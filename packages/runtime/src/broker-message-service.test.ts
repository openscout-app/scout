import { describe, expect, test } from "bun:test";

import {
  type AgentDefinition,
  type ConversationDefinition,
  type DeliveryIntent,
  type FlightRecord,
  type InvocationRequest,
  type MessageRecord,
  type NodeDefinition,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";
import { shouldIgnoreFlightUpdate } from "./broker-flight-lifecycle-service.js";
import {
  BrokerMessageService,
  type BrokerMessageMesh,
} from "./broker-message-service.js";

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
    capabilities: ["chat", "invoke"],
    wakePolicy: "manual",
    homeNodeId: "node-local",
    authorityNodeId: "node-local",
    advertiseScope: "local",
    ...input,
  };
}

function node(input: Partial<NodeDefinition> = {}): NodeDefinition {
  return {
    id: "node-peer",
    meshId: "mesh-1",
    name: "Peer",
    advertiseScope: "mesh",
    registeredAt: 100,
    ...input,
  };
}

function conversation(input: Partial<ConversationDefinition> = {}): ConversationDefinition {
  return {
    id: "conversation-1",
    kind: "direct",
    title: "Agent One",
    visibility: "workspace",
    shareMode: "local",
    authorityNodeId: "node-local",
    participantIds: ["operator", "agent-1"],
    metadata: {},
    ...input,
  };
}

function message(input: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: "msg-1",
    conversationId: "conversation-1",
    actorId: "agent-1",
    originNodeId: "node-local",
    class: "agent",
    body: "done",
    replyToMessageId: "msg-parent",
    visibility: "workspace",
    policy: "durable",
    createdAt: 120,
    ...input,
  };
}

function invocation(input: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    id: "invocation-1",
    requesterId: "operator",
    requesterNodeId: "node-local",
    targetAgentId: "agent-1",
    action: "consult",
    task: "work",
    ensureAwake: true,
    stream: false,
    conversationId: "conversation-1",
    messageId: "msg-parent",
    createdAt: 100,
    ...input,
  };
}

function flight(input: Partial<FlightRecord> = {}): FlightRecord {
  return {
    id: "flight-1",
    invocationId: "invocation-1",
    requesterId: "operator",
    targetAgentId: "agent-1",
    state: "running",
    startedAt: 110,
    metadata: { dispatch: "ok" },
    ...input,
  };
}

function delivery(input: Partial<DeliveryIntent> = {}): DeliveryIntent {
  return {
    id: "delivery-1",
    messageId: "msg-1",
    targetId: "agent-1",
    targetNodeId: "node-local",
    targetKind: "agent",
    transport: "local_socket",
    reason: "notify",
    policy: "durable",
    status: "pending",
    ...input,
  };
}

