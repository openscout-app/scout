import { describe, expect, test } from "bun:test";

import { latestFlightForSession, type ScoutFlightRecord } from "./service.ts";

const flight = (id: string, state: string, startedAt: number, extra: Partial<ScoutFlightRecord> = {}): ScoutFlightRecord => ({
  id, invocationId: `inv-${id}`, requesterId: "parent", targetAgentId: "session-abc", state, startedAt, ...extra,
});

describe("wait on a session handle", () => {
  test("prefers the task the session is running now over a newer finished one", () => {
    const flights = [flight("a", "completed", 30), flight("b", "running", 20), flight("c", "completed", 10)];
    expect(latestFlightForSession(flights, [], "session-abc")?.id).toBe("b");
  });

  test("falls back to the newest task once all are finished", () => {
    const flights = [flight("a", "completed", 10), flight("b", "failed", 30)];
    expect(latestFlightForSession(flights, [], "session-abc")?.id).toBe("b");
  });

  test("matches a session by its trace or by the invocation that targeted it", () => {
    const traced = flight("t", "running", 5, { targetAgentId: "agent-x", metadata: { sessionTrace: [{ sessionId: "session-def", startedAt: 5 }] } });
    const targeted = flight("v", "running", 1, { targetAgentId: "agent-y" });
    expect(latestFlightForSession([traced], [], "session-def")?.id).toBe("t");
    expect(latestFlightForSession([targeted], [{ id: "inv-v", execution: { targetSessionId: "session-ghi" } }], "session-ghi")?.id).toBe("v");
  });

  test("ignores handles that are not session ids and sessions with no tasks", () => {
    expect(latestFlightForSession([flight("a", "running", 1)], [], "abc")).toBeNull();
    expect(latestFlightForSession([flight("a", "running", 1)], [], "session-none")).toBeNull();
  });
});
