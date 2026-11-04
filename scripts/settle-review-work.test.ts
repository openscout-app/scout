import { describe, expect, test } from "bun:test";
import type { CollaborationRecord } from "../packages/protocol/src/index.ts";
import { settleCandidates } from "./settle-review-work.ts";

const DAY = 86_400_000;
const now = 100 * DAY;

function work(id: string, patch: Partial<CollaborationRecord>): CollaborationRecord {
  return {
    id,
    kind: "work_item",
    state: "review",
    acceptanceState: "pending",
    title: id,
    createdById: "operator",
    requestedById: "operator",
    ownerId: "agent-1",
    nextMoveOwnerId: "operator",
    createdAt: 1,
    updatedAt: now - 30 * DAY,
    ...patch,
  } as CollaborationRecord;
}

describe("settleCandidates", () => {
  test("picks stale review items waiting on the operator, oldest first", () => {
    const records = [
      work("stale-2", { updatedAt: now - 10 * DAY }),
      work("stale-1", { updatedAt: now - 40 * DAY }),
      work("recent", { updatedAt: now - 2 * DAY }),
      work("agent-review", { nextMoveOwnerId: "agent-2" }),
      work("accepted", { acceptanceState: "accepted" }),
      work("working", { state: "working" }),
      { ...work("question", {}), kind: "question" } as CollaborationRecord,
    ];

    expect(settleCandidates(records, { waitingOn: "operator", olderThanDays: 7, now }).map((record) => record.id))
      .toEqual(["stale-1", "stale-2"]);
    expect(settleCandidates(records, { waitingOn: "operator", olderThanDays: 0, now }).map((record) => record.id))
      .toEqual(["stale-1", "stale-2", "recent"]);
  });
});
