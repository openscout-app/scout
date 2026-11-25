import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CrewReachabilityChecker } from "@openscout/runtime/crew";

import { createScoutCommandContext } from "../context.ts";
import { parseCrewCommandOptions, renderCrewCommandHelp, runCrewCommand } from "./crew.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function createTestContext(options: {
  cwd: string;
  env: Record<string, string>;
  json?: boolean;
}) {
  const lines: string[] = [];
  const context = createScoutCommandContext({
    cwd: options.cwd,
    env: options.env,
    outputMode: options.json ? "json" : "plain",
    stdout: (line) => lines.push(line),
    stderr: () => undefined,
    isTty: false,
  });
  return { context, lines };
}

function mockChecker(availableHarnesses: string[]): CrewReachabilityChecker {
  const set = new Set(availableHarnesses);
  return {
    checkHarness(harness: string) {
      return set.has(harness)
        ? { harness, available: true, state: "ready", detail: `${harness} is ready` }
        : { harness, available: false, state: "missing", detail: `${harness} is missing` };
    },
  };
}

describe("scout crew CLI", () => {
  test("parses help and core subcommands", () => {
    expect(renderCrewCommandHelp()).toContain("scout crew <command>");
    expect(parseCrewCommandOptions([], "/tmp")).toEqual({ command: "list", currentDirectory: "/tmp" });
    expect(parseCrewCommandOptions(["set", "worker", "codex", "--pool", "4", "--fallback", "claude,opencode", "--project"], "/tmp")).toEqual({
      command: "set",
      role: "worker",
      runtime: "codex",
      pool: 4,
      fallback: ["claude", "opencode"],
      scope: "project",
      currentDirectory: "/tmp",
    });
    expect(parseCrewCommandOptions(["preset", "save", "sprint", "--note", "Fast loop"], "/tmp")).toEqual({
      command: "preset-save",
      name: "sprint",
      note: "Fast loop",
      scope: "global",
      currentDirectory: "/tmp",
    });
  });

  test("list starts empty with built-in slot profiles and zero hardcoded models", async () => {
    const root = makeTempDir("scout-crew-cli-empty-");
    const home = join(root, "openscout-home");
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });

    const { context, lines } = createTestContext({
      cwd: repo,
      env: { OPENSCOUT_HOME: home },
      json: true,
    });
    await runCrewCommand(context, ["list", "--json"]);
    const payload = JSON.parse(lines.join("\n"));

    expect(payload.roles).toEqual([]);
    expect(payload.presets).toEqual([]);
    expect(payload.profiles.map((p: { id: string }) => p.id)).toEqual([
      "architect", "lane", "worker", "systems", "stylist", "advisor",
    ]);
  });

  test("set, unset, project override, preset save/use/list, and check round-trip cleanly", async () => {
    const root = makeTempDir("scout-crew-cli-roundtrip-");
    const home = join(root, "openscout-home");
    const repo = join(root, "repo");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(repo, ".git"), { recursive: true });
    const env = { OPENSCOUT_HOME: home };

    // Set global roles
    const setArchitect = createTestContext({ cwd: repo, env });
    await runCrewCommand(setArchitect.context, ["set", "architect", "claude/opus", "--note", "Design seat"]);
    expect(setArchitect.lines.join("\n")).toContain("Set global crew role architect = claude/opus");

    const setWorker = createTestContext({ cwd: repo, env });
    await runCrewCommand(setWorker.context, ["set", "worker", "codex/gpt-fixture", "--pool", "3", "--fallback", "antigravity/gemini-fixture,claude/sonnet"]);
    expect(setWorker.lines.join("\n")).toContain("Set global crew role worker = codex/gpt-fixture");

    // Save preset
    const savePreset = createTestContext({ cwd: repo, env });
    await runCrewCommand(savePreset.context, ["preset", "save", "default-mix", "--note", "Balanced"]);
    expect(savePreset.lines.join("\n")).toContain("Saved global crew preset default-mix");

    // Project override on worker pool
    const setProject = createTestContext({ cwd: repo, env });
    await runCrewCommand(setProject.context, ["set", "worker", "codex/gpt-fixture", "--pool", "6", "--fallback", "antigravity/gemini-fixture", "--project"]);
    expect(setProject.lines.join("\n")).toContain("Set project crew role worker");

    // Check reachability when codex is missing but antigravity is available
    const checkRun = createTestContext({ cwd: repo, env, json: true });
    await runCrewCommand(checkRun.context, ["check", "--json"], {
      checker: mockChecker(["claude", "antigravity"]),
    });
    const checkReport = JSON.parse(checkRun.lines.join("\n"));
    expect(checkReport.ok).toBe(true);
    const workerCheck = checkReport.roles.find((r: { role: string }) => r.role === "worker");
    expect(workerCheck.available).toBe(true);
    expect(workerCheck.usedFallback).toBe(true);
    expect(workerCheck.selectedRuntime).toBe("antigravity/gemini-fixture");
    expect(workerCheck.binding.pool).toBe(6);

    // Unset project override and switch preset
    const unsetProject = createTestContext({ cwd: repo, env });
    await runCrewCommand(unsetProject.context, ["unset", "worker", "--project"]);
    expect(unsetProject.lines.join("\n")).toContain("Removed project crew role worker");

    const usePreset = createTestContext({ cwd: repo, env });
    await runCrewCommand(usePreset.context, ["preset", "use", "default-mix"]);
    expect(usePreset.lines.join("\n")).toContain("Activated global crew preset default-mix");

    const listPresets = createTestContext({ cwd: repo, env, json: true });
    await runCrewCommand(listPresets.context, ["preset", "list", "--json"]);
    const presetsPayload = JSON.parse(listPresets.lines.join("\n"));
    expect(presetsPayload.activePreset).toBe("default-mix");
    expect(presetsPayload.presets).toHaveLength(1);
    expect(presetsPayload.presets[0].active).toBe(true);
  });

  test("surfaces warnings for symlinked project .openscout directory without breaking global roles", async () => {
    const root = makeTempDir("scout-crew-cli-symlink-");
    const home = join(root, "openscout-home");
    const outside = join(root, "outside");
    const repo = join(root, "repo");
    mkdirSync(home, { recursive: true });
    mkdirSync(outside, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(outside, "crew.json"), JSON.stringify({ version: 1, roles: { worker: { runtime: "codex" } } }));
    symlinkSync(outside, join(repo, ".openscout"));

    const env = { OPENSCOUT_HOME: home };
    await runCrewCommand(createTestContext({ cwd: repo, env }).context, ["set", "architect", "claude"]);

    const listRun = createTestContext({ cwd: repo, env, json: true });
    await runCrewCommand(listRun.context, ["list", "--json"]);
    const payload = JSON.parse(listRun.lines.join("\n"));
    expect(payload.roles.map((r: { role: string }) => r.role)).toEqual(["architect"]);
    expect(payload.issues).toEqual([
      expect.objectContaining({ source: "project", code: "symlink_rejected" }),
    ]);
  });
});
