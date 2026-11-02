import type {
  FlightRecord,
  InvocationRequest,
} from "@openscout/protocol";

import {
  isInvocationDispatchJobDue,
  type BrokerInvocationDispatchJob,
} from "./broker-dispatch-job.js";
import { isTerminalFlightState } from "./broker-local-invocation-helpers.js";

type DispatchRecoverySnapshot = {
  flights: Record<string, FlightRecord>;
};

export type BrokerDispatchRecoveryResult = {
  considered: number;
  dispatched: number;
  failed: number;
  skippedActive: number;
  skippedMissingInvocation: number;
};

export type BrokerDispatchRecoveryServiceDeps = {
  runtimeSnapshot: () => DispatchRecoverySnapshot;
  dispatchJobs: () => BrokerInvocationDispatchJob[];
  /** Exact ownership lookup, independent of a bounded scheduler enumeration. */
  dispatchJobForInvocation?: (invocationId: string) => BrokerInvocationDispatchJob | null | undefined;
  invocationFor: (invocationId: string) => InvocationRequest | undefined;
  isInvocationActive: (invocationId: string) => boolean;
  runDispatchJob: (job: BrokerInvocationDispatchJob, invocation?: InvocationRequest) => Promise<void>;
  /** Revalidate and persist the completed-to-pending transition before dispatch. */
  requeueDispatchJob?: (
    job: BrokerInvocationDispatchJob,
    invocation: InvocationRequest,
    flight: FlightRecord,
  ) => Promise<void>;
  dispatchAcceptedInvocation?: (invocation: InvocationRequest) => Promise<void>;
  /**
   * Fingerprint of the registry inputs that decide whether an agent has a
   * runnable endpoint (agent, actor, endpoints; liveness excluded). A delivery
   * parked for no_runnable_endpoint is retried at once when it changes, and
   * otherwise only on a widening backoff. Without it, every pass retries.
   */
  endpointWakeKey?: (agentId: string) => string;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  now?: () => number;
};

/**
 * Explicit evidence that the last local attempt did not submit work. A queued
 * flight alone is insufficient: a crash after submission can leave its state
 * stale. Completed scheduler jobs only retry these known pre-submission parks.
 */
export function isSafelyDeferredDispatchFlight(flight: FlightRecord): boolean {
  return deferredDispatchCheckedAt(flight) !== null;
}

export function deferredDispatchCheckedAt(flight: FlightRecord | undefined): number | null {
  if (flight?.state !== "queued" && flight?.state !== "waking") return null;
  const outcome = flight.metadata?.dispatchOutcome;
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return null;
  const deferred = outcome as Record<string, unknown>;
  return (deferred.status === "not_submitted"
    || (flight.state === "queued" && deferred.status === "queued_until_online"
      && (deferred.reason === "no_runnable_endpoint" || deferred.reason === "thread_held_externally")))
    && typeof deferred.checkedAt === "number"
    && Number.isFinite(deferred.checkedAt)
    && deferred.checkedAt > 0
    ? deferred.checkedAt : null;
}

/** A pre-submission park that waits for the target to gain a runnable endpoint. */
export function isAwaitingRunnableEndpoint(flight: FlightRecord | undefined): boolean {
  if (flight?.state !== "queued") return false;
  const outcome = flight.metadata?.dispatchOutcome;
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return false;
  const deferred = outcome as Record<string, unknown>;
  return deferred.status === "queued_until_online" && deferred.reason === "no_runnable_endpoint";
}

export const ENDPOINT_WAIT_INITIAL_MS = 60_000;
export const ENDPOINT_WAIT_MAX_MS = 60 * 60_000;

type EndpointWait = { flightId: string; key: string; retryAt: number; delayMs: number };

function hasUnconsumedDeferral(job: BrokerInvocationDispatchJob, flight: FlightRecord): boolean {
  const checkedAt = deferredDispatchCheckedAt(flight);
  return checkedAt !== null && checkedAt >= job.createdAt && checkedAt > (job.lastDeferredAt ?? 0);
}

export class BrokerDispatchRecoveryService {
  readonly #recoveringInvocationIds = new Set<string>();
  readonly #deferredInvocations = new Map<string, number>();
  /** In memory only: a restart retries every park once, at startup. */
  readonly #endpointWaits = new Map<string, EndpointWait>();

  constructor(private readonly deps: BrokerDispatchRecoveryServiceDeps) {}

