import { describe, expect, test } from "bun:test";

import {
  applyRuntimeModelContextWindows,
  catalogContextWindowTokens,
  MODEL_WINDOW_OVERRIDES,
} from "./model-catalog.js";

import { RUNTIME_MODEL_CONTEXT_WINDOWS } from "./runtime-model-windows.generated.js";

describe("model catalog (models.dev-backed)", () => {
  test("Claude windows are per VERSION (5 ≠ 4.5)", () => {
    expect(catalogContextWindowTokens("claude-opus-5")).toBe(1_000_000);
    expect(catalogContextWindowTokens("claude-opus-4-8")).toBe(1_000_000);
    expect(catalogContextWindowTokens("claude-opus-4-5")).toBe(200_000);
    expect(catalogContextWindowTokens("claude-sonnet-4-6")).toBe(1_000_000);
    expect(catalogContextWindowTokens("claude-sonnet-4-5")).toBe(200_000);
  });

  test("knows the raw model windows for GPT-6 / GPT-5 / Grok / Gemini / MiniMax", () => {
    expect(catalogContextWindowTokens("gpt-6-astra")).toBe(1_050_000);
    expect(catalogContextWindowTokens("gpt-5")).toBe(400_000);
    expect(catalogContextWindowTokens("gpt-5.5")).toBe(1_050_000); // RAW window — Codex caps this separately
    expect(catalogContextWindowTokens("grok-4.6")).toBe(500_000);
    expect(catalogContextWindowTokens("grok-4.3")).toBe(1_000_000);
    expect(catalogContextWindowTokens("gemini-2.5-pro")).toBe(1_048_576);
    expect(catalogContextWindowTokens("MiniMax-M3")).toBe(512_000);
  });

  test("canonicalizes dot/dash/underscore separators and casing", () => {
    expect(catalogContextWindowTokens("GPT-5.5")).toBe(catalogContextWindowTokens("gpt-5-5"));
    expect(catalogContextWindowTokens("claude_opus_4_8")).toBe(1_000_000);
  });

  test("strips a provider prefix and an :effort suffix (pi-style ids)", () => {
    expect(catalogContextWindowTokens("anthropic/claude-opus-4-8")).toBe(1_000_000);
    expect(catalogContextWindowTokens("anthropic/claude-sonnet-4-6:medium")).toBe(1_000_000);
  });

  test("overrides win and cover models missing from the generated catalog", () => {
    expect(MODEL_WINDOW_OVERRIDES["claude-opus-5"]).toBe(1_000_000);
    expect(catalogContextWindowTokens("claude-opus-5")).toBe(1_000_000);
    expect(MODEL_WINDOW_OVERRIDES["gpt-6-astra"]).toBe(1_050_000);
    expect(catalogContextWindowTokens("gpt-6-astra")).toBe(1_050_000);
    expect(MODEL_WINDOW_OVERRIDES["grok-4"]).toBe(256_000);
    expect(catalogContextWindowTokens("grok-4")).toBe(256_000);
    expect(catalogContextWindowTokens("grok-code-fast-1")).toBe(256_000);
  });

  test("unknown / empty ids resolve to undefined (caller applies its default)", () => {
    expect(catalogContextWindowTokens("totally-made-up-model")).toBeUndefined();
    expect(catalogContextWindowTokens("")).toBeUndefined();
    expect(catalogContextWindowTokens(null)).toBeUndefined();
  });

  test("adopts context windows from scoutd's live catalog without a rebuild", () => {
    try {
      applyRuntimeModelContextWindows({ "grok-live": 777_000 });
      expect(catalogContextWindowTokens("grok-live")).toBe(777_000);
    } finally {
      applyRuntimeModelContextWindows(RUNTIME_MODEL_CONTEXT_WINDOWS);
    }
  });
});
