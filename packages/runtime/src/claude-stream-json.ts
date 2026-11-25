import { appendBoundedLog } from "@openscout/agent-sessions/local/bounded-log";
import type { RuntimeTimer } from "./portable-types.js";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  Action,
  ActionBlock,
  BlockState,
  QuestionBlock,
  SessionState,
  TextBlock,
  ReasoningBlock,
  TurnState,
} from "@openscout/agent-sessions";
import { redactSecrets } from "@openscout/agent-sessions/secret-redaction";
import { buildManagedAgentEnvironment } from "./managed-agent-environment.js";
import { RequesterWaitTimeoutError } from "./requester-timeout.js";
import { resolveClaudeExecutable } from "./tool-resolution.js";

type SessionRequestOptions = {
  agentName: string;
  sessionId: string;
  cwd: string;
  systemPrompt: string;
  runtimeDirectory: string;
  logsDirectory: string;
  launchArgs?: string[];
  crewRole?: string;
};

type InvocationOptions = SessionRequestOptions & {
  prompt: string;
  timeoutMs?: number;
};

type InterruptOptions = SessionRequestOptions;

type ActiveTurn = {
  id: string;
  output: string[];
  resolve: (output: string) => void;
  reject: (error: Error) => void;
};

type ClaudeEvent =
  | { type: "system"; subtype?: string; session_id?: string; sessionId?: string }
  | { type: "assistant"; message?: { content?: Array<{ type?: string; text?: string }> }; content?: Array<{ type?: string; text?: string }> }
  | { type: "result"; subtype?: string; result?: string; is_error?: boolean; errors?: string[]; error?: { message?: string }; message?: string }
  | { type: "error"; error?: { message?: string }; message?: string };

export type ClaudeSessionSnapshotOptions = Pick<
  SessionRequestOptions,
  "agentName" | "sessionId" | "cwd"
>;

function resolveRequesterTimeoutMs(timeoutMs: number | undefined): number | null {
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return timeoutMs;
  }

  return null;
}

function waitForRequesterResult<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  label: string,
): Promise<T> {
  const effectiveTimeoutMs = resolveRequesterTimeoutMs(timeoutMs);
  if (effectiveTimeoutMs === null) {
    return promise;
  }

  let timer: RuntimeTimer | null = null;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new RequesterWaitTimeoutError({ label, timeoutMs: effectiveTimeoutMs }));
    }, effectiveTimeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

export function resolveClaudeStreamJsonOutput(
  result: string | undefined,
  fallbackParts: string[],
): string {
  const trimmedResult = result?.trim();
  if (trimmedResult) {
    return trimmedResult;
  }
  return fallbackParts.join("").trim();
}

function claudeResultErrorMessage(event: Extract<ClaudeEvent, { type: "result" }>): string | null {
  const errors = Array.isArray(event.errors)
    ? event.errors.map((entry) => entry.trim()).filter(Boolean)
    : [];
  if (
    event.is_error === true
    || event.subtype === "error_during_execution"
    || errors.length > 0
  ) {
    return errors.join("; ")
      || event.error?.message
      || event.message
      || event.subtype
      || "Claude stream-json result reported an error";
  }

  return null;
}

function emptyClaudeOutputError(): Error {
  return new Error("Claude stream-json completed without broker-visible output.");
}

function isMissingClaudeConversationError(error: unknown): boolean {
  return errorMessage(error).toLowerCase().includes("no conversation found with session id");
}

