import { isClaudeHistoryPath } from "./claude-projects.js";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { basename, resolve } from "node:path";

import { projectCodexAssistantText } from "./adapters/codex/host-metadata.js";

export const DEFAULT_TASK_TAIL_MAX_MESSAGES = 20;
export const MAX_TASK_TAIL_MESSAGES = 100;
export const DEFAULT_TASK_TAIL_MAX_BYTES = 256 * 1024;
export const MAX_TASK_TAIL_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TASK_TAIL_MAX_SCAN_BYTES = 32 * 1024 * 1024;
export const MAX_TASK_TAIL_SCAN_BYTES = 64 * 1024 * 1024;

const CURSOR_VERSION = 1;
const CURSOR_PREFIX = `task-tail.v${CURSOR_VERSION}`;
const CURSOR_DOMAIN = "@openscout/agent-sessions/task-tail-cursor\0";
const MAX_CURSOR_BYTES = 64 * 1024;
const MAX_CURSOR_SEEN_FINGERPRINTS = 128;
const MAX_TASK_ID_LENGTH = 1_024;
const MAX_TURN_ID_LENGTH = 2_048;
const HEAD_TASK_ID_READ_BYTES = 64 * 1024;
const IDENTITY_PREFIX_BYTES = 4 * 1024;
const TAIL_GROWTH_MAX_BYTES = 4 * 1024 * 1024;

export type TaskTailAdapterType = "codex" | "claude-code";
export type TaskTailRole = "user" | "assistant";

export interface TaskTailMessage {
  id: string;
  role: TaskTailRole;
  text: string;
  timestamp?: string;
  turnId?: string;
  /** True when `text` was clipped to the normalized-output byte budget. */
  truncated?: true;
}

export interface TaskTailInput {
  path: string;
  adapterType?: TaskTailAdapterType;
  expectedTaskId?: string;
  cursor?: string;
  maxMessages?: number;
  maxBytes?: number;
  /** Maximum transcript bytes inspected to find messages. */
  maxScanBytes?: number;
}

export interface TaskTailSource {
  path: string;
  identity: string;
  startOffset: number;
  endOffset: number;
  /** Actual transcript bytes read, including bounded task-id proof reads. */
  bytesRead: number;
  /** File size observed before the bounded read. */
  fileSize: number;
}

export interface TaskTailResult {
  adapterType: TaskTailAdapterType;
  taskId: string;
  messages: TaskTailMessage[];
  cursor: string;
  truncated: boolean;
  source: TaskTailSource;
}

export type TaskTailErrorCode =
  | "INVALID_INPUT"
  | "LIMIT_EXCEEDED"
  | "ADAPTER_UNSUPPORTED"
  | "SOURCE_UNAVAILABLE"
  | "SOURCE_NOT_FILE"
  | "SOURCE_REPLACED"
  | "SOURCE_TRUNCATED"
  | "TASK_ID_UNPROVEN"
  | "TASK_MISMATCH"
  | "CURSOR_INVALID"
  | "CURSOR_ADAPTER_MISMATCH"
  | "CURSOR_TASK_MISMATCH"
  | "CURSOR_OFFSET_INVALID";

export class TaskTailError extends Error {
  readonly code: TaskTailErrorCode;

  constructor(code: TaskTailErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskTailError";
    this.code = code;
  }
}

export function isTaskTailError(value: unknown): value is TaskTailError {
  return value instanceof TaskTailError;
}

type CursorPayloadV1 = {
  version: 1;
  adapterType: TaskTailAdapterType;
  taskId: string;
  identity: string;
  offset: number;
  turnId?: string;
  seen?: string[];
  discardingLine?: true;
};

type ParsedCursor = {
  adapterType: TaskTailAdapterType;
  taskId: string;
  identity: string;
  offset: number;
  turnId?: string;
  seen: string[];
  discardingLine: boolean;
};

type SourceLine = {
  startOffset: number;
  endOffset: number;
  text: string;
  partial?: true;
};

type CandidateMessage = {
  message: TaskTailMessage;
  dedupeKey: string;
  priority: number;
  startOffset: number;
  endOffset: number;
};

type ParsedCodexLines = {
  candidates: CandidateMessage[];
  currentTurnId?: string;
  observedTaskIds: Set<string>;
};

type OpenSource = {
  fd: number;
  stats: BigIntStats;
  identity: string;
  identityBytesRead: number;
  identityProofLength: number;
  fileSize: number;
};

function taskTailError(
  code: TaskTailErrorCode,
  message: string,
  cause?: unknown,
): TaskTailError {
  return new TaskTailError(code, message, cause === undefined ? undefined : { cause });
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizedLimit(
  name: "maxMessages" | "maxBytes" | "maxScanBytes",
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw taskTailError(
      "LIMIT_EXCEEDED",
      `${name} must be a positive integer no greater than ${maximum}.`,
    );
  }
  return resolved;
}

function fileIdentity(stats: BigIntStats, prefix: Buffer): string {
  const digest = createHash("sha256").update(prefix).digest("base64url").slice(0, 24);
  return `posix:${stats.dev.toString(36)}:${stats.ino.toString(36)}:${prefix.length}:${digest}`;
}

