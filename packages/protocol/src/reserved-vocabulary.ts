import {
  BUILT_IN_AGENT_DEFINITION_IDS,
  OPENSCOUT_COORDINATOR_AGENT_ID,
  SCOUT_DISPATCHER_AGENT_ID,
  normalizeAgentSelectorSegment,
} from "./agent-identity.js";
import {
  SCOUT_LAUNCHABLE_HARNESSES,
  SCOUT_RUNTIME_HARNESS_ALIASES,
  SCOUT_REASONING_EFFORTS,
} from "./runtime-execution.js";
import { SCOUT_RESERVED_RUNTIME_PROFILE_IDS } from "./runtime-profiles.js";

export const SCOUT_RESERVED_ROUTE_WORDS = [
  "scout",
  "openscout",
  "scoutbot",
  "operator",
  "shared",
  "broadcast",
  "agent",
  "alias",
  "target",
  "session",
  "ref",
  "id",
  "project",
  "channel",
] as const;

export const SCOUT_RESERVED_DIMENSION_WORDS = [
  "harness",
  "model",
  "profile",
  "node",
  "workspace",
  "effort",
] as const;

export type ScoutReservedVocabularyKind =
  | "harness"
  | "profile"
  | "effort"
  | "route"
  | "dimension"
  | "product"
  | "built_in";

const PRODUCT_IDENTITIES = new Set([
  SCOUT_DISPATCHER_AGENT_ID,
  OPENSCOUT_COORDINATOR_AGENT_ID,
  "scoutbot",
]);

const RESERVED_BY_KIND: ReadonlyArray<readonly [ScoutReservedVocabularyKind, ReadonlySet<string>]> = [
  ["profile", new Set(SCOUT_RESERVED_RUNTIME_PROFILE_IDS)],
  ["harness", new Set([...SCOUT_LAUNCHABLE_HARNESSES, ...Object.keys(SCOUT_RUNTIME_HARNESS_ALIASES)])],
  ["effort", new Set(SCOUT_REASONING_EFFORTS)],
  ["dimension", new Set(SCOUT_RESERVED_DIMENSION_WORDS)],
  ["product", PRODUCT_IDENTITIES],
  ["built_in", BUILT_IN_AGENT_DEFINITION_IDS],
  ["route", new Set(SCOUT_RESERVED_ROUTE_WORDS)],
];

export const SCOUT_RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set(
  RESERVED_BY_KIND.flatMap(([, values]) => [...values]),
);

export const SCOUT_AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
export const SCOUT_SESSION_HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,127}$/;

export function scoutReservedVocabularyKind(
  value: string | null | undefined,
): ScoutReservedVocabularyKind | null {
  const normalized = normalizeAgentSelectorSegment(value ?? "");
  if (!normalized) return null;
  return RESERVED_BY_KIND.find(([, values]) => values.has(normalized))?.[0] ?? null;
}

export function isScoutReservedAgentName(value: string | null | undefined): boolean {
  return scoutReservedVocabularyKind(value) !== null;
}

export type ScoutNameValidation =
  | { ok: true; value: string }
  | { ok: false; code: "invalid_name" | "reserved_name"; message: string };

export function validateScoutAgentNameForWrite(value: string): ScoutNameValidation {
  const raw = value.trim().replace(/^@+/, "");
  if (!SCOUT_AGENT_NAME_PATTERN.test(raw)) {
    return {
      ok: false,
      code: "invalid_name",
      message: `invalid_name: agent name "${value}" must match ^[a-z][a-z0-9-]{0,62}$; names are not silently rewritten`,
    };
  }
  const kind = scoutReservedVocabularyKind(raw);
  if (kind) {
    const teaching = kind === "harness" || kind === "profile"
      ? ` To target a runtime, use --harness ${raw} or ${raw}/<model>/<effort>.`
      : " Pick a non-runtime word to name an agent.";
    return {
      ok: false,
      code: "reserved_name",
      message: `reserved_name: name "${raw}" is reserved — it names a ${kind}.${teaching}`,
    };
  }
  return { ok: true, value: raw };
}

export function assertScoutAgentNameForWrite(value: string): string {
  const result = validateScoutAgentNameForWrite(value);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

/** Session handles are opaque but still cannot claim bare runtime grammar. */
export function validateScoutSessionHandleForWrite(value: string): ScoutNameValidation {
  const raw = value.trim().replace(/^@+/, "");
  if (!SCOUT_SESSION_HANDLE_PATTERN.test(raw)) {
    return {
      ok: false,
      code: "invalid_name",
      message: `invalid_name: session handle "${value}" contains unsupported characters`,
    };
  }
  const kind = scoutReservedVocabularyKind(raw);
  if (kind) {
    return {
      ok: false,
      code: "reserved_name",
      message: `reserved_name: session handle "${raw}" is reserved — it names a ${kind}`,
    };
  }
  return { ok: true, value: raw };
}
