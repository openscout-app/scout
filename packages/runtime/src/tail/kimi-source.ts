import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  buildParentChain,
  classifyAttribution,
  commandBasename,
  listProcesses,
  processResourceFields,
  readCwd,
  type RawProcess,
} from "./discover.js";
import { formatToolCall, formatToolResult } from "./tool-format.js";
import type {
  DiscoveredProcess,
  DiscoveredTranscript,
  TailContext,
  TailDiscoveryScope,
  TailEvent,
  TailEventKind,
  TranscriptSource,
} from "./types.js";

const SOURCE_NAME = "kimi";
const MAX_SUMMARY_LEN = 200;
const DEFAULT_HOT_DISCOVERY_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_SHALLOW_DISCOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DEEP_DISCOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HOT_DISCOVERY_LIMIT = 96;
const DEFAULT_SHALLOW_DISCOVERY_LIMIT = 256;
const DEFAULT_DEEP_DISCOVERY_LIMIT = 256;
const METADATA_CACHE_LIMIT = 512;
const TOOL_CALL_STATE_KEY = "kimiToolCallSummaries";
const TOOL_CALL_STATE_LIMIT = 512;

type TranscriptFileStat = { path: string; mtimeMs: number; size: number };
type KimiTranscriptMetadata = {
  cwd: string | null;
  sessionId: string;
  parentSessionId: string;
  agentId: string;
  title: string | null;
};

type KimiTranscriptMetadataCacheEntry = TranscriptFileStat & KimiTranscriptMetadata & {
  stateMtimeMs: number | null;
  stateSize: number | null;
};

const metadataCache = new Map<string, KimiTranscriptMetadataCacheEntry>();

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  try {
    return recordValue(JSON.parse(line));
  } catch {
    return null;
  }
}

function readPositiveIntEnv(names: string[], fallback: number): number {
  for (const name of names) {
    const raw = Number.parseInt(process.env[name] ?? "", 10);
    if (Number.isFinite(raw) && raw > 0) return raw;
  }
  return fallback;
}

function discoveryWindowMs(scope: TailDiscoveryScope): number {
  const fallback = scope === "hot"
    ? DEFAULT_HOT_DISCOVERY_WINDOW_MS
    : scope === "deep"
      ? DEFAULT_DEEP_DISCOVERY_WINDOW_MS
      : DEFAULT_SHALLOW_DISCOVERY_WINDOW_MS;
  return readPositiveIntEnv([
    `OPENSCOUT_TAIL_${scope.toUpperCase()}_DISCOVERY_WINDOW_MS`,
    "OPENSCOUT_TAIL_DISCOVERY_WINDOW_MS",
  ], fallback);
}

function discoveryLimit(scope: TailDiscoveryScope): number {
  const fallback = scope === "hot"
    ? DEFAULT_HOT_DISCOVERY_LIMIT
    : scope === "deep"
      ? DEFAULT_DEEP_DISCOVERY_LIMIT
      : DEFAULT_SHALLOW_DISCOVERY_LIMIT;
  return readPositiveIntEnv([
    `OPENSCOUT_TAIL_${scope.toUpperCase()}_DISCOVERY_LIMIT`,
    "OPENSCOUT_TAIL_DISCOVERY_LIMIT",
  ], fallback);
}

function kimiSessionsRoot(): string {
  const explicit = process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT?.trim();
  if (explicit) return explicit;
  const kimiHome = process.env.KIMI_CODE_HOME?.trim() || join(homedir(), ".kimi-code");
  return join(kimiHome, "sessions");
}

function isKimiProcess(command: string): boolean {
  const base = commandBasename(command);
  return base === "kimi" || command.includes("/.kimi-code/bin/kimi");
}

export async function discoverKimiProcesses(): Promise<DiscoveredProcess[]> {
  const all = await listProcesses();
  const byPid = new Map<number, RawProcess>();
  for (const proc of all) byPid.set(proc.pid, proc);

  const out: DiscoveredProcess[] = [];
  await Promise.all(all.filter((proc) => isKimiProcess(proc.command)).map(async (proc) => {
    const cwd = await readCwd(proc.pid, proc.etime);
    const parentChain = buildParentChain(proc.pid, byPid);
    out.push({
      pid: proc.pid,
      ppid: proc.ppid,
      command: proc.command,
      etime: proc.etime,
      ...processResourceFields(proc),
      cwd,
      harness: classifyAttribution(parentChain),
      parentChain,
      source: SOURCE_NAME,
    });
  }));
  out.sort((left, right) => left.pid - right.pid);
  return out;
}

