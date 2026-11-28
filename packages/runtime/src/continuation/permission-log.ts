/**
 * The permission record: every decision the watcher, a rule or the operator
 * made, read back from the continuation audit log (the live file and its
 * gzipped segments), with stats and the rule writes the agent page needs.
 *
 * Rule writes are the operator's: the broker route that calls them requires
 * operator proof. Nothing here is reachable by an agent on its own.
 */

import { redactSecrets } from "./redact.js";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, isAbsolute, resolve, sep } from "node:path";

import {
  continuationAuditPath,
  continuationPermissionScopes,
  continuationPolicyPath,
  loadContinuationPolicy,
  resolveContinuationGrant,
  rolledContinuationAuditFiles,
  type ContinuationAuditEntry,
  type ContinuationPolicyFile,
} from "./grants.js";
import {
  DEFAULT_PERMISSION_RULES,
  PERMISSION_LISTS,
  matchPermissionRules,
  parsePermissionRule,
  permissionScope,
  permissionToolName,
  type PermissionCall,
  type PermissionList,
  type PermissionMode,
} from "./rules.js";

export const PERMISSION_DECISIONS = ["approved", "asked", "denied", "closed", "answered"] as const;
export type PermissionDecisionOutcome = (typeof PERMISSION_DECISIONS)[number];

/** One row of the record, in the page's terms. */
export type PermissionRecordRow = {
  at: number;
  decision: PermissionDecisionOutcome;
  /** How the keys fared: sent, failed, or the line's own outcome for one that sent none. */
  outcome: string;
  answer?: string;
  via?: string;
  /** The rule as written, `mode:auto` / `mode:default`, or `operator` for an answer by hand. */
  rule: string;
  list: string;
  ruleScope?: string;
  /** The built-in deny rules the allow rule lifted. */
  overrides?: string[];
  /** The rule as the page shows it: `allow Bash(rm -rf ./dist:*) (overrides default deny Bash(rm -rf:*))`. */
  label: string;
  risk: string;
  reason: string;
  agentId?: string;
  agentName?: string;
  project?: string;
  tool?: string;
  command: string | null;
  requestId?: string;
  sessionId?: string;
  backend?: string;
  grant: string;
};

export type PermissionLogQuery = {
  since?: number;
  until?: number;
  decision?: PermissionDecisionOutcome;
  /** An agent id, or part of its name. */
  agent?: string;
  rule?: string;
  tool?: string;
  project?: string;
  via?: string;
  /** Newest first; default 200, at most 5000. */
  limit?: number;
};

type Counts = Record<PermissionDecisionOutcome, number>;
export type PermissionStats = {
  since: number;
  until: number;
  total: number;
  byDecision: Counts;
  byRule: Array<{ rule: string; list: string; total: number; byDecision: Counts }>;
  byAgent: Array<{ agentId: string | null; agentName: string | null; total: number; byDecision: Counts }>;
  byVia: Array<{ via: string; total: number }>;
  byTool: Array<{ tool: string; total: number }>;
};

const DAY_MS = 24 * 60 * 60_000;

/** Reads every line still kept, oldest first. Unreadable lines are skipped. */
export function readContinuationAudit(path = continuationAuditPath(), since = 0): ContinuationAuditEntry[] {
  const texts: string[] = [];
  for (const file of rolledContinuationAuditFiles(path)) {
    try {
      texts.push(gunzipSync(readFileSync(file)).toString("utf8"));
    } catch {
      // A damaged segment loses its own lines, not the rest.
    }
  }
  try {
    if (existsSync(path)) texts.push(readFileSync(path, "utf8"));
  } catch {
    // Nothing live yet.
  }
  const entries: ContinuationAuditEntry[] = [];
  for (const text of texts) {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as ContinuationAuditEntry;
        if (typeof entry?.at === "number" && entry.at >= since) entries.push(entry);
      } catch {
        // A torn line from a crash; skip it.
      }
    }
  }
  return entries.sort((left, right) => left.at - right.at);
}

/**
 * One line as a record row, or null for a line that is not a decision (a key
 * attempt, a pane mismatch, a claim another server took). Lines written
 * before `decision` existed read as an approval by `mode:auto`, or as the
 * operator's answer when an `operator:` grant sent them.
 */