function cursorIdentityMatchesSource(identity: string, source: OpenSource): boolean {
  const match = /^(posix:[^:]+:[^:]+):(\d+):([A-Za-z0-9_-]+)$/u.exec(identity);
  if (!match) {
    return false;
  }
  const statPrefix = `posix:${source.stats.dev.toString(36)}:${source.stats.ino.toString(36)}`;
  const proofLength = Number(match[2]);
  if (
    match[1] !== statPrefix
    || !Number.isSafeInteger(proofLength)
    || proofLength < 0
    || proofLength > IDENTITY_PREFIX_BYTES
    || proofLength > source.fileSize
  ) {
    return false;
  }
  const prefix = readAt(source.fd, 0, proofLength);
  return fileIdentity(source.stats, prefix) === identity;
}

function safeFileSize(stats: BigIntStats): number {
  if (stats.size < 0n || stats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw taskTailError(
      "SOURCE_UNAVAILABLE",
      "Task transcript size is outside the supported safe-integer range.",
    );
  }
  return Number(stats.size);
}

function openSource(path: string): OpenSource {
  let fd: number;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    fd = openSync(path, constants.O_RDONLY | noFollow);
  } catch (cause) {
    throw taskTailError("SOURCE_UNAVAILABLE", `Cannot open task transcript: ${path}`, cause);
  }

  try {
    const stats = fstatSync(fd, { bigint: true });
    const pathStats = lstatSync(path, { bigint: true });
    if (!stats.isFile() || !pathStats.isFile() || pathStats.isSymbolicLink()) {
      throw taskTailError("SOURCE_NOT_FILE", `Task transcript is not a regular file: ${path}`);
    }
    if (stats.dev !== pathStats.dev || stats.ino !== pathStats.ino) {
      throw taskTailError("SOURCE_REPLACED", `Task transcript changed while it was being opened: ${path}`);
    }
    const prefix = readAt(fd, 0, Math.min(IDENTITY_PREFIX_BYTES, safeFileSize(stats)));
    const identity = fileIdentity(stats, prefix);
    return {
      fd,
      stats,
      identity,
      identityBytesRead: prefix.length,
      identityProofLength: prefix.length,
      fileSize: safeFileSize(stats),
    };
  } catch (cause) {
    closeSync(fd);
    if (cause instanceof TaskTailError) {
      throw cause;
    }
    throw taskTailError("SOURCE_UNAVAILABLE", `Cannot inspect task transcript: ${path}`, cause);
  }
}

function assertSourceStillCurrent(path: string, source: OpenSource, minimumSize: number): void {
  try {
    const descriptorStats = fstatSync(source.fd, { bigint: true });
    const pathStats = lstatSync(path, { bigint: true });
    if (
      !descriptorStats.isFile()
      || !pathStats.isFile()
      || pathStats.isSymbolicLink()
      || descriptorStats.dev !== pathStats.dev
      || descriptorStats.ino !== pathStats.ino
    ) {
      throw taskTailError("SOURCE_REPLACED", `Task transcript was replaced during the read: ${path}`);
    }
    if (safeFileSize(descriptorStats) < minimumSize) {
      throw taskTailError("SOURCE_TRUNCATED", `Task transcript was truncated during the read: ${path}`);
    }
    const prefix = readAt(source.fd, 0, source.identityProofLength);
    if (fileIdentity(descriptorStats, prefix) !== source.identity) {
      throw taskTailError("SOURCE_REPLACED", `Task transcript content changed during the read: ${path}`);
    }
  } catch (cause) {
    if (cause instanceof TaskTailError) {
      throw cause;
    }
    throw taskTailError("SOURCE_REPLACED", `Task transcript changed during the read: ${path}`, cause);
  }
}

