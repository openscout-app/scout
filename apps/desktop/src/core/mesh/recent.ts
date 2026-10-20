import { isDormantMeshNode, visibleMeshNodes } from "@openscout/runtime/mesh-peer-filter";
import { epochMs, type NodeDefinition } from "@openscout/protocol";
import { requestScoutBrokerJson } from "@openscout/runtime/broker-api";
import { resolveBrokerSocketPathForBaseUrl } from "@openscout/runtime/broker-process-manager";
import { httpMeshUrlsForNode } from "@openscout/runtime/mesh-dial-order";
import { createMeshPeerFetch, isMeshPeerTrustError, type MeshPeerFetch } from "@openscout/runtime/mesh-peer-client";
import {
  MESH_NODE_STATE_ROSTER_LIMIT,
  MESH_NODE_STATE_SESSION_LIMIT,
  MESH_NODE_STATE_WORK_LIMIT,
  type MeshNodeStateReport,
  type MeshNodeStateWork,
} from "@openscout/runtime/mesh-node-state";
import { resolveScoutBrokerUrl } from "../broker/service.ts";
import { resolveScoutMachines } from "./machine-selector.ts";

export const RECENT_TIMEOUT_MS = 3_000;
export const RECENT_SCOPE = "Node-state only: sessions and work must belong to a home agent; sessions without an agent are out of scope. Sessions have no timestamp.";
const NODE_STATE_PATH = "/v1/mesh/node-state";

export type ScoutRecentEntry = {
  kind: "agent" | "session" | "work";
  id: string;
  agentId: string;
  nodeId: string;
  nodeName: string | null;
  projectRoot: string | null;
  harness: string | null;
  sessionId: string | null;
  state: string;
  timestamp: number | null;
  timestampKind: "lastSeenAt" | "startedAt" | "completedAt" | null;
  workId: string | null;
  workTitle: string | null;
  workState: string | null;
};

type Coverage = { returned: number; total: number; truncated: boolean };
export type ScoutRecentMachine = {
  nodeId: string;
  nodeName: string | null;
  local: boolean;
} & ({
  status: "ok";
  observedAt: number;
  coverage: { agents: Coverage; sessions: Coverage; work: Coverage };
  entries: ScoutRecentEntry[];
  noTimestamp: ScoutRecentEntry[];
} | {
  status: "unavailable";
  error: string;
});

export type ScoutRecentReport = {
  since: number | null;
  scope: string;
  machines: ScoutRecentMachine[];
};

function recentTimestamp(value: unknown): number | null {
  const timestamp = epochMs(value);
  return timestamp !== null && Number.isFinite(new Date(timestamp).getTime()) ? timestamp : null;
}

function workTime(work: MeshNodeStateWork | undefined): Pick<ScoutRecentEntry, "timestamp" | "timestampKind"> {
  const completedAt = recentTimestamp(work?.completedAt);
  const startedAt = recentTimestamp(work?.startedAt);
  if (completedAt !== null && (startedAt === null || completedAt >= startedAt)) {
    return { timestamp: completedAt, timestampKind: "completedAt" };
  }
  return { timestamp: startedAt, timestampKind: startedAt === null ? null : "startedAt" };
}

