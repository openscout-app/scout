/**
 * Fleet view — operator-scoped rollup of asks, attention items, and a
 * synthesized activity feed.
 *
 * Lifted from db-queries.ts as part of SCO-031 Phase C. The fleet
 * projection types (`FleetActivityRow`, `FleetAskRow`, `FleetAttentionRow`)
 * remain private to this module — they shape only the rows consumed
 * directly by the projection helpers below.
 *
 * The freshness predicate `isFreshActiveTimestamp` and its companion
 * `isStaleActiveFlight` were promoted to `internal/sql-helpers.ts` because
 * the runs domain (queryRuns) needs the same logic.
 */

import { resolveOperatorName } from "@openscout/runtime/user-config";

import { db } from "./internal/db.ts";
import { jsonBoolean, normalizeTimestampMs } from "./internal/parse.ts";
import { compact } from "./internal/paths.ts";
import {
  agentFlightPhaseFromFlightState,
  isStaleActiveFlight,
  sqlJoinClauses,
  sqlPlaceholders,
  sqlTimestampMsExpression,
  sqlWhereClause,
  staleFlightActivityPredicate,
  summarizeAgentState,
} from "./internal/sql-helpers.ts";
import type {
  WebFleetActivity,
  WebFleetAsk,
  WebFleetAskStatus,
  WebFleetState,
} from "../shared/api/web.ts";

/* ── Row projection types (private to this domain) ── */

type FleetActivityRow = {
  id: string;
  /** The author's harness: stamped on the activity at write time, else the
   *  author's most recent endpoint. Session agents aren't in the roster, so
   *  the feed learns it here rather than by joining back to /api/agents. */
  actor_harness?: string | null;
  kind: string;
  ts: number;
  actor_name: string | null;
  title: string | null;
  summary: string | null;
  conversation_id: string | null;
  workspace_root: string | null;
  actor_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
  message_id: string | null;
  invocation_id: string | null;
  flight_id: string | null;
  record_id: string | null;
  session_id: string | null;
  conversation_kind: string | null;
};

type FleetAskRow = {
  invocation_id: string;
  requester_id: string;
  target_agent_id: string;
  agent_name: string | null;
  conversation_id: string | null;
  collaboration_record_id: string | null;
  task: string;
  created_at: number;
  flight_id: string | null;
  flight_state: string | null;
  flight_summary: string | null;
  flight_error: string | null;
  started_at: number | null;
  completed_at: number | null;
  flight_dismissed_at: number | string | null;
  failure_stage: string | null;
  failure_severity: string | null;
  recovered_after_failure_at: number | string | null;
  dispatch_outcome_status: string | null;
  dispatch_outcome_reason: string | null;
  requester_timed_out: number | string | null;
  timeout_scope: string | null;
  status_kind: string | null;
  status_title: string | null;
  status_summary: string | null;
  status_ts: number | string | null;
  harness: string | null;
  transport: string | null;
  endpoint_state: string | null;
  work_title: string | null;
  work_summary: string | null;
  record_kind: "work_item" | "question" | null;
  work_state: string | null;
  next_move_owner_id: string | null;
  work_updated_at: number | string | null;
};

type FleetAttentionRow = {
  record_kind: "work_item" | "question";
  record_id: string;
  title: string;
  summary: string | null;
  conversation_id: string | null;
  state: string;
  acceptance_state: string;
  updated_at: number;
  agent_id: string | null;
  agent_name: string | null;
};

function projectFleetActivity(row: FleetActivityRow): WebFleetActivity {
  return {
    id: row.id,
    kind: normalizeFleetActivityKind(row),
    ts: row.ts,
    actorName: row.actor_name,
    title: row.title,
    summary: row.summary,
    conversationId: row.conversation_id,
    workspaceRoot: compact(row.workspace_root),
    actorId: row.actor_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    flightId: row.flight_id,
    invocationId: row.invocation_id,
    messageId: row.message_id,
    recordId: row.record_id,
    sessionId: row.session_id,
    actorHarness: row.actor_harness ?? null,
  };
}

function normalizeFleetActivityKind(row: FleetActivityRow): string {
  if (
    row.kind === "ask_opened"
    && row.message_id
    && !row.invocation_id
    && !row.flight_id
    && row.conversation_kind !== "direct"
  ) {
    return "message_posted";
  }
  return row.kind;
}

