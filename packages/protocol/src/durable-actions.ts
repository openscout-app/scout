import type { MetadataMap, ScoutId } from "./common.js";

// First implementation slice. Add work_item/question/approval only after ask,
// message_delivery, and checkback semantics prove out against real paths.
// `manual_review` is a recorded occurrence (see manual-review-occurrences.ts).
// It carries no due time and no lease, so nothing claims or runs it. Its one
// ask starts through the manual review dispatch entry point, not a worker.
// `manual_review_routine` is a saved Board review routine (see
// manual-review-board.ts). It is configuration held as a record: no due time,
// no lease, and nothing runs it.
export type DurableActionKind = "ask" | "message_delivery" | "checkback" | "manual_review" | "manual_review_routine";

export type DurableCheckbackMode =
  | "notify"
  | "scoutbot"
  | "agent"
  | "routine";

export interface DurableCheckbackMetadata extends MetadataMap {
  dueAt: number;
  mode?: DurableCheckbackMode;
  title?: string;
  body?: string;
  prompt?: string;
  ownerId?: ScoutId;
  conversationId?: ScoutId;
  recordId?: ScoutId;
  route?: unknown;
  recurrence?: unknown;
}

export type DurableActionState =
  | "pending"
  | "leased"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export type DurableAttemptState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface DurableAction {
  id: ScoutId;
  kind: DurableActionKind;
  subjectId: ScoutId;
  authorityCellId: ScoutId;
  state: DurableActionState;
  idempotencyKey?: string;
  leaseOwner?: string;
  leaseGeneration: number;
  leaseExpiresAt?: number;
  createdAt: number;
  updatedAt: number;
  metadata?: MetadataMap;
}

export interface DurableAttempt {
  id: ScoutId;
  actionId: ScoutId;
  attempt: number;
  state: DurableAttemptState;
  leaseGeneration: number;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  metadata?: MetadataMap;
}

export interface DurableCheckpoint {
  actionId: ScoutId;
  name: string;
  payload?: unknown;
  ownerAttemptId?: ScoutId;
  leaseOwner?: string;
  leaseGeneration?: number;
  createdAt: number;
}

export interface DurableSignal {
  actionId: ScoutId;
  name: string;
  payload?: unknown;
  leaseOwner?: string;
  leaseGeneration?: number;
  emittedAt: number;
}

export interface DurableActionCreateInput {
  id: ScoutId;
  kind: DurableActionKind;
  subjectId: ScoutId;
  authorityCellId: ScoutId;
  idempotencyKey?: string;
  createdAt: number;
  metadata?: MetadataMap;
}

export interface DurableActionClaimInput {
  actionId: ScoutId;
  owner: string;
  leaseMs: number;
  claimedAt: number;
}

export interface DurableActionHeartbeatInput {
  actionId: ScoutId;
  owner: string;
  generation: number;
  leaseMs: number;
  heartbeatAt: number;
}

export interface DurableActionLease {
  owner: string;
  generation: number;
  expiresAt: number;
}

export interface DurableActionCommandReceipt {
  accepted: boolean;
  duplicate?: boolean;
  action: DurableAction;
  lease?: DurableActionLease;
  events: string[];
}
