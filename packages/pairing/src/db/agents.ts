/**
 * Web-shaped agent listing queries.
 *
 * Lifted from db-queries.ts as part of SCO-031 Phase C. The
 * Agent rows expose an existing chat id when one exists. They do not mint or
 * synthesize chat ids; chat creation goes through the broker.
 */

import { agentRosterTag, directChannelNaturalKey, type AgentRosterTag } from "@openscout/protocol";

import { db } from "./internal/db.ts";
import { metadataString } from "./internal/parse.ts";
import {
  compact,
  resolveHarnessLogPath,
  resolveHarnessSessionIdForAgent,
} from "./internal/paths.ts";
import { resolveTerminalSurface } from "../core/terminal-surfaces.ts";
import {
  LATEST_AGENT_ENDPOINT_JOIN,
  activeAgentMetadataPredicate,
  queryAgentFlightPhases,
  sqlTimestampMsCoalesceExpression,
  sqlTimestampMsExpression,
  summarizeAgentState,
  type AgentFlightPhase,
} from "./internal/sql-helpers.ts";
import type { WebAgent } from "../shared/api/web.ts";

function existingDirectConversationIdsForAgents(agentIds: string[]): Map<string, string> {
  const agentIdByNaturalKey = new Map(
    agentIds.map((agentId) => [directChannelNaturalKey(["operator", agentId]), agentId]),
  );
  const conversationIdByAgentId = new Map<string, string>();
  if (agentIdByNaturalKey.size === 0) return conversationIdByAgentId;

  // Agent lists contain hundreds of rows on long-lived pilots. Reading direct
  // conversations once avoids the former N+1 path (one prepared SQLite query
  // per agent) while preserving the oldest-canonical-conversation rule.
  const rows = db().prepare(
    `SELECT id, json_extract(metadata_json, '$.naturalKey') AS natural_key
     FROM conversations
     WHERE kind = 'direct'
     ORDER BY created_at ASC`,
  ).all() as Array<{ id: string; natural_key: string | null }>;
  for (const row of rows) {
    if (!row.natural_key) continue;
    const agentId = agentIdByNaturalKey.get(row.natural_key);
    if (agentId && !conversationIdByAgentId.has(agentId)) {
      conversationIdByAgentId.set(agentId, row.id);
    }
  }
  return conversationIdByAgentId;
}

type AgentQueryRow = {
  id: string;
  definition_id: string;
  node_qualifier: string | null;
  workspace_qualifier: string | null;
  selector: string | null;
  name: string;
  handle: string | null;
  actor_created_at: number | null;
  agent_class: string;
  default_selector: string | null;
  wake_policy: string | null;
  capabilities_json: string | null;
  metadata_json: string | null;
  authority_node_id: string | null;
  authority_node_name: string | null;
  home_node_id: string | null;
  home_node_name: string | null;
  owner_id: string | null;
  owner_name: string | null;
  owner_handle: string | null;
  harness: string | null;
  transport: string | null;
  state: string | null;
  project_root: string | null;
  cwd: string | null;
  session_id: string | null;
  endpoint_metadata_json: string | null;
  updated_at: number | null;
};

const actorCreatedAtExpression = sqlTimestampMsExpression("ac.created_at");
const endpointUpdatedAtExpression = sqlTimestampMsExpression("ep.updated_at");
const AGENT_ROW_SELECT = `SELECT
  a.id,
  a.definition_id,
  a.node_qualifier,
  a.workspace_qualifier,
  a.selector,
  ac.display_name AS name,
  ac.handle,
  ${actorCreatedAtExpression} AS actor_created_at,
  a.agent_class,
  a.default_selector,
  a.wake_policy,
  a.capabilities_json,
  a.metadata_json,
  a.authority_node_id,
  an.name AS authority_node_name,
  a.home_node_id,
  hn.name AS home_node_name,
  a.owner_id,
  oa.display_name AS owner_name,
  oa.handle AS owner_handle,
  ep.harness,
  ep.transport,
  ep.state,
  ep.project_root,
  ep.cwd,
  ep.session_id,
  ep.metadata_json AS endpoint_metadata_json,
  ${endpointUpdatedAtExpression} AS updated_at
FROM agents a
JOIN actors ac ON ac.id = a.id
LEFT JOIN nodes an ON an.id = a.authority_node_id
LEFT JOIN nodes hn ON hn.id = a.home_node_id
LEFT JOIN actors oa ON oa.id = a.owner_id
${LATEST_AGENT_ENDPOINT_JOIN}`;

