import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CODEX_GPT5_CONTEXT_WINDOW_TOKENS } from "./adapters/codex/context-window.js";
import {
  clearObservedContextWindows,
  recordObservedContextWindow,
} from "./model-window-registry.js";
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  inferModelContextWindowTokens,
} from "./model-context-window.js";

// Dispatch precedence: learned registry → Codex cap → per-model catalog → default.
// The catalog values themselves are unit-tested in model-catalog.test.ts.
describe("inferModelContextWindowTokens (dispatch)", () => {
  beforeEach(clearObservedContextWindows);
  afterEach(clearObservedContextWindows);

  test("Codex GPT-5.x is capped at its real logged budget (258,400), not the model's raw window", () => {
    expect(CODEX_GPT5_CONTEXT_WINDOW_TOKENS).toBe(258_400);
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-5"]) {
      expect(inferModelContextWindowTokens({ model })).toBe(258_400);
    }
    // even an unknown model arrives capped when the adapter is codex
    expect(inferModelContextWindowTokens({ model: "o4-mini", adapterType: "codex" })).toBe(258_400);
  });

  test("Codex GPT-6 Astra uses its model-specific 1.05M window", () => {
    expect(inferModelContextWindowTokens({ model: "gpt-6-astra" })).toBe(1_050_000);
    expect(inferModelContextWindowTokens({ model: "gpt-6-astra", adapterType: "codex" })).toBe(1_050_000);
  });

  test("Codex GPT-6.2 uses the context window for the selected model", () => {
    expect(inferModelContextWindowTokens({ model: "gpt-6.2-sol", adapterType: "codex" })).toBe(500_000);
    expect(inferModelContextWindowTokens({ model: "gpt-6.2-astra", adapterType: "codex" })).toBe(272_000);
  });

  test("Claude resolves PER VERSION from the catalog", () => {
    expect(inferModelContextWindowTokens({ model: "claude-opus-5" })).toBe(1_000_000);
    expect(inferModelContextWindowTokens({ model: "claude-opus-4-8" })).toBe(1_000_000);
    expect(inferModelContextWindowTokens({ model: "claude-sonnet-4-6" })).toBe(1_000_000);
    expect(inferModelContextWindowTokens({ model: "claude-opus-4-5" })).toBe(200_000);
    expect(inferModelContextWindowTokens({ model: "claude-sonnet-4-5" })).toBe(200_000);
    expect(inferModelContextWindowTokens({ model: "anthropic/claude-opus-4-7" })).toBe(1_000_000);
  });

  test("Grok resolves by model via the catalog/overrides, regardless of adapterType", () => {
    expect(inferModelContextWindowTokens({ model: "grok-4.3" })).toBe(1_000_000); // catalog
    expect(inferModelContextWindowTokens({ model: "grok-4" })).toBe(256_000); // override
    // rides the claude-code log → still resolved by model, not a claude default
    expect(
      inferModelContextWindowTokens({ model: "grok-4.3", adapterType: "claude-code" }),
    ).toBe(1_000_000);
  });

  test("a window learned from logs (once per model) overrides everything below it", () => {
    // e.g. a provider bumps a model's window — track it from real data, even over the codex cap
    recordObservedContextWindow("gpt-5.5", 300_000);
    expect(inferModelContextWindowTokens({ model: "gpt-5.5" })).toBe(300_000);
  });

  test("a fully unknown model uses the conservative default", () => {
    expect(inferModelContextWindowTokens({ model: "who-knows" })).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(inferModelContextWindowTokens({ model: "mystery", adapterType: "claude" })).toBe(
      DEFAULT_CONTEXT_WINDOW_TOKENS,
    );
    expect(inferModelContextWindowTokens({})).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
  });

  test("normalization tolerates underscores, casing, and whitespace", () => {
    expect(inferModelContextWindowTokens({ model: "GPT_5.5" })).toBe(258_400);
    expect(inferModelContextWindowTokens({ model: "  Claude-OPUS-5 " })).toBe(1_000_000);
  });
});
