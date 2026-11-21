import { invocationWorkId, isFailedWork, projectWorkFlight } from "./broker-failed-work.js";
import { createHash } from "node:crypto";
import { isTerminalFlightState } from "./broker-local-invocation-helpers.js";

import {
  taskReadyOf,
  assertValidCollaborationEvent,
  assertValidCollaborationRecord,
  rolePassAssignmentId,
  type CollaborationEvent,
  type CollaborationPriority,
  type CollaborationRecord,
  type FlightRecord,
  type InvocationRequest,
  type ScoutDeliverRequest,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";
import { planReadyWorkItem, TASK_READY_PRIOR_ACCEPTANCE_KEY } from "./broker-task-ready.js";

type DurableStore = {
  runWrite<T>(work: () => Promise<T>): Promise<T>;
  commitEntries(
    entries: BrokerJournalEntry | BrokerJournalEntry[],
    applyRuntime: (entries: BrokerJournalEntry[]) => Promise<void>,
    options?: { enqueueProjection?: boolean },
  ): Promise<BrokerJournalEntry[]>;
  applyProjectedEntries(entries: BrokerJournalEntry | BrokerJournalEntry[]): Promise<void>;
};

type WorkItemRuntime = {
  collaborationRecord(recordId: string): CollaborationRecord | undefined;
  flight(flightId: string): FlightRecord | undefined;
  flightForInvocation(invocationId: string): FlightRecord | undefined;
  upsertFlight(flight: FlightRecord, options?: { preserveCurrent?: boolean }): Promise<void>;
  upsertCollaboration(record: CollaborationRecord): Promise<void>;
  appendCollaborationEvent(event: CollaborationEvent): Promise<void>;
};

export type DeliveryWorkItemResolution = {
  record: CollaborationRecord | null;
  collaborationRecordId?: string;
  pendingCreation?: { record: CollaborationRecord; event: CollaborationEvent };
};

export type BrokerWorkItemStoreOptions = {
  runtime: WorkItemRuntime;
  durableStore: DurableStore;
  createId: (prefix: string) => string;
  /** Journal state remains canonical even if the runtime apply callback failed. */
  durableFlight?: (flightId: string) => FlightRecord | undefined;
  durableCurrentFlight?: (invocationId: string) => FlightRecord | undefined;
  durableWorkItem?: (workId: string) => CollaborationRecord | undefined;
  newestFlightForWork?: (workId: string) => FlightRecord | undefined;
  /** Gives a runtime-driven state change its lifecycle placement and ledger move. */
  placeWorkChange?: (
    before: CollaborationRecord,
    after: CollaborationRecord,
    context: { now: number; actorId: string; moveId: string },
  ) => { record: CollaborationRecord; move?: unknown };
  warn?: (message: string, error: unknown) => void;
  /** Ready work waits on the operator, whoever asked for it. */
  operatorActorId?: string;
};

export type RecordDeliveryWorkItemInput = {
  payload: ScoutDeliverRequest;
  requestId: string;
  requesterId: string;
  targetAgentId: string;
  conversationId: string;
  createdAt: number;
};

function metadataStringValue(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeScoutLabels(labels: string[] | undefined): string[] {
  if (!labels) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const label of labels) {
    const trimmed = label.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function mergeScoutLabels(
  left: string[] | undefined,
  right: string[] | undefined,
): string[] | undefined {
  const merged = normalizeScoutLabels([...(left ?? []), ...(right ?? [])]);
  return merged.length ? merged : undefined;
}

function normalizeComparableDeliveryValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeComparableDeliveryValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeComparableDeliveryValue(entry)] as const),
    );
  }
  return value;
}

function sameDeliveryWorkItemValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeComparableDeliveryValue(left))
    === JSON.stringify(normalizeComparableDeliveryValue(right));
}

function sameDeliveryWorkItemLabels(left: string[] | undefined, right: string[] | undefined): boolean {
  return sameDeliveryWorkItemValue(left ?? [], right ?? []);
}

