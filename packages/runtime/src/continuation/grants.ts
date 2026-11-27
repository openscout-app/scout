/**
 * Continuation grants: the operator's explicit, scoped opt-in.
 *
 * Nothing continues by default. A pane runs at `ask` (notify every stop)
 * unless a Scout-owned grant names it — by Herdr session + pane, or by a
 * project directory that the pane's working directories sit inside. The grant
 * file is written by the operator, not by an agent and not by a harness
 * setting. Every key Scout sends on a grant's behalf is appended to an audit
 * log next to it.
 *
 *   $OPENSCOUT_HOME/continuation-policy.json
 *   {
 *     "version": 1,
 *     "allowModel": false,
 *     "grants": [
 *       { "scope": "project", "path": "/Users/me/dev/app", "level": "workspace" },
 *       { "scope": "session", "herdrSession": "default", "paneId": "w1:p2", "level": "unattended" }
 *     ]
 *   }
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { normalizeContinuationLevel, type ContinuationLevel } from "./policy.js";
import { resolveOpenScoutHome } from "../support-paths.js";

export type ContinuationGrant =
  | { scope: "project"; path: string; level: ContinuationLevel }
  | { scope: "session"; herdrSession: string; paneId: string; level: ContinuationLevel };

export type ContinuationPolicyFile = {
  /** Lets the cheap model read live dialogs on granted panes. Default false. */
  allowModel: boolean;
  grants: ContinuationGrant[];
};

export type ContinuationPaneScope = {
  herdrSession: string;
  paneId: string;
  terminalId?: string | null;
  cwd?: string | null;
  foregroundCwd?: string | null;
};

export type ResolvedContinuationGrant = {
  level: ContinuationLevel;
  /** Human-readable pointer at the grant that applied, or `default`. */
  source: string;
};

const EMPTY_POLICY: ContinuationPolicyFile = { allowModel: false, grants: [] };

function continuationHome(): string {
  return resolveOpenScoutHome();
}

export function continuationPolicyPath(): string {
  return join(continuationHome(), "continuation-policy.json");
}

export function continuationAuditPath(): string {
  return join(continuationHome(), "logs", "continuation-audit.jsonl");
}

function continuationLockDirectory(): string {
  return join(continuationHome(), "run", "continuation-locks");
}

/** Parse a policy document. Anything malformed is dropped, never widened. */
export function parseContinuationPolicy(raw: unknown): ContinuationPolicyFile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_POLICY;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) return EMPTY_POLICY;
  const grants: ContinuationGrant[] = [];
  for (const entry of Array.isArray(record.grants) ? record.grants : []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const grant = entry as Record<string, unknown>;
    const level = typeof grant.level === "string" ? normalizeContinuationLevel(grant.level) : undefined;
    if (!level) continue;
    if (grant.scope === "project") {
      const path = typeof grant.path === "string" ? grant.path.trim() : "";
      // Only absolute, non-root paths. `/` would grant the whole machine.
      if (!path || !isAbsolute(path) || resolve(path) === resolve(sep)) continue;
      grants.push({ scope: "project", path: resolve(path), level });
    } else if (grant.scope === "session") {
      const herdrSession = typeof grant.herdrSession === "string" ? grant.herdrSession.trim() : "";
      const paneId = typeof grant.paneId === "string" ? grant.paneId.trim() : "";
      if (!herdrSession || !paneId) continue;
      grants.push({ scope: "session", herdrSession, paneId, level });
    }
  }
  return { allowModel: record.allowModel === true, grants };
}

/** Read the operator's policy file. Missing or unreadable means no grants. */
export function loadContinuationPolicy(path = continuationPolicyPath()): ContinuationPolicyFile {
  try {
    if (!existsSync(path)) return EMPTY_POLICY;
    return parseContinuationPolicy(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return EMPTY_POLICY;
  }
}

function within(directory: string, root: string): boolean {
  const target = resolve(directory);
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * The level for one pane. A session grant (exact Herdr session + pane) wins
 * over a project grant. A project grant applies only when every working
 * directory Herdr reports for the pane is inside the project; a pane with no
 * directory never matches a project. No match is `ask`.
 */
export function resolveContinuationGrant(
  policy: ContinuationPolicyFile,
  pane: ContinuationPaneScope,
): ResolvedContinuationGrant {
  const paneIds = new Set([pane.paneId, pane.terminalId].filter((value): value is string => Boolean(value)));
  const session = policy.grants.find((grant) =>
    grant.scope === "session"
    && grant.herdrSession === pane.herdrSession
    && paneIds.has(grant.paneId));
  if (session) {
    return { level: session.level, source: `session:${pane.herdrSession}:${(session as { paneId: string }).paneId}` };
  }

  const directories = [pane.cwd, pane.foregroundCwd]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value && isAbsolute(value)));
  if (directories.length === 0) return { level: "ask", source: "default" };

  // Each directory resolves to its own deepest project grant. They must all
  // land on the same grant; a pane straddling scopes (or one directory with
  // no grant) is `ask`, so a narrower grant is never skipped.
  const resolved = directories.map((directory) => deepestProjectGrant(policy, directory));
  const first = resolved[0] ?? null;
  if (!first || resolved.some((grant) => grant !== first)) {
    return { level: "ask", source: resolved.some(Boolean) ? "conflict" : "default" };
  }
  return { level: first.level, source: `project:${first.path}` };
}

