import { describe, expect, test } from "bun:test";

import type { CollaborationEvent, CollaborationRecord, FlightRecord, InvocationRequest, WorkItemRecord } from "@openscout/protocol";

import { createInMemoryControlRuntime } from "./broker.js";
import { BrokerBoardService, type BoardRegistryView } from "./broker-boards.js";
import { BrokerDurableStore } from "./broker-durable-store.js";
import type { BrokerJournalEntry } from "./broker-journal.js";
import { BrokerWorkLifecycleService, WorkLifecycleError, WorkLifecycleRegistry } from "./broker-work-lifecycles.js";

function workItem(input: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "work-1", kind: "work_item", title: "Ship the board", createdById: "operator", ownerId: "agent-1",
    nextMoveOwnerId: "agent-1", state: "open", acceptanceState: "none", createdAt: 100, updatedAt: 100, ...input,
  };
}

function invocation(id: string, workId: string): InvocationRequest {
  return {
    id, origin: { kind: "cli" } as never, requesterId: "operator", requesterNodeId: "node-1", targetAgentId: "agent-1",
    action: "consult", task: "Do it", collaborationRecordId: workId, ensureAwake: false, stream: false, createdAt: 100,
  } as InvocationRequest;
}

async function setup(records: CollaborationRecord[]) {
  const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });
  for (const record of records) await runtime.upsertCollaboration(record);
  const durableStore = new BrokerDurableStore({
    journal: { async appendEntries(entries: BrokerJournalEntry[]) { return entries; } },
    projection: { async applyEntries() { return []; } },
    threadEvents: { publish() {} },
  });
  const registry = new WorkLifecycleRegistry();
  const work = new BrokerWorkLifecycleService({
    registry, durableStore, runtime,
    listEvents: () => [],
    listWorkItems: () => Object.values(runtime.peek().collaborationRecords).filter((r): r is WorkItemRecord => r.kind === "work_item"),
    childrenOf: () => [],
    createId: (prefix) => `${prefix}-1`,
    operatorActorId: "operator",
    now: () => 10_000,
  });
  const view: { hide: Set<string>; actors: BoardRegistryView["actors"]; agents: BoardRegistryView["agents"];
    invocations: Record<string, InvocationRequest>; flights: Record<string, FlightRecord> } = {
    hide: new Set(), actors: {}, agents: {}, invocations: {}, flights: {},
  };
  const events: CollaborationEvent[] = [];
  const boards = new BrokerBoardService({
    work,
    defaultLifecycleId: registry.defaultId,
    registry: () => ({
      actors: view.actors, agents: view.agents, invocations: view.invocations, flights: view.flights,
      collaborationRecords: Object.fromEntries(Object.entries(runtime.peek().collaborationRecords).filter(([id]) => !view.hide.has(id))),
    }),
    latestEvents: (ids) => {
      const latest = new Map<string, CollaborationEvent>();
      for (const event of events) {
        if (ids.has(event.recordId) && (!latest.get(event.recordId) || event.at >= latest.get(event.recordId)!.at)) latest.set(event.recordId, event);
      }
      return latest;
    },
  });
  return { boards, view, events, runtime };
}

