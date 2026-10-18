import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { namedChannelNaturalKey, stableChannelId, type ConversationDefinition } from "@openscout/protocol";

import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test";

const broker = createBrokerDaemonTestHarness();

describe("broker daemon messaging routes", () => {
  test("broadcast uses live membership in a new room without rewriting historical shared records", async () => {
    const harness = await broker.startBroker();
    await broker.seedBasicConversation(harness);
    const oldId = stableChannelId(namedChannelNaturalKey("shared"));
    await broker.postJson(harness.baseUrl, "/v1/conversations", {
      id: oldId, kind: "channel", title: "shared-channel", visibility: "workspace",
      shareMode: "shared", authorityNodeId: harness.nodeId, participantIds: ["operator", "fabric"],
      metadata: { channel: "shared", naturalKey: namedChannelNaturalKey("shared") },
    });
    const before = await broker.getJson<{ conversations: Record<string, ConversationDefinition> }>(harness.baseUrl, "/v1/snapshot");
    const endpoint = {
      id: "fabric-broadcast", agentId: "fabric", nodeId: harness.nodeId,
      harness: "claude", transport: "pairing_bridge", state: "active",
    };
    await broker.postJson(harness.baseUrl, "/v1/endpoints", endpoint);
    const first = await broker.postJson<{ routeKind: string; conversation: ConversationDefinition }>(harness.baseUrl, "/v1/deliver", {
      requesterId: "operator", target: { kind: "broadcast" }, intent: "tell", body: "maintenance soon",
    });
    expect(first.routeKind).toBe("broadcast");
    expect(first.conversation.id).toBe(stableChannelId(namedChannelNaturalKey("broadcast")));
    expect(first.conversation.participantIds).toContain("fabric");
    await broker.postJson(harness.baseUrl, "/v1/endpoints", { ...endpoint, state: "offline" });
    const second = await broker.postJson<{ conversation: ConversationDefinition }>(harness.baseUrl, "/v1/deliver", {
      requesterId: "operator", channel: "shared", intent: "tell", body: "maintenance done",
    });
    expect(second.conversation.id).toBe(first.conversation.id);
    expect(second.conversation.participantIds).not.toContain("fabric");
    const after = await broker.getJson<{ conversations: Record<string, ConversationDefinition> }>(harness.baseUrl, "/v1/snapshot");
    expect(after.conversations[oldId]).toEqual(before.conversations[oldId]);
    expect(after.conversations["channel.shared"]).toEqual(before.conversations["channel.shared"]);
  }, 15_000);

  test("persists posted messages and emits message events", async () => {
    const harness = await broker.startBroker();
    await broker.seedBasicConversation(harness);

    const createdAt = Date.now();
    const response = await broker.postJson<{ ok: boolean; message: { id: string } }>(
      harness.baseUrl,
      "/v1/messages",
      {
        id: "msg-test-1",
        conversationId: "channel.shared",
        actorId: "operator",
        originNodeId: harness.nodeId,
        class: "agent",
        body: "@fabric status check",
        mentions: [{ actorId: "fabric", label: "@fabric" }],
        audience: {
          notify: ["fabric"],
          invoke: ["fabric"],
        },
        visibility: "workspace",
        policy: "durable",
        createdAt,
      },
    );

    expect(response.ok).toBe(true);
    expect(response.message.id).toBe("msg-test-1");

    const snapshot = await broker.getJson<{
      messages: Record<string, { id: string; audience?: { invoke?: string[]; notify?: string[] } }>;
    }>(harness.baseUrl, "/v1/snapshot");

    expect(snapshot.messages["msg-test-1"]).toBeDefined();
    expect(snapshot.messages["msg-test-1"]?.audience?.notify).toEqual(["fabric"]);
    expect(snapshot.messages["msg-test-1"]?.audience?.invoke).toEqual(["fabric"]);

    const events = await broker.getJson<Array<{ kind: string; payload: { message?: { id: string } } }>>(
      harness.baseUrl,
      "/v1/events?limit=20",
    );

    expect(events.some((event) => event.kind === "message.posted" && event.payload.message?.id === "msg-test-1")).toBe(true);
    expect(events.some((event) => event.kind === "delivery.planned")).toBe(true);
  }, 15_000);

  test("serves broker messages with status and errors for one agent", async () => {
    const harness = await broker.startBroker();
    await broker.seedBasicConversation(harness);

    const createdAt = Date.now();
    await broker.postJson(harness.baseUrl, "/v1/messages", {
      id: "msg-broker-feed-1",
      conversationId: "channel.shared",
      actorId: "operator",
      originNodeId: harness.nodeId,
      class: "agent",
      body: "@fabric please check the broker view",
      mentions: [{ actorId: "fabric", label: "@fabric" }],
      audience: {
        notify: ["fabric"],
        invoke: ["fabric"],
      },
      visibility: "workspace",
      policy: "durable",
      createdAt,
    });
    await broker.postJson(harness.baseUrl, "/v1/flights", {
      id: "flight-broker-feed-1",
      invocationId: "inv-broker-feed-1",
      requesterId: "operator",
      targetAgentId: "fabric",
      state: "failed",
      summary: "Dispatch failed",
      error: "composer did not submit",
      startedAt: createdAt + 1,
      completedAt: createdAt + 2,
    });

    const feed = await broker.getJson<{
      agentId: string;
      status: { found: boolean; lastError?: string; pendingDeliveryIds: string[] };
      counts: { messages: number; deliveries: number; errors: number };
      items: Array<{
        kind: string;
        severity: string;
        messageId?: string;
        flightId?: string;
        deliveryId?: string;
        summary: string;
      }>;
    }>(harness.baseUrl, "/v1/broker/messages?agentId=fabric&limit=20");

    expect(feed.agentId).toBe("fabric");
    expect(feed.status.found).toBe(true);
    expect(feed.status.lastError).toBe("composer did not submit");
    expect(feed.status.pendingDeliveryIds.length).toBeGreaterThan(0);
    expect(feed.counts.messages).toBeGreaterThanOrEqual(1);
    expect(feed.counts.deliveries).toBeGreaterThanOrEqual(1);
    expect(feed.counts.errors).toBeGreaterThanOrEqual(1);
    expect(feed.items).toContainEqual(expect.objectContaining({
      kind: "message",
      messageId: "msg-broker-feed-1",
    }));
    expect(feed.items).toContainEqual(expect.objectContaining({
      kind: "flight",
      severity: "error",
      flightId: "flight-broker-feed-1",
      summary: "composer did not submit",
    }));
    expect(feed.items.some((item) => item.kind === "delivery" && item.deliveryId)).toBe(true);
  }, 15_000);

  test("does not downgrade terminal flights with delayed queued updates", async () => {
    const harness = await broker.startBroker();
    const startedAt = Date.now();

    await broker.postJson(harness.baseUrl, "/v1/flights", {
      id: "flight-terminal-downgrade-1",
      invocationId: "inv-terminal-downgrade-1",
      requesterId: "operator",
      targetAgentId: "scoutbot",
      state: "completed",
      summary: "Scoutbot replied.",
      output: "done",
      startedAt,
      completedAt: startedAt + 1,
      metadata: {
        completedBy: "scoutbot",
        replyMessageId: "reply-1",
      },
    });

    await broker.postJson(harness.baseUrl, "/v1/flights", {
      id: "flight-terminal-downgrade-1",
      invocationId: "inv-terminal-downgrade-1",
      requesterId: "operator",
      targetAgentId: "scoutbot",
      state: "queued",
      summary: "Message stored for Scout. Will deliver when online.",
      startedAt,
      metadata: {},
    });

    const snapshot = await broker.getJson<{
      flights: Record<string, {
        state: string;
        summary?: string;
        output?: string;
        completedAt?: number;
        metadata?: Record<string, unknown>;
      }>;
    }>(harness.baseUrl, "/v1/snapshot");
    const flight = snapshot.flights["flight-terminal-downgrade-1"];

    expect(flight?.state).toBe("completed");
    expect(flight?.summary).toBe("Scoutbot replied.");
    expect(flight?.output).toBe("done");
    expect(flight?.completedAt).toBe(startedAt + 1);
    expect(flight?.metadata?.replyMessageId).toBe("reply-1");
  }, 15_000);

  test("completes an active invocation when the target posts a broker reply", async () => {
    const harness = await broker.startBroker();
    await broker.seedBasicConversation(harness);
    await broker.seedHangingReceiver(harness, "fabric");

    const createdAt = Date.now();
    const request = await broker.postJson<{
      kind: string;
      flight?: {
        id: string;
        invocationId: string;
        requesterId: string;
        targetAgentId: string;
        metadata?: Record<string, unknown>;
      };
      conversation?: { id: string; visibility: "workspace" | "private" | "public" };
      message?: { id: string };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-complete-on-reply",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "agent_id",
        agentId: "fabric",
      },
      body: "Please answer in this thread.",
      intent: "consult",
      ensureAwake: false,
      createdAt,
    });

    expect(request.kind).toBe("delivery");
    expect(request.flight?.id).toBeTruthy();
    expect(request.conversation?.id).toBeTruthy();
    expect(request.message?.id).toBeTruthy();

    await broker.postJson(harness.baseUrl, "/v1/flights", {
      id: request.flight!.id,
      invocationId: request.flight!.invocationId,
      requesterId: request.flight!.requesterId,
      targetAgentId: request.flight!.targetAgentId,
      state: "running",
      summary: "Fabric acknowledged.",
      startedAt: createdAt + 1,
      metadata: request.flight!.metadata ?? {},
    });

    await broker.postJson(harness.baseUrl, "/v1/messages", {
      id: "msg-fabric-completes-invocation",
      conversationId: request.conversation!.id,
      actorId: "fabric",
      originNodeId: harness.nodeId,
      class: "agent",
      body: "The requested answer is complete.",
      replyToMessageId: request.message!.id,
      audience: {
        notify: ["operator"],
        reason: "thread_reply",
      },
      visibility: request.conversation!.visibility,
      policy: "durable",
      createdAt: createdAt + 2,
      metadata: {
        source: "test",
      },
    });

    const snapshot = await broker.getJson<{
      flights: Record<string, {
        state: string;
        summary?: string;
        output?: string;
        completedAt?: number;
        metadata?: Record<string, unknown>;
      }>;
    }>(harness.baseUrl, "/v1/snapshot");
    const flight = snapshot.flights[request.flight!.id];

    expect(flight?.state).toBe("completed");
    expect(flight?.summary).toBe("Fabric replied.");
    expect(flight?.output).toBe("The requested answer is complete.");
    expect(flight?.completedAt).toBe(createdAt + 2);
    expect(flight?.metadata?.completedByBrokerReply).toBe(true);
    expect(flight?.metadata?.replyMessageId).toBe("msg-fabric-completes-invocation");
  }, 15_000);

  test("projects target deliveries as claimable inbox items", async () => {
    const harness = await broker.startBroker();
    await broker.seedBasicConversation(harness);

    await broker.postJson(harness.baseUrl, "/v1/messages", {
      id: "msg-inbox-1",
      conversationId: "channel.shared",
      actorId: "operator",
      originNodeId: harness.nodeId,
      class: "agent",
      body: "@fabric inbox this",
      mentions: [{ actorId: "fabric", label: "@fabric" }],
      audience: { notify: ["fabric"] },
      visibility: "workspace",
      policy: "durable",
      createdAt: Date.now(),
    });

    const inbox = await broker.getJson<Array<{
      id: string;
      targetId: string;
      status: string;
      message?: { id: string; body: string };
    }>>(harness.baseUrl, "/v1/inbox?targetId=fabric&limit=20");
    const item = inbox.find((candidate) => candidate.message?.id === "msg-inbox-1");
    expect(item).toBeDefined();
    expect(item?.targetId).toBe("fabric");
    expect(item?.status).toBe("pending");

    const claimed = await broker.postJson<{
      ok: boolean;
      claimed: { id: string; status: string; leaseOwner?: string; leaseGeneration?: number; message?: { id: string } } | null;
    }>(harness.baseUrl, "/v1/inbox/claim", {
      targetId: "fabric",
      itemId: item!.id,
      leaseOwner: "test-agent",
      leaseMs: 30_000,
    });
    expect(claimed.ok).toBe(true);
    expect(claimed.claimed?.status).toBe("leased");
    expect(claimed.claimed?.message?.id).toBe("msg-inbox-1");

    const staleAck = await broker.postJsonStatus(harness.baseUrl, "/v1/inbox/ack", {
      itemId: claimed.claimed!.id,
      leaseOwner: "other-agent",
    });
    expect(staleAck.status).toBe(409);

    const stillLeased = await broker.getJson<Array<{ id: string; status: string; leaseOwner?: string }>>(
      harness.baseUrl,
      `/v1/inbox?targetId=fabric&status=leased&limit=20`,
    );
    expect(stillLeased).toContainEqual(expect.objectContaining({
      id: item!.id,
      status: "leased",
      leaseOwner: "test-agent",
    }));

    await broker.postJson(harness.baseUrl, "/v1/inbox/ack", {
      itemId: claimed.claimed!.id,
      leaseOwner: "test-agent",
      leaseGeneration: claimed.claimed!.leaseGeneration,
    });

    const acknowledged = await broker.getJson<Array<{ id: string; status: string }>>(
      harness.baseUrl,
      `/v1/inbox?targetId=fabric&status=acknowledged&limit=20`,
    );
    expect(acknowledged.some((candidate) => candidate.id === item!.id && candidate.status === "acknowledged")).toBe(true);
  }, 15_000);

  test("records conversation read cursors and acknowledges passive message deliveries", async () => {
    const harness = await broker.startBroker();
    await broker.seedBasicConversation(harness);

    await broker.postJson(harness.baseUrl, "/v1/messages", {
      id: "msg-read-cursor-1",
      conversationId: "channel.shared",
      actorId: "operator",
      originNodeId: harness.nodeId,
      class: "agent",
      body: "@fabric please read this",
      mentions: [{ actorId: "fabric", label: "@fabric" }],
      audience: { notify: ["fabric"] },
      visibility: "workspace",
      policy: "durable",
      createdAt: Date.now(),
    });

    const pending = await broker.getJson<Array<{ id: string; status: string; message?: { id: string } }>>(
      harness.baseUrl,
      "/v1/inbox?targetId=fabric&status=pending&limit=20",
    );
    const item = pending.find((candidate) => candidate.message?.id === "msg-read-cursor-1");
    expect(item).toBeDefined();

    const marked = await broker.postJson<{
      ok: boolean;
      cursor: {
        conversationId: string;
        actorId: string;
        lastReadMessageId?: string;
      };
      acknowledgedDeliveries: number;
    }>(
      harness.baseUrl,
      "/v1/conversations/channel.shared/read-cursors",
      {
        actorId: "fabric",
        lastReadMessageId: "msg-read-cursor-1",
        metadata: { source: "test" },
      },
    );

    expect(marked.ok).toBe(true);
    expect(marked.cursor).toEqual(expect.objectContaining({
      conversationId: "channel.shared",
      actorId: "fabric",
      lastReadMessageId: "msg-read-cursor-1",
    }));
    expect(marked.acknowledgedDeliveries).toBeGreaterThan(0);

    const cursors = await broker.getJson<Array<{ actorId: string; lastReadMessageId?: string }>>(
      harness.baseUrl,
      "/v1/conversations/channel.shared/read-cursors",
    );
    expect(cursors).toContainEqual(expect.objectContaining({
      actorId: "fabric",
      lastReadMessageId: "msg-read-cursor-1",
    }));

    const acknowledged = await broker.getJson<Array<{ id: string; status: string; message?: { id: string } }>>(
      harness.baseUrl,
      "/v1/inbox?targetId=fabric&status=acknowledged&limit=20",
    );
    expect(acknowledged).toContainEqual(expect.objectContaining({
      id: item!.id,
      status: "acknowledged",
    }));

    const events = await broker.getJson<Array<{ kind: string; payload: { cursor?: { actorId: string } } }>>(
      harness.baseUrl,
      "/v1/events?limit=50",
    );
    expect(events.some((event) =>
      event.kind === "conversation.read_cursor.updated" && event.payload.cursor?.actorId === "fabric"
    )).toBe(true);
  }, 15_000);

  test("rejects inbox nack when the caller does not own the active lease", async () => {
    const harness = await broker.startBroker();
    await broker.seedBasicConversation(harness);

    await broker.postJson(harness.baseUrl, "/v1/messages", {
      id: "msg-inbox-nack-1",
      conversationId: "channel.shared",
      actorId: "operator",
      originNodeId: harness.nodeId,
      class: "agent",
      body: "@fabric nack this",
      mentions: [{ actorId: "fabric", label: "@fabric" }],
      audience: { notify: ["fabric"] },
      visibility: "workspace",
      policy: "durable",
      createdAt: Date.now(),
    });

    const inbox = await broker.getJson<Array<{ id: string; message?: { id: string } }>>(
      harness.baseUrl,
      "/v1/inbox?targetId=fabric&limit=20",
    );
    const item = inbox.find((candidate) => candidate.message?.id === "msg-inbox-nack-1");
    expect(item).toBeDefined();

    const claimed = await broker.postJson<{
      claimed: { id: string; status: string; leaseOwner?: string } | null;
    }>(harness.baseUrl, "/v1/inbox/claim", {
      targetId: "fabric",
      itemId: item!.id,
      leaseOwner: "nack-owner",
      leaseMs: 30_000,
    });
    expect(claimed.claimed?.status).toBe("leased");

    const staleNack = await broker.postJsonStatus(harness.baseUrl, "/v1/inbox/nack", {
      itemId: claimed.claimed!.id,
      leaseOwner: "other-agent",
      reason: "not mine",
    });
    expect(staleNack.status).toBe(409);

    const stillLeased = await broker.getJson<Array<{ id: string; status: string; leaseOwner?: string }>>(
      harness.baseUrl,
      "/v1/inbox?targetId=fabric&status=leased&limit=20",
    );
    expect(stillLeased).toContainEqual(expect.objectContaining({
      id: item!.id,
      status: "leased",
      leaseOwner: "nack-owner",
    }));
  }, 15_000);

  test("accepts broker-owned channel tells without caller-side route preflight", async () => {
    const harness = await broker.startBroker();

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "fabric",
      kind: "agent",
      definitionId: "fabric",
      displayName: "Fabric",
      handle: "fabric",
      labels: ["test"],
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });
    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "offline",
      kind: "agent",
      definitionId: "offline",
      displayName: "Offline",
      handle: "offline",
      labels: ["test"],
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });
    await broker.postJson(harness.baseUrl, "/v1/endpoints", {
      id: "endpoint-fabric",
      agentId: "fabric",
      nodeId: harness.nodeId,
      harness: "codex",
      transport: "pairing_bridge",
      state: "active",
    });
    await broker.postJson(harness.baseUrl, "/v1/conversations", {
      id: "chn-11111111111141118111111111111111",
      kind: "channel",
      title: "ops",
      visibility: "workspace",
      shareMode: "local",
      authorityNodeId: harness.nodeId,
      participantIds: ["operator", "fabric", "offline"],
      metadata: { surface: "test", channel: "ops", naturalKey: namedChannelNaturalKey("ops") },
    });

    const response = await broker.postJson<{
      kind: string;
      accepted: boolean;
      routeKind: string;
      targetAgentId?: string;
      receipt?: {
        requestId: string;
        requesterId: string;
        requesterNodeId: string;
        targetLabel?: string;
        conversationId: string;
        messageId: string;
      };
      conversation?: { id: string; kind: string };
      message?: {
        id: string;
        actorId: string;
        conversationId: string;
        createdAt: number;
        audience?: { notify?: string[]; reason?: string };
      };
    }>(harness.baseUrl, "/v1/deliver", {
      target: {
        kind: "channel",
        channel: "ops",
      },
      targetLabel: "@ghost",
      body: "build status update",
      intent: "tell",
    });

    expect(response.kind).toBe("delivery");
    expect(response.accepted).toBe(true);
    expect(response.routeKind).toBe("channel");
    expect(response.targetAgentId).toBeUndefined();
    broker.expectOpaqueNamedConversation(response.conversation, {
      channel: "ops",
      participantIds: ["fabric", "offline", "operator"],
    });
    expect(response.message?.conversationId).toBe(response.conversation?.id);
    expect(response.message?.createdAt).toBeGreaterThan(0);
    expect(response.message?.audience?.reason).toBe("conversation_visibility");
    expect(response.message?.audience?.notify).toEqual(["fabric"]);
    expect(response.receipt?.requestId.startsWith("deliver-")).toBe(true);
    expect(response.receipt?.requesterId).toBe("operator");
    expect(response.receipt?.requesterNodeId).toBe(harness.nodeId);
    expect(response.receipt?.targetLabel).toBe("ops");
    expect(response.receipt?.conversationId).toBe(response.conversation?.id);
    expect(response.receipt?.messageId).toBe(response.message?.id);

    const deliveries = await broker.getJson<Array<{ targetId: string; reason: string; policy: string }>>(
      harness.baseUrl,
      `/v1/deliveries?messageId=${encodeURIComponent(response.message?.id ?? "")}&targetId=fabric`,
    );
    expect(deliveries).toContainEqual(expect.objectContaining({
      targetId: "fabric",
      reason: "conversation_visibility",
      policy: "durable",
    }));

    const claim = await broker.postJson<{ claimed?: { id: string; status: string; leaseOwner?: string } | null }>(
      harness.baseUrl,
      "/v1/deliveries/claim",
      {
        messageId: response.message?.id,
        targetId: "fabric",
        reasons: ["conversation_visibility"],
        leaseOwner: "test-instance",
        leaseMs: 30_000,
      },
    );
    expect(claim.claimed?.status).toBe("leased");
    expect(claim.claimed?.leaseOwner).toBe("test-instance");

    const duplicateClaim = await broker.postJson<{ claimed?: { id: string } | null }>(
      harness.baseUrl,
      "/v1/deliveries/claim",
      {
        messageId: response.message?.id,
        targetId: "fabric",
        reasons: ["conversation_visibility"],
        leaseOwner: "other-instance",
      },
    );
    expect(duplicateClaim.claimed).toBeNull();

    await broker.postJson(harness.baseUrl, "/v1/deliveries/status", {
      deliveryId: claim.claimed?.id,
      status: "acknowledged",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    const acknowledged = await broker.getJson<Array<{ id: string; status: string }>>(
      harness.baseUrl,
      `/v1/deliveries?messageId=${encodeURIComponent(response.message?.id ?? "")}&targetId=fabric&status=acknowledged`,
    );
    expect(acknowledged).toContainEqual(expect.objectContaining({
      id: claim.claimed?.id,
      status: "acknowledged",
    }));
  }, 15_000);
});
