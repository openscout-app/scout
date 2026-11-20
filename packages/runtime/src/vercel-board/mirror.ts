import {
  VERCEL_BOARD_LABELS,
  type VercelBoardActorRef, type VercelBoardHandoff, type VercelBoardHandoffKind, type VercelBoardMirroredMessage, type VercelBoardTaskState,
} from "@openscout/protocol";
import type { ControlPlaneSqliteTransactionalDatabase } from "../sqlite-adapter.js";
import type { VercelBoardWireEvent, VercelBoardWireMessage } from "./wire.js";

/**
 * Scout's copy of the mirrored channels, in runtime-owned tables. One row per
 * Board message at its latest version, updated in place: an edit overwrites
 * the text, a delete leaves a tombstone with no text, and the task state is a
 * field. Nothing here enters Scout's message log. Each task event the feed
 * carried is kept too, so a task's hand-offs are one query.
 */

/** Board's task events that are hand-offs. `task.ready` has no actor and `task.renewed` is a lease renewal: neither is one. */
const HANDOFF_KINDS: Record<string, VercelBoardHandoffKind> = {
  "task.created": "created", "task.assigned": "assigned", "task.claimed": "claimed", "task.released": "released",
  "task.expired": "expired", "task.completed": "completed", "task.failed": "failed", "task.blocked": "blocked",
  "task.unblocked": "unblocked", "task.reopened": "reopened", "task.canceled": "canceled",
};
const TERMINAL: VercelBoardTaskState[] = ["completed", "failed", "canceled"];
const DETAIL_MAX = 4000;

export interface VercelBoardTaskEventRow {
  connectionId: string;
  cursor: string;
  channel: string;
  taskId: string;
  kind: VercelBoardHandoffKind;
  at: number;
  actor: Omit<VercelBoardActorRef, "scoutActorId"> | null;
  to: string | null;
  epoch: number | null;
  detail: { title?: string; result?: string; reason?: string };
  derived: boolean;
}

type MessageSql = {
  connection_id: string; message_id: string; channel: string; root_id: string | null; reply_to: string | null; version: number; text: string;
  labels_json: string; author_actor: string | null; author_principal: string | null; author_profile: string | null; origin: string;
  no_sync: number; deleted: number; task_state: string | null; task_json: string | null; created_at: number | null; edited_at: number | null;
};
type EventSql = {
  connection_id: string; cursor: string; channel: string; task_id: string; kind: VercelBoardHandoffKind; at: number; actor: string | null;
  principal: string | null; profile: string | null; to_actor: string | null; epoch: number | null; detail_json: string | null; derived: number;
};

const time = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};
const clip = (value: unknown): string | undefined => typeof value === "string" && value ? value.slice(0, DETAIL_MAX) : undefined;
const principalOf = (actor: string): string => actor.split("+")[0]!;
/** Whether a write changed a row. Both SQLite adapters answer `changes`. */
const changed = (result: unknown): boolean => Number((result as { changes?: number } | null)?.changes ?? 0) > 0;

/** Who wrote a message, as the mirror labels it: `scout` for Scout's own profile, the sync key for a synced post, else `board`. */
export function vercelBoardOriginOf(message: VercelBoardWireMessage, self: { principal: string; profile: string }): string {
  if (message.by && message.by.principal === self.principal && message.by.profile === self.profile) return "scout";
  return message.from ? message.from : "board";
}

/** The hand-off one feed event records, or null when the event is not one. */
export function vercelBoardHandoffOf(connectionId: string, channel: string, event: VercelBoardWireEvent, now: number): VercelBoardTaskEventRow | null {
  const kind0 = HANDOFF_KINDS[event.type];
  if (!kind0) return null;
  const payload = event.payload as Record<string, any>;
  const message = event.message;
  const taskId = typeof payload.id === "string" || typeof payload.id === "number" ? String(payload.id) : message?.id;
  if (!taskId) return null;
  const by = payload.by && typeof payload.by === "object" && typeof payload.by.actor === "string" && typeof payload.by.principal === "string"
    ? { actor: String(payload.by.actor), principal: String(payload.by.principal), profile: typeof payload.by.profile === "string" ? payload.by.profile : null }
    : event.actor ? { actor: event.actor.id, principal: principalOf(event.actor.id), profile: null } : null;
  const task = message?.task;
  const kind: VercelBoardHandoffKind = kind0 === "created" && message?.labels[VERCEL_BOARD_LABELS.plan] ? "planned" : kind0;
  const to = kind0 === "created" || kind0 === "assigned" ? (typeof payload.for === "string" ? payload.for : task?.for ?? null)
    : kind0 === "claimed" ? (by?.actor ?? task?.claim?.actor ?? null)
    : kind0 === "completed" || kind0 === "failed" ? (task?.owner ?? null)
    : null;
  const detail: VercelBoardTaskEventRow["detail"] = {};
  if ((kind0 === "created") && message) detail.title = message.text.split("\n")[0]!.slice(0, 200);
  const result = clip(payload.result) ?? (kind0 === "completed" ? clip(task?.result) : undefined);
  const reason = clip(payload.reason) ?? (kind0 === "failed" || kind0 === "blocked" || kind0 === "canceled" ? clip(task?.reason ?? task?.blocked?.reason) : undefined);
  if (result) detail.result = result;
  if (reason) detail.reason = reason;
  // task.expired is the server's own: it has no actor.
  return {
    connectionId, cursor: event.cursor, channel, taskId, kind, at: time(event.createdAt) ?? now,
    actor: kind0 === "expired" ? null : by, to, epoch: Number.isSafeInteger(payload.epoch) ? payload.epoch : task?.epoch ?? null, detail, derived: false,
  };
}

