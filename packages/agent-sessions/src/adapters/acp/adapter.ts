import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { redactSecrets } from "../../secret-redaction.js";
import { BaseAdapter, type AdapterConfig } from "../../protocol/adapter.js";
import type {
  Action,
  Block,
  BlockStatus,
  Prompt,
  QuestionAnswer,
  QuestionBlock,
  SessionStatus,
  Turn,
  TurnStatus,
} from "../../protocol/primitives.js";
import { scoutUserSpawnEnvironment } from "../../scout-state-paths.js";

type JsonRpcId = string | number | null;

type JsonRpcResponse = {
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

type JsonRpcRequest = {
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

type JsonRpcMessage = JsonRpcResponse | JsonRpcRequest | JsonRpcNotification;

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | null;
};

type AcpContentBlock = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  title?: string | null;
  resource?: {
    uri?: string;
    text?: string;
    blob?: string;
    mimeType?: string;
  };
};

type AcpToolCallContent =
  | { type: "content"; content?: AcpContentBlock }
  | { type: "diff"; path?: string; oldText?: string | null; newText?: string | null }
  | { type: "terminal"; terminalId?: string };

type AcpToolCallUpdate = {
  toolCallId?: string;
  title?: string | null;
  kind?: string | null;
  status?: "pending" | "in_progress" | "completed" | "failed" | null;
  content?: AcpToolCallContent[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
};

type AcpSessionUpdate = {
  sessionUpdate?: string;
  content?: AcpContentBlock;
  entries?: Array<{ content?: string; priority?: string; status?: string }>;
  toolCallId?: string;
  title?: string | null;
  kind?: string | null;
  status?: "pending" | "in_progress" | "completed" | "failed" | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  sessionId?: string;
  [key: string]: unknown;
};

type AcpInitializeResponse = {
  protocolVersion?: number;
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: {
      image?: boolean;
      embeddedContext?: boolean;
    };
    sessionCapabilities?: {
      resume?: Record<string, unknown>;
      close?: Record<string, unknown>;
    };
    [key: string]: unknown;
  };
  agentInfo?: {
    name?: string;
    title?: string;
    version?: string;
  } | null;
  authMethods?: Array<{ id?: string; methodId?: string; name?: string }>;
};

type ActiveTurnState = {
  turnId: string;
  blockIndex: number;
  textBlockId: string | null;
  reasoningBlockId: string | null;
  blocks: Map<string, Block>;
  endedBlocks: Set<string>;
  toolBlocksByCallId: Map<string, string>;
  ended: boolean;
};

type PendingPermission = {
  requestId: JsonRpcId;
  turnId: string;
  blockId: string;
  allowOptionId: string | null;
  rejectOptionId: string | null;
};

type PendingCursorQuestion = {
  requestId: JsonRpcId;
  turnId: string;
  questionId: string;
  optionIdsByLabel: Map<string, string>;
};

type PendingCursorQuestionRequest = {
  requestId: JsonRpcId;
  answers: Map<string, string[]>;
  remainingBlockIds: Set<string>;
};

type PendingCursorPlan = {
  requestId: JsonRpcId;
  turnId: string;
  blockId: string;
};

type AcpSessionResult = {
  sessionId?: string;
  models?: { currentModelId?: string };
};

