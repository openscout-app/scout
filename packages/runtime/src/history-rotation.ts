import { flightCompletion } from "@openscout/protocol";
import type { CollaborationEvent, DeliveryAttempt, DeliveryIntent, DeliveryStatus, FlightRecord, InvocationRequest } from "@openscout/protocol";

import { isTerminalFlightState } from "./broker-local-invocation-helpers.js";
import {
  isTerminalInvocationDispatchJobState,
  type BrokerInvocationDispatchJob,
} from "./broker-dispatch-job.js";
import { asyncMessageRecordView, iterateMessageRecords } from "./broker-message-records.js";
import type { RuntimeRegistrySnapshot } from "./registry.js";

/**
 * Hot-set history rotation. `history.rotate` carries a week-clock cutoff; the
 * in-memory snapshot and the journal keep only records from the live windows
 * — SQLite holds everything. Eviction is a cache rotation, not a semantic
 * delete: no tombstones, no events, and never anything a live reader could
 * still need.
 *
 * Eviction follows a dependency closure, not record age alone:
 *
 * - PROTECTED: messages and invocations referenced by any non-terminal
 *   delivery, any non-terminal invocation dispatch job, any non-terminal
 *   flight, every read-cursor message anchor (`lastReadMessageId`) — plus
 *   the `messageId`/`replyToMessageId` of every invocation that is itself
 *   not evictable.
 * - Invocation: evictable only when `createdAt < cutoff`, it has at least
 *   one flight, every flight is terminal, and it is not protected. "No
 *   flight" is NOT terminal evidence — a flightless invocation stays.
 * - Flight: evictable only when terminal AND (`completedAt ?? startedAt`)
 *   < cutoff AND its invocation is evictable in the same rotation (or
 *   already absent). A terminal flight kept with its invocation is the
 *   evidence that lets a later rotation retire both — removing it early
 *   would leak the invocation forever.
 * - Message: evictable only when `createdAt < cutoff` and not protected.
 * - Delivery: evictable only when terminal AND (its referent was evicted by
 *   a rotation OR every referent is already absent from the snapshot —
 *   nothing left to protect). Unlinked intents carry no age evidence and
 *   are kept.
 * - Registry, conversation, and binding records are never touched — that
 *   is the retention sweep's job.
 *
 * OPENSCOUT_BROKER_DISK_HISTORY limitation: under the disk-backed async
 * message history, `snapshot.messages` is a proxy that cannot enumerate or
 * answer synchronous membership. Message eviction is not implemented there —
 * messages are retained and journal compaction keeps their lines (the doom
 * sets stay empty for messages), until disk-history rotation lands.
 */

/** Flight age is its terminal stamp; `startedAt` is the only older marker the record carries. */
function flightRotationTimestamp(flight: { completedAt?: number; startedAt?: number }): number {
  return flight.completedAt ?? flight.startedAt ?? 0;
}

function pendingFlightReports(flight: FlightRecord): Array<{ message?: { id?: string; replyToMessageId?: string } }> {
  return [flight.metadata?.resultReply, flight.metadata?.terminalReport].filter((intent) =>
    intent && typeof intent === "object" && (intent as { status?: unknown }).status === "pending") as Array<{ message?: { id?: string; replyToMessageId?: string } }>;
}
function hasPendingResultReply(flight: FlightRecord): boolean {
  return pendingFlightReports(flight).length > 0;
}

function hasPendingWorkPromotion(flight: FlightRecord): boolean {
  const intent = flight.metadata?.workPromotion;
  return Boolean(intent && typeof intent === "object" && (intent as { status?: unknown }).status === "pending");
}

const TERMINAL_DELIVERY_STATUSES = new Set<DeliveryStatus>([
  "completed",
  "failed",
  "cancelled",
  // Legacy terminal values kept for backwards-compatible journal replay.
  "acknowledged",
]);

export function isTerminalDeliveryStatus(status: DeliveryStatus): boolean {
  return TERMINAL_DELIVERY_STATUSES.has(status);
}

/**
 * Records outside the rotated snapshot that still constrain eviction. The
 * journal supplies its own delivery/dispatch-job maps; the runtime mirror
 * receives the same context from the daemon so both evict identically.
 */
