import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCrewWhoAmISummary,
  checkCrewState,
  loadCrewState,
  resolveCrewRoleForAsk,
  saveCrewPreset,
  setCrewRole,
  unsetCrewRole,
  useCrewPreset,
  type CrewReachabilityChecker,
} from "./crew.js";

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

function mockChecker(options: {
  availableHarnesses: string[];
  reachableHosts?: Record<string, { reachable: boolean; local?: boolean; detail?: string }>;
}): CrewReachabilityChecker {
  const available = new Set(options.availableHarnesses);
  return {
    checkHarness(harness: string) {
      return available.has(harness)
        ? { harness, available: true, state: "ready", detail: `${harness} is ready` }
        : { harness, available: false, state: "missing", detail: `${harness} is not installed` };
    },
    checkHost(host: string) {
      const entry = options.reachableHosts?.[host];
      if (!entry) {
        return { host, reachable: false, detail: `mesh host "${host}" is unreachable` };
      }
      return {
        host,
        reachable: entry.reachable,
        local: entry.local,
        detail: entry.detail ?? (entry.reachable ? `${host} answered` : `${host} unreachable`),
      };
    },
  };
}

describe("runtime crew config & layering", () => {
  test("returns empty defaults when neither global nor project crew.json exists", () => {
    const root = makeTempDir("scout-crew-empty-");
    const env = { OPENSCOUT_HOME: join(root, "openscout-home") };
    const projectRoot = join(root, "repo");
    mkdirSync(projectRoot, { recursive: true });

    const state = loadCrewState({ env, projectRoot });
    expect(state.global).toEqual({ version: 1, roles: {}, presets: {} });
    expect(state.project).toBeNull();
    expect(state.roles).toEqual({});
    expect(state.presets).toEqual({});
    expect(state.issues).toEqual([]);
  });

  test("deep-merges project overrides per role over global config and preserves custom slots", () => {
    const root = makeTempDir("scout-crew-merge-");
    const home = join(root, "openscout-home");
    const projectRoot = join(root, "repo");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(projectRoot, ".openscout"), { recursive: true });

    writeFileSync(join(home, "crew.json"), JSON.stringify({
      version: 1,
      roles: {
        architect: { runtime: "claude/opus", note: "Global architect" },
        worker: { runtime: "codex/gpt-fixture", pool: 2, fallback: ["opencode"], note: "Global worker" },
      },
    }), "utf8");

    writeFileSync(join(projectRoot, ".openscout", "crew.json"), JSON.stringify({
      version: 1,
      roles: {
        worker: { pool: 5, note: "Project burst pool" },
        qa: { runtime: "antigravity/gemini-fixture", note: "Custom slot" },
      },
    }), "utf8");

    const state = loadCrewState({ env: { OPENSCOUT_HOME: home }, projectRoot });
    expect(state.issues).toEqual([]);
    expect(state.roles.architect).toMatchObject({
      role: "architect",
      runtime: "claude/opus",
      note: "Global architect",
      source: "global",
    });
    expect(state.roles.worker).toMatchObject({
      role: "worker",
      runtime: "codex/gpt-fixture",
      pool: 5,
      fallback: ["opencode"],
      note: "Project burst pool",
      source: "project",
    });
    expect(state.roles.qa).toMatchObject({
      role: "qa",
      runtime: "antigravity/gemini-fixture",
      note: "Custom slot",
      source: "project",
      profile: null,
    });
  });

  test("isolates malformed individual entries without breaking valid sibling roles", () => {
    const root = makeTempDir("scout-crew-malformed-");
    const home = join(root, "openscout-home");
    mkdirSync(home, { recursive: true });

    writeFileSync(join(home, "crew.json"), JSON.stringify({
      version: 1,
      roles: {
        architect: { runtime: "claude/opus" },
        broken: { runtime: "bogus/model" },
        bad_pool: { runtime: "codex", pool: -2 },
        worker: { runtime: "codex", pool: 3 },
      },
    }), "utf8");

    const state = loadCrewState({ env: { OPENSCOUT_HOME: home }, projectRoot: null });
    expect(Object.keys(state.roles).sort()).toEqual(["architect", "worker"]);
    expect(state.issues).toHaveLength(2);
    expect(state.issues.map((issue) => issue.role).sort()).toEqual(["bad_pool", "broken"]);
  });

  test("skips symlinked .openscout directory and symlinked crew.json file as a safety guard", () => {
    const root = makeTempDir("scout-crew-symlink-");
    const home = join(root, "openscout-home");
    const outside = join(root, "outside");
    mkdirSync(home, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "crew.json"), JSON.stringify({
      version: 1,
      roles: { worker: { runtime: "codex" } },
    }), "utf8");

    // Case 1: symlinked .openscout directory
    const repoDirSymlink = join(root, "repo-dir-symlink");
    mkdirSync(repoDirSymlink, { recursive: true });
    symlinkSync(outside, join(repoDirSymlink, ".openscout"));

    const state1 = loadCrewState({ env: { OPENSCOUT_HOME: home }, projectRoot: repoDirSymlink });
    expect(state1.roles).toEqual({});
    expect(state1.issues).toEqual([
      expect.objectContaining({
        source: "project",
        code: "symlink_rejected",
      }),
    ]);
    expect(() => setCrewRole("worker", { runtime: "codex" }, {
      scope: "project",
      projectRoot: repoDirSymlink,
    })).toThrow(/symlinked/i);

    // Case 2: symlinked crew.json file inside real .openscout directory
    const repoFileSymlink = join(root, "repo-file-symlink");
    mkdirSync(join(repoFileSymlink, ".openscout"), { recursive: true });
    symlinkSync(join(outside, "crew.json"), join(repoFileSymlink, ".openscout", "crew.json"));

    const state2 = loadCrewState({ env: { OPENSCOUT_HOME: home }, projectRoot: repoFileSymlink });
    expect(state2.roles).toEqual({});
    expect(state2.issues).toEqual([
      expect.objectContaining({
        source: "project",
        code: "symlink_rejected",
      }),
    ]);
    expect(() => setCrewRole("worker", { runtime: "codex" }, {
      scope: "project",
      projectRoot: repoFileSymlink,
    })).toThrow(/symlinked/i);
  });

  test("supports set, unset, preset save, and preset use", () => {
    const root = makeTempDir("scout-crew-presets-");
    const globalPath = join(root, "crew.json");

    setCrewRole("architect", { runtime: "claude/opus", note: "Design lead" }, { globalPath });
    setCrewRole("worker", { runtime: "codex/gpt-fixture", pool: 4, fallback: ["opencode"] }, { globalPath });
    saveCrewPreset("sprint", { note: "High throughput", globalPath });

    // Mutate roles after saving preset
    setCrewRole("worker", { runtime: "opencode", pool: 1 }, { globalPath });
    unsetCrewRole("architect", { globalPath });

    const mutated = loadCrewState({ globalPath, projectRoot: null });
    expect(Object.keys(mutated.roles)).toEqual(["worker"]);
    expect(mutated.roles.worker?.runtime).toBe("opencode");

    // Restore saved preset
    useCrewPreset("sprint", { globalPath });
    const restored = loadCrewState({ globalPath, projectRoot: null });
    expect(restored.activePreset).toBe("sprint");
    expect(Object.keys(restored.roles).sort()).toEqual(["architect", "worker"]);
    expect(restored.roles.worker?.runtime).toBe("codex/gpt-fixture");
    expect(restored.roles.worker?.pool).toBe(4);
    expect(JSON.parse(readFileSync(globalPath, "utf8")).version).toBe(1);
  });
});

