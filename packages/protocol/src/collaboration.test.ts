import { describe, expect, test } from "bun:test";

import {
  validateCollaborationRecord,
  validateCollaborationEvent,
  assertValidCollaborationRecord,
  assertValidCollaborationEvent,
  isWorkItemTerminalState,
  isQuestionTerminalState,
  isCollaborationTerminalState,
  collaborationRequiresOwner,
  collaborationRequiresNextMoveOwner,
  collaborationRequiresWaitingOn,
  collaborationRequiresAcceptance,
  isWorkItem,
  isQuestion,
  collaborationRequesterId,
  validateExternalWorkContext,
  type ExternalWorkContext,
  type CollaborationRecord,
  type CollaborationEvent,
  type WorkItemRecord,
  type QuestionRecord,
} from "./collaboration.js";

function makeExternalContext(): ExternalWorkContext {
  return {
    source: { adapterId: "t3-orchestrator", instanceId: "local", projectId: "project-1", workItemId: "card-1" },
    observedAt: 1_700_000_000_000,
    sourceState: "review",
    board: { id: "board-1", title: "Development", column: { id: "in-review", title: "Review" } },
    workflow: {
      activeStageId: "review-1",
      executionState: "idle",
      stages: [
        { id: "implementation-1", kind: "implementation", state: "completed", threadId: "thread-1", provider: "codex", model: "source-model" },
        { id: "review-1", kind: "review", state: "completed", threadId: "thread-2", provider: "claudeCode" },
      ],
      humanAcceptance: { required: true, state: "pending", sourceState: "awaiting-acceptance" },
    },
  };
}

