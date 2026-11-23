/**
 * The reviewed artifact of a Board review run: the commit checked out in the
 * routine's project on this host.
 *
 * The runtime reads it itself, so a preview and a run agree on what "the
 * project's HEAD" was. It reads the commit and nothing else: uncommitted
 * changes in the work tree are not part of the artifact.
 */
import { realpath, stat } from "node:fs/promises";

import { execSystemFile } from "./system-probes/exec.js";

export class ManualReviewProjectError extends Error {
  constructor(
    readonly code: "project_not_found" | "project_not_git" | "project_head_unreadable",
    message: string,
  ) {
    super(message);
    this.name = "ManualReviewProjectError";
  }
}

export type ManualReviewProjectReader = {
  /** The canonical path of a project that is a directory inside a Git work tree. */
  canonical(projectPath: string): Promise<string>;
  /** The commit checked out at a canonical project path. */
  head(canonicalPath: string): Promise<string>;
};

const GIT_TIMEOUT_MS = 5_000;
/** A commit ID and a newline fit many times over. Anything longer is not an answer. */
const GIT_OUTPUT_MAX_BYTES = 4096;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Git reads its repository from the path it is given. Variables such as
 * GIT_DIR in the runtime's own environment must not point it elsewhere.
 */
function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  return { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
}

/**
 * One bounded, read-only Git call. The path is an absolute canonical path, so
 * it cannot be read as an option, and every other argument is fixed here. No
 * shell is involved.
 */
async function git(canonicalPath: string, args: readonly string[]): Promise<string> {
  const result = await execSystemFile("git", ["-C", canonicalPath, ...args], {
    timeoutMs: GIT_TIMEOUT_MS,
    maxStdoutBytes: GIT_OUTPUT_MAX_BYTES,
    maxStderrBytes: GIT_OUTPUT_MAX_BYTES,
    env: gitEnvironment(),
    probeId: "manual-review.git",
  });
  return result.stdout.trim();
}

export async function canonicalManualReviewProject(projectPath: string): Promise<string> {
  if (typeof projectPath !== "string" || !projectPath.startsWith("/") || projectPath.includes("\0")) {
    throw new ManualReviewProjectError("project_not_found", "The project path must be an absolute path.");
  }
  let canonical: string;
  try {
    canonical = await realpath(projectPath);
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new ManualReviewProjectError("project_not_found", `The project ${projectPath} does not exist on this host, or is not a directory.`);
  }
  let inside: string;
  try {
    inside = await git(canonical, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    inside = "";
  }
  if (inside !== "true") {
    throw new ManualReviewProjectError("project_not_git", `The project ${canonical} is not inside a Git work tree.`);
  }
  return canonical;
}

export async function readManualReviewProjectHead(canonicalPath: string): Promise<string> {
  let commit: string;
  try {
    commit = await git(canonicalPath, ["rev-parse", "--verify", "HEAD^{commit}"]);
  } catch {
    commit = "";
  }
  if (!COMMIT.test(commit)) {
    throw new ManualReviewProjectError("project_head_unreadable", `Git could not name the commit checked out in ${canonicalPath}.`);
  }
  return commit;
}

export const manualReviewProjectReader: ManualReviewProjectReader = {
  canonical: canonicalManualReviewProject,
  head: readManualReviewProjectHead,
};
