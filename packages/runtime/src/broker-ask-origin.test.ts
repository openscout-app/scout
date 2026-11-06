import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createScoutMcpServer } from "../../cli/src/mcp/scout-mcp.ts";
import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test.ts";
import { buildMeshInvocationBundle, forwardMeshInvocation } from "./mesh-forwarding.js";
import type { RuntimeSnapshot } from "@openscout/protocol";

const broker = createBrokerDaemonTestHarness();
const savedBrokerUrl = process.env.OPENSCOUT_BROKER_URL;
afterEach(() => {
  if (savedBrokerUrl === undefined) delete process.env.OPENSCOUT_BROKER_URL;
  else process.env.OPENSCOUT_BROKER_URL = savedBrokerUrl;
});

test("MCP origin claims and trace context survive creation and HTTP mesh forwarding on isolated brokers", async () => {
  const source = await broker.startBroker();
  const destination = await broker.startBroker();
  process.env.OPENSCOUT_BROKER_URL = source.baseUrl;
  const agent = { id: "origin-test-worker", kind: "agent", definitionId: "origin-test-worker", displayName: "Origin test worker",
    agentClass: "general", capabilities: ["chat", "invoke"], wakePolicy: "manual", homeNodeId: source.nodeId,
    authorityNodeId: source.nodeId, advertiseScope: "local" };
  await broker.postJson(source.baseUrl, "/v1/agents", agent);
  const mailbox = await broker.postJson<{ sessionId: string }>(source.baseUrl, "/v1/external-sessions/attach", { ownerId: agent.id, nativeSessionId: "fixture-worker" });
  // A shared transport on the requester must not become the asking session.
  await broker.postJson(source.baseUrl, "/v1/endpoints", { id: "shared-transport", agentId: "operator", nodeId: source.nodeId,
    harness: "bridge", transport: "http", sessionId: "shared-mcp-transport", state: "idle", metadata: {} });
  async function ask(env: NodeJS.ProcessEnv, body: string) {
    const server = createScoutMcpServer({ env, defaultCurrentDirectory: source.controlHome,
      dependencies: { resolveSenderId: async () => "operator", loadMeshOverview: async () => { throw new Error("not needed"); } } });
    const client = new Client({ name: "origin-test", version: "1" }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(st), client.connect(ct)]);
      const receipt = await client.callTool({ name: "ask", arguments: { targetSessionId: mailbox.sessionId, body, replyMode: "none" } });
      expect(receipt.isError).toBeFalsy();
      const data = receipt.structuredContent as { ok: boolean; ids: { invocationId: string } };
      expect(data.ok).toBe(true);
      const state = await broker.getJson<RuntimeSnapshot>(source.baseUrl, "/v1/snapshot");
      return state.invocations[data.ids.invocationId]!;
    } finally { await client.close(); await server.close(); }
  }
  const claimed = await ask({ CODEX_THREAD_ID: "origin-native-thread" }, "claimed caller");
  expect(claimed.origin.source).toBe("claimed");
  expect(claimed.origin.sessionAddress).toMatch(/^sess\.[0-9a-f]{20}@/);
  expect(claimed.trace?.traceId).toMatch(/^[0-9a-f]{32}$/);
  expect(claimed.trace?.spanId).toMatch(/^[0-9a-f]{16}$/);
  await broker.postJson(source.baseUrl, "/v1/endpoints", { id: "observed-caller", agentId: "operator", nodeId: source.nodeId,
    harness: "codex", transport: "codex_app_server", sessionId: "origin-native-thread", state: "active",
    metadata: { nativeSessionId: "origin-native-thread" } });
  const parentState = await broker.waitFor(() => broker.getJson<RuntimeSnapshot>(source.baseUrl, "/v1/snapshot"),
    state => Object.values(state.flights).some(flight => flight.invocationId === claimed.id && flight.state === "waiting"));
  const parentFlight = Object.values(parentState.flights).find(flight => flight.invocationId === claimed.id)!;
  const runningParent = { ...parentFlight, state: "running", metadata: { ...parentFlight.metadata,
    sessionTrace: [{ sessionId: "origin-native-thread", endpointId: "observed-caller", startedAt: Date.now(), lastAcknowledgedAt: Date.now() }],
    dispatchAck: { sessionId: "origin-native-thread", endpointId: "observed-caller", acknowledgedAt: Date.now() } } };
  await broker.postJson(source.baseUrl, "/v1/flights", runningParent);
  const child = await ask({ CODEX_THREAD_ID: "origin-native-thread", TRACEPARENT: "00-11111111111111111111111111111111-2222222222222222-01" }, "nested caller");
  expect(child.origin).toMatchObject({ source: "claimed", runningFlightId: parentFlight.id });
  expect(child.trace).toMatchObject({ traceId: claimed.trace!.traceId, parentSpanId: claimed.trace!.spanId });
  expect(child.metadata?.completionRelation).toBeUndefined();
  await broker.postJson(source.baseUrl, "/v1/flights", { ...runningParent, state: "completed", output: "Parent finished independently.", completedAt: Date.now() });
  const finished = await broker.getJson<RuntimeSnapshot>(source.baseUrl, "/v1/snapshot");
  expect(finished.flights[parentFlight.id]?.state).toBe("completed");
  expect(Object.values(finished.flights).find(flight => flight.invocationId === child.id)?.completedAt).toBeUndefined();
  const claude = await ask({ CLAUDE_CODE_SESSION_ID: "origin-claude-session" }, "Claude caller");
  expect(claude.origin.source).toBe("claimed");
  expect(claude.origin.sessionAddress).toMatch(/^sess\.[0-9a-f]{20}@/);
  const unknown = await ask({ TRACEPARENT: "00-11111111111111111111111111111111-2222222222222222-01" }, "unknown caller");
  expect(unknown.origin).toEqual({ source: "unknown" });
  expect(unknown.trace).toMatchObject({ traceId: "1".repeat(32), parentSpanId: "2".repeat(16) });
  const state = await broker.getJson<RuntimeSnapshot>(source.baseUrl, "/v1/snapshot");
  const bundle = buildMeshInvocationBundle(state, state.nodes[source.nodeId]!, child);
  // The same ask is received by the node that owns this fixture's target.
  bundle.agents = bundle.agents.map(item => item.id === agent.id ? { ...item, homeNodeId: destination.nodeId, authorityNodeId: destination.nodeId } : item);
  expect(bundle.invocation.trace?.traceId).toMatch(/^[0-9a-f]{32}$/);
  expect(bundle.invocation.trace?.spanId).toMatch(/^[0-9a-f]{16}$/);
  expect(bundle.invocation.trace?.parentSpanId).toMatch(/^[0-9a-f]{16}$/);
  const forwarded = await forwardMeshInvocation(destination.baseUrl, bundle, {
    peerFetch: (base, path, init) => fetch(base + path, init),
  });
  expect(forwarded.ok).toBe(true);
  const received = await broker.getJson<RuntimeSnapshot>(destination.baseUrl, "/v1/snapshot");
  expect(received.invocations[child.id]?.trace).toEqual(child.trace);
  expect(received.invocations[child.id]?.origin).toEqual(child.origin);
  const duplicate = await forwardMeshInvocation(destination.baseUrl, bundle, { peerFetch: (base, path, init) => fetch(base + path, init) });
  expect(duplicate.flight.id).toBe(forwarded.flight.id);
  expect((await broker.getJson<RuntimeSnapshot>(destination.baseUrl, "/v1/snapshot")).invocations[child.id]?.trace).toEqual(child.trace);
}, 30_000);
