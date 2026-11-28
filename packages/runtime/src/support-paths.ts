import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { deriveOpenScoutInstanceLayout, isProdOpenScoutInstance, resolveOpenScoutInstanceName } from "./instance.js";
import { resolveOpenScoutToolDir, scoutHomeReadPath } from "./scout-home.js";

export type OpenScoutSupportPaths = {
  supportDirectory: string;
  logsDirectory: string;
  appLogsDirectory: string;
  brokerLogsDirectory: string;
  runtimeDirectory: string;
  catalogDirectory: string;
  relayAgentsDirectory: string;
  settingsPath: string;
  harnessCatalogPath: string;
  relayAgentsRegistryPath: string;
  managedInstallsPath: string;
  hostInfoPath: string;
  relayHubDirectory: string;
  controlHome: string;
  knowledgeDirectory: string;
  knowledgeQmdDirectory: string;
  knowledgeSqlitePath: string;
  desktopStatusPath: string;
  workspaceStatePath: string;
  cutoverMarkerPath: string;
};

const OPENSCOUT_RPC_CUTOVER_MARKER = "rpc-runtime-cutover-v1";

/**
 * True when this process is a test run. NODE_ENV=test is the primary signal,
 * but bun test does not override a preset NODE_ENV (a dev shell exporting
 * NODE_ENV=development silently disarmed the old check), so also recognize
 * the runner by its entrypoint: under bun test the main module is always a
 * test file.
 */
export function isTestRunnerProcess(): boolean {
  if (process.env.NODE_ENV === "test") return true;
  const entry = typeof Bun !== "undefined" ? Bun.main : process.argv[1] ?? "";
  return /[._](test|spec)\.[cm]?[jt]sx?$/.test(entry);
}

