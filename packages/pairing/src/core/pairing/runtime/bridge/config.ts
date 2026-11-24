// Bridge configuration — loads from ~/.scout/pairing/config.json with CLI overrides.
//
// Layering order (later wins):
//   1. Built-in defaults
//   2. ~/.scout/pairing/config.json
//   3. CLI flags

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadLocalConfig, resolvePairingPort, resolveOpenScoutPairingHome } from "@openscout/runtime/config";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface AdapterEntry {
  type: string;
  options?: Record<string, unknown>;
}

export interface SessionEntry {
  /** Adapter type to use (e.g. "claude-code", "codex", "openai"). */
  adapter: string;
  /** Display name for the session. */
  name: string;
  /** Working directory. */
  cwd?: string;
  /** Adapter-specific options. */
  options?: Record<string, unknown>;
}

export interface WorkspaceConfig {
  /** Root directory to browse projects from (e.g. "~/dev"). */
  root: string;
}

export interface PairingConfig {
  /** Relay WebSocket URL (e.g. "ws://relay.example.com:43131"). */
  relay?: string;
  /** Enable Noise encryption on local WebSocket connections. */
  secure?: boolean;
  /** Local WebSocket port. */
  port: number;
  /** Additional adapters to register (keyed by name). */
  adapters?: Record<string, AdapterEntry>;
  /** Sessions to auto-start when the bridge launches. */
  sessions?: SessionEntry[];
  /** Workspace root for project discovery. */
  workspace?: WorkspaceConfig;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

// The port default is per OPENSCOUT_INSTANCE (resolvePairingPort), not a constant.
const DEFAULTS: Pick<PairingConfig, "secure"> = {
  secure: true,
};

// ---------------------------------------------------------------------------
// Config file path
// ---------------------------------------------------------------------------

export function pairingConfigFile(): string {
  return join(resolveOpenScoutPairingHome(), "config.json");
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load config from ~/.scout/pairing/config.json, returning defaults for any missing
 * fields. Returns the raw file values so CLI can overlay on top.
 */
export function loadConfigFile(): Partial<PairingConfig> {
  if (!existsSync(pairingConfigFile())) {
    return {};
  }

  try {
    const raw = readFileSync(pairingConfigFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<PairingConfig>;
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[config] failed to parse ${pairingConfigFile()}: ${msg}`);
    return {};
  }
}

// ---------------------------------------------------------------------------
// CLI argument helpers
// ---------------------------------------------------------------------------

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

// ---------------------------------------------------------------------------
// Parse CLI flags into a partial config
// ---------------------------------------------------------------------------

export function parseCLIFlags(): Partial<PairingConfig> & { pair?: boolean } {
  const flags: Partial<PairingConfig> & { pair?: boolean } = {};

  const portStr = getArg("--port");
  if (portStr !== undefined) {
    const n = Number(portStr);
    if (!Number.isNaN(n) && n > 0) flags.port = n;
  }

  if (hasFlag("--secure")) flags.secure = true;

  const relay = getArg("--relay");
  if (relay !== undefined) flags.relay = relay;

  if (hasFlag("--pair")) flags.pair = true;

  return flags;
}

// ---------------------------------------------------------------------------
// Resolve final config: defaults <- legacy file <- local config/env <- CLI
// ---------------------------------------------------------------------------

export interface ResolvedConfig extends PairingConfig {
  /** --pair flag: just show QR and wait, don't start sessions. */
  pair: boolean;
}

export function resolveConfigLayers(
  file: Partial<PairingConfig>,
  cli: Partial<PairingConfig> & { pair?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const filePort = isValidPort(file.port) ? file.port : undefined;
  return {
    port: cli.port ?? parseEnvPort(env) ?? loadLocalConfig().ports?.pairing ?? filePort ?? resolvePairingPort(),
    secure: cli.secure ?? file.secure ?? DEFAULTS.secure ?? false,
    relay: cli.relay ?? file.relay,
    adapters: file.adapters,
    sessions: file.sessions,
    workspace: file.workspace,
    pair: cli.pair ?? false,
  };
}

function parseEnvPort(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.OPENSCOUT_PAIRING_PORT?.trim() || env.SCOUT_PAIRING_PORT?.trim();
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return isValidPort(parsed) ? parsed : undefined;
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536;
}

export function resolveConfig(): ResolvedConfig {
  const file = loadConfigFile();
  const cli = parseCLIFlags();
  return resolveConfigLayers(file, cli);
}
