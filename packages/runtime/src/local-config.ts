import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, hostname as osHostname } from "node:os";
import { dirname, join } from "node:path";

import { assertTestIsolatedUserData, defaultOpenScoutSupportDirectory, resolveOpenScoutHome } from "./support-paths.js";
import { deriveOpenScoutInstanceLayout } from "./instance.js";
import { stripBonjourCollisionSuffix } from "./node-identity.js";

export const LOCAL_CONFIG_VERSION = 1;
export const DEFAULT_SCOUT_WEB_PORTAL_HOST = "scout.local";
export const DEFAULT_SCOUT_WEB_LOCAL_NAME = DEFAULT_SCOUT_WEB_PORTAL_HOST;
export const DEFAULT_SCOUT_WEB_DEV_HOST = `dev.${DEFAULT_SCOUT_WEB_PORTAL_HOST}`;
export const DEFAULT_SCOUT_WEB_VITE_HMR_PATH = "/ws/hmr";

export const OPENSCOUT_PORTS = {
  broker: 43110,
  roomListening: 43112,
  // Opt-in shared Scout MCP server, one process for every local session.
  mcp: 43115,
  web: 43120,
  webTerminalRelay: 43121,
  vite: 43122,
  pairingBridge: 43130,
  pairingRelay: 43131,
  pairingFileServer: 43132,
  studio: 43140,
  // Opt-in JetStream sidecar. Deliberately not 4222: an operator's own
  // nats-server must never be adopted, restarted, or collided with.
  jetstream: 43150,
  jetstreamMonitor: 43151,
} as const;
export const OPENSCOUT_WORKTREE_PORT_BASES = {
  web: 43200,
  vite: 43900,
  pairing: 44600,
} as const;
export const OPENSCOUT_WORKTREE_PORT_RANGE = 700;

export type LocalPortsConfig = {
  broker?: number;
  web?: number;
  pairing?: number;
};

export type LocalConfig = {
  version: number;
  host?: string;
  webLocalName?: string;
  ports?: LocalPortsConfig;
  /**
   * How much of the web surface the LAN-bound listener serves to non-loopback
   * peers. "pairing" (the default) answers only GET /pair; "full" serves the
   * app; "chat" exposes room pages, assets and room APIs only. API handlers
   * retain their credential and invitation checks. Operator-tunable
   * here so enabling LAN/tailnet access does not mean editing a launchd plist.
   */
  webLanScope?: "full" | "pairing" | "chat";
  /** Publish the node doorway on its physical LAN and reject remote web clients. */
  webLanOnly?: boolean;
};

export const DEFAULT_LOCAL_CONFIG = {
  version: LOCAL_CONFIG_VERSION,
  host: "127.0.0.1",
  webLocalName: undefined,
  ports: {
    broker: OPENSCOUT_PORTS.broker,
    web: OPENSCOUT_PORTS.web,
    pairing: OPENSCOUT_PORTS.pairingBridge,
  },
} as const;

export function normalizeLocalHostnameLabel(value: string | undefined): string {
  const stripped = value ? stripBonjourCollisionSuffix(value) : value;
  const firstLabel = stripped
    ?.trim()
    .replace(/\.local\.?$/i, "")
    .split(".")
    .find((part) => part.trim().length > 0)
    ?.trim();
  const normalized = firstLabel
    ?.toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return normalized || "localhost";
}

export function normalizeLocalHostname(value: string | undefined): string {
  const stripped = value ? stripBonjourCollisionSuffix(value) : value;
  const trimmed = stripped?.trim().replace(/\.$/, "").toLowerCase();
  const labels = trimmed
    ?.split(".")
    .map((label) =>
      label
        .trim()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-")
    )
    .filter(Boolean);
  return labels && labels.length > 0 ? labels.join(".") : "localhost";
}

export function resolveScoutWebMdnsHostname(hostname = osHostname()): string {
  return `${normalizeLocalHostnameLabel(hostname)}.local`;
}

