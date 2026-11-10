import { describe, expect, test } from "bun:test";

import type {
  ActorIdentity,
  AgentDefinition,
  AgentEndpoint,
} from "@openscout/protocol";

import {
  BrokerLocalAgentSyncService,
  clearStaleLocalEndpointMetadata,
  coreAgentPreferenceRank,
  resolveConfiguredCoreAgentId,
  preserveMissingTmuxEndpointState,
  staleLocalAgentReplacementId,
  staleLocalRegistrationMetadata,
} from "./broker-local-agent-sync-service.js";
import type { LocalAgentBinding } from "./local-agents.js";
import type { RelayAgentOverrides } from "./broker-local-agent-sync-service.js";
import type { RuntimeSnapshot } from "./scout-dispatcher.js";

function actor(input: Partial<ActorIdentity> = {}): ActorIdentity {
  return {
    id: "agent.main",
    kind: "agent",
    displayName: "Agent Main",
    handle: "agent-main",
    labels: [],
    metadata: {},
    ...input,
  };
}

function agent(input: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "agent.main",
    kind: "agent",
    definitionId: "worker",
    displayName: "Agent Main",
    handle: "agent-main",
    labels: [],
    metadata: {},
    selector: "@agent-main",
    defaultSelector: "@agent-main",
    agentClass: "general",
    capabilities: ["chat", "invoke", "deliver"],
    wakePolicy: "on_demand",
    homeNodeId: "node-1",
    authorityNodeId: "node-1",
    advertiseScope: "local",
    ...input,
  };
}

function endpoint(input: Partial<AgentEndpoint> = {}): AgentEndpoint {
  return {
    id: "endpoint-new",
    agentId: "agent.main",
    nodeId: "node-1",
    harness: "codex",
    transport: "codex_app_server",
    state: "idle",
    sessionId: "session-new",
    metadata: {},
    ...input,
  };
}

function binding(input: {
  actor?: ActorIdentity;
  agent?: AgentDefinition;
  endpoint?: AgentEndpoint;
} = {}): LocalAgentBinding {
  const nextAgent = input.agent ?? agent();
  return {
    actor: input.actor ?? actor({ id: nextAgent.id }),
    agent: nextAgent,
    endpoint: input.endpoint ?? endpoint({ agentId: nextAgent.id }),
  };
}

function snapshot(input: {
  agents?: Record<string, AgentDefinition>;
  endpoints?: Record<string, AgentEndpoint>;
} = {}): RuntimeSnapshot {
  return {
    nodes: {},
    actors: {},
    agents: input.agents ?? {},
    endpoints: input.endpoints ?? {},
    conversations: {},
    bindings: {},
    messages: {},
    readCursors: {},
    invocations: {},
    flights: {},
    collaborationRecords: {},
  };
}

