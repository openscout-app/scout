import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLAUDE_PERMISSION_HOOK_WRAPPER,
  HarnessHooks,
  HarnessHooksError,
  claudePermissionHookWrapper,
  scoutClaudeHookCommands,
  shellQuote,
  withoutScoutClaudeHooks,
  withScoutClaudeHooks,
} from "./harness-hooks.js";

const ORCA = { hooks: [{ type: "command", command: "/opt/orca/bin/orca-hook permission", timeout: 30 }] };

/** A settings file shaped like a real one: other keys, other hooks, Orca's PermissionRequest. */
const ORIGINAL = JSON.stringify({
  model: "opus",
  statusLine: { type: "command", command: "/x/statusline.sh", padding: 0 },
  hooks: {
    SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }],
    PermissionRequest: [ORCA],
  },
  permissions: { allow: ["Bash(ls:*)"] },
}, null, 2) + "\n";

const CMD = `'/s/${CLAUDE_PERMISSION_HOOK_WRAPPER}'`;
let dir: string;
let settingsPath: string;
let wrapperPath: string;

function hooks(overrides: Partial<ConstructorParameters<typeof HarnessHooks>[0]> = {}): HarnessHooks {
  return new HarnessHooks({
    settingsPath, wrapperPath, instance: "prod", instanceOverride: "",
    scoutInvocation: () => "'/usr/local/bin/scout'", managedInstalls: false, ...overrides,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scout-hooks-"));
  settingsPath = join(dir, "home", ".claude", "settings.json");
  wrapperPath = join(dir, "support", "runtime", "hooks", CLAUDE_PERMISSION_HOOK_WRAPPER);
  await mkdir(join(dir, "home", ".claude"), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("settings edits", () => {
  test("apply adds one entry beside Orca's, and remove gives back the same object", () => {
    const original = JSON.parse(ORIGINAL);
    const applied = withScoutClaudeHooks(original, CMD);
    expect((applied.hooks as any).PermissionRequest).toEqual([ORCA, { hooks: [{ type: "command", command: CMD }] }]);
    expect(withScoutClaudeHooks(applied, CMD)).toBe(applied);
    expect(withoutScoutClaudeHooks(applied).settings).toEqual(original);
  });

  test("remove drops only what its own removal emptied", () => {
    const settings = {
      hooks: {
        Stop: [],
        PermissionRequest: [{ matcher: "Bash", hooks: [{ type: "command", command: "scout permission-hook claude" }, { type: "command", command: "other" }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: `'/a/${CLAUDE_PERMISSION_HOOK_WRAPPER}'` }] }],
      },
    };
    const { settings: next, removed } = withoutScoutClaudeHooks(settings);
    expect(removed).toBe(2);
    expect(next).toEqual({ hooks: { Stop: [], PermissionRequest: [{ matcher: "Bash", hooks: [{ type: "command", command: "other" }] }] } });
  });

  test("the hooks key goes when Scout's entry was the only hook", () => {
    const applied = withScoutClaudeHooks({ model: "opus" }, CMD);
    expect(withoutScoutClaudeHooks(applied).settings).toEqual({ model: "opus" });
  });

  test("an older bare CLI entry is replaced, not doubled", () => {
    const legacy = { hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: "scout permission-hook claude" }] }] } };
    const next = withScoutClaudeHooks(legacy, CMD);
    expect(scoutClaudeHookCommands(next)).toEqual([CMD]);
  });

  test("Orca's hook is never taken for Scout's", () => {
    expect(scoutClaudeHookCommands(JSON.parse(ORIGINAL))).toEqual([]);
  });
});

