import { describe, expect, test } from "bun:test";

import type {
  DeliveryAttempt,
  DeliveryIntent,
  InboxItem,
} from "@openscout/protocol";

import {
  BrokerDeliveryHttpService,
} from "./broker-delivery-http-service.js";
import type { DeliveryStatusUpdateInput } from "./broker-delivery-store.js";

function delivery(input: Partial<DeliveryIntent> = {}): DeliveryIntent {
  return {
    id: "delivery-1",
    messageId: "msg-1",
    targetId: "agent-1",
    targetNodeId: "node-local",
    targetKind: "agent",
    transport: "local_socket",
    reason: "direct_message",
    policy: "durable",
    status: "pending",
    ...input,
  };
}

function attempt(input: Partial<DeliveryAttempt> = {}): DeliveryAttempt {
  return {
    id: "attempt-1",
    deliveryId: "delivery-1",
    attempt: 1,
    status: "sent",
    createdAt: 100,
    ...input,
  };
}

function inboxItem(input: Partial<InboxItem> = {}): InboxItem {
  const nextDelivery = input.delivery ?? delivery({ id: input.id ?? "delivery-1" });
  return {
    id: nextDelivery.id,
    kind: "message",
    targetId: nextDelivery.targetId,
    targetNodeId: nextDelivery.targetNodeId,
    conversationId: "conversation-1",
    messageId: nextDelivery.messageId,
    reason: nextDelivery.reason,
    status: nextDelivery.status,
    delivery: nextDelivery,
    metadata: nextDelivery.metadata,
    ...input,
  };
}

function createHarness(input: {
  deliveries?: DeliveryIntent[];
  attempts?: Record<string, DeliveryAttempt[]>;
  updateError?: Error;
  claimedDelivery?: DeliveryIntent | null;
} = {}) {
  const deliveries = input.deliveries ?? [delivery()];
  const attempts = input.attempts ?? { "delivery-1": [attempt()] };
  const listInboxCalls: unknown[] = [];
  const claimCalls: unknown[] = [];
  const updates: DeliveryStatusUpdateInput[] = [];
  const recordedAttempts: DeliveryAttempt[] = [];
  const service = new BrokerDeliveryHttpService({
    async listInboxItems(options) {
      listInboxCalls.push(options);
      return deliveries
        .filter((candidate) => candidate.targetId === options.targetId)
        .map((candidate) => inboxItem({ delivery: candidate }));
    },
    inboxItemForDelivery: (nextDelivery) => inboxItem({ delivery: nextDelivery }),
    async claimDelivery(inputClaim) {
      claimCalls.push(inputClaim);
      return input.claimedDelivery === undefined ? deliveries[0] ?? null : input.claimedDelivery;
    },
    async updateDeliveryStatus(update) {
      updates.push(update);
      if (input.updateError) {
        throw input.updateError;
      }
    },
    listDeliveries: ({ limit, transport, status }) => deliveries
      .filter((candidate) => !transport || candidate.transport === transport)
      .filter((candidate) => !status || candidate.status === status)
      .slice(0, limit),
    listDeliveryAttempts: (deliveryId) => attempts[deliveryId] ?? [],
    async recordDeliveryAttempt(nextAttempt) {
      recordedAttempts.push(nextAttempt);
    },
    now: () => 1_000,
  });

  return {
    claimCalls,
    listInboxCalls,
    recordedAttempts,
    service,
    updates,
  };
}

