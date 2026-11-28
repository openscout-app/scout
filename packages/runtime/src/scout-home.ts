import { existsSync, lstatSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface ScoutHomeOptions {
  /** Inject HOME for sandboxes; never substitute the real home in tests. */
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

const TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function baseHome(options: ScoutHomeOptions): string {
  const env = options.env ?? process.env;
  return options.home ?? env.HOME?.trim() ?? homedir();
}

function explicitHomeOverride(env: NodeJS.ProcessEnv): string | undefined {
  return env.OPENSCOUT_HOME?.trim()
    || env.SCOUT_HOME?.trim()
    || env.OPENSCOUT_SCOUT_HOME?.trim()
    || undefined;
}

function legacyPlatformSupportDir(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "OpenScout");
  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  return join(xdgDataHome || join(home, ".local", "share"), "openscout");
}

/**
 * Pure resolution: importing or reading this module never moves user data.
 * One home root on every platform: ~/.openscout, overridden by OPENSCOUT_HOME
 * (with deprecated aliases SCOUT_HOME and OPENSCOUT_SCOUT_HOME).
 */
export function resolveScoutHome(options: ScoutHomeOptions = {}): string {
  const env = options.env ?? process.env;
  return explicitHomeOverride(env) ?? join(baseHome(options), ".openscout");
}

export const resolveOpenScoutHomeRoot = resolveScoutHome;

/** Scout-owned state directory: OPENSCOUT_STATE_DIR (alias OPENSCOUT_SUPPORT_DIRECTORY), default ~/.openscout/state. */
export function resolveOpenScoutStateDir(options: ScoutHomeOptions = {}): string {
  const env = options.env ?? process.env;
  return env.OPENSCOUT_STATE_DIR?.trim()
    || env.OPENSCOUT_SUPPORT_DIRECTORY?.trim()
    || join(resolveScoutHome(options), "state");
}

/** Rebuildable cache directory: OPENSCOUT_CACHE_DIR, default ~/.openscout/cache. */
export function resolveOpenScoutCacheDir(options: ScoutHomeOptions = {}): string {
  const env = options.env ?? process.env;
  return env.OPENSCOUT_CACHE_DIR?.trim()
    || join(resolveScoutHome(options), "cache");
}

/** Sibling tool dot-folder inside ~/.openscout (for example .studio, .desk, .feed). */
export function resolveOpenScoutToolDir(tool: string, options: ScoutHomeOptions = {}): string {
  const normalized = tool.trim().replace(/^\.+/, "");
  if (!TOOL_NAME_PATTERN.test(normalized)) {
    throw new Error(`Invalid OpenScout tool name ${JSON.stringify(tool)}: use lowercase letters, digits, and hyphens.`);
  }
  return join(resolveScoutHome(options), `.${normalized}`);
}

/**
 * Operator-facing read roots: ~/.openscout first, then legacy ~/.scout.
 * Explicit env overrides stay isolated and never fall back to ambient home.
 */
export function scoutHomeReadRoots(options: ScoutHomeOptions = {}): string[] {
  const env = options.env ?? process.env;
  const primary = resolveScoutHome(options);
  // Explicit overrides are isolation boundaries, not invitations to read real data.
  if (explicitHomeOverride(env)) return [primary];
  return [primary, join(baseHome(options), ".scout")];
}

/**
 * Scout-owned state read roots: ~/.openscout/state first, then legacy
 * Application Support / XDG data, ~/.openscout, and ~/.scout.
 * Explicit env overrides stay isolated.
 */
export function scoutStateReadRoots(options: ScoutHomeOptions = {}): string[] {
  const env = options.env ?? process.env;
  const primary = resolveOpenScoutStateDir(options);
  if (env.OPENSCOUT_STATE_DIR?.trim() || env.OPENSCOUT_SUPPORT_DIRECTORY?.trim() || explicitHomeOverride(env)) {
    return [primary];
  }
  const home = baseHome(options);
  const platform = options.platform ?? process.platform;
  const candidates = [
    primary,
    legacyPlatformSupportDir(home, platform, env),
    join(home, ".openscout"),
    join(home, ".scout"),
  ];
  return [...new Set(candidates)];
}

function child(root: string, name: string): string {
  const result = resolve(root, name);
  const rel = relative(resolve(root), result);
  if (!name || isAbsolute(name) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Scout home paths must be nonempty relative paths inside the home");
  }
  return result;
}

/** New (~/.openscout) wins; missing files fall back to legacy (~/.scout). Never creates either home. */
export function scoutHomeReadPath(name: string, options: ScoutHomeOptions = {}): string {
  const candidates = scoutHomeReadRoots(options).map((root) => child(root, name));
  return candidates.find((path) => existsSync(path)) ?? candidates[0]!;
}

/** New-only target inside ~/.openscout. */
export function scoutHomeWritePath(name: string, options: ScoutHomeOptions = {}): string {
  return child(resolveScoutHome(options), name);
}

/** New (~/.openscout/state) wins; missing state files fall back to legacy state roots. */
export function scoutStateReadPath(name: string, options: ScoutHomeOptions = {}): string {
  const candidates = scoutStateReadRoots(options).map((root) => child(root, name));
  return candidates.find((path) => existsSync(path)) ?? candidates[0]!;
}

/** New-only target inside ~/.openscout/state. */
export function scoutStateWritePath(name: string, options: ScoutHomeOptions = {}): string {
  return child(resolveOpenScoutStateDir(options), name);
}

/**
 * Offline whole-root fast path, not a live-broker migration API.
 * Moves legacy ~/.scout -> ~/.openscout when ~/.openscout does not exist yet.
 * The lifecycle owner must hold an exclusive admission lease across this call
 * and restart. A PID check, absent WAL, or SQLite backup is NOT such a lease.
 * Existing ~/.openscout trees need the journalled `scout home migrate` merge.
 */
export function moveLegacyScoutHomeOffline(
  options: ScoutHomeOptions & { assertExclusiveOwnership: () => void },
): "moved" | "absent" | "overridden" {
  const env = options.env ?? process.env;
  if (explicitHomeOverride(env)) return "overridden";
  const [target, legacy] = scoutHomeReadRoots(options);
  if (!existsSync(legacy!)) return "absent";
  options.assertExclusiveOwnership();
  if (existsSync(target!)) throw new Error("Scout home merge requires the coordinated migration journal; neither home was changed");
  if (!lstatSync(legacy!).isDirectory() || lstatSync(legacy!).isSymbolicLink()) {
    throw new Error("Refusing to migrate a symlink or non-directory Scout home");
  }
  // Same-parent rename moves SQLite + WAL + SHM together without copying.
  // EXDEV and all other failures propagate; never fall back to a partial copy.
  renameSync(legacy!, target!);
  return "moved";
}