function readAt(fd: number, position: number, length: number): Buffer {
  if (length <= 0) {
    return Buffer.alloc(0);
  }
  const buffer = Buffer.allocUnsafe(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const count = readSync(fd, buffer, bytesRead, length - bytesRead, position + bytesRead);
    if (count <= 0) {
      break;
    }
    bytesRead += count;
  }
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

function cursorChecksum(body: string): string {
  return createHash("sha256")
    .update(CURSOR_DOMAIN)
    .update(body)
    .digest("base64url");
}

function encodeCursor(payload: Omit<CursorPayloadV1, "version">): string {
  const body = Buffer.from(JSON.stringify({ version: CURSOR_VERSION, ...payload }), "utf8")
    .toString("base64url");
  return `${CURSOR_PREFIX}.${body}.${cursorChecksum(body)}`;
}

function invalidCursor(message: string, cause?: unknown): TaskTailError {
  return taskTailError("CURSOR_INVALID", message, cause);
}

function decodeCursor(cursor: string): ParsedCursor {
  if (!cursor || Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES) {
    throw invalidCursor("Task-tail cursor is empty or too large.");
  }
  const parts = cursor.split(".");
  if (parts.length !== 4 || `${parts[0]}.${parts[1]}` !== CURSOR_PREFIX) {
    throw invalidCursor("Task-tail cursor has an unsupported format or version.");
  }
  const body = parts[2]!;
  const checksum = parts[3]!;
  if (!/^[A-Za-z0-9_-]+$/u.test(body) || !/^[A-Za-z0-9_-]+$/u.test(checksum)) {
    throw invalidCursor("Task-tail cursor is corrupt.");
  }

  const expected = Buffer.from(cursorChecksum(body), "utf8");
  const actual = Buffer.from(checksum, "utf8");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw invalidCursor("Task-tail cursor checksum is invalid.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  } catch (cause) {
    throw invalidCursor("Task-tail cursor payload is corrupt.", cause);
  }
  const value = recordValue(parsed);
  const taskId = nonEmptyString(value?.taskId);
  const identity = nonEmptyString(value?.identity);
  const adapterType = value?.adapterType;
  const offset = value?.offset;
  const turnId = value?.turnId === undefined ? undefined : nonEmptyString(value.turnId);
  const seen = value?.seen === undefined ? [] : value.seen;
  const discardingLine = value?.discardingLine === true;
  if (
    value?.version !== CURSOR_VERSION
    || (adapterType !== "codex" && adapterType !== "claude-code")
    || !taskId
    || taskId.length > MAX_TASK_ID_LENGTH
    || !identity
    || identity.length > 256
    || !Number.isSafeInteger(offset)
    || (offset as number) < 0
    || (value?.turnId !== undefined && (!turnId || turnId.length > MAX_TURN_ID_LENGTH))
    || (value?.discardingLine !== undefined && value.discardingLine !== true)
    || !Array.isArray(seen)
    || seen.length > MAX_CURSOR_SEEN_FINGERPRINTS
    || seen.some((entry) => typeof entry !== "string" || !/^[A-Za-z0-9_-]{16,64}$/u.test(entry))
  ) {
    throw invalidCursor("Task-tail cursor payload is invalid.");
  }

  return {
    adapterType,
    taskId,
    identity,
    offset: offset as number,
    turnId,
    seen: seen as string[],
    discardingLine,
  };
}

function inferAdapterType(path: string): TaskTailAdapterType | null {
  if (isClaudeHistoryPath(path)) return "claude-code";
  const normalized = path.toLowerCase();
  if (
    normalized.includes("/.codex/")
    || normalized.includes("/.openai-codex/")
    || /^rollout-.*\.jsonl$/u.test(basename(normalized))
  ) {
    return "codex";
  }
  return null;
}

function resolveAdapterType(
  requested: TaskTailAdapterType | undefined,
  path: string,
  cursor: ParsedCursor | undefined,
): TaskTailAdapterType {
  if (requested !== undefined && requested !== "codex" && requested !== "claude-code") {
    throw taskTailError("INVALID_INPUT", `Unknown task-tail adapter type: ${String(requested)}`);
  }
  const inferred = inferAdapterType(path);
  const adapterType = requested ?? cursor?.adapterType ?? inferred;
  if (!adapterType) {
    throw taskTailError("ADAPTER_UNSUPPORTED", `Cannot infer a task-tail adapter for: ${path}`);
  }
  if (cursor && cursor.adapterType !== adapterType) {
    throw taskTailError(
      "CURSOR_ADAPTER_MISMATCH",
      `Task-tail cursor is for ${cursor.adapterType}, not ${adapterType}.`,
    );
  }
  if (requested && inferred && requested !== inferred) {
    throw taskTailError(
      "ADAPTER_UNSUPPORTED",
      `Requested adapter ${requested} does not match the transcript path inferred as ${inferred}.`,
    );
  }
  if (adapterType !== "codex") {
    throw taskTailError(
      "ADAPTER_UNSUPPORTED",
      `Task-tail adapter ${adapterType} is not implemented yet; Codex rollout JSONL is currently supported.`,
    );
  }
  return adapterType;
}

function codexTaskIdFromPath(path: string): string | undefined {
  const name = basename(path);
  const timestamped = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?-(.+)\.jsonl$/u.exec(name);
  const simple = /^rollout-(.+)\.jsonl$/u.exec(name);
  const taskId = nonEmptyString(timestamped?.[1] ?? simple?.[1]);
  return taskId && taskId.length <= MAX_TASK_ID_LENGTH ? taskId : undefined;
}

function sourceLines(buffer: Buffer, absoluteStart: number, knownBoundary: boolean): SourceLine[] {
  const lines: SourceLine[] = [];
  let lineStart = 0;
  if (!knownBoundary) {
    const boundary = buffer.indexOf(0x0a);
    if (boundary < 0) {
      return lines;
    }
    // The first newline proves the next byte is a record boundary even though
    // the bytes before it are a discarded partial record from the tail read.
    lines.push({
      startOffset: absoluteStart,
      endOffset: absoluteStart + boundary + 1,
      text: buffer.toString("utf8", 0, boundary > 0 && buffer[boundary - 1] === 0x0d ? boundary - 1 : boundary),
      partial: true,
    });
    lineStart = boundary + 1;
  }

  while (lineStart < buffer.length) {
    const newline = buffer.indexOf(0x0a, lineStart);
    if (newline < 0) {
      break;
    }
    let lineEnd = newline;
    if (lineEnd > lineStart && buffer[lineEnd - 1] === 0x0d) {
      lineEnd -= 1;
    }
    lines.push({
      startOffset: absoluteStart + lineStart,
      endOffset: absoluteStart + newline + 1,
      text: buffer.toString("utf8", lineStart, lineEnd),
    });
    lineStart = newline + 1;
  }
  return lines;
}

function timestampString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const timestamp = value < 1e12 ? value * 1_000 : value;
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

function contentText(content: unknown, role: TaskTailRole): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const allowedTypes = role === "user"
    ? new Set(["input_text", "text"])
    : new Set(["output_text", "text"]);
  return content.flatMap((entry) => {
    const item = recordValue(entry);
    const type = nonEmptyString(item?.type);
    if (!item || !type || !allowedTypes.has(type) || typeof item.text !== "string") {
      return [];
    }
    return [item.text];
  }).join("\n").trim();
}

