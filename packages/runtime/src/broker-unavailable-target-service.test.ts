import { describe, expect, test } from "bun:test";

import type {
  AgentDefinition,
  AgentEndpoint,
  NodeDefinition,
  ScoutDispatchUnavailableTarget,
} from "@openscout/protocol";

import { BrokerUnavailableTargetService, localEndpointCanReceive, localEndpointSupportsQueue } from "./broker-unavailable-target-service.js";
import { evaluateBrokerAvailability } from "./broker-endpoint-selection.js";
import { createRuntimeRegistrySnapshot } from "./registry.js";

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
    capabilities: ["chat", "invoke", "deliver"],
    wakePolicy: "manual",
    homeNodeId: "node-local",
    authorityNodeId: "node-local",
    advertiseScope: "local",
    ...input,
  };
}

function endpoint(input: Partial<AgentEndpoint> = {}): AgentEndpoint {
  return {
    id: "endpoint-1",
    agentId: "agent-1",
    nodeId: "node-local",
    harness: "codex",
    transport: "tmux",
    state: "offline",
    sessionId: "session-1",
    projectRoot: "/repo",
    metadata: {},
    ...input,
  };
}

function node(input: Partial<NodeDefinition> = {}): NodeDefinition {
  return {
    id: "node-peer",
    meshId: "openscout",
    name: "Peer",
    hostName: "peer.local",
    advertiseScope: "mesh",
    brokerUrl: "http://peer.local:41411",
    capabilities: ["broker"],
    registeredAt: 1_000,
    lastSeenAt: 2_000,
    ...input,
  };
}

function createService(input: {
  remoteIssue?: ScoutDispatchUnavailableTarget | null;
  now?: number;
} = {}) {
  const remoteCalls: Array<{
    agent: AgentDefinition;
    authorityNode: NodeDefinition | undefined;
  }> = [];
  const service = new BrokerUnavailableTargetService({
    nodeId: "node-local",
    describeRemoteAuthorityIssue: (targetAgent, authorityNode) => {
      remoteCalls.push({ agent: targetAgent, authorityNode });
      return input.remoteIssue ?? null;
    },
    now: () => input.now ?? 10_000,
  });
  return { service, remoteCalls };
}

describe("broker unavailable target service", () => {
  test("reports superseded local session references as not attachable", () => {
    const target = agent();
    const staleEndpoint = endpoint({
      state: "idle",
      metadata: {
        staleLocalRegistration: true,
        replacedByAgentId: "agent-new",
      },
    });
    const snapshot = createRuntimeRegistrySnapshot({
      agents: { [target.id]: target },
      endpoints: { [staleEndpoint.id]: staleEndpoint },
    });
    const { service } = createService();

    const issue = service.describe(snapshot, target, "session-old");

    expect(issue).toEqual(expect.objectContaining({
      agentId: "agent-1",
      reason: "session_reference_not_attachable",
      endpointState: "online",
      transport: "tmux",
      projectRoot: "/repo",
    }));
    expect(issue?.detail).toContain("superseded local registration");
    expect(issue?.detail).toContain("agent-new");
  });

  test("reports retired agents and manual-wake offline agents", () => {
    const retired = agent({
      id: "retired",
      displayName: "Retired Agent",
      metadata: { retiredFromFleet: true },
    });
    const manual = agent({ id: "manual", displayName: "Manual Agent" });
    const manualEndpoint = endpoint({
      id: "manual-endpoint",
      agentId: "manual",
      state: "offline",
      projectRoot: "/manual",
    });
    const snapshot = createRuntimeRegistrySnapshot({
      agents: {
        retired,
        manual,
      },
      endpoints: {
        [manualEndpoint.id]: manualEndpoint,
      },
    });
    const { service } = createService();

    expect(service.describe(snapshot, retired)).toEqual(expect.objectContaining({
      agentId: "retired",
      reason: "retired",
      endpointState: "unknown",
    }));
    expect(service.describe(snapshot, manual)).toEqual(expect.objectContaining({
      agentId: "manual",
      reason: "manual_wake_required",
      endpointState: "offline",
      projectRoot: "/manual",
    }));
  });

  test("does not report manual-wake issues for online or direct managed sessions", () => {
    const online = agent({ id: "online" });
    const managed = agent({ id: "managed" });
    const snapshot = createRuntimeRegistrySnapshot({
      agents: {
        online,
        managed,
      },
      endpoints: {
        online: endpoint({
          id: "online",
          agentId: "online",
          state: "idle",
        }),
        managed: endpoint({
          id: "managed",
          agentId: "managed",
          transport: "codex_app_server",
          state: "offline",
          metadata: {
            source: "local-session",
            managedByScout: true,
          },
        }),
      },
    });
    const { service } = createService();

    expect(service.describe(snapshot, online)).toBeNull();
    expect(service.describe(snapshot, managed)).not.toBeNull();
    const verified = new BrokerUnavailableTargetService({ nodeId: "node-local",
      describeRemoteAuthorityIssue: () => null,
      verifiedLaunchRoute: () => ({ projectRoot: "/repo", harness: "codex" }),
    });
    expect(verified.describe(snapshot, managed)).toBeNull();
  });

  test("delegates remote authority issues and builds unavailable envelopes", () => {
    const remote = agent({
      id: "remote",
      displayName: "Remote Agent",
      authorityNodeId: "node-peer",
    });
    const remoteIssue: ScoutDispatchUnavailableTarget = {
      agentId: "remote",
      displayName: "Remote Agent",
      reason: "unknown",
      detail: "peer unavailable",
      wakePolicy: "manual",
      endpointState: "unknown",
      transport: null,
      projectRoot: null,
    };
    const snapshot = createRuntimeRegistrySnapshot({
      agents: { remote },
      nodes: { "node-peer": node() },
    });
    const { service, remoteCalls } = createService({ remoteIssue, now: 12_345 });

    expect(service.describe(snapshot, remote)?.detail).toContain("peer unavailable");
    expect(remoteCalls.length).toBeGreaterThan(0);
    expect(service.buildEnvelope("@remote", remoteIssue)).toEqual({
      kind: "unavailable",
      askedLabel: "@remote",
      detail: "peer unavailable",
      candidates: [],
      target: remoteIssue,
      dispatchedAt: 12_345,
      dispatcherNodeId: "node-local",
    });
  });
});


