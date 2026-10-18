import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { BrokerDeliveryAcceptanceService } from "./broker-delivery-acceptance-service.js";
import { createBrokerHttpRouter } from "./broker-http-router.js";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flightCompletion, type FlightRecord, type InvocationRequest, type MessageRecord } from "@openscout/protocol";
import { createInMemoryControlRuntime } from "./broker.js";
import { FileBackedBrokerJournal, type BrokerJournalEntry } from "./broker-journal.js";
import { BrokerDurableRecordStore } from "./broker-durable-record-store.js";
import { BrokerFlightLifecycleService } from "./broker-flight-lifecycle-service.js";
import { BrokerMessageService } from "./broker-message-service.js";
import { isFinalReplyForInvocation } from "./broker-conversation-helpers.js";
import { planHistoryRotation } from "./history-rotation.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function invocation(id = "parent", metadata: Record<string, unknown> = {}): InvocationRequest {
  return { id, requestId: id, requesterId: "operator", requesterNodeId: "node", targetNodeId: "node", targetAgentId: "worker",
    action: "consult", task: id, conversationId: "conversation", messageId: `ask-${id}`, createdAt: 1, ensureAwake: false, stream: false,
    metadata: { completion: { mode: "explicit" }, completionLocalNodeId: "node", completionEndpointId: "endpoint-worker", ...metadata } };
}
function flight(request: InvocationRequest, id = `flight-${request.id}`): FlightRecord {
  return { id, invocationId: request.id, requesterId: request.requesterId, targetAgentId: request.targetAgentId, state: "running", startedAt: 2 };
}
function reply(revision = 0, kind: "progress" | "final" = "final", id = `reply-${kind}-${revision}`): MessageRecord {
  return { id, requestId: id, actorId: "worker", originNodeId: "node", conversationId: "conversation", replyToMessageId: "ask-parent",
    class: "agent", body: "result", policy: "durable", visibility: "private", createdAt: 3,
    metadata: { clientMessageId: id, completionReply: { kind, invocationId: "parent", flightId: "flight-parent", revision } } };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "scout-explicit-completion-")); dirs.push(directory);
  const path = join(directory, "journal.jsonl");
  let journal = new FileBackedBrokerJournal(path); await journal.load();
  let runtime = createInMemoryControlRuntime({}, { localNodeId: "node" });
  let serial = Promise.resolve(), failApplyParent = false;
  const runWrite = <T>(work: () => Promise<T>): Promise<T> => { const result = serial.then(work); serial = result.then(() => {}, () => {}); return result; };
  const frames: BrokerJournalEntry[][] = [];
  const commitEntries = async (entries: BrokerJournalEntry | BrokerJournalEntry[], apply: (entries: BrokerJournalEntry[]) => Promise<void>) => {
    const list = Array.isArray(entries) ? entries : [entries]; await journal.appendEntries(list); frames.push(list); await apply(list); return list;
  };
  const durableStore = { runWrite, commitEntries, applyProjectedEntries: async () => {} };
  let records: BrokerDurableRecordStore, lifecycle: BrokerFlightLifecycleService, messages: BrokerMessageService;
  function configure() {
    records = new BrokerDurableRecordStore({ localNodeId: "node", runtime: {
      peek: () => runtime.peek(), planInvocation: request => runtime.planInvocation(request),
      commitInvocation: (request, result) => runtime.commitInvocation(request, result),
      upsertFlight: async (value, options) => { if (failApplyParent && value.id === "flight-parent") { failApplyParent = false; throw new Error("runtime apply failed"); } await runtime.upsertFlight(value, options); },
      flightForInvocation: id => runtime.flightForInvocation(id),
      planMessage: (message, options) => runtime.planMessage(message, options), commitMessage: (message, deliveries) => runtime.commitMessage(message, deliveries),
      collaborationRecord: id => runtime.collaborationRecord(id),
    } as any, durableStore, knownInvocations: new Map(), completionCurrentFlight: id => journal.getCurrentFlightForInvocation(id), completionFlight: id => journal.getFlight(id), completionInvocation: id => journal.getInvocation(id) });
    lifecycle = new BrokerFlightLifecycleService({ runtime, journal, durableStore, invocationFor: id => journal.getInvocation(id),
      updateDeliveryStatus: async () => {}, updateDeliveryStatusIf: async () => false, promoteInvocationFlightToWork: async () => {},
      maybeForwardFlightToAuthority: async () => {}, isInvocationActive: () => false });
    messages = new BrokerMessageService({ nodeId: "node", systemActorId: "system", runtime, createId: prefix => prefix,
      mesh: { authorityNodeForConversation: () => null, forwardConversationMessageToAuthority: async () => { throw new Error("unexpected mesh"); }, forwardPeerBrokerDeliveries: async () => ({}) as any },
      recordMessage: (message, options) => records.recordMessage(message, options), applyProjectedEntries: async () => {}, reconcileStaleLocalDeliveries: async () => {},
      completionFlight: id => journal.getFlight(id), completionCurrentFlight: id => journal.getCurrentFlightForInvocation(id), persistFlight: lifecycle.recordFlight, persistAcceptedReply: async () => {}, activeLocalEndpointForAgent: () => undefined });
  }
  configure();
  for (const agentId of ["worker", "helper"]) {
    const endpoint = { id: `endpoint-${agentId}`, agentId, nodeId: "node", harness: "codex" as const, transport: "tmux" as const, state: "idle" as const, sessionId: "session" };
    await runtime.upsertEndpoint(endpoint); await journal.appendEntries({ kind: "agent.endpoint.upsert", endpoint });
  }
  await runtime.upsertConversation({ id: "conversation", title: "Work", kind: "direct", participantIds: ["operator", "worker"], authorityNodeId: "node", visibility: "private", shareMode: "private" } as any);
  await journal.appendEntries({ kind: "conversation.upsert", conversation: { id: "conversation", title: "Work", kind: "direct", participantIds: ["operator", "worker"], authorityNodeId: "node", visibility: "private", shareMode: "private" } as any });
  async function accept(request = invocation()) { return records.recordInvocation(request, { flight: flight(request) }); }
  async function child(id = "child", kind: "joined" | "continuation" = "joined") {
    const request = { ...invocation(id, { completion: undefined, completionRelation: { parentFlightId: "flight-parent", kind } }), requesterId: "worker", targetAgentId: "helper", metadata: { completion: undefined, completionLocalNodeId: "node", completionEndpointId: "endpoint-helper", completionRelation: { parentFlightId: "flight-parent", kind } } };
    return accept(request);
  }
  return { accept, child, frames, get runtime() { return runtime; }, get records() { return records; }, get lifecycle() { return lifecycle; }, get messages() { return messages; }, get journal() { return journal; },
    failParentApply() { failApplyParent = true; },
    async reopen() { journal = new FileBackedBrokerJournal(path); await journal.load(); runtime = createInMemoryControlRuntime(journal.snapshot(), { localNodeId: "node" }); configure(); },
  };
}

