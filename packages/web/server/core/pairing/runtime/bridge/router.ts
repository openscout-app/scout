// tRPC v11 router for the Bridge server.
//
// Maps every JSON-RPC method from the legacy switch statement in server.ts
// to a typed tRPC procedure with Zod v4 input validation.
//
// Usage:
//   import { bridgeRouter, type BridgeRouter } from "./router.ts";

import { hostname as osHostname } from "node:os";

import { initTRPC, tracked, TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  createHistorySessionSnapshot,
  inferHistorySessionAdapterType,
  isSessionRegistryError,
  normalizeApprovalRequest,
  supportsHistorySessionSnapshotForPath,
  type ActionBlock,
  type AgentSessionStreamEvent,
  type Prompt,
  type SequencedEvent,
  type SessionState,
} from "@openscout/agent-sessions";
import {
  projectSessionAttention,
  type SessionAttentionItem,
} from "@openscout/runtime";
import {
  readSessionFileScan,
  readSessionSearch,
} from "@openscout/runtime/system-probes";
import {
  loadLocalConfig,
  OPENSCOUT_PORTS,
  resolveBrokerPort,
  resolveHost,
  resolveWebPort,
} from "@openscout/runtime/local-config";

import { log } from "./log.ts";
import { resolveConfig } from "./config.ts";
import { readPairingRuntimeSnapshot } from "../runtime-state.ts";
import type { Bridge } from "./bridge.ts";
import type { AgentHarness } from "@openscout/protocol";
import {
  createScoutSession,
  getScoutFleet,
  getScoutMobileActivity,
  getScoutMobileAgents,
  getScoutMobileConversations,
  getScoutMobileConversationMessages,
  getScoutMobileHome,
  getScoutMobileRuntimeCapabilities,
  getScoutMobileServiceBudgets,
  getScoutMobileSessions,
  getScoutMobileSessionSnapshot,
  getScoutMobileTerminals,
  getScoutMobileWorkspaces,
  markScoutMobileConversationRead,
  sendScoutMobileComms,
  sendScoutMobileMessage,
} from "../../../mobile/service.ts";
import { askScoutQuestion, loadScoutBrokerContext, readScoutBrokerTailRecent } from "../../../broker/service.ts";
import { askMobileHarnessSession } from "../../../mobile/ask-session.ts";
import { loadSessionRefObservePayload } from "../../../observe/service.ts";
import { formatSessionRouteRef } from "../../../../../shared/session-route-ref.ts";
import { toSessionUpdate } from "../../../../../client/screens/agents/agents-feed-article.ts";
import { pendingOperatorNeeds } from "../../../attention/operator-needs.ts";
import { collectHerdrHostAttention } from "../../../attention/herdr-host-attention.ts";
import { answerHerdrPermission } from "../../../attention/herdr-permission-answer.ts";
import { resolveOperatorName } from "@openscout/runtime/user-config";
import {
  provisionMobileTerminalAccess,
  readMobileTerminalStatus,
} from "./mobile-terminal-provision.ts";
import { InvalidMobileTerminalSessionError } from "./mobile-terminal-session.ts";
import { syncMobilePushRegistrationWithRelay } from "@openscout/runtime/mobile-push";
import {
  queryHeartrate,
  queryMobileAgentDetail,
} from "../../../../db-queries.ts";
import {
  connectCodexDeckThread,
  getCodexDeckThreadSnapshot,
  getLocalAgentConfig,
  isCodexDeckThreadConnected,
  interruptCodexDeckTurn,
  interruptLocalAgent,
  restartLocalAgent,
  startCodexDeckTurn,
  steerCodexDeckTurn,
  stopLocalAgent,
} from "@openscout/runtime/local-agents";
import {
  issueWebHandoff,
  pathForWebHandoffScope,
  type WebHandoffScope,
} from "./web-handoff.ts";
import {
  pairingFileServerOrigin,
  readPairingAttachmentBlob,
  storePairingAttachmentBlob,
} from "./fileserver.ts";
import { createArtifactPresentation } from "./artifact-presentation.ts";
import { getMobileMeshNodes } from "./mobile-mesh-nodes.ts";
import { getMobileMeshStatus } from "./mobile-mesh-status.ts";

import { readFileSync, readdirSync, realpathSync, statSync } from "fs";
import { basename, isAbsolute, join, relative, resolve } from "path";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface BridgeContext {
  bridge: Bridge;
  cwd: string;
  deviceId?: string;
  secureTransport?: boolean;
  trustedPeer?: boolean;
}

// ---------------------------------------------------------------------------
// tRPC init
// ---------------------------------------------------------------------------

const t = initTRPC.context<BridgeContext>().create();

// ---------------------------------------------------------------------------
// Middleware: logged — logs method name + timing
// ---------------------------------------------------------------------------

const logged = t.middleware(async ({ path, type, next }) => {
  const start = Date.now();
  log.debug("rpc:req", `-> ${type} ${path}`);
  const result = await next();
  const elapsed = Date.now() - start;
  if (result.ok) {
    log.debug("rpc:res", `✓ ${path} (${elapsed}ms)`);
  } else {
    log.error("rpc:res", `✗ ${path} (${elapsed}ms)`);
  }
  return result;
});

const procedure = t.procedure.use(logged);

// ---------------------------------------------------------------------------
// Protected endpoint discovery
// ---------------------------------------------------------------------------

const protectedMobileProcedure = procedure.use(({ ctx, next }) => {
  if (!ctx.secureTransport || !ctx.trustedPeer || !ctx.deviceId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Endpoint discovery requires an encrypted trusted mobile transport",
    });
  }
  return next({ ctx });
});

function localServiceHost(): string {
  const rawHost = resolveHost() || loadLocalConfig().host || "127.0.0.1";
  if (rawHost === "0.0.0.0" || rawHost === "::") {
    return "127.0.0.1";
  }
  return rawHost;
}

function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function httpUrl(host: string, port: number): string {
  return `http://${hostForUrl(host)}:${port}`;
}

function wsUrl(host: string, port: number): string {
  return `ws://${hostForUrl(host)}:${port}`;
}

function isMobileReachableHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return Boolean(normalized)
    && normalized !== "localhost"
    && normalized !== "127.0.0.1"
    && normalized !== "::1"
    && normalized !== "0.0.0.0"
    && normalized !== "::";
}

function dedupeUrls(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    urls.push(trimmed);
  }
  return urls;
}

function currentMobileRelayUrls(host: string, pairingBridgePort: number): string[] {
  const snapshot = readPairingRuntimeSnapshot();
  const snapshotPairing = snapshot?.pairing;
  const configuredRelay = resolveConfig().relay;
  return dedupeUrls([
    snapshotPairing?.relay,
    ...(snapshotPairing?.fallbackRelays ?? []),
    configuredRelay,
    isMobileReachableHost(host) ? wsUrl(host, pairingBridgePort) : null,
  ]);
}

const VOICE_LEG_HEALTH_TIMEOUT_MS = 300;
const VOICE_LEG_HEALTH_TTL_MS = 5_000;

type VoiceLegHealth = {
  reachable: boolean;
  asr: "up" | "down" | "unknown";
};

let voiceLegHealthCache: {
  port: number;
  at: number;
  value: VoiceLegHealth;
} | null = null;

function resolveVoiceLegPort(): number {
  const raw = Number(process.env.SCOUT_RTC_PORT);
  return Number.isInteger(raw) && raw > 0 && raw < 65_536
    ? raw
    : 8090;
}

async function probeVoiceLegHealth(port: number): Promise<VoiceLegHealth> {
  const now = Date.now();
  if (
    voiceLegHealthCache?.port === port
    && now - voiceLegHealthCache.at < VOICE_LEG_HEALTH_TTL_MS
  ) {
    return voiceLegHealthCache.value;
  }

  let value: VoiceLegHealth = { reachable: false, asr: "unknown" };
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(VOICE_LEG_HEALTH_TIMEOUT_MS),
    });
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as { asr?: unknown } | null;
      const asr = body?.asr;
      value = {
        reachable: true,
        asr: asr === "up" || asr === "down" ? asr : "unknown",
      };
    }
  } catch {
    // Connection refused and timeouts both mean the leg is unavailable.
  }

  voiceLegHealthCache = { port, at: now, value };
  return value;
}