/**
 * The hand-offs a task's state implies, for a task the copy first saw at a
 * backfill: its events are older than the copy. Marked derived.
 */
export function vercelBoardDerivedHandoffs(connectionId: string, root: VercelBoardWireMessage, now: number): VercelBoardTaskEventRow[] {
  const task = root.task;
  if (!task) return [];
  const created = time(root.createdAt) ?? now;
  const author = root.by ?? { actor: task.by, principal: principalOf(task.by), profile: null };
  const base = { connectionId, channel: root.channel, taskId: root.id, derived: true };
  const rows: VercelBoardTaskEventRow[] = [{
    ...base, cursor: `derived:${root.id}:created`, kind: root.labels[VERCEL_BOARD_LABELS.plan] ? "planned" : "created", at: created,
    actor: author, to: task.for, epoch: 0, detail: { title: root.text.split("\n")[0]!.slice(0, 200) },
  }];
  const at = Math.max(created, now);
  const claimer = task.claim ? { actor: task.claim.actor, principal: principalOf(task.claim.actor), profile: null } : null;
  if (task.state === "claimed" && claimer) rows.push({ ...base, cursor: `derived:${root.id}:claimed:${task.epoch}`, kind: "claimed", at, actor: claimer, to: claimer.actor, epoch: task.epoch, detail: {} });
  if (task.state === "completed") rows.push({ ...base, cursor: `derived:${root.id}:completed:${task.epoch}`, kind: "completed", at, actor: null, to: task.owner, epoch: task.epoch, detail: task.result ? { result: task.result.slice(0, DETAIL_MAX) } : {} });
  if (task.state === "failed") rows.push({ ...base, cursor: `derived:${root.id}:failed:${task.epoch}`, kind: "failed", at, actor: null, to: task.owner, epoch: task.epoch, detail: task.reason ? { reason: task.reason.slice(0, DETAIL_MAX) } : {} });
  if (task.state === "blocked") rows.push({ ...base, cursor: `derived:${root.id}:blocked:${task.epoch}`, kind: "blocked", at, actor: null, to: null, epoch: task.epoch, detail: task.blocked?.reason ? { reason: task.blocked.reason.slice(0, DETAIL_MAX) } : {} });
  if (task.state === "canceled") rows.push({ ...base, cursor: `derived:${root.id}:canceled`, kind: "canceled", at, actor: null, to: null, epoch: task.epoch, detail: task.reason ? { reason: task.reason.slice(0, DETAIL_MAX) } : {} });
  return rows;
}

export function vercelBoardHandoffRecord(row: VercelBoardTaskEventRow, scout?: VercelBoardHandoff["scout"]): VercelBoardHandoff {
  return {
    id: `vercel-board:${row.connectionId}:${row.cursor}`, source: "vercel_board", connectionId: row.connectionId, channel: row.channel, taskId: row.taskId,
    kind: row.kind, at: row.at, cursor: row.cursor, actor: row.actor, to: row.to, ...(row.epoch !== null ? { epoch: row.epoch } : {}),
    ...(row.detail.title ? { title: row.detail.title } : {}), ...(row.detail.result ? { result: row.detail.result } : {}),
    ...(row.detail.reason ? { reason: row.detail.reason } : {}), ...(scout ? { scout } : {}), ...(row.derived ? { derived: true } : {}),
  };
}

export class VercelBoardMirror {
  constructor(private readonly database: ControlPlaneSqliteTransactionalDatabase, private readonly now = Date.now) {}

  version(connectionId: string, messageId: string): number | null {
    const row = this.database.query<{ version: number }>("SELECT version FROM vercel_board_messages WHERE connection_id = ?1 AND message_id = ?2").get(connectionId, messageId);
    return row ? row.version : null;
  }

