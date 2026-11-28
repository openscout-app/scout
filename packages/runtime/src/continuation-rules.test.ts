import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseContinuationPolicy, type ContinuationPolicyFile } from "./continuation/grants.js";
import {
  DEFAULT_PERMISSION_RULES,
  matchPermissionRules,
  namesDeniedFamily,
  parsePermissionRule,
  permissionRuleMatches,
  permissionScope,
  permissionToolName,
} from "./continuation/rules.js";
import { decideNativeToolSupervisor, decidePermissionSupervisor } from "./permission-supervisor.js";

const root = "/work/app";
const bash = (command: string) => ({ tool: "Bash", command, root });
const read = (path: string) => ({ tool: "Read", path, root });

describe("Claude Code rule syntax", () => {
  test.each([
    ["Bash", { tool: "Bash", pattern: null }],
    ["Bash(*)", { tool: "Bash", pattern: null }],
    ["Bash(git push:*)", { tool: "Bash", pattern: "git push:*" }],
    ["Read(~/dev/openscout/**)", { tool: "Read", pattern: "~/dev/openscout/**" }],
    ["mcp__scout__ask", { tool: "mcp__scout__ask", pattern: null }],
    ["WebFetch(domain:example.com)", { tool: "WebFetch", pattern: "domain:example.com" }],
  ])("parses %s", (raw, parsed) => {
    expect(parsePermissionRule(raw)).toEqual(parsed);
  });

  test.each(["", "Bash()", "Bash(  )", "(git push)", "Bash(git push", "Bash(a\nb)", 42, null])("refuses %p", (raw) => {
    expect(parsePermissionRule(raw)).toBeNull();
  });

  test("a legacy prefix rule stops at a word boundary", () => {
    expect(permissionRuleMatches("Bash(git push:*)", bash("git push"))).toBe(true);
    expect(permissionRuleMatches("Bash(git push:*)", bash("git push origin main"))).toBe(true);
    expect(permissionRuleMatches("Bash(git push:*)", bash("git pushx"))).toBe(false);
    expect(permissionRuleMatches("Bash(git push:*)", bash("echo git push"))).toBe(false);
  });

  test("a wildcard matches any text, and a trailing ` *` also covers the bare command", () => {
    expect(permissionRuleMatches("Bash(bun run *build)", bash("bun run landing:build"))).toBe(true);
    expect(permissionRuleMatches("Bash(bun run *build)", bash("bun run build"))).toBe(true);
    expect(permissionRuleMatches("Bash(bun run *build)", bash("bun run build --watch"))).toBe(false);
    expect(permissionRuleMatches("Bash(ls *)", bash("ls"))).toBe(true);
    expect(permissionRuleMatches("Bash(ls *)", bash("lsof"))).toBe(false);
    expect(permissionRuleMatches("Bash(git push * --force*)", bash("git push origin main --force-with-lease"))).toBe(true);
  });

  test("a command under the home folder also reads as ~/", () => {
    expect(permissionRuleMatches("Bash(cat ~/notes.txt)", bash(`cat ${homedir()}/notes.txt`))).toBe(true);
  });

  test("paths use Claude Code's forms", () => {
    const home = homedir();
    expect(permissionRuleMatches("Read(~/dev/openscout/**)", read(`${home}/dev/openscout/scout/a.ts`))).toBe(true);
    expect(permissionRuleMatches("Read(~/dev/openscout/**)", read(`${home}/dev/other/a.ts`))).toBe(false);
    expect(permissionRuleMatches("Read(//**/.env)", read("/anywhere/deep/.env"))).toBe(true);
    expect(permissionRuleMatches("Read(//**/.env)", read("/anywhere/.envrc"))).toBe(false);
    expect(permissionRuleMatches("Read(//**/.env.*)", read("/anywhere/.env.local"))).toBe(true);
    expect(permissionRuleMatches("Read(/src/**)", read("src/a/b.ts"))).toBe(true);
    expect(permissionRuleMatches("Read(src/*.ts)", read("/work/app/src/a.ts"))).toBe(true);
    expect(permissionRuleMatches("Read(src/*.ts)", read("/work/app/src/a/b.ts"))).toBe(false);
    expect(permissionRuleMatches("Read(.env)", read("/work/app/pkg/.env"))).toBe(true);
    expect(permissionRuleMatches("Read(.env)", read("/elsewhere/.env"))).toBe(false);
  });

  test("Edit rules cover writes; Read rules do not cover edits", () => {
    expect(permissionRuleMatches("Edit(src/**)", { tool: "Write", path: "src/a.ts", root })).toBe(true);
    expect(permissionRuleMatches("Read(src/**)", { tool: "Edit", path: "src/a.ts", root })).toBe(false);
  });

  test("an MCP rule names a server or one tool", () => {
    expect(permissionRuleMatches("mcp__scout", { tool: "mcp__scout__ask", root })).toBe(true);
    expect(permissionRuleMatches("mcp__scout__*", { tool: "mcp__scout__reply", root })).toBe(true);
    expect(permissionRuleMatches("mcp__scout__ask", { tool: "mcp__scout__reply", root })).toBe(false);
    expect(permissionRuleMatches("mcp__scout", { tool: "mcp__scoutx__ask", root })).toBe(false);
  });

  test("WebFetch domain rules match the host and its subdomains", () => {
    expect(permissionRuleMatches("WebFetch(domain:example.com)", { tool: "WebFetch", url: "https://docs.example.com/x", root })).toBe(true);
    expect(permissionRuleMatches("WebFetch(domain:example.com)", { tool: "WebFetch", url: "https://example.com.evil.io", root })).toBe(false);
  });

  test("harness tool names map to Claude Code's", () => {
    expect(permissionToolName("run_command")).toBe("Bash");
    expect(permissionToolName("view_file")).toBe("Read");
    expect(permissionToolName("edit_file")).toBe("Edit");
    expect(permissionToolName("write_file")).toBe("Write");
    expect(permissionToolName("mcp__scout__ask")).toBe("mcp__scout__ask");
  });
});

