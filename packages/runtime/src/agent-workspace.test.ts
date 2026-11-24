import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentWorkspace, resolveSessionWorkspace, SCOUT_WORKSPACES_DIRNAME } from "./agent-workspace.js";
import { setExecSystemSpawnForTests } from "./system-probes/exec.js";

const tempRoots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function configureAuthor(root: string): void {
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
}

function commit(root: string, message: string): string {
  git(root, "commit", "-q", "--allow-empty", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function makeGitRepo(branch = "main"): string {
  const root = makeTempDir();
  git(root, "init", "-q", "-b", branch);
  configureAuthor(root);
  commit(root, "init");
  return root;
}

function cloneRepo(remote: string): string {
  const root = makeTempDir();
  git(root, "clone", "-q", "--", remote, ".");
  configureAuthor(root);
  return root;
}

function makeTempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "scout-ws-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("createAgentWorkspace", () => {
  test("creates a git worktree under .scout-worktrees on branch scout/<agent>", async () => {
    const root = makeGitRepo();
    const result = await createAgentWorkspace(root, "explorer");

    expect(result).not.toBeNull();
    expect(result!.path).toBe(join(root, SCOUT_WORKSPACES_DIRNAME, "explorer"));
    expect(result!.branch).toBe("scout/explorer");
    expect(statSync(result!.path).isDirectory()).toBe(true);

    expect(git(result!.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("scout/explorer");
  });

  test("honors a requested branch name", async () => {
    const root = makeGitRepo();
    const result = await createAgentWorkspace(root, "explorer", "feature/thing");

    expect(result!.branch).toBe("feature/thing");
    expect(git(result!.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/thing");
  });

  test("rejects option-like requested branch names before git worktree add", async () => {
    const root = makeGitRepo();

    await expect(createAgentWorkspace(root, "explorer", "--orphan=/tmp/x")).rejects.toThrow("must not start with '-'");
    expect(existsSync(join(root, SCOUT_WORKSPACES_DIRNAME, "explorer"))).toBe(false);
  });

  test.each(["--detach", " \t", "HEAD\0"])("rejects unsafe baseRef %j before running Git", async (baseRef) => {
    const root = makeGitRepo();
    let spawns = 0;
    setExecSystemSpawnForTests(() => {
      spawns++;
      throw new Error("Git must not run");
    });
    try {
      await expect(createAgentWorkspace(root, "explorer", undefined, { baseRef }))
        .rejects.toThrow("git worktree baseRef must be non-empty");
      expect(spawns).toBe(0);
    } finally {
      setExecSystemSpawnForTests(null);
    }
  });

  test("rejects an explicit baseRef that does not resolve to a commit", async () => {
    const root = makeGitRepo();
    await expect(createAgentWorkspace(root, "explorer", undefined, { baseRef: "refs/heads/missing" }))
      .rejects.toThrow('baseRef "refs/heads/missing" does not resolve to a commit');
    expect(existsSync(join(root, SCOUT_WORKSPACES_DIRNAME))).toBe(false);
  });

  test("does not attach a different existing branch in place of an explicit base", async () => {
    const root = makeGitRepo();
    git(root, "branch", "scout/explorer");
    const baseRef = commit(root, "requested base");

    await expect(createAgentWorkspace(root, "explorer", undefined, { baseRef }))
      .rejects.toThrow('could not create branch "scout/explorer" at baseRef');
    expect(existsSync(join(root, SCOUT_WORKSPACES_DIRNAME, "explorer"))).toBe(false);
  });

  test("reuses an existing workspace at the same path", async () => {
    const root = makeGitRepo();
    const first = await createAgentWorkspace(root, "explorer");
    const nextBase = commit(root, "new head");
    const second = await createAgentWorkspace(root, "explorer", undefined, { baseRef: nextBase });

    expect(second).not.toBeNull();
    expect(second!.path).toBe(first!.path);
    expect(second!.branch).toBe("scout/explorer");
    expect(second!.baseRef).toBeUndefined();
    expect(git(second!.path, "rev-parse", "HEAD")).toBe(first!.baseRef!);
  });

  test("returns null when the project is not a git repo", async () => {
    const root = makeTempDir();
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    // TMPDIR may itself be inside a checkout. Stop discovery before its parent
    // so this case cannot create a branch or worktree in the enclosing repo.
    process.env.GIT_CEILING_DIRECTORIES = realpathSync(dirname(root));
    try {
      const result = await createAgentWorkspace(root, "explorer");

      expect(result).toBeNull();
      expect(existsSync(join(root, SCOUT_WORKSPACES_DIRNAME))).toBe(false);
    } finally {
      if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    }
  });

  test("temporary workspace and setup fixtures leave an enclosing TMPDIR repository unchanged", async () => {
    const repo = makeGitRepo();
    const nestedTmp = join(repo, "tmp");
    mkdirSync(nestedTmp);
    const branchesBefore = git(repo, "for-each-ref", "refs/heads");
    const worktreesBefore = git(repo, "worktree", "list", "--porcelain");
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: nestedTmp, TMP: nestedTmp, TEMP: nestedTmp };
    // The subprocess must supply its own ceiling, not inherit one from us.
    delete env.GIT_CEILING_DIRECTORIES;

    const child = Bun.spawn([
      process.execPath,
      "test", fileURLToPath(import.meta.url),
      fileURLToPath(new URL("./setup.test.ts", import.meta.url)),
      "--test-name-pattern", "^(createAgentWorkspace returns null when the project is not a git repo|setup inventory creates a project manifest directly in the explicit Relay context root)$",
    ], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, output: stdout + stderr }).toMatchObject({ exitCode: 0 });
      // A renamed test must not turn this into a successful zero-test run.
      expect(stderr).toContain("2 pass");
      expect(stderr).toContain("0 fail");
    } finally {
      clearTimeout(timeout);
      child.kill("SIGKILL");
      await child.exited;
    }

    expect(git(repo, "for-each-ref", "refs/heads")).toBe(branchesBefore);
    expect(git(repo, "worktree", "list", "--porcelain")).toBe(worktreesBefore);
    expect(existsSync(join(repo, ".git", "worktrees"))).toBe(false);
    expect(existsSync(join(repo, ".openscout"))).toBe(false);
    expect(existsSync(join(repo, ".gitignore"))).toBe(false);
  }, 20_000);
});

describe("resolveSessionWorkspace", () => {
  test("runs in the project root when no worktree is requested", async () => {
    const root = makeGitRepo();
    expect(await resolveSessionWorkspace({ projectRoot: root, agentName: "quill" })).toEqual({ cwd: root });
    expect(await resolveSessionWorkspace({ projectRoot: root, agentName: "quill", workspace: "same" })).toEqual({ cwd: root });
    expect(existsSync(join(root, SCOUT_WORKSPACES_DIRNAME))).toBe(false);
  });

  test("new_worktree runs the session in a git worktree from HEAD when there is no remote", async () => {
    const root = makeGitRepo();
    const head = git(root, "rev-parse", "HEAD");
    const workspace = await resolveSessionWorkspace({ projectRoot: root, agentName: "quill", workspace: "new_worktree" });

    expect(workspace).toEqual({ cwd: join(root, SCOUT_WORKSPACES_DIRNAME, "quill"), branch: "scout/quill", baseRef: head });
    expect(git(workspace.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe("scout/quill");
    expect(git(workspace.cwd, "rev-parse", "HEAD")).toBe(head);
  });

  test("uses the configured base, or an explicit baseRef in preference to it", async () => {
    const root = makeGitRepo();
    const tagged = git(root, "rev-parse", "HEAD");
    git(root, "tag", "-a", "v1", "-m", "version one");
    const configured = commit(root, "configured base");
    git(root, "branch", "release");
    git(root, "config", "scout.worktreeBase", "release");
    commit(root, "checkout tip");

    const defaultWorkspace = await resolveSessionWorkspace({ projectRoot: root, agentName: "default", workspace: "new_worktree" });
    expect(defaultWorkspace.baseRef).toBe(configured);
    expect(git(defaultWorkspace.cwd, "rev-parse", "HEAD")).toBe(configured);

    const explicitWorkspace = await resolveSessionWorkspace({ projectRoot: root, agentName: "explicit", workspace: "new_worktree", baseRef: "v1" });
    expect(explicitWorkspace.baseRef).toBe(tagged);
    expect(git(explicitWorkspace.cwd, "rev-parse", "HEAD")).toBe(tagged);
  });

  test("refreshes origin/main before branching without moving local main", async () => {
    const remote = makeGitRepo();
    const root = cloneRepo(remote);
    const local = git(root, "rev-parse", "HEAD");
    const remoteTip = commit(remote, "new remote tip");
    expect(git(root, "rev-parse", "origin/main")).toBe(local);
    // A broader fetch would update this local branch as well.
    git(root, "config", "--add", "remote.origin.fetch", "+refs/heads/main:refs/heads/local-mirror");
    git(root, "branch", "local-mirror");

    const workspace = await resolveSessionWorkspace({ projectRoot: root, agentName: "quill", workspace: "new_worktree" });

    expect(workspace.baseRef).toBe(remoteTip);
    expect(git(workspace.cwd, "rev-parse", "HEAD")).toBe(remoteTip);
    expect(git(root, "rev-parse", "origin/main")).toBe(remoteTip);
    expect(git(root, "rev-parse", "HEAD")).toBe(local);
    expect(git(root, "rev-parse", "refs/heads/main")).toBe(local);
    expect(git(root, "rev-parse", "refs/heads/local-mirror")).toBe(local);
  });

  test.each(["main", "trunk"])("uses the ahead origin fallback on %s without a configured upstream", async (branch) => {
    const remote = makeGitRepo(branch);
    const root = cloneRepo(remote);
    git(root, "branch", "--unset-upstream");
    git(root, "config", "scout.worktreeBase", "refs/heads/missing");
    const remoteTip = commit(remote, "new remote tip");

    const workspace = await resolveSessionWorkspace({ projectRoot: root, agentName: "quill", workspace: "new_worktree" });
    expect(workspace.baseRef).toBe(remoteTip);
    expect(git(workspace.cwd, "rev-parse", "HEAD")).toBe(remoteTip);
  });

  test("prefers the current branch's configured upstream to origin/main", async () => {
    const remote = makeGitRepo();
    git(remote, "branch", "release");
    const root = cloneRepo(remote);
    git(root, "branch", "--set-upstream-to=origin/release");
    commit(remote, "new main tip");
    git(remote, "switch", "-q", "release");
    const releaseTip = commit(remote, "new release tip");

    const workspace = await resolveSessionWorkspace({ projectRoot: root, agentName: "quill", workspace: "new_worktree" });
    expect(git(workspace.cwd, "rev-parse", "HEAD")).toBe(releaseTip);
  });

  test.each(["ahead", "diverged"])("keeps HEAD when the local branch is %s relative to origin/main", async (relation) => {
    const remote = makeGitRepo();
    const root = cloneRepo(remote);
    const local = commit(root, "local work");
    if (relation === "diverged") commit(remote, "remote work");

    const workspace = await resolveSessionWorkspace({ projectRoot: root, agentName: "quill", workspace: "new_worktree" });
    expect(workspace.baseRef).toBe(local);
    expect(git(workspace.cwd, "rev-parse", "HEAD")).toBe(local);
  });

  test("keeps HEAD after a failed fetch unless the caller disables refreshing", async () => {
    const remote = makeGitRepo();
    const root = cloneRepo(remote);
    const local = git(root, "rev-parse", "HEAD");
    const cachedTip = commit(remote, "remote work");
    git(root, "fetch", "-q", "origin");
    git(root, "remote", "set-url", "origin", join(remote, "missing"));

    const offline = await resolveSessionWorkspace({ projectRoot: root, agentName: "offline", workspace: "new_worktree" });
    expect(git(offline.cwd, "rev-parse", "HEAD")).toBe(local);

    const cached = await resolveSessionWorkspace({ projectRoot: root, agentName: "cached", workspace: "new_worktree", fetchBase: false });
    expect(git(cached.cwd, "rev-parse", "HEAD")).toBe(cachedTip);

    git(root, "config", "scout.worktreeBase", "origin/main");
    const configured = await resolveSessionWorkspace({ projectRoot: root, agentName: "configured", workspace: "new_worktree" });
    expect(git(configured.cwd, "rev-parse", "HEAD")).toBe(cachedTip);
  });

  test("new_worktree fails with a diagnostic instead of falling back to the project root", async () => {
    const root = makeTempDir();
    await expect(resolveSessionWorkspace({ projectRoot: root, agentName: "quill", workspace: "new_worktree" }))
      .rejects.toThrow(/workspace new_worktree: could not create a git worktree/);
  });
});
