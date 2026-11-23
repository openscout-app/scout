import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildScoutReturnAddress,
  manualReviewOccurrenceOf,
  type AgentDefinition,
  type ConversationDefinition,
  type DurableAction,
  type FlightRecord,
  type InvocationRequest,
  type ManualReviewDispatchConflict,
  type ManualReviewDispatchTarget,
  type ManualReviewOccurrenceRequest,
  type MessageRecord,
  type ScoutAttribution,
  type ScoutDeliverRequest,
  type WorkItemRecord,
} from "@openscout/protocol";

import { BrokerDeliveryAcceptanceService } from "./broker-delivery-acceptance-service.js";
import { deliveryRequestInvocationId, deliveryRequestMessageId, messageWithAcceptedFlight } from "./broker-delivery-receipt-recovery.js";
import type { InvocationResolution } from "./broker-delivery-routing.js";
import { BrokerDurableStore } from "./broker-durable-store.js";
import { FileBackedBrokerJournal } from "./broker-journal.js";
import { BrokerRequestReceipts, type BrokerRequestReceiptOptions } from "./broker-request-receipts.js";
import { BrokerCommandAdmission } from "./broker-storage-pressure.js";
import {
  ManualReviewDispatchError,
  ManualReviewDispatchService,
  buildManualReviewAsk,
  manualReviewAskRequestId,
  manualReviewWorkId,
} from "./manual-review-dispatch.js";
import { ManualReviewOccurrenceService, manualReviewOccurrenceId } from "./manual-review-occurrences.js";
import type { RuntimeSnapshot } from "./scout-dispatcher.js";
import { RecoverableSQLiteProjection } from "./sqlite-projection.js";

const NODE = "node-local";
const HEAD = "1f2e3d4c5b6a79880123456789abcdef01234567";
const REVIEWER: ManualReviewDispatchTarget = { kind: "agent_id", agentId: "reviewer" };
const OPERATOR: ScoutAttribution = { actorId: "operator", rootActorId: "operator", source: "local-admin" };
const AGENT: ScoutAttribution = { actorId: "agent-retry", rootActorId: "agent-retry", source: "unverified" };

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openscout-manual-review-dispatch-"));
  roots.add(root);
  return root;
}

function reviewRequest(overrides: Partial<ManualReviewOccurrenceRequest> = {}): ManualReviewOccurrenceRequest {
  return {
    scope: "review",
    requestId: "run-1",
    input: { source: "board:connection-1", id: "message-42", version: "3" },
    artifact: { kind: "pull_request", ref: "example/repo#12", revision: HEAD, observedAt: 900 },
    requestedById: "operator",
    ...overrides,
  };
}

function reviewer(id: string): AgentDefinition {
  return {
    id,
    kind: "agent",
    definitionId: id,
    displayName: id,
    handle: id,
    labels: ["agent"],
    metadata: {},
    selector: `@${id}`,
    defaultSelector: `@${id}`,
    agentClass: "general",
    capabilities: ["chat", "invoke", "deliver"],
    wakePolicy: "on_demand",
    homeNodeId: NODE,
    authorityNodeId: NODE,
    advertiseScope: "local",
  };
}

/**
 * What the ask path committed. It outlives a restart, as the journal does,
 * so a test can reopen the runtime and still find an accepted ask.
 */
type AskWorld = {
  /** Every accepted ask, in order. One entry is one started ask. */
  accepted: Array<{ invocation: InvocationRequest; message: MessageRecord; flight: FlightRecord }>;
  /** Accepted invocations as the journal keeps them, with the receipt witness. */
  canonical: Map<string, InvocationRequest>;
  /** Attempts that reached the commit, including ones that failed there. */
  commitAttempts: number;
  sessionsStarted: Array<{ projectPath: string; harness?: string }>;
};

function createWorld(): AskWorld {
  return { accepted: [], canonical: new Map(), commitAttempts: 0, sessionsStarted: [] };
}

type RuntimeOptions = {
  now?: () => number;
  receipts?: BrokerRequestReceiptOptions;
  admission?: BrokerCommandAdmission;
  /** Fails the commit of an ask, as a crash inside acceptance would. */
  failCommit?: () => boolean;
  /** The ask path's answer for a target it does not accept. */
  resolution?: InvocationResolution;
};

