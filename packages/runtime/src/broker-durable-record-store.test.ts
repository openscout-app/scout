import { deliveryRequestMessageId, deliveryRequestInvocationId, recoverAcceptedInvocation, recoverAcceptedDelivery } from "./broker-delivery-receipt-recovery.js";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentDefinition,
  AgentEndpoint,
  ConversationDefinition,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
  NodeDefinition,
} from "@openscout/protocol";
import { createInvocationDispatchJob, type BrokerInvocationDispatchJob } from "./broker-dispatch-job.js";

import { createInMemoryControlRuntime } from "./broker.js";
import { BrokerChannelInviteService } from "./broker-channel-invite-service.js";
import { FileBackedBrokerJournal, type BrokerJournalEntry } from "./broker-journal.js";
import { BrokerDurableRecordStore, isEndpointLastSeenHeartbeat } from "./broker-durable-record-store.js";
import { BrokerDurableStore } from "./broker-durable-store.js";
import { createRegistryRetentionEvaluator } from "./broker-registry-retention.js";
import { ConversationProjectionStore } from "./conversation-projection-store.js";
import type { ControlPlaneSqliteTransactionalDatabase } from "./sqlite-adapter.js";
import { RecoverableSQLiteProjection } from "./sqlite-projection.js";
import { SQLiteControlPlaneStore } from "./sqlite-store.js";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createTestRecordStore(options: {
  beforeAppend?: () => Promise<void>;
  memberConversationIds?: (actorId: string) => string[];
} = {}) {
  const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });
  const appended: BrokerJournalEntry[][] = [];
  const projected: BrokerJournalEntry[][] = [];
  const jobs = new Map<string, BrokerInvocationDispatchJob>();
  const durableStore = new BrokerDurableStore({
    journal: {
      async appendEntries(entries) {
        await options.beforeAppend?.();
        appended.push(entries);
        for (const entry of entries) if (entry.kind === "invocation.dispatch_job.record") jobs.set(entry.job.id, entry.job);
        return entries;
      },
    },
    projection: {
      async applyEntries(entries) {
        projected.push(entries);
        return [];
      },
    },
    threadEvents: {
      publish() {},
    },
  });
  const knownInvocations = new Map<string, InvocationRequest>();
  const records = new BrokerDurableRecordStore({
    localNodeId: "node-1",
    runtime,
    durableStore,
    knownInvocations,
    invocationDispatchJobFor: (id) => jobs.get(id) ?? null,
    memberConversationIds: options.memberConversationIds,
  });

  return {
    runtime,
    durableStore,
    appended,
    projected,
    knownInvocations,
    records,
  };
}

function testNode(): NodeDefinition {
  return {
    id: "node-1",
    name: "Node One",
    kind: "local",
    lastSeenAt: 1,
    capabilities: [],
    metadata: {},
  };
}

function testAgent(): AgentDefinition {
  return {
    id: "agent-1",
    kind: "agent",
    definitionId: "agent-1",
    displayName: "Agent One",
    handle: "agent-1",
    labels: ["test"],
    selector: "@agent-1",
    defaultSelector: "@agent-1",
    metadata: { source: "test" },
    agentClass: "general",
    capabilities: ["chat", "invoke"],
    wakePolicy: "on_demand",
    homeNodeId: "node-1",
    authorityNodeId: "node-1",
    advertiseScope: "local",
  };
}

function testEndpoint(input: Partial<AgentEndpoint> = {}): AgentEndpoint {
  return {
    id: "endpoint-1",
    agentId: "agent-1",
    nodeId: "node-1",
    harness: "codex",
    transport: "codex_app_server",
    state: "active",
    sessionId: "session-1",
    metadata: { source: "test", lastSeenAt: 1 },
    ...input,
  };
}

function testConversation(): ConversationDefinition {
  return {
    id: "conversation-1",
    kind: "direct",
    title: "Agent One",
    visibility: "workspace",
    shareMode: "local",
    authorityNodeId: "node-1",
    participantIds: ["operator", "agent-1"],
    metadata: {},
  };
}

function testMessage(): MessageRecord {
  return {
    id: "message-1",
    conversationId: "conversation-1",
    actorId: "operator",
    originNodeId: "node-1",
    class: "agent",
    body: "hello",
    mentions: [{ actorId: "agent-1", label: "@agent-1" }],
    audience: {
      notify: ["agent-1"],
    },
    visibility: "workspace",
    policy: "durable",
    createdAt: 1,
  };
}

function testInvocation(input: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    id: "invocation-1",
    requesterId: "operator",
    requesterNodeId: "node-1",
    targetAgentId: "agent-1",
    action: "consult",
    task: "hello",
    ensureAwake: true,
    stream: false,
    createdAt: 1,
    ...input,
  };
}

describe("canonical chat question responses", () => {
  const question = { id: "question-1", kind: "question" as const, state: "open" as const, acceptanceState: "none" as const,
    title: "Which release?", createdById: "requester", ownerId: "respondent", nextMoveOwnerId: "respondent",
    conversationId: "conversation-1", createdAt: 1, updatedAt: 1 };
  async function seed(runtime: ReturnType<typeof createInMemoryControlRuntime>) {
    await runtime.upsertConversation({ ...testConversation(), kind: "channel", participantIds: ["requester", "respondent"] });
    await runtime.upsertCollaboration(question);
  }
  test("racing answers produce one record/event transaction and preserve review responsibility", async () => {
    const { records, runtime, appended } = createTestRecordStore();
    await seed(runtime);
    const outcomes = await Promise.allSettled([
      records.respondToChatQuestion("conversation-1", question.id, "respondent", false, { action: "answer", expectedUpdatedAt: 1, answer: "Release two" }),
      records.respondToChatQuestion("conversation-1", question.id, "respondent", false, { action: "answer", expectedUpdatedAt: 1, answer: "Stale answer" }),
    ]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.map(entry => entry.kind)).toEqual(["collaboration.record", "collaboration.event.record"]);
    const answered = runtime.collaborationRecord(question.id)!;
    expect(answered).toMatchObject({ state: "answered", answer: "Release two", nextMoveOwnerId: "requester", acceptanceState: "pending" });
    await expect(records.respondToChatQuestion("conversation-1", question.id, "respondent", false, { action: "close", expectedUpdatedAt: answered.updatedAt })).rejects.toThrow("requesting actor");
    const closed = await records.respondToChatQuestion("conversation-1", question.id, "requester", false, { action: "close", expectedUpdatedAt: answered.updatedAt });
    expect(closed).toMatchObject({ state: "closed", acceptanceState: "accepted" });
    expect(closed.nextMoveOwnerId).toBeUndefined();
  });
  test("membership, channel scope and explicit assignment are checked before mutation", async () => {
    const { records, runtime, appended } = createTestRecordStore();
    await seed(runtime);
    const change = { action: "answer", expectedUpdatedAt: 1, answer: "Two" };
    await expect(records.respondToChatQuestion("elsewhere", question.id, "respondent", true, change)).rejects.toThrow("not available");
    await expect(records.respondToChatQuestion("conversation-1", question.id, "stranger", false, change)).rejects.toThrow("member");
    await expect(records.respondToChatQuestion("conversation-1", question.id, "requester", true, change)).rejects.toThrow("assigned respondent");
    expect(appended).toHaveLength(0);
  });
  test("journal failure does not accept the answer", async () => {
    const { records, runtime } = createTestRecordStore({ beforeAppend: async () => { throw new Error("injected failure"); } });
    await seed(runtime);
    await expect(records.respondToChatQuestion("conversation-1", question.id, "respondent", false, { action: "answer", expectedUpdatedAt: 1, answer: "Two" })).rejects.toThrow("injected failure");
    expect(runtime.collaborationRecord(question.id)).toMatchObject({ state: "open", updatedAt: 1 });
  });
});