function projectCodexUserText(text: string): string {
  let projected = text.trim();
  const requestMarker = "## My request for Codex:";
  const markerIndex = projected.lastIndexOf(requestMarker);
  if (markerIndex >= 0) {
    projected = projected.slice(markerIndex + requestMarker.length).trim();
  }

  const injectedTags = [
    "recommended_plugins",
    "environment_context",
    "in-app-browser-context",
    "permissions instructions",
    "apps_instructions",
    "plugins_instructions",
    "skills_instructions",
  ];
  let removed = true;
  while (projected && removed) {
    removed = false;
    for (const tag of injectedTags) {
      const opening = new RegExp(`^<${tag}(?:\\s[^>]*)?>`, "u").exec(projected);
      if (!opening) {
        continue;
      }
      const closing = `</${tag}>`;
      const closingIndex = projected.indexOf(closing, opening[0].length);
      if (closingIndex < 0) {
        return "";
      }
      projected = projected.slice(closingIndex + closing.length).trim();
      removed = true;
      break;
    }
  }

  if (projected.startsWith("# AGENTS.md instructions for ")) {
    return "";
  }
  return projected;
}

function isFinalAssistantPhase(value: unknown): boolean {
  const phase = nonEmptyString(value);
  return phase === undefined || phase === "final" || phase === "final_answer";
}

function candidateTurnId(
  payload: Record<string, unknown>,
  currentTurnId: string | undefined,
): string | undefined {
  const internalMetadata = recordValue(payload.internal_chat_message_metadata_passthrough);
  return nonEmptyString(payload.turn_id)
    ?? nonEmptyString(internalMetadata?.turn_id)
    ?? currentTurnId;
}

function messageFingerprint(role: TaskTailRole, turnId: string | undefined, text: string): string {
  return createHash("sha256")
    .update(role)
    .update("\0")
    .update(turnId ?? "")
    .update("\0")
    .update(text)
    .digest("base64url")
    .slice(0, 32);
}

function derivedMessageId(
  taskId: string,
  role: TaskTailRole,
  turnId: string | undefined,
  lineOffset: number,
  text: string,
): string {
  const digest = createHash("sha256")
    .update(taskId)
    .update("\0")
    .update(role)
    .update("\0")
    .update(turnId ?? "")
    .update("\0")
    .update(String(lineOffset))
    .update("\0")
    .update(text)
    .digest("base64url")
    .slice(0, 24);
  return `codex:${taskId}:${digest}`;
}

function lastRegexMatch(pattern: RegExp, value: string): RegExpExecArray | null {
  let last: RegExpExecArray | null = null;
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    last = match;
  }
  return last;
}

function decodeJsonStringSuffix(value: string): string | null {
  for (let skip = 0; skip <= Math.min(8, value.length); skip += 1) {
    try {
      const decoded = JSON.parse(`"${value.slice(skip)}"`) as unknown;
      if (typeof decoded === "string") {
        return decoded;
      }
    } catch {
      // A tail window can begin in the middle of an escape. Advance only a
      // bounded number of bytes until the remaining JSON-string suffix is valid.
    }
  }
  return null;
}

/**
 * A final assistant record can itself exceed the source budget. Codex writes
 * `phase` after the content array, so the bounded suffix still proves the role
 * and finality without scanning the skipped middle of the line. Return that
 * deterministic suffix marked as truncated; other partial record kinds fail
 * closed and are ignored.
 */
function partialFinalAssistantCandidate(
  line: SourceLine,
  taskId: string,
  currentTurnId: string | undefined,
): CandidateMessage | null {
  const marker = lastRegexMatch(/"\}\]\s*,\s*"phase"\s*:\s*"(?:final|final_answer)"/gu, line.text);
  if (!marker || marker.index <= 0) {
    return null;
  }
  const explicitRole = /"role"\s*:\s*"(user|assistant|developer|system)"/u.exec(line.text)?.[1];
  if (explicitRole && explicitRole !== "assistant") {
    return null;
  }

  let encodedText = line.text.slice(0, marker.index);
  const textMarker = lastRegexMatch(/"text"\s*:\s*"/gu, encodedText);
  if (textMarker) {
    encodedText = encodedText.slice(textMarker.index + textMarker[0].length);
  }
  const decoded = decodeJsonStringSuffix(encodedText);
  if (!decoded) {
    return null;
  }
  const text = projectCodexAssistantText(decoded).text;
  if (!text) {
    return null;
  }

  const turnIdMatch = /"turn_id"\s*:\s*"((?:[^"\\]|\\.)*)"/u.exec(line.text.slice(marker.index));
  const turnId = turnIdMatch
    ? decodeJsonStringSuffix(turnIdMatch[1]!) ?? currentTurnId
    : currentTurnId;
  const id = /"id"\s*:\s*"([^"\\]+)"/u.exec(line.text)?.[1]
    ?? derivedMessageId(taskId, "assistant", turnId, line.startOffset, text);
  return {
    message: {
      id,
      role: "assistant",
      text,
      ...(turnId ? { turnId } : {}),
      truncated: true,
    },
    dedupeKey: messageFingerprint("assistant", turnId, text),
    priority: 2,
    startOffset: line.startOffset,
    endOffset: line.endOffset,
  };
}

