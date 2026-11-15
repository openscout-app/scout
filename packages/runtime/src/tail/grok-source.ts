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
import type {
  DiscoveredProcess,
  DiscoveredTranscript,
  TailContext,
  TailDiscoveryScope,
  TailEvent,
  TailEventKind,
  TranscriptSource,
} from "./types.js";
import { oneLine } from "./tool-format.js";

const SOURCE_NAME = "grok";
const MAX_SUMMARY_LEN = 200;
const DEFAULT_HOT_DISCOVERY_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_SHALLOW_DISCOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DEEP_DISCOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HOT_DISCOVERY_LIMIT = 64;
const DEFAULT_SHALLOW_DISCOVERY_LIMIT = 160;
const DEFAULT_DEEP_DISCOVERY_LIMIT = 160;
const HEAD_READ_BYTES = 256 * 1024;
const METADATA_CACHE_LIMIT = 512;
const TOOL_CALL_MATCH_WINDOW_MS = 10_000;
const TOOL_CALL_INDEX_CACHE_LIMIT = 64;

type GrokToolCallRecord = {
  toolCallId: string;
  tsMs: number;
  toolName: string;
  arg: string;
  rawInput: Record<string, unknown>;
};

/**
 * One prompt/reply pair from `updates.jsonl`. `events.jsonl` only carries
 * lifecycle markers, so without this a reply-only turn (a Scout ask answered
 * without tools) has no user or assistant event and never reaches Lanes or
 * Mission Control.
 */
type GrokTurnRecord = {
  prompt: string;
  replies: string[];
};

type GrokToolCallMatcher = {
  records: GrokToolCallRecord[];
  turns: Map<number, GrokTurnRecord>;
  paired: Set<string>;
  pendingByTool: Map<string, GrokToolCallRecord>;
  updatesMtimeMs: number;
};

const grokToolCallMatchers = new Map<string, GrokToolCallMatcher>();
/** Turn in progress per session dir, advanced by `turn_started` as lines parse in order. */
const grokCurrentTurns = new Map<string, number>();

type TranscriptFileStat = { path: string; mtimeMs: number; size: number };
type TranscriptMetadata = {
  cwd: string | null;
  sessionId: string | null;
  modelId: string | null;
  title: string | null;
};

const metadataCache = new Map<string, TranscriptFileStat & TranscriptMetadata>();

