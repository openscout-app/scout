import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { gcScoutWorktrees, listScoutWorktrees } from "./agent-workspace-gc.js";
import { execSystemFile } from "./system-probes/exec.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execSystemFile("git", args, { cwd, timeoutMs: 10_000 })).stdout;
}

describe("Scout worktree GC", () => {
  let fixture: string;
  let root: string;
  let workspaceDir: string;

  beforeEach(async () => {
    fixture = await realpath(await mkdtemp(join(tmpdir(), "scout-worktree-gc-")));
    root = join(fixture, "project");
    workspaceDir = join(root, ".scout-worktrees");
    await mkdir(workspaceDir, { recursive: true });
    await git(root, "init", "-q", "-b", "main");
    await git(root, "config", "user.name", "Test");
    await git(root, "config", "user.email", "test@example.com");
    await writeFile(join(root, "tracked.txt"), "initial\n");
    await git(root, "add", "tracked.txt");
    await git(root, "commit", "-qm", "Initial commit");
  });

  afterEach(async () => {
    if (fixture) await rm(fixture, { recursive: true, force: true });
  });

  async function addWorktree(name: string, branch = `scout/${name}`): Promise<string> {
    const path = join(workspaceDir, name);
    await git(root, "worktree", "add", "-q", "-b", branch, "--", path);
    return path;
  }

  async function advance(path: string) {
    await git(path, "commit", "-qm", "Agent work", "--allow-empty");
    return (await git(path, "rev-parse", "HEAD")).trim();
  }

  test("lists and removes a merged clean worktree and deletes its Scout branch", async () => {
    const path = await addWorktree("finished");
    const head = await advance(path);
    await git(root, "merge", "--ff-only", "scout/finished");

    expect((await listScoutWorktrees(root)).worktrees).toEqual([{
      path, name: "finished", branch: "scout/finished", head, clean: true,
      merged: true, locked: false, activeSession: false, eligible: true,
    }]);
    const report = await gcScoutWorktrees(root);
    expect(report.worktrees).toMatchObject([{ path, action: "removed", branchDeleted: true }]);
    expect(report.warnings).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect(await git(root, "branch", "--list", "scout/finished")).toBe("");
    expect(await git(root, "worktree", "list", "--porcelain")).not.toContain(path);
  });

  test("keeps tracked, staged, untracked, and unmerged work", async () => {
    const modified = await addWorktree("modified");
    const staged = await addWorktree("staged");
    const untracked = await addWorktree("untracked");
    const unmerged = await addWorktree("unmerged");
    await writeFile(join(modified, "tracked.txt"), "modified\n");
    await writeFile(join(staged, "tracked.txt"), "staged\n");
    await git(staged, "add", "tracked.txt");
    await git(root, "config", "status.showUntrackedFiles", "no");
    await writeFile(join(untracked, "new.txt"), "untracked\n");
    await advance(unmerged);

    const { worktrees } = await gcScoutWorktrees(root);
    expect(Object.fromEntries(worktrees.map(entry => [entry.name, entry.skipReason])))
      .toEqual({ modified: "dirty", staged: "dirty", untracked: "dirty", unmerged: "unmerged" });
    for (const entry of worktrees) {
      expect(entry.action).toBe("skipped");
      expect(existsSync(entry.path)).toBe(true);
    }
  });

  test("keeps locked worktrees and worktrees whose active session cwd is a symlinked subdirectory", async () => {
    const locked = await addWorktree("locked");
    const active = await addWorktree("active");
    const sibling = await addWorktree("active-sibling");
    await git(root, "worktree", "lock", "--reason", "Keep this\nworktree", locked);
    await mkdir(join(active, "nested"));
    const alias = join(fixture, "alias");
    await symlink(active, alias, "dir");

    const { worktrees } = await gcScoutWorktrees(root, { activePaths: new Set([join(alias, "nested")]) });
    const byName = Object.fromEntries(worktrees.map(entry => [entry.name, entry]));
    expect(byName.locked).toMatchObject({ locked: true, skipReason: "locked", action: "skipped" });
    expect(byName.active).toMatchObject({ activeSession: true, clean: true, skipReason: "active", action: "skipped" });
    expect(byName["active-sibling"]).toMatchObject({ path: sibling, action: "removed" });
    expect(existsSync(locked)).toBe(true);
    expect(existsSync(active)).toBe(true);
  });

  test("does not list or touch the main checkout, sibling directories, or external worktrees", async () => {
    const path = await addWorktree("inside");
    const external = join(fixture, ".scout-worktrees-backup", "external");
    const absent = join(fixture, "absent");
    await git(root, "worktree", "add", "-q", "-b", "scout/external", external);
    await git(root, "worktree", "add", "-q", "-b", "scout/absent", absent);
    await rename(absent, join(fixture, "temporarily-unmounted"));
    const gitfile = join(root, ".git", "worktrees", "absent", "gitdir");
    await utimes(gitfile, new Date(0), new Date(0));

    expect((await gcScoutWorktrees(root)).worktrees).toMatchObject([{ path, action: "removed" }]);
    expect(existsSync(external)).toBe(true);
    expect(existsSync(root)).toBe(true);
    expect(existsSync(gitfile)).toBe(true);
    expect(await git(root, "branch", "--list", "scout/external")).toContain("scout/external");
  });

  test("does not follow a workspace directory or registered child redirected through a symlink", async () => {
    const path = await addWorktree("inside");
    const movedWorkspaces = join(fixture, "workspaces");
    await rename(workspaceDir, movedWorkspaces);
    await symlink(movedWorkspaces, workspaceDir, "dir");
    expect((await gcScoutWorktrees(root)).worktrees).toEqual([]);
    expect(existsSync(join(movedWorkspaces, "inside"))).toBe(true);

    await rm(workspaceDir);
    await rename(movedWorkspaces, workspaceDir);
    const movedChild = join(fixture, "moved-child");
    await rename(path, movedChild);
    await symlink(movedChild, path, "dir");
    expect((await gcScoutWorktrees(root)).worktrees).toEqual([]);
    expect(await readFile(join(movedChild, "tracked.txt"), "utf8")).toBe("initial\n");
  });

  test("keeps a registered worktree path that has been reused for a different repository", async () => {
    const path = await addWorktree("reused");
    await rename(path, join(fixture, "original"));
    await mkdir(path);
    await git(path, "init", "-q", "-b", "main");
    await git(path, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "Different history", "--allow-empty");

    expect((await gcScoutWorktrees(root)).worktrees).toMatchObject([
      { path, eligible: false, action: "skipped", skipReason: "git_error" },
    ]);
    expect(await git(path, "log", "-1", "--format=%s")).toBe("Different history\n");
  });

  test("dry run leaves files, index, refs, and worktree registrations unchanged", async () => {
    const path = await addWorktree("with space", "scout/with-space");
    const gitPath = (await git(path, "rev-parse", "--git-path", "index")).trim();
    const index = isAbsolute(gitPath) ? gitPath : join(path, gitPath);
    await utimes(index, new Date(0), new Date(0));
    const indexBefore = await readFile(index);
    const mtimeBefore = (await stat(index)).mtimeMs;
    const refsBefore = await git(root, "show-ref");
    const worktreesBefore = await git(root, "worktree", "list", "--porcelain");

    const report = await gcScoutWorktrees(root, { dryRun: true, baseRef: "HEAD" });
    expect(report).toMatchObject({ baseRef: "HEAD", dryRun: true, worktrees: [{ path, action: "would_remove" }] });
    expect(existsSync(path)).toBe(true);
    expect(await readFile(index)).toEqual(indexBefore);
    expect((await stat(index)).mtimeMs).toBe(mtimeBefore);
    expect(await git(root, "show-ref")).toBe(refsBefore);
    expect(await git(root, "worktree", "list", "--porcelain")).toBe(worktreesBefore);
  });

  test("prefers origin/main and honors Git's refusal to delete a branch with -d", async () => {
    const path = await addWorktree("remote-merge");
    const head = await advance(path);
    await git(root, "update-ref", "refs/remotes/origin/main", head);

    expect((await listScoutWorktrees(root, { baseRef: "main" })).worktrees[0]?.skipReason).toBe("unmerged");
    expect(await gcScoutWorktrees(root)).toMatchObject({
      baseRef: "refs/remotes/origin/main",
      worktrees: [{ path, action: "removed", branchDeleted: false }],
      warnings: [expect.stringContaining("Kept branch scout/remote-merge")],
    });
    expect(existsSync(path)).toBe(false);
    expect((await git(root, "rev-parse", "scout/remote-merge")).trim()).toBe(head);
  });

  test("keeps non-Scout branches and the selected base branch", async () => {
    const custom = await addWorktree("custom", "feature/custom");
    const base = await addWorktree("base");
    const { worktrees } = await gcScoutWorktrees(root, { baseRef: "scout/base" });
    expect(worktrees).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: base, action: "removed", branchDeleted: false }),
      expect.objectContaining({ path: custom, action: "removed", branchDeleted: false }),
    ]));
    expect(await git(root, "branch", "--list", "feature/custom")).toContain("feature/custom");
    expect(await git(root, "branch", "--list", "scout/base")).toContain("scout/base");
  });

  test("falls back to HEAD without either main ref and rejects invalid explicit bases", async () => {
    await git(root, "branch", "-m", "trunk");
    expect((await listScoutWorktrees(root)).baseRef).toBe("HEAD");
    for (const baseRef of ["", "-n", "--all", "main\0other"]) {
      await expect(listScoutWorktrees(root, { baseRef })).rejects.toThrow("must be non-empty");
    }
    await expect(gcScoutWorktrees(root, { baseRef: "missing" })).rejects.toThrow("does not resolve to a commit");
  });
});
