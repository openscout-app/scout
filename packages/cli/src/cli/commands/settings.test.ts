import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resetUserConfigCache } from "@openscout/runtime";

import { createScoutCommandContext } from "../context.ts";
import { scoutCommandHelp } from "../command-help.ts";
import { findScoutCommandRegistration } from "../registry.ts";
import { runConfigCommand } from "./config.ts";
import { runSettingsCommand } from "./settings.ts";

const priorEnv = {
  home: process.env.OPENSCOUT_HOME,
  support: process.env.OPENSCOUT_SUPPORT_DIRECTORY,
};
let home = "";

function restore(key: "OPENSCOUT_HOME" | "OPENSCOUT_SUPPORT_DIRECTORY", value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "scout-settings-cli-"));
  process.env.OPENSCOUT_HOME = home;
  // The name hook writes onboarding state to settings.json in the support directory.
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "support");
  resetUserConfigCache();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  restore("OPENSCOUT_HOME", priorEnv.home);
  restore("OPENSCOUT_SUPPORT_DIRECTORY", priorEnv.support);
  resetUserConfigCache();
  process.exitCode = 0;
});

async function settings(args: string[], json = false): Promise<string> {
  const lines: string[] = [];
  const context = createScoutCommandContext({
    cwd: home,
    env: { ...process.env, OPENSCOUT_SETUP_CWD: home },
    stdout: (line) => lines.push(line),
    outputMode: json ? "json" : "plain",
  });
  await runSettingsCommand(context, args);
  return lines.join("\n");
}

async function config(args: string[]): Promise<string> {
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  });
  try {
    await runConfigCommand(createScoutCommandContext({ cwd: home, env: { ...process.env, OPENSCOUT_SETUP_CWD: home } }), args);
  } finally {
    log.mockRestore();
  }
  return lines.join("\n");
}

function readChangeLog(): Array<Record<string, any>> {
  const path = join(home, "settings-changes.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

describe("scout settings", () => {
  test("is registered so scout help --json lists it", () => {
    expect(findScoutCommandRegistration("settings")?.grammar?.subcommands).toEqual(expect.objectContaining({
      list: expect.anything(), get: expect.anything(), set: expect.anything(), unset: expect.anything(), apply: expect.anything(),
    }));
    const catalog = scoutCommandHelp([], "test") as { commands: Array<{ name: string }> };
    expect(catalog.commands.map((command) => command.name)).toContain("settings");
    const help = scoutCommandHelp(["settings"], "test") as { flags: Array<{ name: string }> };
    expect(help.flags.map((flag) => flag.name)).toContain("--dry-run");
  });

  test("list --json returns every catalog entry with its risk", async () => {
    const payload = JSON.parse(await settings(["list"], true)) as { settings: Array<Record<string, unknown>> };
    const tone = payload.settings.find((setting) => setting.id === "tone");
    expect(tone).toEqual(expect.objectContaining({
      scope: "core", kind: "enum", risk: "apply", enumValues: ["direct", "warm", "formal"], value: null, isSet: false,
    }));
    expect(payload.settings.find((setting) => setting.id === "handle")?.risk).toBe("confirm");
  });

  test("set, get and unset round-trip through user.json", async () => {
    expect(await settings(["set", "verbosity", "detailed"])).toContain("verbosity  apply    (unset) → detailed");
    expect(JSON.parse(await settings(["get", "verbosity"], true))).toEqual(expect.objectContaining({ value: "detailed" }));
    const unset = JSON.parse(await settings(["unset", "verbosity"], true));
    expect(unset).toEqual(expect.objectContaining({ status: "applied" }));
    expect(unset.changes[0]).toEqual(expect.objectContaining({ action: "unset", from: "detailed", to: null }));
  });

  test("apply prints the diff and the risk of each change", async () => {
    const patch = join(home, "patch.json");
    writeFileSync(patch, JSON.stringify({ tone: "warm", handle: "ada" }));
    const output = await settings(["apply", patch]);
    expect(output).toContain("Applied 2 changes.");
    expect(output).toContain("tone    apply    (unset) → warm");
    expect(output).toContain("handle  confirm  (unset) → ada  approved by operator");
    expect(JSON.parse(readFileSync(join(home, "user.json"), "utf8"))).toEqual({ tone: "warm", handle: "ada" });
  });

  test("apply --dry-run writes nothing", async () => {
    const patch = join(home, "patch.json");
    writeFileSync(patch, JSON.stringify({ tone: "formal", "agent-names": ["ada"] }));
    const result = JSON.parse(await settings(["apply", patch, "--dry-run"], true));
    expect(result.status).toBe("dry-run");
    expect(result.changes.map((change: { id: string; risk: string }) => [change.id, change.risk])).toEqual([
      ["tone", "apply"],
      ["agent-names", "apply"],
    ]);
    expect(existsSync(join(home, "user.json"))).toBe(false);
    expect(readChangeLog()).toEqual([]);
  });

  test("--json reports invalid values as structured issues", async () => {
    const output = JSON.parse(await settings(["set", "tone", "loud"], true));
    expect(output).toEqual({
      error: "invalid-value",
      issues: [expect.objectContaining({ id: "tone", code: "invalid-value" })],
    });
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(home, "user.json"))).toBe(false);
  });

  test("plain output fails with the reason", async () => {
    await expect(settings(["get", "nope"])).rejects.toThrow(/unknown setting/);
    await expect(settings(["set", "tone"])).rejects.toThrow(/usage: scout settings set/);
  });

  test("the CLI caller is the operator and is recorded as such", async () => {
    await settings(["set", "name", "Ada", "Lovelace"]);
    expect(readChangeLog()).toEqual([expect.objectContaining({
      id: "name",
      approval: "operator",
      actor: { authority: "operator", id: "cli", via: "scout settings" },
      from: null,
      to: "Ada Lovelace",
    })]);
  });
});

describe("scout config compatibility", () => {
  test("keeps its set, get, list and show output", async () => {
    expect(await config(["set", "tone", "warm"])).toBe("tone set to: warm");
    expect(await config(["get", "tone"])).toBe("warm");
    expect(await config(["set", "name", "Ada"])).toBe("Name set to: Ada");
    expect(await config(["set", "agent-names", "ada,grace"])).toBe("agent-names set to: ada, grace");
    expect(await config(["set", "tone"])).toBe("tone cleared");
    expect((await config(["list"])).split("\n")).toContain("agent-names-mode");
    expect((await config([])).split("\n")[0]).toBe("name: Ada");
  });

  test("writes through the settings service and its change log", async () => {
    await config(["set", "verbosity", "detailed"]);
    expect(JSON.parse(readFileSync(join(home, "user.json"), "utf8")).verbosity).toBe("detailed");
    expect(readChangeLog()).toEqual([expect.objectContaining({
      id: "verbosity",
      actor: { authority: "operator", id: "cli", via: "scout config" },
      to: "detailed",
    })]);
    expect(await settings(["get", "verbosity"])).toContain("verbosity: detailed");
  });
});