export function resolveScoutWebNamedHostname(name: string): string {
  const normalized = normalizeLocalHostname(name);
  return normalized.includes(".") ? normalized : `${normalized}.${DEFAULT_SCOUT_WEB_PORTAL_HOST}`;
}

/** Stable dev edge hostname for source + Vite HMR through Caddy. */
export function resolveScoutWebDevHostname(
  portalHost = DEFAULT_SCOUT_WEB_PORTAL_HOST,
): string {
  const normalized = portalHost.trim().replace(/\.$/, "").toLowerCase();
  if (!normalized || normalized.startsWith("dev.")) {
    return normalized || DEFAULT_SCOUT_WEB_DEV_HOST;
  }
  return `dev.${normalized}`;
}

export function resolveConfiguredScoutWebHostname(
  config: Pick<LocalConfig, "webLocalName"> = loadLocalConfig(),
  machineHostname = osHostname(),
): string {
  if (config.webLocalName) {
    return resolveScoutWebNamedHostname(config.webLocalName);
  }
  return `${normalizeLocalHostnameLabel(machineHostname)}.${DEFAULT_SCOUT_WEB_PORTAL_HOST}`;
}

export function resolveScoutWebVirtualHostname(hostname = osHostname()): string {
  return `${normalizeLocalHostnameLabel(hostname)}.${DEFAULT_SCOUT_WEB_PORTAL_HOST}`;
}

export function localConfigHome(): string {
  return resolveOpenScoutHome();
}

export function localConfigPath(): string {
  return join(localConfigHome(), "config.json");
}

export function loadLocalConfig(): LocalConfig {
  const configPath = localConfigPath();
  if (!existsSync(configPath)) return { version: LOCAL_CONFIG_VERSION };
  try {
    return validateLocalConfig(JSON.parse(readFileSync(configPath, "utf8")));
  } catch {
    return { version: LOCAL_CONFIG_VERSION };
  }
}

function validateLocalConfig(input: unknown): LocalConfig {
  if (!input || typeof input !== "object") return { version: LOCAL_CONFIG_VERSION };
  const raw = input as Record<string, unknown>;
  const out: LocalConfig = { version: LOCAL_CONFIG_VERSION };
  if (typeof raw.host === "string" && raw.host.trim().length > 0) {
    out.host = raw.host.trim();
  }
  if (typeof raw.webLocalName === "string" && raw.webLocalName.trim().length > 0) {
    out.webLocalName = raw.webLocalName.trim();
  }
  if (raw.webLanScope === "full" || raw.webLanScope === "pairing" || raw.webLanScope === "chat") {
    out.webLanScope = raw.webLanScope;
  }
  if (typeof raw.webLanOnly === "boolean") out.webLanOnly = raw.webLanOnly;
  if (raw.ports && typeof raw.ports === "object") {
    const ports = raw.ports as Record<string, unknown>;
    const p: LocalPortsConfig = {};
    if (isValidPort(ports.broker)) p.broker = ports.broker;
    if (isValidPort(ports.web)) p.web = ports.web;
    if (isValidPort(ports.pairing)) p.pairing = ports.pairing;
    if (Object.keys(p).length > 0) out.ports = p;
  }
  return out;
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536;
}

function parseEnvPort(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return isValidPort(parsed) ? parsed : undefined;
}

/** File config merged with process-env overlays (env defines config at runtime). */
export function resolveEffectiveLocalConfig(): LocalConfig {
  const file = loadLocalConfig();
  const host = process.env.OPENSCOUT_BROKER_HOST?.trim()
    || process.env.OPENSCOUT_HOST?.trim()
    || file.host;
  const ports = {
    broker: parseEnvPort("OPENSCOUT_BROKER_PORT") ?? file.ports?.broker,
    web: parseEnvPort("OPENSCOUT_WEB_PORT")
      ?? parseEnvPort("SCOUT_WEB_PORT")
      ?? file.ports?.web,
    pairing: parseEnvPort("OPENSCOUT_PAIRING_PORT") ?? file.ports?.pairing,
  };

  return {
    version: LOCAL_CONFIG_VERSION,
    ...(host ? { host } : {}),
    ...(file.webLocalName ? { webLocalName: file.webLocalName } : {}),
    ...(ports.broker || ports.web || ports.pairing ? { ports } : {}),
  };
}

