import { describe, expect, test } from "bun:test";

import {
  BUILTIN_CREW_SLOT_IDS,
  BUILTIN_CREW_SLOT_PROFILES,
  CREW_CONFIG_VERSION,
  createEmptyCrewConfig,
  getCrewSlotProfile,
  isValidCrewKey,
  listBuiltinCrewSlotProfiles,
  mergeCrewLayers,
  sanitizeCrewConfig,
  sanitizeCrewLayer,
} from "./crew.js";

describe("crew protocol contracts", () => {
  test("empty default config ships with zero hardcoded roles or presets", () => {
    const empty = createEmptyCrewConfig();
    expect(empty).toEqual({
      version: CREW_CONFIG_VERSION,
      roles: {},
      presets: {},
    });
    expect(Object.keys(empty.roles)).toHaveLength(0);
    expect(Object.keys(empty.presets ?? {})).toHaveLength(0);
  });

  test("built-in slot profiles cover the six timeless postures with zero hardcoded vendor or model names", () => {
    expect([...BUILTIN_CREW_SLOT_IDS]).toEqual([
      "architect",
      "lane",
      "worker",
      "systems",
      "stylist",
      "advisor",
    ]);
    const profiles = listBuiltinCrewSlotProfiles();
    expect(profiles).toHaveLength(6);

    const forbiddenVendorOrHype = /\b(claude|codex|openai|anthropic|gemini|gpt|opus|sonnet|haiku|grok|kimi|deepseek|glm|qwen|minimax|antigravity|swarm|mega-agent|agentic os)\b/i;
    for (const profile of profiles) {
      expect(BUILTIN_CREW_SLOT_PROFILES[profile.id]).toEqual(profile);
      expect(getCrewSlotProfile(profile.id.toUpperCase())).toEqual(profile);
      expect(profile.economics.length).toBeGreaterThan(10);
      expect(profile.posture.length).toBeGreaterThan(20);
      expect(forbiddenVendorOrHype.test(profile.economics)).toBe(false);
      expect(forbiddenVendorOrHype.test(profile.posture)).toBe(false);
    }
    expect(getCrewSlotProfile("custom-reviewer")).toBeNull();
  });

  test("rejects prototype-pollution keys and strips them during sanitization", () => {
    expect(isValidCrewKey("__proto__")).toBe(false);
    expect(isValidCrewKey("prototype")).toBe(false);
    expect(isValidCrewKey("constructor")).toBe(false);
    expect(isValidCrewKey("worker")).toBe(true);
    expect(isValidCrewKey("qa-verifier")).toBe(true);

    const raw = JSON.parse(`{
      "version": 1,
      "__proto__": { "polluted": true },
      "constructor": { "polluted": true },
      "roles": {
        "__proto__": { "runtime": "codex" },
        "prototype": { "runtime": "codex" },
        "constructor": { "runtime": "codex" },
        "worker": {
          "runtime": "codex/gpt-fixture/high",
          "pool": 3,
          "__proto__": { "polluted": true }
        }
      },
      "presets": {
        "__proto__": { "roles": {} },
        "lean": {
          "roles": {
            "constructor": { "runtime": "claude" },
            "architect": { "runtime": "claude/opus" }
          }
        }
      }
    }`);

    const { config, issues } = sanitizeCrewConfig(raw, {
      source: "global",
      path: "/tmp/crew.json",
    });

    expect(issues).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(config.roles)).toEqual(["worker"]);
    expect(Object.keys(config.presets ?? {})).toEqual(["lean"]);
    expect(Object.keys(config.presets?.lean?.roles ?? {})).toEqual(["architect"]);
    expect(Object.prototype.hasOwnProperty.call(config.roles, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(config.roles, "constructor")).toBe(false);
  });

  test("isolates malformed individual role and preset entries without breaking valid siblings", () => {
    const raw = {
      version: 1,
      roles: {
        architect: { runtime: "claude/opus" },
        broken_runtime: { runtime: "not-a-harness/model" },
        broken_pool: { runtime: "codex", pool: 0 },
        broken_fallback: { runtime: "codex", fallback: ["bad-harness/x"] },
        "bad role name": { runtime: "codex" },
        worker: { runtime: "antigravity/gemini-fixture", pool: 4, fallback: ["codex"] },
      },
      presets: {
        valid: {
          note: "Balanced preset",
          roles: {
            systems: { runtime: "codex" },
            bad_inside: { runtime: "unknown-harness" },
          },
        },
        broken: "not-an-object",
      },
    };

    const { config, issues } = sanitizeCrewConfig(raw, {
      source: "global",
      path: "/tmp/crew.json",
    });

    expect(Object.keys(config.roles).sort()).toEqual(["architect", "worker"]);
    expect(config.roles.worker).toEqual({
      runtime: "antigravity/gemini-fixture",
      pool: 4,
      fallback: ["codex"],
    });
    expect(Object.keys(config.presets ?? {})).toEqual(["valid"]);
    expect(Object.keys(config.presets?.valid?.roles ?? {})).toEqual(["systems"]);
    expect(issues.length).toBeGreaterThanOrEqual(5);
    expect(issues.some((i) => i.role === "broken_runtime" && i.code === "invalid_runtime_spec")).toBe(true);
    expect(issues.some((i) => i.role === "broken_pool" && i.code === "invalid_role_binding")).toBe(true);
    expect(issues.some((i) => i.preset === "broken" && i.code === "invalid_preset")).toBe(true);
  });

  test("deep-merges project role overrides over global roles and reports partial project-only roles without runtime", () => {
    const { config: globalConfig } = sanitizeCrewConfig({
      version: 1,
      roles: {
        architect: { runtime: "claude/opus", note: "Global architect" },
        worker: { runtime: "codex", pool: 2, fallback: ["opencode"], note: "Global worker" },
      },
    }, { source: "global", path: "/global/crew.json" });

    const { layer: projectLayer, issues: parseIssues } = sanitizeCrewLayer({
      version: 1,
      roles: {
        worker: { pool: 6, note: "High concurrency repo" },
        stylist: { runtime: "antigravity/gemini-fixture" },
        orphan_partial: { pool: 2 },
      },
    }, { source: "project", path: "/repo/.openscout/crew.json", allowPartialRoles: true });

    expect(parseIssues).toEqual([]);

    const merged = mergeCrewLayers({
      global: globalConfig,
      project: projectLayer,
      projectPath: "/repo/.openscout/crew.json",
    });

    expect(merged.roles.architect).toMatchObject({
      role: "architect",
      runtime: "claude/opus",
      note: "Global architect",
      source: "global",
    });
    expect(merged.roles.worker).toMatchObject({
      role: "worker",
      runtime: "codex",
      pool: 6,
      fallback: ["opencode"],
      note: "High concurrency repo",
      source: "project",
    });
    expect(merged.roles.stylist).toMatchObject({
      role: "stylist",
      runtime: "antigravity/gemini-fixture",
      source: "project",
    });
    expect(merged.roles.orphan_partial).toBeUndefined();
    expect(merged.issues).toEqual([
      expect.objectContaining({
        source: "project",
        role: "orphan_partial",
        code: "invalid_role_binding",
      }),
    ]);
  });
});