  /** Keep the newest view. A view at or below the stored version changes nothing. Returns whether it changed the copy. */
  upsert(connectionId: string, message: VercelBoardWireMessage, origin: string): boolean {
    const task = message.task;
    const result = this.database.query(`INSERT INTO vercel_board_messages (connection_id, message_id, channel, root_id, reply_to, version, text, labels_json,
        author_actor, author_principal, author_profile, origin, no_sync, deleted, task_state, task_json, created_at, edited_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
      ON CONFLICT (connection_id, message_id) DO UPDATE SET channel = excluded.channel, root_id = excluded.root_id, reply_to = excluded.reply_to,
        version = excluded.version, text = excluded.text, labels_json = excluded.labels_json, author_actor = COALESCE(excluded.author_actor, author_actor),
        author_principal = COALESCE(excluded.author_principal, author_principal), author_profile = COALESCE(excluded.author_profile, author_profile),
        origin = excluded.origin, no_sync = excluded.no_sync, deleted = MAX(deleted, excluded.deleted), task_state = excluded.task_state,
        task_json = excluded.task_json, created_at = COALESCE(created_at, excluded.created_at), edited_at = excluded.edited_at, updated_at = excluded.updated_at
      WHERE excluded.version > vercel_board_messages.version AND vercel_board_messages.deleted = 0`).run(
      connectionId, message.id, message.channel, message.re, message.replyTo ?? null, message.version,
      // A deleted message keeps no text: Scout must not keep what the team deleted.
      message.deleted ? "" : message.text, message.deleted ? "{}" : JSON.stringify(message.labels),
      message.by?.actor ?? null, message.by?.principal ?? null, message.by?.profile ?? null, origin, message.noSync ? 1 : 0, message.deleted ? 1 : 0,
      task?.state ?? null, task ? JSON.stringify({ owner: task.owner, for: task.for, epoch: task.epoch, claim: task.claim, result: message.deleted ? null : task.result, reason: task.reason, blocked: task.blocked, needs: task.needs }) : null,
      time(message.createdAt), time(message.editedAt ?? null), this.now());
    return changed(result);
  }

  /** A message the board no longer has: keep a tombstone with no text. */
  tombstone(connectionId: string, messageId: string, channel: string): boolean {
    const result = this.database.query(`INSERT INTO vercel_board_messages (connection_id, message_id, channel, version, text, labels_json, origin, deleted, task_state, updated_at)
      VALUES (?1, ?2, ?3, 0, '', '{}', 'board', 1, NULL, ?4)
      ON CONFLICT (connection_id, message_id) DO UPDATE SET text = '', labels_json = '{}', deleted = 1,
        task_state = CASE WHEN task_state IS NULL THEN NULL ELSE 'canceled' END, task_json = NULL, updated_at = excluded.updated_at
      WHERE vercel_board_messages.deleted = 0`).run(connectionId, messageId, channel, this.now());
    return changed(result);
  }

  /** Insert each event once, keyed by its cursor. Returns the rows that were new. */
  recordEvents(rows: VercelBoardTaskEventRow[]): VercelBoardTaskEventRow[] {
    const statement = this.database.query(`INSERT INTO vercel_board_task_events (connection_id, cursor, channel, task_id, kind, at, actor, principal, profile, to_actor, epoch, detail_json, derived)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) ON CONFLICT (connection_id, cursor) DO NOTHING`);
    return rows.filter(row => changed(statement.run(row.connectionId, row.cursor, row.channel, row.taskId, row.kind, row.at, row.actor?.actor ?? null,
      row.actor?.principal ?? null, row.actor?.profile ?? null, row.to, row.epoch, Object.keys(row.detail).length ? JSON.stringify(row.detail) : null, row.derived ? 1 : 0)));
  }

  /** The tasks that have any recorded event. A backfilled task without one gets derived events. */
  tasksWithEvents(connectionId: string, taskIds: string[]): Set<string> {
    if (!taskIds.length) return new Set();
    const rows = this.database.query<{ task_id: string }>(`SELECT DISTINCT task_id FROM vercel_board_task_events WHERE connection_id = ?1 AND task_id IN (SELECT value FROM json_each(?2))`)
      .all(connectionId, JSON.stringify(taskIds));
    return new Set(rows.map(row => row.task_id));
  }

  /** The newest `limit` messages of a channel, oldest first. One query. */
  window(connectionId: string, channel: string, limit: number): VercelBoardMirroredMessage[] {
    const rows = this.database.query<MessageSql>(`SELECT * FROM (SELECT rowid AS seq, * FROM vercel_board_messages WHERE connection_id = ?1 AND channel = ?2
      ORDER BY created_at DESC, seq DESC LIMIT ?3) ORDER BY created_at, seq`).all(connectionId, channel, Math.max(1, Math.min(limit, 500)));
    return rows.map(mirrored);
  }

