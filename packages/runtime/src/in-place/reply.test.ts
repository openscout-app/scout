import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeReplyFromTranscript, codexReplyFromTranscript, openSessionReplyReader } from "./reply.js";

const MARKER = "inv-123";
const lines = (...rows: unknown[]) => rows.map((row) => typeof row === "string" ? row : JSON.stringify(row)).join("\n") + "\n";

const codexUser = (message: string) => ({ type: "event_msg", payload: { type: "user_message", message } });
const codexEvent = (type: string, extra: Record<string, unknown> = {}) => ({ type: "event_msg", payload: { type, ...extra } });

describe("codexReplyFromTranscript", () => {
  test("nothing recorded yet is pending and not accepted", () => {
    expect(codexReplyFromTranscript("", MARKER)).toEqual({ state: "pending", accepted: false });
  });

  test("the turn that carries the marker answers with its last message", () => {
    const text = lines(
      codexUser(`do the thing\n\nScout task ${MARKER}`),
      codexEvent("task_started"),
      codexEvent("agent_message", { message: "working on it" }),
      codexEvent("task_complete", { last_agent_message: "Done. Two files changed." }),
    );
    expect(codexReplyFromTranscript(text, MARKER)).toEqual({ state: "answered", text: "Done. Two files changed." });
  });

  test("a turn that finished before the ask was typed is not the answer", () => {
    const text = lines(
      codexUser("an earlier prompt from the operator"),
      codexEvent("agent_message", { message: "earlier answer" }),
      codexEvent("task_complete", { last_agent_message: "earlier answer" }),
      codexUser(`the ask ${MARKER}`),
      codexEvent("task_started"),
    );
    expect(codexReplyFromTranscript(text, MARKER)).toEqual({ state: "pending", accepted: true });
  });

  test("an interrupted turn is aborted, not answered", () => {
    const text = lines(codexUser(`the ask ${MARKER}`), codexEvent("agent_message", { message: "partial" }), codexEvent("turn_aborted"));
    expect(codexReplyFromTranscript(text, MARKER)).toEqual({ state: "aborted" });
  });

  test("the marker is also found in a response item, and the last assistant text stands in for a missing final message", () => {
    const text = lines(
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `ask ${MARKER}` }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "the answer" }] } },
      codexEvent("task_complete"),
    );
    expect(codexReplyFromTranscript(text, MARKER)).toEqual({ state: "answered", text: "the answer" });
  });

  test("a line still being written does not end the turn", () => {
    const text = lines(codexUser(`ask ${MARKER}`), codexEvent("agent_message", { message: "so far" })) + '{"type":"event_msg","payload":{"type":"task_compl';
    expect(codexReplyFromTranscript(text, MARKER)).toEqual({ state: "pending", accepted: true });
  });
});

const claudeUser = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: "user", message: { role: "user", content }, ...extra });
const claudeSays = (content: unknown[], stopReason: string | null = null) => ({ type: "assistant", message: { role: "assistant", content, stop_reason: stopReason } });
const text = (value: string) => ({ type: "text", text: value });
const toolUse = { type: "tool_use", id: "t1", name: "Bash", input: {} };
const toolResult = claudeUser([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]);

describe("claudeReplyFromTranscript", () => {
  test("end_turn after the ask answers with the text since the last tool result", () => {
    const transcript = lines(
      claudeUser(`please check\n\nScout task ${MARKER}`),
      claudeSays([text("Let me look.")]),
      claudeSays([toolUse]),
      toolResult,
      claudeSays([text("It passes.")], "end_turn"),
    );
    expect(claudeReplyFromTranscript(transcript, MARKER)).toEqual({ state: "answered", text: "It passes." });
  });

  test("text before a tool call is not an answer, even when the harness reads idle", () => {
    const transcript = lines(claudeUser(`ask ${MARKER}`), claudeSays([text("Let me look.")]), claudeSays([toolUse]));
    expect(claudeReplyFromTranscript(transcript, MARKER, { idle: true })).toEqual({ state: "pending", accepted: true });
  });

  test("the turn_duration record ends the turn when no stop reason was written", () => {
    const transcript = lines(claudeUser(`ask ${MARKER}`), claudeSays([text("Part one.")]), claudeSays([text("Part two.")]), { type: "system", subtype: "turn_duration", durationMs: 10 });
    expect(claudeReplyFromTranscript(transcript, MARKER)).toEqual({ state: "answered", text: "Part one.\n\nPart two." });
  });

  test("the harness's idle report ends the turn only when asked to count", () => {
    const transcript = lines(claudeUser(`ask ${MARKER}`), claudeSays([text("All done.")]));
    expect(claudeReplyFromTranscript(transcript, MARKER)).toEqual({ state: "pending", accepted: true });
    expect(claudeReplyFromTranscript(transcript, MARKER, { idle: true })).toEqual({ state: "answered", text: "All done." });
  });

  test("an earlier turn's text is never the answer, and idle alone answers nothing", () => {
    const transcript = lines(claudeUser("an earlier prompt"), claudeSays([text("earlier answer")], "end_turn"));
    expect(claudeReplyFromTranscript(transcript, MARKER, { idle: true })).toEqual({ state: "pending", accepted: false });
    const accepted = transcript + lines(claudeUser(`ask ${MARKER}`));
    expect(claudeReplyFromTranscript(accepted, MARKER, { idle: true })).toEqual({ state: "pending", accepted: true });
  });

  test("an interruption is aborted", () => {
    const transcript = lines(claudeUser(`ask ${MARKER}`), claudeSays([text("Starting.")]), claudeUser([text("[Request interrupted by user]")]));
    expect(claudeReplyFromTranscript(transcript, MARKER)).toEqual({ state: "aborted" });
  });

  test("the operator's next prompt closes the turn that took the ask", () => {
    const transcript = lines(claudeUser(`ask ${MARKER}`), claudeSays([text("Answer.")]), claudeUser("something else"), claudeSays([text("Other answer.")], "end_turn"));
    expect(claudeReplyFromTranscript(transcript, MARKER)).toEqual({ state: "answered", text: "Answer." });
  });

  test("subagent rows and meta rows are ignored", () => {
    const transcript = lines(
      claudeUser(`ask ${MARKER}`),
      { ...claudeSays([text("subagent chatter")], "end_turn"), isSidechain: true },
      claudeUser("<system-reminder>note</system-reminder>", { isMeta: true }),
      claudeSays([text("Real answer.")], "end_turn"),
    );
    expect(claudeReplyFromTranscript(transcript, MARKER)).toEqual({ state: "answered", text: "Real answer." });
  });
});

