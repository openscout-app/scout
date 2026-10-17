import { describe, expect, test } from "bun:test";
import type { AgentEndpoint, CollaborationRecord, DeliveryIntent, FlightRecord, InvocationRequest, MessageRecord } from "@openscout/protocol";
import { runtimeSessionHandleForEndpoint } from "../runtime-session-handle.js";
import { T3Adapter, t3ScopedId } from "./adapter.js";
import { BrokerT3Service, pendingT3Attention, type BrokerT3ServiceOptions } from "./broker-service.js";
import { T3RpcError } from "./rpc-client.js";

type SourceThread = Awaited<ReturnType<T3Adapter["thread"]>>;
type Start = Parameters<T3Adapter["start"]>[1];
const NOW = "2026-10-17T20:00:00.000Z";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const endpoint: AgentEndpoint = { id: "endpoint", agentId: "t3-actor", nodeId: "node", harness: "bridge", transport: "http", state: "idle",
    sessionId: "t3:local:project:thread", metadata: { t3Session: true, connectionId: "local", projectId: "project", nativeSessionId: "thread" } };
  const invocation: InvocationRequest = { id: "flight", requesterId: "human", requesterNodeId: "node", targetAgentId: endpoint.agentId,
    action: "execute", task: "Compute a result", ensureAwake: true, stream: false, createdAt: Date.parse(NOW),
    conversationId: "conversation", messageId: "source-request", execution: { targetSessionId: runtimeSessionHandleForEndpoint(endpoint)! } };
  const flights = new Map<string, FlightRecord>();
  const initial = (id: string) => ({ id, invocationId: id, requesterId: invocation.requesterId, targetAgentId: endpoint.agentId, state: "running" as const });
  flights.set(invocation.id, initial(invocation.id));
  const deliveries = new Map<string, DeliveryIntent>();
  const work = new Map<string, CollaborationRecord>();
  const messages: MessageRecord[] = [];
  const transitions: FlightRecord[] = [];
  const starts: Start[] = [];
  const calls: Array<{ method: string; payload: unknown }> = [];
  const events: string[] = [];
  let thread: SourceThread = { id: "thread", projectId: "project", title: "T3 thread", runtimeMode: "approval-required", interactionMode: "default",
    modelSelection: { instanceId: "codex", model: "configured-model" }, session: { status: "idle" }, messages: [], activities: [], latestTurn: null };
  let onStart: (input: Start, signal?: AbortSignal) => void | Promise<void> = () => {};
  let onThread: () => SourceThread | Promise<SourceThread> = () => thread;
  let onFlight: (flight: FlightRecord) => void = () => {};
  let onCall: (method: string, payload: unknown) => unknown | Promise<unknown> = () => ({});
  const adapter = {
    thread: async () => onThread(),
    start: async (_thread: SourceThread, input: Start, signal?: AbortSignal) => { events.push("submit"); starts.push(input); await onStart(input, signal); return {}; },
    call: async (method: string, payload: unknown) => { calls.push({ method, payload }); return onCall(method, payload); },
  } as unknown as T3Adapter;
  const options: BrokerT3ServiceOptions = { nodeId: "node", adapter: () => adapter, pollMs: 1, cancellationReconcileMs: 30,
    endpoints: () => [endpoint], persistActor: async () => {}, persistEndpoint: async () => {},
    work: id => work.get(id), recordWork: async record => { work.set(record.id, record); },
    delivery: id => deliveries.get(id), recordDelivery: async delivery => { events.push("persist"); deliveries.set(delivery.id, delivery); },
    mutateDelivery: async (id, update) => { const current = deliveries.get(id); if (!current) return; const next = update(current); if (next) deliveries.set(id, next); return next ?? undefined; },
    flight: id => flights.get(id), recordFlight: async flight => { flights.set(flight.id, flight); transitions.push(flight); onFlight(flight); },
    postMessage: async message => { events.push("reply"); messages.push(message); },
  };
  const service = new BrokerT3Service(options);
  const receiptId = t3ScopedId("t3-invocation", invocation.id);
  const snapshotFor = (input: Start, patch: Partial<SourceThread> = {}) => ({ ...thread,
    messages: [{ id: input.messageId, role: "user", text: input.text, turnId: null, createdAt: input.createdAt },
      { id: "final", role: "assistant", text: "Correlated result", streaming: false, turnId: "turn" }],
    latestTurn: { turnId: "turn", state: "completed", assistantMessageId: "final", requestedAt: input.createdAt }, ...patch });
  return { service, options, endpoint, invocation, flights, deliveries, messages, transitions, starts, calls, events, initial, receiptId, snapshotFor,
    get thread() { return thread; }, set thread(value: SourceThread) { thread = value; },
    onStart(fn: typeof onStart) { onStart = fn; }, onFlight(fn: typeof onFlight) { onFlight = fn; },
    onThread(fn: typeof onThread) { onThread = fn; },
    onCall(fn: typeof onCall) { onCall = fn; },
    stop(id = invocation.id) { flights.set(id, { ...flights.get(id)!, state: "cancelled" }); },
  };
}