test("progress never completes legacy or explicit asks; untagged legacy replies remain final", async () => {
  expect(isFinalReplyForInvocation(reply(0, "progress"), invocation("parent", { completion: undefined }))).toBe(false);
  expect(isFinalReplyForInvocation({ ...reply(), metadata: {} }, invocation("parent", { completion: undefined }))).toBe(true);
  expect(isFinalReplyForInvocation({ ...reply(), metadata: {} }, invocation())).toBe(false);
  const h = await fixture(); await h.accept(); await h.messages.postConversationMessage(reply(0, "progress"));
  expect(h.runtime.flightForInvocation("parent")?.state).toBe("running");
  await h.messages.postConversationMessage(reply()); expect(h.runtime.flightForInvocation("parent")?.state).toBe("completed");
});

test.each(["completed", "empty"])("%s adapter exit waits for explicit final across restart", async variant => {
  const h = await fixture(); const accepted = await h.accept();
  await h.lifecycle.recordFlight({ ...accepted.flight, state: variant === "empty" ? "failed" : "completed", output: variant === "empty" ? undefined : "plain output", completedAt: 4,
    metadata: { failureStage: "empty_reply", resultReply: { status: "pending" } } });
  await h.reopen(); const current = h.runtime.flightForInvocation("parent")!;
  expect(current.state).toBe("waiting"); expect(current.completedAt).toBeUndefined(); expect(current.metadata?.resultReply).toBeUndefined();
  expect(flightCompletion(current)?.awaitingFinal).toBe(true);
  await h.messages.postConversationMessage(reply()); expect(h.runtime.flightForInvocation("parent")?.state).toBe("completed");
});

test("joined child acceptance and revision are one frame, retries join once and survive reopen", async () => {
  const h = await fixture(); await h.accept(); await h.child(); await h.child();
  expect(flightCompletion(h.runtime.flightForInvocation("parent"))?.revision).toBe(1);
  const frame = h.frames.find(entries => entries.some(entry => entry.kind === "invocation.record" && entry.invocation.id === "child"))!;
  expect(frame.filter(entry => entry.kind === "flight.record").map(entry => entry.flight.id)).toEqual(["flight-parent", "flight-child"]);
  await h.reopen(); await h.child(); expect(flightCompletion(h.runtime.flightForInvocation("parent"))?.obligations).toHaveLength(1);
});

