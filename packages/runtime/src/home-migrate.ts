import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  resolveOpenScoutCacheDir,
  resolveOpenScoutStateDir,
  resolveOpenScoutToolDir,
  resolveScoutHome,
  type ScoutHomeOptions,
} from "./scout-home.js";

const require = createRequire(import.meta.url);

export const HOME_MIGRATE_LOCK_FILENAME = "home-migrate.lock";
export const HOME_MIGRATE_JOURNAL_FILENAME = "home-migrate.journal.json";
export const HOME_MIGRATE_MOVED_FILENAME = "MOVED.md";

const PAIRING_DIR_MODE = 0o700;
const SQLITE_HEADER_MAGIC = "SQLite format 3\0";

const OPERATOR_CATALOG_NAMES = ["skills", "artifacts", "reports", "reviews"] as const;
const OPERATOR_CONFIG_NAMES = [
  "config.json",
  "user.json",
  "project.json",
  "continuation-policy.json",
  "crew.json",
] as const;
const OPENSCOUT_STATE_NAMES = [
  "control-plane",
  "relay",
  "instances",
  "work-archives",
  "backups",
] as const;
const OPENSCOUT_CACHE_NAMES = ["release-evidence", "evidence"] as const;
const LEGACY_SCOUT_STATE_NAMES = [
  "pairing",
  "local-edge",
  "world-team",
  "world-team-history",
] as const;
const LEGACY_SUPPORT_PRIORITY_NAMES = [
  "runtime",
  "logs",
  "deployments",
  "settings.json",
  "relay-agents.json",
  "managed-installs.json",
  "agent-status.json",
  "workspace-state.json",
  ".host-info",
  "catalog",
  "rpc-runtime-cutover-v1",
] as const;

export type HomeMigrationCategory =
  | "operator-catalog"
  | "operator-config"
  | "state"
  | "cache"
  | "tool"
  | "worktree";

export type HomeMigrationPlanAction = "move" | "conflict" | "skip" | "refused";

export type HomeMigrationPlanEntry = {
  id: string;
  category: HomeMigrationCategory;
  action: HomeMigrationPlanAction;
  sourceRoot: string;
  source: string;
  target: string | null;
  requiredMode?: number;
  reason?: string;
};

export type HomeMigrationPaths = {
  home: string;
  platform: NodeJS.Platform;
  openscoutHome: string;
  stateDir: string;
  cacheDir: string;
  deskDir: string;
  legacyScoutDir: string;
  legacySupportDir: string;
  legacyDeskDir: string;
  lockPath: string;
  journalPath: string;
};

export type HomeMigrationHostUpdateKind =
  | "launch-agent"
  | "systemd-unit"
  | "claude-settings"
  | "antigravity-hooks";

export type HomeMigrationHostUpdate = {
  kind: HomeMigrationHostUpdateKind;
  path: string;
  replacements: number;
};

export type HomeMigrationPlan = {
  paths: HomeMigrationPaths;
  entries: HomeMigrationPlanEntry[];
  moves: HomeMigrationPlanEntry[];
  conflicts: HomeMigrationPlanEntry[];
  skipped: HomeMigrationPlanEntry[];
  refused: HomeMigrationPlanEntry[];
  hostUpdates: HomeMigrationHostUpdate[];
};

export type HomeMigrationJournalEntryStatus = "pending" | "done" | "conflict" | "skipped";

export type HomeMigrationJournalEntry = {
  id: string;
  category: HomeMigrationCategory;
  sourceRoot: string;
  source: string;
  target: string;
  conflictTarget?: string;
  requiredMode?: number;
  status: HomeMigrationJournalEntryStatus;
  reason?: string;
  updatedAt: string;
};

export type HomeMigrationJournal = {
  version: 1;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  status: "in_progress" | "completed" | "failed";
  openscoutHome: string;
  stateDir: string;
  cacheDir: string;
  entries: HomeMigrationJournalEntry[];
  retiredRoots: string[];
  error?: string;
};

export type HomeMigrationLockInfo = {
  pid: number;
  startedAt: string;
  command: string;
};

export type HomeMigrationErrorCode =
  | "LOCK_HELD"
  | "SYMLINK_SOURCE"
  | "EXDEV"
  | "SQLITE_BUSY"
  | "WRITERS_RUNNING";

export class HomeMigrationError extends Error {
  readonly code: HomeMigrationErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: HomeMigrationErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "HomeMigrationError";
    this.code = code;
    this.details = details;
  }
}

export type RunHomeMigrationOptions = ScoutHomeOptions & {
  dryRun?: boolean;
  /** Verify all writers (broker, scoutd, app, web) are stopped before taking the lock. */
  assertWritersStopped?: () => Promise<void> | void;
  /** Clock override for deterministic dates in tests. */
  now?: () => Date;
  /** Rename implementation override for EXDEV and crash-recovery tests. */
  renameImpl?: (source: string, target: string) => void;
};

export type HomeMigrationResult = {
  dryRun: boolean;
  resumed: boolean;
  alreadyMigrated: boolean;
  paths: HomeMigrationPaths;
  plan: HomeMigrationPlan;
  journalPath: string;
  journal: HomeMigrationJournal | null;
  movedCount: number;
  conflictCount: number;
  skippedCount: number;
  refusedCount: number;
  checkpointedDatabases: string[];
  movedMarkers: string[];
  updatedHostFiles: HomeMigrationHostUpdate[];
};

export type HomeLayoutLegacyRootStatus = {
  path: string;
  exists: boolean;
  isSymlink: boolean;
  movedMarkerExists: boolean;
};

