import {
  createLocalAgentClient,
  type LocalAgentClient,
  type LocalAgentHarness,
  type LocalAgentTransport,
} from "@openscout/agent-sessions/local";

import type { RuntimeTimer } from "./portable-types.js";
import { bindManagedPermissionRequester } from "./managed-permission.js";
import { RequesterWaitTimeoutError } from "./requester-timeout.js";

export interface AcpAgentInvocationOptions {
  adapterType: "grok-acp" | "kimi-acp" | "cursor-acp" | "opencode-acp" | "devin-acp";
  label: string;
  /** Stable broker/runtime session id. It is not an ACP provider session id. */
  sessionId: string;
  /** Stable resolved endpoint key used to own one live ACP process. */
  poolKey?: string;
  /** Provider-native ACP session id used only when attaching a cold process. */
  resumeSessionId?: string;
  cwd: string;
  prompt: string;
  name?: string;
  timeoutMs?: number;
  hardCeilingMs?: number;
  adapterOptions?: Record<string, unknown>;
}

export interface AcpAgentInvocationResult {
  output: string;
  /** Provider-native ACP session id, suitable for a later cold resume. */
  sessionId: string;
  metadata?: Record<string, unknown>;
  /** Token counts as reported by the provider, when it reports any. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    totalTokens?: number;
  };
}

type AcpPoolEntry = {
  client: LocalAgentClient;
  fingerprint: string;
  nativeSessionId?: string;
};

// Env-tunable like the OPENSCOUT_TMUX_VERIFY_* deadlines — a VARIANT, not a
// one-way door. 60 min: 30 min was below a realistic multi-chapter turn and
// capped every ACP turn on every node regardless of what the ask declared.
const DEFAULT_ACP_HARD_CEILING_MS = 60 * 60_000;
const DEFAULT_ACP_HARD_CEILING_MAX_MS = 6 * 60 * 60_000;

function configuredAcpHardCeilingMs(): number {
  const parsed = Number.parseInt(process.env.OPENSCOUT_ACP_HARD_CEILING_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ACP_HARD_CEILING_MS;
}

function configuredAcpHardCeilingMaxMs(): number {
  const parsed = Number.parseInt(process.env.OPENSCOUT_ACP_HARD_CEILING_MAX_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ACP_HARD_CEILING_MAX_MS;
}

/**
 * The turn deadline passed to the local agent client. The requester's wait
 * (options.timeoutMs) deliberately does not feed it — a caller willing to
 * wait hours does not license an hours-long turn. An explicit execution
 * budget (invocation.execution.turnBudgetMs → hardCeilingMs) is the only
 * per-invocation override. Whatever the source, the result is clamped to the
 * administrator maximum OPENSCOUT_ACP_HARD_CEILING_MAX_MS (default 6 h) —
 * a defense-in-depth bound independent of the HTTP schema's own 6 h limit.
 */
export function acpTurnCeilingMs(
  options: Pick<AcpAgentInvocationOptions, "hardCeilingMs">,
): number {
  return Math.min(
    options.hardCeilingMs ?? configuredAcpHardCeilingMs(),
    configuredAcpHardCeilingMaxMs(),
  );
}

const activeAcpSessions = new Map<string, Promise<AcpPoolEntry>>();

function harnessForAdapter(adapterType: AcpAgentInvocationOptions["adapterType"]): LocalAgentHarness {
  if (adapterType === "grok-acp") return "grok";
  if (adapterType === "kimi-acp") return "kimi";
  if (adapterType === "opencode-acp") return "opencode";
  if (adapterType === "devin-acp") return "devin";
  return "cursor";
}

function transportForAdapter(adapterType: AcpAgentInvocationOptions["adapterType"]): LocalAgentTransport {
  if (adapterType === "grok-acp") return "grok_acp";
  if (adapterType === "kimi-acp") return "kimi_acp";
  if (adapterType === "opencode-acp") return "opencode_acp";
  if (adapterType === "devin-acp") return "devin_acp";
  return "cursor_acp";
}

function resolvedPoolKey(options: AcpAgentInvocationOptions): string {
  return options.poolKey?.trim() || `${options.adapterType}\u0000${options.sessionId}`;
}

function sessionFingerprint(options: AcpAgentInvocationOptions): string {
  const requestedModel = typeof options.adapterOptions?.model === "string"
    ? options.adapterOptions.model.trim()
    : "";
  const requestedEffort = typeof options.adapterOptions?.reasoningEffort === "string"
    ? options.adapterOptions.reasoningEffort.trim()
    : "";
  // Adapter model selection happens when the ACP process/session is created.
  // Reusing the same pool entry after the requested model changes would keep
  // prompting the old model while reporting the new request as resolved. The
  // same holds for reasoning effort, which rides on that one set_model call.
  return [options.adapterType, options.sessionId, options.cwd, requestedModel, requestedEffort].join("\u0000");
}

async function createPoolEntry(options: AcpAgentInvocationOptions): Promise<AcpPoolEntry> {
  const client = await createLocalAgentClient({
    harness: harnessForAdapter(options.adapterType),
    transport: transportForAdapter(options.adapterType),
    cwd: options.cwd,
    sessionId: options.sessionId,
    reuseKey: options.resumeSessionId,
    adapterOptions: options.adapterOptions,
    warmth: "lazy",
  });
  return {
    client,
    fingerprint: sessionFingerprint(options),
    nativeSessionId: options.resumeSessionId,
  };
}

async function closeEntry(entryPromise: Promise<AcpPoolEntry>): Promise<void> {
  const entry = await entryPromise.catch(() => null);
  if (entry) {
    await entry.client.close().catch(() => undefined);
  }
}

async function entryForInvocation(options: AcpAgentInvocationOptions): Promise<AcpPoolEntry> {
  const key = resolvedPoolKey(options);
  const fingerprint = sessionFingerprint(options);
  let detachedNativeSessionId: string | undefined;
  const existingPromise = activeAcpSessions.get(key);
  if (existingPromise) {
    const existing = await existingPromise;
    const requestedNativeId = options.resumeSessionId?.trim();
    const nativeIdConflict = Boolean(
      requestedNativeId
      && existing.nativeSessionId
      && requestedNativeId !== existing.nativeSessionId,
    );
    if (existing.fingerprint === fingerprint && !nativeIdConflict && existing.client.isAlive?.() !== false) {
      return existing;
    }
    detachedNativeSessionId = existing.nativeSessionId;
    if (activeAcpSessions.get(key) === existingPromise) {
      activeAcpSessions.delete(key);
    }
    await closeEntry(existingPromise);
  }

  const createdPromise = createPoolEntry({
    ...options,
    resumeSessionId: options.resumeSessionId ?? detachedNativeSessionId,
  });
  activeAcpSessions.set(key, createdPromise);
  try {
    return await createdPromise;
  } catch (error) {
    if (activeAcpSessions.get(key) === createdPromise) {
      activeAcpSessions.delete(key);
    }
    throw error;
  }
}

export async function invokeAcpAgent(
  options: AcpAgentInvocationOptions,
): Promise<AcpAgentInvocationResult> {
  // Bind now. The permission answer arrives later, outside this async context.
  const requestPermission = bindManagedPermissionRequester();
  const key = resolvedPoolKey(options);
  const entry = await entryForInvocation(options);
  const turn = entry.client.turn({
    input: options.prompt,
    timeoutMs: acpTurnCeilingMs(options),
    onPermission: async (request) => {
      let open = true;
      let decision: "approve" | "deny" = "deny";
      const accepted = await requestPermission({
        sessionId: options.sessionId,
        projectRoot: options.cwd,
        text: `${options.label} asks permission: ${request.description}`,
        version: `${request.turnId}:${request.blockId}:${request.version}`,
        decisions: ["once", "deny"],
        decisionLabels: { once: "Allow once", deny: "Deny" },
        isCurrent: async () => open,
        answer: async (choice) => {
          open = false;
          decision = choice === "deny" ? "deny" : "approve";
        },
      });
      if (!accepted) {
        throw new Error(`${options.label} has no permission surface for this request.`);
      }
      return decision;
    },
  }).then((result) => {
    const nativeSessionId = result.session.nativeId?.trim()
      || entry.nativeSessionId
      || options.resumeSessionId?.trim();
    if (!nativeSessionId) {
      throw new Error(`${options.label} did not expose a provider-native ACP session id.`);
    }
    entry.nativeSessionId = nativeSessionId;
    return {
      output: result.text,
      sessionId: nativeSessionId,
      metadata: result.metadata,
      usage: result.usage,
    };
  }).catch(async (error) => {
    const current = activeAcpSessions.get(key);
    if (current && await current.catch(() => null) === entry) {
      activeAcpSessions.delete(key);
    }
    await entry.client.close().catch(() => undefined);
    throw error;
  });

  return await waitForRequesterResult(turn, options.timeoutMs, options.label);
}

export async function shutdownAcpAgentSession(input: {
  adapterType: AcpAgentInvocationOptions["adapterType"];
  sessionId: string;
  poolKey?: string;
}): Promise<void> {
  const key = input.poolKey?.trim() || `${input.adapterType}\u0000${input.sessionId}`;
  const entry = activeAcpSessions.get(key);
  if (!entry) return;
  activeAcpSessions.delete(key);
  await closeEntry(entry);
}

export async function shutdownAllAcpAgentSessions(): Promise<void> {
  const entries = [...activeAcpSessions.values()];
  activeAcpSessions.clear();
  await Promise.all(entries.map(closeEntry));
}

function requesterTimeoutMs(timeoutMs: number | undefined): number | null {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return null;
  }
  return Math.floor(timeoutMs);
}

async function waitForRequesterResult<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  label: string,
): Promise<T> {
  const effectiveTimeoutMs = requesterTimeoutMs(timeoutMs);
  if (effectiveTimeoutMs === null) return await promise;

  let timer: RuntimeTimer | null = null;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new RequesterWaitTimeoutError({ label, timeoutMs: effectiveTimeoutMs }));
    }, effectiveTimeoutMs);
    timer.unref?.();
  });

  return await Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Read only the existing pool; do not use entryForInvocation (which can spawn). */
export async function existingAcpNativeSession(poolKey: string) {
  const pending = activeAcpSessions.get(poolKey);
  if (!pending) return undefined;
  const entry = await pending.catch(() => null);
  if (!entry || activeAcpSessions.get(poolKey) !== pending) return undefined;
  return entry.client.nativeAttention;
}
