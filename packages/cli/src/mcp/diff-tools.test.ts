import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SCOUT_MCP_CORE_TOOL_NAMES } from "@openscout/protocol";

import { changedWorktrees, registerDiffTools, renderChangedWorktrees, renderDiff } from "./diff-tools.ts";

const worktree = (path: string, overrides: Record<string, unknown> = {}) => ({
  path,
  branch: { name: "feat/x", upstream: "origin/feat/x", ahead: 0, behind: 0, isMain: false },
  status: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0, changedFiles: 0 },
  diff: { branchShortstat: null, unstagedShortstat: null, stagedShortstat: null },
  agents: [],
  ...overrides,
});

const WATCH = {
  generatedAt: 1,
  projects: [{
    name: "scout-apps",
    root: "/work/scout-apps",
    worktrees: [
      worktree("/work/scout-apps", { lastTouchedAt: 10 }),
      worktree("/work/scout-apps-a", {
        status: { staged: 1, unstaged: 2, untracked: 1, conflicts: 0, changedFiles: 4 },
        diff: { branchShortstat: null, unstagedShortstat: "3 files changed, 20 insertions(+)", stagedShortstat: null },
        agents: [{ id: "a1", name: "lovelace", state: "working", harness: "codex" }],
        lastTouchedAt: 20,
      }),
      worktree("/work/scout-apps-b", {
        branch: { name: "feat/b", upstream: null, ahead: 3, behind: 1, isMain: false },
        diff: { branchShortstat: "5 files changed, 80 insertions(+), 4 deletions(-)", unstagedShortstat: null, stagedShortstat: null },
        lastTouchedAt: 30,
      }),
    ],
  }, {
    name: "scout",
    root: "/work/scout",
    worktrees: [worktree("/work/scout", { status: { staged: 0, unstaged: 1, untracked: 0, conflicts: 0, changedFiles: 1 }, lastTouchedAt: 5 })],
  }],
  warnings: [],
};

const DIFF = {
  worktreePath: "/work/scout-apps-a",
  layers: [
    { kind: "branch", baseLabel: "origin/main", compareLabel: "HEAD", rawPatch: null, truncated: false, files: [], shortstat: null },
    {
      kind: "unstaged", baseLabel: "index", compareLabel: "worktree", truncated: false, shortstat: "2 files changed, 12 insertions(+), 1 deletion(-)",
      rawPatch: `diff --git a/src/a.ts b/src/a.ts\n${"+line\n".repeat(400)}`,
      files: [
        { oldPath: "src/a.ts", newPath: "src/a.ts", status: "modified", binary: false, additions: 10, deletions: 1, truncated: false },
        { oldPath: "src/old.ts", newPath: "src/new.ts", status: "renamed", binary: false, additions: 2, deletions: 0, truncated: false },
      ],
    },
  ],
  diagnostics: [{ level: "warning", kind: "patch_truncated", message: "Patch truncated", path: null }],
};

