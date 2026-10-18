import type {
  DeliveryAttempt,
  DeliveryIntent,
  DeliveryReason,
  InboxAckRequest,
  InboxClaimRequest,
  InboxItem,
  InboxNackRequest,
} from "@openscout/protocol";

import type {
  DeliveryClaimInput,
  DeliveryStatusUpdateInput,
} from "./broker-delivery-store.js";

export type DeliveryClaimBody = {
  messageId: string;
  targetId: string;
  reasons?: DeliveryReason[];
  leaseOwner?: string;
  leaseMs?: number;
};

export type DeliveryStatusBody = {
  deliveryId: string;
  status: DeliveryIntent["status"];
  metadata?: Record<string, unknown>;
  leaseOwner?: string | null;
  leaseExpiresAt?: number | null;
};

export type DeliveryAttemptBody = DeliveryAttempt;

export type BrokerDeliveryHttpResult = {
  status: number;
  body: unknown;
};

export type BrokerDeliveryHttpServiceDeps = {
  listInboxItems: (options: {
    targetId: string;
    statuses?: Set<DeliveryIntent["status"]>;
    reasons?: Set<DeliveryReason>;
    limit?: number;
  }) => Promise<InboxItem[]>;
  inboxItemForDelivery: (delivery: DeliveryIntent) => InboxItem | Promise<InboxItem>;
  claimDelivery: (input: DeliveryClaimInput) => Promise<DeliveryIntent | null>;
  updateDeliveryStatus: (input: DeliveryStatusUpdateInput) => Promise<void>;
  listDeliveries: (options: {
    limit: number;
    transport?: DeliveryIntent["transport"];
    status?: DeliveryIntent["status"];
  }) => DeliveryIntent[];
  listDeliveryAttempts: (deliveryId: string) => DeliveryAttempt[];
  recordDeliveryAttempt: (attempt: DeliveryAttempt) => Promise<void>;
  now?: () => number;
};

export class BrokerDeliveryHttpService {
  constructor(private readonly deps: BrokerDeliveryHttpServiceDeps) {}

  readonly readInboxItems = async (input: {
    targetId?: string | null;
    statuses?: Set<DeliveryIntent["status"]>;
    reasons?: Set<DeliveryReason>;
    limit?: number;
  }): Promise<InboxItem[]> => {
    const targetId = input.targetId?.trim();
    if (!targetId) {
      throw new Error("targetId is required");
    }
    return await this.deps.listInboxItems({
      targetId,
      statuses: input.statuses,
      reasons: input.reasons,
      limit: input.limit,
    });
  };

  readonly readInboxSnapshot = async (input: {
    targetId?: string | null;
    statuses?: Set<DeliveryIntent["status"]>;
    reasons?: Set<DeliveryReason>;
    limit?: number;
  }): Promise<{ targetId: string; items: InboxItem[] }> => {
    const targetId = input.targetId?.trim();
    if (!targetId) {
      throw new Error("targetId is required");
    }
    return {
      targetId,
      items: await this.readInboxItems({ ...input, targetId }),
    };
  };

  readonly claimInboxItem = async (body: InboxClaimRequest): Promise<{
    ok: true;
    claimed: InboxItem | null;
  }> => {
    const targetId = body.targetId?.trim();
    if (!targetId) {
      throw new Error("targetId is required");
    }
    const claimedDelivery = await this.deps.claimDelivery({
      itemId: body.itemId,
      messageId: body.messageId,
      targetId,
      reasons: body.reasons,
      leaseOwner: body.leaseOwner,
      leaseMs: body.leaseMs,
    });
    return {
      ok: true,
      claimed: claimedDelivery ? await this.deps.inboxItemForDelivery(claimedDelivery) : null,
    };
  };

  readonly acknowledgeInboxItem = async (body: InboxAckRequest): Promise<BrokerDeliveryHttpResult> => {
    const itemId = body.itemId?.trim();
    if (!itemId) {
      throw new Error("itemId is required");
    }
    const leaseOwner = body.leaseOwner?.trim();
    if (!leaseOwner) {
      throw new Error("leaseOwner is required");
    }
    const now = this.deps.now?.() ?? Date.now();
    return await this.updateLeaseSensitiveStatus({
      deliveryId: itemId,
      status: "acknowledged",
      metadata: {
        ...(body.metadata ?? {}),
        acknowledgedAt: now,
        acknowledgedBy: leaseOwner,
      },
      leaseOwner: null,
      leaseExpiresAt: null,
      expectedLeaseOwner: leaseOwner,
      expectedLeaseGeneration: body.leaseGeneration,
      requireActiveLease: true,
    }, {
      ok: true,
      itemId,
      status: "acknowledged",
    });
  };

