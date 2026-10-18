import { expect, test } from "bun:test";
import type { NodeDefinition } from "@openscout/protocol";
import type { MeshNodeStateReport } from "@openscout/runtime/mesh-node-state";
import { loadRouteContext, type RouteContextDeps } from "./route-context.ts";

const node = { id: "mini-id", name: "mini", hostName: "mini.local" } as NodeDefinition;
function fixture(address: string | null = "sess.0123456789abcdef0123@mini"): RouteContextDeps {
  const report: MeshNodeStateReport = {
    kind: "mesh-node-state", version: 1, nodeId: node.id, meshId: null, name: node.name,
    hostName: node.hostName!, capabilities: [], observedAt: 123,
    workload: { total: 2, working: 1, available: 1, offline: 0, truncated: false },
    roster: [
      { id: "a", title: "Reviewer", role: null, projectRoot: "/scout", state: "working", statusLabel: "working", lastSeenAt: 123 },
      { id: "b", title: "Builder", role: null, projectRoot: "/elsewhere", state: "available", statusLabel: "available", lastSeenAt: 123 },
    ],
    sessions: { total: 2, truncated: false, items: [
      { id: "ep1", agentId: "a", harness: "codex", transport: "local", state: "active", sessionId: "native-1", address, projectRoot: "/scout" },
      { id: "ep2", agentId: "a", harness: "codex", transport: "local", state: "active", sessionId: "native-2", projectRoot: "/scout" },
    ] },
    work: { total: 1, running: 1, truncated: false, items: [{ id: "w", targetAgentId: "a", state: "running", summary: "Permissions fix", startedAt: 120, completedAt: null }] },
    projects: { total: 1, truncated: false, items: [{ root: "/scout", name: "scout", agents: 1, liveSessions: 2 }] },
  };
  return { live: async () => ({ localNodeId: "other", machines: [{ node, nodeId: node.id, nodeName: node.name, local: false, status: "ok", report }] }), history: () => [] };
}

test("one read retains distinct sessions, grounded remote addresses and payload evidence", async () => {
  const result = await loadRouteContext({ query: "permissions", machine: "mini" }, fixture());
  const machine = result.machines[0]!;
  if (machine.status !== "available") throw new Error("missing machine");
  expect(machine.candidates[0]?.id).toBe("a");
  expect(machine.candidates[0]?.matchedTerms).toEqual(["permissions"]);
  expect(machine.candidates[0]?.sessions).toHaveLength(2);
  expect(machine.candidates[0]?.sessions[0]?.continuation).toEqual({ to: "session:sess.0123456789abcdef0123@mini" });
  expect(machine.candidates[0]?.sessions[1]?.continuation).toBeNull();
  expect(machine.projects?.items[0]?.freshWork).toEqual({ on: "mini-id", projectPath: "/scout" });
  expect(result.policy.discoveryOnly).toBe(true);
});

test("older, malformed and wrong-authority addresses never produce a continuation", async () => {
  for (const address of [null, "native-id", "sess.0123456789abcdef0123@archie"]) {
    const result = await loadRouteContext({ query: "reviewer" }, fixture(address));
    const machine = result.machines[0]!;
    if (machine.status !== "available") throw new Error("missing machine");
    expect(machine.candidates[0]?.sessions[0]?.continuation).toBeNull();
  }
});

test("cardless sessions expose the same grounded continuation and work evidence", async () => {
  for (const address of ["sess.0123456789abcdef0123@mini", "sess.0123456789abcdef0123@archie", null]) {
    const deps = fixture(address);
    const read = deps.live;
    deps.live = async (scope) => {
      const result = await read(scope);
      const machine = result.machines[0]!;
      if (machine.status === "ok") machine.report.roster = [];
      return result;
    };
    const result = await loadRouteContext({ query: "permissions", machine: "mini", projectRoot: "/scout", agentId: "a" }, deps);
    const machine = result.machines[0]!;
    if (machine.status !== "available") throw new Error("missing machine");
    expect(machine.candidates).toEqual([]);
    const session = machine.unlinkedSessions[0]!;
    expect(session.matchedTerms).toEqual(["permissions"]);
    expect(session.work[0]?.id).toBe("w");
    expect(session.continuation).toEqual(address?.endsWith("@mini") ? { to: `session:${address}` } : null);
  }
});

test("scope is sent upstream and enforced against old peers ignoring filters", async () => {
  const deps = fixture();
  const read = deps.live;
  deps.live = async (scope) => { expect(scope).toEqual({ machine: "mini", projectRoot: "/scout", agentId: "a" }); return read(scope); };
  deps.history = (_query, scope) => { expect(scope).toEqual({ nodeIds: ["mini-id"], projectRoot: "/scout", agentId: "a" }); return []; };
  const result = await loadRouteContext({ query: "permissions", machine: "mini", projectRoot: "/scout", agentId: "a" }, deps);
  const machine = result.machines[0]!;
  if (machine.status !== "available") throw new Error("missing machine");
  expect(machine.candidates.map((c) => c.id)).toEqual(["a"]);
  // Preserve the source total so the reader sees that this was a bounded view.
  expect(machine.coverage.agents.total).toBe(2);
});

test("missing history preserves live evidence and failed machine lookup never broadens history", async () => {
  const deps = fixture();
  deps.history = () => { throw new Error("missing index"); };
  expect((await loadRouteContext({ query: "permissions" }, deps)).sourceErrors).toEqual(["Local routing index: Error: missing index"]);
  deps.live = async () => { throw new Error("Unknown machine"); };
  deps.history = () => [{ query: "permissions", candidates: [{ target: { nodeId: "other", projectRoot: "/scout" } }], coverage: {} } as never];
  const result = await loadRouteContext({ query: "permissions", machine: "typo" }, deps);
  expect(result.machines).toEqual([]);
  expect(result.history[0]?.candidates).toEqual([]);
  expect(result.sourceErrors).toEqual(["Live discovery: Error: Unknown machine"]);
});

test("duplicate machine matches and truncated coverage remain visible", async () => {
  const deps = fixture();
  const read = deps.live;
  deps.live = async (scope) => {
    const result = await read(scope);
    const first = result.machines[0]!;
    if (first.status === "ok") first.report.sessions.truncated = true;
    return { ...result, machines: [first, { node, nodeId: "mini-2", nodeName: "mini", local: false, status: "unavailable", error: "no answer" }] };
  };
  const result = await loadRouteContext({ query: "permissions", machine: "mini" }, deps);
  expect(result.machines).toHaveLength(2);
  const first = result.machines[0]!;
  if (first.status !== "available") throw new Error("missing machine");
  expect(first.coverage.sessions.truncated).toBe(true);
  expect(result.machines[1]?.status).toBe("unavailable");
});

test("native UI routes are local-only exact session-send targets, never fabricated broker continuations", async () => {
  const deps = fixture();
  deps.nativeApp = async () => ({ available: true, truncated: false, threads: [{ sessionId: "native-app", harness: "codex", title: "Review", cwd: "/scout", location: "native_codex_app", deliveryModes: ["draft", "submit"] }] });
  expect((await loadRouteContext({ query: "Review" }, deps)).nativeApp.threads).toMatchObject([{ send: { tool: "session_send", sessionId: "native-app" } }]);
  expect((await loadRouteContext({ query: "Review", machine: "mini" }, deps)).nativeApp.threads).toEqual([]);
  expect((await loadRouteContext({ query: "Review", projectRoot: "/other" }, deps)).nativeApp.threads).toEqual([]);
});
