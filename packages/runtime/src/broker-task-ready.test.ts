import { describe, expect, test } from "bun:test";

import type { CollaborationEvent, FlightRecord, InvocationRequest, WorkItemRecord } from "@openscout/protocol";

import {
  BrokerTaskReadyService,
  TaskReadyError,
  TaskReadyNotifier,
  planContinuedWorkItem,
  planReadyWorkItem,
  prepareTaskReady,
  taskReadyEntered,
} from "./broker-task-ready.js";

const context = { operatorActorId: "operator", nodeId: "node-1", now: 500 };
const mark = { readyNotify: { on: true, byId: "operator", at: 100 } };

function invocation(input: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    id: "inv-1", requesterId: "operator", requesterNodeId: "node-1", targetAgentId: "agent-1",
    action: "consult", task: "do it", collaborationRecordId: "work-1", conversationId: "conv-1",
    messageId: "msg-1", ensureAwake: true, stream: false, createdAt: 100,
    metadata: { taskVersion: 1, taskHomeNodeId: "node-1", ...mark }, ...input,
  };
}

function flight(input: Partial<FlightRecord> = {}): FlightRecord {
  return { id: "flt-1", invocationId: "inv-1", requesterId: "operator", targetAgentId: "agent-1",
    state: "running", startedAt: 100, ...input };
}

function work(input: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return { id: "work-1", kind: "work_item", state: "working", acceptanceState: "none", title: "Do it",
    createdById: "operator", ownerId: "agent-1", nextMoveOwnerId: "agent-1", createdAt: 100, updatedAt: 100, ...input };
}

describe("prepareTaskReady", () => {
  test("leaves an unmarked task alone", () => {
    const done = flight({ state: "completed", completedAt: 400, output: "Done." });
    expect(prepareTaskReady(undefined, done, invocation({ metadata: {} }), context)).toBe(done);
  });

  test("writes Ready when a marked flight completes, with the summary line and the operator's move", () => {
    const done = flight({ state: "completed", completedAt: 400, output: "## Result\n\nShipped the **fix** in `a.ts`.\n\nMore detail." });
    const next = prepareTaskReady(flight(), done, invocation(), context);
    expect(next.metadata).toEqual(expect.objectContaining({
      ready: { state: "ready", at: 500, summary: "Shipped the fix in a.ts.", nodeId: "node-1" },
      nextMoveOwnerId: "operator",
    }));
    expect(taskReadyEntered(flight(), next)).toBe(true);
  });

  test("writes Ready for a reply waiting on review, not for a question or permission wait", () => {
    const review = flight({ state: "waiting", metadata: { waitingOn: { kind: "review", summary: "PR is up for review.", since: 400 } } });
    expect(prepareTaskReady(flight(), review, invocation(), context).metadata?.ready).toEqual(
      expect.objectContaining({ summary: "PR is up for review." }));
    const question = flight({ state: "waiting", metadata: { waitingOn: { kind: "question", summary: "Which branch?", since: 400 } } });
    expect(prepareTaskReady(flight(), question, invocation(), context).metadata?.ready).toBeUndefined();
  });

  test("a mark set later on the flight wins over the ask", () => {
    const off = flight({ state: "completed", output: "Done.", metadata: { readyNotify: { on: false, byId: "operator", at: 300 } } });
    expect(prepareTaskReady(undefined, off, invocation(), context).metadata?.ready).toBeUndefined();
    const on = flight({ state: "completed", output: "Done.", metadata: { readyNotify: { on: true, byId: "agent-2", at: 300 } } });
    expect(prepareTaskReady(undefined, on, invocation({ metadata: {} }), context).metadata?.ready).toBeDefined();
  });

  test("keeps the mark and Ready across a writer's stale copy, and writes Ready once", () => {
    const ready = { state: "ready", at: 450, summary: "Done.", nodeId: "node-1", heldAt: 480 };
    const stored = flight({ state: "completed", output: "Done.", metadata: { ...mark, ready } });
    const stale = flight({ state: "completed", output: "Done.", metadata: { other: 1 } });
    const next = prepareTaskReady(stored, stale, invocation({ metadata: {} }), context);
    expect(next.metadata).toEqual(expect.objectContaining({ other: 1, readyNotify: mark.readyNotify, ready }));
    expect(taskReadyEntered(stored, next)).toBe(false);
  });
});

