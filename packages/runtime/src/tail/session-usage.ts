import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { redactSecrets } from "@openscout/agent-sessions/secret-redaction";

import type { DiscoveredTranscript, TailContext, TailEvent, TranscriptSource } from "./types.js";

/**
 * Lifetime token totals read from a session's own transcript. Every field
 * uses Claude's split: `input` is uncached input, and cache reads and writes
 * are counted apart from it (Codex reports cached input inside its input
 * total; it is moved to `cacheRead` here).
 */
export type TailSessionTokenTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Codex only: reasoning output, already included in `output`. */
  reasoningOutput?: number;
};

export type TailSessionLastTurn = {
  kind: "user" | "assistant";
  /** Epoch ms of the turn, when the transcript records one. */
  at: number | null;
  /** The turn's text, redacted and clipped to 160 characters. */
  text: string;
};

export type TailSessionUsage = {
  sessionId: string;
  source: string;
  transcriptPath: string;
  /** The model of the newest assistant turn that named one. */
  model: string | null;
  /** Null when the source does not record usage (Grok, Kimi, Cursor, OpenCode, Devin) or none was seen yet. */
  tokens: TailSessionTokenTotals | null;
  /** The newest user or assistant turn; tool, system and harness-only turns are skipped. */
  lastTurn: TailSessionLastTurn | null;
  /**
   * How far into the transcript the token scan has read, and the size the file
   * had. A Codex scan starts near the end, because its totals are cumulative.
   */
  scannedBytes: number;
  size: number;
  /**
   * False while a large transcript is still being read: each request reads a
   * bounded slice, and totals cover only `scannedBytes`. Ask again to continue.
   */
  complete: boolean;
};

export type TailSessionUsageReply = {
  generatedAt: number;
  sessions: TailSessionUsage[];
  /** Requested refs that matched no discovered transcript. */
  missing: string[];
};

/** Most session refs one usage read accepts. */
export const TAIL_SESSION_USAGE_MAX_REFS = 50;

/** Most one transcript's scan reads in one request. */
export const TAIL_SESSION_USAGE_SCAN_BYTES = 16 * 1024 * 1024;
/** Most all scans together read in one request. */
export const TAIL_SESSION_USAGE_REQUEST_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
/** A line longer than this is skipped rather than buffered. */
const MAX_LINE_BYTES = 4 * 1024 * 1024;
/**
 * Codex records cumulative totals, so a new scan of a long rollout starts
 * this far from its end; it starts at the beginning only if no total is there.
 */
const CODEX_TAIL_START_BYTES = 4 * 1024 * 1024;
/** The newest turn is looked for in this much of the file's end. */
const TURN_TAIL_BYTES = 512 * 1024;
const TURN_TAIL_MAX_EVENTS = 400;
const TURN_TEXT_MAX_CHARS = 160;
/** Harness placeholders, not words: an empty block, a thinking or reasoning beat. */
const PLACEHOLDER_TURN = /^\[(?:assistant|thinking|reasoning)\](?:\s|$)/u;
const SCAN_STATE_LIMIT = 256;

type Totals = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoningOutput: number };

type ScanState = {
  path: string;
  source: string;
  offset: number;
  mtimeMs: number;
  carry: string;
  /** True while `carry` is the middle of an over-long line being skipped. */
  skippingLine: boolean;
  decoder: StringDecoder;
  totals: Totals;
  sawTokens: boolean;
  /** Claude repeats one message's usage on every content block; count each id once. */
  claudePending: { id: string; input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  model: string | null;
  /** Set once a Codex scan that began at the tail has fallen back to the start. */
  codexFromStart: boolean;
  lastTurn: TailSessionLastTurn | null;
  /** The file size and mtime the newest turn was read at. */
  turnReadAt: { size: number; mtimeMs: number } | null;
  /** Bytes the latest scan read, for the caller's request budget. */
  lastReadBytes: number;
};

const scanStates = new Map<string, ScanState>();
const scansInFlight = new Map<string, Promise<ScanState>>();

function emptyTotals(): Totals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningOutput: 0 };
}