describe("availability admission table", () => {
  const launcher = { projectRoot: "/repo", harness: "codex" as const };
  const cases = [
    { name: "offline remote with reachable authority", endpoint: endpoint(), state: "gone" },
    { name: "missing transport", endpoint: endpoint({ state: "idle", transport: "local_socket" }), state: "gone" },
    { name: "busy without queue", endpoint: endpoint({ state: "active" }), state: "gone" },
    { name: "busy with verified queue", endpoint: endpoint({ state: "active" }), queueSupported: true, state: "ready" },
    { name: "valid launcher", endpoint: endpoint(), launchRoute: launcher, state: "can_start" },
    { name: "unavailable authority with launcher", endpoint: endpoint(), authorityAvailable: false, launchRoute: launcher, state: "gone" },
    { name: "retired", endpoint: endpoint({ state: "idle" }), agent: agent({ metadata: { retiredFromFleet: true } }), launchRoute: launcher, state: "gone" },
    { name: "stale endpoint", endpoint: endpoint({ state: "idle", metadata: { staleLocalRegistration: true } }), launchRoute: launcher, state: "gone" },
    { name: "failed liveness probe", endpoint: endpoint({ state: "idle" }), alive: false, state: "gone" },
    { name: "exact offline cannot launch", endpoint: endpoint(), targetSessionId: "session-1", launchRoute: launcher, state: "gone" },
    { name: "exact mismatched session cannot launch", endpoint: endpoint({ state: "idle" }), targetSessionId: "other", launchRoute: launcher, state: "gone" },
    { name: "exact offline resumes the same session", endpoint: endpoint(), targetSessionId: "session-1", launchRoute: { ...launcher, resumesSessionId: "session-1" }, state: "can_start" },
    { name: "exact offline cannot resume a different session", endpoint: endpoint(), targetSessionId: "session-1", launchRoute: { ...launcher, resumesSessionId: "other" }, state: "gone" },
    { name: "exact mismatched session cannot resume", endpoint: endpoint({ state: "idle" }), targetSessionId: "other", launchRoute: { ...launcher, resumesSessionId: "other" }, state: "gone" },
    { name: "exact live attachment", endpoint: endpoint({ state: "idle" }), targetSessionId: "session-1", state: "ready" },
    { name: "wake policy not launch evidence", endpoint: null, agent: agent({ wakePolicy: "on_demand" }), state: "gone" },
  ];
  for (const row of cases) test(row.name, () => {
    const result = evaluateBrokerAvailability({
      agent: agent(), authority: "node-peer", authorityAvailable: true,
      checkedAt: 123, ...row,
    });
    expect(result.state).toBe(row.state);
    expect(result.checkedAt).toBe(123);
    expect(result.authority).toBe("node-peer");
    if (row.state === "gone") {
      expect(result.supportedActions).toEqual([]);
      expect(result.selectedRoute).toBeNull();
    }
  });

  test("reachable remote authority alone is refused with remediation", () => {
    const target = agent({ authorityNodeId: "node-peer", wakePolicy: "on_demand" });
    const snapshot = createRuntimeRegistrySnapshot({ agents: { [target.id]: target },
      endpoints: { offline: endpoint() }, nodes: { "node-peer": node() } });
    const issue = createService().service.describe(snapshot, target);
    expect(issue?.detail).toContain('scout ask --project "/repo" --harness codex');
  });
});