export function queryFleetActivity(opts?: {
  limit?: number;
  lookbackMs?: number;
  agentId?: string | null;
  sessionId?: string | null;
  conversationId?: string | null;
}): WebFleetActivity[] {
  const filters: string[] = [];
  const params: Array<string | number> = [];
  const activityTsExpression = sqlTimestampMsExpression("ai.ts");
  const andClauses: string[] = [];
  const andParams: Array<string | number> = [];

  if (typeof opts?.lookbackMs === "number" && opts.lookbackMs > 0) {
    andClauses.push(`${activityTsExpression} >= ?`);
    andParams.push(Date.now() - opts.lookbackMs);
  }
  if (opts?.agentId) {
    filters.push(`(
      ai.agent_id = ?
      OR ai.actor_id = ?
      OR ai.record_id IN (
        SELECT cr.id
        FROM collaboration_records cr
        WHERE cr.owner_id = ?
          OR cr.next_move_owner_id = ?
      )
    )`);
    params.push(opts.agentId, opts.agentId, opts.agentId, opts.agentId);
  }
  if (opts?.sessionId) {
    filters.push("ai.session_id = ?");
    params.push(opts.sessionId);
  }
  if (opts?.conversationId) {
    filters.push("ai.conversation_id = ?");
    params.push(opts.conversationId);
  }

  const scopedFilters = sqlJoinClauses(filters, "OR");
  const sql = `SELECT
    ai.id,
    ai.kind,
    ${activityTsExpression} AS ts,
    ac.display_name AS actor_name,
    ai.title,
    ai.summary,
    ai.conversation_id,
    ai.workspace_root,
    ai.actor_id,
    ai.agent_id,
    agent_actor.display_name AS agent_name,
    ai.message_id,
    ai.invocation_id,
    ai.flight_id,
    ai.record_id,
    ai.session_id,
    -- Stamped on the activity when it was recorded (the agent's harness);
    -- older rows fall back to the author's latest endpoint.
    COALESCE(
      CASE WHEN ai.agent_id = ai.actor_id THEN json_extract(ai.payload_json, '$.agentHarness') END,
      (
        SELECT ep.harness
        FROM agent_endpoints ep
        WHERE ep.agent_id = ai.actor_id AND ep.harness IS NOT NULL
        ORDER BY ep.updated_at DESC
        LIMIT 1
      )
    ) AS actor_harness,
    c.kind AS conversation_kind
  FROM activity_items ai
  LEFT JOIN actors ac ON ac.id = ai.actor_id
  LEFT JOIN actors agent_actor ON agent_actor.id = ai.agent_id
  LEFT JOIN conversations c ON c.id = ai.conversation_id
  ${sqlWhereClause([
    staleFlightActivityPredicate("ai"),
    "ai.kind NOT IN ('ask_replied', 'ask_failed', 'flight_updated', 'flight.completed', 'flight.updated')",
    ...andClauses,
    scopedFilters ? `(${scopedFilters})` : null,
  ])}
  ORDER BY ${activityTsExpression} DESC
  LIMIT ?`;

  const rows = db().prepare(sql).all(...andParams, ...params, opts?.limit ?? 80) as Array<FleetActivityRow>;
  return rows.map(projectFleetActivity);
}

const TERMINAL_FLIGHT_STATES = new Set(["completed", "failed", "cancelled"]);
const FLEET_RECENT_COMPLETED_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
export const ATTENTION_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function fleetRequesterIds(): string[] {
  const operatorName = resolveOperatorName().trim() || "operator";
  return Array.from(new Set([operatorName, "operator"]));
}

function fleetStatusLabel(status: WebFleetAskStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "working":
      return "Working";
    case "needs_attention":
      return "Asking for input";
    case "failed":
      return "Failed";
    default:
      return "Completed";
  }
}

