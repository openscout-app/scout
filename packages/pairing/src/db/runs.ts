/**
 * Flights and run-graph projections.
 *
 * Lifted from db-queries.ts as part of SCO-031 Phase C. Includes
 * `queryRuns` (merged invocation projection), `queryFlights` (flight-shaped
 * rows for the UI), `queryFlightRecordById` (canonical FlightRecord
 * lookup), and `queryFollowTarget` (single helper that resolves
 * conversation/flight/work/session deep-links).
 *
 * Phase 3 read-switch: all four read the invocation's shadow status columns
 * (state/summary/output/error/started_at/completed_at/flight_id/
 * flight_metadata_json) directly — the flights table is no longer joined.
 * The FlightRecord alias is projected from the invocation row, so the
 * WebFlight/WebAgentRun shapes are unchanged. An invocation carries exactly
 * ONE current status: a flight id addresses an invocation's latest flight
 * only, and a superseded sibling id deliberately resolves nowhere.
 *
 * `queryFollowTarget` defers to `queryWorkItemById` (`./work.ts`) and
 * `querySessionById` (db-queries.ts) when the requested target is sparse;
 * the latter creates a small import cycle with db-queries.ts that is only
 * exercised at call time, not at module load. Per SCO-031 §6, the session
 * cluster moves to `Conversations` in a follow-up step, at which point
 * the cycle disappears.
 */

import {
  AGENT_RUN_SOURCES,
  AGENT_RUN_STATES,
  flightSessionTrace,
  projectAgentRunFromInvocationFlight,
  type AgentRun,
  type AgentRunSource,
  type AgentRunState,
  type FlightRecord,
  type InvocationExecutionPreference,
  type InvocationRequest,
  type MetadataMap,
} from "@openscout/protocol";

import { db } from "./internal/db.ts";
import {
  configuredOperatorActorIds,
  conversationIdAliases,
} from "./internal/conversation-ids.ts";
import { coerceNumber, jsonBoolean, parseJson } from "./internal/parse.ts";
import { resolveHarnessSessionId } from "./internal/paths.ts";
import {
  ACTIVE_FLIGHT_MAX_AGE_MS,
  ACTIVE_FLIGHT_STATES_SQL,
  isFreshActiveTimestamp,
  sqlJoinClauses,
  sqlPlaceholders,
  sqlStringList,
  sqlTimestampMsCoalesceExpression,
  sqlTimestampMsExpression,
  sqlWhereClause,
} from "./internal/sql-helpers.ts";
import { queryWorkItemById } from "./work.ts";
// Session-cluster reads moved to db/sessions.ts as the final SCO-031 Phase C
// extraction. The import is local to db/ so there is no cycle through the
// db-queries.ts barrel.
import { querySessionById } from "./sessions.ts";
import type { WebAgentRun, WebFlight, WebFollowTarget } from "../shared/api/web.ts";

function firstNonOperatorAgentId(
  ...candidateIds: Array<string | null | undefined>
): string | null {
  const operatorIds = new Set(configuredOperatorActorIds());
  for (const candidateId of candidateIds) {
    if (candidateId && !operatorIds.has(candidateId)) return candidateId;
  }
  return null;
}

/* ── Row projection helpers (private) ── */

type RunQueryRow = {
  invocation_id: string;
  invocation_requester_id: string;
  requester_node_id: string;
  invocation_target_agent_id: string;
  target_node_id: string | null;
  action: string;
  task: string;
  collaboration_record_id: string | null;
  collaboration_record_kind: string | null;
  conversation_id: string | null;
  message_id: string | null;
  context_json: string | null;
  execution_json: string | null;
  execution_resolution_json: string | null;
  origin_json: string | null;
  trace_json: string | null;
  ensure_awake: number | string;
  stream: number | string;
  timeout_ms: number | string | null;
  invocation_labels_json: string | null;
  invocation_metadata_json: string | null;
  invocation_created_at: number;
  agent_name: string | null;
  flight_id: string | null;
  flight_invocation_id: string | null;
  flight_requester_id: string | null;
  flight_target_agent_id: string | null;
  flight_state: string | null;
  flight_summary: string | null;
  flight_output: string | null;
  flight_error: string | null;
  flight_metadata_json: string | null;
  started_at: number | null;
  completed_at: number | null;
};

