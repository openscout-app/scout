import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeSseFrame } from "./broker-control-stream-service.js";
import { registerAsyncMessageRecordView } from "./broker-message-records.js";

import type {
  AgentDefinition,
  DeliveryIntent,
  FlightRecord,
  InvocationRequest,
  NodeDefinition,
} from "@openscout/protocol";

import {
  createPeerDeliveryWorker,
  type PeerDeliveryDeps,
} from "./peer-delivery.js";
import type { MeshForwardTarget } from "./mesh-forwarding.js";
import {
  PeerRejectedError,
  PeerUnreachableError,
} from "./mesh-forwarding.js";
import type { RuntimeRegistrySnapshot } from "./registry.js";

/* ── Fixtures ── */

function makeNode(id: string, brokerUrl?: string): NodeDefinition {
  return {
    id,
    meshId: "test-mesh",
    name: id,
    advertiseScope: "mesh",
    brokerUrl,
    capabilities: ["broker"],
    registeredAt: 0,
    lastSeenAt: 0,
  };
}

function makeAgent(id: string, authorityNodeId: string): AgentDefinition {
  return {
    id,
    kind: "agent",
    displayName: id,
    handle: id,
    homeNodeId: authorityNodeId,
    authorityNodeId,
    advertiseScope: "mesh",
    state: "idle",
    workspace: "main",
    registeredAt: 0,
    updatedAt: 0,
  };
}

function makeInvocation(id: string, targetAgentId: string): InvocationRequest {
  return {
    id,
    requesterId: "actor-arach",
    targetAgentId,
    action: "invoke",
    task: "hello",
    createdAt: 0,
  };
}

function emptySnapshot(): RuntimeRegistrySnapshot {
  return {
    nodes: {},
    actors: {},
    agents: {},
    endpoints: {},
    conversations: {},
    bindings: {},
    messages: {},
    flights: {},
    collaborationRecords: {},
  };
}

/* ── Test harness ── */

interface Harness {
  deps: PeerDeliveryDeps;
  deliveries: Map<string, DeliveryIntent>;
  attempts: Map<string, Array<{ attempt: number; status: string; metadata?: Record<string, unknown> }>>;
  flights: FlightRecord[];
  failedInvocations: Array<{ invocation: InvocationRequest; detail: string }>;
  setNow: (ms: number) => void;
  setForward: (
    impl: (target: MeshForwardTarget) => Promise<{ ok: true; flight: FlightRecord; duplicate?: boolean }>,
  ) => void;
  setNode: (node: NodeDefinition | undefined) => void;
  setInvocation: (invocation: InvocationRequest | undefined) => void;
}

function makeHarness(opts: {
  invocation?: InvocationRequest;
  agent?: AgentDefinition;
  peer?: NodeDefinition;
} = {}): Harness {
  const deliveries = new Map<string, DeliveryIntent>();
  const attempts = new Map<
    string,
    Array<{ attempt: number; status: string; metadata?: Record<string, unknown> }>
  >();
  const flights: FlightRecord[] = [];
  const failedInvocations: Array<{ invocation: InvocationRequest; detail: string }> = [];

  let currentTime = 0;
  let invocation = opts.invocation;
  let peer = opts.peer;
  let forwardImpl:
    | ((target: MeshForwardTarget) => Promise<{ ok: true; flight: FlightRecord; duplicate?: boolean }>)
    | undefined;

  const localNode = makeNode("origin", "http://127.0.0.1:65501");

  const deps: PeerDeliveryDeps = {
    journal: {
      getDelivery: (id) => deliveries.get(id),
      findDelivery: (predicate) => [...deliveries.values()].find(predicate),
      listPendingPeerForwardDeliveries: (options = {}) => [...deliveries.values()]
        .filter((delivery) => delivery.transport === "peer_broker" && (delivery.status === "accepted" || delivery.status === "deferred"))
        .slice(0, options.limit ?? 500),
      listPendingPeerMirrorDeliveries: (options = {}) => [...deliveries.values()]
        .filter((delivery) => delivery.transport === "peer_broker" && delivery.status === "peer_acked")
        .slice(0, options.limit ?? 500),
      listDeliveryAttempts: (deliveryId) =>
        (attempts.get(deliveryId) ?? []).map((a, idx) => ({
          id: `att-${deliveryId}-${idx}`,
          deliveryId,
          attempt: a.attempt,
          status: a.status as "sent" | "acknowledged" | "failed",
          createdAt: 0,
          metadata: a.metadata,
        })),
    },
    snapshot: emptySnapshot,
    localNode: () => localNode,
    localNodeId: localNode.id,
    nodeFor: (id) => (peer && peer.id === id ? peer : undefined),
    agentFor: () => opts.agent,
    invocationFor: (id) => (invocation && invocation.id === id ? invocation : undefined),
    flightForInvocation: (id) => flights.findLast((flight) => flight.invocationId === id),
    peerFetch: async () => new Response(null, { status: 204 }),
    recordDelivery: async (delivery) => {
      deliveries.set(delivery.id, delivery);
    },
    updateDeliveryStatus: async ({ deliveryId, status, metadata, leaseOwner, leaseExpiresAt }) => {
      const current = deliveries.get(deliveryId);
      if (!current) return;
      deliveries.set(deliveryId, {
        ...current,
        status,
        metadata: { ...(current.metadata ?? {}), ...(metadata ?? {}) },
        leaseOwner: leaseOwner ?? undefined,
        leaseExpiresAt: leaseExpiresAt ?? undefined,
      });
    },
    recordDeliveryAttempt: async (attempt) => {
      const list = attempts.get(attempt.deliveryId) ?? [];
      list.push({ attempt: attempt.attempt, status: attempt.status, metadata: attempt.metadata });
      attempts.set(attempt.deliveryId, list);
    },
    recordFlight: async (flight, eligible) => {
      if (eligible && !eligible()) return;
      flights.push(flight);
    },
    failInvocation: async (inv, detail) => {
      failedInvocations.push({ invocation: inv, detail });
    },
    forward: async (brokerUrl) => {
      if (!forwardImpl) throw new Error("forward impl not configured");
      return forwardImpl(brokerUrl);
    },
    now: () => currentTime,
  };

  return {
    deps,
    deliveries,
    attempts,
    flights,
    failedInvocations,
    setNow: (ms) => { currentTime = ms; },
    setForward: (impl) => { forwardImpl = impl; },
    setNode: (node) => { peer = node; },
    setInvocation: (inv) => { invocation = inv; },
  };
}

