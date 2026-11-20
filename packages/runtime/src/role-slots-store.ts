/**
 * Role slots: one short, cited summary per role assignment. The PM's Kanban
 * summary is the first. The slot is a cache the role rewrites on each pass,
 * so it lives in its own table and is not journaled.
 *
 * Writes compare only the slot's own version: an older summary still lands
 * when the board moved during the pass, and the reader's `behind` covers that.
 */

import {
  agentMayWriteRoleSlot,
  validateRoleSlotWrite,
  type ScoutRoleSlot,
  type ScoutRoleSlotSentence,
  type ScoutRoleSlotStamp,
  type ScoutRoleSlotWriteInput,
} from "@openscout/protocol";

import { getRoleAssignment } from "./assigned-roles-store.js";
import type { ControlPlaneSqliteDatabase } from "./sqlite-adapter.js";

/** A refused slot write, with the HTTP status the runtime answers with. */
export class RoleSlotError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string, readonly currentVersion?: number) {
    super(message);
    this.name = "RoleSlotError";
  }
}

type RoleSlotRow = {
  assignment_id: string;
  role_id: string;
  version: number;
  stamp_json: string;
  sentences_json: string;
  written_by_id: string;
  written_at: number;
};

function parse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToSlot(row: RoleSlotRow): ScoutRoleSlot {
  return {
    assignmentId: row.assignment_id,
    roleId: row.role_id,
    version: row.version,
    stamp: parse<ScoutRoleSlotStamp>(row.stamp_json, {}),
    sentences: parse<ScoutRoleSlotSentence[]>(row.sentences_json, []),
    writtenById: row.written_by_id,
    writtenAt: row.written_at,
  };
}

export function readRoleSlot(db: ControlPlaneSqliteDatabase, assignmentId: string): ScoutRoleSlot | null {
  const row = db.query(`SELECT * FROM role_slots WHERE assignment_id = ?`).get(assignmentId) as RoleSlotRow | null;
  return row ? rowToSlot(row) : null;
}

/**
 * Write a slot as its holder. Refuses a writer that does not hold the
 * assignment or whose role lacks slot.write, a sentence that cites no stamped
 * card, and a version that moved since the writer read it.
 */
export function writeRoleSlot(
  db: ControlPlaneSqliteDatabase,
  input: ScoutRoleSlotWriteInput,
  now: number = Date.now(),
): ScoutRoleSlot {
  const assignment = getRoleAssignment(db, input.assignmentId);
  if (!assignment) throw new RoleSlotError(404, `unknown role assignment: ${input.assignmentId}`);
  if (!agentMayWriteRoleSlot({ agentId: input.actorId, assignment })) {
    throw new RoleSlotError(403, `agent ${input.actorId} does not hold ${input.assignmentId} with slot.write`);
  }
  const validation = validateRoleSlotWrite(input);
  if (!validation.ok) throw new RoleSlotError(400, `invalid slot: ${validation.errors.join("; ")}`);

  // One statement compares and writes, so two writers with the same version cannot both land.
  const sentences = input.sentences.map((s) => ({ text: s.text.trim(), cites: [...new Set(s.cites)] }));
  const result = (input.expectedVersion === 0
    ? db.query(
        `INSERT INTO role_slots (assignment_id, role_id, version, stamp_json, sentences_json, written_by_id, written_at)
         VALUES (?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(assignment_id) DO NOTHING`,
      ).run(assignment.id, assignment.roleId, JSON.stringify(input.stamp), JSON.stringify(sentences), input.actorId, now)
    : db.query(
        `UPDATE role_slots
         SET version = version + 1, stamp_json = ?, sentences_json = ?, written_by_id = ?, written_at = ?
         WHERE assignment_id = ? AND version = ?`,
      ).run(JSON.stringify(input.stamp), JSON.stringify(sentences), input.actorId, now, assignment.id, input.expectedVersion)) as { changes?: number | bigint };
  const changes = Number(result.changes ?? 0);

  const slot = readRoleSlot(db, assignment.id);
  if (!changes || !slot) {
    const current = slot?.version ?? 0;
    throw new RoleSlotError(409, `slot ${assignment.id} is at version ${current}, not ${input.expectedVersion}. Read it again.`, current);
  }
  return slot;
}
