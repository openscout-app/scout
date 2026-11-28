import "./bun-bootstrap.js";
import type { RuntimeEnv, RuntimePlatform } from "./portable-types.js";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ScoutBrokerHealthPayload,
  ScoutBrokerStorageStatus,
  ScoutBrokerBuildIdentity,
  ScoutBrokerChildServiceSnapshots,
  ScoutBrokerJsonRequestTrace,
} from "./broker-api.js";
import { requestScoutBrokerJsonWithTrace } from "./broker-api.js";
import { CONTROL_PLANE_SCHEMA_VERSION } from "./schema-version.js";
import { openControlPlaneSqliteDatabase } from "./sqlite-adapter.js";
import {
  defaultOpenScoutControlHome,
  defaultOpenScoutSupportDirectory,
  resolveOpenScoutSupportPaths,
} from "./support-paths.js";
import {
  applyOpenScoutInstanceEnvironment,
  assertOpenScoutInstanceIsolation,
  deriveOpenScoutInstanceLayout,
  openScoutInstanceMeshRefusal,
  resolveOpenScoutInstanceName,
} from "./instance.js";
import {
  assertSystemctlOk,
  assertSystemdUnitOwnership,
  buildSystemdUserUnitSpec,
  systemdUserLingerWarning,
  readSystemdUserUnitState,
  removeSystemdUserUnit,
  renderSystemdUserUnit,
  runSystemctlUser,
  systemdUserUnitDirectory,
  writeSystemdUserUnit,
  withOperatorUnitEnvironment,
  type SystemctlRunner,
} from "./systemd-user-service.js";
import {
  openScoutNetworkDiscoveryEnabled,
} from "./open-scout-network.js";
import { readTailscaleSelfWebHostsSync } from "./tailscale.js";
import { OPENSCOUT_PORTS, resolveBrokerControlUrl, resolveBrokerPort } from "./local-config.js";
import {
  expandHomePath,
  isExecutablePath,
  resolveBunExecutable as resolveResolvedBunExecutable,
  resolveExecutableFromSearch,
} from "./tool-resolution.js";
import {
  defaultServiceAdapterForPlatform,
  type RuntimeServiceAdapterKind,
} from "./runtime-adapters.js";

/** True for paths under /tmp or /private/tmp — transient remote-install dirs. */
function isTmpPath(p: string): boolean {
  return /^\/(?:private\/)?tmp\//.test(p);
}

export type BrokerServiceMode = "dev" | "prod" | "custom";
export type BrokerAdvertiseScope = "local" | "mesh";
export type BrokerHealthTransport = ScoutBrokerJsonRequestTrace["transport"] | "in_process";

export type BrokerServiceConfig = {
  label: string;
  mode: BrokerServiceMode;
  uid: number;
  domainTarget: string;
  serviceTarget: string;
  launchAgentPath: string;
  supportDirectory: string;
  runtimeDirectory: string;
  logsDirectory: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  controlHome: string;
  runtimePackageDir: string;
  bunExecutable: string | null;
  brokerHost: string;
  brokerPort: number;
  brokerUrl: string;
  brokerSocketPath: string;
  advertiseScope: BrokerAdvertiseScope;
  coreAgents: string[];
};

export type BrokerHealthSnapshot = {
  state?: string;
  durationMs?: number;
  reachable: boolean;
  ok: boolean;
  checkedAt: number;
  transport?: BrokerHealthTransport;
  socketPath?: string;
  socketFallbackError?: string;
  nodeId?: string;
  meshId?: string;
  build?: ScoutBrokerBuildIdentity;
  services?: ScoutBrokerChildServiceSnapshots;
  storage?: ScoutBrokerStorageStatus;
  counts?: {
    nodes: number;
    actors: number;
    agents: number;
    agentRecords?: number;
    rawAgentRecords?: number;
    configuredAgents?: number;
    scoutManagedAgents?: number;
    currentAgentRegistrations?: number;
    localAgentRegistrations?: number;
    remoteAgentRegistrations?: number;
    staleAgentRegistrations?: number;
    retiredAgentRegistrations?: number;
    oneTimeAgentCards?: number;
    persistentAgentCards?: number;
    conversations: number;
    messages: number | null;
    flights: number;
    collaborationRecords: number;
  };
  error?: string;
};

export type BrokerRuntimeFreshness = {
  state: "current" | "pinned" | "stale" | "unverified" | string;
  intentional: boolean;
  basis: string;
  reasonCode: string | null;
  artifactCommit: string | null;
  expectedCommit: string | null;
  pin: string | null;
  pinReason: string | null;
  manifestPath: string | null;
  version: string | null;
  actualBuiltAt: string | null;
  expectedBuiltAt: string | null;
  /** @deprecated Use actualBuiltAt. */
  builtAt: string | null;
  sourceDirty: boolean | null;
  detail: string;
};

export type BrokerServiceStatus = {
  serviceAdapter?: RuntimeServiceAdapterKind;
  /** OPENSCOUT_INSTANCE this status describes (`prod` unless isolated). */
  instance?: string;
  label: string;
  mode: BrokerServiceMode;
  launchAgentPath: string;
  bootoutCommand: string;
  brokerUrl: string;
  brokerSocketPath: string;
  supportDirectory: string;
  runtimeDirectory: string;
  controlHome: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  installed: boolean;
  loaded: boolean;
  pid: number | null;
  launchdState: string | null;
  lastExitStatus: number | null;
  usesLaunchAgent: boolean;
  reachable: boolean;
  health: BrokerHealthSnapshot;
  runtimeFreshness?: BrokerRuntimeFreshness;
  lastLogLine: string | null;
  /** Non-fatal service advisories (for example systemd lingering off). */
  warnings?: string[];
};

export type BrokerServiceCommand = "install" | "start" | "stop" | "restart" | "uninstall" | "status";

export const DEFAULT_BROKER_HOST = "127.0.0.1";
/**
 * @deprecated P1.5 retires the mesh-scope `0.0.0.0` plaintext default
 * (docs/proposals/mesh-trust-cone.md §11.3). Mesh posture is loopback
 * plaintext + non-loopback TLS. Kept as a named constant for tests and
 * legacy config readers that still compare against the old wildcard.
 */
export const DEFAULT_BROKER_HOST_MESH = "0.0.0.0";
export const DEFAULT_BROKER_PORT: number = OPENSCOUT_PORTS.broker;
export const DEFAULT_ADVERTISE_SCOPE: BrokerAdvertiseScope = "local";

/**
 * Optional reader of the support-dir mesh-bind.json desired scope. Injected
 * lazily so this module does not import the bind controller (cycle risk);
 * broker-daemon / service config call sites pass it when available.
 */
export type PersistedAdvertiseScopeReader = () => BrokerAdvertiseScope | null;

/** Support-dir file written by POST /v1/mesh/bind (reboot restore, §11.5). */
export const MESH_BIND_CONFIG_FILE = "mesh-bind.json";

export type MeshBindPersistedConfig = {
  version: 1;
  advertiseScope: BrokerAdvertiseScope;
};

export function meshBindConfigPath(supportDirectory?: string): string {
  const dir = supportDirectory ?? resolveOpenScoutSupportPaths().supportDirectory;
  return join(dir, MESH_BIND_CONFIG_FILE);
}