function targetErrorUrl(target: MeshForwardTarget): string {
  return typeof target === "string"
    ? target
    : target.brokerUrl ?? `mesh:${target.id}`;
}

/* ── Tests ── */

describe("peer-delivery outbox worker", () => {
  test("forwards past 500 historical and not-yet-due peer deliveries", async () => {
    const invocation = makeInvocation("fresh-inv", "remote-session");
    const peer = makeNode("peer", "https://mini.tailnet.test.:43110");
    const h = makeHarness({ invocation, peer });
    h.setForward(async () => ({ ok: true, flight: {
      id: "remote-flight", invocationId: invocation.id, requesterId: invocation.requesterId,
      targetAgentId: invocation.targetAgentId, state: "running",
    } }));
    for (let i = 0; i < 600; i++) {
      h.deliveries.set(`old-${i}`, {
        id: `old-${i}`, targetId: "old", targetKind: "agent", transport: "peer_broker",
        reason: "invocation", policy: "must_ack", status: i % 2 ? "peer_acked" : "deferred",
        metadata: { nextAttemptAt: 100000 },
      });
    }
    const worker = createPeerDeliveryWorker(h.deps);
    const delivery = await worker.enqueue(invocation, peer);
    await worker.tick();
    expect(h.deliveries.get(delivery.id)?.status).toBe("peer_acked");
    expect(h.attempts.get(delivery.id)).toHaveLength(1);
    worker.stop();
  });

  test("a large eligible backlog is drained with bounded forwarding concurrency", async () => {
    const invocation = makeInvocation("batch", "remote-session");
    const peer = makeNode("peer", "http://peer:43110");
    const h = makeHarness({ invocation, peer });
    h.deps.invocationFor = id => ({ ...invocation, id });
    let active = 0, peak = 0, sent = 0;
    h.deps.forward = async (_target, bundle) => {
      active++; peak = Math.max(peak, active);
      await Bun.sleep(1);
      active--; sent++;
      return { ok: true, flight: { id: `flight-${bundle.invocation.id}`,
        invocationId: bundle.invocation.id, requesterId: invocation.requesterId,
        targetAgentId: invocation.targetAgentId, state: "running" } };
    };
    for (let i = 0; i < 40; i++) h.deliveries.set(`batch-${i}`, {
      id: `batch-${i}`, invocationId: `batch-inv-${i}`, targetId: invocation.targetAgentId,
      targetNodeId: peer.id, targetKind: "agent", transport: "peer_broker", reason: "invocation",
      policy: "must_ack", status: "accepted",
    });
    const worker = createPeerDeliveryWorker(h.deps);
    await worker.tick();
    expect(sent).toBe(40);
    expect(peak).toBeLessThanOrEqual(16);
    expect([...h.deliveries.values()].every(d => d.status === "peer_acked")).toBe(true);
    worker.stop();
  });

  test("recovery reuses the peer outbox identity without resetting its retry budget", async () => {
    const invocation = makeInvocation("retry-inv", "remote-session");
    const peer = makeNode("peer", "http://peer:43110");
    const h = makeHarness({ invocation, peer });
    h.setForward(async () => { throw new PeerUnreachableError("offline"); });
    const worker = createPeerDeliveryWorker(h.deps);
    const delivery = await worker.enqueue(invocation, peer);
    await worker.tick();
    h.setNow(100);
    const recovered = await worker.enqueue(invocation, peer);
    await worker.tick();
    expect(recovered.id).toBe(delivery.id);
    expect(h.deliveries.size).toBe(1);
    expect(h.attempts.get(delivery.id)).toHaveLength(1);
    expect(h.deliveries.get(delivery.id)?.metadata?.firstAttemptQueuedAt).toBe(0);
    worker.stop();
  });

  test("concurrent recovery enqueues share one durable peer receipt", async () => {
    const invocation = makeInvocation("concurrent-inv", "remote-session");
    const peer = makeNode("peer", "http://peer:43110");
    const h = makeHarness({ invocation, peer });
    const write = h.deps.recordDelivery;
    h.deps.recordDelivery = async (delivery) => { await Bun.sleep(1); await write(delivery); };
    const worker = createPeerDeliveryWorker(h.deps);
    const [a, b] = await Promise.all([worker.enqueue(invocation, peer), worker.enqueue(invocation, peer)]);
    await worker.tick();
    expect(a.id).toBe(b.id);
    expect(h.deliveries.size).toBe(1);
    worker.stop();
  });

  test("cancelled flights never forward their pending peer deliveries", async () => {
    const invocation = makeInvocation("cancelled-inv", "remote-session");
    const peer = makeNode("peer", "http://peer:43110");
    const h = makeHarness({ invocation, peer });
    h.flights.push({ id: "closed", invocationId: invocation.id, requesterId: invocation.requesterId,
      targetAgentId: invocation.targetAgentId, state: "cancelled" });
    const worker = createPeerDeliveryWorker(h.deps);
    const delivery = await worker.enqueue(invocation, peer);
    await worker.tick();
    expect(h.deliveries.get(delivery.id)?.status).toBe("cancelled");
    expect(h.attempts.size).toBe(0);
    worker.stop();
  });

  test("legacy duplicate receipts are retired without another peer send", async () => {
    const invocation = makeInvocation("legacy-inv", "remote-session");
    const peer = makeNode("peer", "http://peer:43110");
    const h = makeHarness({ invocation, peer });
    const canonical: DeliveryIntent = { id: "original", invocationId: invocation.id,
      targetId: invocation.targetAgentId, targetNodeId: peer.id, targetKind: "agent",
      transport: "peer_broker", reason: "invocation", policy: "must_ack", status: "peer_acked" };
    h.deliveries.set(canonical.id, canonical);
    h.deliveries.set("duplicate", { ...canonical, id: "duplicate", status: "accepted" });
    const worker = createPeerDeliveryWorker(h.deps);
    await worker.tick();
    expect(h.deliveries.get("duplicate")?.status).toBe("cancelled");
    expect(h.deliveries.get("duplicate")?.metadata?.supersededPeerDeliveryId).toBe("original");
    expect(h.attempts.size).toBe(0);
    worker.stop();
  });

  test("on success, marks delivery peer_acked and records the returned flight", async () => {
    const invocation = makeInvocation("inv-1", "scout.main.mini");
    const agent = makeAgent("scout.main.mini", "mini-node");
    const peer = makeNode("mini-node", "http://10.0.0.2:65501");
    const harness = makeHarness({ invocation, agent, peer });

    const flight: FlightRecord = {
      id: "flt-peer-1",
      invocationId: "inv-1",
      requesterId: "actor-arach",
      targetAgentId: "scout.main.mini",
      state: "waking",
      startedAt: 100,
    };
    harness.setForward(async () => ({ ok: true, flight }));

    const worker = createPeerDeliveryWorker(harness.deps, { tickIntervalMs: 999_999 });
    const delivery = await worker.enqueue(invocation, peer);
    await worker.tick();

    const stored = harness.deliveries.get(delivery.id);
    expect(stored?.status).toBe("peer_acked");
    expect(stored?.metadata?.peerFlightId).toBe("flt-peer-1");
    expect(harness.flights).toHaveLength(1);
    expect(harness.flights[0]?.id).toBe("flt-peer-1");

    const attempts = harness.attempts.get(delivery.id);
    expect(attempts).toHaveLength(1);
    expect(attempts?.[0]?.status).toBe("acknowledged");
    expect(harness.failedInvocations).toHaveLength(0);
  });

  test("on PeerUnreachableError, defers with backoff and stays retry-able", async () => {
    const invocation = makeInvocation("inv-2", "scout.main.mini");
    const peer = makeNode("mini-node", "http://10.0.0.2:65501");
    const harness = makeHarness({ invocation, peer });

    harness.setForward(async (target) => {
      throw new PeerUnreachableError("ECONNREFUSED", targetErrorUrl(target));
    });

    const worker = createPeerDeliveryWorker(harness.deps, { tickIntervalMs: 999_999 });
    const delivery = await worker.enqueue(invocation, peer);
    harness.setNow(1_000);
    await worker.tick();

    const stored = harness.deliveries.get(delivery.id);
    expect(stored?.status).toBe("deferred");
    expect(stored?.metadata?.failureReason).toBe("peer_unreachable");
    expect(typeof stored?.metadata?.nextAttemptAt).toBe("number");
    expect((stored?.metadata?.nextAttemptAt as number) > 1_000).toBe(true);
    expect(harness.failedInvocations).toHaveLength(0); // not terminal
  });

  test("on PeerRejectedError 4xx, fails terminally without retry", async () => {
    const invocation = makeInvocation("inv-3", "scout.main.mini");
    const peer = makeNode("mini-node", "http://10.0.0.2:65501");
    const harness = makeHarness({ invocation, peer });

    harness.setForward(async (target) => {
      throw new PeerRejectedError("bad request", targetErrorUrl(target), 400, "Bad Request", "{\"error\":\"unknown_node\"}");
    });

    const worker = createPeerDeliveryWorker(harness.deps, { tickIntervalMs: 999_999 });
    const delivery = await worker.enqueue(invocation, peer);
    await worker.tick();

    const stored = harness.deliveries.get(delivery.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.metadata?.failureReason).toBe("peer_rejected");
    expect(harness.failedInvocations).toHaveLength(1);
    expect(harness.failedInvocations[0]?.detail).toContain("rejected");
  });

  test("on PeerRejectedError 5xx, defers (treated like unreachable)", async () => {
    const invocation = makeInvocation("inv-4", "scout.main.mini");
    const peer = makeNode("mini-node", "http://10.0.0.2:65501");
    const harness = makeHarness({ invocation, peer });

    harness.setForward(async (target) => {
      throw new PeerRejectedError("internal error", targetErrorUrl(target), 503, "Service Unavailable");
    });

    const worker = createPeerDeliveryWorker(harness.deps, { tickIntervalMs: 999_999 });
    const delivery = await worker.enqueue(invocation, peer);
    await worker.tick();

    const stored = harness.deliveries.get(delivery.id);
    expect(stored?.status).toBe("deferred");
    expect(stored?.metadata?.failureReason).toBe("peer_unreachable");
    expect(harness.failedInvocations).toHaveLength(0);
  });

  test("after the retry window expires, retains unknown submission without failing the invocation", async () => {
    const invocation = makeInvocation("inv-5", "scout.main.mini");
    const peer = makeNode("mini-node", "http://10.0.0.2:65501");
    const harness = makeHarness({ invocation, peer });

    harness.setForward(async (target) => {
      throw new PeerUnreachableError("still down", targetErrorUrl(target));
    });

    const worker = createPeerDeliveryWorker(harness.deps, {
      tickIntervalMs: 999_999,
      retryWindowMs: 10_000,
    });
    harness.setNow(0);
    const delivery = await worker.enqueue(invocation, peer);

    // First attempt at t=1s → defers.
    harness.setNow(1_000);
    await worker.tick();
    expect(harness.deliveries.get(delivery.id)?.status).toBe("deferred");

    // Second attempt past the retry window stops forwarding, not remote work.
    harness.setNow(20_000);
    // Force the deferred entry to become eligible.
    const cur = harness.deliveries.get(delivery.id)!;
    harness.deliveries.set(delivery.id, {
      ...cur,
      metadata: { ...(cur.metadata ?? {}), nextAttemptAt: 19_000 },
    });
    await worker.tick();

    const stored = harness.deliveries.get(delivery.id);
    expect(stored?.status).toBe("sent");
    expect(stored?.metadata?.peerSubmission).toMatchObject({ status: "unknown", reason: "retry_window_expired" });
    expect(harness.failedInvocations).toHaveLength(0);
    const attempts = harness.attempts.get(delivery.id)?.length;
    harness.setNow(100_000);
    worker.notifyPeerOnline(peer.id);
    await worker.tick();
    expect(harness.attempts.get(delivery.id)).toHaveLength(attempts!);
    worker.stop();
  });

  test("deferred entries are skipped before nextAttemptAt", async () => {
    const invocation = makeInvocation("inv-6", "scout.main.mini");
    const peer = makeNode("mini-node", "http://10.0.0.2:65501");
    const harness = makeHarness({ invocation, peer });

    let calls = 0;
    harness.setForward(async (target) => {
      calls += 1;
      throw new PeerUnreachableError("down", targetErrorUrl(target));
    });

    const worker = createPeerDeliveryWorker(harness.deps, { tickIntervalMs: 999_999 });
    harness.setNow(0);
    await worker.enqueue(invocation, peer);
    harness.setNow(100);
    await worker.tick();
    expect(calls).toBe(1);

    // Tick again before the next attempt window — should be a no-op.
    harness.setNow(200);
    await worker.tick();
    expect(calls).toBe(1);
  });

  test("missing peer URL defers without burning the retry budget", async () => {
    const invocation = makeInvocation("inv-7", "scout.main.mini");
    const peer = makeNode("mini-node"); // no brokerUrl
    const harness = makeHarness({ invocation, peer });

    harness.setForward(async () => {
      throw new Error("forward should not be called when peer URL is unknown");
    });

    const worker = createPeerDeliveryWorker(harness.deps, { tickIntervalMs: 999_999 });
    const delivery = await worker.enqueue(invocation, peer);

    // enqueue() captures peerBrokerUrl in metadata — strip it to simulate
    // the case where neither the registry nor the cached metadata have a URL.
    const stripped = harness.deliveries.get(delivery.id)!;
    harness.deliveries.set(delivery.id, {
      ...stripped,
      metadata: { ...(stripped.metadata ?? {}), peerBrokerUrl: undefined },
    });
    harness.setNode(makeNode("mini-node")); // still no URL

    await worker.tick();
    const stored = harness.deliveries.get(delivery.id);
    expect(stored?.status).toBe("deferred");
    expect(stored?.metadata?.failureReason).toBe("peer_unreachable");
  });

  test("notifyPeerOnline flushes deferred deliveries for that peer", async () => {
    const invocation = makeInvocation("inv-8", "scout.main.mini");
    const peer = makeNode("mini-node", "http://10.0.0.2:65501");
    const harness = makeHarness({ invocation, peer });

    let online = false;
    harness.setForward(async (target) => {
      if (!online) throw new PeerUnreachableError("down", targetErrorUrl(target));
      return { ok: true, flight: {
        id: "flt-online",
        invocationId: invocation.id,
        requesterId: invocation.requesterId,
        targetAgentId: invocation.targetAgentId,
        state: "waking",
        startedAt: 0,
      } };
    });

    const worker = createPeerDeliveryWorker(harness.deps, { tickIntervalMs: 999_999 });
    const delivery = await worker.enqueue(invocation, peer);
    await worker.tick();
    expect(harness.deliveries.get(delivery.id)?.status).toBe("deferred");

    online = true;
    worker.notifyPeerOnline("mini-node");
    // notifyPeerOnline is fire-and-forget — give it a tick to settle.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(harness.deliveries.get(delivery.id)?.status).toBe("peer_acked");
  });

  test("status mirror requests the remote-tier stream path, then the legacy path on 404", async () => {
    const invocation = makeInvocation("inv-mirror", "scout.main.mini");
    const agent = makeAgent("scout.main.mini", "mini-node");
    const peer = makeNode("mini-node", "http://10.0.0.2:65501");
    const harness = makeHarness({ invocation, agent, peer });

    const paths: string[] = [];
    // ensureStatusMirror is a no-op unless emit is wired, which is why the rest
    // of this file never exercises the stream path.
    harness.deps.emit = () => {};
    harness.deps.peerFetch = async (_baseUrl, path) => {
      paths.push(path);
      // 404 the first call so the pre-trust-cone fallback is exercised too.
      return new Response(null, { status: paths.length === 1 ? 404 : 204 });
    };

    harness.setForward(async () => ({
      ok: true as const,
      flight: {
        id: "flt-mirror",
        invocationId: invocation.id,
        requesterId: invocation.requesterId,
        targetAgentId: invocation.targetAgentId,
        state: "waking",
        startedAt: 0,
      },
    }));

    const worker = createPeerDeliveryWorker(harness.deps, { tickIntervalMs: 999_999 });
    await worker.enqueue(invocation, peer);
    await worker.tick();
    // The mirror is started in a floating async IIFE — let it reach both fetches.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(paths[0]).toBe("/v1/mesh/invocations/inv-mirror/stream");
    expect(paths[1]).toBe("/v1/invocations/inv-mirror/stream");
  });
});

