/**
 * Work lifecycles in the runtime.
 *
 * Lifecycles are documents compiled into state machines (see the protocol
 * module). This service is the one writer of moves: a move reads the item,
 * decides with deterministic checks, and commits the item and its ledger event
 * in one durable write. The ledger is the item's collaboration events: each
 * move event carries `metadata.workMove`, and each review event carries
 * `metadata.workReview`, so the ledger is append-only and replays with the
 * journal.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_WORK_LIFECYCLE,
  assertValidCollaborationEvent,
  assertValidCollaborationRecord,
  compileWorkLifecycle,
  currentWorkStation,
  decideWorkMove,
  hashWorkLifecycle,
  isWorkItemTerminalState,
  validateWorkLifecycle,
  workLifecycleToXState,
  workPlacementOf,
  type CollaborationEvent,
  type CollaborationEventKind,
  type CollaborationRecord,
  type CompiledWorkLifecycle,
  type WorkItemRecord,
  type WorkItemState,
  type WorkLifecycle,
  type WorkLifecycleSummary,
  type WorkMoveDecision,
  type WorkMoveRecord,
  type WorkMoveRequest,
  type WorkMoveResponse,
  type WorkMoveReviewStatus,
  type WorkPlacement,
  type WorkReviewRequest,
  type WorkReviewResponse,
  type WorkStationId,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";

export interface WorkItemPosition {
  workId: string;
  lifecycleId: string;
  lifecycleVersion: number;
  station: WorkStationId;
  stationName: string;
  state: WorkItemState;
  reviewPending: boolean;
  revision: number;
  next: Array<{ station: WorkStationId; name: string; state: WorkItemState }>;
}

export interface WorkBoard {
  lifecycle: WorkLifecycleSummary;
  items: Array<{ workId: string; station: WorkStationId; reviewPending: boolean; revision: number; next: WorkStationId[] }>;
}

export class WorkLifecycleError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Registry

type RegistryEntry = { doc: WorkLifecycle; machine: CompiledWorkLifecycle; builtIn: boolean };

/** Built-in lifecycles plus the documents saved under one directory, one JSON file each. */
export class WorkLifecycleRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  constructor(private readonly directory?: string, warn: (message: string) => void = () => {}) {
    this.put(DEFAULT_WORK_LIFECYCLE, true);
    if (!directory || !existsSync(directory)) return;
    for (const name of readdirSync(directory).filter((n) => n.endsWith(".json")).sort()) {
      try {
        const doc = JSON.parse(readFileSync(join(directory, name), "utf8")) as WorkLifecycle;
        const errors = validateWorkLifecycle(doc);
        if (errors.length) { warn(`[openscout-runtime] work lifecycle ${name} skipped: ${errors.join("; ")}`); continue; }
        const existing = this.entries.get(doc.id);
        if (!existing || doc.version >= existing.doc.version) this.put(doc, false);
      } catch (error) {
        warn(`[openscout-runtime] work lifecycle ${name} unreadable: ${String(error)}`);
      }
    }
  }

  private put(doc: WorkLifecycle, builtIn: boolean): RegistryEntry {
    const entry = { doc, machine: compileWorkLifecycle(doc), builtIn };
    this.entries.set(doc.id, entry);
    return entry;
  }

  get defaultId(): string { return DEFAULT_WORK_LIFECYCLE.id; }

  get(id: string): CompiledWorkLifecycle | undefined { return this.entries.get(id)?.machine; }

  list(): WorkLifecycleSummary[] {
    return [...this.entries.values()].map(({ doc, machine, builtIn }) => ({
      lifecycle: doc, hash: machine.hash, builtIn, machine: workLifecycleToXState(machine),
    }));
  }

  /** The lifecycle an item follows: its placement's, a lifecycle named in metadata, or the default. */
  forRecord(record: CollaborationRecord): CompiledWorkLifecycle {
    const named = workPlacementOf(record)?.lifecycleId
      ?? (typeof record.metadata?.workLifecycleId === "string" ? record.metadata.workLifecycleId : undefined);
    return (named && this.get(named)) || this.get(this.defaultId)!;
  }

  /** Save a lifecycle. A changed document needs a higher version; placements keep the version they moved under. */
  save(doc: WorkLifecycle): WorkLifecycleSummary {
    const errors = validateWorkLifecycle(doc);
    if (errors.length) throw new WorkLifecycleError(400, errors.join("; "));
    const existing = this.entries.get(doc.id);
    if (existing && existing.machine.hash !== hashWorkLifecycle(doc) && doc.version <= existing.doc.version) {
      throw new WorkLifecycleError(409, `${doc.id} is at version ${existing.doc.version}; save a higher version.`);
    }
    if (!this.directory) throw new WorkLifecycleError(503, "This runtime has no lifecycle directory.");
    mkdirSync(this.directory, { recursive: true });
    const file = join(this.directory, `${doc.id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
    writeFileSync(`${file}.tmp`, `${JSON.stringify(doc, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
    const entry = this.put(doc, false);
    return { lifecycle: doc, hash: entry.machine.hash, builtIn: false, machine: workLifecycleToXState(entry.machine) };
  }
}

// ---------------------------------------------------------------------------
// Pure planning: record in, record and event out

function eventKindFor(from: WorkItemState, to: WorkItemState, claimed: boolean): CollaborationEventKind {
  if (isWorkItemTerminalState(from) && !isWorkItemTerminalState(to)) return "reopened";
  switch (to) {
    case "waiting": return "waiting";
    case "review": return "review_requested";
    case "done": return "done";
    case "cancelled": return "cancelled";
    case "working": return claimed ? "claimed" : "progressed";
    default: return "progressed";
  }
}

function stationName(machine: CompiledWorkLifecycle, id: WorkStationId): string {
  return machine.stations.get(id)?.name ?? id;
}

/** Put a work item into a station: state, placement and the state's own fields. */
function placeRecord(
  machine: CompiledWorkLifecycle,
  record: WorkItemRecord,
  to: WorkStationId,
  input: { now: number; reviewPending: boolean; waitingOn?: WorkMoveRequest["waitingOn"] },
): { record: WorkItemRecord; placement: WorkPlacement } {
  const station = machine.stations.get(to)!;
  const previous = workPlacementOf(record);
  const placement: WorkPlacement = {
    lifecycleId: machine.id,
    lifecycleVersion: machine.version,
    station: to,
    revision: (previous?.revision ?? 0) + 1,
    movedAt: input.now,
    ...(input.reviewPending ? { reviewPending: true } : {}),
  };
  const state = station.state;
  const terminal = isWorkItemTerminalState(state);
  const waitingOn = state === "waiting"
    ? input.waitingOn
      ? { kind: (input.waitingOn.kind ?? "condition") as NonNullable<WorkItemRecord["waitingOn"]>["kind"], label: input.waitingOn.label, ...(input.waitingOn.targetId ? { targetId: input.waitingOn.targetId } : {}) }
      : record.waitingOn
    : undefined;
  const reopened = isWorkItemTerminalState(record.state) && !terminal;
  const requester = record.requestedById;
  const acceptanceState = input.reviewPending && requester
    ? "pending"
    : reopened && record.acceptanceState !== "none" ? "reopened" : record.acceptanceState;
  const next: WorkItemRecord = {
    ...record,
    state,
    acceptanceState,
    updatedAt: Math.max(input.now, record.updatedAt),
    waitingOn,
    startedAt: state === "working" ? record.startedAt ?? input.now : record.startedAt,
    reviewRequestedAt: state === "review" ? input.now : record.reviewRequestedAt,
    completedAt: terminal ? record.completedAt ?? input.now : undefined,
    nextMoveOwnerId: record.nextMoveOwnerId ?? record.ownerId,
    metadata: { ...(record.metadata ?? {}), workPlacement: placement },
  };
  if (!next.waitingOn) delete next.waitingOn;
  if (next.completedAt === undefined) delete next.completedAt;
  return { record: next, placement };
}

export interface PlannedWorkMove {
  decision: WorkMoveDecision;
  move?: WorkMoveRecord;
  record?: WorkItemRecord;
  event?: CollaborationEvent;
}

export function planWorkMove(
  machine: CompiledWorkLifecycle,
  record: WorkItemRecord,
  request: WorkMoveRequest & { actorId: string },
  context: { now: number; moveId: string; children?: WorkItemRecord[] },
): PlannedWorkMove {
  const claimed = Boolean(request.claim) && record.ownerId !== request.actorId;
  const base: WorkItemRecord = claimed ? { ...record, ownerId: request.actorId, nextMoveOwnerId: request.actorId } : record;
  const decision = decideWorkMove(machine, {
    item: { ...base, placement: workPlacementOf(base) },
    to: request.to,
    moverId: request.actorId,
    note: request.note,
    evidence: request.evidence,
    waitingOn: request.waitingOn,
    children: context.children,
  });
  if (request.dryRun) return { decision };
  // A move outside the graph is a mistake, not an event worth keeping.
  if (decision.verdict === "deny" && decision.reasons.some((r) => r.scope === "graph")) return { decision };

  const applied = decision.verdict === "allow";
  const move: WorkMoveRecord = {
    id: context.moveId,
    itemId: record.id,
    lifecycleId: machine.id,
    lifecycleVersion: machine.version,
    from: decision.from,
    to: request.to,
    moverId: request.actorId,
    verdict: decision.verdict,
    decision,
    evidence: request.evidence ?? [],
    ...(request.note?.trim() ? { note: request.note.trim() } : {}),
    review: applied ? decision.review : "not_needed",
    createdAt: context.now,
  };
  const failed = decision.reasons.filter((r) => r.outcome === "fail" && !r.shadow && r.effect !== "advise");
  if (!applied) {
    const event: CollaborationEvent = {
      id: `${context.moveId}:event`, recordId: record.id, recordKind: "work_item", kind: "progressed",
      actorId: request.actorId, at: context.now,
      summary: `Move to ${stationName(machine, request.to)} ${decision.verdict === "deny" ? "denied" : decision.verdict === "hold" ? "held" : "needs a decision"}: ${failed.map((r) => r.message).join(" ")}`,
      metadata: { workMove: move },
    };
    return { decision, move, event };
  }
  const placed = placeRecord(machine, base, request.to, { now: context.now, reviewPending: decision.review === "pending", waitingOn: request.waitingOn });
  move.revision = placed.placement.revision;
  const event: CollaborationEvent = {
    id: `${context.moveId}:event`, recordId: record.id, recordKind: "work_item",
    kind: eventKindFor(record.state, placed.record.state, claimed),
    actorId: request.actorId, at: context.now,
    summary: `Moved from ${stationName(machine, decision.from)} to ${stationName(machine, request.to)}.${move.note ? ` ${move.note}` : ""}`,
    metadata: { workMove: move },
  };
  return { decision, move, record: placed.record, event };
}

/**
 * Place a record that another runtime writer already changed (a flight ending).
 * The checks still run and their results are kept on the move, marked as a
 * runtime move, so a rule the runtime skipped is visible on the board.
 */
export function placeRuntimeChange(
  machine: CompiledWorkLifecycle,
  before: WorkItemRecord,
  after: WorkItemRecord,
  context: { now: number; moveId: string; actorId: string },
): { record: WorkItemRecord; move?: WorkMoveRecord } {
  const from = currentWorkStation(machine, { ...before, placement: workPlacementOf(before) });
  const fromStation = machine.stations.get(from);
  if (fromStation?.state === after.state) return { record: after };
  const to = machine.stationForState(after.state);
  const decision = decideWorkMove(machine, { item: { ...before, placement: workPlacementOf(before) }, to, moverId: context.actorId });
  const reviewPending = Boolean(machine.stations.get(to)?.judges?.length);
  const previous = workPlacementOf(before);
  const placement: WorkPlacement = {
    lifecycleId: machine.id, lifecycleVersion: machine.version, station: to,
    revision: (previous?.revision ?? 0) + 1, movedAt: context.now, ...(reviewPending ? { reviewPending: true } : {}),
  };
  const record: WorkItemRecord = { ...after, metadata: { ...(after.metadata ?? {}), workPlacement: placement } };
  const move: WorkMoveRecord = {
    id: context.moveId, itemId: after.id, lifecycleId: machine.id, lifecycleVersion: machine.version,
    from, to, moverId: context.actorId, verdict: decision.verdict, decision: { ...decision, review: reviewPending ? "pending" : "not_needed" },
    evidence: [], note: "Moved by the runtime when the run ended.", revision: placement.revision,
    review: reviewPending ? "pending" : "not_needed", createdAt: context.now,
  };
  return { record, move };
}

export interface PlannedWorkReview {
  status: WorkMoveReviewStatus;
  record?: WorkItemRecord;
  event: CollaborationEvent;
  station?: WorkStationId;
}

export function planWorkReview(
  machine: CompiledWorkLifecycle,
  record: WorkItemRecord,
  move: WorkMoveRecord,
  request: WorkReviewRequest & { actorId: string },
  context: { now: number; eventId: string },
): PlannedWorkReview {
  if (move.review !== "pending" && move.review !== "consulted") {
    throw new WorkLifecycleError(409, `This move is already ${move.review}.`);
  }
  const placement = workPlacementOf(record);
  const review = (status: WorkMoveReviewStatus) => ({
    moveId: move.id, status, revision: request.revision, reviewerId: request.actorId,
    ...(request.note?.trim() ? { note: request.note.trim() } : {}), at: context.now,
  });
  const base = { id: context.eventId, recordId: record.id, recordKind: "work_item" as const, actorId: request.actorId, at: context.now };
  if (!placement || placement.revision !== request.revision || move.revision !== request.revision) {
    return { status: "stale", event: { ...base, kind: "progressed", summary: "Review skipped: the item moved after this move.", metadata: { workReview: review("stale") } } };
  }
  if (request.verdict === "consult") {
    return { status: "consulted", event: { ...base, kind: "progressed", summary: `Review asks for a decision.${request.note ? ` ${request.note}` : ""}`, metadata: { workReview: review("consulted") } } };
  }
  if (request.verdict === "confirm") {
    const { reviewPending: _settled, ...settled } = placement;
    const next: WorkItemRecord = {
      ...record,
      updatedAt: Math.max(context.now, record.updatedAt),
      acceptanceState: record.requestedById ? "accepted" : record.acceptanceState,
      metadata: { ...(record.metadata ?? {}), workPlacement: settled },
    };
    return { status: "confirmed", record: next, event: { ...base, kind: "accepted", summary: `Review confirmed the move to ${stationName(machine, move.to)}.${request.note ? ` ${request.note}` : ""}`, metadata: { workReview: review("confirmed") } } };
  }
  // Reopen: back to where the move came from, or to working when that station cannot hold it.
  let target = move.from;
  const fromState = machine.stations.get(target)?.state;
  if (!fromState || isWorkItemTerminalState(fromState) || (fromState === "waiting" && !record.waitingOn)) {
    target = machine.stationForState("working");
  }
  const placed = placeRecord(machine, { ...record, ownerId: record.ownerId ?? move.moverId }, target, { now: context.now, reviewPending: false });
  const next: WorkItemRecord = { ...placed.record, acceptanceState: record.acceptanceState === "none" ? "none" : "reopened" };
  return {
    status: "reopened", record: next, station: target,
    event: { ...base, kind: "reopened", summary: `Review reopened it into ${stationName(machine, target)}.${request.note ? ` ${request.note}` : ""}`, metadata: { workReview: review("reopened") } },
  };
}

/** Fold an item's events into its ledger, newest first, with each move's latest review. */
export function workMovesFromEvents(events: CollaborationEvent[]): WorkMoveRecord[] {
  const ordered = [...events].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const moves = new Map<string, WorkMoveRecord>();
  for (const event of ordered) {
    const move = event.metadata?.workMove as WorkMoveRecord | undefined;
    if (move && typeof move.id === "string") moves.set(move.id, { ...move });
    const review = event.metadata?.workReview as { moveId?: string; status?: WorkMoveReviewStatus; note?: string; reviewerId?: string; at?: number } | undefined;
    const target = review?.moveId ? moves.get(review.moveId) : undefined;
    if (target && review?.status) {
      target.review = review.status;
      if (review.note) target.reviewNote = review.note;
      if (review.reviewerId) target.reviewedById = review.reviewerId;
      if (review.at) target.reviewedAt = review.at;
    }
  }
  return [...moves.values()].sort((a, b) => b.createdAt - a.createdAt);
}

// ---------------------------------------------------------------------------
// Service

type DurableStore = {
  runWrite<T>(work: () => Promise<T>): Promise<T>;
  commitEntries(
    entries: BrokerJournalEntry | BrokerJournalEntry[],
    applyRuntime: (entries: BrokerJournalEntry[]) => Promise<void>,
    options?: { enqueueProjection?: boolean },
  ): Promise<BrokerJournalEntry[]>;
};

export interface BrokerWorkLifecycleServiceOptions {
  registry: WorkLifecycleRegistry;
  durableStore: DurableStore;
  runtime: {
    collaborationRecord(recordId: string): CollaborationRecord | undefined;
    upsertCollaboration(record: CollaborationRecord): Promise<void>;
    appendCollaborationEvent(event: CollaborationEvent): Promise<void>;
  };
  listEvents(options: { recordId?: string; limit?: number }): CollaborationEvent[];
  childrenOf(recordId: string): CollaborationRecord[];
  listWorkItems(): WorkItemRecord[];
  createId(prefix: string): string;
  operatorActorId: string;
  now?: () => number;
}

export class BrokerWorkLifecycleService {
  constructor(private readonly options: BrokerWorkLifecycleServiceOptions) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private workItem(workId: string): WorkItemRecord {
    const record = this.options.runtime.collaborationRecord(workId);
    if (!record || record.kind !== "work_item") throw new WorkLifecycleError(404, `No work item ${workId}.`);
    return record;
  }

  private async commit(record: WorkItemRecord | undefined, event: CollaborationEvent): Promise<void> {
    if (record) assertValidCollaborationRecord(record);
    assertValidCollaborationEvent(event, record ?? this.options.runtime.collaborationRecord(event.recordId));
    const entries: BrokerJournalEntry[] = [
      ...(record ? [{ kind: "collaboration.record" as const, record }] : []),
      { kind: "collaboration.event.record", event },
    ];
    await this.options.durableStore.commitEntries(entries, async () => {
      if (record) await this.options.runtime.upsertCollaboration(record);
      await this.options.runtime.appendCollaborationEvent(event);
    });
  }

  readonly lifecycles = (): WorkLifecycleSummary[] => this.options.registry.list();

  /** Every item on one lifecycle, placed: open work plus work closed since `closedSince`. */
  readonly board = (query: { lifecycleId?: string; closedSince?: number; limit?: number }): WorkBoard => {
    const lifecycleId = query.lifecycleId?.trim() || this.options.registry.defaultId;
    const summary = this.options.registry.list().find((entry) => entry.lifecycle.id === lifecycleId);
    if (!summary) throw new WorkLifecycleError(404, `No lifecycle ${lifecycleId}.`);
    const closedSince = query.closedSince ?? this.now() - 7 * 24 * 60 * 60 * 1000;
    const limit = Math.min(Math.max(query.limit ?? 500, 1), 2000);
    const items = this.options.listWorkItems()
      .filter((record) => this.options.registry.forRecord(record).id === lifecycleId)
      .filter((record) => !isWorkItemTerminalState(record.state) || record.updatedAt >= closedSince)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((record) => {
        const position = this.position(record.id);
        return { workId: record.id, station: position.station, reviewPending: position.reviewPending, revision: position.revision, next: position.next.map((n) => n.station) };
      });
    return { lifecycle: summary, items };
  };

  /** Where an item sits and the moves open to it, for agents deciding their next move. */
  readonly position = (workId: string): WorkItemPosition => {
    const record = this.workItem(workId);
    const machine = this.options.registry.forRecord(record);
    const placement = workPlacementOf(record);
    const station = currentWorkStation(machine, { ...record, placement });
    return {
      workId: record.id,
      lifecycleId: machine.id,
      lifecycleVersion: machine.version,
      station,
      stationName: stationName(machine, station),
      state: record.state,
      reviewPending: Boolean(placement?.reviewPending && placement.station === station),
      revision: placement?.revision ?? 0,
      next: machine.nextStations(station).map((id) => ({ station: id, name: stationName(machine, id), state: machine.stations.get(id)!.state })),
    };
  };

  readonly saveLifecycle = (doc: WorkLifecycle): WorkLifecycleSummary => this.options.registry.save(doc);

  readonly moves = (query: { workId?: string; limit?: number }): WorkMoveRecord[] => {
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    const events = this.options.listEvents({ recordId: query.workId, limit: query.workId ? 1000 : 2000 })
      .filter((e) => e.metadata?.workMove || e.metadata?.workReview);
    return workMovesFromEvents(events).slice(0, limit);
  };

  readonly move = (request: WorkMoveRequest): Promise<WorkMoveResponse> =>
    this.options.durableStore.runWrite(async () => {
      if (!request.workId?.trim() || !request.to?.trim()) throw new WorkLifecycleError(400, "workId and to are required.");
      const record = this.workItem(request.workId);
      const machine = this.options.registry.forRecord(record);
      const children = this.options.childrenOf(record.id).filter((c): c is WorkItemRecord => c.kind === "work_item");
      const actorId = request.actorId?.trim() || this.options.operatorActorId;
      const plan = planWorkMove(machine, record, { ...request, actorId }, { now: this.now(), moveId: this.options.createId("move"), children });
      if (plan.event) await this.commit(plan.record, plan.event);
      return { decision: plan.decision, ...(plan.event && plan.move ? { move: plan.move } : {}), applied: Boolean(plan.record) };
    });

  readonly review = (request: WorkReviewRequest): Promise<WorkReviewResponse> =>
    this.options.durableStore.runWrite(async () => {
      if (!request.workId?.trim() || !request.moveId?.trim()) throw new WorkLifecycleError(400, "workId and moveId are required.");
      if (!["confirm", "reopen", "consult"].includes(request.verdict)) throw new WorkLifecycleError(400, "verdict is confirm, reopen or consult.");
      const record = this.workItem(request.workId);
      const move = this.moves({ workId: record.id, limit: 500 }).find((m) => m.id === request.moveId);
      if (!move) throw new WorkLifecycleError(404, `No move ${request.moveId} on ${record.id}.`);
      const machine = this.options.registry.get(move.lifecycleId) ?? this.options.registry.forRecord(record);
      const actorId = request.actorId?.trim() || this.options.operatorActorId;
      const plan = planWorkReview(machine, record, move, { ...request, actorId }, { now: this.now(), eventId: this.options.createId("review") });
      await this.commit(plan.record, plan.event);
      const updated = workMovesFromEvents([...this.options.listEvents({ recordId: record.id, limit: 1000 })]).find((m) => m.id === move.id) ?? move;
      return { move: updated, status: plan.status, ...(plan.station ? { station: plan.station } : {}) };
    });
}

export function workLifecycleDirectory(controlHome: string): string {
  return join(controlHome, "work-lifecycles");
}