/**
 * Port defaults for the current OPENSCOUT_INSTANCE: prod keeps OPENSCOUT_PORTS,
 * any other instance gets its own block. Env and ~/.openscout/config.json win.
 */
function instanceDefaultPorts(): { broker: number; web: number; pairing: number } {
  // The layout reads the instance ledger (read-only): a claimed block wins
  // over the raw hashed slot. Claims happen only in the bootstraps.
  const ports = deriveOpenScoutInstanceLayout().ports;
  return { broker: ports.broker, web: ports.web, pairing: ports.pairingBridge };
}

function localBrokerControlHost(host: string): string {
  const trimmed = host.trim();
  if (!trimmed || trimmed === "0.0.0.0" || trimmed === "::" || trimmed === "[::]") {
    return DEFAULT_LOCAL_CONFIG.host;
  }
  return trimmed;
}

/** Same-machine broker API URL from config (host + broker port). */
export function resolveBrokerControlUrl(
  config: LocalConfig = resolveEffectiveLocalConfig(),
): string {
  // Ephemeral injection when a parent broker process starts a managed web child.
  const injected = process.env.OPENSCOUT_BROKER_INTERNAL_URL?.trim();
  if (injected) {
    return injected;
  }
  const host = config.host ?? DEFAULT_LOCAL_CONFIG.host;
  const port = config.ports?.broker ?? instanceDefaultPorts().broker;
  return `http://${localBrokerControlHost(host)}:${port}`;
}

export function resolveBrokerPort(): number {
  return resolveEffectiveLocalConfig().ports?.broker ?? instanceDefaultPorts().broker;
}

export function resolveWebPort(): number {
  return resolveEffectiveLocalConfig().ports?.web ?? instanceDefaultPorts().web;
}

export function resolvePairingPort(): number {
  return resolveEffectiveLocalConfig().ports?.pairing ?? instanceDefaultPorts().pairing;
}

export function resolveHost(): string {
  return resolveEffectiveLocalConfig().host ?? DEFAULT_LOCAL_CONFIG.host;
}

export function writeLocalConfig(config: LocalConfig): void {
  assertTestIsolatedUserData("write the OpenScout local config", "OPENSCOUT_HOME");
  const configPath = localConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });
  const body = JSON.stringify(
    { ...config, version: LOCAL_CONFIG_VERSION },
    null,
    2,
  ) + "\n";
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, configPath);
}

export function localConfigExists(): boolean {
  return existsSync(localConfigPath());
}

export function resolveWebAuthToken(env: NodeJS.ProcessEnv = process.env): string {
  const envToken = env.OPENSCOUT_WEB_AUTH_TOKEN?.trim();
  if (envToken) return envToken;

  const supportDir = env.OPENSCOUT_SUPPORT_DIRECTORY
    ?? defaultOpenScoutSupportDirectory();
  const tokenPath = join(supportDir, "runtime", "web-auth-token");

  try {
    if (existsSync(tokenPath)) {
      const stored = readFileSync(tokenPath, "utf8").trim();
      if (stored) return stored;
    }
  } catch {
    /* ignore read failures */
  }

  const generated = randomBytes(32).toString("base64url");
  try {
    if (process.env.NODE_ENV === "test" && !env.OPENSCOUT_SUPPORT_DIRECTORY) {
      return generated;
    }
    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    /* ignore write failures */
  }
  return generated;
}
