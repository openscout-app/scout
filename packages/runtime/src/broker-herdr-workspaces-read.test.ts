import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrSessionTopology, HerdrWorkspacesRead } from "@openscout/protocol";
import { HERDR_WORKSPACE_LIMITS, readHerdrWorkspaces, type HerdrWorkspacesReadDeps } from "./broker-herdr-workspaces-read.js";
import { createBrokerHttpRouter, type BrokerHttpRouterDeps } from "./broker-http-router.js";
import { meshRouteMatrixEntries } from "./mesh-route-matrix.js";
import { herdrSessionsProbe, invalidateHerdrTopology, readHerdrSessionsSnapshot, readHerdrTopologySnapshot, type HerdrSessionInfo } from "./system-probes/herdr.js";
import type { ProbeSnapshot } from "./system-probes/registry.js";

const path = "/v1/terminal-hosts/herdr/workspaces";
const url = (query = "") => new URL("http://local" + path + query);
const sessions = (names = ["alpha"]): HerdrSessionInfo[] => names.map(name => ({ name, running: true, isDefault: false, sessionDir: "/never-return-this" }));
const snapshot = (value = sessions()): ProbeSnapshot<HerdrSessionInfo[]> => ({ id: "herdr.sessions", value, at: 100, ageMs: 0, stale: false, refreshing: false, status: "fresh", error: null, consecutiveFailures: 0, backend: "local" });
function topology(session = "alpha", workspaces = 1, tabs = 1, panes = 1): HerdrSessionTopology {
  return { session, running: true, observedAt: 123, workspaces: Array.from({ length: workspaces }, (_, w) => ({
    workspaceId: `w${w}`, label: "Workspace", number: w, focused: true, activeTabId: `w${w}:t0`, agentStatus: "blocked",
    tabs: Array.from({ length: tabs }, (_, t) => ({ tabId: `w${w}:t${t}`, workspaceId: `w${w}`, label: "Tab", number: t,
      focused: true, agentStatus: "blocked", layout: null, panes: Array.from({ length: panes }, (_, p) => ({
        paneId: `w${w}:t${t}:p${p}`, workspaceId: `w${w}`, tabId: `w${w}:t${t}`, terminalId: `term-${p}`, name: "Panel",
        label: "Title", agent: "codex", agentStatus: "blocked", agentSession: { agent: "codex", kind: "id", source: "herdr", value: "Native-ID" },
        cwd: "/repo", foregroundCwd: null, focused: true, scroll: null,
      })) })) })) };
}
const deps = (names = ["alpha"]): HerdrWorkspacesReadDeps => ({ nodeId: "node-test", sessions: async () => snapshot(sessions(names)), topology: async name => ({ topology: topology(name), availability: "available" }) });
async function body(d = deps(), query = ""): Promise<HerdrWorkspacesRead> { const r = await readHerdrWorkspaces(d, url(query)); expect(r.status).toBe(200); return r.body as HerdrWorkspacesRead; }
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); invalidateHerdrTopology(); });

test("versioned local digest preserves panel identity without claiming a Scout binding or exposing sessionDir", async () => {
  const result = await body();
  expect(result).toMatchObject({ schema: "scout.herdr-workspaces/v1", nodeId: "node-test", scannedAt: 100, availability: "available", reason: null, count: 1, truncated: false });
  expect(result.digests[0]).toMatchObject({ session: "alpha", live: true, observedAt: 123, savedAt: null, availability: "available", totals: { panes: 1 } });
  expect(result.digests[0].needsYou[0]).toMatchObject({ name: "Panel", paneId: "w0:t0:p0", target: "term-0", agentSession: { value: "Native-ID" } });
  expect(JSON.stringify(result)).not.toContain("/never-return-this");
  expect(result.digests[0].needsYou[0]).not.toHaveProperty("identity");
});

