import { homedir } from "node:os";
import { join } from "node:path";

// agent-sessions cannot depend on @openscout/runtime, so it follows the env
// that runtime entrypoints materialize for the current OPENSCOUT_INSTANCE
// (see packages/runtime/src/instance.ts). Unset env keeps the prod layout.

/** The `~/.scout` class of state for this instance (OPENSCOUT_SCOUT_HOME). */
export function scoutStateHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENSCOUT_SCOUT_HOME?.trim() || join(homedir(), ".scout");
}

/** Pairing bridge state for this instance (OPENSCOUT_PAIRING_HOME). */
export function scoutPairingHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENSCOUT_PAIRING_HOME?.trim()
    || env.SCOUT_PAIRING_HOME?.trim()
    || env.OPENSCOUT_PAIRING_DIR?.trim()
    || join(scoutStateHome(env), "pairing");
}

/**
 * Root of one adapter's pairing session files for this instance. An explicit
 * pairing home (set per OPENSCOUT_INSTANCE) wins; otherwise `<home>/.scout/pairing`.
 */
export function scoutPairingAdapterRoot(
  home: string,
  adapter: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.OPENSCOUT_PAIRING_HOME?.trim()
    || env.SCOUT_PAIRING_HOME?.trim()
    || env.OPENSCOUT_PAIRING_DIR?.trim()
    || (env.OPENSCOUT_SCOUT_HOME?.trim() ? join(env.OPENSCOUT_SCOUT_HOME.trim(), "pairing") : "");
  return join(explicit || join(home, ".scout", "pairing"), adapter);
}

/** True for a file under `<prefix>` in prod's pairing tree or this instance's. */
export function isScoutPairingPath(path: string, prefix: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (path.includes(`/.scout/pairing/${prefix}`)) return true;
  const instanceRoot = scoutPairingAdapterRoot(homedir(), prefix, env);
  return path.startsWith(instanceRoot);
}

/**
 * Instance-derived env a Scout service holds; a harness session a service
 * launches must not inherit it (mirrors OPENSCOUT_USER_SPAWN_STRIPPED_ENV_KEYS
 * in @openscout/runtime/config; a runtime test keeps the two in sync).
 */
export const SCOUT_USER_SPAWN_STRIPPED_ENV_KEYS: readonly string[] = [
  "OPENSCOUT_INSTANCE",
  "OPENSCOUT_INSTANCE_EXPLICIT",
  "OPENSCOUT_INSTANCE_ROOT",
  "OPENSCOUT_INSTANCE_PORT_BASE",
  "OPENSCOUT_INSTANCE_MESH",
  "OPENSCOUT_INSTANCE_HOST_LABEL",
  "OPENSCOUT_HOME",
  "OPENSCOUT_CONTROL_HOME",
  "OPENSCOUT_ATTRIBUTION_KEY_FILE",
  "OPENSCOUT_SUPPORT_DIRECTORY",
  "OPENSCOUT_RELAY_HUB",
  "OPENSCOUT_SCOUT_HOME",
  "OPENSCOUT_PAIRING_HOME",
  "OPENSCOUT_PAIRING_DIR",
  "SCOUT_PAIRING_HOME",
  "OPENSCOUT_BROKER_SOCKET_PATH",
  "OPENSCOUT_APP_SOCKET",
  "OPENSCOUT_PROBES_SOCKET",
  "OPENSCOUT_BROKER_PORT",
  "OPENSCOUT_LISTENING_PORT",
  "OPENSCOUT_WEB_PORT",
  "SCOUT_WEB_PORT",
  "OPENSCOUT_WEB_TERMINAL_RELAY_PORT",
  "OPENSCOUT_PAIRING_PORT",
  "SCOUT_PAIRING_PORT",
  "OPENSCOUT_JETSTREAM_PORT",
  "OPENSCOUT_JETSTREAM_MONITOR_PORT",
  "OPENSCOUT_NODE_NAME",
  "OPENSCOUT_NODE_QUALIFIER",
  "OPENSCOUT_NODE_ID",
  "OPENSCOUT_SERVICE_LABEL",
  "OPENSCOUT_BROKER_SERVICE_LABEL",
  "OPENSCOUT_BROKER_SERVICE_MODE",
  "OPENSCOUT_PARENT_PID",
  "OPENSCOUT_BROKER_HOST",
  "OPENSCOUT_BROKER_URL",
  "OPENSCOUT_BROKER_INTERNAL_URL",
  "OPENSCOUT_ADVERTISE_SCOPE",
  "OPENSCOUT_NETWORK_DISCOVERY_ENABLED",
  "OPENSCOUT_MESH_RENDEZVOUS_URL",
  "OPENSCOUT_MESH_SEEDS",
  "OPENSCOUT_MESH_DISCOVERY_INTERVAL_MS",
  "OPENSCOUT_RUNTIME_PACKAGE_DIR",
  "OPENSCOUT_CHAT_HOME",
  "OPENSCOUT_ZELLIJ_SOCKET_DIR",
  "OPENSCOUT_JETSTREAM_HOME",
  "OPENSCOUT_PAIRING_RUNTIME_STATE_PATH",
  "OPENSCOUT_CLIENT_INSTANCE",
];

