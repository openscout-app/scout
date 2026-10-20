import { describe, expect, test } from "bun:test";
import type { NodeDefinition } from "@openscout/protocol";
import { PeerCardVerificationError, PeerTlsPinError } from "@openscout/runtime/mesh-peer-client";
import type { MeshNodeStateReport } from "@openscout/runtime/mesh-node-state";
import { createScoutCommandContext } from "../../cli/context.ts";
import { renderScoutRecent } from "../../ui/terminal/recent.ts";
import { loadScoutRecent, projectScoutRecentEntries, type ScoutRecentDeps } from "./recent.ts";

const now = 1_800_000_000_000;
const mini = { id: "mini-id", name: "arts-mini", hostName: "arts-mini.local", brokerUrl: "http://advertised-mini:43110" } as NodeDefinition;
const archie = { id: "archie-id", name: "archie", brokerUrl: "http://archie:43110", lastSeenAt: Date.now() } as NodeDefinition;

function state(node = mini): MeshNodeStateReport {
  return {
    kind: "mesh-node-state", version: 1, nodeId: node.id, name: node.name, hostName: node.hostName ?? null,
    meshId: "mesh", capabilities: [], observedAt: now,
    workload: { total: 2, working: 1, available: 0, offline: 1, truncated: false },
    roster: [
      { id: "agent-1", title: "Agent", role: null, projectRoot: "/work/project", state: "working", statusLabel: "working", lastSeenAt: now - 1_000 },
      { id: "old-agent", title: "Old", role: null, projectRoot: "/different/project", state: "offline", statusLabel: "offline", lastSeenAt: now - 10_000 },
    ],
    sessions: { total: 1, truncated: false, items: [{ id: "endpoint-1", agentId: "agent-1", harness: "codex", transport: "codex_app_server", state: "active", sessionId: "session-1", projectRoot: "/work/project" }] },
    work: { total: 2, running: 1, truncated: false, items: [
      { id: "work-1", targetAgentId: "agent-1", state: "running", summary: "Implement P0", startedAt: now - 3_000, completedAt: null },
      { id: "work-old", targetAgentId: "old-agent", state: "completed", summary: "Old work", startedAt: now - 20_000, completedAt: now - 500 },
    ] },
  };
}

function fixture(peers: NodeDefinition[] = [archie], report = state()) {
  const calls: string[] = [];
  const deps: ScoutRecentDeps = {
    timeoutMs: 30,
    readLocal: async (path) => {
      calls.push(`local ${path}`);
      if (path === "/v1/node") return mini;
      if (path === "/v1/mesh/nodes") return Object.fromEntries([mini, ...peers].map((node) => [node.id, node]));
      if (path === "/v1/mesh/node-state") return report;
      throw new Error(`unexpected local path ${path}`);
    },
    peerFetch: async (url, path, init) => {
      calls.push(`${url}${path}`);
      expect(init?.signal).toBeDefined();
      return Response.json(state(archie));
    },
  };
  return { deps, calls };
}

