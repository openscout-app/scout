import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { digestHerdrTopology, type HerdrSessionTopology, type HerdrWorkspacesRead } from "@openscout/protocol";
import { readHerdrWorkspaces } from "../../../runtime/src/broker-herdr-workspaces-read.ts";
import type { HerdrSessionInfo } from "../../../runtime/src/system-probes/herdr.ts";
import type { ProbeSnapshot } from "../../../runtime/src/system-probes/registry.ts";
import { readRuntimeHerdrWorkspaces } from "./herdr-workspaces-runtime.ts";
import { herdrWorkspacesDependencies, registerHerdrWorkspaceTools } from "./herdr-workspaces.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const path = "/v1/terminal-hosts/herdr/workspaces";
const limits = { sessions: 8, enumeratedSessions: 256, workspacesPerSession: 16, tabsPerSession: 64,
  inputPanesPerSession: 256, emittedPanesPerSession: 40, leadsPerSession: 12, concurrentSessions: 2 };
function topology(session = "alpha"): HerdrSessionTopology {
  return { session, running: true, observedAt: 123, workspaces: [{ workspaceId: "w1", label: "Work", number: 1,
    focused: true, activeTabId: "t1", agentStatus: "blocked", tabs: [{ tabId: "t1", workspaceId: "w1", label: "Tab",
      number: 1, focused: true, agentStatus: "blocked", layout: null, panes: [{ paneId: "p1", terminalId: "T1",
        workspaceId: "w1", tabId: "t1", name: "panel", label: "Title", agent: "codex", agentStatus: "blocked",
        agentSession: { agent: "codex", kind: "id", source: "herdr", value: "Case/Native" }, cwd: "/work",
        foregroundCwd: null, focused: true, scroll: null }] }] }] };
}
function value(overrides: Partial<HerdrWorkspacesRead> = {}): HerdrWorkspacesRead {
  return { schema: "scout.herdr-workspaces/v1", nodeId: "node-one", scannedAt: 100, availability: "available",
    reason: null, requestedSession: null, count: 1, digests: [{ ...digestHerdrTopology(topology()), availability: "available" }],
    truncated: false, coverage: { kind: "ttl_cached_probes", scope: "this_host_only", listedSessions: 1, limits }, ...overrides };
}
const fetcher = (fn: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): typeof fetch => Object.assign(fn, { preconnect() {} });
const read = (response: Response, session?: string) => readRuntimeHerdrWorkspaces({ session,
  env: { OPENSCOUT_BROKER_URL: "http://localhost:1" }, fetchImpl: fetcher(async () => response) });

test("one selected local broker GET carries no web cookie, bearer, origin or forwarding authority", async () => {
  let calls = 0;
  const result = await readRuntimeHerdrWorkspaces({ session: "Space & Case", env: { OPENSCOUT_BROKER_URL: "http://localhost:43121/base",
    OPENSCOUT_WEB_URL: "https://must-not-use.invalid", OPENSCOUT_WEB_AUTH_TOKEN: "must-not-send" },
    fetchImpl: fetcher(async (input, init) => {
      calls++; const url = new URL(String(input)); expect(url.pathname).toBe(path);
      expect(url.searchParams.get("session")).toBe("Space & Case");
      expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      for (const header of ["authorization", "cookie", "origin", "x-openscout-forwarded-node-id"]) expect(new Headers(init?.headers).get(header)).toBeNull();
      return Response.json(value({ requestedSession: "Space & Case", digests: [{ ...value().digests[0]!, session: "Space & Case" }] }));
    }) });
  expect(result.requestedSession).toBe("Space & Case"); expect(calls).toBe(1);
});

test("actual runtime projection preserves live, saved, unavailable, partial and available-empty observations", async () => {
  const snapshot: ProbeSnapshot<HerdrSessionInfo[]> = { id: "herdr.sessions", value: [{ name: "alpha", running: true, isDefault: false, sessionDir: "/fixture-only" }],
    at: 100, ageMs: 0, stale: false, refreshing: false, status: "fresh", error: null, consecutiveFailures: 0, backend: "local" };
  for (const kind of ["live", "saved", "unavailable", "empty", "not_scanned", "list_failed", "partial"] as const) {
    const projected = await readHerdrWorkspaces({ nodeId: "node-one", sessions: async () => kind === "empty" ? { ...snapshot, value: [] }
      : kind === "not_scanned" ? { ...snapshot, at: null, value: null, status: "empty" }
      : kind === "list_failed" ? { ...snapshot, status: "failed" } : kind === "partial" ? { ...snapshot, stale: true } : snapshot,
      topology: async () => {
        if (kind === "unavailable") throw Error("fixture-only");
        return { topology: kind === "saved" ? { ...topology(), running: false, savedAt: 90, unavailable: "not_running" } : topology(),
          availability: kind === "saved" ? "partial" : "available" };
      } }, new URL("http://localhost" + path));
    expect(projected.status).toBe(200);
    if (!("schema" in projected.body)) throw Error("expected a runtime observation");
    const parsed = await read(Response.json(projected.body)); expect(parsed).toEqual(projected.body);
    if (kind === "saved") expect(parsed.digests[0]!.groups[0]!.panes[0]).toMatchObject({ target: null, status: "unknown" });
  }
});