describe("canonical chat corrections", () => {
  test("serializes competing edits, retains message identity, and creates no delivery or posted event", async () => {
    const { runtime, records, appended } = createTestRecordStore();
    await runtime.upsertConversation(testConversation());
    const original = testMessage();
    await runtime.commitMessage(original, []);
    const postsBefore = runtime.recentEvents().filter(event => event.kind === "message.posted").length;
    const results = await Promise.allSettled([
      records.correctMessage(original.conversationId, original.id, original.actorId, false, { expectedRevision: 0, body: "First edit" }),
      records.correctMessage(original.conversationId, original.id, original.actorId, false, { expectedRevision: 0, body: "Stale edit" }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(runtime.peek().messages[original.id]).toMatchObject({ id: original.id, createdAt: original.createdAt, body: "First edit" });
    expect(appended).toHaveLength(1);
    expect(appended[0]?.map(entry => entry.kind)).toEqual(["message.record"]);
    expect(runtime.recentEvents().filter(event => event.kind === "message.posted")).toHaveLength(postsBefore);
    expect(runtime.recentEvents().filter(event => event.kind === "message.corrected")).toHaveLength(1);
    await expect(records.correctMessage("foreign-channel", original.id, original.actorId, true, { expectedRevision: 1, deleted: true })).rejects.toThrow("not available");
    await expect(records.correctMessage(original.conversationId, original.id, "other", true, { expectedRevision: 1, body: "Impersonation" })).rejects.toThrow("Only the author");
  });
  test("journal failure leaves the prior message intact", async () => {
    const { records, runtime } = createTestRecordStore({ beforeAppend: async () => { throw new Error("injected failure"); } });
    const original = testMessage();
    await runtime.commitMessage(original, []);
    await expect(records.correctMessage(original.conversationId, original.id, original.actorId, false, { expectedRevision: 0, deleted: true })).rejects.toThrow("injected failure");
    expect(runtime.peek().messages[original.id]).toEqual(original);
  });
});

describe("canonical shared channel pins", () => {
  test("concurrent pins and titles preserve each other and journal channel state", async () => {
    const { runtime, records, appended } = createTestRecordStore();
    const original = testConversation();
    await runtime.upsertConversation(original);
    await Promise.all([
      records.updateConversationPins(original.id, "maya", { messageId: "a", pinned: true }),
      records.setConversationTitle(original.id, "Named channel"),
      records.updateConversationPins(original.id, "alex", { messageId: "b", pinned: true }),
    ]);
    const next = runtime.peek().conversations[original.id]!;
    expect(next.title).toBe("Named channel");
    expect(next.participantIds).toEqual(original.participantIds);
    expect(next.metadata?.chatPins).toEqual([
      { messageId: "a", pinnedBy: "maya", pinnedAt: expect.any(Number) },
      { messageId: "b", pinnedBy: "alex", pinnedAt: expect.any(Number) },
    ]);
    expect(appended).toHaveLength(3);
    expect(await records.updateConversationPins("missing", "maya", { messageId: "a", pinned: true })).toBeNull();
  });
  test("failed persistence never exposes an uncommitted pin", async () => {
    const { records, runtime } = createTestRecordStore({ beforeAppend: async () => { throw new Error("injected journal failure"); } });
    const original = testConversation();
    await runtime.upsertConversation(original);
    await expect(records.updateConversationPins(original.id, "maya", { messageId: "a", pinned: true })).rejects.toThrow("injected journal failure");
    expect(runtime.peek().conversations[original.id]?.metadata?.chatPins).toBeUndefined();
  });
});

describe("canonical conversation title mutation", () => {
  test("patches the latest coordination state after writes already queued ahead of rename", async () => {
    const { runtime, durableStore, records, appended } = createTestRecordStore();
    const original = testConversation();
    await runtime.upsertConversation(original);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocker = durableStore.runWrite(async () => { entered(); await gate; });
    await started;
    const changed = { ...original, participantIds: [...original.participantIds, "agent-new"],
      shareMode: "shared" as const, metadata: { routingEpoch: 7, source: "coordination" } };
    const coordination = records.upsertConversation(changed);
    const rename = records.setConversationTitle(original.id, "Operator name");
    release();
    await Promise.all([blocker, coordination]);
    const titled = await rename;
    expect(titled).toMatchObject({ ...changed, title: "Operator name",
      metadata: { ...changed.metadata, titleSource: "operator", titleSetAt: expect.any(Number) } });
    expect(runtime.peek().conversations[original.id]).toMatchObject({ ...changed, title: "Operator name", metadata: { titleSource: "operator" } });
    expect(appended).toHaveLength(2);
    expect(appended[1]![0]).toEqual({ kind: "conversation.upsert", conversation: titled });
    const cleared = await records.setConversationTitle(original.id, "");
    expect(cleared).toMatchObject({ ...changed, title: "Operator name" });
    expect(cleared?.metadata).not.toHaveProperty("titleSource");
    expect(cleared?.metadata).not.toHaveProperty("titleSetAt");
  });

  test("unknown conversation does not append or create a record", async () => {
    const { records, appended, runtime } = createTestRecordStore();
    expect(await records.setConversationTitle("missing", "New name")).toBeNull();
    expect(appended).toEqual([]);
    expect(runtime.peek().conversations.missing).toBeUndefined();
  });

  test("journal failure rejects rename without changing canonical runtime state", async () => {
    const { records, runtime, appended } = createTestRecordStore({ beforeAppend: async () => { throw new Error("injected journal failure"); } });
    const original = testConversation();
    await runtime.upsertConversation(original);
    const before = structuredClone(runtime.peek().conversations[original.id]);
    await expect(records.setConversationTitle(original.id, "Uncommitted")).rejects.toThrow("injected journal failure");
    expect(runtime.peek().conversations[original.id]).toEqual(before);
    expect(appended).toEqual([]);
  });
});

describe("BrokerDurableRecordStore", () => {
  test("canonical acceptance frame contains a complete recoverable receipt before sidecar save", async () => {
    const h = createTestRecordStore();
    await h.runtime.upsertNode(testNode());
    await h.runtime.upsertAgent(testAgent());
    await h.runtime.upsertConversation(testConversation());
    const request = testInvocation();
    const message = testMessage();
    request.id = deliveryRequestInvocationId(request.requesterId, "retry-key");
    request.conversationId = message.conversationId;
    message.id = deliveryRequestMessageId(request.requesterId, "retry-key");
    request.messageId = message.id;
    message.metadata = { scoutAcceptance: {
      version: 1, requesterId: request.requesterId, requestId: "retry-key",
      response: { kind: "delivery", accepted: true, routeKind: "direct", conversation: { id: message.conversationId }, targetAgentId: request.targetAgentId },
      receiptInput: { requestId: "retry-key", requesterId: request.requesterId, requesterNodeId: "node-1", routeKind: "direct", conversationId: message.conversationId, messageId: message.id, targetAgentId: request.targetAgentId, targetLabel: "Agent" },
    } };
    const accepted = await h.records.recordInvocation(request, { message, createDispatchJob: flight => createInvocationDispatchJob(request, flight, 100) });
    expect(h.appended).toHaveLength(1);
    const stored = h.appended[0].find(entry => entry.kind === "message.record");
    expect(stored?.kind).toBe("message.record");
    const recovered = recoverAcceptedDelivery(stored?.kind === "message.record" ? stored.message : undefined, request.requesterId, "retry-key");
    expect(recovered?.flight?.id).toBe(accepted.flight.id);
    expect(recovered?.receipt.flightId).toBe(accepted.flight.id);
    expect(recovered?.message.id).toBe(message.id);
    expect(recovered?.message.metadata?.scoutAcceptance).toBeUndefined();
    expect(recoverAcceptedDelivery(stored?.kind === "message.record" ? stored.message : undefined, "someone-else", "retry-key")).toBeNull();
    expect((accepted.flight.metadata?.dispatchOutcome as { checkedAt: number }).checkedAt).toBeGreaterThanOrEqual(accepted.dispatchJob!.createdAt);
    const remoteMessage = structuredClone(message);
    remoteMessage.id = deliveryRequestMessageId(request.requesterId, "remote-retry-key");
    const remoteEnvelope = remoteMessage.metadata!.scoutAcceptance as any;
    remoteEnvelope.requestId = remoteEnvelope.receiptInput.requestId = "remote-retry-key";
    remoteEnvelope.receiptInput.messageId = remoteMessage.id;
    const remoteRequest = { ...request, messageId: remoteMessage.id, id: deliveryRequestInvocationId(request.requesterId, "remote-retry-key") };
    const remote = await h.records.recordInvocation(remoteRequest, { receiptMessage: remoteMessage,
      createDispatchJob: flight => createInvocationDispatchJob(remoteRequest, flight, 999_999) });
    expect(h.appended[1].some(entry => entry.kind === "message.record")).toBe(false);
    const remoteStored = h.appended[1].find(entry => entry.kind === "invocation.record");
    expect(recoverAcceptedInvocation(remoteStored?.kind === "invocation.record" ? remoteStored.invocation : undefined,
      request.requesterId, "remote-retry-key")?.flight?.id).toBe(remote.flight.id);
    expect((remote.flight.metadata?.dispatchOutcome as { checkedAt: number }).checkedAt).toBeGreaterThanOrEqual(999_999);
  });

  test("reused legacy message recovers through local invocation without rewriting the message authority", async () => {
    const h = createTestRecordStore();
    await h.runtime.upsertNode(testNode());
    await h.runtime.upsertAgent(testAgent());
    await h.runtime.upsertConversation(testConversation());
    const original = { ...testMessage(), metadata: { clientMessageId: "old-client-id", original: "preserve" } };
    await h.records.recordMessage(original);
    const before = structuredClone(h.runtime.peek().messages[original.id]);
    const request = testInvocation({ id: deliveryRequestInvocationId("operator", "new-request"),
      messageId: original.id, conversationId: original.conversationId });
    const acceptedMessage = { ...original, metadata: { ...original.metadata, scoutAcceptance: {
      version: 1, requesterId: "operator", requestId: "new-request",
      response: { kind: "delivery", accepted: true, routeKind: "dm", conversation: testConversation(), targetAgentId: request.targetAgentId },
      receiptInput: { requestId: "new-request", requesterId: "operator", requesterNodeId: "node-1", routeKind: "dm",
        conversationId: original.conversationId, messageId: original.id, targetAgentId: request.targetAgentId, targetLabel: "Agent" },
    } } };
    const accepted = await h.records.recordInvocation(request, { message: acceptedMessage });
    expect(accepted.entries.some(entry => entry.kind === "message.record")).toBe(false);
    expect(h.runtime.peek().messages[original.id]).toEqual(before);
    const recovered = recoverAcceptedInvocation(h.runtime.peek().invocations[request.id], "operator", "new-request");
    expect(recovered?.message.id).toBe(original.id);
    expect(recovered?.flight?.id).toBe(accepted.flight.id);
    expect(recovered?.conversation.authorityNodeId).toBe("node-1");
    const receiptBefore = structuredClone(h.runtime.peek().invocations[request.id]!.metadata!.acceptedDeliveryReceipt);
    const retry = await h.records.recordInvocation(request, { message: { ...acceptedMessage, body: "must not replace original receipt" } });
    expect(retry.entries).toEqual([]);
    expect(h.runtime.peek().invocations[request.id]!.metadata!.acceptedDeliveryReceipt).toEqual(receiptBefore);
  });

  test("message, invocation, flight and scheduler job form one commit and concurrent retries reuse it", async () => {
    const { runtime, records, appended, knownInvocations } = createTestRecordStore();
    await runtime.upsertNode(testNode());
    await runtime.upsertAgent(testAgent());
    await runtime.upsertConversation(testConversation());
    const message = testMessage();
    const request = testInvocation({ messageId: message.id, conversationId: message.conversationId });
    const options = { message, createDispatchJob: (flight: FlightRecord) => createInvocationDispatchJob(request, flight, 1) };
    const [first, second] = await Promise.all([records.recordInvocation(request, options), records.recordInvocation(request, options)]);
    expect(first.flight.id).toBe(second.flight.id);
    expect(first.dispatchJob).toEqual(second.dispatchJob);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.map(entry => entry.kind)).toEqual([
      "message.record", "deliveries.record", "invocation.record", "invocation.dispatch_job.record", "flight.record",
    ]);
    expect(runtime.peek().messages[message.id]?.body).toBe(message.body);
    expect(knownInvocations.get(request.id)?.messageId).toBe(message.id);
  });

  test("failed acceptance exposes neither message nor invocation cache entries", async () => {
    const { runtime, records, knownInvocations } = createTestRecordStore({ beforeAppend: async () => { throw new Error("disk write failed"); } });
    await runtime.upsertNode(testNode());
    await runtime.upsertAgent(testAgent());
    await runtime.upsertConversation(testConversation());
    const message = testMessage();
    const request = testInvocation({ messageId: message.id, conversationId: message.conversationId });
    await expect(records.recordInvocation(request, { message })).rejects.toThrow("disk write failed");
    expect(runtime.peek().messages[message.id]).toBeUndefined();
    expect(runtime.flightForInvocation(request.id)).toBeUndefined();
    expect(knownInvocations.has(request.id)).toBe(false);
  });

  test("dispatch job eligibility is checked inside the writer against the latest committed version", async () => {
    const { records, appended } = createTestRecordStore();
    const job = createInvocationDispatchJob(testInvocation(), { id: "flight-1" } as FlightRecord, 1);
    await records.recordInvocationDispatchJob(job);
    const claims = await Promise.all([1, 2].map(attempts => records.recordInvocationDispatchJobIf(
      { ...job, state: "running", attempts }, current => current?.state === "pending",
    )));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(appended).toHaveLength(2);
  });

  test("can defer projection only for explicit bootstrap node and actor writes", async () => {
    const { appended, projected, records, runtime } = createTestRecordStore();
    const actor = testAgent();

    await records.upsertNode(testNode(), { enqueueProjection: false });
    await records.upsertActor(actor, { enqueueProjection: false });

    expect(appended.map((entries) => entries[0]?.kind)).toEqual([
      "node.upsert",
      "actor.upsert",
    ]);
    expect(projected).toEqual([]);
    expect(runtime.snapshot().nodes["node-1"]).toBeDefined();
    expect(runtime.snapshot().actors["agent-1"]).toBeDefined();
  });

  test("detects endpoint last-seen-only heartbeats", () => {
    const previous = testEndpoint({ metadata: { source: "test", lastSeenAt: 1 } });
    const next = testEndpoint({ metadata: { source: "test", lastSeenAt: 2 } });
    const changed = testEndpoint({ state: "idle", metadata: { source: "test", lastSeenAt: 2 } });

    expect(isEndpointLastSeenHeartbeat(previous, next)).toBe(true);
    expect(isEndpointLastSeenHeartbeat(previous, changed)).toBe(false);
  });

  test("persists endpoint heartbeat rows for replay without emitting control events", async () => {
    const { runtime, appended, records } = createTestRecordStore();
    await runtime.upsertEndpoint(testEndpoint({ metadata: { source: "test", lastSeenAt: 1 } }));

    await records.upsertEndpoint(testEndpoint({ metadata: { source: "test", lastSeenAt: 2 } }));

    expect(appended.flat().map(entry => entry.kind)).toEqual(["agent.endpoint.upsert"]);
    expect(runtime.peek().endpoints["endpoint-1"]?.metadata?.lastSeenAt).toBe(2);
  });

  test("skips exact duplicate agent and endpoint upserts", async () => {
    const { appended, records } = createTestRecordStore();
    const agent = testAgent();
    const endpoint = testEndpoint();

    await records.upsertAgent(agent);
    await records.upsertAgent({ ...agent, metadata: { source: "test" } });
    await records.upsertEndpoint(endpoint);
    await records.upsertEndpoint({ ...endpoint, metadata: { source: "test", lastSeenAt: 1 } });

    expect(appended.map((entries) => entries.map((entry) => entry.kind))).toEqual([
      ["actor.upsert", "agent.upsert"],
      ["agent.endpoint.upsert"],
    ]);
  });

  test("persists meaningful agent and endpoint changes", async () => {
    const { appended, records } = createTestRecordStore();
    const agent = testAgent();
    const endpoint = testEndpoint();

    await records.upsertAgent(agent);
    await records.upsertAgent({ ...agent, displayName: "Agent One Updated" });
    await records.upsertEndpoint(endpoint);
    await records.upsertEndpoint({ ...endpoint, state: "idle" });

    expect(appended.map((entries) => entries.map((entry) => entry.kind))).toEqual([
      ["actor.upsert", "agent.upsert"],
      ["actor.upsert", "agent.upsert"],
      ["agent.endpoint.upsert"],
      ["agent.endpoint.upsert"],
    ]);
  });

  test("deletes endpoints through the durable journal", async () => {
    const { runtime, appended, records } = createTestRecordStore();
    await runtime.upsertEndpoint(testEndpoint());

    await records.deleteEndpoint("endpoint-1");

    expect(appended).toEqual([
      [{ kind: "agent.endpoint.delete", endpointId: "endpoint-1", agentId: "agent-1" }],
    ]);
    expect(runtime.peek().endpoints["endpoint-1"]).toBeUndefined();
  });

  test("records messages with planned deliveries in one durable commit", async () => {
    const { runtime, appended, records } = createTestRecordStore();
    await runtime.upsertNode(testNode());
    await runtime.upsertAgent(testAgent());
    await runtime.upsertConversation(testConversation());

    const result = await records.recordMessage(testMessage());

    expect(result.deliveries.some((delivery) => delivery.messageId === "message-1")).toBe(true);
    expect(appended[0]?.map((entry) => entry.kind)).toEqual([
      "message.record",
      "deliveries.record",
    ]);
    expect(runtime.snapshot().messages["message-1"]).toEqual(expect.objectContaining({
      id: "message-1",
    }));
  });

  test("records invocations and flights while updating the daemon invocation cache", async () => {
    const { runtime, appended, knownInvocations, records } = createTestRecordStore();
    await runtime.upsertNode(testNode());
    await runtime.upsertAgent(testAgent());
    const flight: FlightRecord = {
      id: "flight-1",
      invocationId: "invocation-1",
      requesterId: "operator",
      targetAgentId: "agent-1",
      state: "queued",
      startedAt: 1,
    };

    const result = await records.recordInvocation(testInvocation(), { flight });

    expect(result.flight).toBe(flight);
    expect(knownInvocations.get("invocation-1")).toEqual(expect.objectContaining({
      id: "invocation-1",
    }));
    expect(appended[0]?.map((entry) => entry.kind)).toEqual([
      "invocation.record",
      "flight.record",
    ]);
    expect(runtime.flightForInvocation("invocation-1")).toEqual(expect.objectContaining({
      id: "flight-1",
    }));
  });
});

describe("registry deletes", () => {
  test("deleteAgent journals endpoint tombstones and membership removal before the delete", async () => {
    const { runtime, appended, records } = createTestRecordStore();
    await runtime.upsertAgent(testAgent());
    await runtime.upsertEndpoint(testEndpoint());
    await runtime.upsertEndpoint(testEndpoint({ id: "endpoint-2" }));
    await runtime.upsertConversation(testConversation());

    const result = await records.deleteAgent("agent-1");

    expect(result).toEqual({ deleted: true });
    const batch = appended.at(-1)!;
    expect(batch.map((entry) => entry.kind)).toEqual([
      // Endpoint upserts dedupe under their own keys — each surviving
      // endpoint needs an explicit tombstone so compaction cannot
      // resurrect it through agent.delete's cascade.
      "agent.endpoint.delete",
      "agent.endpoint.delete",
      // Membership removal is canonical, not a cascade side effect: a
      // journal rebuild must never restore the deleted id to a roster.
      "conversation.upsert",
      "agent.delete",
    ]);
    expect(batch[0]).toEqual({
      kind: "agent.endpoint.delete", endpointId: "endpoint-1", agentId: "agent-1",
    });
    expect(batch[1]).toEqual({
      kind: "agent.endpoint.delete", endpointId: "endpoint-2", agentId: "agent-1",
    });
    expect(batch[2]).toMatchObject({
      kind: "conversation.upsert",
      conversation: { id: "conversation-1", participantIds: ["operator"] },
    });
    expect(batch[3]).toEqual({
      kind: "agent.delete", agentId: "agent-1", conversationIds: ["conversation-1"],
    });

    const snapshot = runtime.peek();
    expect(snapshot.agents["agent-1"]).toBeUndefined();
    expect(snapshot.endpoints).toEqual({});
    expect(snapshot.conversations["conversation-1"]?.participantIds).toEqual(["operator"]);
  });

  test("deleteActor journals canonical membership removal and unions the SQL preimage", async () => {
    const { runtime, appended, records } = createTestRecordStore({
      // A membership row that exists in SQLite but not yet in canonical
      // state still lands in the delete preimage.
      memberConversationIds: () => ["conv-sql-only"],
    });
    await runtime.upsertActor({ id: "agent-1", kind: "agent", displayName: "Agent One" });
    await runtime.upsertConversation(testConversation());

    const result = await records.deleteActor("agent-1");

    expect(result).toEqual({ deleted: true });
    const batch = appended.at(-1)!;
    expect(batch.map((entry) => entry.kind)).toEqual(["conversation.upsert", "actor.delete"]);
    expect(batch[0]).toMatchObject({
      kind: "conversation.upsert",
      conversation: { id: "conversation-1", participantIds: ["operator"] },
    });
    expect(batch[1]).toEqual({
      kind: "actor.delete",
      actorId: "agent-1",
      conversationIds: ["conv-sql-only", "conversation-1"],
    });
  });

  test("a revival queued ahead of the delete wins the in-writer eligibility check", async () => {
    const { runtime, durableStore, appended, records } = createTestRecordStore();
    await runtime.upsertEndpoint(testEndpoint({
      state: "offline",
      metadata: { lastSeenAt: 1 },
    }));
    const evaluator = createRegistryRetentionEvaluator({ nodeId: "node-1" });

    // Occupy the serialized writer so the revival queues ahead of the delete.
    let release!: () => void;
    const lock = durableStore.runWrite(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    await Promise.resolve();

    const revival = records.upsertEndpoint(testEndpoint({
      state: "active",
      metadata: { lastSeenAt: Date.now() },
    }));
    const deletion = records.deleteEndpoint("endpoint-1", {
      eligible: (snapshot) => evaluator.endpointEligible(snapshot, "endpoint-1"),
    });
    release();
    await Promise.all([lock, revival]);
    const result = await deletion;

    expect(result).toEqual({ deleted: false, reason: "state-active" });
    expect(appended.flat().filter((entry) => entry.kind === "agent.endpoint.delete")).toEqual([]);
    expect(runtime.peek().endpoints["endpoint-1"]?.state).toBe("active");
  });

  test("an eligibility veto journals nothing and reports the reason", async () => {
    const { runtime, appended, records } = createTestRecordStore();
    await runtime.upsertAgent(testAgent());
    await runtime.upsertActor({ id: "actor-1", kind: "person", displayName: "Person" });

    const agentResult = await records.deleteAgent("agent-1", {
      eligible: () => ({ ok: false, reason: "live-peer-node" }),
    });
    const actorResult = await records.deleteActor("actor-1", { eligible: () => false });

    expect(agentResult).toEqual({ deleted: false, reason: "live-peer-node" });
    expect(actorResult).toEqual({ deleted: false, reason: "not eligible" });
    expect(appended).toEqual([]);
    expect(runtime.peek().agents["agent-1"]).toBeDefined();
    expect(runtime.peek().actors["actor-1"]).toBeDefined();
  });

  test("the delete preimage covers canonical membership while the SQLite projection lags", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-durable-preimage-"));
    tempRoots.add(root);
    const store = new SQLiteControlPlaneStore(join(root, "control-plane.sqlite"));
    const projection = new ConversationProjectionStore(
      store.writerDb as ControlPlaneSqliteTransactionalDatabase,
      { operatorActorIds: ["operator"] },
    );
    try {
      store.upsertNode({
        id: "node-1",
        meshId: "mesh-1",
        name: "Node One",
        advertiseScope: "local",
        registeredAt: 1,
      });
      store.upsertActor({ id: "agent-1", kind: "agent", displayName: "Agent One" });
      store.upsertActor({ id: "operator", kind: "person", displayName: "Operator" });

      const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });
      await runtime.upsertActor({ id: "agent-1", kind: "agent", displayName: "Agent One" });

      // Block the projection queue so the conversation's member rows never
      // reach SQLite before the delete — the repro for the empty-preimage
      // bug in review985-preimage.ts.
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const appended: BrokerJournalEntry[] = [];
      const durableStore = new BrokerDurableStore({
        journal: {
          async appendEntries(entries) {
            appended.push(...entries);
            return entries;
          },
        },
        projection: {
          async applyEntries(entries) {
            await blocked;
            for (const entry of entries) {
              if (entry.kind === "conversation.upsert") store.upsertConversation(entry.conversation);
              if (entry.kind === "actor.delete") store.deleteActor(entry.actorId);
            }
            projection.applyBrokerBatch(entries);
            return [];
          },
        },
        threadEvents: { publish() {} },
      });
      const records = new BrokerDurableRecordStore({
        runtime,
        durableStore,
        knownInvocations: new Map(),
        memberConversationIds: (actorId) => store.memberConversationIds(actorId),
      });

      const channel: ConversationDefinition = {
        ...testConversation(),
        id: "chn-1",
        kind: "channel",
        participantIds: ["agent-1", "operator"],
      };
      await records.upsertConversation(channel);
      const result = await records.deleteActor("agent-1");

      expect(result.deleted).toBe(true);
      // Canonical state still lists the membership even though the SQL
      // member row was never materialized — a lagging lookup must not
      // produce an empty authoritative preimage.
      const removalUpsert = appended.find(
        (entry) => entry.kind === "conversation.upsert"
          && !entry.conversation.participantIds.includes("agent-1"),
      );
      expect(removalUpsert).toMatchObject({
        conversation: { id: "chn-1", participantIds: ["operator"] },
      });
      const deleteEntry = appended.find((entry) => entry.kind === "actor.delete");
      expect(deleteEntry).toEqual({
        kind: "actor.delete",
        actorId: "agent-1",
        conversationIds: ["chn-1"],
      });

      release();
      await durableStore.flushProjectedEntries();

      const item = projection.snapshot(10).items.find(
        (feedItem) => feedItem.conversationId === "chn-1",
      );
      expect(item?.participantCount).toBe(1);
    } finally {
      store.close();
    }
  });

  test("guarded actor delete vetoes a cardless actor whose endpoint committed after planning", async () => {
    // Port of /tmp/review985-second-extra.ts: a cardless session actor is a
    // plan candidate while it has no endpoints; an active endpoint then
    // commits ahead of the delete while the SQLite projection lags. The
    // canonical endpoint check must veto even though the store still
    // reports zero references.
    const root = mkdtempSync(join(tmpdir(), "openscout-actor-endpoint-veto-"));
    tempRoots.add(root);
    const store = new SQLiteControlPlaneStore(join(root, "control-plane.sqlite"));
    try {
      const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });
      const actor = {
        id: "sess-1", kind: "session" as const, displayName: "sess-1", createdAt: 1,
      };
      await runtime.upsertActor(actor);
      store.upsertActor(actor);
      const appended: BrokerJournalEntry[] = [];
      let releaseProjection!: () => void;
      const blocked = new Promise<void>((resolve) => { releaseProjection = resolve; });
      const durableStore = new BrokerDurableStore({
        journal: {
          async appendEntries(entries) { appended.push(...entries); return entries; },
        },
        // Projection never drains — SQLite stays a plan-time snapshot.
        projection: { async applyEntries() { await blocked; return []; } },
        threadEvents: { publish() {} },
      });
      const records = new BrokerDurableRecordStore({
        runtime, durableStore, knownInvocations: new Map(),
      });
      const evaluator = createRegistryRetentionEvaluator({ nodeId: "node-1" });

      // Plan-time: candidate (no endpoints, old, unreferenced).
      expect(evaluator.actorEligible(runtime.peek(), "sess-1").ok).toBe(true);

      await records.upsertEndpoint(testEndpoint({
        id: "ep-live",
        agentId: "sess-1",
        state: "active",
        metadata: { lastSeenAt: Date.now() },
      }));

      expect(evaluator.actorEligible(runtime.peek(), "sess-1"))
        .toEqual({ ok: false, reason: "endpoint-survives:ep-live" });
      // The lagging store cannot see the endpoint — the veto is canonical.
      expect(store.actorReferenceCount("sess-1")).toBe(0);

      const result = await records.deleteActor("sess-1", {
        eligible: (snapshot) => {
          const verdict = evaluator.actorEligible(snapshot, "sess-1");
          if (!verdict.ok) return verdict;
          return store.actorReferenceCount("sess-1") > 0
            ? { ok: false, reason: "sqlite-reference" }
            : { ok: true };
        },
      });

      expect(result).toEqual({ deleted: false, reason: "endpoint-survives:ep-live" });
      expect(appended.filter((entry) => entry.kind === "actor.delete")).toEqual([]);
      expect(runtime.peek().actors["sess-1"]).toBeDefined();
      expect(runtime.peek().endpoints["ep-live"]?.state).toBe("active");

      releaseProjection();
      await durableStore.flushProjectedEntries();
    } finally {
      store.close();
    }
  });
});