describe("external work context", () => {
  test("preserves source workflow and review completion while human acceptance is pending", () => {
    const work = makeWorkItem({
      state: "review", requestedById: "operator", acceptanceState: "pending", externalContext: makeExternalContext(),
    });
    expect(validateCollaborationRecord(work)).toEqual([]);
    expect(isCollaborationTerminalState(work)).toBe(false);
    expect(work.externalContext?.workflow?.stages?.every((stage) => stage.state === "completed")).toBe(true);
    expect(work.externalContext?.workflow?.humanAcceptance?.state).toBe("pending");
    expect(JSON.parse(JSON.stringify(work)).externalContext).toEqual(work.externalContext);
  });

  test("keeps source state independent of Scout execution state and allows source-specific vocabulary", () => {
    const context = makeExternalContext();
    context.sourceState = "custom-column:blocked-for-design";
    context.workflow!.stages![0]!.state = "provider-specific-failure";
    expect(validateCollaborationRecord(makeWorkItem({ state: "working", externalContext: context }))).toEqual([]);
  });

  test("accepts minimal scoped source references and existing work without an external context", () => {
    expect(validateExternalWorkContext({ source: { adapterId: "other", instanceId: "remote", workItemId: "1" }, observedAt: 0 })).toEqual([]);
    expect(validateCollaborationRecord(makeWorkItem())).toEqual([]);
  });

  test("rejects malformed nested JSON without throwing", () => {
    for (const context of [null, [], "context", { source: null, observedAt: "now", board: { column: [] }, workflow: { stages: [null], humanAcceptance: null } }]) {
      expect(() => validateExternalWorkContext(context)).not.toThrow();
      expect(validateExternalWorkContext(context).length).toBeGreaterThan(0);
    }
    const malformed = { source: { adapterId: 1, instanceId: "", workItemId: false }, observedAt: Number.NaN };
    const work = makeWorkItem({ externalContext: malformed as unknown as ExternalWorkContext });
    expect(validateCollaborationRecord(work)).toContain("externalContext.source.instanceId must be a non-empty string");
  });

  test("requires scoped identity and valid observation time", () => {
    const context = makeExternalContext();
    context.source.instanceId = " ";
    context.observedAt = Number.POSITIVE_INFINITY;
    expect(validateExternalWorkContext(context)).toEqual([
      "externalContext.observedAt must be a non-negative finite timestamp",
      "externalContext.source.instanceId must be a non-empty string",
    ]);
  });

  test("rejects duplicate stages, dangling active stages, and invalid acceptance states", () => {
    const context = makeExternalContext();
    context.workflow!.stages![1]!.id = "implementation-1";
    context.workflow!.humanAcceptance!.state = "complete" as never;
    const errors = validateExternalWorkContext(context);
    expect(errors).toContain("externalContext.workflow.stages[1].id must be unique within the workflow");
    expect(errors).toContain("externalContext.workflow.activeStageId must reference a supplied stage");
    expect(errors).toContain("externalContext.workflow.humanAcceptance.state must be pending, accepted, rejected, or unknown");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkItem(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "wi-1",
    kind: "work_item",
    title: "Test work item",
    createdById: "actor-1",
    ownerId: "actor-1",
    nextMoveOwnerId: "actor-1",
    state: "open",
    acceptanceState: "none",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeQuestion(overrides: Partial<QuestionRecord> = {}): QuestionRecord {
  return {
    id: "q-1",
    kind: "question",
    title: "Test question",
    createdById: "actor-1",
    nextMoveOwnerId: "actor-1",
    state: "open",
    acceptanceState: "none",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeCollabEvent(overrides: Partial<CollaborationEvent> = {}): CollaborationEvent {
  return {
    id: "cev-1",
    recordId: "wi-1",
    recordKind: "work_item",
    kind: "created",
    actorId: "actor-1",
    at: 1_700_000_000_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isWorkItemTerminalState
// ---------------------------------------------------------------------------

describe("isWorkItemTerminalState", () => {
  test("returns true for done", () => {
    expect(isWorkItemTerminalState("done")).toBe(true);
  });

  test("returns true for cancelled", () => {
    expect(isWorkItemTerminalState("cancelled")).toBe(true);
  });

  test("returns false for non-terminal states", () => {
    expect(isWorkItemTerminalState("open")).toBe(false);
    expect(isWorkItemTerminalState("working")).toBe(false);
    expect(isWorkItemTerminalState("waiting")).toBe(false);
    expect(isWorkItemTerminalState("review")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// collaborationRequires* helpers
// ---------------------------------------------------------------------------

describe("collaborationRequiresOwner", () => {
  test("requires owner for non-terminal work_item", () => {
    expect(collaborationRequiresOwner(makeWorkItem({ state: "open" }))).toBe(true);
    expect(collaborationRequiresOwner(makeWorkItem({ state: "working" }))).toBe(true);
  });

  test("does not require owner for terminal work_item", () => {
    expect(collaborationRequiresOwner(makeWorkItem({ state: "done" }))).toBe(false);
    expect(collaborationRequiresOwner(makeWorkItem({ state: "cancelled" }))).toBe(false);
  });
});

describe("collaborationRequiresNextMoveOwner", () => {
  test("requires nextMoveOwnerId for non-terminal", () => {
    expect(collaborationRequiresNextMoveOwner(makeWorkItem({ state: "review" }))).toBe(true);
  });

  test("does not require nextMoveOwnerId for terminal", () => {
    expect(collaborationRequiresNextMoveOwner(makeWorkItem({ state: "done" }))).toBe(false);
  });
});

describe("collaborationRequiresWaitingOn", () => {
  test("returns true only when state is waiting", () => {
    expect(collaborationRequiresWaitingOn(makeWorkItem({ state: "waiting" }))).toBe(true);
    expect(collaborationRequiresWaitingOn(makeWorkItem({ state: "open" }))).toBe(false);
  });
});

describe("collaborationRequiresAcceptance", () => {
  test("returns false when acceptanceState is none", () => {
    expect(collaborationRequiresAcceptance(makeWorkItem({ acceptanceState: "none" }))).toBe(false);
  });

  test("returns true when acceptanceState is pending and requestedById is set", () => {
    expect(
      collaborationRequiresAcceptance(
        makeWorkItem({ acceptanceState: "pending", requestedById: "actor-2" }),
      ),
    ).toBe(true);
  });

  test("returns false when acceptanceState is pending but no requestedById", () => {
    expect(
      collaborationRequiresAcceptance(
        makeWorkItem({ acceptanceState: "pending", requestedById: undefined }),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateCollaborationRecord
// ---------------------------------------------------------------------------

describe("validateCollaborationRecord — valid record", () => {
  test("passes with a minimal valid work item", () => {
    const errors = validateCollaborationRecord(makeWorkItem());
    expect(errors).toEqual([]);
  });

  test("passes for terminal state without ownerId or nextMoveOwnerId", () => {
    const errors = validateCollaborationRecord(
      makeWorkItem({
        state: "done",
        ownerId: undefined,
        nextMoveOwnerId: undefined,
      }),
    );
    expect(errors).toEqual([]);
  });
});

describe("validateCollaborationRecord — blank id", () => {
  test("returns error when id is blank", () => {
    const errors = validateCollaborationRecord(makeWorkItem({ id: "   " }));
    expect(errors).toContain("collaboration record id is required");
  });
});

describe("validateCollaborationRecord — blank title", () => {
  test("returns error when title is blank", () => {
    const errors = validateCollaborationRecord(makeWorkItem({ title: "" }));
    expect(errors).toContain("collaboration title is required");
  });
});

describe("validateCollaborationRecord — blank createdById", () => {
  test("returns error when createdById is blank", () => {
    const errors = validateCollaborationRecord(makeWorkItem({ createdById: " " }));
    expect(errors).toContain("createdById is required");
  });
});

describe("validateCollaborationRecord — parent self-reference", () => {
  test("returns error when parentId === id", () => {
    const errors = validateCollaborationRecord(makeWorkItem({ id: "wi-1", parentId: "wi-1" }));
    expect(errors).toContain("parentId cannot reference the record itself");
  });

  test("passes when parentId is a different id", () => {
    const errors = validateCollaborationRecord(makeWorkItem({ id: "wi-1", parentId: "wi-other" }));
    expect(errors).not.toContain("parentId cannot reference the record itself");
  });
});

describe("validateCollaborationRecord — createdAt > updatedAt", () => {
  test("returns error when createdAt is after updatedAt", () => {
    const errors = validateCollaborationRecord(
      makeWorkItem({ createdAt: 1_700_000_002_000, updatedAt: 1_700_000_001_000 }),
    );
    expect(errors).toContain("updatedAt must be greater than or equal to createdAt");
  });

  test("passes when createdAt === updatedAt", () => {
    const errors = validateCollaborationRecord(
      makeWorkItem({ createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 }),
    );
    expect(errors).not.toContain("updatedAt must be greater than or equal to createdAt");
  });
});

describe("validateCollaborationRecord — missing ownerId for non-terminal", () => {
  test("returns error when non-terminal work item lacks ownerId", () => {
    const errors = validateCollaborationRecord(
      makeWorkItem({ state: "open", ownerId: undefined }),
    );
    expect(errors).toContain("non-terminal work items require ownerId");
  });

  test("passes for done state without ownerId", () => {
    const errors = validateCollaborationRecord(
      makeWorkItem({ state: "done", ownerId: undefined, nextMoveOwnerId: undefined }),
    );
    expect(errors).not.toContain("non-terminal work items require ownerId");
  });
});

describe("validateCollaborationRecord — missing nextMoveOwnerId for non-terminal", () => {
  test("returns error when non-terminal record lacks nextMoveOwnerId", () => {
    const errors = validateCollaborationRecord(
      makeWorkItem({ state: "working", nextMoveOwnerId: undefined }),
    );
    expect(errors).toContain("non-terminal collaboration records require nextMoveOwnerId");
  });
});

describe("validateCollaborationRecord — waiting without waitingOn", () => {
  test("returns error when waiting work item lacks waitingOn", () => {
    const errors = validateCollaborationRecord(
      makeWorkItem({ state: "waiting", waitingOn: undefined }),
    );
    expect(errors).toContain("waiting work items require waitingOn");
  });

  test("passes when waiting work item has waitingOn", () => {
    const errors = validateCollaborationRecord(
      makeWorkItem({
        state: "waiting",
        waitingOn: { kind: "actor", label: "reviewer", targetId: "actor-2" },
      }),
    );
    expect(errors).not.toContain("waiting work items require waitingOn");
  });
});

describe("validateCollaborationRecord — waitingOn self-reference", () => {
  test("returns error when waitingOn.targetId === record id", () => {
    const errors = validateCollaborationRecord(
      makeWorkItem({
        id: "wi-1",
        state: "waiting",
        waitingOn: { kind: "work_item", label: "itself", targetId: "wi-1" },
      }),
    );
    expect(errors).toContain("waitingOn.targetId cannot reference the work item itself");
  });

  test("passes when waitingOn.targetId is a different id", () => {
    const errors = validateCollaborationRecord(
      makeWorkItem({
        id: "wi-1",
        state: "waiting",
        waitingOn: { kind: "work_item", label: "other", targetId: "wi-other" },
      }),
    );
    expect(errors).not.toContain("waitingOn.targetId cannot reference the work item itself");
  });
});

describe("validateCollaborationRecord — acceptance coherence", () => {
  test("returns error when acceptanceState is non-none without requestedById", () => {
    const errors = validateCollaborationRecord(
      makeWorkItem({ acceptanceState: "pending", requestedById: undefined }),
    );
    expect(errors).toContain(
      "acceptanceState requires the corresponding requester and reviewer identities",
    );
  });

  test("passes when acceptanceState is pending and requestedById is set", () => {
    const errors = validateCollaborationRecord(
      makeWorkItem({ acceptanceState: "pending", requestedById: "actor-2" }),
    );
    expect(errors).not.toContain(
      "acceptanceState requires the corresponding requester and reviewer identities",
    );
  });
});

describe("assertValidCollaborationRecord", () => {
  test("throws for invalid record", () => {
    expect(() => assertValidCollaborationRecord(makeWorkItem({ id: "" }))).toThrow();
  });

  test("does not throw for valid record", () => {
    expect(() => assertValidCollaborationRecord(makeWorkItem())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateCollaborationEvent
// ---------------------------------------------------------------------------

describe("validateCollaborationEvent — valid event", () => {
  test("passes with a valid created event", () => {
    const errors = validateCollaborationEvent(makeCollabEvent());
    expect(errors).toEqual([]);
  });

  test("passes with matching record provided", () => {
    const record = makeWorkItem();
    const errors = validateCollaborationEvent(makeCollabEvent(), record);
    expect(errors).toEqual([]);
  });
});

describe("validateCollaborationEvent — blank id", () => {
  test("returns error when event id is blank", () => {
    const errors = validateCollaborationEvent(makeCollabEvent({ id: "  " }));
    expect(errors).toContain("collaboration event id is required");
  });
});

describe("validateCollaborationEvent — blank recordId", () => {
  test("returns error when event recordId is blank", () => {
    const errors = validateCollaborationEvent(makeCollabEvent({ recordId: "" }));
    expect(errors).toContain("collaboration event recordId is required");
  });
});

describe("validateCollaborationEvent — blank actorId", () => {
  test("returns error when event actorId is blank", () => {
    const errors = validateCollaborationEvent(makeCollabEvent({ actorId: " " }));
    expect(errors).toContain("collaboration event actorId is required");
  });
});

describe("validateCollaborationEvent — recordId mismatch with record", () => {
  test("returns error when event recordId does not match provided record id", () => {
    const record = makeWorkItem({ id: "wi-99" });
    const errors = validateCollaborationEvent(makeCollabEvent({ recordId: "wi-1" }), record);
    expect(errors).toContain("collaboration event recordId does not match the target record");
  });
});

describe("validateCollaborationEvent — recordKind mismatch with record", () => {
  test("returns error when event recordKind does not match provided record kind", () => {
    const record = makeWorkItem({ id: "wi-1" });
    // Force a wrong recordKind via cast
    const event = makeCollabEvent({ recordId: "wi-1", recordKind: "work_item" });
    (event as any).recordKind = "unknown_kind";
    const errors = validateCollaborationEvent(event, record);
    expect(errors).toContain("collaboration event recordKind does not match the target record");
  });
});

describe("validateCollaborationEvent — work_item-only event kinds", () => {
  const workItemOnlyKinds = [
    "waiting",
    "progressed",
    "review_requested",
    "done",
    "cancelled",
  ] as const;

  for (const kind of workItemOnlyKinds) {
    test(`returns error when '${kind}' event has non-work_item recordKind`, () => {
      const event = makeCollabEvent({ kind });
      (event as any).recordKind = "not_work_item";
      const errors = validateCollaborationEvent(event);
      expect(errors).toContain(`${kind} events only apply to work items`);
    });

    test(`passes when '${kind}' event has work_item recordKind`, () => {
      const errors = validateCollaborationEvent(makeCollabEvent({ kind }));
      expect(errors).not.toContain(`${kind} events only apply to work items`);
    });
  }
});

describe("assertValidCollaborationEvent", () => {
  test("throws for invalid event", () => {
    expect(() => assertValidCollaborationEvent(makeCollabEvent({ id: "" }))).toThrow();
  });

  test("does not throw for valid event", () => {
    expect(() => assertValidCollaborationEvent(makeCollabEvent())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Question terminal-state helpers
// ---------------------------------------------------------------------------

describe("isQuestionTerminalState", () => {
  test("returns true for closed and declined", () => {
    expect(isQuestionTerminalState("closed")).toBe(true);
    expect(isQuestionTerminalState("declined")).toBe(true);
  });

  test("returns false for open and answered (answered is not terminal)", () => {
    expect(isQuestionTerminalState("open")).toBe(false);
    expect(isQuestionTerminalState("answered")).toBe(false);
  });
});

describe("isCollaborationTerminalState", () => {
  test("dispatches to work-item terminal states", () => {
    expect(isCollaborationTerminalState(makeWorkItem({ state: "done" }))).toBe(true);
    expect(isCollaborationTerminalState(makeWorkItem({ state: "open" }))).toBe(false);
  });

  test("dispatches to question terminal states", () => {
    expect(isCollaborationTerminalState(makeQuestion({ state: "closed" }))).toBe(true);
    expect(
      isCollaborationTerminalState(makeQuestion({ state: "answered", answer: "yes" })),
    ).toBe(false);
    expect(isCollaborationTerminalState(makeQuestion({ state: "open" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// collaborationRequires* helpers — question side
// ---------------------------------------------------------------------------

describe("collaborationRequiresOwner — question", () => {
  test("never requires owner for questions (work-item-only gate)", () => {
    expect(collaborationRequiresOwner(makeQuestion({ state: "open" }))).toBe(false);
    expect(collaborationRequiresOwner(makeQuestion({ state: "answered", answer: "a" }))).toBe(false);
  });
});

describe("collaborationRequiresNextMoveOwner — question", () => {
  test("requires nextMoveOwnerId for non-terminal questions", () => {
    expect(collaborationRequiresNextMoveOwner(makeQuestion({ state: "open" }))).toBe(true);
    expect(
      collaborationRequiresNextMoveOwner(makeQuestion({ state: "answered", answer: "a" })),
    ).toBe(true);
  });

  test("does not require nextMoveOwnerId for terminal questions", () => {
    expect(collaborationRequiresNextMoveOwner(makeQuestion({ state: "closed" }))).toBe(false);
    expect(collaborationRequiresNextMoveOwner(makeQuestion({ state: "declined" }))).toBe(false);
  });
});

describe("collaborationRequiresWaitingOn — question", () => {
  test("never requires waitingOn for questions", () => {
    expect(collaborationRequiresWaitingOn(makeQuestion({ state: "open" }))).toBe(false);
  });
});

describe("collaborationRequiresAcceptance — question uses askedById", () => {
  test("returns false when acceptanceState is none", () => {
    expect(collaborationRequiresAcceptance(makeQuestion({ acceptanceState: "none" }))).toBe(false);
  });

  test("returns true when pending and askedById is set", () => {
    expect(
      collaborationRequiresAcceptance(
        makeQuestion({ acceptanceState: "pending", askedById: "actor-2" }),
      ),
    ).toBe(true);
  });

  test("returns false when pending but no askedById", () => {
    expect(
      collaborationRequiresAcceptance(
        makeQuestion({ acceptanceState: "pending", askedById: undefined }),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateCollaborationRecord — question records
// ---------------------------------------------------------------------------

describe("validateCollaborationRecord — valid question", () => {
  test("passes with a minimal valid open question", () => {
    const errors = validateCollaborationRecord(makeQuestion());
    expect(errors).toEqual([]);
  });

  test("passes for an answered question that carries an answer", () => {
    const errors = validateCollaborationRecord(
      makeQuestion({ state: "answered", answeredById: "actor-2", answer: "42" }),
    );
    expect(errors).toEqual([]);
  });

  test("passes for terminal (closed) question without nextMoveOwnerId", () => {
    const errors = validateCollaborationRecord(
      makeQuestion({ state: "closed", nextMoveOwnerId: undefined }),
    );
    expect(errors).toEqual([]);
  });

  test("does not require ownerId for a non-terminal question", () => {
    const errors = validateCollaborationRecord(makeQuestion({ state: "open", ownerId: undefined }));
    expect(errors).not.toContain("non-terminal work items require ownerId");
    expect(errors).toEqual([]);
  });
});

describe("validateCollaborationRecord — answered question requires answer", () => {
  test("returns error when answered question has no answer", () => {
    const errors = validateCollaborationRecord(
      makeQuestion({ state: "answered", answer: undefined }),
    );
    expect(errors).toContain("answered questions require an answer");
  });

  test("returns error when answered question has a blank answer", () => {
    const errors = validateCollaborationRecord(
      makeQuestion({ state: "answered", answer: "   " }),
    );
    expect(errors).toContain("answered questions require an answer");
  });

  test("passes when answered question has an answer", () => {
    const errors = validateCollaborationRecord(
      makeQuestion({ state: "answered", answer: "yes" }),
    );
    expect(errors).not.toContain("answered questions require an answer");
  });

  test("does not apply the answer gate to work items", () => {
    // A work item never carries the question `answer` field; the gate must not fire.
    const errors = validateCollaborationRecord(makeWorkItem({ state: "working" }));
    expect(errors).not.toContain("answered questions require an answer");
  });
});

describe("validateCollaborationRecord — question shares base gates", () => {
  test("returns error for blank id", () => {
    expect(validateCollaborationRecord(makeQuestion({ id: "  " }))).toContain(
      "collaboration record id is required",
    );
  });

  test("returns error for missing nextMoveOwnerId on non-terminal question", () => {
    expect(
      validateCollaborationRecord(makeQuestion({ state: "open", nextMoveOwnerId: undefined })),
    ).toContain("non-terminal collaboration records require nextMoveOwnerId");
  });

  test("returns error for question acceptance without askedById", () => {
    expect(
      validateCollaborationRecord(
        makeQuestion({ acceptanceState: "pending", askedById: undefined }),
      ),
    ).toContain("acceptanceState requires the corresponding requester and reviewer identities");
  });
});

// ---------------------------------------------------------------------------
// validateCollaborationEvent — question records
// ---------------------------------------------------------------------------

describe("validateCollaborationEvent — question record kinds", () => {
  test("passes a created event on a question record", () => {
    const record = makeQuestion();
    const errors = validateCollaborationEvent(
      makeCollabEvent({ recordId: "q-1", recordKind: "question", kind: "created" }),
      record,
    );
    expect(errors).toEqual([]);
  });

  const workItemOnlyKinds = ["waiting", "progressed", "review_requested", "done", "cancelled", "claimed"] as const;

  for (const kind of workItemOnlyKinds) {
    test(`rejects '${kind}' event on a question record`, () => {
      const errors = validateCollaborationEvent(
        makeCollabEvent({ recordKind: "question", kind }),
      );
      expect(errors).toContain(`${kind} events only apply to work items`);
    });
  }

  test("still allows 'claimed' on a work item (work-item behavior preserved)", () => {
    const errors = validateCollaborationEvent(makeCollabEvent({ kind: "claimed" }));
    expect(errors).not.toContain("claimed events only apply to work items");
  });
});

// ---------------------------------------------------------------------------
// Discriminated-union narrowing on `kind`
// ---------------------------------------------------------------------------

describe("CollaborationRecord discriminated union", () => {
  function describeState(record: CollaborationRecord): string {
    // Compiles only because `kind` narrows the union to the right member,
    // exposing `waitingOn` (work_item) vs `answer` (question).
    if (record.kind === "work_item") {
      return record.waitingOn ? `waiting on ${record.waitingOn.label}` : `work item ${record.state}`;
    }
    return record.answer ? `answered: ${record.answer}` : `question ${record.state}`;
  }

  test("narrows to WorkItemRecord on kind === 'work_item'", () => {
    const record: CollaborationRecord = makeWorkItem({
      state: "waiting",
      waitingOn: { kind: "actor", label: "reviewer", targetId: "actor-2" },
    });
    expect(describeState(record)).toBe("waiting on reviewer");
  });

  test("narrows to QuestionRecord on kind === 'question'", () => {
    const answered: CollaborationRecord = makeQuestion({ state: "answered", answer: "yes" });
    expect(describeState(answered)).toBe("answered: yes");

    const open: CollaborationRecord = makeQuestion({ state: "open" });
    expect(describeState(open)).toBe("question open");
  });

  test("assertValidCollaborationRecord accepts a valid question through the union", () => {
    const record: CollaborationRecord = makeQuestion();
    expect(() => assertValidCollaborationRecord(record)).not.toThrow();
  });
});

describe("kind helpers", () => {
  test("isWorkItem / isQuestion narrow on kind", () => {
    const wi: CollaborationRecord = makeWorkItem();
    const q: CollaborationRecord = makeQuestion();
    expect(isWorkItem(wi)).toBe(true);
    expect(isQuestion(wi)).toBe(false);
    expect(isWorkItem(q)).toBe(false);
    expect(isQuestion(q)).toBe(true);
    // Narrowing: these field reads only compile because the guard narrows the union.
    if (isWorkItem(wi)) expect(wi.state).toBe("open");
    if (isQuestion(q)) expect(q.state).toBe("open");
  });

  test("collaborationRequesterId returns the kind-appropriate requester", () => {
    expect(collaborationRequesterId(makeWorkItem({ requestedById: "asker-wi" }))).toBe("asker-wi");
    expect(collaborationRequesterId(makeQuestion({ askedById: "asker-q" }))).toBe("asker-q");
    expect(collaborationRequesterId(makeWorkItem())).toBeUndefined();
    expect(collaborationRequesterId(makeQuestion())).toBeUndefined();
  });
});
