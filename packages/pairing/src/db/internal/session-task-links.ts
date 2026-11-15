/**
 * What a session or agent works on, read from the ask that started or last
 * steered it: the invocation's work item and the first line of its task.
 * Derived at read time from `invocations` and `collaboration_records`, so it
 * needs no write path and no backfill.
 */
import {
  EMPTY_SESSION_TASK_LINK,
  resolveSessionTaskLink,
  type SessionTaskLink,
} from "@openscout/protocol";
import { db } from "./db.ts";
import { sqlTimestampMsExpression } from "./sql-helpers.ts";

type TaskLinkRow = {
  target_agent_id: string;
  task: string | null;
  collaboration_record_id: string | null;
  action: string | null;
  created_at_ms: number | null;
  work_item_title: string | null;
};

function linkFromRow(row: TaskLinkRow | null | undefined): SessionTaskLink {
  if (!row) return { ...EMPTY_SESSION_TASK_LINK };
  return resolveSessionTaskLink(
    [{
      task: row.task,
      collaborationRecordId: row.collaboration_record_id,
      action: row.action,
      createdAt: row.created_at_ms,
    }],
    () => row.work_item_title,
  );
}

function isMissingTable(error: unknown): boolean {
  return error instanceof Error && error.message.includes("no such table");
}

const createdAtMs = sqlTimestampMsExpression("i.created_at");
const TASK_LINK_COLUMNS = `
  i.target_agent_id,
  i.task,
  i.collaboration_record_id,
  i.action,
  ${createdAtMs} AS created_at_ms,
  cr.title AS work_item_title`;

/**
 * The latest ask in a conversation. When the conversation belongs to one
 * agent, only asks to that agent count: in a direct between two agents the
 * session is the target's, not the requester's.
 */
export function querySessionTaskLinkForConversation(
  conversationId: string,
  targetAgentId: string | null,
): SessionTaskLink {
  try {
    const row = db().prepare(
      `SELECT ${TASK_LINK_COLUMNS}
       FROM invocations i
       LEFT JOIN collaboration_records cr ON cr.id = i.collaboration_record_id
       WHERE i.conversation_id = ?
         AND i.action != 'wake'
         AND (? IS NULL OR i.target_agent_id = ?)
       ORDER BY ${createdAtMs} DESC, i.id DESC
       LIMIT 1`,
    ).get(conversationId, targetAgentId, targetAgentId) as TaskLinkRow | null;
    return linkFromRow(row);
  } catch (error) {
    if (isMissingTable(error)) return { ...EMPTY_SESSION_TASK_LINK };
    throw error;
  }
}

/** The latest ask to each agent, keyed by agent id. Agents with none are absent. */
export function querySessionTaskLinksForAgents(agentIds: string[]): Map<string, SessionTaskLink> {
  const links = new Map<string, SessionTaskLink>();
  if (agentIds.length === 0) return links;
  let rows: TaskLinkRow[];
  try {
    rows = db().prepare(
      `SELECT target_agent_id, task, collaboration_record_id, action, created_at_ms, work_item_title
       FROM (
         SELECT ${TASK_LINK_COLUMNS},
           ROW_NUMBER() OVER (
             PARTITION BY i.target_agent_id
             ORDER BY ${createdAtMs} DESC, i.id DESC
           ) AS rank
         FROM invocations i
         LEFT JOIN collaboration_records cr ON cr.id = i.collaboration_record_id
         WHERE i.target_agent_id IN (SELECT value FROM json_each(?))
           AND i.action != 'wake'
       )
       WHERE rank = 1`,
    ).all(JSON.stringify(agentIds)) as TaskLinkRow[];
  } catch (error) {
    if (isMissingTable(error)) return links;
    throw error;
  }
  for (const row of rows) links.set(row.target_agent_id, linkFromRow(row));
  return links;
}