async function buildMobileEndpointManifest(ctx: BridgeContext) {
  const host = localServiceHost();
  const brokerPort = resolveBrokerPort();
  const webPort = resolveWebPort();
  const pairingBridgePort = resolveConfig().port;
  const pairingFileServerPort = pairingBridgePort + 2;
  const brokerUrl = httpUrl(host, brokerPort);
  const webUrl = httpUrl(host, webPort);
  const pairingBridgeUrl = wsUrl(host, pairingBridgePort);
  const pairingFileServerUrl = httpUrl(host, pairingFileServerPort);
  const relayUrls = currentMobileRelayUrls(host, pairingBridgePort);
  const voicePort = resolveVoiceLegPort();
  const voiceHealth = await probeVoiceLegHealth(voicePort);
  const voiceReachableFromPhone = voiceHealth.reachable && isMobileReachableHost(host);

  const nodeName = process.env.OPENSCOUT_NODE_NAME?.trim() || osHostname();
  const hostName = osHostname();

  return {
    version: 1,
    observedAt: Date.now(),
    source: "bridge-rpc",
    protected: true,
    node: {
      name: nodeName,
      hostName,
    },
    // The Mac's own hostname, so a mesh-reached phone can label this machine with
    // its real name — the shared relay front door never identifies the Mac.
    hostName,
    transport: {
      secure: ctx.secureTransport === true,
      trustedPeer: ctx.trustedPeer === true,
      deviceId: ctx.deviceId ?? null,
    },
    ports: {
      broker: brokerPort,
      web: webPort,
      pairingBridge: pairingBridgePort,
      pairingFileServer: pairingFileServerPort,
      defaults: {
        broker: OPENSCOUT_PORTS.broker,
        web: OPENSCOUT_PORTS.web,
        pairingBridge: OPENSCOUT_PORTS.pairingBridge,
        pairingFileServer: OPENSCOUT_PORTS.pairingFileServer,
      },
    },
    endpoints: {
      brokerUrl,
      webUrl,
      pairingBridgeUrl,
      pairingFileServerUrl,
      relayUrls,
    },
    voice: {
      available: voiceReachableFromPhone,
      port: voicePort,
      url: voiceReachableFromPhone ? httpUrl(host, voicePort) : null,
      asr: voiceHealth.asr,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers (ported from server.ts)
// ---------------------------------------------------------------------------

function resolveMobileCurrentDirectory(): string {
  const config = resolveConfig();
  const configuredRoot = config.workspace?.root;
  if (!configuredRoot) return process.cwd();
  try {
    return resolveWorkspaceRoot(configuredRoot);
  } catch {
    return process.cwd();
  }
}

function resolveWorkspaceRoot(root: string): string {
  const expandedRoot = root.replace(/^~/, homedir());
  return realpathSync(expandedRoot);
}

function resolveWorkspacePath(root: string, requestedPath?: string): string {
  const normalizedRoot = resolveWorkspaceRoot(root);
  const expandedPath = requestedPath?.replace(/^~/, homedir());
  const candidate = expandedPath
    ? isAbsolute(expandedPath)
      ? expandedPath
      : join(normalizedRoot, expandedPath)
    : normalizedRoot;
  const resolvedCandidate = realpathSync(candidate);
  const rel = relative(normalizedRoot, resolvedCandidate);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return resolvedCandidate;
  }
  throw new Error("Path escapes workspace root");
}

interface DirectoryEntry {
  name: string;
  path: string;
  markers: string[];
}

const MARKER_FILES: [string, string][] = [
  [".git", "git"],
  ["package.json", "node"],
  ["Package.swift", "swift"],
  ["Cargo.toml", "rust"],
  ["go.mod", "go"],
  ["pyproject.toml", "python"],
  ["setup.py", "python"],
  ["Gemfile", "ruby"],
  ["build.gradle", "java"],
  ["pom.xml", "java"],
  ["CMakeLists.txt", "cpp"],
  ["Makefile", "make"],
  [".xcodeproj", "xcode"],
];

function listDirectories(dirPath: string): DirectoryEntry[] {
  const entries: DirectoryEntry[] = [];
  for (const name of readdirSync(dirPath)) {
    if (name.startsWith(".")) continue;
    if (name === "node_modules" || name === ".build" || name === "target") continue;
    const fullPath = join(dirPath, name);
    try {
      const stat = statSync(fullPath);
      if (!stat.isDirectory()) continue;
      const children = new Set(readdirSync(fullPath));
      const markers: string[] = [];
      const seen = new Set<string>();
      for (const [file, marker] of MARKER_FILES) {
        const found = file.startsWith(".")
          ? [...children].some((c) => c.endsWith(file))
          : children.has(file);
        if (found && !seen.has(marker)) {
          markers.push(marker);
          seen.add(marker);
        }
      }
      entries.push({ name, path: fullPath, markers });
    } catch {
      continue;
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function extractProjectName(filePath: string): string {
  const claudeMatch = filePath.match(/\.claude\/projects\/[^/]*-dev-([^/]+)/);
  if (claudeMatch?.[1]) return claudeMatch[1];
  const parts = filePath.split("/");
  return parts[parts.length - 2] || "unknown";
}

/**
 * A transcript line carrying words someone said: a Claude user/assistant line
 * with text (not a tool result), or a Codex message item. Cheap substring
 * checks first — most lines of a long session are tool traffic.
 */
const STEP_TEXT_LIMIT = 600;
const STEP_INPUT_LIMIT = 240;

/** Keeps the first and last three lines of a long output, within a budget. */
function trimStepText(value: string): string {
  const lines = value.split("\n");
  let out = lines.length > 7 ? [...lines.slice(0, 3), `… ${lines.length - 6} more lines`, ...lines.slice(-3)].join("\n") : value;
  if (out.length > STEP_TEXT_LIMIT) out = `${out.slice(0, STEP_TEXT_LIMIT)}…`;
  return out;
}

function trimStepInput(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[key] = typeof value === "string" && value.length > STEP_INPUT_LIMIT ? `${value.slice(0, STEP_INPUT_LIMIT)}…` : value;
  }
  return out;
}

/**
 * One transcript line reduced to what a lane draws: a prompt, a reply, a
 * tool call (its input trimmed) or a tool result (its output trimmed).
 * Anything else is null.
 */
function compactTranscriptStepLine(line: string): string | null {
  const claude = line.includes('"type":"user"') || line.includes('"type":"assistant"');
  const codex = line.includes('"type":"response_item"');
  if (!claude && !codex) return null;
  try {
    const entry = JSON.parse(line) as Record<string, any>;
    if (codex) {
      if (entry.type !== "response_item") return null;
      const payload = entry.payload ?? {};
      const kind = payload.type as string | undefined;
      if (kind === "message") return line.length > 8000 ? JSON.stringify({ ...entry, payload: { ...payload, content: (payload.content ?? []).map((b: any) => typeof b?.text === "string" ? { ...b, text: b.text.slice(0, 8000) } : b) } }) : line;
      if (kind === "function_call" || kind === "custom_tool_call" || kind === "local_shell_call") {
        const next = { ...payload };
        if (typeof next.arguments === "string" && next.arguments.length > 2000) next.arguments = next.arguments.slice(0, 2000);
        if (typeof next.input === "string") next.input = trimStepText(next.input);
        return JSON.stringify({ type: entry.type, timestamp: entry.timestamp, payload: next });
      }
      if (kind === "function_call_output" || kind === "custom_tool_call_output") {
        const raw = typeof payload.output === "string"
          ? payload.output
          : Array.isArray(payload.output)
            ? payload.output.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("")
            : "";
        const output = trimStepText(raw);
        return JSON.stringify({ type: entry.type, timestamp: entry.timestamp, payload: { ...payload, output } });
      }
      return null;
    }
    if (entry.type !== "user" && entry.type !== "assistant") return null;
    if (entry.isMeta || entry.isSidechain) return null;
    const message = entry.message ?? {};
    const content = message.content;
    const blocks = Array.isArray(content)
      ? content.flatMap<Record<string, unknown>>((block: any) => {
        if (block?.type === "text") return [{ type: "text", text: String(block.text ?? "").slice(0, 8000) }];
        if (block?.type === "tool_use") return [{ type: "tool_use", id: block.id, name: block.name, input: trimStepInput(block.input) }];
        if (block?.type === "tool_result") {
          const raw = typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n")
              : "";
          return [{ type: "tool_result", tool_use_id: block.tool_use_id, is_error: block.is_error === true, lines: raw.split("\n").length, content: trimStepText(raw) }];
        }
        return [];
      })
      : typeof content === "string" ? content.slice(0, 8000) : null;
    if (blocks === null || (Array.isArray(blocks) && blocks.length === 0)) return null;
    return JSON.stringify({
      type: entry.type,
      timestamp: entry.timestamp,
      isCompactSummary: entry.isCompactSummary,
      message: { id: message.id, role: message.role, content: blocks },
    });
  } catch {
    return null;
  }
}

function isTranscriptMessageLine(line: string): boolean {
  const claude = line.includes('"type":"user"') || line.includes('"type":"assistant"');
  const codex = line.includes('"type":"response_item"') && line.includes('"type":"message"');
  if (!claude && !codex) return false;
  if (claude && line.includes('"type":"tool_result"')) return false;
  if (claude && !line.includes('"type":"text"') && !line.includes('"content":"')) return false;
  try {
    const entry = JSON.parse(line) as Record<string, any>;
    if (codex) return entry.type === "response_item" && entry.payload?.type === "message";
    if (entry.type !== "user" && entry.type !== "assistant") return false;
    if (entry.isMeta || entry.isSidechain) return false;
    const content = entry.message?.content;
    if (typeof content === "string") return content.trim().length > 0;
    return Array.isArray(content) && content.some((block: any) => block?.type === "text" && block.text?.trim());
  } catch {
    return false;
  }
}

interface DiscoveredSession {
  path: string;
  project: string;
  agent: string;
  modifiedAt: number;
  sizeBytes: number;
  lineCount: number;
  traceSupported: boolean;
}

async function discoverSessionFiles(
  maxAgeDays: number,
  limit: number,
): Promise<DiscoveredSession[]> {
  const config = resolveConfig();
  const workspaceRoot = config.workspace?.root
    ? resolveWorkspaceRoot(config.workspace.root)
    : null;
  const sessions = await readSessionFileScan({
    home: homedir(),
    workspaceRoot,
    maxAgeDays,
    limit,
  });
  return sessions.map((session) => ({
    ...session,
    lineCount: 0,
    traceSupported: supportsHistorySessionSnapshotForPath(session.path, session.agent),
  }));
}

// ---------------------------------------------------------------------------
// Async iterable adapter for bridge.onEvent()
// ---------------------------------------------------------------------------

/**
 * Converts the callback-based `bridge.onEvent(cb)` into an async iterable
 * that yields SequencedEvents. Respects AbortSignal for cleanup.
 */
function bridgeEventIterable(
  bridge: Bridge,
  signal?: AbortSignal,
): AsyncIterable<SequencedEvent> {
  return {
    [Symbol.asyncIterator]() {
      const buffer: SequencedEvent[] = [];
      let resolve: (() => void) | null = null;
      let done = false;

      const unsub = bridge.onEvent((event) => {
        if (done) return;
        buffer.push(event);
        if (resolve) {
          resolve();
          resolve = null;
        }
      });

      const cleanup = () => {
        done = true;
        unsub();
        // Wake up any pending next() so it can return { done: true }
        if (resolve) {
          resolve();
          resolve = null;
        }
      };

      signal?.addEventListener("abort", cleanup, { once: true });

      return {
        async next(): Promise<IteratorResult<SequencedEvent>> {
          while (true) {
            if (done) return { done: true, value: undefined };
            if (buffer.length > 0) {
              return { done: false, value: buffer.shift()! };
            }
            // Wait for next event
            await new Promise<void>((r) => {
              resolve = r;
            });
          }
        },
        async return(): Promise<IteratorResult<SequencedEvent>> {
          cleanup();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function getEventSessionId(event: SequencedEvent): string | undefined {
  const payload = event.event as Record<string, unknown>;
  return (payload.sessionId as string | undefined)
    ?? ((payload.session as { id?: string } | undefined)?.id);
}

function trackedSequencedEventId(event: SequencedEvent): string {
  return `${getEventSessionId(event) ?? "unknown"}:${event.seq}`;
}

export type MobileInboxItemKind =
  | "approval"
  | "question"
  | "failed_action"
  | "failed_turn"
  | "session_error"
  | "native_attention"
  // A declared `scout need`: answered by replying in its conversation, so
  // sessionId carries the conversation id and the phone offers "Open chat".
  | "ask";

export type MobileInboxItem = {
  id: string;
  kind: MobileInboxItemKind;
  createdAt: number;
  sessionId: string;
  sessionName: string;
  adapterType: string;
  turnId: string | null;
  blockId: string | null;
  version: number | null;
  risk: "low" | "medium" | "high";
  title: string;
  description: string;
  detail: string | null;
  actionKind?: ActionBlock["action"]["kind"];
  actionStatus?: ActionBlock["action"]["status"];
  /** Discrete answers a declared ask offers; the phone sends one as a reply. */
  options?: string[];
};

function approvalInboxItemId(
  sessionId: string,
  turnId: string,
  blockId: string,
  version: number,
): string {
  return `approval:${sessionId}:${turnId}:${blockId}:v${version}`;
}

function projectApprovalInboxItem(
  snapshot: SessionState,
  turn: SessionState["turns"][number],
  block: ActionBlock,
): MobileInboxItem | null {
  const normalized = normalizeApprovalRequest(snapshot.session, turn.id, block);
  if (!normalized) {
    return null;
  }

  return {
    id: approvalInboxItemId(
      normalized.sessionId,
      normalized.turnId,
      normalized.blockId,
      normalized.version,
    ),
    kind: "approval",
    createdAt: turn.startedAt,
    sessionId: normalized.sessionId,
    sessionName: normalized.sessionName,
    adapterType: normalized.adapterType,
    turnId: normalized.turnId,
    blockId: normalized.blockId,
    version: normalized.version,
    risk: normalized.risk,
    title: normalized.title,
    description: normalized.description,
    detail: normalized.detail,
    actionKind: normalized.actionKind,
    actionStatus: normalized.actionStatus,
  };
}

function riskForAttention(item: SessionAttentionItem): "low" | "medium" | "high" {
  if (item.approval) {
    return item.approval.risk;
  }
  switch (item.severity) {
    case "critical":
      return "high";
    case "warning":
      return "medium";
    default:
      return "low";
  }
}

function mobileInboxItemFromSessionAttention(item: SessionAttentionItem): MobileInboxItem {
  return {
    id: item.id,
    kind: item.kind,
    createdAt: item.updatedAt,
    sessionId: item.sessionId,
    sessionName: item.sessionName,
    adapterType: item.adapterType,
    turnId: item.turnId,
    blockId: item.blockId,
    version: item.version,
    risk: riskForAttention(item),
    title: item.title,
    description: item.summary ?? item.title,
    detail: item.detail,
    ...(item.actionKind ? { actionKind: item.actionKind } : {}),
    ...(item.approval ? { actionStatus: item.approval.actionStatus } : {}),
  };
}

function queryMobileInboxItemsForSnapshot(snapshot: SessionState): MobileInboxItem[] {
  return projectSessionAttention(snapshot)
    .map(mobileInboxItemFromSessionAttention);
}

function lookupMobileInboxItemForBlock(
  bridge: Bridge,
  sessionId: string,
  turnId: string,
  blockId: string,
): MobileInboxItem | null {
  const snapshot = bridge.getSessionSnapshot(sessionId);
  if (!snapshot) {
    return null;
  }

  const turn = snapshot.turns.find((candidate) => candidate.id === turnId);
  if (!turn) {
    return null;
  }

  const blockState = turn.blocks.find((candidate) => candidate.block.id === blockId);
  if (!blockState || blockState.block.type !== "action") {
    return queryMobileInboxItemsForSnapshot(snapshot)
      .find((item) => item.turnId === turnId && item.blockId === blockId)
      ?? null;
  }

  return projectApprovalInboxItem(snapshot, turn, blockState.block)
    ?? queryMobileInboxItemsForSnapshot(snapshot)
      .find((item) => item.turnId === turnId && item.blockId === blockId)
    ?? null;
}

export function lookupMobileInboxItemForEvent(
  bridge: Bridge,
  event: AgentSessionStreamEvent,
): MobileInboxItem | null {
  switch (event.event) {
    case "block:start": {
      if (
        event.block.type !== "question"
        && !(event.block.type === "action" && event.block.action.status === "awaiting_approval")
      ) {
        return null;
      }
      return lookupMobileInboxItemForBlock(
        bridge,
        event.sessionId,
        event.turnId,
        event.block.id,
      );
    }
    case "block:action:approval":
      return lookupMobileInboxItemForBlock(
        bridge,
        event.sessionId,
        event.turnId,
        event.blockId,
      );
    case "block:action:status":
      if (event.status !== "failed" && event.status !== "awaiting_approval") {
        return null;
      }
      return lookupMobileInboxItemForBlock(
        bridge,
        event.sessionId,
        event.turnId,
        event.blockId,
      );
    case "turn:error": {
      const snapshot = bridge.getSessionSnapshot(event.sessionId);
      return snapshot
        ? queryMobileInboxItemsForSnapshot(snapshot).find((item) => item.turnId === event.turnId) ?? null
        : null;
    }
    case "session:update": {
      const snapshot = bridge.getSessionSnapshot(event.session.id);
      return snapshot
        ? queryMobileInboxItemsForSnapshot(snapshot).find((item) =>
          item.kind === "session_error" || item.kind === "native_attention") ?? null
        : null;
    }
    default:
      return null;
  }
}

/**
 * Unanswered `scout need` declarations. They reach the phone as a push but live
 * only as conversation messages, so without this the inbox the push opens has
 * nothing in it. Best-effort: an unreachable broker adds nothing rather than
 * failing the session-attention half of the inbox.
 */
async function queryOperatorNeedInboxItems(): Promise<MobileInboxItem[]> {
  const broker = await loadScoutBrokerContext(undefined, {
    scope: "conversations",
    signal: AbortSignal.timeout(2_000),
  }).catch(() => null);
  if (!broker) return [];
  const snapshot = broker.snapshot;
  const operatorName = resolveOperatorName().trim() || "operator";
  return pendingOperatorNeeds({
    messages: Object.values(snapshot.messages ?? {}),
    operatorIds: [operatorName, "operator"],
  }).map((need) => {
    const name = snapshot.actors[need.actorId]?.displayName?.trim() || need.actorId;
    return {
      id: `need:${need.messageId}`,
      kind: "ask" as const,
      createdAt: need.createdAt,
      sessionId: need.conversationId,
      sessionName: name,
      adapterType: "agent",
      turnId: null,
      blockId: null,
      version: null,
      risk: "medium" as const,
      title: `${name} is asking`,
      description: need.question,
      detail: need.blockedReason ? `Blocked: ${need.blockedReason}` : null,
      ...(need.options.length ? { options: need.options } : {}),
    };
  });
}

/**
 * Terminal sessions herdr reports as blocked — a native Claude/Codex/etc. at a
 * permission or input prompt. A Claude permission dialog Scout could parse
 * carries its fingerprint as `version`, and the phone can answer it through
 * `mobile.answerTerminalPermission`; anything else is answered at the terminal.
 */
async function queryHerdrInboxItems(): Promise<MobileInboxItem[]> {
  const items = await collectHerdrHostAttention().catch(() => []);
  return items.map((item) => ({
    id: item.id,
    kind: "native_attention" as const,
    createdAt: item.updatedAt,
    sessionId: item.sessionId,
    sessionName: item.sessionName,
    adapterType: item.harness,
    turnId: null,
    blockId: null,
    version: item.version,
    risk: "medium" as const,
    title: item.title,
    description: item.summary,
    detail: [item.detail, `herdr · ${item.location}`].filter(Boolean).join("\n"),
  }));
}

function queryMobileInboxItems(bridge: Bridge): MobileInboxItem[] {
  const items: MobileInboxItem[] = [];

  for (const session of bridge.getSessionSummaries()) {
    const snapshot = bridge.getSessionSnapshot(session.sessionId);
    if (!snapshot) {
      continue;
    }

    items.push(...queryMobileInboxItemsForSnapshot(snapshot));
  }

  return items.sort((left, right) =>
    right.createdAt - left.createdAt || left.id.localeCompare(right.id));
}

function toTRPCRegistryError(error: unknown): TRPCError | null {
  if (!isSessionRegistryError(error)) {
    return null;
  }

  switch (error.code) {
    case "NOT_FOUND":
      return new TRPCError({ code: "NOT_FOUND", message: error.message });
    case "CONFLICT":
      return new TRPCError({ code: "CONFLICT", message: error.message });
    case "BAD_REQUEST":
      return new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
}

// ---------------------------------------------------------------------------
// Sub-routers
// ---------------------------------------------------------------------------

// -- Session ----------------------------------------------------------------

const sessionRouter = t.router({
  create: procedure
    .input(
      z.object({
        adapterType: z.string(),
        name: z.string().optional(),
        cwd: z.string().optional(),
        options: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return ctx.bridge.createSession(input.adapterType, {
        name: input.name,
        cwd: input.cwd,
        options: input.options,
      });
    }),

  list: procedure.query(({ ctx }) => {
    return ctx.bridge.listSessions();
  }),

  close: procedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await ctx.bridge.closeSession(input.sessionId);
      return { ok: true };
    }),

  snapshot: procedure
    .input(z.object({ sessionId: z.string() }))
    .query(({ input, ctx }) => {
      const snapshot = ctx.bridge.getSessionSnapshot(input.sessionId);
      if (!snapshot) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No session: ${input.sessionId}`,
        });
      }
      return snapshot;
    }),

  resume: procedure
    .input(
      z.object({
        sessionPath: z.string(),
        adapterType: z.string().optional(),
        name: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const sessionFilename = basename(input.sessionPath, ".jsonl");
      const parentDir = input.sessionPath.substring(
        0,
        input.sessionPath.lastIndexOf("/"),
      );
      const dirName = basename(parentDir);

      let cwd: string;
      if (dirName.startsWith("-")) {
        const candidate = "/" + dirName.slice(1).replace(/-/g, "/");
        try {
          statSync(candidate);
          cwd = candidate;
        } catch {
          const config = resolveConfig();
          cwd = config.workspace?.root
            ? resolveWorkspaceRoot(config.workspace.root)
            : process.cwd();
        }
      } else {
        cwd = process.cwd();
      }

      const adapterType = input.adapterType ?? "claude-code";
      const name = input.name ?? extractProjectName(input.sessionPath);

      return ctx.bridge.createSession(adapterType, {
        name,
        cwd,
        options: { resume: sessionFilename },
      });
    }),
});

// -- Mobile -----------------------------------------------------------------

export const mobileAskSessionInputSchema = z.object({
  sessionId: z.string().min(1),
  harness: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  body: z.string(),
  clientMessageId: z.string().nullable().optional(),
});

const mobileAskSessionProcedure = procedure
    .input(mobileAskSessionInputSchema)
    .mutation(async ({ input }) => {
      return askMobileHarnessSession(input, {
        ask: askScoutQuestion,
        senderId: resolveOperatorName().trim() || "operator",
        fallbackCurrentDirectory: resolveMobileCurrentDirectory(),
      });
    });

const mobileRouter = t.router({
  runtimeCapabilities: procedure
    .input(z.object({ projectRoot: z.string().optional() }).optional())
    .query(({ input }) => getScoutMobileRuntimeCapabilities(input?.projectRoot)),

  endpoints: protectedMobileProcedure
    .query(({ ctx }) => buildMobileEndpointManifest(ctx)),

  meshStatus: procedure
    .query(() => getMobileMeshStatus()),

  meshNodes: procedure
    .query(() => getMobileMeshNodes()),

  inbox: procedure
    .query(async ({ ctx }) => ({
      items: [
        ...(await queryOperatorNeedInboxItems()),
        ...(await queryHerdrInboxItems()),
        ...queryMobileInboxItems(ctx.bridge),
      ],
    })),

  pushSync: procedure
    .input(z.object({
      pushToken: z.string().nullable().optional(),
      authorizationStatus: z.enum([
        "notDetermined",
        "denied",
        "authorized",
        "provisional",
        "ephemeral",
      ]),
      appBundleId: z.string(),
      apnsEnvironment: z.enum(["development", "production"]),
      appVersion: z.string().nullable().optional(),
      buildNumber: z.string().nullable().optional(),
      deviceModel: z.string().nullable().optional(),
      systemVersion: z.string().nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.deviceId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Push registration requires a paired mobile device",
        });
      }

      return syncMobilePushRegistrationWithRelay({
        deviceId: ctx.deviceId,
        platform: "ios",
        appBundleId: input.appBundleId,
        apnsEnvironment: input.apnsEnvironment,
        authorizationStatus: input.authorizationStatus,
        pushToken: input.pushToken ?? null,
        appVersion: input.appVersion ?? null,
        buildNumber: input.buildNumber ?? null,
        deviceModel: input.deviceModel ?? null,
        systemVersion: input.systemVersion ?? null,
      });
    }),

  home: procedure
    .input(
      z
        .object({
          workspaceLimit: z.number().optional(),
          agentLimit: z.number().optional(),
          sessionLimit: z.number().optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      return getScoutMobileHome({
        currentDirectory: resolveMobileCurrentDirectory(),
        workspaceLimit: input?.workspaceLimit,
        agentLimit: input?.agentLimit,
        sessionLimit: input?.sessionLimit,
      });
    }),

  workspaces: procedure
    .input(
      z
        .object({
          query: z.string().optional(),
          limit: z.number().optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      return getScoutMobileWorkspaces(input, resolveMobileCurrentDirectory());
    }),

  agents: procedure
    .input(
      z
        .object({
          query: z.string().optional(),
          limit: z.number().optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      return getScoutMobileAgents(input, resolveMobileCurrentDirectory());
    }),

  sessions: procedure
    .input(
      z
        .object({
          query: z.string().optional(),
          limit: z.number().optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      return getScoutMobileSessions(input, resolveMobileCurrentDirectory());
    }),

  sessionSnapshot: procedure
    .input(
      z.object({
        conversationId: z.string().optional(),
        sessionId: z.string().optional(),
        beforeTurnId: z.string().nullable().optional(),
        limit: z.number().nullable().optional(),
      }),
    )
    .query(async ({ input }) => {
      const rawId = input.conversationId ?? input.sessionId;
      if (!rawId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "conversationId is required",
        });
      }
      // Pass the routed id straight through. The snapshot service resolves it
      // against the live broker snapshot as an opaque chat id or a bare agent id
      // whose actual conversation is discovered from broker state.
      return getScoutMobileSessionSnapshot(
        rawId,
        {
          beforeTurnId: input.beforeTurnId ?? null,
          limit: typeof input.limit === "number" ? input.limit : null,
        },
        resolveMobileCurrentDirectory(),
      );
    }),

  webHandoff: procedure
    .input(
      z.object({
        kind: z.enum(["session", "file_change"]),
        sessionId: z.string(),
        turnId: z.string().optional(),
        blockId: z.string().optional(),
      }),
    )
    .mutation(({ input, ctx }) => {
      if (!ctx.deviceId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Secure web handoff requires a paired mobile device",
        });
      }

      const snapshot = ctx.bridge.getSessionSnapshot(input.sessionId);
      if (!snapshot) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No session: ${input.sessionId}`,
        });
      }

      let scope: WebHandoffScope;
      let title = snapshot.session.name || snapshot.session.id;

      if (input.kind === "file_change") {
        if (!input.turnId || !input.blockId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "turnId and blockId are required for file_change handoffs",
          });
        }
        const turn = snapshot.turns.find((candidate) => candidate.id === input.turnId);
        const block = turn?.blocks.find((candidate) => candidate.block.id === input.blockId)?.block;
        if (!turn || !block || block.type !== "action" || block.action.kind !== "file_change") {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "File change block not found",
          });
        }
        scope = {
          kind: "file_change",
          sessionId: input.sessionId,
          turnId: input.turnId,
          blockId: input.blockId,
        };
        title = block.action.path || title;
      } else {
        scope = {
          kind: "session",
          sessionId: input.sessionId,
        };
      }

      const issued = issueWebHandoff(scope, ctx.deviceId);
      return {
        kind: input.kind,
        path: pathForWebHandoffScope(scope),
        token: issued.token,
        expiresAt: issued.expiresAt,
        title,
      };
    }),

  artifactPresent: procedure
    .input(
      z.object({
        sessionId: z.string().min(1),
        sourcePath: z.string().min(1),
        entryPath: z.string().nullable().optional(),
        title: z.string().nullable().optional(),
        ttlMs: z.number().int().positive().nullable().optional(),
      }),
    )
    .mutation(({ input, ctx }) => {
      if (!ctx.secureTransport || !ctx.trustedPeer || !ctx.deviceId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Artifact presentation requires a trusted paired device over the encrypted bridge.",
        });
      }
      const snapshot = ctx.bridge.getSessionSnapshot(input.sessionId);
      const workspaceRoot = snapshot?.session.cwd?.trim();
      if (!snapshot || !workspaceRoot) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No workspace-backed session: ${input.sessionId}`,
        });
      }

      try {
        const grant = createArtifactPresentation(
          {
            sourcePath: isAbsolute(input.sourcePath)
              ? input.sourcePath
              : resolve(workspaceRoot, input.sourcePath),
            entryPath: input.entryPath,
            title: input.title,
            ttlMs: input.ttlMs,
          },
          { allowedRoot: workspaceRoot },
        );
        return {
          ...grant,
          port: resolveConfig().port + 2,
        };
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }),

  createSession: procedure
    .input(
      z.object({
        workspaceId: z.string(),
        harness: z.string().optional() as z.ZodOptional<z.ZodType<AgentHarness>>,
        agentName: z.string().optional(),
        worktree: z.string().nullable().optional(),
        profile: z.string().nullable().optional(),
        branch: z.string().optional(),
        model: z.string().optional(),
        reasoningEffort: z.string().optional(),
        forceNew: z.boolean().optional(),
        seed: z
          .object({
            instructions: z.string().nullable().optional(),
            fromMessageId: z.string().nullable().optional(),
            fromConversationId: z.string().nullable().optional(),
            attachments: z
              .array(
                z.object({
                  id: z.string().optional(),
                  mediaType: z.string(),
                  fileName: z.string().optional(),
                  blobKey: z.string().optional(),
                  url: z.string().optional(),
                }),
              )
              .optional(),
          })
          .nullable()
          .optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return createScoutSession(
        input,
        resolveMobileCurrentDirectory(),
        ctx.deviceId,
      );
    }),

  sendMessage: procedure
    .input(
      z.object({
        agentId: z.string(),
        body: z.string(),
        clientMessageId: z.string().nullable().optional(),
        replyToMessageId: z.string().nullable().optional(),
        referenceMessageIds: z.array(z.string()).optional(),
        harness: z.string().optional() as z.ZodOptional<z.ZodType<AgentHarness>>,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return sendScoutMobileMessage(
        input,
        resolveMobileCurrentDirectory(),
        ctx.deviceId,
      );
    }),

  activity: procedure
    .input(
      z
        .object({
          agentId: z.string().optional(),
          actorId: z.string().optional(),
          conversationId: z.string().optional(),
          limit: z.number().optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      return getScoutMobileActivity(input);
    }),

  fleet: procedure
    .input(z.object({ limit: z.number().int().positive().max(200).optional() }).optional())
    .query(async ({ input }) => {
      return getScoutFleet({ limit: input?.limit });
    }),

  // Usage-quota readout (Claude / Codex / Kimi / GitHub). No params; the phone just
  // asks for the current budgets and gets one flat row per known provider.
  serviceBudgets: procedure
    .input(z.object({}).optional())
    .query(async () => {
      return getScoutMobileServiceBudgets();
    }),

  // Fleet Velocity: the same trailing-7d smoothed activity line the web and
  // Mac Home draw from /api/heartrate. The phone draws it small in its feed.
  heartrate: procedure
    .input(z.object({}).optional())
    .query(() => queryHeartrate()),

  // Recent terminal sessions. No params; the phone just asks for the recent
  // sessions and gets one flat row per registry record (most recent first).
  terminalSessions: procedure
    .input(z.object({}).optional())
    .query(async () => {
      return getScoutMobileTerminals();
    }),

  // Mobile Tail is a polled snapshot, not a live firehose: the phone fetches a
  // recent slice every few seconds while the Tail view is open. The query hits
  // the broker fresh each call (re-resolving the URL), so it survives broker
  // restarts where the singleton tail-fanout push would silently go stale, and
  // it never streams the full firehose across cellular when nobody's watching.
  //
  // The Agents feed on Home asks for `mode: "assistant-replies"`: each harness
  // session's latest reply, Scout-started or not, the same slice the web feed
  // reads from /api/tail/recent.
  tail: procedure
    .input(z.object({
      limit: z.number().optional(),
      mode: z.literal("assistant-replies").optional(),
      windowMs: z.number().int().positive().optional(),
    }).optional())
    .query(async ({ input }) => {
      return readScoutBrokerTailRecent(input?.limit ?? 50, undefined, {
        mode: input?.mode,
        windowMs: input?.windowMs,
      });
    }),

  // The Agents feed's session page: a harness session Scout didn't start has
  // no conversation, only its transcript. Read-only — the same projection the
  // web feed detail shows (the update, the steps behind it, files changed).
  sessionUpdate: procedure
    .input(z.object({
      sessionId: z.string().min(1),
      harness: z.string().nullable().optional(),
      at: z.number(),
    }))
    .query(async ({ input }) => {
      const ref = formatSessionRouteRef(input.harness ?? null, input.sessionId) ?? input.sessionId;
      const payload = await loadSessionRefObservePayload(ref);
      const data = payload?.data ?? null;
      return {
        update: toSessionUpdate(data, input.at),
        cwd: data?.metadata?.session?.cwd ?? null,
        model: data?.metadata?.session?.model ?? null,
      };
    }),

  // Reply to a harness session Scout did not start (one the phone saw in the
  // tail). The broker reserves a stable request receipt before live input;
  // only an explicit not-live result permits exact-session resume. Expected
  // refusals and unknown outcomes return { ok: false }, not replacement asks.
  askSession: mobileAskSessionProcedure,
  // Versioned wire name: old bridges reject before input instead of ignoring
  // a new field and repeating an unreceipted terminal submission.
  askSessionDurable: mobileAskSessionProcedure,

  // Approve / Deny a Claude permission prompt in a Herdr pane: presses the
  // dialog's Yes or No, only while the dialog the phone was shown (`version`)
  // is still up. Expected refusals return { ok: false }, not errors.
  answerTerminalPermission: procedure
    .input(z.object({
      itemId: z.string(),
      version: z.number().int(),
      decision: z.enum(["approve", "deny"]),
    }))
    .mutation(async ({ input }) => {
      return answerHerdrPermission(input);
    }),

  agentDetail: procedure
    .input(z.object({ agentId: z.string() }))
    .query(async ({ input }) => {
      return queryMobileAgentDetail(input.agentId);
    }),

  agentRestart: procedure
    .input(z.object({ agentId: z.string() }))
    .mutation(async ({ input }) => {
      const result = await restartLocalAgent(input.agentId);
      return { ok: result !== null, agentId: input.agentId };
    }),

  agentStop: procedure
    .input(z.object({ agentId: z.string() }))
    .mutation(async ({ input }) => {
      const result = await stopLocalAgent(input.agentId);
      return { ok: result !== null, agentId: input.agentId };
    }),

  agentInterrupt: procedure
    .input(z.object({ agentId: z.string() }))
    .mutation(async ({ input }) => {
      return interruptLocalAgent(input.agentId);
    }),

  // -- Comms (channels + DMs) -------------------------------------------------

  commsConversations: procedure
    .input(
      z
        .object({
          kind: z.string().optional(),
          limit: z.number().optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      return getScoutMobileConversations(input ?? {});
    }),

  commsMessages: procedure
    .input(
      z.object({
        conversationId: z.string(),
        limit: z.number().optional(),
      }),
    )
    .query(async ({ input }) => {
      return getScoutMobileConversationMessages(input.conversationId, input.limit ?? 200);
    }),

  commsSend: procedure
    .input(
      z.object({
        conversationId: z.string(),
        body: z.string(),
        attachments: z
          .array(
            z.object({
              id: z.string().optional(),
              mediaType: z.string(),
              fileName: z.string().optional(),
              blobKey: z.string().optional(),
              url: z.string().optional(),
            }),
          )
          .optional(),
        replyToMessageId: z.string().nullable().optional(),
        clientMessageId: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return sendScoutMobileComms(input, resolveMobileCurrentDirectory(), ctx.deviceId);
    }),

  attachmentUpload: procedure
    .input(
      z.object({
        data: z.string(),
        mediaType: z.string(),
        fileName: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (!ctx.secureTransport || !ctx.trustedPeer || !ctx.deviceId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Attachment upload requires a trusted paired device over the encrypted bridge.",
        });
      }
      const fileServerPort = resolveConfig().port + 2;
      return storePairingAttachmentBlob(input, {
        origin: pairingFileServerOrigin(fileServerPort),
      });
    }),

  // The bytes back. A hosted attachment's URL points at this Mac's file server,
  // which a paired phone cannot reach — on the same LAN it would have to guess
  // the right interface, and over the relay there is no route at all — so the
  // client that needs to DRAW the image asks for it over the bridge it is
  // already trusted on.
  attachmentFetch: procedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      if (!ctx.secureTransport || !ctx.trustedPeer || !ctx.deviceId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Attachment fetch requires a trusted paired device over the encrypted bridge.",
        });
      }
      const blob = readPairingAttachmentBlob(input.id);
      if (!blob) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Attachment is gone or expired." });
      }
      return blob;
    }),

  commsMarkRead: procedure
    .input(
      z.object({
        conversationId: z.string(),
        lastReadMessageId: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return markScoutMobileConversationRead(input);
    }),

  // -- Terminal (in-app SSH/PTY) ------------------------------------------
  terminalProvision: procedure
    .input(z.object({ sshPublicKey: z.string(), deviceClass: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.secureTransport || !ctx.trustedPeer || !ctx.deviceId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Terminal provisioning requires a trusted paired device over the encrypted bridge.",
        });
      }
      return await provisionMobileTerminalAccess(input.sshPublicKey, ctx.deviceId, input.deviceClass);
    }),

  terminalStatus: procedure
    .input(z.object({ sessionName: z.string() }).optional())
    .query(async ({ input, ctx }) => {
      if (!ctx.secureTransport || !ctx.trustedPeer || !ctx.deviceId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Terminal status requires a trusted paired device over the encrypted bridge.",
        });
      }
      try {
        return await readMobileTerminalStatus(input?.sessionName, ctx.deviceId);
      } catch (error) {
        if (error instanceof InvalidMobileTerminalSessionError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: error.message, cause: error });
        }
        throw error;
      }
    }),
});

// -- Workspace --------------------------------------------------------------

const workspaceRouter = t.router({
  info: procedure.query(() => {
    const config = resolveConfig();
    const configuredRoot = config.workspace?.root;
    if (!configuredRoot) {
      return { configured: false as const };
    }
    try {
      const root = resolveWorkspaceRoot(configuredRoot);
      return { configured: true as const, root };
    } catch (err: any) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      });
    }
  }),

  list: procedure
    .input(z.object({ path: z.string().optional() }).optional())
    .query(({ input }) => {
      const config = resolveConfig();
      const configuredRoot = config.workspace?.root;
      if (!configuredRoot) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No workspace root configured",
        });
      }
      try {
        const root = resolveWorkspaceRoot(configuredRoot);
        const browsePath = resolveWorkspacePath(root, input?.path);
        const entries = listDirectories(browsePath);
        return { root, path: browsePath, entries };
      } catch (err: any) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: err.message,
        });
      }
    }),

  open: procedure
    .input(
      z.object({
        path: z.string(),
        adapter: z.string().optional(),
        name: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const config = resolveConfig();
      const configuredRoot = config.workspace?.root;
      if (!configuredRoot) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No workspace root configured",
        });
      }

      const root = resolveWorkspaceRoot(configuredRoot);
      const projectPath = resolveWorkspacePath(root, input.path);
      const stat = statSync(projectPath);
      if (!stat.isDirectory()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Workspace target is not a directory",
        });
      }

      const adapterType = input.adapter ?? "claude-code";
      const name = input.name ?? basename(projectPath);

      return ctx.bridge.createSession(adapterType, {
        name,
        cwd: projectPath,
      });
    }),
});

// -- History ----------------------------------------------------------------

const historyRouter = t.router({
  discover: procedure
    .input(
      z
        .object({
          maxAge: z.number().optional(),
          limit: z.number().optional(),
          project: z.string().optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const maxAgeDays = input?.maxAge ?? 14;
      const limit = input?.limit ?? 250;
      const projectFilter = input?.project;

      let sessions = await discoverSessionFiles(maxAgeDays, limit);
      if (projectFilter) {
        const filter = projectFilter.toLowerCase();
        sessions = sessions.filter((s) =>
          s.project.toLowerCase().includes(filter),
        );
      }
      return { sessions };
    }),

  search: procedure
    .input(
      z.object({
        query: z.string(),
        maxAge: z.number().optional(),
        limit: z.number().optional(),
      }),
    )
    .query(async ({ input }) => {
      const maxAge = input.maxAge ?? 14;
      const limit = input.limit ?? 50;

      const candidateLimit = Math.max(limit * 10, 1000);
      const config = resolveConfig();
      const workspaceRoot = config.workspace?.root
        ? resolveWorkspaceRoot(config.workspace.root)
        : null;
      const matches = await readSessionSearch({
        home: homedir(),
        workspaceRoot,
        maxAgeDays: maxAge,
        limit,
        query: input.query,
        candidateLimit,
      });

      return { query: input.query, matches: matches.slice(0, limit) };
    }),

  // Raw transcript lines, newest 500 by default. The phone's session page
  // pages backwards with `before` (a line index) + `limit`, and asks for
  // `messages` only: the prompt and reply lines, without the tool results
  // that make up most of a transcript's bytes. Older phones send neither.
  read: procedure
    .input(z.object({
      path: z.string(),
      before: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(500).optional(),
      messages: z.boolean().optional(),
      // `steps`: prompts, replies, tool calls and their results, with the
      // bulky parts (file contents, long outputs) trimmed here so a page
      // stays small. The iPad Deck's lanes draw a turn from these.
      steps: z.boolean().optional(),
    }))
    .query(({ input }) => {
      if (!input.path.endsWith(".jsonl")) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only .jsonl files can be read",
        });
      }
      try {
        const content = readFileSync(input.path, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim().length > 0);
        if (input.steps) {
          const limit = input.limit ?? 120;
          let index = Math.min(input.before ?? lines.length, lines.length) - 1;
          const picked: string[] = [];
          while (index >= 0 && picked.length < limit) {
            const compact = compactTranscriptStepLine(lines[index]!);
            // `_line` keeps step ids stable while the page's window moves.
            if (compact) picked.push(`{"_line":${index},${compact.slice(1)}`);
            index -= 1;
          }
          picked.reverse();
          const start = index + 1;
          return { path: input.path, lineCount: lines.length, lines: picked, start, hasOlder: start > 0 };
        }
        if (input.before === undefined && input.limit === undefined && !input.messages) {
          const trimmed = lines.length > 500 ? lines.slice(-500) : lines;
          return { path: input.path, lineCount: lines.length, lines: trimmed };
        }
        const limit = input.limit ?? 500;
        let index = Math.min(input.before ?? lines.length, lines.length) - 1;
        const picked: string[] = [];
        while (index >= 0 && picked.length < limit) {
          const line = lines[index]!;
          if (!input.messages || isTranscriptMessageLine(line)) picked.push(line);
          index -= 1;
        }
        picked.reverse();
        const start = index + 1;
        let hasOlder = start > 0;
        if (input.messages) {
          hasOlder = false;
          for (let i = start - 1; i >= 0; i -= 1) {
            if (isTranscriptMessageLine(lines[i]!)) { hasOlder = true; break; }
          }
        }
        return { path: input.path, lineCount: lines.length, lines: picked, start, hasOlder };
      } catch (err: any) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Cannot read file: ${err.message}`,
        });
      }
    }),

  snapshot: procedure
    .input(
      z.object({
        path: z.string(),
        adapterType: z.string().optional(),
        name: z.string().optional(),
        includeEvents: z.boolean().optional(),
      }),
    )
    .query(({ input }) => {
      if (!input.path.endsWith(".jsonl")) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only .jsonl files can be replayed",
        });
      }

      const adapterType = inferHistorySessionAdapterType(input.path, input.adapterType);
      if (!supportsHistorySessionSnapshotForPath(input.path, input.adapterType)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `History replay is not supported for adapter type "${adapterType}".`,
        });
      }

      try {
        const fileStat = statSync(input.path);
        const content = readFileSync(input.path, "utf-8");
        const replay = createHistorySessionSnapshot({
          path: input.path,
          content,
          adapterType: input.adapterType,
          name: input.name,
          baseTimestampMs: fileStat.mtimeMs,
        });

        return {
          path: input.path,
          adapterType: replay.adapterType,
          lineCount: replay.lineCount,
          parsedLineCount: replay.parsedLineCount,
          skippedLineCount: replay.skippedLineCount,
          snapshot: replay.snapshot,
          ...(input.includeEvents ? { events: replay.events } : {}),
        };
      } catch (err: any) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Cannot replay history file: ${err.message}`,
        });
      }
    }),
});

// -- Prompt -----------------------------------------------------------------

const promptRouter = t.router({
  send: procedure
    .input(
      z.object({
        sessionId: z.string(),
        text: z.string(),
        files: z.array(z.string()).optional(),
        images: z
          .array(z.object({ mimeType: z.string(), data: z.string() }))
          .optional(),
        providerOptions: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .mutation(({ input, ctx }) => {
      log.info("prompt", `sending to session ${input.sessionId}`, {
        text: input.text?.slice(0, 80),
      });
      ctx.bridge.send(input as Prompt);
      log.info("prompt", "send() returned — adapter should be streaming");
      return { ok: true };
    }),
});

// -- Codex Deck -------------------------------------------------------------

async function codexDeckSnapshot(agentId: string, connect: boolean) {
  const config = await getLocalAgentConfig(agentId);
  if (!config) {
    throw new TRPCError({ code: "NOT_FOUND", message: `Agent ${agentId} is not configured on this host.` });
  }
  if (config.runtime.transport !== "codex_app_server") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Agent ${agentId} uses ${config.runtime.transport}; this control surface requires codex_app_server.`,
    });
  }

  const connected = connect ? await connectCodexDeckThread(agentId) : null;
  const online = connected ? true : await isCodexDeckThreadConnected(agentId);
  const snapshot = await getCodexDeckThreadSnapshot(agentId);
  const currentTurn = snapshot?.currentTurnId
    ? snapshot.turns.find((turn) => turn.id === snapshot.currentTurnId) ?? null
    : null;
  const running = Boolean(currentTurn && !["completed", "interrupted", "error"].includes(currentTurn.status));
  const observedThreadId = snapshot?.session.providerMeta?.threadId;
  const threadId = connected?.threadId
    ?? (typeof observedThreadId === "string" ? observedThreadId : snapshot?.session.id ?? null);

  return {
    adapter: "codex_app_server" as const,
    agentId,
    threadId,
    turnId: online && running ? currentTurn?.id ?? null : null,
    state: online ? running ? "running" as const : "idle" as const : "disconnected" as const,
    capabilities: {
      connect: true,
      start: true,
      steer: true,
      interrupt: true,
      queue: false,
      approvals: false,
    },
    capabilityNotes: {
      queue: "The Deck sends directly to Scout's managed Codex session and does not invent a client-side queue.",
      approvals: "Approval prompts remain runtime-owned and are not actionable from Deck yet.",
    },
    snapshot,
  };
}

