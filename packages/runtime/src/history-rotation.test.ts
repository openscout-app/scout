import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ConversationReadCursor,
  DeliveryAttempt,
  DeliveryIntent,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
} from "@openscout/protocol";

import {
  assertRotationPlanPartition,
  deliveryRotatedWithReferents,
  emptyHistoryRotationPlan,
  planHistoryRotation,
  refineVerifiedRotation,
  rotateHistoryInSnapshot,
} from "./history-rotation.ts";
import { createRuntimeRegistrySnapshot, type RuntimeRegistrySnapshot } from "./registry.ts";
import { FileBackedBrokerJournal } from "./broker-journal.ts";
import { BrokerMessageHistory } from "./broker-message-history.ts";
import { BrokerReadCursorStore } from "./broker-read-cursor-store.ts";
import { readMessageRecord } from "./broker-message-records.ts";
import type { BrokerInvocationDispatchJob } from "./broker-dispatch-job.ts";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
  roots.clear();
});

const OLD = 1_699_000_000_000;
const CUTOFF = 1_700_000_000_000;
const NEW = 1_700_500_000_000;

function message(id: string, createdAt = OLD): MessageRecord {
  return {
    id,
    conversationId: "conv-1",
    actorId: "operator",
    originNodeId: "node-1",
    class: "agent",
    body: "hello",
    visibility: "private",
    policy: "durable",
    createdAt,
  };
}

function invocation(id: string, input: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    id,
    requesterId: "operator",
    requesterNodeId: "node-1",
    targetAgentId: "agent-1",
    action: "execute",
    task: "Run work.",
    ensureAwake: true,
    stream: true,
    createdAt: OLD,
    ...input,
  };
}

function flight(id: string, invocationId: string, input: Partial<FlightRecord> = {}): FlightRecord {
  return {
    id,
    invocationId,
    requesterId: "operator",
    targetAgentId: "agent-1",
    state: "completed",
    startedAt: OLD,
    completedAt: OLD + 1_000,
    ...input,
  };
}

function delivery(id: string, input: Partial<DeliveryIntent> = {}): DeliveryIntent {
  return {
    id,
    targetId: "agent-1",
    targetKind: "agent",
    transport: "local_socket",
    reason: "direct_message",
    policy: "best_effort",
    status: "pending",
    ...input,
  } as DeliveryIntent;
}

function dispatchJob(invocationId: string, state: BrokerInvocationDispatchJob["state"]): BrokerInvocationDispatchJob {
  return {
    id: `dispatch-${invocationId}`,
    invocationId,
    flightId: "flt-1",
    targetAgentId: "agent-1",
    state,
    attempts: 0,
    createdAt: OLD,
    updatedAt: OLD,
  };
}

function snapshot(input: {
  messages?: MessageRecord[];
  invocations?: InvocationRequest[];
  flights?: FlightRecord[];
  readCursors?: ConversationReadCursor[];
}): RuntimeRegistrySnapshot {
  return createRuntimeRegistrySnapshot({
    messages: Object.fromEntries((input.messages ?? []).map((record) => [record.id, record])),
    invocations: Object.fromEntries((input.invocations ?? []).map((record) => [record.id, record])),
    flights: Object.fromEntries((input.flights ?? []).map((record) => [record.id, record])),
    readCursors: Object.fromEntries((input.readCursors ?? [])
      .map((cursor) => [`${cursor.conversationId}:${cursor.actorId}`, cursor])),
  });
}

