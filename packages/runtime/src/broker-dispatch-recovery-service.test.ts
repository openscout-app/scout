import { describe, expect, test } from "bun:test";

import type {
  FlightRecord,
  InvocationRequest,
} from "@openscout/protocol";

import type { BrokerInvocationDispatchJob } from "./broker-dispatch-job.js";
import {
  BrokerDispatchRecoveryService,
  ENDPOINT_WAIT_INITIAL_MS,
  ENDPOINT_WAIT_MAX_MS,
} from "./broker-dispatch-recovery-service.js";

function invocation(input: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    id: "invocation-1",
    requesterId: "operator",
    requesterNodeId: "node-1",
    targetAgentId: "agent-1",
    action: "consult",
    task: "hello",
    ensureAwake: false,
    stream: false,
    createdAt: 1_000,
    metadata: {},
    ...input,
  };
}

function flight(input: Partial<FlightRecord> = {}): FlightRecord {
  return {
    id: "flight-1",
    invocationId: "invocation-1",
    requesterId: "operator",
    targetAgentId: "agent-1",
    state: "queued",
    startedAt: 1_000,
    metadata: {},
    ...input,
  };
}

function dispatchJob(input: Partial<BrokerInvocationDispatchJob> = {}): BrokerInvocationDispatchJob {
  return {
    id: "dispatch-invocation-1",
    invocationId: "invocation-1",
    flightId: "flight-1",
    targetAgentId: "agent-1",
    state: "pending",
    attempts: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...input,
  };
}

function createService(input: {
  dispatchJobs?: BrokerInvocationDispatchJob[];
  flights: Record<string, FlightRecord>;
  invocations?: Record<string, InvocationRequest>;
  activeInvocationIds?: Set<string>;
  allDispatchJobs?: BrokerInvocationDispatchJob[];
  onRunJob?: (job: BrokerInvocationDispatchJob) => void | Promise<void>;
  onRequeueJob?: (job: BrokerInvocationDispatchJob) => void | Promise<void>;
  onDispatch?: (invocation: InvocationRequest) => void | Promise<void>;
  endpointWakeKey?: (agentId: string) => string;
  now?: () => number;
}): {
  dispatched: InvocationRequest[];
  logs: string[];
  runJobs: Array<{ job: BrokerInvocationDispatchJob; invocation?: InvocationRequest }>;
  requeuedJobs: Array<{ job: BrokerInvocationDispatchJob; invocation: InvocationRequest; flight: FlightRecord }>;
  service: BrokerDispatchRecoveryService;
  warnings: string[];
} {
  const invocations = input.invocations ?? {
    "invocation-1": invocation(),
  };
  const activeInvocationIds = input.activeInvocationIds ?? new Set<string>();
  const dispatched: InvocationRequest[] = [];
  const runJobs: Array<{ job: BrokerInvocationDispatchJob; invocation?: InvocationRequest }> = [];
  const requeuedJobs: Array<{ job: BrokerInvocationDispatchJob; invocation: InvocationRequest; flight: FlightRecord }> = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const service = new BrokerDispatchRecoveryService({
    runtimeSnapshot: () => ({ flights: input.flights }),
    dispatchJobs: () => input.dispatchJobs ?? [],
    dispatchJobForInvocation: (invocationId) => (input.allDispatchJobs ?? input.dispatchJobs ?? [])
      .find((job) => job.invocationId === invocationId),
    invocationFor: (invocationId) => invocations[invocationId],
    isInvocationActive: (invocationId) => activeInvocationIds.has(invocationId),
    async runDispatchJob(job, nextInvocation) {
      runJobs.push({ job, invocation: nextInvocation });
      await input.onRunJob?.(job);
    },
    async requeueDispatchJob(job, nextInvocation, nextFlight) {
      requeuedJobs.push({ job, invocation: nextInvocation, flight: nextFlight });
      await input.onRequeueJob?.(job);
    },
    async dispatchAcceptedInvocation(nextInvocation) {
      dispatched.push(nextInvocation);
      await input.onDispatch?.(nextInvocation);
    },
    endpointWakeKey: input.endpointWakeKey,
    log: (message) => logs.push(message),
    warn: (message) => warnings.push(message),
    now: input.now ?? (() => 10_000),
  });
  return { dispatched, logs, runJobs, requeuedJobs, service, warnings };
}

