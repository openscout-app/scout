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
 *     ],
 *     "permissions": { "allow": [], "ask": [], "deny": [], "defaultMode": "default" }
 *   }
 *
 * `permissions` holds rules in Claude Code's `Tool(pattern)` syntax (see
 * `rules.ts`). A project grant may carry its own `permissions` lists too.
 */

import { parsePermissionSignalSettings, type PermissionSignalSettings } from "./signals.js";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import { homedir } from "node:os";
import { redactSecrets } from "./redact.js";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { normalizeContinuationLevel, type ContinuationLevel } from "./policy.js";
import {
  normalizePermissionMode,
  parsePermissionRuleList,
  permissionScope,
  type PermissionMode,
  type PermissionRuleScope,
  type PermissionRuleSet,
} from "./rules.js";
import { resolveOpenScoutHome } from "../support-paths.js";

export type ContinuationGrant =
  | { scope: "project"; path: string; level: ContinuationLevel; permissions?: Partial<PermissionRuleSet>; signals?: PermissionSignalSettings }
  | { scope: "session"; herdrSession: string; paneId: string; level: ContinuationLevel };

export type ContinuationPolicyFile = {
  /** Lets the cheap model read live dialogs on granted panes. Default false. */
  allowModel: boolean;
  grants: ContinuationGrant[];
  /** The file's own rule lists. A list left out takes the built-in default. */
  permissions?: Partial<PermissionRuleSet>;
  /** The mode outside every grant. Only an explicit `auto` changes `default`. */
  defaultMode?: PermissionMode;
  /** Escalation signals turned off, everywhere or for some projects. Every one is on by default. */
  signals?: PermissionSignalSettings;
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
      const permissions = parsePermissionLists(grant.permissions);
      const signals = parsePermissionSignalSettings(grant.signals);
      grants.push({ scope: "project", path: resolve(path), level, ...(permissions ? { permissions } : {}), ...(signals ? { signals } : {}) });
    } else if (grant.scope === "session") {
      const herdrSession = typeof grant.herdrSession === "string" ? grant.herdrSession.trim() : "";
      const paneId = typeof grant.paneId === "string" ? grant.paneId.trim() : "";
      if (!herdrSession || !paneId) continue;
      grants.push({ scope: "session", herdrSession, paneId, level });
    }
  }
  const permissions = parsePermissionLists(record.permissions);
  const signals = parsePermissionSignalSettings(record.signals);
  const defaultMode = record.permissions && typeof record.permissions === "object"
    ? normalizePermissionMode((record.permissions as Record<string, unknown>).defaultMode)
    : undefined;
  return {
    allowModel: record.allowModel === true,
    grants,
    ...(permissions ? { permissions } : {}),
    ...(defaultMode ? { defaultMode } : {}),
    ...(signals ? { signals } : {}),
  };
}

/**
 * The signal settings for a call: the grant's own settings over the file's.
 * A signal is on unless one of them turns it off.
 */
export function continuationSignalSettings(policy: ContinuationPolicyFile, grantSource: string): PermissionSignalSettings {
  const grant = policy.grants.find((entry) => entry.scope === "project" && `project:${entry.path}` === grantSource);
  return { ...(policy.signals ?? {}), ...(grant?.scope === "project" ? grant.signals ?? {} : {}) };
}

/** The lists a `permissions` object names. Malformed rules are dropped, never widened. */
function parsePermissionLists(raw: unknown): Partial<PermissionRuleSet> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const lists: Partial<PermissionRuleSet> = {};
  for (const list of ["allow", "ask", "deny"] as const) {
    const rules = parsePermissionRuleList(record[list]);
    if (rules) lists[list] = rules;
  }
  return Object.keys(lists).length ? lists : undefined;
}

/**
 * The rule scopes for a call under the grant that `resolveContinuationGrant`
 * picked: the grant's own lists (for a project grant), then the file's.
 * Built-in allow labels join only when the mode is `auto`.
 */
