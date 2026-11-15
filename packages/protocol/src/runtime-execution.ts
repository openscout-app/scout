import { SCOUT_RUNTIME_CATALOG_DATA } from "./runtime-catalog.generated.js";
import {
  SCOUT_LAUNCHABLE_HARNESSES,
  SCOUT_REASONING_EFFORT_LABELS,
  SCOUT_REASONING_EFFORTS,
  type ScoutLaunchableHarness,
  type ScoutOwnedRuntimeCatalog,
  type ScoutOwnedRuntimeHarness,
  type ScoutReasoningEffort,
  type ScoutRuntimeHarnessPresentation,
  type ScoutRuntimeModelPresentation,
} from "./runtime-catalog-contract.js";
export * from "./runtime-catalog-contract.js";

export interface ScoutRuntimeHarnessDefaults {
  model: string | null;
  reasoningEffort: ScoutReasoningEffort | null;
}

/**
 * Scout's published, versioned catalog controls enabled names, ordering,
 * labels and model effort metadata. A running broker can adopt newer data
 * without an app/package update. Adapters separately report harness readiness;
 * actual execution errors remain authoritative for a particular task.
 */
export const SCOUT_RUNTIME_CATALOG: ScoutOwnedRuntimeCatalog = SCOUT_RUNTIME_CATALOG_DATA;

export function scoutRuntimeHarness(
  harness: string,
  catalog: ScoutOwnedRuntimeCatalog = SCOUT_RUNTIME_CATALOG,
): ScoutOwnedRuntimeHarness | undefined {
  return catalog.harnesses.find((entry) => entry.id === harness);
}

export function isScoutRuntimeHarnessEnabled(
  harness: string,
  catalog: ScoutOwnedRuntimeCatalog = SCOUT_RUNTIME_CATALOG,
): harness is ScoutLaunchableHarness {
  return scoutRuntimeHarness(harness, catalog)?.enabled === true;
}

/** Enabled and offered as its own picker row. Hidden transports remain legal. */
export function isScoutRuntimeHarnessListed(
  harness: string,
  catalog: ScoutOwnedRuntimeCatalog = SCOUT_RUNTIME_CATALOG,
): boolean {
  const entry = scoutRuntimeHarness(harness, catalog);
  return entry?.enabled === true && entry.listed !== false;
}

/** A harness accepts a model dimension iff the owned catalog lists at least one enabled model for it. */
export function isModelSelectableHarness(
  harness: string,
  catalog: ScoutOwnedRuntimeCatalog = SCOUT_RUNTIME_CATALOG,
): boolean {
  const entry = scoutRuntimeHarness(harness, catalog);
  return entry?.enabled === true && (entry.allowCustomModels === true || entry.models.some((model) => model.enabled));
}

export function scoutRuntimeDefaultHarness(
  catalog: ScoutOwnedRuntimeCatalog = SCOUT_RUNTIME_CATALOG,
): ScoutLaunchableHarness | null {
  return catalog.harnesses.find((entry) => entry.enabled && entry.default)?.id
    ?? catalog.harnesses.find((entry) => entry.enabled)?.id
    ?? null;
}

export function scoutRuntimeDefaultModel(
  harness: string,
  catalog: ScoutOwnedRuntimeCatalog = SCOUT_RUNTIME_CATALOG,
): string | null {
  const entry = scoutRuntimeHarness(harness, catalog);
  return entry?.models.find((model) => model.enabled && model.default)?.id
    ?? entry?.models.find((model) => model.enabled)?.id
    ?? null;
}

export function scoutRuntimeReasoningEfforts(
  harness: string,
  model?: string | null,
  catalog: ScoutOwnedRuntimeCatalog = SCOUT_RUNTIME_CATALOG,
): readonly ScoutReasoningEffort[] | null {
  const entry = scoutRuntimeHarness(harness, catalog);
  if (!entry || !entry.enabled) return null;
  const selected = model
    ? entry.models.find((candidate) => candidate.enabled && candidate.id === model)
    : undefined;
  return selected?.reasoningEfforts === null
    ? null
    : selected?.reasoningEfforts ?? entry.reasoningEfforts;
}