function metadataContainsDeliveryWorkItemValues(
  existing: Record<string, unknown> | undefined,
  expected: Record<string, unknown> | undefined,
): boolean {
  for (const [key, value] of Object.entries(expected ?? {})) {
    if (value === undefined) {
      continue;
    }
    if (!sameDeliveryWorkItemValue(existing?.[key], value)) {
      return false;
    }
  }
  return true;
}

function deliveryWorkItemFingerprint(record: CollaborationRecord): string {
  const metadata = { ...(record.metadata ?? {}) };
  delete metadata.deliveryWorkItemFingerprint;
  const identity = normalizeComparableDeliveryValue({
    title: record.title,
    summary: record.summary,
    acceptanceState: record.acceptanceState,
    createdById: record.createdById,
    ownerId: record.ownerId,
    nextMoveOwnerId: record.nextMoveOwnerId,
    conversationId: record.conversationId,
    parentId: record.parentId,
    priority: record.priority,
    labels: record.labels,
    requestedById: record.kind === "work_item" ? record.requestedById : undefined,
    metadata,
  });
  return createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
}

export function existingDeliveryWorkItemMatches(
  existing: CollaborationRecord,
  proposed: CollaborationRecord,
): boolean {
  if (existing.kind !== "work_item" || proposed.kind !== "work_item") {
    return false;
  }

  const existingFingerprint = metadataStringValue(
    existing.metadata,
    "deliveryWorkItemFingerprint",
  );
  if (existingFingerprint) {
    return existingFingerprint === deliveryWorkItemFingerprint(proposed);
  }

  return existing.title === proposed.title
    && (existing.summary ?? "") === (proposed.summary ?? "")
    && existing.createdById === proposed.createdById
    && existing.conversationId === proposed.conversationId
    && existing.parentId === proposed.parentId
    && existing.priority === proposed.priority
    && sameDeliveryWorkItemLabels(existing.labels, proposed.labels)
    && existing.requestedById === proposed.requestedById
    && metadataContainsDeliveryWorkItemValues(existing.metadata, proposed.metadata);
}


export type WorkPromotionIntent = {
  version: 1;
  status: "pending" | "applied" | "superseded";
  workId: string;
  invocationId: string;
  flightId: string;
  flightState: FlightRecord["state"];
  conversationId?: string;
  messageId?: string;
  eventId: string;
  expectedRecordHash: string | null;
  at: number;
  settledAt?: number;
};

function workPromotionEventId(flight: FlightRecord, workId: string): string {
  return `work-flight-${createHash("sha256").update(JSON.stringify([workId, flight.invocationId, flight.id])).digest("hex").slice(0, 32)}`;
}

function workRecordHash(record: CollaborationRecord): string {
  return createHash("sha256").update(JSON.stringify(normalizeComparableDeliveryValue(record))).digest("hex");
}

function workItemProtected(record: CollaborationRecord): boolean {
  return record.kind !== "work_item" || record.state === "done" || record.state === "cancelled"
    || record.acceptanceState === "accepted"
    // Board owns a Board item's state: its custodian settles the task, and the result returns as an event.
    || record.externalContext?.source.adapterId === "vercel-board";
}

export class BrokerWorkItemStore {
  constructor(private readonly options: BrokerWorkItemStoreOptions) {}

  /** Called synchronously inside the terminal flight's canonical writer. */
  readonly prepareTerminalWorkPromotion = (
    flight: FlightRecord,
    invocation: InvocationRequest | undefined,
    previous?: FlightRecord,
  ): FlightRecord => {
    const { workPromotion: _untrusted, ...metadata } = flight.metadata ?? {};
    previous = this.options.durableFlight?.(flight.id) ?? previous;
    if (previous?.metadata?.workPromotion !== undefined) {
      return { ...flight, metadata: { ...metadata, workPromotion: previous.metadata.workPromotion } };
    }
    const workId = invocation && invocationWorkId(invocation);
    if (!invocation || !workId || !isTerminalFlightState(flight.state)) return { ...flight, metadata };
    const record = this.options.durableWorkItem ? this.options.durableWorkItem(workId) : this.options.runtime.collaborationRecord(workId);
    if (record && workItemProtected(record)) return { ...flight, metadata };
    const intent: WorkPromotionIntent = {
      version: 1, status: "pending", workId, invocationId: invocation.id, flightId: flight.id,
      flightState: flight.state, conversationId: invocation.conversationId, messageId: invocation.messageId, eventId: workPromotionEventId(flight, workId),
      expectedRecordHash: record ? workRecordHash(record) : null, at: flight.completedAt ?? Date.now(),
    };
    return { ...flight, metadata: { ...metadata, workPromotion: intent } };
  };