export function permissionRecordRow(entry: ContinuationAuditEntry): PermissionRecordRow | null {
  const legacyOperator = entry.grant?.startsWith("operator:") === true;
  const decision = entry.decision
    ?? (entry.outcome === "sent" || entry.outcome === "failed" ? (legacyOperator ? "answered" : "approved") : null);
  if (!decision) return null;
  const via = entry.via ?? (entry.grant === "operator:companion" ? "mac-companion" : !legacyOperator && decision === "approved" ? "watcher" : undefined);
  return {
    at: entry.at,
    decision,
    outcome: entry.outcome,
    ...(entry.answer ? { answer: entry.answer } : {}),
    ...(via ? { via } : {}),
    rule: entry.rule ?? (decision === "answered" ? "operator" : "mode:auto"),
    list: entry.list ?? (decision === "answered" ? "operator" : "mode"),
    ...(entry.ruleScope ? { ruleScope: entry.ruleScope } : {}),
    ...(entry.overrides?.length ? { overrides: entry.overrides } : {}),
    label: ruleLabel(entry.list ?? (decision === "answered" ? "operator" : "mode"), entry.rule ?? (decision === "answered" ? "operator" : "mode:auto"), entry.overrides),
    risk: entry.risk,
    reason: redactSecrets(entry.reason),
    ...(entry.agentId ? { agentId: entry.agentId } : {}),
    ...(entry.agentName ? { agentName: entry.agentName } : {}),
    ...(entry.projectRoot ? { project: entry.projectRoot } : {}),
    ...(entry.tool ? { tool: entry.tool } : {}),
    command: redactSecrets(entry.command) ?? null,
    ...(entry.requestId ? { requestId: entry.requestId } : {}),
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    ...(entry.backend ? { backend: entry.backend } : {}),
    grant: entry.grant,
  };
}

function rowMatches(row: PermissionRecordRow, query: PermissionLogQuery): boolean {
  if (query.since !== undefined && row.at < query.since) return false;
  if (query.until !== undefined && row.at > query.until) return false;
  if (query.decision && row.decision !== query.decision) return false;
  if (query.rule && row.rule !== query.rule) return false;
  if (query.via && row.via !== query.via) return false;
  if (query.tool && permissionToolName(row.tool ?? "") !== permissionToolName(query.tool)) return false;
  if (query.project && !(row.project && within(row.project, query.project))) return false;
  if (query.agent) {
    const needle = query.agent.toLowerCase();
    if (row.agentId !== query.agent && !row.agentName?.toLowerCase().includes(needle)) return false;
  }
  return true;
}

/** The record, newest first. */
export function readPermissionLog(query: PermissionLogQuery = {}, path = continuationAuditPath()): PermissionRecordRow[] {
  const limit = Math.min(Math.max(1, query.limit ?? 200), 5000);
  const rows: PermissionRecordRow[] = [];
  const entries = readContinuationAudit(path, query.since ?? 0);
  for (let index = entries.length - 1; index >= 0 && rows.length < limit; index--) {
    const row = permissionRecordRow(entries[index]!);
    if (row && rowMatches(row, query)) rows.push(row);
  }
  return rows;
}

function emptyCounts(): Counts {
  return { approved: 0, asked: 0, denied: 0, closed: 0, answered: 0 };
}

/** Counts by decision, rule, agent, surface and tool over a window (default: the last 7 days). */
export function permissionStats(
  query: Omit<PermissionLogQuery, "limit"> = {},
  path = continuationAuditPath(),
  now = Date.now(),
): PermissionStats {
  const since = query.since ?? now - 7 * DAY_MS;
  const until = query.until ?? now;
  const byDecision = emptyCounts();
  const rules = new Map<string, { rule: string; list: string; total: number; byDecision: Counts }>();
  const agents = new Map<string, { agentId: string | null; agentName: string | null; total: number; byDecision: Counts }>();
  const vias = new Map<string, number>();
  const tools = new Map<string, number>();
  let total = 0;
  for (const entry of readContinuationAudit(path, since)) {
    const row = permissionRecordRow(entry);
    if (!row || !rowMatches(row, { ...query, since, until })) continue;
    total++;
    byDecision[row.decision]++;
    const rule = rules.get(`${row.list}\u0000${row.rule}`) ?? { rule: row.rule, list: row.list, total: 0, byDecision: emptyCounts() };
    rule.total++;
    rule.byDecision[row.decision]++;
    rules.set(`${row.list}\u0000${row.rule}`, rule);
    const agentKey = row.agentId ?? row.sessionId ?? "unknown";
    const agent = agents.get(agentKey) ?? { agentId: row.agentId ?? null, agentName: row.agentName ?? null, total: 0, byDecision: emptyCounts() };
    agent.total++;
    agent.byDecision[row.decision]++;
    if (!agent.agentName && row.agentName) agent.agentName = row.agentName;
    agents.set(agentKey, agent);
    if (row.via) vias.set(row.via, (vias.get(row.via) ?? 0) + 1);
    const tool = permissionToolName(row.tool ?? "unknown");
    tools.set(tool, (tools.get(tool) ?? 0) + 1);
  }
  const byTotal = <T extends { total: number }>(items: Iterable<T>) => [...items].sort((a, b) => b.total - a.total);
  return {
    since, until, total, byDecision,
    byRule: byTotal(rules.values()),
    byAgent: byTotal(agents.values()),
    byVia: byTotal([...vias].map(([via, count]) => ({ via, total: count }))),
    byTool: byTotal([...tools].map(([tool, count]) => ({ tool, total: count }))),
  };
}

