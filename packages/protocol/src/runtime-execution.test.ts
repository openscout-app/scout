import { describe, expect, test } from "bun:test";

import {
  createScoutExecutionResolution,
  parseScoutRuntimeSpec,
  formatScoutRuntimeSpec,
  isModelSelectableHarness,
  normalizeScoutRuntimeModel,
  scoutRuntimeLatestModelInFamily,
  SCOUT_LAUNCHABLE_HARNESSES,
  SCOUT_REASONING_EFFORT_LABELS,
  SCOUT_RUNTIME_CATALOG,
  SCOUT_RUNTIME_EFFORT_CATALOG,
  isScoutRuntimeHarnessListed,
  scoutRuntimeDefaultHarness,
  scoutRuntimeDefaultModel,
  scoutRuntimeDefaultReasoningEffort,
  scoutRuntimeReasoningEfforts,
  validateScoutRuntimeTuple,
} from "./runtime-execution.js";

describe("runtime execution contracts", () => {
  test("keeps endpoint-only harness categories out of the launch vocabulary", () => {
    expect(SCOUT_LAUNCHABLE_HARNESSES).toContain("codex");
    expect(SCOUT_LAUNCHABLE_HARNESSES).not.toContain("worker" as never);
    expect(SCOUT_LAUNCHABLE_HARNESSES).not.toContain("bridge" as never);
  });

  test("uses the Scout-owned catalog for product defaults and display labels", () => {
    expect(SCOUT_RUNTIME_CATALOG.schemaVersion).toBe("openscout.runtime-catalog.v1");
    expect(scoutRuntimeDefaultHarness()).toBe("claude");
    expect(scoutRuntimeDefaultModel("claude")).toBe("claude-opus-5-5");
    expect(scoutRuntimeDefaultModel("codex")).toBe("gpt-6-astra");
    expect(scoutRuntimeDefaultModel("grok")).toBe("grok-4.6");
    expect(scoutRuntimeDefaultModel("grok-acp")).toBe("grok-4.6");
    expect(isScoutRuntimeHarnessListed("grok")).toBe(false);
    expect(isScoutRuntimeHarnessListed("grok-acp")).toBe(true);
    expect(scoutRuntimeDefaultReasoningEffort("claude", "claude-opus-5")).toBe("medium");
    expect(scoutRuntimeDefaultReasoningEffort("codex", "gpt-6-astra")).toBe("low");
    expect(SCOUT_REASONING_EFFORT_LABELS.low).toBe("Light");
    expect(SCOUT_REASONING_EFFORT_LABELS.xhigh).toBe("Extra High");
    expect(isScoutRuntimeHarnessListed("grok")).toBe(false);
    expect(isScoutRuntimeHarnessListed("grok-acp")).toBe(true);
  });

  test("lets Scout define a different effort ladder for each model", () => {
    expect(scoutRuntimeReasoningEfforts("claude", "claude-opus-5-5")).toEqual([
      "low", "medium", "high", "xhigh", "max",
    ]);
    expect(scoutRuntimeReasoningEfforts("codex", "gpt-6-sol")).toEqual([
      "low", "medium", "high", "xhigh", "max", "ultra",
    ]);
    expect(scoutRuntimeReasoningEfforts("codex", "gpt-6-luna")).toEqual([
      "low", "medium", "high", "xhigh", "max",
    ]);
    expect(scoutRuntimeReasoningEfforts("codex", "gpt-6-astra")).toEqual([
      "low", "medium", "high", "xhigh", "max",
    ]);
    expect(scoutRuntimeReasoningEfforts("codex", "gpt-5.6-sol")).toEqual([
      "low", "medium", "high", "xhigh", "ultra",
    ]);
    expect(scoutRuntimeReasoningEfforts("codex", "gpt-5.6-luna")).toEqual([
      "low", "medium", "high", "xhigh",
    ]);
    expect(SCOUT_RUNTIME_EFFORT_CATALOG.find((entry) => entry.id === "ultra")).toEqual(
      expect.objectContaining({
        harnesses: ["codex"],
        models: ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra"],
      }),
    );
  });

  test("rejects effort values that are valid globally but illegal for the harness", () => {
    expect(validateScoutRuntimeTuple({
      harness: "claude",
      reasoningEffort: "ultra",
    })).toEqual([expect.objectContaining({
      code: "reasoning_effort_harness_mismatch",
      dimension: "reasoningEffort",
    })]);
  });

  test("rejects effort values that Scout disabled for the selected model", () => {
    expect(validateScoutRuntimeTuple({ harness: "codex", model: "gpt-6-sol", reasoningEffort: "ultra" })).toEqual([]);
    expect(validateScoutRuntimeTuple({ harness: "codex", model: "gpt-6-luna", reasoningEffort: "max" })).toEqual([]);
    expect(validateScoutRuntimeTuple({ harness: "claude", model: "claude-opus-5-5", reasoningEffort: "max" })).toEqual([]);
    expect(validateScoutRuntimeTuple({ harness: "codex", model: "gpt-6-luna", reasoningEffort: "ultra" }))
      .toEqual([expect.objectContaining({ code: "reasoning_effort_harness_mismatch" })]);
    expect(parseScoutRuntimeSpec("codex/gpt-5.6-luna/ultra")).toEqual({
      ok: true,
      value: { harness: "codex", model: "gpt-5.6-luna", reasoningEffort: "ultra" },
    });
  });

  test("Pi accepts its native thinking ladder but not ultra", () => {
    expect(validateScoutRuntimeTuple({ harness: "pi", model: "custom-provider/custom-model", reasoningEffort: "low" })).toEqual([]);
    expect(validateScoutRuntimeTuple({ harness: "pi", reasoningEffort: "none" })).toEqual([]);
    expect(validateScoutRuntimeTuple({ harness: "pi", reasoningEffort: "ultra" }))
      .toEqual([expect.objectContaining({ code: "reasoning_effort_harness_mismatch" })]);
  });

  test("records requested, resolved, observed, and drift independently", () => {
    const resolution = createScoutExecutionResolution({
      requested: { harness: "codex", model: "5.6", reasoningEffort: "xhigh" },
      resolved: { harness: "codex", model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
      source: { harness: "flag", model: "flag", reasoningEffort: "flag" },
      observed: { harness: "codex", model: "gpt-5.6-terra", reasoningEffort: "xhigh" },
      observedAt: 123,
    });

    expect(resolution.model).toEqual({
      requested: "5.6",
      resolved: "gpt-5.6-sol",
      source: "flag",
      observed: "gpt-5.6-terra",
      observedAt: 123,
      drift: "mismatch",
    });
    expect(resolution.reasoningEffort.drift).toBe("match");
  });

  test("drift compares the session's report with the ask, and only when the ask requested a value", () => {
    // Nothing requested: the session's own model and effort are recorded, with no drift to compute.
    const unrequested = createScoutExecutionResolution({
      requested: { harness: "claude" },
      resolved: { harness: "claude", model: "claude-opus-5-5", reasoningEffort: "high" },
      source: { harness: "flag", model: "profile", reasoningEffort: "profile" },
      observed: { harness: "claude", model: "claude-sonnet-5-5", reasoningEffort: "medium" },
      observedAt: 7,
    });
    expect(unrequested.harness.drift).toBe("match");
    expect(unrequested.model).toEqual({
      resolved: "claude-opus-5-5", source: "profile", observed: "claude-sonnet-5-5", observedAt: 7, drift: "not_requested",
    });
    expect(unrequested.reasoningEffort).toEqual(expect.objectContaining({ observed: "medium", drift: "not_requested" }));

    // Requested but not yet reported by the session.
    expect(createScoutExecutionResolution({
      requested: { model: "opus" }, resolved: { model: "claude-opus-5-5" },
    }).model.drift).toBe("unknown");
    // Requested without a resolved form: compare with the request itself.
    expect(createScoutExecutionResolution({
      requested: { reasoningEffort: "high" }, observed: { reasoningEffort: "HIGH" },
    }).reasoningEffort.drift).toBe("match");
    expect(createScoutExecutionResolution({}).model).toEqual({ drift: "not_requested" });
  });

  test("parses a shell-safe fixed-position runtime literal", () => {
    expect(parseScoutRuntimeSpec("codex/gpt-5.6-sol/xhigh")).toEqual({
      ok: true,
      value: {
        harness: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
      },
    });
    expect(parseScoutRuntimeSpec("claude/fable/ultra")).toEqual({
      ok: true,
      value: { harness: "claude", model: "fable", reasoningEffort: "ultra" },
    });
    expect(parseScoutRuntimeSpec("grok/grok-4.6/xhigh")).toEqual({
      ok: true,
      value: {
        harness: "grok",
        model: "grok-4.6",
        reasoningEffort: "xhigh",
      },
    });
    expect(validateScoutRuntimeTuple({
      harness: "grok-acp",
      model: "grok-4.6",
    })).toEqual([]);
  });

  test("normalizes model aliases at the shared boundary", () => {
    for (const alias of ["6", "gpt-6", "astra"]) {
      expect(normalizeScoutRuntimeModel("codex", alias)).toEqual({
        ok: true,
        requested: alias,
        resolved: "gpt-6-astra",
      });
    }
    expect(normalizeScoutRuntimeModel("codex", "5.6")).toEqual({
      ok: true,
      requested: "5.6",
      resolved: "gpt-5.6-sol",
    });
    expect(normalizeScoutRuntimeModel("claude", "fable")).toEqual({
      ok: true,
      requested: "fable",
      resolved: "claude-fable-5-2",
    });
    // Family aliases follow the catalog's newest model, not a pinned release.
    expect(normalizeScoutRuntimeModel("claude", "opus")).toEqual({
      ok: true,
      requested: "opus",
      resolved: "claude-opus-5-5",
    });
    expect(normalizeScoutRuntimeModel("claude", "claude-opus-5")).toEqual({
      ok: true,
      requested: "claude-opus-5",
      resolved: "claude-opus-5",
    });
  });

  test("resolves a family to its newest enabled catalog model", () => {
    const catalog = {
      ...SCOUT_RUNTIME_CATALOG,
      harnesses: [{
        ...SCOUT_RUNTIME_CATALOG.harnesses.find((entry) => entry.id === "claude")!,
        models: [
          { id: "claude-opus-6", label: "Opus 6", enabled: false, family: "Opus" },
          { id: "claude-opus-5-5", label: "Opus 5.5", enabled: true, family: "Opus" },
          { id: "claude-opus-5", label: "Opus 5", enabled: true, family: "Opus" },
        ],
      }],
    };
    expect(scoutRuntimeLatestModelInFamily("claude", "Opus", catalog)).toBe("claude-opus-5-5");
    expect(scoutRuntimeLatestModelInFamily("claude", "Sonnet", catalog)).toBeUndefined();
  });

  test("does not format sparse runtime tuples ambiguously", () => {
    expect(() => formatScoutRuntimeSpec({
      harness: "codex",
      reasoningEffort: "xhigh",
    })).toThrow("cannot encode effort without a model");
  });

  test("devin with a catalog model passes model selectability", () => {
    const model = SCOUT_RUNTIME_CATALOG.harnesses
      .find((entry) => entry.id === "devin")!
      .models.find((candidate) => candidate.enabled)!.id;
    const issues = validateScoutRuntimeTuple({ harness: "devin", model });
    expect(issues.some((issue) => issue.code === "unsupported_model_dimension")).toBe(false);
  });

  test("a harness with no catalog models rejects a model", () => {
    expect(validateScoutRuntimeTuple({ harness: "kimi", model: "some-model" }))
      .toEqual([expect.objectContaining({
        code: "unsupported_model_dimension",
        dimension: "model",
      })]);
  });

  test("isModelSelectableHarness follows the catalog", () => {
    expect(isModelSelectableHarness("claude")).toBe(true);
    expect(isModelSelectableHarness("devin")).toBe(true);
    expect(isModelSelectableHarness("kimi")).toBe(false);
    expect(isModelSelectableHarness("not-a-harness")).toBe(false);
  });
});


test("runtime literal grammar preserves a future model and effort for live broker validation", () => {
  expect(parseScoutRuntimeSpec("codex/gpt-published-next/ultra")).toEqual({ ok: true,
    value: { harness: "codex", model: "gpt-published-next", reasoningEffort: "ultra" } });
  expect(parseScoutRuntimeSpec("codex/gpt-published-next/imaginary").ok).toBe(false);
  expect(parseScoutRuntimeSpec("codex//ultra").ok).toBe(false);
});

test("published family alias normalization follows live data and keeps stable Codex aliases", () => {
  const catalog = structuredClone(SCOUT_RUNTIME_CATALOG);
  const claude = catalog.harnesses.find((harness) => harness.id === "claude")!;
  claude.models = [{ id: "claude-opus-future", label: "Future Opus", family: "Opus", enabled: true, default: true }];
  expect(normalizeScoutRuntimeModel("claude", "opus", catalog)).toEqual({ ok: true, requested: "opus", resolved: "claude-opus-future" });
  expect(normalizeScoutRuntimeModel("codex", "6", catalog)).toEqual({ ok: true, requested: "6", resolved: "gpt-6-astra" });
  expect(normalizeScoutRuntimeModel("codex", "gpt-6-sol", catalog)).toEqual({ ok: true, requested: "gpt-6-sol", resolved: "gpt-6-sol" });
});
