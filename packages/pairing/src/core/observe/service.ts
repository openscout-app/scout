import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  OBSERVED_HARNESS_TOPOLOGY_META_KEY,
  createHistorySessionSnapshot,
  supportsHistorySessionSnapshotForPath,
  type ObservedHarnessTopology,
  type Block,
  type HistorySessionEvent,
  type AgentSessionStreamEvent,
  type SessionState,
} from "@openscout/agent-sessions";
import {
  getLocalAgentEndpointSessionSnapshot,
  getLocalAgentSessionSnapshot,
  getTailDiscovery,
  readTailEventsForSession,
  refreshTailDiscovery,
  type DiscoverySnapshot,
} from "@openscout/runtime/harnesses";
import {
  epochMs,
  flightSessionTrace,
  type AgentEndpoint,
  type FlightRecord,
} from "@openscout/protocol";

import {
  canonicalSessionHarness,
  parseSessionRouteRef,
  sessionHarnessMatches,
} from "../../shared/session-route-ref.ts";
import type { WebAgent } from "../../db-queries.ts";
import { queryAgentById, queryAgents } from "../../db-queries.ts";
import { getScoutWebPairingSessionSnapshot } from "../../pairing.ts";
import {
  endpointMetadataRecord,
  endpointSessionAliases,
  selectPreferredAgentEndpoint,
} from "../agent-endpoints.ts";
import {
  loadScoutBrokerContext,
  readScoutBrokerTailDiscovery,
} from "../broker/service.ts";
import { buildObserveDataFromTail } from "./tail-observe.ts";
import type {
  ObserveEventKind,
  ObserveEvent,
  ObserveFile,
  ObserveUsageMeta,
  ObserveSessionMeta,
  ObserveMetadata,
  ObservePulse,
  ObserveData,
  ObserveInitiatingAsk,
  AgentObservePayload,
} from "../../shared/api/observe.ts";
export type {
  ObserveEventKind,
  ObserveEvent,
  ObserveFile,
  ObserveUsageMeta,
  ObserveSessionMeta,
  ObserveMetadata,
  ObservePulse,
  ObserveData,
  ObserveInitiatingAsk,
  AgentObservePayload,
} from "../../shared/api/observe.ts";

type TimestampedPairingEvent = {
  timestamp: number;
  event: AgentSessionStreamEvent;
};

type ObserveBrokerContext = Awaited<ReturnType<typeof loadScoutBrokerContext>>;

type SnapshotSource =
  | {
      source: "history";
      historyPath: string;
      snapshot: SessionState;
      timedEvents: TimestampedPairingEvent[];
      live: boolean;
      sessionId: string | null;
      sessionAliases: string[];
    }
  | {
      source: "live";
      historyPath: string | null;
      snapshot: SessionState;
      timedEvents: TimestampedPairingEvent[];
      live: boolean;
      sessionId: string | null;
      sessionAliases: string[];
    }
  | {
      source: "unavailable";
      historyPath: null;
      live: false;
      sessionId: null;
      sessionAliases: string[];
    };

type HistorySnapshotResult = {
  historyPath: string;
  snapshot: SessionState;
  timedEvents: TimestampedPairingEvent[];
};

type HistorySnapshotCacheEntry = HistorySnapshotResult & {
  adapterType: "claude-code" | "codex" | "pi";
  mtimeMs: number;
  size: number;
};

const HISTORY_SNAPSHOT_CACHE_LIMIT = 128;
const historySnapshotCache = new Map<string, HistorySnapshotCacheEntry>();
const OBSERVE_SUMMARY_TAIL_SIZE = 8;
// Tail discovery is the normal, materialized session index. This filesystem
// lookup only covers cold/legacy Claude refs that are absent from that index,
// so rebuilding it more often than discovery itself just restats thousands of
// unchanged transcript descriptors on the request path.
const SESSION_REF_LOOKUP_TTL_MS = 60_000;

type SessionRefLookupEntry = {
  refId: string;
  historyPath: string;
  adapterType: "claude-code" | "codex" | "pi";
  mtimeMs: number;
  size: number;
};

type SessionRefLookupCache = {
  generatedAt: number;
  entries: Map<string, SessionRefLookupEntry>;
};

let sessionRefLookupCache: SessionRefLookupCache | null = null;
const AMBIGUOUS_TAIL_SESSION_REF = Symbol("ambiguous-tail-session-ref");

export type SessionRefObservePayload =
  | {
      kind: "agent";
      refId: string;
      agentId: string;
      source: AgentObservePayload["source"];
      fidelity: AgentObservePayload["fidelity"];
      historyPath: string | null;
      sessionId: string | null;
      updatedAt: number;
      data: ObserveData;
    }
  | {
      kind: "history";
      refId: string;
      agentId: null;
      source: "history";
      fidelity: "timestamped" | "synthetic";
      historyPath: string;
      sessionId: string;
      updatedAt: number;
      data: ObserveData;
    }
  | {
      kind: "tail";
      refId: string;
      agentId: null;
      source: "tail";
      fidelity: "synthetic";
      historyPath: string;
      sessionId: string;
      updatedAt: number;
      data: ObserveData;
    }
  | {
      kind: "broker";
      refId: string;
      agentId: string;
      source: "broker" | "history" | "live" | "tail";
      fidelity: "timestamped" | "synthetic";
      historyPath: string | null;
      sessionId: string | null;
      updatedAt: number;
      data: ObserveData;
    };

function normalizedComparableString(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function normalizedSessionAlias(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().toLowerCase()
    : null;
}

function normalizedFilesystemPath(value: string | null | undefined): string | null {
  const expanded = expandHome(value)?.trim();
  return expanded ? resolve(expanded) : null;
}

function expandHome(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function encodeClaudeProjectsSlug(absolutePath: string): string {
  const normalized = resolve(absolutePath);
  return `-${normalized.replace(/^\//u, "").replace(/\//gu, "-")}`;
}

function claudeProjectsRoot(): string {
  return process.env.OPENSCOUT_CLAUDE_PROJECTS_ROOT?.trim()
    || join(homedir(), ".claude", "projects");
}

function resolveClaudeHistoryPath(
  cwd: string | null | undefined,
  sessionId: string | null | undefined,
  options: { allowMostRecentFallback?: boolean } = {},
): string | null {
  const normalizedCwd = expandHome(cwd)?.trim();
  if (!normalizedCwd) {
    return null;
  }
  const projectDir = join(
    claudeProjectsRoot(),
    encodeClaudeProjectsSlug(normalizedCwd),
  );
  const normalizedSessionId = sessionId?.trim().replace(/\.jsonl$/u, "") || "";
  if (normalizedSessionId) {
    const exactPath = join(projectDir, `${normalizedSessionId}.jsonl`);
    if (existsSync(exactPath)) {
      return exactPath;
    }
  }
  if (options.allowMostRecentFallback === false) {
    return null;
  }
  // Fallback: find the most recently modified .jsonl in the project dir
  return findMostRecentJsonl(projectDir);
}

function findMostRecentJsonl(dir: string): string | null {
  if (!existsSync(dir)) return null;
  try {
    let best: { path: string; mtime: number } | null = null;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".jsonl")) continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (!best || st.mtimeMs > best.mtime) {
        best = { path: full, mtime: st.mtimeMs };
      }
    }
    return best?.path ?? null;
  } catch {
    return null;
  }
}

function normalizeSessionRefId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const leaf = basename(trimmed);
  return leaf.endsWith(".jsonl") ? leaf.slice(0, -".jsonl".length) : leaf;
}

function tailSessionRefTranscripts(
  discovery: Awaited<ReturnType<typeof getTailDiscovery>>,
  normalizedRef: string,
  harness: string | null,
) {
  return discovery.transcripts.filter((transcript) => {
    if (!sessionHarnessMatches(harness, transcript.source)) return false;
    const refs = [
      normalizeSessionRefId(transcript.sessionId),
      normalizeSessionRefId(transcript.transcriptPath),
    ].filter((candidate): candidate is string => Boolean(candidate));
    return refs.includes(normalizedRef);
  });
}

function bestTailSessionRefLookupEntry(
  transcripts: DiscoverySnapshot["transcripts"],
  normalizedRef: string,
): SessionRefLookupEntry | null {
  const matches: SessionRefLookupEntry[] = [];
  for (const transcript of transcripts) {
    const adapterType = adapterTypeFromTailSource(transcript.source);
    if (!adapterType || !supportsHistorySessionSnapshotForPath(transcript.transcriptPath, adapterType)) {
      continue;
    }
    matches.push({
      refId: normalizedRef,
      historyPath: transcript.transcriptPath,
      adapterType,
      mtimeMs: transcript.mtimeMs,
      size: transcript.size,
    });
  }
  return matches.sort((left, right) => right.mtimeMs - left.mtimeMs)[0] ?? null;
}

function hasAmbiguousTailHarness(
  transcripts: Awaited<ReturnType<typeof getTailDiscovery>>["transcripts"],
): boolean {
  const sources = new Set(transcripts.map((transcript) => (
    canonicalSessionHarness(transcript.source) ?? transcript.source.trim().toLowerCase()
  )));
  return sources.size > 1;
}

function addSessionRefLookupEntry(
  entries: Map<string, SessionRefLookupEntry>,
  entry: SessionRefLookupEntry,
): void {
  const current = entries.get(entry.refId);
  if (!current || entry.mtimeMs > current.mtimeMs) {
    entries.set(entry.refId, entry);
  }
}

function buildClaudeSessionRefLookup(): Map<string, SessionRefLookupEntry> {
  const entries = new Map<string, SessionRefLookupEntry>();
  const projectsRoot = claudeProjectsRoot();
  if (!existsSync(projectsRoot)) {
    return entries;
  }

  try {
    for (const projectEntry of readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!projectEntry.isDirectory()) {
        continue;
      }
      const projectDir = join(projectsRoot, projectEntry.name);
      for (const historyEntry of readdirSync(projectDir, { withFileTypes: true })) {
        if (!historyEntry.isFile() || !historyEntry.name.endsWith(".jsonl")) {
          continue;
        }
        const refId = normalizeSessionRefId(historyEntry.name);
        if (!refId) {
          continue;
        }
        const historyPath = join(projectDir, historyEntry.name);
        const stat = statSync(historyPath);
        addSessionRefLookupEntry(entries, {
          refId,
          historyPath,
          adapterType: "claude-code",
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        });
      }
    }
  } catch {
    return entries;
  }

  return entries;
}

function sessionRefLookup(): Map<string, SessionRefLookupEntry> {
  const now = Date.now();
  if (
    sessionRefLookupCache
    && now - sessionRefLookupCache.generatedAt < SESSION_REF_LOOKUP_TTL_MS
  ) {
    return sessionRefLookupCache.entries;
  }
  const entries = buildClaudeSessionRefLookup();
  sessionRefLookupCache = { generatedAt: now, entries };
  return entries;
}