describe("worktrees_changes", () => {
  test("lists only worktrees with changes or unpushed commits, most recently touched first", () => {
    const rows = changedWorktrees(WATCH);
    expect(rows.map((row) => row.path)).toEqual(["/work/scout-apps-b", "/work/scout-apps-a", "/work/scout"]);
    expect(rows[1]).toMatchObject({ staged: 1, unstaged: 2, untracked: 1, agents: ["lovelace"], workingShortstat: "3 files changed, 20 insertions(+)" });
  });

  test("a busy checkout lists a few distinct agents, working ones first, and counts the rest", () => {
    const agents = [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, name: `idle-${i % 6}`, state: "idle", harness: "claude" })),
      { id: "w1", name: "hopper", state: "working", harness: "codex" },
    ];
    const snapshot = { projects: [{ name: "p", root: "/p", worktrees: [worktree("/p", { agents, status: { staged: 0, unstaged: 1, untracked: 0, conflicts: 0, changedFiles: 1 } })] }] };
    const rows = changedWorktrees(snapshot);
    expect(rows[0]).toMatchObject({ agents: ["hopper", "idle-0", "idle-1", "idle-2"], agentCount: 7 });
    expect(renderChangedWorktrees(rows, { limit: 5, loading: false, warnings: [] })).toContain("agents: hopper, idle-0, idle-1, idle-2, and 3 more");
  });

  test("filters by a literal substring of the project or path", () => {
    expect(changedWorktrees(WATCH, "scout-apps-b").map((row) => row.path)).toEqual(["/work/scout-apps-b"]);
    expect(changedWorktrees(WATCH, "nothing-matches")).toEqual([]);
  });

  test("an empty list during a scan does not claim that nothing is changing", () => {
    expect(renderChangedWorktrees([], { limit: 5, loading: true, warnings: [] })).toContain("not evidence that nothing is changing");
    expect(renderChangedWorktrees([], { limit: 5, loading: false, warnings: [] })).toContain("No worktree Repo Watch covers");
  });

  test("states when the list is cut to the limit", () => {
    const text = renderChangedWorktrees(changedWorktrees(WATCH), { limit: 2, loading: false, warnings: [] });
    expect(text).toContain("3 worktrees with work in progress, showing the 2 most recently touched");
    expect(text).toContain("/work/scout-apps-b (scout-apps, feat/b): 3 ahead, 1 behind");
    expect(text).not.toContain("/work/scout (");
  });
});

describe("diff_read", () => {
  test("a summary lists each layer with changes and its files, without patch text", () => {
    const { text, cut } = renderDiff(DIFF as never, { detail: "summary", maxChars: 40_000 });
    expect(cut).toBe(false);
    expect(text).toContain("Not staged (index -> worktree): 2 files changed, 12 insertions(+), 1 deletion(-)");
    expect(text).toContain("modified src/a.ts +10 -1");
    expect(text).toContain("renamed src/old.ts -> src/new.ts +2 -0");
    expect(text).not.toContain("Committed on this branch");
    expect(text).not.toContain("+line");
    expect(text).toContain("Warning: Patch truncated");
  });

  test("a patch read is cut at the budget and says so", () => {
    const { text, cut } = renderDiff(DIFF as never, { detail: "patch", maxChars: 2_000 });
    expect(cut).toBe(true);
    expect(text).toContain("--- Not staged patch ---");
    expect(text).toContain("[Patch cut at 2000 characters.");
    expect(text.length).toBeLessThan(2_200);
  });

  test("a whole patch within the budget is not marked cut", () => {
    const { text, cut } = renderDiff(DIFF as never, { detail: "patch", maxChars: 40_000 });
    expect(cut).toBe(false);
    expect(text.split("+line").length - 1).toBe(400);
  });
});

test("the tools read the runtime's Repo Watch and diff routes and are not offered on the hosted bridge", async () => {
  const server = new McpServer({ name: "test", version: "1" });
  const paths: string[] = [];
  registerDiffTools(server, async (path) => {
    paths.push(path);
    return path.startsWith("/v1/repo-watch/") ? WATCH : DIFF;
  });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    const listed = await client.callTool({ name: "worktrees_changes", arguments: { project: "scout-apps" } });
    expect((listed.structuredContent as { total: number }).total).toBe(2);
    const read = await client.callTool({
      name: "diff_read",
      arguments: { path: "/work/scout-apps-a", files: ["src/a.ts", "src/a.ts"], layers: ["unstaged"], detail: "patch" },
    });
    expect((read.structuredContent as { cut: boolean }).cut).toBe(false);
    expect(paths).toEqual([
      "/v1/repo-watch/snapshot?includeDiff=1&maxWorktrees=64",
      "/v1/repo-diff/worktree?path=%2Fwork%2Fscout-apps-a&tier=patch&file=src%2Fa.ts&layers=unstaged",
    ]);
    const tools = (await client.listTools()).tools;
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(SCOUT_MCP_CORE_TOOL_NAMES as readonly string[]).not.toContain(tool.name);
    }
  } finally { await client.close(); await server.close(); }
});