export type HistoryRotationContext = {
  /** Non-terminal deliveries protect their message/invocation referents. */
  deliveries?: Iterable<DeliveryIntent>;
  /** Non-terminal dispatch jobs protect their invocation. */
  dispatchJobs?: Iterable<Pick<BrokerInvocationDispatchJob, "invocationId" | "state">>;
  /** Collaboration events are dooms candidates by `at < cutoff`. */
  collaborationEvents?: Iterable<Pick<CollaborationEvent, "id" | "at">>;
  /** Delivery attempts follow their delivery: evictable only when the delivery is evictable too (or already absent). */
  deliveryAttempts?: Iterable<DeliveryAttempt>;
  /**
   * Synchronous presence probe for a message id. The disk-backed async
   * history proxy cannot answer `in` reliably, so disk-history callers pass
   * a conservative `() => true` — a delivery whose message may live on disk
   * is never treated as referent-absent.
   */
  messageIdPresent?: (messageId: string) => boolean;
};

export type HistoryRotationEviction = {
  messageIds: Set<string>;
  flightIds: Set<string>;
  invocationIds: Set<string>;
};

/**
 * The full candidate eviction a rotation evaluates — every record the
 * closure rules would retire. The daemon verifies each id against durable
 * SQLite and journals only the `present` subset as the marker's `evicted`
 * sets, so apply and compaction doom exactly verified rows.
 */
export type HistoryRotationPlan = {
  messageIds: Set<string>;
  invocationIds: Set<string>;
  flightIds: Set<string>;
  deliveryIds: Set<string>;
  deliveryAttemptIds: Set<string>;
  collaborationEventIds: Set<string>;
};

export function emptyHistoryRotationPlan(): HistoryRotationPlan {
  return {
    messageIds: new Set(),
    invocationIds: new Set(),
    flightIds: new Set(),
    deliveryIds: new Set(),
    deliveryAttemptIds: new Set(),
    collaborationEventIds: new Set(),
  };
}

/** Message ids an invocation references — its own message plus any reply target. */
function invocationMessageReferences(invocation: InvocationRequest): string[] {
  const ids: string[] = [];
  if (invocation.messageId) ids.push(invocation.messageId);
  const replyTo = (invocation as { replyToMessageId?: unknown }).replyToMessageId;
  if (typeof replyTo === "string" && replyTo.length > 0) ids.push(replyTo);
  return ids;
}

/**
 * Compute the full candidate eviction under the dependency-closure rules —
 * WITHOUT mutating `snapshot`. The daemon runs this at planning time, then
 * verifies every id against durable SQLite before journaling the `present`
 * subset as the marker's `evicted` sets. Apply and compaction doom exactly
 * those ids; the rules never run again.
 */
