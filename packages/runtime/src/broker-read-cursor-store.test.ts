import { describe, expect, test } from "bun:test";

import type {
  ConversationDefinition,
  ConversationReadCursor,
  DeliveryIntent,
  MessageRecord,
} from "@openscout/protocol";

import { createInMemoryControlRuntime } from "./broker.js";
import type { BrokerJournalEntry } from "./broker-journal.js";
import { BrokerDurableStore } from "./broker-durable-store.js";
import { BrokerReadCursorStore } from "./broker-read-cursor-store.js";

function testConversation(): ConversationDefinition {
  return {
    id: "conversation-1",
    kind: "direct",
    title: "Conversation One",
    visibility: "workspace",
    shareMode: "local",
    authorityNodeId: "node-1",
    participantIds: ["operator", "agent-1"],
    metadata: {},
  };
}

function testMessage(input: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: "message-1",
    conversationId: "conversation-1",
    actorId: "operator",
    originNodeId: "node-1",
    class: "agent",
    body: "hello",
    visibility: "workspace",
    policy: "durable",
    createdAt: 100,
    ...input,
  };
}

function testDelivery(input: Partial<DeliveryIntent> = {}): DeliveryIntent {
  return {
    id: "delivery-1",
    messageId: "message-1",
    targetId: "agent-1",
    targetKind: "agent",
    transport: "local_socket",
    reason: "direct_message",
    policy: "best_effort",
    status: "pending",
    ...input,
  };
}

function createStore(input: {
  latestThreadSeq?: number;
  deliveries?: DeliveryIntent[];
  /** Messages that history rotation moved out of the runtime's live window. */
  durableHistory?: MessageRecord[];
} = {}) {
  const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });
  const durableHistory = new Map((input.durableHistory ?? []).map((message) => [message.id, message]));
  const appended: BrokerJournalEntry[][] = [];
  const ensuredActors: string[] = [];
  const deliveryUpdates: unknown[] = [];
  const durableStore = new BrokerDurableStore({
    journal: {
      async appendEntries(entries) {
        appended.push(entries);
        return entries;
      },
    },
    projection: {
      async applyEntries() {
        return [];
      },
    },
    threadEvents: {
      publish() {},
    },
  });
  const store = new BrokerReadCursorStore({
    runtime,
    durableStore,
    projection: {
      async latestThreadSeq() {
        return input.latestThreadSeq ?? 0;
      },

    },
    operatorActorId: "operator",
    nodeId: "node-1",
    ensureActor: async (actorId) => {
      ensuredActors.push(actorId);
    },
    readMessage: async (messageId) => await runtime.readMessage(messageId) ?? durableHistory.get(messageId),
    journal: {
      async visitDeliveries(visitor) {
        for (const delivery of input.deliveries ?? []) await visitor(delivery);
      },
    },
    updateDeliveryStatusIf: async (update, eligible) => {
      const current = input.deliveries?.find((delivery) => delivery.id === update.deliveryId);
      if (!current || !await eligible(current)) return false;
      deliveryUpdates.push(update);
      return true;
    },
  });

  return {
    runtime,
    appended,
    ensuredActors,
    deliveryUpdates,
    store,
  };
}

