import { claudeProjectForPath, claudeProjectRoots } from "../claude-projects.js";
import { stripHarnessBoilerplate, stripHarnessValue } from "./boilerplate.js";
import { knowledgeIndexEnabled, KNOWLEDGE_INDEX_OFF } from "./settings.js";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { open, opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";

import {
  deterministicKnowledgeChunkId,
  SQLiteKnowledgeStore,
} from "./store.js";
import { knowledgeCollectionQmdPath, resolveOpenScoutKnowledgePaths } from "./paths.js";
import type {
  KnowledgeChunk,
  KnowledgeCollection,
  KnowledgeDocument,
  KnowledgeFacets,
  KnowledgeIndexJob,
  KnowledgePortablePath,
  KnowledgeSearchHit,
  KnowledgeSourceRef,
} from "./types.js";

export interface IndexRecentSessionKnowledgeInput {
  /** Lookback window in whole days (default 3). Ignored when `hours` is set. */
  days?: number;
  /** Lookback window in hours. Takes precedence over `days` when provided. */
  hours?: number;
  limit?: number;
  force?: boolean;
  /** Restrict indexing to one or more harnesses (codex, claude, kimi, …). */
  harness?: string | string[];
}

export interface IndexedSessionKnowledgeSummary {
  collectionId: string;
  title: string;
  harness: string;
  project: string;
  transcriptPath: string;
  qmdPath: string;
  records: number;
  documents: number;
  chunks: number;
  bytes: number;
  mtimeMs: number;
  skipped?: boolean;
  error?: string;
}

export interface IndexRecentSessionKnowledgeResult {
  enabled?: boolean;
  message?: string;
  job: KnowledgeIndexJob;
  days: number;
  hours?: number;
  discovered: number;
  indexed: number;
  failed: number;
  sessions: IndexedSessionKnowledgeSummary[];
}

type Harness = "codex" | "claude" | "kimi";

type SessionFile = {
  harness: Harness;
  path: string;
  mtimeMs: number;
  size: number;
};

type NormalizedKind =
  | "session_meta"
  | "user_turn"
  | "assistant_turn"
  | "command_or_tool"
  | "observation"
  | "system_record"
  | "unknown";

type NormalizedRecord = {
  i: number;
  ts?: string;
  kind: NormalizedKind;
  tag?: string;
  text?: string;
  tool?: { name: string; input: unknown };
  result?: { ok?: boolean; output: unknown };
  meta?: Record<string, unknown>;
  refs?: { id?: string; parentId?: string; sessionId?: string };
  sourceType: string;
  sourceOffset: number;
};

type ParseResult = {
  harness: Harness;
  records: NormalizedRecord[];
  scannedLines: number;
  bytesRead: number;
  contentHash: string;
  cwd: string | null;
  sessionId: string | null;
};

type ExtractedDocument = {
  path: string;
  kind: string;
  content: string;
  sourceRef: KnowledgeSourceRef;
  facets?: KnowledgeFacets;
};

const EXTRACTOR_VERSION = "session-qmd-v4";
const CHUNK_POLICY_VERSION = "session-qmd-record-window-v2";
const EVENT_WINDOW_RECORDS = 350;
const EVENT_CHUNK_RECORDS = 50;
const DEFAULT_DAYS = 3;
const DEFAULT_LIMIT = 220;
const KNOWN_HARNESSES: readonly Harness[] = ["codex", "claude", "kimi"];

function clampPositiveInt(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.floor(value));
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Time-budgeted yield for long synchronous loops (JSON.parse over hundreds of
 * MB, per-record summarization). Keeps the hosting server's event loop
 * responsive instead of blocking it for the duration of a large transcript.
 */
function createYieldBudget(intervalMs = 12): () => Promise<void> {
  let last = Date.now();
  return async () => {
    const now = Date.now();
    if (now - last >= intervalMs) {
      await yieldToEventLoop();
      last = Date.now();
    }
  };
}

function normalizeHarnessFilter(value: string | string[] | undefined): Set<Harness> | null {
  if (value == null) return null;
  const raw = Array.isArray(value) ? value : [value];
  const selected = new Set<Harness>();
  for (const entry of raw) {
    const key = entry.trim().toLowerCase();
    if (!key) continue;
    if ((KNOWN_HARNESSES as readonly string[]).includes(key)) {
      selected.add(key as Harness);
    }
  }
  return selected.size > 0 ? selected : null;
}

function sessionRoots(harnessFilter: Set<Harness> | null): Array<{ harness: Harness; root: string }> {
  const home = homedir();
  const kimiHome = process.env.KIMI_CODE_HOME?.trim() || join(home, ".kimi-code");
  const roots: Array<{ harness: Harness; root: string }> = [
    { harness: "codex", root: process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT ?? join(home, ".codex", "sessions") },
    { harness: "codex", root: join(home, ".openai-codex", "sessions") },
    ...claudeProjectRoots(home).map(({ root }) => ({ harness: "claude" as const, root })),
    { harness: "kimi", root: process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT ?? join(kimiHome, "sessions") },
  ];
  return roots.filter((entry, index, entries) =>
    existsSync(entry.root)
    && (harnessFilter == null || harnessFilter.has(entry.harness))
    && entries.findIndex((candidate) => candidate.harness === entry.harness && candidate.root === entry.root) === index
  );
}

function isHarnessTranscriptFile(harness: Harness, entry: string): boolean {
  // Kimi stores many JSONL-adjacent artifacts; only wire.jsonl is the transcript spine.
  if (harness === "kimi") return entry === "wire.jsonl";
  return entry.endsWith(".jsonl");
}

function resolveLookbackMs(input: IndexRecentSessionKnowledgeInput): { cutoffMs: number; days: number; hours?: number } {
  // Harmonized max window: 30 days either via --days or --hours.
  const maxHours = 30 * 24;
  if (typeof input.hours === "number" && Number.isFinite(input.hours) && input.hours > 0) {
    const hours = Math.min(maxHours, Math.floor(input.hours));
    return {
      cutoffMs: Date.now() - hours * 60 * 60 * 1000,
      days: Math.max(1, Math.ceil(hours / 24)),
      hours,
    };
  }
  const days = clampPositiveInt(input.days, DEFAULT_DAYS, 30);
  return {
    cutoffMs: Date.now() - days * 24 * 60 * 60 * 1000,
    days,
  };
}

function discoverRecentSessionFiles(
  cutoffMs: number,
  limit: number,
  harnessFilter: Set<Harness> | null,
): SessionFile[] {
  const files: SessionFile[] = [];
  for (const { harness, root } of sessionRoots(harnessFilter)) {
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
        if (!isHarnessTranscriptFile(harness, entry) || stats.mtimeMs < cutoffMs) continue;
        files.push({ harness, path, mtimeMs: stats.mtimeMs, size: stats.size });
      }
    }
  }
  return files
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit);
}

