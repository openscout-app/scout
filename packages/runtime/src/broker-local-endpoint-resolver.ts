import type {
  ActorIdentity,
  AgentDefinition,
  AgentEndpoint,
  AgentHarness,
  InvocationRequest,
  SessionPlacement,
} from "@openscout/protocol";

import { describeAttachedLiveTerminal, isAttachedLiveTerminalEndpoint } from "./live-terminal-session.js";
import { isA2AHttpEndpoint } from "./a2a-http-endpoint.js";
import { isCodexThreadHeldExternallyError } from "./codex-app-server.js";
import {
  compareLocalEndpointPreference,
  endpointMatchesTargetSession,
} from "./broker-endpoint-selection.js";
import {
  invocationTargetSessionId,
  staleLocalEndpointReason,
} from "./broker-local-invocation-helpers.js";
import {
  isBrokerRunnableLocalAgentTransport,
  isDirectLocalAgentTransport,
} from "./local-agent-transports.js";
import {
  clearEndpointFailureMetadata,
  type LocalAgentBinding,
} from "./local-agents.js";
import {
  discardAdoptedSessionEvidence,
  endpointSessionIdIsUnverified,
  sessionObservationMetadata,
  type LocalEndpointSessionObservation,
} from "./session-observation.js";

type LocalEndpointRuntime = {
  endpointsForAgent(
    agentId: string,
    options?: {
      includeOffline?: boolean;
      nodeId?: string;
      harness?: AgentEndpoint["harness"];
    },
  ): AgentEndpoint[];
};

export type BrokerLocalEndpointResolverOptions = {
  nodeId: string;
  runtime: LocalEndpointRuntime;
  isLocalAgentEndpointAlive: (endpoint: AgentEndpoint) => boolean;
  isLocalAgentEndpointAliveAsync?: (endpoint: AgentEndpoint) => Promise<boolean>;
  ensureLocalSessionEndpointOnline: (endpoint: AgentEndpoint) => Promise<{
    externalSessionId?: string | null;
    metadata?: Record<string, unknown>;
  }>;
  ensureLocalAgentBindingOnline: (
    agentId: string,
    nodeId: string,
    options: {
      includeDiscovered?: boolean;
      harness?: AgentHarness;
    },
  ) => Promise<LocalAgentBinding | null>;
  /**
   * Spawn a one-invocation session attached to a durable agent without
   * changing that agent's configured endpoint or runtime metadata.
   */
  createIsolatedAgentEndpoint?: (invocation: InvocationRequest) => Promise<AgentEndpoint | null>;
  /**
   * What the harness itself reports about the session behind an endpoint whose
   * transport cannot be asked over a wire (tmux). Null when no live, unambiguous
   * harness record exists for that endpoint.
   */
  observeLocalEndpointSession?: (endpoint: AgentEndpoint) => Promise<LocalEndpointSessionObservation | null>;
  upsertActor: (actor: ActorIdentity) => Promise<void>;
  upsertAgent: (agent: AgentDefinition) => Promise<void>;
  persistEndpoint: (endpoint: AgentEndpoint) => Promise<void>;
  now?: () => number;
};

export type LocalSessionPreparationResult = {
  externalSessionId?: string | null;
  metadata?: Record<string, unknown>;
};

