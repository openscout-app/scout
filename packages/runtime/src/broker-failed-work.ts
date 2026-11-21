import { FAILED_RUN_ACTIONS, failedRunCause, failedRunRetryable, taskReadyOf,
  type CollaborationRecord, type FlightRecord, type InvocationRequest, type WorkItemRecord } from "@openscout/protocol";
import { TASK_READY_PRIOR_ACCEPTANCE_KEY } from "./broker-task-ready.js";

export function invocationWorkId(invocation: InvocationRequest): string | undefined {
  const nested = invocation.context?.collaboration as { recordId?: string } | undefined;
  for (const id of [invocation.collaborationRecordId, invocation.metadata?.collaborationRecordId,
    invocation.metadata?.workId, invocation.context?.collaborationRecordId, nested?.recordId]) {
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return undefined;
}

/** Same work, not merely the same endpoint. Completion time never orders asks. */
export function newestWorkFlight(workId: string, invocations: Iterable<InvocationRequest>, flights: Iterable<FlightRecord>): FlightRecord | undefined {
  const owners = new Map<string, InvocationRequest>();
  for (const item of invocations) if (invocationWorkId(item) === workId) owners.set(item.id, item);
  let newest: FlightRecord | undefined;
  for (const flight of flights) {
    const owner = owners.get(flight.invocationId);
    if (!owner) continue;
    const newestOwner = newest && owners.get(newest.invocationId)!;
    if (!newest || owner.createdAt > newestOwner!.createdAt
      || (owner.createdAt === newestOwner!.createdAt && ((flight.startedAt ?? 0) > (newest.startedAt ?? 0)
        || ((flight.startedAt ?? 0) === (newest.startedAt ?? 0) && flight.id > newest.id)))) newest = flight;
  }
  return newest;
}

export function isFailedWork(record: CollaborationRecord, flight?: FlightRecord): record is WorkItemRecord {
  return record.kind === "work_item" && record.state === "waiting"
    && (record.waitingOn?.kind === "failed_run"
      || (!record.waitingOn && (record.metadata?.lastFlightState === "failed" || Boolean(flight)))
      || (record.waitingOn?.kind === "actor" && typeof record.waitingOn.metadata?.flightId === "string"
        && (record.metadata?.lastFlightState === "failed" || typeof record.waitingOn.metadata?.invocationId === "string")));
}

export function projectWorkFlight(record: WorkItemRecord, flight: FlightRecord, now: number,
  options: { operatorActorId?: string } = {}): WorkItemRecord {
  // A task the operator asked to hear about lands in review for them.
  const ready = flight.state === "completed" && Boolean(taskReadyOf(flight)) && Boolean(options.operatorActorId);
  const review = flight.state === "completed" && (record.acceptanceState !== "none" || ready);
  const state = flight.state === "completed" ? review ? "review" : "done"
    : flight.state === "failed" ? "waiting" : flight.state === "cancelled" ? "cancelled" : "working";
  const cause = failedRunCause(flight);
  const detail = [flight.output, flight.error, flight.summary].map(value => value?.replace(/\s+/gu, " ").trim()).find(Boolean)
    ?? `${flight.targetAgentId}: ${flight.state}`;
  const summary = detail.length <= 320 ? detail : `${detail.slice(0, 317).trimEnd()}...`;
  return {
    ...record, state, summary: record.summary ?? summary, updatedAt: Math.max(now, record.updatedAt),
    acceptanceState: review ? "pending" : record.acceptanceState,
    ...(review ? { requestedById: record.requestedById ?? record.createdById } : {}),
    nextMoveOwnerId: ready ? options.operatorActorId!
      : review || flight.state === "failed" ? record.requestedById ?? record.createdById : flight.targetAgentId,
    progress: { ...record.progress, summary,
      completedSteps: flight.state === "completed" ? 1 : record.progress?.completedSteps,
      totalSteps: flight.state === "completed" ? 1 : record.progress?.totalSteps },
    completedAt: state === "done" || state === "cancelled" ? record.completedAt ?? now : undefined,
    reviewRequestedAt: review ? now : record.reviewRequestedAt,
    waitingOn: flight.state === "failed" ? { kind: "failed_run", cause, flightId: flight.id,
      retryable: failedRunRetryable(cause), label: `${cause}: ${FAILED_RUN_ACTIONS[cause]}` } : undefined,
    metadata: { ...record.metadata, ...(ready ? { [TASK_READY_PRIOR_ACCEPTANCE_KEY]: record.acceptanceState } : {}),
      lastInvocationId: flight.invocationId, lastFlightId: flight.id, lastFlightState: flight.state },
  };
}
