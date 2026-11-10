/**
 * Work item claims in the runtime.
 *
 * The runtime is the one writer of a claim. Each call reads the item under the
 * durable writer, compares the caller with the claim it holds, and commits the
 * result in the same write, so two callers cannot both win. A lost claim is a
 * typed 409 that names the holder, its session and the lease left; it never
 * overwrites the holder and never waits.
 */
import {
  WORK_CLAIM_METADATA_KEY,
  clampWorkClaimLeaseMs,
  isWorkItemTerminalState,
  workClaimOf,
  workClaimStatus,
  type CollaborationEvent,
  type CollaborationRecord,
  type WorkClaim,
  type WorkClaimAction,
  type WorkClaimConflict,
  type WorkClaimConflictCode,
  type WorkClaimRequest,
  type WorkClaimResponse,
  type WorkItemRecord,
} from "@openscout/protocol";

export class WorkClaimConflictError extends Error {
  readonly status = 409;
  constructor(readonly conflict: WorkClaimConflict) {
    super(conflict.error);
  }
}

function holderLabel(claim: WorkClaim): string {
  return claim.sessionAddress ? `${claim.claimantId} (session ${claim.sessionAddress})` : claim.claimantId;
}

function leaseLeft(claim: WorkClaim, now: number): string {
  const seconds = Math.max(0, Math.ceil((claim.leaseExpiresAt - now) / 1000));
  return seconds >= 120 ? `${Math.ceil(seconds / 60)}m` : `${seconds}s`;
}

function conflict(
  code: WorkClaimConflictCode,
  record: WorkItemRecord,
  error: string,
  hint: string,
  now: number,
  holder?: WorkClaim,
): WorkClaimConflictError {
  const active = holder && workClaimStatus(holder, now) === "active";
  return new WorkClaimConflictError({
    error: `${error} ${hint}`,
    code,
    workId: record.id,
    ...(holder ? { holder } : {}),
    ...(record.ownerId ? { ownerId: record.ownerId } : {}),
    ...(active ? { retryAfterMs: holder.leaseExpiresAt - now } : {}),
    hint,
  });
}

function heldConflict(record: WorkItemRecord, holder: WorkClaim, now: number, what = "Claim refused"): WorkClaimConflictError {
  return conflict(
    "work_claim_held",
    record,
    `${what}: ${record.id} is claimed by ${holderLabel(holder)} for ${leaseLeft(holder, now)} more.`,
    `Pick other work, ask ${holder.claimantId} to release it, or claim it after the lease ends at ${new Date(holder.leaseExpiresAt).toISOString()}.`,
    now,
    holder,
  );
}

/** The caller is the holder: same actor, and the same session when both name one. */
function holds(claim: WorkClaim, actorId: string, sessionAddress: string | undefined): boolean {
  if (claim.claimantId !== actorId) return false;
  return !sessionAddress || !claim.sessionAddress || claim.sessionAddress === sessionAddress;
}

/**
 * The highest lease generation an item has issued. It outlives the claim, so a
 * claim after a release or a reopen gets a new generation, and a stale attempt
 * cannot match it.
 */
const WORK_CLAIM_GENERATION_METADATA_KEY = "workClaimGeneration";

function lastClaimGeneration(record: CollaborationRecord | undefined): number {
  const stored = record?.metadata?.[WORK_CLAIM_GENERATION_METADATA_KEY];
  const held = record?.kind === "work_item" ? workClaimOf(record)?.leaseGeneration : undefined;
  return Math.max(typeof stored === "number" && Number.isFinite(stored) ? stored : 0, held ?? 0);
}

function withClaim(record: WorkItemRecord, claim: WorkClaim | undefined, now: number): WorkItemRecord {
  const metadata = { ...(record.metadata ?? {}) };
  metadata[WORK_CLAIM_GENERATION_METADATA_KEY] = Math.max(lastClaimGeneration(record), claim?.leaseGeneration ?? 0);
  if (claim) metadata[WORK_CLAIM_METADATA_KEY] = claim;
  else delete metadata[WORK_CLAIM_METADATA_KEY];
  return { ...record, updatedAt: Math.max(now, record.updatedAt), metadata };
}

function trimmed(value: string | null | undefined): string | undefined {
  const next = value?.trim();
  return next ? next.slice(0, 512) : undefined;
}

export interface WorkClaimInput {
  actorId: string;
  sessionAddress?: string;
  leaseMs?: number;
  expectedOwnerId?: string | null;
}

/**
 * Compare-and-set a claim. The caller's own active claim is renewed. An active
 * claim held by anyone else is a conflict. An expired or absent claim is
 * replaced, with a new lease generation, and the caller becomes the owner.
 */