function sessionKey(options: SessionRequestOptions): string {
  return `${options.agentName}:${options.sessionId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const trimmed = raw.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  const trimmed = value?.trim();
  if (!trimmed) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/* ── Session catalog ── */

export type SessionCatalogEntry = {
  id: string;
  startedAt: number;
  endedAt?: number;
  cwd: string;
  harness?: string;
  transport?: string;
  model?: string | null;
  reasoningEffort?: string | null;
};

export type SessionCatalog = {
  activeSessionId: string | null;
  sessions: SessionCatalogEntry[];
};

const SESSION_CATALOG_FILENAME = "session-catalog.json";
const SESSION_CATALOG_MAX_ENTRIES = 64;

export function readSessionCatalogSync(runtimeDirectory: string): SessionCatalog {
  const catalogPath = join(runtimeDirectory, SESSION_CATALOG_FILENAME);
  try {
    if (!existsSync(catalogPath)) {
      const legacyPath = join(runtimeDirectory, "claude-session-id.txt");
      if (existsSync(legacyPath)) {
        const legacyId = readFileSync(legacyPath, "utf8").trim();
        if (legacyId) {
          return {
            activeSessionId: legacyId,
            sessions: [{ id: legacyId, startedAt: Date.now(), cwd: "" }],
          };
        }
      }
      return { activeSessionId: null, sessions: [] };
    }
    const raw = readFileSync(catalogPath, "utf8").trim();
    if (!raw) return { activeSessionId: null, sessions: [] };
    const parsed = JSON.parse(raw) as SessionCatalog;
    return {
      activeSessionId: parsed.activeSessionId ?? null,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch {
    return { activeSessionId: null, sessions: [] };
  }
}

// Catalog read-modify-write cycles are serialized per runtime directory so a
// reset can never be overtaken by an earlier init record, and shutdown can
// drain pending writes before callers tear the directory down.
const sessionCatalogWriteTails = new Map<string, Promise<void>>();

async function drainSessionCatalogWrites(runtimeDirectory: string): Promise<void> {
  let tail = sessionCatalogWriteTails.get(runtimeDirectory);
  while (tail) {
    await tail;
    const next = sessionCatalogWriteTails.get(runtimeDirectory);
    tail = next === tail ? undefined : next;
  }
}

async function readSessionCatalog(runtimeDirectory: string): Promise<SessionCatalog> {
  await drainSessionCatalogWrites(runtimeDirectory);
  return readSessionCatalogSync(runtimeDirectory);
}

async function writeSessionCatalogAtomic(runtimeDirectory: string, catalog: SessionCatalog): Promise<void> {
  const catalogPath = join(runtimeDirectory, SESSION_CATALOG_FILENAME);
  const tempPath = `${catalogPath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(runtimeDirectory, { recursive: true });
  try {
    await writeFile(tempPath, JSON.stringify(catalog, null, 2) + "\n");
    await rename(tempPath, catalogPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

// Without reportError the failure rejects the returned promise. With it, the
// report runs inside the queue so drains also cover the error reporting.
function updateSessionCatalog(
  runtimeDirectory: string,
  mutate: (catalog: SessionCatalog) => SessionCatalog,
  reportError?: (error: unknown) => Promise<void>,
): Promise<void> {
  const previous = sessionCatalogWriteTails.get(runtimeDirectory) ?? Promise.resolve();
  const write = previous.then(() =>
    writeSessionCatalogAtomic(runtimeDirectory, mutate(readSessionCatalogSync(runtimeDirectory))),
  );
  const operation = reportError ? write.catch(reportError) : write;
  const tail = operation.then(() => undefined, () => undefined);
  sessionCatalogWriteTails.set(runtimeDirectory, tail);
  void tail.then(() => {
    if (sessionCatalogWriteTails.get(runtimeDirectory) === tail) {
      sessionCatalogWriteTails.delete(runtimeDirectory);
    }
  });
  return operation;
}

function clearActiveSession(catalog: SessionCatalog): SessionCatalog {
  return { ...catalog, activeSessionId: null };
}

function catalogRecordSession(
  catalog: SessionCatalog,
  sessionId: string,
  cwd: string,
): SessionCatalog {
  const now = Date.now();

  const sessions = catalog.sessions.map((s) =>
    s.id === catalog.activeSessionId && !s.endedAt
      ? { ...s, endedAt: now }
      : s,
  );

  if (!sessions.some((s) => s.id === sessionId)) {
    sessions.push({ id: sessionId, startedAt: now, cwd });
  }

  while (sessions.length > SESSION_CATALOG_MAX_ENTRIES) {
    sessions.shift();
  }

  return { activeSessionId: sessionId, sessions };
}

function appendActionOutput(blockState: BlockState | undefined, output: string): void {
  if (!blockState || blockState.block.type !== "action" || !output) {
    return;
  }

  const actionBlock = blockState.block as ActionBlock;
  actionBlock.action.output += output;
}

function updateBlockCompletion(blockState: BlockState | undefined, completed: boolean): void {
  if (!blockState) {
    return;
  }

  blockState.status = completed ? "completed" : "streaming";
  blockState.block.status = completed ? "completed" : "streaming";
}

function parseQuestionAnswer(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => typeof entry === "string" ? entry.trim() : String(entry).trim())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  if (value == null) {
    return [];
  }

  return [String(value)];
}

function isClaudeSessionGlobalEvent(event: Record<string, unknown>): boolean {
  return event.type === "system" && event.subtype === "init";
}

function stringifyToolResultContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => stringifyToolResultContent(entry)).filter(Boolean).join("\n");
  }

  if (value == null) {
    return "";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildClaudeAction(toolName: string, toolUseId: string, input: Record<string, unknown>): Action {
  if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") {
    return {
      kind: "file_change",
      path: typeof input.file_path === "string"
        ? input.file_path
        : typeof input.path === "string"
          ? input.path
          : "",
      diff: "",
      status: "running",
      output: "",
    };
  }

  if (toolName === "Bash") {
    return {
      kind: "command",
      command: typeof input.command === "string" ? input.command : "",
      status: "running",
      output: "",
    };
  }

  if (toolName === "Agent") {
    return {
      kind: "subagent",
      agentId: toolUseId,
      agentName: typeof input.description === "string" ? input.description : undefined,
      prompt: typeof input.prompt === "string" ? input.prompt : undefined,
      status: "running",
      output: "",
    };
  }

  return {
    kind: "tool_call",
    toolName,
    toolCallId: toolUseId,
    input,
    status: "running",
    output: "",
  };
}

export function buildClaudeStreamJsonSessionSnapshot(
  raw: string,
  options: ClaudeSessionSnapshotOptions,
  targetClaudeSessionId?: string | null,
): SessionState | null {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let resolvedSessionId = targetClaudeSessionId?.trim() || null;
  if (!resolvedSessionId) {
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const nextSessionId = typeof event.session_id === "string"
          ? event.session_id
          : typeof event.sessionId === "string"
            ? event.sessionId
            : null;
        if (event.type === "system" && event.subtype === "init" && nextSessionId) {
          resolvedSessionId = nextSessionId;
        } else if (!resolvedSessionId && nextSessionId) {
          resolvedSessionId = nextSessionId;
        }
      } catch {
        // Ignore malformed history lines in snapshot mode.
      }
    }
  }

  const snapshot: SessionState = {
    session: {
      id: options.sessionId,
      name: options.agentName,
      adapterType: "claude_stream_json",
      status: "idle",
      cwd: options.cwd,
      providerMeta: resolvedSessionId ? { transportSessionId: resolvedSessionId } : undefined,
    },
    turns: [],
  };

  type PendingToolBlock = {
    toolUseId: string;
    toolName: string;
    input: Record<string, unknown>;
    inputJson: string;
    blockIndex: number;
  };

  let currentTurn: (TurnState & { nextBlockIndex: number; nextMessageIndex: number }) | null = null;
  const blockById = new Map<string, BlockState>();
  let activeContentBlocks = new Map<number, BlockState>();
  let pendingToolBlocks = new Map<number, PendingToolBlock>();

  const startTurn = () => {
    const turn: TurnState & { nextBlockIndex: number; nextMessageIndex: number } = {
      id: `${options.sessionId}:turn:${snapshot.turns.length + 1}`,
      status: "streaming",
      blocks: [],
      startedAt: Date.now(),
      nextBlockIndex: 0,
      nextMessageIndex: 0,
    };
    snapshot.turns.push(turn);
    snapshot.currentTurnId = turn.id;
    currentTurn = turn;
    activeContentBlocks = new Map();
    pendingToolBlocks = new Map();
    snapshot.session.status = "active";
    return turn;
  };

  const ensureTurn = () => currentTurn ?? startTurn();

  const startTextualBlock = (type: "text" | "reasoning", index: number, initialText = ""): BlockState => {
    const turn = ensureTurn();
    const blockId = `${turn.id}:m${turn.nextMessageIndex}:i${index}`;
    const block = type === "text"
      ? {
          id: blockId,
          turnId: turn.id,
          index: turn.nextBlockIndex++,
          type: "text",
          text: initialText,
          status: "streaming",
        } satisfies TextBlock
      : {
          id: blockId,
          turnId: turn.id,
          index: turn.nextBlockIndex++,
          type: "reasoning",
          text: initialText,
          status: "streaming",
        } satisfies ReasoningBlock;
    const blockState: BlockState = {
      block,
      status: "streaming",
    };
    turn.blocks.push(blockState);
    blockById.set(blockId, blockState);
    activeContentBlocks.set(index, blockState);
    return blockState;
  };

  const finalizeCurrentTurn = (status: TurnState["status"]) => {
    if (!currentTurn) {
      return;
    }

    for (const blockState of activeContentBlocks.values()) {
      updateBlockCompletion(blockState, true);
    }
    activeContentBlocks.clear();

    currentTurn.status = status;
    currentTurn.endedAt = Date.now();
    currentTurn = null;
    snapshot.currentTurnId = undefined;
    snapshot.session.status = status === "error" ? "error" : "idle";
  };

  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const eventSessionId = typeof event.session_id === "string"
      ? event.session_id
      : typeof event.sessionId === "string"
        ? event.sessionId
        : null;
    if (resolvedSessionId) {
      if (eventSessionId && eventSessionId !== resolvedSessionId) {
        continue;
      }
      if (!eventSessionId && !isClaudeSessionGlobalEvent(event)) {
        continue;
      }
    }

    if (event.type === "system" && event.subtype === "init") {
      if (typeof event.model === "string" && event.model.trim()) {
        snapshot.session.model = event.model;
      }
      const observedEffort = typeof event.effort === "string"
        ? event.effort
        : typeof event.reasoning_effort === "string"
          ? event.reasoning_effort
          : typeof event.thinking_level === "string"
            ? event.thinking_level
            : null;
      if (observedEffort?.trim()) {
        snapshot.session.reasoningEffort = observedEffort.trim();
      }
      if (typeof event.cwd === "string" && event.cwd.trim()) {
        snapshot.session.cwd = event.cwd;
      }
      snapshot.session.status = currentTurn ? "active" : "idle";
      continue;
    }

    if (event.type === "stream_event") {
      const streamEvent = event.event as Record<string, unknown> | undefined;
      const streamEventType = typeof streamEvent?.type === "string" ? streamEvent.type : "";

      if (streamEventType === "message_start") {
        const turn = ensureTurn();
        turn.nextMessageIndex += 1;
        activeContentBlocks.clear();
        pendingToolBlocks.clear();
        snapshot.session.status = "active";
        continue;
      }

      if (streamEventType === "content_block_start") {
        const turn = ensureTurn();
        const blockIndex = typeof streamEvent?.index === "number" ? streamEvent.index : 0;
        const contentBlock = streamEvent?.content_block as Record<string, unknown> | undefined;
        const contentType = typeof contentBlock?.type === "string" ? contentBlock.type : "";

        if (contentType === "thinking") {
          startTextualBlock("reasoning", blockIndex, typeof contentBlock?.thinking === "string" ? contentBlock.thinking : "");
        } else if (contentType === "text") {
          startTextualBlock("text", blockIndex, typeof contentBlock?.text === "string" ? contentBlock.text : "");
        } else if (contentType === "tool_use") {
          pendingToolBlocks.set(blockIndex, {
            toolUseId: typeof contentBlock?.id === "string" ? contentBlock.id : `${turn.id}:tool:${blockIndex}`,
            toolName: typeof contentBlock?.name === "string" ? contentBlock.name : "unknown",
            input: contentBlock?.input && typeof contentBlock.input === "object" && !Array.isArray(contentBlock.input)
              ? contentBlock.input as Record<string, unknown>
              : {},
            inputJson: "",
            blockIndex: turn.nextBlockIndex++,
          });
        }
        continue;
      }

      if (streamEventType === "content_block_delta") {
        const blockIndex = typeof streamEvent?.index === "number" ? streamEvent.index : 0;
        const delta = streamEvent?.delta as Record<string, unknown> | undefined;
        const deltaType = typeof delta?.type === "string" ? delta.type : "";

        if (deltaType === "text_delta") {
          const blockState = activeContentBlocks.get(blockIndex);
          if (blockState?.block.type === "text" && typeof delta?.text === "string") {
            (blockState.block as TextBlock).text += delta.text;
          }
          continue;
        }

        if (deltaType === "thinking_delta") {
          const blockState = activeContentBlocks.get(blockIndex);
          if (blockState?.block.type === "reasoning" && typeof delta?.thinking === "string") {
            (blockState.block as ReasoningBlock).text += delta.thinking;
          }
          continue;
        }

        if (deltaType === "input_json_delta") {
          const pending = pendingToolBlocks.get(blockIndex);
          if (pending && typeof delta?.partial_json === "string") {
            pending.inputJson += delta.partial_json;
          }
        }
        continue;
      }

      if (streamEventType === "content_block_stop") {
        const blockIndex = typeof streamEvent?.index === "number" ? streamEvent.index : 0;
        const blockState = activeContentBlocks.get(blockIndex);
        if (blockState) {
          updateBlockCompletion(blockState, true);
          activeContentBlocks.delete(blockIndex);
          continue;
        }

        const pendingTool = pendingToolBlocks.get(blockIndex);
        if (!pendingTool) {
          continue;
        }

        const turn = ensureTurn();
        const parsedInput = {
          ...pendingTool.input,
          ...parseJsonObject(pendingTool.inputJson),
        };

        if (pendingTool.toolName === "AskUserQuestion") {
          const questions = Array.isArray(parsedInput.questions)
            ? parsedInput.questions as Array<Record<string, unknown>>
            : [];
          const firstQuestion = questions[0] ?? {};
          const block: QuestionBlock = {
            id: pendingTool.toolUseId,
            turnId: turn.id,
            index: pendingTool.blockIndex,
            type: "question",
            header: typeof firstQuestion.header === "string" ? firstQuestion.header : undefined,
            question: typeof firstQuestion.question === "string" ? firstQuestion.question : "",
            options: Array.isArray(firstQuestion.options)
              ? firstQuestion.options.map((option) => {
                  if (typeof option === "string") {
                    return { label: option };
                  }

                  const optionRecord = option as Record<string, unknown>;
                  return {
                    label: typeof optionRecord.label === "string" ? optionRecord.label : String(option),
                    description: typeof optionRecord.description === "string" ? optionRecord.description : undefined,
                  };
                })
              : [],
            multiSelect: Boolean(firstQuestion.multiSelect),
            questionStatus: "awaiting_answer",
            status: "streaming",
          };
          const nextBlockState: BlockState = { block, status: "streaming" };
          turn.blocks.push(nextBlockState);
          blockById.set(block.id, nextBlockState);
        } else {
          const block: ActionBlock = {
            id: pendingTool.toolUseId,
            turnId: turn.id,
            index: pendingTool.blockIndex,
            type: "action",
            action: buildClaudeAction(pendingTool.toolName, pendingTool.toolUseId, parsedInput),
            status: "streaming",
          };
          const nextBlockState: BlockState = { block, status: "streaming" };
          turn.blocks.push(nextBlockState);
          blockById.set(block.id, nextBlockState);
        }

        pendingToolBlocks.delete(blockIndex);
      }

      continue;
    }

    if (event.type === "user") {
      const message = event.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const entry of content) {
        const result = entry as Record<string, unknown>;
        if (result.type !== "tool_result" || typeof result.tool_use_id !== "string") {
          continue;
        }

        const blockState = blockById.get(result.tool_use_id);
        if (!blockState) {
          continue;
        }

        if (blockState.block.type === "question") {
          const questionBlock = blockState.block as QuestionBlock;
          questionBlock.questionStatus = result.is_error ? "denied" : "answered";
          const answer = parseQuestionAnswer(result.content);
          questionBlock.answer = answer.length > 0 ? answer : undefined;
          updateBlockCompletion(blockState, true);
          continue;
        }

        appendActionOutput(blockState, stringifyToolResultContent(result.content));
        if (blockState.block.type === "action") {
          blockState.block.action.status = result.is_error ? "failed" : "completed";
        }
        updateBlockCompletion(blockState, true);
      }
      continue;
    }

    if (event.type === "result") {
      const permissionDenials = Array.isArray(event.permission_denials)
        ? event.permission_denials as Array<Record<string, unknown>>
        : [];
      for (const denial of permissionDenials) {
        if (denial.tool_name !== "AskUserQuestion") {
          continue;
        }

        const toolUseId = typeof denial.tool_use_id === "string" ? denial.tool_use_id : null;
        const blockState = toolUseId ? blockById.get(toolUseId) : undefined;
        if (blockState?.block.type === "question") {
          (blockState.block as QuestionBlock).questionStatus = "denied";
          updateBlockCompletion(blockState, true);
          continue;
        }

        const input = denial.tool_input && typeof denial.tool_input === "object" && !Array.isArray(denial.tool_input)
          ? denial.tool_input as Record<string, unknown>
          : {};
        const questions = Array.isArray(input.questions) ? input.questions as Array<Record<string, unknown>> : [];
        const firstQuestion = questions[0] ?? {};
        const turn = ensureTurn();
        const block: QuestionBlock = {
          id: toolUseId ?? `${turn.id}:denied:${turn.nextBlockIndex}`,
          turnId: turn.id,
          index: turn.nextBlockIndex++,
          type: "question",
          header: typeof firstQuestion.header === "string" ? firstQuestion.header : undefined,
          question: typeof firstQuestion.question === "string" ? firstQuestion.question : "",
          options: Array.isArray(firstQuestion.options)
            ? firstQuestion.options.map((option) => {
                if (typeof option === "string") {
                  return { label: option };
                }

                const optionRecord = option as Record<string, unknown>;
                return {
                  label: typeof optionRecord.label === "string" ? optionRecord.label : String(option),
                  description: typeof optionRecord.description === "string" ? optionRecord.description : undefined,
                };
              })
            : [],
          multiSelect: Boolean(firstQuestion.multiSelect),
          questionStatus: "denied",
          status: "completed",
        };
        const deniedBlock: BlockState = { block, status: "completed" };
        turn.blocks.push(deniedBlock);
        blockById.set(block.id, deniedBlock);
      }

      finalizeCurrentTurn(event.is_error ? "error" : "completed");
      continue;
    }

    if (event.type === "error") {
      finalizeCurrentTurn("error");
    }
  }

  if (!resolvedSessionId && snapshot.turns.length === 0) {
    return null;
  }

  snapshot.session.status = currentTurn ? "active" : snapshot.session.status;
  return snapshot;
}

