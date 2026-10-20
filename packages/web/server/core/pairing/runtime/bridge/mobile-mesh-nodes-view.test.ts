import { describe, expect, test } from "bun:test";

import { buildMobileMeshNodes, meshHostKey, type MobileMeshNodesInput } from "./mobile-mesh-nodes-view.ts";

const NOW = 1_790_800_000_000;
const HOUR = 3_600_000;

function node(id: string, name: string, lastSeenAt: number, extra: Record<string, unknown> = {}) {
  return { id, meshId: "openscout", name, hostName: name, advertiseScope: "mesh", registeredAt: lastSeenAt - HOUR, lastSeenAt, ...extra } as any;
}

function agent(id: string, nodeId: string, extra: Record<string, unknown> = {}) {
  return {
    id, kind: "agent", displayName: id, definitionId: id, agentClass: "general", capabilities: [],
    wakePolicy: "on_demand", homeNodeId: nodeId, authorityNodeId: nodeId, advertiseScope: "mesh", ...extra,
  } as any;
}

function input(partial: Partial<MobileMeshNodesInput>): MobileMeshNodesInput {
  return { localNodeId: null, nodes: {}, agents: {}, endpoints: {}, flights: {}, invocations: {}, messages: {}, now: NOW, ...partial };
}

describe("meshHostKey", () => {
  test("first DNS label, lowercased, spaces to dashes", () => {
    expect(meshHostKey("air.local")).toBe("air");
    expect(meshHostKey("Arts Mini")).toBe("arts-mini");
    expect(meshHostKey("mini.tail1e8e67.ts.net.")).toBe("mini");
  });
});

describe("buildMobileMeshNodes", () => {
  test("dedupes one host's records, keeping the freshest, and folds agents from every id", () => {
    const result = buildMobileMeshNodes(input({
      nodes: {
        "mini-openscout": node("mini-openscout", "mini", NOW - 150 * HOUR),
        "mini-local-openscout": node("mini-local-openscout", "mini", NOW - 1000),
      },
      agents: {
        a: agent("a", "mini-openscout"),
        b: agent("b", "mini-local-openscout"),
      },
    }));
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.id).toBe("mini-local-openscout");
    expect(result.nodes[0]!.nodeIds).toEqual(["mini-local-openscout", "mini-openscout"]);
    expect(result.nodes[0]!.agents.total).toBe(2);
  });

  test("the local node wins its host and sorts first", () => {
    const result = buildMobileMeshNodes(input({
      localNodeId: "arts-mini-openscout",
      nodes: {
        "zz-openscout": node("zz-openscout", "zz", NOW),
        "arts-mini-openscout": node("arts-mini-openscout", "arts-mini.local", NOW - 36 * HOUR),
        "arts-mini-2": node("arts-mini-2", "arts-mini", NOW),
      },
    }));
    expect(result.nodes.map((n) => n.id)).toEqual(["arts-mini-openscout", "zz-openscout"]);
    expect(result.nodes[0]!.isLocal).toBe(true);
  });

  test("working = an active flight; status is the task's first line; unattributed are counted", () => {
    const result = buildMobileMeshNodes(input({
      nodes: { n1: node("n1", "studio", NOW) },
      agents: {
        busy: agent("busy", "n1", { metadata: { branch: "main" } }),
        quiet: agent("quiet", "n1"),
        retired: agent("retired", "n1", { metadata: { retiredFromFleet: true } }),
        stray: agent("stray", "gone-node"),
      },
      endpoints: {
        e1: { id: "e1", agentId: "busy", nodeId: "n1", harness: "claude", transport: "tmux", state: "active", projectRoot: "/Users/x/dev/openscout" } as any,
      },
      flights: {
        f1: { id: "f1", invocationId: "i1", requesterId: "operator", targetAgentId: "busy", state: "running", startedAt: NOW - 1000 } as any,
        f2: { id: "f2", invocationId: "i2", requesterId: "operator", targetAgentId: "quiet", state: "completed", startedAt: NOW - 2 * HOUR, completedAt: NOW - HOUR } as any,
      },
      invocations: { i1: { id: "i1", task: "\n  run the tests\nthen report" } as any },
    }));
    const studio = result.nodes[0]!;
    expect(studio.agents.total).toBe(2);
    expect(studio.agents.working).toBe(1);
    expect(studio.agents.workingAgents[0]).toMatchObject({
      id: "busy", status: "run the tests", projectName: "openscout", branch: "main", harness: "claude",
    });
    expect(studio.agents.lastActiveAt).toBe(NOW - 1000);
    expect(result.unattributedAgents).toBe(1);
  });

  test("an agent whose every endpoint is retired is left out", () => {
    const result = buildMobileMeshNodes(input({
      nodes: { n1: node("n1", "studio", NOW) },
      agents: { gone: agent("gone", "n1") },
      endpoints: { e: { id: "e", agentId: "gone", nodeId: "n1", harness: "claude", transport: "tmux", state: "offline", metadata: { staleLocalRegistration: true } } as any },
    }));
    expect(result.nodes[0]!.agents.total).toBe(0);
  });
});

test("dormant visibility and URL aliases affect display only", () => {
  const stale = node("old", "old-name", NOW - 13 * 24 * HOUR, { brokerUrl: "https://peer" });
  const current = node("new", "new-name", NOW, { brokerUrl: "https://peer/" });
  const source = input({ nodes: { old: stale } });
  expect(buildMobileMeshNodes(source).nodes).toEqual([]);
  expect(buildMobileMeshNodes({ ...source, all: true }).nodes[0]?.id).toBe("old");
  const both = buildMobileMeshNodes(input({ all: true, nodes: { old: stale, new: current },
    agents: { a: agent("a", "old"), b: agent("b", "new") } }));
  expect(both.nodes).toHaveLength(1);
  expect(both.nodes[0]?.id).toBe("new");
  expect(both.nodes[0]?.nodeIds).toEqual(["new", "old"]);
  expect(both.nodes[0]?.agents.total).toBe(2);
  expect(stale.id).toBe("old");
});
