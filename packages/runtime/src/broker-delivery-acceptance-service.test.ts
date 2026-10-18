import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerRequestReceipts } from "./broker-request-receipts.js";
import { BrokerCommandAdmission } from "./broker-storage-pressure.js";
import { messageWithAcceptedFlight } from "./broker-delivery-receipt-recovery.js";

import {
  buildScoutReturnAddress,
  SCOUT_RUNTIME_CATALOG,
  type AgentDefinition,
  type AgentEndpoint,
  type ConversationDefinition,
  type FlightRecord,
  type InvocationRequest,
  type MessageRecord,
  type ScoutDeliverRequest,
  type ScoutDispatchEnvelope,
  type ScoutDispatchRecord,
  type ScoutOwnedRuntimeCatalog,
} from "@openscout/protocol";

import { recoverSessionInputDelivery } from "./broker-session-input-delivery.js";
import type { SessionInputDeliveryOptions } from "./broker-session-input-delivery.js";
import { BrokerDeliveryAcceptanceService } from "./broker-delivery-acceptance-service.js";
import type { InvocationResolution } from "./broker-delivery-routing.js";
import type { RuntimeSnapshot } from "./scout-dispatcher.js";

function testAgent(input: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "agent-1",
    kind: "agent",
    definitionId: "agent-1",
    displayName: "Agent One",
    handle: "agent-one",
    labels: ["agent"],
    metadata: {},
    selector: "@agent-one",
    defaultSelector: "@agent-one",
    agentClass: "general",
    capabilities: ["chat", "invoke", "deliver"],
    wakePolicy: "on_demand",
    homeNodeId: "node-1",
    authorityNodeId: "node-1",
    advertiseScope: "local",
    ...input,
  };
}

function testEndpoint(input: Partial<AgentEndpoint> = {}): AgentEndpoint {
  return {
    id: "endpoint-1",
    agentId: "agent-1",
    nodeId: "node-1",
    harness: "codex",
    transport: "tmux",
    state: "idle",
    sessionId: "session-1",
    metadata: {},
    ...input,
  };
}

function testConversation(input: Partial<ConversationDefinition> = {}): ConversationDefinition {
  return {
    id: "conversation-1",
    kind: "direct",
    title: "Agent One",
    visibility: "workspace",
    shareMode: "local",
    authorityNodeId: "node-1",
    participantIds: ["operator", "agent-1"],
    metadata: {},
    ...input,
  };
}

function testMessage(input: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: "message-1",
    conversationId: "conversation-1",
    actorId: "operator",
    originNodeId: "node-1",
    class: "agent",
    body: "please investigate",
    audience: { notify: ["agent-1"], reason: "direct_message" },
    visibility: "workspace",
    policy: "durable",
    createdAt: 20_000,
    metadata: {},
    ...input,
  };
}

function testSnapshot(input: {
  agents?: Record<string, AgentDefinition>;
  endpoints?: Record<string, AgentEndpoint>;
  conversations?: Record<string, ConversationDefinition>;
  messages?: Record<string, MessageRecord>;
} = {}): RuntimeSnapshot {
  return {
    nodes: {},
    actors: {},
    agents: input.agents ?? {},
    endpoints: input.endpoints ?? {},
    conversations: input.conversations ?? {},
    bindings: {},
    messages: input.messages ?? {},
    readCursors: {},
    invocations: {},
    flights: {},
    collaborationRecords: {},
  };
}

function createHarness(input: {
  resolution?: InvocationResolution;
  conversation?: ConversationDefinition;
  conversationForRequest?: (
    request: { requesterId: string; targetAgentId?: string; channel?: string },
  ) => ConversationDefinition;
  snapshot?: RuntimeSnapshot;
  isOperatorTarget?: (payload: ScoutDeliverRequest) => boolean;
  isScoutTarget?: (payload: ScoutDeliverRequest) => boolean;
  cardlessEndpointHarness?: AgentEndpoint["harness"];
  runtimeCatalog?: ScoutOwnedRuntimeCatalog;
  now?: number;
  requestReceipts?: BrokerRequestReceipts;
  commandAdmission?: BrokerCommandAdmission;
  readAcceptedInvocation?: (id: string) => Promise<InvocationRequest | undefined>;
  duringCommit?: () => void;
  submitSessionInput?: SessionInputDeliveryOptions["submitSessionInput"];
  readAcceptedMessage?: (id: string) => Promise<MessageRecord | undefined>;
  onPostedMessage?: (message: MessageRecord) => Promise<void>;
} = {}) {
  const agent = testAgent();
  const endpoint = testEndpoint();
  const conversation = input.conversation ?? testConversation();
  const snapshot = input.snapshot ?? testSnapshot({
    agents: { [agent.id]: agent },
    endpoints: { [endpoint.id]: endpoint },
    conversations: { [conversation.id]: conversation },
  });
  const ensuredActors: string[] = [];
  const conversationsRequested: Array<{ requesterId: string; targetAgentId?: string; channel?: string }> = [];
  const postedMessages: MessageRecord[] = [];
  const acceptedInvocations: InvocationRequest[] = [];
  const dispatchedInvocations: InvocationRequest[] = [];
  const cardlessProjectSessionCalls: Array<{
    projectPath: string;
    execution?: InvocationRequest["execution"];
    projectAgent?: ScoutDeliverRequest["projectAgent"];
    requesterId: string;
    createdAt: number;
  }> = [];
  const recordedDispatches: Array<{ envelope: ScoutDispatchEnvelope; requesterId?: string }> = [];
  const recordedWorkItemPayloads: ScoutDeliverRequest[] = [];
  const operatorIssues: Array<{
    kind: "unassigned_scout" | "rejected" | "unavailable";
    requestId: string;
    requesterId: string;
    requesterNodeId: string;
    targetLabel: string;
    detail: string;
  }> = [];
  const operatorSignals: Array<{
    signal: NonNullable<ScoutDeliverRequest["operatorSignal"]>;
    messageId: string;
    conversationId: string;
    requesterId: string;
    requesterNodeId: string;
  }> = [];
  const operatorNeeds: MessageRecord[] = [];
  const localAgentSyncReasons: string[] = [];
  let idCounter = 0;

  const service = new BrokerDeliveryAcceptanceService({
    requestReceipts: input.requestReceipts,
    submitSessionInput: input.submitSessionInput,
    upsertSessionInputActor: async actor => { snapshot.actors[actor.id] = actor; },
    readAcceptedMessage: input.readAcceptedMessage,
    commandAdmission: input.commandAdmission,
    readAcceptedInvocation: input.readAcceptedInvocation,
    nodeId: "node-1",
    operatorActorId: "operator",
    runtimeSnapshot: () => snapshot,
    ...(input.runtimeCatalog
      ? { readRuntimeCatalog: async () => ({ catalog: input.runtimeCatalog! }) }
      : {}),
    createId: (prefix) => `${prefix}-${++idCounter}`,
    syncRegisteredLocalAgentsIfChanged: async (reason) => {
      localAgentSyncReasons.push(reason);
    },
    metadataStringValue: (metadata, key) => {
      const value = metadata?.[key];
      return typeof value === "string" && value.trim() ? value.trim() : null;
    },
    messageRefCandidateForRouteTarget: () => null,
    resolveBrokerMessageRef: () => null,
    async ensureBrokerActorForDelivery(actorId) {
      ensuredActors.push(actorId);
    },
    async ensureBrokerDeliveryConversation(request) {
      conversationsRequested.push(request);
      return input.conversationForRequest?.(request) ?? conversation;
    },
    brokerRouteKind: (conversationInput) => conversationInput.kind === "direct" ? "dm" : "channel",
    messageVisibilityForConversation: (conversationInput) => conversationInput?.visibility ?? "workspace",
    brokerActorDisplayName: (_snapshot, actorId) => actorId === agent.id ? agent.displayName : actorId,
    brokerTargetLabel: (agentInput) => agentInput.selector ?? agentInput.handle ?? agentInput.id,
    homeEndpointForAgent: (snapshotInput, agentId) =>
      Object.values(snapshotInput.endpoints).find((candidate) => candidate.agentId === agentId) ?? null,
    titleCaseName: (value) => value.slice(0, 1).toUpperCase() + value.slice(1),
    buildBrokerReturnAddressForActor: (_snapshot, actorId, options) => buildScoutReturnAddress({
      actorId,
      handle: actorId,
      conversationId: options?.conversationId,
      replyToMessageId: options?.replyToMessageId,
      sessionId: options?.sessionId,
    }),
    isOperatorDeliveryTarget: input.isOperatorTarget ?? (() => false),
    isLocalScoutProductTarget: input.isScoutTarget ?? (() => false),
    onlineConversationNotifyTargets: () => ["agent-1"],
    resolveBrokerDeliveryTargetWithImplicitProjectAgent: async () =>
      input.resolution ?? { kind: "resolved", agent },
    async createCardlessProjectSession(request) {
      cardlessProjectSessionCalls.push(request);
      const cardlessEndpoint = testEndpoint({
        id: "endpoint-cardless",
        agentId: "cardless-agent",
        sessionId: "session-cardless",
        harness: input.cardlessEndpointHarness ?? "codex",
      });
      return {
        kind: "resolved_session",
        session: {
          sessionId: "session-cardless",
          actorId: "cardless-agent",
          endpoint: cardlessEndpoint,
          label: "Cardless Session",
          nodeId: "node-1",
        },
      };
    },
    async recordScoutDispatch(envelope, options) {
      recordedDispatches.push({ envelope, requesterId: options?.requesterId });
      const record: ScoutDispatchRecord = {
        id: `dispatch-${recordedDispatches.length}`,
        requesterId: options?.requesterId,
        ...envelope,
      };
      return { record };
    },
    describeUnavailableDeliveryTarget: () => null,
    buildUnavailableDispatchEnvelope: () => {
      throw new Error("unexpected unavailable dispatch");
    },
    recordDeliveryWorkItemIfNeeded: async ({ payload }) => {
      recordedWorkItemPayloads.push(payload);
      return { record: null };
    },
    deliveryWorkItemResolutionForTell: () => ({ record: null }),
    async postConversationMessage(message) {
      postedMessages.push(message);
      await input.onPostedMessage?.(message);
      return { ok: true };
    },
    async acceptInvocation(invocation, message) {
      input.duringCommit?.();
      if (message) postedMessages.push(message);
      acceptedInvocations.push(invocation);
      const flight: FlightRecord = {
        id: "flight-1",
        invocationId: invocation.id,
        requesterId: invocation.requesterId,
        targetAgentId: invocation.targetAgentId,
        state: "waking",
        startedAt: input.now ?? 10_000,
      };
      return flight;
    },
    async dispatchAcceptedInvocation(invocation) {
      dispatchedInvocations.push(invocation);
    },
    queueOperatorDeliveryIssue: (issue) => operatorIssues.push(issue),
    recordOperatorNeed: async message => { operatorNeeds.push(message); },
    queueOperatorSignal: (signal) => operatorSignals.push(signal),
    now: () => input.now ?? 10_000,
  });

  return {
    acceptedInvocations,
    cardlessProjectSessionCalls,
    conversationsRequested,
    dispatchedInvocations,
    ensuredActors,
    localAgentSyncReasons,
    operatorIssues,
    operatorSignals,
    operatorNeeds,
    postedMessages,
    recordedDispatches,
    recordedWorkItemPayloads,
    service,
  };
}

