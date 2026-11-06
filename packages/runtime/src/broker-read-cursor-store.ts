import { applyChatAttentionPreferenceChange, type ChatAttentionPreferences } from "@openscout/protocol";
import { selectMessageRecordsAsync } from "./broker-message-records.js";
import type {
  ConversationDefinition,
  ConversationReadCursor,
  DeliveryIntent,
  MessageRecord,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";
import type { DeliveryStatusUpdateInput } from "./broker-delivery-store.js";

type DurableStore = {
  runWrite<T>(work: () => Promise<T>): Promise<T>;
  commitEntries(
    entries: BrokerJournalEntry | BrokerJournalEntry[],
    applyRuntime: (entries: BrokerJournalEntry[]) => Promise<void>,
    options?: { enqueueProjection?: boolean },
  ): Promise<BrokerJournalEntry[]>;
};

type ReadCursorRuntime = {
  snapshot(): {
    messages: Record<string, MessageRecord>;
    readCursors: Record<string, ConversationReadCursor>;
  };
  conversation(conversationId: string): ConversationDefinition | undefined;
  readCursor(conversationId: string, actorId: string): ConversationReadCursor | undefined;
  upsertReadCursor(cursor: ConversationReadCursor): Promise<void>;
};

type ReadCursorProjection = {
  latestThreadSeq(conversationId: string): Promise<number>;

};

export type ReadCursorResolveInput = {
  actorId?: string;
  readerNodeId?: string;
  lastReadMessageId?: string;
  lastReadSeq?: number;
  lastReadAt?: number;
  metadata?: Record<string, unknown>;
};

export type BrokerReadCursorStoreOptions = {
  runtime: ReadCursorRuntime;
  projection: ReadCursorProjection;
  durableStore: DurableStore;
  operatorActorId: string;
  nodeId: string;
  ensureActor: (actorId: string) => Promise<void>;
  /**
   * Point read of any durable message. History rotation leaves only the live
   * window in the runtime; an older message lives in SQLite or the history
   * archive and is still a valid read position.
   */
  readMessage: (messageId: string) => Promise<MessageRecord | undefined>;
  journal: { visitDeliveries(visitor: (delivery: DeliveryIntent) => void | Promise<void>, options?: { activeOnly?: boolean }): Promise<void> };
  updateDeliveryStatusIf: (
    input: DeliveryStatusUpdateInput,
    eligible: (current: DeliveryIntent) => boolean | Promise<boolean>,
  ) => Promise<boolean>;
};

function finitePositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

const readableDeliveryStatuses = new Set<DeliveryIntent["status"]>([
  "pending",
  "accepted",
  "deferred",
  "sent",
]);

const readDeliveryReasons = new Set<DeliveryIntent["reason"]>([
  "conversation_visibility",
  "direct_message",
  "mention",
  "thread_reply",
]);

export class BrokerReadCursorStore {
  constructor(private readonly options: BrokerReadCursorStoreOptions) {}

  readonly listForConversation = (conversationId: string): ConversationReadCursor[] => {
    return Object.values(this.options.runtime.snapshot().readCursors)
      .filter((cursor) => cursor.conversationId === conversationId)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  };

  readonly resolve = async (
    conversationId: string,
    input: ReadCursorResolveInput,
  ): Promise<ConversationReadCursor> => {
    const conversation = this.options.runtime.conversation(conversationId);
    if (!conversation) {
      throw new Error(`conversation ${conversationId} not found`);
    }

    const actorId = input.actorId?.trim() || this.options.operatorActorId;
    await this.options.ensureActor(actorId);

    const explicitMessageId = input.lastReadMessageId?.trim();
    const lastReadMessage = explicitMessageId
      ? await this.options.readMessage(explicitMessageId)
      : await this.latestMessageForConversation(conversationId);

    if (explicitMessageId && !lastReadMessage) {
      throw new Error(`message ${explicitMessageId} not found`);
    }
    if (lastReadMessage && lastReadMessage.conversationId !== conversationId) {
      throw new Error(`message ${lastReadMessage.id} does not belong to ${conversationId}`);
    }

    const latestThreadSeq = await this.options.projection.latestThreadSeq(conversationId);
    const providedSeq = finitePositiveNumber(input.lastReadSeq);
    let lastReadSeq = providedSeq
      ?? (!explicitMessageId && latestThreadSeq > 0 ? latestThreadSeq : undefined);
    let lastReadAt = finitePositiveNumber(input.lastReadAt) ?? Date.now();
    let lastReadMessageId = lastReadMessage?.id;

    const current = this.options.runtime.readCursor(conversationId, actorId);
    if (current) {
      if (await this.isBehind({ lastReadSeq, lastReadMessageId }, current)) {
        lastReadMessageId = current.lastReadMessageId;
        lastReadSeq = current.lastReadSeq;
        lastReadAt = current.lastReadAt;
      }
    }

    const boundary = lastReadMessageId === lastReadMessage?.id
      ? lastReadMessage
      : lastReadMessageId ? await this.options.readMessage(lastReadMessageId) : undefined;
    return {
      conversationId,
      actorId,
      readerNodeId: input.readerNodeId?.trim() || this.options.nodeId,
      lastReadMessageId,
      lastReadSeq,
      lastReadAt,
      updatedAt: Date.now(),
      metadata: {
        ...current?.metadata,
        ...input.metadata,
        // Canonical message position survives paging; callers cannot supply it.
        scoutReadBoundary: boundary ? { id: boundary.id, createdAt: boundary.createdAt } : null,
      },
    };
  };

  readonly record = async (cursor: ConversationReadCursor): Promise<void> => {
    await this.options.durableStore.runWrite(async () => {
      // Resolution happens before the write queue. Another device can advance
      // the cursor in between; re-check inside the canonical writer's lock.
      const current = this.options.runtime.readCursor(cursor.conversationId, cursor.actorId);
      if (current && await this.isBehind(cursor, current)) return;
      // A preference write may have happened after read-position resolution.
      // Read acknowledgements never own or replace personal attention settings.
      if (current?.metadata?.chatAttention !== undefined) {
        cursor = { ...cursor, metadata: { ...cursor.metadata, chatAttention: current.metadata.chatAttention } };
      }
      await this.options.durableStore.commitEntries(
        { kind: "conversation.read_cursor.upsert", cursor },
        async () => {
          await this.options.runtime.upsertReadCursor(cursor);
        },
      );
    });
  };

  readonly updatePreferences = async (
    conversationId: string, actorId: string, change: unknown,
  ): Promise<ChatAttentionPreferences> => {
    if (!actorId.trim() || !this.options.runtime.conversation(conversationId)) throw new Error("Conversation and actor are required.");
    // Validate the request before creating any identity or durable record.
    applyChatAttentionPreferenceChange(undefined, change);
    await this.options.ensureActor(actorId);
    return this.options.durableStore.runWrite(async () => {
      const current = this.options.runtime.readCursor(conversationId, actorId);
      const preferences = applyChatAttentionPreferenceChange(current?.metadata?.chatAttention, change);
      const cursor: ConversationReadCursor = {
        ...(current ?? { conversationId, actorId, lastReadAt: 0 }),
        updatedAt: Date.now(), metadata: { ...current?.metadata, chatAttention: preferences },
      };
      await this.options.durableStore.commitEntries(
        { kind: "conversation.read_cursor.upsert", cursor },
        async () => { await this.options.runtime.upsertReadCursor(cursor); },
      );
      return preferences;
    });
  };

  readonly acknowledgeDeliveries = async (cursor: ConversationReadCursor): Promise<number> => {
    const boundaryMessage = cursor.lastReadMessageId
      ? await this.options.readMessage(cursor.lastReadMessageId)
      : await this.latestMessageForConversation(cursor.conversationId);
    if (!boundaryMessage) {
      return 0;
    }

    let acknowledged = 0;

    const eligible = async (delivery: DeliveryIntent): Promise<boolean> => {
      if (delivery.targetId !== cursor.actorId || !delivery.messageId) return false;
      if (!readableDeliveryStatuses.has(delivery.status) || !readDeliveryReasons.has(delivery.reason)) return false;
      const message = await this.options.readMessage(delivery.messageId);
      return Boolean(message && message.conversationId === cursor.conversationId
        && message.createdAt <= boundaryMessage.createdAt);
    };
    await this.options.journal.visitDeliveries(async (delivery) => {
      if (!await eligible(delivery)) return;
      const changed = await this.options.updateDeliveryStatusIf({
        deliveryId: delivery.id,
        status: "acknowledged",
        metadata: {
          acknowledgedByReadCursor: true,
          readAt: cursor.lastReadAt,
          readCursorUpdatedAt: cursor.updatedAt,
          readMessageId: cursor.lastReadMessageId,
        },
        leaseOwner: null,
        leaseExpiresAt: null,
      }, eligible);
      if (changed) acknowledged += 1;
    }, { activeOnly: true });

    return acknowledged;
  };

  private async latestMessageForConversation(conversationId: string): Promise<MessageRecord | undefined> {
    return (await selectMessageRecordsAsync(this.options.runtime.snapshot().messages ?? {}, 1,
      (left, right) => right.createdAt - left.createdAt,
      (message) => message.conversationId === conversationId,{selection:{conversationIds:[conversationId],newestFirst:true}}))[0];
  }

  private async messageCreatedAt(messageId: string | undefined): Promise<number | undefined> {
    return messageId ? (await this.options.readMessage(messageId))?.createdAt : undefined;
  }

  private async cursorProgressRank(cursor: {
    lastReadSeq?: number;
    lastReadMessageId?: string;
  }): Promise<number | undefined> {
    if (typeof cursor.lastReadSeq === "number" && Number.isFinite(cursor.lastReadSeq)) {
      return cursor.lastReadSeq;
    }
    return this.messageCreatedAt(cursor.lastReadMessageId);
  }

  private async isBehind(next: { lastReadSeq?: number; lastReadMessageId?: string }, current: { lastReadSeq?: number; lastReadMessageId?: string }): Promise<boolean> {
    if (Number.isFinite(next.lastReadSeq) && Number.isFinite(current.lastReadSeq)) {
      return next.lastReadSeq! < current.lastReadSeq!;
    }
    if (next.lastReadMessageId && current.lastReadMessageId) {
      const [nextMessage, currentMessage] = await Promise.all([
        this.options.readMessage(next.lastReadMessageId),
        this.options.readMessage(current.lastReadMessageId),
      ]);
      if (nextMessage && currentMessage) {
        return nextMessage.createdAt < currentMessage.createdAt
          || (nextMessage.createdAt === currentMessage.createdAt && nextMessage.id < currentMessage.id);
      }
    }
    const [nextRank, currentRank] = await Promise.all([this.cursorProgressRank(next), this.cursorProgressRank(current)]);
    return currentRank !== undefined && (nextRank === undefined || nextRank < currentRank);
  }
}
