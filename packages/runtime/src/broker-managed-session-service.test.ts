import { describe, expect, test } from "bun:test";

import type {
  AgentDefinition,
  AgentEndpoint,
} from "@openscout/protocol";

import { createInMemoryControlRuntime } from "./broker.js";
import { BrokerManagedSessionService } from "./broker-managed-session-service.js";
import type { PairingSession } from "./pairing-session-agents.js";

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
    wakePolicy: "manual",
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
    transport: "pairing_bridge",
    state: "idle",
    metadata: {},
    ...input,
  };
}

function testPairingSession(input: Partial<PairingSession> = {}): PairingSession {
  return {
    id: "session-1",
    name: "Repo Session",
    adapterType: "codex",
    status: "active",
    cwd: "/tmp/repo",
    model: "gpt-5",
    ...input,
  };
}

function createHarness(input: {
  sessions?: Record<string, PairingSession>;
  snapshotSessions?: Record<string, PairingSession | null>;
  now?: number;
} = {}) {
  const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });
  const sessions = new Map(Object.entries(input.sessions ?? {}));
  const snapshotSessions = new Map(Object.entries(input.snapshotSessions ?? {}));
  const persistedEndpoints: AgentEndpoint[] = [];
  const upsertedAgents: AgentDefinition[] = [];
  const ensuredThreads: string[] = [];
  const shutDownEndpointIds: string[] = [];
  let idCounter = 0;

  const service = new BrokerManagedSessionService({
    nodeId: "node-1",
    runtime,
    createId(prefix) {
      idCounter += 1;
      return `${prefix}-${idCounter}`;
    },
    isInactiveLocalAgent: (agent) => agent?.metadata?.staleLocalRegistration === true,
    async upsertAgent(agent) {
      upsertedAgents.push(agent);
      await runtime.upsertAgent(agent);
    },
    async persistEndpoint(endpoint) {
      persistedEndpoints.push(endpoint);
      await runtime.upsertEndpoint(endpoint);
    },
    async findPairingSession(externalSessionId) {
      return sessions.get(externalSessionId) ?? null;
    },
    async getPairingSessionSnapshot(externalSessionId) {
      if (!snapshotSessions.has(externalSessionId)) {
        return null;
      }
      const session = snapshotSessions.get(externalSessionId);
      return session ? { session } : null;
    },
    async ensurePairingSessionForCodexThread({ threadId, cwd, name }) {
      ensuredThreads.push(threadId);
      return testPairingSession({
        id: `pairing-${threadId.slice(0, 8)}`,
        name: name ?? "Codex",
        cwd,
      });
    },
    async shutdownLocalSessionEndpoint(endpoint) {
      shutDownEndpointIds.push(endpoint.id);
    },
    now: () => input.now ?? 10_000,
  });

  return {
    runtime,
    service,
    persistedEndpoints,
    upsertedAgents,
    ensuredThreads,
    shutDownEndpointIds,
  };
}