test("lost runtime apply after atomic acceptance cannot double-join before restart", async () => {
  const h = await fixture(); await h.accept(); h.failParentApply();
  await expect(h.child()).rejects.toThrow("runtime apply failed");
  await h.child(); expect(flightCompletion(h.journal.getFlight("flight-parent"))?.revision).toBe(1);
  await h.reopen(); expect(flightCompletion(h.runtime.flightForInvocation("parent"))?.obligations).toHaveLength(1);
});

test.each(["completed", "failed", "cancelled"] as const)("early final is rejected, %s child settles but parent still owes a new final", async state => {
  const h = await fixture(); await h.accept(); const child = await h.child();
  await expect(h.messages.postConversationMessage(reply(1))).rejects.toThrow("completion_obligations_pending");
  expect(h.journal.snapshot().messages[reply(1).id]).toBeUndefined();
  await h.lifecycle.recordFlight({ ...child.flight, state, output: state === "completed" ? "child result" : undefined, completedAt: 5 });
  await h.reopen(); expect(h.runtime.flightForInvocation("parent")?.state).toBe("running");
  expect(await h.messages.recoverInvocationReply(invocation())).toBe(false);
  await h.messages.postConversationMessage(reply(1)); expect(h.runtime.flightForInvocation("parent")?.state).toBe("completed");
});

test("new admission invalidates an already stored final even if child finishes before completion writer", async () => {
  const h = await fixture(); await h.accept(); await h.records.recordMessage(reply());
  const child = await h.child(); await h.lifecycle.recordFlight({ ...child.flight, state: "failed", completedAt: 4 });
  expect(await h.messages.completeInvocationForBrokerReply(invocation(), reply())).toBe(false);
  await h.reopen(); expect(await h.messages.recoverInvocationReply(invocation())).toBe(false);
  await expect(h.messages.postConversationMessage(reply(0, "final", "new-stale-final"))).rejects.toThrow("completion_revision_stale");
  await h.messages.postConversationMessage(reply(1)); expect(h.runtime.flightForInvocation("parent")?.state).toBe("completed");
});

test("durably accepted explicit final recovers completion after restart without replaying acceptance or fanout", async () => {
  const h = await fixture(); await h.accept(); await h.records.recordMessage(reply());
  expect(h.runtime.flightForInvocation("parent")?.state).toBe("running");
  await h.reopen(); const frameCount = h.frames.length;
  expect(await h.messages.recoverInvocationReply(invocation())).toBe(true);
  expect(h.runtime.flightForInvocation("parent")?.state).toBe("completed");
  expect(h.frames.slice(frameCount).flat().map(entry => entry.kind)).toEqual(["flight.record"]);
  expect(await h.messages.recoverInvocationReply(invocation())).toBe(false);
  await h.messages.postConversationMessage(reply());
  expect(h.frames.slice(frameCount).flat().filter(entry => entry.kind === "message.record" || entry.kind === "deliveries.record" || entry.kind === "invocation.record")).toEqual([]);
  await h.reopen(); expect(h.runtime.flightForInvocation("parent")?.state).toBe("completed");
});

test("same request identity cannot turn progress into final", async () => {
  const h = await fixture(); await h.accept(); await h.messages.postConversationMessage(reply(0, "progress", "stable"));
  await expect(h.messages.postConversationMessage(reply(0, "final", "stable"))).rejects.toThrow("different record");
  expect(h.runtime.flightForInvocation("parent")?.state).toBe("running");
});

test("cancelled parent and replaced current parent reject late child acceptance", async () => {
  const h = await fixture(); const accepted = await h.accept();
  await h.lifecycle.recordFlight({ ...accepted.flight, state: "cancelled", completedAt: 4 });
  await expect(h.child()).rejects.toThrow("completion_parent_unavailable");
  const h2 = await fixture(); await h2.accept(); await h2.journal.appendEntries({ kind: "flight.record", flight: flight(invocation(), "replacement") });
  await expect(h2.child()).rejects.toThrow("completion_parent_not_current");
});

test("continuation requires same target and exact current session and advances revision", async () => {
  const h = await fixture(); const accepted = await h.accept();
  await h.lifecycle.recordFlight({ ...accepted.flight, metadata: { dispatchAck: { sessionId: "session", acknowledgedAt: 2 } } });
  await expect(h.child("wrong", "continuation")).rejects.toThrow("completion_continuation_requires_same_session");
  const continuation = invocation("continuation", { completion: undefined, completionRelation: { parentFlightId: accepted.flight.id, kind: "continuation" } });
  continuation.execution = { targetSessionId: "session", session: "existing" };
  await h.accept(continuation); expect(flightCompletion(h.runtime.flightForInvocation("parent"))?.revision).toBe(1);
});

