import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createHistorySessionSnapshot,
  inferHistorySessionAdapterType,
  supportsHistorySessionSnapshotForPath,
} from "./history.ts";
import { clearObservedContextWindows } from "./model-window-registry.ts";

describe("history snapshot replay", () => {
  // The learned-window registry is process-global; reset it so a window logged by
  // one fixture session doesn't leak into another's inference path.
  beforeEach(clearObservedContextWindows);

  test("takes a Claude session's folder from its records, never from a guess at its project folder name", () => {
    // "-" in the project folder name stands for "/", "." and "-" alike, so this decodes to
    // /example/worktrees/my/project, which does not exist.
    const path = "/example/home/.claude/projects/-example-worktrees-my-project/session-dash.jsonl";
    const header = [
      JSON.stringify({ type: "permission-mode", permissionMode: "default", sessionId: "session-dash" }),
      JSON.stringify({ type: "mode", mode: "normal", sessionId: "session-dash" }),
    ];
    const snapshotOf = (lines: string[]) =>
      createHistorySessionSnapshot({ path, content: lines.join("\n"), adapterType: "claude-code", baseTimestampMs: 0 }).snapshot;

    expect(snapshotOf(header).session.cwd).toBeUndefined();

    const withCwd = snapshotOf([
      ...header,
      JSON.stringify({
        type: "user",
        sessionId: "session-dash",
        cwd: "/example/worktrees/my-project",
        timestamp: "2026-04-22T12:00:01.000Z",
        message: { role: "user", content: "hello" },
      }),
    ]);
    expect(withCwd.session.cwd).toBe("/example/worktrees/my-project");
    expect(withCwd.session.name).toBe("my-project");

    // A folder the caller already knows names a session whose records carry none yet.
    const known = createHistorySessionSnapshot({
      path, content: header.join("\n"), adapterType: "claude-code", baseTimestampMs: 0, cwd: "/example/worktrees/my-project",
    }).snapshot.session;
    expect([known.cwd, known.name]).toEqual(["/example/worktrees/my-project", "my-project"]);
  });

  test("a recorded folder beats a decoded project folder name that happens to exist", () => {
    const root = mkdtempSync(join(tmpdir(), "historycwd"));
    try {
      // Both root/my/project and root/my-project exist; the transcript recorded the second.
      mkdirSync(join(root, "my", "project"), { recursive: true });
      const recorded = join(root, "my-project");
      const path = join(root, ".claude", "projects", recorded.replace(/[/.]/g, "-"), "session-both.jsonl");
      const content = JSON.stringify({
        type: "user", sessionId: "session-both", cwd: recorded,
        timestamp: "2026-04-22T12:00:01.000Z", message: { role: "user", content: "hello" },
      });
      const session = createHistorySessionSnapshot({ path, content, adapterType: "claude-code", baseTimestampMs: 0 }).snapshot.session;
      expect([session.cwd, session.name]).toEqual([recorded, "my-project"]);

      // With no record of its own, an existing decoded folder is the last resort.
      const header = JSON.stringify({ type: "mode", mode: "normal", sessionId: "session-both" });
      expect(createHistorySessionSnapshot({ path, content: header, adapterType: "claude-code", baseTimestampMs: 0 }).snapshot.session.cwd)
        .toBe(join(root, "my", "project"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("names a pi session after the folder its session record holds", () => {
    const path = "/example/home/.pi/agent/sessions/--example-dev-my-tool--/2026-04-22_session.jsonl";
    const content = JSON.stringify({ type: "session", id: "pi-1", cwd: "/example/dev/my-tool", timestamp: "2026-04-22T12:00:00.000Z" });
    const session = createHistorySessionSnapshot({ path, content, adapterType: "pi", baseTimestampMs: 0 }).snapshot.session;
    expect([session.cwd, session.name]).toEqual(["/example/dev/my-tool", "my-tool"]);
  });

  test("reconstructs a unified Claude Code snapshot from external jsonl history", () => {
    const basePath = "/Users/guest/.claude/projects/-Users-guest-dev-openscout/session-123.jsonl";
    const content = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        timestamp: "2026-04-22T12:00:00.000Z",
        session_id: "claude-upstream-session",
        cwd: "/Users/guest/dev/openscout",
        model: "claude-sonnet-test",
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-04-22T12:00:01.000Z",
        message: { role: "user", content: "summarize the repo" },
      }),
      JSON.stringify({
        type: "stream_event",
        timestamp: "2026-04-22T12:00:02.000Z",
        event: { type: "message_start" },
      }),
      JSON.stringify({
        type: "stream_event",
        timestamp: "2026-04-22T12:00:02.100Z",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        timestamp: "2026-04-22T12:00:02.200Z",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "hello " },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        timestamp: "2026-04-22T12:00:02.300Z",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "world" },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        timestamp: "2026-04-22T12:00:02.400Z",
        event: { type: "content_block_stop", index: 0 },
      }),
      JSON.stringify({
        type: "tool_use",
        timestamp: "2026-04-22T12:00:03.000Z",
        tool_name: "Bash",
        tool_use_id: "tool-bash-1",
        input: { command: "pwd" },
      }),
      JSON.stringify({
        type: "tool_result",
        timestamp: "2026-04-22T12:00:03.500Z",
        tool_use_id: "tool-bash-1",
        content: "/Users/guest/dev/openscout",
      }),
      JSON.stringify({
        type: "tool_use",
        timestamp: "2026-04-22T12:00:04.000Z",
        tool_name: "AskUserQuestion",
        tool_use_id: "tool-question-1",
        input: {
          questions: [
            {
              header: "Next step",
              question: "Ship it?",
              options: [{ label: "Yes" }, { label: "No" }],
              multiSelect: false,
            },
          ],
        },
      }),
      JSON.stringify({
        type: "tool_result",
        timestamp: "2026-04-22T12:00:04.500Z",
        tool_use_id: "tool-question-1",
        content: "Yes",
      }),
      JSON.stringify({
        type: "result",
        timestamp: "2026-04-22T12:00:05.000Z",
        subtype: "success",
        is_error: false,
      }),
    ].join("\n");

    const result = createHistorySessionSnapshot({
      path: basePath,
      content,
    });

    expect(result.adapterType).toBe("claude-code");
    expect(result.lineCount).toBe(12);
    expect(result.parsedLineCount).toBe(12);
    expect(result.skippedLineCount).toBe(0);

    const snapshot = result.snapshot;
    expect(snapshot.session.id).toBe(`history:${basePath}`);
    expect(snapshot.session.adapterType).toBe("claude-code");
    expect(snapshot.session.name).toBe("openscout");
    expect(snapshot.session.cwd).toBe("/Users/guest/dev/openscout");
    expect(snapshot.session.model).toBe("claude-sonnet-test");
    expect(snapshot.session.providerMeta).toEqual(
      expect.objectContaining({
        historyPath: basePath,
        historyAdapterType: "claude-code",
        source: "external_history",
        externalSessionId: "claude-upstream-session",
      }),
    );
    expect(snapshot.currentTurnId).toBeUndefined();
    expect(snapshot.turns).toHaveLength(1);

    const turn = snapshot.turns[0]!;
    expect(turn.status).toBe("completed");
    expect(turn.startedAt).toBe(Date.parse("2026-04-22T12:00:01.000Z"));
    expect(turn.endedAt).toBe(Date.parse("2026-04-22T12:00:05.000Z"));
    expect(turn.blocks).toHaveLength(3);

    const textBlock = turn.blocks[0]!.block;
    expect(textBlock.type).toBe("text");
    if (textBlock.type === "text") {
      expect(textBlock.text).toBe("hello world");
      expect(textBlock.status).toBe("completed");
    }

    const commandBlock = turn.blocks[1]!.block;
    expect(commandBlock.type).toBe("action");
    if (commandBlock.type === "action") {
      expect(commandBlock.action.kind).toBe("command");
      expect(commandBlock.action.status).toBe("completed");
      expect(commandBlock.action.output).toBe("/Users/guest/dev/openscout");
    }

    const questionBlock = turn.blocks[2]!.block;
    expect(questionBlock.type).toBe("question");
    if (questionBlock.type === "question") {
      expect(questionBlock.question).toBe("Ship it?");
      expect(questionBlock.questionStatus).toBe("answered");
      expect(questionBlock.answer).toEqual(["Yes"]);
      expect(questionBlock.status).toBe("completed");
    }
  });

  test("populates Claude context usage from latest assistant input and inferred model window", () => {
    const basePath = "/Users/guest/.claude/projects/-Users-guest-dev-openscout/session-usage.jsonl";
    const content = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        timestamp: "2026-04-22T12:00:00.000Z",
        session_id: "claude-usage-session",
        cwd: "/Users/guest/dev/openscout",
        model: "claude-opus-4-8",
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-04-22T12:00:01.000Z",
        message: { role: "user", content: "summarize the repo" },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-22T12:00:02.000Z",
        message: {
          id: "msg-first",
          role: "assistant",
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "first" }],
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 20,
            output_tokens: 5,
            service_tier: "standard",
          },
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-22T12:00:03.000Z",
        message: {
          id: "msg-latest",
          role: "assistant",
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "latest" }],
          usage: {
            input_tokens: 30,
            cache_read_input_tokens: 300,
            cache_creation_input_tokens: 40,
            output_tokens: 7,
            speed: "standard",
          },
        },
      }),
      JSON.stringify({
        type: "result",
        timestamp: "2026-04-22T12:00:04.000Z",
        subtype: "success",
        is_error: false,
      }),
    ].join("\n");

    const result = createHistorySessionSnapshot({
      path: basePath,
      content,
    });

    expect(result.snapshot.session.providerMeta).toEqual(expect.objectContaining({
      observeUsage: expect.objectContaining({
        assistantMessages: 2,
        inputTokens: 40,
        outputTokens: 12,
        cacheReadInputTokens: 400,
        cacheCreationInputTokens: 60,
        totalTokens: 512,
        contextInputTokens: 370,
        contextWindowTokens: 1_000_000,
        serviceTier: "standard",
        speed: "standard",
      }),
    }));
  });

  test("replays embedded assistant tool_use and user tool_result records without inflating turns", () => {
    const basePath = "/Users/guest/.claude/projects/-Users-guest-dev-openscout/session-embedded.jsonl";
    const content = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        timestamp: "2026-04-25T23:00:00.000Z",
        session_id: "claude-embedded-session",
        cwd: "/Users/guest/dev/openscout",
        model: "claude-opus-4-8",
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-04-25T23:00:01.000Z",
        message: { role: "user", content: "inspect the repo" },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-25T23:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Looking around." },
            {
              type: "tool_use",
              id: "toolu_bash_1",
              name: "Bash",
              input: { command: "pwd" },
            },
          ],
          stop_reason: "tool_use",
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-04-25T23:00:03.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_bash_1",
              content: "/Users/guest/dev/openscout",
              is_error: false,
            },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-25T23:00:04.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          stop_reason: "end_turn",
        },
      }),
    ].join("\n");

    const result = createHistorySessionSnapshot({
      path: basePath,
      content,
    });

    expect(result.lineCount).toBe(5);
    expect(result.parsedLineCount).toBe(5);
    expect(result.skippedLineCount).toBe(0);

    const snapshot = result.snapshot;
    expect(snapshot.turns).toHaveLength(1);

    const turn = snapshot.turns[0]!;
    expect(turn.status).toBe("completed");
    expect(turn.blocks).toHaveLength(3);

    const reasoningBlock = turn.blocks[0]!.block;
    expect(reasoningBlock.type).toBe("reasoning");
    if (reasoningBlock.type === "reasoning") {
      expect(reasoningBlock.text).toBe("Looking around.");
      expect(reasoningBlock.status).toBe("completed");
    }

    const actionBlock = turn.blocks[1]!.block;
    expect(actionBlock.type).toBe("action");
    if (actionBlock.type === "action") {
      expect(actionBlock.action.kind).toBe("command");
      expect(actionBlock.action.status).toBe("completed");
      expect(actionBlock.action.output).toBe("/Users/guest/dev/openscout");
    }

    const textBlock = turn.blocks[2]!.block;
    expect(textBlock.type).toBe("text");
    if (textBlock.type === "text") {
      expect(textBlock.text).toBe("Done.");
      expect(textBlock.status).toBe("completed");
    }
  });

  test("captures observe runtime and deduped usage metadata from Claude history", () => {
    const basePath = "/Users/guest/.claude/projects/-Users-guest-dev-openscout/session-observe-meta.jsonl";
    const content = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        timestamp: "2026-04-25T23:00:00.000Z",
        session_id: "claude-observe-session",
        cwd: "/Users/guest/dev/openscout",
        model: "claude-opus-4-8",
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-04-25T23:00:01.000Z",
        message: { role: "user", content: "inspect the repo" },
        permissionMode: "bypassPermissions",
        userType: "external",
        entrypoint: "sdk-cli",
        version: "2.1.119",
        gitBranch: "master",
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-25T23:00:02.000Z",
        message: {
          id: "msg-1",
          role: "assistant",
          model: "claude-opus-4-8",
          content: [{ type: "thinking", thinking: "Looking around." }],
          stop_reason: "tool_use",
          service_tier: "standard",
          speed: "standard",
          usage: {
            input_tokens: 7,
            output_tokens: 11,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 50,
            server_tool_use: {
              web_search_requests: 1,
              web_fetch_requests: 0,
            },
          },
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-25T23:00:02.100Z",
        message: {
          id: "msg-1",
          role: "assistant",
          model: "claude-opus-4-8",
          content: [
            {
              type: "tool_use",
              id: "toolu_bash_1",
              name: "Bash",
              input: { command: "pwd" },
            },
          ],
          stop_reason: "tool_use",
          service_tier: "standard",
          speed: "standard",
          usage: {
            input_tokens: 7,
            output_tokens: 11,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 50,
            server_tool_use: {
              web_search_requests: 1,
              web_fetch_requests: 0,
            },
          },
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-04-25T23:00:03.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_bash_1",
              content: "/Users/guest/dev/openscout",
              is_error: false,
            },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-25T23:00:04.000Z",
        message: {
          id: "msg-2",
          role: "assistant",
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "Done." }],
          stop_reason: "end_turn",
          service_tier: "standard",
          speed: "standard",
          usage: {
            input_tokens: 5,
            output_tokens: 13,
            cache_read_input_tokens: 25,
            cache_creation_input_tokens: 10,
            server_tool_use: {
              web_search_requests: 0,
              web_fetch_requests: 1,
            },
          },
        },
      }),
    ].join("\n");

    const result = createHistorySessionSnapshot({
      path: basePath,
      content,
    });

    expect(result.snapshot.turns).toHaveLength(1);
    expect(result.snapshot.session.providerMeta).toEqual(
      expect.objectContaining({
        observeRuntime: expect.objectContaining({
          permissionMode: "bypassPermissions",
          userType: "external",
          entrypoint: "sdk-cli",
          cliVersion: "2.1.119",
          gitBranch: "master",
        }),
        observeUsage: expect.objectContaining({
          assistantMessages: 2,
          inputTokens: 12,
          outputTokens: 24,
          cacheReadInputTokens: 125,
          cacheCreationInputTokens: 60,
          webSearchRequests: 1,
          webFetchRequests: 1,
          serviceTier: "standard",
          speed: "standard",
        }),
      }),
    );
  });

  test("reconstructs a Codex snapshot from external jsonl history", () => {
    const basePath = "/Users/guest/.codex/sessions/2026/05/29/rollout-2026-05-29T21-08-19-codex-session.jsonl";
    const content = [
      JSON.stringify({
        timestamp: "2026-05-30T01:08:36.827Z",
        type: "session_meta",
        payload: {
          id: "codex-session",
          cwd: "/Users/guest/dev/openscout",
          originator: "Codex Desktop",
          cli_version: "0.133.0-alpha.1",
          source: "vscode",
          thread_source: "user",
          model_provider: "openai",
          git: {
            branch: "codex/embed-vox-transcription",
            commit_hash: "abc123",
            repository_url: "https://github.com/openscout-app/scout.git",
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-30T01:08:36.827Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn-codex-1",
          started_at: 1780103316,
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-30T01:08:36.839Z",
        type: "turn_context",
        payload: {
          cwd: "/Users/guest/dev/openscout",
          model: "gpt-5.5",
          approval_policy: "never",
          timezone: "America/Toronto",
          effort: "xhigh",
          sandbox_policy: { type: "danger-full-access" },
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-30T01:08:36.848Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "inspect the repo",
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-30T01:08:51.653Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "I am checking the repo.",
          phase: "commentary",
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-30T01:09:12.371Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: "pwd",
            workdir: "/Users/guest/dev/openscout",
          }),
          call_id: "call-shell-1",
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-30T01:09:12.782Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-shell-1",
          output: "Exit code: 0\nOutput:\n/Users/guest/dev/openscout\n",
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-30T01:09:13.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          input: "*** Begin Patch\n*** End Patch\n",
          call_id: "call-patch-1",
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-30T01:09:13.100Z",
        type: "event_msg",
        payload: {
          type: "patch_apply_end",
          call_id: "call-patch-1",
          stdout: "Success. Updated the following files:\nM file.ts\n",
          stderr: "",
          success: true,
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-30T01:09:14.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            model_context_window: 200000,
            total_token_usage: {
              input_tokens: 400000,
              cached_input_tokens: 40,
              output_tokens: 20,
              reasoning_output_tokens: 7,
            },
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 40,
              output_tokens: 20,
              reasoning_output_tokens: 7,
            },
          },
          rate_limits: {
            plan_type: "plus",
            primary: {
              used_percent: 64,
              reset_after_seconds: 1800,
              window_minutes: 300,
            },
            secondary: {
              percent_remaining: 72,
              reset_at: "2026-06-06T00:00:00.000Z",
              window_seconds: 604800,
            },
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-30T01:09:15.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          completed_at: 1780103355,
        },
      }),
    ].join("\n");

    expect(inferHistorySessionAdapterType(basePath)).toBe("codex");
    expect(supportsHistorySessionSnapshotForPath(basePath)).toBe(true);

    const result = createHistorySessionSnapshot({
      path: basePath,
      content,
    });

    expect(result.adapterType).toBe("codex");
    expect(result.lineCount).toBe(11);
    expect(result.parsedLineCount).toBe(11);
    expect(result.skippedLineCount).toBe(0);

    const snapshot = result.snapshot;
    expect(snapshot.session.adapterType).toBe("codex");
    expect(snapshot.session.name).toBe("openscout");
    expect(snapshot.session.cwd).toBe("/Users/guest/dev/openscout");
    expect(snapshot.session.model).toBe("gpt-5.5");
    expect(snapshot.session.providerMeta).toEqual(
      expect.objectContaining({
        historyPath: basePath,
        historyAdapterType: "codex",
        source: "external_history",
        externalSessionId: "codex-session",
        observeRuntime: expect.objectContaining({
          originator: "Codex Desktop",
          cliVersion: "0.133.0-alpha.1",
          modelProvider: "openai",
          approvalPolicy: "never",
          gitBranch: "codex/embed-vox-transcription",
        }),
        observeUsage: expect.objectContaining({
          // last.input_tokens only — cached is a subset, not additive
          contextInputTokens: 100,
          inputTokens: 400000,
          outputTokens: 20,
          reasoningOutputTokens: 7,
          cacheReadInputTokens: 40,
          totalTokens: 400020,
          contextWindowTokens: 200000,
          planType: "plus",
          tokenEvents: 1,
        }),
        observeQuota: expect.objectContaining({
          provider: "openai",
          planType: "plus",
          windows: [
            expect.objectContaining({
              label: "5h",
              windowKind: "primary",
              usedPercent: 64,
              resetAt: Date.parse("2026-05-30T01:39:14.000Z"),
              windowMs: 300 * 60 * 1000,
            }),
            expect.objectContaining({
              // label derived from window_seconds (7d), not hardcoded "weekly"
              label: "7d",
              windowKind: "secondary",
              percentRemaining: 72,
              resetAt: Date.parse("2026-06-06T00:00:00.000Z"),
              windowMs: 604800 * 1000,
            }),
          ],
        }),
      }),
    );
    expect(snapshot.currentTurnId).toBeUndefined();
    expect(snapshot.turns).toHaveLength(1);

    const turn = snapshot.turns[0]!;
    expect(turn.status).toBe("completed");
    expect(turn.blocks).toHaveLength(3);

    const textBlock = turn.blocks[0]!.block;
    expect(textBlock.type).toBe("text");
    if (textBlock.type === "text") {
      expect(textBlock.text).toBe("I am checking the repo.");
    }

    const commandBlock = turn.blocks[1]!.block;
    expect(commandBlock.type).toBe("action");
    if (commandBlock.type === "action") {
      expect(commandBlock.action.kind).toBe("command");
      expect(commandBlock.action.status).toBe("completed");
      expect(commandBlock.action.output).toContain("/Users/guest/dev/openscout");
    }

    const patchBlock = turn.blocks[2]!.block;
    expect(patchBlock.type).toBe("action");
    if (patchBlock.type === "action") {
      expect(patchBlock.action.kind).toBe("tool_call");
      expect(patchBlock.action.status).toBe("completed");
      expect(patchBlock.action.output).toContain("Success. Updated");
    }
  });

  test("keeps Codex host metadata out of visible assistant text", () => {
    const basePath = "/Users/guest/.codex/sessions/2026/07/03/codex-host-metadata.jsonl";
    const assistantText = [
      "Committed, pushed, and merged.",
      "",
      "::git-stage{cwd=\"/Users/guest/dev/openscout\"}",
      "::git-commit{cwd=\"/Users/guest/dev/openscout\"}",
      "::git-push{cwd=\"/Users/guest/dev/openscout\" branch=\"codex/project-level-view\"}",
      "",
      "<oai-mem-citation>",
      "<citation_entries>",
      "MEMORY.md:1-47|note=[Projects surface constraints]",
      "</citation_entries>",
      "<rollout_ids>",
      "019f25c1-3d6d-7640-ab25-f8a589f7e573",
      "</rollout_ids>",
      "</oai-mem-citation>",
    ].join("\n");
    const content = [
      JSON.stringify({
        timestamp: "2026-07-03T16:30:00.000Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn-codex-host-metadata",
          started_at: 1783096200,
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-03T16:30:02.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: assistantText,
          phase: "final",
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-03T16:30:03.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: assistantText }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-03T16:30:04.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          completed_at: 1783096204,
        },
      }),
    ].join("\n");

    const result = createHistorySessionSnapshot({
      path: basePath,
      content,
    });

    const turn = result.snapshot.turns[0]!;
    expect(turn.blocks).toHaveLength(1);
    const block = turn.blocks[0]!.block;
    expect(block.type).toBe("text");
    if (block.type === "text") {
      expect(block.text).toBe("Committed, pushed, and merged.");
      expect(block.text).not.toContain("oai-mem-citation");
      expect(block.text).not.toContain("::git-");
    }

    expect(result.snapshot.session.providerMeta).toEqual(expect.objectContaining({
      observeHostMetadata: expect.objectContaining({
        directives: [
          expect.objectContaining({ name: "git-stage" }),
          expect.objectContaining({ name: "git-commit" }),
          expect.objectContaining({ name: "git-push" }),
        ],
        memoryCitations: [
          expect.objectContaining({
            citationEntries: ["MEMORY.md:1-47|note=[Projects surface constraints]"],
            rolloutIds: ["019f25c1-3d6d-7640-ab25-f8a589f7e573"],
          }),
        ],
      }),
    }));
  });

  test("infers a Codex model window when token logs omit the denominator", () => {
    const basePath = "/Users/guest/.codex/sessions/2026/05/30/codex-no-window.jsonl";
    const content = [
      JSON.stringify({
        timestamp: "2026-05-30T01:09:00.000Z",
        type: "turn_context",
        payload: {
          cwd: "/Users/guest/dev/openscout",
          model: "gpt-5.5",
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-30T01:09:01.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 900000,
              output_tokens: 50,
              total_tokens: 900050,
            },
            last_token_usage: {
              input_tokens: 12345,
              output_tokens: 50,
              total_tokens: 12395,
            },
          },
        },
      }),
    ].join("\n");

    const result = createHistorySessionSnapshot({
      path: basePath,
      content,
    });

    expect(result.snapshot.session.providerMeta).toEqual(expect.objectContaining({
      observeUsage: expect.objectContaining({
        inputTokens: 900000,
        totalTokens: 900050,
        contextInputTokens: 12345,
        contextWindowTokens: 258400,
      }),
    }));
  });

  test("reconstructs Pi JSONL history into an observable session", () => {
    const path = "/Users/you/Library/Application Support/OpenScout/runtime/agents/review/pi-sessions/2026-06-02T15-42-59-840Z_relay-review-pi.jsonl";
    const content = [
      JSON.stringify({
        type: "session",
        id: "relay-review-pi",
        timestamp: "2026-06-02T15:42:59.840Z",
        cwd: "/Users/you/dev/lattices",
      }),
      JSON.stringify({
        type: "model_change",
        timestamp: "2026-06-02T15:43:00.593Z",
        provider: "minimax",
        modelId: "MiniMax-M3",
      }),
      JSON.stringify({
        type: "thinking_level_change",
        timestamp: "2026-06-02T15:43:00.594Z",
        thinkingLevel: "low",
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-06-02T15:43:05.340Z",
        message: {
          role: "assistant",
          provider: "minimax",
          model: "MiniMax-M3",
          content: [
            { type: "thinking", thinking: "Need to inspect status." },
            { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd && git status --short" } },
          ],
          usage: { input: 10, output: 4, cacheRead: 2, totalTokens: 16 },
          stopReason: "toolUse",
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-06-02T15:43:05.397Z",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          content: [{ type: "text", text: "/Users/you/dev/lattices\n" }],
          isError: false,
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-06-02T15:43:08.581Z",
        message: {
          role: "assistant",
          provider: "minimax",
          model: "MiniMax-M3",
          content: [{ type: "text", text: "FINAL: clean." }],
          stopReason: "stop",
        },
      }),
    ].join("\n");

    expect(inferHistorySessionAdapterType(path)).toBe("pi");
    expect(supportsHistorySessionSnapshotForPath(path)).toBe(true);

    const result = createHistorySessionSnapshot({ path, content });
    expect(result.adapterType).toBe("pi");
    expect(result.parsedLineCount).toBe(6);
    expect(result.skippedLineCount).toBe(0);
    expect(result.snapshot.session.adapterType).toBe("pi");
    expect(result.snapshot.session.cwd).toBe("/Users/you/dev/lattices");
    expect(result.snapshot.session.model).toBe("MiniMax-M3");
    expect(result.snapshot.session.providerMeta).toEqual(expect.objectContaining({
      externalSessionId: "relay-review-pi",
      threadId: "relay-review-pi",
      threadPath: path,
      provider: "minimax",
      observeRuntime: expect.objectContaining({ effort: "low", modelProvider: "minimax" }),
      observeUsage: expect.objectContaining({
        inputTokens: 10,
        outputTokens: 4,
        cacheReadInputTokens: 2,
        totalTokens: 16,
      }),
    }));

    expect(result.snapshot.turns).toHaveLength(2);
    const actionBlock = result.snapshot.turns[0]?.blocks.find((block) => block.block.type === "action")?.block;
    expect(actionBlock?.type).toBe("action");
    if (actionBlock?.type === "action") {
      expect(actionBlock.action.kind).toBe("command");
      expect(actionBlock.action.status).toBe("completed");
      expect(actionBlock.action.output).toContain("/Users/you/dev/lattices");
    }
    const finalText = result.snapshot.turns[1]?.blocks.find((block) => block.block.type === "text")?.block;
    expect(finalText?.type).toBe("text");
    if (finalText?.type === "text") {
      expect(finalText.text).toBe("FINAL: clean.");
    }
  });

  test("marks unsupported harness history clearly", () => {
    const path = "/Users/guest/.unknown/history.jsonl";

    expect(inferHistorySessionAdapterType(path)).toBe("unknown");
    expect(supportsHistorySessionSnapshotForPath(path)).toBe(false);
    expect(() =>
      createHistorySessionSnapshot({
        path,
        content: `${JSON.stringify({ cwd: "/tmp/project" })}\n`,
      }),
    ).toThrow('History snapshot is not supported for adapter type "unknown".');
  });
});