function createHarness(input: {
  snapshot?: RuntimeSnapshot;
  bindings?: LocalAgentBinding[];
  bindingBatches?: LocalAgentBinding[][];
  coreBindings?: LocalAgentBinding[];
  overrides?: RelayAgentOverrides;
  signatures?: Array<string | null>;
  configuredCoreAgentIds?: string[];
  aliveEndpointIds?: string[];
  aliveEndpointIdsAsync?: string[];
  aliveSessionIds?: string[];
  aliveSessionIdsAsync?: string[];
  disabledSyntheticEndpointIds?: string[];
} = {}) {
  const runtimeSnapshot = input.snapshot ?? snapshot();
  const persistedEndpoints: AgentEndpoint[] = [];
  const upsertedAgents: AgentDefinition[] = [];
  const upsertedActors: ActorIdentity[] = [];
  const loadCalls: Array<{ nodeId: string; ensureOnline?: boolean; agentIds?: string[] }> = [];
  const logs: string[] = [];
  let signatureIndex = 0;
  let clearGitBranchCacheCount = 0;
  let migrated = false;
  let retiredLegacyPairing = false;
  let reconciledManagedPairing = false;
  let reconciledStaleFlights = 0;
  let reconciledStaleDeliveries = 0;
  const aliveEndpointIds = new Set(input.aliveEndpointIds ?? []);
  const aliveEndpointIdsAsync = new Set(input.aliveEndpointIdsAsync ?? []);
  const aliveSessionIds = new Set(input.aliveSessionIds ?? []);
  const aliveSessionIdsAsync = new Set(input.aliveSessionIdsAsync ?? []);
  const endpointLivenessChecks: string[] = [];
  const asyncEndpointLivenessChecks: string[] = [];
  const sessionLivenessChecks: string[] = [];
  const asyncSessionLivenessChecks: string[] = [];
  const disabledSyntheticEndpointIds = new Set(input.disabledSyntheticEndpointIds ?? []);
  let bindingBatchIndex = 0;
  const service = new BrokerLocalAgentSyncService({
    nodeId: "node-1",
    configuredCoreAgentIds: input.configuredCoreAgentIds ?? [],
    runtime: {
      snapshot: () => runtimeSnapshot,
    },
    async registrySignature() {
      const signatures = input.signatures ?? ["sig-1"];
      return signatures[Math.min(signatureIndex++, signatures.length - 1)] ?? null;
    },
    async migrateRelayAgentKeys() {
      migrated = true;
    },
    async readRelayAgentOverrides() {
      return input.overrides ?? {};
    },
    async loadRegisteredLocalAgentBindings(nodeId, options = {}) {
      loadCalls.push({ nodeId, ...options });
      if (options.ensureOnline) {
        return input.coreBindings ?? [];
      }
      if (input.bindingBatches) {
        return input.bindingBatches[Math.min(bindingBatchIndex++, input.bindingBatches.length - 1)] ?? [];
      }
      return input.bindings ?? [];
    },
    clearGitBranchCache: () => {
      clearGitBranchCacheCount++;
    },
    isGeneratedLocalAgentMetadata: (metadata) => metadata?.generatedLocalAgent === true,
    isLocalAgentEndpointAlive: (candidate) => {
      endpointLivenessChecks.push(candidate.id);
      return aliveEndpointIds.has(candidate.id);
    },
    isLocalAgentEndpointAliveAsync: async (candidate) => {
      asyncEndpointLivenessChecks.push(candidate.id);
      return aliveEndpointIdsAsync.has(candidate.id);
    },
    isLocalAgentSessionAlive: (sessionId) => {
      sessionLivenessChecks.push(sessionId);
      return aliveSessionIds.has(sessionId);
    },
    isLocalAgentSessionAliveAsync: async (sessionId) => {
      asyncSessionLivenessChecks.push(sessionId);
      return aliveSessionIdsAsync.has(sessionId);
    },
    shouldDisableGeneratedCodexEndpoint: (candidate) => disabledSyntheticEndpointIds.has(candidate.id),
    async upsertActor(nextActor) {
      upsertedActors.push(nextActor);
      runtimeSnapshot.actors[nextActor.id] = nextActor;
    },
    async upsertAgent(nextAgent) {
      upsertedAgents.push(nextAgent);
      runtimeSnapshot.agents[nextAgent.id] = nextAgent;
    },
    async persistEndpoint(nextEndpoint) {
      persistedEndpoints.push(nextEndpoint);
      runtimeSnapshot.endpoints[nextEndpoint.id] = nextEndpoint;
    },
    async retireLegacyPairingSessionAgents() {
      retiredLegacyPairing = true;
    },
    async reconcileManagedPairingEndpoints() {
      reconciledManagedPairing = true;
    },
    async reconcileStaleWorkingFlights() {
      reconciledStaleFlights++;
    },
    async reconcileStaleLocalDeliveries() {
      reconciledStaleDeliveries++;
    },
    log: (message) => logs.push(message),
    now: () => 10_000,
  });

  return {
    get clearGitBranchCacheCount() {
      return clearGitBranchCacheCount;
    },
    get migrated() {
      return migrated;
    },
    get reconciledManagedPairing() {
      return reconciledManagedPairing;
    },
    get reconciledStaleDeliveries() {
      return reconciledStaleDeliveries;
    },
    get reconciledStaleFlights() {
      return reconciledStaleFlights;
    },
    get retiredLegacyPairing() {
      return retiredLegacyPairing;
    },
    loadCalls,
    logs,
    endpointLivenessChecks,
    asyncEndpointLivenessChecks,
    sessionLivenessChecks,
    asyncSessionLivenessChecks,
    persistedEndpoints,
    runtimeSnapshot,
    service,
    upsertedActors,
    upsertedAgents,
  };
}