  /** Bounded caller-owned pages; one failed record cannot block another. */
  readonly recoverTerminalWorkPromotions = async (flights: Iterable<FlightRecord>): Promise<void> => {
    for (const flight of flights) {
      try { await this.applyTerminalWorkPromotion(flight.id); }
      catch (error) { this.options.warn?.(`[openscout-runtime] work promotion ${flight.id} remains pending:`, error); }
    }
  };

  /** Prepare canonical data; the acceptance writer rechecks and commits it with the ask. */
  readonly prepareDeliveryWorkItemIfNeeded = async (input: RecordDeliveryWorkItemInput): Promise<DeliveryWorkItemResolution> => {
    const record = this.buildDeliveryWorkItem(input);
    if (!record) return this.deliveryWorkItemResolutionForTell(input.payload);
    const existing = this.options.runtime.collaborationRecord(record.id);
    if (existing) return existingDeliveryWorkItemMatches(existing, record)
      ? { record: existing, collaborationRecordId: existing.id } : { record: null };
    const event = this.buildDeliveryWorkItemCreatedEvent(record, input);
    assertValidCollaborationRecord(record);
    assertValidCollaborationEvent(event, record);
    return { record, collaborationRecordId: record.id, pendingCreation: { record, event } };
  };

  readonly recordDeliveryWorkItemIfNeeded = async (
    input: RecordDeliveryWorkItemInput,
  ): Promise<DeliveryWorkItemResolution> => {
    const record = this.buildDeliveryWorkItem(input);
    if (!record) {
      return this.deliveryWorkItemResolutionForTell(input.payload);
    }

    const result = await this.options.durableStore.runWrite(async (): Promise<DeliveryWorkItemResolution & { entries?: BrokerJournalEntry[] }> => {
      const existing = this.options.runtime.collaborationRecord(record.id);
      if (existing) {
        if (existingDeliveryWorkItemMatches(existing, record)) {
          return {
            record: existing,
            collaborationRecordId: existing.id,
          };
        }
        return { record: null };
      }

      const event = this.buildDeliveryWorkItemCreatedEvent(record, input);
      assertValidCollaborationRecord(record);
      assertValidCollaborationEvent(event, record);
      const entries = await this.options.durableStore.commitEntries(
        [
          { kind: "collaboration.record", record },
          { kind: "collaboration.event.record", event },
        ],
        async (retainedEntries) => {
          for (const entry of retainedEntries) {
            if (entry.kind === "collaboration.record") {
              await this.options.runtime.upsertCollaboration(entry.record);
            } else if (entry.kind === "collaboration.event.record") {
              await this.options.runtime.appendCollaborationEvent(entry.event);
            }
          }
        },
        { enqueueProjection: false },
      );
      return {
        record,
        collaborationRecordId: record.id,
        entries,
      };
    });

    if (result.entries) {
      await this.options.durableStore.applyProjectedEntries(result.entries);
    }
    return {
      record: result.record,
      ...(result.collaborationRecordId ? { collaborationRecordId: result.collaborationRecordId } : {}),
    };
  };

  readonly deliveryWorkItemResolutionForTell = (payload: ScoutDeliverRequest): DeliveryWorkItemResolution => {
    // A role pass never links a card: its end would move the card and start another pass.
    if (rolePassAssignmentId(payload.invocationMetadata)) return { record: null };
    const collaborationRecordId = payload.collaborationRecordId?.trim();
    return {
      record: null,
      ...(collaborationRecordId ? { collaborationRecordId } : {}),
    };
  };