/** Read persisted desired advertise scope, if any. */
export function readPersistedAdvertiseScope(
  supportDirectory?: string,
): BrokerAdvertiseScope | null {
  const path = meshBindConfigPath(supportDirectory);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as MeshBindPersistedConfig;
    if (parsed.version !== 1) return null;
    if (parsed.advertiseScope === "mesh" || parsed.advertiseScope === "local") {
      return parsed.advertiseScope;
    }
  } catch {
    // corrupt file — ignore and fall through to env default
  }
  return null;
}

/** Write desired advertise scope (reboot restore; no service restart). */
export function writePersistedAdvertiseScope(
  scope: BrokerAdvertiseScope,
  supportDirectory?: string,
): void {
  const path = meshBindConfigPath(supportDirectory);
  mkdirSync(dirname(path), { recursive: true });
  const payload: MeshBindPersistedConfig = { version: 1, advertiseScope: scope };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export function resolveAdvertiseScope(
  env: RuntimeEnv = process.env,
  readPersisted: PersistedAdvertiseScopeReader | null = null,
): BrokerAdvertiseScope {
  // A non-prod OPENSCOUT_INSTANCE stays local unless explicitly opted in.
  if (openScoutInstanceMeshRefusal(env)) return "local";
  // Persisted bind posture wins over env so a reboot restores the announced
  // scope (docs/proposals/mesh-trust-cone.md §11.5). Env remains the boot
  // default when nothing has been persisted.
  const persisted = readPersisted?.() ?? null;
  if (persisted === "mesh" || persisted === "local") {
    return persisted;
  }
  if (openScoutNetworkDiscoveryEnabled(env)) return "mesh";
  const raw = (env.OPENSCOUT_ADVERTISE_SCOPE ?? "").trim().toLowerCase();
  if (raw === "mesh") return "mesh";
  if (raw === "local") return "local";
  return DEFAULT_ADVERTISE_SCOPE;
}

/**
 * Host for the *plaintext* TCP listener. P1.5 always binds loopback for
 * plaintext (§11.3); mesh exposure is non-loopback TLS, not a wildcard
 * plaintext bind. Explicit `0.0.0.0`/`::` is normalized to loopback so legacy
 * service plists stop opening a LAN-facing plaintext socket.
 */
export function resolveBrokerHost(
  _scope: BrokerAdvertiseScope = resolveAdvertiseScope(),
  env: RuntimeEnv = process.env,
): string {
  const explicit = env.OPENSCOUT_BROKER_HOST?.trim();
  if (explicit && !isWildcardHost(explicit)) {
    // Explicit non-wildcard host still allowed for specialized installs, but
    // mesh scope no longer upgrades loopback → 0.0.0.0.
    return explicit;
  }
  return DEFAULT_BROKER_HOST;
}

export function isLoopbackHost(host: string): boolean {
  const trimmed = host.trim();
  return trimmed === "127.0.0.1" || trimmed === "::1" || trimmed === "localhost";
}

function localBrokerControlHost(host: string): string {
  const trimmed = host.trim();
  if (!trimmed || isWildcardHost(trimmed)) {
    return DEFAULT_BROKER_HOST;
  }
  return trimmed;
}

export function buildDefaultBrokerUrl(host = DEFAULT_BROKER_HOST, port = DEFAULT_BROKER_PORT): string {
  return `http://${host}:${port}`;
}

/** Peer-facing HTTPS URL for a non-loopback TLS bind (§11.3 card endpoints). */
export function buildDefaultBrokerHttpsUrl(host: string, port = DEFAULT_BROKER_PORT): string {
  return `https://${host}:${port}`;
}

export function resolveBrokerUrl(
  host: string,
  port: number,
  scope: BrokerAdvertiseScope,
  env: RuntimeEnv = process.env,
  lanHost: string | null = findLanIPv4Address(),
): string {
  const explicit = env.OPENSCOUT_BROKER_URL?.trim();
  if (explicit && !(scope === "mesh" && isUnreachableMeshBrokerUrl(explicit))) {
    return explicit;
  }
  if (scope === "mesh") {
    // LAN before Tailscale: same-house peers dial RFC1918 first. MagicDNS/CGNAT
    // stay advertised as fallback when the LAN path is unreachable.
    if (lanHost) {
      return buildDefaultBrokerHttpsUrl(lanHost, port);
    }
    const tailnetHost = readTailscaleSelfWebHostsSync(env)[0];
    if (tailnetHost) {
      return buildDefaultBrokerHttpsUrl(tailnetHost, port);
    }
  }
  return buildDefaultBrokerUrl(host, port);
}

/**
 * Best private LAN IPv4 for announcing to same-LAN peers (physical `en*`
 * interfaces first; link-local and Tailscale ranges skipped). Returns null
 * when the machine has no usable LAN address.
 */
export function findLanIPv4Address(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string | null {
  const candidates: Array<{ name: string; address: string }> = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      // family may be the number 4 on some Node versions
      if (entry.family !== "IPv4" && entry.family !== (4 as never)) continue;
      if (!isPrivateIPv4(entry.address) || isLinkLocalIPv4(entry.address) || isTailscaleIPv4(entry.address)) continue;
      candidates.push({ name, address: entry.address });
    }
  }
  candidates.sort((left, right) => {
    const scoreDelta = lanInterfaceScore(left.name) - lanInterfaceScore(right.name);
    return scoreDelta !== 0 ? scoreDelta : left.address.localeCompare(right.address);
  });
  return candidates[0]?.address ?? null;
}

/**
 * Best Tailscale IPv4 (CGNAT 100.64/10) for §11.3 TLS bind on the tailnet
 * interface. Returns null when Tailscale is absent or has no IPv4.
 */
export function findTailscaleIPv4Address(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string | null {
  const candidates: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family !== "IPv4" && entry.family !== 4 as never) continue;
      if (isTailscaleIPv4(entry.address)) {
        candidates.push(entry.address);
      }
    }
  }
  candidates.sort();
  return candidates[0] ?? null;
}

function lanInterfaceScore(name: string): number {
  if (/^en\d+$/i.test(name)) return 0;
  if (/^bridge\d*$/i.test(name)) return 2;
  return 1;
}