function adapterTypeFromTailSource(source: string): "claude-code" | "codex" | "pi" | null {
  const normalized = source.trim().toLowerCase();
  if (normalized === "claude" || normalized === "claude-code") {
    return "claude-code";
  }
  if (normalized === "codex") {
    return "codex";
  }
  if (normalized === "pi" || normalized === "pi_rpc") {
    return "pi";
  }
  return null;
}

async function findTailSessionRefLookupEntry(
  normalizedRef: string,
  harness: string | null = null,
): Promise<SessionRefLookupEntry | null | typeof AMBIGUOUS_TAIL_SESSION_REF> {
  const discovery = await getTailDiscovery().catch(() => null);
  if (!discovery?.transcripts.length) {
    return null;
  }

  const transcripts = tailSessionRefTranscripts(discovery, normalizedRef, harness);
  if (!harness && hasAmbiguousTailHarness(transcripts)) return AMBIGUOUS_TAIL_SESSION_REF;
  return bestTailSessionRefLookupEntry(transcripts, normalizedRef);
}

function historyAdapterAlias(
  value: string | null | undefined,
): "claude-code" | "codex" | "pi" | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "claude" || normalized === "claude-code" || normalized === "claude_stream_json") {
    return "claude-code";
  }
  if (normalized === "codex" || normalized === "codex_app_server") {
    return "codex";
  }
  if (normalized === "pi" || normalized === "pi_rpc") {
    return "pi";
  }
  return null;
}

function historyAdapterForEndpoint(
  endpoint: AgentEndpoint | null | undefined,
): "claude-code" | "codex" | "pi" | null {
  return historyAdapterAlias(endpoint?.harness) ?? historyAdapterAlias(endpoint?.transport);
}

function historyAdapterForAgent(
  agent: WebAgent,
): "claude-code" | "codex" | "pi" | null {
  return historyAdapterAlias(agent.harness) ?? historyAdapterAlias(agent.transport);
}

function snapshotProviderMeta(snapshot: SessionState): Record<string, unknown> {
  const providerMeta = snapshot.session.providerMeta;
  return providerMeta && typeof providerMeta === "object" ? providerMeta : {};
}

function metadataRecord(
  metadata: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = metadata?.[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function metadataNumber(
  metadata: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildObserveMetadata(
  snapshot: SessionState,
  sessionStart?: number,
): ObserveMetadata | undefined {
  const providerMeta = snapshotProviderMeta(snapshot);
  const observeRuntime = metadataRecord(providerMeta, "observeRuntime");
  const observeUsage = metadataRecord(providerMeta, "observeUsage");

  const sessionMeta: ObserveSessionMeta = {};
  if (snapshot.session.adapterType) sessionMeta.adapterType = snapshot.session.adapterType;
  if (snapshot.session.model) sessionMeta.model = snapshot.session.model;
  if (snapshot.session.reasoningEffort) sessionMeta.effort = snapshot.session.reasoningEffort;
  if (snapshot.session.cwd) sessionMeta.cwd = snapshot.session.cwd;
  if (typeof sessionStart === "number" && Number.isFinite(sessionStart)) {
    sessionMeta.sessionStart = sessionStart;
  }
  if (snapshot.turns.length > 0) sessionMeta.turnCount = snapshot.turns.length;
  if (metadataString(providerMeta, "externalSessionId")) {
    sessionMeta.externalSessionId = metadataString(providerMeta, "externalSessionId");
  }
  if (metadataString(providerMeta, "threadId")) {
    sessionMeta.threadId = metadataString(providerMeta, "threadId");
  }
  if (metadataString(providerMeta, "threadPath")) {
    sessionMeta.threadPath = metadataString(providerMeta, "threadPath");
  }
  if (metadataString(observeRuntime, "gitBranch")) {
    sessionMeta.gitBranch = metadataString(observeRuntime, "gitBranch");
  }
  if (metadataString(observeRuntime, "cliVersion")) {
    sessionMeta.cliVersion = metadataString(observeRuntime, "cliVersion");
  }
  if (metadataString(observeRuntime, "entrypoint")) {
    sessionMeta.entrypoint = metadataString(observeRuntime, "entrypoint");
  }
  if (metadataString(observeRuntime, "originator")) {
    sessionMeta.originator = metadataString(observeRuntime, "originator");
  }
  if (metadataString(observeRuntime, "source")) {
    sessionMeta.source = metadataString(observeRuntime, "source");
  }
  if (metadataString(observeRuntime, "permissionMode")) {
    sessionMeta.permissionMode = metadataString(observeRuntime, "permissionMode");
  }
  if (metadataString(observeRuntime, "approvalPolicy")) {
    sessionMeta.approvalPolicy = metadataString(observeRuntime, "approvalPolicy");
  }
  if (metadataString(observeRuntime, "sandbox")) {
    sessionMeta.sandbox = metadataString(observeRuntime, "sandbox");
  }
  if (metadataString(observeRuntime, "userType")) {
    sessionMeta.userType = metadataString(observeRuntime, "userType");
  }
  if (metadataString(observeRuntime, "effort")) {
    sessionMeta.effort = metadataString(observeRuntime, "effort");
  }
  if (metadataString(observeRuntime, "modelProvider")) {
    sessionMeta.modelProvider = metadataString(observeRuntime, "modelProvider");
  }
  if (metadataString(observeRuntime, "timezone")) {
    sessionMeta.timezone = metadataString(observeRuntime, "timezone");
  }

  const usageMeta: ObserveUsageMeta = {};
  if (metadataNumber(observeUsage, "assistantMessages") !== undefined) {
    usageMeta.assistantMessages = metadataNumber(observeUsage, "assistantMessages");
  }
  if (metadataNumber(observeUsage, "inputTokens") !== undefined) {
    usageMeta.inputTokens = metadataNumber(observeUsage, "inputTokens");
  }
  if (metadataNumber(observeUsage, "contextInputTokens") !== undefined) {
    usageMeta.contextInputTokens = metadataNumber(observeUsage, "contextInputTokens");
  }
  if (metadataNumber(observeUsage, "outputTokens") !== undefined) {
    usageMeta.outputTokens = metadataNumber(observeUsage, "outputTokens");
  }
  if (metadataNumber(observeUsage, "reasoningOutputTokens") !== undefined) {
    usageMeta.reasoningOutputTokens = metadataNumber(observeUsage, "reasoningOutputTokens");
  }
  if (metadataNumber(observeUsage, "cacheReadInputTokens") !== undefined) {
    usageMeta.cacheReadInputTokens = metadataNumber(observeUsage, "cacheReadInputTokens");
  }
  if (metadataNumber(observeUsage, "cacheCreationInputTokens") !== undefined) {
    usageMeta.cacheCreationInputTokens = metadataNumber(observeUsage, "cacheCreationInputTokens");
  }
  if (metadataNumber(observeUsage, "totalTokens") !== undefined) {
    usageMeta.totalTokens = metadataNumber(observeUsage, "totalTokens");
  }
  if (metadataNumber(observeUsage, "contextWindowTokens") !== undefined) {
    usageMeta.contextWindowTokens = metadataNumber(observeUsage, "contextWindowTokens");
  }
  if (metadataNumber(observeUsage, "webSearchRequests") !== undefined) {
    usageMeta.webSearchRequests = metadataNumber(observeUsage, "webSearchRequests");
  }
  if (metadataNumber(observeUsage, "webFetchRequests") !== undefined) {
    usageMeta.webFetchRequests = metadataNumber(observeUsage, "webFetchRequests");
  }
  if (metadataString(observeUsage, "serviceTier")) {
    usageMeta.serviceTier = metadataString(observeUsage, "serviceTier");
  }
  if (metadataString(observeUsage, "speed")) {
    usageMeta.speed = metadataString(observeUsage, "speed");
  }
  if (metadataString(observeUsage, "planType")) {
    usageMeta.planType = metadataString(observeUsage, "planType");
  }

  const observedTopology =
    metadataRecord(providerMeta, OBSERVED_HARNESS_TOPOLOGY_META_KEY) as ObservedHarnessTopology | undefined;
  const hasSessionMeta = Object.keys(sessionMeta).length > 0;
  const hasUsageMeta = Object.keys(usageMeta).length > 0;
  if (!hasSessionMeta && !hasUsageMeta && !observedTopology) {
    return undefined;
  }

  return {
    ...(hasSessionMeta ? { session: sessionMeta } : {}),
    ...(hasUsageMeta ? { usage: usageMeta } : {}),
    ...(observedTopology ? { topology: observedTopology } : {}),
  };
}

function firstString(
  ...values: Array<unknown>
): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function directRuntimeEndpointRequiresSessionMatch(
  endpoint: AgentEndpoint | null | undefined,
): boolean {
  if (!endpoint) {
    return false;
  }
  const endpointMeta = endpointMetadataRecord(endpoint);
  const runtimeMode = metadataString(endpointMeta, "runtimeMode")?.toLowerCase();
  const transport = normalizedComparableString(endpoint.transport);
  return runtimeMode === "direct_session"
    || transport === "codex_app_server"
    || transport === "claude_stream_json"
    || transport === "pi_rpc";
}

function historyPathSessionId(path: string): string | null {
  const name = basename(path).trim();
  if (!name) {
    return null;
  }
  return name.replace(/\.(jsonl|json)$/u, "") || null;
}

function historySnapshotSessionId(history: HistorySnapshotResult): string | null {
  const providerMeta = snapshotProviderMeta(history.snapshot);
  const snapshotSessionId = history.snapshot.session.id?.startsWith("history:")
    ? null
    : history.snapshot.session.id;
  return firstString(
    providerMeta.externalSessionId,
    providerMeta.threadId,
    providerMeta.transportSessionId,
    providerMeta.nativeSessionId,
    snapshotSessionId,
    historyPathSessionId(history.historyPath),
  );
}

function resolveHistoryCandidate(
  agent: WebAgent,
  snapshot: SessionState | null,
  endpoint?: AgentEndpoint | null,
): { path: string; adapterType: "claude-code" | "codex" | "pi" } | null {
  const snapshotAdapter = historyAdapterAlias(snapshot?.session.adapterType);
  const endpointAdapter = historyAdapterForEndpoint(endpoint);
  const agentAdapter = historyAdapterForAgent(agent);
  const providerMeta = snapshot ? snapshotProviderMeta(snapshot) : {};
  const endpointMeta = endpointMetadataRecord(endpoint);
  const requireSessionMatch = directRuntimeEndpointRequiresSessionMatch(endpoint);

  const directPath = firstString(
    providerMeta.resumeSessionPath,
    providerMeta.threadPath,
    endpointMeta.threadPath,
  );
  if (directPath) {
    const adapterType = snapshotAdapter ?? endpointAdapter ?? agentAdapter;
    if (adapterType) {
      return { path: directPath, adapterType };
    }
  }

  const claudeSessionId = firstString(
    providerMeta.transportSessionId,
    providerMeta.externalSessionId,
    providerMeta.threadId,
    providerMeta.nativeSessionId,
    endpoint?.sessionId,
    endpointMeta.sessionId,
    endpointMeta.runtimeSessionId,
    endpointMeta.runtimeInstanceId,
    endpointMeta.threadId,
    endpointMeta.externalSessionId,
    endpointMeta.nativeSessionId,
    agent.harnessSessionId,
  );
  const claudeCwd = firstString(
    snapshot?.session.cwd,
    agent.cwd,
    agent.projectRoot,
  );
  if ((snapshotAdapter ?? endpointAdapter ?? agentAdapter) === "claude-code") {
    const path = resolveClaudeHistoryPath(claudeCwd, claudeSessionId, {
      allowMostRecentFallback: !requireSessionMatch,
    });
    if (path) {
      return { path, adapterType: "claude-code" };
    }
  }

  return null;
}

function collectSessionRefs(
  agent: WebAgent,
  snapshot: SessionState | null,
  endpoint: AgentEndpoint | null | undefined,
): Set<string> {
  const providerMeta = snapshot ? snapshotProviderMeta(snapshot) : {};
  const refs = new Set([
    snapshot?.session.id,
    providerMeta.transportSessionId,
    providerMeta.externalSessionId,
    providerMeta.threadId,
    providerMeta.nativeSessionId,
    agent.harnessSessionId,
  ].map(normalizedSessionAlias).filter((ref): ref is string => Boolean(ref)));
  if (endpoint) {
    for (const alias of endpointSessionAliases(endpoint)) {
      refs.add(alias);
    }
  }
  return refs;
}

function collectAgentCwdRefs(agent: WebAgent, snapshot: SessionState | null, endpoint: AgentEndpoint | null | undefined): Set<string> {
  return new Set([
    normalizedFilesystemPath(snapshot?.session.cwd),
    normalizedFilesystemPath(endpoint?.cwd),
    normalizedFilesystemPath(endpoint?.projectRoot),
    normalizedFilesystemPath(agent.cwd),
    normalizedFilesystemPath(agent.projectRoot),
  ].filter((path): path is string => Boolean(path)));
}

async function resolveDiscoveredHistoryCandidate(
  agent: WebAgent,
  snapshot: SessionState | null,
  endpoint?: AgentEndpoint | null,
): Promise<{ path: string; adapterType: "claude-code" | "codex" | "pi" } | null> {
  const adapterType = historyAdapterAlias(snapshot?.session.adapterType)
    ?? historyAdapterForEndpoint(endpoint)
    ?? historyAdapterForAgent(agent);
  if (!adapterType) {
    return null;
  }

  const discovery = await getTailDiscovery().catch(() => null);
  if (!discovery?.transcripts.length) {
    return null;
  }

  const sessionRefs = collectSessionRefs(agent, snapshot, endpoint);
  const cwdRefs = collectAgentCwdRefs(agent, snapshot, endpoint);
  const agentProject = normalizedComparableString(agent.project);
  const requireSessionMatch = directRuntimeEndpointRequiresSessionMatch(endpoint);
  const candidates = discovery.transcripts
    .filter((transcript) => adapterTypeFromTailSource(transcript.source) === adapterType)
    .map((transcript) => {
      const sessionMatch = Boolean(transcript.sessionId && sessionRefs.has(transcript.sessionId.trim().toLowerCase()));
      const cwd = normalizedFilesystemPath(transcript.cwd);
      const cwdMatch = Boolean(cwd && cwdRefs.has(cwd));
      const projectMatch = Boolean(
        agentProject
        && normalizedComparableString(transcript.project) === agentProject
        && cwdRefs.size > 0,
      );
      return {
        transcript,
        sessionMatch,
        cwdMatch,
        projectMatch,
      };
    })
    .filter(({ sessionMatch, cwdMatch, projectMatch }) => (
      sessionMatch || (!requireSessionMatch && (cwdMatch || projectMatch))
    ))
    .sort((left, right) => {
      const leftTuple = [
        left.sessionMatch ? 0 : 1,
        left.cwdMatch ? 0 : 1,
        left.projectMatch ? 0 : 1,
        -left.transcript.mtimeMs,
        -left.transcript.size,
      ];
      const rightTuple = [
        right.sessionMatch ? 0 : 1,
        right.cwdMatch ? 0 : 1,
        right.projectMatch ? 0 : 1,
        -right.transcript.mtimeMs,
        -right.transcript.size,
      ];
      for (let index = 0; index < leftTuple.length; index += 1) {
        const leftValue = leftTuple[index]!;
        const rightValue = rightTuple[index]!;
        if (leftValue < rightValue) {
          return -1;
        }
        if (leftValue > rightValue) {
          return 1;
        }
      }
      return left.transcript.transcriptPath.localeCompare(right.transcript.transcriptPath);
    });

  for (const { transcript } of candidates) {
    if (supportsHistorySessionSnapshotForPath(transcript.transcriptPath, adapterType)) {
      return { path: transcript.transcriptPath, adapterType };
    }
  }
  return null;
}

function normalizeTimedEvents(
  events: HistorySessionEvent[] | undefined,
): TimestampedPairingEvent[] {
  if (!events) {
    return [];
  }
  return events.map((entry) => ({
    timestamp: entry.capturedAt,
    event: entry.event,
  }));
}

function readHistorySnapshot(
  candidate: { path: string; adapterType: "claude-code" | "codex" | "pi" } | null,
): HistorySnapshotResult | null {
  if (!candidate) {
    return null;
  }
  if (!supportsHistorySessionSnapshotForPath(candidate.path, candidate.adapterType)) {
    return null;
  }
  if (!existsSync(candidate.path)) {
    return null;
  }

  const stat = statSync(candidate.path);
  const cached = historySnapshotCache.get(candidate.path);
  if (
    cached
    && cached.adapterType === candidate.adapterType
    && cached.mtimeMs === stat.mtimeMs
    && cached.size === stat.size
  ) {
    return {
      historyPath: cached.historyPath,
      snapshot: cached.snapshot,
      timedEvents: cached.timedEvents,
    };
  }
  const replay = createHistorySessionSnapshot({
    path: candidate.path,
    content: readFileSync(candidate.path, "utf8"),
    adapterType: candidate.adapterType,
    baseTimestampMs: stat.mtimeMs,
  });
  if (replay.events.length === 0) {
    return null;
  }

  const nextEntry: HistorySnapshotCacheEntry = {
    historyPath: candidate.path,
    snapshot: replay.snapshot,
    timedEvents: normalizeTimedEvents(replay.events),
    adapterType: candidate.adapterType,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
  historySnapshotCache.set(candidate.path, nextEntry);
  if (historySnapshotCache.size > HISTORY_SNAPSHOT_CACHE_LIMIT) {
    const oldestKey = historySnapshotCache.keys().next().value;
    if (typeof oldestKey === "string") {
      historySnapshotCache.delete(oldestKey);
    }
  }

  return {
    historyPath: nextEntry.historyPath,
    snapshot: nextEntry.snapshot,
    timedEvents: nextEntry.timedEvents,
  };
}

async function readEndpointSessionSnapshot(endpoint: AgentEndpoint | null): Promise<SessionState | null> {
  if (!endpoint?.sessionId) {
    return null;
  }
  if (endpoint.transport === "pairing_bridge") {
    return await getScoutWebPairingSessionSnapshot(endpoint.sessionId);
  }
  if (endpoint.transport === "codex_app_server" || endpoint.transport === "claude_stream_json" || endpoint.transport === "pi_rpc") {
    return await getLocalAgentEndpointSessionSnapshot(endpoint);
  }
  return null;
}

async function readLiveSnapshot(agent: WebAgent, endpoint: AgentEndpoint | null): Promise<SessionState | null> {
  const configuredSnapshot = await getLocalAgentSessionSnapshot(agent.id).catch(() => null);
  if (configuredSnapshot) {
    return configuredSnapshot;
  }

  return readEndpointSessionSnapshot(endpoint);
}

function summarizeCommandOutput(output: string): string[] | undefined {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return undefined;
  }
  return lines.slice(-12);
}

function truncatePreview(value: string, maxLines = 6, maxChars = 400): string {
  const lines = value
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(0, maxLines);
  const joined = lines.join("\n");
  return joined.length <= maxChars ? joined : `${joined.slice(0, maxChars - 1).trimEnd()}…`;
}

function countDiffStats(value: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of value.split(/\r?\n/u)) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      continue;
    }
    if (line.startsWith("+")) {
      add += 1;
    } else if (line.startsWith("-")) {
      del += 1;
    }
  }
  return { add, del };
}