/* ── the definition, and the operator's rule writes ────────────────────── */

export type PermissionRulesView = {
  path: string;
  defaultMode: PermissionMode;
  precedence: string;
  scopes: Array<{
    scope: string;
    mode: PermissionMode;
    lists: Record<PermissionList, Array<{ rule: string; builtin: boolean }>>;
  }>;
};

/** What the watcher may answer: each scope's lists, with the built-in defaults marked. */
export function permissionRulesView(policy = loadContinuationPolicy(), path = continuationPolicyPath()): PermissionRulesView {
  const scopes: PermissionRulesView["scopes"] = [];
  const describe = (scope: string, mode: PermissionMode, inheritAllow: boolean, explicit: ContinuationPolicyFile["permissions"], inherit: boolean) => {
    const built = permissionScope(scope, explicit, { deny: inherit, ask: inherit, allow: inherit && inheritAllow });
    const lists = { allow: [], ask: [], deny: [] } as PermissionRulesView["scopes"][number]["lists"];
    for (const list of PERMISSION_LISTS) lists[list] = built.rules[list].map((rule) => ({ rule, builtin: built.builtin[list] === true }));
    scopes.push({ scope, mode, lists });
  };
  for (const grant of policy.grants) {
    if (grant.scope !== "project") continue;
    describe(`project:${grant.path}`, grant.level === "ask" ? "default" : "auto", false, grant.permissions, false);
  }
  describe("policy", policy.defaultMode ?? "default", true, policy.permissions, true);
  return {
    path,
    defaultMode: policy.defaultMode ?? "default",
    precedence: "Deny beats ask, and ask beats allow. Anything no rule covers goes to the mode.",
    scopes,
  };
}

export type PermissionRuleDryRun = {
  rule: string;
  list: PermissionList;
  scope: string;
  /** Past records the rule covers, newest first. */
  matches: Array<PermissionRecordRow & {
    /** The decision this rule would give the call now, or the rule that would still win over it. */
    wouldBe: PermissionList | "unchanged";
    shadowedBy?: { rule: string; list: PermissionList; scope: string };
    /** The built-in deny rules the new allow rule would lift for this call. */
    overrides?: string[];
    /** `allow Bash(rm -rf ./dist:*) (overrides default deny Bash(rm -rf:*))`. */
    wouldBeLabel?: string;
  }>;
  total: number;
};

export class PermissionRuleError extends Error {}

/**
 * What a new rule would have matched in the record, and where an existing
 * deny or ask rule would still win over it. Writes nothing.
 */
export function dryRunPermissionRule(
  input: { list: PermissionList; rule: string; project?: string; since?: number; limit?: number },
  policy = loadContinuationPolicy(),
  auditPath = continuationAuditPath(),
): PermissionRuleDryRun {
  const { list, rule, project } = validateRuleInput(input);
  const scope = project ? `project:${project}` : "policy";
  const candidate = permissionScope(scope, { [list]: [rule] }, { deny: false, ask: false, allow: false });
  const matches: PermissionRuleDryRun["matches"] = [];
  let total = 0;
  for (const row of readPermissionLog({ since: input.since ?? 0, limit: 5000 }, auditPath)) {
    const call = rowCall(row);
    if (!call) continue;
    if (project && !within(call.root, project)) continue;
    if (!matchPermissionRules([candidate], call)) continue;
    total++;
    if (matches.length >= (input.limit ?? 50)) continue;
    const resolved = resolveContinuationGrant(policy, { herdrSession: "", paneId: "", cwd: call.root, foregroundCwd: call.root });
    const mode: PermissionMode = resolved.level === "ask" ? "default" : "auto";
    // The new rule joins the existing ones; whatever then decides the call is the answer.
    const decided = matchPermissionRules([candidate, ...continuationPermissionScopes(policy, resolved.source, mode)], call);
    const ours = decided !== null && decided.scope === scope && decided.list === list && decided.rule === rule && !decided.builtin;
    const winner = !ours && decided && !(decided.list === "allow" && decided.builtin) ? decided : null;
    matches.push({
      ...row,
      wouldBe: winner ? "unchanged" : list,
      ...(winner ? { shadowedBy: { rule: winner.rule, list: winner.list, scope: winner.scope } } : {}),
      ...(ours && decided.overrides ? { overrides: decided.overrides } : {}),
      ...(!winner ? { wouldBeLabel: ruleLabel(list, rule, ours ? decided.overrides : undefined) } : {}),
    });
  }
  return { rule, list, scope, matches, total };
}

