/**
 * Compact node state — the observe-tier answer to "what is running on you?".
 *
 * Mesh trust cone §4: `GET /v1/home` is a local-tier route and must never be
 * widened, so a peer cannot read it even with a signed request. This is the
 * narrow remote-tier twin: node identity, plus bounded views of the three
 * things a Network viewer actually asks about a machine — who is registered
 * there, which sessions are live, and what work is in flight.
 *
 * What it deliberately does not carry: conversation and message bodies, flight
 * output, endpoint addresses, panes and working directories. Enough to see
 * what a machine is doing; not enough to mirror its registry or read its
 * traffic. Summaries are truncated, and every list is capped with the true
 * total reported alongside.
 *
 * A peer that predates this route refuses it — 404 where the route is simply
 * absent, 403 where a deny-by-default route matrix rejects a name it does not
 * know. Either way that is an honest `unsupported` reading, and callers must
 * render it as such rather than as an idle machine with zero agents.
 */

import type { AgentEndpoint, FlightRecord } from "@openscout/protocol";
import type { RuntimeRegistrySnapshot } from "./registry.js";
import { projectHomeAgents } from "./broker-home-service.js";
import { isWorkingFlightState } from "./broker-local-invocation-helpers.js";
import { isStaleLocalEndpoint } from "./broker-endpoint-selection.js";
import { runtimeSessionAddressForEndpoint } from "./runtime-session-address.js";

/** Bounded roster: enough to show what a machine is doing, never its whole registry. */
export const MESH_NODE_STATE_ROSTER_LIMIT = 24;
/** Sessions and work are shorter lists; a machine with more is summarised. */
export const MESH_NODE_STATE_SESSION_LIMIT = 16;
export const MESH_NODE_STATE_WORK_LIMIT = 16;
/**
 * Project roots are what a peer needs to start work here (`scout ask --on`),
 * so the list is longer than the roster but still capped.
 */
export const MESH_NODE_STATE_PROJECT_LIMIT = 64;
/** Free text crossing the mesh is clipped; this is a status line, not a log. */
const SUMMARY_MAX = 160;

export type MeshNodeStateAgent = {
  id: string;
  title: string;
  role: string | null;
  projectRoot: string | null;
  state: "offline" | "available" | "working";
  statusLabel: string;
  lastSeenAt: number | null;
};

export type MeshNodeStateSession = {
  id: string;
  /** Human-readable session label, including sessions without an agent card. */
  title?: string | null;
  /** Broker-issued exact conversation address. Older peers may omit it. */
  address?: string | null;
  agentId: string;
  /** Harness running the session, e.g. claude/codex. */
  harness: string | null;
  transport: string | null;
  state: string;
  /** The harness session handle, when there is one; never an address. */
  sessionId: string | null;
  projectRoot: string | null;
};

export type MeshNodeStateWork = {
  id: string;
  targetAgentId: string;
  state: string;
  /** Clipped one-liner; flight output is never carried. */
  summary: string | null;
  startedAt: number | null;
  completedAt: number | null;
};

export type MeshNodeStateProject = {
  /** Absolute repo root on this node: pass it as `--project` with `--on`. */
  root: string;
  /** Last path segment, for display. */
  name: string;
  /** Agents homed here that belong to this repo. */
  agents: number;
  /** Live sessions in this repo right now. */
  liveSessions: number;
};

export type MeshNodeStateReport = {
  /** Wire-shape version, so a client can tell an old twin from a new one. */
  kind: "mesh-node-state";
  version: 1;
  nodeId: string;
  meshId: string | null;
  name: string | null;
  hostName: string | null;
  capabilities: readonly string[];
  /** When this broker computed the report, by its own clock. */
  observedAt: number;
  workload: {
    total: number;
    working: number;
    available: number;
    offline: number;
    /** True at the roster cap (or beyond); totals stay exact. */
    truncated: boolean;
  };
  roster: MeshNodeStateAgent[];
  /** Live harness sessions on this node. */
  sessions: {
    total: number;
    truncated: boolean;
    items: MeshNodeStateSession[];
  };
  /** Work in flight against this node's agents. */
  work: {
    total: number;
    running: number;
    truncated: boolean;
    items: MeshNodeStateWork[];
  };
  /**
   * Repos this node knows, from its homed agents and sessions: where a peer can
   * start fresh work. Optional on the wire — peers older than this field omit
   * it, which means "unknown", never "no projects".
   */
  projects?: {
    total: number;
    truncated: boolean;
    items: MeshNodeStateProject[];
  };
};