export function planHistoryRotation(
  snapshot: RuntimeRegistrySnapshot,
  cutoff: number,
  context: HistoryRotationContext = {},
): HistoryRotationPlan {
  const protectedMessageIds = new Set<string>();
  const protectedInvocationIds = new Set<string>();
  const protectedCompletionFlights = new Set<string>();

  // Context iterables may be one-shot (the journal hands live `.values()`
  // iterators) and deliveries are consulted twice — protection first, doom
  // last — so materialize them up front.
  const deliveries = [...(context.deliveries ?? [])];
  const collaborationEvents = [...(context.collaborationEvents ?? [])];
  const deliveryAttempts = [...(context.deliveryAttempts ?? [])];

  // Non-terminal deliveries still have retry work on their referents.
  for (const delivery of deliveries) {
    if (isTerminalDeliveryStatus(delivery.status)) continue;
    if (delivery.messageId) protectedMessageIds.add(delivery.messageId);
    if (delivery.invocationId) protectedInvocationIds.add(delivery.invocationId);
  }
  // A pending/running dispatch job may still need to re-read the invocation.
  for (const job of context.dispatchJobs ?? []) {
    if (!isTerminalInvocationDispatchJobState(job.state)) {
      protectedInvocationIds.add(job.invocationId);
    }
  }
  // Non-terminal flights keep their invocation alive.
  const flightsByInvocation = new Map<string, FlightRecord[]>();
  for (const flight of Object.values(snapshot.flights)) {
    const list = flightsByInvocation.get(flight.invocationId) ?? [];
    list.push(flight);
    flightsByInvocation.set(flight.invocationId, list);
    if (!isTerminalFlightState(flight.state) || hasPendingResultReply(flight) || hasPendingWorkPromotion(flight)) {
      protectedInvocationIds.add(flight.invocationId);
    }
    if (!isTerminalFlightState(flight.state)) for (const obligation of flightCompletion(flight)?.obligations ?? []) {
      protectedInvocationIds.add(obligation.invocationId);
      protectedCompletionFlights.add(obligation.flightId);
    }
    for (const { message } of pendingFlightReports(flight)) {
      if (message?.id) protectedMessageIds.add(message.id);
      if (message?.replyToMessageId) protectedMessageIds.add(message.replyToMessageId);
    }
  }
  // Read cursors survive rotation but still reference their anchor
  // messages — keep those anchors resolvable.
  for (const cursor of Object.values(snapshot.readCursors)) {
    if (cursor.lastReadMessageId) {
      protectedMessageIds.add(cursor.lastReadMessageId);
    }
  }

  // Invocation: evictable only when old, flighted, all-terminal, unprotected.
  const evictableInvocationIds = new Set<string>();
  for (const invocation of Object.values(snapshot.invocations)) {
    if (invocation.createdAt >= cutoff) continue;
    if (protectedInvocationIds.has(invocation.id)) continue;
    const flights = flightsByInvocation.get(invocation.id);
    if (!flights || flights.length === 0) continue; // no flight is not terminal evidence
    if (flights.every((flight) => isTerminalFlightState(flight.state))) {
      evictableInvocationIds.add(invocation.id);
    }
  }

  // Every invocation that survives protects the message it was raised against.
  for (const invocation of Object.values(snapshot.invocations)) {
    if (evictableInvocationIds.has(invocation.id)) continue;
    for (const messageId of invocationMessageReferences(invocation)) {
      protectedMessageIds.add(messageId);
    }
  }

  const plan = emptyHistoryRotationPlan();
  // Disk-backed async history cannot enumerate synchronously; message
  // eviction is not implemented there — see the file header.
  if (!asyncMessageRecordView(snapshot.messages)) {
    for (const record of iterateMessageRecords(snapshot.messages)) {
      if (record.createdAt < cutoff && !protectedMessageIds.has(record.id)) {
        plan.messageIds.add(record.id);
      }
    }
  }

  for (const flight of Object.values(snapshot.flights)) {
    if (!isTerminalFlightState(flight.state)) continue;
    if (hasPendingResultReply(flight) || hasPendingWorkPromotion(flight) || protectedCompletionFlights.has(flight.id)) continue;
    if (flightRotationTimestamp(flight) >= cutoff) continue;
    // A terminal flight is evictable only when its invocation is leaving
    // too (or is already gone). Keeping it while the invocation survives
    // preserves the evidence a later rotation needs to retire both.
    if (!evictableInvocationIds.has(flight.invocationId)
        && flight.invocationId in snapshot.invocations) continue;
    plan.flightIds.add(flight.id);
  }

  for (const id of evictableInvocationIds) {
    if (id in snapshot.invocations) {
      plan.invocationIds.add(id);
    }
  }

  // Terminal deliveries doomed by referent loss — the same rule
  // deliveryRotatedWithReferents applies post-eviction, expressed against
  // the planned sets so the planner never mutates the snapshot.
  const deliveryIdsInSnapshot = new Set(deliveries.map((delivery) => delivery.id));
  for (const delivery of deliveries) {
    if (deliveryDoomedByPlan(delivery, plan, snapshot, context)) {
      plan.deliveryIds.add(delivery.id);
    }
  }

  // An attempt is part of its delivery's history: evictable only when the
  // delivery leaves in the same rotation or is already absent — never by
  // age alone, so an unverified delivery keeps its attempts too.
  for (const attempt of deliveryAttempts) {
    if (plan.deliveryIds.has(attempt.deliveryId) || !deliveryIdsInSnapshot.has(attempt.deliveryId)) {
      plan.deliveryAttemptIds.add(attempt.id);
    }
  }

  for (const event of collaborationEvents) {
    if (event.at < cutoff) {
      plan.collaborationEventIds.add(event.id);
    }
  }

  return plan;
}

/** Delete exactly the verified ids — apply never recomputes eligibility. */
export function applyHistoryRotationEviction(
  snapshot: RuntimeRegistrySnapshot,
  evicted: Pick<HistoryRotationPlan, "messageIds" | "invocationIds" | "flightIds">,
): void {
  for (const id of evicted.messageIds) {
    delete snapshot.messages[id];
  }
  for (const id of evicted.invocationIds) {
    delete snapshot.invocations[id];
  }
  for (const id of evicted.flightIds) {
    delete snapshot.flights[id];
  }
}

/**
 * Legacy path for `history.rotate` markers that predate the `evicted` sets:
 * recompute the candidate plan under the closure rules and evict it. New
 * markers carry verified id sets and never reach this code — they remove
 * exactly what was journaled.
 */
