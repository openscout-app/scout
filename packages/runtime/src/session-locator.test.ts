import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import { locateHarnessSession } from "./session-locator.js";

const roots: string[] = [];

function makeRoot(prefix: string): string {
  const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("locateHarnessSession", () => {
  test("does not assign Claude a nonexistent decoded cwd", () => {
    const root = makeRoot("claude-slug");
    const dir = join(root, "-example-worktrees-my-project");
    mkdirSync(dir);
    writeFileSync(join(dir, "late-cwd.jsonl"), JSON.stringify({ type: "last-prompt" }) + "\n");
    const result = locateHarnessSession({
      nativeSessionId: "late-cwd",
      harness: "claude",
      claudeProjectsRoot: root,
      codexSessionsRoot: makeRoot("codex-empty"),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.session.cwd).toBe("");
  });

  test("reads a long transcript's head only, and still finds its session and folder", () => {
    const root = makeRoot("claude-long");
    const dir = join(root, "-work-app");
    mkdirSync(dir);
    const cwd = makeRoot("claude-long-cwd");
    const sessionId = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
    const head = JSON.stringify({ type: "user", sessionId, cwd }) + "\n";
    // A body far past the head, in multi-byte text so the cut can land mid-character.
    const body = (JSON.stringify({ type: "assistant", text: "é".repeat(4_000) }) + "\n").repeat(200);
    writeFileSync(join(dir, "another-name.jsonl"), head + body);

    const result = locateHarnessSession({
      nativeSessionId: sessionId,
      harness: "claude",
      claudeProjectsRoot: root,
      codexSessionsRoot: makeRoot("codex-empty"),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.session).toMatchObject({ nativeSessionId: sessionId, cwd, match: "jsonl" });
  });


  test("finds a Codex rollout by session id and cwd", () => {
    const codexRoot = makeRoot("codex-sessions");
    const day = join(codexRoot, "2026", "08", "03");
    mkdirSync(day, { recursive: true });
    const sessionId = "019fbee7-2a7f-7eb0-84bf-da22717c74d0";
    const path = join(day, `rollout-2026-08-03T12-00-00-${sessionId}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: sessionId,
          session_id: sessionId,
          cwd: "/Users/you/dev/blink",
        },
      })}\n`,
    );

    const result = locateHarnessSession({
      nativeSessionId: sessionId,
      harness: "codex",
      codexSessionsRoot: codexRoot,
      claudeProjectsRoot: makeRoot("claude-empty"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.harness).toBe("codex");
    expect(result.session.nativeSessionId).toBe(sessionId);
    expect(result.session.cwd).toBe("/Users/you/dev/blink");
    expect(result.session.path).toBe(path);
  });

  test("fails closed on cwd conflict", () => {
    const codexRoot = makeRoot("codex-cwd");
    const day = join(codexRoot, "2026", "08", "03");
    mkdirSync(day, { recursive: true });
    const sessionId = "019fbee7-aaaa-bbbb-cccc-ddddeeeeffff";
    writeFileSync(
      join(day, `rollout-${sessionId}.jsonl`),
      `${JSON.stringify({
        type: "session_meta",
        payload: { id: sessionId, cwd: "/Users/you/dev/blink" },
      })}\n`,
    );

    const result = locateHarnessSession({
      nativeSessionId: sessionId,
      harness: "codex",
      projectPath: "/Users/you/dev/openscout",
      codexSessionsRoot: codexRoot,
      claudeProjectsRoot: makeRoot("claude-empty-2"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("session_cwd_conflict");
  });

  test("requires --project when Codex rollout has no cwd", () => {
    const codexRoot = makeRoot("codex-nocwd");
    const day = join(codexRoot, "2026", "08", "03");
    mkdirSync(day, { recursive: true });
    const sessionId = "019fbee7-1111-2222-3333-444455556666";
    writeFileSync(
      join(day, `rollout-${sessionId}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { id: sessionId } })}\n`,
    );

    const missing = locateHarnessSession({
      nativeSessionId: sessionId,
      harness: "codex",
      codexSessionsRoot: codexRoot,
      claudeProjectsRoot: makeRoot("claude-empty-3"),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("session_not_resumable");

    const withProject = locateHarnessSession({
      nativeSessionId: sessionId,
      harness: "codex",
      projectPath: "/Users/you/dev/blink",
      codexSessionsRoot: codexRoot,
      claudeProjectsRoot: makeRoot("claude-empty-4"),
    });
    expect(withProject.ok).toBe(true);
    if (withProject.ok) expect(withProject.session.cwd).toBe("/Users/you/dev/blink");
  });

  test("the caller's own folder never conflicts with the session's folder", () => {
    const codexRoot = makeRoot("codex-caller-elsewhere");
    const day = join(codexRoot, "2026", "08", "03");
    mkdirSync(day, { recursive: true });
    const sessionId = "019fbee7-7777-8888-9999-aaaabbbbcccc";
    writeFileSync(
      join(day, `rollout-${sessionId}.jsonl`),
      `${JSON.stringify({
        type: "session_meta",
        payload: { id: sessionId, cwd: "/work/blink" },
      })}\n`,
    );

    const result = locateHarnessSession({
      nativeSessionId: sessionId,
      harness: "codex",
      fallbackCwd: "/work/openscout",
      codexSessionsRoot: codexRoot,
      claudeProjectsRoot: makeRoot("claude-empty-caller-1"),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.session.cwd).toBe("/work/blink");

    // A project the request names still has to match.
    const named = locateHarnessSession({
      nativeSessionId: sessionId,
      harness: "codex",
      projectPath: "/work/openscout",
      fallbackCwd: "/work/blink",
      codexSessionsRoot: codexRoot,
      claudeProjectsRoot: makeRoot("claude-empty-caller-2"),
    });
    expect(named.ok).toBe(false);
    if (!named.ok) expect(named.reason).toBe("session_cwd_conflict");
  });

  test("the caller's folder fills in a cwd the store does not have", () => {
    const codexRoot = makeRoot("codex-caller-fallback");
    const day = join(codexRoot, "2026", "08", "03");
    mkdirSync(day, { recursive: true });
    const sessionId = "019fbee7-dddd-eeee-ffff-000011112222";
    writeFileSync(
      join(day, `rollout-${sessionId}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { id: sessionId } })}\n`,
    );

    const fromCaller = locateHarnessSession({
      nativeSessionId: sessionId,
      harness: "codex",
      fallbackCwd: "/work/openscout",
      codexSessionsRoot: codexRoot,
      claudeProjectsRoot: makeRoot("claude-empty-caller-3"),
    });
    expect(fromCaller.ok).toBe(true);
    if (fromCaller.ok) expect(fromCaller.session.cwd).toBe("/work/openscout");

    // The named project wins over where the caller is.
    const named = locateHarnessSession({
      nativeSessionId: sessionId,
      harness: "codex",
      projectPath: "/work/blink",
      fallbackCwd: "/work/openscout",
      codexSessionsRoot: codexRoot,
      claudeProjectsRoot: makeRoot("claude-empty-caller-4"),
    });
    expect(named.ok).toBe(true);
    if (named.ok) expect(named.session.cwd).toBe("/work/blink");
  });

  test("returns session_unknown when absent", () => {
    const result = locateHarnessSession({
      nativeSessionId: "does-not-exist",
      harness: "codex",
      codexSessionsRoot: makeRoot("codex-none"),
      claudeProjectsRoot: makeRoot("claude-none"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("session_unknown");
  });

  test("Blink incident id shape is locatable from filename alone", () => {
    const codexRoot = makeRoot("codex-filename");
    const day = join(codexRoot, "2026", "08", "01");
    mkdirSync(day, { recursive: true });
    const sessionId = "019fbee7-2a7f-7eb0-84bf-da22717c74d0";
    writeFileSync(
      join(day, `rollout-2026-08-01T15-57-28-${sessionId}.jsonl`),
      `${JSON.stringify({
        type: "session_meta",
        payload: { id: sessionId, cwd: "/Users/you/dev/blink" },
      })}\n`,
    );

    const result = locateHarnessSession({
      nativeSessionId: sessionId,
      codexSessionsRoot: codexRoot,
      claudeProjectsRoot: makeRoot("claude-fn"),
    });
    expect(result.ok).toBe(true);
  });
});
