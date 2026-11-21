import { describe, expect, test } from "bun:test";

import {
  type ActorIdentity,
  type AgentDefinition,
  type AgentEndpoint,
  type FlightRecord,
  type InvocationRequest,
  type NodeDefinition,
  type ScoutDispatchEnvelope,
  type ScoutDispatchRecord,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";
import { createInvocationDispatchJob, type BrokerInvocationDispatchJob } from "./broker-dispatch-job.js";
import {
  BrokerInvocationDispatchService,
  type BrokerInvocationDispatchServiceDeps,
} from "./broker-invocation-dispatch-service.js";
import type { InvocationResolution } from "./broker-delivery-routing.js";

function agent(input: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "agent-1",
    kind: "agent",
    definitionId: "agent-1",
    displayName: "Agent One",
    handle: "agent-one",
    selector: "@agent-one",
    defaultSelector: "@agent-one",
    labels: [],
    metadata: {},
    agentClass: "general",
    capabilities: ["chat", "invoke"],
    wakePolicy: "manual",
    homeNodeId: "node-local",
    authorityNodeId: "node-local",
    advertiseScope: "local",
    ...input,
  };
}

function actor(input: Partial<ActorIdentity> = {}): ActorIdentity {
  return {
    id: "agent-1",
    kind: "agent",
    displayName: "Agent One",
    handle: "agent-one",
    metadata: {},
    ...input,
  };
}

function node(input: Partial<NodeDefinition> = {}): NodeDefinition {
  return {
    id: "node-peer",
    meshId: "mesh-1",
    name: "Peer",
    advertiseScope: "mesh",
    registeredAt: 100,
    ...input,
  };
}

function invocation(input: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    id: "invocation-1",
    requesterId: "operator",
    requesterNodeId: "node-local",
    targetAgentId: "agent-1",
    action: "consult",
    task: "work",
    ensureAwake: true,
    stream: false,
    conversationId: "conversation-1",
    messageId: "msg-parent",
    createdAt: 100,
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
    startedAt: 110,
    metadata: { dispatch: "ok" },
    ...input,
  };
}

function dispatchRecord(input: Partial<ScoutDispatchRecord> = {}): ScoutDispatchRecord {
  return {
    id: "dispatch-1",
    kind: "unknown",
    askedLabel: "@missing",
    detail: "No agent matched @missing",
    candidates: [],
    dispatchedAt: 120,
    dispatcherNodeId: "node-local",
    ...input,
  };
}