function newState(transcript: DiscoveredTranscript): ScanState {
  return {
    path: transcript.transcriptPath,
    source: transcript.source,
    offset: 0,
    mtimeMs: transcript.mtimeMs,
    carry: "",
    skippingLine: false,
    decoder: new StringDecoder("utf8"),
    totals: emptyTotals(),
    sawTokens: false,
    claudePending: null,
    model: null,
    codexFromStart: false,
    lastTurn: null,
    turnReadAt: null,
    lastReadBytes: 0,
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseJson(line: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(line));
  } catch {
    return null;
  }
}

function commitClaudePending(state: ScanState): void {
  const pending = state.claudePending;
  if (!pending) return;
  state.totals.input += pending.input;
  state.totals.output += pending.output;
  state.totals.cacheRead += pending.cacheRead;
  state.totals.cacheWrite += pending.cacheWrite;
  state.claudePending = null;
}

function applyClaudeLine(state: ScanState, line: string): void {
  if (!line.includes("\"usage\"") && !line.includes("\"model\"")) return;
  const entry = parseJson(line);
  const message = record(entry?.message);
  if (!message || message.role !== "assistant") return;
  const model = typeof message.model === "string" ? message.model.trim() : "";
  if (model && model !== "<synthetic>") state.model = model;
  const usage = record(message.usage);
  if (!usage) return;
  const id = typeof message.id === "string" && message.id ? message.id : null;
  const next = {
    id: id ?? `line:${state.offset}`,
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens),
  };
  // Blocks of one message are adjacent; a repeat replaces the earlier reading.
  if (state.claudePending && state.claudePending.id !== next.id) commitClaudePending(state);
  state.claudePending = next;
  state.sawTokens = true;
}

function applyCodexLine(state: ScanState, line: string): void {
  if (line.includes("\"turn_context\"")) {
    const payload = record(parseJson(line)?.payload);
    const model = typeof payload?.model === "string" ? payload.model.trim() : "";
    if (model) state.model = model;
    return;
  }
  if (!line.includes("\"token_count\"")) return;
  const payload = record(parseJson(line)?.payload);
  if (payload?.type !== "token_count") return;
  const total = record(record(payload.info)?.total_token_usage);
  if (!total) return;
  // total_token_usage is already cumulative for the session; the newest wins.
  const input = num(total.input_tokens);
  const cacheRead = num(total.cached_input_tokens);
  state.totals = {
    input: Math.max(0, input - cacheRead),
    output: num(total.output_tokens),
    cacheRead,
    cacheWrite: num(total.cache_write_input_tokens),
    reasoningOutput: num(total.reasoning_output_tokens),
  };
  state.sawTokens = true;
}

function applyPiLine(state: ScanState, line: string): void {
  if (!line.includes("\"usage\"")) return;
  const message = record(parseJson(line)?.message);
  if (!message || message.role !== "assistant") return;
  const model = typeof message.model === "string" ? message.model.trim() : "";
  if (model) state.model = model;
  const usage = record(message.usage);
  if (!usage) return;
  state.totals.input += num(usage.input);
  state.totals.output += num(usage.output);
  state.totals.cacheRead += num(usage.cacheRead);
  state.totals.cacheWrite += num(usage.cacheWrite);
  state.sawTokens = true;
}

function applyUsageLine(state: ScanState, line: string): void {
  if (state.source === "claude") applyClaudeLine(state, line);
  else if (state.source === "codex") applyCodexLine(state, line);
  else if (state.source === "pi") applyPiLine(state, line);
}

function clipText(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= TURN_TEXT_MAX_CHARS ? flat : `${flat.slice(0, TURN_TEXT_MAX_CHARS - 1)}…`;
}

