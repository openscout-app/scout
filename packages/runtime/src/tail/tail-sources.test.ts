import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetTailThinkingModeCache } from "../user-config.js";
import { ClaudeSource } from "./claude-source.js";
import { CodexSource } from "./codex-source.js";
import { CursorSource } from "./cursor-source.js";
import { DevinSource } from "./devin-source.js";
import { isTailNoiseEvent } from "./display.js";
import { GrokSource } from "./grok-source.js";
import { KimiSource } from "./kimi-source.js";
import { OpenCodeSource } from "./opencode-source.js";
import { PiSource } from "./pi-source.js";
import type { DiscoveredProcess, DiscoveredTranscript, TailContext } from "./types.js";

const originalClaudeRoot = process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT;
const originalCodexRoot = process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT;
const originalCursorRoot = process.env.OPENSCOUT_TAIL_CURSOR_PROCESS_MONITOR_ROOT;
const originalGrokRoot = process.env.OPENSCOUT_TAIL_GROK_SESSIONS_ROOT;
const originalKimiRoot = process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT;
const originalOpenCodeRoot = process.env.OPENSCOUT_TAIL_OPENCODE_STORAGE_ROOT;
const originalOpenCodeMessages = process.env.OPENSCOUT_TAIL_OPENCODE_MESSAGES_PER_SESSION;
const originalPiRoot = process.env.OPENSCOUT_TAIL_PI_SESSIONS_ROOT;
const originalDevinRoot = process.env.OPENSCOUT_TAIL_DEVIN_TRANSCRIPTS_ROOT;
const originalDevinDb = process.env.OPENSCOUT_TAIL_DEVIN_SESSIONS_DB;
const originalWindow = process.env.OPENSCOUT_TAIL_DISCOVERY_WINDOW_MS;
const originalLimit = process.env.OPENSCOUT_TAIL_DISCOVERY_LIMIT;

let tempRoot = "";

function restoreEnv(): void {
  if (originalClaudeRoot === undefined) delete process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT;
  else process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT = originalClaudeRoot;
  if (originalCodexRoot === undefined) delete process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT;
  else process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT = originalCodexRoot;
  if (originalCursorRoot === undefined) delete process.env.OPENSCOUT_TAIL_CURSOR_PROCESS_MONITOR_ROOT;
  else process.env.OPENSCOUT_TAIL_CURSOR_PROCESS_MONITOR_ROOT = originalCursorRoot;
  if (originalGrokRoot === undefined) delete process.env.OPENSCOUT_TAIL_GROK_SESSIONS_ROOT;
  else process.env.OPENSCOUT_TAIL_GROK_SESSIONS_ROOT = originalGrokRoot;
  if (originalKimiRoot === undefined) delete process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT;
  else process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT = originalKimiRoot;
  if (originalOpenCodeRoot === undefined) delete process.env.OPENSCOUT_TAIL_OPENCODE_STORAGE_ROOT;
  else process.env.OPENSCOUT_TAIL_OPENCODE_STORAGE_ROOT = originalOpenCodeRoot;
  if (originalOpenCodeMessages === undefined) delete process.env.OPENSCOUT_TAIL_OPENCODE_MESSAGES_PER_SESSION;
  else process.env.OPENSCOUT_TAIL_OPENCODE_MESSAGES_PER_SESSION = originalOpenCodeMessages;
  if (originalPiRoot === undefined) delete process.env.OPENSCOUT_TAIL_PI_SESSIONS_ROOT;
  else process.env.OPENSCOUT_TAIL_PI_SESSIONS_ROOT = originalPiRoot;
  if (originalDevinRoot === undefined) delete process.env.OPENSCOUT_TAIL_DEVIN_TRANSCRIPTS_ROOT;
  else process.env.OPENSCOUT_TAIL_DEVIN_TRANSCRIPTS_ROOT = originalDevinRoot;
  if (originalDevinDb === undefined) delete process.env.OPENSCOUT_TAIL_DEVIN_SESSIONS_DB;
  else process.env.OPENSCOUT_TAIL_DEVIN_SESSIONS_DB = originalDevinDb;
  if (originalWindow === undefined) delete process.env.OPENSCOUT_TAIL_DISCOVERY_WINDOW_MS;
  else process.env.OPENSCOUT_TAIL_DISCOVERY_WINDOW_MS = originalWindow;
  if (originalLimit === undefined) delete process.env.OPENSCOUT_TAIL_DISCOVERY_LIMIT;
  else process.env.OPENSCOUT_TAIL_DISCOVERY_LIMIT = originalLimit;
}

function makeProcess(source: string, cwd: string): DiscoveredProcess {
  return {
    pid: 123,
    ppid: 1,
    command: `${source} app-server`,
    etime: "01:00",
    cwd,
    harness: "scout-managed",
    parentChain: [],
    source,
  };
}

function makeContext(source: string, transcript: DiscoveredTranscript): TailContext {
  return {
    process: makeProcess(source, transcript.cwd ?? "/tmp/project"),
    transcript,
    transcriptPath: transcript.transcriptPath,
    lineOffset: 7,
  };
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "openscout-tail-sources-"));
  process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT = join(tempRoot, "claude-projects");
  process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT = join(tempRoot, "codex-sessions");
  process.env.OPENSCOUT_TAIL_CURSOR_PROCESS_MONITOR_ROOT = join(tempRoot, "cursor-process-monitor");
  process.env.OPENSCOUT_TAIL_GROK_SESSIONS_ROOT = join(tempRoot, "grok-sessions");
  process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT = join(tempRoot, "kimi-sessions");
  process.env.OPENSCOUT_TAIL_OPENCODE_STORAGE_ROOT = join(tempRoot, "opencode-storage");
  process.env.OPENSCOUT_TAIL_OPENCODE_MESSAGES_PER_SESSION = "10";
  process.env.OPENSCOUT_TAIL_DISCOVERY_WINDOW_MS = String(60 * 60 * 1000);
  process.env.OPENSCOUT_TAIL_DISCOVERY_LIMIT = "20";
  process.env.OPENSCOUT_TAIL_PI_SESSIONS_ROOT = join(tempRoot, "pi-sessions");
  process.env.OPENSCOUT_TAIL_DEVIN_TRANSCRIPTS_ROOT = join(tempRoot, "devin-cli", "transcripts");
  process.env.OPENSCOUT_TAIL_DEVIN_SESSIONS_DB = join(tempRoot, "devin-cli", "sessions.db");
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  restoreEnv();
});

