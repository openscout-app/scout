import { MODEL_ECONOMICS, type ModelEconomicsEntry } from "./model-economics.generated.js";

/**
 * The consummate models representation: models.dev-backed economics
 * (model-economics.generated.ts) with a curated opinion layered on top.
 *
 * The opinion has two axes:
 *
 * 1. POPULAR_MODEL_FAMILIES — the order product surfaces present families
 *    in: the popular heads first (Claude, OpenAI, OpenRouter as the gateway,
 *    MiniMax, Grok-with-a-K), then the long tail. Access paths like OpenCode
 *    and Pi are harnesses, not families — they ride these families' models —
 *    so they don't appear here; this list is about whose models they are.
 *
 * 2. FAMILY_TIER_PICKS — per family, the clear winner per cost tier. The
 *    `inexpensive` tier is the one products should default to for cheap
 *    cognition: classification, extraction, structuring, reconciliation —
 *    calls where the answer is checkable and the token bill must not be the
 *    reason the feature stays off.
 *
 * Pure (no node deps) so it rides the browser bundle. Prices are USD per 1M
 * tokens and come from the generated catalog — a pick with no catalog row is
 * a test failure, which is what keeps this list honest as models retire.
 */

export type ModelFamilyId =
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "minimax"
  | "deepseek"
  | "alibaba"
  | "moonshotai"
  | "mistral"
  | "zai"
  | "groq"
  | "apple";

/** Popular heads first, then the long tail — product display order. */
export const POPULAR_MODEL_FAMILIES: ModelFamilyId[] = [
  "anthropic",
  "openai",
  "xai",
  "minimax",
  "google",
  "deepseek",
  "mistral",
  "alibaba",
  "moonshotai",
  "zai",
  "groq",
  "apple",
];

export type FamilyTierPicks = {
  family: ModelFamilyId;
  label: string;
  /** The clear winner for cheap cognition — exact API model id. */
  inexpensive: string;
  /** Cheaper-still floor when quality can drop another notch, if one exists. */
  budgetFloor?: string;
  /** Notes a product surface may show (access path, caveats). */
  note?: string;
};

/**
 * Verified against native-provider pricing pages and models.dev, 2026-11-10.
 * `apple` has no catalog row: on-device Foundation Models are free and
 * private, which is why it exists here at all — it is the zero-cost tier.
 */
export const FAMILY_TIER_PICKS: Record<ModelFamilyId, FamilyTierPicks> = {
  anthropic: {
    family: "anthropic",
    label: "Claude",
    inexpensive: "claude-haiku-5-5",
  },
  openai: {
    family: "openai",
    label: "OpenAI",
    inexpensive: "gpt-5.6-luna",
    budgetFloor: "gpt-5-nano",
  },
  xai: {
    family: "xai",
    label: "Grok",
    inexpensive: "grok-4.20-0309-non-reasoning",
    note: "No fast/mini tier as of 2026-08; 4.20 non-reasoning is the volume model.",
  },
  minimax: {
    family: "minimax",
    label: "MiniMax",
    inexpensive: "MiniMax-M3",
  },
  google: {
    family: "google",
    label: "Gemini",
    inexpensive: "gemini-3.1-flash-lite",
    budgetFloor: "gemini-2.5-flash-lite",
  },
  deepseek: {
    family: "deepseek",
    label: "DeepSeek",
    inexpensive: "deepseek-v4-flash",
    note: "deepseek-chat alias retired 2026-07-24.",
  },
  mistral: {
    family: "mistral",
    label: "Mistral",
    inexpensive: "mistral-small-latest",
    budgetFloor: "ministral-8b-latest",
  },
  alibaba: {
    family: "alibaba",
    label: "Qwen",
    inexpensive: "qwen-flash",
    note: "qwen-turbo is no longer updated; Flash replaces it.",
  },
  moonshotai: {
    family: "moonshotai",
    label: "Kimi",
    inexpensive: "kimi-k2.6",
  },
  zai: {
    family: "zai",
    label: "GLM",
    inexpensive: "glm-4.7-flashx",
    budgetFloor: "glm-4.7-flash",
    note: "glm-4.7-flash is free-tier.",
  },
  groq: {
    family: "groq",
    label: "Groq (open-weights host)",
    inexpensive: "openai/gpt-oss-20b",
    budgetFloor: "llama-3.1-8b-instant",
    note: "Host, not a lab: serves Meta/OSS weights. gpt-oss-20b is the pick because Groq grants it strict json_schema.",
  },
  apple: {
    family: "apple",
    label: "Apple on-device",
    inexpensive: "apple-foundation-on-device",
    note: "Free and private; no catalog row. Quality floor — validate outputs and fall through to a cloud pick.",
  },
};

function canonical(model: string | null | undefined): string {
  let m = model?.trim().toLowerCase() ?? "";
  if (!m) return "";
  m = m.replace(/:[a-z0-9-]+$/u, "");
  return m.replace(/[._]/gu, "-");
}

/** Economics for a model id (native-provider data), or undefined. */
export function modelEconomics(model: string | null | undefined): ModelEconomicsEntry | undefined {
  const key = canonical(model);
  if (!key) return undefined;
  // Groq-hosted ids keep their prefix ("openai/gpt-oss-20b"); try exact first,
  // then the suffix the way window lookup does.
  if (MODEL_ECONOMICS[key]) return MODEL_ECONOMICS[key];
  const slash = key.lastIndexOf("/");
  return slash >= 0 ? MODEL_ECONOMICS[key.slice(slash + 1)] : undefined;
}

/** The inexpensive-cognition pick for a family, with its economics attached. */
export function inexpensiveCognitionPick(
  family: ModelFamilyId,
): FamilyTierPicks & { economics?: ModelEconomicsEntry } {
  const picks = FAMILY_TIER_PICKS[family];
  return { ...picks, economics: modelEconomics(picks.inexpensive) };
}