export function scoutRuntimeDefaultReasoningEffort(
  harness: string,
  model?: string | null,
  catalog: ScoutOwnedRuntimeCatalog = SCOUT_RUNTIME_CATALOG,
): ScoutReasoningEffort | null {
  const entry = scoutRuntimeHarness(harness, catalog);
  const selected = model
    ? entry?.models.find((candidate) => candidate.enabled && candidate.id === model)
    : undefined;
  const efforts = scoutRuntimeReasoningEfforts(harness, model, catalog);
  const preferred = selected?.defaultReasoningEffort ?? entry?.defaultReasoningEffort ?? null;
  return preferred && efforts?.includes(preferred) ? preferred : efforts?.[0] ?? null;
}

export function scoutRuntimeDefaultsByHarness(
  catalog: ScoutOwnedRuntimeCatalog = SCOUT_RUNTIME_CATALOG,
): Readonly<Partial<Record<ScoutLaunchableHarness, ScoutRuntimeHarnessDefaults>>> {
  return Object.fromEntries(
  catalog.harnesses
    .filter((entry) => entry.enabled)
    .map((entry) => {
      const model = scoutRuntimeDefaultModel(entry.id, catalog);
      return [entry.id, {
        model,
        reasoningEffort: scoutRuntimeDefaultReasoningEffort(entry.id, model, catalog),
      }];
    }),
  ) as Partial<Record<ScoutLaunchableHarness, ScoutRuntimeHarnessDefaults>>;
}

export const SCOUT_RUNTIME_DEFAULTS_BY_HARNESS = scoutRuntimeDefaultsByHarness();

export const SCOUT_REASONING_EFFORTS_BY_HARNESS: Readonly<
  Partial<Record<ScoutLaunchableHarness, readonly ScoutReasoningEffort[]>>
> = Object.fromEntries(
  SCOUT_RUNTIME_CATALOG.harnesses
    .filter((entry) => entry.enabled)
    .map((entry) => {
      const supported = SCOUT_REASONING_EFFORTS.filter((effort) =>
        entry.reasoningEfforts?.includes(effort)
        || entry.models.some((model) => model.enabled && model.reasoningEfforts?.includes(effort))
      );
      return [entry.id, supported];
    }),
) as Partial<Record<ScoutLaunchableHarness, readonly ScoutReasoningEffort[]>>;

export type ScoutRuntimeResolutionSource =
  | "flag"
  | "literal"
  | "profile"
  | "endpoint"
  | "config"
  | "default";

/**
 * Drift compares what the session reports against what the ask requested.
 * `not_requested`: the ask named no value, so there is nothing to drift from;
 * the session's own value is in `observed`. `unknown`: the ask named a value
 * and the session has not reported one yet.
 */
export type ScoutRuntimeDriftState =
  | "not_requested"
  | "unknown"
  | "match"
  | "mismatch";

export interface ScoutRuntimeDimensionResolution {
  requested?: string;
  resolved?: string;
  source?: ScoutRuntimeResolutionSource;
  observed?: string;
  observedAt?: number;
  drift: ScoutRuntimeDriftState;
}

/**
 * Which Codex app-server executed the session: one Scout spawned for itself,
 * or an already-running server Scout attached to over its control socket.
 * Harness-owned evidence from `initialize` and `codex app-server daemon version`.
 */
export interface ScoutCodexAppServerIdentity {
  connection: "spawned" | "attached";
  socketPath: string | null;
  pid: number | null;
  userAgent: string | null;
  appServerVersion: string | null;
  codexHome: string | null;
  platformOs?: string | null;
  /** Scout features that do not apply to this server (e.g. scout_mcp_injection). */
  capabilityGaps: string[];
  connectedAt: number;
}

/**
 * Durable execution truth for one concrete session. `requested` is caller
 * intent, `resolved` is the spawn value after the launch ladder, and
 * `observed` is populated only from harness-owned evidence: the session's own
 * report of the model and effort it runs. `drift` compares `observed` with the
 * request and is `not_requested` when the ask named nothing.
 */
export interface ScoutExecutionResolution {
  schemaVersion: "openscout.execution-resolution.v1";
  harness: ScoutRuntimeDimensionResolution;
  model: ScoutRuntimeDimensionResolution;
  reasoningEffort: ScoutRuntimeDimensionResolution;
  sessionId?: string;
  resolvedAt?: number;
  observedAt?: number;
  /** Present for Codex sessions once the app-server has been reached. */
  codexAppServer?: ScoutCodexAppServerIdentity;
}

export interface ScoutRuntimeModelOption {
  id: string;
  label: string;
  description?: string;
  harnesses: ScoutLaunchableHarness[];
  source: "catalog" | "observed" | "configured" | "default";
  family?: string;
  version?: string;
  /** True when the owned catalog marks this model as its harness's default. */
  isDefault?: boolean;
  presentation?: ScoutRuntimeModelPresentation;
}