export type HomeLayoutStatus = {
  paths: HomeMigrationPaths;
  openscoutHomeExists: boolean;
  stateDirExists: boolean;
  cacheDirExists: boolean;
  deskDirExists: boolean;
  legacy: {
    scout: HomeLayoutLegacyRootStatus;
    support: HomeLayoutLegacyRootStatus;
    desk: HomeLayoutLegacyRootStatus;
  };
  lock: {
    path: string;
    held: boolean;
    info: HomeMigrationLockInfo | null;
  };
  journal: {
    path: string;
    exists: boolean;
    status: HomeMigrationJournal["status"] | null;
    startedAt: string | null;
    updatedAt: string | null;
    completedAt: string | null;
    doneCount: number;
    conflictCount: number;
    pendingCount: number;
    skippedCount: number;
  };
  pendingMoves: number;
  conflicts: number;
  refused: number;
  skipped: number;
  pendingHostUpdates: number;
  migrationPending: boolean;
  plan: HomeMigrationPlan;
};

type SqliteStatement = {
  get(...params: unknown[]): unknown;
};

type SqliteDatabaseHandle = {
  query?(sql: string): SqliteStatement;
  prepare?(sql: string): SqliteStatement;
  close(): void;
};

function resolveBaseHome(options: ScoutHomeOptions): string {
  const env = options.env ?? process.env;
  return options.home ?? env.HOME?.trim() ?? homedir();
}

function legacyPlatformSupportDir(
  home: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "OpenScout");
  }
  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  return join(xdgDataHome || join(home, ".local", "share"), "openscout");
}

export function resolveHomeMigrationPaths(options: ScoutHomeOptions = {}): HomeMigrationPaths {
  const env = options.env ?? process.env;
  const home = resolveBaseHome(options);
  const platform = options.platform ?? process.platform;
  const homeOptions: ScoutHomeOptions = { home, env, platform };
  const openscoutHome = resolveScoutHome(homeOptions);
  const stateDir = resolveOpenScoutStateDir(homeOptions);
  const cacheDir = resolveOpenScoutCacheDir(homeOptions);
  const deskDir = resolveOpenScoutToolDir("desk", homeOptions);
  const legacyScoutDir = join(home, ".scout");
  const legacySupportDir = legacyPlatformSupportDir(home, platform, env);
  const legacyDeskDir = join(home, ".scout-desk");

  return {
    home,
    platform,
    openscoutHome,
    stateDir,
    cacheDir,
    deskDir,
    legacyScoutDir,
    legacySupportDir,
    legacyDeskDir,
    lockPath: join(stateDir, HOME_MIGRATE_LOCK_FILENAME),
    journalPath: join(stateDir, HOME_MIGRATE_JOURNAL_FILENAME),
  };
}

function lstatSafe(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function sameResolvedPath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function isStrayTempOrBackup(name: string): boolean {
  return name.endsWith(".bak") || name.endsWith(".tmp");
}

function formatDateStamp(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function nextLegacyConflictPath(target: string, dateStamp: string): string {
  const base = `${target}.legacy-${dateStamp}`;
  if (!lstatSafe(base)) {
    return base;
  }
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!lstatSafe(candidate)) {
      return candidate;
    }
  }
  return `${base}-${Date.now()}`;
}

/**
 * Pure planner inspecting the home layout without creating directories,
 * acquiring locks, or mutating any files.
 */
