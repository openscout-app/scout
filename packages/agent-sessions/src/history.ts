import { statSync } from "node:fs";
import { basename, dirname } from "node:path";

import { StateTracker, type SessionState } from "./state.js";
import {
  readCodexRolloutUsageObservation,
  type CodexQuotaWindowObservation,
} from "./adapters/codex/usage.js";
import { codexContextWindowTokens } from "./adapters/codex/context-window.js";
import { projectCodexAssistantText, type CodexHostMetadata } from "./adapters/codex/host-metadata.js";
import { claudeContextWindowTokens } from "./adapters/claude-code/context-window.js";
import {
  observedContextWindowTokens,
  recordObservedContextWindow,
} from "./model-window-registry.js";
import type {
  Action,
  Block,
  AgentSessionStreamEvent,
  QuestionOption,
  Session,
  Turn,
  TurnStatus,
} from "./protocol/index.js";

type TextualBlock = Extract<Block, { type: "text" | "reasoning" }>;

type ClaudeObserveUsageEntry = {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  contextInputTokens: number;
  contextWindowTokens?: number;
  webSearchRequests: number;
  webFetchRequests: number;
  serviceTier?: string;
  speed?: string;
};

export type HistorySessionEvent = {
  capturedAt: number;
  event: AgentSessionStreamEvent;
};

export type SupportedHistoryAdapterType = "claude-code" | "codex" | "pi";
export type HistoryAdapterType = SupportedHistoryAdapterType | "unknown";

export interface HistorySessionSnapshotInput {
  path: string;
  content: string;
  adapterType?: string | null;
  name?: string | null;
  sessionId?: string | null;
  cwd?: string | null;
  baseTimestampMs?: number | null;
}

export interface HistorySessionSnapshotResult {
  adapterType: HistoryAdapterType;
  lineCount: number;
  parsedLineCount: number;
  skippedLineCount: number;
  events: HistorySessionEvent[];
  snapshot: SessionState;
}

function decodeClaudeProjectsSlug(name: string): string | null {
  if (!name || !name.startsWith("-")) {
    return null;
  }

  const tail = name.slice(1);
  if (!tail) {
    return null;
  }

  return `/${tail.replace(/-/g, "/")}`;
}

/** The first folder a transcript's records hold, found without splitting the whole transcript. */
function firstRecordedCwd(content: string): string | null {
  let from = 0;
  for (;;) {
    const at = content.indexOf('"cwd"', from);
    if (at < 0) return null;
    const end = content.indexOf("\n", at);
    const line = content.slice(content.lastIndexOf("\n", at) + 1, end < 0 ? content.length : end);
    try {
      const cwd = (JSON.parse(line) as { cwd?: unknown } | null)?.cwd;
      if (typeof cwd === "string" && cwd.trim()) return cwd.trim();
    } catch {
      // a partial last line
    }
    // a "cwd" in a message or a nested object is not the record's folder
    if (end < 0) return null;
    from = end + 1;
  }
}

/**
 * A Claude transcript's decoded project folder name, only when that folder
 * exists: the name turns "/", ".", "_" and "-" all into "-", so a guess such
 * as my/project for my-project must never become a session's folder.
 */
function inferClaudeHistoryCwd(path: string): string | null {
  const decoded = decodeClaudeProjectsSlug(basename(dirname(path)));
  if (!decoded) return null;
  try {
    return statSync(decoded).isDirectory() ? decoded : null;
  } catch {
    return null;
  }
}

/** A label, so the lossy decode of the project folder name is good enough when no folder is known. */
function deriveHistoryName(path: string, cwd: string | null): string {
  const parent = basename(dirname(path));
  const named = cwd ?? decodeClaudeProjectsSlug(parent);
  if (named) {
    return basename(named) || named;
  }

  return parent || basename(path) || "History Session";
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    return value < 1e12 ? value * 1000 : value;
  }

  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric < 1e12 ? numeric * 1000 : numeric;
    }

    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function extractRecordTimestamp(record: Record<string, unknown>): number | null {
  const candidates = [
    record.timestamp,
    record.createdAt,
    record.created_at,
    record.updatedAt,
    record.updated_at,
    record.time,
    record.ts,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeTimestamp(candidate);
    if (normalized !== null) {
      return normalized;
    }
  }

  return null;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function maybeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function maybeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function renderToolResultContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }
        const item = entry as Record<string, unknown>;
        if (typeof item.text === "string") {
          return item.text;
        }
        if (typeof item.content === "string") {
          return item.content;
        }
        return stringifyUnknown(entry);
      })
      .filter(Boolean)
      .join("\n");
    return text || stringifyUnknown(content);
  }

  return stringifyUnknown(content);
}

function renderContentPartsText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (!isRecord(entry)) {
        return "";
      }
      if (typeof entry.text === "string") {
        return entry.text;
      }
      if (typeof entry.content === "string") {
        return entry.content;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractReasoningText(item: Record<string, unknown>): string {
  const summary = Array.isArray(item.summary) ? item.summary : [];
  const content = Array.isArray(item.content) ? item.content : [];

  const summaryText = summary
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }

      const record = entry as Record<string, unknown>;
      if (typeof record.text === "string") {
        return record.text;
      }
      if (typeof record.summary === "string") {
        return record.summary;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");

  const contentText = content
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }

      const record = entry as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");

  return [summaryText, contentText].filter(Boolean).join("\n\n").trim();
}

function extractQuestionOptions(firstQuestion: Record<string, unknown>): QuestionOption[] {
  const options = Array.isArray(firstQuestion.options) ? firstQuestion.options : [];
  return options.map((option) => {
    if (typeof option === "string") {
      return { label: option };
    }

    const record = option as Record<string, unknown>;
    return {
      label: typeof record.label === "string" ? record.label : String(option),
      description: typeof record.description === "string" ? record.description : undefined,
    };
  });
}

