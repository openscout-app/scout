// Retire dispatched-agent worktrees that are idle, clean and merged.
//
// `createAgentWorkspace` adds a git worktree for every `new_worktree` session
// (`<projectRoot>/.scout-worktrees/<agent>` on branch `scout/<agent>`) and
// nothing removed them. This sweep removes one only when nothing can be lost:
//
// - Scout made it: a registered worktree that is a direct child of
//   `<projectRoot>/.scout-worktrees/` (by realpath and `path.relative`, never a
//   string prefix) and has `scout/<dirname>` checked out.
// - Idle: no endpoint whose cwd is the worktree is alive, owes a flight or a
//   collaboration record, or is a registered agent that could be woken there;
//   and the newest activity (session records, then git's own HEAD, reflog and
//   index times) is older than the idle threshold.
// - Clean: `git status --porcelain --untracked-files=all` is empty. Ignored
//   files do not count; `git worktree remove` deletes them with the tree.
// - Merged: the branch tip is an ancestor of the default branch, local or
//   `origin/`. Squash merges are not detected, so those worktrees are kept.
//
// Removal is `git worktree remove` (never `--force`), then `git branch -d`
// (never `-D`), then `git worktree prune` only when it would prune nothing but
// the entries this sweep removed. See docs/eng/isolation-cow-vs-worktrees.md
// for the teardown blockers this narrow routine is built around.

import type { AgentEndpoint } from "@openscout/protocol";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  agentWorkspaceClaimedAt,
  SCOUT_WORKSPACES_DIRNAME,
  withAgentWorkspaceRetirement,
} from "./agent-workspace.js";
import {
  activeCollaborationForAgent,
  activeFlightForAgent,
  lastSessionActivity,
} from "./broker-cardless-session-reaper.js";
import { isCardlessSessionEndpoint } from "./broker-cardless-session.js";
import { isStaleLocalEndpoint } from "./broker-endpoint-selection.js";
import type { RuntimeRegistrySnapshot } from "./registry.js";
import { execSystemFile } from "./system-probes/exec.js";
import { loadUserConfig, type OpenScoutUserConfig } from "./user-config.js";

export const DEFAULT_WORKTREE_RETIRE_IDLE_HOURS = 24;
export const MIN_WORKTREE_RETIRE_IDLE_HOURS = 1;
export const SCOUT_WORKTREE_BRANCH_PREFIX = "scout/";

export type WorktreeRetirementSettings = {
  /** The periodic sweep runs. A sweep run by hand runs either way. */
  enabled: boolean;
  idleHours: number;
};

export function resolveWorktreeRetirementSettings(
  config: OpenScoutUserConfig = loadUserConfig(),
): WorktreeRetirementSettings {
  const hours = Number(config.worktreeRetireIdleHours);
  return {
    enabled: config.worktreeRetire !== "off",
    idleHours: Number.isFinite(hours) && hours > 0
      ? Math.max(MIN_WORKTREE_RETIRE_IDLE_HOURS, hours)
      : DEFAULT_WORKTREE_RETIRE_IDLE_HOURS,
  };
}

export type WorktreeVerdictAction = "retired" | "would_retire" | "kept" | "skipped";

export type WorktreeVerdict = {
  path: string;
  projectRoot: string;
  branch: string | null;
  /** `skipped`: not a worktree Scout made; nothing about it was checked or changed. */
  action: WorktreeVerdictAction;
  /** Why it was kept or skipped, or what happened while retiring it. */
  reasons: string[];
  lastActivityAt?: number;
  /** `du -sk` before removal. Approximate: APFS clones and shared blocks make it high. */
  approxBytes?: number;
  branchDeleted?: boolean;
  /** Endpoints stamped stopped so nothing relaunches into the removed folder. */
  retiredEndpointIds?: string[];
};

export type WorktreeRetirementReport = {
  trigger: "periodic" | "manual";
  dryRun: boolean;
  startedAt: number;
  finishedAt: number;
  settings: WorktreeRetirementSettings;
  projectRoots: string[];
  worktrees: WorktreeVerdict[];
  retired: number;
  kept: number;
  /** Sum of `approxBytes` for retired (or, in a dry run, retirable) worktrees. */
  approxBytesReclaimed: number;
  errors: string[];
};

