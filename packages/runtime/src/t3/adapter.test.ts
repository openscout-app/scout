import { describe, expect, test } from "bun:test";
import { isCollaborationTerminalState, validateCollaborationRecord } from "@openscout/protocol";
import { t3CardWorkItem, t3Connections, t3ScopedId } from "./adapter.js";

function card(overrides: Record<string, unknown> = {}) {
  return {
    id: "card-1", title: "Implement request", state: "Review", createdAt: "2026-01-01T00:00:00Z",
    runtime: { implementationRunId: "thread-implementation", reviewRunId: "thread-review" },
    ...overrides,
  };
}

describe("T3 board projection", () => {
  test("preserves scoped dependency direction and the source intent without inventing a priority scale", () => {
    const work = t3CardWorkItem("local", "project-1", card({ dependencies: ["dependency"], priority: 2, area: "runtime",
      intentBrief: { intent: "Implement after the schema is reviewed", acceptanceCriteria: ["Keep compatibility"] } }), Date.now());
    expect(work.summary).toBe("Implement after the schema is reviewed");
    expect(work.relations).toEqual([{ kind: "depends_on", targetId: t3ScopedId("t3-work", "local", "project-1", "dependency"),
      metadata: { adapterId: "t3-orchestrator", instanceId: "local", projectId: "project-1", workItemId: "dependency" } }]);
    expect(work.metadata).toMatchObject({ sourcePriority: 2, sourceArea: "runtime", sourceIntentBrief: { acceptanceCriteria: ["Keep compatibility"] } });
    expect(work.priority).toBeUndefined();
    expect(validateCollaborationRecord(work)).toEqual([]);
  });
  test("keeps Review open for human acceptance without claiming the review passed or provider stopped", () => {
    const work = t3CardWorkItem("local", "project-1", card(), Date.now());
    expect(validateCollaborationRecord(work)).toEqual([]);
    expect(work.state).toBe("review");
    expect(isCollaborationTerminalState(work)).toBe(false);
    expect(work.acceptanceState).toBe("pending");
    expect(work.externalContext?.workflow?.humanAcceptance).toMatchObject({ required: true, state: "pending" });
    expect(work.externalContext?.sourceState).toBe("Review");
    expect(work.externalContext?.board?.column).toEqual({ id: "Review", title: "Review" });
    expect(work.externalContext?.workflow?.stages?.find(stage => stage.id === "review")).toMatchObject({ state: "observed", threadId: "thread-review" });
    expect(work.externalContext?.workflow?.executionState).toBeUndefined();
  });

  test("keeps source-reported Done acceptance distinct from verified human provenance", () => {
    const work = t3CardWorkItem("local", "project-1", card({ state: "Done" }), Date.now());
    expect(validateCollaborationRecord(work)).toEqual([]);
    expect(work.state).toBe("done");
    expect(work.acceptanceState).toBe("accepted");
    expect(work.externalContext?.workflow?.humanAcceptance).toEqual({ required: true, state: "accepted", sourceState: "Done" });
  });

  test("uses the source completion timestamp and clears removed source metadata on refresh", () => {
    const first = t3CardWorkItem("local", "project-1", card({ priority: 2, area: "runtime", slice: "adapter", intentBrief: { intent: "Previous intent" } }), Date.now());
    const updatedAt = "2026-01-02T00:00:00Z";
    const refreshed = t3CardWorkItem("local", "project-1", card({ state: "Done", updatedAt }), Date.now());
    expect(refreshed.completedAt).toBe(Date.parse(updatedAt));
    const mergedMetadata = { ...first.metadata, ...refreshed.metadata };
    expect(mergedMetadata.sourceIntentBrief).toBeUndefined();
    expect(mergedMetadata.sourcePriority).toBeUndefined();
    expect(mergedMetadata.sourceArea).toBeUndefined();
    expect(mergedMetadata.sourceSlice).toBeUndefined();
  });

  test("preserves explicit Fast Mode review bypass without inventing a review thread", () => {
    const work = t3CardWorkItem("local", "project-1", card({
      runtime: { implementationRunId: "thread-implementation" }, reviewBypass: { at: "2026-01-02T00:00:00Z", reason: "Fast Mode approved" },
    }), Date.now());
    const review = work.externalContext?.workflow?.stages?.find(stage => stage.id === "review");
    expect(review).toEqual({ id: "review", kind: "review", state: "bypassed" });
    expect(work.acceptanceState).toBe("pending");
  });

  test("represents repair in its reused source thread and retains the human dependency", () => {
    const work = t3CardWorkItem("local", "project-1", card({
      state: "Diagnosing", runtime: { implementationRunId: "thread-implementation", repairRequestedAt: "2026-01-02T00:00:00Z" },
    }), Date.now());
    expect(validateCollaborationRecord(work)).toEqual([]);
    expect(work.externalContext?.workflow?.activeStageId).toBe("repair");
    expect(work.externalContext?.workflow?.stages?.find(stage => stage.id === "repair")?.state).toBe("running");
    expect(work.externalContext?.workflow?.stages?.find(stage => stage.id === "repair")?.threadId).toBe("thread-implementation");
    const blocked = t3CardWorkItem("local", "project-1", card({ state: "Needs Decision", runtime: { currentDecisionQuestion: "Which API should this use?" } }), Date.now());
    expect(validateCollaborationRecord(blocked)).toEqual([]);
    expect(blocked.state).toBe("waiting");
    expect(blocked.waitingOn).toEqual({ kind: "condition", label: "Which API should this use?" });
    expect(blocked.nextMoveOwnerId).toBe(blocked.requestedById);
  });

  test("scopes colliding source IDs by instance and project with stable refresh identity", () => {
    const first = t3CardWorkItem("local", "project-1", card(), 1);
    const refreshed = t3CardWorkItem("local", "project-1", card({ state: "Done" }), 2);
    const otherInstance = t3CardWorkItem("remote", "project-1", card(), 1);
    const otherProject = t3CardWorkItem("local", "project-2", card(), 1);
    expect(first.id).toBe(refreshed.id);
    expect(new Set([first.id, otherInstance.id, otherProject.id]).size).toBe(3);
    expect(first.externalContext?.source).toEqual({ adapterId: "t3-orchestrator", instanceId: "local", projectId: "project-1", workItemId: "card-1" });
  });

  test("rejects malformed source card identities before projection", () => {
    for (const value of [null, [], card({ id: " " }), card({ title: 1 }), card({ state: undefined })]) {
      expect(() => t3CardWorkItem("local", "project-1", value, 1)).toThrow();
    }
  });

  test("rejects malformed supplied dependencies rather than silently dropping the source constraint", () => {
    for (const dependencies of [null, "card-2", {}, [" "], [1]]) {
      expect(() => t3CardWorkItem("local", "project-1", card({ dependencies }), 1)).toThrow();
    }
  });
});

