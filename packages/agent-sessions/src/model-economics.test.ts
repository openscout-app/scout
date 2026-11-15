import { describe, expect, test } from "bun:test";

import {
  buildModelEconomicsRows,
  type SourceCatalog,
} from "../scripts/generate-model-economics.js";

import {
  FAMILY_TIER_PICKS,
  inexpensiveCognitionPick,
  modelEconomics,
  POPULAR_MODEL_FAMILIES,
  type ModelFamilyId,
} from "./model-economics.js";

describe("model economics (models.dev-backed + curated picks)", () => {
  test("every family in the popular order carries picks, and vice versa", () => {
    const ordered = new Set(POPULAR_MODEL_FAMILIES);
    const picked = new Set(Object.keys(FAMILY_TIER_PICKS));
    expect([...picked].sort()).toEqual([...ordered].sort());
  });

  test("the popular heads lead the order", () => {
    expect(POPULAR_MODEL_FAMILIES.slice(0, 4)).toEqual(["anthropic", "openai", "xai", "minimax"]);
  });

  test("every cloud pick resolves to its family's catalog row with a real price", () => {
    for (const family of POPULAR_MODEL_FAMILIES) {
      if (family === "apple") {
        expect(modelEconomics(FAMILY_TIER_PICKS.apple.inexpensive)).toBeUndefined();
        continue; // on-device, deliberately uncataloged
      }
      const pick = inexpensiveCognitionPick(family);
      expect(pick.economics, `${family}: ${pick.inexpensive} missing from catalog`).toBeDefined();
      expect(pick.economics!.family, `${family}: ${pick.inexpensive} provenance`).toBe(family);
      expect(pick.economics!.input).toBeGreaterThanOrEqual(0);
      expect(pick.economics!.output).toBeGreaterThanOrEqual(0);
    }
  });

  test("inexpensive means inexpensive: every cloud pick is ≤ $5 out per 1M", () => {
    for (const family of POPULAR_MODEL_FAMILIES) {
      if (family === "apple") continue;
      const pick = inexpensiveCognitionPick(family);
      expect(pick.economics!.output, `${family}: ${pick.inexpensive}`).toBeLessThanOrEqual(5);
    }
  });

  test("every configured budget floor resolves and is no pricier on input or output", () => {
    for (const picks of Object.values(FAMILY_TIER_PICKS)) {
      if (picks.family === "apple") {
        expect(picks.budgetFloor).toBeUndefined();
        continue;
      }

      const pick = modelEconomics(picks.inexpensive);
      expect(pick, `${picks.family}: ${picks.inexpensive} missing pick row`).toBeDefined();
      if (!picks.budgetFloor) continue;

      const floor = modelEconomics(picks.budgetFloor);
      expect(floor, `${picks.family}: ${picks.budgetFloor} missing floor row`).toBeDefined();
      expect(floor!.family, `${picks.family}: ${picks.budgetFloor} provenance`).toBe(picks.family);
      expect(floor!.input, `${picks.family}: ${picks.budgetFloor} input`).toBeLessThanOrEqual(
        pick!.input,
      );
      expect(floor!.output, `${picks.family}: ${picks.budgetFloor} output`).toBeLessThanOrEqual(
        pick!.output,
      );
    }
  });

  test("known current ids resolve with expected prices", () => {
    expect(modelEconomics("claude-haiku-4-5")).toMatchObject({ input: 1, output: 5 });
    expect(modelEconomics("gpt-5.6-luna")?.input).toBe(0.2);
    expect(modelEconomics("claude-haiku-5-5")).toMatchObject({ input: 0.1, output: 0.5 });
    expect(modelEconomics("deepseek-v4-flash")).toMatchObject({ input: 0.15, output: 0.6 });
    expect(modelEconomics("MiniMax-M3")).toMatchObject({ input: 0.3, output: 1.2 });
    expect(modelEconomics("openai/gpt-oss-20b")?.structuredOutput).toBe(true);
  });

  test("lookup canonicalizes dots, underscores, case, variants, and provider prefixes", () => {
    const expected = modelEconomics("gpt-5.6-luna");
    expect(expected).toBeDefined();
    expect(modelEconomics("GPT_5.6_LUNA")).toEqual(expected);
    expect(modelEconomics("gpt-5.6-luna:preview")).toEqual(expected);
    expect(modelEconomics("openai/gpt-5.6-luna")).toEqual(expected);
    expect(modelEconomics("  OpenAI/GPT_5.6_LUNA:Preview  ")).toEqual(expected);
  });

  test("retired ids the industry moved off are not our picks", () => {
    const pickedIds = Object.values(FAMILY_TIER_PICKS).map((p) => p.inexpensive);
    for (const retired of ["claude-3-5-haiku-latest", "deepseek-chat", "qwen-turbo"]) {
      expect(pickedIds).not.toContain(retired);
    }
  });

  test("family ids are exhaustive at the type level", () => {
    // Compile-time exhaustiveness: a new ModelFamilyId without picks fails to
    // build; this runtime line just keeps the import meaningful.
    const families: ModelFamilyId[] = Object.keys(FAMILY_TIER_PICKS) as ModelFamilyId[];
    expect(families.length).toBeGreaterThanOrEqual(12);
  });
});