describe("Ready rounds and homes", () => {
  test("only the task's home runtime writes Ready", () => {
    const done = flight({ state: "completed", output: "Done." });
    expect(prepareTaskReady(flight(), done, invocation({ metadata: { ...mark, taskHomeNodeId: "node-2" } }), context).metadata?.ready).toBeUndefined();
  });

  test("after Continue, the same flight finishing again is a new round of Ready", () => {
    const continued = { state: "continued", at: 450, summary: "First.", nodeId: "node-1", continuedAt: 470 };
    const running = flight({ state: "running", metadata: { ...mark, ready: continued } });
    const again = flight({ state: "completed", output: "Second pass done.", metadata: { ...mark, ready: continued } });
    const next = prepareTaskReady(running, again, invocation(), { ...context, now: 600 });
    expect(next.metadata?.ready).toEqual({ state: "ready", at: 600, summary: "Second pass done.", nodeId: "node-1" });
    expect(taskReadyEntered(running, next)).toBe(true);
    // Enrichment of an already finished flight does not start another round.
    expect(prepareTaskReady(again, again, invocation(), context).metadata?.ready).toEqual(continued);
  });
});

describe("TaskReadyNotifier", () => {
  function notifier(open = false) {
    const sent: unknown[] = [];
    const subject = new TaskReadyNotifier({ nodeId: "node-1", hasOpenOperatorRequest: () => open,
      notify: (notice) => sent.push(notice), workIdFor: (inv) => inv?.collaborationRecordId });
    return { sent, subject };
  }
  const ready = flight({ state: "completed", output: "Done.", metadata: { ready: { state: "ready", at: 500, summary: "Done.", nodeId: "node-1" } } });

  test("rings once per flight, keyed by the flight", () => {
    const { sent, subject } = notifier();
    expect(subject.noteFlight(flight(), ready, invocation())).toBe(true);
    expect(subject.noteFlight(flight(), ready, invocation())).toBe(false);
    expect(sent).toEqual([{ flightId: "flt-1", invocationId: "inv-1", summary: "Done.", agentId: "agent-1",
      conversationId: "conv-1", workId: "work-1" }]);
  });

  test("an open operator question or permission owns the ping", () => {
    const { sent, subject } = notifier(true);
    expect(subject.noteFlight(flight(), ready, invocation())).toBe(false);
    expect(sent).toEqual([]);
  });

  test("only the runtime that wrote Ready rings", () => {
    const { sent, subject } = notifier();
    const remote = { ...ready, metadata: { ready: { state: "ready", at: 500, summary: "Done.", nodeId: "node-2" } } };
    expect(subject.noteFlight(flight(), remote, invocation())).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("work item plans", () => {
  test("Ready lands in review and Continue returns it to working with its old acceptance", () => {
    const landed = planReadyWorkItem(work(), { operatorActorId: "operator", summary: "Done.", now: 500, flightId: "flt-1" })!;
    expect(landed).toEqual(expect.objectContaining({ state: "review", acceptanceState: "pending", nextMoveOwnerId: "operator",
      metadata: expect.objectContaining({ taskReadyPriorAcceptance: "none" }) }));
    const continued = planContinuedWorkItem(landed, { now: 600, agentId: "agent-1" })!;
    expect(continued).toEqual(expect.objectContaining({ state: "working", acceptanceState: "none", nextMoveOwnerId: "agent-1" }));
    expect(continued.metadata?.taskReadyPriorAcceptance).toBeUndefined();
  });

  test("settled work is left alone", () => {
    expect(planReadyWorkItem(work({ state: "done" }), { operatorActorId: "operator", summary: "", now: 1, flightId: "f" })).toBeUndefined();
    expect(planReadyWorkItem(work({ acceptanceState: "accepted" }), { operatorActorId: "operator", summary: "", now: 1, flightId: "f" })).toBeUndefined();
  });
});

describe("BrokerTaskReadyService", () => {
  function service(start: FlightRecord, record?: WorkItemRecord) {
    let stored = start;
    let item = record;
    const events: CollaborationEvent[] = [];
    const delivered: unknown[] = [];
    let id = 0;
    const subject = new BrokerTaskReadyService({
      nodeId: "node-1", operatorActorId: "operator",
      resolve: async () => ({ invocation: invocation(), flight: stored }),
      flight: () => stored,
      recordFlight: async (next) => { stored = next; },
      workItem: () => item,
      recordWorkItem: async (next) => { item = next; },
      appendWorkEvent: async (event) => { events.push(event); },
      deliverContinue: async (task, input) => { delivered.push({ id: task.invocation.id, ...input }); return { invocationId: "inv-2", flightId: "flt-2" }; },
      createId: (prefix) => `${prefix}-${++id}`,
      now: () => 900,
    });
    return { subject, events, delivered, stored: () => stored, item: () => item };
  }
  const readyFlight = flight({ state: "completed", output: "Done.",
    metadata: { ...mark, ready: { state: "ready", at: 500, summary: "Done.", nodeId: "node-1" }, nextMoveOwnerId: "operator" } });
  const reviewWork = work({ state: "review", acceptanceState: "pending", nextMoveOwnerId: "operator",
    metadata: { taskReadyPriorAcceptance: "none" } });

  test("setNotify marks a running task, for the operator or the task's asker only", async () => {
    const { subject, stored } = service(flight());
    expect(await subject.setNotify({ ref: "inv-1", notify: true, actorId: "operator" })).toEqual(
      { ok: true, invocationId: "inv-1", flightId: "flt-1", notify: true });
    expect(stored().metadata?.readyNotify).toEqual({ on: true, byId: "operator", at: 900 });
    await expect(subject.setNotify({ ref: "inv-1", notify: true, actorId: "agent-9" })).rejects.toBeInstanceOf(TaskReadyError);
  });

  test("setNotify refuses a finished task", async () => {
    const { subject } = service(flight({ state: "completed" }));
    await expect(subject.setNotify({ ref: "inv-1", notify: true, actorId: "operator" })).rejects.toThrow(/running task/);
  });

  test("Hold keeps Ready, records the hold and a dismissed event", async () => {
    const { subject, stored, events, item } = service(readyFlight, reviewWork);
    const result = await subject.decide({ ref: "inv-1", decision: "hold", actorId: "operator" });
    expect(result.ready).toEqual(expect.objectContaining({ state: "ready", heldAt: 900, heldById: "operator" }));
    expect(stored().metadata?.nextMoveOwnerId).toBe("operator");
    expect(item()?.state).toBe("review");
    expect(events.map((event) => event.kind)).toEqual(["dismissed"]);
  });

  test("Continue delivers into the session, hands the move back, and accepts the work", async () => {
    const { subject, stored, events, item, delivered } = service(readyFlight, reviewWork);
    const result = await subject.decide({ ref: "inv-1", decision: "continue", actorId: "operator" });
    expect(delivered).toEqual([{ id: "inv-1", requestId: "ready-continue-flt-1", actorId: "operator", notify: true }]);
    expect(result.continuation).toEqual({ invocationId: "inv-2", flightId: "flt-2" });
    expect(stored().metadata).toEqual(expect.objectContaining({ nextMoveOwnerId: "agent-1",
      ready: expect.objectContaining({ state: "continued", continuedAt: 900 }) }));
    expect(item()).toEqual(expect.objectContaining({ state: "working", acceptanceState: "none", nextMoveOwnerId: "agent-1" }));
    expect(events.map((event) => event.kind)).toEqual(["accepted"]);
    await expect(subject.decide({ ref: "inv-1", decision: "continue", actorId: "operator" })).rejects.toThrow(/not Ready/);
  });

  test("only the operator decides, and only on a Ready task", async () => {
    await expect(service(readyFlight).subject.decide({ ref: "inv-1", decision: "hold", actorId: "agent-1" })).rejects.toThrow(/only the operator/);
    await expect(service(flight()).subject.decide({ ref: "inv-1", decision: "hold", actorId: "operator" })).rejects.toThrow(/not Ready/);
  });

  test("a refused Continue leaves the task Ready", async () => {
    const { subject, stored } = service(readyFlight);
    (subject as unknown as { options: { deliverContinue: () => Promise<never> } }).options.deliverContinue = async () => { throw new Error("session gone"); };
    await expect(subject.decide({ ref: "inv-1", decision: "continue", actorId: "operator" })).rejects.toThrow("session gone");
    expect(stored().metadata?.ready).toEqual(expect.objectContaining({ state: "ready" }));
  });
});