function parseCodexLines(
  lines: SourceLine[],
  taskId: string,
  initialTurnId?: string,
): ParsedCodexLines {
  const candidates: CandidateMessage[] = [];
  const observedTaskIds = new Set<string>();
  let currentTurnId = initialTurnId;

  for (const line of lines) {
    if (line.partial) {
      const partial = partialFinalAssistantCandidate(line, taskId, currentTurnId);
      if (partial) {
        candidates.push(partial);
      }
      continue;
    }
    let record: Record<string, unknown> | null = null;
    try {
      record = recordValue(JSON.parse(line.text) as unknown);
    } catch {
      continue;
    }
    if (!record) {
      continue;
    }
    const entryType = nonEmptyString(record.type);
    const payload = recordValue(record.payload);
    if (!entryType || !payload) {
      continue;
    }
    if (entryType === "compacted") {
      continue;
    }
    if (entryType === "session_meta") {
      const observedTaskId = nonEmptyString(payload.id);
      if (observedTaskId) {
        observedTaskIds.add(observedTaskId);
      }
      continue;
    }
    if (entryType === "event_msg") {
      const payloadType = nonEmptyString(payload.type);
      if (payloadType === "task_started") {
        currentTurnId = nonEmptyString(payload.turn_id) ?? currentTurnId;
        continue;
      }
      if (payloadType === "task_complete") {
        currentTurnId = undefined;
        continue;
      }
      const role: TaskTailRole | null = payloadType === "user_message"
        ? "user"
        : payloadType === "agent_message" && isFinalAssistantPhase(payload.phase)
          ? "assistant"
          : null;
      if (!role || typeof payload.message !== "string") {
        continue;
      }
      let text = payload.message.trim();
      if (role === "assistant") {
        text = projectCodexAssistantText(text).text;
      } else {
        text = projectCodexUserText(text);
      }
      if (!text) {
        continue;
      }
      const turnId = candidateTurnId(payload, currentTurnId);
      const sourceId = nonEmptyString(payload.id) ?? nonEmptyString(record.id);
      candidates.push({
        message: {
          id: sourceId ?? derivedMessageId(taskId, role, turnId, line.startOffset, text),
          role,
          text,
          ...(timestampString(record.timestamp) ? { timestamp: timestampString(record.timestamp) } : {}),
          ...(turnId ? { turnId } : {}),
        },
        dedupeKey: messageFingerprint(role, turnId, text),
        priority: 1,
        startOffset: line.startOffset,
        endOffset: line.endOffset,
      });
      continue;
    }
    if (entryType !== "response_item" || payload.type !== "message") {
      continue;
    }
    const role = payload.role === "user"
      ? "user"
      : payload.role === "assistant" && isFinalAssistantPhase(payload.phase)
        ? "assistant"
        : null;
    if (!role) {
      continue;
    }
    let text = contentText(payload.content, role);
    if (role === "assistant") {
      text = projectCodexAssistantText(text).text;
    } else {
      text = projectCodexUserText(text);
    }
    if (!text) {
      continue;
    }
    const turnId = candidateTurnId(payload, currentTurnId);
    const sourceId = nonEmptyString(payload.id) ?? nonEmptyString(record.id);
    candidates.push({
      message: {
        id: sourceId ?? derivedMessageId(taskId, role, turnId, line.startOffset, text),
        role,
        text,
        ...(timestampString(record.timestamp) ? { timestamp: timestampString(record.timestamp) } : {}),
        ...(turnId ? { turnId } : {}),
      },
      dedupeKey: messageFingerprint(role, turnId, text),
      priority: 2,
      startOffset: line.startOffset,
      endOffset: line.endOffset,
    });
  }

  return { candidates, currentTurnId, observedTaskIds };
}

function dedupeCandidates(
  candidates: CandidateMessage[],
  previouslySeen: ReadonlySet<string>,
): CandidateMessage[] {
  const deduped: CandidateMessage[] = [];
  const indexByKey = new Map<string, number>();
  for (const candidate of candidates) {
    if (previouslySeen.has(candidate.dedupeKey)) {
      continue;
    }
    const existingIndex = indexByKey.get(candidate.dedupeKey);
    if (existingIndex === undefined) {
      indexByKey.set(candidate.dedupeKey, deduped.length);
      deduped.push(candidate);
      continue;
    }
    if (candidate.priority > deduped[existingIndex]!.priority) {
      deduped[existingIndex] = candidate;
    }
  }
  return deduped;
}

