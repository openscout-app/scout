import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { namedChannelNaturalKey } from "@openscout/protocol";

import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test";

const broker = createBrokerDaemonTestHarness();

describe("broker daemon collaboration routes", () => {
  test("links broker delivery work items to invocations and terminal flights", async () => {
    const harness = await broker.startBroker();
    await broker.seedBasicConversation(harness);
    await broker.seedHangingReceiver(harness, "fabric");

    const createdAt = Date.now();
    const response = await broker.postJson<{
      kind: string;
      accepted: boolean;
      conversation?: { id: string };
      message?: { id: string; metadata?: Record<string, unknown> };
      flight?: { id: string; invocationId: string; targetAgentId: string; state: string };
      workItem?: {
        id: string;
        kind: string;
        state: string;
        title: string;
        ownerId?: string;
        nextMoveOwnerId?: string;
        conversationId?: string;
      };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-work-test-1",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "agent_label",
        label: "@fabric",
      },
      body: "@fabric review the Hudson plan",
      intent: "consult",
      createdAt,
      collaborationRecordId: "work-delivery-test-1",
      workItem: {
        id: "work-delivery-test-1",
        title: "Review the Hudson plan",
        acceptanceState: "pending",
        summary: "Track the delegated plan review.",
        priority: "high",
        labels: ["plan"],
        metadata: {
          source: "test",
        },
      },
    });

    expect(response.kind).toBe("delivery");
    expect(response.accepted).toBe(true);
    expect(response.workItem).toEqual(expect.objectContaining({
      id: "work-delivery-test-1",
      kind: "work_item",
      state: "working",
      title: "Review the Hudson plan",
      ownerId: "fabric",
      nextMoveOwnerId: "fabric",
      conversationId: response.conversation?.id,
    }));
    expect(response.flight?.invocationId).toBeDefined();

    const linkedSnapshot = await broker.getJson<{
      messages: Record<string, { metadata?: Record<string, unknown> }>;
      invocations: Record<string, { collaborationRecordId?: string; metadata?: Record<string, unknown> }>;
      collaborationRecords: Record<string, { id: string; state: string; progress?: { summary?: string } }>;
    }>(harness.baseUrl, "/v1/snapshot");
    const invocation = linkedSnapshot.invocations[response.flight!.invocationId];
    const message = linkedSnapshot.messages[response.message!.id];
    expect(invocation?.collaborationRecordId).toBe("work-delivery-test-1");
    expect(invocation?.metadata?.collaborationRecordId).toBe("work-delivery-test-1");
    expect(message?.metadata?.collaborationRecordId).toBe("work-delivery-test-1");
    expect(linkedSnapshot.collaborationRecords["work-delivery-test-1"]?.state).toBe("working");

    await broker.postJson(harness.baseUrl, "/v1/flights", {
      id: response.flight!.id,
      invocationId: response.flight!.invocationId,
      requesterId: "operator",
      targetAgentId: "fabric",
      state: "completed",
      summary: "Fabric replied.",
      output: "Plan review complete.",
      startedAt: createdAt,
      completedAt: createdAt + 1000,
    });

    const completedSnapshot = await broker.getJson<{
      collaborationRecords: Record<string, { state: string; acceptanceState: string; nextMoveOwnerId?: string; reviewRequestedAt?: number; progress?: { summary?: string; completedSteps?: number; totalSteps?: number } }>;
    }>(harness.baseUrl, "/v1/snapshot");
    expect(completedSnapshot.collaborationRecords["work-delivery-test-1"]).toEqual(expect.objectContaining({
      state: "review",
      acceptanceState: "pending",
      nextMoveOwnerId: "operator",
      reviewRequestedAt: createdAt + 1000,
    }));
    expect(completedSnapshot.collaborationRecords["work-delivery-test-1"]?.progress).toEqual(expect.objectContaining({
      summary: "Plan review complete.",
      completedSteps: 1,
      totalSteps: 1,
    }));
  }, 15_000);

  test("reuses duplicate delivery work items without appending another created event", async () => {
    const harness = await broker.startBroker();
    await broker.seedBasicConversation(harness);
    await broker.seedHangingReceiver(harness, "fabric");

    const createdAt = Date.now();
    const payload = {
      id: "deliver-work-idempotent-1",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "agent_label",
        label: "@fabric",
      },
      body: "@fabric retry-safe review",
      intent: "consult",
      createdAt,
      collaborationRecordId: "work-delivery-idempotent-1",
      workItem: {
        id: "work-delivery-idempotent-1",
        title: "Retry-safe review",
        acceptanceState: "pending",
        summary: "Track a delivery retry without duplicating work.",
        priority: "normal",
        labels: ["retry"],
        metadata: {
          source: "test",
        },
      },
    };

    const first = await broker.postJson<{
      flight?: { id: string; invocationId: string };
      workItem?: { id: string; state: string; title: string };
    }>(harness.baseUrl, "/v1/deliver", payload);
    expect(first.workItem).toEqual(expect.objectContaining({
      id: "work-delivery-idempotent-1",
      state: "working",
      title: "Retry-safe review",
    }));

    await broker.postJson(harness.baseUrl, "/v1/flights", {
      id: first.flight!.id,
      invocationId: first.flight!.invocationId,
      requesterId: "operator",
      targetAgentId: "fabric",
      state: "completed",
      summary: "Fabric replied.",
      output: "Retry-safe review complete.",
      startedAt: createdAt,
      completedAt: createdAt + 500,
    });

    const duplicate = await broker.postJson<{
      message?: { id: string; metadata?: Record<string, unknown> };
      flight?: { id: string; invocationId: string };
      workItem?: { id: string; state: string; title: string };
    }>(harness.baseUrl, "/v1/deliver", payload);

    expect(duplicate.workItem).toEqual(expect.objectContaining({
      id: "work-delivery-idempotent-1",
      state: "review",
      title: "Retry-safe review",
    }));

    const snapshot = await broker.getJson<{
      invocations: Record<string, { collaborationRecordId?: string; metadata?: Record<string, unknown> }>;
      collaborationRecords: Record<string, { state: string; title: string; reviewRequestedAt?: number }>;
    }>(harness.baseUrl, "/v1/snapshot");
    expect(snapshot.collaborationRecords["work-delivery-idempotent-1"]).toEqual(expect.objectContaining({
      state: "review",
      title: "Retry-safe review",
      reviewRequestedAt: createdAt + 500,
    }));
    expect(snapshot.invocations[duplicate.flight!.invocationId]?.collaborationRecordId).toBe("work-delivery-idempotent-1");

    const events = await broker.getJson<Array<{ recordId: string; kind: string }>>(
      harness.baseUrl,
      "/v1/collaboration/events?recordId=work-delivery-idempotent-1&limit=20",
    );
    expect(events.filter((event) => event.kind === "created")).toHaveLength(1);
  }, 15_000);

  test("does not overwrite or link conflicting delivery work item ids", async () => {
    const harness = await broker.startBroker();
    await broker.seedBasicConversation(harness);
    await broker.seedHangingReceiver(harness, "fabric");

    const createdAt = Date.now();
    await broker.postJson(harness.baseUrl, "/v1/collaboration/records", {
      id: "work-delivery-conflict-1",
      kind: "work_item",
      state: "waiting",
      acceptanceState: "accepted",
      title: "Existing owned work",
      summary: "Keep this state intact.",
      createdById: "operator",
      ownerId: "operator",
      nextMoveOwnerId: "operator",
      requestedById: "operator",
      waitingOn: {
        kind: "actor",
        label: "operator follow-up",
        targetId: "operator",
      },
      conversationId: "channel.shared",
      priority: "high",
      labels: ["existing"],
      createdAt,
      updatedAt: createdAt,
      metadata: {
        source: "seed",
        deliveryRequestId: "deliver-original-conflict-source",
      },
    });
    await broker.postJson(harness.baseUrl, "/v1/collaboration/events", {
      id: "evt-work-delivery-conflict-created",
      recordId: "work-delivery-conflict-1",
      recordKind: "work_item",
      kind: "created",
      actorId: "operator",
      at: createdAt,
      summary: "Existing owned work",
      metadata: {
        source: "seed",
        deliveryRequestId: "deliver-original-conflict-source",
      },
    });

    const response = await broker.postJson<{
      message?: { id: string; metadata?: Record<string, unknown> };
      flight?: { invocationId: string };
      workItem?: { id: string };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-original-conflict-source",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "agent_label",
        label: "@fabric",
      },
      body: "@fabric try to claim the existing id",
      intent: "consult",
      createdAt: createdAt + 100,
      collaborationRecordId: "work-delivery-conflict-1",
      workItem: {
        id: "work-delivery-conflict-1",
        title: "Conflicting replacement title",
        summary: "This should not replace the existing record.",
        priority: "low",
        labels: ["replacement"],
        metadata: {
          source: "replacement",
          deliveryRequestId: "deliver-original-conflict-source",
        },
      },
    });

    expect(response.workItem).toBeUndefined();
    expect(response.message?.metadata?.collaborationRecordId).toBeUndefined();

    const snapshot = await broker.getJson<{
      invocations: Record<string, { collaborationRecordId?: string; metadata?: Record<string, unknown> }>;
      collaborationRecords: Record<string, {
        state: string;
        title: string;
        ownerId?: string;
        nextMoveOwnerId?: string;
        priority?: string;
        labels?: string[];
      }>;
    }>(harness.baseUrl, "/v1/snapshot");
    expect(snapshot.invocations[response.flight!.invocationId]?.collaborationRecordId).toBeUndefined();
    expect(snapshot.invocations[response.flight!.invocationId]?.metadata?.collaborationRecordId).toBeUndefined();
    expect(snapshot.collaborationRecords["work-delivery-conflict-1"]).toEqual(expect.objectContaining({
      state: "waiting",
      title: "Existing owned work",
      ownerId: "operator",
      nextMoveOwnerId: "operator",
      priority: "high",
      labels: ["existing"],
    }));

    const events = await broker.getJson<Array<{ recordId: string; kind: string }>>(
      harness.baseUrl,
      "/v1/collaboration/events?recordId=work-delivery-conflict-1&limit=20",
    );
    expect(events.filter((event) => event.kind === "created")).toHaveLength(1);
  }, 15_000);

  test("persists valid collaboration records and emits collaboration events", async () => {
    const harness = await broker.startBroker();
    await broker.seedBasicConversation(harness);

    const now = Date.now();
    const response = await broker.postJson<{ ok: boolean; recordId: string }>(
      harness.baseUrl,
      "/v1/collaboration/records",
      {
        id: "work-test-1",
        kind: "work_item",
        state: "working",
        acceptanceState: "none",
        title: "Investigate relay drift",
        summary: "Check runtime and relay state alignment.",
        createdById: "operator",
        ownerId: "fabric",
        nextMoveOwnerId: "fabric",
        conversationId: "channel.shared",
        createdAt: now,
        updatedAt: now,
      },
    );

    expect(response.ok).toBe(true);
    expect(response.recordId).toBe("work-test-1");

    const snapshot = await broker.getJson<{
      collaborationRecords: Record<string, { id: string; ownerId?: string; nextMoveOwnerId?: string; state: string }>;
    }>(harness.baseUrl, "/v1/snapshot");

    expect(snapshot.collaborationRecords["work-test-1"]).toBeDefined();
    expect(snapshot.collaborationRecords["work-test-1"]?.ownerId).toBe("fabric");
    expect(snapshot.collaborationRecords["work-test-1"]?.nextMoveOwnerId).toBe("fabric");
    expect(snapshot.collaborationRecords["work-test-1"]?.state).toBe("working");

    const events = await broker.getJson<Array<{ kind: string; payload: { record?: { id: string } } }>>(
      harness.baseUrl,
      "/v1/events?limit=20",
    );

    expect(events.some((event) => event.kind === "collaboration.upserted" && event.payload.record?.id === "work-test-1")).toBe(true);
  }, 15_000);

  test("rejects invalid waiting work items without required ownership metadata", async () => {
    const harness = await broker.startBroker();
    await broker.seedBasicConversation(harness);

    const response = await fetch(`${harness.baseUrl}/v1/collaboration/records`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        id: "work-invalid-1",
        kind: "work_item",
        state: "waiting",
        acceptanceState: "none",
        title: "Wait for review",
        createdById: "operator",
        ownerId: "fabric",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json() as { detail: string };
    expect(payload.detail).toContain("nextMoveOwnerId");
    expect(payload.detail).toContain("waitingOn");
  }, 15_000);

  test("rejects collaboration events that do not match the target record kind", async () => {
    const harness = await broker.startBroker();
    await broker.seedBasicConversation(harness);

    const now = Date.now();
    await broker.postJson(harness.baseUrl, "/v1/collaboration/records", {
      id: "question-test-1",
      kind: "question",
      state: "open",
      acceptanceState: "none",
      title: "Who owns the next change?",
      createdById: "operator",
      nextMoveOwnerId: "fabric",
      askedById: "operator",
      askedOfId: "fabric",
      conversationId: "channel.shared",
      createdAt: now,
      updatedAt: now,
    });

    const response = await fetch(`${harness.baseUrl}/v1/collaboration/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        id: "evt-question-invalid-1",
        recordId: "question-test-1",
        recordKind: "question",
        kind: "review_requested",
        actorId: "fabric",
        at: Date.now(),
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json() as { detail: string };
    expect(payload.detail).toContain("review_requested");
  }, 15_000);

  test("builds collaboration-aware invocations from the broker wake endpoint", async () => {
    const harness = await broker.startBroker();
    await broker.seedBasicConversation(harness);

    const now = Date.now();
    await broker.postJson(harness.baseUrl, "/v1/collaboration/records", {
      id: "work-wake-1",
      kind: "work_item",
      state: "waiting",
      acceptanceState: "none",
      title: "Resolve review dependency",
      summary: "Fabric needs to answer the outstanding review request.",
      createdById: "operator",
      ownerId: "fabric",
      nextMoveOwnerId: "fabric",
      requestedById: "operator",
      waitingOn: {
        kind: "actor",
        label: "review response",
        targetId: "fabric",
      },
      conversationId: "channel.shared",
      createdAt: now,
      updatedAt: now,
    });

    const response = await broker.postJson<{
      ok: boolean;
      recordId: string;
      targetAgentId: string;
      wakeReason: string;
      invocation: {
        targetAgentId: string;
        context?: {
          collaboration?: {
            recordId?: string;
            nextMoveOwnerId?: string;
            wakeReason?: string;
            waitingOn?: { targetId?: string };
          };
        };
        metadata?: {
          collaborationRecordId?: string;
          wakeReason?: string;
        };
      };
      flight: {
        targetAgentId: string;
        state: string;
      };
    }>(harness.baseUrl, "/v1/collaboration/records/work-wake-1/invoke", {
      requesterId: "operator",
    });

    expect(response.ok).toBe(true);
    expect(response.recordId).toBe("work-wake-1");
    expect(response.targetAgentId).toBe("fabric");
    expect(response.wakeReason).toBe("next_move_owner");
    expect(response.invocation.targetAgentId).toBe("fabric");
    expect(response.invocation.context?.collaboration?.recordId).toBe("work-wake-1");
    expect(response.invocation.context?.collaboration?.nextMoveOwnerId).toBe("fabric");
    expect(response.invocation.context?.collaboration?.wakeReason).toBe("next_move_owner");
    expect(response.invocation.context?.collaboration?.waitingOn?.targetId).toBe("fabric");
    expect(response.invocation.metadata?.collaborationRecordId).toBe("work-wake-1");
    expect(response.invocation.metadata?.wakeReason).toBe("next_move_owner");
    expect(response.flight.targetAgentId).toBe("fabric");
    expect(response.flight.state).toBe("waking");
  }, 15_000);
});
