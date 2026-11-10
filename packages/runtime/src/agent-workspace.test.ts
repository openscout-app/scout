import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentWorkspace, resolveSessionWorkspace, SCOUT_WORKSPACES_DIRNAME } from "./agent-workspace.js";

const tempRoots: string[] = [];

function makeGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "scout-ws-"));
  tempRoots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  return root;
}

function makeNonGitDir(): string {
  const root = mkdtempSync(join(tmpdir(), "scout-nongit-"));
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

    const head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: result!.path,
    }).toString().trim();
    expect(head).toBe("scout/explorer");
  });

  test("honors a requested branch name", async () => {
    const root = makeGitRepo();
    const result = await createAgentWorkspace(root, "explorer", "feature/thing");

    expect(result!.branch).toBe("feature/thing");
    const head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: result!.path,
    }).toString().trim();
    expect(head).toBe("feature/thing");
  });

  test("rejects option-like requested branch names before git worktree add", async () => {
    const root = makeGitRepo();

    await expect(createAgentWorkspace(root, "explorer", "--orphan=/tmp/x")).rejects.toThrow("must not start with '-'");
    expect(existsSync(join(root, SCOUT_WORKSPACES_DIRNAME, "explorer"))).toBe(false);
  });

  test("reuses an existing workspace at the same path", async () => {
    const root = makeGitRepo();
    const first = await createAgentWorkspace(root, "explorer");
    const second = await createAgentWorkspace(root, "explorer");

    expect(second).not.toBeNull();
    expect(second!.path).toBe(first!.path);
    expect(second!.branch).toBe("scout/explorer");
  });

  test("returns null when the project is not a git repo", async () => {
    const root = makeNonGitDir();
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
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString();
    const branchesBefore = git("for-each-ref", "refs/heads");
    const worktreesBefore = git("worktree", "list", "--porcelain");
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

    expect(git("for-each-ref", "refs/heads")).toBe(branchesBefore);
    expect(git("worktree", "list", "--porcelain")).toBe(worktreesBefore);
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

  test("new_worktree runs the session in a git worktree, not the project root", async () => {
    const root = makeGitRepo();
    const workspace = await resolveSessionWorkspace({ projectRoot: root, agentName: "quill", workspace: "new_worktree" });

    expect(workspace).toEqual({ cwd: join(root, SCOUT_WORKSPACES_DIRNAME, "quill"), branch: "scout/quill" });
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspace.cwd, encoding: "utf8" }).trim();
    expect(branch).toBe("scout/quill");
  });

  test("new_worktree fails with a diagnostic instead of falling back to the project root", async () => {
    const root = makeNonGitDir();
    await expect(resolveSessionWorkspace({ projectRoot: root, agentName: "quill", workspace: "new_worktree" }))
      .rejects.toThrow(/workspace new_worktree: could not create a git worktree/);
  });
});
