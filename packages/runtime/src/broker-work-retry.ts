import { createHash } from "node:crypto";
import { hasExplicitCompletion, failedRunCause, failedRunRetryable, FAILED_RUN_ACTIONS,
  type CollaborationRecord, type FlightRecord, type InvocationRequest, type ScoutDeliverRequest, type ScoutDeliverResponse,
  type WorkItemRecord, type WorkRetryRequest, type WorkRetryResponse } from "@openscout/protocol";
import type { BrokerDurableStore } from "./broker-durable-store.js";
import type { RuntimeRegistrySnapshot } from "./registry.js";
import { isFailedWork, newestWorkFlight, projectWorkFlight } from "./broker-failed-work.js";
import { readMessageRecord } from "./broker-message-records.js";
import { WorkLifecycleError } from "./broker-work-lifecycles.js";

type RetryIntent = { refused?: true; attempt: number; sourceFlightId: string; request: ScoutDeliverRequest };
type Options = {
  nodeId: string;
  snapshot(): RuntimeRegistrySnapshot;
  record(id: string): CollaborationRecord | undefined;
  durableStore: Pick<BrokerDurableStore, "runWrite" | "commitEntries" | "applyProjectedEntries">;
  apply(record: WorkItemRecord): Promise<void>;
  appendEvent(event: import("@openscout/protocol").CollaborationEvent): Promise<void>;
  accept(request: ScoutDeliverRequest): Promise<ScoutDeliverResponse>;
  place?: (before: WorkItemRecord, after: WorkItemRecord, context: { now: number; actorId: string; moveId: string }) => { record: WorkItemRecord; move?: unknown };
};

export function workRetryRequestId(workId: string, attempt: number): string {
  return `work-retry-${createHash("sha256").update(JSON.stringify([workId, attempt])).digest("hex")}`;
}

/** A reserved command survives an uncertain receipt; only an explicit call sends it. */
export class BrokerWorkRetryService {
  private readonly active = new Map<string, Promise<WorkRetryResponse>>();
  constructor(private readonly options: Options) {}

  readonly retry = (input: WorkRetryRequest): Promise<WorkRetryResponse> => {
    if (typeof input?.workId !== "string" || !input.workId.trim() || !Number.isSafeInteger(input.attempt) || input.attempt < 1) {
      throw new WorkLifecycleError(400, "work_retry requires workId and a positive integer attempt. Start at 1; reuse it after an uncertain receipt.");
    }
    input = { workId: input.workId.trim(), attempt: input.attempt };
    const key = workRetryRequestId(input.workId, input.attempt);
    const active = this.active.get(key);
    if (active) return active;
    const pending = this.run(input, key).finally(() => { this.active.delete(key); });
    this.active.set(key, pending);
    return pending;
  };

  private accepted(input: WorkRetryRequest, requestId: string): WorkRetryResponse | undefined {
    const record = this.options.record(input.workId);
    const receipts = record?.metadata?.workRetryReceipts as Record<string, WorkRetryResponse> | undefined;
    const receipt = receipts?.[input.attempt];
    if (receipt?.requestId === requestId && receipt.workId === input.workId && receipt.attempt === input.attempt) return receipt;
    const snapshot = this.options.snapshot();
    const invocation = Object.values(snapshot.invocations).find(item => item.requestId === requestId
      && item.collaborationRecordId === input.workId && item.metadata?.workRetryAttempt === input.attempt);
    const flight = invocation && newestWorkFlight(input.workId, [invocation], Object.values(snapshot.flights));
    return invocation && flight ? { ...input, requestId, invocationId: invocation.id, flightId: flight.id } : undefined;
  }

