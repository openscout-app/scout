import { describe, expect, test } from "bun:test";

import { parseHooksCommandOptions, renderHooksResult } from "./hooks.ts";

const hook = {
  harness: "claude" as const, hook: "permission-request" as const, event: "PermissionRequest" as const,
  settingsPath: "/home/.claude/settings.json", wrapperPath: "/support/hooks/openscout-claude-permission-request.sh",
  command: "'/support/hooks/openscout-claude-permission-request.sh'", entries: [],
};

describe("scout hooks", () => {
  test("status is the default; apply and remove are the verbs", () => {
    expect(parseHooksCommandOptions([])).toMatchObject({ command: "status", json: false });
    expect(parseHooksCommandOptions(["apply", "--json"])).toMatchObject({ command: "apply", json: true });
    expect(parseHooksCommandOptions(["remove"])).toMatchObject({ command: "remove" });
    expect(parseHooksCommandOptions(["--help"]).help).toBe(true);
    expect(() => parseHooksCommandOptions(["install"])).toThrow("Unknown hooks command: install");
    expect(() => parseHooksCommandOptions(["apply", "remove"])).toThrow();
    expect(() => parseHooksCommandOptions(["--force"])).toThrow("Unknown hooks option: --force");
  });

  test("results read as what changed", () => {
    expect(renderHooksResult({ action: "apply", outcome: "changed", hooks: [{ ...hook, state: "applied" }] }))
      .toStartWith("Applied Scout's hooks.\nClaude Code PermissionRequest: applied");
    expect(renderHooksResult({ action: "remove", outcome: "unchanged", hooks: [{ ...hook, state: "absent" }] }))
      .toStartWith("Nothing to remove.");
    expect(renderHooksResult({ action: "apply", outcome: "skipped", reason: "non-prod-instance", hooks: [{ ...hook, state: "absent" }] }))
      .toContain("OPENSCOUT_HOOKS_INSTANCE");
  });
});
