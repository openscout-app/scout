import { describe, expect, test } from "bun:test";

import {
  resolveScoutBaselineRuntime,
  SCOUT_BASELINE_CANDIDATES,
  SCOUT_BASELINE_PURPOSE,
} from "./scout-baseline-runtime.js";

describe("Scout baseline runtime", () => {
  test("prefers Luna when a Codex subscription harness is available", () => {
    expect(resolveScoutBaselineRuntime(["claude", "codex", "grok"])).toEqual({
      harness: "codex",
      model: "gpt-5.6-luna",
      effort: "low",
      label: "Luna",
      purpose: SCOUT_BASELINE_PURPOSE,
    });
  });

  test("uses DeepSeek Flash for OpenRouter-style OpenCode nodes", () => {
    expect(resolveScoutBaselineRuntime(["opencode"])).toEqual({
      harness: "opencode",
      model: "deepseek-v4-flash",
      effort: null,
      label: "DeepSeek Flash",
      purpose: SCOUT_BASELINE_PURPOSE,
    });
  });

  test("treats grok-acp as the Grok cheap pick", () => {
    expect(resolveScoutBaselineRuntime(["grok-acp"])?.harness).toBe("grok");
    expect(resolveScoutBaselineRuntime(["grok-acp"])?.model).toBe("grok-4.20-0309-non-reasoning");
  });

  test("falls through to Haiku when only Claude is present", () => {
    expect(resolveScoutBaselineRuntime(["claude"])).toEqual({
      harness: "claude",
      model: "claude-haiku-5-5",
      effort: "low",
      label: "Haiku",
      purpose: SCOUT_BASELINE_PURPOSE,
    });
  });

  test("returns null when no cheap harness is available", () => {
    expect(resolveScoutBaselineRuntime([])).toBeNull();
    expect(resolveScoutBaselineRuntime(["pi", "cursor"])).toBeNull();
  });

  test("keeps candidate harnesses unique and purpose-tagged", () => {
    const harnesses = SCOUT_BASELINE_CANDIDATES.map((candidate) => candidate.harness);
    expect(new Set(harnesses).size).toBe(harnesses.length);
    expect(resolveScoutBaselineRuntime(["kimi"])?.purpose).toBe("scout-utility");
  });
});
