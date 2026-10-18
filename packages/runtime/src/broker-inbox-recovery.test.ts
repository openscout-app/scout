import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliveryIntent, InboxItem } from "@openscout/protocol";
import { FileBackedBrokerJournal } from "./broker-journal.js";
import { BrokerDurableStore } from "./broker-durable-store.js";
import { BrokerDeliveryStore } from "./broker-delivery-store.js";
import { BrokerDeliveryHttpService } from "./broker-delivery-http-service.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const delivery = (overrides: Partial<DeliveryIntent> = {}): DeliveryIntent => ({
  id: "item", targetId: "agent", targetKind: "agent", transport: "local_socket",
  reason: "direct_message", policy: "durable", status: "pending", ...overrides,
});

async function openStore(path: string, clock: { now: number }) {
  const journal = new FileBackedBrokerJournal(path);
  await journal.load();
  const durableStore = new BrokerDurableStore({ journal, projection: { async applyEntries() { return []; } }, threadEvents: { publish() {} } });
  const warnings: string[] = [];
  const store = new BrokerDeliveryStore({ journal, durableStore, nodeId: "local", createEventId: () => "event", publishEvent() {}, now: () => clock.now, warn: message => warnings.push(message) });
  const service = new BrokerDeliveryHttpService({
    now: () => clock.now, claimDelivery: store.claimDelivery, updateDeliveryStatus: store.updateDeliveryStatus,
    inboxItemForDelivery: item => ({ id: item.id, kind: "message", targetId: item.targetId, reason: item.reason, status: item.status,
      leaseOwner: item.leaseOwner, leaseExpiresAt: item.leaseExpiresAt, leaseGeneration: item.metadata?.leaseGeneration, delivery: item } as InboxItem),
    listInboxItems: async () => [], listDeliveries: () => [], listDeliveryAttempts: () => [], recordDeliveryAttempt: store.recordDeliveryAttempt,
  });
  return { journal, durableStore, store, service, warnings };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scout-inbox-recovery-")); roots.push(root);
  const path = join(root, "journal.jsonl"), clock = { now: 1_000 };
  return { path, clock, ...await openStore(path, clock) };
}

const claim = { targetId: "agent", itemId: "item", leaseOwner: "same-worker", leaseMs: 100 };

describe("durable inbox claim recovery", () => {
  test("NACK backoff survives restart and is enforced for exact and searched claims at the writer", async () => {
    const h = await fixture(); await h.store.recordDelivery(delivery());
    const first = (await h.service.claimInboxItem(claim)).claimed!;
    expect(first.leaseGeneration).toBe(1);
    expect((await h.service.nackInboxItem({ itemId: first.id, leaseOwner: first.leaseOwner, leaseGeneration: first.leaseGeneration, retryAfterMs: 200 })).status).toBe(200);
    await h.durableStore.flushProjectedEntries();
    const restarted = await openStore(h.path, h.clock);
    expect(await restarted.store.claimDelivery(claim)).toBeNull();
    expect(await restarted.store.claimDelivery({ targetId: "agent" })).toBeNull();
    h.clock.now = 1_199; expect(await restarted.store.claimDelivery(claim)).toBeNull();
    h.clock.now = 1_200;
    const [next, competing] = await Promise.all([restarted.store.claimDelivery(claim), restarted.store.claimDelivery(claim)]);
    expect(next?.metadata?.leaseGeneration).toBe(2); expect(competing).toBeNull();
    await restarted.durableStore.flushProjectedEntries();
  });

  test("stale ACK and NACK cannot change a reclaimed lease with the same owner, including after restart", async () => {
    const h = await fixture(); await h.store.recordDelivery(delivery());
    const first = (await h.service.claimInboxItem(claim)).claimed!;
    h.clock.now = 1_100;
    const second = (await h.service.claimInboxItem(claim)).claimed!;
    expect(second.leaseGeneration).toBe(2);
    await h.durableStore.flushProjectedEntries();
    const restarted = await openStore(h.path, h.clock);
    for (const generation of [first.leaseGeneration, undefined, 0, NaN, 1.5]) {
      const input = { itemId: first.id, leaseOwner: first.leaseOwner, leaseGeneration: generation };
      expect((await restarted.service.acknowledgeInboxItem(input)).status).toBe(409);
      expect((await restarted.service.nackInboxItem({ ...input, retryAfterMs: 500 })).status).toBe(409);
      expect(restarted.journal.getDelivery("item")).toMatchObject({ status: "leased", metadata: { leaseGeneration: 2 } });
    }
    expect((await restarted.service.acknowledgeInboxItem({ itemId: second.id, leaseOwner: second.leaseOwner, leaseGeneration: second.leaseGeneration, metadata: { leaseGeneration: 0 } })).status).toBe(200);
    expect(restarted.journal.getDelivery("item")).toMatchObject({ status: "acknowledged", metadata: { leaseGeneration: 2 } });
    await restarted.durableStore.flushProjectedEntries();
  });

  test("queued claim rereads a deferred deadline committed ahead of it", async () => {
    const h = await fixture(); await h.store.recordDelivery(delivery());
    const deferred = h.store.updateDeliveryStatus({ deliveryId: "item", status: "deferred", metadata: { nextAttemptAt: 2_000 } });
    const queued = h.store.claimDelivery(claim);
    await deferred; expect(await queued).toBeNull();
    await h.durableStore.flushProjectedEntries();
  });

  test("legacy deferred items remain claimable but every new claim is fenced", async () => {
    const h = await fixture(); await h.store.recordDelivery(delivery({ status: "deferred" }));
    const first = (await h.service.claimInboxItem(claim)).claimed!;
    expect(first.leaseGeneration).toBe(1);
    expect((await h.service.acknowledgeInboxItem({ itemId: first.id, leaseOwner: first.leaseOwner })).status).toBe(409);
    expect(h.warnings).toEqual([]);
    await h.durableStore.flushProjectedEntries();
  });

  test("only outstanding pre-upgrade leases accept owner-only acknowledgement with a diagnostic", async () => {
    const h = await fixture(); await h.store.recordDelivery(delivery({ status: "leased", leaseOwner: "old-client", leaseExpiresAt: 1_500 }));
    expect((await h.service.acknowledgeInboxItem({ itemId: "item", leaseOwner: "old-client" })).status).toBe(200);
    expect(h.warnings).toHaveLength(1);
    await h.durableStore.flushProjectedEntries();
  });

  test("legacy NACK metadata cannot create a poisoned generation that blocks the next claim", async () => {
    const h = await fixture();
    await h.store.recordDelivery(delivery({ status: "leased", leaseOwner: "old-client", leaseExpiresAt: 1_500 }));
    expect((await h.service.nackInboxItem({ itemId: "item", leaseOwner: "old-client", metadata: { leaseGeneration: 0 } })).status).toBe(200);
    expect(h.journal.getDelivery("item")?.metadata?.leaseGeneration).toBeUndefined();
    const next = (await h.service.claimInboxItem(claim)).claimed!;
    expect(next.leaseGeneration).toBe(1);
    expect((await h.service.acknowledgeInboxItem({ itemId: next.id, leaseOwner: next.leaseOwner, leaseGeneration: next.leaseGeneration })).status).toBe(200);
    await h.durableStore.flushProjectedEntries();
  });
});
