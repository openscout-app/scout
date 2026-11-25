import {
  parseScoutRuntimeSpec,
  type ScoutLaunchableHarness,
  type ScoutReasoningEffort,
  type ScoutRuntimeSpec,
} from "./runtime-execution.js";

export const CREW_CONFIG_VERSION = 1 as const;

export const BUILTIN_CREW_SLOT_IDS = [
  "architect",
  "lane",
  "worker",
  "systems",
  "stylist",
  "advisor",
] as const;

export type BuiltinCrewSlotId = typeof BUILTIN_CREW_SLOT_IDS[number];

export interface CrewSlotProfile {
  id: BuiltinCrewSlotId;
  label: string;
  economics: string;
  posture: string;
}

/**
 * Timeless economic and behavioral posture profiles.
 *
 * Scout core ships no hardcoded vendor model names or fallback chains; model
 * names change faster than working postures. Concrete bindings live in the
 * operator's ~/.openscout/crew.json and optional <project>/.openscout/crew.json.
 */
export const BUILTIN_CREW_SLOT_PROFILES: Readonly<Record<BuiltinCrewSlotId, CrewSlotProfile>> = {
  architect: {
    id: "architect",
    label: "Architect",
    economics: "Highest reasoning ceiling · scarce, premium tokens · single seat",
    posture: "Holds the system map, settles boundaries and contracts with the operator, cuts independent lanes, and reviews outcomes. Conserves turns and context; delegates mechanical edits and build loops.",
  },
  lane: {
    id: "lane",
    label: "Lane owner",
    economics: "Strong judgment + high efficiency · one per active lane",
    posture: "Owns a coherent lane end-to-end, makes tactical calls within settled boundaries, and delegates volume to workers or targeted checks to specialists when warranted.",
  },
  worker: {
    id: "worker",
    label: "Worker pool",
    economics: "Capable execution · low token cost / abundant quota · pool of N",
    posture: "Executes bounded implementation, refactors, test suites, and build-fix loops across isolated worktrees. Cost-effective enough to run in parallel.",
  },
  systems: {
    id: "systems",
    label: "Systems specialist",
    economics: "High-depth systems & verification · targeted bursts",
    posture: "Called in for complex runtime mechanics, process lifecycles, concurrency, package boundaries, and adversarial review.",
  },
  stylist: {
    id: "stylist",
    label: "Stylist",
    economics: "High visual & editorial taste · targeted passes",
    posture: "Elevates visual hierarchy, typography, layout rhythm, and copy within the existing frame rather than spending turns on plumbing.",
  },
  advisor: {
    id: "advisor",
    label: "Advisor",
    economics: "Second-opinion reasoning · targeted consults",
    posture: "Provides independent design critique, risk checks, and trade-off analysis without taking ownership of implementation.",
  },
};

export interface CrewRoleBinding {
  runtime: string;
  fallback?: string[];
  pool?: number;
  host?: string;
  note?: string;
}

export type CrewRolePartialOverride = Partial<CrewRoleBinding>;

export interface CrewPreset {
  roles: Record<string, CrewRoleBinding>;
  note?: string;
}

export interface CrewConfig {
  version: typeof CREW_CONFIG_VERSION;
  activePreset?: string;
  roles: Record<string, CrewRoleBinding>;
  presets?: Record<string, CrewPreset>;
}

export type CrewLayerSource = "global" | "project" | "preset";

export type CrewConfigIssueCode =
  | "symlink_rejected"
  | "invalid_json"
  | "invalid_schema"
  | "invalid_role_name"
  | "invalid_role_binding"
  | "invalid_runtime_spec"
  | "invalid_preset"
  | "read_error";

export interface CrewConfigIssue {
  source: "global" | "project";
  path: string;
  role?: string;
  preset?: string;
  code: CrewConfigIssueCode;
  message: string;
}

export interface ResolvedCrewRole extends CrewRoleBinding {
  role: string;
  source: CrewLayerSource;
  presetName?: string;
  profile: CrewSlotProfile | null;
}

export interface CrewRoleRungCheck {
  runtime: string;
  harness?: ScoutLaunchableHarness;
  model?: string;
  reasoningEffort?: ScoutReasoningEffort;
  host?: string;
  available: boolean;
  reason: string;
}

export interface CrewRoleCheckResult {
  role: string;
  source: CrewLayerSource;
  presetName?: string;
  binding: CrewRoleBinding;
  profile: CrewSlotProfile | null;
  available: boolean;
  selectedRuntime: string | null;
  selectedSpec: ScoutRuntimeSpec | null;
  selectedHost?: string;
  usedFallback: boolean;
  rungs: CrewRoleRungCheck[];
}

