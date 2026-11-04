import {
  type ActorIdentity,
  type AgentDefinition,
  type FlightRecord,
  type InvocationRequest,
  type MessageRecord,
  type NodeDefinition,
  type ScoutDispatchEnvelope,
  type ScoutDispatchRecord,
  type ScoutDispatchUnavailableTarget,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";
import {
  createInvocationDispatchJob,
  isInvocationDispatchJobDue,
  isTerminalInvocationDispatchJobState,
  type BrokerInvocationDispatchJob,
} from "./broker-dispatch-job.js";
import type { InvocationResolution } from "./broker-delivery-routing.js";
import {
  askedLabelForRouteTarget,
  buildDispatchEnvelope,
  type BrokerRouteTargetInput,
  type RuntimeSnapshot,
} from "./scout-dispatcher.js";
import {
  describeUnavailableSessionEndpoint,
  homeEndpointForAgent,
} from "./broker-endpoint-selection.js";
import { isReachableMeshNode } from "./broker-mesh-forwarding-service.js";
import { isTerminalFlightState } from "./broker-local-invocation-helpers.js";
import { deferredDispatchCheckedAt } from "./broker-dispatch-recovery-service.js";
import { isIdempotentInvocationRetry } from "./broker-invocation-idempotency.js";
import type { DeliveryWorkItemResolution } from "./broker-work-item-store.js";

export type BrokerInvocationDispatchRuntime = {
  snapshot(): RuntimeSnapshot;
  /** Read-only view for synchronous lookups; do not retain it across awaits. */
  routingSnapshot?(): RuntimeSnapshot;
  actor(actorId: string): ActorIdentity | undefined;
  agent(agentId: string): AgentDefinition | undefined;
  node(nodeId: string): NodeDefinition | undefined;
  flightForInvocation(invocationId: string): FlightRecord | undefined;
};

export type BrokerInvocationDispatchServiceDeps = {
  nodeId: string;
  runtime: BrokerInvocationDispatchRuntime;
  createId: (prefix: string) => string;
  syncRegisteredLocalAgentsIfChanged: (reason: string) => Promise<void>;
  resolveInvocationTarget: (
    payload: InvocationRequest & BrokerRouteTargetInput,
  ) => Promise<InvocationResolution>;
  recordScoutDispatch: (
    envelope: ScoutDispatchEnvelope,
    options?: {
      invocationId?: string;
      conversationId?: string;
      requesterId?: string;
    },
  ) => Promise<{ record: ScoutDispatchRecord }>;
  recordInvocation: (
    invocation: InvocationRequest,
    options?: {
      createDispatchJob?: (flight: FlightRecord) => BrokerInvocationDispatchJob;
      enqueueProjection?: boolean;
      message?: MessageRecord;
      receiptMessage?: MessageRecord;
      workItem?: DeliveryWorkItemResolution["pendingCreation"];
    },
  ) => Promise<{ flight: FlightRecord; dispatchJob?: BrokerInvocationDispatchJob; entries: BrokerJournalEntry[] }>;
  recordInvocationDispatchJob: (
    job: BrokerInvocationDispatchJob,
    options?: { enqueueProjection?: boolean },
  ) => Promise<BrokerJournalEntry[]>;
  recordInvocationDispatchJobIf: (
    job: BrokerInvocationDispatchJob,
    eligible: (current: BrokerInvocationDispatchJob | null) => boolean,
    options?: { enqueueProjection?: boolean },
  ) => Promise<BrokerJournalEntry[] | null>;
  applyProjectedEntries: (entries: BrokerJournalEntry | BrokerJournalEntry[]) => Promise<void>;
  recordFlight: (flight: FlightRecord) => Promise<void>;
  postInvocationStatusMessage: (invocation: InvocationRequest, flight: {
    id?: string;
    summary?: string;
    error?: string;
  }) => Promise<void>;
  describeRemoteAuthorityIssue: (
    agent: AgentDefinition,
    authorityNode: NodeDefinition | undefined,
  ) => ScoutDispatchUnavailableTarget | null;
  describeUnavailableInvocationTarget?: (
    snapshot: RuntimeSnapshot,
    agent: AgentDefinition,
    targetSessionId?: string,
  ) => ScoutDispatchUnavailableTarget | null;
  buildUnavailableDispatchEnvelope?: (
    askedLabel: string,
    unavailable: ScoutDispatchUnavailableTarget,
  ) => ScoutDispatchEnvelope;
  enqueuePeerInvocation: (invocation: InvocationRequest, authorityNode: NodeDefinition) => Promise<void>;
  launchLocalInvocation: (invocation: InvocationRequest) => void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string, detail: unknown) => void;
  now?: () => number;
};

