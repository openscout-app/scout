import {
  recordFlightSessionDispatch,
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
  latestEndpointForAgent,
} from "./broker-endpoint-selection.js";

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
  if (!endpointId || endpointId !== flightDispatchEndpointId(right)) return false;
  const leftAck = left.metadata!.dispatchAck as Record<string, unknown>;
  const rightAck = right.metadata!.dispatchAck as Record<string, unknown>;
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

export function staleWorkingFlightReason(
  snapshot: RuntimeSnapshot,
  flight: FlightRecord,
  options: {
    isInvocationActive: (invocationId: string) => boolean;
    now?: number;
  },
): string | null {
  if (!isWorkingFlightState(flight.state)) {
    return null;
  }
  if (options.isInvocationActive(flight.invocationId)) {
    return null;
  }
  const dispatchOutcome = flight.metadata?.dispatchOutcome;
  if (dispatchOutcome && typeof dispatchOutcome === "object"
    && (dispatchOutcome as Record<string, unknown>).status === "submission_unknown") {
    return null;
  }

  const startedAt = flightTimestamp(flight);
  const newerTerminalFlight = Object.values(snapshot.flights)
    .filter((candidate) => (
      candidate.targetAgentId === flight.targetAgentId
      && candidate.id !== flight.id
      && flightsShareExecutionOwner(flight, candidate)
      && !isWorkingFlightState(candidate.state)
      && flightTimestamp(candidate) > startedAt
    ))
    .sort((left, right) => flightTimestamp(right) - flightTimestamp(left))[0] ?? null;
  if (newerTerminalFlight) {
    return `superseded by newer ${newerTerminalFlight.state} flight ${newerTerminalFlight.id}`;
  }

  const agent = snapshot.agents[flight.targetAgentId];
  if (isRetiredLocalAgent(agent)) {
    return `target agent ${flight.targetAgentId} was retired from the fleet`;
  }
  if (agent?.metadata?.staleLocalRegistration === true) {
    return staleLocalEndpointReason(latestEndpointForAgent(snapshot, flight.targetAgentId))
      ?? `target agent ${flight.targetAgentId} is a superseded local registration replaced by current setup`;
  }

  const dispatchEndpointReason = flightDispatchEndpointUnavailableReason(snapshot, flight);
  if (dispatchEndpointReason) {
    return dispatchEndpointReason;
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
      return `target agent ${flight.targetAgentId} has no registered endpoint after ${Math.floor(ageMs / 1000)}s`;
    }
    return null;
  }

  const staleEndpointReason = staleLocalEndpointReason(endpoint);
  if (staleEndpointReason) {
    return staleEndpointReason;
  }

  const terminalAt = endpointTerminalAt(endpoint);
  if (endpoint.state !== "active" && terminalAt > startedAt) {
    return `endpoint ${endpoint.id} moved to ${endpoint.state} at ${terminalAt}`;
  }

  const startedEndpointAt = endpointStartedAt(endpoint);
  const endpointInvocationId = endpointLastInvocationId(endpoint);
  if (
    endpoint.state === "active"
    && endpointInvocationId === flight.invocationId
    && !options.isInvocationActive(flight.invocationId)
    && startedEndpointAt >= startedAt
  ) {
    // A requester timeout ends the broker task on purpose while the agent keeps
    // working. Its reply still completes the flight when it arrives, so an
    // active endpoint is not evidence of a lost task. Offline, stale and
    // superseded endpoints are still caught by the checks around this one.
    if (flight.metadata?.requesterTimedOut === true) {
      return null;
    }
    return `endpoint ${endpoint.id} was replayed active for invocation ${flight.invocationId} without a live broker task`;
  }
  if (
    endpoint.state === "active"
    && startedEndpointAt > startedAt
    && endpointInvocationId !== null
    && endpointInvocationId !== flight.invocationId
  ) {
    return `endpoint ${endpoint.id} started newer work at ${startedEndpointAt}`;
  }

  return null;
}
