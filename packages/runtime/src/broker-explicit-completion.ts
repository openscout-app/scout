import { endpointMatchesTargetSessionAddress } from "./runtime-session-address.js";
import { completionReply, flightCompletion, flightSessionTrace, hasExplicitCompletion,
  SCOUT_COMPLETION_MAX_OBLIGATIONS, type FlightRecord, type InvocationRequest, type MessageRecord,
  type ScoutCompletionRelation } from "@openscout/protocol";
import type { RuntimeRegistrySnapshot } from "./registry.js";

const terminal = (flight: FlightRecord) => ["completed", "failed", "cancelled"].includes(flight.state);
export function explicitReplyMatchesFlight(message: MessageRecord, invocation: InvocationRequest,
  flight: FlightRecord, flights: Record<string, FlightRecord>, flightById?: (id: string) => FlightRecord | undefined): boolean {
  const reply = completionReply(message), state = flightCompletion(flight);
  if (!hasExplicitCompletion(invocation)) return !reply || (reply.kind === "final"
    && reply.invocationId === invocation.id && reply.flightId === flight.id && reply.revision === 0);
  return Boolean(reply?.kind === "final" && state && reply.invocationId === invocation.id
    && reply.flightId === flight.id && reply.revision === state.revision
    && state.obligations.every(item => {
      const child = flightById ? flightById(item.flightId) : flights[item.flightId];
      return child?.invocationId === item.invocationId && terminal(child);
    }));
}

/** Inside the canonical writer: an early final cannot become a later completion candidate. */
export function assertExplicitReplyAdmission(message: MessageRecord, snapshot: Readonly<RuntimeRegistrySnapshot>, flightById?: (id: string) => FlightRecord | undefined): void {
  if (message.metadata?.completionReply === undefined) return;
  const reply = completionReply(message);
  if (!reply) throw new Error("completion_reply_invalid");
  const invocation = snapshot.invocations[reply.invocationId], flight = snapshot.flights[reply.flightId];
  const state = flightCompletion(flight);
  if (!invocation || !flight || (hasExplicitCompletion(invocation) && !state) || terminal(flight)
    || flight.invocationId !== invocation.id || message.actorId !== invocation.targetAgentId
    || message.class !== "agent" || message.conversationId !== invocation.conversationId
    || message.replyToMessageId !== invocation.messageId || !message.body.trim()) throw new Error("completion_reply_context_mismatch");
  if (reply.revision !== (state?.revision ?? 0)) throw new Error("completion_revision_stale");
  if (reply.kind === "final" && !explicitReplyMatchesFlight(message, invocation, flight, snapshot.flights, flightById)) {
    throw new Error("completion_obligations_pending: wait for joined work, then submit a new final at the current revision");
  }
}

/** Called once for a new invocation under the writer, before acceptance or dispatch. */
export function prepareCompletionAdmission(invocation: InvocationRequest, flight: FlightRecord,
  snapshot: Readonly<RuntimeRegistrySnapshot>, localNodeId?: string): { flight: FlightRecord; parent?: FlightRecord } {
  const explicit = hasExplicitCompletion(invocation);
  const relation = invocation.metadata?.completionRelation as ScoutCompletionRelation | undefined;
  if (!explicit && !relation) return { flight };
  if (!localNodeId || invocation.requesterNodeId !== localNodeId || (invocation.targetNodeId && invocation.targetNodeId !== localNodeId)
    || invocation.action !== "consult" || !invocation.requestId) throw new Error("completion_local_ask_required");
  // The acceptance service selects the actual local endpoint before reaching this writer.
  if (invocation.metadata?.completionLocalNodeId !== localNodeId) throw new Error("completion_route_unsupported");
  const endpointId = invocation.metadata?.completionEndpointId;
  const endpoint = typeof endpointId === "string" ? snapshot.endpoints[endpointId] : undefined;
  if (!endpoint || endpoint.agentId !== invocation.targetAgentId || endpoint.nodeId !== localNodeId
    || endpoint.metadata?.externalSession === true || ["http", "mcp_poll", "pairing_bridge", "devin_cloud_cli"].includes(endpoint.transport)
    || invocation.execution?.session === "fork") throw new Error("completion_endpoint_changed");
  const admitted = explicit ? { ...flight, metadata: { ...flight.metadata,
    completion: { version: 1, revision: 0, obligations: [] } } } : flight;
  if (!relation) return { flight: admitted };
  if (!relation.parentFlightId || !["joined", "continuation"].includes(relation.kind)) throw new Error("completion_relation_invalid");
  const parent = snapshot.flights[relation.parentFlightId], state = flightCompletion(parent);
  const parentInvocation = parent && snapshot.invocations[parent.invocationId];
  if (!parent || !state || terminal(parent) || !parentInvocation || !hasExplicitCompletion(parentInvocation)
    || parentInvocation.requesterNodeId !== localNodeId || parent.id === flight.id) throw new Error("completion_parent_unavailable");
  if (state.obligations.length >= SCOUT_COMPLETION_MAX_OBLIGATIONS) throw new Error("completion_obligations_limit");
  if (relation.kind === "joined" && invocation.requesterId !== parent.targetAgentId) throw new Error("completion_parent_actor_mismatch");
  if (relation.kind === "continuation") {
    const session = flightSessionTrace(parent).at(-1)?.sessionId ?? parentInvocation.execution?.targetSessionId;
    if (![parent.requesterId, parent.targetAgentId].includes(invocation.requesterId)
      || invocation.targetAgentId !== parent.targetAgentId || !session || !invocation.execution?.targetSessionId
      || !endpointMatchesTargetSessionAddress(snapshot, endpoint, session)
      || !endpointMatchesTargetSessionAddress(snapshot, endpoint, invocation.execution.targetSessionId)) {
      throw new Error("completion_continuation_requires_same_session");
    }
  }
  return { flight: { ...admitted, metadata: { ...admitted.metadata, parentCompletion: { flightId: parent.id, revision: state.revision + 1 } } }, parent: { ...parent, metadata: { ...parent.metadata, completion: {
    ...state, revision: state.revision + 1,
    obligations: [...state.obligations, { invocationId: invocation.id, flightId: flight.id, kind: relation.kind }],
  } } } };
}