const codexDeckRouter = t.router({
  snapshot: procedure
    .input(z.object({ agentId: z.string().min(1) }))
    .query(({ input }) => codexDeckSnapshot(input.agentId, false)),
  connect: procedure
    .input(z.object({ agentId: z.string().min(1) }))
    .mutation(({ input }) => codexDeckSnapshot(input.agentId, true)),
  start: procedure
    .input(z.object({ agentId: z.string().min(1), text: z.string().trim().min(1).max(65_536) }))
    .mutation(({ input }) => startCodexDeckTurn(input.agentId, input.text)),
  steer: procedure
    .input(z.object({ agentId: z.string().min(1), text: z.string().trim().min(1).max(65_536) }))
    .mutation(({ input }) => steerCodexDeckTurn(input.agentId, input.text)),
  interrupt: procedure
    .input(z.object({ agentId: z.string().min(1) }))
    .mutation(({ input }) => interruptCodexDeckTurn(input.agentId)),
});

// -- Sync -------------------------------------------------------------------

function replaySyncEvents(
  bridge: Bridge,
  sessionId: string,
  lastSeq: number,
): ReturnType<Bridge["replay"]> {
  return bridge.replay(sessionId, lastSeq);
}

function readSyncStatus(
  bridge: Bridge,
  sessionId: string,
): {
  currentSeq: ReturnType<Bridge["currentSeq"]>;
  oldestBufferedSeq: ReturnType<Bridge["oldestBufferedSeq"]>;
} {
  return {
    currentSeq: bridge.currentSeq(sessionId),
    oldestBufferedSeq: bridge.oldestBufferedSeq(sessionId),
  };
}

