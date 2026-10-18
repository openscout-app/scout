import { describe, expect, test } from "bun:test";

import type {
  CollaborationRecord,
  FlightRecord,
  InvocationRequest,
  ScoutDeliverRequest,
} from "@openscout/protocol";

import { createInMemoryControlRuntime } from "./broker.js";
import type { BrokerJournalEntry } from "./broker-journal.js";
import { BrokerDurableStore } from "./broker-durable-store.js";
import { BrokerWorkItemStore } from "./broker-work-item-store.js";

function testPayload(input: Partial<ScoutDeliverRequest> = {}): ScoutDeliverRequest {
  return {
    id: "deliver-1",
    body: "please do the thing",
    intent: "consult",
    targetAgentId: "agent-1",
    labels: [" team ", "team", "ops"],
    messageMetadata: { source: "message-source" },
    invocationMetadata: { source: "invocation-source" },
    workItem: {
      id: "work-1",
      title: " Ship the broker split ",
      summary: "Keep behavior stable",
      priority: "high",
      labels: ["ops", "runtime"],
      metadata: { nested: { beta: 2, alpha: 1 } },
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
    task: "do it",
    collaborationRecordId: "work-1",
    conversationId: "conversation-1",
    messageId: "message-1",
    ensureAwake: true,
    stream: false,
    createdAt: 100,
    ...input,
  };
}

function testFlight(input: Partial<FlightRecord> = {}): FlightRecord {
  return {
    id: "flight-1",
    invocationId: "invocation-1",
    requesterId: "operator",
    targetAgentId: "agent-1",
    state: "completed",
    startedAt: 100,
    completedAt: 200,
    output: "done",
    ...input,
  };
}

function createStore() {
  const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });
  const appended: BrokerJournalEntry[][] = [];
  const projected: BrokerJournalEntry[][] = [];
  let id = 0;
  const durableStore = new BrokerDurableStore({
    journal: {
      async appendEntries(entries) {
        appended.push(entries);
        return entries;
      },
    },
    projection: {
      async applyEntries(entries) {
        projected.push(entries);
        return [];
      },
    },
    threadEvents: {
      publish() {},
    },
  });
  const store = new BrokerWorkItemStore({
    runtime,
    durableStore,
    createId(prefix) {
      id += 1;
      return `${prefix}-${id}`;
    },
  });

  return {
    runtime,
    appended,
    projected,
    store,
    durableStore,
    async promote(invocation: InvocationRequest, flight: FlightRecord, output: string | undefined) {
      const prepared = store.prepareTerminalWorkPromotion(flight, invocation);
      await runtime.upsertFlight(prepared);
      await store.promoteInvocationFlightToWork(invocation, prepared, output);
    },
  };
}

