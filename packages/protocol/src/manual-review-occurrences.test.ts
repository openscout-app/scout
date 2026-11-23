import { describe, expect, test } from "bun:test";

import type { DurableAction } from "./durable-actions.js";
import {
  MANUAL_REVIEW_FIELD_MAX_LENGTH,
  manualReviewOccurrenceOf,
  manualReviewPinnedDifferences,
  validateManualReviewOccurrenceRequest,
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
});