function recoveredDelivery(invocation: InvocationRequest, peer: NodeDefinition): DeliveryIntent {
  return {
    id: `delivery-${invocation.id}`, invocationId: invocation.id, targetId: invocation.targetAgentId,
    targetNodeId: peer.id, targetKind: "agent", transport: "peer_broker", reason: "invocation", policy: "must_ack", status: "peer_acked",
    metadata: { peerBrokerUrl: peer.brokerUrl, peerFlightId: `flight-${invocation.id}` },
  };
}

function recoveredFlight(invocation: InvocationRequest, state: FlightRecord["state"] = "completed"): FlightRecord {
  return {
    id: `flight-${invocation.id}`, invocationId: invocation.id, targetAgentId: invocation.targetAgentId,
    requesterId: invocation.requesterId, state, startedAt: 0,
    ...(state === "completed" ? { completedAt: 5, output: "finished while origin offline" } : {}),
  };
}

async function settleMirror() { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); }

test("healthy HTTP backpressure delivers a complete 3 MiB terminal snapshot to the peer mirror", async () => {
  const invocation = makeInvocation("large-snapshot", "remote-agent");
  const flight = { ...recoveredFlight(invocation), output: "x".repeat(3 * 1024 * 1024) };
  let acceptedForLiveFanout: boolean | undefined;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    acceptedForLiveFanout = writeSseFrame(response, "snapshot", { invocationId: invocation.id, flight });
    if (acceptedForLiveFanout) response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const peer = makeNode("remote", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const harness = makeHarness({ invocation, peer });
  const delivery = recoveredDelivery(invocation, peer);
  harness.deliveries.set(delivery.id, delivery);
  let captured!: () => void;
  const done = new Promise<void>(resolve => { captured = resolve; });
  harness.deps.peerFetch = (base, path, init) => fetch(new URL(path, base), init);
  harness.deps.recordFlight = async value => { harness.flights.push(value); captured(); };
  const worker = createPeerDeliveryWorker(harness.deps);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    worker.start();
    await Promise.race([done, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error("large snapshot was not delivered")), 2_000); deadline.unref();
    })]);
    expect(acceptedForLiveFanout).toBe(false); // Node high-water mark, not a failed delivery.
    expect(harness.flights).toHaveLength(1);
    expect(harness.flights[0]!.output).toBe(flight.output);
    expect(harness.flights[0]!.state).toBe("completed");
  } finally {
    clearTimeout(deadline);
    worker.stop(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("peer parser accepts a complete legal snapshot above its former 8 MiB cap", async () => {
  const invocation = makeInvocation("large-parser", "remote-agent");
  const peer = makeNode("remote", "http://remote.test");
  const harness = makeHarness({ invocation, peer });
  const delivery = recoveredDelivery(invocation, peer);
  harness.deliveries.set(delivery.id, delivery);
  const flight = { ...recoveredFlight(invocation), output: "x".repeat(9 * 1024 * 1024) + "界" };
  const encoded = new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify({ invocationId: invocation.id, flight })}\n\n`);
  harness.deps.peerFetch = async () => new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < encoded.length; offset += 65_537) controller.enqueue(encoded.subarray(offset, offset + 65_537));
    controller.close();
  } }));
  const worker = createPeerDeliveryWorker(harness.deps);
  try {
    worker.start(); await settleMirror();
    expect(harness.flights).toHaveLength(1);
    expect(harness.flights[0]!.output).toBe(flight.output);
  } finally { worker.stop(); }
});

test("restart restores peer_acked observation and captures a terminal snapshot without forwarding again", async () => {
  const invocation = makeInvocation("restored", "remote-agent");
  const peer = makeNode("remote", "http://remote.test");
  const harness = makeHarness({ invocation, peer });
  const delivery = recoveredDelivery(invocation, peer);
  harness.deliveries.set(delivery.id, delivery);
  let forwards = 0;
  let fetches = 0;
  let cancels = 0;
  const emitted: unknown[] = [];
  const flight = recoveredFlight(invocation);
  harness.setForward(async () => { forwards += 1; return { ok: true, flight }; });
  harness.deps.emit = (event) => emitted.push(event);
  harness.deps.peerFetch = async () => {
    fetches += 1;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify({ invocationId: invocation.id, flight })}\n\n`)); },
      cancel() { cancels += 1; },
    }));
  };
  const worker = createPeerDeliveryWorker(harness.deps, { tickIntervalMs: 999_999 });
  worker.start();
  await settleMirror();
  expect(forwards).toBe(0);
  expect(fetches).toBe(1);
  expect(cancels).toBe(1);
  expect(harness.flights).toEqual([flight]);
  expect(emitted).toHaveLength(1);
  harness.setNow(100_000);
  await worker.tick();
  expect(fetches).toBe(1);
  expect(harness.deliveries.get(delivery.id)?.status).toBe("peer_acked");
  worker.stop();
});

