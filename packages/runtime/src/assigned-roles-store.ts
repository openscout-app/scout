/**
 * Persistence for assigned roles + mission log entries.
 *
 * Tables live on the control-plane SQLite DB (role_assignments, mission_log_entries).
 * Canonical writer: the broker (HTTP /v1/roles*, lifecycle). Web proxies to broker;
 * do not CREATE TABLE from web. See docs/proposals/assigned-roles-and-mission-log.md
 */

import { createHash, randomBytes } from "node:crypto";

import {
  SCOUT_MISSION_LOG_APPEND,
  SCOUT_ORCHESTRATOR_ROLE_ID,
  agentMayWriteMissionLog,
  scoutRoleDefinition,
  validateMissionLogEntryFields,
  type ScoutMissionLogAppendInput,
  type ScoutMissionLogEntry,
  type ScoutMissionLogKind,
  type ScoutRoleAssignment,
  type ScoutRoleAssignmentScope,
  type ScoutRoleId,
} from "@openscout/protocol";

import type { ControlPlaneSqliteDatabase } from "./sqlite-adapter.js";

function runInTransaction<T>(db: ControlPlaneSqliteDatabase, work: () => T): T {
  const anyDb = db as {
    transaction?: <R>(fn: () => R) => () => R;
    exec: (sql: string) => unknown;
  };
  if (typeof anyDb.transaction === "function") {
    return anyDb.transaction(work)();
  }
  anyDb.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    anyDb.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      anyDb.exec("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    throw error;
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message);
}

export type AssignRoleInput = {
  roleId: ScoutRoleId | string;
  agentId: string;
  scope: ScoutRoleAssignmentScope;
  assignedById: string;
  /**
   * Default true: refuse a second active holder where the role's definition
   * names this scope kind in singleHolder (orchestrator: one per mission;
   * pm: one in all). False allows several.
   */
  enforceSingleHolder?: boolean;
  /** Older name for enforceSingleHolder, still read when that is absent. */
  enforceSingleOrchestrator?: boolean;
  metadata?: Record<string, unknown>;
  id?: string;
  assignedAt?: number;
};

export type RevokeRoleInput = {
  assignmentId: string;
  revokedById: string;
  revokedAt?: number;
};

export type ListRoleAssignmentsOpts = {
  agentId?: string;
  missionId?: string;
  roleId?: string;
  activeOnly?: boolean;
  includeStanding?: boolean;
  limit?: number;
};

export type ListMissionLogOpts = {
  missionId: string;
  limit?: number;
  afterSeq?: number;
};

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function scopeColumns(scope: ScoutRoleAssignmentScope): {
  scopeKind: string;
  missionId: string | null;
  projectRoot: string | null;
} {
  switch (scope.kind) {
    case "mission":
      return { scopeKind: "mission", missionId: scope.missionId, projectRoot: null };
    case "agent":
      return { scopeKind: "agent", missionId: null, projectRoot: null };
    case "project":
      return { scopeKind: "project", missionId: null, projectRoot: scope.projectRoot };
  }
}

function rowToAssignment(row: {
  id: string;
  role_id: string;
  agent_id: string;
  scope_kind: string;
  mission_id: string | null;
  project_root: string | null;
  assigned_by_id: string;
  assigned_at: number;
  active: number;
  revoked_at: number | null;
  revoked_by_id: string | null;
  metadata_json: string | null;
}): ScoutRoleAssignment {
  let scope: ScoutRoleAssignmentScope;
  if (row.scope_kind === "mission" && row.mission_id) {
    scope = { kind: "mission", missionId: row.mission_id };
  } else if (row.scope_kind === "project" && row.project_root) {
    scope = { kind: "project", projectRoot: row.project_root };
  } else {
    scope = { kind: "agent" };
  }

  return {
    id: row.id,
    roleId: row.role_id,
    agentId: row.agent_id,
    scope,
    assignedById: row.assigned_by_id,
    assignedAt: row.assigned_at,
    active: row.active === 1,
    ...(row.revoked_at != null ? { revokedAt: row.revoked_at } : {}),
    ...(row.revoked_by_id ? { revokedById: row.revoked_by_id } : {}),
    ...(row.metadata_json
      ? { metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}) }
      : {}),
  };
}

