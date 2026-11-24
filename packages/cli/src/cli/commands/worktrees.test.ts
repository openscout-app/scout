import { describe, expect, test } from "bun:test";

import { parseWorktreesCommandOptions, renderWorktreeRetirementReport } from "./worktrees.ts";

describe("scout worktrees", () => {
  test("parses status and retire with a dry run and project folders", () => {
    expect(parseWorktreesCommandOptions([], "/work")).toMatchObject({ command: "status", dryRun: false, projects: [] });
    expect(parseWorktreesCommandOptions(["retire", "--dry-run", "--project", "app", "--project=/srv/api"], "/work"))
      .toMatchObject({ command: "retire", dryRun: true, projects: ["/work/app", "/srv/api"] });
    expect(() => parseWorktreesCommandOptions(["status", "--dry-run"], "/work")).toThrow("go with scout worktrees retire");
    expect(() => parseWorktreesCommandOptions(["prune"], "/work")).toThrow("Unknown worktrees command");
    expect(() => parseWorktreesCommandOptions(["retire", "--force"], "/work")).toThrow("Unknown worktrees option");
  });

  test("labels the reclaimed size as approximate and gives each kept reason", () => {
    const text = renderWorktreeRetirementReport({
      trigger: "manual",
      dryRun: true,
      startedAt: 0,
      finishedAt: 0,
      settings: { enabled: true, idleHours: 24 },
      projectRoots: ["/srv/app"],
      worktrees: [
        { path: "/srv/app/.scout-worktrees/a", projectRoot: "/srv/app", branch: "scout/a", action: "would_retire", reasons: [], approxBytes: 3 * 1024 ** 2 },
        { path: "/srv/app/.scout-worktrees/b", projectRoot: "/srv/app", branch: "scout/b", action: "kept", reasons: ["scout/b has commits not in main"] },
        { path: "/srv/app/.scout-worktrees/c", projectRoot: "/srv/app", branch: "feature/c", action: "skipped", reasons: ["not Scout's"] },
      ],
      retired: 1,
      kept: 1,
      approxBytesReclaimed: 3 * 1024 ** 2,
      errors: [],
    });
    expect(text).toContain("Dry run: would retire 1 of 2 agent worktrees, ~3 MB by du, approximate");
    expect(text).toContain("scout/b has commits not in main");
    expect(text).toContain("Nothing was changed.");
  });
});
