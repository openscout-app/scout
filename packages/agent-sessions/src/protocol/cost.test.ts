import { describe, expect, test } from "bun:test";
import { estimateAdapterCost } from "@openscout/agent-sessions/protocol/cost";

describe("adapter cost estimates", () => {
  test("prices OpenAI tokens with cached input and output split", () => {
    const estimate = estimateAdapterCost({
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        inputTokens: 1_000_000,
        cacheReadInputTokens: 200_000,
        outputTokens: 100_000,
      },
      capturedAt: 1,
    });

    expect(estimate.rateCardSource).toBe("exact");
    expect(estimate.billingMode).toBe("api");
    expect(estimate.usage.uncachedInput).toBe(800_000);
    expect(estimate.totalUsd).toBeCloseTo(3.55, 6);
    expect(estimate.billedTotalUsd).toBeCloseTo(3.55, 6);
  });

  test("prices Anthropic cache writes separately from cache reads", () => {
    const estimate = estimateAdapterCost({
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      usage: {
        inputTokens: 100_000,
        cacheCreationInputTokens: 1_000_000,
        cacheReadInputTokens: 2_000_000,
        outputTokens: 50_000,
      },
      capturedAt: 1,
    });

    expect(estimate.rateCardSource).toBe("alias");
    expect(estimate.usage.uncachedInput).toBe(0);
    expect(estimate.totalUsd).toBeCloseTo(5.1, 6);
  });

  test("prices the current Claude models from their own rate cards", () => {
    const priced = (model: string) => estimateAdapterCost({
      provider: "anthropic",
      model,
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      capturedAt: 1,
    });
    for (const [model, total] of [
      ["claude-fable-5-2", 48],
      ["claude-fable-5-1", 60],
      ["claude-opus-5-5", 24],
      ["claude-sonnet-5-5", 12],
      ["claude-haiku-5-5", 0.6],
    ] as const) {
      const estimate = priced(model);
      expect(estimate.rateCardSource).toBe("alias");
      expect(estimate.totalUsd).toBeCloseTo(total, 6);
    }
  });

  test("prices a model only from the card its id is listed under", () => {
    const priced = (model: string | null) => estimateAdapterCost({
      provider: "anthropic",
      model,
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      capturedAt: 1,
    });
    for (const [model, total] of [
      ["claude-opus-4-7", 30],
      ["claude-opus-4-8", 30],
      ["claude-opus-5", 30],
      ["claude-sonnet-5", 12],
      ["claude-haiku-4-5-20251001", 6],
      ["claude-3-7-sonnet-20250219", 18],
    ] as const) {
      expect(priced(model).totalUsd, model).toBeCloseTo(total, 6);
    }
    // No listed id, no price: never an older model's rates guessed from the name.
    for (const model of ["claude-haiku-6", "claude-haiku-5-5-20990101", "claude-sonnet-next", null]) {
      const estimate = priced(model);
      expect(estimate.rateCardSource, String(model)).toBe("unknown");
      expect(estimate.totalUsd, String(model)).toBeNull();
    }
  });

  test("marks subscription-covered usage down while preserving API-equivalent cost", () => {
    const estimate = estimateAdapterCost({
      provider: "openai",
      model: "gpt-5.4",
      billingMode: "subscription",
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
      },
      capturedAt: 1,
    });

    expect(estimate.totalUsd).toBeCloseTo(4, 6);
    expect(estimate.billedTotalUsd).toBe(0);
    expect(estimate.lineItems[0]?.rate).toBe(2.5);
    expect(estimate.lineItems[0]?.billedRate).toBe(0);
  });

  test("treats local Claude Code sessions as subscription-covered by default", () => {
    const estimate = estimateAdapterCost({
      adapterType: "claude-code",
      model: "claude-opus-4-7",
      usage: {
        cacheReadInputTokens: 1_000_000,
        outputTokens: 10_000,
      },
      capturedAt: 1,
    });

    expect(estimate.provider).toBe("anthropic");
    expect(estimate.billingMode).toBe("subscription");
    expect(estimate.totalUsd).toBeGreaterThan(0);
    expect(estimate.billedTotalUsd).toBe(0);
  });
});