describe("BrokerReadCursorStore", () => {
  test("preference writes preserve unread state and concurrent independent choices", async () => {
    const { runtime, store, appended, deliveryUpdates } = createStore();
    await runtime.upsertConversation(testConversation());
    await runtime.commitMessage(testMessage(), []);
    await store.updatePreferences("conversation-1", "agent-1", { notificationMode: "mentions" });
    expect(runtime.readCursor("conversation-1", "agent-1")?.lastReadMessageId).toBeUndefined();
    expect(runtime.readCursor("conversation-1", "agent-1")?.lastReadAt).toBe(0);
    const pendingRead = await store.resolve("conversation-1", { actorId: "agent-1", lastReadMessageId: "message-1" });
    await Promise.all([
      store.updatePreferences("conversation-1", "agent-1", { threadId: "thread-a", following: true }),
      store.updatePreferences("conversation-1", "agent-1", { threadId: "thread-b", following: true }),
      store.updatePreferences("conversation-1", "agent-1", { messageId: "message-1", saved: true }),
    ]);
    await store.record(pendingRead);
    expect(runtime.readCursor("conversation-1", "agent-1")?.metadata?.chatAttention).toEqual({
      notificationMode: "mentions", followedThreadIds: ["thread-a", "thread-b"], savedMessageIds: ["message-1"],
    });
    await store.updatePreferences("conversation-1", "agent-1", { notificationMode: "muted" });
    expect(runtime.readCursor("conversation-1", "agent-1")?.lastReadMessageId).toBe("message-1");
    expect(runtime.readCursor("conversation-1", "operator")).toBeUndefined();
    expect(deliveryUpdates).toEqual([]);
    expect(appended.flat().every(entry => entry.kind === "conversation.read_cursor.upsert")).toBe(true);
  });

  test("records read cursors durably and updates runtime state", async () => {
    const { runtime, appended, store } = createStore();
    const cursor: ConversationReadCursor = {
      conversationId: "conversation-1",
      actorId: "agent-1",
      readerNodeId: "node-1",
      lastReadMessageId: "message-1",
      lastReadAt: 200,
      updatedAt: 250,
    };

    await store.record(cursor);

    expect(appended[0]).toEqual([{ kind: "conversation.read_cursor.upsert", cursor }]);
    expect(runtime.readCursor("conversation-1", "agent-1")).toEqual(cursor);
  });

  test("resolves cursors without regressing existing progress", async () => {
    const { runtime, ensuredActors, store } = createStore({ latestThreadSeq: 5 });
    await runtime.upsertConversation(testConversation());
    await runtime.commitMessage(testMessage({ id: "message-1", createdAt: 100 }), []);
    await runtime.commitMessage(testMessage({ id: "message-2", createdAt: 200 }), []);
    await runtime.upsertReadCursor({
      conversationId: "conversation-1",
      actorId: "agent-1",
      readerNodeId: "node-1",
      lastReadMessageId: "message-2",
      lastReadSeq: 10,
      lastReadAt: 300,
      updatedAt: 350,
    });

    const cursor = await store.resolve("conversation-1", {
      actorId: "agent-1",
      lastReadSeq: 5,
      lastReadAt: 150,
    });

    expect(ensuredActors).toEqual(["agent-1"]);
    expect(cursor).toEqual(expect.objectContaining({
      conversationId: "conversation-1",
      actorId: "agent-1",
      readerNodeId: "node-1",
      lastReadMessageId: "message-2",
      lastReadSeq: 10,
      lastReadAt: 300,
    }));
  });

  test("acknowledges readable deliveries at or before the cursor boundary", async () => {
    const deliveries = [
      testDelivery({ id: "delivery-read", messageId: "message-1", status: "pending" }),
      testDelivery({ id: "delivery-unread", messageId: "message-2", status: "pending" }),
      testDelivery({ id: "delivery-completed", messageId: "message-1", status: "completed" }),
    ];
    const { runtime, deliveryUpdates, store } = createStore({ deliveries });
    await runtime.upsertConversation(testConversation());
    await runtime.commitMessage(testMessage({ id: "message-1", createdAt: 100 }), []);
    await runtime.commitMessage(testMessage({ id: "message-2", createdAt: 200 }), []);

    const acknowledged = await store.acknowledgeDeliveries({
      conversationId: "conversation-1",
      actorId: "agent-1",
      readerNodeId: "node-1",
      lastReadMessageId: "message-1",
      lastReadAt: 300,
      updatedAt: 350,
    });

    expect(acknowledged).toBe(1);
    expect(deliveryUpdates).toEqual([
      expect.objectContaining({
        deliveryId: "delivery-read",
        status: "acknowledged",
        leaseOwner: null,
        leaseExpiresAt: null,
        metadata: expect.objectContaining({
          acknowledgedByReadCursor: true,
          readAt: 300,
          readCursorUpdatedAt: 350,
          readMessageId: "message-1",
        }),
      }),
    ]);
  });

  test("read boundaries are derived from the canonical message and survive a regressing request", async () => {
    const { runtime, store } = createStore();
    await runtime.upsertConversation(testConversation());
    await runtime.commitMessage(testMessage({ id: "old", createdAt: 100 }), []);
    await runtime.commitMessage(testMessage({ id: "new", createdAt: 200 }), []);
    const first = await store.resolve("conversation-1", {
      actorId: "agent-1", lastReadMessageId: "new",
      metadata: { scoutReadBoundary: { id: "new", createdAt: 999999 } },
    });
    expect(first.metadata?.scoutReadBoundary).toEqual({ id: "new", createdAt: 200 });
    await store.record(first);
    const older = await store.resolve("conversation-1", { actorId: "agent-1", lastReadMessageId: "old" });
    expect(older.lastReadMessageId).toBe("new");
    expect(older.metadata?.scoutReadBoundary).toEqual({ id: "new", createdAt: 200 });
  });

  test("two devices resolving before either writes cannot move read progress backwards", async () => {
    const { runtime, store } = createStore();
    await runtime.upsertConversation(testConversation());
    await runtime.commitMessage(testMessage({ id: "a", createdAt: 200 }), []);
    await runtime.commitMessage(testMessage({ id: "b", createdAt: 200 }), []);
    const earlier = await store.resolve("conversation-1", { actorId: "agent-1", lastReadMessageId: "a" });
    const later = await store.resolve("conversation-1", { actorId: "agent-1", lastReadMessageId: "b" });
    await store.record(later);
    await store.record(earlier);
    expect(runtime.readCursor("conversation-1", "agent-1")?.lastReadMessageId).toBe("b");
    expect((await store.resolve("conversation-1", { actorId: "agent-1", lastReadMessageId: "a" })).lastReadMessageId).toBe("b");
  });

  // A room whose messages all predate the rotation cutoff has none of them in
  // the runtime. Its first read named a message SQLite still held, and the
  // runtime answered "not found".
  test("a message rotated out of the runtime window is still a valid read position", async () => {
    const rotated = testMessage({ id: "m-client-rotated", createdAt: 100 });
    const deliveries = [testDelivery({ id: "delivery-before", messageId: "m-protected", targetId: "operator", status: "pending" })];
    const { runtime, store, deliveryUpdates } = createStore({ durableHistory: [rotated], deliveries });
    await runtime.upsertConversation(testConversation());
    // An active delivery keeps its own message in the live window.
    await runtime.commitMessage(testMessage({ id: "m-protected", createdAt: 50 }), []);
    expect(await runtime.readMessage("m-client-rotated")).toBeUndefined();

    const cursor = await store.resolve("conversation-1", { actorId: "operator", lastReadMessageId: "m-client-rotated" });
    expect(cursor.lastReadMessageId).toBe("m-client-rotated");
    expect(cursor.metadata?.scoutReadBoundary).toEqual({ id: "m-client-rotated", createdAt: 100 });
    await store.record(cursor);
    expect(runtime.readCursor("conversation-1", "operator")?.lastReadMessageId).toBe("m-client-rotated");
    expect(await store.acknowledgeDeliveries(cursor)).toBe(1);
    expect(deliveryUpdates).toEqual([expect.objectContaining({ deliveryId: "delivery-before", status: "acknowledged" })]);
  });

  test("rotated read positions still order against the live window and never regress", async () => {
    const { runtime, store } = createStore({ durableHistory: [
      testMessage({ id: "rotated-older", createdAt: 50 }),
      testMessage({ id: "rotated", createdAt: 100 }),
    ] });
    await runtime.upsertConversation(testConversation());
    await runtime.commitMessage(testMessage({ id: "live", createdAt: 200 }), []);
    await store.record(await store.resolve("conversation-1", { actorId: "operator", lastReadMessageId: "rotated" }));

    const older = await store.resolve("conversation-1", { actorId: "operator", lastReadMessageId: "rotated-older" });
    expect(older.lastReadMessageId).toBe("rotated");
    await store.record(older);
    expect(runtime.readCursor("conversation-1", "operator")?.lastReadMessageId).toBe("rotated");

    await store.record(await store.resolve("conversation-1", { actorId: "operator", lastReadMessageId: "live" }));
    expect(runtime.readCursor("conversation-1", "operator")?.lastReadMessageId).toBe("live");
  });

  test("durable history does not widen what a read position may name", async () => {
    const { runtime, store } = createStore({ durableHistory: [
      testMessage({ id: "rotated-elsewhere", conversationId: "conversation-2", createdAt: 100 }),
    ] });
    await runtime.upsertConversation(testConversation());
    await expect(store.resolve("conversation-1", { actorId: "operator", lastReadMessageId: "rotated-elsewhere" }))
      .rejects.toThrow("message rotated-elsewhere does not belong to conversation-1");
    await expect(store.resolve("conversation-1", { actorId: "operator", lastReadMessageId: "missing" }))
      .rejects.toThrow("message missing not found");
  });
});


test("read acknowledgement reaches the eligible delivery beyond 6000 historical records", async () => {
  const deliveries = Array.from({ length: 6001 }, (_, index) => testDelivery({
    id: `history-${index}`, status: index === 6000 ? "pending" : "completed",
  }));
  const { runtime, deliveryUpdates, store } = createStore({ deliveries });
  await runtime.upsertConversation(testConversation());
  await runtime.commitMessage(testMessage(), []);
  const count = await store.acknowledgeDeliveries({
    conversationId: "conversation-1", actorId: "agent-1", lastReadMessageId: "message-1",
    lastReadAt: 300, updatedAt: 350,
  });
  expect(count).toBe(1);
  expect(deliveryUpdates).toEqual([expect.objectContaining({ deliveryId: "history-6000" })]);
});
