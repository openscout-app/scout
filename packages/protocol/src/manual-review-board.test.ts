import { describe, expect, test } from "bun:test";

import type { DurableAction } from "./durable-actions.js";
import {
  isManualReviewBoardScope,
  manualReviewBoardRoutineOf,
  manualReviewBoardRunDifferences,
  manualReviewBoardScope,
  validateManualReviewBoardPreviewRequest,
  validateManualReviewBoardRoutineSaveRequest,
  validateManualReviewBoardRunRequest,
  type ManualReviewBoardRoutine,
  type ManualReviewBoardRunRequest,
} from "./manual-review-board.js";
import { manualReviewOccurrenceOf, manualReviewPinnedDifferences, type ManualReviewOccurrenceRequest } from "./manual-review-occurrences.js";

const routine: ManualReviewBoardRoutine = {
  id: "nightly-review",
  name: "Review the work channel",
  version: 3,
  connectionId: "c1",
  channel: "work",
  projectPath: "/projects/reviewer",
  harness: "codex",
  enabled: true,
};
const { version: _version, ...fields } = routine;
const save = { ...fields, expectedVersion: 0 };

const run: ManualReviewBoardRunRequest = {
  routineId: "nightly-review",
  itemId: "42",
  requestId: "run-1",
  routineVersion: 3,
  inputVersion: "7",
  revision: "1f2e3d4c",
};

const recorded: ManualReviewOccurrenceRequest = {
  scope: manualReviewBoardScope("nightly-review"),
  requestId: "run-1",
  input: { source: "vercel-board:c1:work", id: "42", version: "7" },
  artifact: { kind: "git_commit", ref: "/projects/reviewer", revision: "1f2e3d4c" },
  routine: { id: "nightly-review", version: 3 },
  requestedById: "operator",
};

function storedAction(kind: DurableAction["kind"], metadata: DurableAction["metadata"]): DurableAction {
  return { id: "action-1", kind, subjectId: "subject", authorityCellId: "node-local", state: "pending", leaseGeneration: 0, createdAt: 1_000, updatedAt: 1_000, metadata };
}

describe("Board review routines", () => {
  test("a save names a reviewer and a channel exactly, and nothing else", () => {
    expect(validateManualReviewBoardRoutineSaveRequest(save)).toEqual([]);
    expect(validateManualReviewBoardRoutineSaveRequest({ ...save, expectedVersion: 3, harness: "claude", enabled: false })).toEqual([]);
    expect(validateManualReviewBoardRoutineSaveRequest(null)).toEqual(["request must be an object"]);

    for (const [change, field] of [
      [{ id: "../other" }, "id"],
      [{ name: "" }, "name"],
      [{ name: " padded " }, "name"],
      [{ name: "two\nlines" }, "name"],
      [{ connectionId: "c1/work" }, "connectionId"],
      [{ channel: "Work" }, "channel"],
      [{ projectPath: "projects/reviewer" }, "projectPath"],
      [{ projectPath: "/projects/reviewer\n--flag" }, "projectPath"],
      [{ harness: "grok" }, "harness"],
      [{ enabled: 1 }, "enabled"],
      [{ expectedVersion: -1 }, "expectedVersion"],
      [{ expectedVersion: "1" }, "expectedVersion"],
    ] as const) {
      expect(validateManualReviewBoardRoutineSaveRequest({ ...save, ...change }).map(problem => problem.split(" ")[0])).toEqual([field]);
    }
  });

  test("only a readable routine record reads as a routine, without what else the record holds", () => {
    const stored = { schemaVersion: 1, ...routine, savedById: "operator", savedAt: 1_000 };
    expect(manualReviewBoardRoutineOf(storedAction("manual_review_routine", { manualReviewRoutine: stored }))).toEqual(routine);
    expect(manualReviewBoardRoutineOf(null)).toBeNull();
    expect(manualReviewBoardRoutineOf(storedAction("manual_review", { manualReviewRoutine: stored }))).toBeNull();
    expect(manualReviewBoardRoutineOf(storedAction("manual_review_routine", { manualReviewRoutine: { ...stored, schemaVersion: 2 } }))).toBeNull();
    expect(manualReviewBoardRoutineOf(storedAction("manual_review_routine", { manualReviewRoutine: { ...stored, version: 0 } }))).toBeNull();
    expect(manualReviewBoardRoutineOf(storedAction("manual_review_routine", { manualReviewRoutine: { ...stored, harness: "grok" } }))).toBeNull();
  });
});

describe("Board review runs", () => {
  test("a preview and a run name the routine and the item, and a run repeats every pin", () => {
    expect(validateManualReviewBoardPreviewRequest({ routineId: "nightly-review", itemId: "42" })).toEqual([]);
    expect(validateManualReviewBoardPreviewRequest({ routineId: "nightly review", itemId: " 42" })).toHaveLength(2);
    expect(validateManualReviewBoardRunRequest(run)).toEqual([]);
    for (const [change, field] of [
      [{ requestId: "" }, "requestId"],
      [{ routineVersion: 0 }, "routineVersion"],
      [{ routineVersion: "3" }, "routineVersion"],
      [{ inputVersion: 7 }, "inputVersion"],
      [{ revision: undefined }, "revision"],
    ] as const) {
      expect(validateManualReviewBoardRunRequest({ ...run, ...change }).map(problem => problem.split(" ")[0])).toEqual([field]);
    }
  });

  test("the routine version is a pin of the stored run, compared like the input and the revision", () => {
    expect(isManualReviewBoardScope(recorded.scope)).toBe(true);
    expect(isManualReviewBoardScope("review")).toBe(false);

    expect(manualReviewBoardRunDifferences(recorded, run)).toEqual([]);
    expect(manualReviewBoardRunDifferences(recorded, { ...run, itemId: "43", inputVersion: "8", revision: "89abcdef", routineVersion: 4 }))
      .toEqual(["input.id", "input.version", "artifact.revision", "routine.version"]);
    // A run recorded without a routine pin is never a routine's run.
    expect(manualReviewBoardRunDifferences({ ...recorded, routine: undefined }, run)).toEqual(["routine.id", "routine.version"]);

    expect(manualReviewPinnedDifferences(recorded, recorded)).toEqual([]);
    expect(manualReviewPinnedDifferences(recorded, { ...recorded, routine: { id: "nightly-review", version: 4 } })).toEqual(["routine.version"]);
    expect(manualReviewPinnedDifferences(recorded, { ...recorded, routine: undefined })).toEqual(["routine.id", "routine.version"]);

    const stored = storedAction("manual_review", { manualReview: { schemaVersion: 1, ...recorded, state: "recorded" } });
    expect(manualReviewOccurrenceOf(stored)?.routine).toEqual({ id: "nightly-review", version: 3 });
    expect(manualReviewOccurrenceOf(storedAction("manual_review", { manualReview: { schemaVersion: 1, ...recorded, routine: { id: "nightly-review", version: 0 }, state: "recorded" } }))).toBeNull();
  });
});