describe("model economics generation", () => {
  const directGoogle = {
    models: {
      "gemini-3.1-flash-lite": {
        cost: { input: 0.25, output: 1.5 },
        limit: { context: 1_048_576 },
        structured_output: true,
      },
    },
  };
  const vertex = {
    models: {
      "gemini-3.1-flash-lite": {
        cost: { input: 99, output: 99 },
        limit: { context: 1 },
      },
      "claude-haiku-4-5@vertex": {
        cost: { input: 1, output: 5 },
      },
      "gemini-2.5-flash-tts": {
        cost: { input: 0.5, output: 10 },
        limit: { context: 32_768 },
      },
    },
  };

  test("direct Google is authoritative regardless of source object order", () => {
    const vertexFirst: SourceCatalog = {
      "google-vertex": vertex,
      google: directGoogle,
    };
    const googleFirst: SourceCatalog = {
      google: directGoogle,
      "google-vertex": vertex,
    };

    const expected = {
      family: "google",
      input: 0.25,
      output: 1.5,
      context: 1_048_576,
      structuredOutput: true,
      released: undefined,
    };
    const fromVertexFirst = buildModelEconomicsRows(vertexFirst);
    const fromGoogleFirst = buildModelEconomicsRows(googleFirst);

    expect(fromVertexFirst).toEqual(fromGoogleFirst);
    expect(fromVertexFirst.get("gemini-3-1-flash-lite")).toEqual(expected);
    expect(fromVertexFirst.get("gemini-2-5-flash-tts")?.family).toBe("google");
    expect(fromVertexFirst.has("claude-haiku-4-5@vertex")).toBe(false);
  });

  test("unhandled cross-family canonical collisions fail generation", () => {
    const fixture: SourceCatalog = {
      openai: {
        models: {
          shared_model: { cost: { input: 2, output: 4 } },
        },
      },
      anthropic: {
        models: {
          "Shared.Model": { cost: { input: 1, output: 3 } },
        },
      },
    };

    expect(() => buildModelEconomicsRows(fixture)).toThrow(
      /cross-family canonical model collision.*anthropic.*openai/u,
    );
  });

  test("hosts that resell another lab's model do not claim it", () => {
    const fixture: SourceCatalog = {
      mistral: { models: { "glm-5.2": { cost: { input: 9, output: 9 } }, "mistral-small-latest": { cost: { input: 0.1, output: 0.3 } } } },
      alibaba: { models: { "glm-5-2": { cost: { input: 8, output: 8 } }, "qwen-flash": { cost: { input: 0.05, output: 0.4 } } } },
      zai: { models: { "glm-5.2": { cost: { input: 1, output: 3 } } } },
    };
    const rows = buildModelEconomicsRows(fixture);
    expect(rows.get("glm-5-2")).toMatchObject({ family: "zai", input: 1, output: 3 });
    expect(rows.get("mistral-small-latest")?.family).toBe("mistral");
    expect(rows.get("qwen-flash")?.family).toBe("alibaba");
  });
});