/** The turn an event shows, or null for tool, system and harness-only events. */
export function turnFromEvent(event: TailEvent): TailSessionLastTurn | null {
  if (event.kind !== "user" && event.kind !== "assistant") return null;
  if (event.kind === "user" && event.prompt?.harnessOnly) return null;
  const raw = event.kind === "user" && event.prompt?.words ? event.prompt.words : event.summary;
  const text = clipText(redactSecrets(raw ?? ""));
  if (!text || PLACEHOLDER_TURN.test(text)) return null;
  return { kind: event.kind, at: Number.isFinite(event.ts) && event.ts > 0 ? event.ts : null, text };
}

function syntheticContext(transcript: DiscoveredTranscript, lineOffset: number): TailContext {
  return {
    process: {
      pid: 0,
      ppid: 0,
      command: `${transcript.source} transcript`,
      etime: "0",
      cwd: transcript.cwd,
      harness: transcript.harness,
      parentChain: [],
      source: transcript.source,
    },
    transcript,
    transcriptPath: transcript.transcriptPath,
    lineOffset,
    state: {},
  };
}

function newestTurn(source: TranscriptSource, transcript: DiscoveredTranscript, lines: string[]): TailSessionLastTurn | null {
  const stop = Math.max(0, lines.length - TURN_TAIL_MAX_EVENTS);
  for (let index = lines.length - 1; index >= stop; index -= 1) {
    if (!lines[index]) continue;
    let event: TailEvent | null = null;
    try {
      event = source.parseLine(lines[index]!, syntheticContext(transcript, index));
    } catch {
      event = null;
    }
    const turn = event ? turnFromEvent(event) : null;
    if (turn) return turn;
  }
  return null;
}

/** The newest turn in the file's last TURN_TAIL_BYTES, whatever the scan has reached. */
async function readNewestTurn(
  handle: Awaited<ReturnType<typeof open>>,
  source: TranscriptSource,
  transcript: DiscoveredTranscript,
): Promise<TailSessionLastTurn | null> {
  const start = Math.max(0, transcript.size - TURN_TAIL_BYTES);
  const buffer = Buffer.alloc(transcript.size - start);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
  const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n").map((line) => line.trim());
  if (start > 0) lines.shift();
  return newestTurn(source, transcript, lines);
}

async function advanceScan(
  state: ScanState,
  source: TranscriptSource,
  transcript: DiscoveredTranscript,
  maxBytes: number,
): Promise<ScanState> {
  if (transcript.size < state.offset || transcript.mtimeMs < state.mtimeMs) {
    // Truncated or replaced: start over.
    Object.assign(state, newState(transcript));
  }
  if (state.source === "codex" && state.offset === 0 && !state.codexFromStart && transcript.size > CODEX_TAIL_START_BYTES) {
    state.offset = transcript.size - CODEX_TAIL_START_BYTES;
    state.skippingLine = true;
  }
  const handle = await open(state.path, "r");
  try {
    if (!state.turnReadAt || state.turnReadAt.size !== transcript.size || state.turnReadAt.mtimeMs !== transcript.mtimeMs) {
      const turn = await readNewestTurn(handle, source, transcript);
      if (turn) state.lastTurn = turn;
      state.turnReadAt = { size: transcript.size, mtimeMs: transcript.mtimeMs };
    }
    const end = Math.min(transcript.size, state.offset + Math.max(0, maxBytes));
    const startedAt = state.offset;
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    while (state.offset < end) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(READ_CHUNK_BYTES, end - state.offset), state.offset);
      if (bytesRead <= 0) break;
      state.offset += bytesRead;
      const text = state.carry + state.decoder.write(buffer.subarray(0, bytesRead));
      const lines = text.split("\n");
      state.carry = lines.pop() ?? "";
      for (const rawLine of lines) {
        if (state.skippingLine) {
          state.skippingLine = false;
          continue;
        }
        const line = rawLine.trim();
        if (!line) continue;
        applyUsageLine(state, line);
      }
      if (state.carry.length > MAX_LINE_BYTES) {
        state.carry = "";
        state.skippingLine = true;
      }
      // Yield between chunks so a long scan never holds the event loop.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    state.lastReadBytes = Math.max(0, state.offset - startedAt);
  } finally {
    await handle.close();
  }
  state.mtimeMs = transcript.mtimeMs;
  if (state.source === "codex" && !state.sawTokens && !state.codexFromStart && state.offset >= transcript.size) {
    // No cumulative total near the end: read the whole rollout from the start.
    Object.assign(state, { ...newState(transcript), codexFromStart: true, lastTurn: state.lastTurn, turnReadAt: state.turnReadAt });
  }
  return state;
}