function rowToMissionLogEntry(row: {
  id: string;
  mission_id: string;
  node_id: string | null;
  at: number;
  seq: number;
  actor_id: string;
  kind: string;
  intent: string;
  status: string;
  checkpoint: string | null;
  blockers_json: string | null;
  refs_json: string | null;
  note: string | null;
  metadata_json: string | null;
}): ScoutMissionLogEntry {
  return {
    id: row.id,
    missionId: row.mission_id,
    ...(row.node_id ? { nodeId: row.node_id } : {}),
    at: row.at,
    seq: row.seq,
    actorId: row.actor_id,
    kind: row.kind as ScoutMissionLogKind,
    intent: row.intent,
    status: row.status,
    ...(row.checkpoint ? { checkpoint: row.checkpoint } : {}),
    ...(row.blockers_json
      ? { blockers: parseJson(row.blockers_json, []) }
      : {}),
    ...(row.refs_json ? { refs: parseJson(row.refs_json, {}) } : {}),
    ...(row.note ? { note: row.note } : {}),
    ...(row.metadata_json
      ? { metadata: parseJson(row.metadata_json, {}) }
      : {}),
  };
}

export function listRoleAssignments(
  db: ControlPlaneSqliteDatabase,
  opts: ListRoleAssignmentsOpts = {},
): ScoutRoleAssignment[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const activeOnly = opts.activeOnly ?? true;
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (activeOnly) {
    clauses.push("active = 1");
  }
  if (opts.agentId) {
    clauses.push("agent_id = ?");
    params.push(opts.agentId);
  }
  if (opts.roleId) {
    clauses.push("role_id = ?");
    params.push(opts.roleId);
  }
  if (opts.missionId) {
    if (opts.includeStanding ?? true) {
      clauses.push("(mission_id = ? OR scope_kind = 'agent')");
      params.push(opts.missionId);
    } else {
      clauses.push("mission_id = ?");
      params.push(opts.missionId);
    }
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .query(
      `SELECT * FROM role_assignments
       ${where}
       ORDER BY assigned_at DESC
       LIMIT ?`,
    )
    .all(...params, limit) as Array<Parameters<typeof rowToAssignment>[0]>;

  return rows.map(rowToAssignment);
}

export function getRoleAssignment(
  db: ControlPlaneSqliteDatabase,
  assignmentId: string,
): ScoutRoleAssignment | null {
  const row = db
    .query(`SELECT * FROM role_assignments WHERE id = ?`)
    .get(assignmentId) as Parameters<typeof rowToAssignment>[0] | null;
  return row ? rowToAssignment(row) : null;
}

export function assignRole(
  db: ControlPlaneSqliteDatabase,
  input: AssignRoleInput,
): ScoutRoleAssignment {
  const definition = scoutRoleDefinition(input.roleId);
  if (!definition) {
    throw new Error(`unknown role id: ${input.roleId}`);
  }

  return runInTransaction(db, () => {
    const now = input.assignedAt ?? Date.now();
    const scope = scopeColumns(input.scope);
    const enforceSingle = input.enforceSingleHolder ?? input.enforceSingleOrchestrator ?? true;

    if (enforceSingle && definition.singleHolder?.includes(input.scope.kind)) {
      const holders = (db
        .query(
          `SELECT DISTINCT agent_id FROM role_assignments
           WHERE active = 1 AND role_id = ? AND scope_kind = ?
             AND IFNULL(mission_id, '') = IFNULL(?, '')
             AND IFNULL(project_root, '') = IFNULL(?, '')
             AND agent_id != ?`,
        )
        .all(input.roleId, scope.scopeKind, scope.missionId, scope.projectRoot, input.agentId) as Array<{ agent_id: string }>)
        .map((row) => row.agent_id);

      if (holders.length > 0) {
        const where = input.scope.kind === "mission"
          ? `mission ${input.scope.missionId}`
          : input.scope.kind === "project" ? `project ${input.scope.projectRoot}` : "this runtime";
        throw new Error(
          `${where} already has ${definition.id}(s): ${holders.join(", ")}. Revoke first or pass enforceSingleHolder: false.`,
        );
      }
    }

    // Re-activate matching inactive assignment if present.
    const existing = db
      .query(
        `SELECT * FROM role_assignments
         WHERE role_id = ? AND agent_id = ? AND scope_kind = ?
           AND IFNULL(mission_id, '') = IFNULL(?, '')
           AND IFNULL(project_root, '') = IFNULL(?, '')
         ORDER BY assigned_at DESC
         LIMIT 1`,
      )
      .get(
        input.roleId,
        input.agentId,
        scope.scopeKind,
        scope.missionId,
        scope.projectRoot,
      ) as Parameters<typeof rowToAssignment>[0] | null;

    if (existing) {
      db.query(
        `UPDATE role_assignments
         SET active = 1,
             assigned_by_id = ?,
             assigned_at = ?,
             revoked_at = NULL,
             revoked_by_id = NULL,
             metadata_json = ?,
             updated_at = ?
         WHERE id = ?`,
      ).run(
        input.assignedById,
        now,
        input.metadata ? JSON.stringify(input.metadata) : existing.metadata_json,
        now,
        existing.id,
      );
      return getRoleAssignment(db, existing.id)!;
    }

    const id = input.id ?? createId("role");
    try {
      db.query(
        `INSERT INTO role_assignments (
           id, role_id, agent_id, scope_kind, mission_id, project_root,
           assigned_by_id, assigned_at, active, revoked_at, revoked_by_id,
           metadata_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?, ?, ?)`,
      ).run(
        id,
        input.roleId,
        input.agentId,
        scope.scopeKind,
        scope.missionId,
        scope.projectRoot,
        input.assignedById,
        now,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
        now,
      );
    } catch (error) {
      if (
        isUniqueConstraintError(error)
        && input.roleId === SCOUT_ORCHESTRATOR_ROLE_ID
        && input.scope.kind === "mission"
      ) {
        throw new Error(
          `mission ${input.scope.missionId} already has an active orchestrator. Revoke first or pass enforceSingleOrchestrator: false.`,
        );
      }
      throw error;
    }

    return getRoleAssignment(db, id)!;
  });
}

export function revokeRole(
  db: ControlPlaneSqliteDatabase,
  input: RevokeRoleInput,
): ScoutRoleAssignment {
  const existing = getRoleAssignment(db, input.assignmentId);
  if (!existing) {
    throw new Error(`unknown role assignment: ${input.assignmentId}`);
  }
  if (!existing.active) {
    return existing;
  }

  const now = input.revokedAt ?? Date.now();
  db.query(
    `UPDATE role_assignments
     SET active = 0, revoked_at = ?, revoked_by_id = ?, updated_at = ?
     WHERE id = ?`,
  ).run(now, input.revokedById, now, input.assignmentId);

  return getRoleAssignment(db, input.assignmentId)!;
}

export function listMissionLogEntries(
  db: ControlPlaneSqliteDatabase,
  opts: ListMissionLogOpts,
): ScoutMissionLogEntry[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  if (opts.afterSeq != null) {
    const rows = db
      .query(
        `SELECT * FROM mission_log_entries
         WHERE mission_id = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(opts.missionId, opts.afterSeq, limit) as Array<
        Parameters<typeof rowToMissionLogEntry>[0]
      >;
    return rows.map(rowToMissionLogEntry);
  }

  const rows = db
    .query(
      `SELECT * FROM mission_log_entries
       WHERE mission_id = ?
       ORDER BY seq DESC
       LIMIT ?`,
    )
    .all(opts.missionId, limit) as Array<Parameters<typeof rowToMissionLogEntry>[0]>;

  return rows.map(rowToMissionLogEntry).reverse();
}

export function appendMissionLogEntry(
  db: ControlPlaneSqliteDatabase,
  input: ScoutMissionLogAppendInput,
  opts?: {
    /**
     * Skip assignment gate. Broker lifecycle only — never expose as a client
     * request field.
     */
    bypassPermission?: boolean;
    assignments?: ScoutRoleAssignment[];
    projectRoot?: string;
  },
): ScoutMissionLogEntry {
  const validation = validateMissionLogEntryFields(input);
  if (!validation.ok) {
    throw new Error(`invalid mission log entry: ${validation.errors.join("; ")}`);
  }

  if (!opts?.bypassPermission) {
    // Load all active assignments for the actor; scope matching (mission /
    // standing agent / project) happens in agentMayWriteMissionLog via
    // assignmentAppliesTo. Filtering by missionId here would drop project-scoped
    // orchestrators that should still be able to write when projectRoot matches.
    const assignments =
      opts?.assignments
      ?? listRoleAssignments(db, {
        agentId: input.actorId,
        activeOnly: true,
        limit: 100,
      });
    const allowed = agentMayWriteMissionLog({
      agentId: input.actorId,
      missionId: input.missionId,
      assignments,
      projectRoot: opts?.projectRoot,
    });
    if (!allowed) {
      throw new Error(
        `agent ${input.actorId} is not an assigned mission-log writer for mission ${input.missionId}`,
      );
    }
    const definitionActions = assignments
      .filter((a) => a.active && a.agentId === input.actorId)
      .map((a) => scoutRoleDefinition(a.roleId))
      .filter(Boolean);
    const hasAction = definitionActions.some((d) =>
      d!.actions.includes(SCOUT_MISSION_LOG_APPEND),
    );
    if (!hasAction) {
      throw new Error(
        `agent ${input.actorId} role does not include ${SCOUT_MISSION_LOG_APPEND}`,
      );
    }
  }

  const at = input.at ?? Date.now();
  const maxAttempts = 8;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const id = input.id && attempt === 0 ? input.id : createId("mlog");
    try {
      return runInTransaction(db, () => {
        const maxSeqRow = db
          .query(
            `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM mission_log_entries WHERE mission_id = ?`,
          )
          .get(input.missionId) as { max_seq: number };
        const seq = input.seq ?? maxSeqRow.max_seq + 1;

        db.query(
          `INSERT INTO mission_log_entries (
             id, mission_id, node_id, at, seq, actor_id, kind, intent, status,
             checkpoint, blockers_json, refs_json, note, metadata_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          input.missionId,
          input.nodeId ?? null,
          at,
          seq,
          input.actorId,
          input.kind,
          input.intent.trim(),
          input.status.trim(),
          input.checkpoint?.trim() || null,
          input.blockers ? JSON.stringify(input.blockers) : null,
          input.refs ? JSON.stringify(input.refs) : null,
          input.note?.trim() || null,
          input.metadata ? JSON.stringify(input.metadata) : null,
        );

        const row = db
          .query(`SELECT * FROM mission_log_entries WHERE id = ?`)
          .get(id) as Parameters<typeof rowToMissionLogEntry>[0];

        return rowToMissionLogEntry(row);
      });
    } catch (error) {
      if (isUniqueConstraintError(error) && input.seq == null && attempt < maxAttempts - 1) {
        continue;
      }
      throw error;
    }
  }

  throw new Error(`failed to allocate mission log seq for ${input.missionId}`);
}

/** Stable fingerprint for cache/ETag of a mission log tail. */
export function missionLogFingerprint(entries: ScoutMissionLogEntry[]): string {
  const payload = entries
    .map((e) => `${e.seq}:${e.kind}:${e.status}`)
    .join("|");
  return createHash("sha1").update(payload).digest("hex").slice(0, 12);
}