/**
 * The journal and writer as the broker wires them, with the real delivery
 * acceptance service and its receipt ledger in front of a recorded commit.
 */
async function openRuntime(root: string, world: AskWorld, options: RuntimeOptions = {}) {
  const now = options.now ?? (() => 1_000);
  const journal = new FileBackedBrokerJournal(join(root, "broker-journal.jsonl"));
  await journal.load();
  const projection = new RecoverableSQLiteProjection(join(root, "control-plane.sqlite"), journal, {
    conversationFeedPublishDelayMs: 0,
    conversationThreadPublishDelayMs: 0,
  });
  await projection.warm();
  await projection.flush();
  const durable = new BrokerDurableStore({ journal, projection, threadEvents: { publish() {} } });
  const getDurableAction = (actionId: string) => journal.getDurableAction(actionId);
  const receipts = new BrokerRequestReceipts(join(root, "request-receipts"), options.receipts);

  const snapshot: RuntimeSnapshot = {
    nodes: {}, actors: {}, agents: { reviewer: reviewer("reviewer"), other: reviewer("other") }, endpoints: {},
    conversations: {}, bindings: {}, messages: {}, readCursors: {}, invocations: {}, flights: {}, collaborationRecords: {},
  };
  const delivered: ScoutDeliverRequest[] = [];
  let ids = 0;
  const acceptance = new BrokerDeliveryAcceptanceService({
    requestReceipts: receipts,
    commandAdmission: options.admission,
    readAcceptedInvocation: async (id) => world.canonical.get(id),
    nodeId: NODE,
    operatorActorId: "operator",
    runtimeSnapshot: () => snapshot,
    createId: (prefix) => `${prefix}-${++ids}`,
    syncRegisteredLocalAgentsIfChanged: async () => {},
    metadataStringValue: (metadata, key) => {
      const value = metadata?.[key];
      return typeof value === "string" && value.trim() ? value.trim() : null;
    },
    messageRefCandidateForRouteTarget: () => null,
    resolveBrokerMessageRef: () => null,
    ensureBrokerActorForDelivery: async () => {},
    ensureBrokerDeliveryConversation: async (request): Promise<ConversationDefinition> => ({
      id: `dm.${request.requesterId}.${request.targetAgentId}`,
      kind: "direct",
      title: request.targetAgentId ?? "direct",
      visibility: "workspace",
      shareMode: "local",
      authorityNodeId: NODE,
      participantIds: [request.requesterId, request.targetAgentId ?? ""],
      metadata: {},
    }),
    brokerRouteKind: (conversation) => conversation.kind === "direct" ? "dm" : "channel",
    messageVisibilityForConversation: (conversation) => conversation?.visibility ?? "workspace",
    brokerActorDisplayName: (_snapshot, actorId) => actorId,
    brokerTargetLabel: (agent) => agent.selector ?? agent.id,
    homeEndpointForAgent: () => null,
    titleCaseName: (value) => value,
    buildBrokerReturnAddressForActor: (_snapshot, actorId, address) => buildScoutReturnAddress({
      actorId,
      handle: actorId,
      conversationId: address?.conversationId,
      replyToMessageId: address?.replyToMessageId,
      sessionId: address?.sessionId,
    }),
    isOperatorDeliveryTarget: () => false,
    isLocalScoutProductTarget: () => false,
    onlineConversationNotifyTargets: () => [],
    resolveBrokerDeliveryTargetWithImplicitProjectAgent: async (input) => {
      if (options.resolution) return options.resolution;
      const agentId = input.target?.kind === "agent_id" ? input.target.agentId : "reviewer";
      return { kind: "resolved", agent: snapshot.agents[agentId] ?? reviewer(agentId) };
    },
    createCardlessProjectSession: async (request) => {
      world.sessionsStarted.push({ projectPath: request.projectPath, harness: request.execution?.harness });
      return {
        kind: "resolved_session",
        session: {
          sessionId: "session-fresh",
          actorId: "fresh-reviewer",
          label: "Fresh reviewer",
          nodeId: NODE,
          endpoint: {
            id: "endpoint-fresh", agentId: "fresh-reviewer", nodeId: NODE, harness: request.execution?.harness ?? "codex",
            transport: "codex_app_server", state: "idle", sessionId: "session-fresh", metadata: { cardless: true },
          },
        },
      } as Extract<InvocationResolution, { kind: "resolved_session" }>;
    },
    recordScoutDispatch: async (envelope, dispatchOptions) => ({
      record: { id: `dispatch-${++ids}`, requesterId: dispatchOptions?.requesterId, ...envelope },
    }),
    describeUnavailableDeliveryTarget: () => null,
    buildUnavailableDispatchEnvelope: () => { throw new Error("unexpected unavailable dispatch"); },
    recordDeliveryWorkItemIfNeeded: async ({ payload, requesterId, targetAgentId, conversationId, createdAt }) => {
      const record = {
        id: payload.workItem!.id!, kind: "work_item", state: "working", acceptanceState: "none", title: payload.workItem!.title,
        createdById: requesterId, ownerId: targetAgentId, nextMoveOwnerId: targetAgentId, conversationId,
        createdAt, updatedAt: createdAt, requestedById: requesterId, labels: payload.workItem!.labels, metadata: payload.workItem!.metadata,
      } as WorkItemRecord;
      return { record, collaborationRecordId: record.id };
    },
    deliveryWorkItemResolutionForTell: () => ({ record: null }),
    postConversationMessage: async () => ({ ok: true }),
    acceptInvocation: async (invocation, message) => {
      world.commitAttempts += 1;
      if (options.failCommit?.()) throw new Error("the broker stopped inside acceptance");
      const flight: FlightRecord = {
        id: `flight-${world.accepted.length + 1}`,
        invocationId: invocation.id,
        requesterId: invocation.requesterId,
        targetAgentId: invocation.targetAgentId,
        state: "waking",
        startedAt: now(),
      };
      world.accepted.push({ invocation, message: message!, flight });
      // The broker stores this witness in the same journal frame as the ask.
      world.canonical.set(invocation.id, {
        ...invocation,
        metadata: { ...invocation.metadata, acceptedDeliveryReceipt: messageWithAcceptedFlight(message!, flight) },
      });
      return flight;
    },
    dispatchAcceptedInvocation: async () => {},
    queueOperatorDeliveryIssue: () => {},
    queueOperatorSignal: () => {},
    now,
  });

  const stores = { authorityCellId: NODE, runDurableWrite: durable.runWrite, commitEntries: durable.commitEntries, getDurableAction, now };
  return {
    journal,
    receipts,
    delivered,
    occurrences: new ManualReviewOccurrenceService(stores),
    dispatch: new ManualReviewDispatchService({
      ...stores,
      deliver: (request) => { delivered.push(request); return acceptance.accept(request); },
      readAskReceipt: (requesterId, requestId) => receipts.get(requesterId, requestId, "deliver"),
    }),
    async close(): Promise<void> {
      await durable.flushProjectedEntries();
      projection.close();
      await journal.close();
    },
  };
}

