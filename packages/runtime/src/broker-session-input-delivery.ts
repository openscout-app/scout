import type { ActorIdentity, MessageRecord, ScoutDeliverRequest, ScoutDeliverResponse, ScoutSessionInputReceipt } from "@openscout/protocol";
import type { BrokerDeliveryAcceptanceServiceOptions } from "./broker-delivery-acceptance-service.js";
import { deliveryRequestMessageId } from "./broker-delivery-receipt-recovery.js";
import { flatDispatchSessionId } from "./broker-session-wake.js";
import { buildDispatchEnvelope } from "./scout-dispatcher.js";
import type { InPlaceDelivery } from "./in-place/deliver.js";

type Accepted = Extract<ScoutDeliverResponse, { kind: "delivery" }>;
type SessionInputAcceptance = {
  version: 1;
  requesterId: string;
  requestId: string;
  response: Omit<Accepted, "message">;
};

export type SessionInputDeliveryOptions = {
  submitSessionInput?: (input: { sessionId: string; harness: "claude" | "codex"; body: string }) => Promise<InPlaceDelivery>;
  upsertSessionInputActor?: (actor: ActorIdentity) => Promise<void>;
};

/** Validate before reservation or any external input; unsupported semantics must not be dropped. */
export function validateSessionInputRequest(payload: ScoutDeliverRequest): void {
  if (payload.sessionDelivery === undefined) return;
  if (!payload.requestId?.trim()) throw new Error("request_id_required: session input requires a stable request id");
  const target = payload.target;
  if (payload.sessionDelivery !== "in_place_or_resume" || payload.intent !== "consult" || !payload.body.trim()
    || target?.kind !== "session_id" || !target.sessionId.trim()
    || (target.harness !== "claude" && target.harness !== "codex")
    || Object.keys(target).some(key => !["kind", "sessionId", "harness", "forkIfLive"].includes(key))
    || (target.forkIfLive && target.harness !== "codex")
    || payload.targetAgentId || payload.targetSessionId || payload.channel || payload.routePolicy
    || payload.attachments?.length || payload.workItem || payload.projectAgent || payload.operatorSignal
    || payload.collaborationRecordId || payload.replyToMessageId || payload.replyToSessionId || payload.speechText
    || payload.executionSource || payload.labels?.length
    || (payload.execution && Object.entries(payload.execution).some(([key, value]) => value !== undefined && (key !== "session" || value !== "existing")))
    || (payload.invocationMetadata && Object.keys(payload.invocationMetadata).some(key => key !== "source"))) {
    throw new Error("session_input_unsupported: requires an exact local Claude or Codex session without attachments or execution options");
  }
}

/** A persisted submission witness can recover acceptance, never execution completion. */
export function recoverSessionInputDelivery(message: MessageRecord | undefined, requesterId: string, requestId: string): Accepted | null {
  const envelope = message?.metadata?.scoutSessionInputAcceptance as SessionInputAcceptance | undefined;
  const response = envelope?.response;
  const receipt = response?.receipt;
  const submitted = receipt?.inputSubmitted;
  if (!message || message.id !== deliveryRequestMessageId(requesterId, requestId) || message.actorId !== requesterId
    || message.audience?.delivery !== "none" || envelope?.version !== 1
    || envelope.requesterId !== requesterId || envelope.requestId !== requestId
    || response?.kind !== "delivery" || response.accepted !== true || response.routeKind !== "dm" || response.flight
    || receipt?.requesterId !== requesterId || receipt.requestId !== requestId || receipt.flightId
    || receipt.messageId !== message.id || receipt.conversationId !== message.conversationId
    || receipt.requesterNodeId !== message.originNodeId || receipt.acceptedAt !== message.createdAt
    || response.conversation?.id !== message.conversationId || receipt.routeKind !== "dm"
    || !response.targetAgentId || response.targetAgentId !== receipt.targetAgentId
    || submitted?.kind !== "in_place" || submitted.state !== "submitted"
    || (submitted.harness !== "claude" && submitted.harness !== "codex")
    || !["herdr", "orca", "tmux", "lattices", "scout-app"].includes(submitted.via)
    || typeof submitted.location !== "string" || !submitted.location
    || !submitted.sessionId || submitted.sessionId !== response.targetSessionId || submitted.sessionId !== receipt.targetSessionId) return null;
  const { scoutSessionInputAcceptance: _, ...metadata } = message.metadata ?? {};
  return { ...response, message: { ...message, metadata } };
}