function walkRecentKimiWireFiles(root: string, scope: TailDiscoveryScope): TranscriptFileStat[] {
  if (!existsSync(root)) return [];
  const cutoff = Date.now() - discoveryWindowMs(scope);
  const found: TranscriptFileStat[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        stack.push(path);
      } else if (entry === "wire.jsonl" && stats.mtimeMs >= cutoff) {
        found.push({ path, mtimeMs: stats.mtimeMs, size: stats.size });
      }
    }
  }
  return found
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, discoveryLimit(scope));
}

function readKimiTranscriptMetadata(file: TranscriptFileStat): KimiTranscriptMetadata {
  const agentId = basename(dirname(file.path));
  const sessionDirectory = dirname(dirname(dirname(file.path)));
  const statePath = join(sessionDirectory, "state.json");
  let stateMtimeMs: number | null = null;
  let stateSize: number | null = null;
  try {
    const stateStat = statSync(statePath);
    stateMtimeMs = stateStat.mtimeMs;
    stateSize = stateStat.size;
  } catch {
    // A newly-created session may expose wire.jsonl before state.json is durable.
  }

  const cached = metadataCache.get(file.path);
  if (
    cached
    && cached.mtimeMs === file.mtimeMs
    && cached.size === file.size
    && cached.stateMtimeMs === stateMtimeMs
    && cached.stateSize === stateSize
  ) {
    return cached;
  }
  const parentSessionId = basename(sessionDirectory);

  let cwd: string | null = null;
  let title: string | null = null;
  try {
    const state = recordValue(JSON.parse(readFileSync(statePath, "utf8")));
    // `version: 2` state files renamed `workDir` to `cwd`; both shapes stay on disk.
    cwd = trimmedString(state?.cwd) ?? trimmedString(state?.workDir);
    title = trimmedString(state?.title);
  } catch {
    // A newly-created session may expose wire.jsonl before state.json is durable.
  }

  const metadata: KimiTranscriptMetadata = {
    cwd,
    parentSessionId,
    agentId,
    sessionId: agentId === "main" ? parentSessionId : `${parentSessionId}:${agentId}`,
    title,
  };
  metadataCache.delete(file.path);
  metadataCache.set(file.path, { ...file, stateMtimeMs, stateSize, ...metadata });
  while (metadataCache.size > METADATA_CACHE_LIMIT) {
    const oldest = metadataCache.keys().next().value;
    if (!oldest) break;
    metadataCache.delete(oldest);
  }
  return metadata;
}

/**
 * Kimi groups sessions under a `wd_<slug>_<hash>` workspace directory, so the slug still
 * names the project when state.json is missing, unreadable, or not yet durable.
 */
function workspaceProject(wirePath: string): string | null {
  // .../wd_<slug>_<hash>/session_<id>/agents/<agentId>/wire.jsonl
  const workspaceDirectory = basename(dirname(dirname(dirname(dirname(wirePath)))));
  return trimmedString(/^wd_(.+)_[0-9a-f]{6,}$/u.exec(workspaceDirectory)?.[1]);
}

function discoverKimiTranscripts(scope: TailDiscoveryScope): DiscoveredTranscript[] {
  return walkRecentKimiWireFiles(kimiSessionsRoot(), scope).map((file) => {
    const metadata = readKimiTranscriptMetadata(file);
    return {
      source: SOURCE_NAME,
      transcriptPath: file.path,
      sessionId: metadata.sessionId,
      cwd: metadata.cwd,
      project: (metadata.cwd ? basename(metadata.cwd) : workspaceProject(file.path)) ?? "(unknown)",
      harness: "unattributed",
      mtimeMs: file.mtimeMs,
      size: file.size,
    };
  });
}

function clip(text: string, max = MAX_SUMMARY_LEN): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    const part = recordValue(item);
    if (!part) continue;
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    else if (part.type === "image") parts.push("[image]");
    else if (part.type === "resource" || part.type === "resource_link") parts.push("[resource]");
  }
  return parts.join(" ").trim();
}

function toolCalls(ctx: TailContext): Map<string, string> | null {
  if (!ctx.state) return null;
  const existing = ctx.state[TOOL_CALL_STATE_KEY];
  if (existing instanceof Map) return existing as Map<string, string>;
  const next = new Map<string, string>();
  ctx.state[TOOL_CALL_STATE_KEY] = next;
  return next;
}

function rememberToolCall(ctx: TailContext, id: string, summary: string): void {
  if (!id) return;
  const calls = toolCalls(ctx);
  if (!calls) return;
  calls.delete(id);
  calls.set(id, summary);
  while (calls.size > TOOL_CALL_STATE_LIMIT) {
    const oldest = calls.keys().next().value;
    if (!oldest) break;
    calls.delete(oldest);
  }
}

