import { describe, expect, test } from "bun:test";

import type {
  ActionBlock,
  BlockState,
  QuestionBlock,
  Session,
  SessionState,
  TextBlock,
  TurnState,
} from "@openscout/agent-sessions";

import {
  projectSessionAttention,
  sessionApprovalAttentionId,
} from "./session-attention.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    name: "Codex Session",
    adapterType: "codex",
    status: "active",
    cwd: "/tmp/project",
    ...overrides,
  };
}

function makeSnapshot(
  turns: TurnState[],
  session: Partial<Session> = {},
  currentTurnId = turns.at(-1)?.id,
): SessionState {
  return {
    session: makeSession(session),
    turns,
    currentTurnId,
  };
}

function makeTurn(input: {
  id: string;
  status?: TurnState["status"];
  blocks?: BlockState[];
  startedAt?: number;
  endedAt?: number;
}): TurnState {
  return {
    id: input.id,
    status: input.status ?? "streaming",
    startedAt: input.startedAt ?? 1_000,
    endedAt: input.endedAt,
    blocks: input.blocks ?? [],
  };
}

function questionBlock(input: {
  id?: string;
  turnId: string;
  status?: QuestionBlock["questionStatus"];
}): BlockState {
  const block: QuestionBlock = {
    id: input.id ?? "question-1",
    turnId: input.turnId,
    type: "question",
    status: "streaming",
    index: 0,
    header: "Decision",
    question: "Should I keep going?",
    options: [{ label: "Yes" }, { label: "No" }],
    multiSelect: false,
    questionStatus: input.status ?? "awaiting_answer",
  };
  return { block, status: "streaming" };
}

function commandBlock(input: {
  id?: string;
  turnId: string;
  status: ActionBlock["action"]["status"];
  blockStatus?: ActionBlock["status"];
  approvalVersion?: number;
  output?: string;
  risk?: "low" | "medium" | "high";
}): BlockState {
  const block: ActionBlock = {
    id: input.id ?? "cmd-1",
    turnId: input.turnId,
    type: "action",
    status: input.blockStatus ?? (input.status === "failed" ? "failed" : "streaming"),
    index: 0,
    action: {
      kind: "command",
      status: input.status,
      output: input.output ?? "",
      command: "bun test",
      ...(input.status === "awaiting_approval"
        ? {
            approval: {
              version: input.approvalVersion ?? 1,
              description: "Run focused tests",
              risk: input.risk ?? "medium",
            },
          }
        : {}),
    },
  };
  return { block, status: input.status === "failed" ? "completed" : "streaming" };
}

function textBlock(turnId: string): BlockState {
  const block: TextBlock = {
    id: "text-1",
    turnId,
    type: "text",
    status: "completed",
    index: 0,
    text: "All clear.",
  };
  return { block, status: "completed" };
}