export function planHomeMigration(options: ScoutHomeOptions = {}): HomeMigrationPlan {
  const paths = resolveHomeMigrationPaths(options);
  const entries: HomeMigrationPlanEntry[] = [];
  const seenSources = new Set<string>();

  const pushEntry = (entry: Omit<HomeMigrationPlanEntry, "id">) => {
    const normalizedSource = resolve(entry.source);
    if (seenSources.has(normalizedSource)) {
      return;
    }
    seenSources.add(normalizedSource);
    const id = `${entry.category}:${entries.length + 1}:${entry.source}`;
    entries.push({ id, ...entry });
  };

  const inspectCandidate = (input: {
    category: HomeMigrationCategory;
    sourceRoot: string;
    source: string;
    target: string;
    requiredMode?: number;
  }) => {
    if (sameResolvedPath(input.source, input.target)) {
      return;
    }
    const stat = lstatSafe(input.source);
    if (!stat) {
      return;
    }
    if (stat.isSymbolicLink()) {
      pushEntry({
        category: input.category,
        action: "refused",
        sourceRoot: input.sourceRoot,
        source: input.source,
        target: input.target,
        requiredMode: input.requiredMode,
        reason: `Refusing to migrate symbolic link source: ${input.source}`,
      });
      return;
    }
    const targetStat = lstatSafe(input.target);
    if (targetStat) {
      pushEntry({
        category: input.category,
        action: "conflict",
        sourceRoot: input.sourceRoot,
        source: input.source,
        target: input.target,
        requiredMode: input.requiredMode,
        reason: `Target already exists at ${input.target}; legacy source will be moved aside with a .legacy-YYYY-MM-DD suffix without merging or overwriting.`,
      });
      return;
    }
    pushEntry({
      category: input.category,
      action: "move",
      sourceRoot: input.sourceRoot,
      source: input.source,
      target: input.target,
      requiredMode: input.requiredMode,
    });
  };

  // 1. Legacy ~/.scout directory
  const legacyScoutStat = lstatSafe(paths.legacyScoutDir);
  if (legacyScoutStat && !sameResolvedPath(paths.legacyScoutDir, paths.openscoutHome)) {
    if (legacyScoutStat.isSymbolicLink()) {
      pushEntry({
        category: "operator-catalog",
        action: "refused",
        sourceRoot: paths.legacyScoutDir,
        source: paths.legacyScoutDir,
        target: paths.openscoutHome,
        reason: `Refusing to migrate symbolic link source root: ${paths.legacyScoutDir}`,
      });
    } else if (legacyScoutStat.isDirectory()) {
      // Operator catalogs: ~/.scout/{skills,artifacts,reports,reviews} -> ~/.openscout/...
      for (const name of OPERATOR_CATALOG_NAMES) {
        inspectCandidate({
          category: "operator-catalog",
          sourceRoot: paths.legacyScoutDir,
          source: join(paths.legacyScoutDir, name),
          target: join(paths.openscoutHome, name),
        });
      }

      // Operator config fallbacks: ~/.scout/{config.json,...} -> ~/.openscout/...
      for (const name of OPERATOR_CONFIG_NAMES) {
        inspectCandidate({
          category: "operator-config",
          sourceRoot: paths.legacyScoutDir,
          source: join(paths.legacyScoutDir, name),
          target: join(paths.openscoutHome, name),
        });
      }

      // Scout-owned state from ~/.scout: pairing (0700), local-edge, world-team*
      for (const name of LEGACY_SCOUT_STATE_NAMES) {
        inspectCandidate({
          category: "state",
          sourceRoot: paths.legacyScoutDir,
          source: join(paths.legacyScoutDir, name),
          target: join(paths.stateDir, name),
          ...(name === "pairing" ? { requiredMode: PAIRING_DIR_MODE } : {}),
        });
      }

      // Any additional world-team* directories under ~/.scout
      const extraScoutEntries = readdirSync(paths.legacyScoutDir).sort((left, right) => left.localeCompare(right));
      for (const name of extraScoutEntries) {
        if (!name.startsWith("world-team")) {
          continue;
        }
        if ((LEGACY_SCOUT_STATE_NAMES as readonly string[]).includes(name)) {
          continue;
        }
        inspectCandidate({
          category: "state",
          sourceRoot: paths.legacyScoutDir,
          source: join(paths.legacyScoutDir, name),
          target: join(paths.stateDir, name),
        });
      }

      // Live Git worktrees under ~/.scout/work are NEVER moved by rename.
      const workPath = join(paths.legacyScoutDir, "work");
      if (lstatSafe(workPath)) {
        pushEntry({
          category: "worktree",
          action: "skip",
          sourceRoot: paths.legacyScoutDir,
          source: workPath,
          target: null,
          reason: "Live Git worktrees are never renamed by scout home migrate; move them individually with `git worktree move`.",
        });
      }
    }
  }

  // 2. Scout-owned state from ~/.openscout -> ~/.openscout/state
  const openscoutStat = lstatSafe(paths.openscoutHome);
  if (openscoutStat && openscoutStat.isDirectory() && !openscoutStat.isSymbolicLink()) {
    for (const name of OPENSCOUT_STATE_NAMES) {
      inspectCandidate({
        category: "state",
        sourceRoot: paths.openscoutHome,
        source: join(paths.openscoutHome, name),
        target: join(paths.stateDir, name),
      });
    }

    // 3. Rebuildable cache from ~/.openscout -> ~/.openscout/cache
    for (const name of OPENSCOUT_CACHE_NAMES) {
      inspectCandidate({
        category: "cache",
        sourceRoot: paths.openscoutHome,
        source: join(paths.openscoutHome, name),
        target: join(paths.cacheDir, name),
      });
    }
  }

  // 4. Scout-owned state from legacy platform support directory -> ~/.openscout/state
  const legacySupportStat = lstatSafe(paths.legacySupportDir);
  if (legacySupportStat && !sameResolvedPath(paths.legacySupportDir, paths.stateDir)) {
    if (legacySupportStat.isSymbolicLink()) {
      pushEntry({
        category: "state",
        action: "refused",
        sourceRoot: paths.legacySupportDir,
        source: paths.legacySupportDir,
        target: paths.stateDir,
        reason: `Refusing to migrate symbolic link source root: ${paths.legacySupportDir}`,
      });
    } else if (legacySupportStat.isDirectory()) {
      const diskNames = readdirSync(paths.legacySupportDir).sort((left, right) => left.localeCompare(right));
      const orderedNames = [
        ...LEGACY_SUPPORT_PRIORITY_NAMES.filter((name) => diskNames.includes(name)),
        ...diskNames.filter((name) => !(LEGACY_SUPPORT_PRIORITY_NAMES as readonly string[]).includes(name)),
      ];

      for (const name of orderedNames) {
        if (name === HOME_MIGRATE_MOVED_FILENAME || name === ".DS_Store") {
          continue;
        }
        const source = join(paths.legacySupportDir, name);
        if (isStrayTempOrBackup(name)) {
          pushEntry({
            category: "state",
            action: "skip",
            sourceRoot: paths.legacySupportDir,
            source,
            target: null,
            reason: "Stray temporary/backup file (*.bak/*.tmp) is skipped during migration.",
          });
          continue;
        }
        inspectCandidate({
          category: "state",
          sourceRoot: paths.legacySupportDir,
          source,
          target: join(paths.stateDir, name),
        });
      }
    }
  }

  // 5. Scout Desk: ~/.scout-desk -> ~/.openscout/.desk
  const legacyDeskStat = lstatSafe(paths.legacyDeskDir);
  if (legacyDeskStat && !sameResolvedPath(paths.legacyDeskDir, paths.deskDir)) {
    inspectCandidate({
      category: "tool",
      sourceRoot: paths.legacyDeskDir,
      source: paths.legacyDeskDir,
      target: paths.deskDir,
    });
  }

  const hostUpdates = planHostReferenceUpdates(paths, options.env ?? process.env);

  return {
    paths,
    entries,
    moves: entries.filter((entry) => entry.action === "move"),
    conflicts: entries.filter((entry) => entry.action === "conflict"),
    skipped: entries.filter((entry) => entry.action === "skip"),
    refused: entries.filter((entry) => entry.action === "refused"),
    hostUpdates,
  };
}

const LAUNCH_AGENT_PLIST_PATTERN = /^app\.openscout(?:\.[^/]+)?\.plist$/;
const SYSTEMD_UNIT_PATTERN = /^openscout(?:[-.][^/]+)?\.service$/;

type HostTextReplacement = {
  from: string;
  to: string;
};

