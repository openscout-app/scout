// Agent workspace isolation.
//
// A dispatched agent runs in an isolated git worktree so its edits don't
// clobber the operator's working tree. This module owns the single shared
// implementation that used to be duplicated byte-for-byte inline in the desktop
// and web mobile services.
//
// The only strategy today is `git worktree add`: branch `scout/<agent>` under
// `<projectRoot>/.scout-worktrees/<agent>`. A copy-on-write (APFS clonefile) strategy,
// workspace teardown, and merge-back were prototyped but deferred; see
// docs/eng/isolation-cow-vs-worktrees.md for the design and the review blockers
// that gate them.

import { existsSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execSystemFile } from "./system-probes/exec.js";

/** Directory (under the project root) that holds every Scout-created workspace. */
export const SCOUT_WORKSPACES_DIRNAME = ".scout-worktrees";

export interface CreateAgentWorkspaceResult {
  /** Absolute path the agent should run in (its cwdOverride). */
  path: string;
  /** Branch the worktree tracks (`scout/<agent>` unless one was requested). */
  branch: string;
  /** Start commit of a newly created branch. Omitted when reusing a branch or worktree. */
  baseRef?: string;
}

export interface AgentWorkspaceBaseOptions {
  /** Git ref or commit to use instead of the repository's default. */
  baseRef?: string;
  /** Refresh a remote-tracking base before use. Defaults to true. */
  fetchBase?: boolean;
}

/**
 * In-process handshake with the retirement sweep. A workspace handed to a
 * session counts as activity, so the sweep will not retire it in the window
 * before that session's endpoint is recorded. A workspace that the sweep is
 * retiring is not handed out until the retirement settles.
 */
const workspaceClaimedAt = new Map<string, number>();
const workspaceRetirements = new Map<string, Promise<unknown>>();