const DISPATCH_JOB_LEASE_MS = 30_000;

export class BrokerInvocationDispatchService {
  private readonly activeDispatchJobs = new Set<string>();
  constructor(private readonly deps: BrokerInvocationDispatchServiceDeps) {}

  readonly acceptInvocation = async (
    invocation: InvocationRequest,
    message?: MessageRecord,
    workItem?: DeliveryWorkItemResolution["pendingCreation"],
    receiptMessage?: MessageRecord,
  ): Promise<{ flight: FlightRecord; dispatchJob: BrokerInvocationDispatchJob }> => {
    const { flight, dispatchJob, entries } = await this.deps.recordInvocation(invocation, {
      createDispatchJob: (nextFlight) => createInvocationDispatchJob(
        invocation,
        nextFlight,
        currentTime(this.deps),
      ),
      enqueueProjection: false,
      message,
      workItem,
      receiptMessage,
    });
    await this.deps.applyProjectedEntries(entries);
    if (!dispatchJob) {
      throw new Error(`dispatch job was not recorded for invocation ${invocation.id}`);
    }
    return { flight, dispatchJob };
  };

  readonly acceptAndDispatch = async (
    invocation: InvocationRequest,
    options: { includeOk?: boolean; logAccepted?: boolean } = {},
  ): Promise<{
    ok?: true;
    accepted: true;
    invocationId: string;
    flightId: string;
    targetAgentId: string;
    state: FlightRecord["state"];
    flight: FlightRecord;
  }> => {
    const existingInvocation = (this.deps.runtime.routingSnapshot?.() ?? this.deps.runtime.snapshot()).invocations[invocation.id];
    const existingFlight = this.deps.runtime.flightForInvocation(invocation.id);
    if (existingInvocation || existingFlight) {
      if (
        !existingInvocation
        || !existingFlight
        || !isIdempotentInvocationRetry(existingInvocation, invocation)
      ) {
        throw new Error(`invocation id ${invocation.id} is already assigned to a different record`);
      }
      return {
        ...(options.includeOk ? { ok: true as const } : {}),
        accepted: true,
        invocationId: existingInvocation.id,
        flightId: existingFlight.id,
        targetAgentId: existingFlight.targetAgentId,
        state: existingFlight.state,
        flight: existingFlight,
      };
    }

    const { flight, dispatchJob } = await this.acceptInvocation(invocation);
    if (options.logAccepted) {
      this.deps.log?.(
        `[openscout-runtime] invocation ${invocation.id} accepted for ${invocation.targetAgentId} (state=${flight.state})`,
      );
    }
    this.runDispatchJob(dispatchJob, invocation).catch((error) => {
      this.deps.error?.(
        `[openscout-runtime] background dispatch job failed for invocation ${invocation.id}:`,
        error,
      );
    });
    return {
      ...(options.includeOk ? { ok: true as const } : {}),
      accepted: true,
      invocationId: invocation.id,
      flightId: flight.id,
      targetAgentId: invocation.targetAgentId,
      state: flight.state,
      flight,
    };
  };