  private async run(input: WorkRetryRequest, requestId: string): Promise<WorkRetryResponse> {
    // Check before state validation: repeated attempts remain receipts even after Done/Drop.
    const existing = this.accepted(input, requestId);
    if (existing) { await this.settle(input, existing); return existing; }
    let intent!: RetryIntent;
    const entries = await this.options.durableStore.runWrite(async () => {
      const record = this.options.record(input.workId);
      const snapshot = this.options.snapshot();
      const flight = newestWorkFlight(input.workId, Object.values(snapshot.invocations), Object.values(snapshot.flights));
      if (!record || !isFailedWork(record, flight) || flight?.state !== "failed") {
        throw new WorkLifecycleError(409, `Work ${input.workId} is not waiting on its newest failed run. Read the work item; use Done or Drop, or create a new ask.`);
      }
      const cause = failedRunCause(flight);
      if (!failedRunRetryable(cause)) throw new WorkLifecycleError(409, `Work ${input.workId} cannot retry cause ${cause}. ${FAILED_RUN_ACTIONS[cause]}`);
      const prior = record.metadata?.failedRunRetry as RetryIntent | undefined;
      if (prior?.attempt === input.attempt) {
        if (prior.refused) throw new WorkLifecycleError(409, `Retry attempt ${input.attempt} was refused before execution. Fix the target, then use attempt ${input.attempt + 1}.`);
        intent = prior; return [];
      }
      const expected = (prior?.attempt ?? 0) + 1;
      if (input.attempt !== expected) throw new WorkLifecycleError(409, `Next retry attempt is ${expected}; reuse an earlier attempt only to recover its receipt.`);
      if (prior && !prior.refused && !this.accepted({ workId: input.workId, attempt: prior.attempt }, prior.request.requestId!)) {
        throw new WorkLifecycleError(409, `Retry attempt ${prior.attempt} has an uncertain receipt. Repeat that attempt before starting another.`);
      }
      const original = snapshot.invocations[flight.invocationId];
      if (!original?.task?.trim()) throw new WorkLifecycleError(409, "Original ask is unavailable. Create a new ask with the intended task and target.");
      const fresh = this.freshTarget(original, snapshot, flight);
      const originalMessage = original.messageId ? await readMessageRecord(snapshot.messages, original.messageId) : undefined;
      if (original.messageId && !originalMessage) throw new WorkLifecycleError(409, "Original ask message is unavailable. Create a new ask so its attachments and context are explicit.");
      const { targetSessionId: _session, forkFromStateId: _state, forkFromSessionId: _fork, forkContext: _context, lineage: _lineage, ...execution } = original.execution ?? {};
      intent = { attempt: input.attempt, sourceFlightId: flight.id, request: {
        requestId, createdAt: Math.max(Date.now(), original.createdAt + 1), requesterId: original.requesterId, requesterNodeId: original.requesterNodeId,
        intent: "consult", body: original.task, target: fresh.target, collaborationRecordId: record.id,
        ...(hasExplicitCompletion(original) ? { completion: { mode: "explicit" as const } } : {}),
        ensureAwake: true, execution: { ...execution, ...(fresh.harness ? { harness: fresh.harness } : {}), session: "new" }, labels: original.labels,
        attachments: originalMessage?.attachments,
        invocationMetadata: { workRetryAttempt: input.attempt, workRetrySourceFlightId: flight.id,
          ...(original.metadata?.taskVersion === 1 ? { taskVersion: 1, taskHomeNodeId: this.options.nodeId } : {}) },
      } };
      const next = { ...record, metadata: { ...record.metadata, failedRunRetry: intent } };
      return this.options.durableStore.commitEntries({ kind: "collaboration.record", record: next },
        async () => { await this.options.apply(next); }, { enqueueProjection: false });
    });
    await this.options.durableStore.applyProjectedEntries(entries);
    const result = await this.options.accept(intent.request);
    if (!result.accepted) {
      const refusedEntries = await this.options.durableStore.runWrite(async () => {
        const record = this.options.record(input.workId);
        const current = record?.metadata?.failedRunRetry as RetryIntent | undefined;
        if (!record || record.kind !== "work_item" || current?.attempt !== input.attempt) return [];
        const next = { ...record, metadata: { ...record.metadata, failedRunRetry: { ...current, refused: true } } };
        return this.options.durableStore.commitEntries({ kind: "collaboration.record", record: next },
          async () => { await this.options.apply(next); }, { enqueueProjection: false });
      });
      await this.options.durableStore.applyProjectedEntries(refusedEntries);
      const detail = result.kind === "question" ? result.question?.detail : result.reason;
      throw new WorkLifecycleError(409, `Retry attempt ${input.attempt} was refused before execution: ${detail ?? "target unavailable"}. Fix the target, then use attempt ${input.attempt + 1}.`);
    }
    if (result.kind !== "delivery" || !result.flight) {
      throw new WorkLifecycleError(409, `Retry has an uncertain receipt. Repeat attempt ${input.attempt}; do not increment it.`);
    }
    const receipt = { ...input, requestId, invocationId: result.flight.invocationId, flightId: result.flight.id };
    await this.settle(input, receipt);
    return receipt;
  }