export type MeshNodeStateDeps = {
  snapshot: () => RuntimeRegistrySnapshot;
  nodeId: string;
  meshId: string | null;
  actorDisplayName: (snapshot: RuntimeRegistrySnapshot, actorId: string) => string;
  /** Session names (operator, then current work); null keeps the endpoint's display name. */
  sessionNamer?: () => (endpoint: AgentEndpoint) => string | null;
  now?: () => number;
  rosterLimit?: number;
  sessionLimit?: number;
  workLimit?: number;
  projectLimit?: number;
};

/** Exact, conjunctive scope. Applied before any of the three caps. */
export type MeshNodeStateQuery = {
  projectRoot?: string;
  agentId?: string;
};

/**
 * Project this broker's own workloads.
 *
 * Scoped to agents homed here: a peer asking what runs on this machine must
 * not receive this broker's second-hand view of a third machine, which would
 * make one stale mirror look like live evidence on the asking node.
 */
export function readMeshNodeState(deps: MeshNodeStateDeps, query: MeshNodeStateQuery = {}): MeshNodeStateReport {
  const snapshot = deps.snapshot();
  const nameSession = deps.sessionNamer?.();
  const node = snapshot.nodes?.[deps.nodeId] ?? null;
  const limit = deps.rosterLimit ?? MESH_NODE_STATE_ROSTER_LIMIT;

  const nodeSessions = Object.values(snapshot.endpoints ?? {})
    .filter((endpoint) => endpoint.nodeId === deps.nodeId)
    .sort((a, b) => sessionRank(snapshot, b) - sessionRank(snapshot, a));
  const own = projectHomeAgents(snapshot, deps.actorDisplayName)
    .filter((agent) => agent.homeNodeId === deps.nodeId)
    .filter((agent) => !query.agentId || agent.id === query.agentId)
    // Do not use the home projection's cwd fallback, even for filtering.
    .filter((agent) => !query.projectRoot || repoRoot(snapshot, agent.id, nodeSessions) === query.projectRoot);

  const workload = { total: own.length, working: 0, available: 0, offline: 0 };
  for (const agent of own) {
    if (agent.state === "working") workload.working += 1;
    else if (agent.state === "available") workload.available += 1;
    else workload.offline += 1;
  }

  const ownAgentIds = new Set(own.map((agent) => agent.id));
  const sessionLimit = deps.sessionLimit ?? MESH_NODE_STATE_SESSION_LIMIT;
  const workLimit = deps.workLimit ?? MESH_NODE_STATE_WORK_LIMIT;

  // Sessions name their own node, so they are scoped directly rather than
  // inferred from the agent they serve.
  // Both lists are capped, so order decides what an operator actually sees.
  // Registry order is insertion order, which on a long-lived machine means the
  // oldest records — a live session or a running flight would fall off the end
  // behind a window of finished work. Rank before the cap: live first, then
  // most recent.
  const sessions = nodeSessions.filter((endpoint) => {
    if (ownAgentIds.has(endpoint.agentId)) return true;
    // Fresh Scout work is cardless. Its endpoint is the local authority;
    // absence from the home-screen agent roster must not erase the session.
    if (snapshot.agents[endpoint.agentId] || isStaleLocalEndpoint(snapshot, endpoint)) return false;
    return (!query.agentId || endpoint.agentId === query.agentId)
      && (!query.projectRoot || endpoint.projectRoot === query.projectRoot);
  });
  const workTargetIds = new Set([...ownAgentIds, ...sessions.map((endpoint) => endpoint.agentId)]);
  const work = Object.values(snapshot.flights ?? {})
    .filter((flight) => workTargetIds.has(flight.targetAgentId))
    .sort((a, b) => flightRank(b) - flightRank(a));

  const projects = projectList(snapshot, own.map((agent) => agent.id), sessions);
  const projectLimit = deps.projectLimit ?? MESH_NODE_STATE_PROJECT_LIMIT;

  return {
    kind: "mesh-node-state",
    version: 1,
    nodeId: deps.nodeId,
    meshId: deps.meshId ?? node?.meshId ?? null,
    name: node?.name ?? null,
    hostName: node?.hostName ?? null,
    capabilities: node?.capabilities ?? [],
    observedAt: deps.now?.() ?? Date.now(),
    workload: { ...workload, truncated: own.length >= limit },
    roster: own.slice(0, limit).map((agent) => ({
      id: agent.id,
      title: agent.title,
      role: agent.role,
      // The repo an agent belongs to, never a pane's working directory: the
      // home projection falls back to `endpoint.cwd`, and this route promises
      // not to carry that.
      projectRoot: repoRoot(snapshot, agent.id, sessions),
      state: agent.state,
      statusLabel: agent.statusLabel,
      lastSeenAt: agent.lastSeenAt,
    })),
    sessions: {
      total: sessions.length,
      truncated: sessions.length >= sessionLimit,
      items: sessions.slice(0, sessionLimit).map((endpoint) => ({
        id: endpoint.id,
        title: nameSession?.(endpoint)?.slice(0, SUMMARY_MAX)
          ?? (typeof endpoint.metadata?.displayName === "string"
            ? endpoint.metadata.displayName.slice(0, SUMMARY_MAX) : null),
        address: runtimeSessionAddressForEndpoint(snapshot, endpoint),
        agentId: endpoint.agentId,
        harness: endpoint.harness ?? null,
        transport: endpoint.transport ?? null,
        state: endpoint.state,
        sessionId: endpoint.sessionId ?? null,
        // `projectRoot` only — `cwd` is a pane detail and stays home.
        projectRoot: endpoint.projectRoot ?? null,
      })),
    },
    work: {
      total: work.length,
      running: work.filter((flight) => isWorkingFlightState(flight.state)).length,
      truncated: work.length >= workLimit,
      items: work.slice(0, workLimit).map((flight) => ({
        id: flight.id,
        targetAgentId: flight.targetAgentId,
        state: flight.state,
        summary: clip(flight.summary),
        startedAt: flight.startedAt ?? null,
        completedAt: flight.completedAt ?? null,
      })),
    },
    projects: {
      total: projects.length,
      truncated: projects.length > projectLimit,
      items: projects.slice(0, projectLimit),
    },
  };
}