function deepestProjectGrant(
  policy: ContinuationPolicyFile,
  directory: string,
): Extract<ContinuationGrant, { scope: "project" }> | null {
  let best: Extract<ContinuationGrant, { scope: "project" }> | null = null;
  for (const grant of policy.grants) {
    if (grant.scope !== "project") continue;
    if (!within(directory, grant.path)) continue;
    if (!best || grant.path.length > best.path.length) best = grant;
  }
  return best;
}

export type ContinuationAuditEntry = {
  at: number;
  outcome: "attempt" | "sent" | "failed" | "mismatch" | "claimed-elsewhere";
  /** Where the answer went: a tmux/Herdr pane, a native harness hook, or a Scout-managed session. */
  backend?: string;
  herdrSession?: string;
  paneId?: string;
  sessionId?: string;
  requestId?: string;
  projectRoot?: string;
  tool?: string;
  level: ContinuationLevel;
  grant: string;
  command: string | null;
  risk: string;
  keys: readonly string[] | null;
  source: "rules" | "model";
  reason: string;
};

/** Append one actuation record. Audit failure must not be silent success. */
export function appendContinuationAudit(
  entry: ContinuationAuditEntry,
  path = continuationAuditPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}

/**
 * Cross-process claim on one pane's prompt so two Scout web servers on the
 * same machine cannot both answer it.
 *
 * No lock is ever taken over or deleted while it can matter. Time is cut
 * into `ttlMs` buckets and a claim must exclusively create the files for
 * its bucket and the next one. Two claims less than `ttlMs` apart always
 * share a bucket file, and `O_EXCL` lets only one create it. A partial claim
 * returns false (fail closed: the prompt is surfaced, not answered).
 */
export function claimContinuationActuation(
  key: string,
  ttlMs: number,
  directory = continuationLockDirectory(),
): boolean {
  const now = Date.now();
  mkdirSync(directory, { recursive: true });
  const id = createHash("sha256").update(key).digest("hex").slice(0, 32);
  const width = Math.max(1, Math.floor(ttlMs));
  const bucket = Math.floor(now / width);
  pruneContinuationLocks(directory, now, width);
  for (const slot of [bucket, bucket + 1]) {
    try {
      const fd = openSync(join(directory, `${id}.${slot}.lock`), "wx", 0o600);
      try {
        writeSync(fd, `${process.pid} ${now}\n`);
      } finally {
        closeSync(fd);
      }
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Give back a claim this process took when the keys it was for never reached
 * the pane, so the next answer isn't refused as already in progress. Only this
 * process's own bucket files are removed.
 */
export function releaseContinuationActuation(
  key: string,
  directory = continuationLockDirectory(),
): void {
  const id = createHash("sha256").update(key).digest("hex").slice(0, 32);
  try {
    for (const name of readdirSync(directory)) {
      if (!name.startsWith(`${id}.`) || !name.endsWith(".lock")) continue;
      const path = join(directory, name);
      try {
        if (readFileSync(path, "utf8").startsWith(`${process.pid} `)) unlinkSync(path);
      } catch {
        // Pruned or released already; fine.
      }
    }
  } catch {
    // No lock directory: nothing to give back.
  }
}

/** Drop bucket files far older than any live claim window. */
function pruneContinuationLocks(directory: string, now: number, width: number): void {
  const horizon = Math.max(width * 4, 5 * 60_000);
  try {
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".lock")) continue;
      const path = join(directory, name);
      try {
        if (now - statSync(path).mtimeMs > horizon) unlinkSync(path);
      } catch {
        // Raced with another pruner; fine.
      }
    }
  } catch {
    // Unreadable directory: claims below will fail closed on their own.
  }
}