function toolArgSummary(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "";
  }
  const record = input as Record<string, unknown>;
  const preferred = firstString(
    record.file_path,
    record.path,
    record.command,
    record.pattern,
    record.query,
    record.glob,
    record.prompt,
    record.description,
  );
  if (preferred) {
    return preferred;
  }
  try {
    return JSON.stringify(record);
  } catch {
    return "";
  }
}

function normalizeToolName(toolName: string): string {
  switch (toolName.trim().toLowerCase()) {
    case "read":
    case "view":
      return "read";
    case "grep":
    case "glob":
    case "search":
      return "grep";
    case "edit":
    case "multiedit":
      return "edit";
    case "write":
      return "write";
    case "bash":
      return "bash";
    case "agent":
      return "agent";
    default:
      return toolName.trim().toLowerCase() || "tool";
  }
}

function fileStatePriority(state: ObserveFile["state"]): number {
  switch (state) {
    case "created":
      return 3;
    case "modified":
      return 2;
    case "read":
      return 1;
  }
}

function addTouchedFile(
  files: Map<string, ObserveFile>,
  path: string,
  state: ObserveFile["state"],
  lastT: number,
): void {
  const normalizedPath = path.trim();
  if (!normalizedPath) {
    return;
  }
  const existing = files.get(normalizedPath);
  if (!existing) {
    files.set(normalizedPath, {
      path: normalizedPath,
      state,
      touches: 1,
      lastT,
    });
    return;
  }

  existing.touches += 1;
  existing.lastT = Math.max(existing.lastT, lastT);
  if (fileStatePriority(state) > fileStatePriority(existing.state)) {
    existing.state = state;
  }
}

function detectFileTouches(
  block: Block,
  t: number,
  files: Map<string, ObserveFile>,
): void {
  if (block.type !== "action") {
    return;
  }

  const { action } = block;
  if (action.kind === "file_change" && action.path.trim()) {
    addTouchedFile(files, action.path, "modified", t);
    return;
  }

  if (action.kind !== "tool_call") {
    return;
  }

  const toolName = normalizeToolName(action.toolName);
  const input = action.input as Record<string, unknown> | undefined;
  const path = firstString(input?.file_path, input?.path);
  if (!path) {
    return;
  }

  if (toolName === "read" || toolName === "grep") {
    addTouchedFile(files, path, "read", t);
    return;
  }

  if (toolName === "write") {
    addTouchedFile(files, path, "created", t);
    return;
  }

  if (toolName === "edit") {
    addTouchedFile(files, path, "modified", t);
  }
}

