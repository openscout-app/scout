import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  buildParentChain,
  classifyAttribution,
  commandBasename,
  listProcesses,
  readCwd,
  type RawProcess,
} from "./discover.js";
import { formatToolCall, formatToolResult, parseMaybeJson } from "./tool-format.js";
import type {
  DiscoveredProcess,
  DiscoveredTranscript,
  TailContext,
  TailDiscoveryScope,
  TailEvent,
  TailEventKind,
  TranscriptSource,
} from "./types.js";

const SOURCE_NAME = "codex";
const MAX_SUMMARY_LEN = 200;
const TOOL_CALL_STATE_KEY = "codexToolCallsById";
const TOOL_CALL_STATE_LIMIT = 512;
const DEFAULT_HOT_DISCOVERY_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_SHALLOW_DISCOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DEEP_DISCOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HOT_DISCOVERY_LIMIT = 64;
const DEFAULT_SHALLOW_DISCOVERY_LIMIT = 160;
const DEFAULT_DEEP_DISCOVERY_LIMIT = 160;
const HEAD_READ_BYTES = 512 * 1024;
const METADATA_CACHE_LIMIT = 512;

type TranscriptFileStat = { path: string; mtimeMs: number; size: number };
type TranscriptMetadata = { cwd: string | null; sessionId: string | null; parentSessionId?: string | null; agentNickname?: string | null };

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

function codexSessionRoots(): string[] {
  const explicit = process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT;
  if (explicit?.trim()) return [explicit.trim()];
  return [
    join(homedir(), ".codex", "sessions"),
    join(homedir(), ".openai-codex", "sessions"),
  ].filter((root) => existsSync(root));
}

function isCodexAppServerProcess(command: string): boolean {
  const base = commandBasename(command);
  return base === "codex" && /\bapp-server\b/.test(command);
}

