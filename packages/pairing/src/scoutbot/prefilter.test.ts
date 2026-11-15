import { afterAll, describe, expect, mock, test } from "bun:test";

// /flight falls back to the durable store for flights the broker's hot set
// rotated out — stub it so tests never open the real control-plane database.
let durableFlightResult: Record<string, unknown> | null = null;
mock.module("../db-queries.ts", () => ({
  queryFlightRecordById: () => durableFlightResult,
}));

const { prefilterHandle } = await import("./prefilter.ts");

mock.restore();

afterAll(() => {
  mock.restore();
});

describe("scoutbot prefilter", () => {
  test("/flight falls back to SQLite for a flight rotated out of the broker hot set", () => {
    durableFlightResult = {
      id: "flight-rotated",
      invocationId: "inv-rotated",
      requesterId: "operator",
      targetAgentId: "hudson",
      state: "completed",
      summary: "rotated completion",
      output: "all done",
      startedAt: 1000,
      completedAt: 2000,
      metadata: {},
    };
    try {
      const reply = prefilterHandle("/flight flight-rotated", {
        actors: {},
        agents: {},
        endpoints: {},
        conversations: {},
        messages: {},
        nodes: {},
        flights: {},
      }, 5000);

      expect(reply?.metadata).toMatchObject({ matched_rule: "slash.flight" });
      expect(reply?.body).toContain("rotated completion");
      expect(reply?.body).toContain("wound down");
      expect(reply?.body).toContain("id flight-rotated");
      expect(reply?.body).toContain("output: all done");
    } finally {
      durableFlightResult = null;
    }
  });

  test("answers /agents with matched rule metadata (hands as work facets)", () => {
    const reply = prefilterHandle("/agents", {
      actors: {},
      agents: {
        hudson: {
          id: "hudson",
          kind: "agent",
          displayName: "Hudson",
          handle: "hudson",
          defaultSelector: "@hudson",
          definitionId: "hudson",
          labels: [],
          metadata: {},
          agentClass: "general",
          capabilities: [],
          wakePolicy: "manual",
          homeNodeId: "node-1",
          authorityNodeId: "node-1",
          advertiseScope: "local",
        },
      },
      endpoints: {
        "endpoint.hudson": {
          id: "endpoint.hudson",
          agentId: "hudson",
          nodeId: "node-1",
          transport: "codex_app_server",
          state: "idle",
          projectRoot: "/Users/you/dev/openscout",
        },
      },
      conversations: {},
      messages: {},
      nodes: {},
      flights: {
        "flight-hudson": {
          id: "flight-hudson",
          invocationId: "inv-hudson",
          requesterId: "operator",
          targetAgentId: "hudson",
          state: "running",
          summary: "checking the build",
          startedAt: 2000,
          metadata: {},
        },
      },
    }, 3000);

    expect(reply?.metadata).toMatchObject({
      matched_rule: "slash.agents",
      snapshot_at: 3000,
      scoutbotAction: "agents",
    });
    expect(reply?.body).toContain("@hudson");
    expect(reply?.body).toContain("HANDS ON WORK");
    expect(reply?.body).toContain("checking the build");
    expect(reply?.body).toContain("#openscout");
    expect(reply?.body).not.toContain("transport:");
    expect(reply?.body).not.toContain("matched_rule: slash.agents");
    expect(reply?.body).not.toContain("snapshot_at:");
  });

  test("/status leads with ON YOU then RECENT and hides scoutbot delivery artifacts", () => {
    const reply = prefilterHandle("/status", {
      actors: {},
      agents: {
        hudson: {
          id: "hudson",
          kind: "agent",
          displayName: "Hudson",
          handle: "hudson",
          defaultSelector: "@hudson",
          definitionId: "hudson",
          labels: [],
          metadata: {},
          agentClass: "general",
          capabilities: [],
          wakePolicy: "manual",
          homeNodeId: "node-1",
          authorityNodeId: "node-1",
          advertiseScope: "local",
        },
        pike: {
          id: "pike",
          kind: "agent",
          displayName: "Pike",
          handle: "pike",
          defaultSelector: "@pike",
          definitionId: "pike",
          labels: [],
          metadata: {},
          agentClass: "general",
          capabilities: [],
          wakePolicy: "manual",
          homeNodeId: "node-1",
          authorityNodeId: "node-1",
          advertiseScope: "local",
        },
      },
      endpoints: {
        "endpoint.hudson": {
          id: "endpoint.hudson",
          agentId: "hudson",
          nodeId: "node-1",
          transport: "codex_app_server",
          state: "idle",
          projectRoot: "/repo/openscout",
        },
        "endpoint.pike": {
          id: "endpoint.pike",
          agentId: "pike",
          nodeId: "node-1",
          transport: "codex_app_server",
          state: "waiting",
          projectRoot: "/repo/openscout",
        },
      },
      conversations: {},
      messages: {},
      nodes: {},
      flights: {
        "flight-real": {
          id: "flight-real",
          invocationId: "inv-real",
          requesterId: "operator",
          targetAgentId: "hudson",
          state: "running",
          summary: "checking the build",
          startedAt: 200,
          metadata: {},
        },
        "flight-waiting": {
          id: "flight-waiting",
          invocationId: "inv-waiting",
          requesterId: "operator",
          targetAgentId: "pike",
          state: "waiting",
          summary: "macOS build failed — missing entitlement",
          startedAt: 100,
          metadata: {},
        },
        "flight-scoutbot-direct": {
          id: "flight-scoutbot-direct",
          invocationId: "inv-scoutbot-direct",
          requesterId: "operator",
          targetAgentId: "scoutbot",
          state: "queued",
          summary: "Message stored for Scout. Will deliver when online.",
          startedAt: 300,
          metadata: {
            source: "scout-mobile",
            destinationKind: "direct",
            destinationId: "scoutbot",
          },
        },
      },
    }, 1234);

    expect(reply?.metadata.matched_rule).toBe("slash.status");
    expect(reply?.body).toContain("ON YOU · 1");
    expect(reply?.body).toContain("macOS build failed — missing entitlement");
    expect(reply?.body).toContain("@pike");
    expect(reply?.body).toContain("RECENT");
    expect(reply?.body).toContain("checking the build");
    expect(reply?.body).toContain("@hudson");
    expect(reply?.body).toContain("1 Scoutbot delivery artifact hidden");
    expect(reply?.body).not.toContain("flight-scoutbot-direct");
    expect(reply?.body).not.toContain("endpoint");
    expect(reply?.body).not.toContain("active flight");
  });

  test("accepts effort directives on slash commands without treating them as args", () => {
    const reply = prefilterHandle("/status eff:low", {
      actors: {},
      agents: {},
      endpoints: {},
      conversations: {},
      messages: {},
      nodes: {},
      flights: {},
    }, 1234);

    expect(reply?.metadata).toMatchObject({
      matched_rule: "slash.status",
      reasoningEffort: "low",
      scoutbotAction: "status",
    });
    expect(reply?.body).toContain("ON YOU · 0");
    expect(reply?.body).toContain("No open requests.");
    expect(reply?.body).toContain("RECENT");
    expect(reply?.body).not.toContain("eff:low");
  });

  test("accepts slash actions and session directives anywhere in the message", () => {
    const reply = prefilterHandle("can you /doing Hudson session:3234", {
      actors: {},
      agents: {
        hudson: {
          id: "hudson",
          kind: "agent",
          displayName: "Hudson",
          handle: "hudson",
          defaultSelector: "@hudson",
          definitionId: "hudson",
          labels: [],
          metadata: {},
          agentClass: "general",
          capabilities: [],
          wakePolicy: "manual",
          homeNodeId: "node-1",
          authorityNodeId: "node-1",
          advertiseScope: "local",
        },
      },
      endpoints: {},
      conversations: {},
      messages: {},
      nodes: {},
      flights: {},
    }, 1234);

    expect(reply?.metadata).toMatchObject({
      matched_rule: "slash.doing",
      scoutbotAction: "doing",
      targetSessionId: "3234",
    });
    expect(reply?.body).toContain("@hudson has no active work");
  });

  test("steers a ScoutBot thread to an explicit session target", () => {
    const reply = prefilterHandle("/steer session:3234", {
      actors: {}, agents: {}, endpoints: {}, conversations: {}, messages: {}, nodes: {}, flights: {},
    }, 1234);

    expect(reply?.metadata).toMatchObject({
      matched_rule: "slash.steer",
      scoutbotAction: "steer",
      targetSessionId: "3234",
    });
    expect(reply?.body).toContain("session 3234");
  });

  test("answers latest-on-agent status from broker facts without Codex", () => {
    const reply = prefilterHandle("what's latest on Hudson", {
      actors: {},
      agents: {
        hudson: {
          id: "hudson",
          kind: "agent",
          displayName: "Hudson",
          handle: "hudson",
          defaultSelector: "@hudson",
          definitionId: "hudson",
          labels: [],
          metadata: {},
          agentClass: "general",
          capabilities: [],
          wakePolicy: "manual",
          homeNodeId: "node-1",
          authorityNodeId: "node-1",
          advertiseScope: "local",
        },
      },
      endpoints: {
        "endpoint.hudson": {
          id: "endpoint.hudson",
          agentId: "hudson",
          nodeId: "node-1",
          transport: "codex_app_server",
          state: "idle",
          projectRoot: "/repo/openscout",
        },
      },
      conversations: {},
      messages: {
        "msg-hudson": {
          id: "msg-hudson",
          conversationId: "dm.operator.hudson",
          actorId: "hudson",
          class: "agent",
          body: "Found the failing compile path.",
          createdAt: 1000,
        },
      },
      nodes: {},
      flights: {
        "flight-hudson": {
          id: "flight-hudson",
          invocationId: "inv-hudson",
          requesterId: "operator",
          targetAgentId: "hudson",
          state: "running",
          summary: "checking the build",
          startedAt: 2000,
          metadata: {},
        },
      },
    }, 3000);

    expect(reply?.metadata.matched_rule).toBe("status.latest_agent");
    expect(reply?.body).toContain("Latest on @hudson");
    expect(reply?.body).toContain("checking the build");
    expect(reply?.body).toContain("Found the failing compile path.");
  });

  test("/recent without agent shows fleet RECENT work rows", () => {
    const reply = prefilterHandle("/recent", {
      actors: {},
      agents: {
        hudson: {
          id: "hudson",
          kind: "agent",
          displayName: "Hudson",
          handle: "hudson",
          defaultSelector: "@hudson",
          definitionId: "hudson",
          labels: [],
          metadata: {},
          agentClass: "general",
          capabilities: [],
          wakePolicy: "manual",
          homeNodeId: "node-1",
          authorityNodeId: "node-1",
          advertiseScope: "local",
        },
      },
      endpoints: {},
      conversations: {},
      messages: {},
      nodes: {},
      flights: {
        "flight-hudson": {
          id: "flight-hudson",
          invocationId: "inv-hudson",
          requesterId: "operator",
          targetAgentId: "hudson",
          state: "running",
          summary: "Inspector atom rollout",
          startedAt: 2000,
          metadata: {},
        },
      },
    }, 3000);

    expect(reply?.metadata.matched_rule).toBe("slash.recent");
    expect(reply?.body).toContain("RECENT");
    expect(reply?.body).toContain("Inspector atom rollout");
    expect(reply?.body).toContain("@hudson");
  });

  test("/help documents tabs and place-default addressing", () => {
    const reply = prefilterHandle("/help", {
      actors: {}, agents: {}, endpoints: {}, conversations: {}, messages: {}, nodes: {}, flights: {},
    }, 1);

    expect(reply?.metadata.matched_rule).toBe("slash.help");
    expect(reply?.body).toContain("focus · threads · tail · scout");
    expect(reply?.body).toContain("@work");
    expect(reply?.body).toContain("#project");
    expect(reply?.body).toContain("ON YOU");
    expect(reply?.body).not.toContain("endpoints");
  });

  test("falls through for ambiguous natural language", () => {
    expect(prefilterHandle("can you think through the HUD redesign?", {
      actors: {}, agents: {}, endpoints: {}, conversations: {}, messages: {}, nodes: {}, flights: {},
    })).toBeNull();
  });
});