describe("precedence", () => {
  const scope = permissionScope("policy", {
    allow: ["Bash(git:*)", "Bash(bun test:*)"],
    ask: ["Bash(git push:*)"],
    deny: ["Bash(git push --force:*)"],
  }, { deny: false, ask: false, allow: false });

  test("deny beats ask, and ask beats allow", () => {
    expect(matchPermissionRules([scope], bash("git push --force origin main"))).toMatchObject({ list: "deny" });
    expect(matchPermissionRules([scope], bash("git push origin main"))).toMatchObject({ list: "ask", rule: "Bash(git push:*)" });
    expect(matchPermissionRules([scope], bash("git status"))).toMatchObject({ list: "allow", rule: "Bash(git:*)" });
    expect(matchPermissionRules([scope], bash("cargo test"))).toBeNull();
  });

  test("deny and ask read every part of a chained command; allow never reads one", () => {
    expect(matchPermissionRules([scope], bash("bun test && git push --force"))).toMatchObject({ list: "deny" });
    expect(matchPermissionRules([scope], bash("FOO=1 git push origin"))).toMatchObject({ list: "ask" });
    expect(matchPermissionRules([scope], bash("bun test; rm x"))).toBeNull();
  });

  test("a deny the operator wrote in any scope beats an allow in a narrower one", () => {
    const project = permissionScope("project:/work/app", { allow: ["Bash(sudo:*)"] }, { deny: false, ask: false, allow: false });
    const policy = permissionScope("policy", { deny: ["Bash(sudo:*)"] }, { deny: true, ask: true, allow: false });
    expect(matchPermissionRules([project, policy], bash("sudo ls"))).toMatchObject({ list: "deny", scope: "policy", builtin: false });
    // Against the built-in sudo deny, an allow lifts it only for the exact words it names.
    const defaults = permissionScope("policy", undefined, { deny: true, ask: true, allow: false });
    expect(matchPermissionRules([project, defaults], bash("sudo ls"))).toMatchObject({ list: "deny", builtin: true });
    const exact = permissionScope("project:/work/app", { allow: ["Bash(sudo ls)"] }, { deny: false, ask: false, allow: false });
    expect(matchPermissionRules([exact, defaults], bash("sudo ls"))).toMatchObject({ list: "allow", overrides: ["Bash(sudo:*)"] });
  });
});

