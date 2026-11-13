import { expect, test } from "bun:test";
import { completionReply, submittedCompletionReply } from "./completion.js";
import { projectFlightRecord, type FlightRecord } from "./invocations.js";

const base: FlightRecord = { id: "flt", invocationId: "inv", requesterId: "operator", targetAgentId: "agent", state: "waiting" };

test("a waiting flight projects a typed waitingOn and its latest session id", () => {
  const flight = projectFlightRecord({ ...base, metadata: {
    waitingOn: { kind: "permission", summary: "Waiting on permission", requestRef: "permission-1", since: 5 },
    sessionTrace: [
      { sessionId: "old", startedAt: 1, lastAcknowledgedAt: 1 },
      { sessionId: "current", startedAt: 2, lastAcknowledgedAt: 3 },
    ],
  } });
  expect(flight.waitingOn).toEqual({ kind: "permission", summary: "Waiting on permission", requestRef: "permission-1", since: 5 });
  expect(flight.sessionId).toBe("current");
});

test("only a waiting flight carries waitingOn, and an unchanged flight is returned as is", () => {
  const running = { ...base, state: "running" as const, metadata: { waitingOn: { kind: "review", summary: "Diff", since: 1 } } };
  expect(projectFlightRecord(running).waitingOn).toBeUndefined();
  const plain = { ...base, state: "running" as const };
  expect(projectFlightRecord(plain)).toBe(plain);
  expect(projectFlightRecord({ ...base, waitingOn: { kind: "review", summary: "stale", since: 1 } }).waitingOn).toBeUndefined();
});

test("a blocked completion reply needs a valid waitingOn; a held final reads back as the final it was", () => {
  const identity = { invocationId: "inv", flightId: "flt", revision: 0 };
  expect(completionReply({ metadata: { completionReply: { ...identity, kind: "blocked", waitingOn: { kind: "question", summary: "Which branch?" } } } })).toBeDefined();
  expect(completionReply({ metadata: { completionReply: { ...identity, kind: "blocked" } } })).toBeUndefined();
  expect(completionReply({ metadata: { completionReply: { ...identity, kind: "blocked", outcome: "failed", waitingOn: { kind: "review", summary: "x" } } } })).toBeUndefined();
  expect(submittedCompletionReply({ ...identity, kind: "blocked", held: "final", waitingOn: { kind: "permission", summary: "Waiting on permission" } }))
    .toEqual({ ...identity, kind: "final" });
});