describe("T3 broker connection configuration", () => {
  test("permits explicit loopback and encrypted remote origins while retaining only credential references", () => {
    const configured = [{ id: "local", url: "http://127.0.0.1:3773", tokenEnv: "T3_ACCESS_TOKEN" }, { id: "remote", url: "wss://t3.example.test/ws", tokenEnv: "REMOTE_T3_TOKEN" }];
    expect(t3Connections({ OPENSCOUT_T3_CONNECTIONS: JSON.stringify(configured), T3_ACCESS_TOKEN: "not-returned" })).toEqual(configured);
  });

  test("rejects embedded credentials, insecure remote endpoints, and duplicate instance names", () => {
    for (const value of [
      [{ id: "remote", url: "http://t3.example.test", tokenEnv: "T3_ACCESS_TOKEN" }],
      [{ id: "local", url: "http://token@127.0.0.1:3773", tokenEnv: "T3_ACCESS_TOKEN" }],
      [{ id: "local", url: "http://127.0.0.1:3773?token=secret", tokenEnv: "T3_ACCESS_TOKEN" }],
      [{ id: "local", url: "http://127.0.0.1:3773", tokenEnv: "T3_ACCESS_TOKEN" }, { id: "local", url: "https://t3.example.test", tokenEnv: "T3_ACCESS_TOKEN" }],
    ]) expect(() => t3Connections({ OPENSCOUT_T3_CONNECTIONS: JSON.stringify(value) })).toThrow();
  });
});
