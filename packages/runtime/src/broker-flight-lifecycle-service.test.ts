import { describe, expect, test } from "bun:test";

import type {
  AgentDefinition,
  AgentEndpoint,
  DeliveryAttempt,
  DeliveryIntent,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
} from "@openscout/protocol";

import {
  BrokerFlightLifecycleService,
  deliveryStatusForFlight,
  isDuplicateFlightUpdate,
  STALE_LOCAL_DELIVERY_GRACE_MS,
  shouldIgnoreFlightUpdate,
  staleLocalDeliveryReason,
} from "./broker-flight-lifecycle-service.js";
import type { RuntimeSnapshot } from "./scout-dispatcher.js";

function testAgent(input: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "agent-1",
    kind: "agent",
    definitionId: "agent-1",
    displayName: "Agent One",
    handle: "agent-one",
    labels: ["agent"],
    metadata: {},
    selector: "@agent-one",
    defaultSelector: "@agent-one",
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
    transport: "tmux",
    state: "offline",
    metadata: {
      staleLocalRegistration: true,
      replacedByAgentId: "agent-2",
      lastStartedAt: 1_000,
    },
    ...input,
  };
}

function testInvocation(input: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    id: "invocation-1",
    requesterId: "operator",
    requesterNodeId: "node-1",
    targetAgentId: "agent-1",
    action: "consult",
    task: "hello",
    messageId: "message-1",
    ensureAwake: false,
    stream: false,
    createdAt: 1_000,
    metadata: {},
    ...input,
  };
}

function testMessage(input: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: "message-1",
    conversationId: "conversation-1",
    actorId: "operator",
    originNodeId: "node-1",
    class: "agent",
    body: "hello",
    createdAt: 1_000,
    ...input,
  };
}

function testFlight(input: Partial<FlightRecord> = {}): FlightRecord {
  return {
    id: "flight-1",
    invocationId: "invocation-1",
    requesterId: "operator",
    targetAgentId: "agent-1",
    state: "running",
    startedAt: 1_000,
    metadata: {},
    ...input,
  };
}

function testDelivery(input: Partial<DeliveryIntent> = {}): DeliveryIntent {
  return {
    id: "delivery-1",
    messageId: "message-1",
    invocationId: "invocation-1",
    targetId: "agent-1",
    targetKind: "agent",
    transport: "tmux",
    reason: "mention",
    policy: "durable",
    status: "pending",
    metadata: {},
    ...input,
  };
}

function testDeliveryAttempt(input: Partial<DeliveryAttempt> = {}): DeliveryAttempt {
  return {
    id: "attempt-1",
    deliveryId: "delivery-1",
    attempt: 1,
    status: "sent",
    createdAt: 1_000,
    ...input,
  };
}

function testSnapshot(input: {
  agents?: Record<string, AgentDefinition>;
  endpoints?: Record<string, AgentEndpoint>;
  invocations?: Record<string, InvocationRequest>;
  messages?: Record<string, MessageRecord>;
  flights?: Record<string, FlightRecord>;
} = {}): RuntimeSnapshot {
  return {
    nodes: {},
    actors: {},
    agents: input.agents ?? {},
    endpoints: input.endpoints ?? {},
    conversations: {},
    bindings: {},
    messages: input.messages ?? {},
    readCursors: {},
    invocations: input.invocations ?? {},
    flights: input.flights ?? {},
    collaborationRecords: {},
  };
}