async function refusalOf(attempt: Promise<unknown>): Promise<ManualReviewDispatchError> {
  const error = await attempt.then(
    () => { throw new Error("expected the dispatch to be refused"); },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ManualReviewDispatchError);
  return error as ManualReviewDispatchError;
}

async function journaledOccurrenceStates(journal: FileBackedBrokerJournal): Promise<string[]> {
  const states: string[] = [];
  for (const entry of await journal.readEntries()) {
    if (entry.kind !== "durable.action.record") continue;
    states.push(((entry.action as DurableAction).metadata?.manualReview as { state: string }).state);
  }
  return states;
}

const run = { scope: "review", requestId: "run-1" };
const occurrenceId = manualReviewOccurrenceId(NODE, "review", "run-1");
const askRequestId = manualReviewAskRequestId(occurrenceId);

describe("manual review dispatch", () => {
  test("recording stays inert, and a dispatch starts one ask whose ticket every retry returns", async () => {
    const root = createRoot();
    const world = createWorld();
    const runtime = await openRuntime(root, world);

    await runtime.occurrences.record(reviewRequest());
    await runtime.occurrences.record(reviewRequest());
    expect(runtime.delivered).toEqual([]);
    expect(world.commitAttempts).toBe(0);

    const first = await runtime.dispatch.dispatch({ ...run, target: REVIEWER, attribution: OPERATOR });

    expect(first.replayed).toBe(false);
    expect(first.ticket).toEqual({
      workId: manualReviewWorkId(occurrenceId),
      flightId: "flight-1",
      invocationId: deliveryRequestInvocationId("operator", askRequestId),
      messageId: deliveryRequestMessageId("operator", askRequestId),
      conversationId: "dm.operator.reviewer",
      targetAgentId: "reviewer",
      bindingRef: "flight-1".slice(-8),
      acceptedAt: 1_000,
    });
    expect(first.occurrence).toMatchObject({
      id: occurrenceId,
      state: "dispatched",
      artifact: { revision: HEAD },
      dispatch: { target: REVIEWER, askRequestId, requestedById: "operator", attribution: OPERATOR, admittedAt: 1_000, ticket: first.ticket },
    });

    // The ask is an ordinary task ask sent as the admitted principal, with the pins and nothing fetched.
    const [{ invocation, message }] = world.accepted;
    expect(invocation).toMatchObject({ requesterId: "operator", targetAgentId: "reviewer", action: "consult", requestId: askRequestId });
    expect(invocation.metadata).toMatchObject({ taskVersion: 1, source: "scout-manual-review", manualReviewOccurrenceId: occurrenceId, attribution: OPERATOR });
    expect(message.metadata).toMatchObject({ attribution: OPERATOR, workId: manualReviewWorkId(occurrenceId) });
    expect(message.body).toContain(`Review pull_request example/repo#12 at revision ${HEAD}.`);
    expect(message.body).toContain(JSON.stringify({
      occurrenceId, scope: "review", requestId: "run-1",
      input: { source: "board:connection-1", id: "message-42", version: "3" },
      artifact: { kind: "pull_request", ref: "example/repo#12", revision: HEAD },
    }));

    // A retry, also from another principal, reads the stored ticket. Nothing is delivered again.
    const retry = await runtime.dispatch.dispatch({ ...run, target: { ...REVIEWER }, attribution: AGENT });
    expect(retry).toEqual({ occurrence: first.occurrence, ticket: first.ticket, replayed: true });
    expect(runtime.delivered).toHaveLength(1);
    expect(world.accepted).toHaveLength(1);

    // Recording again is still a replay of the same run, and still starts nothing.
    const recorded = await runtime.occurrences.record(reviewRequest());
    expect(recorded).toEqual({ occurrence: first.occurrence, created: false });
    expect(runtime.occurrences.lookup(run)).toEqual(first.occurrence);
    expect(world.accepted).toHaveLength(1);
    expect(await journaledOccurrenceStates(runtime.journal)).toEqual(["recorded", "admitted", "dispatched"]);
    await runtime.close();
  });

  test("concurrent replays share one ask and one ticket", async () => {
    const root = createRoot();
    const world = createWorld();
    const runtime = await openRuntime(root, world);
    await runtime.occurrences.record(reviewRequest());

    const results = await Promise.all([OPERATOR, AGENT, OPERATOR, AGENT, OPERATOR].map((attribution) =>
      runtime.dispatch.dispatch({ ...run, target: { ...REVIEWER }, attribution })));

    expect(world.commitAttempts).toBe(1);
    expect(world.accepted).toHaveLength(1);
    for (const result of results) expect(result.ticket).toEqual(results[0]!.ticket);
    // One call stored the ticket. The others read it.
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    // Every attempt that reached the ask path sent the same request, as the admitted principal.
    expect(new Set(runtime.delivered.map((request) => JSON.stringify(request))).size).toBe(1);
    expect(runtime.delivered[0]).toMatchObject({ requestId: askRequestId, caller: { actorId: "operator", nodeId: NODE } });
    expect(await journaledOccurrenceStates(runtime.journal)).toEqual(["recorded", "admitted", "dispatched"]);
    await runtime.close();
  });

  test("a target is pinned at admission and a different one is refused, also when both arrive together", async () => {
    const root = createRoot();
    const world = createWorld();
    const runtime = await openRuntime(root, world);
    await runtime.occurrences.record(reviewRequest());
    const other: ManualReviewDispatchTarget = { kind: "agent_id", agentId: "other" };

    const settled = await Promise.allSettled([
      runtime.dispatch.dispatch({ ...run, target: REVIEWER, attribution: OPERATOR }),
      runtime.dispatch.dispatch({ ...run, target: other, attribution: AGENT }),
    ]);

    expect(settled[0].status).toBe("fulfilled");
    expect(settled[1].status).toBe("rejected");
    const refused = (settled[1] as PromiseRejectedResult).reason as ManualReviewDispatchError;
    expect(refused).toBeInstanceOf(ManualReviewDispatchError);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "manual_review_dispatch_conflict", differs: ["target.agentId"] });
    expect(world.accepted.map(({ invocation }) => invocation.targetAgentId)).toEqual(["reviewer"]);

    // Every other way to name a different recipient is refused the same way, after dispatch too.
    const retargets: Array<[ManualReviewDispatchTarget, string[]]> = [
      [other, ["target.agentId"]],
      [{ kind: "session_id", sessionId: "sess.abc" }, ["target.kind"]],
      [{ kind: "project_path", projectPath: "/work/example" }, ["target.kind"]],
    ];
    for (const [target, differs] of retargets) {
      const error = await refusalOf(runtime.dispatch.dispatch({ ...run, target, attribution: OPERATOR }));
      expect(error.status).toBe(409);
      expect((error.body as ManualReviewDispatchConflict).differs).toEqual(differs);
      expect((error.body as ManualReviewDispatchConflict).occurrence?.dispatch?.target).toEqual(REVIEWER);
    }
    expect(world.accepted).toHaveLength(1);
    expect(runtime.delivered).toHaveLength(1);
    await runtime.close();
  });

  test("a restart between admission and dispatch delivers the pinned ask once, under the same identity", async () => {
    const root = createRoot();
    const world = createWorld();
    // The ask path is at capacity, so the first call admits and then cannot reserve the ask.
    const admission = new BrokerCommandAdmission({ maxCommands: 1 });
    admission.reserve({ held: "another command" });
    const before = await openRuntime(root, world, { now: () => 1_000, admission });
    await before.occurrences.record(reviewRequest());

    const notStarted = await refusalOf(before.dispatch.dispatch({ ...run, target: REVIEWER, attribution: OPERATOR }));
    expect(notStarted.status).toBe(503);
    expect(notStarted.body).toMatchObject({ error: "manual_review_dispatch_not_started", retryable: true });
    expect(await before.receipts.get("operator", askRequestId, "deliver")).toBeNull();
    const admitted = before.occurrences.lookup(run);
    expect(admitted).toMatchObject({ state: "admitted", dispatch: { target: REVIEWER, askRequestId, requestedById: "operator", admittedAt: 1_000 } });
    expect(admitted?.dispatch?.ticket).toBeUndefined();
    await before.close();

    // After the restart another principal retries, later. The pin decides who asks, what, and when it was admitted.
    const after = await openRuntime(root, world, { now: () => 9_000 });
    expect(after.occurrences.lookup(run)).toEqual(admitted);
    const retargeted = await refusalOf(after.dispatch.dispatch({ ...run, target: { kind: "agent_id", agentId: "other" }, attribution: AGENT }));
    expect(retargeted.body).toMatchObject({ error: "manual_review_dispatch_conflict" });

    const [first, second] = await Promise.all([
      after.dispatch.dispatch({ ...run, target: REVIEWER, attribution: AGENT }),
      after.dispatch.dispatch({ ...run, target: REVIEWER, attribution: AGENT }),
    ]);

    expect(world.accepted).toHaveLength(1);
    expect(second.ticket).toEqual(first.ticket);
    expect(first.ticket).toMatchObject({
      invocationId: deliveryRequestInvocationId("operator", askRequestId),
      messageId: deliveryRequestMessageId("operator", askRequestId),
      targetAgentId: "reviewer",
    });
    expect(world.accepted[0]!.invocation).toMatchObject({ requesterId: "operator", requestId: askRequestId, createdAt: 1_000 });
    expect(after.delivered[0]).toEqual(buildManualReviewAsk(admitted!, admitted!.dispatch!, NODE));
    await after.close();
  });

  test("a restart after the ask was accepted returns the original ticket and starts no second ask", async () => {
    const root = createRoot();
    const world = createWorld();
    // The ask commits, then the broker stops before the receipt is saved as done.
    const before = await openRuntime(root, world, {
      receipts: { sync: async (file, _kind, record) => { if (record.state === "done") throw new Error("stopped before the receipt was saved"); await file.sync(); } },
    });
    await before.occurrences.record(reviewRequest());
    await refusalOf(before.dispatch.dispatch({ ...run, target: REVIEWER, attribution: OPERATOR }));
    expect(world.accepted).toHaveLength(1);
    expect((await before.receipts.get("operator", askRequestId, "deliver"))?.state).toBe("unknown");
    expect(before.occurrences.lookup(run)?.state).toBe("admitted");
    await before.close();

    const after = await openRuntime(root, world, { now: () => 9_000 });
    const recovered = await after.dispatch.dispatch({ ...run, target: REVIEWER, attribution: AGENT });

    const original = world.accepted[0]!;
    expect(recovered.ticket).toMatchObject({
      workId: manualReviewWorkId(occurrenceId),
      flightId: original.flight.id,
      invocationId: original.invocation.id,
      messageId: original.message.id,
      targetAgentId: "reviewer",
      acceptedAt: 1_000,
    });
    expect(world.commitAttempts).toBe(1);
    expect(world.accepted).toHaveLength(1);
    expect((await after.receipts.get("operator", askRequestId, "deliver"))?.state).toBe("done");

    // The ticket is on the occurrence now, so later retries do not reach the ask path at all.
    const deliveredSoFar = after.delivered.length;
    const again = await after.dispatch.dispatch({ ...run, target: REVIEWER, attribution: OPERATOR });
    expect(again).toEqual({ occurrence: recovered.occurrence, ticket: recovered.ticket, replayed: true });
    expect(after.delivered).toHaveLength(deliveredSoFar);
    await after.close();

    // And a restart after the ticket was stored reads it from the journal.
    const later = await openRuntime(root, createWorld());
    expect((await later.dispatch.dispatch({ ...run, target: REVIEWER, attribution: OPERATOR })).ticket).toEqual(recovered.ticket);
    expect(later.delivered).toEqual([]);
    await later.close();
  });

  test("an ask that stopped inside acceptance stays unknown and is never started again", async () => {
    const root = createRoot();
    const world = createWorld();
    const before = await openRuntime(root, world, { failCommit: () => true });
    await before.occurrences.record(reviewRequest());

    const stopped = await refusalOf(before.dispatch.dispatch({ ...run, target: REVIEWER, attribution: OPERATOR }));
    expect(stopped.status).toBe(409);
    expect(stopped.body).toMatchObject({ error: "manual_review_dispatch_unknown", occurrence: { state: "admitted" } });
    expect(stopped.body.detail).toContain(`request ${askRequestId} from operator`);
    expect(world.commitAttempts).toBe(1);
    await before.close();

    // The ask path cannot tell whether the stopped attempt had an effect, so it refuses to run it again.
    const after = await openRuntime(root, world);
    for (const attribution of [OPERATOR, AGENT]) {
      const unknown = await refusalOf(after.dispatch.dispatch({ ...run, target: REVIEWER, attribution }));
      expect(unknown.body).toMatchObject({ error: "manual_review_dispatch_unknown" });
    }
    expect(world.commitAttempts).toBe(1);
    expect(world.accepted).toEqual([]);
    expect(after.occurrences.lookup(run)?.state).toBe("admitted");

    // A new occurrence of the same review is a new run with its own ask.
    await after.occurrences.record(reviewRequest({ requestId: "run-2" }));
    const fresh = await after.dispatch.dispatch({ scope: "review", requestId: "run-2", target: REVIEWER, attribution: OPERATOR });
    expect(fresh.ticket.invocationId).not.toBe(deliveryRequestInvocationId("operator", askRequestId));
    expect(world.accepted).toHaveLength(1);
    await after.close();
  });

  test("a target the ask path refuses is stored as refused, and no ask starts on retry", async () => {
    const root = createRoot();
    const world = createWorld();
    const runtime = await openRuntime(root, world, { resolution: { kind: "unknown", label: "reviewer", detail: "no agent named reviewer" } as InvocationResolution });
    await runtime.occurrences.record(reviewRequest());

    const refused = await refusalOf(runtime.dispatch.dispatch({ ...run, target: REVIEWER, attribution: OPERATOR }));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      error: "manual_review_dispatch_refused",
      occurrence: { state: "refused", dispatch: { target: REVIEWER, refusal: { kind: "rejected", reason: "unknown_target", refusedAt: 1_000 } } },
    });
    expect(world.commitAttempts).toBe(0);
    await runtime.close();

    // The target exists after the restart. The occurrence keeps its refusal all the same.
    const after = await openRuntime(root, world);
    const again = await refusalOf(after.dispatch.dispatch({ ...run, target: REVIEWER, attribution: OPERATOR }));
    expect(again.body).toMatchObject({ error: "manual_review_dispatch_refused" });
    expect(after.delivered).toEqual([]);
    expect(world.accepted).toEqual([]);
    await after.close();
  });

  test("a project target starts a fresh session in the selected harness", async () => {
    const root = createRoot();
    const world = createWorld();
    const runtime = await openRuntime(root, world);
    await runtime.occurrences.record(reviewRequest());
    const target: ManualReviewDispatchTarget = { kind: "project_path", projectPath: "/work/example", harness: "codex" };

    const { ticket, occurrence } = await runtime.dispatch.dispatch({ ...run, target, attribution: OPERATOR });

    expect(world.sessionsStarted).toEqual([{ projectPath: "/work/example", harness: "codex" }]);
    expect(ticket).toMatchObject({ targetAgentId: "fresh-reviewer", targetSessionId: "session-fresh" });
    expect(occurrence.dispatch?.target).toEqual(target);
    const sameProjectOtherHarness = await refusalOf(runtime.dispatch.dispatch({ ...run, target: { ...target, harness: "claude" }, attribution: OPERATOR }));
    expect((sameProjectOtherHarness.body as ManualReviewDispatchConflict).differs).toEqual(["target.harness"]);
    expect((await runtime.dispatch.dispatch({ ...run, target, attribution: AGENT })).ticket).toEqual(ticket);
    expect(world.sessionsStarted).toHaveLength(1);
    await runtime.close();
  });

  test("a request that names no single recorded run and recipient is refused before any write", async () => {
    const root = createRoot();
    const world = createWorld();
    const runtime = await openRuntime(root, world);

    const missing = await refusalOf(runtime.dispatch.dispatch({ ...run, target: REVIEWER, attribution: OPERATOR }));
    expect(missing.status).toBe(404);

    await runtime.occurrences.record(reviewRequest());
    const invalid: Array<[unknown, string]> = [
      [undefined, "target must be an object"],
      [{ kind: "channel", channel: "reviews" }, "one explicit recipient"],
      [{ kind: "broadcast" }, "one explicit recipient"],
      [{ kind: "agent_label", label: "reviewer" }, "one explicit recipient"],
      [{ kind: "agent_id", agentId: " reviewer" }, "target.agentId"],
      [{ kind: "agent_id", agentId: "reviewer", sessionId: "sess.abc" }, "target.sessionId is not part of a agent_id target"],
      [{ kind: "project_path", projectPath: "example" }, "absolute path"],
      [{ kind: "project_path", projectPath: "/work/example", host: "elsewhere" }, "target.host is not part of a project_path target"],
      [{ kind: "project_path", projectPath: "/work/example", harness: "not-a-harness" }, "target.harness"],
    ];
    for (const [target, detail] of invalid) {
      const error = await refusalOf(runtime.dispatch.dispatch({ ...run, target: target as ManualReviewDispatchTarget, attribution: OPERATOR }));
      expect(error.status).toBe(400);
      expect(error.message).toContain(detail);
    }
    const unattributed = await refusalOf(runtime.dispatch.dispatch({ ...run, target: REVIEWER, attribution: { ...OPERATOR, actorId: "" } }));
    expect(unattributed.status).toBe(400);

    expect(runtime.occurrences.lookup(run)).toMatchObject({ state: "recorded" });
    expect(manualReviewOccurrenceOf(runtime.journal.getDurableAction(occurrenceId))?.dispatch).toBeUndefined();
    expect(await journaledOccurrenceStates(runtime.journal)).toEqual(["recorded"]);
    expect(runtime.delivered).toEqual([]);
    await runtime.close();
  });
});
