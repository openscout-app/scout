import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
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
import { resolveTailThinkingMode } from "../user-config.js";
import type {
  DiscoveredProcess,
  DiscoveredTranscript,
  TailContext,
  TailDiscoveryScope,
  TailEvent,
  TailEventKind,
  TranscriptSource,
} from "./types.js";

const SOURCE_NAME = "devin";
const MAX_SUMMARY_LEN = 200;
const DEFAULT_HOT_DISCOVERY_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_SHALLOW_DISCOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DEEP_DISCOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HOT_DISCOVERY_LIMIT = 64;
const DEFAULT_SHALLOW_DISCOVERY_LIMIT = 160;
const DEFAULT_DEEP_DISCOVERY_LIMIT = 160;
const HEAD_READ_BYTES = 8 * 1024;
const SESSION_META_CACHE_LIMIT = 4;

type JsonRecord = Record<string, unknown>;
type TranscriptFileStat = { path: string; mtimeMs: number; size: number };
type DevinSessionMeta = { cwd: string | null };
type SessionDbCache = {
  path: string;
  mtimeMs: number;
  size: number;
  byId: Map<string, DevinSessionMeta>;
};

const sessionDbCache = new Map<string, SessionDbCache>();

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
  const scopedName = `OPENSCOUT_TAIL_${scope.toUpperCase()}_DISCOVERY_WINDOW_MS`;
  return readPositiveIntEnv([scopedName, "OPENSCOUT_TAIL_DISCOVERY_WINDOW_MS"], fallback);
}

function discoveryLimit(scope: TailDiscoveryScope): number {
  const fallback = scope === "hot"
    ? DEFAULT_HOT_DISCOVERY_LIMIT
    : scope === "deep"
      ? DEFAULT_DEEP_DISCOVERY_LIMIT
      : DEFAULT_SHALLOW_DISCOVERY_LIMIT;
  const scopedName = `OPENSCOUT_TAIL_${scope.toUpperCase()}_DISCOVERY_LIMIT`;
  return readPositiveIntEnv([scopedName, "OPENSCOUT_TAIL_DISCOVERY_LIMIT"], fallback);
}

function defaultCliRoot(): string {
  return join(homedir(), ".local", "share", "devin", "cli");
}

function transcriptsRoot(): string {
  const explicit = process.env.OPENSCOUT_TAIL_DEVIN_TRANSCRIPTS_ROOT?.trim();
  if (explicit) return explicit;
  return join(defaultCliRoot(), "transcripts");
}

function sessionsDbPath(): string {
  const explicit = process.env.OPENSCOUT_TAIL_DEVIN_SESSIONS_DB?.trim();
  if (explicit) return explicit;
  return join(dirname(transcriptsRoot()), "sessions.db");
}

function isDevinProcess(command: string): boolean {
  const base = commandBasename(command);
  return base === "devin" || command.includes("/.local/bin/devin");
}

export async function discoverDevinProcesses(): Promise<DiscoveredProcess[]> {
  const all = await listProcesses();
  const byPid = new Map<number, RawProcess>();
  for (const proc of all) byPid.set(proc.pid, proc);

  const matches = all.filter((proc) => isDevinProcess(proc.command));
  const out: DiscoveredProcess[] = [];
  await Promise.all(
    matches.map(async (proc) => {
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
    }),
  );
  out.sort((a, b) => a.pid - b.pid);
  return out;
}

function metadataRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function parseJsonRecord(text: string): JsonRecord | null {
  try {
    return metadataRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function stringValue(record: JsonRecord | null | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nestedRecord(record: JsonRecord | null | undefined, key: string): JsonRecord | null {
  return metadataRecord(record?.[key]);
}

function readFileHead(filePath: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const buffer = new Uint8Array(HEAD_READ_BYTES);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return Buffer.from(buffer.subarray(0, bytesRead)).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function sessionIdFromPath(filePath: string): string {
  return basename(filePath).replace(/\.json$/u, "");
}

function peekSessionId(filePath: string): string | null {
  const head = readFileHead(filePath);
  const match = /"session_id"\s*:\s*"([^"]+)"/u.exec(head);
  const sessionId = match?.[1]?.trim();
  return sessionId || null;
}

function provenCwdFromRecord(record: JsonRecord | null | undefined): string | null {
  if (!record) return null;
  return stringValue(record, "working_directory")
    ?? stringValue(record, "cwd")
    ?? stringValue(record, "directory");
}

function rememberSessionDb(path: string, stats: { mtimeMs: number; size: number }, byId: Map<string, DevinSessionMeta>): Map<string, DevinSessionMeta> {
  sessionDbCache.delete(path);
  sessionDbCache.set(path, { path, mtimeMs: stats.mtimeMs, size: stats.size, byId });
  while (sessionDbCache.size > SESSION_META_CACHE_LIMIT) {
    const oldest = sessionDbCache.keys().next().value;
    if (!oldest) break;
    sessionDbCache.delete(oldest);
  }
  return byId;
}

function readSessionMetadataFromDb(dbPath: string): Map<string, DevinSessionMeta> {
  try {
    // Devin's CLI session index is the only proven cwd/project store. Transcript
    // ATIF documents do not carry working_directory; never infer it from tool
    // command text. bun:sqlite is the runtime's existing readonly sqlite seam.
    const db = new Database(dbPath, { readonly: true, create: false });
    try {
      const rows = db.query("SELECT id, working_directory FROM sessions").all() as Array<{
        id?: unknown;
        working_directory?: unknown;
      }>;
      const byId = new Map<string, DevinSessionMeta>();
      for (const row of rows) {
        const id = typeof row.id === "string" ? row.id.trim() : "";
        if (!id) continue;
        const cwd = typeof row.working_directory === "string" && row.working_directory.trim()
          ? row.working_directory.trim()
          : null;
        byId.set(id, { cwd });
      }
      return byId;
    } finally {
      db.close();
    }
  } catch {
    return new Map();
  }
}

function loadSessionMetadata(dbPath: string): Map<string, DevinSessionMeta> {
  if (!dbPath || !existsSync(dbPath)) return new Map();
  try {
    // An open WAL writer can commit without changing the main database file.
    // Read a fresh snapshot while its WAL exists; discard any pre-WAL cache
    // so a later checkpoint cannot resurrect stale session metadata.
    if (existsSync(`${dbPath}-wal`)) {
      sessionDbCache.delete(dbPath);
      return readSessionMetadataFromDb(dbPath);
    }
    const stats = statSync(dbPath);
    const cached = sessionDbCache.get(dbPath);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.byId;
    }
    return rememberSessionDb(dbPath, stats, readSessionMetadataFromDb(dbPath));
  } catch {
    return new Map();
  }
}

function listRecentTranscriptFiles(root: string, scope: TailDiscoveryScope): TranscriptFileStat[] {
  const cutoff = Date.now() - discoveryWindowMs(scope);
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  const found: TranscriptFileStat[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const path = join(root, entry);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (!stats.isFile() || stats.mtimeMs < cutoff) continue;
    found.push({ path, mtimeMs: stats.mtimeMs, size: stats.size });
  }
  return found
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, discoveryLimit(scope));
}

function discoverDevinTranscripts(scope: TailDiscoveryScope): DiscoveredTranscript[] {
  const root = transcriptsRoot();
  if (!existsSync(root)) return [];
  const sessionMeta = loadSessionMetadata(sessionsDbPath());
  return listRecentTranscriptFiles(root, scope).map((file) => {
    const sessionId = peekSessionId(file.path) ?? sessionIdFromPath(file.path);
    const cwd = sessionMeta.get(sessionId)?.cwd ?? null;
    return {
      source: SOURCE_NAME,
      transcriptPath: file.path,
      sessionId,
      cwd,
      project: cwd ? basename(cwd) : "(unknown)",
      harness: "unattributed",
      mtimeMs: file.mtimeMs,
      size: file.size,
    };
  });
}

function clip(text: string, max = MAX_SUMMARY_LEN): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stepId(step: JsonRecord, index: number): string {
  const value = step.step_id;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  return String(index);
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  const record = metadataRecord(value);
  if (!record) return "";
  if (typeof record.content === "string") return record.content;
  if (typeof record.text === "string") return record.text;
  return "";
}

function eventKindForSource(source: string | null): TailEventKind {
  if (source === "user") return "user";
  if (source === "agent" || source === "assistant") return "assistant";
  if (source === "system") return "system";
  return "other";
}

function isAtifDocument(record: JsonRecord | null): record is JsonRecord {
  return Boolean(record && Array.isArray(record.steps));
}

function loadAtifDocument(text: string, transcriptPath: string): JsonRecord | null {
  const fromText = parseJsonRecord(text);
  if (isAtifDocument(fromText)) return fromText;
  // Whole-file watchers may pass a truncated tail of the JSON document.
  // Only reread from disk when the supplied text is not valid JSON; a parsed
  // non-ATIF object (including a single step) must not be treated as JSONL
  // and must not silently substitute the on-disk transcript.
  if (fromText || !transcriptPath) return null;
  try {
    const fromDisk = parseJsonRecord(readFileSync(transcriptPath, "utf8"));
    return isAtifDocument(fromDisk) ? fromDisk : null;
  } catch {
    return null;
  }
}

function thinkingSummary(reasoning: unknown): string | null {
  if (typeof reasoning !== "string") return null;
  const text = reasoning.trim();
  if (text) return clip(`[thinking] ${text}`);
  if (resolveTailThinkingMode() === "tag") return "[thinking]";
  return null;
}

