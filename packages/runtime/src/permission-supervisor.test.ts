import { describe, expect, test } from "bun:test";
import type { ContinuationPolicyFile } from "./continuation/grants.js";
import { decideNativeToolSupervisor, decidePermissionSupervisor } from "./permission-supervisor.js";

const project = "/work/app";
const grants = (level: "ask" | "workspace" | "unattended" | "silent" = "workspace"): ContinuationPolicyFile => ({
  allowModel: false,
  grants: [{ scope: "project", path: project, level }],
});

function prompt(text: string, decisions: Array<"once" | "project" | "deny"> = ["once", "deny"]) {
  return { projectRoot: project, text, decisions };
}

function claude(command: string, header = "Bash command") {
  return `${header}\n ${command}\nThis command requires approval\nDo you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again in this project\n   3. No\nEsc to cancel`;
}

function codex(command: unknown, cwd?: unknown) {
  return JSON.stringify({
    method: "item/commandExecution/requestApproval",
    threadId: "thread-1",
    turnId: "turn-1",
    command,
    ...(cwd !== undefined ? { cwd } : {}),
  }, null, 2);
}

describe("permission supervisor", () => {
  test("does nothing without an explicit project grant", () => {
    expect(decidePermissionSupervisor(prompt(claude("bun test")), { allowModel: false, grants: [] })).toMatchObject({
      act: "notify", reason: "no project continuation grant",
    });
  });

  test("continues a local test once under a workspace grant", () => {
    expect(decidePermissionSupervisor(prompt(claude("bun test packages/runtime")), grants())).toMatchObject({
      act: "continue", risk: "workspace", grant: `project:${project}`,
    });
  });

  test("continues a plain relative edit but not a sensitive or outside path", () => {
    expect(decidePermissionSupervisor(prompt(claude("src/app.ts", "Edit file")), grants()).act).toBe("continue");
    expect(decidePermissionSupervisor(prompt(claude(".env", "Edit file")), grants())).toMatchObject({ act: "notify", risk: "secrets" });
    expect(decidePermissionSupervisor(prompt(claude("../outside.ts", "Edit file")), grants()).act).toBe("notify");
  });

  test("denies rm -rf by the default deny rule at workspace level", () => {
    expect(decidePermissionSupervisor(prompt(claude("rm -rf dist")), grants())).toMatchObject({
      act: "deny", risk: "destructive", rule: "Bash(rm -rf:*)", list: "deny",
    });
  });

  test.each([
    ["rm -r dist", "destructive"],
    ["curl https://example.com", "network"],
    ["git push origin main", "publish"],
    ["bun test && git push origin main", "unknown"],
  ])("escalates %s at workspace level", (command, risk) => {
    expect(decidePermissionSupervisor(prompt(claude(command)), grants())).toMatchObject({ act: "notify", risk });
  });

  test("cat .env meets the built-in .env deny, as a Read would", () => {
    expect(decidePermissionSupervisor(prompt(claude("cat .env")), grants())).toMatchObject({ act: "deny", list: "deny", rule: "Read(//**/.env)", risk: "secrets" });
  });

  test("never turns folder trust into a one-time approval", () => {
    const trust = "Accessing workspace:\n /work/app\nQuick safety check: Is this a project you trust?\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel";
    expect(decidePermissionSupervisor(prompt(trust, ["project", "deny"]), grants())).toMatchObject({
      act: "notify", reason: "one-time approval is not offered",
    });
  });

  test("continues a structured Codex command in the project", () => {
    expect(decidePermissionSupervisor(prompt(codex("bun test packages/runtime", project)), grants())).toMatchObject({
      act: "continue", risk: "workspace",
    });
  });

  test("escalates Codex commands outside the project or with shell syntax", () => {
    expect(decidePermissionSupervisor(prompt(codex("bun test", "/work/outside")), grants()).act).toBe("notify");
    expect(decidePermissionSupervisor(prompt(codex("bun test && git push origin main", project)), grants())).toMatchObject({
      act: "notify", risk: "unknown",
    });
  });

  test("escalates malformed Codex commands and file changes", () => {
    expect(decidePermissionSupervisor(prompt(codex(["bun", "test"], project)), grants()).act).toBe("notify");
    expect(decidePermissionSupervisor(prompt(JSON.stringify({ method: "item/fileChange/requestApproval", filePath: "src/app.ts" })), grants()).act).toBe("notify");
  });

  test("a nested project grant applies below its root, not outside it", () => {
    const nested = decidePermissionSupervisor({ ...prompt(claude("bun test")), projectRoot: `${project}/packages/runtime` }, grants());
    const outside = decidePermissionSupervisor({ ...prompt(claude("bun test")), projectRoot: "/work/other" }, grants());
    expect(nested.act).toBe("continue");
    expect(outside).toMatchObject({ act: "notify", reason: "no project continuation grant" });
  });

  test("a Codex command cannot bypass a narrower working-directory grant", () => {
    const policy: ContinuationPolicyFile = {
      allowModel: false,
      grants: [...grants().grants, { scope: "project", path: `${project}/restricted`, level: "ask" }],
    };
    expect(decidePermissionSupervisor(prompt(codex("bun test", `${project}/restricted`)), policy)).toMatchObject({
      act: "notify", grant: "conflict",
    });
  });

  test.each([
    "make -C/tmp/outside check",
    "grep -f/etc/passwd README.md",
    "bun run ship",
  ])("escalates delegated command %s for Claude and Codex", command => {
    expect(decidePermissionSupervisor(prompt(claude(command)), grants()).act).toBe("notify");
    expect(decidePermissionSupervisor(prompt(codex(command, project)), grants()).act).toBe("notify");
  });

  test("continues named local package scripts", () => {
    expect(decidePermissionSupervisor(prompt(claude("bun run test:unit")), grants()).act).toBe("continue");
    expect(decidePermissionSupervisor(prompt(codex("bun run check:core", project)), grants()).act).toBe("continue");
  });

  test("a Claude command cannot inherit a grant after leaving the project", () => {
    expect(decidePermissionSupervisor({ ...prompt(claude("bun test")), cwd: "/work/outside" }, grants())).toMatchObject({
      act: "notify", reason: "command leaves the granted project",
    });
  });

  test("a Claude command cannot bypass a narrower live-directory grant", () => {
    const policy: ContinuationPolicyFile = {
      allowModel: false,
      grants: [...grants().grants, { scope: "project", path: `${project}/restricted`, level: "ask" }],
    };
    expect(decidePermissionSupervisor({ ...prompt(claude("bun test")), cwd: `${project}/restricted` }, policy)).toMatchObject({
      act: "notify", grant: "conflict",
    });
  });

  test("a Codex command without a working directory stays with the operator", () => {
    expect(decidePermissionSupervisor(prompt(codex("bun test")), grants())).toMatchObject({
      act: "notify", reason: "command has no working directory",
    });
  });

  test("network and publish grants do not permit outside filesystem effects", () => {
    for (const text of [claude("cat https://example.com/../../../../etc/hosts"), codex("cat https://example.com/../../../../etc/hosts", project)]) {
      expect(decidePermissionSupervisor(prompt(text), grants()).act).toBe("notify");
    }
    const networkCommands = [
      "curl -o/tmp/outside https://example.com",
      "curl file:///etc/hosts",
      "curl --output=https://example.com/../../../../tmp/outside https://example.com",
      "curl --output https://example.com/../../../../tmp/outside https://example.com",
      "curl --create-dirs -so https://example.com/../../../../tmp/outside https://example.com",
      "curl --create-dirs --output-dir https://example.com/../../../../tmp --output outside https://example.com",
    ];
    for (const command of networkCommands) {
      for (const text of [claude(command), codex(command, project)]) {
        expect(decidePermissionSupervisor(prompt(text), grants("unattended")).act).toBe("notify");
      }
    }
    for (const command of ["git push /tmp/outside HEAD", "git push file:///tmp/outside HEAD"]) {
      for (const text of [claude(command), codex(command, project)]) {
        expect(decidePermissionSupervisor(prompt(text), grants("silent")).act).toBe("notify");
      }
    }
  });

  test("the default ask rules hold network and publish under higher grants", () => {
    expect(decidePermissionSupervisor(prompt(claude("curl https://example.com")), grants("unattended"))).toMatchObject({
      act: "notify", rule: "Bash(curl:*)", list: "ask",
    });
    expect(decidePermissionSupervisor(prompt(codex("git push origin HEAD", project)), grants("silent"))).toMatchObject({
      act: "notify", rule: "Bash(git push:*)", list: "ask",
    });
  });

  test("higher grants retain their in-project network and publish meaning once the ask list is emptied", () => {
    const grants = (level: "unattended" | "silent"): ContinuationPolicyFile => ({
      allowModel: false,
      grants: [{ scope: "project", path: project, level }],
      permissions: { ask: [] },
    });
    const networkCommands = [
      "curl -o dist/result https://example.com",
      "curl https://example.com/../../../../tmp/outside",
    ];
    for (const command of networkCommands) {
      expect(decidePermissionSupervisor(prompt(claude(command)), grants("unattended")).act).toBe("continue");
      expect(decidePermissionSupervisor(prompt(codex(command, project)), grants("unattended")).act).toBe("continue");
    }
    for (const command of ["git push origin HEAD", "git push https://example.com/repo.git HEAD"]) {
      expect(decidePermissionSupervisor(prompt(claude(command)), grants("silent")).act).toBe("continue");
      expect(decidePermissionSupervisor(prompt(codex(command, project)), grants("silent")).act).toBe("continue");
    }
  });

  test("decideNativeToolSupervisor governs Antigravity tool calls by project continuation policy", () => {
    expect(decideNativeToolSupervisor({
      projectRoot: project,
      toolName: "run_command",
      toolInput: { CommandLine: "bun test packages/runtime" },
    }, grants("ask")).act).toBe("notify");

    expect(decideNativeToolSupervisor({
      projectRoot: project,
      toolName: "run_command",
      toolInput: { CommandLine: "bun test packages/runtime" },
    }, grants("workspace"))).toMatchObject({ act: "continue", risk: "workspace" });

    expect(decideNativeToolSupervisor({
      projectRoot: project,
      toolName: "edit_file",
      toolInput: { Path: `${project}/src/index.ts` },
    }, grants("workspace"))).toMatchObject({ act: "continue", risk: "workspace" });

    // Secrets, outside-project files, and destructive commands always escalate.
    expect(decideNativeToolSupervisor({
      projectRoot: project,
      toolName: "edit_file",
      toolInput: { Path: `${project}/.env` },
    }, grants("silent"))).toMatchObject({ act: "notify", risk: "secrets" });

    expect(decideNativeToolSupervisor({
      projectRoot: project,
      toolName: "edit_file",
      toolInput: { Path: "/etc/hosts" },
    }, grants("silent")).act).toBe("notify");

    expect(decideNativeToolSupervisor({
      projectRoot: project,
      toolName: "run_command",
      toolInput: { CommandLine: "rm -rf dist" },
    }, grants("silent"))).toMatchObject({ act: "deny", risk: "destructive", rule: "Bash(rm -rf:*)" });

    expect(decideNativeToolSupervisor({
      projectRoot: project,
      toolName: "run_command",
      toolInput: { CommandLine: "git push origin main" },
    }, grants("workspace")).act).toBe("notify");

    expect(decideNativeToolSupervisor({
      projectRoot: project,
      toolName: "run_command",
      toolInput: { CommandLine: "git push origin main" },
    }, grants("silent"))).toMatchObject({ act: "notify", risk: "publish", rule: "Bash(git push:*)", list: "ask" });

    expect(decideNativeToolSupervisor({
      projectRoot: project,
      toolName: "run_command",
      toolInput: { CommandLine: "git push origin main" },
    }, { ...grants("silent"), permissions: { ask: [] } })).toMatchObject({ act: "continue", risk: "publish", rule: "mode:auto" });
  });

  describe("absolute paths inside the granted project", () => {
    const parent = "/work";
    const parentGrant = (level: "workspace" | "silent" = "workspace", extra: ContinuationPolicyFile["grants"] = []): ContinuationPolicyFile => ({
      allowModel: false,
      grants: [{ scope: "project", path: parent, level }, ...extra],
    });
    const run = (command: string, policy = parentGrant()) => decideNativeToolSupervisor({
      projectRoot: parent, cwd: parent, toolName: "run_command", toolInput: { CommandLine: command },
    }, policy);

    test("continues builds and reads that address a worktree by absolute path", () => {
      for (const command of [
        "bun --cwd /work/app-hero/landing/site next build",
        "bun run --cwd /work/app-hero landing:build",
        "bun test /work/app-hero/packages/runtime",
        "git -C /work/app-hero status --short",
        "cat /work/app-hero/README.md",
      ]) expect(run(command)).toMatchObject({ act: "continue", risk: "workspace", level: "workspace" });
    });

    test("still escalates what workspace never covered", () => {
      for (const command of [
        "git -C /work/app-hero push origin site/hero",
        "bun --cwd /work/app-hero next dev --port 3099",
        "bun /home/agent/scratch/capture.mjs",
        "bun --cwd /work/../etc next build",
        "bun --cwd /elsewhere next build",
        "cat /work/app-hero/.env",
        "cd /work/app-hero && bun run build",
        "bun run --cwd /work/app-hero deploy",
        "git -C /work/app-hero log --output=/tmp/out",
      ]) expect(run(command).act).not.toBe("continue");
    });

    test("a narrower grant below the project keeps its say", () => {
      const policy = parentGrant("workspace", [{ scope: "project", path: "/work/locked", level: "ask" }]);
      expect(run("bun --cwd /work/locked next build", policy).act).toBe("notify");
      expect(run("bun --cwd /work/open next build", policy).act).toBe("continue");
    });

    test("Codex and Claude pane commands get the same reading", () => {
      const codexPrompt = { projectRoot: parent, text: codex("git -C /work/app-hero diff", parent), decisions: ["once", "deny"] as Array<"once" | "deny"> };
      expect(decidePermissionSupervisor(codexPrompt, parentGrant())).toMatchObject({ act: "continue", risk: "workspace" });
      const pane = { projectRoot: parent, text: claude("bun --cwd /work/app-hero next build"), decisions: ["once", "deny"] as Array<"once" | "deny"> };
      expect(decidePermissionSupervisor(pane, parentGrant())).toMatchObject({ act: "continue", risk: "workspace" });
      const panePush = { ...pane, text: claude("git -C /work/app-hero push origin main") };
      expect(decidePermissionSupervisor(panePush, parentGrant()).act).toBe("notify");
    });
  });

  describe("gh under a workspace grant", () => {
    const run = (command: string, level: "workspace" | "silent" = "workspace") => decideNativeToolSupervisor({
      projectRoot: project, cwd: project, toolName: "run_command", toolInput: { CommandLine: command },
    }, grants(level));

    test("continues reads and reversible pull request changes", () => {
      for (const command of [
        "gh pr list --repo arach/scout --state open --limit 50 --json number,title,headRefName",
        "gh pr view 306 --repo arach/scout --json state",
        "gh pr diff 306",
        "gh pr checks 306",
        "gh pr status",
        "gh pr comment 2268 --repo arach/scout --body-file notes/comment.md",
        "gh pr edit 2272 --repo arach/scout --add-label ready",
        "gh pr ready 2268 --repo arach/scout",
        "gh run list --limit 5",
        "gh run view 123 --log",
        "gh issue list",
        "gh issue view 9",
        "gh api repos/arach/scout/pulls",
        "gh api repos/arach/scout/pulls --paginate --jq .total_count",
        "gh api -X GET repos/arach/scout/actions/runs",
        "gh api --method=GET repos/arach/scout/issues",
      ]) expect(run(command), command).toMatchObject({ act: "continue", risk: "workspace" });
    });

    test("keeps publishing, CI triggers, and writes escalating", () => {
      for (const command of [
        "git push origin main",
        "gh pr create --repo arach/scout --base main --fill",
        "gh pr merge 306 --squash",
        "gh pr close 306",
        "gh workflow run ci.yml",
        "gh run rerun 123",
        "gh run cancel 123",
        "gh api -X POST repos/arach/scout/issues",
        "gh api --method=PATCH repos/arach/scout/pulls/1",
        "gh api repos/arach/scout/issues -f title=x",
        "gh api repos/arach/scout/issues --input body.json",
        "gh api -H X-HTTP-Method-Override:DELETE repos/arach/scout/issues/1",
        "gh api graphql",
        "gh api repos/a/b repos/c/d",
        "gh pr comment 1 --body-file /tmp/outside.md",
        "gh repo delete arach/scout",
        "gh secret list",
      ]) expect(run(command).act, command).toBe("notify");
    });

    test("higher levels do not turn CI triggers or merges into answers", () => {
      for (const command of ["gh workflow run ci.yml", "gh run rerun 123", "gh pr merge 306", "gh api -X DELETE repos/a/b"]) {
        expect(run(command, "silent").act, command).toBe("notify");
      }
    });
  });
});