describe("rotateHistoryInSnapshot dependency closure", () => {
  test("pending failure reports and anchors survive rotation, compaction and reopen until delivered", async () => {
    const root = mkdtempSync(join(tmpdir(), "terminal-report-rotation-")); roots.add(root);
    const path = join(root, "journal.jsonl");
    let journal = new FileBackedBrokerJournal(path); await journal.load();
    const reportFlight = flight("f", "i", { state: "failed", metadata: { terminalReport: {
      version: 1, status: "pending", message: { id: "report", replyToMessageId: "m" },
    } } });
    await journal.appendEntries([
      { kind: "message.record", message: message("m") }, { kind: "message.record", message: message("report") },
      { kind: "invocation.record", invocation: invocation("i", { messageId: "m" }) },
      { kind: "flight.record", flight: reportFlight },
    ]);
    const plan = planHistoryRotation(journal.snapshot(), CUTOFF);
    expect(plan.flightIds.size).toBe(0); expect(plan.invocationIds.size).toBe(0); expect(plan.messageIds.size).toBe(0);
    await journal.appendEntries({ kind: "message.record", message: message("unreferenced") });
    await journal.appendEntries({ kind: "history.rotate", cutoff: CUTOFF, rotatedAt: NEW });
    journal = new FileBackedBrokerJournal(path, { compactionPolicy: { minimumReclaimBytes: 1, minimumReclaimRatio: 0 } });
    await journal.load();
    expect((await journal.readEntries()).some(entry => entry.kind === "message.record" && entry.message.id === "unreferenced")).toBe(false);
    expect(journal.snapshot().flights.f).toEqual(reportFlight);
    expect([...journal.pendingTerminalReports()].map(f => f.id)).toEqual(["f"]);
    expect(await readMessageRecord(journal.snapshot().messages, "m")).toBeDefined();
    await journal.appendEntries({ kind: "flight.record", preserveCurrent: true, flight: { ...reportFlight,
      metadata: { terminalReport: { version: 1, status: "delivered" } } } });
    const deliveredPlan = planHistoryRotation(journal.snapshot(), CUTOFF);
    expect([...deliveredPlan.flightIds]).toEqual(["f"]);
    expect([...deliveredPlan.invocationIds]).toEqual(["i"]);
    expect([...deliveredPlan.messageIds]).toEqual(["m", "report"]);
  });
  test("an undelivered result protects terminal output and original context until its reply is durably posted", () => {
    const resultFlight = flight("f", "i", { metadata: { resultReply: {
      version: 1, status: "pending", message: { id: "reply", replyToMessageId: "m" },
    } } });
    const state = snapshot({
      messages: [message("m"), message("reply")],
      invocations: [invocation("i", { messageId: "m" })], flights: [resultFlight],
    });
    const protectedPlan = planHistoryRotation(state, CUTOFF);
    expect(protectedPlan.flightIds.size).toBe(0);
    expect(protectedPlan.invocationIds.size).toBe(0);
    expect(protectedPlan.messageIds.size).toBe(0);
    resultFlight.metadata!.resultReply = { version: 1, status: "delivered" };
    state.flights[resultFlight.id] = resultFlight;
    const moved = planHistoryRotation(state, CUTOFF);
    expect([...moved.flightIds]).toEqual(["f"]);
    expect([...moved.invocationIds]).toEqual(["i"]);
    expect([...moved.messageIds]).toEqual(["m", "reply"]);
  });
  test("a pending delivery protects its message and invocation referents", () => {
    const state = snapshot({
      messages: [message("m")],
      invocations: [invocation("i")],
      flights: [flight("f", "i")],
    });
    const pending = delivery("d", { invocationId: "i", messageId: "m", status: "pending" });

    const evicted = rotateHistoryInSnapshot(state, CUTOFF, { deliveries: [pending] });

    // The F2 repro: pending delivery → invocation + message survive even
    // though every record is older than the cutoff.
    expect(evicted.invocationIds.has("i")).toBe(false);
    expect(evicted.messageIds.has("m")).toBe(false);
    expect(state.invocations["i"]).toBeDefined();
    expect(state.messages["m"]).toBeDefined();
    // The terminal flight stays too: it is the evidence a later rotation
    // needs to retire the still-protected invocation.
    expect(evicted.flightIds.has("f")).toBe(false);
  });

  test("a pending invocation dispatch job protects its invocation", () => {
    const state = snapshot({
      invocations: [invocation("i")],
      flights: [flight("f", "i")],
    });

    const evicted = rotateHistoryInSnapshot(state, CUTOFF, {
      dispatchJobs: [dispatchJob("i", "pending")],
    });

    expect(evicted.invocationIds.has("i")).toBe(false);
    expect(state.invocations["i"]).toBeDefined();
  });

  test("a terminal dispatch job does not protect an otherwise evictable invocation", () => {
    const state = snapshot({
      invocations: [invocation("i")],
      flights: [flight("f", "i")],
    });

    const evicted = rotateHistoryInSnapshot(state, CUTOFF, {
      dispatchJobs: [dispatchJob("i", "completed")],
    });

    expect(evicted.invocationIds.has("i")).toBe(true);
    expect(state.invocations["i"]).toBeUndefined();
  });

  test("an old invocation with zero flights is kept — no flight is not terminal evidence", () => {
    const state = snapshot({
      invocations: [invocation("i")],
    });

    const evicted = rotateHistoryInSnapshot(state, CUTOFF);

    expect(evicted.invocationIds.size).toBe(0);
    expect(state.invocations["i"]).toBeDefined();
  });

  test("an old invocation with a non-terminal flight is kept and protects its message", () => {
    const state = snapshot({
      messages: [message("m")],
      invocations: [invocation("i", { messageId: "m" })],
      flights: [flight("f", "i", { state: "running", completedAt: undefined })],
    });

    const evicted = rotateHistoryInSnapshot(state, CUTOFF);

    expect(state.invocations["i"]).toBeDefined();
    expect(state.messages["m"]).toBeDefined();
    expect(evicted.messageIds.size).toBe(0);
  });

  test("an old invocation with only terminal flights is evicted and its message is unprotected", () => {
    const state = snapshot({
      messages: [message("m"), message("m-new", NEW)],
      invocations: [invocation("i", { messageId: "m" })],
      flights: [flight("f", "i")],
    });

    const evicted = rotateHistoryInSnapshot(state, CUTOFF);

    expect(evicted.invocationIds.has("i")).toBe(true);
    expect(evicted.flightIds.has("f")).toBe(true);
    expect(evicted.messageIds.has("m")).toBe(true);
    expect(state.messages["m-new"]).toBeDefined();
  });

  test("a terminal delivery whose referent is already absent is evictable", () => {
    const state = snapshot({
      messages: [message("m-keep", NEW)],
    });
    const evicted = rotateHistoryInSnapshot(state, CUTOFF);
    const orphan = delivery("d", { messageId: "m-gone", status: "completed" });

    // Referent missing ⇒ nothing left to protect.
    expect(deliveryRotatedWithReferents(orphan, evicted, state)).toBe(true);
  });

  // Regression: PR #986 second pass — a read cursor outlives rotation but
  // still anchors on its last-read message; the anchor must not be evicted.
  test("a read cursor's lastReadMessageId anchor survives rotation", () => {
    const state = snapshot({
      messages: [message("m")],
      readCursors: [{
        conversationId: "conv-1",
        actorId: "operator",
        lastReadMessageId: "m",
        lastReadAt: OLD,
        updatedAt: OLD,
      }],
    });

    const evicted = rotateHistoryInSnapshot(state, CUTOFF);

    expect(evicted.messageIds.has("m")).toBe(false);
    expect(state.messages["m"]).toBeDefined();
  });

  // Regression: a terminal flight removed while its invocation is protected
  // leaves the invocation flightless — and flightless means never evictable.
  // The flight must survive with the invocation and leave when it does.
  test("a terminal flight is kept while its invocation is protected, then evicted with it", () => {
    const state = snapshot({
      messages: [message("m")],
      invocations: [invocation("i", { messageId: "m" })],
      flights: [flight("f", "i")],
    });

    // Rotation 1: the pending delivery protects the invocation, so its
    // terminal flight stays as evidence.
    const pending = delivery("d", { invocationId: "i", messageId: "m", status: "pending" });
    const first = rotateHistoryInSnapshot(state, CUTOFF, { deliveries: [pending] });
    expect(first.flightIds.has("f")).toBe(false);
    expect(first.invocationIds.has("i")).toBe(false);
    expect(state.flights["f"]).toBeDefined();
    expect(state.invocations["i"]).toBeDefined();

    // Rotation 2: the delivery completed between markers — nothing is
    // protected now, so message + invocation + flight retire together.
    const second = rotateHistoryInSnapshot(state, CUTOFF + 1_000, {
      deliveries: [{ ...pending, status: "completed" }],
    });
    expect(second.invocationIds.has("i")).toBe(true);
    expect(second.flightIds.has("f")).toBe(true);
    expect(second.messageIds.has("m")).toBe(true);
    expect(state.invocations["i"]).toBeUndefined();
    expect(state.flights["f"]).toBeUndefined();
    expect(state.messages["m"]).toBeUndefined();
  });

  test("a terminal flight whose invocation is already absent is evictable", () => {
    const state = snapshot({
      flights: [flight("f-orphan", "i-gone")],
    });

    const evicted = rotateHistoryInSnapshot(state, CUTOFF);

    expect(evicted.flightIds.has("f-orphan")).toBe(true);
    expect(state.flights["f-orphan"]).toBeUndefined();
  });

  test("a terminal delivery with a surviving referent is kept, an unlinked one is kept", () => {
    const state = snapshot({
      messages: [message("m-keep", NEW)],
    });
    const evicted = rotateHistoryInSnapshot(state, CUTOFF);

    expect(deliveryRotatedWithReferents(
      delivery("d1", { messageId: "m-keep", status: "completed" }), evicted, state,
    )).toBe(false);
    expect(deliveryRotatedWithReferents(
      delivery("d2", { status: "completed" }), evicted, state,
    )).toBe(false);
    expect(deliveryRotatedWithReferents(
      delivery("d3", { messageId: "m-keep", status: "pending" }), evicted, state,
    )).toBe(false);
  });
});

