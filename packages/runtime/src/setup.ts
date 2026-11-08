import type { RuntimeEnv } from "./portable-types.js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { access, chmod, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

import {
  BUILT_IN_AGENT_DEFINITION_IDS,
  formatAgentSelector,
  isScoutReservedAgentName,
  parseAgentSelector,
  normalizeAgentSelectorSegment,
  normalizeScoutPermissionProfile,
  isOpaqueChannelId,
  resolveAgentSelector,
  type AgentSelector,
  type AgentSelectorCandidate,
  type AgentCapability,
  type AgentHarness,
  type ScoutPermissionProfile,
} from "@openscout/protocol";

import { ensureHarnessCatalogOverrideFile } from "./harness-catalog.js";
import {
  claudeStatuslineCommandWrapperPath,
  isClaudeStatuslineWrapperIsolatedFromSettings,
  isOpenScoutClaudeStatuslineCommand,
  resolveClaudeStatuslineDelegatePath,
  resolveClaudeStatuslineWrapperPath,
  writeClaudeStatuslineDelegate,
} from "./claude-statusline.js";
import { upsertManagedInstall } from "./managed-installs.js";
import { readStableNodeQualifier } from "./node-identity.js";
import {
  defaultOpenScoutNetworkSettings,
  normalizeOpenScoutNetworkSettings,
  type OpenScoutNetworkRuntimeSettings,
} from "./open-scout-network.js";
import { assertTestIsolatedUserData, defaultOpenScoutSupportDirectory, ensureOpenScoutCleanSlateSync, resolveOpenScoutSupportPaths } from "./support-paths.js";
import type { RuntimePresetConfig } from "./user-config.js";
import { collectUserLevelProjectRootHints, encodeClaudeProjectsSlug } from "./user-project-hints.js";
import { isProdOpenScoutInstance, resolveOpenScoutInstanceName } from "./instance.js";

export type RelayRuntimeTransport = "claude_stream_json" | "codex_app_server" | "pi_rpc" | "grok_acp" | "kimi_acp" | "cursor_acp" | "opencode_acp" | "devin_acp" | "tmux" | "cursor_exec";
export type TelegramBridgeMode = "auto" | "webhook" | "polling";
export const SCOUT_AGENT_ID = "scout";
export const MANAGED_AGENT_HARNESSES = ["claude", "codex", "cursor", "devin", "grok", "grok-acp", "kimi", "pi", "opencode"] as const;
export type ManagedAgentHarness = typeof MANAGED_AGENT_HARNESSES[number];

export type RelayHarnessProfile = {
  cwd: string;
  transport: RelayRuntimeTransport;
  sessionId: string;
  launchArgs: string[];
  permissionProfile?: ScoutPermissionProfile;
};

export type RelayHarnessProfiles = Partial<Record<ManagedAgentHarness, RelayHarnessProfile>>;

export type RelayHarnessProfileInput = {
  cwd?: string;
  transport?: RelayRuntimeTransport;
  sessionId?: string;
  launchArgs?: string[];
  permissionProfile?: ScoutPermissionProfile;
};

export type OpenScoutProjectScriptSet = {
  default?: string;
  macos?: string;
  linux?: string;
  windows?: string;
};

export type OpenScoutProjectAction = {
  name: string;
  icon?: string;
  scripts: OpenScoutProjectScriptSet;
};

export type OpenScoutProjectEnvironment = {
  setup?: OpenScoutProjectScriptSet;
  actions?: OpenScoutProjectAction[];
};

export type OpenScoutCodexImport = {
  sourcePath: string;
  importedAt: number;
  version?: number;
  name?: string;
  environment?: OpenScoutProjectEnvironment;
};

export type OpenScoutClaudeImport = {
  sourcePath: string;
  importedAt: number;
  slug: string;
  memoryPath?: string;
  recentDirectories?: string[];
  gitBranches?: string[];
  sessionCount?: number;
};

export type OpenScoutProjectConfig = {
  version: 1;
  project: {
    id: string;
    name: string;
    root?: string;
  };
  environment?: OpenScoutProjectEnvironment;
  imports?: {
    codex?: OpenScoutCodexImport;
    claude?: OpenScoutClaudeImport;
  };
  agent?: {
    id?: string;
    displayName?: string;
    prompt?: {
      template?: string;
    };
    runtime?: {
      defaultHarness?: AgentHarness;
      profiles?: Partial<Record<ManagedAgentHarness, RelayHarnessProfileInput>>;
      /**
       * Project-scoped model shortlist and presets — the most specific layer
       * of the picker ordering (project → user → harness-native → broker).
       * Read-only in this pass; no CLI writer exists for project scope.
       */
      shortlist?: string[];
      presets?: RuntimePresetConfig[];
      defaults?: {
        cwd?: string;
        harness?: AgentHarness;
        transport?: RelayRuntimeTransport;
        sessionId?: string;
        launchArgs?: string[];
        permissionProfile?: ScoutPermissionProfile;
        capabilities?: AgentCapability[];
      };
    };
  };
};

export type SceneSurface = "mission-control";

export type SceneMatcher =
  | { kind: "all" }
  | { kind: "harness"; value: string }
  | { kind: "project"; value: string }
  | { kind: "branch"; value: string }
  | { kind: "agentClass"; value: string }
  | { kind: "agentIds"; ids: string[] }
  | { kind: "and"; of: SceneMatcher[] }
  | { kind: "or"; of: SceneMatcher[] };

export type SceneZone = {
  id: string;
  label: string;
  rect: { x: number; y: number; w: number; h: number };
  layout: "auto-pack" | "manual";
  match: SceneMatcher;
  color?: string;
};

export type SceneAgentOverride = {
  agentId: string;
  zoneId: string | null;
  position?: { x: number; y: number };
};

export type SceneBody = {
  version: 1;
  viewport: { pan: { x: number; y: number }; zoom: number } | null;
  zones: SceneZone[];
  overrides: SceneAgentOverride[];
  fallback: "auto-pack" | "hide";
};

export type Scene = {
  id: string;
  surface: SceneSurface;
  name: string;
  createdAt: number;
  updatedAt: number;
  body: SceneBody;
};

export type OpenScoutVoicePlayback = "browser" | "host";

export type OpenScoutSettings = {
  /** Opt-in local transcript search; DB, WAL and QMD stay within 256 MiB. */
  knowledgeIndexEnabled?: boolean;
  version: 1;
  profile: {
    operatorName: string;
  };
  onboarding: {
    operatorAnsweredAt: number | null;
    sourceRootsAnsweredAt: number | null;
    harnessChosenAt: number | null;
    inputsSavedAt: number | null;
    initRanAt: number | null;
    doctorRanAt: number | null;
    runtimesRanAt: number | null;
    completedAt: number | null;
    skippedAt: number | null;
  };
  node: {
    alias: string;
  };
  discovery: {
    contextRoot: string | null;
    workspaceRoots: string[];
    includeCurrentRepo: boolean;
    hiddenProjectRoots: string[];
  };
  agents: {
    defaultHarness: AgentHarness;
    defaultTransport: RelayRuntimeTransport;
    defaultCapabilities: AgentCapability[];
    sessionPrefix: string;
    coreAgents: string[];
  };
  bridges: {
    telegram: {
      enabled: boolean;
      mode: TelegramBridgeMode;
      botToken: string;
      secretToken: string;
      apiBaseUrl: string;
      userName: string;
      defaultConversationId: string;
      ownerNodeId: string;
    };
  };
  network: {
    openScoutNetwork: OpenScoutNetworkRuntimeSettings;
  };
  phone: {
    favorites: string[];
    quickHits: string[];
    preparedAt: number | null;
  };
  voice: {
    realtimeEnabled: boolean;
    /** Where web-originated speech is heard: this browser, or Scout Menu on the Mac. */
    playback: OpenScoutVoicePlayback;
  };
  ui: {
    scenes: Scene[];
    activeSceneIdBySurface: Partial<Record<SceneSurface, string | null>>;
  };
};

export type RelayAgentOverride = {
  agentId: string;
  definitionId?: string;
  displayName?: string;
  // Set when the agent is archived (hidden from the directory). Lives on the
  // persisted override so it survives config edits (the override converter
  // spreads existing fields) and the local→broker sync.
  archivedAt?: number;
  projectName?: string;
  projectRoot: string;
  projectConfigPath?: string | null;
  source?: "manifest" | "inferred" | "legacy-import" | "manual";
  startedAt?: number;
  systemPrompt?: string;
  launchArgs?: string[];
  capabilities?: AgentCapability[];
  defaultHarness?: AgentHarness;
  harnessProfiles?: Partial<Record<ManagedAgentHarness, RelayHarnessProfileInput>>;
  card?: {
    kind: "persistent" | "one_time";
    createdAt?: number;
    createdById?: string;
    expiresAt?: number;
    maxUses?: number;
    inboxConversationId?: string;
  };
  runtime?: {
    cwd?: string;
    harness?: AgentHarness;
    transport?: RelayRuntimeTransport;
    sessionId?: string;
    wakePolicy?: "on_demand";
  };
};

export type RelayAgentCardLifecycle = NonNullable<RelayAgentOverride["card"]>;

export type ResolvedRelayAgentConfig = {
  agentId: string;
  definitionId: string;
  displayName: string;
  projectName: string;
  projectRoot: string;
  projectConfigPath: string | null;
  source: "manifest" | "inferred" | "legacy-import" | "manual";
  registrationKind: "configured" | "discovered";
  startedAt: number;
  systemPrompt?: string;
  launchArgs: string[];
  capabilities: AgentCapability[];
  defaultHarness: ManagedAgentHarness;
  harnessProfiles: RelayHarnessProfiles;
  instance: {
    id: string;
    selector: string;
    defaultSelector: string;
    nodeQualifier: string;
    workspaceQualifier: string;
    branch: string | null;
    isDefault: true;
  };
  runtime: {
    cwd: string;
    harness: AgentHarness;
    transport: RelayRuntimeTransport;
    sessionId: string;
    wakePolicy: "on_demand";
  };
};

export type ProjectInventoryHarnessEvidence = {
  harness: ManagedAgentHarness;
  source: "manifest" | "marker" | "default";
  detail: string;
};

export type ProjectInventoryEntry = {
  agentId: string;
  definitionId: string;
  displayName: string;
  projectName: string;
  projectRoot: string;
  sourceRoot: string;
  relativePath: string;
  source: ResolvedRelayAgentConfig["source"];
  registrationKind: ResolvedRelayAgentConfig["registrationKind"];
  projectConfigPath: string | null;
  defaultHarness: ManagedAgentHarness;
  harnesses: ProjectInventoryHarnessEvidence[];
};

export type ProjectInventoryError = {
  code: "reserved_name_existing";
  projectRoot: string;
  sourceRoot: string;
  relativePath: string;
  message: string;
};

export type SetupResult = {
  supportDirectory: string;
  settingsPath: string;
  harnessCatalogPath: string;
  relayAgentsPath: string;
  managedInstallsPath: string;
  relayHubPath: string;
  currentProjectConfigPath: string | null;
  createdProjectConfig: boolean;
  settings: OpenScoutSettings;
  agents: ResolvedRelayAgentConfig[];
  discoveredAgents: ResolvedRelayAgentConfig[];
  projectInventory: ProjectInventoryEntry[];
  projectErrors: ProjectInventoryError[];
};

export type UpdateOpenScoutSettingsInput = {
  knowledgeIndexEnabled?: boolean;
  profile?: Partial<OpenScoutSettings["profile"]>;
  onboarding?: Partial<OpenScoutSettings["onboarding"]>;
  node?: Partial<OpenScoutSettings["node"]>;
  discovery?: Partial<OpenScoutSettings["discovery"]>;
  agents?: Partial<OpenScoutSettings["agents"]>;
  ui?: Partial<OpenScoutSettings["ui"]>;
  bridges?: {
    telegram?: Partial<OpenScoutSettings["bridges"]["telegram"]>;
  };
  network?: {
    openScoutNetwork?: Partial<OpenScoutSettings["network"]["openScoutNetwork"]>;
  };
  phone?: Partial<OpenScoutSettings["phone"]>;
  voice?: Partial<OpenScoutSettings["voice"]>;
};

type LegacyRelayConfig = {
  projectRoot?: string;
};

type LegacyAgentRecord = {
  project?: string;
  tmuxSession?: string;
  cwd?: string;
  startedAt?: number;
  systemPrompt?: string;
  harness?: AgentHarness;
  transport?: RelayRuntimeTransport;
  capabilities?: AgentCapability[];
  launchArgs?: string[];
};

type LegacyRelayAgentRecord = {
  cwd?: string;
  project?: string;
  session?: string;
};

function titleCaseWords(value: string): string {
  return value
    .split(/[\s._-]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function guessedOperatorName(): string {
  const seeded = process.env.OPENSCOUT_OPERATOR_NAME?.trim();
  if (seeded) {
    return seeded;
  }

  const candidates = [
    process.env.OPENSCOUT_OPERATOR_DISPLAY_NAME,
    process.env.USER,
    process.env.LOGNAME,
    process.env.USERNAME,
  ];

  try {
    candidates.push(userInfo().username);
  } catch {
    // Ignore OS user lookup failures and fall through to a neutral default.
  }

  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed) {
      continue;
    }
    const normalized = titleCaseWords(trimmed);
    if (normalized) {
      return normalized;
    }
  }

  return "Operator";
}

export const DEFAULT_OPERATOR_NAME = guessedOperatorName();
const DEFAULT_CAPABILITIES: AgentCapability[] = ["chat", "invoke", "deliver"];
const DEFAULT_TRANSPORT: RelayRuntimeTransport = "tmux";
const DEFAULT_TELEGRAM_MODE: TelegramBridgeMode = "polling";
const DEFAULT_TELEGRAM_CONVERSATION_ID = "";
const SETTINGS_VERSION = 1;
const PROJECT_CONFIG_VERSION = 1;
const PROJECT_SCAN_SKIP_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  ".turbo",
  ".next",
  ".cache",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "vendor",
  "Pods",
  ".venv",
  "venv",
  "target",
  ".gradle",
  "__pypackages__",
  ".tox",
  ".nox",
  ".mypy_cache",
  ".ruff_cache",
  ".pytest_cache",
  "bower_components",
  ".pnpm-store",
  ".pnpm",
  ".yarn",
  "tmp",
  ".tmp",
  "DerivedData",
]);
const PROJECT_STRONG_MARKERS = [
  ".openscout/project.json",
  ".git",
] as const;
/** Files/dirs that imply an AI/agent workspace — used only for discovery, not harness choice. */
const PROJECT_WEAK_MARKERS = [
  "AGENTS.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  "CODEX.md",
  "GEMINI.md",
  "GOOGLE.md",
  ".cursorrules",
  ".cursor",
  ".github/copilot-instructions.md",
  "opencode.json",
  ".opencode",
  "WARP.md",
  "CONTINUE.md",
  ".aider.conf.yml",
  ".aider",
  ".kilocode",
  ".factory",
  "PI.md",
  ".pi",
  "Cargo.toml",
  "go.mod",
  "go.work",
  "pyproject.toml",
  "setup.py",
  "Gemfile",
  "Package.swift",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "pubspec.yaml",
  "composer.json",
  "flake.nix",
] as const;
const PROJECT_HARNESS_MARKERS: Record<ManagedAgentHarness, readonly string[]> = {
  claude: [
    "CLAUDE.md",
    "CLAUDE.local.md",
    ".claude",
  ],
  codex: [
    "AGENTS.md",
    "CODEX.md",
    ".codex",
  ],
  cursor: [
    ".cursor",
    ".cursorrules",
  ],
  devin: [
    ".devin",
  ],
  grok: [
    "AGENTS.md",
    "Grok.md",
    ".grok",
  ],
  "grok-acp": [
    // ACP is an explicit runtime profile; do not infer it from the same
    // project markers as the interactive Grok CLI.
  ],
  kimi: [
    "KIMI.md",
    ".kimi",
    ".kimi-code",
  ],
  pi: [
    "PI.md",
    ".pi",
  ],
  opencode: [
    "OPENCODE.md",
    ".opencode",
  ],
};

