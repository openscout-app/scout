import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { readAntigravitySessionRecords } from "@openscout/runtime";

import { handleAntigravityPermissionHook, handleClaudePermissionHook } from "./permission-hook.ts";

const hook = JSON.stringify({
  hook_event_name: "PermissionRequest", session_id: "0f10496b", cwd: "/tmp/project", permission_mode: "default",
  tool_name: "Bash", tool_input: { command: "rm -rf dist", description: "Remove the build output" },
});

function runtime(replies: Array<unknown | Error>) {
  const posts: Array<{ path: string; body: unknown }> = [];
  const out: string[] = [];
  return {
    posts, out,
    deps: {
      post: async <T,>(path: string, body: unknown): Promise<T> => {
        posts.push({ path, body });
        const reply = replies.shift();
        if (reply instanceof Error || reply === undefined) throw reply ?? new Error("no reply");
        return reply as T;
      },
      write: (text: string) => { out.push(text); },
    },
  };
}

describe("scout permission-hook claude", () => {
  test("waits through open polls and prints the operator's allow for Claude Code", async () => {
    const r = runtime([{ requestId: "permission-1" }, { state: "open" }, { state: "decided", decision: "allow" }]);
    await handleClaudePermissionHook(hook, r.deps);
    expect(r.posts).toEqual([
      { path: "/v1/permissions/native", body: { harness: "claude", sessionId: "0f10496b", cwd: "/tmp/project", toolName: "Bash",
        toolInput: { command: "rm -rf dist", description: "Remove the build output" } } },
      { path: "/v1/permissions/native/wait", body: { requestId: "permission-1", waitMs: 8000 } },
      { path: "/v1/permissions/native/wait", body: { requestId: "permission-1", waitMs: 8000 } },
    ]);
    expect(r.out.map((line) => JSON.parse(line))).toEqual([{ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }]);
  });

  test("Allow always forwards Claude Code's suggestions and hands back the rules to keep", async () => {
    const rule = { type: "addRules", behavior: "allow", destination: "localSettings", rules: [{ toolName: "Bash", ruleContent: "rm -rf dist" }] };
    const r = runtime([{ requestId: "permission-1" }, { state: "decided", decision: "allow", updatedPermissions: [rule] }]);
    await handleClaudePermissionHook(JSON.stringify({ ...JSON.parse(hook), permission_suggestions: [rule] }), r.deps);
    expect(r.posts[0]!.body).toMatchObject({ suggestions: [rule] });
    expect(JSON.parse(r.out[0]!)).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedPermissions: [rule] } } });
  });

  test("a denial carries a message for the model", async () => {
    const r = runtime([{ requestId: "permission-1" }, { state: "decided", decision: "deny" }]);
    await handleClaudePermissionHook(hook, r.deps);
    expect(JSON.parse(r.out[0]!)).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: "The operator denied this from Scout." } } });
  });

  test.each([
    ["the runtime is down", [new Error("ECONNREFUSED")]],
    ["Scout launched the session", [{ skipped: "scout_managed" }]],
    ["the dialog was answered in the session", [{ requestId: "permission-1" }, { state: "ended", reason: "Answered in the session." }]],
    ["the runtime stops answering", [{ requestId: "permission-1" }, new Error("x"), new Error("x"), new Error("x")]],
  ])("prints nothing when %s, so the dialog stays the session's", async (_why, replies) => {
    const r = runtime(replies as Array<unknown | Error>);
    await handleClaudePermissionHook(hook, r.deps);
    expect(r.out).toEqual([]);
  }, 10_000);

  test("input that is not a permission dialog is ignored without a call", async () => {
    for (const raw of ["not json", JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: "/", tool_name: "Bash" }),
      JSON.stringify({ hook_event_name: "PermissionRequest", cwd: "/", tool_name: "Bash" })]) {
      const r = runtime([]);
      await handleClaudePermissionHook(raw, r.deps);
      expect(r.posts).toEqual([]); expect(r.out).toEqual([]);
    }
  });
});

test("passes transcript_path to the runtime without interpreting it", async () => {
  const r = runtime([{ skipped: "no_live_session" }]);
  await handleClaudePermissionHook(JSON.stringify({ ...JSON.parse(hook), transcript_path: "/example/.claude/projects/project/0f10496b.jsonl" }), r.deps);
  expect(r.posts[0]?.body).toMatchObject({ transcriptPath: "/example/.claude/projects/project/0f10496b.jsonl" });
});

