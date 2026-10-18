import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlightRecord, InvocationRequest, ScoutDeliverRequest } from "@openscout/protocol";
import { closeDb } from "../../db/internal/db.ts";
import { SQLiteControlPlaneStore } from "../../../../runtime/src/sqlite-store.ts";
import { ControlPlaneHistoryStore } from "../../../../runtime/src/control-plane-history-store.ts";
import { emptyHistoryRotationPlan } from "../../../../runtime/src/history-rotation.ts";
import { BrokerRequestReceipts } from "../../../../runtime/src/broker-request-receipts.ts";

import {
  LOCAL_CONFIG_VERSION,
  writeLocalConfig,
} from "@openscout/runtime/local-config";
import {
  resolveRelayAgentConfig,
  writeOpenScoutSettings,
  writeProjectConfig,
} from "@openscout/runtime/setup";

import {
  askScoutQuestion,
  loadScoutBrokerContext,
  loadScoutMessages,
  markScoutConversationRead,
  openScoutPeerSession,
  readScoutBrokerHealth,
  readScoutChatQuestionHistory,
  readScoutBrokerTailDiscovery,
  readScoutBrokerTailRecent,
  resolveScoutBrokerUrl,
  ScoutDirectDeliveryUnavailableError,
  sendScoutConversationSteer,
  sendScoutConversationMessage,
  cancelScoutChatFlight,
  sendScoutDirectMessage,
  sendScoutMessage,
  waitForScoutFlight,
  watchScoutMessages,
} from "./service.ts";

const originalHome = process.env.HOME;
const originalOpenScoutHome = process.env.OPENSCOUT_HOME;
const originalSupportDirectory = process.env.OPENSCOUT_SUPPORT_DIRECTORY;
const originalControlHome = process.env.OPENSCOUT_CONTROL_HOME;
const originalRelayHub = process.env.OPENSCOUT_RELAY_HUB;
const originalBrokerUrl = process.env.OPENSCOUT_BROKER_URL;
const originalBrokerInternalUrl = process.env.OPENSCOUT_BROKER_INTERNAL_URL;
const originalBrokerSocketPath = process.env.OPENSCOUT_BROKER_SOCKET_PATH;
const originalSkipUserProjectHints = process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS;
const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;
const testDirectories = new Set<string>();
const testCleanups: Array<() => void> = [];

afterEach(() => {
  closeDb();
  for (const cleanup of testCleanups.splice(0).reverse()) cleanup();
  process.env.HOME = originalHome;
  if (originalOpenScoutHome === undefined) {
    delete process.env.OPENSCOUT_HOME;
  } else {
    process.env.OPENSCOUT_HOME = originalOpenScoutHome;
  }
  if (originalSupportDirectory === undefined) {
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
  } else {
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = originalSupportDirectory;
  }
  if (originalControlHome === undefined) {
    delete process.env.OPENSCOUT_CONTROL_HOME;
  } else {
    process.env.OPENSCOUT_CONTROL_HOME = originalControlHome;
  }
  if (originalRelayHub === undefined) {
    delete process.env.OPENSCOUT_RELAY_HUB;
  } else {
    process.env.OPENSCOUT_RELAY_HUB = originalRelayHub;
  }
  if (originalBrokerUrl === undefined) {
    delete process.env.OPENSCOUT_BROKER_URL;
  } else {
    process.env.OPENSCOUT_BROKER_URL = originalBrokerUrl;
  }
  if (originalBrokerInternalUrl === undefined) {
    delete process.env.OPENSCOUT_BROKER_INTERNAL_URL;
  } else {
    process.env.OPENSCOUT_BROKER_INTERNAL_URL = originalBrokerInternalUrl;
  }
  if (originalBrokerSocketPath === undefined) {
    delete process.env.OPENSCOUT_BROKER_SOCKET_PATH;
  } else {
    process.env.OPENSCOUT_BROKER_SOCKET_PATH = originalBrokerSocketPath;
  }
  if (originalSkipUserProjectHints === undefined) {
    delete process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS;
  } else {
    process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS = originalSkipUserProjectHints;
  }
  globalThis.fetch = originalFetch;
  Date.now = originalDateNow;
  for (const directory of testDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  testDirectories.clear();
});

function useIsolatedOpenScoutHome(): string {
  const home = mkdtempSync(join(tmpdir(), "openscout-desktop-broker-"));
  testDirectories.add(home);
  process.env.HOME = home;
  process.env.OPENSCOUT_HOME = join(home, ".openscout");
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
  process.env.OPENSCOUT_CONTROL_HOME = join(home, ".openscout", "control-plane");
  process.env.OPENSCOUT_RELAY_HUB = join(home, ".openscout", "relay");
  process.env.OPENSCOUT_BROKER_URL = "http://broker.test";
  process.env.OPENSCOUT_BROKER_SOCKET_PATH = join(home, "broker.sock");
  process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS = "1";
  return home;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("resolveScoutBrokerUrl", () => {
  test("uses local config host and broker port for same-machine broker API", () => {
    useIsolatedOpenScoutHome();
    writeLocalConfig({
      version: LOCAL_CONFIG_VERSION,
      host: "127.0.0.1",
      ports: { broker: 43110 },
    });
    delete process.env.OPENSCOUT_BROKER_INTERNAL_URL;
    process.env.OPENSCOUT_BROKER_URL = "http://mesh.example.test:43110";

    expect(resolveScoutBrokerUrl()).toBe("http://127.0.0.1:43110");
  });
});

describe("markScoutConversationRead", () => {
  test("posts directly without loading the broker snapshot", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: url.pathname,
        body: request.method === "POST" ? await request.json() : undefined,
      });

      return jsonResponse({
        ok: true,
        cursor: {
          conversationId: "chn-direct-read",
          readerNodeId: "node-local",
          lastReadMessageId: "msg-latest",
          lastReadAt: 1234,
        },
        acknowledgedDeliveries: 0,
      });
    }) as unknown as typeof fetch;

    const result = await markScoutConversationRead({
      conversationId: "chn-direct-read",
      lastReadMessageId: "msg-latest",
      lastReadAt: 1234,
      baseUrl: "http://broker.test",
    });

    expect(result.ok).toBe(true);
    expect(requests).toEqual([{
      method: "POST",
      path: "/v1/conversations/chn-direct-read/read-cursors",
      body: {
        lastReadMessageId: "msg-latest",
        lastReadAt: 1234,
      },
    }]);
  });
});

describe("loadScoutBrokerContext", () => {
  test("requests a 24-hour working-set snapshot by default", async () => {
    useIsolatedOpenScoutHome();
    let snapshotSince: number | null = null;
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (url.pathname === "/v1/snapshot") {
        snapshotSince = Number(url.searchParams.get("since"));
        return jsonResponse({
          nodes: {},
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          bindings: {},
          messages: {},
          readCursors: {},
          invocations: {},
          flights: {},
          collaborationRecords: {},
        });
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    }) as unknown as typeof fetch;

    const expectedSince = Date.now() - 24 * 60 * 60 * 1_000;
    const context = await loadScoutBrokerContext();

    expect(context?.node.id).toBe("node-1");
    expect(snapshotSince).toBeGreaterThanOrEqual(expectedSince - 60 * 1_000);
    expect(snapshotSince).toBeLessThanOrEqual(Date.now() - 24 * 60 * 60 * 1_000);
  });

  test("coalesces concurrent reads for the same bounded snapshot", async () => {
    useIsolatedOpenScoutHome();
    let snapshotRequests = 0;
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (url.pathname === "/v1/snapshot") {
        snapshotRequests += 1;
        await Bun.sleep(10);
        return jsonResponse({
          nodes: {},
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          bindings: {},
          messages: {},
          readCursors: {},
          invocations: {},
          flights: {},
          collaborationRecords: {},
        });
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    }) as unknown as typeof fetch;

    const contexts = await Promise.all([
      loadScoutBrokerContext(undefined, { since: 1234 }),
      loadScoutBrokerContext(undefined, { since: 1234 }),
      loadScoutBrokerContext(undefined, { since: 1234 }),
    ]);

    expect(contexts.every((context) => context?.node.id === "node-1")).toBe(true);
    expect(snapshotRequests).toBe(1);
  });

  test("can warm a cold snapshot without blocking the first caller", async () => {
    useIsolatedOpenScoutHome();
    let snapshotRequests = 0;
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (url.pathname === "/v1/snapshot") {
        snapshotRequests += 1;
        return jsonResponse({
          nodes: {},
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          bindings: {},
          messages: {},
          readCursors: {},
          invocations: {},
          flights: {},
          collaborationRecords: {},
        });
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    }) as unknown as typeof fetch;

    await expect(loadScoutBrokerContext(undefined, {
      since: 2468,
      waitForInitial: false,
    })).resolves.toBeNull();

    await expect(loadScoutBrokerContext(undefined, { since: 2468 })).resolves.toMatchObject({
      node: { id: "node-1" },
    });
    expect(snapshotRequests).toBe(1);
  });

  test("serves a stale snapshot while refreshing an expired cache entry", async () => {
    useIsolatedOpenScoutHome();
    let now = originalDateNow();
    Date.now = () => now;
    let advertiseScope: "local" | "mesh" = "local";
    let snapshotRequests = 0;
    let signalBackgroundSnapshot: (() => void) | null = null;
    const backgroundSnapshotRequested = new Promise<void>((resolve) => {
      signalBackgroundSnapshot = resolve;
    });
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1", advertiseScope });
      }
      if (url.pathname === "/v1/snapshot") {
        snapshotRequests += 1;
        if (snapshotRequests === 2) signalBackgroundSnapshot?.();
        return jsonResponse({
          nodes: {},
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          bindings: {},
          messages: {},
          readCursors: {},
          invocations: {},
          flights: {},
          collaborationRecords: {},
        });
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    }) as unknown as typeof fetch;

    expect((await loadScoutBrokerContext(undefined, { since: 5678 }))?.node.advertiseScope).toBe("local");
    advertiseScope = "mesh";
    now += 5_001;

    // Ordinary polling inside the 30-second fallback window reuses the large
    // snapshot. Broker writes and explicit force reads invalidate separately.
    expect((await loadScoutBrokerContext(undefined, { since: 5678 }))?.node.advertiseScope).toBe("local");
    await Bun.sleep(0);
    expect(snapshotRequests).toBe(1);

    now += 25_000;

    // Expiry begins a refresh, but the route-facing read remains immediate and
    // receives the last known-good snapshot instead of awaiting broker JSON.
    expect((await loadScoutBrokerContext(undefined, { since: 5678 }))?.node.advertiseScope).toBe("local");
    await backgroundSnapshotRequested;
    await Bun.sleep(0);

    expect((await loadScoutBrokerContext(undefined, { since: 5678 }))?.node.advertiseScope).toBe("mesh");
    expect(snapshotRequests).toBe(2);
  });

  test("can bypass a primed context cache after an out-of-band broker mutation", async () => {
    useIsolatedOpenScoutHome();
    let advertiseScope: "local" | "mesh" = "local";
    let snapshotRequests = 0;
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1", advertiseScope });
      }
      if (url.pathname === "/v1/snapshot") {
        snapshotRequests += 1;
        return jsonResponse({
          nodes: {},
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          bindings: {},
          messages: {},
          readCursors: {},
          invocations: {},
          flights: {},
          collaborationRecords: {},
        });
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    }) as unknown as typeof fetch;

    expect((await loadScoutBrokerContext(undefined, { since: 4321 }))?.node.advertiseScope).toBe("local");
    advertiseScope = "mesh";
    expect((await loadScoutBrokerContext(undefined, { since: 4321 }))?.node.advertiseScope).toBe("local");
    expect((await loadScoutBrokerContext(undefined, { since: 4321, force: true }))?.node.advertiseScope).toBe("mesh");
    expect((await loadScoutBrokerContext(undefined, { since: 4321 }))?.node.advertiseScope).toBe("mesh");
    expect(snapshotRequests).toBe(2);
  });

  test("keeps narrow snapshots separate from the default cache", async () => {
    useIsolatedOpenScoutHome();
    const snapshotQueries: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (url.pathname === "/v1/snapshot") {
        snapshotQueries.push(url.search);
        return jsonResponse({
          nodes: {},
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          bindings: {},
          messages: {},
          readCursors: {},
          invocations: {},
          flights: {},
          collaborationRecords: {},
        });
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    }) as unknown as typeof fetch;

    await Promise.all([
      loadScoutBrokerContext(undefined, { since: 1234 }),
      loadScoutBrokerContext(undefined, { since: 1234, scope: "conversations" }),
      loadScoutBrokerContext(undefined, { since: 1234, scope: "agents" }),
    ]);

    expect(snapshotQueries).toHaveLength(3);
    expect(snapshotQueries).toContain("?since=1234");
    expect(snapshotQueries).toContain("?since=1234&scope=conversations");
    expect(snapshotQueries).toContain("?since=1234&scope=agents");
  });

  test("invalidates cached snapshots after a successful broker write", async () => {
    const home = useIsolatedOpenScoutHome();
    let snapshotRequests = 0;
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        snapshotRequests += 1;
        return jsonResponse({
          nodes: {},
          actors: {
            operator: { id: "operator", kind: "person", displayName: "Operator" },
          },
          agents: {},
          endpoints: {},
          conversations: {},
          bindings: {},
          messages: {},
          readCursors: {},
          invocations: {},
          flights: {},
          collaborationRecords: {},
        });
      }
      if (
        request.method === "POST"
        && (url.pathname === "/v1/conversations" || url.pathname === "/v1/messages")
      ) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    }) as unknown as typeof fetch;

    await loadScoutBrokerContext();
    await sendScoutMessage({
      senderId: "operator",
      body: "Keep the first paint continuous.",
      channel: "lifecycle-cache-test",
      currentDirectory: home,
    });
    await loadScoutBrokerContext();

    expect(snapshotRequests).toBe(2);
  });
});