function partitionFlatAndNestedMarkers(markers: readonly string[]): { flat: string[]; nested: string[] } {
  const flat: string[] = [];
  const nested: string[] = [];
  for (const marker of markers) {
    if (marker.includes("/")) {
      nested.push(marker);
    } else {
      flat.push(marker);
    }
  }
  return { flat, nested };
}

const PROJECT_STRONG_MARKERS_FLAT_NESTED = partitionFlatAndNestedMarkers(PROJECT_STRONG_MARKERS);
const PROJECT_WEAK_MARKERS_FLAT_NESTED = partitionFlatAndNestedMarkers(PROJECT_WEAK_MARKERS);

function matchFlatMarkers(entryNames: ReadonlySet<string>, flatMarkers: readonly string[]): string[] {
  const found: string[] = [];
  for (const marker of flatMarkers) {
    if (entryNames.has(marker)) {
      found.push(marker);
    }
  }
  return found;
}

async function matchNestedMarkers(projectRoot: string, nestedMarkers: readonly string[]): Promise<string[]> {
  if (nestedMarkers.length === 0) {
    return [];
  }
  const hits = await Promise.all(
    nestedMarkers.map(async (marker) => ((await pathExists(join(projectRoot, marker))) ? marker : null)),
  );
  return hits.filter((marker): marker is string => Boolean(marker));
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function expandHomePath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function compactHomePath(value: string): string {
  const home = homedir();
  return value.startsWith(home) ? value.replace(home, "~") : value;
}

function normalizePath(value: string): string {
  return resolve(expandHomePath(value.trim() || "."));
}

function normalizeProjectRelativePath(projectRoot: string, value: string): string {
  const expanded = expandHomePath(value.trim() || ".");
  return isAbsolute(expanded) ? resolve(expanded) : resolve(projectRoot, expanded);
}

function uniquePaths(values: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(values).map((value) => normalizePath(value))));
}

function normalizeAgentId(value: string): string {
  return normalizeAgentSelectorSegment(value);
}

function inferredAgentId(value: string): string {
  const normalized = normalizeAgentId(value);
  return isScoutReservedAgentName(normalized) ? `${normalized}-agent` : normalized;
}

function existingAgentId(value: string, source: string): string {
  const normalized = normalizeAgentId(value);
  if (isScoutReservedAgentName(normalized)) {
    throw new Error(
      `reserved_name_existing: ${source} defines reserved agent name "${normalized}"; `
        + `rename it to a non-runtime name such as "${normalized}-agent" before starting Scout`,
    );
  }
  return normalized;
}

function normalizeManagedHarness(
  value: string | undefined,
  fallback: ManagedAgentHarness,
): ManagedAgentHarness {
  if (value === "codex") {
    return "codex";
  }
  if (value === "claude") {
    return "claude";
  }
  if (value === "cursor") {
    return "cursor";
  }
  if (value === "devin") {
    return "devin";
  }
  if (value === "grok") {
    return "grok";
  }
  if (value === "grok-acp") {
    return "grok-acp";
  }
  if (value === "kimi") {
    return "kimi";
  }
  if (value === "pi") {
    return "pi";
  }
  if (value === "opencode") {
    return "opencode";
  }
  return fallback;
}

function titleCase(value: string): string {
  return value
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function normalizeSessionPrefix(value: string | undefined): string {
  const trimmed = (value ?? "").trim().replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "");
  return trimmed || "relay";
}

function normalizeOptionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(new Set(
    value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean),
  ));
}

function normalizeOptionalTimestamp(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return Math.floor(value);
}

function readEnvFileValue(filePath: string, key: string): string {
  try {
    if (!statSync(filePath).isFile()) return "";
    const raw = readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
      if (!normalized.startsWith(`${key}=`)) continue;

      let value = normalized.slice(key.length + 1).trim();
      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return value;
    }
  } catch {
    return "";
  }

  return "";
}

function resolveTelegramConfigSeedValue(
  key: string,
  currentDirectory?: string,
): string {
  const envValue = process.env[key]?.trim();
  if (envValue) {
    return envValue;
  }

  if (currentDirectory) {
    const currentDirValue = readEnvFileValue(join(currentDirectory, ".env.local"), key).trim();
    if (currentDirValue) {
      return currentDirValue;
    }
  }

  const home = homedir();
  if (!home) {
    return "";
  }

  return readEnvFileValue(join(home, ".env.local"), key).trim();
}

function normalizeTelegramBridgeMode(value: unknown): TelegramBridgeMode {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (normalized) {
    case "auto":
    case "webhook":
    case "polling":
      return normalized as TelegramBridgeMode;
    default:
      return DEFAULT_TELEGRAM_MODE;
  }
}

function normalizeTelegramConversationId(value: unknown): string {
  const normalized = normalizeOptionalString(value);
  return isOpaqueChannelId(normalized) ? normalized : DEFAULT_TELEGRAM_CONVERSATION_ID;
}

function resolveNodeQualifier(): string {
  // Priority: env var > settings alias > persisted machine identity > hostname.
  // The final fallback is for setup before the first broker boot only.
  const fromEnv = process.env.OPENSCOUT_NODE_QUALIFIER?.trim();
  if (fromEnv) {
    return normalizeAgentSelectorSegment(fromEnv) || "local";
  }

  const alias = readNodeAliasSync();
  if (alias) {
    return normalizeAgentSelectorSegment(alias) || "local";
  }

  const persisted = readStableNodeQualifier();
  if (persisted) {
    return persisted;
  }

  return normalizeAgentSelectorSegment(hostname() || "local") || "local";
}

function readNodeAliasSync(): string | null {
  try {
    const settingsPath = resolveOpenScoutSupportPaths().settingsPath;
    const raw = readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(raw) as { node?: { alias?: string } };
    return settings.node?.alias?.trim() || null;
  } catch {
    return null;
  }
}

function readGitHeadBranch(projectRoot: string): { found: boolean; branch: string | null } {
  const dotGitPath = join(projectRoot, ".git");
  let gitDirectory = dotGitPath;
  try {
    const marker = readFileSync(dotGitPath, "utf8");
    const match = /^gitdir:\s*(.+)\s*$/imu.exec(marker);
    if (!match?.[1]) return { found: false, branch: null };
    gitDirectory = isAbsolute(match[1])
      ? match[1]
      : resolve(projectRoot, match[1]);
  } catch {
    // A normal checkout has a .git directory, not a gitdir marker file.
  }

  try {
    const head = readFileSync(join(gitDirectory, "HEAD"), "utf8").trim();
    const match = /^ref:\s*refs\/heads\/(.+)$/u.exec(head);
    return { found: true, branch: match?.[1]?.trim() || null };
  } catch {
    return { found: false, branch: null };
  }
}

