import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ActorIdentity,
  type AgentDefinition,
  type AgentEndpoint,
  type CollaborationEvent,
  type CollaborationRecord,
  type ConversationDefinition,
  type DeliveryIntent,
  type FlightRecord,
  type InvocationRequest,
  type MessageRecord,
  type NodeDefinition,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";
import type { BrokerInvocationDispatchJob } from "./broker-dispatch-job.js";
import {
  BrokerMeshHttpService,
  type BrokerMeshHttpServiceDeps,
} from "./broker-mesh-http-service.js";
import { createInMemoryControlRuntime } from "./broker.js";
import { SQLiteControlPlaneStore } from "./sqlite-store.js";
import { ControlPlaneHistoryStore } from "./control-plane-history-store.js";
import { emptyHistoryRotationPlan } from "./history-rotation.js";
import type {
  MeshCollaborationEventBundle,
  MeshCollaborationRecordBundle,
  MeshInvocationBundle,
  MeshMessageBundle,
} from "./mesh-forwarding.js";

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

function actor(input: Partial<ActorIdentity> = {}): ActorIdentity {
  return {
    id: "operator",
    kind: "person",
    displayName: "Operator",
    handle: "operator",
    labels: [],
    metadata: {},
    ...input,
  };
}

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

function conversation(input: Partial<ConversationDefinition> = {}): ConversationDefinition {
  return {
    id: "conversation-1",
    kind: "channel",
    title: "shared",
    visibility: "workspace",
    shareMode: "shared",
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
    actorId: "operator",
    originNodeId: "node-peer",
    class: "agent",
    body: "hello",
    visibility: "workspace",
    policy: "durable",
    createdAt: 100,
    ...input,
  };
}

function invocation(input: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    id: "invocation-1",
    requesterId: "operator",
    requesterNodeId: "node-peer",
    targetAgentId: "agent-1",
    action: "consult",
    task: "work",
    ensureAwake: true,
    stream: false,
    conversationId: "conversation-1",
    messageId: "msg-1",
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
    state: "queued",
    startedAt: 100,
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
    reason: "conversation_visibility",
    policy: "durable",
    status: "pending",
    ...input,
  };
}

function workItem(input: Partial<CollaborationRecord> = {}): CollaborationRecord {
  return {
    id: "work-1",
    kind: "work_item",
    state: "working",
    acceptanceState: "none",
    title: "Investigate mesh",
    createdById: "operator",
    ownerId: "agent-1",
    nextMoveOwnerId: "agent-1",
    requestedById: "operator",
    conversationId: "conversation-1",
    createdAt: 100,
    updatedAt: 100,
    ...input,
  } as CollaborationRecord;
}

function collaborationEvent(input: Partial<CollaborationEvent> = {}): CollaborationEvent {
  return {
    id: "event-1",
    recordId: "work-1",
    recordKind: "work_item",
    kind: "progressed",
    actorId: "agent-1",
    at: 120,
    ...input,
  };
}

function messageBundle(input: Partial<MeshMessageBundle> = {}): MeshMessageBundle {
  const nextConversation = input.conversation ?? conversation();
  return {
    originNode: node(),
    actors: [actor()],
    agents: [agent()],
    conversation: nextConversation,
    bindings: [],
    message: message({ conversationId: nextConversation.id }),
    ...input,
  };
}

function invocationBundle(input: Partial<MeshInvocationBundle> = {}): MeshInvocationBundle {
  return {
    originNode: node(),
    actors: [actor()],
    agents: [agent()],
    conversation: conversation(),
    invocation: invocation(),
    ...input,
  };
}

function collaborationRecordBundle(input: Partial<MeshCollaborationRecordBundle> = {}): MeshCollaborationRecordBundle {
  return {
    originNode: node(),
    actors: [actor()],
    agents: [agent()],
    conversation: conversation(),
    record: workItem(),
    ...input,
  };
}

function collaborationEventBundle(input: Partial<MeshCollaborationEventBundle> = {}): MeshCollaborationEventBundle {
  return {
    originNode: node(),
    actors: [actor()],
    agents: [agent()],
    conversation: conversation(),
    record: workItem(),
    event: collaborationEvent(),
    ...input,
  };
}