function parseOptionalMetadata(value: string | null): MetadataMap | undefined {
  const parsed = parseJson<unknown>(value, undefined);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as MetadataMap
    : undefined;
}

function parseOptionalExecution(value: string | null): InvocationExecutionPreference | undefined {
  const parsed = parseJson<unknown>(value, undefined);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as InvocationExecutionPreference
    : undefined;
}

function optionalNumber(value: number | string | null): number | undefined {
  return coerceNumber(value) ?? undefined;
}

function sqlBoolean(value: number | string): boolean {
  return value === 1 || value === "1";
}

function projectInvocationFromRunRow(row: RunQueryRow): InvocationRequest {
  const invocation: InvocationRequest = {
    origin: parseJson<InvocationRequest["origin"]>(row.origin_json, { source: "unknown" }),
    trace: parseJson<InvocationRequest["trace"]>(row.trace_json, undefined),
    id: row.invocation_id,
    requesterId: row.invocation_requester_id,
    requesterNodeId: row.requester_node_id,
    targetAgentId: row.invocation_target_agent_id,
    action: row.action as InvocationRequest["action"],
    task: row.task,
    ensureAwake: sqlBoolean(row.ensure_awake),
    stream: sqlBoolean(row.stream),
    createdAt: row.invocation_created_at,
  };

  if (row.target_node_id) invocation.targetNodeId = row.target_node_id;
  if (row.collaboration_record_id) invocation.collaborationRecordId = row.collaboration_record_id;
  if (row.conversation_id) invocation.conversationId = row.conversation_id;
  if (row.message_id) invocation.messageId = row.message_id;

  const context = parseOptionalMetadata(row.context_json);
  if (context) invocation.context = context;
  const execution = parseOptionalExecution(row.execution_json);
  if (execution) invocation.execution = execution;
  const executionResolution = parseJson<InvocationRequest["executionResolution"]>(
    row.execution_resolution_json,
    undefined,
  );
  if (executionResolution) invocation.executionResolution = executionResolution;
  const timeoutMs = optionalNumber(row.timeout_ms);
  if (timeoutMs !== undefined) invocation.timeoutMs = timeoutMs;
  const labels = parseJson<string[] | undefined>(row.invocation_labels_json, undefined);
  if (labels) invocation.labels = labels;
  const metadata = parseOptionalMetadata(row.invocation_metadata_json);
  if (metadata) invocation.metadata = metadata;

  return invocation;
}

function projectFlightFromRunRow(row: RunQueryRow): FlightRecord | undefined {
  if (!row.flight_id || !row.flight_state) {
    return undefined;
  }

  const flight: FlightRecord = {
    id: row.flight_id,
    invocationId: row.flight_invocation_id ?? row.invocation_id,
    requesterId: row.flight_requester_id ?? row.invocation_requester_id,
    targetAgentId: row.flight_target_agent_id ?? row.invocation_target_agent_id,
    state: row.flight_state as FlightRecord["state"],
  };

  if (row.flight_summary) flight.summary = row.flight_summary;
  if (row.flight_output) flight.output = row.flight_output;
  if (row.flight_error) flight.error = row.flight_error;
  const metadata = parseOptionalMetadata(row.flight_metadata_json);
  if (metadata) flight.metadata = metadata;
  if (row.started_at !== null) flight.startedAt = row.started_at;
  if (row.completed_at !== null) flight.completedAt = row.completed_at;

  return flight;
}

const ACTIVE_RUN_STATES = new Set<AgentRunState>([
  "queued",
  "waking",
  "running",
  "waiting",
  "review",
  "unknown",
]);
const ACTIVE_RUN_STATES_SQL = sqlStringList([...ACTIVE_RUN_STATES]);
const AGENT_RUN_STATES_SQL = sqlStringList(AGENT_RUN_STATES);
const AGENT_RUN_SOURCES_SQL = sqlStringList(AGENT_RUN_SOURCES);