describe("history.rotate journal dependency closure", () => {
  const compactedPolicy = {
    minimumReclaimBytes: 1,
    minimumReclaimRatio: 0,
    highWaterBytes: Number.MAX_SAFE_INTEGER,
    highWaterMinimumReclaimBytes: Number.MAX_SAFE_INTEGER,
  };

  function createJournalDir(): { dir: string; journalPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "openscout-rotation-"));
    roots.add(dir);
    return { dir, journalPath: join(dir, "journal.jsonl") };
  }

  test("runtime apply and compacted replay converge under the dependency closure", async () => {
    const { journalPath } = createJournalDir();
    const pending = delivery("d", { invocationId: "i", messageId: "m", status: "pending" });
    const entries = [
      JSON.stringify({ kind: "message.record", message: message("m") }),
      JSON.stringify({ kind: "invocation.record", invocation: invocation("i", { messageId: "m" }) }),
      JSON.stringify({ kind: "flight.record", flight: flight("f", "i") }),
      JSON.stringify({ kind: "deliveries.record", deliveries: [pending] }),
      JSON.stringify({ kind: "history.rotate", cutoff: CUTOFF, rotatedAt: NEW }),
    ];
    writeFileSync(journalPath, entries.join("\n") + "\n", "utf8");

    const journal = new FileBackedBrokerJournal(journalPath, { compactionPolicy: compactedPolicy });
    await journal.load();
    const snap = journal.snapshot();

    // The pending delivery's closure survives rotation AND compaction.
    expect(snap.messages["m"]).toBeDefined();
    expect(snap.invocations["i"]).toBeDefined();
    expect(journal.getDelivery("d")?.status).toBe("pending");

    const kinds = (await journal.readEntries()).map((entry) => entry.kind);
    expect(kinds).toContain("message.record");
    expect(kinds).toContain("invocation.record");
  });

  test("multiple rotations preserve the dependency closure", async () => {
    const { journalPath } = createJournalDir();
    const job = dispatchJob("i2", "pending");
    const entries = [
      JSON.stringify({ kind: "message.record", message: message("m1") }),
      JSON.stringify({ kind: "invocation.record", invocation: invocation("i1") }),
      JSON.stringify({ kind: "flight.record", flight: flight("f1", "i1") }),
      JSON.stringify({ kind: "message.record", message: message("m2") }),
      JSON.stringify({ kind: "invocation.record", invocation: invocation("i2", { messageId: "m2" }) }),
      JSON.stringify({ kind: "invocation.dispatch_job.record", job }),
      JSON.stringify({ kind: "history.rotate", cutoff: CUTOFF, rotatedAt: NEW }),
      // Second rotation evicts i1 but i2 stays: its dispatch job is pending
      // and that keeps m2 alive through the invocation reference.
      JSON.stringify({ kind: "history.rotate", cutoff: CUTOFF + 1_000, rotatedAt: NEW + 1_000 }),
    ];
    writeFileSync(journalPath, entries.join("\n") + "\n", "utf8");

    const journal = new FileBackedBrokerJournal(journalPath, { compactionPolicy: compactedPolicy });
    await journal.load();
    const snap = journal.snapshot();

    expect(snap.invocations["i1"]).toBeUndefined();
    expect(snap.messages["m1"]).toBeUndefined();
    expect(snap.invocations["i2"]).toBeDefined();
    expect(snap.messages["m2"]).toBeDefined();
    expect(journal.getInvocationDispatchJob("dispatch-i2")?.state).toBe("pending");
  });

  test("a terminal delivery whose referent was already absent is dropped by compaction", async () => {
    const { journalPath } = createJournalDir();
    const orphan = delivery("d-orphan", { messageId: "m-never", status: "completed" });
    const entries = [
      JSON.stringify({ kind: "deliveries.record", deliveries: [orphan] }),
      JSON.stringify({ kind: "history.rotate", cutoff: CUTOFF, rotatedAt: NEW }),
    ];
    writeFileSync(journalPath, entries.join("\n") + "\n", "utf8");

    const journal = new FileBackedBrokerJournal(journalPath, { compactionPolicy: compactedPolicy });
    await journal.load();

    expect(journal.getDelivery("d-orphan")).toBeUndefined();
    expect((await journal.readEntries()).map((entry) => entry.kind)).not.toContain("deliveries.record");
  });

  // Regression port: PR #986 second pass — a protected invocation lost its
  // terminal flight at the first marker and could never become evictable
  // again. The second marker must retire the whole closure together.
  test("a protected invocation's terminal flight survives the first rotation and leaves with it on the second", async () => {
    const { journalPath } = createJournalDir();
    const pending = delivery("d", { invocationId: "i", messageId: "m", status: "pending" });
    const entries = [
      JSON.stringify({ kind: "message.record", message: message("m") }),
      JSON.stringify({ kind: "invocation.record", invocation: invocation("i", { messageId: "m" }) }),
      JSON.stringify({ kind: "flight.record", flight: flight("f", "i") }),
      JSON.stringify({ kind: "deliveries.record", deliveries: [pending] }),
      JSON.stringify({ kind: "history.rotate", cutoff: CUTOFF, rotatedAt: NEW }),
    ];
    writeFileSync(journalPath, entries.join("\n") + "\n", "utf8");

    const journal = new FileBackedBrokerJournal(journalPath, { compactionPolicy: compactedPolicy });
    await journal.load();

    // Marker 1: pending delivery protects the invocation; the flight stays
    // as the evidence that lets a later rotation retire it.
    expect(journal.snapshot().invocations["i"]).toBeDefined();
    expect(journal.snapshot().flights["f"]).toBeDefined();
    expect(journal.snapshot().messages["m"]).toBeDefined();

    // Delivery completes between markers; marker 2 retires the closure.
    await journal.appendEntries([
      { kind: "deliveries.record", deliveries: [{ ...pending, status: "completed" }] },
      { kind: "history.rotate", cutoff: CUTOFF + 1_000, rotatedAt: NEW + 1_000 },
    ]);

    const snap = journal.snapshot();
    expect(snap.invocations["i"]).toBeUndefined();
    expect(snap.flights["f"]).toBeUndefined();
    expect(snap.messages["m"]).toBeUndefined();
    // The completed delivery's referents were evicted this rotation, so the
    // delivery itself is evictable too — nothing is retained forever.
    expect(journal.getDelivery("d")).toBeUndefined();
  });

  // Third-pass design: a modern marker carries the ids the writer verified
  // in SQLite. Apply removes EXACTLY those ids and compaction dooms EXACTLY
  // those lines — eligibility is never recomputed, so records the verifier
  // reported missing stay hot even when the rules would evict them.
  test("a marker's evicted sets apply and compact exactly — unlisted records survive", async () => {
    const { journalPath } = createJournalDir();
    const entries = [
      JSON.stringify({ kind: "message.record", message: message("m-evict") }),
      // m-keep is old too — the rules WOULD doom it — but the writer did
      // not verify it, so the marker does not name it.
      JSON.stringify({ kind: "message.record", message: message("m-keep") }),
      JSON.stringify({ kind: "invocation.record", invocation: invocation("i", { messageId: "m-keep" }) }),
      JSON.stringify({
        kind: "history.rotate",
        cutoff: CUTOFF,
        rotatedAt: NEW,
        evicted: {
          messageIds: ["m-evict"],
          invocationIds: [],
          flightIds: [],
          deliveryIds: [],
          collaborationEventIds: [],
        },
      }),
    ];
    writeFileSync(journalPath, entries.join("\n") + "\n", "utf8");

    const journal = new FileBackedBrokerJournal(journalPath, { compactionPolicy: compactedPolicy });
    await journal.load();
    const snap = journal.snapshot();

    expect(snap.messages["m-evict"]).toBeUndefined();
    expect(snap.messages["m-keep"]).toBeDefined();
    expect(snap.invocations["i"]).toBeDefined();

    const lines = (await journal.readEntries()).map((entry) => entry.kind);
    expect(lines).toContain("message.record");
    expect((await journal.readEntries())
      .filter((entry) => entry.kind === "message.record")
      .map((entry) => entry.message.id)).toEqual(["m-keep"]);
  });

  test("a marker evicts exactly its listed ids even where the rules would not", async () => {
    const { journalPath } = createJournalDir();
    const entries = [
      // Newer than the cutoff — the rules would keep it, but the marker
      // names it, and apply honors the marker exactly.
      JSON.stringify({ kind: "message.record", message: message("m-new", NEW) }),
      JSON.stringify({
        kind: "history.rotate",
        cutoff: CUTOFF,
        rotatedAt: NEW,
        evicted: {
          messageIds: ["m-new"],
          invocationIds: [],
          flightIds: [],
          deliveryIds: [],
          collaborationEventIds: [],
        },
      }),
    ];
    writeFileSync(journalPath, entries.join("\n") + "\n", "utf8");

    const journal = new FileBackedBrokerJournal(journalPath, { compactionPolicy: compactedPolicy });
    await journal.load();
    expect(journal.snapshot().messages["m-new"]).toBeUndefined();
    expect((await journal.readEntries()).map((entry) => entry.kind))
      .not.toContain("message.record");
  });

  test("a marker without evicted sets falls back to the closure rules", async () => {
    const { journalPath } = createJournalDir();
    const entries = [
      JSON.stringify({ kind: "message.record", message: message("m") }),
      JSON.stringify({ kind: "history.rotate", cutoff: CUTOFF, rotatedAt: NEW }),
    ];
    writeFileSync(journalPath, entries.join("\n") + "\n", "utf8");

    const journal = new FileBackedBrokerJournal(journalPath, { compactionPolicy: compactedPolicy });
    await journal.load();
    // Legacy markers recompute the plan — the message is old and
    // unprotected, so it is evicted as before.
    expect(journal.snapshot().messages["m"]).toBeUndefined();
    expect((await journal.readEntries()).map((entry) => entry.kind))
      .not.toContain("message.record");
  });

  test("a marker's delivery and collaboration-event sets doom exactly those lines", async () => {
    const { journalPath } = createJournalDir();
    const doomed = delivery("d-doom", { messageId: "m-gone", status: "completed" });
    const kept = delivery("d-keep", { status: "completed" });
    const entries = [
      JSON.stringify({ kind: "deliveries.record", deliveries: [doomed, kept] }),
      JSON.stringify({
        kind: "collaboration.event.record",
        event: { id: "ce-doom", recordId: "r", recordKind: "agent", kind: "agent.updated", actorId: "a", at: OLD },
      }),
      JSON.stringify({
        kind: "collaboration.event.record",
        event: { id: "ce-keep", recordId: "r", recordKind: "agent", kind: "agent.updated", actorId: "a", at: OLD },
      }),
      JSON.stringify({
        kind: "history.rotate",
        cutoff: CUTOFF,
        rotatedAt: NEW,
        evicted: {
          messageIds: [],
          invocationIds: [],
          flightIds: [],
          deliveryIds: ["d-doom"],
          collaborationEventIds: ["ce-doom"],
        },
      }),
    ];
    writeFileSync(journalPath, entries.join("\n") + "\n", "utf8");

    const journal = new FileBackedBrokerJournal(journalPath, { compactionPolicy: compactedPolicy });
    await journal.load();

    expect(journal.getDelivery("d-doom")).toBeUndefined();
    expect(journal.getDelivery("d-keep")).toBeDefined();
    // The mixed deliveries.record line survives filtered — and the
    // collaboration events doom only by id, not by `at < cutoff`.
    const entries2 = await journal.readEntries();
    const deliveryLines = entries2.filter((entry) => entry.kind === "deliveries.record");
    expect(deliveryLines.flatMap((entry) => entry.deliveries.map((d) => d.id)))
      .toEqual(["d-keep"]);
    expect(entries2.filter((entry) => entry.kind === "collaboration.event.record")
      .map((entry) => entry.event.id)).toEqual(["ce-keep"]);
  });

  // Regression port: PR #986 second pass — the cursor anchor message was
  // evicted and BrokerReadCursorStore.resolve reported "message m not found".
  test("a cursor anchor message survives rotation and the cursor store still resolves it", async () => {
    const { journalPath } = createJournalDir();
    const cursor: ConversationReadCursor = {
      conversationId: "conv-1",
      actorId: "operator",
      lastReadMessageId: "m",
      lastReadAt: OLD,
      updatedAt: OLD,
    };
    const entries = [
      JSON.stringify({ kind: "message.record", message: message("m") }),
      JSON.stringify({ kind: "conversation.read_cursor.upsert", cursor }),
      JSON.stringify({ kind: "history.rotate", cutoff: CUTOFF, rotatedAt: NEW }),
    ];
    writeFileSync(journalPath, entries.join("\n") + "\n", "utf8");

    const journal = new FileBackedBrokerJournal(journalPath, { compactionPolicy: compactedPolicy });
    await journal.load();
    const snap = journal.snapshot();

    // The anchor message and the cursor itself both survive.
    expect(snap.messages["m"]).toBeDefined();
    expect(Object.values(snap.readCursors)[0]?.lastReadMessageId).toBe("m");

    const cursorStore = new BrokerReadCursorStore({
      runtime: {
        snapshot: () => snap,
        message: (id: string) => snap.messages[id],
        conversation: () => ({ id: "conv-1" }),
        readCursor: () => Object.values(snap.readCursors)[0],
      },
      ensureActor: async () => {},
      projection: { latestThreadSeq: async () => 1 },
      operatorActorId: "operator",
      nodeId: "node-1",
    } as never);
    const resolved = await cursorStore.resolve("conv-1", { lastReadMessageId: "m" });
    expect(resolved.lastReadMessageId).toBe("m");
  });
});

