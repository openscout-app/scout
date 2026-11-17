import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DecisionModel } from "./decision-synthesis.js";

/** The small model that lays an ask out as a card. */
export const DECISION_SYNTHESIS_MODEL = "claude-haiku-5-5";
const TIMEOUT_MS = 20_000;
const MAX_OUTPUT_TOKENS = 1_024;

/**
 * Whether this runtime can call the model: an API key or token, a named
 * profile, or a profile in the Anthropic config directory. Synthesis is off
 * when `SCOUT_DECISION_SYNTHESIS=0`. Without any of these, asks stay plain.
 */
export function decisionSynthesisConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SCOUT_DECISION_SYNTHESIS === "0" || env.SCOUT_DECISION_SYNTHESIS === "off") return false;
  if (env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim() || env.ANTHROPIC_PROFILE?.trim()) return true;
  const configDir = env.ANTHROPIC_CONFIG_DIR?.trim() || join(homedir(), ".config", "anthropic");
  return existsSync(join(configDir, "configs"));
}

/**
 * One structured-output call to Claude through the official SDK. No retries:
 * a failed call leaves the plain ask, and the next ask tries again.
 */
export function createDecisionModel(env: NodeJS.ProcessEnv = process.env): DecisionModel | undefined {
  if (!decisionSynthesisConfigured(env)) return undefined;
  const model = env.SCOUT_DECISION_SYNTHESIS_MODEL?.trim() || DECISION_SYNTHESIS_MODEL;
  let client: Promise<import("@anthropic-ai/sdk").default> | undefined;
  const sdk = () => client ??= import("@anthropic-ai/sdk").then(({ default: Anthropic }) => new Anthropic({ maxRetries: 0, timeout: TIMEOUT_MS }));
  return {
    model,
    async extract({ system, prompt, schema }) {
      const anthropic = await sdk();
      const response = await anthropic.messages.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        thinking: { type: "disabled" },
        output_config: { effort: "low", format: { type: "json_schema", schema } },
        messages: [{ role: "user", content: prompt }],
      });
      const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
      if (response.stop_reason === "refusal") throw new Error("the model declined to read this ask");
      if (response.stop_reason === "max_tokens") throw new Error("the model's answer was cut off");
      const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
      return { output: text ? JSON.parse(text) as unknown : null, usage };
    },
  };
}
