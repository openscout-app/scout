import { describe, expect, test } from "bun:test";
import type { NodeDefinition } from "@openscout/protocol";

import { collectCurrentMeshPeerNodes, isCurrentMeshPeerNode, MESH_PEER_STALE_MS } from "./mesh-peer-filter.ts";

function node(input: Partial<NodeDefinition> = {}): NodeDefinition {
  const now = Date.now();
  return {
    id: "peer-node",
    meshId: "openscout",
    name: "peer",
    advertiseScope: "mesh",
    brokerUrl: "https://peer.test:43110",
    capabilities: ["broker"],
    registeredAt: now,
    lastSeenAt: now,
    ...input,
  };
}

describe("mesh-peer-filter", () => {
  test("keeps only live, reachable peers from the current mesh", () => {
    const localNodeId = "local-node";
    const live = node({ id: "live-peer" });
    const stale = node({
      id: "stale-peer",
      lastSeenAt: Date.now() - MESH_PEER_STALE_MS - 1,
    });
    const local = node({ id: localNodeId, brokerUrl: "https://local.test:43110" });
    const wrongMesh = node({ id: "wrong-mesh", meshId: "another-mesh" });
    const localOnly = node({ id: "local-only", advertiseScope: "local" });
    const missingBrokerUrl = node({ id: "missing-url", brokerUrl: undefined });
    const peers = collectCurrentMeshPeerNodes({
      nodes: {
        [live.id]: live,
        [stale.id]: stale,
        [local.id]: local,
        [wrongMesh.id]: wrongMesh,
        [localOnly.id]: localOnly,
        [missingBrokerUrl.id]: missingBrokerUrl,
      },
      localNodeId,
      meshId: "openscout",
    });
    expect(peers.map((peer) => peer.id)).toEqual(["live-peer"]);
    expect(isCurrentMeshPeerNode(live, { localNodeId, meshId: "openscout" })).toBe(true);
    expect(isCurrentMeshPeerNode(stale, { localNodeId, meshId: "openscout" })).toBe(false);
    expect(isCurrentMeshPeerNode(wrongMesh, { localNodeId, meshId: "openscout" })).toBe(false);
    expect(isCurrentMeshPeerNode(localOnly, { localNodeId, meshId: "openscout" })).toBe(false);
    expect(isCurrentMeshPeerNode(missingBrokerUrl, { localNodeId, meshId: "openscout" })).toBe(false);
  });
});

import { isDormantMeshNode, visibleMeshNodes, MESH_HOST_DORMANT_MS } from "./mesh-peer-filter.js";
test("dormancy boundary and display dedup do not mutate discovery or routing", () => {
  const now = Date.now();
  const old = { id: "old", name: "old", brokerUrl: "https://host", lastSeenAt: now - MESH_HOST_DORMANT_MS } as NodeDefinition;
  const fresh = { ...old, id: "fresh", lastSeenAt: now };
  expect(isDormantMeshNode(old, now - 1)).toBe(false);
  expect(isDormantMeshNode(old, now)).toBe(true);
  expect(visibleMeshNodes({ old }, { now })).toEqual({});
  expect(visibleMeshNodes({ old }, { now, all: true })).toEqual({ old });
  expect(visibleMeshNodes({ old, fresh }, { now, all: true })).toEqual({ fresh });
  expect(old.id).toBe("old");
});
