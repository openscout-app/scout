import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendContinuationAudit,
  loadContinuationPolicy,
  rolledContinuationAuditFiles,
  rotateContinuationAudit,
  type ContinuationAuditEntry,
} from "./continuation/grants.js";
import {
  appendPermissionRule,
  dryRunPermissionRule,
  permissionRecordRow,
  permissionRulesView,
  permissionStats,
  readPermissionLog,
} from "./continuation/permission-log.js";
import { DEFAULT_PERMISSION_RULES } from "./continuation/rules.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function scratch(): { dir: string; audit: string; policy: string } {
  const dir = mkdtempSync(join(tmpdir(), "scout-permission-log-"));
  dirs.push(dir);
  return { dir, audit: join(dir, "logs", "continuation-audit.jsonl"), policy: join(dir, "continuation-policy.json") };
}

const project = "/work/app";
function line(overrides: Partial<ContinuationAuditEntry>): ContinuationAuditEntry {
  return {
    at: 1_000, outcome: "sent", backend: "native:antigravity", sessionId: "s1", projectRoot: project, tool: "run_command",
    level: "workspace", grant: `project:${project}`, command: "bun test", risk: "workspace", keys: null, source: "rules",
    reason: "workspace continues workspace", ...overrides,
  };
}

describe("the record", () => {
  test("reads lines written before decision existed: an automatic send is approved by mode:auto, an operator one is answered", () => {
    expect(permissionRecordRow(line({}))).toMatchObject({ decision: "approved", rule: "mode:auto", list: "mode", via: "watcher" });
    expect(permissionRecordRow(line({ grant: "operator:companion", backend: "tmux" }))).toMatchObject({ decision: "answered", via: "mac-companion", rule: "operator" });
    expect(permissionRecordRow(line({ outcome: "attempt" }))).toBeNull();
    expect(permissionRecordRow(line({ outcome: "claimed-elsewhere" }))).toBeNull();
  });

  test("filters by decision, agent, rule and window, newest first", () => {
    const { audit } = scratch();
    appendContinuationAudit(line({ at: 1, decision: "approved", rule: "Bash(bun test:*)", list: "allow", agentId: "a1", agentName: "Pixel" }), audit);
    appendContinuationAudit(line({ at: 2, outcome: "asked", decision: "asked", rule: "Bash(git push:*)", list: "ask", command: "git push", agentId: "a2", agentName: "Satie" }), audit);
    appendContinuationAudit(line({ at: 3, outcome: "denied", decision: "denied", rule: "Bash(rm -rf:*)", list: "deny", command: "rm -rf x", agentId: "a2" }), audit);
    appendContinuationAudit(line({ at: 4, decision: "answered", answer: "once", via: "ios", rule: "operator", list: "operator", agentId: "a2" }), audit);
    writeFileSync(audit, `${readFileSync(audit, "utf8")}{torn\n`);
    expect(readPermissionLog({}, audit).map((row) => row.at)).toEqual([4, 3, 2, 1]);
    expect(readPermissionLog({ decision: "asked" }, audit).map((row) => row.rule)).toEqual(["Bash(git push:*)"]);
    expect(readPermissionLog({ agent: "pix" }, audit).map((row) => row.at)).toEqual([1]);
    expect(readPermissionLog({ since: 2, until: 3 }, audit).map((row) => row.at)).toEqual([3, 2]);
    expect(readPermissionLog({ via: "ios" }, audit)).toHaveLength(1);

    const stats = permissionStats({ since: 0 }, audit, 10);
    expect(stats.total).toBe(4);
    expect(stats.byDecision).toEqual({ approved: 1, asked: 1, denied: 1, closed: 0, answered: 1 });
    expect(stats.byAgent[0]).toMatchObject({ agentId: "a2", agentName: "Satie", total: 3 });
    expect(stats.byRule.map((rule) => rule.rule)).toContain("Bash(rm -rf:*)");
    expect(stats.byVia).toEqual(expect.arrayContaining([{ via: "watcher", total: 1 }, { via: "ios", total: 1 }]));
  });
});

describe("rotation", () => {
  test("rolls the live file into a gzipped segment the reader still sees, and prunes segments past retention", () => {
    const { audit } = scratch();
    for (let index = 0; index < 20; index++) appendContinuationAudit(line({ at: index }), audit);
    rotateContinuationAudit(audit, { maxBytes: 100, now: Date.UTC(2026, 10, 27) });
    expect(rolledContinuationAuditFiles(audit)).toHaveLength(1);
    appendContinuationAudit(line({ at: 99 }), audit);
    expect(readPermissionLog({ limit: 100 }, audit)).toHaveLength(21);

    const [segment] = rolledContinuationAuditFiles(audit);
    const old = (Date.now() - 50 * 86_400_000) / 1000;
    utimesSync(segment!, old, old);
    for (let index = 0; index < 20; index++) appendContinuationAudit(line({ at: 100 + index }), audit);
    rotateContinuationAudit(audit, { maxBytes: 100 });
    const left = rolledContinuationAuditFiles(audit);
    expect(left).toHaveLength(1);
    expect(left[0]).not.toBe(segment);
  });

  test("a small file is left alone", () => {
    const { audit } = scratch();
    appendContinuationAudit(line({}), audit);
    rotateContinuationAudit(audit);
    expect(readdirSync(join(audit, ".."))).toEqual(["continuation-audit.jsonl"]);
  });
});

