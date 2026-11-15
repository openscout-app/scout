import { SCOUT_MODEL_TASTE_DATA } from "./model-taste.generated.js";
import type { ScoutOwnedRuntimeCatalog } from "./runtime-catalog-contract.js";

export type ScoutModelTaste = {
  schemaVersion: "openscout.model-taste.v1";
  revision: string;
  factsReviewedAt: string;
  opinionBasis: string;
  sources: string[];
  runtimes: Record<string, {
    label: string; providerId: string; harness: string; effort: string | null; profile: string | null;
    capability: string; caution: string; selector: { family?: string; tier?: string };
  }>;
  roles: Record<string, {
    label: string; objective: string; strategy: string;
    candidates: Array<{ runtime: string; fit: number; rationale: string }>;
  }>;
};
export const SCOUT_MODEL_TASTE = SCOUT_MODEL_TASTE_DATA as unknown as ScoutModelTaste;

/** Validate remotely published opinions before they can influence advisory picks. */
export function assertValidScoutModelTaste(value: unknown): asserts value is ScoutModelTaste {
  const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 4_096;
  const nullableText = (v: unknown) => v === null || text(v);
  if (!isRecord(value) || value.schemaVersion !== "openscout.model-taste.v1" || typeof value.revision !== "string" || !/^\d{4}-\d{2}-\d{2}\.\d+$/u.test(value.revision)) throw new Error("Invalid Scout taste version");
  if (!text(value.factsReviewedAt) || !/^\d{4}-\d{2}-\d{2}$/u.test(value.factsReviewedAt) || !text(value.opinionBasis)) throw new Error("Invalid Scout taste provenance");
  if (!isRecord(value.runtimes) || Object.keys(value.runtimes).length === 0 || Object.keys(value.runtimes).length > 64) throw new Error("Invalid Scout runtimes");
  if (!Array.isArray(value.sources) || value.sources.length > 64 || !value.sources.every(s => text(s) && s.startsWith("https://"))) throw new Error("Invalid Scout taste sources");
  for (const slot of Object.values(value.runtimes)) {
    if (!isRecord(slot) || ![slot.label, slot.providerId, slot.harness, slot.capability, slot.caution].every(text) || !nullableText(slot.effort) || !nullableText(slot.profile)) throw new Error("Invalid Scout runtime slot");
    if (!isRecord(slot.selector) || Object.keys(slot.selector).some(key => key !== "family" && key !== "tier") || Object.values(slot.selector).some(v => !text(v)) || Object.keys(slot.selector).length > 1) throw new Error("Invalid Scout model selector");
  }
  const roles = Object.keys(SCOUT_MODEL_TASTE.roles);
  if (!isRecord(value.roles) || Object.keys(value.roles).length !== roles.length || !roles.every(id => Object.hasOwn(value.roles as object, id))) throw new Error("Invalid Scout taste roles");
  for (const role of Object.values(value.roles)) {
    if (!isRecord(role) || ![role.label, role.objective, role.strategy].every(text) || !Array.isArray(role.candidates) || role.candidates.length === 0 || role.candidates.length > 20) throw new Error("Invalid Scout role candidates");
    for (const candidate of role.candidates) if (!isRecord(candidate) || typeof candidate.runtime !== "string" || !Object.hasOwn(value.runtimes, candidate.runtime) || typeof candidate.fit !== "number" || !Number.isFinite(candidate.fit) || candidate.fit < 0 || candidate.fit > 100 || !text(candidate.rationale)) throw new Error("Invalid Scout preference weight");
  }
}

/**
 * Resolve shorthand through a reviewed catalog; never invent provider-qualified IDs.
 *
 * Only slots the catalog can route are returned. A slot is left out when its
 * harness is missing or disabled, or when it names a family or tier and no
 * enabled model matches: a route without a model would silently fall back to
 * the harness default. A slot with an empty selector (the harness picks its
 * own model, as Kimi does) resolves with `model: null` on purpose.
 */
export function resolveScoutModelTaste(taste: ScoutModelTaste, catalog: ScoutOwnedRuntimeCatalog) {
  assertValidScoutModelTaste(taste);
  return Object.fromEntries(Object.entries(taste.runtimes).flatMap(([key, slot]) => {
    const harness = catalog.harnesses.find(h => h.id === slot.harness && h.enabled);
    if (!harness) return [];
    const wantsModel = Boolean(slot.selector.tier || slot.selector.family);
    const candidates = harness.models.filter(m => m.enabled && (slot.selector.tier ? m.id.endsWith(`-${slot.selector.tier}`) : slot.selector.family ? m.family === slot.selector.family : false));
    const model = candidates.find(m => m.default) ?? candidates[0];
    if (wantsModel && !model) return [];
    const label = model ? (slot.selector.tier ? `GPT-${model.version ?? model.label}` : model.label) : slot.label;
    return [[key, { label, route: { providerId: slot.providerId, harness: slot.harness, model: model?.id ?? null, effort: slot.effort, profile: slot.profile }, capability: slot.capability, caution: slot.caution }] as const];
  }));
}
