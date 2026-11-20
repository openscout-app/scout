import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { SCOUT_ORCHESTRATOR_ROLE_ID, SCOUT_PM_ROLE_ID } from "@openscout/protocol";

import { assignRole, revokeRole } from "./assigned-roles-store.js";
import { brokerReadRoleSlots, roleSlotBoardCards } from "./broker-roles-http.js";
import { migrateControlPlaneDatabaseSchema } from "./control-plane-migrations.js";
import { readRoleSlot, RoleSlotError, writeRoleSlot } from "./role-slots-store.js";
import type { ControlPlaneSqliteDatabase } from "./sqlite-adapter.js";

function openTestDb(): ControlPlaneSqliteDatabase {
  const db = new Database(":memory:");
  migrateControlPlaneDatabaseSchema(db as unknown as ControlPlaneSqliteDatabase);
  return db as unknown as ControlPlaneSqliteDatabase;
}

function assignPm(db: ControlPlaneSqliteDatabase, agentId = "pm-1") {
  return assignRole(db, { roleId: SCOUT_PM_ROLE_ID, agentId, scope: { kind: "agent" }, assignedById: "operator" });
}

const STAMP = { "work-a": 3, "work-b": 1 };
const SENTENCES = [{ text: "Two runs failed overnight and wait on a retry.", cites: ["work-a", "work-b"] }];

function refusal(write: () => unknown): RoleSlotError {
  try {
    write();
  } catch (error) {
    if (error instanceof RoleSlotError) return error;
    throw error;
  }
  throw new Error("expected the write to be refused");
}