async function parseJsonl(file: SessionFile): Promise<ParseResult> {
  const maybeYield = createYieldBudget();
  const records: NormalizedRecord[] = [];
  const hash = createHash("sha256");
  let carry = "";
  let offset = 0;
  let index = 0;
  let cwd: string | null = null;
  let sessionId: string | null = null;

  if (file.harness === "kimi") {
    const state = readKimiSessionState(file.path);
    cwd = state.cwd;
    sessionId = state.sessionId;
  }

  const handleLine = (rawLine: string) => {
    const lineOffset = offset;
    offset += Buffer.byteLength(rawLine, "utf8") + 1;
    if (!rawLine.trim()) return;
    try {
      const value = JSON.parse(rawLine) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        records.push({
          i: index++,
          kind: "unknown",
          sourceType: "non_object",
          sourceOffset: lineOffset,
        });
        return;
      }
      const record = normalizeRecord(value as Record<string, unknown>, index, lineOffset, file.harness);
      if (record.text !== undefined) record.text = stripHarnessBoilerplate(record.text);
      if (record.tool) record.tool.input = stripHarnessValue(record.tool.input);
      if (record.result) record.result.output = stripHarnessValue(record.result.output);
      if (record.meta) record.meta = stripHarnessValue(record.meta) as Record<string, unknown>;
      // Keep source record numbers/offsets, but omit harness instructions from
      // every derived document, facet, title and FTS entry.
      if (record.kind !== "system_record" && !(record.text === "" && ["user_turn", "assistant_turn"].includes(record.kind))) records.push(record);
      cwd ??= inferCwd(record);
      sessionId ??= inferSessionId(record, file);
      index++;
    } catch {
      records.push({
        i: index++,
        kind: "unknown",
        sourceType: "unparseable",
        sourceOffset: lineOffset,
      });
    }
  };

  for await (const chunk of createReadStream(file.path, { encoding: "utf8" })) {
    hash.update(chunk);
    carry += chunk;
    const lines = carry.split(/\r?\n/u);
    carry = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
    await maybeYield();
  }
  if (carry.length > 0) handleLine(carry);

  return {
    harness: file.harness,
    records,
    scannedLines: index,
    bytesRead: offset,
    contentHash: `sha256:${hash.digest("hex")}`,
    cwd,
    sessionId,
  };
}

function normalizeRecord(
  obj: Record<string, unknown>,
  i: number,
  sourceOffset: number,
  harness: Harness,
): NormalizedRecord {
  if (harness === "codex") return normalizeCodex(obj, i, sourceOffset);
  if (harness === "claude") return normalizeClaude(obj, i, sourceOffset);
  return normalizeKimi(obj, i, sourceOffset);
}

function normalizeCodex(
  obj: Record<string, unknown>,
  i: number,
  sourceOffset: number,
): NormalizedRecord {
  const type = String(obj.type ?? "");
  const ts = typeof obj.timestamp === "string" ? obj.timestamp : undefined;
  const payload = recordValue(obj.payload) ?? {};
  const base = { i, ts, sourceType: type, sourceOffset };

  if (type === "session_meta") {
    return {
      ...base,
      kind: "session_meta",
      tag: "meta",
      meta: payload,
      refs: { sessionId: stringValue(payload.id) },
    };
  }
  if (type === "turn_context") {
    return { ...base, kind: "system_record", tag: "turn_context", meta: payload };
  }
  if (type === "response_item") return normalizeCodexInner(payload, base);
  if (type === "event_msg") return normalizeCodexEvent(payload, base);
  if (type === "message") return normalizeCodexMessage(payload, base);
  if (type === "function_call" || type === "local_shell_call") return normalizeCodexTool(payload, base);
  if (type === "function_call_output" || type === "local_shell_call_output") return normalizeCodexResult(payload, base);
  if (type === "reasoning") return normalizeCodexReasoning(payload, base);
  return { ...base, kind: "system_record", tag: type || "record", text: compactJson(payload) };
}

type CodexBase = { i: number; ts?: string; sourceType: string; sourceOffset: number };

function normalizeCodexInner(payload: Record<string, unknown>, base: CodexBase): NormalizedRecord {
  const type = String(payload.type ?? "");
  if (type === "message") return normalizeCodexMessage(payload, base);
  if (type === "reasoning") return normalizeCodexReasoning(payload, base);
  if (type === "function_call" || type === "local_shell_call") return normalizeCodexTool(payload, base);
  if (type === "function_call_output" || type === "local_shell_call_output") return normalizeCodexResult(payload, base);
  return { ...base, kind: "system_record", tag: type || "response_item", meta: payload };
}

function normalizeCodexEvent(payload: Record<string, unknown>, base: CodexBase): NormalizedRecord {
  const type = String(payload.type ?? "");
  if (type === "user_message") {
    return { ...base, kind: "user_turn", tag: "user", text: String(payload.message ?? payload.text ?? "") };
  }
  if (type === "agent_message") {
    return { ...base, kind: "assistant_turn", tag: "assistant", text: String(payload.message ?? payload.text ?? "") };
  }
  return { ...base, kind: "system_record", tag: type || "event_msg", meta: payload };
}

function normalizeCodexMessage(payload: Record<string, unknown>, base: CodexBase): NormalizedRecord {
  const role = String(payload.role ?? "");
  const text = extractText(payload.content);
  if (role === "user") return { ...base, kind: "user_turn", tag: "user", text };
  if (role === "assistant") return { ...base, kind: "assistant_turn", tag: "assistant", text };
  return { ...base, kind: "system_record", tag: role || "message", text };
}

function normalizeCodexTool(payload: Record<string, unknown>, base: CodexBase): NormalizedRecord {
  const name = String(payload.name ?? payload.command ?? "tool");
  const input = payload.arguments ?? payload.args ?? payload.input ?? {};
  return { ...base, kind: "command_or_tool", tag: name, tool: { name, input } };
}

function normalizeCodexResult(payload: Record<string, unknown>, base: CodexBase): NormalizedRecord {
  return { ...base, kind: "observation", tag: "result", result: { output: payload.output ?? payload.content ?? "" } };
}

function normalizeCodexReasoning(payload: Record<string, unknown>, base: CodexBase): NormalizedRecord {
  let text = "";
  if (Array.isArray(payload.summary)) {
    text = payload.summary
      .map((entry) => recordValue(entry)?.text)
      .filter((entry): entry is string => typeof entry === "string")
      .join(" ");
  }
  return { ...base, kind: "assistant_turn", tag: "reasoning", text: text || stringValue(payload.content) || "" };
}

function normalizeClaude(
  obj: Record<string, unknown>,
  i: number,
  sourceOffset: number,
): NormalizedRecord {
  const type = String(obj.type ?? "");
  const ts = typeof obj.timestamp === "string" ? obj.timestamp : undefined;
  const refs = {
    id: stringValue(obj.uuid),
    parentId: stringValue(obj.parentUuid),
    sessionId: stringValue(obj.sessionId) ?? stringValue(obj.session_id),
  };
  const base = { i, ts, sourceType: type, sourceOffset, refs };

  if (type === "user") {
    const message = recordValue(obj.message);
    return { ...base, kind: "user_turn", tag: "user", text: extractText(message?.content ?? obj.content) };
  }
  if (type === "assistant") {
    const message = recordValue(obj.message);
    const content = message?.content ?? obj.content;
    const tool = Array.isArray(content)
      ? content.map(recordValue).find((entry) => entry?.type === "tool_use")
      : null;
    if (tool) {
      const name = String(tool.name ?? "tool");
      return {
        ...base,
        kind: "command_or_tool",
        tag: name,
        sourceType: "tool_use",
        tool: { name, input: tool.input ?? {} },
      };
    }
    return { ...base, kind: "assistant_turn", tag: "assistant", text: extractText(content) };
  }
  if (type === "tool_use") {
    const name = String(obj.name ?? "tool");
    return { ...base, kind: "command_or_tool", tag: name, tool: { name, input: obj.input ?? {} } };
  }
  if (type === "tool_result") {
    return { ...base, kind: "observation", tag: "result", result: { output: obj.content ?? "" } };
  }
  if (type === "system") {
    return { ...base, kind: "system_record", tag: "system", text: extractText(obj.content) };
  }
  return { ...base, kind: "system_record", tag: type || "record", meta: obj };
}

