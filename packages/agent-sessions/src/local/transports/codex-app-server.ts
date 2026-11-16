import { appendBoundedLog } from "../bounded-log.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { registerSharedScoutMcpClient, resolveScoutMcpCodexLaunch } from "../../codex-launch-config.js";
import { resolveCodexExecutable } from "../../codex-executable.js";
import { redactSecrets } from "../../secret-redaction.js";
import { writeCodexMetadata } from "./codex-metadata-file.js";
import { CodexWireLog } from "./codex-wire-log.js";
import {
  connectCodexAppServerSocket,
  defaultCodexAppServerControlSocketPath,
  readCodexAppServerDaemonVersion,
  resolveCodexAppServerConnectionConfig,
  spawnCodexAppServerStdioConnection,
  type CodexAppServerConnection,
  type CodexAppServerConnectionClose,
  type CodexAppServerConnectionConfig,
  type CodexAppServerConnectionHandlers,
  type CodexAppServerConnectionMode,
  type CodexAppServerDaemonVersion,
} from "./codex-app-server-connection.js";

export {
  defaultCodexAppServerControlSocketPath,
  type CodexAppServerConnectionConfig,
  type CodexAppServerConnectionMode,
} from "./codex-app-server-connection.js";
import { scoutUserSpawnEnvironment } from "../../scout-state-paths.js";

export type CodexAppServerApprovalPolicy = "untrusted" | "on-request" | "on-failure" | "never";
export type CodexAppServerSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type CodexAppServerRequest = {
  id: string | number;
  method: string;
  params?: unknown;
};

export type CodexAppServerResponse = {
  id: string | number;
  result?: unknown;
  error?: {
    message?: string;
    code?: string | number;
    data?: unknown;
  };
};

export type CodexAppServerNotification = {
  method: string;
  params?: Record<string, unknown>;
};

export type CodexAppServerServerRequest = {
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
};

type CodexErrorResponse = {
  code: number;
  message: string;
  data?: unknown;
};

type ThreadStartResult = {
  thread: {
    id: string;
    path?: string | null;
    cwd?: string | null;
    name?: string | null;
  };
};

type ThreadResumeResult = ThreadStartResult;

type TurnStartResult = {
  turn: {
    id: string;
  };
};

type TurnCompletedParams = {
  threadId: string;
  turn: {
    id: string;
    status: "completed" | "interrupted" | "failed" | "inProgress";
    error?: {
      message?: string;
      additionalDetails?: string | null;
    } | null;
  };
};

export type CodexAppServerClientInfo = {
  name: string;
  title: string;
  version: string;
};

export type CodexAppServerSessionOptions = {
  agentName: string;
  sessionId: string;
  cwd: string;
  systemPrompt: string;
  runtimeDirectory: string;
  logsDirectory: string;
  env?: Record<string, string | undefined>;
  /** Final child-process environment. When omitted, process.env plus env overrides is used. */
  processEnv?: Record<string, string | undefined>;
  launchArgs?: string[];
  approvalPolicy?: CodexAppServerApprovalPolicy;
  sandbox?: CodexAppServerSandboxMode;
  threadId?: string;
  requireExistingThread?: boolean;
  clientInfo?: CodexAppServerClientInfo;
  /** Called with each agent-message delta as the active turn streams. */
  onDelta?: (delta: string) => void;
  /** Owner callback for native requests; never resumes or forks a thread. */
  onPermissionRequest?: (request: { id: string | number; method: string; params?: Record<string, unknown> }, controls: {
    isCurrent: () => boolean; respond: (result: Record<string, unknown>) => void;
  }) => Promise<boolean>;
  /** Optional owner lifetime; checked before launching or starting a turn. */
  signal?: AbortSignal;
  /** Bounds startup/handshake only; never limits a running inference turn. */
  startupTimeoutMs?: number;
  /** Bounds each control response (including submission acknowledgement). */
  controlRequestTimeoutMs?: number;
  /**
   * Which app-server to talk to. Default `{ mode: "spawn" }`: Scout launches
   * and owns a private `codex app-server`. `{ mode: "attach" }` connects to an
   * app-server that is already running (the Codex daemon control socket);
   * Scout never stops or restarts that server.
   */
  connection?: CodexAppServerConnectionConfig;
  /** Optional title set with `thread/name/set` when Scout starts a new thread. */
  threadName?: string;
  /**
   * Stop a spawned app-server after this long with nothing to do; every
   * interaction restarts the window. The thread is kept, and the next message
   * resumes it. Default 60 minutes, or OPENSCOUT_CODEX_IDLE_PARK_MS; 0 keeps it.
   */
  idleParkMs?: number;
};

export const DEFAULT_CODEX_IDLE_PARK_MS = 60 * 60 * 1000;

export function resolveCodexIdleParkMs(value: number | undefined, env: Record<string, string | undefined> = process.env): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  const fromEnv = Number(env.OPENSCOUT_CODEX_IDLE_PARK_MS);
  if (env.OPENSCOUT_CODEX_IDLE_PARK_MS?.trim() && Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  return DEFAULT_CODEX_IDLE_PARK_MS;
}

/**
 * Which Codex this session is talking to. Captured from `initialize` and, for
 * attached servers, `codex app-server daemon version`.
 */
export type CodexAppServerIdentity = {
  connection: CodexAppServerConnectionMode;
  socketPath: string | null;
  pid: number | null;
  userAgent: string | null;
  appServerVersion: string | null;
  codexHome: string | null;
  platformOs: string | null;
  /** Scout-side features that do not apply to this server. */
  capabilityGaps: string[];
  connectedAt: number;
};

/**
 * Attached servers were launched by someone else: Scout cannot add its MCP
 * server, launch args, or process environment (including CODEX_HOME).
 */
export const CODEX_ATTACHED_CAPABILITY_GAPS = [
  "scout_mcp_injection",
  "launch_args",
  "process_env",
] as const;

type InitializeResult = {
  userAgent?: string;
  codexHome?: string;
  platformOs?: string;
};

function codexVersionFromUserAgent(userAgent: string | null): string | null {
  const match = userAgent?.match(/\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/);
  return match?.[1] ?? null;
}

export function buildCodexAppServerIdentity(input: {
  connection: Pick<CodexAppServerConnection, "mode" | "pid" | "socketPath">;
  initialized: InitializeResult | null | undefined;
  daemon?: CodexAppServerDaemonVersion | null;
  now?: number;
}): CodexAppServerIdentity {
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
  const userAgent = text(input.initialized?.userAgent);
  // Only trust the daemon's version when it describes the socket we attached to.
  const daemonMatches = Boolean(
    input.daemon
      && input.connection.socketPath
      && input.daemon.socketPath === input.connection.socketPath,
  );
  return {
    connection: input.connection.mode,
    socketPath: input.connection.socketPath,
    pid: input.connection.pid,
    userAgent,
    appServerVersion: (daemonMatches ? input.daemon?.appServerVersion : null) ?? codexVersionFromUserAgent(userAgent),
    codexHome: text(input.initialized?.codexHome),
    platformOs: text(input.initialized?.platformOs),
    capabilityGaps: input.connection.mode === "attached" ? [...CODEX_ATTACHED_CAPABILITY_GAPS] : [],
    connectedAt: input.now ?? Date.now(),
  };
}

export type CodexAppServerInvocationOptions = CodexAppServerSessionOptions & {
  prompt: string;
  timeoutMs?: number;
};

export type CodexAppServerSteerOptions = CodexAppServerSessionOptions & {
  prompt: string;
};

export type CodexAppServerInterruptOptions = CodexAppServerSessionOptions;

export type CodexAppServerShutdownOptions = {
  resetThread?: boolean;
  reason?: string;
};

export type CodexAppServerTurnResult = {
  output: string;
  threadId: string;
  /** Which Codex answered: attached vs Scout-spawned, socket, version, home. */
  codexAppServer?: CodexAppServerIdentity | null;
};

export type CodexAppServerTurnStartResult = {
  threadId: string;
  turnId: string;
};

export type CodexAppServerThreadResult = {
  threadId: string;
  durableThreadId: string | null;
  codexAppServer?: CodexAppServerIdentity | null;
};

export type CodexAppServerExitKind =
  | "proactive_shutdown"
  | "external_sigterm"
  | "unexpected_exit";

export class CodexAppServerExitError extends Error {
  readonly code = "CODEX_APP_SERVER_EXIT";

  readonly exitKind: CodexAppServerExitKind;

  readonly agentName: string;

  readonly exitCode: number | null;

  readonly signal: string | null;

  readonly reason: string | null;

  readonly noteworthy: boolean;

  constructor(input: {
    agentName: string;
    exitKind?: CodexAppServerExitKind;
    exitCode: number | null;
    signal: string | null;
    reason?: string | null;
  }) {
    const exitKind: CodexAppServerExitKind = input.exitKind ?? (input.signal === "SIGTERM" || input.exitCode === 143
      ? "external_sigterm"
      : "unexpected_exit");
    super(codexAppServerExitMessage({
      ...input,
      exitKind,
    }));
    this.name = "CodexAppServerExitError";
    this.exitKind = exitKind;
    this.agentName = input.agentName;
    this.exitCode = input.exitCode;
    this.signal = input.signal;
    this.reason = input.reason ?? null;
    this.noteworthy = exitKind !== "unexpected_exit";
  }
}

export function isCodexAppServerExitError(error: unknown): error is CodexAppServerExitError {
  return error instanceof CodexAppServerExitError
    || Boolean(
      error
        && typeof error === "object"
        && (error as { code?: unknown }).code === "CODEX_APP_SERVER_EXIT",
    );
}

export class CodexAppServerRequesterTimeoutError extends Error {
  readonly code = "REQUESTER_WAIT_TIMEOUT";
  readonly timeoutMs: number;
  readonly label: string;

  constructor(input: { label: string; timeoutMs: number }) {
    super(`Timed out after ${input.timeoutMs}ms waiting for ${input.label}.`);
    this.name = "RequesterWaitTimeoutError";
    this.label = input.label;
    this.timeoutMs = input.timeoutMs;
  }
}

export class CodexAppServerControlError extends Error {
  readonly code: "CODEX_APP_SERVER_CONTROL_TIMEOUT" | "CODEX_APP_SERVER_CONTROL_ABORTED";
  readonly method: string;
  readonly timeoutMs?: number;
  readonly submissionUnknown: boolean;