function createHarness(input: {
  actors?: Record<string, ActorIdentity>;
  agents?: Record<string, AgentDefinition>;
  nodes?: Record<string, NodeDefinition>;
  endpoints?: Record<string, AgentEndpoint>;
  flights?: Record<string, FlightRecord>;
  invocations?: Record<string, InvocationRequest>;
  jobs?: Record<string, BrokerInvocationDispatchJob>;
  enqueuePeerInvocation?: BrokerInvocationDispatchServiceDeps["enqueuePeerInvocation"];
  resolution?: InvocationResolution;
  describeRemoteAuthorityIssue?: BrokerInvocationDispatchServiceDeps["describeRemoteAuthorityIssue"];
  describeUnavailableInvocationTarget?: BrokerInvocationDispatchServiceDeps["describeUnavailableInvocationTarget"];
} = {}) {
  const agents = input.agents ?? { "agent-1": agent() };
  const actors = input.actors ?? Object.fromEntries(
    Object.values(agents).map((nextAgent) => [nextAgent.id, actor(nextAgent)]),
  );
  const nodes = input.nodes ?? {};
  const endpoints = input.endpoints ?? {};
  const flights = input.flights ?? {};
  const invocations = input.invocations ?? {};
  const jobs = input.jobs ?? {};
  const recordInvocationCalls: Array<{
    invocation: InvocationRequest;
    options?: {
      createDispatchJob?: (flight: FlightRecord) => BrokerInvocationDispatchJob;
      enqueueProjection?: boolean;
    };
  }> = [];
  const appliedEntries: BrokerJournalEntry[][] = [];
  const recordedDispatchJobs: BrokerInvocationDispatchJob[] = [];
  const recordedFlights: FlightRecord[] = [];
  const statusMessages: Array<{ invocation: InvocationRequest; flight: Partial<FlightRecord> }> = [];
  const launched: Array<{ invocation: InvocationRequest }> = [];
  const peerEnqueues: Array<{ invocation: InvocationRequest; authorityNode: NodeDefinition }> = [];
  const dispatches: Array<{
    envelope: ScoutDispatchEnvelope;
    options?: { invocationId?: string; conversationId?: string; requesterId?: string };
  }> = [];
  const syncReasons: string[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const errors: Array<{ message: string; detail: unknown }> = [];

  const service = new BrokerInvocationDispatchService({
    nodeId: "node-local",
    runtime: {
      snapshot: () => ({
        nodes,
        actors,
        agents,
        endpoints,
        conversations: {},
        bindings: {},
        messages: {},
        readCursors: {},
        invocations,
        flights,
        collaborationRecords: {},
      }),
      actor: (actorId) => actors[actorId],
      agent: (agentId) => agents[agentId],
      node: (nodeId) => nodes[nodeId],
      flightForInvocation: (invocationId) => flights[invocationId],
    },
    createId: (prefix) => `${prefix}-1`,
    async syncRegisteredLocalAgentsIfChanged(reason) {
      syncReasons.push(reason);
    },
    async resolveInvocationTarget() {
      return input.resolution ?? { kind: "resolved", agent: agents["agent-1"]! };
    },
    async recordScoutDispatch(envelope, options) {
      dispatches.push({ envelope, options });
      return {
        record: dispatchRecord({
          ...envelope,
          invocationId: options?.invocationId,
          conversationId: options?.conversationId,
          requesterId: options?.requesterId,
        }),
      };
    },
    async recordInvocation(nextInvocation, options) {
      recordInvocationCalls.push({ invocation: nextInvocation, options });
      invocations[nextInvocation.id] = nextInvocation;
      const nextFlight = flight({
        invocationId: nextInvocation.id,
        requesterId: nextInvocation.requesterId,
        targetAgentId: nextInvocation.targetAgentId,
      });
      const dispatchJob = options?.createDispatchJob?.(nextFlight);
      if (dispatchJob) jobs[dispatchJob.id] = dispatchJob;
      flights[nextInvocation.id] = nextFlight;
      const entries: BrokerJournalEntry[] = [
        { kind: "invocation.record", invocation: nextInvocation },
        ...(dispatchJob ? [{ kind: "invocation.dispatch_job.record" as const, job: dispatchJob }] : []),
      ];
      return {
        flight: nextFlight,
        dispatchJob,
        entries,
      };
    },
    async recordInvocationDispatchJob(job) {
      jobs[job.id] = job;
      recordedDispatchJobs.push(job);
      return [{ kind: "invocation.dispatch_job.record", job }];
    },
    async recordInvocationDispatchJobIf(job, eligible) {
      if (!eligible(jobs[job.id] ?? null)) return null;
      jobs[job.id] = job;
      recordedDispatchJobs.push(job);
      return [{ kind: "invocation.dispatch_job.record", job }];
    },
    async applyProjectedEntries(entries) {
      appliedEntries.push(entries);
    },
    async recordFlight(nextFlight) {
      recordedFlights.push(nextFlight);
      flights[nextFlight.invocationId] = nextFlight;
    },
    async postInvocationStatusMessage(nextInvocation, nextFlight) {
      statusMessages.push({ invocation: nextInvocation, flight: nextFlight });
    },
    describeRemoteAuthorityIssue: input.describeRemoteAuthorityIssue ?? (() => null),
    describeUnavailableInvocationTarget: input.describeUnavailableInvocationTarget,
    buildUnavailableDispatchEnvelope: (askedLabel, unavailable) => ({
      kind: "unavailable",
      askedLabel,
      detail: unavailable.detail,
      candidates: [],
      target: unavailable,
      dispatchedAt: 200,
      dispatcherNodeId: "node-local",
    }),
    async enqueuePeerInvocation(nextInvocation, authorityNode) {
      peerEnqueues.push({ invocation: nextInvocation, authorityNode });
      await input.enqueuePeerInvocation?.(nextInvocation, authorityNode);
    },
    launchLocalInvocation(nextInvocation) {
      launched.push({ invocation: nextInvocation });
    },
    log: (message) => logs.push(message),
    warn: (message) => warnings.push(message),
    error: (message, detail) => errors.push({ message, detail }),
    now: () => 200,
  });

  return {
    appliedEntries,
    dispatches,
    errors,
    flights,
    jobs,
    launched,
    logs,
    peerEnqueues,
    recordedDispatchJobs,
    recordInvocationCalls,
    recordedFlights,
    service,
    statusMessages,
    syncReasons,
    warnings,
  };
}

describe("BrokerInvocationDispatchService", () => {
  test("terminal flights never submit locally or remotely, even if their target disappeared", async () => {
    for (const state of ["completed", "cancelled", "failed"] as const) {
      for (const authority of ["node-local", "node-peer", "missing"]) {
        const target = agent({ authorityNodeId: authority });
        const request = invocation();
        const terminal = flight({ state, output: "preserved result", completedAt: 150 });
        const harness = createHarness({
          agents: authority === "missing" ? {} : { [target.id]: target },
          nodes: { "node-peer": node() }, flights: { [request.id]: terminal },
        });
        await harness.service.dispatchAcceptedInvocation(request);
        expect(harness.launched).toHaveLength(0);
        expect(harness.peerEnqueues).toHaveLength(0);
        expect(harness.recordedFlights).toHaveLength(0);
        expect(harness.flights[request.id]).toEqual(terminal);
      }
    }
  });

  test("concurrent and stale dispatch job claims submit only once", async () => {
    const request = invocation();
    const initialFlight = flight();
    const job = createInvocationDispatchJob(request, initialFlight, 100);
    const harness = createHarness({
      flights: { [request.id]: initialFlight }, invocations: { [request.id]: request },
      jobs: { [job.id]: job },
    });
    await Promise.all([harness.service.runDispatchJob(job), harness.service.runDispatchJob(job)]);
    await harness.service.runDispatchJob(job);
    expect(harness.launched).toHaveLength(1);
    expect(harness.jobs[job.id]?.attempts).toBe(1);
    expect(harness.jobs[job.id]?.state).toBe("completed");
  });

  test("an expired running lease does not authorize replay of an unknown submission", async () => {
    const request = invocation();
    const initialFlight = flight();
    const job: BrokerInvocationDispatchJob = {
      ...createInvocationDispatchJob(request, initialFlight, 100),
      state: "running", attempts: 1, leaseExpiresAt: 150, leaseOwner: "old-broker",
    };
    const harness = createHarness({
      flights: { [request.id]: initialFlight }, invocations: { [request.id]: request },
      jobs: { [job.id]: job },
    });
    await harness.service.runDispatchJob(job);
    expect(harness.launched).toHaveLength(0);
    expect(harness.jobs[job.id]).toEqual(job);
  });

  test("stale job completion cannot overwrite a newer ownership generation", async () => {
    const request = invocation();
    const initialFlight = flight();
    const job = createInvocationDispatchJob(request, initialFlight, 100);
    const jobs = { [job.id]: job };
    const harness = createHarness({
      agents: { "agent-1": agent({ authorityNodeId: "node-peer" }) },
      nodes: { "node-peer": node() }, jobs,
      flights: { [request.id]: initialFlight }, invocations: { [request.id]: request },
      enqueuePeerInvocation: async () => {
        jobs[job.id] = { ...jobs[job.id]!, attempts: 2, updatedAt: 250, leaseOwner: "new-broker" };
      },
    });
    await harness.service.runDispatchJob(job);
    expect(harness.peerEnqueues).toHaveLength(1);
    expect(jobs[job.id]?.state).toBe("running");
    expect(jobs[job.id]?.attempts).toBe(2);
    expect(jobs[job.id]?.leaseOwner).toBe("new-broker");
  });

  test("replays a stable invocation id without launching the worker twice", async () => {
    const harness = createHarness();
    const request = invocation({ id: "inv-client-stable" });

    const first = await harness.service.handleInvocationRequest(request);
    const retry = await harness.service.handleInvocationRequest({
      ...request,
      createdAt: request.createdAt + 5_000,
    });
    await Bun.sleep(0);

    expect(retry).toEqual(first);
    expect(harness.recordInvocationCalls).toHaveLength(1);
    expect(harness.launched).toHaveLength(1);
  });

  test("rejects reuse of an invocation id for a different task", async () => {
    const harness = createHarness();
    const request = invocation({ id: "inv-client-stable" });
    await harness.service.handleInvocationRequest(request);

    await expect(harness.service.handleInvocationRequest({
      ...request,
      task: "different work",
    })).rejects.toThrow("already assigned to a different record");
  });

  test("rejects reuse of an invocation id with different execution", async () => {
    const harness = createHarness();
    const request = invocation({
      id: "inv-client-stable",
      execution: { model: "gpt-5.6-sol" },
    });
    await harness.service.handleInvocationRequest(request);

    await expect(harness.service.handleInvocationRequest({
      ...request,
      execution: { model: "grok-4.20-beta" },
    })).rejects.toThrow("already assigned to a different record");
  });

  test("resolves invocation requests, records flights, applies projections, and launches locally", async () => {
    const resolvedAgent = agent({ id: "agent-resolved", displayName: "Resolved Agent" });
    const harness = createHarness({
      agents: { [resolvedAgent.id]: resolvedAgent },
      resolution: { kind: "resolved", agent: resolvedAgent },
    });

    const result = await harness.service.handleInvocationRequest(invocation({
      id: "invocation-resolved",
      targetAgentId: "placeholder",
      targetLabel: "@resolved",
    }));
    await Bun.sleep(0);

    expect(result).toEqual(expect.objectContaining({
      accepted: true,
      invocationId: "invocation-resolved",
      flightId: "flight-1",
      targetAgentId: "agent-resolved",
      state: "queued",
    }));
    expect(harness.syncReasons).toEqual(["invocation"]);
    expect(harness.recordInvocationCalls).toEqual([
      expect.objectContaining({
        invocation: expect.objectContaining({
          id: "invocation-resolved",
          targetAgentId: "agent-resolved",
        }),
        options: expect.objectContaining({
          createDispatchJob: expect.any(Function),
          enqueueProjection: false,
        }),
      }),
    ]);
    expect(harness.appliedEntries[0]).toEqual(
      [
        expect.objectContaining({ kind: "invocation.record" }),
        expect.objectContaining({ kind: "invocation.dispatch_job.record" }),
      ],
    );
    expect(harness.launched).toEqual([
      expect.objectContaining({
        invocation: expect.objectContaining({ targetAgentId: "agent-resolved" }),
      }),
    ]);
  });

  test("launches resolved session actors without requiring an agent card", async () => {
    const sessionActor = actor({
      id: "session-cardless-1",
      kind: "session",
      displayName: "openscout:session",
      metadata: { cardless: true },
    });
    const harness = createHarness({
      actors: { [sessionActor.id]: sessionActor },
      agents: {},
      resolution: {
        kind: "resolved_session",
        session: {
          sessionId: sessionActor.id,
          actorId: sessionActor.id,
          label: "openscout:session",
          nodeId: "node-local",
          endpoint: {
            id: "endpoint-cardless",
            agentId: sessionActor.id,
            nodeId: "node-local",
            harness: "claude",
            transport: "claude_stream_json",
            state: "idle",
            sessionId: sessionActor.id,
            metadata: { cardless: true, sessionBacked: true },
          },
        },
      },
    });

    const payload = {
      ...invocation({
        id: "invocation-cardless",
        targetAgentId: "placeholder",
      }),
      target: { kind: "session_id" as const, sessionId: sessionActor.id },
    };

    const result = await harness.service.handleInvocationRequest(payload);
    await Bun.sleep(0);

    expect(result).toEqual(expect.objectContaining({
      accepted: true,
      invocationId: "invocation-cardless",
      targetAgentId: sessionActor.id,
      state: "queued",
    }));
    expect(harness.recordInvocationCalls[0]?.invocation).toEqual(expect.objectContaining({
      id: "invocation-cardless",
      targetAgentId: sessionActor.id,
    }));
    expect(harness.launched).toEqual([
      expect.objectContaining({
        invocation: expect.objectContaining({ targetAgentId: sessionActor.id }),
      }),
    ]);
  });

  test("records scout dispatches for unresolved invocation requests", async () => {
    const harness = createHarness({
      resolution: { kind: "unknown", label: "@missing" },
    });

    const result = await harness.service.handleInvocationRequest(invocation({
      id: "invocation-missing",
      targetLabel: "@missing",
    }));

    expect(result).toEqual(expect.objectContaining({
      accepted: true,
      invocationId: "invocation-missing",
      dispatch: expect.objectContaining({
        id: "dispatch-1",
        kind: "unknown",
        askedLabel: "@missing",
        invocationId: "invocation-missing",
        conversationId: "conversation-1",
        requesterId: "operator",
      }),
    }));
    expect(harness.recordInvocationCalls).toEqual([]);
    expect(harness.dispatches).toEqual([
      expect.objectContaining({
        envelope: expect.objectContaining({
          kind: "unknown",
          askedLabel: "@missing",
          dispatcherNodeId: "node-local",
        }),
        options: {
          invocationId: "invocation-missing",
          conversationId: "conversation-1",
          requesterId: "operator",
        },
      }),
    ]);
  });

  test("records scout dispatches for unavailable resolved invocation targets", async () => {
    const resolvedAgent = agent({ id: "agent-manual", displayName: "Manual Agent" });
    const harness = createHarness({
      agents: { [resolvedAgent.id]: resolvedAgent },
      resolution: { kind: "resolved", agent: resolvedAgent },
      describeUnavailableInvocationTarget: () => ({
        agentId: resolvedAgent.id,
        displayName: resolvedAgent.displayName,
        reason: "manual_wake_required",
        detail: "manual wake required",
        wakePolicy: "manual",
        endpointState: "offline",
        transport: null,
        projectRoot: null,
      }),
    });

    const result = await harness.service.handleInvocationRequest(invocation({
      id: "invocation-unavailable-target",
      targetAgentId: "placeholder",
      targetLabel: "@manual",
    }));

    expect(result).toEqual(expect.objectContaining({
      accepted: true,
      invocationId: "invocation-unavailable-target",
      dispatch: expect.objectContaining({
        kind: "unavailable",
        askedLabel: "@manual",
        detail: "manual wake required",
      }),
    }));
    expect(harness.recordInvocationCalls).toEqual([]);
    expect(harness.launched).toEqual([]);
  });

  test("dispatches remote-authority invocations to the peer outbox", async () => {
    const remoteAgent = agent({
      id: "agent-remote",
      authorityNodeId: "node-peer",
      homeNodeId: "node-peer",
      advertiseScope: "mesh",
    });
    const authorityNode = node();
    const nextInvocation = invocation({
      id: "invocation-remote",
      targetAgentId: remoteAgent.id,
    });
    const harness = createHarness({
      agents: { [remoteAgent.id]: remoteAgent },
      nodes: { [authorityNode.id]: authorityNode },
      flights: {
        [nextInvocation.id]: flight({
          invocationId: nextInvocation.id,
          targetAgentId: remoteAgent.id,
        }),
      },
    });

    await harness.service.dispatchAcceptedInvocation(nextInvocation);

    expect(harness.peerEnqueues).toEqual([
      { invocation: nextInvocation, authorityNode },
    ]);
    expect(harness.launched).toEqual([]);
    expect(harness.recordedFlights).toEqual([]);
  });

  test("forwards cardless session invocations whose endpoint lives on another node", async () => {
    const sessionActorId = "flat-claude-4fad8bb9";
    const ownerNode = node({ id: "node-peer", brokerUrl: "http://peer.example:43110" });
    const nextInvocation = invocation({
      id: "invocation-cross-node",
      targetAgentId: sessionActorId,
    });
    const harness = createHarness({
      agents: {},
      actors: { [sessionActorId]: actor({ id: sessionActorId, kind: "session" }) },
      nodes: { [ownerNode.id]: ownerNode },
      endpoints: {
        "endpoint-remote": {
          id: "endpoint-remote",
          agentId: sessionActorId,
          nodeId: "node-peer",
          harness: "claude",
          transport: "claude_stream_json",
          state: "idle",
          sessionId: sessionActorId,
          metadata: { cardless: true },
        } as AgentEndpoint,
      },
      flights: {
        [nextInvocation.id]: flight({
          invocationId: nextInvocation.id,
          targetAgentId: sessionActorId,
        }),
      },
    });

    await harness.service.dispatchAcceptedInvocation(nextInvocation);

    expect(harness.peerEnqueues).toEqual([
      { invocation: nextInvocation, authorityNode: ownerNode },
    ]);
    expect(harness.launched).toEqual([]);
    expect(harness.recordedFlights).toEqual([]);
  });

  test("fails cardless session invocations when the endpoint's node is unreachable", async () => {
    const sessionActorId = "flat-claude-4fad8bb9";
    const nextInvocation = invocation({
      id: "invocation-cross-node-dark",
      targetAgentId: sessionActorId,
    });
    const harness = createHarness({
      agents: {},
      actors: { [sessionActorId]: actor({ id: sessionActorId, kind: "session" }) },
      nodes: { "node-peer": node({ id: "node-peer", brokerUrl: undefined }) },
      endpoints: {
        "endpoint-remote": {
          id: "endpoint-remote",
          agentId: sessionActorId,
          nodeId: "node-peer",
          harness: "claude",
          transport: "claude_stream_json",
          state: "idle",
          sessionId: sessionActorId,
          metadata: { cardless: true },
        } as AgentEndpoint,
      },
      flights: {
        [nextInvocation.id]: flight({
          invocationId: nextInvocation.id,
          targetAgentId: sessionActorId,
        }),
      },
    });

    await harness.service.dispatchAcceptedInvocation(nextInvocation);

    expect(harness.peerEnqueues).toEqual([]);
    expect(harness.launched).toEqual([]);
    expect(harness.recordedFlights).toEqual([
      expect.objectContaining({
        state: "failed",
        error: `session endpoint for ${sessionActorId} lives on node-peer, which has no reachable broker URL`,
      }),
    ]);
  });

  test("fails remote-authority invocations with unavailable authority details", async () => {
    const remoteAgent = agent({
      id: "agent-remote",
      authorityNodeId: "node-peer",
      homeNodeId: "node-peer",
      advertiseScope: "mesh",
    });
    const nextInvocation = invocation({
      id: "invocation-unavailable",
      targetAgentId: remoteAgent.id,
      metadata: { source: "test" },
    });
    const existingFlight = flight({
      id: "flight-existing",
      invocationId: nextInvocation.id,
      targetAgentId: remoteAgent.id,
      startedAt: 150,
      state: "running",
    });
    const harness = createHarness({
      agents: { [remoteAgent.id]: remoteAgent },
      flights: { [nextInvocation.id]: existingFlight },
      describeRemoteAuthorityIssue: () => ({
        agentId: remoteAgent.id,
        displayName: remoteAgent.displayName,
        reason: "unknown",
        detail: "authority unavailable",
        endpointState: "offline",
      }),
    });

    await harness.service.dispatchAcceptedInvocation(nextInvocation);

    expect(harness.recordedFlights).toEqual([
      expect.objectContaining({
        id: "flight-existing",
        invocationId: "invocation-unavailable",
        requesterId: "operator",
        targetAgentId: "agent-remote",
        state: "failed",
        startedAt: 150,
        completedAt: 200,
        summary: "authority unavailable",
        error: "authority unavailable",
        metadata: { source: "test", failureCause: "endpoint_lost" },
      }),
    ]);
    expect(harness.statusMessages).toEqual([
      expect.objectContaining({
        invocation: nextInvocation,
        flight: expect.objectContaining({
          state: "failed",
          error: "authority unavailable",
        }),
      }),
    ]);
    expect(harness.peerEnqueues).toEqual([]);
  });

  test("acceptAndDispatch can preserve command-style response fields and logging", async () => {
    const harness = createHarness();

    const result = await harness.service.acceptAndDispatch(invocation(), {
      includeOk: true,
      logAccepted: true,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      accepted: true,
      invocationId: "invocation-1",
      flightId: "flight-1",
      targetAgentId: "agent-1",
      state: "queued",
    }));
    expect(harness.logs).toEqual([
      "[openscout-runtime] invocation invocation-1 accepted for agent-1 (state=queued)",
    ]);
  });
});