function kimiTimestamp(obj: Record<string, unknown>): string | undefined {
  const raw = obj.time ?? obj.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    return new Date(ms).toISOString();
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : raw;
  }
  return undefined;
}

/**
 * Normalize Kimi Code wire.jsonl records into the same mechanical record kinds
 * used for Codex/Claude. Wire format is event-oriented; only conversational and
 * tool spine events become searchable content.
 */
function normalizeKimi(
  obj: Record<string, unknown>,
  i: number,
  sourceOffset: number,
): NormalizedRecord {
  const type = String(obj.type ?? "");
  const ts = kimiTimestamp(obj);
  const base = { i, ts, sourceType: type, sourceOffset };

  if (type === "turn.prompt" || type === "turn.steer") {
    return {
      ...base,
      kind: "user_turn",
      tag: type === "turn.steer" ? "steer" : "user",
      text: extractText(obj.input ?? obj.content),
    };
  }

  if (type === "context.append_message") {
    const message = recordValue(obj.message) ?? {};
    const role = String(message.role ?? "");
    const text = extractText(message.content);
    if (role === "assistant") return { ...base, kind: "assistant_turn", tag: "assistant", text };
    return { ...base, kind: "user_turn", tag: role || "user", text };
  }

  if (type === "context.append_loop_event") {
    const event = recordValue(obj.event) ?? {};
    const eventType = String(event.type ?? "");
    const eventBase = {
      ...base,
      sourceType: eventType || type,
      refs: {
        id: stringValue(event.uuid) ?? stringValue(event.toolCallId),
        parentId: stringValue(event.parentUuid),
      },
    };

    if (eventType === "tool.call") {
      const name = String(event.name ?? "tool");
      return {
        ...eventBase,
        kind: "command_or_tool",
        tag: name,
        tool: { name, input: event.args ?? event.input ?? {} },
      };
    }
    if (eventType === "tool.result") {
      const result = recordValue(event.result) ?? {};
      return {
        ...eventBase,
        kind: "observation",
        tag: "result",
        result: { output: result.output ?? result.content ?? event.result ?? "" },
        refs: {
          ...eventBase.refs,
          id: stringValue(event.toolCallId) ?? eventBase.refs.id,
          parentId: stringValue(event.parentUuid),
        },
      };
    }
    if (eventType === "content.part") {
      const part = recordValue(event.part) ?? {};
      if (part.type === "text" && typeof part.text === "string") {
        return { ...eventBase, kind: "assistant_turn", tag: "assistant", text: part.text };
      }
      // Deliberate: do not index full reasoning text into the durable search corpus.
      // Keep a tag-only system marker so event windows stay bounded and observed.
      if (part.type === "think") {
        return { ...eventBase, kind: "system_record", tag: "think" };
      }
      return { ...eventBase, kind: "system_record", tag: eventType || "part", meta: event };
    }
    return { ...eventBase, kind: "system_record", tag: eventType || "loop_event", meta: event };
  }

  if (type === "metadata" || type === "config.update") {
    return { ...base, kind: "session_meta", tag: "meta", meta: obj };
  }

  // High-churn transport records (llm.request, usage, mcp discovery) are not
  // useful as session knowledge; keep a thin system placeholder.
  return { ...base, kind: "system_record", tag: type || "record", meta: obj };
}

function readKimiSessionState(wirePath: string): { cwd: string | null; sessionId: string | null; title: string | null } {
  // .../session_<id>/agents/<agentId>/wire.jsonl
  const agentId = basename(dirname(wirePath));
  const sessionDirectory = dirname(dirname(dirname(wirePath)));
  const parentSessionId = basename(sessionDirectory);
  const sessionId = agentId === "main" ? parentSessionId : `${parentSessionId}:${agentId}`;
  let cwd: string | null = null;
  let title: string | null = null;
  try {
    const state = recordValue(JSON.parse(readFileSync(join(sessionDirectory, "state.json"), "utf8")));
    // Kimi state v2 renamed `workDir` to `cwd`; both shapes remain on disk.
    cwd = stringValue(state?.cwd) ?? stringValue(state?.workDir) ?? null;
    title = stringValue(state?.title) ?? null;
  } catch {
    // state.json may lag a freshly created wire file
  }
  return { cwd, sessionId, title };
}

function inferCwd(record: NormalizedRecord): string | null {
  const meta = record.meta;
  const cwd = stringValue(meta?.cwd) ?? stringValue(meta?.workDir);
  return cwd && cwd.trim() ? cwd : null;
}