describe("readScoutBrokerHealth", () => {
  test("preserves broker build identity and child service states", async () => {
    useIsolatedOpenScoutHome();
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({
          ok: true,
          nodeId: "node-1",
          meshId: "mesh-1",
          build: {
            packageName: "@openscout/runtime",
            version: "0.test",
            mode: "dev",
          },
          services: {
            web: {
              managed: true,
              managedBy: "broker",
              state: "running",
              pid: 4321,
              port: 43120,
              url: "http://127.0.0.1:43120",
              healthy: null,
            },
            localEdge: {
              managed: true,
              managedBy: "base",
              state: "unknown",
              healthy: null,
            },
          },
          counts: {
            nodes: 1,
            actors: 2,
            agents: 3,
            conversations: 4,
            messages: 5,
            flights: 6,
            collaborationRecords: 7,
          },
        });
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    }) as unknown as typeof fetch;

    const health = await readScoutBrokerHealth();

    expect(health.reachable).toBe(true);
    expect(health.build?.version).toBe("0.test");
    expect(health.services?.web?.state).toBe("running");
    expect(health.services?.web?.pid).toBe(4321);
    expect(health.services?.localEdge?.managedBy).toBe("base");
    expect(health.counts?.collaborationRecords).toBe(7);
  });
});

describe("broker status resilience", () => {
  test("distinguishes a slow ready response, degraded HTTP, invalid health, and recovery", async () => {
    useIsolatedOpenScoutHome();
    let now = 10_000;
    Date.now = () => now;
    let mode = "slow";
    globalThis.fetch = (async () => {
      if (mode === "slow") { now += 1_200; return jsonResponse({ ok: true }); }
      if (mode === "degraded") return jsonResponse({ error: "warming" }, 503);
      if (mode === "invalid") return jsonResponse({ ok: "true" });
      return jsonResponse({ ok: true });
    }) as typeof fetch;
    const slow = await readScoutBrokerHealth();
    expect(slow).toMatchObject({ reachable: true, ok: true, observation: { state: "slow", lastSuccessAt: 11_200, durationMs: 1_200 } });
    now += 100;
    mode = "degraded";
    expect(await readScoutBrokerHealth()).toMatchObject({ reachable: true, ok: false, observation: { state: "degraded", statusCode: 503, lastSuccessAt: 11_200 } });
    mode = "invalid";
    expect(await readScoutBrokerHealth()).toMatchObject({ reachable: true, ok: false, observation: { state: "degraded", lastSuccessAt: 11_200 } });
    mode = "ready";
    expect(await readScoutBrokerHealth()).toMatchObject({ ok: true, observation: { state: "healthy", lastSuccessAt: 11_300 } });
  });

  test("bounds a slow health probe even with an unbounded caller signal and preserves prior success", async () => {
    useIsolatedOpenScoutHome();
    globalThis.fetch = (async () => jsonResponse({ ok: true })) as typeof fetch;
    const success = await readScoutBrokerHealth();
    let aborted = false;
    globalThis.fetch = (async (_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
    })) as typeof fetch;
    const started = Date.now();
    const health = await readScoutBrokerHealth(undefined, { signal: new AbortController().signal, timeoutMs: 20 });
    expect(Date.now() - started).toBeLessThan(500);
    expect(aborted).toBe(true);
    expect(health).toMatchObject({ ok: false, observation: { state: "timed_out", lastSuccessAt: success.observation!.lastSuccessAt } });
    globalThis.fetch = (async () => { throw new Error("Connection refused"); }) as typeof fetch;
    expect(await readScoutBrokerHealth()).toMatchObject({ reachable: false, ok: false, observation: { state: "unreachable" } });
    globalThis.fetch = (async () => jsonResponse({ ok: true })) as typeof fetch;
    expect(await readScoutBrokerHealth()).toMatchObject({ reachable: true, ok: true, observation: { state: "healthy" } });
  });

  test("bounds the whole context read when health succeeds but the snapshot stalls", async () => {
    useIsolatedOpenScoutHome();
    let snapshotAborted = false;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/health") return jsonResponse({ ok: true });
      if (url.pathname === "/v1/node") return jsonResponse({ id: "node-1" });
      return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => {
        snapshotAborted = true;
        reject(init!.signal!.reason);
      }, { once: true }));
    }) as typeof fetch;
    const started = Date.now();
    expect(await loadScoutBrokerContext(undefined, { since: 993, signal: new AbortController().signal })).toBeNull();
    expect(snapshotAborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(6_500);
  }, 10_000);

  test("cold context failures back off and retry after the short failure window", async () => {
    useIsolatedOpenScoutHome();
    let now = 10_000;
    Date.now = () => now;
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; throw new Error("unavailable"); }) as typeof fetch;
    expect(await loadScoutBrokerContext(undefined, { since: 992 })).toBeNull();
    expect(await loadScoutBrokerContext(undefined, { since: 992 })).toBeNull();
    expect(calls).toBe(1);
    now += 2_001;
    expect(await loadScoutBrokerContext(undefined, { since: 992 })).toBeNull();
    expect(calls).toBe(2);
  });

  test("failed context refreshes retain provenance, expire old data, and recover", async () => {
    useIsolatedOpenScoutHome();
    let now = 10_000;
    Date.now = () => now;
    let failing = false;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/health") return jsonResponse({ ok: true });
      if (url.pathname === "/v1/node") return jsonResponse({ id: "node-1" });
      if (failing) throw new Error("snapshot unavailable");
      return jsonResponse({ nodes: {}, messages: {} });
    }) as typeof fetch;
    const first = await loadScoutBrokerContext(undefined, { since: 991 });
    expect(first?.freshness).toMatchObject({ lastSuccessAt: 10_000, stale: false });
    failing = true;
    now += 30_001;
    const stale = await loadScoutBrokerContext(undefined, { since: 991 });
    expect(stale?.freshness).toMatchObject({ lastSuccessAt: 10_000, stale: true, refreshing: true });
    await Bun.sleep(0);
    const failed = await loadScoutBrokerContext(undefined, { since: 991 });
    expect(failed?.freshness).toMatchObject({ lastSuccessAt: 10_000, lastFailureAt: now, stale: true });
    now += 30_001;
    await loadScoutBrokerContext(undefined, { since: 991 });
    await Bun.sleep(0);
    now += 30_001;
    expect(await loadScoutBrokerContext(undefined, { since: 991 })).toBeNull();
    await Bun.sleep(0);
    failing = false;
    now += 30_001;
    expect(await loadScoutBrokerContext(undefined, { since: 991 })).toBeNull();
    await Bun.sleep(0);
    expect((await loadScoutBrokerContext(undefined, { since: 991 }))?.freshness).toMatchObject({ lastSuccessAt: now, stale: false, lastFailureAt: null });
  });
});