describe("role slots", () => {
  test("the holder writes version 1, then each write bumps the version it read", () => {
    const db = openTestDb();
    const pm = assignPm(db);
    expect(readRoleSlot(db, pm.id)).toBeNull();

    const first = writeRoleSlot(db, { assignmentId: pm.id, actorId: "pm-1", expectedVersion: 0, stamp: STAMP, sentences: SENTENCES }, 1000);
    expect(first).toEqual({
      assignmentId: pm.id, roleId: "pm", version: 1, stamp: STAMP, sentences: SENTENCES, writtenById: "pm-1", writtenAt: 1000,
    });

    const second = writeRoleSlot(db, {
      assignmentId: pm.id, actorId: "pm-1", expectedVersion: 1, stamp: { "work-a": 4 },
      sentences: [{ text: "  The retry landed.  ", cites: ["work-a", "work-a"] }],
    }, 2000);
    expect(second.version).toBe(2);
    expect(second.sentences).toEqual([{ text: "The retry landed.", cites: ["work-a"] }]);
    expect(readRoleSlot(db, pm.id)).toEqual(second);
  });

  test("a write on a version that moved is refused with the current version", () => {
    const db = openTestDb();
    const pm = assignPm(db);
    writeRoleSlot(db, { assignmentId: pm.id, actorId: "pm-1", expectedVersion: 0, stamp: STAMP, sentences: SENTENCES });

    const again = refusal(() => writeRoleSlot(db, { assignmentId: pm.id, actorId: "pm-1", expectedVersion: 0, stamp: STAMP, sentences: SENTENCES }));
    expect(again.status).toBe(409);
    expect(again.currentVersion).toBe(1);

    writeRoleSlot(db, { assignmentId: pm.id, actorId: "pm-1", expectedVersion: 1, stamp: STAMP, sentences: SENTENCES });
    const stale = refusal(() => writeRoleSlot(db, { assignmentId: pm.id, actorId: "pm-1", expectedVersion: 1, stamp: STAMP, sentences: SENTENCES }));
    expect(stale.status).toBe(409);
    expect(stale.currentVersion).toBe(2);
    expect(readRoleSlot(db, pm.id)?.version).toBe(2);
  });

  test("only the active holder of a role with slot.write may write", () => {
    const db = openTestDb();
    const pm = assignPm(db);
    const write = (assignmentId: string, actorId: string) =>
      refusal(() => writeRoleSlot(db, { assignmentId, actorId, expectedVersion: 0, stamp: STAMP, sentences: SENTENCES }));

    expect(write(pm.id, "someone-else").status).toBe(403);
    expect(write("role-missing", "pm-1").status).toBe(404);

    const orchestrator = assignRole(db, { roleId: SCOUT_ORCHESTRATOR_ROLE_ID, agentId: "orch-1", scope: { kind: "mission", missionId: "work-1" }, assignedById: "operator" });
    expect(write(orchestrator.id, "orch-1").status).toBe(403);

    revokeRole(db, { assignmentId: pm.id, revokedById: "operator" });
    expect(write(pm.id, "pm-1").status).toBe(403);
    expect(readRoleSlot(db, pm.id)).toBeNull();
  });

  test("every sentence cites at least one stamped card", () => {
    const db = openTestDb();
    const pm = assignPm(db);
    const write = (sentences: Array<{ text: string; cites: string[] }>) =>
      refusal(() => writeRoleSlot(db, { assignmentId: pm.id, actorId: "pm-1", expectedVersion: 0, stamp: STAMP, sentences }));

    const uncited = write([{ text: "Things are moving.", cites: [] }]);
    expect(uncited.status).toBe(400);
    expect(uncited.message).toContain("sentence 1 cites no card");
    expect(write([{ text: "A card nobody read.", cites: ["work-z"] }]).message).toContain("outside the stamp: work-z");
    expect(write([{ text: " ", cites: ["work-a"] }]).message).toContain("sentence 1 is empty");
    expect(readRoleSlot(db, pm.id)).toBeNull();

    // An empty board says nothing, and that is a valid slot.
    expect(writeRoleSlot(db, { assignmentId: pm.id, actorId: "pm-1", expectedVersion: 0, stamp: {}, sentences: [] }).version).toBe(1);
  });

  test("one agent holds the PM role; the assigner can opt out", () => {
    const db = openTestDb();
    assignPm(db, "pm-1");
    expect(() => assignPm(db, "pm-2")).toThrow(/this runtime already has pm\(s\): pm-1/);
    // Re-assigning the same holder is not a second holder.
    expect(assignPm(db, "pm-1").active).toBe(true);
    expect(assignRole(db, {
      roleId: SCOUT_PM_ROLE_ID, agentId: "pm-2", scope: { kind: "agent" }, assignedById: "operator", enforceSingleHolder: false,
    }).active).toBe(true);
  });

  test("standing orchestrators stay unlimited; one per mission still holds", () => {
    const db = openTestDb();
    const standing = (agentId: string) => assignRole(db, { roleId: SCOUT_ORCHESTRATOR_ROLE_ID, agentId, scope: { kind: "agent" }, assignedById: "operator" });
    standing("orch-1");
    expect(standing("orch-2").active).toBe(true);
    assignRole(db, { roleId: SCOUT_ORCHESTRATOR_ROLE_ID, agentId: "orch-1", scope: { kind: "mission", missionId: "work-1" }, assignedById: "operator" });
    expect(() => assignRole(db, { roleId: SCOUT_ORCHESTRATOR_ROLE_ID, agentId: "orch-2", scope: { kind: "mission", missionId: "work-1" }, assignedById: "operator" }))
      .toThrow(/already has orchestrator/);
  });

  test("the slot read says whether the board moved since the stamp", () => {
    const db = openTestDb();
    const pm = assignPm(db);
    const stations = [{ id: "doing", state: "working" }, { id: "done", state: "done" }];
    const work = (items: Array<{ workId: string; station: string; revision: number }>) =>
      ({ board: () => ({ lifecycle: { lifecycle: { stations } }, items }) });

    const board = [{ workId: "work-a", station: "doing", revision: 3 }, { workId: "work-b", station: "doing", revision: 1 }];
    expect(brokerReadRoleSlots(db, "pm", roleSlotBoardCards(work(board))).slots).toEqual([{ assignment: pm, slot: null, behind: true }]);

    writeRoleSlot(db, { assignmentId: pm.id, actorId: "pm-1", expectedVersion: 0, stamp: STAMP, sentences: SENTENCES });
    const read = (items: typeof board) => brokerReadRoleSlots(db, "pm", roleSlotBoardCards(work(items))).slots[0]!.behind;
    expect(read(board)).toBe(false);
    expect(read([board[0]!, { workId: "work-b", station: "done", revision: 2 }])).toBe(true);
    expect(read([...board, { workId: "work-c", station: "doing", revision: 1 }])).toBe(true);
    expect(read([...board, { workId: "work-old", station: "done", revision: 9 }])).toBe(false);
    expect(brokerReadRoleSlots(db, "pm", roleSlotBoardCards(undefined)).slots[0]!.behind).toBeNull();
  });
});
