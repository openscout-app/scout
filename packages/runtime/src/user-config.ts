import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { assertTestIsolatedUserData, resolveOpenScoutSupportPaths } from "./support-paths.js";
import { resolveOpenScoutHome } from "./support-paths.js";

export type InterruptThreshold = "always" | "blocking-only" | "batched" | "never";

/**
 * How the tail renders a thinking block the model returned with no text.
 *
 * Claude's API returns thinking blocks with an empty `thinking` field whenever
 * the caller leaves `display` at its default of `"omitted"` — which every
 * current model does, so every Claude transcript on disk has signed-but-empty
 * thinking. `hide` drops those beats (a row that promises reasoning and shows a
 * bare tag is worse than silence); `tag` keeps a marker for operators who want
 * to see that the agent stopped to think. Runtimes that DO return thinking text
 * (Kimi) are unaffected by this setting — their text always renders.
 */
export type TailThinkingMode = "hide" | "tag";
export type CommsChannel = "here" | "mobile" | "here+mobile";
export type CommsVerbosity = "terse" | "normal" | "detailed";
export type CommsTone = "direct" | "warm" | "formal";
export type ProvisionalAgentNamesMode = "replace" | "extend";
export type WorktreeRetireMode = "on" | "off";

export type OpenScoutUserConfig = {
  name?: string;
  handle?: string;
  pronouns?: string;
  hue?: number;
  /** Avatar monogram override. Empty/absent derives initials from `name`. */
  monogram?: string;
  /**
   * Crew face slug worn as the avatar. Empty/absent falls back to the monogram
   * coin, so a profile saved before this field existed keeps rendering.
   */
  avatar?: string;
  bio?: string;
  timezone?: string;
  workingHours?: string;
  interruptThreshold?: InterruptThreshold;
  batchWindow?: number;
  channel?: CommsChannel;
  verbosity?: CommsVerbosity;
  tone?: CommsTone;
  quietHours?: string;
  /** Custom rotation pool for ephemeral agent names (one entry per name). */
  provisionalAgentNames?: string[];
  /** `replace` uses only your list; `extend` prepends yours then Scout defaults. */
  provisionalAgentNamesMode?: ProvisionalAgentNamesMode;
  /** Advanced: path to a JSON name pool (`{ "names": [...] }` or a string array). */
  provisionalAgentNamesFile?: string;
  /** How the tail renders text-less thinking blocks. Default `hide`. */
  tailThinking?: TailThinkingMode;
  /**
   * Models pinned to the top of runtime pickers — `<harness>[/<model>]`
   * specs. Everything else stays listed below the pinned rows.
   */
  runtimeShortlist?: string[];
  /** Named `<harness>[/<model>[/<effort>]]` tuples shown as one-tap presets. */
  runtimePresets?: RuntimePresetConfig[];
  /** The runtime's periodic sweep of idle, clean, merged agent worktrees. Default `on`. */
  worktreeRetire?: WorktreeRetireMode;
  /** Hours a Scout worktree must sit idle before the sweep retires it. Default 24. */
  worktreeRetireIdleHours?: number;
};

export type RuntimePresetConfig = {
  id: string;
  label?: string;
  runtime: string;
};

function userConfigPath(): string {
  return join(resolveOpenScoutHome(), "user.json");
}

/**
 * Memoized against the file's stat identity: hot request paths resolve the
 * operator name/handle tens of thousands of times per request, and each
 * uncached call is an existsSync + readFileSync + JSON.parse. The stat itself
 * is throttled to {@link USER_CONFIG_STAT_INTERVAL_MS} so those bursts pay
 * for at most one stat, while another process's write (CLI, broker) is
 * noticed within that interval rather than being served stale for a fixed
 * TTL. `saveUserConfig` drops the memo so an in-process edit is visible
 * immediately; the path key drops it whenever `OPENSCOUT_HOME` changes
 * (test fixtures do this).
 */
let userConfigCache: {
  path: string;
  value: OpenScoutUserConfig;
  /** `ino:mtimeMs:size` of the file the memo parsed, or "missing". */
  fileKey: string;
  statCheckedAt: number;
} | null = null;

const USER_CONFIG_STAT_INTERVAL_MS = 100;

function userConfigFileKey(configPath: string): string {
  try {
    const stats = statSync(configPath);
    return `${stats.ino}:${stats.mtimeMs}:${stats.size}`;
  } catch {
    return "missing";
  }
}