describe("history.rotate under disk-backed message history", () => {
  test("rotate plus compaction keeps the message readable — message eviction is not implemented there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openscout-disk-history-"));
    roots.add(dir);
    const journalPath = join(dir, "journal.jsonl");
    const compactedPolicy = {
      minimumReclaimBytes: 1,
      minimumReclaimRatio: 0,
      highWaterBytes: Number.MAX_SAFE_INTEGER,
      highWaterMinimumReclaimBytes: Number.MAX_SAFE_INTEGER,
    };
    const entries = [
      JSON.stringify({ kind: "message.record", message: message("m") }),
      JSON.stringify({ kind: "invocation.record", invocation: invocation("i") }),
      JSON.stringify({ kind: "deliveries.record", deliveries: [delivery("d", { invocationId: "i", messageId: "m", status: "pending" })] }),
      JSON.stringify({ kind: "history.rotate", cutoff: CUTOFF, rotatedAt: NEW }),
    ];
    writeFileSync(journalPath, entries.join("\n") + "\n", "utf8");

    const history = await BrokerMessageHistory.create(journalPath);
    try {
      const journal = new FileBackedBrokerJournal(journalPath, {
        messageHistory: history,
        compactionPolicy: compactedPolicy,
      });
      await journal.load();

      // The marker cannot evict from the async store, and compaction must
      // not drop the line: the message stays readable either way.
      const record = await readMessageRecord(journal.snapshot().messages, "m");
      expect(record?.body).toBe("hello");
      expect((await journal.readEntries()).map((entry) => entry.kind)).toContain("message.record");
    } finally {
      await history.close();
    }
  });
});