describe("policy file", () => {
  test("reads permissions at the top and per project grant; malformed rules are dropped", () => {
    const policy = parseContinuationPolicy({
      version: 1,
      grants: [{ scope: "project", path: "/work/app", level: "workspace", permissions: { allow: ["Bash(make:*)", "Bash("] } }],
      permissions: { deny: ["Bash(rm:*)", 7], defaultMode: "auto" },
    });
    expect(policy.grants[0]).toMatchObject({ permissions: { allow: ["Bash(make:*)"] } });
    expect(policy.permissions).toEqual({ deny: ["Bash(rm:*)"] });
    expect(policy.defaultMode).toBe("auto");
  });

  test("an unknown defaultMode is ignored", () => {
    expect(parseContinuationPolicy({ version: 1, grants: [], permissions: { defaultMode: "bypassPermissions" } }).defaultMode).toBeUndefined();
  });

  test("a project grant's allow applies inside it only", () => {
    const policy = parseContinuationPolicy({
      version: 1,
      grants: [{ scope: "project", path: "/work/app", level: "ask", permissions: { allow: ["Bash(make deploy-preview)"] } }],
    });
    const decide = (projectRoot: string) => decideNativeToolSupervisor({
      projectRoot, cwd: projectRoot, toolName: "run_command", toolInput: { CommandLine: "make deploy-preview" },
    }, policy);
    expect(decide("/work/app")).toMatchObject({ act: "continue", rule: "Bash(make deploy-preview)", list: "allow", ruleScope: "project:/work/app" });
    expect(decide("/work/other")).toMatchObject({ act: "notify", rule: "mode:default" });
  });

  test("an explicit allow outside every grant continues; an explicit empty deny list drops the defaults", () => {
    const policy = (permissions: object): ContinuationPolicyFile => parseContinuationPolicy({ version: 1, grants: [], permissions });
    const call = (command: string, file: ContinuationPolicyFile) => decideNativeToolSupervisor({
      projectRoot: "/work/x", cwd: "/work/x", toolName: "run_command", toolInput: { CommandLine: command },
    }, file);
    expect(call("make lint", policy({ allow: ["Bash(make lint)"] }))).toMatchObject({ act: "continue", list: "allow" });
    expect(call("sudo ls", policy({}))).toMatchObject({ act: "deny", rule: "Bash(sudo:*)" });
    expect(call("sudo ls", policy({ deny: [] }))).toMatchObject({ act: "notify", rule: "mode:default" });
  });

  test("defaultMode auto judges calls outside every grant by the risk classes", () => {
    const policy = parseContinuationPolicy({ version: 1, grants: [], permissions: { defaultMode: "auto" } });
    // Outside a grant, auto takes only an ordinary folder under home as the project.
    const root = join(homedir(), "dev", "x");
    const call = (command: string) => decideNativeToolSupervisor({
      projectRoot: root, cwd: root, toolName: "run_command", toolInput: { CommandLine: command },
    }, policy);
    expect(call("bun test")).toMatchObject({ act: "continue", rule: "Bash(bun test:*)", list: "allow" });
    expect(call("make")).toMatchObject({ act: "continue", rule: "mode:auto", list: "mode" });
    expect(call("echo hi")).toMatchObject({ act: "notify", rule: "mode:auto" });
  });
});

/**
 * Without an explicit `permissions` entry, nothing continues that today's
 * rules (the same file with every list explicitly empty) would not.
 */