describe("readScoutBrokerTailRecent", () => {
  test("requests transcript backfill for a cold tail snapshot", async () => {
    useIsolatedOpenScoutHome();
    let requestedUrl: URL | null = null;
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requestedUrl = new URL(request.url);
      return jsonResponse({ events: [] });
    }) as typeof fetch;

    await readScoutBrokerTailRecent(50);

    expect(requestedUrl?.pathname).toBe("/v1/tail/recent");
    expect(requestedUrl?.searchParams.get("limit")).toBe("50");
    expect(requestedUrl?.searchParams.get("transcripts")).toBe("1");
    expect(requestedUrl?.searchParams.has("mode")).toBe(false);
  });

  test("asks for each session's latest reply when the feed wants it", async () => {
    useIsolatedOpenScoutHome();
    let requestedUrl: URL | null = null;
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requestedUrl = new URL(request.url);
      return jsonResponse({ events: [] });
    }) as typeof fetch;

    await readScoutBrokerTailRecent(60, undefined, { mode: "assistant-replies", windowMs: 48 * 60 * 60 * 1_000 });

    expect(requestedUrl?.searchParams.get("mode")).toBe("assistant-replies");
    expect(requestedUrl?.searchParams.get("windowMs")).toBe(String(24 * 60 * 60 * 1_000));
  });
});

describe("readScoutBrokerTailDiscovery", () => {
  test("reads the broker materialized discovery inventory", async () => {
    useIsolatedOpenScoutHome();
    let requestedUrl: URL | null = null;
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requestedUrl = new URL(request.url);
      return jsonResponse({
        generatedAt: 123,
        processes: [],
        transcripts: [],
        totals: {
          total: 0,
          scoutManaged: 0,
          hudsonManaged: 0,
          unattributed: 0,
          transcripts: 0,
        },
      });
    }) as typeof fetch;

    const discovery = await readScoutBrokerTailDiscovery();

    expect(requestedUrl?.pathname).toBe("/v1/tail/discover");
    expect(discovery?.generatedAt).toBe(123);
  });
});

describe("askScoutQuestion", () => {
  test("registers discovered targets and lets the broker wake them on demand", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const talkieRoot = join(workspaceRoot, "talkie");

    mkdirSync(join(talkieRoot, ".git"), { recursive: true });
    writeFileSync(join(talkieRoot, "AGENTS.md"), "# talkie\n", "utf8");

    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [workspaceRoot],
        includeCurrentRepo: false,
      },
    });

    const requests: Array<{ method: string; path: string; body?: any }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/agents") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/conversations") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        const body = await request.json() as { requesterId: string; targetLabel: string; body: string };
        requests[requests.length - 1]!.body = body;
        return jsonResponse({
          kind: "delivery",
          accepted: true,
          routeKind: "dm",
          conversation: {
            id: "dm.operator.talkie",
            kind: "direct",
            title: "Talkie",
            visibility: "private",
            authorityNodeId: "node-1",
            participantIds: ["operator", "talkie"],
          },
          message: {
            id: "msg-1",
            conversationId: "dm.operator.talkie",
            actorId: body.requesterId,
            originNodeId: "node-1",
            class: "agent",
            body: body.body,
            visibility: "private",
            policy: "durable",
            createdAt: Date.now(),
          },
          flight: {
            id: "flt-1",
            invocationId: "inv-1",
            requesterId: body.requesterId,
            targetAgentId: "talkie",
            state: "waking",
            summary: "Talkie waking.",
            startedAt: Date.now(),
          },
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await askScoutQuestion({
      senderId: "operator",
      targetLabel: "talkie",
      body: "build it for me",
      currentDirectory: workspaceRoot,
    });

    expect(result.usedBroker).toBe(true);
    expect(result.flight?.id).toBe("flt-1");
    expect(result.flight?.state).toBe("waking");
    expect(result.unresolvedTarget).toBeUndefined();
    expect(result.targetDiagnostic).toBeUndefined();
    expect(requests.some((request) => request.path === "/v1/agents")).toBe(false);
    expect(requests.some((request) => request.path === "/v1/messages")).toBe(false);
    expect(requests.some((request) => request.path === "/v1/invocations")).toBe(false);
    expect(requests.some((request) => request.path === "/v1/deliver")).toBe(true);
    expect(requests.find((request) => request.path === "/v1/deliver")?.body?.execution)
      .toEqual({ session: "new" });
    expect(requests.some((request) => request.path === "/v1/endpoints")).toBe(false);
  }, 15000);

  test("returns broker delivery rejections as structured unresolved targets", async () => {
    const home = useIsolatedOpenScoutHome();

    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {
            operator: {
              id: "operator",
              kind: "person",
              displayName: "Operator",
            },
          },
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        return jsonResponse({
          kind: "rejected",
          accepted: false,
          reason: "unknown_target",
          rejection: {
            id: "dispatch-1",
            requesterId: "operator",
            kind: "unknown",
            askedLabel: "@ghost",
            detail: "no agent matches @ghost",
            candidates: [],
            dispatchedAt: Date.now(),
            dispatcherNodeId: "node-1",
          },
        }, 422);
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await askScoutQuestion({
      senderId: "operator",
      targetLabel: "ghost",
      body: "build it for me",
      currentDirectory: home,
    });

    expect(result.usedBroker).toBe(true);
    expect(result.unresolvedTarget).toBe("ghost");
    expect(result.targetDiagnostic).toEqual({
      agentId: "@ghost",
      state: "unknown",
      registrationKind: null,
      projectRoot: null,
    });
  }, 15000);

  test("preserves exact session choices for session-only handle ambiguity", async () => {
    const home = useIsolatedOpenScoutHome();
    const detail = "@composer-review matches multiple live targets: session:session-one, session:session-two; use one exact session:<id> target";

    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {
            operator: {
              id: "operator",
              kind: "person",
              displayName: "Operator",
            },
          },
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        return jsonResponse({
          kind: "rejected",
          accepted: false,
          reason: "ambiguous_target",
          rejection: {
            id: "dispatch-session-ambiguity",
            requesterId: "operator",
            kind: "ambiguous",
            askedLabel: "@composer-review",
            detail,
            candidates: [],
            dispatchedAt: Date.now(),
            dispatcherNodeId: "node-1",
          },
        }, 422);
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await askScoutQuestion({
      senderId: "operator",
      target: {
        kind: "existing_handle",
        handle: "composer-review",
        value: "@composer-review",
      },
      body: "build it for me",
      currentDirectory: home,
    });

    expect(result.usedBroker).toBe(true);
    expect(result.unresolvedTarget).toBe("@composer-review");
    expect(result.targetDiagnostic).toEqual({
      state: "ambiguous",
      detail,
      candidates: [],
    });
  }, 15000);

  test("refreshes stale exact targets before asking", async () => {
    const home = useIsolatedOpenScoutHome();
    const repo = join(home, "dev", "openscout");
    mkdirSync(join(repo, ".git"), { recursive: true });
    await writeProjectConfig(repo, {
      version: 1,
      project: {
        id: "openscout",
        name: "OpenScout",
      },
      agent: {
        id: "project-agent",
      },
    });
    const configured = await resolveRelayAgentConfig("project-agent", {
      currentDirectory: repo,
    });
    expect(configured).not.toBeNull();
    const configuredAgentId = configured!.agentId;

    const requests: Array<{ method: string; path: string; body?: any }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : undefined;
      requests.push({ method: request.method, path: url.pathname, body });

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {
            operator: {
              id: "operator",
              kind: "person",
              displayName: "Operator",
            },
          },
          agents: {
            [configuredAgentId]: {
              id: configuredAgentId,
              kind: "agent",
              definitionId: "project-agent",
              displayName: "Project Agent",
              metadata: {
                staleLocalRegistration: true,
                projectRoot: repo,
              },
            },
          },
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/agents") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        return jsonResponse({
          kind: "delivery",
          accepted: true,
          routeKind: "dm",
          conversation: {
            id: `dm.operator.${configuredAgentId}`,
            kind: "direct",
            title: "Project Agent",
            visibility: "private",
            authorityNodeId: "node-1",
            participantIds: ["operator", configuredAgentId],
          },
          message: {
            id: "msg-1",
            conversationId: `dm.operator.${configuredAgentId}`,
            actorId: "operator",
            originNodeId: "node-1",
            class: "agent",
            body: body.body,
            visibility: "private",
            policy: "durable",
            createdAt: Date.now(),
          },
          targetAgentId: configuredAgentId,
          flight: {
            id: "flt-1",
            invocationId: "inv-1",
            requesterId: "operator",
            targetAgentId: configuredAgentId,
            state: "waking",
          },
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await askScoutQuestion({
      senderId: "operator",
      targetLabel: configuredAgentId,
      targetAgentId: configuredAgentId,
      body: "inspect state",
      currentDirectory: repo,
    });

    expect(result.usedBroker).toBe(true);
    expect(result.flight?.targetAgentId).toBe(configuredAgentId);
    expect(requests.some((request) => (
      request.method === "POST" &&
      request.path === "/v1/agents" &&
      request.body?.id === configuredAgentId &&
      request.body?.metadata?.staleLocalRegistration !== true
    ))).toBe(true);
    expect(requests.find((request) => request.path === "/v1/deliver")?.body)
      .toMatchObject({
        targetAgentId: configuredAgentId,
        targetLabel: configuredAgentId,
        execution: { session: "new" },
      });
  }, 15000);
});

describe("sendScoutMessage", () => {
  test("creates named channels with opaque conversation ids and alias metadata", async () => {
    const home = useIsolatedOpenScoutHome();
    const requests: Array<{ method: string; path: string; search: string; body?: any }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : undefined;
      requests.push({ method: request.method, path: url.pathname, search: url.search, body });

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {
            operator: {
              id: "operator",
              kind: "person",
              displayName: "Operator",
            },
          },
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/conversations") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        return jsonResponse({ ok: true });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await sendScoutMessage({
      senderId: "operator",
      body: "ship the channel primitive",
      channel: "talkie-next",
      currentDirectory: home,
      createdAtMs: 12345,
    });

    const conversationPost = requests.find((request) => request.path === "/v1/conversations");
    const messagePost = requests.find((request) => request.path === "/v1/messages");

    expect(result).toEqual({
      usedBroker: true,
      conversationId: conversationPost?.body?.id,
      messageId: messagePost?.body?.id,
      invokedTargets: [],
      unresolvedTargets: [],
    });
    expect(conversationPost?.body).toEqual(expect.objectContaining({
      kind: "channel",
      title: "talkie-next",
      visibility: "workspace",
      metadata: expect.objectContaining({
        channel: "talkie-next",
        naturalKey: "channel:talkie-next",
      }),
    }));
    expect(conversationPost?.body?.id).toMatch(/^chn-[0-9a-f]{32}$/);
    expect(messagePost?.body).toMatchObject({
      conversationId: conversationPost?.body?.id,
      actorId: "operator",
      body: "ship the channel primitive",
      metadata: {
        relayChannel: "talkie-next",
      },
    });
  }, 15000);
});

