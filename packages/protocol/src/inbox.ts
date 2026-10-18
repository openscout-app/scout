import type { DeliveryIntent } from "./deliveries.js";
import type { InvocationRequest } from "./invocations.js";
import type { MessageRecord } from "./messages.js";
import type { DeliveryReason, DeliveryStatus, MetadataMap, ScoutId } from "./common.js";

export type InboxItemKind = "message" | "invocation";

export const INBOX_CLAIMABLE_DELIVERY_STATUSES = [
  "pending",
  "accepted",
  "deferred",
] as const satisfies readonly DeliveryStatus[];

export type InboxClaimableDeliveryStatus =
  (typeof INBOX_CLAIMABLE_DELIVERY_STATUSES)[number];

export function isInboxClaimableDeliveryStatus(
  status: DeliveryStatus,
): status is InboxClaimableDeliveryStatus {
  return (INBOX_CLAIMABLE_DELIVERY_STATUSES as readonly DeliveryStatus[])
    .includes(status);
}

export interface InboxItem {
  id: ScoutId;
  kind: InboxItemKind;
  targetId: ScoutId;
  targetNodeId?: ScoutId;
  conversationId?: ScoutId;
  messageId?: ScoutId;
  invocationId?: ScoutId;
  reason: DeliveryReason;
  status: DeliveryStatus;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  /** Echo this claim generation when acknowledging or releasing the lease. */
  leaseGeneration?: number;
  delivery: DeliveryIntent;
  message?: MessageRecord;
  invocation?: InvocationRequest;
  metadata?: MetadataMap;
}

export interface InboxClaimRequest {
  targetId: ScoutId;
  itemId?: ScoutId;
  messageId?: ScoutId;
  reasons?: DeliveryReason[];
  leaseOwner?: string;
  leaseMs?: number;
}

export interface InboxClaimResponse {
  ok: true;
  claimed: InboxItem | null;
}

export interface InboxAckRequest {
  itemId: ScoutId;
  leaseOwner?: string | null;
  /** Required for claims issued by brokers supporting lease fencing. */
  leaseGeneration?: number;
  metadata?: MetadataMap;
}

export interface InboxNackRequest {
  itemId: ScoutId;
  leaseOwner?: string | null;
  /** Required for claims issued by brokers supporting lease fencing. */
  leaseGeneration?: number;
  retryAfterMs?: number;
  reason?: string;
  metadata?: MetadataMap;
}
