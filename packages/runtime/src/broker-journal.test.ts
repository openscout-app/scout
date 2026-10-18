import { decodeJournalLine, encodeJournalEntries, JOURNAL_FRAME_LIMITS } from "./broker-journal-framing.js";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ActorIdentity,
  AgentDefinition,
  DeliveryIntent,
  DurableAction,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
} from "@openscout/protocol";

import {
  FileBackedBrokerJournal,
  type FileBackedBrokerJournalOptions,
  type BrokerJournalReplayBarrier,
} from "./broker-journal.ts";

const journalRoots = new Set<string>();

afterEach(() => {
  for (const root of journalRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  journalRoots.clear();
});

function createJournal(
  options: FileBackedBrokerJournalOptions = {},
): { journal: FileBackedBrokerJournal; journalPath: string } {
  const root = mkdtempSync(join(tmpdir(), "openscout-broker-journal-"));
  journalRoots.add(root);
  const journalPath = join(root, "broker-journal.jsonl");
  return {
    journal: new FileBackedBrokerJournal(journalPath, options),
    journalPath,
  };
}

function sampleActor(): ActorIdentity {
  return {
    id: "agent-1",
    kind: "agent",
    displayName: "Agent One",
    handle: "agent-one",
    labels: ["builder"],
    metadata: {
      workspace: "/tmp/agent-one",
    },
  };
}

function sampleAgent(): AgentDefinition {
  return {
    ...sampleActor(),
    kind: "agent",
    definitionId: "agent-1",
    agentClass: "builder",
    capabilities: ["chat", "execute"],
    wakePolicy: "on_demand",
    homeNodeId: "node-1",
    authorityNodeId: "node-1",
    advertiseScope: "local",
  };
}

function sampleMessage(): MessageRecord {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    actorId: "operator",
    originNodeId: "node-1",
    class: "agent",
    body: "hello",
    visibility: "private",
    policy: "durable",
    createdAt: 1_700_000_000_000,
  };
}

function sampleInvocation(): InvocationRequest {
  return {
    id: "inv-1",
    requesterId: "operator",
    requesterNodeId: "node-1",
    targetAgentId: "agent-1",
    action: "execute",
    task: "Run the issue runner.",
    ensureAwake: true,
    stream: true,
    createdAt: 1_700_000_000_001,
  };
}

function sampleFlight(): FlightRecord {
  return {
    id: "flt-1",
    invocationId: "inv-1",
    requesterId: "operator",
    targetAgentId: "agent-1",
    state: "running",
    summary: "Running issue work.",
    startedAt: 1_700_000_000_002,
  };
}

function sampleDurableAction(input: Partial<DurableAction> = {}): DurableAction {
  return {
    id: "action-1",
    kind: "message_delivery",
    subjectId: "delivery-1",
    authorityCellId: "node-1",
    state: "pending",
    idempotencyKey: "delivery-1:create",
    leaseGeneration: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...input,
  };
}

function sampleReplayBarrier(id: string): BrokerJournalReplayBarrier {
  return {
    id,
    projectionId: "control-plane",
    projectionVersion: 1,
    createdAt: 1_700_000_000_000,
  };
}

