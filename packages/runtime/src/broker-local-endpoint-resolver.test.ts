import { describe, expect, test } from "bun:test";

import type {
  ActorIdentity,
  AgentDefinition,
  AgentEndpoint,
  InvocationRequest,
} from "@openscout/protocol";

import { createInMemoryControlRuntime } from "./broker.js";
import {
  BrokerLocalEndpointResolver,
  PENDING_PROVISIONED_RUNTIME_TRUST_MS,
} from "./broker-local-endpoint-resolver.js";
import type { LocalAgentBinding } from "./local-agents.js";
import type { LocalEndpointSessionObservation } from "./session-observation.js";

function testActor(input: Partial<ActorIdentity> = {}): ActorIdentity {
  return {
    id: "agent-1",
    kind: "agent",
    displayName: "Agent One",
    handle: "agent-one",
    labels: ["agent"],
    metadata: {},
    ...input,
  };
}

function testAgent(input: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    ...testActor(input),
    id: "agent-1",
    kind: "agent",
    definitionId: "agent-1",
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

function createResolver(input: {
  bindings?: Record<string, LocalAgentBinding | null>;
  onlineSession?: {
    externalSessionId?: string | null;
    metadata?: Record<string, unknown>;
  };
  isolatedEndpoint?: AgentEndpoint | null;
  observe?: (endpoint: AgentEndpoint) => Promise<LocalEndpointSessionObservation | null>;
  now?: number;
} = {}) {
  const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });
  const persistedEndpoints: AgentEndpoint[] = [];
  const observedEndpoints: AgentEndpoint[] = [];
  const upsertedActors: ActorIdentity[] = [];
  const upsertedAgents: AgentDefinition[] = [];
  const ensuredBindings: Array<{ agentId: string; harness?: string }> = [];
  const ensuredSessionEndpoints: AgentEndpoint[] = [];
  const isolatedInvocations: InvocationRequest[] = [];
  const resolver = new BrokerLocalEndpointResolver({
    nodeId: "node-1",
    runtime,
    isLocalAgentEndpointAlive: (endpoint) => endpoint.metadata?.alive === true,
    async ensureLocalSessionEndpointOnline(endpoint) {
      ensuredSessionEndpoints.push(endpoint);
      return input.onlineSession ?? { externalSessionId: "revived-session" };
    },
    async ensureLocalAgentBindingOnline(agentId, _nodeId, options) {
      ensuredBindings.push({ agentId, harness: options.harness });
      return input.bindings?.[agentId] ?? null;
    },
    async createIsolatedAgentEndpoint(invocation) {
      isolatedInvocations.push(invocation);
      return input.isolatedEndpoint ?? null;
    },
    ...(input.observe ? {
      observeLocalEndpointSession: async (endpoint: AgentEndpoint) => {
        observedEndpoints.push(endpoint);
        return input.observe!(endpoint);
      },
    } : {}),
    async upsertActor(actor) {
      upsertedActors.push(actor);
      await runtime.upsertActor(actor);
    },
    async upsertAgent(agent) {
      upsertedAgents.push(agent);
      await runtime.upsertAgent(agent);
    },
    async persistEndpoint(endpoint) {
      persistedEndpoints.push(endpoint);
      await runtime.upsertEndpoint(endpoint);
    },
    now: () => input.now ?? 10_000,
  });

  return {
    runtime,
    resolver,
    persistedEndpoints,
    upsertedActors,
    upsertedAgents,
    ensuredBindings,
    ensuredSessionEndpoints,
    isolatedInvocations,
    observedEndpoints,
  };
}