export function agentWorkspaceKey(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** When this process last handed the workspace at `path` to a session. */
export function agentWorkspaceClaimedAt(path: string): number | undefined {
  return workspaceClaimedAt.get(agentWorkspaceKey(path));
}

/** Hold new sessions off `path` until `retirement` settles. */
export async function withAgentWorkspaceRetirement<T>(path: string, retirement: () => Promise<T>): Promise<T> {
  const key = agentWorkspaceKey(path);
  const pending = retirement();
  workspaceRetirements.set(key, pending);
  try {
    return await pending;
  } finally {
    if (workspaceRetirements.get(key) === pending) workspaceRetirements.delete(key);
  }
}

function claimAgentWorkspace(path: string): void {
  workspaceClaimedAt.set(agentWorkspaceKey(path), Date.now());
}

async function isGitRepo(projectRoot: string): Promise<boolean> {
  try {
    await execSystemFile("git", ["rev-parse", "--git-dir"], { cwd: projectRoot, timeoutMs: 2_000 });
    return true;
  } catch {
    return false;
  }
}

function validateWorktreeBranch(branch: string): void {
  if (!branch || branch.includes("\0") || branch.startsWith("-")) {
    throw new Error("git worktree branch must be non-empty and must not start with '-'");
  }
}

function validBaseRef(ref: string): boolean {
  return !!ref && !ref.includes("\0") && !ref.startsWith("-");
}

async function gitOutput(projectRoot: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execSystemFile("git", args, { cwd: projectRoot, timeoutMs: 2_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function resolveCommit(projectRoot: string, ref: string): Promise<string | undefined> {
  return gitOutput(projectRoot, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
}

const REMOTE_REFS = "refs/remotes/";
type RemoteBase = { ref: string; remote: string; source: string };

async function remoteBaseForRef(projectRoot: string, ref: string): Promise<RemoteBase | undefined> {
  // Resolve symbolic refs such as origin/HEAD and keep Git's precedence over
  // similarly named local branches or tags.
  const fullRef = await gitOutput(projectRoot, ["rev-parse", "--symbolic-full-name", "--verify", "--quiet", "--end-of-options", ref]);
  if (!fullRef?.startsWith(REMOTE_REFS)) return undefined;

  const path = fullRef.slice(REMOTE_REFS.length);
  const remotes = (await gitOutput(projectRoot, ["remote"]))?.split("\n") ?? [];
  // A remote name can itself contain a slash. Use the longest matching name.
  const remote = remotes.sort((a, b) => b.length - a.length).find((name) => path.startsWith(`${name}/`));
  if (!remote) return undefined;
  return { ref: fullRef, remote, source: `refs/heads/${path.slice(remote.length + 1)}` };
}

async function refreshRemoteBase(projectRoot: string, base: RemoteBase): Promise<boolean> {
  // A fetch updates only the selected remote-tracking ref, never a local
  // branch. Don't follow an unusual symbolic tracking ref into refs/heads/.
  const destination = await gitOutput(projectRoot, ["symbolic-ref", "--quiet", "--", base.ref]) ?? base.ref;
  if (!destination.startsWith(REMOTE_REFS)) return false;
  try {
    await execSystemFile("git", [
      "fetch", "--no-tags", "--no-prune", "--no-recurse-submodules",
      "--no-write-fetch-head", "--no-auto-gc", "--refmap=", "--",
      base.remote, `+${base.source}:${destination}`,
    ], { cwd: projectRoot, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 2_000 });
    return true;
  } catch {
    return false;
  }
}

async function resolveWorktreeBase(
  projectRoot: string,
  explicitRef: string | undefined,
  fetchBase: boolean,
): Promise<string | undefined> {
  const preferred = explicitRef ?? await gitOutput(projectRoot, ["config", "--get", "scout.worktreeBase"]);
  if (preferred && validBaseRef(preferred)) {
    if (fetchBase) {
      const remoteBase = await remoteBaseForRef(projectRoot, preferred);
      if (remoteBase) await refreshRemoteBase(projectRoot, remoteBase);
    }
    const commit = await resolveCommit(projectRoot, preferred);
    if (commit) return commit;
  }
  if (explicitRef !== undefined) {
    throw new Error(`git worktree baseRef ${JSON.stringify(explicitRef)} does not resolve to a commit. Fetch the ref or choose an existing commit.`);
  }

  const head = await resolveCommit(projectRoot, "HEAD");
  if (!head) return undefined;
  const branch = await gitOutput(projectRoot, ["symbolic-ref", "--quiet", "HEAD"]);
  if (!branch?.startsWith("refs/heads/")) return head;

  // Read both ends of the branch's upstream mapping rather than assuming
  // the remote branch has the same name as the local branch.
  const upstream = await gitOutput(projectRoot, [
    "for-each-ref", "--format=%(upstream)%09%(upstream:remotename)%09%(upstream:remoteref)", "--", branch,
  ]);
  const [ref, remote, source] = upstream?.split("\t") ?? [];
  const base = ref?.startsWith(REMOTE_REFS) && remote && remote !== "." && source
    ? { ref, remote, source }
    : await remoteBaseForRef(projectRoot, "refs/remotes/origin/main")
      ?? await remoteBaseForRef(projectRoot, "refs/remotes/origin/HEAD");
  if (!base || (fetchBase && !(await refreshRemoteBase(projectRoot, base)))) return head;

  const remoteCommit = await resolveCommit(projectRoot, base.ref);
  if (!remoteCommit || remoteCommit === head) return head;
  try {
    await execSystemFile("git", ["merge-base", "--is-ancestor", head, remoteCommit], { cwd: projectRoot, timeoutMs: 2_000 });
    return remoteCommit;
  } catch {
    return head;
  }
}

/**
 * Materialize an isolated git worktree for `agentName` under
 * `<projectRoot>/.scout-worktrees/<agentName>`, on branch `scout/<agentName>`
 * (or `requestedBranch` when given). An existing worktree at that path is
 * reused as-is.
 *
 * Returns the workspace descriptor, or `null` when the project isn't a git repo
 * (or both `git worktree add` attempts fail) — callers then run the agent in the
 * project root, exactly as before.
 */
export async function createAgentWorkspace(
  projectRoot: string,
  agentName: string,
  requestedBranch?: string,
  options: AgentWorkspaceBaseOptions = {},
): Promise<CreateAgentWorkspaceResult | null> {
  const explicitRef = options.baseRef?.trim();
  if (explicitRef !== undefined && !validBaseRef(explicitRef)) {
    throw new Error("git worktree baseRef must be non-empty, must not contain a NUL byte, and must not start with '-'");
  }
  if (!(await isGitRepo(projectRoot))) {
    return null;
  }

  const branch = requestedBranch?.trim() || `scout/${agentName}`;
  validateWorktreeBranch(branch);
  const workspaceDir = join(projectRoot, SCOUT_WORKSPACES_DIRNAME);
  const workspacePath = join(workspaceDir, agentName);

  // A retirement in flight decides whether the path still exists.
  await workspaceRetirements.get(agentWorkspaceKey(workspacePath))?.catch(() => undefined);

  // Reuse an existing worktree rather than recreate it.
  if (existsSync(workspacePath)) {
    claimAgentWorkspace(workspacePath);
    return { path: workspacePath, branch };
  }

  const baseRef = await resolveWorktreeBase(projectRoot, explicitRef, options.fetchBase ?? true);
  await mkdir(workspaceDir, { recursive: true });

  try {
    // Use the resolved commit so a concurrent fetch cannot change the start point.
    await execSystemFile("git", ["worktree", "add", "-b", branch, "--", workspacePath, ...(baseRef ? [baseRef] : [])], { cwd: projectRoot, timeoutMs: 10_000 });
    claimAgentWorkspace(workspacePath);
    return { path: workspacePath, branch, ...(baseRef ? { baseRef } : {}) };
  } catch {
    // Branch might already exist — retry attaching to it without -b.
    if (explicitRef !== undefined && await resolveCommit(projectRoot, `refs/heads/${branch}`) !== baseRef) {
      throw new Error(`git worktree could not create branch ${JSON.stringify(branch)} at baseRef ${JSON.stringify(explicitRef)}. Choose a new branch or check git worktree list.`);
    }
    try {
      await execSystemFile("git", ["worktree", "add", workspacePath, "--", branch], { cwd: projectRoot, timeoutMs: 10_000 });
      claimAgentWorkspace(workspacePath);
      return { path: workspacePath, branch };
    } catch {
      // If both fail, fall back to no worktree.
      return null;
    }
  }
}

export interface SessionWorkspace {
  /** Directory the session runs in. */
  cwd: string;
  /** Branch of the worktree, when the session runs in one. */
  branch?: string;
  /** Start commit of a newly created branch. */
  baseRef?: string;
}

/**
 * Pick the working directory for a new session. `same` (or no choice) runs in
 * the project root. `new_worktree` runs in a git worktree, and fails with an
 * actionable error instead of falling back to the project root: a caller that
 * asked for isolation must not get a worker in the shared checkout.
 */
export async function resolveSessionWorkspace(input: AgentWorkspaceBaseOptions & {
  projectRoot: string;
  agentName: string;
  workspace?: "same" | "new_worktree";
  createWorkspace?: typeof createAgentWorkspace;
}): Promise<SessionWorkspace> {
  if (input.workspace !== "new_worktree") {
    return { cwd: input.projectRoot };
  }
  const created = await (input.createWorkspace ?? createAgentWorkspace)(input.projectRoot, input.agentName, undefined, {
    baseRef: input.baseRef,
    fetchBase: input.fetchBase,
  });
  if (!created) {
    throw new Error(
      `workspace new_worktree: could not create a git worktree for ${input.projectRoot}`
      + ` (branch scout/${input.agentName} under ${SCOUT_WORKSPACES_DIRNAME}/).`
      + " The folder must be a git repository with at least one commit."
      + " Ask without workspace new_worktree to run in the project folder.",
    );
  }
  return { cwd: created.path, branch: created.branch, ...(created.baseRef ? { baseRef: created.baseRef } : {}) };
}