describe("BrokerManagedSessionService", () => {
  test("attaches pairing sessions idempotently and reuses the managed endpoint", async () => {
    const firstSession = testPairingSession({ id: "session-1", name: "First Session" });
    const secondSession = testPairingSession({ id: "session-2", name: "Second Session", model: "gpt-5.1" });
    const harness = createHarness({
      sessions: {
        "session-1": firstSession,
        "session-2": secondSession,
      },
    });

    const first = await harness.service.attachManagedPairingSession({
      externalSessionId: "session-1",
      alias: "@repo",
      displayName: "Repo",
    });
    const second = await harness.service.attachManagedPairingSession({
      externalSessionId: "session-2",
      alias: "@repo",
      displayName: "Repo Updated",
    });
    const snapshot = harness.runtime.snapshot();

    expect(second.agentId).toBe(first.agentId);
    expect(second.endpointId).toBe(first.endpointId);
    expect(Object.values(snapshot.agents).filter((agent) => agent.selector === "@repo")).toHaveLength(1);
    expect(Object.values(snapshot.endpoints).filter((endpoint) => endpoint.agentId === first.agentId)).toHaveLength(1);
    expect(snapshot.agents[first.agentId]?.displayName).toBe("Repo Updated");
    expect(snapshot.endpoints[first.endpointId]?.sessionId).toBe("session-2");
    expect(snapshot.endpoints[first.endpointId]?.metadata).toEqual(expect.objectContaining({
      externalSessionId: "session-2",
      pairingSessionId: "session-2",
      model: "gpt-5.1",
    }));
  });

  test("attaches and detaches Codex local sessions as pairing-backed managed identities", async () => {
    const harness = createHarness();

    const attached = await harness.service.attachManagedLocalSession({
      externalSessionId: "019d9762-19f7-7792-8962-90d924ce7faa",
      transport: "codex_app_server",
      cwd: "/tmp/codex-here",
      alias: "@codex-here",
      displayName: "Codex Here",
    });
    const detached = await harness.service.detachManagedLocalSession({
      alias: "@codex-here",
    });
    const snapshot = harness.runtime.snapshot();

    expect(attached.selector).toBe("@codex-here");
    expect(attached.sessionId).toBe("pairing-019d9762");
    expect(harness.ensuredThreads).toEqual(["019d9762-19f7-7792-8962-90d924ce7faa"]);
    expect(detached).toEqual({
      agentId: attached.agentId,
      endpointId: attached.endpointId,
      detached: true,
    });
    expect(snapshot.agents[attached.agentId]?.selector).toBe("@codex-here");
    expect(snapshot.endpoints[attached.endpointId]).toEqual(expect.objectContaining({
      transport: "pairing_bridge",
      state: "offline",
      sessionId: "pairing-019d9762",
      metadata: expect.objectContaining({
        source: "local-session",
        externalSessionId: "019d9762-19f7-7792-8962-90d924ce7faa",
        pairingSessionId: "pairing-019d9762",
        lastError: "local session detached",
        lastFailedAt: 10_000,
      }),
    }));
    expect(harness.shutDownEndpointIds).toEqual([]);
  });

  test("attaches a live terminal harness to its own tmux pane without a pairing session", async () => {
    const harness = createHarness();

    const attached = await harness.service.attachManagedLocalSession({
      externalSessionId: "",
      transport: "tmux",
      cwd: "/tmp/grok-here",
      liveTerminal: {
        harness: "grok",
        pid: 85103,
        tty: "ttys009",
        surface: { backend: "tmux", pane: "%12", session: "work" },
      },
    });
    const snapshot = harness.runtime.snapshot();

    expect(attached.selector).toBe("@grok-grok-here");
    expect(attached.sessionId).toBe("work");
    expect(harness.ensuredThreads).toEqual([]);
    expect(snapshot.agents[attached.agentId]).toEqual(expect.objectContaining({
      displayName: "Grok (grok-here)",
      wakePolicy: "manual",
    }));
    expect(snapshot.endpoints[attached.endpointId]).toEqual(expect.objectContaining({
      transport: "tmux",
      harness: "grok",
      sessionId: "work",
      pane: "%12",
      metadata: expect.objectContaining({
        source: "local-session",
        managedByScout: true,
        attachedLive: true,
        livePid: 85103,
        liveTty: "ttys009",
        tmuxPane: "%12",
      }),
    }));

    const detached = await harness.service.detachManagedLocalSession({ alias: "@grok-grok-here" });
    expect(detached.endpointId).toBe(attached.endpointId);
    expect(harness.runtime.snapshot().endpoints[attached.endpointId]?.state).toBe("offline");
  });

  test("attaches a live harness in a Ghostty terminal by surface id", async () => {
    const harness = createHarness();

    const attached = await harness.service.attachManagedLocalSession({
      externalSessionId: "",
      transport: "ghostty",
      cwd: "/tmp/repo",
      alias: "@tchaikovsky",
      liveTerminal: {
        harness: "grok",
        pid: 85103,
        tty: "ttys013",
        surface: { backend: "ghostty", terminalId: "D0B1E807-7BA3-4786-A0EB-18EDEF5CA895" },
      },
    });

    expect(attached.selector).toBe("@tchaikovsky");
    expect(harness.ensuredThreads).toEqual([]);
    expect(harness.runtime.snapshot().endpoints[attached.endpointId]).toEqual(expect.objectContaining({
      transport: "ghostty",
      harness: "grok",
      sessionId: "D0B1E807-7BA3-4786-A0EB-18EDEF5CA895",
      metadata: expect.objectContaining({
        attachedLive: true,
        livePid: 85103,
        liveTty: "ttys013",
        ghosttyTerminalId: "D0B1E807-7BA3-4786-A0EB-18EDEF5CA895",
      }),
    }));
  });

  test("rejects a surface that does not match the transport", async () => {
    const harness = createHarness();
    await expect(harness.service.attachManagedLocalSession({
      externalSessionId: "",
      transport: "tmux",
      cwd: "/tmp/repo",
      liveTerminal: {
        harness: "grok",
        pid: 85103,
        tty: "ttys013",
        surface: { backend: "ghostty", terminalId: "D0B1E807" },
      },
    })).rejects.toThrow("tmux attach needs liveTerminal");
  });

  test("attaches and detaches an Antigravity conversation directly via antigravity_acp", async () => {
    const harness = createHarness();
    const attached = await harness.service.attachManagedLocalSession({
      externalSessionId: "agy-conv-1234",
      transport: "antigravity_acp",
      cwd: "/tmp/demo-project",
    });

    expect(attached.selector).toBe("@antigravity-demo-project");
    expect(attached.sessionId).toBe("agy-conv-1234");
    const snapshot = harness.runtime.snapshot();
    expect(snapshot.agents[attached.agentId]).toEqual(expect.objectContaining({
      displayName: "Antigravity (demo-project)",
      selector: "@antigravity-demo-project",
    }));
    expect(snapshot.endpoints[attached.endpointId]).toEqual(expect.objectContaining({
      harness: "antigravity",
      transport: "antigravity_acp",
      sessionId: "agy-conv-1234",
      state: "idle",
      metadata: expect.objectContaining({
        externalSessionId: "agy-conv-1234",
        managedByScout: true,
        source: "local-session",
      }),
    }));

    const detached = await harness.service.detachManagedLocalSession({ agentId: attached.agentId });
    expect(detached.detached).toBe(true);
    expect(harness.runtime.snapshot().endpoints[attached.endpointId]?.state).toBe("offline");
  });

  test("rejects a tmux attach without a live pane", async () => {
    const harness = createHarness();
    await expect(harness.service.attachManagedLocalSession({
      externalSessionId: "",
      transport: "tmux",
      cwd: "/tmp/grok-here",
    })).rejects.toThrow("tmux attach needs liveTerminal");
  });

  test("reconciles managed pairing endpoints and retires legacy pairing registrations", async () => {
    const harness = createHarness({
      snapshotSessions: {
        "session-active": testPairingSession({ id: "session-active", name: "Active Session", status: "idle" }),
        "session-missing": null,
      },
      now: 25_000,
    });
    await harness.runtime.upsertAgent(testAgent({
      id: "managed-agent",
      displayName: "Managed Agent",
      handle: "managed",
    }));
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "endpoint-managed",
      agentId: "managed-agent",
      sessionId: "session-active",
      metadata: {
        source: "pairing-session",
        managedByScout: true,
        externalSessionId: "session-active",
        stalePairingSession: true,
      },
    }));
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "endpoint-missing",
      agentId: "missing-agent",
      sessionId: "session-missing",
      metadata: {
        source: "pairing-session",
        managedByScout: true,
        externalSessionId: "session-missing",
      },
    }));
    await harness.runtime.upsertAgent(testAgent({
      id: "legacy-agent",
      metadata: { source: "pairing-session" },
    }));
    await harness.runtime.upsertEndpoint(testEndpoint({
      id: "endpoint-legacy",
      agentId: "legacy-agent",
      metadata: { source: "pairing-session" },
    }));

    await harness.service.reconcileManagedPairingEndpoints();
    await harness.service.retireLegacyPairingSessionAgents();
    const snapshot = harness.runtime.snapshot();

    expect(snapshot.endpoints["endpoint-managed"]).toEqual(expect.objectContaining({
      state: "idle",
      sessionId: "session-active",
      metadata: expect.objectContaining({
        stalePairingSession: false,
        sessionName: "Active Session",
      }),
    }));
    expect(snapshot.endpoints["endpoint-missing"]).toEqual(expect.objectContaining({
      state: "offline",
      metadata: expect.objectContaining({
        stalePairingSession: true,
        lastError: "pairing session session-missing is offline or unreachable",
        lastFailedAt: 25_000,
      }),
    }));
    expect(snapshot.agents["legacy-agent"]?.metadata).toEqual(expect.objectContaining({
      legacyAutoSync: true,
      retiredFromFleet: true,
      stalePairingSession: true,
      retiredAt: 25_000,
    }));
    expect(snapshot.endpoints["endpoint-legacy"]).toEqual(expect.objectContaining({
      state: "offline",
      metadata: expect.objectContaining({
        legacyAutoSync: true,
        retiredFromFleet: true,
        stalePairingSession: true,
        lastError: "legacy pairing auto-sync retired; re-attach through Scout to manage this session",
        lastFailedAt: 25_000,
      }),
    }));
  });
});
