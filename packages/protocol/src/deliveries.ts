import type {
  DeliveryFailureReason,
  DeliveryPolicy,
  DeliveryReason,
  DeliveryStatus,
  DeliveryTargetKind,
  DeliveryTransport,
  MetadataMap,
  ScoutId,
} from "./common.js";

/**
 * Delivery metadata carries a small set of well-known keys alongside arbitrary
 * extension data. The typed fields document the keys the runtime reads on the
 * retry path; the {@link MetadataMap} index signature keeps the bag open for
 * transport-specific extras. The wire/persistence shape is unchanged — these
 * were always plain metadata keys, now they are typed.
 */
export interface DeliveryMetadata extends MetadataMap {
  /** Monotonic inbox claim generation, retained after ACK/NACK and across restart. */
  leaseGeneration?: number;
  /** Epoch ms of the next retry attempt. Set while `status` is `"deferred"`. */
  nextAttemptAt?: number;
  /** Classified failure reason. Set when `status` is `"failed"`. */
  failureReason?: DeliveryFailureReason;
}

export interface DeliveryTarget {
  id: ScoutId;
  kind: DeliveryTargetKind;
  transport: DeliveryTransport;
  address?: string;
  bindingId?: ScoutId;
  metadata?: MetadataMap;
}

export interface DeliveryIntent {
  id: ScoutId;
  messageId?: ScoutId;
  invocationId?: ScoutId;
  targetId: ScoutId;
  targetNodeId?: ScoutId;
  targetKind: DeliveryTargetKind;
  transport: DeliveryTransport;
  reason: DeliveryReason;
  policy: DeliveryPolicy;
  status: DeliveryStatus;
  bindingId?: ScoutId;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  metadata?: DeliveryMetadata;
}

export interface DeliveryAttempt {
  id: ScoutId;
  deliveryId: ScoutId;
  attempt: number;
  status: "sent" | "acknowledged" | "failed";
  error?: string;
  externalRef?: string;
  createdAt: number;
  metadata?: MetadataMap;
}