export function rotateHistoryInSnapshot(
  snapshot: RuntimeRegistrySnapshot,
  cutoff: number,
  context: HistoryRotationContext = {},
): HistoryRotationEviction {
  const plan = planHistoryRotation(snapshot, cutoff, context);
  applyHistoryRotationEviction(snapshot, plan);
  return {
    messageIds: plan.messageIds,
    flightIds: plan.flightIds,
    invocationIds: plan.invocationIds,
  };
}

/**
 * The referent-loss rule expressed against a planned (not yet applied)
 * eviction: `snapshot` is the PRE-rotation state, so "present" means in the
 * snapshot and NOT planned for eviction. Semantically identical to
 * deliveryRotatedWithReferents evaluated post-eviction.
 */
function deliveryDoomedByPlan(
  delivery: DeliveryIntent,
  plan: Pick<HistoryRotationPlan, "messageIds" | "invocationIds">,
  snapshot: RuntimeRegistrySnapshot,
  context: HistoryRotationContext = {},
): boolean {
  if (!isTerminalDeliveryStatus(delivery.status)) return false;
  if (!delivery.messageId && !delivery.invocationId) return false;

  const messagePresent = delivery.messageId !== undefined
    && (context.messageIdPresent
      ? context.messageIdPresent(delivery.messageId)
      : delivery.messageId in snapshot.messages
        && !plan.messageIds.has(delivery.messageId));
  const invocationPresent = delivery.invocationId !== undefined
    && delivery.invocationId in snapshot.invocations
    && !plan.invocationIds.has(delivery.invocationId);

  if (!messagePresent && !invocationPresent) return true;
  return Boolean(
    (delivery.messageId && plan.messageIds.has(delivery.messageId))
      || (delivery.invocationId && plan.invocationIds.has(delivery.invocationId)),
  );
}

/**
 * Whether a delivery is rotated out: the delivery must be terminal (an
 * in-flight intent still has retry work) AND either linked to a referent
 * this rotation evicted, or every referent is already absent from the
 * snapshot — a missing referent has nothing left to protect. Unlinked
 * deliveries carry no referent ids at all; with no evidence they are kept.
 *
 * `snapshot` is inspected AFTER the rotation eviction ran, so "absent"
 * covers both records this rotation removed and referents that never made
 * it into the hot set.
 */
export function deliveryRotatedWithReferents(
  delivery: DeliveryIntent,
  evicted: HistoryRotationEviction,
  snapshot: RuntimeRegistrySnapshot,
  context: HistoryRotationContext = {},
): boolean {
  if (!isTerminalDeliveryStatus(delivery.status)) return false;
  if (!delivery.messageId && !delivery.invocationId) return false;

  const messagePresent = delivery.messageId !== undefined
    && (context.messageIdPresent
      ? context.messageIdPresent(delivery.messageId)
      : delivery.messageId in snapshot.messages);
  const invocationPresent = delivery.invocationId !== undefined
    && delivery.invocationId in snapshot.invocations;

  if (!messagePresent && !invocationPresent) return true;
  return Boolean(
    (delivery.messageId && evicted.messageIds.has(delivery.messageId))
      || (delivery.invocationId && evicted.invocationIds.has(delivery.invocationId)),
  );
}

/** Candidate records the post-verification closure needs to resolve edges. */
export type HistoryRotationRecordLookup = {
  invocation?: (id: string) => InvocationRequest | undefined;
  flight?: (id: string) => FlightRecord | undefined;
  delivery?: (id: string) => DeliveryIntent | undefined;
  deliveryAttempt?: (id: string) => DeliveryAttempt | undefined;
};

const ROTATION_PLAN_KEYS = [
  "messageIds",
  "invocationIds",
  "flightIds",
  "deliveryIds",
  "deliveryAttemptIds",
  "collaborationEventIds",
] as const;

/**
 * Re-run the dependency closure AFTER durable verification. The planner's
 * closure assumed every planned record would leave; verification can refuse
 * individual ids, and a retained record must hold its whole
 * dependency-connected component: an invocation that stays keeps its
 * message, flights, deliveries, and attempts; a kept message keeps the
 * deliveries and attempts referencing it, and so on. Eviction is therefore
 * all-or-nothing per connected component — the demotion propagates to a
 * fixpoint (bounded by the candidate count), equivalent to treating every
 * retained record as live and recomputing.
 */