  constructor(input: { method: string; timeoutMs?: number; submissionUnknown?: boolean; aborted?: boolean }) {
    super(input.aborted
      ? `Aborted while waiting for Codex app-server ${input.method}.`
      : `Timed out after ${input.timeoutMs}ms waiting for Codex app-server ${input.method}.`);
    this.name = "CodexAppServerControlError";
    this.code = input.aborted ? "CODEX_APP_SERVER_CONTROL_ABORTED" : "CODEX_APP_SERVER_CONTROL_TIMEOUT";
    this.method = input.method;
    this.timeoutMs = input.timeoutMs;
    this.submissionUnknown = input.submissionUnknown === true;
  }
}

export function isCodexAppServerControlError(error: unknown): error is CodexAppServerControlError {
  return error instanceof CodexAppServerControlError || Boolean(error && typeof error === "object"
    && ((error as { code?: unknown }).code === "CODEX_APP_SERVER_CONTROL_TIMEOUT"
      || (error as { code?: unknown }).code === "CODEX_APP_SERVER_CONTROL_ABORTED"));
}

function controlDeadlineMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 30_000;
}

function waitForStartup<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    // Always observe the operation, including a late rejection after abort.
    void operation.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    if (signal.aborted) onAbort();
  });
}

export class CodexThreadHeldExternallyError extends Error {
  readonly code = "CODEX_THREAD_HELD_EXTERNALLY";
  readonly threadId: string;
  readonly agentName: string;

  constructor(input: { agentName: string; threadId: string; detail?: string | null }) {
    super(
      `Codex thread ${input.threadId} is open in another application`
        + (input.detail ? ` (${input.detail})` : "")
        + "; it will accept turns once that application releases it.",
    );
    this.name = "CodexThreadHeldExternallyError";
    this.threadId = input.threadId;
    this.agentName = input.agentName;
  }
}

export function isCodexThreadHeldExternallyError(error: unknown): error is CodexThreadHeldExternallyError {
  return error instanceof CodexThreadHeldExternallyError
    || Boolean(
      error
        && typeof error === "object"
        && (error as { code?: unknown }).code === "CODEX_THREAD_HELD_EXTERNALLY",
    );
}

function codexAppServerExitMessage(input: {
  agentName: string;
  exitKind: CodexAppServerExitKind;
  exitCode: number | null;
  signal: string | null;
  reason?: string | null;
}): string {
  if (input.exitKind === "proactive_shutdown") {
    return `Codex app-server session for ${input.agentName} was stopped by OpenScout`
      + (input.reason ? `: ${input.reason}` : "")
      + ".";
  }

  if (input.exitKind === "external_sigterm") {
    return `Codex app-server for ${input.agentName} was interrupted by SIGTERM.`;
  }

  return `Codex app-server exited for ${input.agentName}`
    + (input.exitCode !== null ? ` with code ${input.exitCode}` : "")
    + (input.signal ? ` (${input.signal})` : "");
}

function normalizeCodexModelValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  if (lower === "6" || lower === "gpt-6" || lower === "astra") {
    return "gpt-6-astra";
  }
  if (lower === "5.6" || lower === "gpt-5.6") {
    return "gpt-5.6-sol";
  }

  // Scout route labels document shorthand such as `@agent#codex?5.5`.
  // Codex app-server expects the full model id, e.g. `gpt-5.5`.
  if (/^\d+(?:\.\d+)*(?:-[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(trimmed)) {
    return `gpt-${trimmed}`;
  }

  return trimmed;
}

function normalizeCodexReasoningEffortValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function encodeCodexModelConfig(model: string): string {
  return `model=${JSON.stringify(model)}`;
}

function encodeCodexReasoningEffortConfig(reasoningEffort: string): string {
  return `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`;
}

function parseCodexConfigValue(value: string | null | undefined, expectedKey: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex <= 0) {
    return null;
  }

  const key = trimmed.slice(0, separatorIndex).trim();
  if (key !== expectedKey) {
    return null;
  }

  const rawValue = trimmed.slice(separatorIndex + 1).trim();
  if (!rawValue) {
    return null;
  }

  if (
    (rawValue.startsWith("\"") && rawValue.endsWith("\""))
    || (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1) || null;
  }

  return rawValue;
}

function parseCodexModelConfig(value: string | null | undefined): string | null {
  return normalizeCodexModelValue(parseCodexConfigValue(value, "model"));
}

function parseCodexReasoningEffortConfig(value: string | null | undefined): string | null {
  return parseCodexConfigValue(value, "model_reasoning_effort");
}

export function normalizeCodexAppServerLaunchArgs(launchArgs?: string[]): string[] {
  const args = Array.isArray(launchArgs)
    ? launchArgs.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
  const normalized: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index] ?? "";
    if (current === "--model" || current === "-m") {
      const model = normalizeCodexModelValue(args[index + 1]);
      if (model) {
        normalized.push("-c", encodeCodexModelConfig(model));
        index += 1;
        continue;
      }
      normalized.push(current);
      continue;
    }

    if (current.startsWith("--model=")) {
      const model = normalizeCodexModelValue(current.slice("--model=".length));
      if (model) {
        normalized.push("-c", encodeCodexModelConfig(model));
        continue;
      }
    }

    if (current.startsWith("-m=")) {
      const model = normalizeCodexModelValue(current.slice(3));
      if (model) {
        normalized.push("-c", encodeCodexModelConfig(model));
        continue;
      }
    }

    if (current === "--reasoning-effort" || current === "--effort") {
      const reasoningEffort = normalizeCodexReasoningEffortValue(args[index + 1]);
      if (reasoningEffort) {
        normalized.push("-c", encodeCodexReasoningEffortConfig(reasoningEffort));
        index += 1;
        continue;
      }
      normalized.push(current);
      continue;
    }

    if (current.startsWith("--reasoning-effort=")) {
      const reasoningEffort = normalizeCodexReasoningEffortValue(current.slice("--reasoning-effort=".length));
      if (reasoningEffort) {
        normalized.push("-c", encodeCodexReasoningEffortConfig(reasoningEffort));
        continue;
      }
    }

    if (current.startsWith("--effort=")) {
      const reasoningEffort = normalizeCodexReasoningEffortValue(current.slice("--effort=".length));
      if (reasoningEffort) {
        normalized.push("-c", encodeCodexReasoningEffortConfig(reasoningEffort));
        continue;
      }
    }

    if (current === "-c" || current === "--config") {
      const next = args[index + 1];
      if (typeof next === "string") {
        const model = parseCodexModelConfig(next);
        const reasoningEffort = parseCodexReasoningEffortConfig(next);
        normalized.push(
          current === "--config" ? "--config" : "-c",
          model
            ? encodeCodexModelConfig(model)
            : reasoningEffort
              ? encodeCodexReasoningEffortConfig(reasoningEffort)
              : next,
        );
        index += 1;
        continue;
      }
    }

    if (current.startsWith("--config=")) {
      const value = current.slice("--config=".length);
      const model = parseCodexModelConfig(value);
      const reasoningEffort = parseCodexReasoningEffortConfig(value);
      normalized.push(
        model
          ? `--config=${encodeCodexModelConfig(model)}`
          : reasoningEffort
            ? `--config=${encodeCodexReasoningEffortConfig(reasoningEffort)}`
            : current,
      );
      continue;
    }

    normalized.push(current);
  }

  return normalized;
}

export function readCodexAppServerModelFromLaunchArgs(launchArgs?: string[]): string | null {
  const normalized = normalizeCodexAppServerLaunchArgs(launchArgs);

  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index] ?? "";
    if (current === "-c" || current === "--config") {
      const model = parseCodexModelConfig(normalized[index + 1]);
      if (model) {
        return model;
      }
      index += 1;
      continue;
    }

    if (current.startsWith("--config=")) {
      const model = parseCodexModelConfig(current.slice("--config=".length));
      if (model) {
        return model;
      }
    }
  }

  return null;
}

export function readCodexAppServerReasoningEffortFromLaunchArgs(launchArgs?: string[]): string | null {
  const normalized = normalizeCodexAppServerLaunchArgs(launchArgs);

  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index] ?? "";
    if (current === "-c" || current === "--config") {
      const reasoningEffort = parseCodexReasoningEffortConfig(normalized[index + 1]);
      if (reasoningEffort) {
        return reasoningEffort;
      }
      index += 1;
      continue;
    }

    if (current.startsWith("--config=")) {
      const reasoningEffort = parseCodexReasoningEffortConfig(current.slice("--config=".length));
      if (reasoningEffort) {
        return reasoningEffort;
      }
    }
  }

  return null;
}

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

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new CodexAppServerRequesterTimeoutError({ label, timeoutMs: effectiveTimeoutMs }));
    }, effectiveTimeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function metadataRecord(metadata: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = metadata?.[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function normalizeEnvironmentOverrides(env: Record<string, string | undefined> | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (!env) {
    return normalized;
  }

  for (const key of Object.keys(env).sort()) {
    const value = env[key];
    if (typeof value === "string") {
      normalized[key] = value;
    }
  }

  return normalized;
}

function mergeEnvironmentOverrides(
  baseEnv: Record<string, string | undefined>,
  overrides: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...baseEnv };
  if (!overrides) {
    return merged;
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "string") {
      merged[key] = value;
    } else {
      delete merged[key];
    }
  }

  return merged;
}

