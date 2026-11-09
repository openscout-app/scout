import { AcpAdapter } from "../adapters/acp/adapter.js";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { createAdapter as createGrokAcpAdapter } from "../adapters/grok-acp/index.js";
import { createAdapter as createKimiAcpAdapter } from "../adapters/kimi-acp/index.js";
import { createAdapter as createCursorAcpAdapter } from "../adapters/cursor-acp/index.js";
import { createAdapter as createOpencodeAcpAdapter } from "../adapters/opencode-acp/index.js";
import { createAdapter as createOpencodeV2Adapter } from "../adapters/opencode-v2/index.js";
import { findOpenCodeV2Binary } from "../adapters/opencode-v2/binary.js";
import { createAdapter as createOpenclawAcpAdapter } from "../adapters/openclaw-acp/index.js";
import { createAdapter as createDevinAcpAdapter } from "../adapters/devin-acp/index.js";
import { createAdapter as createPiAdapter } from "../adapters/pi/index.js";
import type { SequencedEvent } from "../buffer.js";
import type { AdapterFactory, AgentSessionStreamEvent, Session } from "../protocol/index.js";
import { SessionRegistry } from "../registry.js";
import type { SessionState, TurnState } from "../state.js";
import {
  getOrCreateCodexAppServerClient,
  shutdownCodexAppServerLocalAgent,
  type CodexAppServerClient,
  type CodexAppServerSessionOptions,
} from "./transports/codex-app-server.js";
import { buildLocalCodexLaunchArgs } from "./codex-launch-args.js";

export {
  existingCodexNativeSession,
  CODEX_ATTACHED_CAPABILITY_GAPS,
  CodexAppServerClient,
  CodexAppServerControlError,
  CodexAppServerExitError,
  CodexAppServerRequesterTimeoutError,
  CodexAppServerTransport,
  CodexThreadHeldExternallyError,
  buildCodexAppServerIdentity,
  codexAppServerSessionKey,
  defaultCodexAppServerControlSocketPath,
  ensureCodexAppServerLocalAgentOnline,
  getOrCreateCodexAppServerClient,
  interruptCodexAppServerLocalAgent,
  invokeCodexAppServerLocalAgent,
  isCodexAppServerExitError,
  isCodexAppServerControlError,
  isCodexAppServerLocalAgentAlive,
  isCodexThreadHeldExternallyError,
  normalizeCodexAppServerLaunchArgs,
  readCodexAppServerModelFromLaunchArgs,
  readCodexAppServerReasoningEffortFromLaunchArgs,
  sendCodexAppServerLocalAgent,
  shutdownCodexAppServerLocalAgent,
  startCodexAppServerLocalAgent,
  steerCodexAppServerLocalAgent,
} from "./transports/codex-app-server.js";
export type {
  CodexAppServerApprovalPolicy,
  CodexAppServerClientInfo,
  CodexAppServerConnectionConfig,
  CodexAppServerConnectionMode,
  CodexAppServerIdentity,
  CodexAppServerExitKind,
  CodexAppServerInterruptOptions,
  CodexAppServerInvocationOptions,
  CodexAppServerNotification,
  CodexAppServerRequest,
  CodexAppServerResponse,
  CodexAppServerSandboxMode,
  CodexAppServerServerRequest,
  CodexAppServerSessionOptions,
  CodexAppServerShutdownOptions,
  CodexAppServerSteerOptions,
  CodexAppServerThreadResult,
  CodexAppServerTurnStartResult,
  CodexAppServerTurnResult,
} from "./transports/codex-app-server.js";
import { scoutStateHome } from "../scout-state-paths.js";

export type LocalAgentHarness = "codex" | "pi" | "grok" | "grok-acp" | "kimi" | "cursor" | "opencode" | "devin" | "openclaw";
export type LocalAgentResolvedHarness = "codex" | "pi" | "grok" | "kimi" | "cursor" | "opencode" | "devin" | "openclaw";
export type LocalAgentTransport =
  | "codex_app_server"
  | "pi_rpc"
  | "grok_acp"
  | "kimi_acp"
  | "cursor_acp"
  | "opencode_acp"
  | "opencode_v2"
  | "devin_acp"
  | "openclaw_acp";
export type LocalAgentWarmth = "warm" | "lazy";

export type LocalAgentUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
};

export type LocalAgentSessionResult = {
  id: string;
  nativeId?: string;
  reused: boolean;
  warm: boolean;
};