// Keep recovery expressions aligned with idx_invocations_completed_recovery:
// a state-only index scans all completed history once per recent ask.
export function queryFleetAskRows(requesterIds: string[], limit: number): FleetAskRow[] {
  const requesterClause = sqlPlaceholders(requesterIds.length);
  return db().prepare(
    `WITH recent_invocations AS MATERIALIZED (
       SELECT id FROM invocations
       WHERE requester_id IN (${requesterClause})
         AND NOT (COALESCE(state, '') = 'failed'
           AND COALESCE(error, '') LIKE 'Stale running flight reconciled:%')
       ORDER BY COALESCE(completed_at, started_at, created_at) DESC
       LIMIT ?
     )
     SELECT
       inv.id AS invocation_id,
       inv.requester_id,
       inv.target_agent_id,
       ac.display_name AS agent_name,
       inv.conversation_id,
       inv.collaboration_record_id,
       inv.task,
       inv.created_at,
       inv.flight_id AS flight_id,
       inv.state AS flight_state,
       inv.summary AS flight_summary,
       inv.error AS flight_error,
       inv.started_at,
       inv.completed_at,
       json_extract(inv.flight_metadata_json, '$.operatorAttentionDismissedAt') AS flight_dismissed_at,
       json_extract(inv.flight_metadata_json, '$.failureStage') AS failure_stage,
       json_extract(inv.flight_metadata_json, '$.failureSeverity') AS failure_severity,
       json_extract(inv.flight_metadata_json, '$.dispatchOutcome.status') AS dispatch_outcome_status,
       json_extract(inv.flight_metadata_json, '$.dispatchOutcome.reason') AS dispatch_outcome_reason,
       json_extract(inv.flight_metadata_json, '$.requesterTimedOut') AS requester_timed_out,
       json_extract(inv.flight_metadata_json, '$.timeoutScope') AS timeout_scope,
       (
         SELECT MAX(COALESCE(recovery_inv.completed_at, recovery_inv.started_at, 0))
         FROM invocations recovery_inv
         WHERE recovery_inv.target_agent_id = inv.target_agent_id
           AND COALESCE(recovery_inv.conversation_id, '') = COALESCE(inv.conversation_id, '')
           AND recovery_inv.state = 'completed'
           AND COALESCE(recovery_inv.completed_at, recovery_inv.started_at, 0) > COALESCE(inv.completed_at, inv.started_at, inv.created_at)
       ) AS recovered_after_failure_at,
       latest_ai.kind AS status_kind,
       latest_ai.title AS status_title,
       latest_ai.summary AS status_summary,
       latest_ai.ts AS status_ts,
       ep.harness,
       ep.transport,
       ep.state AS endpoint_state,
       cr.title AS work_title,
       cr.summary AS work_summary,
       cr.kind AS record_kind,
       cr.state AS work_state,
       cr.next_move_owner_id,
       cr.updated_at AS work_updated_at
     FROM recent_invocations recent
     JOIN invocations inv ON inv.id = recent.id
     LEFT JOIN actors ac ON ac.id = inv.target_agent_id
     LEFT JOIN activity_items latest_ai ON latest_ai.id = (
       SELECT ai.id
       FROM activity_items ai
       WHERE (
           ai.invocation_id = inv.id
           OR (
             inv.message_id IS NOT NULL
             AND json_extract(ai.payload_json, '$.replyToMessageId') = inv.message_id
           )
         )
         AND ai.agent_id = inv.target_agent_id
         AND ai.kind IN ('ask_replied', 'ask_failed', 'ask_working', 'status_message')
         AND ai.ts >= inv.created_at
       ORDER BY ai.ts DESC
       LIMIT 1
     )
     LEFT JOIN agent_endpoints ep ON ep.id = (
       SELECT ep2.id
       FROM agent_endpoints ep2
       WHERE ep2.agent_id = inv.target_agent_id
       ORDER BY ep2.updated_at DESC
       LIMIT 1
     )
     LEFT JOIN collaboration_records cr ON cr.id = inv.collaboration_record_id
     ORDER BY COALESCE(inv.completed_at, inv.started_at, inv.created_at) DESC`,
  ).all(...requesterIds, limit) as Array<FleetAskRow>;
}

function isRecoverableDeliveryFailure(row: FleetAskRow): boolean {
  const text = [
    row.flight_error,
    row.flight_summary,
    row.status_summary,
    row.status_title,
  ].filter(Boolean).join(" ").toLowerCase();
  return text.includes("no conversation found with session id");
}

function deliveryBlockedSummary(reason: string | null): string {
  if (reason === "no_runnable_endpoint") {
    return "No runnable endpoint was available.";
  }
  return "The agent could not receive this request.";
}