function parseQuestionAnswer(content: unknown): string[] {
  const text = renderToolResultContent(content).trim();
  if (!text) {
    return [];
  }

  return text
    .split(/\s*,\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function inferHistoryAdapterType(path: string, adapterType?: string | null): HistoryAdapterType {
  const normalizedAdapter = adapterType?.trim();
  if (normalizedAdapter === "claude-code") {
    return "claude-code";
  }
  if (normalizedAdapter === "codex") {
    return "codex";
  }
  if (normalizedAdapter === "pi" || normalizedAdapter === "pi_rpc") {
    return "pi";
  }

  const normalizedPath = path.toLowerCase();
  if (normalizedPath.includes("/.claude/projects/")) {
    return "claude-code";
  }
  if (normalizedPath.includes("/.codex/") || normalizedPath.includes("/.openai-codex/")) {
    return "codex";
  }
  if (normalizedPath.includes("/pi-sessions/") || normalizedPath.includes("/.pi/agent/sessions/")) {
    return "pi";
  }

  return "unknown";
}

export function supportsHistorySessionSnapshot(adapterType: string | null | undefined): boolean {
  const inferred = inferHistoryAdapterType("", adapterType ?? undefined);
  return inferred === "claude-code" || inferred === "codex" || inferred === "pi";
}

function buildBaseHistorySession(input: HistorySessionSnapshotInput, adapterType: HistoryAdapterType): Session {
  // Claude and pi records hold their folder; the pi parser sets it from its session record.
  const recorded = adapterType === "codex" ? null : firstRecordedCwd(input.content);
  // A recorded folder beats a decoded project folder name, even one that exists.
  const cwd = input.cwd?.trim()
    || (adapterType === "claude-code" ? recorded ?? inferClaudeHistoryCwd(input.path) : null)
    || undefined;

  return {
    id: input.sessionId?.trim() || `history:${input.path}`,
    name: input.name?.trim() || deriveHistoryName(input.path, cwd ?? recorded),
    adapterType,
    status: "idle",
    ...(cwd ? { cwd } : {}),
    providerMeta: {
      historyPath: input.path,
      historyAdapterType: adapterType,
      source: "external_history",
      threadPath: input.path,
    },
  };
}

class ClaudeCodeHistoryParser {
  private readonly events: HistorySessionEvent[] = [];
  private currentTurn: Turn | null = null;
  private turnCounter = 0;
  private blockIndex = 0;
  private toolBlockMap = new Map<string, string>();
  private questionBlockMap = new Map<string, string>();
  private blockById = new Map<string, Block>();
  private activeStreamBlocks = new Map<number, TextualBlock>();
  private sawStreamTextThisTurn = false;
  private assistantUsageByMessageId = new Map<string, ClaudeObserveUsageEntry>();
  private latestAssistantUsage: ClaudeObserveUsageEntry | null = null;
  private claudeContextWindowTokens: number | undefined;

  constructor(
    private readonly session: Session,
    private readonly baseTimestampMs: number,
  ) {}

  parse(content: string): {
    events: HistorySessionEvent[];
    lineCount: number;
    parsedLineCount: number;
    skippedLineCount: number;
  } {
    const lines = content.split(/\r?\n/u);
    let parsedLineCount = 0;
    let skippedLineCount = 0;
    let lineCount = 0;
    let lastCapturedAt = this.baseTimestampMs;

    for (let index = 0; index < lines.length; index += 1) {
      const rawLine = lines[index];
      const trimmed = rawLine.trim();
      if (!trimmed) {
        continue;
      }

      lineCount += 1;

      let record: Record<string, unknown>;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          skippedLineCount += 1;
          continue;
        }
        record = parsed as Record<string, unknown>;
      } catch {
        skippedLineCount += 1;
        continue;
      }

      const capturedAt = extractRecordTimestamp(record) ?? (this.baseTimestampMs + index);
      lastCapturedAt = capturedAt;
      if (this.handleRecord(record, capturedAt)) {
        parsedLineCount += 1;
      } else {
        skippedLineCount += 1;
      }
    }

    if (this.persistObserveUsageMetadata()) {
      this.emitEvent(lastCapturedAt, {
        event: "session:update",
        session: { ...this.session },
      });
    }

    return {
      events: this.events,
      lineCount,
      parsedLineCount,
      skippedLineCount,
    };
  }

  private handleRecord(record: Record<string, unknown>, capturedAt: number): boolean {
    this.captureRecordMetadata(record);

    const type = typeof record.type === "string" ? record.type : null;
    if (!type) {
      return false;
    }

    switch (type) {
      case "system":
        this.handleSystem(record, capturedAt);
        return true;
      case "user":
        this.handleUser(record, capturedAt);
        return true;
      case "assistant":
        this.handleAssistant(record, capturedAt);
        return true;
      case "tool_use":
        this.handleToolUse(record, capturedAt);
        return true;
      case "tool_result":
        this.handleToolResult(record, capturedAt);
        return true;
      case "stream_event":
        this.handleStreamEvent(record, capturedAt);
        return true;
      case "result":
        this.handleResult(record, capturedAt);
        return true;
      case "error":
        this.handleError(record, capturedAt);
        return true;
      default:
        return false;
    }
  }

  private captureRecordMetadata(record: Record<string, unknown>): void {
    const runtime = this.ensureObserveMetaRecord("observeRuntime");
    this.assignObserveString(runtime, "entrypoint", record.entrypoint);
    this.assignObserveString(runtime, "cliVersion", record.version);
    this.assignObserveString(runtime, "gitBranch", record.gitBranch);
    this.assignObserveString(runtime, "permissionMode", record.permissionMode);
    this.assignObserveString(runtime, "userType", record.userType);

    const recordCwd = maybeString(record.cwd);
    if (recordCwd && !this.session.cwd) {
      this.session.cwd = recordCwd;
    }

    const message = isRecord(record.message) ? record.message : null;
    const model = maybeString(message?.model);
    if (model && this.session.model !== model) {
      this.session.model = model;
    }

    const usage = this.readClaudeUsageEntry(record);
    if (!usage) {
      return;
    }

    const messageId = maybeString(message?.id)
      ?? maybeString(record.requestId)
      ?? maybeString(record.uuid);
    if (!messageId) {
      return;
    }

    this.assistantUsageByMessageId.set(messageId, usage);
    this.latestAssistantUsage = usage;
    this.claudeContextWindowTokens = usage.contextWindowTokens ?? this.claudeContextWindowTokens;
  }

  private readClaudeUsageEntry(record: Record<string, unknown>): ClaudeObserveUsageEntry | null {
    const type = maybeString(record.type);
    const message = isRecord(record.message) ? record.message : null;
    const role = maybeString(message?.role);
    if (type !== "assistant" && role !== "assistant") {
      return null;
    }

    const usage = isRecord(message?.usage) ? message.usage : null;
    const serverToolUse = isRecord(usage?.server_tool_use) ? usage.server_tool_use : null;
    const inputTokens = maybeNumber(usage?.input_tokens) ?? 0;
    const cacheReadInputTokens = maybeNumber(usage?.cache_read_input_tokens) ?? 0;
    const cacheCreationInputTokens = maybeNumber(usage?.cache_creation_input_tokens) ?? 0;
    const model = maybeString(message?.model);
    const contextWindowTokens = this.readClaudeContextWindowTokens(record, message, usage);
    const serviceTier = maybeString(message?.service_tier) ?? maybeString(usage?.service_tier);
    const speed = maybeString(message?.speed) ?? maybeString(usage?.speed);
    const entry: ClaudeObserveUsageEntry = {
      ...(model ? { model } : {}),
      inputTokens,
      outputTokens: maybeNumber(usage?.output_tokens) ?? 0,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      contextInputTokens: inputTokens + cacheReadInputTokens + cacheCreationInputTokens,
      ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
      webSearchRequests: maybeNumber(serverToolUse?.web_search_requests) ?? 0,
      webFetchRequests: maybeNumber(serverToolUse?.web_fetch_requests) ?? 0,
      ...(serviceTier ? { serviceTier } : {}),
      ...(speed ? { speed } : {}),
    };

    const hasUsage = entry.inputTokens > 0
      || entry.outputTokens > 0
      || entry.cacheReadInputTokens > 0
      || entry.cacheCreationInputTokens > 0
      || entry.contextInputTokens > 0
      || entry.contextWindowTokens !== undefined
      || entry.webSearchRequests > 0
      || entry.webFetchRequests > 0
      || Boolean(entry.serviceTier)
      || Boolean(entry.speed);
    return hasUsage ? entry : null;
  }

  private readClaudeContextWindowTokens(
    record: Record<string, unknown>,
    message: Record<string, unknown> | null,
    usage: Record<string, unknown> | null,
  ): number | undefined {
    return maybeNumber(usage?.context_window_tokens)
      ?? maybeNumber(usage?.contextWindowTokens)
      ?? maybeNumber(usage?.context_window)
      ?? maybeNumber(usage?.model_context_window)
      ?? maybeNumber(message?.context_window_tokens)
      ?? maybeNumber(message?.contextWindowTokens)
      ?? maybeNumber(message?.model_context_window)
      ?? maybeNumber(record.context_window_tokens)
      ?? maybeNumber(record.contextWindowTokens)
      ?? maybeNumber(record.model_context_window);
  }

  private persistObserveUsageMetadata(): boolean {
    if (this.assistantUsageByMessageId.size === 0) {
      return false;
    }

    const usage = this.ensureObserveMetaRecord("observeUsage");
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadInputTokens = 0;
    let cacheCreationInputTokens = 0;
    let webSearchRequests = 0;
    let webFetchRequests = 0;
    let serviceTier: string | undefined;
    let speed: string | undefined;

    for (const entry of this.assistantUsageByMessageId.values()) {
      inputTokens += entry.inputTokens;
      outputTokens += entry.outputTokens;
      cacheReadInputTokens += entry.cacheReadInputTokens;
      cacheCreationInputTokens += entry.cacheCreationInputTokens;
      webSearchRequests += entry.webSearchRequests;
      webFetchRequests += entry.webFetchRequests;
      if (entry.serviceTier) {
        serviceTier = entry.serviceTier;
      }
      if (entry.speed) {
        speed = entry.speed;
      }
    }

    let changed = false;
    const assignNumber = (key: string, value: number): void => {
      if (usage[key] !== value) {
        usage[key] = value;
        changed = true;
      }
    };
    const assignString = (key: string, value: string): void => {
      if (usage[key] !== value) {
        usage[key] = value;
        changed = true;
      }
    };

    assignNumber("assistantMessages", this.assistantUsageByMessageId.size);
    if (inputTokens > 0) assignNumber("inputTokens", inputTokens);
    if (outputTokens > 0) assignNumber("outputTokens", outputTokens);
    if (cacheReadInputTokens > 0) assignNumber("cacheReadInputTokens", cacheReadInputTokens);
    if (cacheCreationInputTokens > 0) assignNumber("cacheCreationInputTokens", cacheCreationInputTokens);
    const totalTokens = inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens;
    if (totalTokens > 0) assignNumber("totalTokens", totalTokens);
    const latestUsage = this.latestAssistantUsage;
    if (latestUsage?.contextInputTokens && latestUsage.contextInputTokens > 0) {
      assignNumber("contextInputTokens", latestUsage.contextInputTokens);
    }
    const claudeModel = latestUsage?.model ?? this.session.model;
    // Claude never logs a window today, so this records nothing — but it keeps the
    // learn-once-per-model path uniform if that ever changes.
    recordObservedContextWindow(claudeModel, latestUsage?.contextWindowTokens ?? this.claudeContextWindowTokens);
    const contextWindowTokens = latestUsage?.contextWindowTokens
      ?? this.claudeContextWindowTokens
      ?? observedContextWindowTokens(claudeModel)
      ?? claudeContextWindowTokens(claudeModel);
    if (contextWindowTokens > 0) assignNumber("contextWindowTokens", contextWindowTokens);
    if (webSearchRequests > 0) assignNumber("webSearchRequests", webSearchRequests);
    if (webFetchRequests > 0) assignNumber("webFetchRequests", webFetchRequests);
    if (serviceTier) assignString("serviceTier", serviceTier);
    if (speed) assignString("speed", speed);
    return changed;
  }

  private ensureObserveMetaRecord(key: "observeRuntime" | "observeUsage"): Record<string, unknown> {
    const providerMeta = isRecord(this.session.providerMeta) ? this.session.providerMeta : {};
    this.session.providerMeta = providerMeta;

    const existing = providerMeta[key];
    if (isRecord(existing)) {
      return existing;
    }

    const next: Record<string, unknown> = {};
    providerMeta[key] = next;
    return next;
  }

  private assignObserveString(
    target: Record<string, unknown>,
    key: string,
    value: unknown,
  ): void {
    const next = maybeString(value);
    if (next) {
      target[key] = next;
    }
  }

  private handleSystem(record: Record<string, unknown>, capturedAt: number): void {
    if (record.subtype !== "init") {
      return;
    }

    let changed = false;
    const externalSessionId = typeof record.session_id === "string"
      ? record.session_id
      : typeof record.sessionId === "string"
        ? record.sessionId
        : null;
    if (externalSessionId) {
      const providerMeta = { ...(this.session.providerMeta ?? {}) };
      if (providerMeta.externalSessionId !== externalSessionId) {
        providerMeta.externalSessionId = externalSessionId;
        this.session.providerMeta = providerMeta;
        changed = true;
      }
    }

    if (typeof record.cwd === "string" && record.cwd.trim() && this.session.cwd !== record.cwd) {
      this.session.cwd = record.cwd;
      changed = true;
    }

    if (typeof record.model === "string" && record.model.trim() && this.session.model !== record.model) {
      this.session.model = record.model;
      changed = true;
    }

    if (changed) {
      this.emitEvent(capturedAt, {
        event: "session:update",
        session: { ...this.session },
      });
    }
  }

  private handleUser(record: Record<string, unknown>, capturedAt: number): void {
    const message = record.message && typeof record.message === "object"
      ? record.message as Record<string, unknown>
      : null;
    const content = message?.content;

    if (Array.isArray(content) && content.length > 0) {
      const toolResults = content.filter((entry) => {
        return !!entry
          && typeof entry === "object"
          && !Array.isArray(entry)
          && (entry as Record<string, unknown>).type === "tool_result";
      }) as Record<string, unknown>[];

      if (toolResults.length === content.length) {
        for (const toolResult of toolResults) {
          this.handleToolResult({
            ...toolResult,
            tool_use_id: typeof toolResult.tool_use_id === "string"
              ? toolResult.tool_use_id
              : toolResult.id,
            is_error: toolResult.is_error === true,
          }, capturedAt);
        }
        return;
      }
    }

    this.startTurn(capturedAt);
  }

  private handleAssistant(record: Record<string, unknown>, capturedAt: number): void {
    const turn = this.ensureTurn(capturedAt);
    const content = record.message && typeof record.message === "object"
      ? (record.message as Record<string, unknown>).content
      : record.content;
    if (!Array.isArray(content)) {
      this.maybeEndTurnFromAssistant(record, capturedAt);
      return;
    }

    const skipTextBlocks = this.sawStreamTextThisTurn;
    for (const part of content) {
      const contentPart = part as Record<string, unknown>;
      const contentType = typeof contentPart.type === "string" ? contentPart.type : "";
      if (contentType === "thinking" || contentType === "reasoning") {
        if (skipTextBlocks) {
          continue;
        }
        const block = this.startBlock<Extract<Block, { type: "reasoning" }>>(turn, capturedAt, {
          type: "reasoning",
          text: typeof contentPart.thinking === "string"
            ? contentPart.thinking
            : typeof contentPart.text === "string"
              ? contentPart.text
              : "",
          status: "completed",
        });
        this.emitBlockEnd(capturedAt, turn, block, "completed");
      } else if (contentType === "text") {
        if (skipTextBlocks) {
          continue;
        }
        const block = this.startBlock<Extract<Block, { type: "text" }>>(turn, capturedAt, {
          type: "text",
          text: typeof contentPart.text === "string" ? contentPart.text : "",
          status: "completed",
        });
        this.emitBlockEnd(capturedAt, turn, block, "completed");
      } else if (contentType === "tool_use") {
        this.handleToolUse(contentPart, capturedAt);
      }
    }

    this.maybeEndTurnFromAssistant(record, capturedAt);
  }

  private handleStreamEvent(record: Record<string, unknown>, capturedAt: number): void {
    const turn = this.ensureTurn(capturedAt);
    const streamEvent = record.event;
    if (!streamEvent || typeof streamEvent !== "object") {
      return;
    }

    const eventRecord = streamEvent as Record<string, unknown>;
    const streamType = typeof eventRecord.type === "string" ? eventRecord.type : "";

    if (streamType === "message_start") {
      this.activeStreamBlocks.clear();
      this.sawStreamTextThisTurn = false;
      return;
    }

    if (streamType === "content_block_start") {
      const index = typeof eventRecord.index === "number" ? eventRecord.index : 0;
      const contentBlock = eventRecord.content_block;
      if (!contentBlock || typeof contentBlock !== "object") {
        return;
      }

      const contentRecord = contentBlock as Record<string, unknown>;
      const contentType = typeof contentRecord.type === "string" ? contentRecord.type : "";
      if (contentType !== "text" && contentType !== "thinking") {
        return;
      }

      const block = this.startBlock<TextualBlock>(turn, capturedAt, {
        type: contentType === "thinking" ? "reasoning" : "text",
        text: "",
        status: "streaming",
      }) as TextualBlock;

      this.activeStreamBlocks.set(index, block);
      this.sawStreamTextThisTurn = true;

      const initialText = contentType === "thinking"
        ? typeof contentRecord.thinking === "string" ? contentRecord.thinking : ""
        : typeof contentRecord.text === "string" ? contentRecord.text : "";
      this.appendTextDelta(capturedAt, turn, block, initialText);
      return;
    }

    if (streamType === "content_block_delta") {
      const index = typeof eventRecord.index === "number" ? eventRecord.index : 0;
      const block = this.activeStreamBlocks.get(index);
      const delta = eventRecord.delta;
      if (!block || !delta || typeof delta !== "object") {
        return;
      }

      const deltaRecord = delta as Record<string, unknown>;
      const deltaType = typeof deltaRecord.type === "string" ? deltaRecord.type : "";
      if (deltaType === "text_delta") {
        this.appendTextDelta(capturedAt, turn, block, typeof deltaRecord.text === "string" ? deltaRecord.text : "");
        return;
      }
      if (deltaType === "thinking_delta") {
        this.appendTextDelta(capturedAt, turn, block, typeof deltaRecord.thinking === "string" ? deltaRecord.thinking : "");
      }
      return;
    }

    if (streamType === "content_block_stop") {
      const index = typeof eventRecord.index === "number" ? eventRecord.index : 0;
      const block = this.activeStreamBlocks.get(index);
      if (!block) {
        return;
      }

      this.emitBlockEnd(capturedAt, turn, block, "completed");
      this.activeStreamBlocks.delete(index);
    }
  }

  private handleToolUse(record: Record<string, unknown>, capturedAt: number): void {
    const turn = this.ensureTurn(capturedAt);
    const toolName = typeof record.tool_name === "string"
      ? record.tool_name
      : typeof record.name === "string"
        ? record.name
        : "unknown";
    const toolCallId = typeof record.tool_use_id === "string"
      ? record.tool_use_id
      : typeof record.id === "string"
        ? record.id
        : `${turn.id}:tool:${this.blockIndex}`;

    if (toolName === "AskUserQuestion") {
      const input = record.input && typeof record.input === "object" ? record.input as Record<string, unknown> : {};
      const questions = Array.isArray(input.questions) ? input.questions : [];
      const firstQuestion = (questions[0] as Record<string, unknown> | undefined) ?? {};

      const block = this.startBlock<Extract<Block, { type: "question" }>>(turn, capturedAt, {
        id: `${turn.id}:question:${toolCallId}`,
        type: "question",
        header: typeof firstQuestion.header === "string" ? firstQuestion.header : undefined,
        question: typeof firstQuestion.question === "string" ? firstQuestion.question : "",
        options: extractQuestionOptions(firstQuestion),
        multiSelect: firstQuestion.multiSelect === true,
        questionStatus: "awaiting_answer",
        answer: undefined,
        status: "streaming",
      });

      this.toolBlockMap.set(toolCallId, block.id);
      this.questionBlockMap.set(toolCallId, block.id);
      return;
    }

    let action: Action;
    if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") {
      const input = record.input && typeof record.input === "object" ? record.input as Record<string, unknown> : {};
      action = {
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
    } else if (toolName === "Bash") {
      const input = record.input && typeof record.input === "object" ? record.input as Record<string, unknown> : {};
      action = {
        kind: "command",
        command: typeof input.command === "string" ? input.command : "",
        status: "running",
        output: "",
      };
    } else if (toolName === "Agent") {
      const input = record.input && typeof record.input === "object" ? record.input as Record<string, unknown> : {};
      action = {
        kind: "subagent",
        agentId: toolCallId,
        agentName: typeof input.description === "string" ? input.description : undefined,
        prompt: typeof input.prompt === "string" ? input.prompt : undefined,
        status: "running",
        output: "",
      };
    } else {
      action = {
        kind: "tool_call",
        toolName,
        toolCallId,
        input: record.input,
        status: "running",
        output: "",
      };
    }

    const block = this.startBlock<Extract<Block, { type: "action" }>>(turn, capturedAt, {
      id: `${turn.id}:action:${toolCallId}`,
      type: "action",
      action,
      status: "streaming",
    });
    this.toolBlockMap.set(toolCallId, block.id);
  }

  private handleToolResult(record: Record<string, unknown>, capturedAt: number): void {
    const turn = this.ensureTurn(capturedAt);
    const toolCallId = typeof record.tool_use_id === "string"
      ? record.tool_use_id
      : typeof record.id === "string"
        ? record.id
        : "";
    if (!toolCallId) {
      return;
    }

    const questionBlockId = this.questionBlockMap.get(toolCallId);
    if (questionBlockId) {
      const answer = parseQuestionAnswer(record.content);
      this.emitEvent(capturedAt, {
        event: "block:question:answer",
        sessionId: this.session.id,
        turnId: turn.id,
        blockId: questionBlockId,
        questionStatus: "answered",
        ...(answer.length > 0 ? { answer } : {}),
      });
      const block = this.blockById.get(questionBlockId);
      if (block) {
        this.emitBlockEnd(capturedAt, turn, block, "completed");
      }
      this.questionBlockMap.delete(toolCallId);
      this.toolBlockMap.delete(toolCallId);
      return;
    }

    const blockId = this.toolBlockMap.get(toolCallId);
    if (!blockId) {
      return;
    }

    const output = renderToolResultContent(record.content);
    if (output) {
      this.emitEvent(capturedAt, {
        event: "block:action:output",
        sessionId: this.session.id,
        turnId: turn.id,
        blockId,
        output,
      });
    }

    const status = record.is_error === true ? "failed" : "completed";
    this.emitEvent(capturedAt, {
      event: "block:action:status",
      sessionId: this.session.id,
      turnId: turn.id,
      blockId,
      status,
    });

    const block = this.blockById.get(blockId);
    if (block) {
      this.emitBlockEnd(capturedAt, turn, block, status === "failed" ? "failed" : "completed");
    }
    this.toolBlockMap.delete(toolCallId);
  }

  private handleResult(record: Record<string, unknown>, capturedAt: number): void {
    const turn = this.currentTurn;
    if (!turn) {
      return;
    }

    this.completeOpenStreamBlocks(capturedAt, turn);

    const denials = Array.isArray(record.permission_denials) ? record.permission_denials : [];
    for (const denial of denials) {
      const denialRecord = denial as Record<string, unknown>;
      if (denialRecord.tool_name !== "AskUserQuestion") {
        continue;
      }

      const input = denialRecord.tool_input && typeof denialRecord.tool_input === "object"
        ? denialRecord.tool_input as Record<string, unknown>
        : {};
      const questions = Array.isArray(input.questions) ? input.questions : [];
      const firstQuestion = (questions[0] as Record<string, unknown> | undefined) ?? {};

      const block = this.startBlock<Extract<Block, { type: "question" }>>(turn, capturedAt, {
        type: "question",
        header: typeof firstQuestion.header === "string" ? firstQuestion.header : undefined,
        question: typeof firstQuestion.question === "string" ? firstQuestion.question : "",
        options: extractQuestionOptions(firstQuestion),
        multiSelect: firstQuestion.multiSelect === true,
        questionStatus: "denied",
        status: "completed",
      });
      this.emitBlockEnd(capturedAt, turn, block, "completed");
    }

    this.endTurn(record.subtype === "error" ? "failed" : "completed", capturedAt);
  }

  private handleError(record: Record<string, unknown>, capturedAt: number): void {
    const turn = this.ensureTurn(capturedAt);
    const error = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : {};
    const message = typeof error.message === "string"
      ? error.message
      : typeof record.message === "string"
        ? record.message
        : "Unknown error";
    this.emitError(turn, capturedAt, message);
    this.endTurn("failed", capturedAt);
  }

  private maybeEndTurnFromAssistant(record: Record<string, unknown>, capturedAt: number): void {
    const stopReason = record.message && typeof record.message === "object"
      ? (record.message as Record<string, unknown>).stop_reason
      : record.stop_reason;
    if (stopReason === "end_turn") {
      this.endTurn("completed", capturedAt);
    }
  }

  private startTurn(capturedAt: number): Turn {
    if (this.currentTurn) {
      this.endTurn("stopped", capturedAt);
    }

    this.turnCounter += 1;
    this.blockIndex = 0;
    this.toolBlockMap.clear();
    this.questionBlockMap.clear();
    this.blockById.clear();
    this.activeStreamBlocks.clear();
    this.sawStreamTextThisTurn = false;

    this.session.status = "active";
    this.emitEvent(capturedAt, {
      event: "session:update",
      session: { ...this.session },
    });

    const turn: Turn = {
      id: `history-turn-${this.turnCounter}`,
      sessionId: this.session.id,
      status: "started",
      startedAt: new Date(capturedAt).toISOString(),
      blocks: [],
    };
    this.currentTurn = turn;

    this.emitEvent(capturedAt, {
      event: "turn:start",
      sessionId: this.session.id,
      turn,
    });

    return turn;
  }

  private ensureTurn(capturedAt: number): Turn {
    return this.currentTurn ?? this.startTurn(capturedAt);
  }

  private endTurn(status: TurnStatus, capturedAt: number): void {
    const turn = this.currentTurn;
    if (!turn) {
      return;
    }

    turn.status = status;
    turn.endedAt = new Date(capturedAt).toISOString();
    this.emitEvent(capturedAt, {
      event: "turn:end",
      sessionId: this.session.id,
      turnId: turn.id,
      status,
    });

    this.currentTurn = null;
    this.toolBlockMap.clear();
    this.questionBlockMap.clear();
    this.blockById.clear();
    this.activeStreamBlocks.clear();
    this.sawStreamTextThisTurn = false;

    this.session.status = "idle";
    this.emitEvent(capturedAt, {
      event: "session:update",
      session: { ...this.session },
    });
  }

  private startBlock<T extends Block>(
    turn: Turn,
    capturedAt: number,
    partial: Omit<T, "turnId" | "index" | "id"> & { id?: string },
  ): T {
    const block = {
      ...partial,
      id: partial.id || `${turn.id}:block:${this.blockIndex}`,
      turnId: turn.id,
      index: this.blockIndex,
    } as T;
    this.blockIndex += 1;
    turn.blocks.push(block);
    this.blockById.set(block.id, block);

    this.emitEvent(capturedAt, {
      event: "block:start",
      sessionId: this.session.id,
      turnId: turn.id,
      block,
    });

    return block;
  }

  private appendTextDelta(capturedAt: number, turn: Turn, block: TextualBlock, text: string): void {
    if (!text) {
      return;
    }

    block.text += text;
    block.status = "streaming";
    this.emitEvent(capturedAt, {
      event: "block:delta",
      sessionId: this.session.id,
      turnId: turn.id,
      blockId: block.id,
      text,
    });
  }

  private emitBlockEnd(
    capturedAt: number,
    turn: Turn,
    block: Block,
    status: Block["status"],
  ): void {
    block.status = status;
    this.emitEvent(capturedAt, {
      event: "block:end",
      sessionId: this.session.id,
      turnId: turn.id,
      blockId: block.id,
      status,
    });
  }

  private completeOpenStreamBlocks(capturedAt: number, turn: Turn): void {
    for (const block of this.activeStreamBlocks.values()) {
      this.emitBlockEnd(capturedAt, turn, block, "completed");
    }
    this.activeStreamBlocks.clear();
  }

  private emitError(turn: Turn, capturedAt: number, message: string): void {
    const block = this.startBlock<Extract<Block, { type: "error" }>>(turn, capturedAt, {
      type: "error",
      message,
      status: "completed",
    });
    this.emitBlockEnd(capturedAt, turn, block, "completed");
  }

  private emitEvent(capturedAt: number, event: AgentSessionStreamEvent): void {
    this.events.push({
      capturedAt,
      event: structuredClone(event),
    });
  }
}

