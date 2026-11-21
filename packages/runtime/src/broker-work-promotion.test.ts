import { newestWorkFlight } from "./broker-failed-work.js";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlightRecord, InvocationRequest, WorkItemRecord } from "@openscout/protocol";
import { createInMemoryControlRuntime } from "./broker.js";
import { BrokerDurableStore } from "./broker-durable-store.js";
import { BrokerFlightLifecycleService } from "./broker-flight-lifecycle-service.js";
import { FileBackedBrokerJournal, type BrokerJournalEntry } from "./broker-journal.js";
import { BrokerWorkItemStore } from "./broker-work-item-store.js";
import { planHistoryRotation } from "./history-rotation.js";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const at = 1_800_000_000_000;
const invocation: InvocationRequest = {
  id: "invocation-1", requesterId: "operator", requesterNodeId: "node-1", targetAgentId: "agent-1",
  action: "consult", task: "work", ensureAwake: true, stream: false, createdAt: at,
  conversationId: "conversation-1", messageId: "message-1", collaborationRecordId: "work-1",
};
function terminal(patch: Partial<FlightRecord> = {}): FlightRecord {
  return { id: "flight-1", invocationId: invocation.id, requesterId: "operator", targetAgentId: "agent-1",
    state: "completed", startedAt: at, completedAt: at + 100, output: "Verified result", ...patch };
}

async function fixture(followNewest = false) {
  const directory = mkdtempSync(join(tmpdir(), "scout-work-promotion-"));
  directories.push(directory);
  const path = join(directory, "journal.ndjson");
  let journal = new FileBackedBrokerJournal(path);
  await journal.load();
  await journal.appendEntries({ kind: "invocation.record", invocation });
  let runtime = createInMemoryControlRuntime(journal.snapshot(), { localNodeId: "node-1" });
  let fault: "none" | "before" | "after" = "none";
  let skipPromotion = false;
  let insideWriter = false;
  const warnings: unknown[] = [];
  const commits: BrokerJournalEntry[][] = [];
  let durable: BrokerDurableStore;
  let work: BrokerWorkItemStore;
  let lifecycle: BrokerFlightLifecycleService;
  function wire() {
    durable = new BrokerDurableStore({
      journal: { async appendEntries(entries) {
        const promotion = entries.some(entry => entry.kind === "collaboration.event.record" && entry.event.kind !== "created");
        if (promotion && fault === "before") throw new Error("injected promotion persistence failure");
        const retained = await journal.appendEntries(entries);
        commits.push(retained);
        if (promotion && fault === "after") throw new Error("injected failure after durable promotion");
        return retained;
      } },
      projection: { async applyEntries() { expect(insideWriter).toBe(false); return []; } },
      threadEvents: { publish() {} },
    });
    work = new BrokerWorkItemStore({ runtime, durableStore: durable, durableFlight: id => journal.getFlight(id),
      durableWorkItem: id => journal.getCollaborationRecord(id),
      ...(followNewest ? { newestFlightForWork: (id: string) => newestWorkFlight(id, Object.values(runtime.peek().invocations), Object.values(runtime.peek().flights)) } : {}),
      createId: prefix => `${prefix}-created`, warn: (_message, error) => warnings.push(error),
    });
    lifecycle = new BrokerFlightLifecycleService({
      runtime,
      durableStore: {
        runWrite: fn => durable.runWrite(async () => { insideWriter = true; try { return await fn(); } finally { insideWriter = false; } }),
        commitEntries: durable.commitEntries, applyProjectedEntries: async () => {},
      },
      journal: { visitDeliveries: async () => {} }, invocationFor: id => id === invocation.id ? invocation : undefined,
      updateDeliveryStatus: async () => {}, updateDeliveryStatusIf: async () => false,
      prepareWorkPromotion: work.prepareTerminalWorkPromotion,
      promoteInvocationFlightToWork: async (...args) => { expect(insideWriter).toBe(false); if (!skipPromotion) await work.promoteInvocationFlightToWork(...args); },
      maybeForwardFlightToAuthority: async () => {}, isInvocationActive: () => false,
      warn: (_message, error) => warnings.push(error),
    });
  }
  wire();
  await work!.recordDeliveryWorkItemIfNeeded({
    payload: { id: "delivery-1", body: "work", intent: "consult", workItem: { id: "work-1", title: "Work", acceptanceState: "pending" } },
    requestId: "delivery-1", requesterId: "operator", targetAgentId: "agent-1", conversationId: "conversation-1", createdAt: at,
  });
  return {
    journal: () => journal, runtime: () => runtime, work: () => work, warnings, commits,
    setFault(value: typeof fault) { fault = value; }, skip(value: boolean) { skipPromotion = value; },
    record: (flight: FlightRecord) => lifecycle.recordFlight(flight),
    recover: () => work.recoverTerminalWorkPromotions(journal.listPendingWorkPromotionFlights()),
    async editWork(patch: Partial<WorkItemRecord>) {
      const record = { ...runtime.collaborationRecord("work-1"), ...patch } as WorkItemRecord;
      await durable.runWrite(() => durable.commitEntries({ kind: "collaboration.record", record }, async () => { await runtime.upsertCollaboration(record); }));
      return record;
    },
    async reopen() {
      await durable.flushProjectedEntries(); await journal.close();
      journal = new FileBackedBrokerJournal(path); await journal.load();
      runtime = createInMemoryControlRuntime(journal.snapshot(), { localNodeId: "node-1" }); wire();
    },
    async close() { await durable.flushProjectedEntries(); await journal.close(); },
  };
}