export interface ScoutRuntimeEffortOption {
  id: ScoutReasoningEffort;
  label: string;
  description?: string;
  harnesses: ScoutLaunchableHarness[];
  /**
   * Model-scoped restriction, interpreted per harness: the rung is withheld
   * only from catalog models of a harness that has at least one model named
   * here. `max` naming `gpt-5.6-*` ids restricts Codex models but leaves
   * Claude's ladder untouched. Empty/absent means every model of every listed
   * harness supports the rung.
   */
  models?: string[];
}

export interface ScoutRuntimeHarnessOption {
  id: ScoutLaunchableHarness;
  name?: string;
  label: string;
  description?: string | null;
  state?: "ready" | "configured" | "installed" | "missing" | null;
  ready?: boolean | null;
  detail?: string | null;
  presentation?: ScoutRuntimeHarnessPresentation;
}

export interface ScoutRuntimeCapabilityCatalog {
  schemaVersion: "openscout.runtime-capabilities.v1";
  catalogVersion?: ScoutOwnedRuntimeCatalog["schemaVersion"];
  catalogRevision?: string;
  generatedAt: number;
  scope: "global" | "project" | "global+project";
  projectRoot?: string;
  harnesses: ScoutRuntimeHarnessOption[];
  models: ScoutRuntimeModelOption[];
  efforts: ScoutRuntimeEffortOption[];
  defaults?: {
    harness?: ScoutLaunchableHarness;
    model?: string | null;
    reasoningEffort?: ScoutReasoningEffort | null;
  };
  defaultsByHarness?: Partial<Record<ScoutLaunchableHarness, ScoutRuntimeHarnessDefaults>>;
  warnings?: string[];
}

/** Project one nested catalog into the flat API model list. */
export function scoutRuntimeModelCatalog(
  catalog: ScoutOwnedRuntimeCatalog = SCOUT_RUNTIME_CATALOG,
): ScoutRuntimeModelOption[] {
  const models = new Map<string, ScoutRuntimeModelOption>();
  for (const harness of catalog.harnesses) {
    if (!harness.enabled) continue;
    for (const model of harness.models) {
      if (!model.enabled) continue;
      const existing = models.get(model.id);
      if (existing) {
        if (!existing.harnesses.includes(harness.id)) existing.harnesses.push(harness.id);
        continue;
      }
      models.set(model.id, {
        id: model.id,
        label: model.label,
        ...(model.description ? { description: model.description } : {}),
        harnesses: [harness.id],
        source: "default",
        ...(model.family ? { family: model.family } : {}),
        ...(model.version ? { version: model.version } : {}),
        ...(model.default === true ? { isDefault: true } : {}),
        ...(model.presentation ? { presentation: model.presentation } : {}),
      });
    }
  }
  return Array.from(models.values());
}

/** Projections retained for API compatibility; SCOUT_RUNTIME_CATALOG owns them. */
export const SCOUT_RUNTIME_MODEL_CATALOG: readonly ScoutRuntimeModelOption[] = scoutRuntimeModelCatalog();

const SCOUT_RUNTIME_EFFORT_DESCRIPTIONS: Readonly<Record<ScoutReasoningEffort, string>> = {
  none: "No extra thinking",
  minimal: "Smallest reasoning budget",
  low: "Fast responses with lighter reasoning",
  medium: "Balanced speed and reasoning depth",
  high: "Greater reasoning depth for complex work",
  xhigh: "Extra high reasoning depth",
  max: "Maximum reasoning depth",
  ultra: "Maximum reasoning with delegation",
};

export function scoutRuntimeEffortCatalog(
  catalog: ScoutOwnedRuntimeCatalog = SCOUT_RUNTIME_CATALOG,
): ScoutRuntimeEffortOption[] {
  return SCOUT_REASONING_EFFORTS.flatMap((id): ScoutRuntimeEffortOption[] => {
    const harnesses: ScoutLaunchableHarness[] = [];
    const restrictedModels: string[] = [];
    for (const harness of catalog.harnesses) {
      if (!harness.enabled) continue;
      const enabledModels = harness.models.filter((model) => model.enabled);
      const supportingModels = enabledModels.filter((model) =>
        (model.reasoningEfforts ?? harness.reasoningEfforts)?.includes(id)
      );
      const supportedWithoutModel = enabledModels.length === 0 && harness.reasoningEfforts?.includes(id);
      if (supportingModels.length === 0 && !supportedWithoutModel) continue;
      harnesses.push(harness.id);
      if (enabledModels.length > 0 && supportingModels.length < enabledModels.length) {
        restrictedModels.push(...supportingModels.map((model) => model.id));
      }
    }
    if (harnesses.length === 0) return [];
    return [{
      id,
      label: SCOUT_REASONING_EFFORT_LABELS[id],
      description: SCOUT_RUNTIME_EFFORT_DESCRIPTIONS[id],
      harnesses,
      ...(restrictedModels.length > 0 ? { models: restrictedModels } : {}),
    }];
  });
}