describe("sendScoutConversationMessage", () => {
  test("fans a group Chat post out to its agent participants without creating invocations", async () => {
    const home = useIsolatedOpenScoutHome();
    const requests: Array<{ method: string; path: string; body?: any }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : undefined;
      requests.push({ method: request.method, path: url.pathname, body });

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: { operator: { id: "operator", kind: "person", displayName: "Operator" } },
          agents: {
            fable: { id: "fable", kind: "agent", displayName: "Fable" },
            talkie: { id: "talkie", kind: "agent", displayName: "Talkie" },
          },
          endpoints: {},
          conversations: {
            "chn-iris": {
              id: "chn-iris",
              kind: "channel",
              title: "iris-architecture",
              visibility: "workspace",
              authorityNodeId: "node-1",
              participantIds: ["operator", "fable", "talkie"],
            },
            "chn-iris-thread": {
              id: "chn-iris-thread",
              kind: "thread",
              title: "Thread · iris-architecture",
              visibility: "workspace",
              authorityNodeId: "node-1",
              participantIds: ["operator", "fable", "talkie"],
              parentConversationId: "chn-iris",
              messageId: "msg-anchor",
            },
          },
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await sendScoutConversationMessage({
      conversationId: "chn-iris",
      senderId: "operator",
      body: "Keep the first slice simple.",
      clientMessageId: "web-channel-stable-1",
      notifyParticipantAgents: true,
      currentDirectory: home,
      source: "scout-web",
    });
    const messagePost = requests.find((request) => request.path === "/v1/messages");

    expect(result.invokedTargets).toEqual([]);
    expect(result.notifiedTargets).toEqual(["fable", "talkie"]);
    expect(requests.some((request) => request.path === "/v1/invocations")).toBe(false);
    expect(messagePost?.body).toMatchObject({
      audience: { notify: ["fable", "talkie"], reason: "conversation_visibility" },
      metadata: {
        deliveryIntent: "group_message",
        relayTargetIds: ["fable", "talkie"],
        clientMessageId: "web-channel-stable-1",
      },
    });

    await sendScoutConversationMessage({
      conversationId: "chn-iris",
      senderId: "operator",
      body: "Keep the first slice simple.",
      clientMessageId: "web-channel-stable-1",
      notifyParticipantAgents: true,
      currentDirectory: home,
      source: "scout-web",
    });
    const retriedMessagePosts = requests.filter((request) => request.path === "/v1/messages");
    expect(retriedMessagePosts).toHaveLength(2);
    expect(retriedMessagePosts[0]?.body.id).toBe(retriedMessagePosts[1]?.body.id);
    expect(retriedMessagePosts[0]?.body.id).toMatch(/^m-client-/);

    requests.length = 0;
    const attention = await sendScoutConversationMessage({
      conversationId: "chn-iris", senderId: "operator", body: "@fable quoted text",
      clientMessageId: "attention-1", notifyParticipantAgents: false, resolveMentionsFromBody: false,
      attentionMentions: [{ actorId: "fable", label: "Fable" }], currentDirectory: home,
    });
    expect(attention.invokedTargets).toEqual([]);
    expect(requests.some(request => request.path === "/v1/invocations" || request.path === "/v1/deliver")).toBe(false);
    expect(requests.find(request => request.path === "/v1/messages")?.body).toMatchObject({
      mentions: [{ actorId: "fable", label: "Fable" }], audience: { delivery: "none" },
    });

    requests.length = 0;
    const threadResult = await sendScoutConversationMessage({
      conversationId: "chn-iris-thread",
      senderId: "operator",
      body: "Keep this in the child thread.",
      notifyParticipantAgents: true,
      currentDirectory: home,
      source: "scout-web",
    });
    const threadMessagePost = requests.find((request) => request.path === "/v1/messages");

    expect(threadResult.invokedTargets).toEqual([]);
    expect(threadResult.notifiedTargets).toEqual(["fable", "talkie"]);
    expect(requests.some((request) => request.path === "/v1/invocations")).toBe(false);
    expect(threadMessagePost?.body).toMatchObject({
      conversationId: "chn-iris-thread",
      audience: { notify: ["fable", "talkie"], reason: "conversation_visibility" },
    });
  }, 15000);

  test("appends operator contributions to the existing conversation", async () => {
    const home = useIsolatedOpenScoutHome();
    const requests: Array<{ method: string; path: string; body?: any }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : undefined;
      requests.push({ method: request.method, path: url.pathname, body });

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {
            operator: {
              id: "operator",
              kind: "person",
              displayName: "Operator",
            },
          },
          agents: {
            "hudson.main.mini": {
              id: "hudson.main.mini",
              kind: "agent",
              handle: "hudson",
              selector: "@hudson",
              displayName: "Hudson",
              metadata: { selector: "@hudson" },
            },
            "narrative-studio.main.mini": {
              id: "narrative-studio.main.mini",
              kind: "agent",
              handle: "narrative-studio",
              selector: "@narrative-studio",
              displayName: "Narrative Studio",
              metadata: { selector: "@narrative-studio" },
            },
          },
          endpoints: {},
          conversations: {
            "dm.hudson.main.mini.narrative-studio.main.mini": {
              id: "dm.hudson.main.mini.narrative-studio.main.mini",
              kind: "direct",
              title: "Hudson <> Narrative Studio",
              visibility: "private",
              authorityNodeId: "node-1",
              participantIds: ["hudson.main.mini", "narrative-studio.main.mini"],
            },
          },
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        return jsonResponse({ ok: true });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await sendScoutConversationMessage({
      conversationId: "dm.hudson.main.mini.narrative-studio.main.mini",
      senderId: "operator",
      body: "@hudson hi",
      currentDirectory: home,
      source: "scout-web",
    });
    const messagePost = requests.find((request) => request.path === "/v1/messages");

    expect(result).toEqual({
      usedBroker: true,
      conversationId: "dm.hudson.main.mini.narrative-studio.main.mini",
      messageId: messagePost?.body?.id,
      invokedTargets: ["hudson.main.mini"],
      unresolvedTargets: [],
    });
    expect(requests.some((request) => request.path === "/v1/deliver")).toBe(false);
    expect(messagePost?.body)
      .toMatchObject({
        conversationId: "dm.hudson.main.mini.narrative-studio.main.mini",
        actorId: "operator",
        body: "@hudson hi",
        mentions: [{ actorId: "hudson.main.mini", label: "@hudson" }],
        audience: { notify: ["hudson.main.mini"], reason: "mention" },
        metadata: {
          source: "scout-web",
          destinationKind: "conversation",
          destinationId: "dm.hudson.main.mini.narrative-studio.main.mini",
        },
      });
  }, 15000);
});