function deferredFlight(reason = "no_runnable_endpoint", input: Partial<FlightRecord> = {}): FlightRecord {
  return flight({
    metadata: { dispatchOutcome: { status: "queued_until_online", reason, checkedAt: 9_000 } },
    ...input,
  });
}

describe("BrokerDispatchRecoveryService", () => {
  test.each(["run", "requeue", "legacy"] as const)("a rejected %s recovery does not stop another session or reopen unknown submission", async (kind) => {
    const bad = invocation({ id: "bad", targetAgentId: "session:bad" });
    const good = invocation({ id: "good", targetAgentId: "session:good" });
    const unknown = invocation({ id: "unknown", targetAgentId: "session:unknown" });
    const badJob = dispatchJob({ id: "dispatch-bad", invocationId: bad.id, flightId: "flight-bad", targetAgentId: bad.targetAgentId,
      state: kind === "requeue" ? "completed" : "pending" });
    const goodJob = dispatchJob({ id: "dispatch-good", invocationId: good.id, flightId: "flight-good", targetAgentId: good.targetAgentId, createdAt: 2_000 });
    const unknownJob = dispatchJob({ id: "dispatch-unknown", invocationId: unknown.id, flightId: "flight-unknown", state: "running", leaseExpiresAt: 1 });
    const flights = {
      "flight-bad": deferredFlight("no_runnable_endpoint", { id: "flight-bad", invocationId: bad.id, targetAgentId: bad.targetAgentId }),
      "flight-good": flight({ id: "flight-good", invocationId: good.id, targetAgentId: good.targetAgentId, startedAt: 2_000 }),
      "flight-unknown": flight({ id: "flight-unknown", invocationId: unknown.id, state: "waiting",
        metadata: { dispatchOutcome: { status: "submission_unknown", checkedAt: 9_000 } } }),
    };
    const originalUnknown = structuredClone(flights["flight-unknown"]);
    const rejectBad = (id: string) => { if (id === bad.id) throw new Error("broken record fixture"); };
    const h = createService({
      invocations: { bad, good, unknown }, flights,
      dispatchJobs: kind === "legacy" ? [unknownJob] : [badJob, goodJob, unknownJob],
      onRunJob: job => rejectBad(job.invocationId),
      onRequeueJob: job => rejectBad(job.invocationId),
      onDispatch: next => rejectBad(next.id),
    });
    const result = await h.service.recoverQueuedFlights({ reason: "startup" });
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(1);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain("invocation bad");
    expect(kind === "legacy" ? h.dispatched.map(next => next.id) : h.runJobs.map(next => next.job.invocationId))
      .toContain("good");
    expect([...h.runJobs.map(next => next.job.invocationId), ...h.requeuedJobs.map(next => next.invocation.id), ...h.dispatched.map(next => next.id)])
      .not.toContain("unknown");
    expect(flights["flight-unknown"]).toEqual(originalUnknown);
    // Releasing the in-memory guard is mandatory even when the item failed.
    const retry = await h.service.recoverQueuedFlights({ reason: "queued_retry_sweep" });
    expect(retry.skippedActive).toBe(0);
    expect(retry.dispatched).toBe(1);
  });

  test("bounds detailed errors while continuing a large failing recovery page", async () => {
    const invocations = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`inv-${i}`, invocation({ id: `inv-${i}` })]));
    const jobs = Object.values(invocations).map(next => dispatchJob({ id: `job-${next.id}`, invocationId: next.id }));
    const h = createService({ invocations, dispatchJobs: jobs, flights: {}, onRunJob: () => { throw new Error("x".repeat(5_000)); } });
    expect((await h.service.recoverQueuedFlights({ reason: "startup" })).failed).toBe(12);
    expect(h.runJobs).toHaveLength(12);
    expect(h.warnings).toHaveLength(6);
    expect(h.warnings[0]!.length).toBeLessThan(1_200);
    expect(h.warnings[5]).toContain("7 additional");
  });

  test("recovers queued flights through the accepted-dispatch path", async () => {
    const invocations = {
      "invocation-old": invocation({ id: "invocation-old", targetAgentId: "agent-1" }),
      "invocation-new": invocation({ id: "invocation-new", targetAgentId: "agent-1" }),
    };
    const harness = createService({
      invocations,
      dispatchJobs: [
        dispatchJob({
          id: "dispatch-new",
          invocationId: "invocation-new",
          flightId: "flight-new",
          targetAgentId: "agent-1",
          createdAt: 2_000,
          updatedAt: 2_000,
        }),
        dispatchJob({
          id: "dispatch-old",
          invocationId: "invocation-old",
          flightId: "flight-old",
          targetAgentId: "agent-1",
          createdAt: 1_000,
          updatedAt: 1_000,
        }),
      ],
      flights: {
        "flight-new": flight({
          id: "flight-new",
          invocationId: "invocation-new",
          targetAgentId: "agent-1",
          startedAt: 2_000,
        }),
        "flight-old": flight({
          id: "flight-old",
          invocationId: "invocation-old",
          targetAgentId: "agent-1",
          startedAt: 1_000,
        }),
        done: flight({
          id: "done",
          invocationId: "invocation-done",
          targetAgentId: "agent-1",
          state: "completed",
        }),
      },
    });

    const result = await harness.service.recoverQueuedFlights({ reason: "startup" });

    expect(result).toEqual({
      considered: 2,
      dispatched: 2,
      failed: 0,
      skippedActive: 0,
      skippedMissingInvocation: 0,
    });
    expect(harness.runJobs.map((item) => item.invocation?.id)).toEqual([
      "invocation-old",
      "invocation-new",
    ]);
    expect(harness.dispatched).toEqual([]);
    expect(harness.logs[0]).toContain("startup");
  });

  test("defers a parked invocation until its retry time, then dispatches it", async () => {
    const harness = createService({
      flights: { "flight-1": flight() },
    });

    // Deferred into the future (now is fixed at 10_000): the queued flight is
    // suppressed — this is what keeps a thread_held_externally park from
    // redispatching in a hot loop off the endpoint-persist recovery hook.
    harness.service.deferInvocation("invocation-1", 20_000);
    const deferred = await harness.service.recoverQueuedFlights({ reason: "endpoint_online" });
    expect(deferred.dispatched).toBe(0);
    expect(harness.dispatched).toEqual([]);

    // Once due, the deferral clears and the flight dispatches normally.
    harness.service.deferInvocation("invocation-1", 10_000);
    const due = await harness.service.recoverQueuedFlights({ reason: "queued_retry_sweep" });
    expect(due.dispatched).toBe(1);
    expect(harness.dispatched.map((item) => item.id)).toEqual(["invocation-1"]);
  });

  test("defers dispatch jobs alongside queued flights", async () => {
    const harness = createService({
      dispatchJobs: [dispatchJob()],
      flights: {},
    });

    harness.service.deferInvocation("invocation-1", 20_000);
    const deferred = await harness.service.recoverQueuedFlights({ reason: "endpoint_online" });
    expect(deferred.dispatched).toBe(0);
    expect(harness.runJobs).toEqual([]);

    harness.service.deferInvocation("invocation-1", 9_000);
    const due = await harness.service.recoverQueuedFlights({ reason: "queued_retry_sweep" });
    expect(due.dispatched).toBe(1);
    expect(harness.runJobs.map((item) => item.job.id)).toEqual(["dispatch-invocation-1"]);
  });

  test("can drain only one target agent after an endpoint comes online", async () => {
    const invocations = {
      "invocation-agent-1": invocation({ id: "invocation-agent-1", targetAgentId: "agent-1" }),
      "invocation-agent-2": invocation({ id: "invocation-agent-2", targetAgentId: "agent-2" }),
    };
    const harness = createService({
      invocations,
      dispatchJobs: [
        dispatchJob({
          id: "dispatch-agent-1",
          invocationId: "invocation-agent-1",
          flightId: "flight-agent-1",
          targetAgentId: "agent-1",
        }),
        dispatchJob({
          id: "dispatch-agent-2",
          invocationId: "invocation-agent-2",
          flightId: "flight-agent-2",
          targetAgentId: "agent-2",
        }),
      ],
      flights: {
        "flight-agent-1": flight({
          id: "flight-agent-1",
          invocationId: "invocation-agent-1",
          targetAgentId: "agent-1",
        }),
        "flight-agent-2": flight({
          id: "flight-agent-2",
          invocationId: "invocation-agent-2",
          targetAgentId: "agent-2",
        }),
      },
    });

    const result = await harness.service.recoverQueuedFlights({
      reason: "endpoint_online",
      agentId: "agent-1",
    });

    expect(result.considered).toBe(1);
    expect(harness.runJobs.map((item) => item.invocation?.id)).toEqual(["invocation-agent-1"]);
  });

  test("recovers an expired running job only with affirmative pre-submission park evidence", async () => {
    const nextInvocation = invocation({ id: "invocation-running" });
    const harness = createService({
      invocations: { [nextInvocation.id]: nextInvocation },
      dispatchJobs: [
        dispatchJob({
          id: "dispatch-running",
          invocationId: nextInvocation.id,
          state: "running",
          leaseOwner: "broker:old",
          leaseExpiresAt: 9_000,
          updatedAt: 8_000,
        }),
      ],
      flights: {
        "flight-1": deferredFlight("no_runnable_endpoint", { invocationId: nextInvocation.id }),
      },
    });

    const result = await harness.service.recoverQueuedFlights({ reason: "startup" });

    expect(result.dispatched).toBe(1);
    expect(harness.runJobs).toEqual([
      expect.objectContaining({
        job: expect.objectContaining({ id: "dispatch-running", state: "running" }),
        invocation: nextInvocation,
      }),
    ]);
  });

  test.each(["queued", "waking", "running"] as const)("does not infer non-submission from an expired lease and a %s flight", async (state) => {
    const harness = createService({
      dispatchJobs: [dispatchJob({ state: "running", attempts: 1, leaseOwner: "broker:old", leaseExpiresAt: 9_000 })],
      flights: { "flight-1": flight({ state }) },
    });
    expect((await harness.service.recoverQueuedFlights({ reason: "startup" })).dispatched).toBe(0);
    expect(harness.runJobs).toEqual([]);
    expect(harness.requeuedJobs).toEqual([]);
    expect(harness.dispatched).toEqual([]);
  });

  test.each(["queued", "waking"] as const)("does not bypass an unexpired running job through a %s flight", async (state) => {
    const harness = createService({
      dispatchJobs: [dispatchJob({ state: "running", attempts: 1, leaseOwner: "broker:old", leaseExpiresAt: 20_000 })],
      flights: { "flight-1": flight({ state }) },
    });

    const result = await harness.service.recoverQueuedFlights({ reason: "startup" });

    expect(result.dispatched).toBe(0);
    expect(harness.runJobs).toEqual([]);
    expect(harness.requeuedJobs).toEqual([]);
    expect(harness.dispatched).toEqual([]);
  });

  test.each(["no_runnable_endpoint", "thread_held_externally"])("explicitly requeues a completed job parked for %s", async (reason) => {
    const job = dispatchJob({ state: "completed", attempts: 2, completedAt: 8_000 });
    const parked = deferredFlight(reason);
    const harness = createService({ dispatchJobs: [job], flights: { "flight-1": parked } });

    const result = await harness.service.recoverQueuedFlights({ reason: "endpoint_online" });

    expect(result.dispatched).toBe(1);
    expect(harness.requeuedJobs).toEqual([{ job, invocation: invocation(), flight: parked }]);
    expect(harness.runJobs).toEqual([]);
    expect(harness.dispatched).toEqual([]);
  });

  test.each(["queued", "waking"] as const)("requeues a completed job whose %s flight was durably never submitted", async (state) => {
    const parked = flight({ state, metadata: { dispatchOutcome: { status: "not_submitted", checkedAt: 1_000 } } });
    const job = dispatchJob({ state: "completed", attempts: 1 });
    const harness = createService({ dispatchJobs: [job], flights: { "flight-1": parked } });
    expect((await harness.service.recoverQueuedFlights({ reason: "startup" })).dispatched).toBe(1);
    expect(harness.requeuedJobs).toEqual([{ job, invocation: invocation(), flight: parked }]);
    expect(harness.dispatched).toEqual([]);
  });

  test("respects deferral cadence before requeuing a completed scheduler job", async () => {
    const harness = createService({
      dispatchJobs: [dispatchJob({ state: "completed", attempts: 1 })],
      flights: { "flight-1": deferredFlight("thread_held_externally") },
    });
    harness.service.deferInvocation("invocation-1", 20_000);
    expect((await harness.service.recoverQueuedFlights({ reason: "endpoint_online" })).dispatched).toBe(0);
    harness.service.deferInvocation("invocation-1", 10_000);
    expect((await harness.service.recoverQueuedFlights({ reason: "queued_retry_sweep" })).dispatched).toBe(1);
    expect(harness.requeuedJobs).toHaveLength(1);
    expect(harness.dispatched).toEqual([]);
  });

  test.each(["completed", "running"] as const)("does not reuse consumed park evidence for a %s job", async (state) => {
    const harness = createService({
      dispatchJobs: [dispatchJob({ state, attempts: 2, leaseExpiresAt: 9_000, lastDeferredAt: 9_000 })],
      flights: { "flight-1": deferredFlight() },
    });
    expect((await harness.service.recoverQueuedFlights({ reason: "startup" })).dispatched).toBe(0);
    expect(harness.runJobs).toEqual([]);
    expect(harness.requeuedJobs).toEqual([]);
    expect(harness.dispatched).toEqual([]);
  });

  test("accepts a new pre-submission park after an earlier deferral was consumed", async () => {
    const harness = createService({
      dispatchJobs: [dispatchJob({ state: "completed", attempts: 2, lastDeferredAt: 8_000 })],
      flights: { "flight-1": deferredFlight() },
    });
    expect((await harness.service.recoverQueuedFlights({ reason: "endpoint_online" })).dispatched).toBe(1);
    expect(harness.requeuedJobs).toHaveLength(1);
  });

  test("does not use deferral metadata older than the owning job", async () => {
    const harness = createService({
      dispatchJobs: [dispatchJob({ state: "completed", createdAt: 9_500 })],
      flights: { "flight-1": deferredFlight() },
    });
    expect((await harness.service.recoverQueuedFlights({ reason: "startup" })).dispatched).toBe(0);
    expect(harness.requeuedJobs).toEqual([]);
    expect(harness.dispatched).toEqual([]);
  });

  test.each([
    ["bare queued", flight()],
    ["bare waking", flight({ state: "waking" })],
    ["running", deferredFlight("no_runnable_endpoint", { state: "running" })],
    ["unknown submission", deferredFlight("submission_unknown")],
    ["missing check timestamp", flight({ metadata: { dispatchOutcome: { status: "queued_until_online", reason: "no_runnable_endpoint" } } })],
  ])("does not resubmit a completed job with %s evidence", async (_description, nextFlight) => {
    const harness = createService({
      dispatchJobs: [dispatchJob({ state: "completed", attempts: 1 })],
      flights: { "flight-1": nextFlight as FlightRecord },
    });
    expect((await harness.service.recoverQueuedFlights({ reason: "startup" })).dispatched).toBe(0);
    expect(harness.runJobs).toEqual([]);
    expect(harness.requeuedJobs).toEqual([]);
    expect(harness.dispatched).toEqual([]);
  });

  test.each(["failed", "cancelled"] as const)("does not reopen a %s dispatch job even when the flight has park metadata", async (state) => {
    const harness = createService({
      dispatchJobs: [dispatchJob({ state, attempts: 1 })],
      flights: { "flight-1": deferredFlight() },
    });
    expect((await harness.service.recoverQueuedFlights({ reason: "endpoint_online" })).dispatched).toBe(0);
    expect(harness.runJobs).toEqual([]);
    expect(harness.requeuedJobs).toEqual([]);
    expect(harness.dispatched).toEqual([]);
  });

  test.each(["completed", "failed", "cancelled"] as const)("does not dispatch pending or expired jobs for a %s flight", async (state) => {
    for (const jobState of ["pending", "running"] as const) {
      const harness = createService({
        dispatchJobs: [dispatchJob({ state: jobState, leaseExpiresAt: 9_000 })],
        flights: { "flight-1": flight({ state }) },
      });
      expect((await harness.service.recoverQueuedFlights({ reason: "startup" })).dispatched).toBe(0);
      expect(harness.runJobs).toEqual([]);
      expect(harness.dispatched).toEqual([]);
    }
  });

  test("exact ownership lookup prevents a bounded job enumeration from creating a legacy dispatch", async () => {
    const harness = createService({
      dispatchJobs: [],
      allDispatchJobs: [dispatchJob({ state: "running", leaseExpiresAt: 20_000 })],
      flights: { "flight-1": flight() },
    });
    expect((await harness.service.recoverQueuedFlights({ reason: "startup" })).dispatched).toBe(0);
    expect(harness.dispatched).toEqual([]);
  });

  test("rechecks legacy ownership after an earlier awaited dispatch creates its job", async () => {
    const jobs = [dispatchJob()];
    const second = invocation({ id: "invocation-2" });
    const harness = createService({
      dispatchJobs: jobs,
      invocations: { "invocation-1": invocation(), "invocation-2": second },
      flights: { "flight-1": flight(), "flight-2": flight({ id: "flight-2", invocationId: second.id }) },
      onRunJob: () => {
        jobs.push(dispatchJob({ id: "dispatch-invocation-2", invocationId: second.id, flightId: "flight-2", state: "running", leaseExpiresAt: 20_000 }));
      },
    });
    await harness.service.recoverQueuedFlights({ reason: "startup" });
    expect(harness.runJobs).toHaveLength(1);
    expect(harness.dispatched).toEqual([]);
  });

  test("rechecks a flight that becomes terminal while an earlier dispatch is awaited", async () => {
    const second = invocation({ id: "invocation-2" });
    const flights = { "flight-1": flight(), "flight-2": flight({ id: "flight-2", invocationId: second.id }) };
    const harness = createService({
      dispatchJobs: [dispatchJob(), dispatchJob({ id: "dispatch-invocation-2", invocationId: second.id, flightId: "flight-2", createdAt: 2_000 })],
      invocations: { "invocation-1": invocation(), "invocation-2": second },
      flights,
      onRunJob: () => { flights["flight-2"] = { ...flights["flight-2"], state: "cancelled" }; },
    });
    await harness.service.recoverQueuedFlights({ reason: "startup" });
    expect(harness.runJobs.map(({ job }) => job.invocationId)).toEqual(["invocation-1"]);
    expect(harness.dispatched).toEqual([]);
  });

  test("overlapping recovery passes do not concurrently requeue the same deferred job", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const harness = createService({
      dispatchJobs: [dispatchJob({ state: "completed", attempts: 1 })],
      flights: { "flight-1": deferredFlight() },
      onRequeueJob: () => blocked,
    });
    const first = harness.service.recoverQueuedFlights({ reason: "endpoint_online" });
    const second = await harness.service.recoverQueuedFlights({ reason: "queued_retry_sweep" });
    expect(second.skippedActive).toBe(1);
    expect(harness.requeuedJobs).toHaveLength(1);
    release();
    await first;
  });

  test("recovers legacy waking flights without dispatch jobs", async () => {
    const nextInvocation = invocation({ id: "invocation-waking" });
    const harness = createService({
      invocations: { [nextInvocation.id]: nextInvocation },
      flights: {
        "flight-waking": flight({
          id: "flight-waking",
          invocationId: nextInvocation.id,
          state: "waking",
        }),
      },
    });

    const result = await harness.service.recoverQueuedFlights({ reason: "startup" });

    expect(result.dispatched).toBe(1);
    expect(harness.dispatched).toEqual([nextInvocation]);
  });

  test("skips active invocations and missing invocation records", async () => {
    const harness = createService({
      invocations: {
        active: invocation({ id: "active" }),
      },
      activeInvocationIds: new Set(["active"]),
      dispatchJobs: [
        dispatchJob({
          id: "dispatch-active",
          invocationId: "active",
          flightId: "active-flight",
        }),
        dispatchJob({
          id: "dispatch-missing",
          invocationId: "missing",
          flightId: "missing-flight",
        }),
      ],
      flights: {
        active: flight({ id: "active-flight", invocationId: "active" }),
        missing: flight({ id: "missing-flight", invocationId: "missing" }),
      },
    });

    const result = await harness.service.recoverQueuedFlights({ reason: "startup" });

    expect(result).toEqual({
      considered: 2,
      dispatched: 0,
      failed: 0,
      skippedActive: 1,
      skippedMissingInvocation: 1,
    });
    expect(harness.dispatched).toEqual([]);
    expect(harness.warnings).toHaveLength(1);
  });

  describe("parks waiting for a runnable endpoint", () => {
    function waitHarness(kind: "legacy" | "job") {
      let now = 10_000;
      let key = "agent-1 v1";
      const flights = { "flight-1": deferredFlight("no_runnable_endpoint") };
      const harness = createService({
        flights,
        dispatchJobs: kind === "job" ? [dispatchJob({ state: "completed", attempts: 1 })] : [],
        endpointWakeKey: () => key,
        now: () => now,
      });
      const attempts = () => harness.dispatched.length + harness.requeuedJobs.length;
      return {
        harness, flights, attempts,
        at: (next: number) => { now = next; },
        setKey: (next: string) => { key = next; },
        pass: (reason: string) => harness.service.recoverQueuedFlights({ reason }),
      };
    }

    test.each(["legacy", "job"] as const)("a %s park is not retried while the agent's registry inputs are unchanged", async (kind) => {
      const h = waitHarness(kind);
      await h.pass("queued_retry_sweep");
      expect(h.attempts()).toBe(1);
      await h.pass("queued_retry_sweep");
      await h.pass("endpoint_online");
      expect(h.attempts()).toBe(1);
      h.at(10_000 + ENDPOINT_WAIT_INITIAL_MS - 1);
      await h.pass("queued_retry_sweep");
      expect(h.attempts()).toBe(1);
      h.at(10_000 + ENDPOINT_WAIT_INITIAL_MS);
      await h.pass("queued_retry_sweep");
      expect(h.attempts()).toBe(2);
      expect(h.harness.service.endpointWaits().get("invocation-1")?.delayMs).toBe(2 * ENDPOINT_WAIT_INITIAL_MS);
    });

    test("a change to the agent's registry inputs retries at once and resets the backoff", async () => {
      const h = waitHarness("legacy");
      await h.pass("queued_retry_sweep");
      await h.pass("queued_retry_sweep");
      expect(h.attempts()).toBe(1);
      h.setKey("agent-1 v2");
      await h.pass("endpoint_online");
      expect(h.attempts()).toBe(2);
      expect(h.harness.service.endpointWaits().get("invocation-1")?.delayMs).toBe(ENDPOINT_WAIT_INITIAL_MS);
    });

    test("startup retries every park once", async () => {
      const h = waitHarness("legacy");
      await h.pass("queued_retry_sweep");
      await h.pass("startup");
      expect(h.attempts()).toBe(2);
    });

    test("the backoff stops widening at its maximum", async () => {
      const h = waitHarness("legacy");
      let now = 10_000;
      for (let attempt = 0; attempt < 12; attempt++) {
        h.at(now);
        await h.pass("queued_retry_sweep");
        now = h.harness.service.endpointWaits().get("invocation-1")!.retryAt;
      }
      expect(h.attempts()).toBe(12);
      expect(h.harness.service.endpointWaits().get("invocation-1")?.delayMs).toBe(ENDPOINT_WAIT_MAX_MS);
    });

    test("a wait is dropped once the flight leaves the park", async () => {
      const h = waitHarness("legacy");
      await h.pass("queued_retry_sweep");
      expect(h.harness.service.endpointWaits().size).toBe(1);
      h.flights["flight-1"] = flight({ state: "running" });
      await h.pass("queued_retry_sweep");
      expect(h.harness.service.endpointWaits().size).toBe(0);
    });

    test("a park for a held thread keeps its own retry cadence", async () => {
      const h = waitHarness("legacy");
      h.flights["flight-1"] = deferredFlight("thread_held_externally");
      await h.pass("queued_retry_sweep");
      await h.pass("queued_retry_sweep");
      expect(h.attempts()).toBe(2);
      expect(h.harness.service.endpointWaits().size).toBe(0);
    });
  });
});
