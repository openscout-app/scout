import type { ControlPlaneSqliteTransactionalDatabase } from "../sqlite-adapter.js";

export type BoardCustodyState = "claiming" | "claim_unknown" | "held" | "settling" | "settled" | "lost";
export type BoardSettleOutcome = "completed" | "failed" | "released";

export interface BoardCustodyRow {
  connectionId: string;
  taskId: string;
  attemptId: string;
  epoch: number | null;
  /** Raw: the runtime presents it to Board. Never in status, logs or records. */
  token: string | null;
  until: number | null;
  leaseSeconds: number;
  agentId: string;
  workId: string;
  startedBy: string;
  flightId: string | null;
  state: BoardCustodyState;
  outcome: BoardSettleOutcome | null;
  /** The agent's result, kept from the first settle attempt so a retry or a re-claim sends the same one. */
  result: string | null;
  detail: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface BoardOutboxRow {
  connectionId: string;
  clientId: string;
  lane: string;
  kind: "post" | "plan";
  request: unknown;
  state: "pending" | "unknown" | "done" | "failed";
  attempts: number;
  response: unknown;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

type CustodySql = {
  connection_id: string; task_id: string; attempt_id: string; epoch: number | null; token: string | null; until: number | null;
  lease_seconds: number; agent_id: string; work_id: string; started_by: string; flight_id: string | null; state: BoardCustodyState;
  outcome: BoardSettleOutcome | null; result: string | null; detail: string | null; created_at: number; updated_at: number;
};
type OutboxSql = {
  connection_id: string; client_id: string; lane: string; kind: "post" | "plan"; request: string; state: BoardOutboxRow["state"];
  attempts: number; response: string | null; error: string | null; created_at: number; updated_at: number;
};

const custody = (row: CustodySql): BoardCustodyRow => ({
  connectionId: row.connection_id, taskId: row.task_id, attemptId: row.attempt_id, epoch: row.epoch, token: row.token, until: row.until,
  leaseSeconds: row.lease_seconds, agentId: row.agent_id, workId: row.work_id, startedBy: row.started_by, flightId: row.flight_id,
  state: row.state, outcome: row.outcome, result: row.result, detail: row.detail, createdAt: row.created_at, updatedAt: row.updated_at,
});
const outbox = (row: OutboxSql): BoardOutboxRow => ({
  connectionId: row.connection_id, clientId: row.client_id, lane: row.lane, kind: row.kind, request: JSON.parse(row.request),
  state: row.state, attempts: row.attempts, response: row.response ? JSON.parse(row.response) : null, error: row.error,
  createdAt: row.created_at, updatedAt: row.updated_at,
});

/** A batch commit lost the compare-and-set: another follower moved the cursor. */
export class BoardCursorConflictError extends Error {
  constructor(readonly connectionId: string, readonly channel: string) {
    super(`board_cursor_conflict: the cursor for ${channel} moved under this follower`);
    this.name = "BoardCursorConflictError";
  }
}

const ACTIVE_CUSTODY: BoardCustodyState[] = ["claiming", "claim_unknown", "held", "settling"];

export class BoardStore {
  constructor(private readonly database: ControlPlaneSqliteTransactionalDatabase, private readonly now = Date.now) {}

  cursor(connectionId: string, channel: string): { cursor: string; updatedAt: number } | null {
    const row = this.database.query<{ cursor: string; updated_at: number }>(
      "SELECT cursor, updated_at FROM board_cursors WHERE connection_id = ?1 AND channel = ?2").get(connectionId, channel);
    return row ? { cursor: row.cursor, updatedAt: row.updated_at } : null;
  }

  version(connectionId: string, rootId: string): number | null {
    const row = this.database.query<{ version: number }>("SELECT version FROM board_versions WHERE connection_id = ?1 AND root_id = ?2").get(connectionId, rootId);
    return row ? row.version : null;
  }

  /**
   * Commit a batch: compare-and-set the cursor from `from` to `to`, and raise
   * each task root's version. Work items are written before this, and those
   * writes are idempotent, so a lost commit replays safely.
   */
  commitBatch(input: { connectionId: string; channel: string; from: string | null; to: string; versions: Map<string, number> }): void {
    this.database.transaction(() => {
      const current = this.cursor(input.connectionId, input.channel)?.cursor ?? null;
      if (current !== input.from) throw new BoardCursorConflictError(input.connectionId, input.channel);
      const at = this.now();
      this.database.query(`INSERT INTO board_cursors (connection_id, channel, cursor, updated_at) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT (connection_id, channel) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`).run(input.connectionId, input.channel, input.to, at);
      this.raiseVersions(input.connectionId, input.versions, at);
    })();
  }

  /** Versions only grow. A lower or equal version is ignored. */
  raiseVersions(connectionId: string, versions: Map<string, number>, at = this.now()): void {
    const statement = this.database.query(`INSERT INTO board_versions (connection_id, root_id, version, updated_at) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT (connection_id, root_id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at WHERE excluded.version > board_versions.version`);
    for (const [rootId, version] of versions) statement.run(connectionId, rootId, version, at);
  }

  /** Drop a channel's cursor so the next read reconciles and then follows from the head. */
  dropCursor(connectionId: string, channel: string): void {
    this.database.query("DELETE FROM board_cursors WHERE connection_id = ?1 AND channel = ?2").run(connectionId, channel);
  }

  insertCustody(row: Omit<BoardCustodyRow, "createdAt" | "updatedAt">): void {
    const at = this.now();
    this.database.query(`INSERT INTO board_custody (connection_id, task_id, attempt_id, epoch, token, until, lease_seconds, agent_id, work_id, started_by, flight_id, state, outcome, result, detail, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)`).run(
      row.connectionId, row.taskId, row.attemptId, row.epoch, row.token, row.until, row.leaseSeconds, row.agentId, row.workId,
      row.startedBy, row.flightId, row.state, row.outcome, row.result, row.detail, at);
  }

  updateCustody(connectionId: string, attemptId: string, patch: Partial<Pick<BoardCustodyRow, "epoch" | "token" | "until" | "leaseSeconds" | "flightId" | "state" | "outcome" | "result" | "detail">>): void {
    const columns: Record<string, string> = { epoch: "epoch", token: "token", until: "until", leaseSeconds: "lease_seconds", flightId: "flight_id", state: "state", outcome: "outcome", result: "result", detail: "detail" };
    const keys = Object.keys(patch).filter(key => key in columns) as (keyof typeof patch)[];
    if (!keys.length) return;
    const sets = keys.map((key, index) => `${columns[key]} = ?${index + 3}`).join(", ");
    this.database.query(`UPDATE board_custody SET ${sets}, updated_at = ?${keys.length + 3} WHERE connection_id = ?1 AND attempt_id = ?2`)
      .run(connectionId, attemptId, ...keys.map(key => patch[key] ?? null), this.now());
  }

  custody(connectionId: string, attemptId: string): BoardCustodyRow | null {
    const row = this.database.query<CustodySql>("SELECT * FROM board_custody WHERE connection_id = ?1 AND attempt_id = ?2").get(connectionId, attemptId);
    return row ? custody(row) : null;
  }

  /** The newest attempt on a task, settled or not. */
  latestCustody(connectionId: string, taskId: string): BoardCustodyRow | null {
    const row = this.database.query<CustodySql>("SELECT * FROM board_custody WHERE connection_id = ?1 AND task_id = ?2 ORDER BY created_at DESC, rowid DESC LIMIT 1").get(connectionId, taskId);
    return row ? custody(row) : null;
  }

  /** The custody row for exactly this epoch: how a replayed `task.completed` is matched to Scout's claim. */
  custodyForEpoch(connectionId: string, taskId: string, epoch: number): BoardCustodyRow | null {
    const row = this.database.query<CustodySql>("SELECT * FROM board_custody WHERE connection_id = ?1 AND task_id = ?2 AND epoch = ?3").get(connectionId, taskId, epoch);
    return row ? custody(row) : null;
  }

  activeCustody(connectionId: string): BoardCustodyRow[] {
    return this.database.query<CustodySql>(`SELECT * FROM board_custody WHERE connection_id = ?1 AND state IN (${ACTIVE_CUSTODY.map(s => `'${s}'`).join(", ")}) ORDER BY created_at`)
      .all(connectionId).map(custody);
  }

  custodyCounts(connectionId: string): { held: number; settling: number; settled: number; lost: number } {
    const rows = this.database.query<{ state: BoardCustodyState; n: number }>("SELECT state, COUNT(*) AS n FROM board_custody WHERE connection_id = ?1 GROUP BY state").all(connectionId);
    const count = (...states: BoardCustodyState[]) => rows.filter(row => states.includes(row.state)).reduce((sum, row) => sum + row.n, 0);
    return { held: count("claiming", "held"), settling: count("settling", "claim_unknown"), settled: count("settled"), lost: count("lost") };
  }

  enqueue(row: { connectionId: string; clientId: string; lane: string; kind: "post" | "plan"; request: unknown }): BoardOutboxRow {
    const at = this.now();
    this.database.query(`INSERT INTO board_outbox (connection_id, client_id, lane, kind, request, state, attempts, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, ?6) ON CONFLICT (connection_id, client_id) DO NOTHING`).run(
      row.connectionId, row.clientId, row.lane, row.kind, JSON.stringify(row.request), at);
    return this.outboxRow(row.connectionId, row.clientId)!;
  }

  outboxRow(connectionId: string, clientId: string): BoardOutboxRow | null {
    const row = this.database.query<OutboxSql>("SELECT * FROM board_outbox WHERE connection_id = ?1 AND client_id = ?2").get(connectionId, clientId);
    return row ? outbox(row) : null;
  }

  /** The oldest unfinished write in a lane. A lane sends one write at a time, in order. */
  laneHead(connectionId: string, lane: string): BoardOutboxRow | null {
    const row = this.database.query<OutboxSql>("SELECT * FROM board_outbox WHERE connection_id = ?1 AND lane = ?2 AND state IN ('pending', 'unknown') ORDER BY created_at, rowid LIMIT 1").get(connectionId, lane);
    return row ? outbox(row) : null;
  }

  pendingLanes(connectionId: string): string[] {
    return this.database.query<{ lane: string }>("SELECT DISTINCT lane FROM board_outbox WHERE connection_id = ?1 AND state IN ('pending', 'unknown')").all(connectionId).map(row => row.lane);
  }

  markOutbox(connectionId: string, clientId: string, patch: { state: BoardOutboxRow["state"]; response?: unknown; error?: string; attempt?: boolean }): void {
    this.database.query(`UPDATE board_outbox SET state = ?3, response = COALESCE(?4, response), error = ?5, attempts = attempts + ?6, updated_at = ?7
      WHERE connection_id = ?1 AND client_id = ?2`).run(connectionId, clientId, patch.state,
      patch.response === undefined ? null : JSON.stringify(patch.response), patch.error ?? null, patch.attempt ? 1 : 0, this.now());
  }

  outboxCounts(connectionId: string): { pending: number; unknown: number; failed: number } {
    const rows = this.database.query<{ state: string; n: number }>("SELECT state, COUNT(*) AS n FROM board_outbox WHERE connection_id = ?1 GROUP BY state").all(connectionId);
    const count = (state: string) => rows.find(row => row.state === state)?.n ?? 0;
    return { pending: count("pending"), unknown: count("unknown"), failed: count("failed") };
  }
}