/**
 * The bounded roster starts with endpoint-backed agents because every valid
 * endpoint timestamp sorts ahead of the no-endpoint fallback. The matching
 * expression index lets SQLite stop after the requested page instead of
 * evaluating the latest-endpoint subquery for every historical agent.
 *
 * Exported only so the query-plan regression test can explain the exact SQL
 * used in production.
 */
const RECENT_ENDPOINT_AGENT_IDS_WITHOUT_INDEX_SQL = (() => {
  const endpointUpdatedAtExpression = sqlTimestampMsExpression("ep.updated_at");
  const latestEndpointUpdatedAtExpression = sqlTimestampMsCoalesceExpression("ep2.updated_at");
  return `SELECT a.id
    FROM agent_endpoints ep
    JOIN agents a ON a.id = ep.agent_id
    JOIN actors ac ON ac.id = a.id
    WHERE ep.id = (
      SELECT ep2.id
      FROM agent_endpoints ep2
      WHERE ep2.agent_id = a.id
      ORDER BY ${latestEndpointUpdatedAtExpression} DESC
      LIMIT 1
    )
      AND ${endpointUpdatedAtExpression} > 0
      AND ${activeAgentMetadataPredicate("a")}
    ORDER BY ${endpointUpdatedAtExpression} DESC, ac.display_name ASC
    LIMIT ?`;
})();

export const RECENT_ENDPOINT_AGENT_IDS_SQL = RECENT_ENDPOINT_AGENT_IDS_WITHOUT_INDEX_SQL.replace(
  "FROM agent_endpoints ep",
  "FROM agent_endpoints ep INDEXED BY idx_agent_endpoints_roster_recency",
);

function queryAgentIdsForBoundedRoster(limit: number): string[] {
  const database = db();
  let recentIds: Array<{ id: string }>;
  try {
    recentIds = database.prepare(RECENT_ENDPOINT_AGENT_IDS_SQL).all(limit) as Array<{ id: string }>;
  } catch (error) {
    // The web listener can become available while a lazily warmed broker is
    // still applying this additive index. Stay correct during that brief
    // mixed-version window; the next request takes the indexed path.
    if (!(error instanceof Error) || !error.message.includes("idx_agent_endpoints_roster_recency")) {
      throw error;
    }
    recentIds = database
      .prepare(RECENT_ENDPOINT_AGENT_IDS_WITHOUT_INDEX_SQL)
      .all(limit) as Array<{ id: string }>;
  }
  if (recentIds.length >= limit) {
    return recentIds.map((row) => row.id);
  }

  // Endpoints use positive epoch timestamps (including legacy seconds). Only
  // databases with fewer endpoint-backed agents than the page size reach this
  // path. Keep the full COALESCE ordering here so zero/negative legacy rows
  // still interleave with agents that have no endpoint exactly as before.
  const endpointUpdatedAtExpression = sqlTimestampMsExpression("ep.updated_at");
  const fallbackIds = database
    .prepare(
      `SELECT a.id
       FROM agents a
       JOIN actors ac ON ac.id = a.id
       ${LATEST_AGENT_ENDPOINT_JOIN}
       WHERE ${activeAgentMetadataPredicate("a")}
         AND COALESCE(${endpointUpdatedAtExpression}, 0) <= 0
       ORDER BY COALESCE(${endpointUpdatedAtExpression}, 0) DESC, ac.display_name ASC
       LIMIT ?`,
    )
    .all(limit - recentIds.length) as Array<{ id: string }>;
  return [...recentIds, ...fallbackIds].map((row) => row.id);
}