function buildTimingLookup(
  snapshot: SessionState,
  timedEvents: TimestampedPairingEvent[],
): {
  baseTimestampMs: number;
  bootTimestampMs: number;
  turnStartedAtMs: Map<string, number>;
  turnEndedAtMs: Map<string, number>;
  blockStartedAtMs: Map<string, number>;
  questionAnsweredAtMs: Map<string, number>;
} {
  const turnStartedAtMs = new Map<string, number>();
  const turnEndedAtMs = new Map<string, number>();
  const blockStartedAtMs = new Map<string, number>();
  const questionAnsweredAtMs = new Map<string, number>();

  let bootTimestampMs = Number.POSITIVE_INFINITY;

  for (const entry of timedEvents) {
    if (entry.event.event === "session:update") {
      bootTimestampMs = Math.min(bootTimestampMs, entry.timestamp);
      continue;
    }
    if (entry.event.event === "turn:start") {
      turnStartedAtMs.set(entry.event.turn.id, entry.timestamp);
      bootTimestampMs = Math.min(bootTimestampMs, entry.timestamp);
      continue;
    }
    if (entry.event.event === "turn:end" || entry.event.event === "turn:error") {
      turnEndedAtMs.set(entry.event.turnId, entry.timestamp);
      continue;
    }
    if (entry.event.event === "block:start") {
      blockStartedAtMs.set(entry.event.block.id, entry.timestamp);
      continue;
    }
    if (entry.event.event === "block:question:answer") {
      questionAnsweredAtMs.set(entry.event.blockId, entry.timestamp);
    }
  }

  for (const turn of snapshot.turns) {
    if (!turnStartedAtMs.has(turn.id) && Number.isFinite(turn.startedAt)) {
      turnStartedAtMs.set(turn.id, turn.startedAt);
    }
    if (!turnEndedAtMs.has(turn.id) && Number.isFinite(turn.endedAt ?? NaN)) {
      turnEndedAtMs.set(turn.id, turn.endedAt!);
    }
    bootTimestampMs = Math.min(bootTimestampMs, turnStartedAtMs.get(turn.id) ?? Number.POSITIVE_INFINITY);
  }

  if (!Number.isFinite(bootTimestampMs)) {
    bootTimestampMs = Date.now();
  }

  return {
    baseTimestampMs: bootTimestampMs,
    bootTimestampMs,
    turnStartedAtMs,
    turnEndedAtMs,
    blockStartedAtMs,
    questionAnsweredAtMs,
  };
}

function blockTimestampMs(
  turnId: string,
  block: Block,
  turnBlockCount: number,
  timing: ReturnType<typeof buildTimingLookup>,
): number {
  const explicit = timing.blockStartedAtMs.get(block.id);
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return explicit;
  }

  const turnStart = timing.turnStartedAtMs.get(turnId) ?? timing.baseTimestampMs;
  const turnEnd = timing.turnEndedAtMs.get(turnId)
    ?? (turnStart + Math.max(3_000, turnBlockCount * 2_000));
  const duration = Math.max(1_000, turnEnd - turnStart);
  const step = duration / Math.max(1, turnBlockCount + 1);
  return Math.round(turnStart + step * (block.index + 1));
}

function timelineSeconds(values: number[], baseTimestampMs: number): number[] {
  let last = 0;
  return values.map((timestamp) => {
    const seconds = Math.max(0, Math.round((timestamp - baseTimestampMs) / 1000));
    last = Math.max(last, seconds);
    return last;
  });
}

const PULSE_BUCKET_COUNT = 30;
const PULSE_BUCKET_MS = 60_000;

/**
 * Bin event wall-clock times into a trailing activity histogram.
 *
 * Contract: {@link PULSE_BUCKET_COUNT} buckets × {@link PULSE_BUCKET_MS}ms
 * ending at `nowMs`; each count is the number of timestamps that fall in that
 * bucket's `[start, end)` half-open interval. Timestamps outside the window
 * (older than the first bucket, or at/after `nowMs`) are ignored. Returns
 * `undefined` when no timestamp is finite / in-window — callers should hide the
 * chart rather than render an empty one.
 */
export function buildObservePulse(
  timestamps: number[],
  nowMs: number,
): ObservePulse | undefined {
  if (!Number.isFinite(nowMs)) return undefined;
  const endMs = Math.floor(nowMs);
  const windowMs = PULSE_BUCKET_COUNT * PULSE_BUCKET_MS;
  const startMs = endMs - windowMs;
  const counts = new Array<number>(PULSE_BUCKET_COUNT).fill(0);
  let placed = 0;
  for (const raw of timestamps) {
    if (!Number.isFinite(raw)) continue;
    if (raw < startMs || raw >= endMs) continue;
    const index = Math.floor((raw - startMs) / PULSE_BUCKET_MS);
    if (index < 0 || index >= PULSE_BUCKET_COUNT) continue;
    counts[index] += 1;
    placed += 1;
  }
  if (placed === 0) return undefined;
  return { bucketMs: PULSE_BUCKET_MS, endMs, counts };
}

function contextUsageRatio(usage: ObserveUsageMeta | undefined): number | null {
  const used = usage?.contextInputTokens;
  const total = usage?.contextWindowTokens;
  if (
    typeof used !== "number"
    || typeof total !== "number"
    || !Number.isFinite(used)
    || !Number.isFinite(total)
    || total <= 0
  ) {
    return null;
  }
  return Math.max(0, Math.min(1, used / total));
}

function observedContextUsage(eventCount: number, usage: ObserveUsageMeta | undefined): number[] {
  if (eventCount <= 0) {
    return [];
  }
  const length = Math.max(2, Math.min(eventCount, 24));
  const current = contextUsageRatio(usage);
  if (current !== null) {
    const start = current <= 0.02 ? current : Math.max(0.01, current * 0.35);
    return Array.from({ length }, (_, index) => {
      const progress = length <= 1 ? 1 : index / (length - 1);
      return start + (current - start) * progress;
    });
  }
  return Array.from({ length }, (_, index) => {
    const progress = length <= 1 ? 1 : index / (length - 1);
    return Math.min(0.92, 0.08 + progress * 0.66);
  });
}

export function buildObserveDataFromSnapshot(
  snapshot: SessionState,
  timedEvents: TimestampedPairingEvent[] = [],
  live = false,
): ObserveData {
  const timing = buildTimingLookup(snapshot, timedEvents);
  const files = new Map<string, ObserveFile>();
  const eventDrafts: Array<{
    timestampMs: number;
    block?: Block;
    build: (t: number) => ObserveEvent;
  }> = [
    {
      timestampMs: timing.bootTimestampMs,
      build: (t) => ({
      id: `${snapshot.session.id}:boot`,
      t,
      kind: "boot",
      text: `Session started · ${snapshot.session.model ?? snapshot.session.adapterType}`,
      detail: [
        snapshot.session.cwd ? `workspace: ${snapshot.session.cwd}` : null,
        `turns: ${snapshot.turns.length}`,
        `status: ${snapshot.session.status}`,
      ].filter(Boolean).join(" · "),
      }),
    },
  ];

  for (const turn of snapshot.turns) {
    const turnBlockCount = turn.blocks.length;
    for (const blockState of turn.blocks) {
      const { block } = blockState;
      const timestampMs = blockTimestampMs(turn.id, block, turnBlockCount, timing);
      eventDrafts.push({
        timestampMs,
        block,
        build: (t) => {
        switch (block.type) {
          case "reasoning":
            return {
              id: block.id,
              t,
              kind: "think",
              text: block.text.trim(),
              live: live && snapshot.currentTurnId === turn.id && blockState.status === "streaming",
            };
          case "text":
            return {
              id: block.id,
              t,
              kind: "message",
              text: block.text.trim(),
              to: "human",
            };
          case "question": {
            const answeredAt = timing.questionAnsweredAtMs.get(block.id);
            return {
              id: block.id,
              t,
              kind: "ask",
              text: block.question.trim(),
              to: "human",
              answer: block.answer?.join(", "),
              answerT: answeredAt
                ? Math.max(t, Math.round((answeredAt - timing.baseTimestampMs) / 1000))
                : undefined,
            };
          }
          case "error":
            return {
              id: block.id,
              t,
              kind: "system",
              text: block.message,
              detail: block.code,
            };
          case "file":
            return {
              id: block.id,
              t,
              kind: "note",
              text: block.name ? `Generated file ${block.name}` : "Generated file artifact",
            };
          case "action": {
            if (block.action.kind === "command") {
              return {
                id: block.id,
                t,
                kind: "tool",
                text: "",
                tool: "bash",
                arg: block.action.command,
                stream: summarizeCommandOutput(block.action.output),
              };
            }
            if (block.action.kind === "file_change") {
              const diffBody = block.action.diff?.trim() || block.action.output.trim();
              const diff = diffBody
                ? {
                    ...countDiffStats(diffBody),
                    preview: truncatePreview(diffBody),
                  }
                : undefined;
              return {
                id: block.id,
                t,
                kind: "tool",
                text: "",
                tool: block.action.path ? "edit" : "write",
                arg: block.action.path,
                ...(diff ? { diff } : {}),
              };
            }
            if (block.action.kind === "subagent") {
              return {
                id: block.id,
                t,
                kind: "tool",
                text: "",
                tool: "agent",
                arg: block.action.agentName ?? block.action.agentId,
                stream: summarizeCommandOutput(block.action.output),
              };
            }

            return {
              id: block.id,
              t,
              kind: "tool",
              text: "",
              tool: normalizeToolName(block.action.toolName),
              arg: toolArgSummary(block.action.input),
              stream: summarizeCommandOutput(block.action.output),
            };
          }
        }
        },
      });
    }
  }

  const seconds = timelineSeconds(
    eventDrafts.map((draft) => draft.timestampMs),
    timing.baseTimestampMs,
  );
  const builtEntries = eventDrafts
    .map((draft, index) => ({
      draft,
      event: {
        ...draft.build(seconds[index] ?? 0),
        at: draft.timestampMs,
      },
    }))
    .filter(({ event }) => event.text.length > 0 || event.kind === "tool" || event.kind === "boot");
  const events = builtEntries.map((entry) => entry.event);

  for (const { draft, event } of builtEntries) {
    if (draft.block) {
      detectFileTouches(draft.block, event.t, files);
    }
  }

  const pulse = buildObservePulse(
    events
      .map((event) => event.at)
      .filter((at): at is number => typeof at === "number" && Number.isFinite(at)),
    Date.now(),
  );

  const metadata = buildObserveMetadata(snapshot, timing.baseTimestampMs);

  return {
    events,
    files: [...files.values()].sort((left, right) => right.lastT - left.lastT || left.path.localeCompare(right.path)),
    contextUsage: observedContextUsage(events.length, metadata?.usage),
    ...(pulse ? { pulse } : {}),
    live,
    metadata,
  };
}