export interface CrewCheckReport {
  activePreset?: string;
  roles: CrewRoleCheckResult[];
  issues: CrewConfigIssue[];
}

export interface CrewWhoAmISummary {
  activePreset?: string;
  activeSeat?: {
    role: string;
    profile: CrewSlotProfile | null;
    runtime?: string;
    note?: string;
  };
  availableRoles: Array<{
    role: string;
    runtime: string;
    host?: string;
    pool?: number;
    usedFallback?: boolean;
    economics?: string;
  }>;
}

const FORBIDDEN_CREW_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const CREW_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isForbiddenCrewKey(key: string): boolean {
  return FORBIDDEN_CREW_KEYS.has(key);
}

export function normalizeCrewKey(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidCrewKey(value: string): boolean {
  const normalized = normalizeCrewKey(value);
  return Boolean(normalized)
    && !FORBIDDEN_CREW_KEYS.has(normalized)
    && CREW_KEY_PATTERN.test(normalized);
}

export function getCrewSlotProfile(role: string): CrewSlotProfile | null {
  const normalized = normalizeCrewKey(role);
  if (!Object.prototype.hasOwnProperty.call(BUILTIN_CREW_SLOT_PROFILES, normalized)) {
    return null;
  }
  return BUILTIN_CREW_SLOT_PROFILES[normalized as BuiltinCrewSlotId];
}

export function listBuiltinCrewSlotProfiles(): CrewSlotProfile[] {
  return BUILTIN_CREW_SLOT_IDS.map((id) => BUILTIN_CREW_SLOT_PROFILES[id]);
}

export function createEmptyCrewConfig(): CrewConfig {
  return {
    version: CREW_CONFIG_VERSION,
    roles: {},
    presets: {},
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function safeOwnEntries(record: Record<string, unknown>): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_CREW_KEYS.has(key)) continue;
    entries.push([key, record[key]]);
  }
  return entries;
}