describe("sendScoutConversationSteer", () => {
  for (const scenario of ["reply", "offline", "missing", "receipt", "durable", "relocated", "relocated_preferences", "unavailable", "unavailable_preferences", "unavailable_new", "unavailable_existing"] as const) {
    test(`continues the conversation's worker instead of another endpoint (${scenario})`, async () => {
      const home = useIsolatedOpenScoutHome();
      const agentId = "project-darwin.master.mini";
      const conversationId = "chn-darwin";
      const unavailableHistory = scenario.startsWith("unavailable");
      const requestedExecution: InvocationRequest["execution"] = scenario === "unavailable_new"
        ? { session: "new", harness: "codex" }
        : scenario === "unavailable_existing"
          ? { session: "existing", targetSessionId: "requested-session" }
          : scenario === "relocated_preferences" || scenario === "unavailable_preferences"
            ? { harness: "codex", model: "requested-model" }
            : undefined;
      const invocations: any[] = [];
      const invocation: InvocationRequest = {
        id: "inv-this-chat", conversationId, targetAgentId: agentId, requesterId: "operator",
        requesterNodeId: "node-1", action: "consult", task: "original", createdAt: 1000,
        execution: { session: "new" }, ensureAwake: true, stream: false,
      };
      const flight: FlightRecord = {
        id: "flt-this-chat", invocationId: invocation.id, targetAgentId: agentId, requesterId: "operator",
        state: "completed", startedAt: 1000, completedAt: 2000,
        metadata: { dispatchAck: { sessionId: "session-this-chat" } },
      };
      let historicalStore: SQLiteControlPlaneStore | undefined;
      let historicalReads = 0;
      if (scenario.startsWith("relocated") || unavailableHistory) {
        mkdirSync(process.env.OPENSCOUT_CONTROL_HOME!, { recursive: true });
        const store = new SQLiteControlPlaneStore(join(process.env.OPENSCOUT_CONTROL_HOME!, "control-plane.sqlite"));
        testCleanups.push(() => store.close());
        const historyDirectory = join(process.env.OPENSCOUT_CONTROL_HOME!, "history");
        const history = new ControlPlaneHistoryStore(historyDirectory);
        testCleanups.push(() => history.close());
        store.configureHistory(historyDirectory);
        store.upsertNode({ id: "node-1", meshId: "mesh-1", name: "Node", advertiseScope: "local", registeredAt: 1 });
        store.upsertActor({ id: "operator", kind: "human", displayName: "Operator" });
        store.upsertActor({ id: agentId, kind: "agent", displayName: "Darwin" });
        store.upsertConversation({ id: conversationId, kind: "direct", title: "Darwin", visibility: "private", shareMode: "local", authorityNodeId: "node-1", participantIds: ["operator", agentId] });
        store.recordInvocation(invocation);
        store.recordFlight(flight);
        const plan = emptyHistoryRotationPlan();
        plan.invocationIds.add(invocation.id);
        plan.flightIds.add(flight.id);
        const prepared = store.publishHistoryRotation(plan, history);
        const removed = store.removePublishedHistory(prepared.publication!, prepared.published, history);
        expect(removed.blocked).toEqual([]);
        expect(store.writerDb.query("SELECT flight_metadata_json FROM invocations WHERE id=?1").get(invocation.id)).toEqual({ flight_metadata_json: null });
        expect(store.loadSnapshot().invocations[invocation.id]).toBeUndefined();
        expect(store.loadSnapshot().flights[flight.id]).toBeUndefined();
        historicalStore = store;
      }
      if (scenario === "durable") {
        mkdirSync(process.env.OPENSCOUT_CONTROL_HOME!, { recursive: true });
        const seed = new Database(join(process.env.OPENSCOUT_CONTROL_HOME!, "control-plane.sqlite"), { create: true });
        seed.exec(`CREATE TABLE invocations (
          id TEXT PRIMARY KEY, requester_id TEXT, requester_node_id TEXT, target_agent_id TEXT,
          target_node_id TEXT, action TEXT, task TEXT, collaboration_record_id TEXT, conversation_id TEXT,
          message_id TEXT, context_json TEXT, execution_json TEXT, execution_resolution_json TEXT,
          ensure_awake INTEGER, stream INTEGER, timeout_ms INTEGER, labels_json TEXT, metadata_json TEXT,
          created_at INTEGER, flight_id TEXT, state TEXT, summary TEXT, output TEXT, error TEXT,
          started_at INTEGER, completed_at INTEGER, flight_metadata_json TEXT
        )`);
        seed.prepare(`INSERT INTO invocations
          (id, requester_id, requester_node_id, target_agent_id, action, task, conversation_id,
           created_at, flight_id, state, started_at, completed_at, flight_metadata_json)
          VALUES (?, 'operator', 'node-1', ?, 'consult', 'original', ?, 1000, ?, 'completed', 1000, 2000, ?)`)
          .run(invocation.id, agentId, conversationId, flight.id, JSON.stringify(flight.metadata));
        seed.close();
        (await import("../../db-queries.ts")).closeDb();
      }
      globalThis.fetch = (async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/health") {
          return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
        }
        if (request.method === "GET" && url.pathname === "/v1/node") return jsonResponse({ id: "node-1" });
        if (request.method === "GET" && url.pathname === "/v1/snapshot") {
          const endpoint = (id: string, state: string, sessionId: string) => ({
            id, agentId, nodeId: "node-1", harness: "codex", transport: "codex_app_server", state, sessionId,
          });
          return jsonResponse({
            actors: { operator: { id: "operator", kind: "person" } },
            agents: { [agentId]: { id: agentId, kind: "agent", displayName: "Project Darwin" } },
            endpoints: {
              launcher: endpoint("launcher", "waiting", "relay-darwin-codex"),
              ...(scenario === "missing" ? {} : {
                worker: endpoint("worker", scenario === "offline" ? "offline" : "idle", "session-this-chat"),
              }),
              other: endpoint("other", "active", "session-other-chat"),
            },
            conversations: { [conversationId]: {
              id: conversationId, kind: "direct", title: "Darwin", visibility: "private",
              authorityNodeId: "node-1", participantIds: ["operator", agentId],
            } },
            messages: {
              ...(scenario === "receipt" || scenario === "durable" || historicalStore ? {} : { reply: {
                id: "reply", conversationId, actorId: agentId, class: "agent", createdAt: 1000,
                body: "Done", metadata: { source: "broker", responderSessionId: "session-this-chat" },
              } }),
              other: {
                id: "other", conversationId: "another-chat", actorId: agentId, class: "agent", createdAt: 2000,
                body: "Other work", metadata: { source: "broker", responderSessionId: "session-other-chat" },
              },
              correction: {
                id: "correction", conversationId, actorId: "operator", class: "agent", createdAt: 3000,
                body: "Wrong project", metadata: { returnAddress: { sessionId: "operator-session" } },
              },
            },
            invocations: scenario === "receipt" ? { [invocation.id]: invocation } : {},
            flights: scenario === "receipt" ? { [flight.id]: flight } : {},
          });
        }
        if (request.method === "GET" && url.pathname === `/v1/invocations/${invocation.id}`) {
          historicalReads += 1;
          return unavailableHistory
            ? jsonResponse({ error: "invocation_storage_unavailable" }, 503)
            : jsonResponse(historicalStore!.readInvocationSnapshot(invocation.id));
        }
        if (request.method === "POST" && url.pathname === "/v1/messages") return jsonResponse({ ok: true });
        if (request.method === "POST" && url.pathname === "/v1/invocations") {
          const body = await request.json();
          invocations.push(body);
          return jsonResponse({ accepted: true, invocationId: body.id });
        }
        return jsonResponse({ error: "unexpected request" }, 404);
      }) as typeof fetch;

      const send = sendScoutConversationSteer({
        conversationId, senderId: "operator", body: "Continue this conversation", intent: "invoke",
        targetParticipantIds: [agentId], resolveMentionsFromBody: false, currentDirectory: home,
        ...(requestedExecution ? { execution: requestedExecution } : {}),
      });
      if (scenario === "unavailable" || scenario === "unavailable_preferences") {
        await expect(send).rejects.toThrow("Conversation session storage is unavailable.");
        expect(invocations).toHaveLength(0);
        expect(historicalReads).toBe(1);
        return;
      }
      await send;
      expect(invocations).toHaveLength(1);
      expect(invocations[0].execution).toEqual(scenario === "unavailable_new" || scenario === "unavailable_existing"
        ? requestedExecution
        : { session: "existing", targetSessionId: "session-this-chat", ...requestedExecution });
      expect(historicalReads).toBe(scenario.startsWith("relocated") ? 1 : 0);
    });
  }

  test("routes a conversation-local session by its visible runtime name", async () => {
    const home = useIsolatedOpenScoutHome();
    const requests: Array<{ method: string; path: string; body?: any }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : undefined;
      requests.push({ method: request.method, path: url.pathname, body });
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {
            operator: { id: "operator", kind: "person", displayName: "Operator" },
            "session-gauss": { id: "session-gauss", kind: "session", displayName: "openscout-gauss-4" },
          },
          agents: {},
          endpoints: {
            "endpoint-gauss": {
              id: "endpoint-gauss",
              agentId: "session-gauss",
              nodeId: "node-1",
              harness: "claude",
              transport: "tmux",
              state: "idle",
              sessionId: "session-gauss",
            },
          },
          conversations: {
            "chn-engineering": {
              id: "chn-engineering",
              kind: "channel",
              title: "engineering-ci",
              visibility: "workspace",
              shareMode: "local",
              authorityNodeId: "node-1",
              participantIds: ["operator", "session-gauss"],
            },
          },
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/invocations") {
        return jsonResponse({
          accepted: true,
          invocationId: body.id,
          flightId: "flight-gauss",
          targetAgentId: body.targetAgentId,
          state: "queued",
        });
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await sendScoutConversationSteer({
      conversationId: "chn-engineering",
      senderId: "operator",
      body: "@openscout-gauss-4 consolidate the feedback",
      intent: "invoke",
      currentDirectory: home,
      source: "scout-web",
    });

    expect(result).toMatchObject({
      usedBroker: true,
      invokedTargets: ["session-gauss"],
      unresolvedTargets: [],
    });
    expect(requests.find((request) => request.path === "/v1/messages")?.body)
      .toMatchObject({
        mentions: [expect.objectContaining({ actorId: "session-gauss" })],
        metadata: expect.objectContaining({ relayTargetIds: ["session-gauss"] }),
      });
    expect(requests.find((request) => request.path === "/v1/invocations")?.body)
      .toMatchObject({ targetAgentId: "session-gauss", action: "consult" });
  }, 15000);

  test("records one operator message and wakes every non-human participant in an agent-to-agent conversation", async () => {
    const home = useIsolatedOpenScoutHome();
    const requests: Array<{ method: string; path: string; body?: any }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : undefined;
      requests.push({ method: request.method, path: url.pathname, body });

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {
            operator: {
              id: "operator",
              kind: "person",
              displayName: "Operator",
            },
          },
          agents: {
            "hudson.main.mini": {
              id: "hudson.main.mini",
              kind: "agent",
              handle: "hudson",
              selector: "@hudson",
              displayName: "Hudson",
              metadata: { selector: "@hudson" },
            },
            "narrative-studio.main.mini": {
              id: "narrative-studio.main.mini",
              kind: "agent",
              handle: "narrative-studio",
              selector: "@narrative-studio",
              displayName: "Narrative Studio",
              metadata: { selector: "@narrative-studio" },
            },
          },
          endpoints: {
            "endpoint-hudson": {
              id: "endpoint-hudson",
              agentId: "hudson.main.mini",
              nodeId: "node-1",
              harness: "claude",
              transport: "tmux",
              state: "idle",
              sessionId: "relay-hudson-claude",
            },
            "endpoint-narrative": {
              id: "endpoint-narrative",
              agentId: "narrative-studio.main.mini",
              nodeId: "node-1",
              harness: "claude",
              transport: "claude_stream_json",
              state: "idle",
              sessionId: "relay-narrative-claude",
            },
          },
          conversations: {
            "c.hudson-narrative": {
              id: "c.hudson-narrative",
              kind: "direct",
              title: "Hudson <> Narrative Studio",
              visibility: "private",
              authorityNodeId: "node-1",
              participantIds: ["hudson.main.mini", "narrative-studio.main.mini"],
            },
          },
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/invocations") {
        return jsonResponse({
          accepted: true,
          invocationId: body.id,
          flightId: `flight-${body.targetAgentId}`,
          targetAgentId: body.targetAgentId,
          state: "queued",
          flight: {
            id: `flight-${body.targetAgentId}`,
            invocationId: body.id,
            requesterId: body.requesterId,
            targetAgentId: body.targetAgentId,
            state: "queued",
          },
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await sendScoutConversationSteer({
      conversationId: "c.hudson-narrative",
      senderId: "operator",
      body: "Who has next?",
      steerContextByTargetAgentId: {
        "hudson.main.mini": {
          runId: "run:flight:flt-hudson-active",
          flightId: "flt-hudson-active",
        },
      },
      currentDirectory: home,
      source: "scout-web",
    });

    expect(result).toMatchObject({
      usedBroker: true,
      conversationId: "c.hudson-narrative",
      invokedTargets: ["hudson.main.mini", "narrative-studio.main.mini"],
      unresolvedTargets: [],
    });
    const messagePost = requests.find((request) => request.path === "/v1/messages")?.body;
    expect(messagePost).toMatchObject({
      conversationId: "c.hudson-narrative",
      actorId: "operator",
      body: "Who has next?",
      audience: {
        notify: ["hudson.main.mini", "narrative-studio.main.mini"],
        reason: "direct_message",
      },
      metadata: {
        source: "scout-web",
        destinationKind: "conversation",
        destinationId: "c.hudson-narrative",
        intent: "steer",
        relayTargetIds: ["hudson.main.mini", "narrative-studio.main.mini"],
      },
    });

    const invocationPosts = requests
      .filter((request) => request.path === "/v1/invocations")
      .map((request) => request.body);
    expect(invocationPosts).toHaveLength(2);
    expect(invocationPosts).toEqual([
      expect.objectContaining({
        targetAgentId: "hudson.main.mini",
        action: "wake",
        conversationId: "c.hudson-narrative",
        messageId: messagePost.id,
        execution: {
          session: "existing",
          targetSessionId: "relay-hudson-claude",
        },
        metadata: expect.objectContaining({
          intent: "steer",
          relayTarget: "hudson.main.mini",
          relayMessageId: messagePost.id,
          parentRunId: "run:flight:flt-hudson-active",
          steeredFlightId: "flt-hudson-active",
        }),
      }),
      expect.objectContaining({
        targetAgentId: "narrative-studio.main.mini",
        action: "wake",
        conversationId: "c.hudson-narrative",
        messageId: messagePost.id,
        execution: {
          session: "existing",
          targetSessionId: "relay-narrative-claude",
        },
        metadata: expect.objectContaining({
          intent: "steer",
          relayTarget: "narrative-studio.main.mini",
          relayMessageId: messagePost.id,
        }),
      }),
    ]);

    requests.length = 0;
    const scopedResult = await sendScoutConversationSteer({
      conversationId: "c.hudson-narrative",
      senderId: "operator",
      body: "@Tesla take this one.",
      currentDirectory: home,
      source: "scout-web",
    });

    expect(scopedResult).toMatchObject({
      usedBroker: true,
      conversationId: "c.hudson-narrative",
      invokedTargets: ["hudson.main.mini"],
      unresolvedTargets: [],
    });
    expect(requests.find((request) => request.path === "/v1/messages")?.body)
      .toMatchObject({
        mentions: [{ actorId: "hudson.main.mini", label: "@Tesla" }],
        audience: {
          notify: ["hudson.main.mini"],
          reason: "direct_message",
        },
      });
    expect(requests.filter((request) => request.path === "/v1/invocations").map((request) => request.body.targetAgentId))
      .toEqual(["hudson.main.mini"]);

    requests.length = 0;
    const tellResult = await sendScoutConversationSteer({
      conversationId: "c.hudson-narrative",
      senderId: "operator",
      body: "Heads up for Hudson.",
      targetParticipantIds: ["hudson.main.mini"],
      intent: "tell",
      currentDirectory: home,
      source: "scout-web",
    });

    expect(tellResult).toMatchObject({
      usedBroker: true,
      conversationId: "c.hudson-narrative",
      invokedTargets: ["hudson.main.mini"],
      unresolvedTargets: [],
    });
    const tellMessagePost = requests.find((request) => request.path === "/v1/messages")?.body;
    expect(tellMessagePost).toMatchObject({
      metadata: expect.objectContaining({
        intent: "tell",
        relayTargetIds: ["hudson.main.mini"],
      }),
    });
    expect(requests.find((request) => request.path === "/v1/invocations")?.body)
      .toMatchObject({
        targetAgentId: "hudson.main.mini",
        labels: ["tell"],
        metadata: expect.objectContaining({
          intent: "tell",
          sourceIntent: "direct_message",
          relayMessageId: tellMessagePost.id,
        }),
      });

    requests.length = 0;
    const invokeResult = await sendScoutConversationSteer({
      conversationId: "c.hudson-narrative",
      senderId: "operator",
      body: "Review the current implementation.",
      targetParticipantIds: ["hudson.main.mini"],
      attentionMentions: [{ actorId: "operator", label: "Operator" }, { actorId: "narrative-studio.main.mini", label: "Narrative" }],
      intent: "invoke",
      execution: { harness: "claude", model: "opus-test" },
      currentDirectory: home,
      source: "scout-web",
    });

    expect(invokeResult).toMatchObject({
      usedBroker: true,
      conversationId: "c.hudson-narrative",
      invokedTargets: ["hudson.main.mini"],
    });
    const invokeMessagePost = requests.find((request) => request.path === "/v1/messages")?.body;
    expect(requests.filter(request => request.path === "/v1/invocations")).toHaveLength(1);
    expect(invokeMessagePost.audience.notify).toEqual(["hudson.main.mini"]);
    expect(invokeMessagePost.mentions.map((mention: any) => mention.actorId)).toEqual(["hudson.main.mini", "operator", "narrative-studio.main.mini"]);
    expect(invokeMessagePost).toMatchObject({
      conversationId: "c.hudson-narrative",
      metadata: expect.objectContaining({
        intent: "invoke",
      }),
    });
    expect(requests.find((request) => request.path === "/v1/invocations")?.body)
      .toMatchObject({
        targetAgentId: "hudson.main.mini",
        action: "consult",
        conversationId: "c.hudson-narrative",
        messageId: invokeMessagePost.id,
        execution: {
          session: "existing",
          targetSessionId: "relay-hudson-claude",
          harness: "claude",
          model: "opus-test",
        },
        labels: ["invoke"],
        metadata: expect.objectContaining({
          intent: "invoke",
          relayMessageId: invokeMessagePost.id,
        }),
      });

    requests.length = 0;
    await sendScoutConversationSteer({
      conversationId: "c.hudson-narrative",
      senderId: "operator",
      body: "",
      attachments: [{ id: "att-only", mediaType: "image/png", data: "aW1hZ2U=" }],
      targetParticipantIds: ["hudson.main.mini"],
      intent: "invoke",
      currentDirectory: home,
      source: "scout-web",
    });
    expect(requests.find((request) => request.path === "/v1/invocations")?.body)
      .toMatchObject({
        task: "Review the attached message.",
        conversationId: "c.hudson-narrative",
      });
  }, 15000);

  test("does not steer an offline cardless session participant", async () => {
    const home = useIsolatedOpenScoutHome();
    const requests: Array<{ method: string; path: string; body?: any }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : undefined;
      requests.push({ method: request.method, path: url.pathname, body });

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {
            operator: {
              id: "operator",
              kind: "person",
              displayName: "Operator",
            },
            "session-lattices": {
              id: "session-lattices",
              kind: "session",
              displayName: "lattices-schubert",
              handle: "project-schubert",
              metadata: {
                cardless: true,
                handle: "project-schubert",
                projectRoot: "/Users/art/dev/lattices",
              },
            },
          },
          agents: {},
          endpoints: {
            "endpoint-lattices": {
              id: "endpoint-lattices",
              agentId: "session-lattices",
              nodeId: "node-1",
              harness: "codex",
              transport: "codex_app_server",
              state: "offline",
              sessionId: "session-lattices",
              projectRoot: "/Users/art/dev/lattices",
              cwd: "/Users/art/dev/lattices",
              metadata: {
                cardless: true,
                handle: "project-schubert",
              },
            },
          },
          conversations: {
            "c.session-lattices": {
              id: "c.session-lattices",
              kind: "direct",
              title: "lattices-schubert",
              visibility: "private",
              authorityNodeId: "node-1",
              participantIds: ["operator", "session-lattices"],
            },
          },
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        return jsonResponse({ ok: true });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await sendScoutConversationSteer({
      conversationId: "c.session-lattices",
      senderId: "operator",
      body: "still there?",
      targetParticipantIds: ["session-lattices"],
      currentDirectory: home,
      source: "scout-web",
    });

    expect(result).toMatchObject({
      usedBroker: true,
      conversationId: "c.session-lattices",
      invokedTargets: [],
      unresolvedTargets: ["session-lattices"],
    });
    expect(requests.filter((request) => request.path === "/v1/invocations")).toHaveLength(0);
    expect(requests.find((request) => request.path === "/v1/messages")?.body)
      .toMatchObject({
        conversationId: "c.session-lattices",
        metadata: {
          intent: "steer",
          relayTargetIds: [],
        },
      });
  }, 15000);
});