function inferSessionId(record: NormalizedRecord, file: SessionFile): string | null {
  if (file.harness === "kimi") {
    return readKimiSessionState(file.path).sessionId;
  }
  return record.refs?.sessionId
    ?? stringValue(record.meta?.id)
    ?? stringValue(record.meta?.sessionId)
    ?? basename(file.path).replace(/\.jsonl$/u, "");
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const block = recordValue(entry);
      if (!block) return "";
      if (typeof block.text === "string") return block.text;
      if (typeof block.content === "string") return block.content;
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function trimOneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 3))}...`;
}

function hashText(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableId(value: string, length = 16): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function portablePath(filePath: string): KnowledgePortablePath {
  const home = homedir();
  const paths = resolveOpenScoutKnowledgePaths();
  const roots: Array<{ root: KnowledgePortablePath["root"]; path: string }> = [
    { root: "OPENSCOUT_CONTROL_HOME", path: paths.knowledgeRoot.replace(new RegExp(`${sep}knowledge$`), "") },
    { root: "HOME", path: home },
  ];
  for (const root of roots) {
    const rel = relative(root.path, filePath);
    if (rel && !rel.startsWith("..") && !rel.startsWith(sep)) {
      return { root: root.root, relPath: rel };
    }
  }
  return { root: "ABSOLUTE", relPath: filePath };
}

function sourceRefFor(file: SessionFile, parse: ParseResult, range?: [number, number]): KnowledgeSourceRef {
  return {
    kind: "harness_transcript",
    harness: file.harness,
    path: portablePath(file.path),
    sessionId: parse.sessionId ?? undefined,
    recordRange: range,
    anchor: {
      sizeBytes: file.size,
      mtimeMs: file.mtimeMs,
      contentHash: parse.contentHash,
    },
  };
}

function sourceRefWithRecordRange(ref: KnowledgeSourceRef, range: [number, number]): KnowledgeSourceRef {
  return ref.kind === "harness_transcript" ? { ...ref, recordRange: range } : ref;
}

function projectName(cwd: string | null, file: SessionFile): string {
  const claude = file.harness === "claude" ? claudeProjectForPath(file.path) : undefined;
  if (claude?.mirror) return claude.folder;
  if (cwd) return basename(cwd);
  if (claude) return claude.folder.replace(/^-/, "").split("-").filter(Boolean).pop() || "claude";
  return basename(file.path).replace(/\.jsonl$/u, "");
}

function titleFor(file: SessionFile, parse: ParseResult, project: string): string {
  const date = new Date(file.mtimeMs).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  // Kimi (and any future harness) may expose a durable session title in state;
  // prefer it over reconstructing from the first user turn.
  if (file.harness === "kimi") {
    const stateTitle = readKimiSessionState(file.path).title;
    if (stateTitle) {
      return `${capitalize(file.harness)} ${project} ${date} - ${trimOneLine(stripHarnessBoilerplate(stateTitle), 82)}`;
    }
  }
  const firstUser = parse.records.find((record) => record.kind === "user_turn" && record.text?.trim());
  const goal = firstUser?.text ? ` - ${trimOneLine(firstUser.text, 82)}` : "";
  return `${capitalize(file.harness)} ${project} ${date}${goal}`;
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function extractPaths(input: unknown): string[] {
  if (input == null) return [];
  if (typeof input === "string") {
    try {
      return extractPaths(JSON.parse(input));
    } catch {
      const matches = input.match(/(?:\.\/|\.\.\/|~\/|\/)[\w./~_\-+]+\.[\w]+/gu);
      return matches ?? [];
    }
  }
  if (typeof input !== "object" || Array.isArray(input)) return [];
  const obj = input as Record<string, unknown>;
  const paths = new Set<string>();
  for (const key of ["path", "file_path", "filePath", "filename", "filenames"]) {
    const value = obj[key];
    if (typeof value === "string") paths.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) if (typeof entry === "string") paths.add(entry);
    }
  }
  const command = obj.command ?? obj.cmd;
  if (typeof command === "string") {
    const matches = command.match(/(?:\.\/|\.\.\/|~\/|\/)[\w./~_\-+]+\.[\w]+/gu);
    if (matches) for (const match of matches) paths.add(match);
  }
  return [...paths];
}

function oneLineInput(input: unknown): string {
  const text = typeof input === "string" ? input : compactJson(input ?? {});
  return trimOneLine(text, 120);
}

function uniqueFacetValues(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = trimmed; // Facet equality is exact; case-distinct source paths must survive.
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function touchedPaths(records: NormalizedRecord[]): string[] {
  return uniqueFacetValues(records.flatMap((record) =>
    record.tool ? extractPaths(record.tool.input) : []
  ));
}

function recordFacets(records: NormalizedRecord[]): KnowledgeFacets {
  const facets: KnowledgeFacets = {};
  const kinds = uniqueFacetValues(records.map((record) => record.kind));
  const tags = uniqueFacetValues(records.map((record) => record.tag));
  const tools = uniqueFacetValues(records.map((record) => record.tool?.name));
  const paths = touchedPaths(records);

  if (kinds.length > 0) facets.recordKind = kinds;
  if (tags.length > 0) facets.recordTag = tags;
  if (tools.length > 0) facets.toolName = tools;
  if (paths.length > 0) facets.touchedPath = paths;
  return facets;
}

function documentFacets(kind: string, records: NormalizedRecord[]): KnowledgeFacets {
  return {
    documentKind: kind,
    ...recordFacets(records),
  };
}

function summarizeRecord(record: NormalizedRecord): string {
  if (record.text) return trimOneLine(record.text, 180);
  if (record.tool) return `name=${record.tool.name} input=${oneLineInput(record.tool.input)}`;
  if (record.result) {
    const output = typeof record.result.output === "string"
      ? record.result.output
      : compactJson(record.result.output ?? "");
    return trimOneLine(output, 180);
  }
  if (record.meta) return trimOneLine(compactJson(record.meta), 180);
  return "";
}

function buildOverview(parse: ParseResult, file: SessionFile, project: string, title: string): string {
  const userTurns = parse.records.filter((record) => record.kind === "user_turn" && record.text?.trim());
  const assistantTurns = parse.records.filter((record) => record.kind === "assistant_turn" && record.text?.trim());
  const tools = parse.records.filter((record) => record.kind === "command_or_tool");
  const firstUser = userTurns[0]?.text ? trimOneLine(userTurns[0].text, 700) : "No user turn text detected.";
  const latestAssistant = assistantTurns.at(-1)?.text ? trimOneLine(assistantTurns.at(-1)!.text!, 700) : "No assistant text detected.";
  const modified = new Date(file.mtimeMs).toISOString();
  return [
    `# ${title}`,
    "",
    `Source: ${file.harness} transcript ${file.path}`,
    `Project: ${project}`,
    `Modified: ${modified}`,
    "",
    "## Session Frame",
    "",
    firstUser,
    "",
    "## Latest Assistant Context",
    "",
    latestAssistant,
    "",
    "## Mechanical Summary",
    "",
    `- Records: ${parse.records.length}`,
    `- User turns: ${userTurns.length}`,
    `- Assistant turns: ${assistantTurns.length}`,
    `- Tool calls: ${tools.length}`,
    `- Raw size: ${file.size} bytes`,
    "",
  ].join("\n");
}

function buildFiles(parse: ParseResult): string {
  const counts = new Map<string, number>();
  const tools = new Map<string, Set<string>>();
  for (const record of parse.records) {
    if (record.kind !== "command_or_tool" || !record.tool) continue;
    for (const path of extractPaths(record.tool.input)) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
      const names = tools.get(path) ?? new Set<string>();
      names.add(record.tool.name);
      tools.set(path, names);
    }
  }
  const rows = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  const lines = [
    "# Files touched",
    "",
    `Distinct paths: ${rows.length}.`,
    "",
    "| path | hits | tools |",
    "| --- | ---: | --- |",
  ];
  for (const [path, hits] of rows) {
    lines.push(`| \`${path}\` | ${hits} | ${[...(tools.get(path) ?? [])].sort().join(", ")} |`);
  }
  if (rows.length === 0) lines.push("| _no paths detected_ | 0 |  |");
  return `${lines.join("\n")}\n`;
}

function buildToolCalls(parse: ParseResult): string {
  const calls = parse.records.filter((record) => record.kind === "command_or_tool" && record.tool);
  const byName = new Map<string, number>();
  for (const call of calls) byName.set(call.tool!.name, (byName.get(call.tool!.name) ?? 0) + 1);
  const lines = [
    "# Tool calls",
    "",
    `Total calls: ${calls.length}.`,
    "",
    "## By tool",
    "",
    "| tool | calls |",
    "| --- | ---: |",
  ];
  for (const [name, count] of [...byName.entries()].sort((left, right) => right[1] - left[1])) {
    lines.push(`| \`${name}\` | ${count} |`);
  }
  lines.push("", "## Sample", "");
  for (const call of calls.slice(0, 80)) {
    lines.push(`- [${String(call.i).padStart(4, "0")}] \`${call.tool!.name}\` ${oneLineInput(call.tool!.input)}`);
  }
  return `${lines.join("\n")}\n`;
}

async function buildEventDocuments(parse: ParseResult, file: SessionFile): Promise<ExtractedDocument[]> {
  const maybeYield = createYieldBudget();
  const docs: ExtractedDocument[] = [];
  for (let start = 0; start < parse.records.length; start += EVENT_WINDOW_RECORDS) {
    const slice = parse.records.slice(start, start + EVENT_WINDOW_RECORDS);
    const index = String(Math.floor(start / EVENT_WINDOW_RECORDS) + 1).padStart(3, "0");
    const first = slice[0]?.i ?? start;
    const last = slice.at(-1)?.i ?? first;
    const sourceRef = sourceRefFor(file, parse, [first, last]);
    const lines = [
      `# Events window ${index}`,
      "",
      `Source: ${file.path}`,
      `Records: ${first}..${last}`,
      "",
    ];
    for (const record of slice) {
      lines.push(`- [${String(record.i).padStart(4, "0")}] \`${record.kind}\` (${record.tag ?? record.sourceType}) - ${summarizeRecord(record)}`);
    }
    docs.push({
      path: `events-${index}.md`,
      kind: "events",
      content: `${lines.join("\n")}\n`,
      sourceRef,
      facets: documentFacets("events", slice),
    });
    await maybeYield();
  }
  return docs;
}

