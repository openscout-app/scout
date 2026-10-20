import { visibleMeshNodes } from "@openscout/runtime/mesh-peer-filter";
import type { NodeDefinition } from "@openscout/protocol";
import { meshPeerFetch } from "@openscout/runtime";
import { requestScoutBrokerJson } from "@openscout/runtime/broker-api";
import { httpMeshUrlsForNode, orderMeshDialUrls } from "@openscout/runtime/mesh-dial-order";
import { joinBrokerMesh, leaveBrokerMesh } from "@openscout/runtime/mesh-join";
import {
  type TailscalePeerCandidate,
} from "@openscout/runtime/mesh/tailscale";
import { execSystemFile, tailscaleStatusProbe } from "@openscout/runtime/system-probes";

import {
  readScoutBrokerHealth,
  loadScoutBrokerContext,
  resolveScoutBrokerUrl,
  type ScoutBrokerHealthState,
  type ScoutBrokerNodeRecord,
} from "../broker/service.ts";
import {
  listMeshEnrollmentSessions,
  listMeshTrustedPeers,
  readMeshNodeTrust,
} from "./trust-service.ts";

/* ── Types ── */

export type MeshStatusReport = {
  brokerUrl: string;
  health: ScoutBrokerHealthState;
  localNode: ScoutBrokerNodeRecord | null;
  meshId: string | null;
  nodes: Record<string, NodeDefinition>;
  tailscale: TailscaleStatus;
  trust: MeshTrustSection;
  warnings: string[];
};

/** Trust-cone summary for `scout mesh status` (docs/proposals/mesh-trust-cone.md §7). */
export type MeshTrustSection = {
  available: boolean;
  keyId: string | null;
  fingerprint: string | null;
  gateMode: string | null;
  peerCount: number;
  pendingEnrollments: number;
  error: string | null;
};

export type MeshDoctorReport = MeshStatusReport & {
  envVars: MeshEnvVars;
};

export type MeshDiscoverReport = {
  brokerUrl: string;
  discovered: NodeDefinition[];
  probes: string[];
  tailscalePeers: TailscalePeerCandidate[];
};

export type MeshPingReport = {
  target: string;
  url: string;
  reachable: boolean;
  latencyMs: number;
  node: NodeDefinition | null;
  meshIdMatch: boolean;
  localMeshId: string | null;
  error: string | null;
};

export type TailscaleStatus = {
  available: boolean;
  running: boolean;
  backendState: string | null;
  health: string[];
  peers: TailscalePeerCandidate[];
  onlineCount: number;
};

export type MeshJoinReport = MeshStatusReport & {
  discovery: {
    discoveredCount: number;
    probes: string[];
    error: string | null;
  };
};

export type MeshEnvVars = {
  meshId: string | null;
  meshSeeds: string | null;
  brokerHost: string | null;
  brokerPort: string | null;
  brokerUrl: string | null;
  advertiseScope: string | null;
  nodeId: string | null;
  nodeName: string | null;
  discoveryIntervalMs: string | null;
};

/* ── Helpers ── */

function isLoopbackBrokerUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
  } catch {
    return false;
  }
}

function readMeshEnvVars(): MeshEnvVars {
  return {
    meshId: process.env.OPENSCOUT_MESH_ID ?? null,
    meshSeeds: process.env.OPENSCOUT_MESH_SEEDS ?? null,
    brokerHost: process.env.OPENSCOUT_BROKER_HOST ?? null,
    brokerPort: process.env.OPENSCOUT_BROKER_PORT ?? null,
    brokerUrl: process.env.OPENSCOUT_BROKER_URL ?? null,
    advertiseScope: process.env.OPENSCOUT_ADVERTISE_SCOPE ?? null,
    nodeId: process.env.OPENSCOUT_NODE_ID ?? null,
    nodeName: process.env.OPENSCOUT_NODE_NAME ?? null,
    discoveryIntervalMs: process.env.OPENSCOUT_MESH_DISCOVERY_INTERVAL_MS ?? null,
  };
}

async function readTailscaleStatus(): Promise<TailscaleStatus> {
  const summary = tailscaleStatusProbe.read().value;
  const peers = summary?.peers ?? [];
  return {
    available: summary !== null,
    running: summary?.running ?? false,
    backendState: summary?.backendState ?? null,
    health: summary?.health ?? [],
    peers,
    onlineCount: peers.filter((p) => p.online).length,
  };
}