describe("broker session input receipts", () => {
  const payload: ScoutDeliverRequest = { requestId: "mobile-reply-1", requesterId: "operator", requesterNodeId: "node-1",
    intent: "consult", body: "continue with this", sessionDelivery: "in_place_or_resume",
    target: { kind: "session_id", sessionId: "native-1", harness: "claude" }, execution: { session: "existing" } };

  test("reserves before input, coalesces concurrent retries and replays after restart without a flight", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scout-session-input-"));
    try {
      const ledger = new BrokerRequestReceipts(directory);
      let submits = 0;
      const harness = createHarness({ requestReceipts: ledger, submitSessionInput: async input => {
        submits++;
        expect((await ledger.get("operator", payload.requestId!, "deliver"))?.state).toBe("unknown");
        expect(input).toEqual({ sessionId: "native-1", harness: "claude", body: payload.body });
        return { ok: true, via: "tmux", location: "%3" };
      } });
      const responses = await Promise.all([harness.service.accept(payload), harness.service.accept(payload)]);
      expect(submits).toBe(1);
      expect(responses[0]).toEqual(responses[1]);
      expect(responses[0]).toMatchObject({ kind: "delivery", targetAgentId: "flat-claude-native-1", receipt: {
        inputSubmitted: { kind: "in_place", state: "submitted", sessionId: "native-1", harness: "claude", via: "tmux", location: "%3" },
      } });
      expect("flight" in responses[0]!).toBe(false);
      expect(harness.acceptedInvocations).toHaveLength(0);
      expect(harness.dispatchedInvocations).toHaveLength(0);
      expect(harness.postedMessages).toHaveLength(1);
      expect(harness.postedMessages[0]?.audience).toEqual({ delivery: "none" });
      const restarted = createHarness({ requestReceipts: new BrokerRequestReceipts(directory), now: 99_000,
        submitSessionInput: async () => { throw new Error("must not resubmit"); } });
      expect(await restarted.service.accept(payload)).toEqual(responses[0]);
      for (const changed of [{ ...payload, body: "different" }, { ...payload, target: { kind: "session_id" as const, sessionId: "native-2", harness: "claude" as const } }]) {
        await expect(restarted.service.accept(changed)).rejects.toThrow("different content");
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("only explicit not_live continues normal exact-session acceptance within the same receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scout-session-resume-"));
    try {
      let submits = 0;
      const harness = createHarness({ requestReceipts: new BrokerRequestReceipts(directory), submitSessionInput: async () => {
        submits++; return { ok: false, code: "not_live" };
      } });
      const response = await harness.service.accept(payload);
      expect(response.kind).toBe("delivery");
      expect(harness.acceptedInvocations).toHaveLength(1);
      expect(await harness.service.accept(payload)).toEqual(response);
      expect(submits).toBe(1);
      expect(harness.acceptedInvocations).toHaveLength(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("a definite live refusal is replayable and never resumes or submits a second time", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scout-session-refusal-"));
    try {
      let submits = 0;
      const harness = createHarness({ requestReceipts: new BrokerRequestReceipts(directory), submitSessionInput: async () => {
        submits++; return { ok: false, code: "session_blocked", via: "herdr", location: "pane1" };
      } });
      const result = await harness.service.accept(payload);
      expect(result).toMatchObject({ kind: "rejected", rejection: { sessionWakeReason: "session_blocked" } });
      expect(await harness.service.accept(payload)).toEqual(result);
      expect(submits).toBe(1);
      expect(harness.acceptedInvocations).toHaveLength(0);
      expect(harness.postedMessages).toHaveLength(0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("ambiguous input, unexpected throws, and failure before canonical commit remain unknown across restart", async () => {
    for (const failure of ["uncertain", "throw", "commit"] as const) {
      const directory = await mkdtemp(join(tmpdir(), "scout-session-unknown-"));
      try {
        let submits = 0;
        const harness = createHarness({ requestReceipts: new BrokerRequestReceipts(directory), submitSessionInput: async () => {
          submits++;
          if (failure === "throw") throw new Error("socket closed after input");
          if (failure === "uncertain") return { ok: false, code: "in_place_failed", via: "scout-app", location: "Codex", detail: "confirmation timed out" };
          return { ok: true, via: "tmux", location: "%3" };
        }, onPostedMessage: async () => { throw new Error("commit interrupted"); } });
        await expect(harness.service.accept(payload)).rejects.toThrow();
        expect(harness.acceptedInvocations).toHaveLength(0);
        const restarted = createHarness({ requestReceipts: new BrokerRequestReceipts(directory), submitSessionInput: async () => {
          submits++; return { ok: false, code: "not_live" };
        } });
        await expect(restarted.service.accept(payload)).rejects.toThrow("request_outcome_unknown");
        expect(submits).toBe(1);
        expect(restarted.acceptedInvocations).toHaveLength(0);
        expect((await new BrokerRequestReceipts(directory).get("operator", payload.requestId!, "deliver"))?.state).toBe("unknown");
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
  });

  test("canonical submission witness recovers an unknown ledger and rejects mismatched provenance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scout-session-witness-"));
    try {
      let committed: MessageRecord | undefined;
      const harness = createHarness({ requestReceipts: new BrokerRequestReceipts(directory), submitSessionInput: async () => ({ ok: true, via: "herdr", location: "pane1" }),
        onPostedMessage: async message => { committed = message; throw new Error("lost commit acknowledgement"); } });
      await expect(harness.service.accept(payload)).rejects.toThrow("lost commit acknowledgement");
      const restarted = createHarness({ requestReceipts: new BrokerRequestReceipts(directory), readAcceptedMessage: async () => committed,
        submitSessionInput: async () => { throw new Error("must not resubmit"); } });
      const response = await restarted.service.accept(payload);
      expect(response).toMatchObject({ receipt: { inputSubmitted: { state: "submitted" } } });
      expect("flight" in response).toBe(false);
      expect(recoverSessionInputDelivery(committed, "different-requester", payload.requestId!)).toBeNull();
      expect(recoverSessionInputDelivery(committed, "operator", "different-request")).toBeNull();
      expect(recoverSessionInputDelivery({ ...committed!, originNodeId: "wrong-node" }, "operator", payload.requestId!)).toBeNull();
      expect(recoverSessionInputDelivery({ ...committed!, conversationId: "wrong-conversation" }, "operator", payload.requestId!)).toBeNull();
      const wrongSession = structuredClone(committed!);
      (wrongSession.metadata!.scoutSessionInputAcceptance as any).response.receipt.inputSubmitted.sessionId = "wrong-session";
      expect(recoverSessionInputDelivery(wrongSession, "operator", payload.requestId!)).toBeNull();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("rejects missing keys and unsupported semantics before input or ledger reservation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scout-session-validation-"));
    try {
      let submits = 0;
      const ledger = new BrokerRequestReceipts(directory);
      const harness = createHarness({ requestReceipts: ledger, submitSessionInput: async () => { submits++; return { ok: false, code: "not_live" }; } });
      for (const change of [{ requestId: undefined }, { body: " " }, { intent: "tell" }, { attachments: [{ id: "a", mediaType: "text/plain", url: "file:///a" }] },
        { workItem: { title: "work" } }, { execution: { session: "fork" } }, { execution: { model: "x" } },
        { target: { kind: "session_id", sessionId: "native-1" } }, { target: { kind: "session_id", sessionId: "native-1", harness: "claude", host: "remote" } }]) {
        await expect(harness.service.accept({ ...payload, ...change } as ScoutDeliverRequest)).rejects.toThrow();
      }
      expect(submits).toBe(0);
      expect(await ledger.get("operator", payload.requestId!, "deliver")).toBeNull();
      await expect(createHarness({ submitSessionInput: async () => ({ ok: false, code: "not_live" }) }).service.accept(payload)).rejects.toThrow("session_input_unsupported");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("reuses the unique local native session actor and refuses ambiguous identities before input", async () => {
    for (const ambiguous of [false, true]) {
      const directory = await mkdtemp(join(tmpdir(), "scout-session-actor-"));
      try {
        let submits = 0;
        const snapshot = testSnapshot({ endpoints: {
          one: testEndpoint({ sessionId: "broker-session", metadata: { nativeSessionId: "native-1" }, harness: "claude" }),
          remote: testEndpoint({ agentId: "remote", nodeId: "node-2", sessionId: "native-1", harness: "claude" }),
          ...(ambiguous ? { two: testEndpoint({ agentId: "other", sessionId: "native-1", harness: "claude" }) } : {}),
        } });
        const harness = createHarness({ snapshot, requestReceipts: new BrokerRequestReceipts(directory), submitSessionInput: async () => { submits++; return { ok: true, via: "tmux", location: "%3" }; } });
        const response = await harness.service.accept(payload);
        expect(submits).toBe(ambiguous ? 0 : 1);
        expect(response).toMatchObject(ambiguous ? { kind: "rejected", rejection: { sessionWakeReason: "session_ambiguous" } } : { targetAgentId: "agent-1" });
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
  });
});

describe("BrokerDeliveryAcceptanceService", () => {
  test("unknown sidecar recovers a reused message through historical invocation after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scout-reused-receipt-recovery-"));
    try {
      const oldMessage = testMessage({ id: "old-message", metadata: { clientMessageId: "stable-client" } });
      const snapshot = testSnapshot({ messages: { [oldMessage.id]: oldMessage }, conversations: { "conversation-1": testConversation() } });
      const initial = createHarness({ snapshot });
      const payload: ScoutDeliverRequest = { requestId: "request-after-legacy-message", body: oldMessage.body,
        intent: "consult", targetAgentId: "agent-1", caller: { actorId: "operator", nodeId: "node-1" },
        messageMetadata: { clientMessageId: "stable-client" } };
      const accepted = await initial.service.accept(payload);
      if (accepted.kind !== "delivery" || !accepted.flight) throw new Error("expected accepted flight");
      const canonicalInvocation = { ...initial.acceptedInvocations[0]!, metadata: {
        acceptedDeliveryReceipt: messageWithAcceptedFlight(initial.postedMessages[0]!, accepted.flight),
      } };
      const ledger = new BrokerRequestReceipts(directory);
      await expect(ledger.run("operator", payload.requestId!, "deliver", payload, async () => {
        throw new Error("crash after canonical commit before receipt save");
      })).rejects.toThrow("crash after canonical commit");
      const readIds: string[] = [];
      const restarted = createHarness({ requestReceipts: new BrokerRequestReceipts(directory),
        readAcceptedInvocation: async id => { readIds.push(id); return id === canonicalInvocation.id ? canonicalInvocation : undefined; } });
      const recovered = await restarted.service.accept(payload);
      expect(recovered).toEqual(accepted);
      expect(readIds).toEqual([canonicalInvocation.id]);
      expect(restarted.acceptedInvocations).toEqual([]);
      expect(restarted.dispatchedInvocations).toEqual([]);
      expect((await ledger.get("operator", payload.requestId!, "deliver"))?.state).toBe("done");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("outer alias receipt admission rejects before reservation and releases exactly once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scout-outer-command-receipts-"));
    try {
      const ledger = new BrokerRequestReceipts(directory);
      const admission = new BrokerCommandAdmission({ maxCommands: 1 });
      const harness = createHarness({ requestReceipts: ledger, commandAdmission: admission });
      const payload: ScoutDeliverRequest = { requestId: "outer-alias-request", body: "work", intent: "consult",
        targetAgentId: "agent-1", caller: { actorId: "operator", nodeId: "node-1" } };
      const run = () => ledger.run("operator", payload.requestId!, "deliver", payload,
        () => harness.service.accept(payload, { receiptReserved: true, admissionReserved: true }),
        () => harness.service.recoverReceipt("operator", payload.requestId!), () => harness.service.reserveCommand(payload));
      const hold = admission.reserve({ existing: "command" });
      await expect(run()).rejects.toThrow("admission paused");
      expect(await ledger.get("operator", payload.requestId!, "deliver")).toBeNull();
      hold();
      expect((await run()).accepted).toBe(true);
      expect(harness.acceptedInvocations).toHaveLength(1);
      expect(admission.status().pendingCommands).toBe(0);
      expect((await run()).accepted).toBe(true);
      expect(harness.acceptedInvocations).toHaveLength(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("caller abort after the atomic commit starts cannot strand an accepted ask", async () => {
    const abort = new AbortController();
    const harness = createHarness({ duringCommit: () => abort.abort() });
    const result = await harness.service.accept({
      body: "keep the accepted work", intent: "consult", targetAgentId: "agent-1",
      caller: { actorId: "operator", nodeId: "node-1" },
    }, { signal: abort.signal });
    expect(result.accepted).toBe(true);
    expect(harness.postedMessages).toHaveLength(1);
    expect(harness.acceptedInvocations).toHaveLength(1);
    expect(harness.dispatchedInvocations).toHaveLength(1);
  });

  test("direct command retries share one durable receipt across service restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scout-command-receipts-"));
    try {
      const request: ScoutDeliverRequest = {
        requestId: "stable-command", body: "preserve my context", intent: "consult", targetAgentId: "agent-1",
        caller: { actorId: "operator", nodeId: "node-1" },
      };
      const first = createHarness({ requestReceipts: new BrokerRequestReceipts(directory) });
      const [accepted, concurrent] = await Promise.all([first.service.accept(request), first.service.accept({ ...request })]);
      expect(concurrent).toEqual(accepted);
      expect(first.acceptedInvocations).toHaveLength(1);
      const reopened = createHarness({ requestReceipts: new BrokerRequestReceipts(directory) });
      expect(await reopened.service.accept(request)).toEqual(accepted);
      expect(reopened.acceptedInvocations).toHaveLength(0);
      await expect(reopened.service.accept({ ...request, body: "different work" })).rejects.toThrow("different content");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("marks an unassigned product-Scout request as reply-required and origin-correlated", async () => {
    const harness = createHarness({
      isScoutTarget: () => true,
    });

    const result = await harness.service.accept({
      id: "deliver-scout",
      body: "Create the work item",
      intent: "consult",
      targetAgentId: "scout.dispatcher",
      caller: {
        actorId: "remote-agent",
        nodeId: "remote-node",
      },
    });

    expect(result).toEqual(expect.objectContaining({
      kind: "rejected",
      accepted: false,
      reason: "unknown_target",
    }));
    expect(harness.postedMessages[0]).toEqual(expect.objectContaining({
      metadata: expect.objectContaining({
        requestId: "deliver-scout",
        replyExpectation: "required",
        routingState: "failed",
      }),
    }));
    expect(harness.operatorIssues).toEqual([
      expect.objectContaining({
        kind: "unassigned_scout",
        originConversationId: harness.postedMessages[0]!.conversationId,
        originMessageId: harness.postedMessages[0]!.id,
      }),
    ]);
    expect(harness.acceptedInvocations).toEqual([]);
    expect(harness.recordedDispatches).toEqual([
      expect.objectContaining({
        envelope: expect.objectContaining({
          kind: "unknown",
          askedLabel: "scout.dispatcher",
        }),
      }),
    ]);
  });

  test("accepts an unassigned product-Scout tell without marking it failed", async () => {
    const harness = createHarness({
      isScoutTarget: () => true,
    });

    const result = await harness.service.accept({
      id: "deliver-scout-tell",
      body: "local broker status",
      intent: "tell",
      targetAgentId: "scout.dispatcher",
      caller: {
        actorId: "remote-agent",
        nodeId: "remote-node",
      },
    });

    // Fire-and-forget: nobody is blocked on a reply, so the message is simply
    // durable in the Scout thread until an operator session reads it.
    expect(result).toEqual(expect.objectContaining({
      kind: "delivery",
      accepted: true,
    }));
    expect(harness.postedMessages).toHaveLength(1);
    expect(harness.postedMessages[0]!.metadata).toEqual(expect.objectContaining({
      requestId: "deliver-scout-tell",
    }));
    expect(harness.postedMessages[0]!.metadata).not.toHaveProperty("replyExpectation");
    expect(harness.postedMessages[0]!.metadata).not.toHaveProperty("routingState");
    expect(harness.postedMessages[0]!.metadata).not.toHaveProperty("dispatchId");
    // No dispatch record and no in-thread failure mirror for an accepted send.
    expect(harness.recordedDispatches).toEqual([]);
    expect(harness.operatorIssues).toEqual([
      expect.objectContaining({ kind: "unassigned_scout" }),
    ]);
    expect(harness.operatorIssues[0]).not.toHaveProperty("originConversationId");
    expect(harness.acceptedInvocations).toEqual([]);
    expect(harness.localAgentSyncReasons).toEqual([]);
  });

  test("records an operator signal without creating an invocation", async () => {
    const conversation = testConversation({
      id: "dm.agent.operator",
      participantIds: ["agent-1", "operator"],
    });
    const harness = createHarness({
      conversation,
      isOperatorTarget: () => true,
      now: 11_000,
    });

    const result = await harness.service.accept({
      id: "deliver-signal",
      body: "I found the root cause and am continuing with the fix.",
      intent: "tell",
      targetLabel: "@operator",
      caller: { actorId: "agent-1", nodeId: "node-1" },
      operatorSignal: {
        kind: "notify",
        blocking: false,
        replyExpectation: "none",
      },
    });

    expect(result.kind).toBe("delivery");
    expect(result.accepted).toBe(true);
    expect(harness.acceptedInvocations).toEqual([]);
    expect(harness.dispatchedInvocations).toEqual([]);
    expect(harness.postedMessages[0]).toEqual(expect.objectContaining({
      id: "msg-1",
      conversationId: "dm.agent.operator",
      actorId: "agent-1",
      body: "I found the root cause and am continuing with the fix.",
      metadata: expect.objectContaining({
        operatorSignal: {
          kind: "notify",
          blocking: false,
          replyExpectation: "none",
        },
        operatorSignalId: "msg-1",
      }),
    }));
    expect(harness.operatorSignals).toEqual([{
      signal: {
        kind: "notify",
        blocking: false,
        replyExpectation: "none",
      },
      messageId: "msg-1",
      conversationId: "dm.agent.operator",
      requesterId: "agent-1",
      requesterNodeId: "node-1",
      body: "I found the root cause and am continuing with the fix.",
      requesterName: "agent-one",
      createdAt: 11000,
    }]);
  });

  test("rejects malformed or lifecycle-bearing operator signals before writing", async () => {
    const harness = createHarness({ isOperatorTarget: () => true });
    const base = {
      body: "Optional input requested.",
      intent: "tell" as const,
      targetLabel: "@operator",
      caller: { actorId: "agent-1", nodeId: "node-1" },
    };

    await expect(harness.service.accept({
      ...base,
      operatorSignal: {
        kind: "consult",
        blocking: false,
        replyExpectation: "optional",
        defaultAction: " ",
      },
    })).rejects.toThrow();

    await expect(harness.service.accept({
      ...base,
      ensureAwake: false,
      operatorSignal: {
        kind: "notify",
        blocking: false,
        replyExpectation: "none",
      },
    })).rejects.toThrow("cannot carry work or invocation lifecycle fields");

    expect(harness.postedMessages).toEqual([]);
    expect(harness.operatorSignals).toEqual([]);
  });

  test("routes channel tells without creating an invocation", async () => {
    const conversation = testConversation({
      id: "channel.shared",
      kind: "channel",
      title: "Shared",
      participantIds: ["operator", "agent-1"],
    });
    const harness = createHarness({ conversation, now: 12_000 });

    const result = await harness.service.accept({
      id: "deliver-1",
      body: "hello channel",
      intent: "tell",
      target: { kind: "channel", channel: "shared" },
      caller: { actorId: "operator", nodeId: "node-1" },
    });

    expect(result.kind).toBe("delivery");
    expect(result.accepted).toBe(true);
    expect(result.routeKind).toBe("channel");
    expect(harness.acceptedInvocations).toEqual([]);
    expect(harness.dispatchedInvocations).toEqual([]);
    expect(harness.postedMessages).toHaveLength(1);
    expect(harness.postedMessages[0]).toEqual(expect.objectContaining({
      id: "msg-1",
      conversationId: "channel.shared",
      body: "hello channel",
      audience: expect.objectContaining({
        notify: ["agent-1"],
        reason: "conversation_visibility",
      }),
      metadata: expect.objectContaining({
        relayChannel: "shared",
        relayMessageId: "msg-1",
      }),
    }));
  });

  test("resolved consult posts a message and dispatches an invocation", async () => {
    const harness = createHarness({ now: 20_000 });

    const result = await harness.service.accept({
      id: "deliver-2",
      body: "please investigate",
      intent: "consult",
      targetAgentId: "agent-1",
      caller: { actorId: "operator", nodeId: "node-1" },
      messageMetadata: { source: "test" },
      labels: ["urgent", "urgent"],
    });

    expect(result.kind).toBe("delivery");
    expect(result.accepted).toBe(true);
    expect(result.receipt).toEqual(expect.objectContaining({
      requestId: "deliver-2",
      targetAgentId: "agent-1",
      targetLabel: "@agent-one",
      conversationId: "conversation-1",
      messageId: "msg-1",
      flightId: "flight-1",
    }));
    expect(harness.postedMessages[0]).toEqual(expect.objectContaining({
      id: "msg-1",
      actorId: "operator",
      body: "please investigate",
      mentions: [{ actorId: "agent-1", label: "@agent-one" }],
      metadata: expect.objectContaining({
        labels: ["urgent"],
        relayTarget: "agent-1",
        relayMessageId: "msg-1",
      }),
    }));
    expect(harness.acceptedInvocations).toHaveLength(1);
    expect(harness.acceptedInvocations[0]).toEqual(expect.objectContaining({
      id: "inv-2",
      action: "consult",
      targetAgentId: "agent-1",
      task: "please investigate",
      conversationId: "conversation-1",
      messageId: "msg-1",
      metadata: expect.objectContaining({
        source: "test",
        labels: ["urgent"],
        relayTarget: "agent-1",
      }),
    }));
    expect(harness.dispatchedInvocations).toEqual(harness.acceptedInvocations);
  });

  test("replays a committed delivery by stable client and request ids without a second write", async () => {
    const message = testMessage({
      metadata: {
        clientMessageId: "ios-stable-1",
        deliveryRequestId: "deliver-client-stable-1",
        relayTarget: "agent-1",
      },
    });
    const harness = createHarness({
      snapshot: testSnapshot({
        agents: { "agent-1": testAgent() },
        endpoints: { "endpoint-1": testEndpoint() },
        conversations: { "conversation-1": testConversation() },
        messages: { [message.id]: message },
      }),
    });

    const result = await harness.service.accept({
      id: "deliver-client-stable-1",
      body: "please investigate",
      intent: "consult",
      targetAgentId: "agent-1",
      caller: { actorId: "operator", nodeId: "node-1" },
      messageMetadata: { clientMessageId: "ios-stable-1" },
    });

    expect(result).toEqual(expect.objectContaining({
      kind: "delivery",
      accepted: true,
      message: expect.objectContaining({ id: message.id }),
      receipt: expect.objectContaining({
        requestId: "deliver-client-stable-1",
        messageId: message.id,
      }),
    }));
    expect(harness.postedMessages).toEqual([]);
    expect(harness.acceptedInvocations).toEqual([]);
    expect(harness.dispatchedInvocations).toEqual([]);
  });

  test("promotes a recoverable durable message instead of creating a duplicate bubble", async () => {
    const message = testMessage({
      id: "message-recoverable",
      metadata: { clientMessageId: "ios-recoverable-1" },
    });
    const harness = createHarness({
      snapshot: testSnapshot({
        agents: { "agent-1": testAgent() },
        endpoints: { "endpoint-1": testEndpoint() },
        conversations: { "conversation-1": testConversation() },
        messages: { [message.id]: message },
      }),
    });

    const result = await harness.service.accept({
      id: "deliver-client-recoverable-1",
      body: "please investigate",
      intent: "consult",
      targetAgentId: "agent-1",
      caller: { actorId: "operator", nodeId: "node-1" },
      messageMetadata: { clientMessageId: "ios-recoverable-1" },
    });

    expect(result).toEqual(expect.objectContaining({
      kind: "delivery",
      accepted: true,
      message: expect.objectContaining({ id: message.id }),
    }));
    expect(harness.postedMessages).toHaveLength(1);
    expect(harness.postedMessages[0]).toEqual(expect.objectContaining({
      id: message.id,
      metadata: expect.objectContaining({
        clientMessageId: "ios-recoverable-1",
        deliveryRequestId: "deliver-client-recoverable-1",
      }),
    }));
    expect(harness.acceptedInvocations).toHaveLength(1);
    expect(harness.acceptedInvocations[0]?.messageId).toBe(message.id);
  });

  test("resolved target handles continue the resolved session", async () => {
    const sessionEndpoint = testEndpoint({
      id: "endpoint-session",
      agentId: "session-agent",
      sessionId: "session-mw-talkie",
    });
    const harness = createHarness({
      now: 20_250,
      resolution: {
        kind: "resolved_session",
        session: {
          sessionId: "session-mw-talkie",
          actorId: "session-agent",
          endpoint: sessionEndpoint,
          label: "target:mw-talkie",
          nodeId: "node-1",
        },
      },
    });

    const result = await harness.service.accept({
      id: "deliver-target-handle",
      body: "continue the editorial pass",
      intent: "consult",
      target: { kind: "target_handle", handle: "mw-talkie", value: "target:mw-talkie" },
      caller: { actorId: "operator", nodeId: "node-1" },
    });

    expect(result.kind).toBe("delivery");
    expect(result).toEqual(expect.objectContaining({
      targetAgentId: "session-agent",
      targetSessionId: "session-mw-talkie",
    }));
    expect(harness.postedMessages[0]?.metadata).toEqual(expect.objectContaining({
      targetSessionId: "session-mw-talkie",
    }));
    expect(harness.acceptedInvocations[0]).toEqual(expect.objectContaining({
      targetAgentId: "session-agent",
      execution: expect.objectContaining({
        session: "existing",
        targetSessionId: "session-mw-talkie",
      }),
      metadata: expect.objectContaining({
        targetSessionId: "session-mw-talkie",
      }),
    }));
  });

  test("a live exact session continued as a fork targets the fork everywhere downstream", async () => {
    const forkEndpoint = testEndpoint({
      id: "endpoint-fork",
      agentId: "flat-claude-fork-id",
      sessionId: "flat-claude-fork-id",
    });
    const harness = createHarness({
      now: 20_300,
      resolution: {
        kind: "resolved_session",
        session: {
          sessionId: "flat-claude-fork-id",
          actorId: "flat-claude-fork-id",
          endpoint: forkEndpoint,
          label: "session:claude:fork-id",
          nodeId: "node-1",
        },
        sessionFork: { sourceSessionId: "source-id", sessionId: "fork-id" },
      },
    });

    const result = await harness.service.accept({
      id: "deliver-fork",
      body: "reply from the phone",
      intent: "consult",
      target: { kind: "session_id", sessionId: "source-id", harness: "claude", forkIfLive: true },
      caller: { actorId: "operator", nodeId: "node-1" },
    });

    expect(result).toEqual(expect.objectContaining({ kind: "delivery", targetSessionId: "fork-id" }));
    expect(harness.acceptedInvocations[0]?.execution).toEqual(expect.objectContaining({
      session: "existing",
      targetSessionId: "fork-id",
    }));
  });

  test("accepts and queues delivery to an offline session endpoint instead of refusing", async () => {
    // SCO-098: a resolved session whose endpoint is offline (non-terminal) is
    // the store-and-forward case — record the message and dispatch so the
    // invocation path wakes the session or parks the flight, instead of
    // returning "nothing was sent."
    const sessionEndpoint = testEndpoint({
      id: "endpoint-session-offline",
      agentId: "session-agent",
      sessionId: "session-mw-offline",
      transport: "codex_app_server",
      state: "offline",
      metadata: { sessionBacked: true },
    });
    const harness = createHarness({
      now: 20_260,
      resolution: {
        kind: "resolved_session",
        session: {
          sessionId: "session-mw-offline",
          actorId: "session-agent",
          endpoint: sessionEndpoint,
          label: "target:mw-offline",
          nodeId: "node-1",
        },
      },
    });

    const result = await harness.service.accept({
      id: "deliver-offline-session",
      body: "check in when you can",
      intent: "consult",
      target: { kind: "target_handle", handle: "mw-offline", value: "target:mw-offline" },
      caller: { actorId: "operator", nodeId: "node-1" },
    });

    expect(result.kind).toBe("delivery");
    expect(harness.postedMessages).toHaveLength(1);
    expect(harness.acceptedInvocations[0]).toEqual(expect.objectContaining({
      targetAgentId: "session-agent",
      execution: expect.objectContaining({
        session: "existing",
        targetSessionId: "session-mw-offline",
      }),
    }));
  });

  test("project-path consult with an explicit agent target does not synthesize a cardless session", async () => {
    const harness = createHarness({ now: 20_500 });

    const result = await harness.service.accept({
      id: "deliver-project-agent",
      body: "start from this project context",
      intent: "consult",
      target: { kind: "project_path", projectPath: "/tmp/openscout" },
      targetAgentId: "agent-1",
      caller: { actorId: "operator", nodeId: "node-1" },
      execution: { session: "new", harness: "codex" },
    });

    expect(result.kind).toBe("delivery");
    expect(harness.cardlessProjectSessionCalls).toEqual([]);
    expect(harness.acceptedInvocations).toHaveLength(1);
    expect(harness.acceptedInvocations[0]).toEqual(expect.objectContaining({
      targetAgentId: "agent-1",
      execution: { session: "new", harness: "codex" },
      task: "start from this project context",
    }));
  });

  test("runtime-profile consult starts a cardless current-project session with broker-owned execution", async () => {
    const harness = createHarness({
      now: 20_750,
      cardlessEndpointHarness: "claude",
    });

    const result = await harness.service.accept({
      id: "deliver-profile-opus",
      body: "review the parser",
      intent: "consult",
      target: {
        kind: "runtime_profile",
        profile: "opus",
        projectPath: "/tmp/openscout",
        reasoningEffort: "high",
      },
      caller: { actorId: "operator", nodeId: "node-1" },
    });

    expect(result.kind).toBe("delivery");
    expect(harness.cardlessProjectSessionCalls).toEqual([{
      projectPath: "/tmp/openscout",
      execution: {
        harness: "claude",
        model: "claude-opus-5-5",
        reasoningEffort: "high",
        session: "new",
      },
      projectAgent: undefined,
      requesterId: "operator",
      createdAt: 20_750,
    }]);
    expect(harness.acceptedInvocations[0]?.execution).toEqual({
      harness: "claude",
      model: "claude-opus-5-5",
      reasoningEffort: "high",
      session: "existing",
      targetSessionId: "session-cardless",
    });
    expect(harness.acceptedInvocations[0]?.executionResolution).toEqual(expect.objectContaining({
      schemaVersion: "openscout.execution-resolution.v1",
      harness: expect.objectContaining({ resolved: "claude", source: "profile", drift: "unknown" }),
      model: expect.objectContaining({ resolved: "claude-opus-5-5", source: "profile", drift: "unknown" }),
      reasoningEffort: expect.objectContaining({ resolved: "high", source: "profile", drift: "unknown" }),
    }));
  });

  test("normalizes exact models, preserves literal provenance, and rejects unsupported dimensions", async () => {
    const harness = createHarness({ now: 20_800 });
    const result = await harness.service.accept({
      id: "deliver-exact-runtime",
      body: "review",
      intent: "consult",
      targetAgentId: "agent-1",
      caller: { actorId: "operator", nodeId: "node-1" },
      execution: { harness: "codex", model: "5.6", reasoningEffort: "xhigh" },
      executionSource: { harness: "literal", model: "literal", reasoningEffort: "literal" },
    });
    expect(harness.acceptedInvocations[0]?.execution).toEqual(expect.objectContaining({
      harness: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
    }));
    expect(harness.acceptedInvocations[0]?.executionResolution?.model).toEqual(expect.objectContaining({
      requested: "5.6",
      resolved: "gpt-5.6-sol",
      source: "literal",
    }));
    expect(result.kind === "delivery" ? result.receipt.executionResolution?.model : undefined)
      .toEqual(expect.objectContaining({
        requested: "5.6",
        resolved: "gpt-5.6-sol",
        source: "literal",
      }));

    await expect(harness.service.accept({
      id: "deliver-unsupported-model",
      body: "review",
      intent: "consult",
      targetAgentId: "agent-1",
      caller: { actorId: "operator", nodeId: "node-1" },
      execution: { harness: "kimi", model: "some-model" },
    })).rejects.toThrow("unsupported_model_dimension");
  });

  test("invalid runtime profiles fail closed before cardless session creation", async () => {
    const harness = createHarness({
      now: 20_875,
      resolution: {
        kind: "unknown",
        label: "profile:composer-review",
        detail: 'unknown runtime profile "composer-review"',
      },
    });

    const result = await harness.service.accept({
      id: "deliver-profile-unknown",
      body: "review the parser",
      intent: "consult",
      target: {
        kind: "runtime_profile",
        profile: "composer-review",
        projectPath: "/tmp/openscout",
      },
      caller: { actorId: "operator", nodeId: "node-1" },
    });

    expect(result.kind).toBe("rejected");
    expect(harness.cardlessProjectSessionCalls).toEqual([]);
    expect(harness.acceptedInvocations).toEqual([]);
  });

  test("runtime profiles with unsupported effort fail closed before cardless session creation", async () => {
    for (const profile of ["kimi", "grok"]) {
      const harness = createHarness({
        now: 20_900,
        resolution: {
          kind: "unparseable",
          label: `profile:${profile}`,
        },
      });

      const result = await harness.service.accept({
        id: `deliver-profile-${profile}-effort`,
        body: "review the parser",
        intent: "consult",
        target: {
          kind: "runtime_profile",
          profile,
          projectPath: "/tmp/openscout",
          reasoningEffort: "high",
        },
        caller: { actorId: "operator", nodeId: "node-1" },
      });

      expect(result.kind).toBe("rejected");
      expect(harness.cardlessProjectSessionCalls).toEqual([]);
      expect(harness.acceptedInvocations).toEqual([]);
    }
  });

  test("preserves requested fork execution when accepting a consult", async () => {
    const harness = createHarness({ now: 21_000 });

    const result = await harness.service.accept({
      id: "deliver-fork",
      body: "continue from the prior run",
      intent: "consult",
      targetAgentId: "agent-1",
      caller: { actorId: "operator", nodeId: "node-1" },
      execution: {
        harness: "codex",
        model: "gpt-5.5",
        reasoningEffort: "high",
        session: "fork",
        forkFromSessionId: "session-source-1",
      },
    });

    expect(result.kind).toBe("delivery");
    expect(harness.acceptedInvocations).toHaveLength(1);
    expect(harness.acceptedInvocations[0]?.execution).toEqual({
      harness: "codex",
      model: "gpt-5.5",
      reasoningEffort: "high",
      session: "fork",
      forkFromSessionId: "session-source-1",
    });
  });

  test("channel consult posts a canonical channel message and broker pointer DM", async () => {
    const channelConversation = testConversation({
      id: "channel.xterm-super-component",
      kind: "channel",
      title: "xterm-super-component",
      visibility: "workspace",
      participantIds: ["operator", "agent-1"],
    });
    const directConversation = testConversation({
      id: "dm.operator.agent-1",
      kind: "direct",
      title: "Agent One",
      visibility: "private",
      participantIds: ["operator", "agent-1"],
    });
    const harness = createHarness({
      conversation: channelConversation,
      conversationForRequest: (request) => request.channel ? channelConversation : directConversation,
      now: 40_000,
    });

    const result = await harness.service.accept({
      id: "deliver-channel-1",
      body: "@agent-one please take pass 2",
      intent: "consult",
      targetAgentId: "agent-1",
      channel: "xterm-super-component",
      caller: { actorId: "operator", nodeId: "node-1" },
      messageMetadata: { source: "test" },
      invocationMetadata: { source: "test" },
    });

    expect(result.kind).toBe("delivery");
    expect(result.accepted).toBe(true);
    expect(result.conversation.id).toBe("channel.xterm-super-component");
    expect(harness.conversationsRequested).toEqual([
      { requesterId: "operator", targetAgentId: "agent-1", channel: "xterm-super-component" },
      { requesterId: "operator", targetAgentId: "agent-1" },
    ]);
    expect(harness.postedMessages).toHaveLength(2);

    const [canonical, pointer] = harness.postedMessages;
    expect(canonical).toEqual(expect.objectContaining({
      id: "msg-1",
      conversationId: "channel.xterm-super-component",
      body: "@agent-one please take pass 2",
      audience: expect.objectContaining({
        notify: ["agent-1"],
        reason: "mention",
      }),
      metadata: expect.objectContaining({
        relayChannel: "xterm-super-component",
        relayTarget: "agent-1",
        relayMessageId: "msg-1",
        returnAddress: expect.objectContaining({
          conversationId: "channel.xterm-super-component",
          replyToMessageId: "msg-1",
        }),
      }),
    }));

    expect(pointer).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^msg-/),
      conversationId: "dm.operator.agent-1",
      actorId: "operator",
      class: "status",
      mentions: [{ actorId: "agent-1", label: "@agent-one" }],
      audience: {
        notify: ["agent-1"],
        reason: "direct_message",
      },
      metadata: expect.objectContaining({
        source: "broker-channel-attention",
        brokerGenerated: true,
        attentionKind: "channel_pointer",
        relayChannel: "dm",
        relayTarget: "agent-1",
        relayTargetIds: ["agent-1"],
        relayMessageId: pointer!.id,
        channelPointer: expect.objectContaining({
          channel: "xterm-super-component",
          conversationId: "channel.xterm-super-component",
          messageId: "msg-1",
          intent: "consult",
          targetAgentId: "agent-1",
        }),
        returnAddress: expect.objectContaining({
          conversationId: "channel.xterm-super-component",
          replyToMessageId: "msg-1",
        }),
      }),
    }));
    expect(pointer!.body).toContain("Reply in #xterm-super-component.");
    expect(pointer!.body).not.toContain("please take pass 2");

    expect(harness.acceptedInvocations).toHaveLength(1);
    expect(harness.acceptedInvocations[0]).toEqual(expect.objectContaining({
      conversationId: "channel.xterm-super-component",
      messageId: "msg-1",
      task: "@agent-one please take pass 2",
      metadata: expect.objectContaining({
        relayChannel: "xterm-super-component",
        relayTarget: "agent-1",
        returnAddress: expect.objectContaining({
          conversationId: "channel.xterm-super-component",
          replyToMessageId: "msg-1",
        }),
      }),
    }));
  });

  test("unresolved targets record a dispatch and operator issue", async () => {
    const harness = createHarness({
      resolution: { kind: "unknown", label: "@missing" },
      now: 30_000,
    });

    const result = await harness.service.accept({
      id: "deliver-3",
      body: "hello?",
      intent: "consult",
      targetLabel: "@missing",
      caller: { actorId: "remote-agent", nodeId: "node-remote" },
    });

    expect(result).toEqual(expect.objectContaining({
      kind: "rejected",
      accepted: false,
      reason: "unknown_target",
      rejection: expect.objectContaining({
        id: "dispatch-1",
        kind: "unknown",
        askedLabel: "@missing",
        requesterId: "remote-agent",
      }),
    }));
    expect(harness.recordedDispatches).toEqual([
      expect.objectContaining({
        envelope: expect.objectContaining({
          kind: "unknown",
          askedLabel: "@missing",
        }),
        requesterId: "remote-agent",
      }),
    ]);
    expect(harness.operatorIssues).toEqual([
      expect.objectContaining({
        kind: "rejected",
        requestId: "deliver-3",
        requesterId: "remote-agent",
        requesterNodeId: "node-remote",
        targetLabel: "@missing",
      }),
    ]);
    expect(harness.postedMessages).toEqual([]);
    expect(harness.acceptedInvocations).toEqual([]);
  });

  test("pins alias proof and exact-session semantics across receipt, message, and invocation", async () => {
    const agent = testAgent();
    const endpoint = testEndpoint();
    const aliasResolution = {
      bindingId: "alias-1",
      revision: 4,
      requestedAlias: "patch",
      scope: { projectKey: "project:alpha", projectRoot: "/work/alpha", nodeId: "node-1" },
      target: {
        kind: "session" as const,
        sessionId: "session-1",
        agentId: agent.id,
        endpointId: endpoint.id,
        nodeId: endpoint.nodeId,
        harness: endpoint.harness,
      },
      resolvedAt: 40_000,
    };
    const harness = createHarness({
      resolution: { kind: "resolved", agent, aliasResolution },
      now: 40_000,
    });

    const result = await harness.service.accept({
      id: "deliver-alias",
      body: "continue exactly here",
      intent: "consult",
      target: { kind: "route_alias", alias: "patch" },
      caller: { actorId: "operator", nodeId: "node-1", currentDirectory: "/work/alpha" },
      workItem: { title: "Continue patch" },
    });

    expect(result).toEqual(expect.objectContaining({
      kind: "delivery",
      accepted: true,
      targetAgentId: agent.id,
      targetSessionId: "session-1",
      aliasResolution,
      receipt: expect.objectContaining({
        targetAgentId: agent.id,
        targetSessionId: "session-1",
        aliasResolution,
      }),
    }));
    expect(harness.postedMessages[0]?.metadata).toEqual(expect.objectContaining({ aliasResolution }));
    expect(harness.acceptedInvocations[0]).toEqual(expect.objectContaining({
      targetAgentId: agent.id,
      execution: expect.objectContaining({ session: "existing", targetSessionId: "session-1" }),
      metadata: expect.objectContaining({ aliasResolution }),
    }));
    expect(harness.recordedWorkItemPayloads[0]?.workItem?.metadata).toEqual(
      expect.objectContaining({ aliasResolution }),
    );
  });

  test("model selectability follows the live runtime catalog, not the bundled default", async () => {
    // Two catalogs that disagree with the bundled data: one grants kimi a
    // model, the other strips every model from claude. Which one the service
    // reads decides the verdict — no harness name is special-cased in code.
    const base = {
      schemaVersion: "openscout.runtime-catalog.v1" as const,
      revision: "2026-09-20.9",
    };
    const kimiWithModel: ScoutOwnedRuntimeCatalog = {
      ...base,
      harnesses: [
        { id: "claude", label: "Claude", enabled: true, default: true, reasoningEfforts: null, models: [] },
        { id: "kimi", label: "Kimi", enabled: true, reasoningEfforts: null, models: [
          { id: "kimi-live-1", label: "Kimi Live", enabled: true },
        ] },
      ],
    };

    const permissive = createHarness({ runtimeCatalog: kimiWithModel });
    const accepted = await permissive.service.accept({
      id: "deliver-live-kimi",
      body: "review",
      intent: "consult",
      targetAgentId: "agent-1",
      caller: { actorId: "operator", nodeId: "node-1" },
      execution: { harness: "kimi", model: "kimi-live-1" },
    });
    expect(accepted.kind).toBe("delivery");

    await expect(permissive.service.accept({
      id: "deliver-live-claude",
      body: "review",
      intent: "consult",
      targetAgentId: "agent-1",
      caller: { actorId: "operator", nodeId: "node-1" },
      execution: { harness: "claude", model: "claude-opus-5" },
    })).rejects.toThrow("unsupported_model_dimension");
  });
});


test("delivery accepts remote-only models and effort metadata and rejects a disabled fresh choice", async () => {
  const catalog = structuredClone(SCOUT_RUNTIME_CATALOG);
  const codex = catalog.harnesses.find((harness) => harness.id === "codex")!;
  codex.models = codex.models.map((model) => ({ ...model, enabled: false, default: false }));
  codex.models.push({ id: "gpt-published-next", label: "Published Next", enabled: true, default: true, reasoningEfforts: ["max", "ultra"] });
  const harness = createHarness({ runtimeCatalog: catalog });
  const base = { body: "review", intent: "consult" as const, targetAgentId: "agent-1", caller: { actorId: "operator", nodeId: "node-1" } };
  const accepted = await harness.service.accept({ ...base, id: "future-model", execution: { harness: "codex", model: "gpt-published-next", reasoningEffort: "ultra", session: "new" } });
  expect(accepted.kind).toBe("delivery");
  expect(harness.acceptedInvocations[0]?.execution).toMatchObject({ model: "gpt-published-next", reasoningEffort: "ultra" });
  await expect(harness.service.accept({ ...base, id: "disabled-model", execution: { harness: "codex", model: "gpt-6-astra", session: "new" } })).rejects.toThrow("disabled_model");
  expect(harness.acceptedInvocations).toHaveLength(1);
});

test("delivery resolves family aliases using live catalog data", async () => {
  const catalog = structuredClone(SCOUT_RUNTIME_CATALOG);
  const claude = catalog.harnesses.find((harness) => harness.id === "claude")!;
  claude.models = [{ id: "claude-opus-future", label: "Future Opus", family: "Opus", enabled: true, default: true }];
  const harness = createHarness({ runtimeCatalog: catalog });
  await harness.service.accept({ id: "live-opus", body: "review", intent: "consult", targetAgentId: "agent-1",
    caller: { actorId: "operator", nodeId: "node-1" }, execution: { harness: "claude", model: "opus" } });
  expect(harness.acceptedInvocations[0]?.execution?.model).toBe("claude-opus-future");
});

test("exact-session delivery retains its disabled published runtime as continuation context", async () => {
  const catalog = structuredClone(SCOUT_RUNTIME_CATALOG);
  const codex = catalog.harnesses.find((entry) => entry.id === "codex")!;
  codex.models = codex.models.map((entry) => ({ ...entry, enabled: entry.id !== "gpt-6-astra", default: false }));
  const endpoint = testEndpoint({ id: "retained-endpoint", agentId: "retained-agent", sessionId: "retained-session" });
  const harness = createHarness({ runtimeCatalog: catalog, resolution: { kind: "resolved_session", session: {
    sessionId: "retained-session", actorId: "retained-agent", endpoint, label: "Retained task", nodeId: "node-1",
  } } });
  const result = await harness.service.accept({ id: "retained-model", body: "continue", intent: "consult",
    target: { kind: "session_id", sessionId: "retained-session" },
    caller: { actorId: "operator", nodeId: "node-1" }, execution: { harness: "codex", model: "gpt-6-astra", reasoningEffort: "high" } });
  expect(result.kind).toBe("delivery");
  expect(harness.acceptedInvocations[0]?.execution).toMatchObject({ model: "gpt-6-astra", reasoningEffort: "high", session: "existing", targetSessionId: "retained-session" });
});

test("operator permission is durably recorded before its push is queued", async () => {
  const harness = createHarness({ isOperatorTarget: () => true });
  await harness.service.accept({ id: "deliver-permission", body: "May I run the deploy?", intent: "tell", targetLabel: "@operator",
    caller: { actorId: "agent-1", nodeId: "node-1" }, operatorSignal: { kind: "need", blocking: true, replyExpectation: "required", question: "May I run the deploy?", requestKind: "permission" } });
  expect(harness.operatorNeeds).toHaveLength(1);
  expect(harness.operatorNeeds[0]?.metadata?.operatorSignal).toMatchObject({ requestKind: "permission" });
  expect(harness.operatorSignals).toHaveLength(1);
});

describe("explicit completion local rollout", () => {
  const payload: ScoutDeliverRequest = { requestId: "explicit-1", requesterId: "operator", requesterNodeId: "node-1", intent: "consult", body: "inspect",
    target: { kind: "agent_id", agentId: "agent-1" }, completion: { mode: "explicit" } };
  test("passes typed local ask and accepted flight identity to execution", async () => {
    const h = createHarness(); await h.service.accept(payload);
    expect(h.acceptedInvocations[0]).toMatchObject({ targetNodeId: "node-1", metadata: { completion: { mode: "explicit" }, completionLocalNodeId: "node-1", completionEndpointId: "endpoint-1" } });
    expect(h.dispatchedInvocations[0]?.metadata?.completionFlightId).toBe("flight-1");
  });
  test.each([
    { target: { kind: "project_path", projectPath: "/tmp/project" } },
    { target: { kind: "route_alias", alias: "other", scope: { nodeId: "remote" } } },
    { target: { kind: "session_id", sessionId: "session-1", host: "remote" } },
    { requestId: undefined }, { requesterNodeId: "remote" }, { execution: { session: "fork" } },
    { execution: { harness: "codex" } }, { execution: { model: "model" } }, { execution: { reasoningEffort: "high" } },
    { execution: { placement: "foreground" } }, { projectAgent: { persistence: "one_time" } },
  ])("unsupported route rejects before launching or accepting: %j", async override => {
    const h = createHarness(); await expect(h.service.accept({ ...payload, ...override } as ScoutDeliverRequest)).rejects.toThrow("completion_route_unsupported");
    expect(h.cardlessProjectSessionCalls).toEqual([]); expect(h.acceptedInvocations).toEqual([]); expect(h.dispatchedInvocations).toEqual([]);
  });
  test("remote or external endpoint fails before command acceptance", async () => {
    for (const endpoint of [testEndpoint({ nodeId: "remote" }), testEndpoint({ transport: "http", metadata: { externalSession: true } })]) {
      const h = createHarness({ snapshot: testSnapshot({ endpoints: { [endpoint.id]: endpoint } }) });
      await expect(h.service.accept(payload)).rejects.toThrow("completion_route_unsupported"); expect(h.acceptedInvocations).toEqual([]);
    }
  });
});
