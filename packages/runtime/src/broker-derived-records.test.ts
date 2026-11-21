import { describe, expect, test } from "bun:test";

import {
  DEFAULT_WORK_LIFECYCLE,
  DERIVED_BODY_MAX_BYTES,
  DERIVED_WORK_LABEL,
  compileWorkLifecycle,
  keepDerivedRecords,
  readDerived,
  validateWorkLifecycle,
  type CollaborationRecord,
  type ScoutDeliverRequest,
  type WorkItemRecord,
  type WorkLifecycle,
} from "@openscout/protocol";

import { createInMemoryControlRuntime } from "./broker.js";
import type { BrokerJournalEntry } from "./broker-journal.js";
import { BrokerDerivedRecordService, DerivedRecordError, derivedRequestId } from "./broker-derived-records.js";
import { BrokerDurableStore } from "./broker-durable-store.js";

const lifecycle: WorkLifecycle = {
  ...DEFAULT_WORK_LIFECYCLE,
  id: "test.derived",
  stations: DEFAULT_WORK_LIFECYCLE.stations.map((station) => station.id === "waiting"
    ? { ...station, derive: [
      { kind: "presentation", instructions: "Pick what to show.", skill: "work-board-curator", projectPath: "/projects/app", harness: "claude" },
      { kind: "digest", instructions: "Summarize it." },
    ] }
    : station),
};

function workItem(input: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "work-1", kind: "work_item", title: "Ship the board", createdById: "operator", ownerId: "agent-1",
    nextMoveOwnerId: "agent-1", state: "waiting", acceptanceState: "none", createdAt: 100, updatedAt: 100,
    waitingOn: { kind: "condition", label: "a decision" },
    metadata: { workPlacement: { lifecycleId: "test.derived", lifecycleVersion: 1, station: "waiting", revision: 3, movedAt: 100 } },
    ...input,
  };
}

async function setup(records: CollaborationRecord[] = [workItem()], options: { maxDispatchesPerDay?: number; deliver?: boolean; recordAsks?: boolean } = {}) {
  const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });
  for (const record of records) await runtime.upsertCollaboration(record);
  const journal: BrokerJournalEntry[] = [];
  const durableStore = new BrokerDurableStore({
    journal: { async appendEntries(entries: BrokerJournalEntry[]) { journal.push(...entries); return entries; } },
    projection: { async applyEntries() { return []; } },
    threadEvents: { publish() {} },
  });
  const machine = compileWorkLifecycle(lifecycle);
  const asks: ScoutDeliverRequest[] = [];
  let clock = 1_000;
  // With recordAsks, an accepted ask leaves its work item, as delivery does.
  const deliver = async (request: ScoutDeliverRequest) => {
    asks.push(request);
    if (!options.recordAsks || !request.workItem) return;
    await runtime.upsertCollaboration({
      id: `work-ask-${asks.length}`, kind: "work_item", title: request.workItem.title, createdById: "scout.deriver",
      ownerId: "agent-9", nextMoveOwnerId: "agent-9", state: "done", acceptanceState: "none", labels: request.workItem.labels,
      createdAt: clock, updatedAt: clock, metadata: { source: "scout-derived", ...request.workItem.metadata, deliveryRequestId: request.requestId },
    } as WorkItemRecord);
  };
  const serviceOptions = () => ({
    registry: { forRecord: () => machine },
    durableStore,
    runtime,
    listWorkItems: () => Object.values(runtime.peek().collaborationRecords).filter((r): r is WorkItemRecord => r.kind === "work_item"),
    producerActorId: "scout.deriver",
    maxDispatchesPerDay: options.maxDispatchesPerDay,
    now: () => clock,
  });
  const service = new BrokerDerivedRecordService({
    registry: { forRecord: () => machine },
    durableStore,
    runtime,
    listWorkItems: () => Object.values(runtime.peek().collaborationRecords).filter((r): r is WorkItemRecord => r.kind === "work_item"),
    ...(options.deliver === false ? {} : { deliver }),
    producerActorId: "scout.deriver",
    maxDispatchesPerDay: options.maxDispatchesPerDay,
    now: () => clock,
  });
  const item = (id = "work-1") => runtime.collaborationRecord(id) as WorkItemRecord;
  // A new service on the same records, as after a runtime restart.
  const restart = () => new BrokerDerivedRecordService({ ...serviceOptions(), deliver });
  return { runtime, service, journal, asks, item, restart, advance: (ms: number) => { clock += ms; } };
}

