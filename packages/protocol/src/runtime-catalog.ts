import {
  SCOUT_LAUNCHABLE_HARNESSES,
  SCOUT_REASONING_EFFORTS,
  type ScoutLaunchableHarness,
  type ScoutOwnedRuntimeCatalog,
  type ScoutOwnedRuntimeHarness,
  type ScoutOwnedRuntimeModel,
  type ScoutReasoningEffort,
} from "./runtime-catalog-contract.js";

export type ScoutRuntimeCatalogParseResult =
  | { ok: true; catalog: ScoutOwnedRuntimeCatalog }
  | { ok: false; errors: string[] };

const launchableHarnesses = new Set<string>(SCOUT_LAUNCHABLE_HARNESSES);
const reasoningEfforts = new Set<string>(SCOUT_REASONING_EFFORTS);
export const MAX_RUNTIME_MODELS_PER_HARNESS = 256;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() === value && value.length > 0
    ? value
    : null;
}

function presentation<K extends string>(
  value: unknown,
  path: string,
  errors: string[],
  keys: readonly K[],
): Record<K, string> | undefined {
  if (value === undefined) return undefined;
  const input = record(value);
  if (!input) {
    errors.push(`${path} must be an object`);
    return undefined;
  }
  const result = {} as Record<K, string>;
  for (const key of keys) {
    const field = input[key];
    if (field === undefined) continue;
    const parsed = text(field);
    if (!parsed) {
      errors.push(`${path}.${key} must be a non-empty trimmed string`);
      continue;
    }
    result[key] = parsed;
  }
  return result;
}

