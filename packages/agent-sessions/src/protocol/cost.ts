export type AdapterCostProvider = "openai" | "anthropic" | "unknown";

export type AdapterCostUsage = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningOutputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  totalTokens?: number | null;
  webSearchRequests?: number | null;
  webFetchRequests?: number | null;
  planType?: string | null;
};

export type AdapterSubscriptionWindowSnapshot = {
  label: "5h" | "weekly" | string;
  capturedAt: number;
  percentRemaining: number | null;
  used: number | null;
  limit: number | null;
  resetAt: number | null;
  source: "provider" | "observed" | "estimated";
};

export type AdapterCostInput = {
  provider?: string | null;
  adapterType?: string | null;
  model?: string | null;
  usage?: AdapterCostUsage | null;
  billingMode?: "api" | "subscription" | null;
  capturedAt?: number | null;
  subscriptionWindows?: AdapterSubscriptionWindowSnapshot[] | null;
};

export type AdapterCostRateCard = {
  provider: AdapterCostProvider;
  model: string;
  inputPerM: number;
  cachedInputPerM: number | null;
  cacheWritePerM: number | null;
  outputPerM: number;
  webSearchPer1K?: number | null;
};

export type AdapterTokenBreakdown = {
  input: number | null;
  uncachedInput: number | null;
  cachedInput: number | null;
  cacheWrite: number | null;
  output: number | null;
  reasoningOutput: number | null;
  total: number | null;
  webSearchRequests: number | null;
  webFetchRequests: number | null;
};

export type AdapterCostLineItem = {
  key: "input" | "cached_input" | "cache_write" | "output" | "web_search";
  label: string;
  quantity: number;
  unit: "tokens" | "requests";
  rate: number;
  billedRate: number;
  costUsd: number;
  billedCostUsd: number;
};

export type AdapterCostEstimate = {
  provider: AdapterCostProvider;
  model: string | null;
  rateCard: AdapterCostRateCard | null;
  rateCardSource: "exact" | "alias" | "provider-default" | "unknown";
  capturedAt: number;
  usage: AdapterTokenBreakdown;
  lineItems: AdapterCostLineItem[];
  totalUsd: number | null;
  billedTotalUsd: number | null;
  billingMode: "api" | "subscription";
  subscriptionWindows: AdapterSubscriptionWindowSnapshot[];
};

const OPENAI_PROVIDER_HINTS = ["openai", "codex", "codex_app_server"];
const ANTHROPIC_PROVIDER_HINTS = ["anthropic", "claude", "claude-code", "claude_stream_json"];