function rememberSeen(existing: string[], additions: string[]): string[] {
  const ordered = [...existing];
  for (const fingerprint of additions) {
    const prior = ordered.indexOf(fingerprint);
    if (prior >= 0) {
      ordered.splice(prior, 1);
    }
    ordered.push(fingerprint);
  }
  return ordered.slice(-MAX_CURSOR_SEEN_FINGERPRINTS);
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  const ellipsis = Buffer.byteLength("…", "utf8") <= maxBytes ? "…" : "";
  const contentBudget = maxBytes - Buffer.byteLength(ellipsis, "utf8");
  const output: string[] = [];
  let used = 0;
  const codePoints = Array.from(text);
  for (let index = codePoints.length - 1; index >= 0; index -= 1) {
    const codePoint = codePoints[index]!;
    const size = Buffer.byteLength(codePoint, "utf8");
    if (used + size > contentBudget) {
      break;
    }
    output.push(codePoint);
    used += size;
  }
  return `${ellipsis}${output.reverse().join("")}`;
}

function applyInitialOutputLimits(
  candidates: CandidateMessage[],
  maxMessages: number,
  maxBytes: number,
): { messages: TaskTailMessage[]; outputTruncated: boolean; selected: CandidateMessage[] } {
  const byCount = candidates.slice(-maxMessages);
  const selected: CandidateMessage[] = [];
  const messages: TaskTailMessage[] = [];
  let remainingBytes = maxBytes;
  let outputTruncated = candidates.length > byCount.length;

  for (let index = byCount.length - 1; index >= 0; index -= 1) {
    const candidate = byCount[index]!;
    const textBytes = Buffer.byteLength(candidate.message.text, "utf8");
    if (textBytes <= remainingBytes) {
      selected.unshift(candidate);
      messages.unshift(candidate.message);
      remainingBytes -= textBytes;
      continue;
    }
    if (remainingBytes > 0) {
      const text = truncateUtf8(candidate.message.text, remainingBytes);
      selected.unshift(candidate);
      messages.unshift({ ...candidate.message, text, truncated: true });
    }
    outputTruncated = true;
    break;
  }
  return { messages, outputTruncated, selected };
}

function applyForwardOutputLimits(
  candidates: CandidateMessage[],
  maxMessages: number,
  maxBytes: number,
): {
  messages: TaskTailMessage[];
  selected: CandidateMessage[];
  firstWithheld?: CandidateMessage;
  outputTruncated: boolean;
} {
  const messages: TaskTailMessage[] = [];
  const selected: CandidateMessage[] = [];
  let remainingBytes = maxBytes;
  let outputTruncated = false;

  for (const candidate of candidates) {
    if (messages.length >= maxMessages) {
      return { messages, selected, firstWithheld: candidate, outputTruncated: true };
    }
    const textBytes = Buffer.byteLength(candidate.message.text, "utf8");
    if (textBytes <= remainingBytes) {
      selected.push(candidate);
      messages.push(candidate.message);
      remainingBytes -= textBytes;
      continue;
    }
    if (remainingBytes > 0) {
      const text = truncateUtf8(candidate.message.text, remainingBytes);
      selected.push(candidate);
      messages.push({ ...candidate.message, text, truncated: true });
      remainingBytes = 0;
      outputTruncated = true;
      continue;
    }
    return { messages, selected, firstWithheld: candidate, outputTruncated: true };
  }
  return { messages, selected, outputTruncated };
}

function assertTaskIdentity(taskId: string, expectedTaskId: string | undefined): void {
  if (expectedTaskId !== undefined && expectedTaskId !== taskId) {
    throw taskTailError(
      "TASK_MISMATCH",
      `Task transcript identity ${JSON.stringify(taskId)} does not match expected task ${JSON.stringify(expectedTaskId)}.`,
    );
  }
}

function assertObservedTaskIds(taskId: string, observedTaskIds: ReadonlySet<string>): void {
  for (const observed of observedTaskIds) {
    if (observed !== taskId) {
      throw taskTailError(
        "TASK_MISMATCH",
        `Codex session_meta task ${JSON.stringify(observed)} does not match proven task ${JSON.stringify(taskId)}.`,
      );
    }
  }
}

function taskIdFromHead(buffer: Buffer): string | undefined {
  const lines = sourceLines(buffer, 0, true);
  for (const line of lines) {
    try {
      const record = recordValue(JSON.parse(line.text) as unknown);
      const payload = recordValue(record?.payload);
      if (record?.type === "session_meta") {
        const taskId = nonEmptyString(payload?.id);
        if (taskId && taskId.length <= MAX_TASK_ID_LENGTH) {
          return taskId;
        }
      }
    } catch {
      // Continue through the bounded metadata prefix.
    }
  }
  return undefined;
}

function completedEnd(lines: SourceLine[], fallbackOffset: number): number {
  return lines.at(-1)?.endOffset ?? fallbackOffset;
}