describe("durable terminal work promotion", () => {
  test.each(["completed", "failed", "cancelled"] as const)("%s promotion survives failure and journal reopen without duplicate events", async state => {
    const f = await fixture();
    try {
      f.setFault("before");
      await f.record(terminal({ state, ...(state === "failed" ? { error: "Execution failed", output: undefined } : {}) }));
      expect(f.journal().getFlight("flight-1")?.metadata?.workPromotion).toMatchObject({ status: "pending", flightState: state });
      expect(f.runtime().collaborationRecord("work-1")?.state).toBe("working");
      expect(f.warnings).toHaveLength(1);
      f.setFault("none"); await f.reopen();
      await f.recover(); await f.recover(); await f.reopen(); await f.recover();
      expect(f.runtime().collaborationRecord("work-1")?.state).toBe(state === "completed" ? "review" : state === "failed" ? "waiting" : "cancelled");
      expect(f.journal().getFlight("flight-1")?.metadata?.workPromotion).toMatchObject({ status: "applied" });
      const events = f.journal().listCollaborationEvents({ recordId: "work-1" }).filter(event => event.kind !== "created");
      expect(events).toHaveLength(1);
      expect(events[0]?.id).toStartWith("work-flight-");
      expect(f.commits.find(batch => batch.some(entry => entry.kind === "collaboration.event.record" && entry.event.id === events[0]?.id))?.map(entry => entry.kind))
        .toEqual(["collaboration.record", "collaboration.event.record", "flight.record"]);
      expect(f.journal().listPendingWorkPromotionFlights()).toEqual([]);
    } finally { await f.close(); }
  });

  test("a failure after the promotion batch committed does not append its event again", async () => {
    const f = await fixture();
    try {
      f.setFault("after"); await f.record(terminal());
      expect(f.runtime().collaborationRecord("work-1")?.state).toBe("working");
      expect(f.journal().getFlight("flight-1")?.metadata?.workPromotion).toMatchObject({ status: "applied" });
      f.setFault("none");
      await f.work().promoteInvocationFlightToWork(invocation, terminal(), "retry");
      await f.reopen(); await f.recover();
      expect(f.runtime().collaborationRecord("work-1")?.state).toBe("review");
      expect(f.journal().listCollaborationEvents({ recordId: "work-1" }).filter(event => event.kind !== "created")).toHaveLength(1);
    } finally { await f.close(); }
  });

  test.each(["accepted", "cancelled", "edited"])("recovery preserves a later human decision: %s", async decision => {
    const f = await fixture();
    try {
      f.skip(true); await f.record(terminal());
      const changed = await f.editWork(decision === "accepted" ? { state: "done", acceptanceState: "accepted", completedAt: at + 100 }
        : decision === "cancelled" ? { state: "cancelled" } : { summary: "Human revision at the same timestamp" });
      await f.recover();
      expect(f.runtime().collaborationRecord("work-1")).toEqual(changed);
      expect(f.journal().getFlight("flight-1")?.metadata?.workPromotion).toMatchObject({ status: "superseded" });
      expect(f.journal().listCollaborationEvents({ recordId: "work-1" }).filter(event => event.kind !== "created")).toEqual([]);
    } finally { await f.close(); }
  });

  test("a committed human acceptance wins even if its runtime callback was interrupted", async () => {
    const f = await fixture();
    try {
      f.skip(true); await f.record(terminal());
      const accepted = { ...f.journal().getCollaborationRecord("work-1"), state: "done", acceptanceState: "accepted" } as WorkItemRecord;
      await f.journal().appendEntries({ kind: "collaboration.record", record: accepted });
      // Runtime still has the pre-acceptance work item, as after an interrupted apply callback.
      expect(f.runtime().collaborationRecord("work-1")?.state).toBe("working");
      await f.recover(); await f.reopen();
      expect(f.runtime().collaborationRecord("work-1")).toEqual(accepted);
      expect(f.journal().getFlight("flight-1")?.metadata?.workPromotion).toMatchObject({ status: "superseded" });
    } finally { await f.close(); }
  });

  test("a newer current flight wins and stays current after recovery and journal reopen", async () => {
    const f = await fixture();
    try {
      f.skip(true); await f.record(terminal());
      const next = terminal({ id: "flight-2", state: "running", completedAt: undefined, output: undefined });
      await f.record(next); await f.recover();
      expect(f.runtime().flightForInvocation(invocation.id)?.id).toBe("flight-2");
      expect(f.runtime().collaborationRecord("work-1")?.state).toBe("working");
      await f.reopen();
      expect(f.runtime().flightForInvocation(invocation.id)?.id).toBe("flight-2");
      expect(f.journal().getFlight("flight-1")?.metadata?.workPromotion).toMatchObject({ status: "superseded" });
    } finally { await f.close(); }
  });

  test("malformed pending work is retained while another valid promotion recovers", async () => {
    const f = await fixture();
    try {
      f.skip(true); await f.record(terminal());
      const malformed = terminal({ id: "bad-flight", invocationId: "bad-invocation", metadata: { workPromotion: { version: 99, status: "pending" } } });
      await f.journal().appendEntries({ kind: "flight.record", flight: malformed });
      await f.runtime().upsertFlight(malformed);
      await f.work().recoverTerminalWorkPromotions([malformed, f.journal().getFlight("flight-1")!]);
      expect(f.journal().getFlight("bad-flight")).toEqual(malformed);
      expect(f.warnings).toHaveLength(1);
      expect(f.runtime().collaborationRecord("work-1")?.state).toBe("review");
      expect(f.journal().listPendingWorkPromotionFlights().map(flight => flight.id)).toEqual(["bad-flight"]);
    } finally { await f.close(); }
  });

  test("pending recovery pages are bounded and fair across repeated failures and restart", async () => {
    const f = await fixture();
    try {
      await f.journal().appendEntries(Array.from({ length: 300 }, (_, index) => ({ kind: "flight.record" as const,
        flight: terminal({ id: `pending-${index}`, invocationId: `invocation-${index}`,
          metadata: { workPromotion: { status: "pending", version: 99 } } }),
      })));
      await f.reopen();
      const first = f.journal().listPendingWorkPromotionFlights(1000);
      const second = f.journal().listPendingWorkPromotionFlights(1000);
      expect(first).toHaveLength(256);
      expect(second).toHaveLength(256);
      expect(second[0]?.id).toBe("pending-256");
      expect(new Set([...first, ...second].map(flight => flight.id)).size).toBe(300);
    } finally { await f.close(); }
  });

  test("terminal enrichment preserves the original intent and pending work pins history", async () => {
    const f = await fixture();
    try {
      f.skip(true); await f.record(terminal());
      const original = f.runtime().flight("flight-1")?.metadata?.workPromotion;
      await f.record(terminal({ metadata: { newObservation: true, workPromotion: { status: "applied" } } }));
      expect(f.journal().getFlight("flight-1")?.metadata?.workPromotion).toEqual(original);
      const plan = planHistoryRotation(f.journal().snapshot(), at + 1_000_000);
      expect(plan.flightIds.has("flight-1")).toBe(false);
      expect(plan.invocationIds.has(invocation.id)).toBe(false);
      await f.recover();
      const settled = planHistoryRotation(f.journal().snapshot(), at + 1_000_000);
      expect(settled.flightIds.has("flight-1")).toBe(true);
    } finally { await f.close(); }
  });
});