describe("updateConversation", () => {
  test("applies the mutator to the latest canonical record inside the writer", async () => {
    const { runtime, durableStore, appended, records } = createTestRecordStore();
    await runtime.upsertConversation(testConversation());

    // Occupy the writer so the update queues behind a roster change the
    // caller could not have seen.
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocker = durableStore.runWrite(async () => {
      await runtime.upsertConversation({
        ...testConversation(), participantIds: ["operator"],
      });
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await started;

    let observed: string[] = [];
    const update = records.updateConversation("conversation-1", (current) => {
      observed = current?.participantIds ?? [];
      return current
        ? { ...current, participantIds: [...current.participantIds, "agent-2"].sort() }
        : null;
    });
    release();
    await blocker;
    const result = await update;

    // The mutator saw the post-blocker roster, not the caller's preimage.
    expect(observed).toEqual(["operator"]);
    expect(result.updated).toBe(true);
    expect(result.conversation?.participantIds).toEqual(["agent-2", "operator"]);
    expect(runtime.peek().conversations["conversation-1"]?.participantIds)
      .toEqual(["agent-2", "operator"]);
    expect(appended.at(-1)![0]).toMatchObject({
      kind: "conversation.upsert",
      conversation: { id: "conversation-1", participantIds: ["agent-2", "operator"] },
    });
  });

  test("a null mutator declines the write and journals nothing", async () => {
    const { runtime, appended, records } = createTestRecordStore();
    await runtime.upsertConversation(testConversation());

    const declined = await records.updateConversation("conversation-1", () => null);
    expect(declined.updated).toBe(false);
    expect(declined.conversation?.id).toBe("conversation-1");

    const missing = await records.updateConversation("missing", () => null);
    expect(missing).toEqual({ updated: false, conversation: null });
    expect(appended).toEqual([]);
  });

  test("can create under the target id but cannot drift to another id", async () => {
    const { runtime, records } = createTestRecordStore();

    const created = await records.updateConversation("conv-new", (current) =>
      current ? null : { ...testConversation(), id: "conv-new" });
    expect(created.updated).toBe(true);
    expect(runtime.peek().conversations["conv-new"]).toBeDefined();

    await expect(
      records.updateConversation("conv-new", () => testConversation()),
    ).rejects.toThrow("cannot change the record id");
    expect(runtime.peek().conversations["conv-new"]?.id).toBe("conv-new");
  });
});

describe("invite redemption vs retention membership removal", () => {
  // Port of /tmp/review985-second-membership.ts: whichever side queues first
  // on the durable writer, the final roster must be [b, op] in canonical
  // state AND after a compacted SQLite replay — a stale whole-record write
  // can neither resurrect the deleted actor nor trip the member-row FK.
  for (const order of ["add-first", "delete-first"] as const) {
    test(`${order}: the roster converges on [b, op] in runtime and compacted replay`, async () => {
      const root = mkdtempSync(join(tmpdir(), `openscout-membership-${order}-`));
      tempRoots.add(root);
      const journalPath = join(root, "journal");
      const journal = new FileBackedBrokerJournal(journalPath, {
        compactionPolicy: { minimumReclaimBytes: 1, minimumReclaimRatio: 0 },
      });
      await journal.load();
      const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });
      const appended: BrokerJournalEntry[] = [];
      const durableStore = new BrokerDurableStore({
        journal: {
          async appendEntries(entries) {
            appended.push(...entries);
            return journal.appendEntries(entries);
          },
        },
        projection: { async applyEntries() { return []; } },
        threadEvents: { publish() {} },
      });
      const records = new BrokerDurableRecordStore({
        runtime,
        durableStore,
        knownInvocations: new Map(),
        memberConversationIds: () => ["nonmember"],
      });
      await records.upsertNode({
        ...testNode(), meshId: "mesh-1", advertiseScope: "local", registeredAt: 1,
      });
      for (const id of ["a", "op", "b"]) {
        await records.upsertActor({
          id, kind: id === "a" ? "agent" : "person",
          displayName: id, handle: id, createdAt: 1,
        });
      }
      const room: ConversationDefinition = {
        id: "room", kind: "channel", title: "c", visibility: "workspace",
        shareMode: "shared", authorityNodeId: "node-1", participantIds: ["a", "op"],
      };
      await records.upsertConversation(room);
      await records.upsertConversation({ ...room, id: "nonmember", participantIds: ["op"] });

      const service = new BrokerChannelInviteService({
        runtime,
        updateConversation: records.updateConversation,
      });
      const tokenHash = "a".repeat(64);
      await service.create({
        kind: "channel.invite.create", channelId: "room", inviteId: "i",
        tokenHash, tokenHint: "a", createdByActorId: "op", createdAt: 100,
        expiresAt: null, maxRedemptions: 1,
        route: {
          authorityNodeId: "node-1", host: "127.0.0.1",
          baseUrl: "http://127.0.0.1", reachability: "local_only",
        },
      });

      // Occupy the writer so the ordering below is the journal order.
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const lock = durableStore.runWrite(async () => {
        entered();
        await new Promise<void>((resolve) => { release = resolve; });
      });
      await started;
      const startAdd = () => service.redeem({
        kind: "channel.invite.redeem", channelId: "room", tokenHash,
        redemptionId: "red", redeemedAt: 101, request: { actorId: "b" },
      });
      let deletion: Promise<unknown>;
      let add: Promise<unknown>;
      if (order === "delete-first") {
        // The delete queues first; the redemption's roster read has already
        // happened against the stale [a, op] preimage.
        deletion = records.deleteActor("a");
        add = startAdd();
      } else {
        add = startAdd();
        await Promise.resolve();
        await Promise.resolve();
        deletion = records.deleteActor("a");
      }
      await Promise.resolve();
      await Promise.resolve();
      release();
      await Promise.all([lock, deletion, add]);

      expect(runtime.peek().conversations["room"]?.participantIds).toEqual(["b", "op"]);
      // No roster journaled after actor.delete may still list the removed
      // actor — the redemption rebuilt its write from the post-delete record.
      const deleteIndex = appended.findIndex((entry) => entry.kind === "actor.delete");
      expect(deleteIndex).toBeGreaterThan(-1);
      const staleUpserts = appended.slice(deleteIndex).filter((entry) =>
        entry.kind === "conversation.upsert" && entry.conversation.participantIds.includes("a"));
      expect(staleUpserts).toEqual([]);

      // Compacted replay onto a fresh store must agree — the stale roster
      // never reaches the journal, so no member row references 'a' after
      // actor.delete.
      const reloaded = new FileBackedBrokerJournal(journalPath, {
        compactionPolicy: { minimumReclaimBytes: 1, minimumReclaimRatio: 0 },
      });
      await reloaded.load();
      let store!: SQLiteControlPlaneStore;
      const projection = new RecoverableSQLiteProjection(join(root, "fresh.db"), reloaded, {
        createStore: (path) => {
          store = new SQLiteControlPlaneStore(path);
          return store;
        },
        conversationFeedPublishDelayMs: 0,
        conversationThreadPublishDelayMs: 0,
      });
      try {
        await projection.warm();
        await projection.flush();
        const members = (store.writerDb as ControlPlaneSqliteTransactionalDatabase)
          .query("SELECT actor_id FROM conversation_members WHERE conversation_id = 'room' ORDER BY actor_id")
          .all() as Array<{ actor_id: string }>;
        const actors = (store.writerDb as ControlPlaneSqliteTransactionalDatabase)
          .query("SELECT id FROM actors ORDER BY id")
          .all() as Array<{ id: string }>;
        expect(members.map((row) => row.actor_id)).toEqual(["b", "op"]);
        expect(actors.map((row) => row.id)).toEqual(["b", "op"]);
      } finally {
        projection.close();
      }
    });
  }
});