class PiHistoryParser {
  private readonly events: HistorySessionEvent[] = [];
  private currentTurn: Turn | null = null;
  private turnCounter = 0;
  private blockIndex = 0;
  private lineCount = 0;
  private parsedLineCount = 0;
  private skippedLineCount = 0;
  private toolBlockMap = new Map<string, string>();

  constructor(
    private readonly session: Session,
    private readonly baseTimestampMs: number,
  ) {}

  parse(content: string): {
    events: HistorySessionEvent[];
    lineCount: number;
    parsedLineCount: number;
    skippedLineCount: number;
  } {
    const lines = content.split(/\r?\n/u);
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      this.lineCount += 1;
      let record: Record<string, unknown>;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!isRecord(parsed)) {
          this.skippedLineCount += 1;
          return;
        }
        record = parsed;
      } catch {
        this.skippedLineCount += 1;
        return;
      }

      const capturedAt = extractRecordTimestamp(record) ?? this.baseTimestampMs + index;
      if (this.handleRecord(record, capturedAt)) {
        this.parsedLineCount += 1;
      } else {
        this.skippedLineCount += 1;
      }
    });

    if (this.currentTurn) {
      this.endTurn(this.currentTurn, this.baseTimestampMs + lines.length);
    }

    return {
      events: this.events,
      lineCount: this.lineCount,
      parsedLineCount: this.parsedLineCount,
      skippedLineCount: this.skippedLineCount,
    };
  }

  private handleRecord(record: Record<string, unknown>, capturedAt: number): boolean {
    const type = maybeString(record.type);
    if (type === "session") {
      this.applySessionRecord(record, capturedAt);
      return true;
    }
    if (type === "model_change") {
      this.applyModelRecord(record, capturedAt);
      return true;
    }
    if (type === "thinking_level_change") {
      const runtime = this.ensureObserveMetaRecord("observeRuntime");
      if (this.assignObserveString(runtime, "effort", record.thinkingLevel)) {
        this.emitSessionUpdate(capturedAt);
      }
      return true;
    }
    if (type !== "message" || !isRecord(record.message)) {
      return false;
    }

    const message = record.message;
    const role = maybeString(message.role);
    if (role === "assistant") {
      this.handleAssistantMessage(record, message, capturedAt);
      return true;
    }
    if (role === "toolResult") {
      this.handleToolResultMessage(message, capturedAt);
      return true;
    }
    if (role === "user") {
      return true;
    }
    return false;
  }

  private applySessionRecord(record: Record<string, unknown>, capturedAt: number): void {
    const cwd = maybeString(record.cwd);
    if (cwd) {
      this.session.cwd = cwd;
    }
    const externalSessionId = maybeString(record.id);
    const providerMeta = this.ensureProviderMeta();
    if (externalSessionId) {
      providerMeta.externalSessionId = externalSessionId;
      providerMeta.threadId = externalSessionId;
    }
    this.emitSessionUpdate(capturedAt);
  }

  private applyModelRecord(record: Record<string, unknown>, capturedAt: number): void {
    const model = maybeString(record.modelId) ?? maybeString(record.model);
    const provider = maybeString(record.provider);
    if (model) {
      this.session.model = model;
    }
    const providerMeta = this.ensureProviderMeta();
    if (provider) {
      providerMeta.provider = provider;
    }
    const runtime = this.ensureObserveMetaRecord("observeRuntime");
    if (provider) {
      runtime.modelProvider = provider;
    }
    this.emitSessionUpdate(capturedAt);
  }

  private handleAssistantMessage(
    record: Record<string, unknown>,
    message: Record<string, unknown>,
    capturedAt: number,
  ): void {
    this.applyAssistantMetadata(record, message, capturedAt);
    if (this.currentTurn) {
      this.endTurn(this.currentTurn, capturedAt);
    }

    const turn = this.startTurn(capturedAt);
    const content = Array.isArray(message.content) ? message.content : [];
    let hasOpenToolCall = false;

    for (const part of content) {
      if (!isRecord(part)) continue;
      const type = maybeString(part.type);
      if (type === "thinking") {
        const text = maybeString(part.thinking);
        if (text) {
          this.addTextualBlock(turn, capturedAt, "reasoning", text);
        }
      } else if (type === "text" || type === "output_text") {
        const text = maybeString(part.text);
        if (text) {
          this.addTextualBlock(turn, capturedAt, "text", text);
        }
      } else if (type === "toolCall") {
        hasOpenToolCall = true;
        this.addToolCallBlock(turn, capturedAt, part);
      }
    }

    const stopReason = maybeString(message.stopReason);
    if (!hasOpenToolCall || stopReason !== "toolUse") {
      this.endTurn(turn, capturedAt);
    }
  }

  private handleToolResultMessage(message: Record<string, unknown>, capturedAt: number): void {
    const turn = this.currentTurn ?? this.startTurn(capturedAt);
    const toolCallId = maybeString(message.toolCallId);
    const blockId = toolCallId ? this.toolBlockMap.get(toolCallId) : undefined;
    const output = renderToolResultContent(message.content);
    if (blockId && output) {
      this.emitEvent(capturedAt, {
        event: "block:action:output",
        sessionId: this.session.id,
        turnId: turn.id,
        blockId,
        output,
      });
    }
    if (blockId) {
      const failed = message.isError === true || message.is_error === true;
      this.emitEvent(capturedAt, {
        event: "block:action:status",
        sessionId: this.session.id,
        turnId: turn.id,
        blockId,
        status: failed ? "failed" : "completed",
      });
      this.emitEvent(capturedAt, {
        event: "block:end",
        sessionId: this.session.id,
        turnId: turn.id,
        blockId,
        status: failed ? "failed" : "completed",
      });
      if (toolCallId) {
        this.toolBlockMap.delete(toolCallId);
      }
    }
    this.endTurn(turn, capturedAt);
  }

  private applyAssistantMetadata(
    record: Record<string, unknown>,
    message: Record<string, unknown>,
    capturedAt: number,
  ): void {
    const model = maybeString(record.model) ?? maybeString(message.model);
    const provider = maybeString(record.provider) ?? maybeString(message.provider);
    let changed = false;
    if (model && this.session.model !== model) {
      this.session.model = model;
      changed = true;
    }
    const providerMeta = this.ensureProviderMeta();
    if (provider && providerMeta.provider !== provider) {
      providerMeta.provider = provider;
      changed = true;
    }
    if (isRecord(message.usage)) {
      const usage = this.ensureObserveMetaRecord("observeUsage");
      const inputTokens = maybeNumber(message.usage.input);
      const outputTokens = maybeNumber(message.usage.output);
      const cacheReadInputTokens = maybeNumber(message.usage.cacheRead);
      const totalTokens = maybeNumber(message.usage.totalTokens);
      if (inputTokens !== undefined) usage.inputTokens = inputTokens;
      if (outputTokens !== undefined) usage.outputTokens = outputTokens;
      if (cacheReadInputTokens !== undefined) usage.cacheReadInputTokens = cacheReadInputTokens;
      if (totalTokens !== undefined) usage.totalTokens = totalTokens;
      changed = true;
    }
    if (changed) {
      this.emitSessionUpdate(capturedAt);
    }
  }

  private startTurn(capturedAt: number): Turn {
    this.blockIndex = 0;
    const turn: Turn = {
      id: `${this.session.id}:turn:${++this.turnCounter}`,
      sessionId: this.session.id,
      status: "streaming",
      startedAt: new Date(capturedAt).toISOString(),
      blocks: [],
    };
    this.currentTurn = turn;
    this.emitEvent(capturedAt, {
      event: "turn:start",
      sessionId: this.session.id,
      turn,
    });
    return turn;
  }

  private endTurn(turn: Turn, capturedAt: number): void {
    if (this.currentTurn?.id !== turn.id) return;
    this.currentTurn = null;
    turn.status = "completed";
    turn.endedAt = new Date(capturedAt).toISOString();
    this.emitEvent(capturedAt, {
      event: "turn:end",
      sessionId: this.session.id,
      turnId: turn.id,
      status: "completed",
    });
  }

  private addTextualBlock(turn: Turn, capturedAt: number, type: "text" | "reasoning", text: string): void {
    const block = {
      id: `${turn.id}:${type}:${this.blockIndex}`,
      turnId: turn.id,
      index: this.blockIndex++,
      type,
      text,
      status: "completed",
    } as Extract<Block, { type: "text" | "reasoning" }>;
    turn.blocks.push(block);
    this.emitEvent(capturedAt, {
      event: "block:start",
      sessionId: this.session.id,
      turnId: turn.id,
      block,
    });
    this.emitEvent(capturedAt, {
      event: "block:end",
      sessionId: this.session.id,
      turnId: turn.id,
      blockId: block.id,
      status: "completed",
    });
  }

  private addToolCallBlock(turn: Turn, capturedAt: number, part: Record<string, unknown>): void {
    const toolCallId = maybeString(part.id) ?? `${turn.id}:tool:${this.blockIndex}`;
    const toolName = maybeString(part.name) ?? "unknown";
    const input = part.arguments ?? part.input;
    const block: Extract<Block, { type: "action" }> = {
      id: `${turn.id}:action:${toolCallId}`,
      turnId: turn.id,
      index: this.blockIndex++,
      type: "action",
      action: this.buildAction(toolName, toolCallId, input),
      status: "streaming",
    };
    turn.blocks.push(block);
    this.toolBlockMap.set(toolCallId, block.id);
    this.emitEvent(capturedAt, {
      event: "block:start",
      sessionId: this.session.id,
      turnId: turn.id,
      block,
    });
  }

  private buildAction(toolName: string, toolCallId: string, input: unknown): Action {
    if (toolName === "bash" && isRecord(input)) {
      return {
        kind: "command",
        command: maybeString(input.command) ?? "",
        status: "running",
        output: "",
      };
    }
    if ((toolName === "edit" || toolName === "write") && isRecord(input)) {
      return {
        kind: "file_change",
        path: maybeString(input.file_path) ?? maybeString(input.path) ?? "",
        diff: "",
        status: "running",
        output: "",
      };
    }
    return {
      kind: "tool_call",
      toolName,
      toolCallId,
      input,
      status: "running",
      output: "",
    };
  }

  private ensureProviderMeta(): Record<string, unknown> {
    const providerMeta = isRecord(this.session.providerMeta) ? this.session.providerMeta : {};
    this.session.providerMeta = providerMeta;
    return providerMeta;
  }

  private ensureObserveMetaRecord(key: "observeRuntime" | "observeUsage"): Record<string, unknown> {
    const providerMeta = this.ensureProviderMeta();
    const existing = providerMeta[key];
    if (isRecord(existing)) {
      return existing;
    }
    const next: Record<string, unknown> = {};
    providerMeta[key] = next;
    return next;
  }

  private assignObserveString(target: Record<string, unknown>, key: string, value: unknown): boolean {
    const next = maybeString(value);
    if (!next || target[key] === next) {
      return false;
    }
    target[key] = next;
    return true;
  }

  private emitSessionUpdate(capturedAt: number): void {
    this.emitEvent(capturedAt, {
      event: "session:update",
      session: { ...this.session },
    });
  }

  private emitEvent(capturedAt: number, event: AgentSessionStreamEvent): void {
    this.events.push({
      capturedAt,
      event: structuredClone(event),
    });
  }
}