function eventIdentity(record: Record<string, unknown>, lineOffset: number): string {
  const event = recordValue(record.event);
  const stable = [
    event?.uuid,
    event?.toolCallId,
    record.toolCallId,
    record.id,
  ].find((value) => typeof value === "string" && value.trim());
  const type = typeof record.type === "string" ? record.type : "event";
  return `${type}:${typeof stable === "string" ? stable : `${String(record.time ?? "na")}:${lineOffset}`}`;
}

function summarizeKimiRecord(
  record: Record<string, unknown>,
  ctx: TailContext,
): { kind: TailEventKind; summary: string } | null {
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "turn.prompt") {
    return { kind: "user", summary: clip(contentText(record.input) || "[user]") };
  }
  if (type === "turn.steer") {
    const origin = recordValue(record.origin);
    const status = typeof origin?.status === "string" ? origin.status : "update";
    return { kind: "system", summary: clip(`background task ${status} · ${contentText(record.input)}`) };
  }
  if (type === "turn.cancel") {
    return { kind: "system", summary: "turn cancelled" };
  }
  if (type === "permission.record_approval_result") {
    const result = recordValue(record.result);
    const decision = typeof result?.decision === "string" ? result.decision : "recorded";
    const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
    return { kind: "system", summary: clip(`permission ${decision} · ${toolName}`) };
  }
  if (type === "plan_mode.enter" || type === "plan_mode.exit") {
    return { kind: "system", summary: type === "plan_mode.enter" ? "plan mode entered" : "plan mode exited" };
  }
  if (type === "full_compaction.begin" || type === "full_compaction.complete") {
    return { kind: "system", summary: type.endsWith("begin") ? "context compaction started" : "context compaction completed" };
  }
  if (type === "context.apply_compaction") {
    const summary = typeof record.summary === "string" ? record.summary : "";
    return { kind: "system", summary: clip(`context compacted${summary ? ` · ${summary}` : ""}`) };
  }
  if (type !== "context.append_loop_event") return null;

  const event = recordValue(record.event);
  const eventType = typeof event?.type === "string" ? event.type : "";
  if (eventType === "content.part") {
    const part = recordValue(event?.part);
    if (part?.type === "text" && typeof part.text === "string") {
      return { kind: "assistant", summary: clip(part.text || "[assistant]") };
    }
    if (part?.type === "think" && typeof part.think === "string") {
      return { kind: "system", summary: clip(`[thinking] ${part.think}`) };
    }
    return null;
  }
  if (eventType === "tool.call") {
    const name = typeof event?.name === "string" ? event.name : "tool";
    const summary = clip(formatToolCall(name, event?.args));
    const callId = typeof event?.toolCallId === "string" ? event.toolCallId : "";
    rememberToolCall(ctx, callId, summary);
    return { kind: "tool", summary };
  }
  if (eventType === "tool.result") {
    const callId = typeof event?.toolCallId === "string" ? event.toolCallId : "";
    return {
      kind: "tool-result",
      summary: clip(formatToolResult(event?.result, toolCalls(ctx)?.get(callId))),
    };
  }
  return null;
}

function parseKimiLine(line: string, ctx: TailContext): TailEvent | null {
  const record = parseJsonRecord(line.trim());
  if (!record) return null;
  const parsed = summarizeKimiRecord(record, ctx);
  if (!parsed) return null;

  const sessionId = ctx.transcript.sessionId ?? basename(dirname(dirname(dirname(ctx.transcriptPath))));
  const cwd = ctx.transcript.cwd ?? ctx.process.cwd ?? "";
  const nestedEvent = recordValue(record.event);
  return {
    id: `${SOURCE_NAME}:${sessionId}:${eventIdentity(record, ctx.lineOffset)}`,
    ts: parseTimestamp(record.time)
      ?? parseTimestamp(nestedEvent?.time)
      ?? parseTimestamp(record.created_at)
      ?? Date.now(),
    source: SOURCE_NAME,
    sessionId,
    pid: ctx.process.pid,
    parentPid: ctx.process.ppid || null,
    project: cwd ? basename(cwd) : ctx.transcript.project,
    cwd,
    harness: ctx.process.harness,
    kind: parsed.kind,
    summary: parsed.summary,
    raw: record,
  };
}

export const KimiSource: TranscriptSource = {
  name: SOURCE_NAME,
  discoverProcesses(): Promise<DiscoveredProcess[]> {
    return discoverKimiProcesses();
  },
  discoverTranscripts(_processes: DiscoveredProcess[], scope: TailDiscoveryScope = "shallow"): DiscoveredTranscript[] {
    return discoverKimiTranscripts(scope);
  },
  parseLine(line: string, ctx: TailContext): TailEvent | null {
    return parseKimiLine(line, ctx);
  },
};
