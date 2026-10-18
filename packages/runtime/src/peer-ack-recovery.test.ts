import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlightRecord, InvocationRequest, NodeDefinition } from "@openscout/protocol";
import { FileBackedBrokerJournal } from "./broker-journal.js";
import { PeerUnreachableError } from "./mesh-forwarding.js";
import { createPeerDeliveryWorker, type PeerDeliveryDeps, type PeerDeliveryWorker } from "./peer-delivery.js";

const roots: string[] = [];
const workers: PeerDeliveryWorker[] = [];
const logs: Array<ReturnType<typeof spyOn>> = [];
afterEach(async () => {
  workers.splice(0).forEach(worker => worker.stop());
  logs.splice(0).forEach(log => log.mockRestore());
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scout-peer-ack-"));
  roots.push(root);
  const path = join(root, "journal.jsonl");
  let journal = new FileBackedBrokerJournal(path);
  await journal.load();
  const invocation: InvocationRequest = {
    id: "inv-peer", requesterId: "requester", requesterNodeId: "origin", targetAgentId: "remote-agent",
    action: "execute", task: "test", ensureAwake: true, stream: false, createdAt: 0,
  };
  const peer: NodeDefinition = {
    id: "peer", meshId: "test", name: "peer", brokerUrl: "http://peer.test",
    advertiseScope: "mesh", capabilities: ["broker"], registeredAt: 0, lastSeenAt: 0,
  };
  const flight: FlightRecord = {
    id: "peer-flight", invocationId: invocation.id, requesterId: invocation.requesterId,
    targetAgentId: invocation.targetAgentId, state: "running", startedAt: 1,
  };
  await journal.appendEntries({ kind: "invocation.record", invocation });
  let now = 10;
  let forwards = 0;
  let failures = 0;
  let observations = 0;
  const deps: PeerDeliveryDeps = {
    journal,
    snapshot: () => journal.snapshot(),
    localNode: () => ({ ...peer, id: "origin" }), localNodeId: "origin",
    nodeFor: () => peer, agentFor: () => undefined,
    invocationFor: id => journal.snapshot().invocations[id],
    flightForInvocation: id => Object.values(journal.snapshot().flights).findLast(value => value.invocationId === id),
    recordDelivery: async delivery => { await journal.appendEntries({ kind: "deliveries.record", deliveries: [delivery] }); },
    updateDeliveryStatus: async input => { await journal.appendEntries({ kind: "delivery.status.update", ...input }); },
    recordDeliveryAttempt: async attempt => { await journal.appendEntries({ kind: "delivery.attempt.record", attempt }); },
    recordFlight: async (value, eligible) => {
      if (eligible && !eligible()) return;
      await journal.appendEntries({ kind: "flight.record", flight: value });
    },
    failInvocation: async () => { failures++; },
    forward: async () => { forwards++; return { ok: true, flight }; },
    peerFetch: async () => { observations++; return new Response(null, { status: 204 }); },
    now: () => now,
  };
  const start = () => {
    const worker = createPeerDeliveryWorker(deps, { retryWindowMs: 0, initialBackoffMs: 1 });
    workers.push(worker);
    return worker;
  };
  return {
    deps, invocation, peer, flight, start,
    journal: () => journal,
    counts: () => ({ forwards, failures, observations }),
    async reopen() {
      workers.splice(0).forEach(worker => worker.stop());
      journal = new FileBackedBrokerJournal(path);
      await journal.load();
      deps.journal = journal;
      now += 60_000;
    },
  };
}

for (const failedEffect of ["checkpoint", "attempt", "attempt_ack", "flight", "clear"] as const) {
  test(`ACK remains durable across ${failedEffect} persistence failure and journal reopen`, async () => {
    const f = await fixture();
    logs.push(spyOn(console, "error").mockImplementation(() => {}));
    const recordAttempt = f.deps.recordDeliveryAttempt;
    const recordFlight = f.deps.recordFlight;
    const update = f.deps.updateDeliveryStatus;
    if (failedEffect === "checkpoint") f.deps.updateDeliveryStatus = async input => {
      await update(input);
      if (input.metadata?.peerAcknowledgement) throw new Error("ACK write committed but response lost");
    };
    if (failedEffect === "attempt") f.deps.recordDeliveryAttempt = async () => { throw new Error("attempt disk failure"); };
    if (failedEffect === "attempt_ack") f.deps.recordDeliveryAttempt = async attempt => {
      await recordAttempt(attempt);
      throw new Error("attempt write committed but response lost");
    };
    if (failedEffect === "flight") f.deps.recordFlight = async () => { throw new Error("flight disk failure"); };
    if (failedEffect === "clear") {
      // A terminal result must remain indexed until the final local receipt clears.
      f.flight.state = "completed";
      f.flight.completedAt = 5;
      f.flight.output = "finished remotely";
      f.deps.updateDeliveryStatus = async input => {
        if (input.metadata?.peerAcknowledgement === null) throw new Error("receipt disk failure");
        await update(input);
      };
    }
    const first = f.start();
    const delivery = await first.enqueue(f.invocation, f.peer);
    await first.tick();
    expect(f.journal().getDelivery(delivery.id)?.status).toBe("peer_acked");
    expect(f.journal().getDelivery(delivery.id)?.metadata?.peerAcknowledgement).toBeTruthy();
    expect(f.counts()).toMatchObject({ forwards: 1, failures: 0 });

    await f.reopen();
    f.deps.recordDeliveryAttempt = recordAttempt;
    f.deps.recordFlight = recordFlight;
    f.deps.updateDeliveryStatus = update;
    expect(f.journal().listPendingPeerMirrorDeliveries().map(value => value.id)).toEqual([delivery.id]);
    const recovered = f.start();
    await recovered.tick();
    await recovered.tick();
    expect(f.counts()).toMatchObject({ forwards: 1, failures: 0 });
    expect(f.journal().listPendingPeerForwardDeliveries()).toEqual([]);
    expect(f.journal().getDelivery(delivery.id)?.metadata?.peerAcknowledgement).toBeNull();
    expect(f.journal().listDeliveryAttempts(delivery.id).map(attempt => attempt.status)).toEqual(["acknowledged"]);
    expect(f.journal().snapshot().flights[f.flight.id]).toEqual(f.flight);
    if (failedEffect === "clear") expect(f.journal().listPendingPeerMirrorDeliveries()).toEqual([]);
  });
}

test("failed ACK checkpoint retains unknown submission and resolves by observation after restart", async () => {
  const f = await fixture();
  logs.push(spyOn(console, "error").mockImplementation(() => {}));
  const update = f.deps.updateDeliveryStatus;
  f.deps.updateDeliveryStatus = async input => {
    if (input.status === "peer_acked") throw new Error("ACK checkpoint failed");
    await update(input);
  };
  const first = f.start();
  const delivery = await first.enqueue(f.invocation, f.peer);
  await first.tick();
  expect(f.journal().getDelivery(delivery.id)).toMatchObject({
    status: "sent", metadata: { peerSubmission: { status: "unknown" } },
  });
  expect(f.journal().listDeliveryAttempts(delivery.id)).toEqual([]);
  await f.reopen();
  f.deps.updateDeliveryStatus = update;
  f.deps.peerFetch = async () => new Response(`event: snapshot\ndata: ${JSON.stringify({ invocationId: f.invocation.id, flight: f.flight })}\n\n`);
  const recovered = f.start();
  await recovered.tick();
  await Bun.sleep(20);
  expect(f.counts()).toMatchObject({ forwards: 1, failures: 0 });
  expect(f.journal().getDelivery(delivery.id)).toMatchObject({ status: "peer_acked", metadata: { peerFlightId: f.flight.id } });
  expect(f.journal().snapshot().flights[f.flight.id]).toEqual(f.flight);
  expect(f.journal().listDeliveryAttempts(delivery.id).map(attempt => attempt.status)).toEqual(["acknowledged"]);
});

test("peer ACK without a flight still becomes acknowledged and starts observation", async () => {
  const f = await fixture();
  f.deps.forward = async () => ({ ok: true });
  const worker = f.start();
  const delivery = await worker.enqueue(f.invocation, f.peer);
  await worker.tick();
  expect(f.journal().getDelivery(delivery.id)?.status).toBe("peer_acked");
  expect(f.journal().listDeliveryAttempts(delivery.id).map(attempt => attempt.status)).toEqual(["acknowledged"]);
  expect(f.counts()).toMatchObject({ failures: 0, observations: 1 });
});

for (const field of ["invocationId", "requesterId", "targetAgentId"] as const) {
  test(`uncorrelated ACK ${field} never pins or records the wrong flight`, async () => {
    const f = await fixture();
    logs.push(spyOn(console, "warn").mockImplementation(() => {}));
    f.deps.forward = async () => ({ ok: true, flight: { ...f.flight, [field]: "unrelated" } });
    f.deps.peerFetch = async () => new Response(`event: snapshot\ndata: ${JSON.stringify({ invocationId: f.invocation.id, flight: f.flight })}\n\n`);
    const worker = f.start();
    const delivery = await worker.enqueue(f.invocation, f.peer);
    await worker.tick();
    await Bun.sleep(20);
    expect(f.journal().getDelivery(delivery.id)).toMatchObject({ status: "peer_acked", metadata: { peerFlightId: null } });
    expect(f.journal().snapshot().flights[f.flight.id]).toEqual(f.flight);
    expect(f.counts().failures).toBe(0);
  });
}

for (const replacement of ["same_flight", "new_flight", "cancelled"] as const) {
  test(`delayed ACK cannot replace ${replacement} after restart or inside the writer`, async () => {
    const f = await fixture();
    logs.push(spyOn(console, "error").mockImplementation(() => {}));
    const origin: FlightRecord = { ...f.flight, id: "origin-flight", state: "queued", startedAt: 0 };
    await f.deps.recordFlight(origin);
    const recordFlight = f.deps.recordFlight;
    f.deps.recordFlight = async () => { throw new Error("completion disk failure"); };
    const first = f.start();
    const delivery = await first.enqueue(f.invocation, f.peer);
    await first.tick();
    expect(f.journal().getDelivery(delivery.id)?.metadata?.peerAcknowledgement).toMatchObject({ previousFlight: origin });
    await f.reopen();
    const newer: FlightRecord = { ...f.flight, id: replacement === "new_flight" ? "new-flight" : f.flight.id,
      state: replacement === "cancelled" ? "cancelled" : "running", summary: "newer observation", startedAt: 20 };
    // This simulates another writer winning after recovery submits its write.
    f.deps.recordFlight = async (value, eligible) => {
      await recordFlight(newer);
      await recordFlight(value, eligible);
    };
    const recovered = f.start();
    await recovered.tick();
    expect(f.deps.flightForInvocation?.(f.invocation.id)).toEqual(newer);
    expect(f.journal().getDelivery(delivery.id)?.metadata?.peerAcknowledgement).toBeNull();
    expect(f.counts()).toMatchObject({ forwards: 1, failures: 0 });
  });
}

test("ACK recovery may replace its unchanged origin placeholder after restart", async () => {
  const f = await fixture();
  logs.push(spyOn(console, "error").mockImplementation(() => {}));
  const origin: FlightRecord = { ...f.flight, id: "origin-flight", state: "queued", startedAt: 0 };
  await f.deps.recordFlight(origin);
  const recordFlight = f.deps.recordFlight;
  f.deps.recordFlight = async () => { throw new Error("flight disk failure"); };
  const first = f.start();
  const delivery = await first.enqueue(f.invocation, f.peer);
  await first.tick();
  await f.reopen();
  f.deps.recordFlight = recordFlight;
  const recovered = f.start();
  await recovered.tick();
  expect(f.deps.flightForInvocation?.(f.invocation.id)).toEqual(f.flight);
  expect(f.journal().getDelivery(delivery.id)?.metadata?.peerAcknowledgement).toBeNull();
  expect(f.counts()).toMatchObject({ forwards: 1, failures: 0 });
});

test("exhausted unacknowledged request remains unknown across restart and peer-online hints", async () => {
  const f = await fixture();
  let forwards = 0;
  f.deps.forward = async () => { forwards++; throw new PeerUnreachableError("response lost"); };
  const first = f.start();
  const delivery = await first.enqueue(f.invocation, f.peer);
  await first.tick();
  await f.reopen();
  const recovered = f.start();
  recovered.notifyPeerOnline(f.peer.id);
  await recovered.tick();
  expect(forwards).toBe(1);
  expect(f.counts().failures).toBe(0);
  expect(f.journal().getDelivery(delivery.id)).toMatchObject({
    status: "sent", metadata: { peerSubmission: { status: "unknown", reason: "retry_window_expired" } },
  });
  expect(f.journal().listPendingPeerForwardDeliveries()).toEqual([]);
  expect(f.journal().listPendingPeerMirrorDeliveries().map(value => value.id)).toEqual([delivery.id]);
});

test("interrupted send is observed after restart without submitting again", async () => {
  const f = await fixture();
  const deliveryId = "interrupted";
  await f.journal().appendEntries({ kind: "deliveries.record", deliveries: [{
    id: deliveryId, invocationId: f.invocation.id, targetId: f.invocation.targetAgentId,
    targetNodeId: f.peer.id, targetKind: "agent", transport: "peer_broker", reason: "invocation", policy: "must_ack",
    status: "sent", metadata: { peerSubmission: { version: 1, status: "unknown", startedAt: 1, attempt: 1 } },
  }] });
  await f.reopen();
  const recovered = f.start();
  await recovered.tick();
  expect(f.counts()).toMatchObject({ forwards: 0, failures: 0, observations: 1 });
  expect(f.journal().getDelivery(deliveryId)?.status).toBe("sent");
});
