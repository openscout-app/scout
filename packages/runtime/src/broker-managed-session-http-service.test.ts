import { describe, expect, test } from "bun:test";

import type { AgentEndpoint } from "@openscout/protocol";

import { createRuntimeRegistrySnapshot, type RuntimeRegistrySnapshot } from "./registry.js";
import {
  BrokerManagedSessionHttpService,
} from "./broker-managed-session-http-service.js";
import type { PairingSession } from "./pairing-session-agents.js";
import type { ManagedLocalSessionTransport } from "./broker-managed-session-helpers.js";

function endpoint(input: Partial<AgentEndpoint> = {}): AgentEndpoint {
  return {
    id: "endpoint-1",
    agentId: "agent-1",
    nodeId: "node-local",
    harness: "codex",
    transport: "codex_app_server",
    state: "waiting",
    sessionId: "old-session",
    projectRoot: "/repo",
    metadata: {},
    ...input,
  };
}

function pairingSession(input: Partial<PairingSession> = {}): PairingSession {
  return {
    id: "session-abcdef123456",
    name: "Codex Work",
    adapterType: "codex",
    status: "active",
    cwd: "/repo",
    model: "gpt-5",
    providerMeta: {},
    ...input,
  };
}

function createHarness(input: {
  snapshot?: RuntimeRegistrySnapshot;
  sessions?: PairingSession[];
  processCwd?: string;
  onlineSession?: { externalSessionId?: string | null; metadata?: Record<string, unknown> };
} = {}) {
  const snapshot = input.snapshot ?? createRuntimeRegistrySnapshot();
  const persistedEndpoints: AgentEndpoint[] = [];
  const attachPairingInputs: unknown[] = [];
  const detachPairingInputs: unknown[] = [];
  const attachLocalInputs: unknown[] = [];
  const detachLocalInputs: unknown[] = [];
  const ensuredEndpoints: AgentEndpoint[] = [];

  const service = new BrokerManagedSessionHttpService({
    async startRexSession() { throw new Error("unexpected Rex launch"); },
    nodeId: "node-local",
    runtimeSnapshot: () => snapshot,
    processCwd: () => input.processCwd ?? "/default-cwd",
    listPairingSessions: async () => input.sessions ?? [],
    async attachManagedPairingSession(nextInput) {
      attachPairingInputs.push(nextInput);
      return {
        agentId: nextInput.agentId ?? "agent-pairing",
        selector: nextInput.alias ?? "@pairing",
        endpointId: "endpoint-pairing",
      };
    },
    async detachManagedPairingSession(nextInput) {
      detachPairingInputs.push(nextInput);
      return {
        agentId: nextInput.agentId ?? "agent-pairing",
        endpointId: "endpoint-pairing",
        detached: true,
      };
    },
    async attachManagedLocalSession(nextInput) {
      attachLocalInputs.push(nextInput);
      return {
        agentId: nextInput.agentId ?? "agent-local",
        selector: nextInput.alias ?? "@local",
        endpointId: "endpoint-local",
        sessionId: nextInput.externalSessionId,
      };
    },
    async detachManagedLocalSession(nextInput) {
      detachLocalInputs.push(nextInput);
      return {
        agentId: nextInput.agentId ?? "agent-local",
        endpointId: "endpoint-local",
        detached: true,
      };
    },
    async ensureLocalSessionEndpointOnline(nextEndpoint) {
      ensuredEndpoints.push(nextEndpoint);
      return input.onlineSession ?? { externalSessionId: "session-new" };
    },
    async persistEndpoint(nextEndpoint) {
      persistedEndpoints.push(nextEndpoint);
      snapshot.endpoints[nextEndpoint.id] = nextEndpoint;
    },
    now: () => 1_000,
  });

  return {
    attachLocalInputs,
    attachPairingInputs,
    detachLocalInputs,
    detachPairingInputs,
    ensuredEndpoints,
    persistedEndpoints,
    service,
    snapshot,
  };
}

