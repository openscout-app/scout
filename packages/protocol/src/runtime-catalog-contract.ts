import type { AgentHarness } from "./actors.js";

/** Harness ids Scout can select for a new execution session. */
export const SCOUT_LAUNCHABLE_HARNESSES = [
  "claude", "codex", "grok", "grok-acp", "kimi", "flue", "cursor", "opencode", "pi", "devin", "antigravity",
] as const satisfies readonly AgentHarness[];

export type ScoutLaunchableHarness = typeof SCOUT_LAUNCHABLE_HARNESSES[number];

export const SCOUT_REASONING_EFFORTS = [
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
] as const;

export type ScoutReasoningEffort = typeof SCOUT_REASONING_EFFORTS[number];

export const SCOUT_REASONING_EFFORT_LABELS: Readonly<Record<ScoutReasoningEffort, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Light",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

/** Optional picker-facing copy owned by the catalog, not by client code. */
export interface ScoutRuntimeHarnessPresentation {
  /** One-word rail/chip label, e.g. "Claude" for "Claude Code". */
  short?: string;
  /** Typographic stand-in for surfaces that render the harness as a mark. */
  monogram?: string;
}

/** Optional picker-facing copy owned by the catalog, not by client code. */
export interface ScoutRuntimeModelPresentation {
  /** One-line picker blurb, e.g. "Deepest", "Frontier". */
  detail?: string;
}

export interface ScoutOwnedRuntimeModel {
  id: string;
  label: string;
  enabled: boolean;
  default?: boolean;
  description?: string;
  family?: string;
  version?: string;
  contextWindowTokens?: number;
  reasoningEfforts?: readonly ScoutReasoningEffort[] | null;
  defaultReasoningEffort?: ScoutReasoningEffort | null;
  presentation?: ScoutRuntimeModelPresentation;
}

export interface ScoutOwnedRuntimeHarness {
  id: ScoutLaunchableHarness;
  label: string;
  enabled: boolean;
  /**
   * Whether pickers offer this harness. Defaults to `true`; `false` keeps the
   * harness launchable and resumable without presenting a duplicate transport
   * as a separate operator choice.
   */
  listed?: boolean;
  /** Accept provider/extension model ids without inventing a Scout default. */
  allowCustomModels?: boolean;
  default?: boolean;
  reasoningEfforts: readonly ScoutReasoningEffort[] | null;
  defaultReasoningEffort?: ScoutReasoningEffort | null;
  presentation?: ScoutRuntimeHarnessPresentation;
  models: readonly ScoutOwnedRuntimeModel[];
}

export interface ScoutOwnedRuntimeCatalog {
  schemaVersion: "openscout.runtime-catalog.v1";
  revision: string;
  harnesses: readonly ScoutOwnedRuntimeHarness[];
}
