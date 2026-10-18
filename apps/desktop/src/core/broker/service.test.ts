import { afterEach, describe, expect, test } from "bun:test";
import { isIdempotentMessageRetry } from "../../../../../packages/runtime/src/broker-message-idempotency.ts";
import type { MessageRecord } from "@openscout/protocol";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  writeOpenScoutSettings,
  writeProjectConfig,
  writeRelayAgentOverrides,
} from "@openscout/runtime/setup";
import {
  namedChannelNaturalKey,
  stableChannelId,
  systemChannelNaturalKey,
  type ScoutCapabilityMatrixSnapshot,
  type ScoutDeliverRequest,
} from "@openscout/protocol";
import {
  registerActiveScoutBrokerService,
  type ActiveScoutBrokerService,
} from "@openscout/runtime/broker-api";
import { createRuntimeRegistrySnapshot } from "@openscout/runtime/registry";
import { SUPPORTED_LOCAL_AGENT_HARNESSES } from "@openscout/runtime/local-agents";

import {
  askScoutAgentById,
  askScoutQuestion,
  askScoutSessionById,
  buildScoutLabelBrief,
  buildScoutLabelFeed,
  deliverScoutAsk,
  replyToScoutMessage,
  isReusableBrokerRegisteredTargetAgent,
  listScoutAgents,
  loadScoutBrokerContext,
  loadScoutBrokerContextResult,
  parseScoutHarness,
  parseScoutLocalHarness,
  readScoutCapabilityMatrix,
  readScoutBrokerHealth,
  resolveScoutBrokerUrl,
  resolveHumanAskSenderName,
  resolveScoutMatchParticipantId,
  resolveScoutSenderId,
  scoutBrokerAgentRegistrationFromConfig,
  scoutConversationIdForChannel,
  sendScoutMessage,
  sendScoutMessageToAgentIds,
  updateScoutWorkItem,
  waitForScoutFlight,
  watchScoutMessages,
} from "./service.ts";
import { scoutAskHandler } from "./ask.ts";
import { runAskCommand } from "../../cli/commands/ask.ts";
import { createScoutCommandContext } from "../../cli/context.ts";
import type { ScoutAskCommand } from "./ask-types.ts";

const originalHome = process.env.HOME;
const originalOpenScoutHome = process.env.OPENSCOUT_HOME;
const originalSupportDirectory = process.env.OPENSCOUT_SUPPORT_DIRECTORY;
const originalControlHome = process.env.OPENSCOUT_CONTROL_HOME;
const originalRelayHub = process.env.OPENSCOUT_RELAY_HUB;
const originalBrokerUrl = process.env.OPENSCOUT_BROKER_URL;
const originalBrokerSocketPath = process.env.OPENSCOUT_BROKER_SOCKET_PATH;
const originalBrokerHost = process.env.OPENSCOUT_BROKER_HOST;
const originalBrokerPort = process.env.OPENSCOUT_BROKER_PORT;
const originalNetworkDiscovery =
  process.env.OPENSCOUT_NETWORK_DISCOVERY_ENABLED;
const originalSkipUserProjectHints =
  process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS;
const originalOpenScoutAgent = process.env.OPENSCOUT_AGENT;
const originalOpenScoutOperatorName = process.env.OPENSCOUT_OPERATOR_NAME;
const originalFetch = globalThis.fetch;
const testDirectories = new Set<string>();

describe("relay-agent broker registration", () => {
  test("marks configured cards for shared web projection", () => {
    const registration = scoutBrokerAgentRegistrationFromConfig({
      agentId: "ocean-minimax.main.ocean-iron",
      definitionId: "ocean-minimax",
      displayName: "Ocean Minimax",
      projectName: "Scout Ocean Agent",
      projectRoot: "/home/exedev/scout-ocean-agent",
      projectConfigPath: null,
      source: "manual",
      registrationKind: "configured",
      startedAt: 1,
      launchArgs: ["--no-extensions"],
      capabilities: ["chat", "invoke", "deliver"],
      defaultHarness: "pi",
      harnessProfiles: {},
      instance: {
        id: "ocean-minimax.main.ocean-iron",
        selector: "@ocean-minimax.main.node:ocean-iron",
        defaultSelector: "@ocean-minimax",
        nodeQualifier: "ocean-iron",
        workspaceQualifier: "main",
        branch: "main",
        isDefault: true,
      },
      runtime: {
        cwd: "/home/exedev/scout-ocean-agent",
        harness: "pi",
        transport: "pi_rpc",
        sessionId: "relay-ocean-minimax-main-ocean-iron-pi",
        wakePolicy: "on_demand",
      },
    }, "ocean-iron-openscout");

    expect(registration.agent.metadata).toMatchObject({
      brokerRegistered: true,
      source: "relay-agent-registry",
    });
  });

  test("migrates legacy cards before reusing them", () => {
    const base = {
      id: "ocean-minimax.main.ocean-iron",
      kind: "agent" as const,
      definitionId: "ocean-minimax",
      displayName: "Ocean Minimax",
      agentClass: "general" as const,
      capabilities: ["chat" as const],
      wakePolicy: "on_demand" as const,
      homeNodeId: "ocean-iron-openscout",
      authorityNodeId: "ocean-iron-openscout",
      advertiseScope: "local" as const,
    };

    expect(isReusableBrokerRegisteredTargetAgent({
      ...base,
      metadata: { source: "relay-agent-registry" },
    })).toBe(false);
    expect(isReusableBrokerRegisteredTargetAgent({
      ...base,
      metadata: { brokerRegistered: true },
    })).toBe(true);
    expect(isReusableBrokerRegisteredTargetAgent({
      ...base,
      metadata: { source: "broker" },
    })).toBe(true);
  });
});

afterEach(() => {
  process.env.HOME = originalHome;
  if (originalOpenScoutHome === undefined) {
    delete process.env.OPENSCOUT_HOME;
  } else {
    process.env.OPENSCOUT_HOME = originalOpenScoutHome;
  }
  if (originalSupportDirectory === undefined) {
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
  } else {
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = originalSupportDirectory;
  }
  if (originalControlHome === undefined) {
    delete process.env.OPENSCOUT_CONTROL_HOME;
  } else {
    process.env.OPENSCOUT_CONTROL_HOME = originalControlHome;
  }
  if (originalRelayHub === undefined) {
    delete process.env.OPENSCOUT_RELAY_HUB;
  } else {
    process.env.OPENSCOUT_RELAY_HUB = originalRelayHub;
  }
  if (originalBrokerUrl === undefined) {
    delete process.env.OPENSCOUT_BROKER_URL;
  } else {
    process.env.OPENSCOUT_BROKER_URL = originalBrokerUrl;
  }
  if (originalBrokerSocketPath === undefined) {
    delete process.env.OPENSCOUT_BROKER_SOCKET_PATH;
  } else {
    process.env.OPENSCOUT_BROKER_SOCKET_PATH = originalBrokerSocketPath;
  }
  if (originalBrokerHost === undefined) {
    delete process.env.OPENSCOUT_BROKER_HOST;
  } else {
    process.env.OPENSCOUT_BROKER_HOST = originalBrokerHost;
  }
  if (originalBrokerPort === undefined) {
    delete process.env.OPENSCOUT_BROKER_PORT;
  } else {
    process.env.OPENSCOUT_BROKER_PORT = originalBrokerPort;
  }
  if (originalNetworkDiscovery === undefined) {
    delete process.env.OPENSCOUT_NETWORK_DISCOVERY_ENABLED;
  } else {
    process.env.OPENSCOUT_NETWORK_DISCOVERY_ENABLED =
      originalNetworkDiscovery;
  }
  if (originalSkipUserProjectHints === undefined) {
    delete process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS;
  } else {
    process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS =
      originalSkipUserProjectHints;
  }
  if (originalOpenScoutAgent === undefined) {
    delete process.env.OPENSCOUT_AGENT;
  } else {
    process.env.OPENSCOUT_AGENT = originalOpenScoutAgent;
  }
  if (originalOpenScoutOperatorName === undefined) {
    delete process.env.OPENSCOUT_OPERATOR_NAME;
  } else {
    process.env.OPENSCOUT_OPERATOR_NAME = originalOpenScoutOperatorName;
  }
  registerActiveScoutBrokerService(null);
  globalThis.fetch = originalFetch;
  for (const directory of testDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  testDirectories.clear();
});

describe("listScoutAgents", () => {
  test("adds authoritative machine/project fields and filters by machine, not cwd or agent name", async () => {
    const home = useIsolatedOpenScoutHome();
    await writeOpenScoutSettings({ discovery: { workspaceRoots: [], includeCurrentRepo: false } });
    await writeRelayAgentOverrides({
      "configured.main": { agentId: "configured.main", projectRoot: "/configured/project" },
    });
    const mini = { id: "node-mini", name: "arts-mini", hostName: "arts-mini.local" };
    const remote = { id: "node-archie", name: "archie", hostName: "archie.local" };
    const otherMini = { id: "node-other-mini", name: "arts-mini", hostName: "arts-mini.local" };
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/health") return jsonResponse({ ok: true, nodeId: mini.id });
      if (path === "/v1/node") return jsonResponse(mini);
      if (path === "/v1/aliases") return jsonResponse({ bindings: [] });
      if (path === "/v1/snapshot") return jsonResponse({
        nodes: { [mini.id]: mini, [remote.id]: remote, [otherMini.id]: otherMini },
        agents: {
          "remote-agent": { id: "remote-agent", homeNodeId: remote.id, metadata: { projectRoot: "/remote/project" } },
          "other-mini-agent": { id: "other-mini-agent", homeNodeId: otherMini.id },
        },
        endpoints: {
          "remote-ep": { id: "remote-ep", agentId: "remote-agent", nodeId: mini.id, state: "active", projectRoot: "/wrong/project" },
          "local-ep": { id: "local-ep", agentId: "local-agent", nodeId: mini.id, state: "idle", projectRoot: "/local/project", cwd: "/pane/cwd" },
        },
        messages: { orphan: { id: "orphan", actorId: "unlocated-agent", createdAt: 1_800_000_000_000 } },
      });
      return jsonResponse({}, 404);
    }) as typeof fetch;
    const all = await listScoutAgents({ currentDirectory: home });
    expect(all.find((entry) => entry.agentId === "remote-agent")).toMatchObject({ nodeId: remote.id, nodeName: "archie", projectRoot: "/remote/project" });
    expect(all.find((entry) => entry.agentId === "local-agent")).toMatchObject({ nodeId: mini.id, nodeName: "arts-mini", projectRoot: "/local/project" });
    const configured = all.find((entry) => entry.registrationKind === "configured");
    expect(configured).toMatchObject({ nodeId: mini.id, projectRoot: "/configured/project" });
    expect(all.find((entry) => entry.agentId === "unlocated-agent")).toMatchObject({ nodeId: null, nodeName: null, projectRoot: null });
    const local = await listScoutAgents({ currentDirectory: home, machine: "mini" });
    expect(local.map((entry) => entry.agentId).sort()).toEqual([configured!.agentId, "local-agent", "other-mini-agent"].sort());
    expect((await listScoutAgents({ currentDirectory: home, machine: mini.id })).map((entry) => entry.agentId).sort()).toEqual([configured!.agentId, "local-agent"].sort());
    expect((await listScoutAgents({ currentDirectory: home, machine: "archie.local" })).map((entry) => entry.agentId)).toEqual(["remote-agent"]);
    await expect(listScoutAgents({ currentDirectory: home, machine: "missing" })).rejects.toThrow("Unknown machine");
  });

  test("hides stale broker registrations and includes discovered local projects", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const talkieRoot = join(workspaceRoot, "talkie");
    mkdirSync(join(talkieRoot, ".git"), { recursive: true });
    writeFileSync(join(talkieRoot, "AGENTS.md"), "# talkie\n", "utf8");

    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [workspaceRoot],
        includeCurrentRepo: false,
      },
    });

    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {
            "talkie.old.mini": {
              id: "talkie.old.mini",
              kind: "agent",
              definitionId: "talkie",
              displayName: "Talkie",
              metadata: {
                staleLocalRegistration: true,
                projectRoot: "/tmp/old-talkie",
              },
            },
          },
          endpoints: {
            "endpoint-talkie-old": {
              id: "endpoint-talkie-old",
              agentId: "talkie.old.mini",
              nodeId: "node-1",
              harness: "codex",
              transport: "codex_app_server",
              state: "offline",
              metadata: { staleLocalRegistration: true },
            },
          },
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const entries = await listScoutAgents({ currentDirectory: workspaceRoot });

    expect(entries.some((entry) => entry.agentId === "talkie.old.mini")).toBe(false);
    expect(entries.some((entry) => (
      entry.agentId.startsWith("talkie.")
      && entry.registrationKind === "discovered"
      && entry.state === "discovered"
    ))).toBe(true);
    expect(entries.find((entry) => entry.registrationKind === "discovered")).toMatchObject({ nodeId: "node-1", projectRoot: talkieRoot });
  });
});

describe("readScoutCapabilityMatrix", () => {
  test("reads the broker capability snapshot without importing runtime internals", async () => {
    process.env.OPENSCOUT_BROKER_URL = "http://broker.test";
    const capabilitySnapshot: ScoutCapabilityMatrixSnapshot = {
      generatedAt: 123,
      scope: { machineId: "node-1" },
      sources: [{
        kind: "harness_adapter",
        id: "codex",
        capturedAt: 123,
      }],
      capabilities: [],
      warnings: [],
    };
    const service: ActiveScoutBrokerService = {
      baseUrl: "http://broker.test",
      readHealth: async () => ({
        ok: true,
        nodeId: "node-1",
        meshId: "mesh-1",
        counts: {
          nodes: 1,
          actors: 0,
          agents: 0,
          conversations: 0,
          messages: 0,
          flights: 0,
          collaborationRecords: 0,
        },
      }),
      readNode: async () => ({
        id: "node-1",
        meshId: "mesh-1",
        name: "node-1",
        advertiseScope: "local",
        registeredAt: 1,
        lastSeenAt: 1,
      }),
      readSnapshot: async () => createRuntimeRegistrySnapshot(),
      readCapabilities: async () => capabilitySnapshot,
      executeCommand: async () => ({ ok: true }),
    };
    registerActiveScoutBrokerService(service);

    await expect(readScoutCapabilityMatrix()).resolves.toEqual(capabilitySnapshot);
  });
});