class CodexHistoryParser {
  private readonly events: HistorySessionEvent[] = [];
  private currentTurn: Turn | null = null;
  private turnCounter = 0;
  private blockIndex = 0;
  private blockById = new Map<string, Block>();
  private toolBlockMap = new Map<string, string>();
  private assistantMessageTextThisTurn = new Set<string>();
  private inputTokens = 0;
  private outputTokens = 0;
  private reasoningOutputTokens = 0;
  private cachedInputTokens = 0;
  private cacheCreationInputTokens = 0;
  private totalTokens = 0;
  private contextInputTokens = 0;
  private previousInputTokens: number | undefined;
  private tokenEventCount = 0;
  private contextWindowTokens: number | undefined;
  private planType: string | undefined;
  private quotaWindows: CodexQuotaWindowObservation[] = [];
  private codexHostMetadataRaw = new Set<string>();

  constructor(
    private readonly session: Session,
    private readonly baseTimestampMs: number,
  ) {}

  parse(content: string): {
    events: HistorySessionEvent[];
    lineCount: number;
    parsedLineCount: number;
    skippedLineCount: number;
  } {
    const lines = content.split(/\r?\n/u);
    let parsedLineCount = 0;
    let skippedLineCount = 0;
    let lineCount = 0;
    let lastCapturedAt = this.baseTimestampMs;

    for (let index = 0; index < lines.length; index += 1) {
      const rawLine = lines[index];
      const trimmed = rawLine.trim();
      if (!trimmed) {
        continue;
      }

      lineCount += 1;

      let record: Record<string, unknown>;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!isRecord(parsed)) {
          skippedLineCount += 1;
          continue;
        }
        record = parsed;
      } catch {
        skippedLineCount += 1;
        continue;
      }