describe("stale whole-record roster fencing", () => {
  // Port of /tmp/review985-third-external-roster.ts: the external
  // /v1/conversations writers (scout-broker, web, desktop) compute a
  // replacement roster from a stale client snapshot and POST the whole
  // record. A roster written after retention deleted an actor must not
  // resurrect the membership — the durable writer drops retired actor ids
  // inside the serialized write, so the runtime AND the journaled record
  // (and its SQLite replay) all converge on the filtered roster.
  test("delete-first: a stale whole-record upsert cannot resurrect a retired actor", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-external-roster-"));
    tempRoots.add(root);
    const journalPath = join(root, "journal");
    const journal = new FileBackedBrokerJournal(journalPath, {
      compactionPolicy: { minimumReclaimBytes: 1, minimumReclaimRatio: 0 },
    });
    await journal.load();
    const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });
    const appended: BrokerJournalEntry[] = [];
    const durableStore = new BrokerDurableStore({
      journal: {
        async appendEntries(entries) {
          appended.push(...entries);
          return journal.appendEntries(entries);
        },
      },
      projection: { async applyEntries() { return []; } },
      threadEvents: { publish() {} },
    });
    const records = new BrokerDurableRecordStore({
      runtime,
      durableStore,
      knownInvocations: new Map(),
      memberConversationIds: () => [],
    });
    await records.upsertNode({
      ...testNode(), meshId: "mesh-1", advertiseScope: "local", registeredAt: 1,
    });
    for (const id of ["a", "op", "b"]) {
      await records.upsertActor({
        id, kind: id === "a" ? "agent" : "person",
        displayName: id, handle: id, createdAt: 1,
      });
    }
    const room: ConversationDefinition = {
      id: "room", kind: "channel", title: "c", visibility: "workspace",
      shareMode: "shared", authorityNodeId: "node-1", participantIds: ["a", "op"],
    };
    await records.upsertConversation(room);

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown, ...rest: unknown[]) => {
      warnings.push([message, ...rest].join(" "));
    };
    try {
      // Occupy the writer so the ordering below is the journal order: the
      // retention delete queues first, then the stale client upsert whose
      // roster was computed from the pre-delete snapshot ([a,b,op]).
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const lock = durableStore.runWrite(async () => {
        entered();
        await new Promise<void>((resolve) => { release = resolve; });
      });
      await started;
      const deletion = records.deleteActor("a");
      const staleUpsert = records.upsertConversation({ ...room, participantIds: ["a", "b", "op"] });
      await Promise.resolve();
      await Promise.resolve();
      release();
      await Promise.all([lock, deletion, staleUpsert]);
    } finally {
      console.warn = originalWarn;
    }

    expect(runtime.isRetiredActor("a")).toBe(true);
    // Canonical state AND the journaled record carry the filtered roster.
    expect(runtime.peek().conversations["room"]?.participantIds).toEqual(["b", "op"]);
    const deleteIndex = appended.findIndex((entry) => entry.kind === "actor.delete");
    expect(deleteIndex).toBeGreaterThan(-1);
    const postDeleteUpserts = appended.slice(deleteIndex).filter((entry) =>
      entry.kind === "conversation.upsert" && entry.conversation.id === "room");
    expect(postDeleteUpserts.map((entry) =>
      entry.kind === "conversation.upsert" ? entry.conversation.participantIds : []))
      .toEqual([["b", "op"]]);
    // One rate-limited warn line per filtered write.
    expect(warnings.filter((line) => line.includes("room") && line.includes("a")))
      .toHaveLength(1);

    // Compacted replay onto a fresh store must agree: the filtered roster was
    // journaled, so no member row references 'a' and nothing trips the FK.
    const reloaded = new FileBackedBrokerJournal(journalPath, {
      compactionPolicy: { minimumReclaimBytes: 1, minimumReclaimRatio: 0 },
    });
    await reloaded.load();
    // Tombstones survive compaction: a restart rebuilds the retired set.
    expect(reloaded.retiredActorIds().has("a")).toBe(true);
    let store!: SQLiteControlPlaneStore;
    const projection = new RecoverableSQLiteProjection(join(root, "fresh.db"), reloaded, {
      createStore: (path) => {
        store = new SQLiteControlPlaneStore(path);
        return store;
      },
      conversationFeedPublishDelayMs: 0,
      conversationThreadPublishDelayMs: 0,
    });
    try {
      await projection.warm();
      await projection.flush();
      const members = (store.writerDb as ControlPlaneSqliteTransactionalDatabase)
        .query("SELECT actor_id FROM conversation_members WHERE conversation_id = 'room' ORDER BY actor_id")
        .all() as Array<{ actor_id: string }>;
      const actors = (store.writerDb as ControlPlaneSqliteTransactionalDatabase)
        .query("SELECT id FROM actors ORDER BY id")
        .all() as Array<{ id: string }>;
      expect(members.map((row) => row.actor_id)).toEqual(["b", "op"]);
      expect(actors.map((row) => row.id)).toEqual(["b", "op"]);
    } finally {
      projection.close();
    }

    // Re-registration revives the identity: a fresh actor.upsert clears the
    // tombstone, so a later whole-record write keeps 'a'.
    await records.upsertActor({ id: "a", kind: "agent", displayName: "a", handle: "a", createdAt: 2 });
    expect(runtime.isRetiredActor("a")).toBe(false);
    await records.upsertConversation({ ...room, participantIds: ["a", "b", "op"] });
    expect(runtime.peek().conversations["room"]?.participantIds).toEqual(["a", "b", "op"]);
  });
});