describe("failed work follows its newest run", () => {
  async function seedSuccessor(f: Awaited<ReturnType<typeof fixture>>, state: FlightRecord["state"] = "completed", workId = "work-1") {
    const successor = { ...invocation, id: "invocation-2", createdAt: at + 50, collaborationRecordId: workId };
    const flight = terminal({ id: "flight-2", invocationId: successor.id, startedAt: at + 50,
      completedAt: at + 75, state, ...(state === "failed" ? { output: undefined, error: "New error", metadata: { failureCause: "harness_error" } } : {}) });
    await f.journal().appendEntries([{ kind: "invocation.record", invocation: successor }, { kind: "flight.record", flight }]);
    await f.reopen();
  }

  test.each(["none", "pending"] as const)("an older failure cannot leave completed work waiting (%s acceptance)", async acceptanceState => {
    const f = await fixture(true);
    try {
      await f.editWork({ acceptanceState });
      await seedSuccessor(f);
      await f.record(terminal({ state: "failed", output: undefined, error: "Superseded", metadata: { failureCause: "superseded" } }));
      expect(f.runtime().collaborationRecord("work-1")).toMatchObject({ state: acceptanceState === "none" ? "done" : "review",
        metadata: { lastFlightId: "flight-2" } });
      expect((f.runtime().collaborationRecord("work-1") as WorkItemRecord).waitingOn).toBeUndefined();
    } finally { await f.close(); }
  });

  test.each(["missing", "actor"] as const)("one startup pass repairs an existing %s blocker and remains idempotent after reopen", async blocker => {
    const f = await fixture(true);
    try {
      await f.record(terminal({ state: "failed", output: undefined, error: "Old untyped failure" }));
      const legacy = { ...f.journal().getCollaborationRecord("work-1"), waitingOn: blocker === "actor"
        ? { kind: "actor", label: "Decide whether to retry", metadata: { invocationId: invocation.id, flightId: "flight-1" } }
        : undefined, acceptanceState: "none" } as WorkItemRecord;
      if (blocker === "missing") { const { lastFlightState: _legacyMissing, ...metadata } = legacy.metadata ?? {}; legacy.metadata = metadata; }
      await f.journal().appendEntries({ kind: "collaboration.record", record: legacy });
      await seedSuccessor(f);
      await f.reopen();
      for (let i = 0; i < 2; i++) await f.work().reconcileFailedWorkItems([f.journal().getCollaborationRecord("work-1")!]);
      await f.reopen();
      await f.work().reconcileFailedWorkItems([f.journal().getCollaborationRecord("work-1")!]);
      expect(f.runtime().collaborationRecord("work-1")).toMatchObject({ state: "done", metadata: { lastFlightId: "flight-2" } });
      expect(f.journal().listCollaborationEvents({ recordId: "work-1" }).filter(item => item.metadata?.source === "failed_run_reconciliation")).toHaveLength(1);
    } finally { await f.close(); }
  });

  test("newer failures carry their own cause, not the older failure", async () => {
    const f = await fixture(true);
    try {
      await seedSuccessor(f, "failed");
      await f.record(terminal({ state: "failed", output: undefined, metadata: { failureCause: "superseded" } }));
      expect(f.runtime().collaborationRecord("work-1")).toMatchObject({ state: "waiting",
        waitingOn: { cause: "harness_error", flightId: "flight-2", retryable: false } });
    } finally { await f.close(); }
  });

  test("an endpoint's unrelated newer task does not settle this work", async () => {
    const f = await fixture(true);
    try {
      await seedSuccessor(f, "completed", "other-work");
      await f.record(terminal({ state: "failed", output: undefined, metadata: { failureCause: "superseded" } }));
      expect(f.runtime().collaborationRecord("work-1")).toMatchObject({ state: "waiting", waitingOn: { cause: "superseded" } });
    } finally { await f.close(); }
  });

  test("migration keeps a manual wait and a human terminal decision", async () => {
    const f = await fixture(true);
    try {
      await f.record(terminal({ state: "failed", output: undefined }));
      await seedSuccessor(f);
      const manual = await f.editWork({ waitingOn: { kind: "condition", label: "Human review of scope" } });
      await f.work().reconcileFailedWorkItems([manual]);
      expect(f.runtime().collaborationRecord("work-1")).toEqual(manual);
      const done = await f.editWork({ state: "done", acceptanceState: "accepted" });
      await f.work().reconcileFailedWorkItems([done]);
      expect(f.runtime().collaborationRecord("work-1")).toEqual(done);
    } finally { await f.close(); }
  });
});