type PlannedHostFileRewrite = HomeMigrationHostUpdate & {
  nextContent: string;
  mode: number;
};

function replaceAllCount(input: string, from: string, to: string): { output: string; count: number } {
  if (!from || from === to || !input.includes(from)) {
    return { output: input, count: 0 };
  }
  const parts = input.split(from);
  return { output: parts.join(to), count: parts.length - 1 };
}

function applyTextReplacements(
  input: string,
  replacements: HostTextReplacement[],
): { output: string; count: number } {
  let output = input;
  let count = 0;
  for (const rule of replacements) {
    const applied = replaceAllCount(output, rule.from, rule.to);
    output = applied.output;
    count += applied.count;
  }
  return { output, count };
}

function rewriteJsonStrings(
  value: unknown,
  replacements: HostTextReplacement[],
): { value: unknown; count: number } {
  if (typeof value === "string") {
    const applied = applyTextReplacements(value, replacements);
    return { value: applied.output, count: applied.count };
  }
  if (Array.isArray(value)) {
    let total = 0;
    let changed = false;
    const next = value.map((item) => {
      const rewritten = rewriteJsonStrings(item, replacements);
      if (rewritten.count > 0) {
        total += rewritten.count;
        changed = true;
      }
      return rewritten.value;
    });
    return changed ? { value: next, count: total } : { value, count: 0 };
  }
  if (value && typeof value === "object") {
    let total = 0;
    let changed = false;
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      const rewritten = rewriteJsonStrings(entry, replacements);
      if (rewritten.count > 0) {
        total += rewritten.count;
        changed = true;
      }
      next[key] = rewritten.value;
    }
    return changed ? { value: next, count: total } : { value, count: 0 };
  }
  return { value, count: 0 };
}

function planTextHostRewrite(
  kind: HomeMigrationHostUpdateKind,
  filePath: string,
  replacements: HostTextReplacement[],
): PlannedHostFileRewrite | null {
  const stat = lstatSafe(filePath);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    return null;
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const applied = applyTextReplacements(raw, replacements);
  if (applied.count === 0 || applied.output === raw) {
    return null;
  }
  return {
    kind,
    path: filePath,
    replacements: applied.count,
    nextContent: applied.output,
    mode: stat.mode & 0o777,
  };
}

function planJsonHostRewrite(
  kind: HomeMigrationHostUpdateKind,
  filePath: string,
  replacements: HostTextReplacement[],
): PlannedHostFileRewrite | null {
  const stat = lstatSafe(filePath);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    return null;
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  if (!replacements.some((rule) => rule.from && rule.from !== rule.to && raw.includes(rule.from))) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const rewritten = rewriteJsonStrings(parsed, replacements);
  if (rewritten.count === 0) {
    return null;
  }
  const trailing = raw.endsWith("\n") ? "\n" : "";
  return {
    kind,
    path: filePath,
    replacements: rewritten.count,
    nextContent: `${JSON.stringify(rewritten.value, null, 2)}${trailing}`,
    mode: stat.mode & 0o777,
  };
}

function collectHostReferenceRewrites(
  paths: HomeMigrationPaths,
  env: NodeJS.ProcessEnv,
): PlannedHostFileRewrite[] {
  const rewrites: PlannedHostFileRewrite[] = [];

  const serviceReplacements: HostTextReplacement[] = [];
  if (!sameResolvedPath(paths.legacySupportDir, paths.stateDir)) {
    serviceReplacements.push({ from: paths.legacySupportDir, to: paths.stateDir });
  }
  const legacyControlHome = join(paths.openscoutHome, "control-plane");
  const targetControlHome = join(paths.stateDir, "control-plane");
  if (!sameResolvedPath(legacyControlHome, targetControlHome)) {
    serviceReplacements.push({ from: legacyControlHome, to: targetControlHome });
  }

  // 1. Service definitions (macOS LaunchAgents or Linux systemd user units)
  if (serviceReplacements.length > 0) {
    if (paths.platform === "darwin") {
      const launchAgentsDir = join(paths.home, "Library", "LaunchAgents");
      const dirStat = lstatSafe(launchAgentsDir);
      if (dirStat && dirStat.isDirectory() && !dirStat.isSymbolicLink()) {
        const names = readdirSync(launchAgentsDir)
          .filter((name) => LAUNCH_AGENT_PLIST_PATTERN.test(name))
          .sort((a, b) => a.localeCompare(b));
        for (const name of names) {
          const planned = planTextHostRewrite("launch-agent", join(launchAgentsDir, name), serviceReplacements);
          if (planned) {
            rewrites.push(planned);
          }
        }
      }
    } else {
      const xdgConfigHome = env.XDG_CONFIG_HOME?.trim() || join(paths.home, ".config");
      const systemdDir = join(xdgConfigHome, "systemd", "user");
      const dirStat = lstatSafe(systemdDir);
      if (dirStat && dirStat.isDirectory() && !dirStat.isSymbolicLink()) {
        const names = readdirSync(systemdDir)
          .filter((name) => SYSTEMD_UNIT_PATTERN.test(name))
          .sort((a, b) => a.localeCompare(b));
        for (const name of names) {
          const planned = planTextHostRewrite("systemd-unit", join(systemdDir, name), serviceReplacements);
          if (planned) {
            rewrites.push(planned);
          }
        }
      }
    }
  }

  // 2. Harness hook and statusline settings (only Scout's own runtime/hooks & runtime/statusline paths)
  if (!sameResolvedPath(paths.legacySupportDir, paths.stateDir)) {
    const legacyHooksDir = join(paths.legacySupportDir, "runtime", "hooks");
    const targetHooksDir = join(paths.stateDir, "runtime", "hooks");
    const legacyStatuslineDir = join(paths.legacySupportDir, "runtime", "statusline");
    const targetStatuslineDir = join(paths.stateDir, "runtime", "statusline");

    const antigravityPlanned = planJsonHostRewrite(
      "antigravity-hooks",
      join(paths.home, ".gemini", "config", "hooks.json"),
      [{ from: legacyHooksDir, to: targetHooksDir }],
    );
    if (antigravityPlanned) {
      rewrites.push(antigravityPlanned);
    }

    const claudePlanned = planJsonHostRewrite(
      "claude-settings",
      join(paths.home, ".claude", "settings.json"),
      [
        { from: legacyHooksDir, to: targetHooksDir },
        { from: legacyStatuslineDir, to: targetStatuslineDir },
      ],
    );
    if (claudePlanned) {
      rewrites.push(claudePlanned);
    }
  }

  return rewrites;
}

