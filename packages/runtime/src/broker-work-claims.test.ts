import { describe, expect, test } from "bun:test";

import { workClaimOf, type CollaborationEvent, type CollaborationRecord, type WorkItemRecord } from "@openscout/protocol";

import { createInMemoryControlRuntime } from "./broker.js";
import type { BrokerJournalEntry } from "./broker-journal.js";
import { BrokerDurableStore } from "./broker-durable-store.js";
import { WorkClaimConflictError, reconcileWorkClaimOnWrite } from "./broker-work-claims.js";
import { BrokerWorkLifecycleService, WorkLifecycleRegistry } from "./broker-work-lifecycles.js";

function workItem(input: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "work-1", kind: "work_item", title: "Ship the board", createdById: "operator",
    ownerId: "planner", nextMoveOwnerId: "planner", state: "open", acceptanceState: "none", createdAt: 100, updatedAt: 100, ...input,
  };
}

async function setup(records: CollaborationRecord[] = [workItem()]) {
  const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });
  for (const record of records) await runtime.upsertCollaboration(record);
  const events: CollaborationEvent[] = [];
  const durableStore = new BrokerDurableStore({
    journal: { async appendEntries(entries: BrokerJournalEntry[]) {
      // Yield like a real journal write, so unserialized writers would interleave.
      await new Promise((resolve) => setTimeout(resolve, 1));
      for (const e of entries) if (e.kind === "collaboration.event.record") events.push(e.event);
      return entries;
    } },
    projection: { async applyEntries() { return []; } },
    threadEvents: { publish() {} },
  });
  let id = 0;
  const clock = { now: 1_000_000 };
  const service = new BrokerWorkLifecycleService({
    registry: new WorkLifecycleRegistry(), durableStore, runtime,
    listEvents: ({ recordId }) => events.filter((e) => !recordId || e.recordId === recordId),
    listWorkItems: () => Object.values(runtime.peek().collaborationRecords).filter((r): r is WorkItemRecord => r.kind === "work_item"),
    childrenOf: () => [],
    createId: (prefix) => `${prefix}-${++id}`,
    operatorActorId: "operator",
    now: () => clock.now,
  });
  const item = () => runtime.collaborationRecord("work-1") as WorkItemRecord;
  return { service, events, item, clock };
}

async function conflictOf(promise: Promise<unknown>): Promise<WorkClaimConflictError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WorkClaimConflictError);
    return error as WorkClaimConflictError;
  }
  throw new Error("expected a claim conflict");
}