function isActiveRun(run: AgentRun): boolean {
  return ACTIVE_RUN_STATES.has(run.state) && isFreshActiveTimestamp(run.updatedAt);
}

function sqlRunReviewNeededExpression(): string {
  return `(
    COALESCE(json_extract(inv.flight_metadata_json, '$.reviewState'), json_extract(inv.metadata_json, '$.reviewState')) IN ('needed', 'blocked')
    OR COALESCE(json_extract(inv.flight_metadata_json, '$.reviewNeeded'), 0) = 1
    OR COALESCE(json_extract(inv.flight_metadata_json, '$.needsReview'), 0) = 1
    OR COALESCE(json_extract(inv.flight_metadata_json, '$.requiresReview'), 0) = 1
    OR COALESCE(json_extract(inv.metadata_json, '$.reviewNeeded'), 0) = 1
    OR COALESCE(json_extract(inv.metadata_json, '$.needsReview'), 0) = 1
    OR COALESCE(json_extract(inv.metadata_json, '$.requiresReview'), 0) = 1
    OR COALESCE(json_array_length(json_extract(inv.flight_metadata_json, '$.reviewTaskIds')), 0) > 0
    OR COALESCE(json_array_length(json_extract(inv.metadata_json, '$.reviewTaskIds')), 0) > 0
  )`;
}

function sqlRunStateExpression(): string {
  return `CASE
    WHEN inv.state = 'failed' THEN 'failed'
    WHEN inv.state = 'cancelled' THEN 'cancelled'
    WHEN inv.state = 'completed' AND ${sqlRunReviewNeededExpression()} THEN 'review'
    WHEN inv.state IN ${AGENT_RUN_STATES_SQL} THEN inv.state
    ELSE 'unknown'
  END`;
}

function sqlRunSourceExpression(): string {
  const explicitSource = `COALESCE(
    NULLIF(trim(json_extract(inv.metadata_json, '$.agentRunSource')), ''),
    NULLIF(trim(json_extract(inv.metadata_json, '$.runSource')), '')
  )`;
  const rawSource = `NULLIF(trim(json_extract(inv.metadata_json, '$.source')), '')`;
  return `CASE
    WHEN ${explicitSource} IN ${AGENT_RUN_SOURCES_SQL} THEN ${explicitSource}
    WHEN ${rawSource} IN ${AGENT_RUN_SOURCES_SQL} THEN ${rawSource}
    WHEN ${rawSource} = 'collaboration-record' THEN 'ask'
    WHEN ${rawSource} = 'broker-deliver' THEN 'message'
    WHEN ${rawSource} = 'scout-app' AND inv.message_id IS NOT NULL THEN 'message'
    WHEN ${rawSource} = 'scout-app' THEN 'manual'
    WHEN ${rawSource} = 'scout-cli' AND inv.message_id IS NOT NULL THEN 'message'
    WHEN ${rawSource} = 'scout-cli' THEN 'ask'
    WHEN inv.collaboration_record_id IS NOT NULL THEN 'ask'
    WHEN json_type(inv.context_json, '$.collaboration') IS NOT NULL THEN 'ask'
    WHEN json_extract(inv.context_json, '$.collaborationRecordId') IS NOT NULL THEN 'ask'
    WHEN inv.message_id IS NOT NULL OR inv.conversation_id IS NOT NULL THEN 'message'
    WHEN inv.action = 'wake' THEN 'manual'
    ELSE 'ask'
  END`;
}

function sqlRunWorkIdClause(): string {
  return `(
    inv.collaboration_record_id = ?
    OR json_extract(inv.metadata_json, '$.workId') = ?
    OR json_extract(inv.metadata_json, '$.collaborationRecordId') = ?
    OR json_extract(inv.context_json, '$.workId') = ?
    OR json_extract(inv.context_json, '$.collaborationRecordId') = ?
    OR json_extract(inv.context_json, '$.collaboration.recordId') = ?
  )`;
}

function optionalRunBoundary(value: unknown): number | null {
  return typeof value === "number" || typeof value === "string"
    ? coerceNumber(value)
    : null;
}

