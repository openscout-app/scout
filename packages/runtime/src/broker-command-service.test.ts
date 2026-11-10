import { describe, expect, test } from "bun:test";

import {
  type ActorIdentity,
  type CollaborationEvent,
  type CollaborationRecord,
  type DeliveryIntent,
  type InvocationRequest,
  type MessageRecord,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";
import { BrokerCommandService, type BrokerCommandMesh } from "./broker-command-service.js";

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

function workItem(input: Partial<CollaborationRecord> = {}): CollaborationRecord {
  return {
    id: "work-1",
    kind: "work_item",
    state: "working",
    acceptanceState: "none",
    title: "Investigate dispatch",
    createdById: "operator",
    ownerId: "agent-1",
    nextMoveOwnerId: "agent-1",
    requestedById: "operator",
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

function message(input: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: "msg-1",
    conversationId: "conversation-1",
    actorId: "operator",
    originNodeId: "node-local",
    class: "agent",
    body: "hello",
    visibility: "workspace",
    policy: "durable",
    createdAt: 100,
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
    reason: "direct_message",
    policy: "durable",
    status: "pending",
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
    createdAt: 100,
    ...input,
  };
}

function createHarness(input: {
  authorityConversationIds?: Set<string>;
  collaborationRecords?: Record<string, CollaborationRecord>;
  mesh?: Partial<BrokerCommandMesh>;
} = {}) {
  const collaborationRecords = input.collaborationRecords ?? {};
  const upsertedActors: ActorIdentity[] = [];
  const recordedCollaborations: Array<{
    record: CollaborationRecord;
    options?: { enqueueProjection?: boolean };
  }> = [];
  const appendedEvents: Array<{
    event: CollaborationEvent;
    options?: { enqueueProjection?: boolean };
  }> = [];
  const recordedMessages: Array<{
    message: MessageRecord;
    options?: { enqueueProjection?: boolean };
  }> = [];
  const appliedEntries: BrokerJournalEntry[][] = [];
  const peerMessageForwards: Array<{ message: MessageRecord; deliveries: DeliveryIntent[] }> = [];
  const acceptedInvocations: Array<{ invocation: InvocationRequest; options: { includeOk: true; logAccepted: true } }> = [];
  const runtimeCommands: string[] = [];
  const logs: string[] = [];
  let reconcileCount = 0;

  const mesh: BrokerCommandMesh = {
    authorityNodeForConversation: (conversationId) =>
      input.authorityConversationIds?.has(conversationId) ? { id: "node-peer" } : null,
    async forwardCollaborationRecordToAuthority() {
      return { forwarded: true, authorityNodeId: "node-peer" };
    },
    async forwardPeerBrokerCollaborationRecord() {
      return { forwarded: ["node-peer"], failed: [] };
    },
    async forwardCollaborationEventToAuthority() {
      return { forwarded: true, authorityNodeId: "node-peer" };
    },
    async forwardPeerBrokerCollaborationEvent() {
      return { forwarded: ["node-peer"], failed: [] };
    },
    async forwardConversationMessageToAuthority() {
      return { forwarded: true, authorityNodeId: "node-peer" };
    },
    async forwardPeerBrokerDeliveries(nextMessage, deliveries) {
      peerMessageForwards.push({ message: nextMessage, deliveries });
      return { forwarded: ["node-peer"], failed: [] };
    },
    ...input.mesh,
  };

  const service = new BrokerCommandService({
    runtime: {
      collaborationRecord: (recordId) => collaborationRecords[recordId],
      async dispatch(command) {
        runtimeCommands.push(command.kind);
      },
    },
    mesh,
    upsertNode: async () => {},
    async upsertActor(nextActor) {
      upsertedActors.push(nextActor);
    },
    upsertAgent: async () => {},
    persistEndpoint: async () => {},
    upsertConversation: async () => {},
    upsertBinding: async () => {},
    async recordCollaboration(record, options) {
      recordedCollaborations.push({ record, options });
      return [{ kind: "collaboration.record", record }];
    },
    async appendCollaborationEvent(event, options) {
      appendedEvents.push({ event, options });
      return [{ kind: "collaboration.event.record", event }];
    },
    async recordMessage(nextMessage, options) {
      recordedMessages.push({ message: nextMessage, options });
      return {
        deliveries: [delivery({ messageId: nextMessage.id })],
        entries: [{ kind: "message.record", message: nextMessage }],
      };
    },
    async applyProjectedEntries(entries) {
      appliedEntries.push(entries);
    },
    async reconcileStaleLocalDeliveries() {
      reconcileCount += 1;
    },
    async acceptAndDispatchInvocation(nextInvocation, options) {
      acceptedInvocations.push({ invocation: nextInvocation, options });
      return {
        ok: true,
        accepted: true,
        invocationId: nextInvocation.id,
      };
    },
    log: (line) => logs.push(line),
  });

  return {
    acceptedInvocations,
    appendedEvents,
    appliedEntries,
    logs,
    peerMessageForwards,
    reconcileCount: () => reconcileCount,
    recordedCollaborations,
    recordedMessages,
    runtimeCommands,
    service,
    upsertedActors,
  };
}

describe("BrokerCommandService", () => {
  test("delegates simple upsert commands", async () => {
    const harness = createHarness();
    const nextActor = actor();

    await expect(harness.service.execute({
      kind: "actor.upsert",
      actor: nextActor,
    })).resolves.toEqual({ ok: true });

    expect(harness.upsertedActors).toEqual([nextActor]);
  });

  test("records local collaboration records and forwards unscoped records to peers", async () => {
    const harness = createHarness();
    const record = workItem({ conversationId: undefined });

    await expect(harness.service.execute({
      kind: "collaboration.upsert",
      record,
    })).resolves.toEqual({
      ok: true,
      recordId: record.id,
      mesh: { forwarded: ["node-peer"], failed: [] },
    });

    expect(harness.recordedCollaborations).toEqual([
      { record, options: { enqueueProjection: false, reconcile: expect.any(Function) } },
    ]);
    expect(harness.appliedEntries).toEqual([
      [expect.objectContaining({ kind: "collaboration.record" })],
    ]);
  });

  test("forwards authority-owned collaboration records without local writes", async () => {
    const harness = createHarness({
      authorityConversationIds: new Set(["conversation-remote"]),
    });
    const record = workItem({ conversationId: "conversation-remote" });

    await expect(harness.service.execute({
      kind: "collaboration.upsert",
      record,
    })).resolves.toEqual({
      ok: true,
      recordId: record.id,
      mesh: { forwarded: true, authorityNodeId: "node-peer" },
    });

    expect(harness.recordedCollaborations).toEqual([]);
    expect(harness.appliedEntries).toEqual([]);
  });

  test("appends collaboration events using their record authority", async () => {
    const record = workItem({ conversationId: "conversation-local" });
    const event = collaborationEvent({ recordId: record.id });
    const harness = createHarness({
      collaborationRecords: { [record.id]: record },
    });

    await expect(harness.service.execute({
      kind: "collaboration.event.append",
      event,
    })).resolves.toEqual({
      ok: true,
      eventId: event.id,
      mesh: { forwarded: [], failed: [] },
    });

    expect(harness.appendedEvents).toEqual([
      { event, options: { enqueueProjection: false } },
    ]);
  });

  test("records local conversation posts, fans deliveries, projects entries, and reconciles", async () => {
    const harness = createHarness();
    const nextMessage = message();

    await expect(harness.service.execute({
      kind: "conversation.post",
      message: nextMessage,
    })).resolves.toEqual({
      ok: true,
      message: nextMessage,
      deliveries: [expect.objectContaining({ id: "delivery-1", messageId: "msg-1" })],
      mesh: { forwarded: ["node-peer"], failed: [] },
    });

    expect(harness.recordedMessages).toEqual([
      { message: nextMessage, options: { enqueueProjection: false } },
    ]);
    expect(harness.peerMessageForwards).toEqual([
      {
        message: nextMessage,
        deliveries: [expect.objectContaining({ id: "delivery-1" })],
      },
    ]);
    expect(harness.reconcileCount()).toBe(1);
    expect(harness.logs).toEqual([
      "[openscout-runtime] message msg-1 posted by operator to conversation-1 with 1 deliveries",
    ]);
  });

  test("delegates agent invocation commands with command response options", async () => {
    const harness = createHarness();
    const nextInvocation = invocation();

    await expect(harness.service.execute({
      kind: "agent.invoke",
      invocation: nextInvocation,
    })).resolves.toEqual({
      ok: true,
      accepted: true,
      invocationId: nextInvocation.id,
    });

    expect(harness.acceptedInvocations).toEqual([
      {
        invocation: nextInvocation,
        options: { includeOk: true, logAccepted: true },
      },
    ]);
  });
});