/**
 * One row per repo root, ranked by live sessions then agent count then name.
 * Built from declared repo roots only (agent metadata, session projectRoot),
 * never a pane's cwd — the same promise the roster makes.
 */
function projectList(
  snapshot: RuntimeRegistrySnapshot,
  agentIds: readonly string[],
  sessions: readonly AgentEndpoint[],
): MeshNodeStateProject[] {
  const rows = new Map<string, MeshNodeStateProject>();
  const row = (root: string) => {
    let existing = rows.get(root);
    if (!existing) {
      existing = { root, name: root.split("/").filter(Boolean).pop() ?? root, agents: 0, liveSessions: 0 };
      rows.set(root, existing);
    }
    return existing;
  };
  for (const agentId of agentIds) {
    const root = repoRoot(snapshot, agentId, sessions);
    if (root) row(root).agents += 1;
  }
  for (const endpoint of sessions) {
    if (endpoint.projectRoot && !isStaleLocalEndpoint(snapshot, endpoint)) row(endpoint.projectRoot).liveSessions += 1;
  }
  return [...rows.values()].sort((a, b) =>
    b.liveSessions - a.liveSessions || b.agents - a.agents || a.name.localeCompare(b.name));
}

/**
 * Timestamps sit on the record on some shapes and in `metadata` on others, so
 * recency is the newest of whichever are present rather than one named field.
 */
const RECENCY_KEYS = ["completedAt", "updatedAt", "startedAt", "lastSeenAt", "createdAt"] as const;

function recency(record: { metadata?: Record<string, unknown> }): number {
  const bag = record as unknown as Record<string, unknown>;
  let latest = 0;
  for (const key of RECENCY_KEYS) {
    const own = bag[key];
    const meta = record.metadata?.[key];
    if (typeof own === "number" && Number.isFinite(own)) latest = Math.max(latest, own);
    if (typeof meta === "number" && Number.isFinite(meta)) latest = Math.max(latest, meta);
  }
  return latest;
}

/** A session still attached outranks one that has ended; then most recent. */
function sessionRank(snapshot: RuntimeRegistrySnapshot, endpoint: AgentEndpoint): number {
  return (isStaleLocalEndpoint(snapshot, endpoint) ? 0 : 1e15) + recency(endpoint);
}

/** Work in flight outranks finished work; then most recent. */
function flightRank(flight: FlightRecord): number {
  return (isWorkingFlightState(flight.state) ? 1e15 : 0) + recency(flight);
}

/**
 * The repo an agent is registered against: its own card first, then a session's
 * declared `projectRoot`. Never `cwd` — a pane's working directory is a local
 * detail, and this route promises not to carry it.
 */
function repoRoot(
  snapshot: RuntimeRegistrySnapshot,
  agentId: string,
  sessions: readonly AgentEndpoint[],
): string | null {
  const declared = snapshot.agents?.[agentId]?.metadata?.projectRoot;
  if (typeof declared === "string" && declared.trim()) return declared;
  const session = sessions.find((endpoint) => endpoint.agentId === agentId && endpoint.projectRoot);
  return session?.projectRoot ?? null;
}

/** Status lines cross the mesh; logs and transcripts do not. */
function clip(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;
}
