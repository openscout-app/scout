import { assertExplicitReplyAdmission, prepareCompletionAdmission } from "./broker-explicit-completion.js";
import { messageWithAcceptedFlight } from "./broker-delivery-receipt-recovery.js";
import { ChatQuestionError, transitionChatQuestion } from "./chat-question-transition.js";
import { clearOperatorTitle, markOperatorTitled } from "./conversation-title.js";
import { isIdempotentMessageRetry } from "./broker-message-idempotency.js";
import { isIdempotentInvocationRetry } from "./broker-invocation-idempotency.js";
import { existingDeliveryWorkItemMatches, type DeliveryWorkItemResolution } from "./broker-work-item-store.js";
import { readMessageRecord } from "./broker-message-records.js";
import {
  applyChatPinChange,
  correctChatMessage,
  ChatMessageCorrectionError,
  assertValidCollaborationEvent,
  assertValidCollaborationRecord,
  type ActorIdentity,
  type AgentDefinition,
  type AgentEndpoint,
  type CollaborationEvent,
  type CollaborationRecord,
  type ConversationBinding,
  type ConversationDefinition,
  type DeliveryIntent,
  type FlightRecord,
  type InvocationRequest,
  type MessageRecord,
  type NodeDefinition,
} from "@openscout/protocol";
import { isDeepStrictEqual } from "node:util";

import type { BrokerJournalEntry } from "./broker-journal.js";
import type { BrokerInvocationDispatchJob } from "./broker-dispatch-job.js";
import type {
  RuntimeActorIdentity,
  RuntimeAgentDefinition,
  RuntimeRegistrySnapshot,
} from "./registry.js";

export type DurableCommitOptions = {
  enqueueProjection?: boolean;
};

type DurableStore = {
  runWrite<T>(work: () => Promise<T>): Promise<T>;
  commitEntries(
    entries: BrokerJournalEntry | BrokerJournalEntry[],
    applyRuntime: (entries: BrokerJournalEntry[]) => Promise<void>,
    options?: DurableCommitOptions,
  ): Promise<BrokerJournalEntry[]>;
};

type RuntimeRecordStore = {
  peek(): Readonly<RuntimeRegistrySnapshot>;
  upsertNode(node: NodeDefinition): Promise<void>;
  upsertActor(actor: ActorIdentity): Promise<void>;
  upsertAgent(agent: AgentDefinition): Promise<void>;
  upsertEndpoint(endpoint: AgentEndpoint): Promise<void>;
  refreshEndpointSilently(endpoint: AgentEndpoint): void;
  deleteEndpoint(endpointId: string): void;
  deleteAgent(agentId: string): void;
  deleteActor(actorId: string): void;
  isRetiredActor(actorId: string): boolean;
  upsertConversation(conversation: ConversationDefinition): Promise<void>;
  upsertBinding(binding: ConversationBinding): Promise<void>;
  upsertCollaboration(record: CollaborationRecord): Promise<void>;
  collaborationRecord(recordId: string): CollaborationRecord | undefined;
  appendCollaborationEvent(event: CollaborationEvent): Promise<void>;
  planMessage(message: MessageRecord, options?: { localOnly?: boolean }): DeliveryIntent[];
  correctMessage(message: MessageRecord): Promise<void>;
  commitMessage(message: MessageRecord, deliveries: DeliveryIntent[]): Promise<void>;
  upsertFlight?(flight: FlightRecord, options?: { preserveCurrent?: boolean }): Promise<void>;
  flightForInvocation?(invocationId: string): FlightRecord | undefined;
  planInvocation(invocation: InvocationRequest): FlightRecord;
  commitInvocation(invocation: InvocationRequest, flight: FlightRecord): Promise<void>;
};

export type BrokerDurableRecordStoreOptions = {
  localNodeId?: string;
  completionCurrentFlight?: (invocationId: string) => FlightRecord | undefined;
  completionFlight?: (id: string) => FlightRecord | undefined;
  completionInvocation?: (id: string) => InvocationRequest | undefined;
  runtime: RuntimeRecordStore;
  durableStore: DurableStore;
  knownInvocations: Map<string, InvocationRequest>;
  invocationDispatchJobFor?: (jobId: string) => BrokerInvocationDispatchJob | null;
  /**
   * Authoritative membership lookup (SQLite conversation_members), queried
   * before an agent/actor delete so the journaled entry carries the delete
   * preimage the conversation projection needs. Absent = no store wired.
   */
  memberConversationIds?: (actorId: string) => string[];
};