describe("tail transcript sources", () => {
  test("discovers and parses Claude transcript files without process discovery", () => {
    const projectDir = join(process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT!, "-Users-arach-dev-openscout");
    mkdirSync(projectDir, { recursive: true });
    const transcriptPath = join(projectDir, "claude-session.jsonl");
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: "system",
          timestamp: "2026-04-27T15:00:00.000Z",
          session_id: "claude-session",
          cwd: "/Users/arach/dev/openscout",
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-04-27T15:00:01.000Z",
          message: { content: [{ type: "text", text: "hello from claude" }] },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const transcripts = ClaudeSource.discoverTranscripts([]);
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]?.cwd).toBe("/Users/arach/dev/openscout");
    expect(transcripts[0]?.sessionId).toBe("claude-session");
    expect(transcripts[0]?.lastEventAt).toBe(Date.parse("2026-04-27T15:00:01.000Z"));
    expect(transcripts[0]?.mtimeMs).toBeGreaterThan(transcripts[0]?.lastEventAt ?? 0);

    const event = ClaudeSource.parseLine(
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-27T15:00:01.000Z",
        message: { id: "msg-1", content: [{ type: "text", text: "hello from claude" }] },
      }),
      makeContext("claude", transcripts[0]!),
    );
    expect(event?.source).toBe("claude");
    expect(event?.sessionId).toBe("claude-session");
    expect(event?.kind).toBe("assistant");
    expect(event?.summary).toBe("hello from claude");
  });

  test("drops Claude lines without a parseable timestamp during replay", () => {
    const transcript = {
      source: "claude" as const,
      transcriptPath: "/tmp/claude/no-ts.jsonl",
      sessionId: "claude-no-ts",
      cwd: "/Users/arach/dev/openscout",
      project: "openscout",
      harness: "unattributed" as const,
      mtimeMs: Date.now(),
      size: 100,
    };
    const event = ClaudeSource.parseLine(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ghost" }] } }),
      makeContext("claude", transcript),
    );
    expect(event).toBeNull();
  });

  test("uses transcript mtime to render timestamp-less Claude child-agent records", () => {
    const transcript: DiscoveredTranscript = {
      source: "claude",
      transcriptPath: "/tmp/claude/subagents/agent-worker123.jsonl",
      sessionId: "worker123",
      parentSessionId: "claude-parent",
      subagentId: "worker123",
      cwd: "/Users/arach/dev/openscout",
      project: "openscout",
      harness: "unattributed",
      mtimeMs: 1_700_000_000_000,
      size: 100,
    };

    const event = ClaudeSource.parseLine(
      JSON.stringify({
        type: "assistant",
        agentId: "worker123",
        message: { content: [{ type: "text", text: "I found the component." }] },
      }),
      makeContext("claude", transcript),
    );

    expect(event).toEqual(expect.objectContaining({
      sessionId: "worker123",
      kind: "assistant",
      summary: "I found the component.",
      ts: 1_700_000_000_007,
    }));
  });

  test("discovers active Claude child-agent transcripts separately from their parent session", () => {
    const projectDir = join(process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT!, "-Users-arach-dev-openscout");
    const subagentsDir = join(projectDir, "claude-session", "subagents");
    const workflowDir = join(subagentsDir, "workflows", "wf_fixture");
    mkdirSync(workflowDir, { recursive: true });
    const transcriptPath = join(projectDir, "claude-session.jsonl");
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: "system",
        timestamp: "2026-04-27T15:00:00.000Z",
        session_id: "claude-session",
        cwd: "/Users/arach/dev/openscout",
      }) + "\n",
      "utf8",
    );
    writeFileSync(
      join(workflowDir, "journal.jsonl"),
      [
        JSON.stringify({ type: "started", agentId: "a111" }),
        JSON.stringify({ type: "result", agentId: "a111", result: { ok: true } }),
      ].join("\n") + "\n",
      "utf8",
    );
    writeFileSync(
      join(subagentsDir, "agent-worker123.jsonl"),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-27T15:00:02.000Z",
        agentId: "worker123",
        message: { content: [{ type: "text", text: "working" }] },
      }) + "\n",
      "utf8",
    );

    const transcripts = ClaudeSource.discoverTranscripts([]);
    expect(transcripts.map((transcript) => transcript.sessionId).sort()).toEqual(["claude-session", "worker123"]);
    expect(transcripts).toContainEqual(expect.objectContaining({
      sessionId: "worker123",
      parentSessionId: "claude-session",
      subagentId: "worker123",
      cwd: "/Users/arach/dev/openscout",
    }));
    expect(transcripts.some((transcript) => transcript.transcriptPath.endsWith("journal.jsonl"))).toBe(false);
  });

  test("discovers Kimi main and subagent wire logs and parses their activity", () => {
    const sessionId = "session_c77b8954-a27a-46ff-8470-887dbb81066d";
    const sessionDir = join(process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT!, "wd_openscout_bcafead09134", sessionId);
    const mainDir = join(sessionDir, "agents", "main");
    const subagentDir = join(sessionDir, "agents", "agent-0");
    mkdirSync(mainDir, { recursive: true });
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(join(sessionDir, "state.json"), JSON.stringify({
      workDir: "/Users/arach/dev/openscout",
      title: "Review the project",
      createdAt: "2026-07-16T12:00:00.000Z",
      updatedAt: "2026-07-16T12:00:05.000Z",
      agents: {
        main: { type: "main", parentAgentId: null },
        "agent-0": { type: "sub", parentAgentId: "main" },
      },
    }), "utf8");

    const mainPath = join(mainDir, "wire.jsonl");
    writeFileSync(mainPath, [
      JSON.stringify({
        type: "turn.prompt",
        input: [{ type: "text", text: "Inspect the tail service" }],
        origin: { kind: "user" },
        time: 1_784_224_000_000,
      }),
      JSON.stringify({
        type: "context.append_loop_event",
        time: 1_784_224_000_100,
        event: {
          type: "content.part",
          uuid: "thought-1",
          part: { type: "think", think: "I should inspect the source registry." },
        },
      }),
      JSON.stringify({
        type: "context.append_loop_event",
        time: 1_784_224_000_200,
        event: {
          type: "tool.call",
          uuid: "tool-call-event-1",
          toolCallId: "tool-1",
          name: "Read",
          args: { path: "/Users/arach/dev/openscout/packages/runtime/src/tail/service.ts" },
        },
      }),
      JSON.stringify({
        type: "context.append_loop_event",
        time: 1_784_224_000_300,
        event: {
          type: "tool.result",
          parentUuid: "tool-call-event-1",
          toolCallId: "tool-1",
          result: { output: "import { KimiSource } from './kimi-source.js';" },
        },
      }),
      JSON.stringify({
        type: "context.append_loop_event",
        time: 1_784_224_000_400,
        event: {
          type: "content.part",
          uuid: "answer-1",
          part: { type: "text", text: "Kimi logs are now in the firehose." },
        },
      }),
    ].join("\n") + "\n", "utf8");

    const subagentPath = join(subagentDir, "wire.jsonl");
    writeFileSync(subagentPath, JSON.stringify({
      type: "turn.prompt",
      input: [{ type: "text", text: "Inspect the parser" }],
      origin: { kind: "user" },
      time: 1_784_224_000_500,
    }) + "\n", "utf8");

    const transcripts = KimiSource.discoverTranscripts([]);
    expect(transcripts).toHaveLength(2);
    const main = transcripts.find((entry) => entry.transcriptPath === mainPath);
    const subagent = transcripts.find((entry) => entry.transcriptPath === subagentPath);
    expect(main).toEqual(expect.objectContaining({
      source: "kimi",
      sessionId,
      cwd: "/Users/arach/dev/openscout",
      project: "openscout",
    }));
    expect(subagent?.sessionId).toBe(`${sessionId}:agent-0`);

    const context = { ...makeContext("kimi", main!), state: {} as Record<string, unknown> };
    const lines = readFileSync(mainPath, "utf8").trim().split("\n");
    const events = lines.map((line, index) => KimiSource.parseLine(line, {
      ...context,
      lineOffset: index,
    }));

    expect(events.map((event) => event?.kind)).toEqual([
      "user",
      "system",
      "tool",
      "tool-result",
      "assistant",
    ]);
    expect(events[0]?.summary).toBe("Inspect the tail service");
    expect(events[1]?.summary).toBe("[thinking] I should inspect the source registry.");
    expect(events[2]?.summary).toBe("Read tail/service.ts");
    expect(events[3]?.summary).toBe("Read tail/service.ts -> res: import { KimiSource } from './kimi-source.js';");
    expect(events[4]?.id).toBe(`kimi:${sessionId}:context.append_loop_event:answer-1`);
    expect(events[4]?.summary).toBe("Kimi logs are now in the firehose.");
  });

  test("reads the working directory from version 2 Kimi state files", () => {
    const sessionId = "session_eafc4bb8-4573-401e-906c-28f1cfc50ff6";
    const sessionDir = join(process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT!, "wd_openscout_bcafead09134", sessionId);
    mkdirSync(join(sessionDir, "agents", "main"), { recursive: true });
    writeFileSync(join(sessionDir, "state.json"), JSON.stringify({
      id: sessionId,
      version: 2,
      cwd: "/Users/arach/dev/openscout",
      title: "Review the project",
    }), "utf8");
    writeFileSync(join(sessionDir, "agents", "main", "wire.jsonl"), JSON.stringify({
      type: "turn.prompt",
      input: [{ type: "text", text: "Inspect the tail service" }],
      origin: { kind: "user" },
      time: 1_784_224_000_000,
    }) + "\n", "utf8");

    expect(KimiSource.discoverTranscripts([])[0]).toEqual(expect.objectContaining({
      sessionId,
      cwd: "/Users/arach/dev/openscout",
      project: "openscout",
    }));
  });

  test("names the Kimi project from the workspace directory when state.json is unreadable", () => {
    const sessionDir = join(
      process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT!,
      "wd_openscout_bcafead09134",
      "session_2b022738-81f0-4f8f-9024-9f635ca7a5de",
    );
    mkdirSync(join(sessionDir, "agents", "main"), { recursive: true });
    writeFileSync(join(sessionDir, "agents", "main", "wire.jsonl"), JSON.stringify({
      type: "turn.prompt",
      input: [{ type: "text", text: "Inspect the tail service" }],
      origin: { kind: "user" },
      time: 1_784_224_000_000,
    }) + "\n", "utf8");

    expect(KimiSource.discoverTranscripts([])[0]).toEqual(expect.objectContaining({
      cwd: null,
      project: "openscout",
    }));

    writeFileSync(join(sessionDir, "state.json"), JSON.stringify({
      version: 2,
      cwd: "/Users/arach/dev/openscout",
    }), "utf8");
    expect(KimiSource.discoverTranscripts([])[0]).toEqual(expect.objectContaining({
      cwd: "/Users/arach/dev/openscout",
      project: "openscout",
    }));
  });

  test("maps Kimi permission, plan, compaction, and cancellation records", () => {
    const transcript: DiscoveredTranscript = {
      source: "kimi",
      transcriptPath: "/tmp/kimi/session_1/agents/main/wire.jsonl",
      sessionId: "session_1",
      cwd: "/Users/arach/dev/openscout",
      project: "openscout",
      harness: "unattributed",
      mtimeMs: Date.now(),
      size: 100,
    };
    const records = [
      { type: "permission.record_approval_result", toolName: "Bash", result: { decision: "approved" }, time: 1 },
      { type: "plan_mode.enter", time: 2 },
      { type: "context.apply_compaction", summary: "Earlier work was preserved.", time: 3 },
      { type: "turn.cancel", time: 4 },
    ];
    const events = records.map((record, index) => KimiSource.parseLine(
      JSON.stringify(record),
      { ...makeContext("kimi", transcript), lineOffset: index },
    ));
    expect(events.map((event) => event?.summary)).toEqual([
      "permission approved · Bash",
      "plan mode entered",
      "context compacted · Earlier work was preserved.",
      "turn cancelled",
    ]);
  });

  test("discovers and parses Codex rollout files without process discovery", () => {
    const sessionDir = join(process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT!, "2026", "04", "27");
    mkdirSync(sessionDir, { recursive: true });
    const transcriptPath = join(sessionDir, "rollout-2026-04-27T11-15-09-019dcf82-3383-71c1-a23d-49947b6b4b04.jsonl");
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: "2026-04-27T15:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "019dcf82-3383-71c1-a23d-49947b6b4b04",
            cwd: "/Users/arach/dev/openscout",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-27T15:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hello from codex" }],
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const transcripts = CodexSource.discoverTranscripts([]);
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]?.cwd).toBe("/Users/arach/dev/openscout");
    expect(transcripts[0]?.sessionId).toBe("019dcf82-3383-71c1-a23d-49947b6b4b04");

    const event = CodexSource.parseLine(
      JSON.stringify({
        timestamp: "2026-04-27T15:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello from codex" }],
        },
      }),
      makeContext("codex", transcripts[0]!),
    );
    expect(event?.source).toBe("codex");
    expect(event?.kind).toBe("assistant");
    expect(event?.summary).toBe("hello from codex");
  });

  test("joins Codex tool results to their tool calls by call_id", () => {
    const transcript = {
      source: "codex" as const,
      transcriptPath: "/tmp/codex/rollout-019dcf82-tool-join.jsonl",
      sessionId: "019dcf82-tool-join",
      cwd: "/Users/arach/dev/openscout",
      project: "openscout",
      harness: "unattributed" as const,
      mtimeMs: Date.now(),
      size: 100,
    };
    const ctx = {
      ...makeContext("codex", transcript),
      state: {} as Record<string, unknown>,
    };

    const call = CodexSource.parseLine(
      JSON.stringify({
        timestamp: "2026-04-27T15:00:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: "sed -n '1,70p' crates/scoutd/src/main.rs",
            workdir: "/Users/arach/dev/openscout",
          }),
          call_id: "call-sed-main",
        },
      }),
      ctx,
    );
    const result = CodexSource.parseLine(
      JSON.stringify({
        timestamp: "2026-04-27T15:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-sed-main",
          output: [
            "Chunk ID: abc123",
            "Wall time: 0.0100 seconds",
            "Process exited with code 0",
            "Output:",
            "use std::env;",
            "use std::fs;",
            "fn main() {",
            "  println!(\"scoutd\");",
            "}",
          ].join("\n"),
        },
      }),
      { ...ctx, lineOffset: 8 },
    );

    expect(call?.summary).toBe("sed -n '1,70p' crates/scoutd/src/main.rs");
    expect(result?.kind).toBe("tool-result");
    expect(result?.summary).toBe(
      "sed -n '1,70p' crates/scoutd/src/main.rs -> res: use std::env; use std::fs; fn main() { println!(\"scoutd\"); (5 lines)",
    );
  });

  test("uses stable Codex response item ids across repeated transcript offsets", () => {
    const transcript = {
      source: "codex" as const,
      transcriptPath: "/tmp/codex/rollout-019dcf82-stable-id.jsonl",
      sessionId: "019dcf82-stable-id",
      cwd: "/Users/arach/dev/openscout",
      project: "openscout",
      harness: "unattributed" as const,
      mtimeMs: Date.now(),
      size: 100,
    };
    const line = JSON.stringify({
      timestamp: "2026-04-27T15:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "msg_same",
        role: "assistant",
        content: [{ type: "output_text", text: "same visible line" }],
      },
    });

    const first = CodexSource.parseLine(line, {
      ...makeContext("codex", transcript),
      lineOffset: 7,
    });
    const second = CodexSource.parseLine(line, {
      ...makeContext("codex", transcript),
      lineOffset: 42,
    });

    expect(first?.id).toBe("codex:019dcf82-stable-id:response:message:msg_same");
    expect(second?.id).toBe(first?.id);
  });

  test("falls back to a result preview when a Codex output has no matching call in the parsed window", () => {
    const transcript = {
      source: "codex" as const,
      transcriptPath: "/tmp/codex/rollout-019dcf82-tool-miss.jsonl",
      sessionId: "019dcf82-tool-miss",
      cwd: "/Users/arach/dev/openscout",
      project: "openscout",
      harness: "unattributed" as const,
      mtimeMs: Date.now(),
      size: 100,
    };
    const event = CodexSource.parseLine(
      JSON.stringify({
        timestamp: "2026-04-27T15:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-missing",
          output: "alpha\nbeta\n",
        },
      }),
      {
        ...makeContext("codex", transcript),
        state: {},
      },
    );

    expect(event?.summary).toBe("res: alpha beta (2 lines)");
  });

  test("discovers and parses Grok event logs without process discovery", () => {
    const projectDir = join(
      process.env.OPENSCOUT_TAIL_GROK_SESSIONS_ROOT!,
      encodeURIComponent("/Users/art/dev/openscout"),
    );
    const sessionDir = join(projectDir, "019edd6b-fc26-7a53-a4a0-dd36c5378515");
    mkdirSync(sessionDir, { recursive: true });
    const transcriptPath = join(sessionDir, "events.jsonl");
    writeFileSync(
      join(sessionDir, "summary.json"),
      JSON.stringify({
        info: {
          id: "019edd6b-fc26-7a53-a4a0-dd36c5378515",
          cwd: "/Users/art/dev/openscout",
        },
        current_model_id: "grok-composer-2.5-fast",
      }),
      "utf8",
    );
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          ts: "2026-04-27T15:00:00.000Z",
          type: "turn_started",
          session_id: "019edd6b-fc26-7a53-a4a0-dd36c5378515",
          turn_number: 0,
          model_id: "grok-composer-2.5-fast",
        }),
        JSON.stringify({
          ts: "2026-04-27T15:00:01.000Z",
          type: "tool_started",
          session_id: "019edd6b-fc26-7a53-a4a0-dd36c5378515",
          tool_name: "Read",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const transcripts = GrokSource.discoverTranscripts([]);
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]?.source).toBe("grok");
    expect(transcripts[0]?.cwd).toBe("/Users/art/dev/openscout");
    expect(transcripts[0]?.sessionId).toBe("019edd6b-fc26-7a53-a4a0-dd36c5378515");

    const event = GrokSource.parseLine(
      JSON.stringify({
        ts: "2026-04-27T15:00:02.000Z",
        type: "tool_completed",
        session_id: "019edd6b-fc26-7a53-a4a0-dd36c5378515",
        tool_name: "Read",
        outcome: "success",
      }),
      makeContext("grok", transcripts[0]!),
    );
    expect(event?.source).toBe("grok");
    expect(event?.kind).toBe("tool-result");
    expect(event?.summary).toBe("Read completed · success");

    const phaseEvent = GrokSource.parseLine(
      JSON.stringify({
        ts: "2026-04-27T15:00:03.000Z",
        type: "phase_changed",
        session_id: "019edd6b-fc26-7a53-a4a0-dd36c5378515",
        phase: "tool_execution",
      }),
      makeContext("grok", transcripts[0]!),
    );
    expect(phaseEvent?.kind).toBe("system");
    expect(phaseEvent?.summary).toBe("phase · tool_execution");
  });

  test("emits a reply-only Grok turn's prompt and reply from updates.jsonl", () => {
    const sessionId = "019edd6b-reply-only";
    const sessionDir = join(
      process.env.OPENSCOUT_TAIL_GROK_SESSIONS_ROOT!,
      encodeURIComponent("/Users/art/dev/openscout"),
      sessionId,
    );
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "summary.json"),
      JSON.stringify({ info: { id: sessionId, cwd: "/Users/art/dev/openscout" } }),
      "utf8",
    );
    const update = (body: Record<string, unknown>) => JSON.stringify({
      timestamp: Date.parse("2026-04-27T15:00:01.000Z") / 1000,
      method: "_x.ai/session/update",
      params: { sessionId, update: body },
    });
    writeFileSync(
      join(sessionDir, "updates.jsonl"),
      [
        update({
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "Reply with exactly: ok" },
          _meta: { promptIndex: 0 },
        }),
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "o" } }),
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "k" } }),
        update({ sessionUpdate: "turn_completed", stop_reason: "end_turn" }),
      ].join("\n") + "\n",
      "utf8",
    );
    const lines = [
      { ts: "2026-04-27T15:00:01.000Z", type: "turn_started", session_id: sessionId, turn_number: 0, model_id: "grok-4.7" },
      { ts: "2026-04-27T15:00:01.100Z", type: "loop_started", loop_index: 0 },
      { ts: "2026-04-27T15:00:02.000Z", type: "turn_ended", outcome: "completed" },
    ].map((line) => JSON.stringify(line));
    writeFileSync(join(sessionDir, "events.jsonl"), lines.join("\n") + "\n", "utf8");

    const transcript = GrokSource.discoverTranscripts([]).find((entry) => entry.sessionId === sessionId);
    expect(transcript).toBeDefined();
    const ctx = makeContext("grok", transcript!);
    const events = lines.map((line, lineOffset) => GrokSource.parseLine(line, { ...ctx, lineOffset }));

    expect(events.map((event) => [event?.kind, event?.summary])).toEqual([
      ["system", "turn 0 · grok-4.7"],
      ["user", "Reply with exactly: ok"],
      ["assistant", "ok"],
    ]);
  });

  test("enriches Grok shell tool events with commands from updates.jsonl", () => {
    const projectDir = join(
      process.env.OPENSCOUT_TAIL_GROK_SESSIONS_ROOT!,
      encodeURIComponent("/Users/art/dev/openscout"),
    );
    const sessionDir = join(projectDir, "019edd6b-shell-enrich");
    mkdirSync(sessionDir, { recursive: true });
    const transcriptPath = join(sessionDir, "events.jsonl");
    const shellCommand = "curl -s http://127.0.0.1:43122/api/session-ref/test";
    writeFileSync(
      join(sessionDir, "summary.json"),
      JSON.stringify({
        info: {
          id: "019edd6b-shell-enrich",
          cwd: "/Users/art/dev/openscout",
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(sessionDir, "updates.jsonl"),
      `${JSON.stringify({
        timestamp: Date.parse("2026-04-27T15:00:01.000Z") / 1000,
        method: "session/update",
        params: {
          sessionId: "019edd6b-shell-enrich",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call-shell-fixture",
            title: "Shell",
            rawInput: { command: shellCommand },
          },
        },
      })}\n`,
      "utf8",
    );
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          ts: "2026-04-27T15:00:01.000Z",
          type: "tool_started",
          session_id: "019edd6b-shell-enrich",
          tool_name: "Shell",
        }),
        JSON.stringify({
          ts: "2026-04-27T15:00:02.000Z",
          type: "tool_completed",
          session_id: "019edd6b-shell-enrich",
          tool_name: "Shell",
          outcome: "success",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const transcripts = GrokSource.discoverTranscripts([]);
    const transcript = transcripts.find((entry) => entry.sessionId === "019edd6b-shell-enrich");
    expect(transcript).toBeDefined();

    const ctx = makeContext("grok", transcript!);
    const started = GrokSource.parseLine(
      JSON.stringify({
        ts: "2026-04-27T15:00:01.000Z",
        type: "tool_started",
        session_id: "019edd6b-shell-enrich",
        tool_name: "Shell",
      }),
      { ...ctx, lineOffset: 0 },
    );
    const completed = GrokSource.parseLine(
      JSON.stringify({
        ts: "2026-04-27T15:00:02.000Z",
        type: "tool_completed",
        session_id: "019edd6b-shell-enrich",
        tool_name: "Shell",
        outcome: "success",
      }),
      { ...ctx, lineOffset: 1 },
    );

    expect(started?.summary).toBe(`Shell · ${shellCommand}`);
    expect(completed?.summary).toBe(`Shell · ${shellCommand} · success`);
  });

  test("enriches Grok StrReplace tool events with old/new edit previews", () => {
    const projectDir = join(
      process.env.OPENSCOUT_TAIL_GROK_SESSIONS_ROOT!,
      encodeURIComponent("/Users/art/dev/openscout"),
    );
    const sessionDir = join(projectDir, "019edd6b-strreplace-enrich");
    mkdirSync(sessionDir, { recursive: true });
    const transcriptPath = join(sessionDir, "events.jsonl");
    const filePath = "packages/web/client/lib/tail-display.test.ts";
    writeFileSync(
      join(sessionDir, "summary.json"),
      JSON.stringify({
        info: {
          id: "019edd6b-strreplace-enrich",
          cwd: "/Users/art/dev/openscout",
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(sessionDir, "updates.jsonl"),
      `${JSON.stringify({
        timestamp: Date.parse("2026-04-27T15:00:01.000Z") / 1000,
        method: "session/update",
        params: {
          sessionId: "019edd6b-strreplace-enrich",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call-strreplace-fixture",
            title: "StrReplace",
            rawInput: {
              path: filePath,
              old_string: "const max = 96;",
              new_string: "const max = 120;",
            },
          },
        },
      })}\n`,
      "utf8",
    );
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          ts: "2026-04-27T15:00:01.000Z",
          type: "tool_started",
          session_id: "019edd6b-strreplace-enrich",
          tool_name: "StrReplace",
        }),
        JSON.stringify({
          ts: "2026-04-27T15:00:02.000Z",
          type: "tool_completed",
          session_id: "019edd6b-strreplace-enrich",
          tool_name: "StrReplace",
          outcome: "success",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const transcripts = GrokSource.discoverTranscripts([]);
    const transcript = transcripts.find((entry) => entry.sessionId === "019edd6b-strreplace-enrich");
    expect(transcript).toBeDefined();

    const ctx = makeContext("grok", transcript!);
    const started = GrokSource.parseLine(
      JSON.stringify({
        ts: "2026-04-27T15:00:01.000Z",
        type: "tool_started",
        session_id: "019edd6b-strreplace-enrich",
        tool_name: "StrReplace",
      }),
      { ...ctx, lineOffset: 0 },
    );
    const completed = GrokSource.parseLine(
      JSON.stringify({
        ts: "2026-04-27T15:00:02.000Z",
        type: "tool_completed",
        session_id: "019edd6b-strreplace-enrich",
        tool_name: "StrReplace",
        outcome: "success",
      }),
      { ...ctx, lineOffset: 1 },
    );

    expect(started?.summary).toBe(
      "StrReplace · packages/web/client/lib/tail-display.test.ts · edit: -const max = 96; · +const max = 120;",
    );
    expect(completed?.summary).toBe(
      "StrReplace · packages/web/client/lib/tail-display.test.ts · edit: -const max = 96; · +const max = 120; · success",
    );
  });

  test("discovers and parses OpenCode sessions from message and part storage", () => {
    const storageRoot = process.env.OPENSCOUT_TAIL_OPENCODE_STORAGE_ROOT!;
    const sessionPath = join(storageRoot, "session", "global", "ses_fixture.json");
    const messageDir = join(storageRoot, "message", "ses_fixture");
    const userPartDir = join(storageRoot, "part", "msg_user");
    const assistantPartDir = join(storageRoot, "part", "msg_assistant");
    mkdirSync(join(storageRoot, "session", "global"), { recursive: true });
    mkdirSync(messageDir, { recursive: true });
    mkdirSync(userPartDir, { recursive: true });
    mkdirSync(assistantPartDir, { recursive: true });
    writeFileSync(
      sessionPath,
      JSON.stringify({
        id: "ses_fixture",
        directory: "/Users/art/dev/openscout",
        title: "OpenScout fixture",
        time: { created: 1771000000000, updated: 1771000002000 },
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(messageDir, "msg_user.json"),
      JSON.stringify({
        id: "msg_user",
        sessionID: "ses_fixture",
        role: "user",
        time: { created: 1771000000000 },
        agent: "build",
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(userPartDir, "prt_user.json"),
      JSON.stringify({
        id: "prt_user",
        sessionID: "ses_fixture",
        messageID: "msg_user",
        type: "text",
        text: "Check the repo status",
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(messageDir, "msg_assistant.json"),
      JSON.stringify({
        id: "msg_assistant",
        sessionID: "ses_fixture",
        role: "assistant",
        time: { created: 1771000001000, completed: 1771000002000 },
        path: { cwd: "/Users/art/dev/openscout", root: "/Users/art/dev/openscout" },
        modelID: "minimax-m2.5-free",
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(assistantPartDir, "prt_assistant.json"),
      JSON.stringify({
        id: "prt_assistant",
        sessionID: "ses_fixture",
        messageID: "msg_assistant",
        type: "text",
        text: "Repo is clean enough to proceed",
      }, null, 2),
      "utf8",
    );

    const transcripts = OpenCodeSource.discoverTranscripts([]);
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]?.source).toBe("opencode");
    expect(transcripts[0]?.cwd).toBe("/Users/art/dev/openscout");
    expect(transcripts[0]?.sessionId).toBe("ses_fixture");

    const parsed = OpenCodeSource.parseFile?.(
      readFileSync(sessionPath, "utf8"),
      makeContext("opencode", transcripts[0]!),
    );
    const events = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe("user");
    expect(events[0]?.summary).toBe("Check the repo status");
    expect(events[1]?.kind).toBe("assistant");
    expect(events[1]?.summary).toBe("Repo is clean enough to proceed");

    const initialFingerprint = transcripts[0]!;
    const followupPart = join(assistantPartDir, "prt_followup.json");
    writeFileSync(
      followupPart,
      JSON.stringify({
        id: "prt_followup",
        sessionID: "ses_fixture",
        messageID: "msg_assistant",
        type: "text",
        text: "A later sibling part",
      }),
      "utf8",
    );
    const dependencyTime = new Date(Date.now() + 1_000);
    utimesSync(followupPart, dependencyTime, dependencyTime);

    const rediscovered = OpenCodeSource.discoverTranscripts([])[0]!;
    expect(rediscovered.mtimeMs).toBeGreaterThan(initialFingerprint.mtimeMs);
    expect(rediscovered.size).toBeGreaterThan(initialFingerprint.size);
  });

  test("discovers and parses Pi transcript files without process discovery", () => {
    const projectDir = join(process.env.OPENSCOUT_TAIL_PI_SESSIONS_ROOT!, "--Users-art-dev-openscout--");
    mkdirSync(projectDir, { recursive: true });
    const transcriptPath = join(
      projectDir,
      "2026-06-28T15-49-50-320Z_019f0eec-3a70-79c9-b643-ae82a445891b.jsonl",
    );
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "019f0eec-3a70-79c9-b643-ae82a445891b",
          timestamp: "2026-06-28T15:49:50.320Z",
          cwd: "/Users/art/dev/openscout",
        }),
        JSON.stringify({
          type: "message",
          id: "e5a06ff5",
          timestamp: "2026-06-28T15:50:05.233Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "pi update" }],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "245ffa91",
          timestamp: "2026-06-28T15:50:07.970Z",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Running update." },
              {
                type: "toolCall",
                id: "call_019f0eec7e8275a3b72837f7",
                name: "bash",
                arguments: { command: "pi update --self 2>&1" },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "30b2078e",
          timestamp: "2026-06-28T15:50:11.353Z",
          message: {
            role: "toolResult",
            toolCallId: "call_019f0eec7e8275a3b72837f7",
            toolName: "bash",
            content: [{ type: "text", text: "Updated packages" }],
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const transcripts = PiSource.discoverTranscripts([]);
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]?.source).toBe("pi");
    expect(transcripts[0]?.sessionId).toBe("019f0eec-3a70-79c9-b643-ae82a445891b");
    expect(transcripts[0]?.cwd).toBe("/Users/art/dev/openscout");
    expect(transcripts[0]?.project).toBe("openscout");

    const userLine = JSON.stringify({
      type: "message",
      id: "e5a06ff5",
      timestamp: "2026-06-28T15:50:05.233Z",
      message: { role: "user", content: [{ type: "text", text: "pi update" }] },
    });
    const userEvent = PiSource.parseLine(userLine, makeContext("pi", transcripts[0]!));
    expect(userEvent?.source).toBe("pi");
    expect(userEvent?.kind).toBe("user");
    expect(userEvent?.summary).toBe("pi update");

    const toolLine = JSON.stringify({
      type: "message",
      id: "245ffa91",
      timestamp: "2026-06-28T15:50:07.970Z",
      message: {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "call_019f0eec7e8275a3b72837f7",
          name: "bash",
          arguments: { command: "pi update --self 2>&1" },
        }],
      },
    });
    const toolEvent = PiSource.parseLine(toolLine, makeContext("pi", transcripts[0]!));
    expect(toolEvent?.kind).toBe("tool");
    expect(toolEvent?.summary).toContain("pi update --self");

    const resultLine = JSON.stringify({
      type: "message",
      id: "30b2078e",
      timestamp: "2026-06-28T15:50:11.353Z",
      message: {
        role: "toolResult",
        toolName: "bash",
        content: [{ type: "text", text: "Updated packages" }],
      },
    });
    const resultEvent = PiSource.parseLine(resultLine, makeContext("pi", transcripts[0]!));
    expect(resultEvent?.kind).toBe("tool-result");
    expect(resultEvent?.summary).toContain("Updated packages");
  });

  test("discovers and parses Cursor process-monitor logs without process discovery", () => {
    const root = process.env.OPENSCOUT_TAIL_CURSOR_PROCESS_MONITOR_ROOT!;
    mkdirSync(root, { recursive: true });
    const transcriptPath = join(root, "1781827200000.log");
    const line = JSON.stringify({
      sampleStart: 1781827200000,
      sampleEnd: 1781827200500,
      sessionId: "cursor-session",
      rows: [
        {
          processName: "Cursor Helper (Plugin): extension-host (agent-exec) openscout [2-6]",
        },
        {
          processName: "Cursor Helper (Plugin): extension-host (always-local) vox [1-3]",
        },
      ],
    });
    writeFileSync(transcriptPath, `${line}\n`, "utf8");

    const transcripts = CursorSource.discoverTranscripts([]);
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]?.source).toBe("cursor");
    expect(transcripts[0]?.sessionId).toBe("cursor-session");
    expect(transcripts[0]?.project).toBe("openscout");

    const event = CursorSource.parseLine(line, makeContext("cursor", transcripts[0]!));
    expect(event?.source).toBe("cursor");
    expect(event?.kind).toBe("system");
    expect(event?.summary).toBe("process sample · openscout, vox");
    expect(event?.raw).toEqual(expect.objectContaining({
      sessionId: "cursor-session",
      rows: expect.arrayContaining([
        expect.objectContaining({ processName: expect.stringContaining("openscout") }),
        expect.objectContaining({ processName: expect.stringContaining("vox") }),
      ]),
    }));
    expect(isTailNoiseEvent(event!)).toBe(true);
  });
});

const DEVIN_TOOL_DEFINITION_LEAK = "TOOL_DEFINITION_SCHEMA_MUST_NOT_LEAK";

function writeDevinTranscript(
  sessionId: string,
  steps: unknown[],
  options: { extra?: Record<string, unknown> } = {},
): string {
  const transcriptsDir = process.env.OPENSCOUT_TAIL_DEVIN_TRANSCRIPTS_ROOT!;
  mkdirSync(transcriptsDir, { recursive: true });
  const path = join(transcriptsDir, `${sessionId}.json`);
  writeFileSync(path, JSON.stringify({
    schema_version: "ATIF-v1.7",
    session_id: sessionId,
    agent: {
      name: "devin",
      version: "3000.10.27",
      model_name: "SWE-2 High",
      tool_definitions: [
        {
          type: "function",
          function: {
            name: "ask_user_question",
            description: DEVIN_TOOL_DEFINITION_LEAK,
          },
        },
      ],
      extra: { backend: "Windsurf", ...(options.extra ?? {}) },
    },
    steps,
    final_metrics: { total_steps: steps.length },
  }), "utf8");
  return path;
}

function writeDevinSessionsDb(rows: Array<{ id: string; cwd: string }>): void {
  mkdirSync(join(tempRoot, "devin-cli"), { recursive: true });
  const db = new Database(process.env.OPENSCOUT_TAIL_DEVIN_SESSIONS_DB!);
  db.run("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO sessions (id, working_directory) VALUES (?, ?)");
  for (const row of rows) insert.run(row.id, row.cwd);
  db.close();
}

function parseDevin(transcript: DiscoveredTranscript, text?: string) {
  const parsed = DevinSource.parseFile?.(
    text ?? readFileSync(transcript.transcriptPath, "utf8"),
    makeContext("devin", transcript),
  );
  return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
}

describe("Devin ATIF transcript source", () => {
  afterEach(() => {
    delete process.env.OPENSCOUT_TAIL_THINKING;
    resetTailThinkingModeCache();
  });

  const userStep = {
    step_id: 1,
    timestamp: "2026-09-16T20:47:20.603366+00:00",
    source: "user",
    message: "inspect the runtime tail registry",
    extra: { telemetry: { source: "user" } },
  };
  const agentStep = {
    step_id: 2,
    timestamp: "2026-09-16T20:47:21.557406+00:00",
    source: "agent",
    message: "Checking the tail source registry.",
    model_name: "swe-2-high",
    reasoning_content: "Look at the registered sources first.",
    tool_calls: [
      {
        tool_call_id: "exec_176#abc",
        function_name: "exec",
        arguments: { command: "cd /Users/art/dev/openscout && git status" },
      },
    ],
    observation: {
      results: [
        {
          source_call_id: "exec_176#abc",
          content: "On branch herdr-scout-agent-profile\nnothing to commit",
        },
      ],
    },
    extra: { telemetry: { source: "assistant" } },
  };

  test("discovers native Devin identity without process discovery", () => {
    writeDevinTranscript("zealous-noun", [userStep, agentStep]);

    const transcripts = DevinSource.discoverTranscripts([]);
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]).toEqual(expect.objectContaining({
      source: "devin",
      sessionId: "zealous-noun",
      cwd: null,
      project: "(unknown)",
    }));
    expect(transcripts[0]?.transcriptPath).toMatch(/zealous-noun\.json$/);
  });

  test("uses sessions.db working_directory as proven cwd and leaves missing metadata unknown", () => {
    writeDevinTranscript("zealous-noun", [userStep]);
    writeDevinTranscript("cyan-ornament", [userStep]);
    writeDevinSessionsDb([{ id: "zealous-noun", cwd: "/Users/art/dev/openscout" }]);

    const transcripts = DevinSource.discoverTranscripts([])
      .sort((left, right) => (left.sessionId ?? "").localeCompare(right.sessionId ?? ""));
    expect(transcripts).toHaveLength(2);

    const known = transcripts.find((row) => row.sessionId === "zealous-noun");
    const unknown = transcripts.find((row) => row.sessionId === "cyan-ornament");
    expect(known).toEqual(expect.objectContaining({
      cwd: "/Users/art/dev/openscout",
      project: "openscout",
      source: "devin",
    }));
    expect(unknown).toEqual(expect.objectContaining({
      cwd: null,
      project: "(unknown)",
      source: "devin",
    }));
  });

  test("refreshes session metadata after WAL commits while the writer remains open", () => {
    writeDevinTranscript("zealous-noun", [userStep]);
    writeDevinSessionsDb([]);
    // Prime the main-file cache before WAL mode starts.
    expect(DevinSource.discoverTranscripts([])[0]?.cwd).toBeNull();
    const dbPath = process.env.OPENSCOUT_TAIL_DEVIN_SESSIONS_DB!;
    const db = new Database(dbPath);
    try {
      db.run("PRAGMA journal_mode = WAL");
      db.run("PRAGMA wal_autocheckpoint = 0");
      expect(DevinSource.discoverTranscripts([])[0]?.cwd).toBeNull();
      const before = statSync(dbPath);
      db.prepare("INSERT INTO sessions (id, working_directory) VALUES (?, ?)")
        .run("zealous-noun", "/projects/first");
      expect(statSync(dbPath).mtimeMs).toBe(before.mtimeMs);
      expect(statSync(dbPath).size).toBe(before.size);
      expect(DevinSource.discoverTranscripts([])[0]).toEqual(expect.objectContaining({
        cwd: "/projects/first", project: "first",
      }));
      db.prepare("UPDATE sessions SET working_directory = ? WHERE id = ?")
        .run("/projects/second", "zealous-noun");
      expect(DevinSource.discoverTranscripts([])[0]?.cwd).toBe("/projects/second");
    } finally {
      db.close();
    }
    expect(DevinSource.discoverTranscripts([])[0]?.cwd).toBe("/projects/second");
  });

  test("does not invent thinking events for steps without reasoning in tag mode", () => {
    process.env.OPENSCOUT_TAIL_THINKING = "tag";
    resetTailThinkingModeCache();
    const { reasoning_content: _, ...withoutReasoning } = agentStep;
    writeDevinTranscript("zealous-noun", [userStep, withoutReasoning]);
    const events = parseDevin(DevinSource.discoverTranscripts([])[0]!);
    expect(events.map((event) => event.kind)).toEqual([
      "user", "assistant", "tool", "tool-result",
    ]);
  });

  test("parses user/agent text, correlates tool calls and results, and never emits tool definitions", () => {
    writeDevinTranscript("zealous-noun", [userStep, agentStep]);
    const transcript = DevinSource.discoverTranscripts([])[0]!;
    const events = parseDevin(transcript);

    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events.every((event) => event.source === "devin")).toBe(true);
    expect(events.every((event) => event.sessionId === "zealous-noun")).toBe(true);
    expect(events.map((event) => event.kind)).toEqual([
      "user",
      "system",
      "assistant",
      "tool",
      "tool-result",
    ]);
    expect(events[0]?.summary).toBe("inspect the runtime tail registry");
    expect(events[1]?.summary).toBe("[thinking] Look at the registered sources first.");
    expect(events[2]?.summary).toBe("Checking the tail source registry.");
    expect(events[3]?.kind).toBe("tool");
    expect(events[3]?.id).toContain("exec_176#abc");
    expect(events[3]?.summary).toContain("git status");
    expect(events[4]?.kind).toBe("tool-result");
    expect(events[4]?.id).toContain("exec_176#abc");
    expect(events[4]?.summary).toContain("nothing to commit");
    expect(events[4]?.summary).toContain("git status");

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(DEVIN_TOOL_DEFINITION_LEAK);
    expect(serialized).not.toContain("tool_definitions");
    expect(events.every((event) => event.cwd === "")).toBe(true);
    expect(events.every((event) => event.project === "(unknown)")).toBe(true);
  });

  test("does not guess cwd from tool command text", () => {
    writeDevinTranscript("zealous-noun", [agentStep]);
    const transcript = DevinSource.discoverTranscripts([])[0]!;
    const events = parseDevin(transcript);
    expect(transcript.cwd).toBeNull();
    expect(events.every((event) => event.cwd === "")).toBe(true);
    expect(events.some((event) => event.summary.includes("git status"))).toBe(true);
  });

  test("keeps event ids stable across whole-file rewrites and appended steps", () => {
    writeDevinTranscript("zealous-noun", [userStep, agentStep]);
    const transcript = DevinSource.discoverTranscripts([])[0]!;
    const first = parseDevin(transcript);
    const second = parseDevin(transcript);
    expect(second.map((event) => event.id)).toEqual(first.map((event) => event.id));

    const followup = {
      step_id: 3,
      timestamp: "2026-09-16T20:47:30.000Z",
      source: "user",
      message: "keep going",
      extra: {},
    };
    writeDevinTranscript("zealous-noun", [userStep, agentStep, followup]);
    const appended = parseDevin(transcript);
    expect(appended.slice(0, first.length).map((event) => event.id)).toEqual(first.map((event) => event.id));
    expect(appended).toHaveLength(first.length + 1);
    expect(appended.at(-1)?.id).toBe("devin:zealous-noun:step:3:message");
    expect(appended.at(-1)?.summary).toBe("keep going");
  });

  test("recovers from malformed and partial files without throwing", () => {
    const path = writeDevinTranscript("zealous-noun", [userStep]);
    const transcript = DevinSource.discoverTranscripts([])[0]!;
    expect(() => DevinSource.parseFile?.("{", makeContext("devin", transcript))).not.toThrow();

    const recoveredFromTruncation = parseDevin(transcript, '{"schema_version":"ATIF-v1.7"');
    expect(recoveredFromTruncation).toHaveLength(1);
    expect(recoveredFromTruncation[0]?.source).toBe("devin");

    writeFileSync(path, "{", "utf8");
    expect(() => parseDevin(transcript, "{")).not.toThrow();
    expect(parseDevin(transcript, "{")).toEqual([]);
    expect(parseDevin(transcript, '{"schema_version":"ATIF-v1.7","session_id":"zealous-noun","steps":[')).toEqual([]);

    writeDevinTranscript("zealous-noun", [userStep]);
    const recovered = parseDevin(transcript, '{"schema_version":"ATIF-v1.7"');
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.summary).toBe("inspect the runtime tail registry");
    expect(recovered[0]?.source).toBe("devin");
  });

  test("does not parse ATIF documents as JSONL", () => {
    const stepLine = JSON.stringify(userStep);
    writeDevinTranscript("zealous-noun", [userStep]);
    const transcript = DevinSource.discoverTranscripts([])[0]!;
    expect(DevinSource.parseLine(stepLine, makeContext("devin", transcript))).toBeNull();
  });

  test("honors thinking visibility for empty reasoning and always renders reasoning text", () => {
    const emptyReasoning = {
      ...agentStep,
      message: "Done.",
      reasoning_content: "   ",
      tool_calls: [],
      observation: undefined,
    };
    writeDevinTranscript("zealous-noun", [emptyReasoning]);
    const transcript = DevinSource.discoverTranscripts([])[0]!;

    resetTailThinkingModeCache();
    delete process.env.OPENSCOUT_TAIL_THINKING;
    const hidden = parseDevin(transcript);
    expect(hidden.map((event) => event.kind)).toEqual(["assistant"]);
    expect(hidden[0]?.summary).toBe("Done.");

    process.env.OPENSCOUT_TAIL_THINKING = "tag";
    resetTailThinkingModeCache();
    const tagged = parseDevin(transcript);
    expect(tagged.map((event) => event.kind)).toEqual(["system", "assistant"]);
    expect(tagged[0]?.summary).toBe("[thinking]");

    writeDevinTranscript("zealous-noun", [agentStep]);
    delete process.env.OPENSCOUT_TAIL_THINKING;
    resetTailThinkingModeCache();
    const withText = parseDevin(DevinSource.discoverTranscripts([])[0]!);
    expect(withText.some((event) => event.summary === "[thinking] Look at the registered sources first.")).toBe(true);
  });
});

// --- Textless thinking blocks (the `tail-thinking` setting) -----------------
//
// Claude returns thinking blocks with an EMPTY `thinking` field whenever the
// caller leaves `display` at its default of "omitted", which every current
// model does. The tail must not render `[thinking]` with nothing behind it by
// default, and must still render thinking that DOES carry text.

describe("textless thinking blocks", () => {
  const transcript = {
    source: "claude" as const,
    transcriptPath: "/tmp/claude/thinking.jsonl",
    sessionId: "claude-thinking",
    cwd: "/Users/arach/dev/openscout",
    project: "openscout",
    harness: "unattributed" as const,
    mtimeMs: Date.now(),
    size: 100,
  };

  function parse(content: unknown[]) {
    return ClaudeSource.parseLine(
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-04T12:00:00.000Z",
        message: { id: "msg-thinking", content },
      }),
      makeContext("claude", transcript),
    );
  }

  afterEach(() => {
    delete process.env.OPENSCOUT_TAIL_THINKING;
    resetTailThinkingModeCache();
  });

  test("drops the empty beat by default", () => {
    resetTailThinkingModeCache();
    const event = parse([
      { type: "thinking", thinking: "", signature: "CAISuAQK" },
      { type: "text", text: "Done." },
    ]);
    expect(event?.summary).toBe("Done.");
  });

  test("keeps a marker when tail-thinking is tag", () => {
    process.env.OPENSCOUT_TAIL_THINKING = "tag";
    resetTailThinkingModeCache();
    const event = parse([{ type: "thinking", thinking: "", signature: "CAISuAQK" }]);
    expect(event?.summary).toBe("[thinking]");
  });

  test("renders thinking that carries text whatever the setting", () => {
    resetTailThinkingModeCache();
    const event = parse([{ type: "thinking", thinking: "Weigh the two fixes.", signature: "x" }]);
    expect(event?.summary).toBe("[thinking] Weigh the two fixes.");
  });
});