describe("FileBackedBrokerJournal", () => {
  test("reports startup scan and compaction diagnostics without record payloads", async () => {
    const { journal, journalPath } = createJournal();
    const actor = sampleActor();
    writeFileSync(
      journalPath,
      [
        JSON.stringify({ kind: "actor.upsert", actor }),
        "",
        "{not-json",
        JSON.stringify({ kind: "actor.upsert", actor: { ...actor, displayName: "Updated" } }),
        JSON.stringify({ kind: "message.record", message: sampleMessage() }),
      ].join("\n") + "\n",
      "utf8",
    );

    const report = await journal.load();

    expect(report.validEntries).toBe(3);
    expect(report.invalidLines).toBe(1);
    expect(report.blankLines).toBe(1);
    expect(report.compactionRequired).toBe(true);
    expect(report.estimatedReclaimBytes).toBeGreaterThan(0);
    expect(report.estimatedReclaimRatio).toBeGreaterThan(0);
    expect(report.compactionReason).not.toBeNull();
    expect(report.countsByKind).toEqual({
      "actor.upsert": 2,
      "message.record": 1,
    });
    expect(report.sourceBytes).toBeGreaterThan(report.compactedBytes);
    expect(report.totalMs).toBeGreaterThanOrEqual(report.scanMs + report.compactionMs);
    expect(JSON.stringify(report)).not.toContain("hello");
    expect(journal.loadReport()).toEqual(report);
  });

  test("does not rewrite the whole journal for a trivial duplicate", async () => {
    const { journal, journalPath } = createJournal();
    const actor = sampleActor();
    const supersededLine = JSON.stringify({ kind: "actor.upsert", actor });
    const originalContents = [
      supersededLine,
      JSON.stringify({
        kind: "message.record",
        message: { ...sampleMessage(), body: "x".repeat(32_000) },
      }),
      JSON.stringify({ kind: "actor.upsert", actor: { ...actor, displayName: "Updated" } }),
    ].join("\n") + "\n";
    writeFileSync(journalPath, originalContents, "utf8");

    const report = await journal.load();

    expect(report.compactionRequired).toBe(false);
    expect(report.compactionReason).toBeNull();
    expect(report.estimatedReclaimBytes).toBe(Buffer.byteLength(supersededLine, "utf8") + 1);
    expect(report.estimatedReclaimRatio).toBeLessThan(0.05);
    expect(report.compactionMs).toBe(0);
    expect(report.compactedBytes).toBe(report.sourceBytes);
    expect(readFileSync(journalPath, "utf8")).toBe(originalContents);
    expect(journal.snapshot().actors["agent-1"]?.displayName).toBe("Updated");
  });

  test("uses the high-water policy when a large journal has bounded reclaim", async () => {
    const { journal, journalPath } = createJournal({
      compactionPolicy: {
        minimumReclaimBytes: 100_000,
        minimumReclaimRatio: 0.99,
        highWaterBytes: 1_000,
        highWaterMinimumReclaimBytes: 100,
      },
    });
    const actor = sampleActor();
    writeFileSync(
      journalPath,
      [
        JSON.stringify({ kind: "actor.upsert", actor }),
        JSON.stringify({
          kind: "message.record",
          message: { ...sampleMessage(), body: "x".repeat(2_000) },
        }),
        JSON.stringify({ kind: "actor.upsert", actor: { ...actor, displayName: "Updated" } }),
      ].join("\n") + "\n",
      "utf8",
    );

    const report = await journal.load();

    expect(report.compactionRequired).toBe(true);
    expect(report.compactionReason).toBe("high_water");
    expect((await journal.readEntries()).filter((entry) => entry.kind === "actor.upsert"))
      .toHaveLength(1);
  });

  test("dedupes within a batch and preserves delete-then-reinsert ordering", async () => {
    const { journal } = createJournal(); await journal.load();
    const actor = sampleActor();
    const changed = { ...actor, displayName: "Changed" };
    const endpoint = {id: "ep", agentId: actor.id, nodeId: "node-1", harness: "codex" as const, transport: "local_socket" as const, state: "idle" as const};
    await journal.appendEntries({kind: "agent.endpoint.upsert", endpoint});
    const retained = await journal.appendEntries([
      {kind: "actor.upsert", actor}, {kind: "actor.upsert", actor},
      {kind: "actor.upsert", actor: changed}, {kind: "actor.upsert", actor: changed},
      {kind: "agent.endpoint.delete", endpointId: endpoint.id},
      {kind: "agent.endpoint.upsert", endpoint},
    ]);
    expect(retained).toHaveLength(4);
    expect(journal.snapshot().actors[actor.id]).toEqual(changed);
    expect(journal.snapshot().endpoints[endpoint.id]).toEqual(endpoint);
  });

  test("failed durable append does not publish copy-on-write batch state", async () => {
    const { journal, journalPath } = createJournal(); await journal.load();
    mkdirSync(journalPath);
    await expect(journal.appendEntries({kind: "agent.upsert", agent: sampleAgent()})).rejects.toThrow();
    expect(journal.snapshot().agents).toEqual({});
    expect(journal.snapshot().actors).toEqual({});
  });

  test("skips redundant entity upserts on append", async () => {
    const { journal, journalPath } = createJournal();
    await journal.load();

    const first = await journal.appendEntries([
      { kind: "actor.upsert", actor: sampleActor() },
      { kind: "agent.upsert", agent: sampleAgent() },
    ]);
    const second = await journal.appendEntries([
      { kind: "actor.upsert", actor: sampleActor() },
      { kind: "agent.upsert", agent: sampleAgent() },
    ]);

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(0);

    const lines = readFileSync(journalPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => decodeJournalLine(line));

    expect(lines.filter((entry) => entry.kind === "actor.upsert")).toHaveLength(1);
    expect(lines.filter((entry) => entry.kind === "agent.upsert")).toHaveLength(1);
  });

  test("replays a stable byte boundary while later appends remain queued for projection", async () => {
    const { journal } = createJournal();
    await journal.load();
    await journal.appendEntries({ kind: "actor.upsert", actor: sampleActor() });

    const boundary = await journal.captureReplayBoundary();
    await journal.appendEntries({ kind: "message.record", message: sampleMessage() });

    const boundedKinds: string[] = [];
    await journal.replay((entry) => {
      boundedKinds.push(entry.kind);
    }, boundary);
    const allKinds = (await journal.readEntries()).map((entry) => entry.kind);

    expect(boundedKinds).toEqual(["actor.upsert"]);
    expect(allKinds).toEqual(["actor.upsert", "message.record"]);
  });

  test("captures an opaque barrier atomically and resumes after it without exposing barriers", async () => {
    const { journal } = createJournal();
    await journal.load();
    await journal.appendEntries({ kind: "actor.upsert", actor: sampleActor() });

    const firstBarrier = sampleReplayBarrier("barrier-1");
    const firstBoundary = await journal.captureReplayBoundary({ barrier: firstBarrier });
    await journal.appendEntries({ kind: "message.record", message: sampleMessage() });
    const secondBoundary = await journal.captureReplayBoundary({
      barrier: sampleReplayBarrier("barrier-2"),
    });

    const replayedKinds: string[] = [];
    const report = await journal.replay((entry) => {
      replayedKinds.push(entry.kind);
    }, secondBoundary, { afterBarrier: firstBarrier });

    expect(firstBoundary.barrier).toEqual(firstBarrier);
    expect(report).toEqual({ afterBarrierFound: true, visitedEntries: 1 });
    expect(replayedKinds).toEqual(["message.record"]);
    expect((await journal.readEntries()).map((entry) => entry.kind)).toEqual([
      "actor.upsert",
      "journal.replay_barrier",
      "message.record",
      "journal.replay_barrier",
    ]);
    expect(journal.snapshot().messages["msg-1"]).toEqual(sampleMessage());
  });

  test("fails closed when a requested replay barrier is absent", async () => {
    const { journal } = createJournal();
    await journal.load();
    await journal.appendEntries({ kind: "message.record", message: sampleMessage() });

    const replayedKinds: string[] = [];
    const report = await journal.replay((entry) => {
      replayedKinds.push(entry.kind);
    }, undefined, { afterBarrier: sampleReplayBarrier("missing") });

    expect(report).toEqual({ afterBarrierFound: false, visitedEntries: 0 });
    expect(replayedKinds).toEqual([]);
  });

  test("does not resume from a same-id marker owned by another projection", async () => {
    const { journal } = createJournal();
    await journal.load();
    const barrier = sampleReplayBarrier("shared-id");
    const boundary = await journal.captureReplayBoundary({ barrier });

    const report = await journal.replay(() => {
      throw new Error("foreign barrier must not release replay");
    }, boundary, {
      afterBarrier: { ...barrier, projectionId: "foreign-projection" },
    });

    expect(report).toEqual({ afterBarrierFound: false, visitedEntries: 0 });
  });

  test("skips identical flight records while preserving state transitions", async () => {
    const { journal, journalPath } = createJournal();
    await journal.load();
    const running = sampleFlight();
    const completed = {
      ...running,
      state: "completed" as const,
      summary: "Issue work complete.",
      completedAt: running.startedAt + 1_000,
    };

    expect(await journal.appendEntries({ kind: "flight.record", flight: running })).toHaveLength(1);
    expect(await journal.appendEntries({ kind: "flight.record", flight: structuredClone(running) })).toHaveLength(0);
    expect(await journal.appendEntries({ kind: "flight.record", flight: completed })).toHaveLength(1);
    expect(await journal.appendEntries({ kind: "flight.record", flight: structuredClone(completed) })).toHaveLength(0);

    const flightEntries = readFileSync(journalPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; flight?: FlightRecord })
      .filter((entry) => entry.kind === "flight.record");
    expect(flightEntries.map((entry) => entry.flight?.state)).toEqual(["running", "completed"]);
  });

  test("compacts superseded upserts on load while preserving non-upsert entries", async () => {
    const { journal, journalPath } = createJournal();
    const actor = sampleActor();
    const updatedActor = {
      ...actor,
      displayName: "Agent One Updated",
    };

    writeFileSync(
      journalPath,
      [
        JSON.stringify({ kind: "actor.upsert", actor }),
        JSON.stringify({
          kind: "journal.replay_barrier",
          barrier: sampleReplayBarrier("retained-barrier"),
        }),
        JSON.stringify({ kind: "message.record", message: sampleMessage() }),
        JSON.stringify({ kind: "actor.upsert", actor: updatedActor }),
      ].join("\n") + "\n",
      "utf8",
    );

    await journal.load();

    const compactedEntries = await journal.readEntries();
    expect(compactedEntries).toHaveLength(3);
    expect(compactedEntries.filter((entry) => entry.kind === "actor.upsert")).toHaveLength(1);
    expect(compactedEntries.filter((entry) => entry.kind === "message.record")).toHaveLength(1);
    expect(compactedEntries.map((entry) => entry.kind)).toEqual([
      "journal.replay_barrier",
      "message.record",
      "actor.upsert",
    ]);
    expect(journal.snapshot().actors["agent-1"]?.displayName).toBe("Agent One Updated");
  });

  test("compacts identical flight records on load while preserving transitions", async () => {
    const { journal, journalPath } = createJournal();
    const running = sampleFlight();
    const completed = {
      ...running,
      state: "completed" as const,
      summary: "Issue work complete.",
      completedAt: running.startedAt + 1_000,
    };

    writeFileSync(
      journalPath,
      [
        running,
        structuredClone(running),
        completed,
        structuredClone(completed),
      ].map((flight) => JSON.stringify({ kind: "flight.record", flight })).join("\n") + "\n",
      "utf8",
    );

    await journal.load();

    const compactedEntries = await journal.readEntries();
    expect(compactedEntries).toHaveLength(2);
    expect(compactedEntries.map((entry) => (
      entry.kind === "flight.record" ? entry.flight.state : entry.kind
    ))).toEqual(["running", "completed"]);
    expect(journal.snapshot().flights["flt-1"]?.state).toBe("completed");
  });

  test("replays invocation records into snapshots", async () => {
    const { journal, journalPath } = createJournal();

    writeFileSync(
      journalPath,
      [
        JSON.stringify({ kind: "invocation.record", invocation: sampleInvocation() }),
        JSON.stringify({ kind: "flight.record", flight: sampleFlight() }),
      ].join("\n") + "\n",
      "utf8",
    );

    await journal.load();

    const snapshot = journal.snapshot();
    expect(snapshot.invocations["inv-1"]).toEqual(expect.objectContaining({
      targetAgentId: "agent-1",
    }));
    expect(snapshot.flights["flt-1"]).toEqual(expect.objectContaining({
      invocationId: "inv-1",
    }));
  });

  test.each([false, true])("flight current selection survives duplicate selection, compaction and reopen (preserveCurrent=%s)", async preserveCurrent => {
    const { journal, journalPath } = createJournal({ compactionPolicy: { minimumReclaimBytes: 1, minimumReclaimRatio: 0 } });
    await journal.load();
    const first = sampleFlight(), second = { ...first, id: "flt-2" };
    await journal.appendEntries([
      { kind: "flight.record", flight: first },
      { kind: "flight.record", flight: second },
      { kind: "flight.record", flight: first, preserveCurrent },
    ]);
    const expected = preserveCurrent ? second.id : first.id;
    expect(journal.getCurrentFlightForInvocation(first.invocationId)?.id).toBe(expected);
    // A redundant copy makes compaction run, while the repeated first flight
    // above is semantically required only when it changes current selection.
    await fsPromises.appendFile(journalPath, `${JSON.stringify({ kind: "flight.record", flight: first, preserveCurrent: true })}\n`);
    const compacted = new FileBackedBrokerJournal(journalPath, { compactionPolicy: { minimumReclaimBytes: 1, minimumReclaimRatio: 0 } });
    expect((await compacted.load()).compactionRequired).toBe(true);
    expect(compacted.getCurrentFlightForInvocation(first.invocationId)?.id).toBe(expected);
    const reopened = new FileBackedBrokerJournal(journalPath);
    await reopened.load();
    expect(reopened.getCurrentFlightForInvocation(first.invocationId)?.id).toBe(expected);
  });

  test("looks up durable actions by idempotency key after replay", async () => {
    const { journal, journalPath } = createJournal();

    writeFileSync(
      journalPath,
      JSON.stringify({
        kind: "durable.action.record",
        action: sampleDurableAction(),
      }) + "\n",
      "utf8",
    );

    await journal.load();

    expect(journal.getDurableActionByIdempotencyKey({
      authorityCellId: "node-1",
      kind: "message_delivery",
      idempotencyKey: "delivery-1:create",
    })?.id).toBe("action-1");
    expect(journal.getDurableActionByIdempotencyKey({
      authorityCellId: "node-other",
      kind: "message_delivery",
      idempotencyKey: "delivery-1:create",
    })).toBeNull();
  });
});