export function queryRuns(opts?: {
  agentId?: string;
  conversationId?: string;
  collaborationRecordId?: string;
  workId?: string;
  state?: AgentRunState | string;
  source?: AgentRunSource | string;
  active?: boolean;
  before?: number | string;
  after?: number | string;
  cursor?: number | string;
  limit?: number;
}): WebAgentRun[] {
  const conversationIds = opts?.conversationId ? conversationIdAliases(opts.conversationId) : [];
  const requestedWorkId = opts?.collaborationRecordId ?? opts?.workId;
  const runStateExpression = sqlRunStateExpression();
  const runSourceExpression = sqlRunSourceExpression();
  const runUpdatedAtExpression = sqlTimestampMsExpression("COALESCE(inv.completed_at, inv.started_at, inv.created_at)");
  const invocationCreatedAtExpression = sqlTimestampMsExpression("inv.created_at");
  const flightStartedAtExpression = sqlTimestampMsExpression("inv.started_at");
  const flightCompletedAtExpression = sqlTimestampMsExpression("inv.completed_at");
  const explicitActiveFilter = opts?.active;
  const activeOnly = explicitActiveFilter ?? (opts?.state ? false : true);
  const before = optionalRunBoundary(opts?.before ?? opts?.cursor);
  const after = optionalRunBoundary(opts?.after);
  const where = sqlJoinClauses([
    opts?.agentId ? `inv.target_agent_id = ?` : null,
    conversationIds.length > 0
      ? `inv.conversation_id IN (${sqlPlaceholders(conversationIds.length)})`
      : null,
    requestedWorkId ? sqlRunWorkIdClause() : null,
    opts?.state ? `${runStateExpression} = ?` : null,
    opts?.source ? `${runSourceExpression} = ?` : null,
    activeOnly
      ? `${runStateExpression} IN ${ACTIVE_RUN_STATES_SQL}
        AND ${runUpdatedAtExpression} >= ?`
      : null,
    before !== null ? `${runUpdatedAtExpression} < ?` : null,
    after !== null ? `${runUpdatedAtExpression} > ?` : null,
  ]);
  const requestedLimit = opts?.limit;
  const limit = typeof requestedLimit === "number" && Number.isFinite(requestedLimit)
    ? Math.min(500, Math.max(1, Math.floor(requestedLimit)))
    : 100;

  const params: Array<number | string> = [];
  if (opts?.agentId) params.push(opts.agentId);
  if (conversationIds.length > 0) params.push(...conversationIds);
  if (requestedWorkId) {
    params.push(
      requestedWorkId,
      requestedWorkId,
      requestedWorkId,
      requestedWorkId,
      requestedWorkId,
      requestedWorkId,
    );
  }
  if (opts?.state) params.push(opts.state);
  if (opts?.source) params.push(opts.source);
  if (activeOnly) params.push(Date.now() - ACTIVE_FLIGHT_MAX_AGE_MS);
  if (before !== null) params.push(before);
  if (after !== null) params.push(after);
  params.push(limit);

  const rows = db().prepare(
    `SELECT
       inv.id AS invocation_id,
       inv.requester_id AS invocation_requester_id,
       inv.requester_node_id,
       inv.target_agent_id AS invocation_target_agent_id,
       inv.target_node_id,
       inv.action,
       inv.task,
       inv.collaboration_record_id,
       cr.kind AS collaboration_record_kind,
       inv.conversation_id,
       inv.message_id,
       inv.context_json,
       inv.execution_json,
       inv.execution_resolution_json,
       inv.origin_json,
       inv.trace_json,
       inv.ensure_awake,
       inv.stream,
       inv.timeout_ms,
       inv.labels_json AS invocation_labels_json,
       inv.metadata_json AS invocation_metadata_json,
       ${invocationCreatedAtExpression} AS invocation_created_at,
       ac.display_name AS agent_name,
       inv.flight_id AS flight_id,
       inv.id AS flight_invocation_id,
       inv.requester_id AS flight_requester_id,
       inv.target_agent_id AS flight_target_agent_id,
       inv.state AS flight_state,
       inv.summary AS flight_summary,
       inv.output AS flight_output,
       inv.error AS flight_error,
       inv.flight_metadata_json AS flight_metadata_json,
       ${flightStartedAtExpression} AS started_at,
       ${flightCompletedAtExpression} AS completed_at
     FROM invocations inv
     LEFT JOIN actors ac ON ac.id = inv.target_agent_id
     LEFT JOIN collaboration_records cr ON cr.id = inv.collaboration_record_id
     ${sqlWhereClause([where])}
     ORDER BY ${runUpdatedAtExpression} DESC, ${invocationCreatedAtExpression} DESC, COALESCE(inv.flight_id, inv.id) ASC
     LIMIT ?`,
  ).all(...params) as RunQueryRow[];

  return rows
    .map((row) => {
      const run = projectAgentRunFromInvocationFlight({
        invocation: projectInvocationFromRunRow(row),
        flight: projectFlightFromRunRow(row),
      });
      if (!run.workId && row.collaboration_record_kind === "work_item" && row.collaboration_record_id) {
        run.workId = row.collaboration_record_id;
      }
      return {
        ...run,
        agentName: row.agent_name,
      };
    })
    .filter((run) => requestedWorkId
      ? run.collaborationRecordId === requestedWorkId || run.workId === requestedWorkId
      : true)
    .filter((run) => opts?.state ? run.state === opts.state : true)
    .filter((run) => opts?.source ? run.source === opts.source : true)
    .filter((run) => activeOnly ? isActiveRun(run) : true)
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    .slice(0, limit);
}