describe("buildScoutLabelBrief", () => {
  test("aggregates flights and work items by label", () => {
    const snapshot = createRuntimeRegistrySnapshot({
      invocations: {
        "inv-1": {
          id: "inv-1",
          requesterId: "operator",
          requesterNodeId: "node-1",
          targetAgentId: "hudson.main",
          action: "consult",
          task: "review the bump",
          collaborationRecordId: "work-1",
          conversationId: "dm.operator.hudson",
          messageId: "msg-1",
          ensureAwake: true,
          stream: false,
          labels: ["release:0.2.66"],
          createdAt: 1_000,
        },
      },
      flights: {
        "flt-1": {
          id: "flt-1",
          invocationId: "inv-1",
          requesterId: "operator",
          targetAgentId: "hudson.main",
          state: "running",
          summary: "Running tests.",
          labels: ["release:0.2.66"],
          startedAt: 1_500,
        },
      },
      collaborationRecords: {
        "work-1": {
          id: "work-1",
          kind: "work_item",
          title: "Ship bump",
          state: "working",
          acceptanceState: "pending",
          createdById: "operator",
          ownerId: "hudson.main",
          nextMoveOwnerId: "hudson.main",
          conversationId: "dm.operator.hudson",
          labels: ["release:0.2.66"],
          createdAt: 900,
          updatedAt: 1_600,
        },
      },
    });

    const brief = buildScoutLabelBrief(snapshot, "release:0.2.66", 2_000);

    expect(brief.counts).toEqual({
      flights: 1,
      activeFlights: 1,
      workItems: 1,
    });
    expect(brief.activeFlights[0]?.id).toBe("flt-1");
    expect(brief.activeFlights[0]?.workId).toBe("work-1");
    expect(brief.workItems[0]?.id).toBe("work-1");
    expect(brief.participants).toEqual(["hudson.main", "operator"]);
    expect(brief.lastActivityAt).toBe(1_600);
  });
});

describe("buildScoutLabelFeed", () => {
  test("normalizes messages, invocations, flights, and work events by label", () => {
    const snapshot = createRuntimeRegistrySnapshot({
      messages: {
        "msg-1": {
          id: "msg-1",
          conversationId: "dm.operator.hudson",
          actorId: "operator",
          originNodeId: "node-1",
          class: "agent",
          body: "Please review the release.",
          visibility: "private",
          policy: "durable",
          createdAt: 1_000,
          metadata: {
            labels: ["release:0.2.66"],
            workId: "work-1",
          },
        },
      },
      invocations: {
        "inv-1": {
          id: "inv-1",
          requesterId: "operator",
          requesterNodeId: "node-1",
          targetAgentId: "hudson.main",
          action: "consult",
          task: "review the bump",
          collaborationRecordId: "work-1",
          conversationId: "dm.operator.hudson",
          messageId: "msg-1",
          ensureAwake: true,
          stream: false,
          labels: ["release:0.2.66"],
          createdAt: 1_100,
        },
      },
      flights: {
        "flt-1": {
          id: "flt-1",
          invocationId: "inv-1",
          requesterId: "operator",
          targetAgentId: "hudson.main",
          state: "running",
          summary: "Running tests.",
          startedAt: 1_200,
          labels: ["release:0.2.66"],
        },
      },
      collaborationRecords: {
        "work-1": {
          id: "work-1",
          kind: "work_item",
          title: "Ship bump",
          state: "working",
          acceptanceState: "pending",
          createdById: "operator",
          ownerId: "hudson.main",
          nextMoveOwnerId: "hudson.main",
          conversationId: "dm.operator.hudson",
          labels: ["release:0.2.66"],
          createdAt: 900,
          updatedAt: 1_400,
        },
      },
    });

    const feed = buildScoutLabelFeed(snapshot, "release:0.2.66", {
      collaborationEvents: [
        {
          id: "evt-1",
          recordId: "work-1",
          recordKind: "work_item",
          kind: "progressed",
          actorId: "hudson.main",
          at: 1_300,
          summary: "Tests are still running.",
        },
      ],
    }, 2_000);

    expect(feed.events.map((event) => event.kind)).toEqual([
      "message",
      "invocation_created",
      "flight_started",
      "flight_state",
      "work_event",
    ]);
    expect(feed.events.at(-1)?.summary).toBe("Tests are still running.");
    expect(feed.counts).toEqual({
      events: 5,
      messages: 1,
      invocations: 1,
      flights: 2,
      workEvents: 1,
    });
  });

  test("returns the latest limited events in chronological order", () => {
    const snapshot = createRuntimeRegistrySnapshot({
      messages: {
        "msg-1": {
          id: "msg-1",
          conversationId: "dm.operator.hudson",
          actorId: "operator",
          originNodeId: "node-1",
          class: "agent",
          body: "Old",
          visibility: "private",
          policy: "durable",
          createdAt: 1_000,
          metadata: {
            labels: ["goal:ios"],
          },
        },
        "msg-2": {
          id: "msg-2",
          conversationId: "dm.operator.hudson",
          actorId: "hudson.main",
          originNodeId: "node-1",
          class: "agent",
          body: "New",
          visibility: "private",
          policy: "durable",
          createdAt: 2_000,
          metadata: {
            labels: ["goal:ios"],
          },
        },
      },
    });

    const feed = buildScoutLabelFeed(snapshot, "goal:ios", {
      since: 500,
      limit: 1,
    }, 3_000);

    expect(feed.events.map((event) => event.id)).toEqual(["message:msg-2"]);
  });
});

describe("parseScoutHarness", () => {
  test("accepts Flue for Scout message attribution", () => {
    expect(parseScoutHarness("flue")).toBe("flue");
  });

  test("keeps managed local launch harnesses explicit", () => {
    expect(() => parseScoutLocalHarness("flue")).toThrow(
      `Unsupported local agent harness "flue". Use one of: ${SUPPORTED_LOCAL_AGENT_HARNESSES.join(", ")}`,
    );
    expect(parseScoutLocalHarness("pi")).toBe("pi");
  });
});

describe("resolveScoutBrokerUrl", () => {
  test("uses the configured broker port when no URL env override is set", () => {
    const home = mkdtempSync(join(tmpdir(), "openscout-broker-url-"));
    testDirectories.add(home);
    const openScoutHome = join(home, ".openscout");
    mkdirSync(openScoutHome, { recursive: true });
    writeFileSync(
      join(openScoutHome, "config.json"),
      JSON.stringify({
        version: 1,
        host: "0.0.0.0",
        ports: { broker: 45678 },
      }),
    );
    process.env.HOME = home;
    process.env.OPENSCOUT_HOME = openScoutHome;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(
      home,
      "Library",
      "Application Support",
      "OpenScout",
    );
    delete process.env.OPENSCOUT_BROKER_URL;
    delete process.env.OPENSCOUT_BROKER_HOST;
    delete process.env.OPENSCOUT_BROKER_PORT;
    process.env.OPENSCOUT_NETWORK_DISCOVERY_ENABLED = "0";

    expect(resolveScoutBrokerUrl()).toBe("http://127.0.0.1:45678");
  });
});

describe("scoutConversationIdForChannel", () => {
  test("maps friendly and structural channel names to one definitive opaque id", () => {
    const sharedId = stableChannelId(namedChannelNaturalKey("broadcast"));
    const fontStudioId = stableChannelId(namedChannelNaturalKey("font-studio"));

    expect(scoutConversationIdForChannel()).toBe(sharedId);
    expect(scoutConversationIdForChannel("shared")).toBe(sharedId);
    expect(scoutConversationIdForChannel("broadcast")).toBe(sharedId);
    expect(scoutConversationIdForChannel("channel.shared")).toBe(sharedId);
    expect(scoutConversationIdForChannel("font studio")).toBe(fontStudioId);
    expect(scoutConversationIdForChannel("channel.font-studio")).toBe(fontStudioId);
    expect(scoutConversationIdForChannel("system")).toBe(
      stableChannelId(systemChannelNaturalKey("system")),
    );
  });
});