function createHarness(input: {
  agents?: Record<string, AgentDefinition>;
  messages?: Record<string, MessageRecord>;
  flights?: Record<string, FlightRecord>;
  invocations?: Record<string, InvocationRequest>;
  records?: Record<string, CollaborationRecord>;
  localEndpoints?: Record<string, AgentEndpoint>;
  invocationSnapshotFor?: BrokerMeshHttpServiceDeps["invocationSnapshotFor"];
  messageFor?: BrokerMeshHttpServiceDeps["messageFor"];
} = {}) {
  const agents = input.agents ?? {};
  const localEndpoints = input.localEndpoints ?? {};
  const messages = input.messages ?? {};
  const flights = input.flights ?? {};
  const invocations = input.invocations ?? {};
  const records = input.records ?? {};
  const applyBundleCalls: Array<MeshMessageBundle | MeshInvocationBundle | MeshCollaborationRecordBundle | MeshCollaborationEventBundle> = [];
  const committedEntries: BrokerJournalEntry[][] = [];
  const projectedEntries: BrokerJournalEntry[][] = [];
  const rememberedInvocations: InvocationRequest[] = [];
  const runDispatchJobs: Array<{ job: BrokerInvocationDispatchJob; invocation: InvocationRequest }> = [];
  const completedReplies: MessageRecord[] = [];
  const plannedInvocations: InvocationRequest[] = [];
  const messageFor = async (id: string) => messages[id] ?? await input.messageFor?.(id);

  const service = new BrokerMeshHttpService({
    nodeId: "node-local",
    runtime: {
      message: (messageId) => messages[messageId],
      planMessage: (nextMessage) => [delivery({ messageId: nextMessage.id })],
      async commitMessage(nextMessage) {
        messages[nextMessage.id] = nextMessage;
      },
      agent: (agentId) => agents[agentId],
      flightForInvocation: (invocationId) => flights[invocationId],
      planInvocation: (nextInvocation) => {
        plannedInvocations.push(nextInvocation);
        return flight({
          invocationId: nextInvocation.id,
          requesterId: nextInvocation.requesterId,
          targetAgentId: nextInvocation.targetAgentId,
        });
      },
      async commitInvocation(nextInvocation, nextFlight) {
        invocations[nextInvocation.id] = nextInvocation;
        flights[nextFlight.invocationId] = nextFlight;
      },
      collaborationRecord: (recordId) => records[recordId],
    },
    async runDurableWrite(work) {
      return await work();
    },
    async applyMeshBundle(bundle) {
      applyBundleCalls.push(bundle);
      for (const nextAgent of bundle.agents) {
        agents[nextAgent.id] = nextAgent;
      }
      if ("record" in bundle && bundle.record) {
        records[bundle.record.id] = bundle.record;
      }
      return [{ kind: "node.upsert", node: bundle.originNode }];
    },
    async commitEntries(entries, applyRuntime) {
      const normalized = Array.isArray(entries) ? entries : [entries];
      committedEntries.push(normalized);
      await applyRuntime(normalized);
      return normalized;
    },
    async applyProjectedEntries(entries) {
      projectedEntries.push(entries);
    },
    invocationSnapshotFor: input.invocationSnapshotFor ?? (async (id) => ({ invocation: invocations[id], flight: flights[id] })),
    messageFor,
    rememberInvocation(nextInvocation) {
      rememberedInvocations.push(nextInvocation);
    },
    async completeInvocationsForBrokerReply(reply) {
      expect(await messageFor(reply.id)).toEqual(reply);
      completedReplies.push(reply);
    },
    localEndpointForActor: (actorId) => localEndpoints[actorId],
    async runDispatchJob(job, nextInvocation) {
      runDispatchJobs.push({ job, invocation: nextInvocation });
    },
  });

  return {
    agents,
    applyBundleCalls,
    committedEntries,
    completedReplies,
    flights,
    invocations,
    messages,
    plannedInvocations,
    projectedEntries,
    records,
    rememberedInvocations,
    runDispatchJobs,
    service,
  };
}

const historyCleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of historyCleanups.splice(0).reverse()) cleanup(); });