function readUserConfigFromDisk(configPath: string, now: number): OpenScoutUserConfig {
  const fileKey = userConfigFileKey(configPath);
  let value: OpenScoutUserConfig = {};
  if (existsSync(configPath)) {
    try {
      value = JSON.parse(readFileSync(configPath, "utf8")) as OpenScoutUserConfig;
    } catch {
      value = {};
    }
  }
  userConfigCache = { path: configPath, value, fileKey, statCheckedAt: now };
  return { ...value };
}

export function loadUserConfig(now = Date.now()): OpenScoutUserConfig {
  const configPath = userConfigPath();
  if (userConfigCache && userConfigCache.path === configPath) {
    if (now - userConfigCache.statCheckedAt < USER_CONFIG_STAT_INTERVAL_MS) {
      // Shallow copy: callers mutate the returned object before saving it back.
      return { ...userConfigCache.value };
    }
    if (userConfigFileKey(configPath) === userConfigCache.fileKey) {
      userConfigCache.statCheckedAt = now;
      return { ...userConfigCache.value };
    }
  }
  return readUserConfigFromDisk(configPath, now);
}

/**
 * Always reads disk, bypassing the memo entirely. Use this for
 * read-modify-write flows: reading a memoized copy there can silently
 * overwrite a concurrent writer's update when saving the mutated result.
 */
export function loadUserConfigFresh(): OpenScoutUserConfig {
  return readUserConfigFromDisk(userConfigPath(), Date.now());
}

export function saveUserConfig(config: OpenScoutUserConfig): void {
  assertTestIsolatedUserData("write the OpenScout user config", "OPENSCOUT_HOME");
  const configPath = userConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  userConfigCache = null;
}

/** Test seam — drops the memo so a fixture's direct user.json write is seen at once. */
export function resetUserConfigCache(): void {
  userConfigCache = null;
}

function readSettingsOperatorName(): string {
  const settingsPath = resolveOpenScoutSupportPaths().settingsPath;
  if (!existsSync(settingsPath)) return "";
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      profile?: { operatorName?: unknown };
      operatorName?: unknown;
    };
    const candidate = typeof settings.profile?.operatorName === "string"
      ? settings.profile.operatorName
      : typeof settings.operatorName === "string"
        ? settings.operatorName
        : "";
    return candidate.trim();
  } catch {
    return "";
  }
}

export function resolveOperatorName(): string {
  const config = loadUserConfig();
  return config.name?.trim()
    || process.env.OPENSCOUT_OPERATOR_NAME?.trim()
    || readSettingsOperatorName()
    || process.env.USER?.trim()
    || "operator";
}

function normalizeHandle(value: string | undefined): string {
  return value?.trim().replace(/^@+/, "") ?? "";
}

export function resolveOperatorHandle(): string {
  const config = loadUserConfig();
  return normalizeHandle(config.handle)
    || normalizeHandle(process.env.OPENSCOUT_OPERATOR_HANDLE)
    || normalizeHandle(config.name)
    || normalizeHandle(process.env.OPENSCOUT_OPERATOR_NAME)
    || normalizeHandle(process.env.USER)
    || "operator";
}

const TAIL_THINKING_MODES: readonly TailThinkingMode[] = ["hide", "tag"];

function normalizeTailThinkingMode(value: unknown): TailThinkingMode | null {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return TAIL_THINKING_MODES.includes(raw as TailThinkingMode) ? (raw as TailThinkingMode) : null;
}

/**
 * Resolution order: `~/.openscout/user.json` → `OPENSCOUT_TAIL_THINKING` → `hide`.
 *
 * Memoized for one second: this is read per tail EVENT during ingest, and the
 * config lives on disk. A second is short enough that `scout config set
 * tail-thinking …` feels immediate and long enough that a burst of events does
 * not turn into a burst of stat calls.
 */
let tailThinkingCache: { value: TailThinkingMode; readAt: number } | null = null;

export function resolveTailThinkingMode(now = Date.now()): TailThinkingMode {
  if (tailThinkingCache && now - tailThinkingCache.readAt < 1_000) {
    return tailThinkingCache.value;
  }
  const value = normalizeTailThinkingMode(loadUserConfig().tailThinking)
    ?? normalizeTailThinkingMode(process.env.OPENSCOUT_TAIL_THINKING)
    ?? "hide";
  tailThinkingCache = { value, readAt: now };
  return value;
}

/** Test seam — drops the memos so a fixture's config/env change is seen at once. */
export function resetTailThinkingModeCache(): void {
  tailThinkingCache = null;
  userConfigCache = null;
}