export type WorktreeUsage = {
  /** Why the worktree is in use; empty when nothing holds it. */
  holds: string[];
  /** Newest session-record activity for the worktree, 0 when none is known. */
  lastActivityAt: number;
  /** Dead, routable cardless endpoints whose cwd is the worktree. Retiring the worktree stops them. */
  releasable: AgentEndpoint[];
  referencedBy: string[];
};

type GitResult = { stdout: string; stderr: string };
export type WorktreeGit = (args: readonly string[], options: { cwd: string; timeoutMs?: number }) => Promise<GitResult>;

const defaultGit: WorktreeGit = (args, options) =>
  execSystemFile("git", args, { cwd: options.cwd, timeoutMs: options.timeoutMs ?? 15_000 });

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function endpointPaths(endpoint: AgentEndpoint): string[] {
  const values = [endpoint.cwd, endpoint.projectRoot, endpoint.metadata?.cwd, endpoint.metadata?.projectRoot];
  return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => resolve(value));
}

/** Endpoints on this node whose working directory is `worktreePath` or inside it. */
function endpointsInWorktree(snapshot: RuntimeRegistrySnapshot, nodeId: string, worktreePath: string): AgentEndpoint[] {
  const real = realpathOrNull(worktreePath) ?? resolve(worktreePath);
  const name = basename(real);
  return Object.values(snapshot.endpoints).filter((endpoint) =>
    endpoint.nodeId === nodeId
    && endpointPaths(endpoint).some((path) =>
      // Only paths that name the worktree folder can be inside it; skip the realpath call for the rest.
      path.includes(name) && (isInside(resolve(worktreePath), path) || isInside(real, realpathOrNull(path) ?? path))));
}

/**
 * How the runtime's records use one worktree. A registered agent (one with a
 * card or relay registration) keeps its worktree until its endpoint is retired:
 * it can be woken again in that folder. A cardless session that is not alive
 * and owes nothing can be released; the sweep stops its endpoint before it
 * removes the folder.
 */
export async function scoutWorktreeUsage(
  snapshot: RuntimeRegistrySnapshot,
  worktreePath: string,
  input: { nodeId: string; isEndpointAlive: (endpoint: AgentEndpoint) => boolean | Promise<boolean> },
): Promise<WorktreeUsage> {
  const usage: WorktreeUsage = { holds: [], lastActivityAt: 0, releasable: [], referencedBy: [] };
  for (const endpoint of endpointsInWorktree(snapshot, input.nodeId, worktreePath)) {
    usage.referencedBy.push(endpoint.id);
    const retiredAt = Number(endpoint.metadata?.retiredAt);
    usage.lastActivityAt = Math.max(
      usage.lastActivityAt,
      lastSessionActivity(snapshot, endpoint),
      Number.isFinite(retiredAt) ? retiredAt : 0,
    );
    if (Object.values(snapshot.flights).some((flight) => activeFlightForAgent(flight, endpoint.agentId))) {
      usage.holds.push(`flight in progress for ${endpoint.agentId}`);
      continue;
    }
    if (Object.values(snapshot.collaborationRecords).some((record) => activeCollaborationForAgent(record, endpoint.agentId))) {
      usage.holds.push(`open work item for ${endpoint.agentId}`);
      continue;
    }
    if (isStaleLocalEndpoint(snapshot, endpoint)) continue;
    if (await input.isEndpointAlive(endpoint)) {
      usage.holds.push(`live session ${endpoint.agentId} (${endpoint.state})`);
      continue;
    }
    if (!isCardlessSessionEndpoint(endpoint)) {
      usage.holds.push(`registered agent ${endpoint.agentId} runs here and can be woken`);
      continue;
    }
    usage.releasable.push(endpoint);
  }
  return usage;
}

/** Project roots on this node that the runtime's records tie to a `.scout-worktrees` folder. */
export function scoutWorktreeProjectRoots(snapshot: RuntimeRegistrySnapshot, nodeId: string): string[] {
  const marker = `${sep}${SCOUT_WORKSPACES_DIRNAME}${sep}`;
  const roots = new Set<string>();
  for (const endpoint of Object.values(snapshot.endpoints)) {
    if (endpoint.nodeId !== nodeId) continue;
    for (const path of endpointPaths(endpoint)) {
      const index = `${path}${sep}`.indexOf(marker);
      roots.add(index >= 0 ? path.slice(0, index) : path);
    }
  }
  const real = new Set<string>();
  for (const root of roots) {
    const resolved = realpathOrNull(root);
    if (!resolved) continue;
    try {
      if (statSync(join(resolved, SCOUT_WORKSPACES_DIRNAME)).isDirectory()) real.add(resolved);
    } catch {
      // No workspace folder: nothing to sweep there.
    }
  }
  return [...real].sort();
}

