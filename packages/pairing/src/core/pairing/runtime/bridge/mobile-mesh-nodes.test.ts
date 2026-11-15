import { describe, expect, test } from "bun:test";

import type { ScoutBrokerContext } from "../../../broker/service.ts";
import { getMobileMeshNodes } from "./mobile-mesh-nodes.ts";
import { buildMobileMeshNodes, meshHostKey, type MobileMeshNodesInput } from "./mobile-mesh-nodes-view.ts";
import { bridgeRouter } from "./router.ts";

const NOW = 1_800_000_000_000;

function input(overrides: Partial<MobileMeshNodesInput> = {}): MobileMeshNodesInput {
  return {
    localNodeId: "node-mini",
    nodes: {
      "node-mini": { id: "node-mini", name: "mini", hostName: "mini.local", lastSeenAt: NOW - 1_000 },
      // A stale record for the same host folds into the local one.
      "node-mini-old": { id: "node-mini-old", name: "Mini", hostName: "MINI", lastSeenAt: NOW - 90_000 },
      "node-air": { id: "node-air", name: "air", hostName: "air.local", brokerUrl: "http://air:43110", lastSeenAt: NOW - 5_000 },
    },
    agents: {
      builder: { id: "builder", displayName: "Builder", authorityNodeId: "node-mini" },
      reviewer: { id: "reviewer", displayName: "Reviewer", homeNodeId: "node-mini-old" },
      idle: { id: "idle", displayName: "Idle", authorityNodeId: "node-air" },
      retired: { id: "retired", displayName: "Retired", authorityNodeId: "node-air", metadata: { retiredFromFleet: true } },
      stray: { id: "stray", displayName: "Stray", authorityNodeId: "node-gone" },
    },
    endpoints: {
      "ep-builder": {
        id: "ep-builder",
        agentId: "builder",
        harness: "claude",
        projectRoot: "/Users/guest/dev/openscout",
        metadata: { branch: "main", lastSeenAt: NOW - 2_000 },
      },
    },
    flights: {
      "flight-builder": {
        id: "flight-builder",
        invocationId: "inv-builder",
        targetAgentId: "builder",
        state: "running",
        startedAt: NOW - 3_000,
      },
      "flight-reviewer-done": {
        id: "flight-reviewer-done",
        invocationId: "inv-reviewer",
        targetAgentId: "reviewer",
        state: "completed",
        startedAt: NOW - 60_000,
        completedAt: NOW - 30_000,
      },
    },
    invocations: {
      "inv-builder": { id: "inv-builder", task: "\n  Port mesh nodes to the web bridge\nsecond line" },
    },
    messages: {},
    now: NOW,
    ...overrides,
  } as MobileMeshNodesInput;
}

describe("buildMobileMeshNodes", () => {
  test("one node per host, local first, with attributed agents and working detail", () => {
    const result = buildMobileMeshNodes(input());

    expect(result.observedAt).toBe(NOW);
    expect(result.localNodeId).toBe("node-mini");
    expect(result.nodes.map((node) => node.host)).toEqual(["mini", "air"]);
    expect(result.unattributedAgents).toBe(1);

    const [mini, air] = result.nodes;
    expect(mini.id).toBe("node-mini");
    expect(mini.nodeIds).toEqual(["node-mini", "node-mini-old"]);
    expect(mini.isLocal).toBe(true);
    expect(mini.agents.total).toBe(2);
    expect(mini.agents.working).toBe(1);
    expect(mini.agents.lastActiveAt).toBe(NOW - 2_000);
    expect(mini.agents.workingAgents).toEqual([{
      id: "builder",
      title: "Builder",
      status: "Port mesh nodes to the web bridge",
      projectName: "openscout",
      branch: "main",
      harness: "claude",
      lastActiveAt: NOW - 2_000,
    }]);

    expect(air.isLocal).toBe(false);
    expect(air.brokerUrl).toBe("http://air:43110");
    expect(air.agents).toEqual({ total: 1, working: 0, lastActiveAt: null, workingAgents: [] });
  });

  test("normalizes host keys to the first DNS label", () => {
    expect(meshHostKey("Air.local")).toBe("air");
    expect(meshHostKey(" arts mini ")).toBe("arts-mini");
    expect(meshHostKey(null)).toBe("");
  });
});

describe("getMobileMeshNodes", () => {
  test("is null when the broker context can't be read", async () => {
    expect(await getMobileMeshNodes(async () => null)).toBeNull();
  });

  test("projects the broker snapshot with the broker's own node as local", async () => {
    const { nodes, agents, endpoints, flights, invocations, messages } = input();
    const context = {
      baseUrl: "http://127.0.0.1:0",
      node: { id: "node-mini" },
      snapshot: { nodes, agents, endpoints, flights, invocations, messages },
    } as unknown as ScoutBrokerContext;

    const result = await getMobileMeshNodes(async () => context);

    expect(result?.localNodeId).toBe("node-mini");
    expect(result?.nodes.map((node) => node.host)).toEqual(["mini", "air"]);
    expect(result?.nodes[0]?.agents.working).toBe(1);
  });
});

describe("bridgeRouter mobile.meshNodes", () => {
  test("is the query RPCWire maps mobile/mesh/nodes to", () => {
    const procedures = (bridgeRouter as unknown as {
      _def: { procedures: Record<string, { _def: { type: string } }> };
    })._def.procedures;
    expect(procedures["mobile.meshNodes"]?._def.type).toBe("query");
  });
});
