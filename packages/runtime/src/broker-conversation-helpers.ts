import { completionReply, hasExplicitCompletion } from "@openscout/protocol";
import { iterateMessageRecords, iterateMessageRecordsAsync, readMessageRecord } from "./broker-message-records.js";
import {
  buildScoutReturnAddress,
  preferredConversationWithNaturalKey,
  type AgentDefinition,
  type AgentEndpoint,
  type ConversationDefinition,
  type FlightRecord,
  type InvocationRequest,
  type MessageRecord,
  type ScoutDeliverRouteKind,
} from "@openscout/protocol";

import type { BrokerRouteTargetInput, RuntimeSnapshot } from "./scout-dispatcher.js";
import { runtimeSessionAddressForEndpoint, runtimeSessionAddressForSessionId } from "./runtime-session-address.js";
import {
  classifyEndpoint,
  endpointStartedAt,
  endpointTerminalAt,
  homeEndpointForAgent,
} from "./broker-endpoint-selection.js";

export function brokerActorDisplayName(
  snapshot: RuntimeSnapshot,
  actorId: string,
  options: {
    operatorActorId?: string;
    operatorDisplayName?: string;
  } = {},
): string {
  if (actorId === options.operatorActorId) {
    return options.operatorDisplayName?.trim() || actorId;
  }

  const agent = snapshot.agents[actorId];
  if (typeof agent?.displayName === "string" && agent.displayName.trim().length > 0) {
    return agent.displayName;
  }

  const actor = snapshot.actors[actorId];
  if (typeof actor?.displayName === "string" && actor.displayName.trim().length > 0) {
    return actor.displayName;
  }

  return actorId;
}

export function brokerConversationChannel(
  snapshot: RuntimeSnapshot,
  conversationId: string | null | undefined,
): string | null {
  if (!conversationId) {
    return null;
  }

  const conversation = snapshot.conversations[conversationId];
  if (!conversation) {
    return null;
  }

  if (typeof conversation.metadata?.channel === "string") {
    return conversation.metadata.channel;
  }
  return null;
}