describe("crew reachability gating, ask resolution, and whoami summary", () => {
  test("walks fallback rungs when primary harness or mesh host is unavailable", async () => {
    const root = makeTempDir("scout-crew-resolve-");
    const globalPath = join(root, "crew.json");

    setCrewRole("worker", {
      runtime: "codex/gpt-fixture",
      fallback: ["antigravity/gemini-fixture", "claude/sonnet"],
      pool: 3,
    }, { globalPath });
    setCrewRole("systems", {
      runtime: "codex/gpt-fixture/xhigh",
      host: "build-box",
      fallback: ["claude/opus"],
    }, { globalPath });

    // Primary codex unavailable, antigravity available -> worker walks to antigravity
    const checker = mockChecker({
      availableHarnesses: ["antigravity", "claude"],
      reachableHosts: { "build-box": { reachable: false } },
    });

    const worker = await resolveCrewRoleForAsk("worker", { globalPath, projectRoot: null, checker });
    expect(worker.ok).toBe(true);
    if (worker.ok) {
      expect(worker.selectedRuntime).toBe("antigravity/gemini-fixture");
      expect(worker.selectedSpec).toEqual({ harness: "antigravity", model: "gemini-fixture" });
      expect(worker.usedFallback).toBe(true);
    }

    // Primary host build-box unreachable -> systems walks to local fallback claude/opus
    const systems = await resolveCrewRoleForAsk("systems", { globalPath, projectRoot: null, checker });
    expect(systems.ok).toBe(true);
    if (systems.ok) {
      expect(systems.selectedRuntime).toBe("claude/opus");
      expect(systems.selectedHost).toBeUndefined();
      expect(systems.usedFallback).toBe(true);
    }
  });

  test("returns actionable error naming scout crew set when role is unconfigured", async () => {
    const root = makeTempDir("scout-crew-unconfigured-");
    const globalPath = join(root, "crew.json");

    const resolved = await resolveCrewRoleForAsk("advisor", {
      globalPath,
      projectRoot: null,
      checker: mockChecker({ availableHarnesses: ["claude"] }),
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.code).toBe("role_unconfigured");
      expect(resolved.error).toContain("scout crew set advisor <runtime>");
    }
  });

  test("whoami summary advertises only available roles and includes active seat posture", async () => {
    const root = makeTempDir("scout-crew-whoami-");
    const globalPath = join(root, "crew.json");

    setCrewRole("lane", { runtime: "antigravity/gemini-fixture", note: "Core lane" }, { globalPath });
    setCrewRole("worker", { runtime: "codex", pool: 4 }, { globalPath });
    setCrewRole("stylist", { runtime: "kimi" }, { globalPath });

    const state = loadCrewState({ globalPath, projectRoot: null });
    const check = await checkCrewState(state, mockChecker({ availableHarnesses: ["antigravity", "codex"] }));
    const summary = buildCrewWhoAmISummary({ state, check, activeRole: "lane" });

    expect(summary).not.toBeNull();
    expect(summary?.availableRoles.map((r) => r.role)).toEqual(["lane", "worker"]);
    expect(summary?.availableRoles.some((r) => r.role === "stylist")).toBe(false);
    expect(summary?.activeSeat).toMatchObject({
      role: "lane",
      runtime: "antigravity/gemini-fixture",
      note: "Core lane",
      profile: expect.objectContaining({ id: "lane", label: "Lane owner" }),
    });
  });

  test("project-scoped writes preserve existing partial role overrides in .openscout/crew.json", () => {
    const root = makeTempDir("scout-crew-project-partial-");
    const globalPath = join(root, "global-crew.json");
    const projectRoot = join(root, "repo");
    mkdirSync(join(projectRoot, ".openscout"), { recursive: true });
    setCrewRole("worker", { runtime: "codex", pool: 2 }, { globalPath });
    writeFileSync(
      join(projectRoot, ".openscout", "crew.json"),
      JSON.stringify({ version: 1, roles: { worker: { pool: 8 } } }, null, 2),
      "utf8",
    );

    setCrewRole("advisor", { runtime: "claude" }, { scope: "project", projectRoot, globalPath });

    const state = loadCrewState({ globalPath, projectRoot });
    expect(state.roles.worker).toMatchObject({ runtime: "codex", pool: 8, source: "project" });
    expect(state.roles.advisor).toMatchObject({ runtime: "claude", source: "project" });
  });
});