describe("broker T3 source reconciliation", () => {
  test("scopes an attached session handle to its T3 environment", async () => {
    const f = fixture();
    const first = await f.service.attach("local", "thread");
    const second = await f.service.attach("other-environment", "thread");
    expect(first.endpointId).not.toBe(second.endpointId);
    expect(first.sessionId).not.toBe(second.sessionId);
  });

  test("persists the send attempt before dispatch and completes from the exact requested timestamp", async () => {
    const f = fixture();
    f.onStart(input => {
      expect(f.events).toEqual(["persist", "submit"]);
      expect(f.deliveries.get(f.receiptId)?.metadata).toMatchObject({ phase: "submitting", messageId: input.messageId, requestedAt: input.createdAt });
      f.thread = f.snapshotFor(input);
    });
    await f.service.dispatch(f.invocation, f.endpoint);
    expect(f.starts).toHaveLength(1);
    expect(f.flights.get("flight")).toMatchObject({ state: "completed", output: "Correlated result" });
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]).toMatchObject({ actorId: "t3-actor", conversationId: "conversation", replyToMessageId: "source-request", body: "Correlated result" });
    expect(f.deliveries.get(f.receiptId)).toMatchObject({ status: "completed", metadata: { phase: "replied", turnId: "turn" } });
  });

  test("does not use a newer foreign turn when the submitted message has no provider turn ID", async () => {
    const f = fixture();
    f.onStart(input => { f.thread = f.snapshotFor(input, { latestTurn: { turnId: "foreign", state: "completed", assistantMessageId: "final", requestedAt: "2026-10-17T21:00:00.000Z" } }); });
    f.onFlight(flight => { if (flight.state === "waiting") f.stop(); });
    await f.service.dispatch(f.invocation, f.endpoint);
    expect(f.messages).toHaveLength(0);
    expect(f.transitions.some(flight => flight.state === "completed")).toBe(false);
  });

  test("correlates the exact source message when T3 rewrites its accepted timestamp", async () => {
    const f = fixture();
    f.onStart(input => {
      const acceptedAt = new Date(Date.parse(input.createdAt) + 7).toISOString();
      f.thread = f.snapshotFor(input, {
        messages: [{ id: input.messageId, role: "user", text: input.text, turnId: null, createdAt: acceptedAt },
          { id: "final", role: "assistant", text: "Accepted source result", streaming: false, turnId: "turn" }],
        latestTurn: { turnId: "turn", state: "completed", assistantMessageId: "final", requestedAt: acceptedAt },
      });
    });
    // A regression must terminate with a visible failure instead of leaving its poll loop alive.
    f.onFlight(flight => { if (flight.state === "waiting") f.stop(); });
    await f.service.dispatch(f.invocation, f.endpoint);
    expect(f.flights.get("flight")).toMatchObject({ state: "completed", output: "Accepted source result" });
    expect(f.messages).toHaveLength(1);
  });

  test("a foreign user message with the same timestamp cannot satisfy the exact submitted identity", async () => {
    const f = fixture();
    f.onStart(input => { f.thread = f.snapshotFor(input, { messages: [
      { id: "foreign-user", role: "user", text: input.text, turnId: null, createdAt: input.createdAt },
      { id: "final", role: "assistant", text: "Foreign result", streaming: false, turnId: "turn" },
    ] }); });
    f.onFlight(flight => { if (flight.summary?.includes("has not exposed the exact submitted message")) f.stop(); });
    await f.service.dispatch(f.invocation, f.endpoint);
    expect(f.messages).toHaveLength(0);
    expect(f.transitions.some(flight => flight.state === "completed")).toBe(false);
  });

  test("does not accept an assistant final from another turn", async () => {
    const f = fixture();
    f.onStart(input => {
      f.thread = f.snapshotFor(input, { messages: [{ id: input.messageId, role: "user", turnId: "turn" },
        { id: "final", role: "assistant", text: "Foreign result", streaming: false, turnId: "foreign" }] });
    });
    f.onFlight(flight => { if (flight.state === "waiting") f.stop(); });
    await f.service.dispatch(f.invocation, f.endpoint);
    expect(f.messages).toHaveLength(0);
    expect(f.transitions.some(flight => flight.state === "completed")).toBe(false);
  });

  test.each([["error", "failed"], ["interrupted", "cancelled"]] as const)("maps correlated provider %s to %s", async (sourceState, flightState) => {
    const f = fixture();
    f.onStart(input => { f.thread = f.snapshotFor(input, { latestTurn: { turnId: "turn", state: sourceState, requestedAt: input.createdAt } }); });
    await f.service.dispatch(f.invocation, f.endpoint);
    expect(f.flights.get("flight")).toMatchObject({ state: flightState, error: `t3_turn_${sourceState}` });
    expect(f.messages).toHaveLength(0);
  });

  test("surfaces a source decision for the correlated turn", async () => {
    const f = fixture();
    f.onStart(input => {
      f.thread = f.snapshotFor(input, { latestTurn: { turnId: "turn", state: "running", requestedAt: input.createdAt },
        activities: [{ kind: "approval.requested", turnId: "turn", summary: "Allow file write", payload: { requestId: "approval" } },
          { kind: "user-input.requested", turnId: "foreign", summary: "Foreign question", payload: { requestId: "foreign" } }] });
    });
    f.onFlight(flight => { if (flight.metadata?.t3Attention) f.stop(); });
    await f.service.dispatch(f.invocation, f.endpoint);
    expect(f.transitions.find(flight => Array.isArray(flight.metadata?.t3Attention))).toMatchObject({ state: "waiting", metadata: {
      t3TurnId: "turn", t3Attention: [{ requestId: "approval", kind: "approval.requested", summary: "Allow file write" }],
    } });
  });

  test("recovery reconciles an uncertain submission without sending the mutation again", async () => {
    const f = fixture();
    f.onStart(() => { throw new Error("connection dropped after send"); });
    f.onFlight(flight => { if (flight.summary?.includes("has not exposed the exact submitted message")) f.stop(); });
    await f.service.dispatch(f.invocation, f.endpoint);
    expect(f.starts).toHaveLength(1);
    expect(f.deliveries.get(f.receiptId)?.metadata?.phase).toBe("submitting");
    f.flights.set("flight", f.initial("flight"));
    f.thread = f.snapshotFor(f.starts[0]!);
    const completed = deferred<void>();
    f.onFlight(flight => { if (flight.state === "completed") completed.resolve(); });
    const recovered = new BrokerT3Service(f.options);
    recovered.recover([f.invocation]);
    await completed.promise;
    expect(f.starts).toHaveLength(1);
    expect(f.messages).toHaveLength(1);
    expect(f.flights.get("flight")?.state).toBe("completed");
  });

  test("replays a durably captured final response after reply persistence fails and T3 advances", async () => {
    const f = fixture();
    f.onStart(input => { f.thread = f.snapshotFor(input); });
    const post = f.options.postMessage;
    f.options.postMessage = async () => { throw new Error("Scout reply persistence interrupted"); };
    f.onFlight(flight => { if (flight.summary?.includes("T3 is unavailable")) f.stop(); });
    await f.service.dispatch(f.invocation, f.endpoint);
    expect(f.deliveries.get(f.receiptId)?.metadata).toMatchObject({ resultBody: "Correlated result", turnId: "turn" });
    expect(f.messages).toHaveLength(0);
    f.thread = { ...f.thread, messages: [], latestTurn: { turnId: "newer", requestedAt: "2026-10-17T21:00:00.000Z", state: "completed" } };
    f.options.postMessage = post;
    f.flights.set("flight", f.initial("flight"));
    await new BrokerT3Service(f.options).dispatch(f.invocation, f.endpoint);
    expect(f.starts).toHaveLength(1);
    expect(f.messages).toHaveLength(1);
    expect(f.flights.get("flight")).toMatchObject({ state: "completed", output: "Correlated result" });
  });

  test("recovers a known terminal turn after latestTurn advances using the persisted terminal proof", async () => {
    const f = fixture();
    let input: Start | undefined;
    f.onStart(value => {
      input = value;
      f.thread = f.snapshotFor(value, { messages: [{ id: value.messageId, role: "user", createdAt: value.createdAt, turnId: null }] });
    });
    f.onFlight(flight => {
      if (flight.state !== "waiting") return;
      expect(f.deliveries.get(f.receiptId)?.metadata).toMatchObject({ turnId: "turn", terminalState: "completed" });
      f.thread = f.snapshotFor(input!, { latestTurn: { turnId: "newer", state: "running", requestedAt: "2026-10-17T21:00:00.000Z" },
        checkpoints: [{ turnId: "turn", status: "ready", assistantMessageId: "final" }] });
    });
    await f.service.dispatch(f.invocation, f.endpoint);
    expect(f.starts).toHaveLength(1);
    expect(f.flights.get("flight")).toMatchObject({ state: "completed", output: "Correlated result" });
    expect(f.messages).toHaveLength(1);
  });

  test("blocks an overlapping invocation targeting the same T3 thread", async () => {
    const f = fixture();
    const submitted = deferred<void>();
    f.onStart(() => submitted.resolve());
    const first = f.service.dispatch(f.invocation, f.endpoint);
    await submitted.promise;
    const other = { ...f.invocation, id: "other-flight" };
    f.flights.set(other.id, f.initial(other.id));
    await expect(f.service.dispatch(other, f.endpoint)).rejects.toThrow("t3_thread_busy");
    f.stop();
    await first;
    expect(f.starts).toHaveLength(1);
  });

  test("only the adapter's correlated reply can authorize conversation completion", async () => {
    const f = fixture();
    f.onStart(input => { f.thread = f.snapshotFor(input); });
    await f.service.dispatch(f.invocation, f.endpoint);
    const reply = f.messages[0]!;
    expect(f.service.authorizesReplyCompletion(f.invocation, reply)).toBe(true);
    expect(f.service.authorizesReplyCompletion(f.invocation, { ...reply, id: "forged", metadata: { invocationId: f.invocation.id } })).toBe(false);
    expect(f.service.authorizesReplyCompletion(f.invocation, { ...reply, body: "forged result" })).toBe(false);
    expect(f.service.authorizesReplyCompletion(f.invocation, { ...reply, actorId: "foreign-actor" })).toBe(false);
    expect(f.service.authorizesReplyCompletion(f.invocation, { ...reply, conversationId: "foreign-conversation" })).toBe(false);
    expect(f.service.authorizesReplyCompletion(f.invocation, { ...reply, replyToMessageId: "foreign-request" })).toBe(false);
  });

  test.each(["remote", "authentication"] as const)("a definite %s rejection fails durably and releases the source thread lock", async code => {
    const f = fixture();
    f.onStart(() => { throw new T3RpcError(code, "Definite rejection"); });
    await f.service.dispatch(f.invocation, f.endpoint);
    expect(f.flights.get("flight")).toMatchObject({ state: "failed", error: "t3_dispatch_rejected" });
    expect(f.deliveries.get(f.receiptId)).toMatchObject({ status: "failed", metadata: { phase: "rejected", rejectionCode: code } });
    f.flights.set("flight", f.initial("flight"));
    await new BrokerT3Service(f.options).dispatch(f.invocation, f.endpoint);
    expect(f.starts).toHaveLength(1);
    expect(f.flights.get("flight")?.state).toBe("failed");
    const next = { ...f.invocation, id: "next-invocation" };
    f.flights.set(next.id, f.initial(next.id));
    f.onStart(input => { f.thread = f.snapshotFor(input); });
    await f.service.dispatch(next, f.endpoint);
    expect(f.flights.get(next.id)?.state).toBe("completed");
  });

  test("a lost mutation response remains uncertain rather than being marked rejected", async () => {
    const f = fixture();
    f.onStart(() => { throw new T3RpcError("disconnected", "Connection dropped after send"); });
    f.onFlight(flight => { if (flight.summary?.includes("has not exposed the exact submitted message")) f.stop(); });
    await f.service.dispatch(f.invocation, f.endpoint);
    expect(f.deliveries.get(f.receiptId)).toMatchObject({ status: "sent", metadata: { phase: "submitting" } });
    expect(f.transitions.some(flight => flight.state === "failed")).toBe(false);
  });
});