type WorktreeEntry = { path: string; branch: string | null; locked: boolean; prunable: boolean };

function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length), branch: null, locked: false, prunable: false };
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (current && (line === "locked" || line.startsWith("locked "))) {
      current.locked = true;
    } else if (current && (line === "prunable" || line.startsWith("prunable "))) {
      current.prunable = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

export type ScoutWorktreeCandidate = {
  path: string;
  projectRoot: string;
  /** Short branch name, `scout/<dirname>`. */
  branch: string;
  locked: boolean;
};

/**
 * The worktrees of `projectRoot` that live under its `.scout-worktrees/`. Each
 * is either a candidate (Scout made it) or skipped with the reason. Worktrees
 * anywhere else are not returned at all.
 */
export async function listScoutWorktrees(
  projectRoot: string,
  git: WorktreeGit = defaultGit,
): Promise<{ candidates: ScoutWorktreeCandidate[]; skipped: WorktreeVerdict[] }> {
  const root = realpathOrNull(projectRoot);
  const workspaceDir = root ? realpathOrNull(join(root, SCOUT_WORKSPACES_DIRNAME)) : null;
  if (!root || !workspaceDir) return { candidates: [], skipped: [] };
  const { stdout } = await git(["worktree", "list", "--porcelain"], { cwd: root });
  const candidates: ScoutWorktreeCandidate[] = [];
  const skipped: WorktreeVerdict[] = [];
  for (const entry of parseWorktreeList(stdout)) {
    if (entry.prunable) continue;
    const real = realpathOrNull(entry.path);
    if (!real) continue;
    const rel = relative(workspaceDir, real);
    // A direct child of the workspace folder, never the folder itself or a path that climbs out.
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.includes(sep)) continue;
    const skip = (reason: string): void => {
      skipped.push({ path: real, projectRoot: root, branch: entry.branch?.replace(/^refs\/heads\//, "") ?? null, action: "skipped", reasons: [reason] });
    };
    let symlink = false;
    try {
      symlink = lstatSync(join(workspaceDir, rel)).isSymbolicLink();
    } catch {
      symlink = true;
    }
    if (symlink) { skip("the folder is a symbolic link, not a worktree Scout made"); continue; }
    const expected = `refs/heads/${SCOUT_WORKTREE_BRANCH_PREFIX}${basename(real)}`;
    if (entry.branch !== expected) {
      skip(entry.branch
        ? `branch ${entry.branch.replace(/^refs\/heads\//, "")} is not ${expected.slice("refs/heads/".length)}, so Scout did not make it`
        : "detached HEAD, so Scout did not make it");
      continue;
    }
    candidates.push({ path: real, projectRoot: root, branch: expected.slice("refs/heads/".length), locked: entry.locked });
  }
  return { candidates, skipped };
}

async function gitSucceeds(git: WorktreeGit, args: readonly string[], cwd: string): Promise<boolean> {
  try {
    await git(args, { cwd });
    return true;
  } catch {
    return false;
  }
}

/** The default branch, local and on `origin`, as full refs that exist. */
export async function defaultBranchRefs(projectRoot: string, git: WorktreeGit = defaultGit): Promise<string[]> {
  let names = ["main", "master"];
  try {
    const { stdout } = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { cwd: projectRoot });
    const name = stdout.trim().replace(/^refs\/remotes\/origin\//, "");
    if (name && !name.startsWith("refs/")) names = [name];
  } catch {
    // No origin/HEAD: fall back to the usual names.
  }
  const refs: string[] = [];
  for (const name of names) {
    for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`]) {
      if (await gitSucceeds(git, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], projectRoot)) refs.push(ref);
    }
  }
  return refs;
}

function fileMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Git's own activity evidence for a worktree: last commit, reflog and index writes. Read before any status call. */
async function gitActivityAt(worktree: string, git: WorktreeGit): Promise<number> {
  let latest = 0;
  try {
    const { stdout } = await git(["log", "-1", "--format=%ct", "HEAD"], { cwd: worktree });
    const seconds = Number(stdout.trim());
    if (Number.isFinite(seconds)) latest = Math.max(latest, seconds * 1_000);
  } catch {
    // An unborn HEAD has no commit time.
  }
  try {
    const { stdout } = await git(["rev-parse", "--absolute-git-dir"], { cwd: worktree });
    const gitDir = stdout.trim();
    if (gitDir) latest = Math.max(latest, fileMtime(join(gitDir, "index")), fileMtime(join(gitDir, "logs", "HEAD")), fileMtime(join(gitDir, "HEAD")));
  } catch {
    // Without a git dir there is no further evidence.
  }
  return latest;
}

async function approxDiskBytes(path: string): Promise<number | undefined> {
  try {
    const { stdout } = await execSystemFile("du", ["-sk", path], { timeoutMs: 120_000 });
    const kib = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isFinite(kib) ? kib * 1024 : undefined;
  } catch {
    return undefined;
  }
}

function errorText(error: unknown): string {
  const stderr = (error as { stderr?: unknown })?.stderr;
  const text = typeof stderr === "string" && stderr.trim() ? stderr.trim() : error instanceof Error ? error.message : String(error);
  return text.split("\n")[0]!.slice(0, 300);
}

export type WorktreeSweepInput = {
  projectRoots: readonly string[];
  dryRun: boolean;
  trigger: WorktreeRetirementReport["trigger"];
  settings: WorktreeRetirementSettings;
  /** Read fresh for every check: a session that starts mid-sweep must win. */
  usage: (worktreePath: string) => Promise<WorktreeUsage>;
  /** Stops the released endpoints before their folder goes. A throw keeps the worktree. */
  releaseEndpoints?: (endpoints: AgentEndpoint[], worktree: ScoutWorktreeCandidate) => Promise<void>;
  now?: () => number;
  git?: WorktreeGit;
  measure?: (path: string) => Promise<number | undefined>;
};

/** Every reason to keep `candidate`; empty means it may be retired. */
async function keepReasons(
  candidate: ScoutWorktreeCandidate,
  input: WorktreeSweepInput & { git: WorktreeGit; now: () => number },
  baseRefs: readonly string[],
): Promise<{ reasons: string[]; usage: WorktreeUsage; lastActivityAt: number }> {
  const reasons: string[] = [];
  if (candidate.locked) reasons.push("locked with git worktree lock");
  const usage = await input.usage(candidate.path);
  reasons.push(...usage.holds);

  const gitActivity = await gitActivityAt(candidate.path, input.git);
  const lastActivityAt = Math.max(usage.lastActivityAt, gitActivity, agentWorkspaceClaimedAt(candidate.path) ?? 0);
  const idleMs = input.settings.idleHours * 3_600_000;
  if (lastActivityAt + idleMs > input.now()) {
    const hours = Math.max(0, (input.now() - lastActivityAt) / 3_600_000);
    reasons.push(`active ${hours < 1 ? "within the last hour" : `${Math.floor(hours)}h ago`}, under the ${input.settings.idleHours}h idle threshold`);
  }

  try {
    const { stdout } = await input.git(["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"], { cwd: candidate.path });
    const changes = stdout.split("\n").filter((line) => line.trim()).length;
    if (changes > 0) reasons.push(`uncommitted changes: ${changes} path${changes === 1 ? "" : "s"} in git status`);
  } catch (error) {
    reasons.push(`git status failed: ${errorText(error)}`);
  }

  if (baseRefs.length === 0) {
    reasons.push("no main or master branch to check merges against");
  } else {
    let merged = false;
    for (const ref of baseRefs) {
      if (await gitSucceeds(input.git, ["merge-base", "--is-ancestor", `refs/heads/${candidate.branch}`, ref], candidate.projectRoot)) {
        merged = true;
        break;
      }
    }
    if (!merged) {
      reasons.push(`${candidate.branch} has commits not in ${baseRefs.map((ref) => ref.replace(/^refs\/(heads|remotes)\//, "")).join(" or ")}`);
    }
  }
  return { reasons, usage, lastActivityAt };
}

/** Prune only when git would prune nothing but the entries this sweep removed. */
async function pruneOwnEntries(projectRoot: string, removedAdminNames: readonly string[], git: WorktreeGit): Promise<string | null> {
  let preview: GitResult;
  try {
    preview = await git(["worktree", "prune", "--dry-run", "--verbose"], { cwd: projectRoot });
  } catch (error) {
    return `git worktree prune --dry-run failed: ${errorText(error)}`;
  }
  const lines = `${preview.stdout}\n${preview.stderr}`.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const foreign = lines.filter((line) => !removedAdminNames.some((name) => line.includes(`worktrees/${name}:`)));
  if (foreign.length > 0) {
    return `git worktree prune skipped: it would also prune entries Scout did not remove (${foreign.length})`;
  }
  try {
    await git(["worktree", "prune"], { cwd: projectRoot });
    return null;
  } catch (error) {
    return `git worktree prune failed: ${errorText(error)}`;
  }
}

export async function sweepScoutWorktrees(input: WorktreeSweepInput): Promise<WorktreeRetirementReport> {
  const git = input.git ?? defaultGit;
  const now = input.now ?? Date.now;
  const measure = input.measure ?? approxDiskBytes;
  const context = { ...input, git, now };
  const report: WorktreeRetirementReport = {
    trigger: input.trigger,
    dryRun: input.dryRun,
    startedAt: now(),
    finishedAt: 0,
    settings: input.settings,
    projectRoots: [],
    worktrees: [],
    retired: 0,
    kept: 0,
    approxBytesReclaimed: 0,
    errors: [],
  };

  const roots = [...new Set(input.projectRoots.map((root) => realpathOrNull(root)).filter((root): root is string => Boolean(root)))];
  for (const projectRoot of roots) {
    report.projectRoots.push(projectRoot);
    let listed: Awaited<ReturnType<typeof listScoutWorktrees>>;
    try {
      listed = await listScoutWorktrees(projectRoot, git);
    } catch (error) {
      report.errors.push(`${projectRoot}: git worktree list failed: ${errorText(error)}`);
      continue;
    }
    report.worktrees.push(...listed.skipped);
    if (listed.candidates.length === 0) continue;
    const baseRefs = await defaultBranchRefs(projectRoot, git);
    const removedAdminNames: string[] = [];

    for (const candidate of listed.candidates) {
      const verdict: WorktreeVerdict = { path: candidate.path, projectRoot, branch: candidate.branch, action: "kept", reasons: [] };
      report.worktrees.push(verdict);
      const first = await keepReasons(candidate, context, baseRefs);
      verdict.lastActivityAt = first.lastActivityAt || undefined;
      if (first.reasons.length > 0) {
        verdict.reasons = first.reasons;
        report.kept += 1;
        continue;
      }
      verdict.approxBytes = await measure(candidate.path);
      if (input.dryRun) {
        verdict.action = "would_retire";
        report.retired += 1;
        report.approxBytesReclaimed += verdict.approxBytes ?? 0;
        continue;
      }

      await withAgentWorkspaceRetirement(candidate.path, async () => {
        // Check again right before removal: a session or edit since the first pass wins.
        const second = await keepReasons(candidate, context, baseRefs);
        if (second.reasons.length > 0) {
          verdict.reasons = second.reasons;
          return;
        }
        if (second.usage.releasable.length > 0) {
          try {
            await input.releaseEndpoints?.(second.usage.releasable, candidate);
            verdict.retiredEndpointIds = second.usage.releasable.map((endpoint) => endpoint.id);
          } catch (error) {
            verdict.reasons = [`could not stop the session endpoint first: ${errorText(error)}`];
            return;
          }
        }
        let adminName: string | null = null;
        try {
          const { stdout } = await git(["rev-parse", "--absolute-git-dir"], { cwd: candidate.path });
          adminName = basename(stdout.trim()) || null;
        } catch {
          adminName = null;
        }
        try {
          await git(["worktree", "remove", candidate.path], { cwd: projectRoot, timeoutMs: 120_000 });
        } catch (error) {
          verdict.reasons = [`git worktree remove refused: ${errorText(error)}`];
          return;
        }
        verdict.action = "retired";
        if (adminName) removedAdminNames.push(adminName);
        try {
          await git(["branch", "-d", candidate.branch], { cwd: projectRoot });
          verdict.branchDeleted = true;
        } catch (error) {
          verdict.branchDeleted = false;
          verdict.reasons.push(`branch kept: git branch -d refused: ${errorText(error)}`);
        }
      });

      if (verdict.action === "retired") {
        report.retired += 1;
        report.approxBytesReclaimed += verdict.approxBytes ?? 0;
      } else {
        verdict.approxBytes = undefined;
        report.kept += 1;
      }
    }

    if (removedAdminNames.length > 0) {
      const pruneNote = await pruneOwnEntries(projectRoot, removedAdminNames, git);
      if (pruneNote) report.errors.push(`${projectRoot}: ${pruneNote}`);
    }
  }

  report.finishedAt = now();
  return report;
}

export function formatApproxBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `~${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `~${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `~${Math.round(bytes / 1024)} KB`;
  return `~${bytes} B`;
}

export type WorktreeRetirementStatus = {
  settings: WorktreeRetirementSettings;
  intervalMs: number;
  running: boolean;
  lastSweep: WorktreeRetirementReport | null;
};

export type WorktreeRetirementServiceOptions = {
  nodeId: string;
  snapshot: () => RuntimeRegistrySnapshot;
  isEndpointAlive: (endpoint: AgentEndpoint) => boolean | Promise<boolean>;
  releaseEndpoints: (endpoints: AgentEndpoint[], worktree: ScoutWorktreeCandidate) => Promise<void>;
  /** Mutations admitted: never sweep while the runtime is still restoring. */
  ready?: () => boolean;
  settings?: () => WorktreeRetirementSettings;
  intervalMs?: number;
  firstDelayMs?: number;
  log?: (line: string) => void;
};

/** The runtime routine: an hourly sweep, plus sweeps run by hand. One sweep at a time. */
export class WorktreeRetirementService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private running = false;
  private lastSweep: WorktreeRetirementReport | null = null;
  private readonly intervalMs: number;

  constructor(private readonly options: WorktreeRetirementServiceOptions) {
    this.intervalMs = Math.max(60_000, options.intervalMs ?? 3_600_000);
  }

  private settings(): WorktreeRetirementSettings {
    return (this.options.settings ?? resolveWorktreeRetirementSettings)();
  }

  start(): void {
    if (this.timer) return;
    const tick = (): void => {
      if (!this.settings().enabled) return;
      if (this.options.ready && !this.options.ready()) return;
      this.sweep({ trigger: "periodic" }).catch((error) => {
        this.options.log?.(`[openscout-runtime] worktree retirement sweep failed: ${errorText(error)}`);
      });
    };
    this.firstTimer = setTimeout(tick, this.options.firstDelayMs ?? 10 * 60_000);
    this.firstTimer.unref?.();
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.timer = null;
    this.firstTimer = null;
  }

  status(): WorktreeRetirementStatus {
    return { settings: this.settings(), intervalMs: this.intervalMs, running: this.running, lastSweep: this.lastSweep };
  }

  sweep(input: { trigger: WorktreeRetirementReport["trigger"]; dryRun?: boolean; projectRoots?: readonly string[] }): Promise<WorktreeRetirementReport> {
    const run = async (): Promise<WorktreeRetirementReport> => {
      this.running = true;
      try {
        const { nodeId } = this.options;
        const projectRoots = input.projectRoots?.length
          ? input.projectRoots
          : scoutWorktreeProjectRoots(this.options.snapshot(), nodeId);
        const report = await sweepScoutWorktrees({
          projectRoots,
          dryRun: input.dryRun ?? false,
          trigger: input.trigger,
          settings: this.settings(),
          usage: (path) => scoutWorktreeUsage(this.options.snapshot(), path, { nodeId, isEndpointAlive: this.options.isEndpointAlive }),
          releaseEndpoints: this.options.releaseEndpoints,
        });
        if (!report.dryRun) this.lastSweep = report;
        if (report.retired > 0 && !report.dryRun) {
          this.options.log?.(`[openscout-runtime] retired ${report.retired} idle merged worktree${report.retired === 1 ? "" : "s"}, ${formatApproxBytes(report.approxBytesReclaimed)} (approximate)`);
        }
        return report;
      } finally {
        this.running = false;
      }
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }
}