function queryAgentRowsByIds(agentIds: string[]): AgentQueryRow[] {
  if (agentIds.length === 0) return [];

  return db()
    .prepare(
      `${AGENT_ROW_SELECT}
       WHERE a.id IN (SELECT value FROM json_each(?))
         AND ${activeAgentMetadataPredicate("a")}
       ORDER BY COALESCE(${endpointUpdatedAtExpression}, 0) DESC, ac.display_name ASC`,
    )
    .all(JSON.stringify(agentIds)) as AgentQueryRow[];
}

/**
 * Latest endpoint session id → agent id, for joining pairing-session
 * attention items (which only know their session) to fleet agents.
 *
 * Session ids are not unique across agents (a re-registered agent can leave a
 * stale row claiming the same session), so rows are ordered oldest-first and
 * the most recently updated endpoint wins the map slot.
 */
export function queryAgentIdsByEndpointSessionId(): Map<string, string> {
  const endpointUpdatedAtExpression = sqlTimestampMsExpression("ep.updated_at");
  const rows = db()
    .prepare(
      `SELECT a.id, ep.session_id
       FROM agents a
       ${LATEST_AGENT_ENDPOINT_JOIN}
       WHERE ep.session_id IS NOT NULL
         AND ${activeAgentMetadataPredicate("a")}
       ORDER BY COALESCE(${endpointUpdatedAtExpression}, 0) ASC`,
    )
    .all() as Array<{ id: string; session_id: string }>;
  const map = new Map<string, string>();
  for (const row of rows) {
    const sessionId = row.session_id.trim();
    if (sessionId) {
      map.set(sessionId, row.id);
    }
  }
  return map;
}

export function queryAgents(limit = 500): WebAgent[] {
  const flightPhases = queryAgentFlightPhases();
  // SQLite's negative LIMIT means "all rows". Retain that uncommon caller
  // contract with the canonical full scan; normal bounded roster reads take
  // the indexed early-stop path.
  let rows: AgentQueryRow[];
  if (limit < 0) {
    rows = db()
      .prepare(
        `${AGENT_ROW_SELECT}
         WHERE ${activeAgentMetadataPredicate("a")}
         ORDER BY COALESCE(${endpointUpdatedAtExpression}, 0) DESC, ac.display_name ASC
         LIMIT ?`,
      )
      .all(limit) as AgentQueryRow[];
  } else {
    rows = queryAgentRowsByIds(queryAgentIdsForBoundedRoster(limit));
  }

  return mapAgentRows(
    rows,
    flightPhases,
    existingDirectConversationIdsForAgents(rows.map((row) => row.id)),
  );
}

export function queryAgentById(agentId: string): WebAgent | null {
  const flightPhases = queryAgentFlightPhases();
  const row = db()
    .prepare(
      `${AGENT_ROW_SELECT}
       WHERE a.id = ?
         AND ${activeAgentMetadataPredicate("a")}
       LIMIT 1`,
    )
    .get(agentId) as AgentQueryRow | null;

  return row
    ? mapAgentRows(
        [row],
        flightPhases,
        existingDirectConversationIdsForAgents([row.id]),
      )[0] ?? null
    : null;
}

