import { describe, expect, test } from "bun:test";

import type {
  ActorIdentity,
  AgentDefinition,
  AgentEndpoint,
  FlightRecord,
  InvocationRequest,
} from "@openscout/protocol";

import { createInMemoryControlRuntime } from "./broker.js";
import {
  a2aBlockingTimeoutMs,
  a2aJsonRpcError,
  a2aJsonRpcResult,
  a2aTargetAgentId,
  BrokerA2AService,
  type BrokerA2AServiceOptions,
} from "./broker-a2a-service.js";
import type { LocalAgentBinding } from "./local-agents.js";

function testActor(input: Partial<ActorIdentity> = {}): ActorIdentity {
  return {
    id: "agent-1",
    kind: "agent",
    displayName: "Agent One",
    handle: "agent-one",
    metadata: {},
    ...input,
  };
}

function testAgent(input: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "agent-1",
    kind: "agent",
    definitionId: "agent",
    displayName: "Agent One",
    handle: "agent-one",
    labels: ["agent"],
    selector: "@agent-one",
    defaultSelector: "@agent-one",
    metadata: {
      brokerRegistered: true,
      description: "A test agent.",
      skills: [{ id: "echo", name: "Echo", description: "Echo text." }],
    },
    agentClass: "general",
    capabilities: ["chat", "invoke", "deliver"],
    wakePolicy: "on_demand",
    homeNodeId: "node-1",
    authorityNodeId: "node-1",
    advertiseScope: "local",
    ...input,
  };
}

function testEndpoint(input: Partial<AgentEndpoint> = {}): AgentEndpoint {
  return {
    id: "endpoint-1",
    agentId: "agent-1",
    nodeId: "node-1",
    harness: "codex",
    transport: "codex_app_server",
    state: "active",
    projectRoot: "/repo",
    cwd: "/repo",
    metadata: {},
    ...input,
  };
}

function testFlight(input: Partial<FlightRecord> = {}): FlightRecord {
  return {
    id: "flight-1",
    invocationId: "invocation-1",
    requesterId: "operator",
    targetAgentId: "agent-1",
    state: "queued",
    startedAt: 100,
    ...input,
  };
}

function createService(extra: (runtime: ReturnType<typeof createInMemoryControlRuntime>) => Partial<BrokerA2AServiceOptions> = () => ({})) {
  const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });
  const knownInvocations = new Map<string, InvocationRequest>();
  const activeInvocationTasks = new Map<string, Promise<void>>();
  const accepted: InvocationRequest[] = [];
  const dispatched: InvocationRequest[] = [];
  const recordedFlights: FlightRecord[] = [];
  const localBindings: LocalAgentBinding[] = [];
  let idCounter = 0;
  const service = new BrokerA2AService({
    nodeId: "node-1",
    brokerUrl: "http://127.0.0.1:4321",
    runtime,
    knownInvocations,
    activeInvocationTasks,
    createId(prefix) {
      idCounter += 1;
      return `${prefix}-${idCounter}`;
    },
    async acceptInvocation(invocation) {
      accepted.push(invocation);
      knownInvocations.set(invocation.id, invocation);
      const flight = testFlight({
        id: `flight-${idCounter}`,
        invocationId: invocation.id,
        requesterId: invocation.requesterId,
        targetAgentId: invocation.targetAgentId,
        startedAt: invocation.createdAt,
      });
      await runtime.commitInvocation(invocation, flight);
      return flight;
    },
    async dispatchInvocation(invocation) {
      dispatched.push(invocation);
    },
    async recordFlight(flight) {
      recordedFlights.push(flight);
      await runtime.upsertFlight(flight);
    },
    ...extra(runtime),
    async loadRegisteredLocalAgentBindings() {
      return localBindings;
    },
    sleep: async () => {},
  });

  return {
    runtime,
    service,
    knownInvocations,
    activeInvocationTasks,
    accepted,
    dispatched,
    recordedFlights,
    localBindings,
  };
}