export function queryFlights(opts?: {
  flightId?: string;
  agentId?: string;
  conversationId?: string;
  collaborationRecordId?: string;
  activeOnly?: boolean;
}): WebFlight[] {
  const conversationIds = opts?.conversationId ? conversationIdAliases(opts.conversationId) : [];
  const flightActiveAtExpression = sqlTimestampMsExpression("COALESCE(inv.started_at, inv.created_at)");
  const flightStartedAtExpression = sqlTimestampMsExpression("inv.started_at");
  const flightCompletedAtExpression = sqlTimestampMsExpression("inv.completed_at");
  const where = sqlJoinClauses([
    `inv.flight_id IS NOT NULL`,
    opts?.activeOnly ? `inv.state IN ${ACTIVE_FLIGHT_STATES_SQL}` : null,
    opts?.activeOnly ? `${flightActiveAtExpression} >= ?` : null,
    opts?.flightId ? `inv.flight_id = ?` : null,
    opts?.agentId ? `inv.target_agent_id = ?` : null,
    conversationIds.length > 0
      ? `inv.conversation_id IN (${sqlPlaceholders(conversationIds.length)})`
      : null,
    opts?.collaborationRecordId ? `inv.collaboration_record_id = ?` : null,
  ]);

  const sql = `SELECT
    inv.flight_id AS id,
    inv.id AS invocation_id,
    inv.message_id,
    inv.target_agent_id,
    ac.display_name AS agent_name,
    inv.conversation_id,
    inv.collaboration_record_id,
    inv.state,
    inv.summary,
    inv.flight_metadata_json,
    json_extract(inv.flight_metadata_json, '$.dispatchOutcome.status') AS dispatch_outcome_status,
    json_extract(inv.flight_metadata_json, '$.dispatchOutcome.reason') AS dispatch_outcome_reason,
    json_extract(inv.flight_metadata_json, '$.dispatchOutcome.checkedAt') AS dispatch_outcome_checked_at,
    json_extract(inv.flight_metadata_json, '$.requesterTimedOut') AS requester_timed_out,
    json_extract(inv.flight_metadata_json, '$.timeoutScope') AS timeout_scope,
    ${flightStartedAtExpression} AS started_at,
    ${flightCompletedAtExpression} AS completed_at
  FROM invocations inv
  LEFT JOIN actors ac ON ac.id = inv.target_agent_id
  ${sqlWhereClause([where])}
  ORDER BY COALESCE(${flightStartedAtExpression}, ${sqlTimestampMsExpression("inv.created_at")}, 0) DESC
  LIMIT 100`;

  const params: Array<string | number> = [];
  if (opts?.activeOnly) params.push(Date.now() - ACTIVE_FLIGHT_MAX_AGE_MS);
  if (opts?.flightId) params.push(opts.flightId);
  if (opts?.agentId) params.push(opts.agentId);
  if (conversationIds.length > 0) params.push(...conversationIds);
  if (opts?.collaborationRecordId) params.push(opts.collaborationRecordId);

  const rows = db().prepare(sql).all(...params) as Array<{
    id: string;
    invocation_id: string;
    message_id: string | null;
    target_agent_id: string;
    agent_name: string | null;
    conversation_id: string | null;
    collaboration_record_id: string | null;
    state: string;
    summary: string | null;
    flight_metadata_json: string | null;
    dispatch_outcome_status: string | null;
    dispatch_outcome_reason: string | null;
    dispatch_outcome_checked_at: number | string | null;
    requester_timed_out: number | string | null;
    timeout_scope: string | null;
    started_at: number | null;
    completed_at: number | null;
  }>;

  return rows.map((r) => {
    const dispatchOutcome = r.dispatch_outcome_status
      ? {
          status: r.dispatch_outcome_status,
          reason: r.dispatch_outcome_reason,
          checkedAt: coerceNumber(r.dispatch_outcome_checked_at),
        }
      : null;

    return {
      id: r.id,
      invocationId: r.invocation_id,
      ...(r.message_id ? { messageId: r.message_id } : {}),
      agentId: r.target_agent_id,
      agentName: r.agent_name,
      conversationId: r.conversation_id,
      collaborationRecordId: r.collaboration_record_id,
      state: r.state,
      summary: r.summary,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      sessions: flightSessionTrace(parseJson<Record<string, unknown>>(r.flight_metadata_json, {})),
      ...(dispatchOutcome ? { dispatchOutcome } : {}),
      ...(jsonBoolean(r.requester_timed_out) || r.timeout_scope === "requester_wait"
        ? { requesterWaitTimedOut: true }
        : {}),
    };
  });
}