class ClaudeStreamJsonSession {
  private readonly catalogDirectory: string;

  private readonly stdoutLogPath: string;

  private readonly stderrLogPath: string;

  private process: ChildProcessWithoutNullStreams | null = null;

  private lineBuffer = "";

  private activeTurn: ActiveTurn | null = null;

  // Claude stream-json has no steer primitive; overlapping broker asks cue here.
  private turnQueue: Promise<void> = Promise.resolve();
  private queuedOperations = 0;
  private readonly liveIncarnation = randomUUID();
  private liveRevision = 0;
  private attentionUnsafe = false;

  private starting: Promise<void> | null = null;

  private claudeSessionId: string | null = null;

  private resumedSessionId: string | null = null;

  private lastConfigSignature: string;

  constructor(private options: SessionRequestOptions) {
    this.catalogDirectory = options.runtimeDirectory;
    this.stdoutLogPath = join(options.logsDirectory, "stdout.log");
    this.stderrLogPath = join(options.logsDirectory, "stderr.log");
    this.lastConfigSignature = this.configSignature(options);
  }

  matches(options: SessionRequestOptions): boolean {
    return this.lastConfigSignature === this.configSignature(options);
  }

  update(options: SessionRequestOptions): void {
    this.options = options;
    this.lastConfigSignature = this.configSignature(options);
  }

