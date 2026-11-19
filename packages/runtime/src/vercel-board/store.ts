import type { ControlPlaneSqliteTransactionalDatabase } from "../sqlite-adapter.js";

export type VercelBoardCustodyState = "claiming" | "claim_unknown" | "held" | "settling" | "settled" | "lost";
export type VercelBoardSettleOutcome = "completed" | "failed" | "released";

export interface VercelBoardCustodyRow {
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
  state: VercelBoardCustodyState;
  outcome: VercelBoardSettleOutcome | null;
  /** The agent's result, kept from the first settle attempt so a retry or a re-claim sends the same one. */
  result: string | null;
  detail: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface VercelBoardOutboxRow {
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
  lease_seconds: number; agent_id: string; work_id: string; started_by: string; flight_id: string | null; state: VercelBoardCustodyState;
  outcome: VercelBoardSettleOutcome | null; result: string | null; detail: string | null; created_at: number; updated_at: number;
};
type OutboxSql = {
  connection_id: string; client_id: string; lane: string; kind: "post" | "plan"; request: string; state: VercelBoardOutboxRow["state"];
  attempts: number; response: string | null; error: string | null; created_at: number; updated_at: number;
};

const custody = (row: CustodySql): VercelBoardCustodyRow => ({
  connectionId: row.connection_id, taskId: row.task_id, attemptId: row.attempt_id, epoch: row.epoch, token: row.token, until: row.until,
  leaseSeconds: row.lease_seconds, agentId: row.agent_id, workId: row.work_id, startedBy: row.started_by, flightId: row.flight_id,
  state: row.state, outcome: row.outcome, result: row.result, detail: row.detail, createdAt: row.created_at, updatedAt: row.updated_at,
});
const outbox = (row: OutboxSql): VercelBoardOutboxRow => ({
  connectionId: row.connection_id, clientId: row.client_id, lane: row.lane, kind: row.kind, request: JSON.parse(row.request),
  state: row.state, attempts: row.attempts, response: row.response ? JSON.parse(row.response) : null, error: row.error,
  createdAt: row.created_at, updatedAt: row.updated_at,
});

/** A batch commit lost the compare-and-set: another follower moved the cursor. */
export class VercelBoardCursorConflictError extends Error {
  constructor(readonly connectionId: string, readonly channel: string) {
    super(`vercel_board_cursor_conflict: the cursor for ${channel} moved under this follower`);
    this.name = "VercelBoardCursorConflictError";
  }
}

const ACTIVE_CUSTODY: VercelBoardCustodyState[] = ["claiming", "claim_unknown", "held", "settling"];

export class VercelBoardStore {
  /*
   * Connections known to have no active custody or no queued writes. The
   * custodian is the only writer of these tables (its lease fences other
   * processes), so a quiet connection needs no query until this store writes
   * a row that ends the quiet. Idle timers then cost no SQL at all.
   */
  private readonly quietCustody = new Set<string>();
  private readonly quietOutbox = new Set<string>();

  constructor(private readonly database: ControlPlaneSqliteTransactionalDatabase, private readonly now = Date.now) {}

  cursor(connectionId: string, channel: string): { cursor: string; updatedAt: number; lastDeltaAt: number | null } | null {
    const row = this.database.query<{ cursor: string; updated_at: number; last_delta_at: number | null }>(
      "SELECT cursor, updated_at, last_delta_at FROM vercel_board_cursors WHERE connection_id = ?1 AND channel = ?2").get(connectionId, channel);
    return row ? { cursor: row.cursor, updatedAt: row.updated_at, lastDeltaAt: row.last_delta_at } : null;
  }