function parseJsonLine(line: string): CodexAppServerResponse | CodexAppServerNotification | CodexAppServerServerRequest | null {
  try {
    return JSON.parse(line) as CodexAppServerResponse | CodexAppServerNotification | CodexAppServerServerRequest;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : null;
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

async function assertCodexWorkingDirectory(cwd: string, agentName: string): Promise<void> {
  try {
    const stats = await stat(cwd);
    if (!stats.isDirectory()) {
      throw new Error(`Codex app-server cwd is not a directory for ${agentName}: ${cwd}`);
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new Error(`Codex app-server cwd does not exist for ${agentName}: ${cwd}`);
    }
    throw error;
  }
}

function buildUnsupportedServerRequestError(message: CodexAppServerServerRequest): CodexErrorResponse {
  if (message.method === "item/tool/call") {
    const tool = typeof message.params?.tool === "string" ? message.params.tool : null;
    const toolLabel = tool ? `dynamic tool call \`${tool}\`` : "dynamic tool call";
    return {
      code: -32000,
      message: `${toolLabel} is not supported by openscout-runtime`,
    };
  }

  return {
    code: -32000,
    message: `Unsupported server request: ${message.method}`,
  };
}

function isResponse(message: unknown): message is CodexAppServerResponse {
  return Boolean(
    message
    && typeof message === "object"
    && "id" in message
    && ("result" in message || "error" in message),
  );
}

function isServerRequest(message: unknown): message is CodexAppServerServerRequest {
  return Boolean(
    message
    && typeof message === "object"
    && "id" in message
    && "method" in message
    && !("result" in message)
    && !("error" in message),
  );
}

function isNotification(message: unknown): message is CodexAppServerNotification {
  return Boolean(
    message
    && typeof message === "object"
    && "method" in message
    && !("id" in message),
  );
}

type CodexSessionCatalogEntry = {
  id: string;
  startedAt: number;
  endedAt?: number;
  cwd: string;
  harness?: string;
  transport?: string;
  model?: string | null;
  approvalPolicy?: CodexAppServerApprovalPolicy;
  sandbox?: CodexAppServerSandboxMode;
};

type CodexSessionCatalog = {
  activeSessionId: string | null;
  sessions: CodexSessionCatalogEntry[];
};

const SESSION_CATALOG_FILENAME = "session-catalog.json";
const SESSION_CATALOG_MAX_ENTRIES = 64;

function parseCodexMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

async function readCodexSessionCatalog(runtimeDirectory: string): Promise<CodexSessionCatalog> {
  const raw = await readOptionalFile(join(runtimeDirectory, SESSION_CATALOG_FILENAME));
  if (!raw) {
    return { activeSessionId: null, sessions: [] };
  }

  const parsed = parseCodexMaybeJson(raw) as Partial<CodexSessionCatalog> | null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { activeSessionId: null, sessions: [] };
  }

  return {
    activeSessionId: typeof parsed.activeSessionId === "string" ? parsed.activeSessionId : null,
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions.filter((entry): entry is CodexSessionCatalogEntry => (
      Boolean(entry)
      && typeof entry === "object"
      && typeof (entry as CodexSessionCatalogEntry).id === "string"
      && typeof (entry as CodexSessionCatalogEntry).startedAt === "number"
      && typeof (entry as CodexSessionCatalogEntry).cwd === "string"
    )) : [],
  };
}

async function writeCodexSessionCatalog(runtimeDirectory: string, catalog: CodexSessionCatalog): Promise<void> {
  await mkdir(runtimeDirectory, { recursive: true });
  await writeCodexMetadata(join(runtimeDirectory, SESSION_CATALOG_FILENAME), JSON.stringify(catalog, null, 2) + "\n");
}

async function recordCodexSessionCatalog(
  runtimeDirectory: string,
  threadId: string,
  input: {
    cwd: string;
    harness: string;
    transport: string;
    model: string | null;
    approvalPolicy: CodexAppServerApprovalPolicy;
    sandbox: CodexAppServerSandboxMode;
  },
): Promise<void> {
  const catalog = await readCodexSessionCatalog(runtimeDirectory);
  const now = Date.now();
  const sessions = catalog.sessions.map((session) =>
    session.id === catalog.activeSessionId && session.id !== threadId && !session.endedAt
      ? { ...session, endedAt: now }
      : session
  );

  if (!sessions.some((session) => session.id === threadId)) {
    sessions.push({
      id: threadId,
      startedAt: now,
      cwd: input.cwd,
      harness: input.harness,
      transport: input.transport,
      model: input.model,
      approvalPolicy: input.approvalPolicy,
      sandbox: input.sandbox,
    });
  }

  while (sessions.length > SESSION_CATALOG_MAX_ENTRIES) {
    sessions.shift();
  }

  await writeCodexSessionCatalog(runtimeDirectory, {
    activeSessionId: threadId,
    sessions,
  });
}

async function closeCodexSessionCatalog(runtimeDirectory: string, threadId: string | null): Promise<void> {
  if (!threadId) {
    return;
  }
  const catalog = await readCodexSessionCatalog(runtimeDirectory);
  if (catalog.activeSessionId !== threadId) {
    return;
  }
  const activeSessionId = threadId;
  const now = Date.now();
  const sessions = catalog.sessions.map((session) =>
    session.id === activeSessionId && !session.endedAt
      ? { ...session, endedAt: now }
      : session
  );
  await writeCodexSessionCatalog(runtimeDirectory, {
    activeSessionId: null,
    sessions,
  });
}

function isMissingCodexRolloutError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("no rollout found for thread id");
}

function isCodexThreadWriterConflictError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("already has an active writer")
    || message.includes("thread-store conflict");
}

type ProactiveCodexAppServerShutdown = {
  reason: string;
};

export class CodexAppServerTransport {
  private readonly threadIdPath: string;
  private readonly statePath: string;
  private readonly stdoutLogPath: string;
  private readonly stderrLogPath: string;
  private readonly wireLog: CodexWireLog;

  private connection: CodexAppServerConnection | null = null;
  connectionGeneration = 0;
  nativeControlBlocked = false;
  private serverIdentity: CodexAppServerIdentity | null = null;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<string | number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();

  private starting: Promise<void> | null = null;
  private startupSignal: AbortSignal | undefined;
  private threadPersistence: Promise<void> = Promise.resolve();
  private threadPersistenceRunning = false;
  private threadPersistenceDirty = false;
  private promptDirty = false;
  private readonly writeMetadata = writeCodexMetadata;
  private readonly recordCatalog = recordCodexSessionCatalog;
  private confirmedThreadId: string | null = null;
  private catalogedThreadId: string | null = null;
  private metadataRetry: ReturnType<typeof setTimeout> | null = null;
  private metadataRetriesEnabled = true;
  private metadataRetryMs = 1000;
  private threadId: string | null = null;
  private threadPath: string | null = null;
  private durableThreadId: string | null = null;
  private proactiveShutdown: ProactiveCodexAppServerShutdown | null = null;
  /** Stopped for idleness with its thread kept; the next request starts it again. */
  private parked = false;
  /** The stop under way for a park; a wake waits for it before launching. */
  private parking: Promise<void> | null = null;
  private lastConfigSignature: string;
  private readonly notificationListeners = new Set<(message: CodexAppServerNotification) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();

  constructor(private options: CodexAppServerSessionOptions) {
    this.threadIdPath = join(options.runtimeDirectory, "codex-thread-id.txt");
    this.statePath = join(options.runtimeDirectory, "state.json");
    this.stdoutLogPath = join(options.logsDirectory, "stdout.log");
    this.stderrLogPath = join(options.logsDirectory, "stderr.log");
    this.wireLog = new CodexWireLog({
      append: async (path, text) => { await mkdir(this.options.logsDirectory, { recursive: true }); await appendBoundedLog(path, text); },
      setPaused: (paused) => this.connection?.setReadingPaused(paused),
      onError: (error) => console.warn(`[openscout] Codex wire-log persistence failed; logging degraded, input continues: ${error.message}`),
    });
    this.lastConfigSignature = this.configSignature(options);
  }

  get currentThreadId(): string | null {
    return this.threadId;
  }

  get currentThreadPath(): string | null {
    return this.threadPath;
  }

  get currentDurableThreadId(): string | null {
    return this.durableThreadId;
  }

  get stdoutLogFile(): string {
    return this.stdoutLogPath;
  }

  get stderrLogFile(): string {
    return this.stderrLogPath;
  }

  get pid(): number | null {
    return this.connection?.pid ?? null;
  }

  get identity(): CodexAppServerIdentity | null {
    return this.serverIdentity;
  }

  private get connectionConfig() {
    return resolveCodexAppServerConnectionConfig(this.options.connection);
  }

  get sessionOptions(): CodexAppServerSessionOptions {
    return this.options;
  }

  matches(options: CodexAppServerSessionOptions): boolean {
    if (this.lastConfigSignature === this.configSignature(options)) return true;
    // A generated provider ID promoted onto the broker endpoint names this
    // same live session. Only normalize identity; runtime/launch settings
    // remain strict so an actual requested change still replaces the client.
    // A parked session still names its thread: replacing it would reset that thread.
    if (!(this.isAlive() || this.parked) || !this.threadId
      || (this.options.threadId && this.options.threadId !== this.threadId)
      || (options.threadId && options.threadId !== this.threadId)) return false;
    const liveIdentity = { threadId: this.threadId, requireExistingThread: true };
    return this.configSignature({ ...this.options, ...liveIdentity })
      === this.configSignature({ ...options, ...liveIdentity });
  }

  update(options: CodexAppServerSessionOptions): void {
    this.options = options;
    this.lastConfigSignature = this.configSignature(options);
  }

