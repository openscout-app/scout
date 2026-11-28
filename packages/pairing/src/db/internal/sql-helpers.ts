/**
 * SQL builders, predicate clauses, and shared activity helpers used by the
 * web server's direct reads. Lifted from db-queries.ts in SCO-031 Phase A.
 *
 * Domain-specific projections (e.g. `projectWorkItemRow`) live in their
 * domain files (e.g. `../work.ts`). Only cross-domain SQL plumbing and
 * row helpers belong here.
 */

import type { AgentSummaryState } from "../../shared/api/common.ts";
import type { WebActivityItem } from "../../shared/api/web.ts";

import { db } from "./db.ts";
import {
  EPOCH_MILLISECONDS_FLOOR,
  normalizeTimestampMs,
} from "./parse.ts";

export { EPOCH_MILLISECONDS_FLOOR } from "./parse.ts";

/* ── Internal-only SQL helper types ── */

export type SqlClause = string | null | undefined | false;

/* ── SQL clause builders ── */

export function sqlJoinClauses(clauses: SqlClause[], operator: "AND" | "OR" = "AND"): string {
  return clauses.filter((clause): clause is string => Boolean(clause)).join(` ${operator} `);
}

export function sqlWhereClause(clauses: SqlClause[], operator: "AND" | "OR" = "AND"): string {
  const joined = sqlJoinClauses(clauses, operator);
  return joined ? `WHERE ${joined}` : "";
}

export function sqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export function sqlQuoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function sqlStringList(values: readonly string[]): string {
  return `(${values.map(sqlQuoteLiteral).join(",")})`;
}

export function sqlTimestampMsExpression(valueExpression: string): string {
  return `CASE
    WHEN ${valueExpression} IS NULL THEN NULL
    WHEN CAST(${valueExpression} AS REAL) < ${EPOCH_MILLISECONDS_FLOOR}
      THEN CAST(CAST(${valueExpression} AS REAL) * 1000 AS INTEGER)
    ELSE CAST(${valueExpression} AS INTEGER)
  END`;
}

export function sqlTimestampMsCoalesceExpression(valueExpression: string, fallback = "0"): string {
  return `COALESCE(${sqlTimestampMsExpression(valueExpression)}, ${fallback})`;
}

/* ── Agent endpoint join + flight predicates ── */

export const LATEST_AGENT_ENDPOINT_JOIN = `LEFT JOIN agent_endpoints ep ON ep.id = (
  SELECT ep2.id
  FROM agent_endpoints ep2
  WHERE ep2.agent_id = a.id
  ORDER BY ${sqlTimestampMsCoalesceExpression("ep2.updated_at")} DESC
  LIMIT 1
)`;

export type AgentFlightPhase = "in_turn" | "in_flight";

export const ACTIVE_FLIGHT_STATES = ["running", "waking", "waiting", "queued"] as const;

export const ACTIVE_FLIGHT_STATES_SQL = sqlStringList([...ACTIVE_FLIGHT_STATES]);

export function isExecutingFlightState(state: string | null): boolean {
  return state === "running";
}

export function isActiveFlightState(state: string | null): boolean {
  return state === "running"
    || state === "queued"
    || state === "waking"
    || state === "waiting";
}

export function agentFlightPhaseFromFlightState(state: string | null): AgentFlightPhase | null {
  if (state === "running") {
    return "in_turn";
  }
  if (state === "queued" || state === "waking" || state === "waiting") {
    return "in_flight";
  }
  return null;
}

/**
 * Agents holding a live turn.
 *
 * An active flight state is not on its own evidence of live work. A flight
 * whose requester stopped waiting (`requesterTimedOut` / `timeoutScope:
 * requester_wait`) is not being waited on by anyone — the agent may still be
 * running, but nothing is live for the operator. Excluded here, because a
 * single such record otherwise pins an agent to "In turn" for as long as it
 * survives in the table.
 */
