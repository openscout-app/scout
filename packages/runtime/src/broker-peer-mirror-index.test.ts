import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliveryIntent, FlightRecord } from "@openscout/protocol";
import { FileBackedBrokerJournal, type BrokerJournalEntry } from "./broker-journal.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function pair(index: number, state: FlightRecord["state"] = "running") {
  const flight: FlightRecord = {
    id: `flight-${index}`, invocationId: `inv-${index}`, requesterId: "requester", targetAgentId: "target", state, startedAt: index,
    ...(state === "completed" ? { completedAt: index + 1, output: "done" } : {}),
  };
  const delivery: DeliveryIntent = {
    id: `delivery-${index}`, invocationId: flight.invocationId, targetId: flight.targetAgentId,
    targetNodeId: "peer", targetKind: "agent", transport: "peer_broker", reason: "invocation", policy: "must_ack", status: "peer_acked",
    metadata: { peerFlightId: flight.id },
  };
  return { flight, delivery };
}

async function journalFixture() {
  const root = await mkdtemp(join(tmpdir(), "peer-mirror-index-"));
  roots.push(root);
  const path = join(root, "journal.jsonl");
  const journal = new FileBackedBrokerJournal(path);
  await journal.load();
  return { journal, path };
}

test("peer mirror recovery skips terminal history and fairly visits more than 500 active deliveries after restart", async () => {
  const { journal, path } = await journalFixture();
  const entries: BrokerJournalEntry[] = [];
  for (let index = 0; index < 1205; index++) {
    const { flight, delivery } = pair(index, index < 600 ? "completed" : "running");
    entries.push({ kind: "flight.record", flight }, { kind: "deliveries.record", deliveries: [delivery] });
  }
  await journal.appendEntries(entries);
  const restored = new FileBackedBrokerJournal(path);
  await restored.load();
  const first = restored.listPendingPeerMirrorDeliveries({ limit: 500 });
  const second = restored.listPendingPeerMirrorDeliveries({ limit: 500 });
  expect(first).toHaveLength(500);
  expect(first[0]!.id).toBe("delivery-600");
  expect(second[0]!.id).toBe("delivery-1100");
  expect(new Set([...first, ...second].map((delivery) => delivery.id)).size).toBe(605);
  const completed = pair(1204, "completed");
  await restored.appendEntries({ kind: "flight.record", flight: completed.flight });
  expect(restored.listPendingPeerMirrorDeliveries({ limit: 5000 })).toHaveLength(604);
});

test("terminal mirror exclusion requires matching flight, invocation, target, and requester", async () => {
  const { journal } = await journalFixture();
  const { flight, delivery } = pair(1, "completed");
  await journal.appendEntries([
    { kind: "invocation.record", invocation: { id: flight.invocationId, requesterId: "requester", targetAgentId: "target", action: "invoke", task: "hello", createdAt: 0 } },
    { kind: "flight.record", flight: { ...flight, requesterId: "different" } },
    { kind: "deliveries.record", deliveries: [delivery] },
  ]);
  expect(journal.listPendingPeerMirrorDeliveries()).toHaveLength(1);
  await journal.appendEntries({ kind: "flight.record", flight: { ...flight, targetAgentId: "other" } });
  expect(journal.listPendingPeerMirrorDeliveries()).toHaveLength(1);
  await journal.appendEntries({ kind: "flight.record", flight: { ...flight, invocationId: "other-invocation" } });
  expect(journal.listPendingPeerMirrorDeliveries()).toHaveLength(1);
  await journal.appendEntries({ kind: "flight.record", flight });
  expect(journal.listPendingPeerMirrorDeliveries()).toHaveLength(0);
});

test("peer mirror indexes follow delivery status and replacement flight identities", async () => {
  const { journal } = await journalFixture();
  const { flight, delivery } = pair(1);
  await journal.appendEntries({ kind: "deliveries.record", deliveries: [{ ...delivery, status: "accepted" }] });
  expect(journal.listPendingPeerMirrorDeliveries()).toHaveLength(0);
  await journal.appendEntries({ kind: "delivery.status.update", deliveryId: delivery.id, status: "peer_acked" });
  expect(journal.listPendingPeerMirrorDeliveries()).toHaveLength(1);
  await journal.appendEntries({ kind: "delivery.status.update", deliveryId: delivery.id, status: "peer_acked", metadata: { peerFlightId: "replacement" } });
  await journal.appendEntries({ kind: "flight.record", flight: { ...flight, state: "completed" } });
  expect(journal.listPendingPeerMirrorDeliveries()).toHaveLength(1);
  await journal.appendEntries({ kind: "flight.record", flight: { ...flight, id: "replacement", state: "completed" } });
  expect(journal.listPendingPeerMirrorDeliveries()).toHaveLength(0);
});

test("peer forward candidates rotate past a 500-delivery leased prefix without scanning terminal history", async () => {
  const { journal, path } = await journalFixture();
  const deliveries = Array.from({ length: 1205 }, (_, index) => ({
    ...pair(index).delivery, status: index < 600 ? "completed" : "accepted",
    ...(index < 1100 ? { leaseOwner: "other", leaseExpiresAt: 999_999 } : {}),
  } as DeliveryIntent));
  await journal.appendEntries({ kind: "deliveries.record", deliveries });
  const restored = new FileBackedBrokerJournal(path);
  await restored.load();
  const first = restored.listPendingPeerForwardDeliveries({ limit: 500 });
  const second = restored.listPendingPeerForwardDeliveries({ limit: 500 });
  expect(first[0]!.id).toBe("delivery-600");
  expect(first.every((delivery) => delivery.leaseOwner === "other")).toBe(true);
  expect(second[0]!.id).toBe("delivery-1100");
  await restored.appendEntries({ kind: "delivery.status.update", deliveryId: "delivery-1100", status: "peer_acked" });
  expect(restored.listPendingPeerForwardDeliveries({ limit: 5000 })).toHaveLength(604);
});

test("only explicitly uncertain sent peer receipts enter observation recovery", async () => {
  const { journal, path } = await journalFixture();
  const legacy = { ...pair(1).delivery, status: "sent" as const };
  const uncertain = { ...pair(2).delivery, status: "sent" as const,
    metadata: { peerSubmission: { version: 1, status: "unknown" } } };
  await journal.appendEntries({ kind: "deliveries.record", deliveries: [legacy, uncertain] });
  const restored = new FileBackedBrokerJournal(path);
  await restored.load();
  expect(restored.listPendingPeerForwardDeliveries()).toEqual([]);
  expect(restored.listPendingPeerMirrorDeliveries()).toEqual([uncertain]);
});