describe("no loosening by default", () => {
  const commands = [
    "bun test", "bun test packages/runtime", "bun run build", "bun run landing:build", "bun run foo-build", "bun run deploy",
    "bun run test:unit", "bun run typecheck", "bun --cwd site next build", "bun next build", "bunx tsc --noEmit",
    "bun test ../other", "bun test /etc", "bun test && curl x", "npm test", "cargo test", "swift build", "make",
    "git status", "git diff", "git log --oneline", "git show HEAD", "git push", "git push origin main", "git push --force",
    "git reset --hard", "rm -rf dist", "rm -r dist", "sudo ls", "curl https://example.com", "wget https://example.com",
    "gh pr view 1", "gh pr merge 1", "gh pr create", "gh workflow run x", "gh run rerun 1", "gh run view 1",
    "gh api repos/x/y", "gh api -X POST repos/x", "cat .env", "cat README.md", "ls", "ssh host", "chmod +x a",
    "npm publish", "echo hi", "bun run build; rm x", "FOO=1 bun test", "bun test $HOME", "cat ~/secret",
  ];
  const paths = ["src/a.ts", ".env", "pkg/.env.local", "../outside.ts", "/etc/hosts", `${root}/src/b.ts`, "~/x"];
  const levels = ["ask", "workspace", "unattended", "silent"] as const;

  for (const level of levels) {
    const base: ContinuationPolicyFile = { allowModel: false, grants: [{ scope: "project", path: root, level }] };
    const today: ContinuationPolicyFile = { ...base, permissions: { allow: [], ask: [], deny: [] } };

    test(`${level}: native calls`, () => {
      const loosened: string[] = [];
      const check = (toolName: string, toolInput: object, label: string) => {
        const now = decideNativeToolSupervisor({ projectRoot: root, cwd: root, toolName, toolInput }, base);
        const before = decideNativeToolSupervisor({ projectRoot: root, cwd: root, toolName, toolInput }, today);
        if (now.act === "continue" && before.act !== "continue") loosened.push(label);
      };
      for (const command of commands) check("run_command", { CommandLine: command }, command);
      for (const path of paths) for (const tool of ["read_file", "edit_file", "write_file"]) check(tool, { Path: path }, `${tool} ${path}`);
      expect(loosened).toEqual([]);
    });

    test(`${level}: Claude dialogs and Codex approvals`, () => {
      const loosened: string[] = [];
      for (const command of commands) {
        for (const text of [
          `Bash command\n ${command}\nDo you want to proceed?\n ❯ 1. Yes\n   2. No\nEsc to cancel`,
          JSON.stringify({ method: "item/commandExecution/requestApproval", command, cwd: root }),
        ]) {
          const ask = { projectRoot: root, text, decisions: ["once", "deny"] as Array<"once" | "deny"> };
          if (decidePermissionSupervisor(ask, base).act === "continue" && decidePermissionSupervisor(ask, today).act !== "continue") {
            loosened.push(command);
          }
        }
      }
      expect(loosened).toEqual([]);
    });
  }

  test("with no grant and no file entry, nothing continues", () => {
    const empty: ContinuationPolicyFile = { allowModel: false, grants: [] };
    for (const command of commands) {
      expect(decideNativeToolSupervisor({ projectRoot: root, cwd: root, toolName: "run_command", toolInput: { CommandLine: command } }, empty).act)
        .not.toBe("continue");
    }
  });

  test("every default rule parses", () => {
    for (const list of ["allow", "ask", "deny"] as const) {
      for (const rule of DEFAULT_PERMISSION_RULES[list]) expect(parsePermissionRule(rule)).not.toBeNull();
    }
  });
});

