import { describe, expect, test } from "bun:test";

import type {
  AgentDefinition,
  AgentEndpoint,
  FlightRecord,
  InvocationRequest,
} from "@openscout/protocol";

import { createInMemoryControlRuntime } from "./broker.js";
import {
  applyInvocationStatusPatch,
  compareLocalEndpointPreference,
  dispatchAckStrategyForEndpoint,
  endpointForFlight,
  endpointMatchesTargetSession,
  endpointSessionAliasValues,
  flightDispatchEndpointId,
  flightDispatchEndpointUnavailableReason,
  flightTimestamp,
  homeEndpointForAgent,
  invocationTargetSessionId,
  invocationReplyMode,
  isInactiveLocalAgent,
  isReconciledStaleFlightActivityItem,
  isTerminalFlightState,
  isWorkingFlightState,
  latestEndpointForAgent,
  localEndpointPreferenceRank,
  STALE_WORKING_FLIGHT_NO_ENDPOINT_GRACE_MS,
  staleLocalAgentReason,
  staleLocalEndpointReason,
  staleWorkingFlightReason,
  shouldNotifyInvocationRequester,
} from "./broker-local-invocation-helpers.js";
import { runtimeSessionHandleForEndpoint } from "./runtime-session-handle.js";

function testAgent(input: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "agent-1",
    kind: "agent",
    definitionId: "agent-1",
    displayName: "Agent One",
    handle: "agent-one",
    labels: ["agent"],
    metadata: {},
    selector: "@agent-one",
    defaultSelector: "@agent-one",
    agentClass: "general",
    capabilities: ["chat", "invoke", "deliver"],
    wakePolicy: "on_demand",
    homeNodeId: "node-1",
    authorityNodeId: "node-1",
    advertiseScope: "local",
    ...input,
  };
}

function testEndpoint(input: Partial<AgentEndpoint> = {}): AgentEndpoint {
  return {
    id: "endpoint-1",
    agentId: "agent-1",
    nodeId: "node-1",
    harness: "codex",
    transport: "codex_app_server",
    state: "idle",
    sessionId: "session-1",
    metadata: {},
    ...input,
  };
}