function setSafeProp<T>(target: Record<string, T>, key: string, value: T): void {
  if (FORBIDDEN_CREW_KEYS.has(key)) return;
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function cloneBinding(binding: CrewRoleBinding): CrewRoleBinding {
  return {
    runtime: binding.runtime,
    ...(binding.fallback ? { fallback: [...binding.fallback] } : {}),
    ...(binding.pool !== undefined ? { pool: binding.pool } : {}),
    ...(binding.host !== undefined ? { host: binding.host } : {}),
    ...(binding.note !== undefined ? { note: binding.note } : {}),
  };
}

function clonePartialBinding(binding: CrewRolePartialOverride): CrewRolePartialOverride {
  return {
    ...(binding.runtime !== undefined ? { runtime: binding.runtime } : {}),
    ...(binding.fallback ? { fallback: [...binding.fallback] } : {}),
    ...(binding.pool !== undefined ? { pool: binding.pool } : {}),
    ...(binding.host !== undefined ? { host: binding.host } : {}),
    ...(binding.note !== undefined ? { note: binding.note } : {}),
  };
}

function sanitizeRoleBinding(
  raw: unknown,
  meta: {
    source: "global" | "project";
    path: string;
    role: string;
    preset?: string;
    allowPartial?: boolean;
  },
): { binding: CrewRolePartialOverride | null; issues: CrewConfigIssue[] } {
  const issues: CrewConfigIssue[] = [];
  const issue = (code: CrewConfigIssueCode, message: string): CrewConfigIssue => ({
    source: meta.source,
    path: meta.path,
    role: meta.role,
    ...(meta.preset ? { preset: meta.preset } : {}),
    code,
    message,
  });

  if (!isPlainRecord(raw)) {
    issues.push(issue("invalid_role_binding", `role "${meta.role}" must be an object`));
    return { binding: null, issues };
  }

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of safeOwnEntries(raw)) {
    setSafeProp(cleaned, key, value);
  }

  let runtime: string | undefined;
  if (cleaned.runtime !== undefined) {
    if (typeof cleaned.runtime !== "string" || !cleaned.runtime.trim()) {
      issues.push(issue("invalid_runtime_spec", `role "${meta.role}" has an empty or non-string runtime`));
      return { binding: null, issues };
    }
    const trimmed = cleaned.runtime.trim();
    const parsed = parseScoutRuntimeSpec(trimmed);
    if (!parsed.ok) {
      issues.push(issue("invalid_runtime_spec", `role "${meta.role}" has invalid runtime "${trimmed}": ${parsed.error}`));
      return { binding: null, issues };
    }
    runtime = trimmed;
  } else if (!meta.allowPartial) {
    issues.push(issue("invalid_role_binding", `role "${meta.role}" is missing a runtime`));
    return { binding: null, issues };
  }

  let fallback: string[] | undefined;
  if (cleaned.fallback !== undefined) {
    if (!Array.isArray(cleaned.fallback)) {
      issues.push(issue("invalid_role_binding", `role "${meta.role}" fallback must be an array of RuntimeSpec strings`));
      return { binding: null, issues };
    }
    const nextFallback: string[] = [];
    for (const item of cleaned.fallback) {
      if (typeof item !== "string" || !item.trim()) {
        issues.push(issue("invalid_runtime_spec", `role "${meta.role}" contains an empty or non-string fallback entry`));
        return { binding: null, issues };
      }
      const trimmed = item.trim();
      const parsed = parseScoutRuntimeSpec(trimmed);
      if (!parsed.ok) {
        issues.push(issue("invalid_runtime_spec", `role "${meta.role}" has invalid fallback runtime "${trimmed}": ${parsed.error}`));
        return { binding: null, issues };
      }
      nextFallback.push(trimmed);
    }
    fallback = nextFallback;
  }

  let pool: number | undefined;
  if (cleaned.pool !== undefined) {
    if (typeof cleaned.pool !== "number" || !Number.isSafeInteger(cleaned.pool) || cleaned.pool < 1) {
      issues.push(issue("invalid_role_binding", `role "${meta.role}" pool must be a positive integer`));
      return { binding: null, issues };
    }
    pool = cleaned.pool;
  }

  let host: string | undefined;
  if (cleaned.host !== undefined) {
    if (typeof cleaned.host !== "string" || !cleaned.host.trim()) {
      issues.push(issue("invalid_role_binding", `role "${meta.role}" host must be a non-empty string`));
      return { binding: null, issues };
    }
    host = cleaned.host.trim();
  }

  let note: string | undefined;
  if (cleaned.note !== undefined) {
    if (typeof cleaned.note !== "string") {
      issues.push(issue("invalid_role_binding", `role "${meta.role}" note must be a string`));
      return { binding: null, issues };
    }
    const trimmed = cleaned.note.trim();
    if (trimmed) {
      note = trimmed;
    }
  }

  if (runtime === undefined && fallback === undefined && pool === undefined && host === undefined && note === undefined) {
    issues.push(issue("invalid_role_binding", `role "${meta.role}" defines no valid fields`));
    return { binding: null, issues };
  }

  return {
    binding: {
      ...(runtime !== undefined ? { runtime } : {}),
      ...(fallback !== undefined ? { fallback } : {}),
      ...(pool !== undefined ? { pool } : {}),
      ...(host !== undefined ? { host } : {}),
      ...(note !== undefined ? { note } : {}),
    },
    issues,
  };
}

export interface SanitizedCrewLayer {
  version: typeof CREW_CONFIG_VERSION;
  activePreset?: string;
  roles: Record<string, CrewRolePartialOverride>;
  presets: Record<string, CrewPreset>;
}

