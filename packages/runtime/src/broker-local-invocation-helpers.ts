import {
  flightCompletion,
  recordFlightSessionDispatch,
  type FailedRunCause,
  type AgentDefinition,
  type AgentEndpoint,
  type FlightRecord,
  type InvocationRequest,
  type InvocationStatus,
  type MetadataMap,
} from "@openscout/protocol";

import type { RuntimeSnapshot } from "./scout-dispatcher.js";
import {
  endpointStartedAt,
  endpointTerminalAt,
  isRetiredLocalAgent,
  isStaleLocalEndpoint,
  latestEndpointForAgent,
} from "./broker-endpoint-selection.js";
import { isResumableInPlaceFlight } from "./in-place/checkpoint.js";
import { isDirectLocalAgentTransport } from "./local-agent-transports.js";

export {
  ENDPOINT_SESSION_ALIAS_METADATA_KEYS,
  compareLocalEndpointPreference,
  endpointAvailabilityScore,
  endpointCandidateState,
  endpointLifecycleAt,
  endpointMatchesTargetSession,
  endpointSessionAliasValues,
  endpointStartedAt,
  endpointTerminalAt,
  homeEndpointForAgent,
  isEndpointOnlineState,
  isInactiveLocalAgent,
  isRetiredLocalAgent,
  isStaleLocalEndpoint,
  latestEndpointForAgent,
  localEndpointPreferenceRank,
} from "./broker-endpoint-selection.js";