function effortList(value: unknown, path: string, errors: string[]): ScoutReasoningEffort[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array or null`);
    return undefined;
  }
  const result: ScoutReasoningEffort[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string" || !reasoningEfforts.has(candidate)) {
      errors.push(`${path} contains unknown effort ${String(candidate)}`);
      continue;
    }
    if (seen.add(candidate)) result.push(candidate as ScoutReasoningEffort);
    else errors.push(`${path} contains duplicate effort ${candidate}`);
  }
  return result;
}

function model(value: unknown, path: string, errors: string[]): ScoutOwnedRuntimeModel | null {
  const input = record(value);
  if (!input) {
    errors.push(`${path} must be an object`);
    return null;
  }
  const id = text(input.id);
  const label = text(input.label);
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(id)) {
    errors.push(`${path}.id must use provider-safe letters, numbers, dot, slash, underscore, or hyphen`);
  }
  if (!label) errors.push(`${path}.label is required`);
  if (typeof input.enabled !== "boolean") errors.push(`${path}.enabled must be boolean`);
  if (input.default === true && input.enabled !== true) errors.push(`${path} cannot be default while disabled`);
  if (!id || !label || typeof input.enabled !== "boolean") return null;
  const efforts = input.reasoningEfforts === undefined
    ? undefined
    : effortList(input.reasoningEfforts, `${path}.reasoningEfforts`, errors);
  const defaultEffort = input.defaultReasoningEffort == null ? null : text(input.defaultReasoningEffort);
  const contextWindowTokens = input.contextWindowTokens;
  if (contextWindowTokens !== undefined && (!Number.isInteger(contextWindowTokens) || Number(contextWindowTokens) <= 0)) {
    errors.push(`${path}.contextWindowTokens must be a positive integer`);
  }
  if (input.defaultReasoningEffort != null && (!defaultEffort || !reasoningEfforts.has(defaultEffort))) {
    errors.push(`${path}.defaultReasoningEffort is unknown`);
  }
  return {
    id,
    label,
    enabled: input.enabled,
    ...(input.default === true ? { default: true } : {}),
    ...(text(input.description) ? { description: text(input.description)! } : {}),
    ...(text(input.family) ? { family: text(input.family)! } : {}),
    ...(text(input.version) ? { version: text(input.version)! } : {}),
    ...(Number.isInteger(contextWindowTokens) && Number(contextWindowTokens) > 0
      ? { contextWindowTokens: Number(contextWindowTokens) }
      : {}),
    ...(input.reasoningEfforts !== undefined ? { reasoningEfforts: efforts ?? null } : {}),
    ...(defaultEffort && reasoningEfforts.has(defaultEffort)
      ? { defaultReasoningEffort: defaultEffort as ScoutReasoningEffort }
      : input.defaultReasoningEffort === null ? { defaultReasoningEffort: null } : {}),
    ...(input.presentation !== undefined
      ? { presentation: presentation(input.presentation, `${path}.presentation`, errors, ["detail"]) }
      : {}),
  };
}

function harness(value: unknown, path: string, errors: string[]): ScoutOwnedRuntimeHarness | null {
  const input = record(value);
  if (!input) {
    errors.push(`${path} must be an object`);
    return null;
  }
  const id = text(input.id);
  const label = text(input.label);
  if (!id || !launchableHarnesses.has(id)) errors.push(`${path}.id is not a launchable harness`);
  if (!label) errors.push(`${path}.label is required`);
  if (typeof input.enabled !== "boolean") errors.push(`${path}.enabled must be boolean`);
  if (input.listed !== undefined && typeof input.listed !== "boolean") {
    errors.push(`${path}.listed must be boolean when provided`);
  }
  if (input.allowCustomModels !== undefined && typeof input.allowCustomModels !== "boolean") {
    errors.push(`${path}.allowCustomModels must be boolean when provided`);
  }
  if (input.default === true && input.enabled !== true) errors.push(`${path} cannot be default while disabled`);
  const efforts = effortList(input.reasoningEfforts, `${path}.reasoningEfforts`, errors);
  if (!id || !launchableHarnesses.has(id) || !label || typeof input.enabled !== "boolean" || efforts === undefined) {
    return null;
  }
  if (!Array.isArray(input.models)) {
    errors.push(`${path}.models must be an array`);
    return null;
  }
  if (input.models.length > MAX_RUNTIME_MODELS_PER_HARNESS) {
    errors.push(`${path}.models exceeds the ${MAX_RUNTIME_MODELS_PER_HARNESS}-model limit`);
    return null;
  }
  const models = input.models
    .map((entry, index) => model(entry, `${path}.models[${index}]`, errors))
    .filter((entry): entry is ScoutOwnedRuntimeModel => Boolean(entry));
  const ids = new Set<string>();
  for (const entry of models) {
    if (!ids.add(entry.id)) errors.push(`${path} contains duplicate model ${entry.id}`);
    const effective = entry.reasoningEfforts === undefined ? efforts : entry.reasoningEfforts;
    if (entry.defaultReasoningEffort && !effective?.includes(entry.defaultReasoningEffort)) {
      errors.push(`${path} model ${entry.id} has an unsupported default effort`);
    }
  }
  if (models.filter((entry) => entry.default).length > 1) errors.push(`${path} has more than one default model`);
  for (const entry of models) {
    if (entry.default && !entry.enabled) errors.push(`${path} model ${entry.id} cannot be default while disabled`);
  }
  const defaultEffort = input.defaultReasoningEffort == null ? null : text(input.defaultReasoningEffort);
  if (defaultEffort && !efforts?.includes(defaultEffort as ScoutReasoningEffort)) {
    errors.push(`${path}.defaultReasoningEffort is not supported`);
  }
  return {
    id: id as ScoutLaunchableHarness,
    label,
    enabled: input.enabled,
    ...(typeof input.listed === "boolean" ? { listed: input.listed } : {}),
    ...(typeof input.allowCustomModels === "boolean" ? { allowCustomModels: input.allowCustomModels } : {}),
    ...(input.default === true ? { default: true } : {}),
    reasoningEfforts: efforts,
    ...(defaultEffort && reasoningEfforts.has(defaultEffort)
      ? { defaultReasoningEffort: defaultEffort as ScoutReasoningEffort }
      : input.defaultReasoningEffort === null ? { defaultReasoningEffort: null } : {}),
    ...(input.presentation !== undefined
      ? { presentation: presentation(input.presentation, `${path}.presentation`, errors, ["short", "monogram"]) }
      : {}),
    models,
  };
}

export function parseScoutRuntimeCatalog(value: unknown): ScoutRuntimeCatalogParseResult {
  const input = record(value);
  if (!input) return { ok: false, errors: ["catalog must be a JSON object"] };
  const errors: string[] = [];
  if (input.schemaVersion !== "openscout.runtime-catalog.v1") errors.push("unexpected schemaVersion");
  const revision = text(input.revision);
  if (!revision || !/^\d{4}-\d{2}-\d{2}\.\d+$/u.test(revision)) {
    errors.push("revision must use YYYY-MM-DD.N format");
  }
  if (!Array.isArray(input.harnesses) || input.harnesses.length === 0) {
    errors.push("harnesses must be a non-empty array");
    return { ok: false, errors };
  }
  const harnesses = input.harnesses
    .map((entry, index) => harness(entry, `harnesses[${index}]`, errors))
    .filter((entry): entry is ScoutOwnedRuntimeHarness => Boolean(entry));
  const ids = new Set<string>();
  const sharedModels = new Map<string, string>();
  for (const entry of harnesses) {
    if (!ids.add(entry.id)) errors.push(`duplicate harness ${entry.id}`);
    for (const model of entry.models) {
      const signature = JSON.stringify([
        model.label,
        model.description ?? null,
        model.family ?? null,
        model.version ?? null,
        model.contextWindowTokens ?? null,
      ]);
      const prior = sharedModels.get(model.id);
      if (prior && prior !== signature) errors.push(`shared model ${model.id} has inconsistent metadata`);
      sharedModels.set(model.id, signature);
    }
  }
  if (harnesses.filter((entry) => entry.enabled && entry.default).length !== 1) {
    errors.push("catalog must contain exactly one enabled default harness");
  }
  return errors.length || !revision
    ? { ok: false, errors }
    : { ok: true, catalog: { schemaVersion: "openscout.runtime-catalog.v1", revision, harnesses } };
}