/**
 * Fresh-state veto for registry deletes, evaluated INSIDE the serialized
 * durable writer against the canonical snapshot — a revival or new reference
 * queued ahead of the delete wins instead of being overwritten by a stale plan.
 */
export type RegistryDeleteEligibility = (
  snapshot: Readonly<RuntimeRegistrySnapshot>,
) => boolean | { ok: boolean; reason?: string };

export type RegistryDeleteResult = {
  deleted: boolean;
  reason?: string;
};

export type RegistryDeleteOptions = {
  eligible?: RegistryDeleteEligibility;
};

export type ConversationMutator = (
  current: ConversationDefinition | undefined,
) => ConversationDefinition | null | undefined;

export type UpdateConversationResult = {
  /** Whether a `conversation.upsert` reached the journal. */
  updated: boolean;
  /** Post-call canonical record: the write, the declined current, or null. */
  conversation: ConversationDefinition | null;
};

/**
 * Whole-record roster writes carry the caller's preimage: external
 * /v1/conversations upserts and other replacement producers can still name an
 * actor retention deleted between the client's read and this write. A stale
 * upsert would resurrect the membership in canonical state — and trip the
 * conversation_members actor FK on SQLite projection. The durable writer
 * drops retired actor ids from every journaled conversation roster.
 *
 * One warn line per filtered write, capped: a pathological producer loop
 * must not flood the broker log.
 */
let retiredRosterFilterWrites = 0;
const reportRetiredRosterFilter = (conversationId: string, droppedIds: string[]): void => {
  retiredRosterFilterWrites += 1;
  if (retiredRosterFilterWrites <= 20 || retiredRosterFilterWrites % 100 === 0) {
    console.warn(`[openscout-runtime] conversation upsert for ${conversationId} dropped retired actor participant(s): ${droppedIds.join(", ")} (filtered write #${retiredRosterFilterWrites})`);
  }
};

function normalizeComparableValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeComparableValue(entry));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeComparableValue(entry)] as const),
  );
}

function comparableEndpointWithoutHeartbeatMetadata(endpoint: AgentEndpoint): unknown {
  const ignoredMetadataKeys = new Set(["lastSeenAt"]);
  if (endpoint.metadata?.source === "scout-channel") {
    ignoredMetadataKeys.add("startedAt");
  }
  const metadata = endpoint.metadata
    ? Object.fromEntries(
        Object.entries(endpoint.metadata)
          .filter(([key]) => !ignoredMetadataKeys.has(key)),
      )
    : undefined;

  return normalizeComparableValue({
    ...endpoint,
    metadata: metadata && Object.keys(metadata).length > 0 ? metadata : undefined,
  });
}

export function isEndpointLastSeenHeartbeat(
  previous: AgentEndpoint | undefined,
  next: AgentEndpoint,
): boolean {
  if (!previous) {
    return false;
  }

  const previousLastSeenAt = previous.metadata?.lastSeenAt;
  const nextLastSeenAt = next.metadata?.lastSeenAt;
  if (
    typeof previousLastSeenAt !== "number"
    || typeof nextLastSeenAt !== "number"
    || !Number.isFinite(previousLastSeenAt)
    || !Number.isFinite(nextLastSeenAt)
    || nextLastSeenAt <= previousLastSeenAt
  ) {
    return false;
  }

  return JSON.stringify(comparableEndpointWithoutHeartbeatMetadata(previous))
    === JSON.stringify(comparableEndpointWithoutHeartbeatMetadata(next));
}

function actorIdentityForAgent(agent: AgentDefinition): RuntimeActorIdentity {
  return {
    id: agent.id,
    kind: agent.kind,
    displayName: agent.displayName,
    handle: agent.handle,
    labels: agent.labels,
    metadata: agent.metadata,
    createdAt: (agent as RuntimeAgentDefinition).createdAt,
  };
}

/**
 * First-registration stamp. New actors/agents get Date.now(); re-upserts keep
 * the value already in the runtime so the stamp survives every later write
 * and journal replay.
 */