  /**
   * Suppress recovery redispatch for one invocation until `notBeforeTs`.
   * Used by thread_held_externally parks: restoring the endpoint's online
   * state fires this service via the persist hook, and without the deferral
   * the parked flight would redispatch (and re-fail) in a hot loop.
   */
  deferInvocation(invocationId: string, notBeforeTs: number): void {
    this.#deferredInvocations.set(invocationId, notBeforeTs);
  }

  #isDeferred(invocationId: string, now: number): boolean {
    const notBefore = this.#deferredInvocations.get(invocationId);
    if (notBefore === undefined) return false;
    if (now >= notBefore) {
      this.#deferredInvocations.delete(invocationId);
      return false;
    }
    return true;
  }

  /**
   * Retrying a park for no_runnable_endpoint against the same registry inputs
   * repeats work that cannot succeed and appends job and flight records each
   * time. Retry when the inputs change; otherwise back off to ENDPOINT_WAIT_MAX_MS.
   */
  #endpointWaitAllows(invocationId: string, agentId: string, flight: FlightRecord | undefined, now: number, reason: string): boolean {
    if (!this.deps.endpointWakeKey || reason === "startup" || !isAwaitingRunnableEndpoint(flight)) return true;
    const wait = this.#endpointWaits.get(invocationId);
    return !wait || now >= wait.retryAt || wait.key !== this.deps.endpointWakeKey(agentId);
  }

  #noteEndpointAttempt(invocationId: string, agentId: string, flight: FlightRecord | undefined, now: number): void {
    if (!this.deps.endpointWakeKey || !flight || !isAwaitingRunnableEndpoint(flight)) {
      this.#endpointWaits.delete(invocationId);
      return;
    }
    const key = this.deps.endpointWakeKey(agentId);
    const previous = this.#endpointWaits.get(invocationId);
    const delayMs = previous && previous.key === key
      ? Math.min(previous.delayMs * 2, ENDPOINT_WAIT_MAX_MS)
      : ENDPOINT_WAIT_INITIAL_MS;
    this.#endpointWaits.set(invocationId, { flightId: flight.id, key, retryAt: now + delayMs, delayMs });
  }

  /** Test and diagnostics view of the in-memory endpoint waits. */
  endpointWaits(): ReadonlyMap<string, Readonly<EndpointWait>> {
    return this.#endpointWaits;
  }

  async recoverQueuedFlights(input: {
    reason: string;
    agentId?: string;
  }): Promise<BrokerDispatchRecoveryResult> {
    const now = this.deps.now?.() ?? Date.now();
    const allJobs = this.deps.dispatchJobs();
    // Ownership is independent of eligibility. In particular, an unexpired
    // running lease must not turn its queued flight into a legacy invocation.
    const jobInvocationIds = new Set(allJobs.map((job) => job.invocationId));
    const snapshot = this.deps.runtimeSnapshot();
    for (const [invocationId, wait] of this.#endpointWaits) {
      if (!isAwaitingRunnableEndpoint(snapshot.flights[wait.flightId])) this.#endpointWaits.delete(invocationId);
    }
    const jobs = allJobs
      .filter((job) => {
        const flight = snapshot.flights[job.flightId];
        if (flight && isTerminalFlightState(flight.state)) return false;
        const due = isInvocationDispatchJobDue(job, now, { includeRunning: true });
        // Lease expiry proves that the old claim expired, not that its effect
        // was never submitted. Only affirmative parked-before-send evidence
        // allows recovery of an already-running attempt.
        return (due && (job.state !== "running" || (flight !== undefined && hasUnconsumedDeferral(job, flight))))
          || (job.state === "completed" && flight !== undefined && hasUnconsumedDeferral(job, flight));
      })
      .filter((job) => !input.agentId || job.targetAgentId === input.agentId)
      .filter((job) => !this.#isDeferred(job.invocationId, now))
      .filter((job) => this.#endpointWaitAllows(job.invocationId, job.targetAgentId, snapshot.flights[job.flightId], now, input.reason))
      .sort((left, right) => left.createdAt - right.createdAt);
    const queued = Object.values(snapshot.flights)
      .filter((flight) => flight.state === "queued" || flight.state === "waking")
      .filter((flight) => !input.agentId || flight.targetAgentId === input.agentId)
      .filter((flight) => !jobInvocationIds.has(flight.invocationId))
      .filter((flight) => !this.#isDeferred(flight.invocationId, now))
      .filter((flight) => this.#endpointWaitAllows(flight.invocationId, flight.targetAgentId, flight, now, input.reason))
      .sort((left, right) => flightSortTime(left) - flightSortTime(right));
    const result: BrokerDispatchRecoveryResult = {
      considered: jobs.length + queued.length,
      dispatched: 0,
      failed: 0,
      skippedActive: 0,
      skippedMissingInvocation: 0,
    };
    const failedRecovery = (recordId: string, invocationId: string, error: unknown): void => {
      result.failed += 1;
      // Keep one bad record from interrupting other owners, or flooding logs.
      // The runner owns durable failure/unknown-submission state; this catch
      // must not invent retry evidence or change an execution outcome.
      if (result.failed <= 5) {
        const detail = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
        this.deps.warn?.(`[openscout-runtime] recovery failed for ${recordId} (invocation ${invocationId}); other work continues: ${detail}`);
      }
    };

    for (const job of jobs) {
      const invocation = this.deps.invocationFor(job.invocationId);
      if (!invocation) {
        result.skippedMissingInvocation += 1;
        this.deps.warn?.(
          `[openscout-runtime] dispatch job ${job.id} has no invocation ${job.invocationId}; recovery skipped`,
        );
        continue;
      }
      if (
        this.deps.isInvocationActive(invocation.id)
        || this.#recoveringInvocationIds.has(invocation.id)
      ) {
        result.skippedActive += 1;
        continue;
      }

      this.#recoveringInvocationIds.add(invocation.id);
      try {
        const currentFlight = this.deps.runtimeSnapshot().flights[job.flightId];
        if (currentFlight && isTerminalFlightState(currentFlight.state)) continue;
        if (job.state === "running" && (!currentFlight || !hasUnconsumedDeferral(job, currentFlight))) continue;
        if (job.state === "completed") {
          if (!currentFlight || !hasUnconsumedDeferral(job, currentFlight) || !this.deps.requeueDispatchJob) {
            continue;
          }
          this.deps.log?.(
            `[openscout-runtime] requeuing deferred dispatch job ${job.id} for ${job.targetAgentId} (${input.reason})`,
          );
          this.#noteEndpointAttempt(invocation.id, job.targetAgentId, currentFlight, now);
          await this.deps.requeueDispatchJob(job, invocation, currentFlight);
          result.dispatched += 1;
          continue;
        }
        this.deps.log?.(
          `[openscout-runtime] recovering dispatch job ${job.id} for ${job.targetAgentId} (${input.reason})`,
        );
        this.#noteEndpointAttempt(invocation.id, job.targetAgentId, currentFlight, now);
        await this.deps.runDispatchJob(job, invocation);
        result.dispatched += 1;
      } catch (error) {
        failedRecovery(job.id, invocation.id, error);
      } finally {
        this.#recoveringInvocationIds.delete(invocation.id);
      }
    }

    for (const flight of queued) {
      // Recheck after earlier awaited dispatches: an invocation may have gained
      // a job, or the scheduler enumeration may have omitted its historical row.
      const owningJob = this.deps.dispatchJobForInvocation
        ? this.deps.dispatchJobForInvocation(flight.invocationId)
        : this.deps.dispatchJobs().find((job) => job.invocationId === flight.invocationId);
      if (owningJob) continue;
      const currentFlight = this.deps.runtimeSnapshot().flights[flight.id];
      if (!currentFlight || (currentFlight.state !== "queued" && currentFlight.state !== "waking")) continue;
      const invocation = this.deps.invocationFor(flight.invocationId);
      if (!invocation) {
        result.skippedMissingInvocation += 1;
        this.deps.warn?.(
          `[openscout-runtime] queued flight ${flight.id} has no invocation ${flight.invocationId}; recovery skipped`,
        );
        continue;
      }
      if (
        this.deps.isInvocationActive(invocation.id)
        || this.#recoveringInvocationIds.has(invocation.id)
      ) {
        result.skippedActive += 1;
        continue;
      }
      if (!this.deps.dispatchAcceptedInvocation) {
        continue;
      }

      this.#recoveringInvocationIds.add(invocation.id);
      try {
        this.deps.log?.(
          `[openscout-runtime] recovering legacy queued flight ${flight.id} for ${flight.targetAgentId} (${input.reason})`,
        );
        this.#noteEndpointAttempt(invocation.id, flight.targetAgentId, currentFlight, now);
        await this.deps.dispatchAcceptedInvocation(invocation);
        result.dispatched += 1;
      } catch (error) {
        failedRecovery(flight.id, invocation.id, error);
      } finally {
        this.#recoveringInvocationIds.delete(invocation.id);
      }
    }

    if (result.failed > 5) this.deps.warn?.(`[openscout-runtime] ${result.failed - 5} additional recovery failures retained their own lifecycle state.`);
    return result;
  }
}

function flightSortTime(flight: FlightRecord): number {
  return flight.startedAt ?? flight.completedAt ?? 0;
}