describe("broker local agent sync helpers", () => {
  test("resolves replacement and configured core agent ids predictably", () => {
    const active = new Map([
      ["worker", ["worker.feature.codex", "worker.main.codex", "worker.master.codex"]],
    ]);

    expect(staleLocalAgentReplacementId("worker", active)).toBe("worker.main.codex");
    expect(staleLocalAgentReplacementId("missing", active)).toBeNull();
    expect(coreAgentPreferenceRank("worker.main.codex")).toBeLessThan(coreAgentPreferenceRank("worker.master.codex"));
    expect(resolveConfiguredCoreAgentId("worker", {
      "worker.feature.codex": { definitionId: "worker", projectRoot: "/repo/feature" },
      "worker.main.codex": { definitionId: "worker", projectRoot: "/repo/main" },
    })).toBe("worker.main.codex");
    expect(resolveConfiguredCoreAgentId("exact.id", {
      "exact.id": { definitionId: "worker", projectRoot: "/repo" },
    })).toBe("exact.id");
    expect(staleLocalRegistrationMetadata({ existing: true }, 123, "replacement")).toEqual({
      existing: true,
      staleLocalRegistration: true,
      staleAt: 123,
      replacedByAgentId: "replacement",
    });
    expect(clearStaleLocalEndpointMetadata({
      staleLocalRegistration: true,
      staleAt: 123,
      replacedByAgentId: "replacement",
      keep: "value",
    })).toEqual({ keep: "value" });
  });

  test("preserves a missing tmux endpoint diagnostic across registry rematerialization", () => {
    const waiting = endpoint({
      id: "endpoint-missing",
      transport: "tmux",
      state: "waiting",
      sessionId: "relay-missing-claude",
      metadata: { source: "relay-agent-registry", tmuxSession: "relay-missing-claude" },
    });
    const offline = {
      ...waiting,
      state: "offline" as const,
      metadata: {
        ...waiting.metadata,
        lastError: "tmux session missing: relay-missing-claude",
        lastFailedAt: 9_000,
      },
    };

    expect(preserveMissingTmuxEndpointState(offline, waiting)).toEqual(offline);
    expect(preserveMissingTmuxEndpointState(
      { ...offline, sessionId: "relay-previous", metadata: { ...offline.metadata, lastError: "tmux session missing: relay-previous" } },
      waiting,
    )).toBe(waiting);
  });
});