describe("Harness-native transcript metadata", () => {
  test("captures timestamp-less Claude titles and discovers workflow children of cold parents", async () => {
    const project = join(process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT!, "-tmp-metadata");
    const parent = join(project, "parent.jsonl");
    const workflow = join(project, "parent", "subagents", "workflows", "run-123");
    mkdirSync(workflow, { recursive: true });
    const records = [
      { type: "user", sessionId: "parent", cwd: "/tmp/arrivals", timestamp: new Date().toISOString(), message: { content: "hello" } },
      { type: "ai-title", aiTitle: "AI first" },
      { type: "agent-name", agentName: "Agent first" },
      { type: "custom-title", customTitle: "Custom first" },
      { type: "custom-title", customTitle: "Custom newest" },
      { type: "ai-title", aiTitle: "AI newer but lower priority" },
    ];
    writeFileSync(parent, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    writeFileSync(join(workflow, "agent-abc123.jsonl"), JSON.stringify({
      type: "assistant", timestamp: new Date().toISOString(), message: { content: "working" },
    }) + "\n");
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(parent, old, old);
    const discovery = await ClaudeSource.discoverTranscripts([], "shallow");
    expect(discovery.find((t) => t.subagentId === "abc123")).toMatchObject({
      parentSessionId: "parent", workflowRunId: "run-123", sessionId: "abc123", cwd: "/tmp/arrivals",
    });
    utimesSync(parent, new Date(), new Date());
    expect((await ClaudeSource.discoverTranscripts([])).find((t) => t.sessionId === "parent")?.title).toBe("Custom newest");
    expect((await ClaudeSource.discoverTranscripts([])).find((t) => t.sessionId === "parent")?.title).toBe("Custom newest");
  });

  test("Claude title falls back from agent name to AI title and refreshes on append", async () => {
    const project = join(process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT!, "-tmp-titles");
    mkdirSync(project, { recursive: true });
    const path = join(project, "titles.jsonl");
    writeFileSync(path, '{"type":"ai-title","aiTitle":"First"}\n');
    expect((await ClaudeSource.discoverTranscripts([]))[0]?.title).toBe("First");
    writeFileSync(path, '{"type":"ai-title","aiTitle":"First"}\n{"type":"agent-name","agentName":"Named"}\n');
    expect((await ClaudeSource.discoverTranscripts([]))[0]?.title).toBe("Named");
  });

  test("Codex index uses the newest entry and tolerates partial lines", async () => {
    const root = process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT!;
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "rollout.jsonl"), JSON.stringify({
      type: "session_meta", payload: { id: "codex-native", cwd: "/tmp/arrivals" },
    }));
    writeFileSync(join(root, "..", "session_index.jsonl"), [
      '{"id":"codex-native","thread_name":"Old"}',
      '{"id":"codex-native","thread_name":"New title"}',
      '{"id":',
    ].join("\n"));
    expect((await CodexSource.discoverTranscripts([]))[0]?.title).toBe("New title");
  });

  test("Codex completed items preserve data and classify messages, commands, MCP and files", () => {
    const ctx = makeContext("codex", { source: "codex", sessionId: "native", transcriptPath: "/tmp/codex.jsonl",
      cwd: "/tmp", project: "tmp", harness: "unattributed", mtimeMs: 1, size: 1 });
    const items = [
      { type: "CommandExecution", command: ["git", "status"], exit_code: 0, duration_ms: 10, aggregated_output: "clean" },
      { type: "AgentMessage", text: "Done", phase: "final" },
      { type: "agent_message", text: "Checking", phase: "commentary" },
      { type: "McpToolCall", server: "scout", tool: "lookup", arguments: { query: "hello" } },
      { type: "FileChange", changes: [{ path: "src/file.ts", kind: "update" }] },
      { type: "Reasoning", text: "reason" }, { type: "SubAgentActivity" },
    ];
    const kinds = ["tool-result", "assistant", "assistant", "tool-result", "tool-result", "system", "system"];
    items.forEach((item, i) => {
      const raw = { type: "event_msg", timestamp: "2026-10-15T12:00:00Z", payload: { type: "item_completed", item } };
      const event = CodexSource.parseLine(JSON.stringify(raw), ctx)!;
      expect(event.kind).toBe(kinds[i]!);
      expect(event.raw).toEqual(raw);
      if (i === 0) expect(event.summary).toContain("git status");
      if (i === 4) expect(event.summary).toContain("src/file.ts");
    });
    expect(CodexSource.parseLine(JSON.stringify({ type: "response_item", payload: {
      type: "message", role: "developer", content: [{ type: "input_text", text: "instructions" }],
    } }), ctx)?.kind).toBe("system");
    for (const type of ["task_complete", "turn_aborted"]) {
      const raw = { type: "event_msg", payload: { type, duration_ms: 123, last_agent_message: "recap", reason: "interrupt" } };
      const event = CodexSource.parseLine(JSON.stringify(raw), ctx)!;
      expect(event.raw).toEqual(raw);
      expect(event.summary).toStartWith(type === "task_complete" ? "task complete" : "turn aborted");
    }
  });

  test("Claude turn end and recap keep raw fields and native child timestamps", () => {
    const ctx = makeContext("claude", { source: "claude", sessionId: "child", subagentId: "child",
      transcriptPath: "/tmp/agent-child.jsonl", cwd: "/tmp", project: "tmp", harness: "unattributed", mtimeMs: Date.now(), size: 1 });
    for (const subtype of ["turn_duration", "away_summary"]) {
      const raw = { type: "system", subtype, durationMs: 2345, summary: "Work recap", timestamp: "2026-10-15T12:00:00Z" };
      const event = ClaudeSource.parseLine(JSON.stringify(raw), ctx)!;
      expect(event.raw).toEqual(raw);
      expect(event.kind).toBe("system");
      expect(event.ts).toBe(Date.parse(raw.timestamp));
      expect(event.summary).toContain(subtype === "turn_duration" ? "2345" : "Work recap");
    }
    expect(ClaudeSource.parseLine(JSON.stringify({ type: "assistant", timestamp: "2026-10-15T12:00:00Z", message: { content: [
      { type: "tool_use", name: "Bash", input: { command: "git status", description: "Check working tree" } },
    ] } }), ctx)?.summary).toBe("Check working tree");
  });
});

test("title metadata reads the bounded tail and retains titles as appends push them out of that tail", async () => {
  const project = join(process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT!, "-tmp-tail-titles");
  mkdirSync(project, { recursive: true });
  const path = join(project, "tail-title.jsonl");
  writeFileSync(path, [
    JSON.stringify({ type: "user", sessionId: "tail-title", cwd: "/tmp", timestamp: "2026-10-15T12:00:00Z" }),
    JSON.stringify({ type: "padding", value: "x".repeat(300_000) }),
    JSON.stringify({ type: "custom-title", customTitle: "From tail" }),
  ].join("\n") + "\n");
  expect((await ClaudeSource.discoverTranscripts([]))[0]?.title).toBe("From tail");
  appendFileSync(path, JSON.stringify({ type: "padding", value: "x".repeat(600_000) }) + "\n");
  expect((await ClaudeSource.discoverTranscripts([]))[0]?.title).toBe("From tail");
});