describe("loadScoutMessages", () => {
  test("resolves channel aliases to opaque conversation ids", async () => {
    const home = useIsolatedOpenScoutHome();
    const requests: Array<{ method: string; path: string; search: string }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname, search: url.search });

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {
            "conv.11111111-1111-4111-8111-111111111111": {
              id: "conv.11111111-1111-4111-8111-111111111111",
              kind: "channel",
              title: "talkie-next",
              visibility: "workspace",
              authorityNodeId: "node-1",
              participantIds: ["operator"],
              metadata: {
                channel: "talkie-next",
                naturalKey: "channel:talkie-next",
              },
            },
          },
          messages: {},
          flights: {},
        });
      }
      if (request.method === "GET" && url.pathname === "/v1/messages") {
        return jsonResponse([]);
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const messages = await loadScoutMessages({
      channel: "talkie-next",
      baseUrl: "http://broker.test",
    });

    const messagesRequest = requests.find((request) => request.path === "/v1/messages");
    const params = new URLSearchParams(messagesRequest?.search ?? "");

    expect(messages).toEqual([]);
    expect(params.get("conversationId")).toBe("conv.11111111-1111-4111-8111-111111111111");
  }, 15000);
});

describe("openScoutPeerSession", () => {
  test("auto-registers a configured local agent and creates a direct conversation", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const talkieRoot = join(workspaceRoot, "talkie");

    mkdirSync(join(talkieRoot, ".git"), { recursive: true });
    writeFileSync(join(talkieRoot, "AGENTS.md"), "# talkie\n", "utf8");

    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [workspaceRoot],
        includeCurrentRepo: false,
      },
    });

    const requests: Array<{ method: string; path: string; body?: any }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : undefined;
      requests.push({ method: request.method, path: url.pathname, body });

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/agents") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/endpoints") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/conversations") {
        return jsonResponse({ ok: true });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await openScoutPeerSession({
      sourceId: "operator",
      targetId: "talkie",
      currentDirectory: talkieRoot,
      sourceName: "Operator",
    });

    expect(result.sourceId).toBe("operator");
    expect(result.targetId).toContain("talkie");
    expect(result.conversation.participantIds).toEqual(["operator", result.targetId]);
    expect(result.conversation.kind).toBe("direct");
    expect(result.existed).toBe(false);

    const actorPosts = requests.filter((request) => request.path === "/v1/actors");
    const agentPosts = requests.filter((request) => request.path === "/v1/agents");
    const endpointPosts = requests.filter((request) => request.path === "/v1/endpoints");
    const conversationPost = requests.find((request) => request.path === "/v1/conversations");

    expect(actorPosts.some((request) => request.body?.id === "operator")).toBe(true);
    expect(actorPosts.some((request) => request.body?.id === result.targetId)).toBe(true);
    expect(agentPosts.some((request) => request.body?.id === result.targetId)).toBe(true);
    expect(endpointPosts.some((request) => request.body?.agentId === result.targetId)).toBe(true);
    expect(conversationPost?.body).toEqual(expect.objectContaining({
      kind: "direct",
      participantIds: ["operator", result.targetId],
      visibility: "private",
    }));
  }, 15000);
});