test("failed peer observation backs off, then reconnects without spending another dispatch attempt", async () => {
  const invocation = makeInvocation("reconnect", "remote-agent");
  const peer = makeNode("remote", "http://remote.test");
  const harness = makeHarness({ invocation, peer });
  const delivery = recoveredDelivery(invocation, peer);
  harness.deliveries.set(delivery.id, delivery);
  let fetches = 0;
  harness.deps.peerFetch = async () => { fetches += 1; throw new Error("offline"); };
  const worker = createPeerDeliveryWorker(harness.deps, { initialBackoffMs: 100 });
  await worker.tick();
  await settleMirror();
  await worker.tick();
  expect(fetches).toBe(1);
  harness.setNow(1_000);
  await worker.tick();
  await settleMirror();
  expect(fetches).toBe(2);
  expect(harness.attempts.size).toBe(0);
  expect(harness.failedInvocations).toHaveLength(0);
  worker.stop();
});

test("peer mirror matches exact flight and target, persists before emitting, and cleans the terminal reader", async () => {
  const invocation = makeInvocation("match", "remote-agent");
  const peer = makeNode("remote", "http://remote.test");
  const harness = makeHarness({ invocation, peer });
  const delivery = recoveredDelivery(invocation, peer);
  harness.deliveries.set(delivery.id, delivery);
  const flight = recoveredFlight(invocation);
  let cancels = 0;
  let events = 0;
  harness.deps.emit = () => { expect(harness.flights).toEqual([flight]); events += 1; };
  harness.deps.peerFetch = async () => new Response(new ReadableStream({
    start(controller) {
      for (const candidate of [{ ...flight, id: "wrong-flight" }, { ...flight, targetAgentId: "wrong-target" }, { ...flight, requesterId: "wrong-requester" }, flight]) {
        controller.enqueue(new TextEncoder().encode(`event: flight.updated\ndata: ${JSON.stringify({ id: "event", kind: "flight.updated", ts: 3, actorId: "system", payload: { flight: candidate } })}\n\n`));
      }
    },
    cancel() { cancels += 1; },
  }));
  const worker = createPeerDeliveryWorker(harness.deps);
  await worker.tick();
  await settleMirror();
  expect(events).toBe(1);
  expect(cancels).toBe(1);
  expect(harness.flights).toEqual([flight]);
  worker.stop();
});