  /**
   * Commit a read in one transaction: compare-and-set the cursor from `from`
   * to `to`, and apply the read's changes to the mirror. A lost
   * compare-and-set applies nothing, so the next read replays the same events.
   */
  commit<T>(input: { connectionId: string; channel: string; from: string | null; to: string; delta: boolean; apply: () => T }): T {
    return this.database.transaction(() => {
      const current = this.cursor(input.connectionId, input.channel);
      if ((current?.cursor ?? null) !== input.from) throw new VercelBoardCursorConflictError(input.connectionId, input.channel);
      const result = input.apply();
      const at = this.now();
      this.database.query(`INSERT INTO vercel_board_cursors (connection_id, channel, cursor, last_delta_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT (connection_id, channel) DO UPDATE SET cursor = excluded.cursor, last_delta_at = COALESCE(excluded.last_delta_at, vercel_board_cursors.last_delta_at), updated_at = excluded.updated_at`)
        .run(input.connectionId, input.channel, input.to, input.delta ? at : null, at);
      return result;
    })();
  }

  /** Drop a channel's cursor so the next read reconciles and then follows from the head. */
  dropCursor(connectionId: string, channel: string): void {
    this.database.query("DELETE FROM vercel_board_cursors WHERE connection_id = ?1 AND channel = ?2").run(connectionId, channel);
  }

  insertCustody(row: Omit<VercelBoardCustodyRow, "createdAt" | "updatedAt">): void {
    this.quietCustody.delete(row.connectionId);
    const at = this.now();
    this.database.query(`INSERT INTO vercel_board_custody (connection_id, task_id, attempt_id, epoch, token, until, lease_seconds, agent_id, work_id, started_by, flight_id, state, outcome, result, detail, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)`).run(
      row.connectionId, row.taskId, row.attemptId, row.epoch, row.token, row.until, row.leaseSeconds, row.agentId, row.workId,
      row.startedBy, row.flightId, row.state, row.outcome, row.result, row.detail, at);
  }

  updateCustody(connectionId: string, attemptId: string, patch: Partial<Pick<VercelBoardCustodyRow, "epoch" | "token" | "until" | "leaseSeconds" | "flightId" | "state" | "outcome" | "result" | "detail">>): void {
    const columns: Record<string, string> = { epoch: "epoch", token: "token", until: "until", leaseSeconds: "lease_seconds", flightId: "flight_id", state: "state", outcome: "outcome", result: "result", detail: "detail" };
    const keys = Object.keys(patch).filter(key => key in columns) as (keyof typeof patch)[];
    if (!keys.length) return;
    if (patch.state && ACTIVE_CUSTODY.includes(patch.state)) this.quietCustody.delete(connectionId);
    const sets = keys.map((key, index) => `${columns[key]} = ?${index + 3}`).join(", ");
    this.database.query(`UPDATE vercel_board_custody SET ${sets}, updated_at = ?${keys.length + 3} WHERE connection_id = ?1 AND attempt_id = ?2`)
      .run(connectionId, attemptId, ...keys.map(key => patch[key] ?? null), this.now());
  }

  custody(connectionId: string, attemptId: string): VercelBoardCustodyRow | null {
    const row = this.database.query<CustodySql>("SELECT * FROM vercel_board_custody WHERE connection_id = ?1 AND attempt_id = ?2").get(connectionId, attemptId);
    return row ? custody(row) : null;
  }

  /** The newest attempt on a task, settled or not. */
  latestCustody(connectionId: string, taskId: string): VercelBoardCustodyRow | null {
    const row = this.database.query<CustodySql>("SELECT * FROM vercel_board_custody WHERE connection_id = ?1 AND task_id = ?2 ORDER BY created_at DESC, rowid DESC LIMIT 1").get(connectionId, taskId);
    return row ? custody(row) : null;
  }

  /** The custody row for exactly this epoch: how a replayed `task.completed` is matched to Scout's claim. */
  custodyForEpoch(connectionId: string, taskId: string, epoch: number): VercelBoardCustodyRow | null {
    const row = this.database.query<CustodySql>("SELECT * FROM vercel_board_custody WHERE connection_id = ?1 AND task_id = ?2 AND epoch = ?3").get(connectionId, taskId, epoch);
    return row ? custody(row) : null;
  }