function attempt(id: string, deliveryId: string, input: Partial<DeliveryAttempt> = {}): DeliveryAttempt {
  return {
    id,
    deliveryId,
    attempt: 1,
    status: "failed",
    createdAt: OLD,
    ...input,
  };
}

describe("planHistoryRotation delivery attempts", () => {
  // Fourth-pass finding 2: attempts are part of the plan — evictable only
  // when their delivery leaves in the same rotation or is already absent,
  // never by age alone.
  test("an attempt is planned only when its delivery is evictable in the same rotation or absent", () => {
    const state = snapshot({ messages: [message("m")] });
    const doomed = delivery("d", { messageId: "m", status: "completed" });
    // Pending on a different referent — pending work must not protect m.
    const surviving = delivery("d-keep", { messageId: "m-other", status: "pending" });

    const plan = planHistoryRotation(state, CUTOFF, {
      deliveries: [doomed, surviving],
      deliveryAttempts: [
        attempt("a-doomed", "d"),
        attempt("a-surviving", "d-keep"),
        attempt("a-absent", "d-never-journaled"),
      ],
    });

    // d is terminal and its only referent leaves → doomed, and its attempt
    // follows. The absent-delivery attempt is planned too. The pending
    // delivery's attempt is NOT a candidate — its delivery stays live.
    expect(plan.deliveryIds.has("d")).toBe(true);
    expect(plan.deliveryAttemptIds.has("a-doomed")).toBe(true);
    expect(plan.deliveryAttemptIds.has("a-absent")).toBe(true);
    expect(plan.deliveryAttemptIds.has("a-surviving")).toBe(false);
  });

  test("an old attempt on a retained delivery is never a candidate", () => {
    const state = snapshot({ messages: [message("m")] });
    const pending = delivery("d", { messageId: "m", status: "pending" });

    const plan = planHistoryRotation(state, CUTOFF, {
      deliveries: [pending],
      deliveryAttempts: [attempt("a1", "d")],
    });

    expect(plan.deliveryIds.size).toBe(0);
    expect(plan.deliveryAttemptIds.size).toBe(0);
  });
});

