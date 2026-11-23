import { describe, expect, test } from "bun:test";

import type { DurableAction } from "./durable-actions.js";
import {
  MANUAL_REVIEW_FIELD_MAX_LENGTH,
  manualReviewOccurrenceOf,
  manualReviewPinnedDifferences,
  manualReviewTargetDifferences,
  validateManualReviewDispatchRequest,
  validateManualReviewOccurrenceRequest,
  type ManualReviewDispatch,
  type ManualReviewOccurrenceRequest,
} from "./manual-review-occurrences.js";

const request: ManualReviewOccurrenceRequest = {
  scope: "review",
  requestId: "run-1",
  input: { source: "board:connection-1", id: "message-42", version: "3" },
  artifact: { kind: "pull_request", ref: "example/repo#12", revision: "1f2e3d4c", observedAt: 900 },
  requestedById: "operator",
};

function storedAction(manualReview: unknown, kind: DurableAction["kind"] = "manual_review"): DurableAction {
  return {
    id: "manual-review-1",
    kind,
    subjectId: "message-42",
    authorityCellId: "node-local",
    state: "pending",
    leaseGeneration: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    metadata: { manualReview },
  };
}

describe("manual review occurrences", () => {
  test("a request needs every pinned field, exactly as it will be stored", () => {
    expect(validateManualReviewOccurrenceRequest(request)).toEqual([]);
    expect(validateManualReviewOccurrenceRequest(null)).toEqual(["request must be an object"]);
    expect(validateManualReviewOccurrenceRequest({ ...request, input: undefined, artifact: [] }))
      .toEqual(["input must be an object", "artifact must be an object"]);

    const problems = validateManualReviewOccurrenceRequest({
      ...request,
      requestId: " run-1",
      input: { ...request.input, version: 3 },
      artifact: { ...request.artifact, revision: "x".repeat(MANUAL_REVIEW_FIELD_MAX_LENGTH + 1), observedAt: -1 },
    });
    expect(problems.map((problem) => problem.split(" ")[0]))
      .toEqual(["requestId", "input.version", "artifact.revision", "artifact.observedAt"]);
  });

  test("the input version and the artifact revision are compared as separate pins", () => {
    expect(manualReviewPinnedDifferences(request, request)).toEqual([]);
    expect(manualReviewPinnedDifferences(request, { ...request, input: { ...request.input, version: "4" } }))
      .toEqual(["input.version"]);
    expect(manualReviewPinnedDifferences(request, { ...request, artifact: { ...request.artifact, revision: "89abcdef" } }))
      .toEqual(["artifact.revision"]);
    // When the revision was read does not identify the run.
    expect(manualReviewPinnedDifferences(request, { ...request, artifact: { ...request.artifact, observedAt: 5_000 } }))
      .toEqual([]);
  });

  test("only a readable manual review action reads as an occurrence", () => {
    const stored = { schemaVersion: 1, ...request, state: "recorded" };
    expect(manualReviewOccurrenceOf(storedAction(stored))).toEqual({
      id: "manual-review-1",
      scope: "review",
      requestId: "run-1",
      input: request.input,
      artifact: request.artifact,
      requestedById: "operator",
      state: "recorded",
      createdAt: 1_000,
    });

    expect(manualReviewOccurrenceOf(null)).toBeNull();
    expect(manualReviewOccurrenceOf(storedAction(stored, "checkback"))).toBeNull();
    expect(manualReviewOccurrenceOf(storedAction(undefined))).toBeNull();
    expect(manualReviewOccurrenceOf(storedAction({ ...stored, schemaVersion: 2 }))).toBeNull();
    expect(manualReviewOccurrenceOf(storedAction({ ...stored, state: "dispatched" }))).toBeNull();
    expect(manualReviewOccurrenceOf(storedAction({ ...stored, artifact: { kind: "pull_request", ref: "example/repo#12" } }))).toBeNull();
  });

  test("a dispatch request names one run and one explicit recipient", () => {
    const run = { scope: "review", requestId: "run-1" };
    for (const target of [
      { kind: "agent_id", agentId: "reviewer" },
      { kind: "session_id", sessionId: "sess.abc" },
      { kind: "project_path", projectPath: "/work/example" },
      { kind: "project_path", projectPath: "/work/example", harness: "codex" },
    ]) {
      expect(validateManualReviewDispatchRequest({ ...run, target, requestedById: "operator" })).toEqual([]);
    }
    expect(validateManualReviewDispatchRequest(null)).toEqual(["request must be an object"]);
    expect(validateManualReviewDispatchRequest({ target: { kind: "agent_id", agentId: "reviewer" } })).toHaveLength(2);
    expect(validateManualReviewDispatchRequest({ ...run })).toEqual(["target must be an object"]);
    for (const target of [
      { kind: "channel", channel: "reviews" },
      { kind: "broadcast" },
      { kind: "agent_label", label: "reviewer" },
      { kind: "agent_id" },
      { kind: "agent_id", agentId: "reviewer", harness: "codex" },
      { kind: "session_id", sessionId: "s".repeat(MANUAL_REVIEW_FIELD_MAX_LENGTH + 1) },
      { kind: "project_path", projectPath: "relative/path" },
      { kind: "project_path", projectPath: "/work/example", host: "elsewhere" },
      { kind: "project_path", projectPath: "/work/example", harness: "unknown" },
    ]) {
      expect(validateManualReviewDispatchRequest({ ...run, target })).toHaveLength(1);
    }
  });

  test("a requested target is compared with the pinned one field by field", () => {
    const project = { kind: "project_path", projectPath: "/work/example", harness: "codex" } as const;
    expect(manualReviewTargetDifferences(project, { ...project })).toEqual([]);
    expect(manualReviewTargetDifferences(project, { kind: "project_path", projectPath: "/work/example" })).toEqual(["target.harness"]);
    expect(manualReviewTargetDifferences(project, { kind: "project_path", projectPath: "/work/other", harness: "claude" }))
      .toEqual(["target.projectPath", "target.harness"]);
    expect(manualReviewTargetDifferences({ kind: "agent_id", agentId: "a" }, { kind: "agent_id", agentId: "b" })).toEqual(["target.agentId"]);
    expect(manualReviewTargetDifferences({ kind: "session_id", sessionId: "a" }, { kind: "session_id", sessionId: "b" })).toEqual(["target.sessionId"]);
    expect(manualReviewTargetDifferences({ kind: "agent_id", agentId: "a" }, { kind: "session_id", sessionId: "a" })).toEqual(["target.kind"]);
  });

  test("a stored state reads only with the dispatch that state requires", () => {
    const stored = { schemaVersion: 1, ...request };
    const dispatch: ManualReviewDispatch = {
      target: { kind: "agent_id", agentId: "reviewer" },
      askRequestId: "manual-review-1.ask",
      askVersion: 1,
      requestedById: "operator",
      attribution: { actorId: "operator", rootActorId: "operator", source: "local-admin" },
      admittedAt: 1_100,
    };
    const ticket = { workId: "work-1", flightId: "flight-1", invocationId: "inv-1", messageId: "msg-1", conversationId: "dm-1", targetAgentId: "reviewer", acceptedAt: 1_200 };
    const refusal = { kind: "rejected", reason: "unknown_target", detail: "no such agent", refusedAt: 1_200 };
    const read = (state: string, value: unknown) => manualReviewOccurrenceOf(storedAction({ ...stored, state, dispatch: value }));

    expect(read("admitted", dispatch)).toMatchObject({ state: "admitted", dispatch });
    expect(read("dispatched", { ...dispatch, ticket })).toMatchObject({ state: "dispatched", dispatch: { ...dispatch, ticket } });
    expect(read("refused", { ...dispatch, refusal })).toMatchObject({ state: "refused", dispatch: { ...dispatch, refusal } });

    // A state never claims more or less than what is stored with it.
    expect(read("recorded", dispatch)).toBeNull();
    expect(read("admitted", undefined)).toBeNull();
    expect(read("admitted", { ...dispatch, ticket })).toBeNull();
    expect(read("dispatched", dispatch)).toBeNull();
    expect(read("dispatched", { ...dispatch, ticket: { ...ticket, flightId: "" } })).toBeNull();
    expect(read("refused", { ...dispatch, ticket })).toBeNull();
    expect(read("dispatched", { ...dispatch, ticket, refusal })).toBeNull();
    expect(read("running", dispatch)).toBeNull();
    // The pin is whole or the occurrence is unreadable: no target, version or principal is guessed.
    expect(read("admitted", { ...dispatch, target: { kind: "channel", channel: "reviews" } })).toBeNull();
    expect(read("admitted", { ...dispatch, askVersion: 2 })).toBeNull();
    expect(read("admitted", { ...dispatch, askRequestId: "" })).toBeNull();
    expect(read("admitted", { ...dispatch, attribution: { ...dispatch.attribution, actorId: "someone-else" } })).toBeNull();
    expect(read("admitted", { ...dispatch, attribution: undefined })).toBeNull();
  });
});