  readonly handleInvocationRequest = async (
    payload: InvocationRequest & BrokerRouteTargetInput,
  ): Promise<{
    accepted: true;
    invocationId: string;
    dispatch?: ScoutDispatchRecord;
    flightId?: string;
    targetAgentId?: string;
    state?: FlightRecord["state"];
    flight?: FlightRecord;
  }> => {
    await this.deps.syncRegisteredLocalAgentsIfChanged("invocation");
    const resolved = await this.deps.resolveInvocationTarget(payload);
    if (resolved.kind !== "resolved" && resolved.kind !== "resolved_session") {
      const envelope = buildDispatchEnvelope(
        resolved,
        askedLabelForRouteTarget(payload),
        this.deps.nodeId,
        (this.deps.runtime.routingSnapshot?.() ?? this.deps.runtime.snapshot()),
        { homeEndpointFor: homeEndpointForAgent },
      );
      const { record } = await this.deps.recordScoutDispatch(envelope, {
        invocationId: payload.id,
        conversationId: payload.conversationId,
        requesterId: payload.requesterId,
      });
      return {
        accepted: true,
        invocationId: payload.id,
        dispatch: record,
      };
    }

    // SCO-070: a cardless session resolves to an endpoint owned by the session
    // marker. The invocation target stores that actor id; no agent card is needed.
    const targetActorId = resolved.kind === "resolved"
      ? resolved.agent.id
      : resolved.session.actorId;
    const invocation: InvocationRequest = {
      ...payload,
      targetAgentId: targetActorId,
      ...(resolved.aliasResolution?.target.kind === "session" ? {
        execution: {
          ...(payload.execution ?? {}),
          session: "existing",
          targetSessionId: resolved.aliasResolution.target.sessionId,
        },
      } : {}),
      ...(resolved.aliasResolution ? {
        metadata: { ...(payload.metadata ?? {}), aliasResolution: resolved.aliasResolution },
      } : {}),
    };

    const unavailable = resolved.kind === "resolved"
      ? this.deps.describeUnavailableInvocationTarget?.(
          (this.deps.runtime.routingSnapshot?.() ?? this.deps.runtime.snapshot()),
          resolved.agent,
          targetSessionIdForInvocation(invocation),
        )
      : describeUnavailableSessionEndpoint(resolved.session.endpoint);
    if (unavailable && this.deps.buildUnavailableDispatchEnvelope) {
      const envelope = this.deps.buildUnavailableDispatchEnvelope(
        askedLabelForRouteTarget(payload),
        unavailable,
      );
      const { record } = await this.deps.recordScoutDispatch(envelope, {
        invocationId: payload.id,
        conversationId: payload.conversationId,
        requesterId: payload.requesterId,
      });
      return {
        accepted: true,
        invocationId: payload.id,
        dispatch: record,
      };
    }

    return await this.acceptAndDispatch(invocation);
  };

  readonly runDispatchJob = async (
    job: BrokerInvocationDispatchJob,
    invocation?: InvocationRequest,
  ): Promise<void> => {
    if (isTerminalInvocationDispatchJobState(job.state) || this.activeDispatchJobs.has(job.id)) {
      return;
    }

    this.activeDispatchJobs.add(job.id);
    try {
      await this.runClaimedDispatchJob(job, invocation);
    } finally {
      this.activeDispatchJobs.delete(job.id);
    }
  };