  isAlive(): boolean {
    return Boolean(this.process && !this.process.killed && this.process.exitCode === null);
  }

  observeExisting() {
    return { state: !this.isAlive() ? "gone" : !this.claudeSessionId || this.attentionUnsafe ? "unknown"
      : this.activeTurn ? "active" : this.queuedOperations ? "unknown" : "idle",
      sessionId: this.claudeSessionId ?? undefined, turnId: this.activeTurn?.id,
      token: `${this.liveIncarnation}:${this.liveRevision}`, steer: false } as const;
  }

  submitExisting(expected: { sessionId: string; token: string }, action: "revive" | "steer", prompt: string) {
    const observed = this.observeExisting();
    if (action !== "revive" || observed.state !== "idle" || expected.sessionId !== observed.sessionId
      || expected.token !== observed.token) return { accepted: false, evidence: "native_state_changed_or_unsupported" };
    // Synchronous validation + reservation + stdin write. No invoke/ensure/retry path.
    const turn = this.startTurn(prompt);
    this.turnQueue = turn.outputPromise.then(() => undefined, () => undefined);
    return { accepted: true, evidence: "claude_stdin_written" };
  }

  async connectDeck(): Promise<void> { await this.ensureStarted(); }

  async startDeck(prompt: string, signal?: AbortSignal): Promise<{ output: Promise<string>; sessionId: string | null }> {
    await this.ensureStarted();
    signal?.throwIfAborted();
    if (this.queuedOperations || this.activeTurn) throw new Error("Claude lane already has an active or queued turn.");
    const turn = this.startTurn(prompt);
    this.turnQueue = turn.outputPromise.then(() => undefined, () => undefined);
    return { output: turn.outputPromise, sessionId: this.claudeSessionId };
  }