function isPrivateIPv4(address: string): boolean {
  const octets = parseIPv4(address);
  if (!octets) return false;
  const [first, second] = octets;
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function isLinkLocalIPv4(address: string): boolean {
  const octets = parseIPv4(address);
  return Boolean(octets && octets[0] === 169 && octets[1] === 254);
}

function isTailscaleIPv4(address: string): boolean {
  const octets = parseIPv4(address);
  return Boolean(octets && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
}

function parseIPv4(address: string): [number, number, number, number] | null {
  const octets = address.split(".");
  if (octets.length !== 4) return null;
  const numbers = octets.map((octet) => Number(octet));
  if (numbers.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return numbers as [number, number, number, number];
}

function isUnreachableMeshBrokerUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return isLoopbackHost(host) || isWildcardHost(host);
  } catch {
    return false;
  }
}

function isWildcardHost(host: string): boolean {
  const trimmed = host.trim();
  return trimmed === "0.0.0.0" || trimmed === "::" || trimmed === "[::]";
}

export function buildLocalBrokerControlUrl(host = DEFAULT_BROKER_HOST, port = DEFAULT_BROKER_PORT): string {
  return buildDefaultBrokerUrl(localBrokerControlHost(host), port);
}

export function buildDefaultBrokerSocketPath(runtimeDirectory: string): string {
  return join(runtimeDirectory, "broker.sock");
}

export const DEFAULT_BROKER_URL = buildDefaultBrokerUrl();

function normalizeBrokerUrl(value: string): string {
  try {
    return new URL(value).toString();
  } catch {
    return value.trim();
  }
}

/** Same-machine broker API URL — ~/.openscout/config.json (+ env overlays). */
export function resolveScoutBrokerControlUrl(
  _config: BrokerServiceConfig = resolveBrokerServiceConfig(),
): string {
  return resolveBrokerControlUrl();
}

export function resolveBrokerSocketPathForBaseUrl(
  baseUrl: string,
  config: BrokerServiceConfig = resolveBrokerServiceConfig(),
): string | null {
  const normalized = normalizeBrokerUrl(baseUrl);
  if (
    normalized === normalizeBrokerUrl(config.brokerUrl)
    || normalized === normalizeBrokerUrl(resolveScoutBrokerControlUrl(config))
  ) {
    return config.brokerSocketPath;
  }
  return null;
}

function runtimePackageDir(): string {
  // 1. Explicit override — always wins (useful for development)
  const explicit = process.env.OPENSCOUT_RUNTIME_PACKAGE_DIR?.trim();
  if (explicit) return explicit;

  // 2. Prefer the package that bundled this code. In published installs this
  // is @openscout/scout, which carries a private openscout-runtime shim.
  const fromBundledPackage = findBundledRuntimeDir();
  if (fromBundledPackage) return fromBundledPackage;

  // 3. Monorepo workspace fallback (dev only)
  const fromCwd = findWorkspaceRuntimeDir(process.cwd());
  if (fromCwd) return fromCwd;

  // 4. Compatibility with old installs that still have a separate runtime pkg.
  const fromGlobal = findGlobalRuntimeDir();
  if (fromGlobal) return fromGlobal;

  // 5. Last resort: relative to this module.
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, "..");
}

function isInstalledRuntimePackageDir(candidate: string): boolean {
  return existsSync(join(candidate, "package.json"))
    && existsSync(join(candidate, "bin", "openscout-runtime.mjs"));
}

function findGlobalRuntimeDir(): string | null {
  // Static candidates: bun global install layouts
  const candidates = [
    join(homedir(), ".bun", "node_modules", "@openscout", "runtime"),
    join(homedir(), ".bun", "install", "global", "node_modules", "@openscout", "runtime"),
    join(homedir(), ".bun", "install", "global", "node_modules", "@openscout", "scout", "node_modules", "@openscout", "runtime"),
  ];

  for (const c of candidates) {
    if (isInstalledRuntimePackageDir(c)) return c;
  }

  // Dynamic: resolve from `which scout` — works regardless of how it was installed
  // (npm -g, bun -g, Homebrew prefix, etc.)
  try {
    const result = spawnSync("which", ["scout"], { encoding: "utf8", timeout: 3000 });
    const scoutBin = result.stdout?.trim();
    if (scoutBin) {
      // scout bin → ../../lib/node_modules/@openscout/scout
      const scoutPkg = resolve(scoutBin, "..", "..");
      if (isInstalledRuntimePackageDir(scoutPkg)) return scoutPkg;

      // Legacy layouts: scout bin → ../../lib/node_modules/@openscout/scout/node_modules/@openscout/runtime
      const nested = join(scoutPkg, "node_modules", "@openscout", "runtime");
      if (isInstalledRuntimePackageDir(nested)) return nested;
      // or runtime is a sibling: ../../lib/node_modules/@openscout/runtime
      const sibling = resolve(scoutPkg, "..", "runtime");
      if (isInstalledRuntimePackageDir(sibling)) return sibling;
    }
  } catch {
    // which not available or timed out
  }

  return null;
}

function findBundledRuntimeDir(): string | null {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolveBundledRuntimeDirFromModuleDir(moduleDir);
}

export function resolveBundledRuntimeDirFromModuleDir(moduleDir: string): string | null {
  const candidates = [
    // @openscout/runtime/dist/broker-process-manager.js
    resolve(moduleDir, ".."),
    // @openscout/scout/dist/runtime/broker-process-manager.mjs
    resolve(moduleDir, "..", ".."),
  ];

  for (const candidate of candidates) {
    if (!isInstalledRuntimePackageDir(candidate)) continue;

    // The source-linked CLI has the same private runtime shim as the
    // published package, but the shared dev service is owned by the sibling
    // packages/runtime directory. Keep that stable owner instead of making
    // every CLI command try to repoint launchd from runtime to cli.
    const sourceWorkspaceRuntime = resolveSourceWorkspaceRuntimeDir(candidate);
    if (sourceWorkspaceRuntime) return sourceWorkspaceRuntime;

    return candidate;
  }

  return null;
}

function resolveSourceWorkspaceRuntimeDir(bundledPackageDir: string): string | null {
  const packagesDir = dirname(bundledPackageDir);
  if (resolve(packagesDir, "cli") !== resolve(bundledPackageDir)) return null;

  const runtimeDir = join(packagesDir, "runtime");
  if (!existsSync(join(runtimeDir, "src"))) return null;
  if (!isInstalledRuntimePackageDir(runtimeDir)) return null;

  try {
    const cliPackage = JSON.parse(readFileSync(join(bundledPackageDir, "package.json"), "utf8")) as { name?: unknown };
    const runtimePackage = JSON.parse(readFileSync(join(runtimeDir, "package.json"), "utf8")) as { name?: unknown };
    return cliPackage.name === "@openscout/scout" && runtimePackage.name === "@openscout/runtime"
      ? runtimeDir
      : null;
  } catch {
    return null;
  }
}