describe("live recent", () => {
  test("queries the local broker rather than its advertised URL, and every peer even if stale", async () => {
    const { deps, calls } = fixture();
    const report = await loadScoutRecent({}, deps);
    expect(calls).toEqual(["local /v1/node", "local /v1/mesh/nodes", "local /v1/mesh/node-state", "http://archie:43110/v1/mesh/node-state"]);
    expect(report.machines.map((machine) => [machine.nodeId, machine.status])).toEqual([[mini.id, "ok"], [archie.id, "ok"]]);
    expect(report.scope).toContain("sessions without an agent are out of scope");
  });
  test("machine selection reads only the selected live endpoint and fails closed on typos", async () => {
    const { deps, calls } = fixture();
    expect((await loadScoutRecent({ machine: "mini" }, deps)).machines).toHaveLength(1);
    expect(calls).not.toContain("http://archie:43110/v1/mesh/node-state");
    calls.length = 0;
    expect((await loadScoutRecent({ machine: "archie" }, deps)).machines[0]?.nodeId).toBe(archie.id);
    expect(calls).not.toContain("local /v1/mesh/node-state");
    await expect(loadScoutRecent({ machine: "typo" }, deps)).rejects.toThrow("Unknown machine");
  });
  test("sorts and filters by the timestamp actually present, keeping sessions under no timestamp", async () => {
    const { deps } = fixture([]);
    const report = await loadScoutRecent({ since: now - 2_000 }, deps);
    const machine = report.machines[0]!;
    if (machine.status !== "ok") throw new Error(machine.error);
    expect(machine.entries.map((entry) => [entry.id, entry.timestampKind])).toEqual([["old-agent", "completedAt"], ["agent-1", "lastSeenAt"]]);
    expect(machine.noTimestamp.map((entry) => entry.id)).toEqual(["endpoint-1"]);
    expect(machine.noTimestamp[0]).toMatchObject({ projectRoot: "/work/project", harness: "codex", sessionId: "session-1", timestamp: null, timestampKind: null, workTitle: null });
    const text = renderScoutRecent(report);
    expect(text).toContain("— no timestamp:");
    expect(text).toContain("(lastSeenAt)");
    expect(text).toContain("(completedAt)");
    expect(text).not.toContain("(startedAt)");
    expect(text).not.toContain("caps apply before");
    const json: string[] = [];
    createScoutCommandContext({ outputMode: "json", stdout: (line) => json.push(line) }).output.writeValue(report, renderScoutRecent);
    expect(JSON.parse(json.join("\n")).machines[0].noTimestamp[0].timestamp).toBeNull();
  });
  test("never uses observedAt or a parent's timestamp for sessions; work times identify their kind", () => {
    const report = state();
    report.roster[0]!.lastSeenAt = null;
    let entries = projectScoutRecentEntries(report);
    expect(entries.find((entry) => entry.id === "agent-1")).toMatchObject({ timestamp: now - 3_000, timestampKind: "startedAt" });
    expect(entries.find((entry) => entry.id === "endpoint-1")?.timestamp).toBeNull();
    report.work.items[0]!.startedAt = null;
    entries = projectScoutRecentEntries(report);
    expect(entries.filter((entry) => entry.timestamp === null).map((entry) => entry.id)).toEqual(["agent-1", "endpoint-1"]);
  });
  test("reports all caps even when an old peer reports false at the cap, before since filtering", async () => {
    const report = state();
    report.roster = Array.from({ length: 24 }, (_, index) => ({ ...report.roster[0]!, id: `a${index}` }));
    report.workload.total = 24;
    report.sessions.items = Array.from({ length: 16 }, (_, index) => ({ ...report.sessions.items[0]!, id: `s${index}` }));
    report.sessions.total = 16;
    report.work.items = Array.from({ length: 16 }, (_, index) => ({ ...report.work.items[0]!, id: `w${index}` }));
    report.work.total = 16;
    const result = await loadScoutRecent({ since: now }, fixture([], report).deps);
    const machine = result.machines[0]!;
    if (machine.status !== "ok") throw new Error(machine.error);
    expect(machine.entries).toHaveLength(0);
    expect(machine.noTimestamp).toHaveLength(16);
    expect(Object.values(machine.coverage).every((item) => item.truncated)).toBe(true);
    expect(renderScoutRecent(result)).toContain("caps apply before the local time filter");
    expect(renderScoutRecent(result).match(/\[truncated\]/g)).toHaveLength(3);
  });
  test("missing joins across independently capped lists stay unknown, not fabricated", () => {
    const report = state();
    report.roster = [];
    const entries = projectScoutRecentEntries(report);
    expect(entries.find((entry) => entry.id === "work-1")).toMatchObject({ projectRoot: "/work/project", harness: "codex" });
    expect(entries.find((entry) => entry.id === "work-old")).toMatchObject({ projectRoot: null, harness: null, sessionId: null });
    report.sessions.items.push({ ...report.sessions.items[0]!, id: "another", sessionId: "session-2" });
    expect(projectScoutRecentEntries(report).find((entry) => entry.id === "work-1")?.sessionId).toBeNull();
  });
  test("merges current/latest work into one agent row; only unmatched work gets its own row", () => {
    const report = state();
    report.work.items.unshift(
      { id: "completed-newer", targetAgentId: "agent-1", state: "completed", summary: "Already done", startedAt: now - 100, completedAt: now },
      { id: "running-older", targetAgentId: "agent-1", state: "running", summary: "Older active task", startedAt: now - 4_000, completedAt: null },
      { id: "no-roster", targetAgentId: "capped-agent", state: "waiting", summary: "Unmatched task", startedAt: now, completedAt: null },
      { id: "completed-older", targetAgentId: "old-agent", state: "completed", summary: "Earlier task", startedAt: now - 20_000, completedAt: now - 5_000 },
    );
    const entries = projectScoutRecentEntries(report);
    expect(entries.filter((entry) => entry.kind === "agent")).toHaveLength(2);
    expect(entries.filter((entry) => entry.kind === "work").map((entry) => entry.id)).toEqual(["no-roster"]);
    expect(entries.find((entry) => entry.id === "agent-1")).toMatchObject({ workId: "work-1", workTitle: "Implement P0", workState: "running" });
    expect(entries.find((entry) => entry.id === "old-agent")).toMatchObject({ workId: "work-old", workTitle: "Old work", workState: "completed", timestamp: now - 500 });
  });

  test("ambiguous machine names read every matching id and label success and failure separately", async () => {
    const first = { ...archie, id: "mini-local-openscout", name: "mini", hostName: "mini" };
    const second = { ...first, id: "mini-openscout", brokerUrl: "http://other-mini:43110" };
    const { deps, calls } = fixture([first, second]);
    deps.peerFetch = async (url, path) => {
      calls.push(`${url}${path}`);
      return Response.json(state(second)); // the legacy registration serves the other id
    };
    const report = await loadScoutRecent({ machine: "mini" }, deps);
    expect(report.machines.map((machine) => [machine.nodeId, machine.status])).toEqual([[first.id, "unavailable"], [second.id, "ok"]]);
    expect(calls).toContain(`${first.brokerUrl}/v1/mesh/node-state`);
    expect(calls).toContain(`${second.brokerUrl}/v1/mesh/node-state`);
    expect(calls).not.toContain("local /v1/mesh/node-state");
    const text = renderScoutRecent(report);
    expect(text).toContain(`mini (${first.id}): node-state identity mismatch`);
    expect(text).toContain(`mini (${second.id}): agents`);
    expect(text.match(/Implement P0/g)).toHaveLength(1);
    expect(text).toContain("work [running] Implement P0");
  });

  test("a capped session list cannot prove an agent has exactly one session", () => {
    const report = state();
    report.sessions.total = 20;
    report.sessions.truncated = true;
    const entries = projectScoutRecentEntries(report);
    expect(entries.find((entry) => entry.id === "agent-1")).toMatchObject({ sessionId: null, harness: null });
    expect(entries.find((entry) => entry.id === "endpoint-1")).toMatchObject({ sessionId: "session-1", harness: "codex" });
  });
  test("out-of-range peer timestamps stay unknown rather than breaking plain output", async () => {
    const report = state();
    report.roster[0]!.lastSeenAt = 1e20;
    report.work.items[0]!.startedAt = 1e20;
    const result = await loadScoutRecent({}, fixture([], report).deps);
    expect(() => renderScoutRecent(result)).not.toThrow();
    const machine = result.machines[0]!;
    if (machine.status !== "ok") throw new Error(machine.error);
    expect(machine.noTimestamp.find((entry) => entry.id === "agent-1")?.timestamp).toBeNull();
  });
  test("bounds unreachable peers per machine and keeps a successful local result", async () => {
    const { deps } = fixture();
    let signal: AbortSignal | null = null;
    deps.peerFetch = (_url, _path, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise(() => {});
    };
    const report = await loadScoutRecent({}, deps);
    expect(report.machines[0]?.status).toBe("ok");
    expect(report.machines[1]).toMatchObject({ status: "unavailable", error: "no answer in 0.03s" });
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    expect(renderScoutRecent(report)).toContain("archie (archie-id): no answer in 0.03s; recent activity unknown");
    expect(renderScoutRecent(report)).not.toContain("nothing recent");
  });
  test("reports missing URLs, denied/old peer routes, invalid responses, and wrong node identity", async () => {
    for (const response of [new Response("denied", { status: 403 }), new Response("missing", { status: 404 }), Response.json({}), Response.json(state(mini))]) {
      const { deps } = fixture();
      deps.peerFetch = async () => response;
      expect((await loadScoutRecent({ machine: "archie" }, deps)).machines[0]?.status).toBe("unavailable");
    }
    const { deps } = fixture([{ ...archie, brokerUrl: undefined }]);
    expect((await loadScoutRecent({ machine: "archie" }, deps)).machines[0]).toMatchObject({ error: "no mesh broker URL advertised" });
  });
  test("uses the previously reached tailnet route before an advertised dead LAN", async () => {
    const tailnet = "https://100.119.71.19:43110";
    const peer = { ...archie, brokerUrl: tailnet, meshEntrypoints: [{ kind: "http" as const, url: "https://192.168.18.28:43110" }] };
    const { deps } = fixture([peer]);
    const urls: string[] = [];
    deps.peerFetch = async (url) => {
      urls.push(url);
      if (url !== tailnet) throw new Error("unreachable LAN must not precede the proved route");
      return Response.json(state(archie));
    };
    expect((await loadScoutRecent({ machine: "archie" }, deps)).machines[0]?.status).toBe("ok");
    expect(urls).toEqual([tailnet]);
  });

  test("a stalled preferred route leaves deadline for the authenticated fallback read", async () => {
    const lan = "https://192.168.18.28:43110";
    const tailnet = "https://100.119.71.19:43110";
    for (const stalledBody of [false, true]) {
      const peer = { ...archie, brokerUrl: lan, meshEntrypoints: [{ kind: "http" as const, url: tailnet }] };
      const { deps } = fixture([peer]);
      deps.timeoutMs = 120;
      const signals: AbortSignal[] = [];
      const urls: string[] = [];
      deps.peerFetch = async (url, _path, init) => {
        urls.push(url);
        signals.push(init!.signal!);
        if (url === lan) return stalledBody
          ? new Response(new ReadableStream({ start() {} }))
          : new Promise<Response>(() => {});
        expect(signals[0]!.aborted).toBe(true);
        return Response.json(state(archie));
      };
      const result = await loadScoutRecent({ machine: "archie" }, deps);
      expect(result.machines[0]?.status).toBe("ok");
      expect(urls).toEqual([lan, tailnet]);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    }
  });

  test("a real identity or pin rejection is not bypassed through another alias", async () => {
    const peer = { ...archie, meshEntrypoints: [{ kind: "http" as const, url: "https://100.119.71.19:43110" }] };
    for (const failure of [new PeerCardVerificationError("wrong enrolled key", archie.brokerUrl!), new PeerTlsPinError("wrong TLS key", archie.brokerUrl!, "f".repeat(64))]) {
      const { deps } = fixture([peer]);
      const urls: string[] = [];
      deps.peerFetch = async (url) => { urls.push(url); throw failure; };
      expect((await loadScoutRecent({ machine: "archie" }, deps)).machines[0]).toMatchObject({ status: "unavailable", error: failure.message });
      expect(urls).toEqual([archie.brokerUrl!]);
    }
  });

  test("tries another advertised peer URL after a refusal without adding another machine", async () => {
    const peer = { ...archie, meshEntrypoints: [{ kind: "http" as const, url: "http://archie-other:43110" }] };
    const { deps } = fixture([peer]);
    const urls: string[] = [];
    deps.peerFetch = async (url) => {
      urls.push(url);
      if (urls.length === 1) throw new Error("refused");
      return Response.json(state(archie));
    };
    const report = await loadScoutRecent({ machine: "archie" }, deps);
    expect(urls).toEqual([archie.brokerUrl!, "http://archie-other:43110"]);
    expect(report.machines).toHaveLength(1);
    expect(report.machines[0]?.status).toBe("ok");
  });
});

