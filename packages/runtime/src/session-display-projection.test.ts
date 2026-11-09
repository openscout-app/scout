import { describe, expect, test } from "bun:test";

import type { ActionBlock, Session, SessionState, TurnState } from "@openscout/agent-sessions";

import { projectSessionDisplayState } from "./session-display-projection.js";

const now = 10_000;

function makeSession(input: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    name: "Codex OpenScout",
    adapterType: "codex",
    status: "active",
    cwd: "/Users/you/dev/openscout",
    model: "gpt-5",
    ...input,
  };
}

function makeSnapshot(input: {
  session?: Partial<Session>;
  turns?: TurnState[];
  currentTurnId?: string;
} = {}): SessionState {
  const turns = input.turns ?? [];
  return {
    session: makeSession(input.session),
    turns,
    currentTurnId: input.currentTurnId ?? turns.find((turn) => turn.status === "streaming")?.id,
  };
}

function makeStreamingTurn(): TurnState {
  const approvalBlock: ActionBlock = {
    id: "cmd-1",
    turnId: "turn-1",
    type: "action",
    status: "started",
    index: 1,
    action: {
      kind: "command",
      command: "npm test",
      output: "",
      status: "awaiting_approval",
      approval: {
        version: 2,
        description: "Run the focused runtime tests",
        risk: "medium",
      },
    },
  };

  return {
    id: "turn-1",
    status: "streaming",
    startedAt: now - 1_000,
    blocks: [
      {
        status: "completed",
        block: {
          id: "text-1",
          turnId: "turn-1",
          type: "text",
          status: "completed",
          index: 0,
          text: "I am wiring the normalized session view.",
        },
      },
      {
        status: "streaming",
        block: approvalBlock,
      },
      {
        status: "streaming",
        block: {
          id: "question-1",
          turnId: "turn-1",
          type: "question",
          status: "streaming",
          index: 2,
          header: "Next action",
          question: "Should I continue into the broker API?",
          options: [{ label: "Yes" }],
          multiSelect: false,
          questionStatus: "awaiting_answer",
        },
      },
    ],
  };
}

describe("session display projection", () => {
  test("normalizes a live session snapshot into one backend display state", () => {
    const snapshot = makeSnapshot({
      session: {
        providerMeta: {
          provider: "openai",
          observeUsage: {
            inputTokens: 120,
            outputTokens: 45,
            totalTokens: 165,
          },
          observedTopology: {
            tasks: [
              {
                id: "task-1",
                title: "Implement session view",
                state: "working",
                assigneeId: "agent-1",
              },
            ],
          },
        },
      },
      turns: [makeStreamingTurn()],
    });

    const state = projectSessionDisplayState(snapshot, { now });

    expect(state).toMatchObject({
      sessionId: "session-1",
      phase: "waiting",
      currentMessage: {
        text: "I am wiring the normalized session view.",
        role: "assistant",
      },
      usage: {
        inputTokens: 120,
        outputTokens: 45,
        totalTokens: 165,
        source: "provider_exact",
      },
      metadata: {
        adapterType: "codex",
        cwd: "/Users/you/dev/openscout",
        model: "gpt-5",
        provider: "openai",
        sessionName: "Codex OpenScout",
        sessionStatus: "active",
        turnCount: 1,
      },
    });
    expect(Object.values(state.activeTools)).toEqual([
      expect.objectContaining({
        id: "turn-1:cmd-1",
        name: "command",
        status: "running",
        summary: "npm test",
      }),
    ]);
    expect(Object.values(state.attention).map((item) => item.kind).sort()).toEqual([
      "approval",
      "question",
    ]);
    expect(state.tasks).toEqual([
      expect.objectContaining({
        id: "task-1",
        title: "Implement session view",
        status: "in_progress",
      }),
    ]);
    expect(state.turns).toEqual([
      expect.objectContaining({
        id: "turn-1",
        status: "streaming",
        blockCount: 3,
        messageCount: 1,
        toolCount: 1,
        attentionCount: 2,
      }),
    ]);
  });

  test("projects completed sessions without inventing active tools", () => {
    const snapshot = makeSnapshot({
      session: { status: "idle" },
      turns: [{
        id: "turn-1",
        status: "completed",
        startedAt: now - 1_000,
        endedAt: now - 500,
        blocks: [
          {
            status: "completed",
            block: {
              id: "text-1",
              turnId: "turn-1",
              type: "text",
              status: "completed",
              index: 0,
              text: "Done.",
            },
          },
          {
            status: "completed",
            block: {
              id: "tool-1",
              turnId: "turn-1",
              type: "action",
              status: "completed",
              index: 1,
              action: {
                kind: "tool_call",
                toolName: "read_file",
                toolCallId: "tool-call-1",
                output: "ok",
                status: "completed",
              },
            },
          },
        ],
      }],
    });

    const state = projectSessionDisplayState(snapshot, { now });

    expect(state.phase).toBe("completed");
    expect(state.activeTools).toEqual({});
    expect(state.turns[0]).toMatchObject({
      id: "turn-1",
      status: "completed",
      toolCount: 1,
      attentionCount: 0,
      summary: "ok",
    });
  });
});