describe("BrokerLocalAgentSyncService", () => {
  test("syncs current bindings and reconciles generated local endpoint state", async () => {
    const active = binding();
    const oldAgent = agent({
      id: "agent.old",
      displayName: "Old Agent",
      definitionId: "worker",
      metadata: { generatedLocalAgent: true },
    });
    const supersededTransport = endpoint({
      id: "endpoint-tmux-old",
      agentId: active.agent.id,
      transport: "tmux",
      sessionId: "old-tmux",
      state: "active",
      metadata: {},
    });
    const staleEndpoint = endpoint({
      id: "endpoint-old",
      agentId: oldAgent.id,
      transport: "tmux",
      sessionId: "stale-tmux",
      state: "active",
      metadata: { generatedLocalAgent: true },
    });
    const missingTmux = endpoint({
      id: "endpoint-missing-tmux",
      agentId: "agent.tmux",
      transport: "tmux",
      sessionId: "missing-session",
      state: "active",
      metadata: {},
    });
    const synthetic = endpoint({
      id: "endpoint-synthetic",
      agentId: "agent.synthetic",
      transport: "codex_app_server",
      state: "idle",
      metadata: {},
    });
    const harness = createHarness({
      snapshot: snapshot({
        agents: {
          [active.agent.id]: active.agent,
          [oldAgent.id]: oldAgent,
          "agent.tmux": agent({ id: "agent.tmux", definitionId: "tmux" }),
          "agent.synthetic": agent({ id: "agent.synthetic", definitionId: "synthetic" }),
        },
        endpoints: {
          [supersededTransport.id]: supersededTransport,
          [staleEndpoint.id]: staleEndpoint,
          [missingTmux.id]: missingTmux,
          [synthetic.id]: synthetic,
        },
      }),
      bindings: [active],
      disabledSyntheticEndpointIds: ["endpoint-synthetic"],
    });

    await harness.service.sync();

    expect(harness.upsertedAgents).toContainEqual(active.agent);
    expect(harness.persistedEndpoints).toContainEqual(active.endpoint);
    expect(harness.upsertedAgents).toContainEqual(expect.objectContaining({
      id: "agent.old",
      metadata: expect.objectContaining({
        staleLocalRegistration: true,
        staleAt: 10_000,
        replacedByAgentId: "agent.main",
      }),
    }));
    expect(harness.persistedEndpoints).toContainEqual(expect.objectContaining({
      id: "endpoint-old",
      state: "offline",
      metadata: expect.objectContaining({
        staleLocalRegistration: true,
        replacedByAgentId: "agent.main",
        lastError: "superseded local agent registration replaced by current setup",
        lastFailedAt: 10_000,
      }),
    }));
    expect(harness.persistedEndpoints).toContainEqual(expect.objectContaining({
      id: "endpoint-tmux-old",
      state: "offline",
      metadata: expect.objectContaining({
        supersededLocalTransport: true,
        replacedByEndpointId: "endpoint-new",
        replacedByTransport: "codex_app_server",
      }),
    }));
    expect(harness.persistedEndpoints).toContainEqual(expect.objectContaining({
      id: "endpoint-missing-tmux",
      state: "offline",
      metadata: expect.objectContaining({
        lastError: "tmux session missing: missing-session",
        lastFailedAt: 10_000,
      }),
    }));
    expect(harness.persistedEndpoints).toContainEqual(expect.objectContaining({
      id: "endpoint-synthetic",
      state: "offline",
      metadata: expect.objectContaining({
        disabledReason: "synthetic_executor_disabled",
      }),
    }));
    expect(harness.reconciledStaleFlights).toBe(1);
    expect(harness.reconciledStaleDeliveries).toBe(1);
  });

  test("keeps live tmux broker-only cards when only fresh async liveness can see the session", async () => {
    const cardAgent = agent({
      id: "card-active",
      definitionId: "card-active",
      displayName: "Card Active",
      metadata: {
        generatedLocalAgent: true,
        source: "relay-agent-registry",
        cardLifecycle: { kind: "one_time" },
      },
    });
    const cardEndpoint = endpoint({
      id: "endpoint-card-active-tmux",
      agentId: cardAgent.id,
      transport: "tmux",
      sessionId: "relay-card-active-claude",
      state: "active",
      metadata: {
        generatedLocalAgent: true,
        source: "relay-agent-registry",
        tmuxSession: "relay-card-active-claude",
      },
    });
    const harness = createHarness({
      snapshot: snapshot({
        agents: { [cardAgent.id]: cardAgent },
        endpoints: { [cardEndpoint.id]: cardEndpoint },
      }),
      bindings: [],
      aliveEndpointIds: [],
      aliveSessionIds: [],
      aliveEndpointIdsAsync: [cardEndpoint.id],
      aliveSessionIdsAsync: ["relay-card-active-claude"],
    });

    await harness.service.sync();

    expect(harness.upsertedAgents).not.toContainEqual(expect.objectContaining({
      id: cardAgent.id,
      metadata: expect.objectContaining({ staleLocalRegistration: true }),
    }));
    expect(harness.persistedEndpoints).not.toContainEqual(expect.objectContaining({
      id: cardEndpoint.id,
      state: "offline",
    }));
    expect(harness.runtimeSnapshot.agents[cardAgent.id]?.metadata?.staleLocalRegistration).toBeUndefined();
    expect(harness.runtimeSnapshot.endpoints[cardEndpoint.id]?.state).toBe("active");
  });

  test("does not toggle a known-missing registered tmux endpoint back to waiting", async () => {
    const waitingEndpoint = endpoint({
      id: "endpoint-missing-registered-tmux",
      transport: "tmux",
      state: "waiting",
      sessionId: "relay-missing-registered-claude",
      metadata: {
        source: "relay-agent-registry",
        tmuxSession: "relay-missing-registered-claude",
      },
    });
    const offlineEndpoint = {
      ...waitingEndpoint,
      state: "offline" as const,
      metadata: {
        ...waitingEndpoint.metadata,
        lastError: "tmux session missing: relay-missing-registered-claude",
        lastFailedAt: 9_000,
      },
    };
    const currentBinding = binding({ endpoint: waitingEndpoint });
    const harness = createHarness({
      snapshot: snapshot({
        agents: { [currentBinding.agent.id]: currentBinding.agent },
        endpoints: { [offlineEndpoint.id]: offlineEndpoint },
      }),
      bindings: [currentBinding],
    });

    await harness.service.sync();

    expect(harness.persistedEndpoints).toEqual([offlineEndpoint]);
    expect(harness.sessionLivenessChecks).toEqual([]);
    expect(harness.asyncSessionLivenessChecks).toEqual([]);
  });

  test("does not re-probe archived or remote tmux endpoint history", async () => {
    const archivedAgent = agent({
      id: "agent.archived",
      definitionId: "archived",
      metadata: { generatedLocalAgent: true },
    });
    const archived = endpoint({
      id: "endpoint-archived",
      agentId: archivedAgent.id,
      transport: "tmux",
      sessionId: "archived-session",
      state: "offline",
      metadata: {
        generatedLocalAgent: true,
        staleLocalRegistration: true,
        staleAt: 9_000,
      },
    });
    const remote = endpoint({
      id: "endpoint-remote",
      agentId: "agent.remote",
      nodeId: "node-2",
      transport: "tmux",
      sessionId: "remote-session",
      state: "active",
    });
    const harness = createHarness({
      snapshot: snapshot({
        agents: {
          [archivedAgent.id]: archivedAgent,
          "agent.remote": agent({
            id: "agent.remote",
            definitionId: "remote",
            homeNodeId: "node-2",
            authorityNodeId: "node-2",
          }),
        },
        endpoints: {
          [archived.id]: archived,
          [remote.id]: remote,
        },
      }),
      bindings: [],
    });

    await harness.service.sync();

    expect(harness.endpointLivenessChecks).toEqual([]);
    expect(harness.asyncEndpointLivenessChecks).toEqual([]);
    expect(harness.sessionLivenessChecks).toEqual([]);
    expect(harness.asyncSessionLivenessChecks).toEqual([]);
    expect(harness.persistedEndpoints).toEqual([]);
  });

  test("archives the previous harness endpoint when a local agent switches runtimes", async () => {
    const active = binding({
      endpoint: endpoint({
        id: "endpoint-kimi",
        harness: "kimi",
        transport: "kimi_acp",
        sessionId: "relay-kimi",
      }),
    });
    const previous = endpoint({
      id: "endpoint-claude",
      agentId: active.agent.id,
      harness: "claude",
      transport: "tmux",
      sessionId: "legacy-claude",
      state: "waiting",
    });
    const harness = createHarness({
      snapshot: snapshot({
        agents: { [active.agent.id]: active.agent },
        endpoints: { [previous.id]: previous },
      }),
      bindings: [active],
    });

    await harness.service.sync();

    expect(harness.persistedEndpoints).toContainEqual(expect.objectContaining({
      id: "endpoint-claude",
      state: "offline",
      metadata: expect.objectContaining({
        supersededLocalTransport: true,
        replacedByEndpointId: "endpoint-kimi",
        replacedByTransport: "kimi_acp",
      }),
    }));
  });

  test("syncIfChanged refreshes once per changed registry signature", async () => {
    const harness = createHarness({
      signatures: ["sig-1", "sig-1", "sig-1", "sig-1"],
      bindings: [binding()],
    });

    await harness.service.syncIfChanged("test");
    await harness.service.syncIfChanged("test");

    expect(harness.clearGitBranchCacheCount).toBe(1);
    expect(harness.loadCalls.filter((call) => !call.ensureOnline)).toHaveLength(1);
    expect(harness.logs).toContain("[openscout-runtime] local agent registry changed (test); refreshing registered agents");
  });

  test("sync retries when the registry changes during a refresh", async () => {
    const ranger = binding({
      agent: agent({ id: "ranger.test-node", definitionId: "ranger", displayName: "Ranger" }),
      endpoint: endpoint({ id: "endpoint-ranger", agentId: "ranger.test-node" }),
    });
    const harness = createHarness({
      signatures: ["sig-empty", "sig-updated", "sig-updated", "sig-updated"],
      bindingBatches: [[], [ranger]],
    });

    await harness.service.sync();

    expect(harness.loadCalls.filter((call) => !call.ensureOnline)).toHaveLength(2);
    expect(harness.upsertedAgents).toContainEqual(expect.objectContaining({ id: "ranger.test-node" }));
    expect(harness.logs).toContain("[openscout-runtime] local agent registry changed during sync; refreshing registered agents again");
  });

  test("bootstrap migrates registry keys, reconciles managed pairing, and warms configured core agents", async () => {
    const core = binding({
      agent: agent({ id: "worker.main.codex", definitionId: "worker" }),
      endpoint: endpoint({ id: "core-endpoint", agentId: "worker.main.codex" }),
    });
    const harness = createHarness({
      configuredCoreAgentIds: ["worker"],
      bindings: [],
      coreBindings: [core],
      overrides: {
        "worker.feature.codex": { definitionId: "worker", projectRoot: "/repo/feature" },
        "worker.main.codex": { definitionId: "worker", projectRoot: "/repo/main" },
      },
    });

    await harness.service.bootstrap();

    expect(harness.migrated).toBe(true);
    expect(harness.retiredLegacyPairing).toBe(true);
    expect(harness.reconciledManagedPairing).toBe(true);
    expect(harness.loadCalls).toContainEqual({
      nodeId: "node-1",
      ensureOnline: true,
      agentIds: ["worker.main.codex"],
    });
    expect(harness.upsertedAgents).toContainEqual(core.agent);
    expect(harness.persistedEndpoints).toContainEqual(core.endpoint);
  });

  function relayTmuxEndpoint(input: Partial<AgentEndpoint> = {}): AgentEndpoint {
    return endpoint({
      id: "endpoint.session-card.ws.node-1.tmux",
      agentId: "session-card.ws.node",
      harness: "claude",
      transport: "tmux",
      state: "idle",
      sessionId: "session-card",
      metadata: {
        source: "relay-agent-registry",
        agentName: "session-card",
        tmuxSession: "session-card",
        runtimeInstanceId: "session-card",
        terminalSurface: { backend: "tmux", sessionName: "session-card", paneId: "session-card" },
      },
      ...input,
    });
  }

  function observedMetadata(sessionId: string, observedAt: number, extra: Record<string, unknown> = {}) {
    return {
      externalSessionId: sessionId,
      threadId: null,
      nativeSessionId: null,
      pendingExternalSession: false,
      observedSessionId: sessionId,
      observedSessionEvidence: {
        source: "claude-session-record",
        tmuxSession: "session-card",
        tmuxPane: "%1",
        pid: 4242,
        observedAt,
        ...extra,
      },
      observedRuntimeAt: observedAt,
    };
  }

  test("gives a relay tmux binding the observation of the card that runs in its session", async () => {
    const card = endpoint({
      id: "endpoint.session-card.node-1.tmux",
      agentId: "session-card",
      harness: "claude",
      transport: "tmux",
      sessionId: "session-card",
      metadata: { source: "scout-cardless-session", cardless: true, ...observedMetadata("claude-session-1", 2_000) },
    });
    const relay = binding({
      agent: agent({ id: "session-card.ws.node", definitionId: "session-card" }),
      endpoint: relayTmuxEndpoint(),
    });
    const harness = createHarness({
      snapshot: snapshot({ endpoints: { [card.id]: card } }),
      bindings: [relay],
      aliveSessionIds: ["session-card"],
    });

    await harness.service.sync();

    const persisted = harness.persistedEndpoints.find((candidate) => candidate.id === relay.endpoint.id);
    expect(persisted?.metadata?.observedSessionId).toBe("claude-session-1");
    expect(persisted?.metadata?.observedSessionEvidence).toMatchObject({
      source: "claude-session-record",
      tmuxSession: "session-card",
      mirroredFromEndpointId: card.id,
    });
    expect(persisted?.metadata?.externalSessionId).toBeUndefined();
    expect(persisted?.metadata?.runtimeInstanceId).toBe("session-card");
  });

  test("keeps a relay tmux binding's own observation when the registry rebuilds it", async () => {
    const previous = relayTmuxEndpoint({
      metadata: {
        ...relayTmuxEndpoint().metadata,
        observedSessionId: "claude-session-1",
        observedSessionEvidence: observedMetadata("claude-session-1", 2_000).observedSessionEvidence,
      },
    });
    const relay = binding({
      agent: agent({ id: "session-card.ws.node", definitionId: "session-card" }),
      endpoint: relayTmuxEndpoint(),
    });
    const harness = createHarness({
      snapshot: snapshot({ endpoints: { [previous.id]: previous } }),
      bindings: [relay],
      aliveSessionIds: ["session-card"],
    });

    await harness.service.sync();

    const persisted = harness.persistedEndpoints.find((candidate) => candidate.id === relay.endpoint.id);
    expect(persisted?.metadata?.observedSessionId).toBe("claude-session-1");
    expect(persisted?.metadata?.observedSessionEvidence).not.toHaveProperty("mirroredFromEndpointId");
  });

  test("leaves a relay tmux binding without identity when nothing observed its session", async () => {
    const pendingCard = endpoint({
      id: "endpoint.session-card.node-1.tmux",
      agentId: "session-card",
      harness: "claude",
      transport: "tmux",
      sessionId: "session-card",
      metadata: { source: "scout-cardless-session", cardless: true, pendingExternalSession: true },
    });
    const relay = binding({
      agent: agent({ id: "session-card.ws.node", definitionId: "session-card" }),
      endpoint: relayTmuxEndpoint(),
    });
    const harness = createHarness({
      snapshot: snapshot({ endpoints: { [pendingCard.id]: pendingCard } }),
      bindings: [relay],
      aliveSessionIds: ["session-card"],
    });

    await harness.service.sync();

    expect(harness.persistedEndpoints.find((candidate) => candidate.id === relay.endpoint.id)).toEqual(relay.endpoint);
  });

  test("warms a core relay tmux agent with its known observation", async () => {
    const previous = relayTmuxEndpoint({
      metadata: {
        ...relayTmuxEndpoint().metadata,
        observedSessionId: "claude-session-1",
        observedSessionEvidence: observedMetadata("claude-session-1", 2_000).observedSessionEvidence,
      },
    });
    const core = binding({
      agent: agent({ id: "session-card.ws.node", definitionId: "session-card" }),
      endpoint: relayTmuxEndpoint(),
    });
    const harness = createHarness({
      snapshot: snapshot({ endpoints: { [previous.id]: previous } }),
      configuredCoreAgentIds: ["session-card"],
      coreBindings: [core],
    });

    await harness.service.ensureCoreLocalAgentsOnline();

    expect(harness.persistedEndpoints.at(-1)?.metadata?.observedSessionId).toBe("claude-session-1");
  });
});