  async ensureOnline(): Promise<{ sessionId: string | null }> {
    if (!this.isAlive()) {
      const catalog = await readSessionCatalog(this.catalogDirectory);
      this.claudeSessionId = catalog.activeSessionId;
      this.resumedSessionId = this.claudeSessionId;
    }
    return {
      sessionId: this.claudeSessionId,
    };
  }

  async invoke(prompt: string, timeoutMs?: number): Promise<{ output: string; sessionId: string | null }> {
    return this.invokeWithRetry(prompt, timeoutMs, true);
  }

  private async invokeWithRetry(
    prompt: string,
    timeoutMs: number | undefined,
    allowStaleResumeRetry: boolean,
  ): Promise<{ output: string; sessionId: string | null }> {
    this.queuedOperations++;
    const queuedTurn = this.turnQueue
      .catch(() => undefined)
      .then(async () => {
        await this.ensureReadyForTurn();
        return this.startTurn(prompt);
      });
    this.turnQueue = queuedTurn.then(
      (turn) => turn.outputPromise.then(() => undefined, () => undefined),
      () => undefined,
    ).finally(() => { this.queuedOperations--; });

    const turn = await queuedTurn;
    let output: string;
    try {
      output = await waitForRequesterResult(turn.outputPromise, timeoutMs, this.options.agentName);
    } catch (error) {
      if (allowStaleResumeRetry && this.resumedSessionId && isMissingClaudeConversationError(error)) {
        await appendBoundedLog(
          this.stderrLogPath,
          `[openscout] Claude resume id ${this.resumedSessionId} was stale for ${this.options.agentName}; resetting and retrying once.\n`,
        ).catch(() => undefined);
        await this.shutdown({ resetSession: true });
        return this.invokeWithRetry(prompt, timeoutMs, false);
      }
      throw error;
    }

    return {
      output,
      sessionId: this.claudeSessionId,
    };
  }