export function queryAgentFlightPhases(database = db()): Map<string, AgentFlightPhase> {
  const phases = new Map<string, AgentFlightPhase>();
  const rows = database.prepare(
    `SELECT target_agent_id, state FROM invocations
     WHERE state IN (${sqlPlaceholders(ACTIVE_FLIGHT_STATES.length)})
       AND COALESCE(json_extract(flight_metadata_json, '$.requesterTimedOut'), 0) != 1
       AND COALESCE(json_extract(flight_metadata_json, '$.timeoutScope'), '') != 'requester_wait'`,
  ).all(...ACTIVE_FLIGHT_STATES) as Array<{ target_agent_id: string; state: string }>;

  for (const row of rows) {
    const phase = agentFlightPhaseFromFlightState(row.state);
    if (!phase) {
      continue;
    }
    const existing = phases.get(row.target_agent_id);
    if (existing !== "in_turn") {
      phases.set(row.target_agent_id, phase);
    }
  }
  return phases;
}

export function queryExecutingAgentIds(): Set<string> {
  return new Set(
    [...queryAgentFlightPhases().entries()]
      .filter(([, phase]) => phase === "in_turn")
      .map(([agentId]) => agentId),
  );
}

export function activeAgentMetadataPredicate(alias: string): string {
  return `COALESCE(json_extract(${alias}.metadata_json, '$.retiredFromFleet'), 0) != 1
    AND COALESCE(json_extract(${alias}.metadata_json, '$.staleLocalRegistration'), 0) != 1`;
}

export function summarizeAgentState(
  rawState: string | null,
  flightPhase: AgentFlightPhase | null,
  options: { blocked?: boolean } = {},
): AgentSummaryState {
  if (flightPhase === "in_turn") {
    return "working";
  }
  if (flightPhase === "in_flight") {
    return "in_flight";
  }
  if (options.blocked) {
    return "offline";
  }
  // Callable default: cold endpoint / offline process does not mean unavailable.
  void rawState;
  return "available";
}

export function summarizeAgentStatusLabel(
  rawState: string | null,
  flightPhase: AgentFlightPhase | null,
  options: { blocked?: boolean } = {},
): string {
  switch (summarizeAgentState(rawState, flightPhase, options)) {
    case "working":
      return "In turn";
    case "in_flight":
      return "In flight";
    case "available":
      return "Callable";
    default:
      return "Blocked";
  }
}

/* ── Activity / work state constants and predicates ── */

export const ACTIVE_FLIGHT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const ACTIVE_WORK_STATES_SQL = sqlStringList(["open", "working", "waiting", "review"]);

/** Active-flight freshness — shared between runs and fleet projections. */
export function isFreshActiveTimestamp(timestamp: number | string | null | undefined): boolean {
  const timestampMs = normalizeTimestampMs(timestamp);
  return timestampMs !== null && Date.now() - timestampMs <= ACTIVE_FLIGHT_MAX_AGE_MS;
}

export function isStaleActiveFlight(startedAt: number | null, createdAt: number): boolean {
  return !isFreshActiveTimestamp(startedAt ?? createdAt);
}

export function isDuplicateActivityFeedItem(
  previous: WebActivityItem | null,
  next: WebActivityItem,
): boolean {
  if (!previous) {
    return false;
  }
  return previous.kind === next.kind
    && previous.title === next.title
    && previous.summary === next.summary
    && previous.conversationId === next.conversationId
    && Math.abs(previous.ts - next.ts) <= 5_000;
}

export function transientBrokerWorkingStatusPredicate(alias: string): string {
  return `NOT (
    ${alias}.class = 'status'
    AND COALESCE(json_extract(${alias}.metadata_json, '$.source'), '') = 'broker'
    AND (
      ${alias}.body LIKE '% is working.'
      OR ${alias}.body LIKE '%Scout stopped waiting for a synchronous result%'
      OR ${alias}.body LIKE '%the requester stopped waiting after%'
    )
  )`;
}

export function staleFlightActivityPredicate(alias: string): string {
  return `NOT (
    ${alias}.kind = 'flight_updated'
    AND (COALESCE(${alias}.summary, '') LIKE 'Stale running flight reconciled:%'
      OR COALESCE(${alias}.summary, '') LIKE 'Didn''t finish:%')
  )`;
}
