/**
 * Scout's cheap/fast utility runtime — not the operator's session model.
 *
 * Use this for Scout-owned jobs such as session titling and classification.
 * Prefer the first candidate whose harness is actually available on the node:
 * Codex Luna when a ChatGPT/Codex subscription is present, then an OpenRouter-
 * style flash model, then other inexpensive family picks.
 */

export const SCOUT_BASELINE_PURPOSE = "scout-utility" as const;

export type ScoutBaselineRuntime = {
  harness: string;
  model: string;
  effort: string | null;
  label: string;
  purpose: typeof SCOUT_BASELINE_PURPOSE;
};

type BaselineCandidate = {
  harness: string;
  aliases?: readonly string[];
  model: string;
  effort: string | null;
  label: string;
};

/**
 * Ordered cheapest-useful defaults. First matching available harness wins.
 * Keep these aligned with `packages/agent-sessions` inexpensive family picks
 * when those ids are launchable through a Scout harness.
 */
export const SCOUT_BASELINE_CANDIDATES: readonly BaselineCandidate[] = [
  {
    harness: "codex",
    model: "gpt-5.6-luna",
    effort: "low",
    label: "Luna",
  },
  {
    harness: "opencode",
    model: "deepseek-v4-flash",
    effort: null,
    label: "DeepSeek Flash",
  },
  {
    harness: "grok",
    aliases: ["grok-acp"],
    model: "grok-4.20-0309-non-reasoning",
    effort: null,
    label: "Grok Fast",
  },
  {
    harness: "claude",
    model: "claude-haiku-5-5",
    effort: "low",
    label: "Haiku",
  },
  {
    harness: "kimi",
    aliases: ["kimi-acp"],
    model: "kimi-k2.5",
    effort: null,
    label: "Kimi",
  },
];

function normalizeHarness(value: string): string {
  return value.trim().toLowerCase();
}

function candidateMatches(candidate: BaselineCandidate, harness: string): boolean {
  if (candidate.harness === harness) return true;
  return candidate.aliases?.some((alias) => alias === harness) === true;
}

/** First cheap/fast Scout utility runtime the node can actually launch. */
export function resolveScoutBaselineRuntime(
  availableHarnesses: readonly string[],
): ScoutBaselineRuntime | null {
  const available = new Set(
    availableHarnesses.map(normalizeHarness).filter(Boolean),
  );
  if (available.size === 0) return null;

  for (const candidate of SCOUT_BASELINE_CANDIDATES) {
    const harness = [...available].find((id) => candidateMatches(candidate, id));
    if (!harness) continue;
    return {
      harness: candidate.harness,
      model: candidate.model,
      effort: candidate.effort,
      label: candidate.label,
      purpose: SCOUT_BASELINE_PURPOSE,
    };
  }
  return null;
}