function rememberMetadata(file: TranscriptFileStat, metadata: TranscriptMetadata): TranscriptMetadata {
  metadataCache.delete(file.path);
  metadataCache.set(file.path, { ...file, ...metadata });
  while (metadataCache.size > METADATA_CACHE_LIMIT) {
    const oldest = metadataCache.keys().next().value;
    if (!oldest) break;
    metadataCache.delete(oldest);
  }
  return metadata;
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

function grokSessionRoots(): string[] {
  const explicit = process.env.OPENSCOUT_TAIL_GROK_SESSIONS_ROOT;
  if (explicit?.trim()) return [explicit.trim()];
  return [join(homedir(), ".grok", "sessions")].filter((root) => existsSync(root));
}

function isGrokProcess(command: string): boolean {
  const base = commandBasename(command);
  return base === "grok" || command.includes("/.grok/bin/grok") || command.includes("/.grok/bin/agent");
}

export async function discoverGrokProcesses(): Promise<DiscoveredProcess[]> {
  const all = await listProcesses();
  const byPid = new Map<number, RawProcess>();
  for (const proc of all) byPid.set(proc.pid, proc);

  const groks = all.filter((proc) => isGrokProcess(proc.command));
  const out: DiscoveredProcess[] = [];
  await Promise.all(
    groks.map(async (proc) => {
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

function parseJsonRecord(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    return metadataRecord(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

function decodeGrokCwdFromProjectDir(projectDir: string): string | null {
  try {
    const decoded = decodeURIComponent(basename(projectDir));
    return decoded.startsWith("/") ? decoded : null;
  } catch {
    return null;
  }
}

function readGrokMetadata(file: TranscriptFileStat): TranscriptMetadata {
  const cached = metadataCache.get(file.path);
  if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
    return {
      cwd: cached.cwd,
      sessionId: cached.sessionId,
      modelId: cached.modelId,
      title: cached.title,
    };
  }

  const sessionDir = dirname(file.path);
  const summary = readJsonFile(join(sessionDir, "summary.json"));
  const info = metadataRecord(summary?.info);
  let cwd = typeof info?.cwd === "string" && info.cwd.trim() ? info.cwd : null;
  let sessionId: string | null = typeof info?.id === "string" && info.id.trim() ? info.id : basename(sessionDir);
  let modelId = typeof summary?.current_model_id === "string" && summary.current_model_id.trim()
    ? summary.current_model_id
    : null;
  let title = typeof summary?.generated_title === "string" && summary.generated_title.trim()
    ? summary.generated_title
    : typeof summary?.session_summary === "string" && summary.session_summary.trim()
      ? summary.session_summary
      : null;

  const head = readFileHead(file.path);
  for (const line of head.split(/\r?\n/)) {
    const record = parseJsonRecord(line.trim());
    if (!record) continue;
    cwd ??= typeof record.cwd === "string" && record.cwd.trim()
      ? record.cwd
      : null;
    sessionId ??= typeof record.session_id === "string" && record.session_id.trim()
      ? record.session_id
      : null;
    modelId ??= typeof record.model_id === "string" && record.model_id.trim()
      ? record.model_id
      : null;
    if (cwd && sessionId && modelId) break;
  }

  cwd ??= decodeGrokCwdFromProjectDir(dirname(sessionDir));
  return rememberMetadata(file, { cwd, sessionId, modelId, title });
}

function walkRecentGrokEventFiles(
  root: string,
  scope: TailDiscoveryScope,
): TranscriptFileStat[] {
  const cutoff = Date.now() - discoveryWindowMs(scope);
  const found: TranscriptFileStat[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (entry !== "events.jsonl" || stats.mtimeMs < cutoff) continue;
      found.push({ path, mtimeMs: stats.mtimeMs, size: stats.size });
    }
  }
  return found;
}

function discoverGrokTranscripts(scope: TailDiscoveryScope): DiscoveredTranscript[] {
  const byPath = new Map<string, TranscriptFileStat>();
  for (const root of grokSessionRoots()) {
    for (const file of walkRecentGrokEventFiles(root, scope)) {
      const existing = byPath.get(file.path);
      if (!existing || file.mtimeMs > existing.mtimeMs) byPath.set(file.path, file);
    }
  }
  return [...byPath.values()]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, discoveryLimit(scope))
    .map((file) => {
      const meta = readGrokMetadata(file);
      return {
        source: SOURCE_NAME,
        transcriptPath: file.path,
        sessionId: meta.sessionId,
        cwd: meta.cwd,
        project: meta.cwd ? basename(meta.cwd) : "(unknown)",
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
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function grokToolArgSummary(toolName: string, rawInput: Record<string, unknown>): string {
  const name = toolName.trim();
  if (name === "Shell") {
    return typeof rawInput.command === "string" ? rawInput.command.trim() : "";
  }
  if (name === "Read" || name === "Write" || name === "Delete" || name === "StrReplace") {
    return typeof rawInput.path === "string" ? rawInput.path.trim() : "";
  }
  if (name === "Grep") {
    const pattern = typeof rawInput.pattern === "string" ? rawInput.pattern.trim() : "";
    const path = typeof rawInput.path === "string" ? rawInput.path.trim() : "";
    if (pattern && path) return `${pattern} in ${path}`;
    return pattern || path;
  }
  if (name === "Glob") {
    const glob = typeof rawInput.glob_pattern === "string" ? rawInput.glob_pattern.trim() : "";
    const dir = typeof rawInput.target_directory === "string" ? rawInput.target_directory.trim() : "";
    if (glob && dir) return `${glob} @ ${dir}`;
    return glob || dir;
  }

  for (const value of Object.values(rawInput)) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function grokContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(grokContentText).join("");
  const record = metadataRecord(content);
  return typeof record?.text === "string" ? record.text : "";
}

function loadGrokUpdatesIndex(sessionDir: string): {
  records: GrokToolCallRecord[];
  turns: Map<number, GrokTurnRecord>;
} {
  const updatesPath = join(sessionDir, "updates.jsonl");
  const records: GrokToolCallRecord[] = [];
  const turns = new Map<number, GrokTurnRecord>();
  if (!existsSync(updatesPath)) return { records, turns };

  let currentTurn: GrokTurnRecord | null = null;
  let previousUpdate = "";
  try {
    const text = readFileSync(updatesPath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const envelope = parseJsonRecord(line.trim());
      const params = metadataRecord(envelope?.params);
      const update = metadataRecord(params?.update);
      const kind = typeof update?.sessionUpdate === "string" ? update.sessionUpdate : "";
      if (!update || !kind) continue;

      if (kind === "user_message_chunk") {
        const promptIndex = metadataRecord(update._meta)?.promptIndex;
        const index = typeof promptIndex === "number" ? promptIndex : turns.size;
        currentTurn = turns.get(index) ?? { prompt: "", replies: [] };
        turns.set(index, currentTurn);
        currentTurn.prompt += grokContentText(update.content);
      } else if (kind === "agent_message_chunk" && currentTurn) {
        // Consecutive chunks stream one message; anything in between (a tool
        // call, a thought) starts the next one.
        const chunk = grokContentText(update.content);
        if (previousUpdate === "agent_message_chunk" && currentTurn.replies.length > 0) {
          currentTurn.replies[currentTurn.replies.length - 1] += chunk;
        } else {
          currentTurn.replies.push(chunk);
        }
      }
      previousUpdate = kind;
      if (kind !== "tool_call") continue;

      const toolName = typeof update.title === "string" && update.title.trim()
        ? update.title.trim()
        : "tool";
      const rawInput = metadataRecord(update.rawInput) ?? {};
      const toolCallId = typeof update.toolCallId === "string" && update.toolCallId.trim()
        ? update.toolCallId.trim()
        : `${toolName}:${records.length}`;
      const tsMs = parseTimestamp(envelope?.timestamp) ?? Date.now();
      const arg = grokToolArgSummary(toolName, rawInput);
      if (!arg) continue;

      records.push({
        toolCallId,
        tsMs,
        toolName,
        arg,
        rawInput,
      });
    }
  } catch {
    return { records: [], turns: new Map() };
  }

  return { records: records.sort((left, right) => left.tsMs - right.tsMs), turns };
}

function grokMatcherForTranscript(transcriptPath: string): GrokToolCallMatcher | null {
  const sessionDir = dirname(transcriptPath);
  const updatesPath = join(sessionDir, "updates.jsonl");
  if (!existsSync(updatesPath)) return null;

  let updatesMtimeMs = 0;
  try {
    updatesMtimeMs = statSync(updatesPath).mtimeMs;
  } catch {
    return null;
  }

  const existing = grokToolCallMatchers.get(sessionDir);
  if (existing && existing.updatesMtimeMs === updatesMtimeMs) {
    return existing;
  }

  const { records, turns } = loadGrokUpdatesIndex(sessionDir);
  const matcher: GrokToolCallMatcher = {
    records,
    turns,
    paired: new Set(),
    pendingByTool: new Map(),
    updatesMtimeMs,
  };
  grokToolCallMatchers.delete(sessionDir);
  grokToolCallMatchers.set(sessionDir, matcher);
  while (grokToolCallMatchers.size > TOOL_CALL_INDEX_CACHE_LIMIT) {
    const oldest = grokToolCallMatchers.keys().next().value;
    if (!oldest) break;
    grokToolCallMatchers.delete(oldest);
  }
  while (grokCurrentTurns.size > TOOL_CALL_INDEX_CACHE_LIMIT) {
    const oldest = grokCurrentTurns.keys().next().value;
    if (!oldest) break;
    grokCurrentTurns.delete(oldest);
  }
  return matcher;
}

function resetGrokToolCallMatcher(transcriptPath: string): void {
  const sessionDir = dirname(transcriptPath);
  grokCurrentTurns.delete(sessionDir);
  const matcher = grokToolCallMatchers.get(sessionDir);
  if (!matcher) return;
  matcher.paired.clear();
  matcher.pendingByTool.clear();
}

function matchGrokToolCall(
  matcher: GrokToolCallMatcher,
  toolName: string,
  eventTs: number,
  phase: "started" | "completed",
): GrokToolCallRecord | null {
  if (phase === "completed") {
    const pending = matcher.pendingByTool.get(toolName);
    if (pending && !matcher.paired.has(pending.toolCallId)) {
      matcher.paired.add(pending.toolCallId);
      matcher.pendingByTool.delete(toolName);
      return pending;
    }
  }

  let best: GrokToolCallRecord | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const record of matcher.records) {
    if (record.toolName !== toolName) continue;
    if (matcher.paired.has(record.toolCallId)) continue;
    const delta = Math.abs(record.tsMs - eventTs);
    if (delta > TOOL_CALL_MATCH_WINDOW_MS || delta >= bestDelta) continue;
    best = record;
    bestDelta = delta;
  }

  if (!best) return null;
  if (phase === "started") {
    matcher.pendingByTool.set(toolName, best);
    return best;
  }

  matcher.paired.add(best.toolCallId);
  matcher.pendingByTool.delete(toolName);
  return best;
}

function grokKind(type: string): TailEventKind {
  if (type === "tool_started") return "tool";
  if (type === "tool_completed") return "tool-result";
  if (type === "permission_requested" || type === "permission_resolved") return "system";
  if (type === "turn_started" || type === "loop_started" || type === "phase_changed" || type === "first_token") {
    return "system";
  }
  return "other";
}

function grokStrReplaceEditClause(toolInput: Record<string, unknown> | null): string | null {
  if (!toolInput) return null;
  const oldText = typeof toolInput.old_string === "string" ? toolInput.old_string.trim() : "";
  const newText = typeof toolInput.new_string === "string" ? toolInput.new_string.trim() : "";
  if (!oldText && !newText) return null;
  const parts: string[] = [];
  if (oldText) parts.push(`-${oneLine(oldText, 72)}`);
  if (newText) parts.push(`+${oneLine(newText, 72)}`);
  return `edit: ${parts.join(" · ")}`;
}

function summarizeGrokToolLine(
  tool: string,
  payload: Record<string, unknown>,
  phase: "started" | "completed",
): string {
  const arg = typeof payload.tool_arg === "string" ? payload.tool_arg.trim() : "";
  const outcome = typeof payload.outcome === "string" ? payload.outcome.trim() : "";
  const editClause = tool === "StrReplace"
    ? grokStrReplaceEditClause(metadataRecord(payload.tool_input))
    : null;

  if (arg && editClause) {
    return clip(`${tool} · ${arg} · ${editClause}${phase === "completed" && outcome ? ` · ${outcome}` : ""}`);
  }
  if (arg) {
    return clip(`${tool} · ${arg}${phase === "completed" && outcome ? ` · ${outcome}` : ""}`);
  }
  return clip(phase === "completed"
    ? `${tool} completed${outcome ? ` · ${outcome}` : ""}`
    : `${tool} started`);
}

function summarizeGrok(type: string, payload: Record<string, unknown>): string {
  if (type === "turn_started") {
    const model = typeof payload.model_id === "string" ? payload.model_id : "";
    const turn = typeof payload.turn_number === "number" ? `turn ${payload.turn_number}` : "turn started";
    return clip(`${turn}${model ? ` · ${model}` : ""}`);
  }
  if (type === "loop_started") {
    return typeof payload.loop_index === "number" ? `loop ${payload.loop_index} started` : "loop started";
  }
  if (type === "phase_changed") {
    return clip(`phase · ${String(payload.phase ?? "unknown")}`);
  }
  if (type === "first_token") return "first token";
  if (type === "tool_started") {
    return summarizeGrokToolLine(String(payload.tool_name ?? "tool"), payload, "started");
  }
  if (type === "tool_completed") {
    return summarizeGrokToolLine(String(payload.tool_name ?? "tool"), payload, "completed");
  }
  if (type === "permission_requested") return clip(`permission requested · ${String(payload.tool_name ?? "tool")}`);
  if (type === "permission_resolved") {
    const tool = String(payload.tool_name ?? "tool");
    const decision = typeof payload.decision === "string" ? payload.decision : "";
    return clip(`permission ${decision || "resolved"} · ${tool}`);
  }
  return clip(`[${type || SOURCE_NAME}]`);
}

function enrichGrokToolPayload(
  payload: Record<string, unknown>,
  type: string,
  eventTs: number,
  matcher: GrokToolCallMatcher | null,
): Record<string, unknown> {
  if (!matcher || (type !== "tool_started" && type !== "tool_completed")) {
    return payload;
  }

  const toolName = typeof payload.tool_name === "string" ? payload.tool_name.trim() : "";
  if (!toolName) return payload;

  const match = matchGrokToolCall(
    matcher,
    toolName,
    eventTs,
    type === "tool_started" ? "started" : "completed",
  );
  if (!match) return payload;

  return {
    ...payload,
    tool_arg: match.arg,
    tool_call_id: match.toolCallId,
    tool_input: match.rawInput,
  };
}

/**
 * The first loop of a turn stands in for the prompt and `turn_ended` for the
 * reply; both lines are otherwise lifecycle noise. The turn number comes from
 * the preceding `turn_started`, so a line read without it stays lifecycle
 * rather than guess which turn it belongs to.
 */
function grokTurnMessage(
  type: string,
  record: Record<string, unknown>,
  turnNumber: number | undefined,
  matcher: GrokToolCallMatcher | null,
): { kind: "user" | "assistant"; text: string } | null {
  if (turnNumber === undefined || !matcher) return null;
  const turn = matcher.turns.get(turnNumber);
  if (!turn) return null;
  if (type === "loop_started" && record.loop_index === 0) {
    const text = turn.prompt.trim();
    return text ? { kind: "user", text } : null;
  }
  if (type === "turn_ended") {
    const text = [...turn.replies].reverse().find((reply) => reply.trim())?.trim() ?? "";
    return text ? { kind: "assistant", text } : null;
  }
  return null;
}

function parseGrokLine(line: string, ctx: TailContext): TailEvent | null {
  const record = parseJsonRecord(line.trim());
  if (!record) return null;

  const type = typeof record.type === "string" ? record.type : "other";
  const sessionId = typeof record.session_id === "string" && record.session_id.trim()
    ? record.session_id
    : ctx.transcript.sessionId ?? basename(dirname(ctx.transcriptPath));
  const cwd = ctx.transcript.cwd ?? ctx.process.cwd ?? "";
  const eventTs = parseTimestamp(record.ts) ?? parseTimestamp(record.timestamp) ?? Date.now();
  const matcher = grokMatcherForTranscript(ctx.transcriptPath);
  const enriched = enrichGrokToolPayload(record, type, eventTs, matcher);
  const sessionDir = dirname(ctx.transcriptPath);
  if (type === "turn_started" && typeof record.turn_number === "number") {
    grokCurrentTurns.set(sessionDir, record.turn_number);
  }
  const message = grokTurnMessage(type, record, grokCurrentTurns.get(sessionDir), matcher);
  if (message) {
    return {
      id: `${SOURCE_NAME}:${sessionId}:${ctx.lineOffset}`,
      ts: eventTs,
      source: SOURCE_NAME,
      sessionId,
      pid: ctx.process.pid,
      parentPid: ctx.process.ppid || null,
      project: cwd ? basename(cwd) : ctx.transcript.project,
      cwd,
      harness: ctx.process.harness,
      kind: message.kind,
      summary: clip(message.text),
      raw: { ...enriched, text: message.text },
    };
  }

  return {
    id: `${SOURCE_NAME}:${sessionId}:${ctx.lineOffset}`,
    ts: eventTs,
    source: SOURCE_NAME,
    sessionId,
    pid: ctx.process.pid,
    parentPid: ctx.process.ppid || null,
    project: cwd ? basename(cwd) : ctx.transcript.project,
    cwd,
    harness: ctx.process.harness,
    kind: grokKind(type),
    summary: summarizeGrok(type, enriched),
    raw: enriched,
  };
}

export const GrokSource: TranscriptSource = {
  name: SOURCE_NAME,
  discoverProcesses(): Promise<DiscoveredProcess[]> {
    return discoverGrokProcesses();
  },
  discoverTranscripts(_processes: DiscoveredProcess[], scope: TailDiscoveryScope = "shallow"): DiscoveredTranscript[] {
    return discoverGrokTranscripts(scope);
  },
  parseLine(line: string, ctx: TailContext): TailEvent | null {
    if (ctx.lineOffset === 0) {
      resetGrokToolCallMatcher(ctx.transcriptPath);
    }
    return parseGrokLine(line, ctx);
  },
};