describe("HarnessHooks", () => {
  test("apply then remove leaves the settings file byte for byte as it was", async () => {
    await writeFile(settingsPath, ORIGINAL);
    await chmod(settingsPath, 0o600);

    const applied = await hooks().apply();
    expect(applied.outcome).toBe("changed");
    expect(applied.hooks[0]!.state).toBe("applied");
    expect(await readFile(wrapperPath, "utf8")).toBe(claudePermissionHookWrapper("'/usr/local/bin/scout'"));
    expect((await stat(wrapperPath)).mode & 0o777).toBe(0o755);
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.hooks.PermissionRequest).toEqual([ORCA, { hooks: [{ type: "command", command: shellQuote(wrapperPath) }] }]);

    const before = await readFile(settingsPath, "utf8");
    expect((await hooks().apply()).outcome).toBe("unchanged");
    expect(await readFile(settingsPath, "utf8")).toBe(before);

    const removed = await hooks().remove();
    expect(removed.outcome).toBe("changed");
    expect(removed.hooks[0]!.state).toBe("absent");
    expect(await readFile(settingsPath, "utf8")).toBe(ORIGINAL);
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
    expect(existsSync(wrapperPath)).toBe(false);
    expect(existsSync(join(dir, "support", "runtime", "hooks"))).toBe(false);
    expect((await hooks().remove()).outcome).toBe("unchanged");
  });

  test("a symlinked settings file stays a symlink", async () => {
    const real = join(dir, "dotfiles-settings.json");
    await writeFile(real, ORIGINAL);
    await symlink(real, settingsPath);
    await hooks().apply();
    expect((await lstat(settingsPath)).isSymbolicLink()).toBe(true);
    expect(scoutClaudeHookCommands(JSON.parse(await readFile(real, "utf8")))).toHaveLength(1);
    await hooks().remove();
    expect(await readFile(real, "utf8")).toBe(ORIGINAL);
  });

  test("settings that are not valid JSON are left alone", async () => {
    await writeFile(settingsPath, "{ \"model\": \"opus\", // comment\n}");
    await expect(hooks().apply()).rejects.toBeInstanceOf(HarnessHooksError);
    expect(await readFile(settingsPath, "utf8")).toBe("{ \"model\": \"opus\", // comment\n}");
  });

  test("a non-prod instance leaves the settings to prod unless pointed at itself", async () => {
    await writeFile(settingsPath, ORIGINAL);
    const skipped = await hooks({ instance: "dev-1" }).apply();
    expect(skipped).toMatchObject({ outcome: "skipped", reason: "non-prod-instance" });
    expect(await readFile(settingsPath, "utf8")).toBe(ORIGINAL);
    expect(existsSync(wrapperPath)).toBe(false);
    expect((await hooks({ instance: "dev-1" }).remove()).outcome).toBe("skipped");
    expect((await hooks({ instance: "dev-1", instanceOverride: "dev-1" }).apply()).outcome).toBe("changed");
  });

  test("no Scout CLI to run means no hook", async () => {
    await writeFile(settingsPath, ORIGINAL);
    expect(await hooks({ scoutInvocation: () => null }).apply()).toMatchObject({ outcome: "skipped", reason: "scout-cli-not-found" });
    expect(await readFile(settingsPath, "utf8")).toBe(ORIGINAL);
  });

  test("another install's live script keeps its entry", async () => {
    const other = join(dir, "other", CLAUDE_PERMISSION_HOOK_WRAPPER);
    await mkdir(join(dir, "other"));
    await writeFile(other, "#!/bin/sh\n");
    const settings = withScoutClaudeHooks(JSON.parse(ORIGINAL), shellQuote(other));
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    expect(await hooks().apply()).toMatchObject({ outcome: "skipped", reason: "owned-by-other-install" });
    // once that script is gone, apply takes the entry over
    await rm(other);
    await hooks().apply();
    expect(scoutClaudeHookCommands(JSON.parse(await readFile(settingsPath, "utf8")))).toEqual([shellQuote(wrapperPath)]);
  });

  test("status says stale when the script is gone or starts another CLI", async () => {
    await writeFile(settingsPath, ORIGINAL);
    await hooks().apply();
    expect((await hooks({ scoutInvocation: () => "'/elsewhere/scout'" }).status())[0]).toMatchObject({ state: "stale" });
    await rm(wrapperPath);
    expect((await hooks().status())[0]).toMatchObject({ state: "stale", detail: "The hook script is missing." });
    await hooks().apply();
    expect((await hooks().status())[0]!.state).toBe("applied");
  });

  test("a missing settings file is created on apply", async () => {
    await hooks().apply();
    expect(scoutClaudeHookCommands(JSON.parse(await readFile(settingsPath, "utf8")))).toHaveLength(1);
    await hooks().remove();
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({});
  });
});
