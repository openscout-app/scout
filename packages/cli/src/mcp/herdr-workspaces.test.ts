import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { digestHerdrTopology, type HerdrPaneProjection, type HerdrSessionTopology } from "@openscout/protocol";

import {
  herdrWorkspacesDependencies,
  registerHerdrWorkspaceTools,
  type HerdrWorkspacesDependencies,
} from "./herdr-workspaces.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function clientFor(deps: HerdrWorkspacesDependencies) {
  const server = new McpServer({ name: "test", version: "1" });
  registerHerdrWorkspaceTools(server, deps);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  cleanups.push(async () => { await client.close(); await server.close(); });
  return client;
}

function pane(paneId: string, overrides: Partial<HerdrPaneProjection> = {}): HerdrPaneProjection {
  return {
    paneId, terminalId: `term-${paneId}`, tabId: "w1:t1", workspaceId: "w1", label: null,
    agent: "claude", agentStatus: "idle", agentSession: null, cwd: "/Users/you/dev/openscout",
    foregroundCwd: null, focused: false, scroll: null, ...overrides,
  };
}

function topology(session: string, panes: HerdrPaneProjection[], running = true): HerdrSessionTopology {
  return {
    session, running, observedAt: 1,
    workspaces: [{
      workspaceId: "w1", label: "main", number: 1, focused: true, activeTabId: "w1:t1", agentStatus: "idle",
      tabs: [{ tabId: "w1:t1", workspaceId: "w1", label: "build", number: 1, focused: true, agentStatus: "idle", panes, layout: null }],
    }],
  };
}

function dependencies(overrides: Partial<HerdrWorkspacesDependencies> = {}): HerdrWorkspacesDependencies {
  return {
    readDigests: async () => ({
      digests: [digestHerdrTopology(topology("openscout", [pane("w1:p1", { agentStatus: "blocked" })]))],
      truncated: false,
      available: true,
    }),
    ...overrides,
  };
}