function envPathFrom(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function hasEffectiveTestIsolation(isolationEnvKey: string, env: Record<string, string | undefined> = process.env): boolean {
  if (envPathFrom(env, isolationEnvKey)) return true;
  if (!isProdOpenScoutInstance(resolveOpenScoutInstanceName(env))) return true;
  if (isolationEnvKey === "OPENSCOUT_SUPPORT_DIRECTORY") {
    return Boolean(
      envPathFrom(env, "OPENSCOUT_STATE_DIR")
      || envPathFrom(env, "OPENSCOUT_HOME")
      || envPathFrom(env, "SCOUT_HOME"),
    );
  }
  if (isolationEnvKey === "OPENSCOUT_HOME") {
    return Boolean(
      envPathFrom(env, "SCOUT_HOME")
      || envPathFrom(env, "OPENSCOUT_SCOUT_HOME"),
    );
  }
  return false;
}

/**
 * Tests must never touch real user data. Every writer of OpenScout user state
 * calls this first: under a test runner the write is refused unless an
 * isolation env var (or non-prod OPENSCOUT_INSTANCE) redirects it to a temp
 * directory. This exists because an unisolated test once persisted its fake
 * temp-home workspaceRoots into the operator's real settings.json.
 */
export function assertTestIsolatedUserData(operation: string, isolationEnvKey: string): void {
  if (!isTestRunnerProcess()) return;
  if (hasEffectiveTestIsolation(isolationEnvKey)) return;
  throw new Error(
    `Refusing to ${operation} under a test runner without ${isolationEnvKey} set. `
      + "Tests must isolate OpenScout user data in a temp directory (see prepareHome in onboarding.test.ts).",
  );
}

/**
 * Durable support directory when OPENSCOUT_SUPPORT_DIRECTORY is unset, for
 * the current OPENSCOUT_INSTANCE. Prod on Darwin stays
 * ~/Library/Application Support/OpenScout; prod elsewhere uses
 * ${XDG_DATA_HOME:-~/.local/share}/openscout. A non-prod instance uses
 * ~/.openscout/instances/<name>/support on every platform.
 */
export function defaultOpenScoutSupportDirectory(home = homedir()): string {
  return deriveOpenScoutInstanceLayout({ home }).supportDirectory;
}

/** Control-plane home when OPENSCOUT_CONTROL_HOME is unset, for the current instance. */
export function defaultOpenScoutControlHome(home = homedir()): string {
  return deriveOpenScoutInstanceLayout({ home }).controlHome;
}

function envPath(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

/**
 * OPENSCOUT_HOME (config.json, user.json, skills/, artifacts/, reports/, .<tool>/):
 * ~/.openscout for prod, the instance root otherwise.
 * Accepts deprecated aliases SCOUT_HOME and OPENSCOUT_SCOUT_HOME.
 */
export function resolveOpenScoutHome(): string {
  return envPath("OPENSCOUT_HOME")
    ?? envPath("SCOUT_HOME")
    ?? envPath("OPENSCOUT_SCOUT_HOME")
    ?? deriveOpenScoutInstanceLayout().openscoutHome;
}

/**
 * OPENSCOUT_STATE_DIR (alias OPENSCOUT_SUPPORT_DIRECTORY): Scout-owned state.
 * When OPENSCOUT_HOME (or SCOUT_HOME) is explicitly set on prod without a
 * separate support override, state resolves to <home>/state; otherwise it keeps
 * the instance layout default until `scout home migrate` runs.
 */
export function resolveOpenScoutStateDirectory(env: Record<string, string | undefined> = process.env): string {
  const explicitState = envPathFrom(env, "OPENSCOUT_STATE_DIR")
    ?? envPathFrom(env, "OPENSCOUT_SUPPORT_DIRECTORY");
  if (explicitState) return explicitState;
  const layout = deriveOpenScoutInstanceLayout({ env, home: env.HOME?.trim() || homedir() });
  if (layout.isProd) {
    const explicitHome = envPathFrom(env, "OPENSCOUT_HOME") ?? envPathFrom(env, "SCOUT_HOME");
    if (explicitHome) return join(explicitHome, "state");
  }
  return layout.supportDirectory;
}

/** Rebuildable cache directory: OPENSCOUT_CACHE_DIR, default <home>/cache. */
export function resolveOpenScoutCacheDirectory(env: Record<string, string | undefined> = process.env): string {
  return envPathFrom(env, "OPENSCOUT_CACHE_DIR") ?? join(resolveOpenScoutHomeForEnv(env), "cache");
}

/** Sibling tool dot-folder under the resolved home (<home>/.<tool>). */
export function resolveOpenScoutToolDirectory(tool: string, env: Record<string, string | undefined> = process.env): string {
  const home = resolveOpenScoutHomeForEnv(env);
  return resolveOpenScoutToolDir(tool, { env: { ...env, OPENSCOUT_HOME: home } });
}

/**
 * Dual-location read resolver for operator config files (config.json, user.json, etc.):
 * checks <home>/<name> first, falling back to legacy ~/.scout/<name> only when
 * no explicit home override is set on prod.
 */
export function resolveOpenScoutConfigReadPath(
  filename: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const home = env.HOME?.trim() || homedir();
  const layout = deriveOpenScoutInstanceLayout({ env, home });
  if (!layout.isProd) {
    return join(layout.openscoutHome, filename);
  }
  return scoutHomeReadPath(filename, { home, env });
}

/**
 * OPENSCOUT_SCOUT_HOME: legacy `~/.scout` class of state (local edge, CLI logs,
 * CLI mtime cache). ~/.scout for prod, the instance root otherwise.
 */
export function resolveOpenScoutScoutHome(): string {
  return envPath("OPENSCOUT_SCOUT_HOME") ?? deriveOpenScoutInstanceLayout().scoutHome;
}

/**
 * Pairing bridge state (Noise static key, trusted peers, runtime.json, logs,
 * attachments). OPENSCOUT_PAIRING_HOME wins, then the legacy SCOUT_PAIRING_HOME
 * and OPENSCOUT_PAIRING_DIR spellings, then <OPENSCOUT_STATE_DIR>/pairing, then
 * <scout home>/pairing for an explicit OPENSCOUT_SCOUT_HOME, then migrated
 * ~/.openscout/state/pairing if present, then the instance default (~/.scout/pairing
 * for prod).
 */
export function resolveOpenScoutPairingHome(): string {
  return resolveOpenScoutPairingHomeForEnv(process.env);
}

/** resolveOpenScoutHome for an explicit env (HOME honoured from that env). */
export function resolveOpenScoutHomeForEnv(env: Record<string, string | undefined>): string {
  const explicit = envPathFrom(env, "OPENSCOUT_HOME")
    ?? envPathFrom(env, "SCOUT_HOME")
    ?? envPathFrom(env, "OPENSCOUT_SCOUT_HOME");
  if (explicit) return explicit;
  return deriveOpenScoutInstanceLayout({ env, home: env.HOME?.trim() || homedir() }).openscoutHome;
}

/** resolveOpenScoutPairingHome for an explicit env (HOME honoured from that env). */
export function resolveOpenScoutPairingHomeForEnv(env: Record<string, string | undefined>): string {
  const explicit = envPathFrom(env, "OPENSCOUT_PAIRING_HOME")
    ?? envPathFrom(env, "SCOUT_PAIRING_HOME")
    ?? envPathFrom(env, "OPENSCOUT_PAIRING_DIR");
  if (explicit) return explicit;
  const explicitState = envPathFrom(env, "OPENSCOUT_STATE_DIR");
  if (explicitState) return join(explicitState, "pairing");
  const scoutHome = envPathFrom(env, "OPENSCOUT_SCOUT_HOME");
  if (scoutHome) return join(scoutHome, "pairing");
  const layout = deriveOpenScoutInstanceLayout({ env, home: env.HOME?.trim() || homedir() });
  if (layout.isProd) {
    const explicitHome = envPathFrom(env, "OPENSCOUT_HOME") ?? envPathFrom(env, "SCOUT_HOME");
    const migratedPairing = join(explicitHome ?? layout.openscoutHome, "state", "pairing");
    if (existsSync(migratedPairing)) return migratedPairing;
  }
  return layout.pairingHome;
}

/** Local edge (Caddy) state: <scout home>/local-edge (prefers migrated ~/.openscout/state/local-edge if present). */
export function resolveOpenScoutLocalEdgeDirectory(): string {
  if (!envPath("OPENSCOUT_SCOUT_HOME") && isProdOpenScoutInstance(resolveOpenScoutInstanceName())) {
    const migrated = join(resolveOpenScoutStateDirectory(), "local-edge");
    if (existsSync(migrated)) return migrated;
  }
  return join(resolveOpenScoutScoutHome(), "local-edge");
}

export function resolveOpenScoutSupportPaths(): OpenScoutSupportPaths {
  const layout = deriveOpenScoutInstanceLayout();
  const supportDirectory = resolveOpenScoutStateDirectory();
  const logsDirectory = join(supportDirectory, "logs");
  const runtimeDirectory = join(supportDirectory, "runtime");
  const catalogDirectory = join(supportDirectory, "catalog");
  const explicitControlHome = envPath("OPENSCOUT_CONTROL_HOME");
  const controlHome = explicitControlHome
    ?? (layout.isProd && (envPath("OPENSCOUT_STATE_DIR") || envPath("OPENSCOUT_HOME") || envPath("SCOUT_HOME"))
      ? join(supportDirectory, "control-plane")
      : layout.controlHome);
  const knowledgeDirectory = join(controlHome, "knowledge");

  return {
    supportDirectory,
    logsDirectory,
    appLogsDirectory: join(logsDirectory, "app"),
    brokerLogsDirectory: join(logsDirectory, "broker"),
    runtimeDirectory,
    catalogDirectory,
    relayAgentsDirectory: join(runtimeDirectory, "agents"),
    settingsPath: join(supportDirectory, "settings.json"),
    harnessCatalogPath: join(catalogDirectory, "harness-catalog.json"),
    relayAgentsRegistryPath: join(supportDirectory, "relay-agents.json"),
    managedInstallsPath: join(supportDirectory, "managed-installs.json"),
    hostInfoPath: join(supportDirectory, ".host-info"),
    relayHubDirectory: envPath("OPENSCOUT_RELAY_HUB") ?? layout.relayHub,
    controlHome,
    knowledgeDirectory,
    knowledgeQmdDirectory: join(knowledgeDirectory, "qmd"),
    knowledgeSqlitePath: join(knowledgeDirectory, "knowledge.sqlite"),
    desktopStatusPath: join(supportDirectory, "agent-status.json"),
    workspaceStatePath: join(supportDirectory, "workspace-state.json"),
    cutoverMarkerPath: join(supportDirectory, OPENSCOUT_RPC_CUTOVER_MARKER),
  };
}

/**
 * Base directory for control-plane archive output (gzip JSONL exports written
 * before pruning). Sits next to the control-plane home so an overridden
 * OPENSCOUT_CONTROL_HOME keeps archives on the same volume.
 */
export function controlPlaneArchiveDirectory(): string {
  const { controlHome } = resolveOpenScoutSupportPaths();
  return join(dirname(controlHome), "work-archives", "control-plane");
}

export function localAgentRuntimeDirectory(agentId: string): string {
  return join(resolveOpenScoutSupportPaths().relayAgentsDirectory, agentId);
}

export function localAgentLogsDirectory(agentId: string): string {
  return join(localAgentRuntimeDirectory(agentId), "logs");
}

export function relayAgentRuntimeDirectory(agentId: string): string {
  return localAgentRuntimeDirectory(agentId);
}

export function relayAgentLogsDirectory(agentId: string): string {
  return localAgentLogsDirectory(agentId);
}

export function ensureOpenScoutCleanSlateSync(): void {
  assertTestIsolatedUserData("initialize the OpenScout support directory", "OPENSCOUT_SUPPORT_DIRECTORY");
  const paths = resolveOpenScoutSupportPaths();
  if (existsSync(paths.cutoverMarkerPath)) {
    return;
  }

  // Keep the compatibility marker without discarding durable state or files
  // already opened by the supervisor before the broker's first startup.
  mkdirSync(paths.supportDirectory, { recursive: true });
  writeFileSync(paths.cutoverMarkerPath, `${Date.now()}\n`, "utf8");
}