function makeEvent(
  ctx: TailContext,
  params: {
    id: string;
    ts: number;
    sessionId: string;
    cwd: string;
    kind: TailEventKind;
    summary: string;
    raw: unknown;
  },
): TailEvent {
  return {
    id: params.id,
    ts: params.ts,
    source: SOURCE_NAME,
    sessionId: params.sessionId,
    pid: ctx.process.pid,
    parentPid: ctx.process.ppid || null,
    project: params.cwd ? basename(params.cwd) : ctx.transcript.project || "(unknown)",
    cwd: params.cwd,
    harness: ctx.process.harness,
    kind: params.kind,
    summary: params.summary,
    raw: params.raw,
  };
}

function parseDevinDocument(text: string, ctx: TailContext): TailEvent[] {
  const document = loadAtifDocument(text, ctx.transcriptPath);
  if (!document) return [];

  const sessionId = stringValue(document, "session_id")
    ?? ctx.transcript.sessionId
    ?? sessionIdFromPath(ctx.transcriptPath);
  const cwd = ctx.transcript.cwd
    ?? provenCwdFromRecord(nestedRecord(document, "extra"))
    ?? provenCwdFromRecord(nestedRecord(nestedRecord(document, "agent"), "extra"))
    ?? "";
  const steps = Array.isArray(document.steps) ? document.steps : [];
  const events: TailEvent[] = [];

  for (const [index, rawStep] of steps.entries()) {
    const step = metadataRecord(rawStep);
    if (!step) continue;

    const id = stepId(step, index);
    const ts = parseTimestamp(step.timestamp) ?? ctx.transcript.mtimeMs ?? Date.now();
    const stepSource = stringValue(step, "source");
    const reasoning = thinkingSummary(step.reasoning_content);
    if (reasoning) {
      events.push(makeEvent(ctx, {
        id: `${SOURCE_NAME}:${sessionId}:step:${id}:thinking`,
        ts,
        sessionId,
        cwd,
        kind: "system",
        summary: reasoning,
        raw: { step_id: step.step_id, reasoning_content: step.reasoning_content },
      }));
    }

    const textContent = messageText(step.message).trim();
    if (textContent) {
      events.push(makeEvent(ctx, {
        id: `${SOURCE_NAME}:${sessionId}:step:${id}:message`,
        ts,
        sessionId,
        cwd,
        kind: eventKindForSource(stepSource),
        summary: clip(textContent),
        raw: {
          step_id: step.step_id,
          source: step.source,
          message: step.message,
          ...(step.model_name != null ? { model_name: step.model_name } : {}),
        },
      }));
    }

    const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    const summariesByCallId = new Map<string, string>();
    for (const [toolIndex, rawCall] of toolCalls.entries()) {
      const call = metadataRecord(rawCall);
      if (!call) continue;
      const toolCallId = stringValue(call, "tool_call_id") ?? `tool-${toolIndex}`;
      const functionName = stringValue(call, "function_name") ?? "tool";
      const summary = clip(formatToolCall(functionName, call.arguments));
      summariesByCallId.set(toolCallId, summary);
      events.push(makeEvent(ctx, {
        id: `${SOURCE_NAME}:${sessionId}:step:${id}:tool:${toolCallId}`,
        ts,
        sessionId,
        cwd,
        kind: "tool",
        summary,
        raw: {
          step_id: step.step_id,
          tool_call_id: toolCallId,
          function_name: functionName,
          arguments: call.arguments,
        },
      }));
    }

    const observation = nestedRecord(step, "observation");
    const results = Array.isArray(observation?.results) ? observation.results : [];
    for (const [resultIndex, rawResult] of results.entries()) {
      const result = metadataRecord(rawResult);
      if (!result) continue;
      const sourceCallId = stringValue(result, "source_call_id") ?? `result-${resultIndex}`;
      events.push(makeEvent(ctx, {
        id: `${SOURCE_NAME}:${sessionId}:step:${id}:result:${sourceCallId}`,
        ts,
        sessionId,
        cwd,
        kind: "tool-result",
        summary: clip(formatToolResult(result.content, summariesByCallId.get(sourceCallId))),
        raw: {
          step_id: step.step_id,
          source_call_id: sourceCallId,
          content: result.content,
        },
      }));
    }
  }

  return events;
}

export const DevinSource: TranscriptSource = {
  name: SOURCE_NAME,
  discoverProcesses(): Promise<DiscoveredProcess[]> {
    return discoverDevinProcesses();
  },
  discoverTranscripts(_processes: DiscoveredProcess[], scope: TailDiscoveryScope = "shallow"): DiscoveredTranscript[] {
    return discoverDevinTranscripts(scope);
  },
  parseLine(line: string, ctx: TailContext): TailEvent | null {
    return parseDevinDocument(line, ctx)[0] ?? null;
  },
  parseFile(text: string, ctx: TailContext): TailEvent[] {
    return parseDevinDocument(text, ctx);
  },
};