test("remote receive evidence must be fresh; reachable authority is insufficient", () => {
  const target = agent({ authorityNodeId: "node-peer" });
  const { service } = createService({ now: 100_000 });
  for (const [lastSeenAt, expected] of [[99_000, "ready"], [1_000, "gone"], [undefined, "gone"]] as const) {
    const attachment = endpoint({ nodeId: "node-peer", state: "idle",
      metadata: { lastSeenAt } });
    const snapshot = createRuntimeRegistrySnapshot({
      agents: { [target.id]: target }, endpoints: { attachment },
      nodes: { "node-peer": node() },
    });
    expect(service.evaluate(snapshot, target).state).toBe(expected);
  }
});

test("exact continuation selects the requested endpoint rather than the home endpoint", () => {
  const target = agent();
  const snapshot = createRuntimeRegistrySnapshot({ agents: { [target.id]: target },
    endpoints: {
      home: endpoint({ id: "home", preferred: true, state: "idle", sessionId: "home-session" }),
      exact: endpoint({ id: "exact", state: "offline", sessionId: "exact-session" }),
    } });
  const service = new BrokerUnavailableTargetService({ nodeId: "node-local",
    describeRemoteAuthorityIssue: () => null,
    verifiedLaunchRoute: () => ({ projectRoot: "/repo", harness: "codex" }),
  });
  expect(service.evaluate(snapshot, target).state).toBe("ready");
  expect(service.evaluate(snapshot, target, "exact-session").state).toBe("gone");
});

test("exact continuation of a per-turn session launches only a resume of that session", () => {
  const target = agent();
  const snapshot = createRuntimeRegistrySnapshot({ agents: { [target.id]: target },
    endpoints: {
      home: endpoint({ id: "home", preferred: true, state: "idle", sessionId: "home-session" }),
      exact: endpoint({ id: "exact", transport: "codex_app_server", state: "idle", sessionId: "exact-session",
        metadata: { threadId: "thread-exact" } }),
    } });
  const resuming = (resumesSessionId: string) => new BrokerUnavailableTargetService({ nodeId: "node-local",
    describeRemoteAuthorityIssue: () => null,
    isEndpointAlive: () => false,
    verifiedLaunchRoute: () => ({ projectRoot: "/repo", harness: "codex", resumesSessionId }),
  });
  const resumed = resuming("thread-exact").evaluate(snapshot, target, "exact-session");
  expect(resumed.state).toBe("can_start");
  expect(resumed.reason).toBe("verified_session_resume");
  expect(resuming("home-session").evaluate(snapshot, target, "exact-session").state).toBe("gone");
});