describe("scout permission-hook antigravity", () => {
  test("never answers PreToolUse without a decision, even for bad input", async () => {
    const out: string[] = [];
    const write = (t: string) => out.push(t);
    await handleAntigravityPermissionHook("not json", { write });
    await handleAntigravityPermissionHook(JSON.stringify({ hookEventName: "PreToolUse", conversationId: "bad id" }), { write });
    await handleAntigravityPermissionHook(JSON.stringify({ hookEventName: "Stop", conversationId: "bad id" }), { write });
    expect(out.map((line) => JSON.parse(line))).toEqual([{ decision: "ask" }, { decision: "ask" }, {}]);
  });

  test("records unsandboxed commands and ask_question on PreToolUse, clears on PostToolUse/Stop, and defers PreToolUse to Antigravity with decision ask when broker is offline", async () => {
    const recordsDirectory = mkdtempSync(join(tmpdir(), "scout-agy-hook-"));
    const sessionId = "3a102f26-6237-46c4-ae20-6152148eecaa";
    const out: string[] = [];
    const now = 1_800_000_000_000;
    const offlinePost = async () => { throw new Error("ECONNREFUSED"); };
    try {
      await handleAntigravityPermissionHook(JSON.stringify({
        hookEventName: "PreToolUse",
        conversationId: sessionId,
        cwd: "/tmp/workspace",
        workspacePaths: ["/tmp/workspace"],
        toolCall: { id: "t1", name: "run_command", args: { CommandLine: "bun test", BypassSandbox: false } },
      }), { recordsDirectory, now: () => now, post: offlinePost, write: (t) => out.push(t) });
      expect(await readAntigravitySessionRecords({ directory: recordsDirectory, now })).toEqual([]);
      expect(out).toEqual(['{"decision":"ask"}\n']);

      await handleAntigravityPermissionHook(JSON.stringify({
        hookEventName: "PreToolUse",
        conversationId: sessionId,
        cwd: "/tmp/workspace",
        workspacePaths: ["/tmp/workspace"],
        toolCall: { id: "t2", name: "run_command", args: { CommandLine: "gh pr create", BypassSandbox: true, toolSummary: "Create PR" } },
      }), { recordsDirectory, now: () => now, post: offlinePost, write: (t) => out.push(t) });
      const waiting = await readAntigravitySessionRecords({ directory: recordsDirectory, now });
      expect(waiting).toHaveLength(1);
      expect(waiting[0]).toMatchObject({
        sessionId,
        status: "waiting",
        waitingFor: "Unsandboxed command: gh pr create",
      });

      await handleAntigravityPermissionHook(JSON.stringify({
        hookEventName: "PostToolUse",
        conversationId: sessionId,
        cwd: "/tmp/workspace",
        toolCall: { id: "t2", name: "run_command", args: {} },
      }), { recordsDirectory, now: () => now, post: offlinePost, write: (t) => out.push(t) });
      expect(await readAntigravitySessionRecords({ directory: recordsDirectory, now })).toEqual([]);
      expect(out).toEqual(['{"decision":"ask"}\n', '{"decision":"ask"}\n', "{}\n"]);
    } finally {
      rmSync(recordsDirectory, { recursive: true, force: true });
    }
  });

  test("auto-allows in-policy Antigravity calls immediately and waits on Scout escalations for Allow or Deny", async () => {
    const recordsDirectory = mkdtempSync(join(tmpdir(), "scout-agy-engine-"));
    const sessionId = "3a102f26-6237-46c4-ae20-6152148eecaa";
    const now = 1_800_000_000_000;
    try {
      // 1. Policy auto-allow returns decision: allow with zero polls.
      const autoRun = runtime([{ decision: "allow", reason: "workspace continues workspace", grant: "project:/tmp/workspace" }]);
      await handleAntigravityPermissionHook(JSON.stringify({
        hookEventName: "PreToolUse",
        conversationId: sessionId,
        cwd: "/tmp/workspace",
        workspacePaths: ["/tmp/workspace"],
        toolCall: { id: "t1", name: "run_command", args: { CommandLine: "bun test", BypassSandbox: false } },
      }), { ...autoRun.deps, recordsDirectory, now: () => now });
      expect(autoRun.posts).toEqual([{
        path: "/v1/permissions/native",
        body: {
          harness: "antigravity",
          sessionId,
          cwd: "/tmp/workspace",
          toolName: "run_command",
          toolInput: { CommandLine: "bun test", BypassSandbox: false },
          escalate: false,
        },
      }]);
      expect(autoRun.out.map((l) => JSON.parse(l))).toEqual([{ decision: "allow" }]);

      // 2. Escalation approved in Scout returns decision: allow and clears waiting record.
      const allowRun = runtime([{ requestId: "perm-agy-1" }, { state: "open" }, { state: "decided", decision: "allow" }]);
      await handleAntigravityPermissionHook(JSON.stringify({
        hookEventName: "PreToolUse",
        conversationId: sessionId,
        cwd: "/tmp/workspace",
        workspacePaths: ["/tmp/workspace"],
        toolCall: { id: "t2", name: "run_command", args: { CommandLine: "git push origin main", BypassSandbox: true } },
      }), { ...allowRun.deps, recordsDirectory, now: () => now });
      expect(allowRun.posts[0]).toMatchObject({ path: "/v1/permissions/native", body: { harness: "antigravity", escalate: true } });
      expect(allowRun.out.map((l) => JSON.parse(l))).toEqual([{ decision: "allow" }]);
      expect(await readAntigravitySessionRecords({ directory: recordsDirectory, now })).toEqual([]);

      // 3. Escalation denied in Scout returns decision: deny with reason.
      const denyRun = runtime([{ requestId: "perm-agy-2" }, { state: "decided", decision: "deny" }]);
      await handleAntigravityPermissionHook(JSON.stringify({
        hookEventName: "PreToolUse",
        conversationId: sessionId,
        cwd: "/tmp/workspace",
        workspacePaths: ["/tmp/workspace"],
        toolCall: { id: "t3", name: "run_command", args: { CommandLine: "rm -rf /tmp/foo", BypassSandbox: true } },
      }), { ...denyRun.deps, recordsDirectory, now: () => now });
      expect(denyRun.out.map((l) => JSON.parse(l))).toEqual([{ decision: "deny", reason: "The operator denied this from Scout." }]);
    } finally {
      rmSync(recordsDirectory, { recursive: true, force: true });
    }
  });
});