export async function discoverCodexProcesses(): Promise<DiscoveredProcess[]> {
  const all = await listProcesses();
  const byPid = new Map<number, RawProcess>();
  for (const proc of all) byPid.set(proc.pid, proc);

  const codexes = all.filter((proc) => isCodexAppServerProcess(proc.command));
  const out: DiscoveredProcess[] = [];
  await Promise.all(
    codexes.map(async (proc) => {
      const cwd = await readCwd(proc.pid);
      const parentChain = buildParentChain(proc.pid, byPid);
      out.push({
        pid: proc.pid,
        ppid: proc.ppid,
        command: proc.command,
        etime: proc.etime,
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

function readCodexMetadata(file: TranscriptFileStat): TranscriptMetadata {
  const cached = metadataCache.get(file.path);
  if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
    return { cwd: cached.cwd, sessionId: cached.sessionId, parentSessionId: cached.parentSessionId, agentNickname: cached.agentNickname };
  }

  const head = readFileHead(file.path);
  let cwd: string | null = null;
  let sessionId: string | null = null;
  let parentSessionId: string | null = null;
  let agentNickname: string | null = null;
  for (const line of head.split(/\r?\n/)) {
    const record = parseJsonRecord(line.trim());
    if (!record) continue;
    const payload = metadataRecord(record.payload);
    if (!payload) continue;
    if (record.type === "session_meta" || record.type === "turn_context") {
      cwd ??= typeof payload.cwd === "string" && payload.cwd.trim()
        ? payload.cwd
        : null;
      sessionId ??= typeof payload.id === "string" && payload.id.trim()
        ? payload.id
        : null;
      if (record.type === "session_meta") {
        const source = metadataRecord(payload.source);
        const spawn = metadataRecord(metadataRecord(source?.sub_agent)?.thread_spawn);
        const parent = payload.parent_thread_id ?? spawn?.parent_thread_id;
        parentSessionId = typeof parent === "string" && parent.trim() && parent.trim() !== sessionId ? parent.trim() : null;
        const nickname = payload.agent_nickname ?? spawn?.agent_nickname;
        agentNickname = parentSessionId && typeof nickname === "string" && nickname.trim() ? nickname.trim() : null;
      }
      if (cwd && sessionId) return rememberMetadata(file, { cwd, sessionId, parentSessionId, agentNickname });
    }
  }
  return rememberMetadata(file, { cwd, sessionId, parentSessionId, agentNickname });
}

function walkRecentJsonlFiles(
  root: string,
  scope: TailDiscoveryScope,
): TranscriptFileStat[] {
  const cutoff = Date.now() - discoveryWindowMs(scope);
  const found: Array<{ path: string; mtimeMs: number; size: number }> = [];
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
      if (!entry.endsWith(".jsonl") || stats.mtimeMs < cutoff) continue;
      found.push({ path, mtimeMs: stats.mtimeMs, size: stats.size });
    }
  }
  return found;
}

/** The index is append-only: the last entry for an id wins. */
function readCodexTitles(): Map<string, string | null> {
  const titles = new Map<string, string | null>();
  for (const root of codexSessionRoots()) {
    try {
      for (const line of readFileSync(join(dirname(root), "session_index.jsonl"), "utf8").split("\n")) {
        const entry = parseJsonRecord(line);
        if (typeof entry?.id !== "string") continue;
        titles.set(entry.id, typeof entry.thread_name === "string" ? entry.thread_name.trim() || null : null);
      }
    } catch { /* Index absent or being replaced; transcripts still discoverable. */ }
  }
  return titles;
}

function discoverCodexTranscripts(scope: TailDiscoveryScope): DiscoveredTranscript[] {
  const titles = readCodexTitles();
  const byPath = new Map<string, TranscriptFileStat>();
  for (const root of codexSessionRoots()) {
    for (const file of walkRecentJsonlFiles(root, scope)) {
      const existing = byPath.get(file.path);
      if (!existing || file.mtimeMs > existing.mtimeMs) byPath.set(file.path, file);
    }
  }
  return [...byPath.values()]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, discoveryLimit(scope))
    .map((file) => codexTranscriptForFile(file, titles));
}

function codexTranscriptForFile(file: TranscriptFileStat, titles?: Map<string, string | null>): DiscoveredTranscript {
  const meta = readCodexMetadata(file);
  const sessionId = meta.sessionId
    ?? sessionIdFromCodexPath(file.path);
  return {
    source: SOURCE_NAME,
    transcriptPath: file.path,
    sessionId,
    parentSessionId: meta.parentSessionId ?? null,
    subagentId: meta.parentSessionId ? sessionId : null,
    agentNickname: meta.agentNickname ?? null,
    title: (titles ?? readCodexTitles()).get(sessionId) ?? null,
    cwd: meta.cwd,
    project: meta.cwd ? basename(meta.cwd) : "(unknown)",
    harness: "unattributed",
    mtimeMs: file.mtimeMs,
    size: file.size,
  };
}

function sessionIdFromCodexPath(filePath: string): string {
  const name = basename(filePath).replace(/\.jsonl$/, "");
  const match = name.match(/(019[0-9a-f-]+)$/);
  return match?.[1] ?? name;
}

function clip(text: string, max = MAX_SUMMARY_LEN): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function stringifyValue(value: unknown, max = MAX_SUMMARY_LEN): string {
  if (typeof value === "string") return clip(value, max);
  if (value == null) return "";
  try {
    return clip(JSON.stringify(value), max);
  } catch {
    return clip(String(value), max);
  }
}

function toolCallSummaries(ctx: TailContext): Map<string, string> | null {
  if (!ctx.state) return null;
  const existing = ctx.state[TOOL_CALL_STATE_KEY];
  if (existing instanceof Map) return existing as Map<string, string>;
  const next = new Map<string, string>();
  ctx.state[TOOL_CALL_STATE_KEY] = next;
  return next;
}

function rememberToolCall(ctx: TailContext, payload: Record<string, unknown>, summary: string): void {
  const callId = typeof payload.call_id === "string" && payload.call_id.trim()
    ? payload.call_id
    : null;
  if (!callId) return;
  const calls = toolCallSummaries(ctx);
  if (!calls) return;
  calls.delete(callId);
  calls.set(callId, summary);
  while (calls.size > TOOL_CALL_STATE_LIMIT) {
    const oldest = calls.keys().next().value;
    if (!oldest) break;
    calls.delete(oldest);
  }
}

function rememberedToolCall(ctx: TailContext, payload: Record<string, unknown>): string | null {
  const callId = typeof payload.call_id === "string" && payload.call_id.trim()
    ? payload.call_id
    : null;
  if (!callId) return null;
  return toolCallSummaries(ctx)?.get(callId) ?? null;
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

function stableIdPart(value: string): string {
  return value.trim().replace(/[\s\u0000-\u001f\u007f]+/gu, "_");
}

function codexEventIdSuffix(entryType: string, payloadType: string, payload: Record<string, unknown>, lineOffset: number): string {
  if (entryType === "response_item") {
    const payloadId = typeof payload.id === "string" ? stableIdPart(payload.id) : "";
    if (payloadId) return `response:${payloadType || "item"}:${payloadId}`;

    const callId = typeof payload.call_id === "string" ? stableIdPart(payload.call_id) : "";
    if (callId && (payloadType === "function_call_output" || payloadType === "custom_tool_call_output")) {
      return `response:${payloadType}:call:${callId}`;
    }
  }

  return `line:${lineOffset}`;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return clip(content);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const entry of content) {
    if (typeof entry === "string") {
      parts.push(entry);
      continue;
    }
    const record = metadataRecord(entry);
    if (!record) continue;
    if (typeof record.text === "string") parts.push(record.text);
    else if (typeof record.summary === "string") parts.push(record.summary);
    else if (typeof record.input_text === "string") parts.push(record.input_text);
  }
  return clip(parts.join("\n\n"));
}

function reasoningText(payload: Record<string, unknown>): string {
  return clip([textFromContent(payload.summary), textFromContent(payload.content)]
    .filter(Boolean)
    .join("\n\n"));
}

function completedItem(payload: Record<string, unknown>): Record<string, unknown> {
  return metadataRecord(payload.item) ?? payload;
}

function completedItemType(item: Record<string, unknown>): string {
  return String(item.type ?? item.kind ?? "").replace(/[_-]/gu, "").toLowerCase();
}

function codexKind(entryType: string, payloadType: string, payload: Record<string, unknown>): TailEventKind {
  if (entryType === "response_item") {
    if (payloadType === "message") {
      return payload.role === "user" ? "user" : payload.role === "assistant" ? "assistant" : "system";
    }
    if (payloadType === "function_call" || payloadType === "custom_tool_call" || payloadType === "web_search_call") {
      return "tool";
    }
    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
      return "tool-result";
    }
    if (payloadType === "reasoning") return "system";
  }
  if ((entryType === "event_msg" && payloadType === "item_completed") || entryType === "item_completed") {
    const type = completedItemType(completedItem(payload));
    if (type === "agentmessage") return "assistant";
    if (["commandexecution", "mcptoolcall", "filechange"].includes(type)) return "tool-result";
    return "system";
  }
  if (entryType === "event_msg") {
    if (payloadType.endsWith("_end")) return "tool-result";
    if (payloadType.endsWith("_start")) return "tool";
    return "system";
  }
  if (entryType === "session_meta" || entryType === "turn_context") return "system";
  return "other";
}

function summarizeCodex(entryType: string, payloadType: string, payload: Record<string, unknown>, ctx: TailContext): string {
  if (entryType === "session_meta") {
    const id = typeof payload.id === "string" ? payload.id : "";
    const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
    return clip(`session ${id}${cwd ? ` · ${cwd}` : ""}`);
  }
  if (entryType === "turn_context") {
    const model = typeof payload.model === "string" ? payload.model : "";
    const effort = typeof payload.effort === "string" ? payload.effort : "";
    return clip(`turn context${model ? ` · ${model}` : ""}${effort ? ` · ${effort}` : ""}`);
  }
  if ((entryType === "event_msg" && payloadType === "item_completed") || entryType === "item_completed") {
    const item = completedItem(payload);
    const type = completedItemType(item);
    if (type === "agentmessage") return textFromContent(item.content) || stringifyValue(item.text) || "[assistant]";
    if (type === "commandexecution") {
      const cmd = item.command ?? item.cmd ?? item.argv;
      return clip(formatToolResult(item.aggregated_output ?? item.output, Array.isArray(cmd) ? cmd.join(" ") : stringifyValue(cmd)));
    }
    if (type === "mcptoolcall") return clip(`${String(item.server ?? "mcp")} · ${String(item.tool ?? item.name ?? "tool")}`);
    if (type === "filechange") {
      const paths = Array.isArray(item.changes) ? item.changes.map((change) => metadataRecord(change)?.path).filter(Boolean) : [];
      return clip(`file change · ${paths.join(", ") || stringifyValue(item.paths)}`);
    }
    return clip(`[${String(item.type ?? item.kind ?? "item_completed")}]`);
  }
  if (entryType === "event_msg") {
    if (payloadType === "task_started") return "task started";
    if (payloadType === "task_complete") return "task complete";
    if (payloadType === "turn_aborted") return `turn aborted · ${stringifyValue(payload.reason)}`;
    if (payloadType === "token_count") {
      const info = metadataRecord(payload.info);
      const usage = metadataRecord(info?.total_token_usage);
      const total = usage?.total_tokens;
      return typeof total === "number" ? `tokens · ${total}` : "tokens";
    }
    if (payloadType.endsWith("_end")) {
      const command = Array.isArray(payload.command)
        ? payload.command.join(" ")
        : typeof payload.command === "string"
          ? payload.command
          : "";
      // Only append a command when there is a real one — otherwise the type
      // alone (no `type · type` echo).
      return command ? clip(`${payloadType} · ${command}`) : clip(payloadType);
    }
    return clip(payloadType || "event");
  }
  if (entryType === "response_item") {
    if (payloadType === "message") return textFromContent(payload.content) || `[${String(payload.role ?? "message")}]`;
    if (payloadType === "reasoning") return reasoningText(payload) || "[reasoning]";
    if (payloadType === "function_call") {
      const name = typeof payload.name === "string" ? payload.name : "function_call";
      const summary = clip(formatToolCall(name, payload.arguments));
      rememberToolCall(ctx, payload, summary);
      return summary;
    }
    if (payloadType === "custom_tool_call") {
      const name = typeof payload.name === "string" ? payload.name : "custom_tool_call";
      const summary = clip(formatToolCall(name, payload.input));
      rememberToolCall(ctx, payload, summary);
      return summary;
    }
    if (payloadType === "web_search_call") return "web_search";
    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
      return clip(formatToolResult(parseMaybeJson(payload.output), rememberedToolCall(ctx, payload)));
    }
    return clip(`[${payloadType || entryType}]`);
  }
  return clip(`[${entryType || "codex"}]`);
}

