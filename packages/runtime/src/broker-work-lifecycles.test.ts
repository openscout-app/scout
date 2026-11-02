import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_WORK_LIFECYCLE, workPlacementOf, type CollaborationEvent, type CollaborationRecord, type WorkItemRecord } from "@openscout/protocol";

import { createInMemoryControlRuntime } from "./broker.js";
import type { BrokerJournalEntry } from "./broker-journal.js";
import { BrokerDurableStore } from "./broker-durable-store.js";
import { BrokerWorkLifecycleService, WorkLifecycleError, WorkLifecycleRegistry, placeRuntimeChange } from "./broker-work-lifecycles.js";

function workItem(input: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "work-1", kind: "work_item", title: "Ship the board", createdById: "operator", ownerId: "agent-1",
    nextMoveOwnerId: "agent-1", state: "open", acceptanceState: "none", createdAt: 100, updatedAt: 100, ...input,
  };
}

async function setup(records: CollaborationRecord[] = [workItem()], directory?: string) {
  const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });
  for (const record of records) await runtime.upsertCollaboration(record);
  const events: CollaborationEvent[] = [];
  const durableStore = new BrokerDurableStore({
    journal: { async appendEntries(entries: BrokerJournalEntry[]) {
      for (const e of entries) if (e.kind === "collaboration.event.record") events.push(e.event);
      return entries;
    } },
    projection: { async applyEntries() { return []; } },
    threadEvents: { publish() {} },
  });
  let id = 0;
  let clock = 1_000;
  const registry = new WorkLifecycleRegistry(directory);
  const service = new BrokerWorkLifecycleService({
    registry, durableStore, runtime,
    listEvents: ({ recordId }) => events.filter((e) => !recordId || e.recordId === recordId).sort((a, b) => b.at - a.at),
    childrenOf: (recordId) => Object.values(runtime.peek().collaborationRecords).filter((r) => r.parentId === recordId),
    createId: (prefix) => `${prefix}-${++id}`,
    operatorActorId: "operator",
    now: () => (clock += 10),
  });
  const item = () => runtime.collaborationRecord("work-1") as WorkItemRecord;
  return { runtime, service, events, item, registry };
}