describe("refineVerifiedRotation", () => {
  const planWith = (input: Partial<Record<
    "messageIds" | "invocationIds" | "flightIds" | "deliveryIds" | "deliveryAttemptIds" | "collaborationEventIds",
    string[]
  >>) => {
    const plan = emptyHistoryRotationPlan();
    for (const [key, ids] of Object.entries(input)) {
      for (const id of ids ?? []) {
        plan[key as keyof typeof plan].add(id);
      }
    }
    return plan;
  };

  // Fourth-pass finding 4: an unverified message is retained — and every
  // candidate connected to it is demoted to retained even though SQLite
  // verified them. Eviction is all-or-nothing per connected component.
  test("an unverified message retains its verified invocation and terminal flight", () => {
    const present = planWith({ invocationIds: ["i"], flightIds: ["f"] });
    const missing = planWith({ messageIds: ["m"] });

    const { evictable, retained } = refineVerifiedRotation(present, missing, {
      invocation: (id) => invocation(id, { messageId: "m" }),
      flight: (id) => flight(id, "i"),
    });

    expect(evictable.messageIds.size + evictable.invocationIds.size + evictable.flightIds.size).toBe(0);
    expect(retained.messageIds.has("m")).toBe(true);
    expect(retained.invocationIds.has("i")).toBe(true);
    expect(retained.flightIds.has("f")).toBe(true);
  });

  test("a retained invocation retains its message, flights, deliveries, and attempts", () => {
    const present = planWith({
      messageIds: ["m"],
      flightIds: ["f"],
      deliveryIds: ["d"],
      deliveryAttemptIds: ["a1"],
    });
    const missing = planWith({ invocationIds: ["i"] });

    const { evictable, retained } = refineVerifiedRotation(present, missing, {
      invocation: (id) => invocation(id, { messageId: "m" }),
      flight: (id) => flight(id, "i"),
      delivery: (id) => delivery(id, { invocationId: "i", messageId: "m", status: "completed" }),
      deliveryAttempt: (id) => attempt(id, "d"),
    });

    expect(evictable.messageIds.size).toBe(0);
    expect(evictable.flightIds.size).toBe(0);
    expect(evictable.deliveryIds.size).toBe(0);
    expect(evictable.deliveryAttemptIds.size).toBe(0);
    expect(retained.invocationIds.has("i")).toBe(true);
    expect(retained.messageIds.has("m")).toBe(true);
    expect(retained.flightIds.has("f")).toBe(true);
    expect(retained.deliveryIds.has("d")).toBe(true);
    expect(retained.deliveryAttemptIds.has("a1")).toBe(true);
  });

  test("a retained message retains the deliveries and attempts referencing it", () => {
    const present = planWith({ deliveryIds: ["d"], deliveryAttemptIds: ["a1"] });
    const missing = planWith({ messageIds: ["m"] });

    const { evictable, retained } = refineVerifiedRotation(present, missing, {
      delivery: (id) => delivery(id, { messageId: "m", status: "completed" }),
      deliveryAttempt: (id) => attempt(id, "d"),
    });

    expect(evictable.deliveryIds.size).toBe(0);
    expect(evictable.deliveryAttemptIds.size).toBe(0);
    expect(retained.deliveryIds.has("d")).toBe(true);
    expect(retained.deliveryAttemptIds.has("a1")).toBe(true);
  });

  test("a retained delivery controls its attempts — and an unconnected component still evicts", () => {
    const present = planWith({
      deliveryAttemptIds: ["a1"],
      messageIds: ["m-other"],
    });
    const missing = planWith({ deliveryIds: ["d"] });

    const { evictable, retained } = refineVerifiedRotation(present, missing, {
      delivery: (id) => delivery(id, { messageId: "m", status: "completed" }),
      deliveryAttempt: (id) => attempt(id, "d"),
    });

    expect(retained.deliveryAttemptIds.has("a1")).toBe(true);
    // An unrelated candidate with no edge to the retained component still
    // evicts — retention is per connected component, not global.
    expect(evictable.messageIds.has("m-other")).toBe(true);
  });

  test("an unverified attempt retains its delivery and the delivery's message", () => {
    const present = planWith({ deliveryIds: ["d"], messageIds: ["m"] });
    const missing = planWith({ deliveryAttemptIds: ["a1"] });

    const { evictable, retained } = refineVerifiedRotation(present, missing, {
      delivery: (id) => delivery(id, { messageId: "m", status: "completed" }),
      deliveryAttempt: (id) => attempt(id, "d"),
    });

    expect(retained.deliveryAttemptIds.has("a1")).toBe(true);
    expect(retained.deliveryIds.has("d")).toBe(true);
    expect(retained.messageIds.has("m")).toBe(true);
    expect(evictable.deliveryIds.size + evictable.messageIds.size).toBe(0);
  });

  test("an id shared across categories does not collapse the closure", () => {
    // Message "x" retained, invocation "x" evictable and unrelated: same
    // string id, different categories — no edge may connect them.
    const present = planWith({ invocationIds: ["x"] });
    const missing = planWith({ messageIds: ["x"] });

    const { evictable, retained } = refineVerifiedRotation(present, missing, {
      invocation: () => invocation("x"),
    });

    expect(retained.messageIds.has("x")).toBe(true);
    expect(evictable.invocationIds.has("x")).toBe(true);
  });
});