export function titleCaseName(value: string): string {
  return value
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

export function metadataStringValue(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function scoutbotReplyProvenanceMetadata(invocation: InvocationRequest): Record<string, unknown> {
  if (invocation.targetAgentId !== "scoutbot") {
    return {};
  }
  return {
    source: metadataStringValue(invocation.metadata, "source") ?? "scoutbot",
    requestedBy: metadataStringValue(invocation.metadata, "requestedBy") ?? invocation.requesterId,
    sourceMessageId: metadataStringValue(invocation.metadata, "sourceMessageId") ?? invocation.messageId ?? null,
    parentScoutbotTurnId: metadataStringValue(invocation.metadata, "parentScoutbotTurnId"),
    generatedBy: metadataStringValue(invocation.metadata, "generatedBy") ?? "scoutbot",
    scoutbotThreadId: metadataStringValue(invocation.metadata, "scoutbotThreadId"),
    targetSessionId: metadataStringValue(invocation.metadata, "targetSessionId"),
  };
}

export function brokerTargetProjectRoot(agent: AgentDefinition, endpoint: AgentEndpoint | null): string | null {
  return endpoint?.projectRoot
    ?? endpoint?.cwd
    ?? metadataStringValue(agent.metadata, "projectRoot");
}

export function brokerTargetLabel(agent: AgentDefinition): string {
  const selector = agent.selector
    ?? agent.defaultSelector
    ?? metadataStringValue(agent.metadata, "selector")
    ?? metadataStringValue(agent.metadata, "defaultSelector");
  if (selector) {
    return selector;
  }
  const handle = agent.handle?.trim();
  return `@${handle && handle.length > 0 ? handle : agent.id}`;
}

export function brokerRouteKind(
  conversation: Pick<ConversationDefinition, "id" | "kind" | "metadata">,
): ScoutDeliverRouteKind {
  if (conversation.kind === "direct") {
    return "dm";
  }
  return conversation.metadata?.channel === "shared" || conversation.metadata?.channel === "broadcast"
    ? "broadcast"
    : "channel";
}

export function normalizeBrokerProductTarget(value: string): string {
  return value.trim().toLowerCase().replace(/^@+/, "");
}

export function isLocalScoutProductTarget(payload: BrokerRouteTargetInput): boolean {
  const target = payload.target;
  if (target) {
    if (target.kind !== "agent_label" && target.kind !== "agent_id") {
      return false;
    }
    const value = target.kind === "agent_label" ? target.label : target.agentId;
    const normalized = normalizeBrokerProductTarget(value);
    return normalized === "scout" || normalized === "openscout";
  }

  const normalizedLabel = normalizeBrokerProductTarget(payload.targetLabel ?? "");
  const normalizedAgentId = normalizeBrokerProductTarget(payload.targetAgentId ?? "");
  return normalizedLabel === "scout"
    || normalizedLabel === "openscout"
    || normalizedAgentId === "scout"
    || normalizedAgentId === "openscout";
}

export function isOperatorDeliveryTarget(
  payload: BrokerRouteTargetInput,
  operatorActorId = "operator",
): boolean {
  const target = payload.target;
  if (target) {
    if (target.kind !== "agent_label" && target.kind !== "agent_id") {
      return false;
    }
    const value = target.kind === "agent_label" ? target.label : target.agentId;
    return normalizeBrokerProductTarget(value) === operatorActorId;
  }

  return normalizeBrokerProductTarget(payload.targetLabel ?? "") === operatorActorId
    || normalizeBrokerProductTarget(payload.targetAgentId ?? "") === operatorActorId;
}

export function messageRefCandidateForRouteTarget(payload: BrokerRouteTargetInput): string | null {
  const target = payload.target;
  const raw = target?.kind === "binding_ref"
    ? target.ref
    : target?.kind === "agent_label"
    ? target.label
    : payload.targetLabel ?? "";
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const withoutPrefix = trimmed.startsWith("ref:") ? trimmed.slice("ref:".length).trim() : trimmed;
  return /^(?:msg|m)-[a-z0-9][a-z0-9._-]*$/i.test(withoutPrefix) ? withoutPrefix : null;
}

export function resolveBrokerMessageRef(snapshot: RuntimeSnapshot, ref: string): MessageRecord | null {
  const direct = snapshot.messages[ref];
  if (direct) {
    return direct;
  }
  const normalized = ref.toLowerCase();
  let match: MessageRecord | null = null;
  for (const message of iterateMessageRecords(snapshot.messages)) {
    if (message.id.toLowerCase() !== normalized && !message.id.toLowerCase().endsWith(normalized)) continue;
    if (match) return null;
    match = message;
  }
  return match;
}

export async function resolveBrokerMessageRefAsync(snapshot: RuntimeSnapshot, ref: string): Promise<MessageRecord | null> {
  const direct = await readMessageRecord(snapshot.messages,ref);
  if (direct) {
    return direct;
  }
  const normalized = ref.toLowerCase();
  let match: MessageRecord | null = null;
  for await (const message of iterateMessageRecordsAsync(snapshot.messages)) {
    if (message.id.toLowerCase() !== normalized && !message.id.toLowerCase().endsWith(normalized)) continue;
    if (match) return null;
    match = message;
  }
  return match;
}

export function resolveConversationShareMode(
  snapshot: RuntimeSnapshot,
  participantIds: string[],
  fallback: "local" | "shared",
  localNodeId: string,
): "local" | "shared" {
  if (fallback === "shared") {
    return "shared";
  }

  const hasRemoteParticipant = participantIds.some((participantId) => {
    const participant = snapshot.agents[participantId];
    return Boolean(participant?.authorityNodeId && participant.authorityNodeId !== localNodeId);
  });
  return hasRemoteParticipant ? "shared" : fallback;
}

export function findConversationByIdentity(
  snapshot: RuntimeSnapshot,
  naturalKey: string,
): ConversationDefinition | undefined {
  return preferredConversationWithNaturalKey(
    Object.values(snapshot.conversations),
    naturalKey,
  );
}

export function buildBrokerReturnAddressForActor(
  snapshot: RuntimeSnapshot,
  actorId: string,
  options: {
    conversationId?: string;
    replyToMessageId?: string;
    sessionId?: string;
  } = {},
) {
  const agent = snapshot.agents[actorId];
  const actor = snapshot.actors[actorId];
  const endpoint = homeEndpointForAgent(snapshot, actorId);
  return buildScoutReturnAddress({
    actorId,
    handle: agent?.handle?.trim() || actor?.handle?.trim() || actorId,
    displayName: agent?.displayName || actor?.displayName,
    selector: agent?.selector ?? metadataStringValue(agent?.metadata, "selector") ?? metadataStringValue(actor?.metadata, "selector") ?? undefined,
    defaultSelector: agent?.defaultSelector
      ?? metadataStringValue(agent?.metadata, "defaultSelector")
      ?? metadataStringValue(actor?.metadata, "defaultSelector")
      ?? undefined,
    conversationId: options.conversationId,
    replyToMessageId: options.replyToMessageId,
    nodeId: endpoint?.nodeId || agent?.authorityNodeId || agent?.homeNodeId,
    projectRoot: endpoint?.projectRoot ?? endpoint?.cwd ?? metadataStringValue(agent?.metadata, "projectRoot") ?? undefined,
    sessionId: options.sessionId ?? endpoint?.sessionId,
    sessionAddress: options.sessionId
      ? runtimeSessionAddressForSessionId(snapshot, options.sessionId) ?? undefined
      : endpoint
      ? runtimeSessionAddressForEndpoint(snapshot, endpoint) ?? undefined
      : undefined,
  });
}

export function summarizeHomeAgent(endpoint: AgentEndpoint | null, hasActiveFlight = false): {
  state: "offline" | "available" | "working";
  reachable: boolean;
  statusLabel: string;
  statusDetail: string | null;
  lastSeenAt: number | null;
} {
  if (!endpoint) {
    return {
      state: "offline",
      reachable: false,
      statusLabel: "Offline",
      statusDetail: "No live endpoint detected.",
      lastSeenAt: null,
    };
  }

  const classification = classifyEndpoint(endpoint);
  const lastSeenAt = Math.max(endpointStartedAt(endpoint), endpointTerminalAt(endpoint)) || null;
  const runtimeLabel = [endpoint.harness, endpoint.transport].filter(Boolean).join(" · ");

  if (!classification.reachable) {
    return {
      state: "offline",
      reachable: false,
      statusLabel: "Offline",
      statusDetail: runtimeLabel || "Endpoint offline",
      lastSeenAt,
    };
  }

  // Endpoint `active` means the harness session is attached and routable; it
  // does not mean a turn is still executing. Flights own work lifecycle, so
  // only a non-terminal flight may promote a reachable agent to Working.
  return hasActiveFlight
    ? {
        state: "working",
        reachable: true,
        statusLabel: "Working",
        statusDetail: runtimeLabel || "Active flight",
        lastSeenAt,
      }
    : {
        state: "available",
        reachable: true,
        statusLabel: "Available",
        statusDetail: runtimeLabel || "Reachable endpoint",
        lastSeenAt,
      };
}

export function messageVisibilityForConversation(conversation?: ConversationDefinition): MessageRecord["visibility"] {
  switch (conversation?.visibility) {
    case "private":
    case "public":
    case "system":
      return conversation.visibility;
    case "workspace":
    default:
      return "workspace";
  }
}

/** Legacy replies are final; explicit progress/final semantics belong here. */
export function isFinalReplyForInvocation(message: MessageRecord, invocation: InvocationRequest): boolean {
  if (invocation.action === "wake") {
    return false;
  }
  if (!invocation.conversationId || !invocation.messageId) {
    return false;
  }
  const explicit = completionReply(message);
  if (message.metadata?.completionReply !== undefined && !explicit) return false;
  if (explicit?.kind === "progress" || (hasExplicitCompletion(invocation) && explicit?.kind !== "final")) return false;
  if (explicit && explicit.invocationId !== invocation.id) return false;
  return message.class === "agent"
    && message.actorId === invocation.targetAgentId
    && message.conversationId === invocation.conversationId
    && message.replyToMessageId === invocation.messageId
    && message.body.trim().length > 0;
}

export const messageAnswersInvocation = isFinalReplyForInvocation;

export function completedFlightFromBrokerReply(
  invocation: InvocationRequest,
  flight: FlightRecord,
  reply: MessageRecord,
  targetDisplayName?: string,
): FlightRecord {
  const replySource = metadataStringValue(reply.metadata, "source");
  return {
    ...flight,
    state: "completed",
    summary: `${targetDisplayName ?? invocation.targetAgentId} replied.`,
    output: reply.body,
    error: undefined,
    completedAt: reply.createdAt,
    metadata: {
      ...(flight.metadata ?? {}),
      completedByBrokerReply: true,
      replyMessageId: reply.id,
      ...(replySource ? { replySource } : {}),
    },
  };
}