test.each([401, 403, 404, 409, 503])("HTTP %i preserves safe status/code without retry or cookie bootstrap", async status => {
  let calls = 0;
  await expect(readRuntimeHerdrWorkspaces({ env: { OPENSCOUT_BROKER_URL: "http://localhost:1" }, fetchImpl: fetcher(async () => {
    calls++; return Response.json({ error: "herdr_session_not_listed", detail: "private body" }, { status });
  }) })).rejects.toMatchObject({ status, code: "herdr_session_not_listed" });
  expect(calls).toBe(1);
});

test("actual maximum distinct-directory groups fit even when most panes were omitted", async () => {
  const input = topology(); const p = input.workspaces[0]!.tabs[0]!.panes[0]!;
  input.workspaces[0]!.tabs[0]!.panes = Array.from({ length: 300 }, (_, i) => ({ ...p, paneId: `p${i}`, cwd: `/dir/${i}` }));
  const projected = await readHerdrWorkspaces({ nodeId: "node-one", sessions: async () => ({ id: "herdr.sessions",
    value: [{ name: "alpha", running: true, isDefault: false, sessionDir: "/fixture" }], at: 100, ageMs: 0,
    stale: false, refreshing: false, status: "fresh", error: null, consecutiveFailures: 0, backend: "local" }),
    topology: async () => ({ topology: input, availability: "available" }) }, new URL("http://localhost" + path));
  if (!("schema" in projected.body)) throw Error("expected a runtime observation");
  expect(projected.body.digests[0]!.groups).toHaveLength(256);
  const result = await read(Response.json(projected.body)); expect(result).toEqual(projected.body);
  expect(result.digests[0]!.groups.flatMap(g => g.panes)).toHaveLength(40);
  expect(result.truncated).toBe(true);
});

test("attached clients, their apps and pane branches pass validation and survive the read", async () => {
  const live = topology();
  live.clients = 2; live.apps = ["Example Term"];
  live.workspaces[0]!.tabs[0]!.panes[0]!.gitBranch = "main";
  const v = value({ digests: [{ ...digestHerdrTopology(live), availability: "available" }] });
  const result = await read(Response.json(v));
  expect(result).toEqual(v);
  expect(result.digests[0]).toMatchObject({ clients: 2, apps: ["Example Term"] });
  expect(result.digests[0]!.needsYou[0]!.gitBranch).toBe("main");
  const d = v.digests[0]!;
  const saved = { ...digestHerdrTopology({ ...topology(), running: false, savedAt: 90, unavailable: "not_running" }), availability: "partial" as const };
  await expect(read(Response.json({ ...v, availability: "partial", digests: [saved] }))).resolves.toBeDefined();
  for (const bad of [{ ...d, apps: undefined }, { ...d, clients: undefined }, { ...d, clients: -1 },
    { ...d, apps: [1] }, { ...saved, clients: 1, apps: [] }]) {
    await expect(read(Response.json({ ...v, availability: "partial", digests: [bad] }))).rejects.toMatchObject({ code: "invalid_herdr_workspaces_response" });
  }
});

test("non-JSON denial preserves status without reflecting raw server text", async () => {
  await expect(read(new Response("SECRET", { status: 403 }))).rejects.toMatchObject({ status: 403, code: "herdr_workspaces_unavailable" });
});

test("scope, schema, count, session binding, duplicate and nested malformed responses refuse", async () => {
  const v = value(), d = v.digests[0]!;
  for (const bad of [{}, { ...v, schema: "other" }, { ...v, count: 0 }, { ...v, nodeId: "" },
    { ...v, coverage: { ...v.coverage, scope: "fleet" } }, { ...v, digests: [d, d], count: 2 },
    { ...v, digests: [{ ...d, live: true, savedAt: 90 }] }, { ...v, digests: [{ ...d, groups: [{ ...d.groups[0], panes: [{}] }] }] },
    { ...v, digests: [{ ...d, session: "../outside" }] }, { ...v, availability: "not_scanned" },
    { ...v, digests: [{ ...d, live: false }] }, { ...v, digests: [{ ...d, notes: Array(129).fill("x") }] },
    { ...v, digests: Array(9).fill(d), count: 9 }, { ...v, credential: "never accept" }]) {
    await expect(read(Response.json(bad))).rejects.toMatchObject({ code: "invalid_herdr_workspaces_response" });
  }
  await expect(read(Response.json(v), "alpha")).rejects.toThrow();
  await expect(read(Response.json({ ...v, requestedSession: "alpha", digests: [{ ...d, session: "beta" }] }), "alpha")).rejects.toThrow();
});