const RATE_CARDS: Record<string, AdapterCostRateCard> = {
  "openai:gpt-5.5": { provider: "openai", model: "gpt-5.5", inputPerM: 5, cachedInputPerM: 0.5, cacheWritePerM: null, outputPerM: 30, webSearchPer1K: 10 },
  "openai:gpt-5.5-pro": { provider: "openai", model: "gpt-5.5-pro", inputPerM: 30, cachedInputPerM: null, cacheWritePerM: null, outputPerM: 180, webSearchPer1K: 10 },
  "openai:gpt-5.4": { provider: "openai", model: "gpt-5.4", inputPerM: 2.5, cachedInputPerM: 0.25, cacheWritePerM: null, outputPerM: 15, webSearchPer1K: 10 },
  "openai:gpt-5.4-mini": { provider: "openai", model: "gpt-5.4-mini", inputPerM: 0.75, cachedInputPerM: 0.075, cacheWritePerM: null, outputPerM: 4.5, webSearchPer1K: 10 },
  "openai:gpt-5.4-nano": { provider: "openai", model: "gpt-5.4-nano", inputPerM: 0.2, cachedInputPerM: 0.02, cacheWritePerM: null, outputPerM: 1.25, webSearchPer1K: 10 },
  "openai:gpt-5.4-pro": { provider: "openai", model: "gpt-5.4-pro", inputPerM: 30, cachedInputPerM: null, cacheWritePerM: null, outputPerM: 180, webSearchPer1K: 10 },
  "openai:gpt-5.3-codex": { provider: "openai", model: "gpt-5.3-codex", inputPerM: 1.75, cachedInputPerM: 0.175, cacheWritePerM: null, outputPerM: 14, webSearchPer1K: 10 },
  "openai:gpt-5.3-chat-latest": { provider: "openai", model: "gpt-5.3-chat-latest", inputPerM: 1.75, cachedInputPerM: 0.175, cacheWritePerM: null, outputPerM: 14, webSearchPer1K: 10 },
  "openai:gpt-5.2": { provider: "openai", model: "gpt-5.2", inputPerM: 1.75, cachedInputPerM: 0.175, cacheWritePerM: null, outputPerM: 14, webSearchPer1K: 10 },
  "openai:gpt-5.2-codex": { provider: "openai", model: "gpt-5.2-codex", inputPerM: 1.75, cachedInputPerM: 0.175, cacheWritePerM: null, outputPerM: 14, webSearchPer1K: 10 },
  "openai:gpt-5.2-chat-latest": { provider: "openai", model: "gpt-5.2-chat-latest", inputPerM: 1.75, cachedInputPerM: 0.175, cacheWritePerM: null, outputPerM: 14, webSearchPer1K: 10 },
  "openai:gpt-5.2-pro": { provider: "openai", model: "gpt-5.2-pro", inputPerM: 21, cachedInputPerM: null, cacheWritePerM: null, outputPerM: 168, webSearchPer1K: 10 },
  "openai:gpt-5.1": { provider: "openai", model: "gpt-5.1", inputPerM: 1.25, cachedInputPerM: 0.125, cacheWritePerM: null, outputPerM: 10, webSearchPer1K: 10 },
  "openai:gpt-5.1-codex": { provider: "openai", model: "gpt-5.1-codex", inputPerM: 1.25, cachedInputPerM: 0.125, cacheWritePerM: null, outputPerM: 10, webSearchPer1K: 10 },
  "openai:gpt-5.1-codex-max": { provider: "openai", model: "gpt-5.1-codex-max", inputPerM: 1.25, cachedInputPerM: 0.125, cacheWritePerM: null, outputPerM: 10, webSearchPer1K: 10 },
  "openai:gpt-5.1-chat-latest": { provider: "openai", model: "gpt-5.1-chat-latest", inputPerM: 1.25, cachedInputPerM: 0.125, cacheWritePerM: null, outputPerM: 10, webSearchPer1K: 10 },
  "openai:gpt-5": { provider: "openai", model: "gpt-5", inputPerM: 1.25, cachedInputPerM: 0.125, cacheWritePerM: null, outputPerM: 10, webSearchPer1K: 10 },
  "openai:gpt-5-codex": { provider: "openai", model: "gpt-5-codex", inputPerM: 1.25, cachedInputPerM: 0.125, cacheWritePerM: null, outputPerM: 10, webSearchPer1K: 10 },
  "openai:gpt-5-chat-latest": { provider: "openai", model: "gpt-5-chat-latest", inputPerM: 1.25, cachedInputPerM: 0.125, cacheWritePerM: null, outputPerM: 10, webSearchPer1K: 10 },
  "openai:gpt-5-mini": { provider: "openai", model: "gpt-5-mini", inputPerM: 0.25, cachedInputPerM: 0.025, cacheWritePerM: null, outputPerM: 2, webSearchPer1K: 10 },
  "openai:gpt-5-nano": { provider: "openai", model: "gpt-5-nano", inputPerM: 0.05, cachedInputPerM: 0.005, cacheWritePerM: null, outputPerM: 0.4, webSearchPer1K: 10 },
  "openai:gpt-5-pro": { provider: "openai", model: "gpt-5-pro", inputPerM: 15, cachedInputPerM: null, cacheWritePerM: null, outputPerM: 120, webSearchPer1K: 10 },
  "openai:gpt-4.1": { provider: "openai", model: "gpt-4.1", inputPerM: 2, cachedInputPerM: 0.5, cacheWritePerM: null, outputPerM: 8, webSearchPer1K: 10 },
  "openai:gpt-4.1-mini": { provider: "openai", model: "gpt-4.1-mini", inputPerM: 0.4, cachedInputPerM: 0.1, cacheWritePerM: null, outputPerM: 1.6, webSearchPer1K: 10 },
  "openai:gpt-4.1-nano": { provider: "openai", model: "gpt-4.1-nano", inputPerM: 0.1, cachedInputPerM: 0.025, cacheWritePerM: null, outputPerM: 0.4, webSearchPer1K: 10 },
  "openai:gpt-4o": { provider: "openai", model: "gpt-4o", inputPerM: 2.5, cachedInputPerM: 1.25, cacheWritePerM: null, outputPerM: 10, webSearchPer1K: 10 },
  "openai:gpt-4o-mini": { provider: "openai", model: "gpt-4o-mini", inputPerM: 0.15, cachedInputPerM: 0.075, cacheWritePerM: null, outputPerM: 0.6, webSearchPer1K: 10 },
  "anthropic:claude-fable-5.2": { provider: "anthropic", model: "claude-fable-5.2", inputPerM: 8, cachedInputPerM: 0.8, cacheWritePerM: 10, outputPerM: 40, webSearchPer1K: 10 },
  "anthropic:claude-fable-5.1": { provider: "anthropic", model: "claude-fable-5.1", inputPerM: 10, cachedInputPerM: 1, cacheWritePerM: 12.5, outputPerM: 50, webSearchPer1K: 10 },
  "anthropic:claude-fable-5": { provider: "anthropic", model: "claude-fable-5", inputPerM: 10, cachedInputPerM: 1, cacheWritePerM: 12.5, outputPerM: 50, webSearchPer1K: 10 },
  "anthropic:claude-opus-5.5": { provider: "anthropic", model: "claude-opus-5.5", inputPerM: 4, cachedInputPerM: 0.4, cacheWritePerM: 5, outputPerM: 20, webSearchPer1K: 10 },
  "anthropic:claude-sonnet-5.5": { provider: "anthropic", model: "claude-sonnet-5.5", inputPerM: 2, cachedInputPerM: 0.2, cacheWritePerM: 2.5, outputPerM: 10, webSearchPer1K: 10 },
  // Haiku 5.5 bills prompts above 100K tokens at $0.50/$2.50; this card holds the base tier.
  "anthropic:claude-haiku-5.5": { provider: "anthropic", model: "claude-haiku-5.5", inputPerM: 0.1, cachedInputPerM: 0.01, cacheWritePerM: 0.125, outputPerM: 0.5, webSearchPer1K: 10 },
  "anthropic:claude-opus-5": { provider: "anthropic", model: "claude-opus-5", inputPerM: 5, cachedInputPerM: 0.5, cacheWritePerM: 6.25, outputPerM: 25, webSearchPer1K: 10 },
  "anthropic:claude-sonnet-5": { provider: "anthropic", model: "claude-sonnet-5", inputPerM: 2, cachedInputPerM: 0.2, cacheWritePerM: 2.5, outputPerM: 10, webSearchPer1K: 10 },
  "anthropic:claude-opus-4.8": { provider: "anthropic", model: "claude-opus-4.8", inputPerM: 5, cachedInputPerM: 0.5, cacheWritePerM: 6.25, outputPerM: 25, webSearchPer1K: 10 },
  "anthropic:claude-opus-4.7": { provider: "anthropic", model: "claude-opus-4.7", inputPerM: 5, cachedInputPerM: 0.5, cacheWritePerM: 6.25, outputPerM: 25, webSearchPer1K: 10 },
  "anthropic:claude-opus-4.6": { provider: "anthropic", model: "claude-opus-4.6", inputPerM: 5, cachedInputPerM: 0.5, cacheWritePerM: 6.25, outputPerM: 25, webSearchPer1K: 10 },
  "anthropic:claude-opus-4.5": { provider: "anthropic", model: "claude-opus-4.5", inputPerM: 5, cachedInputPerM: 0.5, cacheWritePerM: 6.25, outputPerM: 25, webSearchPer1K: 10 },
  "anthropic:claude-opus-4.1": { provider: "anthropic", model: "claude-opus-4.1", inputPerM: 15, cachedInputPerM: 1.5, cacheWritePerM: 18.75, outputPerM: 75, webSearchPer1K: 10 },
  "anthropic:claude-opus-4": { provider: "anthropic", model: "claude-opus-4", inputPerM: 15, cachedInputPerM: 1.5, cacheWritePerM: 18.75, outputPerM: 75, webSearchPer1K: 10 },
  "anthropic:claude-sonnet-4.6": { provider: "anthropic", model: "claude-sonnet-4.6", inputPerM: 3, cachedInputPerM: 0.3, cacheWritePerM: 3.75, outputPerM: 15, webSearchPer1K: 10 },
  "anthropic:claude-sonnet-4.5": { provider: "anthropic", model: "claude-sonnet-4.5", inputPerM: 3, cachedInputPerM: 0.3, cacheWritePerM: 3.75, outputPerM: 15, webSearchPer1K: 10 },
  "anthropic:claude-sonnet-4": { provider: "anthropic", model: "claude-sonnet-4", inputPerM: 3, cachedInputPerM: 0.3, cacheWritePerM: 3.75, outputPerM: 15, webSearchPer1K: 10 },
  "anthropic:claude-3-7-sonnet": { provider: "anthropic", model: "claude-3-7-sonnet", inputPerM: 3, cachedInputPerM: 0.3, cacheWritePerM: 3.75, outputPerM: 15, webSearchPer1K: 10 },
  "anthropic:claude-haiku-4.5": { provider: "anthropic", model: "claude-haiku-4.5", inputPerM: 1, cachedInputPerM: 0.1, cacheWritePerM: 1.25, outputPerM: 5, webSearchPer1K: 10 },
};

