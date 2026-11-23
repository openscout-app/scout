import { expect, test } from "bun:test";
import {
  DEFAULT_WORK_LIFECYCLE, compileWorkLifecycle, type CollaborationEvent, type FlightRecord,
  type ManualReviewOccurrence, type ScoutAttribution, type WorkItemRecord,
} from "@openscout/protocol";
import { ManualReviewBoardTickets } from "./manual-review-board-ticket.js";

const occurrenceId = "manual-review-" + "a".repeat(32);
const workId = "work-" + occurrenceId;
const actor: ScoutAttribution = { actorId: "operator", rootActorId: "operator", source: "local-admin" };

function fixture() {
  const machine = compileWorkLifecycle(DEFAULT_WORK_LIFECYCLE);
  const ticket = { workId, flightId: "flight-1", invocationId: "invoke-1", targetAgentId: "reviewer",
    conversationId: "conversation-1", messageId: "message-1", acceptedAt: 1 };
  const occurrence: ManualReviewOccurrence = {
    id: occurrenceId, requestId: "run-1", scope: "board-review:docs", routine: { id: "docs", version: 2 },
    input: { source: "vercel-board:one:work", id: "item-1", version: "3" },
    artifact: { kind: "git_commit", ref: "/project", revision: "a".repeat(40) },
    requestedById: "operator", createdAt: 1, state: "dispatched",
    dispatch: { target: { kind: "project_path", projectPath: "/project", harness: "codex" },
      askRequestId: "ask-1", askVersion: 1, requestedById: "operator", attribution: actor, admittedAt: 1, ticket },
  };
  const state = {
    work: { id: workId, kind: "work_item", title: "Review docs", state: "review", acceptanceState: "pending",
      createdAt: 1, updatedAt: 2, createdById: "operator", requestedById: "operator", ownerId: "reviewer",
      metadata: { source: "scout-manual-review", manualReviewOccurrenceId: occurrenceId } } as WorkItemRecord,
    flight: { id: ticket.flightId, invocationId: ticket.invocationId, requesterId: "operator",
      targetAgentId: "reviewer", state: "completed" } as FlightRecord,
    children: [] as WorkItemRecord[], events: [] as CollaborationEvent[],
  };
  let writer = Promise.resolve();
  const service = new ManualReviewBoardTickets({
    work: id => id === workId ? state.work : null,
    occurrence: id => id === occurrenceId ? occurrence : null,
    latestFlight: () => state.flight, lifecycle: () => machine, children: () => state.children,
    write: fn => { const result = writer.then(fn); writer = result.then(() => {}, () => {}); return result; },
    commit: async (work, events) => { state.work = work; state.events.push(...events); },
  });
  return { service, occurrence, state };
}

test("the ticket returns its recorded pins and acceptance is one journal change across retries", async () => {
  const { service, state, occurrence } = fixture();
  const before = service.read(workId);
  expect(before).toMatchObject({ workId, state: "review", acceptanceState: "pending", routine: { id: "docs", version: 2 },
    input: { id: "item-1", version: "3" }, artifact: { revision: "a".repeat(40) } });
  const [first, again] = await Promise.all([service.accept(workId, actor), service.accept(workId, actor)]);
  expect(again).toEqual(first);
  expect(service.read(workId)).toEqual({ ...before, state: "done", acceptanceState: "accepted" });
  expect(state.events.filter(event => event.kind === "accepted")).toHaveLength(1);
  expect(state.work.metadata?.workPlacement).toMatchObject({ station: "done" });
  occurrence.scope = "generic";
  expect(() => service.read(workId)).toThrow("No Board review ticket");
});

test("a different ticket, incomplete reviewer or open child cannot be accepted", async () => {
  const { service, state, occurrence } = fixture();
  state.flight.id = "different-flight";
  await expect(service.accept(workId, actor)).rejects.toThrow("completed reviewer");
  state.flight.id = "flight-1";
  state.flight.state = "running";
  await expect(service.accept(workId, actor)).rejects.toThrow("completed reviewer");
  state.flight.state = "completed";
  state.children.push({ ...state.work, id: "child", state: "working" });
  await expect(service.accept(workId, actor)).rejects.toThrow("sub-items");
  expect(state.events).toHaveLength(0);
  occurrence.dispatch!.ticket!.workId = "different-work";
  expect(() => service.read(workId)).toThrow("No Board review ticket");
});