export const SCOUT_RUNTIME_EFFORT_CATALOG: readonly ScoutRuntimeEffortOption[] = scoutRuntimeEffortCatalog();

export type ScoutRuntimeTuple = {
  harness?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  /** Existing task context remains usable after a published choice is disabled. */
  session?: "new" | "reuse" | "existing" | "fork" | "any";
  targetSessionId?: string;
  forkFromSessionId?: string;
  forkFromStateId?: string;
};

export interface ScoutRuntimeSpec {
  harness: ScoutLaunchableHarness;
  model?: string;
  reasoningEffort?: ScoutReasoningEffort;
}

export type ScoutRuntimeSpecParseResult =
  | { ok: true; value: ScoutRuntimeSpec }
  | { ok: false; error: string };

export type ScoutRuntimeModelNormalization =
  | { ok: true; requested: string; resolved: string }
  | { ok: false; requested: string; error: string; candidates?: string[] };

const CLAUDE_FAMILY_ALIASES: Record<string, string> = {
  fable: "Fable",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
};

/**
 * The newest enabled model in a catalog family: the harness default when it is
 * in the family, otherwise the first in catalog order (newest first). A family
 * alias like `opus` follows the catalog instead of pinning a release.
 */
export function scoutRuntimeLatestModelInFamily(
  harness: string,
  family: string,
  catalog: ScoutOwnedRuntimeCatalog = SCOUT_RUNTIME_CATALOG,
): string | undefined {
  const models = (scoutRuntimeHarness(harness, catalog)?.models ?? [])
    .filter((model) => model.enabled && model.family === family);
  return (models.find((model) => model.default) ?? models[0])?.id;
}

/** Canonical model aliases shared by every request boundary and spawn path. */
export function normalizeScoutRuntimeModel(
  harness: string,
  input: string,
  catalog: ScoutOwnedRuntimeCatalog = SCOUT_RUNTIME_CATALOG,
): ScoutRuntimeModelNormalization {
  const requested = input.trim();
  if (!requested) {
    return { ok: false, requested, error: "model cannot be empty" };
  }
  const normalizedHarness = harness.trim().toLowerCase();
  const lower = requested.toLowerCase();
  if (normalizedHarness === "codex") {
    if (lower === "6" || lower === "gpt-6" || lower === "astra") {
      return { ok: true, requested, resolved: "gpt-6-astra" };
    }
    if (lower === "5.6" || lower === "gpt-5.6") {
      return { ok: true, requested, resolved: "gpt-5.6-sol" };
    }
    if (/^\d+(?:\.\d+)*(?:-[a-z0-9][a-z0-9._-]*)?$/u.test(lower)) {
      return { ok: true, requested, resolved: `gpt-${lower}` };
    }
    return { ok: true, requested, resolved: requested };
  }
  if (normalizedHarness === "claude") {
    const family = CLAUDE_FAMILY_ALIASES[lower];
    const resolved = family ? scoutRuntimeLatestModelInFamily("claude", family, catalog) : undefined;
    return { ok: true, requested, resolved: resolved ?? requested };
  }
  return { ok: true, requested, resolved: requested };
}

/** Parse the shell-safe `<harness>[/<model>[/<effort>]]` production. */
export function parseScoutRuntimeSpec(input: string): ScoutRuntimeSpecParseResult {
  const raw = input.trim();
  const parts = raw.split("/");
  if (!raw || parts.length > 3 || parts.some((part) => !part.trim())) {
    return {
      ok: false,
      error: "runtime must be <harness>[/<model>[/<effort>]]",
    };
  }
  const rawHarness = parts[0]!.trim().toLowerCase();
  const harness = (rawHarness === "oc" ? "opencode" : rawHarness) as ScoutLaunchableHarness;
  if (!isScoutLaunchableHarness(harness)) {
    return {
      ok: false,
      error: `unsupported runtime harness "${parts[0]}"; expected one of: ${SCOUT_LAUNCHABLE_HARNESSES.join(", ")}`,
    };
  }
  const model = parts[1]?.trim();
  const effortRaw = parts[2]?.trim();
  const reasoningEffort = effortRaw ? normalizeScoutReasoningEffort(effortRaw) : null;
  if (effortRaw && !reasoningEffort) {
    return {
      ok: false,
      error: `unsupported reasoning effort "${effortRaw}"; expected one of: ${SCOUT_REASONING_EFFORTS.join(", ")}`,
    };
  }
  // Parse syntax locally. The broker validates model/effort legality against
  // its current published catalog, which can be newer than this CLI package.
  return {
    ok: true,
    value: {
      harness,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    },
  };
}