export function applyWorkClaim(
  record: WorkItemRecord,
  input: WorkClaimInput,
  now: number,
): { record: WorkItemRecord; claim: WorkClaim; renewed: boolean } {
  if (isWorkItemTerminalState(record.state)) {
    throw conflict("work_claim_closed", record, `Claim refused: ${record.id} is ${record.state}.`, "Reopen it first, or claim open work.", now);
  }
  if (input.expectedOwnerId !== undefined && (record.ownerId ?? null) !== (input.expectedOwnerId ?? null)) {
    throw conflict(
      "work_claim_owner_mismatch",
      record,
      `Claim refused: ${record.id} is owned by ${record.ownerId ?? "nobody"}, not ${input.expectedOwnerId ?? "nobody"}.`,
      "Read the item again and retry with its current owner, or pick other work.",
      now,
      workClaimOf(record),
    );
  }
  const sessionAddress = trimmed(input.sessionAddress);
  const leaseMs = clampWorkClaimLeaseMs(input.leaseMs);
  const current = workClaimOf(record);
  if (current && workClaimStatus(current, now) === "active") {
    if (!holds(current, input.actorId, sessionAddress)) throw heldConflict(record, current, now);
    const claim: WorkClaim = { ...current, renewedAt: now, leaseExpiresAt: now + leaseMs };
    if (!claim.sessionAddress && sessionAddress) claim.sessionAddress = sessionAddress;
    return { record: withClaim(record, claim, now), claim, renewed: true };
  }
  const claim: WorkClaim = {
    claimantId: input.actorId,
    ...(sessionAddress ? { sessionAddress } : {}),
    leaseGeneration: lastClaimGeneration(record) + 1,
    claimedAt: now,
    renewedAt: now,
    leaseExpiresAt: now + leaseMs,
  };
  const owned = record.ownerId === input.actorId ? record : { ...record, ownerId: input.actorId, nextMoveOwnerId: input.actorId };
  return { record: withClaim(owned, claim, now), claim, renewed: false };
}

export interface PlannedWorkClaim {
  response: WorkClaimResponse;
  /** Absent when nothing changes. */
  record?: WorkItemRecord;
  /** Absent for a renewal: a lease heartbeat is not a ledger event. */
  event?: CollaborationEvent;
}

export function planWorkClaim(
  record: WorkItemRecord,
  request: WorkClaimRequest & { actorId: string },
  context: { now: number; eventId: string; operatorActorId: string },
): PlannedWorkClaim {
  const action: WorkClaimAction = request.action ?? "claim";
  const { now } = context;
  const sessionAddress = trimmed(request.sessionAddress);
  const event = (kind: CollaborationEvent["kind"], summary: string, claim: WorkClaim | null): CollaborationEvent => ({
    id: context.eventId, recordId: record.id, recordKind: "work_item", kind, actorId: request.actorId, at: now, summary,
    metadata: { workClaim: { action, claim } },
  });

  if (action === "claim") {
    const applied = applyWorkClaim(record, { ...request, sessionAddress }, now);
    const response: WorkClaimResponse = { workId: record.id, action, claim: applied.claim, ownerId: applied.record.ownerId, ...(applied.renewed ? { renewed: true } : {}) };
    if (applied.renewed) return { response, record: applied.record };
    return { response, record: applied.record, event: event("claimed", `Claimed by ${holderLabel(applied.claim)}.`, applied.claim) };
  }

  const current = workClaimOf(record);
  const status = workClaimStatus(current, now);
  // A holder proves which attempt it is with the lease generation. A request
  // that omits it cannot tell a stale attempt from the current one, so it is
  // refused whenever the claim has a generation. The operator may release
  // without one.
  const generationMatches = (mayOmit: boolean) =>
    request.leaseGeneration === undefined
      ? mayOmit || current?.leaseGeneration === undefined
      : request.leaseGeneration === current?.leaseGeneration;
  const generationRefusal = (verb: "Renew" | "Release", hint: string) => conflict(
    "work_claim_stale_generation",
    record,
    request.leaseGeneration === undefined
      ? `${verb} refused: ${record.id} is at lease generation ${current?.leaseGeneration}; the request names none.`
      : `${verb} refused: lease generation ${request.leaseGeneration} is stale; ${record.id} is at generation ${current?.leaseGeneration}.`,
    request.leaseGeneration === undefined ? "Pass the lease generation from your claim." : hint,
    now,
    current,
  );

  if (action === "renew") {
    if (!current || status !== "active" || !holds(current, request.actorId, sessionAddress)) {
      if (current && status === "active") throw heldConflict(record, current, now, "Renew refused");
      throw conflict(
        "work_claim_not_held",
        record,
        `Renew refused: ${request.actorId} holds no active claim on ${record.id}${current ? `; the lease of ${holderLabel(current)} ended at ${new Date(current.leaseExpiresAt).toISOString()}` : ""}.`,
        "Claim it again; a new claim gets a new lease generation.",
        now,
        current,
      );
    }
    if (!generationMatches(false)) {
      throw generationRefusal(
        "Renew",
        "Another attempt holds this claim now. Stop work on this attempt, or read the item and use its current generation.",
      );
    }
    const applied = applyWorkClaim(record, { actorId: request.actorId, sessionAddress, leaseMs: request.leaseMs }, now);
    return { response: { workId: record.id, action, claim: applied.claim, ownerId: applied.record.ownerId, renewed: true }, record: applied.record };
  }

  if (action !== "release") {
    throw conflict("work_claim_not_held", record, `Unknown claim action ${String(action)}.`, "Use claim, renew or release.", now);
  }
  if (!current) return { response: { workId: record.id, action, claim: null, ...(record.ownerId ? { ownerId: record.ownerId } : {}) } };
  if (status === "active") {
    const isOperator = request.actorId === context.operatorActorId;
    const mayRelease = holds(current, request.actorId, sessionAddress) || isOperator;
    if (!mayRelease) throw heldConflict(record, current, now, "Release refused");
    if (!generationMatches(isOperator)) {
      throw generationRefusal("Release", "Another attempt holds this claim now; leave it to that attempt.");
    }
  }
  const released = withClaim(record, undefined, now);
  const summary = status === "expired"
    ? `Released the expired claim of ${holderLabel(current)}.`
    : `Released the claim of ${holderLabel(current)}.`;
  return {
    response: { workId: record.id, action, claim: null, ...(released.ownerId ? { ownerId: released.ownerId } : {}) },
    record: released,
    event: event("progressed", summary, null),
  };
}