function testInvocation(input: Partial<InvocationRequest> = {}): InvocationRequest {
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

function testFlight(input: Partial<FlightRecord> = {}): FlightRecord {
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

describe("invocation reply mode", () => {
  test("notifies only explicit notify and legacy invocations", () => {
    expect(invocationReplyMode(testInvocation({ metadata: { replyMode: "inline" } }))).toBe("inline");
    expect(shouldNotifyInvocationRequester(testInvocation({ metadata: { replyMode: "inline" } }))).toBe(false);
    expect(shouldNotifyInvocationRequester(testInvocation({ metadata: { replyMode: "none" } }))).toBe(false);
    expect(shouldNotifyInvocationRequester(testInvocation({ metadata: { replyMode: "notify" } }))).toBe(true);
    expect(shouldNotifyInvocationRequester(testInvocation({ metadata: {} }))).toBe(true);
    expect(shouldNotifyInvocationRequester(testInvocation({ metadata: { replyMode: "future-mode" } }))).toBe(true);
  });
});

describe("applyInvocationStatusPatch", () => {
  test("patches status fields and preserves flight identity", () => {
    const current = testFlight({
      state: "running",
      summary: "working",
      startedAt: 1_000,
      labels: ["release:1"],
    });

    const next = applyInvocationStatusPatch(current, {
      state: "completed",
      summary: "done",
      output: "the answer",
      completedAt: 2_000,
    });

    expect(next).toEqual({
      ...current,
      state: "completed",
      summary: "done",
      output: "the answer",
      completedAt: 2_000,
    });
    expect(next.id).toBe("flight-1");
    expect(next.invocationId).toBe("invocation-1");
    expect(next.labels).toEqual(["release:1"]);
  });

  test("keys explicitly set to undefined clear the current value", () => {
    const current = testFlight({
      state: "queued",
      error: "boom",
      completedAt: 2_000,
    });

    const next = applyInvocationStatusPatch(current, {
      state: "running",
      error: undefined,
      completedAt: undefined,
    });

    expect(next.state).toBe("running");
    expect(next.error).toBeUndefined();
    expect(next.completedAt).toBeUndefined();
  });

  test("terminal truth cannot be reopened or replaced by stale status patches", () => {
    for (const state of ["completed", "failed", "cancelled"] as const) {
      const current = testFlight({ state, output: "retained result", completedAt: 2_000 });
      for (const nextState of ["queued", "running", "completed", "failed", "cancelled"] as const) {
        if (nextState === state) continue;
        expect(applyInvocationStatusPatch(current, {
          state: nextState,
          summary: "stale reconciliation",
          output: undefined,
          completedAt: 3_000,
        })).toBe(current);
      }
    }
  });

  test("omitted keys keep the current value", () => {
    const current = testFlight({
      state: "running",
      summary: "working",
      output: "partial",
      startedAt: 1_500,
    });

    const next = applyInvocationStatusPatch(current, { summary: "still working" });

    expect(next.state).toBe("running");
    expect(next.output).toBe("partial");
    expect(next.startedAt).toBe(1_500);
  });

  test("metadata merges key-wise instead of replacing", () => {
    const current = testFlight({
      metadata: { dispatchAck: { strategy: "spawn" }, attempt: 1 },
    });

    const next = applyInvocationStatusPatch(current, {
      state: "failed",
      metadata: { failureStage: "empty_reply", attempt: 2 },
    });

    expect(next.metadata).toEqual({
      dispatchAck: { strategy: "spawn" },
      failureStage: "empty_reply",
      attempt: 2,
    });
  });

  test("a patch without metadata leaves current metadata untouched", () => {
    const current = testFlight({ metadata: { dispatchAck: { strategy: "attach" } } });

    const next = applyInvocationStatusPatch(current, { state: "completed" });

    expect(next.metadata).toEqual({ dispatchAck: { strategy: "attach" } });
  });

  test("dispatch patches retain the concrete session history", () => {
    const first = applyInvocationStatusPatch(testFlight(), {
      state: "running",
      metadata: {
        dispatchAck: {
          sessionId: "session-1",
          endpointId: "endpoint-1",
          strategy: "spawn",
          acknowledgedAt: 100,
        },
      },
    });
    const second = applyInvocationStatusPatch(first, {
      state: "running",
      metadata: {
        dispatchAck: {
          sessionId: "session-2",
          endpointId: "endpoint-2",
          strategy: "wake",
          acknowledgedAt: 200,
        },
        attempt: 2,
      },
    });

    expect(second.metadata?.sessionTrace).toEqual([
      expect.objectContaining({ sessionId: "session-1", endedAt: 200 }),
      expect.objectContaining({ sessionId: "session-2", startedAt: 200 }),
    ]);
    expect(second.metadata?.attempt).toBe(2);
  });
});

describe("broker local invocation helpers", () => {
  test("classifies flight states and timestamps", () => {
    expect(isWorkingFlightState("queued")).toBe(true);
    expect(isWorkingFlightState("running")).toBe(true);
    expect(isWorkingFlightState("completed")).toBe(false);
    expect(isTerminalFlightState("completed")).toBe(true);
    expect(isTerminalFlightState("waiting")).toBe(false);
    expect(flightTimestamp(testFlight({ completedAt: 2_000 }))).toBe(2_000);
    expect(flightTimestamp(testFlight({ startedAt: 1_500 }))).toBe(1_500);
  });

  test("matches endpoint session aliases from direct fields and metadata", () => {
    const endpoint = testEndpoint({
      id: "endpoint-codex",
      sessionId: "session-direct",
      metadata: {
        externalSessionId: "external-1",
        threadId: "thread-1",
        runtimeSessionId: "runtime-1",
        runtimeInstanceId: "instance-1",
        tmuxSession: "tmux-1",
        pairingSessionId: "pairing-1",
      },
    });

    const handle = runtimeSessionHandleForEndpoint(endpoint);
    expect(handle).toMatch(/^sess\.[a-f0-9]{20}$/);
    expect(endpointSessionAliasValues(endpoint)).toEqual([
      handle,
      "endpoint-codex",
      "session-direct",
      "external-1",
      "thread-1",
      "runtime-1",
      "instance-1",
      "tmux-1",
      "pairing-1",
    ]);
    expect(endpointMatchesTargetSession(endpoint, "thread-1")).toBe(true);
    expect(endpointMatchesTargetSession(endpoint, " missing ")).toBe(false);
    expect(endpointMatchesTargetSession(endpoint, "   ")).toBe(false);
  });

  test("ranks local endpoints by transport and recency", () => {
    const tmux = testEndpoint({ id: "tmux", transport: "tmux" });
    const codexOld = testEndpoint({
      id: "codex-old",
      transport: "codex_app_server",
      metadata: { lastStartedAt: 1_000 },
    });
    const codexNew = testEndpoint({
      id: "codex-new",
      transport: "codex_app_server",
      metadata: { lastStartedAt: 2_000 },
    });
    const claude = testEndpoint({ id: "claude", transport: "claude_stream_json" });

    expect(localEndpointPreferenceRank(tmux)).toBeLessThan(localEndpointPreferenceRank(codexOld));
    expect(localEndpointPreferenceRank(claude)).toBeGreaterThan(localEndpointPreferenceRank(codexOld));
    expect([claude, codexOld, codexNew, tmux].sort(compareLocalEndpointPreference).map((endpoint) => endpoint.id))
      .toEqual(["tmux", "codex-new", "codex-old", "claude"]);
  });

  test("selects home and latest endpoints while excluding stale registrations", () => {
    const runtime = createInMemoryControlRuntime({
      agents: {
        "agent-1": testAgent(),
        stale: testAgent({ id: "stale", metadata: { staleLocalRegistration: true } }),
      },
      endpoints: {
        active: testEndpoint({ id: "active", state: "active", metadata: { lastStartedAt: 5_000 } }),
        idle: testEndpoint({ id: "idle", state: "idle", metadata: { lastStartedAt: 10_000 } }),
        stale: testEndpoint({
          id: "stale",
          agentId: "agent-1",
          state: "active",
          metadata: { staleLocalRegistration: true, replacedByAgentId: "agent-2", lastStartedAt: 20_000 },
        }),
        "stale-agent-endpoint": testEndpoint({ id: "stale-agent-endpoint", agentId: "stale" }),
      },
    }, { localNodeId: "node-1" });
    const snapshot = runtime.snapshot();

    expect(homeEndpointForAgent(snapshot, "agent-1")?.id).toBe("active");
    expect(latestEndpointForAgent(snapshot, "agent-1")?.id).toBe("stale");
    expect(isInactiveLocalAgent(snapshot.agents.stale)).toBe(true);
    expect(staleLocalEndpointReason(snapshot.endpoints.stale)).toBe(
      "endpoint stale is a superseded local registration replaced by current setup; replacement agent is agent-2",
    );
    expect(staleLocalAgentReason(snapshot, snapshot.agents.stale!)).toBe(
      "agent stale is a superseded local registration replaced by current setup",
    );
  });

  test("resolves dispatched endpoint ids and unavailable endpoint reasons for flights", () => {
    const runtime = createInMemoryControlRuntime({
      endpoints: {
        "endpoint-agent-1": testEndpoint({ id: "endpoint-agent-1", agentId: "agent-1" }),
        "endpoint-other": testEndpoint({ id: "endpoint-other", agentId: "other-agent" }),
      },
    }, { localNodeId: "node-1" });
    const snapshot = runtime.snapshot();
    const dispatched = testFlight({
      metadata: { dispatchAck: { endpointId: " endpoint-agent-1 " } },
    });
    const wrongOwner = testFlight({
      metadata: { dispatchAck: { endpointId: "endpoint-other" } },
    });
    const missing = testFlight({
      metadata: { dispatchAck: { endpointId: "missing-endpoint" } },
    });

    expect(flightDispatchEndpointId(dispatched)).toBe("endpoint-agent-1");
    expect(endpointForFlight(snapshot, dispatched)?.id).toBe("endpoint-agent-1");
    expect(flightDispatchEndpointUnavailableReason(snapshot, dispatched)).toBeNull();
    expect(endpointForFlight(snapshot, wrongOwner)).toBeNull();
    expect(flightDispatchEndpointUnavailableReason(snapshot, wrongOwner))
      .toBe("dispatched endpoint endpoint-other no longer belongs to target agent agent-1");
    expect(flightDispatchEndpointUnavailableReason(snapshot, missing))
      .toBe("dispatched endpoint missing-endpoint is no longer registered");
  });

  test("derives invocation target sessions and dispatch acknowledgement strategies", () => {
    const endpoint = testEndpoint({
      id: "endpoint-1",
      metadata: { lastResumedAt: 9_500 },
    });
    const previous = testEndpoint({ id: "endpoint-1" });

    expect(invocationTargetSessionId(testInvocation({
      execution: { targetSessionId: " execution-session " },
      metadata: { targetSessionId: "metadata-session" },
    }))).toBe("execution-session");
    expect(invocationTargetSessionId(testInvocation({
      metadata: { targetSessionId: "metadata-session" },
    }))).toBe("metadata-session");
    expect(dispatchAckStrategyForEndpoint({
      invocation: testInvocation({ execution: { session: "existing" } }),
      endpoint,
      now: 10_000,
    })).toBe("steer");
    expect(dispatchAckStrategyForEndpoint({
      invocation: testInvocation(),
      endpoint,
      previousEndpoint: previous,
      now: 10_000,
    })).toBe("attach");
    expect(dispatchAckStrategyForEndpoint({
      invocation: testInvocation(),
      endpoint,
      now: 10_000,
    })).toBe("wake");
    expect(dispatchAckStrategyForEndpoint({
      invocation: testInvocation({ ensureAwake: true }),
      endpoint: testEndpoint(),
      now: 10_000,
    })).toBe("spawn");
    expect(dispatchAckStrategyForEndpoint({
      invocation: testInvocation(),
      endpoint: testEndpoint(),
      now: 10_000,
    })).toBe("queued");
  });

  test("recognizes stale-flight activity items", () => {
    expect(isReconciledStaleFlightActivityItem({
      kind: "flight_updated",
      summary: "Stale running flight reconciled: endpoint moved offline",
    })).toBe(true);
    expect(isReconciledStaleFlightActivityItem({
      kind: "flight_updated",
      summary: "normal update",
    })).toBe(false);
    expect(isReconciledStaleFlightActivityItem({
      kind: "message",
      summary: "Stale running flight reconciled: hidden",
    })).toBe(false);
  });

  test("explains stale working flights without daemon task state", () => {
    const runtime = createInMemoryControlRuntime({
      agents: {
        "agent-1": testAgent(),
        retired: testAgent({ id: "retired", metadata: { retiredFromFleet: true } }),
      },
      endpoints: {
        replayed: testEndpoint({
          id: "replayed",
          agentId: "agent-1",
          state: "active",
          metadata: {
            lastInvocationId: "invocation-1",
            lastStartedAt: 1_000,
          },
        }),
        retired: testEndpoint({ id: "retired-endpoint", agentId: "retired" }),
      },
      flights: {
        working: testFlight({
          id: "working",
          invocationId: "invocation-1",
          targetAgentId: "agent-1",
          state: "running",
          startedAt: 900,
          metadata: { dispatchAck: { endpointId: "replayed" } },
        }),
        active: testFlight({
          id: "active",
          invocationId: "active-invocation",
          targetAgentId: "agent-1",
          state: "running",
          startedAt: 900,
        }),
        old: testFlight({
          id: "old",
          invocationId: "old-invocation",
          targetAgentId: "agent-1",
          state: "running",
          startedAt: 500,
          metadata: { dispatchAck: { endpointId: "older-owner", sessionId: "older-session" } },
        }),
        newer: testFlight({
          id: "newer",
          invocationId: "newer-invocation",
          targetAgentId: "agent-1",
          state: "completed",
          completedAt: 700,
          metadata: { dispatchAck: { endpointId: "older-owner", sessionId: "older-session" } },
        }),
        retired: testFlight({
          id: "retired",
          invocationId: "retired-invocation",
          targetAgentId: "retired",
          state: "queued",
          startedAt: 500,
        }),
      },
    }, { localNodeId: "node-1" });
    const snapshot = runtime.snapshot();

    expect(staleWorkingFlightReason(snapshot, snapshot.flights.active!, {
      isInvocationActive: (id) => id === "active-invocation",
    })).toBeNull();
    expect(staleWorkingFlightReason(snapshot, snapshot.flights.old!, {
      isInvocationActive: () => false,
    })).toBe("superseded by newer completed flight newer");
    expect(staleWorkingFlightReason(snapshot, snapshot.flights.retired!, {
      isInvocationActive: () => false,
    })).toBe("target agent retired was retired from the fleet");
    expect(staleWorkingFlightReason(snapshot, snapshot.flights.working!, {
      isInvocationActive: () => false,
    })).toBe("endpoint replayed was replayed active for invocation invocation-1 without a live broker task");
    const timedOut = { ...snapshot.flights.working!, metadata: { ...snapshot.flights.working!.metadata, requesterTimedOut: true } };
    expect(staleWorkingFlightReason(snapshot, timedOut, {
      isInvocationActive: () => false,
    })).toBeNull();
  });

  test("newer work on another session cannot supersede a flight for the same agent", () => {
    const active = testFlight({
      state: "running",
      metadata: { dispatchAck: { endpointId: "endpoint-1", sessionId: "native-1", nodeId: "node-1" } },
    });
    for (const dispatchAck of [
      { endpointId: "endpoint-2", sessionId: "native-2", nodeId: "node-1" },
      { endpointId: "endpoint-1", sessionId: "native-2", nodeId: "node-1" },
      { endpointId: "endpoint-1", sessionId: "native-1", nodeId: "node-2" },
      {},
    ]) {
      const snapshot = createInMemoryControlRuntime({
        agents: { "agent-1": testAgent() },
        endpoints: { "endpoint-1": testEndpoint({ state: "active" }) },
        flights: {
          active,
          newer: testFlight({ id: "newer", invocationId: "newer", state: "completed", completedAt: 2_000, metadata: { dispatchAck } }),
        },
      }, { localNodeId: "node-1" }).snapshot();
      expect(staleWorkingFlightReason(snapshot, active, { isInvocationActive: () => false, now: 2_000 })).toBeNull();
    }
  });

  test("a provider identity refinement still identifies the same execution owner", () => {
    const active = testFlight({ state: "running", metadata: { dispatchAck: { endpointId: "endpoint-1", sessionId: "pending-1" } } });
    const snapshot = createInMemoryControlRuntime({
      flights: {
        active,
        newer: testFlight({
          id: "newer", invocationId: "newer", state: "completed", completedAt: 2_000,
          metadata: { dispatchAck: { endpointId: "endpoint-1", sessionId: "native-1", refinesSessionId: "pending-1" } },
        }),
      },
    }, { localNodeId: "node-1" }).snapshot();
    expect(staleWorkingFlightReason(snapshot, active, { isInvocationActive: () => false }))
      .toBe("superseded by newer completed flight newer");
  });

  test("unattributed flights do not inherit another session's endpoint lifecycle", () => {
    const flight = testFlight({ state: "running" });
    const snapshot = createInMemoryControlRuntime({
      agents: { "agent-1": testAgent() },
      endpoints: { other: testEndpoint({ id: "other", state: "offline", metadata: { lastFailedAt: 5_000 } }) },
      flights: { flight },
    }, { localNodeId: "node-1" }).snapshot();
    expect(endpointForFlight(snapshot, flight)).toBeNull();
    expect(staleWorkingFlightReason(snapshot, flight, { isInvocationActive: () => false, now: 500_000 })).toBeNull();
  });

  test("missing broker task or newer work cannot resolve an unknown native submission", () => {
    const flight = testFlight({
      state: "waiting",
      metadata: { dispatchAck: { endpointId: "endpoint-1" }, dispatchOutcome: { status: "submission_unknown" } },
    });
    const snapshot = createInMemoryControlRuntime({
      flights: {
        flight,
        newer: testFlight({ id: "newer", invocationId: "newer", state: "completed", completedAt: 2_000, metadata: { dispatchAck: { endpointId: "endpoint-1" } } }),
      },
    }, { localNodeId: "node-1" }).snapshot();
    expect(staleWorkingFlightReason(snapshot, flight, { isInvocationActive: () => false, now: 500_000 })).toBeNull();
  });

  test("waits briefly for endpoint recovery before marking endpointless working flights stale", () => {
    const runtime = createInMemoryControlRuntime({
      agents: {
        "agent-1": testAgent(),
      },
      endpoints: {},
      flights: {
        waking: testFlight({
          id: "waking",
          invocationId: "invocation-1",
          targetAgentId: "agent-1",
          state: "waking",
          startedAt: 10_000,
        }),
      },
    }, { localNodeId: "node-1" });
    const snapshot = runtime.snapshot();
    const flight = snapshot.flights.waking!;

    expect(staleWorkingFlightReason(snapshot, flight, {
      isInvocationActive: () => true,
      now: 10_000 + STALE_WORKING_FLIGHT_NO_ENDPOINT_GRACE_MS + 1,
    })).toBeNull();
    expect(staleWorkingFlightReason(snapshot, flight, {
      isInvocationActive: () => false,
      now: 10_000 + STALE_WORKING_FLIGHT_NO_ENDPOINT_GRACE_MS - 1,
    })).toBeNull();
    expect(staleWorkingFlightReason(snapshot, flight, {
      isInvocationActive: () => false,
      now: 10_000 + STALE_WORKING_FLIGHT_NO_ENDPOINT_GRACE_MS,
    })).toBe("target agent agent-1 has no registered endpoint after 120s");
  });
});
