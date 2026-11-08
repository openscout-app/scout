/**
 * Work item claims: one holder at a time, under a lease.
 *
 * A claim is runtime-owned state on the work item (`metadata.workClaim`). The
 * runtime decides every claim, renewal and release under its single writer, as
 * a compare-and-set against the claim it holds. A contended claim fails with a
 * typed conflict; it never overwrites the holder. An expired lease frees the
 * item: the next claim wins, and any caller may release it.
 *
 * `leaseGeneration` fences one attempt. It advances on every new claim of the
 * item, including a re-claim by the same holder after expiry. Echo it when you
 * renew or release.
 */
import type { CollaborationRecord } from "./collaboration.js";

export const WORK_CLAIM_METADATA_KEY = "workClaim" as const;
export const WORK_CLAIM_DEFAULT_LEASE_MS = 15 * 60 * 1000;
export const WORK_CLAIM_MIN_LEASE_MS = 10 * 1000;
export const WORK_CLAIM_MAX_LEASE_MS = 24 * 60 * 60 * 1000;

export interface WorkClaim {
  /** The actor that holds the item. The runtime also makes it the owner. */
  claimantId: string;
  /** The session the claim came from, so work can route back to it. A session address or a session id. */
  sessionAddress?: string;
  leaseGeneration: number;
  claimedAt: number;
  renewedAt: number;
  leaseExpiresAt: number;
}

export type WorkClaimAction = "claim" | "renew" | "release";

export interface WorkClaimRequest {
  workId: string;
  /** Defaults to `claim`. */
  action?: WorkClaimAction;
  actorId?: string;
  sessionAddress?: string;
  /** Lease length. Clamped to the minimum and maximum lease. */
  leaseMs?: number;
  /** Required by `renew` and `release` from the holder when the claim has one. */
  leaseGeneration?: number;
  /**
   * Compare-and-set on the owner: the claim fails unless the item's owner is
   * this value. `null` means the item must have no owner.
   */
  expectedOwnerId?: string | null;
}

export interface WorkClaimResponse {
  workId: string;
  action: WorkClaimAction;
  /** The claim after the call. `null` after a release. */
  claim: WorkClaim | null;
  ownerId?: string;
  /** True when a claim call extended the caller's own active claim. */
  renewed?: boolean;
}

export type WorkClaimConflictCode =
  | "work_claim_held"
  | "work_claim_owner_mismatch"
  | "work_claim_not_held"
  | "work_claim_stale_generation"
  | "work_claim_closed";

/** The body of a 409 from the claim API and from writes that would break a claim. */
export interface WorkClaimConflict {
  error: string;
  code: WorkClaimConflictCode;
  workId: string;
  holder?: WorkClaim;
  ownerId?: string;
  /** Time left on the holder's lease. */
  retryAfterMs?: number;
  /** What the caller can do next. */
  hint: string;
}

export type WorkClaimStatus = "unclaimed" | "active" | "expired";

export function workClaimOf(record: CollaborationRecord | undefined): WorkClaim | undefined {
  const value = record?.metadata?.[WORK_CLAIM_METADATA_KEY] as WorkClaim | undefined;
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.claimantId !== "string" || typeof value.leaseExpiresAt !== "number") return undefined;
  return value;
}

export function workClaimStatus(claim: WorkClaim | undefined, now: number): WorkClaimStatus {
  if (!claim) return "unclaimed";
  return claim.leaseExpiresAt > now ? "active" : "expired";
}

export function clampWorkClaimLeaseMs(leaseMs: number | undefined): number {
  if (typeof leaseMs !== "number" || !Number.isFinite(leaseMs)) return WORK_CLAIM_DEFAULT_LEASE_MS;
  return Math.min(Math.max(Math.round(leaseMs), WORK_CLAIM_MIN_LEASE_MS), WORK_CLAIM_MAX_LEASE_MS);
}