function findWorkspaceRuntimeDir(startDir: string): string | null {
  let current = resolve(startDir);
  while (true) {
    const candidate = join(current, "packages", "runtime");
    if (existsSync(join(candidate, "package.json")) && existsSync(join(candidate, "src"))) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveBunExecutable(): string {
  const bun = resolveOptionalBunExecutable();
  if (bun) {
    return bun;
  }

  throw new Error("Unable to locate Bun for broker service management. Install Bun or set OPENSCOUT_BUN_BIN.");
}

function resolveOptionalBunExecutable(): string | null {
  return resolveResolvedBunExecutable(process.env)?.path ?? null;
}

function resolveBrokerServiceMode(): BrokerServiceMode {
  const explicit = (process.env.OPENSCOUT_BROKER_SERVICE_MODE ?? "").trim().toLowerCase();
  if (explicit === "prod" || explicit === "production") {
    return "prod";
  }
  if (explicit === "custom") {
    return "custom";
  }
  return "dev";
}

function resolveBrokerServiceLabel(mode: BrokerServiceMode): string {
  const explicit = process.env.OPENSCOUT_SERVICE_LABEL?.trim()
    || process.env.OPENSCOUT_BROKER_SERVICE_LABEL?.trim();
  if (explicit) {
    return explicit;
  }

  // A non-prod OPENSCOUT_INSTANCE owns its own label (app.openscout.<name>).
  const layout = deriveOpenScoutInstanceLayout();
  if (!layout.isProd) {
    return layout.serviceLabel;
  }
  return mode === "custom" ? "app.openscout.custom" : layout.serviceLabel;
}

export function resolveBrokerServiceConfig(): BrokerServiceConfig {
  const mode = resolveBrokerServiceMode();
  const label = resolveBrokerServiceLabel(mode);
  const serviceAdapter = resolveBrokerServiceAdapter();
  const uid = typeof process.getuid === "function" ? process.getuid() : Number.parseInt(process.env.UID ?? "0", 10);
  // Explicit OPENSCOUT_SUPPORT_DIRECTORY / OPENSCOUT_CONTROL_HOME always win
  // for the running process (the broker socket and journal must land where
  // the caller said). Only the *persisted* service definition swaps transient
  // /tmp paths for durable defaults: see persistentBrokerServiceConfig.
  const supportPaths = resolveOpenScoutSupportPaths();
  const supportDirectory = supportPaths.supportDirectory;
  const runtimeDirectory = join(supportDirectory, "runtime");
  const logsDirectory = join(supportDirectory, "logs", "broker");
  const controlHome = supportPaths.controlHome;
  const advertiseScope = resolveAdvertiseScope(
    process.env,
    () => readPersistedAdvertiseScope(supportDirectory),
  );
  const brokerHost = resolveBrokerHost(advertiseScope);
  const brokerPort = Number.parseInt(process.env.OPENSCOUT_BROKER_PORT ?? String(resolveBrokerPort()), 10);
  const brokerUrl = resolveBrokerUrl(brokerHost, brokerPort, advertiseScope);
  const brokerSocketPath = process.env.OPENSCOUT_BROKER_SOCKET_PATH?.trim()
    || (process.env.OPENSCOUT_SUPPORT_DIRECTORY?.trim() && isTmpPath(supportDirectory)
      ? buildDefaultBrokerSocketPath(runtimeDirectory)
      : deriveOpenScoutInstanceLayout().brokerSocketPath);
  const launchAgentPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);

  return {
    label,
    mode,
    uid,
    domainTarget: `gui/${uid}`,
    serviceTarget: `gui/${uid}/${label}`,
    launchAgentPath,
    supportDirectory,
    runtimeDirectory,
    logsDirectory,
    stdoutLogPath: join(logsDirectory, "stdout.log"),
    stderrLogPath: join(logsDirectory, "stderr.log"),
    controlHome,
    runtimePackageDir: runtimePackageDir(),
    bunExecutable: serviceAdapter === "macos-scoutd"
      ? resolveBunExecutable()
      : resolveOptionalBunExecutable(),
    brokerHost,
    brokerPort,
    brokerUrl,
    brokerSocketPath,
    advertiseScope,
    coreAgents: readCoreAgentsSync(),
  };
}

/**
 * The config a persistent service (launchd plist, systemd unit) should carry.
 * Remote-install sessions point OPENSCOUT_SUPPORT_DIRECTORY / CONTROL_HOME at
 * transient /tmp dirs that do not survive a reboot; a service definition gets
 * the durable instance defaults instead. The running process keeps honouring
 * its explicit env (resolveBrokerServiceConfig).
 */
export function persistentBrokerServiceConfig(config: BrokerServiceConfig): BrokerServiceConfig {
  const supportTransient = isTmpPath(config.supportDirectory);
  const controlTransient = isTmpPath(config.controlHome);
  if (!supportTransient && !controlTransient) return config;
  const supportDirectory = supportTransient ? defaultOpenScoutSupportDirectory() : config.supportDirectory;
  const runtimeDirectory = join(supportDirectory, "runtime");
  const logsDirectory = join(supportDirectory, "logs", "broker");
  return {
    ...config,
    supportDirectory,
    runtimeDirectory,
    logsDirectory,
    stdoutLogPath: join(logsDirectory, "stdout.log"),
    stderrLogPath: join(logsDirectory, "stderr.log"),
    controlHome: controlTransient ? defaultOpenScoutControlHome() : config.controlHome,
    brokerSocketPath: isTmpPath(config.brokerSocketPath)
      ? deriveOpenScoutInstanceLayout().brokerSocketPath
      : config.brokerSocketPath,
  };
}

type ScoutdCommand = {
  path: string;
  source: "env" | "package" | "workspace" | "path";
};

type NativeServiceStatus = Record<string, unknown> & {
  health?: unknown;
};

type HeadlessBrokerHealthReader = (
  config: BrokerServiceConfig,
) => Promise<{
  health: ScoutBrokerHealthPayload;
  trace: ScoutBrokerJsonRequestTrace;
}>;

export function resolveBrokerServiceAdapter(
  env: RuntimeEnv = process.env,
  platform: RuntimePlatform = process.platform,
): RuntimeServiceAdapterKind {
  return defaultServiceAdapterForPlatform(platform, env);
}

function executableCandidate(path: string | undefined | null): string | null {
  return isExecutablePath(path) ? path : null;
}

function resolveExecutableName(name: string): string | null {
  return resolveExecutableFromSearch({ names: [name] })?.path ?? null;
}

function resolveEnvExecutable(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.includes("/") || trimmed.startsWith(".")) {
    const expanded = resolve(expandHomePath(trimmed));
    return executableCandidate(expanded);
  }
  return resolveExecutableName(trimmed);
}