function createHarness(input: {
  agents?: Record<string, AgentDefinition>;
  conversations?: Record<string, ConversationDefinition>;
  invocations?: Record<string, InvocationRequest>;
  messages?: Record<string, MessageRecord>;
  flights?: Record<string, FlightRecord>;
  mesh?: Partial<BrokerMessageMesh>;
  recordDuplicate?: MessageRecord;
  beforePersistFlight?: (flight: FlightRecord) => void | Promise<void>;
  beforePersistAcceptedReply?: () => void | Promise<void>;
  authorizeReplyCompletion?: (invocation: InvocationRequest, reply: MessageRecord) => boolean;
  activeLocalEndpointForAgent?: (agentId: string) => unknown;
} = {}) {
  const agents = input.agents ?? { "agent-1": agent() };
  const conversations = input.conversations ?? { "conversation-1": conversation() };
  const invocations = input.invocations ?? {};
  const messages = input.messages ?? {};
  const flights = input.flights ?? {};
  const recordedMessages: Array<{
    message: MessageRecord;
    options?: { enqueueProjection?: boolean };
  }> = [];
  const projectedEntries: BrokerJournalEntry[][] = [];
  const forwardedPeerDeliveries: Array<{
    message: MessageRecord;
    deliveries: DeliveryIntent[];
  }> = [];
  const persistedFlights: FlightRecord[] = [];
  let reconcileCount = 0;
  let nextId = 0;

  const mesh: BrokerMessageMesh = {
    authorityNodeForConversation: () => null,
    async forwardConversationMessageToAuthority(nextMessage) {
      return { forwarded: true, authorityNodeId: "node-peer", message: nextMessage };
    },
    async forwardPeerBrokerDeliveries(nextMessage, deliveries) {
      forwardedPeerDeliveries.push({ message: nextMessage, deliveries });
      return { forwarded: [], failed: [] };
    },
    ...input.mesh,
  };

  const service = new BrokerMessageService({
    nodeId: "node-local",
    systemActorId: "system",
    runtime: {
      peek: () => ({ messages }),
      snapshot: () => ({ invocations }),
      conversation: (conversationId) => conversations[conversationId],
      agent: (agentId) => agents[agentId],
      flightForInvocation: (invocationId) => flights[invocationId],
    },
    mesh,
    createId: (prefix) => `${prefix}-${++nextId}`,
    async recordMessage(nextMessage, options) {
      if (input.recordDuplicate) return { deliveries: [], entries: [], duplicate: input.recordDuplicate };
      recordedMessages.push({ message: nextMessage, options });
      messages[nextMessage.id] = nextMessage;
      const nextDelivery = delivery({ id: `delivery-${recordedMessages.length}`, messageId: nextMessage.id });
      return {
        deliveries: [nextDelivery],
        entries: [{ kind: "message.record", message: nextMessage }],
      };
    },
    async applyProjectedEntries(entries) {
      projectedEntries.push(entries);
    },
    async reconcileStaleLocalDeliveries() {
      reconcileCount += 1;
    },
    async persistFlight(nextFlight, eligible) {
      await input.beforePersistFlight?.(nextFlight);
      if (eligible && !eligible()) return;
      const previous = flights[nextFlight.invocationId];
      if (previous && shouldIgnoreFlightUpdate(previous, nextFlight)) return;
      persistedFlights.push(nextFlight);
      flights[nextFlight.invocationId] = nextFlight;
    },
    async persistAcceptedReply(nextInvocation, receipt, eligible) {
      await input.beforePersistAcceptedReply?.();
      if (!eligible()) return;
      const current = flights[nextInvocation.id];
      if (current?.metadata?.acceptedReply !== undefined) return;
      flights[nextInvocation.id] = { ...current!, metadata: { ...current?.metadata, acceptedReply: receipt } };
    },
    authorizeReplyCompletion: input.authorizeReplyCompletion,
    activeLocalEndpointForAgent: input.activeLocalEndpointForAgent ?? (() => ({ id: "endpoint-1" })),
  });

  return {
    agents,
    conversations,
    flights,
    forwardedPeerDeliveries,
    invocations,
    messages,
    persistedFlights,
    projectedEntries,
    recordedMessages,
    reconcileCount: () => reconcileCount,
    service,
  };
}