describe("bounded delivery listing", () => {
  test("target, status set and reason set are filtered before the page limit", async () => {
    const { journal } = createJournal();
    await journal.load();
    const base = { targetKind: "agent" as const, transport: "local_socket" as const, policy: "best_effort" as const,
      reason: "direct_message" as const, status: "pending" as const };
    await journal.appendEntries({ kind: "deliveries.record", deliveries: [
      ...Array.from({ length: 5_001 }, (_, i) => ({ ...base, id: `unrelated-${i}`, targetId: "elsewhere" })),
      { ...base, id: "terminal", targetId: "wanted", status: "acknowledged" },
      { ...base, id: "wanted", targetId: "wanted" },
    ] });
    expect(journal.listDeliveries({ targetId: "wanted", statuses: ["pending"], reasons: ["direct_message"], limit: 1 }).map(row => row.id)).toEqual(["wanted"]);
    expect(journal.listDeliveries({ targetId: "wanted", statuses: [], limit: 1 })).toEqual([]);
    expect(journal.listDeliveries({ reasons: [], limit: 1 })).toEqual([]);
  });

  test("matches filtered insertion-order slice including unusual limits and replacements", async () => {
    const { journal } = createJournal();
    await journal.load();
    const deliveries = Array.from({ length: 6001 }, (_, i) => ({
      id: `delivery-${i}`, targetId: "agent-1", targetKind: "agent" as const,
      transport: i % 2 ? "local_socket" as const : "peer_broker" as const,
      reason: "direct_message" as const, policy: "best_effort" as const,
      status: i % 3 ? "pending" as const : "acknowledged" as const,
    }));
    await journal.appendEntries({ kind: "deliveries.record", deliveries });
    const replacement = { ...deliveries[2]!, status: "pending" as const };
    deliveries[2] = replacement;
    await journal.appendEntries({ kind: "deliveries.record", deliveries: [replacement] });
    expect(journal.getDelivery("delivery-6000")).toEqual(deliveries[6000]);
    expect(journal.getDelivery("missing")).toBeUndefined();
    expect(journal.getDelivery("delivery-2")).toEqual(replacement);
    expect(journal.findDelivery(d => d.id === "delivery-6000")).toEqual(deliveries[6000]);
    expect(journal.findDelivery(() => false)).toBeUndefined();
    for (const limit of [undefined, 0, 1, 20, 5000, 7000, 1.9, -1, -3.7, NaN, Infinity, -Infinity]) {
      for (const transport of [undefined, "local_socket" as const]) {
        for (const status of [undefined, "pending" as const]) {
          const expected = deliveries.filter(d => !transport || d.transport === transport)
            .filter(d => !status || d.status === status).slice(0, limit ?? 200);
          expect(journal.listDeliveries({ limit, transport, status })).toEqual(expected);
        }
      }
    }
  });
});

test("pending result index replaces flights and reconstructs only undelivered replies", async () => {
  const { journal, journalPath } = createJournal();
  await journal.load();
  const pending = { ...sampleFlight(), state: "completed" as const, metadata: { resultReply: { status: "pending" } } };
  await journal.appendEntries({ kind: "flight.record", flight: pending });
  expect([...journal.pendingInvocationResultFlights()]).toEqual([pending]);
  await journal.appendEntries({ kind: "flight.record", flight: { ...pending, metadata: { resultReply: { status: "delivered" } } } });
  expect([...journal.pendingInvocationResultFlights()]).toEqual([]);
  const next = { ...pending, id: "flight-other", invocationId: "invocation-other" };
  await journal.appendEntries({ kind: "flight.record", flight: next });
  const restored = new FileBackedBrokerJournal(journalPath); await restored.load();
  expect([...restored.pendingInvocationResultFlights()]).toEqual([next]);
});

test("complete delivery traversal yields and excludes later appends without freezing replacements", async () => {
  const { journal } = createJournal();
  await journal.load();
  const deliveries = Array.from({ length: 1500 }, (_, index) => ({
    id: `visit-${index}`, targetId: "agent", targetKind: "agent" as const,
    transport: "local_socket" as const, policy: "best_effort" as const,
    reason: "direct_message" as const, status: "pending" as const,
  }));
  await journal.appendEntries({ kind: "deliveries.record", deliveries });
  let yielded = false;
  setImmediate(() => { yielded = true; });
  const seen: string[] = [];
  await journal.visitDeliveries(async (delivery) => {
    seen.push(delivery.id);
    if (seen.length === 1) {
      await journal.appendEntries({ kind: "deliveries.record", deliveries: [{ ...deliveries[0]!, id: "later" }] });
      await journal.appendEntries({ kind: "delivery.status.update", deliveryId: "visit-1400", status: "acknowledged" });
    }
    if (seen.length === 130) expect(yielded).toBe(true);
    if (delivery.id === "visit-1400") expect(delivery.status).toBe("acknowledged");
  });
  expect(seen).toEqual(deliveries.map((delivery) => delivery.id));
  expect(journal.getDelivery("later")).toBeDefined();
});


test("canonical delivery reads reconstruct status/leases/large metadata and preserve captured boundaries", async () => {
  const { journal, journalPath } = createJournal();
  await journal.load();
  const original: DeliveryIntent = {
    id: "canonical-delivery", targetId: "agent", targetKind: "agent", transport: "local_socket",
    reason: "direct_message", policy: "durable", status: "pending", messageId: "message",
    invocationId: "invocation", bindingId: "binding", targetNodeId: "node",
    metadata: { rich: "雪🦉\ud800".repeat(20000), nested: { array: [null, true, 3] } },
  };
  await journal.appendEntries({ kind: "deliveries.record", deliveries: [original] });
  const capture = journal.captureReplayBoundary.bind(journal);
  let markCaptured!: () => void;
  let resume!: () => void;
  const captured = new Promise<void>((resolve) => { markCaptured = resolve; });
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  journal.captureReplayBoundary = async (...args) => {
    const boundary = await capture(...args); markCaptured(); await paused; return boundary;
  };
  const priorRead = journal.readCanonicalDelivery(original.id);
  await captured;
  await journal.appendEntries({ kind: "delivery.status.update", deliveryId: original.id,
    status: "leased", leaseOwner: "worker", leaseExpiresAt: 5000, metadata: { phase: "leased" } });
  resume();
  const prior = await priorRead;
  expect(prior.kind).toBe("found");
  if (prior.kind === "found") expect(prior.value).toEqual(original);
  journal.captureReplayBoundary = capture;
  const leased = await journal.readCanonicalDelivery(original.id);
  expect(leased.kind).toBe("found");
  if (leased.kind === "found") expect(leased.value).toEqual({ ...original, status: "leased",
    leaseOwner: "worker", leaseExpiresAt: 5000, metadata: { ...original.metadata, phase: "leased" } });
  await journal.appendEntries({ kind: "delivery.status.update", deliveryId: original.id, status: "completed",
    leaseOwner: null, leaseExpiresAt: null, metadata: { phase: "completed" } });
  const final = await journal.readCanonicalDelivery(original.id);
  expect(final.kind).toBe("found");
  if (final.kind === "found") {
    expect(final.value.leaseOwner).toBeUndefined();
    expect(final.value.leaseExpiresAt).toBeUndefined();
    expect(final.value.metadata).toEqual({ ...original.metadata, phase: "completed" });
  }
  await journal.appendEntries({ kind: "delivery.status.update", deliveryId: "unknown", status: "acknowledged" });
  expect((await journal.readCanonicalDelivery("unknown")).kind).toBe("not_found");
  rmSync(journalPath);
  expect((await journal.readCanonicalDelivery(original.id)).kind).toBe("unavailable");
  expect((await journal.readCanonicalDelivery("absent")).kind).toBe("unavailable");
});