test("scoped live reads send encoded filters and reject unrelated rows from older peers", async () => {
  const { deps, calls } = fixture([]);
  const original = deps.readLocal!;
  deps.readLocal = async (path, signal) => path.startsWith("/v1/mesh/node-state?")
    ? (calls.push(path), state()) : original(path, signal);
  const report = await loadScoutRecent({ machine: mini.id, projectRoot: "/work/project", agentId: "agent-1" }, deps);
  expect(calls.at(-1)).toBe("/v1/mesh/node-state?projectRoot=%2Fwork%2Fproject&agentId=agent-1");
  const machine = report.machines[0]!;
  if (machine.status !== "ok") throw new Error(machine.error);
  expect(machine.entries.map((e) => e.id)).toEqual(["agent-1"]);
  expect(machine.noTimestamp.map((e) => e.id)).toEqual(["endpoint-1"]);
  expect(report.scope).toContain("older peers may cap before filtering");
});

test("dormant nodes are hidden and --all never probes them; explicit names still resolve", async () => {
  const dormant = { ...archie, lastSeenAt: Date.now() - 13 * 86400000 };
  const { deps, calls } = fixture([dormant]);
  const { loadMachineNodeStates } = await import("./recent.ts");
  expect((await loadMachineNodeStates({}, deps)).machines).toHaveLength(1);
  const all = await loadMachineNodeStates({ all: true }, deps);
  expect(all.machines).toHaveLength(2);
  expect(all.machines[1]).toMatchObject({ status: "unavailable" });
  expect(calls.some(call => call.startsWith(dormant.brokerUrl!))).toBe(false);
  await loadMachineNodeStates({ machine: dormant.id }, deps);
  expect(calls.some(call => call.startsWith(dormant.brokerUrl!))).toBe(true);
});