async function buildDocuments(parse: ParseResult, file: SessionFile, project: string, title: string): Promise<ExtractedDocument[]> {
  const allSourceRef = sourceRefFor(file, parse, parse.records.length > 0 ? [0, parse.records.at(-1)!.i] : undefined);
  const toolRecords = parse.records.filter((record) => record.kind === "command_or_tool");
  return [
    {
      path: "overview.md",
      kind: "overview",
      content: buildOverview(parse, file, project, title),
      sourceRef: allSourceRef,
      facets: documentFacets("overview", parse.records),
    },
    {
      path: "files.md",
      kind: "files",
      content: buildFiles(parse),
      sourceRef: allSourceRef,
      facets: {
        documentKind: "files",
        ...(touchedPaths(parse.records).length > 0 ? { touchedPath: touchedPaths(parse.records) } : {}),
      },
    },
    {
      path: "tool-calls.md",
      kind: "tool-calls",
      content: buildToolCalls(parse),
      sourceRef: allSourceRef,
      facets: documentFacets("tool-calls", toolRecords),
    },
    ...await buildEventDocuments(parse, file),
  ];
}

function chunkDocument(document: ExtractedDocument): Array<{ text: string; sourceRef: KnowledgeSourceRef }> {
  if (document.kind !== "events") {
    return splitMarkdownSections(document.content).map((text) => ({ text, sourceRef: document.sourceRef }));
  }
  const lines = document.content.split("\n");
  const chunks: Array<{ text: string; sourceRef: KnowledgeSourceRef }> = [];
  let header: string[] = [];
  let current: { first: number; last: number; records: number; lines: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const text = current.lines.join("\n").trim();
    if (text) {
      chunks.push({
        text,
        sourceRef: sourceRefWithRecordRange(document.sourceRef, [current.first, current.last]),
      });
    }
    current = null;
  };
  for (const line of lines) {
    const match = /^- \[(\d+)\]/u.exec(line);
    if (!match) {
      if (current) current.lines.push(line);
      else if (line.trim()) header.push(line);
      continue;
    }
    const record = Number(match[1]);
    if (!current || current.records >= EVENT_CHUNK_RECORDS) {
      flush();
      current = {
        first: record,
        last: record,
        records: 1,
        lines: header.length > 0 ? [...header, "", line] : [line],
      };
      header = [];
    } else {
      current.last = record;
      current.records++;
      current.lines.push(line);
    }
  }
  flush();
  return chunks.length > 0 ? chunks : [{ text: document.content, sourceRef: document.sourceRef }];
}

function splitMarkdownSections(content: string): string[] {
  const lines = content.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const text = current.join("\n").trim();
    if (text) chunks.push(text);
    current = [];
  };
  for (const line of lines) {
    if (line.startsWith("## ") && current.length > 0) flush();
    current.push(line);
  }
  flush();
  return chunks;
}

function qmdCollectionFiles(
  collection: KnowledgeCollection,
  documents: ExtractedDocument[],
  parse: ParseResult,
  file: SessionFile,
): Record<string, string> {
  const manifest = {
    schema: "openscout.knowledge.collection/v1",
    collectionId: collection.id,
    kind: collection.kind,
    title: collection.title,
    generator: {
      extractorVersion: collection.extractorVersion,
      generatedAt: new Date(collection.updatedAt).toISOString(),
    },
    source: {
      kind: "harness_transcript",
      harness: file.harness,
      ref: portablePath(file.path),
      sessionId: parse.sessionId,
      sizeBytes: file.size,
      mtimeMs: file.mtimeMs,
      contentHash: parse.contentHash,
      recordsScanned: parse.records.length,
    },
    chunking: {
      events: {
        strategy: "record-window",
        window: EVENT_WINDOW_RECORDS,
        chunkRecords: EVENT_CHUNK_RECORDS,
        version: CHUNK_POLICY_VERSION,
      },
    },
    documents: documents.map((document) => ({
      path: document.path,
      kind: document.kind,
      origin: "mechanical",
      bytes: Buffer.byteLength(document.content, "utf8"),
      contentHash: hashText(document.content),
    })),
    facets: collection.facets,
    ownership: "derived",
    contentHash: collection.contentHash,
    status: collection.status,
  };

  return {
    "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    ...Object.fromEntries(documents.map((document) => [document.path, document.content])),
  };
}

function collectionContentHash(file: SessionFile, parse: ParseResult): string {
  return hashText([
    EXTRACTOR_VERSION,
    CHUNK_POLICY_VERSION,
    file.harness,
    file.path,
    file.mtimeMs,
    file.size,
    parse.contentHash,
  ].join("\0"));
}

function collectionIdFor(file: SessionFile, parse: ParseResult): string {
  const sessionPart = parse.sessionId
    ? parse.sessionId.replace(/[^A-Za-z0-9_.-]+/gu, "-").slice(0, 80)
    : stableId(file.path);
  return `sessions/${file.harness}/${sessionPart}-${stableId(file.path, 10)}`;
}

function documentId(collectionId: string, path: string): string {
  return hashText(`${collectionId}\0${path}`);
}