function useIsolatedOpenScoutHome(): string {
  const home = mkdtempSync(join(tmpdir(), "openscout-desktop-broker-"));
  testDirectories.add(home);
  process.env.HOME = home;
  process.env.OPENSCOUT_HOME = join(home, ".openscout");
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(
    home,
    "Library",
    "Application Support",
    "OpenScout",
  );
  process.env.OPENSCOUT_CONTROL_HOME = join(
    home,
    ".openscout",
    "control-plane",
  );
  process.env.OPENSCOUT_RELAY_HUB = join(home, ".openscout", "relay");
  process.env.OPENSCOUT_BROKER_URL = "http://broker.test";
  // Pin the socket to a path that never exists — otherwise a live broker's
  // unix socket answers in place of the fetch stub on dev machines.
  process.env.OPENSCOUT_BROKER_SOCKET_PATH = join(home, "broker.sock");
  process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS = "1";
  return home;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("loadScoutBrokerContext", () => {
  test("prefers an active in-process broker service before HTTP", async () => {
    useIsolatedOpenScoutHome();

    const snapshot = createRuntimeRegistrySnapshot({
      agents: {
        "agent-1": {
          id: "agent-1",
          kind: "agent",
          definitionId: "agent-1",
          displayName: "Agent One",
          agentClass: "general",
          capabilities: ["chat"],
          wakePolicy: "manual",
          homeNodeId: "node-1",
          authorityNodeId: "node-1",
          advertiseScope: "local",
        },
      },
    });
    const service: ActiveScoutBrokerService = {
      baseUrl: "http://broker.test",
      readHealth: async () => ({
        ok: true,
        nodeId: "node-1",
        meshId: "mesh-1",
        counts: {
          nodes: 1,
          actors: 0,
          agents: 1,
          conversations: 0,
          messages: 0,
          flights: 0,
          collaborationRecords: 0,
        },
      }),
      readNode: async () => ({
        id: "node-1",
        meshId: "mesh-1",
        name: "node-1",
        advertiseScope: "local",
        registeredAt: 1,
        lastSeenAt: 1,
      }),
      readSnapshot: async () => snapshot,
      executeCommand: async () => {
        throw new Error("unexpected write command");
      },
    };
    registerActiveScoutBrokerService(service);
    globalThis.fetch = (async () => {
      throw new Error(
        "fetch should not be called when an in-process broker is active",
      );
    }) as unknown as typeof fetch;

    const context = await loadScoutBrokerContext();

    expect(context).not.toBeNull();
    expect(context?.node.id).toBe("node-1");
    expect(context?.snapshot.agents["agent-1"]?.displayName).toBe("Agent One");
  });

  test("preserves broker health diagnostics from an active service", async () => {
    useIsolatedOpenScoutHome();
    const service: ActiveScoutBrokerService = {
      baseUrl: "http://broker.test",
      readHealth: async () => ({
        ok: true,
        nodeId: "node-1",
        meshId: "mesh-1",
        build: {
          packageName: "@openscout/runtime",
          version: "0.test",
          mode: "dev",
        },
        services: {
          web: {
            managed: true,
            managedBy: "broker",
            state: "starting",
            pid: 1234,
            port: 43120,
            url: "http://127.0.0.1:43120",
            healthy: null,
          },
        },
        counts: {
          nodes: 1,
          actors: 1,
          agents: 2,
          conversations: 3,
          messages: 4,
          flights: 5,
          collaborationRecords: 6,
        },
      }),
      readNode: async () => ({
        id: "node-1",
        meshId: "mesh-1",
        name: "node-1",
        advertiseScope: "local",
        registeredAt: 1,
        lastSeenAt: 1,
      }),
      readSnapshot: async () => createRuntimeRegistrySnapshot(),
      executeCommand: async () => {
        throw new Error("unexpected write command");
      },
    };
    registerActiveScoutBrokerService(service);
    globalThis.fetch = (async () => {
      throw new Error(
        "fetch should not be called when an in-process broker is active",
      );
    }) as unknown as typeof fetch;

    const health = await readScoutBrokerHealth();

    expect(health.reachable).toBe(true);
    expect(health.transport).toBe("in_process");
    expect(health.socketFallbackError).toBeNull();
    expect(health.build).toEqual({
      packageName: "@openscout/runtime",
      version: "0.test",
      mode: "dev",
    });
    expect(health.services?.web?.state).toBe("starting");
    expect(health.services?.web?.pid).toBe(1234);
    expect(health.counts?.collaborationRecords).toBe(6);
    expect(health.checkedAt).toBeGreaterThan(0);
  });
});

describe("scoutAskHandler", () => {
  test("rejects asks with both an agent target and project path", async () => {
    const receipt = await scoutAskHandler({
      senderId: "operator",
      to: "talkie",
      projectPath: "/tmp/talkie",
      body: "Review this.",
      currentDirectory: process.cwd(),
    } as unknown as ScoutAskCommand);

    expect(receipt).toEqual({
      ok: false,
      state: "failed",
      ids: {},
      error: {
        code: "invalid_request",
        message:
          "provide one existing target, or a project/runtime launch target",
      },
    });
  });

  test("posts one broker ask with sender context and returns a compact receipt", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const talkieRoot = join(workspaceRoot, "talkie");
    mkdirSync(join(talkieRoot, ".git"), { recursive: true });

    const captured = {
      delivery: null as {
        body: string;
        target?: { kind?: string; label?: string };
        execution?: { harness?: string; session?: string; placement?: string };
        messageMetadata?: {
          source?: string;
          askWorkspace?: string;
          senderContext?: Record<string, unknown>;
          replyMode?: string;
        };
        invocationMetadata?: {
          source?: string;
          askWorkspace?: string;
          senderContext?: Record<string, unknown>;
          replyMode?: string;
        };
      } | null,
    };

    globalThis.fetch = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        captured.delivery = (await request.json()) as NonNullable<
          typeof captured.delivery
        >;
        return jsonResponse({
          kind: "delivery",
          accepted: true,
          routeKind: "dm",
          conversation: {
            id: "dm.operator.talkie",
            kind: "direct",
            title: "Talkie",
            visibility: "private",
            authorityNodeId: "node-1",
            participantIds: ["operator", "talkie.main"],
          },
          message: {
            id: "msg-1",
            conversationId: "dm.operator.talkie",
            actorId: "operator",
            originNodeId: "node-1",
            class: "agent",
            body: captured.delivery.body,
            visibility: "private",
            policy: "durable",
            createdAt: Date.now(),
          },
          targetAgentId: "talkie.main",
          flight: {
            id: "flt-1",
            invocationId: "inv-1",
            requesterId: "operator",
            targetAgentId: "talkie.main",
            state: "waking",
          },
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const receipt = await scoutAskHandler({
      senderId: "operator",
      to: "talkie",
      body: "How did you handle auth?",
      harness: "claude",
      placement: "background",
      workspace: "new_worktree",
      session: "reuse",
      replyMode: "inline",
      currentDirectory: talkieRoot,
    });

    expect(receipt).toEqual({
      ok: true,
      state: "queued",
      ids: {
        targetAgentId: "talkie.main",
        invocationId: "inv-1",
        flightId: "flt-1",
        conversationId: "dm.operator.talkie",
        messageId: "msg-1",
      },
    });
    expect(captured.delivery?.target).toEqual({
      kind: "agent_label",
      label: "talkie",
    });
    expect(captured.delivery?.execution).toEqual({
      harness: "claude",
      placement: "background",
      session: "new",
    });
    expect(captured.delivery?.messageMetadata).toMatchObject({
      source: "scout-ask",
      askWorkspace: "new_worktree",
      senderContext: {
        agentId: "operator",
        project: "talkie",
        cwd: talkieRoot,
        worktree: "unknown",
      },
      replyMode: "inline",
    });
    expect(captured.delivery?.invocationMetadata).toMatchObject(
      captured.delivery?.messageMetadata ?? {},
    );
  }, 15000);

  test("routes id-prefixed ask targets through direct agent ids", async () => {
    useIsolatedOpenScoutHome();

    const captured = {
      delivery: null as {
        target?: { kind?: string; agentId?: string };
        targetAgentId?: string;
      } | null,
    };

    globalThis.fetch = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        captured.delivery = (await request.json()) as NonNullable<
          typeof captured.delivery
        >;
        return jsonResponse({
          kind: "delivery",
          accepted: true,
          routeKind: "dm",
          conversation: {
            id: "dm.operator.talkie",
            kind: "direct",
            title: "Talkie",
            visibility: "private",
            authorityNodeId: "node-1",
            participantIds: ["operator", "talkie.main"],
          },
          message: {
            id: "msg-1",
            conversationId: "dm.operator.talkie",
            actorId: "operator",
            originNodeId: "node-1",
            class: "agent",
            body: "Review this.",
            visibility: "private",
            policy: "durable",
            createdAt: Date.now(),
          },
          targetAgentId: "talkie.main",
          flight: {
            id: "flt-1",
            invocationId: "inv-1",
            requesterId: "operator",
            targetAgentId: "talkie.main",
            state: "waking",
          },
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const receipt = await scoutAskHandler({
      senderId: "operator",
      to: "id:talkie.main",
      body: "Review this.",
      currentDirectory: process.cwd(),
    });

    expect(receipt.ids.targetAgentId).toBe("talkie.main");
    expect(captured.delivery?.target).toEqual({
      kind: "agent_id",
      agentId: "talkie.main",
    });
    expect(captured.delivery?.targetAgentId).toBe("talkie.main");
  }, 15000);

  test.each(["api", "cli"])("posts %s ask deliveries with a session-pinned return address", async (surface) => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev", "openscout");
    mkdirSync(workspaceRoot, { recursive: true });

    const captured = {
      delivery: null as {
        caller?: { actorId?: string; nodeId?: string; currentDirectory?: string };
        target?: { kind?: string; agentId?: string; label?: string };
        targetAgentId?: string;
        targetLabel?: string;
        replyToSessionId?: string;
        execution?: { session?: string };
        messageMetadata?: Record<string, unknown>;
        invocationMetadata?: Record<string, unknown>;
      } | null,
    };

    globalThis.fetch = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        captured.delivery = (await request.json()) as NonNullable<
          typeof captured.delivery
        >;
        return jsonResponse({
          kind: "delivery",
          accepted: true,
          routeKind: "dm",
          conversation: {
            id: "dm.operator.hudson",
            kind: "direct",
            title: "Hudson",
            visibility: "private",
            authorityNodeId: "node-1",
            participantIds: ["operator", "hudson.main"],
          },
          message: {
            id: "msg-1",
            conversationId: "dm.operator.hudson",
            actorId: "operator",
            originNodeId: "node-1",
            class: "agent",
            body: "Review this.",
            visibility: "private",
            policy: "durable",
            createdAt: Date.now(),
          },
          targetAgentId: "hudson.main",
          flight: {
            id: "flt-1",
            invocationId: "inv-1",
            requesterId: "operator",
            targetAgentId: "hudson.main",
            state: "waking",
          },
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    if (surface === "cli") {
      await runAskCommand(createScoutCommandContext({
        cwd: workspaceRoot,
        env: { CODEX_THREAD_ID: "codex-thread-123" },
        stdout: () => {},
        stderr: () => {},
      }), ["--as", "operator", "--to", "hudson.main", "--notify", "Review this."]);
    } else {
      const result = await askScoutAgentById({
        senderId: "operator",
        targetAgentId: "hudson.main",
        body: "Review this.",
        replyToSessionId: "codex-thread-123",
        currentDirectory: workspaceRoot,
        source: "scout-mcp",
      });
      expect(result.usedBroker).toBe(true);
      expect(result.flight?.id).toBe("flt-1");
    }
    expect(captured.delivery?.caller).toMatchObject({
      actorId: "operator",
      currentDirectory: workspaceRoot,
    });
    expect(captured.delivery?.target).toEqual(surface === "api"
      ? { kind: "agent_id", agentId: "hudson.main" }
      : { kind: "agent_label", label: "hudson.main" });
    if (surface === "api") expect(captured.delivery?.targetAgentId).toBe("hudson.main");
    expect(captured.delivery?.targetLabel).toBe("hudson.main");
    expect(captured.delivery?.replyToSessionId).toBe("codex-thread-123");
    expect(captured.delivery?.execution).toEqual({ session: "new" });
    expect(captured.delivery?.messageMetadata?.replyToSessionId).toBe(
      "codex-thread-123",
    );
    expect(captured.delivery?.invocationMetadata?.replyToSessionId).toBe(
      "codex-thread-123",
    );
  }, 15000);

  test("posts exact ask-by-session deliveries that continue existing context", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev", "openscout");
    mkdirSync(workspaceRoot, { recursive: true });

    const captured = {
      delivery: null as {
        target?: { kind?: string; sessionId?: string };
        targetSessionId?: string;
        targetLabel?: string;
        execution?: { session?: string; targetSessionId?: string };
        messageMetadata?: Record<string, unknown>;
        invocationMetadata?: Record<string, unknown>;
      } | null,
    };

    globalThis.fetch = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        captured.delivery = (await request.json()) as NonNullable<
          typeof captured.delivery
        >;
        return jsonResponse({
          kind: "delivery",
          accepted: true,
          routeKind: "dm",
          conversation: {
            id: "dm.operator.hudson",
            kind: "direct",
            title: "Hudson",
            visibility: "private",
            authorityNodeId: "node-1",
            participantIds: ["operator", "hudson.main"],
          },
          message: {
            id: "msg-1",
            conversationId: "dm.operator.hudson",
            actorId: "operator",
            originNodeId: "node-1",
            class: "agent",
            body: "Continue this review.",
            visibility: "private",
            policy: "durable",
            createdAt: Date.now(),
          },
          targetAgentId: "hudson.main",
          targetSessionId: "codex-thread-target",
          flight: {
            id: "flt-1",
            invocationId: "inv-1",
            requesterId: "operator",
            targetAgentId: "hudson.main",
            state: "running",
          },
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await askScoutSessionById({
      senderId: "operator",
      targetSessionId: "codex-thread-target",
      body: "Continue this review.",
      currentDirectory: workspaceRoot,
      source: "scout-mcp",
    });

    expect(result.usedBroker).toBe(true);
    expect(result.flight?.id).toBe("flt-1");
    expect(captured.delivery?.target).toEqual({
      kind: "session_id",
      sessionId: "codex-thread-target",
    });
    expect(captured.delivery?.targetSessionId).toBe("codex-thread-target");
    expect(captured.delivery?.targetLabel).toBe("session:codex-thread-target");
    expect(captured.delivery?.execution).toEqual({
      session: "existing",
      targetSessionId: "codex-thread-target",
    });
    expect(captured.delivery?.messageMetadata?.targetSessionId).toBe(
      "codex-thread-target",
    );
    expect(captured.delivery?.invocationMetadata?.targetSessionId).toBe(
      "codex-thread-target",
    );
  }, 15000);

  test("routes project path asks through broker project resolution", async () => {
    useIsolatedOpenScoutHome();
    const projectRoot = "/tmp/talkie";

    type CapturedDelivery = {
      target?: { kind?: string; projectPath?: string };
      targetLabel?: string;
    };
    const captured = {
      delivery: null as CapturedDelivery | null,
    };

    globalThis.fetch = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        captured.delivery = (await request.json()) as NonNullable<
          typeof captured.delivery
        >;
        return jsonResponse({
          kind: "delivery",
          accepted: true,
          routeKind: "dm",
          conversation: {
            id: "dm.operator.talkie",
            kind: "direct",
            title: "Talkie",
            visibility: "private",
            authorityNodeId: "node-1",
            participantIds: ["operator", "talkie.main"],
          },
          message: {
            id: "msg-1",
            conversationId: "dm.operator.talkie",
            actorId: "operator",
            originNodeId: "node-1",
            class: "agent",
            body: "Review this.",
            visibility: "private",
            policy: "durable",
            createdAt: Date.now(),
          },
          targetAgentId: "talkie.main",
          flight: {
            id: "flt-1",
            invocationId: "inv-1",
            requesterId: "operator",
            targetAgentId: "talkie.main",
            state: "waking",
          },
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const receipt = await scoutAskHandler({
      senderId: "operator",
      projectPath: projectRoot,
      body: "Review this.",
      currentDirectory: "/tmp",
    });

    expect(receipt.ids.targetAgentId).toBe("talkie.main");
    expect(captured.delivery?.target).toEqual({
      kind: "project_path",
      projectPath: projectRoot,
    });
    expect(captured.delivery?.targetLabel).toBe(projectRoot);

  }, 15000);

  test("infers a one-time project target when an ask only specifies execution preferences", async () => {
    useIsolatedOpenScoutHome();
    const projectRoot = "/tmp/talkie";

    type CapturedDelivery = {
      target?: { kind?: string; projectPath?: string };
      targetLabel?: string;
      execution?: { harness?: string; session?: string };
      projectAgent?: { persistence?: string };
    };
    const captured = {
      delivery: null as CapturedDelivery | null,
    };

    globalThis.fetch = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        captured.delivery = (await request.json()) as NonNullable<
          typeof captured.delivery
        >;
        return jsonResponse({
          kind: "delivery",
          accepted: true,
          routeKind: "dm",
          conversation: {
            id: "dm.operator.talkie",
            kind: "direct",
            title: "Talkie",
            visibility: "private",
            authorityNodeId: "node-1",
            participantIds: ["operator", "talkie.main"],
          },
          message: {
            id: "msg-1",
            conversationId: "dm.operator.talkie",
            actorId: "operator",
            originNodeId: "node-1",
            class: "agent",
            body: "Review this.",
            visibility: "private",
            policy: "durable",
            createdAt: Date.now(),
          },
          targetAgentId: "talkie.main",
          flight: {
            id: "flt-1",
            invocationId: "inv-1",
            requesterId: "operator",
            targetAgentId: "talkie.main",
            state: "waking",
          },
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const receipt = await scoutAskHandler({
      senderId: "operator",
      body: "Review this.",
      harness: "codex",
      currentDirectory: projectRoot,
    });

    expect(receipt.ids.targetAgentId).toBe("talkie.main");
    expect(captured.delivery?.target).toEqual({
      kind: "project_path",
      projectPath: projectRoot,
    });
    expect(captured.delivery?.targetLabel).toBe(projectRoot);
    expect(captured.delivery?.execution).toEqual({
      harness: "codex",
      session: "new",
    });
    expect(captured.delivery?.projectAgent).toEqual({
      persistence: "one_time",
    });

    captured.delivery = null;
    await scoutAskHandler({
      senderId: "operator",
      projectPath: projectRoot,
      body: "Review this.",
      session: "new",
      currentDirectory: "/tmp",
    });

    const explicitProjectDelivery = captured.delivery as CapturedDelivery | null;
    expect(explicitProjectDelivery?.target).toEqual({
      kind: "project_path",
      projectPath: projectRoot,
    });
    expect(explicitProjectDelivery?.execution).toEqual({
      session: "new",
    });
    expect(explicitProjectDelivery?.projectAgent).toEqual({
      persistence: "one_time",
    });
  }, 15000);

  test("rejects project-prefixed to targets at the core boundary", async () => {
    const receipt = await scoutAskHandler({
      senderId: "operator",
      to: "project:talkie",
      body: "Review this.",
      currentDirectory: "/tmp",
    });

    expect(receipt).toEqual({
      ok: false,
      state: "failed",
      ids: {},
      error: {
        code: "invalid_request",
        message: "project targets must use projectPath",
      },
    });
  });

  test("returns one required resolve call for ambiguous targets", async () => {
    useIsolatedOpenScoutHome();

    globalThis.fetch = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        return jsonResponse({
          kind: "rejected",
          accepted: false,
          reason: "ambiguous_target",
          rejection: {
            id: "dispatch-1",
            kind: "ambiguous",
            askedLabel: "vox",
            detail: "vox matches multiple agents",
            candidates: [
              { agentId: "vox.codex", label: "@vox.harness:codex" },
              { agentId: "vox.claude", label: "@vox.harness:claude" },
            ],
            dispatchedAt: Date.now(),
            dispatcherNodeId: "node-1",
          },
        });
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const receipt = await scoutAskHandler({
      senderId: "operator",
      to: "vox",
      body: "Review this.",
      currentDirectory: process.cwd(),
    });

    expect(receipt).toEqual({
      ok: false,
      state: "ambiguous",
      ids: {},
      next: {
        tool: "agents_resolve",
        arguments: {
          label: "vox",
          currentDirectory: process.cwd(),
        },
        reason: "vox matches multiple agents",
      },
    });
  }, 15000);
});

describe("askScoutQuestion", () => {
  test("passes route intent to broker delivery and lets the broker wake targets", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const talkieRoot = join(workspaceRoot, "talkie");

    mkdirSync(join(talkieRoot, ".git"), { recursive: true });
    writeFileSync(join(talkieRoot, "AGENTS.md"), "# talkie\n", "utf8");

    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [workspaceRoot],
        includeCurrentRepo: false,
      },
    });

    const requests: Array<{ method: string; path: string }> = [];
    const captured = {
      postedMessage: null as {
        conversationId: string;
        audience?: { notify: string[]; reason: string };
        metadata?: { relayChannel?: string; relayTarget?: string };
      } | null,
      postedInvocation: null as {
        id: string;
        requesterId: string;
        conversationId: string;
        metadata?: { relayChannel?: string; relayTarget?: string };
      } | null,
      delivery: null as {
        body: string;
        target?: { kind?: string; label?: string };
        caller?: { actorId?: string; nodeId?: string; currentDirectory?: string };
        labels?: string[];
        messageMetadata?: { source?: string; labels?: string[] };
        invocationMetadata?: { source?: string; labels?: string[] };
      } | null,
    };
    globalThis.fetch = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/agents") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        captured.postedMessage = (await request.json()) as NonNullable<
          typeof captured.postedMessage
        >;
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/conversations") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        const body = (await request.json()) as {
          caller?: { actorId?: string; nodeId?: string; currentDirectory?: string };
          body: string;
          target?: { kind?: string; label?: string };
          labels?: string[];
          messageMetadata?: { source?: string; labels?: string[] };
          invocationMetadata?: { source?: string; labels?: string[] };
        };
        const requesterId = body.caller?.actorId ?? "operator";
        captured.delivery = body;
        return jsonResponse({
          kind: "delivery",
          accepted: true,
          routeKind: "dm",
          conversation: {
            id: "dm.operator.talkie",
            kind: "direct",
            title: "Talkie",
            visibility: "private",
            authorityNodeId: "node-1",
            participantIds: ["operator", "talkie"],
          },
          message: {
            id: "msg-1",
            conversationId: "dm.operator.talkie",
            actorId: requesterId,
            originNodeId: "node-1",
            class: "agent",
            body: body.body,
            audience: {
              notify: ["talkie"],
              reason: "direct_message",
            },
            visibility: "private",
            policy: "durable",
            createdAt: Date.now(),
            metadata: {
              relayChannel: "dm",
            },
          },
          flight: {
            id: "flt-1",
            invocationId: "inv-1",
            requesterId,
            targetAgentId: "talkie",
            state: "waking",
            summary: "Talkie waking.",
            startedAt: Date.now(),
          },
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await askScoutQuestion({
      senderId: "operator",
      targetLabel: "talkie",
      body: "build it for me",
      labels: ["goal:build", "release:0.2.66"],
      currentDirectory: workspaceRoot,
    });

    expect(result.usedBroker).toBe(true);
    expect(result.conversationId?.startsWith("dm.")).toBe(true);
    expect(result.messageId).toBeTruthy();
    expect(result.flight?.id).toBe("flt-1");
    expect(result.flight?.state).toBe("waking");
    expect(result.unresolvedTarget).toBeUndefined();
    expect(result.targetDiagnostic).toBeUndefined();
    expect(captured.delivery?.body).toBe("build it for me");
    expect(captured.delivery?.target).toEqual({
      kind: "agent_label",
      label: "talkie",
    });
    expect(captured.delivery?.caller).toMatchObject({
      actorId: "operator",
      currentDirectory: workspaceRoot,
    });
    expect(captured.delivery?.messageMetadata?.source).toBe("scout-cli");
    expect(captured.delivery?.invocationMetadata?.source).toBe("scout-cli");
    expect(captured.delivery?.labels).toEqual(["goal:build", "release:0.2.66"]);
    expect(captured.delivery?.messageMetadata?.labels).toEqual(["goal:build", "release:0.2.66"]);
    expect(captured.delivery?.invocationMetadata?.labels).toEqual(["goal:build", "release:0.2.66"]);
    expect(requests.some((request) => request.path === "/v1/deliver")).toBe(
      true,
    );
    expect(requests.some((request) => request.path === "/v1/agents")).toBe(
      false,
    );
    expect(requests.some((request) => request.path === "/v1/messages")).toBe(
      false,
    );
    expect(requests.some((request) => request.path === "/v1/invocations")).toBe(
      false,
    );
    expect(requests.some((request) => request.path === "/v1/endpoints")).toBe(
      false,
    );
  }, 15000);

  test("returns an ambiguous diagnostic when @name matches multiple agents", async () => {
    useIsolatedOpenScoutHome();

    const voxCodexAgent = {
      id: "vox.mini.codex",
      kind: "agent",
      definitionId: "vox",
      displayName: "Vox (codex)",
      handle: "vox",
      agentClass: "general",
      capabilities: ["chat"],
      wakePolicy: "on_demand",
      homeNodeId: "node-1",
      authorityNodeId: "node-1",
      advertiseScope: "local",
      metadata: {
        definitionId: "vox",
        nodeQualifier: "mini",
      },
    };
    const voxClaudeAgent = {
      id: "vox.mini.claude",
      kind: "agent",
      definitionId: "vox",
      displayName: "Vox (claude)",
      handle: "vox",
      agentClass: "general",
      capabilities: ["chat"],
      wakePolicy: "on_demand",
      homeNodeId: "node-1",
      authorityNodeId: "node-1",
      advertiseScope: "local",
      metadata: {
        definitionId: "vox",
        nodeQualifier: "mini",
      },
    };
    const voxCodexEndpoint = {
      id: "ep-vox-codex",
      agentId: "vox.mini.codex",
      nodeId: "node-1",
      harness: "codex",
      transport: "local_socket",
      state: "active",
    };
    const voxClaudeEndpoint = {
      id: "ep-vox-claude",
      agentId: "vox.mini.claude",
      nodeId: "node-1",
      harness: "claude",
      transport: "local_socket",
      state: "active",
    };

    globalThis.fetch = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {
            [voxCodexAgent.id]: voxCodexAgent,
            [voxClaudeAgent.id]: voxClaudeAgent,
          },
          endpoints: {
            [voxCodexEndpoint.id]: voxCodexEndpoint,
            [voxClaudeEndpoint.id]: voxClaudeEndpoint,
          },
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        return jsonResponse({
          kind: "rejected",
          accepted: false,
          reason: "ambiguous_target",
          rejection: {
            id: "dispatch-1",
            kind: "ambiguous",
            askedLabel: "@vox",
            detail: "@vox matches multiple agents; pick one",
            candidates: [
              {
                agentId: "vox.mini.codex",
                displayName: "Vox (codex)",
                label: "@vox.harness:codex",
                endpointState: "online",
                transport: "local_socket",
              },
              {
                agentId: "vox.mini.claude",
                displayName: "Vox (claude)",
                label: "@vox.harness:claude",
                endpointState: "online",
                transport: "local_socket",
              },
            ],
            dispatchedAt: Date.now(),
            dispatcherNodeId: "node-1",
          },
        });
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await askScoutQuestion({
      senderId: "operator",
      targetLabel: "vox",
      body: "are you there?",
      currentDirectory: process.cwd(),
    });

    expect(result.usedBroker).toBe(true);
    expect(result.flight).toBeUndefined();
    expect(result.unresolvedTarget).toBe("vox");
    expect(result.targetDiagnostic?.state).toBe("ambiguous");
    if (result.targetDiagnostic?.state === "ambiguous") {
      const ids = result.targetDiagnostic.candidates
        .map((candidate) => candidate.agentId)
        .sort();
      expect(ids).toEqual(["vox.mini.claude", "vox.mini.codex"]);
      const labels = result.targetDiagnostic.candidates
        .map((candidate) => candidate.label)
        .sort();
      expect(labels).toEqual(["@vox.harness:claude", "@vox.harness:codex"]);
    }
  }, 15000);

  test("prefers the current project agent over a stale worktree alias", async () => {
    useIsolatedOpenScoutHome();

    const workspaceRoot = join(tmpdir(), "openscout-current-project");
    const currentRoot = join(workspaceRoot, "openscout");
    const staleRoot = join(workspaceRoot, "openscout-pr9-merge");
    mkdirSync(join(currentRoot, ".git"), { recursive: true });
    mkdirSync(join(staleRoot, ".git"), { recursive: true });
    writeFileSync(join(currentRoot, "AGENTS.md"), "# openscout\n", "utf8");
    writeFileSync(join(staleRoot, "AGENTS.md"), "# openscout pr9\n", "utf8");

    const staleAgent = {
      id: "openscout.codex-pr9-merge-snapshot.mini",
      kind: "agent",
      definitionId: "openscout",
      displayName: "Openscout",
      handle: "openscout",
      defaultSelector: "@openscout",
      agentClass: "general",
      capabilities: ["chat"],
      wakePolicy: "on_demand",
      homeNodeId: "node-1",
      authorityNodeId: "node-1",
      advertiseScope: "local",
      metadata: {
        definitionId: "openscout",
        defaultSelector: "@openscout",
        workspaceQualifier: "codex-pr9-merge-snapshot",
        projectRoot: staleRoot,
      },
    };
    const discoveredAgent = {
      id: "openscout.codex-control-plane-foundation.mini",
      kind: "agent",
      definitionId: "openscout",
      displayName: "Openscout",
      handle: "openscout",
      defaultSelector: "@openscout",
      agentClass: "general",
      capabilities: ["chat"],
      wakePolicy: "on_demand",
      homeNodeId: "node-1",
      authorityNodeId: "node-1",
      advertiseScope: "local",
      metadata: {
        definitionId: "openscout",
        defaultSelector: "@openscout",
        workspaceQualifier: "codex-control-plane-foundation",
        projectRoot: join(workspaceRoot, "other-worktree"),
      },
    };
    const currentAgent = {
      id: "openscout-4.main.mini",
      kind: "agent",
      definitionId: "openscout-4",
      displayName: "Openscout 4",
      handle: "openscout-4",
      defaultSelector: "@openscout-4",
      agentClass: "general",
      capabilities: ["chat"],
      wakePolicy: "on_demand",
      homeNodeId: "node-1",
      authorityNodeId: "node-1",
      advertiseScope: "local",
      metadata: {
        definitionId: "openscout-4",
        defaultSelector: "@openscout-4",
        workspaceQualifier: "main",
        projectRoot: currentRoot,
      },
    };
    const staleEndpoint = {
      id: "ep-openscout-stale",
      agentId: staleAgent.id,
      nodeId: "node-1",
      harness: "claude",
      transport: "local_socket",
      state: "idle",
      projectRoot: staleRoot,
    };
    const currentEndpoint = {
      id: "ep-openscout-current",
      agentId: currentAgent.id,
      nodeId: "node-1",
      harness: "claude",
      transport: "local_socket",
      state: "idle",
      projectRoot: currentRoot,
    };
    globalThis.fetch = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {
            [staleAgent.id]: staleAgent,
            [discoveredAgent.id]: discoveredAgent,
            [currentAgent.id]: currentAgent,
          },
          endpoints: {
            [staleEndpoint.id]: staleEndpoint,
            [currentEndpoint.id]: currentEndpoint,
          },
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        const body = await request.json() as { requesterId: string; body: string };
        return jsonResponse({
          kind: "delivery",
          accepted: true,
          routeKind: "dm",
          conversation: {
            id: `dm.operator.${currentAgent.id}`,
            kind: "direct",
            title: "Openscout 4",
            visibility: "private",
            authorityNodeId: "node-1",
            participantIds: ["operator", currentAgent.id],
          },
          message: {
            id: "msg-current",
            conversationId: `dm.operator.${currentAgent.id}`,
            actorId: body.requesterId,
            originNodeId: "node-1",
            class: "agent",
            body: body.body,
            visibility: "private",
            policy: "durable",
            createdAt: Date.now(),
          },
          targetAgentId: currentAgent.id,
          flight: {
            id: "flt-current",
            invocationId: "inv-current",
            requesterId: "operator",
            targetAgentId: currentAgent.id,
            state: "waking",
          },
        });
      }
      if (request.method === "POST") {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await askScoutQuestion({
      senderId: "operator",
      targetLabel: "openscout",
      body: "please look at this",
      currentDirectory: currentRoot,
    });

    expect(result.usedBroker).toBe(true);
    expect(result.unresolvedTarget).toBeUndefined();
    expect(result.targetDiagnostic).toBeUndefined();
    expect(result.flight?.targetAgentId).toBe(currentAgent.id);
  }, 15000);

  test("creates a durable work item beyond the message and flight ids", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const talkieRoot = join(workspaceRoot, "talkie");

    mkdirSync(join(talkieRoot, ".git"), { recursive: true });
    writeFileSync(join(talkieRoot, "AGENTS.md"), "# talkie\n", "utf8");

    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [workspaceRoot],
        includeCurrentRepo: false,
      },
    });

    const captured = {
      postedDeliver: null as {
        caller?: { actorId?: string };
        body: string;
        collaborationRecordId?: string;
        workItem?: {
          id?: string;
          title?: string;
          summary?: string;
        };
        messageMetadata?: Record<string, unknown>;
        invocationMetadata?: Record<string, unknown>;
      } | null,
      postedRecord: null as {
        id: string;
        kind: string;
        title: string;
        ownerId?: string;
      } | null,
      postedEvent: null as {
        recordId: string;
        kind: string;
        actorId: string;
        summary?: string;
      } | null,
    };

    globalThis.fetch = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
          collaborationRecords: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/agents") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/conversations") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        const body = (await request.json()) as NonNullable<typeof captured.postedDeliver>;
        captured.postedDeliver = body;
        const requesterId = body.caller?.actorId ?? "operator";
        return jsonResponse({
          kind: "delivery",
          accepted: true,
          routeKind: "dm",
          conversation: {
            id: "dm.operator.talkie",
            kind: "direct",
            title: "Talkie",
            visibility: "private",
            authorityNodeId: "node-1",
            participantIds: ["operator", "talkie"],
          },
          message: {
            id: "msg-1",
            conversationId: "dm.operator.talkie",
            actorId: requesterId,
            originNodeId: "node-1",
            class: "agent",
            body: body.body,
            visibility: "private",
            policy: "durable",
            createdAt: Date.now(),
          },
          targetAgentId: "talkie.main.mini",
          flight: {
            id: "flt-1",
            invocationId: "inv-1",
            requesterId,
            targetAgentId: "talkie.main.mini",
            state: "running",
          },
        });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/collaboration/records"
      ) {
        captured.postedRecord = (await request.json()) as NonNullable<
          typeof captured.postedRecord
        >;
        return jsonResponse({ ok: true, recordId: captured.postedRecord.id });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/collaboration/events"
      ) {
        captured.postedEvent = (await request.json()) as NonNullable<typeof captured.postedEvent>;
        return jsonResponse({ ok: true, eventId: captured.postedEvent.recordId });
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await askScoutQuestion({
      senderId: "operator",
      targetLabel: "talkie",
      body: "build it for me",
      currentDirectory: workspaceRoot,
      workItem: {
        title: "Build the talkie feature",
        summary: "Track the delegated implementation request",
      },
    });

    expect(result.usedBroker).toBe(true);
    expect(result.workItem?.id.startsWith("work-")).toBe(true);
    expect(result.workItem?.title).toBe("Build the talkie feature");
    expect(captured.postedDeliver?.collaborationRecordId).toBe(result.workItem?.id);
    expect(captured.postedDeliver?.workItem?.id).toBe(result.workItem?.id);
    expect(captured.postedDeliver?.workItem?.title).toBe("Build the talkie feature");
    expect(captured.postedDeliver?.messageMetadata?.collaborationRecordId).toBe(result.workItem?.id);
    expect(captured.postedDeliver?.invocationMetadata?.collaborationRecordId).toBe(result.workItem?.id);
    expect(captured.postedRecord?.kind).toBe("work_item");
    expect(captured.postedRecord?.id).toBe(result.workItem?.id);
    expect(captured.postedRecord?.ownerId).toBe("talkie.main.mini");
    expect(captured.postedEvent?.recordId).toBe(result.workItem?.id);
    expect(captured.postedEvent?.kind).toBe("created");
  }, 15000);
});

describe("waitForScoutFlight", () => {
  test("resolves the flight once, then polls only its invocation", async () => {
    useIsolatedOpenScoutHome();
    const paths: string[] = [];
    const flight = { id: "flight-1", invocationId: "inv-1", requesterId: "operator", targetAgentId: "worker", state: "running" };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      paths.push(path);
      if (path === "/v1/snapshot") return jsonResponse({ flights: { "flight-1": flight } });
      expect(path).toBe("/v1/invocations/inv-1");
      return jsonResponse({ flight: { ...flight, state: "completed" } });
    }) as typeof fetch;
    expect((await waitForScoutFlight("http://broker.test", "flight-1")).state).toBe("completed");
    expect(paths).toEqual(["/v1/snapshot", "/v1/invocations/inv-1"]);
  });

  test("a known invocation skips the registry and cancellation stops polling", async () => {
    useIsolatedOpenScoutHome();
    const controller = new AbortController();
    let requests = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      expect(new URL(input instanceof Request ? input.url : String(input)).pathname).toBe("/v1/invocations/inv-1");
      requests++;
      controller.abort();
      return jsonResponse({ flight: { id: "flight-1", invocationId: "inv-1", requesterId: "operator", targetAgentId: "worker", state: "running" } });
    }) as typeof fetch;
    await expect(waitForScoutFlight("http://broker.test", "flight-1", { invocationId: "inv-1", signal: controller.signal })).rejects.toThrow();
    expect(requests).toBe(1);
  });

  test("can return on target acknowledgement without waiting for completion", async () => {
    useIsolatedOpenScoutHome();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.pathname).toBe("/v1/snapshot");
      return jsonResponse({
        flights: {
          "flight-1": {
            id: "flight-1",
            invocationId: "inv-1",
            requesterId: "operator",
            targetAgentId: "hudson",
            state: "running",
            summary: "Hudson acknowledged via codex_app_server.",
          },
        },
      });
    }) as unknown as typeof fetch;

    const flight = await waitForScoutFlight("http://broker.test", "flight-1", {
      waitUntil: "acknowledged",
    });

    expect(flight.state).toBe("running");
  });
});