test("canonical delivery coverage rejects malformed records and survives journal compaction/restart", async () => {
  const { journal, journalPath } = createJournal({ compactionPolicy: { minimumReclaimBytes: 1 } });
  await journal.load();
  await journal.appendEntries({ kind: "deliveries.record", deliveries: [{ id: "d", targetId: "a", targetKind: "agent",
    transport: "local_socket", reason: "mention", policy: "durable", status: "pending", metadata: { a: 1 } }] });
  await journal.appendEntries({ kind: "delivery.status.update", deliveryId: "d", status: "acknowledged", metadata: { b: 2 } });
  await journal.appendEntries({ kind: "actor.upsert", actor: { id: "a", kind: "agent", displayName: "before" } });
  await journal.appendEntries({ kind: "actor.upsert", actor: { id: "a", kind: "agent", displayName: "after" } });
  const expected = await journal.readCanonicalDelivery("d");
  const restarted = new FileBackedBrokerJournal(journalPath, { compactionPolicy: { minimumReclaimBytes: 1 } });
  expect((await restarted.load()).compactionRequired).toBe(true);
  const actual = await restarted.readCanonicalDelivery("d");
  expect(actual.kind).toBe("found");
  if (expected.kind === "found" && actual.kind === "found") expect(actual.value).toEqual(expected.value);
  const valid = readFileSync(journalPath, "utf8");
  for (const suffix of ["bad-json", JSON.stringify({ kind: "delivery.status.update", deliveryId: "d", status: "delivered" }),
    JSON.stringify({ kind: "deliveries.record", deliveries: [{ id: "bad", status: "pending" }] })]) {
    writeFileSync(journalPath, valid + suffix + "\n");
    expect((await restarted.readCanonicalDelivery("d")).kind).toBe("unavailable");
    expect((await restarted.readCanonicalDelivery("absent")).kind).toBe("unavailable");
  }
});


test("active delivery traversal excludes later appends after filtering terminal records", async () => {
  const { journal } = createJournal();
  await journal.load();
  const delivery: DeliveryIntent = { id: "active-first", targetId: "agent", targetKind: "agent",
    transport: "local_socket", policy: "best_effort", reason: "direct_message", status: "pending" };
  await journal.appendEntries({ kind: "deliveries.record", deliveries: [
    delivery, { ...delivery, id: "terminal", status: "completed" }, { ...delivery, id: "active-last" },
  ] });
  const seen: string[] = [];
  await journal.visitDeliveries(async (current) => {
    seen.push(current.id);
    if (current.id === "active-first") {
      await journal.appendEntries({ kind: "deliveries.record", deliveries: [{ ...delivery, id: "later" }] });
    }
  }, { activeOnly: true });
  expect(seen).toEqual(["active-first", "active-last"]);
  expect(journal.getDelivery("later")).toBeDefined();
});

describe("progressive startup", () => {
  test("defers compaction, preserves writes during prefix rewrite and is restart exact", async () => {
    const { journal, journalPath } = createJournal({ progressiveStartup: true,
      compactionPolicy: { minimumReclaimBytes: 1, minimumReclaimRatio: 0 } });
    const actor = sampleActor();
    writeFileSync(journalPath, Array.from({ length: 2000 }, (_, i) => JSON.stringify({ kind: "actor.upsert", actor: { ...actor, displayName: `old-${i}` } }) + "\n").join(""));
    const report = await journal.load();
    expect(report.compactionRequired).toBe(true);
    expect(report.compactionMs).toBe(0);
    expect(journal.snapshot().actors[actor.id]?.displayName).toBe("old-1999");
    const hydration = journal.finishStartup();
    for (let i = 0; i < 20; i++) await journal.appendEntries([{ kind: "actor.upsert", actor: { ...actor, displayName: `accepted-${i}` } }]);
    await hydration;
    expect(journal.startupStatus().phase).toBe("complete");
    const restarted = new FileBackedBrokerJournal(journalPath);
    await restarted.load();
    expect(restarted.snapshot().actors[actor.id]?.displayName).toBe("accepted-19");
    await journal.close(); await restarted.close();
  });

  test("folds deferred compaction into the load report after hydration", async () => {
    const { journal, journalPath } = createJournal({ progressiveStartup: true,
      compactionPolicy: { minimumReclaimBytes: 1, minimumReclaimRatio: 0 } });
    const actor = sampleActor();
    writeFileSync(journalPath, Array.from({ length: 500 }, (_, i) => JSON.stringify({ kind: "actor.upsert", actor: { ...actor, displayName: `old-${i}` } }) + "\n").join(""));
    const initial = await journal.load();
    expect(initial.compactionRequired).toBe(true);
    expect(initial.compactionReason).not.toBeNull();
    // Deferred: the pre-hydration report cannot know the real numbers yet.
    expect(initial.compactionMs).toBe(0);
    await journal.finishStartup();
    const report = journal.loadReport();
    expect(report).not.toBeNull();
    expect(report!.compactionMs).toBe(journal.startupStatus().compactionMs);
    expect(report!.compactedBytes).toBeLessThan(report!.sourceBytes);
    expect(report!.compactedBytes).toBe(statSync(journalPath).size);
    expect(report!.compactionReason).toBe(initial.compactionReason);
    // The deferred work folds into the reported totals as well — a reader sees
    // the full cost of load + compaction, not just the eager prefix.
    expect(report!.completedAt).toBeGreaterThanOrEqual(initial.completedAt);
    expect(report!.totalMs).toBeGreaterThanOrEqual(initial.totalMs);
    await journal.close();
  });

  test("startup hydration rejects before load instead of caching a false completion", async () => {
    const { journal } = createJournal({ progressiveStartup: true });
    await expect(journal.finishStartup()).rejects.toThrow("must be loaded");
    await journal.load(); await journal.finishStartup();
    expect(journal.startupStatus().phase).toBe("complete");
    await journal.close();
  });
});

test("failed background compaction leaves the canonical prefix and accepted suffix recoverable", async () => {
  const { journal, journalPath } = createJournal({ progressiveStartup: true,
    compactionPolicy: { minimumReclaimBytes: 1, minimumReclaimRatio: 0 } });
  const actor = sampleActor();
  writeFileSync(journalPath, Array.from({ length: 128 }, (_, i) => JSON.stringify({ kind: "actor.upsert", actor: { ...actor, displayName: `old-${i}` } }) + "\n").join(""));
  await journal.load();
  // Inject a failed streaming reader after output has begun, while accepting a
  // concurrent command. The original file must remain the recovery authority.
  const internal = journal as unknown as { visitEntries: (...args: any[]) => Promise<any> };
  const visit = internal.visitEntries.bind(journal);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  internal.visitEntries = (visitor, options) => visit(async (entry: unknown, index: number, bytes: number) => {
    if (index === 0) { entered(); await resume; }
    await visitor(entry, index, bytes);
    if (index === 32) throw Error("injected compaction read failure");
  }, options);
  const hydration = journal.finishStartup();
  const rejected = hydration.catch(error => error);
  await started;
  await journal.appendEntries([{ kind: "actor.upsert", actor: { ...actor, displayName: "accepted-during-failure" } }]);
  release();
  expect(await rejected).toBeInstanceOf(Error);
  expect(journal.startupStatus().phase).toBe("failed");
  const recovered = new FileBackedBrokerJournal(journalPath);
  await recovered.load();
  expect(recovered.snapshot().actors[actor.id]?.displayName).toBe("accepted-during-failure");
  await journal.close(); await recovered.close();
});