function metadataStringValue(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export type InvocationReplyMode = "inline" | "notify" | "none";

export function invocationReplyMode(
  invocation: InvocationRequest,
): InvocationReplyMode | null {
  const value = metadataStringValue(invocation.metadata, "replyMode");
  return value === "inline" || value === "notify" || value === "none"
    ? value
    : null;
}

/**
 * Older invocation producers did not declare a reply mode and expected the
 * broker to notify the requester, so absence intentionally preserves that
 * behavior. Inline and none callers observe the durable flight/conversation
 * directly and must not create a second delivery attempt.
 */
export function shouldNotifyInvocationRequester(
  invocation: InvocationRequest,
): boolean {
  const replyMode = invocationReplyMode(invocation);
  return replyMode === null || replyMode === "notify";
}

/**
 * A status transition for an invocation's flight. Keys present in the patch
 * override the current record — including keys explicitly set to `undefined`
 * (e.g. `error: undefined` clears a prior error on re-entry to `running`).
 * `metadata` is merged key-wise into the current metadata rather than
 * replacing it; `flightId` is excluded because a transition never re-points
 * the invocation at a different flight.
 */
export type InvocationStatusPatch = Omit<InvocationStatus, "flightId"> & {
  metadata?: MetadataMap;
};

export function applyInvocationStatusPatch(
  current: FlightRecord,
  patch: InvocationStatusPatch,
): FlightRecord {
  // A late attempt or reconciliation must not reopen or replace terminal
  // truth. An explicit retry needs its own nonterminal flight first.
  if (isTerminalFlightState(current.state) && patch.state && patch.state !== current.state) {
    return current;
  }
  const { metadata, ...status } = patch;
  let nextMetadata = "metadata" in patch
    ? { ...(current.metadata ?? {}), ...(metadata ?? {}) }
    : current.metadata;
  if (metadata && Object.prototype.hasOwnProperty.call(metadata, "dispatchAck")) {
    const { dispatchAck, sessionTrace: _ignoredSessionTrace, ...metadataPatch } = metadata;
    nextMetadata = {
      ...recordFlightSessionDispatch(current.metadata, dispatchAck),
      ...metadataPatch,
    };
  }
  return {
    ...current,
    ...status,
    state: status.state ?? current.state,
    ...("metadata" in patch ? { metadata: nextMetadata } : {}),
  };
}

// Metadata keys that describe a single execution attempt's failure or timeout.
// Cleared on re-entry to `running` so a fresh attempt does not carry a prior
// attempt's failure detail into its own success record (an explicit undefined
// value overrides in the key-wise metadata merge and is dropped by the durable
// JSON serialization).
const TRANSIENT_STATUS_METADATA_KEYS = [
  "dispatchOutcome",
  "heldThreadId",
  "failureStage",
  "failureSeverity",
  "noteworthy",
  "dispatchStalledSession",
  "dispatchStalledRetries",
  "dispatchStalledPaneTail",
  "exitKind",
  "exitSignal",
  "exitCode",
  "shutdownReason",
  "requesterTimedOut",
  "timeoutMs",
  "timeoutScope",
] as const;

export function clearedTransientStatusMetadata(): Record<string, undefined> {
  return Object.fromEntries(
    TRANSIENT_STATUS_METADATA_KEYS.map((key) => [key, undefined]),
  ) as Record<string, undefined>;
}

export function isWorkingFlightState(state: FlightRecord["state"]): boolean {
  return state === "queued" || state === "waking" || state === "running" || state === "waiting";
}

export const STALE_WORKING_FLIGHT_NO_ENDPOINT_GRACE_MS = 2 * 60_000;

/**
 * The finished flight that took over this open one's invocation. An ask that
 * starts its target elsewhere (another host, a fresh session) records a
 * placeholder flight first and then the flight that carries the work. The
 * placeholder has no dispatch of its own, so nothing closes it when the work
 * ends. A placeholder is known by its missing dispatch, so a twin that started
 * on another host's clock still closes it. Any other open flight closes only
 * for a later attempt: a late result from an older attempt never closes a
 * newer one that is still running.
 */
export function supersedingTwinFlight(
  snapshot: Pick<RuntimeSnapshot, "flights">,
  flight: FlightRecord,
): FlightRecord | null {
  if (!isWorkingFlightState(flight.state)) return null;
  const startedAt = flight.startedAt ?? 0;
  const placeholder = isUndispatchedFlight(flight);
  let twin: FlightRecord | null = null;
  for (const candidate of Object.values(snapshot.flights)) {
    if (candidate.id === flight.id
      || candidate.invocationId !== flight.invocationId
      || candidate.targetAgentId !== flight.targetAgentId
      || !isTerminalFlightState(candidate.state)
      || (!placeholder && (candidate.startedAt ?? 0) < startedAt)) continue;
    if (!twin || flightTimestamp(candidate) > flightTimestamp(twin)) twin = candidate;
  }
  return twin;
}

/** A flight that never reached a target: no dispatch acknowledgement and no submission. */
function isUndispatchedFlight(flight: FlightRecord): boolean {
  if (flight.metadata?.dispatchAck !== undefined) return false;
  const outcome = flight.metadata?.dispatchOutcome as { status?: unknown } | undefined;
  return outcome?.status === "not_submitted";
}

/** The open flight, closed with the outcome its twin already reported. */
export function closedAsSupersededTwin(flight: FlightRecord, twin: FlightRecord, now: number): FlightRecord {
  const reason = `superseded by ${twin.state} flight ${twin.id} for the same invocation`;
  return {
    ...flight,
    state: twin.state,
    summary: twin.summary ?? flight.summary,
    output: twin.output,
    error: twin.error,
    completedAt: twin.completedAt ?? now,
    metadata: {
      ...(flight.metadata ?? {}),
      supersededByFlightId: twin.id,
      reconciledStaleFlight: true,
      reconciledReason: reason,
      reconciledAt: now,
    },
  };
}

/**
 * A flight closed as its twin's copy. The twin owns the outcome: its report,
 * work item, callback and forwarding already ran, so the copy runs none again.
 */
export function isSupersededTwinCopy(snapshot: Pick<RuntimeSnapshot, "flights">, flight: FlightRecord): boolean {
  const twinId = flight.metadata?.supersededByFlightId;
  if (typeof twinId !== "string" || twinId === flight.id) return false;
  const twin = snapshot.flights[twinId];
  return Boolean(twin && twin.invocationId === flight.invocationId
    && twin.targetAgentId === flight.targetAgentId
    && isTerminalFlightState(twin.state) && twin.state === flight.state);
}

export function isTerminalFlightState(state: FlightRecord["state"]): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

export function flightTimestamp(flight: FlightRecord): number {
  return flight.completedAt ?? flight.startedAt ?? 0;
}

export function endpointLastInvocationId(endpoint: AgentEndpoint): string | null {
  const value = endpoint.metadata?.lastInvocationId;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function staleLocalEndpointReason(endpoint: AgentEndpoint | null): string | null {
  if (!endpoint || endpoint.metadata?.staleLocalRegistration !== true) {
    return null;
  }

  const replacementAgentId = endpoint.metadata.replacedByAgentId;
  const replacement = typeof replacementAgentId === "string" && replacementAgentId.trim().length > 0
    ? `; replacement agent is ${replacementAgentId.trim()}`
    : "";
  return `endpoint ${endpoint.id} is a superseded local registration replaced by current setup${replacement}`;
}

export function staleLocalAgentReason(
  snapshot: RuntimeSnapshot,
  agent: AgentDefinition,
): string | null {
  const endpoints = Object.values(snapshot.endpoints).filter((endpoint) => endpoint.agentId === agent.id);
  const staleEndpointReasons = endpoints
    .map((endpoint) => staleLocalEndpointReason(endpoint))
    .filter((reason): reason is string => Boolean(reason));
  if (endpoints.length > 0 && staleEndpointReasons.length === endpoints.length) {
    return staleLocalEndpointReason(latestEndpointForAgent(snapshot, agent.id)) ?? staleEndpointReasons[0] ?? null;
  }

  if (agent.metadata?.staleLocalRegistration !== true) {
    return null;
  }

  const endpointReason = staleLocalEndpointReason(latestEndpointForAgent(snapshot, agent.id));
  if (endpointReason) {
    return endpointReason;
  }

  const replacementAgentId = metadataStringValue(agent.metadata, "replacedByAgentId");
  const replacement = replacementAgentId
    ? `; replacement agent is ${replacementAgentId}`
    : "";
  return `agent ${agent.id} is a superseded local registration replaced by current setup${replacement}`;
}

export function flightDispatchEndpointId(flight: FlightRecord): string | null {
  const dispatchAck = flight.metadata?.dispatchAck;
  if (!dispatchAck || typeof dispatchAck !== "object" || Array.isArray(dispatchAck)) {
    return null;
  }

  const endpointId = (dispatchAck as Record<string, unknown>).endpointId;
  return typeof endpointId === "string" && endpointId.trim().length > 0
    ? endpointId.trim()
    : null;
}

export function endpointForFlight(snapshot: RuntimeSnapshot, flight: FlightRecord): AgentEndpoint | null {
  const dispatchedEndpointId = flightDispatchEndpointId(flight);
  if (dispatchedEndpointId) {
    const endpoint = snapshot.endpoints[dispatchedEndpointId];
    if (endpoint?.agentId === flight.targetAgentId) {
      return endpoint;
    }
    return null;
  }

  // Agent identity can own many isolated sessions. Without dispatch evidence,
  // its latest endpoint is not evidence about this flight's execution owner.
  return null;
}

function flightsShareExecutionOwner(left: FlightRecord, right: FlightRecord): boolean {
  const endpointId = flightDispatchEndpointId(left);
  const rightEndpointId = flightDispatchEndpointId(right);
  if (!endpointId || !rightEndpointId) return false;
  const leftAck = left.metadata!.dispatchAck as Record<string, unknown>;
  const rightAck = right.metadata!.dispatchAck as Record<string, unknown>;
  if (endpointId !== rightEndpointId) {
    // One harness session can sit behind two endpoints when it is registered
    // under two agent ids. A tmux session still runs one turn at a time, so it
    // is one owner when every piece of its address matches.
    return (["sessionId", "nodeId", "harness", "transport"] as const).every((key) => {
      const value = metadataStringValue(leftAck, key);
      return value !== null && value === metadataStringValue(rightAck, key);
    });
  }
  for (const key of ["nodeId", "harness"] as const) {
    if (leftAck[key] && rightAck[key] && leftAck[key] !== rightAck[key]) return false;
  }
  const leftSession = metadataStringValue(leftAck, "sessionId");
  const rightSession = metadataStringValue(rightAck, "sessionId");
  // Provider identity can refine the same pending endpoint's routing identity.
  // A different, unlinked session on a reused endpoint is a different owner.
  return !leftSession || !rightSession || leftSession === rightSession
    || leftAck.refinesSessionId === rightSession || rightAck.refinesSessionId === leftSession;
}

export function flightDispatchEndpointUnavailableReason(
  snapshot: RuntimeSnapshot,
  flight: FlightRecord,
): string | null {
  const dispatchedEndpointId = flightDispatchEndpointId(flight);
  if (!dispatchedEndpointId) {
    return null;
  }

  const endpoint = snapshot.endpoints[dispatchedEndpointId];
  if (!endpoint) {
    return `dispatched endpoint ${dispatchedEndpointId} is no longer registered`;
  }
  if (endpoint.agentId !== flight.targetAgentId) {
    return `dispatched endpoint ${dispatchedEndpointId} no longer belongs to target agent ${flight.targetAgentId}`;
  }
  return null;
}

export function isReconciledStaleFlightActivityItem(item: {
  kind: string;
  summary?: string | null;
}): boolean {
  return item.kind === "flight_updated"
    && typeof item.summary === "string"
    && item.summary.startsWith("Stale running flight reconciled:");
}

export function invocationTargetSessionId(invocation: InvocationRequest): string | undefined {
  return invocation.execution?.targetSessionId?.trim()
    || metadataStringValue(invocation.metadata, "targetSessionId")
    || undefined;
}

export function dispatchAckStrategyForEndpoint(input: {
  invocation: InvocationRequest;
  endpoint: AgentEndpoint;
  previousEndpoint?: AgentEndpoint;
  now?: number;
}): string {
  if (input.invocation.execution?.session === "existing") {
    return "steer";
  }
  if (input.previousEndpoint?.id === input.endpoint.id) {
    return "attach";
  }
  const lastResumedAt = Number(input.endpoint.metadata?.lastResumedAt);
  const now = input.now ?? Date.now();
  if (Number.isFinite(lastResumedAt) && now - lastResumedAt < 10_000) {
    return "wake";
  }
  if (input.invocation.ensureAwake) {
    return "spawn";
  }
  return "queued";
}

/**
 * How long a flight may wait for its task reply after the session's turn ended
 * with no sign of a new turn. A session that keeps working (background jobs that
 * wake it, a new turn) restarts the clock.
 */
export const AWAITING_FINAL_REPLY_IDLE_MS = 30 * 60_000;

const ENDED_ENDPOINT_STATES = new Set(["offline", "failed", "superseded", "stopped"]);

/** When the session last ended a turn without the task reply. */
export function awaitingFinalReplySince(flight: FlightRecord): number {
  const since = flight.metadata?.awaitingFinalSince;
  return typeof since === "number" && Number.isFinite(since) ? since : flightTimestamp(flight);
}

/**
 * Why a flight that waits for an explicit task reply can no longer expect one,
 * or null while it still can. The broker treats such a flight as active, so the
 * general stale rules never reach it: this is its only exit.
 */
export function awaitingFinalReplyExitReason(
  snapshot: RuntimeSnapshot,
  flight: FlightRecord,
  now: number,
): string | null {
  if (flight.state !== "waiting" || flightCompletion(flight)?.awaitingFinal !== true) return null;
  const agent = snapshot.agents[flight.targetAgentId];
  if (isRetiredLocalAgent(agent)) {
    return `target agent ${flight.targetAgentId} was retired from the fleet before its task reply`;
  }
  if (agent?.metadata?.staleLocalRegistration === true) {
    return `target agent ${flight.targetAgentId} is a superseded local registration; no task reply can arrive`;
  }
  const completionEndpointId = snapshot.invocations[flight.invocationId]?.metadata?.completionEndpointId;
  const endpointId = flightDispatchEndpointId(flight)
    ?? (typeof completionEndpointId === "string" && completionEndpointId ? completionEndpointId : null);
  const endpoint = endpointId ? snapshot.endpoints[endpointId] : undefined;
  if (!endpoint || endpoint.agentId !== flight.targetAgentId) {
    return `the session for ${flight.targetAgentId} is gone; no task reply can arrive`;
  }
  if (isStaleLocalEndpoint(snapshot, endpoint) || ENDED_ENDPOINT_STATES.has(endpoint.state)) {
    return `endpoint ${endpoint.id} is ${endpoint.state}; no task reply can arrive`;
  }
  const since = Math.max(awaitingFinalReplySince(flight), endpointStartedAt(endpoint));
  const idleMs = now - since;
  if (idleMs >= AWAITING_FINAL_REPLY_IDLE_MS) {
    return `the session ended its turn without a task reply and stayed idle for ${Math.floor(idleMs / 60_000)} min`;
  }
  return null;
}

/** Reopening Scout's store does not establish what happened in Codex. */
export function interruptedCodexFlight(flight: FlightRecord, bootedAt?: number): FlightRecord | null {
  if (flight.state !== "running" || bootedAt === undefined
    || flightCompletion(flight)?.awaitingFinal === true || isResumableInPlaceFlight(flight)) return null;
  const outcome = flight.metadata?.dispatchOutcome as { status?: unknown; reason?: unknown; checkedAt?: unknown } | undefined;
  if (!isCodexSubmissionCheckpoint(outcome) || typeof outcome?.checkedAt !== "number" || outcome.checkedAt >= bootedAt) return null;
  const ack = flight.metadata?.dispatchAck as { sessionId?: unknown; nativeTurnId?: unknown } | undefined;
  const session = metadataStringValue(ack, "sessionId");
  const turn = metadataStringValue(ack, "nativeTurnId");
  const detail = turn
    ? `Codex acknowledged the submission for turn ${turn}, but Scout did not record its outcome.`
    : "Scout restarted without confirmation that Codex received the submission.";
  return {
    ...flight,
    state: "waiting",
    summary: `${detail} ${session ? `Inspect Codex session ${session}.` : "Inspect the original dispatch."}`,
    error: undefined,
    completedAt: undefined,
  };
}

function isCodexSubmissionCheckpoint(outcome: { status?: unknown; reason?: unknown } | undefined): boolean {
  return (outcome?.status === "submission_unknown" && outcome.reason === "codex_send_boundary")
    || (outcome?.status === "submitted" && outcome.reason === "codex_rpc_acknowledged");
}

export function staleWorkingFlightFailure(
  snapshot: RuntimeSnapshot,
  flight: FlightRecord,
  options: {
    isInvocationActive: (invocationId: string) => boolean;
    now?: number;
    /**
     * When this runtime process started. A runtime-owned child that began its
     * turn before then died with the previous process.
     */
    bootedAt?: number;
  },
): { cause: FailedRunCause; detail: string; supersededByFlightId?: string } | null {
  if (!isWorkingFlightState(flight.state)) {
    return null;
  }
  const awaitingExit = awaitingFinalReplyExitReason(snapshot, flight, options.now ?? Date.now());
  if (awaitingExit) {
    // The idle window is the one exit where the session itself is still there.
    const idle = awaitingExit.startsWith("the session ended its turn");
    return { cause: idle ? "unknown" : "endpoint_lost", detail: awaitingExit };
  }
  if (options.isInvocationActive(flight.invocationId)) {
    return null;
  }
  const dispatchOutcome = flight.metadata?.dispatchOutcome as { status?: unknown; reason?: unknown } | undefined;
  if (dispatchOutcome?.status === "submission_unknown"
    || (flight.state === "waiting" && isCodexSubmissionCheckpoint(dispatchOutcome))) {
    return null;
  }

  const startedAt = flightTimestamp(flight);
  const newerTerminalFlight = Object.values(snapshot.flights)
    .filter((candidate) => (
      candidate.id !== flight.id
      && flightsShareExecutionOwner(flight, candidate)
      && !isWorkingFlightState(candidate.state)
      // A flight this pass closed carries the time it was closed, not a finish:
      // an older turn reconciled late must not look newer than live work.
      && candidate.metadata?.reconciledStaleFlight !== true
      && flightTimestamp(candidate) > startedAt
    ))
    .sort((left, right) => flightTimestamp(right) - flightTimestamp(left))[0] ?? null;
  if (newerTerminalFlight) {
    return { cause: "superseded", detail: `superseded by newer ${newerTerminalFlight.state} flight ${newerTerminalFlight.id}`, supersededByFlightId: newerTerminalFlight.id };
  }

  const agent = snapshot.agents[flight.targetAgentId];
  if (isRetiredLocalAgent(agent)) {
    return { cause: "endpoint_lost", detail: `target agent ${flight.targetAgentId} was retired from the fleet` };
  }
  if (agent?.metadata?.staleLocalRegistration === true) {
    return { cause: "endpoint_lost", detail: staleLocalEndpointReason(latestEndpointForAgent(snapshot, flight.targetAgentId))
      ?? `target agent ${flight.targetAgentId} is a superseded local registration replaced by current setup` };
  }

  // A delivery into a session open in the operator's own place is picked up
  // by dispatch recovery. Its endpoint says nothing about it: the endpoint
  // sweep marks such an endpoint offline whenever Scout runs no copy of it.
  if (isResumableInPlaceFlight(flight)) {
    return null;
  }

  const dispatchEndpointReason = flightDispatchEndpointUnavailableReason(snapshot, flight);
  if (dispatchEndpointReason) {
    return { cause: "endpoint_lost", detail: dispatchEndpointReason };
  }

  const endpoint = endpointForFlight(snapshot, flight);
  if (!endpoint) {
    if (!flightDispatchEndpointId(flight)
      && Object.values(snapshot.endpoints).some((candidate) => candidate.agentId === flight.targetAgentId)) {
      return null;
    }
    const now = options.now ?? Date.now();
    const ageMs = now - startedAt;
    if (startedAt > 0 && ageMs >= STALE_WORKING_FLIGHT_NO_ENDPOINT_GRACE_MS) {
      return { cause: "endpoint_lost", detail: `target agent ${flight.targetAgentId} has no registered endpoint after ${Math.floor(ageMs / 1000)}s` };
    }
    return null;
  }

  const staleEndpointReason = staleLocalEndpointReason(endpoint);
  if (staleEndpointReason) {
    return { cause: "endpoint_lost", detail: staleEndpointReason };
  }

  const terminalAt = endpointTerminalAt(endpoint);
  if (endpoint.state !== "active" && terminalAt > startedAt) {
    return { cause: "endpoint_lost", detail: `endpoint ${endpoint.id} moved to ${endpoint.state} at ${terminalAt}` };
  }

  const startedEndpointAt = endpointStartedAt(endpoint);
  const endpointInvocationId = endpointLastInvocationId(endpoint);
  // A broker task is process-local. For a worker that outlives the runtime
  // (a tmux or attached terminal session), its absence after restart says
  // nothing about the agent's execution: leave the work open for its durable
  // reply, and do not redispatch it, because submission may already have
  // happened. A direct transport (app server, stream-json, RPC, ACP) runs as a
  // child of the runtime and dies with it, so its reply can no longer arrive.
  if (
    isDirectLocalAgentTransport(endpoint.transport)
    && endpoint.state === "active"
    && endpointInvocationId === flight.invocationId
    && !options.isInvocationActive(flight.invocationId)
    && startedEndpointAt >= startedAt
  ) {
    // A requester timeout ends the broker task on purpose while the agent keeps
    // working. Its reply still completes the flight when it arrives, but only
    // while the child that runs the turn is alive: a turn that started before
    // this process booted ran in a child of the previous one.
    const turnPredatesBoot = options.bootedAt !== undefined && startedEndpointAt < options.bootedAt;
    if (flight.metadata?.requesterTimedOut === true && !turnPredatesBoot) {
      return null;
    }
    return { cause: "endpoint_lost", detail: `endpoint ${endpoint.id} was replayed active for invocation ${flight.invocationId} without a live broker task` };
  }
  // Positive offline, stale or superseded endpoint evidence still reconciles
  // every transport normally.
  if (
    endpoint.state === "active"
    && startedEndpointAt > startedAt
    && endpointInvocationId !== null
    && endpointInvocationId !== flight.invocationId
  ) {
    return { cause: "endpoint_lost", detail: `endpoint ${endpoint.id} started newer work at ${startedEndpointAt}` };
  }

  return null;
}

/** Compatibility text view; failure writers use the structured decision. */
export function staleWorkingFlightReason(...args: Parameters<typeof staleWorkingFlightFailure>): string | null {
  return staleWorkingFlightFailure(...args)?.detail ?? null;
}