describe("derived records", () => {
  test("a write lands on the source without touching updatedAt, and reads as current", async () => {
    const { service, item, journal } = await setup();
    const before = service.read({ workId: "work-1", kind: "presentation" });
    expect(before).toEqual({ status: "missing", currentVersion: "r3.u100" });
    const written = await service.write({ workId: "work-1", kind: "presentation", sourceVersion: before.currentVersion, body: { primary: "shot-1" }, producerId: "agent-9" });
    expect(written.status).toBe("written");
    expect(item().updatedAt).toBe(100);
    expect(journal.map((e) => e.kind)).toEqual(["collaboration.record"]);
    const after = service.read({ workId: "work-1", kind: "presentation" });
    expect(after.status).toBe("current");
    expect(after.record).toMatchObject({ kind: "presentation", sourceId: "work-1", sourceVersion: "r3.u100", body: { primary: "shot-1" }, producer: { id: "agent-9", kind: "agent" } });
  });

  test("a write that names an old version is refused and changes nothing", async () => {
    const { service, runtime, item, journal } = await setup();
    await runtime.upsertCollaboration({ ...item(), updatedAt: 200 });
    const result = await service.write({ workId: "work-1", kind: "presentation", sourceVersion: "r3.u100", body: {} });
    expect(result).toEqual({ status: "stale", currentVersion: "r3.u200" });
    expect(journal).toHaveLength(0);
    expect(service.read({ workId: "work-1", kind: "presentation" }).status).toBe("missing");
  });

  test("a later change to the source makes the record stale, and a reader still sees the old body", async () => {
    const { service, runtime, item } = await setup();
    await service.write({ workId: "work-1", kind: "presentation", sourceVersion: "r3.u100", body: { primary: "old" } });
    await runtime.upsertCollaboration({ ...item(), updatedAt: 300 });
    const read = service.read({ workId: "work-1", kind: "presentation" });
    expect(read.status).toBe("stale");
    expect(read.record?.body).toEqual({ primary: "old" });
  });

  test("a producer version the reader no longer accepts reads as stale", async () => {
    const { service, item } = await setup();
    await service.write({ workId: "work-1", kind: "presentation", sourceVersion: "r3.u100", body: {}, producerVersion: "v1" });
    expect(readDerived(item(), "presentation", { producerVersion: "v1" }).status).toBe("current");
    expect(readDerived(item(), "presentation", { producerVersion: "v2" }).status).toBe("stale");
  });

  test("bad requests fail with a status", async () => {
    const { service } = await setup();
    await expect(service.write({ workId: "work-1", kind: "Bad Kind", sourceVersion: "r3.u100", body: {} })).rejects.toMatchObject({ status: 400 });
    await expect(service.write({ workId: "work-1", kind: "presentation", sourceVersion: "r3.u100", body: "x".repeat(DERIVED_BODY_MAX_BYTES) })).rejects.toMatchObject({ status: 413 });
    await expect(service.write({ workId: "missing", kind: "presentation", sourceVersion: "r0.u0", body: {} })).rejects.toBeInstanceOf(DerivedRecordError);
  });

  test("pending lists each kind the station names that has no current record", async () => {
    const { service } = await setup([
      workItem(),
      workItem({ id: "work-done", state: "done" }),
      workItem({ id: "work-derive-run", labels: [DERIVED_WORK_LABEL] }),
    ]);
    expect(service.pending()).toEqual([
      { workId: "work-1", kind: "presentation", station: "waiting", sourceVersion: "r3.u100", status: "missing", dispatchable: true },
      { workId: "work-1", kind: "digest", station: "waiting", sourceVersion: "r3.u100", status: "missing", dispatchable: false },
    ]);
    await service.write({ workId: "work-1", kind: "presentation", sourceVersion: "r3.u100", body: {} });
    expect(service.pending().map((p) => p.kind)).toEqual(["digest"]);
  });

  test("dispatch starts one idempotent ask per item and kind, then waits out the interval", async () => {
    const { service, runtime, item, asks, advance } = await setup();
    expect(await service.dispatchPending()).toBe(1);
    expect(asks[0]).toMatchObject({
      requestId: derivedRequestId({ workId: "work-1", kind: "presentation", sourceVersion: "r3.u100" }),
      caller: { actorId: "scout.deriver" },
      target: { kind: "project_path", projectPath: "/projects/app" },
      intent: "consult",
      execution: { harness: "claude", session: "new" },
      labels: [DERIVED_WORK_LABEL],
    });
    expect(asks[0]!.body).toContain("work-board-curator");
    expect(asks[0]!.body).toContain('sourceVersion "r3.u100"');
    // A change inside the interval does not start a second ask.
    await runtime.upsertCollaboration({ ...item(), updatedAt: 150 });
    expect(await service.dispatchPending()).toBe(0);
    advance(15 * 60 * 1000);
    expect(await service.dispatchPending()).toBe(1);
    expect(asks[1]!.requestId).toBe("derive.work-1.presentation.r3.u150");
  });

  test("dispatch stops at the daily cap and starts nothing without a deliver route", async () => {
    const capped = await setup([workItem(), workItem({ id: "work-2" })], { maxDispatchesPerDay: 1 });
    expect(await capped.service.dispatchPending()).toBe(1);
    expect(capped.asks).toHaveLength(1);
    const pull = await setup([workItem()], { deliver: false });
    expect(await pull.service.dispatchPending()).toBe(0);
    expect(pull.service.pending()).toHaveLength(2);
  });

  test("an ask that ends without a write is not replayed and spends no more budget", async () => {
    const { service, runtime, item, asks, advance } = await setup([workItem(), workItem({ id: "work-2", createdAt: 50, updatedAt: 50 })], { maxDispatchesPerDay: 3, recordAsks: true });
    expect(await service.dispatchPending()).toBe(2);
    // The agents answered without writing: both items stay pending at the same version.
    for (let pass = 0; pass < 8; pass++) {
      advance(15 * 60 * 1000);
      expect(await service.dispatchPending()).toBe(0);
    }
    expect(asks).toHaveLength(2);
    expect(service.pending().filter((p) => p.dispatchable)).toHaveLength(2);
    // A new version is a new request id, and the budget still has room for it.
    await runtime.upsertCollaboration({ ...item(), updatedAt: 200 });
    expect(await service.dispatchPending()).toBe(1);
    expect(asks.map((a) => a.requestId)).toEqual([
      "derive.work-1.presentation.r3.u100", "derive.work-2.presentation.r3.u50", "derive.work-1.presentation.r3.u200",
    ]);
  });

  test("a restart reads the asked versions and the daily cap from records", async () => {
    const { runtime, item, asks, restart, advance } = await setup([workItem(), workItem({ id: "work-2", createdAt: 50, updatedAt: 50 }), workItem({ id: "work-3", createdAt: 40, updatedAt: 40 })], { maxDispatchesPerDay: 2, recordAsks: true });
    expect(await restart().dispatchPending()).toBe(2);
    expect(asks.map((a) => a.workItem?.metadata?.derivedRequestId)).toEqual(["derive.work-1.presentation.r3.u100", "derive.work-2.presentation.r3.u50"]);
    // The old instance hit its cap. A new one, a minute later, starts nothing.
    advance(60 * 1000);
    await runtime.upsertCollaboration({ ...item(), updatedAt: 300 });
    expect(await restart().dispatchPending()).toBe(0);
    expect(asks).toHaveLength(2);
    // The next UTC day has a fresh budget.
    advance(24 * 60 * 60 * 1000);
    expect(await restart().dispatchPending()).toBe(2);
    expect(asks.slice(2).map((a) => a.requestId)).toEqual(["derive.work-1.presentation.r3.u300", "derive.work-3.presentation.r3.u40"]);
  });

  test("a restart inside the interval does not ask again for a changed item", async () => {
    const { runtime, item, asks, restart, advance } = await setup([workItem()], { recordAsks: true });
    expect(await restart().dispatchPending()).toBe(1);
    advance(60 * 1000);
    await runtime.upsertCollaboration({ ...item(), updatedAt: 400 });
    expect(await restart().dispatchPending()).toBe(0);
    advance(15 * 60 * 1000);
    expect(await restart().dispatchPending()).toBe(1);
    expect(asks).toHaveLength(2);
  });

  test("a deliver that fails may be tried again after the interval", async () => {
    const { runtime, item } = await setup();
    let calls = 0;
    let clock = 0;
    const service = new BrokerDerivedRecordService({
      registry: { forRecord: () => compileWorkLifecycle(lifecycle) },
      durableStore: { runWrite: (work) => work(), commitEntries: async (entries) => [entries].flat() },
      runtime,
      listWorkItems: () => [item()],
      deliver: async () => { calls += 1; throw new Error("no route"); },
      producerActorId: "scout.deriver",
      now: () => clock,
    });
    expect(await service.dispatchPending()).toBe(1);
    expect(await service.dispatchPending()).toBe(0);
    clock += 15 * 60 * 1000;
    expect(await service.dispatchPending()).toBe(1);
    expect(calls).toBe(2);
  });

  test("a kind named like an Object.prototype key reads as missing", async () => {
    const { item } = await setup();
    for (const kind of ["constructor", "tostring", "__proto__", "hasownproperty"]) {
      expect(readDerived(item(), kind)).toEqual({ status: "missing", currentVersion: "r3.u100" });
    }
    expect(readDerived({ ...item(), metadata: {} }, "constructor").status).toBe("missing");
  });
});