function mapAgentRows(
  rows: AgentQueryRow[],
  flightPhases: Map<string, AgentFlightPhase>,
  conversationIdByAgentId: ReadonlyMap<string, string>,
): WebAgent[] {
  const rosterTags = rosterTagsForAgents(rows.map((row) => row.id));
  return rows.map((r) => {
    let capabilities: string[] = [];
    try { capabilities = r.capabilities_json ? JSON.parse(r.capabilities_json) : []; } catch {}

    let meta: Record<string, unknown> = {};
    try { meta = r.metadata_json ? JSON.parse(r.metadata_json) : {}; } catch {}

    let endpointMeta: Record<string, unknown> = {};
    try { endpointMeta = r.endpoint_metadata_json ? JSON.parse(r.endpoint_metadata_json) : {}; } catch {}

    const state = summarizeAgentState(r.state, flightPhases.get(r.id) ?? null);

    return {
      id: r.id,
      definitionId: r.definition_id,
      name: r.name,
      handle: r.handle,
      agentClass: r.agent_class,
      harness: r.harness,
      state,
      projectRoot: compact(r.project_root),
      cwd: compact(r.cwd),
      updatedAt: r.updated_at,
      createdAt: r.actor_created_at,
      transport: r.transport,
      selector: r.selector ?? metadataString(meta, "selector") ?? null,
      defaultSelector: r.default_selector ?? metadataString(meta, "defaultSelector") ?? null,
      nodeQualifier: r.node_qualifier ?? metadataString(meta, "nodeQualifier") ?? null,
      workspaceQualifier: r.workspace_qualifier ?? metadataString(meta, "workspaceQualifier") ?? null,
      wakePolicy: r.wake_policy,
      capabilities,
      project: (meta.project as string) ?? null,
      branch: (meta.branch as string) ?? null,
      role: (meta.role as string) ?? null,
      model: (meta.model as string) ?? metadataString(endpointMeta, "model"),
      reasoningEffort: metadataString(endpointMeta, "reasoningEffort")
        ?? metadataString(endpointMeta, "effort"),
      harnessSessionId: resolveHarnessSessionIdForAgent(r.transport, r.session_id, endpointMeta, state),
      terminalSurface: resolveTerminalSurface({
        transport: r.transport,
        endpointSessionId: r.session_id,
        metadata: endpointMeta,
      }),
      harnessLogPath: resolveHarnessLogPath(r.id, r.transport, r.session_id, endpointMeta),
      conversationId: conversationIdByAgentId.get(r.id) ?? null,
      authorityNodeId: r.authority_node_id,
      authorityNodeName: r.authority_node_name,
      homeNodeId: r.home_node_id,
      homeNodeName: r.home_node_name,
      ownerId: r.owner_id,
      ownerName: r.owner_name,
      ownerHandle: r.owner_handle,
      staleLocalRegistration: meta.staleLocalRegistration === true,
      retiredFromFleet: meta.retiredFromFleet === true,
      replacedByAgentId: metadataString(meta, "replacedByAgentId") ?? null,
      roster: rosterTags.get(r.id) ?? null,
    };
  });
}

/**
 * The roster tags (OS-003) of the agents that hold a number, read from the
 * runtime's roster tables. An agent that was deleted or retired, and whose
 * number has not been freed yet, has no tag.
 */
function rosterTagsForAgents(agentIds: string[]): Map<string, AgentRosterTag> {
  const tags = new Map<string, AgentRosterTag>();
  if (agentIds.length === 0) return tags;
  let rows: Array<{ agent_id: string; number: number; code: string | null }>;
  try {
    rows = db().prepare(
      `SELECT ra.agent_id, ra.number, rp.code
       FROM roster_agents ra
       LEFT JOIN roster_projects rp ON rp.project_key = ra.project_key
       WHERE ra.gone_at IS NULL
         AND ra.agent_id IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(agentIds)) as typeof rows;
  } catch (error) {
    // The web server can read a control-plane database that the runtime has
    // not migrated to the roster yet. Until it does, no agent has a code.
    if (error instanceof Error && error.message.includes("no such table")) return tags;
    throw error;
  }
  for (const row of rows) tags.set(row.agent_id, agentRosterTag({ number: row.number, projectCode: row.code }));
  return tags;
}
