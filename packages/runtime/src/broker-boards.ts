/**
 * Boards: lifecycles as columns, work items as cards, read from the runtime's
 * own records.
 *
 * Placement comes from the work lifecycle service, so a card sits where
 * `/v1/work/board` puts it and in the same order. Content comes from the live
 * registry: the work item, its parent, the actors named on it, its latest
 * ledger event and its newest flights. Nothing here writes.
 */
import {
  DEFAULT_BOARD_ID,
  flightSessionTrace,
  type BoardCard,
  type BoardCardFlight,
  type BoardCardSource,
  type BoardListResponse,
  type BoardRead,
  type BoardReadQuery,
  type CollaborationEvent,
  type CollaborationRecord,
  type FlightRecord,
  type InvocationRequest,
  type WorkItemRecord,
  type WorkLifecycleSummary,
} from "@openscout/protocol";

import { invocationWorkId } from "./broker-failed-work.js";
import type { WorkBoard } from "./broker-work-lifecycles.js";

type NamedActor = { displayName?: string };

/** The parts of the registry a board read uses. */
export interface BoardRegistryView {
  actors: Readonly<Record<string, NamedActor>>;
  agents: Readonly<Record<string, NamedActor>>;
  collaborationRecords: Readonly<Record<string, CollaborationRecord>>;
  invocations: Readonly<Record<string, InvocationRequest>>;
  flights: Readonly<Record<string, FlightRecord>>;
}

export interface BrokerBoardServiceOptions {
  work: {
    lifecycles(): WorkLifecycleSummary[];
    board(query: BoardReadQuery & { lifecycleId?: string }): WorkBoard;
  };
  defaultLifecycleId: string;
  registry(): Readonly<BoardRegistryView>;
  /** The newest ledger event of each named record. */
  latestEvents(recordIds: ReadonlySet<string>): Map<string, CollaborationEvent>;
}

const ENDED_FLIGHT_STATES = new Set(["completed", "failed", "cancelled"]);

export class BrokerBoardService {
  constructor(private readonly options: BrokerBoardServiceOptions) {}

  readonly list = (): BoardListResponse => ({
    boards: this.options.work.lifecycles().map(({ lifecycle }) => ({
      id: lifecycle.id,
      name: lifecycle.name,
      version: lifecycle.version,
      isDefault: lifecycle.id === this.options.defaultLifecycleId,
    })),
  });

  /** One board. `default` names the default lifecycle unless a lifecycle has that id. An unknown id is a 404. */
  readonly read = (boardId: string, query: BoardReadQuery = {}): BoardRead => {
    const id = boardId.trim();
    const lifecycleId = id === DEFAULT_BOARD_ID && !this.options.work.lifecycles().some((s) => s.lifecycle.id === id)
      ? this.options.defaultLifecycleId
      : id;
    const placed = this.options.work.board({ ...query, lifecycleId });
    return joinBoard(placed, this.options.registry(), this.options.latestEvents);
  };
}

/**
 * Join placements with card content. A placement whose work item cannot be
 * read is left out: a card is never drawn without its title. Any other field
 * the registry cannot fill (an actor's name, a parent's title) is null.
 */