test("failed mirror persistence leaves acknowledgement recoverable and never emits an unrecorded completion", async () => {
  const invocation = makeInvocation("write-failure", "remote-agent");
  const peer = makeNode("remote", "http://remote.test");
  const harness = makeHarness({ invocation, peer });
  const delivery = recoveredDelivery(invocation, peer);
  harness.deliveries.set(delivery.id, delivery);
  let events = 0;
  let fetches = 0;
  harness.deps.emit = () => { events += 1; };
  harness.deps.recordFlight = async () => { throw new Error("disk full"); };
  harness.deps.peerFetch = async () => {
    fetches += 1;
    return new Response(`event: snapshot\ndata: ${JSON.stringify({ invocationId: invocation.id, flight: recoveredFlight(invocation) })}\n\n`);
  };
  const worker = createPeerDeliveryWorker(harness.deps, { initialBackoffMs: 100 });
  await worker.tick();
  await settleMirror();
  expect(events).toBe(0);
  harness.setNow(1_000);
  await worker.tick();
  await settleMirror();
  expect(fetches).toBe(2);
  expect(harness.deliveries.get(delivery.id)?.status).toBe("peer_acked");
  worker.stop();
});

test("peer observation concurrency is bounded and stop cancels even readers whose fetch ignores abort", async () => {
  const invocation = makeInvocation("bounded", "remote-agent");
  const peer = makeNode("remote", "http://remote.test");
  const harness = makeHarness({ invocation, peer });
  for (let index = 0; index < 20; index++) {
    const delivery = recoveredDelivery(invocation, peer);
    harness.deliveries.set(`delivery-${index}`, { ...delivery, id: `delivery-${index}` });
  }
  let fetches = 0;
  let cancels = 0;
  harness.deps.peerFetch = async () => {
    fetches += 1;
    return new Response(new ReadableStream({ cancel() { cancels += 1; } }));
  };
  const worker = createPeerDeliveryWorker(harness.deps, { maxStatusMirrors: 3 });
  await worker.tick();
  await settleMirror();
  expect(fetches).toBe(3);
  worker.stop();
  await settleMirror();
  expect(cancels).toBe(3);
  await worker.tick();
  expect(fetches).toBe(3);
});