function unavailableObserveData(agent: WebAgent): ObserveData {
  return {
    events: [
      {
        id: `${agent.id}:unavailable`,
        t: 0,
        kind: "system",
        text: "No session trace is available for this agent yet.",
        detail: agent.harness
          ? `${agent.harness} · waiting for a live session or a readable history file`
          : "waiting for a live session or a readable history file",
      },
    ],
    files: [],
    contextUsage: [],
    live: false,
  };
}

function isLiveSessionSnapshot(snapshot: SessionState | null | undefined): boolean {
  return Boolean(
    snapshot
    && (
      snapshot.currentTurnId
      || snapshot.session.status === "active"
      || snapshot.turns.some((turn) => (
        turn.status === "streaming"
        || turn.blocks.some((block) => block.status === "streaming")
      ))
    ),
  );
}

type AgentObserveOptions = {
  sessionId?: string | null;
};

const ACTIVE_FLIGHT_STATES = new Set(["queued", "waking", "running", "waiting"]);
const HISTORY_ENDPOINT_START_TOLERANCE_MS = 10_000;

type ObservedChildIdentity = {
  agentIds: string[];
  sessionAliases: string[];
};

function observedChildIdentity(
  broker: ObserveBrokerContext,
  requesterAgentId: string,
  data: ObserveData,
): ObservedChildIdentity | null {
  if (!broker) return null;
  const sessionStart = data.metadata?.session?.sessionStart;
  const observedCwd = normalizedFilesystemPath(data.metadata?.session?.cwd);
  const observedAdapter = historyAdapterAlias(data.metadata?.session?.adapterType);
  if (!sessionStart || !observedCwd || !observedAdapter) return null;

  const matches = new Map<string, { agentIds: Set<string>; sessionAliases: Set<string> }>();
  for (const flight of Object.values(broker.snapshot.flights ?? {})) {
    const invocation = broker.snapshot.invocations?.[flight.invocationId];
    if (!invocation || invocation.requesterId !== requesterAgentId) continue;
    for (const trace of flightSessionTrace(flight)) {
      const endpoint = trace.endpointId ? broker.snapshot.endpoints?.[trace.endpointId] : null;
      if (!endpoint || endpoint.agentId !== flight.targetAgentId) continue;
      const endpointCwd = normalizedFilesystemPath(endpoint.cwd ?? endpoint.projectRoot);
      const endpointAdapter = historyAdapterForEndpoint(endpoint);
      const startedAt = epochMs(endpointMetadataRecord(endpoint).startedAt);
      if (
        endpointCwd !== observedCwd
        || endpointAdapter !== observedAdapter
        || startedAt === null
        || Math.abs(startedAt - sessionStart) > HISTORY_ENDPOINT_START_TOLERANCE_MS
      ) {
        continue;
      }
      const sessionKey = normalizedSessionAlias(trace.sessionId);
      if (!sessionKey) continue;
      const match = matches.get(sessionKey) ?? {
        agentIds: new Set<string>(),
        sessionAliases: new Set<string>(),
      };
      match.agentIds.add(endpoint.agentId);
      match.sessionAliases.add(sessionKey);
      for (const alias of endpointSessionAliases(endpoint)) match.sessionAliases.add(alias);
      matches.set(sessionKey, match);
    }
  }
  if (matches.size !== 1) return null;
  const match = [...matches.values()][0];
  return match ? {
    agentIds: [...match.agentIds],
    sessionAliases: [...match.sessionAliases],
  } : null;
}

function observeInitiatingAsk(
  broker: ObserveBrokerContext,
  agentId: string,
  sessionAliases: readonly string[],
  linkedTargetAgentIds: readonly string[] = [],
): ObserveInitiatingAsk | null {
  if (!broker) return null;

  const observedAliases = new Set(
    sessionAliases
      .map((value) => normalizedSessionAlias(value))
      .filter((value): value is string => Boolean(value)),
  );

  const linkedTargets = new Set(linkedTargetAgentIds);
  const candidates = Object.values(broker.snapshot.flights ?? {})
    .map((flight) => ({
      flight,
      invocation: broker.snapshot.invocations?.[flight.invocationId],
    }))
    .filter(({ invocation }) => Boolean(invocation));

  const exact = observedAliases.size > 0
    ? candidates.filter(({ flight, invocation }) => (
        flightSessionTrace(flight).some((entry) => {
          const sessionId = normalizedSessionAlias(entry.sessionId);
          return Boolean(sessionId && observedAliases.has(sessionId));
        })
        || (() => {
          const targetSessionId = normalizedSessionAlias(invocation?.execution?.targetSessionId);
          return Boolean(targetSessionId && observedAliases.has(targetSessionId));
        })()
      ))
    : [];
  const active = candidates.filter(({ flight, invocation }) => (
    ACTIVE_FLIGHT_STATES.has(flight.state)
    && (
      flight.targetAgentId === agentId
      || (linkedTargets.has(flight.targetAgentId) && invocation?.requesterId === agentId)
    )
  ));
  const eligible = exact.length > 0 ? exact : observedAliases.size === 0 && active.length === 1 ? active : [];
  const selected = eligible.sort((left, right) => exact.length > 0
    ? (left.flight.startedAt ?? left.invocation?.createdAt ?? 0)
      - (right.flight.startedAt ?? right.invocation?.createdAt ?? 0)
    : (right.flight.startedAt ?? right.invocation?.createdAt ?? 0)
      - (left.flight.startedAt ?? left.invocation?.createdAt ?? 0))[0];
  const invocation = selected?.invocation;
  if (!selected || !invocation?.task.trim()) return null;

  const requester = broker.snapshot.actors?.[invocation.requesterId]
    ?? broker.snapshot.agents?.[invocation.requesterId];
  const message = invocation.messageId
    ? broker.snapshot.messages?.[invocation.messageId]
    : null;
  return {
    task: invocation.task.trim(),
    requesterId: invocation.requesterId,
    requesterName: requester?.displayName?.trim() || invocation.requesterId,
    requestedAt: message?.createdAt ?? invocation.createdAt,
    invocationId: invocation.id,
    flightId: selected.flight.id,
    conversationId: invocation.conversationId ?? message?.conversationId ?? null,
    messageId: invocation.messageId ?? null,
  };
}

async function resolveSnapshotSource(
  agent: WebAgent,
  broker: ObserveBrokerContext,
  options: AgentObserveOptions = {},
): Promise<SnapshotSource> {
  const endpoint = broker ? selectPreferredAgentEndpoint(broker.snapshot, agent.id, {
    harness: agent.harness,
    transport: agent.transport,
    sessionId: options.sessionId ?? agent.harnessSessionId,
    cwd: agent.cwd,
    projectRoot: agent.projectRoot,
  }) : null;
  const liveSnapshot = await readLiveSnapshot(agent, endpoint);
  const live = isLiveSessionSnapshot(liveSnapshot);
  const endpointAliases = endpoint ? [...endpointSessionAliases(endpoint)] : [];
  const sourceAliases = (...values: Array<string | null | undefined>): string[] => [...new Set([
    ...endpointAliases,
    ...values
      .map((value) => normalizedSessionAlias(value))
      .filter((value): value is string => Boolean(value)),
  ])];

  let historyCandidate = resolveHistoryCandidate(agent, liveSnapshot, endpoint);
  let historySnapshot = readHistorySnapshot(historyCandidate);
  if (!historySnapshot) {
    const discoveredCandidate = await resolveDiscoveredHistoryCandidate(agent, liveSnapshot, endpoint);
    const discoveredSnapshot = readHistorySnapshot(discoveredCandidate);
    if (discoveredSnapshot) {
      historyCandidate = discoveredCandidate;
      historySnapshot = discoveredSnapshot;
    }
  }
  if (historySnapshot) {
    const historySessionId = historySnapshotSessionId(historySnapshot);
    return {
      source: "history",
      historyPath: historySnapshot.historyPath,
      snapshot: historySnapshot.snapshot,
      timedEvents: historySnapshot.timedEvents,
      live: live || isLiveSessionSnapshot(historySnapshot.snapshot),
      sessionId: liveSnapshot?.session.id ?? historySessionId ?? endpoint?.sessionId ?? null,
      sessionAliases: sourceAliases(liveSnapshot?.session.id, historySessionId),
    };
  }

  if (liveSnapshot) {
    return {
      source: "live",
      historyPath: historyCandidate?.path ?? null,
      snapshot: liveSnapshot,
      timedEvents: [],
      live,
      sessionId: liveSnapshot.session.id,
      sessionAliases: sourceAliases(liveSnapshot.session.id),
    };
  }

  let agentHistoryCandidate = resolveHistoryCandidate(agent, null, endpoint);
  let agentHistorySnapshot = readHistorySnapshot(agentHistoryCandidate);
  if (!agentHistorySnapshot) {
    const discoveredCandidate = await resolveDiscoveredHistoryCandidate(agent, null, endpoint);
    const discoveredSnapshot = readHistorySnapshot(discoveredCandidate);
    if (discoveredSnapshot) {
      agentHistoryCandidate = discoveredCandidate;
      agentHistorySnapshot = discoveredSnapshot;
    }
  }
  if (agentHistorySnapshot) {
    const historySessionId = historySnapshotSessionId(agentHistorySnapshot);
    return {
      source: "history",
      historyPath: agentHistorySnapshot.historyPath,
      snapshot: agentHistorySnapshot.snapshot,
      timedEvents: agentHistorySnapshot.timedEvents,
      live: false,
      sessionId: historySessionId ?? endpoint?.sessionId ?? null,
      sessionAliases: sourceAliases(historySessionId),
    };
  }

  return {
    source: "unavailable",
    historyPath: null,
    live: false,
    sessionId: null,
    sessionAliases: sourceAliases(),
  };
}

async function buildAgentObservePayload(
  agent: WebAgent,
  broker: ObserveBrokerContext,
  options: AgentObserveOptions = {},
): Promise<AgentObservePayload> {
  const source = await resolveSnapshotSource(agent, broker, options);
  if (source.source === "unavailable") {
    return {
      agentId: agent.id,
      source: "unavailable",
      fidelity: "synthetic",
      historyPath: null,
      sessionId: null,
      updatedAt: Date.now(),
      initiatingAsk: observeInitiatingAsk(broker, agent.id, source.sessionAliases),
      data: unavailableObserveData(agent),
    };
  }

  const fidelity = source.timedEvents.length > 0 ? "timestamped" : "synthetic";
  const data = buildObserveDataFromSnapshot(source.snapshot, source.timedEvents, source.live);
  const childIdentity = source.source === "history"
    ? observedChildIdentity(broker, agent.id, data)
    : null;
  const provenanceAliases = childIdentity
    ? [...new Set([...source.sessionAliases, ...childIdentity.sessionAliases])]
    : source.sessionAliases;
  return {
    agentId: agent.id,
    source: source.source,
    fidelity,
    historyPath: source.historyPath,
    sessionId: source.sessionId,
    updatedAt: Date.now(),
    initiatingAsk: observeInitiatingAsk(
      broker,
      agent.id,
      provenanceAliases,
      childIdentity?.agentIds ?? [],
    ),
    data,
  };
}