describe("BrokerManagedSessionHttpService", () => {
  test("lists pairing sessions as attach candidates", async () => {
    const harness = createHarness({
      sessions: [pairingSession()],
    });

    await expect(harness.service.listPairingSessionCandidates()).resolves.toEqual([
      expect.objectContaining({
        externalSessionId: "session-abcdef123456",
        name: "Codex Work",
        adapterType: "codex",
        status: "active",
        cwd: "/repo",
        model: "gpt-5",
        suggestedSelector: expect.stringMatching(/^@/),
      }),
    ]);
  });

  test("normalizes pairing and local attach route bodies before delegating", async () => {
    const harness = createHarness({ processCwd: "/route-cwd" });

    await expect(harness.service.attachPairingSession({
      externalSessionId: undefined,
      agentId: "agent-pairing",
      alias: "@pair",
    })).resolves.toEqual({
      ok: true,
      agentId: "agent-pairing",
      selector: "@pair",
      endpointId: "endpoint-pairing",
    });
    await expect(harness.service.attachLocalSession({
      externalSessionId: "session-local",
      agentId: "agent-local",
    })).resolves.toEqual({
      ok: true,
      agentId: "agent-local",
      selector: "@local",
      endpointId: "endpoint-local",
      sessionId: "session-local",
    });

    expect(harness.attachPairingInputs).toEqual([
      {
        externalSessionId: "",
        agentId: "agent-pairing",
        alias: "@pair",
        displayName: undefined,
      },
    ]);
    expect(harness.attachLocalInputs).toEqual([
      {
        externalSessionId: "session-local",
        transport: "codex_app_server" satisfies ManagedLocalSessionTransport,
        cwd: "/route-cwd",
        projectRoot: undefined,
        agentId: "agent-local",
        alias: undefined,
        displayName: undefined,
      },
    ]);
  });

  test("ensures a ready local session endpoint and persists refreshed metadata", async () => {
    const currentEndpoint = endpoint({
      metadata: {
        lastError: "previous failure",
        lastFailedAt: 500,
        custom: "kept",
      },
    });
    const harness = createHarness({
      snapshot: createRuntimeRegistrySnapshot({
        endpoints: { [currentEndpoint.id]: currentEndpoint },
      }),
    });

    await expect(harness.service.ensureLocalSession({
      endpointId: currentEndpoint.id,
    })).resolves.toEqual({
      ok: true,
      endpoint: expect.objectContaining({
        id: currentEndpoint.id,
        state: "idle",
        sessionId: "old-session",
        metadata: {
          custom: "kept",
          externalSessionId: "session-new",
          threadId: "session-new",
          lastEnsuredAt: 1_000,
        },
      }),
      externalSessionId: "session-new",
    });
    expect(harness.ensuredEndpoints).toEqual([currentEndpoint]);
    expect(harness.persistedEndpoints).toHaveLength(1);
  });

  test("keeps a provisional Codex provider session pending after warmup", async () => {
    const currentEndpoint = endpoint({
      metadata: {
        sessionBacked: true,
        pendingExternalSession: true,
      },
    });
    const harness = createHarness({
      snapshot: createRuntimeRegistrySnapshot({
        endpoints: { [currentEndpoint.id]: currentEndpoint },
      }),
      onlineSession: { externalSessionId: null },
    });

    const result = await harness.service.ensureLocalSession({
      endpointId: currentEndpoint.id,
    });

    expect(result.externalSessionId).toBeNull();
    expect(result.endpoint.metadata).toEqual(expect.objectContaining({
      sessionBacked: true,
      pendingExternalSession: true,
      lastEnsuredAt: 1_000,
    }));
    expect(result.endpoint.metadata?.externalSessionId).toBeUndefined();
    expect(result.endpoint.metadata?.threadId).toBeUndefined();
  });

  test("ensures by agent id and preserves Claude thread metadata", async () => {
    const currentEndpoint = endpoint({
      id: "endpoint-claude",
      agentId: "agent-claude",
      harness: "claude",
      transport: "claude_stream_json",
      state: "active",
      metadata: { threadId: "thread-old" },
    });
    const harness = createHarness({
      snapshot: createRuntimeRegistrySnapshot({
        endpoints: { [currentEndpoint.id]: currentEndpoint },
      }),
    });

    const result = await harness.service.ensureLocalSession({
      agentId: "agent-claude",
    });

    expect(result.endpoint).toEqual(expect.objectContaining({
      id: "endpoint-claude",
      state: "active",
      sessionId: "old-session",
      metadata: expect.objectContaining({
        externalSessionId: "session-new",
        threadId: "thread-old",
      }),
    }));
  });

  test("rejects missing or unsupported local session endpoints", async () => {
    const unsupported = endpoint({
      id: "endpoint-pairing",
      transport: "pairing_bridge",
    });
    const harness = createHarness({
      snapshot: createRuntimeRegistrySnapshot({
        endpoints: { [unsupported.id]: unsupported },
      }),
    });

    await expect(harness.service.ensureLocalSession({
      endpointId: "missing",
    })).rejects.toThrow("local session endpoint not found");
    await expect(harness.service.ensureLocalSession({
      endpointId: unsupported.id,
    })).rejects.toThrow("endpoint endpoint-pairing does not use a local session transport");
  });
});