/**
 * Two layers, both explicit. Layer 1 maps each string a harness or API
 * reports to one card key: a card answers to its own `model` name plus the
 * extra spellings listed here. Layer 2 is RATE_CARDS, which holds the
 * provider and prices. A string in neither layer is not priced. Add new ids
 * and snapshots here rather than matching names by pattern.
 */
const CARD_MODEL_IDS: Record<string, readonly string[]> = {
  "anthropic:claude-fable-5.2": ["claude-fable-5-2"],
  "anthropic:claude-fable-5.1": ["claude-fable-5-1"],
  "anthropic:claude-fable-5": ["claude-fable-5"],
  "anthropic:claude-opus-5.5": ["claude-opus-5-5"],
  "anthropic:claude-sonnet-5.5": ["claude-sonnet-5-5"],
  "anthropic:claude-haiku-5.5": ["claude-haiku-5-5"],
  "anthropic:claude-opus-5": ["claude-opus-5"],
  "anthropic:claude-sonnet-5": ["claude-sonnet-5"],
  "anthropic:claude-opus-4.8": ["claude-opus-4-8"],
  "anthropic:claude-opus-4.7": ["claude-opus-4-7"],
  "anthropic:claude-opus-4.6": ["claude-opus-4-6"],
  "anthropic:claude-opus-4.5": ["claude-opus-4-5", "claude-opus-4-5-20251101"],
  "anthropic:claude-opus-4.1": ["claude-opus-4-1", "claude-opus-4-1-20250805"],
  "anthropic:claude-opus-4": ["claude-opus-4-0", "claude-opus-4-20250514"],
  "anthropic:claude-sonnet-4.6": ["claude-sonnet-4-6"],
  "anthropic:claude-sonnet-4.5": ["claude-sonnet-4-5", "claude-sonnet-4-5-20250929"],
  "anthropic:claude-sonnet-4": ["claude-sonnet-4-0", "claude-sonnet-4-20250514"],
  "anthropic:claude-3-7-sonnet": ["claude-3-7-sonnet-latest", "claude-3-7-sonnet-20250219"],
  "anthropic:claude-haiku-4.5": ["claude-haiku-4-5", "claude-haiku-4-5-20251001"],
};