  activeCustody(connectionId: string): VercelBoardCustodyRow[] {
    if (this.quietCustody.has(connectionId)) return [];
    const rows = this.database.query<CustodySql>(`SELECT * FROM vercel_board_custody WHERE connection_id = ?1 AND state IN (${ACTIVE_CUSTODY.map(s => `'${s}'`).join(", ")}) ORDER BY created_at`)
      .all(connectionId).map(custody);
    if (!rows.length) this.quietCustody.add(connectionId);
    return rows;
  }

  custodyCounts(connectionId: string): { held: number; settling: number; settled: number; lost: number } {
    const rows = this.database.query<{ state: VercelBoardCustodyState; n: number }>("SELECT state, COUNT(*) AS n FROM vercel_board_custody WHERE connection_id = ?1 GROUP BY state").all(connectionId);
    const count = (...states: VercelBoardCustodyState[]) => rows.filter(row => states.includes(row.state)).reduce((sum, row) => sum + row.n, 0);
    return { held: count("claiming", "held"), settling: count("settling", "claim_unknown"), settled: count("settled"), lost: count("lost") };
  }

  enqueue(row: { connectionId: string; clientId: string; lane: string; kind: "post" | "plan"; request: unknown }): VercelBoardOutboxRow {
    this.quietOutbox.delete(row.connectionId);
    const at = this.now();
    this.database.query(`INSERT INTO vercel_board_outbox (connection_id, client_id, lane, kind, request, state, attempts, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, ?6) ON CONFLICT (connection_id, client_id) DO NOTHING`).run(
      row.connectionId, row.clientId, row.lane, row.kind, JSON.stringify(row.request), at);
    return this.outboxRow(row.connectionId, row.clientId)!;
  }

  outboxRow(connectionId: string, clientId: string): VercelBoardOutboxRow | null {
    const row = this.database.query<OutboxSql>("SELECT * FROM vercel_board_outbox WHERE connection_id = ?1 AND client_id = ?2").get(connectionId, clientId);
    return row ? outbox(row) : null;
  }

  /** The oldest unfinished write in a lane. A lane sends one write at a time, in order. */
  laneHead(connectionId: string, lane: string): VercelBoardOutboxRow | null {
    const row = this.database.query<OutboxSql>("SELECT * FROM vercel_board_outbox WHERE connection_id = ?1 AND lane = ?2 AND state IN ('pending', 'unknown') ORDER BY created_at, rowid LIMIT 1").get(connectionId, lane);
    return row ? outbox(row) : null;
  }

  pendingLanes(connectionId: string): string[] {
    if (this.quietOutbox.has(connectionId)) return [];
    const lanes = this.database.query<{ lane: string }>("SELECT DISTINCT lane FROM vercel_board_outbox WHERE connection_id = ?1 AND state IN ('pending', 'unknown')").all(connectionId).map(row => row.lane);
    if (!lanes.length) this.quietOutbox.add(connectionId);
    return lanes;
  }

  markOutbox(connectionId: string, clientId: string, patch: { state: VercelBoardOutboxRow["state"]; response?: unknown; error?: string; attempt?: boolean }): void {
    if (patch.state === "pending" || patch.state === "unknown") this.quietOutbox.delete(connectionId);
    this.database.query(`UPDATE vercel_board_outbox SET state = ?3, response = COALESCE(?4, response), error = ?5, attempts = attempts + ?6, updated_at = ?7
      WHERE connection_id = ?1 AND client_id = ?2`).run(connectionId, clientId, patch.state,
      patch.response === undefined ? null : JSON.stringify(patch.response), patch.error ?? null, patch.attempt ? 1 : 0, this.now());
  }

  outboxCounts(connectionId: string): { pending: number; unknown: number; failed: number } {
    const rows = this.database.query<{ state: string; n: number }>("SELECT state, COUNT(*) AS n FROM vercel_board_outbox WHERE connection_id = ?1 GROUP BY state").all(connectionId);
    const count = (state: string) => rows.find(row => row.state === state)?.n ?? 0;
    return { pending: count("pending"), unknown: count("unknown"), failed: count("failed") };
  }
}
