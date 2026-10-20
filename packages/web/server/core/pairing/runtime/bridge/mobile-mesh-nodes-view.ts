import { isDormantMeshNode } from "@openscout/runtime/mesh-peer-filter";
// The phone's view of the broker's mesh nodes (`mobile/mesh/nodes`).
//
// Pure: a projection of the broker snapshot's node registry, with the agents
// the broker attributes to each node. The same source `scout mesh nodes`
// reads. Kept free of I/O so it can be tested without a broker; the loader in
// mobile-mesh-nodes.ts feeds it.
//
// Attribution is the agent's `authorityNodeId` (falling back to
// `homeNodeId`) — the broker's own record of which node an agent lives on.
// Agents whose node isn't in the registry are counted, never guessed onto a
// host.
//
// NOTE: apps/desktop/src/core/pairing/runtime/bridge/mobile-mesh-nodes-view.ts
// is a copy (the bridge router lives in two copies); keep them in step.

import type {
  AgentDefinition,
  AgentEndpoint,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
  NodeDefinition,
} from "@openscout/protocol";

export type MobileMeshNodesInput = {
  all?: boolean;
  localNodeId: string | null;
  nodes: Record<string, NodeDefinition>;
  agents: Record<string, AgentDefinition>;
  endpoints: Record<string, AgentEndpoint>;
  flights: Record<string, FlightRecord>;
  invocations: Record<string, InvocationRequest>;
  messages: Record<string, MessageRecord>;
  now: number;
};

export type MobileMeshWorkingAgent = {
  id: string;
  title: string;
  /** What it was asked to do: the first line of its active flight's task. */
  status: string | null;
  projectName: string | null;
  branch: string | null;
  harness: string | null;
  lastActiveAt: number | null;
};

export type MobileMeshNode = {
  /** The kept record's node id. */
  id: string;
  /** Every node id folded into this host, kept record first. */
  nodeIds: string[];
  name: string;
  /** Normalized host key: lowercase, first DNS label (`air.local` → `air`). */
  host: string;
  hostName: string | null;
  brokerUrl: string | null;
  webHost: string | null;
  advertiseScope: string | null;
  lastSeenAt: number | null;
  /** The node this broker runs as. */
  isLocal: boolean;
  agents: {
    total: number;
    working: number;
    /** Latest activity across the host's agents (flights, endpoints, messages). */
    lastActiveAt: number | null;
    /** Up to three working agents, most recently active first. */
    workingAgents: MobileMeshWorkingAgent[];
  };
};

export type MobileMeshNodesResponse = {
  observedAt: number;
  localNodeId: string | null;
  nodes: MobileMeshNode[];
  /** Agents whose authority/home node is not in the registry. */
  unattributedAgents: number;
};

const WORKING_AGENTS_PER_NODE = 3;
const STATUS_MAX_LENGTH = 140;

export function meshHostKey(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim().replace(/^\.+|\.+$/g, "");
  const first = trimmed.split(".")[0] ?? trimmed;
  return first.toLowerCase().replace(/[\s_]+/g, "-");
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function metadataBoolean(metadata: Record<string, unknown> | undefined, key: string): boolean {
  return metadata?.[key] === true;
}

function toMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  // Seconds-epoch values are promoted; everything else is already ms.
  return value < 1e12 ? value * 1_000 : value;
}

function maxMs(values: Array<number | null | undefined>): number | null {
  let best: number | null = null;
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && (best === null || value > best)) best = value;
  }
  return best;
}

function isInactiveAgent(agent: AgentDefinition): boolean {
  return metadataBoolean(agent.metadata, "retiredFromFleet")
    || metadataBoolean(agent.metadata, "staleLocalRegistration");
}

function isInactiveEndpoint(endpoint: AgentEndpoint): boolean {
  return metadataBoolean(endpoint.metadata, "retiredFromFleet")
    || metadataBoolean(endpoint.metadata, "staleLocalRegistration");
}