describe("work lifecycle service", () => {
  test("a move updates state and placement and writes one ledger event", async () => {
    const { service, events, item } = await setup();
    const result = await service.move({ workId: "work-1", to: "doing", actorId: "agent-1" });
    expect(result.applied).toBe(true);
    expect(item().state).toBe("working");
    expect(workPlacementOf(item())).toMatchObject({ lifecycleId: "scout.default", station: "doing", revision: 1 });
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("progressed");
    expect(service.moves({ workId: "work-1" })[0]).toMatchObject({ from: "ready", to: "doing", verdict: "allow", revision: 1 });
  });

  test("a held move is recorded and leaves the item alone; claim lets it through", async () => {
    const { service, events, item } = await setup();
    const held = await service.move({ workId: "work-1", to: "doing", actorId: "agent-2" });
    expect(held.applied).toBe(false);
    expect(held.decision.verdict).toBe("hold");
    expect(item().state).toBe("open");
    expect(events).toHaveLength(1);
    const claimed = await service.move({ workId: "work-1", to: "doing", actorId: "agent-2", claim: true });
    expect(claimed.applied).toBe(true);
    expect(item().ownerId).toBe("agent-2");
    expect(events.at(-1)!.kind).toBe("claimed");
  });

  test("dry runs and moves outside the graph write nothing", async () => {
    const { service, events } = await setup();
    expect((await service.move({ workId: "work-1", to: "doing", actorId: "agent-1", dryRun: true })).decision.verdict).toBe("allow");
    expect((await service.move({ workId: "work-1", to: "review", actorId: "agent-1" })).decision.verdict).toBe("deny");
    expect(events).toHaveLength(0);
  });

  test("waiting carries its reason onto the record", async () => {
    const { service, item } = await setup([workItem({ state: "working" })]);
    expect((await service.move({ workId: "work-1", to: "waiting", actorId: "agent-1" })).decision.verdict).toBe("deny");
    await service.move({ workId: "work-1", to: "waiting", actorId: "agent-1", waitingOn: { label: "CI on the fork" } });
    expect(item().state).toBe("waiting");
    expect(item().waitingOn).toMatchObject({ kind: "condition", label: "CI on the fork" });
    await service.move({ workId: "work-1", to: "doing", actorId: "agent-1" });
    expect(item().waitingOn).toBeUndefined();
  });

  test("done is pending review; confirm settles it, a stale review is refused", async () => {
    const { service, item } = await setup([workItem({ state: "working" })]);
    const done = await service.move({ workId: "work-1", to: "done", actorId: "agent-1" });
    expect(done.decision.review).toBe("pending");
    expect(workPlacementOf(item())?.reviewPending).toBe(true);
    const reviewed = await service.review({ workId: "work-1", moveId: done.move!.id, verdict: "confirm", revision: done.move!.revision!, actorId: "reviewer" });
    expect(reviewed.status).toBe("confirmed");
    expect(workPlacementOf(item())?.reviewPending).toBeUndefined();
    expect(service.moves({ workId: "work-1" })[0]).toMatchObject({ review: "confirmed", reviewedById: "reviewer" });
    await expect(service.review({ workId: "work-1", moveId: done.move!.id, verdict: "confirm", revision: 1 })).rejects.toBeInstanceOf(WorkLifecycleError);
  });

  test("reopen sends the item back to where it came from", async () => {
    const { service, item } = await setup([workItem({ state: "working" })]);
    await service.move({ workId: "work-1", to: "review", actorId: "agent-1" });
    const done = await service.move({ workId: "work-1", to: "done", actorId: "agent-1" });
    const later = await service.review({ workId: "work-1", moveId: done.move!.id, verdict: "reopen", revision: done.move!.revision!, note: "Tests missing." });
    expect(later.status).toBe("reopened");
    expect(later.station).toBe("review");
    expect(item().state).toBe("review");
  });

  test("a review of an older revision is stale", async () => {
    const { service } = await setup([workItem({ state: "working" })]);
    const done = await service.move({ workId: "work-1", to: "done", actorId: "agent-1" });
    await service.move({ workId: "work-1", to: "doing", actorId: "agent-1" });
    const stale = await service.review({ workId: "work-1", moveId: done.move!.id, verdict: "confirm", revision: done.move!.revision! });
    expect(stale.status).toBe("stale");
  });

  test("runtime changes get a placement and a ledger move", () => {
    const registry = new WorkLifecycleRegistry();
    const before = workItem({ state: "working" });
    const after = { ...before, state: "done" as const, completedAt: 500, updatedAt: 500 };
    const placed = placeRuntimeChange(registry.forRecord(before), before, after, { now: 500, moveId: "m1", actorId: "agent-1" });
    expect(workPlacementOf(placed.record)).toMatchObject({ station: "done", reviewPending: true });
    expect(placed.move).toMatchObject({ from: "doing", to: "done", review: "pending" });
  });

  test("saved lifecycles load, need a higher version to change, and items can follow them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "work-lifecycles-"));
    try {
      const registry = new WorkLifecycleRegistry(dir);
      const doc = { ...DEFAULT_WORK_LIFECYCLE, id: "team.fast", name: "Fast", stations: DEFAULT_WORK_LIFECYCLE.stations.map((s) => ({ ...s, judges: undefined })) };
      registry.save(doc);
      expect(() => registry.save({ ...doc, name: "Faster" })).toThrow(WorkLifecycleError);
      registry.save({ ...doc, name: "Faster", version: 2 });
      expect(new WorkLifecycleRegistry(dir).get("team.fast")?.version).toBe(2);
      const { service } = await setup([workItem({ state: "working", metadata: { workLifecycleId: "team.fast" } })], dir);
      const done = await service.move({ workId: "work-1", to: "done", actorId: "agent-1" });
      expect(done.decision).toMatchObject({ lifecycleId: "team.fast", review: "not_needed" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