function planHostReferenceUpdates(
  paths: HomeMigrationPaths,
  env: NodeJS.ProcessEnv,
): HomeMigrationHostUpdate[] {
  return collectHostReferenceRewrites(paths, env).map(({ kind, path, replacements }) => ({
    kind,
    path,
    replacements,
  }));
}

function applyHostReferenceUpdates(
  paths: HomeMigrationPaths,
  env: NodeJS.ProcessEnv,
): HomeMigrationHostUpdate[] {
  const rewrites = collectHostReferenceRewrites(paths, env);
  const updated: HomeMigrationHostUpdate[] = [];
  for (const rewrite of rewrites) {
    writeFileAtomically(rewrite.path, rewrite.nextContent, rewrite.mode || 0o644);
    updated.push({
      kind: rewrite.kind,
      path: rewrite.path,
      replacements: rewrite.replacements,
    });
  }
  return updated;
}

function fsyncDirectory(dirPath: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dirPath, "r");
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EBADF" && code !== "EISDIR" && code !== "ENOENT" && code !== "EPERM") {
      throw error;
    }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore close failure after fsync
      }
    }
  }
}

function writeFileAtomically(filePath: string, content: string, mode = 0o600): void {
  const parent = dirname(filePath);
  mkdirSync(parent, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  const fd = openSync(tempPath, "w", mode);
  try {
    writeSync(fd, content, 0, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, filePath);
  fsyncDirectory(parent);
}

function readLockInfo(lockPath: string): HomeMigrationLockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<HomeMigrationLockInfo>;
    if (typeof parsed.pid === "number" && typeof parsed.startedAt === "string") {
      return {
        pid: parsed.pid,
        startedAt: parsed.startedAt,
        command: typeof parsed.command === "string" ? parsed.command : "scout home migrate",
      };
    }
    return null;
  } catch {
    return null;
  }
}

function acquireMigrationLock(lockPath: string, now: () => Date): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  const payload: HomeMigrationLockInfo = {
    pid: process.pid,
    startedAt: now().toISOString(),
    command: "scout home migrate",
  };
  let fd: number | null = null;
  try {
    fd = openSync(lockPath, "wx", 0o600);
    writeSync(fd, `${JSON.stringify(payload, null, 2)}\n`, 0, "utf8");
    fsyncSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const existing = readLockInfo(lockPath);
      const holder = existing
        ? ` (held by pid ${existing.pid} since ${existing.startedAt})`
        : "";
      throw new HomeMigrationError(
        "LOCK_HELD",
        `Cannot run \`scout home migrate\`: exclusive migration lock already exists at ${lockPath}${holder}. Wait for the active migration to finish or remove the stale lock if no migration is running.`,
        { lockPath, holder: existing },
      );
    }
    throw error;
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
  fsyncDirectory(dirname(lockPath));
}

function releaseMigrationLock(lockPath: string): void {
  try {
    rmSync(lockPath, { force: true });
    fsyncDirectory(dirname(lockPath));
  } catch {
    // best-effort cleanup on exit
  }
}

function readJournal(journalPath: string): HomeMigrationJournal | null {
  if (!existsSync(journalPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(journalPath, "utf8")) as Partial<HomeMigrationJournal>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) {
      return null;
    }
    return parsed as HomeMigrationJournal;
  } catch {
    return null;
  }
}

function writeJournal(journalPath: string, journal: HomeMigrationJournal, now: () => Date): void {
  journal.updatedAt = now().toISOString();
  writeFileAtomically(journalPath, `${JSON.stringify(journal, null, 2)}\n`, 0o600);
}

function isSqliteDatabaseFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (!lower.endsWith(".sqlite") && !lower.endsWith(".sqlite3") && !lower.endsWith(".db")) {
    return false;
  }
  const stat = lstatSafe(filePath);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size < SQLITE_HEADER_MAGIC.length) {
    return false;
  }
  const header = Buffer.alloc(SQLITE_HEADER_MAGIC.length);
  const fd = openSync(filePath, "r");
  try {
    const bytesRead = readSync(fd, header, 0, header.length, 0);
    if (bytesRead < SQLITE_HEADER_MAGIC.length) {
      return false;
    }
  } finally {
    closeSync(fd);
  }
  return header.toString("ascii") === SQLITE_HEADER_MAGIC;
}

function collectSqliteDatabases(rootPath: string): string[] {
  const results: string[] = [];
  const walk = (current: string) => {
    const stat = lstatSafe(current);
    if (!stat || stat.isSymbolicLink()) {
      return;
    }
    if (stat.isFile()) {
      if (isSqliteDatabaseFile(current)) {
        results.push(current);
      }
      return;
    }
    if (stat.isDirectory()) {
      const names = readdirSync(current).sort((left, right) => left.localeCompare(right));
      for (const name of names) {
        walk(join(current, name));
      }
    }
  };
  walk(rootPath);
  return results;
}

function openSqliteForCheckpoint(filePath: string): SqliteDatabaseHandle {
  if (typeof Bun !== "undefined") {
    const { Database } = require("bun:sqlite") as {
      Database: new (path: string, options?: { create?: boolean }) => SqliteDatabaseHandle;
    };
    return new Database(filePath, { create: false });
  }
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options?: { open?: boolean; readOnly?: boolean }) => SqliteDatabaseHandle;
  };
  return new DatabaseSync(filePath, { open: true, readOnly: false });
}

