import type { NodeDefinition } from "@openscout/protocol";

/** Peers older than this are ignored for sync, pinning, and mesh status lists. */
export const MESH_PEER_STALE_MS = 24 * 60 * 60 * 1000;

export function isCurrentMeshPeerNode(
  node: NodeDefinition,
  options: { localNodeId: string; meshId?: string | null; now?: number },
): boolean {
  if (!node.brokerUrl?.trim()) return false;
  if (node.id === options.localNodeId) return false;
  if (node.advertiseScope !== "mesh") return false;
  const meshId = options.meshId;
  if (meshId && node.meshId !== meshId) return false;
  const now = options.now ?? Date.now();
  const lastSeen = node.lastSeenAt ?? node.registeredAt ?? 0;
  if (lastSeen > 0 && now - lastSeen > MESH_PEER_STALE_MS) return false;
  return true;
}

export function collectCurrentMeshPeerNodes(input: {
  nodes: Record<string, NodeDefinition>;
  localNodeId: string;
  meshId?: string | null;
  now?: number;
}): NodeDefinition[] {
  return Object.values(input.nodes).filter((node) => isCurrentMeshPeerNode(node, input));
}

export function currentMeshPeerNodeIds(input: {
  nodes: Record<string, NodeDefinition>;
  localNodeId: string;
  meshId?: string | null;
  now?: number;
}): Set<string> {
  return new Set(collectCurrentMeshPeerNodes(input).map((node) => node.id));
}

/** Visibility is deliberately independent of the 24-hour routing policy. */
export const MESH_HOST_DORMANT_MS = 7 * 24 * 60 * 60 * 1000;
export function isDormantMeshNode(node: NodeDefinition, now = Date.now()): boolean {
  const seen = node.lastSeenAt ?? node.registeredAt;
  return typeof seen === "number" && now - seen >= MESH_HOST_DORMANT_MS;
}

/** Display projection only: never use URL deduplication to resolve trust. */
export function visibleMeshNodes(nodes: Record<string, NodeDefinition>, options: {
  localNodeId?: string | null; all?: boolean; now?: number;
} = {}): Record<string, NodeDefinition> {
  const byUrl = new Map<string, NodeDefinition>();
  for (const node of Object.values(nodes)) {
    if (!options.all && node.id !== options.localNodeId && isDormantMeshNode(node, options.now)) continue;
    const key = node.brokerUrl?.replace(/\/$/, "") || node.id;
    const prior = byUrl.get(key);
    if (!prior || (node.lastSeenAt ?? node.registeredAt ?? 0) > (prior.lastSeenAt ?? prior.registeredAt ?? 0)) byUrl.set(key, node);
  }
  return Object.fromEntries([...byUrl.values()].map(node => [node.id, node]));
}