export function formatScoutRuntimeSpec(spec: ScoutRuntimeSpec): string {
  if (spec.reasoningEffort && !spec.model) {
    throw new Error("runtime literal cannot encode effort without a model; use --harness and --effort");
  }
  return [spec.harness, spec.model, spec.reasoningEffort]
    .filter((part): part is string => Boolean(part))
    .join("/");
}

export type ScoutRuntimeTupleIssue = {
  code:
    | "unsupported_harness"
    | "disabled_model"
    | "unsupported_reasoning_effort"
    | "reasoning_effort_harness_mismatch"
    | "unsupported_model_dimension"
    | "model_harness_mismatch";
  dimension: "harness" | "model" | "reasoningEffort";
  message: string;
};

export function normalizeScoutLaunchableHarness(
  value: string | null | undefined,
): ScoutLaunchableHarness | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "oc") return "opencode";
  return isScoutLaunchableHarness(normalized) ? normalized : null;
}

export function isScoutLaunchableHarness(value: string | null | undefined): value is ScoutLaunchableHarness {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "oc" || SCOUT_LAUNCHABLE_HARNESSES.includes(normalized as ScoutLaunchableHarness);
}

export function normalizeScoutReasoningEffort(
  value: string | null | undefined,
): ScoutReasoningEffort | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && SCOUT_REASONING_EFFORTS.includes(normalized as ScoutReasoningEffort)
    ? normalized as ScoutReasoningEffort
    : null;
}

export function runtimeDimensionResolution(input: {
  requested?: string | null;
  resolved?: string | null;
  source?: ScoutRuntimeResolutionSource;
  observed?: string | null;
  observedAt?: number;
}): ScoutRuntimeDimensionResolution {
  const requested = input.requested?.trim() || undefined;
  const resolved = input.resolved?.trim() || undefined;
  const observed = input.observed?.trim() || undefined;
  // Model and effort come from the session that runs the work. Drift is a
  // question about the ask, so it exists only when the ask requested a value.
  // The request is compared in its resolved (normalized) form when one exists.
  const expected = requested ? resolved ?? requested : undefined;
  const drift: ScoutRuntimeDriftState = !expected
    ? "not_requested"
    : !observed
      ? "unknown"
      : observed.toLowerCase() === expected.toLowerCase()
        ? "match"
        : "mismatch";
  return {
    ...(requested ? { requested } : {}),
    ...(resolved ? { resolved } : {}),
    ...(input.source && resolved ? { source: input.source } : {}),
    ...(observed ? { observed } : {}),
    ...(observed && input.observedAt !== undefined ? { observedAt: input.observedAt } : {}),
    drift,
  };
}

export function createScoutExecutionResolution(input: {
  requested?: ScoutRuntimeTuple;
  resolved?: ScoutRuntimeTuple;
  source?: Partial<Record<"harness" | "model" | "reasoningEffort", ScoutRuntimeResolutionSource>>;
  observed?: ScoutRuntimeTuple;
  sessionId?: string;
  resolvedAt?: number;
  observedAt?: number;
}): ScoutExecutionResolution {
  const dimension = (key: "harness" | "model" | "reasoningEffort") => runtimeDimensionResolution({
    requested: input.requested?.[key],
    resolved: input.resolved?.[key],
    source: input.source?.[key],
    observed: input.observed?.[key],
    observedAt: input.observedAt,
  });
  return {
    schemaVersion: "openscout.execution-resolution.v1",
    harness: dimension("harness"),
    model: dimension("model"),
    reasoningEffort: dimension("reasoningEffort"),
    ...(input.sessionId?.trim() ? { sessionId: input.sessionId.trim() } : {}),
    ...(input.resolvedAt !== undefined ? { resolvedAt: input.resolvedAt } : {}),
    ...(input.observedAt !== undefined ? { observedAt: input.observedAt } : {}),
  };
}