describe("BrokerDeliveryHttpService", () => {
  test("reads inbox items and snapshots with target validation", async () => {
    const harness = createHarness({
      deliveries: [
        delivery({ id: "delivery-agent", targetId: "agent-1" }),
        delivery({ id: "delivery-other", targetId: "agent-2" }),
      ],
    });

    await expect(harness.service.readInboxItems({
      targetId: " agent-1 ",
      limit: 25,
    })).resolves.toEqual([
      expect.objectContaining({ id: "delivery-agent", targetId: "agent-1" }),
    ]);
    await expect(harness.service.readInboxSnapshot({
      targetId: "agent-1",
    })).resolves.toEqual({
      targetId: "agent-1",
      items: [expect.objectContaining({ id: "delivery-agent" })],
    });
    await expect(harness.service.readInboxItems({
      targetId: " ",
    })).rejects.toThrow("targetId is required");
    expect(harness.listInboxCalls[0]).toEqual(expect.objectContaining({
      targetId: "agent-1",
      limit: 25,
    }));
  });

  test("claims inbox items and maps claimed deliveries to inbox items", async () => {
    const claimed = delivery({ id: "delivery-claimed", status: "leased" });
    const harness = createHarness({ claimedDelivery: claimed });

    await expect(harness.service.claimInboxItem({
      targetId: " agent-1 ",
      itemId: "delivery-claimed",
      leaseOwner: "worker-1",
      leaseMs: 5_000,
    })).resolves.toEqual({
      ok: true,
      claimed: expect.objectContaining({
        id: "delivery-claimed",
        status: "leased",
      }),
    });
    expect(harness.claimCalls).toEqual([
      {
        itemId: "delivery-claimed",
        messageId: undefined,
        targetId: "agent-1",
        reasons: undefined,
        leaseOwner: "worker-1",
        leaseMs: 5_000,
      },
    ]);
  });

  test("acknowledges inbox items and maps delivery lease conflicts to 409", async () => {
    const harness = createHarness();

    await expect(harness.service.acknowledgeInboxItem({
      itemId: "delivery-1",
      leaseOwner: "worker-1",
      leaseGeneration: 4,
      metadata: { source: "test" },
    })).resolves.toEqual({
      status: 200,
      body: { ok: true, itemId: "delivery-1", status: "acknowledged" },
    });
    expect(harness.updates).toEqual([
      {
        deliveryId: "delivery-1",
        status: "acknowledged",
        metadata: {
          source: "test",
          acknowledgedAt: 1_000,
          acknowledgedBy: "worker-1",
        },
        leaseOwner: null,
        leaseExpiresAt: null,
        expectedLeaseOwner: "worker-1",
        expectedLeaseGeneration: 4,
        requireActiveLease: true,
      },
    ]);

    const conflictHarness = createHarness({
      updateError: new Error("delivery lease is missing, expired, or owned by another worker"),
    });
    await expect(conflictHarness.service.acknowledgeInboxItem({
      itemId: "delivery-1",
      leaseOwner: "worker-1",
    })).resolves.toEqual({
      status: 409,
      body: {
        error: "conflict",
        detail: "delivery lease is missing, expired, or owned by another worker",
      },
    });
  });

  test("nacks inbox items with optional retry delay metadata", async () => {
    const harness = createHarness();

    await expect(harness.service.nackInboxItem({
      itemId: "delivery-1",
      leaseOwner: "worker-1",
      leaseGeneration: 5,
      retryAfterMs: 1_250.8,
      reason: "busy",
      metadata: { source: "test" },
    })).resolves.toEqual({
      status: 200,
      body: { ok: true, itemId: "delivery-1", status: "deferred" },
    });
    expect(harness.updates).toEqual([
      expect.objectContaining({
        deliveryId: "delivery-1",
        status: "deferred",
        metadata: {
          source: "test",
          nackedAt: 1_000,
          nackedBy: "worker-1",
          nackReason: "busy",
          nextAttemptAt: 2_250,
        },
        expectedLeaseOwner: "worker-1",
        expectedLeaseGeneration: 5,
        requireActiveLease: true,
      }),
    ]);
  });

  test("filters delivery lists and handles delivery claims", async () => {
    const claimed = delivery({ id: "delivery-claimed", targetId: "agent-1" });
    const harness = createHarness({
      claimedDelivery: claimed,
      deliveries: [
        delivery({ id: "match", targetId: "agent-1", messageId: "msg-1", reason: "direct_message" }),
        delivery({ id: "wrong-target", targetId: "agent-2", messageId: "msg-1", reason: "direct_message" }),
        delivery({ id: "wrong-reason", targetId: "agent-1", messageId: "msg-1", reason: "mention" }),
      ],
    });

    expect(harness.service.listDeliveries({
      limit: 100,
      targetId: "agent-1",
      messageId: "msg-1",
      reason: "direct_message",
    })).toEqual([
      expect.objectContaining({ id: "match" }),
    ]);
    await expect(harness.service.claimDelivery({
      messageId: "msg-1",
      targetId: "agent-1",
      leaseOwner: "worker-1",
    })).resolves.toEqual({
      ok: true,
      claimed,
    });
  });

  test("lists, records, and updates delivery attempts and statuses", async () => {
    const harness = createHarness();
    const nextAttempt = attempt({ id: "attempt-new", status: "failed" });

    expect(harness.service.listDeliveryAttempts(" delivery-1 ")).toEqual([
      expect.objectContaining({ id: "attempt-1" }),
    ]);
    expect(() => harness.service.listDeliveryAttempts(" ")).toThrow("deliveryId is required");
    await expect(harness.service.recordDeliveryAttempt(nextAttempt)).resolves.toEqual({
      ok: true,
      deliveryId: "delivery-1",
      attemptId: "attempt-new",
    });
    await expect(harness.service.updateDeliveryStatus({
      deliveryId: "delivery-1",
      status: "failed",
      metadata: { reason: "test" },
    })).resolves.toEqual({
      ok: true,
      deliveryId: "delivery-1",
      status: "failed",
    });
    expect(harness.recordedAttempts).toEqual([nextAttempt]);
    expect(harness.updates.at(-1)).toEqual({
      deliveryId: "delivery-1",
      status: "failed",
      metadata: { reason: "test" },
    });
  });
});