function createHarness(input: {
  snapshot?: RuntimeSnapshot;
  deliveries?: DeliveryIntent[];
  deliveryAttempts?: Record<string, DeliveryAttempt[]>;
  beforeConditionalUpdate?: () => void;
  beforeWrite?: () => void;
  invocation?: InvocationRequest;
  activeInvocationIds?: string[];
  now?: number;
  onTerminalFlight?: (input: {
    flight: FlightRecord;
    invocation?: InvocationRequest;
    previous: FlightRecord | undefined;
  }) => void | Promise<void>;
} = {}) {
  const snapshot = input.snapshot ?? testSnapshot({
    agents: { "agent-1": testAgent() },
    invocations: { "invocation-1": input.invocation ?? testInvocation() },
    flights: {},
  });
  const committedFlights: FlightRecord[] = [];
  const appliedEntries: unknown[] = [];
  const updatedDeliveries: Array<{
    deliveryId: string;
    status: DeliveryIntent["status"];
    metadata?: Record<string, unknown>;
    leaseOwner?: string | null;
    leaseExpiresAt?: number | null;
  }> = [];
  const promoted: Array<{ invocation: InvocationRequest; flight: FlightRecord; output: string | undefined }> = [];
  const forwardedFlights: FlightRecord[] = [];
  const warnings: string[] = [];
  const activeInvocationIds = new Set(input.activeInvocationIds ?? []);

  const service = new BrokerFlightLifecycleService({
    runtime: {
      snapshot: () => snapshot,
      async upsertFlight(flight) {
        snapshot.flights[flight.id] = flight;
        committedFlights.push(flight);
      },
    },
    journal: {
      visitDeliveries: async (visitor) => { for (const delivery of [...(input.deliveries ?? [])]) await visitor(delivery); },
      listDeliveryAttempts: (deliveryId) => input.deliveryAttempts?.[deliveryId] ?? [],
    },
    durableStore: {
      async runWrite(work) {
        input.beforeWrite?.();
        return await work();
      },
      async commitEntries(entries, applyRuntime) {
        const retainedEntries = Array.isArray(entries) ? entries : [entries];
        await applyRuntime(retainedEntries);
        return retainedEntries;
      },
      async applyProjectedEntries(entries) {
        appliedEntries.push(...(Array.isArray(entries) ? entries : [entries]));
      },
    },
    invocationFor: (invocationId) => input.invocation ?? snapshot.invocations[invocationId],
    async updateDeliveryStatus(update) {
      updatedDeliveries.push(update);
    },
    async updateDeliveryStatusIf(update, eligible) {
      input.beforeConditionalUpdate?.();
      const current = input.deliveries?.find(delivery => delivery.id === update.deliveryId);
      if (!current || !await eligible(current)) return false;
      updatedDeliveries.push(update);
      return true;
    },
    async promoteInvocationFlightToWork(invocation, flight, output) {
      promoted.push({ invocation, flight, output });
    },
    async maybeForwardFlightToAuthority(flight) {
      forwardedFlights.push(flight);
    },
    isInvocationActive: (invocationId) => activeInvocationIds.has(invocationId),
    onTerminalFlight: input.onTerminalFlight,
    warn: (message) => warnings.push(message),
    now: () => input.now ?? 10_000,
  });

  return {
    appliedEntries,
    committedFlights,
    forwardedFlights,
    promoted,
    service,
    snapshot,
    updatedDeliveries,
    warnings,
  };
}