test("declared/streamed oversize, invalid UTF8 and redirects refuse and cancel their streams", async () => {
  for (const response of [new Response("small", { headers: { "content-length": "2097153" } }), new Response("x".repeat(2097153)),
    new Response(new Uint8Array([0xff])), new Response(null, { status: 302, headers: { location: "https://must-not-use.invalid" } })]) {
    await expect(read(response)).rejects.toMatchObject({ code: "invalid_herdr_workspaces_response" });
  }
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(2097153)); }, cancel() { cancelled = true; } });
  await expect(read(new Response(stream))).rejects.toThrow(); expect(cancelled).toBe(true);
});

test("invalid local authority, selectors and socket-only configuration refuse before any request", async () => {
  let calls = 0; const fetchImpl = fetcher(async () => { calls++; throw Error("must not fetch"); });
  for (const url of ["https://remote.invalid", "http://user:secret@localhost", "file:///tmp/no", "not a url", "http://127.1", "http://2130706433"])
    await expect(readRuntimeHerdrWorkspaces({ env: { OPENSCOUT_BROKER_URL: url }, fetchImpl })).rejects.toThrow();
  for (const session of ["", " ", "..", "../outside", "a/b", "a\\b", "a\0b", "x".repeat(129)])
    await expect(readRuntimeHerdrWorkspaces({ session, env: { OPENSCOUT_BROKER_URL: "http://localhost:1" }, fetchImpl })).rejects.toThrow();
  await expect(readRuntimeHerdrWorkspaces({ env: { OPENSCOUT_BROKER_URL: "http://localhost:1", OPENSCOUT_BROKER_SOCKET_ONLY: "1" }, fetchImpl })).rejects.toMatchObject({ code: "broker_socket_required" });
  expect(calls).toBe(0);
});

test("the actual Unix socket wins and an absent socket cannot fall back to an HTTP trap", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr_read_")); const socket = join(root, "control.sock");
  let httpCalls = 0, socketCalls = 0;
  const trap = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { httpCalls++; return Response.json(value()); } });
  const server = Bun.serve({ unix: socket, fetch(request) { socketCalls++; expect(new URL(request.url).pathname).toBe(path); return Response.json(value()); } });
  try {
    expect(await readRuntimeHerdrWorkspaces({ env: { OPENSCOUT_BROKER_URL: trap.url.origin, OPENSCOUT_BROKER_SOCKET_PATH: socket } })).toEqual(value());
    await expect(readRuntimeHerdrWorkspaces({ env: { OPENSCOUT_BROKER_URL: trap.url.origin, OPENSCOUT_BROKER_SOCKET_PATH: join(root, "absent.sock") } })).rejects.toThrow();
    expect(httpCalls).toBe(0); expect(socketCalls).toBe(1);
  } finally { await server.stop(true); await trap.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test("real HTTP redirect does not reach its target", async () => {
  let targetCalls = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { targetCalls++; return Response.json(value()); } });
  const redirect = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(null, { status: 302, headers: { location: target.url.origin } }); } });
  try { await expect(readRuntimeHerdrWorkspaces({ env: { OPENSCOUT_BROKER_URL: redirect.url.origin } })).rejects.toThrow(); expect(targetCalls).toBe(0); }
  finally { await redirect.stop(true); await target.stop(true); }
});

test("MCP preserves runtime availability/coverage and never upgrades missing observations into absence", async () => {
  for (const availability of ["not_scanned", "unavailable", "partial", "available"] as const) {
    const reply = value({ availability, scannedAt: availability === "not_scanned" ? null : 100,
      reason: availability === "not_scanned" ? "not_scanned" : null, count: 0, digests: [] });
    const server = new McpServer({ name: "fixture", version: "1" });
    registerHerdrWorkspaceTools(server, herdrWorkspacesDependencies({ env: { OPENSCOUT_BROKER_URL: "http://localhost:1" }, fetchImpl: fetcher(async () => Response.json(reply)) }));
    const client = new Client({ name: "fixture", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([client.connect(a), server.connect(b)]);
      for (const args of [{}, { query: "missing" }]) {
        const result = await client.callTool({ name: "herdr_workspaces", arguments: args });
        expect(result.structuredContent).toMatchObject({ available: availability === "available" || availability === "partial",
          runtimeRead: { schema: "scout.herdr-workspaces/v1", nodeId: "node-one", availability, scannedAt: reply.scannedAt } });
        if (availability !== "available") expect(JSON.stringify(result.content)).not.toContain("No herdr sessions on this host.");
      }
    } finally { await client.close(); await server.close(); }
  }
});

test("the retired browser-cookie adapter is absent and runtime reads cannot return to it", () => {
  const source = readFileSync(new URL("./herdr-workspaces.ts", import.meta.url), "utf8");
  expect(source).not.toContain("web-api"); expect(source).not.toContain("/api/terminal-hosts");
  const factory = readFileSync(new URL("./scout-mcp.ts", import.meta.url), "utf8");
  expect(factory).toContain("herdrWorkspacesDependencies({ env })");
});