describe("updateScoutWorkItem", () => {
  test("updates an existing work item and appends a collaboration event", async () => {
    useIsolatedOpenScoutHome();

    const snapshot: {
      actors: Record<string, unknown>;
      agents: Record<string, unknown>;
      endpoints: Record<string, unknown>;
      conversations: Record<string, unknown>;
      messages: Record<string, unknown>;
      flights: Record<string, unknown>;
      collaborationRecords: Record<string, {
        id: string;
        kind: string;
        title: string;
        summary?: string;
        state: string;
        acceptanceState: string;
        createdById?: string;
        ownerId?: string;
        nextMoveOwnerId?: string;
        requestedById?: string;
        conversationId?: string;
        createdAt: number;
        updatedAt: number;
        reviewRequestedAt?: number;
      }>;
    } = {
      actors: {},
      agents: {},
      endpoints: {},
      conversations: {},
      messages: {},
      flights: {},
      collaborationRecords: {
        "work-1": {
          id: "work-1",
          kind: "work_item",
          title: "Render the promo clip",
          summary: "Initial request",
          state: "working",
          acceptanceState: "pending",
          createdById: "premotion.master.mini",
          requestedById: "premotion.master.mini",
          ownerId: "hudson.main",
          nextMoveOwnerId: "hudson.main",
          conversationId: "dm.premotion.master.mini.hudson.main",
          createdAt: 100,
          updatedAt: 100,
        },
      },
    };
    const captured = {
      postedRecord: null as {
        id: string;
        kind: string;
        title: string;
        summary?: string;
        state: string;
        acceptanceState: string;
        createdById?: string;
        ownerId?: string;
        nextMoveOwnerId?: string;
        requestedById?: string;
        conversationId?: string;
        createdAt: number;
        updatedAt: number;
        reviewRequestedAt?: number;
      } | null,
      postedEvent: null as { kind: string; summary?: string } | null,
    };

    globalThis.fetch = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse(snapshot);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/collaboration/records"
      ) {
        const body = (await request.json()) as NonNullable<typeof captured.postedRecord>;
        captured.postedRecord = body;
        snapshot.collaborationRecords["work-1"] = body;
        return jsonResponse({ ok: true, recordId: body.id });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/collaboration/events"
      ) {
        captured.postedEvent = (await request.json()) as NonNullable<typeof captured.postedEvent>;
        return jsonResponse({ ok: true, eventId: "evt-1" });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const updated = await updateScoutWorkItem({
      workId: "work-1",
      actorId: "hudson.main",
      state: "review",
      summary: "Ready for operator review",
    });

    expect(updated?.id).toBe("work-1");
    expect(updated?.state).toBe("review");
    expect(updated?.summary).toBe("Ready for operator review");
    expect(captured.postedRecord?.state).toBe("review");
    expect(captured.postedRecord?.summary).toBe("Ready for operator review");
    expect(typeof captured.postedRecord?.reviewRequestedAt).toBe("number");
    expect(captured.postedEvent?.kind).toBe("review_requested");
    expect(captured.postedEvent?.summary).toBe("Ready for operator review");
  });
});