describe("broker flight lifecycle helpers", () => {
  test("a caller eligibility guard runs inside the writer and suppresses all rejected-flight effects", async () => {
    let eligible = true;
    let observedInsideWriter = false;
    const harness = createHarness({ beforeWrite: () => { eligible = false; },
      onTerminalFlight: () => { throw new Error("rejected flight must not notify"); },
    });
    await harness.service.recordFlight(testFlight({ state: "completed", output: "old result" }), () => {
      observedInsideWriter = !eligible;
      return eligible;
    });
    expect(observedInsideWriter).toBe(true);
    expect(harness.committedFlights).toEqual([]);
    expect(harness.appliedEntries).toEqual([]);
    expect(harness.updatedDeliveries).toEqual([]);
    expect(harness.promoted).toEqual([]);
    expect(harness.forwardedFlights).toEqual([]);
  });

  test("delayed working metadata cannot erase or replace an authority-accepted reply", async () => {
    const acceptedReply = { version: 1, authorityNodeId: "peer", message: { id: "reply-original", body: "done" } };
    const running = testFlight({ metadata: { acceptedReply } });
    const harness = createHarness({ snapshot: testSnapshot({ flights: { [running.id]: running } }) });
    await harness.service.recordFlight({ ...running, metadata: { requesterTimedOut: true } });
    expect(harness.committedFlights.at(-1)?.metadata?.acceptedReply).toEqual(acceptedReply);
    await harness.service.recordFlight({ ...running, metadata: { requesterTimedOut: true, acceptedReply: { message: { id: "replacement" } } } });
    expect(harness.committedFlights).toHaveLength(1);
  });

  test("classifies terminal downgrades and delivery statuses", () => {
    expect(shouldIgnoreFlightUpdate(
      testFlight({ state: "completed" }),
      testFlight({ state: "running" }),
    )).toBe(true);
    expect(shouldIgnoreFlightUpdate(
      testFlight({ state: "running" }),
      testFlight({ state: "completed" }),
    )).toBe(false);
    expect(shouldIgnoreFlightUpdate(
      testFlight({
        summary: "Agent One is still working.",
        metadata: {
          requesterTimedOut: true,
          timeoutMs: 300_000,
          timeoutScope: "requester_wait",
          dispatchAck: { sessionId: "session-1", acknowledgedAt: 2_000 },
        },
      }),
      testFlight({
        summary: "Agent One acknowledged via attach.",
        metadata: {
          dispatchAck: { sessionId: "session-1", acknowledgedAt: 2_000 },
        },
      }),
    )).toBe(true);
    expect(shouldIgnoreFlightUpdate(
      testFlight({
        metadata: {
          requesterTimedOut: true,
          timeoutMs: 300_000,
          timeoutScope: "requester_wait",
          dispatchAck: { sessionId: "session-1", acknowledgedAt: 2_000 },
        },
      }),
      testFlight({
        metadata: {
          dispatchAck: { sessionId: "session-2", acknowledgedAt: 3_000 },
        },
      }),
    )).toBe(false);
    expect(isDuplicateFlightUpdate(
      testFlight({ metadata: { nested: { value: true } } }),
      testFlight({ metadata: { nested: { value: true } } }),
    )).toBe(true);
    expect(isDuplicateFlightUpdate(
      testFlight({ state: "running" }),
      testFlight({ state: "completed" }),
    )).toBe(false);

    expect(deliveryStatusForFlight(testFlight({ state: "running" }))).toBe("running");
    expect(deliveryStatusForFlight(testFlight({ state: "waiting" }))).toBe("running");
    expect(deliveryStatusForFlight(testFlight({ state: "completed" }))).toBe("completed");
    expect(deliveryStatusForFlight(testFlight({ state: "waking" }))).toBeNull();
  });

  test("ignores non-terminal updates after a terminal flight", async () => {
    const terminal = testFlight({ state: "completed", completedAt: 2_000 });
    const harness = createHarness({
      snapshot: testSnapshot({
        flights: { [terminal.id]: terminal },
      }),
    });

    await harness.service.recordFlight(testFlight({ state: "running" }));

    expect(harness.committedFlights).toEqual([]);
    expect(harness.appliedEntries).toEqual([]);
    expect(harness.warnings).toEqual([
      "[openscout-runtime] ignored stale flight update flight-1: completed -> running",
    ]);
  });

  test("late terminal metadata cannot erase a pending result or reopen a delivered result", async () => {
    for (const status of ["pending", "delivered"]) {
      const resultReply = { version: 1, status, message: { id: "reply-original", body: "complete output" } };
      const terminal = testFlight({ state: "completed", completedAt: 2_000, output: "complete output", metadata: { resultReply } });
      const harness = createHarness({ snapshot: testSnapshot({ flights: { [terminal.id]: terminal } }) });
      await harness.service.recordFlight({ ...terminal, metadata: { lateObservation: true, resultReply: { ...resultReply, status: status === "pending" ? "delivered" : "pending" } } });
      expect(harness.committedFlights.at(-1)?.metadata?.resultReply).toEqual(resultReply);
    }
  });

  test("late terminal outcomes cannot replace captured output or cancellation", async () => {
    for (const state of ["completed", "failed", "cancelled"] as const) {
      const terminal = testFlight({ state, output: "preserved context", completedAt: 2_000 });
      const harness = createHarness({ snapshot: testSnapshot({ flights: { [terminal.id]: terminal } }) });
      await harness.service.recordFlight({ ...terminal, state: state === "failed" ? "completed" : "failed", error: "late failure" });
      await harness.service.recordFlight({ ...terminal, output: "stale result" });
      await harness.service.recordFlight({ ...terminal, completedAt: 1_000 });
      expect(harness.committedFlights).toEqual([]);
      expect(harness.forwardedFlights).toEqual([]);
      expect(harness.promoted).toEqual([]);
    }
  });

  test("ignores identical flight updates without persisting or forwarding them", async () => {
    const running = testFlight({
      summary: "Still running.",
      metadata: { source: "peer" },
    });
    const harness = createHarness({
      snapshot: testSnapshot({
        flights: { [running.id]: running },
      }),
    });

    await harness.service.recordFlight(structuredClone(running));

    expect(harness.committedFlights).toEqual([]);
    expect(harness.appliedEntries).toEqual([]);
    expect(harness.updatedDeliveries).toEqual([]);
    expect(harness.promoted).toEqual([]);
    expect(harness.forwardedFlights).toEqual([]);
    expect(harness.warnings).toEqual([]);
  });

  test("ignores a late dispatch acknowledgement after requester wait timed out", async () => {
    const timedOut = testFlight({
      summary: "Agent One is still working.",
      metadata: {
        requesterTimedOut: true,
        timeoutMs: 300_000,
        timeoutScope: "requester_wait",
        dispatchAck: { sessionId: "session-1", acknowledgedAt: 2_000 },
      },
    });
    const harness = createHarness({
      snapshot: testSnapshot({ flights: { [timedOut.id]: timedOut } }),
    });

    await harness.service.recordFlight(testFlight({
      summary: "Agent One acknowledged via attach.",
      metadata: {
        dispatchAck: { sessionId: "session-1", acknowledgedAt: 2_000 },
      },
    }));

    expect(harness.committedFlights).toEqual([]);
    expect(harness.appliedEntries).toEqual([]);
    expect(harness.forwardedFlights).toEqual([]);
    expect(harness.warnings).toEqual([
      "[openscout-runtime] ignored stale flight update flight-1: running -> running",
    ]);
  });

  test("records terminal flights, updates deliveries, promotes work, and forwards", async () => {
    const invocation = testInvocation();
    const delivery = testDelivery({ status: "running" });
    const completed = testFlight({
      state: "completed",
      completedAt: 4_000,
      output: "done",
    });
    const terminalCallbacks: Array<{ flightId: string; invocationId?: string }> = [];
    const harness = createHarness({
      invocation,
      deliveries: [
        delivery,
        testDelivery({ id: "terminal-delivery", status: "failed" }),
      ],
      now: 20_000,
      onTerminalFlight: async ({ flight, invocation: inv }) => {
        terminalCallbacks.push({
          flightId: flight.id,
          invocationId: inv?.id,
        });
      },
    });

    await harness.service.recordFlight(completed);

    expect(harness.committedFlights).toEqual([completed]);
    expect(harness.appliedEntries).toEqual([{ kind: "flight.record", flight: completed }]);
    expect(harness.updatedDeliveries).toEqual([
      {
        deliveryId: "delivery-1",
        status: "completed",
        metadata: {
          invocationId: "invocation-1",
          flightId: "flight-1",
          flightState: "completed",
          flightStatusUpdatedAt: 4_000,
        },
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    ]);
    expect(harness.promoted).toEqual([{ invocation, flight: completed, output: "done" }]);
    expect(harness.forwardedFlights).toEqual([completed]);
    expect(terminalCallbacks).toEqual([
      { flightId: "flight-1", invocationId: "invocation-1" },
    ]);
  });

  test("turns completed consult flights without visible output into failures", async () => {
    const invocation = testInvocation({ action: "consult" });
    const delivery = testDelivery({ status: "running" });
    const completed = testFlight({
      state: "completed",
      completedAt: 4_000,
      output: "",
    });
    const harness = createHarness({
      invocation,
      deliveries: [delivery],
      now: 20_000,
    });

    await harness.service.recordFlight(completed);

    expect(harness.committedFlights).toEqual([
      expect.objectContaining({
        id: "flight-1",
        state: "failed",
        completedAt: 4_000,
        error: "Consult flight flight-1 completed without broker-visible output.",
        metadata: expect.objectContaining({
          failureStage: "empty_completed_output",
        }),
      }),
    ]);
    expect(harness.updatedDeliveries).toEqual([
      expect.objectContaining({
        deliveryId: "delivery-1",
        status: "failed",
        metadata: expect.objectContaining({
          flightState: "failed",
          failureDetail: "Consult flight flight-1 completed without broker-visible output.",
        }),
      }),
    ]);
    expect(harness.promoted).toEqual([
      expect.objectContaining({
        invocation,
        output: "Consult flight flight-1 completed without broker-visible output.",
      }),
    ]);
  });

  test("fails deliveries when every local endpoint for the target is stale", async () => {
    const endpoint = testEndpoint();
    const delivery = testDelivery({ status: "pending" });
    const snapshot = testSnapshot({
      agents: { "agent-1": testAgent() },
      endpoints: { [endpoint.id]: endpoint },
    });
    const harness = createHarness({
      snapshot,
      deliveries: [delivery],
      now: 30_000,
    });

    expect(staleLocalDeliveryReason(snapshot, delivery)).toContain("superseded local registration");

    await harness.service.reconcileStaleLocalDeliveries();

    expect(harness.updatedDeliveries).toEqual([
      expect.objectContaining({
        deliveryId: "delivery-1",
        status: "failed",
        leaseOwner: null,
        leaseExpiresAt: null,
        metadata: expect.objectContaining({
          failureReason: "agent_offline",
          staleLocalRegistration: true,
          reconciledStaleDelivery: true,
          reconciledAt: 30_000,
        }),
      }),
    ]);
  });

  test("does not fail a new delivery while its wake-on-demand endpoint is starting", async () => {
    const endpoint = testEndpoint({
      metadata: {},
      state: "offline",
    });
    const now = 30_000;
    const delivery = testDelivery({
      invocationId: undefined,
    });
    const snapshot = testSnapshot({
      agents: { "agent-1": testAgent() },
      endpoints: { [endpoint.id]: endpoint },
      messages: { "message-1": testMessage({ createdAt: now - 50 }) },
    });
    const harness = createHarness({
      snapshot,
      deliveries: [delivery],
      now,
    });

    expect(staleLocalDeliveryReason(snapshot, delivery, { now })).toBeNull();
    expect(staleLocalDeliveryReason(snapshot, delivery, {
      now: now + STALE_LOCAL_DELIVERY_GRACE_MS,
    })).toBe("endpoint endpoint-1 is offline");

    await harness.service.reconcileStaleLocalDeliveries();
    expect(harness.updatedDeliveries).toEqual([]);
  });

  test("uses the fresh invocation age when an old message is dispatched again", () => {
    const endpoint = testEndpoint({ metadata: {}, state: "offline" });
    const now = 500_000;
    const delivery = testDelivery();
    const snapshot = testSnapshot({
      agents: { "agent-1": testAgent() },
      endpoints: { [endpoint.id]: endpoint },
      messages: {
        "message-1": testMessage({ createdAt: now - STALE_LOCAL_DELIVERY_GRACE_MS - 1 }),
      },
      invocations: {
        "invocation-1": testInvocation({ createdAt: now - 50 }),
      },
    });

    expect(staleLocalDeliveryReason(snapshot, delivery, { now })).toBeNull();
    expect(staleLocalDeliveryReason(snapshot, delivery, {
      now: now + STALE_LOCAL_DELIVERY_GRACE_MS,
    })).toBe("endpoint endpoint-1 is offline");
  });

  test("uses the latest delivery attempt when source records are absent from the snapshot", async () => {
    const endpoint = testEndpoint({ metadata: {}, state: "offline" });
    const now = 600_000;
    const delivery = testDelivery({ messageId: undefined, invocationId: undefined });
    const attempt = testDeliveryAttempt({ createdAt: now - 50 });
    const snapshot = testSnapshot({
      agents: { "agent-1": testAgent() },
      endpoints: { [endpoint.id]: endpoint },
    });
    const harness = createHarness({
      snapshot,
      deliveries: [delivery],
      deliveryAttempts: { [delivery.id]: [attempt] },
      now,
    });

    expect(staleLocalDeliveryReason(snapshot, delivery, {
      now,
      latestAttemptAt: attempt.createdAt,
    })).toBeNull();
    await harness.service.reconcileStaleLocalDeliveries();
    expect(harness.updatedDeliveries).toEqual([]);
  });

  test("a running flight recovers a delivery falsely failed by stale reconciliation", async () => {
    const delivery = testDelivery({
      status: "failed",
      metadata: {
        failureReason: "agent_offline",
        reconciledStaleDelivery: true,
      },
    });
    const invocation = testInvocation();
    const harness = createHarness({
      deliveries: [delivery],
      invocation,
      now: 40_000,
    });

    await harness.service.recordFlight(testFlight({ state: "running" }));

    expect(harness.updatedDeliveries).toEqual([
      expect.objectContaining({
        deliveryId: "delivery-1",
        status: "running",
        metadata: expect.objectContaining({
          failureReason: null,
          failureDetail: null,
          recoveredFromStaleReconciliation: true,
        }),
      }),
    ]);
  });

  test("fails deliveries when every local endpoint for the target is offline", async () => {
    const endpoint = testEndpoint({
      metadata: {},
      state: "offline",
    });
    const delivery = testDelivery({ status: "pending" });
    const snapshot = testSnapshot({
      agents: { "agent-1": testAgent() },
      endpoints: { [endpoint.id]: endpoint },
    });
    const harness = createHarness({
      snapshot,
      deliveries: [delivery],
      now: 40_000,
    });

    expect(staleLocalDeliveryReason(snapshot, delivery)).toBe("endpoint endpoint-1 is offline");

    await harness.service.reconcileStaleLocalDeliveries();

    expect(harness.updatedDeliveries).toEqual([
      expect.objectContaining({
        deliveryId: "delivery-1",
        status: "failed",
        metadata: expect.objectContaining({
          failureReason: "agent_offline",
          failureDetail: "Stale local delivery reconciled: endpoint endpoint-1 is offline",
          reconciledStaleDelivery: true,
          reconciledAt: 40_000,
        }),
      }),
    ]);
  });

  test("fails endpointless working flights after the recovery grace window", async () => {
    const flight = testFlight({
      state: "waking",
      startedAt: 10_000,
    });
    const invocation = testInvocation();
    const harness = createHarness({
      snapshot: testSnapshot({
        agents: { "agent-1": testAgent() },
        endpoints: {},
        invocations: { [invocation.id]: invocation },
        flights: { [flight.id]: flight },
      }),
      invocation,
      now: 10_000 + 2 * 60_000,
    });

    await harness.service.reconcileStaleWorkingFlights();

    expect(harness.committedFlights).toEqual([
      expect.objectContaining({
        id: "flight-1",
        state: "failed",
        summary: "Agent One did not finish cleanly.",
        error: "Stale running flight reconciled: target agent agent-1 has no registered endpoint after 120s",
        completedAt: 130_000,
        metadata: expect.objectContaining({
          reconciledStaleFlight: true,
          reconciledReason: "target agent agent-1 has no registered endpoint after 120s",
          reconciledAt: 130_000,
        }),
      }),
    ]);
    expect(harness.promoted).toHaveLength(1);
    expect(harness.forwardedFlights).toHaveLength(1);
  });
});


describe("stale reconciliation writer eligibility", () => {
  for (const status of ["leased", "completed"] as const) {
    test(`preserves a concurrent ${status} replacement`, async () => {
      const endpoint = testEndpoint();
      const delivery = testDelivery({ status: "pending" });
      const deliveries = [delivery];
      const harness = createHarness({
        snapshot: testSnapshot({ agents: { "agent-1": testAgent() }, endpoints: { [endpoint.id]: endpoint } }),
        deliveries, now: 30_000,
        beforeConditionalUpdate: () => { deliveries[0] = { ...delivery, status, leaseOwner: "worker", leaseExpiresAt: 90_000 }; },
      });
      await harness.service.reconcileStaleLocalDeliveries();
      expect(harness.updatedDeliveries).toEqual([]);
      expect(deliveries[0]!.status).toBe(status);
      expect(harness.warnings).toEqual([]);
    });
  }
  test("leaves an existing unexpired lease intact", async () => {
    const endpoint = testEndpoint();
    const harness = createHarness({
      snapshot: testSnapshot({ agents: { "agent-1": testAgent() }, endpoints: { [endpoint.id]: endpoint } }),
      deliveries: [testDelivery({ status: "leased", leaseOwner: "worker", leaseExpiresAt: 90_000 })], now: 30_000,
    });
    await harness.service.reconcileStaleLocalDeliveries();
    expect(harness.updatedDeliveries).toEqual([]);
    expect(harness.warnings).toEqual([]);
  });
});


test("external provider receipts are not projected to running/completed by local flight state", async () => {
  const delivery = testDelivery({ transport: "http", status: "acknowledged", metadata: { externalSession: true, phase: "provider_accepted" } });
  const harness = createHarness({ deliveries: [delivery] });
  await harness.service.recordFlight(testFlight({ state: "waiting" }));
  await harness.service.recordFlight(testFlight({ state: "completed", output: "done" }));
  expect(harness.updatedDeliveries).toEqual([]);
  expect(staleLocalDeliveryReason(harness.snapshot, delivery, { now: 1_000_000 })).toBeNull();
});