/** null means a definite not_live result, permitting normal exact-session acceptance in this same command. */
export async function acceptSessionInput(
  payload: ScoutDeliverRequest,
  context: { requesterId: string; requesterNodeId: string; createdAt: number },
  deps: BrokerDeliveryAcceptanceServiceOptions & SessionInputDeliveryOptions,
): Promise<ScoutDeliverResponse | null> {
  const target = payload.target;
  if (target?.kind !== "session_id" || (target.harness !== "claude" && target.harness !== "codex")) throw new Error("invalid session input target");
  if (!deps.submitSessionInput || !deps.upsertSessionInputActor) throw new Error("session_input_unsupported: broker cannot submit live input");
  const { requesterId, requesterNodeId, createdAt } = context;
  const sessionId = target.sessionId.trim();
  const harness = target.harness;
  const snapshot = deps.runtimeSnapshot();
  const matchingActors = new Set(Object.values(snapshot.endpoints)
    .filter(endpoint => endpoint.nodeId === deps.nodeId && endpoint.harness === harness
      && [endpoint.sessionId, endpoint.metadata?.externalSessionId, endpoint.metadata?.threadId, endpoint.metadata?.nativeSessionId].includes(sessionId))
    .map(endpoint => endpoint.agentId));
  const reject = async (code: string, detail: string): Promise<ScoutDeliverResponse> => {
    const envelope = buildDispatchEnvelope({ kind: "unknown", label: sessionId, detail }, `session:${sessionId}`, deps.nodeId, snapshot, { homeEndpointFor: deps.homeEndpointForAgent });
    const { record } = await deps.recordScoutDispatch({ ...envelope, sessionWakeReason: code }, { requesterId });
    return { kind: "rejected", accepted: false, reason: "invalid_target", rejection: record };
  };
  if (matchingActors.size > 1) return reject("session_ambiguous", "More than one local actor owns this native session.");
  const targetAgentId = [...matchingActors][0] ?? flatDispatchSessionId(harness, sessionId);
  // Receipt reservation already exists. Any throw or uncertain external result remains unknown.
  let result: InPlaceDelivery;
  try { result = await deps.submitSessionInput({ sessionId, harness, body: payload.body.trim() }); }
  catch { throw new Error("request_outcome_unknown: session input may have been submitted; retain the same request id"); }
  if (!result.ok) {
    if (result.code === "not_live") return null;
    if (result.code === "in_place_failed") throw new Error("request_outcome_unknown: session input may have been submitted; retain the same request id");
    return reject(result.code, "The live session cannot accept input right now.");
  }
  // Failure after submission deliberately leaves the request unknown until its canonical witness exists.
  await deps.ensureBrokerActorForDelivery(requesterId);
  if (!snapshot.actors[targetAgentId] && !snapshot.agents[targetAgentId]) {
    await deps.upsertSessionInputActor({ id: targetAgentId, kind: "session", displayName: `${harness} session`,
      labels: ["session"], metadata: { source: "broker-session-input", harness, nativeSessionId: sessionId, nodeId: deps.nodeId } });
  }
  const conversation = await deps.ensureBrokerDeliveryConversation({ requesterId, targetAgentId });
  const inputSubmitted: ScoutSessionInputReceipt = { kind: "in_place", state: "submitted", sessionId, harness, via: result.via, location: result.location };
  const requestId = payload.requestId!;
  const message: MessageRecord = { id: deliveryRequestMessageId(requesterId, requestId), conversationId: conversation.id,
    actorId: requesterId, originNodeId: requesterNodeId, class: "agent", body: payload.body.trim(),
    audience: { delivery: "none" }, visibility: deps.messageVisibilityForConversation(conversation), policy: "durable", createdAt,
    metadata: { ...payload.messageMetadata, deliveryRequestId: requestId, targetSessionId: sessionId, relayTarget: targetAgentId } };
  const response: Omit<Accepted, "message"> = { kind: "delivery", accepted: true, routeKind: "dm", conversation, targetAgentId, targetSessionId: sessionId,
    receipt: { requestId, routeKind: "dm", requesterId, requesterNodeId, targetAgentId, targetSessionId: sessionId,
      targetLabel: `session:${sessionId}`, conversationId: conversation.id, messageId: message.id, acceptedAt: createdAt, inputSubmitted } };
  const witness: SessionInputAcceptance = { version: 1, requesterId, requestId, response };
  await deps.postConversationMessage({ ...message, metadata: { ...message.metadata, scoutSessionInputAcceptance: witness } });
  return { ...response, message };
}
