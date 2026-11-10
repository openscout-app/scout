import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { buildObservedSessionInventory, readObservedSessions } from "./broker-observed-sessions-read.js";
import { getCachedTailDiscovery } from "./tail/index.js";
import { __testing } from "./tail/service.js";
import type { DiscoverySnapshot, DiscoveredTranscript, TranscriptSource } from "./tail/types.js";
import type { AgentEndpoint } from "@openscout/protocol";
import { createBrokerHttpRouter, type BrokerHttpRouterDeps } from "./broker-http-router.js";
import { meshRouteTierFor } from "./mesh-route-matrix.js";
const transcript = (source = "codex", sessionId = "Native-1", path = "/private/session.jsonl"): DiscoveredTranscript => ({ source, sessionId, transcriptPath: path, cwd: "/repo", project: "repo", harness: "unattributed", mtimeMs: 10, size: 10 });
const cache = (transcripts = [transcript()]): DiscoverySnapshot => ({ generatedAt: 100, processes: [], transcripts, totals: { total: 0, scoutManaged: 0, hudsonManaged: 0, unattributed: 0, transcripts: transcripts.length }, readStatus: { initialized: true, scope: "shallow", sources: [{ harness: "codex", availability: "available", processes: "available" }, { harness: "claude", availability: "available", processes: "available" }] } });
const endpoints = { ep: { id: "ep", agentId: "agent-1", nodeId: "node-1", harness: "codex", sessionId: "Native-1" } as AgentEndpoint };
const deps = (value = cache()) => ({ nodeId: "node-1", readCache: () => value, readEndpoints: () => endpoints });
const url = (query = "") => new URL("http://local/v1/observed-sessions" + query);
const exact = "?nodeId=node-1&harness=codex&nativeSessionId=Native-1";
afterEach(() => { __testing.resetDiscovery(); __testing.clearWatchers(); });

test("passive cold cache is not scanned, not a fabricated observed empty; does not start a loop", () => {
  __testing.resetDiscovery(); const before = __testing.tailLoopState();
  const inventory = buildObservedSessionInventory({ nodeId: "node-1", readCache: getCachedTailDiscovery });
  expect(inventory).toMatchObject({ availability: "not_scanned", scannedAt: null, sessions: [] });
  expect(inventory.sources.every(source => source.availability === "not_scanned")).toBe(true);
  expect(__testing.tailLoopState()).toEqual(before);
});

test("source failures and legacy unknown empty stay distinct from explicitly observed empty", async () => {
  const source = (name: string): TranscriptSource => ({ name, discoverProcesses: () => [], discoverTranscripts: () => [], parseLine: () => null });
  await __testing.refreshDiscovery([{ ...source("good"), discoveryAvailability: () => "available" }, source("unknown"), { ...source("failed"), discoverTranscripts() { throw new Error("unreadable"); } }]);
  const inventory = buildObservedSessionInventory({ nodeId: "node-1" });
  expect(inventory.availability).toBe("partial");
  expect(inventory.sources.map(source => [source.harness, source.availability])).toEqual([["good", "available"], ["unknown", "unknown"], ["failed", "unavailable"]]);
  const empty = buildObservedSessionInventory(deps(cache([])));
  expect(empty).toMatchObject({ availability: "available", sessions: [], scannedAt: 100 });
});

test("native identities stay case-sensitive, typed agent links never replace them, no path is emitted", () => {
  const result = buildObservedSessionInventory(deps());
  expect(result.sessions[0]).toMatchObject({ identity: { nodeId: "node-1", harness: "codex", nativeSessionId: "Native-1" }, links: [{ kind: "agent", id: "agent-1" }] });
  expect(result.coverage.links).toEqual({ agents: "available", conversations: "unsupported", terminals: "unsupported" });
  expect(JSON.stringify(result)).not.toContain("/private/session.jsonl");
  expect(readObservedSessions(deps(), url(exact), true).status).toBe(200);
  expect(readObservedSessions(deps(), url(exact.replace("Native-1", "native-1")), true).status).toBe(404);
  expect(readObservedSessions(deps(), url(exact.replace("node-1", "other-node")), true).status).toBe(404);
});