test("obligations are bounded before child acceptance and keep terminal children through rotation", async () => {
  const h = await fixture(); await h.accept();
  for (let n = 0; n < 64; n++) { const child = await h.child(`child-${n}`); await h.lifecycle.recordFlight({ ...child.flight, state: "failed", completedAt: 4 }); }
  await expect(h.child("overflow")).rejects.toThrow("completion_obligations_limit");
  expect(h.journal.getInvocation("overflow")).toBeUndefined();
  const plan = planHistoryRotation(h.journal.snapshot(), 100);
  expect(plan.flightIds.size).toBe(0); expect(plan.invocationIds.size).toBe(0);
});

test("canonical F2 prevents old replies and late completion when runtime still holds F1", async () => {
  const h = await fixture(); const accepted = await h.accept(); await h.records.recordMessage(reply());
  await h.journal.appendEntries({ kind: "flight.record", flight: { ...accepted.flight, id: "replacement" } });
  expect(h.runtime.flightForInvocation("parent")?.id).toBe("flight-parent");
  await expect(h.messages.postConversationMessage(reply(0, "progress", "stale-progress"))).rejects.toThrow("completion_flight_not_current");
  expect(await h.messages.completeInvocationForBrokerReply(invocation(), reply())).toBe(false);
  expect(h.journal.getCurrentFlightForInvocation("parent")?.id).toBe("replacement");
  await h.reopen(); expect(h.journal.getCurrentFlightForInvocation("parent")?.id).toBe("replacement");
});

test("endpoint route is rechecked inside acceptance writer before joined child commits", async () => {
  const h = await fixture(); await h.accept();
  await h.runtime.upsertEndpoint({ id: "endpoint-helper", agentId: "helper", nodeId: "remote", harness: "codex", transport: "tmux", state: "idle" });
  await expect(h.child()).rejects.toThrow("completion_endpoint_changed");
  expect(h.journal.getInvocation("child")).toBeUndefined();
  expect(flightCompletion(h.journal.getFlight("flight-parent"))?.revision).toBe(0);
});

test("unknown flight identity cannot bypass explicit completion through raw status updates", async () => {
  const h = await fixture(); const accepted = await h.accept();
  await expect(h.lifecycle.recordFlight({ ...accepted.flight, id: "unadmitted", state: "completed", output: "bypass", completedAt: 10 })).rejects.toThrow("completion_flight_unknown");
  expect(h.journal.getFlight("unadmitted")).toBeUndefined(); expect(h.journal.getCurrentFlightForInvocation("parent")?.id).toBe(accepted.flight.id);
});

test("an explicit flight cannot be reparented or retargeted by a raw status update", async () => {
  const h = await fixture(); const accepted = await h.accept();
  for (const identity of [{ invocationId: "unknown" }, { targetAgentId: "other" }, { requesterId: "other" }]) {
    await expect(h.lifecycle.recordFlight({ ...accepted.flight, ...identity, state: "completed", output: "bypass", completedAt: 10 }))
      .rejects.toThrow("completion_flight_identity_mismatch");
  }
  expect(h.journal.getFlight(accepted.flight.id)).toEqual(accepted.flight);
});

test("canonical child terminal truth permits final despite failed runtime apply", async () => {
  const h = await fixture(); await h.accept(); const child = await h.child();
  await h.journal.appendEntries({ kind: "flight.record", flight: { ...child.flight, state: "failed", completedAt: 5 } });
  expect(h.runtime.flightForInvocation("child")?.state).toBe("running");
  await h.messages.postConversationMessage(reply(1)); expect(h.runtime.flightForInvocation("parent")?.state).toBe("completed");
});