describe("BrokerWorkItemStore", () => {
  test("records delivery work items and created events in one durable commit", async () => {
    const { runtime, appended, projected, store, durableStore, promote } = createStore();

    const result = await store.recordDeliveryWorkItemIfNeeded({
      payload: testPayload(),
      requestId: "deliver-1",
      requesterId: "operator",
      targetAgentId: "agent-1",
      conversationId: "conversation-1",
      createdAt: 100,
    });

    expect(result.collaborationRecordId).toBe("work-1");
    expect(result.record).toEqual(expect.objectContaining({
      id: "work-1",
      kind: "work_item",
      state: "working",
      title: "Ship the broker split",
      ownerId: "agent-1",
      nextMoveOwnerId: "agent-1",
      labels: ["team", "ops", "runtime"],
      metadata: expect.objectContaining({
        source: "invocation-source",
        deliveryRequestId: "deliver-1",
      }),
    }));
    expect(appended[0]?.map((entry) => entry.kind)).toEqual([
      "collaboration.record",
      "collaboration.event.record",
    ]);
    await durableStore.flushProjectedEntries();
    expect(projected[0]).toEqual(appended[0]);
    expect(runtime.collaborationRecord("work-1")).toEqual(expect.objectContaining({
      id: "work-1",
      state: "working",
    }));
  });

  test("reuses an existing matching delivery work item without appending another event", async () => {
    const { appended, store } = createStore();
    const input = {
      payload: testPayload(),
      requestId: "deliver-1",
      requesterId: "operator",
      targetAgentId: "agent-1",
      conversationId: "conversation-1",
      createdAt: 100,
    };

    const first = await store.recordDeliveryWorkItemIfNeeded(input);
    const second = await store.recordDeliveryWorkItemIfNeeded(input);

    expect(first.collaborationRecordId).toBe("work-1");
    expect(second.collaborationRecordId).toBe("work-1");
    expect(second.record).toEqual(first.record);
    expect(appended).toHaveLength(1);
  });

  test("does not overwrite an existing work item with conflicting delivery metadata", async () => {
    const { runtime, appended, store } = createStore();
    const existing: CollaborationRecord = {
      id: "work-1",
      kind: "work_item",
      state: "working",
      acceptanceState: "pending",
      title: "Different title",
      createdById: "operator",
      ownerId: "agent-1",
      nextMoveOwnerId: "agent-1",
      conversationId: "conversation-1",
      createdAt: 100,
      updatedAt: 100,
      requestedById: "operator",
      startedAt: 100,
      metadata: {
        source: "invocation-source",
        deliveryRequestId: "deliver-1",
      },
    };
    await runtime.upsertCollaboration(existing);

    const result = await store.recordDeliveryWorkItemIfNeeded({
      payload: testPayload(),
      requestId: "deliver-1",
      requesterId: "operator",
      targetAgentId: "agent-1",
      conversationId: "conversation-1",
      createdAt: 100,
    });

    expect(result).toEqual({ record: null });
    expect(appended).toEqual([]);
    expect(runtime.collaborationRecord("work-1")).toEqual(existing);
  });

  test("moves requested work to review when its invocation completes", async () => {
    const { runtime, appended, projected, store, durableStore, promote } = createStore();
    await store.recordDeliveryWorkItemIfNeeded({
      payload: testPayload(),
      requestId: "deliver-1",
      requesterId: "operator",
      targetAgentId: "agent-1",
      conversationId: "conversation-1",
      createdAt: 100,
    });

    await promote(
      testInvocation(),
      testFlight({ output: "All broker tests stayed green." }),
      "All broker tests stayed green.",
    );

    const updated = runtime.collaborationRecord("work-1");
    expect(updated).toEqual(expect.objectContaining({
      id: "work-1",
      state: "review",
      acceptanceState: "pending",
      nextMoveOwnerId: "operator",
      reviewRequestedAt: 200,
      progress: expect.objectContaining({
        summary: "All broker tests stayed green.",
        completedSteps: 1,
        totalSteps: 1,
      }),
      metadata: expect.objectContaining({
        lastInvocationId: "invocation-1",
        lastFlightId: "flight-1",
        lastFlightState: "completed",
      }),
    }));
    expect(appended[1]?.map((entry) => entry.kind)).toEqual([
      "collaboration.record",
      "collaboration.event.record",
      "flight.record",
    ]);
    expect(appended[1]?.[1]).toEqual(expect.objectContaining({
      kind: "collaboration.event.record",
      event: expect.objectContaining({
        kind: "review_requested",
        actorId: "agent-1",
        summary: "All broker tests stayed green.",
      }),
    }));
    await durableStore.flushProjectedEntries();
    expect(projected[1]).toEqual(appended[1]);
  });

  test("completes self-driven work that does not require acceptance", async () => {
    const { runtime, store, promote } = createStore();
    await store.recordDeliveryWorkItemIfNeeded({
      payload: testPayload({
        workItem: {
          id: "work-1",
          title: "Run routine maintenance",
          acceptanceState: "none",
        },
      }),
      requestId: "deliver-1",
      requesterId: "agent-1",
      targetAgentId: "agent-1",
      conversationId: "conversation-1",
      createdAt: 100,
    });

    await promote(
      testInvocation({ requesterId: "agent-1" }),
      testFlight({ requesterId: "agent-1" }),
      "Maintenance complete.",
    );

    expect(runtime.collaborationRecord("work-1")).toEqual(expect.objectContaining({
      state: "done",
      acceptanceState: "none",
      completedAt: 200,
    }));
  });

  test("moves failed work to an explicit requester-owned waiting state", async () => {
    const { runtime, store, promote } = createStore();
    await store.recordDeliveryWorkItemIfNeeded({
      payload: testPayload(),
      requestId: "deliver-1",
      requesterId: "operator",
      targetAgentId: "agent-1",
      conversationId: "conversation-1",
      createdAt: 100,
    });

    await promote(
      testInvocation(),
      testFlight({ state: "failed", output: undefined, error: "Sandbox stopped." }),
      "Sandbox stopped.",
    );

    expect(runtime.collaborationRecord("work-1")).toEqual(expect.objectContaining({
      state: "waiting",
      completedAt: undefined,
      nextMoveOwnerId: "operator",
      waitingOn: expect.objectContaining({
        kind: "actor",
        targetId: "operator",
        label: "Decide whether to retry the failed execution",
      }),
    }));
  });

  test("records cancellation as a terminal work-item transition", async () => {
    const { runtime, store, promote } = createStore();
    await store.recordDeliveryWorkItemIfNeeded({
      payload: testPayload(),
      requestId: "deliver-1",
      requesterId: "operator",
      targetAgentId: "agent-1",
      conversationId: "conversation-1",
      createdAt: 100,
    });

    await promote(
      testInvocation(),
      testFlight({ state: "cancelled" }),
      "Cancelled by operator.",
    );

    expect(runtime.collaborationRecord("work-1")).toEqual(expect.objectContaining({
      state: "cancelled",
      completedAt: 200,
      waitingOn: undefined,
    }));
  });
});
