/**
 * Broker HTTP handlers for assigned roles + mission log.
 * Canonical writer path — web proxies here; does not create schema (migrations own DDL).
 */

import { SCOUT_ROLE_CATALOG, roleSlotBehind } from "@openscout/protocol";
import type { ScoutMissionLogAppendInput, ScoutRoleSlotWriteInput } from "@openscout/protocol";

import {
  appendMissionLogEntry,
  assignRole,
  listMissionLogEntries,
  listRoleAssignments,
  revokeRole,
  type AssignRoleInput,
  type ListMissionLogOpts,
  type ListRoleAssignmentsOpts,
  type RevokeRoleInput,
} from "./assigned-roles-store.js";
import { readRoleSlot, writeRoleSlot } from "./role-slots-store.js";
import type { ControlPlaneSqliteDatabase } from "./sqlite-adapter.js";

export type BrokerRolesDb = ControlPlaneSqliteDatabase;

export function brokerRolesCatalog() {
  return { roles: SCOUT_ROLE_CATALOG };
}

export function brokerListRoleAssignments(
  db: BrokerRolesDb,
  opts: ListRoleAssignmentsOpts = {},
) {
  return { assignments: listRoleAssignments(db, opts) };
}

export function brokerAssignRole(db: BrokerRolesDb, input: AssignRoleInput) {
  return { assignment: assignRole(db, input) };
}

export function brokerRevokeRole(db: BrokerRolesDb, input: RevokeRoleInput) {
  return { assignment: revokeRole(db, input) };
}

export function brokerListMissionLog(db: BrokerRolesDb, opts: ListMissionLogOpts) {
  return {
    missionId: opts.missionId,
    entries: listMissionLogEntries(db, opts),
  };
}

export function brokerAppendMissionLog(
  db: BrokerRolesDb,
  input: ScoutMissionLogAppendInput,
  opts?: { projectRoot?: string },
) {
  // Never accept client bypass — permission gate always enforced here.
  return {
    entry: appendMissionLogEntry(db, input, {
      projectRoot: opts?.projectRoot,
    }),
  };
}

/**
 * The default lifecycle's board as `behind` reads it. Null without a work
 * service. Open means the card's station is not done or cancelled.
 */
export function roleSlotBoardCards(work: {
  board(query: { lifecycleId?: string; closedSince?: number; limit?: number }): {
    lifecycle: { lifecycle: { stations: ReadonlyArray<{ id: string; state: string }> } };
    items: ReadonlyArray<{ workId: string; station: string; revision: number }>;
  };
} | undefined): RoleSlotBoardCard[] | null {
  if (!work) return null;
  const board = work.board({ limit: 2000 });
  const settled = new Set(board.lifecycle.lifecycle.stations.filter((s) => s.state === "done" || s.state === "cancelled").map((s) => s.id));
  return board.items.map((item) => ({ workId: item.workId, revision: item.revision, open: !settled.has(item.station) }));
}

/** A board card as the slot's `behind` needs it: its revision, and whether its station is still open. */
export type RoleSlotBoardCard = { workId: string; revision: number; open: boolean };

/**
 * Each active holder of a role with its slot and whether the board moved
 * since that slot was written. `behind` is null when the board is not readable.
 * A read never starts a pass.
 */
export function brokerReadRoleSlots(db: BrokerRolesDb, roleId: string, boardCards: RoleSlotBoardCard[] | null) {
  return {
    slots: listRoleAssignments(db, { roleId, activeOnly: true }).map((assignment) => {
      const slot = readRoleSlot(db, assignment.id);
      return { assignment, slot, behind: boardCards ? roleSlotBehind(slot?.stamp, boardCards) : null };
    }),
  };
}

export function brokerWriteRoleSlot(db: BrokerRolesDb, input: ScoutRoleSlotWriteInput) {
  return { slot: writeRoleSlot(db, input) };
}

export function parseRoleScope(body: {
  kind?: string;
  missionId?: string;
  projectRoot?: string;
}): AssignRoleInput["scope"] {
  const kind = (body.kind ?? "agent").trim();
  if (kind === "mission") {
    const missionId = body.missionId?.trim();
    if (!missionId) throw new Error("scope.missionId is required for mission scope");
    return { kind: "mission", missionId };
  }
  if (kind === "project") {
    const projectRoot = body.projectRoot?.trim();
    if (!projectRoot) throw new Error("scope.projectRoot is required for project scope");
    return { kind: "project", projectRoot };
  }
  if (kind === "agent") {
    return { kind: "agent" };
  }
  throw new Error(`unknown scope.kind: ${kind}`);
}