describe("BrokerA2AService", () => {
  test("builds JSON-RPC result and error envelopes", () => {
    expect(a2aJsonRpcResult("1", { ok: true })).toEqual({
      jsonrpc: "2.0",
      id: "1",
      result: { ok: true },
    });
    expect(a2aJsonRpcError("1", -32601, "Nope", { method: "x" })).toEqual({
      jsonrpc: "2.0",
      id: "1",
      error: {
        code: -32601,
        message: "Nope",
        data: { method: "x" },
      },
    });
  });

  test("extracts target ids and caps blocking timeouts", () => {
    expect(a2aTargetAgentId({
      message: { role: "ROLE_USER", parts: [] },
      metadata: { scoutTargetAgentId: " agent-1 " },
    })).toBe("agent-1");
    expect(a2aTargetAgentId({
      message: { role: "ROLE_USER", parts: [], metadata: { targetAgentId: "agent-2" } },
    }, "agent-path")).toBe("agent-path");
    expect(a2aBlockingTimeoutMs({
      message: { role: "ROLE_USER", parts: [] },
      configuration: { timeoutMs: 500_000 },
    })).toBe(120_000);
  });

  test("serves broker and per-agent cards from registered agents", async () => {
    const { runtime, service } = createService();
    await runtime.upsertActor(testActor());
    await runtime.upsertAgent(testAgent());
    await runtime.upsertEndpoint(testEndpoint());

    const brokerCard = await service.agentCardForRequest("http://broker.test");
    const agentCard = await service.agentCardForRequest("http://broker.test", "agent-1");

    expect(brokerCard?.name).toBe("OpenScout Broker");
    expect(brokerCard?.metadata?.scoutAgentIds).toEqual(["agent-1"]);
    expect(agentCard?.name).toBe("Agent One");
    expect(agentCard?.supportedInterfaces?.[0]).toEqual(expect.objectContaining({
      tenant: "agent-1",
      protocolBinding: "JSONRPC",
      url: "http://broker.test/v1/a2a/agents/agent-1/rpc",
    }));
  });

  test("turns SendMessage into a Scout invocation and exposes it as a task", async () => {
    const { runtime, service, accepted, dispatched } = createService();
    await runtime.upsertAgent(testAgent());

    const send = await service.handleJsonRpc({
      jsonrpc: "2.0",
      id: "send-1",
      method: "SendMessage",
      params: {
        message: {
          role: "ROLE_USER",
          messageId: "a2a-message-1",
          contextId: "conversation-1",
          parts: [{ text: "hello from a2a" }],
          metadata: { scoutRequesterId: "operator" },
        },
        configuration: {
          blocking: false,
          timeoutMs: 5_000,
        },
      },
    }, "http://broker.test", "agent-1");

    expect(send.error).toBeUndefined();
    expect(send.result).toEqual(expect.objectContaining({
      task: expect.objectContaining({
        id: "flight-1",
        contextId: "conversation-1",
        status: expect.objectContaining({ state: "TASK_STATE_SUBMITTED" }),
      }),
    }));
    expect(accepted).toEqual([
      expect.objectContaining({
        id: "a2a-inv-1",
        requesterId: "operator",
        targetAgentId: "agent-1",
        task: "hello from a2a",
        labels: ["a2a"],
        timeoutMs: 5_000,
        metadata: expect.objectContaining({
          a2aMessageId: "a2a-message-1",
          a2aRole: "ROLE_USER",
          a2aProtocolVersion: "1.0",
        }),
      }),
    ]);
    expect(dispatched.map((invocation) => invocation.id)).toEqual(["a2a-inv-1"]);

    const listed = await service.handleJsonRpc({
      jsonrpc: "2.0",
      id: "list-1",
      method: "ListTasks",
      params: { contextId: "conversation-1" },
    }, "http://broker.test", "agent-1");
    expect(listed.result).toEqual(expect.objectContaining({
      totalSize: 1,
      tasks: [expect.objectContaining({ id: "flight-1" })],
    }));
  });

  test("does not mark externally running or waiting work cancelled without interrupting it", async () => {
    for (const state of ["waking", "running", "waiting"] as const) {
      const { runtime, service, recordedFlights } = createService();
      await runtime.commitInvocation({ id: "invocation-1", requesterId: "operator", requesterNodeId: "node-1", targetAgentId: "agent-1", action: "consult", task: "work", ensureAwake: true, stream: false, createdAt: 100 }, testFlight({ invocationId: "invocation-1", state }));
      const response = await service.handleJsonRpc({ jsonrpc: "2.0", id: "cancel", method: "CancelTask", params: { id: "flight-1" } }, "http://broker.test");
      expect(response.error?.code).toBe(-32004);
      expect(recordedFlights).toHaveLength(0);
    }
  });

  test("cancels queued tasks and rejects unknown A2A methods", async () => {
    const { runtime, service, recordedFlights } = createService();
    const invocation: InvocationRequest = {
      id: "invocation-1",
      requesterId: "operator",
      requesterNodeId: "node-1",
      targetAgentId: "agent-1",
      action: "consult",
      task: "queued work",
      ensureAwake: true,
      stream: false,
      createdAt: 100,
    };
    const flight = testFlight({ invocationId: invocation.id, state: "queued" });
    await runtime.commitInvocation(invocation, flight);

    const cancelled = await service.handleJsonRpc({
      jsonrpc: "2.0",
      id: "cancel-1",
      method: "CancelTask",
      params: { id: "flight-1" },
    }, "http://broker.test");

    expect(cancelled.result).toEqual(expect.objectContaining({
      id: "flight-1",
      status: expect.objectContaining({ state: "TASK_STATE_CANCELED" }),
    }));
    expect(recordedFlights[0]).toEqual(expect.objectContaining({
      id: "flight-1",
      state: "cancelled",
      summary: "A2A client cancelled the task before it started running.",
    }));

    const unknown = await service.handleJsonRpc({
      jsonrpc: "2.0",
      id: "missing-1",
      method: "NoSuchMethod",
    }, "http://broker.test");

    expect(unknown.error).toEqual(expect.objectContaining({
      code: -32601,
      message: "A2A method not found: NoSuchMethod",
    }));
  });

  describe("cancelling a waking flight", () => {
    const invocation: InvocationRequest = { id: "invocation-1", requesterId: "operator", requesterNodeId: "node-1", targetAgentId: "agent-1",
      action: "consult", task: "work", ensureAwake: true, stream: false, createdAt: 100 };
    const notSubmitted = { dispatchOutcome: { status: "not_submitted", checkedAt: 100 } };
    const cancel = (service: BrokerA2AService) => service.handleJsonRpc({ jsonrpc: "2.0", id: "cancel", method: "CancelTask", params: { id: "flight-1" } }, "http://broker.test");

    test("cancels a waking flight with not-submitted evidence and no executor", async () => {
      const { runtime, service, recordedFlights } = createService(() => ({ isInvocationActive: () => false }));
      await runtime.commitInvocation(invocation, testFlight({ state: "waking", metadata: notSubmitted }));
      const response = await cancel(service);
      expect(response.result).toEqual(expect.objectContaining({ id: "flight-1", status: expect.objectContaining({ state: "TASK_STATE_CANCELED" }) }));
      expect(recordedFlights.map(flight => flight.state)).toEqual(["cancelled"]);
    });

    test("refuses a waking flight that another executor holds", async () => {
      const { runtime, service, recordedFlights } = createService(() => ({ isInvocationActive: () => true }));
      await runtime.commitInvocation(invocation, testFlight({ state: "waking", metadata: notSubmitted }));
      expect((await cancel(service)).error?.code).toBe(-32004);
      expect(recordedFlights).toHaveLength(0);
    });

    test("cancels a superseded placeholder without moving the invocation's current flight", async () => {
      const cancelledPlaceholders: string[] = [];
      const { runtime, service, recordedFlights } = createService((runtime) => ({
        currentFlightForInvocation: (invocationId) => runtime.flightForInvocation(invocationId),
        // The superseding flight's executor is busy; the placeholder has none.
        isInvocationActive: () => true,
        async cancelSupersededFlight(flight, summary) {
          cancelledPlaceholders.push(flight.id);
          const cancelled = { ...flight, state: "cancelled" as const, summary, completedAt: 200 };
          await runtime.upsertFlight(cancelled, { preserveCurrent: true });
          return cancelled;
        },
      }));
      // Bare waking: no not-submitted evidence. Supersession is the evidence.
      await runtime.commitInvocation(invocation, testFlight({ state: "waking" }));
      await runtime.upsertFlight(testFlight({ id: "peer-flight", state: "completed", startedAt: 150 }));

      const response = await cancel(service);
      expect(response.result).toEqual(expect.objectContaining({ id: "flight-1", status: expect.objectContaining({ state: "TASK_STATE_CANCELED" }) }));
      expect(cancelledPlaceholders).toEqual(["flight-1"]);
      expect(recordedFlights).toHaveLength(0);
      expect(runtime.flightForInvocation("invocation-1")?.id).toBe("peer-flight");
    });
  });
});
