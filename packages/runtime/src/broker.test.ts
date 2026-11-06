import { describe, expect, test } from "bun:test";

import { stampAskContext } from "./ask-context.js";
import { createInMemoryControlRuntime } from "./broker.ts";

describe("InMemoryControlRuntime", () => {
  test("defaults identity-only external agents to general class", () => {
    const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });

    runtime.upsertAgentIdentity({
      id: "weather-a2a.local",
      displayName: "Weather A2A Agent",
      handle: "weather-a2a",
      authorityNodeId: "node-1",
      metadata: { brokerRegistered: true },
    });

    expect(runtime.snapshot().agents["weather-a2a.local"]).toMatchObject({
      agentClass: "general",
      capabilities: [],
      wakePolicy: "on_demand",
    });
  });

  test("posts messages using indexed endpoints and bindings", async () => {
    const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });

    await runtime.upsertNode({
      id: "node-1",
      meshId: "mesh-1",
      name: "Node 1",
      advertiseScope: "local",
      registeredAt: Date.now(),
    });
    await runtime.upsertActor({
      id: "operator",
      kind: "person",
      displayName: "Operator",
    });
    await runtime.upsertActor({
      id: "fabric",
      kind: "agent",
      displayName: "Fabric",
    });
    await runtime.upsertAgent({
      id: "fabric",
      kind: "agent",
      definitionId: "fabric",
      displayName: "Fabric",
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: "node-1",
      authorityNodeId: "node-1",
      advertiseScope: "local",
    });
    await runtime.upsertConversation({
      id: "conv-1",
      kind: "direct",
      title: "Direct",
      visibility: "private",
      shareMode: "local",
      authorityNodeId: "node-1",
      participantIds: ["operator", "fabric"],
    });
    await runtime.upsertBinding({
      id: "binding-1",
      conversationId: "conv-1",
      platform: "webhook",
      mode: "bidirectional",
      externalChannelId: "ext-1",
    });
    await runtime.upsertEndpoint({
      id: "fabric-local",
      agentId: "fabric",
      nodeId: "node-1",
      harness: "claude",
      transport: "local_socket",
      state: "active",
    });
    await runtime.upsertEndpoint({
      id: "fabric-preferred",
      agentId: "fabric",
      nodeId: "node-1",
      harness: "codex",
      transport: "codex_app_server",
      state: "active",
    });

    for (let index = 0; index < 200; index += 1) {
      const agentId = `extra-agent-${index}`;
      await runtime.upsertActor({
        id: agentId,
        kind: "agent",
        displayName: `Extra ${index}`,
      });
      await runtime.upsertAgent({
        id: agentId,
        kind: "agent",
        definitionId: agentId,
        displayName: `Extra ${index}`,
        agentClass: "general",
        capabilities: ["chat"],
        wakePolicy: "on_demand",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
      });
      await runtime.upsertEndpoint({
        id: `extra-endpoint-${index}`,
        agentId,
        nodeId: "node-1",
        harness: "claude",
        transport: "local_socket",
        state: "active",
      });
    }

    const deliveries = await runtime.postMessage({
      id: "msg-1",
      conversationId: "conv-1",
      actorId: "operator",
      originNodeId: "node-1",
      class: "agent",
      body: "check status",
      visibility: "private",
      policy: "durable",
      createdAt: Date.now(),
    });

    expect(runtime.endpointsForAgent("fabric")).toHaveLength(2);
    expect(runtime.bindingsForConversation("conv-1")).toHaveLength(1);
    expect(deliveries).toContainEqual(expect.objectContaining({
      targetId: "fabric",
      transport: "codex_app_server",
      reason: "direct_message",
    }));
    expect(deliveries).toContainEqual(expect.objectContaining({
      targetId: "binding-1",
      transport: "webhook",
      reason: "bridge_outbound",
    }));
  });

  test("tracks flights by invocation id for constant-time lookups", async () => {
    const runtime = createInMemoryControlRuntime();

    await runtime.upsertFlight({
      id: "flight-1",
      invocationId: "invocation-1",
      requesterId: "operator",
      targetAgentId: "fabric",
      state: "queued",
      startedAt: Date.now(),
    });

    expect(runtime.flightForInvocation("invocation-1")?.id).toBe("flight-1");
  });

  test("refreshes endpoint liveness without emitting events", async () => {
    const runtime = createInMemoryControlRuntime();

    await runtime.upsertEndpoint({
      id: "endpoint-1",
      agentId: "fabric",
      nodeId: "node-1",
      harness: "claude",
      transport: "claude_channel",
      state: "active",
      metadata: {
        source: "scout-channel",
        startedAt: 100,
        lastSeenAt: 100,
      },
    });

    const eventCount = runtime.recentEvents().length;

    runtime.refreshEndpointSilently({
      id: "endpoint-1",
      agentId: "fabric",
      nodeId: "node-1",
      harness: "claude",
      transport: "claude_channel",
      state: "active",
      metadata: {
        source: "scout-channel",
        startedAt: 100,
        lastSeenAt: 200,
      },
    });

    expect(runtime.snapshot().endpoints["endpoint-1"]?.metadata?.lastSeenAt).toBe(200);
    expect(runtime.endpointsForAgent("fabric")[0]?.metadata?.lastSeenAt).toBe(200);
    expect(runtime.recentEvents()).toHaveLength(eventCount);
  });

  test("can plan and commit a message separately", async () => {
    const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });

    await runtime.upsertNode({
      id: "node-1",
      meshId: "mesh-1",
      name: "Node 1",
      advertiseScope: "local",
      registeredAt: Date.now(),
    });
    await runtime.upsertActor({
      id: "operator",
      kind: "person",
      displayName: "Operator",
    });
    await runtime.upsertAgent({
      id: "fabric",
      kind: "agent",
      definitionId: "fabric",
      displayName: "Fabric",
      agentClass: "general",
      capabilities: ["chat"],
      wakePolicy: "on_demand",
      homeNodeId: "node-1",
      authorityNodeId: "node-1",
      advertiseScope: "local",
    });
    await runtime.upsertConversation({
      id: "conv-1",
      kind: "direct",
      title: "Direct",
      visibility: "private",
      shareMode: "local",
      authorityNodeId: "node-1",
      participantIds: ["operator", "fabric"],
    });
    await runtime.upsertEndpoint({
      id: "endpoint-1",
      agentId: "fabric",
      nodeId: "node-1",
      harness: "codex",
      transport: "codex_app_server",
      state: "active",
    });

    const message = {
      id: "msg-1",
      conversationId: "conv-1",
      actorId: "operator",
      originNodeId: "node-1",
      class: "agent" as const,
      body: "status?",
      visibility: "private" as const,
      policy: "durable" as const,
      createdAt: Date.now(),
    };
    const deliveries = runtime.planMessage(message);

    expect(runtime.message("msg-1")).toBeUndefined();
    expect(deliveries).toContainEqual(expect.objectContaining({
      targetId: "fabric",
      transport: "codex_app_server",
    }));

    await runtime.commitMessage(message, deliveries);

    expect(runtime.message("msg-1")?.body).toBe("status?");
    expect(runtime.recentEvents().some((event) => event.kind === "message.posted")).toBe(true);
  });

  test("can plan and commit an invocation separately", async () => {
    const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });

    await runtime.upsertNode({
      id: "node-1",
      meshId: "mesh-1",
      name: "Node 1",
      advertiseScope: "local",
      registeredAt: Date.now(),
    });
    await runtime.upsertAgent({
      id: "fabric",
      kind: "agent",
      definitionId: "fabric",
      displayName: "Fabric",
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: "node-1",
      authorityNodeId: "node-1",
      advertiseScope: "local",
    });

    const invocation = {
      origin: { source: "unknown" as const },
      id: "inv-1",
      requesterId: "operator",
      requesterNodeId: "node-1",
      targetAgentId: "fabric",
      action: "consult" as const,
      task: "Status?",
      ensureAwake: true,
      stream: false,
      labels: ["release:0.2.66"],
      createdAt: Date.now(),
    };
    stampAskContext(invocation, runtime.peek(), "node-1");
    const flight = runtime.planInvocation(invocation);

    expect(runtime.flightForInvocation("inv-1")).toBeUndefined();
    expect(flight.labels).toEqual(["release:0.2.66"]);

    await runtime.commitInvocation(invocation, flight);

    expect(runtime.flightForInvocation("inv-1")?.id).toBe(flight.id);
    expect(runtime.recentEvents().some((event) => event.kind === "invocation.requested")).toBe(true);
  });

  test("retired actor tombstones mark deletes and clear on re-registration", async () => {
    const runtime = createInMemoryControlRuntime(
      {},
      { localNodeId: "node-1", retiredActorIds: ["actor-gone"] },
    );

    // Hydrated tombstones are visible.
    expect(runtime.isRetiredActor("actor-gone")).toBe(true);
    expect(runtime.isRetiredActor("actor-1")).toBe(false);

    // deleteActor retires the id even when no row is present.
    runtime.deleteActor("actor-1");
    expect(runtime.isRetiredActor("actor-1")).toBe(true);

    // A fresh actor registration revives the identity.
    await runtime.upsertActor({ id: "actor-1", kind: "agent", displayName: "One" });
    expect(runtime.isRetiredActor("actor-1")).toBe(false);

    // Agent registration synthesizes its actor — it also revives.
    runtime.deleteActor("agent-1");
    expect(runtime.isRetiredActor("agent-1")).toBe(true);
    await runtime.upsertAgent({
      id: "agent-1",
      kind: "agent",
      definitionId: "agent-1",
      displayName: "Agent",
      agentClass: "general",
      capabilities: [],
      wakePolicy: "manual",
      homeNodeId: "node-1",
      authorityNodeId: "node-1",
      advertiseScope: "local",
    });
    expect(runtime.isRetiredActor("agent-1")).toBe(false);
  });
});