export function sanitizeCrewLayer(
  raw: unknown,
  meta: {
    source: "global" | "project";
    path: string;
    allowPartialRoles?: boolean;
  },
): { layer: SanitizedCrewLayer; issues: CrewConfigIssue[] } {
  const issues: CrewConfigIssue[] = [];
  const empty: SanitizedCrewLayer = {
    version: CREW_CONFIG_VERSION,
    roles: {},
    presets: {},
  };

  if (!isPlainRecord(raw)) {
    issues.push({
      source: meta.source,
      path: meta.path,
      code: "invalid_schema",
      message: "crew.json must be a JSON object",
    });
    return { layer: empty, issues };
  }

  if (raw.version !== undefined && raw.version !== CREW_CONFIG_VERSION) {
    issues.push({
      source: meta.source,
      path: meta.path,
      code: "invalid_schema",
      message: `unsupported crew.json version "${String(raw.version)}"; expected ${CREW_CONFIG_VERSION}`,
    });
    return { layer: empty, issues };
  }

  let activePreset: string | undefined;
  if (raw.activePreset !== undefined) {
    if (typeof raw.activePreset !== "string" || !isValidCrewKey(raw.activePreset)) {
      issues.push({
        source: meta.source,
        path: meta.path,
        code: "invalid_preset",
        message: `invalid activePreset "${String(raw.activePreset)}"`,
      });
    } else {
      activePreset = normalizeCrewKey(raw.activePreset);
    }
  }

  const roles: Record<string, CrewRolePartialOverride> = {};
  if (raw.roles !== undefined) {
    if (!isPlainRecord(raw.roles)) {
      issues.push({
        source: meta.source,
        path: meta.path,
        code: "invalid_schema",
        message: "crew.json roles must be an object",
      });
    } else {
      for (const [rawRole, rawBinding] of safeOwnEntries(raw.roles)) {
        const normalizedRole = normalizeCrewKey(rawRole);
        if (!isValidCrewKey(rawRole)) {
          issues.push({
            source: meta.source,
            path: meta.path,
            role: rawRole,
            code: "invalid_role_name",
            message: `ignoring invalid role name "${rawRole}"`,
          });
          continue;
        }
        const sanitized = sanitizeRoleBinding(rawBinding, {
          source: meta.source,
          path: meta.path,
          role: normalizedRole,
          allowPartial: meta.allowPartialRoles,
        });
        issues.push(...sanitized.issues);
        if (sanitized.binding) {
          setSafeProp(roles, normalizedRole, sanitized.binding);
        }
      }
    }
  }

  const presets: Record<string, CrewPreset> = {};
  if (raw.presets !== undefined) {
    if (!isPlainRecord(raw.presets)) {
      issues.push({
        source: meta.source,
        path: meta.path,
        code: "invalid_preset",
        message: "crew.json presets must be an object",
      });
    } else {
      for (const [rawPresetName, rawPreset] of safeOwnEntries(raw.presets)) {
        const presetName = normalizeCrewKey(rawPresetName);
        if (!isValidCrewKey(rawPresetName)) {
          issues.push({
            source: meta.source,
            path: meta.path,
            preset: rawPresetName,
            code: "invalid_preset",
            message: `ignoring invalid preset name "${rawPresetName}"`,
          });
          continue;
        }
        if (!isPlainRecord(rawPreset) || !isPlainRecord(rawPreset.roles)) {
          issues.push({
            source: meta.source,
            path: meta.path,
            preset: presetName,
            code: "invalid_preset",
            message: `preset "${presetName}" must be an object with a roles map`,
          });
          continue;
        }
        let presetNote: string | undefined;
        if (rawPreset.note !== undefined) {
          if (typeof rawPreset.note !== "string") {
            issues.push({
              source: meta.source,
              path: meta.path,
              preset: presetName,
              code: "invalid_preset",
              message: `preset "${presetName}" note must be a string`,
            });
            continue;
          }
          const trimmed = rawPreset.note.trim();
          if (trimmed) presetNote = trimmed;
        }
        const presetRoles: Record<string, CrewRoleBinding> = {};
        for (const [rawRole, rawBinding] of safeOwnEntries(rawPreset.roles)) {
          const normalizedRole = normalizeCrewKey(rawRole);
          if (!isValidCrewKey(rawRole)) {
            issues.push({
              source: meta.source,
              path: meta.path,
              preset: presetName,
              role: rawRole,
              code: "invalid_role_name",
              message: `ignoring invalid role name "${rawRole}" in preset "${presetName}"`,
            });
            continue;
          }
          const sanitized = sanitizeRoleBinding(rawBinding, {
            source: meta.source,
            path: meta.path,
            role: normalizedRole,
            preset: presetName,
            allowPartial: false,
          });
          issues.push(...sanitized.issues);
          if (sanitized.binding?.runtime) {
            setSafeProp(presetRoles, normalizedRole, sanitized.binding as CrewRoleBinding);
          }
        }
        setSafeProp(presets, presetName, {
          roles: presetRoles,
          ...(presetNote ? { note: presetNote } : {}),
        });
      }
    }
  }

  return {
    layer: {
      version: CREW_CONFIG_VERSION,
      ...(activePreset ? { activePreset } : {}),
      roles,
      presets,
    },
    issues,
  };
}

export function sanitizeCrewConfig(
  raw: unknown,
  meta: { source: "global" | "project"; path: string },
): { config: CrewConfig; issues: CrewConfigIssue[] } {
  const { layer, issues } = sanitizeCrewLayer(raw, {
    ...meta,
    allowPartialRoles: false,
  });
  const roles: Record<string, CrewRoleBinding> = {};
  for (const [role, binding] of Object.entries(layer.roles)) {
    if (binding.runtime) {
      setSafeProp(roles, role, cloneBinding(binding as CrewRoleBinding));
    }
  }
  return {
    config: {
      version: CREW_CONFIG_VERSION,
      ...(layer.activePreset ? { activePreset: layer.activePreset } : {}),
      roles,
      presets: layer.presets,
    },
    issues,
  };
}

