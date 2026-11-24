import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  CREW_CONFIG_VERSION,
  createEmptyCrewConfig,
  getCrewSlotProfile,
  isValidCrewKey,
  mergeCrewLayers,
  normalizeCrewKey,
  parseScoutRuntimeSpec,
  sanitizeCrewConfig,
  sanitizeCrewLayer,
  type CrewCheckReport,
  type CrewConfig,
  type CrewConfigIssue,
  type CrewLayerSource,
  type CrewPreset,
  type CrewRoleBinding,
  type CrewRoleCheckResult,
  type CrewRoleRungCheck,
  type CrewSlotProfile,
  type CrewWhoAmISummary,
  type ResolvedCrewRole,
  type SanitizedCrewLayer,
  type ScoutRuntimeSpec,
} from "@openscout/protocol";

import {
  loadHarnessCatalogSnapshot,
  type HarnessCatalogLoadOptions,
  type HarnessCatalogSnapshot,
} from "./harness-catalog.js";
import type { RuntimeEnv } from "./portable-types.js";
import {
  assertTestIsolatedUserData,
  resolveOpenScoutHome,
  resolveOpenScoutHomeForEnv,
} from "./support-paths.js";

export type CrewScope = "global" | "project";

export interface LoadedCrewState {
  globalPath: string;
  projectRoot: string | null;
  projectPath: string | null;
  global: CrewConfig;
  project: SanitizedCrewLayer | null;
  activePreset?: string;
  roles: Record<string, ResolvedCrewRole>;
  presets: Record<string, CrewPreset>;
  issues: CrewConfigIssue[];
}

export interface CrewHarnessAvailability {
  harness: string;
  available: boolean;
  state: "ready" | "configured" | "installed" | "missing" | "unknown";
  detail: string;
}

export interface CrewHostAvailability {
  host: string;
  reachable: boolean;
  local?: boolean;
  detail: string;
}

export interface CrewReachabilityChecker {
  checkHarness(harness: string): Promise<CrewHarnessAvailability> | CrewHarnessAvailability;
  checkHost?(host: string): Promise<CrewHostAvailability> | CrewHostAvailability;
}

export type CrewRoleAskResolution =
  | {
      ok: true;
      role: string;
      source: CrewLayerSource;
      binding: CrewRoleBinding;
      profile: CrewSlotProfile | null;
      selectedRuntime: string;
      selectedSpec: ScoutRuntimeSpec;
      selectedHost?: string;
      usedFallback: boolean;
      rungs: CrewRoleRungCheck[];
      issues: CrewConfigIssue[];
    }
  | {
      ok: false;
      code: "invalid_role_name" | "role_unconfigured" | "role_unavailable";
      role: string;
      error: string;
      rungs?: CrewRoleRungCheck[];
      issues: CrewConfigIssue[];
    };

export function resolveGlobalCrewConfigPath(env?: RuntimeEnv): string {
  const home = env ? resolveOpenScoutHomeForEnv(env) : resolveOpenScoutHome();
  return join(home, "crew.json");
}