describe("resolveHumanAskSenderName", () => {
  test("keeps human ask senders as the operator by default", () => {
    expect(resolveHumanAskSenderName(null, {} as NodeJS.ProcessEnv)).toBe(
      "operator",
    );
  });

  test("preserves explicit ask sender identity", () => {
    expect(
      resolveHumanAskSenderName("talkie.main.mini", {
        OPENSCOUT_AGENT: "openscout.main.mini",
      } as NodeJS.ProcessEnv),
    ).toBe("talkie.main.mini");
  });

  test("defers to agent environment when an agent is asking", () => {
    expect(
      resolveHumanAskSenderName(null, {
        OPENSCOUT_AGENT: "openscout.main.mini",
      } as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });

  test("defers to project sender inference for coding-agent hosts", () => {
    expect(
      resolveHumanAskSenderName(null, {
        CURSOR_AGENT: "1",
      } as NodeJS.ProcessEnv),
    ).toBeUndefined();
    expect(
      resolveHumanAskSenderName(null, {
        CLAUDECODE: "1",
      } as NodeJS.ProcessEnv),
    ).toBeUndefined();
    expect(
      resolveHumanAskSenderName(null, {
        CODEX_CI: "1",
      } as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });
});

describe("scout ask sender resolution", () => {
  test("uses operator for human shells and project sender for coding-agent hosts", async () => {
    const home = useIsolatedOpenScoutHome();
    const repo = join(home, "dev", "openscout");
    mkdirSync(join(repo, ".git"), { recursive: true });
    await writeProjectConfig(repo, {
      version: 1,
      project: {
        id: "openscout",
        name: "OpenScout",
      },
      agent: {
        id: "openscout",
      },
    });

    const humanSender = await resolveScoutSenderId(
      resolveHumanAskSenderName(null, {} as NodeJS.ProcessEnv),
      repo,
      {} as NodeJS.ProcessEnv,
    );
    expect(humanSender).toBe("operator");

    const agentSender = await resolveScoutSenderId(
      resolveHumanAskSenderName(null, { CURSOR_AGENT: "1" } as NodeJS.ProcessEnv),
      repo,
      { CURSOR_AGENT: "1" } as NodeJS.ProcessEnv,
    );
    expect(agentSender).toMatch(/^openscout\./);
    expect(agentSender).not.toBe("operator");
  });
});

describe("resolveScoutSenderId", () => {
  test("falls back to the operator name outside a project", async () => {
    const home = useIsolatedOpenScoutHome();
    const scratch = join(home, "scratch");
    mkdirSync(scratch, { recursive: true });
    process.env.OPENSCOUT_OPERATOR_NAME = "arach";

    const senderId = await resolveScoutSenderId(null, scratch);

    expect(senderId).toBe("arach");
  });

  test("prefers OPENSCOUT_AGENT when present", async () => {
    const home = useIsolatedOpenScoutHome();
    const scratch = join(home, "scratch");
    mkdirSync(scratch, { recursive: true });
    process.env.OPENSCOUT_AGENT = "vox.main.mini";
    process.env.OPENSCOUT_OPERATOR_NAME = "arach";

    const senderId = await resolveScoutSenderId(null, scratch);

    expect(senderId).toBe("vox.main.mini");
  });

  test("uses the current project root instead of a duplicate basename", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceA = join(home, "workspace-a");
    const workspaceB = join(home, "workspace-b");
    const repoA = join(workspaceA, "shared");
    const repoB = join(workspaceB, "shared");
    const nestedRepoB = join(repoB, "src", "feature");

    mkdirSync(join(repoA, ".git"), { recursive: true });
    mkdirSync(join(repoB, ".git"), { recursive: true });
    mkdirSync(nestedRepoB, { recursive: true });

    await writeProjectConfig(repoA, {
      version: 1,
      project: {
        id: "alpha-project",
        name: "Alpha Project",
      },
      agent: {
        id: "alpha",
      },
    });
    await writeProjectConfig(repoB, {
      version: 1,
      project: {
        id: "beta-project",
        name: "Beta Project",
      },
      agent: {
        id: "beta",
      },
    });

    const senderA = await resolveScoutSenderId(null, repoA);
    const senderB = await resolveScoutSenderId(null, nestedRepoB);

    expect(senderA).toMatch(/^alpha\./);
    expect(senderB).toMatch(/^beta\./);
    expect(senderA).not.toBe(senderB);
  });

  test("prefers the project-configured agent when multiple local cards share the root", async () => {
    const home = useIsolatedOpenScoutHome();
    const repo = join(home, "dev", "openscout");

    mkdirSync(join(repo, ".git"), { recursive: true });
    await writeProjectConfig(repo, {
      version: 1,
      project: {
        id: "openscout",
        name: "OpenScout",
      },
      agent: {
        id: "ranger",
      },
    });
    await writeRelayAgentOverrides({
      "openscout-canvas-nav.main.mini": {
        agentId: "openscout-canvas-nav.main.mini",
        definitionId: "openscout-canvas-nav",
        projectName: "OpenScout",
        projectRoot: repo,
        source: "manual",
      },
      "ranger.main.mini": {
        agentId: "ranger.main.mini",
        definitionId: "ranger",
        projectName: "OpenScout",
        projectRoot: repo,
        source: "manual",
      },
    });

    const senderId = await resolveScoutSenderId(null, repo);

    expect(senderId.startsWith("ranger.")).toBe(true);
    expect(senderId.startsWith("openscout-canvas-nav.")).toBe(false);
  });

  test("prefers the manifest agent as the project default sender", async () => {
    const home = useIsolatedOpenScoutHome();
    const repo = join(home, "dev", "openscout");

    mkdirSync(join(repo, ".git"), { recursive: true });
    await writeProjectConfig(repo, {
      version: 1,
      project: {
        id: "openscout",
        name: "OpenScout",
      },
      agent: {
        id: "ranger",
      },
    });
    await writeRelayAgentOverrides({
      "ranger.main.mini": {
        agentId: "ranger.main.mini",
        definitionId: "ranger",
        projectName: "OpenScout",
        projectRoot: repo,
        source: "manifest",
      },
      "openscout.main.mini": {
        agentId: "openscout.main.mini",
        definitionId: "openscout",
        projectName: "OpenScout",
        projectRoot: repo,
        projectConfigPath: null,
        source: "manual",
      },
    });

    const senderId = await resolveScoutSenderId(null, repo);

    expect(senderId.startsWith("ranger.")).toBe(true);
    expect(senderId.startsWith("openscout.")).toBe(false);
  });

  test("keeps explicit and OPENSCOUT_AGENT senders ahead of Herdr identity", async () => {
    const home = useIsolatedOpenScoutHome();
    const repo = join(home, "dev", "openscout");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const env = {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p2",
      HERDR_AGENT_NAME: "worker",
      OPENSCOUT_AGENT: "vox.main.mini",
    } as NodeJS.ProcessEnv;

    expect(await resolveScoutSenderId("explicit.main.mini", repo, env)).toBe(
      "explicit.main.mini",
    );
    expect(await resolveScoutSenderId(null, repo, env)).toBe("vox.main.mini");
  });

  test("resolves the exact project card matching the Herdr managed name", async () => {
    const home = useIsolatedOpenScoutHome();
    const repo = join(home, "dev", "openscout");
    mkdirSync(join(repo, ".git"), { recursive: true });
    await writeProjectConfig(repo, {
      version: 1,
      project: {
        id: "openscout",
        name: "OpenScout",
      },
      agent: {
        id: "ranger",
      },
    });
    await writeRelayAgentOverrides({
      "openscout-canvas-nav.main.mini": {
        agentId: "openscout-canvas-nav.main.mini",
        definitionId: "openscout-canvas-nav",
        projectName: "OpenScout",
        projectRoot: repo,
        source: "manual",
      },
      "ranger.main.mini": {
        agentId: "ranger.main.mini",
        definitionId: "ranger",
        projectName: "OpenScout",
        projectRoot: repo,
        source: "manual",
      },
      "worker.main.mini": {
        agentId: "worker.main.mini",
        definitionId: "worker",
        projectName: "OpenScout",
        projectRoot: repo,
        source: "manual",
      },
    });

    const senderId = await resolveScoutSenderId(null, repo, {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p2",
      HERDR_AGENT_NAME: "worker",
    } as NodeJS.ProcessEnv);

    expect(senderId.startsWith("worker.")).toBe(true);
    expect(senderId.startsWith("ranger.")).toBe(false);
    expect(senderId.startsWith("openscout-canvas-nav.")).toBe(false);
  });

  test("derives a project-qualified sender from the Herdr name when no card matches", async () => {
    const home = useIsolatedOpenScoutHome();
    const repo = join(home, "dev", "openscout");
    mkdirSync(join(repo, ".git"), { recursive: true });
    await writeProjectConfig(repo, {
      version: 1,
      project: {
        id: "openscout",
        name: "OpenScout",
      },
      agent: {
        id: "ranger",
      },
    });
    await writeRelayAgentOverrides({
      "ranger.main.mini": {
        agentId: "ranger.main.mini",
        definitionId: "ranger",
        projectName: "OpenScout",
        projectRoot: repo,
        source: "manual",
      },
    });

    const senderId = await resolveScoutSenderId(null, repo, {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p2",
      HERDR_AGENT_NAME: "Worker One",
    } as NodeJS.ProcessEnv);

    expect(senderId.startsWith("worker-one.")).toBe(true);
    expect(senderId).not.toBe("ranger.main.mini");
  });

  test("ignores Herdr identity when its markers are incomplete", async () => {
    const home = useIsolatedOpenScoutHome();
    const repo = join(home, "dev", "openscout");
    mkdirSync(join(repo, ".git"), { recursive: true });
    await writeProjectConfig(repo, {
      version: 1,
      project: {
        id: "openscout",
        name: "OpenScout",
      },
      agent: {
        id: "ranger",
      },
    });

    for (const env of [
      { HERDR_PANE_ID: "w1:p2", HERDR_AGENT_NAME: "worker" },
      { HERDR_ENV: "0", HERDR_PANE_ID: "w1:p2", HERDR_AGENT_NAME: "worker" },
      { HERDR_ENV: "1", HERDR_AGENT_NAME: "worker" },
      { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" },
      { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", HERDR_AGENT_NAME: "  " },
    ]) {
      const senderId = await resolveScoutSenderId(null, repo, env as NodeJS.ProcessEnv);
      expect(senderId.startsWith("ranger.")).toBe(true);
    }
  });
});

describe("resolveScoutMatchParticipantId", () => {
  test("canonicalizes an explicit session override", async () => {
    const participantId = await resolveScoutMatchParticipantId(
      "reviewer",
      { CODEX_THREAD_ID: "thread-one" } as NodeJS.ProcessEnv,
    );
    expect(participantId).toBe("session:reviewer");
  });

  test("uses Codex and Claude native session addresses", async () => {
    const codex = await resolveScoutMatchParticipantId(
      null,
      { CODEX_THREAD_ID: "thread-one" } as NodeJS.ProcessEnv,
    );
    const claude = await resolveScoutMatchParticipantId(
      null,
      { CLAUDE_SESSION_ID: "session-two" } as NodeJS.ProcessEnv,
    );
    expect(codex).toBe("session:thread-one");
    expect(claude).toBe("session:session-two");
  });

  test("fails clearly instead of collapsing to a project agent", async () => {
    await expect(resolveScoutMatchParticipantId(
      null,
      {} as NodeJS.ProcessEnv,
    )).rejects.toThrow("requires a live session identity");
  });

  test("rejects a malformed diagnostic session override", async () => {
    await expect(resolveScoutMatchParticipantId(
      "session:",
      {} as NodeJS.ProcessEnv,
    )).rejects.toThrow("not a valid Scout session address");
  });
});

describe("sendScoutMessage", () => {
  test("posts a durable message without creating an invocation", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const talkieRoot = join(workspaceRoot, "talkie");

    mkdirSync(join(talkieRoot, ".git"), { recursive: true });
    writeFileSync(join(talkieRoot, "AGENTS.md"), "# talkie\n", "utf8");

    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [workspaceRoot],
        includeCurrentRepo: false,
      },
    });

    const requests: Array<{ method: string; path: string }> = [];
    const captured = {
      postedMessage: null as {
        id: string;
        conversationId: string;
        audience?: { notify: string[]; reason: string };
        metadata?: { relayChannel?: string };
      } | null,
    };
    const snapshot = {
      actors: {} as Record<string, unknown>,
      agents: {} as Record<string, unknown>,
      endpoints: {} as Record<string, unknown>,
      conversations: {} as Record<string, unknown>,
      messages: {} as Record<string, unknown>,
      flights: {} as Record<string, unknown>,
    };

    globalThis.fetch = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse(snapshot);
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        const body = (await request.json()) as { id: string };
        snapshot.actors[body.id] = body;
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/agents") {
        const body = (await request.json()) as { id: string };
        snapshot.agents[body.id] = body;
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/conversations") {
        const body = (await request.json()) as { id: string };
        snapshot.conversations[body.id] = body;
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        const body = (await request.json()) as { requesterId: string; body: string };
        return jsonResponse({
          kind: "delivery",
          accepted: true,
          routeKind: "dm",
          conversation: {
            id: "dm.operator.talkie",
            kind: "direct",
            title: "Talkie",
            visibility: "private",
            authorityNodeId: "node-1",
            participantIds: ["operator", "talkie"],
          },
          message: {
            id: "msg-1",
            conversationId: "dm.operator.talkie",
            actorId: body.requesterId,
            originNodeId: "node-1",
            class: "agent",
            body: body.body,
            audience: {
              notify: ["talkie"],
              reason: "direct_message",
            },
            visibility: "private",
            policy: "durable",
            createdAt: Date.now(),
            metadata: {
              relayChannel: "dm",
            },
          },
          targetAgentId: "talkie",
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await sendScoutMessage({
      senderId: "operator",
      body: "@talkie hello",
      currentDirectory: workspaceRoot,
    });

    expect(result.usedBroker).toBe(true);
    expect(result.conversationId?.startsWith("dm.")).toBe(true);
    expect(result.messageId).toBeTruthy();
    expect(result.unresolvedTargets).toEqual([]);
    expect(result.invokedTargets).toHaveLength(1);
    expect(requests.some((request) => request.path === "/v1/deliver")).toBe(
      true,
    );
    expect(requests.some((request) => request.path === "/v1/messages")).toBe(
      false,
    );
    expect(requests.some((request) => request.path === "/v1/invocations")).toBe(
      false,
    );
  }, 15000);

  test.each([
    "plain channel update",
    "Review @openscout/scout",
    "Review @openscout/scout and @openscout/protocol",
    "@talkie this stays in the channel",
  ])("routes explicit-channel body as payload: %s", async (body) => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const talkieRoot = join(workspaceRoot, "talkie");
    mkdirSync(join(talkieRoot, ".git"), { recursive: true });
    writeFileSync(join(talkieRoot, "AGENTS.md"), "# talkie\n", "utf8");
    await writeOpenScoutSettings({
      discovery: { workspaceRoots: [workspaceRoot], includeCurrentRepo: false },
    });
    const naturalKey = namedChannelNaturalKey("huddle-v1");
    const canonicalId = stableChannelId(naturalKey);
    const captured: {
      conversation?: {
        id: string;
        participantIds: string[];
        metadata?: Record<string, unknown>;
      };
      message?: { conversationId: string; body: string; mentions?: unknown[]; audience?: unknown };
    } = {};
    const requests: string[] = [];
    const snapshot = {
      actors: {},
      agents: {},
      endpoints: {},
      conversations: {
        "channel.huddle-v1": {
          id: "channel.huddle-v1",
          kind: "channel",
          title: "huddle-v1",
          visibility: "workspace",
          shareMode: "local",
          authorityNodeId: "node-1",
          participantIds: ["legacy-agent", "operator"],
          metadata: { channel: "huddle-v1" },
        },
        [canonicalId]: {
          id: canonicalId,
          kind: "channel",
          title: "huddle-v1",
          visibility: "workspace",
          shareMode: "local",
          authorityNodeId: "node-1",
          participantIds: ["operator"],
          metadata: { channel: "huddle-v1", naturalKey },
        },
      },
      messages: {},
      flights: {},
    };

    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse(snapshot);
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/conversations") {
        captured.conversation = await request.json() as NonNullable<typeof captured.conversation>;
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        captured.message = await request.json() as NonNullable<typeof captured.message>;
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await sendScoutMessage({
      senderId: "operator",
      body,
      channel: "huddle-v1",
      currentDirectory: workspaceRoot,
    });

    expect(result.conversationId).toBe(canonicalId);
    expect(result.messageId).toBeTruthy();
    expect(result.unresolvedTargets).toEqual([]);
    expect(result.invokedTargets).toEqual([]);
    expect(requests).not.toContain("POST /v1/deliver");
    expect(requests).not.toContain("POST /v1/invocations");
    expect(requests).not.toContain("POST /v1/agents");
    expect(captured.message?.mentions).toEqual([]);
    expect(captured.message?.audience).toBeUndefined();
    expect(captured.conversation).toMatchObject({
      id: canonicalId,
      participantIds: ["legacy-agent", "operator"],
      metadata: { channel: "huddle-v1", naturalKey },
    });
    expect(captured.message).toMatchObject({
      conversationId: canonicalId,
      body,
    });
  });

  test("uses explicit send target as route intent and leaves body mentions as text", async () => {
    useIsolatedOpenScoutHome();

    const requests: string[] = [];
    const captured = {
      delivery: null as {
        id?: string;
        requesterId?: string;
        requesterNodeId?: string;
        caller?: { actorId?: string; nodeId?: string; currentDirectory?: string };
        target?: { kind?: string; label?: string };
        body?: string;
        intent?: string;
        ensureAwake?: boolean;
        execution?: unknown;
        messageMetadata?: Record<string, unknown>;
        invocationMetadata?: Record<string, unknown>;
        createdAt?: number;
      } | null,
    };

    globalThis.fetch = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        captured.delivery = await request.json() as NonNullable<typeof captured.delivery>;
        return jsonResponse({
          kind: "delivery",
          accepted: true,
          routeKind: "dm",
          conversation: {
            id: "dm.operator.hudson",
            kind: "direct",
            title: "Hudson",
            visibility: "private",
            authorityNodeId: "node-1",
            participantIds: ["operator", "hudson.main"],
          },
          message: {
            id: "msg-1",
            conversationId: "dm.operator.hudson",
            actorId: "operator",
            originNodeId: "node-1",
            class: "agent",
            body: captured.delivery.body,
            audience: {
              notify: ["hudson.main"],
              reason: "direct_message",
            },
            visibility: "private",
            policy: "durable",
            createdAt: Date.now(),
          },
          targetAgentId: "hudson.main",
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await sendScoutMessage({
      senderId: "operator",
      targetLabel: "hudson",
      body: "status references literal @codex and should still route",
      currentDirectory: "/worktree/project",
    });

    expect(result.usedBroker).toBe(true);
    expect(result.invokedTargets).toEqual(["hudson.main"]);
    expect(captured.delivery?.target).toEqual({
      kind: "agent_label",
      label: "hudson",
    });
    expect(captured.delivery?.body).toBe(
      "status references literal @codex and should still route",
    );
    expect(captured.delivery?.intent).toBe("tell");
    expect(captured.delivery?.ensureAwake).toBeUndefined();
    expect(captured.delivery?.execution).toBeUndefined();
    expect(captured.delivery?.messageMetadata).toEqual({
      source: "scout-cli",
    });
    expect(captured.delivery?.invocationMetadata).toBeUndefined();
    expect(captured.delivery?.requesterId).toBeUndefined();
    expect(captured.delivery?.requesterNodeId).toBeUndefined();
    expect(captured.delivery?.id).toBeUndefined();
    expect(captured.delivery?.createdAt).toBeUndefined();
    expect(captured.delivery?.caller).toMatchObject({
      actorId: "operator",
      nodeId: "node-1",
      currentDirectory: "/worktree/project",
    });
    expect(requests).toEqual([
      "GET /health",
      // Identity scope for sender resolution — not the full registry.
      "GET /v1/node",
      "GET /v1/snapshot",
      "POST /v1/actors",
      "POST /v1/deliver",
    ]);
  }, 15000);

  test("uses target handles as typed send route intent", async () => {
    useIsolatedOpenScoutHome();

    const captured = {
      delivery: null as {
        target?: unknown;
        targetLabel?: string;
        body?: string;
        intent?: string;
        execution?: unknown;
      } | null,
    };

    globalThis.fetch = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        captured.delivery = await request.json() as NonNullable<typeof captured.delivery>;
        return jsonResponse({
          kind: "delivery",
          accepted: true,
          routeKind: "dm",
          conversation: {
            id: "dm.operator.session",
            kind: "direct",
            title: "Mission Writer Talkie",
            visibility: "private",
            authorityNodeId: "node-1",
            participantIds: ["operator", "session-mw-talkie"],
          },
          message: {
            id: "msg-1",
            conversationId: "dm.operator.session",
            actorId: "operator",
            originNodeId: "node-1",
            class: "agent",
            body: captured.delivery.body,
            audience: {
              notify: ["session-mw-talkie"],
              reason: "direct_message",
            },
            visibility: "private",
            policy: "durable",
            createdAt: Date.now(),
          },
          targetAgentId: "session-mw-talkie",
          targetSessionId: "session-mw-talkie",
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await sendScoutMessage({
      senderId: "operator",
      targetLabel: "target:mw-talkie",
      body: "status update for that worker",
      currentDirectory: "/worktree/project",
    });

    expect(result.usedBroker).toBe(true);
    expect(result.invokedTargets).toEqual(["session-mw-talkie"]);
    expect(captured.delivery?.target).toEqual({
      kind: "target_handle",
      handle: "mw-talkie",
      value: "target:mw-talkie",
    });
    expect(captured.delivery?.targetLabel).toBe("target:mw-talkie");
    expect(captured.delivery?.body).toBe("status update for that worker");
    expect(captured.delivery?.intent).toBe("tell");
    expect(captured.delivery?.execution).toBeUndefined();
  }, 15000);

  test("uses session ids from match output as typed send route intent", async () => {
    useIsolatedOpenScoutHome();

    const captured = {
      delivery: null as {
        target?: unknown;
        targetLabel?: string;
        body?: string;
      } | null,
    };

    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        captured.delivery = await request.json() as NonNullable<typeof captured.delivery>;
        return jsonResponse({
          kind: "delivery",
          accepted: true,
          routeKind: "dm",
          conversation: {
            id: "dm.operator.session",
            kind: "direct",
            title: "Matched session",
            visibility: "private",
            authorityNodeId: "node-1",
            participantIds: ["operator", "peer-agent"],
          },
          message: {
            id: "msg-1",
            conversationId: "dm.operator.session",
            actorId: "operator",
            originNodeId: "node-1",
            class: "agent",
            body: captured.delivery.body,
            audience: {
              notify: ["peer-agent"],
              reason: "direct_message",
            },
            visibility: "private",
            policy: "durable",
            createdAt: Date.now(),
          },
          targetAgentId: "peer-agent",
          targetSessionId: "claude-session-1",
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await sendScoutMessage({
      senderId: "operator",
      targetLabel: "session:claude-session-1",
      body: "matched handoff",
      currentDirectory: "/worktree/project",
    });

    expect(result.usedBroker).toBe(true);
    expect(result.invokedTargets).toEqual(["peer-agent"]);
    expect(captured.delivery?.target).toEqual({
      kind: "session_id",
      sessionId: "claude-session-1",
      value: "session:claude-session-1",
    });
    expect(captured.delivery?.targetLabel).toBe("session:claude-session-1");
    expect(captured.delivery?.body).toBe("matched handoff");
  }, 15000);

  test("routes a single explicit target id through broker delivery", async () => {
    useIsolatedOpenScoutHome();

    const captured = {
      delivery: null as {
        caller?: { actorId?: string; nodeId?: string; currentDirectory?: string };
        target?: { kind?: string; agentId?: string };
        body?: string;
        intent?: string;
        ensureAwake?: boolean;
        messageMetadata?: Record<string, unknown>;
        invocationMetadata?: Record<string, unknown>;
      } | null,
    };

    globalThis.fetch = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {
            "hudson.main": {
              id: "hudson.main",
              kind: "agent",
              displayName: "Hudson",
              handle: "hudson",
              selector: "@hudson",
              defaultSelector: "@hudson",
              homeNodeId: "node-1",
              authorityNodeId: "node-1",
              wakePolicy: "on_demand",
            },
          },
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        captured.delivery = await request.json() as NonNullable<typeof captured.delivery>;
        return jsonResponse({
          kind: "delivery",
          accepted: true,
          routeKind: "dm",
          conversation: {
            id: "dm.operator.hudson",
            kind: "direct",
            title: "Hudson",
            visibility: "private",
            authorityNodeId: "node-1",
            participantIds: ["operator", "hudson.main"],
          },
          message: {
            id: "msg-1",
            conversationId: "dm.operator.hudson",
            actorId: "operator",
            originNodeId: "node-1",
            class: "agent",
            body: captured.delivery.body,
            audience: {
              notify: ["hudson.main"],
              reason: "direct_message",
            },
            visibility: "private",
            policy: "durable",
            createdAt: Date.now(),
          },
          targetAgentId: "hudson.main",
          flight: {
            id: "flt-1",
            invocationId: "inv-1",
            requesterId: "operator",
            targetAgentId: "hudson.main",
            state: "waking",
          },
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await sendScoutMessageToAgentIds({
      senderId: "operator",
      targetAgentIds: ["hudson.main"],
      body: "please look when you can",
      currentDirectory: "/worktree/project",
      source: "scout-mcp",
    });

    expect(result.usedBroker).toBe(true);
    expect(result.invokedTargetIds).toEqual(["hudson.main"]);
    expect(result.flight?.id).toBe("flt-1");
    expect(captured.delivery?.target).toEqual({
      kind: "agent_id",
      agentId: "hudson.main",
    });
    expect(captured.delivery?.intent).toBe("tell");
    expect(captured.delivery?.ensureAwake).toBeUndefined();
    expect(captured.delivery?.messageMetadata).toEqual({
      source: "scout-mcp",
    });
    expect(captured.delivery?.invocationMetadata).toEqual({
      source: "scout-mcp",
    });
  }, 15000);

  test("can post a tell and wake the target asynchronously", async () => {
    useIsolatedOpenScoutHome();

    const captured = {
      delivery: null as {
        caller?: { actorId?: string; nodeId?: string; currentDirectory?: string };
        target?: { kind?: string; label?: string };
        body?: string;
        intent?: string;
        ensureAwake?: boolean;
        execution?: unknown;
        messageMetadata?: Record<string, unknown>;
        invocationMetadata?: Record<string, unknown>;
      } | null,
    };

    globalThis.fetch = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        captured.delivery = await request.json() as NonNullable<typeof captured.delivery>;
        return jsonResponse({
          kind: "delivery",
          accepted: true,
          routeKind: "dm",
          conversation: {
            id: "dm.operator.hudson",
            kind: "direct",
            title: "Hudson",
            visibility: "private",
            authorityNodeId: "node-1",
            participantIds: ["operator", "hudson.main"],
          },
          message: {
            id: "msg-1",
            conversationId: "dm.operator.hudson",
            actorId: "operator",
            originNodeId: "node-1",
            class: "agent",
            body: captured.delivery.body,
            audience: {
              notify: ["hudson.main"],
              reason: "direct_message",
            },
            visibility: "private",
            policy: "durable",
            createdAt: Date.now(),
          },
          targetAgentId: "hudson.main",
          flight: {
            id: "flt-1",
            invocationId: "inv-1",
            requesterId: "operator",
            targetAgentId: "hudson.main",
            state: "working",
          },
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const result = await sendScoutMessage({
      senderId: "operator",
      targetLabel: "hudson",
      body: "please process this when you can",
      currentDirectory: "/worktree/project",
      wake: true,
      executionHarness: "claude",
    });

    expect(result.usedBroker).toBe(true);
    expect(result.invokedTargets).toEqual(["hudson.main"]);
    expect(result.flight?.id).toBe("flt-1");
    expect(captured.delivery?.target).toEqual({
      kind: "agent_label",
      label: "hudson",
    });
    expect(captured.delivery?.intent).toBe("consult");
    expect(captured.delivery?.ensureAwake).toBe(true);
    expect(captured.delivery?.execution).toEqual({
      session: "new",
      harness: "claude",
    });
    expect(captured.delivery?.messageMetadata).toEqual({
      source: "scout-cli",
      wake: true,
    });
    expect(captured.delivery?.invocationMetadata).toEqual({
      source: "scout-cli",
      sourceIntent: "tell_wake",
    });
  }, 15000);

  test("fails closed when a mention target is unresolved", async () => {
    const currentDirectory = useIsolatedOpenScoutHome();

    const requests: Array<{ method: string; path: string }> = [];
    globalThis.fetch = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/deliver") {
        return jsonResponse({
          kind: "rejected",
          accepted: false,
          reason: "unknown_target",
          rejection: {
            id: "dispatch-unknown",
            kind: "unknown",
            askedLabel: "@missing",
            detail: "no agent matches @missing",
            candidates: [],
            dispatchedAt: Date.now(),
            dispatcherNodeId: "node-1",
          },
        });
      }

      return jsonResponse({ ok: true });
    }) as typeof fetch;

    const result = await sendScoutMessage({
      senderId: "operator",
      body: "@missing hello",
      currentDirectory,
    });

    expect(result.usedBroker).toBe(true);
    expect(result.invokedTargets).toEqual([]);
    expect(result.unresolvedTargets).toEqual(["@missing"]);
    expect(result.targetDiagnostic?.state).toBe("unknown");
    expect(requests.some((request) => request.path === "/v1/deliver")).toBe(
      true,
    );
    expect(requests.some((request) => request.path === "/v1/messages")).toBe(
      false,
    );
    expect(
      requests.some((request) => request.path === "/v1/conversations"),
    ).toBe(false);
    expect(requests.some((request) => request.path === "/v1/invocations")).toBe(
      false,
    );
  }, 15000);

  test("fails closed when send has no explicit destination", async () => {
    useIsolatedOpenScoutHome();

    const requests: Array<{ method: string; path: string }> = [];
    globalThis.fetch = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        return jsonResponse({ ok: true });
      }

      return jsonResponse({ ok: true });
    }) as typeof fetch;

    const result = await sendScoutMessage({
      senderId: "operator",
      body: "hello without an addressee",
      currentDirectory: process.cwd(),
    });

    expect(result.usedBroker).toBe(true);
    expect(result.routingError).toBe("missing_destination");
    expect(result.invokedTargets).toEqual([]);
    expect(result.unresolvedTargets).toEqual([]);
    expect(requests.some((request) => request.path === "/v1/messages")).toBe(
      false,
    );
    expect(
      requests.some((request) => request.path === "/v1/conversations"),
    ).toBe(false);
  }, 15000);

  test("fails closed when send mentions multiple agents without an explicit channel", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const talkieRoot = join(workspaceRoot, "talkie");
    const hudsonRoot = join(workspaceRoot, "hudson");

    mkdirSync(join(talkieRoot, ".git"), { recursive: true });
    writeFileSync(join(talkieRoot, "AGENTS.md"), "# talkie\n", "utf8");
    mkdirSync(join(hudsonRoot, ".git"), { recursive: true });
    writeFileSync(join(hudsonRoot, "AGENTS.md"), "# hudson\n", "utf8");

    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [workspaceRoot],
        includeCurrentRepo: false,
      },
    });

    const requests: Array<{ method: string; path: string }> = [];
    globalThis.fetch = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/actors") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/agents") {
        return jsonResponse({ ok: true });
      }

      return jsonResponse({ ok: true });
    }) as typeof fetch;

    const result = await sendScoutMessage({
      senderId: "operator",
      body: "@talkie @hudson please review this",
      currentDirectory: workspaceRoot,
    });

    expect(result.usedBroker).toBe(true);
    expect(result.routingError).toBe(
      "multi_target_requires_explicit_channel",
    );
    expect(result.invokedTargets).toEqual([]);
    expect(result.unresolvedTargets).toEqual([]);
    expect(requests.some((request) => request.path === "/v1/messages")).toBe(
      false,
    );
    expect(
      requests.some((request) => request.path === "/v1/conversations"),
    ).toBe(false);
  }, 15000);
});