test("a session Scout resumed links its agent by the harness id it keeps in metadata", () => {
  const resumed = { id: "ep-resumed", agentId: "flat-codex-Native-1", nodeId: "node-1", harness: "codex", sessionId: "flat-codex-Native-1",
    metadata: { externalSessionId: "Native-1", nativeSessionId: "Native-1" } } as unknown as AgentEndpoint;
  const pending = { id: "ep-pending", agentId: "flat-pending", nodeId: "node-1", harness: "codex", metadata: { externalSessionId: "Native-1" } } as unknown as AgentEndpoint;
  const elsewhere = { ...resumed, id: "ep-elsewhere", agentId: "other-node-agent", nodeId: "node-2" } as AgentEndpoint;
  const result = buildObservedSessionInventory({ ...deps(), readEndpoints: () => ({ ...endpoints, resumed, pending, elsewhere }) });
  expect(result.sessions[0].links).toEqual([{ kind: "agent", id: "agent-1" }, { kind: "agent", id: "flat-codex-Native-1" }, { kind: "agent", id: "flat-pending" }]);
});

test("unqualified collisions list unlike candidates instead of applying web precedence", () => {
  const value = cache([transcript(), transcript("claude", "Native-1", "/other")]);
  const result = readObservedSessions(deps(value), url("?ref=Native-1"), true);
  expect(result.status).toBe(409); expect((result.body as any).candidates).toHaveLength(2);
  const same = { ...deps(), readEndpoints: () => ({ ep: { ...endpoints.ep, agentId: "Native-1" } }) };
  expect(readObservedSessions(same, url("?ref=Native-1"), true)).toMatchObject({ status: 409, body: { candidates: [{ kind: "observed_session" }, { kind: "agent" }] } });
  expect(readObservedSessions(deps(), url("?ref=agent-1"), true).status).toBe(503);
});

test("duplicate transcript identity refuses; source failure does not become not-found", () => {
  const duplicate = cache([transcript(), transcript("codex", "Native-1", "/second")]);
  expect(readObservedSessions(deps(duplicate), url(exact), true)).toMatchObject({ status: 409, body: { error: "ambiguous_session_identity" } });
  const missing = cache([]); missing.readStatus!.sources[0].availability = "unavailable";
  expect(readObservedSessions(deps(missing), url(exact), true).status).toBe(503);
  const stale = cache(); stale.readStatus!.sources[0].availability = "unavailable";
  expect(readObservedSessions(deps(stale), url(exact), true).status).toBe(503);
});

test("bounds and strict selectors refuse unknown/mixed queries, and incomplete lookups cannot claim uniqueness", () => {
  for (const query of ["?limit=0", "?limit=201", "?limit=1&limit=2", "?force=1"]) expect(readObservedSessions(deps(), url(query), false).status).toBe(400);
  for (const query of ["?harness=codex", exact + "&ref=Native-1", exact + "&force=1"]) expect(readObservedSessions(deps(), url(query), true).status).toBe(400);
  const value = cache(Array.from({ length: 2_001 }, (_, i) => transcript("codex", String(i), String(i))));
  const result = buildObservedSessionInventory(deps(value), 2); expect(result.sessions).toHaveLength(2); expect(result.coverage.truncated).toBe(true);
  expect(readObservedSessions(deps(value), url("?ref=0"), true).status).toBe(503);
  expect(buildObservedSessionInventory(deps(cache([transcript("codex", "", "/not-an-id")]))).sessions).toEqual([]);
});
class Response extends EventEmitter { status = 0; body = ""; writableEnded = false; writeHead(status: number) { this.status = status; } end(body = "") { this.body += body; this.writableEnded = true; } }
test("HTTP mounts use local/scoped/guest policy and metadata peek, never web or a full snapshot", async () => {
  let reads = 0;
  const route = createBrokerHttpRouter({ brokerService: {} as never, host: "local", port: 1, nodeId: "node-1", runtime: { peek: () => ({ endpoints }), snapshot: () => { throw new Error("no message scan"); } },
    readObservedSessionCache: () => { reads++; return cache(); }, webControl: new Proxy({}, { get() { throw new Error("no web"); } }),
  } as unknown as BrokerHttpRouterDeps);
  for (const path of ["/v1/observed-sessions", "/v1/observed-sessions/resolve" + exact]) {
    for (const transportContext of [undefined, { transport: "remote" }, { transport: "local", scoped: {} }, { transport: "local", guest: {} }]) {
      const response = new Response(); await route({ method: "GET", url: path, headers: {}, transportContext } as any, response as any);
      expect(response.status).toBe(transportContext ? 403 : 200);
    }
    expect(meshRouteTierFor("GET", path.split("?")[0])).toBe("local");
  }
  expect(reads).toBe(2);
});