/** A finished item holds no claim. */
export function dropClaimWhenTerminal<T extends CollaborationRecord>(record: T): T {
  if (record.kind !== "work_item" || !isWorkItemTerminalState(record.state) || !workClaimOf(record)) return record;
  const metadata = { ...(record.metadata ?? {}) };
  metadata[WORK_CLAIM_GENERATION_METADATA_KEY] = lastClaimGeneration(record);
  delete metadata[WORK_CLAIM_METADATA_KEY];
  return { ...record, metadata };
}

/**
 * Keep the claim through a whole-record write from a client.
 *
 * The claim belongs to the runtime: the stored claim replaces whatever the
 * incoming record carries, so a write built from a stale read cannot erase a
 * claim and a client cannot forge one. A write that hands an actively claimed
 * item to anyone but the holder is a conflict; the holder releases first.
 */
export function reconcileWorkClaimOnWrite(
  existing: CollaborationRecord | undefined,
  incoming: CollaborationRecord,
  now: number,
): CollaborationRecord {
  if (incoming.kind !== "work_item") return incoming;
  const held = existing?.kind === "work_item" ? workClaimOf(existing) : undefined;
  let claim = held;
  if (held && workClaimStatus(held, now) === "active") {
    if (incoming.ownerId !== held.claimantId) {
      throw conflict(
        "work_claim_held",
        incoming,
        `Write refused: it changes the owner of ${incoming.id} to ${incoming.ownerId ?? "nobody"}, but ${holderLabel(held)} holds it for ${leaseLeft(held, now)} more.`,
        `Claim it through the runtime (POST /v1/work/claim) after ${held.claimantId} releases it or the lease ends.`,
        now,
        held,
      );
    }
  } else if (held && incoming.ownerId !== held.claimantId) {
    // The lease ended and the owner moved on: the old claim no longer applies.
    claim = undefined;
  }
  // The generation counter belongs to the runtime too: a client write cannot
  // lower it.
  const generation = lastClaimGeneration(existing);
  const incomingGeneration = incoming.metadata?.[WORK_CLAIM_GENERATION_METADATA_KEY];
  if (
    !claim
    && !(incoming.metadata && WORK_CLAIM_METADATA_KEY in incoming.metadata)
    && (generation === 0 ? incomingGeneration === undefined : incomingGeneration === generation)
  ) return incoming;
  const metadata = { ...(incoming.metadata ?? {}) };
  if (generation > 0) metadata[WORK_CLAIM_GENERATION_METADATA_KEY] = generation;
  else delete metadata[WORK_CLAIM_GENERATION_METADATA_KEY];
  if (claim) metadata[WORK_CLAIM_METADATA_KEY] = claim;
  else delete metadata[WORK_CLAIM_METADATA_KEY];
  return dropClaimWhenTerminal({ ...incoming, metadata });
}