describe("registry liveness is durable state, not event history", () => {
  test("identical/liveness upserts emit no events; substantive changes emit one per changed kind", async () => {
    const { runtime, records, durableStore } = createTestRecordStore();
    const node = { ...testNode(), meshId: "mesh-1", advertiseScope: "local" as const, registeredAt: 1,
      meshEntrypoints: [{ kind: "http" as const, url: "http://node.test", lastSeenAt: 1 }] };
    const agent = { ...testAgent(), metadata: { source: "test", lastSeenAt: 1 } };
    const actor = { id: "person", kind: "person" as const, displayName: "Person", metadata: { lastSeenAt: 1 } };
    const endpoint = testEndpoint({ metadata: { source: "scout-channel", startedAt: 1, lastSeenAt: 1 } });
    await records.upsertNode(node); await records.upsertActor(actor); await records.upsertAgent(agent); await records.upsertEndpoint(endpoint);
    const count = runtime.recentEvents().length;
    await records.upsertNode(node); await records.upsertActor(actor); await records.upsertAgent(agent); await records.upsertEndpoint(endpoint);
    await records.upsertNode({ ...node, lastSeenAt: 2, meshEntrypoints: [{ ...node.meshEntrypoints[0]!, lastSeenAt: 2 }] });
    await records.upsertActor({ ...actor, metadata: { lastSeenAt: 2 } });
    await records.upsertAgent({ ...agent, metadata: { source: "test", lastSeenAt: 2 } });
    await records.upsertEndpoint({ ...endpoint, metadata: { source: "scout-channel", startedAt: 2, lastSeenAt: 2 } });
    expect(runtime.recentEvents()).toHaveLength(count);
    for (const [mutate, kind] of [
      [() => records.upsertNode({ ...node, meshEntrypoints: [{ ...node.meshEntrypoints[0]!, url: "http://changed.test" }] }), "node.upserted"],
      [() => records.upsertActor({ ...actor, displayName: "Renamed" }), "actor.registered"],
      [() => records.upsertAgent({ ...agent, capabilities: ["new-capability"] }), "agent.registered"],
      [() => records.upsertEndpoint({ ...endpoint, state: "idle" }), "agent.endpoint.upserted"],
    ] as const) {
      const before = runtime.recentEvents().filter(e => e.kind === kind).length;
      await mutate();
      expect(runtime.recentEvents().filter(e => e.kind === kind)).toHaveLength(before + 1);
    }
    await durableStore.flushProjectedEntries();
  });

  test("a re-signed node card is liveness: memory follows it, the journal does not until the card is half spent", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-node-liveness-")); tempRoots.add(root);
    const journalPath = join(root, "journal");
    const journal = new FileBackedBrokerJournal(journalPath); await journal.load();
    const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });
    const durableStore = new BrokerDurableStore({ journal, projection: { async applyEntries() { return []; } }, threadEvents: { publish() {} } });
    const records = new BrokerDurableRecordStore({ runtime, durableStore, knownInvocations: new Map(),
      journaledNode: (id) => journal.journaledNode(id) });
    const ttl = 86_400_000;
    const card = (issuedAt: number, n: number) => ({ nodeId: "peer", label: "peer", publicKey: "key", keyId: "key-id", fingerprint: "fp",
      version: "test", capabilities: [], endpoints: [], issuedAt, expiresAt: issuedAt + ttl, nonce: `n${n}`, signature: `s${n}` });
    const node = (seenAt: number, n: number, brokerUrl = "http://peer.test") => ({ ...testNode(), id: "peer", meshId: "mesh-1",
      advertiseScope: "local" as const, registeredAt: 1, brokerUrl, lastSeenAt: seenAt, card: card(seenAt, n) });
    const lines = async () => (await Bun.file(journalPath).text()).split("\n").filter(line => line.includes("\"node.upsert\"")).length;

    // The runtime can hold a node the journal has never seen (its own, at
    // startup). The first durable write must reach the journal regardless.
    await runtime.upsertNode(node(500, 0));
    await records.upsertNode(node(1_000, 1));
    expect(await lines()).toBe(1);
    // A probe every minute for an hour re-signs the card each time.
    for (let minute = 1; minute <= 60; minute++) await records.upsertNode(node(1_000 + minute * 60_000, minute + 1));
    expect(await lines()).toBe(1);
    expect(runtime.peek().nodes.peer?.lastSeenAt).toBe(1_000 + 60 * 60_000);
    // Half the journaled card's lifetime later, the journal takes one renewal.
    await records.upsertNode(node(1_000 + ttl / 2, 100));
    expect(await lines()).toBe(2);
    // A real change is written at once.
    await records.upsertNode(node(1_000 + ttl / 2 + 60_000, 101, "http://moved.test"));
    expect(await lines()).toBe(3);
    const reloaded = new FileBackedBrokerJournal(journalPath); await reloaded.load();
    const restored = reloaded.snapshot().nodes.peer as ReturnType<typeof node> | undefined;
    expect(restored?.brokerUrl).toBe("http://moved.test");
    expect(restored!.card.expiresAt).toBeGreaterThan(1_000 + ttl);
  });

  test("restart and fresh SQLite projection retain latest liveness without heartbeat events", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-liveness-replay-")); tempRoots.add(root);
    const journalPath = join(root, "journal");
    const journal = new FileBackedBrokerJournal(journalPath); await journal.load();
    const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });
    const durableStore = new BrokerDurableStore({ journal, projection: { async applyEntries() { return []; } }, threadEvents: { publish() {} } });
    const records = new BrokerDurableRecordStore({ runtime, durableStore, knownInvocations: new Map() });
    const node = { ...testNode(), meshId: "mesh-1", advertiseScope: "local" as const, registeredAt: 1,
      card: { nodeId: "node-1", label: "test", publicKey: "key", keyId: "key-id", fingerprint: "fp", version: "test", capabilities: [], endpoints: [], issuedAt: 1, expiresAt: 1001, nonce: "n1", signature: "s1" } };
    const agent = { ...testAgent(), metadata: { source: "test", lastSeenAt: 1 } };
    const endpoint = testEndpoint({ metadata: { source: "test", lastSeenAt: 1, lastFailedAt: 1, lastError: "offline" } });
    await records.upsertNode(node); await records.upsertAgent(agent); await records.upsertEndpoint(endpoint);
    const initialEvents = runtime.recentEvents().length;
    await records.upsertNode({ ...node, lastSeenAt: 900, card: { ...node.card, issuedAt: 900, expiresAt: 1900, nonce: "n2", signature: "s2" } });
    await records.upsertAgent({ ...agent, metadata: { source: "test", lastSeenAt: 900 } });
    await records.upsertEndpoint({ ...endpoint, metadata: { source: "test", lastSeenAt: 900, lastFailedAt: 900, lastError: "offline" } });
    expect(runtime.recentEvents()).toHaveLength(initialEvents);
    const reloaded = new FileBackedBrokerJournal(journalPath); await reloaded.load();
    const canonical = runtime.snapshot();
    for (const key of ["nodes", "actors", "agents", "endpoints"] as const) {
      expect(JSON.parse(JSON.stringify(reloaded.snapshot()[key]))).toEqual(JSON.parse(JSON.stringify(canonical[key])));
    }
    let sqlite!: SQLiteControlPlaneStore;
    const projection = new RecoverableSQLiteProjection(join(root, "replayed.sqlite"), reloaded, {
      createStore(path) { sqlite = new SQLiteControlPlaneStore(path); return sqlite; },
    });
    try {
      await projection.warm(); await projection.flush();
      const snapshot = sqlite.loadSnapshot();
      expect(snapshot.nodes["node-1"]?.lastSeenAt).toBe(900);
      expect((reloaded.snapshot().nodes["node-1"] as typeof node)?.card?.signature).toBe("s2");
      expect(snapshot.endpoints["endpoint-1"]?.metadata?.lastFailedAt).toBe(900);
      expect(snapshot.actors["agent-1"]?.metadata?.lastSeenAt).toBe(900);
      expect(snapshot.agents["agent-1"]?.metadata?.lastSeenAt).toBe(900);
      expect(snapshot.endpoints["endpoint-1"]?.metadata?.lastSeenAt).toBe(900);
      expect(sqlite.writerDb.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
    } finally { projection.close(); }
  });
});