export interface MergedCrewResult {
  activePreset?: string;
  roles: Record<string, ResolvedCrewRole>;
  presets: Record<string, CrewPreset>;
  issues: CrewConfigIssue[];
}

function mergeRoleOverride(
  base: CrewRoleBinding,
  override: CrewRolePartialOverride,
): CrewRoleBinding {
  return {
    runtime: override.runtime ?? base.runtime,
    ...(override.fallback !== undefined
      ? { fallback: [...override.fallback] }
      : base.fallback !== undefined
        ? { fallback: [...base.fallback] }
        : {}),
    ...(override.pool !== undefined
      ? { pool: override.pool }
      : base.pool !== undefined
        ? { pool: base.pool }
        : {}),
    ...(override.host !== undefined
      ? { host: override.host }
      : base.host !== undefined
        ? { host: base.host }
        : {}),
    ...(override.note !== undefined
      ? { note: override.note }
      : base.note !== undefined
        ? { note: base.note }
        : {}),
  };
}

export function mergeCrewLayers(input: {
  global: CrewConfig;
  project?: SanitizedCrewLayer | null;
  projectPath?: string;
}): MergedCrewResult {
  const issues: CrewConfigIssue[] = [];
  const presets: Record<string, CrewPreset> = {};
  for (const [name, preset] of Object.entries(input.global.presets ?? {})) {
    const clonedRoles: Record<string, CrewRoleBinding> = {};
    for (const [role, binding] of Object.entries(preset.roles)) {
      setSafeProp(clonedRoles, role, cloneBinding(binding));
    }
    setSafeProp(presets, name, {
      roles: clonedRoles,
      ...(preset.note ? { note: preset.note } : {}),
    });
  }
  for (const [name, preset] of Object.entries(input.project?.presets ?? {})) {
    const clonedRoles: Record<string, CrewRoleBinding> = {};
    for (const [role, binding] of Object.entries(preset.roles)) {
      setSafeProp(clonedRoles, role, cloneBinding(binding));
    }
    setSafeProp(presets, name, {
      roles: clonedRoles,
      ...(preset.note ? { note: preset.note } : {}),
    });
  }

  const roles: Record<string, ResolvedCrewRole> = {};
  const applyPreset = (presetName: string | undefined) => {
    if (!presetName) return;
    const preset = presets[presetName];
    if (!preset) return;
    for (const [role, binding] of Object.entries(preset.roles)) {
      setSafeProp(roles, role, {
        ...cloneBinding(binding),
        role,
        source: "preset",
        presetName,
        profile: getCrewSlotProfile(role),
      });
    }
  };

  // 1. Global activePreset, then global explicit roles.
  applyPreset(input.global.activePreset);
  for (const [role, binding] of Object.entries(input.global.roles)) {
    const existing = roles[role];
    const merged = existing ? mergeRoleOverride(existing, binding) : cloneBinding(binding);
    setSafeProp(roles, role, {
      ...merged,
      role,
      source: "global",
      profile: getCrewSlotProfile(role),
    });
  }

  // 2. Project activePreset (if set), then project role overrides deep-merged per role.
  const activePreset = input.project?.activePreset ?? input.global.activePreset;
  if (input.project?.activePreset) {
    applyPreset(input.project.activePreset);
  }
  for (const [role, override] of Object.entries(input.project?.roles ?? {})) {
    const existing = roles[role];
    if (existing) {
      const merged = mergeRoleOverride(existing, clonePartialBinding(override));
      setSafeProp(roles, role, {
        ...merged,
        role,
        source: "project",
        profile: getCrewSlotProfile(role),
      });
    } else if (override.runtime) {
      setSafeProp(roles, role, {
        ...cloneBinding(override as CrewRoleBinding),
        role,
        source: "project",
        profile: getCrewSlotProfile(role),
      });
    } else {
      issues.push({
        source: "project",
        path: input.projectPath ?? ".openscout/crew.json",
        role,
        code: "invalid_role_binding",
        message: `project role "${role}" omits runtime and has no global role to inherit from`,
      });
    }
  }

  return {
    ...(activePreset ? { activePreset } : {}),
    roles,
    presets,
    issues,
  };
}