async function storeSessionCollection(
  store: SQLiteKnowledgeStore,
  file: SessionFile,
  parse: ParseResult,
  force: boolean,
): Promise<IndexedSessionKnowledgeSummary> {
  const project = projectName(parse.cwd, file);
  const id = collectionIdFor(file, parse);
  const qmdPath = knowledgeCollectionQmdPath(id);
  const title = titleFor(file, parse, project);
  const sourceRef = sourceRefFor(file, parse, parse.records.length > 0 ? [0, parse.records.at(-1)!.i] : undefined);
  const facets: KnowledgeFacets = {
    harness: file.harness,
    project,
    // Full path so same basenames in different roots do not collide.
    ...(parse.cwd ? { projectPath: parse.cwd } : {}),
    source: "sessions",
    transcriptPath: file.path,
    sessionId: parse.sessionId ?? "",
    ...recordFacets(parse.records),
  };
  const now = Date.now();
  const collection: KnowledgeCollection = {
    id,
    kind: "sessions",
    title,
    sourceRefs: [sourceRef],
    qmdPath,
    status: "ready",
    contentHash: collectionContentHash(file, parse),
    extractorVersion: EXTRACTOR_VERSION,
    chunkPolicyVersion: CHUNK_POLICY_VERSION,
    createdAt: now,
    updatedAt: now,
    facets,
  };
  const existing = store.getCollection(id);
  if (!force && existing?.status === "ready" && existing.contentHash === collection.contentHash
    && existing.extractorVersion === EXTRACTOR_VERSION && existing.chunkPolicyVersion === CHUNK_POLICY_VERSION) {
    return {
      collectionId: id,
      title,
      harness: file.harness,
      project,
      transcriptPath: file.path,
      qmdPath,
      records: parse.records.length,
      documents: 0,
      chunks: 0,
      bytes: file.size,
      mtimeMs: file.mtimeMs,
      skipped: true,
    };
  }

  const documents = await buildDocuments(parse, file, project, title);
  const storedDocuments: KnowledgeDocument[] = [];
  const storedEntries: Array<{chunk: KnowledgeChunk; title: string}> = [];
  let chunks = 0;
  for (const extracted of documents) {
    const doc: KnowledgeDocument = {
      id: documentId(id, extracted.path),
      collectionId: id,
      path: extracted.path,
      kind: extracted.kind,
      origin: "mechanical",
      contentHash: hashText(extracted.content),
    };
    storedDocuments.push(doc);
    const entries = chunkDocument(extracted).map((chunk, ordinal) => {
      const chunkFacets: KnowledgeFacets = {
        documentKind: extracted.kind,
      };
      const knowledgeChunk: KnowledgeChunk = {
        id: deterministicKnowledgeChunkId({
          collectionId: id,
          documentPath: extracted.path,
          ordinal,
          chunkPolicyVersion: CHUNK_POLICY_VERSION,
          text: chunk.text,
        }),
        collectionId: id,
        documentId: doc.id,
        documentPath: extracted.path,
        ordinal,
        text: chunk.text,
        textHash: hashText(chunk.text),
        origin: "mechanical",
        ownership: "derived",
        sourceRefs: [chunk.sourceRef],
        facets: chunkFacets,
      };
      chunks++;
      return { chunk: knowledgeChunk, title: `${title} / ${extracted.path}` };
    });
    storedEntries.push(...entries);
    // Big transcripts produce hundreds of documents; keep the process responsive.
    await yieldToEventLoop();
  }

  // Recheck after yielding during extraction: turning the setting off prevents
  // the next collection commit, not merely the next indexing job.
  if (!knowledgeIndexEnabled()) throw new Error(KNOWLEDGE_INDEX_OFF);
  store.replaceCollection(collection, storedDocuments, storedEntries, qmdCollectionFiles(collection, documents, parse, file));

  return {
    collectionId: id,
    title,
    harness: file.harness,
    project,
    transcriptPath: file.path,
    qmdPath,
    records: parse.records.length,
    documents: documents.length,
    chunks,
    bytes: file.size,
    mtimeMs: file.mtimeMs,
  };
}