  private startTurn(prompt: string): { outputPromise: Promise<string> } {
    if (!this.isAlive() || !this.process?.stdin) {
      throw new Error(`Claude stream-json session for ${this.options.agentName} is not running.`);
    }
    if (this.activeTurn) {
      throw new Error(`Claude stream-json session for ${this.options.agentName} still has an active turn after queueing.`);
    }

    const outputPromise = new Promise<string>((resolve, reject) => {
      const turn: ActiveTurn = {
        id: randomUUID(),
        output: [],
        resolve,
        reject,
      };
      this.liveRevision++;
      this.activeTurn = turn;
    });

    const payload = JSON.stringify({
      type: "user",
      session_id: this.claudeSessionId ?? "",
      message: {
        role: "user",
        content: prompt,
      },
      parent_tool_use_id: null,
    }) + "\n";
    this.process.stdin.write(payload);

    return {
      outputPromise,
    };
  }

  async interrupt(): Promise<void> {
    if (this.process && !this.process.killed) {
      this.process.kill("SIGINT");
    }
  }

  async answerQuestion(blockId: string, answer: string[]): Promise<void> {
    if (!this.process?.stdin) {
      throw new Error(`Claude stream-json session for ${this.options.agentName} is not running.`);
    }

    this.process.stdin.write(
      JSON.stringify({
        type: "tool_result",
        tool_use_id: blockId,
        content: answer.join(", "),
      }) + "\n",
    );
  }