test("HTTP ask and typed reply traverse real acceptance, atomic admission and completion without re-dispatch", async () => {
  const h = await fixture(); let dispatches = 0, ids = 0;
  const acceptance = new BrokerDeliveryAcceptanceService({
    nodeId: "node", operatorActorId: "operator", runtimeSnapshot: () => h.runtime.snapshot(), createId: prefix => `${prefix}-${++ids}`,
    syncRegisteredLocalAgentsIfChanged: async () => {}, metadataStringValue: (metadata, key) => typeof metadata?.[key] === "string" ? metadata[key] : null,
    messageRefCandidateForRouteTarget: () => null, ensureBrokerActorForDelivery: async () => {},
    ensureBrokerDeliveryConversation: async () => h.runtime.snapshot().conversations.conversation!,
    brokerRouteKind: () => "dm", messageVisibilityForConversation: () => "private", brokerActorDisplayName: (_snapshot, id) => id,
    brokerTargetLabel: agent => agent.id, homeEndpointForAgent: (snapshot, id) => Object.values(snapshot.endpoints).find(endpoint => endpoint.agentId === id) ?? null,
    titleCaseName: value => value, buildBrokerReturnAddressForActor: () => ({} as any), isOperatorDeliveryTarget: () => false, isLocalScoutProductTarget: () => false,
    onlineConversationNotifyTargets: () => [],
    resolveBrokerDeliveryTargetWithImplicitProjectAgent: async payload => {
      const id = payload.target?.kind === "agent_id" ? payload.target.agentId : "worker";
      const endpoint = h.runtime.snapshot().endpoints[`endpoint-${id}`]!;
      return { kind: "resolved_session", session: { actorId: id, label: id, sessionId: endpoint.sessionId!, nodeId: "node", endpoint } };
    },
    describeUnavailableDeliveryTarget: () => null, recordDeliveryWorkItemIfNeeded: async () => ({ record: null }),
    acceptInvocation: async (request, message) => (await h.records.recordInvocation(request, { flight: flight(request), message })).flight,
    dispatchAcceptedInvocation: async () => { dispatches++; }, queueOperatorDeliveryIssue: () => {},
  } as any);
  const router = createBrokerHttpRouter({ host: "127.0.0.1", port: 1, nodeId: "node", meshId: "mesh", operatorActorId: "operator", runtime: h.runtime,
    deliveryReceiptsOwnedByService: true, deliveryAcceptanceService: acceptance, webControl: { corsHeaders: () => ({}) },
    brokerService: { deliver: (payload: any) => acceptance.accept(payload), postConversationMessage: (message: MessageRecord) => h.messages.postConversationMessage(message) },
  } as any);
  class Response extends EventEmitter { status = 0; body = ""; destroyed = false; writableEnded = false;
    writeHead(status: number) { this.status = status; } write(value: string) { this.body += value; } end(value = "") { this.body += value; this.writableEnded = true; }
  }
  async function post(path: string, body: unknown) {
    const request = Object.assign(new PassThrough(), { method: "POST", url: path, headers: { host: "localhost" } });
    const response = new Response(); const pending = router(request as any, response as any); request.end(JSON.stringify(body)); await pending;
    return { status: response.status, body: JSON.parse(response.body) };
  }
  const ask = { intent: "explicit_consult", requestId: "http-parent", requesterId: "operator", requesterNodeId: "node", body: "inspect",
    target: { kind: "agent_id", agentId: "worker" }, completion: { mode: "explicit" } };
  const accepted = await post("/v1/deliver", ask); expect(accepted.status).toBe(202);
  const parent = accepted.body.flight as FlightRecord;
  expect(flightCompletion(parent)?.revision).toBe(0); expect(dispatches).toBe(1);
  const message = { ...reply(), replyToMessageId: accepted.body.message.id, metadata: { completionReply: { kind: "progress", invocationId: parent.invocationId, flightId: parent.id, revision: 0 } } };
  expect((await post("/v1/messages/reply", message)).status).toBe(200);
  expect(h.journal.getFlight(parent.id)?.state).toBe("running");
  const child = await post("/v1/deliver", { ...ask, requestId: "http-child", requesterId: "worker", completion: undefined,
    target: { kind: "agent_id", agentId: "helper" }, relation: { parentFlightId: parent.id, kind: "joined" } });
  expect(child.status).toBe(202); expect(child.body.flight.metadata.parentCompletion).toEqual({ flightId: parent.id, revision: 1 });
  const final = { ...message, requestId: "final-request", metadata: { completionReply: { ...message.metadata.completionReply, kind: "final", revision: 1 } } };
  expect((await post("/v1/messages/reply", final)).status).toBe(400);
  await h.lifecycle.recordFlight({ ...child.body.flight, state: "failed", completedAt: 7 });
  expect(h.journal.getFlight(parent.id)?.state).toBe("running");
  expect((await post("/v1/messages/reply", final)).status).toBe(200);
  expect(h.journal.getFlight(parent.id)?.state).toBe("completed");
  const before = h.frames.length; expect((await post("/v1/messages/reply", final)).status).toBe(200);
  expect(h.frames.length).toBe(before); expect(dispatches).toBe(2);
  await h.reopen(); expect(h.journal.getFlight(parent.id)?.state).toBe("completed");
});