test("concurrent and repeated enqueues reuse the same peer delivery without replaying an acknowledgement", async () => {
  const invocation = makeInvocation("dedup", "remote-agent");
  const peer = makeNode("remote", "http://remote.test");
  const harness = makeHarness({ invocation, peer });
  let forwards = 0;
  harness.setForward(async () => { forwards++; return { ok: true, flight: recoveredFlight(invocation, "running") }; });
  const worker = createPeerDeliveryWorker(harness.deps);
  const results = await Promise.all(Array.from({ length: 8 }, () => worker.enqueue(invocation, peer)));
  await worker.tick();
  expect(new Set(results.map((delivery) => delivery.id)).size).toBe(1);
  expect(harness.deliveries.size).toBe(1);
  expect(forwards).toBe(1);
  await worker.enqueue(invocation, peer);
  await worker.tick();
  expect(forwards).toBe(1);
  worker.stop();
});

test("cancellation during the awaited lease write prevents external forwarding", async () => {
  const invocation = makeInvocation("cancel-at-lease", "remote-agent");
  const peer = makeNode("remote", "http://remote.test");
  const harness = makeHarness({ invocation, peer });
  const delivery = { ...recoveredDelivery(invocation, peer), status: "accepted" as const };
  harness.deliveries.set(delivery.id, delivery);
  const update = harness.deps.updateDeliveryStatus;
  harness.deps.updateDeliveryStatus = async (input) => {
    await update(input);
    if (input.leaseOwner) harness.flights.push(recoveredFlight(invocation, "cancelled"));
  };
  let forwards = 0;
  harness.setForward(async () => { forwards++; return { ok: true, flight: recoveredFlight(invocation) }; });
  const worker = createPeerDeliveryWorker(harness.deps);
  await worker.tick();
  expect(forwards).toBe(0);
  expect(harness.deliveries.get(delivery.id)?.status).toBe("cancelled");
  expect(harness.attempts.size).toBe(0);
  worker.stop();
});