function computeWarnings(
  health: ScoutBrokerHealthState,
  localNode: ScoutBrokerNodeRecord | null,
  nodes: Record<string, NodeDefinition>,
  tailscale: TailscaleStatus,
): string[] {
  const warnings: string[] = [];

  if (!health.reachable) {
    warnings.push("Broker is not reachable. Run `scout setup` to start it.");
    return warnings;
  }

  if (localNode?.advertiseScope === "local") {
    warnings.push(
      "Node advertise scope is `local` — peers will not discover this broker. " +
      "Run `scout mesh join` to announce, discover peers, and sync their agents.",
    );
  } else if (localNode?.advertiseScope === "mesh" && localNode.brokerUrl && isLoopbackBrokerUrl(localNode.brokerUrl)) {
    warnings.push(
      "Broker advertises mesh scope but is bound to loopback — peers cannot reach it. " +
      "Unset OPENSCOUT_BROKER_HOST (mesh default is 0.0.0.0) or use your Tailscale IP.",
    );
  }

  if (tailscale.available && !tailscale.running) {
    warnings.push(
      "Tailscale is installed but currently stopped on this machine. " +
      "Cached peers may appear, but the broker cannot reach them until Tailscale is running.",
    );
  }

  const remoteNodes = Object.values(nodes).filter((n) => n.id !== localNode?.id);

  if (!tailscale.available && remoteNodes.length === 0) {
    warnings.push(
      "No Tailscale peers found and no mesh seeds configured. " +
      "Install Tailscale or set OPENSCOUT_MESH_SEEDS.",
    );
  }

  return warnings;
}

/* ── Public API ── */

async function loadMeshTrustSection(
  brokerUrl: string,
  brokerReachable: boolean,
): Promise<MeshTrustSection> {
  const unavailable = (error: string | null): MeshTrustSection => ({
    available: false,
    keyId: null,
    fingerprint: null,
    gateMode: null,
    peerCount: 0,
    pendingEnrollments: 0,
    error,
  });
  if (!brokerReachable) {
    return unavailable("broker is not reachable");
  }
  try {
    const [nodeTrust, peers, sessions] = await Promise.all([
      readMeshNodeTrust(brokerUrl),
      listMeshTrustedPeers(brokerUrl),
      listMeshEnrollmentSessions(brokerUrl),
    ]);
    return {
      available: true,
      keyId: nodeTrust.card?.keyId ?? null,
      fingerprint: nodeTrust.card?.fingerprint ?? null,
      gateMode: nodeTrust.gateMode,
      peerCount: peers.length,
      pendingEnrollments: sessions.filter(
        (session) => session.state === "pending" || session.state === "ready",
      ).length,
      error: null,
    };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

export async function loadMeshStatus(options: { all?: boolean } = {}): Promise<MeshStatusReport> {
  const brokerUrl = resolveScoutBrokerUrl();
  const [health, context, tailscale] = await Promise.all([
    readScoutBrokerHealth(brokerUrl),
    loadScoutBrokerContext(brokerUrl),
    readTailscaleStatus(),
  ]);

  const localNode = context?.node ?? null;
  const nodes = visibleMeshNodes(context?.snapshot.nodes ?? {}, { ...options, localNodeId: localNode?.id });
  const meshId = health.meshId ?? localNode?.meshId ?? null;
  const trust = await loadMeshTrustSection(brokerUrl, health.reachable);
  const warnings = computeWarnings(health, localNode, nodes, tailscale);

  return { brokerUrl, health, localNode, meshId, nodes, tailscale, trust, warnings };
}

export async function loadMeshDoctorReport(options: { all?: boolean } = {}): Promise<MeshDoctorReport> {
  const status = await loadMeshStatus(options);
  return { ...status, envVars: readMeshEnvVars() };
}

export async function runMeshDiscover(): Promise<MeshDiscoverReport> {
  const brokerUrl = resolveScoutBrokerUrl();
  const tailscalePeers = tailscaleStatusProbe.read().value?.peers ?? [];

  const result = await requestScoutBrokerJson<{ discovered: NodeDefinition[]; probes?: string[] }>(
    brokerUrl,
    "/v1/mesh/discover",
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: {},
      signal: AbortSignal.timeout(60_000),
    },
  );

  return {
    brokerUrl,
    discovered: result.discovered ?? [],
    probes: result.probes ?? [],
    tailscalePeers,
  };
}

async function waitForTailscaleRunning(timeoutMs = 12_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await readTailscaleStatus();
    if (status.running) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    tailscaleStatusProbe.invalidate("mesh.join");
  }
  return false;
}