function cancelledFixture() {
  const f = fixture();
  const sourceMessageId = t3ScopedId("scout-message", f.invocation.id);
  const input = { commandId: "original-command", messageId: sourceMessageId, text: f.invocation.task, createdAt: NOW };
  f.deliveries.set(f.receiptId, { id: f.receiptId, invocationId: f.invocation.id, targetId: f.endpoint.agentId, targetNodeId: "node",
    targetKind: "agent", transport: "http", reason: "invocation", policy: "durable", status: "acknowledged",
    metadata: { messageId: sourceMessageId, threadId: "thread", projectId: "project", connectionId: "local" } });
  f.thread = f.snapshotFor(input, { latestTurn: { turnId: "turn", state: "running", requestedAt: NOW } });
  f.stop();
  return f;
}

describe("T3 exact source cancellation", () => {
  test("cancellation during the persisted running update prevents starting a source turn", async () => {
    const f = fixture();
    let cancellation: Promise<void> | undefined;
    f.onFlight(flight => {
      if (flight.summary === "Submitting to the attached T3 thread.") {
        f.stop();
        cancellation = f.service.cancel(f.invocation);
      }
    });
    await f.service.dispatch(f.invocation, f.endpoint);
    await cancellation;
    expect(f.starts).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
    expect(f.deliveries.get(f.receiptId)?.metadata).toMatchObject({ phase: "cancelled_before_submission", cancellation: { state: "not_submitted" } });
  });

  test("cancels a delayed source RPC before its WebSocket request is written", async () => {
    const f = fixture();
    const starting = deferred<void>();
    f.onStart((_input, signal) => new Promise<void>((_resolve, reject) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      starting.resolve();
      signal!.addEventListener("abort", () => reject(new T3RpcError("aborted", "Cancelled before write", { requestSent: false })), { once: true });
    }));
    const dispatch = f.service.dispatch(f.invocation, f.endpoint);
    await starting.promise;
    f.stop();
    await f.service.cancel(f.invocation);
    await dispatch;
    expect(f.calls).toHaveLength(0);
    expect(f.deliveries.get(f.receiptId)?.metadata).toMatchObject({ phase: "cancelled_before_submission", cancellation: { state: "not_submitted" } });
  });

  test("reconciles delayed acceptance after an aborted sent request before interrupting its exact turn", async () => {
    const f = fixture();
    const starting = deferred<void>();
    let accepted: SourceThread | undefined;
    let reads = 0;
    f.onStart((input, signal) => new Promise<void>((_resolve, reject) => {
      accepted = f.snapshotFor(input, { latestTurn: { turnId: "turn", state: "running", requestedAt: input.createdAt } });
      starting.resolve();
      signal!.addEventListener("abort", () => reject(new T3RpcError("aborted", "Request sent before abort", { requestSent: true })), { once: true });
    }));
    f.onThread(() => accepted && ++reads >= 3 ? accepted : f.thread);
    const dispatch = f.service.dispatch(f.invocation, f.endpoint);
    await starting.promise;
    f.stop();
    await f.service.cancel(f.invocation);
    await dispatch;
    expect(reads).toBe(3);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ method: "orchestration.dispatchCommand", payload: { type: "thread.turn.interrupt", threadId: "thread", turnId: "turn" } });
    expect(f.deliveries.get(f.receiptId)?.metadata?.cancellation).toMatchObject({ state: "submitted", turnId: "turn" });
  });

  test("persists an interrupt attempt before sending only the correlated active turn", async () => {
    const f = cancelledFixture();
    f.onCall((method, payload) => {
      expect(method).toBe("orchestration.dispatchCommand");
      expect(payload).toMatchObject({ type: "thread.turn.interrupt", threadId: "thread", turnId: "turn", commandId: t3ScopedId("scout-interrupt", "flight") });
      expect(f.deliveries.get(f.receiptId)?.metadata?.cancellation).toMatchObject({ state: "submission_unknown", turnId: "turn" });
    });
    // Recording cancellation metadata can re-enter the broker's terminal hook.
    f.onFlight(() => { void f.service.cancel(f.invocation); });
    await f.service.cancel(f.invocation);
    expect(f.calls).toHaveLength(1);
    expect(f.flights.get("flight")).toMatchObject({ state: "cancelled", metadata: { t3Cancellation: { state: "submitted", turnId: "turn" } } });
  });

  test("does not interrupt a newer native turn when only an older binding is owned", async () => {
    const f = cancelledFixture();
    const receipt = f.deliveries.get(f.receiptId)!;
    receipt.metadata = { ...receipt.metadata, turnId: "turn" };
    f.thread = { ...f.thread, latestTurn: { turnId: "foreign", state: "running", requestedAt: "2026-10-17T21:00:00.000Z" } };
    await f.service.cancel(f.invocation);
    expect(f.calls).toHaveLength(0);
    expect(f.deliveries.get(f.receiptId)?.metadata?.cancellation).toMatchObject({ state: "unconfirmed" });
  });

  test("does not interrupt a thread whose source project no longer matches the attachment", async () => {
    const f = cancelledFixture();
    f.thread = { ...f.thread, projectId: "foreign-project" };
    await f.service.cancel(f.invocation);
    expect(f.calls).toHaveLength(0);
    expect(f.deliveries.get(f.receiptId)?.metadata?.cancellation).toMatchObject({ state: "unconfirmed" });
  });

  test("does not replay an uncertain native interrupt after cancellation recovery", async () => {
    const f = cancelledFixture();
    f.onCall(() => { throw new Error("connection lost after interrupt send"); });
    await f.service.cancel(f.invocation);
    await f.service.cancel(f.invocation);
    await new BrokerT3Service(f.options).cancel(f.invocation);
    expect(f.calls).toHaveLength(1);
    expect(f.deliveries.get(f.receiptId)?.metadata?.cancellation).toMatchObject({ state: "submission_unknown", turnId: "turn" });
  });

  test("a source turn already interrupted does not generate another interrupt", async () => {
    const f = cancelledFixture();
    f.thread = { ...f.thread, latestTurn: { turnId: "turn", state: "interrupted", requestedAt: NOW } };
    await f.service.cancel(f.invocation);
    expect(f.calls).toHaveLength(0);
    expect(f.deliveries.get(f.receiptId)?.metadata?.cancellation).toMatchObject({ state: "source_already_terminal", turnId: "turn", sourceState: "interrupted" });
  });

  test("requires native board cancellation to stop later workflow stages", async () => {
    const f = cancelledFixture();
    f.endpoint.metadata = { ...f.endpoint.metadata, t3CardId: "card" };
    await f.service.cancel(f.invocation);
    expect(f.calls).toHaveLength(0);
    expect(f.deliveries.get(f.receiptId)?.metadata?.cancellation).toMatchObject({ state: "native_workflow_requires_t3" });
  });

  test("concurrent cancellation hooks submit the native interrupt at most once", async () => {
    const f = cancelledFixture();
    await Promise.all([f.service.cancel(f.invocation), f.service.cancel(f.invocation)]);
    expect(f.calls).toHaveLength(1);
  });
});

describe("T3 source attention", () => {
  test("clears only resolved source requests and preserves different pending requests", () => {
    expect(pendingT3Attention({ activities: [
      { kind: "approval.requested", turnId: "turn", summary: "Approve", payload: { requestId: "a" } },
      { kind: "user-input.requested", turnId: "turn", summary: "Choose", payload: { requestId: "b" } },
      { kind: "approval.resolved", turnId: "turn", payload: { requestId: "a" } },
      { kind: "approval.requested", turnId: "foreign", payload: { requestId: "c" } },
    ] }, "turn")).toEqual([{ requestId: "b", kind: "user-input.requested", summary: "Choose" }]);
  });
});