describe("work claims", () => {
  test("two concurrent claims: exactly one wins and the other gets an actionable conflict", async () => {
    const { service, events, item } = await setup();
    const results = await Promise.allSettled([
      service.claim({ workId: "work-1", actorId: "agent-a", sessionAddress: "sess.aaaaaaaaaaaa@host-a" }),
      service.claim({ workId: "work-1", actorId: "agent-b", sessionAddress: "sess.bbbbbbbbbbbb@host-b" }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);

    const error = lost[0]!.reason as WorkClaimConflictError;
    expect(error).toBeInstanceOf(WorkClaimConflictError);
    expect(error.status).toBe(409);
    expect(error.conflict).toMatchObject({
      code: "work_claim_held", workId: "work-1", ownerId: "agent-a",
      holder: { claimantId: "agent-a", sessionAddress: "sess.aaaaaaaaaaaa@host-a", leaseGeneration: 1 },
    });
    expect(error.conflict.retryAfterMs).toBeGreaterThan(0);
    expect(error.message).toContain("claimed by agent-a (session sess.aaaaaaaaaaaa@host-a)");
    expect(error.conflict.hint).toContain("ask agent-a to release it");

    expect(item().ownerId).toBe("agent-a");
    expect(item().nextMoveOwnerId).toBe("agent-a");
    expect(workClaimOf(item())).toMatchObject({ claimantId: "agent-a", leaseGeneration: 1 });
    expect(events.map((e) => e.kind)).toEqual(["claimed"]);
  });

  test("two concurrent claiming moves cannot both win", async () => {
    const { service, item } = await setup();
    const results = await Promise.allSettled([
      service.move({ workId: "work-1", to: "doing", actorId: "agent-a", claim: true }),
      service.move({ workId: "work-1", to: "doing", actorId: "agent-b", claim: true }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(WorkClaimConflictError);
    expect(item().ownerId).toBe("agent-a");
    expect(item().state).toBe("working");
    expect(workClaimOf(item())?.claimantId).toBe("agent-a");
  });

  test("an expired lease frees the item: the next claim wins with a new generation", async () => {
    const { service, item, clock, events } = await setup();
    await service.claim({ workId: "work-1", actorId: "agent-a", leaseMs: 60_000 });
    clock.now += 30_000;
    await conflictOf(service.claim({ workId: "work-1", actorId: "agent-b" }));

    clock.now += 31_000;
    const taken = await service.claim({ workId: "work-1", actorId: "agent-b", sessionAddress: "sess.bbbbbbbbbbbb" });
    expect(taken.claim).toMatchObject({ claimantId: "agent-b", leaseGeneration: 2 });
    expect(item().ownerId).toBe("agent-b");

    const late = await conflictOf(service.claim({ workId: "work-1", actorId: "agent-a", action: "renew", leaseGeneration: 1 }));
    expect(late.conflict.code).toBe("work_claim_held");
    expect(events.map((e) => e.kind)).toEqual(["claimed", "claimed"]);
  });

  test("anyone may release an expired claim; an active one only by its holder or the operator", async () => {
    const { service, item, clock } = await setup();
    await service.claim({ workId: "work-1", actorId: "agent-a", leaseMs: 60_000 });
    const refused = await conflictOf(service.claim({ workId: "work-1", actorId: "agent-b", action: "release" }));
    expect(refused.conflict.code).toBe("work_claim_held");
    expect((await service.claim({ workId: "work-1", actorId: "operator", action: "release" })).claim).toBeNull();
    expect(workClaimOf(item())).toBeUndefined();

    await service.claim({ workId: "work-1", actorId: "agent-a", leaseMs: 60_000 });
    clock.now += 61_000;
    const released = await service.claim({ workId: "work-1", actorId: "agent-b", action: "release" });
    expect(released.claim).toBeNull();
    expect(workClaimOf(item())).toBeUndefined();
    // Releasing again is a no-op.
    expect((await service.claim({ workId: "work-1", actorId: "agent-b", action: "release" })).claim).toBeNull();
  });

  test("the holder renews; renewal checks the session and the lease generation", async () => {
    const { service, item, clock, events } = await setup();
    const first = await service.claim({ workId: "work-1", actorId: "agent-a", sessionAddress: "sess.aaaaaaaaaaaa", leaseMs: 60_000 });
    clock.now += 50_000;
    const again = await service.claim({ workId: "work-1", actorId: "agent-a", sessionAddress: "sess.aaaaaaaaaaaa", leaseMs: 60_000 });
    expect(again.renewed).toBe(true);
    expect(again.claim!.leaseGeneration).toBe(first.claim!.leaseGeneration);
    expect(again.claim!.leaseExpiresAt).toBe(clock.now + 60_000);
    expect(events).toHaveLength(1);

    const otherSession = await conflictOf(service.claim({ workId: "work-1", actorId: "agent-a", sessionAddress: "sess.cccccccccccc" }));
    expect(otherSession.conflict.code).toBe("work_claim_held");
    const stale = await conflictOf(service.claim({ workId: "work-1", actorId: "agent-a", action: "renew", leaseGeneration: 7 }));
    expect(stale.conflict.code).toBe("work_claim_stale_generation");

    const renewed = await service.claim({ workId: "work-1", actorId: "agent-a", action: "renew", leaseGeneration: 1, leaseMs: 120_000 });
    expect(renewed.claim!.leaseExpiresAt).toBe(clock.now + 120_000);
    expect(workClaimOf(item())!.leaseExpiresAt).toBe(clock.now + 120_000);
  });

  test("expectedOwnerId makes the claim a compare-and-set on the owner", async () => {
    const { service } = await setup([workItem({ ownerId: "agent-a" })]);
    const mismatch = await conflictOf(service.claim({ workId: "work-1", actorId: "agent-b", expectedOwnerId: null }));
    expect(mismatch.conflict).toMatchObject({ code: "work_claim_owner_mismatch", ownerId: "agent-a" });
    expect((await service.claim({ workId: "work-1", actorId: "agent-b", expectedOwnerId: "agent-a" })).ownerId).toBe("agent-b");
  });

  test("finishing the item drops the claim; a closed item cannot be claimed", async () => {
    const { service, item } = await setup();
    await service.move({ workId: "work-1", to: "doing", actorId: "agent-a", claim: true });
    expect(workClaimOf(item())).toBeDefined();
    await service.move({ workId: "work-1", to: "dropped", actorId: "agent-a", note: "Not needed." });
    expect(item().state).toBe("cancelled");
    expect(workClaimOf(item())).toBeUndefined();
    const closed = await conflictOf(service.claim({ workId: "work-1", actorId: "agent-b" }));
    expect(closed.conflict.code).toBe("work_claim_closed");
  });
});

describe("whole-record writes against a claim", () => {
  const now = 2_000_000;
  const claim = { claimantId: "agent-a", leaseGeneration: 1, claimedAt: now - 1000, renewedAt: now - 1000, leaseExpiresAt: now + 60_000 };
  const claimed = workItem({ ownerId: "agent-a", metadata: { workClaim: claim } });

  test("a write built from a stale read keeps the claim", () => {
    const stale = workItem({ ownerId: "agent-a", state: "working", summary: "Progress" });
    const next = reconcileWorkClaimOnWrite(claimed, stale, now) as WorkItemRecord;
    expect(workClaimOf(next)).toEqual(claim);
    expect(next.summary).toBe("Progress");
  });

  test("a write that hands an actively claimed item to someone else is a conflict", () => {
    expect(() => reconcileWorkClaimOnWrite(claimed, workItem({ ownerId: "agent-b" }), now)).toThrow(WorkClaimConflictError);
    try {
      reconcileWorkClaimOnWrite(claimed, workItem({ ownerId: "agent-b" }), now);
    } catch (error) {
      expect((error as WorkClaimConflictError).conflict).toMatchObject({ code: "work_claim_held", holder: claim });
      expect((error as Error).message).toContain("POST /v1/work/claim");
    }
  });

  test("an expired claim gives way to a new owner, a finished item drops it, and a forged claim is dropped", () => {
    expect(workClaimOf(reconcileWorkClaimOnWrite(claimed, workItem({ ownerId: "agent-b" }), now + 61_000))).toBeUndefined();
    expect(workClaimOf(reconcileWorkClaimOnWrite(claimed, workItem({ ownerId: "agent-a", state: "done" }), now))).toBeUndefined();
    expect(workClaimOf(reconcileWorkClaimOnWrite(workItem(), workItem({ ownerId: "agent-b", metadata: { workClaim: { ...claim, claimantId: "agent-b" } } }), now))).toBeUndefined();
    const plain = workItem({ ownerId: "agent-b" });
    expect(reconcileWorkClaimOnWrite(workItem(), plain, now)).toBe(plain);
  });
});