function readInitialTail(
  path: string,
  source: OpenSource,
  adapterType: TaskTailAdapterType,
  expectedTaskId: string | undefined,
  maxMessages: number,
  maxBytes: number,
  maxScanBytes: number,
): TaskTailResult {
  const pathTaskId = codexTaskIdFromPath(path);
  let taskId: string | undefined;
  let bytesRead = source.identityBytesRead;
  let tailBuffer: Buffer;
  let tailStart: number;
  let knownBoundary: boolean;
  let maxTailReadBytes = Math.min(maxScanBytes, source.fileSize);

  if (source.fileSize <= maxScanBytes) {
    tailStart = 0;
    tailBuffer = readAt(source.fd, 0, source.fileSize);
    bytesRead += tailBuffer.length;
    knownBoundary = true;
    taskId = taskIdFromHead(tailBuffer) ?? pathTaskId;
  } else {
    const headBudget = Math.min(
      HEAD_TASK_ID_READ_BYTES,
      Math.max(1, Math.floor(maxScanBytes / 4)),
    );
    const headBuffer = readAt(source.fd, 0, headBudget);
    bytesRead += headBuffer.length;
    taskId = taskIdFromHead(headBuffer) ?? pathTaskId;
    const tailCapacity = Math.max(0, maxScanBytes - headBuffer.length);
    maxTailReadBytes = tailCapacity;
    const initialTailBudget = Math.min(tailCapacity, maxBytes);
    tailStart = source.fileSize - initialTailBudget;
    tailBuffer = readAt(source.fd, tailStart, initialTailBudget);
    bytesRead += tailBuffer.length;
    knownBoundary = false;
  }

  if (!taskId) {
    throw taskTailError(
      "TASK_ID_UNPROVEN",
      "Cannot prove the Codex task id from session_meta or the rollout filename within the bounded read budget.",
    );
  }
  if (pathTaskId && pathTaskId !== taskId) {
    throw taskTailError(
      "TASK_MISMATCH",
      `Codex session_meta task ${JSON.stringify(taskId)} does not match rollout filename task ${JSON.stringify(pathTaskId)}.`,
    );
  }
  assertTaskIdentity(taskId, expectedTaskId);

  let lines = sourceLines(tailBuffer, tailStart, knownBoundary);
  let parsed = parseCodexLines(lines, taskId);
  let deduped = dedupeCandidates(parsed.candidates, new Set());
  while (
    !knownBoundary
    && deduped.length < maxMessages
    && tailBuffer.length < maxTailReadBytes
    && tailStart > 0
  ) {
    const targetLength = Math.min(
      maxTailReadBytes,
      tailBuffer.length + Math.max(1, Math.min(tailBuffer.length, TAIL_GROWTH_MAX_BYTES)),
    );
    const additionalLength = Math.min(targetLength - tailBuffer.length, tailStart);
    const additionalStart = tailStart - additionalLength;
    const additional = readAt(source.fd, additionalStart, additionalLength);
    tailBuffer = Buffer.concat([additional, tailBuffer]);
    tailStart = additionalStart;
    bytesRead += additional.length;
    knownBoundary = tailStart === 0;
    lines = sourceLines(tailBuffer, tailStart, knownBoundary);
    parsed = parseCodexLines(lines, taskId);
    deduped = dedupeCandidates(parsed.candidates, new Set());
  }

  assertObservedTaskIds(taskId, parsed.observedTaskIds);
  const limited = applyInitialOutputLimits(deduped, maxMessages, maxBytes);
  const tailLastNewline = tailBuffer.lastIndexOf(0x0a);
  const cursorOffset = completedEnd(
    lines,
    knownBoundary
      ? tailStart
      : tailLastNewline >= 0
        ? tailStart + tailLastNewline + 1
        : source.fileSize,
  );
  const discardingLine = !knownBoundary && tailLastNewline < 0;
  const seen = rememberSeen([], deduped.map((candidate) => candidate.dedupeKey));
  const cursor = encodeCursor({
    adapterType,
    taskId,
    identity: source.identity,
    offset: cursorOffset,
    ...(parsed.currentTurnId ? { turnId: parsed.currentTurnId } : {}),
    ...(seen.length > 0 ? { seen } : {}),
    ...(discardingLine ? { discardingLine: true } : {}),
  });

  assertSourceStillCurrent(path, source, source.fileSize);
  return {
    adapterType,
    taskId,
    messages: limited.messages,
    cursor,
    truncated: tailStart > 0 || limited.outputTruncated,
    source: {
      path,
      identity: source.identity,
      startOffset: tailStart,
      endOffset: source.fileSize,
      bytesRead,
      fileSize: source.fileSize,
    },
  };
}