describe("compaction output failures", () => {
  const options = { progressiveStartup: true,
    compactionPolicy: { minimumReclaimBytes: 1, minimumReclaimRatio: 0 } };

  function seed(journalPath: string): string {
    const actor = sampleActor();
    const contents = [
      { kind: "actor.upsert", actor },
      ...Array.from({ length: 3 }, (_, index) => ({ kind: "message.record",
        message: { ...sampleMessage(), id: `preserved-${index}`, body: `${index}:` + "x".repeat(80_000) } })),
      { kind: "actor.upsert", actor: { ...actor, displayName: "latest" } },
    ].map(entry => JSON.stringify(entry) + "\n").join("");
    writeFileSync(journalPath, contents);
    return contents;
  }

  async function settles(work: Promise<void>): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work.then(() => "complete", error => error),
        new Promise(resolve => { timer = setTimeout(() => resolve("compaction stayed pending"), 1_000); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function expectRecovered(journalPath: string): Promise<void> {
    const restarted = new FileBackedBrokerJournal(journalPath, options);
    await restarted.load();
    await restarted.finishStartup();
    expect(restarted.startupStatus().phase).toBe("complete");
    expect(restarted.snapshot().actors["agent-1"]?.displayName).toBe("accepted-after-failure");
    for (let index = 0; index < 3; index++) {
      expect(restarted.snapshot().messages[`preserved-${index}`]?.body)
        .toBe(`${index}:` + "x".repeat(80_000));
    }
    await restarted.close();
  }

  const acceptedActor = () => ({ kind: "actor.upsert" as const,
    actor: { ...sampleActor(), displayName: "accepted-after-failure" } });

  test.each(["ENOSPC", "EDQUOT"] as const)("an asynchronous temporary-file open %s defers optional compaction without blocking startup", async (code) => {
    const { journal, journalPath } = createJournal(options);
    const original = seed(journalPath);
    await journal.load();
    const realOpen = fsPromises.open;
    const failure = Object.assign(new Error(`${code}: temporary output open failed`), { code });
    const openOutput = spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      if (String(args[0]).startsWith(`${journalPath}.`) && args[1] === "wx") {
        await new Promise(resolve => setImmediate(resolve));
        throw failure;
      }
      return realOpen(...args);
    });
    try {
      expect(await settles(journal.finishStartup())).toBe("complete");
      expect(journal.startupStatus()).toMatchObject({ phase: "complete", error: null,
        compactionDeferral: { code, operation: "open" } });
      expect(readFileSync(journalPath, "utf8")).toBe(original);
      await journal.appendEntries(acceptedActor());
      expect(readFileSync(journalPath, "utf8")).toBe(original + JSON.stringify(acceptedActor()) + "\n");
      expect((await fsPromises.readdir(join(journalPath, ".."))).filter(name => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      openOutput.mockRestore();
      await journal.close();
    }
    await expectRecovered(journalPath);
  });

  test.each(["partial-write", "closed-handle"] as const)("a %s failure preserves the canonical prefix and concurrently accepted suffix", async (mode) => {
    const { journal, journalPath } = createJournal(options);
    seed(journalPath);
    await journal.load();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const realOpen = fsPromises.open;
    let outputWrites = 0;
    const openOutput = spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]).startsWith(`${journalPath}.`) && args[1] === "wx") {
        const writeFile = handle.writeFile.bind(handle);
        handle.writeFile = async (...writeArgs) => {
          if (++outputWrites === 2) {
            entered();
            await resume;
            if (mode === "closed-handle") {
              await handle.close();
              return writeFile(...writeArgs);
            }
            await writeFile(String(writeArgs[0]).slice(0, 17), "utf8");
            throw Object.assign(new Error("ENOSPC: partial compaction output"), { code: "ENOSPC" });
          }
          return writeFile(...writeArgs);
        };
      }
      return handle;
    });
    try {
      const hydration = journal.finishStartup();
      const outcome = settles(hydration);
      await started;
      await journal.appendEntries(acceptedActor());
      const acceptedBytes = readFileSync(journalPath, "utf8");
      release();
      const result = await outcome;
      if (mode === "partial-write") {
        expect(result).toBe("complete");
        expect(journal.startupStatus()).toMatchObject({ phase: "complete", error: null,
          compactionDeferral: { code: "ENOSPC", operation: "write" } });
      } else {
        expect(result).toBeInstanceOf(Error);
        expect(journal.startupStatus()).toMatchObject({ phase: "failed", compactionDeferral: null });
      }
      expect(outputWrites).toBe(2);
      expect(readFileSync(journalPath, "utf8")).toBe(acceptedBytes);
      expect((await fsPromises.readdir(join(journalPath, ".."))).filter(name => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      release();
      openOutput.mockRestore();
      await journal.close();
    }
    await expectRecovered(journalPath);
  });

  test.each([
    ["sync", "ENOSPC"], ["close", "ENOSPC"], ["sync", "EIO"], ["close", "EIO"],
  ] as const)("an output %s %s preserves the source and releases queued appends", async (operation, code) => {
    const { journal, journalPath } = createJournal(options);
    const original = seed(journalPath);
    await journal.load();
    const realOpen = fsPromises.open;
    const failure = Object.assign(new Error(`compaction ${operation} failed`), { code });
    const openOutput = spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]).startsWith(`${journalPath}.`) && args[1] === "wx") {
        const originalOperation = handle[operation].bind(handle);
        let fail = true;
        handle[operation] = async () => {
          if (fail) { fail = false; throw failure; }
          return originalOperation();
        };
      }
      return handle;
    });
    try {
      if (code === "ENOSPC") {
        expect(await settles(journal.finishStartup())).toBe("complete");
        expect(journal.startupStatus()).toMatchObject({ phase: "complete", error: null,
          compactionDeferral: { code, operation } });
      } else {
        expect(await settles(journal.finishStartup())).toBe(failure);
        expect(journal.startupStatus()).toMatchObject({ phase: "failed", compactionDeferral: null });
      }
      expect(readFileSync(journalPath, "utf8")).toBe(original);
      await journal.appendEntries(acceptedActor());
      expect(readFileSync(journalPath, "utf8")).toBe(original + JSON.stringify(acceptedActor()) + "\n");
      expect((await fsPromises.readdir(join(journalPath, ".."))).filter(name => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      openOutput.mockRestore();
      await journal.close();
    }
    await expectRecovered(journalPath);
  });

  test("source/rollback capacity failures remain fatal instead of being mistaken for optional output failure", async () => {
    for (const operation of ["visitEntries", "repairFailedAppend"] as const) {
      const { journal, journalPath } = createJournal(options);
      const original = seed(journalPath);
      await journal.load();
      const failure = Object.assign(new Error(`canonical ${operation} failed`), { code: "ENOSPC" });
      const internal = journal as unknown as Record<typeof operation, (...args: any[]) => Promise<any>>;
      const fail = spyOn(internal, operation).mockRejectedValueOnce(failure);
      try {
        expect(await settles(journal.finishStartup())).toBe(failure);
        expect(journal.startupStatus()).toMatchObject({ phase: "failed", compactionDeferral: null });
        expect(readFileSync(journalPath, "utf8")).toBe(original);
        expect((await fsPromises.readdir(join(journalPath, ".."))).filter(name => name.endsWith(".tmp"))).toEqual([]);
      } finally {
        fail.mockRestore();
        await journal.close();
      }
    }
  });

  test("required message coverage failure stays fatal after optional compaction deferral", async () => {
    const historyFailure = new Error("required history unavailable");
    const messageHistory = { records: {}, refresh: async () => { throw historyFailure; },
      accepted: async () => {}, close: async () => {}, status: () => ({ count: 0 }) };
    const { journal, journalPath } = createJournal({ ...options,
      messageHistory: messageHistory as unknown as NonNullable<FileBackedBrokerJournalOptions["messageHistory"]> });
    const original = seed(journalPath);
    await journal.load();
    const realOpen = fsPromises.open;
    const openOutput = spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      if (String(args[0]).startsWith(`${journalPath}.`) && args[1] === "wx") {
        throw Object.assign(new Error("capacity exhausted"), { code: "ENOSPC" });
      }
      return realOpen(...args);
    });
    try {
      expect(await settles(journal.finishStartup())).toBe(historyFailure);
      expect(journal.startupStatus()).toMatchObject({ phase: "failed", error: String(historyFailure),
        compactionDeferral: { code: "ENOSPC", operation: "open" } });
      expect(readFileSync(journalPath, "utf8")).toBe(original);
    } finally {
      openOutput.mockRestore();
      await journal.close();
    }
  });
});

