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
          cwd: "/Users/art/dev/blink",
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
    expect(result.session.cwd).toBe("/Users/art/dev/blink");
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
        payload: { id: sessionId, cwd: "/Users/art/dev/blink" },
      })}\n`,
    );

    const result = locateHarnessSession({
      nativeSessionId: sessionId,
      harness: "codex",
      projectPath: "/Users/art/dev/openscout",
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
      projectPath: "/Users/art/dev/blink",
      codexSessionsRoot: codexRoot,
      claudeProjectsRoot: makeRoot("claude-empty-4"),
    });
    expect(withProject.ok).toBe(true);
    if (withProject.ok) expect(withProject.session.cwd).toBe("/Users/art/dev/blink");
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
        payload: { id: sessionId, cwd: "/Users/art/dev/blink" },
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