  readonly nackInboxItem = async (body: InboxNackRequest): Promise<BrokerDeliveryHttpResult> => {
    const itemId = body.itemId?.trim();
    if (!itemId) {
      throw new Error("itemId is required");
    }
    const leaseOwner = body.leaseOwner?.trim();
    if (!leaseOwner) {
      throw new Error("leaseOwner is required");
    }
    const now = this.deps.now?.() ?? Date.now();
    const retryAfterMs = typeof body.retryAfterMs === "number" && Number.isFinite(body.retryAfterMs) && body.retryAfterMs > 0
      ? Math.floor(body.retryAfterMs)
      : 0;
    const status = retryAfterMs > 0 ? "deferred" : "pending";
    return await this.updateLeaseSensitiveStatus({
      deliveryId: itemId,
      status,
      metadata: {
        ...(body.metadata ?? {}),
        nackedAt: now,
        nackedBy: leaseOwner,
        ...(body.reason ? { nackReason: body.reason } : {}),
        ...(retryAfterMs > 0 ? { nextAttemptAt: now + retryAfterMs } : {}),
      },
      leaseOwner: null,
      leaseExpiresAt: null,
      expectedLeaseOwner: leaseOwner,
      expectedLeaseGeneration: body.leaseGeneration,
      requireActiveLease: true,
    }, {
      ok: true,
      itemId,
      status,
    });
  };

  readonly listDeliveries = (input: {
    limit: number;
    transport?: DeliveryIntent["transport"];
    status?: DeliveryIntent["status"];
    targetId?: string | null;
    messageId?: string | null;
    reason?: string | null;
  }): DeliveryIntent[] => {
    const targetId = input.targetId?.trim();
    const messageId = input.messageId?.trim();
    const reason = input.reason?.trim();
    return this.deps.listDeliveries({
      limit: input.limit,
      transport: input.transport,
      status: input.status,
    }).filter((delivery) => (
      (!targetId || delivery.targetId === targetId)
      && (!messageId || delivery.messageId === messageId)
      && (!reason || delivery.reason === reason)
    ));
  };

  readonly claimDelivery = async (body: DeliveryClaimBody): Promise<{
    ok: true;
    claimed: DeliveryIntent | null;
  }> => {
    const claimed = await this.deps.claimDelivery({
      messageId: body.messageId,
      targetId: body.targetId,
      reasons: body.reasons,
      leaseOwner: body.leaseOwner,
      leaseMs: body.leaseMs,
    });
    return { ok: true, claimed };
  };

  readonly listDeliveryAttempts = (deliveryIdInput?: string | null): DeliveryAttempt[] => {
    const deliveryId = deliveryIdInput?.trim();
    if (!deliveryId) {
      throw new Error("deliveryId is required");
    }
    return this.deps.listDeliveryAttempts(deliveryId);
  };

  readonly recordDeliveryAttempt = async (
    attempt: DeliveryAttemptBody,
  ): Promise<{ ok: true; deliveryId: string; attemptId: string }> => {
    await this.deps.recordDeliveryAttempt(attempt);
    return { ok: true, deliveryId: attempt.deliveryId, attemptId: attempt.id };
  };

  readonly updateDeliveryStatus = async (
    body: DeliveryStatusBody,
  ): Promise<{ ok: true; deliveryId: string; status: DeliveryIntent["status"] }> => {
    await this.deps.updateDeliveryStatus(body);
    return { ok: true, deliveryId: body.deliveryId, status: body.status };
  };

  private async updateLeaseSensitiveStatus(
    update: DeliveryStatusUpdateInput,
    okBody: unknown,
  ): Promise<BrokerDeliveryHttpResult> {
    try {
      await this.deps.updateDeliveryStatus(update);
      return { status: 200, body: okBody };
    } catch (error) {
      if (error instanceof Error && /delivery (not found|lease)/.test(error.message)) {
        return {
          status: 409,
          body: {
            error: "conflict",
            detail: error.message,
          },
        };
      }
      throw error;
    }
  }
}
