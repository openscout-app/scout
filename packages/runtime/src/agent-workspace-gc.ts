import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import { SCOUT_WORKSPACES_DIRNAME } from "./agent-workspace.js";
import { ProbeCommandError, execSystemFile } from "./system-probes/exec.js";

export type ScoutWorktreeSkipReason = "locked" | "active" | "dirty" | "unmerged" | "git_error" | "changed";

export type ScoutWorktree = {
  path: string;
  name: string;
  branch: string | null;
  head: string;
  clean: boolean;
  merged: boolean;
  locked: boolean;
  activeSession: boolean;
  eligible: boolean;
  skipReason?: ScoutWorktreeSkipReason;
  error?: string;
};

export type ScoutWorktreeList = {
  projectRoot: string;
  baseRef: string;
  worktrees: ScoutWorktree[];
};

export type ScoutWorktreeListOptions = {
  baseRef?: string;
  /** Paths to protect, including sessions working in subdirectories of a worktree. */
  activePaths?: ReadonlySet<string>;
};

export type ScoutWorktreeGcOptions = ScoutWorktreeListOptions & { dryRun?: boolean };

export type ScoutWorktreeGcEntry = ScoutWorktree & {
  action: "would_remove" | "removed" | "skipped" | "failed";
  branchDeleted?: boolean;
};

export type ScoutWorktreeGcReport = Omit<ScoutWorktreeList, "worktrees"> & {
  dryRun: boolean;
  worktrees: ScoutWorktreeGcEntry[];
  warnings: string[];
};

function git(cwd: string, args: readonly string[]) {
  // A caller such as a Git hook can inherit GIT_DIR or GIT_INDEX_FILE.
  // Always inspect and change the repository at cwd, not the inherited one.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return execSystemFile("git", ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", ...args], {
    cwd, env: { ...env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 30_000,
  });
}

function gitError(error: unknown): string {
  if (error instanceof ProbeCommandError && error.stderr?.trim()) return error.stderr.trim();
  return error instanceof Error ? error.message : String(error);
}

function validateBaseRef(ref: string | undefined): void {
  if (ref !== undefined && (!ref.trim() || ref.startsWith("-") || ref.includes("\0"))) {
    throw new Error("Worktree base ref must be non-empty, contain no NUL, and not start with '-'.");
  }
}

async function resolveBase(cwd: string, requestedRef?: string) {
  const refs = requestedRef !== undefined ? [requestedRef] : ["refs/remotes/origin/main", "refs/heads/main", "HEAD"];
  for (const ref of refs) {
    try {
      const { stdout } = await git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
      return { ref, commit: stdout.trim() };
    } catch (error) {
      if (!(error instanceof ProbeCommandError && error.exitCode === 1)) throw error;
    }
  }
  throw new Error(requestedRef !== undefined
    ? `Worktree base ref ${JSON.stringify(requestedRef)} does not resolve to a commit.`
    : "No origin/main, main, or HEAD commit was found. Specify a base with --base.");
}

type Entry = Pick<ScoutWorktree, "path" | "head" | "branch" | "locked"> & { prunable: boolean };

async function registeredWorktrees(cwd: string): Promise<Entry[]> {
  const { stdout } = await git(cwd, ["worktree", "list", "--porcelain", "-z"]);
  // Git puts the main checkout (or bare repository) first. Do not consider
  // it, even if a linked checkout is passed as the project root.
  return stdout.split("\0\0").slice(1).flatMap(record => {
    const fields = record.split("\0");
    const path = fields.find(field => field.startsWith("worktree "))?.slice("worktree ".length);
    const head = fields.find(field => field.startsWith("HEAD "))?.slice("HEAD ".length);
    if (!path || !head || !isAbsolute(path)) return [];
    const branch = fields.find(field => field.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length) ?? null;
    return [{
      path: normalize(path), head, branch,
      locked: fields.some(field => field === "locked" || field.startsWith("locked ")),
      prunable: fields.some(field => field === "prunable" || field.startsWith("prunable ")),
    }];
  });
}

async function realpathOrNull(path: string): Promise<string | null> {
  try { return await realpath(path); } catch { return null; }
}

async function isScoutPath(workspaceDir: string, path: string): Promise<boolean> {
  if (dirname(path) !== workspaceDir) return false;
  // Neither the workspace directory nor a registered child may redirect
  // through a symlink. Check both again before a destructive Git call.
  try {
    return (await lstat(workspaceDir)).isDirectory()
      && (await lstat(path)).isDirectory()
      && await realpath(path) === path;
  } catch {
    return false;
  }
}

async function canonicalActivePaths(paths: ReadonlySet<string> | undefined): Promise<Set<string>> {
  const result = new Set<string>();
  for (const path of paths ?? []) {
    const absolute = resolve(path);
    result.add(absolute);
    const canonical = await realpathOrNull(absolute);
    if (canonical) result.add(canonical);
  }
  return result;
}

function containsPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function inspect(entry: Entry, cwd: string, baseCommit: string, activePaths: ReadonlySet<string>): Promise<ScoutWorktree> {
  const { path, branch, head, locked } = entry;
  const activeSession = [...activePaths].some(activePath => containsPath(path, activePath));
  let clean = false;
  let merged = false;
  let error: string | undefined;
  try {
    // A linked worktree has a .git file. A directory reused for a separate
    // clone or missing its pointer is not the registered worktree.
    if (!(await lstat(join(path, ".git"))).isFile()) {
      throw new Error("The registered worktree no longer has a .git file.");
    }
    const { stdout } = await git(path, ["rev-parse", "--show-toplevel"]);
    if (await realpathOrNull(stdout.replace(/\r?\n$/, "")) !== path) {
      throw new Error("Git does not recognize this directory as a worktree root.");
    }
    // Disable optional index writes and override status config that can hide
    // untracked files or changed submodules.
    const status = await git(path, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]);
    clean = status.stdout === "";
  } catch (cause) {
    error = gitError(cause);
  }
  try {
    await git(cwd, ["merge-base", "--is-ancestor", head, baseCommit]);
    merged = true;
  } catch (cause) {
    if (!(cause instanceof ProbeCommandError && cause.exitCode === 1)) error ??= gitError(cause);
  }
  const skipReason = locked ? "locked" : activeSession ? "active" : error ? "git_error"
    : !clean ? "dirty" : !merged ? "unmerged" : undefined;
  return {
    path, name: basename(path), branch, head, clean, merged, locked, activeSession,
    eligible: skipReason === undefined, ...(skipReason && { skipReason }), ...(error && { error }),
  };
}

export async function listScoutWorktrees(projectRoot: string, options: ScoutWorktreeListOptions = {}): Promise<ScoutWorktreeList> {
  validateBaseRef(options.baseRef);
  const cwd = await realpath(projectRoot);
  const base = await resolveBase(cwd, options.baseRef);
  const activePaths = await canonicalActivePaths(options.activePaths);
  const workspaceDir = join(cwd, SCOUT_WORKSPACES_DIRNAME);
  const worktrees: ScoutWorktree[] = [];
  for (const entry of await registeredWorktrees(cwd)) {
    if (!entry.prunable && await isScoutPath(workspaceDir, entry.path)) {
      worktrees.push(await inspect(entry, cwd, base.commit, activePaths));
    }
  }
  return { projectRoot: cwd, baseRef: base.ref, worktrees };
}

async function deleteScoutBranch(
  cwd: string,
  baseRef: string,
  entry: ScoutWorktree,
  warnings: string[],
): Promise<boolean> {
  const { branch, head } = entry;
  // Non-Scout branches can outlive the worktree on purpose. Git's -d checks
  // both checkout ownership and merge status, but uses its own upstream/HEAD.
  if (!branch?.startsWith("scout/")) return false;
  const branchRef = `refs/heads/${branch}`;
  try {
    const base = await git(cwd, ["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", baseRef]);
    if (base.stdout.trim() === branchRef) return false;
    const tip = await git(cwd, ["rev-parse", "--verify", "--end-of-options", branchRef]);
    if (tip.stdout.trim() !== head) {
      warnings.push(`Kept branch ${branch}: its tip changed during GC.`);
      return false;
    }
    await git(cwd, ["branch", "-d", "--", branch]);
    return true;
  } catch (error) {
    warnings.push(`Kept branch ${branch}: ${gitError(error)}`);
    return false;
  }
}

async function pruneWorktreeMetadata(cwd: string, warnings: string[]): Promise<void> {
  // Non-forced removal already deletes its own entry. Git prune is repo-wide;
  // do not remove any other registration (including a temporarily absent disk).
  try {
    const args = ["worktree", "prune", "--expire=never"];
    const preview = await git(cwd, [...args, "--dry-run", "--verbose"]);
    if (preview.stdout.trim() || preview.stderr.trim()) {
      warnings.push("Skipped git worktree prune: it would prune other worktree registrations.");
      return;
    }
    await git(cwd, args);
  } catch (error) {
    warnings.push(`Git worktree prune failed: ${gitError(error)}`);
  }
}

export async function gcScoutWorktrees(projectRoot: string, options: ScoutWorktreeGcOptions = {}): Promise<ScoutWorktreeGcReport> {
  const { projectRoot: cwd, baseRef, worktrees } = await listScoutWorktrees(projectRoot, options);
  const dryRun = options.dryRun ?? false;
  const report: ScoutWorktreeGcReport = { projectRoot: cwd, baseRef, dryRun, worktrees: [], warnings: [] };
  const workspaceDir = join(cwd, SCOUT_WORKSPACES_DIRNAME);
  for (const worktree of worktrees) {
    if (!worktree.eligible || dryRun) {
      report.worktrees.push({ ...worktree, action: worktree.eligible ? "would_remove" : "skipped" });
      continue;
    }
    try {
      const current = (await registeredWorktrees(cwd)).find(entry => entry.path === worktree.path);
      if (!current || current.prunable || current.head !== worktree.head || current.branch !== worktree.branch
        || !await isScoutPath(workspaceDir, worktree.path)) {
        report.worktrees.push({ ...worktree, eligible: false, skipReason: "changed", action: "skipped" });
        continue;
      }
      const base = await resolveBase(cwd, baseRef);
      const activePaths = await canonicalActivePaths(options.activePaths);
      const checked = await inspect(current, cwd, base.commit, activePaths);
      if (!checked.eligible) {
        report.worktrees.push({ ...checked, action: "skipped" });
        continue;
      }
      if (!await isScoutPath(workspaceDir, checked.path)) {
        report.worktrees.push({ ...checked, eligible: false, skipReason: "changed", action: "skipped" });
        continue;
      }
      await git(cwd, ["worktree", "remove", "--", checked.path]);
      const branchDeleted = await deleteScoutBranch(cwd, baseRef, checked, report.warnings);
      report.worktrees.push({ ...checked, action: "removed", branchDeleted });
    } catch (error) {
      report.worktrees.push({ ...worktree, action: "failed", error: gitError(error) });
    }
  }
  if (report.worktrees.some(worktree => worktree.action === "removed")) await pruneWorktreeMetadata(cwd, report.warnings);
  return report;
}