type TailscaleOpenExec = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<unknown>;

export async function openTailscaleApp(exec: TailscaleOpenExec = execSystemFile): Promise<void> {
  if (process.platform !== "darwin") return;
  await exec("open", ["-a", "Tailscale"], { timeoutMs: 1_500 });
  tailscaleStatusProbe.invalidate("tailscale.start");
}

export async function runMeshJoin(): Promise<MeshJoinReport> {
  const brokerUrl = resolveScoutBrokerUrl();
  const tailscale = await readTailscaleStatus();
  if (tailscale.available && !tailscale.running) {
    try {
      await openTailscaleApp();
      await waitForTailscaleRunning();
    } catch {
      // Tailscale is a discovery path, not a prerequisite for an explicit
      // seed or LAN mesh. The status report below keeps its stopped warning.
    }
  }

  const discovery = await joinBrokerMesh(brokerUrl);
  const status = await loadMeshStatus();
  return {
    ...status,
    discovery: {
      discoveredCount: discovery.discovered.length,
      probes: discovery.probes,
      error: discovery.error,
    },
  };
}

export async function runMeshLeave(): Promise<MeshStatusReport> {
  const brokerUrl = resolveScoutBrokerUrl();
  await leaveBrokerMesh(brokerUrl);
  return loadMeshStatus();
}

export async function runMeshPing(target: string): Promise<MeshPingReport> {
  const brokerUrl = resolveScoutBrokerUrl();
  const context = await loadScoutBrokerContext(brokerUrl);
  const localMeshId = context?.node.meshId ?? null;

  // Resolve the target: URL, node id/name, or hostname. Try LAN before Tailscale.
  const probeUrls = resolveMeshPingUrls(target, context?.snapshot.nodes ?? {});
  const start = performance.now();
  let lastError: string | null = null;
  let lastUrl = probeUrls[0] ?? `http://${target}:43110`;

  for (const probeUrl of probeUrls) {
    lastUrl = probeUrl;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const response = await meshPeerFetch(probeUrl, "/v1/node", {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      clearTimeout(timeout);
      const latencyMs = Math.round(performance.now() - start);

      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        continue;
      }

      const node = await response.json() as NodeDefinition;
      return {
        target,
        url: probeUrl,
        reachable: true,
        latencyMs,
        node,
        meshIdMatch: localMeshId !== null && node.meshId === localMeshId,
        localMeshId,
        error: null,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    target,
    url: lastUrl,
    reachable: false,
    latencyMs: Math.round(performance.now() - start),
    node: null,
    meshIdMatch: false,
    localMeshId,
    error: lastError,
  };
}

function resolveMeshPingUrls(target: string, nodes: Record<string, NodeDefinition>): string[] {
  if (target.startsWith("http://") || target.startsWith("https://")) {
    return [target];
  }
  const matchedNode = Object.values(nodes).find(
    (n) => n.id === target || n.name === target || n.hostName === target,
  );
  if (matchedNode) {
    const urls = httpMeshUrlsForNode(matchedNode);
    if (urls.length > 0) return urls;
  }
  return orderMeshDialUrls([
    `https://${target}:43110`,
    `http://${target}:43110`,
  ]);
}

export async function loadMeshNodes(options: { all?: boolean } = {}): Promise<{
  brokerUrl: string;
  localNodeId: string | null;
  nodes: Record<string, NodeDefinition>;
}> {
  const brokerUrl = resolveScoutBrokerUrl();
  const context = await loadScoutBrokerContext(brokerUrl);
  return {
    brokerUrl,
    localNodeId: context?.node.id ?? null,
    nodes: visibleMeshNodes(context?.snapshot.nodes ?? {}, { ...options, localNodeId: context?.node.id }),
  };
}