function projectFleetAsk(row: FleetAskRow): WebFleetAsk {
  const hasFlight = typeof row.flight_id === "string" && row.flight_id.length > 0;
  const replied = row.status_kind === "ask_replied";
  const failed = row.flight_state === "failed" || row.status_kind === "ask_failed";
  const noteworthyFailure = failed && row.failure_severity === "noteworthy";
  const stoppedFailure = noteworthyFailure && row.failure_stage === "codex_app_server_proactive_shutdown";
  const queuedFlight = row.flight_state === "queued";
  const queuedUntilOnline = queuedFlight && row.dispatch_outcome_status === "queued_until_online";
  const staleActiveFlight = hasFlight
    && row.flight_state !== null
    && !TERMINAL_FLIGHT_STATES.has(row.flight_state)
    && isStaleActiveFlight(row.started_at, row.created_at);
  // The requester stopped waiting for a synchronous result. The agent may
  // still be running, but the operator's ask is no longer live, so it must not
  // present as an active "working" ask — that is what left a finished turn
  // reading "working" for as long as the flight record survived.
  const requesterStoppedWaiting = hasFlight
    && row.flight_state !== null
    && !TERMINAL_FLIGHT_STATES.has(row.flight_state)
    && (jsonBoolean(row.requester_timed_out) || row.timeout_scope === "requester_wait");
  const isActiveFlight = hasFlight
    && row.flight_state !== null
    && !TERMINAL_FLIGHT_STATES.has(row.flight_state)
    && !failed
    && !staleActiveFlight
    && !requesterStoppedWaiting;
  // Every row here is an ask the OPERATOR sent. The operator is the asker, so
  // the agent's reply (and the broker's automatic `review` handback that
  // follows it) ends the ask — it never turns it into the agent asking the
  // operator. Asks addressed to the operator exist only when declared
  // (operator needs, approvals, session questions); see operator-attention.

  const updatedAt = normalizeTimestampMs(
    row.status_ts ?? row.completed_at ?? row.started_at ?? row.work_updated_at ?? row.created_at,
  ) ?? Date.now();
  const dismissedAt = normalizeTimestampMs(row.flight_dismissed_at);
  const recoveredAfterFailureAt = normalizeTimestampMs(row.recovered_after_failure_at);
  const failedDismissed = Boolean(dismissedAt !== null && dismissedAt >= updatedAt);
  const recoveredDeliveryFailure = Boolean(
    failed
    && recoveredAfterFailureAt !== null
    && recoveredAfterFailureAt > updatedAt
    && isRecoverableDeliveryFailure(row),
  );

  let status: WebFleetAskStatus;
  if (!hasFlight) {
    status = "queued";
  } else if (queuedFlight && !staleActiveFlight) {
    status = queuedUntilOnline ? "failed" : "queued";
  } else if (isActiveFlight) {
    status = "working";
  } else if (failed || staleActiveFlight) {
    // A failed dispatch produced nothing to review; it must never present as
    // "Asking for input" just because its work record was born pending.
    status = "failed";
  } else {
    status = "completed";
  }

  return {
    invocationId: row.invocation_id,
    flightId: row.flight_id,
    agentId: row.target_agent_id,
    agentName: row.agent_name,
    conversationId: row.conversation_id,
    collaborationRecordId: row.collaboration_record_id,
    task: row.task,
    status,
    statusLabel: requesterStoppedWaiting && status === "completed"
      ? "Stopped waiting"
      : status === "working" && replied
      ? "Acknowledged"
      : status === "failed" && queuedUntilOnline
        ? "Not delivered"
      : status === "failed" && noteworthyFailure
        ? stoppedFailure
          ? "Stopped"
          : "Interrupted"
        : fleetStatusLabel(status),
    acknowledgedAt: status === "working" && replied
      ? normalizeTimestampMs(row.status_ts)
      : null,
    attention: status === "failed" && queuedUntilOnline
      ? "badge"
      : status === "failed" && !failedDismissed && !recoveredDeliveryFailure
        ? noteworthyFailure
          ? "badge"
          : "interrupt"
        : "silent",
    agentState: summarizeAgentState(row.endpoint_state, agentFlightPhaseFromFlightState(row.flight_state)),
    harness: row.harness,
    transport: row.transport,
    summary: queuedUntilOnline
      ? deliveryBlockedSummary(row.dispatch_outcome_reason)
      : row.status_summary ?? row.status_title ?? row.flight_summary ?? row.work_summary ?? row.work_title ?? null,
    startedAt: normalizeTimestampMs(row.started_at ?? row.created_at),
    completedAt: normalizeTimestampMs(row.completed_at),
    updatedAt,
  };
}

