import { hasExplicitCompletion } from "@openscout/protocol";
import { explicitReplyMatchesFlight } from "./broker-explicit-completion.js";
import { isIdempotentMessageRetry } from "./broker-message-idempotency.js";
import { isDeepStrictEqual } from "node:util";
import { canonicalMessageRecord } from "./message-record-canonical.js";
import { selectMessageRecordsAsync, readMessageRecord } from "./broker-message-records.js";
import type {
  AgentDefinition,
  ConversationDefinition,
  DeliveryIntent,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
  NodeDefinition,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";
import {
  completedFlightFromBrokerReply,
  isFinalReplyForInvocation,
  messageVisibilityForConversation,
} from "./broker-conversation-helpers.js";
import type {
  MeshMessageAuthorityForwardResult,
  PeerForwardResult,
} from "./broker-mesh-forwarding-service.js";
import {
  isWorkingFlightState,
  shouldNotifyInvocationRequester,
} from "./broker-local-invocation-helpers.js";

export type BrokerMessageRuntime = {
  peek(): { messages: Record<string, MessageRecord> };
  snapshot(): { invocations: Record<string, InvocationRequest>; flights?: Record<string, FlightRecord> };
  conversation(conversationId: string): ConversationDefinition | undefined;
  agent(agentId: string): AgentDefinition | undefined;
  flightForInvocation(invocationId: string): FlightRecord | undefined;
};

export type BrokerMessageMesh = {
  authorityNodeForConversation(conversationId: string): {
    conversation: ConversationDefinition;
    authorityNode: NodeDefinition;
  } | null;
  forwardConversationMessageToAuthority(message: MessageRecord): Promise<MeshMessageAuthorityForwardResult>;
  forwardPeerBrokerDeliveries(
    message: MessageRecord,
    deliveries: DeliveryIntent[],
  ): Promise<PeerForwardResult>;
};

export type BrokerMessageServiceDeps = {
  nodeId: string;
  systemActorId: string;
  runtime: BrokerMessageRuntime;
  mesh: BrokerMessageMesh;
  createId: (prefix: string) => string;
  recordMessage: (
    message: MessageRecord,
    options?: { enqueueProjection?: boolean; dedupeExisting?: boolean },
  ) => Promise<{ deliveries: DeliveryIntent[]; entries: BrokerJournalEntry[]; duplicate?: MessageRecord }>;
  applyProjectedEntries: (entries: BrokerJournalEntry[]) => Promise<void>;
  reconcileStaleLocalDeliveries: () => Promise<void>;
  persistFlight: (flight: FlightRecord, eligible?: () => boolean) => Promise<void>;
  /** Local checkpoint after remote authority acceptance; never a local message/fanout. */
  persistAcceptedReply: (invocation: InvocationRequest, receipt: AcceptedInvocationReply, eligible: () => boolean) => Promise<void>;
  completionFlight?: (id: string) => FlightRecord | undefined;
  completionCurrentFlight?: (invocationId: string) => FlightRecord | undefined;
  authorizeReplyCompletion?: (invocation: InvocationRequest, reply: MessageRecord) => boolean;
  activeLocalEndpointForAgent: (agentId: string) => unknown;
};

export type AcceptedInvocationReply = {
  version: 1;
  authorityNodeId: string;
  message: MessageRecord;
};

function acceptedInvocationReply(flight: FlightRecord | undefined, invocation: InvocationRequest): AcceptedInvocationReply | undefined {
  const receipt = flight?.metadata?.acceptedReply as AcceptedInvocationReply | undefined;
  if (receipt === undefined) return undefined;
  if (receipt?.version !== 1 || typeof receipt.authorityNodeId !== "string" || !receipt.authorityNodeId
    || !receipt.message || typeof receipt.message.id !== "string" || !receipt.message.id
    || typeof receipt.message.body !== "string" || !Number.isFinite(receipt.message.createdAt)
    || !isFinalReplyForInvocation(receipt.message, invocation)) {
    throw new Error(`Malformed accepted reply for invocation ${invocation.id}; completion recovery held`);
  }
  return receipt;
}

export class BrokerMessageService {
  constructor(private readonly deps: BrokerMessageServiceDeps) {}

  readonly postConversationMessage = async (
    message: MessageRecord,
  ): Promise<{
    ok: true;
    message: MessageRecord;
    deliveries: DeliveryIntent[];
    forwarded?: true;
    authorityNodeId?: string;
    duplicate?: boolean;
  }> => {
    const existing = await readMessageRecord(this.deps.runtime.peek().messages,message.id);
    if (existing) {
      if (!isIdempotentMessageRetry(existing, message)) {
        throw new Error(`message id ${message.id} is already assigned to a different record`);
      }
      await this.completeInvocationsForBrokerReply(existing);
      return {
        ok: true,
        message: existing,
        deliveries: [],
        duplicate: true,
      };
    }

    // An authority-owned reply is intentionally absent from local messages.
    // Its acknowledged receipt repairs completion without contacting that peer.
    for (const invocation of Object.values(this.deps.runtime.snapshot().invocations)) {
      if (!isFinalReplyForInvocation(message, invocation)) continue;
      const receipt = acceptedInvocationReply(this.deps.runtime.flightForInvocation(invocation.id), invocation);
      if (receipt?.message.id !== message.id) continue;
      if (!isIdempotentMessageRetry(receipt.message, message)) {
        // Legacy broker replies have no client ID; only their exact retry qualifies.
        if (!isDeepStrictEqual(receipt.message, message)) {
          throw new Error(`message id ${message.id} is already assigned to a different record`);
        }
      }
      await this.checkpointAndCompleteAcceptedReplies(receipt.message, receipt.authorityNodeId);
      return { ok: true, message: receipt.message, deliveries: [], forwarded: true,
        authorityNodeId: receipt.authorityNodeId, duplicate: true };
    }

    const authority = this.deps.mesh.authorityNodeForConversation(message.conversationId);
    if (authority) {
      if (message.metadata?.completionReply !== undefined) throw new Error("completion_remote_conversation_unsupported");
      const forwarded = await this.deps.mesh.forwardConversationMessageToAuthority(message);
      const accepted = forwarded.message;
      if (accepted !== undefined) {
        if (!accepted || accepted.id !== message.id || !Number.isFinite(accepted.createdAt)
          || !(isIdempotentMessageRetry(canonicalMessageRecord(accepted), canonicalMessageRecord(message))
            || isDeepStrictEqual(canonicalMessageRecord(accepted), canonicalMessageRecord(message)))) {
          throw new Error(`authority ${forwarded.authorityNodeId} returned a conflicting canonical message for ${message.id}`);
        }
        // A retry's timestamp/provenance is not proof of what the authority stored.
        await this.checkpointAndCompleteAcceptedReplies(accepted, forwarded.authorityNodeId);
      } else if (Object.values(this.deps.runtime.snapshot().invocations)
        .some((invocation) => this.completionFlight(invocation, message))) {
        // Older peers can acknowledge delivery, but cannot prove final completion.
        throw new Error(`authority ${forwarded.authorityNodeId} acknowledged ${message.id} without a canonical message; completion recovery held`);
      }
      return {
        ok: true,
        ...forwarded,
        message: accepted ?? message,
        deliveries: forwarded.deliveries ?? [],
      };
    }

    const { deliveries, entries, duplicate } = await this.deps.recordMessage(message, {
      enqueueProjection: false,
      dedupeExisting: true,
    });
    if (duplicate) {
      await this.completeInvocationsForBrokerReply(duplicate);
      return { ok: true, message: duplicate, deliveries: [], duplicate: true };
    }
    await this.deps.mesh.forwardPeerBrokerDeliveries(message, deliveries);
    await this.deps.applyProjectedEntries(entries);
    await this.deps.reconcileStaleLocalDeliveries();
    await this.completeInvocationsForBrokerReply(message);
    return { ok: true, message, deliveries };
  };

  readonly postInvocationStatusMessage = async (
    invocation: InvocationRequest,
    flight: {
      id?: string;
      summary?: string;
      error?: string;
    },
  ): Promise<void> => {
    if (!invocation.conversationId) {
      return;
    }

    const conversation = this.deps.runtime.conversation(invocation.conversationId);
    if (!conversation) {
      return;
    }

    const body = [flight.summary, flight.error]
      .filter((value): value is string => Boolean(value && value.trim().length > 0))
      .join("\n");
    if (!body) {
      return;
    }

    await this.postConversationMessage({
      id: this.deps.createId("msg"),
      conversationId: invocation.conversationId,
      actorId: this.deps.systemActorId,
      originNodeId: this.deps.nodeId,
      class: "status",
      body,
      replyToMessageId: invocation.messageId,
      ...(shouldNotifyInvocationRequester(invocation)
        ? { audience: { notify: [invocation.requesterId] } }
        : { audience: { delivery: "none" } }),
      visibility: messageVisibilityForConversation(conversation),
      policy: "durable",
      createdAt: Date.now(),
      metadata: {
        ...(flight.id ? { flightId: flight.id } : {}),
        invocationId: invocation.id,
        source: "broker",
        targetAgentId: invocation.targetAgentId,
      },
    });
  };

  readonly existingBrokerReplyForInvocation = async (
    invocation: InvocationRequest,
    agentId: string,
    sinceMs: number,
  ): Promise<MessageRecord | null> => {
    if (!invocation.conversationId || !invocation.messageId) {
      return null;
    }

    const since = Math.max(0, sinceMs - 5_000);
    const replies = await selectMessageRecordsAsync(this.deps.runtime.peek().messages, 1,
      (lhs, rhs) => rhs.createdAt - lhs.createdAt, (message) =>
        this.authorizedFinalReply(invocation, message)
        && message.actorId === agentId
        && message.class === "agent"
        && message.createdAt >= since, {selection:{conversationIds:[invocation.conversationId],actorId:agentId,replyToMessageId:invocation.messageId,since,newestFirst:true}});

    return replies[0] ?? null;
  };

  readonly completeInvocationForBrokerReply = async (
    invocation: InvocationRequest,
    reply: MessageRecord,
    expectedFlightId?: string,
  ): Promise<boolean> => {
    const flight = this.completionFlight(invocation, reply);
    if (!flight || (expectedFlightId !== undefined && flight.id !== expectedFlightId)) return false;

    await this.deps.persistFlight(completedFlightFromBrokerReply(
      invocation,
      flight,
      reply,
      this.deps.runtime.agent(invocation.targetAgentId)?.displayName,
    ), () => this.completionFlight(invocation, reply)?.id === flight.id);
    const completed = this.deps.runtime.flightForInvocation(invocation.id);
    return completed?.id === flight.id && completed.state === "completed" && completed.metadata?.replyMessageId === reply.id;
  };

  /** Called for active flights only; accepted-message reads never resubmit work. */
  readonly recoverInvocationReply = async (invocation: InvocationRequest): Promise<boolean> => {
    const flight = this.deps.runtime.flightForInvocation(invocation.id);
    if (!flight || !isWorkingFlightState(flight.state)) return false;
    const receipt = acceptedInvocationReply(flight, invocation);
    const reply = receipt?.message ?? await this.existingBrokerReplyForInvocation(
      invocation, invocation.targetAgentId, flight.startedAt ?? invocation.createdAt,
    );
    return reply ? this.completeInvocationForBrokerReply(invocation, reply, flight.id) : false;
  };

  private authorizedFinalReply(invocation: InvocationRequest, reply: MessageRecord): boolean {
    return isFinalReplyForInvocation(reply, invocation)
      && (!this.deps.authorizeReplyCompletion || this.deps.authorizeReplyCompletion(invocation, reply));
  }

  private completionFlight(invocation: InvocationRequest, reply: MessageRecord): FlightRecord | undefined {
    if (!this.authorizedFinalReply(invocation, reply)) return undefined;
    const flight = hasExplicitCompletion(invocation) && this.deps.completionCurrentFlight
      ? this.deps.completionCurrentFlight(invocation.id) : this.deps.runtime.flightForInvocation(invocation.id);
    if (!flight || !isWorkingFlightState(flight.state)
      || !explicitReplyMatchesFlight(reply, invocation, flight, this.deps.runtime.snapshot().flights ?? {}, this.deps.completionFlight)) return undefined;
    const startedAt = flight.startedAt ?? invocation.createdAt;
    if (reply.createdAt < Math.max(0, startedAt - 5_000)) return undefined;
    const accepted = acceptedInvocationReply(flight, invocation);
    // The first durable authority acknowledgement owns this completion.
    if (accepted && !isDeepStrictEqual(accepted.message, reply)) return undefined;
    return flight;
  }

  private async checkpointAndCompleteAcceptedReplies(message: MessageRecord, authorityNodeId: string): Promise<void> {
    for (const invocation of Object.values(this.deps.runtime.snapshot().invocations)) {
      const flight = this.completionFlight(invocation, message);
      if (!flight) continue;
      await this.deps.persistAcceptedReply(invocation, { version: 1, authorityNodeId, message },
        () => this.completionFlight(invocation, message)?.id === flight.id);
      await this.completeInvocationForBrokerReply(invocation, message, flight.id);
    }
  }

  readonly completeInvocationsForBrokerReply = async (message: MessageRecord): Promise<void> => {
    if (message.class !== "agent" || !message.replyToMessageId || !message.body.trim()) {
      return;
    }

    const invocations = Object.values(this.deps.runtime.snapshot().invocations)
      .filter((invocation) => isFinalReplyForInvocation(message, invocation));
    for (const invocation of invocations) {
      await this.completeInvocationForBrokerReply(invocation, message);
    }
  };

  readonly onlineConversationNotifyTargets = (
    conversation: ConversationDefinition,
    requesterId: string,
  ): string[] => {
    return conversation.participantIds.filter((participantId) => {
      if (participantId === requesterId) {
        return false;
      }
      if (!this.deps.runtime.agent(participantId)) {
        return false;
      }
      return Boolean(this.deps.activeLocalEndpointForAgent(participantId));
    });
  };
}
