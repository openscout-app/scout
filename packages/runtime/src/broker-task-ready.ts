/**
 * Ready in the runtime: a task the operator asked to hear about when it is done.
 *
 * The flight writer calls {@link prepareTaskReady} inside its canonical write,
 * so Ready is decided from the flight's state alone. After the write,
 * {@link TaskReadyNotifier} rings the operator once per flight.
 * {@link BrokerTaskReadyService} sets the mark on a running task and carries
 * out the operator's two moves, Continue and Hold.
 */
import {
  TASK_READY_KEY,
  TASK_READY_NOTIFY_KEY,
  flightFinishedForReady,
  taskReadyNotify,
  taskReadyOf,
  taskReadySummary,
  type CollaborationEvent,
  type FlightRecord,
  type InvocationRequest,
  type MetadataMap,
  type TaskNotifyResponse,
  type TaskReady,
  type TaskReadyDecideResponse,
  type TaskReadyDecision,
  type TaskReadyNotifyMark,
  type WorkItemRecord,
} from "@openscout/protocol";

import { isTerminalFlightState } from "./broker-local-invocation-helpers.js";

/** Work item metadata: the acceptance it had before Ready put it in review. */
export const TASK_READY_PRIOR_ACCEPTANCE_KEY = "taskReadyPriorAcceptance";

export class TaskReadyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "TaskReadyError";
  }
}

// ---------------------------------------------------------------------------
// Inside the flight writer

/**
 * Carry the mark and Ready across a writer's stale copy, and write Ready when
 * a marked flight finishes. Pure; runs under the canonical flight writer.
 */
export function prepareTaskReady(
  previous: FlightRecord | undefined,
  next: FlightRecord,
  invocation: InvocationRequest | undefined,
  context: { operatorActorId: string; nodeId: string; now: number },
): FlightRecord {
  let flight = next;
  const carried: MetadataMap = {};
  if (previous?.metadata?.[TASK_READY_NOTIFY_KEY] !== undefined && next.metadata?.[TASK_READY_NOTIFY_KEY] === undefined) {
    carried[TASK_READY_NOTIFY_KEY] = previous.metadata[TASK_READY_NOTIFY_KEY];
  }
  if (taskReadyOf(previous) && !taskReadyOf(next)) carried[TASK_READY_KEY] = previous!.metadata![TASK_READY_KEY];
  if (Object.keys(carried).length > 0) flight = { ...flight, metadata: { ...flight.metadata, ...carried } };
  if (!taskReadyNotify(invocation, flight) || !flightFinishedForReady(flight)) return flight;
  // Only the task's home runtime writes Ready, so two machines never both ring.
  const home = invocation?.metadata?.taskHomeNodeId;
  if (typeof home === "string" && home && home !== context.nodeId) return flight;
  // Ready is written once per round. Hold changes it in place; after Continue,
  // the same flight finishing again starts a new round.
  const existing = taskReadyOf(flight);
  if (existing && !(existing.state === "continued" && previous && !flightFinishedForReady(previous))) return flight;
  const ready: TaskReady = { state: "ready", at: context.now, summary: taskReadySummary(flight), nodeId: context.nodeId };
  return { ...flight, metadata: { ...flight.metadata, [TASK_READY_KEY]: ready, nextMoveOwnerId: context.operatorActorId } };
}

/** The write that put this flight into a new round of Ready. */
export function taskReadyEntered(previous: FlightRecord | undefined, next: FlightRecord): boolean {
  const ready = taskReadyOf(next);
  if (!ready || ready.state !== "ready") return false;
  const before = taskReadyOf(previous);
  return !before || before.at !== ready.at;
}

/** Land a task's work item in review for its Ready, keeping the acceptance it had. */
export function planReadyWorkItem(
  record: WorkItemRecord,
  input: { operatorActorId: string; summary: string; now: number; flightId: string },
): WorkItemRecord | undefined {
  if (isWorkItemSettled(record) || (record.state === "review" && record.acceptanceState === "pending")) return undefined;
  return {
    ...record,
    state: "review",
    acceptanceState: "pending",
    requestedById: record.requestedById ?? record.createdById,
    nextMoveOwnerId: input.operatorActorId,
    waitingOn: undefined,
    reviewRequestedAt: input.now,
    completedAt: undefined,
    updatedAt: Math.max(input.now, record.updatedAt),
    progress: { ...(record.progress ?? {}), ...(input.summary ? { summary: input.summary } : {}) },
    metadata: {
      ...(record.metadata ?? {}),
      [TASK_READY_PRIOR_ACCEPTANCE_KEY]: record.acceptanceState,
      lastFlightId: input.flightId,
    },
  };
}