describe("openSessionReplyReader", () => {
  const SESSION = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
  const previousHome = process.env.CODEX_HOME;
  let home: string | null = null;

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    if (home) await rm(home, { recursive: true, force: true });
    home = null;
  });

  async function transcriptWith(...rows: unknown[]): Promise<string> {
    home = await mkdtemp(join(tmpdir(), "scout-reply-reader-"));
    process.env.CODEX_HOME = home;
    const folder = join(home, "sessions", "2026", "01", "01");
    await mkdir(folder, { recursive: true });
    const path = join(folder, `rollout-2026-01-01T00-00-00-${SESSION}.jsonl`);
    await writeFile(path, lines(...rows));
    return path;
  }

  test("reads only what the session wrote after the reader was opened", async () => {
    // An earlier turn carries the same marker and a finished answer.
    const path = await transcriptWith(
      codexUser(`an earlier ask ${MARKER}`),
      codexEvent("task_complete", { last_agent_message: "an earlier answer" }),
    );
    const reader = await openSessionReplyReader({ sessionId: SESSION, harness: "codex", marker: MARKER });
    expect(reader?.path).toBe(path);
    expect(await reader!.read()).toEqual({ state: "pending", accepted: false });

    await appendFile(path, lines(codexUser(`the ask ${MARKER}`), codexEvent("task_started")));
    expect(await reader!.read()).toEqual({ state: "pending", accepted: true });
    const grown = reader!.size();

    await appendFile(path, lines(codexEvent("task_complete", { last_agent_message: "the answer" })));
    expect(await reader!.read()).toEqual({ state: "answered", text: "the answer" });
    expect(reader!.size()).toBeGreaterThan(grown);
  });

  test("a reader reopened at an earlier reader's start sees the turn that reader was watching", async () => {
    const path = await transcriptWith(
      codexUser(`an earlier ask ${MARKER}`),
      codexEvent("task_complete", { last_agent_message: "an earlier answer" }),
    );
    const first = await openSessionReplyReader({ sessionId: SESSION, harness: "codex", marker: MARKER });
    await appendFile(path, lines(codexUser(`the ask ${MARKER}`), codexEvent("task_complete", { last_agent_message: "the answer" })));

    // A reader opened now starts after the answer and never sees it.
    const late = await openSessionReplyReader({ sessionId: SESSION, harness: "codex", marker: MARKER });
    expect(await late!.read()).toEqual({ state: "pending", accepted: false });

    const reopened = await openSessionReplyReader({ sessionId: SESSION, harness: "codex", marker: MARKER, fromOffset: first!.offset });
    expect(reopened!.offset).toBe(first!.offset);
    expect(await reopened!.read()).toEqual({ state: "answered", text: "the answer" });

    // An offset past the end of a transcript that was replaced reads from its end.
    const past = await openSessionReplyReader({ sessionId: SESSION, harness: "codex", marker: MARKER, fromOffset: 10_000_000 });
    expect(past!.offset).toBe(late!.offset);
  });

  test("a session with no transcript has no reader, and a transcript that disappears reads as pending", async () => {
    const path = await transcriptWith(codexUser("hello"));
    expect(await openSessionReplyReader({ sessionId: "0199aaaa-0000-7000-8000-000000000000", harness: "codex", marker: MARKER })).toBeNull();
    const reader = await openSessionReplyReader({ sessionId: SESSION, harness: "codex", marker: MARKER });
    await rm(path);
    expect(await reader!.read()).toEqual({ state: "pending", accepted: false });
  });
});