test.each(["cancel", "stop"] as const)("%s during a delayed request-history read prevents external forwarding", async (action) => {
  const invocation = { ...makeInvocation("cancel-at-history", "remote-agent"), messageId: "cold-request" };
  const peer = makeNode("remote", "http://remote.test");
  const harness = makeHarness({ invocation, peer });
  const delivery = { ...recoveredDelivery(invocation, peer), status: "accepted" as const };
  harness.deliveries.set(delivery.id, delivery);
  const snapshot = emptySnapshot();
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  registerAsyncMessageRecordView(snapshot.messages, {
    count: () => 1,
    async read(id) { expect(id).toBe(invocation.messageId); entered(); await resume; return undefined; },
    async *iterate() { throw new Error("must not scan all history"); },
    async withCapture() { throw new Error("must not capture all history"); },
  });
  harness.deps.snapshot = () => snapshot;
  let forwards = 0;
  harness.setForward(async () => { forwards++; return { ok: true, flight: recoveredFlight(invocation) }; });
  const worker = createPeerDeliveryWorker(harness.deps);
  const pending = worker.tick();
  try {
    await reading;
    if (action === "cancel") harness.flights.push(recoveredFlight(invocation, "cancelled"));
    else worker.stop();
    release();
    await pending;
    expect(forwards).toBe(0);
    expect(harness.attempts.size).toBe(0);
    if (action === "cancel") expect(harness.deliveries.get(delivery.id)?.status).toBe("cancelled");
  } finally {
    release();
    worker.stop();
  }
});