async function loadAgentObservePayloadsInternal(
  agentIds?: string[],
  options: AgentObserveOptions = {},
): Promise<AgentObservePayload[]> {
  const agents = queryAgents(200);
  const filteredAgents = agentIds && agentIds.length > 0
    ? agents.filter((agent) => agentIds.includes(agent.id))
    : agents;
  if (filteredAgents.length === 0) {
    return [];
  }

  const broker = await loadScoutBrokerContext();
  return await Promise.all(filteredAgents.map((agent) => buildAgentObservePayload(agent, broker, options)));
}

function summarizeAgentObservePayload(
  payload: AgentObservePayload,
): AgentObservePayload {
  return {
    ...payload,
    data: {
      ...payload.data,
      events: payload.data.events.slice(-OBSERVE_SUMMARY_TAIL_SIZE),
      files: [],
    },
  };
}

export async function loadAgentObserveSummaries(
  agentIds?: string[],
): Promise<AgentObservePayload[]> {
  const payloads = await loadAgentObservePayloadsInternal(agentIds);
  return payloads.map(summarizeAgentObservePayload);
}

export async function loadAgentObservePayload(
  agentId: string,
  options: AgentObserveOptions = {},
): Promise<AgentObservePayload | null> {
  const payloads = await loadAgentObservePayloadsInternal([agentId], options);
  return payloads[0] ?? null;
}

function endpointOpaqueRefAliases(endpoint: AgentEndpoint): string[] {
  const metadata = endpointMetadataRecord(endpoint);
  return uniqueSessionRefs([
    endpoint.agentId,
    endpoint.sessionId,
    metadataString(metadata, "externalSessionId"),
    metadataString(metadata, "threadId"),
    metadataString(metadata, "nativeSessionId"),
    metadataString(metadata, "pairingSessionId"),
    metadataString(metadata, "sessionId"),
    metadataString(metadata, "runtimeSessionId"),
    metadataString(metadata, "runtimeInstanceId"),
    metadataString(metadata, "tmuxSession"),
  ]);
}

function endpointMatchesBrokerPresentationRef(
  endpoint: AgentEndpoint,
  normalizedRef: string,
): boolean {
  if (normalizeSessionRefId(endpoint.agentId) === normalizedRef) {
    return true;
  }
  const handle = normalizeSessionRefId(metadataString(endpointMetadataRecord(endpoint), "handle"));
  return Boolean(handle && handle.toLowerCase() === normalizedRef.toLowerCase());
}

/** All broker endpoints that claim a session ref, before presentation ranking. */
function brokerSessionRefMatchingEndpoints(
  snapshot: { endpoints?: Record<string, AgentEndpoint> },
  normalizedRef: string,
  harness: string | null = null,
): AgentEndpoint[] {
  const targetRef = normalizeSessionRefId(normalizedRef);
  if (!targetRef) return [];
  const matches = Object.values(snapshot.endpoints ?? {})
    .filter((endpoint) => sessionHarnessMatches(harness, endpoint.harness))
    .filter((endpoint) => (
      endpointMatchesBrokerPresentationRef(endpoint, targetRef)
      || endpointOpaqueRefAliases(endpoint).includes(targetRef)
    ));
  return [...new Map(matches.map((endpoint) => [endpoint.id, endpoint])).values()];
}

function isEndpointPresentationRef(endpoint: AgentEndpoint, value: string): boolean {
  const normalized = normalizeSessionRefId(value);
  if (!normalized) {
    return false;
  }
  if (normalized === normalizeSessionRefId(endpoint.agentId)) {
    return true;
  }
  const handle = normalizeSessionRefId(metadataString(endpointMetadataRecord(endpoint), "handle"));
  return Boolean(handle && handle.toLowerCase() === normalized.toLowerCase());
}

const AMBIGUOUS_BROKER_SESSION_REF = Symbol("ambiguous-broker-session-ref");

function selectBrokerSessionRefEndpoint(
  snapshot: { endpoints?: Record<string, AgentEndpoint> },
  normalizedRef: string,
  harness: string | null = null,
): AgentEndpoint | null | typeof AMBIGUOUS_BROKER_SESSION_REF {
  const targetRef = normalizeSessionRefId(normalizedRef);
  if (!targetRef) {
    return null;
  }
  const endpoints = Object.values(snapshot.endpoints ?? {})
    .filter((endpoint) => sessionHarnessMatches(harness, endpoint.harness));
  const actorCandidates = endpoints.filter((endpoint) => (
    normalizeSessionRefId(endpoint.agentId) === targetRef
  ));
  const handleCandidates = endpoints.filter((endpoint) => {
    const handle = normalizeSessionRefId(metadataString(endpointMetadataRecord(endpoint), "handle"));
    return Boolean(handle && handle.toLowerCase() === targetRef.toLowerCase());
  });
  // Actor ids are canonical presentation addresses. A different actor may
  // legitimately have a colliding friendly handle, but it must never outrank
  // the exact actor id. Handles are usable only when they identify one owner.
  const presentationCandidates = actorCandidates.length > 0
    ? actorCandidates
    : handleCandidates;
  if (actorCandidates.length === 0 && handleCandidates.length > 0) {
    const handleOwners = new Set(handleCandidates.map((endpoint) => endpoint.agentId));
    if (handleOwners.size > 1) return AMBIGUOUS_BROKER_SESSION_REF;
  }
  const candidates = presentationCandidates.length > 0
    ? presentationCandidates
    : endpoints.filter((endpoint) => endpointOpaqueRefAliases(endpoint).includes(targetRef));
  if (candidates.length === 0) {
    return null;
  }

  if (presentationCandidates.length === 0) {
    const ownerHarnessScopes = new Set(candidates.map((endpoint) => (
      `${endpoint.agentId}\u0000${endpoint.harness ?? ""}`
    )));
    if (ownerHarnessScopes.size > 1) {
      // Provider ids are harness-owned opaque values, not globally unique Scout
      // addresses. Without an actor/handle presentation ref, selecting one of
      // several owners would attach the trace and writable agent arbitrarily.
      return AMBIGUOUS_BROKER_SESSION_REF;
    }
  }

  // The canonical selector ranks endpoints for one owner. Session refs can
  // name the owner itself and therefore match several historical endpoints,
  // so compare immutable copies under one temporary owner and return the
  // original winner. No cwd/project preference participates in this choice.
  const selectionOwner = "__session_ref_endpoint_selection__";
  const selectionEndpoints = Object.fromEntries(candidates.map((endpoint) => [
    endpoint.id,
    { ...endpoint, agentId: selectionOwner },
  ]));
  const selected = selectPreferredAgentEndpoint(
    { endpoints: selectionEndpoints },
    selectionOwner,
    { sessionId: normalizedRef },
  );
  return selected
    ? candidates.find((candidate) => candidate.id === selected.id) ?? null
    : null;
}

function uniqueSessionRefs(values: unknown[]): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const ref = normalizeSessionRefId(value);
    if (!ref || seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}

function endpointProviderSessionRefs(
  refId: string,
  endpoint: AgentEndpoint,
  snapshot: SessionState | null,
): string[] {
  const endpointMetadata = endpointMetadataRecord(endpoint);
  const providerMetadata = snapshot ? snapshotProviderMeta(snapshot) : {};
  const normalizedInput = normalizeSessionRefId(refId);
  const inputIsPresentationRef = Boolean(
    normalizedInput && isEndpointPresentationRef(endpoint, normalizedInput),
  );
  return uniqueSessionRefs([
    providerMetadata.externalSessionId,
    providerMetadata.threadId,
    providerMetadata.transportSessionId,
    providerMetadata.nativeSessionId,
    endpointMetadata.externalSessionId,
    endpointMetadata.threadId,
    endpointMetadata.nativeSessionId,
    endpointMetadata.pairingSessionId,
    endpointMetadata.runtimeSessionId,
    endpointMetadata.runtimeInstanceId,
    snapshot?.session.id,
    endpoint.sessionId,
    !inputIsPresentationRef ? normalizedInput : null,
  ]).filter((ref) => !isEndpointPresentationRef(endpoint, ref));
}

function concreteProviderSessionId(
  endpoint: AgentEndpoint,
  snapshot: SessionState | null,
): string | null {
  const endpointMetadata = endpointMetadataRecord(endpoint);
  const providerMetadata = snapshot ? snapshotProviderMeta(snapshot) : {};
  const concreteRef = uniqueSessionRefs([
    providerMetadata.externalSessionId,
    providerMetadata.threadId,
    providerMetadata.transportSessionId,
    providerMetadata.nativeSessionId,
    endpointMetadata.externalSessionId,
    endpointMetadata.threadId,
    endpointMetadata.nativeSessionId,
    endpointMetadata.pairingSessionId,
    snapshot?.session.id,
  ]).find((ref) => !isEndpointPresentationRef(endpoint, ref));
  return concreteRef ?? endpoint.sessionId?.trim() ?? null;
}

type EndpointHistoryCandidate = {
  path: string;
  adapterType: "claude-code" | "codex" | "pi";
};

function exactEndpointHistoryCandidates(
  endpoint: AgentEndpoint,
  snapshot: SessionState | null,
  providerRefs: string[],
): EndpointHistoryCandidate[] {
  const adapterType = historyAdapterAlias(snapshot?.session.adapterType)
    ?? historyAdapterForEndpoint(endpoint);
  if (!adapterType) {
    return [];
  }
  const providerMetadata = snapshot ? snapshotProviderMeta(snapshot) : {};
  const endpointMetadata = endpointMetadataRecord(endpoint);
  const paths = new Set<string>();
  for (const path of [
    firstString(providerMetadata.resumeSessionPath),
    firstString(providerMetadata.threadPath),
    firstString(endpointMetadata.threadPath),
  ]) {
    if (path) {
      paths.add(path);
    }
  }

  // Claude stores exact session files below a cwd-derived project directory.
  // The cwd only locates that directory; allowMostRecentFallback=false keeps
  // this an exact provider-id lookup rather than a same-workspace guess.
  if (adapterType === "claude-code") {
    const cwd = firstString(snapshot?.session.cwd, endpoint.cwd, endpoint.projectRoot);
    for (const providerRef of providerRefs) {
      const path = resolveClaudeHistoryPath(cwd, providerRef, {
        allowMostRecentFallback: false,
      });
      if (path) {
        paths.add(path);
      }
    }
  }

  return [...paths].map((path) => ({ path, adapterType }));
}