function parseCodexLine(line: string, ctx: TailContext): TailEvent | null {
  const record = parseJsonRecord(line.trim());
  if (!record) return null;
  const entryType = typeof record.type === "string" ? record.type : "other";
  const payload = metadataRecord(record.payload) ?? record;
  const payloadType = typeof payload.type === "string" ? payload.type : "";
  const sessionId = typeof payload.id === "string" && entryType === "session_meta"
    ? payload.id
    : ctx.transcript.sessionId
      ?? basename(ctx.transcriptPath).replace(/\.jsonl$/, "");
  const cwd = ctx.transcript.cwd ?? ctx.process.cwd ?? "";
  const summary = summarizeCodex(entryType, payloadType, payload, ctx);
  const idSuffix = codexEventIdSuffix(entryType, payloadType, payload, ctx.lineOffset);

  return {
    id: `${SOURCE_NAME}:${sessionId}:${idSuffix}`,
    ts: parseTimestamp(record.timestamp) ?? parseTimestamp(payload.timestamp) ?? Date.now(),
    source: SOURCE_NAME,
    sessionId,
    pid: ctx.process.pid,
    parentPid: ctx.process.ppid || null,
    project: cwd ? basename(cwd) : ctx.transcript.project,
    cwd,
    harness: ctx.process.harness,
    kind: codexKind(entryType, payloadType, payload),
    summary: summary || `[${entryType}]`,
    raw: record,
  };
}

export const CodexSource: TranscriptSource = {
  name: SOURCE_NAME,
  discoverProcesses(): Promise<DiscoveredProcess[]> {
    return discoverCodexProcesses();
  },
  discoverTranscripts(_processes: DiscoveredProcess[], scope: TailDiscoveryScope = "shallow"): DiscoveredTranscript[] {
    return discoverCodexTranscripts(scope);
  },
  parseLine(line: string, ctx: TailContext): TailEvent | null {
    return parseCodexLine(line, ctx);
  },
};