export function joinBoard(
  placed: WorkBoard,
  registry: Readonly<BoardRegistryView>,
  latestEvents: (recordIds: ReadonlySet<string>) => Map<string, CollaborationEvent>,
): BoardRead {
  const { lifecycle, hash } = placed.lifecycle;
  const records = new Map<string, WorkItemRecord>();
  for (const item of placed.items) {
    const record = registry.collaborationRecords[item.workId];
    if (record?.kind === "work_item") records.set(item.workId, record);
  }
  const ids = new Set(records.keys());
  const events = latestEvents(ids);
  const flights = flightsByWork(ids, registry);
  const name = (actorId: string | undefined): string | null => {
    if (!actorId) return null;
    return registry.actors[actorId]?.displayName?.trim() || registry.agents[actorId]?.displayName?.trim() || null;
  };

  const cards = placed.items.flatMap((item): BoardCard[] => {
    const record = records.get(item.workId);
    if (!record) return [];
    const parent = record.parentId ? registry.collaborationRecords[record.parentId] : undefined;
    const workFlights = flights.get(record.id) ?? [];
    const meaningful = lastMeaningful(record, events.get(record.id), newestFlight(workFlights));
    return [{
      workId: record.id,
      column: item.station,
      revision: item.revision,
      reviewPending: item.reviewPending,
      next: item.next,
      title: record.title,
      summary: record.summary ?? null,
      state: record.state,
      acceptanceState: record.acceptanceState,
      priority: record.priority ?? null,
      ownerId: record.ownerId ?? null,
      ownerName: name(record.ownerId),
      nextMoveOwnerId: record.nextMoveOwnerId ?? null,
      nextMoveOwnerName: name(record.nextMoveOwnerId),
      conversationId: record.conversationId ?? null,
      parentId: record.parentId ?? null,
      parentTitle: parent?.title ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastMeaningfulAt: meaningful.at,
      lastMeaningfulSummary: meaningful.summary,
      source: cardSource(record),
      activeFlight: activeFlight(workFlights),
    }];
  });

  return {
    board: { id: lifecycle.id, name: lifecycle.name, version: lifecycle.version, hash, description: lifecycle.description ?? null },
    columns: lifecycle.stations.map((s) => ({ id: s.id, name: s.name, state: s.state, purpose: s.purpose ?? null })),
    transitions: lifecycle.transitions.map((t) => ({ from: t.from, to: t.to, name: t.name ?? null })),
    cards,
    ...(placed.page && { page: placed.page }),
  };
}

/** Each named work item's flights, through the invocations that carry its id. One pass over each map. */
function flightsByWork(ids: ReadonlySet<string>, registry: Readonly<BoardRegistryView>): Map<string, FlightRecord[]> {
  const byWork = new Map<string, FlightRecord[]>();
  if (ids.size === 0) return byWork;
  const workOfInvocation = new Map<string, string>();
  for (const invocation of Object.values(registry.invocations)) {
    const workId = invocationWorkId(invocation);
    if (workId && ids.has(workId)) workOfInvocation.set(invocation.id, workId);
  }
  for (const flight of Object.values(registry.flights)) {
    const workId = workOfInvocation.get(flight.invocationId);
    if (!workId) continue;
    const list = byWork.get(workId);
    if (list) list.push(flight); else byWork.set(workId, [flight]);
  }
  return byWork;
}

function flightAt(flight: FlightRecord): number {
  return flight.completedAt ?? flight.startedAt ?? 0;
}

function newestFlight(flights: FlightRecord[]): FlightRecord | undefined {
  let newest: FlightRecord | undefined;
  for (const flight of flights) if (!newest || flightAt(flight) > flightAt(newest)) newest = flight;
  return newest;
}

/** The newest flight that has not ended, by start time. */
function activeFlight(flights: FlightRecord[]): BoardCardFlight | null {
  let active: FlightRecord | undefined;
  for (const flight of flights) {
    if (ENDED_FLIGHT_STATES.has(flight.state)) continue;
    if (!active || (flight.startedAt ?? 0) > (active.startedAt ?? 0)) active = flight;
  }
  if (!active) return null;
  const session = flightSessionTrace(active).at(-1);
  return {
    id: active.id,
    state: active.state,
    harness: session?.harness ?? null,
    sessionId: session?.sessionId ?? active.sessionId ?? null,
    startedAt: active.startedAt ?? null,
  };
}

/** The newest of the latest event, the latest flight and the record's own update. */
function lastMeaningful(
  record: WorkItemRecord,
  event: CollaborationEvent | undefined,
  flight: FlightRecord | undefined,
): { at: number; summary: string | null } {
  const candidates: Array<{ at: number; summary: string | null }> = [
    { at: record.updatedAt, summary: record.progress?.summary ?? record.summary ?? record.title },
  ];
  if (flight && flightAt(flight) > 0) candidates.push({ at: flightAt(flight), summary: flight.summary ?? null });
  if (event) candidates.push({ at: event.at, summary: event.summary ?? null });
  // Later candidates win a tie: an event says more than the update it caused.
  return candidates.reduce((best, next) => (next.at >= best.at ? next : best));
}

function cardSource(record: WorkItemRecord): BoardCardSource | null {
  const source = record.externalContext?.source;
  if (!source || typeof source.adapterId !== "string" || typeof source.instanceId !== "string"
    || typeof source.workItemId !== "string") return null;
  return {
    adapterId: source.adapterId,
    instanceId: source.instanceId,
    workItemId: source.workItemId,
    url: typeof source.url === "string" && source.url ? source.url : null,
  };
}