async function readExactEndpointHistory(
  endpoint: AgentEndpoint,
  snapshot: SessionState | null,
  providerRefs: string[],
): Promise<HistorySnapshotResult | null> {
  const adapterType = historyAdapterAlias(snapshot?.session.adapterType)
    ?? historyAdapterForEndpoint(endpoint);
  if (!adapterType) {
    return null;
  }
  for (const candidate of exactEndpointHistoryCandidates(endpoint, snapshot, providerRefs)) {
    const history = readHistorySnapshot(candidate);
    if (history) {
      return history;
    }
  }
  for (const providerRef of providerRefs) {
    const normalizedProviderRef = normalizeSessionRefId(providerRef);
    if (!normalizedProviderRef) {
      continue;
    }
    const tailLookup = await findTailSessionRefLookupEntry(normalizedProviderRef, endpoint.harness);
    const lookup = tailLookup === AMBIGUOUS_TAIL_SESSION_REF
      ? null
      : tailLookup ?? sessionRefLookup().get(normalizedProviderRef) ?? null;
    if (!lookup || lookup.adapterType !== adapterType) {
      continue;
    }
    const history = readHistorySnapshot({
      path: lookup.historyPath,
      adapterType: lookup.adapterType,
    });
    if (history) {
      return history;
    }
  }
  return null;
}

async function readExactEndpointTail(
  endpoint: AgentEndpoint,
  providerRefs: string[],
): Promise<Awaited<ReturnType<typeof readTailEventsForSession>>> {
  const endpointHarness = canonicalSessionHarness(endpoint.harness);
  const expectedTailSource = endpointHarness === "grok-acp" ? "grok" : endpointHarness;
  if (!expectedTailSource || !["grok", "kimi", "opencode", "cursor", "antigravity"].includes(expectedTailSource)) {
    return null;
  }

  const readFromDiscovery = async (discovery: DiscoverySnapshot) => {
    for (const providerRef of providerRefs) {
      const normalizedProviderRef = normalizeSessionRefId(providerRef);
      if (!normalizedProviderRef) continue;
      const transcripts = tailSessionRefTranscripts(
        discovery,
        normalizedProviderRef,
        expectedTailSource,
      );
      if (transcripts.length === 0) continue;
      const tail = await readTailEventsForSession(providerRef, {
        discovery: { ...discovery, transcripts },
      }).catch(() => null);
      if (!tail) continue;
      const actualTailSource = canonicalSessionHarness(tail.transcript.source)
        ?? tail.transcript.source.trim().toLowerCase();
      if (actualTailSource === expectedTailSource) return tail;
    }
    return null;
  };

  const discovery = await getTailDiscovery().catch(() => null);
  if (discovery) {
    const tail = await readFromDiscovery(discovery);
    if (tail) return tail;
  }

  // A cached discovery can predate a newly attached native transcript. Refresh
  // the full inventory, but preserve the same endpoint-source scope on retry.
  const refreshed = await refreshTailDiscovery("deep").catch(() => null);
  return refreshed ? readFromDiscovery(refreshed) : null;
}

function snapshotHasTraceActivity(snapshot: SessionState | null): snapshot is SessionState {
  return Boolean(snapshot?.turns.some((turn) => turn.blocks.length > 0));
}

const TERMINAL_BROKER_FLIGHT_STATES = new Set<FlightRecord["state"]>([
  "completed",
  "failed",
  "cancelled",
]);

function brokerSessionObserveFlight(input: {
  snapshot: NonNullable<ObserveBrokerContext>["snapshot"];
  endpoint: AgentEndpoint;
  refId: string;
}): FlightRecord | null {
  const aliases = new Set(
    [...endpointSessionAliases(input.endpoint), normalizedSessionAlias(input.refId)]
      .filter((alias): alias is string => Boolean(alias)),
  );
  const allowAgentMatch = input.snapshot.actors?.[input.endpoint.agentId]?.kind === "session";
  const matched = Object.values(input.snapshot.flights ?? {}).filter((flight) => {
    const traceMatches = flightSessionTrace(flight).some((entry) => {
      if (entry.endpointId === input.endpoint.id) return true;
      const sessionId = normalizedSessionAlias(entry.sessionId);
      return Boolean(sessionId && aliases.has(sessionId));
    });
    if (traceMatches) return true;
    const invocation = input.snapshot.invocations?.[flight.invocationId];
    const invocationMatches = [
      invocation?.execution?.targetSessionId,
      invocation?.executionResolution?.sessionId,
      metadataString(invocation?.metadata, "targetSessionId"),
      metadataString(invocation?.metadata, "sessionId"),
    ].some((value) => {
      const sessionId = normalizedSessionAlias(value);
      return Boolean(sessionId && aliases.has(sessionId));
    });
    if (invocationMatches) return true;
    return allowAgentMatch && flight.targetAgentId === input.endpoint.agentId;
  });
  if (matched.length === 0) return null;
  return [...matched].sort((left, right) => {
    const leftCreatedAt = epochMs(input.snapshot.invocations?.[left.invocationId]?.createdAt) ?? 0;
    const rightCreatedAt = epochMs(input.snapshot.invocations?.[right.invocationId]?.createdAt) ?? 0;
    return rightCreatedAt - leftCreatedAt
      || (epochMs(right.startedAt) ?? epochMs(right.completedAt) ?? 0)
        - (epochMs(left.startedAt) ?? epochMs(left.completedAt) ?? 0)
      || (epochMs(right.completedAt) ?? 0) - (epochMs(left.completedAt) ?? 0)
      || right.id.localeCompare(left.id);
  })[0] ?? null;
}

function brokerSessionObserveData(input: {
  refId: string;
  endpoint: AgentEndpoint;
  actorName?: string | null;
  flight?: FlightRecord | null;
}): ObserveData {
  const metadata = endpointMetadataRecord(input.endpoint);
  const flight = input.flight ?? null;
  const startedAt = Number(metadata.startedAt);
  const flightStartedAt = epochMs(flight?.startedAt);
  const sessionStart = Number.isFinite(startedAt) && startedAt > 0
    ? startedAt
    : flightStartedAt && flightStartedAt > 0
      ? flightStartedAt
      : Date.now();
  const hasRecordedStart = (Number.isFinite(startedAt) && startedAt > 0)
    || Boolean(flightStartedAt && flightStartedAt > 0);
  const handle = metadataString(metadata, "handle");
  const displayName = input.actorName?.trim() || metadataString(metadata, "displayName") || handle || input.refId;
  const externalSessionId = metadataString(metadata, "externalSessionId");
  const pending = metadata.pendingExternalSession === true && !externalSessionId;
  const flightTerminal = Boolean(flight && TERMINAL_BROKER_FLIGHT_STATES.has(flight.state));
  const flightOutcomeText = flightTerminal
    ? flight?.state === "failed"
      ? "Invocation failed; no harness turns were captured."
      : flight?.state === "cancelled"
        ? "Invocation cancelled; no harness turns were captured."
        : "Invocation completed; no harness turns were captured."
    : null;
  const flightDetail = flight?.error?.trim() || flight?.summary?.trim() || null;
  const reachable = !flightTerminal && metadata.staleLocalRegistration !== true && (
    input.endpoint.state === "attaching"
      || input.endpoint.state === "waking"
      || input.endpoint.state === "idle"
      || input.endpoint.state === "active"
      || input.endpoint.state === "waiting"
      || input.endpoint.state === "working"
  );
  const handoffText = flightOutcomeText ?? (!reachable
    ? "Harness session is not currently reachable; no trace events were captured."
    : pending
      ? "Waiting for the harness to attach and emit its first turn."
      : externalSessionId
        ? "Harness session attached; waiting for trace events."
        : "Broker endpoint is reachable; waiting for the harness session to attach.");
  const handoffAt = epochMs(flight?.completedAt) ?? Date.now();
  const handoffT = hasRecordedStart
    ? Math.max(0, (handoffAt - sessionStart) / 1000)
    : 1;
  return {
    events: [
      {
        id: `${input.refId}:registered`,
        t: 0,
        at: sessionStart,
        kind: "boot",
        text: `Session registered - ${displayName}`,
        detail: [
          input.endpoint.harness,
          metadataString(metadata, "model"),
          input.endpoint.cwd,
        ].filter(Boolean).join(" - "),
      },
      {
        id: `${input.refId}:handoff`,
        t: handoffT,
        at: handoffAt,
        kind: "system",
        text: handoffText,
        detail: [
          flightDetail,
          externalSessionId ? `external session: ${externalSessionId}` : null,
          `endpoint state: ${input.endpoint.state}`,
          metadata.staleLocalRegistration === true ? "registration is stale" : null,
        ].filter(Boolean).join(" · "),
      },
    ],
    files: [],
    contextUsage: [],
    live: reachable,
    metadata: {
      session: {
        adapterType: input.endpoint.harness,
        model: metadataString(metadata, "model"),
        cwd: input.endpoint.cwd ?? input.endpoint.projectRoot,
        sessionStart,
        externalSessionId,
        threadId: metadataString(metadata, "threadId"),
        source: "broker",
      },
    },
  };
}