function withCreatedAt<T extends ActorIdentity>(record: T, existing: number | undefined): T & { createdAt: number } {
  const createdAt = (record as RuntimeActorIdentity).createdAt ?? existing ?? Date.now();
  return { ...record, createdAt };
}

function isCurrentAgentRecord(
  snapshot: ReturnType<RuntimeRecordStore["peek"]>,
  agent: AgentDefinition,
): boolean {
  return isDeepStrictEqual(snapshot.agents[agent.id], agent)
    && isDeepStrictEqual(snapshot.actors[agent.id], actorIdentityForAgent(agent));
}

export class BrokerDurableRecordStore {
  constructor(private readonly options: BrokerDurableRecordStoreOptions) {}

  readonly upsertNode = async (
    node: NodeDefinition,
    options: DurableCommitOptions = {},
  ): Promise<void> => {
    await this.options.durableStore.runWrite(async () => {
      await this.options.durableStore.commitEntries(
        { kind: "node.upsert", node },
        async () => {
          await this.options.runtime.upsertNode(node);
        },
        options,
      );
    });
  };

  readonly upsertActor = async (
    actor: RuntimeActorIdentity,
    options: DurableCommitOptions = {},
  ): Promise<void> => {
    await this.options.durableStore.runWrite(async () => {
      const stamped = withCreatedAt(
        actor,
        this.options.runtime.peek().actors[actor.id]?.createdAt,
      );
      await this.options.durableStore.commitEntries(
        { kind: "actor.upsert", actor: stamped },
        async () => {
          await this.options.runtime.upsertActor(stamped);
        },
        options,
      );
    });
  };

  readonly upsertAgent = async (agent: RuntimeAgentDefinition): Promise<void> => {
    const stamped = withCreatedAt(
      agent,
      this.options.runtime.peek().actors[agent.id]?.createdAt,
    );
    if (isCurrentAgentRecord(this.options.runtime.peek(), stamped)) {
      return;
    }

    await this.options.durableStore.runWrite(async () => {
      if (isCurrentAgentRecord(this.options.runtime.peek(), stamped)) {
        return;
      }

      await this.options.durableStore.commitEntries(
        [
          { kind: "actor.upsert", actor: actorIdentityForAgent(stamped) },
          { kind: "agent.upsert", agent: stamped },
        ],
        async (entries) => {
          if (entries.some((entry) => entry.kind === "actor.upsert")) {
            await this.options.runtime.upsertActor(stamped);
          }
          if (entries.some((entry) => entry.kind === "agent.upsert")) {
            await this.options.runtime.upsertAgent(stamped);
          }
        },
      );
    });
  };

  readonly upsertEndpoint = async (endpoint: AgentEndpoint): Promise<void> => {
    const previous = this.options.runtime.peek().endpoints[endpoint.id];
    if (isDeepStrictEqual(previous, endpoint)) {
      return;
    }

    await this.options.durableStore.runWrite(async () => {
      const current = this.options.runtime.peek().endpoints[endpoint.id];
      if (isDeepStrictEqual(current, endpoint)) {
        return;
      }

      await this.options.durableStore.commitEntries(
        { kind: "agent.endpoint.upsert", endpoint },
        async () => {
          await this.options.runtime.upsertEndpoint(endpoint);
        },
      );
    });
  };

  /**
   * Every canonical conversation listing `actorId`, journaled back with the id
   * removed — membership removal is canonical, not a cascade side effect, so
   * journal rebuilds cannot resurrect the actor through retained rosters.
   * `conversationIds` additionally unions the durable SQLite membership lookup
   * as the delete preimage (belt-and-braces for projection ordering).
   */
  private membershipRemovalEntries(actorId: string): {
    upserts: BrokerJournalEntry[];
    conversationIds: string[];
  } {
    const snapshot = this.options.runtime.peek();
    const memberConversations = Object.values(snapshot.conversations)
      .filter((conversation) => conversation.participantIds.includes(actorId))
      .sort((left, right) => left.id.localeCompare(right.id));
    const conversationIds = new Set(memberConversations.map((conversation) => conversation.id));
    for (const id of this.options.memberConversationIds?.(actorId) ?? []) {
      conversationIds.add(id);
    }
    return {
      upserts: memberConversations.map((conversation) => ({
        kind: "conversation.upsert",
        conversation: {
          ...conversation,
          participantIds: conversation.participantIds.filter((id) => id !== actorId),
        },
      })),
      conversationIds: [...conversationIds].sort(),
    };
  }