describe("delete entries", () => {
  const endpoint = {
    id: "ep-1",
    agentId: "agent-1",
    nodeId: "node-1",
    harness: "codex" as const,
    transport: "local_socket" as const,
    state: "offline" as const,
  };

  test("replays an uncompacted upsert/delete pair into an empty registry", async () => {
    const { journal, journalPath } = createJournal({
      compactionPolicy: { minimumReclaimBytes: 1_000_000_000, minimumReclaimRatio: 1 },
    });
    writeFileSync(
      journalPath,
      [
        JSON.stringify({ kind: "actor.upsert", actor: sampleActor() }),
        JSON.stringify({ kind: "agent.upsert", agent: sampleAgent() }),
        JSON.stringify({ kind: "agent.endpoint.upsert", endpoint }),
        JSON.stringify({ kind: "agent.endpoint.delete", endpointId: endpoint.id }),
        JSON.stringify({ kind: "agent.delete", agentId: "agent-1" }),
        JSON.stringify({ kind: "actor.delete", actorId: "agent-1" }),
      ].join("\n") + "\n",
      "utf8",
    );

    await journal.load();

    expect(journal.snapshot().agents["agent-1"]).toBeUndefined();
    expect(journal.snapshot().endpoints["ep-1"]).toBeUndefined();
    expect(journal.snapshot().actors["agent-1"]).toBeUndefined();
    expect(await journal.readEntries()).toHaveLength(6);
  });

  test("agent.delete alone removes the agent and its endpoints", async () => {
    const { journal, journalPath } = createJournal({
      compactionPolicy: { minimumReclaimBytes: 1_000_000_000, minimumReclaimRatio: 1 },
    });
    writeFileSync(
      journalPath,
      [
        JSON.stringify({ kind: "agent.upsert", agent: sampleAgent() }),
        JSON.stringify({ kind: "agent.endpoint.upsert", endpoint }),
        // No endpoint.delete entry: agent.delete must still reap its endpoints.
        JSON.stringify({ kind: "agent.delete", agentId: "agent-1" }),
      ].join("\n") + "\n",
      "utf8",
    );

    await journal.load();

    expect(journal.snapshot().agents["agent-1"]).toBeUndefined();
    expect(journal.snapshot().endpoints["ep-1"]).toBeUndefined();
  });

  test("compaction keeps the latest delete tombstone per key", async () => {
    const { journal, journalPath } = createJournal({
      compactionPolicy: { minimumReclaimBytes: 1, minimumReclaimRatio: 0 },
    });
    const message = sampleMessage();
    writeFileSync(
      journalPath,
      [
        JSON.stringify({ kind: "actor.upsert", actor: sampleActor() }),
        JSON.stringify({ kind: "agent.upsert", agent: sampleAgent() }),
        JSON.stringify({ kind: "agent.endpoint.upsert", endpoint }),
        JSON.stringify({ kind: "agent.endpoint.delete", endpointId: endpoint.id }),
        JSON.stringify({ kind: "agent.delete", agentId: "agent-1" }),
        JSON.stringify({ kind: "actor.delete", actorId: "agent-1" }),
        JSON.stringify({ kind: "message.record", message }),
      ].join("\n") + "\n",
      "utf8",
    );

    await journal.load();

    const compacted = await journal.readEntries();
    // Tombstones must survive compaction: SQLite recovery replays a suffix
    // onto an existing database and cannot infer deletes from absence —
    // dropping them would leave deleted rows (and their references) behind.
    expect(compacted.map((entry) => entry.kind)).toEqual([
      "agent.endpoint.delete",
      "agent.delete",
      "actor.delete",
      "message.record",
    ]);
    expect(journal.snapshot().agents).toEqual({});
    expect(journal.snapshot().endpoints).toEqual({});
    expect(journal.snapshot().actors).toEqual({});
  });

  test("retired actor ids survive compaction, rebuild on restart, and clear on revival", async () => {
    // The runtime fences stale whole-record roster writes against
    // isRetiredActor — a restart from a compacted journal must rebuild the
    // set from the surviving actor.delete tombstones.
    const { journal, journalPath } = createJournal({
      compactionPolicy: { minimumReclaimBytes: 1, minimumReclaimRatio: 0 },
    });
    writeFileSync(
      journalPath,
      [
        JSON.stringify({ kind: "actor.upsert", actor: sampleActor() }),
        JSON.stringify({ kind: "actor.delete", actorId: "agent-1" }),
        // Revived: upsert after delete clears the tombstone.
        JSON.stringify({ kind: "actor.upsert", actor: { ...sampleActor(), id: "agent-2" } }),
        JSON.stringify({ kind: "actor.delete", actorId: "agent-2" }),
        JSON.stringify({ kind: "actor.upsert", actor: { ...sampleActor(), id: "agent-2" } }),
        // Revived via agent registration (synthesizes the actor identity).
        JSON.stringify({ kind: "actor.delete", actorId: "agent-3" }),
        JSON.stringify({ kind: "agent.upsert", agent: { ...sampleAgent(), id: "agent-3" } }),
      ].join("\n") + "\n",
      "utf8",
    );

    await journal.load();
    expect(journal.retiredActorIds().has("agent-1")).toBe(true);
    expect(journal.retiredActorIds().has("agent-2")).toBe(false);
    expect(journal.retiredActorIds().has("agent-3")).toBe(false);
    await journal.close();

    // Restart replays the compacted journal: the tombstone survives and the
    // later reviving upserts are still ordered after their deletes.
    const restarted = new FileBackedBrokerJournal(journalPath, {
      compactionPolicy: { minimumReclaimBytes: 1, minimumReclaimRatio: 0 },
    });
    await restarted.load();
    expect(restarted.retiredActorIds().has("agent-1")).toBe(true);
    expect(restarted.retiredActorIds().has("agent-2")).toBe(false);
    expect(restarted.retiredActorIds().has("agent-3")).toBe(false);
    await restarted.close();
  });

  test("replaying a compacted journal onto a lagging database still deletes", async () => {
    // Regression for the tombstone-drop bug: an existing SQLite database that
    // never applied the deletes must lose the rows on suffix replay.
    const root = mkdtempSync(join(tmpdir(), "openscout-journal-recovery-"));
    const journalPath = join(root, "journal.jsonl");
    const actor = sampleActor();
    const agent = sampleAgent();
    writeFileSync(
      journalPath,
      [
        JSON.stringify({ kind: "actor.upsert", actor }),
        JSON.stringify({ kind: "agent.upsert", agent }),
        JSON.stringify({ kind: "agent.endpoint.upsert", endpoint }),
        JSON.stringify({ kind: "agent.endpoint.delete", endpointId: endpoint.id }),
        JSON.stringify({ kind: "agent.delete", agentId: agent.id }),
        JSON.stringify({ kind: "actor.delete", actorId: actor.id }),
      ].join("\n") + "\n",
      "utf8",
    );

    // Compact first (minimumReclaimBytes: 1 forces it), then replay the
    // compacted journal onto a database that still has the rows.
    const compactedJournal = new FileBackedBrokerJournal(journalPath, {
      compactionPolicy: { minimumReclaimBytes: 1, minimumReclaimRatio: 0 },
    });
    await compactedJournal.load();
    const replayJournal = new FileBackedBrokerJournal(journalPath, {
      compactionPolicy: { minimumReclaimBytes: 1_000_000_000, minimumReclaimRatio: 1 },
    });
    await replayJournal.load();
    expect(replayJournal.snapshot().agents).toEqual({});
    expect(replayJournal.snapshot().endpoints).toEqual({});
    expect(replayJournal.snapshot().actors).toEqual({});
    await compactedJournal.close();
    await replayJournal.close();
  });

  test("a delete is superseded by a later re-upsert under the same dedupe key", async () => {
    const { journal, journalPath } = createJournal({
      compactionPolicy: { minimumReclaimBytes: 1, minimumReclaimRatio: 0 },
    });
    writeFileSync(
      journalPath,
      [
        JSON.stringify({ kind: "actor.delete", actorId: "agent-1" }),
        JSON.stringify({ kind: "actor.upsert", actor: sampleActor() }),
        JSON.stringify({ kind: "agent.endpoint.delete", endpointId: endpoint.id }),
        JSON.stringify({ kind: "agent.endpoint.upsert", endpoint }),
      ].join("\n") + "\n",
      "utf8",
    );

    await journal.load();

    const compacted = await journal.readEntries();
    expect(compacted.map((entry) => entry.kind)).toEqual([
      "actor.upsert",
      "agent.endpoint.upsert",
    ]);
    expect(journal.snapshot().actors["agent-1"]?.displayName).toBe("Agent One");
    expect(journal.snapshot().endpoints["ep-1"]).toEqual(endpoint);
  });
});

