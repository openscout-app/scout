/**
 * The feed's read of work items (`GET /v1/feed/work`), over the control
 * plane's own tables: each item with its owner's reply to the ask, the
 * operator's first words after it, where the owner worked, and its derived
 * presentation. Read-only; a feed keeps its own projection of the result.
 *
 * Two shapes of the same query:
 *   window   every work item that changed since a time (the first read)
 *   changed  work items that changed since a mark, and those whose
 *            conversation got a message since it (each later read)
 * Both match every state; items a feed does not keep come back as `gone`.
 */
import {
  FEED_WORK_LIMITS,
  type ScoutFeedWork,
  type ScoutFeedWorkPage,
  type ScoutFeedWorkPresentation,
  type ScoutFeedWorkRead,
  type ScoutFeedWorkState,
} from "@openscout/protocol";

import type { ControlPlaneSqliteDatabase } from "./sqlite-adapter.js";

export type FeedWorkRow = {
  id: string;
  title: string;
  state: string;
  acceptance_state: string | null;
  owner_id: string | null;
  owner_name: string | null;
  conversation_id: string | null;
  parent_id: string | null;
  parent_title: string | null;
  created_at: number | string;
  updated_at: number | string;
  requested_by: string | null;
  placement_revision: number | string | null;
  presentation: string | null;
  reply_id: string | null;
  reply_body: string | null;
  reply_at: number | string | null;
  operator_id: string | null;
  operator_body: string | null;
  operator_at: number | string | null;
  harness: string | null;
  session_id: string | null;
  cwd: string | null;
  project_root: string | null;
  branch: string | null;
  asked_from: string | null;
};