export async function indexRecentSessionKnowledge(
  input: IndexRecentSessionKnowledgeInput = {},
): Promise<IndexRecentSessionKnowledgeResult> {
  const lookback = resolveLookbackMs(input);
  if (!knowledgeIndexEnabled()) return {
    enabled: false, message: KNOWLEDGE_INDEX_OFF,
    job: { id: "index-off", source: "sessions", state: "cancelled", leaseGeneration: 0, progress: {}, createdAt: Date.now(), updatedAt: Date.now() },
    days: lookback.days, hours: lookback.hours, discovered: 0, indexed: 0, failed: 0, sessions: [],
  };
  const limit = clampPositiveInt(input.limit, DEFAULT_LIMIT, 1000);
  const harnessFilter = normalizeHarnessFilter(input.harness);
  const store = new SQLiteKnowledgeStore();
  try {
    const job = store.createIndexJob({
      source: "sessions",
      days: lookback.days,
      force: input.force,
      mode: "foreground",
    });
    const leaseGeneration = job.leaseGeneration + 1;
    const files = discoverRecentSessionFiles(lookback.cutoffMs, limit, harnessFilter);
    const sessions: IndexedSessionKnowledgeSummary[] = [];
    let indexed = 0;
    let failed = 0;

    try {
      store.updateIndexJob({
        id: job.id,
        state: "running",
        leaseOwner: "session-indexer",
        leaseGeneration,
        progress: { discovered: files.length, extracted: 0, indexed: 0, failed: 0 },
      });
      for (const file of [...files].reverse()) {
        if (!knowledgeIndexEnabled()) break;
        try {
          const parse = await parseJsonl(file);
          const summary = await storeSessionCollection(store, file, parse, input.force === true);
          sessions.push(summary);
          indexed++;
        } catch (error) {
          failed++;
          sessions.push({
            collectionId: `failed/${file.harness}/${stableId(file.path)}`,
            title: basename(file.path),
            harness: file.harness,
            project: projectName(null, file),
            transcriptPath: file.path,
            qmdPath: "",
            records: 0,
            documents: 0,
            chunks: 0,
            bytes: file.size,
            mtimeMs: file.mtimeMs,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        store.updateIndexJob({
          id: job.id,
          state: "running",
          leaseOwner: "session-indexer",
          leaseGeneration,
          progress: { discovered: files.length, extracted: indexed + failed, indexed, failed },
        });
        await yieldToEventLoop();
      }
      const completedAt = Date.now();
      const completed = store.updateIndexJob({
        id: job.id,
        state: "completed",
        completedAt,
        progress: { discovered: files.length, extracted: indexed + failed, indexed, failed },
      }) ?? job;

      // Record what was SCANNED (root harnesses), not only what yielded files.
      // Empty-in-window roots still get a discovered=0 claim so later queries
      // don't prompt a no-op re-warm for a harness that was already walked.
      const lookbackMs = completedAt - lookback.cutoffMs;
      const scannedHarnesses = harnessFilter
        ? [...harnessFilter]
        : [...new Set(sessionRoots(null).map((entry) => entry.harness))];
      const complete = knowledgeIndexEnabled() && failed === 0 && sessions.length === files.length
        && sessions.every(session => store.getCollection(session.collectionId)?.status === "ready");
      for (const harness of complete ? scannedHarnesses : []) {
        const forHarnessFiles = files.filter((file) => file.harness === harness);
        const forHarnessSessions = sessions.filter((session) => session.harness === harness);
        store.recordWarmSpan({
          source: "sessions",
          harness,
          lookbackMs,
          cutoffMs: lookback.cutoffMs,
          completedAt,
          jobId: completed.id,
          discovered: forHarnessFiles.length,
          indexed: forHarnessSessions.filter((session) => !session.error).length,
          failed: forHarnessSessions.filter((session) => Boolean(session.error)).length,
        });
      }

      return {
        job: completed,
        days: lookback.days,
        hours: lookback.hours,
        discovered: files.length,
        indexed,
        failed,
        sessions,
      };
    } catch (error) {
      const failedJob = store.updateIndexJob({
        id: job.id,
        state: "failed",
        completedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
        progress: { discovered: files.length, extracted: indexed + failed, indexed, failed },
      }) ?? job;
      return {
        job: failedJob,
        days: lookback.days,
        hours: lookback.hours,
        discovered: files.length,
        indexed,
        failed: failed + 1,
        sessions,
      };
    }
  } finally {
    store.close();
  }
}

export interface ScanRecentSessionKnowledgeInput {
  q: string;
  /** Cancels discovery, transcript reads and the owned ripgrep process. */
  signal?: AbortSignal;
  /** Lookback window in whole days (default 3). */
  days?: number;
  harness?: string | string[];
  /** Only transcripts written at or after this time. */
  updatedAfterMs?: number;
  /** Newest transcripts to read (default 80). */
  fileLimit?: number;
  /** Hits to return (default 30). */
  limit?: number;
  /** Stop reading after this long and return what matched (default 2500ms). */
  budgetMs?: number;
}

export interface ScanRecentSessionKnowledgeResult {
  hits: KnowledgeSearchHit[];
  /** Known scanned files; a lower bound when ripgrep is interrupted. */
  scannedFiles: number;
  totalFiles: number;
  /** True when the time budget or hit limit ended the scan early. */
  truncated: boolean;
}

const SCAN_HITS_PER_FILE = 3;
const SCAN_RG_MAX_PER_FILE = 200;
const SCAN_RG_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const SCAN_HEAD_BYTES = 256 * 1024;

type ScanLine = { lineNo: number; byte: number; text: string };

function scanSnippet(text: string, terms: string[]): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 220) return compact;
  const index = compact.toLowerCase().indexOf(terms[0] ?? "");
  const start = Math.max(0, index >= 0 ? index - 70 : 0);
  const end = Math.min(compact.length, start + 220);
  return `${start > 0 ? "..." : ""}${compact.slice(start, end)}${end < compact.length ? "..." : ""}`;
}

type ScanBudget = { signal: AbortSignal; stopped: () => boolean };

// Discovery belongs to the request budget too. Stream directory entries rather
// than synchronously enumerating all transcript history before the first await.
async function discoverScanFiles(cutoffMs: number, limit: number, harnessFilter: Set<Harness> | null, budget: ScanBudget) {
  const files: SessionFile[] = [];
  let inspected = 0;
  for (const { harness, root } of sessionRoots(harnessFilter)) {
    const stack = [root];
    const visited = new Set<string>();
    while (stack.length && !budget.stopped()) {
      const directory = stack.pop()!;
      try {
        const directoryStat = await stat(directory);
        const identity = `${directoryStat.dev}:${directoryStat.ino}`;
        if (visited.has(identity) || budget.stopped()) continue;
        visited.add(identity);
        const entries = await opendir(directory);
        for await (const entry of entries) {
          if (budget.stopped()) break;
          if (++inspected % 32 === 0) await yieldToEventLoop();
          if (budget.stopped()) break;
          const path = join(directory, entry.name);
          // Keep existing symlink discovery semantics, but don't revisit cycles.
          if (entry.isDirectory()) { stack.push(path); continue; }
          if (!entry.isSymbolicLink() && !isHarnessTranscriptFile(harness, entry.name)) continue;
          let info;
          try { info = await stat(path); } catch { continue; }
          if (budget.stopped()) break;
          if (info.isDirectory()) { stack.push(path); continue; }
          if (!isHarnessTranscriptFile(harness, entry.name) || info.mtimeMs < cutoffMs) continue;
          files.push({ harness, path, mtimeMs: info.mtimeMs, size: info.size });
          files.sort((left, right) => right.mtimeMs - left.mtimeMs);
          if (files.length > limit) files.pop();
        }
      } catch {
        // A transcript directory may disappear or be unreadable during discovery.
      }
    }
    if (budget.stopped()) break;
  }
  return files;
}

let ripgrepPath: string | null | undefined;

function findRipgrep(): string | null {
  const override = process.env.OPENSCOUT_RG_PATH;
  if (override === "none") return null;
  if (override && existsSync(override)) return override;
  if (ripgrepPath !== undefined) return ripgrepPath;
  const candidates = ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"];
  for (const dir of (process.env.PATH ?? "").split(":")) if (dir) candidates.push(join(dir, "rg"));
  ripgrepPath = candidates.find((candidate) => existsSync(candidate)) ?? null;
  return ripgrepPath;
}

/** Null means rg is unavailable; an aborted/capped scan must never start a fallback. */
function ripgrepLines(files: string[], needle: string, budget: ScanBudget): Promise<{ lines: Map<string, ScanLine[]>; read: number; truncated: boolean } | null> {
  const rg = findRipgrep();
  if (!rg) return Promise.resolve(null);
  if (!files.length || budget.stopped()) return Promise.resolve({ lines: new Map(), read: 0, truncated: budget.stopped() });
  return new Promise((resolve) => {
    const out = new Map<string, ScanLine[]>();
    const child = spawn(rg, [
      "--ignore-case", "--fixed-strings", "--line-number", "--byte-offset", "--no-heading",
      "--with-filename", "--null", "--no-messages", "--max-count", String(SCAN_RG_MAX_PER_FILE),
      "--", needle, ...files,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let carry = "";
    let received = 0;
    let capped = false;
    let failed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      child.kill();
      // Don't leave an abandoned child if it fails to honor SIGTERM.
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 250);
    };
    budget.signal.addEventListener("abort", stop, { once: true });
    if (budget.stopped()) stop();
    const take = (line: string) => {
      const nul = line.indexOf("\0");
      if (nul < 0) return;
      const path = line.slice(0, nul);
      const match = /^(\d+):(\d+):/u.exec(line.slice(nul + 1));
      if (!match) return;
      const list = out.get(path) ?? [];
      list.push({ lineNo: Number(match[1]), byte: Number(match[2]), text: line.slice(nul + 1 + match[0].length) });
      out.set(path, list);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (capped || budget.stopped()) return;
      received += Buffer.byteLength(chunk, "utf8");
      if (received > SCAN_RG_MAX_OUTPUT_BYTES) { capped = true; stop(); return; }
      carry += chunk;
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) take(line);
    });
    child.on("error", () => { failed = true; });
    // Await actual process/pipe closure before releasing an abandoned scan.
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      budget.signal.removeEventListener("abort", stop);
      if (carry && !capped) take(carry);
      const completed = !capped && !budget.stopped() && (code === 0 || code === 1);
      // Completed rg visited the full input set. An interrupted rg only proves
      // the files from which it emitted matches; unmatched visits are unknown.
      resolve(failed && !budget.stopped() ? null : {
        lines: out, read: completed ? files.length : out.size, truncated: !completed,
      });
    });
  });
}

/** Stream the fallback so one large file cannot hide cancellation until EOF. */
async function readerLines(files: string[], terms: string[], budget: ScanBudget) {
  const out = new Map<string, ScanLine[]>();
  const maybeYield = createYieldBudget();
  let read = 0;
  let matchedBytes = 0;
  let capped = false;
  for (const path of files) {
    if (budget.stopped() || capped) break;
    const stream = createReadStream(path, { encoding: "utf8", signal: budget.signal, highWaterMark: 64 * 1024 });
    const list: ScanLine[] = [];
    let carry = "";
    let byte = 0;
    let lineNo = 0;
    let readAny = false;
    let completed = false;
    const take = (text: string) => {
      lineNo++;
      const lower = text.toLowerCase();
      if (terms.every((term) => lower.includes(term))) {
        matchedBytes += Buffer.byteLength(text, "utf8");
        if (matchedBytes > SCAN_RG_MAX_OUTPUT_BYTES) capped = true;
        else list.push({ lineNo, byte, text });
      }
      byte += Buffer.byteLength(text, "utf8") + 1;
    };
    try {
      for await (const chunk of stream) {
        if (budget.stopped()) break;
        readAny = true;
        carry += chunk;
        let newline: number;
        while ((newline = carry.indexOf("\n")) >= 0) {
          take(carry.slice(0, newline));
          carry = carry.slice(newline + 1);
          await maybeYield();
          if (budget.stopped() || capped) break;
        }
        // Bound an unterminated record by the existing scan output ceiling.
        if (Buffer.byteLength(carry, "utf8") > SCAN_RG_MAX_OUTPUT_BYTES) capped = true;
        if (budget.stopped() || capped) break;
      }
      if (carry && !budget.stopped() && !capped) take(carry);
      completed = !budget.stopped() && !capped;
    } catch {
      // Abort or a concurrently removed/unreadable file ends this read.
    } finally {
      stream.destroy();
    }
    // A deadline can abort a later read after earlier records were collected.
    if (readAny || completed) read++;
    if (list.length) out.set(path, list);
  }
  return { lines: out, read, truncated: capped || budget.stopped() || read < files.length };
}