describe("orphaned compaction temps", () => {
  function deadPid(): number {
    for (let pid = 400_000; pid < 4_000_000; pid++) {
      try {
        process.kill(pid, 0);
      } catch {
        return pid;
      }
    }
    throw new Error("could not find a dead pid");
  }

  test("reaps temp files whose writer pid is dead and keeps the live ones", async () => {
    const { journal, journalPath } = createJournal();
    const dead = `${journalPath}.${deadPid()}.1700000000000.tmp`;
    const mine = `${journalPath}.${process.pid}.1700000000001.tmp`;
    const unrelated = join(journalPath, "..", "broker-journal.jsonl.other.tmp");
    writeFileSync(dead, "orphaned bytes");
    writeFileSync(mine, "in-flight bytes");
    writeFileSync(unrelated, "not a pid field");

    await journal.load();

    expect(existsSync(dead)).toBe(false);
    expect(existsSync(mine)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });
});

describe("history.rotate", () => {
  const OLD = 1_699_000_000_000;
  const CUTOFF = 1_700_000_000_000;
  const NEW = 1_700_500_000_000;

  const rotationFixture = (): string[] => {
    const conversation = {
      id: "conv-1",
      kind: "channel",
      title: "Ops",
      visibility: "workspace",
      shareMode: "shared",
      authorityNodeId: "node-1",
      participantIds: ["agent-1"],
      createdAt: OLD,
      updatedAt: OLD,
    };
    const delivery = (input: Record<string, unknown>) => ({
      targetId: "agent-1",
      targetKind: "agent",
      transport: "local_socket",
      reason: "direct_message",
      policy: "best_effort",
      ...input,
    });
    return [
      // Registry + conversation records are the retention sweep's domain —
      // rotation must never touch them.
      JSON.stringify({ kind: "actor.upsert", actor: sampleActor() }),
      JSON.stringify({ kind: "conversation.upsert", conversation }),
      JSON.stringify({ kind: "message.record", message: { ...sampleMessage(), id: "msg-old", createdAt: OLD } }),
      JSON.stringify({ kind: "message.record", message: { ...sampleMessage(), id: "msg-new", createdAt: NEW } }),
      // Completed flight + its invocation: both rotate out.
      JSON.stringify({ kind: "invocation.record", invocation: { ...sampleInvocation(), id: "inv-old", createdAt: OLD } }),
      JSON.stringify({ kind: "flight.record", flight: { ...sampleFlight(), id: "flt-old", invocationId: "inv-old", state: "completed", startedAt: OLD, completedAt: OLD + 1_000 } }),
      // An old invocation with a still-running flight: both survive.
      JSON.stringify({ kind: "invocation.record", invocation: { ...sampleInvocation(), id: "inv-run", createdAt: OLD } }),
      JSON.stringify({ kind: "flight.record", flight: { ...sampleFlight(), id: "flt-run", invocationId: "inv-run", state: "running", startedAt: OLD } }),
      // A flight completed after the cutoff survives regardless of linkage.
      JSON.stringify({ kind: "flight.record", flight: { ...sampleFlight(), id: "flt-new", invocationId: "inv-run", state: "completed", startedAt: NEW, completedAt: NEW + 1_000 } }),
      JSON.stringify({ kind: "deliveries.record", deliveries: [
        delivery({ id: "del-old", messageId: "msg-old", status: "completed" }),
        delivery({ id: "del-live", invocationId: "inv-run", status: "running" }),
        delivery({ id: "del-unlinked", status: "completed" }),
      ] }),
      JSON.stringify({ kind: "delivery.attempt.record", attempt: { id: "att-old", deliveryId: "del-old", attempt: 1, status: "sent", createdAt: OLD } }),
      JSON.stringify({ kind: "delivery.attempt.record", attempt: { id: "att-new", deliveryId: "del-live", attempt: 1, status: "sent", createdAt: NEW } }),
      JSON.stringify({ kind: "collaboration.event.record", event: { id: "ev-old", recordId: "rec-1", recordKind: "work_item", kind: "created", actorId: "agent-1", at: OLD } }),
      JSON.stringify({ kind: "collaboration.event.record", event: { id: "ev-new", recordId: "rec-1", recordKind: "work_item", kind: "updated", actorId: "agent-1", at: NEW } }),
      JSON.stringify({ kind: "history.rotate", cutoff: CUTOFF, rotatedAt: NEW + 2_000 }),
      // Written after the marker: a pre-cutoff record is post-rotation history
      // that stays live until the next rotation.
      JSON.stringify({ kind: "message.record", message: { ...sampleMessage(), id: "msg-late", createdAt: OLD } }),
    ];
  };

  const compactedPolicy = {
    // Force compaction on load so the rewrite runs even on a small journal.
    minimumReclaimBytes: 1,
    minimumReclaimRatio: 0,
    highWaterBytes: Number.MAX_SAFE_INTEGER,
    highWaterMinimumReclaimBytes: Number.MAX_SAFE_INTEGER,
  };

  test("applies the rotation to the hot snapshot and keeps live records", async () => {
    const { journal, journalPath } = createJournal();
    writeFileSync(journalPath, rotationFixture().join("\n") + "\n", "utf8");

    await journal.load();
    const snapshot = journal.snapshot();

    expect(snapshot.messages["msg-old"]).toBeUndefined();
    expect(snapshot.messages["msg-new"]).toBeDefined();
    expect(snapshot.messages["msg-late"]).toBeDefined();
    expect(snapshot.flights["flt-old"]).toBeUndefined();
    expect(snapshot.flights["flt-run"]).toBeDefined();
    expect(snapshot.flights["flt-new"]).toBeDefined();
    expect(snapshot.invocations["inv-old"]).toBeUndefined();
    // inv-run still awaits its running flight.
    expect(snapshot.invocations["inv-run"]).toBeDefined();
    expect(journal.getDelivery("del-old")).toBeUndefined();
    expect(journal.getDelivery("del-live")).toBeDefined();
    // No referent means no age evidence — kept.
    expect(journal.getDelivery("del-unlinked")).toBeDefined();
    expect(journal.listDeliveryAttempts("del-old")).toEqual([]);
    expect(journal.listDeliveryAttempts("del-live")).toHaveLength(1);
    expect(journal.listCollaborationEvents().map((event) => event.id)).toEqual(["ev-new"]);
    // Registry + conversation records untouched.
    expect(snapshot.actors["agent-1"]).toBeDefined();
    expect(snapshot.conversations["conv-1"]).toBeDefined();
    expect(journal.historyRotationCutoff()).toBe(CUTOFF);
  });

  test("compaction drops rotated record lines and keeps only the newest rotate marker", async () => {
    const { journal, journalPath } = createJournal({ compactionPolicy: compactedPolicy });
    writeFileSync(
      journalPath,
      [
        ...rotationFixture(),
        JSON.stringify({ kind: "history.rotate", cutoff: CUTOFF + 1_000, rotatedAt: NEW + 3_000 }),
      ].join("\n") + "\n",
      "utf8",
    );

    await journal.load();
    const entries = await journal.readEntries();
    const kinds = entries.map((entry) => entry.kind);

    expect(kinds.filter((kind) => kind === "history.rotate")).toEqual(["history.rotate"]);
    expect(entries.find((entry) => entry.kind === "history.rotate")).toMatchObject({ cutoff: CUTOFF + 1_000 });
    // Rotated record lines dropped; surviving history kept.
    expect(kinds).toContain("message.record");
    // msg-late predates the second marker but its OLD timestamp is doomed by
    // the newer cutoff — its line is dropped too.
    expect(entries.filter((entry) => entry.kind === "message.record").map((entry) => entry.message.id).sort())
      .toEqual(["msg-new"]);
    expect(entries.filter((entry) => entry.kind === "flight.record").map((entry) => entry.flight.id).sort())
      .toEqual(["flt-new", "flt-run"]);
    expect(entries.filter((entry) => entry.kind === "invocation.record").map((entry) => entry.invocation.id))
      .toEqual(["inv-run"]);
    expect(entries.filter((entry) => entry.kind === "delivery.attempt.record").map((entry) => entry.attempt.id))
      .toEqual(["att-new"]);
    expect(entries.filter((entry) => entry.kind === "collaboration.event.record").map((entry) => entry.event.id))
      .toEqual(["ev-new"]);
    // The partially doomed deliveries.record survives, filtered.
    const deliveries = entries.find((entry) => entry.kind === "deliveries.record");
    expect(deliveries?.kind === "deliveries.record" ? deliveries.deliveries.map((d) => d.id).sort() : [])
      .toEqual(["del-live", "del-unlinked"]);
    // The newest marker also rotated msg-late (OLD < CUTOFF + 1s).
    const snapshot = journal.snapshot();
    expect(Object.keys(snapshot.messages).sort()).toEqual(["msg-new"]);
    expect(Object.keys(snapshot.flights).sort()).toEqual(["flt-new", "flt-run"]);
    expect(Object.keys(snapshot.invocations)).toEqual(["inv-run"]);
    expect(journal.historyRotationCutoff()).toBe(CUTOFF + 1_000);
  });

  test("uncompacted replay converges to the same state as compacted replay", async () => {
    const { journalPath } = createJournal();
    writeFileSync(journalPath, rotationFixture().join("\n") + "\n", "utf8");

    const fresh = new FileBackedBrokerJournal(journalPath);
    await fresh.load();
    const freshSnapshot = fresh.snapshot();

    // Force a compacting reload by duplicating a dedupable line above the
    // reclaim floor.
    const compactionJournal = new FileBackedBrokerJournal(journalPath, { compactionPolicy: compactedPolicy });
    // A second instance on the same path replays the same bytes and compacts.
    await compactionJournal.load();
    const compactedSnapshot = compactionJournal.snapshot();

    expect(Object.keys(compactedSnapshot.messages).sort()).toEqual(Object.keys(freshSnapshot.messages).sort());
    expect(Object.keys(compactedSnapshot.flights).sort()).toEqual(Object.keys(freshSnapshot.flights).sort());
    expect(Object.keys(compactedSnapshot.invocations).sort()).toEqual(Object.keys(freshSnapshot.invocations).sort());
    expect(compactedSnapshot.actors).toEqual(freshSnapshot.actors);
    expect(compactedSnapshot.conversations).toEqual(freshSnapshot.conversations);
    expect(compactionJournal.listDeliveries()).toEqual(fresh.listDeliveries());
    expect(compactionJournal.listCollaborationEvents()).toEqual(fresh.listCollaborationEvents());
    expect(compactionJournal.listDeliveryAttempts("del-live")).toEqual(fresh.listDeliveryAttempts("del-live"));
  });

  test("a same-cutoff rotate marker is not appended twice", async () => {
    const { journal } = createJournal();
    await journal.load();

    const first = await journal.appendEntries([{ kind: "history.rotate", cutoff: CUTOFF, rotatedAt: NEW }]);
    expect(first).toHaveLength(1);
    expect(journal.historyRotationCutoff()).toBe(CUTOFF);

    const second = await journal.appendEntries([{ kind: "history.rotate", cutoff: CUTOFF, rotatedAt: NEW + 1_000 }]);
    expect(second).toEqual([]);
    expect((await journal.readEntries()).filter((entry) => entry.kind === "history.rotate")).toHaveLength(1);

    const newer = await journal.appendEntries([{ kind: "history.rotate", cutoff: CUTOFF + 5_000, rotatedAt: NEW + 2_000 }]);
    expect(newer).toHaveLength(1);
    expect(journal.historyRotationCutoff()).toBe(CUTOFF + 5_000);
  });
});

test("question history filters and cursor order match retained SQLite reads", async () => {
  const { journal } = createJournal();
  await journal.load();
  await journal.appendEntries({ kind: "conversation.upsert", conversation: { id: "thread", title: "Thread", shareMode: "shared", kind: "thread", parentConversationId: "room", authorityNodeId: "node", participantIds: [], visibility: "workspace", createdAt: 1 } });
  for (const [id, conversationId, createdAt, updatedAt] of [["a", "room", 1, 100], ["b", "thread", 1, 300], ["c", "room", 2, 200], ["hidden", "other", 1, 500]] as const) {
    await journal.appendEntries({ kind: "collaboration.record", record: { id, kind: "question", conversationId, createdAt, updatedAt,
      title: id, createdById: "operator", state: "closed", acceptanceState: "accepted", answer: `answer ${id}` } });
  }
  const query = { kind: "question" as const, state: "closed", conversationId: "room", includeThreads: true, orderByCreatedAt: true, limit: 2 };
  expect(journal.listCollaborationRecords(query).map(row => row.id)).toEqual(["a", "b"]);
  expect(journal.listCollaborationRecords({ ...query, afterCreatedAt: 1, afterId: "b" })).toMatchObject([{ id: "c", answer: "answer c" }]);
  expect(journal.listCollaborationRecords({ ...query, includeThreads: false }).map(row => row.id)).toEqual(["a", "c"]);
  expect(journal.listCollaborationRecords({ ...query, orderByCreatedAt: false }).map(row => row.id)).toEqual(["b", "c"]);
});

describe("journal append failures", () => {
  const retire = (actorId: string) => ({ kind: "actor.delete" as const, actorId });

  test("a failed append does not wedge the appends after it", async () => {
    const { journal, journalPath } = createJournal();
    await journal.load();
    await journal.appendEntries(retire("before"));

    chmodSync(journalPath, 0o444);
    await expect(journal.appendEntries(retire("during"))).rejects.toThrow();
    expect(journal.writeStatus()).toMatchObject({ state: "failing", failures: 1, code: "EACCES" });

    chmodSync(journalPath, 0o644);
    await journal.appendEntries(retire("after"));
    expect(journal.writeStatus()).toEqual({ state: "ok" });

    const reloaded = new FileBackedBrokerJournal(journalPath);
    await reloaded.load();
    expect([...reloaded.retiredActorIds()].sort()).toEqual(["after", "before"]);
  });

  test("failed rollback blocks queued writes until the original boundary is repaired", async () => {
    const { journal, journalPath } = createJournal();
    await journal.load();
    await journal.appendEntries(retire("before"));
    const before = readFileSync(journalPath, "utf8");
    const realAppendFile = fsPromises.appendFile;
    const append = spyOn(fsPromises, "appendFile").mockImplementationOnce(async (path, data) => {
      await realAppendFile(path, String(data).slice(0, 12), "utf8");
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });
    const rollback = spyOn(fsPromises, "truncate").mockRejectedValue(
      Object.assign(new Error("rollback unavailable"), { code: "EIO" }),
    );
    try {
      await expect(journal.appendEntries(retire("torn"))).rejects.toThrow("disk full");
      expect(journal.writeStatus()).toMatchObject({ state: "failing", code: "ENOSPC" });
      const blocked = [journal.appendEntries(retire("blocked-a")), journal.appendEntries(retire("blocked-b"))];
      expect((await Promise.allSettled(blocked)).map(result => result.status)).toEqual(["rejected", "rejected"]);
      expect(append).toHaveBeenCalledTimes(1);
      expect(journal.writeStatus()).toMatchObject({ state: "failing", failures: 3, code: "EIO" });
      expect([...journal.retiredActorIds()]).toEqual(["before"]);
    } finally {
      rollback.mockRestore();
      append.mockRestore();
    }
    await journal.appendEntries(retire("after"));
    expect(readFileSync(journalPath, "utf8")).toBe(before + JSON.stringify(retire("after")) + "\n");
    expect(journal.writeStatus()).toEqual({ state: "ok" });
    const reloaded = new FileBackedBrokerJournal(journalPath);
    expect((await reloaded.load()).invalidLines).toBe(0);
    expect([...reloaded.retiredActorIds()].sort()).toEqual(["after", "before"]);
  });

  test("canonical readers reject complete records from a failed partial batch until rollback succeeds", async () => {
    const { journal, journalPath } = createJournal();
    await journal.load();
    await journal.appendEntries(retire("before"));
    const realAppendFile = fsPromises.appendFile;
    const append = spyOn(fsPromises, "appendFile").mockImplementationOnce(async (path, data) => {
      await realAppendFile(path, String(data).split("\n")[0] + "\n", "utf8");
      throw new Error("disk full");
    });
    const rollback = spyOn(fsPromises, "truncate").mockRejectedValue(new Error("rollback failed"));
    try {
      await expect(journal.appendEntries([retire("unacknowledged"), retire("never-written")])).rejects.toThrow();
      await expect(journal.captureReplayBoundary()).rejects.toThrow("rollback failed");
      await expect(journal.readEntries()).rejects.toThrow("rollback failed");
      const visited: unknown[] = [];
      await expect(journal.replay(entry => { visited.push(entry); })).rejects.toThrow("rollback failed");
      expect(visited).toEqual([]);
    } finally { append.mockRestore(); rollback.mockRestore(); }
    expect(await journal.readEntries()).toEqual([retire("before")]);
    await journal.appendEntries(retire("after"));
    const reloaded = new FileBackedBrokerJournal(journalPath);
    await reloaded.load();
    expect([...reloaded.retiredActorIds()].sort()).toEqual(["after", "before"]);
  });

  test("deferred compaction repairs a failed append before moving the rollback boundary", async () => {
    const { journal, journalPath } = createJournal({ progressiveStartup: true,
      compactionPolicy: { minimumReclaimBytes: 1, minimumReclaimRatio: 0 } });
    const actor = sampleActor();
    writeFileSync(journalPath, Array.from({ length: 50 }, (_, i) => JSON.stringify({
      kind: "actor.upsert", actor: { ...actor, displayName: `old-${i}` },
    }) + "\n").join(""));
    expect((await journal.load()).compactionRequired).toBe(true);
    const realAppendFile = fsPromises.appendFile;
    const append = spyOn(fsPromises, "appendFile").mockImplementationOnce(async (path, data) => {
      await realAppendFile(path, String(data).slice(0, 12), "utf8");
      throw new Error("disk full");
    });
    const rollback = spyOn(fsPromises, "truncate").mockRejectedValueOnce(new Error("rollback failed"));
    try {
      await expect(journal.appendEntries(retire("torn"))).rejects.toThrow("disk full");
    } finally {
      append.mockRestore();
      rollback.mockRestore();
    }
    await journal.finishStartup();
    await journal.appendEntries(retire("after"));
    const reloaded = new FileBackedBrokerJournal(journalPath);
    expect((await reloaded.load()).invalidLines).toBe(0);
    expect([...reloaded.retiredActorIds()]).toEqual(["after"]);
    expect(reloaded.snapshot().actors[actor.id]?.displayName).toBe("old-49");
  });

  test.each([false, true])("appends safely after a previous process left an unterminated line (complete=%s)", async complete => {
    const { journalPath } = createJournal();
    const line = JSON.stringify(retire("before"));
    writeFileSync(journalPath, complete ? line : line.slice(0, 12));
    const journal = new FileBackedBrokerJournal(journalPath);
    await journal.load();
    await journal.appendEntries(retire("after"));
    const reloaded = new FileBackedBrokerJournal(journalPath);
    expect((await reloaded.load()).invalidLines).toBe(complete ? 0 : 1);
    expect([...reloaded.retiredActorIds()].sort()).toEqual(complete ? ["after", "before"] : ["after"]);
  });

  test("a torn append is rolled back so the next record is not fused onto it", async () => {
    const { journal, journalPath } = createJournal();
    await journal.load();
    await journal.appendEntries(retire("before"));

    const realAppendFile = fsPromises.appendFile;
    const spy = spyOn(fsPromises, "appendFile").mockImplementationOnce(async (path, data) => {
      await realAppendFile(path, String(data).slice(0, 12), "utf8");
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    });
    try {
      await expect(journal.appendEntries(retire("torn"))).rejects.toThrow("ENOSPC");
    } finally {
      spy.mockRestore();
    }
    expect(journal.writeStatus()).toMatchObject({ state: "failing", code: "ENOSPC" });

    await journal.appendEntries(retire("after"));
    const reloaded = new FileBackedBrokerJournal(journalPath);
    const report = await reloaded.load();
    expect(report.invalidLines).toBe(0);
    expect([...reloaded.retiredActorIds()].sort()).toEqual(["after", "before"]);
  });
});