type AcpAdapterOptions = {
  adapterType: string;
  command: string;
  args: string[];
  cwd: string;
  protocolVersion: number;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  promptTimeoutMs: number | null;
  sessionId: string | null;
  sessionMode: "new" | "load" | "resume" | "auto";
  model: string | null;
  reasoningEffort: string | null;
  authMethodId: string | null;
  authMethodPreference: string[];
  requireAuth: boolean;
  mcpServers: unknown[];
  additionalDirectories: string[];
  readTextFile: boolean;
  writeTextFile: boolean;
  cursorExtensions: boolean;
  cursorInteractionMode: "interactive" | "safe_reject";
  permissionMode: "interactive" | "safe_reject" | "auto_approve";
  clientInfo: {
    name: string;
    title: string;
    version: string;
  };
};

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL_ERROR = -32603;
const ACP_PROTOCOL_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseOptions(config: AdapterConfig): AcpAdapterOptions {
  const raw = isRecord(config.options) ? config.options : {};
  const command = stringValue(raw.command) ?? stringValue(process.env.OPENSCOUT_ACP_COMMAND);
  if (!command) {
    throw new Error("ACP adapter requires options.command, for example { command: \"codex\", args: [\"acp\"] }.");
  }

  const cwd = config.cwd ?? process.cwd();
  const sessionModeRaw = stringValue(raw.sessionMode);
  const sessionMode = sessionModeRaw === "load" || sessionModeRaw === "resume" || sessionModeRaw === "new"
    ? sessionModeRaw
    : "auto";

  return {
    adapterType: stringValue(raw.adapterType) ?? "acp",
    command,
    args: stringArray(raw.args),
    cwd,
    protocolVersion: numberValue(raw.protocolVersion, ACP_PROTOCOL_VERSION),
    startupTimeoutMs: numberValue(raw.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS),
    requestTimeoutMs: numberValue(raw.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
    promptTimeoutMs: typeof raw.promptTimeoutMs === "number" && Number.isFinite(raw.promptTimeoutMs) && raw.promptTimeoutMs > 0
      ? raw.promptTimeoutMs
      : null,
    sessionId: stringValue(raw.sessionId),
    sessionMode,
    model: stringValue(raw.model),
    reasoningEffort: stringValue(raw.reasoningEffort),
    authMethodId: stringValue(raw.authMethodId),
    authMethodPreference: stringArray(raw.authMethodPreference),
    requireAuth: booleanValue(raw.requireAuth, false),
    mcpServers: Array.isArray(raw.mcpServers) ? raw.mcpServers : [],
    additionalDirectories: stringArray(raw.additionalDirectories),
    readTextFile: booleanValue(raw.readTextFile, true),
    writeTextFile: booleanValue(raw.writeTextFile, booleanValue(raw.allowWriteTextFile, false)),
    cursorExtensions: booleanValue(raw.cursorExtensions, false),
    cursorInteractionMode: stringValue(raw.cursorInteractionMode) === "safe_reject"
      ? "safe_reject"
      : "interactive",
    permissionMode: stringValue(raw.permissionMode) === "safe_reject"
      ? "safe_reject"
      : stringValue(raw.permissionMode) === "auto_approve"
        ? "auto_approve"
        : "interactive",
    clientInfo: {
      name: stringValue(raw.clientName) ?? "openscout",
      title: stringValue(raw.clientTitle) ?? "OpenScout",
      version: stringValue(raw.clientVersion) ?? "0.0.0",
    },
  };
}

function parseJsonLine(line: string): JsonRpcMessage | null {
  try {
    return JSON.parse(line) as JsonRpcMessage;
  } catch {
    return null;
  }
}

function isResponse(message: unknown): message is JsonRpcResponse {
  return Boolean(
    isRecord(message)
    && "id" in message
    && ("result" in message || "error" in message)
  );
}

function isRequest(message: unknown): message is JsonRpcRequest {
  return Boolean(
    isRecord(message)
    && "id" in message
    && typeof message.method === "string"
    && !("result" in message)
    && !("error" in message)
  );
}

function isNotification(message: unknown): message is JsonRpcNotification {
  return Boolean(
    isRecord(message)
    && typeof message.method === "string"
    && !("id" in message)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function authMethodId(method: { id?: string; methodId?: string; name?: string }): string | null {
  return stringValue(method.id) ?? stringValue(method.methodId);
}

function resolveAuthMethodId(
  options: AcpAdapterOptions,
  authMethods: AcpInitializeResponse["authMethods"],
): string | null {
  const available = (authMethods ?? [])
    .map(authMethodId)
    .filter((entry): entry is string => entry !== null);
  const availableSet = new Set(available);

  if (options.authMethodId) {
    if (available.length > 0 && !availableSet.has(options.authMethodId)) {
      throw new Error(
        `ACP auth method "${options.authMethodId}" is not available. Available methods: ${available.join(", ") || "none"}.`,
      );
    }
    return options.authMethodId;
  }

  for (const preferred of options.authMethodPreference) {
    if (availableSet.has(preferred)) {
      return preferred;
    }
  }

  if (options.requireAuth) {
    const requested = options.authMethodPreference.length > 0
      ? ` Requested methods: ${options.authMethodPreference.join(", ")}.`
      : "";
    throw new Error(
      `ACP agent requires authentication, but no compatible auth method is available.`
      + ` Available methods: ${available.join(", ") || "none"}.${requested}`,
    );
  }

  return null;
}

function mapSessionStatus(status: string | null | undefined): SessionStatus {
  switch (status) {
    case "idle":
      return "idle";
    case "working":
    case "running":
    case "in_progress":
      return "active";
    case "failed":
    case "error":
      return "error";
    default:
      return "active";
  }
}

function mapTurnStatus(stopReason: unknown): TurnStatus {
  switch (stopReason) {
    case "cancelled":
      return "stopped";
    // The provider cut the turn short or declined it — reporting any of these
    // as "completed" would read as success to the caller.
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
      return "failed";
    default:
      return "completed";
  }
}

function mapToolStatus(status: AcpToolCallUpdate["status"]): Action["status"] {
  switch (status) {
    case "pending":
      return "pending";
    case "in_progress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "running";
  }
}

function textFromContent(content: AcpContentBlock | undefined): string {
  if (!content) {
    return "";
  }

  switch (content.type) {
    case "text":
      return content.text ?? "";
    case "resource": {
      const resource = content.resource;
      if (!resource) {
        return "";
      }
      if (typeof resource.text === "string") {
        return resource.text;
      }
      return resource.uri ? `[resource: ${resource.uri}]` : "";
    }
    case "resource_link":
      return [content.name, content.uri].filter(Boolean).join(" ");
    case "image":
      return content.uri ? `[image: ${content.uri}]` : "[image]";
    case "audio":
      return "[audio]";
    default:
      return content.text ?? "";
  }
}

function diffText(content: Extract<AcpToolCallContent, { type: "diff" }>): string {
  const path = content.path ?? "unknown path";
  const oldText = content.oldText ?? "";
  const newText = content.newText ?? "";
  return `Diff ${path}\n--- old\n${oldText}\n+++ new\n${newText}`;
}

function outputFromToolContent(content: AcpToolCallContent[] | null | undefined): string {
  if (!content?.length) {
    return "";
  }

  return content
    .map((entry) => {
      switch (entry.type) {
        case "content":
          return textFromContent(entry.content);
        case "diff":
          return diffText(entry);
        case "terminal":
          return entry.terminalId ? `Terminal ${entry.terminalId}` : "Terminal output";
      }
    })
    .filter(Boolean)
    .join("\n");
}

function toolName(input: AcpToolCallUpdate): string {
  return input.title?.trim() || input.kind?.trim() || "ACP tool call";
}

function buildToolAction(input: AcpToolCallUpdate): Action {
  return {
    kind: "tool_call",
    toolName: toolName(input),
    toolCallId: input.toolCallId ?? crypto.randomUUID(),
    status: mapToolStatus(input.status),
    output: outputFromToolContent(input.content),
    input: input.rawInput,
    result: input.rawOutput,
  };
}

function toolUpdateFromSessionUpdate(update: AcpSessionUpdate): AcpToolCallUpdate {
  return {
    toolCallId: typeof update.toolCallId === "string" ? update.toolCallId : undefined,
    title: typeof update.title === "string" ? update.title : null,
    kind: typeof update.kind === "string" ? update.kind : null,
    status: update.status ?? null,
    content: Array.isArray(update.content) ? update.content as AcpToolCallContent[] : null,
    rawInput: update.rawInput,
    rawOutput: update.rawOutput,
  };
}

function promptToContent(prompt: Prompt, includeImages: boolean): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = [];
  if (prompt.text.trim()) {
    blocks.push({ type: "text", text: prompt.text });
  }

  for (const file of prompt.files ?? []) {
    const uri = isAbsolute(file) ? pathToFileURL(file).href : file;
    blocks.push({
      type: "resource_link",
      uri,
      name: file.split("/").pop() || file,
    });
  }

  if (includeImages) {
    for (const image of prompt.images ?? []) {
      blocks.push({
        type: "image",
        mimeType: image.mimeType,
        data: image.data,
      });
    }
  }

  if (!blocks.length) {
    blocks.push({ type: "text", text: "" });
  }

  return blocks;
}

function isPathInside(root: string, filePath: string): boolean {
  const rel = relative(root, filePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export class AcpAdapter extends BaseAdapter {
  readonly type: string;

  private readonly acpOptions: AcpAdapterOptions;
  private process: ChildProcessWithoutNullStreams | null = null;
  private lineBuffer = "";
  private requestId = 0;
  private pendingRequests = new Map<JsonRpcId, PendingRequest>();
  private currentSessionId: string | null = null;
  private currentAcpModelId: string | null = null;
  private agentCapabilities: AcpInitializeResponse["agentCapabilities"] = {};
  private activeTurn: ActiveTurnState | null = null;
  private pendingPermissions = new Map<string, PendingPermission>();
  private pendingCursorQuestions = new Map<string, PendingCursorQuestion>();
  private pendingCursorQuestionRequests = new Map<JsonRpcId, PendingCursorQuestionRequest>();
  private pendingCursorPlans = new Map<string, PendingCursorPlan>();
  private promptQueue: Promise<void> = Promise.resolve();
  private queuedPrompts = 0;
  private readonly liveIncarnation = crypto.randomUUID();
  private liveRevision = 0;
  private attentionUnsafe = false;

  constructor(config: AdapterConfig) {
    super(config);
    this.acpOptions = parseOptions(config);
    this.type = this.acpOptions.adapterType;
    (this.session as { adapterType: string }).adapterType = this.type;
  }

  async start(): Promise<void> {
    await this.startProcess();
  }

  send(prompt: Prompt): void {
    this.queuedPrompts++;
    this.promptQueue = this.promptQueue.then(
      () => this.runPrompt(prompt),
      () => this.runPrompt(prompt),
    ).finally(() => { this.queuedPrompts--; });
  }

  observeExisting() {
    const alive = !!this.process && !this.process.killed && this.process.exitCode === null;
    return { state: !alive ? "gone" : !this.currentSessionId || this.attentionUnsafe || this.pendingPermissions.size
      || this.pendingCursorQuestions.size || this.pendingCursorPlans.size ? "unknown"
      : this.activeTurn ? "active" : this.queuedPrompts ? "unknown" : "idle",
      sessionId: this.currentSessionId ?? undefined, turnId: this.activeTurn?.turnId,
      token: `${this.liveIncarnation}:${this.liveRevision}`, steer: false } as const;
  }

  submitExisting(expected: { sessionId: string; token: string }, action: "revive" | "steer", text: string) {
    const observed = this.observeExisting();
    if (action !== "revive" || observed.state !== "idle" || expected.sessionId !== observed.sessionId
      || expected.token !== observed.token) return { accepted: false, evidence: "native_state_changed_or_unsupported" };
    // runPrompt reserves the turn and writes session/prompt synchronously before its first await.
    // Never start/load an ACP session and never cancel+prompt to emulate steer.
    this.promptQueue = this.runPrompt({ sessionId: this.session.id, text }).catch(() => undefined);
    return { accepted: true, evidence: "acp_prompt_requested" };
  }

  interrupt(): void {
    if (this.currentSessionId) {
      this.notify("session/cancel", { sessionId: this.currentSessionId });
    }
    this.cancelPendingPermissions();
    this.cancelCursorInteractions("Cursor interaction cancelled.");
    this.finishTurn("stopped");
  }

  decide(turnId: string, blockId: string, decision: "approve" | "deny"): void {
    const key = this.permissionKey(turnId, blockId);
    const cursorPlan = this.pendingCursorPlans.get(key);
    if (cursorPlan) {
      this.pendingCursorPlans.delete(key);
      this.writeResult(cursorPlan.requestId, {
        outcome: decision === "approve"
          ? { outcome: "accepted" }
          : { outcome: "rejected", reason: "User rejected the Cursor plan." },
      });
      this.emit("event", {
        event: "block:action:status",
        sessionId: this.session.id,
        turnId,
        blockId,
        status: decision === "approve" ? "completed" : "failed",
      });
      this.endBlock(blockId, decision === "approve" ? "completed" : "failed");
      return;
    }
    const pending = this.pendingPermissions.get(key);
    if (!pending) {
      return;
    }

    this.pendingPermissions.delete(key);
    const selected = decision === "approve" ? pending.allowOptionId : pending.rejectOptionId;
    if (selected) {
      this.writeResult(pending.requestId, {
        outcome: {
          outcome: "selected",
          optionId: selected,
        },
      });
    } else {
      this.writeResult(pending.requestId, {
        outcome: { outcome: "cancelled" },
      });
    }

    this.emit("event", {
      event: "block:action:status",
      sessionId: this.session.id,
      turnId,
      blockId,
      status: decision === "approve" ? "running" : "failed",
    });
  }

  answerQuestion(answer: QuestionAnswer): void {
    const pending = this.pendingCursorQuestions.get(answer.blockId);
    if (!pending) return;

    this.pendingCursorQuestions.delete(answer.blockId);
    const request = this.pendingCursorQuestionRequests.get(pending.requestId);
    if (!request) return;

    const selectedOptionIds = answer.answer
      .map((label) => pending.optionIdsByLabel.get(label))
      .filter((optionId): optionId is string => Boolean(optionId));
    request.answers.set(pending.questionId, selectedOptionIds);
    request.remainingBlockIds.delete(answer.blockId);
    this.emit("event", {
      event: "block:question:answer",
      sessionId: this.session.id,
      turnId: pending.turnId,
      blockId: answer.blockId,
      questionStatus: "answered",
      answer: answer.answer,
    });
    this.endBlock(answer.blockId, "completed");

    if (request.remainingBlockIds.size === 0) {
      this.pendingCursorQuestionRequests.delete(pending.requestId);
      this.writeResult(request.requestId, {
        outcome: {
          outcome: "answered",
          answers: [...request.answers].map(([questionId, selectedIds]) => ({
            questionId,
            selectedOptionIds: selectedIds,
          })),
        },
      });
    }
  }

  async shutdown(): Promise<void> {
    this.cancelPendingPermissions();
    this.cancelCursorInteractions("Cursor interaction cancelled because the session closed.");
    const processAlive = Boolean(this.process && !this.process.killed && this.process.exitCode === null);
    if (processAlive && this.currentSessionId && this.agentCapabilities?.sessionCapabilities?.close) {
      await this.request("session/close", { sessionId: this.currentSessionId }, 2_000).catch(() => undefined);
    }

    for (const [, pending] of this.pendingRequests) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(new Error("ACP adapter shut down."));
    }
    this.pendingRequests.clear();

    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.process = null;
    this.setStatus("closed");
  }

  private async startProcess(): Promise<void> {
    if (this.process && !this.process.killed && this.process.exitCode === null) {
      return;
    }

    const options = this.acpOptions;

    // Check the working directory before spawning, because the error you get
    // otherwise blames the wrong thing. `spawn` with a cwd that does not exist
    // fails with ENOENT naming the *command* — "posix_spawn '/…/bin/grok'" —
    // so a stale project path reads as a missing harness binary, and sends you
    // hunting PATH, code signing, and TCC for a directory typo.
    //
    // Routed through failSession rather than thrown raw: the ENOENT this
    // replaces surfaced on the child's "error" event, which emits `error` and
    // moves the session to status "error" so the registry broadcasts a failed
    // session. Throwing straight out of startProcess happens before any child
    // exists, so nothing would ever mark the session failed and the UI would
    // keep showing it as starting.
    if (!existsSync(options.cwd)) {
      const failure = new Error(
        `ACP agent working directory does not exist: ${options.cwd}`
        + ` (harness command: ${options.command})`,
      );
      this.failSession(failure);
      throw failure;
    }

    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: { ...scoutUserSpawnEnvironment(process.env), ...(this.config.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process = child;
    this.lineBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => this.handleStdoutChunk(chunk));
    child.stderr.on("data", (chunk: string) => {
      if (chunk.trim()) {
        this.updateProviderMeta({ lastStderr: redactSecrets(chunk.trim().slice(-4_000)) });
      }
    });
    child.once("error", (error) => {
      this.failSession(new Error(`ACP agent failed to start: ${errorMessage(error)}`));
    });
    child.once("exit", (code, signal) => {
      if (this.session.status === "closed") {
        return;
      }
      // The child's stderr tail is already redacted and capped — surface it in
      // the exit error so callers see why the agent died, not just that it did.
      const acpMeta = isRecord(this.session.providerMeta?.acp) ? this.session.providerMeta.acp : {};
      const lastStderr = typeof acpMeta.lastStderr === "string" ? acpMeta.lastStderr.trim() : "";
      this.failSession(
        new Error(
          `ACP agent exited`
          + (code !== null ? ` with code ${code}` : "")
          + (signal ? ` (${signal})` : "")
          + (lastStderr ? ` — stderr: ${lastStderr}` : ""),
        ),
      );
    });

    const initialized = await this.request<AcpInitializeResponse>("initialize", {
      protocolVersion: options.protocolVersion,
      clientCapabilities: {
        fs: {
          readTextFile: options.readTextFile,
          writeTextFile: options.writeTextFile,
        },
        terminal: false,
      },
      clientInfo: options.clientInfo,
    }, options.startupTimeoutMs);

    if (initialized.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new Error(`ACP protocol version ${String(initialized.protocolVersion)} is not supported.`);
    }

    this.agentCapabilities = initialized.agentCapabilities ?? {};
    this.updateProviderMeta({
      acpProtocolVersion: initialized.protocolVersion,
      agentInfo: initialized.agentInfo ?? null,
      agentCapabilities: this.agentCapabilities,
      command: [options.command, ...options.args].join(" "),
    });

    const selectedAuthMethodId = resolveAuthMethodId(options, initialized.authMethods);
    if (selectedAuthMethodId) {
      await this.request("authenticate", { methodId: selectedAuthMethodId }, options.startupTimeoutMs);
      this.updateProviderMeta({ authMethodId: selectedAuthMethodId });
    }

    await this.openSession();
    this.setStatus("idle");
  }

  private async openSession(): Promise<void> {
    const options = this.acpOptions;
    const baseParams = {
      cwd: options.cwd,
      mcpServers: options.mcpServers,
      ...(options.additionalDirectories.length
        ? { additionalDirectories: options.additionalDirectories }
        : {}),
    };

    const requestedSessionId = options.sessionId;
    if (requestedSessionId && options.sessionMode !== "new") {
      const canResume = Boolean(this.agentCapabilities?.sessionCapabilities?.resume);
      const canLoad = this.agentCapabilities?.loadSession === true;

      if (options.sessionMode === "resume") {
        if (!canResume) {
          throw new Error(`ACP agent does not advertise support for resuming session ${requestedSessionId}.`);
        }
        this.captureModelState(await this.request<AcpSessionResult>("session/resume", {
          ...baseParams,
          sessionId: requestedSessionId,
        }, options.startupTimeoutMs));
        this.setAcpSessionId(requestedSessionId);
        await this.selectRequestedModel(requestedSessionId);
        return;
      }

      if (options.sessionMode === "load") {
        if (!canLoad) {
          throw new Error(`ACP agent does not advertise support for loading session ${requestedSessionId}.`);
        }
        this.captureModelState(await this.request<AcpSessionResult>("session/load", {
          ...baseParams,
          sessionId: requestedSessionId,
        }, options.startupTimeoutMs));
        this.setAcpSessionId(requestedSessionId);
        await this.selectRequestedModel(requestedSessionId);
        return;
      }

      const recoveryFailures: Array<{ method: string; message: string }> = [];
      let recovered = false;
      if (canResume) {
        try {
          this.captureModelState(await this.request<AcpSessionResult>("session/resume", {
            ...baseParams,
            sessionId: requestedSessionId,
          }, options.startupTimeoutMs));
          this.setAcpSessionId(requestedSessionId);
          recovered = true;
        } catch (error) {
          recoveryFailures.push({ method: "session/resume", message: errorMessage(error) });
        }
      }
      if (!recovered && canLoad) {
        try {
          this.captureModelState(await this.request<AcpSessionResult>("session/load", {
            ...baseParams,
            sessionId: requestedSessionId,
          }, options.startupTimeoutMs));
          this.setAcpSessionId(requestedSessionId);
          recovered = true;
        } catch (error) {
          recoveryFailures.push({ method: "session/load", message: errorMessage(error) });
        }
      }
      if (recovered) {
        // Model selection is a distinct startup step. A set_model rejection
        // must fail loudly, not masquerade as resume/load failure and trigger
        // a fallback session with the same invalid model.
        await this.selectRequestedModel(requestedSessionId);
        return;
      }
      this.updateProviderMeta({
        sessionRecovery: {
          requestedSessionId,
          outcome: "new_session",
          failures: recoveryFailures,
        },
      });
    }

    const created = await this.request<AcpSessionResult>("session/new", baseParams, options.startupTimeoutMs);
    if (!created.sessionId) {
      throw new Error("ACP agent did not return a sessionId from session/new.");
    }
    this.captureModelState(created);
    this.setAcpSessionId(created.sessionId);
    await this.selectRequestedModel(created.sessionId);
  }

  private async selectRequestedModel(sessionId: string): Promise<void> {
    const { model, reasoningEffort } = this.acpOptions;
    // `model` is also used by adapters such as OpenCode to configure the
    // child process. Do not assume that means the ACP agent implements the
    // optional session/set_model method; Grok is the transport that exposes
    // model switching through ACP today.
    if (this.acpOptions.adapterType !== "grok-acp") return;
    if (!model && !reasoningEffort) return;
    // Effort rides on set_model rather than a call of its own, and the agent
    // resets it to the model default on every set_model that omits it. So a
    // model-only switch would silently drop a requested effort: send both, and
    // fall back to the current model id when only the effort changed.
    const modelId = model ?? this.currentAcpModelId;
    if (!modelId) return;
    await this.request("session/set_model", {
      sessionId,
      modelId,
      ...(reasoningEffort ? { _meta: { reasoningEffort } } : {}),
    }, this.acpOptions.startupTimeoutMs);
    this.updateProviderMeta({
      requestedModel: modelId,
      ...(reasoningEffort ? { requestedReasoningEffort: reasoningEffort } : {}),
    });
  }

  private async runPrompt(prompt: Prompt): Promise<void> {
    if (!this.currentSessionId) {
      this.emit("error", new Error("ACP session is not ready."));
      return;
    }

    this.liveRevision++;
    const turnId = crypto.randomUUID();
    const turn: Turn = {
      id: turnId,
      sessionId: this.session.id,
      status: "started",
      startedAt: new Date().toISOString(),
      blocks: [],
    };
    this.activeTurn = {
      turnId,
      blockIndex: 0,
      textBlockId: null,
      reasoningBlockId: null,
      blocks: new Map(),
      endedBlocks: new Set(),
      toolBlocksByCallId: new Map(),
      ended: false,
    };

    this.setStatus("active");
    this.emit("event", { event: "turn:start", sessionId: this.session.id, turn });

    try {
      const response = await this.request<{ stopReason?: string; usage?: unknown }>("session/prompt", {
        sessionId: this.currentSessionId,
        prompt: promptToContent(prompt, this.agentCapabilities?.promptCapabilities?.image === true),
      }, this.acpOptions.promptTimeoutMs);
      // Agents may report token usage on the prompt result rather than as a
      // usage_update notification — OpenCode does. Without this the turn looks
      // like it consumed nothing at all.
      if (isRecord(response.usage)) {
        this.updateProviderMeta({ usage: response.usage });
      }
      // Surface the raw ACP stopReason so callers can distinguish "end_turn"
      // from a truncation or refusal without parsing the mapped status.
      if (typeof response.stopReason === "string" && response.stopReason) {
        this.updateProviderMeta({ lastStopReason: response.stopReason });
      }
      this.attentionUnsafe = false;
      this.finishTurn(mapTurnStatus(response.stopReason));
    } catch (error) {
      this.attentionUnsafe = true;
      this.emit("event", {
        event: "turn:error",
        sessionId: this.session.id,
        turnId,
        message: errorMessage(error),
      });
      this.finishTurn("failed");
    } finally {
      if (this.activeTurn?.turnId === turnId) {
        this.activeTurn = null;
      }
      if (this.session.status !== "closed" && this.session.status !== "error") {
        this.setStatus("idle");
      }
    }
  }

  private handleStdoutChunk(chunk: string): void {
    this.lineBuffer += chunk;
    while (true) {
      const newlineIndex = this.lineBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const line = this.lineBuffer.slice(0, newlineIndex).trim();
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      const message = parseJsonLine(line);
      if (!message) {
        this.writeError(null, JSON_RPC_PARSE_ERROR, "Invalid JSON-RPC message.");
        continue;
      }

      if (isResponse(message)) {
        this.handleResponse(message);
        continue;
      }

      if (isRequest(message)) {
        void this.handleRequest(message);
        continue;
      }

      if (isNotification(message)) {
        this.handleNotification(message);
      }
    }
  }

  private handleResponse(message: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(message.id);
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }

    if (message.error) {
      const detail = message.error.message || "request failed";
      pending.reject(new Error(`${pending.method} failed (${message.error.code}): ${detail}`));
      return;
    }

    pending.resolve(message.result);
  }

  private async handleRequest(message: JsonRpcRequest): Promise<void> {
    try {
      switch (message.method) {
        case "session/request_permission":
          await this.handlePermissionRequest(message);
          return;
        case "fs/read_text_file":
          await this.handleReadTextFile(message);
          return;
        case "fs/write_text_file":
          await this.handleWriteTextFile(message);
          return;
        case "cursor/ask_question":
          await this.handleCursorAskQuestion(message);
          return;
        case "cursor/create_plan":
          await this.handleCursorCreatePlan(message);
          return;
        default:
          this.writeError(message.id, JSON_RPC_METHOD_NOT_FOUND, `Unsupported ACP client method: ${message.method}`);
      }
    } catch (error) {
      this.writeError(message.id, JSON_RPC_INTERNAL_ERROR, errorMessage(error));
    }
  }

  private handleNotification(message: JsonRpcNotification): void {
    if (this.acpOptions.cursorExtensions && message.method.startsWith("cursor/")) {
      this.updateProviderMeta({
        lastCursorNotification: {
          method: message.method,
          params: message.params,
        },
      });
      return;
    }
    if (message.method !== "session/update") {
      return;
    }

    const params = isRecord(message.params) ? message.params : {};
    const update = isRecord(params.update) ? params.update as AcpSessionUpdate : null;
    if (!update) {
      return;
    }

    this.handleSessionUpdate(update);
  }

  private handleSessionUpdate(update: AcpSessionUpdate): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.appendContentText("text", update.content);
        return;
      case "agent_thought_chunk":
        this.appendContentText("reasoning", update.content);
        return;
      case "tool_call":
        this.upsertToolBlock(toolUpdateFromSessionUpdate(update));
        return;
      case "tool_call_update":
        this.upsertToolBlock(toolUpdateFromSessionUpdate(update));
        return;
      case "plan":
        this.emitPlan(update);
        return;
      case "session_info_update":
        this.updateProviderMeta({ acpSessionInfo: update });
        if (typeof update.status === "string") {
          this.setStatus(mapSessionStatus(update.status));
        }
        return;
      case "usage_update":
        this.updateProviderMeta({ usage: update });
        return;
      default:
        return;
    }
  }

  private appendContentText(kind: "text" | "reasoning", content: AcpContentBlock | undefined): void {
    const active = this.activeTurn;
    if (!active) {
      return;
    }

    const text = textFromContent(content);
    if (!text) {
      return;
    }

    const existingBlockId = kind === "text" ? active.textBlockId : active.reasoningBlockId;
    const blockId = existingBlockId ?? this.startTextBlock(kind);
    if (!blockId) {
      return;
    }

    this.emit("event", {
      event: "block:delta",
      sessionId: this.session.id,
      turnId: active.turnId,
      blockId,
      text,
    });
  }

  private startTextBlock(kind: "text" | "reasoning"): string | null {
    const active = this.activeTurn;
    if (!active) {
      return null;
    }

    const block: Block = {
      id: crypto.randomUUID(),
      turnId: active.turnId,
      type: kind,
      text: "",
      status: "streaming",
      index: active.blockIndex++,
    };
    active.blocks.set(block.id, block);
    if (kind === "text") {
      active.textBlockId = block.id;
    } else {
      active.reasoningBlockId = block.id;
    }
    this.emit("event", {
      event: "block:start",
      sessionId: this.session.id,
      turnId: active.turnId,
      block,
    });
    return block.id;
  }

  private upsertToolBlock(input: AcpToolCallUpdate): string | null {
    const active = this.activeTurn;
    if (!active) {
      return null;
    }

    const toolCallId = input.toolCallId ?? crypto.randomUUID();
    const existingBlockId = active.toolBlocksByCallId.get(toolCallId);
    if (!existingBlockId) {
      // A new tool separates the content before it from the next message or
      // thought. Updates to an existing tool may arrive while later content
      // is streaming, so only close content when creating the action block.
      if (active.textBlockId) {
        this.endBlock(active.textBlockId, "completed");
      }
      if (active.reasoningBlockId) {
        this.endBlock(active.reasoningBlockId, "completed");
      }
      const block: Block = {
        id: crypto.randomUUID(),
        turnId: active.turnId,
        type: "action",
        status: "streaming",
        index: active.blockIndex++,
        action: buildToolAction({ ...input, toolCallId }),
      };
      active.blocks.set(block.id, block);
      active.toolBlocksByCallId.set(toolCallId, block.id);
      this.emit("event", {
        event: "block:start",
        sessionId: this.session.id,
        turnId: active.turnId,
        block,
      });
      const output = outputFromToolContent(input.content);
      if (output) {
        this.emit("event", {
          event: "block:action:output",
          sessionId: this.session.id,
          turnId: active.turnId,
          blockId: block.id,
          output,
        });
      }
      return block.id;
    }

    const actionStatus = mapToolStatus(input.status);
    this.emit("event", {
      event: "block:action:status",
      sessionId: this.session.id,
      turnId: active.turnId,
      blockId: existingBlockId,
      status: actionStatus,
      meta: {
        ...(input.rawOutput !== undefined ? { rawOutput: input.rawOutput } : {}),
        ...(input.rawInput !== undefined ? { rawInput: input.rawInput } : {}),
      },
    });

    const output = outputFromToolContent(input.content);
    if (output) {
      this.emit("event", {
        event: "block:action:output",
        sessionId: this.session.id,
        turnId: active.turnId,
        blockId: existingBlockId,
        output,
      });
    }

    if (input.status === "completed" || input.status === "failed") {
      this.endBlock(existingBlockId, input.status === "failed" ? "failed" : "completed");
    }

    return existingBlockId;
  }

  private emitPlan(update: AcpSessionUpdate): void {
    const active = this.activeTurn;
    if (!active || !Array.isArray(update.entries) || !update.entries.length) {
      return;
    }

    // A plan is a standalone reasoning block. End prior content before it
    // starts, including reasoning whose active pointer the plan will replace.
    if (active.textBlockId) {
      this.endBlock(active.textBlockId, "completed");
    }
    if (active.reasoningBlockId) {
      this.endBlock(active.reasoningBlockId, "completed");
    }

    const text = update.entries
      .map((entry) => {
        const status = entry.status ? ` [${entry.status}]` : "";
        const priority = entry.priority ? ` (${entry.priority})` : "";
        return `- ${entry.content ?? "Plan item"}${priority}${status}`;
      })
      .join("\n");
    const blockId = this.startTextBlock("reasoning");
    if (!blockId) {
      return;
    }
    this.emit("event", {
      event: "block:delta",
      sessionId: this.session.id,
      turnId: active.turnId,
      blockId,
      text: `Plan:\n${text}`,
    });
    this.endBlock(blockId, "completed");
  }

  private async handlePermissionRequest(message: JsonRpcRequest): Promise<void> {
    if (this.acpOptions.permissionMode === "safe_reject") {
      const params = isRecord(message.params) ? message.params : {};
      const options = Array.isArray(params.options) ? params.options.filter(isRecord) : [];
      const rejectOptionId = this.permissionOption(options, "reject");
      this.writeResult(message.id, rejectOptionId
        ? { outcome: { outcome: "selected", optionId: rejectOptionId } }
        : { outcome: { outcome: "cancelled" } });
      return;
    }
    const active = this.activeTurn;
    if (!active) {
      this.writeResult(message.id, { outcome: { outcome: "cancelled" } });
      return;
    }

    const params = isRecord(message.params) ? message.params : {};
    const toolCall = isRecord(params.toolCall) ? params.toolCall as AcpToolCallUpdate : {};
    const options = Array.isArray(params.options) ? params.options.filter(isRecord) : [];
    const toolCallId = toolCall.toolCallId ?? crypto.randomUUID();
    const blockId = this.upsertToolBlock({ ...toolCall, toolCallId, status: "pending" });
    if (!blockId) {
      this.writeResult(message.id, { outcome: { outcome: "cancelled" } });
      return;
    }

    const allowOptionId = this.permissionOption(options, "allow");
    const rejectOptionId = this.permissionOption(options, "reject");
    if (this.acpOptions.permissionMode === "auto_approve") {
      this.writeResult(message.id, allowOptionId
        ? { outcome: { outcome: "selected", optionId: allowOptionId } }
        : { outcome: { outcome: "cancelled" } });
      if (!allowOptionId) {
        this.emit("event", {
          event: "block:action:status",
          sessionId: this.session.id,
          turnId: active.turnId,
          blockId,
          status: "failed",
        });
        this.endBlock(blockId, "failed");
      }
      return;
    }
    this.pendingPermissions.set(this.permissionKey(active.turnId, blockId), {
      requestId: message.id,
      turnId: active.turnId,
      blockId,
      allowOptionId,
      rejectOptionId,
    });

    this.emit("event", {
      event: "block:action:approval",
      sessionId: this.session.id,
      turnId: active.turnId,
      blockId,
      approval: {
        version: 1,
        description: toolName(toolCall),
        risk: "medium",
      },
    });
  }

  private async handleCursorAskQuestion(message: JsonRpcRequest): Promise<void> {
    if (!this.acpOptions.cursorExtensions) {
      this.writeError(message.id, JSON_RPC_METHOD_NOT_FOUND, "Cursor ACP extensions are disabled.");
      return;
    }
    if (this.acpOptions.cursorInteractionMode === "safe_reject") {
      this.writeResult(message.id, {
        outcome: { outcome: "skipped", reason: "OpenScout headless invocation has no interactive question surface." },
      });
      return;
    }

    const active = this.activeTurn;
    const params = isRecord(message.params) ? message.params : {};
    const questions = Array.isArray(params.questions) ? params.questions.filter(isRecord) : [];
    if (!active || questions.length === 0) {
      this.writeResult(message.id, {
        outcome: { outcome: "skipped", reason: "Cursor supplied no answerable questions." },
      });
      return;
    }

    const request: PendingCursorQuestionRequest = {
      requestId: message.id,
      answers: new Map(),
      remainingBlockIds: new Set(),
    };
    this.pendingCursorQuestionRequests.set(message.id, request);

    for (const [index, question] of questions.entries()) {
      const questionId = stringValue(question.id) ?? `question-${index + 1}`;
      const prompt = stringValue(question.prompt) ?? "Cursor needs more information.";
      const rawOptions = Array.isArray(question.options) ? question.options.filter(isRecord) : [];
      const labels = rawOptions.map((option, optionIndex) =>
        stringValue(option.label) ?? stringValue(option.id) ?? `Option ${optionIndex + 1}`
      );
      const duplicateLabels = new Set(labels.filter((label, index) => labels.indexOf(label) !== index));
      const options = rawOptions.map((option, optionIndex) => ({
        id: stringValue(option.id) ?? `option-${optionIndex + 1}`,
        label: duplicateLabels.has(labels[optionIndex]!)
          ? `${labels[optionIndex]} (${stringValue(option.id) ?? optionIndex + 1})`
          : labels[optionIndex]!,
      }));
      const block: QuestionBlock = {
        id: crypto.randomUUID(),
        turnId: active.turnId,
        type: "question",
        status: "streaming",
        index: active.blockIndex++,
        header: stringValue(params.title) ?? undefined,
        question: prompt,
        options: options.map(({ label }) => ({ label })),
        multiSelect: question.allowMultiple === true,
        questionStatus: "awaiting_answer",
      };
      active.blocks.set(block.id, block);
      request.remainingBlockIds.add(block.id);
      this.pendingCursorQuestions.set(block.id, {
        requestId: message.id,
        turnId: active.turnId,
        questionId,
        optionIdsByLabel: new Map(options.map(({ id, label }) => [label, id])),
      });
      this.emit("event", {
        event: "block:start",
        sessionId: this.session.id,
        turnId: active.turnId,
        block,
      });
    }
  }

  private async handleCursorCreatePlan(message: JsonRpcRequest): Promise<void> {
    if (!this.acpOptions.cursorExtensions) {
      this.writeError(message.id, JSON_RPC_METHOD_NOT_FOUND, "Cursor ACP extensions are disabled.");
      return;
    }
    if (this.acpOptions.cursorInteractionMode === "safe_reject") {
      this.writeResult(message.id, {
        outcome: { outcome: "rejected", reason: "OpenScout headless invocation cannot approve a Cursor plan." },
      });
      return;
    }

    const active = this.activeTurn;
    const params = isRecord(message.params) ? message.params : {};
    if (!active) {
      this.writeResult(message.id, { outcome: { outcome: "cancelled" } });
      return;
    }

    const title = stringValue(params.name) ?? "Cursor plan";
    const plan = stringValue(params.plan) ?? stringValue(params.overview) ?? title;
    const blockId = this.upsertToolBlock({
      toolCallId: stringValue(params.toolCallId) ?? crypto.randomUUID(),
      title,
      kind: "plan",
      status: "pending",
      rawInput: params,
      content: [{ type: "content", content: { type: "text", text: plan } }],
    });
    if (!blockId) {
      this.writeResult(message.id, { outcome: { outcome: "cancelled" } });
      return;
    }
    this.pendingCursorPlans.set(this.permissionKey(active.turnId, blockId), {
      requestId: message.id,
      turnId: active.turnId,
      blockId,
    });
    this.emit("event", {
      event: "block:action:approval",
      sessionId: this.session.id,
      turnId: active.turnId,
      blockId,
      approval: {
        version: 1,
        description: `${title}\n\n${plan}`,
        risk: "medium",
      },
    });
  }

  private async handleReadTextFile(message: JsonRpcRequest): Promise<void> {
    if (!this.acpOptions.readTextFile) {
      this.writeError(message.id, JSON_RPC_METHOD_NOT_FOUND, "fs/read_text_file is disabled.");
      return;
    }

    const params = isRecord(message.params) ? message.params : {};
    const requestedPath = stringValue(params.path);
    if (!requestedPath) {
      this.writeError(message.id, JSON_RPC_INVALID_PARAMS, "fs/read_text_file requires params.path.");
      return;
    }

    const filePath = this.resolveAllowedPath(requestedPath);
    const raw = await readFile(filePath, "utf8");
    const line = typeof params.line === "number" && params.line > 0 ? Math.floor(params.line) : null;
    const limit = typeof params.limit === "number" && params.limit >= 0 ? Math.floor(params.limit) : null;
    const content = line !== null || limit !== null
      ? raw.split(/\r?\n/).slice(Math.max((line ?? 1) - 1, 0), limit === null ? undefined : Math.max((line ?? 1) - 1, 0) + limit).join("\n")
      : raw;
    this.writeResult(message.id, { content });
  }

  private async handleWriteTextFile(message: JsonRpcRequest): Promise<void> {
    if (!this.acpOptions.writeTextFile) {
      this.writeError(message.id, JSON_RPC_METHOD_NOT_FOUND, "fs/write_text_file is disabled.");
      return;
    }

    const params = isRecord(message.params) ? message.params : {};
    const requestedPath = stringValue(params.path);
    if (!requestedPath || typeof params.content !== "string") {
      this.writeError(message.id, JSON_RPC_INVALID_PARAMS, "fs/write_text_file requires params.path and params.content.");
      return;
    }

    const filePath = this.resolveAllowedPath(requestedPath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, params.content, "utf8");
    this.writeResult(message.id, {});
  }

  private request<T>(method: string, params?: unknown, timeoutMs: number | null = this.acpOptions.requestTimeoutMs): Promise<T> {
    const id = ++this.requestId;
    return new Promise<T>((resolve, reject) => {
      const timeout = timeoutMs
        ? setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error(`ACP request timed out: ${method}`));
        }, timeoutMs)
        : null;

      this.pendingRequests.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });

      this.writeMessage({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      });
    });
  }

  private notify(method: string, params?: unknown): void {
    this.writeMessage({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  private writeResult(id: JsonRpcId, result: unknown): void {
    this.writeMessage({
      jsonrpc: "2.0",
      id,
      result,
    });
  }

  private writeError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
    this.writeMessage({
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
        ...(data === undefined ? {} : { data }),
      },
    });
  }

  private writeMessage(message: Record<string, unknown>): void {
    const line = JSON.stringify(message);
    if (!this.process?.stdin.writable) {
      return;
    }
    this.process.stdin.write(`${line}\n`);
  }

  /**
   * Remember the model the agent says the session is on. Effort changes ride
   * on `session/set_model`, so switching effort alone still needs a model id.
   */
  private captureModelState(result: AcpSessionResult | undefined): void {
    const current = result?.models?.currentModelId;
    if (typeof current === "string" && current.trim()) {
      this.currentAcpModelId = current.trim();
    }
  }

  private setAcpSessionId(sessionId: string): void {
    this.currentSessionId = sessionId;
    this.updateProviderMeta({ acpSessionId: sessionId });
  }

  private updateProviderMeta(meta: Record<string, unknown>): void {
    this.session.providerMeta = {
      ...this.session.providerMeta,
      acp: {
        ...(isRecord(this.session.providerMeta?.acp) ? this.session.providerMeta.acp : {}),
        ...meta,
      },
    };
    this.emit("event", { event: "session:update", session: { ...this.session } });
  }

  private finishTurn(status: TurnStatus): void {
    const active = this.activeTurn;
    if (!active || active.ended) {
      return;
    }

    this.cancelPendingPermissions();
    this.cancelCursorInteractions(`Cursor interaction cancelled because the turn ended with status ${status}.`);

    for (const blockId of active.blocks.keys()) {
      if (!active.endedBlocks.has(blockId)) {
        this.endBlock(blockId, status === "failed" ? "failed" : "completed");
      }
    }

    active.ended = true;
    this.emit("event", {
      event: "turn:end",
      sessionId: this.session.id,
      turnId: active.turnId,
      status,
    });
  }

  private endBlock(blockId: string, status: BlockStatus): void {
    const active = this.activeTurn;
    if (!active || active.endedBlocks.has(blockId)) {
      return;
    }

    active.endedBlocks.add(blockId);
    if (active.textBlockId === blockId) {
      active.textBlockId = null;
    }
    if (active.reasoningBlockId === blockId) {
      active.reasoningBlockId = null;
    }
    this.emit("event", {
      event: "block:end",
      sessionId: this.session.id,
      turnId: active.turnId,
      blockId,
      status,
    });
  }

  private cancelPendingPermissions(): void {
    for (const [, pending] of this.pendingPermissions) {
      this.writeResult(pending.requestId, {
        outcome: { outcome: "cancelled" },
      });
      this.emit("event", {
        event: "block:action:status",
        sessionId: this.session.id,
        turnId: pending.turnId,
        blockId: pending.blockId,
        status: "failed",
      });
    }
    this.pendingPermissions.clear();
  }

  private cancelCursorInteractions(reason: string): void {
    for (const [, request] of this.pendingCursorQuestionRequests) {
      this.writeResult(request.requestId, { outcome: { outcome: "skipped", reason } });
    }
    for (const [blockId, pending] of this.pendingCursorQuestions) {
      this.emit("event", {
        event: "block:question:answer",
        sessionId: this.session.id,
        turnId: pending.turnId,
        blockId,
        questionStatus: "denied",
        answer: [],
      });
    }
    for (const [, pending] of this.pendingCursorPlans) {
      this.writeResult(pending.requestId, { outcome: { outcome: "cancelled" } });
      this.emit("event", {
        event: "block:action:status",
        sessionId: this.session.id,
        turnId: pending.turnId,
        blockId: pending.blockId,
        status: "failed",
      });
    }
    this.pendingCursorQuestions.clear();
    this.pendingCursorQuestionRequests.clear();
    this.pendingCursorPlans.clear();
  }

  private permissionOption(options: Record<string, unknown>[], kind: "allow" | "reject"): string | null {
    const kindOf = (option: Record<string, unknown>) => stringValue(option.kind);
    const matches = options.filter((option) => kindOf(option)?.startsWith(kind));
    // Allow once is the decision the operator is offered. Do not pick
    // allow_always just because the agent listed it first.
    const once = matches.find((option) => {
      const value = kindOf(option);
      return value === `${kind}_once` || value === kind;
    });
    const match = once ?? matches[0] ?? options.find((option) => {
      const name = stringValue(option.name)?.toLowerCase();
      return name?.includes(kind === "allow" ? "allow" : "reject") ?? false;
    });

    return stringValue(match?.optionId);
  }

  private permissionKey(turnId: string, blockId: string): string {
    return `${turnId}:${blockId}`;
  }

  private resolveAllowedPath(inputPath: string): string {
    if (!isAbsolute(inputPath)) {
      throw new Error(`ACP file path must be absolute: ${inputPath}`);
    }

    const filePath = resolve(inputPath);
    const roots = [this.acpOptions.cwd, ...this.acpOptions.additionalDirectories].map((root) => resolve(root));
    if (!roots.some((root) => isPathInside(root, filePath))) {
      throw new Error(`ACP file path is outside the configured workspace roots: ${inputPath}`);
    }
    return filePath;
  }

  private failSession(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    this.cancelPendingPermissions();
    this.cancelCursorInteractions(error.message);
    this.emit("error", error);
    this.setStatus("error");
  }
}

export const createAdapter = (config: AdapterConfig) => new AcpAdapter(config);