describe("sendScoutDirectMessage", () => {
  test("gives attachment-only mobile consults a broker-valid task body", async () => {
    useIsolatedOpenScoutHome();
    const agentId = "project-woolf-15.main.node-1";
    const deliveredBodies: Record<string, unknown>[] = [];

    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() as Record<string, unknown> : null;

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {
            [agentId]: {
              id: agentId,
              kind: "agent",
              displayName: "Project Woolf 15",
            },
          },
          endpoints: {
            "endpoint-woolf": {
              id: "endpoint-woolf",
              agentId,
              nodeId: "node-1",
              harness: "claude",
              transport: "tmux",
              state: "idle",
            },
          },
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        if (body) deliveredBodies.push(body);
        return jsonResponse({
          kind: "delivery",
          accepted: true,
          routeKind: "dm",
          conversation: {
            id: "chn-woolf",
            kind: "direct",
            title: "Project Woolf 15",
            visibility: "private",
            shareMode: "local",
            authorityNodeId: "node-1",
            participantIds: ["operator", agentId],
          },
          message: {
            id: "msg-woolf",
            conversationId: "chn-woolf",
            actorId: "operator",
            originNodeId: "node-1",
            class: "agent",
            body: "Review the attached message.",
            visibility: "private",
            policy: "durable",
            createdAt: Date.now(),
          },
          targetAgentId: agentId,
        });
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    }) as unknown as typeof fetch;

    await sendScoutDirectMessage({
      agentId,
      body: "",
      attachments: [{
        id: "att-photo",
        mediaType: "image/jpeg",
        fileName: "Photo.jpg",
        url: "http://127.0.0.1:43132/files/att-photo",
      }],
      source: "scout-mobile",
      clientMessageId: "ios-stable-photo",
    });

    await sendScoutDirectMessage({
      agentId,
      body: "",
      attachments: [{
        id: "att-photo",
        mediaType: "image/jpeg",
        fileName: "Photo.jpg",
        url: "http://127.0.0.1:43132/files/att-photo",
      }],
      source: "scout-mobile",
      clientMessageId: "ios-stable-photo",
    });

    expect(deliveredBodies[0]).toMatchObject({
      body: "Review the attached message.",
      attachments: [{
        id: "att-photo",
        mediaType: "image/jpeg",
        fileName: "Photo.jpg",
        url: "http://127.0.0.1:43132/files/att-photo",
      }],
      intent: "consult",
    });
    expect(deliveredBodies[0]?.id).toBe(deliveredBodies[1]?.id);
    expect(deliveredBodies[0]?.id).toMatch(/^deliver-client-[a-f0-9]{32}$/);
  });

  test("asks the broker to route a cached superseded endpoint and exposes typed recovery", async () => {
    useIsolatedOpenScoutHome();
    const agentId = "stale-session.node-1";
    let deliveryRequests = 0;

    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: { [agentId]: { id: agentId, kind: "agent", displayName: "Stale session" } },
          endpoints: {
            "endpoint-stale": {
              id: "endpoint-stale",
              agentId,
              nodeId: "node-1",
              harness: "claude",
              transport: "tmux",
              state: "offline",
              metadata: { retiredFromFleet: true },
            },
          },
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        deliveryRequests += 1;
        return jsonResponse({
          kind: "question",
          accepted: false,
          question: { detail: "The exact session is no longer attachable." },
          remediation: {
            kind: "session_reference_not_attachable",
            detail: "Start a replacement session.",
          },
        }, 409);
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    }) as unknown as typeof fetch;

    await expect(sendScoutDirectMessage({
      agentId,
      body: "continue",
      clientMessageId: "ios-stale-session",
    })).rejects.toBeInstanceOf(ScoutDirectDeliveryUnavailableError);
    expect(deliveryRequests).toBe(1);
  });
});

