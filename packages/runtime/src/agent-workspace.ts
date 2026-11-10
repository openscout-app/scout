// Agent workspace isolation.
//
// A dispatched agent runs in an isolated git worktree so its edits don't
// clobber the operator's working tree. This module owns the single shared
// implementation that used to be duplicated byte-for-byte inline in the desktop
// and web mobile services.
//
// The only strategy today is `git worktree add` — branch `scout/<agent>` under
// `<projectRoot>/.scout-worktrees/<agent>` — which is exactly the prior behavior
// (this is a pure de-duplication). A copy-on-write (APFS clonefile) strategy,
// workspace teardown, and merge-back were prototyped but deferred; see
// docs/eng/isolation-cow-vs-worktrees.md for the design and the review blockers
// that gate them.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execSystemFile } from "./system-probes/exec.js";

/** Directory (under the project root) that holds every Scout-created workspace. */
export const SCOUT_WORKSPACES_DIRNAME = ".scout-worktrees";

export interface CreateAgentWorkspaceResult {
  /** Absolute path the agent should run in (its cwdOverride). */
  path: string;
  /** Branch the worktree tracks (`scout/<agent>` unless one was requested). */
  branch: string;
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
): Promise<CreateAgentWorkspaceResult | null> {
  if (!(await isGitRepo(projectRoot))) {
    return null;
  }

  const branch = requestedBranch?.trim() || `scout/${agentName}`;
  validateWorktreeBranch(branch);
  const workspaceDir = join(projectRoot, SCOUT_WORKSPACES_DIRNAME);
  const workspacePath = join(workspaceDir, agentName);

  // Reuse an existing worktree rather than recreate it.
  if (existsSync(workspacePath)) {
    return { path: workspacePath, branch };
  }

  await mkdir(workspaceDir, { recursive: true });

  try {
    // Create the worktree on a new branch based on current HEAD.
    await execSystemFile("git", ["worktree", "add", "-b", branch, "--", workspacePath], { cwd: projectRoot, timeoutMs: 10_000 });
    return { path: workspacePath, branch };
  } catch {
    // Branch might already exist — retry attaching to it without -b.
    try {
      await execSystemFile("git", ["worktree", "add", workspacePath, "--", branch], { cwd: projectRoot, timeoutMs: 10_000 });
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
}

/**
 * Pick the working directory for a new session. `same` (or no choice) runs in
 * the project root. `new_worktree` runs in a git worktree, and fails with an
 * actionable error instead of falling back to the project root: a caller that
 * asked for isolation must not get a worker in the shared checkout.
 */
export async function resolveSessionWorkspace(input: {
  projectRoot: string;
  agentName: string;
  workspace?: "same" | "new_worktree";
  createWorkspace?: typeof createAgentWorkspace;
}): Promise<SessionWorkspace> {
  if (input.workspace !== "new_worktree") {
    return { cwd: input.projectRoot };
  }
  const created = await (input.createWorkspace ?? createAgentWorkspace)(input.projectRoot, input.agentName);
  if (!created) {
    throw new Error(
      `workspace new_worktree: could not create a git worktree for ${input.projectRoot}`
      + ` (branch scout/${input.agentName} under ${SCOUT_WORKSPACES_DIRNAME}/).`
      + " The folder must be a git repository with at least one commit."
      + " Ask without workspace new_worktree to run in the project folder.",
    );
  }
  return { cwd: created.path, branch: created.branch };
}