/** Join only this live response, never second-hand snapshot activity. */
export function projectScoutRecentEntries(report: MeshNodeStateReport): ScoutRecentEntry[] {
  // Prefer in-flight work, then the latest reported work time. Old peers need
  // not return these in priority order. Collapse only exact agent-id joins.
  const workByAgent = new Map<string, MeshNodeStateWork>();
  const working = (work: MeshNodeStateWork) => ["queued", "waking", "running", "waiting"].includes(work.state);
  for (const work of [...report.work.items].sort((a, b) =>
    Number(working(b)) - Number(working(a)) || (workTime(b).timestamp ?? 0) - (workTime(a).timestamp ?? 0))) {
    if (!workByAgent.has(work.targetAgentId)) workByAgent.set(work.targetAgentId, work);
  }
  const rosterIds = new Set(report.roster.map((agent) => agent.id));
  const sessionsComplete = !coverage(report.sessions.items.length, report.sessions.total, report.sessions.truncated, MESH_NODE_STATE_SESSION_LIMIT).truncated;
  const base = (agentId: string) => {
    const agent = report.roster.find((item) => item.id === agentId);
    const sessions = report.sessions.items.filter((item) => item.agentId === agentId);
    // A cap may hide additional sessions; never infer uniqueness from that subset.
    const session = sessionsComplete && sessions.length === 1 ? sessions[0] : undefined;
    const work = workByAgent.get(agentId);
    return {
      agentId, nodeId: report.nodeId, nodeName: report.name,
      projectRoot: agent?.projectRoot ?? session?.projectRoot ?? null,
      harness: session?.harness ?? null, sessionId: session?.sessionId ?? null,
      workId: work?.id ?? null, workTitle: work?.summary ?? null, workState: work?.state ?? null,
    };
  };
  return [
    ...report.roster.map((agent): ScoutRecentEntry => {
      const lastSeenAt = recentTimestamp(agent.lastSeenAt);
      const work = workTime(workByAgent.get(agent.id));
      return {
        ...base(agent.id), kind: "agent", id: agent.id, state: agent.state,
        ...(lastSeenAt === null || (work.timestamp !== null && work.timestamp > lastSeenAt)
          ? work
          : { timestamp: lastSeenAt, timestampKind: "lastSeenAt" }),
      };
    }),
    ...report.sessions.items.map((session): ScoutRecentEntry => ({
      ...base(session.agentId), kind: "session", id: session.id, state: session.state,
      projectRoot: session.projectRoot ?? base(session.agentId).projectRoot,
      harness: session.harness, sessionId: session.sessionId,
      // observedAt and the owning agent's lastSeenAt are not session activity.
      timestamp: null, timestampKind: null,
      workId: null, workTitle: null, workState: null,
    })),
    ...report.work.items.filter((work) => !rosterIds.has(work.targetAgentId)).map((work): ScoutRecentEntry => ({
      ...base(work.targetAgentId), kind: "work", id: work.id, state: work.state,
      ...workTime(work), workId: work.id, workTitle: work.summary, workState: work.state,
    })),
  ];
}

function coverage(returned: number, total: number, truncated: boolean, cap: number): Coverage {
  // Older peers report false at exactly the cap. Never present that as complete.
  return { returned, total, truncated: truncated || total > returned || returned >= cap };
}

function requireNodeState(value: unknown, nodeId: string): MeshNodeStateReport {
  const report = value as MeshNodeStateReport | undefined;
  if (report?.kind !== "mesh-node-state" || report.version !== 1
    || !Array.isArray(report.roster) || !Array.isArray(report.sessions?.items)
    || !Array.isArray(report.work?.items) || typeof report.workload?.total !== "number") {
    throw new Error("invalid or unsupported node-state response");
  }
  if (report.nodeId !== nodeId) {
    throw new Error(`node-state identity mismatch: expected ${nodeId}, received ${report.nodeId}`);
  }
  return report;
}

function isTimeoutError(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; current = (current as { cause?: unknown }).cause, depth += 1) {
    const name = (current as { name?: unknown }).name;
    if (name === "TimeoutError") return true;
    if (current instanceof Error && /^no answer in \d/.test(current.message)) return true;
  }
  return false;
}