  /** Task roots in a channel that are not finished. One query. */
  openTasks(connectionId: string, channel: string): string[] {
    return this.database.query<{ message_id: string }>(`SELECT message_id FROM vercel_board_messages WHERE connection_id = ?1 AND channel = ?2
      AND root_id IS NULL AND task_state IS NOT NULL AND task_state NOT IN (${TERMINAL.map(state => `'${state}'`).join(", ")}) AND deleted = 0`)
      .all(connectionId, channel).map(row => row.message_id);
  }

  message(connectionId: string, messageId: string): VercelBoardMirroredMessage | null {
    const row = this.database.query<MessageSql>("SELECT * FROM vercel_board_messages WHERE connection_id = ?1 AND message_id = ?2").get(connectionId, messageId);
    return row ? mirrored(row) : null;
  }

  count(connectionId: string, channel: string): number {
    return this.database.query<{ n: number }>("SELECT COUNT(*) AS n FROM vercel_board_messages WHERE connection_id = ?1 AND channel = ?2").get(connectionId, channel)?.n ?? 0;
  }

  /** A task's chain, oldest first: `ORDER BY at, rowid` over its events. */
  chain(connectionId: string, taskId: string): VercelBoardTaskEventRow[] {
    return this.database.query<EventSql>("SELECT * FROM vercel_board_task_events WHERE connection_id = ?1 AND task_id = ?2 ORDER BY at, rowid")
      .all(connectionId, taskId).map(eventRow);
  }

  /** The newest `limit` hand-offs, oldest first, optionally since a time. One query. */
  recent(connectionId: string, options: { since?: number; limit: number }): VercelBoardTaskEventRow[] {
    return this.database.query<EventSql>(`SELECT * FROM (SELECT *, rowid AS r FROM vercel_board_task_events WHERE connection_id = ?1 AND at >= ?2
      ORDER BY at DESC, rowid DESC LIMIT ?3) ORDER BY at, r`).all(connectionId, options.since ?? 0, Math.max(1, Math.min(options.limit, 1000))).map(eventRow);
  }

  promote(connectionId: string, taskId: string, workId: string, by: string): boolean {
    return changed(this.database.query(`INSERT INTO vercel_board_promotions (connection_id, task_id, work_id, promoted_by, promoted_at) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT (connection_id, task_id) DO NOTHING`).run(connectionId, taskId, workId, by, this.now()));
  }

  promotion(connectionId: string, taskId: string): string | null {
    return this.database.query<{ work_id: string }>("SELECT work_id FROM vercel_board_promotions WHERE connection_id = ?1 AND task_id = ?2").get(connectionId, taskId)?.work_id ?? null;
  }

  promotedOpen(connectionId: string, channel: string): string[] {
    return this.database.query<{ task_id: string }>(`SELECT p.task_id FROM vercel_board_promotions p LEFT JOIN vercel_board_messages m
      ON m.connection_id = p.connection_id AND m.message_id = p.task_id WHERE p.connection_id = ?1 AND (m.channel IS NULL OR m.channel = ?2)
      AND (m.task_state IS NULL OR m.task_state NOT IN (${TERMINAL.map(state => `'${state}'`).join(", ")}))`).all(connectionId, channel).map(row => row.task_id);
  }
}

function mirrored(row: MessageSql): VercelBoardMirroredMessage {
  const task = row.task_json ? JSON.parse(row.task_json) as Record<string, any> : null;
  return {
    connectionId: row.connection_id, id: row.message_id, channel: row.channel, re: row.root_id, replyTo: row.reply_to, version: row.version,
    text: row.text, labels: JSON.parse(row.labels_json), by: row.author_actor && row.author_principal ? { actor: row.author_actor, principal: row.author_principal, profile: row.author_profile } : null,
    origin: row.origin, noSync: row.no_sync === 1, deleted: row.deleted === 1,
    ...(row.task_state && task ? { task: { state: row.task_state as VercelBoardTaskState, owner: task.owner, needs: task.needs ?? [], for: task.for ?? null, epoch: task.epoch ?? 0, claim: task.claim ?? null, result: task.result ?? null, reason: task.reason ?? null } } : {}),
    createdAt: row.created_at, editedAt: row.edited_at, trust: "board_source",
  };
}

function eventRow(row: EventSql): VercelBoardTaskEventRow {
  return {
    connectionId: row.connection_id, cursor: row.cursor, channel: row.channel, taskId: row.task_id, kind: row.kind, at: row.at,
    actor: row.actor && row.principal ? { actor: row.actor, principal: row.principal, profile: row.profile } : null,
    to: row.to_actor, epoch: row.epoch, detail: row.detail_json ? JSON.parse(row.detail_json) : {}, derived: row.derived === 1,
  };
}