export function queryFlightRecordById(id: string): FlightRecord | null {
  const row = db().prepare(
    `SELECT
       flight_id AS id,
       id AS invocation_id,
       requester_id,
       target_agent_id,
       state,
       summary,
       output,
       error,
       flight_metadata_json AS metadata_json,
       ${sqlTimestampMsExpression("started_at")} AS started_at,
       ${sqlTimestampMsExpression("completed_at")} AS completed_at
     FROM invocations
     WHERE flight_id = ?
     LIMIT 1`,
  ).get(id) as {
    id: string;
    invocation_id: string;
    requester_id: string;
    target_agent_id: string;
    state: FlightRecord["state"];
    summary: string | null;
    output: string | null;
    error: string | null;
    metadata_json: string | null;
    started_at: number | null;
    completed_at: number | null;
  } | null;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    invocationId: row.invocation_id,
    requesterId: row.requester_id,
    targetAgentId: row.target_agent_id,
    state: row.state,
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.output ? { output: row.output } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
  };
}

// Durable overlay reads for the broker-rotation boundary. The invocation
// row's shadow flight columns are the FlightRecord source (the flights
// table is not joined — see the header note), so one projection covers
// both invocation and flight overlays.
const DURABLE_INVOCATION_SELECT_SQL = `SELECT
    inv.id AS invocation_id,
    inv.requester_id AS invocation_requester_id,
    inv.requester_node_id,
    inv.target_agent_id AS invocation_target_agent_id,
    inv.target_node_id,
    inv.action,
    inv.task,
    inv.collaboration_record_id,
    NULL AS collaboration_record_kind,
    inv.conversation_id,
    inv.message_id,
    inv.context_json,
    inv.execution_json,
    inv.execution_resolution_json,
    inv.origin_json,
    inv.trace_json,
    inv.ensure_awake,
    inv.stream,
    inv.timeout_ms,
    inv.labels_json AS invocation_labels_json,
    inv.metadata_json AS invocation_metadata_json,
    ${sqlTimestampMsExpression("inv.created_at")} AS invocation_created_at,
    NULL AS agent_name,
    inv.flight_id AS flight_id,
    inv.id AS flight_invocation_id,
    inv.requester_id AS flight_requester_id,
    inv.target_agent_id AS flight_target_agent_id,
    inv.state AS flight_state,
    inv.summary AS flight_summary,
    inv.output AS flight_output,
    inv.error AS flight_error,
    inv.flight_metadata_json AS flight_metadata_json,
    ${sqlTimestampMsExpression("inv.started_at")} AS started_at,
    ${sqlTimestampMsExpression("inv.completed_at")} AS completed_at
  FROM invocations inv`;