/** Bound the whole machine read, including card probes, URL retries and JSON. */
async function withinDeadline<T>(timeoutMs: number, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`no answer in ${timeoutMs / 1_000}s`);
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([read(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export type ScoutRecentDeps = {
  brokerUrl?: string;
  readLocal?: (path: string, signal: AbortSignal) => Promise<unknown>;
  peerFetch?: MeshPeerFetch;
  timeoutMs?: number;
  inventory?: ScoutMachineInventory;
};

export type ScoutMachineInventory = { localNode: NodeDefinition; knownNodes: Record<string, NodeDefinition> };

function recentReader(deps: ScoutRecentDeps) {
  const brokerUrl = deps.brokerUrl ?? resolveScoutBrokerUrl();
  return deps.readLocal ?? ((path: string, signal: AbortSignal) => requestScoutBrokerJson(brokerUrl, path, {
    signal, socketPath: resolveBrokerSocketPathForBaseUrl(brokerUrl),
  }));
}

export async function loadScoutMachineInventory(deps: ScoutRecentDeps = {}): Promise<ScoutMachineInventory> {
  if (deps.inventory) return deps.inventory;
  const readLocal = recentReader(deps);
  const [localNode, knownNodes] = await withinDeadline(deps.timeoutMs ?? RECENT_TIMEOUT_MS, (signal) => Promise.all([
    readLocal("/v1/node", signal) as Promise<NodeDefinition>,
    readLocal("/v1/mesh/nodes", signal) as Promise<Record<string, NodeDefinition>>,
  ]));
  if (!localNode?.id || !knownNodes || typeof knownNodes !== "object") {
    throw new Error("Local broker returned no machine inventory; check coverage is unknown.");
  }
  return { localNode, knownNodes };
}

export type ScoutMachineNodeState = {
  node: NodeDefinition;
  nodeId: string;
  nodeName: string | null;
  local: boolean;
} & ({ status: "ok"; report: MeshNodeStateReport } | { status: "unavailable"; error: string });

export type ScoutMachineNodeStateOptions = { all?: boolean; machine?: string; nodeIds?: string[]; projectRoot?: string; agentId?: string };

/**
 * Read node-state from every machine this broker knows (or the selected ones),
 * each under its own deadline. Shared by `scout check`, `scout hosts` and
 * route_context through the mesh overview. This is the owner of their 3s
 * per-host probe; inventory evidence shaping never performs this request.
 * Dormant records stay in the inventory but only an explicit name probes them.
 */
export async function loadMachineNodeStates(
  options: ScoutMachineNodeStateOptions = {},
  deps: ScoutRecentDeps = {},
): Promise<{ localNodeId: string; machines: ScoutMachineNodeState[] }> {
  const timeoutMs = deps.timeoutMs ?? RECENT_TIMEOUT_MS;
  const readLocal = recentReader(deps);
  const peerFetch = deps.peerFetch ?? createMeshPeerFetch({ log: () => {} });
  const { localNode, knownNodes } = await loadScoutMachineInventory(deps);
  const nodes = Object.values({ ...knownNodes, [localNode.id]: localNode });
  const selected = (options.machine ? resolveScoutMachines(nodes, options.machine) : Object.values(visibleMeshNodes(Object.fromEntries(nodes.map(node => [node.id, node])), { localNodeId: localNode.id, all: options.all })))
    .filter((node) => !options.nodeIds || options.nodeIds.includes(node.id));
  const query = new URLSearchParams();
  if (options.projectRoot) query.set("projectRoot", options.projectRoot);
  if (options.agentId) query.set("agentId", options.agentId);
  const path = NODE_STATE_PATH + (query.size ? `?${query}` : "");
  const machines = await Promise.all(selected.map(async (node): Promise<ScoutMachineNodeState> => {
    const identity = { node, nodeId: node.id, nodeName: node.name ?? null, local: node.id === localNode.id };
    if (!options.machine && !identity.local && isDormantMeshNode(node)) {
      return { ...identity, status: "unavailable", error: `dormant; last seen ${Math.floor((Date.now() - (node.lastSeenAt ?? node.registeredAt ?? 0)) / 86400000)} days ago; run scout mesh ping ${node.name ?? node.id} to probe explicitly` };
    }
    try {
      const report = await withinDeadline(timeoutMs, async (signal) => {
        if (identity.local) return requireNodeState(await readLocal(path, signal), node.id);
        const urls = httpMeshUrlsForNode(node);
        let error: unknown = new Error("no mesh broker URL advertised");
        const deadline = performance.now() + timeoutMs;
        for (const [index, url] of urls.entries()) {
          signal.throwIfAborted();
          // Reserve a fair share of the existing whole-machine deadline for
          // every remaining route, including card verification and body reads.
          const remaining = urls.length - index;
          const candidateMs = Math.max(1, Math.floor((deadline - performance.now()) / remaining));
          try {
            const readCandidate = async (candidateSignal: AbortSignal) => {
              const response = await peerFetch(url, path, {
                signal: candidateSignal,
                headers: { accept: "application/json" },
              });
              if (!response.ok) {
                await response.body?.cancel();
                throw new Error(`node-state HTTP ${response.status}${response.status === 403 || response.status === 404 ? " (denied or unsupported)" : ""}`);
              }
              return requireNodeState(await response.json(), node.id);
            };
            return remaining === 1 ? await readCandidate(signal)
              : await withinDeadline(candidateMs, (candidateSignal) => readCandidate(AbortSignal.any([signal, candidateSignal])));
          } catch (cause) {
            if (isMeshPeerTrustError(cause)) throw cause;
            error = cause;
          }
        }
        throw error;
      });
      return { ...identity, status: "ok", report };
    } catch (error) {
      // An inner timeout (card probe, route candidate) is still this machine's
      // deadline. Report one stable message, not whichever timer fired first.
      const reported = isTimeoutError(error) ? new Error(`no answer in ${timeoutMs / 1_000}s`) : error;
      return { ...identity, status: "unavailable", error: (reported instanceof Error ? reported.message : String(reported)).replace(/\s+/g, " ").slice(0, 240) };
    }
  }));
  return { localNodeId: localNode.id, machines };
}

export type ScoutRecentOptions = ScoutMachineNodeStateOptions & { since?: number };
export async function loadScoutRecent(
  options: ScoutRecentOptions = {},
  deps: ScoutRecentDeps = {},
): Promise<ScoutRecentReport> {
  const { machines: states } = await loadMachineNodeStates(options, deps);
  const scoped = Boolean(options.projectRoot || options.agentId);
  const machines = states.map((state): ScoutRecentMachine => {
    const identity = { nodeId: state.nodeId, nodeName: state.nodeName, local: state.local };
    if (state.status === "unavailable") return { ...identity, status: "unavailable", error: state.error };
    const report = state.report;
    // Older brokers can ignore query parameters. Never relabel an unrelated
    // row as this topic; projectless orphan work remains outside a scoped read.
    const entries = projectScoutRecentEntries(report).filter((entry) =>
      (!options.projectRoot || entry.projectRoot === options.projectRoot)
      && (!options.agentId || entry.agentId === options.agentId));
    return {
      ...identity, status: "ok", observedAt: report.observedAt,
      coverage: {
        agents: coverage(report.roster.length, report.workload.total, report.workload.truncated, MESH_NODE_STATE_ROSTER_LIMIT),
        sessions: coverage(report.sessions.items.length, report.sessions.total, report.sessions.truncated, MESH_NODE_STATE_SESSION_LIMIT),
        work: coverage(report.work.items.length, report.work.total, report.work.truncated, MESH_NODE_STATE_WORK_LIMIT),
      },
      entries: entries.filter((entry) => entry.timestamp !== null && (options.since === undefined || entry.timestamp >= options.since))
        .sort((a, b) => b.timestamp! - a.timestamp!),
      noTimestamp: entries.filter((entry) => entry.timestamp === null),
    };
  });
  return { since: options.since ?? null, scope: RECENT_SCOPE + (scoped ? " Scoped by exact project/agent; older peers may cap before filtering." : ""), machines };
}