function findWorkspaceRootFromRuntimeDir(runtimePackageDir: string): string | null {
  let current = resolve(runtimePackageDir);
  while (true) {
    if (
      existsSync(join(current, "Cargo.toml"))
      && existsSync(join(current, "crates", "scoutd", "Cargo.toml"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function workspaceScoutdAllowed(): boolean {
  const raw = process.env.OPENSCOUT_ALLOW_WORKSPACE_SCOUTD?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** macOS ships a native supervisor. Other platforms must not resolve or spawn it. */
export function nativeSupervisorNotApplicableDetail(platform: NodeJS.Platform = process.platform): string {
  return platform === "linux"
    ? "native supervisor: not applicable on linux"
    : `native supervisor: not applicable on ${platform}`;
}

export function resolveScoutdCommand(config: BrokerServiceConfig = resolveBrokerServiceConfig()): ScoutdCommand | null {
  if (process.platform !== "darwin") return null;

  const explicit = resolveEnvExecutable(process.env.OPENSCOUT_SCOUTD_BIN);
  if (explicit) {
    return { path: explicit, source: "env" };
  }

  const workspaceRoot = findWorkspaceRootFromRuntimeDir(config.runtimePackageDir);
  const packageCandidates = [
    join(config.runtimePackageDir, "bin", "scoutd"),
    join(config.runtimePackageDir, "native", "scoutd"),
    join(config.runtimePackageDir, "scoutd"),
    workspaceRoot ? join(workspaceRoot, "packages", "cli", "bin", "scoutd") : null,
    workspaceRoot ? join(workspaceRoot, "packages", "runtime", "bin", "scoutd") : null,
    join(config.runtimeDirectory, "scoutd"),
    join(dirname(config.runtimePackageDir), "scout", "bin", "scoutd"),
  ];
  for (const candidate of packageCandidates) {
    const resolved = executableCandidate(candidate);
    if (resolved) {
      return { path: resolved, source: "package" };
    }
  }

  const fromPath = resolveExecutableName("scoutd");
  if (fromPath) {
    return { path: fromPath, source: "path" };
  }

  if (workspaceRoot && workspaceScoutdAllowed()) {
    for (const candidate of [
      join(workspaceRoot, "target", "release", "scoutd"),
      join(workspaceRoot, "target", "debug", "scoutd"),
    ]) {
      const resolved = executableCandidate(candidate);
      if (resolved) {
        return { path: resolved, source: "workspace" };
      }
    }
  }

  return null;
}

function nativeServiceEnvironment(serviceConfig: BrokerServiceConfig, scoutdPath: string): RuntimeEnv {
  const config = persistentBrokerServiceConfig(serviceConfig);
  const env: RuntimeEnv = {
    ...process.env,
    OPENSCOUT_SCOUTD_BIN: scoutdPath,
    // Pinned on every service child: checkout code never takes a dev default.
    OPENSCOUT_INSTANCE: resolveOpenScoutInstanceName(),
    OPENSCOUT_RUNTIME_PACKAGE_DIR: config.runtimePackageDir,
    OPENSCOUT_SUPPORT_DIRECTORY: config.supportDirectory,
    OPENSCOUT_CONTROL_HOME: config.controlHome,
    OPENSCOUT_BROKER_HOST: config.brokerHost,
    OPENSCOUT_BROKER_PORT: String(config.brokerPort),
    OPENSCOUT_BROKER_URL: config.brokerUrl,
    OPENSCOUT_BROKER_SOCKET_PATH: config.brokerSocketPath,
    OPENSCOUT_BROKER_SERVICE_MODE: config.mode,
    OPENSCOUT_BROKER_SERVICE_LABEL: config.label,
    OPENSCOUT_SERVICE_LABEL: config.label,
    OPENSCOUT_ADVERTISE_SCOPE: config.advertiseScope,
  };
  if (config.bunExecutable) {
    env.OPENSCOUT_BUN_BIN = config.bunExecutable;
  }
  if (config.coreAgents.length > 0) {
    env.OPENSCOUT_CORE_AGENTS = config.coreAgents.join(",");
  }
  return env;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readHealthTransport(value: unknown): BrokerHealthTransport | undefined {
  return value === "unix_socket" || value === "http" || value === "in_process" ? value : undefined;
}

function readRuntimeFreshness(value: unknown): BrokerRuntimeFreshness | undefined {
  if (!isRecord(value)) return undefined;
  const state = readString(value.state);
  const basis = readString(value.basis);
  const detail = readString(value.detail);
  if (!state || !basis || !detail) return undefined;
  return {
    state,
    intentional: readBoolean(value.intentional) ?? false,
    basis,
    reasonCode: readString(value.reasonCode) ?? null,
    artifactCommit: readString(value.artifactCommit) ?? null,
    expectedCommit: readString(value.expectedCommit) ?? null,
    pin: readString(value.pin) ?? null,
    pinReason: readString(value.pinReason) ?? null,
    manifestPath: readString(value.manifestPath) ?? null,
    version: readString(value.version) ?? null,
    actualBuiltAt: readString(value.actualBuiltAt) ?? readString(value.builtAt) ?? null,
    expectedBuiltAt: readString(value.expectedBuiltAt) ?? null,
    builtAt: readString(value.builtAt) ?? readString(value.actualBuiltAt) ?? null,
    sourceDirty: readBoolean(value.sourceDirty) ?? null,
    detail,
  };
}

function readNativeStorageStatus(health: Record<string, unknown>): ScoutBrokerStorageStatus | undefined {
  let storage = health.storage;
  // scoutd forwards the HTTP payload as a JSON string, not flattened fields.
  if (!isRecord(storage) && typeof health.body === "string") {
    try { storage = JSON.parse(health.body)?.storage; } catch { return undefined; }
  }
  if (!isRecord(storage) || !isRecord(storage.journal)) return undefined;
  const journal = storage.journal;
  if (journal.state === "ok") return { journal: { state: "ok" } };
  if (journal.state !== "failing" || readNumber(journal.since) === undefined
    || readNumber(journal.lastFailedAt) === undefined || readNumber(journal.failures) === undefined
    || typeof journal.error !== "string" || (journal.code !== null && typeof journal.code !== "string")) return undefined;
  return { journal: journal as ScoutBrokerStorageStatus["journal"] };
}

function readNativeChildServices(health: Record<string, unknown>): ScoutBrokerChildServiceSnapshots | undefined {
  if (isRecord(health.services)) return health.services as ScoutBrokerChildServiceSnapshots;
  if (typeof health.body !== "string") return undefined;
  try {
    const services = JSON.parse(health.body)?.services;
    return isRecord(services) ? services as ScoutBrokerChildServiceSnapshots : undefined;
  } catch { return undefined; }
}

function normalizeNativeServiceStatus(input: NativeServiceStatus, config: BrokerServiceConfig): BrokerServiceStatus {
  const healthRecord = isRecord(input.health) ? input.health : {};
  const healthReachable = readBoolean(healthRecord.reachable) ?? readBoolean(input.reachable) ?? false;
  const healthOk = readBoolean(healthRecord.ok)
    ?? (typeof input.health === "boolean" ? input.health : undefined)
    ?? false;
  const healthError = readString(healthRecord.error) ?? readString(input.healthError);
  const healthTransport = readHealthTransport(healthRecord.transport) ?? readHealthTransport(input.healthTransport);
  const healthNodeId = readString(healthRecord.nodeId);
  const healthMeshId = readString(healthRecord.meshId);
  const healthSocketFallbackError = readString(healthRecord.socketFallbackError);
  const healthCounts = isRecord(healthRecord.counts)
    ? healthRecord.counts as BrokerHealthSnapshot["counts"]
    : undefined;
  const installed = readBoolean(input.installed) ?? existsSync(config.launchAgentPath);
  const loaded = readBoolean(input.loaded) ?? false;
  const stdoutLogPath = readString(input.stdoutLogPath) ?? config.stdoutLogPath;
  const stderrLogPath = readString(input.stderrLogPath) ?? config.stderrLogPath;
  const lastLogLine = readString(input.lastLogLine)
    ?? (healthReachable
      ? readLastLogLine([stdoutLogPath, stderrLogPath])
      : readLastLogLine([stderrLogPath, stdoutLogPath]));
  const runtimeFreshness = readRuntimeFreshness(input.runtimeFreshness);

  return {
    label: readString(input.label) ?? config.label,
    mode: (readString(input.mode) as BrokerServiceMode | undefined) ?? config.mode,
    launchAgentPath: readString(input.launchAgentPath) ?? config.launchAgentPath,
    bootoutCommand: readString(input.bootoutCommand) ?? bootoutCommand(config),
    brokerUrl: readString(input.brokerUrl) ?? config.brokerUrl,
    brokerSocketPath: readString(input.brokerSocketPath) ?? config.brokerSocketPath,
    supportDirectory: readString(input.supportDirectory) ?? config.supportDirectory,
    runtimeDirectory: readString(input.runtimeDirectory) ?? config.runtimeDirectory,
    controlHome: readString(input.controlHome) ?? config.controlHome,
    stdoutLogPath,
    stderrLogPath,
    installed,
    loaded,
    pid: readNumber(input.pid) ?? null,
    launchdState: readString(input.launchdState) ?? null,
    lastExitStatus: readNumber(input.lastExitStatus) ?? null,
    usesLaunchAgent: readBoolean(input.usesLaunchAgent) ?? (installed || loaded),
    reachable: healthReachable,
    serviceAdapter: "macos-scoutd",
    health: {
      reachable: healthReachable,
      ok: healthOk,
      checkedAt: readNumber(healthRecord.checkedAt) ?? Date.now(),
      state: readString(healthRecord.state),
      durationMs: readNumber(healthRecord.durationMs),
      transport: healthTransport,
      socketPath: config.brokerSocketPath,
      ...(healthSocketFallbackError ? { socketFallbackError: healthSocketFallbackError } : {}),
      ...(healthNodeId ? { nodeId: healthNodeId } : {}),
      ...(healthMeshId ? { meshId: healthMeshId } : {}),
      ...(healthCounts ? { counts: healthCounts } : {}),
      ...(isRecord(healthRecord.build)
        ? { build: healthRecord.build as ScoutBrokerBuildIdentity }
        : {}),
      services: readNativeChildServices(healthRecord),
      storage: readNativeStorageStatus(healthRecord),
      error: healthError,
    },
    ...(runtimeFreshness
      ? { runtimeFreshness }
      : {}),
    lastLogLine,
  };
}

/** Cap on combined stdout/stderr captured from scoutd. */
const SCOUTD_MAX_BUFFER = 2 * 1024 * 1024;
/**
 * Default timeout for a scoutd service command. scoutd's `start` waits up to
 * 15s internally and `stop` up to 20s; 45s sits comfortably above both so we
 * only fire on a genuinely wedged process.
 */
const SCOUTD_DEFAULT_TIMEOUT_MS = 45_000;
/** Grace period between SIGTERM and SIGKILL when terminating a wedged scoutd. */
const SCOUTD_KILL_GRACE_MS = 250;

/**
 * Run `scoutd <command> --json` and return its parsed stdout. Uses an async
 * `spawn` (not `spawnSync`) so a wedged scoutd can never block the host event
 * loop: output is bounded by {@link SCOUTD_MAX_BUFFER}, and the call is bounded
 * by `timeoutMs` with SIGTERM→SIGKILL escalation on timeout.
 */
function spawnScoutdJson(
  scoutdPath: string,
  command: BrokerServiceCommand,
  env: RuntimeEnv,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(scoutdPath, [command, "--json"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      terminate();
      fail(new Error(`scoutd ${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    killTimer.unref?.();

    function terminate(): void {
      child.kill("SIGTERM");
      const hardKillTimer = setTimeout(() => child.kill("SIGKILL"), SCOUTD_KILL_GRACE_MS);
      hardKillTimer.unref?.();
    }

    function cleanup(): void {
      clearTimeout(killTimer);
    }

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    function succeed(output: string): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(output);
    }

    function append(kind: "stdout" | "stderr", chunk: unknown): void {
      const text = typeof chunk === "string" ? chunk : String(chunk);
      if (kind === "stdout") stdout += text;
      else stderr += text;
      if (stdout.length + stderr.length > SCOUTD_MAX_BUFFER) {
        terminate();
        fail(new Error(`scoutd ${command} exceeded output limit`));
      }
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) => fail(new Error(`scoutd ${command} failed: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (settled || timedOut) return;
      const trimmedStdout = stdout.trim();
      const trimmedStderr = stderr.trim();
      if ((code ?? 1) !== 0) {
        const detail = trimmedStderr || trimmedStdout || `exit ${signal ?? code ?? "unknown status"}`;
        fail(new Error(`scoutd ${command} failed: ${detail}`));
        return;
      }
      succeed(trimmedStdout);
    });
  });
}

type ScoutdJsonRunner = (
  scoutdPath: string,
  command: BrokerServiceCommand,
  env: RuntimeEnv,
  timeoutMs: number,
) => Promise<string>;

const SCHEMA_GUARDED_SERVICE_COMMANDS = new Set<BrokerServiceCommand>([
  "install",
  "start",
  "restart",
]);

export function assertBrokerServiceSchemaCompatible(config: BrokerServiceConfig): void {
  const databasePath = join(config.controlHome, "control-plane.sqlite");
  if (!existsSync(databasePath)) return;

  const database = openControlPlaneSqliteDatabase(databasePath, { readonly: true });
  try {
    const row = database.query<{ user_version: number }>("PRAGMA user_version").get();
    const databaseVersion = row?.user_version ?? 0;
    if (databaseVersion > CONTROL_PLANE_SCHEMA_VERSION) {
      throw new Error(
        `Refusing to change the Scout service: candidate runtime schema v${CONTROL_PLANE_SCHEMA_VERSION} ` +
          `is older than control-plane database schema v${databaseVersion}. ` +
          "The existing service was left untouched. Update or rebase this checkout before restarting Scout.",
      );
    }
  } finally {
    database.close?.();
  }
}

export async function runScoutdServiceCommand(
  command: BrokerServiceCommand,
  config: BrokerServiceConfig,
  timeoutMs: number = SCOUTD_DEFAULT_TIMEOUT_MS,
  runScoutdJson: ScoutdJsonRunner = spawnScoutdJson,
): Promise<BrokerServiceStatus> {
  if (SCHEMA_GUARDED_SERVICE_COMMANDS.has(command)) {
    assertBrokerServiceSchemaCompatible(config);
  }

  const scoutd = resolveScoutdCommand(config);
  if (!scoutd) {
    if (process.platform !== "darwin") {
      throw new Error(nativeSupervisorNotApplicableDetail());
    }
    throw new Error(
      "Unable to locate scoutd for broker service management. Build scoutd with `npm run scoutd:build`, install a package that includes scoutd, or set OPENSCOUT_SCOUTD_BIN.",
    );
  }

  const stdout = await runScoutdJson(
    scoutd.path,
    command,
    nativeServiceEnvironment(config, scoutd.path),
    timeoutMs,
  );

  let parsed: NativeServiceStatus;
  try {
    parsed = JSON.parse(stdout) as NativeServiceStatus;
  } catch {
    throw new Error(`scoutd ${command} returned non-JSON stdout: ${stdout.slice(0, 400)}`);
  }
  return normalizeNativeServiceStatus(parsed, config);
}

function readCoreAgentsSync(): string[] {
  try {
    const settingsPath = resolveOpenScoutSupportPaths().settingsPath;
    const raw = readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(raw) as { agents?: { coreAgents?: unknown } };
    const raw_agents = settings?.agents?.coreAgents;
    if (Array.isArray(raw_agents)) {
      return raw_agents.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    }
  } catch {
    // settings.json missing or malformed — no core agents
  }
  return [];
}

function bootoutCommand(config: BrokerServiceConfig): string {
  return `/bin/launchctl bootout ${config.serviceTarget}`;
}

function readLogLines(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function isPackageScriptBanner(line: string): boolean {
  return /^\$\s*(bun run|npm run|pnpm\b|yarn\b)/.test(line);
}

export function selectLastRelevantLogLine(lines: string[]): string | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!isPackageScriptBanner(line)) {
      return line;
    }
  }
  return lines.at(-1) ?? null;
}

function readLastLogLine(paths: string[]): string | null {
  let fallback: string | null = null;

  for (const path of paths) {
    const lines = readLogLines(path);
    if (lines.length === 0) {
      continue;
    }

    const relevantLine = selectLastRelevantLogLine(lines);
    if (!relevantLine) {
      continue;
    }
    if (!isPackageScriptBanner(relevantLine)) {
      return relevantLine;
    }
    fallback ??= relevantLine;
  }

  return fallback;
}

async function readHeadlessBrokerHealth(
  config: BrokerServiceConfig,
): Promise<{
  health: ScoutBrokerHealthPayload;
  trace: ScoutBrokerJsonRequestTrace;
}> {
  const result = await requestScoutBrokerJsonWithTrace<ScoutBrokerHealthPayload>(
    config.brokerUrl,
    "/health",
    { socketPath: config.brokerSocketPath },
  );
  return {
    health: result.value,
    trace: result.trace,
  };
}

function headlessLifecycleError(command: BrokerServiceCommand): Error {
  return new Error(
    `Next step: run \`openscout-runtime broker\` in this shell or under your process manager. `
    + `The headless service adapter leaves broker ${command} to that foreground process.`,
  );
}

export async function runHeadlessForegroundServiceCommand(
  command: BrokerServiceCommand,
  config: BrokerServiceConfig,
  readHealth: HeadlessBrokerHealthReader = readHeadlessBrokerHealth,
): Promise<BrokerServiceStatus> {
  if (command !== "status") {
    throw headlessLifecycleError(command);
  }

  const checkedAt = Date.now();
  try {
    const { health, trace } = await readHealth(config);
    const reachable = true;
    return {
      serviceAdapter: "headless-foreground",
      label: config.label,
      mode: config.mode,
      launchAgentPath: config.launchAgentPath,
      bootoutCommand: "headless-foreground does not use launchd",
      brokerUrl: config.brokerUrl,
      brokerSocketPath: config.brokerSocketPath,
      supportDirectory: config.supportDirectory,
      runtimeDirectory: config.runtimeDirectory,
      controlHome: config.controlHome,
      stdoutLogPath: config.stdoutLogPath,
      stderrLogPath: config.stderrLogPath,
      installed: false,
      loaded: reachable,
      pid: null,
      launchdState: null,
      lastExitStatus: null,
      usesLaunchAgent: false,
      reachable,
      health: {
        reachable,
        ok: Boolean(health.ok),
        checkedAt,
        transport: trace.transport,
        socketPath: trace.socketPath,
        socketFallbackError: trace.socketFallbackError,
        nodeId: health.nodeId ?? undefined,
        meshId: health.meshId ?? undefined,
        counts: health.counts ?? undefined,
        build: health.build,
        services: health.services,
        storage: health.storage,
      },
      lastLogLine: readLastLogLine([config.stderrLogPath, config.stdoutLogPath]),
    };
  } catch (error) {
    return {
      serviceAdapter: "headless-foreground",
      label: config.label,
      mode: config.mode,
      launchAgentPath: config.launchAgentPath,
      bootoutCommand: "headless-foreground does not use launchd",
      brokerUrl: config.brokerUrl,
      brokerSocketPath: config.brokerSocketPath,
      supportDirectory: config.supportDirectory,
      runtimeDirectory: config.runtimeDirectory,
      controlHome: config.controlHome,
      stdoutLogPath: config.stdoutLogPath,
      stderrLogPath: config.stderrLogPath,
      installed: false,
      loaded: false,
      pid: null,
      launchdState: null,
      lastExitStatus: null,
      usesLaunchAgent: false,
      reachable: false,
      health: {
        reachable: false,
        ok: false,
        checkedAt,
        error: error instanceof Error ? error.message : String(error),
      },
      lastLogLine: readLastLogLine([config.stderrLogPath, config.stdoutLogPath]),
    };
  }
}

export type SystemdUserServiceDeps = {
  systemctl?: SystemctlRunner;
  healthTimeoutMs?: number;
  lingerWarning?: () => string | null;
  readHealth?: HeadlessBrokerHealthReader;
  env?: RuntimeEnv;
  home?: string;
  bunGlobalBinDirectory?: string | null;
};

/** Render the broker's systemd --user unit (path + contents) for this process's instance. */
export function renderBrokerSystemdUserUnit(
  config: BrokerServiceConfig = resolveBrokerServiceConfig(),
  deps: Pick<SystemdUserServiceDeps, "env" | "home" | "bunGlobalBinDirectory"> = {},
): { unitName: string; unitPath: string; contents: string } {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const persistent = persistentBrokerServiceConfig(config);
  const baseSpec = buildSystemdUserUnitSpec({
    env,
    home,
    runtimePackageDir: persistent.runtimePackageDir,
    bunExecutable: persistent.bunExecutable,
    bunGlobalBinDirectory: deps.bunGlobalBinDirectory,
  });
  const unitPath = join(systemdUserUnitDirectory(env, home), baseSpec.unitName);
  // Keep Environment= lines the operator added to an existing unit.
  const spec = withOperatorUnitEnvironment(baseSpec, unitPath);
  return {
    unitName: spec.unitName,
    unitPath,
    contents: renderSystemdUserUnit(spec, home),
  };
}

export async function runSystemdUserServiceCommand(
  command: BrokerServiceCommand,
  config: BrokerServiceConfig,
  deps: SystemdUserServiceDeps = {},
): Promise<BrokerServiceStatus> {
  const env = deps.env ?? process.env;
  const systemctl = deps.systemctl ?? runSystemctlUser;
  const rendered = renderBrokerSystemdUserUnit(config, deps);
  const { unitName, unitPath } = rendered;

  if (command !== "status") {
    // A non-prod instance must never install, start, stop or remove prod's
    // unit, nor run on prod's ports or directories.
    assertOpenScoutInstanceIsolation(`the ${unitName} service`, {
      env,
      home: deps.home,
      extraPorts: [{ label: "broker port", port: config.brokerPort }],
      extraPaths: [
        { label: "support directory", value: config.supportDirectory },
        { label: "control home", value: config.controlHome },
        { label: "broker socket", value: config.brokerSocketPath },
      ],
    });
  }

  if (SCHEMA_GUARDED_SERVICE_COMMANDS.has(command)) {
    assertBrokerServiceSchemaCompatible(config);
  }

  const install = (): "written" | "unchanged" => {
    const outcome = writeSystemdUserUnit(unitPath, rendered.contents, env);
    if (outcome === "written") {
      assertSystemctlOk(systemctl(["daemon-reload"]), "daemon-reload");
    }
    assertSystemctlOk(systemctl(["enable", unitName]), `enable ${unitName}`);
    return outcome;
  };
  const isActive = () => {
    const active = readSystemdUserUnitState(unitName, systemctl).activeState;
    return active === "active" || active === "activating" || active === "reloading";
  };

  switch (command) {
    case "install":
      install();
      break;
    case "start": {
      // A running unit whose definition just changed must restart to pick it up.
      const outcome = install();
      const verb = outcome === "written" && isActive() ? "restart" : "start";
      assertSystemctlOk(systemctl([verb, unitName]), `${verb} ${unitName}`);
      break;
    }
    case "restart":
      install();
      assertSystemctlOk(systemctl(["restart", unitName]), `restart ${unitName}`);
      break;
    case "stop":
      assertSystemdUnitOwnership(unitPath, rendered.contents, env, "stop");
      assertSystemctlOk(systemctl(["stop", unitName]), `stop ${unitName}`);
      break;
    case "uninstall":
      assertSystemdUnitOwnership(unitPath, rendered.contents, env, "uninstall");
      systemctl(["stop", unitName]);
      systemctl(["disable", unitName]);
      if (removeSystemdUserUnit(unitPath)) {
        assertSystemctlOk(systemctl(["daemon-reload"]), "daemon-reload");
      }
      break;
    case "status":
      break;
  }

  if (command === "start" || command === "restart") {
    const healthy = await waitForSystemdBrokerHealth(
      config,
      deps.readHealth ?? readHeadlessBrokerHealth,
      deps.healthTimeoutMs,
    );
    if (!healthy) {
      // A crash-looping unit must not report "started".
      const failed = readSystemdUserUnitState(unitName, systemctl);
      throw new Error(
        `${unitName} did not become healthy on ${config.brokerUrl} `
          + `(state ${[failed.activeState, failed.subState].filter(Boolean).join("/") || "unknown"}`
          + `${failed.execMainStatus !== null ? `, last exit ${failed.execMainStatus}` : ""}). `
          + `See \`journalctl --user -u ${unitName} -n 50\`.`,
      );
    }
  }

  const state = readSystemdUserUnitState(unitName, systemctl);
  const headless = await runHeadlessForegroundServiceCommand("status", config, deps.readHealth);
  const installed = existsSync(unitPath);
  const lingerWarning = installed
    ? (deps.lingerWarning ? deps.lingerWarning() : systemdUserLingerWarning(undefined, env))
    : null;
  return {
    ...headless,
    ...(lingerWarning ? { warnings: [lingerWarning] } : {}),
    serviceAdapter: "linux-systemd-user",
    instance: resolveOpenScoutInstanceName(env),
    launchAgentPath: unitPath,
    bootoutCommand: `systemctl --user stop ${unitName}`,
    installed,
    loaded: state.activeState === "active" || state.activeState === "activating" || state.activeState === "reloading",
    pid: state.mainPid,
    launchdState: [state.activeState, state.subState].filter(Boolean).join("/") || null,
    lastExitStatus: state.execMainStatus,
    usesLaunchAgent: installed,
  };
}

async function waitForSystemdBrokerHealth(
  config: BrokerServiceConfig,
  readHealth: HeadlessBrokerHealthReader,
  timeoutMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { health } = await readHealth(config);
      if (health.ok) return true;
    } catch {
      // still starting
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }
  return false;
}

async function runBrokerServiceCommand(
  command: BrokerServiceCommand,
  config: BrokerServiceConfig,
): Promise<BrokerServiceStatus> {
  const status = await runBrokerServiceAdapterCommand(command, config);
  return { ...status, instance: status.instance ?? resolveOpenScoutInstanceName() };
}

async function runBrokerServiceAdapterCommand(
  command: BrokerServiceCommand,
  config: BrokerServiceConfig,
): Promise<BrokerServiceStatus> {
  const adapter = resolveBrokerServiceAdapter();
  switch (adapter) {
    case "macos-scoutd":
      return await runScoutdServiceCommand(command, config);
    case "headless-foreground":
      return await runHeadlessForegroundServiceCommand(command, config);
    case "linux-systemd-user":
      return await runSystemdUserServiceCommand(command, config);
    case "windows-service":
      throw new Error(
        "The windows-service adapter is not implemented yet. "
        + "Use OPENSCOUT_SERVICE_ADAPTER=headless-foreground and run `openscout-runtime broker` from a shell.",
      );
  }
}

export async function brokerServiceStatus(config: BrokerServiceConfig = resolveBrokerServiceConfig()): Promise<BrokerServiceStatus> {
  return runBrokerServiceCommand("status", config);
}

export async function installBrokerService(config: BrokerServiceConfig = resolveBrokerServiceConfig()): Promise<BrokerServiceStatus> {
  return runBrokerServiceCommand("install", config);
}

export async function startBrokerService(config: BrokerServiceConfig = resolveBrokerServiceConfig()): Promise<BrokerServiceStatus> {
  return runBrokerServiceCommand("start", config);
}

export async function stopBrokerService(config: BrokerServiceConfig = resolveBrokerServiceConfig()): Promise<BrokerServiceStatus> {
  return runBrokerServiceCommand("stop", config);
}

export async function restartBrokerService(config: BrokerServiceConfig = resolveBrokerServiceConfig()): Promise<BrokerServiceStatus> {
  return runBrokerServiceCommand("restart", config);
}

export async function uninstallBrokerService(config: BrokerServiceConfig = resolveBrokerServiceConfig()): Promise<BrokerServiceStatus> {
  return runBrokerServiceCommand("uninstall", config);
}

async function main() {
  applyOpenScoutInstanceEnvironment(process.env);
  const command = (process.argv[2] ?? "status") as BrokerServiceCommand | string;

  const json = process.argv.includes("--json");
  const config = resolveBrokerServiceConfig();

  let status: BrokerServiceStatus;
  switch (command) {
    case "install":
      status = await installBrokerService(config);
      break;
    case "start":
      status = await startBrokerService(config);
      break;
    case "stop":
      status = await stopBrokerService(config);
      break;
    case "restart":
      status = await restartBrokerService(config);
      break;
    case "uninstall":
      status = await uninstallBrokerService(config);
      break;
    case "status":
      status = await brokerServiceStatus(config);
      break;
    default:
      console.error(`Unknown broker service command: ${command}`);
      process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  console.log(formatBrokerServiceStatus(status));
}

function formatBrokerServiceStatus(status: BrokerServiceStatus): string {
  const lines = [
    `instance: ${status.instance ?? resolveOpenScoutInstanceName()}`,
    `service adapter: ${status.serviceAdapter ?? "unknown"}`,
    `label: ${status.label}`,
    `mode: ${status.mode}`,
    `launch agent: ${status.installed ? status.launchAgentPath : "not installed"}`,
    `bootout: ${status.bootoutCommand}`,
    `loaded: ${status.loaded ? "yes" : "no"}`,
    `pid: ${status.pid ?? "—"}`,
    `launchd state: ${status.launchdState ?? "—"}`,
    `broker url: ${status.brokerUrl}`,
    `broker socket: ${status.brokerSocketPath}`,
    `reachable: ${status.reachable ? "yes" : "no"}`,
    `health: ${status.health.ok ? "ok" : status.health.error ?? "unreachable"}`,
    `health transport: ${status.health.transport ?? "unknown"}`,
    `runtime freshness: ${status.runtimeFreshness?.state ?? "unavailable"}`,
    `logs: ${status.stdoutLogPath}`,
  ];

  if (status.runtimeFreshness) {
    lines.push(`runtime freshness detail: ${status.runtimeFreshness.detail}`);
    if (status.runtimeFreshness.reasonCode) {
      lines.push(`runtime freshness reason: ${status.runtimeFreshness.reasonCode}`);
    }
  }

  if (status.health.socketFallbackError) {
    lines.push(`socket fallback: ${status.health.socketFallbackError}`);
  }

  const journalWrites = status.health.storage?.journal;
  if (journalWrites?.state === "failing") {
    lines.push(`journal writes: failing ×${journalWrites.failures} since ${new Date(journalWrites.since).toISOString()} (${journalWrites.code ?? journalWrites.error})`);
  }

  if (status.lastLogLine) {
    lines.push(`last log: ${status.lastLogLine}`);
  }
  for (const warning of status.warnings ?? []) {
    lines.push(`warning: ${warning}`);
  }

  return lines.join("\n");
}

export function isBrokerServiceEntrypoint(moduleUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  const modulePath = fileURLToPath(moduleUrl);
  // Bundling collapses imported modules' URLs to the containing entry. A broker
  // or CLI bundle must not auto-run this imported service-management command.
  return modulePath === argvEntry
    && ["broker-process-manager.ts", "broker-process-manager.js", "broker-process-manager.mjs"]
      .includes(basename(modulePath));
}

if (isBrokerServiceEntrypoint(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