export function checkpointSqliteDatabase(filePath: string): void {
  const db = openSqliteForCheckpoint(filePath);
  try {
    const row = db.query
      ? db.query("PRAGMA wal_checkpoint(TRUNCATE);").get()
      : db.prepare?.("PRAGMA wal_checkpoint(TRUNCATE);").get();
    if (row && typeof row === "object" && "busy" in row && Number((row as { busy?: unknown }).busy) !== 0) {
      throw new HomeMigrationError(
        "SQLITE_BUSY",
        `SQLite database ${filePath} is busy during WAL checkpoint; stop all processes holding it open and re-run \`scout home migrate\`.`,
        { filePath, checkpoint: row },
      );
    }
  } finally {
    db.close();
  }
}

function renderMovedMarker(legacyRoot: string, openscoutHome: string, hasWorktrees: boolean): string {
  const lines = [
    "# OpenScout home moved",
    "",
    `Scout files from this folder have moved into \`~/.openscout\` (\`${openscoutHome}\`):`,
    "",
    "- Operator config and catalogs (`config.json`, `skills/`, `artifacts/`, `reports/`, `reviews/`) live at the top level of `~/.openscout/`.",
    "- Scout-owned runtime state (`control-plane/`, `runtime/`, `logs/`, `instances/`, `pairing/`, deployments, mesh identity) lives under `~/.openscout/state/`.",
    "- Rebuildable cache (`release-evidence/`, `evidence/`) lives under `~/.openscout/cache/`.",
    "- Sibling tool data lives under `~/.openscout/.<tool>/` (for example `.desk/`, `.studio/`).",
    "",
  ];
  if (hasWorktrees) {
    lines.push(
      "Existing Git worktrees under `~/.scout/work/` were left in place because renaming a worktree directory breaks Git backlinks. Relocate them individually with `git worktree move`.",
      "",
    );
  }
  lines.push(
    `Retired folder: \`${legacyRoot}\`. You may remove this folder once no legacy worktrees or files remain.`,
    "",
  );
  return lines.join("\n");
}

function isExdevError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EXDEV");
}

function executeSameVolumeRename(
  renameFn: (source: string, target: string) => void,
  source: string,
  target: string,
  journalPath: string,
  journal: HomeMigrationJournal,
  now: () => Date,
): void {
  try {
    renameFn(source, target);
  } catch (error) {
    if (isExdevError(error)) {
      const message = `Cross-volume rename (EXDEV) moving ${source} -> ${target}. \`scout home migrate\` never copies and deletes across volumes; place source and target on the same filesystem or override OPENSCOUT_HOME / OPENSCOUT_STATE_DIR / OPENSCOUT_CACHE_DIR.`;
      journal.status = "failed";
      journal.error = message;
      writeJournal(journalPath, journal, now);
      throw new HomeMigrationError("EXDEV", message, { source, target });
    }
    journal.status = "failed";
    journal.error = error instanceof Error ? error.message : String(error);
    writeJournal(journalPath, journal, now);
    throw error;
  }
}

/**
 * Execute (or preview with `dryRun: true`) the unified `~/.openscout` home migration.
 *
 * Invariants:
 * - `dryRun: true` never mutates disk or takes the exclusive lock.
 * - Verifies writers are stopped via `assertWritersStopped` before locking or writing.
 * - Acquires exclusive lock (`O_CREAT | O_EXCL`) at `~/.openscout/state/home-migrate.lock`.
 * - Refuses symlink sources without moving anything.
 * - Checkpoints every SQLite database (`PRAGMA wal_checkpoint(TRUNCATE)`) before moving.
 * - Journals planned moves before executing and marks each done after rename + directory fsync.
 * - Preserves conflicts by moving legacy sources aside with `.legacy-YYYY-MM-DD` (never merges DBs).
 * - Aborts immediately on `EXDEV` (never copies and deletes).
 * - Resumes cleanly from an incomplete journal after a crash without deleting unconfirmed sources.
 * - Never touches `~/.scout/work` or `~/.fab`.
 */