describe("BrokerMessageService", () => {
  test("an accepted reply retry repairs interrupted completion from the stored message without refanout", async () => {
    let fail = true;
    const original = message({ metadata: { clientMessageId: "reply-1", source: "original" } });
    const harness = createHarness({ invocations: { "invocation-1": invocation() }, flights: { "invocation-1": flight() },
      beforePersistFlight: () => { if (fail) throw new Error("completion storage unavailable"); },
    });
    await expect(harness.service.postConversationMessage(original)).rejects.toThrow("completion storage unavailable");
    expect(harness.messages[original.id]).toEqual(original);
    fail = false;
    const result = await harness.service.postConversationMessage({ ...original, createdAt: 999,
      metadata: { clientMessageId: "reply-1", source: "changed retry metadata" },
    });
    expect(result).toMatchObject({ duplicate: true, message: original, deliveries: [] });
    expect(harness.flights["invocation-1"]).toMatchObject({ state: "completed", completedAt: 120,
      metadata: { replySource: "original" },
    });
    expect(harness.recordedMessages).toHaveLength(1);
    expect(harness.forwardedPeerDeliveries).toHaveLength(1);
  });

  test("the duplicate found inside the durable writer also repairs completion without fanout", async () => {
    const stored = message({ metadata: { clientMessageId: "reply-1" } });
    const harness = createHarness({ invocations: { "invocation-1": invocation() }, flights: { "invocation-1": flight() }, recordDuplicate: stored });
    expect(await harness.service.postConversationMessage({ ...stored, createdAt: 999 })).toMatchObject({ duplicate: true, message: stored });
    expect(harness.flights["invocation-1"]).toMatchObject({ state: "completed", completedAt: 120 });
    expect(harness.recordedMessages).toHaveLength(0);
    expect(harness.forwardedPeerDeliveries).toHaveLength(0);
  });

  test("duplicate and startup repairs require the same final-reply authorization", async () => {
    const stored = message({ metadata: { clientMessageId: "reply-1" } });
    const harness = createHarness({ messages: { [stored.id]: stored }, invocations: { "invocation-1": invocation() },
      flights: { "invocation-1": flight() }, authorizeReplyCompletion: () => false });
    await harness.service.postConversationMessage(stored);
    expect(await harness.service.recoverInvocationReply(invocation())).toBe(false);
    expect(harness.persistedFlights).toHaveLength(0);
    expect(harness.flights["invocation-1"]?.state).toBe("running");
  });

  test("startup finds an authorized reply even when a newer lookalike is unauthorized", async () => {
    const stored = message();
    const harness = createHarness({ messages: { [stored.id]: stored, spoof: message({ id: "spoof", createdAt: 130 }) },
      invocations: { "invocation-1": invocation() }, flights: { "invocation-1": flight() },
      authorizeReplyCompletion: (_invocation, reply) => reply.id === stored.id });
    expect(await harness.service.recoverInvocationReply(invocation())).toBe(true);
    expect(harness.flights["invocation-1"]).toMatchObject({ state: "completed", completedAt: 120, metadata: { replyMessageId: stored.id } });
    expect(harness.recordedMessages).toHaveLength(0);
    expect(harness.forwardedPeerDeliveries).toHaveLength(0);
  });

  test.each(["cancelled", "failed", "completed"] as const)("startup never replaces a %s flight", async (state) => {
    const harness = createHarness({ messages: { "msg-1": message() }, invocations: { "invocation-1": invocation() },
      flights: { "invocation-1": flight({ state }) } });
    expect(await harness.service.recoverInvocationReply(invocation())).toBe(false);
    expect(harness.persistedFlights).toHaveLength(0);
  });

  test("a cancellation winning the durable writer is preserved during startup repair", async () => {
    const flights = { "invocation-1": flight() };
    const harness = createHarness({ messages: { "msg-1": message() }, invocations: { "invocation-1": invocation() }, flights,
      beforePersistFlight: () => { flights["invocation-1"] = flight({ state: "cancelled", completedAt: 125 }); },
    });
    expect(await harness.service.recoverInvocationReply(invocation())).toBe(false);
    expect(flights["invocation-1"]).toMatchObject({ state: "cancelled", completedAt: 125 });
    expect(harness.persistedFlights).toHaveLength(0);
  });

  test("a newer current flight wins over an already prepared completion", async () => {
    const flights = { "invocation-1": flight() };
    const newer = flight({ id: "flight-2", startedAt: 115 });
    const harness = createHarness({ flights, invocations: { "invocation-1": invocation() }, messages: { "msg-1": message() },
      beforePersistFlight: () => { flights["invocation-1"] = newer; },
    });
    expect(await harness.service.recoverInvocationReply(invocation())).toBe(false);
    expect(flights["invocation-1"]).toBe(newer);
    expect(harness.persistedFlights).toEqual([]);
  });

  test("reply authorization is rechecked inside the completion writer", async () => {
    let authorized = true;
    const harness = createHarness({ flights: { "invocation-1": flight() }, invocations: { "invocation-1": invocation() },
      messages: { "msg-1": message() }, authorizeReplyCompletion: () => authorized,
      beforePersistFlight: () => { authorized = false; },
    });
    expect(await harness.service.recoverInvocationReply(invocation())).toBe(false);
    expect(harness.persistedFlights).toEqual([]);
  });

  test("a newer flight cannot inherit a receipt queued for an earlier flight", async () => {
    const flights = { "invocation-1": flight() };
    const newer = flight({ id: "flight-2", startedAt: 115 });
    const harness = createHarness({ flights, invocations: { "invocation-1": invocation() },
      beforePersistAcceptedReply: () => { flights["invocation-1"] = newer; },
      mesh: { authorityNodeForConversation: () => ({ conversation: conversation(), authorityNode: node() }) },
    });
    await harness.service.postConversationMessage(message());
    expect(flights["invocation-1"]).toBe(newer);
    expect(harness.persistedFlights).toEqual([]);
  });

  test("malformed authority receipt holds recovery instead of treating accepted work as missing", async () => {
    const harness = createHarness({ invocations: { "invocation-1": invocation() }, flights: {
      "invocation-1": flight({ metadata: { acceptedReply: { version: 1, authorityNodeId: "peer", message: { id: "broken" } } } }),
    } });
    await expect(harness.service.recoverInvocationReply(invocation())).rejects.toThrow("Malformed accepted reply");
    expect(harness.persistedFlights).toHaveLength(0);
  });

  test("remote authority acknowledgement survives interrupted completion and repairs offline after restart", async () => {
    const stored = message({ metadata: { clientMessageId: "reply-1" } });
    let forwards = 0;
    const first = createHarness({ invocations: { "invocation-1": invocation() }, flights: { "invocation-1": flight() },
      beforePersistFlight: () => { throw new Error("completion storage unavailable"); },
      mesh: { authorityNodeForConversation: () => ({ conversation: conversation(), authorityNode: node() }),
        forwardConversationMessageToAuthority: async () => { forwards++; return { forwarded: true, authorityNodeId: "node-peer", message: stored }; } },
    });
    await expect(first.service.postConversationMessage(stored)).rejects.toThrow("completion storage unavailable");
    expect(first.messages).toEqual({});
    expect(first.flights["invocation-1"]?.metadata?.acceptedReply).toMatchObject({ message: stored, authorityNodeId: "node-peer" });
    const restarted = createHarness({ invocations: first.invocations, flights: structuredClone(first.flights),
      mesh: { authorityNodeForConversation: () => { throw new Error("peer offline"); } } });
    expect(await restarted.service.recoverInvocationReply(invocation())).toBe(true);
    expect(await restarted.service.postConversationMessage({ ...stored, createdAt: 999 })).toMatchObject({ duplicate: true, forwarded: true });
    expect(restarted.flights["invocation-1"]).toMatchObject({ state: "completed", completedAt: stored.createdAt });
    expect(restarted.recordedMessages).toHaveLength(0);
    expect(restarted.forwardedPeerDeliveries).toHaveLength(0);
    expect(forwards).toBe(1);
  });

  test.each([false, true])("a lost authority ACK retry preserves the original reply receipt (newer flight: %s)", async (newerFlight) => {
    const original = message({ metadata: { clientMessageId: "stable-reply", source: "authority-original" } });
    let sends = 0;
    const harness = createHarness({ invocations: { "invocation-1": invocation() }, flights: { "invocation-1": flight() },
      mesh: { authorityNodeForConversation: () => ({ conversation: conversation(), authorityNode: node() }),
        forwardConversationMessageToAuthority: async () => {
          if (++sends === 1) throw new Error("authority committed; ACK lost");
          return { forwarded: true, authorityNodeId: "node-peer", duplicate: true, message: original };
        } },
    });
    await expect(harness.service.postConversationMessage(original)).rejects.toThrow("ACK lost");
    if (newerFlight) harness.flights["invocation-1"] = flight({ id: "flight-2", startedAt: 20_000 });
    const result = await harness.service.postConversationMessage({ ...original, createdAt: 25_000,
      metadata: { clientMessageId: "stable-reply", source: "retry-changed" } });
    expect(result.message).toEqual(original);
    if (newerFlight) {
      expect(harness.flights["invocation-1"]).toMatchObject({ id: "flight-2", state: "running" });
      expect(harness.flights["invocation-1"]?.metadata?.acceptedReply).toBeUndefined();
      expect(harness.persistedFlights).toEqual([]);
    } else {
      expect(harness.flights["invocation-1"]).toMatchObject({ state: "completed", completedAt: original.createdAt,
        metadata: { replySource: "authority-original", acceptedReply: { message: original } } });
    }
    expect(harness.recordedMessages).toEqual([]);
    expect(harness.forwardedPeerDeliveries).toEqual([]);
  });

  test.each(["missing", "wrong-id", "wrong-body", "invalid-timestamp"])("unsafe authority ACK %s cannot checkpoint or complete a reply", async (kind) => {
    const original = message({ metadata: { clientMessageId: "stable-reply" } });
    const accepted = kind === "missing" ? undefined : { ...original,
      ...(kind === "wrong-id" ? { id: "other" } : {}),
      ...(kind === "wrong-body" ? { body: "other" } : {}),
      ...(kind === "invalid-timestamp" ? { createdAt: Number.NaN } : {}),
    };
    const harness = createHarness({ invocations: { "invocation-1": invocation() }, flights: { "invocation-1": flight() },
      mesh: { authorityNodeForConversation: () => ({ conversation: conversation(), authorityNode: node() }),
        forwardConversationMessageToAuthority: async () => ({ forwarded: true, authorityNodeId: "node-peer", message: accepted }),
      },
    });
    await expect(harness.service.postConversationMessage(original)).rejects.toThrow("canonical message");
    expect(harness.persistedFlights).toEqual([]);
    expect(harness.flights["invocation-1"]?.metadata?.acceptedReply).toBeUndefined();
  });

  test("settles the executor flight only after the remote authority accepts its reply", async () => {
    const nextInvocation = invocation({ requesterNodeId: "node-peer" });
    const nextFlight = flight();
    let accepted = false;
    const harness = createHarness({
      invocations: { [nextInvocation.id]: nextInvocation },
      flights: { [nextInvocation.id]: nextFlight },
      mesh: {
        authorityNodeForConversation: () => ({ conversation: conversation({ authorityNodeId: "node-peer" }), authorityNode: node() }),
        async forwardConversationMessageToAuthority() {
          if (!accepted) expect(harness.persistedFlights).toEqual([]);
          if (!accepted) throw new Error("peer unavailable");
          return { forwarded: true, authorityNodeId: "node-peer", message: message() };
        },
      },
    });
    await expect(harness.service.postConversationMessage(message())).rejects.toThrow("peer unavailable");
    expect(harness.persistedFlights).toEqual([]);
    accepted = true;
    await harness.service.postConversationMessage(message());
    expect(harness.persistedFlights).toMatchObject([{ state: "completed", output: "done", metadata: { completedByBrokerReply: true, replyMessageId: "msg-1" } }]);
    // Message remains authority-owned: no local duplicate fan-out.
    expect(harness.recordedMessages).toEqual([]);
    expect(harness.forwardedPeerDeliveries).toEqual([]);
    await harness.service.postConversationMessage(message());
    expect(harness.persistedFlights).toHaveLength(1);
  });

  test("returns an idempotent client-message retry without replaying deliveries", async () => {
    const existing = message({
      id: "m-client-stable",
      actorId: "operator",
      class: "operator",
      body: "same request",
      replyToMessageId: undefined,
      metadata: { clientMessageId: "web-stable-1" },
    });
    const harness = createHarness({ messages: { [existing.id]: existing } });

    const result = await harness.service.postConversationMessage({
      ...existing,
      createdAt: existing.createdAt + 5_000,
    });

    expect(result).toMatchObject({
      ok: true,
      duplicate: true,
      message: existing,
      deliveries: [],
    });
    expect(harness.recordedMessages).toHaveLength(0);
    expect(harness.forwardedPeerDeliveries).toHaveLength(0);
  });

  test("rejects reuse of a message id for different content", async () => {
    const existing = message({
      id: "m-client-stable",
      metadata: { clientMessageId: "web-stable-1" },
    });
    const harness = createHarness({ messages: { [existing.id]: existing } });

    await expect(harness.service.postConversationMessage({
      ...existing,
      body: "different request",
    })).rejects.toThrow("already assigned to a different record");
  });

  test("rejects reuse of a message id with different attachments", async () => {
    const existing = message({
      id: "m-client-stable",
      metadata: { clientMessageId: "web-stable-1" },
      attachments: [{ id: "attachment-1", mediaType: "text/plain", fileName: "one.txt" }],
    });
    const harness = createHarness({ messages: { [existing.id]: existing } });

    await expect(harness.service.postConversationMessage({
      ...existing,
      attachments: [{ id: "attachment-2", mediaType: "text/plain", fileName: "two.txt" }],
    })).rejects.toThrow("already assigned to a different record");
  });

  test("posts local messages durably, projects entries, reconciles, and completes matching invocations", async () => {
    const nextInvocation = invocation();
    const nextFlight = flight();
    const harness = createHarness({
      invocations: { [nextInvocation.id]: nextInvocation },
      flights: { [nextInvocation.id]: nextFlight },
    });

    const result = await harness.service.postConversationMessage(message({
      id: "msg-reply",
      body: "All done",
      createdAt: 130,
    }));

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      message: expect.objectContaining({ id: "msg-reply" }),
      deliveries: [expect.objectContaining({ id: "delivery-1", messageId: "msg-reply" })],
    }));
    expect(harness.recordedMessages).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ id: "msg-reply" }),
        options: { enqueueProjection: false, dedupeExisting: true },
      }),
    ]);
    expect(harness.forwardedPeerDeliveries).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ id: "msg-reply" }),
        deliveries: [expect.objectContaining({ id: "delivery-1" })],
      }),
    ]);
    expect(harness.projectedEntries).toEqual([
      [expect.objectContaining({ kind: "message.record" })],
    ]);
    expect(harness.reconcileCount()).toBe(1);
    expect(harness.persistedFlights).toEqual([
      expect.objectContaining({
        id: "flight-1",
        state: "completed",
        output: "All done",
        completedAt: 130,
        metadata: expect.objectContaining({
          dispatch: "ok",
          completedByBrokerReply: true,
          replyMessageId: "msg-reply",
        }),
      }),
    ]);
  });

  test("forwards remote-authority messages without local durable writes", async () => {
    const remoteDelivery = delivery({ id: "remote-delivery" });
    const authorityConversation = conversation({
      shareMode: "shared",
      authorityNodeId: "node-peer",
    });
    const harness = createHarness({
      mesh: {
        authorityNodeForConversation: () => ({
          conversation: authorityConversation,
          authorityNode: node(),
        }),
        async forwardConversationMessageToAuthority() {
          return {
            forwarded: true,
            authorityNodeId: "node-peer",
            duplicate: true,
            deliveries: [remoteDelivery],
          };
        },
      },
    });

    const result = await harness.service.postConversationMessage(message());

    expect(result).toEqual({
      ok: true,
      message: message(),
      forwarded: true,
      authorityNodeId: "node-peer",
      duplicate: true,
      deliveries: [remoteDelivery],
    });
    expect(harness.recordedMessages).toEqual([]);
    expect(harness.forwardedPeerDeliveries).toEqual([]);
    expect(harness.projectedEntries).toEqual([]);
    expect(harness.reconcileCount()).toBe(0);
    expect(harness.persistedFlights).toEqual([]);
  });

  test("posts invocation status messages only when a conversation and body exist", async () => {
    const privateConversation = conversation({ visibility: "private" });
    const harness = createHarness({
      conversations: { [privateConversation.id]: privateConversation },
    });
    const nextInvocation = invocation();

    await harness.service.postInvocationStatusMessage(nextInvocation, {
      id: "flight-1",
      summary: "Working",
      error: "Needs attention",
    });
    await harness.service.postInvocationStatusMessage(nextInvocation, {
      id: "flight-empty",
      summary: " ",
      error: "",
    });
    await harness.service.postInvocationStatusMessage(invocation({
      id: "missing-conversation",
      conversationId: "missing",
    }), {
      summary: "Ignored",
    });
    await harness.service.postInvocationStatusMessage(invocation({
      id: "no-conversation",
      conversationId: undefined,
    }), {
      summary: "Ignored",
    });

    expect(harness.recordedMessages).toHaveLength(1);
    expect(harness.recordedMessages[0]?.message).toEqual(expect.objectContaining({
      id: "msg-1",
      conversationId: "conversation-1",
      actorId: "system",
      originNodeId: "node-local",
      class: "status",
      body: "Working\nNeeds attention",
      replyToMessageId: "msg-parent",
      audience: { notify: ["operator"] },
      visibility: "private",
      policy: "durable",
      metadata: {
        flightId: "flight-1",
        invocationId: "invocation-1",
        source: "broker",
        targetAgentId: "agent-1",
      },
    }));
  });

  test("does not enqueue status notifications for inline and none invocations", async () => {
    for (const replyMode of ["inline", "none"] as const) {
      const harness = createHarness();
      await harness.service.postInvocationStatusMessage(invocation({
        metadata: { replyMode },
      }), {
        id: `flight-${replyMode}`,
        error: `${replyMode} failed`,
      });

      expect(harness.recordedMessages).toHaveLength(1);
      expect(harness.recordedMessages[0]?.message.audience).toEqual({ delivery: "none" });
    }
  });

  test("enqueues status notifications for explicit notify and legacy invocations", async () => {
    for (const metadata of [{ replyMode: "notify" }, {}]) {
      const harness = createHarness();
      await harness.service.postInvocationStatusMessage(invocation({ metadata }), {
        error: "failed",
      });

      expect(harness.recordedMessages[0]?.message.audience).toEqual({
        notify: ["operator"],
      });
    }
  });

  test("finds the newest existing broker reply using the reply lookback window", async () => {
    const olderReply = message({ id: "old", createdAt: 4_999 });
    const firstReply = message({ id: "first", createdAt: 5_000 });
    const newestReply = message({ id: "newest", createdAt: 7_000 });
    const harness = createHarness({
      messages: {
        old: olderReply,
        first: firstReply,
        newest: newestReply,
        wrongActor: message({ id: "wrongActor", actorId: "agent-2", createdAt: 8_000 }),
        wrongClass: message({ id: "wrongClass", class: "status", createdAt: 9_000 }),
      },
    });

    expect(await harness.service.existingBrokerReplyForInvocation(invocation(), "agent-1", 10_000))
      .toBe(newestReply);
    expect(await harness.service.existingBrokerReplyForInvocation(invocation({
      conversationId: undefined,
    }), "agent-1", 10_000)).toBeNull();
    expect(await harness.service.existingBrokerReplyForInvocation(invocation({
      messageId: undefined,
    }), "agent-1", 10_000)).toBeNull();
  });

  test("online conversation notify targets skip the requester, unknown agents, and offline participants", () => {
    const harness = createHarness({
      agents: {
        "agent-1": agent({ id: "agent-1" }),
        "agent-2": agent({ id: "agent-2" }),
      },
      activeLocalEndpointForAgent: (agentId) => agentId === "agent-2" ? { id: "endpoint-2" } : null,
    });

    expect(harness.service.onlineConversationNotifyTargets(conversation({
      participantIds: ["operator", "agent-1", "agent-2", "unknown"],
    }), "operator")).toEqual(["agent-2"]);
  });
});