function archivedFixture() {
  const root = mkdtempSync(join(tmpdir(), "scout-mesh-history-retry-"));
  historyCleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new SQLiteControlPlaneStore(join(root, "control.sqlite"));
  historyCleanups.push(() => store.close());
  const history = new ControlPlaneHistoryStore(join(root, "history"));
  historyCleanups.push(() => history.close());
  store.configureHistory(join(root, "history"));
  store.upsertNode(node());
  store.upsertNode(node({ id: "node-local" }));
  store.upsertActor(actor());
  store.upsertActor(agent());
  store.upsertConversation(conversation());
  const request = message({
    createdAt: 1_700_000_000_000,
    mentions: [{ actorId: "operator", label: "Sender" }, { actorId: "agent-1", label: "Target" }],
    attachments: [{ id: "z", mediaType: "text/plain", url: "https://example.test/context" }, { id: "a", mediaType: "text/plain", blobKey: "preserved" }],
    metadata: { context: { original: ["retain", "雪"] } },
  });
  const originalInvocation = invocation({ createdAt: request.createdAt, context: { original: "full task context" } });
  const originalFlight = flight({ state: "completed", startedAt: request.createdAt, completedAt: request.createdAt + 1, output: "original answer" });
  store.recordMessage(request);
  store.recordInvocation(originalInvocation);
  store.recordFlight(originalFlight);
  const runtime = createInMemoryControlRuntime(store.loadSnapshot());
  const expected = store.readInvocationSnapshot(originalInvocation.id);
  const expectedMessage = store.readMessages([request.id]).get(request.id);
  const plan = emptyHistoryRotationPlan();
  plan.messageIds.add(request.id); plan.invocationIds.add(originalInvocation.id); plan.flightIds.add(originalFlight.id);
  const published = store.publishHistoryRotation(plan, history);
  expect(published.publication).not.toBeNull();
  const removed = store.removePublishedHistory(published.publication!, published.published, history);
  expect(removed.blocked).toEqual([]);
  runtime.applyHistoryRotation(removed.removed);
  expect(runtime.flightForInvocation(originalInvocation.id)).toBeUndefined();
  expect(runtime.message(request.id)).toBeUndefined();
  expect(store.writerDb.query("SELECT 1 FROM flights WHERE id=?1").get(originalFlight.id)).toBeNull();
  expect(store.writerDb.query<{ body: string }>("SELECT body FROM messages WHERE id=?1").get(request.id)?.body).toBe("");
  const harness = createHarness({
    invocationSnapshotFor: async id => {
      const snapshot = store.readInvocationSnapshot(id);
      return { invocation: snapshot.invocation ?? undefined, flight: snapshot.flight ?? undefined };
    },
    messageFor: async id => store.readMessages([id]).get(id),
  });
  return { harness, store, request, originalInvocation, originalFlight, expected, expectedMessage };
}