describe("session attention projection", () => {
  test("projects awaiting question blocks", () => {
    const snapshot = makeSnapshot([
      makeTurn({ id: "turn-1", blocks: [questionBlock({ turnId: "turn-1" })] }),
    ]);

    expect(projectSessionAttention(snapshot, { now: 10_000 })).toEqual([
      expect.objectContaining({
        id: "session-question:session-1:turn-1:question-1",
        kind: "question",
        title: "Decision",
        summary: "Should I keep going?",
        detail: "Options: Yes, No",
        severity: "warning",
      }),
    ]);
  });

  test("projects action approvals and can skip approvals already represented by pairing state", () => {
    const snapshot = makeSnapshot([
      makeTurn({
        id: "turn-1",
        blocks: [
          commandBlock({
            turnId: "turn-1",
            status: "awaiting_approval",
            approvalVersion: 2,
            risk: "high",
          }),
        ],
      }),
    ]);
    const approvalId = sessionApprovalAttentionId("session-1", "turn-1", "cmd-1", 2);

    expect(projectSessionAttention(snapshot, { now: 10_000 })).toEqual([
      expect.objectContaining({
        id: approvalId,
        kind: "approval",
        title: "Approve Command",
        approval: expect.objectContaining({
          sessionId: "session-1",
          turnId: "turn-1",
          blockId: "cmd-1",
          version: 2,
        }),
        severity: "critical",
      }),
    ]);

    expect(projectSessionAttention(snapshot, {
      now: 10_000,
      pendingApprovalIds: [approvalId],
    })).toEqual([]);
  });

  test("projects failed action blocks only for the latest active or recent turn", () => {
    const latestFailed = makeSnapshot([
      makeTurn({
        id: "turn-1",
        status: "completed",
        blocks: [textBlock("turn-1")],
        endedAt: 1_500,
      }),
      makeTurn({
        id: "turn-2",
        status: "completed",
        blocks: [
          commandBlock({
            turnId: "turn-2",
            status: "failed",
            output: "exit code 1",
          }),
        ],
        endedAt: 2_500,
      }),
    ], {}, undefined);

    expect(projectSessionAttention(latestFailed, { now: 10_000 })).toEqual([
      expect.objectContaining({
        id: "session-action-failed:session-1:turn-2:cmd-1",
        kind: "failed_action",
        title: "Command failed",
        summary: "exit code 1",
        detail: "bun test",
        severity: "critical",
      }),
    ]);

    const supersededFailure = makeSnapshot([
      latestFailed.turns[1]!,
      makeTurn({
        id: "turn-3",
        status: "completed",
        blocks: [textBlock("turn-3")],
        endedAt: 3_500,
      }),
    ], {}, undefined);

    expect(projectSessionAttention(supersededFailure, { now: 10_000 })).toEqual([]);
  });

  test("projects failed turns and session-level errors", () => {
    const failedTurn = makeTurn({
      id: "turn-1",
      status: "error",
      endedAt: 2_000,
      blocks: [
        {
          status: "completed",
          block: {
            id: "error-1",
            turnId: "turn-1",
            type: "error",
            status: "failed",
            index: 0,
            message: "Tool runtime crashed",
          },
        },
      ],
    });

    expect(projectSessionAttention(makeSnapshot([failedTurn], { status: "error" }), { now: 10_000 })).toEqual([
      expect.objectContaining({
        id: "session-turn-error:session-1:turn-1",
        kind: "failed_turn",
        summary: "Tool runtime crashed",
      }),
    ]);

    expect(projectSessionAttention(makeSnapshot([], {
      status: "error",
      providerMeta: { errorMessage: "Transport disconnected" },
    }), { now: 10_000 })).toEqual([
      expect.objectContaining({
        id: "session-error:session-1",
        kind: "session_error",
        summary: "Transport disconnected",
      }),
    ]);
  });

  test("projects native blocked metadata when providers expose it", () => {
    const snapshot = makeSnapshot([], {
      providerMeta: {
        nativeAttention: {
          id: "confirm-1",
          status: "needs_input",
          message: "Codex needs a decision before continuing.",
          turnId: "native-turn",
          updatedAt: 1_700_000_009_000,
        },
      },
    });

    expect(projectSessionAttention(snapshot, { now: 10_000 })).toEqual([
      expect.objectContaining({
        id: "session-native:session-1:confirm-1",
        kind: "native_attention",
        title: "Waiting on your answer",
        summary: "Codex needs a decision before continuing.",
        turnId: "native-turn",
        updatedAt: 1_700_000_009_000,
      }),
    ]);
  });

  test("drops resolved questions and approvals on the next projection", () => {
    const resolved = makeSnapshot([
      makeTurn({
        id: "turn-1",
        status: "completed",
        blocks: [
          questionBlock({ turnId: "turn-1", status: "answered" }),
          commandBlock({ turnId: "turn-1", status: "completed" }),
        ],
        endedAt: 2_000,
      }),
    ], { status: "idle" }, undefined);

    expect(projectSessionAttention(resolved, { now: 10_000 })).toEqual([]);
  });

  test("does not project externally cleared native attention", () => {
    const snapshots = [
      makeSnapshot([], {
        providerMeta: {
          operatorAttention: {
            status: "cleared",
            message: "The native system no longer reports the blocker.",
          },
        },
      }),
      makeSnapshot([], {
        providerMeta: {
          nativeAttention: {
            state: "resolved",
            message: "Resolved externally.",
          },
        },
      }),
      makeSnapshot([], {
        providerMeta: {
          attention: "idle",
        },
      }),
    ];

    for (const snapshot of snapshots) {
      expect(projectSessionAttention(snapshot, { now: 10_000 })).toEqual([]);
    }
  });
});