      const capturedAt = extractRecordTimestamp(record) ?? (this.baseTimestampMs + index);
      lastCapturedAt = capturedAt;
      if (this.handleRecord(record, capturedAt)) {
        parsedLineCount += 1;
      } else {
        skippedLineCount += 1;
      }
    }

    if (this.persistUsageMetadata()) {
      this.emitSessionUpdate(lastCapturedAt);
    }

    return {
      events: this.events,
      lineCount,
      parsedLineCount,
      skippedLineCount,
    };
  }

  private handleRecord(record: Record<string, unknown>, capturedAt: number): boolean {
    const type = maybeString(record.type);
    if (!type) {
      return false;
    }

    switch (type) {
      case "session_meta":
        this.handleSessionMeta(record, capturedAt);
        return true;
      case "turn_context":
        this.handleTurnContext(record, capturedAt);
        return true;
      case "event_msg":
        this.handleEventMessage(record, capturedAt);
        return true;
      case "response_item":
        this.handleResponseItem(record, capturedAt);
        return true;
      case "compacted":
        return true;
      default:
        return false;
    }
  }

  private handleSessionMeta(record: Record<string, unknown>, capturedAt: number): void {
    const payload = isRecord(record.payload) ? record.payload : {};
    let changed = false;
    const providerMeta = this.ensureProviderMeta();

    const externalSessionId = maybeString(payload.id);
    if (externalSessionId && providerMeta.externalSessionId !== externalSessionId) {
      providerMeta.externalSessionId = externalSessionId;
      changed = true;
    }

    const cwd = maybeString(payload.cwd);
    if (cwd && this.session.cwd !== cwd) {
      this.session.cwd = cwd;
      if (!this.session.name || /^\d+$/u.test(this.session.name)) {
        this.session.name = basename(cwd) || "Codex Session";
      }
      changed = true;
    }

    const git = isRecord(payload.git) ? payload.git : null;
    const runtime = this.ensureObserveMetaRecord("observeRuntime");
    changed = this.assignObserveString(runtime, "originator", payload.originator) || changed;
    changed = this.assignObserveString(runtime, "cliVersion", payload.cli_version) || changed;
    changed = this.assignObserveString(runtime, "source", payload.source) || changed;
    changed = this.assignObserveString(runtime, "threadSource", payload.thread_source) || changed;
    changed = this.assignObserveString(runtime, "modelProvider", payload.model_provider) || changed;
    changed = this.assignObserveString(runtime, "gitBranch", git?.branch) || changed;
    changed = this.assignObserveString(runtime, "gitCommitHash", git?.commit_hash) || changed;
    changed = this.assignObserveString(runtime, "repositoryUrl", git?.repository_url) || changed;

    if (changed) {
      this.emitSessionUpdate(capturedAt);
    }
  }

  private handleTurnContext(record: Record<string, unknown>, capturedAt: number): void {
    const payload = isRecord(record.payload) ? record.payload : {};
    let changed = false;

    const cwd = maybeString(payload.cwd);
    if (cwd && this.session.cwd !== cwd) {
      this.session.cwd = cwd;
      changed = true;
    }

    const model = maybeString(payload.model);
    if (model && this.session.model !== model) {
      this.session.model = model;
      changed = true;
    }

    const runtime = this.ensureObserveMetaRecord("observeRuntime");
    changed = this.assignObserveString(runtime, "approvalPolicy", payload.approval_policy) || changed;
    changed = this.assignObserveString(runtime, "currentDate", payload.current_date) || changed;
    changed = this.assignObserveString(runtime, "timezone", payload.timezone) || changed;
    changed = this.assignObserveString(runtime, "effort", payload.effort) || changed;
    changed = this.assignObserveString(runtime, "personality", payload.personality) || changed;

    if (isRecord(payload.sandbox_policy) && runtime.sandboxPolicy !== payload.sandbox_policy) {
      runtime.sandboxPolicy = payload.sandbox_policy;
      changed = true;
    }

    if (changed) {
      this.emitSessionUpdate(capturedAt);
    }
  }

  private handleEventMessage(record: Record<string, unknown>, capturedAt: number): void {
    const payload = isRecord(record.payload) ? record.payload : {};
    const eventType = maybeString(payload.type);
    if (!eventType) {
      return;
    }

    switch (eventType) {
      case "task_started": {
        const startedAt = normalizeTimestamp(payload.started_at) ?? capturedAt;
        this.startTurn(startedAt, maybeString(payload.turn_id));
        break;
      }
      case "user_message":
        this.ensureTurn(capturedAt);
        break;
      case "agent_message": {
        const message = maybeString(payload.message);
        if (message) {
          this.appendCodexAssistantText(capturedAt, message);
        }
        break;
      }
      case "patch_apply_end":
        this.handleToolOutput(
          capturedAt,
          maybeString(payload.call_id),
          [maybeString(payload.stdout), maybeString(payload.stderr)].filter(Boolean).join("\n"),
          payload.success === false,
        );
        break;
      case "token_count":
        this.captureTokenUsage(payload, capturedAt);
        break;
      case "task_complete":
        this.endTurn("completed", normalizeTimestamp(payload.completed_at) ?? capturedAt);
        break;
      case "context_compacted":
      case "web_search_end":
        break;
      default:
        break;
    }
  }

  private handleResponseItem(record: Record<string, unknown>, capturedAt: number): void {
    const payload = isRecord(record.payload) ? record.payload : {};
    const itemType = maybeString(payload.type);
    if (!itemType) {
      return;
    }

    switch (itemType) {
      case "message":
        this.handleResponseMessage(payload, capturedAt);
        break;
      case "reasoning":
        this.handleReasoning(payload, capturedAt);
        break;
      case "function_call":
      case "custom_tool_call":
        this.handleToolCall(payload, capturedAt);
        break;
      case "function_call_output":
      case "custom_tool_call_output":
        this.handleToolOutput(
          capturedAt,
          maybeString(payload.call_id),
          renderToolResultContent(payload.output),
          false,
        );
        break;
      case "web_search_call":
        this.handleWebSearchCall(payload, capturedAt);
        break;
      default:
        break;
    }
  }

  private handleResponseMessage(payload: Record<string, unknown>, capturedAt: number): void {
    const role = maybeString(payload.role);
    if (role !== "assistant") {
      return;
    }

    const text = renderContentPartsText(payload.content).trim();
    if (!text) {
      return;
    }

    this.appendCodexAssistantText(capturedAt, text);
  }

  private handleReasoning(payload: Record<string, unknown>, capturedAt: number): void {
    const text = extractReasoningText(payload);
    if (!text) {
      return;
    }

    const turn = this.ensureTurn(capturedAt);
    const block = this.startBlock<Extract<Block, { type: "reasoning" }>>(turn, capturedAt, {
      type: "reasoning",
      text,
      status: "completed",
    });
    this.emitBlockEnd(capturedAt, turn, block, "completed");
  }

  private handleToolCall(payload: Record<string, unknown>, capturedAt: number): void {
    const turn = this.ensureTurn(capturedAt);
    const toolName = maybeString(payload.name) ?? "unknown";
    const toolCallId = maybeString(payload.call_id) ?? `${turn.id}:tool:${this.blockIndex}`;
    const input = this.parseToolInput(payload.arguments ?? payload.input);
    const action = this.buildAction(toolName, toolCallId, input);

    const block = this.startBlock<Extract<Block, { type: "action" }>>(turn, capturedAt, {
      id: `${turn.id}:action:${toolCallId}`,
      type: "action",
      action,
      status: "streaming",
    });
    this.toolBlockMap.set(toolCallId, block.id);
  }

  private handleWebSearchCall(payload: Record<string, unknown>, capturedAt: number): void {
    const turn = this.ensureTurn(capturedAt);
    const toolCallId = `${turn.id}:web-search:${this.blockIndex}`;
    const action: Action = {
      kind: "tool_call",
      toolName: "web_search",
      toolCallId,
      input: payload.action,
      result: payload.status,
      status: maybeString(payload.status) === "failed" ? "failed" : "completed",
      output: "",
    };
    const block = this.startBlock<Extract<Block, { type: "action" }>>(turn, capturedAt, {
      id: `${turn.id}:action:${toolCallId}`,
      type: "action",
      action,
      status: "completed",
    });
    this.emitBlockEnd(capturedAt, turn, block, "completed");
  }

  private parseToolInput(value: unknown): unknown {
    if (typeof value !== "string") {
      return value;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return "";
    }

    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return value;
    }
  }

  private buildAction(toolName: string, toolCallId: string, input: unknown): Action {
    const inputRecord = isRecord(input) ? input : {};

    if (toolName === "exec_command") {
      return {
        kind: "command",
        command: maybeString(inputRecord.cmd) ?? "",
        status: "running",
        output: "",
      };
    }

    return {
      kind: "tool_call",
      toolName,
      toolCallId,
      input,
      status: "running",
      output: "",
    };
  }

  private handleToolOutput(
    capturedAt: number,
    toolCallId: string | undefined,
    output: string,
    isError: boolean,
  ): void {
    if (!toolCallId) {
      return;
    }

    const blockId = this.toolBlockMap.get(toolCallId);
    const turn = this.currentTurn;
    if (!blockId || !turn) {
      return;
    }

    if (output) {
      this.emitEvent(capturedAt, {
        event: "block:action:output",
        sessionId: this.session.id,
        turnId: turn.id,
        blockId,
        output,
      });
    }

    const exitCode = this.extractExitCode(output);
    const status = isError || (exitCode != null && exitCode !== 0) ? "failed" : "completed";
    this.emitEvent(capturedAt, {
      event: "block:action:status",
      sessionId: this.session.id,
      turnId: turn.id,
      blockId,
      status,
      ...(exitCode != null ? { meta: { exitCode } } : {}),
    });

    const block = this.blockById.get(blockId);
    if (block) {
      this.emitBlockEnd(capturedAt, turn, block, status === "failed" ? "failed" : "completed");
    }
    this.toolBlockMap.delete(toolCallId);
  }

  private extractExitCode(output: string): number | null {
    const match = output.match(/(?:exit code|exited with code):\s*(-?\d+)/iu);
    if (!match) {
      return null;
    }

    const exitCode = Number(match[1]);
    return Number.isFinite(exitCode) ? exitCode : null;
  }

  private captureTokenUsage(payload: unknown, capturedAt: number): void {
    const observation = readCodexRolloutUsageObservation(payload, capturedAt);
    if (!observation) {
      return;
    }

    // Codex logs its window most events — learn it once per model so the fallback
    // tracks real data rather than a baked-in constant.
    recordObservedContextWindow(this.session.model, observation.contextWindowTokens);
    const contextWindowTokens = observation.contextWindowTokens
      ?? observedContextWindowTokens(this.session.model)
      ?? codexContextWindowTokens(this.session.model);
    const fallbackContextInputTokens = observation.inputTokens === undefined || this.previousInputTokens === undefined
      ? undefined
      : observation.inputTokens - this.previousInputTokens;
    const contextInputTokens = observation.contextInputTokens !== undefined && observation.contextInputTokens > 0
      ? observation.contextInputTokens
      : fallbackContextInputTokens;
    if (
      contextInputTokens !== undefined
      && contextInputTokens > 0
      && contextInputTokens <= contextWindowTokens
    ) {
      this.contextInputTokens = contextInputTokens;
    }
    this.previousInputTokens = observation.inputTokens ?? this.previousInputTokens;
    this.inputTokens = observation.inputTokens ?? this.inputTokens;
    this.outputTokens = observation.outputTokens ?? this.outputTokens;
    this.reasoningOutputTokens = observation.reasoningOutputTokens ?? this.reasoningOutputTokens;
    this.cachedInputTokens = observation.cacheReadInputTokens ?? this.cachedInputTokens;
    this.cacheCreationInputTokens = observation.cacheCreationInputTokens ?? this.cacheCreationInputTokens;
    this.totalTokens = observation.totalTokens
      ?? (
        observation.inputTokens !== undefined || observation.outputTokens !== undefined
          ? (observation.inputTokens ?? 0) + (observation.outputTokens ?? 0)
          : this.totalTokens
      );
    this.contextWindowTokens = contextWindowTokens;
    this.planType = observation.planType ?? this.planType;
    if (observation.quotaWindows.length > 0) {
      this.quotaWindows = observation.quotaWindows;
    }
    this.tokenEventCount += 1;
  }

  private persistUsageMetadata(): boolean {
    if (this.tokenEventCount === 0) {
      return false;
    }

    const usage = this.ensureObserveMetaRecord("observeUsage");
    let changed = false;
    const assignNumber = (key: string, value: number): void => {
      if (value > 0 && usage[key] !== value) {
        usage[key] = value;
        changed = true;
      }
    };

    assignNumber("inputTokens", this.inputTokens);
    assignNumber("contextInputTokens", this.contextInputTokens);
    assignNumber("outputTokens", this.outputTokens);
    assignNumber("reasoningOutputTokens", this.reasoningOutputTokens);
    assignNumber("cacheReadInputTokens", this.cachedInputTokens);
    assignNumber("cacheCreationInputTokens", this.cacheCreationInputTokens);
    assignNumber("totalTokens", this.totalTokens);
    if (this.contextWindowTokens !== undefined) assignNumber("contextWindowTokens", this.contextWindowTokens);
    assignNumber("tokenEvents", this.tokenEventCount);
    if (this.planType && usage.planType !== this.planType) {
      usage.planType = this.planType;
      changed = true;
    }
    if (this.quotaWindows.length > 0) {
      const quota = this.ensureObserveMetaRecord("observeQuota");
      if (quota.provider !== "openai") {
        quota.provider = "openai";
        changed = true;
      }
      if (this.planType && quota.planType !== this.planType) {
        quota.planType = this.planType;
        changed = true;
      }
      const nextWindows = structuredClone(this.quotaWindows);
      if (JSON.stringify(quota.windows) !== JSON.stringify(nextWindows)) {
        quota.windows = nextWindows;
        changed = true;
      }
    }
    return changed;
  }

  private startTurn(capturedAt: number, turnId?: string): Turn {
    if (this.currentTurn) {
      this.endTurn("stopped", capturedAt);
    }

    this.turnCounter += 1;
    this.blockIndex = 0;
    this.blockById.clear();
    this.toolBlockMap.clear();
    this.assistantMessageTextThisTurn.clear();

    this.session.status = "active";
    this.emitSessionUpdate(capturedAt);

    const turn: Turn = {
      id: turnId || `history-turn-${this.turnCounter}`,
      sessionId: this.session.id,
      status: "started",
      startedAt: new Date(capturedAt).toISOString(),
      blocks: [],
    };
    this.currentTurn = turn;

    this.emitEvent(capturedAt, {
      event: "turn:start",
      sessionId: this.session.id,
      turn,
    });

    return turn;
  }

  private ensureTurn(capturedAt: number): Turn {
    return this.currentTurn ?? this.startTurn(capturedAt);
  }

  private endTurn(status: TurnStatus, capturedAt: number): void {
    const turn = this.currentTurn;
    if (!turn) {
      return;
    }

    turn.status = status;
    turn.endedAt = new Date(capturedAt).toISOString();
    this.emitEvent(capturedAt, {
      event: "turn:end",
      sessionId: this.session.id,
      turnId: turn.id,
      status,
    });

    this.currentTurn = null;
    this.blockById.clear();
    this.toolBlockMap.clear();
    this.assistantMessageTextThisTurn.clear();

    this.session.status = "idle";
    this.emitSessionUpdate(capturedAt);
  }

  private appendCompletedText(capturedAt: number, text: string): void {
    const turn = this.ensureTurn(capturedAt);
    const block = this.startBlock<Extract<Block, { type: "text" }>>(turn, capturedAt, {
      type: "text",
      text,
      status: "completed",
    });
    this.emitBlockEnd(capturedAt, turn, block, "completed");
  }

  private appendCodexAssistantText(capturedAt: number, rawText: string): void {
    const projected = projectCodexAssistantText(rawText);
    const changed = this.recordCodexHostMetadata(projected.hostMetadata);
    const text = projected.text.trim();
    if (!text) {
      if (changed) {
        this.emitSessionUpdate(capturedAt);
      }
      return;
    }
    if (this.assistantMessageTextThisTurn.has(text)) {
      if (changed) {
        this.emitSessionUpdate(capturedAt);
      }
      return;
    }

    if (changed) {
      this.emitSessionUpdate(capturedAt);
    }
    this.appendCompletedText(capturedAt, text);
    this.assistantMessageTextThisTurn.add(text);
  }

  private recordCodexHostMetadata(entries: CodexHostMetadata[]): boolean {
    if (entries.length === 0) {
      return false;
    }

    const fresh = entries.filter((entry) => {
      if (this.codexHostMetadataRaw.has(entry.raw)) {
        return false;
      }
      this.codexHostMetadataRaw.add(entry.raw);
      return true;
    });
    if (fresh.length === 0) {
      return false;
    }

    const metadata = this.ensureObserveMetaRecord("observeHostMetadata");
    const directives = Array.isArray(metadata.directives)
      ? metadata.directives.filter(isRecord)
      : [];
    const memoryCitations = Array.isArray(metadata.memoryCitations)
      ? metadata.memoryCitations.filter(isRecord)
      : [];

    for (const entry of fresh) {
      if (entry.kind === "directive") {
        directives.push({
          name: entry.name,
          raw: entry.raw,
        });
      } else {
        memoryCitations.push({
          raw: entry.raw,
          citationEntries: entry.citationEntries,
          rolloutIds: entry.rolloutIds,
        });
      }
    }

    if (directives.length > 0) {
      metadata.directives = directives;
    }
    if (memoryCitations.length > 0) {
      metadata.memoryCitations = memoryCitations;
    }
    return true;
  }

  private startBlock<T extends Block>(
    turn: Turn,
    capturedAt: number,
    partial: Omit<T, "turnId" | "index" | "id"> & { id?: string },
  ): T {
    const block = {
      ...partial,
      id: partial.id || `${turn.id}:block:${this.blockIndex}`,
      turnId: turn.id,
      index: this.blockIndex,
    } as T;
    this.blockIndex += 1;
    turn.blocks.push(block);
    this.blockById.set(block.id, block);

    this.emitEvent(capturedAt, {
      event: "block:start",
      sessionId: this.session.id,
      turnId: turn.id,
      block,
    });

    return block;
  }

  private emitBlockEnd(
    capturedAt: number,
    turn: Turn,
    block: Block,
    status: Block["status"],
  ): void {
    block.status = status;
    this.emitEvent(capturedAt, {
      event: "block:end",
      sessionId: this.session.id,
      turnId: turn.id,
      blockId: block.id,
      status,
    });
  }

  private ensureProviderMeta(): Record<string, unknown> {
    const providerMeta = isRecord(this.session.providerMeta) ? this.session.providerMeta : {};
    this.session.providerMeta = providerMeta;
    return providerMeta;
  }

  private ensureObserveMetaRecord(key: "observeRuntime" | "observeUsage" | "observeQuota" | "observeHostMetadata"): Record<string, unknown> {
    const providerMeta = this.ensureProviderMeta();
    const existing = providerMeta[key];
    if (isRecord(existing)) {
      return existing;
    }

    const next: Record<string, unknown> = {};
    providerMeta[key] = next;
    return next;
  }

  private assignObserveString(
    target: Record<string, unknown>,
    key: string,
    value: unknown,
  ): boolean {
    const next = maybeString(value);
    if (!next || target[key] === next) {
      return false;
    }

    target[key] = next;
    return true;
  }

  private emitSessionUpdate(capturedAt: number): void {
    this.emitEvent(capturedAt, {
      event: "session:update",
      session: { ...this.session },
    });
  }

  private emitEvent(capturedAt: number, event: AgentSessionStreamEvent): void {
    this.events.push({
      capturedAt,
      event: structuredClone(event),
    });
  }
}