  async shutdown(options: { resetSession?: boolean } = {}): Promise<void> {
    const turn = this.activeTurn;
    this.activeTurn = null;
    if (turn) {
      turn.reject(new Error(`Claude stream-json session for ${this.options.agentName} was shut down.`));
    }

    const child = this.process;
    this.process = null;
    this.starting = null;
    this.lineBuffer = "";
    this.resumedSessionId = null;

    if (child && !child.killed && child.exitCode === null) {
      child.kill();
    }

    if (options.resetSession) {
      this.claudeSessionId = null;
      await updateSessionCatalog(this.catalogDirectory, clearActiveSession);
      return;
    }
    await drainSessionCatalogWrites(this.catalogDirectory);
  }

  private async ensureReadyForTurn(): Promise<void> {
    await this.ensureStarted();
  }

  private configSignature(options: SessionRequestOptions): string {
    return JSON.stringify({
      cwd: options.cwd,
      sessionId: options.sessionId,
      systemPrompt: options.systemPrompt,
      launchArgs: Array.isArray(options.launchArgs) ? options.launchArgs : [],
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.isAlive()) {
      return;
    }
    if (this.starting) {
      return this.starting;
    }

    this.starting = this.startSession();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startSession(): Promise<void> {
    await mkdir(this.options.runtimeDirectory, { recursive: true });
    await mkdir(this.options.logsDirectory, { recursive: true });
    await writeFile(join(this.options.runtimeDirectory, "prompt.txt"), this.options.systemPrompt);
    const catalog = await readSessionCatalog(this.catalogDirectory);
    this.claudeSessionId = catalog.activeSessionId;
    this.resumedSessionId = this.claudeSessionId;

    const args = [
      "--verbose",
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--append-system-prompt", this.options.systemPrompt,
      ...this.options.launchArgs ?? [],
    ];
    if (this.claudeSessionId) {
      args.push("--resume", this.claudeSessionId);
    }

    const claudeExecutable = resolveClaudeExecutable(process.env)?.path ?? "claude";
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(claudeExecutable, args, {
        cwd: this.options.cwd,
        stdio: "pipe",
        env: buildManagedAgentEnvironment({
          agentName: this.options.agentName,
          currentDirectory: this.options.cwd,
          ...(this.options.crewRole ? { crewRole: this.options.crewRole } : {}),
          baseEnv: process.env,
        }),
      });
    } catch (error) {
      throw new Error(`Failed to spawn claude: ${errorMessage(error)}`);
    }

    this.liveRevision++;
    this.process = child;

    // Catch spawn errors (e.g. ENOENT when "claude" is not in PATH).
    // Without this handler, the error event becomes an uncaught exception
    // that crashes the entire broker process.
    child.on("error", (error) => {
      if (this.process !== child) {
        return;
      }
      console.error(`[openscout-runtime] claude process error for ${this.options.agentName}: ${error.message}`);
      this.process = null;
      if (this.activeTurn) {
        const turn = this.activeTurn;
        this.activeTurn = null;
        turn.reject(new Error(`Claude process error: ${error.message}`));
      }
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      if (this.process !== child) {
        return;
      }
      void appendBoundedLog(this.stdoutLogPath, redactSecrets(chunk)).catch(() => undefined);
      this.lineBuffer += chunk;
      const lines = this.lineBuffer.split("\n");
      this.lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        this.handleEvent(JSON.parse(trimmed) as ClaudeEvent);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      void appendBoundedLog(this.stderrLogPath, redactSecrets(chunk)).catch(() => undefined);
    });

    child.on("close", (code: number | null) => {
      if (this.process !== child) {
        return;
      }
      this.process = null;
      this.lineBuffer = "";
      if (this.activeTurn) {
        const turn = this.activeTurn;
        this.activeTurn = null;
        if (code === 0) {
          const output = resolveClaudeStreamJsonOutput(undefined, turn.output);
          if (output) {
            turn.resolve(output);
          } else {
            turn.reject(emptyClaudeOutputError());
          }
        } else {
          turn.reject(new Error(`Claude exited with code ${code}`));
        }
      }
    });
  }

  private handleEvent(event: ClaudeEvent): void {
    if (event.type === "system" && event.subtype === "init") {
      const nextSessionId = event.session_id ?? event.sessionId ?? null;
      if (nextSessionId && nextSessionId !== this.claudeSessionId) {
        this.claudeSessionId = nextSessionId;
        const cwd = this.options.cwd;
        const agentName = this.options.agentName;
        const stderrLogPath = this.stderrLogPath;
        void updateSessionCatalog(
          this.catalogDirectory,
          (catalog) => catalogRecordSession(catalog, nextSessionId, cwd),
          async (error) => {
            const message = `[openscout] failed to record Claude session ${nextSessionId} in catalog for ${agentName}: ${errorMessage(error)}`;
            console.error(`[openscout-runtime] ${message}`);
            await appendBoundedLog(stderrLogPath, `${message}\n`).catch(() => undefined);
          },
        );
      }
      return;
    }

    const turn = this.activeTurn;
    if (!turn) {
      return;
    }

    if (event.type === "assistant") {
      const content = event.message?.content ?? event.content ?? [];
      for (const part of content) {
        if (part.type === "text" && part.text) {
          turn.output.push(part.text);
        }
      }
      return;
    }

    if (event.type === "result") {
      this.attentionUnsafe = false;
      const resultError = claudeResultErrorMessage(event);
      this.activeTurn = null;
      if (resultError) {
        turn.reject(new Error(resultError));
        return;
      }

      const output = resolveClaudeStreamJsonOutput(event.result, turn.output);
      if (!output) {
        turn.reject(emptyClaudeOutputError());
        return;
      }

      turn.resolve(output);
      return;
    }

    if (event.type === "error") {
      this.attentionUnsafe = true;
      this.activeTurn = null;
      turn.reject(new Error(event.error?.message ?? event.message ?? "Unknown Claude error"));
    }
  }
}

const sessions = new Map<string, ClaudeStreamJsonSession>();

function getOrCreateSession(options: SessionRequestOptions): ClaudeStreamJsonSession {
  const key = sessionKey(options);
  const existing = sessions.get(key);
  if (existing) {
    if (existing.matches(options)) {
      return existing;
    }
    void existing.shutdown({ resetSession: false }).catch((error) => {
      console.error(`[openscout-runtime] failed to shut down replaced Claude session for ${options.agentName}: ${errorMessage(error)}`);
    });
    sessions.delete(key);
  }

  const session = new ClaudeStreamJsonSession(options);
  sessions.set(key, session);
  return session;
}

export function existingClaudeNativeSession(agentName: string, sessionId: string) {
  const session = sessions.get(`${agentName}:${sessionId}`);
  if (!session) return undefined;
  return { observe: () => session.observeExisting(),
    submit: (expected: { sessionId: string; token: string }, action: "revive" | "steer", prompt: string) => session.submitExisting(expected, action, prompt) };
}

export async function ensureClaudeStreamJsonAgentOnline(options: SessionRequestOptions): Promise<{ sessionId: string | null }> {
  const session = getOrCreateSession(options);
  session.update(options);
  return session.ensureOnline();
}

export async function invokeClaudeStreamJsonAgent(options: InvocationOptions): Promise<{ output: string; sessionId: string | null }> {
  const session = getOrCreateSession(options);
  session.update(options);
  return session.invoke(options.prompt, options.timeoutMs);
}

export async function interruptClaudeStreamJsonAgent(options: InterruptOptions): Promise<void> {
  const session = sessions.get(sessionKey(options));
  if (!session) {
    return;
  }
  session.update(options);
  await session.interrupt();
}

export function isClaudeStreamJsonAgentAlive(options: SessionRequestOptions): boolean {
  const session = sessions.get(sessionKey(options));
  return Boolean(session?.isAlive());
}

export async function answerClaudeStreamJsonQuestion(
  options: SessionRequestOptions,
  input: { blockId: string; answer: string[] },
): Promise<void> {
  const session = sessions.get(sessionKey(options));
  if (!session) {
    throw new Error(`Claude stream-json session for ${options.agentName} is not running.`);
  }

  session.update(options);
  await session.answerQuestion(input.blockId, input.answer);
}

export async function getClaudeStreamJsonAgentSnapshot(
  options: SessionRequestOptions,
): Promise<SessionState | null> {
  const stdoutLogPath = join(options.logsDirectory, "stdout.log");
  const [rawLog, catalog] = await Promise.all([
    readOptionalFile(stdoutLogPath),
    readSessionCatalog(options.runtimeDirectory),
  ]);

  if (!rawLog) {
    return null;
  }

  return buildClaudeStreamJsonSessionSnapshot(rawLog, options, catalog.activeSessionId);
}

export async function shutdownClaudeStreamJsonAgent(
  options: SessionRequestOptions,
  shutdownOptions: { resetSession?: boolean } = {},
): Promise<void> {
  const key = sessionKey(options);
  const session = sessions.get(key);
  if (!session) {
    if (shutdownOptions.resetSession) {
      await updateSessionCatalog(options.runtimeDirectory, clearActiveSession);
    } else {
      await drainSessionCatalogWrites(options.runtimeDirectory);
    }
    return;
  }

  sessions.delete(key);
  await session.shutdown(shutdownOptions);
}

/** Deck connect starts the transport without submitting a prompt. */
export async function connectClaudeDeck(options: SessionRequestOptions): Promise<void> {
  const session = getOrCreateSession(options);
  session.update(options);
  await session.connectDeck();
}

/** Native conflict guard and accepted-start boundary; never queues a Deck turn. */
export async function startClaudeDeckTurn(options: InvocationOptions, signal?: AbortSignal): Promise<{ output: Promise<string>; sessionId: string | null }> {
  const session = getOrCreateSession(options);
  session.update(options);
  return session.startDeck(options.prompt, signal);
}