  private freshTarget(original: InvocationRequest, snapshot: RuntimeRegistrySnapshot, flight: FlightRecord): {
    target: NonNullable<ScoutDeliverRequest["target"]>; harness?: NonNullable<InvocationRequest["execution"]>["harness"];
  } {
    if (snapshot.agents[original.targetAgentId]) return { target: { kind: "agent_id", agentId: original.targetAgentId } };
    // Session actors cannot start a new session under their old identity. Keep
    // their verified project/harness capability, never continue the broken session.
    const endpoints = Object.values(snapshot.endpoints).filter(item => item.agentId === original.targetAgentId);
    const ackId = (flight.metadata?.dispatchAck as { endpointId?: string } | undefined)?.endpointId;
    const endpoint = ackId ? endpoints.find(item => item.id === ackId)
      : original.execution?.targetSessionId ? endpoints.find(item => item.sessionId === original.execution!.targetSessionId)
      : endpoints.length === 1 ? endpoints[0] : undefined;
    if (endpoint?.nodeId !== this.options.nodeId || !endpoint.cwd
      || (original.execution?.harness && endpoint.harness !== original.execution.harness)) {
      throw new WorkLifecycleError(409, "The session-only target has no verified local project and harness for a fresh session. Create a new ask with --project and --harness.");
    }
    return { target: { kind: "project_path", projectPath: endpoint.cwd }, harness: endpoint.harness };
  }

  private async settle(input: WorkRetryRequest, receipt: WorkRetryResponse): Promise<void> {
    const entries = await this.options.durableStore.runWrite(async () => {
      const record = this.options.record(input.workId);
      const snapshot = this.options.snapshot();
      if (!record || record.kind !== "work_item") return [];
      const receipts = record.metadata?.workRetryReceipts as Record<string, WorkRetryResponse> | undefined;
      if (receipts?.[input.attempt]?.requestId === receipt.requestId) return [];
      const flight = snapshot.flights[receipt.flightId];
      const latest = newestWorkFlight(input.workId, Object.values(snapshot.invocations), Object.values(snapshot.flights));
      const now = Date.now();
      const canProject = flight && latest?.id === flight.id && isFailedWork(record)
        && (record.metadata?.failedRunRetry as RetryIntent | undefined)?.attempt === input.attempt;
      const projected = canProject ? projectWorkFlight(record, flight, now) : record;
      const actorId = flight?.requesterId ?? record.requestedById ?? record.createdById;
      const placed = canProject ? this.options.place?.(record, projected, { now, actorId, moveId: `${receipt.requestId}:move` }) : undefined;
      const placedRecord = placed?.record ?? projected;
      const next = { ...placedRecord, metadata: { ...placedRecord.metadata,
        workRetryReceipts: { ...receipts, [input.attempt]: receipt } } };
      const event = { id: `${receipt.requestId}:accepted`, recordId: record.id, recordKind: "work_item" as const,
        kind: "progressed" as const, actorId, at: now, summary: `Retry attempt ${input.attempt} accepted.`,
        metadata: { ...receipt, ...(placed?.move ? { workMove: placed.move } : {}) } };
      return this.options.durableStore.commitEntries([{ kind: "collaboration.record", record: next }, { kind: "collaboration.event.record", event }],
        async () => { await this.options.apply(next); await this.options.appendEvent(event); }, { enqueueProjection: false });
    });
    await this.options.durableStore.applyProjectedEntries(entries);
  }
}
