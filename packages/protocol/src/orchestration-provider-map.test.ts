import { describe, expect, test } from "bun:test";

import { buildOrchestrationProviderMap } from "./orchestration-provider-map.js";
import { scoutRuntimeHarness, scoutRuntimeReasoningEfforts } from "./runtime-execution.js";

const NOW = 1_800_000_000_000;
const NO_QUOTA = { generatedAt: NOW, generatedAtLocal: "now", providers: [] };

describe("orchestration provider map", () => {
  test("picks each role's model from the runtime catalog", () => {
    const map = buildOrchestrationProviderMap(NO_QUOTA, { now: NOW });
    const picks = Object.fromEntries(map.assignments.map((assignment) => [
      assignment.role,
      [assignment.modelLabel, assignment.route.model, assignment.route.effort],
    ]));

    expect(picks).toEqual({
      product_judgment: ["Fable 5.1", "claude-fable-5-1", "max"],
      large_context_synthesis: ["Kimi Code", null, null],
      adversarial_critique: ["Fable 5.1", "claude-fable-5-1", "max"],
      evidence_inventory: ["GPT-6 Luna", "gpt-6-luna", "medium"],
      implementation: ["GPT-6.1 Sol", "gpt-6.1-sol", "xhigh"],
      code_review: ["GPT-6 Astra", "gpt-6-astra", "high"],
    });
  });

  test("routes only enabled catalog models at efforts the catalog allows", () => {
    const map = buildOrchestrationProviderMap(NO_QUOTA, { now: NOW });

    expect(map.models.map((model) => model.modelLabel)).toEqual([
      "Fable 5.1", "GPT-6.1 Sol", "Grok 4.6", "Kimi Code", "Opus 5.5", "GLM-5.2",
      "GPT-6 Astra", "GPT-6 Luna", "Haiku 5.5", "Sonnet 5.5", "DeepSeek V4 Pro",
    ]);
    for (const { modelLabel, route } of map.models) {
      if (route.model === null) continue;
      const entry = scoutRuntimeHarness(route.harness)?.models.find((model) => model.id === route.model);
      expect(entry?.enabled, modelLabel).toBe(true);
      expect(modelLabel).toEndWith(entry!.label);
      if (route.effort) expect(scoutRuntimeReasoningEfforts(route.harness, route.model), modelLabel).toContain(route.effort);
    }
  });

  test("offers no MiniMax route", () => {
    const map = buildOrchestrationProviderMap(NO_QUOTA, { now: NOW });

    expect(map.models.some((model) => model.route.providerId === "minimax" || /minimax/iu.test(model.route.model ?? ""))).toBe(false);
    expect(map.assignments.find((assignment) => assignment.role === "evidence_inventory")?.alternatives.map((alternative) => alternative.label))
      .toEqual(["Haiku 5.5"]);
  });
});
