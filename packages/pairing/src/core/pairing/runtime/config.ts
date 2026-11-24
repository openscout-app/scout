import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { loadLocalConfig, resolvePairingPort, resolveOpenScoutPairingHome } from "@openscout/runtime/config";
import { readOpenScoutNetworkSettingsSync } from "@openscout/runtime/mesh";

export type PairingSessionConfig = {
  adapter: string;
  name: string;
  cwd?: string;
  options?: Record<string, unknown>;
};

export type PairingAdapterConfig = {
  type: string;
  options?: Record<string, unknown>;
};

export type PairingConfig = {
  relay?: string;
  secure?: boolean;
  port?: number;
  adapters?: Record<string, PairingAdapterConfig>;
  workspace?: {
    root?: string;
  };
  sessions?: PairingSessionConfig[];
};

export type PairingPaths = {
  rootDir: string;
  configPath: string;
  identityPath: string;
  trustedPeersPath: string;
  logPath: string;
  runtimeStatePath: string;
  runtimePidPath: string;
};

export const PAIRING_QR_TTL_MS = 5 * 60 * 1000;

export function pairingPaths(): PairingPaths {
  const rootDir = resolveOpenScoutPairingHome();
  return {
    rootDir,
    configPath: path.join(rootDir, "config.json"),
    identityPath: path.join(rootDir, "identity.json"),
    trustedPeersPath: path.join(rootDir, "trusted-peers.json"),
    logPath: path.join(rootDir, "bridge.log"),
    runtimeStatePath: path.join(rootDir, "runtime.json"),
    runtimePidPath: path.join(rootDir, "runtime.pid"),
  };
}

export function loadPairingConfig(): PairingConfig {
  const { configPath } = pairingPaths();
  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const payload = JSON.parse(readFileSync(configPath, "utf8")) as PairingConfig;
    return typeof payload === "object" && payload ? payload : {};
  } catch {
    return {};
  }
}

export function savePairingConfig(config: PairingConfig): void {
  const { rootDir, configPath } = pairingPaths();
  mkdirSync(rootDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536;
}

function parseEnvPort(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.OPENSCOUT_PAIRING_PORT?.trim() || env.SCOUT_PAIRING_PORT?.trim();
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return isValidPort(parsed) ? parsed : undefined;
}

export function resolvedPairingConfig(env: NodeJS.ProcessEnv = process.env) {
  const config = loadPairingConfig();
  const osn = readOpenScoutNetworkSettingsSync();
  const relay = env.OPENSCOUT_PAIRING_RELAY_URL?.trim()
    || env.OPENSCOUT_MOBILE_PAIRING_RELAY_URL?.trim()
    || config.relay
    || (osn.discoveryEnabled ? osn.pairingRelayUrl : undefined);
  const filePort = isValidPort(config.port) ? config.port : undefined;
  const localConfigPort = loadLocalConfig().ports?.pairing;
  return {
    relay: typeof relay === "string" && relay.trim().length > 0
      ? relay.trim()
      : null,
    secure: config.secure !== false,
    port: parseEnvPort(env) ?? localConfigPort ?? filePort ?? resolvePairingPort(),
    workspaceRoot: typeof config.workspace?.root === "string" && config.workspace.root.trim().length > 0
      ? config.workspace.root.trim()
      : null,
    sessions: Array.isArray(config.sessions) ? config.sessions : [],
  };
}