export function resolveProjectCrewConfigPath(projectRoot: string): string {
  return join(resolve(projectRoot), ".openscout", "crew.json");
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Walk upward from `startDirectory` to find the nearest project root that owns
 * either `.openscout` or `.git`. Checking `.openscout` with `lstatSync` ensures
 * a symlinked `.openscout` at the repo root is discovered and explicitly rejected
 * rather than silently skipped in favor of an ancestor directory.
 */
export function findCrewProjectRoot(startDirectory: string): string | null {
  let current = resolve(startDirectory);
  let gitCandidate: string | null = null;

  while (true) {
    if (lstatOrNull(join(current, ".openscout"))) {
      return current;
    }
    if (!gitCandidate && lstatOrNull(join(current, ".git"))) {
      gitCandidate = current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return gitCandidate;
    }
    current = parent;
  }
}

function readRawJsonFileSafe(
  path: string,
  source: "global" | "project",
  options: { checkParentDir?: string } = {},
): { exists: boolean; data?: unknown; issues: CrewConfigIssue[] } {
  const issues: CrewConfigIssue[] = [];

  if (options.checkParentDir) {
    const dirStat = lstatOrNull(options.checkParentDir);
    if (!dirStat) {
      return { exists: false, issues };
    }
    if (dirStat.isSymbolicLink()) {
      issues.push({
        source,
        path: options.checkParentDir,
        code: "symlink_rejected",
        message: `skipping symlinked directory ${options.checkParentDir}`,
      });
      return { exists: false, issues };
    }
    if (!dirStat.isDirectory()) {
      issues.push({
        source,
        path: options.checkParentDir,
        code: "read_error",
        message: `expected directory at ${options.checkParentDir}`,
      });
      return { exists: false, issues };
    }
  }

  const fileStat = lstatOrNull(path);
  if (!fileStat) {
    return { exists: false, issues };
  }
  if (fileStat.isSymbolicLink()) {
    issues.push({
      source,
      path,
      code: "symlink_rejected",
      message: `skipping symlinked crew config ${path}`,
    });
    return { exists: false, issues };
  }
  if (!fileStat.isFile()) {
    issues.push({
      source,
      path,
      code: "read_error",
      message: `expected regular file at ${path}`,
    });
    return { exists: false, issues };
  }

  let rawText: string;
  try {
    rawText = readFileSync(path, "utf8");
  } catch (error) {
    issues.push({
      source,
      path,
      code: "read_error",
      message: `unable to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { exists: false, issues };
  }

  try {
    return { exists: true, data: JSON.parse(rawText), issues };
  } catch (error) {
    issues.push({
      source,
      path,
      code: "invalid_json",
      message: `malformed JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { exists: false, issues };
  }
}

export function loadCrewState(options: {
  projectRoot?: string | null;
  currentDirectory?: string;
  env?: RuntimeEnv;
  globalPath?: string;
} = {}): LoadedCrewState {
  const globalPath = options.globalPath ?? resolveGlobalCrewConfigPath(options.env);
  const projectRoot = options.projectRoot !== undefined
    ? (options.projectRoot ? resolve(options.projectRoot) : null)
    : options.currentDirectory
      ? findCrewProjectRoot(options.currentDirectory)
      : null;
  const projectPath = projectRoot ? resolveProjectCrewConfigPath(projectRoot) : null;

  const issues: CrewConfigIssue[] = [];

  let globalConfig = createEmptyCrewConfig();
  const globalRead = readRawJsonFileSafe(globalPath, "global");
  issues.push(...globalRead.issues);
  if (globalRead.exists) {
    const sanitized = sanitizeCrewConfig(globalRead.data, {
      source: "global",
      path: globalPath,
    });
    globalConfig = sanitized.config;
    issues.push(...sanitized.issues);
  }

  let projectLayer: SanitizedCrewLayer | null = null;
  if (projectRoot && projectPath) {
    const projectDir = join(projectRoot, ".openscout");
    const projectRead = readRawJsonFileSafe(projectPath, "project", {
      checkParentDir: projectDir,
    });
    issues.push(...projectRead.issues);
    if (projectRead.exists) {
      const sanitized = sanitizeCrewLayer(projectRead.data, {
        source: "project",
        path: projectPath,
        allowPartialRoles: true,
      });
      projectLayer = sanitized.layer;
      issues.push(...sanitized.issues);
    }
  }

  const merged = mergeCrewLayers({
    global: globalConfig,
    project: projectLayer,
    projectPath: projectPath ?? undefined,
  });
  issues.push(...merged.issues);

  return {
    globalPath,
    projectRoot,
    projectPath,
    global: globalConfig,
    project: projectLayer,
    ...(merged.activePreset ? { activePreset: merged.activePreset } : {}),
    roles: merged.roles,
    presets: merged.presets,
    issues,
  };
}

function assertNotSymlinkTarget(path: string, label: string): void {
  const stat = lstatOrNull(path);
  if (stat?.isSymbolicLink()) {
    throw new Error(`Refusing to write through symlinked ${label}: ${path}`);
  }
}

function formatCrewConfigJson(config: CrewConfig): string {
  const payload: CrewConfig = {
    version: CREW_CONFIG_VERSION,
    ...(config.activePreset ? { activePreset: config.activePreset } : {}),
    roles: config.roles,
    ...(config.presets && Object.keys(config.presets).length > 0 ? { presets: config.presets } : {}),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function saveGlobalCrewConfig(
  config: CrewConfig,
  options: { env?: RuntimeEnv; globalPath?: string } = {},
): string {
  if (!options.globalPath && !options.env?.OPENSCOUT_HOME?.trim()) {
    assertTestIsolatedUserData("write the OpenScout crew config", "OPENSCOUT_HOME");
  }
  const path = options.globalPath ?? resolveGlobalCrewConfigPath(options.env);
  assertNotSymlinkTarget(path, "crew config");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, formatCrewConfigJson(config), "utf8");
  return path;
}

export function saveProjectCrewConfig(projectRoot: string, config: CrewConfig): string {
  const root = resolve(projectRoot);
  const projectDir = join(root, ".openscout");
  const projectPath = join(projectDir, "crew.json");
  assertNotSymlinkTarget(projectDir, ".openscout directory");
  assertNotSymlinkTarget(projectPath, "project crew config");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(projectPath, formatCrewConfigJson(config), "utf8");
  return projectPath;
}

function readTargetCrewConfigForWrite(options: {
  scope: CrewScope;
  projectRoot?: string;
  currentDirectory?: string;
  env?: RuntimeEnv;
  globalPath?: string;
}): { path: string; projectRoot?: string; config: CrewConfig } {
  if (options.scope === "project") {
    const root = options.projectRoot
      ? resolve(options.projectRoot)
      : options.currentDirectory
        ? (findCrewProjectRoot(options.currentDirectory) ?? resolve(options.currentDirectory))
        : resolve(process.cwd());
    const projectDir = join(root, ".openscout");
    const path = resolveProjectCrewConfigPath(root);
    assertNotSymlinkTarget(projectDir, ".openscout directory");
    assertNotSymlinkTarget(path, "project crew config");
    const raw = readRawJsonFileSafe(path, "project", { checkParentDir: projectDir });
    const config = raw.exists
      ? sanitizeCrewConfig(raw.data, { source: "project", path }).config
      : createEmptyCrewConfig();
    return { path, projectRoot: root, config };
  }

  const path = options.globalPath ?? resolveGlobalCrewConfigPath(options.env);
  assertNotSymlinkTarget(path, "crew config");
  const raw = readRawJsonFileSafe(path, "global");
  const config = raw.exists
    ? sanitizeCrewConfig(raw.data, { source: "global", path }).config
    : createEmptyCrewConfig();
  return { path, config };
}

function validateBindingInput(role: string, binding: CrewRoleBinding): CrewRoleBinding {
  const runtime = binding.runtime?.trim();
  if (!runtime) {
    throw new Error(`role "${role}" requires a runtime`);
  }
  const parsedPrimary = parseScoutRuntimeSpec(runtime);
  if (!parsedPrimary.ok) {
    throw new Error(`runtime_spec_invalid: ${parsedPrimary.error}`);
  }

  let fallback: string[] | undefined;
  if (binding.fallback !== undefined) {
    const normalizedFallback: string[] = [];
    for (const item of binding.fallback) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      const parsed = parseScoutRuntimeSpec(trimmed);
      if (!parsed.ok) {
        throw new Error(`fallback runtime_spec_invalid (${trimmed}): ${parsed.error}`);
      }
      normalizedFallback.push(trimmed);
    }
    if (normalizedFallback.length > 0) {
      fallback = normalizedFallback;
    }
  }

  let pool: number | undefined;
  if (binding.pool !== undefined) {
    if (!Number.isSafeInteger(binding.pool) || binding.pool < 1) {
      throw new Error(`pool must be a positive integer (got ${binding.pool})`);
    }
    pool = binding.pool;
  }

  const host = binding.host?.trim() || undefined;
  const note = binding.note?.trim() || undefined;

  return {
    runtime,
    ...(fallback ? { fallback } : {}),
    ...(pool !== undefined ? { pool } : {}),
    ...(host ? { host } : {}),
    ...(note ? { note } : {}),
  };
}

export function setCrewRole(
  roleInput: string,
  bindingInput: CrewRoleBinding,
  options: {
    scope?: CrewScope;
    projectRoot?: string;
    currentDirectory?: string;
    env?: RuntimeEnv;
    globalPath?: string;
  } = {},
): { role: string; binding: CrewRoleBinding; path: string; scope: CrewScope } {
  const scope = options.scope ?? "global";
  const role = normalizeCrewKey(roleInput);
  if (!isValidCrewKey(role)) {
    throw new Error(`invalid crew role name "${roleInput}"`);
  }
  const binding = validateBindingInput(role, bindingInput);
  const target = readTargetCrewConfigForWrite({ ...options, scope });
  Object.defineProperty(target.config.roles, role, {
    value: binding,
    writable: true,
    enumerable: true,
    configurable: true,
  });

  const path = scope === "project"
    ? saveProjectCrewConfig(target.projectRoot!, target.config)
    : saveGlobalCrewConfig(target.config, { env: options.env, globalPath: options.globalPath });

  return { role, binding, path, scope };
}

export function unsetCrewRole(
  roleInput: string,
  options: {
    scope?: CrewScope;
    projectRoot?: string;
    currentDirectory?: string;
    env?: RuntimeEnv;
    globalPath?: string;
  } = {},
): { role: string; removed: boolean; path: string; scope: CrewScope } {
  const scope = options.scope ?? "global";
  const role = normalizeCrewKey(roleInput);
  if (!isValidCrewKey(role)) {
    throw new Error(`invalid crew role name "${roleInput}"`);
  }
  const target = readTargetCrewConfigForWrite({ ...options, scope });
  const removed = Object.prototype.hasOwnProperty.call(target.config.roles, role);
  if (removed) {
    delete target.config.roles[role];
    if (scope === "project") {
      saveProjectCrewConfig(target.projectRoot!, target.config);
    } else {
      saveGlobalCrewConfig(target.config, { env: options.env, globalPath: options.globalPath });
    }
  }
  return { role, removed, path: target.path, scope };
}

export function saveCrewPreset(
  nameInput: string,
  options: {
    note?: string;
    scope?: CrewScope;
    projectRoot?: string;
    currentDirectory?: string;
    env?: RuntimeEnv;
    globalPath?: string;
  } = {},
): { name: string; preset: CrewPreset; path: string; scope: CrewScope } {
  const scope = options.scope ?? "global";
  const name = normalizeCrewKey(nameInput);
  if (!isValidCrewKey(name)) {
    throw new Error(`invalid crew preset name "${nameInput}"`);
  }

  const effectiveState = loadCrewState({
    projectRoot: options.projectRoot,
    currentDirectory: options.currentDirectory,
    env: options.env,
    globalPath: options.globalPath,
  });
  const target = readTargetCrewConfigForWrite({ ...options, scope });
  const rolesSnapshot: Record<string, CrewRoleBinding> = {};
  const sourceRoles = scope === "global" ? target.config.roles : effectiveState.roles;
  for (const [role, binding] of Object.entries(sourceRoles)) {
    Object.defineProperty(rolesSnapshot, role, {
      value: {
        runtime: binding.runtime,
        ...(binding.fallback ? { fallback: [...binding.fallback] } : {}),
        ...(binding.pool !== undefined ? { pool: binding.pool } : {}),
        ...(binding.host ? { host: binding.host } : {}),
        ...(binding.note ? { note: binding.note } : {}),
      },
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  const note = options.note?.trim() || undefined;
  const preset: CrewPreset = {
    roles: rolesSnapshot,
    ...(note ? { note } : {}),
  };
  target.config.presets ??= {};
  Object.defineProperty(target.config.presets, name, {
    value: preset,
    writable: true,
    enumerable: true,
    configurable: true,
  });

  const path = scope === "project"
    ? saveProjectCrewConfig(target.projectRoot!, target.config)
    : saveGlobalCrewConfig(target.config, { env: options.env, globalPath: options.globalPath });

  return { name, preset, path, scope };
}

export function useCrewPreset(
  nameInput: string,
  options: {
    scope?: CrewScope;
    projectRoot?: string;
    currentDirectory?: string;
    env?: RuntimeEnv;
    globalPath?: string;
  } = {},
): { name: string; preset: CrewPreset; path: string; scope: CrewScope } {
  const scope = options.scope ?? "global";
  const name = normalizeCrewKey(nameInput);
  if (!isValidCrewKey(name)) {
    throw new Error(`invalid crew preset name "${nameInput}"`);
  }

  const state = loadCrewState({
    projectRoot: options.projectRoot,
    currentDirectory: options.currentDirectory,
    env: options.env,
    globalPath: options.globalPath,
  });
  const target = readTargetCrewConfigForWrite({ ...options, scope });
  const preset = target.config.presets?.[name] ?? state.presets[name];
  if (!preset) {
    const known = Object.keys(state.presets).sort();
    throw new Error(
      known.length > 0
        ? `crew preset "${name}" not found; available presets: ${known.join(", ")}`
        : `crew preset "${name}" not found; save one with: scout crew preset save ${name}`,
    );
  }

  target.config.activePreset = name;
  const nextRoles: Record<string, CrewRoleBinding> = {};
  for (const [role, binding] of Object.entries(preset.roles)) {
    Object.defineProperty(nextRoles, role, {
      value: {
        runtime: binding.runtime,
        ...(binding.fallback ? { fallback: [...binding.fallback] } : {}),
        ...(binding.pool !== undefined ? { pool: binding.pool } : {}),
        ...(binding.host ? { host: binding.host } : {}),
        ...(binding.note ? { note: binding.note } : {}),
      },
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  target.config.roles = nextRoles;

  const path = scope === "project"
    ? saveProjectCrewConfig(target.projectRoot!, target.config)
    : saveGlobalCrewConfig(target.config, { env: options.env, globalPath: options.globalPath });

  return { name, preset, path, scope };
}

export function createLocalCrewReachabilityChecker(options: {
  env?: RuntimeEnv;
  catalogOptions?: HarnessCatalogLoadOptions;
  catalogSnapshot?: HarnessCatalogSnapshot;
  checkHost?: (host: string) => Promise<CrewHostAvailability> | CrewHostAvailability;
} = {}): CrewReachabilityChecker {
  let snapshotPromise: Promise<HarnessCatalogSnapshot> | null = null;
  const getSnapshot = () => {
    if (options.catalogSnapshot) {
      return Promise.resolve(options.catalogSnapshot);
    }
    if (!snapshotPromise) {
      snapshotPromise = loadHarnessCatalogSnapshot({
        env: options.env ?? process.env,
        localOnly: true,
        ...options.catalogOptions,
      });
    }
    return snapshotPromise;
  };

  return {
    async checkHarness(harness: string): Promise<CrewHarnessAvailability> {
      const normalized = harness.trim().toLowerCase();
      const snapshot = await getSnapshot();
      const entry = snapshot.entries.find(
        (candidate) => candidate.harness === normalized
          || candidate.name === normalized
          || candidate.aliases?.includes(normalized),
      );
      if (!entry) {
        return {
          harness: normalized,
          available: false,
          state: "unknown",
          detail: `harness "${normalized}" is not in the local harness catalog`,
        };
      }
      const report = entry.readinessReport;
      const available = report.installed && report.configured;
      return {
        harness: normalized,
        available,
        state: report.state,
        detail: report.detail,
      };
    },
    ...(options.checkHost ? { checkHost: options.checkHost } : {}),
  };
}

async function evaluateRung(
  runtime: string,
  host: string | undefined,
  checker: CrewReachabilityChecker,
): Promise<{ rung: CrewRoleRungCheck; spec: ScoutRuntimeSpec | null }> {
  const parsed = parseScoutRuntimeSpec(runtime);
  if (!parsed.ok) {
    return {
      spec: null,
      rung: {
        runtime,
        ...(host ? { host } : {}),
        available: false,
        reason: `invalid runtime spec: ${parsed.error}`,
      },
    };
  }

  const spec = parsed.value;
  if (host) {
    if (!checker.checkHost) {
      return {
        spec,
        rung: {
          runtime,
          harness: spec.harness,
          ...(spec.model ? { model: spec.model } : {}),
          ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort } : {}),
          host,
          available: false,
          reason: `mesh host "${host}" reachability could not be verified`,
        },
      };
    }
    const hostStatus = await checker.checkHost(host);
    if (!hostStatus.reachable) {
      return {
        spec,
        rung: {
          runtime,
          harness: spec.harness,
          ...(spec.model ? { model: spec.model } : {}),
          ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort } : {}),
          host,
          available: false,
          reason: hostStatus.detail,
        },
      };
    }
    if (!hostStatus.local) {
      return {
        spec,
        rung: {
          runtime,
          harness: spec.harness,
          ...(spec.model ? { model: spec.model } : {}),
          ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort } : {}),
          host,
          available: true,
          reason: hostStatus.detail,
        },
      };
    }
  }

  const harnessStatus = await checker.checkHarness(spec.harness);
  return {
    spec,
    rung: {
      runtime,
      harness: spec.harness,
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort } : {}),
      ...(host ? { host } : {}),
      available: harnessStatus.available,
      reason: harnessStatus.detail,
    },
  };
}

export async function evaluateCrewRole(
  resolved: ResolvedCrewRole,
  checker: CrewReachabilityChecker,
): Promise<CrewRoleCheckResult> {
  const candidateRungs: Array<{ runtime: string; host?: string; isFallback: boolean }> = [
    { runtime: resolved.runtime, host: resolved.host, isFallback: false },
    ...(resolved.fallback ?? []).map((runtime) => ({ runtime, isFallback: true })),
  ];

  const rungs: CrewRoleRungCheck[] = [];
  let selectedRuntime: string | null = null;
  let selectedSpec: ScoutRuntimeSpec | null = null;
  let selectedHost: string | undefined;
  let usedFallback = false;

  for (const candidate of candidateRungs) {
    const evaluated = await evaluateRung(candidate.runtime, candidate.host, checker);
    rungs.push(evaluated.rung);
    if (selectedRuntime === null && evaluated.rung.available && evaluated.spec) {
      selectedRuntime = candidate.runtime;
      selectedSpec = evaluated.spec;
      selectedHost = candidate.host;
      usedFallback = candidate.isFallback;
    }
  }

  return {
    role: resolved.role,
    source: resolved.source,
    ...(resolved.presetName ? { presetName: resolved.presetName } : {}),
    binding: {
      runtime: resolved.runtime,
      ...(resolved.fallback ? { fallback: [...resolved.fallback] } : {}),
      ...(resolved.pool !== undefined ? { pool: resolved.pool } : {}),
      ...(resolved.host ? { host: resolved.host } : {}),
      ...(resolved.note ? { note: resolved.note } : {}),
    },
    profile: resolved.profile,
    available: selectedRuntime !== null,
    selectedRuntime,
    selectedSpec,
    ...(selectedHost ? { selectedHost } : {}),
    usedFallback,
    rungs,
  };
}

export async function checkCrewState(
  state: LoadedCrewState,
  checker: CrewReachabilityChecker = createLocalCrewReachabilityChecker(),
): Promise<CrewCheckReport> {
  const roleNames = Object.keys(state.roles).sort();
  const roles = await Promise.all(
    roleNames.map((name) => evaluateCrewRole(state.roles[name]!, checker)),
  );
  return {
    ...(state.activePreset ? { activePreset: state.activePreset } : {}),
    roles,
    issues: [...state.issues],
  };
}

export async function resolveCrewRoleForAsk(
  roleInput: string,
  options: {
    state?: LoadedCrewState;
    projectRoot?: string | null;
    currentDirectory?: string;
    env?: RuntimeEnv;
    globalPath?: string;
    checker?: CrewReachabilityChecker;
  } = {},
): Promise<CrewRoleAskResolution> {
  const role = normalizeCrewKey(roleInput);
  const state = options.state ?? loadCrewState({
    projectRoot: options.projectRoot,
    currentDirectory: options.currentDirectory,
    env: options.env,
    globalPath: options.globalPath,
  });

  if (!isValidCrewKey(role)) {
    return {
      ok: false,
      code: "invalid_role_name",
      role: roleInput,
      error: `invalid crew role name "${roleInput}"`,
      issues: state.issues,
    };
  }

  const configured = state.roles[role];
  if (!configured) {
    return {
      ok: false,
      code: "role_unconfigured",
      role,
      error: `crew role "${role}" is not configured. Configure it with: scout crew set ${role} <runtime>`,
      issues: state.issues,
    };
  }

  const checker = options.checker ?? createLocalCrewReachabilityChecker({ env: options.env });
  const checked = await evaluateCrewRole(configured, checker);
  if (!checked.available || !checked.selectedRuntime || !checked.selectedSpec) {
    const details = checked.rungs
      .map((rung) => `${rung.runtime}${rung.host ? `@${rung.host}` : ""}: ${rung.reason}`)
      .join("; ");
    return {
      ok: false,
      code: "role_unavailable",
      role,
      error: `crew role "${role}" has no available runtime (${details}). Run \`scout crew check\` or update with \`scout crew set ${role} <runtime>\`.`,
      rungs: checked.rungs,
      issues: state.issues,
    };
  }

  return {
    ok: true,
    role,
    source: checked.source,
    binding: checked.binding,
    profile: checked.profile,
    selectedRuntime: checked.selectedRuntime,
    selectedSpec: checked.selectedSpec,
    ...(checked.selectedHost ? { selectedHost: checked.selectedHost } : {}),
    usedFallback: checked.usedFallback,
    rungs: checked.rungs,
    issues: state.issues,
  };
}

export function buildCrewWhoAmISummary(input: {
  state: LoadedCrewState;
  check: CrewCheckReport;
  activeRole?: string | null;
}): CrewWhoAmISummary | null {
  const availableRoles = input.check.roles
    .filter((entry) => entry.available && entry.selectedRuntime)
    .map((entry) => ({
      role: entry.role,
      runtime: entry.selectedRuntime!,
      ...(entry.selectedHost ? { host: entry.selectedHost } : {}),
      ...(entry.binding.pool !== undefined ? { pool: entry.binding.pool } : {}),
      ...(entry.usedFallback ? { usedFallback: true } : {}),
      ...(entry.profile ? { economics: entry.profile.economics } : {}),
    }));

  const normalizedActiveRole = input.activeRole?.trim() ? normalizeCrewKey(input.activeRole) : null;
  let activeSeat: CrewWhoAmISummary["activeSeat"];
  if (normalizedActiveRole && isValidCrewKey(normalizedActiveRole)) {
    const configured = input.state.roles[normalizedActiveRole];
    const checked = input.check.roles.find((entry) => entry.role === normalizedActiveRole);
    activeSeat = {
      role: normalizedActiveRole,
      profile: getCrewSlotProfile(normalizedActiveRole),
      ...(checked?.selectedRuntime
        ? { runtime: checked.selectedRuntime }
        : configured?.runtime
          ? { runtime: configured.runtime }
          : {}),
      ...(configured?.note ? { note: configured.note } : {}),
    };
  }

  if (availableRoles.length === 0 && !activeSeat) {
    return null;
  }

  return {
    ...(input.state.activePreset ? { activePreset: input.state.activePreset } : {}),
    ...(activeSeat ? { activeSeat } : {}),
    availableRoles,
  };
}

export function crewConfigExists(path: string): boolean {
  return existsSync(path);
}