  readonly promoteInvocationFlightToWork = async (
    _invocation: InvocationRequest,
    flight: FlightRecord,
    _output: string | undefined,
  ): Promise<void> => this.applyTerminalWorkPromotion(flight.id);

  private readonly applyTerminalWorkPromotion = async (flightId: string): Promise<void> => {
    const entries = await this.options.durableStore.runWrite(async () => {
      const flight = this.options.durableFlight ? this.options.durableFlight(flightId) : this.options.runtime.flight(flightId);
      const intent = flight?.metadata?.workPromotion as WorkPromotionIntent | undefined;
      if (!flight || !intent || intent.status !== "pending") return [];
      if (intent.version !== 1 || !isTerminalFlightState(flight.state)
        || intent.flightId !== flight.id || intent.invocationId !== flight.invocationId
        || intent.flightState !== flight.state || typeof intent.workId !== "string" || !intent.workId
        || intent.eventId !== workPromotionEventId(flight, intent.workId)
        || (intent.expectedRecordHash !== null && (typeof intent.expectedRecordHash !== "string" || !intent.expectedRecordHash))
        || !Number.isFinite(intent.at) || (flight.completedAt !== undefined && intent.at !== flight.completedAt)) {
        throw new Error("Malformed work promotion intent; automatic recovery held");
      }
      if (intent.expectedRecordHash === null) throw new Error("Work item baseline unavailable; automatic promotion held");
      const record = this.options.durableWorkItem ? this.options.durableWorkItem(intent.workId) : this.options.runtime.collaborationRecord(intent.workId);
      if (!record) throw new Error(`Work item ${intent.workId} is unavailable; promotion remains pending`);
      const latest = this.options.newestFlightForWork?.(intent.workId) ?? flight;
      const current = this.options.durableCurrentFlight?.(latest.invocationId) ?? this.options.runtime.flightForInvocation(latest.invocationId);
      if (current?.id !== latest.id || record.kind !== "work_item" || workItemProtected(record)
        || (latest.id !== flight.id && record.metadata?.lastFlightId === latest.id && record.metadata?.lastFlightState === latest.state)
        || record.updatedAt > intent.at || workRecordHash(record) !== intent.expectedRecordHash) {
        const acknowledged = { ...flight, metadata: { ...flight.metadata,
          workPromotion: { ...intent, status: "superseded", settledAt: Date.now() },
        } };
        return this.options.durableStore.commitEntries({ kind: "flight.record", flight: acknowledged, preserveCurrent: true },
          async () => { await this.options.runtime.upsertFlight(acknowledged, { preserveCurrent: true }); },
          { enqueueProjection: false });
      }
      // Reconstruct only from durable identifiers; no execution or network work.
      const invocation = { id: flight.invocationId, conversationId: intent.conversationId, messageId: intent.messageId };
      const now = intent.at;
      const promotedRecord = projectWorkFlight(record, latest, now, { operatorActorId: this.options.operatorActorId });
      const nextEventKind = latest.state === "completed" ? promotedRecord.state === "review" ? "review_requested" : "done"
        : latest.state === "failed" ? "waiting" : latest.state === "cancelled" ? "cancelled" : "progressed";
      const summary = promotedRecord.progress?.summary;

      const placed = this.options.placeWorkChange?.(record, promotedRecord, {
        now, actorId: flight.targetAgentId, moveId: `${intent.eventId}:move`,
      });
      const nextRecord = placed?.record ?? promotedRecord;
      const event: CollaborationEvent = {
        id: intent.eventId,
        recordId: nextRecord.id,
        recordKind: "work_item",
        kind: nextEventKind,
        actorId: flight.targetAgentId,
        at: now,
        summary,
        metadata: {
          source: "broker",
          invocationId: latest.invocationId,
          flightId: latest.id,
          flightState: latest.state,
          ...(latest.id !== flight.id ? { supersededFlightId: flight.id } : {}),
          conversationId: invocation.conversationId,
          messageId: invocation.messageId,
          ...(placed?.move ? { workMove: placed.move } : {}),
        },
      };
      assertValidCollaborationRecord(nextRecord);
      assertValidCollaborationEvent(event, nextRecord);
      const acknowledged = { ...flight, metadata: { ...flight.metadata,
        workPromotion: { ...intent, status: "applied", settledAt: Date.now() },
      } };
      return this.options.durableStore.commitEntries(
        [
          { kind: "collaboration.record", record: nextRecord },
          { kind: "collaboration.event.record", event },
          { kind: "flight.record", flight: acknowledged, preserveCurrent: true },
        ],
        async (retainedEntries) => {
          for (const entry of retainedEntries) {
            if (entry.kind === "collaboration.record") await this.options.runtime.upsertCollaboration(entry.record);
            else if (entry.kind === "collaboration.event.record") await this.options.runtime.appendCollaborationEvent(entry.event);
            else if (entry.kind === "flight.record") await this.options.runtime.upsertFlight(entry.flight, { preserveCurrent: true });
          }
        },
        { enqueueProjection: false },
      );
    });
    // Projection is replayable; never hold the canonical writer for it.
    await this.options.durableStore.applyProjectedEntries(entries);
  };

