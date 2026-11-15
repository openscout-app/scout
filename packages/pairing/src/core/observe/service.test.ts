import { describe, expect, test } from "bun:test";

import type { SessionState } from "@openscout/agent-sessions";

import { buildObserveDataFromSnapshot, buildObservePulse } from "./service.ts";

describe("buildObserveDataFromSnapshot", () => {
  test("maps timed snapshot blocks into observer events and files", () => {
    const snapshot: SessionState = {
      session: {
        id: "session-1",
        name: "Claude Session",
        adapterType: "claude-code",
        status: "idle",
        cwd: "/Users/guest/dev/openscout",
      },
      turns: [
        {
          id: "turn-1",
          status: "completed",
          startedAt: 1_000,
          endedAt: 12_000,
          blocks: [
            {
              status: "completed",
              block: {
                id: "reason-1",
                turnId: "turn-1",
                index: 0,
                type: "reasoning",
                text: "Need to inspect the file first.",
                status: "completed",
              },
            },
            {
              status: "completed",
              block: {
                id: "read-1",
                turnId: "turn-1",
                index: 1,
                type: "action",
                status: "completed",
                action: {
                  kind: "tool_call",
                  toolName: "Read",
                  toolCallId: "tool-read-1",
                  input: { file_path: "src/index.ts" },
                  status: "completed",
                  output: "42 lines",
                },
              },
            },
            {
              status: "completed",
              block: {
                id: "ask-1",
                turnId: "turn-1",
                index: 2,
                type: "question",
                status: "completed",
                header: "Delete",
                question: "Delete the old helper?",
                options: [{ label: "Yes" }, { label: "No" }],
                multiSelect: false,
                questionStatus: "answered",
                answer: ["Yes"],
              },
            },
          ],
        },
      ],
      currentTurnId: undefined,
    };

    const data = buildObserveDataFromSnapshot(snapshot, [
      { timestamp: 1_000, event: { event: "session:update", session: snapshot.session } },
      { timestamp: 2_000, event: { event: "turn:start", sessionId: "session-1", turn: {
        id: "turn-1",
        sessionId: "session-1",
        status: "started",
        startedAt: new Date(1_000).toISOString(),
        blocks: [],
      } } },
      { timestamp: 3_000, event: { event: "block:start", sessionId: "session-1", turnId: "turn-1", block: snapshot.turns[0]!.blocks[0]!.block } },
      { timestamp: 5_000, event: { event: "block:start", sessionId: "session-1", turnId: "turn-1", block: snapshot.turns[0]!.blocks[1]!.block } },
      { timestamp: 7_000, event: { event: "block:start", sessionId: "session-1", turnId: "turn-1", block: snapshot.turns[0]!.blocks[2]!.block } },
      { timestamp: 9_000, event: { event: "block:question:answer", sessionId: "session-1", turnId: "turn-1", blockId: "ask-1", questionStatus: "answered", answer: ["Yes"] } },
      { timestamp: 12_000, event: { event: "turn:end", sessionId: "session-1", turnId: "turn-1", status: "completed" } },
    ], false);

    expect(data.events.map((event) => event.kind)).toEqual([
      "boot",
      "think",
      "tool",
      "ask",
    ]);
    expect(data.events[1]?.t).toBeGreaterThanOrEqual(2);
    expect(data.events[2]).toEqual(expect.objectContaining({
      kind: "tool",
      tool: "read",
      arg: "src/index.ts",
    }));
    expect(data.events[3]).toEqual(expect.objectContaining({
      kind: "ask",
      answer: "Yes",
      answerT: 8,
    }));
    expect(data.files).toEqual([
      {
        path: "src/index.ts",
        state: "read",
        touches: 1,
        lastT: data.events[2]!.t,
      },
    ]);
  });

  test("synthesizes a live timeline when only a snapshot is available", () => {
    const snapshot: SessionState = {
      session: {
        id: "session-2",
        name: "Codex Session",
        adapterType: "codex",
        status: "active",
        cwd: "/Users/guest/dev/openscout",
      },
      turns: [
        {
          id: "turn-1",
          status: "streaming",
          startedAt: 10_000,
          blocks: [
            {
              status: "streaming",
              block: {
                id: "reason-live",
                turnId: "turn-1",
                index: 0,
                type: "reasoning",
                text: "Running the test command now.",
                status: "streaming",
              },
            },
            {
              status: "streaming",
              block: {
                id: "cmd-live",
                turnId: "turn-1",
                index: 1,
                type: "action",
                status: "streaming",
                action: {
                  kind: "command",
                  command: "bun test",
                  status: "running",
                  output: "1 pass\n2 pass",
                },
              },
            },
          ],
        },
      ],
      currentTurnId: "turn-1",
    };

    const data = buildObserveDataFromSnapshot(snapshot, [], true);

    expect(data.live).toBe(true);
    expect(data.events[1]).toEqual(expect.objectContaining({
      kind: "think",
      live: true,
    }));
    expect(data.events[2]).toEqual(expect.objectContaining({
      kind: "tool",
      tool: "bash",
      arg: "bun test",
      stream: ["1 pass", "2 pass"],
    }));
    expect(data.contextUsage?.length).toBeGreaterThanOrEqual(2);
  });

  test("surfaces observe metadata from session provider meta", () => {
    const snapshot: SessionState = {
      session: {
        id: "session-3",
        name: "Claude Session",
        adapterType: "claude-code",
        status: "idle",
        cwd: "/Users/guest/dev/openscout",
        model: "claude-opus-test",
        providerMeta: {
          externalSessionId: "upstream-123",
          observeRuntime: {
            gitBranch: "master",
            cliVersion: "2.1.119",
            entrypoint: "sdk-cli",
            permissionMode: "bypassPermissions",
          },
          observeUsage: {
            assistantMessages: 2,
            inputTokens: 12,
            contextInputTokens: 137,
            outputTokens: 24,
            cacheReadInputTokens: 125,
            cacheCreationInputTokens: 60,
            totalTokens: 221,
            contextWindowTokens: 1000000,
            serviceTier: "standard",
          },
        },
      },
      turns: [],
    };

    const data = buildObserveDataFromSnapshot(snapshot, [], false);

    expect(data.metadata).toEqual({
      session: {
        adapterType: "claude-code",
        model: "claude-opus-test",
        cwd: "/Users/guest/dev/openscout",
        sessionStart: expect.any(Number),
        externalSessionId: "upstream-123",
        gitBranch: "master",
        cliVersion: "2.1.119",
        entrypoint: "sdk-cli",
        permissionMode: "bypassPermissions",
      },
      usage: {
        assistantMessages: 2,
        inputTokens: 12,
        contextInputTokens: 137,
        outputTokens: 24,
        cacheReadInputTokens: 125,
        cacheCreationInputTokens: 60,
        totalTokens: 221,
        contextWindowTokens: 1000000,
        serviceTier: "standard",
      },
    });
    expect(data.contextUsage?.at(-1)).toBeCloseTo(137 / 1_000_000, 6);
  });
});