function metadataSessionId(
  metadata: AgentEndpoint["metadata"] | undefined,
  key: "externalSessionId" | "threadId" | "nativeSessionId",
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The harness-owned conversation id, distinct from Scout routing identity. */
export function localEndpointProviderSessionId(endpoint: AgentEndpoint): string | null {
  return metadataSessionId(endpoint.metadata, "externalSessionId")
    ?? metadataSessionId(endpoint.metadata, "threadId")
    ?? metadataSessionId(endpoint.metadata, "nativeSessionId");
}

/** Prefer provider identity in traces, while retaining legacy endpoint fallbacks. */
export function localEndpointTraceSessionId(endpoint: AgentEndpoint): string | null {
  return localEndpointProviderSessionId(endpoint)
    ?? endpoint.sessionId?.trim()
    ?? null;
}

/**
 * Attach provider-owned identity without changing endpoint.sessionId, which is
 * the stable Scout routing identity for cardless and isolated sessions.
 */
export function promoteLocalEndpointProviderSession(
  endpoint: AgentEndpoint,
  result: LocalSessionPreparationResult,
): AgentEndpoint {
  const resultMetadata = result.metadata ?? {};
  const metadataProviderSessionId = metadataSessionId(resultMetadata, "externalSessionId")
    || metadataSessionId(resultMetadata, "threadId")
    || metadataSessionId(resultMetadata, "nativeSessionId")
    || null;
  // Pi's direct result id is the Scout adapter/runtime key, not Pi's native
  // session identity. Only provider metadata may promote a Pi endpoint.
  const reportedSessionId = endpoint.transport === "pi_rpc"
    ? metadataProviderSessionId
    : result.externalSessionId?.trim() || metadataProviderSessionId;
  return {
    ...endpoint,
    metadata: {
      ...(endpoint.metadata ?? {}),
      ...resultMetadata,
      ...(reportedSessionId ? {
        externalSessionId: reportedSessionId,
        pendingExternalSession: false,
        ...(endpoint.transport === "codex_app_server" ? { threadId: reportedSessionId } : {}),
      } : {}),
    },
  };
}

export class BrokerLocalEndpointResolver {
  constructor(private readonly options: BrokerLocalEndpointResolverOptions) {}

  activeLocalEndpointForAgent(
    agentId: string,
    harness?: AgentEndpoint["harness"],
    targetSessionId?: string,
    options: { includeWakeable?: boolean } = {},
  ): AgentEndpoint | undefined {
    const candidates = this.options.runtime.endpointsForAgent(agentId, {
      nodeId: this.options.nodeId,
      harness,
    }).filter((endpoint) => {
      if (endpoint.metadata?.staleLocalRegistration === true) {
        return false;
      }
      return targetSessionId ? endpointMatchesTargetSession(endpoint, targetSessionId) : true;
    });
    const orderedCandidates = targetSessionId
      ? candidates
      : [...candidates].sort(compareLocalEndpointPreference);
    return orderedCandidates.find((endpoint) => (
      isA2AHttpEndpoint(endpoint)
        ? true
        : endpoint.transport === "pairing_bridge"
        ? endpoint.state !== "offline"
        : (options.includeWakeable && isWakeableSessionBackedEndpoint(endpoint))
          || this.options.isLocalAgentEndpointAlive(endpoint)
    ));
  }

  async resolveLocalEndpointForInvocation(invocation: InvocationRequest): Promise<AgentEndpoint | undefined> {
    const requestedHarness = invocation.execution?.harness;
    const targetSessionId = invocationTargetSessionId(invocation);
    const sessionPreference = invocation.execution?.session ?? "new";
    const shouldUseExistingSession = Boolean(targetSessionId);
    const hasExplicitRuntime = invocationHasExplicitRuntime(invocation);
    const existing = await this.activeLocalEndpointForInvocation(
      invocation.targetAgentId,
      requestedHarness,
      targetSessionId,
      { includeWakeable: invocation.ensureAwake },
    );
    if (
      hasExplicitRuntime
      && !shouldUseExistingSession
      && sessionPreference !== "existing"
      && invocation.ensureAwake
      && this.options.createIsolatedAgentEndpoint
    ) {
      const isolatedEndpoint = await this.options.createIsolatedAgentEndpoint(invocation);
      if (isolatedEndpoint) {
        await this.options.persistEndpoint(isolatedEndpoint);
        return isolatedEndpoint;
      }
    }
    if (
      existing
      && (
        shouldUseExistingSession
        || existing.transport === "pairing_bridge"
        || isA2AHttpEndpoint(existing)
        || isBrokerRunnableLocalAgentTransport(existing.transport)
      )
    ) {
      assertEndpointPlacementMatches(existing, invocation);
      // Exact continuations and exact runtimes are judged on what the harness
      // reports: re-read its record for a named session (a stale or adopted
      // alias must not steer a request into a session it does not name), and
      // give an unobserved runtime one chance to be observed before ruling.
      const evidence = shouldUseExistingSession || hasExplicitRuntime
        ? await this.withObservedSessionEvidence(existing, { verifyIdentity: shouldUseExistingSession, invocation })
        : { endpoint: existing };
      const evidenced = evidence.endpoint;
      if (targetSessionId && !endpointMatchesTargetSession(evidenced, targetSessionId)) {
        throw new Error(
          `session_identity_mismatch: session ${targetSessionId} is not the session running on `
            + `${existing.sessionId ?? existing.id}; its harness reports ${localEndpointProviderSessionId(evidenced)}`,
        );
      }
      if (hasExplicitRuntime) {
        assertEndpointObservedRuntimeMatches(evidenced, invocation, this.now(), evidence.resumeHarness);
      }
      return evidenced;
    }

    if (!shouldUseExistingSession && sessionPreference === "existing") {
      return undefined;
    }

    const staleEndpoints = shouldUseExistingSession
      ? this.options.runtime.endpointsForAgent(invocation.targetAgentId, {
          nodeId: this.options.nodeId,
          harness: requestedHarness,
        }).filter((endpoint) =>
          endpoint.id !== existing?.id
          && endpointMatchesTargetSession(endpoint, targetSessionId!)
        )
      : [];
    const staleLocalReason = staleEndpoints
      .map((endpoint) => staleLocalEndpointReason(endpoint))
      .find((reason): reason is string => Boolean(reason));
    if (staleLocalReason) {
      throw new Error(staleLocalReason);
    }

    if (invocation.ensureAwake && shouldUseExistingSession) {
      for (const endpoint of staleEndpoints) {
        assertEndpointPlacementMatches(endpoint, invocation);
        try {
          const checked = endpoint.transport === "tmux" && endpoint.harness === "claude"
            ? await this.withObservedSessionEvidence(endpoint, { verifyIdentity: true, invocation })
            : { endpoint };
          if (!endpointMatchesTargetSession(checked.endpoint, targetSessionId!)) {
            throw new Error(`session_identity_mismatch: session ${targetSessionId} is not the current native session`);
          }
          if (endpoint.transport === "tmux" && endpoint.harness === "claude" && hasExplicitRuntime) {
            assertEndpointObservedRuntimeMatches(checked.endpoint, invocation, this.now(), checked.resumeHarness);
          }
          const revived = await this.reviveExactSessionEndpoint(checked.endpoint);
          if (revived) return revived;
        } catch (error) {
          if (isCodexThreadHeldExternallyError(error)) {
            // The thread is open in another app, not dead — surface the truth
            // so the caller parks delivery instead of latching this endpoint
            // offline as if the session were gone.
            throw error;
          }
          await this.options.persistEndpoint({
            ...endpoint,
            state: "offline",
            metadata: {
              ...(endpoint.metadata ?? {}),
              lastError: error instanceof Error ? error.message : String(error),
              lastFailedAt: this.now(),
            },
          });
        }
      }
    }

    for (const endpoint of staleEndpoints) {
      await this.options.persistEndpoint({
        ...endpoint,
        state: "offline",
        metadata: {
          ...(endpoint.metadata ?? {}),
          lastError: endpoint.transport === "tmux"
            ? `tmux session missing: ${endpoint.sessionId ?? endpoint.id}`
            : `${endpoint.transport} session unavailable: ${endpoint.sessionId ?? endpoint.id}`,
          lastFailedAt: this.now(),
        },
      });
    }

    if (targetSessionId && invocation.ensureAwake) {
      const correlated = await this.correlatePendingExternalSession(
        invocation,
        targetSessionId,
        requestedHarness,
      );
      if (correlated) return correlated;
      throw new Error(`session ${targetSessionId} is not currently reachable`);
    }

    if (!invocation.ensureAwake) {
      return undefined;
    }

    if (targetSessionId) {
      return undefined;
    }

    // An agent bound to the operator's own live session is reachable only
    // there. Never spawn a replacement when that process is gone.
    const attachedLive = this.options.runtime.endpointsForAgent(invocation.targetAgentId, {
      nodeId: this.options.nodeId,
    }).find(isAttachedLiveTerminalEndpoint);
    if (attachedLive) {
      throw new Error(
        `live ${attachedLive.harness} session in ${describeAttachedLiveTerminal(attachedLive)} is no longer running; `
          + "Scout does not start a replacement. Attach the session again from where it runs.",
      );
    }

    const binding = await this.options.ensureLocalAgentBindingOnline(invocation.targetAgentId, this.options.nodeId, {
      includeDiscovered: true,
      harness: requestedHarness,
    });
    if (!binding) {
      return undefined;
    }

    if (binding.actor.id !== binding.agent.id) {
      await this.options.upsertActor(binding.actor);
    }
    await this.options.upsertAgent(binding.agent);
    await this.options.persistEndpoint(binding.endpoint);
    return binding.endpoint;
  }

  /**
   * Scout registers a session-backed endpoint the moment it launches a harness,
   * before that harness has told us its own session id, and records
   * `pendingExternalSession` to say the id is still owed. `prepareLocalEndpoint\
ForInvocation` settles that debt for the transports that can be asked directly
   * (codex_app_server, claude_stream_json, pi_rpc). A tmux-hosted harness
   * cannot be asked over a wire, but it still records its own identity on disk
   * (Claude Code names the tmux pane it runs in next to its session id), and
   * `observeLocalEndpointSession` reads that record for the endpoint's pane.
   *
   * A steer addressed by a harness id therefore correlates; it never adopts.
   * Every live endpoint still owed a verified id is asked what its harness
   * says about it, that answer is persisted as the endpoint's alias whether or
   * not it is the id the caller named, and the steer proceeds only onto an
   * endpoint whose harness reported exactly the requested id. The caller's id
   * is a claim to check against evidence, not evidence that the only pending
   * process is theirs; missing or ambiguous evidence leaves the endpoint
   * pending and the request unmet.
   */
  private async correlatePendingExternalSession(
    invocation: InvocationRequest,
    targetSessionId: string,
    requestedHarness: AgentEndpoint["harness"] | undefined,
  ): Promise<AgentEndpoint | undefined> {
    if (!this.options.observeLocalEndpointSession) return undefined;
    const candidates = this.options.runtime.endpointsForAgent(invocation.targetAgentId, {
      nodeId: this.options.nodeId,
      harness: requestedHarness,
    }).filter((endpoint) => (
      endpointSessionIdIsUnverified(endpoint)
      && endpoint.metadata?.staleLocalRegistration !== true
      && isCorrelatableEndpointState(endpoint.state)
    ));
    let matched: AgentEndpoint | undefined;
    for (const endpoint of candidates) {
      if (!(await this.endpointIsAlive(endpoint))) continue;
      const observed = await this.observedEndpoint(endpoint);
      if (!observed) continue;
      // Evidence about this endpoint is worth keeping whether or not it
      // satisfies this request: the next steer resolves by alias directly.
      await this.options.persistEndpoint(observed);
      if (!matched && localEndpointProviderSessionId(observed) === targetSessionId) {
        matched = observed;
      }
    }
    if (!matched) return undefined;
    assertEndpointPlacementMatches(matched, invocation);
    if (invocationHasExplicitRuntime(invocation)) {
      assertEndpointObservedRuntimeMatches(matched, invocation, this.now());
    }
    return matched;
  }

  /**
   * Fold in the current harness report, or quarantine prior caller-adopted
   * evidence if observation is unavailable. Named sessions re-read identity;
   * runtime-only requests re-read while no trustworthy model is available.
   */
  private async withObservedSessionEvidence(
    endpoint: AgentEndpoint,
    options: { verifyIdentity: boolean; invocation: InvocationRequest },
  ): Promise<{ endpoint: AgentEndpoint; resumeHarness?: string }> {
    const adopted = typeof endpoint.metadata?.externalSessionAdoptedAt === "number";
    const tmuxClaude = endpoint.transport === "tmux" && endpoint.harness === "claude";
    if (!tmuxClaude && !adopted && !options.verifyIdentity && observedRuntimeForEndpoint(endpoint).model) return { endpoint };
    const observed = await this.observedEndpoint(endpoint);
    if (!observed) {
      const quarantined = discardAdoptedSessionEvidence(endpoint);
      if (quarantined !== endpoint) await this.options.persistEndpoint(quarantined);
      const target = invocationTargetSessionId(options.invocation);
      const exactNative = target && target !== endpoint.id && target !== endpoint.sessionId;
      if (
        !adopted
        && tmuxClaude
        && (options.invocation.execution?.model || options.invocation.execution?.reasoningEffort)
        && !provisionedRuntimeForPendingEndpoint(endpoint, this.now())
      ) {
        throw new Error(`session_runtime_unobserved: session ${target ?? endpoint.sessionId ?? endpoint.id} has no current model or effort observation`);
      }
      if (!adopted && exactNative && endpoint.transport === "tmux" && endpoint.harness === "claude") {
        // A configured-agent restart creates a fresh context. Only a stopped
        // flat-dispatch endpoint has the supported native --resume path.
        const canResume = endpoint.metadata?.flatDispatch === true && options.invocation.ensureAwake
          && !(await this.endpointIsAlive(endpoint));
        if (!canResume) throw new Error(`session_identity_unobserved: cannot verify native session ${target} on ${endpoint.sessionId ?? endpoint.id}`);
        const awaitingResume: AgentEndpoint = { ...endpoint, metadata: { ...endpoint.metadata,
          pendingExternalSession: false, observedSessionId: null, observedSessionEvidence: null,
          observedRuntime: null, observedHarness: null, observedModel: null, observedReasoningEffort: null,
          observedRuntimeAt: null, observedRuntimeSource: null,
        } };
        await this.options.persistEndpoint(awaitingResume);
        // This is a supported routing hint, not a persisted runtime observation.
        return { endpoint: awaitingResume, resumeHarness: "claude" };
      }
      return { endpoint: quarantined };
    }
    await this.options.persistEndpoint(observed);
    return { endpoint: observed };
  }

  private async observedEndpoint(endpoint: AgentEndpoint): Promise<AgentEndpoint | null> {
    const observe = this.options.observeLocalEndpointSession;
    if (!observe) return null;
    let observation: LocalEndpointSessionObservation | null;
    try {
      observation = await observe(endpoint);
    } catch {
      observation = null;
    }
    if (!observation) return null;
    return promoteLocalEndpointProviderSession(endpoint, {
      metadata: sessionObservationMetadata(endpoint, observation),
    });
  }

  private async endpointIsAlive(endpoint: AgentEndpoint): Promise<boolean> {
    return this.options.isLocalAgentEndpointAliveAsync
      ? await this.options.isLocalAgentEndpointAliveAsync(endpoint)
      : this.options.isLocalAgentEndpointAlive(endpoint);
  }

  async prepareLocalEndpointForInvocation(endpoint: AgentEndpoint): Promise<AgentEndpoint> {
    if (
      endpoint.metadata?.sessionBacked !== true
      || (
        endpoint.transport !== "codex_app_server"
        && endpoint.transport !== "claude_stream_json"
        && endpoint.transport !== "pi_rpc"
      )
      || (
        endpoint.metadata?.pendingExternalSession !== true
        && localEndpointProviderSessionId(endpoint)
      )
    ) {
      return endpoint;
    }

    const sessionResult = await this.options.ensureLocalSessionEndpointOnline(endpoint);
    const preparedEndpoint = promoteLocalEndpointProviderSession(endpoint, sessionResult);
    // Persist immediately after the provider responds. The following turn may
    // remain active for minutes, but observe/trace consumers can resolve the
    // concrete harness session as soon as the running flight is acknowledged.
    await this.options.persistEndpoint(preparedEndpoint);
    return preparedEndpoint;
  }

  private async reviveExactSessionEndpoint(endpoint: AgentEndpoint): Promise<AgentEndpoint | null> {
    if (!isDirectLocalAgentTransport(endpoint.transport)) {
      return null;
    }

    const sessionResult = await this.options.ensureLocalSessionEndpointOnline(endpoint);
    const preparedEndpoint = promoteLocalEndpointProviderSession({
      ...endpoint,
      metadata: clearEndpointFailureMetadata(endpoint.metadata),
    }, sessionResult);
    const revivedEndpoint: AgentEndpoint = {
      ...preparedEndpoint,
      state: "idle",
      metadata: {
        ...(preparedEndpoint.metadata ?? {}),
        lastResumedAt: this.now(),
      },
    };
    await this.options.persistEndpoint(revivedEndpoint);
    return revivedEndpoint;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async activeLocalEndpointForInvocation(
    agentId: string,
    harness?: AgentEndpoint["harness"],
    targetSessionId?: string,
    options: { includeWakeable?: boolean } = {},
  ): Promise<AgentEndpoint | undefined> {
    const candidates = this.options.runtime.endpointsForAgent(agentId, {
      nodeId: this.options.nodeId,
      harness,
    }).filter((endpoint) => {
      if (endpoint.metadata?.staleLocalRegistration === true) {
        return false;
      }
      return targetSessionId ? endpointMatchesTargetSession(endpoint, targetSessionId) : true;
    });
    const orderedCandidates = targetSessionId
      ? candidates
      : [...candidates].sort(compareLocalEndpointPreference);

    for (const endpoint of orderedCandidates) {
      if (this.endpointIsLocallyUsableFromSnapshot(endpoint, options)) {
        return endpoint;
      }
      const alive = this.options.isLocalAgentEndpointAliveAsync
        ? await this.options.isLocalAgentEndpointAliveAsync(endpoint)
        : this.options.isLocalAgentEndpointAlive(endpoint);
      if (alive) {
        return endpoint;
      }
    }
    return undefined;
  }

  private endpointIsLocallyUsableFromSnapshot(
    endpoint: AgentEndpoint,
    options: { includeWakeable?: boolean } = {},
  ): boolean {
    if (isA2AHttpEndpoint(endpoint)) {
      return true;
    }
    if (endpoint.transport === "pairing_bridge") {
      return endpoint.state !== "offline";
    }
    if (options.includeWakeable && isWakeableSessionBackedEndpoint(endpoint)) {
      return true;
    }
    return this.options.isLocalAgentEndpointAlive(endpoint);
  }
}

function invocationHasExplicitRuntime(invocation: InvocationRequest): boolean {
  // On an exact session, harness narrows endpoint lookup; it is not a model observation requirement.
  return Boolean(
    (invocation.execution?.harness?.trim() && !invocationTargetSessionId(invocation))
    || invocation.execution?.model?.trim()
    || invocation.execution?.reasoningEffort?.trim()
    || invocation.execution?.placement,
  );
}

function endpointPlacement(endpoint: AgentEndpoint): SessionPlacement {
  if (endpoint.metadata?.placement === "attached") return "attached";
  if (endpoint.metadata?.placement === "foreground") return "foreground";
  if (endpoint.metadata?.placement === "background") return "background";
  return endpoint.transport === "codex_app_server" ? "foreground" : "background";
}

function assertEndpointPlacementMatches(endpoint: AgentEndpoint, invocation: InvocationRequest): void {
  const requested = invocation.execution?.placement;
  if (!requested) return;
  const actual = endpointPlacement(endpoint);
  if (requested !== actual) {
    throw new Error(
      `session_placement_conflict: session ${endpoint.sessionId ?? endpoint.id} is ${actual}; `
      + `request ${requested} with a new session instead`,
    );
  }
}

type ObservedRuntime = {
  harness?: string;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string;
};

export function observedRuntimeForEndpoint(endpoint: AgentEndpoint): ObservedRuntime {
  const metadata = endpoint.metadata ?? {};
  const nested = metadata.observedRuntime;
  const observed = nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : {};
  const stringValue = (value: unknown): string | undefined => (
    typeof value === "string" && value.trim() ? value.trim() : undefined
  );
  return {
    harness: stringValue(observed.harness) ?? stringValue(metadata.observedHarness),
    model: stringValue(observed.model) ?? stringValue(metadata.observedModel),
    modelProvider: stringValue(observed.modelProvider),
    reasoningEffort: stringValue(observed.reasoningEffort)
      ?? stringValue(metadata.observedReasoningEffort),
  };
}

/** Pi accepts both native IDs and provider/native-ID selectors. Provider is
 * observed separately; never infer it from launch arguments or split native IDs. */
export function observedModelForExpected(observed: ObservedRuntime, expected?: string | null): string | undefined {
  if (observed.harness?.toLowerCase() !== "pi" || !observed.model || !observed.modelProvider
    || observed.model.toLowerCase() === expected?.toLowerCase()) return observed.model;
  return `${observed.modelProvider}/${observed.model}`;
}

function assertEndpointObservedRuntimeMatches(
  endpoint: AgentEndpoint,
  invocation: InvocationRequest,
  now: number,
  resumeHarness?: string,
): void {
  const observed = observedRuntimeForEndpoint(endpoint);
  const provisioned = provisionedRuntimeForPendingEndpoint(endpoint, now);
  const requested: ObservedRuntime = {
    harness: invocation.execution?.harness?.trim(),
    model: invocation.execution?.model?.trim(),
    reasoningEffort: invocation.execution?.reasoningEffort?.trim(),
  };
  for (const dimension of ["harness", "model", "reasoningEffort"] as const) {
    const expected = requested[dimension];
    if (!expected) continue;
    const actual = (dimension === "model" ? observedModelForExpected(observed, expected) : observed[dimension])
      ?? (dimension === "harness" ? resumeHarness : undefined);
    if (!actual) {
      const pendingActual = provisioned?.[dimension];
      if (pendingActual) {
        if (pendingActual.toLowerCase() !== expected.toLowerCase()) {
          throw new Error(
            `session_runtime_mismatch: pending session ${endpoint.sessionId ?? endpoint.id} was provisioned with ${dimension} "${pendingActual}", `
              + `but the request requires "${expected}"; omit the session selector to spawn a fresh isolated session`,
          );
        }
        continue;
      }
      throw new Error(
        `session_runtime_unobserved: session ${endpoint.sessionId ?? endpoint.id} has no observed ${dimension}; `
          + "exact runtime requests require a fresh session or an observed match",
      );
    }
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(
        `session_runtime_mismatch: session ${endpoint.sessionId ?? endpoint.id} observed ${dimension} "${actual}", `
          + `but the request requires "${expected}"; omit the session selector to spawn a fresh isolated session`,
      );
    }
  }
}

/** States in which a tmux/host-backed session can still take a steer. */
function isCorrelatableEndpointState(state: AgentEndpoint["state"]): boolean {
  return state === "idle"
    || state === "active"
    || state === "waiting"
    || state === "working"
    || state === "attaching"
    || state === "waking";
}

/**
 * A Scout-owned session has to receive its first invocation before the harness
 * can report observed runtime metadata. During that narrow pending-launch
 * window, the broker may trust the exact configuration it just provisioned.
 * Once the provider attaches (or for any externally sourced endpoint), only
 * observed runtime is authoritative.
 */
export const PENDING_PROVISIONED_RUNTIME_TRUST_MS = 2 * 60_000;

/**
 * What Scout launched this endpoint with, read off the endpoint itself. A
 * promise about a process, not an observation of one — the caller decides
 * whether it has earned the right to be trusted.
 */
export function provisionedRuntimeForScoutOwnedEndpoint(
  endpoint: AgentEndpoint,
): ObservedRuntime | undefined {
  const metadata = endpoint.metadata ?? {};
  if (
    metadata.sessionBacked !== true
    || (metadata.source !== "scout-cardless-session" && metadata.source !== "scout-isolated-agent-session")
  ) {
    return undefined;
  }

  const stringValue = (value: unknown): string | undefined => (
    typeof value === "string" && value.trim() ? value.trim() : undefined
  );
  const resolution = metadata.executionResolution;
  const resolutionRecord = resolution && typeof resolution === "object" && !Array.isArray(resolution)
    ? resolution as Record<string, unknown>
    : {};
  const resolvedDimension = (dimension: keyof ObservedRuntime): string | undefined => {
    const value = resolutionRecord[dimension];
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return stringValue((value as Record<string, unknown>).resolved);
  };

  return {
    harness: stringValue(endpoint.harness) ?? resolvedDimension("harness"),
    model: stringValue(metadata.model) ?? resolvedDimension("model"),
    reasoningEffort: stringValue(metadata.reasoningEffort) ?? resolvedDimension("reasoningEffort"),
  };
}

function provisionedRuntimeForPendingEndpoint(
  endpoint: AgentEndpoint,
  now: number,
): ObservedRuntime | undefined {
  const metadata = endpoint.metadata ?? {};
  if (metadata.pendingExternalSession !== true) {
    return undefined;
  }

  const pendingAt = metadataTimestamp(
    metadata.pendingExternalSessionAt ?? metadata.startedAt,
  );
  if (
    !pendingAt
    || pendingAt > now + 30_000
    || now - pendingAt >= PENDING_PROVISIONED_RUNTIME_TRUST_MS
  ) {
    return undefined;
  }

  return provisionedRuntimeForScoutOwnedEndpoint(endpoint);
}

function metadataTimestamp(value: unknown): number | undefined {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function isWakeableSessionBackedEndpoint(endpoint: AgentEndpoint): boolean {
  return endpoint.metadata?.sessionBacked === true
    && endpoint.state !== "offline"
    && isBrokerRunnableLocalAgentTransport(endpoint.transport);
}