  /** Startup uses stable caller-owned pages. No timer and no text inference. */
  readonly reconcileFailedWorkItems = async (records: Iterable<CollaborationRecord>): Promise<void> => {
    for (const candidate of records) {
      try {
        const entries = await this.options.durableStore.runWrite(async () => {
          const record = this.options.durableWorkItem?.(candidate.id) ?? this.options.runtime.collaborationRecord(candidate.id);
          const latest = this.options.newestFlightForWork?.(candidate.id);
          if (!record || !latest || !isFailedWork(record, latest) || workItemProtected(record)) return [];
          const now = Math.max(record.updatedAt, latest.completedAt ?? latest.startedAt ?? 0);
          const projected = projectWorkFlight(record, latest, now, { operatorActorId: this.options.operatorActorId });
          if (sameDeliveryWorkItemValue(record, projected)) return [];
          const eventId = `work-failed-reconcile-${createHash("sha256").update(JSON.stringify([record.id, latest.id, latest.state])).digest("hex").slice(0, 32)}`;
          const placed = this.options.placeWorkChange?.(record, projected, { now, actorId: latest.targetAgentId, moveId: `${eventId}:move` });
          const next = placed?.record ?? projected;
          const event: CollaborationEvent = { id: eventId, recordId: record.id, recordKind: "work_item",
            kind: next.state === "review" ? "review_requested" : next.state === "working" ? "progressed" : next.state as "waiting" | "done" | "cancelled",
            actorId: latest.targetAgentId, at: now, summary: projected.progress?.summary,
            metadata: { source: "failed_run_reconciliation", flightId: latest.id, ...(placed?.move ? { workMove: placed.move } : {}) } };
          assertValidCollaborationRecord(next);
          assertValidCollaborationEvent(event, next);
          return this.options.durableStore.commitEntries([
            { kind: "collaboration.record", record: next }, { kind: "collaboration.event.record", event },
          ], async () => { await this.options.runtime.upsertCollaboration(next); await this.options.runtime.appendCollaborationEvent(event); }, { enqueueProjection: false });
        });
        await this.options.durableStore.applyProjectedEntries(entries);
      } catch (error) {
        this.options.warn?.(`[openscout-runtime] failed-work repair ${candidate.id} skipped:`, error);
      }
    }
  };