describe("rule writes and the dry run", () => {
  test("approve things like this lists the records a rule matches, and where an ask or deny still wins", () => {
    const { audit, policy } = scratch();
    writeFileSync(policy, JSON.stringify({ version: 1, grants: [{ scope: "project", path: project, level: "workspace" }] }));
    appendContinuationAudit(line({ at: 1, outcome: "asked", decision: "asked", command: "bun run site:build" }), audit);
    appendContinuationAudit(line({ at: 2, outcome: "asked", decision: "asked", command: "bun run build && git push" }), audit);
    appendContinuationAudit(line({ at: 3, outcome: "asked", decision: "asked", command: "git push origin main" }), audit);
    const allow = dryRunPermissionRule({ list: "allow", rule: "Bash(bun run *build)" }, loadContinuationPolicy(policy), audit);
    expect(allow.matches.map((row) => row.command)).toEqual(["bun run site:build"]);
    expect(allow.matches[0]?.wouldBe).toBe("allow");

    const push = dryRunPermissionRule({ list: "allow", rule: "Bash(git push:*)" }, loadContinuationPolicy(policy), audit);
    expect(push.matches[0]).toMatchObject({ wouldBe: "unchanged", shadowedBy: { rule: "Bash(git push:*)", list: "ask" } });
  });

  test("a dry run shows an allow that lifts a default deny, and the record labels it", () => {
    const { audit, policy } = scratch();
    writeFileSync(policy, JSON.stringify({ version: 1, grants: [{ scope: "project", path: project, level: "workspace" }] }));
    appendContinuationAudit(line({ at: 1, outcome: "denied", decision: "denied", command: "rm -rf ./dist", rule: "Bash(rm -rf:*)", list: "deny" }), audit);
    appendContinuationAudit(line({ at: 2, outcome: "denied", decision: "denied", command: "rm -rf ./src", rule: "Bash(rm -rf:*)", list: "deny" }), audit);
    const narrow = dryRunPermissionRule({ list: "allow", rule: "Bash(rm -rf ./dist:*)", project }, loadContinuationPolicy(policy), audit);
    expect(narrow.matches).toHaveLength(1);
    expect(narrow.matches[0]).toMatchObject({
      command: "rm -rf ./dist", wouldBe: "allow", overrides: ["Bash(rm -rf:*)"],
      wouldBeLabel: "allow Bash(rm -rf ./dist:*) (overrides default deny Bash(rm -rf:*))",
    });
    const broad = dryRunPermissionRule({ list: "allow", rule: "Bash(*)", project }, loadContinuationPolicy(policy), audit);
    expect(broad.matches.map((row) => row.shadowedBy?.rule)).toEqual(["Bash(rm -rf:*)", "Bash(rm -rf:*)"]);

    appendContinuationAudit(line({ at: 3, rule: "Bash(rm -rf ./dist:*)", list: "allow", overrides: ["Bash(rm -rf:*)"], command: "rm -rf ./dist" }), audit);
    expect(readPermissionLog({ since: 3 }, audit)[0]?.label).toBe("allow Bash(rm -rf ./dist:*) (overrides default deny Bash(rm -rf:*))");
    expect(readPermissionLog({ since: 2, until: 2 }, audit)[0]?.label).toBe("deny Bash(rm -rf:*)");
  });

  test("the first ask rule written keeps the default asks; a project rule goes on its grant", () => {
    const { audit, policy } = scratch();
    writeFileSync(policy, JSON.stringify({ version: 1, allowModel: false, grants: [{ scope: "project", path: project, level: "workspace" }] }));
    expect(appendPermissionRule({ list: "ask", rule: "Bash(npm publish:*)" }, policy, audit).added).toBe(true);
    expect(appendPermissionRule({ list: "ask", rule: "Bash(npm publish:*)" }, policy, audit).added).toBe(false);
    appendPermissionRule({ list: "allow", rule: "Bash(make preview)", project }, policy, audit);
    appendPermissionRule({ list: "allow", rule: "Bash(make lint)", project: "/work/other" }, policy, audit);
    const raw = JSON.parse(readFileSync(policy, "utf8"));
    expect(raw.permissions.ask).toEqual([...DEFAULT_PERMISSION_RULES.ask, "Bash(npm publish:*)"]);
    expect(raw.grants[0]).toMatchObject({ level: "workspace", permissions: { allow: ["Bash(make preview)"] } });
    // A project without a grant gets one at `ask`: the rule, and nothing else, changes.
    expect(raw.grants[1]).toEqual({ scope: "project", path: "/work/other", level: "ask", permissions: { allow: ["Bash(make lint)"] } });
    const view = permissionRulesView(loadContinuationPolicy(policy), policy);
    expect(view.scopes.find((scope) => scope.scope === "policy")?.lists.deny[0]).toEqual({ rule: "Bash(rm -rf:*)", builtin: true });
  });

  test("refuses a malformed rule, an unknown list, a relative project, and a file it cannot read", () => {
    const { audit, policy } = scratch();
    expect(() => appendPermissionRule({ list: "allow", rule: "Bash(" }, policy, audit)).toThrow("Tool(pattern)");
    expect(() => appendPermissionRule({ list: "always" as never, rule: "Bash" }, policy, audit)).toThrow("allow, ask or deny");
    expect(() => appendPermissionRule({ list: "allow", rule: "Bash", project: "app" }, policy, audit)).toThrow("absolute");
    writeFileSync(policy, "{ not json");
    expect(() => appendPermissionRule({ list: "ask", rule: "Bash(curl:*)" }, policy, audit)).toThrow("not valid JSON");
  });
});
