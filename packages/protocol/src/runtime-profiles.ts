import { normalizeAgentSelectorSegment } from "./agent-identity.js";
import {
  normalizeScoutReasoningEffort,
  SCOUT_REASONING_EFFORTS,
  type ScoutReasoningEffort,
} from "./runtime-execution.js";

/**
 * Reserved natural-language profile names. Their execution definitions stay
 * broker-owned; clients use this list only to recognize unambiguous syntax.
 */
export const SCOUT_RESERVED_RUNTIME_PROFILE_IDS = [
  "antigravity",
  "carbon",
  "neon",
  "fable",
  "kimi",
  "grok",
  "opus",
  "oc",
  "opencode",
] as const;

export type ScoutReservedRuntimeProfileId =
  (typeof SCOUT_RESERVED_RUNTIME_PROFILE_IDS)[number];

export const SCOUT_RUNTIME_PROFILE_REASONING_EFFORTS = SCOUT_REASONING_EFFORTS;

export type ScoutRuntimeProfileReasoningEffort = ScoutReasoningEffort;

export function normalizeReservedRuntimeProfileId(
  value: string,
): ScoutReservedRuntimeProfileId | null {
  const normalized = normalizeAgentSelectorSegment(value);
  return SCOUT_RESERVED_RUNTIME_PROFILE_IDS.find((id) => id === normalized) ?? null;
}

export function normalizeRuntimeProfileReasoningEffort(
  value: string,
): ScoutRuntimeProfileReasoningEffort | null {
  return normalizeScoutReasoningEffort(normalizeAgentSelectorSegment(value));
}