describe("assertRotationPlanPartition", () => {
  const planWith = (input: Partial<Record<
    "messageIds" | "invocationIds" | "flightIds" | "deliveryIds" | "deliveryAttemptIds" | "collaborationEventIds",
    string[]
  >>) => {
    const plan = emptyHistoryRotationPlan();
    for (const [key, ids] of Object.entries(input)) {
      for (const id of ids ?? []) {
        plan[key as keyof typeof plan].add(id);
      }
    }
    return plan;
  };

  test("accepts a clean partition and throws on overlap, unplanned, or unanswered ids", () => {
    const plan = planWith({ messageIds: ["m"], invocationIds: ["i"], deliveryAttemptIds: ["a1"] });
    const present = planWith({ messageIds: ["m"] });
    const missing = planWith({ invocationIds: ["i"], deliveryAttemptIds: ["a1"] });
    expect(() => assertRotationPlanPartition(plan, present, missing)).not.toThrow();

    // present ∩ missing ≠ ∅
    const overlap = planWith({ invocationIds: ["i"], deliveryAttemptIds: ["a1"] });
    overlap.messageIds.add("m");
    expect(() => assertRotationPlanPartition(plan, present, overlap))
      .toThrow("both present and missing");

    // An id the plan never named.
    const extra = planWith({ invocationIds: ["i"], deliveryAttemptIds: ["a1"] });
    extra.flightIds.add("f-never-planned");
    expect(() => assertRotationPlanPartition(plan, present, extra))
      .toThrow("unplanned");

    // A planned id in neither set.
    const incomplete = planWith({ invocationIds: ["i"] });
    expect(() => assertRotationPlanPartition(plan, present, incomplete))
      .toThrow("unanswered");
  });
});