describe("BrokerMeshHttpService", () => {
  test("an exact retry after physical history relocation returns the original terminal flight without dispatch or rehydration", async () => {
    const { harness, store, request, originalInvocation, expected, expectedMessage } = archivedFixture();
    const result = await harness.service.receiveInvocationBundle(invocationBundle({ invocation: originalInvocation, message: request }));
    expect(result).toEqual({ status: 200, body: { ok: true, duplicate: true, flight: expected.flight } });
    expect(harness.plannedInvocations).toEqual([]);
    expect(harness.runDispatchJobs).toEqual([]);
    expect(harness.rememberedInvocations).toEqual([]);
    expect(harness.committedEntries).toEqual([]);
    expect(harness.messages).toEqual({});
    expect(harness.invocations).toEqual({});
    expect(harness.flights).toEqual({});
    expect(store.readInvocationSnapshot(originalInvocation.id)).toEqual(expected);
    expect(store.readMessages([request.id]).get(request.id)).toEqual(expectedMessage);
    expect(store.writerDb.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("archived anchors reject changed message content and identity before applying a retried bundle", async () => {
    const { harness, store, request, originalInvocation, expectedMessage } = archivedFixture();
    for (const changed of [{ ...request, body: "changed work" }, { ...request, metadata: { replaced: true } }]) {
      await expect(harness.service.receiveInvocationBundle(invocationBundle({ invocation: originalInvocation, message: changed })))
        .rejects.toThrow("conflicts with existing record");
    }
    await expect(harness.service.receiveInvocationBundle(invocationBundle({ invocation: { ...originalInvocation, requesterNodeId: "wrong-peer" }, message: request })))
      .rejects.toThrow("persisted request anchor");
    expect(harness.applyBundleCalls).toEqual([]);
    expect(harness.committedEntries).toEqual([]);
    expect(harness.plannedInvocations).toEqual([]);
    expect(harness.runDispatchJobs).toEqual([]);
    expect(store.readMessages([request.id]).get(request.id)).toEqual(expectedMessage);
  });

  test("archived messages remain duplicate receipts and reject collisions without a new delivery", async () => {
    const { harness, request, expectedMessage } = archivedFixture();
    expect((await harness.service.receiveMessageBundle(messageBundle({ message: request }))).body).toEqual({ ok: true, duplicate: true, message: expectedMessage });
    expect(harness.completedReplies).toEqual([expectedMessage!]);
    await expect(harness.service.receiveMessageBundle(messageBundle({ message: { ...request, body: "collision" } })))
      .rejects.toThrow("conflicts with existing record");
    expect(harness.committedEntries).toEqual([]);
    expect(harness.messages).toEqual({});
    expect(harness.completedReplies).toHaveLength(1);
  });

  test("missing or mismatched historical flight cannot turn a persisted invocation into fresh work", async () => {
    for (const historicalFlight of [undefined, flight({ invocationId: "other-invocation" }), flight({ requesterId: "other-requester" }), flight({ targetAgentId: "other-target" })]) {
      const harness = createHarness({ invocationSnapshotFor: async () => ({ invocation: invocation(), flight: historicalFlight }) });
      await expect(harness.service.receiveInvocationBundle(invocationBundle({ message: message() })))
        .rejects.toThrow(historicalFlight ? "conflicts with its persisted flight" : "has no persisted flight");
      expect(harness.applyBundleCalls).toEqual([]);
      expect(harness.committedEntries).toEqual([]);
      expect(harness.runDispatchJobs).toEqual([]);
    }
  });

  test("a failed historical read is not treated as a new invocation or message", async () => {
    const harness = createHarness({
      invocationSnapshotFor: async () => { throw new Error("history unavailable"); },
      messageFor: async () => { throw new Error("history unavailable"); },
    });
    await expect(harness.service.receiveInvocationBundle(invocationBundle())).rejects.toThrow("history unavailable");
    await expect(harness.service.receiveMessageBundle(messageBundle())).rejects.toThrow("history unavailable");
    expect(harness.applyBundleCalls).toEqual([]);
    expect(harness.committedEntries).toEqual([]);
    expect(harness.runDispatchJobs).toEqual([]);
  });

  test("replicates a cardless tmux ask's request anchor before dispatch, without another delivery", async () => {
    const targetAgentId = "session-mini";
    const bundle = invocationBundle({
      agents: [],
      invocation: invocation({ targetAgentId }),
      conversation: conversation({ authorityNodeId: "node-peer" }),
      message: message(),
    });
    const harness = createHarness({ localEndpoints: {
      [targetAgentId]: { id: "endpoint-mini", agentId: targetAgentId, nodeId: "node-local", harness: "claude", transport: "tmux", state: "idle" },
    } });
    expect((await harness.service.receiveInvocationBundle(bundle)).status).toBe(200);
    expect(harness.messages[bundle.message!.id]).toEqual(bundle.message);
    expect(harness.committedEntries.flat().map(entry => entry.kind)).toEqual([
      "message.record", "invocation.record", "invocation.dispatch_job.record", "flight.record",
    ]);
    expect(harness.runDispatchJobs).toHaveLength(1);
    await harness.service.receiveInvocationBundle(bundle);
    expect(harness.runDispatchJobs).toHaveLength(1);
    expect(harness.committedEntries.flat().filter(entry => entry.kind === "message.record")).toHaveLength(1);
  });

  test("duplicate invocation repairs a missing request anchor without redispatch", async () => {
    const harness = createHarness({ flights: { "invocation-1": flight({ state: "running" }) }, invocations: { "invocation-1": invocation() } });
    const bundle = invocationBundle({ message: message() });
    const result = await harness.service.receiveInvocationBundle(bundle);
    expect(result.body).toMatchObject({ duplicate: true });
    expect(harness.messages["msg-1"]).toEqual(bundle.message);
    expect(harness.runDispatchJobs).toEqual([]);
  });

  test("rejects a mismatched or conflicting request anchor rather than replacing canonical truth", async () => {
    const harness = createHarness();
    await expect(harness.service.receiveInvocationBundle(invocationBundle({ message: message({ actorId: "other" }) })))
      .rejects.toThrow("does not match its request anchor");
    expect(harness.applyBundleCalls).toEqual([]);
    harness.messages["msg-1"] = message({ body: "canonical" });
    await expect(harness.service.receiveInvocationBundle(invocationBundle({ message: message() })))
      .rejects.toThrow("conflicts with existing record");
    expect(harness.messages["msg-1"].body).toBe("canonical");
    expect(harness.runDispatchJobs).toEqual([]);
  });

  test("rejects conflicting duplicate messages without accepting or completing the incoming reply", async () => {
    const canonical = message({ id: "collision", body: "unrelated FYI" });
    const harness = createHarness({ messages: { collision: canonical } });
    const incoming = message({ id: canonical.id, actorId: "agent-1", replyToMessageId: "msg-request", body: "NONCANONICAL RESULT" });
    await expect(harness.service.receiveMessageBundle(messageBundle({ message: incoming })))
      .rejects.toThrow("conflicts with existing record");
    expect(harness.messages.collision).toBe(canonical);
    expect(harness.completedReplies).toEqual([]);
    expect(harness.committedEntries).toEqual([]);
    expect(harness.applyBundleCalls).toEqual([]);
  });

  test("exact duplicate messages complete only from the stored canonical record", async () => {
    const canonical = message({ actorId: "agent-1", replyToMessageId: "msg-request", body: "accepted result" });
    const harness = createHarness({ messages: { [canonical.id]: canonical } });
    const result = await harness.service.receiveMessageBundle(messageBundle({ message: { ...canonical } }));
    expect(result.body).toEqual({ ok: true, duplicate: true, message: canonical });
    expect(harness.completedReplies).toHaveLength(1);
    expect(harness.completedReplies[0]).toBe(canonical);
    expect(harness.committedEntries).toEqual([]);
  });

  test("duplicate invocation receipts validate the persisted request anchor before any writes", async () => {
    for (const patch of [
      { messageId: "msg-other" }, { requesterId: "other-requester" },
      { requesterNodeId: "other-node" }, { conversationId: "conversation-other" },
      { targetAgentId: "agent-other" },
      { messageId: "msg-other", requesterId: "other-requester" },
    ]) {
      const harness = createHarness();
      await harness.service.receiveInvocationBundle(invocationBundle({ message: message() }));
      const altered = invocation(patch);
      const bundle = invocationBundle({
        invocation: altered,
        conversation: conversation({ id: altered.conversationId }),
        message: message({ id: altered.messageId, conversationId: altered.conversationId, actorId: altered.requesterId }),
      });
      await expect(harness.service.receiveInvocationBundle(bundle)).rejects.toThrow("persisted request anchor");
      expect(harness.invocations[altered.id]).toEqual(invocation());
      expect(Object.keys(harness.messages)).toEqual(["msg-1"]);
      expect(harness.applyBundleCalls).toHaveLength(1);
      expect(harness.committedEntries).toHaveLength(2);
      expect(harness.runDispatchJobs).toHaveLength(1);
      // Old bundles without a message must not bypass the persisted-anchor check.
      await expect(harness.service.receiveInvocationBundle({ ...bundle, message: undefined }))
        .rejects.toThrow("persisted request anchor");
      expect(harness.applyBundleCalls).toHaveLength(1);
    }
  });

  test("records local-authority mesh messages and projects bundle plus message entries", async () => {
    const harness = createHarness();
    const bundle = messageBundle();

    const result = await harness.service.receiveMessageBundle(bundle);

    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        message: bundle.message,
        deliveries: [expect.objectContaining({ id: "delivery-1", messageId: "msg-1" })],
      },
    });
    expect(harness.messages["msg-1"]).toBe(bundle.message);
    expect(harness.completedReplies).toEqual([bundle.message]);
    expect(harness.committedEntries[0]?.map((entry) => entry.kind)).toEqual([
      "message.record",
      "deliveries.record",
    ]);
    expect(harness.projectedEntries[0]?.map((entry) => entry.kind)).toEqual([
      "node.upsert",
      "message.record",
      "deliveries.record",
    ]);
  });

  test("rejects non-authority mesh messages after projecting retained bundle entries", async () => {
    const harness = createHarness();
    const bundle = messageBundle({
      conversation: conversation({ authorityNodeId: "node-peer" }),
    });

    const result = await harness.service.receiveMessageBundle(bundle);

    expect(result).toEqual({
      status: 409,
      body: {
        error: "not_authority",
        detail: "conversation conversation-1 is owned by node-peer",
      },
    });
    expect(harness.messages["msg-1"]).toBeUndefined();
    expect(harness.completedReplies).toEqual([]);
    expect(harness.committedEntries).toEqual([]);
    expect(harness.projectedEntries[0]?.map((entry) => entry.kind)).toEqual(["node.upsert"]);
  });

  test("records local-authority mesh invocations and remembers them for daemon reads", async () => {
    const nextAgent = agent({ id: "agent-from-bundle" });
    const nextInvocation = invocation({
      id: "invocation-from-bundle",
      targetAgentId: nextAgent.id,
    });
    const bundle = invocationBundle({
      agents: [nextAgent],
      invocation: nextInvocation,
    });
    const harness = createHarness();

    const result = await harness.service.receiveInvocationBundle(bundle);

    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        flight: expect.objectContaining({
          invocationId: "invocation-from-bundle",
          targetAgentId: "agent-from-bundle",
        }),
      },
    });
    expect(harness.rememberedInvocations).toEqual([nextInvocation]);
    expect(harness.runDispatchJobs).toEqual([
      expect.objectContaining({
        invocation: nextInvocation,
        job: expect.objectContaining({
          invocationId: "invocation-from-bundle",
          targetAgentId: "agent-from-bundle",
          state: "pending",
        }),
      }),
    ]);
    expect(harness.committedEntries[0]?.map((entry) => entry.kind)).toEqual([
      "invocation.record",
      "invocation.dispatch_job.record",
      "flight.record",
    ]);
    expect(harness.flights["invocation-from-bundle"]).toEqual(expect.objectContaining({
      invocationId: "invocation-from-bundle",
    }));
  });

  test("accepts cardless session invocations when this node owns the session endpoint", async () => {
    const sessionActorId = "flat-claude-4fad8bb9";
    const nextInvocation = invocation({
      id: "invocation-cardless",
      targetAgentId: sessionActorId,
    });
    const bundle = invocationBundle({
      agents: [],
      actors: [actor(), actor({ id: sessionActorId, kind: "session" })],
      invocation: nextInvocation,
    });
    const harness = createHarness({
      localEndpoints: {
        [sessionActorId]: {
          id: "endpoint-cardless",
          agentId: sessionActorId,
          nodeId: "node-local",
          harness: "claude",
          transport: "claude_stream_json",
          state: "idle",
          sessionId: sessionActorId,
          metadata: { cardless: true },
        } as AgentEndpoint,
      },
    });

    const result = await harness.service.receiveInvocationBundle(bundle);

    expect(result.status).toBe(200);
    expect(harness.rememberedInvocations).toEqual([nextInvocation]);
    expect(harness.runDispatchJobs).toEqual([
      expect.objectContaining({
        invocation: nextInvocation,
        job: expect.objectContaining({ targetAgentId: sessionActorId }),
      }),
    ]);
  });

  test("rejects cardless session invocations with no local endpoint", async () => {
    const bundle = invocationBundle({
      agents: [],
      invocation: invocation({
        id: "invocation-unknown",
        targetAgentId: "flat-claude-nowhere",
      }),
    });
    const harness = createHarness();

    await expect(harness.service.receiveInvocationBundle(bundle))
      .rejects.toThrow("unknown target agent flat-claude-nowhere");
    expect(harness.rememberedInvocations).toEqual([]);
    expect(harness.runDispatchJobs).toEqual([]);
  });

  test("returns duplicate mesh invocations without appending invocation entries", async () => {
    const existing = flight();
    const harness = createHarness({
      agents: { "agent-1": agent() },
      flights: { "invocation-1": existing },
      invocations: { "invocation-1": invocation() },
    });

    const result = await harness.service.receiveInvocationBundle(invocationBundle());

    expect(result).toEqual({
      status: 200,
      body: { ok: true, duplicate: true, flight: existing },
    });
    expect(harness.committedEntries).toEqual([]);
    expect(harness.rememberedInvocations).toEqual([]);
    expect(harness.projectedEntries[0]?.map((entry) => entry.kind)).toEqual(["node.upsert"]);
  });

  test("rejects non-authority collaboration records without applying the bundle", async () => {
    const harness = createHarness();
    const bundle = collaborationRecordBundle({
      conversation: conversation({ authorityNodeId: "node-peer" }),
    });

    const result = await harness.service.receiveCollaborationRecordBundle(bundle);

    expect(result).toEqual({
      status: 409,
      body: {
        error: "not_authority",
        detail: "conversation conversation-1 is owned by node-peer",
      },
    });
    expect(harness.applyBundleCalls).toEqual([]);
    expect(harness.projectedEntries).toEqual([]);
  });

  test("applies local collaboration events and projects retained entries", async () => {
    const harness = createHarness();

    const result = await harness.service.receiveCollaborationEventBundle(collaborationEventBundle());

    expect(result).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(harness.applyBundleCalls).toHaveLength(1);
    expect(harness.projectedEntries[0]?.map((entry) => entry.kind)).toEqual(["node.upsert"]);
  });
});
