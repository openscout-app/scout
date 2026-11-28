import { describe, expect, test } from "bun:test";

import {
  deadFlightCause,
  flightDeclaredDeadAt,
  flightFinishedAt,
  flightLiveness,
  flightOutcome,
  flightOutcomeCategory,
  flightOwnerNodeId,
} from "./flight-outcome.js";

describe("flight outcomes", () => {
  test("a dead flight is failed on the wire and dead to readers", () => {
    const dead = { state: "failed" as const, completedAt: 9, metadata: { outcome: "dead", deathCause: "session_gone", declaredDeadAt: 9 } };
    expect(flightOutcome(dead)).toBe("dead");
    expect(flightOutcomeCategory("dead")).toBe("unfinished");
    expect(deadFlightCause(dead)).toBe("session_gone");
    expect(flightFinishedAt(dead)).toBeNull();
    expect(flightDeclaredDeadAt(dead)).toBe(9);
  });

  test("records the old reconcile pass closed read as dead", () => {
    const legacy = { state: "failed" as const, completedAt: 7, metadata: { reconciledStaleFlight: true, reconciledAt: 7 } };
    expect(flightOutcome(legacy)).toBe("dead");
    expect(deadFlightCause(legacy)).toBe("legacy_reconciled");
    expect(flightDeclaredDeadAt(legacy)).toBe(7);
  });

  test("reported outcomes keep their state and finish time", () => {
    expect(flightOutcome({ state: "failed", metadata: { failureCause: "harness_error" } })).toBe("failed");
    expect(flightOutcome({ state: "completed" })).toBe("completed");
    expect(flightOutcome({ state: "running" })).toBeNull();
    expect(flightFinishedAt({ state: "completed", completedAt: 5 })).toBe(5);
    expect(flightOutcomeCategory("cancelled")).toBe("finished");
  });

  test("the owner is the supervisor's node, else the node that acknowledged dispatch", () => {
    expect(flightOwnerNodeId({ metadata: { supervisor: { nodeId: "a" }, dispatchAck: { nodeId: "b" } } })).toBe("a");
    expect(flightOwnerNodeId({ metadata: { dispatchAck: { nodeId: "b" } } })).toBe("b");
    expect(flightOwnerNodeId({ metadata: {} })).toBeNull();
  });

  test("liveness follows the deadlines", () => {
    const min = 60_000;
    expect(flightLiveness({ lastEvidenceAt: 0 + 1, now: 1 + min })).toBe("active");
    expect(flightLiveness({ lastEvidenceAt: 1, now: 1 + 3 * min })).toBe("idle");
    expect(flightLiveness({ lastEvidenceAt: 1, now: 1 + 10 * min })).toBe("stalled");
    expect(flightLiveness({ lastEvidenceAt: 1, now: 2, sessionGone: true })).toBe("stalled");
  });
});