/** Continue: back to working, next move to the agent, acceptance as it was before Ready. */
export function planContinuedWorkItem(record: WorkItemRecord, input: { now: number; agentId: string }): WorkItemRecord | undefined {
  if (record.state !== "review" || record.acceptanceState !== "pending") return undefined;
  const prior = record.metadata?.[TASK_READY_PRIOR_ACCEPTANCE_KEY];
  const acceptanceState = prior === "none" || prior === "pending" || prior === "reopened" ? prior : "none";
  const { [TASK_READY_PRIOR_ACCEPTANCE_KEY]: _prior, ...metadata } = record.metadata ?? {};
  return {
    ...record,
    state: "working",
    acceptanceState,
    ownerId: record.ownerId ?? input.agentId,
    nextMoveOwnerId: input.agentId,
    updatedAt: Math.max(input.now, record.updatedAt),
    metadata,
  };
}

function isWorkItemSettled(record: WorkItemRecord): boolean {
  return record.state === "done" || record.state === "cancelled" || record.acceptanceState === "accepted";
}

// ---------------------------------------------------------------------------
// Notifier

export type TaskReadyNotice = {
  flightId: string;
  invocationId: string;
  summary: string;
  /** The agent that finished it. */
  agentId: string;
  conversationId?: string;
  workId?: string;
};

export type TaskReadyNotifierOptions = {
  nodeId: string;
  /** An open operator question or permission owns the ping for its flight. */
  hasOpenOperatorRequest: (flight: FlightRecord) => boolean;
  notify: (notice: TaskReadyNotice) => void;
  workIdFor?: (invocation: InvocationRequest | undefined) => string | undefined;
  capacity?: number;
};

/** Rings once per flight, from the runtime that wrote its Ready. */
export class TaskReadyNotifier {
  private readonly seen = new Set<string>();
  private readonly capacity: number;

  constructor(private readonly options: TaskReadyNotifierOptions) {
    this.capacity = options.capacity ?? 2_000;
  }

  noteFlight(previous: FlightRecord | undefined, flight: FlightRecord, invocation: InvocationRequest | undefined): boolean {
    if (!taskReadyEntered(previous, flight)) return false;
    const ready = taskReadyOf(flight)!;
    // Keyed by the flight (and its round), so one Ready rings once.
    const key = `${flight.id}:${ready.at}`;
    if (ready.nodeId !== this.options.nodeId || this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    if (this.options.hasOpenOperatorRequest(flight)) return false;
    const workId = this.options.workIdFor?.(invocation);
    this.options.notify({
      flightId: flight.id,
      invocationId: flight.invocationId,
      summary: ready.summary,
      agentId: flight.targetAgentId,
      ...(invocation?.conversationId ? { conversationId: invocation.conversationId } : {}),
      ...(workId ? { workId } : {}),
    });
    return true;
  }
}

// ---------------------------------------------------------------------------
// Moves

type Task = { invocation: InvocationRequest; flight: FlightRecord };

export type BrokerTaskReadyServiceOptions = {
  nodeId: string;
  operatorActorId: string;
  resolve: (ref: string) => Promise<Task>;
  /** The latest stored copy of a flight. */
  flight: (flightId: string) => FlightRecord | undefined;
  recordFlight: (flight: FlightRecord) => Promise<void>;
  workItem: (invocation: InvocationRequest) => WorkItemRecord | undefined;
  recordWorkItem: (record: WorkItemRecord) => Promise<void>;
  appendWorkEvent: (event: CollaborationEvent) => Promise<void>;
  /**
   * Deliver "Continue" into the task's session: a follow-up on a task that is
   * still open, or a successor in the same session for a finished one.
   */
  deliverContinue: (task: Task, input: { requestId: string; actorId: string; notify: boolean }) => Promise<TaskReadyDecideResponse["continuation"]>;
  createId: (prefix: string) => string;
  now?: () => number;
};

export class BrokerTaskReadyService {
  constructor(private readonly options: BrokerTaskReadyServiceOptions) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private async localTask(ref: string): Promise<Task> {
    const task = await this.options.resolve(ref);
    const home = task.invocation.metadata?.taskHomeNodeId;
    if (typeof home === "string" && home && home !== this.options.nodeId) {
      throw new TaskReadyError(409, `task ${task.invocation.id} lives on node ${home}; use that runtime`);
    }
    return task;
  }