export function queryFleetAttentionRows(requesterIds: string[], limit: number): FleetAttentionRow[] {
  const requesterClause = sqlPlaceholders(requesterIds.length);
  const staleBefore = Date.now() - ATTENTION_STALE_AFTER_MS;
  return db().prepare(
    // Retirement and dismissal are projection filters. Rank duplicates only
    // after both so an ineligible historical row cannot hide a live handback.
    `WITH live_attention AS (
       SELECT
         cr.kind AS record_kind,
         cr.id AS record_id,
         cr.title,
         cr.summary,
         cr.conversation_id,
         cr.state,
         cr.acceptance_state,
         cr.updated_at,
         CASE WHEN (json_extract(cr.detail_json, '$.metadata.permissionRequest') IS NOT NULL OR json_extract(cr.detail_json, '$.metadata.operatorNeedMessageId') IS NOT NULL)
           THEN cr.created_by_id ELSE cr.owner_id END AS agent_id,
         ROW_NUMBER() OVER (
           PARTITION BY CASE WHEN (json_extract(cr.detail_json, '$.metadata.permissionRequest') IS NOT NULL OR json_extract(cr.detail_json, '$.metadata.operatorNeedMessageId') IS NOT NULL)
             THEN cr.id ELSE cr.title END, cr.owner_id
           ORDER BY cr.updated_at DESC, cr.id DESC
         ) AS duplicate_rank
       FROM collaboration_records cr
       WHERE (
           (cr.kind = 'work_item' AND cr.state IN ('open', 'working', 'waiting', 'review'))
           OR (cr.kind = 'question' AND cr.state IN ('open', 'answered'))
         )
         AND cr.next_move_owner_id IN (${requesterClause})
         -- A record the operator requested (a work item they dispatched, a
         -- question they asked) coming back to them is the operator's own
         -- ask ending, not an agent asking. Only agent-declared records count.
         AND COALESCE(
           json_extract(cr.detail_json, '$.requestedById'),
           json_extract(cr.detail_json, '$.askedById'),
           cr.created_by_id
         ) NOT IN (${requesterClause})
         AND cr.updated_at >= ?
         AND NOT EXISTS (
           SELECT 1
           FROM collaboration_events dismissed
           WHERE dismissed.record_id = cr.id
             AND dismissed.kind = 'dismissed'
             AND dismissed.actor_id IN (${requesterClause})
             AND dismissed.created_at >= cr.updated_at
         )
     )
     SELECT
       cr.record_kind,
       cr.record_id,
       cr.title,
       cr.summary,
       cr.conversation_id,
       cr.state,
       cr.acceptance_state,
       cr.updated_at,
       cr.agent_id,
       owner.display_name AS agent_name
     FROM live_attention cr
     LEFT JOIN actors owner ON owner.id = cr.agent_id
     WHERE cr.duplicate_rank = 1
     ORDER BY cr.updated_at DESC
     LIMIT ?`,
  ).all(...requesterIds, ...requesterIds, staleBefore, ...requesterIds, limit) as Array<FleetAttentionRow>;
}

/**
 * Collaboration records whose next move belongs to the operator, shaped for
 * the /api/agents needs-attention index.
 */
export function queryOperatorAttentionRows(limit = 48): Array<{
  agentId: string | null;
  title: string;
  summary: string | null;
  updatedAt: number;
}> {
  return queryFleetAttentionRows(fleetRequesterIds(), limit).map((row) => ({
    agentId: row.agent_id,
    title: row.title,
    summary: row.summary,
    updatedAt: normalizeTimestampMs(row.updated_at) ?? Date.now(),
  }));
}

export function queryFleet(opts?: {
  limit?: number;
  activityLimit?: number;
  activityLookbackMs?: number;
}): WebFleetState {
  const limit = opts?.limit ?? 12;
  const activityLimit = opts?.activityLimit ?? 80;
  const requesterIds = fleetRequesterIds();
  const asks = queryFleetAskRows(requesterIds, Math.max(limit * 3, 24)).map(projectFleetAsk);
  const activeAsks = asks
    .filter((ask) =>
      ask.status === "queued" || ask.status === "working" || ask.status === "needs_attention")
    .slice(0, limit);
  const recentCompleted = asks
    .filter((ask) => ask.status === "completed" || (ask.status === "failed" && ask.attention !== "silent"))
    .filter((ask) => Date.now() - ask.updatedAt <= FLEET_RECENT_COMPLETED_MAX_AGE_MS)
    .slice(0, limit);
  const needsAttention = queryFleetAttentionRows(requesterIds, limit).map((row) => ({
    kind: row.record_kind,
    recordId: row.record_id,
    title: row.title,
    summary: row.summary,
    agentId: row.agent_id,
    agentName: row.agent_name,
    conversationId: row.conversation_id,
    state: row.state,
    acceptanceState: row.acceptance_state,
    updatedAt: normalizeTimestampMs(row.updated_at) ?? Date.now(),
  }));
  const activity = activityLimit === 0 ? [] : queryFleetActivity({
    limit: activityLimit,
    lookbackMs: opts?.activityLookbackMs,
  });

  return {
    generatedAt: Date.now(),
    totals: {
      active: activeAsks.length,
      recentCompleted: recentCompleted.length,
      needsAttention: needsAttention.length,
      activity: activity.length,
    },
    activeAsks,
    recentCompleted,
    needsAttention,
    activity,
  };
}