test("digests carry attached clients, their apps and pane branches from the live topology", async () => {
  const live = topology();
  live.clients = 1; live.apps = ["Example Term"];
  live.workspaces[0]!.tabs[0]!.panes[0]!.gitBranch = "main";
  const result = await body({ ...deps(), topology: async () => ({ topology: live, availability: "available" }) });
  expect(result.digests[0]).toMatchObject({ clients: 1, apps: ["Example Term"] });
  expect(result.digests[0].needsYou[0]).toMatchObject({ paneId: "w0:t0:p0", gitBranch: "main" });
  expect(result.digests[0].groups[0]!.panes[0]).toMatchObject({ gitBranch: "main" });
  // Without them, the digest stays as it was: no clients, apps or branch keys.
  const plain = await body();
  expect(plain.digests[0]).not.toHaveProperty("clients");
  expect(plain.digests[0]).not.toHaveProperty("apps");
  expect(plain.digests[0].needsYou[0]).not.toHaveProperty("gitBranch");
});

test("failed enumeration with a stale value never becomes available empty or leaks raw probe errors", async () => {
  for (const fail of [async () => { throw new Error("secret path"); }, async () => ({ ...snapshot(), status: "failed" as const, error: { code: "exit", message: "secret path", at: 200 } })]) {
    const result = await body({ ...deps(), sessions: fail });
    expect(result).toMatchObject({ availability: "unavailable", reason: "session_list_unavailable", digests: [] });
    expect(JSON.stringify(result)).not.toContain("secret path");
  }
});

test("cold not_scanned and successful available-empty are distinct", async () => {
  expect(await body({ ...deps(), sessions: async () => ({ ...snapshot(), value: null, at: null, status: "empty" }) })).toMatchObject({ availability: "not_scanned", scannedAt: null });
  expect(await body(deps([]))).toMatchObject({ availability: "available", count: 0, digests: [], scannedAt: 100 });
});

test("topology failures remain unavailable rows and mixed success is partial", async () => {
  const read = { ...deps(["alpha", "bad"]), topology: async (name: string) => { if (name === "bad") throw new Error("unreadable"); return { topology: topology(name), availability: "available" as const }; } };
  const mixed = await body(read);
  expect(mixed.availability).toBe("partial");
  expect(mixed.digests[1]).toMatchObject({ availability: "unavailable", live: false, unavailable: "unreadable" });
  expect((await body({ ...read, sessions: async () => snapshot(sessions(["bad"])) })).availability).toBe("unavailable");
});

test("saved state stays last-known and never offers live status/targets", async () => {
  const result = await body({ ...deps(), topology: async name => ({ topology: { ...topology(name), running: false, savedAt: 90, unavailable: "not_running" }, availability: "partial" }) });
  expect(result.availability).toBe("partial");
  expect(result.digests[0]).toMatchObject({ live: false, savedAt: 90, observedAt: 123, availability: "partial" });
  expect(result.digests[0].groups[0].panes[0]).toMatchObject({ status: "unknown", target: null });
  expect(result.digests[0].needsYou).toEqual([]);
});

test("session fan-out is capped at eight, concurrency at two, with explicit truncation", async () => {
  let active = 0, peak = 0; const seen: string[] = [];
  const result = await body({ ...deps(Array.from({ length: 12 }, (_, i) => `s${i}`)), topology: async name => {
    active++; peak = Math.max(peak, active); seen.push(name); await Bun.sleep(2); active--;
    return { topology: topology(name), availability: "available" };
  } });
  expect(result.count).toBe(8); expect(seen.length).toBe(8); expect(peak).toBe(2);
  expect(result.truncated).toBe(true); expect(result.coverage.limits).toEqual(HERDR_WORKSPACE_LIMITS);
});

test("workspace/tab/input-pane and digest caps bound shape output and label bounded totals", async () => {
  for (const [w, t, p] of [[20, 1, 1], [1, 70, 1], [1, 1, 300]]) {
    const input = topology("alpha", w, t, p);
    const result = await body({ ...deps(), topology: async () => ({ topology: input, availability: "available" }) });
    const digest = result.digests[0];
    expect(result.truncated).toBe(true); expect(digest.truncated).toBe(true);
    expect(digest.totals.workspaces).toBeLessThanOrEqual(16); expect(digest.shapes.length).toBeLessThanOrEqual(64);
    expect(digest.totals.panes).toBeLessThanOrEqual(256);
    expect(digest.groups.reduce((n, g) => n + g.panes.length, 0)).toBeLessThanOrEqual(40);
    expect(digest.needsYou.length).toBeLessThanOrEqual(12);
    expect(digest.notes.join(" ")).toContain("bounded prefix");
    expect(input.workspaces.length).toBe(w); // cached topology was not mutated
  }
});