describe("BrokerLocalEndpointResolver", () => {
  test("selects active endpoints by transport preference and session aliases", async () => {
    const harness = createResolver();
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "codex",
      transport: "codex_app_server",
      metadata: { alive: true, lastStartedAt: 2_000 },
    }));
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "tmux",
      transport: "tmux",
      metadata: { alive: true, lastStartedAt: 1_000, tmuxSession: "tmux-session" },
    }));
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "stale",
      transport: "codex_app_server",
      metadata: { staleLocalRegistration: true, lastStartedAt: 10_000 },
    }));

    expect(harness.resolver.activeLocalEndpointForAgent("agent-1")?.id).toBe("tmux");
    expect(harness.resolver.activeLocalEndpointForAgent("agent-1", undefined, "tmux-session")?.id).toBe("tmux");
    expect(harness.resolver.activeLocalEndpointForAgent("agent-1", undefined, "missing")).toBeUndefined();
  });

  test("returns existing pairing endpoints and honors existing-session requests", async () => {
    const harness = createResolver();
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "pairing",
      transport: "pairing_bridge",
      sessionId: "pairing-session",
      metadata: { source: "pairing-session", managedByScout: true },
    }));

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { targetSessionId: "pairing-session" },
    }))).resolves.toEqual(expect.objectContaining({ id: "pairing" }));
    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      targetAgentId: "missing-agent",
      execution: { session: "existing" },
      ensureAwake: true,
    }))).resolves.toBeUndefined();
  });

  test("rejects stale exact-session endpoints before trying to revive them", async () => {
    const harness = createResolver();
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "stale-session",
      sessionId: "thread-1",
      state: "waiting",
      metadata: {
        staleLocalRegistration: true,
        replacedByAgentId: "agent-2",
      },
    }));

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { targetSessionId: "thread-1" },
      ensureAwake: true,
    }))).rejects.toThrow("endpoint stale-session is a superseded local registration replaced by current setup");
    expect(harness.ensuredSessionEndpoints).toEqual([]);
  });

  test("revives managed local-session endpoints for exact-session wake requests", async () => {
    const harness = createResolver({
      onlineSession: {
        externalSessionId: "thread-revived",
        metadata: { runtimeInstanceId: "runtime-1" },
      },
      now: 12_000,
    });
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "local-session",
      transport: "codex_app_server",
      state: "waiting",
      sessionId: "thread-old",
      metadata: {
        source: "local-session",
        managedByScout: true,
        threadId: "thread-old",
        lastError: "offline",
        lastFailedAt: 9_000,
      },
    }));

    const endpoint = await harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { targetSessionId: "thread-old" },
      ensureAwake: true,
    }));

    expect(endpoint).toEqual(expect.objectContaining({
      id: "local-session",
      state: "idle",
      sessionId: "thread-old",
      metadata: expect.objectContaining({
        source: "local-session",
        managedByScout: true,
        runtimeInstanceId: "runtime-1",
        externalSessionId: "thread-revived",
        threadId: "thread-revived",
        lastResumedAt: 12_000,
      }),
    }));
    expect(endpoint?.metadata?.lastError).toBeUndefined();
    expect(endpoint?.metadata?.lastFailedAt).toBeUndefined();
    expect(harness.persistedEndpoints).toHaveLength(1);
  });

  test("rejects placement changes before reviving an exact session", async () => {
    const harness = createResolver();
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "background-session",
      state: "waiting",
      sessionId: "thread-background",
      metadata: {
        source: "local-session",
        managedByScout: true,
        placement: "background",
        threadId: "thread-background",
      },
    }));

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: {
        session: "existing",
        targetSessionId: "thread-background",
        placement: "foreground",
      },
      ensureAwake: true,
    }))).rejects.toThrow("session thread-background is background; request foreground with a new session instead");
    expect(harness.ensuredSessionEndpoints).toEqual([]);
  });

  test("revives registry-backed Codex endpoints for exact-session wake requests", async () => {
    const harness = createResolver({
      onlineSession: {
        externalSessionId: "thread-current",
      },
      now: 13_000,
    });
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "registry-codex",
      transport: "codex_app_server",
      state: "waiting",
      sessionId: "relay-agent-codex",
      metadata: {
        source: "relay-agent-registry",
        runtimeInstanceId: "relay-agent-codex",
        externalSessionId: "thread-current",
        threadId: "thread-current",
        lastError: "codex_app_server session unavailable: relay-agent-codex",
        lastFailedAt: 9_000,
      },
    }));

    const endpoint = await harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { session: "existing", targetSessionId: "relay-agent-codex" },
      ensureAwake: true,
    }));

    expect(endpoint).toEqual(expect.objectContaining({
      id: "registry-codex",
      state: "idle",
      sessionId: "relay-agent-codex",
      metadata: expect.objectContaining({
        source: "relay-agent-registry",
        runtimeInstanceId: "relay-agent-codex",
        externalSessionId: "thread-current",
        threadId: "thread-current",
        lastResumedAt: 13_000,
      }),
    }));
    expect(endpoint?.metadata?.lastError).toBeUndefined();
    expect(endpoint?.metadata?.lastFailedAt).toBeUndefined();
    expect(harness.ensuredSessionEndpoints.map((candidate) => candidate.id)).toEqual(["registry-codex"]);
    expect(harness.persistedEndpoints).toHaveLength(1);
  });

  // --- tmux sessions: identity and runtime come from harness evidence ---
  //
  // A Scout-launched claude session in tmux registers pending: alive, but its
  // harness id was never learned, so it matches no alias. The harness records
  // its own id next to the tmux pane it runs in; `observe` stands in for that
  // record here (see claude-session-records.test.ts for the on-disk reader).
  const nativeId = "7b81300d-0a9c-4953-8d7f-9274b11ebdfb";
  const foreignId = "0a898412-b3a2-4659-aad3-405e9a24d015";

  function tmuxObservation(
    sessionId: string,
    runtime: LocalEndpointSessionObservation["runtime"] = { harness: "claude", model: "claude-opus-5" },
  ): LocalEndpointSessionObservation {
    return {
      sessionId,
      runtime,
      runtimeSource: "claude-statusline",
      evidence: { source: "claude-session-record", tmuxSession: "session-mtus22pe", pid: 17446 },
      observedAt: 10_000_000,
    };
  }

  function pendingTmuxEndpoint(input: Partial<AgentEndpoint> = {}): AgentEndpoint {
    return testEndpoint({
      id: "isolated-tmux",
      harness: "claude",
      transport: "tmux",
      state: "active",
      sessionId: "session-mtus22pe",
      ...input,
      metadata: {
        source: "scout-isolated-agent-session",
        sessionBacked: true,
        pendingExternalSession: true,
        pendingExternalSessionAt: 9_000,
        model: "claude-opus-5",
        alive: true,
        ...(input.metadata ?? {}),
      },
    });
  }

  test("binds the id the harness reports for a pending tmux session, then continues it by either alias", async () => {
    const harness = createResolver({
      now: 10_000_000,
      observe: async () => tmuxObservation(nativeId),
    });
    await harness.runtime.upsertEndpoint(pendingTmuxEndpoint());

    const resolved = await harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { session: "existing", targetSessionId: nativeId },
      ensureAwake: true,
    }));

    expect(resolved?.id).toBe("isolated-tmux");
    expect(harness.observedEndpoints.map((endpoint) => endpoint.id)).toEqual(["isolated-tmux"]);
    expect(harness.persistedEndpoints).toEqual([
      expect.objectContaining({
        id: "isolated-tmux",
        // The Scout-owned routing id is untouched; the harness id is an alias.
        sessionId: "session-mtus22pe",
        metadata: expect.objectContaining({
          externalSessionId: nativeId,
          pendingExternalSession: false,
          observedSessionId: nativeId,
          observedRuntime: { harness: "claude", model: "claude-opus-5" },
          observedRuntimeAt: 10_000_000,
          observedRuntimeSource: "claude-statusline",
          observedSessionEvidence: expect.objectContaining({ source: "claude-session-record", pid: 17446 }),
        }),
      }),
    ]);

    // Native alias and Scout session id name the same endpoint from now on.
    for (const targetSessionId of [nativeId, "session-mtus22pe"]) {
      const followUp = await harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
        execution: { session: "existing", targetSessionId },
        ensureAwake: true,
      }));
      expect(followUp?.id).toBe("isolated-tmux");
      expect(followUp?.metadata?.externalSessionId).toBe(nativeId);
    }
  });

  test("never binds a caller's id that the harness did not report", async () => {
    const harness = createResolver({
      now: 10_000_000,
      observe: async () => tmuxObservation(nativeId),
    });
    await harness.runtime.upsertEndpoint(pendingTmuxEndpoint());

    // The only pending process is not proof that it is the caller's session.
    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { session: "existing", targetSessionId: foreignId },
      ensureAwake: true,
    }))).rejects.toThrow(`session ${foreignId} is not currently reachable`);

    // What the harness reported is still worth keeping; the claim is not.
    expect(harness.persistedEndpoints).toHaveLength(1);
    expect(harness.persistedEndpoints[0]?.metadata?.externalSessionId).toBe(nativeId);
    expect(harness.persistedEndpoints[0]?.metadata?.externalSessionAdoptedAt).toBeUndefined();
  });

  test("leaves a session pending when there is no harness evidence and fabricates no runtime", async () => {
    const harness = createResolver({
      now: 9_000 + 15 * 60 * 60_000,
      observe: async () => null,
    });
    await harness.runtime.upsertEndpoint(pendingTmuxEndpoint({
      metadata: {
        executionResolution: {
          harness: { requested: "claude", resolved: "claude", source: "flag" },
          model: { requested: "claude-opus-5", resolved: "claude-opus-5", source: "flag" },
        },
      },
    }));

    for (const execution of [
      { session: "existing" as const, targetSessionId: nativeId },
      { session: "existing" as const, targetSessionId: nativeId, harness: "claude" as const, model: "claude-opus-5" },
    ]) {
      await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
        execution,
        ensureAwake: true,
      }))).rejects.toThrow("is not currently reachable");
    }
    // Launch flags never became an observed runtime, and nothing was bound.
    expect(harness.persistedEndpoints).toEqual([]);
    expect(harness.observedEndpoints).toHaveLength(2);
  });

  test("judges an exact runtime on what the harness reports, not on launch flags", async () => {
    const harness = createResolver({
      now: 10_000_000,
      observe: async () => tmuxObservation(nativeId, { harness: "claude", model: "claude-sonnet-5" }),
    });
    await harness.runtime.upsertEndpoint(pendingTmuxEndpoint({
      metadata: {
        executionResolution: {
          model: { requested: "claude-opus-5", resolved: "claude-opus-5", source: "flag" },
        },
      },
    }));

    // Launched with opus flags, observed running sonnet: the observation wins.
    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { session: "existing", targetSessionId: nativeId, harness: "claude", model: "claude-opus-5" },
      ensureAwake: true,
    }))).rejects.toThrow("session_runtime_mismatch");
    expect(harness.persistedEndpoints.at(-1)?.metadata?.observedRuntime).toEqual({
      harness: "claude",
      model: "claude-sonnet-5",
    });

    const resolved = await harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { session: "existing", targetSessionId: nativeId, harness: "claude", model: "claude-sonnet-5" },
      ensureAwake: true,
    }));
    expect(resolved?.id).toBe("isolated-tmux");
  });

  test("an exact runtime stays unobserved when the harness reported only its identity", async () => {
    const harness = createResolver({
      now: 10_000_000,
      observe: async () => tmuxObservation(nativeId, { harness: "claude" }),
    });
    await harness.runtime.upsertEndpoint(pendingTmuxEndpoint());

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { session: "existing", targetSessionId: nativeId, harness: "claude", model: "claude-opus-5" },
      ensureAwake: true,
    }))).rejects.toThrow("session_runtime_unobserved");
    expect(harness.persistedEndpoints.at(-1)?.metadata?.observedRuntime).toEqual({ harness: "claude" });

    // Without a runtime constraint the same session is simply continued.
    const resolved = await harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { session: "existing", targetSessionId: nativeId },
      ensureAwake: true,
    }));
    expect(resolved?.id).toBe("isolated-tmux");
  });

  test("trusts the runtime Scout provisioned while a fresh tmux session is still pending", async () => {
    // The process has not attached yet, so observation is impossible; the
    // pending-launch window trusts what the broker itself just provisioned.
    const harness = createResolver({
      now: 9_000 + 60_000,
      observe: async () => null,
    });
    await harness.runtime.upsertEndpoint(pendingTmuxEndpoint());

    const resolved = await harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { session: "existing", targetSessionId: "session-mtus22pe", harness: "claude", model: "claude-opus-5" },
      ensureAwake: true,
    }));
    expect(resolved?.id).toBe("isolated-tmux");

    // A conflicting request is still refused on the provisioned values.
    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { session: "existing", targetSessionId: "session-mtus22pe", harness: "claude", model: "claude-sonnet-5" },
      ensureAwake: true,
    }))).rejects.toThrow("session_runtime_mismatch");
  });

  test("an exact runtime stays unobserved for a pending session past the provisioning grace", async () => {
    const harness = createResolver({
      now: 9_000 + PENDING_PROVISIONED_RUNTIME_TRUST_MS + 1_000,
      observe: async () => null,
    });
    await harness.runtime.upsertEndpoint(pendingTmuxEndpoint());

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { session: "existing", targetSessionId: "session-mtus22pe", harness: "claude", model: "claude-opus-5" },
      ensureAwake: true,
    }))).rejects.toThrow("session_runtime_unobserved");
  });

  test("correlates each pending endpoint against its own harness record", async () => {
    const harness = createResolver({
      now: 10_000_000,
      observe: async (endpoint) => tmuxObservation(`native-${endpoint.id}`),
    });
    for (const id of ["isolated-a", "isolated-b"]) {
      await harness.runtime.upsertEndpoint(pendingTmuxEndpoint({ id, sessionId: id }));
    }

    const resolved = await harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { session: "existing", targetSessionId: "native-isolated-b" },
      ensureAwake: true,
    }));
    expect(resolved?.id).toBe("isolated-b");
    expect(harness.persistedEndpoints.map((endpoint) => [endpoint.id, endpoint.metadata?.externalSessionId])).toEqual([
      ["isolated-a", "native-isolated-a"],
      ["isolated-b", "native-isolated-b"],
    ]);

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { session: "existing", targetSessionId: "native-isolated-c" },
      ensureAwake: true,
    }))).rejects.toThrow("is not currently reachable");
  });

  test("an ordinary follow-up steers a live tmux session long after the provisioning grace", async () => {
    // No session selector and no runtime constraint: the descriptive harness
    // and model on the agent's card are not a request, so nothing is judged.
    const harness = createResolver({
      now: 9_000 + 15 * 60 * 60_000,
      observe: async () => null,
    });
    await harness.runtime.upsertEndpoint(pendingTmuxEndpoint());

    const resolved = await harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { session: "existing" },
      ensureAwake: true,
    }));
    expect(resolved?.id).toBe("isolated-tmux");
    expect(harness.observedEndpoints).toEqual([]);
    expect(harness.persistedEndpoints).toEqual([]);
  });

  test("re-verifies an adopted alias against the harness before an exact continuation", async () => {
    // Left behind by the retired adoption path: a caller's id bound to the
    // only pending process, stamped externalSessionAdoptedAt.
    const harness = createResolver({
      now: 10_000_000,
      observe: async () => tmuxObservation(nativeId),
    });
    await harness.runtime.upsertEndpoint(pendingTmuxEndpoint({
      metadata: {
        pendingExternalSession: false,
        externalSessionId: foreignId,
        externalSessionAdoptedAt: 9_500,
      },
    }));

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { session: "existing", targetSessionId: foreignId },
      ensureAwake: true,
    }))).rejects.toThrow("session_identity_mismatch");
    expect(harness.persistedEndpoints.at(-1)?.metadata).toEqual(expect.objectContaining({
      externalSessionId: nativeId,
      pendingExternalSession: false,
    }));
    expect(harness.persistedEndpoints.at(-1)?.metadata?.externalSessionAdoptedAt).toBeUndefined();

    const resolved = await harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { session: "existing", targetSessionId: nativeId },
      ensureAwake: true,
    }));
    expect(resolved?.id).toBe("isolated-tmux");
  });

  test("rejects unexplained native identity drift even on flat dispatch while retaining Scout selectors", async () => {
    const harness = createResolver({ now: 10_000_000, observe: async () => tmuxObservation(nativeId) });
    await harness.runtime.upsertEndpoint(pendingTmuxEndpoint({
      metadata: { flatDispatch: true, pendingExternalSession: false, externalSessionId: foreignId, nativeSessionId: foreignId },
    }));
    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { session: "existing", targetSessionId: foreignId, harness: "claude", model: "claude-opus-5" },
      ensureAwake: true,
    }))).rejects.toThrow("session_identity_mismatch");
    const resolved = await harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { session: "existing", targetSessionId: "session-mtus22pe" }, ensureAwake: true,
    }));
    expect(resolved?.metadata?.externalSessionId).toBe(nativeId);
  });

  for (const missing of ["null", "throw"] as const) {
    test(`rejects previously verified native tmux identity when current observation is ${missing}`, async () => {
      const harness = createResolver({ observe: async () => { if (missing === "throw") throw new Error("missing"); return null; } });
      await harness.runtime.upsertEndpoint(pendingTmuxEndpoint({ metadata: {
        pendingExternalSession: false, externalSessionId: nativeId,
        observedRuntime: { harness: "claude", model: "claude-opus-5" },
      } }));
      await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
        execution: { targetSessionId: nativeId }, ensureAwake: true,
      }))).rejects.toThrow("session_identity_unobserved");
      expect(harness.ensuredSessionEndpoints).toHaveLength(0);
      const stable = await harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
        execution: { targetSessionId: "session-mtus22pe" }, ensureAwake: true,
      }));
      expect(stable?.id).toBe("isolated-tmux");
    });
  }

  test("an offline configured tmux endpoint cannot bypass native identity checks through revival", async () => {
    const harness = createResolver({ observe: async () => null });
    await harness.runtime.upsertEndpoint(pendingTmuxEndpoint({ state: "offline", metadata: {
      pendingExternalSession: false, externalSessionId: nativeId, alive: false,
    } }));
    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { targetSessionId: nativeId }, ensureAwake: true,
    }))).rejects.toThrow();
    expect(harness.ensuredSessionEndpoints).toHaveLength(0);
  });

  test("only permits unobserved flat native resume when stopped, with no exact model or effort", async () => {
    const harness = createResolver({ observe: async () => null });
    const endpoint = pendingTmuxEndpoint({ metadata: {
      flatDispatch: true, pendingExternalSession: false, externalSessionId: nativeId,
      observedRuntime: { harness: "claude", model: "claude-opus-5", reasoningEffort: "high" },
    } });
    await harness.runtime.upsertEndpoint(endpoint);
    const request = testInvocation({ execution: { targetSessionId: nativeId, harness: "claude" }, ensureAwake: true });
    await expect(harness.resolver.resolveLocalEndpointForInvocation(request)).rejects.toThrow("session_identity_unobserved");
    await harness.runtime.upsertEndpoint({ ...endpoint, metadata: { ...endpoint.metadata, alive: false } });
    for (const dimension of [{ model: "claude-opus-5" }, { reasoningEffort: "high" }]) {
      await expect(harness.resolver.resolveLocalEndpointForInvocation({ ...request,
        execution: { ...request.execution, ...dimension },
      })).rejects.toThrow("session_runtime_unobserved");
    }
    const resumed = await harness.resolver.resolveLocalEndpointForInvocation(request);
    expect(resumed?.metadata?.externalSessionId).toBe(nativeId);
    expect(resumed?.metadata?.observedRuntime).toBeNull();
    expect(resumed?.metadata?.observedSessionEvidence).toBeNull();
  });

  for (const unavailable of ["absent", "null", "throw"] as const) {
    test(`quarantines adopted aliases and runtime when observer is ${unavailable}`, async () => {
      const harness = createResolver({ now: 10_000_000, ...(unavailable === "absent" ? {} : {
        observe: async () => { if (unavailable === "throw") throw new Error("unavailable"); return null; },
      }) });
      await harness.runtime.upsertEndpoint(pendingTmuxEndpoint({ metadata: {
        pendingExternalSession: false, externalSessionId: foreignId, nativeSessionId: foreignId,
        externalSessionAdoptedAt: 9_500, observedRuntime: { harness: "claude", model: "claude-opus-5" },
        observedModel: "claude-opus-5",
      } }));
      await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
        execution: { targetSessionId: foreignId, harness: "claude", model: "claude-opus-5" }, ensureAwake: true,
      }))).rejects.toThrow("session_identity_mismatch");
      await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
        execution: { targetSessionId: "session-mtus22pe", harness: "claude", model: "claude-opus-5" }, ensureAwake: true,
      }))).rejects.toThrow("session_runtime_unobserved");
      const stable = await harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
        execution: { targetSessionId: "session-mtus22pe" }, ensureAwake: true,
      }));
      expect(stable?.metadata?.externalSessionId).toBeNull();
      expect(stable?.metadata?.observedRuntime).toBeNull();
    });
  }

  test("fails exact-session wake requests when the matching endpoint cannot be resumed", async () => {
    const harness = createResolver({ now: 14_000 });
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "missing-tmux",
      transport: "tmux",
      state: "waiting",
      sessionId: "relay-agent-claude",
      metadata: {
        source: "relay-agent-registry",
        tmuxSession: "relay-agent-claude",
      },
    }));

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { session: "existing", targetSessionId: "relay-agent-claude" },
      ensureAwake: true,
    }))).rejects.toThrow("session relay-agent-claude is not currently reachable");
    expect(harness.ensuredSessionEndpoints).toEqual([]);
    expect(harness.persistedEndpoints).toEqual([
      expect.objectContaining({
        id: "missing-tmux",
        state: "offline",
        metadata: expect.objectContaining({
          lastError: "tmux session missing: relay-agent-claude",
          lastFailedAt: 14_000,
        }),
      }),
    ]);
  });

  test("selects a wakeable session-backed endpoint only when wake is requested", async () => {
    const harness = createResolver();
    const endpoint = testEndpoint({
      id: "cardless-session",
      agentId: "session-cardless",
      transport: "claude_stream_json",
      harness: "claude",
      sessionId: "session-cardless",
      metadata: {
        source: "scout-cardless-session",
        cardless: true,
        sessionBacked: true,
        pendingExternalSession: true,
        pendingExternalSessionAt: 9_000,
      },
    });
    await harness.runtime.upsertEndpoint(endpoint);

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      targetAgentId: "session-cardless",
      ensureAwake: false,
      execution: { harness: "claude" },
    }))).resolves.toBeUndefined();
    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      targetAgentId: "session-cardless",
      ensureAwake: true,
      execution: { harness: "claude" },
    }))).resolves.toEqual(endpoint);
    expect(harness.ensuredBindings).toEqual([]);
  });

  test("persists a provider thread while preserving pending-session routing identity", async () => {
    const harness = createResolver({
      onlineSession: {
        externalSessionId: "019ff3f8-322d-7572-990f-447725ffd348",
      },
    });
    const endpoint = testEndpoint({
      id: "spinoza-2",
      agentId: "session-spinoza-2",
      sessionId: "session-spinoza-2",
      metadata: {
        source: "scout-cardless-session",
        sessionBacked: true,
        pendingExternalSession: true,
      },
    });

    const prepared = await harness.resolver.prepareLocalEndpointForInvocation(endpoint);

    expect(prepared).toEqual(expect.objectContaining({
      id: endpoint.id,
      sessionId: "session-spinoza-2",
      metadata: expect.objectContaining({
        externalSessionId: "019ff3f8-322d-7572-990f-447725ffd348",
        threadId: "019ff3f8-322d-7572-990f-447725ffd348",
        pendingExternalSession: false,
      }),
    }));
    expect(harness.ensuredSessionEndpoints).toEqual([endpoint]);
    expect(harness.persistedEndpoints).toEqual([prepared]);
  });

  test("promotes Pi provider metadata instead of its Scout runtime result id", async () => {
    const harness = createResolver({
      onlineSession: {
        externalSessionId: "runtime-pi-spinoza",
        metadata: {
          externalSessionId: "native-pi-spinoza",
          threadId: "native-pi-spinoza",
        },
      },
    });
    const endpoint = testEndpoint({
      id: "pi-spinoza",
      agentId: "session-pi-spinoza",
      sessionId: "runtime-pi-spinoza",
      transport: "pi_rpc",
      harness: "pi",
      metadata: {
        source: "scout-cardless-session",
        sessionBacked: true,
        pendingExternalSession: true,
      },
    });

    const prepared = await harness.resolver.prepareLocalEndpointForInvocation(endpoint);

    expect(prepared.sessionId).toBe("runtime-pi-spinoza");
    expect(prepared.metadata).toEqual(expect.objectContaining({
      externalSessionId: "native-pi-spinoza",
      threadId: "native-pi-spinoza",
      pendingExternalSession: false,
    }));
  });

  test("does not preflight unsupported direct transports", async () => {
    const harness = createResolver();
    const endpoint = testEndpoint({
      transport: "grok_acp",
      harness: "grok",
      metadata: {
        sessionBacked: true,
        pendingExternalSession: true,
      },
    });

    await expect(harness.resolver.prepareLocalEndpointForInvocation(endpoint)).resolves.toEqual(endpoint);
    expect(harness.ensuredSessionEndpoints).toEqual([]);
    expect(harness.persistedEndpoints).toEqual([]);
  });

  test("starts and persists a local binding when wake is requested without an exact session", async () => {
    const actor = testActor({ id: "actor-1" });
    const agent = testAgent({ id: "agent-1" });
    const endpoint = testEndpoint({ id: "started-endpoint" });
    const harness = createResolver({
      bindings: {
        "agent-1": { actor, agent, endpoint },
      },
    });

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      ensureAwake: true,
      execution: { harness: "codex" },
    }))).resolves.toEqual(endpoint);
    expect(harness.ensuredBindings).toEqual([{ agentId: "agent-1", harness: "codex" }]);
    expect(harness.upsertedActors).toEqual([actor]);
    expect(harness.upsertedAgents).toEqual([agent]);
    expect(harness.persistedEndpoints).toEqual([endpoint]);
  });

  test("spawns an isolated endpoint for an exact runtime instead of reusing a live durable endpoint", async () => {
    const isolatedEndpoint = testEndpoint({
      id: "isolated-endpoint",
      sessionId: "isolated-session",
      metadata: { isolatedExecution: true },
    });
    const harness = createResolver({ isolatedEndpoint });
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "durable-endpoint",
      metadata: { alive: true },
    }));

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      ensureAwake: true,
      execution: { harness: "codex", model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
    }))).resolves.toEqual(isolatedEndpoint);
    expect(harness.isolatedInvocations).toHaveLength(1);
    expect(harness.persistedEndpoints).toEqual([isolatedEndpoint]);
    expect(harness.ensuredBindings).toEqual([]);
  });

  test("fails closed instead of reusing an unobserved exact runtime when wake is disabled", async () => {
    const harness = createResolver();
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "unobserved-no-wake",
      metadata: { alive: true },
    }));

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      ensureAwake: false,
      execution: { harness: "codex", model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
    }))).rejects.toThrow("session_runtime_unobserved");
    expect(harness.isolatedInvocations).toEqual([]);
  });

  test("reuses an observed exact runtime when wake is disabled", async () => {
    const harness = createResolver();
    const endpoint = testEndpoint({
      id: "observed-no-wake",
      metadata: {
        alive: true,
        observedRuntime: {
          harness: "codex",
          model: "gpt-5.6-sol",
          reasoningEffort: "xhigh",
        },
      },
    });
    await harness.runtime.upsertEndpoint(endpoint);

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      ensureAwake: false,
      execution: { harness: "codex", model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
    }))).resolves.toEqual(endpoint);
  });

  test("allows an exact existing session only when every requested dimension was observed to match", async () => {
    const harness = createResolver();
    const endpoint = testEndpoint({
      id: "observed-endpoint",
      sessionId: "observed-session",
      metadata: {
        alive: true,
        observedRuntime: {
          harness: "codex",
          model: "gpt-5.6-sol",
          reasoningEffort: "xhigh",
        },
      },
    });
    await harness.runtime.upsertEndpoint(endpoint);

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      ensureAwake: true,
      execution: {
        harness: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        targetSessionId: "observed-session",
      },
    }))).resolves.toEqual(endpoint);
    expect(harness.isolatedInvocations).toEqual([]);
  });

  test.each([
    ["model", "fixture", "model", true],
    ["model", "fixture", "fixture/model", true],
    ["model", "fixture", "wrong/model", false],
    ["model", undefined, "fixture/model", false],
    ["org/model", "fixture", "fixture/org/model", true],
    ["org/model", "fixture", "org/model", true],
    ["org/model", "fixture", "wrong/org/model", false],
  ])("compares observed Pi model %s and provider %s to %s", async (model, modelProvider, required, matches) => {
    const harness = createResolver();
    const endpoint = testEndpoint({ id: "pi-observed", sessionId: "pi-observed-session", harness: "pi", transport: "pi_rpc",
      metadata: { alive: true, observedRuntime: { harness: "pi", model, modelProvider, reasoningEffort: "none" } } });
    await harness.runtime.upsertEndpoint(endpoint);
    const result = harness.resolver.resolveLocalEndpointForInvocation(testInvocation({ ensureAwake: true,
      execution: { harness: "pi", model: required as string, reasoningEffort: "none", targetSessionId: endpoint.sessionId } }));
    if (matches) await expect(result).resolves.toEqual(endpoint);
    else await expect(result).rejects.toThrow("session_runtime_mismatch");
  });

  test("allows the first exact invocation into a matching Scout-provisioned pending session", async () => {
    const harness = createResolver();
    const endpoint = testEndpoint({
      id: "pending-endpoint",
      sessionId: "pending-session",
      metadata: {
        alive: true,
        source: "scout-cardless-session",
        sessionBacked: true,
        pendingExternalSession: true,
        pendingExternalSessionAt: 9_000,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      },
    });
    await harness.runtime.upsertEndpoint(endpoint);

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      ensureAwake: true,
      execution: {
        harness: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        targetSessionId: "pending-session",
      },
    }))).resolves.toEqual(endpoint);
  });

  test("still rejects a pending session whose provisioned runtime does not match", async () => {
    const harness = createResolver();
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "pending-mismatch",
      sessionId: "pending-mismatch-session",
      metadata: {
        alive: true,
        source: "scout-cardless-session",
        sessionBacked: true,
        pendingExternalSession: true,
        pendingExternalSessionAt: 9_000,
        model: "gpt-5.6-terra",
      },
    }));

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: {
        harness: "codex",
        model: "gpt-5.6-sol",
        targetSessionId: "pending-mismatch-session",
      },
    }))).rejects.toThrow("session_runtime_mismatch");
  });

  test("expires provisioned runtime trust when a pending session never attaches", async () => {
    const now = PENDING_PROVISIONED_RUNTIME_TRUST_MS + 20_000;
    const harness = createResolver({ now });
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "expired-pending",
      sessionId: "expired-pending-session",
      metadata: {
        alive: true,
        source: "scout-isolated-agent-session",
        sessionBacked: true,
        pendingExternalSession: true,
        pendingExternalSessionAt: 10_000,
        model: "gpt-5.6-sol",
      },
    }));

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: {
        harness: "codex",
        model: "gpt-5.6-sol",
        targetSessionId: "expired-pending-session",
      },
    }))).rejects.toThrow("session_runtime_unobserved");
  });

  test("harness alone filters an exact session without requiring model evidence", async () => {
    const harness = createResolver();
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "native-endpoint", sessionId: "native-session", metadata: { alive: true },
    }));
    const resolved = await harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { harness: "codex", targetSessionId: "native-session" },
    }));
    expect(resolved?.id).toBe("native-endpoint");
    const mismatch = await harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { harness: "claude", targetSessionId: "native-session" },
    }));
    expect(mismatch).toBeUndefined();
    expect(harness.isolatedInvocations).toHaveLength(0);
  });

  test("fails closed when an exact existing session is unobserved or mismatched", async () => {
    const harness = createResolver();
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "unobserved-endpoint",
      sessionId: "unobserved-session",
      metadata: { alive: true },
    }));
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "mismatched-endpoint",
      sessionId: "mismatched-session",
      metadata: {
        alive: true,
        observedRuntime: { harness: "codex", model: "gpt-5.6-terra" },
      },
    }));

    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { harness: "codex", model: "gpt-5.6-sol", targetSessionId: "unobserved-session" },
    }))).rejects.toThrow("session_runtime_unobserved");
    await expect(harness.resolver.resolveLocalEndpointForInvocation(testInvocation({
      execution: { harness: "codex", model: "gpt-5.6-sol", targetSessionId: "mismatched-session" },
    }))).rejects.toThrow("session_runtime_mismatch");
  });
});