  /** Set or clear the mark on a task that has not finished. */
  async setNotify(input: { ref: string; notify: boolean; actorId: string }): Promise<TaskNotifyResponse> {
    const { invocation, flight } = await this.localTask(input.ref);
    if (input.actorId !== this.options.operatorActorId && input.actorId !== invocation.requesterId) {
      throw new TaskReadyError(403, "only the operator or the task's asker can set notify");
    }
    if (isTerminalFlightState(flight.state)) {
      throw new TaskReadyError(409, `task ${invocation.id} is ${flight.state}; notify applies to a running task`);
    }
    const mark: TaskReadyNotifyMark = { on: input.notify, byId: input.actorId, at: this.now() };
    await this.options.recordFlight({ ...flight, metadata: { ...flight.metadata, [TASK_READY_NOTIFY_KEY]: mark } });
    const current = this.options.flight(flight.id) ?? flight;
    return { ok: true, invocationId: invocation.id, flightId: current.id, notify: taskReadyNotify(invocation, current) };
  }

  /** The operator's Continue or Hold on a Ready task. */
  async decide(input: { ref: string; decision: TaskReadyDecision; actorId: string; requestId?: string }): Promise<TaskReadyDecideResponse> {
    if (input.actorId !== this.options.operatorActorId) throw new TaskReadyError(403, "only the operator decides a Ready task");
    const task = await this.localTask(input.ref);
    const { invocation } = task;
    const flight = this.options.flight(task.flight.id) ?? task.flight;
    const ready = taskReadyOf(flight);
    if (!ready || ready.state !== "ready") {
      throw new TaskReadyError(409, `task ${invocation.id} is not Ready${ready ? ` (${ready.state})` : ""}`);
    }
    const now = this.now();
    const work = this.options.workItem(invocation);

    if (input.decision === "hold") {
      const held: TaskReady = { ...ready, heldAt: now, heldById: input.actorId };
      await this.options.recordFlight({ ...flight, metadata: { ...flight.metadata, [TASK_READY_KEY]: held } });
      if (work) {
        await this.options.appendWorkEvent({
          id: this.options.createId("evt"), recordId: work.id, recordKind: "work_item", kind: "dismissed",
          actorId: input.actorId, at: now, summary: "Hold: off the operator's list; still Ready.",
          metadata: { source: "scout-ready", taskReady: "hold", flightId: flight.id, invocationId: invocation.id },
        });
      }
      return { ok: true, invocationId: invocation.id, flightId: flight.id, decision: "hold", ready: held };
    }

    // Deliver first: a refused delivery leaves the task Ready for another try.
    const continuation = await this.options.deliverContinue({ invocation, flight }, {
      requestId: input.requestId?.trim() || `ready-continue-${flight.id}`,
      actorId: input.actorId,
      notify: taskReadyNotify(invocation, flight),
    });
    const latest = this.options.flight(flight.id) ?? flight;
    const continued: TaskReady = { ...(taskReadyOf(latest) ?? ready), state: "continued", continuedAt: now, continuedById: input.actorId };
    await this.options.recordFlight({ ...latest, metadata: { ...latest.metadata, [TASK_READY_KEY]: continued, nextMoveOwnerId: latest.targetAgentId } });
    if (work) {
      const next = planContinuedWorkItem(work, { now, agentId: flight.targetAgentId });
      if (next) await this.options.recordWorkItem(next);
      await this.options.appendWorkEvent({
        id: this.options.createId("evt"), recordId: work.id, recordKind: "work_item", kind: "accepted",
        actorId: input.actorId, at: now, summary: "Continue: back to the agent.",
        metadata: { source: "scout-ready", taskReady: "continue", flightId: flight.id, invocationId: invocation.id,
          ...(continuation?.invocationId ? { continuationInvocationId: continuation.invocationId } : {}) },
      });
    }
    return { ok: true, invocationId: invocation.id, flightId: flight.id, decision: "continue", ready: continued,
      ...(continuation ? { continuation } : {}) };
  }
}