/** `allow Bash(rm -rf ./dist:*) (overrides default deny Bash(rm -rf:*))`. */
function ruleLabel(list: string, rule: string, overrides?: string[]): string {
  if (list === "mode" || list === "operator") return rule;
  return overrides?.length ? `${list} ${rule} (overrides default deny ${overrides.join(", ")})` : `${list} ${rule}`;
}

function rowCall(row: PermissionRecordRow): PermissionCall | null {
  if (!row.project || !row.tool) return null;
  const tool = permissionToolName(row.tool);
  if (tool === "Bash") return row.command ? { tool, command: row.command, root: row.project } : null;
  if (tool === "Read" || tool === "Edit" || tool === "Write") return row.command ? { tool, path: row.command, root: row.project } : null;
  return { tool, root: row.project };
}

function validateRuleInput(input: { list: unknown; rule: unknown; project?: unknown }): { list: PermissionList; rule: string; project?: string } {
  if (!PERMISSION_LISTS.includes(input.list as PermissionList)) throw new PermissionRuleError("list must be allow, ask or deny");
  if (!parsePermissionRule(input.rule)) throw new PermissionRuleError("rule must be in Tool(pattern) form, e.g. Bash(git push:*)");
  if (input.project !== undefined) {
    if (typeof input.project !== "string" || !isAbsolute(input.project) || resolve(input.project) === resolve(sep)) {
      throw new PermissionRuleError("project must be an absolute path other than /");
    }
  }
  return {
    list: input.list as PermissionList,
    rule: (input.rule as string).trim(),
    ...(typeof input.project === "string" ? { project: resolve(input.project) } : {}),
  };
}

/**
 * Appends one rule to the operator's policy file and returns the dry run for
 * it. A top-level list the file did not name yet starts from its built-in
 * default, so adding one rule never drops the others. A project rule goes on
 * that project's grant; a project with no grant gets one at `ask`, which
 * changes nothing but the rule.
 */
export function appendPermissionRule(
  input: { list: PermissionList; rule: string; project?: string },
  path = continuationPolicyPath(),
  auditPath = continuationAuditPath(),
): { added: boolean; dryRun: PermissionRuleDryRun } {
  const { list, rule, project } = validateRuleInput(input);
  let raw: Record<string, unknown> = { version: 1, allowModel: false, grants: [] };
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      throw new PermissionRuleError("the policy file is not valid JSON; fix it by hand first");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.version !== 1) {
      throw new PermissionRuleError("the policy file is not version 1; fix it by hand first");
    }
  }
  let target: Record<string, unknown>;
  if (project) {
    const grants = Array.isArray(raw.grants) ? raw.grants as Array<Record<string, unknown>> : [];
    let grant = grants.find((entry) => entry?.scope === "project" && typeof entry.path === "string" && resolve(entry.path) === project);
    if (!grant) {
      grant = { scope: "project", path: project, level: "ask" };
      grants.push(grant);
    }
    raw.grants = grants;
    grant.permissions = grant.permissions && typeof grant.permissions === "object" && !Array.isArray(grant.permissions) ? grant.permissions : {};
    target = grant.permissions as Record<string, unknown>;
  } else {
    raw.permissions = raw.permissions && typeof raw.permissions === "object" && !Array.isArray(raw.permissions) ? raw.permissions : {};
    target = raw.permissions as Record<string, unknown>;
    // Deny and ask defaults stay when the first rule of that list is written.
    if (!Array.isArray(target[list]) && list !== "allow") target[list] = [...DEFAULT_PERMISSION_RULES[list]];
  }
  const current = Array.isArray(target[list]) ? target[list] as unknown[] : [];
  const added = !current.includes(rule);
  if (added) target[list] = [...current, rule];
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return { added, dryRun: dryRunPermissionRule({ list, rule, ...(project ? { project } : {}) }, loadContinuationPolicy(path), auditPath) };
}

function within(path: string, root: string): boolean {
  const target = resolve(path);
  const base = resolve(root);
  return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}
