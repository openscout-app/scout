import { describe, expect, test } from "bun:test";
import type { NodeDefinition } from "@openscout/protocol";
import type { MeshNodeStateReport } from "@openscout/runtime/mesh-node-state";
import { loadScoutMeshOverview, renderScoutMeshOverviewLines } from "./overview.ts";
import type { ScoutRecentDeps } from "./recent.ts";

const mini = { id: "arts-mini-openscout", meshId: "openscout", name: "arts-mini", brokerUrl: "http://mini:43110" } as NodeDefinition;
const archie = { id: "archie-openscout", meshId: "openscout", name: "archie", brokerUrl: "http://archie:43110" } as NodeDefinition;
const hutch = { id: "hutch-openscout", meshId: "openscout", name: "hutch", brokerUrl: "http://hutch:43110" } as NodeDefinition;

function report(node: NodeDefinition, extra: Partial<MeshNodeStateReport> = {}): MeshNodeStateReport {
  return {
    kind: "mesh-node-state", version: 1, nodeId: node.id, name: node.name, hostName: null, meshId: "openscout",
    capabilities: [], observedAt: 1,
    workload: { total: 1, working: 0, available: 1, offline: 0, truncated: false },
    roster: [], sessions: { total: 0, truncated: false, items: [] },
    work: { total: 0, running: 0, truncated: false, items: [] },
    ...extra,
  };
}

function deps(peers: Record<string, MeshNodeStateReport | Error>): ScoutRecentDeps {
  return {
    timeoutMs: 50,
    readLocal: async (path) => {
      if (path === "/v1/node") return mini;
      if (path === "/v1/mesh/nodes") return { [archie.id]: archie, [hutch.id]: hutch };
      if (path === "/v1/mesh/node-state") return report(mini, { workload: { total: 3, working: 2, available: 0, offline: 1, truncated: false } });
      throw new Error(path);
    },
    peerFetch: async (url) => {
      const answer = peers[url];
      if (!answer || answer instanceof Error) throw answer ?? new Error("refused");
      return Response.json(answer);
    },
  };
}

describe("mesh overview", () => {
  test("names each machine by its --on label, lists projects, and gives the exact ask", async () => {
    const overview = await loadScoutMeshOverview({}, deps({
      "http://archie:43110": report(archie, {
        projects: { total: 2, truncated: false, items: [
          { root: "/home/guest/renders/arsenal-x", name: "arsenal-x", agents: 1, liveSessions: 1 },
          { root: "/home/guest/dev/peal", name: "peal", agents: 1, liveSessions: 0 },
        ] },
      }),
      "http://hutch:43110": new Error("node-state HTTP 403 (denied or unsupported)"),
    }));

    expect(overview.machines.map((machine) => [machine.host, machine.local, machine.reach])).toEqual([
      ["arts-mini", true, "answering"],
      ["archie", false, "answering"],
      ["hutch", false, "no_answer"],
    ]);
    const archieRow = overview.machines[1]!;
    if (archieRow.reach !== "answering") throw new Error("archie should answer");
    expect(archieRow.startWork).toBe('scout ask --on archie --project /home/guest/renders/arsenal-x --harness codex "<brief>"');
    const hutchRow = overview.machines[2]!;
    if (hutchRow.reach !== "no_answer") throw new Error("hutch should not answer");
    expect(hutchRow.next).toBe("scout mesh trust");

    const lines = renderScoutMeshOverviewLines(overview);
    expect(lines[0]).toBe("arts-mini (this machine): 2 working");
    expect(lines[1]).toBe("archie: quiet · projects: arsenal-x, peal");
    expect(lines[2]).toContain("hutch: no answer");
    expect(lines.at(-1)).toContain("Never ssh in");
  });

  test("an older peer without a project list says unknown, not empty", async () => {
    const overview = await loadScoutMeshOverview({ machine: "archie" }, deps({ "http://archie:43110": report(archie) }));
    const row = overview.machines[0]!;
    if (row.reach !== "answering") throw new Error("archie should answer");
    expect(row.projects).toBeUndefined();
    expect(row.startWork).toContain("--project <path on archie>");
  });
});