export function inferHistorySessionAdapterType(
  path: string,
  adapterType?: string | null,
): HistoryAdapterType {
  return inferHistoryAdapterType(path, adapterType);
}

export function supportsHistorySessionSnapshotForPath(
  path: string,
  adapterType?: string | null,
): boolean {
  const inferred = inferHistoryAdapterType(path, adapterType);
  return inferred === "claude-code" || inferred === "codex" || inferred === "pi";
}

export function createHistorySessionSnapshot(
  input: HistorySessionSnapshotInput,
): HistorySessionSnapshotResult {
  const adapterType = inferHistoryAdapterType(input.path, input.adapterType);
  if (adapterType !== "claude-code" && adapterType !== "codex" && adapterType !== "pi") {
    throw new Error(`History snapshot is not supported for adapter type "${adapterType}".`);
  }

  const session = buildBaseHistorySession(input, adapterType);
  const baseTimestampMs = normalizeTimestamp(input.baseTimestampMs) ?? Date.now();
  const parser = adapterType === "codex"
    ? new CodexHistoryParser(session, baseTimestampMs)
    : adapterType === "pi"
      ? new PiHistoryParser(session, baseTimestampMs)
      : new ClaudeCodeHistoryParser(session, baseTimestampMs);
  const replay = parser.parse(input.content);

  const tracker = new StateTracker();
  tracker.createSession(session.id, session);
  for (const entry of replay.events) {
    tracker.trackEvent(session.id, entry.event, entry.capturedAt);
  }

  const snapshot = tracker.getSessionState(session.id);
  if (!snapshot) {
    throw new Error("Failed to reconstruct session snapshot from history.");
  }

  return {
    adapterType,
    lineCount: replay.lineCount,
    parsedLineCount: replay.parsedLineCount,
    skippedLineCount: replay.skippedLineCount,
    events: replay.events,
    snapshot,
  };
}