export function refineVerifiedRotation(
  present: HistoryRotationPlan,
  missing: HistoryRotationPlan,
  records: HistoryRotationRecordLookup = {},
): { evictable: HistoryRotationPlan; retained: HistoryRotationPlan } {
  const evictable = emptyHistoryRotationPlan();
  const retained = emptyHistoryRotationPlan();
  for (const key of ROTATION_PLAN_KEYS) {
    for (const id of present[key]) evictable[key].add(id);
    for (const id of missing[key]) retained[key].add(id);
  }

  // Nodes are category-namespaced — a message id equal to an invocation id
  // must never collapse into one graph node.
  type PlanKey = (typeof ROTATION_PLAN_KEYS)[number];
  const node = (key: PlanKey, id: string) => `${key}:${id}`;
  const candidates = new Set<string>();
  for (const key of ROTATION_PLAN_KEYS) {
    for (const id of evictable[key]) candidates.add(node(key, id));
    for (const id of retained[key]) candidates.add(node(key, id));
  }

  // Undirected referent edges between candidates: a surviving dependent
  // must not lose its referent, and a surviving referent must not lose the
  // dependents that give it meaning. Only candidates can be demoted —
  // non-candidate referents survive regardless.
  const adjacent = new Map<string, Set<string>>();
  const link = (from: string, toKey: PlanKey, toId: string | undefined): void => {
    if (!toId) return;
    const to = node(toKey, toId);
    if (!candidates.has(to)) return;
    let list = adjacent.get(from);
    if (!list) adjacent.set(from, (list = new Set()));
    list.add(to);
    list = adjacent.get(to);
    if (!list) adjacent.set(to, (list = new Set()));
    list.add(from);
  };
  const forEachCandidate = (key: PlanKey, fn: (id: string) => void): void => {
    for (const id of evictable[key]) fn(id);
    for (const id of retained[key]) fn(id);
  };
  forEachCandidate("invocationIds", (id) => {
    const invocation = records.invocation?.(id);
    if (invocation) {
      for (const messageId of invocationMessageReferences(invocation)) {
        link(node("invocationIds", id), "messageIds", messageId);
      }
    }
  });
  forEachCandidate("flightIds", (id) => {
    link(node("flightIds", id), "invocationIds", records.flight?.(id)?.invocationId);
  });
  forEachCandidate("deliveryIds", (id) => {
    const delivery = records.delivery?.(id);
    if (delivery) {
      link(node("deliveryIds", id), "messageIds", delivery.messageId);
      link(node("deliveryIds", id), "invocationIds", delivery.invocationId);
    }
  });
  forEachCandidate("deliveryAttemptIds", (id) => {
    link(node("deliveryAttemptIds", id), "deliveryIds", records.deliveryAttempt?.(id)?.deliveryId);
  });

  // Multi-source BFS from every retained node: any candidate reachable from
  // a retained record is retained too — eviction is all-or-nothing per
  // connected component.
  const queue: string[] = [];
  for (const key of ROTATION_PLAN_KEYS) {
    for (const id of retained[key]) queue.push(node(key, id));
  }
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const next of adjacent.get(current) ?? []) {
      const separator = next.indexOf(":");
      const key = next.slice(0, separator) as PlanKey;
      const id = next.slice(separator + 1);
      if (evictable[key].delete(id)) {
        retained[key].add(id);
        queue.push(next);
      }
    }
  }

  return { evictable, retained };
}

/**
 * The verification contract: `present` and `missing` partition the plan —
 * every planned id in exactly one set, no id in both or neither, and no id
 * the plan did not name. A violation means the verifier's answer is
 * untrustworthy; throw rather than evict on it.
 */
export function assertRotationPlanPartition(
  plan: HistoryRotationPlan,
  present: HistoryRotationPlan,
  missing: HistoryRotationPlan,
): void {
  for (const key of ROTATION_PLAN_KEYS) {
    for (const id of present[key]) {
      if (missing[key].has(id)) {
        throw new Error(`rotation verification returned ${key} id ${id} as both present and missing`);
      }
      if (!plan[key].has(id)) {
        throw new Error(`rotation verification returned unplanned ${key} id ${id} as present`);
      }
    }
    for (const id of missing[key]) {
      if (!plan[key].has(id)) {
        throw new Error(`rotation verification returned unplanned ${key} id ${id} as missing`);
      }
    }
    for (const id of plan[key]) {
      if (!present[key].has(id) && !missing[key].has(id)) {
        throw new Error(`rotation verification left planned ${key} id ${id} unanswered`);
      }
    }
  }
}
