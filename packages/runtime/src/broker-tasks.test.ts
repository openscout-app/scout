import { TaskClosedError } from "@openscout/protocol";
import { BrokerMeshHttpService } from "./broker-mesh-http-service.js";
import { forwardMeshMessage } from "./mesh-forwarding.js";
import { BrokerTaskService } from "./broker-tasks.js";
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
async function fixture(options: { nodeId?: string; authorize?: (invocation: InvocationRequest, message: MessageRecord) => boolean; mesh?: any } = {}) {
  const nodeId = options.nodeId ?? "node";
  const directory = await mkdtemp(join(tmpdir(), "scout-explicit-completion-")); dirs.push(directory);
  const path = join(directory, "journal.jsonl");
  let journal = new FileBackedBrokerJournal(path); await journal.load();
  let runtime = createInMemoryControlRuntime({}, { localNodeId: nodeId });
  let serial = Promise.resolve(), failApplyParent = false;
  const runWrite = <T>(work: () => Promise<T>): Promise<T> => { const result = serial.then(work); serial = result.then(() => {}, () => {}); return result; };
  const frames: BrokerJournalEntry[][] = [];
  const commitEntries = async (entries: BrokerJournalEntry | BrokerJournalEntry[], apply: (entries: BrokerJournalEntry[]) => Promise<void>) => {
    const list = Array.isArray(entries) ? entries : [entries]; await journal.appendEntries(list); frames.push(list); await apply(list); return list;
  };
  const durableStore = { runWrite, commitEntries, applyProjectedEntries: async () => {} };
  let records: BrokerDurableRecordStore, lifecycle: BrokerFlightLifecycleService, messages: BrokerMessageService;
  function configure() {
    records = new BrokerDurableRecordStore({ localNodeId: nodeId, authorizeReplyCompletion: options.authorize, runtime: {
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
    messages = new BrokerMessageService({ nodeId, authorizeReplyCompletion: options.authorize, systemActorId: "system", runtime, createId: prefix => prefix,
      mesh: options.mesh ?? { authorityNodeForConversation: () => null, forwardConversationMessageToAuthority: async () => { throw new Error("unexpected mesh"); }, forwardPeerBrokerDeliveries: async () => ({}) as any },
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
  return { accept, child, frames, runWrite, get runtime() { return runtime; }, get records() { return records; }, get lifecycle() { return lifecycle; }, get messages() { return messages; }, get journal() { return journal; },
    failParentApply() { failApplyParent = true; },
    async reopen() { journal = new FileBackedBrokerJournal(path); await journal.load(); runtime = createInMemoryControlRuntime(journal.snapshot(), { localNodeId: nodeId }); configure(); },
  };
}

async function taskFixture(state: FlightRecord["state"] = "running", extra: Record<string, unknown> = {}, beforePost?: () => Promise<void>) {
  const h = await fixture();
  const request = invocation("parent", { completion: undefined, taskVersion: 1, ...extra });
  await h.accept(request);
  if (state !== "running") await h.lifecycle.recordFlight({ ...h.runtime.flightForInvocation("parent")!, state,
    output: state === "completed" ? "earlier result" : undefined, completedAt: ["completed", "failed", "cancelled"].includes(state) ? 4 : undefined });
  const successors: any[] = [];
  let now = 100, interrupts = 0;
  const tasks = new BrokerTaskService({ nodeId: "node", operatorActorId: "operator", snapshot: () => h.runtime.snapshot(),
    openOperatorTasks: () => h.journal.openOperatorTasks(),
    invocation: id => h.journal.getInvocation(id), flight: id => h.journal.getFlight(id), currentFlight: id => h.journal.getCurrentFlightForInvocation(id),
    postMessage: async message => { await beforePost?.(); return h.messages.postConversationMessage(message); }, recordFlight: (flight, eligible) => h.lifecycle.recordFlight(flight, eligible),
    accept: async input => { successors.push(input); return { accepted: true } as any; },
    interrupt: async () => { interrupts++; return true; }, now: () => now });
  const ask = (patch: any = {}) => tasks.ask({ requestId: "followup", requesterId: "operator", target: { kind: "binding_ref", ref: "parent" },
    intent: "consult", body: "scope change", task: { version: 1, ref: "parent" }, ...patch });
  const answer = (patch: any = {}) => tasks.reply({ ref: "parent", senderId: "worker", requestId: "answer", body: "result", ...patch });
  return { h, tasks, ask, answer, successors, get interrupts() { return interrupts; }, setNow(value: number) { now = value; } };
}

test.each(["queued", "waking", "running", "waiting"] as const)("follow-up on %s creates no invocation and returns its own receipt", async state => {
  const { h, ask } = await taskFixture(state);
  const before = Object.keys(h.runtime.snapshot().invocations);
  const first = await ask(); expect(first).toMatchObject({ accepted: true, message: { body: "scope change" } });
  await ask(); expect(Object.keys(h.runtime.snapshot().invocations)).toEqual(before);
  expect(Object.values(h.runtime.peek().messages).filter(m => m.body === "scope change")).toHaveLength(1);
  expect(h.runtime.flightForInvocation("parent")?.state).toBe(state);
});
test.each(["completed", "failed", "cancelled"] as const)("%s rejects ref and permits an authorized successor with outcome context", async state => {
  const { ask, successors } = await taskFixture(state);
  await expect(ask()).rejects.toThrow("--continue parent");
  await ask({ task: { version: 1, continue: "parent" } });
  expect(successors).toHaveLength(1); expect(successors[0].body).toContain(`(${state})`);
  expect(successors[0].execution.session).toBe("new");
});
test("unfinished tasks reject continue; unauthorized follow-ups and cancellation fail", async () => {
  const { ask } = await taskFixture();
  await expect(ask({ task: { version: 1, continue: "parent" } })).rejects.toThrow("unfinished");
  await expect(ask({ requesterId: "stranger" })).rejects.toThrow("not authorized");
  await expect(ask({ requesterId: "worker", task: { version: 1, ref: "parent", cancel: true } })).rejects.toThrow("not authorized");
});
test("cancel explicitly closes work, reports interruption, and wins against a later final", async () => {
  const f = await taskFixture(); const receipt = await f.ask({ task: { version: 1, ref: "parent", cancel: true } });
  expect(receipt).toMatchObject({ message: { metadata: { workerInterrupted: true } }, flight: { state: "cancelled" } });
  expect(f.interrupts).toBe(1); await expect(f.answer()).rejects.toThrow("task was cancelled");
});
test("progress stays open, failed closes, stable request retries are idempotent", async () => {
  const { h, answer } = await taskFixture();
  await answer({ progress: true, requestId: "progress" }); expect(h.runtime.flightForInvocation("parent")?.state).toBe("running");
  await answer({ failed: true }); expect(h.runtime.flightForInvocation("parent")?.state).toBe("failed");
  await answer({ failed: true });
  await expect(answer({ requestId: "later" })).rejects.toThrow("already failed");
});
test("first final claims the writer before completion; automatic and explicit finals cannot both land", async () => {
  const { h } = await taskFixture();
  const first = { ...reply(), metadata: { ...reply().metadata, completionReply: undefined } };
  await h.records.recordMessage(first);
  await expect(h.messages.postConversationMessage(reply(0, "final", "second"))).rejects.toThrow("already has a final");
  expect(Object.values(h.runtime.peek().messages).filter(m => m.replyToMessageId === "ask-parent")).toHaveLength(1);
});
test("follow-up loses if completion reached the writer first", async () => {
  const { h, answer, ask } = await taskFixture(); await answer();
  await expect(ask()).rejects.toThrow("finished");
});
test("only recipient may answer; FYI handles reject task operations", async () => {
  const { h, tasks, answer } = await taskFixture();
  await expect(answer({ senderId: "operator" })).rejects.toThrow("current recipient");
  await h.records.recordMessage({ ...reply(), id: "msg-fyi", replyToMessageId: undefined, metadata: {}, body: "FYI" });
  await expect(tasks.resolve("msg-fyi")).rejects.toThrow("FYI has no task");
});
test("operator default deadlines recover after restart and later answers are marked late", async () => {
  const { h, tasks, answer, setNow } = await taskFixture("running", { humanOwned: true, defaultAction: "staging", operatorAnswerDeadline: 200 });
  await tasks.expireOperatorTasks(); expect(h.runtime.flightForInvocation("parent")?.state).toBe("running");
  await h.reopen(); setNow(201); await tasks.expireOperatorTasks();
  expect(h.runtime.flightForInvocation("parent")).toMatchObject({ state: "completed", metadata: { operatorOutcome: "proceeded_with_default" } });
  await answer(); expect(Object.values(h.runtime.peek().messages).some(m => m.metadata?.late === true)).toBe(true);
  expect(h.runtime.flightForInvocation("parent")?.output).toBe("Proceeded with default: staging");
});
test("blocking operator questions stay open even with legacy deadlines; answers complete normally", async () => {
  const first = await taskFixture("running", { humanOwned: true, operatorAnswerDeadline: 99 });
  await first.tasks.expireOperatorTasks(); expect(first.h.runtime.flightForInvocation("parent")?.state).toBe("running");
  first.setNow(10_000_000); await first.answer();
  expect(first.h.runtime.flightForInvocation("parent")?.state).toBe("completed");
  const second = await taskFixture("running", { humanOwned: true, operatorAnswerDeadline: 200 });
  await second.answer(); expect(second.h.runtime.flightForInvocation("parent")).toMatchObject({ state: "completed", metadata: { operatorOutcome: "answered" } });
});

test("cancel retries preserve interruption receipt after closure and restart", async () => {
  const f = await taskFixture();
  const payload = { task: { version: 1, ref: "parent", cancel: true } };
  const first = await f.ask(payload);
  await f.h.reopen();
  expect(await f.ask(payload)).toMatchObject({ receipt: (first as any).receipt, message: { metadata: { workerInterrupted: true } } });
  expect(f.interrupts).toBe(1);
  expect(await f.tasks.recoverFollowup("operator", "followup")).toMatchObject({ receipt: (first as any).receipt });
});

test("a committed harness result outbox can deliver after completion, but an explicit late final cannot", async () => {
  const { h, answer } = await taskFixture();
  const { createInvocationResultReplyIntent, invocationResultMessageId } = await import("./broker-invocation-result-delivery-service.js");
  const message = { ...reply(), id: invocationResultMessageId("parent"), metadata: { invocationId: "parent", flightId: "flight-parent" } };
  const intent = createInvocationResultReplyIntent("parent", message);
  await h.lifecycle.recordFlight({ ...h.runtime.flightForInvocation("parent")!, state: "completed",
    output: message.body, completedAt: message.createdAt, metadata: { resultReply: intent } });
  await h.messages.postConversationMessage(intent.message);
  await expect(answer()).rejects.toThrow("already completed");
  expect(Object.values(h.runtime.peek().messages).filter(m => m.replyToMessageId === "ask-parent")).toHaveLength(1);
});

test("canonical writer upgrades a stale queued follow-up to live-session delivery", async () => {
  const { h } = await taskFixture("running");
  const followup: MessageRecord = { ...reply(), id: "stale-followup", actorId: "operator", class: "status",
    audience: { delivery: "none" }, body: "new context", metadata: { taskFollowup: { invocationId: "parent" } } };
  await h.records.recordMessage(followup);
  expect(h.runtime.peek().messages[followup.id]?.audience).toMatchObject({ notify: ["worker"] });
});

test("old remote task homes fail locally with a capability diagnostic before forwarding", async () => {
  const { ask, answer } = await taskFixture("running", { taskHomeNodeId: "old-peer" });
  await expect(ask()).rejects.toThrow("ask-reply/1");
  await expect(answer()).rejects.toThrow("ask-reply/1");
});

test("successor launch overrides are separate from the predecessor route", async () => {
  const { ask, successors } = await taskFixture("completed");
  await ask({ task: { version: 1, continue: "parent", successor: { host: "build-peer", projectPath: "/project" } } });
  expect(successors[0]).toMatchObject({ target: { kind: "project_path", host: "build-peer", projectPath: "/project" },
    execution: { session: "new" }, invocationMetadata: { predecessorTaskId: "parent" } });
});


test.each(["reply", "cancel"])("refused completion does not claim an external task; later %s succeeds", async outcome => {
  const h = await fixture({ authorize: (_task, message) => message.id.startsWith("external-reply-") });
  await h.accept(invocation("parent", { completion: undefined, taskVersion: 1 }));
  await expect(h.messages.postConversationMessage(reply())).rejects.toThrow("completion_reply_not_authorized");
  expect(h.journal.getCurrentFlightForInvocation("parent")?.metadata?.taskFinalReplyMessageId).toBeUndefined();
  expect(h.runtime.peek().messages[reply().id]).toBeUndefined();
  await h.reopen();
  if (outcome === "reply") {
    await h.messages.postConversationMessage(reply(0, "final", "external-reply-legitimate"));
    expect(h.journal.getCurrentFlightForInvocation("parent")).toMatchObject({ state: "completed", metadata: { replyMessageId: "external-reply-legitimate" } });
  } else {
    await h.lifecycle.recordFlight({ ...h.journal.getCurrentFlightForInvocation("parent")!, state: "cancelled", completedAt: 4 });
    expect(h.journal.getCurrentFlightForInvocation("parent")?.state).toBe("cancelled");
  }
});

test("a typed final on a pre-upgrade task fences a racing harness result", async () => {
  const h = await fixture();
  await h.accept(invocation("parent", { completion: undefined }));
  await h.records.recordMessage(reply());
  await h.lifecycle.recordFlight({ ...flight(invocation()), state: "completed", output: "harness result", completedAt: 4 });
  expect(h.journal.getCurrentFlightForInvocation("parent")).toMatchObject({ state: "running", metadata: { taskFinalReplyMessageId: reply().id } });
  await h.messages.postConversationMessage(reply());
  expect(h.journal.getCurrentFlightForInvocation("parent")).toMatchObject({ state: "completed", output: "result", metadata: { replyMessageId: reply().id } });
  expect(Object.values(h.runtime.peek().messages).filter(m => m.replyToMessageId === "ask-parent")).toHaveLength(1);
});

test("two nodes deliver a versioned task's automatic result through conversation authority once", async () => {
  const authority = await fixture();
  const forwarded: MessageRecord[] = [];
  const worker = await fixture({ nodeId: "worker-node", mesh: {
    authorityNodeForConversation: () => ({ id: "node" }),
    forwardConversationMessageToAuthority: async (message: MessageRecord) => {
      forwarded.push(message);
      const result = await authority.messages.postConversationMessage(message);
      return { ...result, forwarded: true, authorityNodeId: "node" };
    }, forwardPeerBrokerDeliveries: async () => ({}) } });
  const task = invocation("parent", { completion: undefined, taskVersion: 1, taskHomeNodeId: "node" });
  await authority.accept(task); await worker.accept(task);
  const { createInvocationResultReplyIntent, BrokerInvocationResultDeliveryService } = await import("./broker-invocation-result-delivery-service.js");
  const intent = createInvocationResultReplyIntent(task.id, { ...reply(), metadata: { invocationId: task.id, flightId: "flight-parent" } });
  await worker.lifecycle.recordFlight({ ...flight(task), state: "completed", output: intent.message.body, completedAt: intent.message.createdAt, metadata: { resultReply: intent } });
  const outbox = new BrokerInvocationResultDeliveryService({ flightForInvocation: id => worker.journal.getCurrentFlightForInvocation(id),
    postMessage: worker.messages.postConversationMessage, markDelivered: async () => true });
  expect(await outbox.deliver(task.id)).toBe("delivered");
  await worker.messages.postConversationMessage(intent.message);
  expect(forwarded.every(message => !message.metadata?.completionReply)).toBe(true);
  expect(authority.journal.getCurrentFlightForInvocation(task.id)?.state).toBe("completed");
  expect(Object.values(authority.runtime.peek().messages).filter(m => m.replyToMessageId === task.messageId)).toHaveLength(1);
  expect(worker.runtime.peek().messages[intent.message.id]).toBeUndefined();
});


test("cross-host successor never borrows a local endpoint project", async () => {
  const { h, ask, successors } = await taskFixture("completed");
  const endpoint = h.runtime.peek().endpoints["endpoint-worker"]!;
  await h.runtime.upsertEndpoint({ ...endpoint, projectRoot: "/local-only-project" });
  await expect(ask({ task: { version: 1, continue: "parent", successor: { host: "peer" } } })).rejects.toThrow("requires --project");
  expect(successors).toHaveLength(0);
});


test("queued follow-up commits after dispatch's prompt read and is delivered to the running session", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const atPost = new Promise<void>(resolve => { entered = resolve; });
  const { h, ask } = await taskFixture("queued", {}, async () => { entered(); await gate; });
  const pending = ask();
  await atPost;
  await h.lifecycle.recordFlight({ ...h.runtime.flightForInvocation("parent")!, state: "running" });
  // Dispatch has already read the prompt, before this message reaches the writer.
  expect(Object.values(h.runtime.peek().messages).filter(m => m.metadata?.taskFollowup)).toHaveLength(0);
  release();
  await pending;
  const followup = Object.values(h.runtime.peek().messages).find(m => m.metadata?.taskFollowup)!;
  expect(followup.audience).toMatchObject({ notify: ["worker"] });
  expect(h.frames.flat().filter(entry => entry.kind === "message.record" && entry.message.id === followup.id))
    .toMatchObject([{ message: { audience: { notify: ["worker"] } } }]);
});

test("operator expiry reads only the open-task index, never a registry snapshot", async () => {
  const request = invocation("default", { humanOwned: true, defaultAction: "staging", operatorAnswerDeadline: 100 });
  let current: FlightRecord = flight(request), reads = 0;
  const tasks = new BrokerTaskService({ nodeId: "node", operatorActorId: "operator",
    snapshot: () => { throw new Error("expiry scanned registry"); },
    invocation: () => { throw new Error("expiry read historical invocation"); }, flight: () => undefined,
    currentFlight: () => { reads++; return current; },
    openOperatorTasks: () => current.state === "running" ? [request] : [],
    recordFlight: async value => { current = value; }, now: () => 200,
    postMessage: async () => {}, accept: async () => ({ accepted: true } as any),
  });
  await tasks.expireOperatorTasks();
  expect(current.state).toBe("completed");
  const after = reads;
  for (let i = 0; i < 10; i++) await tasks.expireOperatorTasks();
  expect(reads).toBe(after);
});


test("task suffixes need eight characters and ambiguous matches fail closed", async () => {
  const { h, tasks } = await taskFixture();
  for (const id of ["first", "second"]) {
    const request = invocation(id, { completion: undefined });
    await h.records.recordInvocation(request, { flight: flight(request, `${id}-abcdefgh`) });
  }
  await expect(tasks.resolve("abcdefgh")).rejects.toThrow("ambiguous task");
  await expect(tasks.resolve("bcdefgh")).rejects.toThrow("unknown task");
  expect((await tasks.resolve("first-abcdefgh")).invocation.id).toBe("first");
});

test.each(["explicit", "cancel", "claimed"])("remote %s supersedes an automatic result durably without retrying it", async winner => {
  const authority = await fixture();
  const ingress = new BrokerMeshHttpService({ nodeId: "node", runtime: authority.runtime,
    runDurableWrite: authority.runWrite, applyMeshBundle: async () => [], applyProjectedEntries: async () => {},
    recordAuthorityMessage: message => authority.records.recordMessageUnderWriter(message, { dedupeExisting: true }),
    messageFor: async id => authority.runtime.peek().messages[id],
    completeInvocationsForBrokerReply: authority.messages.completeInvocationsForBrokerReply,
  } as any);
  let attempts = 0, offline = true;
  const worker = await fixture({ nodeId: "worker-node", mesh: {
    authorityNodeForConversation: () => ({ id: "node" }),
    forwardConversationMessageToAuthority: async (message: MessageRecord) => {
      attempts++;
      if (offline) throw new Error("authority offline");
      const result = await forwardMeshMessage("http://authority.test", {
        originNode: { id: "worker-node" }, actors: [], agents: [], bindings: [],
        conversation: authority.runtime.peek().conversations[message.conversationId]!, message,
      } as any, { peerFetch: async (_base, _path, init) => {
        try {
          const accepted = await ingress.receiveMessageBundle(JSON.parse(init!.body as string));
          return Response.json(accepted.body, { status: accepted.status });
        } catch (error) {
          if (error instanceof TaskClosedError) return Response.json(error.toJSON(), { status: 409 });
          throw error;
        }
      } });
      return { ...result, forwarded: true, authorityNodeId: "node" };
    }, forwardPeerBrokerDeliveries: async () => ({}) } });
  const task = invocation("parent", { completion: undefined, taskVersion: 1, taskHomeNodeId: "node" });
  await authority.accept(task); await worker.accept(task);
  const { createInvocationResultReplyIntent, BrokerInvocationResultDeliveryService } = await import("./broker-invocation-result-delivery-service.js");
  const intent = createInvocationResultReplyIntent(task.id, { ...reply(), metadata: { invocationId: task.id, flightId: "flight-parent" } });
  await worker.lifecycle.recordFlight({ ...flight(task), state: "completed", output: intent.message.body, completedAt: intent.message.createdAt, metadata: { resultReply: intent } });
  const makeOutbox = () => new BrokerInvocationResultDeliveryService({
    flightForInvocation: (id: string) => worker.journal.getCurrentFlightForInvocation(id),
    postMessage: worker.messages.postConversationMessage,
    markDelivered: async () => { throw new Error("refused output must not be delivered"); },
    markSuperseded: async (_id: string, _expected: unknown, refusal: unknown) => {
      const current = worker.journal.getCurrentFlightForInvocation(task.id)!;
      const updated = { ...current, metadata: { ...current.metadata, resultReply: { ...intent, status: "superseded", refusal } } };
      await worker.journal.appendEntries({ kind: "flight.record", flight: updated });
      await worker.runtime.upsertFlight(updated); return true;
    },
  } as any);
  const outbox = makeOutbox();
  expect(await outbox.deliver(task.id)).toBe("failed"); // Network failure stays pending.
  if (winner === "explicit") await authority.messages.postConversationMessage(reply(0, "final", "explicit-winner"));
  else if (winner === "claimed") await authority.records.recordMessage(reply(0, "final", "claimed-winner"));
  else await authority.lifecycle.recordFlight({ ...flight(task), state: "cancelled", completedAt: 4 });
  offline = false;
  expect(await outbox.deliver(task.id)).toBe("superseded");
  expect(attempts).toBe(2);
  expect(worker.journal.getCurrentFlightForInvocation(task.id)?.metadata?.resultReply).toMatchObject({ status: "superseded",
    refusal: { error: "task_closed", taskId: task.id, messageId: intent.message.id } });
  await worker.reopen();
  const restarted = makeOutbox();
  expect(restarted.recover(worker.journal.pendingInvocationResultFlights()).scheduled).toBe(0);
  expect(await restarted.deliver(task.id)).toBe("stale");
  expect(attempts).toBe(2);
});