describe("boards", () => {
  test("lists one board per lifecycle and marks the default", async () => {
    const { boards } = await setup([]);
    expect(boards.list()).toEqual({ boards: [{ id: "scout.default", name: "Default", version: 1, isDefault: true }] });
  });

  test("a board carries its columns, transitions and each card's content", async () => {
    const { boards, view, events } = await setup([
      workItem({ id: "parent-1", title: "The epic", state: "working", createdAt: 10, updatedAt: 50 }),
      workItem({
        summary: "Columns and cards from the runtime", priority: "high", conversationId: "conv-1", parentId: "parent-1",
        updatedAt: 200, ownerId: "agent-1", nextMoveOwnerId: "operator",
        externalContext: { source: { adapterId: "vercel-board", instanceId: "team-1", workItemId: "task-9", url: "https://example.test/t/9" }, observedAt: 150 },
      }),
    ]);
    view.actors = { operator: { displayName: "Art" } };
    view.agents = { "agent-1": { displayName: "Builder" } };
    view.invocations = { "inv-1": invocation("inv-1", "work-1"), "inv-0": invocation("inv-0", "work-1") };
    view.flights = {
      "flt-0": { id: "flt-0", invocationId: "inv-0", requesterId: "operator", targetAgentId: "agent-1", state: "completed", startedAt: 120, completedAt: 180, summary: "First pass done" },
      "flt-1": {
        id: "flt-1", invocationId: "inv-1", requesterId: "operator", targetAgentId: "agent-1", state: "running", startedAt: 300,
        metadata: { sessionTrace: [{ sessionId: "sess-1", harness: "claude", startedAt: 300, lastAcknowledgedAt: 310 }] },
      },
    };
    events.push({ id: "evt-1", recordId: "work-1", recordKind: "work_item", kind: "progressed", actorId: "agent-1", at: 400, summary: "Wrote the join" });

    const read = boards.read("default");
    expect(read.board).toMatchObject({ id: "scout.default", name: "Default", version: 1, description: expect.any(String) });
    expect(typeof read.board.hash).toBe("string");
    expect(read.columns.map((c) => c.id)).toEqual(["backlog", "ready", "doing", "waiting", "review", "done", "dropped"]);
    expect(read.columns[1]).toEqual({ id: "ready", name: "Ready", state: "open", purpose: "Planned and ready to start." });
    expect(read.transitions[0]).toEqual({ from: "backlog", to: "ready", name: null });
    expect(read.transitions).toContainEqual({ from: "review", to: "doing", name: "Send back" });
    // Runtime order: most recently updated first.
    expect(read.cards.map((c) => c.workId)).toEqual(["work-1", "parent-1"]);
    expect(read.cards[0]).toEqual({
      workId: "work-1", column: "ready", revision: 0, reviewPending: false, next: expect.arrayContaining(["doing"]),
      title: "Ship the board", summary: "Columns and cards from the runtime", state: "open", acceptanceState: "none", priority: "high",
      ownerId: "agent-1", ownerName: "Builder", nextMoveOwnerId: "operator", nextMoveOwnerName: "Art",
      conversationId: "conv-1", parentId: "parent-1", parentTitle: "The epic",
      createdAt: 100, updatedAt: 200, lastMeaningfulAt: 400, lastMeaningfulSummary: "Wrote the join",
      source: { adapterId: "vercel-board", instanceId: "team-1", workItemId: "task-9", url: "https://example.test/t/9" },
      activeFlight: { id: "flt-1", state: "running", harness: "claude", sessionId: "sess-1", startedAt: 300 },
    });
    expect(read.cards[1]).toMatchObject({
      workId: "parent-1", column: "doing", parentId: null, parentTitle: null, summary: null, priority: null,
      source: null, activeFlight: null, lastMeaningfulAt: 50, lastMeaningfulSummary: "The epic",
    });
  });

  test("names it cannot resolve are null, and the newest flight beats an older update", async () => {
    const { boards, view } = await setup([workItem({ ownerId: "ghost", nextMoveOwnerId: "ghost-2", parentId: "gone", updatedAt: 100 })]);
    view.invocations = { "inv-1": invocation("inv-1", "work-1") };
    view.flights = { "flt-1": { id: "flt-1", invocationId: "inv-1", requesterId: "operator", targetAgentId: "agent-1", state: "failed", startedAt: 150, completedAt: 160, summary: "Crashed" } };
    const [card] = boards.read("scout.default").cards;
    expect(card).toMatchObject({
      ownerId: "ghost", ownerName: null, nextMoveOwnerId: "ghost-2", nextMoveOwnerName: null, parentId: "gone", parentTitle: null,
      activeFlight: null, lastMeaningfulAt: 160, lastMeaningfulSummary: "Crashed",
    });
  });

  test("a placement whose record cannot be read is left out", async () => {
    const { boards, view } = await setup([workItem(), workItem({ id: "work-2", title: "Second", updatedAt: 150 })]);
    view.hide.add("work-2");
    expect(boards.read("default").cards.map((c) => c.workId)).toEqual(["work-1"]);
  });

  test("closedSince and limit mean what they mean on the work board", async () => {
    const { boards } = await setup([
      workItem({ id: "open-1", updatedAt: 100 }),
      workItem({ id: "done-old", state: "done", updatedAt: 200 }),
      workItem({ id: "done-new", state: "done", updatedAt: 900 }),
    ]);
    expect(boards.read("default", { closedSince: 500 }).cards.map((c) => c.workId)).toEqual(["done-new", "open-1"]);
    expect(boards.read("default", { closedSince: 1, limit: 1 }).cards.map((c) => c.workId)).toEqual(["done-new"]);
  });

  test("an unknown board is a 404", async () => {
    const { boards } = await setup([]);
    let error: unknown;
    try { boards.read("nope"); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(WorkLifecycleError);
    expect((error as WorkLifecycleError).status).toBe(404);
  });
});