describe("herdr_workspaces", () => {
  test("panel query returns every matching identity without choosing by activity", async () => {
    const client = await clientFor(dependencies({ readDigests: async () => ({
      available: true, truncated: false,
      digests: [digestHerdrTopology(topology("scout", [
        pane("w1:p2", { name: "devon-2-openscout", agent: "devin", agentSession: { agent: "devin", kind: "id", source: "herdr:devin", value: "plum-chef" } }),
        pane("w1:p3", { name: "devon-2-other", agentStatus: "working" }),
      ]))],
    }) }));
    const result = await client.callTool({ name: "herdr_workspaces", arguments: { query: "devon-2" } });
    const data = result.structuredContent as { results: Array<Record<string, unknown>> };
    expect(result.structuredContent).toMatchObject({ selection: "candidates_only", candidateCount: 2, truncated: false });
    expect(data.results.find((pane) => pane.name === "devon-2-openscout")).toMatchObject({
      herdrSession: "scout", paneId: "w1:p2", agentSession: { value: "plum-chef" },
      readCommand: { command: "herdr", args: ["--session", "scout", "pane", "read", "w1:p2", "--source", "recent-unwrapped", "--lines", "100", "--format", "text"] },
    });
  });

  test("a pane omitted by upstream bounds produces a bounded miss, not absence", async () => {
    const client = await clientFor(dependencies({ readDigests: async () => ({
      available: true, truncated: false,
      digests: [digestHerdrTopology(topology("scout", [pane("w1:p1", { name: "hidden" })]), { paneCap: 0 })],
    }) }));
    const result = await client.callTool({ name: "herdr_workspaces", arguments: { query: "hidden" } });
    expect(result.structuredContent).toMatchObject({ candidateCount: 0, results: [], truncated: true });
  });

  test("saved matches retain provenance and have no read command", async () => {
    const client = await clientFor(dependencies({ readDigests: async () => ({
      available: true, truncated: false,
      digests: [digestHerdrTopology({ ...topology("parked", [pane("w1:p2", { name: "devon-2" })], false), savedAt: 5 })],
    }) }));
    const result = await client.callTool({ name: "herdr_workspaces", arguments: { query: "devon-2" } });
    expect(result.structuredContent).toMatchObject({ results: [{ live: false, savedAt: 5, status: "unknown", target: null, readCommand: null }] });
  });
  test("leads with what is blocked and carries the digest as structured content", async () => {
    const client = await clientFor(dependencies());
    const result = await client.callTool({ name: "herdr_workspaces", arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("herdr · openscout — live");
    expect(text.indexOf("Requests")).toBeLessThan(text.indexOf("Grouped by directory"));
    expect(result.structuredContent).toMatchObject({
      source: "herdr_topology_projection",
      available: true,
      coverage: "this_host_only",
      truncated: false,
    });
  });

  test("an unreachable herdr reports unavailable, never an empty workspace list", async () => {
    const client = await clientFor(dependencies({
      readDigests: async () => ({ digests: [], truncated: false, available: false }),
    }));
    const result = await client.callTool({ name: "herdr_workspaces", arguments: {} });
    expect(result.structuredContent).toMatchObject({ available: false, reason: "herdr_unavailable" });
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain("not evidence that there are no workspaces");
  });

  test("no sessions is an ordinary empty state, distinct from unavailable", async () => {
    const client = await clientFor(dependencies({
      readDigests: async () => ({ digests: [], truncated: false, available: true }),
    }));
    const result = await client.callTool({ name: "herdr_workspaces", arguments: {} });
    expect(result.structuredContent).toMatchObject({ available: true, sessions: [] });
    expect((result.content as Array<{ text: string }>)[0]!.text).toBe("No herdr sessions on this host.");
  });

  test("orders sessions by what is waiting and declares its own truncation", async () => {
    const client = await clientFor(dependencies({
      readDigests: async () => ({
        digests: [
          digestHerdrTopology(topology("quiet", [pane("w1:p1"), pane("w1:p2"), pane("w1:p3")])),
          digestHerdrTopology(topology("busy", [pane("w1:p1", { agentStatus: "blocked" })])),
        ],
        truncated: false,
        available: true,
      }),
    }));
    const result = await client.callTool({ name: "herdr_workspaces", arguments: { limit: 1 } });
    const data = result.structuredContent as { truncated: boolean; sessions: Array<{ session: string }> };
    expect(data.sessions.map((entry) => entry.session)).toEqual(["busy"]);
    expect(data.truncated).toBe(true);
  });

  test("a stopped session is presented as last known, not as running work", async () => {
    const client = await clientFor(dependencies({
      readDigests: async () => ({
        digests: [digestHerdrTopology({ ...topology("parked", [pane("w1:p1")], false), savedAt: 5 })],
        truncated: false,
        available: true,
      }),
    }));
    const result = await client.callTool({ name: "herdr_workspaces", arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("herdr · parked — not running");
    expect(text).toContain("persisted last-known layout");
  });

  test("bounds its inputs", async () => {
    const client = await clientFor(dependencies({
      readDigests: async () => { throw new Error("must not read"); },
    }));
    for (const args of [{ limit: 9 }, { limit: 0 }, { session: "x".repeat(121) }]) {
      expect((await client.callTool({ name: "herdr_workspaces", arguments: args })).isError).toBe(true);
    }
  });

  test("the tool is read-only and offers no mutation verb", async () => {
    const client = await clientFor(dependencies());
    const { tools } = await client.listTools();
    const tool = tools.find((entry) => entry.name === "herdr_workspaces");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.annotations?.destructiveHint).toBe(false);
    expect(tools.map((entry) => entry.name)).toEqual(["herdr_workspaces"]);
  });
});

describe("herdrWorkspacesDependencies", () => {
  test("asks only the selected broker and snapshots its environment", async () => {
    const seen: string[] = [];
    const env = { OPENSCOUT_BROKER_URL: "http://localhost:43121", OPENSCOUT_WEB_URL: "https://web-must-not-be-used.invalid" };
    const deps = herdrWorkspacesDependencies({ env,
      fetchImpl: Object.assign(async (input: Parameters<typeof fetch>[0]) => {
        seen.push(String(input));
        return Response.json({ schema: "scout.herdr-workspaces/v1", nodeId: "node-one", scannedAt: 100,
          availability: "partial", reason: null, requestedSession: "openscout", count: 0, digests: [], truncated: true,
          coverage: { kind: "ttl_cached_probes", scope: "this_host_only", listedSessions: 1,
            limits: { sessions: 8, enumeratedSessions: 256, workspacesPerSession: 16, tabsPerSession: 64,
              inputPanesPerSession: 256, emittedPanesPerSession: 40, leadsPerSession: 12, concurrentSessions: 2 } } });
      }, { preconnect() {} }) as typeof fetch,
    });
    env.OPENSCOUT_BROKER_URL = "https://changed.invalid";
    expect(await deps.readDigests("openscout")).toMatchObject({ digests: [], truncated: true, available: true,
      runtimeRead: { nodeId: "node-one", availability: "partial", requestedSession: "openscout", sessions: [] } });
    expect(seen).toEqual(["http://localhost:43121/v1/terminal-hosts/herdr/workspaces?session=openscout"]);
  });

  test("a failed read is unavailable, with safe HTTP status and no web fallback", async () => {
    let calls = 0;
    const deps = herdrWorkspacesDependencies({ env: { OPENSCOUT_BROKER_URL: "http://localhost:43121" },
      fetchImpl: Object.assign(async () => { calls++; return Response.json({ error: "local_only", detail: "do-not-reflect" }, { status: 403 }); }, { preconnect() {} }) as typeof fetch,
    });
    expect(await deps.readDigests()).toEqual({ digests: [], truncated: false, available: false,
      readError: { status: 403, code: "local_only" } });
    expect(calls).toBe(1);
  });

  test("partial empty observations never claim there are no sessions", async () => {
    const client = await clientFor(dependencies({ readDigests: async () => ({ digests: [], available: true, truncated: true }) }));
    const result = await client.callTool({ name: "herdr_workspaces", arguments: {} });
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain("incomplete observation");
    expect(result.structuredContent).toMatchObject({ available: true, truncated: true });
  });
});