function readForwardTail(
  path: string,
  source: OpenSource,
  adapterType: TaskTailAdapterType,
  expectedTaskId: string | undefined,
  cursor: ParsedCursor,
  maxMessages: number,
  maxBytes: number,
  maxScanBytes: number,
): TaskTailResult {
  if (cursor.offset > source.fileSize) {
    throw taskTailError("SOURCE_TRUNCATED", "Task transcript is shorter than the cursor offset.");
  }
  if (!cursorIdentityMatchesSource(cursor.identity, source)) {
    throw taskTailError("SOURCE_REPLACED", "Task transcript file identity no longer matches the cursor.");
  }
  if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0) {
    throw taskTailError("CURSOR_OFFSET_INVALID", "Task-tail cursor offset is invalid.");
  }
  const pathTaskId = codexTaskIdFromPath(path);
  if (pathTaskId && pathTaskId !== cursor.taskId) {
    throw taskTailError("CURSOR_TASK_MISMATCH", "Task-tail cursor does not match the rollout filename task id.");
  }
  assertTaskIdentity(cursor.taskId, expectedTaskId);

  let boundaryBytesRead = 0;
  if (cursor.offset > 0 && !cursor.discardingLine) {
    const boundary = readAt(source.fd, cursor.offset - 1, 1);
    boundaryBytesRead = boundary.length;
    if (boundary.length !== 1 || boundary[0] !== 0x0a) {
      throw taskTailError(
        "CURSOR_OFFSET_INVALID",
        "Task-tail cursor offset is not positioned after a completed JSONL record.",
      );
    }
  }
  const readLength = Math.min(
    Math.max(0, maxScanBytes - boundaryBytesRead),
    source.fileSize - cursor.offset,
  );
  const buffer = readAt(source.fd, cursor.offset, readLength);
  const lines = sourceLines(buffer, cursor.offset, !cursor.discardingLine);
  const lastNewline = buffer.lastIndexOf(0x0a);
  let completeEndOffset = completedEnd(lines, cursor.offset);
  let discardingLine = false;
  if (completeEndOffset === cursor.offset && buffer.length > 0) {
    if (cursor.discardingLine && lastNewline >= 0) {
      completeEndOffset = cursor.offset + lastNewline + 1;
    } else if (lastNewline < 0) {
      completeEndOffset = cursor.offset + buffer.length;
      discardingLine = true;
    }
  }
  const parsed = parseCodexLines(lines, cursor.taskId, cursor.turnId);
  assertObservedTaskIds(cursor.taskId, parsed.observedTaskIds);
  const priorSeen = new Set(cursor.seen);
  const deduped = dedupeCandidates(parsed.candidates, priorSeen);
  const limited = applyForwardOutputLimits(deduped, maxMessages, maxBytes);
  const nextOffset = limited.firstWithheld?.startOffset ?? completeEndOffset;
  const processedFingerprints = parsed.candidates
    .filter((candidate) => candidate.endOffset <= nextOffset)
    .map((candidate) => candidate.dedupeKey);
  const seen = rememberSeen(cursor.seen, processedFingerprints);
  const nextTurnId = limited.firstWithheld?.message.turnId ?? parsed.currentTurnId;
  const replacementCursor = encodeCursor({
    adapterType,
    taskId: cursor.taskId,
    identity: source.identity,
    offset: nextOffset,
    ...(nextTurnId ? { turnId: nextTurnId } : {}),
    ...(seen.length > 0 ? { seen } : {}),
    ...(limited.firstWithheld === undefined && discardingLine ? { discardingLine: true } : {}),
  });

  assertSourceStillCurrent(path, source, source.fileSize);
  return {
    adapterType,
    taskId: cursor.taskId,
    messages: limited.messages,
    cursor: replacementCursor,
    truncated: limited.outputTruncated || cursor.offset + buffer.length < source.fileSize,
    source: {
      path,
      identity: source.identity,
      startOffset: cursor.offset,
      endOffset: cursor.offset + buffer.length,
      bytesRead: source.identityBytesRead + boundaryBytesRead + buffer.length,
      fileSize: source.fileSize,
    },
  };
}

/**
 * Read a bounded projection of user and final-assistant messages from a
 * harness-owned task transcript. This function is read-only and never writes
 * transcript content to Scout broker state.
 */
export function readTaskTail(input: TaskTailInput): TaskTailResult {
  if (!input || typeof input !== "object") {
    throw taskTailError("INVALID_INPUT", "Task-tail input is required.");
  }
  if (typeof input.path !== "string" || !input.path.trim()) {
    throw taskTailError("INVALID_INPUT", "Task-tail path must be a non-empty string.");
  }
  const expectedTaskId = input.expectedTaskId === undefined
    ? undefined
    : nonEmptyString(input.expectedTaskId);
  if (
    input.expectedTaskId !== undefined
    && (!expectedTaskId || expectedTaskId.length > MAX_TASK_ID_LENGTH)
  ) {
    throw taskTailError("INVALID_INPUT", "expectedTaskId must be a non-empty bounded string.");
  }
  const maxMessages = normalizedLimit(
    "maxMessages",
    input.maxMessages,
    DEFAULT_TASK_TAIL_MAX_MESSAGES,
    MAX_TASK_TAIL_MESSAGES,
  );
  const maxBytes = normalizedLimit(
    "maxBytes",
    input.maxBytes,
    DEFAULT_TASK_TAIL_MAX_BYTES,
    MAX_TASK_TAIL_BYTES,
  );
  const maxScanBytes = normalizedLimit(
    "maxScanBytes",
    input.maxScanBytes,
    DEFAULT_TASK_TAIL_MAX_SCAN_BYTES,
    MAX_TASK_TAIL_SCAN_BYTES,
  );
  const parsedCursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  const path = resolve(input.path);
  const adapterType = resolveAdapterType(input.adapterType, path, parsedCursor);
  const source = openSource(path);
  try {
    return parsedCursor
      ? readForwardTail(
        path,
        source,
        adapterType,
        expectedTaskId,
        parsedCursor,
        maxMessages,
        maxBytes,
        maxScanBytes,
      )
      : readInitialTail(
        path,
        source,
        adapterType,
        expectedTaskId,
        maxMessages,
        maxBytes,
        maxScanBytes,
      );
  } finally {
    closeSync(source.fd);
  }
}