export async function runHomeMigration(options: RunHomeMigrationOptions = {}): Promise<HomeMigrationResult> {
  const dryRun = options.dryRun === true;
  const now = options.now ?? (() => new Date());
  const renameFn = options.renameImpl ?? renameSync;
  const plan = planHomeMigration(options);
  const { paths } = plan;

  if (dryRun) {
    return {
      dryRun: true,
      resumed: false,
      alreadyMigrated:
        plan.moves.length === 0
        && plan.conflicts.length === 0
        && plan.refused.length === 0
        && plan.hostUpdates.length === 0,
      paths,
      plan,
      journalPath: paths.journalPath,
      journal: readJournal(paths.journalPath),
      movedCount: 0,
      conflictCount: 0,
      skippedCount: plan.skipped.length,
      refusedCount: plan.refused.length,
      checkpointedDatabases: [],
      movedMarkers: [],
      updatedHostFiles: [],
    };
  }

  // Verify no symlink sources before touching anything or taking a lock.
  if (plan.refused.length > 0) {
    const details = plan.refused.map((entry) => entry.source).join(", ");
    throw new HomeMigrationError(
      "SYMLINK_SOURCE",
      `Refusing to run \`scout home migrate\`: symlink sources are not allowed (${details}). Resolve or remove symlinks first.`,
      { refused: plan.refused },
    );
  }

  // Confirm writers are stopped before creating state dir or acquiring lock.
  if (options.assertWritersStopped) {
    await options.assertWritersStopped();
  }

  const existingJournalBeforeLock = readJournal(paths.journalPath);
  const hasIncompleteJournal = Boolean(existingJournalBeforeLock && existingJournalBeforeLock.status !== "completed");
  const actionableEntries = plan.entries.filter(
    (entry): entry is HomeMigrationPlanEntry & { target: string } =>
      (entry.action === "move" || entry.action === "conflict") && entry.target !== null,
  );

  if (!hasIncompleteJournal && actionableEntries.length === 0 && plan.hostUpdates.length === 0) {
    return {
      dryRun: false,
      resumed: false,
      alreadyMigrated: true,
      paths,
      plan,
      journalPath: paths.journalPath,
      journal: existingJournalBeforeLock,
      movedCount: 0,
      conflictCount: 0,
      skippedCount: plan.skipped.length,
      refusedCount: 0,
      checkpointedDatabases: [],
      movedMarkers: [],
      updatedHostFiles: [],
    };
  }

  acquireMigrationLock(paths.lockPath, now);
  const checkpointedDatabases: string[] = [];
  const checkpointedSet = new Set<string>();
  const movedMarkers: string[] = [];

  try {
    if (!hasIncompleteJournal && actionableEntries.length === 0 && plan.hostUpdates.length > 0) {
      const updatedHostFiles = applyHostReferenceUpdates(paths, options.env ?? process.env);
      return {
        dryRun: false,
        resumed: false,
        alreadyMigrated: false,
        paths,
        plan,
        journalPath: paths.journalPath,
        journal: existingJournalBeforeLock,
        movedCount: 0,
        conflictCount: 0,
        skippedCount: plan.skipped.length,
        refusedCount: 0,
        checkpointedDatabases: [],
        movedMarkers: [],
        updatedHostFiles,
      };
    }
    const timestamp = now().toISOString();
    const dateStamp = formatDateStamp(now());
    const existingJournal = readJournal(paths.journalPath);
    let resumed = false;
    let journal: HomeMigrationJournal;

    if (existingJournal && existingJournal.status !== "completed") {
      resumed = true;
      journal = {
        ...existingJournal,
        status: "in_progress",
        error: undefined,
        updatedAt: timestamp,
        entries: existingJournal.entries.map((entry) => ({ ...entry })),
        retiredRoots: [...(existingJournal.retiredRoots ?? [])],
      };
      const trackedSources = new Set(journal.entries.map((entry) => resolve(entry.source)));
      for (const planned of actionableEntries) {
        if (trackedSources.has(resolve(planned.source))) {
          continue;
        }
        trackedSources.add(resolve(planned.source));
        journal.entries.push({
          id: planned.id,
          category: planned.category,
          sourceRoot: planned.sourceRoot,
          source: planned.source,
          target: planned.target,
          ...(planned.requiredMode !== undefined ? { requiredMode: planned.requiredMode } : {}),
          status: "pending",
          updatedAt: timestamp,
        });
      }
    } else {
      journal = {
        version: 1,
        startedAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
        status: "in_progress",
        openscoutHome: paths.openscoutHome,
        stateDir: paths.stateDir,
        cacheDir: paths.cacheDir,
        entries: actionableEntries.map((planned) => ({
          id: planned.id,
          category: planned.category,
          sourceRoot: planned.sourceRoot,
          source: planned.source,
          target: planned.target,
          ...(planned.requiredMode !== undefined ? { requiredMode: planned.requiredMode } : {}),
          status: "pending",
          updatedAt: timestamp,
        })),
        retiredRoots: [],
      };
    }

    // Persist planned journal before moving a single file.
    writeJournal(paths.journalPath, journal, now);

    // Execute every pending journal entry with WAL checkpointing, rename, and fsync.
    for (const entry of journal.entries) {
      if (entry.status !== "pending") {
        continue;
      }

      const sourceStat = lstatSafe(entry.source);
      const targetStat = lstatSafe(entry.target);

      // Crash-resume: previous run already moved source -> target before crashing.
      if (!sourceStat && targetStat) {
        if (entry.requiredMode !== undefined) {
          chmodSync(entry.target, entry.requiredMode);
        }
        fsyncDirectory(dirname(entry.source));
        fsyncDirectory(dirname(entry.target));
        entry.status = "done";
        entry.updatedAt = now().toISOString();
        writeJournal(paths.journalPath, journal, now);
        continue;
      }

      // Crash-resume: source already moved aside to conflictTarget.
      if (!sourceStat && entry.conflictTarget && lstatSafe(entry.conflictTarget)) {
        entry.status = "conflict";
        entry.updatedAt = now().toISOString();
        writeJournal(paths.journalPath, journal, now);
        continue;
      }

      // Source absent and target absent: skip cleanly without deleting anything.
      if (!sourceStat) {
        entry.status = "skipped";
        entry.reason = "Source no longer exists on disk during migration.";
        entry.updatedAt = now().toISOString();
        writeJournal(paths.journalPath, journal, now);
        continue;
      }

      if (sourceStat.isSymbolicLink()) {
        const message = `Refusing to migrate symbolic link source: ${entry.source}`;
        journal.status = "failed";
        journal.error = message;
        writeJournal(paths.journalPath, journal, now);
        throw new HomeMigrationError("SYMLINK_SOURCE", message, { source: entry.source });
      }

      // Checkpoint every SQLite database inside this source before renaming.
      for (const dbPath of collectSqliteDatabases(entry.source)) {
        if (checkpointedSet.has(dbPath)) {
          continue;
        }
        checkpointSqliteDatabase(dbPath);
        checkpointedSet.add(dbPath);
        checkpointedDatabases.push(dbPath);
      }

      mkdirSync(dirname(entry.target), { recursive: true });

      if (targetStat) {
        // Conflict: NEVER merge or overwrite target! Move legacy source aside.
        const asidePath = nextLegacyConflictPath(entry.target, dateStamp);
        entry.conflictTarget = asidePath;
        writeJournal(paths.journalPath, journal, now);

        executeSameVolumeRename(renameFn, entry.source, asidePath, paths.journalPath, journal, now);

        if (entry.requiredMode !== undefined) {
          chmodSync(asidePath, entry.requiredMode);
          chmodSync(entry.target, entry.requiredMode);
        }
        fsyncDirectory(dirname(entry.source));
        fsyncDirectory(dirname(asidePath));

        entry.status = "conflict";
        entry.reason = `Target already existed at ${entry.target}; legacy source preserved at ${asidePath}.`;
        entry.updatedAt = now().toISOString();
        writeJournal(paths.journalPath, journal, now);
        continue;
      }

      // Standard same-volume rename.
      executeSameVolumeRename(renameFn, entry.source, entry.target, paths.journalPath, journal, now);

      if (entry.requiredMode !== undefined) {
        chmodSync(entry.target, entry.requiredMode);
      }
      fsyncDirectory(dirname(entry.source));
      fsyncDirectory(dirname(entry.target));

      entry.status = "done";
      entry.updatedAt = now().toISOString();
      writeJournal(paths.journalPath, journal, now);
    }

    // Write MOVED.md into each retired legacy folder that still exists on disk.
    const retirableRoots = [paths.legacyScoutDir, paths.legacySupportDir];
    for (const legacyRoot of retirableRoots) {
      const rootEntries = journal.entries.filter((entry) => sameResolvedPath(entry.sourceRoot, legacyRoot));
      if (rootEntries.length === 0) {
        continue;
      }
      const allCompleted = rootEntries.every(
        (entry) => entry.status === "done" || entry.status === "conflict" || entry.status === "skipped",
      );
      if (!allCompleted) {
        continue;
      }
      const rootStat = lstatSafe(legacyRoot);
      if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        continue;
      }
      const markerPath = join(legacyRoot, HOME_MIGRATE_MOVED_FILENAME);
      const hasWorktrees = sameResolvedPath(legacyRoot, paths.legacyScoutDir)
        && Boolean(lstatSafe(join(paths.legacyScoutDir, "work")));
      writeFileSync(markerPath, renderMovedMarker(legacyRoot, paths.openscoutHome, hasWorktrees), "utf8");
      fsyncDirectory(legacyRoot);
      movedMarkers.push(markerPath);
      if (!journal.retiredRoots.includes(legacyRoot)) {
        journal.retiredRoots.push(legacyRoot);
      }
    }

    const updatedHostFiles = applyHostReferenceUpdates(paths, options.env ?? process.env);

    journal.status = "completed";
    journal.completedAt = now().toISOString();
    writeJournal(paths.journalPath, journal, now);

    const movedCount = journal.entries.filter((entry) => entry.status === "done").length;
    const conflictCount = journal.entries.filter((entry) => entry.status === "conflict").length;
    const journalSkippedCount = journal.entries.filter((entry) => entry.status === "skipped").length;

    return {
      dryRun: false,
      resumed,
      alreadyMigrated: false,
      paths,
      plan,
      journalPath: paths.journalPath,
      journal,
      movedCount,
      conflictCount,
      skippedCount: plan.skipped.length + journalSkippedCount,
      refusedCount: 0,
      checkpointedDatabases,
      movedMarkers,
      updatedHostFiles,
    };
  } finally {
    releaseMigrationLock(paths.lockPath);
  }
}