describe("watchScoutMessages", () => {
  test("does not suppress messages from the same actor id", async () => {
    useIsolatedOpenScoutHome();

    const encoder = new TextEncoder();
    const received: Array<{ actorId: string; body: string }> = [];

    globalThis.fetch = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "GET" && url.pathname === "/v1/events/stream") {
        const payload = JSON.stringify({
          kind: "message.posted",
          payload: {
            message: {
              id: "m-1",
              conversationId: stableChannelId(namedChannelNaturalKey("broadcast")),
              actorId: "scout.main.mini",
              body: "hello from a sibling session",
              class: "agent",
              createdAt: Date.now(),
            },
          },
        });
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(`event: message.posted\ndata: ${payload}\n\n`),
              );
              controller.close();
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
            },
          },
        );
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    await watchScoutMessages({
      channel: "shared",
      onMessage(message) {
        received.push({ actorId: message.actorId, body: message.body });
      },
    });

    expect(received).toEqual([
      {
        actorId: "scout.main.mini",
        body: "hello from a sibling session",
      },
    ]);
  });

  test("filters messages by explicit conversation id", async () => {
    useIsolatedOpenScoutHome();

    const encoder = new TextEncoder();
    const received: string[] = [];

    globalThis.fetch = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {},
          agents: {},
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "GET" && url.pathname === "/v1/events/stream") {
        const matchingPayload = JSON.stringify({
          kind: "message.posted",
          payload: {
            message: {
              id: "m-1",
              conversationId: "dm.operator.hudson",
              actorId: "hudson",
              body: "matching",
              class: "agent",
              createdAt: Date.now(),
            },
          },
        });
        const otherPayload = JSON.stringify({
          kind: "message.posted",
          payload: {
            message: {
              id: "m-2",
              conversationId: "channel.shared",
              actorId: "hudson",
              body: "other",
              class: "agent",
              createdAt: Date.now(),
            },
          },
        });
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(`event: message.posted\ndata: ${otherPayload}\n\n`),
              );
              controller.enqueue(
                encoder.encode(`event: message.posted\ndata: ${matchingPayload}\n\n`),
              );
              controller.close();
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
            },
          },
        );
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    await watchScoutMessages({
      conversationId: "dm.operator.hudson",
      onMessage(message) {
        received.push(message.body);
      },
    });

    expect(received).toEqual(["matching"]);
  });
});