function resolveSyncSessionId(
  bridge: Bridge,
  preferredSessionId?: string,
): string | null {
  if (preferredSessionId) {
    return preferredSessionId;
  }

  let latestSessionId: string | null = null;
  let latestActivityAt = Number.NEGATIVE_INFINITY;

  for (const session of bridge.getSessionSummaries()) {
    if (session.lastActivityAt > latestActivityAt) {
      latestActivityAt = session.lastActivityAt;
      latestSessionId = session.sessionId;
    }
  }

  return latestSessionId;
}

const syncRouter = t.router({
  replay: procedure
    .input(z.object({ lastSeq: z.number(), sessionId: z.string().optional() }))
    .query(({ input, ctx }) => {
      const sessionId = resolveSyncSessionId(ctx.bridge, input.sessionId);
      if (!sessionId) {
        return { events: [] };
      }

      const events = replaySyncEvents(ctx.bridge, sessionId, input.lastSeq);
      return { events };
    }),

  status: procedure
    .input(z.object({ sessionId: z.string().optional() }).optional())
    .query(({ input, ctx }) => {
      const sessionCount = ctx.bridge.listSessions().length;
      const sessionId = resolveSyncSessionId(ctx.bridge, input?.sessionId);
      if (!sessionId) {
        return {
          currentSeq: 0,
          oldestBufferedSeq: 0,
          sessionCount,
        };
      }

      return {
        ...readSyncStatus(ctx.bridge, sessionId),
        sessionCount,
      };
    }),
});