export function validateScoutRuntimeTuple(
  input: ScoutRuntimeTuple,
  catalog?: Pick<ScoutRuntimeCapabilityCatalog, "models" | "efforts">,
  ownedCatalog: ScoutOwnedRuntimeCatalog = SCOUT_RUNTIME_CATALOG,
): ScoutRuntimeTupleIssue[] {
  const rawHarness = input.harness?.trim().toLowerCase();
  const harness = rawHarness === "oc" ? "opencode" : rawHarness;
  const requestedModel = input.model?.trim();
  const normalizedModel = harness && requestedModel
    ? normalizeScoutRuntimeModel(harness, requestedModel, ownedCatalog) : null;
  const model = normalizedModel?.ok ? normalizedModel.resolved : requestedModel;
  const effortRaw = input.reasoningEffort?.trim();
  const issues: ScoutRuntimeTupleIssue[] = [];
  const existingContext = Boolean(input.targetSessionId || input.forkFromSessionId || input.forkFromStateId)
    || input.session === "existing" || input.session === "fork";

  // Harness membership and model selectability come from the owned catalog —
  // the live broker snapshot when one is supplied, the bundled default
  // otherwise — never a hand-maintained list.
  if (harness && !ownedCatalog.harnesses.some((entry) => entry.id === harness)) {
    issues.push({
      code: "unsupported_harness",
      dimension: "harness",
      message: `unsupported harness "${input.harness}"; expected one of: ${ownedCatalog.harnesses.map((entry) => entry.id).join(", ")}`,
    });
    return issues;
  }

  const effort = effortRaw ? normalizeScoutReasoningEffort(effortRaw) : null;
  if (effortRaw && !effort) {
    issues.push({
      code: "unsupported_reasoning_effort",
      dimension: "reasoningEffort",
      message: `unsupported reasoning effort "${effortRaw}"; expected one of: ${SCOUT_REASONING_EFFORTS.join(", ")}`,
    });
  } else if (effort && harness && !existingContext) {
    const catalogEffort = catalog?.efforts.find((candidate) => candidate.id === effort);
    let supported = catalogEffort
      ? catalogEffort.harnesses.includes(harness as ScoutLaunchableHarness)
      : (scoutRuntimeReasoningEfforts(harness, model, ownedCatalog) ?? []).includes(effort);
    if (supported && catalogEffort?.models?.length && model) {
      const harnessModels = new Set(
        catalog?.models
          .filter((candidate) => candidate.harnesses.includes(harness as ScoutLaunchableHarness))
          .map((candidate) => candidate.id.toLowerCase()) ?? [],
      );
      const scopedModels = catalogEffort.models.filter((candidate) => (
        harnessModels.has(candidate.toLowerCase())
      ));
      if (harnessModels.has(model.toLowerCase()) && scopedModels.length > 0) {
        supported = scopedModels.some((candidate) => candidate.toLowerCase() === model.toLowerCase());
      }
    }
    if (!supported) {
      issues.push({
        code: "reasoning_effort_harness_mismatch",
        dimension: "reasoningEffort",
        message: `reasoning effort "${effort}" is not supported by harness "${harness}"`,
      });
    }
  }

  const ownedHarness = harness ? scoutRuntimeHarness(harness, ownedCatalog) : undefined;
  const publishedModel = ownedHarness?.models.find((candidate) => candidate.id.toLowerCase() === model?.toLowerCase());
  if (model && publishedModel?.enabled === false && ownedHarness?.allowCustomModels !== true && !existingContext) {
    issues.push({
      code: "disabled_model",
      dimension: "model",
      message: `model "${model}" is disabled in the Scout runtime catalog`,
    });
  } else if (model && harness && !existingContext && !isModelSelectableHarness(harness, ownedCatalog)) {
    issues.push({
      code: "unsupported_model_dimension",
      dimension: "model",
      message: `model selection is not supported by harness "${harness}"`,
    });
  } else if (model && harness && catalog) {
    const known = catalog.models.find((candidate) => candidate.id.toLowerCase() === model.toLowerCase());
    if (known && scoutRuntimeHarness(harness, ownedCatalog)?.allowCustomModels !== true
      && !known.harnesses.includes(harness as ScoutLaunchableHarness)) {
      issues.push({
        code: "model_harness_mismatch",
        dimension: "model",
        message: `model "${model}" is not supported by harness "${harness}"`,
      });
    }
  }

  return issues;
}