function rememberState(state: ScanState): void {
  scanStates.delete(state.path);
  scanStates.set(state.path, state);
  while (scanStates.size > SCAN_STATE_LIMIT) {
    const oldest = scanStates.keys().next().value;
    if (oldest === undefined) break;
    scanStates.delete(oldest);
  }
}

function usageFromState(state: ScanState, transcript: DiscoveredTranscript): TailSessionUsage {
  const totals = { ...state.totals };
  const pending = state.claudePending;
  if (pending) {
    totals.input += pending.input;
    totals.output += pending.output;
    totals.cacheRead += pending.cacheRead;
    totals.cacheWrite += pending.cacheWrite;
  }
  return {
    sessionId: transcript.sessionId ?? transcript.transcriptPath,
    source: transcript.source,
    transcriptPath: transcript.transcriptPath,
    model: state.model,
    tokens: state.sawTokens
      ? {
        input: totals.input,
        output: totals.output,
        cacheRead: totals.cacheRead,
        cacheWrite: totals.cacheWrite,
        ...(totals.reasoningOutput > 0 ? { reasoningOutput: totals.reasoningOutput } : {}),
      }
      : null,
    lastTurn: state.lastTurn,
    scannedBytes: state.offset,
    size: transcript.size,
    complete: state.offset >= transcript.size,
  };
}

/**
 * Read a line-based transcript's usage, continuing from where the previous
 * read for the same file stopped. Concurrent reads of one file share a scan.
 */
export async function readLineTranscriptUsage(
  source: TranscriptSource,
  transcript: DiscoveredTranscript,
  maxBytes: number = TAIL_SESSION_USAGE_SCAN_BYTES,
): Promise<TailSessionUsage & { lastReadBytes: number }> {
  const path = transcript.transcriptPath;
  let scan = scansInFlight.get(path);
  if (!scan) {
    const state = scanStates.get(path) ?? newState(transcript);
    scan = advanceScan(state, source, transcript, Math.min(maxBytes, TAIL_SESSION_USAGE_SCAN_BYTES))
      .then((advanced) => {
        rememberState(advanced);
        return advanced;
      })
      .finally(() => {
        scansInFlight.delete(path);
      });
    scansInFlight.set(path, scan);
  }
  const state = await scan;
  return { ...usageFromState(state, transcript), lastReadBytes: state.lastReadBytes };
}

/** For whole-file sources: no usage in the transcript, last turn from buffered events. */
export function usageFromEvents(transcript: DiscoveredTranscript, events: readonly TailEvent[]): TailSessionUsage {
  let lastTurn: TailSessionLastTurn | null = null;
  for (let index = events.length - 1; index >= 0 && !lastTurn; index -= 1) {
    lastTurn = turnFromEvent(events[index]!);
  }
  return {
    sessionId: transcript.sessionId ?? transcript.transcriptPath,
    source: transcript.source,
    transcriptPath: transcript.transcriptPath,
    model: null,
    tokens: null,
    lastTurn,
    scannedBytes: 0,
    size: transcript.size,
    complete: true,
  };
}

export function resetSessionUsageForTest(): void {
  scanStates.clear();
  scansInFlight.clear();
}
