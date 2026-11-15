import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeSource } from "./claude-source.js";
import { CodexSource } from "./codex-source.js";
import { PiSource } from "./pi-source.js";
import { readLineTranscriptUsage, resetSessionUsageForTest, usageFromEvents } from "./session-usage.js";
import type { DiscoveredTranscript, TailEvent } from "./types.js";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openscout-session-usage-"));
  resetSessionUsageForTest();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function transcriptFor(source: string, path: string): DiscoveredTranscript {
  const stats = statSync(path);
  return {
    source,
    transcriptPath: path,
    sessionId: `${source}-session`,
    cwd: "/example/project",
    project: "project",
    harness: "unattributed",
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
}

const lines = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";

function claudeAssistant(id: string, usage: Record<string, number>, content: unknown[], at: string) {
  return {
    type: "assistant",
    sessionId: "claude-session",
    timestamp: at,
    message: { id, role: "assistant", model: "claude-opus-5-5", usage, content },
  };
}

describe("session usage", () => {
  test("Claude counts each message once, follows appends, and skips tool turns for the last turn", async () => {
    const path = join(root, "claude.jsonl");
    const usage1 = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 };
    writeFileSync(path, lines(
      { type: "user", sessionId: "claude-session", timestamp: "2026-11-13T10:00:00Z", message: { role: "user", content: "fix the flaky test" } },
      claudeAssistant("msg_1", usage1, [{ type: "thinking", thinking: "..." }], "2026-11-13T10:00:01Z"),
      claudeAssistant("msg_1", { ...usage1, output_tokens: 7 }, [{ type: "text", text: "Looking at it now." }], "2026-11-13T10:00:02Z"),
      claudeAssistant("msg_2", { input_tokens: 1, output_tokens: 3, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 },
        [{ type: "tool_use", id: "tool_1", name: "Bash", input: { command: "bun test" } }], "2026-11-13T10:00:03Z"),
    ));

    const first = await readLineTranscriptUsage(ClaudeSource, transcriptFor("claude", path));
    expect(first.model).toBe("claude-opus-5-5");
    expect(first.tokens).toEqual({ input: 11, output: 10, cacheRead: 300, cacheWrite: 50 });
    expect(first.lastTurn).toMatchObject({ kind: "assistant", text: "Looking at it now." });
    expect(first.complete).toBe(true);

    appendFileSync(path, lines(
      { type: "user", sessionId: "claude-session", timestamp: "2026-11-13T10:00:04Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: "ok" }] } },
      { type: "user", sessionId: "claude-session", timestamp: "2026-11-13T10:00:05Z", message: { role: "user", content: "now ship it" } },
    ));
    const second = await readLineTranscriptUsage(ClaudeSource, transcriptFor("claude", path));
    expect(second.tokens).toEqual({ input: 11, output: 10, cacheRead: 300, cacheWrite: 50 });
    expect(second.lastTurn).toMatchObject({ kind: "user", text: "now ship it" });
    expect(second.lastTurn?.at).toBe(Date.parse("2026-11-13T10:00:05Z"));
    expect(second.scannedBytes).toBe(statSync(path).size);
  });

  test("Codex takes the newest cumulative total and moves cached input out of input", async () => {
    const path = join(root, "rollout.jsonl");
    const tokenCount = (input: number, cached: number, output: number) => ({
      type: "event_msg",
      timestamp: "2026-11-13T10:00:02Z",
      payload: { type: "token_count", info: { total_token_usage: {
        input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0,
        output_tokens: output, reasoning_output_tokens: 4, total_tokens: input + output,
      } } },
    });
    writeFileSync(path, lines(
      { type: "turn_context", timestamp: "2026-11-13T10:00:00Z", payload: { model: "gpt-6.1-sol", cwd: "/example/project" } },
      tokenCount(1_000, 400, 50),
      tokenCount(3_000, 2_000, 90),
    ));
    const usage = await readLineTranscriptUsage(CodexSource, transcriptFor("codex", path));
    expect(usage.model).toBe("gpt-6.1-sol");
    expect(usage.tokens).toEqual({ input: 1_000, output: 90, cacheRead: 2_000, cacheWrite: 0, reasoningOutput: 4 });
  });

  test("Pi sums per-message usage", async () => {
    const path = join(root, "pi.jsonl");
    const message = (input: number, output: number) => ({
      type: "message",
      timestamp: "2026-11-13T10:00:00Z",
      message: { role: "assistant", model: "gpt-5.6-sol", content: [{ type: "text", text: "OK." }],
        usage: { input, output, cacheRead: 10, cacheWrite: 0, totalTokens: input + output } },
    });
    writeFileSync(path, lines(message(100, 5), message(200, 6)));
    const usage = await readLineTranscriptUsage(PiSource, transcriptFor("pi", path));
    expect(usage.model).toBe("gpt-5.6-sol");
    expect(usage.tokens).toEqual({ input: 300, output: 11, cacheRead: 20, cacheWrite: 0 });
  });

  test("a partial scan still reports the newest turn and continues on the next read", async () => {
    const path = join(root, "claude.jsonl");
    const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    writeFileSync(path, lines(
      claudeAssistant("msg_a", usage, [{ type: "text", text: "first answer" }], "2026-11-13T10:00:00Z"),
      claudeAssistant("msg_b", usage, [{ type: "text", text: "second answer" }], "2026-11-13T10:00:01Z"),
      claudeAssistant("msg_c", usage, [{ type: "thinking", thinking: "private reasoning" }], "2026-11-13T10:00:02Z"),
      claudeAssistant("msg_d", usage, [], "2026-11-13T10:00:03Z"),
    ));
    const transcript = transcriptFor("claude", path);
    const partial = await readLineTranscriptUsage(ClaudeSource, transcript, 50);
    expect(partial.complete).toBe(false);
    expect(partial.lastReadBytes).toBe(50);
    // Thinking beats and empty blocks are placeholders, not turns.
    expect(partial.lastTurn).toMatchObject({ kind: "assistant", text: "second answer" });
    const rest = await readLineTranscriptUsage(ClaudeSource, transcript);
    expect(rest.complete).toBe(true);
    expect(rest.tokens).toEqual({ input: 4, output: 8, cacheRead: 0, cacheWrite: 0 });
  });

  test("a long Codex rollout is read from its end", async () => {
    const path = join(root, "rollout.jsonl");
    const filler = lines({ type: "event_msg", payload: { type: "agent_message", message: "x".repeat(1_000) } });
    writeFileSync(path, lines({ type: "turn_context", payload: { model: "old-model" } }) + filler.repeat(5_000) + lines(
      { type: "turn_context", payload: { model: "gpt-6.1-sol" } },
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: {
        input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, total_tokens: 12,
      } } } },
    ));
    const usage = await readLineTranscriptUsage(CodexSource, transcriptFor("codex", path));
    expect(usage.complete).toBe(true);
    expect(usage.lastReadBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(usage.model).toBe("gpt-6.1-sol");
    expect(usage.tokens).toEqual({ input: 6, output: 2, cacheRead: 4, cacheWrite: 0 });
  });

  test("a truncated transcript is read again from the start", async () => {
    const path = join(root, "claude.jsonl");
    const big = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    writeFileSync(path, lines(
      claudeAssistant("msg_a", big, [{ type: "text", text: "one" }], "2026-11-13T10:00:00Z"),
      claudeAssistant("msg_b", big, [{ type: "text", text: "two" }], "2026-11-13T10:00:01Z"),
    ));
    await readLineTranscriptUsage(ClaudeSource, transcriptFor("claude", path));
    writeFileSync(path, lines(claudeAssistant("msg_c", { ...big, output_tokens: 1 }, [{ type: "text", text: "three" }], "2026-11-13T10:00:02Z")));
    const usage = await readLineTranscriptUsage(ClaudeSource, transcriptFor("claude", path));
    expect(usage.tokens).toEqual({ input: 10, output: 1, cacheRead: 0, cacheWrite: 0 });
    expect(usage.lastTurn?.text).toBe("three");
  });

  test("whole-file sources report no tokens and take the last turn from events", () => {
    const transcript: DiscoveredTranscript = {
      source: "opencode", transcriptPath: "/t/s", sessionId: "s", cwd: null, project: "p", harness: "unattributed", mtimeMs: 1, size: 1,
    };
    const event = (kind: TailEvent["kind"], summary: string, ts: number): TailEvent => ({
      id: summary, ts, source: "opencode", sessionId: "s", pid: 0, parentPid: null, project: "p", cwd: "", harness: "unattributed", kind, summary,
    });
    const usage = usageFromEvents(transcript, [event("assistant", "done", 1), event("tool", "bash", 2), event("system", "x", 3)]);
    expect(usage).toMatchObject({ tokens: null, model: null, complete: true, lastTurn: { kind: "assistant", text: "done", at: 1 } });
  });
});
