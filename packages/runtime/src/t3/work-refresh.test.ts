import { expect, test } from "bun:test";
import type { AgentEndpoint, CollaborationRecord, DeliveryIntent, FlightRecord, InvocationRequest, MessageRecord } from "@openscout/protocol";
import { runtimeSessionHandleForEndpoint } from "../runtime-session-handle.js";
import { type T3Adapter, t3ScopedId } from "./adapter.js";
import { BrokerT3Service, type BrokerT3ServiceOptions } from "./broker-service.js";

function fixture(adapter: () => T3Adapter) {
  const work = new Map<string, CollaborationRecord>();
  const deliveries = new Map<string, DeliveryIntent>();
  const flights = new Map<string, FlightRecord>();
  const endpoints: AgentEndpoint[] = [];
  const messages: MessageRecord[] = [];
  const options: BrokerT3ServiceOptions = {
    nodeId: "node", adapter, endpoints: () => endpoints,
    persistEndpoint: async endpoint => { endpoints.push(endpoint); }, persistActor: async () => {},
    work: id => work.get(id), recordWork: async record => { work.set(record.id, record); },
    delivery: id => deliveries.get(id), recordDelivery: async delivery => { deliveries.set(delivery.id, delivery); },
    mutateDelivery: async (id, update) => {
      const current = deliveries.get(id); if (!current) return undefined;
      const next = update(current); if (next) deliveries.set(id, next); return next ?? undefined;
    },
    flight: id => flights.get(id), recordFlight: async flight => { flights.set(flight.id, flight); },
    postMessage: async message => { messages.push(message); },
  };
  return { service: new BrokerT3Service(options), work, deliveries, flights, endpoints, messages };
}

test("refresh retains Scout correlation while replacing stale waiting, completion, and removed source metadata", async () => {
  for (const initialState of ["Blocked", "Done"]) {
    let card: Record<string, unknown> = {
      id: "card", title: "Source card", state: initialState, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
      runtime: { implementationRunId: "implementation", currentError: "Earlier dependency" }, dependencies: ["dependency"],
      intentBrief: { intent: "Previous source intent" }, priority: 2, area: "runtime", slice: "adapter",
    };
    const adapter = { board: async () => ({ project: { id: "project" }, board: { cards: [card] } }) } as unknown as T3Adapter;
    const f = fixture(() => adapter);
    await f.service.refresh("local", "project");
    const id = t3ScopedId("t3-work", "local", "project", "card");
    const before = f.work.get(id)!;
    expect(before.kind).toBe("work_item");
    if (before.kind === "work_item") {
      if (initialState === "Blocked") expect(before.waitingOn).toBeTruthy();
      else expect(before.completedAt).toBeTruthy();
    }
    f.work.set(id, { ...before, conversationId: "original-conversation", metadata: { ...before.metadata, lastInvocationId: "original-invocation", retainedLocalFact: "retain" } });
    card = { id: "card", title: "Source card", state: "Running", createdAt: "2026-01-01T00:00:00Z", runtime: { implementationRunId: "implementation" } };
    await f.service.refresh("local", "project");
    const after = f.work.get(id)!;
    expect(after).toMatchObject({ state: "working", conversationId: "original-conversation", metadata: { lastInvocationId: "original-invocation", retainedLocalFact: "retain" } });
    expect(after.summary).toBeUndefined();
    expect(after.relations).toBeUndefined();
    expect(after.kind === "work_item" && after.waitingOn).toBeUndefined();
    expect(after.kind === "work_item" && after.completedAt).toBeUndefined();
    for (const key of ["sourceIntentBrief", "sourcePriority", "sourceArea", "sourceSlice"]) expect(after.metadata?.[key]).toBeUndefined();
  }
});

test("board recovery replays a captured terminal result after the source card changes without accessing T3", async () => {
  let sourceAccesses = 0;
  const f = fixture(() => { sourceAccesses++; throw new Error("Source card has advanced to another run and must not be consulted"); });
  const endpoint: AgentEndpoint = { id: "card-endpoint", agentId: "t3-project", nodeId: "node", harness: "bridge", transport: "http", state: "idle", sessionId: "card-session",
    metadata: { t3Session: true, connectionId: "local", projectId: "project", t3CardId: "card" } };
  f.endpoints.push(endpoint);
  const invocation: InvocationRequest = { id: "invocation", requesterId: "operator", requesterNodeId: "node", targetAgentId: endpoint.agentId, action: "execute",
    task: "Run the original source card", ensureAwake: true, stream: false, createdAt: 1, conversationId: "original-conversation", messageId: "original-request",
    execution: { targetSessionId: runtimeSessionHandleForEndpoint(endpoint)! } };
  f.flights.set(invocation.id, { id: invocation.id, invocationId: invocation.id, requesterId: invocation.requesterId, targetAgentId: endpoint.agentId, state: "waiting" });
  const receiptId = t3ScopedId("t3-invocation", invocation.id);
  f.deliveries.set(receiptId, { id: receiptId, invocationId: invocation.id, targetId: endpoint.agentId, targetNodeId: "node", targetKind: "agent", transport: "http", reason: "invocation", policy: "durable", status: "acknowledged",
    metadata: { phase: "accepted", threadId: "original-thread", turnId: "original-terminal-turn", resultBody: "Original card reached Review; human acceptance remains pending.", resultAt: 2 } });
  await f.service.dispatch(invocation, endpoint);
  expect(sourceAccesses).toBe(0);
  expect(f.flights.get(invocation.id)).toMatchObject({ state: "completed", output: "Original card reached Review; human acceptance remains pending." });
  expect(f.messages).toHaveLength(1);
  expect(f.messages[0]).toMatchObject({ conversationId: "original-conversation", replyToMessageId: "original-request", body: "Original card reached Review; human acceptance remains pending.",
    metadata: { t3ThreadId: "original-thread", t3TurnId: "original-terminal-turn" } });
  expect(f.deliveries.get(receiptId)).toMatchObject({ status: "completed", metadata: { phase: "replied" } });
});
