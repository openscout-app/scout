import { afterEach, describe, expect, test } from "bun:test";

import { registerSecretValue, resetSecretRegistryForTests } from "../../secret-redaction.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findClaudePendingToolContext, readClaudePendingToolContext, describeClaudeToolCall, findClaudePendingToolCall } from "./pending-tool-call.js";

const at = "2026-11-02T10:00:00.000Z";
const assistant = (...blocks: unknown[]) => JSON.stringify({ type: "assistant", timestamp: at, message: { role: "assistant", content: blocks } });
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const result = (id: string) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const prompt = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
const jsonl = (...lines: string[]) => lines.join("\n") + "\n";

afterEach(() => resetSecretRegistryForTests());

describe("findClaudePendingToolCall", () => {
  test("reads the Bash call that has no result, as the prompt shows it", () => {
    const pending = findClaudePendingToolCall(jsonl(
      prompt("free some disk"),
      assistant(toolUse("t1", "Bash", { command: "df -h", description: "Check free space" })),
      result("t1"),
      assistant({ type: "text", text: "Clearing caches." }),
      assistant(toolUse("t2", "Bash", { command: "rm -rf ~/Library/Caches/pip", description: "Remove the pip cache" })),
    ));
    expect(pending).toEqual({
      toolUseId: "t2", tool: "Bash", title: "Bash command", subject: "rm -rf ~/Library/Caches/pip",
      detail: "Remove the pip cache", subjectKind: "command", at: Date.parse(at), alsoPending: 0,
    });
  });

  test("returns null once every call has a result", () => {
    expect(findClaudePendingToolCall(jsonl(assistant(toolUse("t1", "Bash", { command: "ls" })), result("t1")))).toBeNull();
  });

  test("names the first open call of a parallel turn and counts the rest", () => {
    const pending = findClaudePendingToolCall(jsonl(
      assistant(toolUse("a", "Read", { file_path: "/repo/a.ts" })),
      assistant(toolUse("b", "Edit", { file_path: "/repo/b.ts", old_string: "x", new_string: "y" })),
      assistant(toolUse("c", "Write", { file_path: "/repo/c.ts", content: "z" })),
      result("a"),
    ));
    expect(pending?.toolUseId).toBe("b");
    expect(pending?.title).toBe("Edit file");
    expect(pending?.subject).toBe("/repo/b.ts");
    expect(pending?.alsoPending).toBe(1);
  });

  test("a typed prompt after an open call closes it", () => {
    expect(findClaudePendingToolCall(jsonl(assistant(toolUse("t1", "Bash", { command: "ls" })), prompt("never mind")))).toBeNull();
  });

  test("skips subagent lines and a partial first line", () => {
    const sidechain = JSON.stringify({ type: "assistant", isSidechain: true, message: { content: [toolUse("s1", "Bash", { command: "make" })] } });
    expect(findClaudePendingToolCall(`{"type":"assi` + "\n" + jsonl(sidechain))).toBeNull();
  });

  test("redacts registered secret values from the subject", () => {
    registerSecretValue("sk-test-1234567890abcdef", "test");
    const pending = findClaudePendingToolCall(jsonl(assistant(toolUse("t1", "Bash", { command: "curl -H 'x: sk-test-1234567890abcdef' https://example.com" }))));
    expect(pending?.subject).not.toContain("sk-test-1234567890abcdef");
  });
});

describe("describeClaudeToolCall", () => {
  test("MCP tools read as server - tool (MCP) with their arguments", () => {
    expect(describeClaudeToolCall("mcp__github__create_issue", { title: "Bug", labels: ["a"] })).toEqual({
      title: "github - create_issue (MCP)", subject: 'title: "Bug", labels: ["a"]', detail: null, subjectKind: "arguments",
    });
  });

  test("Fetch shows the address", () => {
    expect(describeClaudeToolCall("WebFetch", { url: "https://example.com/x", prompt: "summarize" })).toMatchObject({ title: "Fetch", subject: "https://example.com/x", subjectKind: "url" });
  });

  test("long subjects are cut", () => {
    const command = "echo " + "x".repeat(5000);
    expect(describeClaudeToolCall("Bash", { command }).subject!.length).toBeLessThanOrEqual(2000);
  });
});

describe("permission context", () => {
  test("keeps the last non-sidechain assistant text before the pending tool", () => {
    const tail = jsonl(
      prompt("Create an isolated workspace."),
      assistant({ type: "text", text: "Earlier paragraph.\n\nI will create a worktree before making changes." }),
      JSON.stringify({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "Child text" }] } }),
      assistant(toolUse("pending", "EnterWorktree", {}), { type: "text", text: "Not before the call" }),
    );
    expect(findClaudePendingToolContext(tail, "EnterWorktree")).toEqual({
      text: "I will create a worktree before making changes.", source: "assistant", at: Date.parse(at),
    });
    expect(findClaudePendingToolContext(tail, "Bash")).toBeNull();
    expect(findClaudePendingToolContext(tail + result("pending"), "EnterWorktree")).toBeNull();
  });

  test("stops at the last typed prompt, ignores tool results and meta prompts", () => {
    const tail = jsonl(assistant({ type: "text", text: "Old task" }), prompt("New task"),
      JSON.stringify({ type: "user", isMeta: true, message: { content: "Internal reminder" } }),
      result("previous"), assistant(toolUse("pending", "Bash", {})));
    expect(findClaudePendingToolContext(tail, "Bash")).toEqual({ text: "New task", source: "prompt", at: null });
    expect(findClaudePendingToolContext(tail + "\n" + prompt("Interrupt"), "Bash")).toBeNull();
  });

  test("reads a hook-time on-disk fixture using only the bounded tail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "permission-context-"));
    try {
      const path = join(dir, "invented-session.jsonl");
      // Fixture captures the hook boundary: assistant text and tool_use have
      // been flushed; no tool_result exists until the permission is decided.
      await writeFile(path, "x".repeat(300 * 1024) + "\n" + jsonl(prompt("Isolate changes."),
        assistant({ type: "text", text: "Creating an isolated worktree." }),
        assistant(toolUse("pending", "EnterWorktree", {}))));
      expect(await readClaudePendingToolContext(path, "EnterWorktree")).toEqual({
        text: "Creating an isolated worktree.", source: "assistant", at: Date.parse(at),
      });
      expect(await readClaudePendingToolContext(path, "Bash")).toBeNull();
      expect(await readClaudePendingToolContext(join(dir, "missing.jsonl"), "Bash")).toBeNull();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
