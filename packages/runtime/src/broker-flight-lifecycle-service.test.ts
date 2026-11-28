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
  bootedAt?: number;
  localNodeId?: string;
  sessionActivity?: Map<string, number>;
  deadAfterMs?: number | null;
  onTerminalFlight?: (input: {
    flight: FlightRecord;
    invocation?: InvocationRequest;
    previous: FlightRecord | undefined;
  }) => void | Promise<void>;
  prepareTerminalReport?: (flight: FlightRecord, invocation?: InvocationRequest) => FlightRecord;
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
    bootedAt: input.bootedAt,
    localNodeId: () => input.localNodeId,
    sessionActivity: () => input.sessionActivity ?? new Map(),
    ...(input.deadAfterMs !== undefined ? { deadlines: { deadAfterMs: input.deadAfterMs } } : {}),
    onTerminalFlight: input.onTerminalFlight,
    prepareTerminalReport: input.prepareTerminalReport,
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
        summary: "Agent One didn't finish.",
        error: "Didn't finish: target agent agent-1 has no registered endpoint after 120s",
        completedAt: 130_000,
        metadata: expect.objectContaining({
          outcome: "dead",
          deathCause: "session_gone",
          declaredDeadAt: 130_000,
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

describe("flights superseded by a finished twin", () => {
  // An ask that starts its target elsewhere records a placeholder flight with
  // no dispatch, then the flight that carries the work, ~100ms later.
  const placeholder = testFlight({
    id: "placeholder",
    state: "waking",
    startedAt: 1_000,
    summary: "Agent One waking.",
    metadata: { dispatchOutcome: { status: "not_submitted", checkedAt: 1_000 } },
  });

  function twinHarness(flights: FlightRecord[], extra: Parameters<typeof createHarness>[0] = {}) {
    const terminalCallbacks: string[] = [];
    const reports: string[] = [];
    const harness = createHarness({
      snapshot: testSnapshot({
        agents: { "agent-1": testAgent() },
        invocations: { "invocation-1": testInvocation() },
        flights: Object.fromEntries(flights.map((flight) => [flight.id, flight])),
      }),
      now: 50_000,
      onTerminalFlight: ({ flight }) => { terminalCallbacks.push(flight.id); },
      prepareTerminalReport: (flight) => {
        if (flight.state === "completed") return flight;
        reports.push(flight.id);
        return { ...flight, metadata: { ...flight.metadata, terminalReport: { version: 1, status: "pending" } } };
      },
      ...extra,
    });
    return { ...harness, terminalCallbacks, reports };
  }

  test("reconciliation closes a placeholder with the outcome its twin reported, and repeats none of its effects", async () => {
    const twin = testFlight({ id: "twin", state: "completed", startedAt: 1_100, completedAt: 9_000, output: "done", summary: "Done." });
    const harness = twinHarness([placeholder, twin]);

    await harness.service.reconcileStaleWorkingFlights();

    expect(harness.snapshot.flights.placeholder).toEqual(expect.objectContaining({
      state: "completed",
      output: "done",
      summary: "Done.",
      completedAt: 9_000,
      metadata: expect.objectContaining({ supersededByFlightId: "twin", reconciledStaleFlight: true }),
    }));
    expect(harness.snapshot.flights.placeholder.metadata?.workPromotion).toBeUndefined();
    expect(harness.promoted).toEqual([]);
    expect(harness.forwardedFlights).toEqual([]);
    expect(harness.terminalCallbacks).toEqual([]);
  });

  test("a failed twin closes its placeholder as failed without a second failure report", async () => {
    const twin = testFlight({ id: "twin", state: "failed", startedAt: 1_100, completedAt: 9_000, error: "boom" });
    const harness = twinHarness([placeholder, twin]);

    await harness.service.reconcileStaleWorkingFlights();

    expect(harness.snapshot.flights.placeholder).toEqual(expect.objectContaining({ state: "failed", error: "boom" }));
    expect(harness.snapshot.flights.placeholder.metadata?.terminalReport).toBeUndefined();
    expect(harness.reports).toEqual([]);
  });

  test("the twin finishing closes its placeholder as it is recorded, and its own effects run once", async () => {
    const running = testFlight({ id: "twin", state: "running", startedAt: 1_100 });
    const harness = twinHarness([placeholder, running]);

    await harness.service.recordFlight({ ...running, state: "completed", completedAt: 9_000, output: "done" });

    expect(harness.snapshot.flights.placeholder).toEqual(expect.objectContaining({
      state: "completed",
      metadata: expect.objectContaining({ supersededByFlightId: "twin" }),
    }));
    expect(harness.promoted.map((entry) => entry.flight.id)).toEqual(["twin"]);
    expect(harness.forwardedFlights.map((flight) => flight.id)).toEqual(["twin"]);
    expect(harness.terminalCallbacks).toEqual(["twin"]);
  });

  test("a late result from an older attempt never closes a newer attempt that is still running", async () => {
    const older = testFlight({ id: "older", state: "running", startedAt: 500 });
    const newer = testFlight({ id: "newer", state: "running", startedAt: 1_000 });
    const harness = twinHarness([older, newer], { activeInvocationIds: [] });

    await harness.service.recordFlight({ ...older, state: "failed", completedAt: 9_000, error: "late" });

    expect(harness.snapshot.flights.newer.state).toBe("running");
  });

  test("a twin that started on another host's earlier clock still closes the undispatched placeholder", async () => {
    const twin = testFlight({ id: "twin", state: "completed", startedAt: 400, completedAt: 9_000, output: "done",
      metadata: { dispatchAck: { endpointId: "endpoint-remote" } } });
    const harness = twinHarness([placeholder, twin]);

    await harness.service.reconcileStaleWorkingFlights();

    expect(harness.snapshot.flights.placeholder).toEqual(expect.objectContaining({
      state: "completed",
      metadata: expect.objectContaining({ supersededByFlightId: "twin" }),
    }));
  });

  test("an earlier-started finished flight never closes a dispatched flight", async () => {
    const dispatched = testFlight({ id: "dispatched", state: "running", startedAt: 1_000,
      metadata: { dispatchAck: { endpointId: "endpoint-1" } } });
    const older = testFlight({ id: "older", state: "failed", startedAt: 400, completedAt: 9_000, error: "late" });
    const harness = twinHarness([dispatched, older]);

    await harness.service.reconcileStaleWorkingFlights();

    // Stale-endpoint reconciliation may still close it, but never as a copy of the older flight.
    expect(harness.snapshot.flights.dispatched.metadata?.supersededByFlightId).toBeUndefined();
  });

  test("reconciliation logs a closed placeholder only when it records one", async () => {
    const twin = testFlight({ id: "twin", state: "completed", startedAt: 1_100, completedAt: 9_000, output: "done" });
    // A flight held for a specific final reply refuses the copy, so nothing is written.
    const held = { ...placeholder, metadata: { ...placeholder.metadata, taskFinalReplyMessageId: "reply-1" } };
    const harness = twinHarness([held, twin]);

    await harness.service.reconcileStaleWorkingFlights();
    await harness.service.reconcileStaleWorkingFlights();

    expect(harness.snapshot.flights.placeholder.state).toBe("waking");
    expect(harness.warnings.filter((line) => line.includes("closed flight placeholder"))).toEqual([]);
  });

  test("a placeholder whose invocation is still running locally stays open", async () => {
    const twin = testFlight({ id: "twin", state: "completed", startedAt: 1_100, completedAt: 9_000, output: "done" });
    const harness = twinHarness([placeholder, twin], { activeInvocationIds: ["invocation-1"] });

    await harness.service.reconcileStaleWorkingFlights();

    expect(harness.snapshot.flights.placeholder.state).toBe("waking");
  });
});

test("a session that finished a later turn closes the earlier one with a typed cause and the later flight", async () => {
  const ack = { endpointId: "endpoint-1", nodeId: "node-1", harness: "codex", sessionId: "one-session" };
  const endpoint = testEndpoint({ state: "active" });
  const older = testFlight({ state: "running", startedAt: 10, metadata: { dispatchAck: { ...ack, acknowledgedAt: 10 } } });
  const newer = testFlight({ id: "newer", invocationId: "newer-ask", startedAt: 20, completedAt: 30, state: "completed", output: "Done", metadata: { dispatchAck: { ...ack, acknowledgedAt: 20 } } });
  const h = createHarness({ snapshot: testSnapshot({ endpoints: { [endpoint.id]: endpoint }, flights: { older, newer } }), now: 40 });
  await h.service.reconcileStaleWorkingFlights();
  expect(h.committedFlights[0]).toMatchObject({ state: "failed", metadata: { outcome: "dead", deathCause: "session_moved_on", movedOnToFlightId: "newer" } });
});


test.each([
  { status: "submission_unknown", reason: "codex_send_boundary", turnId: undefined, state: "waiting" },
  { status: "submitted", reason: "codex_rpc_acknowledged", turnId: "turn-original", state: "waiting" },
  { status: "not_submitted", reason: "before_codex_send", turnId: undefined, state: "failed" },
])("restart reconciles Codex dispatch evidence ($reason) without adopting a neighboring reply", async ({ status, reason, turnId, state }) => {
  const ack = { endpointId: "endpoint-1", transport: "codex_app_server", sessionId: "native-thread" };
  const flight = testFlight({ metadata: {
    dispatchAck: { ...ack, ...(turnId ? { nativeTurnId: turnId } : {}) },
    dispatchOutcome: { status, reason, method: "turn/start", checkedAt: 1_100 },
  } });
  const neighbor = testFlight({
    id: "neighbor", invocationId: "other-ask", startedAt: 1_200, completedAt: 1_300,
    state: "completed", output: "Answer to another ask.", metadata: { dispatchAck: ack },
  });
  const h = createHarness({
    bootedAt: 2_000,
    snapshot: testSnapshot({ flights: { [flight.id]: flight, [neighbor.id]: neighbor } }),
  });

  await h.service.reconcileStaleWorkingFlights();
  await h.service.reconcileStaleWorkingFlights();

  const current = h.snapshot.flights[flight.id];
  expect(current.state).toBe(state);
  expect(current.invocationId).toBe(flight.invocationId);
  expect(current.output).toBeUndefined();
  if (state === "waiting") {
    expect(current.completedAt).toBeUndefined();
    expect(current.summary).toContain("Inspect Codex session native-thread.");
    expect(current.metadata).toEqual(flight.metadata);
    expect(h.committedFlights).toHaveLength(1);
  }
});

describe("flight supervisor", () => {
  const ack = { endpointId: "endpoint-1", nodeId: "node-1", harness: "claude", transport: "tmux", sessionId: "native-1" };

  test("a node never closes a flight another node owns", async () => {
    // The endpoint is unknown here, which would close a local flight.
    const remote = testFlight({ state: "running", startedAt: 10, metadata: { dispatchAck: { ...ack, nodeId: "arts-mini", acknowledgedAt: 10 } } });
    const h = createHarness({ snapshot: testSnapshot({ flights: { [remote.id]: remote } }), localNodeId: "air", now: 10_000_000 });
    await h.service.superviseFlights();
    expect(h.committedFlights).toEqual([]);
    expect(h.service.isMirroredFlight(remote)).toBe(true);
  });

  test("an older flight closed late does not end live work on the same session (2026-11-28)", async () => {
    const endpoint = testEndpoint({ state: "active", metadata: {} });
    // A: dispatched first, closed by the supervisor long after B started.
    const closedLate = testFlight({
      id: "a", invocationId: "a-ask", state: "failed", startedAt: 100, completedAt: 9_000,
      metadata: { dispatchAck: { ...ack, acknowledgedAt: 100 }, outcome: "dead", deathCause: "session_gone", declaredDeadAt: 9_000 },
    });
    const live = testFlight({ id: "b", invocationId: "b-ask", state: "running", startedAt: 200, metadata: { dispatchAck: { ...ack, acknowledgedAt: 200 } } });
    const h = createHarness({
      snapshot: testSnapshot({ endpoints: { [endpoint.id]: endpoint }, flights: { a: closedLate, b: live } }),
      localNodeId: "node-1", activeInvocationIds: [], now: 9_500, sessionActivity: new Map([["native-1", 9_400]]),
    });
    await h.service.superviseFlights();
    expect(h.snapshot.flights.b.error ?? null).toBeNull();
    expect(h.snapshot.flights.b.state).toBe("running");
  });

  test("a late finish corrects a dead flight", async () => {
    const dead = testFlight({
      state: "failed", startedAt: 100, completedAt: 5_000, error: "Didn't finish: gone",
      metadata: { outcome: "dead", deathCause: "session_gone", declaredDeadAt: 5_000, reconciledReason: "gone" },
    });
    const invocation = testInvocation();
    const h = createHarness({ snapshot: testSnapshot({ invocations: { [invocation.id]: invocation }, flights: { [dead.id]: dead } }), now: 6_000 });
    await h.service.recordFlight({ ...dead, state: "completed", output: "Done", error: undefined });
    const corrected = h.snapshot.flights[dead.id];
    expect(corrected.state).toBe("completed");
    expect(corrected.output).toBe("Done");
    expect(corrected.completedAt).toBe(6_000);
    expect(corrected.metadata).toMatchObject({ correctedFrom: "dead", correctedAt: 6_000 });
    expect(corrected.metadata?.outcome).toBeUndefined();
    expect(h.promoted.map((entry) => entry.flight.state)).toEqual(["completed"]);
  });

  test("finished outcomes never change", async () => {
    const failed = testFlight({ state: "failed", completedAt: 5_000, error: "harness error" });
    const h = createHarness({ snapshot: testSnapshot({ flights: { [failed.id]: failed } }), now: 6_000 });
    await h.service.recordFlight({ ...failed, state: "completed", output: "Done", error: undefined });
    expect(h.snapshot.flights[failed.id].state).toBe("failed");
  });

  test("liveness moves active, idle, stalled on evidence, with one write per level", async () => {
    const endpoint = testEndpoint({ state: "active", metadata: { lastInvocationId: "invocation-1", lastStartedAt: 1_000 } });
    const running = testFlight({ state: "running", startedAt: 1_000, metadata: { dispatchAck: { ...ack, acknowledgedAt: 1_000 } } });
    const activity = new Map([["native-1", 1_000]]);
    const at = (now: number) => createHarness({
      snapshot: testSnapshot({ endpoints: { [endpoint.id]: endpoint }, flights: { [running.id]: structuredClone(running) } }),
      localNodeId: "node-1", activeInvocationIds: ["invocation-1"], now, sessionActivity: activity,
    });
    const idle = at(1_000 + 3 * 60_000);
    await idle.service.superviseFlights();
    await idle.service.superviseFlights();
    expect(idle.committedFlights.map((flight) => flight.metadata?.liveness)).toEqual(["idle"]);
    const stalled = at(1_000 + 11 * 60_000);
    await stalled.service.superviseFlights();
    expect(stalled.snapshot.flights[running.id].metadata?.liveness).toBe("stalled");
    // Silence alone never ends it.
    expect(stalled.snapshot.flights[running.id].state).toBe("running");
  });

  test("silence ends a flight only when deadAfter is configured", async () => {
    const endpoint = testEndpoint({ state: "active", metadata: { lastInvocationId: "invocation-1", lastStartedAt: 1_000 } });
    const running = testFlight({ state: "running", startedAt: 1_000, metadata: { dispatchAck: { ...ack, acknowledgedAt: 1_000 } } });
    const h = createHarness({
      snapshot: testSnapshot({ endpoints: { [endpoint.id]: endpoint }, flights: { [running.id]: running } }),
      localNodeId: "node-1", now: 1_000 + 61 * 60_000, deadAfterMs: 60 * 60_000,
    });
    await h.service.superviseFlights();
    expect(h.snapshot.flights[running.id].metadata).toMatchObject({ outcome: "dead", deathCause: "no_progress" });
  });

  test("a waiting flight has no deadlines", async () => {
    const endpoint = testEndpoint({ state: "active", metadata: {} });
    const waiting = testFlight({ state: "waiting", startedAt: 1_000, metadata: { dispatchAck: { ...ack, acknowledgedAt: 1_000 } } });
    const h = createHarness({
      snapshot: testSnapshot({ endpoints: { [endpoint.id]: endpoint }, flights: { [waiting.id]: waiting } }),
      localNodeId: "node-1", activeInvocationIds: ["invocation-1"], now: 1_000 + 24 * 60 * 60_000, deadAfterMs: 60_000,
    });
    await h.service.superviseFlights();
    expect(h.committedFlights).toEqual([]);
  });
});