/** cwd and session id from the head of a transcript, without reading the whole file. */
async function transcriptHead(file: SessionFile): Promise<{ cwd: string | null; sessionId: string | null }> {
  let cwd: string | null = null;
  const kimiAgent = basename(dirname(file.path));
  const kimiSession = basename(dirname(dirname(dirname(file.path))));
  let sessionId: string | null = file.harness === "kimi"
    ? (kimiAgent === "main" ? kimiSession : `${kimiSession}:${kimiAgent}`)
    : null;
  let head = "";
  try {
    const handle = await open(file.path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(SCAN_HEAD_BYTES, file.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      head = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return { cwd, sessionId };
  }
  let index = 0;
  for (const line of head.split("\n").slice(0, -1)) {
    if (cwd && sessionId) break;
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = normalizeRecord(value as Record<string, unknown>, index++, 0, file.harness);
      cwd ??= inferCwd(record);
      sessionId ??= record.refs?.sessionId ?? stringValue(record.meta?.id) ?? stringValue(record.meta?.sessionId) ?? null;
    } catch {
      // partial or non-JSON head line
    }
  }
  return { cwd, sessionId };
}

/**
 * Index-free search: find transcript records whose text holds every query
 * term, newest transcripts first. It answers while the session index is
 * missing or still building, shaped like an indexed hit so the same UI renders
 * it. Uses ripgrep when present (one pass over all files), else reads each file
 * in JS; both stop at the time budget and return what matched.
 */
export async function scanRecentSessionKnowledge(
  input: ScanRecentSessionKnowledgeInput,
): Promise<ScanRecentSessionKnowledgeResult> {
  const terms = [...new Set(input.q.toLowerCase().split(/\s+/u).filter((term) => term.length > 1))];
  if (terms.length === 0) return { hits: [], scannedFiles: 0, totalFiles: 0, truncated: false };
  const days = clampPositiveInt(input.days, DEFAULT_DAYS, 30);
  const cutoffMs = Math.max(Date.now() - days * 24 * 60 * 60 * 1000, input.updatedAfterMs ?? 0);
  const limit = clampPositiveInt(input.limit, 30, 200);
  input.signal?.throwIfAborted();
  const budgetMs = clampPositiveInt(input.budgetMs, 2500, 15_000);
  const deadline = Date.now() + budgetMs;
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const budget: ScanBudget = { signal: controller.signal, stopped: () => controller.signal.aborted || Date.now() >= deadline };
  try {
    const files = await discoverScanFiles(cutoffMs, clampPositiveInt(input.fileLimit, 80, 400), normalizeHarnessFilter(input.harness), budget);
    const paths = files.map((file) => file.path);
    // The longest term is the likeliest to be rare, so it filters hardest.
    const needle = [...terms].sort((left, right) => right.length - left.length)[0]!;
    const rg = await ripgrepLines(paths, needle, budget);
    const fallback = rg ? null : await readerLines(paths, terms, budget);
    const lines = rg?.lines ?? fallback!.lines;
    const scannedFiles = rg?.read ?? fallback!.read;
    let truncated = (rg?.truncated ?? fallback!.truncated) || budget.stopped();
    const maybeYield = createYieldBudget();

    // The collection deadline stops I/O, not assembly of matches already in
    // memory. Existing file/output/hit bounds limit this phase; continue yielding
    // and honor caller cancellation independently of the expired scan budget.
    const phrase = terms.join(" ");
    const hits: KnowledgeSearchHit[] = [];
    for (const file of files) {
      input.signal?.throwIfAborted();
      if (hits.length >= limit) {
        truncated = true;
        break;
      }
      const candidates = lines.get(file.path);
      if (!candidates?.length) continue;
      const matches: Array<{ record: NormalizedRecord; text: string; byte: number; bytes: number; phrase: boolean }> = [];
      for (const line of candidates) {
        await maybeYield();
        input.signal?.throwIfAborted();
        const lower = line.text.toLowerCase();
        if (!terms.every((term) => lower.includes(term))) continue;
        let record: NormalizedRecord;
        try {
          const value = JSON.parse(line.text) as unknown;
          if (!value || typeof value !== "object" || Array.isArray(value)) continue;
          record = normalizeRecord(value as Record<string, unknown>, line.lineNo - 1, line.byte, file.harness);
        } catch {
          continue;
        }
        if (record.kind === "system_record" || record.kind === "unknown" || record.kind === "session_meta") continue;
        const text = stripHarnessBoilerplate(record.text ?? summarizeRecord(record));
        const haystack = text.toLowerCase();
        if (!terms.every((term) => haystack.includes(term))) continue;
        matches.push({ record, text, byte: line.byte, bytes: Buffer.byteLength(line.text, "utf8"), phrase: haystack.includes(phrase) });
      }
      if (matches.length === 0) continue;
      // Exact phrase first, then the newest record.
      matches.sort((left, right) => Number(right.phrase) - Number(left.phrase) || right.record.i - left.record.i);

      input.signal?.throwIfAborted();
      const head = await transcriptHead(file);
      input.signal?.throwIfAborted();
      const resolvedSession = head.sessionId ?? basename(file.path).replace(/\.jsonl$/u, "");
      const project = projectName(head.cwd, file);
      const collectionId = `sessions/${file.harness}/${resolvedSession.replace(/[^A-Za-z0-9_.-]+/gu, "-").slice(0, 80)}-${stableId(file.path, 10)}`;
      const when = new Date(file.mtimeMs).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      for (const match of matches.slice(0, SCAN_HITS_PER_FILE)) {
        if (hits.length >= limit) break;
        const sourceRef: KnowledgeSourceRef = {
          kind: "harness_transcript",
          harness: file.harness,
          path: portablePath(file.path),
          sessionId: resolvedSession,
          recordRange: [match.record.i, match.record.i],
          byteRange: [match.byte, match.byte + match.bytes],
          anchor: { sizeBytes: file.size, mtimeMs: file.mtimeMs },
        };
        const id = `basic:${stableId(`${file.path}\0${match.record.i}`)}`;
        hits.push({
          id,
          collectionId,
          documentId: `${collectionId}/basic`,
          chunkId: id,
          title: `${file.harness} ${project} ${when} - ${trimOneLine(match.text, 80)}`,
          snippet: scanSnippet(match.text, terms),
          score: 0,
          scoreSource: "fts",
          origin: "mechanical",
          ownership: "observed_source",
          freshness: "fresh",
          sourceRefs: [sourceRef],
          drilldown: [{ kind: "harness_transcript", sourceRef }],
          facets: {
            harness: file.harness,
            project,
            ...(head.cwd ? { projectPath: head.cwd } : {}),
            source: "sessions",
            transcriptPath: file.path,
            sessionId: resolvedSession,
            documentKind: "events",
            match: "basic",
          },
        });
      }
    }

    input.signal?.throwIfAborted();
    return { hits, scannedFiles, totalFiles: files.length, truncated };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
  }
}