function isActiveFlight(flight: FlightRecord): boolean {
  return flight.state === "running"
    || flight.state === "waiting"
    || flight.state === "queued"
    || flight.state === "waking";
}

function endpointActivityAt(endpoint: AgentEndpoint): number | null {
  const metadata = endpoint.metadata as Record<string, unknown> | undefined;
  return maxMs([
    toMs(metadata?.lastSeenAt),
    toMs(metadata?.lastEnsuredAt),
    toMs(metadata?.lastStartedAt),
    toMs(metadata?.lastCompletedAt),
    toMs(metadata?.lastFailedAt),
    toMs(metadata?.startedAt),
  ]);
}

function firstLine(text: string | null | undefined): string | null {
  const line = (text ?? "").split("\n").map((part) => part.trim()).find((part) => part.length > 0);
  if (!line) return null;
  return line.length > STATUS_MAX_LENGTH ? `${line.slice(0, STATUS_MAX_LENGTH - 1)}…` : line;
}

function basenameOf(path: string | null | undefined): string | null {
  const trimmed = (path ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  return trimmed.split("/").at(-1) || null;
}

/** Which of two records for the same host to keep: this broker's own node,
 * else the one seen most recently. */
function preferNode(a: NodeDefinition, b: NodeDefinition, localNodeId: string | null): NodeDefinition {
  if (a.id === localNodeId) return a;
  if (b.id === localNodeId) return b;
  const aSeen = toMs(a.lastSeenAt) ?? toMs(a.registeredAt) ?? 0;
  const bSeen = toMs(b.lastSeenAt) ?? toMs(b.registeredAt) ?? 0;
  if (aSeen !== bSeen) return aSeen > bSeen ? a : b;
  return a.id.localeCompare(b.id) <= 0 ? a : b;
}

export function buildMobileMeshNodes(input: MobileMeshNodesInput): MobileMeshNodesResponse {
  const { localNodeId, now } = input;

  // Hosts: one per normalized name, freshest record kept, every id folded in.
  const kept = new Map<string, NodeDefinition>();
  const idsByHost = new Map<string, string[]>();
  const hostByNodeId = new Map<string, string>();
  const hostByUrl = new Map<string, string>();
  const candidates = Object.values(input.nodes).sort((a, b) =>
    (b.lastSeenAt ?? b.registeredAt ?? 0) - (a.lastSeenAt ?? a.registeredAt ?? 0));
  for (const node of candidates) {
    if (!input.all && node.id !== localNodeId && isDormantMeshNode(node, now)) continue;
    const url = node.brokerUrl?.replace(/\/$/, "");
    const key = (url ? hostByUrl.get(url) : undefined) ?? meshHostKey(node.hostName || node.name || node.id);
    if (url) hostByUrl.set(url, key);
    if (!key) continue;
    hostByNodeId.set(node.id, key);
    idsByHost.set(key, [...(idsByHost.get(key) ?? []), node.id]);
    const existing = kept.get(key);
    kept.set(key, existing ? preferNode(existing, node, localNodeId) : node);
  }

  // Indexes, one pass each.
  const endpointsByAgent = new Map<string, AgentEndpoint[]>();
  const agentsWithEndpoints = new Set<string>();
  for (const endpoint of Object.values(input.endpoints)) {
    agentsWithEndpoints.add(endpoint.agentId);
    if (isInactiveEndpoint(endpoint)) continue;
    const list = endpointsByAgent.get(endpoint.agentId);
    if (list) list.push(endpoint); else endpointsByAgent.set(endpoint.agentId, [endpoint]);
  }
  const activeFlightByAgent = new Map<string, FlightRecord>();
  const flightActivityByAgent = new Map<string, number>();
  for (const flight of Object.values(input.flights)) {
    const at = maxMs([toMs(flight.completedAt), toMs(flight.startedAt)]);
    if (at !== null && at > (flightActivityByAgent.get(flight.targetAgentId) ?? 0)) {
      flightActivityByAgent.set(flight.targetAgentId, at);
    }
    if (!isActiveFlight(flight)) continue;
    const current = activeFlightByAgent.get(flight.targetAgentId);
    if (!current || (toMs(flight.startedAt) ?? 0) > (toMs(current.startedAt) ?? 0)) {
      activeFlightByAgent.set(flight.targetAgentId, flight);
    }
  }
  const messageActivityByActor = new Map<string, number>();
  for (const message of Object.values(input.messages)) {
    const at = toMs(message.createdAt);
    if (at !== null && at > (messageActivityByActor.get(message.actorId) ?? 0)) {
      messageActivityByActor.set(message.actorId, at);
    }
  }

  type Tally = { total: number; lastActiveAt: number | null; working: MobileMeshWorkingAgent[] };
  const tallies = new Map<string, Tally>();
  let unattributedAgents = 0;

  for (const agent of Object.values(input.agents)) {
    if (isInactiveAgent(agent)) continue;
    const endpoints = endpointsByAgent.get(agent.id) ?? [];
    // Same visibility rule as the phone's agent list: an agent whose every
    // endpoint is retired is gone; one with no endpoints here is kept.
    if (endpoints.length === 0 && agentsWithEndpoints.has(agent.id)) continue;
    const nodeId = agent.authorityNodeId || agent.homeNodeId;
    const host = nodeId ? hostByNodeId.get(nodeId) : undefined;
    if (!host) {
      unattributedAgents += 1;
      continue;
    }
    const lastActiveAt = maxMs([
      messageActivityByActor.get(agent.id),
      flightActivityByAgent.get(agent.id),
      ...endpoints.map(endpointActivityAt),
    ]);
    const tally = tallies.get(host) ?? { total: 0, lastActiveAt: null, working: [] };
    tally.total += 1;
    tally.lastActiveAt = maxMs([tally.lastActiveAt, lastActiveAt]);
    const flight = activeFlightByAgent.get(agent.id);
    if (flight) {
      const endpoint = endpoints[0];
      const invocation = input.invocations[flight.invocationId];
      tally.working.push({
        id: agent.id,
        title: agent.displayName,
        status: firstLine(invocation?.task) ?? firstLine(flight.summary),
        projectName: basenameOf(endpoint?.projectRoot ?? endpoint?.cwd ?? metadataString(agent.metadata, "projectRoot")),
        branch: metadataString(endpoint?.metadata as Record<string, unknown> | undefined, "branch")
          ?? metadataString(agent.metadata, "branch"),
        harness: endpoint?.harness ?? null,
        lastActiveAt,
      });
    }
    tallies.set(host, tally);
  }

  const nodes: MobileMeshNode[] = [...kept.entries()].map(([host, node]) => {
    const tally = tallies.get(host) ?? { total: 0, lastActiveAt: null, working: [] };
    const ids = idsByHost.get(host) ?? [node.id];
    const working = [...tally.working].sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) || a.title.localeCompare(b.title));
    return {
      id: node.id,
      nodeIds: [node.id, ...ids.filter((id) => id !== node.id)],
      name: node.name,
      host,
      hostName: node.hostName ?? null,
      brokerUrl: node.brokerUrl ?? null,
      webHost: node.webHost ?? null,
      advertiseScope: node.advertiseScope ?? null,
      lastSeenAt: toMs(node.lastSeenAt),
      isLocal: node.id === localNodeId,
      agents: {
        total: tally.total,
        working: working.length,
        lastActiveAt: tally.lastActiveAt,
        workingAgents: working.slice(0, WORKING_AGENTS_PER_NODE),
      },
    };
  }).sort((a, b) => Number(b.isLocal) - Number(a.isLocal) || a.host.localeCompare(b.host));

  return { observedAt: now, localNodeId, nodes, unattributedAgents };
}