describe("an operator allow over a built-in deny", () => {
  const native = (command: string, policy: ContinuationPolicyFile, cwd = root) =>
    decideNativeToolSupervisor({ projectRoot: cwd, cwd, toolName: "Bash", toolInput: { command } }, policy);
  const policy = (grant: Record<string, unknown> = {}, top?: Record<string, unknown>) => parseContinuationPolicy({
    version: 1,
    grants: [{ scope: "project", path: root, level: "workspace", ...grant }],
    ...(top ? { permissions: top } : {}),
  });

  test("with no allow rule, the default deny still wins", () => {
    expect(native("rm -rf ./dist", policy())).toMatchObject({ act: "deny", rule: "Bash(rm -rf:*)", list: "deny" });
    expect(native("sudo ls", policy())).toMatchObject({ act: "deny", rule: "Bash(sudo:*)" });
  });

  test("an allow that names the family lifts the default deny for what it matches, and the record says so", () => {
    const lifted = policy({ permissions: { allow: ["Bash(rm -rf ./dist:*)"] } });
    expect(native("rm -rf ./dist", lifted)).toMatchObject({
      act: "continue", rule: "Bash(rm -rf ./dist:*)", list: "allow", ruleScope: `project:${root}`, overrides: ["Bash(rm -rf:*)"],
      reason: "allow Bash(rm -rf ./dist:*) (overrides default deny Bash(rm -rf:*))",
    });
    // Only for that path, and only inside that project.
    expect(native("rm -rf ./src", lifted)).toMatchObject({ act: "deny", rule: "Bash(rm -rf:*)" });
    expect(native("rm -rf ./dist", lifted, "/work/other")).toMatchObject({ act: "deny", rule: "Bash(rm -rf:*)" });
    // A chained command is never lifted: an allow does not read one.
    expect(native("rm -rf ./dist && rm -rf ~", lifted)).toMatchObject({ act: "deny" });
    // `sudo rm -rf ./dist` meets the sudo deny; an allow that spells it out lifts that one.
    expect(native("sudo rm -rf ./dist", policy({ permissions: { allow: ["Bash(sudo rm -rf ./dist)"] } }))).toMatchObject({ act: "continue", overrides: expect.arrayContaining(["Bash(sudo:*)", "Bash(rm -rf:*)"]) });
  });

  test("a deny the operator wrote beats any operator allow", () => {
    const both = policy({ permissions: { allow: ["Bash(rm -rf ./dist:*)"] } }, { deny: ["Bash(rm -rf:*)"] });
    expect(native("rm -rf ./dist", both)).toMatchObject({ act: "deny", rule: "Bash(rm -rf:*)", ruleScope: "policy" });
    const sameScope = policy({ permissions: { allow: ["Bash(make preview)"], deny: ["Bash(make preview)"] } });
    expect(native("make preview", sameScope)).toMatchObject({ act: "deny", rule: "Bash(make preview)" });
  });

  test("a broad allow does not lift a default deny", () => {
    for (const allow of ["Bash(*)", "Bash", "Bash(rm:*)", "Bash(rm *)", "Bash(* -rf:*)"]) {
      expect(native("rm -rf ./dist", policy({ permissions: { allow: [allow] } }))).toMatchObject({ act: "deny", rule: "Bash(rm -rf:*)" });
    }
    expect(native("git push origin main --force", policy({ permissions: { allow: ["Bash(git push:*)"] } }))).toMatchObject({ act: "deny", list: "deny" });
  });

  test("an ask rule still holds a call whose deny was lifted", () => {
    const lifted = policy({ permissions: { allow: ["Bash(rm -rf ./dist:*)"], ask: ["Bash(rm:*)"] } });
    expect(native("rm -rf ./dist", lifted)).toMatchObject({ act: "notify", list: "ask", rule: "Bash(rm:*)" });
  });

  test("names the family: fixed text starts with the command and spells every fixed word", () => {
    expect(namesDeniedFamily("Bash(rm -rf ./dist:*)", "Bash(rm -rf:*)")).toBe(true);
    expect(namesDeniedFamily("Bash(rm -rf:*)", "Bash(rm -rf:*)")).toBe(true);
    expect(namesDeniedFamily("Bash(git push origin --force-with-lease)", "Bash(git push * --force*)")).toBe(true);
    expect(namesDeniedFamily("Bash(*)", "Bash(rm -rf:*)")).toBe(false);
    expect(namesDeniedFamily("Bash", "Bash(rm -rf:*)")).toBe(false);
    expect(namesDeniedFamily("Bash(rm:*)", "Bash(rm -rf:*)")).toBe(false);
    expect(namesDeniedFamily("Bash(echo rm -rf)", "Bash(rm -rf:*)")).toBe(false);
    expect(namesDeniedFamily("Bash(git push:*)", "Bash(git push * --force*)")).toBe(false);
    expect(namesDeniedFamily("Read(./.env.example)", "Read(//**/.env.*)")).toBe(true);
    expect(namesDeniedFamily("Read(**)", "Read(//**/.env)")).toBe(false);
    expect(namesDeniedFamily("Read", "Read(//**/.env)")).toBe(false);
    expect(namesDeniedFamily("Edit(./.env)", "Read(//**/.env)")).toBe(false);
  });

  test("a path allow lifts the .env deny for that file only", () => {
    const lifted = policy({ permissions: { allow: ["Read(./.env.example)"] } });
    const call = (path: string) => decideNativeToolSupervisor({ projectRoot: root, cwd: root, toolName: "Read", toolInput: { file_path: path } }, lifted);
    expect(call(`${root}/.env.example`)).toMatchObject({ act: "continue", overrides: ["Read(//**/.env.*)"] });
    expect(call(`${root}/.env.local`)).toMatchObject({ act: "deny" });
  });
});