  onNotification(listener: (message: CodexAppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  isAlive(): boolean {
    return Boolean(this.connection?.isOpen());
  }

  async ensureOnline(): Promise<CodexAppServerThreadResult> {
    await this.ensureStarted();
    if (!this.threadId) {
      throw new Error(`Codex app-server session for ${this.options.agentName} has no active thread.`);
    }

    return {
      threadId: this.threadId,
      durableThreadId: this.durableThreadId,
      codexAppServer: this.serverIdentity,
    };
  }

  async startTurn(prompt: string): Promise<TurnStartResult> {
    await this.ensureStarted();
    if (!this.threadId) {
      throw new Error(`Codex app-server session for ${this.options.agentName} has no active thread.`);
    }

    const response = await this.request<TurnStartResult>("turn/start", {
      threadId: this.threadId,
      cwd: this.options.cwd,
      input: this.textInput(prompt),
      ...this.attachedRuntimeParams({ includeEffort: true }),
    });
    await this.persistThreadId();
    return response;
  }

  /** Strict live-only write. No ensureStarted, fallback, attach, or thread load. */
  submitExisting(prompt: string, expectedTurnId?: string): Promise<any> {
    if (!this.isAlive() || !this.threadId || this.connection?.mode === "attached") throw new Error("native_not_owned_live");
    return this.request(expectedTurnId ? "turn/steer" : "turn/start", {
      threadId: this.threadId, input: this.textInput(prompt),
      ...(expectedTurnId ? { expectedTurnId } : { cwd: this.options.cwd, ...this.attachedRuntimeParams({ includeEffort: true }) }),
    });
  }

  get ownedLive(): boolean { return this.isAlive() && this.connection?.mode !== "attached"; }

  get isParked(): boolean { return this.parked; }

  /**
   * Stop an idle spawned app-server and keep its thread. Attached servers are
   * not Scout's to stop, so they are left alone. Returns whether it parked.
   */
  async park(reason: string): Promise<boolean> {
    if (!this.ownedLive || !this.threadId || this.durableThreadId !== this.threadId || this.starting || this.parking) return false;
    this.parked = true;
    const parking: Promise<void> = this.stop({ resetThread: false, reason })
      .finally(() => { if (this.parking === parking) this.parking = null; });
    this.parking = parking;
    await parking;
    return true;
  }

  async steerTurn(prompt: string, expectedTurnId: string): Promise<void> {
    await this.ensureStarted();
    if (!this.threadId) {
      throw new Error(`Codex app-server session for ${this.options.agentName} has no active thread.`);
    }

    await this.request("turn/steer", {
      threadId: this.threadId,
      expectedTurnId,
      input: this.textInput(prompt),
    });
  }

  async interruptTurn(turnId: string): Promise<void> {
    await this.ensureStarted();
    if (!this.threadId) {
      return;
    }

    await this.request("turn/interrupt", {
      threadId: this.threadId,
      turnId,
    });
  }

  async shutdown(options: CodexAppServerShutdownOptions = {}): Promise<void> {
    this.parked = false;
    await this.stop(options);
  }

  private async stop(options: CodexAppServerShutdownOptions): Promise<void> {
    await this.leaveAttachedThread();
    this.proactiveShutdown = {
      reason: options.reason
        ?? (options.resetThread ? "OpenScout reset the app-server session" : "OpenScout stopped the app-server session"),
    };
    const stoppedError = new CodexAppServerExitError({
      agentName: this.options.agentName,
      exitKind: "proactive_shutdown",
      exitCode: null,
      signal: null,
      reason: this.proactiveShutdown.reason,
    });

    for (const pending of this.pendingRequests.values()) {
      pending.reject(stoppedError);
    }
    this.pendingRequests.clear();

    const connection = this.connection;
    this.connection = null;
    this.starting = null;

    // Spawned: Scout owns the child and terminates it. Attached: close only
    // disconnects; the shared server keeps running.
    this.setPersistenceActive(false);
    await connection?.close();
    connection?.detach();
    await this.wireLog.flush();
    await this.threadPersistence;


    if (options.resetThread) {
      await closeCodexSessionCatalog(this.options.runtimeDirectory, this.durableThreadId);
      this.threadId = null;
      this.confirmedThreadId = null; this.catalogedThreadId = null;
      this.threadPath = null;
      this.durableThreadId = null;
      await rm(this.threadIdPath, { force: true });
    }

    await this.persistState();
  }

  /**
   * Attached servers were not launched with Scout's `-c model=…` args, so the
   * model and effort ride on the JSON-RPC requests instead. Spawned servers
   * keep today's launch-arg path unchanged.
   */
  private attachedRuntimeParams(options: { includeEffort?: boolean } = {}): Record<string, string> {
    if (this.connectionConfig.mode !== "attach") return {};
    const model = readCodexAppServerModelFromLaunchArgs(this.options.launchArgs);
    const effort = options.includeEffort
      ? readCodexAppServerReasoningEffortFromLaunchArgs(this.options.launchArgs)
      : null;
    return {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    };
  }

  /** Attached servers outlive Scout: unsubscribe so the server can unload the thread. */
  private async leaveAttachedThread(): Promise<void> {
    const connection = this.connection;
    if (!connection || connection.mode !== "attached" || !connection.isOpen() || !this.threadId) return;
    const threadId = this.threadId;
    try {
      await this.request("thread/unsubscribe", { threadId }, 2_000);
    } catch (error) {
      this.writeLog(
        this.stderrLogPath,
        `[openscout] failed to unsubscribe attached Codex thread ${threadId}: ${errorMessage(error)}\n`,
      );
    }
  }

  private textInput(prompt: string): Array<{ type: "text"; text: string; text_elements: never[] }> {
    return [
      {
        type: "text",
        text: prompt,
        text_elements: [],
      },
    ];
  }

  private configSignature(options: CodexAppServerSessionOptions): string {
    return JSON.stringify({
      cwd: options.cwd,
      sessionId: options.sessionId,
      systemPrompt: options.systemPrompt,
      approvalPolicy: options.approvalPolicy ?? "never",
      sandbox: options.sandbox ?? "danger-full-access",
      threadId: options.threadId ?? null,
      requireExistingThread: options.requireExistingThread === true,
      env: normalizeEnvironmentOverrides(options.env),
      launchArgs: normalizeCodexAppServerLaunchArgs(options.launchArgs),
      connection: resolveCodexAppServerConnectionConfig(options.connection),
      threadName: options.threadName?.trim() || null,
    });
  }

  private async ensureStarted(): Promise<void> {
    this.options.signal?.throwIfAborted();
    // Never launch beside a process that is still being parked.
    if (this.parking) await this.parking.catch(() => undefined);
    if (this.isAlive() && this.threadId) {
      return;
    }

    if (this.starting) {
      return this.starting;
    }

    const controller = new AbortController();
    const ownerSignal = this.options.signal;
    const onAbort = () => controller.abort(new CodexAppServerControlError({ method: "startup", aborted: true }));
    ownerSignal?.addEventListener("abort", onAbort, { once: true });
    const timeoutMs = controlDeadlineMs(this.options.startupTimeoutMs);
    const timer = setTimeout(() => controller.abort(new CodexAppServerControlError({ method: "startup", timeoutMs })), timeoutMs);
    this.startupSignal = controller.signal;
    let startup!: Promise<void>;
    startup = (async () => {
      try {
        await waitForStartup(this.startSession(controller.signal), controller.signal);
      } catch (error) {
        // Share cleanup with every startup waiter. Never let an old failure
        // detach the connection created by a later startup attempt.
        const failedConnection = this.connection;
        this.setPersistenceActive(false);
        this.connection = null;
        failedConnection?.detach();
        await failedConnection?.close();
        throw error;
      } finally {
        clearTimeout(timer);
        ownerSignal?.removeEventListener("abort", onAbort);
        if (this.startupSignal === controller.signal) this.startupSignal = undefined;
        if (this.starting === startup) this.starting = null;
      }
    })();
    this.starting = startup;
    await startup;
  }

  private async startSession(signal: AbortSignal): Promise<void> {
    this.setPersistenceActive(true);
    signal.throwIfAborted();
    await this.wireLog.flush();
    signal.throwIfAborted();
    // This prompt file is observational; baseInstructions goes over JSON-RPC.
    this.promptDirty = true;
    await this.persistPrompt();
    this.proactiveShutdown = null;
    try {
      await assertCodexWorkingDirectory(this.options.cwd, this.options.agentName);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(errorMessage(error));
      this.writeLog(this.stderrLogPath, `[openscout] ${failure.message}\n`);
      await this.persistState().catch(() => undefined);
      throw failure;
    }

    signal.throwIfAborted();
    // A harness session is a user-facing spawn: no service instance env.
    const env = this.options.processEnv ?? mergeEnvironmentOverrides(scoutUserSpawnEnvironment(process.env), this.options.env);
    const connectionConfig = this.connectionConfig;
    let connection: CodexAppServerConnection | undefined;
    const handlers = this.connectionHandlers(() => connection);
    let daemonVersion: Promise<CodexAppServerDaemonVersion | null> | null = null;
    if (connectionConfig.mode === "attach") {
      // `codex app-server daemon version` only describes the default control
      // socket, and it is read-only: it never starts or restarts the daemon.
      if (connectionConfig.socketPath === defaultCodexAppServerControlSocketPath()) {
        const executable = (() => {
          try {
            return resolveCodexExecutable();
          } catch {
            return null;
          }
        })();
        daemonVersion = executable ? readCodexAppServerDaemonVersion({ executable, env }) : null;
      }
      connection = await connectCodexAppServerSocket({
        socketPath: connectionConfig.socketPath,
        handlers,
        signal,
      });
      this.writeLog(
        this.stderrLogPath,
        `[openscout] attached to running Codex app-server at ${connectionConfig.socketPath}; Scout will not stop or restart it\n`,
      );
      if (signal.aborted) {
        await connection.close();
        connection.detach();
        signal.throwIfAborted();
      }
    } else {
      const launchArgs = normalizeCodexAppServerLaunchArgs(this.options.launchArgs);
      const codexExecutable = resolveCodexExecutable(env);
      const scoutMcp = await resolveScoutMcpCodexLaunch({
        currentDirectory: this.options.cwd,
        env,
        codexExecutable,
      });
      signal.throwIfAborted();
      if (scoutMcp.unknownReason) {
        this.writeLog(this.stderrLogPath, `[openscout] ${scoutMcp.unknownReason}\n`);
      }
      connection = spawnCodexAppServerStdioConnection({
        executable: codexExecutable,
        args: [
          "app-server",
          ...scoutMcp.args,
          ...launchArgs,
        ],
        cwd: this.options.cwd,
        env,
        handlers,
      });
      if (scoutMcp.usesUrl) {
        const failure = registerSharedScoutMcpClient(env, connection.pid);
        if (failure) {
          this.writeLog(this.stderrLogPath, `[openscout] could not register this app-server with the shared Scout MCP server: ${failure}\n`);
        }
      }
    }

    this.connectionGeneration++;
    this.connection = connection;
    connection.setReadingPaused(this.wireLog.isPaused);
    this.serverIdentity = null;

    const clientInfo = this.options.clientInfo ?? {
      name: "openscout-agent-sessions",
      title: "OpenScout Agent Sessions",
      version: "0.0.0",
    };

    const initialized = await this.request<InitializeResult>("initialize", {
      clientInfo,
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized");
    this.serverIdentity = buildCodexAppServerIdentity({
      connection,
      initialized,
      daemon: daemonVersion ? await daemonVersion : null,
    });

    signal.throwIfAborted();
    // A wake resumes the parked thread or fails; it never falls back to a new
    // thread. A failed wake stays parked, so a later message tries again.
    await this.resumeOrStartThread(signal, this.parked ? this.durableThreadId : null);
    this.parked = false;
    signal.throwIfAborted();
    await this.persistState();
    signal.throwIfAborted();
  }

  private async resumeOrStartThread(signal: AbortSignal, parkedThreadId: string | null = null): Promise<void> {
    const requestedThreadId = this.options.threadId?.trim() || parkedThreadId || null;
    const storedThreadId = requestedThreadId ?? await readOptionalFile(this.threadIdPath);
    signal.throwIfAborted();
    if (storedThreadId) {
      const threadOrigin = requestedThreadId ? "requested" : "stored";
      try {
        const resumed = await this.request<ThreadResumeResult>("thread/resume", {
          threadId: storedThreadId,
          cwd: this.options.cwd,
          approvalPolicy: this.options.approvalPolicy ?? "never",
          sandbox: this.options.sandbox ?? "danger-full-access",
          baseInstructions: this.options.systemPrompt,
          persistExtendedHistory: true,
          ...this.attachedRuntimeParams(),
        });
        this.threadId = resumed.thread.id;
        this.threadPath = resumed.thread.path ?? null;
        await this.persistThreadId({ confirmed: true });
        return;
      } catch (error) {
        // A missing control response is not evidence that the old thread is
        // absent. Never turn a resume timeout/abort into a fresh thread/start.
        if (isCodexAppServerControlError(error)) throw error;
        this.writeLog(
          this.stderrLogPath,
          `[openscout] failed to resume ${threadOrigin} Codex thread ${storedThreadId}: ${errorMessage(error)}\n`,
        );
        if (!requestedThreadId && isMissingCodexRolloutError(error)) {
          await rm(this.threadIdPath, { force: true }).catch(() => undefined);
          await closeCodexSessionCatalog(this.options.runtimeDirectory, storedThreadId);
          await this.persistState();
        }
        if (requestedThreadId || this.options.requireExistingThread) {
          if (isCodexThreadWriterConflictError(error)) {
            // Single-writer rule: the thread is open in another app-server
            // (typically the Codex desktop app). The session is not gone —
            // callers park delivery and retry when the writer lock releases.
            throw new CodexThreadHeldExternallyError({
              agentName: this.options.agentName,
              threadId: storedThreadId,
              detail: errorMessage(error),
            });
          }
          throw new Error(`Failed to resume ${threadOrigin} Codex thread ${storedThreadId}: ${errorMessage(error)}`);
        }
      }
    }

    if (this.options.requireExistingThread) {
      const detail = requestedThreadId
        ? ` for requested thread ${requestedThreadId}`
        : "";
      throw new Error(`Codex app-server session for ${this.options.agentName} requires an existing thread${detail}.`);
    }

    const started = await this.request<ThreadStartResult>("thread/start", {
      cwd: this.options.cwd,
      approvalPolicy: this.options.approvalPolicy ?? "never",
      sandbox: this.options.sandbox ?? "danger-full-access",
      baseInstructions: this.options.systemPrompt,
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
      ...this.attachedRuntimeParams(),
      ...(this.connectionConfig.mode === "attach" ? { threadSource: "user" } : {}),
    });
    this.threadId = started.thread.id;
    this.threadPath = started.thread.path ?? null;
    if (this.durableThreadId !== this.threadId) {
      this.durableThreadId = null;
    }
    await this.persistThreadId();
    signal.throwIfAborted();
    await this.nameStartedThread(started.thread.id);
  }

  private async nameStartedThread(threadId: string): Promise<void> {
    const name = this.options.threadName?.trim();
    if (!name) return;
    try {
      await this.request("thread/name/set", { threadId, name });
    } catch (error) {
      this.writeLog(
        this.stderrLogPath,
        `[openscout] failed to name Codex thread ${threadId}: ${errorMessage(error)}\n`,
      );
    }
  }

  private catalogRuntimeMeta(): {
    cwd: string;
    harness: string;
    transport: string;
    model: string | null;
    approvalPolicy: CodexAppServerApprovalPolicy;
    sandbox: CodexAppServerSandboxMode;
  } {
    return {
      cwd: this.options.cwd,
      harness: "codex",
      transport: "codex_app_server",
      model: readCodexAppServerModelFromLaunchArgs(this.options.launchArgs),
      approvalPolicy: this.options.approvalPolicy ?? "never",
      sandbox: this.options.sandbox ?? "danger-full-access",
    };
  }

  private connectionHandlers(current: () => CodexAppServerConnection | undefined): CodexAppServerConnectionHandlers {
    return {
      onMessage: (text) => this.handleMessageText(text),
      onStderr: (chunk) => {
        this.writeLog(this.stderrLogPath, chunk);
      },
      onClose: (close) => this.handleConnectionClose(current(), close),
    };
  }

  private handleConnectionClose(
    connection: CodexAppServerConnection | undefined,
    close: CodexAppServerConnectionClose,
  ): void {
    const proactiveShutdown = this.proactiveShutdown;
    if (proactiveShutdown) {
      this.handleProactiveProcessExit(connection, proactiveShutdown, close.exitCode, close.signal);
      return;
    }
    if (connection?.mode === "attached") {
      this.failSession(new CodexAppServerExitError({
        agentName: this.options.agentName,
        exitKind: "unexpected_exit",
        exitCode: null,
        signal: null,
        reason: close.error?.message ?? null,
      }));
      return;
    }
    if (close.error && close.exitCode === null && close.signal === null) {
      this.failSession(new Error(`Codex app-server failed for ${this.options.agentName}: ${errorMessage(close.error)}`));
      return;
    }
    this.failSession(new CodexAppServerExitError({
      agentName: this.options.agentName,
      exitCode: close.exitCode,
      signal: close.signal,
    }));
  }

  private handleMessageText(line: string): void {
    const message = parseJsonLine(line);
    if (!message) {
      this.writeLog(this.stderrLogPath, `[openscout] unparsable app-server output: ${line}\n`);
      return;
    }

    // Capability/config response IDs use their own namespace. Keeping this
    // check independent of pending requests suppresses late responses after a
    // timeout without an unbounded set of retained request-ID tombstones.
    const privateCapabilityResponse = isResponse(message)
      && typeof message.id === "string" && message.id.startsWith("scout-capability-");
    if (!privateCapabilityResponse) {
      this.writeLog(this.stdoutLogPath, `${line}\n`);
    }

    if (isResponse(message)) {
      this.handleResponse(message);
      return;
    }

    if (isServerRequest(message)) {
      this.handleServerRequest(message);
      return;
    }

    if (isNotification(message)) {
      this.handleNotification(message);
    }
  }

  private handleResponse(message: CodexAppServerResponse): void {
    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || `Codex app-server request failed: ${String(message.id)}`));
      return;
    }

    pending.resolve(message.result);
  }

  private readonly pendingPermissions = new Map<string | number, string>();

  private handleServerRequest(message: CodexAppServerServerRequest): void {
    const callback = this.options.onPermissionRequest;
    if (callback && this.connection?.mode !== "attached"
      && (message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval")
      && message.params?.threadId === this.threadId && typeof message.params?.turnId === "string") {
      const turnId = message.params.turnId;
      this.pendingPermissions.set(message.id, turnId);
      this.nativeControlBlocked = true;
      const isCurrent = () => this.isAlive() && this.pendingPermissions.get(message.id) === turnId;
      const respond = (result: Record<string, unknown>) => {
        if (!isCurrent()) throw new Error("Codex approval request is no longer live");
        this.writeMessage({ id: message.id, result });
        this.pendingPermissions.delete(message.id);
        this.nativeControlBlocked = this.pendingPermissions.size > 0;
      };
      void callback(message, { isCurrent, respond }).then(handled => {
        if (!handled && isCurrent()) {
          this.pendingPermissions.delete(message.id);
          this.writeMessage({ id: message.id, error: buildUnsupportedServerRequestError(message) });
        }
      }).catch(error => {
        if (isCurrent()) {
          this.pendingPermissions.delete(message.id);
          this.writeMessage({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
        }
      });
      return;
    }
    this.nativeControlBlocked = true;
    this.writeMessage({
      id: message.id,
      error: buildUnsupportedServerRequestError(message),
    });
  }

  private handleNotification(message: CodexAppServerNotification): void {
    const method = message.method;
    if (method === "turn/completed" && message.params?.threadId === this.threadId) {
      const params = message.params ?? {};
      const turn = params.turn as { id?: string } | undefined;
      for (const [id, turnId] of this.pendingPermissions) if (turnId === turn?.id) this.pendingPermissions.delete(id);
      this.nativeControlBlocked = this.pendingPermissions.size > 0;
    }
    const params = message.params ?? {};

    if (method === "thread/started" || method === "thread/name/updated") {
      const thread = params.thread as { id?: string; path?: string | null } | undefined;
      if (thread?.id) {
        if (thread.id !== this.threadId) {
          this.durableThreadId = null;
        }
        this.threadId = thread.id;
      }
      if ("path" in (thread ?? {})) {
        this.threadPath = thread?.path ?? null;
      }
      void this.persistThreadId();
    } else if (this.threadId && !this.durableThreadId) {
      void this.persistThreadId();
    }

    if (method === "turn/completed") this.nativeControlBlocked = false;
    this.emitNotification(message);
  }

  private emitNotification(message: CodexAppServerNotification): void {
    for (const listener of this.notificationListeners) {
      listener(message);
    }
  }

  private emitError(error: Error): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }

  private failSession(error: Error): void {
    this.setPersistenceActive(false);
    this.connection?.detach();
    this.connection = null;

    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();

    this.writeLog(this.stderrLogPath, `[openscout] ${error.message}\n`);
    void this.persistState().catch(() => undefined);
    this.emitError(error);
  }

  private handleProactiveProcessExit(
    connection: CodexAppServerConnection | undefined,
    shutdown: ProactiveCodexAppServerShutdown,
    code: number | null,
    signal: string | null,
  ): void {
    if (connection && this.connection === connection) {
      this.connection = null;
    }
    this.proactiveShutdown = null;
    this.starting = null;

    const exitDetail = [
      code !== null ? `code ${code}` : null,
      signal,
    ].filter(Boolean).join(", ");
    const detail = exitDetail ? ` (${exitDetail})` : "";
    this.writeLog(
      this.stderrLogPath,
      connection?.mode === "attached"
        ? `[openscout] detached from shared Codex app-server for ${this.options.agentName}: ${shutdown.reason}\n`
        : `[openscout] Codex app-server stopped for ${this.options.agentName}: ${shutdown.reason}${detail}\n`,
    );
    void this.persistState();
  }

  private writeLog(path: string, text: string): void {
    this.wireLog.append(path, redactSecrets(text));
  }

  private setPersistenceActive(active: boolean): void {
    this.wireLog.setActive(active); this.metadataRetriesEnabled = active;
    if (!active && this.metadataRetry) { clearTimeout(this.metadataRetry); this.metadataRetry = null; }
  }

  private metadataFailed(error: unknown): void {
    if (this.metadataRetry) return;
    try { console.warn(`[openscout] Codex metadata persistence failed; control continues: ${redactSecrets(errorMessage(error))}`); }
    catch { /* Diagnostic failure must not reject a control-path persistence promise. */ }
    if (!this.metadataRetriesEnabled) return;
    this.metadataRetry = setTimeout(() => { this.metadataRetry = null; void this.persistPrompt().then(() => this.persistThreadId()); }, this.metadataRetryMs);
    this.metadataRetry.unref?.();
  }

  private async persistPrompt(): Promise<void> {
    if (!this.promptDirty) return;
    try { await this.writeMetadata(join(this.options.runtimeDirectory, "prompt.txt"), this.options.systemPrompt); this.promptDirty = false; }
    catch (error) { this.metadataFailed(error); }
  }

  private persistThreadId(options: { confirmed?: boolean } = {}): Promise<void> {
    if (this.durableThreadId !== this.threadId) this.durableThreadId = null;
    if (options.confirmed) this.confirmedThreadId = this.threadId;
    this.threadPersistenceDirty = true;
    if (this.threadPersistenceRunning) return this.threadPersistence;
    this.threadPersistenceRunning = true;
    this.threadPersistence = (async () => {
      do {
        this.threadPersistenceDirty = false;
        try { await this.persistThreadIdNow(); }
        catch (error) { this.threadPersistenceDirty = false; this.metadataFailed(error); break; }
      } while (this.threadPersistenceDirty);
    })().finally(() => { this.threadPersistenceRunning = false; });
    return this.threadPersistence;
  }

  private async persistThreadIdNow(): Promise<void> {
    const threadId = this.threadId;
    if (!threadId) {
      this.durableThreadId = null;
      await rm(this.threadIdPath, { force: true });
      await this.persistState();
      return;
    }

    let rolloutExists = false;
    if (this.threadPath) {
      try {
        rolloutExists = (await stat(this.threadPath)).isFile();
      } catch {
        rolloutExists = false;
      }
    }

    if (this.confirmedThreadId !== threadId && !rolloutExists && this.durableThreadId !== threadId) {
      this.durableThreadId = null;
      await rm(this.threadIdPath, { force: true });
      await this.persistState();
      return;
    }

    await this.writeMetadata(this.threadIdPath, `${threadId}\n`);
    // A later notification may have selected another thread during the write.
    if (this.threadId !== threadId) { this.threadPersistenceDirty = true; return; }
    this.durableThreadId = threadId;
    await this.persistState();
    if (this.catalogedThreadId !== threadId) {
      await this.recordCatalog(this.options.runtimeDirectory, threadId, this.catalogRuntimeMeta());
      this.catalogedThreadId = threadId;
    }
  }

  private async persistState(): Promise<void> {
    try { await this.persistStateNow(); } catch (error) { this.metadataFailed(error); }
  }

  private async persistStateNow(): Promise<void> {
    const durableThreadPath = this.durableThreadId === this.threadId
      ? this.threadPath
      : null;
    await this.writeMetadata(
      this.statePath,
      JSON.stringify({
        agentId: this.options.agentName,
        transport: "codex_app_server",
        sessionId: this.options.sessionId,
        projectRoot: this.options.cwd,
        cwd: this.options.cwd,
        threadId: this.durableThreadId,
        threadPath: durableThreadPath,
        requestedThreadId: this.options.threadId ?? null,
        requireExistingThread: this.options.requireExistingThread === true,
        pid: this.connection?.pid ?? null,
        codexAppServer: this.serverIdentity,
        stdoutLogFile: this.stdoutLogPath,
        stderrLogFile: this.stderrLogPath,
        updatedAt: new Date().toISOString(),
      }, null, 2) + "\n",
    );
  }

  private async request<T>(method: string, params: unknown, timeoutOverrideMs?: number): Promise<T> {
    const sequence = this.nextRequestId++;
    const id = method === "model/list" || method === "config/read"
      ? `scout-capability-${sequence}` : String(sequence);

    return new Promise<T>((resolve, reject) => {
      const signals = [...new Set([this.options.signal, this.startupSignal].filter((signal): signal is AbortSignal => Boolean(signal)))];
      const timeoutMs = controlDeadlineMs(timeoutOverrideMs ?? this.options.controlRequestTimeoutMs);
      let sent = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        for (const signal of signals) signal.removeEventListener("abort", onAbort);
        this.pendingRequests.delete(id);
      };
      const fail = (error: Error) => {
        if (isCodexAppServerControlError(error) && error.submissionUnknown) this.nativeControlBlocked = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        const timedOut = signals.find((signal) => signal.aborted
          && isCodexAppServerControlError(signal.reason) && signal.reason.code === "CODEX_APP_SERVER_CONTROL_TIMEOUT");
        fail(new CodexAppServerControlError({
          method,
          aborted: !timedOut,
          ...(timedOut ? { timeoutMs: timedOut.reason.timeoutMs } : {}),
          submissionUnknown: sent && (method === "turn/start" || method === "turn/steer"),
        }));
      };
      if (signals.some((signal) => signal.aborted)) { onAbort(); return; }
      this.pendingRequests.set(id, {
        resolve: (value) => { cleanup(); resolve(value as T); },
        reject: fail,
      });
      for (const signal of signals) signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => fail(new CodexAppServerControlError({
        method, timeoutMs, submissionUnknown: sent && (method === "turn/start" || method === "turn/steer"),
      })), timeoutMs);

      try {
        sent = true;
        this.writeMessage({
          id,
          method,
          params,
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(errorMessage(error)));
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    this.writeMessage(params === undefined ? { method } : { method, params });
  }

  private writeMessage(message: Record<string, unknown>): void {
    const connection = this.connection;
    if (!connection || !connection.isOpen()) {
      throw new Error(`Codex app-server session for ${this.options.agentName} is not running.`);
    }

    connection.send(JSON.stringify(message));
  }
}

type ActiveTurn = {
  onDelta?: (delta: string) => void;
  turnId: string;
  startedAt: number;
  messageOrder: string[];
  messageByItemId: Map<string, string>;
  resolve: (output: string) => void;
  reject: (error: Error) => void;
  watchers: Array<{
    resolve: (output: string) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }>;
};

export class CodexAppServerClient {
  private readonly transport: CodexAppServerTransport;
  private serialized = Promise.resolve();
  private queuedOperations = 0;
  private readonly liveIncarnation = randomUUID();
  private liveRevision = 0;
  private attentionUnsafe = false;
  private activeTurn: ActiveTurn | null = null;
  private removeNotificationListener: (() => void) | null = null;
  private removeErrorListener: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** turn/started seen without its turn/completed, tracked or not. */
  private serverTurnOpen = false;
  private closed = false;

  constructor(private options: CodexAppServerSessionOptions) {
    this.transport = new CodexAppServerTransport(options);
    this.bindTransport();
  }

  get isParked(): boolean {
    return this.transport.isParked;
  }

  get threadId(): string | null {
    return this.transport.currentThreadId;
  }

  get threadPath(): string | null {
    return this.transport.currentThreadPath;
  }

  get stdoutLogFile(): string {
    return this.transport.stdoutLogFile;
  }

  get identity(): CodexAppServerIdentity | null {
    return this.transport.identity;
  }

  get stderrLogFile(): string {
    return this.transport.stderrLogFile;
  }

  matches(options: CodexAppServerSessionOptions): boolean {
    return this.transport.matches(options);
  }

  update(options: CodexAppServerSessionOptions): void {
    this.options = options;
    this.transport.update(options);
  }

  isAlive(): boolean {
    return this.transport.isAlive();
  }

  hasActiveTurn(): boolean {
    return Boolean(this.activeTurn);
  }

  observeExisting() {
    // Parked is idle, not gone: "gone" ends room bindings. A revive wakes it.
    if (this.transport.isParked && this.threadId) {
      return { state: "idle", sessionId: this.threadId, turnId: undefined,
        token: `${this.liveIncarnation}:parked:${this.liveRevision}`, steer: true } as const;
    }
    const state = !this.isAlive() ? "gone" : !this.transport.ownedLive || !this.threadId || this.attentionUnsafe || this.transport.nativeControlBlocked ? "unknown"
      : this.activeTurn ? (this.activeTurn.turnId ? "active" : "unknown") : this.queuedOperations ? "unknown" : "idle";
    return { state, sessionId: this.threadId ?? undefined, turnId: this.activeTurn?.turnId || undefined,
      token: `${this.liveIncarnation}:${this.transport.connectionGeneration}:${this.liveRevision}`, steer: true } as const;
  }

  async submitExisting(expected: { sessionId: string; token: string }, action: "revive" | "steer", prompt: string) {
    const observed = this.observeExisting();
    if (observed.sessionId !== expected.sessionId || observed.token !== expected.token
      || observed.state !== (action === "steer" ? "active" : "idle")) return { accepted: false, evidence: "native_state_changed" };
    this.touchIdle();
    try {
      return await this.submitObserved(expected, action, prompt, observed);
    } finally {
      this.settleIdle();
    }
  }

  private async submitObserved(
    expected: { sessionId: string; token: string },
    action: "revive" | "steer",
    prompt: string,
    observed: ReturnType<CodexAppServerClient["observeExisting"]>,
  ) {
    if (action === "revive" && this.transport.isParked) {
      const revision = this.liveRevision;
      await this.transport.ensureOnline();
      await this.serialized; // let the park itself, or any send, leave the queue
      if (this.liveRevision !== revision || this.activeTurn || this.queuedOperations || this.threadId !== expected.sessionId) {
        return { accepted: false, evidence: "native_state_changed" };
      }
    }
    if (action === "steer") {
      // No await between expected-state validation and the native expectedTurnId write.
      await this.transport.submitExisting(prompt, observed.turnId);
      return { accepted: true, evidence: "codex_turn_steer_accepted" };
    }
    let turn!: ActiveTurn;
    const completion = new Promise<string>((resolve, reject) => { turn = this.createActiveTurn(resolve, reject); });
    void completion.catch(() => undefined);
    try {
      const response = await this.transport.submitExisting(prompt);
      turn.turnId = response.turn.id;
      return { accepted: true, evidence: "codex_turn_start_accepted" };
    } catch (error) {
      if (!isCodexAppServerControlError(error) || !error.submissionUnknown) this.clearActiveTurn(turn);
      this.attentionUnsafe = true;
      turn.reject(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  ensureOnline(): Promise<CodexAppServerThreadResult> {
    this.touchIdle();
    return this.transport.ensureOnline().finally(() => this.settleIdle());
  }

  async invoke(prompt: string, timeoutMs?: number): Promise<CodexAppServerTurnResult> {
    const onDelta = this.options.onDelta;
    const signal = this.options.signal;
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      await this.transport.ensureOnline();
      signal?.throwIfAborted();
      if (!this.transport.currentThreadId) {
        throw new Error(`Codex app-server session for ${this.options.agentName} has no active thread.`);
      }

      const outputPromise = new Promise<string>((resolve, reject) => {
        const turn = this.createActiveTurn(resolve, reject, onDelta);
        void this.transport.startTurn(prompt).then((response) => {
          turn.turnId = response.turn.id;
        }, (error: unknown) => {
          if (!isCodexAppServerControlError(error) || !error.submissionUnknown) this.clearActiveTurn(turn);
          reject(error instanceof Error ? error : new Error(errorMessage(error)));
        });
      });
      const output = await waitForRequesterResult(outputPromise, timeoutMs, this.options.agentName);

      return {
        output,
        threadId: this.transport.currentThreadId,
        codexAppServer: this.transport.identity,
      };
    });
  }

  /**
   * Start a turn and return as soon as Codex accepts it. The active-turn
   * tracker remains attached to app-server notifications so later steer,
   * interrupt, and snapshot calls observe the same turn.
   */
  async start(prompt: string): Promise<CodexAppServerTurnStartResult> {
    const onDelta = this.options.onDelta;
    const signal = this.options.signal;
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      await this.transport.ensureOnline();
      signal?.throwIfAborted();
      if (!this.transport.currentThreadId) {
        throw new Error(`Codex app-server session for ${this.options.agentName} has no active thread.`);
      }
      if (this.activeTurn) {
        throw new Error(`Codex app-server session for ${this.options.agentName} already has an active turn.`);
      }

      let turn!: ActiveTurn;
      const completion = new Promise<string>((resolve, reject) => {
        turn = this.createActiveTurn(resolve, reject, onDelta);
      });
      // This path intentionally does not await the final reply. Keep the
      // completion promise observed while notifications finish the turn.
      void completion.catch(() => undefined);

      try {
        const response = await this.transport.startTurn(prompt);
        turn.turnId = response.turn.id;
        return {
          threadId: this.transport.currentThreadId,
          turnId: response.turn.id,
        };
      } catch (error) {
        if (!isCodexAppServerControlError(error) || !error.submissionUnknown) this.clearActiveTurn(turn);
        turn.reject(error instanceof Error ? error : new Error(errorMessage(error)));
        throw error;
      }
    });
  }

  async send(prompt: string, timeoutMs?: number): Promise<CodexAppServerTurnResult> {
    if (this.hasActiveTurn()) {
      return this.steerAndWait(prompt, timeoutMs);
    }
    return this.invoke(prompt, timeoutMs);
  }

  async steerAndWait(prompt: string, timeoutMs?: number): Promise<CodexAppServerTurnResult> {
    await this.transport.ensureOnline();
    if (!this.transport.currentThreadId) {
      throw new Error(`Codex app-server session for ${this.options.agentName} has no active thread.`);
    }

    const activeTurn = this.activeTurn;
    if (!activeTurn?.turnId) {
      return this.invoke(prompt, timeoutMs);
    }

    const output = await new Promise<string>((resolve, reject) => {
      const watcher = this.addTurnWatcher(activeTurn, resolve, reject, timeoutMs);
      void this.transport.steerTurn(prompt, activeTurn.turnId).catch((error: unknown) => {
        this.removeTurnWatcher(activeTurn, watcher);
        reject(error instanceof Error ? error : new Error(errorMessage(error)));
      });
    });

    return {
      output,
      threadId: this.transport.currentThreadId,
      codexAppServer: this.transport.identity,
    };
  }

  async steer(prompt: string): Promise<void> {
    this.touchIdle();
    // A parked session has no turn; do not start the server only to refuse.
    if (!this.transport.isParked) await this.transport.ensureOnline();
    if (!this.transport.currentThreadId || !this.activeTurn?.turnId) {
      this.settleIdle();
      throw new Error(`Codex app-server session for ${this.options.agentName} has no active turn to steer.`);
    }

    await this.transport.steerTurn(prompt, this.activeTurn.turnId);
  }

  async interrupt(): Promise<void> {
    if (this.transport.isParked) return;
    await this.transport.ensureOnline();
    if (!this.transport.currentThreadId || !this.activeTurn?.turnId) {
      return;
    }

    await this.transport.interruptTurn(this.activeTurn.turnId);
  }

  async shutdown(options: CodexAppServerShutdownOptions = {}): Promise<void> {
    const stoppedError = new CodexAppServerExitError({
      agentName: this.options.agentName,
      exitKind: "proactive_shutdown",
      exitCode: null,
      signal: null,
      reason: options.reason
        ?? (options.resetThread ? "OpenScout reset the app-server session" : "OpenScout stopped the app-server session"),
    });

    this.closed = true;
    this.touchIdle();
    const activeTurn = this.activeTurn;
    this.activeTurn = null;
    if (activeTurn) {
      for (const watcher of this.drainTurnWatchers(activeTurn)) {
        watcher.reject(stoppedError);
      }
      activeTurn.reject(stoppedError);
    }

    this.removeNotificationListener?.();
    this.removeNotificationListener = null;
    this.removeErrorListener?.();
    this.removeErrorListener = null;
    await this.transport.shutdown(options);
  }

  private bindTransport(): void {
    this.removeNotificationListener = this.transport.onNotification((message) => {
      this.handleNotification(message);
      if (message.method === "turn/started") this.serverTurnOpen = true;
      if (message.method === "turn/completed") this.serverTurnOpen = false;
      this.settleIdle();
    });
    this.removeErrorListener = this.transport.onError((error) => {
      this.serverTurnOpen = false;
      this.failActiveTurn(error);
      this.settleIdle();
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.touchIdle();
    this.queuedOperations++;
    const next = this.serialized.then(task, task).finally(() => { this.queuedOperations--; this.settleIdle(); });
    this.serialized = next.then(() => undefined, () => undefined);
    return next;
  }

  /** Any interaction stops the idle clock. */
  private touchIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Restart the idle clock from now when the session has nothing to do. */
  private settleIdle(): void {
    this.touchIdle();
    const idleParkMs = resolveCodexIdleParkMs(this.options.idleParkMs, { ...process.env, ...this.options.env });
    if (idleParkMs <= 0 || !this.isIdle()) return;
    this.idleTimer = setTimeout(() => this.parkIfIdle(idleParkMs), idleParkMs);
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  private isIdle(): boolean {
    return this.queuedOperations === 0 && this.isIdleIgnoringQueue();
  }

  private parkIfIdle(idleParkMs: number): void {
    this.idleTimer = null;
    if (!this.isIdle()) return;
    if (!this.threadIsDurable()) {
      this.settleIdle(); // look again after another window
      return;
    }
    // Retire idle tokens handed out before parking: a revive must re-observe.
    this.liveRevision++;
    const minutes = Math.round(idleParkMs / 60_000);
    void this.enqueue(async () => {
      // Serialized behind any send that arrived meanwhile; that send wins.
      if (this.queuedOperations > 1 || !this.isIdleIgnoringQueue()) return;
      await this.transport.park(
        `OpenScout parked the app-server after ${minutes} idle minute${minutes === 1 ? "" : "s"}; the next message resumes thread ${this.threadId}`,
      );
    }).catch(() => undefined);
  }

  private isIdleIgnoringQueue(): boolean {
    return !this.closed && !this.activeTurn && !this.serverTurnOpen
      && !this.transport.nativeControlBlocked && this.transport.ownedLive && Boolean(this.threadId);
  }

  /** Only a thread Codex has written can be resumed; parking any other would lose it. */
  private threadIsDurable(): boolean {
    return Boolean(this.threadId) && this.transport.currentDurableThreadId === this.threadId;
  }

  private createActiveTurn(
    resolve: (output: string) => void,
    reject: (error: Error) => void,
    onDelta?: (delta: string) => void,
  ): ActiveTurn {
    if (this.activeTurn) {
      throw new Error(`Codex app-server session for ${this.options.agentName} already has an active turn.`);
    }

    const turn: ActiveTurn = {
      onDelta,
      turnId: "",
      startedAt: Date.now(),
      messageOrder: [],
      messageByItemId: new Map<string, string>(),
      resolve,
      reject,
      watchers: [],
    };

    this.liveRevision++;
    this.activeTurn = turn;
    return turn;
  }

  private addTurnWatcher(
    turn: ActiveTurn,
    resolve: (output: string) => void,
    reject: (error: Error) => void,
    timeoutMs: number | undefined,
  ): ActiveTurn["watchers"][number] {
    const watcher: ActiveTurn["watchers"][number] = {
      resolve,
      reject,
      timer: null,
    };
    const effectiveTimeoutMs = resolveRequesterTimeoutMs(timeoutMs);
    if (effectiveTimeoutMs !== null) {
      watcher.timer = setTimeout(() => {
        this.removeTurnWatcher(turn, watcher);
        reject(new CodexAppServerRequesterTimeoutError({
          label: this.options.agentName,
          timeoutMs: effectiveTimeoutMs,
        }));
      }, effectiveTimeoutMs);
    }
    turn.watchers.push(watcher);
    return watcher;
  }

  private removeTurnWatcher(turn: ActiveTurn, watcher: ActiveTurn["watchers"][number]): void {
    if (watcher.timer) {
      clearTimeout(watcher.timer);
    }
    turn.watchers = turn.watchers.filter((candidate) => candidate !== watcher);
  }

  private drainTurnWatchers(turn: ActiveTurn): ActiveTurn["watchers"] {
    const watchers = turn.watchers;
    turn.watchers = [];
    for (const watcher of watchers) {
      if (watcher.timer) {
        clearTimeout(watcher.timer);
      }
    }
    return watchers;
  }

  private clearActiveTurn(turn: ActiveTurn): void {
    if (this.activeTurn === turn) {
      this.activeTurn = null;
      this.liveRevision++;
      this.attentionUnsafe = true; // Only turn/completed below proves an idle boundary.
    }
  }

  private handleNotification(message: CodexAppServerNotification): void {
    const method = message.method;
    const params = message.params ?? {};

    if (method === "item/started" && (params.item as any)?.type === "contextCompaction") this.attentionUnsafe = true;
    if (method === "item/completed" && (params.item as any)?.type === "contextCompaction") { this.attentionUnsafe = false; this.liveRevision++; }
    if (method === "turn/started") {
      if (!this.activeTurn) { this.attentionUnsafe = true; this.liveRevision++; }
      const turn = params.turn as { id?: string } | undefined;
      if (this.activeTurn && turn?.id && !this.activeTurn.turnId) {
        this.activeTurn.turnId = turn.id;
      }
      return;
    }

    if (method === "item/agentMessage/delta") {
      const turnId = typeof params.turnId === "string" ? params.turnId : null;
      const itemId = typeof params.itemId === "string" ? params.itemId : null;
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (!this.activeTurn || !turnId || !itemId) {
        return;
      }
      if (this.activeTurn.turnId && this.activeTurn.turnId !== turnId) {
        return;
      }
      if (!this.activeTurn.messageByItemId.has(itemId)) {
        this.activeTurn.messageOrder.push(itemId);
        this.activeTurn.messageByItemId.set(itemId, "");
      }
      this.activeTurn.messageByItemId.set(itemId, (this.activeTurn.messageByItemId.get(itemId) ?? "") + delta);
      if (delta) this.activeTurn.onDelta?.(delta);
      return;
    }

    if (method === "item/completed") {
      const turnId = typeof params.turnId === "string" ? params.turnId : null;
      const item = params.item as { type?: string; id?: string; text?: string } | undefined;
      if (!this.activeTurn || !turnId || item?.type !== "agentMessage" || !item.id) {
        return;
      }
      if (this.activeTurn.turnId && this.activeTurn.turnId !== turnId) {
        return;
      }
      if (!this.activeTurn.messageByItemId.has(item.id)) {
        this.activeTurn.messageOrder.push(item.id);
      }
      this.activeTurn.messageByItemId.set(item.id, item.text ?? this.activeTurn.messageByItemId.get(item.id) ?? "");
      return;
    }

    if (method === "turn/completed") {
      this.completeTurn(params as unknown as TurnCompletedParams);
      return;
    }

    if (method === "error") {
      const willRetry = params.willRetry === true;
      if (willRetry) {
        return;
      }
      const errorPayload = metadataRecord(params, "error");
      const messageText = metadataString(errorPayload, "message")
        ?? metadataString(params, "message")
        ?? "Codex app-server reported an error.";
      const codexErrorInfo = metadataString(errorPayload, "codexErrorInfo")
        ?? metadataString(params, "codexErrorInfo");
      const additionalDetails = metadataString(errorPayload, "additionalDetails")
        ?? metadataString(params, "additionalDetails");
      const detail = [codexErrorInfo, additionalDetails]
        .filter((value): value is string => Boolean(value && value.trim().length > 0))
        .join("; ");
      const error = detail.length > 0 ? `${messageText} (${detail})` : messageText;
      if (this.activeTurn) {
        const activeTurn = this.activeTurn;
        this.clearActiveTurn(activeTurn);
        this.attentionUnsafe = true;
        activeTurn.reject(new Error(error));
      }
    }
  }

  private completeTurn(params: TurnCompletedParams): void {
    const activeTurn = this.activeTurn;
    if (!activeTurn) {
      return;
    }

    if (activeTurn.turnId && activeTurn.turnId !== params.turn.id) {
      return;
    }

    this.clearActiveTurn(activeTurn);
    this.attentionUnsafe = false;

    if (params.turn.status === "failed") {
      const message = params.turn.error?.message || params.turn.error?.additionalDetails || `Turn failed for ${this.options.agentName}.`;
      for (const watcher of this.drainTurnWatchers(activeTurn)) {
        watcher.reject(new Error(message));
      }
      activeTurn.reject(new Error(message));
      return;
    }

    if (params.turn.status === "interrupted") {
      for (const watcher of this.drainTurnWatchers(activeTurn)) {
        watcher.reject(new Error(`Turn interrupted for ${this.options.agentName}.`));
      }
      activeTurn.reject(new Error(`Turn interrupted for ${this.options.agentName}.`));
      return;
    }

    // Codex can close a turn with a message that repeats an earlier one
    // word for word (a progress note restated as the final answer); the reply
    // carries it once.
    const output = activeTurn.messageOrder
      .map((itemId) => (activeTurn.messageByItemId.get(itemId) ?? "").trim())
      .filter((text, index, all) => text.length > 0 && all.indexOf(text) === index)
      .join("\n\n")
      .trim();

    if (!output) {
      for (const watcher of this.drainTurnWatchers(activeTurn)) {
        watcher.reject(new Error(`Codex completed without producing a final response for ${this.options.agentName}.`));
      }
      activeTurn.reject(new Error(`Codex completed without producing a final response for ${this.options.agentName}.`));
      return;
    }

    for (const watcher of this.drainTurnWatchers(activeTurn)) {
      watcher.resolve(output);
    }
    activeTurn.resolve(output);
  }

  private failActiveTurn(error: Error): void {
    const activeTurn = this.activeTurn;
    this.activeTurn = null;
    if (!activeTurn) {
      return;
    }

    for (const watcher of this.drainTurnWatchers(activeTurn)) {
      watcher.reject(error);
    }
    activeTurn.reject(error);
  }
}

const codexAppServerClients = new Map<string, CodexAppServerClient>();

export function codexAppServerSessionKey(options: Pick<CodexAppServerSessionOptions, "agentName" | "sessionId">): string {
  return `${options.agentName}:${options.sessionId}`;
}

export function getOrCreateCodexAppServerClient(options: CodexAppServerSessionOptions): CodexAppServerClient {
  const key = codexAppServerSessionKey(options);
  const existing = codexAppServerClients.get(key);
  if (existing) {
    if (existing.matches(options)) {
      return existing;
    }

    void existing.shutdown({
      resetThread: true,
      reason: "OpenScout replaced the app-server session after its launch options changed",
    });
    codexAppServerClients.delete(key);
  }

  const session = new CodexAppServerClient(options);
  codexAppServerClients.set(key, session);
  return session;
}

/** Transport-owner access only; absence is unknown after owner restart, not a launch request. */
export function existingCodexNativeSession(agentName: string, sessionId: string) {
  const client = codexAppServerClients.get(`${agentName}:${sessionId}`);
  if (!client) return undefined;
  return { observe: () => client.observeExisting(),
    submit: (expected: { sessionId: string; token: string }, action: "revive" | "steer", prompt: string) => client.submitExisting(expected, action, prompt) };
}

export async function ensureCodexAppServerLocalAgentOnline(
  options: CodexAppServerSessionOptions,
): Promise<CodexAppServerThreadResult> {
  const session = getOrCreateCodexAppServerClient(options);
  session.update(options);
  return session.ensureOnline();
}

export async function invokeCodexAppServerLocalAgent(
  options: CodexAppServerInvocationOptions,
): Promise<CodexAppServerTurnResult> {
  const session = getOrCreateCodexAppServerClient(options);
  session.update(options);
  return session.invoke(options.prompt, options.timeoutMs);
}

export async function startCodexAppServerLocalAgent(
  options: CodexAppServerInvocationOptions,
): Promise<CodexAppServerTurnStartResult> {
  const session = getOrCreateCodexAppServerClient(options);
  session.update(options);
  return session.start(options.prompt);
}

export async function sendCodexAppServerLocalAgent(
  options: CodexAppServerInvocationOptions,
): Promise<CodexAppServerTurnResult> {
  const session = getOrCreateCodexAppServerClient(options);
  session.update(options);
  return session.send(options.prompt, options.timeoutMs);
}

export async function steerCodexAppServerLocalAgent(options: CodexAppServerSteerOptions): Promise<void> {
  const session = getOrCreateCodexAppServerClient(options);
  session.update(options);
  await session.steer(options.prompt);
}

export async function interruptCodexAppServerLocalAgent(options: CodexAppServerInterruptOptions): Promise<void> {
  const key = codexAppServerSessionKey(options);
  const session = codexAppServerClients.get(key);
  if (!session) {
    return;
  }

  session.update(options);
  await session.interrupt();
}

export function isCodexAppServerLocalAgentAlive(options: CodexAppServerSessionOptions): boolean {
  const session = codexAppServerClients.get(codexAppServerSessionKey(options));
  // Parked counts: routing must still deliver to it, and delivery wakes it.
  return Boolean(session && (session.isAlive() || session.isParked));
}

export async function shutdownCodexAppServerLocalAgent(
  options: CodexAppServerSessionOptions,
  shutdownOptions: CodexAppServerShutdownOptions = {},
): Promise<void> {
  const key = codexAppServerSessionKey(options);
  const session = codexAppServerClients.get(key);
  if (!session) {
    if (shutdownOptions.resetThread) {
      const threadId = await readOptionalFile(join(options.runtimeDirectory, "codex-thread-id.txt"));
      await closeCodexSessionCatalog(options.runtimeDirectory, threadId);
      await rm(join(options.runtimeDirectory, "codex-thread-id.txt"), { force: true });
    }
    return;
  }

  codexAppServerClients.delete(key);
  await session.shutdown(shutdownOptions);
}