export function continuationPermissionScopes(
  policy: ContinuationPolicyFile,
  grantSource: string,
  mode: PermissionMode,
): PermissionRuleScope[] {
  const scopes: PermissionRuleScope[] = [];
  const project = grantSource.startsWith("project:")
    ? policy.grants.find((grant) => grant.scope === "project" && `project:${grant.path}` === grantSource)
    : undefined;
  if (project?.scope === "project" && project.permissions) {
    scopes.push(permissionScope(grantSource, project.permissions, { deny: false, ask: false, allow: false }));
  }
  scopes.push(permissionScope("policy", policy.permissions, { deny: true, ask: true, allow: mode === "auto" }));
  return scopes;
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
  /**
   * How the line's keys fared (`attempt`, `sent`, `failed`, …), or, for a line
   * that sent nothing, what happened: `asked`, `denied` or `closed`.
   */
  outcome: "attempt" | "sent" | "failed" | "mismatch" | "claimed-elsewhere" | "asked" | "denied" | "closed";
  /** One of the five decisions the permission record counts. Lines written before it existed lack it. */
  decision?: "approved" | "asked" | "denied" | "closed" | "answered";
  /** The decision sent: once, project or deny. */
  answer?: string;
  /** The surface that answered: ios, mac-companion, web, cli or watcher. */
  via?: string;
  /** The rule that decided, exactly as written, or `mode:auto` / `mode:default`. */
  rule?: string;
  /** allow, ask, deny, or mode. */
  list?: string;
  /** Where the rule is defined: `policy` or `project:<path>`. */
  ruleScope?: string;
  /** The built-in deny rules this operator allow rule lifted. */
  overrides?: string[];
  /** The escalation signal the call raised, its line for the phone, and the untrusted source behind it. */
  signal?: string;
  signalLine?: string;
  signalSource?: string;
  /** True when the signal turned an automatic approval into an ask. */
  held?: boolean;
  /** True when this auto-approval was the first time this shape was allowed in the project. */
  firstSeen?: boolean;
  agentId?: string;
  agentName?: string;
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
  rotateContinuationAudit(path);
  // Commands carry tokens often enough that the record never keeps them.
  const line = { ...entry, command: redactSecrets(entry.command), reason: redactSecrets(entry.reason) };
  appendFileSync(path, `${JSON.stringify(line)}\n`, { encoding: "utf8", mode: 0o600 });
}

/** The live file rolls over at this size; each rolled segment is gzipped beside it. */
export const CONTINUATION_AUDIT_ROTATE_BYTES = 1024 * 1024;
/** Rolled segments are kept this long after they roll, so at least 30 days of lines stay readable. */
export const CONTINUATION_AUDIT_RETAIN_MS = 45 * 24 * 60 * 60_000;
const ROLLED_SEGMENT = /^continuation-audit\.(\d{8}T\d{6}Z)-[0-9a-f]{6}\.jsonl\.gz$/;

/** The gzipped segments beside the live file, oldest first. */
export function rolledContinuationAuditFiles(path = continuationAuditPath()): string[] {
  try {
    return readdirSync(dirname(path)).filter((name) => ROLLED_SEGMENT.test(name)).sort().map((name) => join(dirname(path), name));
  } catch {
    return [];
  }
}

/**
 * Rolls the live file over once it passes the size limit, and drops segments
 * past retention. Several writers may race: only the one whose rename wins
 * rolls the file; the others append to the new one.
 */
export function rotateContinuationAudit(
  path = continuationAuditPath(),
  options: { maxBytes?: number; retainMs?: number; now?: number } = {},
): void {
  const now = options.now ?? Date.now();
  try {
    if (statSync(path).size < (options.maxBytes ?? CONTINUATION_AUDIT_ROTATE_BYTES)) return;
  } catch {
    return;
  }
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const suffix = createHash("sha256").update(`${process.pid}:${now}:${Math.random()}`).digest("hex").slice(0, 6);
  const moving = `${path}.${suffix}.rolling`;
  try {
    renameSync(path, moving);
  } catch {
    return;
  }
  try {
    const target = join(dirname(path), `continuation-audit.${stamp}-${suffix}.jsonl.gz`);
    writeFileSync(target, gzipSync(readFileSync(moving)), { mode: 0o600 });
    unlinkSync(moving);
  } catch {
    // Keep the uncompressed segment rather than lose lines.
  }
  for (const file of rolledContinuationAuditFiles(path)) {
    try {
      if (now - statSync(file).mtimeMs > (options.retainMs ?? CONTINUATION_AUDIT_RETAIN_MS)) unlinkSync(file);
    } catch {
      // Raced with another writer's prune; fine.
    }
  }
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