// ---------------------------------------------------------------------------
// Top-level router
// ---------------------------------------------------------------------------

export const bridgeRouter = t.router({
  // Sub-routers (grouped by domain)
  session: sessionRouter,
  mobile: mobileRouter,
  workspace: workspaceRouter,
  history: historyRouter,
  prompt: promptRouter,
  codexDeck: codexDeckRouter,
  sync: syncRouter,

  // -- Top-level procedures (no sub-router grouping) -----------------------

  // bridge/status
  bridgeStatus: procedure.query(({ ctx }) => {
    const sessions = ctx.bridge.getSessionSummaries();
    return { sessions };
  }),

  // turn/interrupt
  turnInterrupt: procedure
    .input(z.object({ sessionId: z.string(), turnId: z.string().min(1).optional() }))
    .mutation(({ input, ctx }) => {
      try {
        if (input.turnId) ctx.bridge.interruptTurn(input.sessionId, input.turnId);
        else ctx.bridge.interrupt(input.sessionId);
      } catch (error) {
        throw toTRPCRegistryError(error) ?? error;
      }
      return { ok: true };
    }),

  // question/answer — routes a user's answer back to the adapter
  questionAnswer: procedure
    .input(z.object({
      sessionId: z.string(),
      blockId: z.string(),
      answer: z.array(z.string()),
    }))
    .mutation(({ input, ctx }) => {
      try {
        ctx.bridge.answerQuestion(input);
      } catch (error) {
        throw toTRPCRegistryError(error) ?? error;
      }
      return { ok: true };
    }),

  // action/decide
  actionDecide: procedure
    .input(
      z.object({
        sessionId: z.string(),
        turnId: z.string(),
        blockId: z.string(),
        version: z.number(),
        decision: z.enum(["approve", "deny"]),
        reason: z.string().optional(),
      }),
    )
    .mutation(({ input, ctx }) => {
      const snapshot = ctx.bridge.getSessionSnapshot(input.sessionId);
      if (!snapshot) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No session: ${input.sessionId}`,
        });
      }

      const turn = snapshot.turns.find((t) => t.id === input.turnId);
      if (!turn) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No turn: ${input.turnId}`,
        });
      }

      const blockState = turn.blocks.find((b) => b.block.id === input.blockId);
      if (!blockState || blockState.block.type !== "action") {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No action block: ${input.blockId}`,
        });
      }

      const action = (blockState.block as ActionBlock).action;
      if (!action.approval || action.approval.version !== input.version) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Stale approval version",
        });
      }

      try {
        ctx.bridge.decide({
          sessionId: input.sessionId,
          turnId: input.turnId,
          blockId: input.blockId,
          version: input.version,
          decision: input.decision,
          reason: input.reason,
        });
      } catch (error) {
        throw toTRPCRegistryError(error) ?? error;
      }
      return { ok: true };
    }),

  // -- Subscription: events -------------------------------------------------

  events: procedure
    .input(z.object({ sessionId: z.string().optional() }).optional())
    .subscription(async function* ({ input, ctx, signal }) {
      for await (const event of bridgeEventIterable(ctx.bridge, signal)) {
        // Filter by sessionId if provided
        if (input?.sessionId) {
          const eventSessionId = getEventSessionId(event);
          if (eventSessionId && eventSessionId !== input.sessionId) {
            continue;
          }
        }

        yield tracked(trackedSequencedEventId(event), {
          seq: event.seq,
          event: event.event,
          timestamp: event.timestamp,
        });
      }
    }),
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export type BridgeRouter = typeof bridgeRouter;