  /**
   * A Ready flight that is still open (waiting on review) has no terminal
   * promotion. Land its work item in review here, once.
   */
  readonly landReadyWorkItem = async (flight: FlightRecord, invocation: InvocationRequest | undefined): Promise<void> => {
    const ready = taskReadyOf(flight);
    const operatorActorId = this.options.operatorActorId;
    const workId = invocation && invocationWorkId(invocation);
    if (!ready || !operatorActorId || !workId || isTerminalFlightState(flight.state)) return;
    const entries = await this.options.durableStore.runWrite(async () => {
      const record = this.options.runtime.collaborationRecord(workId);
      if (!record || record.kind !== "work_item" || workItemProtected(record)) return [];
      const planned = planReadyWorkItem(record, { operatorActorId, summary: ready.summary, now: ready.at, flightId: flight.id });
      if (!planned) return [];
      const placed = this.options.placeWorkChange?.(record, planned, { now: ready.at, actorId: flight.targetAgentId, moveId: `${flight.id}:ready:move` });
      const nextRecord = placed?.record ?? planned;
      const event: CollaborationEvent = {
        id: `work-ready-${flight.id}`, recordId: nextRecord.id, recordKind: "work_item", kind: "review_requested",
        actorId: flight.targetAgentId, at: ready.at, summary: ready.summary || "Ready.",
        metadata: { source: "scout-ready", flightId: flight.id, invocationId: flight.invocationId, ...(placed?.move ? { workMove: placed.move } : {}) },
      };
      assertValidCollaborationRecord(nextRecord);
      assertValidCollaborationEvent(event, nextRecord);
      return this.options.durableStore.commitEntries(
        [{ kind: "collaboration.record", record: nextRecord }, { kind: "collaboration.event.record", event }],
        async (retained) => {
          for (const entry of retained) {
            if (entry.kind === "collaboration.record") await this.options.runtime.upsertCollaboration(entry.record);
            else if (entry.kind === "collaboration.event.record") await this.options.runtime.appendCollaborationEvent(entry.event);
          }
        },
        { enqueueProjection: false },
      );
    });
    await this.options.durableStore.applyProjectedEntries(entries);
  };

  /** The work item a task's invocation points at. */
  readonly workIdForInvocation = (invocation: InvocationRequest | undefined): string | undefined =>
    invocation ? invocationWorkId(invocation) : undefined;

  private buildDeliveryWorkItem(input: RecordDeliveryWorkItemInput): CollaborationRecord | null {
    const workItem = input.payload.workItem;
    // A role pass never becomes a card, or the pass would trigger itself.
    if (!workItem?.title?.trim() || rolePassAssignmentId(input.payload.invocationMetadata)) {
      return null;
    }
    const source =
      metadataStringValue(input.payload.invocationMetadata, "source")
      || metadataStringValue(input.payload.messageMetadata, "source")
      || "broker-delivery";
    const recordId = workItem.id?.trim()
      || input.payload.collaborationRecordId?.trim()
      || this.options.createId("work");
    const labels = mergeScoutLabels(input.payload.labels, workItem.labels);
    const record: CollaborationRecord = {
      id: recordId,
      kind: "work_item",
      state: "working",
      // Finished work goes to done unless the asker chose review.
      acceptanceState: workItem.acceptanceState ?? "none",
      title: workItem.title.trim(),
      ...(workItem.summary?.trim() ? { summary: workItem.summary.trim() } : {}),
      createdById: input.requesterId,
      ownerId: input.targetAgentId,
      nextMoveOwnerId: input.targetAgentId,
      conversationId: input.conversationId,
      ...(workItem.parentId?.trim() ? { parentId: workItem.parentId.trim() } : {}),
      ...(workItem.priority ? { priority: workItem.priority as CollaborationPriority } : {}),
      ...(labels ? { labels } : {}),
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      requestedById: input.requesterId,
      startedAt: input.createdAt,
      metadata: {
        source,
        ...(workItem.metadata ?? {}),
        deliveryRequestId: input.requestId,
      },
    };
    record.metadata = {
      ...(record.metadata ?? {}),
      deliveryWorkItemFingerprint: deliveryWorkItemFingerprint(record),
    };
    return record;
  }

  private buildDeliveryWorkItemCreatedEvent(
    record: CollaborationRecord,
    input: {
      payload: ScoutDeliverRequest;
      requestId: string;
      requesterId: string;
      createdAt: number;
    },
  ): CollaborationEvent {
    return {
      id: this.options.createId("evt"),
      recordId: record.id,
      recordKind: "work_item",
      kind: "created",
      actorId: input.requesterId,
      at: input.createdAt,
      summary: record.summary ?? record.title,
      metadata: {
        source: metadataStringValue(record.metadata, "source") ?? "broker-delivery",
        deliveryRequestId: input.requestId,
      },
    };
  }
}