describe("buildObservePulse", () => {
  const NOW = 1_700_000_000_000;
  const BUCKET_MS = 60_000;
  const BUCKET_COUNT = 30;
  const WINDOW_MS = BUCKET_COUNT * BUCKET_MS;

  test("bins timestamps into 30 one-minute buckets ending at now", () => {
    const pulse = buildObservePulse(
      [
        NOW - 30_000, // last bucket (index 29)
        NOW - 90_000, // index 28
        NOW - 90_001, // index 28 (same bucket)
      ],
      NOW,
    );
    expect(pulse).toBeDefined();
    expect(pulse!.bucketMs).toBe(BUCKET_MS);
    expect(pulse!.endMs).toBe(NOW);
    expect(pulse!.counts).toHaveLength(BUCKET_COUNT);
    expect(pulse!.counts[29]).toBe(1);
    expect(pulse!.counts[28]).toBe(2);
    expect(pulse!.counts.reduce((a, b) => a + b, 0)).toBe(3);
  });

  test("empty input yields undefined", () => {
    expect(buildObservePulse([], NOW)).toBeUndefined();
  });

  test("returns undefined when every timestamp is non-finite", () => {
    expect(buildObservePulse([NaN, Infinity, -Infinity], NOW)).toBeUndefined();
  });

  test("ignores events outside the trailing window", () => {
    const pulse = buildObservePulse(
      [
        NOW - WINDOW_MS - 1, // just older than the window
        NOW, // at now (exclusive right edge)
        NOW + 5_000, // in the future
        NOW - 60_000, // in-window (index 29)
      ],
      NOW,
    );
    expect(pulse).toBeDefined();
    expect(pulse!.counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(pulse!.counts[29]).toBe(1);
  });

  test("places the window's oldest edge in the first bucket", () => {
    const pulse = buildObservePulse([NOW - WINDOW_MS], NOW);
    expect(pulse).toBeDefined();
    expect(pulse!.counts[0]).toBe(1);
    expect(pulse!.counts.slice(1).every((c) => c === 0)).toBe(true);
  });

  test("returns undefined when now is not finite", () => {
    expect(buildObservePulse([NOW - 1_000], NaN)).toBeUndefined();
  });
});