test("session is an exact bounded selector, not arbitrary extra probing", async () => {
  const calls: string[] = [];
  const d = { ...deps(["alpha", "beta"]), topology: async (name: string) => { calls.push(name); return { topology: topology(name), availability: "available" as const }; } };
  expect((await body(d, "?session=beta")).digests.map(x => x.session)).toEqual(["beta"]);
  expect(calls).toEqual(["beta"]);
  expect((await readHerdrWorkspaces(d, url("?session=missing"))).status).toBe(404);
  for (const query of ["?force=1", "?session=", "?session=../outside", "?session=beta&session=alpha", "?session=%00", "?session=" + "x".repeat(129)]) {
    expect((await readHerdrWorkspaces({ ...d, sessions: async () => { throw new Error("query must refuse before probe"); } }, url(query))).status).toBe(400);
  }
  expect((await readHerdrWorkspaces(deps(Array.from({ length: 300 }, (_, i) => `s${i}`)), url("?session=s299"))).status).toBe(503);
});

class Reply extends EventEmitter { status = 0; body = ""; writableEnded = false; writeHead(status: number) { this.status = status; } end(body = "") { this.body += body; this.writableEnded = true; } }
test("HTTP probe route requires identified local transport, unlike cache-only observed sessions", async () => {
  let reads = 0;
  const route = createBrokerHttpRouter({ brokerService: {}, host: "local", port: 1, nodeId: "node-test", runtime: {},
    herdrWorkspaces: { ...deps(), sessions: async () => { reads++; return snapshot([]); } },
    webControl: new Proxy({}, { get() { throw new Error("no private web"); } }),
  } as unknown as BrokerHttpRouterDeps);
  for (const transportContext of [undefined, { transport: "unix-socket" }, { transport: "loopback" }, { transport: "remote" }, { transport: "loopback", guest: {} }, { transport: "loopback", scoped: {} }]) {
    const reply = new Reply(); await route({ method: "GET", url: path, headers: {}, transportContext } as any, reply as any);
    expect(reply.status).toBe(transportContext && ["unix-socket", "loopback"].includes(transportContext.transport) && !("guest" in transportContext) && !("scoped" in transportContext) ? 200 : 403);
  }
  expect(reads).toBe(2); // Missing context cannot authorize a subprocess probe.
  const unidentified = new Reply();
  await route({ method: "GET", url: path, headers: {} } as any, unidentified as any);
  expect(JSON.parse(unidentified.body)).toEqual({ error: "local_only" });
  for (const headers of [{ origin: "https://example.invalid" }, { "x-openscout-forwarded-node-id": "remote" }]) {
    const reply = new Reply(); await route({ method: "GET", url: path, headers, transportContext: { transport: "loopback" } } as any, reply as any); expect(reply.status).toBe(403);
  }
  expect(reads).toBe(2); expect(meshRouteMatrixEntries()[`GET ${path}`]).toBe("local");
});