/** Layer 1: reported model string -> card key. */
const MODEL_ID_CARDS = new Map<string, string>([
  ...Object.entries(RATE_CARDS).map(([key, card]) => [card.model, key] as const),
  ...Object.entries(CARD_MODEL_IDS).flatMap(([key, ids]) => ids.map((id) => [id, key] as const)),
]);

/** The card a reported model string names, if any. */
function cardForModel(model: string | null): AdapterCostRateCard | null {
  const key = model ? MODEL_ID_CARDS.get(model) : undefined;
  return key ? RATE_CARDS[key] ?? null : null;
}

export function normalizeAdapterCostProvider(input: {
  provider?: string | null;
  adapterType?: string | null;
  model?: string | null;
}): AdapterCostProvider {
  const provider = input.provider?.trim().toLowerCase() ?? "";
  const adapterType = input.adapterType?.trim().toLowerCase() ?? "";
  const model = normalizeAdapterCostModel(input.model) ?? "";
  const haystack = [provider, adapterType].filter(Boolean);
  if (haystack.some((value) => OPENAI_PROVIDER_HINTS.some((hint) => value.includes(hint)))) {
    return "openai";
  }
  if (haystack.some((value) => ANTHROPIC_PROVIDER_HINTS.some((hint) => value.includes(hint)))) {
    return "anthropic";
  }
  // Otherwise the provider is the one on the model's card.
  return cardForModel(model)?.provider ?? "unknown";
}

export function normalizeAdapterCostModel(model: string | null | undefined): string | null {
  if (!model) return null;
  // The id as the provider reports it. Other spellings are listed in
  // CARD_MODEL_IDS, never rewritten here.
  return model.trim().toLowerCase();
}

export function adapterTokenBreakdown(usage: AdapterCostUsage | null | undefined): AdapterTokenBreakdown {
  const input = numberOrNull(usage?.inputTokens);
  const cachedInput = numberOrNull(usage?.cacheReadInputTokens);
  const cacheWrite = numberOrNull(usage?.cacheCreationInputTokens);
  const output = numberOrNull(usage?.outputTokens);
  const reasoningOutput = numberOrNull(usage?.reasoningOutputTokens);
  const observedTotal = [input, output].reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const total = numberOrNull(usage?.totalTokens) ?? (observedTotal || null);
  return {
    input,
    uncachedInput: input == null ? null : Math.max(0, input - (cachedInput ?? 0) - (cacheWrite ?? 0)),
    cachedInput,
    cacheWrite,
    output,
    reasoningOutput,
    total,
    webSearchRequests: numberOrNull(usage?.webSearchRequests),
    webFetchRequests: numberOrNull(usage?.webFetchRequests),
  };
}