/** Mirrors normalizeOpenScoutInstanceName in @openscout/runtime/config (a runtime test keeps them aligned). */
export function normalizeScoutInstanceName(raw: string | undefined | null): string | null {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (!trimmed || trimmed === "default" || trimmed === "production") return "prod";
  const normalized = trimmed.replace(/[\s_.]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(normalized) ? normalized : null;
}

const SCOUT_SPAWN_MARKER_ENV_KEYS = [
  "OPENSCOUT_INSTANCE",
  "OPENSCOUT_INSTANCE_EXPLICIT",
  "OPENSCOUT_PARENT_PID",
  "OPENSCOUT_SERVICE_LABEL",
  "OPENSCOUT_BROKER_SERVICE_LABEL",
  "OPENSCOUT_BROKER_SERVICE_MODE",
  "OPENSCOUT_CLIENT_INSTANCE",
  "OPENSCOUT_RUNTIME_PACKAGE_DIR",
  "OPENSCOUT_INSTANCE_ROOT",
  "OPENSCOUT_INSTANCE_PORT_BASE",
  "OPENSCOUT_INSTANCE_MESH",
  "OPENSCOUT_INSTANCE_HOST_LABEL",
] as const;

/**
 * `base` for a harness session (mirrors buildUserSpawnEnvironment): drops
 * OPENSCOUT_INSTANCE and the spawner's markers and sets
 * OPENSCOUT_CLIENT_INSTANCE. A prod spawner's other OPENSCOUT_* values are the
 * operator's overrides and are kept; a non-prod spawner's derived env is dropped.
 */
export function scoutUserSpawnEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const normalized = normalizeScoutInstanceName(base.OPENSCOUT_INSTANCE);
  if (normalized === null) {
    console.warn(`[openscout] invalid OPENSCOUT_INSTANCE ${JSON.stringify(base.OPENSCOUT_INSTANCE)}; harness gets the prod client pointer`);
  }
  const instance = normalized ?? "prod";
  const env: NodeJS.ProcessEnv = { ...base };
  // Fail safe: an invalid spawner name strips everything, like non-prod.
  const keys = normalized === "prod" ? SCOUT_SPAWN_MARKER_ENV_KEYS : SCOUT_USER_SPAWN_STRIPPED_ENV_KEYS;
  for (const key of keys) delete env[key];
  delete env.OPENSCOUT_ATTRIBUTION_KEY_FILE;
  delete env.OPENSCOUT_OPERATOR_ATTRIBUTION_HANDOFF_FILE;
  env.OPENSCOUT_CLIENT_INSTANCE = instance;
  return env;
}