/** Only a disposable executable, never the installed Herdr or a real session. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "scout-herdr-read-")); roots.push(root);
  const bin = join(root, "herdr-stub"), count = join(root, "calls");
  const json = (name: string, value: unknown) => writeFileSync(join(root, name + ".json"), JSON.stringify(value));
  json("sessions", { sessions: [{ name: "alpha", running: true, session_dir: join(root, "saved") }] });
  json("workspace", { result: { workspaces: [{ workspace_id: "w" }] } });
  json("tab", { result: { tabs: [{ workspace_id: "w", tab_id: "t" }] } });
  json("pane", { result: { panes: [{ workspace_id: "w", tab_id: "t", pane_id: "p", terminal_id: "term", agent_status: "working" }] } });
  json("snapshot", { result: { snapshot: { layouts: [] } } }); json("agent", { result: { agents: [] } });
  writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "$*" >> '${count}'
if [ "$1" = session ]; then
 [ ! -f '${root}/fail-list' ] || exit 1
 cat '${root}/sessions.json'; exit 0
fi
[ ! -f '${root}/fail-topology' ] || exit 1
case "$3 $4" in
 'workspace list') cat '${root}/workspace.json';;
 'tab list') cat '${root}/tab.json';;
 'pane list') cat '${root}/pane.json';;
 'api snapshot') cat '${root}/snapshot.json';;
 'agent list') [ ! -f '${root}/fail-agent' ] || exit 1; cat '${root}/agent.json';;
 *) exit 42;;
esac
`);
  chmodSync(bin, 0o755);
  const env = { PATH: "/usr/bin:/bin", HOME: root, OPENSCOUT_HERDR_BIN: bin };
  const reads = { nodeId: "node-test", sessions: () => readHerdrSessionsSnapshot({ env }), topology: (name: string) => readHerdrTopologySnapshot(name, { env }) };
  return { root, env, reads, calls: () => readFileSync(count, "utf8").trim().split("\n") };
}

test("two overlapping HTTP observations inside TTL run one enumeration and one five-command topology refresh", async () => {
  const f = fixture();
  const [first, second] = await Promise.all([body(f.reads), body(f.reads)]);
  expect(first.availability).toBe("available"); expect(second).toEqual(first);
  expect(f.calls().length).toBe(6);
  expect(new Set(f.calls()).size).toBe(6);
  await body(f.reads); expect(f.calls().length).toBe(6);
});

test("missing executable and failed/malformed listing are cached unavailable, not available empty", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "fail-list"), "1");
  expect((await body(f.reads)).availability).toBe("unavailable");
  expect((await body(f.reads)).availability).toBe("unavailable"); expect(f.calls().length).toBe(1);
  const missing = { ...f.env, OPENSCOUT_HERDR_BIN: join(f.root, "absent") };
  const read = { ...f.reads, sessions: () => readHerdrSessionsSnapshot({ env: missing }) };
  expect((await body(read)).availability).toBe("unavailable"); await body(read);
  expect(herdrSessionsProbe.for({ env: missing }).metrics().runCount).toBe(1);
  const invalid = fixture(); writeFileSync(join(invalid.root, "sessions.json"), "not JSON");
  expect((await body(invalid.reads)).availability).toBe("unavailable");
});

test("checked topology distinguishes mandatory failure, optional partial and bounded saved fallback", async () => {
  const fail = fixture(); writeFileSync(join(fail.root, "workspace.json"), "{}");
  expect((await body(fail.reads)).digests[0]).toMatchObject({ availability: "unavailable", live: false, unavailable: "unreadable" });
  const partial = fixture(); writeFileSync(join(partial.root, "fail-agent"), "1");
  expect((await body(partial.reads)).digests[0]).toMatchObject({ availability: "partial", live: true });
  const saved = fixture(); mkdirSync(join(saved.root, "saved"));
  writeFileSync(join(saved.root, "fail-topology"), "1");
  writeFileSync(join(saved.root, "saved", "session.json"), JSON.stringify({ workspaces: [{ id: "w", tabs: [{ panes: { "1": { cwd: "/repo" } } }] }] }));
  const result = await body(saved.reads);
  expect(result.digests[0]).toMatchObject({ availability: "partial", live: false, unavailable: "unreadable" });
  expect(result.digests[0].savedAt).toBeNumber();
  const oversized = fixture(); mkdirSync(join(oversized.root, "saved")); writeFileSync(join(oversized.root, "fail-topology"), "1");
  writeFileSync(join(oversized.root, "saved", "session.json"), " ".repeat(512 * 1024 + 1));
  expect((await body(oversized.reads)).availability).toBe("unavailable");
});