test("forward concurrency stays at 16 even when peer-online hints arrive during a stalled batch", async () => {
  const peer = makeNode("remote", "http://remote.test");
  const harness = makeHarness({ peer });
  const invocations = new Map<string, InvocationRequest>();
  for (let i = 0; i < 25; i++) {
    const invocation = makeInvocation(`pool-${i}`, "remote-agent");
    invocations.set(invocation.id, invocation);
    const delivery = recoveredDelivery(invocation, peer);
    harness.deliveries.set(delivery.id, { ...delivery, status: "accepted" });
  }
  harness.deps.invocationFor = (id) => invocations.get(id);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let active = 0, peak = 0, forwards = 0;
  harness.deps.forward = async (_target, bundle) => {
    active++; peak = Math.max(peak, active); forwards++;
    await gate; active--;
    return { ok: true, flight: recoveredFlight(bundle.invocation, "running") };
  };
  const worker = createPeerDeliveryWorker(harness.deps);
  const pending = worker.tick();
  await settleMirror();
  for (let i = 0; i < 10; i++) worker.notifyPeerOnline(peer.id);
  await settleMirror();
  expect(peak).toBe(16);
  expect(forwards).toBe(16);
  release();
  await pending;
  await worker.tick();
  expect(forwards).toBe(25);
  expect(peak).toBe(16);
  worker.stop();
});