describe("transport-owned availability evidence", () => {
  test("external HTTP and registered mailboxes do not use local process probes", () => {
    const unexpectedProbe = () => { throw new Error("not a local process"); };
    for (const transport of ["http", "devin_cloud_cli", "mcp_poll"] as const) {
      const candidate = endpoint({ transport, state: transport === "mcp_poll" ? "registered" : "idle", metadata: { externalSession: true } });
      expect(localEndpointCanReceive(candidate, unexpectedProbe)).toBe(true);
      expect(classify(candidate).state).toBe("ready");
      for (const state of ["offline", "stopped", "failed"] as const) {
        expect(localEndpointCanReceive({ ...candidate, state }, unexpectedProbe)).toBe(false);
      }
    }
    function classify(candidate: AgentEndpoint) {
      return evaluateBrokerAvailability({ endpoint: candidate, authority: "node-local", authorityAvailable: true,
        checkedAt: 100, alive: localEndpointCanReceive(candidate, unexpectedProbe), targetSessionId: candidate.sessionId! });
    }
  });
  test("live local owner queues admit busy work but dead processes remain unavailable", () => {
    const candidate = endpoint({ transport: "grok_acp", state: "active" });
    expect(localEndpointSupportsQueue(candidate)).toBe(true);
    for (const alive of [false, true]) {
      const availability = evaluateBrokerAvailability({ endpoint: candidate, authority: "node-local", authorityAvailable: true,
        checkedAt: 100, alive: localEndpointCanReceive(candidate, () => alive), queueSupported: localEndpointSupportsQueue(candidate), targetSessionId: candidate.sessionId! });
      expect(availability.state).toBe(alive ? "ready" : "gone");
      if (alive) expect(availability.supportedActions).toEqual(["queue"]);
    }
    for (const address of [undefined, "https://provider.invalid/a2a"]) {
      expect(localEndpointSupportsQueue(endpoint({ transport: "http", address, metadata: { externalSession: true } }))).toBe(false);
    }
  });
});


test("direct queue safety preserves independent external mailbox and bridge queues", () => {
  const denyDirect = () => false;
  for (const transport of ["grok_acp", "codex_app_server"] as const) {
    expect(localEndpointSupportsQueue(endpoint({ transport }), denyDirect)).toBe(false);
  }
  expect(localEndpointSupportsQueue(endpoint({ transport: "codex_app_server" }))).toBe(false);
  for (const candidate of [
    endpoint({ transport: "mcp_poll", metadata: { externalSession: true } }),
    endpoint({ transport: "pairing_bridge" }),
    endpoint({ transport: "http", state: "active", address: "https://provider.invalid/a2a" }),
  ]) {
    expect(localEndpointSupportsQueue(candidate, denyDirect)).toBe(true);
  }
});


test("only physical local Codex liveness overrides a historical offline latch", () => {
  const candidate = endpoint({ id: "codex", transport: "codex_app_server", state: "offline", sessionId: "scout-session",
    metadata: { threadId: "native-thread", lastSeenAt: 100, lastError: "Selected model is at capacity" } });
  for (const remote of [false, true]) for (const alive of [false, true]) {
    const target = agent({ authorityNodeId: remote ? "node-remote" : "node-local" });
    const service = new BrokerUnavailableTargetService({ nodeId: "node-local", describeRemoteAuthorityIssue: () => null,
      isEndpointAlive: () => alive, now: () => 101 });
    const snapshot = createRuntimeRegistrySnapshot({ agents: { [target.id]: target }, endpoints: { codex: candidate } });
    for (const selector of [undefined, "codex", "scout-session", "native-thread"]) {
      expect(service.evaluate(snapshot, target, selector).state).toBe(!remote && alive ? "ready" : "gone");
    }
  }
});


test("retired endpoints never reach a liveness probe or recover via a launcher", () => {
  const target = agent();
  const service = new BrokerUnavailableTargetService({ nodeId: "node-local", describeRemoteAuthorityIssue: () => null,
    isEndpointAlive: () => { throw new Error("retired endpoint must not be probed"); },
    verifiedLaunchRoute: () => ({ projectRoot: "/repo", harness: "codex" }) });
  for (const transport of ["codex_app_server", "tmux"] as const) {
    for (const retirement of [
      { state: "offline", metadata: { replacedByAgentId: "replacement" } },
      { state: "offline", metadata: { staleLocalRegistration: true } },
      { state: "idle", metadata: { staleLocalRegistration: true } },
      { state: "active", metadata: { staleLocalRegistration: true } },
    ] as const) {
      const candidate = endpoint({ transport, ...retirement });
      const snapshot = createRuntimeRegistrySnapshot({ agents: { [target.id]: target }, endpoints: { old: candidate } });
      for (const selector of [undefined, candidate.id, candidate.sessionId!]) {
        expect(service.evaluate(snapshot, target, selector)).toEqual(expect.objectContaining({
          state: "gone", reason: "stale_registration", supportedActions: [], selectedRoute: null,
        }));
      }
    }
  }
});