describe("loadScoutBrokerContextResult", () => {
  test("reports snapshot_read_failed with detail when /v1/snapshot errors", async () => {
    useIsolatedOpenScoutHome();
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requested.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (url.pathname === "/v1/snapshot") {
        return jsonResponse({ error: "snapshot exploded" }, 500);
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as unknown as typeof fetch;

    const result = await loadScoutBrokerContextResult();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("snapshot_read_failed");
      expect(result.detail).toContain("500");
    }
    expect(requested).toContain("GET /v1/node");
    expect(requested).toContain("GET /v1/snapshot");
  });

  test("reports node_read_failed when /v1/node errors while the broker is healthy", async () => {
    useIsolatedOpenScoutHome();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (url.pathname === "/v1/node") {
        return jsonResponse({ error: "node exploded" }, 502);
      }
      if (url.pathname === "/v1/snapshot") {
        return jsonResponse(createRuntimeRegistrySnapshot());
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as unknown as typeof fetch;

    const result = await loadScoutBrokerContextResult();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("node_read_failed");
      expect(result.detail).toContain("502");
    }
  });

  test("reports health_failed when the broker cannot be reached", async () => {
    useIsolatedOpenScoutHome();
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    const result = await loadScoutBrokerContextResult();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("health_failed");
    }
  });

  test("the exact-sender ask path posts one command without preflight", async () => {
    useIsolatedOpenScoutHome();
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requested.push(`${request.method} ${url.pathname}${url.search}`);
      if (url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (url.pathname === "/v1/snapshot") {
        return jsonResponse(createRuntimeRegistrySnapshot());
      }
      if (url.pathname === "/v1/actors" && request.method === "POST") {
        return jsonResponse({ ok: true });
      }
      if (url.pathname === "/v1/deliver" && request.method === "POST") {
        return jsonResponse({
          kind: "delivery",
          accepted: true,
          routeKind: "dm",
          conversation: {
            id: "dm.operator.agent-1",
            kind: "direct",
            title: "Agent One",
            visibility: "private",
            authorityNodeId: "node-1",
            participantIds: ["operator", "agent-1"],
          },
          message: {
            id: "msg-1",
            conversationId: "dm.operator.agent-1",
            actorId: "operator",
            originNodeId: "node-1",
            class: "operator",
            body: "hi",
            visibility: "private",
            policy: "durable",
            createdAt: Date.now(),
          },
          flight: {
            id: "flt-1",
            invocationId: "inv-1",
            requesterId: "operator",
            targetAgentId: "agent-1",
            state: "waking",
            startedAt: Date.now(),
          },
        });
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as unknown as typeof fetch;

    const result = await deliverScoutAsk({
      senderId: "operator",
      target: { kind: "agent_id", agentId: "agent-1" },
      body: "hi",
      currentDirectory: "/tmp",
    });

    expect(result.usedBroker).toBe(true);
    expect(result.flight?.id).toBe("flt-1");
    expect(requested).toEqual(["POST /v1/deliver"]);
  });

  test("work asks preserve the complete command payload across retries with one request id", async () => {
    useIsolatedOpenScoutHome();
    const payloads: ScoutDeliverRequest[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(`${request.method} ${new URL(request.url).pathname}`).toBe("POST /v1/deliver");
      payloads.push(await request.json() as ScoutDeliverRequest);
      return jsonResponse({ kind: "delivery", accepted: true,
        conversation: { id: "dm.operator.agent-1" }, message: { id: "msg-stable" },
        flight: { id: "flt-stable", state: "queued" } });
    }) as typeof fetch;
    const command = { requestId: "work-retry", senderId: "operator",
      target: { kind: "agent_id" as const, agentId: "agent-1" }, body: "Do the work",
      workItem: { title: "Keep this exact work" }, currentDirectory: "/tmp" };
    await deliverScoutAsk({ ...command, createdAtMs: 1 });
    await deliverScoutAsk({ ...command, createdAtMs: 2 });
    expect(payloads[0]).toEqual(payloads[1]);
    const id = payloads[0]!.workItem!.id;
    expect(id).toMatch(/^work-request-[a-f0-9]{64}$/);
    expect(payloads[0]!.messageMetadata?.collaborationRecordId).toBe(id);
    expect(payloads[0]!.invocationMetadata?.workId).toBe(id);
    await deliverScoutAsk({ ...command, senderId: "other-caller" });
    await deliverScoutAsk({ ...command, requestId: "another-command" });
    expect(payloads[2]!.workItem!.id).not.toBe(id);
    expect(payloads[3]!.workItem!.id).not.toBe(id);
    await deliverScoutAsk({ ...command, requestId: undefined, createdAtMs: 1 });
    await deliverScoutAsk({ ...command, requestId: undefined, createdAtMs: 1 });
    expect(payloads[4]!.workItem!.id).not.toBe(payloads[5]!.workItem!.id);
  });

  test("a profile ask posts one command without depending on snapshot health", async () => {
    useIsolatedOpenScoutHome();
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requested.push(`${request.method} ${url.pathname}${url.search}`);
      if (url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (url.pathname === "/v1/snapshot") {
        // The full registry is broken; the identity scope is all this route
        // needs.
        if (url.searchParams.get("scope") !== "identity") {
          return jsonResponse({ error: "snapshot exploded" }, 500);
        }
        return jsonResponse({
          actors: {},
          agents: {},
          nodes: {},
        });
      }
      if (url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (url.pathname === "/v1/actors" && request.method === "POST") {
        return jsonResponse({ ok: true });
      }
      if (url.pathname === "/v1/deliver" && request.method === "POST") {
        return jsonResponse({
          kind: "delivery",
          accepted: true,
          routeKind: "dm",
          conversation: {
            id: "dm.operator.fable",
            kind: "direct",
            title: "Fable",
            visibility: "private",
            authorityNodeId: "node-1",
            participantIds: ["operator", "fable"],
          },
          message: {
            id: "msg-1",
            conversationId: "dm.operator.fable",
            actorId: "operator",
            originNodeId: "node-1",
            class: "operator",
            body: "do the thing",
            visibility: "private",
            policy: "durable",
            createdAt: Date.now(),
          },
          flight: {
            id: "flt-profile",
            invocationId: "inv-profile",
            requesterId: "operator",
            targetAgentId: "fable",
            state: "waking",
            startedAt: Date.now(),
          },
        });
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as unknown as typeof fetch;

    const result = await deliverScoutAsk({
      senderId: "operator",
      target: { kind: "runtime_profile", profile: "fable", projectPath: "/tmp" },
      body: "do the thing",
      currentDirectory: "/tmp",
    });

    expect(result.usedBroker).toBe(true);
    expect(result.flight?.id).toBe("flt-profile");
    expect(requested).toEqual(["POST /v1/deliver"]);
  });

  test("a profile ask resolves the registered sender without re-posting the actor", async () => {
    useIsolatedOpenScoutHome();
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requested.push(`${request.method} ${url.pathname}${url.search}`);
      if (url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (url.pathname === "/v1/snapshot") {
        expect(url.searchParams.get("scope")).toBe("identity");
        return jsonResponse({
          nodes: {},
          actors: {
            operator: {
              id: "operator",
              kind: "person",
              displayName: "Operator",
              labels: ["primary-operator"],
              metadata: { pronouns: "they/them" },
            },
          },
          agents: {},
        });
      }
      if (url.pathname === "/v1/actors" && request.method === "POST") {
        return jsonResponse({ ok: true });
      }
      if (url.pathname === "/v1/deliver" && request.method === "POST") {
        return jsonResponse({
          kind: "delivery",
          accepted: true,
          routeKind: "dm",
          conversation: {
            id: "dm.operator.fable",
            kind: "direct",
            title: "Fable",
            visibility: "private",
            authorityNodeId: "node-1",
            participantIds: ["operator", "fable"],
          },
          message: {
            id: "msg-1",
            conversationId: "dm.operator.fable",
            actorId: "operator",
            originNodeId: "node-1",
            class: "operator",
            body: "do the thing",
            visibility: "private",
            policy: "durable",
            createdAt: Date.now(),
          },
          flight: {
            id: "flt-profile",
            invocationId: "inv-profile",
            requesterId: "operator",
            targetAgentId: "fable",
            state: "waking",
            startedAt: Date.now(),
          },
        });
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as unknown as typeof fetch;

    const result = await deliverScoutAsk({
      senderId: "operator",
      senderResolution: "legacy",
      target: { kind: "runtime_profile", profile: "fable", projectPath: "/tmp" },
      body: "do the thing",
      currentDirectory: "/tmp",
    });

    expect(result.usedBroker).toBe(true);
    expect(requested).toContain("GET /v1/snapshot?scope=identity");
    // The registered actor row satisfied sender resolution — no synthesized
    // upsert replaced its labels/metadata.
    expect(requested.some((entry) => entry === "POST /v1/actors")).toBe(false);
  });
});

describe("scoutAskHandler preflight diagnostics", () => {
  test("a snapshot read failure reports preflight_failed, not broker_unreachable", async () => {
    useIsolatedOpenScoutHome();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (url.pathname === "/v1/snapshot") {
        return jsonResponse({ error: "snapshot exploded" }, 500);
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as unknown as typeof fetch;

    const receipt = await scoutAskHandler({
      senderId: "operator",
      senderResolution: "legacy",
      to: "agent-1",
      body: "hi",
      currentDirectory: "/tmp",
    });

    expect(receipt.ok).toBe(false);
    expect(receipt.error?.code).toBe("preflight_failed");
    expect(receipt.error?.message).toContain("/v1/snapshot");
    expect(receipt.error?.message).toContain("safe to retry");
  });

  test("a direct command transport failure remains uncertain instead of claiming preflight rejection", async () => {
    useIsolatedOpenScoutHome();
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    await expect(scoutAskHandler({
      senderId: "operator",
      to: "agent-1",
      body: "hi",
      currentDirectory: "/tmp",
    })).rejects.toThrow("connection refused");
  });
});


describe("explicit completion client fences", () => {
  const completion = { mode: "explicit" as const };
  const replyCompletion = { kind: "final" as const, invocationId: "inv-1", flightId: "flt-1", revision: 3 };
  const command = { senderId: "operator", target: { kind: "agent_id" as const, agentId: "agent-1" },
    body: "Review this", currentDirectory: "/tmp", completion, requestId: "ask-1" };

  test("rejects unsupported capability before delivering or registering a sender", async () => {
    useIsolatedOpenScoutHome();
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requested.push(`${request.method} ${new URL(request.url).pathname}`);
      return jsonResponse({ id: "node-1", capabilities: ["broker"] });
    }) as typeof fetch;
    await expect(deliverScoutAsk({ ...command, senderResolution: "legacy" })).rejects.toThrow("explicit-completion/1");
    expect(requested).toEqual(["GET /v1/node"]);
  });

  test("fences typed asks on the wire and returns own and parent revisions", async () => {
    useIsolatedOpenScoutHome();
    let payload: Record<string, any> | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/v1/node") {
        return jsonResponse({ id: "node-1", capabilities: ["explicit-completion/1"] });
      }
      expect(new URL(request.url).pathname).toBe("/v1/deliver");
      payload = await request.json() as Record<string, any>;
      return jsonResponse({ kind: "delivery", accepted: true,
        conversation: { id: "dm.test" }, message: { id: "msg-1" },
        flight: { id: "flt-1", invocationId: "inv-1", targetAgentId: "agent-1", state: "queued",
          metadata: { completion: { version: 1, revision: 0, obligations: [] },
            parentCompletion: { flightId: "flt-parent", revision: 2 } } } });
    }) as typeof fetch;
    const receipt = await scoutAskHandler({ senderId: "operator", to: "id:agent-1", body: "Review this",
      requestId: "child-1", completion, relation: { kind: "joined", parentFlightId: "flt-parent" },
      senderContext: { agentId: "operator" }, currentDirectory: "/tmp" });
    expect(payload).toMatchObject({ intent: "explicit_consult", requestId: "child-1", completion,
      relation: { kind: "joined", parentFlightId: "flt-parent" } });
    expect(receipt).toMatchObject({ ok: true, completion: { version: 1, revision: 0, obligations: [],
      invocationId: "inv-1", flightId: "flt-1" },
      parentCompletion: { flightId: "flt-parent", revision: 2 } });
  });

  test("CLI generates a retry key and sends completion relation flags through the command handler", async () => {
    const workspaceRoot = useIsolatedOpenScoutHome();
    let payload: Record<string, any> | undefined;
    const diagnostics: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/v1/node") {
        return jsonResponse({ id: "node-1", capabilities: ["explicit-completion/1"] });
      }
      expect(new URL(request.url).pathname).toBe("/v1/deliver");
      payload = await request.json() as Record<string, any>;
      return jsonResponse({ kind: "delivery", accepted: true, conversation: { id: "dm.test" }, message: { id: "msg-1" },
        flight: { id: "flt-1", invocationId: "inv-1", targetAgentId: "agent-1", state: "queued",
          metadata: { completion: { version: 1, revision: 0, obligations: [] } } } });
    }) as typeof fetch;
    await runAskCommand(createScoutCommandContext({ cwd: workspaceRoot, env: {}, stdout: () => {},
      stderr: (message) => { diagnostics.push(message); } }),
      ["--as", "operator", "--to", "id:agent-1", "--completion", "explicit", "--join-to", "parent-1", "--notify", "Review"]);
    expect(payload).toMatchObject({ intent: "explicit_consult", completion, relation: { kind: "joined", parentFlightId: "parent-1" } });
    expect(payload?.requestId).toMatch(/^ask-/);
    expect(diagnostics.some((line) => line.includes(payload!.requestId))).toBe(true);
  });

  test("rejects launch and alias routes and missing relation identity before network effects", async () => {
    useIsolatedOpenScoutHome();
    let requests = 0;
    globalThis.fetch = (async () => { requests++; throw new Error("unexpected network"); }) as unknown as typeof fetch;
    for (const target of [{ to: "alias:review" }, { to: "reviewer" }, { projectPath: "/tmp/project" },
      { runtimeProfile: "opus" }, { to: "id:agent-1", harness: "codex" as const }]) {
      const result = await scoutAskHandler({ senderId: "operator", body: "Review", completion, ...target });
      expect(result.error?.code).toBe("invalid_request");
    }
    const missingId = await scoutAskHandler({ senderId: "operator", to: "id:agent-1", body: "Review",
      relation: { kind: "joined", parentFlightId: "parent" } });
    expect(missingId.error?.message).toContain("stable requestId");
    expect(requests).toBe(0);
  });

  function mockReplyBroker(options: { capability?: boolean; replyStatus?: number; post?: (message: MessageRecord) => Response } = {}) {
    useIsolatedOpenScoutHome();
    const snapshot = createRuntimeRegistrySnapshot();
    snapshot.actors["agent-1"] = { id: "agent-1", kind: "agent", displayName: "Worker" };
    snapshot.conversations["dm.test"] = { id: "dm.test", kind: "direct", title: "Review", visibility: "private", shareMode: "local",
      authorityNodeId: "node-1", participantIds: ["operator", "agent-1"] };
    snapshot.messages["msg-original"] = { id: "msg-original", conversationId: "dm.test", actorId: "operator",
      originNodeId: "node-1", class: "agent", body: "Review", visibility: "private", policy: "durable", createdAt: 1 };
    const posts: { path: string; body: Record<string, any> }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/health") return jsonResponse({ ok: true, nodeId: "node-1" });
      if (path === "/v1/node") return jsonResponse({ id: "node-1", capabilities: options.capability === false ? [] : ["explicit-completion/1"] });
      if (path === "/v1/snapshot") return jsonResponse(snapshot);
      if (request.method === "POST") {
        const body = await request.json() as Record<string, any>;
        posts.push({ path, body });
        if (options.post) return options.post(body as MessageRecord);
        return options.replyStatus ? jsonResponse({ error: "old broker" }, options.replyStatus) : jsonResponse({ ok: true, message: body });
      }
      return jsonResponse({ error: "unknown" }, 404);
    }) as typeof fetch;
    return posts;
  }
  const reply = { senderId: "agent-1", body: "Finished", conversationId: "dm.test", replyToMessageId: "msg-original",
    completion: replyCompletion, requestId: "final-1", currentDirectory: "/tmp" };

  test("retries typed replies on the dedicated endpoint with stable message and return identities", async () => {
    const posts = mockReplyBroker();
    const first = await replyToScoutMessage({ ...reply, createdAtMs: 100 });
    const retry = await replyToScoutMessage({ ...reply, createdAtMs: 200 });
    expect(posts.map((post) => post.path)).toEqual(["/v1/messages/reply", "/v1/messages/reply"]);
    expect(first.messageId).toBe(retry.messageId);
    expect(posts[0]?.body).toMatchObject({ requestId: "final-1", metadata: { completionReply: replyCompletion } });
    expect(posts[0]?.body.metadata).toEqual(posts[1]?.body.metadata);
  });

  test("attachment replies reconcile a lost receipt and still reject changed content with the same retry key", async () => {
    let stored: MessageRecord | undefined;
    const posts = mockReplyBroker({ post: (incoming) => {
      // The HTTP route canonicalizes the client key before the real broker retry predicate.
      const message = { ...incoming, metadata: { ...incoming.metadata, clientMessageId: incoming.id } };
      if (!stored) {
        stored = message;
        return jsonResponse({ error: "accepted but receipt lost" }, 503);
      }
      if (!isIdempotentMessageRetry(stored, message)) return jsonResponse({ error: "conflicting retry" }, 400);
      return jsonResponse({ ok: true, message: stored, duplicate: true });
    } });
    const attachments = [{ mediaType: "text/plain", url: "https://example.test/result.txt" },
      { id: "caller-supplied", mediaType: "image/png", url: "https://example.test/chart.png" }];
    await expect(replyToScoutMessage({ ...reply, attachments, createdAtMs: 100 })).rejects.toThrow();
    const retry = await replyToScoutMessage({ ...reply, attachments, createdAtMs: 200 });
    expect(retry.messageId).toBe(stored!.id);
    expect(posts[0]!.body.attachments).toEqual(posts[1]!.body.attachments);
    expect(stored!.attachments?.[1]?.id).toBe("caller-supplied");
    await expect(replyToScoutMessage({ ...reply, attachments: [{ ...attachments[0]!, url: "https://example.test/changed.txt" }, attachments[1]!] }))
      .rejects.toThrow();
    expect(stored!.attachments?.[0]?.url).toBe("https://example.test/result.txt");
  });

  test("typed replies fail closed without a broker context and perform no writes", async () => {
    useIsolatedOpenScoutHome();
    const methods: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      methods.push(new Request(input, init).method);
      throw new Error("broker offline");
    }) as unknown as typeof fetch;
    await expect(replyToScoutMessage(reply)).rejects.toThrow("broker context is unavailable");
    expect(methods).not.toContain("POST");
  });

  test("does not downgrade typed replies when capability is absent or the broker is replaced", async () => {
    let posts = mockReplyBroker({ capability: false });
    await expect(replyToScoutMessage(reply)).rejects.toThrow("explicit-completion/1");
    expect(posts).toEqual([]);
    posts = mockReplyBroker({ replyStatus: 404 });
    await expect(replyToScoutMessage(reply)).rejects.toThrow();
    expect(posts.map((post) => post.path)).toEqual(["/v1/messages/reply"]);
  });

  test("keeps legacy threaded replies on their existing endpoint", async () => {
    const posts = mockReplyBroker({ capability: false });
    await replyToScoutMessage({ ...reply, completion: undefined, requestId: undefined });
    expect(posts.map((post) => post.path)).toEqual(["/v1/messages"]);
    expect(posts[0]?.body.metadata.completionReply).toBeUndefined();
  });
});