function detectGitBranchUncached(projectRoot: string): string | null {
  // Repo roots and worktrees expose the branch through .git/HEAD. Reading it
  // directly avoids spawning hundreds of git processes while resolving saved
  // relay agents during web startup and attention polling.
  const direct = readGitHeadBranch(projectRoot);
  if (direct.found) return direct.branch;

  // Prefer `symbolic-ref` so we still get a branch name on unborn HEADs
  // (freshly initialized repos with no commits yet). Fall back to
  // `rev-parse --abbrev-ref HEAD` for project paths below a repository root.
  try {
    const branch = execFileSync(
      "git",
      ["-C", projectRoot, "symbolic-ref", "--short", "HEAD"],
      { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" },
    ).trim();
    if (branch) {
      return branch;
    }
  } catch {
    // ignore and fall through
  }
  try {
    const branch = execFileSync(
      "git",
      ["-C", projectRoot, "rev-parse", "--abbrev-ref", "HEAD"],
      { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" },
    ).trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

// Per-projectRoot branch cache. `readRelayAgentOverrides` is called on every
// mobile createSession RPC and iterates every stored override. Branch changes
// are rare relative to those reads, and mutation paths can explicitly clear
// the cache when fresh identity is required.
const GIT_BRANCH_CACHE_TTL_MS = 5 * 60_000;
type GitBranchCacheEntry = { branch: string | null; expiresAt: number };
const gitBranchCache = new Map<string, GitBranchCacheEntry>();

function detectGitBranch(projectRoot: string): string | null {
  const now = Date.now();
  const cached = gitBranchCache.get(projectRoot);
  if (cached && cached.expiresAt > now) {
    return cached.branch;
  }
  const branch = detectGitBranchUncached(projectRoot);
  gitBranchCache.set(projectRoot, { branch, expiresAt: now + GIT_BRANCH_CACHE_TTL_MS });
  return branch;
}

export function clearGitBranchCache(projectRoot?: string): void {
  if (projectRoot) {
    gitBranchCache.delete(projectRoot);
  } else {
    gitBranchCache.clear();
  }
}

function resolveWorkspaceQualifier(projectRoot: string): { workspaceQualifier: string; branch: string | null } {
  const normalizedProjectRoot = normalizePath(projectRoot);
  const branch = detectGitBranch(normalizedProjectRoot);
  const workspaceQualifier = branch ? normalizeAgentSelectorSegment(branch) : "";

  return {
    workspaceQualifier,
    branch,
  };
}

export function buildRelayAgentInstance(agentId: string, projectRoot: string): ResolvedRelayAgentConfig["instance"] {
  const nodeQualifier = resolveNodeQualifier();
  const { workspaceQualifier, branch } = resolveWorkspaceQualifier(projectRoot);
  return {
    id: [agentId, workspaceQualifier, nodeQualifier].filter(Boolean).join("."),
    selector: formatAgentSelector({ definitionId: agentId, nodeQualifier, workspaceQualifier }),
    defaultSelector: formatAgentSelector({ definitionId: agentId }),
    nodeQualifier,
    workspaceQualifier,
    branch,
    isDefault: true,
  };
}

function normalizeTmuxSessionName(value: string | undefined, fallbackId: string, prefix = "relay"): string {
  const trimmed = (value ?? "").trim();
  const normalized = trimmed.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "");
  const fallback = `${normalizeSessionPrefix(prefix)}-${fallbackId}`
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback || "relay-agent";
}

function normalizeCapabilities(value: unknown): AgentCapability[] {
  const allowed = new Set<AgentCapability>([
    "chat",
    "invoke",
    "deliver",
    "speak",
    "listen",
    "bridge",
    "summarize",
    "review",
    "execute",
  ]);

  const normalized = Array.isArray(value)
    ? Array.from(new Set(value.map((entry) => String(entry).trim()).filter((entry): entry is AgentCapability => allowed.has(entry as AgentCapability))))
    : [];

  return normalized.length > 0 ? normalized : [...DEFAULT_CAPABILITIES];
}

function normalizeHarness(value: string | undefined, fallback: AgentHarness): AgentHarness {
  // Every managed harness survives a settings read. This used to keep only
  // claude/codex/cursor/pi, so a saved devin, opencode, grok-acp or kimi choice
  // was silently read back as Claude.
  return (MANAGED_AGENT_HARNESSES as readonly string[]).includes(value ?? "")
    ? value as ManagedAgentHarness
    : fallback;
}

function normalizeTransport(
  value: string | undefined,
  harness: AgentHarness,
  fallback: RelayRuntimeTransport,
): RelayRuntimeTransport {
  if (harness === "codex") {
    return "codex_app_server";
  }

  if (harness === "cursor") {
    return "cursor_acp";
  }

  if (harness === "devin") {
    return "devin_acp";
  }

  if (harness === "opencode") {
    return "opencode_acp";
  }

  if (harness === "grok-acp") {
    return "grok_acp";
  }

  if (harness === "kimi") {
    return "kimi_acp";
  }

  if (harness === "pi" && value === undefined) {
    return "pi_rpc";
  }

  if (value === "claude_stream_json") {
    return "claude_stream_json";
  }

  if (value === "codex_app_server") {
    return "codex_app_server";
  }

  if (value === "pi_rpc") {
    return "pi_rpc";
  }

  if (value === "grok_acp" || value === "kimi_acp" || value === "cursor_acp" || value === "opencode_acp" || value === "devin_acp") {
    return value;
  }

  if (value === "cursor_exec") {
    return "cursor_acp";
  }

  if (value === "tmux") {
    return "tmux";
  }

  return harness === "claude" || harness === "grok" ? "tmux" : fallback;
}

function normalizeHarnessProfile(
  profile: RelayHarnessProfileInput | undefined,
  harness: ManagedAgentHarness,
  options: {
    projectRoot: string;
    sessionKey: string;
    sessionPrefix: string;
    fallbackLaunchArgs?: string[];
    fallbackPermissionProfile?: ScoutPermissionProfile;
  },
): RelayHarnessProfile {
  const permissionProfile = normalizeScoutPermissionProfile(
    typeof profile?.permissionProfile === "string"
      ? profile.permissionProfile
      : options.fallbackPermissionProfile,
  );
  return {
    cwd: profile?.cwd ? normalizeProjectRelativePath(options.projectRoot, profile.cwd) : options.projectRoot,
    transport: normalizeTransport(profile?.transport, harness, harness === "codex" ? "codex_app_server" : DEFAULT_TRANSPORT),
    sessionId: normalizeTmuxSessionName(
      profile?.sessionId,
      `${options.sessionKey}-${harness}`,
      options.sessionPrefix,
    ),
    launchArgs: normalizeLaunchArgs(profile?.launchArgs ?? options.fallbackLaunchArgs),
    ...(permissionProfile ? { permissionProfile } : {}),
  };
}

function buildHarnessProfiles(input: {
  projectRoot: string;
  sessionKey: string;
  sessionPrefix: string;
  defaultHarness: ManagedAgentHarness;
  profiles?: Partial<Record<ManagedAgentHarness, RelayHarnessProfileInput>>;
  runtime?: {
    cwd?: string;
    harness?: AgentHarness;
    transport?: RelayRuntimeTransport;
    sessionId?: string;
  };
  launchArgs?: string[];
  permissionProfile?: ScoutPermissionProfile;
}): RelayHarnessProfiles {
  const profiles: RelayHarnessProfiles = {};
  const runtimeHarness = normalizeManagedHarness(
    typeof input.runtime === "object" && input.runtime && "harness" in input.runtime
      ? String((input.runtime as { harness?: string }).harness)
      : undefined,
    input.defaultHarness,
  );

  if (input.runtime || (input.launchArgs ?? []).length > 0) {
    profiles[runtimeHarness] = normalizeHarnessProfile({
      cwd: typeof input.runtime === "object" && input.runtime && "cwd" in input.runtime
        ? (input.runtime as { cwd?: string }).cwd
        : undefined,
      transport: typeof input.runtime === "object" && input.runtime && "transport" in input.runtime
        ? (input.runtime as { transport?: RelayRuntimeTransport }).transport
        : undefined,
      sessionId: typeof input.runtime === "object" && input.runtime && "sessionId" in input.runtime
        ? (input.runtime as { sessionId?: string }).sessionId
        : undefined,
      launchArgs: input.launchArgs,
    }, runtimeHarness, {
      projectRoot: input.projectRoot,
      sessionKey: input.sessionKey,
      sessionPrefix: input.sessionPrefix,
      fallbackLaunchArgs: input.launchArgs,
      fallbackPermissionProfile: input.permissionProfile,
    });
  }

  for (const harness of MANAGED_AGENT_HARNESSES) {
    const profile = input.profiles?.[harness];
    if (!profile && profiles[harness]) {
      continue;
    }
    if (profile) {
      profiles[harness] = normalizeHarnessProfile(profile, harness, {
        projectRoot: input.projectRoot,
        sessionKey: input.sessionKey,
        sessionPrefix: input.sessionPrefix,
        fallbackLaunchArgs: profiles[harness]?.launchArgs ?? input.launchArgs,
        fallbackPermissionProfile: profiles[harness]?.permissionProfile ?? input.permissionProfile,
      });
    }
  }

  const ensuredHarness = profiles[input.defaultHarness]
    ?? normalizeHarnessProfile(undefined, input.defaultHarness, {
      projectRoot: input.projectRoot,
      sessionKey: input.sessionKey,
      sessionPrefix: input.sessionPrefix,
      fallbackLaunchArgs: input.launchArgs,
      fallbackPermissionProfile: input.permissionProfile,
    });
  profiles[input.defaultHarness] = ensuredHarness;

  return profiles;
}

function resolvedRuntimeView(
  defaultHarness: ManagedAgentHarness,
  harnessProfiles: RelayHarnessProfiles,
): { runtime: ResolvedRelayAgentConfig["runtime"]; launchArgs: string[] } {
  const profile = harnessProfiles[defaultHarness];
  if (!profile) {
    throw new Error(`missing harness profile for ${defaultHarness}`);
  }

  return {
    runtime: {
      cwd: profile.cwd,
      harness: defaultHarness,
      transport: profile.transport,
      sessionId: profile.sessionId,
      wakePolicy: "on_demand",
    },
    launchArgs: [...profile.launchArgs],
  };
}

function normalizeLaunchArgs(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
}

function hasCustomCapabilities(value: unknown, defaults: AgentCapability[]): boolean {
  const normalized = normalizeCapabilities(value);
  return normalized.join("\n") !== normalizeCapabilities(defaults).join("\n");
}

function tmuxSessionExists(sessionId: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", sessionId], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function isConfiguredRelayAgentOverride(
  agentId: string,
  override: RelayAgentOverride | undefined,
  settings: OpenScoutSettings,
): boolean {
  if (!override?.source || override.source === "inferred") {
    return false;
  }

  if (override.source !== "legacy-import") {
    return true;
  }

  if (override.systemPrompt?.trim()) {
    return true;
  }

  if (normalizeLaunchArgs(override.launchArgs).length > 0) {
    return true;
  }

  if (hasCustomCapabilities(override.capabilities, settings.agents.defaultCapabilities)) {
    return true;
  }

  return tmuxSessionExists(
    normalizeTmuxSessionName(
      override.runtime?.sessionId,
      agentId,
      settings.agents.sessionPrefix,
    ),
  );
}

function defaultSettings(): OpenScoutSettings {
  const seededBotToken = resolveTelegramConfigSeedValue("TELEGRAM_BOT_TOKEN");
  return {
    knowledgeIndexEnabled: false,
    version: SETTINGS_VERSION,
    profile: {
      operatorName: DEFAULT_OPERATOR_NAME,
    },
    onboarding: {
      operatorAnsweredAt: null,
      sourceRootsAnsweredAt: null,
      harnessChosenAt: null,
      inputsSavedAt: null,
      initRanAt: null,
      doctorRanAt: null,
      runtimesRanAt: null,
      completedAt: null,
      skippedAt: null,
    },
    node: {
      alias: "",
    },
    discovery: {
      contextRoot: null,
      workspaceRoots: [],
      includeCurrentRepo: true,
      hiddenProjectRoots: [],
    },
    agents: {
      defaultHarness: "claude",
      defaultTransport: DEFAULT_TRANSPORT,
      defaultCapabilities: [...DEFAULT_CAPABILITIES],
      sessionPrefix: "relay",
      coreAgents: [],
    },
    bridges: {
      telegram: {
        enabled: Boolean(seededBotToken),
        mode: DEFAULT_TELEGRAM_MODE,
        botToken: seededBotToken,
        secretToken: resolveTelegramConfigSeedValue("TELEGRAM_WEBHOOK_SECRET_TOKEN"),
        apiBaseUrl: resolveTelegramConfigSeedValue("TELEGRAM_API_BASE_URL"),
        userName: resolveTelegramConfigSeedValue("TELEGRAM_BOT_USERNAME"),
        defaultConversationId: DEFAULT_TELEGRAM_CONVERSATION_ID,
        ownerNodeId: "",
      },
    },
    network: {
      openScoutNetwork: defaultOpenScoutNetworkSettings(),
    },
    phone: {
      favorites: [],
      quickHits: [],
      preparedAt: null,
    },
    voice: {
      realtimeEnabled: false,
      playback: "browser",
    },
    ui: {
      scenes: [],
      activeSceneIdBySurface: {},
    },
  };
}

function projectConfigPath(projectRoot: string): string {
  return join(projectRoot, ".openscout", "project.json");
}

function projectGitignorePath(projectRoot: string): string {
  return join(projectRoot, ".gitignore");
}

function legacyLocalRelayLinkPath(projectRoot: string): string {
  return join(projectRoot, ".openscout", "relay.json");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isDirectory();
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function codexEnvironmentPath(projectRoot: string): string {
  return join(projectRoot, ".codex", "environments", "environment.toml");
}

function currentHomeDirectory(): string {
  return process.env.HOME?.trim() || homedir();
}

function normalizeProjectScriptSet(value: unknown): OpenScoutProjectScriptSet | undefined {
  if (typeof value !== "object" || !value) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const next: OpenScoutProjectScriptSet = {};
  const defaults = [
    normalizeOptionalString(candidate.default),
    normalizeOptionalString(candidate.script),
    normalizeOptionalString(candidate.command),
  ].find(Boolean);
  const macos = [
    normalizeOptionalString(candidate.macos),
    normalizeOptionalString(candidate.macosScript),
    normalizeOptionalString(candidate.macosCommand),
    normalizeOptionalString((candidate.macos as Record<string, unknown> | undefined)?.script),
    normalizeOptionalString((candidate.macos as Record<string, unknown> | undefined)?.command),
  ].find(Boolean);
  const linux = [
    normalizeOptionalString(candidate.linux),
    normalizeOptionalString(candidate.linuxScript),
    normalizeOptionalString(candidate.linuxCommand),
    normalizeOptionalString((candidate.linux as Record<string, unknown> | undefined)?.script),
    normalizeOptionalString((candidate.linux as Record<string, unknown> | undefined)?.command),
  ].find(Boolean);
  const windows = [
    normalizeOptionalString(candidate.windows),
    normalizeOptionalString(candidate.windowsScript),
    normalizeOptionalString(candidate.windowsCommand),
    normalizeOptionalString((candidate.windows as Record<string, unknown> | undefined)?.script),
    normalizeOptionalString((candidate.windows as Record<string, unknown> | undefined)?.command),
  ].find(Boolean);

  if (defaults) {
    next.default = defaults;
  }
  if (macos) {
    next.macos = macos;
  }
  if (linux) {
    next.linux = linux;
  }
  if (windows) {
    next.windows = windows;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeProjectActions(value: unknown): OpenScoutProjectAction[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const actions: OpenScoutProjectAction[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || !entry) {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    const name = normalizeOptionalString(candidate.name);
    if (!name) {
      continue;
    }
    const scripts = normalizeProjectScriptSet(candidate);
    if (!scripts) {
      continue;
    }
    actions.push({
      name,
      icon: normalizeOptionalString(candidate.icon) || undefined,
      scripts,
    });
  }

  return actions.length > 0 ? actions : undefined;
}

function normalizeProjectEnvironment(value: unknown): OpenScoutProjectEnvironment | undefined {
  if (typeof value !== "object" || !value) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const setup = normalizeProjectScriptSet(candidate.setup);
  const actions = normalizeProjectActions(candidate.actions);
  if (!setup && !actions) {
    return undefined;
  }

  return {
    ...(setup ? { setup } : {}),
    ...(actions ? { actions } : {}),
  };
}

function normalizeCodexImport(value: unknown): OpenScoutCodexImport | undefined {
  if (typeof value !== "object" || !value) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const sourcePath = normalizeOptionalString(candidate.sourcePath);
  if (!sourcePath) {
    return undefined;
  }

  return {
    sourcePath,
    importedAt: Number.isFinite(candidate.importedAt) ? Number(candidate.importedAt) : nowSeconds(),
    version: Number.isFinite(candidate.version) ? Number(candidate.version) : undefined,
    name: normalizeOptionalString(candidate.name) || undefined,
    ...(normalizeProjectEnvironment(candidate.environment) ? { environment: normalizeProjectEnvironment(candidate.environment) } : {}),
  };
}

function normalizeClaudeImport(value: unknown): OpenScoutClaudeImport | undefined {
  if (typeof value !== "object" || !value) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const sourcePath = normalizeOptionalString(candidate.sourcePath);
  const slug = normalizeOptionalString(candidate.slug);
  if (!sourcePath || !slug) {
    return undefined;
  }

  const recentDirectories = Array.isArray(candidate.recentDirectories)
    ? candidate.recentDirectories.map((entry) => normalizeOptionalString(entry)).filter(Boolean)
    : [];
  const gitBranches = Array.isArray(candidate.gitBranches)
    ? candidate.gitBranches.map((entry) => normalizeOptionalString(entry)).filter(Boolean)
    : [];

  return {
    sourcePath,
    importedAt: Number.isFinite(candidate.importedAt) ? Number(candidate.importedAt) : nowSeconds(),
    slug,
    memoryPath: normalizeOptionalString(candidate.memoryPath) || undefined,
    ...(recentDirectories.length > 0 ? { recentDirectories } : {}),
    ...(gitBranches.length > 0 ? { gitBranches } : {}),
    ...(Number.isFinite(candidate.sessionCount) ? { sessionCount: Number(candidate.sessionCount) } : {}),
  };
}

async function readCodexEnvironmentImport(projectRoot: string): Promise<OpenScoutCodexImport | null> {
  const sourcePath = codexEnvironmentPath(projectRoot);
  let body: string;
  try {
    body = await readFile(sourcePath, "utf8");
  } catch {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(body) as Record<string, unknown>;
  } catch {
    return null;
  }

  const environment = normalizeProjectEnvironment({
    setup: parsed.setup,
    actions: parsed.actions,
  });

  return {
    sourcePath,
    importedAt: nowSeconds(),
    version: Number.isFinite(parsed.version) ? Number(parsed.version) : undefined,
    name: normalizeOptionalString(parsed.name) || undefined,
    ...(environment ? { environment } : {}),
  };
}

async function readClaudeProjectImport(projectRoot: string): Promise<OpenScoutClaudeImport | null> {
  const slug = encodeClaudeProjectsSlug(projectRoot);
  const sourcePath = join(currentHomeDirectory(), ".claude", "projects", slug);
  if (!(await isDirectory(sourcePath))) {
    return null;
  }

  const memoryPath = await pathExists(join(sourcePath, "memory", "MEMORY.md"))
    ? join(sourcePath, "memory", "MEMORY.md")
    : undefined;

  let entries: string[] = [];
  try {
    entries = await readdir(sourcePath, { withFileTypes: false });
  } catch {
    entries = [];
  }

  const recentDirectories = new Set<string>();
  const gitBranches = new Set<string>();
  let sessionCount = 0;

  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) {
      continue;
    }
    sessionCount += 1;
    const sessionPath = join(sourcePath, entry);
    let body: string;
    try {
      body = await readFile(sessionPath, "utf8");
    } catch {
      continue;
    }

    let lineCount = 0;
    for (const line of body.split("\n")) {
      if (lineCount++ >= 200) {
        break;
      }
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const cwd = normalizeOptionalString(parsed.cwd);
        if (cwd) {
          recentDirectories.add(cwd);
        }
        const gitBranch = normalizeOptionalString(parsed.gitBranch);
        if (gitBranch) {
          gitBranches.add(gitBranch);
        }
      } catch {
        continue;
      }
    }
  }

  return {
    sourcePath,
    importedAt: nowSeconds(),
    slug,
    ...(memoryPath ? { memoryPath } : {}),
    ...(recentDirectories.size > 0 ? { recentDirectories: Array.from(recentDirectories).sort() } : {}),
    ...(gitBranches.size > 0 ? { gitBranches: Array.from(gitBranches).sort() } : {}),
    ...(sessionCount > 0 ? { sessionCount } : {}),
  };
}

function applyImportedEnvironmentSeeds(
  config: OpenScoutProjectConfig,
  codexImport: OpenScoutCodexImport | null,
  projectRoot: string,
): OpenScoutProjectConfig {
  const { imports: _ignoredImports, ...configWithoutImports } = config;
  const nextImports = { ...(config.imports ?? {}) };
  if (codexImport) {
    nextImports.codex = codexImport;
  } else {
    delete nextImports.codex;
  }

  const next: OpenScoutProjectConfig = {
    ...configWithoutImports,
    ...(Object.keys(nextImports).length > 0 ? { imports: nextImports } : {}),
  };

  const importedEnvironment = codexImport?.environment;
  if (importedEnvironment) {
    next.environment = {
      ...(config.environment ?? {}),
      ...(!(config.environment?.setup) && importedEnvironment.setup ? { setup: importedEnvironment.setup } : {}),
      ...((config.environment?.actions?.length ?? 0) === 0 && importedEnvironment.actions
        ? { actions: importedEnvironment.actions }
        : {}),
    };
  }

  const defaultProjectName = titleCase(basename(projectRoot));
  if (codexImport?.name?.trim() && (!config.project.name?.trim() || config.project.name === defaultProjectName)) {
    next.project = {
      ...config.project,
      name: codexImport.name.trim(),
    };
  }

  return next;
}

async function syncProjectConfigFromLocalSources(
  projectRoot: string,
  config: OpenScoutProjectConfig,
): Promise<{ config: OpenScoutProjectConfig; changed: boolean }> {
  const [codexImport, claudeImport] = await Promise.all([
    readCodexEnvironmentImport(projectRoot),
    readClaudeProjectImport(projectRoot),
  ]);

  const seeded = applyImportedEnvironmentSeeds(config, codexImport, projectRoot);
  const { imports: _ignoredImports, ...seededWithoutImports } = seeded;
  const nextImports = { ...(seeded.imports ?? {}) };
  if (claudeImport) {
    nextImports.claude = claudeImport;
  } else {
    delete nextImports.claude;
  }
  const nextConfig: OpenScoutProjectConfig = {
    ...seededWithoutImports,
    ...(Object.keys(nextImports).length > 0 ? { imports: nextImports } : {}),
  };

  const changed = JSON.stringify(config) !== JSON.stringify(nextConfig);
  return { config: nextConfig, changed };
}

async function ensureProjectConfigIgnored(projectRoot: string): Promise<void> {
  const gitignorePath = projectGitignorePath(projectRoot);
  const ignoreRule = ".openscout/project.json";
  const comment = "# OpenScout local state";

  let current = "";
  try {
    current = await readFile(gitignorePath, "utf8");
  } catch {
    current = "";
  }

  const lines = current.split(/\r?\n/g);
  if (lines.some((line) => line.trim() === ignoreRule)) {
    return;
  }

  const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  const header = lines.some((line) => line.trim() === comment) ? "" : `${comment}\n`;
  await writeFile(gitignorePath, `${current}${separator}${header}${ignoreRule}\n`, "utf8");
}

async function readLegacyRelayConfig(): Promise<LegacyRelayConfig | null> {
  const relayHub = resolveOpenScoutSupportPaths().relayHubDirectory;
  return readJsonFile<LegacyRelayConfig>(join(relayHub, "config.json"));
}

async function readLegacyAgentRegistry(): Promise<Record<string, LegacyAgentRecord>> {
  const relayHub = resolveOpenScoutSupportPaths().relayHubDirectory;
  return (await readJsonFile<Record<string, LegacyAgentRecord>>(join(relayHub, "agents.json"))) ?? {};
}

async function readLegacyRelayAgentsRegistry(): Promise<Record<string, LegacyRelayAgentRecord>> {
  const relayHub = resolveOpenScoutSupportPaths().relayHubDirectory;
  return (await readJsonFile<Record<string, LegacyRelayAgentRecord>>(join(relayHub, "agents.json"))) ?? {};
}

async function detectHarnessMarkers(projectRoot: string): Promise<Record<ManagedAgentHarness, string[]>> {
  const detected: Record<ManagedAgentHarness, string[]> = {
    claude: [],
    codex: [],
    cursor: [],
    devin: [],
    grok: [],
    "grok-acp": [],
    kimi: [],
    pi: [],
    opencode: [],
  };

  for (const harness of MANAGED_AGENT_HARNESSES) {
    for (const marker of PROJECT_HARNESS_MARKERS[harness]) {
      if (await pathExists(join(projectRoot, marker))) {
        detected[harness].push(marker);
      }
    }
  }

  return detected;
}

export async function detectPreferredHarness(projectRoot: string, fallback: AgentHarness = "claude"): Promise<AgentHarness> {
  const markers = await detectHarnessMarkers(projectRoot);
  const hasClaude = markers.claude.length > 0;
  const hasCodex = markers.codex.length > 0;

  if (hasClaude && !hasCodex) {
    return "claude";
  }
  if (hasCodex && !hasClaude) {
    return "codex";
  }
  return fallback;
}

async function normalizeSettingsRecord(
  value: unknown,
  options: { currentDirectory?: string; legacyRelayConfig?: LegacyRelayConfig | null; legacyAgents?: Record<string, LegacyAgentRecord>; includeInferredWorkspaceRoots?: boolean } = {},
): Promise<OpenScoutSettings> {
  const base = defaultSettings();
  const candidate = typeof value === "object" && value ? value as Record<string, unknown> : {};
  const profile = typeof candidate.profile === "object" && candidate.profile ? candidate.profile as Record<string, unknown> : {};
  const onboarding = typeof candidate.onboarding === "object" && candidate.onboarding ? candidate.onboarding as Record<string, unknown> : {};
  const node = typeof candidate.node === "object" && candidate.node ? candidate.node as Record<string, unknown> : {};
  const discovery = typeof candidate.discovery === "object" && candidate.discovery ? candidate.discovery as Record<string, unknown> : {};
  const agents = typeof candidate.agents === "object" && candidate.agents ? candidate.agents as Record<string, unknown> : {};
  const bridges = typeof candidate.bridges === "object" && candidate.bridges ? candidate.bridges as Record<string, unknown> : {};
  const telegram = typeof bridges.telegram === "object" && bridges.telegram ? bridges.telegram as Record<string, unknown> : {};
  const network = typeof candidate.network === "object" && candidate.network ? candidate.network as Record<string, unknown> : {};
  const phone = typeof candidate.phone === "object" && candidate.phone ? candidate.phone as Record<string, unknown> : {};
  const voice = typeof candidate.voice === "object" && candidate.voice ? candidate.voice as Record<string, unknown> : {};
  const ui = typeof candidate.ui === "object" && candidate.ui ? candidate.ui as Record<string, unknown> : {};
  const oldOperatorName = typeof candidate.operatorName === "string" ? candidate.operatorName : undefined;

  // Project selection can request saved folders only; ordinary discovery
  // reads retain the existing cwd, legacy, and home scan-root inference.
  const seededWorkspaceRoots = options.includeInferredWorkspaceRoots === false ? [] : await seedWorkspaceRoots({
    currentDirectory: options.currentDirectory,
    legacyRelayConfig: options.legacyRelayConfig ?? null,
    legacyAgents: options.legacyAgents ?? {},
  });

  const rawWorkspaceRoots = Array.isArray(discovery.workspaceRoots)
    ? discovery.workspaceRoots.map((entry) => String(entry))
    : [];
  const workspaceRoots = uniquePaths(rawWorkspaceRoots.length > 0 ? rawWorkspaceRoots : seededWorkspaceRoots);
  const hiddenProjectRoots = uniquePaths(
    Array.isArray(discovery.hiddenProjectRoots)
      ? discovery.hiddenProjectRoots.map((entry) => String(entry))
      : [],
  );
  const contextRoot = normalizeOptionalString(discovery.contextRoot)
    ? normalizePath(String(discovery.contextRoot))
    : null;
  const seededTelegramBotToken = resolveTelegramConfigSeedValue("TELEGRAM_BOT_TOKEN", options.currentDirectory);
  const seededTelegramSecretToken = resolveTelegramConfigSeedValue("TELEGRAM_WEBHOOK_SECRET_TOKEN", options.currentDirectory);
  const seededTelegramApiBaseUrl = resolveTelegramConfigSeedValue("TELEGRAM_API_BASE_URL", options.currentDirectory);
  const seededTelegramUserName = resolveTelegramConfigSeedValue("TELEGRAM_BOT_USERNAME", options.currentDirectory);
  const telegramBotToken = normalizeOptionalString(telegram.botToken) || seededTelegramBotToken;
  const telegramSecretToken = normalizeOptionalString(telegram.secretToken) || seededTelegramSecretToken;
  const telegramApiBaseUrl = normalizeOptionalString(telegram.apiBaseUrl) || seededTelegramApiBaseUrl;
  const telegramUserName = normalizeOptionalString(telegram.userName) || seededTelegramUserName;
  const defaultHarness = normalizeHarness(
    typeof agents.defaultHarness === "string" ? agents.defaultHarness : undefined,
    base.agents.defaultHarness,
  );

  return {
    knowledgeIndexEnabled: candidate.knowledgeIndexEnabled === true,
    version: SETTINGS_VERSION,
    profile: {
      operatorName: String(profile.operatorName ?? oldOperatorName ?? base.profile.operatorName).trim() || base.profile.operatorName,
    },
    onboarding: {
      operatorAnsweredAt: normalizeOptionalTimestamp(onboarding.operatorAnsweredAt),
      sourceRootsAnsweredAt: normalizeOptionalTimestamp(onboarding.sourceRootsAnsweredAt),
      harnessChosenAt: normalizeOptionalTimestamp(onboarding.harnessChosenAt),
      inputsSavedAt: normalizeOptionalTimestamp(onboarding.inputsSavedAt),
      initRanAt: normalizeOptionalTimestamp(onboarding.initRanAt),
      doctorRanAt: normalizeOptionalTimestamp(onboarding.doctorRanAt),
      runtimesRanAt: normalizeOptionalTimestamp(onboarding.runtimesRanAt),
      completedAt: normalizeOptionalTimestamp(onboarding.completedAt),
      skippedAt: normalizeOptionalTimestamp(onboarding.skippedAt),
    },
    node: {
      alias: normalizeOptionalString(node.alias),
    },
    discovery: {
      contextRoot,
      workspaceRoots,
      includeCurrentRepo: typeof discovery.includeCurrentRepo === "boolean"
        ? discovery.includeCurrentRepo
        : base.discovery.includeCurrentRepo,
      hiddenProjectRoots,
    },
    agents: {
      defaultHarness,
      defaultTransport: normalizeTransport(
        typeof agents.defaultTransport === "string" ? agents.defaultTransport : undefined,
        defaultHarness,
        base.agents.defaultTransport,
      ),
      defaultCapabilities: normalizeCapabilities(agents.defaultCapabilities),
      sessionPrefix: normalizeSessionPrefix(typeof agents.sessionPrefix === "string" ? agents.sessionPrefix : undefined),
      coreAgents: normalizeStringList(agents.coreAgents),
    },
    bridges: {
      telegram: {
        enabled: typeof telegram.enabled === "boolean"
          ? telegram.enabled
          : Boolean(telegramBotToken),
        mode: normalizeTelegramBridgeMode(telegram.mode),
        botToken: telegramBotToken,
        secretToken: telegramSecretToken,
        apiBaseUrl: telegramApiBaseUrl,
        userName: telegramUserName,
        defaultConversationId: normalizeTelegramConversationId(telegram.defaultConversationId),
        ownerNodeId: normalizeOptionalString(telegram.ownerNodeId),
      },
    },
    network: {
      openScoutNetwork: normalizeOpenScoutNetworkSettings(network.openScoutNetwork),
    },
    phone: {
      favorites: normalizeStringList(phone.favorites),
      quickHits: normalizeStringList(phone.quickHits),
      preparedAt: normalizeOptionalTimestamp(phone.preparedAt),
    },
    voice: {
      realtimeEnabled: typeof voice.realtimeEnabled === "boolean"
        ? voice.realtimeEnabled
        : base.voice.realtimeEnabled,
      playback: voice.playback === "host" || voice.playback === "browser"
        ? voice.playback
        : base.voice.playback,
    },
    ui: normalizeUi(ui),
  };
}

function normalizeUi(value: Record<string, unknown>): OpenScoutSettings["ui"] {
  const scenesRaw = Array.isArray(value.scenes) ? value.scenes : [];
  const scenes: Scene[] = [];
  for (const raw of scenesRaw) {
    if (typeof raw !== "object" || !raw) continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : null;
    const name = typeof r.name === "string" ? r.name : null;
    const surface = r.surface === "mission-control" ? "mission-control" : null;
    const body = typeof r.body === "object" && r.body ? r.body as Record<string, unknown> : null;
    if (!id || !name || !surface || !body) continue;
    const viewport = typeof body.viewport === "object" && body.viewport ? body.viewport as Record<string, unknown> : null;
    const pan = viewport && typeof viewport.pan === "object" && viewport.pan ? viewport.pan as Record<string, unknown> : null;
    scenes.push({
      id,
      name,
      surface,
      createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now(),
      updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : Date.now(),
      body: {
        version: 1,
        viewport: viewport && pan && typeof pan.x === "number" && typeof pan.y === "number" && typeof viewport.zoom === "number"
          ? { pan: { x: pan.x, y: pan.y }, zoom: viewport.zoom }
          : null,
        zones: Array.isArray(body.zones) ? body.zones as SceneZone[] : [],
        overrides: Array.isArray(body.overrides) ? body.overrides as SceneAgentOverride[] : [],
        fallback: body.fallback === "hide" ? "hide" : "auto-pack",
      },
    });
  }
  const activeRaw = typeof value.activeSceneIdBySurface === "object" && value.activeSceneIdBySurface
    ? value.activeSceneIdBySurface as Record<string, unknown>
    : {};
  const activeSceneIdBySurface: Partial<Record<SceneSurface, string | null>> = {};
  if (typeof activeRaw["mission-control"] === "string") {
    activeSceneIdBySurface["mission-control"] = activeRaw["mission-control"] as string;
  }
  return { scenes, activeSceneIdBySurface };
}

async function seedWorkspaceRoots(options: {
  currentDirectory?: string;
  legacyRelayConfig?: LegacyRelayConfig | null;
  legacyAgents?: Record<string, LegacyAgentRecord>;
}): Promise<string[]> {
  const roots = new Set<string>();
  const currentProjectRoot = options.currentDirectory
    ? await findOnboardingProjectRoot(options.currentDirectory)
    : null;

  if (currentProjectRoot) {
    const parent = dirname(currentProjectRoot);
    roots.add(parent === normalizePath(currentHomeDirectory()) || dirname(parent) === parent ? currentProjectRoot : parent);
  }

  const legacyRoot = options.legacyRelayConfig?.projectRoot?.trim();
  if (legacyRoot) {
    roots.add(normalizePath(legacyRoot));
  }

  for (const record of Object.values(options.legacyAgents ?? {})) {
    if (record.cwd?.trim()) {
      roots.add(dirname(normalizePath(record.cwd)));
    }
  }

  if (roots.size === 0) {
    roots.add(join(currentHomeDirectory(), "dev"));
  }

  return Array.from(roots);
}

/**
 * A package/service working directory is not a user's project. In particular,
 * npm/Bun package.json files and home-level AGENTS.md/CLAUDE.md files must not
 * turn a fresh install into a scan of /Users or a workspace in node_modules.
 * This is only inference: explicitly saved roots and setup overrides keep
 * their existing authority.
 */
export async function findOnboardingProjectRoot(startDirectory: string): Promise<string | null> {
  let current = normalizePath(startDirectory);
  if (current.split(/[\\/]/u).some((part) => part === "node_modules" || part.endsWith(".app"))) {
    return null;
  }
  if (!(await stat(current).catch(() => null))?.isDirectory()) return null;
  const home = normalizePath(currentHomeDirectory());
  let nearestCandidate: string | null = null;
  while (current !== home && current !== dirname(home) && dirname(current) !== current) {
    if (await pathExists(join(current, ".git"))) return current;
    if (
      await pathExists(projectConfigPath(current))
      || await pathExists(join(current, "package.json"))
      || await pathExists(join(current, "AGENTS.md"))
      || await pathExists(join(current, "CLAUDE.md"))
    ) {
      nearestCandidate ??= current;
    }
    current = dirname(current);
  }
  return nearestCandidate;
}

export async function readOpenScoutSettings(options: { currentDirectory?: string; includeInferredWorkspaceRoots?: boolean } = {}): Promise<OpenScoutSettings> {
  const supportPaths = resolveOpenScoutSupportPaths();
  const legacyRelayConfig = await readLegacyRelayConfig();
  const legacyAgents = await readLegacyAgentRegistry();
  const rawSettings = await readJsonFile<unknown>(supportPaths.settingsPath);
  return normalizeSettingsRecord(rawSettings, {
    currentDirectory: options.currentDirectory,
    includeInferredWorkspaceRoots: options.includeInferredWorkspaceRoots,
    legacyRelayConfig,
    legacyAgents,
  });
}

export function resolveOpenScoutSetupContextRoot(options: {
  env?: RuntimeEnv;
  fallbackDirectory?: string | null;
} = {}): string {
  const env = options.env ?? process.env;
  const explicit = env.OPENSCOUT_SETUP_CWD?.trim();
  if (explicit) {
    return normalizePath(explicit);
  }

  const home = env.HOME?.trim() || homedir();
  const supportDirectory = env.OPENSCOUT_SUPPORT_DIRECTORY?.trim()
    || defaultOpenScoutSupportDirectory(home);
  const settingsPath = join(supportDirectory, "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as {
        discovery?: {
          contextRoot?: unknown;
          workspaceRoots?: unknown;
        };
      };
      const discovery = raw.discovery;
      if (typeof discovery?.contextRoot === "string" && discovery.contextRoot.trim()) {
        return normalizePath(discovery.contextRoot);
      }
      if (Array.isArray(discovery?.workspaceRoots)) {
        const workspaceRoot = discovery.workspaceRoots.find(
          (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
        );
        if (workspaceRoot) {
          return normalizePath(workspaceRoot);
        }
      }
    } catch {
      // Ignore malformed settings and fall back below.
    }
  }

  if (options.fallbackDirectory?.trim()) {
    return normalizePath(options.fallbackDirectory);
  }

  return normalizePath(process.cwd());
}

export async function writeOpenScoutSettings(settings: UpdateOpenScoutSettingsInput, options: { currentDirectory?: string } = {}): Promise<OpenScoutSettings> {
  assertTestIsolatedUserData("write OpenScout settings", "OPENSCOUT_SUPPORT_DIRECTORY");
  ensureOpenScoutCleanSlateSync();
  const settingsPath = resolveOpenScoutSupportPaths().settingsPath;
  const current = await readOpenScoutSettings(options);
  const merged = {
    ...current,
    ...settings,
    profile: {
      ...current.profile,
      ...(settings.profile ?? {}),
    },
    onboarding: {
      ...current.onboarding,
      ...(settings.onboarding ?? {}),
    },
    node: {
      ...current.node,
      ...(settings.node ?? {}),
    },
    discovery: {
      ...current.discovery,
      ...(settings.discovery ?? {}),
      hiddenProjectRoots: settings.discovery?.hiddenProjectRoots
        ? uniquePaths(settings.discovery.hiddenProjectRoots.map((entry) => String(entry)))
        : current.discovery.hiddenProjectRoots,
    },
    agents: {
      ...current.agents,
      ...(settings.agents ?? {}),
    },
    bridges: {
      ...current.bridges,
      ...(settings.bridges ?? {}),
      telegram: {
        ...current.bridges.telegram,
        ...(settings.bridges?.telegram ?? {}),
      },
    },
    network: {
      ...current.network,
      ...(settings.network ?? {}),
      openScoutNetwork: {
        ...current.network.openScoutNetwork,
        ...(settings.network?.openScoutNetwork ?? {}),
      },
    },
    phone: {
      ...current.phone,
      ...(settings.phone ?? {}),
    },
    voice: {
      ...current.voice,
      ...(settings.voice ?? {}),
    },
    ui: {
      ...current.ui,
      ...(settings.ui ?? {}),
    },
  } satisfies OpenScoutSettings;

  const normalized = await normalizeSettingsRecord(merged, {
    currentDirectory: options.currentDirectory,
  });

  // The target path is resolved from the environment, and a test teardown can
  // swap that environment while an abandoned (timed-out) call is still
  // awaiting above; re-resolving here would then retarget the operator's real
  // settings file with fixture state. Refuse to write anywhere but where this
  // call started.
  const settingsPathNow = resolveOpenScoutSupportPaths().settingsPath;
  if (settingsPathNow !== settingsPath) {
    throw new Error(
      `Refusing to write OpenScout settings: target moved from ${settingsPath} to ${settingsPathNow} mid-write (test teardown?).`,
    );
  }
  await writeJsonFile(settingsPath, normalized);
  return normalized;
}

const SCOUT_SKILL_FILE_NAME = "SKILL.md";

const SETUP_MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const SCOUT_SKILL_REPO_ROOT = resolve(SETUP_MODULE_DIRECTORY, "..", "..", "..");

// Host/harness skill roots that should receive the shared Scout skill on setup.
// Codex's canonical user-level skills path is `~/.agents/skills/` (the
// loader at codex-rs/core-skills/src/loader.rs marks `~/.codex/skills/` as
// deprecated). Claude Code still keys off `~/.claude/skills/`. OpenCode
// discovers both `~/.agents/skills/` and `~/.config/opencode/skills/`.
type ScoutSkillInstallTarget = {
  /** Ledger / report id (harness name, or host id such as "opencode"). */
  id: string;
  /** Set when this target is one of the managed harnesses. */
  harness?: ManagedAgentHarness;
  target: string;
};

function scoutSkillInstallTargets(home: string = homedir()): ScoutSkillInstallTarget[] {
  return [
    {
      id: "claude",
      harness: "claude",
      target: join(home, ".claude", "skills", "scout", SCOUT_SKILL_FILE_NAME),
    },
    {
      id: "codex",
      harness: "codex",
      target: join(home, ".agents", "skills", "scout", SCOUT_SKILL_FILE_NAME),
    },
    {
      id: "grok",
      harness: "grok",
      target: join(home, ".grok", "skills", "scout", SCOUT_SKILL_FILE_NAME),
    },
    {
      id: "pi",
      harness: "pi",
      target: join(home, ".pi", "agent", "skills", "scout", SCOUT_SKILL_FILE_NAME),
    },
    // OpenCode host skill root (also discovers ~/.agents via the codex path).
    {
      id: "opencode",
      target: join(home, ".config", "opencode", "skills", "scout", SCOUT_SKILL_FILE_NAME),
    },
  ];
}

function resolveScoutSkillSourcePath(): string | null {
  const candidates = [
    join(SCOUT_SKILL_REPO_ROOT, ".agents", "skills", "scout", SCOUT_SKILL_FILE_NAME),
    join(homedir(), ".agents", "skills", "scout", SCOUT_SKILL_FILE_NAME),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

export type ScoutSkillInstallEntry = {
  /** Host or harness id written to the managed-install ledger. */
  id: string;
  harness?: ManagedAgentHarness;
  target: string;
  status: "installed" | "skipped" | "error";
  error?: string;
};

export type ScoutSkillInstallReport = {
  source: string | null;
  entries: ScoutSkillInstallEntry[];
};

export async function installScoutSkillToHarnesses(): Promise<ScoutSkillInstallReport> {
  const source = resolveScoutSkillSourcePath();
  if (!source) {
    return { source: null, entries: [] };
  }

  const content = await readFile(source, "utf8");
  const entries: ScoutSkillInstallEntry[] = [];

  for (const installTarget of scoutSkillInstallTargets()) {
    const { id, harness, target } = installTarget;
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      await upsertManagedInstall({
        kind: "skill",
        owner: "openscout",
        name: "scout-skill",
        title: "Scout harness skill",
        status: "active",
        // Ledger still keys optional harness; OpenCode is a host skill root.
        ...(harness ? { harness } : {}),
        targetPath: target,
        sourcePath: source,
        metadata: {
          skillId: "scout",
          installTarget: id,
        },
        uninstall: {
          strategy: "delete-target",
          notes: "Remove this skill file from the host/harness skill directory.",
        },
      });
      entries.push({ id, harness, target, status: "installed" });
    } catch (error) {
      entries.push({
        id,
        harness,
        target,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { source, entries };
}

export type ClaudeStatuslineInstallReport = {
  status: "installed" | "skipped" | "error";
  /** Why a skipped install left Claude's settings alone. */
  reason?: "owned-by-other-install" | "isolated-support-directory" | "scout-cli-not-found" | "non-prod-instance";
  settingsPath: string;
  wrapperPath: string;
  delegatePath: string;
  command: string;
  previousCommand?: string;
  error?: string;
};

function resolveClaudeSettingsPath(): string {
  return join(currentHomeDirectory(), ".claude", "settings.json");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * How a wrapper Claude Code runs (the statusline, a hook) reaches the Scout
 * CLI, or null when nothing runnable is found. A bare `scout` that isn't on
 * PATH would wire Claude Code to a command that exits 127 on every call.
 */
export function resolveScoutCliInvocation(): string | null {
  const explicit = normalizeOptionalString(process.env.OPENSCOUT_SCOUT_COMMAND);
  if (explicit) return explicit;

  try {
    const found = execFileSync("sh", ["-lc", "command -v scout"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (found) return shellQuote(found);
  } catch {
    // Fall through to a dev checkout invocation when possible.
  }

  const argvEntry = normalizeOptionalString(process.argv[1]);
  if (argvEntry && basename(argvEntry).startsWith("scout")) {
    return `${shellQuote(process.execPath)} ${shellQuote(argvEntry)}`;
  }

  // A source checkout where the broker or bridge runs from the repo and no CLI
  // is installed: run the CLI's source entry with Bun.
  const sourceEntry = resolveScoutCliSourceEntry();
  const bun = sourceEntry ? resolveBunExecutable() : null;
  if (sourceEntry && bun) return `${shellQuote(bun)} ${shellQuote(sourceEntry)}`;

  return null;
}

/** packages/cli/src/main.ts beside this runtime, from either src/ or a built dist/. */
function resolveScoutCliSourceEntry(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = resolve(here, "..", "..", "cli", "src", "main.ts");
  return existsSync(entry) ? entry : null;
}

function resolveBunExecutable(): string | null {
  if (process.versions.bun && isAbsolute(process.execPath)) return process.execPath;
  try {
    const found = execFileSync("sh", ["-lc", "command -v bun"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return found || null;
  } catch {
    return null;
  }
}

export async function installClaudeStatuslineTool(): Promise<ClaudeStatuslineInstallReport> {
  const settingsPath = resolveClaudeSettingsPath();
  const wrapperPath = resolveClaudeStatuslineWrapperPath();
  const delegatePath = resolveClaudeStatuslineDelegatePath();
  const command = shellQuote(wrapperPath);

  // ~/.claude/settings.json has one statusLine per login, and it belongs to
  // the prod instance. A dev/worktree OPENSCOUT_INSTANCE never claims it
  // unless the operator points the statusline at that instance explicitly
  // (OPENSCOUT_STATUSLINE_INSTANCE=<name>).
  const instance = resolveOpenScoutInstanceName();
  if (
    !isProdOpenScoutInstance(instance)
    && normalizeOptionalString(process.env.OPENSCOUT_STATUSLINE_INSTANCE)?.toLowerCase() !== instance
  ) {
    return {
      status: "skipped",
      reason: "non-prod-instance",
      settingsPath,
      wrapperPath,
      delegatePath,
      command,
    };
  }

  // An isolated (temp) support directory must not rewire the real
  // ~/.claude/settings.json: the wrapper vanishes with the temp directory.
  if (isClaudeStatuslineWrapperIsolatedFromSettings(settingsPath, wrapperPath)) {
    return {
      status: "skipped",
      reason: "isolated-support-directory",
      settingsPath,
      wrapperPath,
      delegatePath,
      command,
    };
  }

  const scoutInvocation = resolveScoutCliInvocation();
  // Leave Claude's statusline alone rather than point it at a CLI that can't run.
  if (!scoutInvocation) {
    return {
      status: "skipped",
      reason: "scout-cli-not-found",
      settingsPath,
      wrapperPath,
      delegatePath,
      command,
    };
  }

  try {
    await mkdir(dirname(wrapperPath), { recursive: true });
    await writeFile(
      wrapperPath,
      [
        "#!/bin/sh",
        "set -eu",
        `exec ${scoutInvocation} statusline claude --delegate "$@"`,
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(wrapperPath, 0o755);

    const rawSettings = await readJsonFile<unknown>(settingsPath);
    const settings = isPlainRecord(rawSettings) ? rawSettings : {};
    const existingStatusLine = isPlainRecord(settings.statusLine) ? settings.statusLine : null;
    const previousCommand = normalizeOptionalString(existingStatusLine?.command);
    const previousIsScout = previousCommand
      ? isOpenScoutClaudeStatuslineCommand(previousCommand, wrapperPath)
      : false;

    // ~/.claude/settings.json is shared by every Scout install on this login.
    // A run with its own support directory (an install smoke test, a scratch
    // OPENSCOUT_SUPPORT_DIRECTORY) must not repoint Claude at its wrapper while
    // another install's wrapper is still live: once that run's temp directory
    // is deleted, Claude quota capture silently stops for the real install.
    const previousWrapperPath = previousCommand
      ? claudeStatuslineCommandWrapperPath(previousCommand)
      : null;
    if (previousWrapperPath && previousWrapperPath !== wrapperPath && existsSync(previousWrapperPath)) {
      return {
        status: "skipped",
        reason: "owned-by-other-install",
        settingsPath,
        wrapperPath,
        delegatePath,
        command,
        previousCommand,
      };
    }

    if (previousCommand && !previousIsScout) {
      await writeClaudeStatuslineDelegate({
        command: previousCommand,
        source: "claude-settings.statusLine",
        installedAt: Date.now(),
        ...(existingStatusLine ? { statusLine: existingStatusLine } : {}),
      });
    }

    const nextStatusLine = {
      ...(existingStatusLine ?? {}),
      type: "command",
      command,
      padding: typeof existingStatusLine?.padding === "number" ? existingStatusLine.padding : 0,
    };

    await writeJsonFile(settingsPath, {
      ...settings,
      statusLine: nextStatusLine,
    });

    await upsertManagedInstall({
      kind: "statusline",
      owner: "openscout",
      name: "claude-statusline",
      title: "Claude Code statusline quota capture",
      status: "active",
      harness: "claude",
      provider: "anthropic",
      targetPath: wrapperPath,
      version: "1",
      uninstall: {
        strategy: "manual",
        command: `Remove statusLine.command ${command} from ${settingsPath}`,
        notes: "If a previous statusline was captured, restore it from the delegate metadata.",
      },
      metadata: {
        settingsPath,
        delegatePath,
        command,
        scoutInvocation,
        ...(previousCommand && !previousIsScout ? { previousCommand } : {}),
      },
    });

    return {
      status: "installed",
      settingsPath,
      wrapperPath,
      delegatePath,
      command,
      ...(previousCommand && !previousIsScout ? { previousCommand } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await upsertManagedInstall({
        kind: "statusline",
        owner: "openscout",
        name: "claude-statusline",
        title: "Claude Code statusline quota capture",
        status: "error",
        harness: "claude",
        provider: "anthropic",
        targetPath: wrapperPath,
        version: "1",
        uninstall: {
          strategy: "manual",
          notes: "Setup could not finish installing this statusline integration.",
        },
        metadata: {
          settingsPath,
          delegatePath,
          command,
          error: message,
        },
      });
    } catch {
      // Preserve the original setup error in the returned report.
    }
    return {
      status: "error",
      settingsPath,
      wrapperPath,
      delegatePath,
      command,
      error: message,
    };
  }
}

export async function readRelayAgentOverrides(): Promise<Record<string, RelayAgentOverride>> {
  const supportPaths = resolveOpenScoutSupportPaths();
  const raw = await readJsonFile<{
    version?: number;
    agents?: Record<string, RelayAgentOverride>;
  }>(supportPaths.relayAgentsRegistryPath);

  const agents = raw?.agents ?? {};
  return Object.fromEntries(
    Object.entries(agents).map(([agentId, record]) => {
      const definitionId = normalizeAgentId(record.definitionId || record.agentId || agentId);
      const projectRoot = normalizePath(record.projectRoot);
      const concreteAgentId = buildRelayAgentInstance(definitionId, projectRoot).id;
      const defaultHarness = normalizeManagedHarness(
        typeof record.defaultHarness === "string"
          ? record.defaultHarness
          : record.runtime?.harness,
        "claude",
      );
      const harnessProfiles = buildHarnessProfiles({
        projectRoot,
        sessionKey: concreteAgentId,
        sessionPrefix: "relay",
        defaultHarness,
        profiles: record.harnessProfiles,
        runtime: record.runtime,
        launchArgs: record.launchArgs,
      });
      const resolved = resolvedRuntimeView(defaultHarness, harnessProfiles);
      return [
        concreteAgentId,
        {
          ...record,
          agentId: concreteAgentId,
          definitionId,
          projectRoot,
          projectConfigPath: record.projectConfigPath ? normalizePath(record.projectConfigPath) : null,
          source: record.source ?? "manual",
          startedAt: Number.isFinite(record.startedAt) && record.startedAt ? Math.floor(record.startedAt) : nowSeconds(),
          defaultHarness,
          harnessProfiles,
          runtime: resolved.runtime,
          launchArgs: resolved.launchArgs,
          capabilities: normalizeCapabilities(record.capabilities),
        } satisfies RelayAgentOverride,
      ];
    }),
  );
}

export async function writeRelayAgentOverrides(overrides: Record<string, RelayAgentOverride>): Promise<void> {
  assertTestIsolatedUserData("write the relay-agents registry", "OPENSCOUT_SUPPORT_DIRECTORY");
  const registryPath = resolveOpenScoutSupportPaths().relayAgentsRegistryPath;
  const normalizedAgents = Object.fromEntries(
    Object.entries(overrides).map(([agentId, record]) => {
      const definitionId = normalizeAgentId(record.definitionId || record.agentId || agentId);
      const projectRoot = normalizePath(record.projectRoot);
      const concreteAgentId = buildRelayAgentInstance(definitionId, projectRoot).id;
      const defaultHarness = normalizeManagedHarness(
        typeof record.defaultHarness === "string"
          ? record.defaultHarness
          : record.runtime?.harness,
        "claude",
      );
      const harnessProfiles = buildHarnessProfiles({
        projectRoot,
        sessionKey: concreteAgentId,
        sessionPrefix: "relay",
        defaultHarness,
        profiles: record.harnessProfiles,
        runtime: record.runtime,
        launchArgs: record.launchArgs,
      });
      const resolved = resolvedRuntimeView(defaultHarness, harnessProfiles);
      return [
        concreteAgentId,
        {
          ...record,
          agentId: concreteAgentId,
          definitionId,
          defaultHarness,
          harnessProfiles,
          projectRoot,
          projectConfigPath: record.projectConfigPath ? normalizePath(record.projectConfigPath) : null,
          source: record.source ?? "manual",
          startedAt: Number.isFinite(record.startedAt) && record.startedAt ? Math.floor(record.startedAt) : nowSeconds(),
          runtime: resolved.runtime,
          launchArgs: resolved.launchArgs,
          capabilities: normalizeCapabilities(record.capabilities),
        } satisfies RelayAgentOverride,
      ];
    }),
  );

  // Same mid-write environment-swap hazard as writeOpenScoutSettings: only
  // write where this call started.
  const registryPathNow = resolveOpenScoutSupportPaths().relayAgentsRegistryPath;
  if (registryPathNow !== registryPath) {
    throw new Error(
      `Refusing to write the relay-agents registry: target moved from ${registryPath} to ${registryPathNow} mid-write (test teardown?).`,
    );
  }
  await writeJsonFile(registryPath, {
    version: 1,
    agents: normalizedAgents,
  });
}

export async function findNearestProjectRoot(startDirectory: string): Promise<string | null> {
  let current = normalizePath(startDirectory);
  let lastCandidate: string | null = null;

  while (true) {
    if (await pathExists(join(current, ".git"))) {
      return current;
    }

    if (
      await pathExists(projectConfigPath(current))
      || await pathExists(join(current, "package.json"))
      || await pathExists(join(current, "AGENTS.md"))
      || await pathExists(join(current, "CLAUDE.md"))
    ) {
      lastCandidate = current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return lastCandidate;
    }
    current = parent;
  }
}

function defaultProjectConfig(projectRoot: string, settings: OpenScoutSettings, preferredHarness: AgentHarness): OpenScoutProjectConfig {
  const projectName = basename(projectRoot);
  const definitionId = inferredAgentId(projectName);
  const relativeRoot = relative(projectRoot, projectRoot) || ".";

  return {
    version: PROJECT_CONFIG_VERSION,
    project: {
      id: projectName,
      name: titleCase(projectName),
      root: relativeRoot,
    },
    agent: {
      id: definitionId,
      displayName: titleCase(definitionId),
      prompt: {},
      runtime: {
        defaultHarness: normalizeManagedHarness(preferredHarness, "claude"),
        profiles: {
          [normalizeManagedHarness(preferredHarness, "claude")]: {
            cwd: ".",
            transport: normalizeTransport(undefined, preferredHarness, settings.agents.defaultTransport),
            sessionId: normalizeTmuxSessionName(undefined, `${definitionId}-${normalizeManagedHarness(preferredHarness, "claude")}`, settings.agents.sessionPrefix),
            launchArgs: [],
          },
        },
      },
    },
  };
}

export async function readProjectConfig(projectRoot: string): Promise<OpenScoutProjectConfig | null> {
  const raw = await readJsonFile<OpenScoutProjectConfig>(projectConfigPath(projectRoot));
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as OpenScoutProjectConfig & {
    environment?: unknown;
    imports?: unknown;
  };
  const { environment: _ignoredEnvironment, imports: _ignoredImports, ...candidateWithoutImported } = candidate;
  const imports = typeof candidate.imports === "object" && candidate.imports
    ? candidate.imports as Record<string, unknown>
    : {};
  const environment = normalizeProjectEnvironment(candidate.environment);
  const codexImport = normalizeCodexImport(imports.codex);
  const claudeImport = normalizeClaudeImport(imports.claude);

  return {
    ...candidateWithoutImported,
    ...(environment ? { environment } : {}),
    ...(codexImport || claudeImport
      ? {
          imports: {
            ...(codexImport ? { codex: codexImport } : {}),
            ...(claudeImport ? { claude: claudeImport } : {}),
          },
        }
      : {}),
  };
}

export async function writeProjectConfig(projectRoot: string, config: OpenScoutProjectConfig): Promise<void> {
  await writeJsonFile(projectConfigPath(projectRoot), config);
  await ensureProjectConfigIgnored(projectRoot);
}

async function removeLegacyRelayLink(projectRoot: string): Promise<void> {
  await rm(legacyLocalRelayLinkPath(projectRoot), { force: true });
}

export async function ensureProjectConfigForDirectory(currentDirectory: string, settings?: OpenScoutSettings): Promise<{
  projectRoot: string | null;
  projectConfigPath: string | null;
  config: OpenScoutProjectConfig | null;
  created: boolean;
}> {
  const projectRoot = await findNearestProjectRoot(currentDirectory) ?? normalizePath(currentDirectory);

  const existing = await readProjectConfig(projectRoot);
  if (existing) {
    const synced = await syncProjectConfigFromLocalSources(projectRoot, existing);
    if (synced.changed) {
      await writeProjectConfig(projectRoot, synced.config);
    }
    await ensureProjectConfigIgnored(projectRoot);
    return {
      projectRoot,
      projectConfigPath: projectConfigPath(projectRoot),
      config: synced.changed ? synced.config : existing,
      created: false,
    };
  }

  const effectiveSettings = settings ?? await readOpenScoutSettings({ currentDirectory });
  const preferredHarness = await detectPreferredHarness(projectRoot, effectiveSettings.agents.defaultHarness);
  const synced = await syncProjectConfigFromLocalSources(
    projectRoot,
    defaultProjectConfig(projectRoot, effectiveSettings, preferredHarness),
  );
  await writeProjectConfig(projectRoot, synced.config);
  await removeLegacyRelayLink(projectRoot);

  return {
    projectRoot,
    projectConfigPath: projectConfigPath(projectRoot),
    config: synced.config,
    created: true,
  };
}

type ProjectScanCandidate = {
  projectRoot: string;
  sourceRoot: string;
};

async function detectProjectMarkers(
  projectRoot: string,
  markers: readonly string[],
): Promise<string[]> {
  const detected: string[] = [];
  for (const marker of markers) {
    if (await pathExists(join(projectRoot, marker))) {
      detected.push(marker);
    }
  }
  return detected;
}

const PROJECT_SCAN_MAX_DEPTH = 64;

async function tryCanonicalDirectory(dir: string): Promise<string | null> {
  try {
    return await realpath(dir);
  } catch {
    return null;
  }
}

/** Collapse multiple candidate paths that resolve to the same directory (symlinks, overlaps). */
async function dedupeResolvedAgentsByCanonicalProjectRoot(
  agents: ResolvedRelayAgentConfig[],
): Promise<ResolvedRelayAgentConfig[]> {
  if (agents.length <= 1) {
    return agents;
  }

  const rank = (agent: ResolvedRelayAgentConfig) =>
    (agent.registrationKind === "configured" ? 4 : 0)
    + (agent.projectConfigPath ? 2 : 0)
    + (agent.source === "manifest" ? 1 : 0);

  const pickWinner = (agent: ResolvedRelayAgentConfig, prev: ResolvedRelayAgentConfig) => {
    const ra = rank(agent);
    const rb = rank(prev);
    if (ra !== rb) {
      return ra > rb ? agent : prev;
    }
    if (agent.projectRoot.length !== prev.projectRoot.length) {
      return agent.projectRoot.length < prev.projectRoot.length ? agent : prev;
    }
    return agent.projectRoot < prev.projectRoot ? agent : prev;
  };

  const byCanon = new Map<string, ResolvedRelayAgentConfig>();
  for (const agent of agents) {
    let canon: string;
    try {
      canon = await realpath(agent.projectRoot);
    } catch {
      canon = normalizePath(agent.projectRoot);
    }
    const prev = byCanon.get(canon);
    byCanon.set(canon, prev ? pickWinner(agent, prev) : agent);
  }

  // Two project roots can resolve to the same agent FQN (same definitionId +
  // branch + node). Without a path fingerprint to disambiguate, they collide;
  // keep the higher-ranked one so downstream consumers see a single owner.
  const byAgentId = new Map<string, ResolvedRelayAgentConfig>();
  for (const agent of byCanon.values()) {
    const prev = byAgentId.get(agent.agentId);
    byAgentId.set(agent.agentId, prev ? pickWinner(agent, prev) : agent);
  }

  return Array.from(byAgentId.values());
}

async function scanSourceRoot(sourceRoot: string): Promise<ProjectScanCandidate[]> {
  const discovered = new Map<string, ProjectScanCandidate>();
  const visitedCanonical = new Set<string>();

  async function walk(currentDirectory: string, depth: number): Promise<void> {
    if (depth > PROJECT_SCAN_MAX_DEPTH) {
      return;
    }

    const canonical = await tryCanonicalDirectory(currentDirectory);
    if (!canonical) {
      return;
    }
    if (visitedCanonical.has(canonical)) {
      return;
    }
    visitedCanonical.add(canonical);

    const entries = await readdir(currentDirectory, { withFileTypes: true }).catch(() => []);
    const entryNames = new Set(entries.map((entry) => entry.name));

    const strongMarkers = [
      ...matchFlatMarkers(entryNames, PROJECT_STRONG_MARKERS_FLAT_NESTED.flat),
      ...(await matchNestedMarkers(currentDirectory, PROJECT_STRONG_MARKERS_FLAT_NESTED.nested)),
    ];
    if (strongMarkers.length > 0) {
      discovered.set(currentDirectory, {
        projectRoot: currentDirectory,
        sourceRoot,
      });
    }

    const weakMarkers = [
      ...matchFlatMarkers(entryNames, PROJECT_WEAK_MARKERS_FLAT_NESTED.flat),
      ...(await matchNestedMarkers(currentDirectory, PROJECT_WEAK_MARKERS_FLAT_NESTED.nested)),
    ];
    if (weakMarkers.length > 0) {
      discovered.set(currentDirectory, {
        projectRoot: currentDirectory,
        sourceRoot,
      });
    }

    // One project per matched directory: do not descend into children (monorepo = single row).
    if (strongMarkers.length > 0 || weakMarkers.length > 0) {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".openscout") {
        continue;
      }
      if (PROJECT_SCAN_SKIP_DIRECTORIES.has(entry.name)) {
        continue;
      }

      const nextPath = join(currentDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        if (!(await isDirectory(nextPath))) {
          continue;
        }
      } else if (!entry.isDirectory()) {
        continue;
      }

      await walk(nextPath, depth + 1);
    }
  }

  await walk(sourceRoot, 0);
  return Array.from(discovered.values());
}

async function scanWorkspaceRoots(workspaceRoots: string[]): Promise<ProjectScanCandidate[]> {
  const discovered = new Map<string, ProjectScanCandidate>();

  for (const workspaceRoot of workspaceRoots) {
    if (!(await isDirectory(workspaceRoot))) {
      continue;
    }

    const candidates = await scanSourceRoot(workspaceRoot);
    for (const candidate of candidates) {
      discovered.set(candidate.projectRoot, candidate);
    }
  }

  return Array.from(discovered.values());
}

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const candidate = normalizePath(candidatePath);
  const root = normalizePath(rootPath);
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function sourceRootForProject(projectRoot: string, workspaceRoots: string[]): string {
  const matches = workspaceRoots
    .filter((root) => isPathInsideRoot(projectRoot, root))
    .sort((lhs, rhs) => rhs.length - lhs.length);
  return matches[0] ?? projectRoot;
}

function relativeProjectPath(projectRoot: string, sourceRoot: string): string {
  return relative(sourceRoot, projectRoot) || ".";
}

function resolveProjectRootFromConfig(projectRoot: string, config: OpenScoutProjectConfig): string {
  return normalizePath(join(projectRoot, config.project.root ?? "."));
}

function mergeResolvedAgentConfig(
  base: ResolvedRelayAgentConfig,
  override: RelayAgentOverride | undefined,
  settings: OpenScoutSettings,
): ResolvedRelayAgentConfig {
  if (!override) {
    return base;
  }

  const overrideIsManual = override.source === "manual";
  const overrideDefinitionId = normalizeAgentId(override.definitionId || override.agentId);
  const overridePointsAtSameManifest = Boolean(
    base.projectConfigPath
      && override.projectConfigPath
      && normalizePath(base.projectConfigPath) === normalizePath(override.projectConfigPath),
  );
  const overrideTargetsDifferentManifestAgent = Boolean(
    overrideDefinitionId && overrideDefinitionId !== base.definitionId,
  );
  const manifestOwnsResolvedConfig = base.source === "manifest"
    && (!overrideIsManual || overridePointsAtSameManifest || overrideTargetsDifferentManifestAgent);
  const overrideLaunchArgs = normalizeLaunchArgs(override.launchArgs);
  const overrideCapabilities = normalizeCapabilities(override.capabilities);

  const definitionId = manifestOwnsResolvedConfig ? base.definitionId : (override.definitionId || base.definitionId);
  const projectRoot = manifestOwnsResolvedConfig
    ? base.projectRoot
    : (override.projectRoot ? normalizePath(override.projectRoot) : base.projectRoot);
  const instance = buildRelayAgentInstance(definitionId, projectRoot);
  const defaultHarness = normalizeManagedHarness(
    manifestOwnsResolvedConfig
      ? base.defaultHarness
      : (override.defaultHarness ?? override.runtime?.harness),
    base.defaultHarness,
  );
  const harnessProfiles = buildHarnessProfiles({
    projectRoot,
    sessionKey: instance.id,
    sessionPrefix: settings.agents.sessionPrefix,
    defaultHarness,
    profiles: {
      ...(base.harnessProfiles ?? {}),
      ...(manifestOwnsResolvedConfig ? {} : (override.harnessProfiles ?? {})),
    },
    runtime: manifestOwnsResolvedConfig ? undefined : override.runtime,
    launchArgs: manifestOwnsResolvedConfig ? base.launchArgs : overrideLaunchArgs,
  });
  const view = resolvedRuntimeView(defaultHarness, harnessProfiles);

  return {
    ...base,
    agentId: instance.id,
    definitionId,
    displayName: manifestOwnsResolvedConfig ? base.displayName : (override.displayName?.trim() || base.displayName),
    projectName: manifestOwnsResolvedConfig ? base.projectName : (override.projectName?.trim() || base.projectName),
    projectRoot,
    projectConfigPath: manifestOwnsResolvedConfig ? base.projectConfigPath : (override.projectConfigPath ?? base.projectConfigPath),
    source: manifestOwnsResolvedConfig ? base.source : (override.source ?? base.source),
    registrationKind: isConfiguredRelayAgentOverride(instance.id, override, settings)
      ? "configured"
      : base.registrationKind,
    startedAt: Number.isFinite(override.startedAt) && override.startedAt ? Math.floor(override.startedAt) : base.startedAt,
    systemPrompt: overrideIsManual
      ? (override.systemPrompt?.trim() || base.systemPrompt)
      : (base.systemPrompt || override.systemPrompt?.trim() || undefined),
    launchArgs: view.launchArgs,
    capabilities: manifestOwnsResolvedConfig
      ? (base.capabilities.length > 0 ? base.capabilities : overrideCapabilities)
      : (overrideCapabilities.length > 0 ? overrideCapabilities : base.capabilities),
    defaultHarness,
    harnessProfiles,
    instance,
    runtime: view.runtime,
  };
}

function relayAgentOverrideFromResolvedConfig(config: ResolvedRelayAgentConfig): RelayAgentOverride {
  return {
    agentId: config.agentId,
    definitionId: config.definitionId,
    displayName: config.displayName,
    projectName: config.projectName,
    projectRoot: config.projectRoot,
    projectConfigPath: config.projectConfigPath,
    source: config.source === "manifest" ? "manifest" : config.source,
    startedAt: config.startedAt,
    systemPrompt: config.systemPrompt,
    defaultHarness: config.defaultHarness,
    harnessProfiles: config.harnessProfiles,
    launchArgs: config.launchArgs,
    capabilities: config.capabilities,
    runtime: {
      cwd: config.runtime.cwd,
      harness: config.runtime.harness,
      transport: config.runtime.transport,
      sessionId: config.runtime.sessionId,
      wakePolicy: config.runtime.wakePolicy,
    },
  };
}

function projectDefaultDefinitionIds(config: ResolvedRelayAgentConfig): Set<string> {
  return new Set(
    [
      basename(config.projectRoot),
      config.projectName,
    ]
      .map((value) => normalizeAgentId(value))
      .filter(Boolean),
  );
}

function overrideMatchesSameManifest(
  override: RelayAgentOverride,
  config: ResolvedRelayAgentConfig,
): boolean {
  return Boolean(
    override.projectConfigPath
      && config.projectConfigPath
      && normalizePath(override.projectConfigPath) === normalizePath(config.projectConfigPath),
  );
}

function isSupersededManifestDefaultOverride(
  override: RelayAgentOverride,
  config: ResolvedRelayAgentConfig | undefined,
): boolean {
  if (!config || config.source !== "manifest") {
    return false;
  }
  if (!override.projectConfigPath || !overrideMatchesSameManifest(override, config)) {
    return false;
  }

  const overrideDefinitionId = normalizeAgentId(override.definitionId || override.agentId);
  if (!overrideDefinitionId || overrideDefinitionId === config.definitionId) {
    return false;
  }

  return projectDefaultDefinitionIds(config).has(overrideDefinitionId);
}

function selectorCandidateFromResolvedAgent(config: ResolvedRelayAgentConfig): AgentSelectorCandidate {
  return {
    agentId: config.agentId,
    definitionId: config.definitionId,
    nodeQualifier: config.instance.nodeQualifier,
    workspaceQualifier: config.instance.workspaceQualifier,
    aliases: [config.instance.selector, config.instance.defaultSelector],
  };
}

function selectorFromInput(value: string | AgentSelector): AgentSelector | null {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return parseAgentSelector(trimmed.startsWith("@") ? trimmed : `@${trimmed}`);
}

async function resolveManifestBackedAgent(
  projectRoot: string,
  config: OpenScoutProjectConfig,
  settings: OpenScoutSettings,
  override: RelayAgentOverride | undefined,
): Promise<ResolvedRelayAgentConfig> {
  const resolvedProjectRoot = resolveProjectRootFromConfig(projectRoot, config);
  const projectName = config.project.name?.trim() || titleCase(config.project.id || basename(resolvedProjectRoot));
  const fallbackDefinitionId = inferredAgentId(config.project.id || basename(resolvedProjectRoot));
  const explicitDefinitionId = config.agent?.id || override?.definitionId;
  const definitionId = explicitDefinitionId
    ? existingAgentId(explicitDefinitionId, projectConfigPath(projectRoot))
    : fallbackDefinitionId;
  const detectedHarness = await detectPreferredHarness(resolvedProjectRoot, settings.agents.defaultHarness);
  const runtimeDefaults = config.agent?.runtime?.defaults;
  const defaultHarness = normalizeManagedHarness(
    typeof config.agent?.runtime?.defaultHarness === "string"
      ? config.agent.runtime.defaultHarness
      : runtimeDefaults?.harness,
    normalizeManagedHarness(detectedHarness, "claude"),
  );
  const instance = buildRelayAgentInstance(definitionId, resolvedProjectRoot);
  const harnessProfiles = buildHarnessProfiles({
    projectRoot: resolvedProjectRoot,
    sessionKey: instance.id,
    sessionPrefix: settings.agents.sessionPrefix,
    defaultHarness,
    profiles: config.agent?.runtime?.profiles,
    runtime: runtimeDefaults,
    launchArgs: normalizeLaunchArgs(runtimeDefaults?.launchArgs),
    permissionProfile: normalizeScoutPermissionProfile(runtimeDefaults?.permissionProfile),
  });
  const view = resolvedRuntimeView(defaultHarness, harnessProfiles);
  const base: ResolvedRelayAgentConfig = {
    agentId: instance.id,
    definitionId,
    displayName: config.agent?.displayName?.trim() || override?.displayName?.trim() || titleCase(definitionId),
    projectName,
    projectRoot: resolvedProjectRoot,
    projectConfigPath: projectConfigPath(projectRoot),
    source: "manifest",
    registrationKind: "configured",
    startedAt: nowSeconds(),
    systemPrompt: config.agent?.prompt?.template?.trim() || undefined,
    launchArgs: view.launchArgs,
    capabilities: normalizeCapabilities(runtimeDefaults?.capabilities),
    defaultHarness,
    harnessProfiles,
    instance,
    runtime: view.runtime,
  };

  return mergeResolvedAgentConfig(base, override, settings);
}

async function resolveInferredAgent(
  projectRoot: string,
  settings: OpenScoutSettings,
  override: RelayAgentOverride | undefined,
): Promise<ResolvedRelayAgentConfig> {
  const projectName = basename(projectRoot);
  const definitionId = override?.definitionId?.trim()
    ? existingAgentId(override.definitionId, "relay agent registry")
    : inferredAgentId(projectName);
  const detectedHarness = await detectPreferredHarness(projectRoot, settings.agents.defaultHarness);
  const defaultHarness = normalizeManagedHarness(
    override?.defaultHarness ?? override?.runtime?.harness,
    normalizeManagedHarness(detectedHarness, "claude"),
  );
  const instance = buildRelayAgentInstance(definitionId, projectRoot);
  const harnessProfiles = buildHarnessProfiles({
    projectRoot,
    sessionKey: instance.id,
    sessionPrefix: settings.agents.sessionPrefix,
    defaultHarness,
    profiles: override?.harnessProfiles,
    runtime: override?.runtime,
    launchArgs: normalizeLaunchArgs(override?.launchArgs),
  });
  const view = resolvedRuntimeView(defaultHarness, harnessProfiles);
  const base: ResolvedRelayAgentConfig = {
    agentId: instance.id,
    definitionId,
    displayName: override?.displayName?.trim() || titleCase(definitionId),
    projectName: override?.projectName?.trim() || titleCase(projectName),
    projectRoot,
    projectConfigPath: null,
    source: override?.source ?? "inferred",
    registrationKind: isConfiguredRelayAgentOverride(instance.id, override, settings) ? "configured" : "discovered",
    startedAt: Number.isFinite(override?.startedAt) && override?.startedAt ? Math.floor(override.startedAt) : nowSeconds(),
    systemPrompt: override?.systemPrompt?.trim() || undefined,
    launchArgs: view.launchArgs,
    capabilities: normalizeCapabilities(override?.capabilities),
    defaultHarness,
    harnessProfiles,
    instance,
    runtime: view.runtime,
  };

  return mergeResolvedAgentConfig(base, override, settings);
}

async function buildProjectInventoryEntry(
  agent: ResolvedRelayAgentConfig,
  sourceRoot: string,
): Promise<ProjectInventoryEntry> {
  const manifestRoot = agent.projectConfigPath
    ? normalizePath(join(dirname(agent.projectConfigPath), ".."))
    : null;
  const manifest = manifestRoot ? await readProjectConfig(manifestRoot) : null;
  const markers = await detectHarnessMarkers(agent.projectRoot);
  const harnesses = new Map<ManagedAgentHarness, ProjectInventoryHarnessEvidence>();
  const runtimeProfiles = manifest?.agent?.runtime?.profiles ?? {};
  const manifestDefaultHarness = manifest?.agent?.runtime?.defaultHarness;

  for (const harness of MANAGED_AGENT_HARNESSES) {
    if (runtimeProfiles[harness]) {
      harnesses.set(harness, {
        harness,
        source: "manifest",
        detail: "Project manifest profile",
      });
    }
  }

  if (MANAGED_AGENT_HARNESSES.includes(manifestDefaultHarness as ManagedAgentHarness)) {
    const harness = manifestDefaultHarness as ManagedAgentHarness;
    harnesses.set(harness, {
      harness,
      source: "manifest",
      detail: "Project manifest default",
    });
  }

  for (const harness of MANAGED_AGENT_HARNESSES) {
    for (const marker of markers[harness]) {
      if (!harnesses.has(harness)) {
        harnesses.set(harness, {
          harness,
          source: "marker",
          detail: marker,
        });
      }
    }
  }

  if (!harnesses.has(agent.defaultHarness)) {
    harnesses.set(agent.defaultHarness, {
      harness: agent.defaultHarness,
      source: "default",
      detail: "OpenScout default",
    });
  }

  return {
    agentId: agent.agentId,
    definitionId: agent.definitionId,
    displayName: agent.displayName,
    projectName: agent.projectName,
    projectRoot: agent.projectRoot,
    sourceRoot,
    relativePath: relativeProjectPath(agent.projectRoot, sourceRoot),
    source: agent.source,
    registrationKind: agent.registrationKind,
    projectConfigPath: agent.projectConfigPath,
    defaultHarness: agent.defaultHarness,
    harnesses: Array.from(harnesses.values()),
  };
}

async function importLegacyState(currentDirectory?: string): Promise<{
  settings: OpenScoutSettings;
  overrides: Record<string, RelayAgentOverride>;
}> {
  const settings = await readOpenScoutSettings({ currentDirectory });
  const overrides = await readRelayAgentOverrides();
  return {
    settings,
    overrides,
  };
}

async function syncRelayAgentMirror(agents: ResolvedRelayAgentConfig[]): Promise<void> {
  void agents;
}

function buildOverrideIndexByProjectRoot(overrides: Record<string, RelayAgentOverride>): Map<string, RelayAgentOverride> {
  return new Map(
    Object.values(overrides).map((record) => [normalizePath(record.projectRoot), record]),
  );
}

export async function loadResolvedRelayAgents(options: {
  currentDirectory?: string;
  ensureCurrentProjectConfig?: boolean;
  syncLegacyMirror?: boolean;
  /** Plain-text doctor / UI: invoked after each project row is built (sorted by relative path). */
  onProjectInventoryEntry?: (entry: ProjectInventoryEntry) => void | Promise<void>;
  /** Invalid historical project identities quarantined from the fleet inventory. */
  onProjectInventoryError?: (error: ProjectInventoryError) => void | Promise<void>;
  /** Home used for ~/.claude/projects, Cursor workspaceStorage, ~/.codex hints. Defaults to os.homedir(). */
  userLevelHintsHome?: string;
} = {}): Promise<SetupResult> {
  ensureOpenScoutCleanSlateSync();
  const supportPaths = resolveOpenScoutSupportPaths();
  if (options.currentDirectory) {
    const projectRoot = await findNearestProjectRoot(options.currentDirectory);
    if (projectRoot) {
      await removeLegacyRelayLink(projectRoot);
    }
  }
  await mkdir(supportPaths.supportDirectory, { recursive: true });
  await mkdir(supportPaths.logsDirectory, { recursive: true });
  await mkdir(supportPaths.appLogsDirectory, { recursive: true });
  await mkdir(supportPaths.brokerLogsDirectory, { recursive: true });
  await mkdir(supportPaths.catalogDirectory, { recursive: true });
  await mkdir(supportPaths.relayAgentsDirectory, { recursive: true });
  await mkdir(supportPaths.controlHome, { recursive: true });
  await ensureHarnessCatalogOverrideFile(supportPaths.harnessCatalogPath);

  const { settings, overrides } = await importLegacyState(options.currentDirectory);
  let currentProjectConfig: {
    projectRoot: string | null;
    projectConfigPath: string | null;
    config?: OpenScoutProjectConfig | null;
    created: boolean;
  } = {
    projectRoot: null,
    projectConfigPath: null,
    created: false,
  };

  if (options.currentDirectory && options.ensureCurrentProjectConfig) {
    currentProjectConfig = await ensureProjectConfigForDirectory(options.currentDirectory, settings);
  } else if (options.currentDirectory) {
    const currentProjectRoot = await findNearestProjectRoot(options.currentDirectory);
    if (currentProjectRoot) {
      currentProjectConfig = {
        projectRoot: currentProjectRoot,
        projectConfigPath: (await pathExists(projectConfigPath(currentProjectRoot))) ? projectConfigPath(currentProjectRoot) : null,
        created: false,
      };
    }
  }

  const hiddenProjectRoots = new Set(settings.discovery.hiddenProjectRoots.map((entry) => normalizePath(entry)));
  const workspaceCandidates = await scanWorkspaceRoots(settings.discovery.workspaceRoots);
  const projectCandidates = new Set<string>(workspaceCandidates.map((candidate) => candidate.projectRoot));
  const sourceRootByProject = new Map<string, string>(
    workspaceCandidates.map((candidate) => [candidate.projectRoot, candidate.sourceRoot]),
  );

  if (process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS !== "1") {
    try {
      const hintHome = options.userLevelHintsHome ?? homedir();
      const userHints = await collectUserLevelProjectRootHints({ home: hintHome });
      for (const hint of userHints) {
        const normalized = normalizePath(hint);
        if (hiddenProjectRoots.has(normalized)) {
          continue;
        }
        if (projectCandidates.has(normalized)) {
          continue;
        }
        projectCandidates.add(normalized);
        sourceRootByProject.set(
          normalized,
          sourceRootForProject(normalized, settings.discovery.workspaceRoots),
        );
      }
    } catch {
      /* best-effort: ignore hint collection failures */
    }
  }

  const overrideByRoot = buildOverrideIndexByProjectRoot(overrides);

  if (settings.discovery.includeCurrentRepo && currentProjectConfig.projectRoot) {
    const normalizedCurrentProjectRoot = normalizePath(currentProjectConfig.projectRoot);
    if (!hiddenProjectRoots.has(normalizedCurrentProjectRoot)) {
      projectCandidates.add(normalizedCurrentProjectRoot);
      sourceRootByProject.set(
        normalizedCurrentProjectRoot,
        sourceRootForProject(normalizedCurrentProjectRoot, settings.discovery.workspaceRoots),
      );
    }
  }

  for (const override of Object.values(overrides)) {
    const normalizedRoot = normalizePath(override.projectRoot);
    if (hiddenProjectRoots.has(normalizedRoot)) {
      continue;
    }
    projectCandidates.add(normalizedRoot);
    sourceRootByProject.set(
      normalizedRoot,
      sourceRootForProject(normalizedRoot, settings.discovery.workspaceRoots),
    );
  }

  const resolvedAgents: ResolvedRelayAgentConfig[] = [];
  const projectErrors: ProjectInventoryError[] = [];
  const currentProjectRoot = currentProjectConfig.projectRoot
    ? normalizePath(currentProjectConfig.projectRoot)
    : null;
  for (const projectRoot of Array.from(projectCandidates).sort()) {
    if (hiddenProjectRoots.has(normalizePath(projectRoot))) {
      continue;
    }
    const manifest = await readProjectConfig(projectRoot);
    const override = overrideByRoot.get(projectRoot);
    let resolvedAgent: ResolvedRelayAgentConfig;
    try {
      resolvedAgent = manifest
        ? await resolveManifestBackedAgent(projectRoot, manifest, settings, override)
        : await resolveInferredAgent(projectRoot, settings, override);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith("reserved_name_existing:")) {
        throw error;
      }
      if (currentProjectRoot === normalizePath(projectRoot)) {
        throw error;
      }
      const sourceRoot = sourceRootByProject.get(projectRoot)
        ?? sourceRootForProject(projectRoot, settings.discovery.workspaceRoots);
      const projectError: ProjectInventoryError = {
        code: "reserved_name_existing",
        projectRoot,
        sourceRoot,
        relativePath: relativeProjectPath(projectRoot, sourceRoot),
        message,
      };
      projectErrors.push(projectError);
      await options.onProjectInventoryError?.(projectError);
      continue;
    }

    if (!resolvedAgent.agentId || BUILT_IN_AGENT_DEFINITION_IDS.has(resolvedAgent.definitionId)) {
      continue;
    }

    resolvedAgents.push(resolvedAgent);
  }

  const dedupedResolvedAgents = await dedupeResolvedAgentsByCanonicalProjectRoot(resolvedAgents);

  const configuredAgents = dedupedResolvedAgents.filter((agent) => agent.registrationKind === "configured");
  const configuredAgentIds = new Set(configuredAgents.map((agent) => agent.agentId));
  const configuredByProjectRoot = new Map(
    configuredAgents.map((agent) => [normalizePath(agent.projectRoot), agent]),
  );
  const builtInOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([, record]) => record.definitionId ? BUILT_IN_AGENT_DEFINITION_IDS.has(record.definitionId) : false),
  );
  const preservedManualOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([agentId, record]) => {
      if (record.source !== "manual") {
        return false;
      }
      const definitionId = normalizeAgentId(record.definitionId || agentId);
      if (!definitionId || BUILT_IN_AGENT_DEFINITION_IDS.has(definitionId)) {
        return false;
      }
      if (configuredAgentIds.has(agentId)) {
        return false;
      }
      const configured = configuredByProjectRoot.get(normalizePath(record.projectRoot));
      return !isSupersededManifestDefaultOverride(record, configured);
    }),
  );
  const nextOverrides = {
    ...builtInOverrides,
    ...preservedManualOverrides,
    ...Object.fromEntries(
      configuredAgents.map((agent) => [
        agent.agentId,
        relayAgentOverrideFromResolvedConfig(agent),
      ]),
    ),
  };

  await writeRelayAgentOverrides(nextOverrides);

  if (options.syncLegacyMirror) {
    await syncRelayAgentMirror(configuredAgents);
  }

  const sortedForInventory = dedupedResolvedAgents.slice().sort((lhs, rhs) => {
    const sourceRootL = sourceRootByProject.get(lhs.projectRoot)
      ?? sourceRootForProject(lhs.projectRoot, settings.discovery.workspaceRoots);
    const sourceRootR = sourceRootByProject.get(rhs.projectRoot)
      ?? sourceRootForProject(rhs.projectRoot, settings.discovery.workspaceRoots);
    const pathCmp = relativeProjectPath(lhs.projectRoot, sourceRootL).localeCompare(
      relativeProjectPath(rhs.projectRoot, sourceRootR),
    );
    if (pathCmp !== 0) {
      return pathCmp;
    }
    return lhs.displayName.localeCompare(rhs.displayName);
  });

  const projectInventory: ProjectInventoryEntry[] = [];
  for (const agent of sortedForInventory) {
    const sourceRoot = sourceRootByProject.get(agent.projectRoot)
      ?? sourceRootForProject(agent.projectRoot, settings.discovery.workspaceRoots);
    const row = await buildProjectInventoryEntry(agent, sourceRoot);
    projectInventory.push(row);
    await options.onProjectInventoryEntry?.(row);
  }

  return {
    supportDirectory: supportPaths.supportDirectory,
    settingsPath: supportPaths.settingsPath,
    harnessCatalogPath: supportPaths.harnessCatalogPath,
    relayAgentsPath: supportPaths.relayAgentsRegistryPath,
    managedInstallsPath: supportPaths.managedInstallsPath,
    relayHubPath: supportPaths.relayHubDirectory,
    currentProjectConfigPath: currentProjectConfig.projectConfigPath,
    createdProjectConfig: currentProjectConfig.created,
    settings,
    agents: configuredAgents.sort((lhs, rhs) => lhs.displayName.localeCompare(rhs.displayName)),
    discoveredAgents: dedupedResolvedAgents.sort((lhs, rhs) => lhs.displayName.localeCompare(rhs.displayName)),
    projectInventory,
    projectErrors,
  };
}

export async function resolveRelayAgentConfig(
  value: string | AgentSelector,
  options: {
    currentDirectory?: string;
    ensureCurrentProjectConfig?: boolean;
  } = {},
): Promise<ResolvedRelayAgentConfig | null> {
  const setup = await loadResolvedRelayAgents({
    currentDirectory: options.currentDirectory,
    ensureCurrentProjectConfig: options.ensureCurrentProjectConfig,
  });

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      const exact = setup.discoveredAgents.find((agent) => agent.agentId === trimmed);
      if (exact) {
        return exact;
      }
    }
  }

  const selector = selectorFromInput(value);
  if (!selector) {
    return null;
  }

  const match = resolveAgentSelector(
    selector,
    setup.discoveredAgents.map(selectorCandidateFromResolvedAgent),
  );
  if (!match) {
    return null;
  }

  return setup.discoveredAgents.find((agent) => agent.agentId === match.agentId) ?? null;
}

export async function ensureRelayAgentConfigured(
  value: string | AgentSelector,
  options: {
    currentDirectory?: string;
    ensureCurrentProjectConfig?: boolean;
    syncLegacyMirror?: boolean;
  } = {},
): Promise<ResolvedRelayAgentConfig | null> {
  const candidate = await resolveRelayAgentConfig(value, {
    currentDirectory: options.currentDirectory,
    ensureCurrentProjectConfig: options.ensureCurrentProjectConfig,
  });
  if (!candidate) {
    return null;
  }

  if (candidate.registrationKind === "configured") {
    return candidate;
  }

  const overrides = await readRelayAgentOverrides();
  overrides[candidate.agentId] = relayAgentOverrideFromResolvedConfig(candidate);
  await writeRelayAgentOverrides(overrides);

  await loadResolvedRelayAgents({
    currentDirectory: options.currentDirectory,
    syncLegacyMirror: options.syncLegacyMirror ?? true,
  });

  return {
    ...candidate,
    registrationKind: "configured",
  };
}

export async function ensureScoutRelayAgentConfigured(options: {
  currentDirectory?: string;
  projectRoot?: string;
} = {}): Promise<RelayAgentOverride> {
  const settings = await readOpenScoutSettings({ currentDirectory: options.currentDirectory });
  const overrides = await readRelayAgentOverrides();
  const resolvedProjectRoot = options.projectRoot
    ? normalizePath(options.projectRoot)
    : options.currentDirectory
      ? (await findNearestProjectRoot(options.currentDirectory)) ?? normalizePath(options.currentDirectory)
      : normalizePath(process.cwd());
  const qualifiedAgentId = buildRelayAgentInstance(SCOUT_AGENT_ID, resolvedProjectRoot).id;
  const existing = overrides[qualifiedAgentId] ?? overrides[SCOUT_AGENT_ID];

  const nextOverride: RelayAgentOverride = {
    ...existing,
    agentId: qualifiedAgentId,
    definitionId: SCOUT_AGENT_ID,
    displayName: "Scout",
    projectName: "OpenScout",
    projectRoot: resolvedProjectRoot,
    projectConfigPath: existing?.projectConfigPath ? normalizePath(existing.projectConfigPath) : null,
    source: "manual",
    startedAt: existing?.startedAt ?? nowSeconds(),
    systemPrompt: existing?.systemPrompt?.trim() || undefined,
    capabilities: normalizeCapabilities(existing?.capabilities),
    defaultHarness: "claude",
    harnessProfiles: buildHarnessProfiles({
      projectRoot: resolvedProjectRoot,
      sessionKey: qualifiedAgentId,
      sessionPrefix: settings.agents.sessionPrefix,
      defaultHarness: "claude",
      profiles: existing?.harnessProfiles,
      runtime: existing?.runtime,
      launchArgs: normalizeLaunchArgs(existing?.launchArgs),
    }),
    runtime: {
      cwd: resolvedProjectRoot,
      harness: "claude",
      transport: "tmux",
      sessionId: normalizeTmuxSessionName(existing?.runtime?.sessionId, `${SCOUT_AGENT_ID}-claude`, settings.agents.sessionPrefix),
      wakePolicy: "on_demand",
    },
  };
  nextOverride.launchArgs = nextOverride.harnessProfiles?.claude?.launchArgs ?? [];

  if (overrides[SCOUT_AGENT_ID]) {
    delete overrides[SCOUT_AGENT_ID];
  }
  if (JSON.stringify(overrides[qualifiedAgentId]) !== JSON.stringify(nextOverride)) {
    overrides[qualifiedAgentId] = nextOverride;
    await writeRelayAgentOverrides(overrides);
  }

  return nextOverride;
}

export async function initializeOpenScoutSetup(options: { currentDirectory?: string } = {}): Promise<SetupResult> {
  return loadResolvedRelayAgents({
    currentDirectory: options.currentDirectory,
    ensureCurrentProjectConfig: true,
    syncLegacyMirror: true,
  });
}