export function queryInvocationById(id: string): InvocationRequest | null {
  const trimmed = id.trim();
  if (!trimmed) return null;
  const row = db().prepare(
    `${DURABLE_INVOCATION_SELECT_SQL}
     WHERE inv.id = ?
     LIMIT 1`,
  ).get(trimmed) as RunQueryRow | undefined;
  return row ? projectInvocationFromRunRow(row) : null;
}

export function queryInvocations(opts: {
  conversationId: string;
  targetAgentId?: string;
}): InvocationRequest[] {
  const conversationIds = opts.conversationId.trim()
    ? conversationIdAliases(opts.conversationId)
    : [];
  if (conversationIds.length === 0) return [];
  // Newest-first LIMIT so the overlay window tracks the rotation boundary —
  // the broker's hot set already covers the oldest rows' successors, while an
  // ASC LIMIT would pin the overlay to the oldest 200 forever.
  const rows = db().prepare(
    `${DURABLE_INVOCATION_SELECT_SQL}
     WHERE inv.conversation_id IN (${sqlPlaceholders(conversationIds.length)})
       ${opts.targetAgentId ? "AND inv.target_agent_id = ?" : ""}
     ORDER BY ${sqlTimestampMsExpression("inv.created_at")} DESC, inv.id DESC
     LIMIT 200`,
  ).all(...conversationIds, ...(opts.targetAgentId ? [opts.targetAgentId] : [])) as RunQueryRow[];
  return rows.map(projectInvocationFromRunRow).reverse();
}

export function queryFlightRecords(opts: {
  conversationId: string;
  targetAgentId?: string;
}): FlightRecord[] {
  const conversationIds = opts.conversationId.trim()
    ? conversationIdAliases(opts.conversationId)
    : [];
  if (conversationIds.length === 0) return [];
  const rows = db().prepare(
    `${DURABLE_INVOCATION_SELECT_SQL}
     WHERE inv.flight_id IS NOT NULL
       AND inv.conversation_id IN (${sqlPlaceholders(conversationIds.length)})
       ${opts.targetAgentId ? "AND inv.target_agent_id = ?" : ""}
     ORDER BY COALESCE(${sqlTimestampMsExpression("inv.started_at")}, ${sqlTimestampMsExpression("inv.created_at")}, 0) DESC,
       inv.flight_id DESC
     LIMIT 200`,
  ).all(...conversationIds, ...(opts.targetAgentId ? [opts.targetAgentId] : [])) as RunQueryRow[];
  return rows
    .map((row) => projectFlightFromRunRow(row))
    .filter((flight): flight is FlightRecord => flight !== undefined)
    .reverse();
}

/**
 * The harness conversation id behind one endpoint (by id) or behind a Scout
 * session id (its most recently updated endpoint). Tail events are keyed by
 * this id, so follow links need it to filter the tail to the right session.
 * The per-transport resolver decides what counts (tmux → observed id only).
 */
function harnessSessionIdForEndpoint(
  by: { endpointId: string } | { sessionId: string },
): string | null {
  const row = ("endpointId" in by
    ? db().prepare(
      `SELECT transport, session_id, metadata_json FROM agent_endpoints WHERE id = ? LIMIT 1`,
    ).get(by.endpointId)
    : db().prepare(
      `SELECT transport, session_id, metadata_json FROM agent_endpoints
       WHERE session_id = ? OR agent_id = ?
       ORDER BY ${sqlTimestampMsCoalesceExpression("updated_at")} DESC
       LIMIT 1`,
    ).get(by.sessionId, by.sessionId)) as {
      transport: string | null;
      session_id: string | null;
      metadata_json: string | null;
    } | null;
  if (!row) return null;
  return resolveHarnessSessionId(
    row.transport,
    row.session_id,
    parseJson<Record<string, unknown>>(row.metadata_json, {}),
  );
}