describe("history.rotate delivery attempts", () => {
  const compactedPolicy = {
    minimumReclaimBytes: 1,
    minimumReclaimRatio: 0,
    highWaterBytes: Number.MAX_SAFE_INTEGER,
    highWaterMinimumReclaimBytes: Number.MAX_SAFE_INTEGER,
  };

  function createJournalDir(): { dir: string; journalPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "openscout-rotation-"));
    roots.add(dir);
    return { dir, journalPath: join(dir, "journal.jsonl") };
  }

  // Fourth-pass finding 2, the probe's exact case: an old unprojected
  // attempt under a pending delivery — the empty marker must evict
  // nothing, and compaction must keep the attempt line.
  test("an empty marker evicts nothing — an old unprojected attempt survives apply and compaction", async () => {
    const { journalPath } = createJournalDir();
    const entries = [
      JSON.stringify({ kind: "message.record", message: message("m") }),
      JSON.stringify({
        kind: "deliveries.record",
        deliveries: [delivery("d", { messageId: "m", status: "pending" })],
      }),
      JSON.stringify({ kind: "delivery.attempt.record", attempt: attempt("a1", "d") }),
      JSON.stringify({
        kind: "history.rotate",
        cutoff: CUTOFF,
        rotatedAt: NEW,
        evicted: {
          messageIds: [],
          invocationIds: [],
          flightIds: [],
          deliveryIds: [],
          deliveryAttemptIds: [],
          collaborationEventIds: [],
        },
      }),
    ];
    writeFileSync(journalPath, entries.join("\n") + "\n", "utf8");

    const journal = new FileBackedBrokerJournal(journalPath, { compactionPolicy: compactedPolicy });
    await journal.load();

    expect(journal.listDeliveryAttempts("d").map((a) => a.id)).toEqual(["a1"]);
    expect(journal.getDelivery("d")).toBeDefined();
    expect(journal.snapshot().messages["m"]).toBeDefined();
    expect((await journal.readEntries()).map((entry) => entry.kind))
      .toContain("delivery.attempt.record");
  });

  // Backward compatibility: a marker written before attempt verification
  // carries no deliveryAttemptIds — absent means no attempts doomed.
  test("a marker without deliveryAttemptIds dooms no attempts", async () => {
    const { journalPath } = createJournalDir();
    const entries = [
      JSON.stringify({ kind: "message.record", message: message("m") }),
      JSON.stringify({
        kind: "deliveries.record",
        deliveries: [delivery("d", { messageId: "m", status: "completed" })],
      }),
      JSON.stringify({ kind: "delivery.attempt.record", attempt: attempt("a1", "d") }),
      JSON.stringify({
        kind: "history.rotate",
        cutoff: CUTOFF,
        rotatedAt: NEW,
        evicted: {
          messageIds: ["m"],
          invocationIds: [],
          flightIds: [],
          deliveryIds: ["d"],
          collaborationEventIds: [],
        },
      }),
    ];
    writeFileSync(journalPath, entries.join("\n") + "\n", "utf8");

    const journal = new FileBackedBrokerJournal(journalPath, { compactionPolicy: compactedPolicy });
    await journal.load();

    expect(journal.getDelivery("d")).toBeUndefined();
    expect(journal.listDeliveryAttempts("d").map((a) => a.id)).toEqual(["a1"]);
    expect((await journal.readEntries()).map((entry) => entry.kind))
      .toContain("delivery.attempt.record");
  });

  test("a marker dooms exactly the listed attempt ids and no others", async () => {
    const { journalPath } = createJournalDir();
    const entries = [
      JSON.stringify({
        kind: "deliveries.record",
        deliveries: [delivery("d", { status: "pending" })],
      }),
      JSON.stringify({ kind: "delivery.attempt.record", attempt: attempt("a1", "d") }),
      JSON.stringify({ kind: "delivery.attempt.record", attempt: attempt("a2", "d", { attempt: 2 }) }),
      JSON.stringify({
        kind: "history.rotate",
        cutoff: CUTOFF,
        rotatedAt: NEW,
        evicted: {
          messageIds: [],
          invocationIds: [],
          flightIds: [],
          deliveryIds: [],
          deliveryAttemptIds: ["a1"],
          collaborationEventIds: [],
        },
      }),
    ];
    writeFileSync(journalPath, entries.join("\n") + "\n", "utf8");

    const journal = new FileBackedBrokerJournal(journalPath, { compactionPolicy: compactedPolicy });
    await journal.load();

    expect(journal.listDeliveryAttempts("d").map((a) => a.id)).toEqual(["a2"]);
    const attemptLines = (await journal.readEntries())
      .filter((entry) => entry.kind === "delivery.attempt.record")
      .map((entry) => entry.attempt.id);
    expect(attemptLines).toEqual(["a2"]);
  });

  // Legacy markers (no evicted sets) recompute the closure — an attempt on
  // an evictable delivery still leaves with it under the rules.
  test("a legacy marker without evicted sets retires attempts only with their delivery", async () => {
    const { journalPath } = createJournalDir();
    const entries = [
      JSON.stringify({ kind: "message.record", message: message("m") }),
      JSON.stringify({
        kind: "deliveries.record",
        deliveries: [
          delivery("d", { messageId: "m", status: "completed" }),
          // Pending on a different referent — must not protect m.
          delivery("d-keep", { messageId: "m-other", status: "pending" }),
        ],
      }),
      JSON.stringify({ kind: "delivery.attempt.record", attempt: attempt("a-doomed", "d") }),
      JSON.stringify({ kind: "delivery.attempt.record", attempt: attempt("a-keep", "d-keep") }),
      JSON.stringify({ kind: "history.rotate", cutoff: CUTOFF, rotatedAt: NEW }),
    ];
    writeFileSync(journalPath, entries.join("\n") + "\n", "utf8");

    const journal = new FileBackedBrokerJournal(journalPath, { compactionPolicy: compactedPolicy });
    await journal.load();

    expect(journal.listDeliveryAttempts("d").map((a) => a.id)).toEqual([]);
    expect(journal.listDeliveryAttempts("d-keep").map((a) => a.id)).toEqual(["a-keep"]);
  });
});