export function estimateAdapterCost(input: AdapterCostInput): AdapterCostEstimate {
  const provider = normalizeAdapterCostProvider(input);
  const model = normalizeAdapterCostModel(input.model);
  const usage = adapterTokenBreakdown(input.usage);
  const resolved = resolveRateCard(provider, model);
  const billingMode = resolveBillingMode(input);
  if (!resolved.rateCard) {
    return {
      provider,
      model,
      rateCard: null,
      rateCardSource: "unknown",
      capturedAt: input.capturedAt ?? Date.now(),
      usage,
      lineItems: [],
      totalUsd: null,
      billedTotalUsd: null,
      billingMode,
      subscriptionWindows: input.subscriptionWindows ?? [],
    };
  }

  const rateCard = resolved.rateCard;
  const uncachedInput = usage.uncachedInput ?? usage.input ?? 0;
  const cachedInput = usage.cachedInput ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const output = usage.output ?? 0;
  const webSearchRequests = usage.webSearchRequests ?? 0;
  const lineItems: AdapterCostLineItem[] = [
    tokenLine("input", "Input", uncachedInput, rateCard.inputPerM, billingMode),
    tokenLine("cached_input", "Cached input", cachedInput, rateCard.cachedInputPerM ?? rateCard.inputPerM, billingMode),
    tokenLine("cache_write", "Cache write", cacheWrite, rateCard.cacheWritePerM ?? rateCard.inputPerM, billingMode),
    tokenLine("output", "Output", output, rateCard.outputPerM, billingMode),
    {
      key: "web_search" as const,
      label: "Web search",
      quantity: webSearchRequests,
      unit: "requests" as const,
      rate: rateCard.webSearchPer1K ?? 0,
      billedRate: billingMode === "subscription" ? 0 : (rateCard.webSearchPer1K ?? 0),
      costUsd: (webSearchRequests / 1_000) * (rateCard.webSearchPer1K ?? 0),
      billedCostUsd: billingMode === "subscription" ? 0 : (webSearchRequests / 1_000) * (rateCard.webSearchPer1K ?? 0),
    },
  ].filter((item) => item.quantity > 0);

  return {
    provider,
    model,
    rateCard,
    rateCardSource: resolved.source,
    capturedAt: input.capturedAt ?? Date.now(),
    usage,
    lineItems,
    totalUsd: lineItems.reduce((sum, item) => sum + item.costUsd, 0),
    billedTotalUsd: lineItems.reduce((sum, item) => sum + item.billedCostUsd, 0),
    billingMode,
    subscriptionWindows: input.subscriptionWindows ?? [],
  };
}

function resolveRateCard(
  provider: AdapterCostProvider,
  model: string | null,
): { rateCard: AdapterCostRateCard | null; source: AdapterCostEstimate["rateCardSource"] } {
  const card = cardForModel(model);
  // No card, or a card from another provider: no price. Never an older
  // model's rates guessed from the name.
  if (!card || card.provider !== provider) return { rateCard: null, source: "unknown" };
  return { rateCard: card, source: card.model === model ? "exact" : "alias" };
}

function tokenLine(
  key: Extract<AdapterCostLineItem["key"], "input" | "cached_input" | "cache_write" | "output">,
  label: string,
  quantity: number,
  rate: number,
  billingMode: AdapterCostEstimate["billingMode"],
): AdapterCostLineItem {
  const billedRate = billingMode === "subscription" ? 0 : rate;
  return {
    key,
    label,
    quantity,
    unit: "tokens",
    rate,
    billedRate,
    costUsd: (quantity / 1_000_000) * rate,
    billedCostUsd: (quantity / 1_000_000) * billedRate,
  };
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function resolveBillingMode(input: AdapterCostInput): AdapterCostEstimate["billingMode"] {
  if (input.billingMode) return input.billingMode;
  const adapterType = input.adapterType?.trim().toLowerCase();
  if (adapterType === "claude-code" || adapterType === "claude_stream_json") {
    return "subscription";
  }
  const planType = input.usage?.planType?.trim().toLowerCase();
  if (!planType) return "api";
  if (planType === "api" || planType.includes("api")) return "api";
  return "subscription";
}