describe("waitForScoutFlight", () => {
  test("reads the conversations-scoped snapshot and resolves a rotated terminal flight from SQLite", async () => {
    useIsolatedOpenScoutHome();
    // Seed the durable control-plane row directly — the broker's hot set has
    // already rotated this terminal flight out. closeDb() forces the readonly
    // handle to reopen against this test's isolated database.
    const dbPath = join(process.env.OPENSCOUT_CONTROL_HOME!, "control-plane.sqlite");
    mkdirSync(process.env.OPENSCOUT_CONTROL_HOME!, { recursive: true });
    const seed = new Database(dbPath, { create: true });
    seed.exec(`CREATE TABLE invocations (
      id TEXT PRIMARY KEY,
      requester_id TEXT NOT NULL,
      requester_node_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL,
      target_node_id TEXT,
      action TEXT NOT NULL,
      task TEXT NOT NULL,
      collaboration_record_id TEXT,
      conversation_id TEXT,
      message_id TEXT,
      context_json TEXT,
      execution_json TEXT,
      execution_resolution_json TEXT,
      ensure_awake INTEGER NOT NULL DEFAULT 1,
      stream INTEGER NOT NULL DEFAULT 1,
      timeout_ms INTEGER,
      labels_json TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      flight_id TEXT,
      state TEXT,
      summary TEXT,
      output TEXT,
      error TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      flight_metadata_json TEXT
    )`);
    seed.prepare(
      `INSERT INTO invocations (id, requester_id, requester_node_id, target_agent_id,
        action, task, ensure_awake, stream, created_at, flight_id, state, summary,
        started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "inv-rotated", "operator", "node-1", "worker-1",
      "run", "old work", 1, 0, 1_700_000_000_000, "flt-rotated", "completed",
      "finished long ago", 1_700_000_000_000, 1_700_000_100_000,
    );
    seed.close();
    const { closeDb } = await import("../../db-queries.ts");
    closeDb();

    const requestedPaths: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requestedPaths.push(`${url.pathname}${url.search}`);
      return jsonResponse({ flights: {} });
    }) as typeof fetch;

    try {
      const flight = await waitForScoutFlight("http://broker.test", "flt-rotated", {
        timeoutSeconds: 5,
      });
      expect(flight.state).toBe("completed");
      expect(flight.summary).toBe("finished long ago");
      expect(requestedPaths).toEqual(["/v1/snapshot?scope=conversations"]);
    } finally {
      closeDb();
    }
  });

  test("keeps polling the broker while the flight is non-terminal", async () => {
    useIsolatedOpenScoutHome();
    const requestedPaths: string[] = [];
    let polls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requestedPaths.push(`${url.pathname}${url.search}`);
      polls += 1;
      return jsonResponse({
        flights: {
          "flt-live": {
            id: "flt-live",
            invocationId: "inv-live",
            requesterId: "operator",
            targetAgentId: "worker-1",
            state: polls === 1 ? "running" : "completed",
            startedAt: 1_700_000_000_000,
          },
        },
      });
    }) as typeof fetch;

    const flight = await waitForScoutFlight("http://broker.test", "flt-live", {
      timeoutSeconds: 5,
    });
    expect(flight.state).toBe("completed");
    expect(polls).toBe(2);
    expect(requestedPaths.every((path) => path === "/v1/snapshot?scope=conversations")).toBe(true);
  });
});

describe("watchScoutMessages", () => {
  test("resolves a rotated invocation from SQLite for live flight lifecycle events", async () => {
    useIsolatedOpenScoutHome();
    // The invocation rotated out of the broker hot set but SQLite retains it;
    // the flight.updated event stream references it by invocationId.
    const dbPath = join(process.env.OPENSCOUT_CONTROL_HOME!, "control-plane.sqlite");
    mkdirSync(process.env.OPENSCOUT_CONTROL_HOME!, { recursive: true });
    const seed = new Database(dbPath, { create: true });
    seed.exec(`CREATE TABLE invocations (
      id TEXT PRIMARY KEY,
      requester_id TEXT NOT NULL,
      requester_node_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL,
      target_node_id TEXT,
      action TEXT NOT NULL,
      task TEXT NOT NULL,
      collaboration_record_id TEXT,
      conversation_id TEXT,
      message_id TEXT,
      context_json TEXT,
      execution_json TEXT,
      execution_resolution_json TEXT,
      ensure_awake INTEGER NOT NULL DEFAULT 1,
      stream INTEGER NOT NULL DEFAULT 1,
      timeout_ms INTEGER,
      labels_json TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      flight_id TEXT,
      state TEXT,
      summary TEXT,
      output TEXT,
      error TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      flight_metadata_json TEXT
    )`);
    seed.prepare(
      `INSERT INTO invocations (id, requester_id, requester_node_id, target_agent_id,
        action, task, ensure_awake, stream, created_at, conversation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "inv-rotated", "operator", "node-1", "worker-1",
      "run", "old work", 1, 0, 1_700_000_000_000, "chn-rotated",
    );
    seed.close();
    const { closeDb } = await import("../../db-queries.ts");
    closeDb();

    const encoder = new TextEncoder();
    const events = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({
            kind: "flight.updated",
            payload: {
              flight: {
                id: "flt-rotated",
                invocationId: "inv-rotated",
                requesterId: "operator",
                targetAgentId: "worker-1",
                state: "running",
                startedAt: 1_700_000_000_000,
              },
            },
          })}\n\n`,
        ));
        controller.close();
      },
    });

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (url.pathname === "/v1/snapshot") {
        // The rotated invocation is absent from every broker read.
        return jsonResponse({
          agents: {},
          actors: {},
          endpoints: {},
          conversations: {},
          messages: {},
          invocations: {},
          flights: {},
        });
      }
      if (url.pathname === "/v1/events/stream") {
        return new Response(events, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as unknown as typeof fetch;

    try {
      const lifecycles: Array<Record<string, unknown>> = [];
      await watchScoutMessages({
        conversationId: "chn-rotated",
        onMessage: () => undefined,
        onLifecycle: (record) => lifecycles.push({ ...record }),
      });
      expect(lifecycles).toEqual([
        expect.objectContaining({
          conversationId: "chn-rotated",
          invocationId: "inv-rotated",
          flightId: "flt-rotated",
          state: "working",
        }),
      ]);
    } finally {
      closeDb();
    }
  });
});


describe("Chat cancellation broker contract", () => {
  test("only an acknowledged terminal result changes the client state", async () => {
    let response: unknown = { error: { code: -32004 } };
    globalThis.fetch = (async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ method: "CancelTask", params: { id: "flight-chat" } });
      return Response.json(response);
    }) as typeof fetch;
    expect(await cancelScoutChatFlight("flight-chat", "http://broker.test")).toMatchObject({ ok: false, status: 409 });
    response = { result: { status: { state: "TASK_STATE_WORKING" } } };
    expect(await cancelScoutChatFlight("flight-chat", "http://broker.test")).toMatchObject({ ok: false, status: 502 });
    response = { result: { status: { state: "TASK_STATE_CANCELED" } } };
    expect(await cancelScoutChatFlight("flight-chat", "http://broker.test")).toEqual({ ok: true, state: "cancelled" });
  });
});

test("retained question history queries both terminal states with broker scope and cursor", async () => {
  const urls: URL[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url); urls.push(url);
    return jsonResponse([{ id: url.searchParams.get("state") }]);
  }) as typeof fetch;
  const result = await readScoutChatQuestionHistory("http://history.test", "room/a", { createdAt: 123, id: "q+2" });
  expect(result.map(row => row.id).sort()).toEqual(["closed", "declined"]);
  for (const url of urls) {
    expect(url.pathname).toBe("/v1/collaboration/records");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ conversationId: "room/a", kind: "question", includeThreads: "true", orderByCreatedAt: "true", afterCreatedAt: "123", afterId: "q+2", limit: "51" });
  }
});

describe("broker-owned live session replies", () => {
  function brokerWithCapability(supported = true, replacedByLegacyBeforePost = false) {
    const home = useIsolatedOpenScoutHome();
    let capabilities = supported ? ["session-input-receipts/1"] : [];
    const posts: ScoutDeliverRequest[] = [];
    let executions = 0;
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/health") return jsonResponse({ ok: true });
      if (path === "/v1/node") return jsonResponse({ id: "node-1", capabilities });
      if (path === "/v1/snapshot") return jsonResponse({ actors: { operator: { id: "operator", kind: "person", displayName: "Operator" } }, agents: {}, endpoints: {}, conversations: {}, messages: {}, flights: {} });
      if (path !== "/v1/deliver") throw new Error(`unexpected mutation: ${path}`);
      const command = await request.json() as ScoutDeliverRequest;
      posts.push(command);
      // The older broker only validates body+intent, passing unknown fields
      // through. Its enum must reject the command even after a fresh probe.
      if (replacedByLegacyBeforePost && !z.object({ body: z.string().min(1), intent: z.enum(["tell", "consult"]) }).passthrough().safeParse(command).success) {
        return jsonResponse({ error: "invalid intent" }, 400);
      }
      executions++;
      return jsonResponse({ kind: "delivery", accepted: true, routeKind: "dm", conversation: { id: "conversation" }, message: { id: "message" },
        targetSessionId: "native-session", receipt: { inputSubmitted: { kind: "in_place", state: "submitted", sessionId: "native-session", harness: "claude", via: "tmux", location: "%3" } } });
    }) as typeof fetch;
    const input: Parameters<typeof askScoutQuestion>[0] = { senderId: "operator", target: { kind: "session_id", sessionId: "native-session", harness: "claude" },
      body: "preserve these words", currentDirectory: home, clientMessageId: "retained-reply", sessionDelivery: "in_place_or_resume" };
    return { posts, input, executions: () => executions, downgrade: () => { capabilities = []; } };
  }

  test("requires broker support before submitting and does not trust stale cached capabilities", async () => {
    const unsupported = brokerWithCapability(false);
    await expect(askScoutQuestion(unsupported.input)).rejects.toThrow("session_input_unsupported");
    expect(unsupported.posts).toHaveLength(0);
    const broker = brokerWithCapability();
    await loadScoutBrokerContext();
    broker.downgrade();
    await expect(askScoutQuestion(broker.input)).rejects.toThrow("session_input_unsupported");
    expect(broker.posts).toHaveLength(0);
  });

  test("passes exact body bytes and stable identity through canonical deliver, exposing submission without a flight", async () => {
    const broker = brokerWithCapability();
    const first = await askScoutQuestion(broker.input);
    Date.now = () => 9_999_999_999_999;
    const second = await askScoutQuestion(broker.input);
    expect(broker.posts).toHaveLength(2);
    expect(broker.posts[0]).toEqual(broker.posts[1]);
    expect(broker.posts[0]).toMatchObject({ intent: "session_input", sessionDelivery: "in_place_or_resume", body: "preserve these words", requestId: expect.stringContaining("deliver-client-"), execution: { session: "existing" } });
    expect(broker.posts[0]!.createdAt).toBeUndefined();
    expect(first).toEqual(second);
    expect(first.inputSubmitted).toMatchObject({ state: "submitted", sessionId: "native-session" });
    expect(first.flight).toBeUndefined();
  });

  test("an older broker replacing the advertised one rejects the wire intent before execution", async () => {
    const broker = brokerWithCapability(true, true);
    await expect(askScoutQuestion(broker.input)).rejects.toThrow("invalid intent");
    expect(broker.posts).toHaveLength(1);
    expect(broker.executions()).toBe(0);
  });

  test("missing client identity cannot fall back to a random request", async () => {
    const broker = brokerWithCapability();
    await expect(askScoutQuestion({ ...broker.input, clientMessageId: undefined })).rejects.toThrow("request_id_required");
    expect(broker.posts).toHaveLength(0);
  });
});

describe("web delivery request receipts", () => {
  function receiptBroker() {
    const home = useIsolatedOpenScoutHome();
    // Exercise the real durable receipt ledger against the payload emitted by
    // the web service. Only HTTP and the downstream execution are simulated.
    const directory = join(home, "receipts");
    let ledger = new BrokerRequestReceipts(directory);
    let executions = 0;
    let loseNextResponse = false;
    const commands: ScoutDeliverRequest[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/health") return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      if (path === "/v1/node") return jsonResponse({ id: "node-1" });
      if (path === "/v1/snapshot") return jsonResponse({
        actors: { operator: { id: "operator", kind: "person", displayName: "Operator" } },
        agents: { kepler: { id: "kepler", kind: "agent", handle: "kepler", displayName: "Kepler", authorityNodeId: "node-1", state: "idle" } },
        endpoints: {}, conversations: {}, messages: {}, flights: {},
      });
      if (path !== "/v1/deliver") throw new Error(`unexpected receipt test request: ${path}`);
      const command = await request.json() as ScoutDeliverRequest;
      commands.push(command);
      const execute = async () => {
        executions++;
        return {
          kind: "delivery", accepted: true, routeKind: "dm", targetAgentId: "kepler",
          conversation: { id: "conversation", kind: "direct", participantIds: [command.requesterId, "kepler"] },
          message: { id: `message-${executions}`, body: command.body },
          flight: { id: `flight-${executions}`, invocationId: `invocation-${executions}`, state: "queued" },
        };
      };
      let result: unknown;
      try {
        result = command.requestId
          ? await ledger.run(command.requesterId!, command.requestId, "deliver", command, execute)
          : await execute();
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
      if (loseNextResponse) {
        loseNextResponse = false;
        throw new Error("response lost after durable acceptance");
      }
      return jsonResponse(result, 202);
    }) as typeof fetch;
    return {
      home, directory, commands,
      executions: () => executions,
      restart: () => { ledger = new BrokerRequestReceipts(directory); },
      loseResponse: () => { loseNextResponse = true; },
    };
  }

  const attachment = { mediaType: "image/png", fileName: "evidence.png", blobKey: "blob-original" };
  const routes = {
    direct: (home: string, key?: string) => sendScoutDirectMessage({ agentId: "kepler", body: "Inspect this", attachments: [attachment], clientMessageId: key, currentDirectory: home }),
    ask: (home: string, key?: string) => askScoutQuestion({ senderId: "operator", targetAgentId: "kepler", body: "Inspect this", attachments: [attachment], clientMessageId: key, currentDirectory: home }),
    explicitMessage: (home: string, key?: string) => sendScoutMessage({ senderId: "operator", explicitTargetAgentIds: ["kepler"], body: "Inspect this", attachments: [attachment], clientMessageId: key, currentDirectory: home }),
    selectedMessage: (home: string, key?: string) => sendScoutMessage({ senderId: "operator", body: "@kepler Inspect this", attachments: [attachment], clientMessageId: key, currentDirectory: home }),
  };

  for (const [name, send] of Object.entries(routes)) {
    test(`${name} shares one receipt across concurrent retries, restart, and clock changes`, async () => {
      const broker = receiptBroker();
      let now = 100_000;
      Date.now = () => now;
      const first = await Promise.all([send(broker.home, "retained-client-key"), send(broker.home, "retained-client-key")]);
      expect(broker.executions()).toBe(1);
      expect(first[0]).toEqual(first[1]);
      broker.restart();
      now += 60_000;
      expect(await send(broker.home, "retained-client-key")).toEqual(first[0]);
      expect(broker.executions()).toBe(1);
      expect(broker.commands).toHaveLength(3);
      expect(broker.commands[0]?.requestId).toMatch(/^deliver-client-/);
      expect(broker.commands.every(command => command.createdAt === undefined)).toBe(true);
      expect(broker.commands[0]?.attachments?.[0]?.id).toMatch(/^att-client-/);
      expect(broker.commands[1]).toEqual(broker.commands[0]);
      expect(broker.commands[2]).toEqual(broker.commands[0]);
    });

    test(`${name} does not reserve a receipt for an unkeyed send`, async () => {
      const broker = receiptBroker();
      await send(broker.home);
      await send(broker.home);
      expect(broker.executions()).toBe(2);
      expect(broker.commands.every(command => command.requestId === undefined && typeof command.createdAt === "number")).toBe(true);
      expect(existsSync(broker.directory)).toBe(false);
    });
  }

  test("a lost response replays the accepted result after restart without another execution", async () => {
    const broker = receiptBroker();
    broker.loseResponse();
    await expect(routes.direct(broker.home, "lost-response")).rejects.toThrow("response lost");
    expect(broker.executions()).toBe(1);
    broker.restart();
    expect(await routes.direct(broker.home, "lost-response")).toMatchObject({ messageId: "message-1", flight: { id: "flight-1" } });
    expect(broker.executions()).toBe(1);
  });

  test("same-key body, target, attachment, and execution changes remain conflicts", async () => {
    const broker = receiptBroker();
    const input = { agentId: "kepler", body: "Inspect this", attachments: [attachment], clientMessageId: "semantic-key" };
    await sendScoutDirectMessage(input);
    for (const change of [
      { body: "Do something else" },
      { agentId: "another-agent" },
      { attachments: [{ ...attachment, blobKey: "different-content" }] },
      { executionModel: "different-model" },
    ]) {
      await expect(sendScoutDirectMessage({ ...input, ...change })).rejects.toThrow("different content");
    }
    expect(broker.executions()).toBe(1);
  });

  test("retained caller timestamps and explicit attachment IDs survive keyed asks", async () => {
    const broker = receiptBroker();
    const input = { senderId: "operator", targetAgentId: "kepler", body: "Inspect this", clientMessageId: "retained-fields", createdAtMs: 12_345,
      attachments: [{ ...attachment, id: "uploaded-attachment" }], currentDirectory: broker.home };
    await askScoutQuestion(input);
    broker.restart();
    await askScoutQuestion(input);
    expect(broker.commands[0]).toMatchObject({ createdAt: 12_345, attachments: [{ id: "uploaded-attachment" }] });
    expect(broker.executions()).toBe(1);
    await expect(askScoutQuestion({ ...input, createdAtMs: 12_346 })).rejects.toThrow("different content");
    expect(broker.executions()).toBe(1);
  });
});