describe("lifecycle derive validation", () => {
  const withDerive = (derive: unknown) => ({
    ...lifecycle,
    stations: lifecycle.stations.map((s) => s.id === "review" ? { ...s, derive } : s),
  }) as WorkLifecycle;

  test("accepts the test lifecycle and rejects bad, duplicate or empty derivers", () => {
    expect(validateWorkLifecycle(lifecycle)).toEqual([]);
    expect(validateWorkLifecycle(withDerive([{ kind: "Bad", instructions: "x" }])).join()).toContain("derive kind Bad");
    expect(validateWorkLifecycle(withDerive([{ kind: "a", instructions: "x" }, { kind: "a", instructions: "y" }])).join()).toContain("duplicate derive kind a");
    expect(validateWorkLifecycle(withDerive([{ kind: "a", instructions: " " }])).join()).toContain("needs instructions");
  });
});

describe("client writes", () => {
  test("keep the runtime's derived records: a client can neither drop nor forge one", () => {
    const held = { schema: "openscout.derived.v1", kind: "presentation", sourceId: "work-1", sourceVersion: "r3.u100", producer: { id: "a", kind: "agent" }, body: {}, generatedAt: 1 };
    const existing = workItem({ metadata: { ...workItem().metadata, derived: { presentation: held } } });
    const dropped = keepDerivedRecords(existing, workItem({ metadata: { note: "client" } }));
    expect(dropped.metadata).toEqual({ note: "client", derived: { presentation: held } });
    const forged = keepDerivedRecords(workItem(), workItem({ metadata: { derived: { presentation: { ...held, body: { forged: true } } } } }));
    expect(forged.metadata).toEqual({});
    const plain = workItem({ metadata: { note: "x" } });
    expect(keepDerivedRecords(workItem(), plain)).toBe(plain);
  });
});