  private async applyRegistryDeleteEntries(entries: BrokerJournalEntry[]): Promise<void> {
    for (const entry of entries) {
      switch (entry.kind) {
        case "agent.endpoint.delete":
          this.options.runtime.deleteEndpoint(entry.endpointId);
          break;
        case "agent.delete":
          this.options.runtime.deleteAgent(entry.agentId);
          break;
        case "actor.delete":
          this.options.runtime.deleteActor(entry.actorId);
          break;
        case "conversation.upsert":
          await this.options.runtime.upsertConversation(entry.conversation);
          break;
      }
    }
  }

  private checkEligibility(
    eligible: RegistryDeleteEligibility | undefined,
  ): { ok: boolean; reason?: string } {
    if (!eligible) return { ok: true };
    const verdict = eligible(this.options.runtime.peek());
    if (verdict === true) return { ok: true };
    if (verdict === false) return { ok: false, reason: "not eligible" };
    return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason ?? "not eligible" };
  }

  readonly deleteEndpoint = async (
    endpointId: string,
    options: RegistryDeleteOptions = {},
  ): Promise<RegistryDeleteResult> => {
    return this.options.durableStore.runWrite(async () => {
      const verdict = this.checkEligibility(options.eligible);
      if (!verdict.ok) return { deleted: false, reason: verdict.reason };
      // Capture the agent preimage before the delete so the conversation
      // projection can target just that agent's rooms.
      const agentId = this.options.runtime.peek().endpoints[endpointId]?.agentId;
      await this.options.durableStore.commitEntries(
        { kind: "agent.endpoint.delete", endpointId, ...(agentId ? { agentId } : {}) },
        async () => {
          this.options.runtime.deleteEndpoint(endpointId);
        },
      );
      return { deleted: true };
    });
  };

  readonly deleteAgent = async (
    agentId: string,
    options: RegistryDeleteOptions = {},
  ): Promise<RegistryDeleteResult> => {
    return this.options.durableStore.runWrite(async () => {
      const verdict = this.checkEligibility(options.eligible);
      if (!verdict.ok) return { deleted: false, reason: verdict.reason };
      const snapshot = this.options.runtime.peek();
      const entries: BrokerJournalEntry[] = [];
      // Each surviving endpoint gets its own tombstone before agent.delete —
      // endpoint upserts key independently, so compaction cannot resurrect
      // them through a cross-key cascade.
      for (const endpoint of Object.values(snapshot.endpoints)) {
        if (endpoint.agentId === agentId) {
          entries.push({ kind: "agent.endpoint.delete", endpointId: endpoint.id, agentId });
        }
      }
      const { upserts, conversationIds } = this.membershipRemovalEntries(agentId);
      entries.push(...upserts);
      entries.push({ kind: "agent.delete", agentId, conversationIds });
      await this.options.durableStore.commitEntries(
        entries,
        (accepted) => this.applyRegistryDeleteEntries(accepted),
      );
      return { deleted: true };
    });
  };

  readonly deleteActor = async (
    actorId: string,
    options: RegistryDeleteOptions = {},
  ): Promise<RegistryDeleteResult> => {
    return this.options.durableStore.runWrite(async () => {
      const verdict = this.checkEligibility(options.eligible);
      if (!verdict.ok) return { deleted: false, reason: verdict.reason };
      const { upserts, conversationIds } = this.membershipRemovalEntries(actorId);
      const entries: BrokerJournalEntry[] = [
        ...upserts,
        { kind: "actor.delete", actorId, conversationIds },
      ];
      await this.options.durableStore.commitEntries(
        entries,
        (accepted) => this.applyRegistryDeleteEntries(accepted),
      );
      return { deleted: true };
    });
  };

  /**
   * Drop retired actor ids from a roster about to be journaled. Called inside
   * the serialized writer so the check sees the latest tombstone set.
   */
  private filterRetiredParticipants(conversation: ConversationDefinition): ConversationDefinition {
    if (!conversation.participantIds.some((id) => this.options.runtime.isRetiredActor(id))) {
      return conversation;
    }
    const participantIds = conversation.participantIds
      .filter((id) => !this.options.runtime.isRetiredActor(id));
    reportRetiredRosterFilter(
      conversation.id,
      conversation.participantIds.filter((id) => !participantIds.includes(id)),
    );
    return { ...conversation, participantIds };
  }

  readonly upsertConversation = async (conversation: ConversationDefinition): Promise<void> => {
    await this.options.durableStore.runWrite(async () => {
      const filtered = this.filterRetiredParticipants(conversation);
      await this.options.durableStore.commitEntries(
        { kind: "conversation.upsert", conversation: filtered },
        async () => {
          await this.options.runtime.upsertConversation(filtered);
        },
      );
    });
  };

  /**
   * Canonical read-modify-write for one conversation: `mutate` runs inside the
   * serialized durable writer against the latest record, so a roster (or
   * invite set, or title) computed there can never overwrite a concurrent
   * write — a retention membership removal, another invite redemption — with
   * a stale preimage. Returning null/undefined declines the write. When the
   * record does not exist, `mutate` receives undefined and may still return a
   * record to create it under this id — the written record's id must match
   * `conversationId`.
   */
  readonly updateConversation = async (
    conversationId: string,
    mutate: ConversationMutator,
  ): Promise<UpdateConversationResult> => {
    return this.options.durableStore.runWrite(async () => {
      const current = this.options.runtime.peek().conversations[conversationId];
      const next = mutate(current);
      if (!next) return { updated: false, conversation: current ?? null };
      if (next.id !== conversationId) {
        throw new Error(`updateConversation(${conversationId}) cannot change the record id`);
      }
      // Same fence as whole-record upserts: a mutator's merged roster can
      // still name a retired actor (e.g. via an equivalent conversation's
      // stale roster).
      const filtered = this.filterRetiredParticipants(next);
      await this.options.durableStore.commitEntries(
        { kind: "conversation.upsert", conversation: filtered },
        async () => {
          await this.options.runtime.upsertConversation(filtered);
        },
      );
      return { updated: true, conversation: filtered };
    });
  };

  /** Patch only the title at the canonical writer boundary, after earlier writes. */
  readonly setConversationTitle = async (
    conversationId: string,
    named: string,
  ): Promise<ConversationDefinition | null> => this.options.durableStore.runWrite(async () => {
    const current = this.options.runtime.peek().conversations[conversationId];
    if (!current) return null;
    const conversation: ConversationDefinition = {
      ...current,
      // Clearing relinquishes operator ownership but retains the current text
      // until automatic derivation next produces a title.
      title: named || current.title,
      metadata: named
        ? markOperatorTitled(current.metadata, Date.now())
        : clearOperatorTitle(current.metadata),
    };
    await this.options.durableStore.commitEntries(
      { kind: "conversation.upsert", conversation },
      async () => { await this.options.runtime.upsertConversation(conversation); },
    );
    return conversation;
  });

  /** Patch shared pins under the same lock as other conversation mutations. */
  readonly updateConversationPins = async (conversationId: string, actorId: string, change: unknown): Promise<ConversationDefinition | null> =>
    this.options.durableStore.runWrite(async () => {
      const current = this.options.runtime.peek().conversations[conversationId];
      if (!current) return null;
      const pins = applyChatPinChange(current.metadata?.chatPins, change, actorId, Date.now());
      const conversation: ConversationDefinition = { ...current, metadata: { ...current.metadata, chatPins: pins } };
      await this.options.durableStore.commitEntries({ kind: "conversation.upsert", conversation }, async () => {
        await this.options.runtime.upsertConversation(conversation);
      });
      return conversation;
    });

  readonly upsertBinding = async (binding: ConversationBinding): Promise<void> => {
    await this.options.durableStore.runWrite(async () => {
      await this.options.durableStore.commitEntries(
        { kind: "binding.upsert", binding },
        async () => {
          await this.options.runtime.upsertBinding(binding);
        },
      );
    });
  };

  readonly recordCollaboration = async (
    record: CollaborationRecord,
    options: DurableCommitOptions = {},
  ): Promise<BrokerJournalEntry[]> => {
    assertValidCollaborationRecord(record);
    return this.options.durableStore.runWrite(async () => {
      return this.options.durableStore.commitEntries(
        { kind: "collaboration.record", record },
        async () => {
          await this.options.runtime.upsertCollaboration(record);
        },
        options,
      );
    });
  };

  readonly appendCollaborationEvent = async (
    event: CollaborationEvent,
    options: DurableCommitOptions = {},
  ): Promise<BrokerJournalEntry[]> => {
    return this.options.durableStore.runWrite(async () => {
      const record = this.options.runtime.collaborationRecord(event.recordId);
      if (!record) {
        throw new Error(`unknown collaboration record: ${event.recordId}`);
      }
      assertValidCollaborationEvent(event, record);

      return this.options.durableStore.commitEntries(
        { kind: "collaboration.event.record", event },
        async () => {
          await this.options.runtime.appendCollaborationEvent(event);
        },
        options,
      );
    });
  };

  readonly respondToChatQuestion = async (channelId: string, questionId: string, actorId: string, isOperator: boolean, change: unknown): Promise<CollaborationRecord> =>
    this.options.durableStore.runWrite(async () => {
      const snapshot = this.options.runtime.peek();
      const channel = snapshot.conversations[channelId];
      const record = this.options.runtime.collaborationRecord(questionId);
      const conversation = record?.conversationId ? snapshot.conversations[record.conversationId] : undefined;
      if (!channel || channel.kind !== "channel" || !record || record.kind !== "question"
        || !(record.conversationId === channelId || (conversation?.kind === "thread" && conversation.parentConversationId === channelId))) {
        throw new ChatQuestionError(404, "Question is not available in this channel.");
      }
      if (channel.authorityNodeId && channel.authorityNodeId !== this.options.localNodeId) throw new ChatQuestionError(409, "Respond on the channel authority host.");
      if (!isOperator && !channel.participantIds.includes(actorId)) throw new ChatQuestionError(403, "You are no longer a member of this channel.");
      const next = transitionChatQuestion(record, actorId, change, Date.now());
      assertValidCollaborationRecord(next.record);
      assertValidCollaborationEvent(next.event, next.record);
      await this.options.durableStore.commitEntries([
        { kind: "collaboration.record", record: next.record },
        { kind: "collaboration.event.record", event: next.event },
      ], async () => {
        await this.options.runtime.upsertCollaboration(next.record);
        await this.options.runtime.appendCollaborationEvent(next.event);
      });
      return next.record;
    });

  readonly correctMessage = async (channelId: string, messageId: string, actorId: string, canModerate: boolean, change: unknown): Promise<MessageRecord> =>
    this.options.durableStore.runWrite(async () => {
      const snapshot = this.options.runtime.peek();
      const message = await readMessageRecord(snapshot.messages, messageId);
      const conversation = message ? snapshot.conversations[message.conversationId] : undefined;
      if (!message || (message.conversationId !== channelId && !(conversation?.kind === "thread" && conversation.parentConversationId === channelId))) {
        throw new ChatMessageCorrectionError(404, "Message is not available in this channel.");
      }
      const next = correctChatMessage(message, change, actorId, canModerate, Date.now());
      await this.options.durableStore.commitEntries({ kind: "message.record", message: next }, async committed => {
        const recorded = committed.find(entry => entry.kind === "message.record");
        await this.options.runtime.correctMessage(recorded?.kind === "message.record" ? recorded.message : next);
      });
      return next;
    });

  readonly recordMessage = async (
    message: MessageRecord,
    options: {
      localOnly?: boolean;
      dedupeExisting?: boolean;
      enqueueProjection?: boolean;
    } = {},
  ): Promise<{ deliveries: DeliveryIntent[]; entries: BrokerJournalEntry[]; duplicate?: MessageRecord }> => {
    return this.options.durableStore.runWrite(async () => {
      if (options.dedupeExisting) {
        const messages = this.options.runtime.peek().messages;
        if (!messages) throw new Error("Message history is unavailable for duplicate validation");
        const existing = await readMessageRecord(messages, message.id);
        if (existing) {
          if (!isIdempotentMessageRetry(existing, message)) {
            throw new Error(`message id ${message.id} is already assigned to a different record`);
          }
          return { deliveries: [], entries: [], duplicate: existing };
        }
      }
      const replySnapshot = this.options.runtime.peek();
      const replyIdentity = message.metadata?.completionReply as { flightId?: string; invocationId?: string } | undefined;
      const durableReplyFlight = replyIdentity?.flightId ? this.options.completionFlight?.(replyIdentity.flightId) : undefined;
      if (replyIdentity && (this.options.completionCurrentFlight ?? this.options.runtime.flightForInvocation?.bind(this.options.runtime))?.(replyIdentity.invocationId ?? "")?.id !== replyIdentity.flightId) {
        throw new Error("completion_flight_not_current");
      }
      assertExplicitReplyAdmission(message, durableReplyFlight ? { ...replySnapshot,
        flights: { ...replySnapshot.flights, [durableReplyFlight.id]: durableReplyFlight } } : replySnapshot, this.options.completionFlight);
      const deliveries = this.options.runtime.planMessage(message, {
        localOnly: options.localOnly,
      });
      const entries = await this.options.durableStore.commitEntries(
        [
          { kind: "message.record", message },
          { kind: "deliveries.record", deliveries },
        ],
        async (committed) => {
          const recorded = committed.find((entry) => entry.kind === "message.record");
          await this.options.runtime.commitMessage(recorded?.kind === "message.record" ? recorded.message : message, deliveries);
        },
        { enqueueProjection: options.enqueueProjection },
      );
      return { deliveries, entries };
    });
  };

  readonly recordInvocation = async (
    invocation: InvocationRequest,
    options: {
      flight?: FlightRecord;
      dispatchJob?: BrokerInvocationDispatchJob;
      createDispatchJob?: (flight: FlightRecord) => BrokerInvocationDispatchJob;
      enqueueProjection?: boolean;
      message?: MessageRecord;
      receiptMessage?: MessageRecord;
      workItem?: DeliveryWorkItemResolution["pendingCreation"];
    } = {},
  ): Promise<{ flight: FlightRecord; dispatchJob?: BrokerInvocationDispatchJob; entries: BrokerJournalEntry[] }> => {
    return this.options.durableStore.runWrite(async () => {
      const runtimeSnapshot = this.options.runtime.peek();
      const relatedParentId = (invocation.metadata?.completionRelation as { parentFlightId?: string } | undefined)?.parentFlightId;
      const durableParent = relatedParentId ? this.options.completionFlight?.(relatedParentId) : undefined;
      const snapshot = durableParent ? { ...runtimeSnapshot, flights: { ...runtimeSnapshot.flights, [durableParent.id]: durableParent } } : runtimeSnapshot;
      const existing = this.options.completionInvocation?.(invocation.id) ?? snapshot.invocations[invocation.id];
      if (existing) {
        const acceptedFlightId = existing.metadata?.completionAcceptedFlightId;
        const existingFlight = typeof acceptedFlightId === "string"
          ? this.options.completionFlight?.(acceptedFlightId) ?? snapshot.flights[acceptedFlightId]
          : Object.values(snapshot.flights).find(candidate => candidate.invocationId === invocation.id);
        if (!existingFlight || !isIdempotentInvocationRetry(existing, invocation)) {
          throw new Error(`invocation id ${invocation.id} is already assigned to a different record`);
        }
        const jobId = options.dispatchJob?.id ?? options.createDispatchJob?.(existingFlight).id;
        const dispatchJob = jobId ? this.options.invocationDispatchJobFor?.(jobId) ?? undefined : undefined;
        return { flight: existingFlight, dispatchJob, entries: [] };
      }
      const plannedFlight = options.flight ?? this.options.runtime.planInvocation(invocation);
      let flight = options.flight ? plannedFlight : {
        ...plannedFlight,
        metadata: { ...plannedFlight.metadata, dispatchOutcome: { status: "not_submitted", checkedAt: plannedFlight.startedAt } },
      };
      const dispatchJob = options.dispatchJob ?? options.createDispatchJob?.(flight);
      if (!options.flight && dispatchJob) flight = {
        ...flight, metadata: { ...flight.metadata, dispatchOutcome: {
          status: "not_submitted", checkedAt: Math.max(flight.startedAt ?? invocation.createdAt, dispatchJob.createdAt),
        } },
      };
      const completion = prepareCompletionAdmission(invocation, flight, snapshot, this.options.localNodeId);
      flight = completion.flight;
      if (completion.parent && (!this.options.runtime.upsertFlight
        || (this.options.completionCurrentFlight ?? this.options.runtime.flightForInvocation?.bind(this.options.runtime))?.(completion.parent.invocationId)?.id !== completion.parent.id)) {
        throw new Error("completion_parent_not_current");
      }
      // A reused client message can predate this request and retain its original
      // ID/metadata. The invocation is always the canonical acceptance witness,
      // even when this writer also owns the message's conversation.
      const receiptMessage = options.receiptMessage ?? options.message;
      if (invocation.metadata?.completion || invocation.metadata?.completionRelation) invocation = { ...invocation, metadata: {
        ...invocation.metadata, completionAcceptedFlightId: flight.id,
        ...(invocation.metadata?.completion ? { completionFlightId: flight.id } : {}),
      } };
      const recordedInvocation = receiptMessage ? {
        ...invocation, metadata: { ...invocation.metadata,
          acceptedDeliveryReceipt: messageWithAcceptedFlight(receiptMessage, flight) },
      } : invocation;
      const work = options.workItem;
      const existingWork = work ? this.options.runtime.collaborationRecord(work.record.id) : undefined;
      if (existingWork && !existingDeliveryWorkItemMatches(existingWork, work!.record)) {
        throw new Error(`work item id ${work!.record.id} changed before command acceptance`);
      }
      if (work && !existingWork) {
        assertValidCollaborationRecord(work.record);
        assertValidCollaborationEvent(work.event, work.record);
      }
      const message = options.message ? messageWithAcceptedFlight(options.message, flight) : undefined;
      const existingMessage = message ? await readMessageRecord(snapshot.messages, message.id) : undefined;
      if (existingMessage && !isIdempotentMessageRetry(existingMessage, message!)) {
        throw new Error(`message id ${message!.id} is already assigned to a different record`);
      }
      const deliveries = message && !existingMessage ? this.options.runtime.planMessage(message) : [];
      const entriesToCommit: BrokerJournalEntry[] = [
        ...(work && !existingWork ? [
          { kind: "collaboration.record" as const, record: work.record },
          { kind: "collaboration.event.record" as const, event: work.event },
        ] : []),
        ...(message && !existingMessage ? [
          { kind: "message.record" as const, message },
          { kind: "deliveries.record" as const, deliveries },
        ] : []),
        ...(completion.parent ? [{ kind: "flight.record" as const, flight: completion.parent, preserveCurrent: true }] : []),
        { kind: "invocation.record", invocation: recordedInvocation },
        ...(dispatchJob ? [{ kind: "invocation.dispatch_job.record" as const, job: dispatchJob }] : []),
        { kind: "flight.record", flight },
      ];
      const entries = await this.options.durableStore.commitEntries(
        entriesToCommit,
        async (committed) => {
          if (work && !existingWork) {
            await this.options.runtime.upsertCollaboration(work.record);
            await this.options.runtime.appendCollaborationEvent(work.event);
          }
          if (message && !existingMessage) {
            const recorded = committed.find(entry => entry.kind === "message.record");
            await this.options.runtime.commitMessage(recorded?.kind === "message.record" ? recorded.message : message, deliveries);
          }
          if (completion.parent) await this.options.runtime.upsertFlight!(completion.parent, { preserveCurrent: true });
          await this.options.runtime.commitInvocation(recordedInvocation, flight);
          this.options.knownInvocations.set(invocation.id, recordedInvocation);
        },
        { enqueueProjection: options.enqueueProjection },
      );
      return { flight, dispatchJob, entries };
    });
  };

  readonly recordInvocationDispatchJob = async (
    job: BrokerInvocationDispatchJob,
    options: DurableCommitOptions = {},
  ): Promise<BrokerJournalEntry[]> => {
    return this.options.durableStore.runWrite(async () => {
      return this.options.durableStore.commitEntries(
        { kind: "invocation.dispatch_job.record", job },
        async () => {},
        options,
      );
    });
  };

  /** Compare and append under the canonical writer, never across an awaited effect. */
  readonly recordInvocationDispatchJobIf = async (
    job: BrokerInvocationDispatchJob,
    eligible: (current: BrokerInvocationDispatchJob | null) => boolean,
    options: DurableCommitOptions = {},
  ): Promise<BrokerJournalEntry[] | null> => {
    if (!this.options.invocationDispatchJobFor) {
      throw new Error("dispatch job conditional writes require canonical job lookup");
    }
    return this.options.durableStore.runWrite(async () => {
      if (!eligible(this.options.invocationDispatchJobFor!(job.id))) return null;
      return this.options.durableStore.commitEntries(
        { kind: "invocation.dispatch_job.record", job },
        async () => {},
        options,
      );
    });
  };
}