export function queryFollowTarget(opts: {
  flightId?: string;
  invocationId?: string;
  conversationId?: string;
  workId?: string;
  sessionId?: string;
  targetAgentId?: string;
}): WebFollowTarget {
  const target: WebFollowTarget = {
    flightId: opts.flightId?.trim() || null,
    invocationId: opts.invocationId?.trim() || null,
    conversationId: opts.conversationId?.trim() || null,
    workId: opts.workId?.trim() || null,
    sessionId: opts.sessionId?.trim() || null,
    targetAgentId: opts.targetAgentId?.trim() || null,
    harnessSessionId: null,
  };

  // A ticket link can arrive before its flight/session exists. Resolve its
  // latest invocation on every read rather than borrowing a chat's session.
  if (target.workId && !target.flightId && !target.invocationId) {
    const invocation = db().prepare(
      `SELECT id FROM invocations WHERE collaboration_record_id = ?
       ORDER BY ${sqlTimestampMsExpression("created_at")} DESC, id DESC LIMIT 1`,
    ).get(target.workId) as { id: string } | null;
    target.invocationId = invocation?.id ?? null;
  }

  if (target.flightId || target.invocationId) {
    const where = target.flightId ? "inv.flight_id = ?" : "inv.id = ?";
    const param = target.flightId ?? target.invocationId ?? "";
    const row = db().prepare(
      `SELECT
         inv.flight_id AS flight_id,
         inv.id AS invocation_id,
         inv.conversation_id,
         inv.collaboration_record_id,
         inv.target_agent_id,
         inv.flight_metadata_json
       FROM invocations inv
       WHERE ${where}
       LIMIT 1`,
    ).get(param) as {
      flight_id: string | null;
      invocation_id: string;
      conversation_id: string | null;
      collaboration_record_id: string | null;
      target_agent_id: string | null;
      flight_metadata_json: string | null;
    } | null;

    if (row) {
      target.flightId = target.flightId ?? row.flight_id;
      target.invocationId = target.invocationId ?? row.invocation_id;
      target.conversationId = target.conversationId ?? row.conversation_id;
      target.workId = target.workId ?? row.collaboration_record_id;
      target.targetAgentId = target.targetAgentId ?? row.target_agent_id;
      const lastTrace = flightSessionTrace(
        parseJson<Record<string, unknown>>(row.flight_metadata_json, {}),
      ).at(-1);
      target.sessionId = lastTrace?.sessionId
        ?? target.sessionId;
      // A queued task may not have a session yet. Never borrow the agent's
      // latest endpoint: it can belong to entirely different work.
      target.harnessSessionId = lastTrace?.endpointId
        ? harnessSessionIdForEndpoint({ endpointId: lastTrace.endpointId })
        : target.sessionId
          ? harnessSessionIdForEndpoint({ sessionId: target.sessionId })
          : null;
    }
  }

  if (!target.harnessSessionId && target.sessionId) {
    target.harnessSessionId = harnessSessionIdForEndpoint({ sessionId: target.sessionId });
  }

  if (target.workId && !target.conversationId) {
    const work = queryWorkItemById(target.workId);
    target.conversationId = work?.conversationId ?? target.conversationId;
    target.targetAgentId = firstNonOperatorAgentId(
      target.targetAgentId,
      work?.nextMoveOwnerId,
      work?.ownerId,
    );
  }

  if (target.conversationId && !target.flightId && !target.invocationId && !target.workId
    && (!target.sessionId || !target.targetAgentId)) {
    // querySessionById now lives in db/sessions.ts (SCO-031 final extraction).
    // SCO-030 may fold this back into `Conversations` once opaque ids land.
    const session = querySessionById(target.conversationId);
    target.sessionId = target.sessionId ?? session?.harnessSessionId ?? null;
    target.harnessSessionId = target.harnessSessionId ?? session?.harnessSessionId ?? null;
    target.targetAgentId = firstNonOperatorAgentId(
      target.targetAgentId,
      session?.agentId,
    );
  }

  target.targetAgentId = firstNonOperatorAgentId(target.targetAgentId);

  return target;
}