  private async runClaimedDispatchJob(
    job: BrokerInvocationDispatchJob,
    invocation?: InvocationRequest,
  ): Promise<void> {

    const dispatchInvocation = invocation ?? (this.deps.runtime.routingSnapshot?.() ?? this.deps.runtime.snapshot()).invocations[job.invocationId];
    if (!dispatchInvocation) {
      const failedAt = currentTime(this.deps);
      await this.recordDispatchJobIf({
        ...job,
        state: "failed",
        updatedAt: failedAt,
        completedAt: failedAt,
        lastError: `missing invocation ${job.invocationId}`,
      }, (current) => matchesDispatchJobVersion(current, job));
      return;
    }

    const startedAt = currentTime(this.deps);
    const deferredAt = deferredDispatchCheckedAt(this.deps.runtime.flightForInvocation(job.invocationId));
    const runningJob: BrokerInvocationDispatchJob = {
      ...job,
      state: "running",
      attempts: job.attempts + 1,
      updatedAt: startedAt,
      leaseOwner: `broker:${this.deps.nodeId}`,
      leaseExpiresAt: startedAt + DISPATCH_JOB_LEASE_MS,
      lastError: undefined,
      completedAt: undefined,
      ...(job.state === "running" && deferredAt !== null ? { lastDeferredAt: deferredAt } : {}),
    };
    const claimed = await this.recordDispatchJobIf(runningJob, (current) =>
      matchesDispatchJobVersion(current, job)
      && isInvocationDispatchJobDue(current!, currentTime(this.deps), { includeRunning: true })
      && (current!.state === "pending" || hasUnconsumedDeferral(current!, this.deps.runtime.flightForInvocation(job.invocationId))));
    if (!claimed) return;

    try {
      await this.dispatchAcceptedInvocation(dispatchInvocation);
      const completedAt = currentTime(this.deps);
      await this.recordDispatchJobIf({
        ...runningJob,
        state: "completed",
        updatedAt: completedAt,
        completedAt,
        leaseExpiresAt: undefined,
      }, (current) => matchesDispatchJobVersion(current, runningJob));
    } catch (error) {
      const failedAt = currentTime(this.deps);
      const message = error instanceof Error ? error.message : String(error);
      await this.recordDispatchJobIf({
        ...runningJob,
        state: "failed",
        updatedAt: failedAt,
        completedAt: failedAt,
        leaseExpiresAt: undefined,
        lastError: message,
      }, (current) => matchesDispatchJobVersion(current, runningJob));
      throw error;
    }
  }

  readonly requeueDispatchJob = async (
    job: BrokerInvocationDispatchJob,
    invocation: InvocationRequest,
    flight: FlightRecord,
  ): Promise<void> => {
    const pending: BrokerInvocationDispatchJob = {
      ...job, state: "pending", updatedAt: currentTime(this.deps),
      completedAt: undefined, leaseOwner: undefined, leaseExpiresAt: undefined,
      lastDeferredAt: deferredDispatchCheckedAt(flight) ?? undefined,
    };
    const requeued = await this.recordDispatchJobIf(pending, (current) => {
      const latestFlight = this.deps.runtime.flightForInvocation(invocation.id);
      return job.state === "completed" && matchesDispatchJobVersion(current, job)
        && latestFlight?.id === flight.id && hasUnconsumedDeferral(current!, latestFlight)
        && deferredDispatchCheckedAt(latestFlight) === pending.lastDeferredAt;
    });
    if (requeued) await this.runDispatchJob(pending, invocation);
  };

