import { describe, expect, test } from "bun:test";
import type { AgentEndpoint, InvocationRequest } from "@openscout/protocol";
import { createInMemoryControlRuntime } from "./broker.js";
import { createRuntimeRegistrySnapshot } from "./registry.js";
import { assertAskTrace, parseAskTraceparent, stampAskContext } from "./ask-context.js";
import { runtimeSessionAddressForEndpoint } from "./runtime-session-address.js";

const endpoint = { id: "caller-endpoint", agentId: "caller", nodeId: "node-test", harness: "codex",
  transport: "codex_app_server", state: "active", sessionId: "native-caller", metadata: { nativeSessionId: "native-caller" } } as AgentEndpoint;
const callerHeader = "00-11111111111111111111111111111111-2222222222222222-01";
function request(metadata: Record<string, unknown> = {}): InvocationRequest {
  return { id: "ask-child", requesterId: "caller", requesterNodeId: "node-test", targetAgentId: "worker", action: "consult",
    task: "test", origin: { source: "unknown" }, ensureAwake: false, stream: false, createdAt: 1, metadata };
}
function snapshot() {
  return createRuntimeRegistrySnapshot({ endpoints: { [endpoint.id]: endpoint } });
}

describe("creation-time ask context", () => {
  test("MCP native Codex identity is claimed, never the shared return transport", () => {
    const state = snapshot();
    const ask = request({ source: "scout-mcp", replyToSessionId: "native-caller",
      returnAddress: { sessionAddress: "sess.shared@shared" } });
    stampAskContext(ask, state, "node-test");
    expect(ask.origin).toEqual({ source: "claimed", sessionAddress: runtimeSessionAddressForEndpoint(state, endpoint)! });
    assertAskTrace(ask.trace);
  });
  test("an undiscovered native conversation still has a caller-asserted address", () => {
    const ask = request({ source: "scout-mcp", replyToSessionId: "native-caller", replyToSessionHarness: "codex" });
    stampAskContext(ask, createRuntimeRegistrySnapshot(), "node-test");
    expect(ask.origin).toEqual({ source: "claimed", sessionAddress: runtimeSessionAddressForEndpoint(snapshot(), endpoint)! });
  });
  test("MCP without a session stays unknown even with an observed actor and shared return address", () => {
    const ask = request({ source: "scout-mcp", returnAddress: { sessionAddress: "sess.shared@shared" } });
    ask.traceparent = callerHeader;
    stampAskContext(ask, snapshot(), "node-test");
    expect(ask.origin).toEqual({ source: "unknown" });
    expect(ask.trace).toMatchObject({ traceId: "1".repeat(32), parentSpanId: "2".repeat(16) });
  });
  test("runtime-observed native binding is verified; caller provenance cannot promote itself", () => {
    const ask = request(); stampAskContext(ask, snapshot(), "node-test", endpoint.id);
    expect(ask.origin.source).toBe("verified");
    const claimed = request(); claimed.origin = { source: "verified", sessionAddress: ask.origin.sessionAddress, runningFlightId: "invented" };
    stampAskContext(claimed, snapshot(), "node-test");
    expect(claimed.origin).toEqual({ source: "claimed", sessionAddress: ask.origin.sessionAddress });
  });
  test("running flight wins over traceparent without creating an obligation", async () => {
    const state = snapshot();
    const parent = request(); parent.id = "ask-parent"; parent.trace = { traceId: "a".repeat(32), spanId: "b".repeat(16) };
    state.invocations[parent.id] = parent;
    state.flights.parent = { id: "parent", invocationId: parent.id, targetAgentId: "caller", requesterId: "operator", state: "running",
      metadata: { dispatchAck: { sessionId: "native-caller", endpointId: endpoint.id, acknowledgedAt: 1 } } };
    const ask = request({ source: "scout-mcp", replyToSessionId: "native-caller" }); ask.traceparent = callerHeader;
    stampAskContext(ask, state, "node-test");
    expect(ask.origin.runningFlightId).toBe("parent");
    expect(ask.origin.source).toBe("claimed");
    expect(ask.trace).toMatchObject({ traceId: parent.trace.traceId, parentSpanId: parent.trace.spanId });
    expect(ask.metadata?.completionRelation).toBeUndefined();
    expect(state.flights.parent.metadata?.completion).toBeUndefined();
    const runtime = createInMemoryControlRuntime(state, { localNodeId: "node-test" });
    await runtime.upsertFlight({ ...state.flights.parent, state: "completed", completedAt: 2 });
    expect(runtime.flight("parent")?.state).toBe("completed");
  });
  test("a running legacy parent retains origin but gets no synthetic trace or parent span", () => {
    const state = snapshot(); const parent = request(); parent.id = "legacy";
    state.invocations[parent.id] = parent;
    state.flights.parent = { id: "parent", invocationId: parent.id, targetAgentId: "caller", requesterId: "operator", state: "running",
      metadata: { dispatchAck: { sessionId: "native-caller", acknowledgedAt: 1 } } };
    const ask = request({ replyToSessionId: "native-caller" }); ask.traceparent = callerHeader;
    stampAskContext(ask, state, "node-test");
    expect(ask.origin.runningFlightId).toBe("parent");
    assertAskTrace(ask.trace);
    expect(ask.trace.traceId).not.toBe("1".repeat(32));
    expect(ask.trace.parentSpanId).toBeUndefined();
    expect(parent.trace).toBeUndefined();
  });
  test("ended or ambiguous flights do not invent a running parent", () => {
    const state = snapshot();
    for (const id of ["one", "two"]) state.flights[id] = { id, invocationId: id, targetAgentId: "caller", requesterId: "operator", state: "running",
      metadata: { dispatchAck: { sessionId: "native-caller", acknowledgedAt: 1 } } };
    const ask = request(); stampAskContext(ask, state, "node-test");
    expect(ask.origin.runningFlightId).toBeUndefined();
  });
  test("no caller parent starts distinct random trace and span ids", () => {
    const one = request(); const two = request();
    stampAskContext(one, createRuntimeRegistrySnapshot(), "node-test");
    stampAskContext(two, createRuntimeRegistrySnapshot(), "node-test");
    assertAskTrace(one.trace); assertAskTrace(two.trace);
    expect(one.trace.traceId).not.toBe(two.trace.traceId); expect(one.trace.spanId).not.toBe(two.trace.spanId);
    expect(one.trace.parentSpanId).toBeUndefined();
  });
  test("legacy snapshot origin is unknown and trace remains absent", () => {
    const legacy = { ...request(), metadata: { returnAddress: { sessionAddress: "sess.shared@shared" } } };
    delete (legacy as Partial<InvocationRequest>).origin;
    expect(createRuntimeRegistrySnapshot({ invocations: { legacy } }).invocations.legacy).toMatchObject({ origin: { source: "unknown" } });
    expect(createRuntimeRegistrySnapshot({ invocations: { legacy } }).invocations.legacy?.trace).toBeUndefined();
  });
  test.each(["00-" + "0".repeat(32) + "-2222222222222222-01", callerHeader.replace("2222222222222222", "0".repeat(16)),
    callerHeader.replace("00-", "ff-"), callerHeader + "-extra", callerHeader.toUpperCase().replace("1111", "AAAA"), "broken"])("invalid traceparent is ignored: %s", header => {
    expect(parseAskTraceparent(header)).toBeUndefined();
    const ask = request({ source: "scout-mcp" }); ask.traceparent = header;
    stampAskContext(ask, snapshot(), "node-test"); assertAskTrace(ask.trace);
    expect(ask.trace.parentSpanId).toBeUndefined(); expect(ask.origin).toEqual({ source: "unknown" });
  });
});