export function feedWorkState(state: string): ScoutFeedWorkState | null {
  return state === "done" || state === "review" || state === "working" ? state : null;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export function queryFeedWork(db: ControlPlaneSqliteDatabase, read: ScoutFeedWorkRead, operatorIds: readonly string[]): ScoutFeedWorkPage {
  // No configured operator: no line can be the operator's.
  const operatorClause = operatorIds.length > 0 ? `om.actor_id IN (${placeholders(operatorIds.length)})` : "0";
  const operatorLine = (column: "id" | "body" | "created_at") => `(
      SELECT om.${column}
      FROM messages om
      WHERE om.conversation_id = r.conversation_id
        AND ${operatorClause}
        AND om.created_at > COALESCE(rm.created_at, r.updated_at)
        AND om.created_at <= COALESCE(rm.created_at, r.updated_at) + ${FEED_WORK_LIMITS.operatorWindowMs}
        -- A message that opened the next task is an ask, not a word on this one.
        AND NOT EXISTS (
          SELECT 1 FROM collaboration_records nx
          WHERE nx.kind = 'work_item'
            AND nx.conversation_id = r.conversation_id
            AND nx.id <> r.id
            AND nx.created_at > COALESCE(rm.created_at, r.updated_at)
            AND nx.created_at <= om.created_at + 60000
        )
      ORDER BY om.created_at ASC
      LIMIT 1
    )`;

  const where = read.mode === "window"
    ? read.until === undefined ? "cr.updated_at >= ?" : "cr.updated_at >= ? AND cr.updated_at < ?"
    : `cr.updated_at >= ? AND (cr.updated_at > ? OR cr.conversation_id IN (SELECT DISTINCT m2.conversation_id FROM messages m2 WHERE m2.created_at > ?))`;
  const whereArgs = read.mode === "window" ? [read.since, ...(read.until === undefined ? [] : [read.until])] : [read.since ?? 0, read.mark, read.mark];

  const sql = `WITH picked AS (
      SELECT cr.id, cr.title, cr.state, cr.acceptance_state, cr.owner_id, cr.conversation_id, cr.parent_id,
             cr.created_at, cr.updated_at,
             CASE WHEN json_valid(cr.detail_json) THEN json_extract(cr.detail_json, '$.metadata.lastInvocationId') END AS invocation_id,
             CASE WHEN json_valid(cr.detail_json) THEN json_extract(cr.detail_json, '$.requestedById') END AS requested_by,
             CASE WHEN json_valid(cr.detail_json) THEN json_extract(cr.detail_json, '$.metadata.workPlacement.revision') END AS placement_revision,
             CASE WHEN json_valid(cr.detail_json) THEN json_extract(cr.detail_json, '$.metadata.derived.presentation') END AS presentation
      FROM collaboration_records cr
      WHERE cr.kind = 'work_item' AND ${where}
      ORDER BY cr.updated_at DESC
      LIMIT ?
    ),
    replied AS MATERIALIZED (
      SELECT p.*,
        COALESCE(
          CASE WHEN json_valid(i.flight_metadata_json) THEN json_extract(i.flight_metadata_json, '$.sessionTrace[#-1].sessionId') END,
          CASE WHEN json_valid(i.execution_resolution_json) THEN json_extract(i.execution_resolution_json, '$.sessionId') END,
          CASE WHEN json_valid(i.execution_json) THEN json_extract(i.execution_json, '$.targetSessionId') END
        ) AS turn_session,
        COALESCE(
          CASE WHEN json_valid(i.flight_metadata_json) THEN json_extract(i.flight_metadata_json, '$.taskFinalReplyMessageId') END,
          (SELECT m.id FROM messages m
           WHERE m.conversation_id = p.conversation_id AND +m.actor_id = p.owner_id
             AND m.reply_to_message_id = i.message_id
             AND (p.state = 'working' OR COALESCE(CASE WHEN json_valid(m.metadata_json)
               THEN json_extract(m.metadata_json, '$.completionReply.kind') END, 'final') = 'final')
           ORDER BY m.created_at DESC, m.id LIMIT 1)
        ) AS reply_id
      FROM picked p LEFT JOIN invocations i ON i.id = p.invocation_id AND i.collaboration_record_id = p.id
    )
    SELECT
      r.id, r.title, r.state, r.acceptance_state, r.owner_id, owner.display_name AS owner_name,
      r.conversation_id, r.parent_id, parent.title AS parent_title, r.created_at, r.updated_at,
      r.requested_by, r.placement_revision, r.presentation,
      rm.id AS reply_id, substr(rm.body, 1, ${FEED_WORK_LIMITS.replyCharacters}) AS reply_body, rm.created_at AS reply_at,
      ${operatorLine("id")} AS operator_id,
      ${operatorLine("body")} AS operator_body,
      ${operatorLine("created_at")} AS operator_at,
      ep.harness, r.turn_session AS session_id, ep.cwd, ep.project_root,
      CASE WHEN json_valid(ep.metadata_json) THEN json_extract(ep.metadata_json, '$.branch') END AS branch,
      -- Where the ask was sent from: its own message, by the requester, naming this work item.
      -- Written with the work item, so a minute either side bounds the scan of a long conversation.
      -- "+am.actor_id" keeps SQLite on the conversation index: the operator's own index holds every message they sent.
      (
        SELECT json_extract(am.metadata_json, '$.senderContext.cwd')
        FROM messages am
        WHERE am.conversation_id = r.conversation_id
          AND am.created_at >= r.created_at - 60000
          AND am.created_at <= r.created_at + 60000
          AND +am.actor_id = r.requested_by
          AND json_valid(am.metadata_json)
          AND json_extract(am.metadata_json, '$.collaborationRecordId') = r.id
        ORDER BY am.created_at DESC
        LIMIT 1
      ) AS asked_from
    FROM replied r
    LEFT JOIN messages rm ON rm.id = r.reply_id AND rm.conversation_id = r.conversation_id AND rm.actor_id = r.owner_id
    LEFT JOIN actors owner ON owner.id = r.owner_id
    LEFT JOIN collaboration_records parent ON parent.id = r.parent_id
    LEFT JOIN agent_endpoints ep ON ep.id = (
      SELECT e.id FROM agent_endpoints e WHERE e.agent_id = r.owner_id ORDER BY e.updated_at DESC LIMIT 1
    )`;

  const rows = db.query<FeedWorkRow>(sql).all(...whereArgs, read.limit, ...operatorIds, ...operatorIds, ...operatorIds);
  const tasks: ScoutFeedWork[] = [];
  const gone: string[] = [];
  for (const row of rows) {
    const task = projectFeedWorkRow(row, operatorIds);
    if (task) tasks.push(task);
    else gone.push(row.id);
  }
  return { tasks, gone };
}

function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clip(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

type PresentationRecord = {
  schema?: unknown;
  kind?: unknown;
  sourceId?: unknown;
  sourceVersion?: unknown;
  body?: { title?: unknown; headline?: unknown; caption?: unknown; summary?: unknown } | null;
};

const MISSING: ScoutFeedWorkPresentation = { status: "missing", title: null, caption: null };

/**
 * A derived record counts only while it names the item's current version,
 * `r<placement revision>.u<updatedAt>`. The body's shape is a feed's:
 * { title | headline, caption | summary }.
 */
export function readFeedPresentation(raw: string | null, id: string, updatedAt: number, revision: number): ScoutFeedWorkPresentation {
  if (!raw) return MISSING;
  let record: PresentationRecord;
  try { record = JSON.parse(raw) as PresentationRecord; } catch { return MISSING; }
  if (record.schema !== "openscout.derived.v1" || record.kind !== "presentation") return MISSING;
  const current = record.sourceId === id && record.sourceVersion === `r${revision}.u${updatedAt}`;
  const title = clip(record.body?.title, 200) ?? clip(record.body?.headline, 200);
  const caption = clip(record.body?.caption, 400) ?? clip(record.body?.summary, 400);
  return { status: current ? "current" : "stale", title, caption };
}

export function projectFeedWorkRow(row: FeedWorkRow, operatorIds: readonly string[]): ScoutFeedWork | null {
  const state = feedWorkState(row.state);
  if (!state) return null;
  const updatedAt = num(row.updated_at) ?? 0;
  const replyAt = num(row.reply_at);
  const operatorAt = num(row.operator_at);
  const operatorText = row.operator_body?.trim();
  return {
    id: row.id,
    title: row.title,
    state,
    accepted: row.acceptance_state === "accepted",
    operatorAsked: row.requested_by != null && (row.requested_by === "operator" || operatorIds.includes(row.requested_by)),
    askedFrom: clip(row.asked_from, 4096),
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    harness: row.harness ?? null,
    sessionId: row.session_id ?? null,
    conversationId: row.conversation_id,
    parentId: row.parent_id,
    parentTitle: row.parent_title,
    projectRoot: row.project_root ?? null,
    cwd: row.cwd ?? null,
    branch: clip(row.branch, 512),
    createdAt: num(row.created_at) ?? updatedAt,
    updatedAt,
    finishedAt: replyAt ?? updatedAt,
    replyId: row.reply_id ?? null,
    reply: row.reply_body?.trim() || null,
    operator: operatorText && operatorAt != null ? { id: row.operator_id ?? null, text: operatorText, at: operatorAt } : null,
    presentation: readFeedPresentation(row.presentation, row.id, updatedAt, num(row.placement_revision) ?? 0),
  };
}