export type LocalAgentTurnResult = {
  text: string;
  harness: LocalAgentResolvedHarness;
  transport: LocalAgentTransport;
  session: LocalAgentSessionResult;
  usage?: LocalAgentUsage;
  metadata?: Record<string, unknown>;
};

export type CompleteLocalAgentTurnOptions = {
  harness: LocalAgentHarness;
  transport?: LocalAgentTransport;
  cwd: string;
  systemPrompt?: string;
  input: string;
  model?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type CreateLocalAgentClientOptions = {
  harness: LocalAgentHarness;
  transport?: LocalAgentTransport;
  cwd: string;
  systemPrompt?: string;
  /** Stable id for the in-process SessionRegistry entry. */
  sessionId?: string;
  /** Provider-native id to resume or load when the harness process is cold. */
  reuseKey?: string;
  /** Adapter-specific behavior such as Cursor interaction and permission policy. */
  adapterOptions?: Record<string, unknown>;
  warmth?: LocalAgentWarmth;
  model?: string;
  /** Codex reasoning effort ("low" | "medium" | ...) — translated to a
   * model_reasoning_effort config override in the app-server launch args. */
  reasoningEffort?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type LocalAgentClientTurnOptions = {
  input: string;
  systemPrompt?: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Called once the harness session exists and before the prompt is sent,
   * with its provider-native id when the harness has reported one. A long
   * turn can then be tracked by that id while it runs, not only after it ends.
   */
  onSessionReady?: (session: { id: string; nativeId?: string }) => void;
};

export type LocalAgentClient = {
  turn(input: string | LocalAgentClientTurnOptions): Promise<LocalAgentTurnResult>;
  close(): Promise<void>;
  interrupt?(): void;
  isAlive?(): boolean;
  nativeAttention?: { observe: () => { state: "idle" | "active" | "unknown" | "gone"; sessionId?: string; turnId?: string; token: string; steer: boolean }; submit: AcpAdapter["submitExisting"] };
};

type LocalAdapterSpec = {
  adapterType: string;
  createAdapter: AdapterFactory;
};

type ActiveLocalSession = {
  registry: SessionRegistry;
  session: Session;
  createdBeforeFirstTurn: boolean;
};

const DEFAULT_LOCAL_AGENT_TIMEOUT_MS = 300_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeHarness(harness: LocalAgentHarness): LocalAgentResolvedHarness {
  return harness === "grok-acp" ? "grok" : harness;
}

function resolveLocalTransport(
  harness: LocalAgentResolvedHarness,
  requested: LocalAgentTransport | undefined,
): LocalAgentTransport {
  const defaultTransport: LocalAgentTransport = harness === "codex"
    ? "codex_app_server"
    : harness === "pi"
      ? "pi_rpc"
      : harness === "grok"
        ? "grok_acp"
        : harness === "kimi"
          ? "kimi_acp"
          : harness === "opencode"
            ? defaultOpenCodeTransport()
            : harness === "devin"
              ? "devin_acp"
              : "cursor_acp";
  const transport = requested ?? (harness === "openclaw" ? "openclaw_acp" : defaultTransport);
  if (harness === "openclaw" && transport !== "openclaw_acp") {
    throw new Error(`Local harness openclaw does not support transport ${transport}.`);
  }

  if (harness === "codex" && transport !== "codex_app_server") {
    throw new Error(`Local harness codex does not support transport ${transport}.`);
  }
  if (harness === "pi" && transport !== "pi_rpc") {
    throw new Error(`Local harness pi does not support transport ${transport}.`);
  }
  if (harness === "grok" && transport !== "grok_acp") {
    throw new Error(`Local harness grok does not support transport ${transport}.`);
  }
  if (harness === "kimi" && transport !== "kimi_acp") {
    throw new Error(`Local harness kimi does not support transport ${transport}.`);
  }
  if (harness === "cursor" && transport !== "cursor_acp") {
    throw new Error(`Local harness cursor does not support transport ${transport}.`);
  }
  if (harness === "opencode" && transport !== "opencode_acp" && transport !== "opencode_v2") {
    throw new Error(`Local harness opencode does not support transport ${transport}.`);
  }
  if (harness === "devin" && transport !== "devin_acp") {
    throw new Error(`Local harness devin does not support transport ${transport}.`);
  }

  return transport;
}

/**
 * OpenCode product V2 (`opencode2`) is the preferred OpenCode runtime. When it
 * is installed, local turns use its shared service; otherwise they fall back to
 * the V1 `opencode acp` bridge.
 */
export function defaultOpenCodeTransport(
  env: NodeJS.ProcessEnv = process.env,
  systemBinDirs?: readonly string[],
): "opencode_v2" | "opencode_acp" {
  return findOpenCodeV2Binary(env, systemBinDirs) ? "opencode_v2" : "opencode_acp";
}

function adapterSpecForTransport(transport: LocalAgentTransport): LocalAdapterSpec {
  if (transport === "openclaw_acp") {
    return { adapterType: "openclaw-acp", createAdapter: createOpenclawAcpAdapter };
  }
  if (transport === "pi_rpc") {
    return {
      adapterType: "pi",
      createAdapter: createPiAdapter,
    };
  }

  if (transport === "grok_acp") {
    return {
      adapterType: "grok-acp",
      createAdapter: createGrokAcpAdapter,
    };
  }

  if (transport === "kimi_acp") {
    return {
      adapterType: "kimi-acp",
      createAdapter: createKimiAcpAdapter,
    };
  }

  if (transport === "cursor_acp") {
    return {
      adapterType: "cursor-acp",
      createAdapter: createCursorAcpAdapter,
    };
  }

  if (transport === "opencode_acp") {
    return {
      adapterType: "opencode-acp",
      createAdapter: createOpencodeAcpAdapter,
    };
  }

  if (transport === "opencode_v2") {
    return {
      adapterType: "opencode-v2",
      createAdapter: createOpencodeV2Adapter,
    };
  }

  if (transport === "devin_acp") {
    return {
      adapterType: "devin-acp",
      createAdapter: createDevinAcpAdapter,
    };
  }

  throw new Error(`Transport ${transport} is handled outside the adapter registry.`);
}

function localSessionName(harness: LocalAgentResolvedHarness): string {
  if (harness === "openclaw") return "Local OpenClaw ACP";
  if (harness === "codex") {
    return "Local Codex";
  }
  if (harness === "pi") return "Local Pi";
  if (harness === "grok") return "Local Grok ACP";
  if (harness === "kimi") return "Local Kimi Code ACP";
  if (harness === "devin") return "Local Devin ACP";
  return harness === "opencode" ? "Local OpenCode" : "Local Cursor ACP";
}

function buildAdapterOptions(options: {
  transport: LocalAgentTransport;
  systemPrompt?: string;
  model?: string;
  reuseKey?: string;
  adapterOptions?: Record<string, unknown>;
}): Record<string, unknown> {
  if (options.transport === "pi_rpc") {
    return {
      ...(options.adapterOptions ?? {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.systemPrompt ? { appendSystemPrompt: options.systemPrompt } : {}),
      ...(options.reuseKey ? { sessionId: options.reuseKey } : {}),
    };
  }

  return {
    // This convenience client has no permission consumer. Direct adapter users
    // can opt into interactive approval and answer through decide().
    ...(options.transport === "openclaw_acp" ? { permissionMode: "safe_reject" } : {}),
    ...(options.adapterOptions ?? {}),
    ...(options.reuseKey ? { sessionId: options.reuseKey, sessionMode: "auto" } : {}),
    ...(options.transport === "cursor_acp" ? { cursorExtensions: true } : {}),
    // Grok exposes model selection through ACP's session/set_model method.
    ...(options.transport === "grok_acp" && options.model ? { model: options.model } : {}),
    // OpenCode has no model flag on `acp`; its adapter turns this into a
    // config overlay on the child environment.
    ...(options.transport === "opencode_acp" && options.model ? { model: options.model } : {}),
    // V2 takes `provider/model#variant` and sets it on the new native session.
    ...(options.transport === "opencode_v2" && options.model ? { model: options.model } : {}),
    // Devin selects the model at process launch; its adapter turns this into
    // a `devin acp --model <id>` argument.
    ...(options.transport === "devin_acp" && options.model ? { model: options.model } : {}),
  };
}

function textForTurn(options: {
  input: string;
  turnSystemPrompt?: string;
  sessionSystemPrompt?: string;
  sessionSystemPromptAppliedByAdapter: boolean;
}): string {
  const input = options.input.trim();
  const turnSystemPrompt = options.turnSystemPrompt?.trim();
  const sessionSystemPrompt = options.sessionSystemPromptAppliedByAdapter
    ? undefined
    : options.sessionSystemPrompt?.trim();
  const effectiveSystemPrompt = turnSystemPrompt || sessionSystemPrompt;

  if (!effectiveSystemPrompt) {
    return input;
  }

  return [
    "System instructions:",
    effectiveSystemPrompt,
    "",
    "User input:",
    input,
  ].join("\n");
}

function eventSessionId(event: AgentSessionStreamEvent): string | undefined {
  return "sessionId" in event && typeof event.sessionId === "string" ? event.sessionId : undefined;
}

function terminalTurnEvent(event: AgentSessionStreamEvent, sessionId: string): {
  kind: "resolved" | "rejected";
  turnId?: string;
  message?: string;
} | null {
  if (eventSessionId(event) !== sessionId) {
    return null;
  }

  if (event.event === "turn:error") {
    return {
      kind: "rejected",
      turnId: event.turnId,
      message: event.message || "Local agent turn failed.",
    };
  }

  if (event.event !== "turn:end") {
    return null;
  }

  if (event.status === "failed") {
    return {
      kind: "rejected",
      turnId: event.turnId,
      message: "Local agent turn failed.",
    };
  }

  if (event.status === "stopped") {
    return {
      kind: "rejected",
      turnId: event.turnId,
      message: "Local agent turn was interrupted.",
    };
  }

  return {
    kind: "resolved",
    turnId: event.turnId,
  };
}

function abortError(): Error {
  return new Error("Local agent turn aborted.");
}

function timeoutError(timeoutMs: number): Error {
  return new Error(`Timed out waiting for local agent turn after ${timeoutMs}ms.`);
}

export async function waitForTurnEnd(options: {
  registry: SessionRegistry;
  sessionId: string;
  text: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const { registry, sessionId, text, signal } = options;
  if (signal?.aborted) {
    registry.interrupt(sessionId);
    throw abortError();
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let removeAbortListener: (() => void) | undefined;

  try {
    const completed = new Promise<string | undefined>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        callback();
      };

      // Settle BEFORE interrupting: interrupt() emits turn:end("stopped")
      // synchronously, which the subscriber below would settle on first and
      // overwrite the specific error with the generic interrupted message.
      // The settled latch keeps whichever reason lands first.
      timeout = setTimeout(() => {
        settle(() => reject(timeoutError(options.timeoutMs)));
        registry.interrupt(sessionId);
      }, options.timeoutMs);

      if (signal) {
        const abort = (): void => {
          settle(() => reject(abortError()));
          registry.interrupt(sessionId);
        };
        signal.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", abort);
      }

      unsubscribe = registry.onEvent((entry: SequencedEvent) => {
        const terminal = terminalTurnEvent(entry.event, sessionId);
        if (!terminal) {
          return;
        }

        if (terminal.kind === "rejected") {
          settle(() => {
            let message = terminal.message ?? "Local agent turn failed.";
            // ACP surfaces the provider stop reason on providerMeta — a
            // truncated or refused turn should say why, not just "failed".
            if (message === "Local agent turn failed.") {
              const stopReason = stringValue(
                nestedRecord(registry.getSessionSnapshot(sessionId)?.session.providerMeta, "acp")?.lastStopReason,
              );
              if (stopReason) {
                message = `Local agent turn failed (${stopReason}).`;
              }
            }
            reject(new Error(message));
          });
          return;
        }

        settle(() => resolve(terminal.turnId));
      });
    });

    registry.send({ sessionId, text });
    return await completed;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    unsubscribe?.();
    removeAbortListener?.();
  }
}

function textFromTurn(turn: TurnState | undefined): string {
  if (!turn) {
    return "";
  }

  return turn.blocks
    .map(({ block }) => block.type === "text" ? block.text.trim() : "")
    .filter(Boolean)
    .join("\n\n");
}

function findTurn(snapshot: SessionState | null, turnId: string | undefined): TurnState | undefined {
  if (!snapshot) {
    return undefined;
  }
  if (turnId) {
    const matched = snapshot.turns.find((turn) => turn.id === turnId);
    if (matched) {
      return matched;
    }
  }
  return snapshot.turns.at(-1);
}

function nestedRecord(source: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = source?.[key];
  return isRecord(value) ? value : undefined;
}

function nativeSessionId(snapshot: SessionState | null): string | undefined {
  const meta = snapshot?.session.providerMeta;
  if (snapshot?.session.adapterType === "openclaw-acp") {
    // OpenClaw's newSession UUID belongs to one bridge process. Cold resume
    // resolves a Gateway session key, published separately in session info.
    // Never return the ephemeral UUID as a usable continuation handle.
    const info = nestedRecord(nestedRecord(meta, "acp"), "acpSessionInfo");
    return stringValue(nestedRecord(info, "_meta")?.sessionKey);
  }
  return stringValue(meta?.externalSessionId)
    ?? stringValue(meta?.threadId)
    ?? stringValue(nestedRecord(meta, "acp")?.acpSessionId);
}

function readUsageRecord(record: Record<string, unknown> | undefined): LocalAgentUsage | undefined {
  if (!record) {
    return undefined;
  }

  const usage: LocalAgentUsage = {
    inputTokens: numberValue(record.inputTokens)
      ?? numberValue(record.input_tokens)
      ?? numberValue(record.promptTokens)
      ?? numberValue(record.prompt_tokens),
    outputTokens: numberValue(record.outputTokens)
      ?? numberValue(record.output_tokens)
      ?? numberValue(record.completionTokens)
      ?? numberValue(record.completion_tokens),
    cachedInputTokens: numberValue(record.cachedInputTokens)
      ?? numberValue(record.cached_input_tokens),
    totalTokens: numberValue(record.totalTokens)
      ?? numberValue(record.total_tokens),
  };

  return Object.values(usage).some((value) => typeof value === "number") ? usage : undefined;
}

function usageFromSnapshot(snapshot: SessionState | null): LocalAgentUsage | undefined {
  const meta = snapshot?.session.providerMeta;
  return readUsageRecord(nestedRecord(meta, "usage"))
    ?? readUsageRecord(nestedRecord(nestedRecord(meta, "acp"), "usage"))
    ?? readUsageRecord(nestedRecord(meta, "observeUsage"));
}

function metadataFromSnapshot(snapshot: SessionState | null, turn: TurnState | undefined): Record<string, unknown> | undefined {
  if (!snapshot) {
    return undefined;
  }

  return {
    adapterType: snapshot.session.adapterType,
    providerMeta: snapshot.session.providerMeta ?? {},
    ...(turn
      ? {
        turn: {
          id: turn.id,
          status: turn.status,
          startedAt: turn.startedAt,
          endedAt: turn.endedAt,
        },
      }
      : {}),
  };
}

function normalizeTurnInput(input: string | LocalAgentClientTurnOptions): LocalAgentClientTurnOptions {
  return typeof input === "string" ? { input } : input;
}

function safeCodexSessionSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "codex";
}

function codexLocalSessionPaths(sessionId: string): {
  runtimeDirectory: string;
  logsDirectory: string;
} {
  const root = join(scoutStateHome(), "local", "codex", safeCodexSessionSegment(sessionId));
  return {
    runtimeDirectory: join(root, "runtime"),
    logsDirectory: join(root, "logs"),
  };
}

function buildCodexSessionOptions(options: {
  sessionId: string;
  cwd: string;
  systemPrompt?: string;
  model?: string;
  reasoningEffort?: string;
}): CodexAppServerSessionOptions {
  const paths = codexLocalSessionPaths(options.sessionId);
  return {
    agentName: "Local Codex",
    sessionId: options.sessionId,
    cwd: options.cwd,
    systemPrompt: options.systemPrompt?.trim() || "You are a helpful local Codex agent.",
    runtimeDirectory: paths.runtimeDirectory,
    logsDirectory: paths.logsDirectory,
    launchArgs: buildLocalCodexLaunchArgs({
      model: options.model,
      reasoningEffort: options.reasoningEffort,
    }),
    clientInfo: {
      name: "openscout-agent-sessions",
      title: "OpenScout Agent Sessions",
      version: "0.0.0",
    },
  };
}

async function runCodexTurnWithAbort(
  client: CodexAppServerClient,
  text: string,
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<{ output: string; threadId: string }> {
  if (options.signal?.aborted) {
    await client.interrupt().catch(() => undefined);
    throw abortError();
  }

  let removeAbortListener: (() => void) | undefined;
  try {
    const turn = client.invoke(text, options.timeoutMs);
    const abort = options.signal
      ? new Promise<never>((_resolve, reject) => {
          const onAbort = (): void => {
            void client.interrupt().catch(() => undefined);
            reject(abortError());
          };
          options.signal?.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
        })
      : null;

    return await (abort ? Promise.race([turn, abort]) : turn);
  } finally {
    removeAbortListener?.();
  }
}

async function createCodexLocalAgentClient(
  options: CreateLocalAgentClientOptions,
): Promise<LocalAgentClient> {
  const sessionId = options.sessionId?.trim() || options.reuseKey?.trim() || randomUUID();
  let currentSessionOptions = buildCodexSessionOptions({
    sessionId,
    cwd: options.cwd,
    systemPrompt: options.systemPrompt,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
  });
  let client = getOrCreateCodexAppServerClient(currentSessionOptions);
  let closed = false;
  let turnCount = 0;
  let createdBeforeFirstTurn = false;
  let queue: Promise<unknown> = Promise.resolve();

  if (options.warmth !== "lazy") {
    createdBeforeFirstTurn = true;
    await client.ensureOnline();
  }

  const runTurn = async (rawInput: string | LocalAgentClientTurnOptions): Promise<LocalAgentTurnResult> => {
    if (closed) {
      throw new Error("Local agent client is closed.");
    }

    const turnOptions = normalizeTurnInput(rawInput);
    const model = turnOptions.model ?? options.model;
    const nextSessionOptions = buildCodexSessionOptions({
      sessionId,
      cwd: options.cwd,
      systemPrompt: options.systemPrompt,
      model,
      reasoningEffort: options.reasoningEffort,
    });
    currentSessionOptions = nextSessionOptions;
    client = getOrCreateCodexAppServerClient(nextSessionOptions);
    client.update(nextSessionOptions);

    const text = textForTurn({
      input: turnOptions.input,
      turnSystemPrompt: turnOptions.systemPrompt,
      sessionSystemPrompt: options.systemPrompt,
      sessionSystemPromptAppliedByAdapter: true,
    });
    const reused = turnCount > 0;
    const warm = createdBeforeFirstTurn;
    const result = await runCodexTurnWithAbort(client, text, {
      timeoutMs: Math.max(1, turnOptions.timeoutMs ?? options.timeoutMs ?? DEFAULT_LOCAL_AGENT_TIMEOUT_MS),
      signal: turnOptions.signal ?? options.signal,
    });
    turnCount += 1;

    return {
      text: result.output,
      harness: "codex",
      transport: "codex_app_server",
      session: {
        id: sessionId,
        nativeId: result.threadId,
        reused,
        warm,
      },
      metadata: {
        providerMeta: {
          threadId: result.threadId,
          ...(client.threadPath ? { threadPath: client.threadPath } : {}),
          stdoutLogFile: client.stdoutLogFile,
          stderrLogFile: client.stderrLogFile,
        },
      },
    };
  };

  return {
    turn(input: string | LocalAgentClientTurnOptions): Promise<LocalAgentTurnResult> {
      const next = queue.then(() => runTurn(input), () => runTurn(input));
      queue = next.then(() => undefined, () => undefined);
      return next;
    },
    async close(): Promise<void> {
      closed = true;
      await shutdownCodexAppServerLocalAgent(currentSessionOptions);
    },
    interrupt(): void {
      void client.interrupt().catch(() => undefined);
    },
  };
}

export async function createLocalAgentClient(
  options: CreateLocalAgentClientOptions,
): Promise<LocalAgentClient> {
  const harness = normalizeHarness(options.harness);
  const transport = resolveLocalTransport(harness, options.transport);
  if (harness === "openclaw" && (options.model || options.reasoningEffort)) {
    throw new Error("OpenClaw ACP model and effort are configured on the Gateway agent.");
  }
  if (transport === "codex_app_server") {
    return createCodexLocalAgentClient({
      ...options,
      harness,
      transport,
    });
  }

  const spec = adapterSpecForTransport(transport);
  let nativeAdapter: AcpAdapter | undefined;
  let pendingTurns = 0;
  const registry = new SessionRegistry({
    adapters: {
      [spec.adapterType]: config => { const adapter = spec.createAdapter(config); if (adapter instanceof AcpAdapter) nativeAdapter = adapter; return adapter; },
    },
  });
  const sessionId = options.sessionId?.trim() || options.reuseKey?.trim() || randomUUID();
  const sessionSystemPromptAppliedByAdapter = transport === "pi_rpc";
  let active: ActiveLocalSession | null = null;
  let closed = false;
  let turnCount = 0;
  let queue: Promise<unknown> = Promise.resolve();

  const ensureSession = async (turnOptions?: LocalAgentClientTurnOptions): Promise<ActiveLocalSession> => {
    if (closed) {
      throw new Error("Local agent client is closed.");
    }
    if (active) {
      return active;
    }

    const createdBeforeFirstTurn = !turnOptions;
    const model = turnOptions?.model ?? options.model;
    const session = await registry.createSession(spec.adapterType, {
      sessionId,
      name: localSessionName(harness),
      cwd: options.cwd,
      options: buildAdapterOptions({
        transport,
        systemPrompt: options.systemPrompt,
        model,
        reuseKey: options.reuseKey,
        adapterOptions: options.adapterOptions,
      }),
    });
    active = {
      registry,
      session,
      createdBeforeFirstTurn,
    };
    return active;
  };

  if (options.warmth !== "lazy") {
    await ensureSession();
  }

  const runTurn = async (rawInput: string | LocalAgentClientTurnOptions): Promise<LocalAgentTurnResult> => {
    const turnOptions = normalizeTurnInput(rawInput);
    if (harness === "openclaw" && turnOptions.model) {
      throw new Error("OpenClaw ACP model is configured on the Gateway agent.");
    }
    const localSession = await ensureSession(turnOptions);
    if (turnOptions.onSessionReady) {
      try {
        turnOptions.onSessionReady({
          id: localSession.session.id,
          nativeId: nativeSessionId(registry.getSessionSnapshot(localSession.session.id)),
        });
      } catch {
        // Session tracking is evidence for observers; it never fails the turn.
      }
    }
    const warm = localSession.createdBeforeFirstTurn;
    const reused = turnCount > 0;
    const text = textForTurn({
      input: turnOptions.input,
      turnSystemPrompt: turnOptions.systemPrompt,
      sessionSystemPrompt: options.systemPrompt,
      sessionSystemPromptAppliedByAdapter,
    });
    const turnId = await waitForTurnEnd({
      registry,
      sessionId: localSession.session.id,
      text,
      timeoutMs: Math.max(1, turnOptions.timeoutMs ?? options.timeoutMs ?? DEFAULT_LOCAL_AGENT_TIMEOUT_MS),
      signal: turnOptions.signal ?? options.signal,
    });
    turnCount += 1;

    const snapshot = registry.getSessionSnapshot(localSession.session.id);
    const turn = findTurn(snapshot, turnId);
    return {
      text: textFromTurn(turn),
      harness,
      transport,
      session: {
        id: localSession.session.id,
        nativeId: nativeSessionId(snapshot),
        reused,
        warm,
      },
      usage: usageFromSnapshot(snapshot),
      metadata: metadataFromSnapshot(snapshot, turn),
    };
  };

  return {
    nativeAttention: {
      observe: () => !nativeAdapter || closed ? { state: "unknown", steer: false, token: "" }
        : pendingTurns && nativeAdapter.observeExisting().state === "idle" ? { state: "unknown", steer: false, token: "" } : nativeAdapter.observeExisting(),
      submit: (expected, action, prompt) => !nativeAdapter || closed || pendingTurns
        ? { accepted: false, evidence: "native_busy_or_unknown" } : nativeAdapter.submitExisting(expected, action, prompt),
    },
    turn(input: string | LocalAgentClientTurnOptions): Promise<LocalAgentTurnResult> {
      pendingTurns++;
      const next = queue.then(() => runTurn(input), () => runTurn(input)).finally(() => { pendingTurns--; });
      queue = next.then(() => undefined, () => undefined);
      return next;
    },
    async close(): Promise<void> {
      closed = true;
      await registry.shutdown();
      active = null;
    },
    interrupt(): void {
      if (active) {
        registry.interrupt(active.session.id);
      }
    },
    isAlive(): boolean {
      if (closed || !active) {
        return !closed;
      }
      const status = registry.getSessionSnapshot(active.session.id)?.session.status;
      return status !== "error" && status !== "closed";
    },
  };
}

export async function completeLocalAgentTurn(
  options: CompleteLocalAgentTurnOptions,
): Promise<LocalAgentTurnResult> {
  const client = await createLocalAgentClient({
    harness: options.harness,
    transport: options.transport,
    cwd: options.cwd,
    systemPrompt: options.systemPrompt,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    warmth: "lazy",
  });

  try {
    return await client.turn({
      input: options.input,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
  } finally {
    await client.close();
  }
}
