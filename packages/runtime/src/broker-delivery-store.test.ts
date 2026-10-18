import { describe, expect, test } from "bun:test";

import type {
  ControlEvent,
  DeliveryAttempt,
  DeliveryIntent,
  DurableAction,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";
import { BrokerDeliveryStore, isDeliveryClaimable } from "./broker-delivery-store.js";
import { BrokerDurableStore } from "./broker-durable-store.js";

class TestDeliveryJournal {
  readonly appended: BrokerJournalEntry[][] = [];
  readonly deliveries = new Map<string, DeliveryIntent>();
  readonly durableActions = new Map<string, DurableAction>();
  readonly attempts: DeliveryAttempt[] = [];

  async appendEntries(entries: BrokerJournalEntry[]): Promise<BrokerJournalEntry[]> {
    this.appended.push(entries);
    for (const entry of entries) {
      switch (entry.kind) {
        case "deliveries.record":
          for (const delivery of entry.deliveries) {
            this.deliveries.set(delivery.id, delivery);
          }
          break;
        case "delivery.status.update": {
          const previous = this.deliveries.get(entry.deliveryId);
          if (previous) {
            this.deliveries.set(entry.deliveryId, {
              ...previous,
              status: entry.status,
              metadata: {
                ...(previous.metadata ?? {}),
                ...(entry.metadata ?? {}),
              },
              leaseOwner: entry.leaseOwner ?? undefined,
              leaseExpiresAt: entry.leaseExpiresAt ?? undefined,
            });
          }
          break;
        }
        case "delivery.attempt.record":
          this.attempts.push(entry.attempt);
          break;
        case "durable.action.record":
          this.durableActions.set(entry.action.id, entry.action);
          break;
        case "durable.action.heartbeat": {
          const current = this.durableActions.get(entry.input.actionId);
          if (current) {
            this.durableActions.set(entry.input.actionId, {
              ...current,
              leaseExpiresAt: entry.input.heartbeatAt + entry.input.leaseMs,
              updatedAt: entry.input.heartbeatAt,
            });
          }
          break;
        }
        default:
          break;
      }
    }
    return entries;
  }

  getDelivery(id: string): DeliveryIntent | undefined { return this.deliveries.get(id); }
  findDelivery(predicate: (delivery: DeliveryIntent) => boolean): DeliveryIntent | undefined {
    for (const delivery of this.deliveries.values()) if (predicate(delivery)) return delivery;
    return undefined;
  }

  listDeliveries(options: { limit: number }): DeliveryIntent[] {
    return [...this.deliveries.values()].slice(0, options.limit);
  }

  getDurableAction(actionId: string): DurableAction | undefined {
    return this.durableActions.get(actionId);
  }
}

function createTestDeliveryStore() {
  const journal = new TestDeliveryJournal();
  const events: ControlEvent[] = [];
  const durableStore = new BrokerDurableStore({
    journal,
    projection: {
      async applyEntries() {
        return [];
      },
    },
    threadEvents: {
      publish() {},
    },
  });
  const store = new BrokerDeliveryStore({
    journal,
    durableStore,
    nodeId: "node-1",
    createEventId: () => `event-${events.length + 1}`,
    publishEvent: (event) => {
      events.push(event);
    },
  });

  return { journal, events, store, durableStore };
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

function testDurableAction(input: Partial<DurableAction> = {}): DurableAction {
  return {
    id: "action-1",
    kind: "message_delivery",
    subjectId: "delivery-1",
    authorityCellId: "node-1",
    state: "running",
    leaseOwner: "worker-1",
    leaseGeneration: 2,
    leaseExpiresAt: 100,
    createdAt: 1,
    updatedAt: 1,
    ...input,
  };
}

describe("BrokerDeliveryStore", () => {
  test("identifies delivery claimability from status and lease expiry", () => {
    expect(isDeliveryClaimable(testDelivery({ status: "pending" }), 10)).toBe(true);
    expect(isDeliveryClaimable(testDelivery({ status: "accepted" }), 10)).toBe(true);
    expect(isDeliveryClaimable(testDelivery({ status: "deferred" }), 10)).toBe(true);
    expect(isDeliveryClaimable(testDelivery({ status: "leased", leaseExpiresAt: 9 }), 10)).toBe(true);
    expect(isDeliveryClaimable(testDelivery({ status: "leased", leaseExpiresAt: 11 }), 10)).toBe(false);
    expect(isDeliveryClaimable(testDelivery({ status: "completed" }), 10)).toBe(false);
  });

  test("claims a pending delivery and publishes the state change", async () => {
    const { journal, events, store } = createTestDeliveryStore();
    await store.recordDelivery(testDelivery());

    const claimed = await store.claimDelivery({
      targetId: "agent-1",
      leaseOwner: "worker-1",
      leaseMs: 1_000,
    });

    expect(claimed).toEqual(expect.objectContaining({
      id: "delivery-1",
      status: "leased",
      leaseOwner: "worker-1",
    }));
    expect(journal.deliveries.get("delivery-1")).toEqual(expect.objectContaining({
      status: "leased",
      leaseOwner: "worker-1",
    }));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({
      kind: "delivery.state.changed",
      payload: expect.objectContaining({
        previousStatus: "pending",
      }),
    }));
  });

  test("rejects status updates when the active lease is owned by another worker", async () => {
    const { store } = createTestDeliveryStore();
    await store.recordDelivery(testDelivery({
      status: "leased",
      leaseOwner: "worker-1",
      leaseExpiresAt: Date.now() + 10_000,
    }));

    await expect(store.updateDeliveryStatus({
      deliveryId: "delivery-1",
      status: "acknowledged",
      expectedLeaseOwner: "worker-2",
      requireActiveLease: true,
    })).rejects.toThrow("delivery lease is missing, expired, or owned by another worker");
  });

  test("claims and acknowledges deliveries beyond the listing window without admitting a second claimant", async () => {
    const { journal, events, store } = createTestDeliveryStore();
    await journal.appendEntries([{
      kind: "deliveries.record",
      deliveries: Array.from({ length: 6001 }, (_, i) => testDelivery({
        id: `history-${i}`, status: i === 6000 ? "pending" : "completed",
      })),
    }]);
    const [first, second] = await Promise.all([
      store.claimDelivery({ targetId: "agent-1", leaseOwner: "worker-1", leaseMs: 60000 }),
      store.claimDelivery({ itemId: "history-6000", targetId: "agent-1", leaseOwner: "worker-2" }),
    ]);
    expect(first?.id).toBe("history-6000");
    expect(second).toBeNull();
    await expect(store.updateDeliveryStatus({
      deliveryId: "history-6000", status: "acknowledged",
      expectedLeaseOwner: "worker-2", requireActiveLease: true,
    })).rejects.toThrow("owned by another worker");
    await store.updateDeliveryStatus({
      deliveryId: "history-6000", status: "acknowledged",
      expectedLeaseOwner: "worker-1", expectedLeaseGeneration: first?.metadata?.leaseGeneration, requireActiveLease: true,
    });
    expect(journal.deliveries.get("history-6000")?.status).toBe("acknowledged");
    expect(events).toHaveLength(2);
    expect(events[1]?.payload).toEqual(expect.objectContaining({previousStatus: "leased"}));
  });

  test("records delivery attempts and durable action heartbeats", async () => {
    const { journal, store } = createTestDeliveryStore();
    const action = testDurableAction();
    await journal.appendEntries([{ kind: "durable.action.record", action }]);

    await store.recordDeliveryAttempt({
      id: "attempt-1",
      deliveryId: "delivery-1",
      attempt: 1,
      status: "sent",
      createdAt: 10,
    });
    const heartbeat = await store.heartbeatDurableAction({
      actionId: "action-1",
      owner: "worker-1",
      generation: 2,
      leaseMs: 500,
      heartbeatAt: 50,
    });

    expect(journal.attempts).toContainEqual(expect.objectContaining({
      id: "attempt-1",
      status: "sent",
    }));
    expect(heartbeat).toEqual(expect.objectContaining({
      id: "action-1",
      leaseExpiresAt: 550,
      updatedAt: 50,
    }));
    expect(journal.durableActions.get("action-1")).toEqual(expect.objectContaining({
      leaseExpiresAt: 550,
      updatedAt: 50,
    }));
  });
});

test("conditional read acknowledgement rechecks after queued claims and terminal updates", async () => {
  const { journal, store, events } = createTestDeliveryStore();
  await store.recordDelivery(testDelivery());
  const snapshot = journal.getDelivery("delivery-1")!;
  expect(snapshot.status).toBe("pending");
  const claim = store.claimDelivery({ targetId: "agent-1", leaseOwner: "worker", leaseMs: 60000 });
  const ack = store.updateDeliveryStatusIf({ deliveryId: snapshot.id, status: "acknowledged", leaseOwner: null, leaseExpiresAt: null }, (current) => current.status === "pending");
  await expect(claim).resolves.toEqual(expect.objectContaining({ status: "leased" }));
  await expect(ack).resolves.toBe(false);
  expect(journal.getDelivery(snapshot.id)?.leaseOwner).toBe("worker");
  const complete = store.updateDeliveryStatus({ deliveryId: snapshot.id, status: "completed" });
  const staleAck = store.updateDeliveryStatusIf({ deliveryId: snapshot.id, status: "acknowledged" }, (current) => current.status !== "completed");
  await complete;
  await expect(staleAck).resolves.toBe(false);
  expect(journal.getDelivery(snapshot.id)?.status).toBe("completed");
  expect(journal.appended.flat().filter((entry) => entry.kind === "delivery.status.update" && entry.status === "acknowledged")).toEqual([]);
  const eventCount = events.length;
  await expect(store.updateDeliveryStatusIf({ deliveryId: "missing", status: "acknowledged" }, () => true)).resolves.toBe(false);
  expect(events.length).toBe(eventCount);
});

test("asynchronous read-ack eligibility holds the existing write queue until its decision", async () => {
  const { journal, store } = createTestDeliveryStore();
  await store.recordDelivery(testDelivery());
  let ready!: () => void;
  const entered = new Promise<void>(resolve => { ready = resolve; });
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const rejected = store.updateDeliveryStatusIf({ deliveryId: "delivery-1", status: "acknowledged" }, async () => {
    ready(); await gate; return false;
  });
  await entered;
  const claim = store.claimDelivery({ targetId: "agent-1", leaseOwner: "worker", leaseMs: 60000 });
  expect(journal.getDelivery("delivery-1")?.status).toBe("pending");
  resume();
  expect(await rejected).toBe(false);
  expect((await claim)?.status).toBe("leased");
  expect(journal.getDelivery("delivery-1")?.leaseOwner).toBe("worker");
});


test("receipt mutations re-read under the canonical writer and preserve prior reply fields", async () => {
  const { store, journal, durableStore } = createTestDeliveryStore();
  await store.recordDelivery({ id: "external", targetId: "agent", targetKind: "agent", transport: "http", reason: "invocation", policy: "durable", status: "sent" });
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const held = durableStore.runWrite(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const complete = store.mutateDelivery("external", (current) => ({ ...current, status: "completed", metadata: { replyBodyHash: "pinned" } }));
  const lateAck = store.mutateDelivery("external", (current) => current.status === "completed" ? null : { ...current, status: "acknowledged" });
  release.resolve(); await Promise.all([held, complete, lateAck]);
  expect(journal.getDelivery("external")).toMatchObject({ status: "completed", metadata: { replyBodyHash: "pinned" } });
});