  readonly dispatchAcceptedInvocation = async (invocation: InvocationRequest): Promise<void> => {
    if (invocation.metadata?.humanOwned === true) return;
    const flight = this.deps.runtime.flightForInvocation(invocation.id);
    if (!flight) {
      this.deps.warn?.(`[openscout-runtime] dispatch skipped - flight missing for invocation ${invocation.id}`);
      return;
    }
    // Fence before target validation as well as local/peer side effects. A
    // deleted target cannot turn an already completed invocation into failure.
    if (isTerminalFlightState(flight.state)) return;
    const targetAgent = this.deps.runtime.agent(invocation.targetAgentId);
    const targetActor = this.deps.runtime.actor(invocation.targetAgentId) ?? targetAgent;
    if (!targetActor) {
      await this.failAcceptedInvocation(invocation, `unknown target actor ${invocation.targetAgentId}`);
      return;
    }

    if (targetAgent?.authorityNodeId && targetAgent.authorityNodeId !== this.deps.nodeId) {
      const authorityNode = this.deps.runtime.node(targetAgent.authorityNodeId);
      const authorityIssue = this.deps.describeRemoteAuthorityIssue(targetAgent, authorityNode);
      if (authorityIssue) {
        await this.failAcceptedInvocation(invocation, authorityIssue.detail);
        return;
      }
      await this.deps.enqueuePeerInvocation(invocation, authorityNode!);
      return;
    }

    // Cardless session targets carry no agent card, so authority rides on the
    // endpoint: one owned by another node (adopted from a mesh session wake)
    // forwards there instead of dead-ending in a local launch.
    if (!targetAgent) {
      const homeEndpoint = homeEndpointForAgent((this.deps.runtime.routingSnapshot?.() ?? this.deps.runtime.snapshot()), invocation.targetAgentId);
      if (homeEndpoint && homeEndpoint.nodeId !== this.deps.nodeId) {
        const ownerNode = this.deps.runtime.node(homeEndpoint.nodeId);
        if (!ownerNode || !isReachableMeshNode(ownerNode)) {
          await this.failAcceptedInvocation(
            invocation,
            `session endpoint for ${invocation.targetAgentId} lives on ${homeEndpoint.nodeId}, which has no reachable broker URL`,
          );
          return;
        }
        await this.deps.enqueuePeerInvocation(invocation, ownerNode);
        return;
      }
    }

    this.deps.launchLocalInvocation(invocation);
  };

  readonly failAcceptedInvocation = async (
    invocation: InvocationRequest,
    detail: string,
  ): Promise<void> => {
    const now = currentTime(this.deps);
    const existing = this.deps.runtime.flightForInvocation(invocation.id);
    if (existing && isTerminalFlightState(existing.state)) return;
    const failed: FlightRecord = {
      id: existing?.id ?? this.deps.createId("flt"),
      invocationId: invocation.id,
      requesterId: invocation.requesterId,
      targetAgentId: invocation.targetAgentId,
      state: "failed",
      startedAt: existing?.startedAt ?? now,
      completedAt: now,
      summary: detail,
      error: detail,
      metadata: invocation.metadata,
    };
    await this.deps.recordFlight(failed);
    await this.deps.postInvocationStatusMessage(invocation, failed);
  };

  private async recordDispatchJobIf(
    job: BrokerInvocationDispatchJob,
    eligible: (current: BrokerInvocationDispatchJob | null) => boolean,
  ): Promise<boolean> {
    const entries = await this.deps.recordInvocationDispatchJobIf(job, eligible, { enqueueProjection: false });
    if (!entries) return false;
    await this.deps.applyProjectedEntries(entries);
    return true;
  }
}

function matchesDispatchJobVersion(current: BrokerInvocationDispatchJob | null, expected: BrokerInvocationDispatchJob): boolean {
  return current !== null && current.id === expected.id && current.state === expected.state
    && current.attempts === expected.attempts && current.updatedAt === expected.updatedAt
    && current.leaseOwner === expected.leaseOwner && current.leaseExpiresAt === expected.leaseExpiresAt;
}

function hasUnconsumedDeferral(job: BrokerInvocationDispatchJob, flight: FlightRecord | undefined): boolean {
  const checkedAt = deferredDispatchCheckedAt(flight);
  return checkedAt !== null && checkedAt >= job.createdAt && checkedAt > (job.lastDeferredAt ?? 0);
}

function currentTime(deps: Pick<BrokerInvocationDispatchServiceDeps, "now">): number {
  return deps.now?.() ?? Date.now();
}

function targetSessionIdForInvocation(invocation: InvocationRequest): string | undefined {
  const executionTarget = invocation.execution?.targetSessionId?.trim();
  if (executionTarget) {
    return executionTarget;
  }
  const metadataTarget = typeof invocation.metadata?.targetSessionId === "string"
    ? invocation.metadata.targetSessionId.trim()
    : "";
  return metadataTarget || undefined;
}
