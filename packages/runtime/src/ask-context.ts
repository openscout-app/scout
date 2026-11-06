import { randomBytes } from "node:crypto";
import {
  AGENT_HARNESSES,
  flightSessionTrace,
  type AgentHarness,
  parseScoutSessionHostAddress,
  type AgentEndpoint,
  type AskOrigin,
  type AskTrace,
  type InvocationRequest,
  type TracedInvocationRequest,
} from "@openscout/protocol";
import type { RuntimeRegistrySnapshot } from "./registry.js";
import { endpointMatchesTargetSessionAddress, runtimeSessionAddressForEndpoint } from "./runtime-session-address.js";

function nonzeroHex(value: unknown, length: number): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value) && !/^0+$/.test(value);
}

export function assertAskTrace(trace: AskTrace | undefined): asserts trace is AskTrace {
  if (!trace || !nonzeroHex(trace.traceId, 32) || !nonzeroHex(trace.spanId, 16)
    || (trace.parentSpanId !== undefined && !nonzeroHex(trace.parentSpanId, 16))) {
    throw new Error("invalid_ask_trace: expected nonzero lowercase W3C trace and span identifiers");
  }
}

/** W3C Trace Context: reject version ff, zero ids and malformed version 00. */
export function parseAskTraceparent(value: unknown): Pick<AskTrace, "traceId" | "parentSpanId"> | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/.exec(value);
  if (!match || match[1] === "ff" || (match[1] === "00" && match[5])
    || !nonzeroHex(match[2], 32) || !nonzeroHex(match[3], 16)) return undefined;
  return { traceId: match[2], parentSpanId: match[3] };
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sessionOrigin(invocation: InvocationRequest, snapshot: RuntimeRegistrySnapshot, localNodeId?: string, observedEndpointId?: string): AskOrigin {
  // A return transport can be shared by many callers. It is never origin evidence.
  const claimed = string(invocation.metadata?.replyToSessionId) || string(invocation.origin?.sessionAddress);
  const endpoints = Object.values(snapshot.endpoints).filter(endpoint => !localNodeId || endpoint.nodeId === localNodeId);
  let source: AskOrigin["source"];
  let candidates: AgentEndpoint[];
  const observed = observedEndpointId ? snapshot.endpoints[observedEndpointId] : undefined;
  if (observed && (!localNodeId || observed.nodeId === localNodeId) && observed.harness !== "bridge") {
    source = "verified";
    candidates = [observed];
  } else if (claimed) {
    source = "claimed";
    candidates = endpoints.filter(endpoint => endpointMatchesTargetSessionAddress(snapshot, endpoint, claimed));
    if (candidates.length && candidates.every(endpoint => endpoint.harness === "bridge" && endpoint.metadata?.externalSession !== true)) {
      return { source: "unknown" };
    }
  } else {
    // Actor/home endpoints do not prove which conversation issued a command.
    return { source: "unknown" };
  }
  const addresses = new Set(candidates.map(endpoint => runtimeSessionAddressForEndpoint(snapshot, endpoint)).filter(Boolean));
  const harness = string(invocation.metadata?.replyToSessionHarness);
  // A native id plus its caller-asserted harness has a deterministic address,
  // even before discovery has observed that conversation. It remains claimed.
  const claimedAddress = claimed && harness && localNodeId && AGENT_HARNESSES.includes(harness as AgentHarness)
    ? runtimeSessionAddressForEndpoint(snapshot, { nodeId: localNodeId, harness: harness as AgentHarness,
        sessionId: claimed, metadata: {} } as AgentEndpoint) : undefined;
  const sessionAddress = addresses.size === 1 ? [...addresses][0]!
    : claimed && parseScoutSessionHostAddress(claimed) ? claimed : addresses.size === 0 ? claimedAddress : undefined;
  if (!sessionAddress) return claimed ? { source: "claimed" } : { source: "unknown" };
  // No "latest" guess: concurrent active flights on one session are ambiguous.
  const active = Object.values(snapshot.flights).filter(flight => {
    if (flight.state !== "running" && flight.state !== "waiting") return false;
    const session = flightSessionTrace(flight).at(-1);
    return session && session.endedAt === undefined
      && candidates.some(endpoint => endpointMatchesTargetSessionAddress(snapshot, endpoint, session.sessionId)
        && runtimeSessionAddressForEndpoint(snapshot, endpoint) === sessionAddress);
  });
  return { sessionAddress, source, ...(active.length === 1 ? { runningFlightId: active[0]!.id } : {}) };
}

/** Called only at creation, under the durable writer; never from a read/replay path. */
export function stampAskContext(
  invocation: InvocationRequest,
  snapshot: RuntimeRegistrySnapshot,
  localNodeId?: string,
  observedEndpointId?: string,
): asserts invocation is TracedInvocationRequest {
  const origin = sessionOrigin(invocation, snapshot, localNodeId, observedEndpointId);
  const running = origin.runningFlightId ? snapshot.flights[origin.runningFlightId] : undefined;
  const parentTrace = running ? snapshot.invocations[running.invocationId]?.trace : undefined;
  // Legacy flights have no trace to inherit. Do not reconstruct their history.
  const parent = running ? parentTrace && { traceId: parentTrace.traceId, parentSpanId: parentTrace.spanId }
    : parseAskTraceparent(invocation.traceparent);
  invocation.origin = origin;
  invocation.trace = { traceId: parent?.traceId ?? randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"), ...(parent?.parentSpanId ? { parentSpanId: parent.parentSpanId } : {}) };
  delete invocation.traceparent;
  assertAskTrace(invocation.trace);
}

/** Trusted mesh forwarding preserves creation-time context, not a new parent edge. */
export function stampForwardedAskContext(invocation: InvocationRequest): asserts invocation is TracedInvocationRequest {
  if (!invocation.trace) {
    // An older peer cannot supply creation-time context; start only this new local flight.
    invocation.trace = { traceId: randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex") };
  }
  assertAskTrace(invocation.trace);
  invocation.origin ??= { source: "unknown" };
  delete invocation.traceparent;
}