function inspectLegacyRoot(path: string): HomeLayoutLegacyRootStatus {
  const stat = lstatSafe(path);
  const exists = Boolean(stat);
  const isSymlink = Boolean(stat?.isSymbolicLink());
  const movedMarkerExists = Boolean(stat?.isDirectory() && !isSymlink && existsSync(join(path, HOME_MIGRATE_MOVED_FILENAME)));
  return { path, exists, isSymlink, movedMarkerExists };
}

/** Read-only status summary of the home layout and any pending migration items. */
export function inspectHomeLayoutStatus(options: ScoutHomeOptions = {}): HomeLayoutStatus {
  const plan = planHomeMigration(options);
  const { paths } = plan;
  const journal = readJournal(paths.journalPath);
  const lockHeld = Boolean(lstatSafe(paths.lockPath));
  const lockInfo = lockHeld ? readLockInfo(paths.lockPath) : null;

  const doneCount = journal ? journal.entries.filter((entry) => entry.status === "done").length : 0;
  const conflictCount = journal ? journal.entries.filter((entry) => entry.status === "conflict").length : 0;
  const pendingCount = journal ? journal.entries.filter((entry) => entry.status === "pending").length : 0;
  const skippedCount = journal ? journal.entries.filter((entry) => entry.status === "skipped").length : 0;

  return {
    paths,
    openscoutHomeExists: existsSync(paths.openscoutHome),
    stateDirExists: existsSync(paths.stateDir),
    cacheDirExists: existsSync(paths.cacheDir),
    deskDirExists: existsSync(paths.deskDir),
    legacy: {
      scout: inspectLegacyRoot(paths.legacyScoutDir),
      support: inspectLegacyRoot(paths.legacySupportDir),
      desk: inspectLegacyRoot(paths.legacyDeskDir),
    },
    lock: {
      path: paths.lockPath,
      held: lockHeld,
      info: lockInfo,
    },
    journal: {
      path: paths.journalPath,
      exists: Boolean(journal),
      status: journal?.status ?? null,
      startedAt: journal?.startedAt ?? null,
      updatedAt: journal?.updatedAt ?? null,
      completedAt: journal?.completedAt ?? null,
      doneCount,
      conflictCount,
      pendingCount,
      skippedCount,
    },
    pendingMoves: plan.moves.length,
    conflicts: plan.conflicts.length,
    refused: plan.refused.length,
    skipped: plan.skipped.length,
    pendingHostUpdates: plan.hostUpdates.length,
    migrationPending:
      plan.moves.length > 0
      || plan.conflicts.length > 0
      || plan.hostUpdates.length > 0
      || (journal !== null && journal.status !== "completed"),
    plan,
  };
}