async function loadBrokerSessionRefObservePayload(
  refId: string,
  harness: string | null = null,
  brokerContext?: ObserveBrokerContext | null,
): Promise<SessionRefObservePayload | null | typeof AMBIGUOUS_BROKER_SESSION_REF> {
  const normalizedRef = normalizeSessionRefId(refId);
  if (!normalizedRef) {
    return null;
  }
  const broker = brokerContext === undefined
    ? await loadScoutBrokerContext().catch(() => null)
    : brokerContext;
  if (!broker) {
    return null;
  }
  const endpoint = selectBrokerSessionRefEndpoint(broker.snapshot, normalizedRef, harness);
  if (endpoint === AMBIGUOUS_BROKER_SESSION_REF) {
    return AMBIGUOUS_BROKER_SESSION_REF;
  }
  if (!endpoint) {
    return null;
  }

  // A Scout session id is the stable handle for the work, while Claude/Codex
  // may write the actual turn stream under a harness-owned session id. Reuse
  // the agent observe path when the catalog already has this agent, but keep
  // cardless endpoints on the exact endpoint path below so cwd heuristics
  // cannot attach another session's transcript.
  const storedAgent = queryAgentById(endpoint.agentId);
  const actor = broker.snapshot.actors?.[endpoint.agentId];
  const endpointRoot = endpoint.projectRoot ?? endpoint.cwd ?? null;
  const withHost = (data: ObserveData): ObserveData => ({
    ...data,
    metadata: {
      ...data.metadata,
      session: {
        ...data.metadata?.session,
        nodeId: endpoint.nodeId,
        hostName: broker.snapshot.nodes?.[endpoint.nodeId]?.name ?? undefined,
      },
    },
  });
  if (storedAgent) {
    const agent: WebAgent = {
      ...storedAgent,
      // The broker endpoint is the authoritative runtime attachment. Never let
      // stale projected cwd/session fields prevent native history discovery.
      harness: endpoint.harness,
      state: endpoint.state,
      projectRoot: endpointRoot,
      cwd: endpoint.cwd ?? endpointRoot,
      transport: endpoint.transport,
      harnessSessionId: endpoint.sessionId?.trim() || normalizedRef,
      project: endpointRoot ? basename(endpointRoot) : storedAgent.project,
    };
    const observed = await buildAgentObservePayload(agent, broker, {
      sessionId: endpoint.sessionId?.trim() || normalizedRef,
    }).catch(() => null);
    if (observed && observed.source !== "unavailable") {
      return {
        kind: "agent",
        refId: normalizedRef,
        agentId: endpoint.agentId,
        source: observed.source,
        fidelity: observed.fidelity,
        historyPath: observed.historyPath,
        sessionId: observed.sessionId,
        updatedAt: observed.updatedAt,
        data: withHost(observed.data),
      };
    }
  }

  const metadata = endpointMetadataRecord(endpoint);
  const liveSnapshot = await readEndpointSessionSnapshot(endpoint).catch(() => null);
  const providerRefs = endpointProviderSessionRefs(normalizedRef, endpoint, liveSnapshot);
  const providerSessionId = concreteProviderSessionId(endpoint, liveSnapshot);
  const live = isLiveSessionSnapshot(liveSnapshot);

  const history = await readExactEndpointHistory(endpoint, liveSnapshot, providerRefs);
  if (history) {
    const historySessionId = historySnapshotSessionId(history);
    return {
      kind: "broker",
      refId: normalizedRef,
      agentId: endpoint.agentId,
      source: "history",
      fidelity: history.timedEvents.length > 0 ? "timestamped" : "synthetic",
      historyPath: history.historyPath,
      sessionId: historySessionId ?? providerSessionId,
      updatedAt: Date.now(),
      data: withHost(buildObserveDataFromSnapshot(
        history.snapshot,
        history.timedEvents,
        live || isLiveSessionSnapshot(history.snapshot),
      )),
    };
  }

  if (snapshotHasTraceActivity(liveSnapshot)) {
    return {
      kind: "broker",
      refId: normalizedRef,
      agentId: endpoint.agentId,
      source: "live",
      fidelity: "synthetic",
      historyPath: null,
      sessionId: providerSessionId,
      updatedAt: Date.now(),
      data: withHost(buildObserveDataFromSnapshot(liveSnapshot, [], live)),
    };
  }

  const nativeTail = await readExactEndpointTail(endpoint, providerRefs);
  if (nativeTail) {
    const sessionId = nativeTail.transcript.sessionId?.trim() || providerSessionId;
    const current = Date.now() - nativeTail.transcript.mtimeMs <= 5 * 60_000;
    return {
      kind: "broker",
      refId: normalizedRef,
      agentId: endpoint.agentId,
      source: "tail",
      fidelity: "synthetic",
      historyPath: nativeTail.transcript.transcriptPath,
      sessionId,
      updatedAt: Date.now(),
      data: withHost(buildObserveDataFromTail(nativeTail.transcript, nativeTail.events, current)),
    };
  }

  const concreteProviderObserved = Boolean(
    providerSessionId
    && !isEndpointPresentationRef(endpoint, providerSessionId),
  );
  const observedEndpoint = concreteProviderObserved && !metadataString(metadata, "externalSessionId")
    ? {
        ...endpoint,
        metadata: {
          ...metadata,
          externalSessionId: providerSessionId,
          pendingExternalSession: false,
          ...(endpoint.transport === "codex_app_server" ? { threadId: providerSessionId } : {}),
        },
      }
    : endpoint;
  return {
    kind: "broker",
    refId: normalizedRef,
    agentId: endpoint.agentId,
    source: "broker",
    fidelity: "synthetic",
    historyPath: null,
    sessionId: providerSessionId,
    updatedAt: Date.now(),
    data: withHost(brokerSessionObserveData({
      refId: normalizedRef,
      endpoint: observedEndpoint,
      actorName: actor?.displayName ?? null,
      flight: brokerSessionObserveFlight({
        snapshot: broker.snapshot,
        endpoint,
        refId: normalizedRef,
      }),
    })),
  };
}

export async function loadSessionRefObservePayload(
  refId: string,
): Promise<SessionRefObservePayload | null> {
  const parsedRef = parseSessionRouteRef(refId);
  const normalizedRef = parsedRef?.refId ?? null;
  const requestedHarness = parsedRef?.harness ?? null;
  if (!normalizedRef) {
    return null;
  }

  let [discovery, brokerContext] = await Promise.all([
    // The broker owns and continuously materializes Tail discovery. Reading
    // that compact inventory avoids launching a duplicate process/transcript
    // scan in the latency-sensitive web request.
    readScoutBrokerTailDiscovery().catch(() => null),
    loadScoutBrokerContext().catch(() => null),
  ]);
  let matchingTranscripts = discovery
    ? tailSessionRefTranscripts(discovery, normalizedRef, requestedHarness)
    : [];
  const discoveredHistoryEntry = bestTailSessionRefLookupEntry(matchingTranscripts, normalizedRef);
  // Do not walk every Claude project directory when the materialized Tail
  // inventory already names the exact transcript. The legacy scan remains a
  // bounded-age fallback for refs not yet represented in discovery.
  const cachedHistoryEntry = !discoveredHistoryEntry
    && matchingTranscripts.length === 0
    && (!requestedHarness || requestedHarness === "claude")
    ? sessionRefLookup().get(normalizedRef) ?? null
    : null;
  const matchingAgents = queryAgents(200).filter((agent) => (
    normalizeSessionRefId(agent.harnessSessionId) === normalizedRef
    && sessionHarnessMatches(requestedHarness, agent.harness)
  ));
  const matchingAgentOwners = new Set(matchingAgents.map((agent) => agent.id));
  if (matchingAgentOwners.size > 1) return null;
  const matchingBrokerEndpoints = brokerContext
    ? brokerSessionRefMatchingEndpoints(brokerContext.snapshot, normalizedRef, requestedHarness)
    : [];
  const brokerHasPresentationMatch = matchingBrokerEndpoints.some((endpoint) => (
    isEndpointPresentationRef(endpoint, normalizedRef)
  ));
  if (!brokerHasPresentationMatch) {
    const providerOwnerScopes = new Set([
      ...matchingAgents.map((agent) => (
        `${agent.id}\u0000${canonicalSessionHarness(agent.harness) ?? agent.harness?.trim().toLowerCase() ?? ""}`
      )),
      ...matchingBrokerEndpoints.map((endpoint) => (
        `${endpoint.agentId}\u0000${canonicalSessionHarness(endpoint.harness) ?? endpoint.harness?.trim().toLowerCase() ?? ""}`
      )),
    ]);
    if (providerOwnerScopes.size > 1) return null;
  }
  const brokerSelection = brokerContext
    ? selectBrokerSessionRefEndpoint(brokerContext.snapshot, normalizedRef, requestedHarness)
    : null;
  if (brokerSelection === AMBIGUOUS_BROKER_SESSION_REF) return null;
  const knownHarnesses = new Set<string>();
  for (const agent of matchingAgents) {
    const harness = canonicalSessionHarness(agent.harness);
    if (harness) knownHarnesses.add(harness);
  }
  for (const transcript of matchingTranscripts) {
    knownHarnesses.add(canonicalSessionHarness(transcript.source) ?? transcript.source.trim().toLowerCase());
  }
  for (const endpoint of matchingBrokerEndpoints) {
    const harness = canonicalSessionHarness(endpoint.harness);
    if (harness) knownHarnesses.add(harness);
  }
  if (cachedHistoryEntry) knownHarnesses.add("claude");
  if (!requestedHarness && knownHarnesses.size > 1) return null;
  // Broker actor ids and handles are presentation refs. They outrank an
  // unrelated database row whose opaque provider id happens to collide.
  const matchedAgent = brokerHasPresentationMatch ? undefined : matchingAgents[0];
  if (matchedAgent) {
    const payload = await loadAgentObservePayload(matchedAgent.id);
    if (payload) {
      return {
        kind: "agent",
        refId: normalizedRef,
        agentId: matchedAgent.id,
        source: payload.source,
        fidelity: payload.fidelity,
        historyPath: payload.historyPath,
        sessionId: payload.sessionId,
        updatedAt: payload.updatedAt,
        data: payload.data,
      };
    }
  }

  const brokerPayload = await loadBrokerSessionRefObservePayload(
    normalizedRef,
    requestedHarness,
    brokerContext,
  );
  if (brokerPayload === AMBIGUOUS_BROKER_SESSION_REF) {
    return null;
  }
  if (brokerPayload) {
    if (!requestedHarness && knownHarnesses.size > 0) {
      const brokerHarness = canonicalSessionHarness(brokerPayload.data.metadata?.session?.adapterType);
      if (!brokerHarness || !knownHarnesses.has(brokerHarness)) return null;
    }
    return brokerPayload;
  }

  if (!requestedHarness && hasAmbiguousTailHarness(matchingTranscripts)) return null;
  const tailHistoryEntry = discoveredHistoryEntry
    ?? await findTailSessionRefLookupEntry(normalizedRef, requestedHarness);
  if (tailHistoryEntry === AMBIGUOUS_TAIL_SESSION_REF) return null;
  const historyEntry = tailHistoryEntry ?? (
    (requestedHarness === "claude" || (!requestedHarness && (!discovery || matchingTranscripts.length === 0)))
      ? cachedHistoryEntry
      : null
  );
  const historySnapshot = historyEntry
    ? readHistorySnapshot({
        path: historyEntry.historyPath,
        adapterType: historyEntry.adapterType,
      })
    : null;
  if (historyEntry && historySnapshot) {
    return {
      kind: "history",
      refId: normalizedRef,
      agentId: null,
      source: "history",
      fidelity: historySnapshot.timedEvents.length > 0 ? "timestamped" : "synthetic",
      historyPath: historySnapshot.historyPath,
      sessionId: normalizedRef,
      updatedAt: Date.now(),
      data: buildObserveDataFromSnapshot(
        historySnapshot.snapshot,
        historySnapshot.timedEvents,
        false,
      ),
    };
  }

  if (!discovery) return null;
  let scopedDiscovery = { ...discovery, transcripts: matchingTranscripts };
  let nativeTail = await readTailEventsForSession(normalizedRef, { discovery: scopedDiscovery }).catch(() => null);
  if (!nativeTail) {
    discovery = await getTailDiscovery(true).catch(() => null);
    if (!discovery) return null;
    matchingTranscripts = tailSessionRefTranscripts(discovery, normalizedRef, requestedHarness);
    if (!requestedHarness && hasAmbiguousTailHarness(matchingTranscripts)) return null;
    scopedDiscovery = { ...discovery, transcripts: matchingTranscripts };
    nativeTail = await readTailEventsForSession(normalizedRef, { discovery: scopedDiscovery }).catch(() => null);
  }
  if (!nativeTail) {
    return null;
  }

  const sessionId = nativeTail.transcript.sessionId?.trim() || normalizedRef;
  const current = Date.now() - nativeTail.transcript.mtimeMs <= 5 * 60_000;
  return {
    kind: "tail",
    refId: normalizedRef,
    agentId: null,
    source: "tail",
    fidelity: "synthetic",
    historyPath: nativeTail.transcript.transcriptPath,
    sessionId,
    updatedAt: Date.now(),
    data: buildObserveDataFromTail(nativeTail.transcript, nativeTail.events, current),
  };
}
