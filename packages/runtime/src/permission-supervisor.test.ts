import { describe, expect, test } from "bun:test";
import type { ContinuationPolicyFile } from "./continuation/grants.js";
import { decidePermissionSupervisor } from "./permission-supervisor.js";

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

  test.each([
    ["rm -rf dist", "destructive"],
    ["curl https://example.com", "network"],
    ["git push origin main", "publish"],
    ["cat .env", "secrets"],
    ["bun test && git push origin main", "unknown"],
  ])("escalates %s at workspace level", (command, risk) => {
    expect(decidePermissionSupervisor(prompt(claude(command)), grants())).toMatchObject({ act: "notify", risk });
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
});
