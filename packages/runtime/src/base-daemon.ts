// Must stay the first import: materializes OPENSCOUT_INSTANCE before any module reads paths/ports.
import { openScoutInstanceBootstrap } from "./instance-bootstrap.js";
import { createRoomListeningSupervisor } from "./room-listening-supervisor.js";
import type { RuntimeErrnoError } from "./portable-types.js";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync, statSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildLocalBrokerControlUrl,
  resolveBrokerServiceConfig,
  type BrokerServiceConfig,
} from "./broker-process-manager.js";
import {
  claimScoutPairingSupervision,
  isScoutPairingProcessRunning,
  readScoutPairingProcessPid,
  readScoutPairingSupervisorIntent,
  releaseScoutPairingSupervision,
  resolveScoutPairingSupervisorPaths,
  updateScoutPairingSupervisorIntent,
} from "./pairing-supervisor.js";
import {
  resolveBunExecutable,
  resolveOpenScoutRepoRoot,
} from "./tool-resolution.js";
import {
  DEFAULT_SCOUT_WEB_PORTAL_HOST,
  loadLocalConfig,
  resolveConfiguredScoutWebHostname,
  resolveScoutWebNamedHostname,
  resolveWebPort,
} from "./local-config.js";
import {
  renderOpenScoutCaddyfile,
  resolveOpenScoutLocalEdgeConfig,
  buildOpenScoutLocalEdgeMdnsCommands,
  resolveOpenScoutLocalEdgeAdvertisements,
  createLocalEdgeAdvertisementOwner,
  shouldStartOpenScoutLocalEdge,
  type OpenScoutLocalEdgeConfig,
  type OpenScoutLocalEdgeScheme,
} from "./local-edge.js";
import { resolveScoutLanNetworks } from "./lan-network.js";
import {
  NatsJetStreamSidecar,
  resolveJetStreamConfig,
  type JetStreamRuntimeConfig,
} from "./jetstream/index.js";
import {
  MESH_BRIDGE_EXIT_UNCONFIGURED,
  findRecordedLiveMeshBridgePid,
  inspectLaunchdJob,
  legacyMeshBridgeLaunchdTarget,
  meshBridgeArgs,
  meshBridgeStatePath,
  readProcessIdentity,
  resolveMeshBridgeDesiredState,
  resolveMeshBridgeEntrypoint,
  type MeshBridgeDesiredState,
} from "./mesh-bridge-supervisor.js";
import { openScoutNetworkServiceEnvironment } from "./open-scout-network.js";
import { readTailscaleSelfWebHostsSync } from "./tailscale.js";
import { resolveOpenScoutLocalEdgeDirectory } from "./support-paths.js";
import { selectInstanceAwareEntrypoint } from "./instance.js";

const RESTART_MIN_DELAY_MS = 1_000;
const RESTART_MAX_DELAY_MS = 30_000;
const BROKER_HEALTH_TIMEOUT_MS = 30_000;
const BROKER_HEALTH_POLL_MS = 250;
// Broker owns web shutdown and allows the web server 10s to drain. Base must
// give that child boundary enough room, while still finishing below scoutd's
// 18s outer child timeout.
const CHILD_SHUTDOWN_TIMEOUT_MS = 15_000;
const WEB_START_RETRY_MS = 5_000;
const PAIRING_RECONCILE_INTERVAL_MS = 500;
const PAIRING_STOP_TIMEOUT_MS = 5_000;
const MESH_BRIDGE_RECONCILE_INTERVAL_MS = 5_000;
const MESH_BRIDGE_STOP_TIMEOUT_MS = 6_000;
// An unconfigured bridge (no relay token) is not a crash; retry rarely.
const MESH_BRIDGE_UNCONFIGURED_RETRY_MS = 5 * 60_000;
// Backoff resets only after the bridge has stayed up this long, so a bridge
// that crashes every few seconds keeps backing off.
const MESH_BRIDGE_STABLE_AFTER_MS = 60_000;
const MENU_BUNDLE_ID = "app.openscout.scout.menu";
const PROCESS_NAME = "scout-base";
// openscout-runtime.mjs runs broker-daemon in-process (no second bun child),
// so the process spawned here IS the broker; name it accordingly for ps/doctor.
const BROKER_PROCESS_NAME = "scout-broker";
const EDGE_PROCESS_NAME = "scout-edge";
const MDNS_PROCESS_NAME = "scout-mdns";

process.title = PROCESS_NAME;

let shuttingDown = false;
let brokerProcess: ChildProcess | null = null;
let caddyProcess: ChildProcess | null = null;
let edgeLanWatchTimer: ReturnType<typeof setInterval> | null = null;
let edgeLanOnly = false;
const edgeAdvertisements = createLocalEdgeAdvertisementOwner({
  start: ({ host, address }, scheme) => spawnMdnsProxy({
    name: `Scout ${host} ${scheme.toUpperCase()}`,
    host, address, scheme, port: scheme === "https" ? 443 : 80,
  }),
  stop: (children: ChildProcess[]) => { for (const child of children) if (!child.killed) child.kill("SIGTERM"); },
});
let brokerRestartDelayMs = RESTART_MIN_DELAY_MS;
let edgeRestartDelayMs = RESTART_MIN_DELAY_MS;
let baseKeepAlive: ReturnType<typeof setInterval> | null = null;
let webStartRetryTimer: ReturnType<typeof setTimeout> | null = null;
let webStartInFlight = false;
let parentWatcher: ReturnType<typeof setInterval> | null = null;
let pairingProcess: ChildProcess | null = null;
let pairingReconcileTimer: NodeJS.Timeout | null = null;
let pairingReconcileInFlight = false;
let pairingRestartGeneration: number | null = null;
let pairingRestartDelayMs = RESTART_MIN_DELAY_MS;
let pairingNextStartAt = 0;
let pairingSupervisionClaimed = false;
let meshBridgeProcess: ChildProcess | null = null;
let meshBridgeConfigMtimeMs = 0;
let meshBridgeRestartDelayMs = RESTART_MIN_DELAY_MS;
let meshBridgeNextStartAt = 0;
let meshBridgeReconcileTimer: NodeJS.Timeout | null = null;
let meshBridgeLastIdleReason: string | null = null;
let meshBridgeReconcileInFlight = false;
let meshBridgeStartedAt = 0;
/** Config mtime when the bridge last exited unconfigured; a change lifts the cooldown. */
let meshBridgeUnconfiguredMtimeMs: number | null = null;

const parentPid = Number.parseInt(process.env.OPENSCOUT_PARENT_PID ?? "0", 10);

const config = resolveBrokerServiceConfig();
const brokerControlUrl = buildLocalBrokerControlUrl(config.brokerHost, config.brokerPort);

const pairingPaths = resolveScoutPairingSupervisorPaths();
function log(message: string, details?: unknown): void {
  if (details === undefined) {
    console.log(`[openscout-base] ${message}`);
    return;
  }
  console.log(`[openscout-base] ${message}`, details);
}

function warn(message: string, details?: unknown): void {
  if (details === undefined) {
    console.warn(`[openscout-base] ${message}`);
    return;
  }
  console.warn(`[openscout-base] ${message}`, details);
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function appendCsvValues(input: string | undefined, values: string[]): string | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [...splitCsv(input), ...values]) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out.length > 0 ? out.join(",") : undefined;
}

function resolveTailnetWebHosts(): string[] {
  return readTailscaleSelfWebHostsSync();
}

/**
 * This machine's own non-loopback addresses, so the local edge answers for a
 * bare LAN address (http://192.168.1.20) the way it already answers for the
 * tailnet ones. Routing only — reaching the web server still depends on the LAN
 * access scope, and every /api route still requires a credential. Opt out with
 * OPENSCOUT_WEB_TRUST_LAN_ADDRESSES=0.
 */
function resolveLanWebHosts(): string[] {
  if (process.env.OPENSCOUT_WEB_TRUST_LAN_ADDRESSES?.trim() === "0") {
    return [];
  }
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal)
    .map((entry) => entry.address)
    // IPv6 link-local carries a zone id (fe80::1%en0) that never appears in a URL host.
    .filter((address) => !address.toLowerCase().startsWith("fe80:"));
}

function resolveWebTrustedHostsEnv(): string | undefined {
  return appendCsvValues(process.env.OPENSCOUT_WEB_TRUSTED_HOSTS, resolveTailnetWebHosts());
}

let jetStreamSidecar: NatsJetStreamSidecar | null = null;
/**
 * Env the broker child needs so the two never disagree about the sidecar.
 *
 * Populated only once the base sidecar has actually resolved, because the
 * answer differs between "base owns it" and "base tried and failed".
 */
let jetStreamBrokerEnv: Record<string, string> = {};

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
}

function logFile(name: string): number {
  const dir = join(config.supportDirectory, "logs", "base");
  ensureDirectory(dir);
  return openSync(join(dir, name), "a");
}

function runtimeEntrypoint(config: BrokerServiceConfig): string {
  return join(config.runtimePackageDir, "bin", "openscout-runtime.mjs");
}

function spawnBroker(): void {
  if (shuttingDown || brokerProcess) {
    return;
  }
  if (!config.bunExecutable) {
    warn("broker supervisor cannot start broker without Bun", {
      hint: "Use the headless broker entrypoint under Node or install Bun for the macOS base supervisor.",
    });
    scheduleBrokerRestart();
    return;
  }

  const webTrustedHostsEnv = resolveWebTrustedHostsEnv();
  const stdout = logFile("broker.stdout.log");
  const stderr = logFile("broker.stderr.log");
  brokerProcess = spawn(config.bunExecutable, [
    "run",
    runtimeEntrypoint(config),
    "broker",
  ], {
    argv0: BROKER_PROCESS_NAME,
    cwd: config.runtimePackageDir,
    env: {
      ...process.env,
      OPENSCOUT_PARENT_PID: String(process.pid),
      OPENSCOUT_BROKER_HOST: config.brokerHost,
      OPENSCOUT_BROKER_PORT: String(config.brokerPort),
      OPENSCOUT_BROKER_URL: config.brokerUrl,
      OPENSCOUT_BROKER_SOCKET_PATH: config.brokerSocketPath,
      OPENSCOUT_CONTROL_HOME: config.controlHome,
      OPENSCOUT_ADVERTISE_SCOPE: config.advertiseScope,
      ...openScoutNetworkServiceEnvironment(process.env),
      ...jetStreamBrokerEnv,
      ...(webTrustedHostsEnv ? { OPENSCOUT_WEB_TRUSTED_HOSTS: webTrustedHostsEnv } : {}),
    },
    stdio: ["ignore", stdout, stderr],
  });

  log("broker started", { pid: brokerProcess.pid, url: config.brokerUrl });
  brokerProcess.once("exit", (code, signal) => {
    log("broker exited", { code, signal });
    brokerProcess = null;
    if (!shuttingDown) {
      scheduleBrokerRestart();
    }
  });
}

// A sibling base child: broker restarts do not cycle room accumulation.
const roomListeningSupervisor = createRoomListeningSupervisor({
  runtimeRevision: () => [runtimeEntrypoint(config), join(config.runtimePackageDir, "package.json"),
    join(config.runtimePackageDir, "dist/room-listening-daemon.js"), join(config.runtimePackageDir, "src/room-listening-daemon.ts")]
    .map(path => { try { const stat = statSync(path); return `${path}:${stat.ino}:${stat.size}:${stat.mtimeMs}`; } catch { return `${path}:missing`; } }).join("|"),
  statusChanged: status => {
    // Local supervisor state, not a broker-owned coordination record.
    try { writeFileSync(join(config.controlHome, "room-listening-status.json"), JSON.stringify({ ...status, updatedAt: Date.now() }) + "\n"); }
    catch (error) { warn("could not persist room listening status", error); }
  },
  spawn: () => {
    if (!config.bunExecutable) throw new Error("Bun is required for room listening");
    const stdout = logFile("room-listening.stdout.log"), stderr = logFile("room-listening.stderr.log");
    try {
      return spawn(config.bunExecutable, ["run", runtimeEntrypoint(config), "listening"], {
        argv0: "scout-listening", cwd: config.runtimePackageDir,
        env: { ...process.env, OPENSCOUT_PARENT_PID: String(process.pid),
          OPENSCOUT_CONTROL_HOME: config.controlHome, OPENSCOUT_BROKER_URL: brokerControlUrl },
        stdio: ["ignore", stdout, stderr],
      });
    } finally { closeSync(stdout); closeSync(stderr); }
  },
  terminate: child => terminateChildProcess(child, "room listening"),
  warn: message => warn(message),
});

function scheduleBrokerRestart(): void {
  const delay = brokerRestartDelayMs;
  brokerRestartDelayMs = Math.min(brokerRestartDelayMs * 2, RESTART_MAX_DELAY_MS);
  setTimeout(() => {
    if (!shuttingDown) {
      spawnBroker();
      void startWebWhenBrokerIsReady();
    }
  }, delay).unref();
}

async function waitForBrokerHealth(timeoutMs = BROKER_HEALTH_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/health", brokerControlUrl), {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const body = await response.json() as { ok?: boolean };
        if (body.ok === true) {
          brokerRestartDelayMs = RESTART_MIN_DELAY_MS;
          return true;
        }
      }
    } catch {
      // Broker is still starting.
    }
    await sleep(BROKER_HEALTH_POLL_MS);
  }
  return false;
}

function resolveEdgeScheme(): OpenScoutLocalEdgeScheme {
  const value = process.env.OPENSCOUT_WEB_EDGE_SCHEME?.trim().toLowerCase();
  if (value === "http" || value === "https" || value === "both") {
    return value;
  }
  // Serve https beside http: browsers only hand the microphone (live voice)
  // to a secure page, and a named .local host over http is not one.
  return "both";
}

// "both" keeps advertising http so existing links and paired devices that do
// not trust the local CA keep working; https is an extra door, not the default.
function forwardedProtoForEdgeScheme(scheme: OpenScoutLocalEdgeScheme): "http" | "https" {
  return scheme === "https" ? "https" : "http";
}

function resolveEdgeConfig(): OpenScoutLocalEdgeConfig {
  const lanOnly = loadLocalConfig().webLanOnly === true;
  const portalHost = process.env.OPENSCOUT_WEB_PORTAL_HOST?.trim() || DEFAULT_SCOUT_WEB_PORTAL_HOST;
  const nodeHost = process.env.OPENSCOUT_WEB_ADVERTISED_HOST?.trim()
    || (process.env.OPENSCOUT_WEB_LOCAL_NAME?.trim()
      ? resolveScoutWebNamedHostname(process.env.OPENSCOUT_WEB_LOCAL_NAME)
      : resolveConfiguredScoutWebHostname());
  return resolveOpenScoutLocalEdgeConfig({
    lanOnly,
    portalHost,
    nodeHost,
    scheme: lanOnly ? "both" : resolveEdgeScheme(),
    brokerPort: config.brokerPort,
    webPort: Number.parseInt(process.env.OPENSCOUT_WEB_PORT ?? "", 10) || resolveWebPort(),
    viteDevUrl: process.env.OPENSCOUT_WEB_VITE_URL,
    viteHmrPath: process.env.OPENSCOUT_WEB_VITE_HMR_PATH,
    extraHosts: [
      ...splitCsv(process.env.OPENSCOUT_WEB_TRUSTED_HOSTS),
      ...resolveTailnetWebHosts(),
      ...resolveLanWebHosts(),
    ],
  });
}

function resolveLocalEdgeCaddyfilePath(): string {
  const dir = resolveOpenScoutLocalEdgeDirectory();
  ensureDirectory(dir);
  return join(dir, "Caddyfile");
}

function resolveCaddyExecutable(): string {
  return process.env.OPENSCOUT_CADDY_BIN?.trim() || "caddy";
}

function spawnMdnsProxy(input: {
  name: string;
  host: string;
  port: number;
  scheme: "http" | "https";
  address: string;
}): ChildProcess[] {
  return buildOpenScoutLocalEdgeMdnsCommands(input).map(({ command, args }) => {
    const child = spawn(command, args, {
      argv0: MDNS_PROCESS_NAME,
      stdio: ["ignore", logFile("mdns.stdout.log"), logFile("mdns.stderr.log")],
    });
    // Discovery is best effort: a missing publisher must not take the edge down.
    child.once("error", (error) => {
      console.warn(`[local-edge] mDNS advertisement for ${input.host} failed: ${error.message}`);
    });
    return child;
  });
}

/**
 * Opt-in NATS JetStream sidecar, supervised beside the local edge.
 *
 * It sits here rather than in the broker because it is an external binary with
 * its own lifetime, and because a broker restart must not cycle the transport
 * underneath a web consumer that is also attached to it.
 */
async function startJetStreamSidecar(): Promise<void> {
  let jetStreamConfig: JetStreamRuntimeConfig;
  try {
    jetStreamConfig = resolveJetStreamConfig();
  } catch (error) {
    warn("jetstream configuration rejected; sidecar disabled", String(error));
    jetStreamBrokerEnv = { OPENSCOUT_JETSTREAM_ENABLED: "0" };
    return;
  }
  // Disabled, or an operator-managed server the broker attaches to on its own
  // terms. Either way base adds nothing and the child keeps the inherited env.
  if (!jetStreamConfig.enabled || !jetStreamConfig.manageServer) {
    return;
  }
  const sidecar = new NatsJetStreamSidecar({
    config: jetStreamConfig,
    log: (message, detail) => log(message, detail),
    warn: (message, detail) => warn(message, detail),
    error: (message, detail) => warn(message, detail),
  });
  jetStreamSidecar = sidecar;
  try {
    // A missing binary or an occupied port is terminal and actionable; it must
    // not become an invisible restart loop the way an ENOENT caddy would.
    await sidecar.start();
    // Base owns the process; the broker connects as a client instead of racing
    // it for the port.
    jetStreamBrokerEnv = { OPENSCOUT_JETSTREAM_MANAGE_SERVER: "0" };
    log("jetstream sidecar started", sidecar.status());
  } catch (error) {
    jetStreamSidecar = null;
    // Critically *not* MANAGE_SERVER=0. The usual reason a managed start fails
    // is that something else already holds the port, and telling the broker to
    // attach there would silently adopt a stranger's NATS server and create
    // SCOUT_EVENTS inside it. Attaching to a server OpenScout does not own is
    // an explicit operator decision, never a fallback. The feature stays off
    // for this run and the operator gets one actionable message.
    jetStreamBrokerEnv = { OPENSCOUT_JETSTREAM_ENABLED: "0" };
    warn(
      "jetstream sidecar unavailable; the broker will run with events disabled "
        + "rather than attach to a NATS server OpenScout does not manage",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function stopEdgeProcesses(): void {
  edgeAdvertisements.stop();
  if (caddyProcess && !caddyProcess.killed) {
    caddyProcess.kill("SIGTERM");
  }
  caddyProcess = null;
}

function startLocalEdge(): void {
  if (!shouldStartOpenScoutLocalEdge({
    isProd: openScoutInstanceBootstrap.layout.isProd,
    platform: process.platform,
    enabled: process.env.OPENSCOUT_BASE_EDGE_ENABLED,
  })) {
    return;
  }
  if (shuttingDown || caddyProcess) {
    return;
  }

  const edgeConfig = resolveEdgeConfig();
  const advertisements = resolveOpenScoutLocalEdgeAdvertisements(edgeConfig);
  edgeLanOnly = edgeConfig.lanOnly === true;
  const schemes = edgeConfig.scheme === "both" ? ["http", "https"] as const : [edgeConfig.scheme] as const;
  const caddyfilePath = resolveLocalEdgeCaddyfilePath();
  // Keep operator-owned routes across regenerated Scout configs. Other local
  // services must use separate upstream ports, not competing port-80 listeners.
  const sitesDirectory = join(dirname(caddyfilePath), "sites");
  ensureDirectory(sitesDirectory);
  writeFileSync(caddyfilePath, renderOpenScoutCaddyfile(edgeConfig, join(sitesDirectory, "*.caddy")), "utf8");

  edgeAdvertisements.update(advertisements, schemes);

  if (!edgeLanWatchTimer) {
    // DHCP and interface loss refresh only the owned mDNS children. Changing
    // the explicit mode also regenerates routes, once the old edge exits.
    edgeLanWatchTimer = setInterval(() => {
      if (shuttingDown || !caddyProcess) return;
      const current = resolveEdgeConfig();
      if ((current.lanOnly === true) !== edgeLanOnly) {
        edgeRestartDelayMs = RESTART_MIN_DELAY_MS;
        stopEdgeProcesses();
        return;
      }
      const currentSchemes = current.scheme === "both" ? ["http", "https"] as const : [current.scheme];
      edgeAdvertisements.update(resolveOpenScoutLocalEdgeAdvertisements(current, resolveScoutLanNetworks()), currentSchemes);
    }, 5_000);
    edgeLanWatchTimer.unref();
  }

  caddyProcess = spawn(resolveCaddyExecutable(), [
    "run",
    "--config",
    caddyfilePath,
    "--adapter",
    "caddyfile",
  ], {
    argv0: EDGE_PROCESS_NAME,
    env: process.env,
    stdio: ["ignore", logFile("edge.stdout.log"), logFile("edge.stderr.log")],
  });

  log("local edge started", {
    pid: caddyProcess.pid,
    portal: edgeConfig.portalHost,
    node: edgeConfig.nodeHost,
    caddyfile: caddyfilePath,
  });

  caddyProcess.once("error", (error: RuntimeErrnoError) => {
    stopEdgeProcesses();
    warn("local edge failed to start", error.message);
    scheduleEdgeRestart();
  });
  caddyProcess.once("exit", (code, signal) => {
    log("local edge exited", { code, signal });
    stopEdgeProcesses();
    if (!shuttingDown) {
      scheduleEdgeRestart();
    }
  });
}

function scheduleEdgeRestart(): void {
  const delay = edgeRestartDelayMs;
  edgeRestartDelayMs = Math.min(edgeRestartDelayMs * 2, RESTART_MAX_DELAY_MS);
  setTimeout(() => {
    if (!shuttingDown) {
      startLocalEdge();
    }
  }, delay).unref();
}

async function startWebWhenBrokerIsReady(): Promise<void> {
  if (process.env.OPENSCOUT_BASE_START_WEB === "0") {
    return;
  }
  if (webStartInFlight) {
    return;
  }
  webStartInFlight = true;
  try {
    if (!(await waitForBrokerHealth())) {
      warn("broker did not become healthy before web startup timeout");
      scheduleWebStartRetry();
      return;
    }

    try {
      const edgeConfig = resolveEdgeConfig();
      const scheme = forwardedProtoForEdgeScheme(edgeConfig.scheme);
      const response = await fetch(new URL("/v1/web/start", brokerControlUrl), {
        method: "POST",
        headers: {
          accept: "application/json",
          "x-forwarded-host": edgeConfig.portalHost,
          "x-forwarded-proto": scheme,
        },
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json() as { ok?: boolean; pid?: number | null; error?: string | null };
      if (!response.ok || body.ok !== true) {
        warn("web server did not report healthy", body.error ?? response.statusText);
        scheduleWebStartRetry();
        return;
      }
      log("web server ready", { pid: body.pid ?? null });
    } catch (error) {
      warn("web server startup failed", error instanceof Error ? error.message : String(error));
      scheduleWebStartRetry();
    }
  } finally {
    webStartInFlight = false;
  }
}

function scheduleWebStartRetry(): void {
  if (shuttingDown || webStartRetryTimer || process.env.OPENSCOUT_BASE_START_WEB === "0") {
    return;
  }
  webStartRetryTimer = setTimeout(() => {
    webStartRetryTimer = null;
    void startWebWhenBrokerIsReady();
  }, WEB_START_RETRY_MS);
  webStartRetryTimer.unref();
}

function findRepoMenuBundle(): string | null {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const distRoot = resolve(current, "apps", "macos", "dist");
    const candidates = [
      resolve(distRoot, "Scout.app", "Contents", "Library", "LoginItems", "ScoutMenu.app"),
      // Backward compatibility for older builds that emitted a standalone
      // helper. Current builds embed the helper in Scout.app, so prefer that
      // artifact and never launch a stale sibling when both happen to exist.
      resolve(distRoot, "ScoutMenu.app"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function startMenuBarApp(): void {
  if (process.env.OPENSCOUT_BASE_MENU_ENABLED === "0" || process.platform !== "darwin") {
    return;
  }

  const explicitBundle = process.env.OPENSCOUT_MENU_BUNDLE_PATH?.trim();
  const repoBundle = explicitBundle && existsSync(explicitBundle) ? explicitBundle : findRepoMenuBundle();
  const args = repoBundle ? [repoBundle] : ["-b", MENU_BUNDLE_ID];
  const child = spawn("open", args, {
    stdio: ["ignore", logFile("menu.stdout.log"), logFile("menu.stderr.log")],
  });
  child.once("exit", (code) => {
    if (code === 0) {
      log("menu bar app launch requested", { target: repoBundle ?? MENU_BUNDLE_ID });
      return;
    }
    warn("menu bar app launch failed", { target: repoBundle ?? MENU_BUNDLE_ID, code });
  });
}
type PairingControllerCommand = {
  command: string;
  args: string[];
  cwd: string;
};

function resolvePairingControllerCommand(): PairingControllerCommand | null {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolveOpenScoutRepoRoot({
    startDirectories: [
      process.env.OPENSCOUT_SETUP_CWD,
      process.cwd(),
      moduleDirectory,
    ],
  });
  const setupCwd = process.env.OPENSCOUT_SETUP_CWD?.trim()
    || repoRoot
    || process.cwd();
  const explicit = process.env.OPENSCOUT_PAIRING_RUNTIME_CONTROLLER_BIN?.trim();
  const candidates = [
    explicit,
    repoRoot ? join(repoRoot, "packages", "cli", "dist", "pairing-runtime-controller.mjs") : null,
    repoRoot ? join(repoRoot, "packages", "web", "dist", "pairing-runtime-controller.mjs") : null,
    repoRoot ? join(repoRoot, "packages", "web", "server", "pairing-runtime-controller.ts") : null,
    resolve(moduleDirectory, "..", "pairing-runtime-controller.mjs"),
    join(homedir(), ".bun", "install", "global", "node_modules", "@openscout", "scout", "dist", "pairing-runtime-controller.mjs"),
    join(homedir(), ".bun", "node_modules", "@openscout", "scout", "dist", "pairing-runtime-controller.mjs"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  // A non-prod instance never runs a stale pre-instance build (it would use
  // prod's ~/.scout/pairing and ports) nor prod's globally installed copy.
  const instanceCandidates = openScoutInstanceBootstrap.layout.isProd
    ? candidates
    : candidates.filter((candidate) => !candidate.includes("/.bun/") || candidate === explicit);
  const entrypoint = selectInstanceAwareEntrypoint(instanceCandidates);
  if (!entrypoint) {
    if (!openScoutInstanceBootstrap.layout.isProd) {
      warn("pairing controller skipped: no instance-aware entrypoint", {
        instance: openScoutInstanceBootstrap.layout.name,
        hint: "Rebuild packages/web or run from source; pre-instance builds would use prod's pairing state.",
      });
    }
    return null;
  }

  if (explicit === entrypoint && !/\.(?:[cm]?js|ts)$/.test(entrypoint)) {
    return { command: entrypoint, args: [], cwd: setupCwd };
  }
  const bun = resolveBunExecutable();
  return bun ? { command: bun.path, args: [entrypoint], cwd: setupCwd } : null;
}

async function waitForPairingProcessExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + PAIRING_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isScoutPairingProcessRunning(pid)) return true;
    await sleep(100);
  }
  return !isScoutPairingProcessRunning(pid);
}

async function stopPairingController(): Promise<void> {
  const ownedChild = pairingProcess;
  if (ownedChild && !isChildExited(ownedChild)) {
    pairingProcess = null;
    await terminateChildProcess(ownedChild, "pairing controller", PAIRING_STOP_TIMEOUT_MS);
    return;
  }
  const runtimePid = readScoutPairingProcessPid(pairingPaths.runtimePidPath);
  if (!isScoutPairingProcessRunning(runtimePid)) {
    pairingProcess = null;
    return;
  }
  try {
    process.kill(runtimePid as number, "SIGTERM");
  } catch {
    pairingProcess = null;
    return;
  }
  if (!await waitForPairingProcessExit(runtimePid as number)) {
    warn("pairing controller did not exit after SIGTERM; forcing shutdown", { pid: runtimePid });
    try {
      process.kill(runtimePid as number, "SIGKILL");
    } catch {
      // The process exited between the liveness check and the signal.
    }
  }
  pairingProcess = null;
}

function spawnPairingController(): void {
  if (shuttingDown || pairingProcess) return;
  const descriptor = resolvePairingControllerCommand();
  if (!descriptor) {
    warn("pairing controller entrypoint or Bun executable could not be resolved");
    pairingNextStartAt = Date.now() + pairingRestartDelayMs;
    pairingRestartDelayMs = Math.min(pairingRestartDelayMs * 2, RESTART_MAX_DELAY_MS);
    return;
  }

  const child = spawn(descriptor.command, descriptor.args, {
    cwd: descriptor.cwd,
    env: {
      ...process.env,
      OPENSCOUT_PARENT_PID: String(process.pid),
    },
    stdio: [
      "ignore",
      logFile("pairing.stdout.log"),
      logFile("pairing.stderr.log"),
    ],
  });
  pairingProcess = child;
  log("pairing controller started", { pid: child.pid, entrypoint: descriptor.args[0] ?? descriptor.command });
  child.once("error", (error) => {
    warn("pairing controller failed to start", error.message);
    if (pairingProcess !== child) return;
    pairingProcess = null;
    pairingNextStartAt = Date.now() + pairingRestartDelayMs;
    pairingRestartDelayMs = Math.min(pairingRestartDelayMs * 2, RESTART_MAX_DELAY_MS);
    void reconcilePairingController();
  });
  child.once("exit", (code, signal) => {
    if (pairingProcess !== child) return;
    pairingProcess = null;
    if (shuttingDown) return;
    warn("pairing controller exited", { code, signal });
    pairingNextStartAt = Date.now() + pairingRestartDelayMs;
    pairingRestartDelayMs = Math.min(pairingRestartDelayMs * 2, RESTART_MAX_DELAY_MS);
    void reconcilePairingController();
  });
}

async function reconcilePairingController(): Promise<void> {
  if (shuttingDown || !pairingSupervisionClaimed || pairingReconcileInFlight) return;
  pairingReconcileInFlight = true;
  try {
    let intent = readScoutPairingSupervisorIntent(pairingPaths.intentPath);
    const runtimePid = readScoutPairingProcessPid(pairingPaths.runtimePidPath);
    const runtimeRunning = isScoutPairingProcessRunning(runtimePid);

    // Preserve the pre-supervisor behavior on first upgrade: pairing starts
    // with base unless the operator has explicitly persisted a stopped intent.
    if (intent.desiredState === null) {
      intent = updateScoutPairingSupervisorIntent("start", pairingPaths.intentPath);
      log(runtimeRunning
        ? "adopted live pairing runtime as desired running state"
        : "initialized pairing desired state as running", runtimeRunning ? { pid: runtimePid } : {});
    }

    if (pairingRestartGeneration === null) {
      pairingRestartGeneration = intent.restartGeneration;
    }
    const restartRequested = pairingRestartGeneration !== intent.restartGeneration;
    if (restartRequested) {
      pairingRestartGeneration = intent.restartGeneration;
    }

    if (intent.desiredState !== "running") {
      pairingNextStartAt = 0;
      pairingRestartDelayMs = RESTART_MIN_DELAY_MS;
      if (runtimeRunning || pairingProcess) {
        await stopPairingController();
      }
      return;
    }

    if (restartRequested) {
      await stopPairingController();
    } else if (
      pairingProcess
      && !isChildExited(pairingProcess)
      && runtimeRunning
      && runtimePid === pairingProcess.pid
    ) {
      pairingRestartDelayMs = RESTART_MIN_DELAY_MS;
      return;
    } else if (runtimeRunning) {
      // A menu/web-owned controller cannot be adopted as a Node ChildProcess.
      // Replace it once so the base owns and can durably restart it.
      await stopPairingController();
    } else if (pairingProcess && !isChildExited(pairingProcess)) {
      return;
    } else {
      pairingProcess = null;
    }

    if (Date.now() >= pairingNextStartAt) {
      spawnPairingController();
    }
  } catch (error) {
    warn("pairing supervisor reconciliation failed", error instanceof Error ? error.message : String(error));
  } finally {
    pairingReconcileInFlight = false;
  }
}

function startPairingSupervision(): void {
  try {
    claimScoutPairingSupervision(process.pid, pairingPaths.supervisorPidPath);
  } catch (error) {
    warn("pairing supervision is owned by another live process", error instanceof Error ? error.message : String(error));
    return;
  }
  pairingSupervisionClaimed = true;
  pairingReconcileTimer = setInterval(() => {
    void reconcilePairingController();
  }, PAIRING_RECONCILE_INTERVAL_MS);
  pairingReconcileTimer.unref();
  void reconcilePairingController();
}

function writeMeshBridgeState(state: Record<string, unknown>): void {
  try {
    ensureDirectory(join(config.supportDirectory, "runtime"));
    writeFileSync(meshBridgeStatePath(config.supportDirectory), `${JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2)}\n`);
  } catch (error) {
    warn("could not record mesh bridge state", error instanceof Error ? error.message : String(error));
  }
}

function spawnMeshBridge(desired: Extract<MeshBridgeDesiredState, { run: true }>): void {
  if (shuttingDown || meshBridgeProcess) return;
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolveOpenScoutRepoRoot({
    startDirectories: [process.env.OPENSCOUT_SETUP_CWD, process.cwd(), moduleDirectory],
  });
  const entrypoint = resolveMeshBridgeEntrypoint({
    repoRoot,
    moduleDirectory,
    serviceMode: config.mode,
    env: process.env,
  });
  const bun = resolveBunExecutable();
  if (!entrypoint || !bun) {
    warn("mesh bridge entrypoint or Bun executable could not be resolved");
    meshBridgeNextStartAt = Date.now() + meshBridgeRestartDelayMs;
    meshBridgeRestartDelayMs = Math.min(meshBridgeRestartDelayMs * 2, RESTART_MAX_DELAY_MS);
    return;
  }

  const child = spawn(bun.path, meshBridgeArgs(entrypoint, desired.configPath), {
    cwd: repoRoot ?? process.cwd(),
    env: { ...process.env, OPENSCOUT_PARENT_PID: String(process.pid) },
    stdio: ["ignore", logFile("mesh-bridge.stdout.log"), logFile("mesh-bridge.stderr.log")],
  });
  meshBridgeProcess = child;
  meshBridgeStartedAt = Date.now();
  meshBridgeUnconfiguredMtimeMs = null;
  meshBridgeConfigMtimeMs = desired.configMtimeMs;
  meshBridgeLastIdleReason = null;
  log("mesh bridge started", { pid: child.pid, entrypoint });
  // The start time lets a later base fence exactly this process, never a
  // process that inherited its pid.
  const processStartedAt = child.pid ? readProcessIdentity(child.pid)?.startedAt ?? null : null;
  writeMeshBridgeState({
    state: "running",
    pid: child.pid ?? null,
    processStartedAt,
    entrypoint,
    configPath: desired.configPath,
    startedAt: Date.now(),
  });
  const settle = (code: number | null, signal: NodeJS.Signals | null, error?: string) => {
    if (meshBridgeProcess !== child) return;
    meshBridgeProcess = null;
    if (shuttingDown) return;
    if (code === MESH_BRIDGE_EXIT_UNCONFIGURED) {
      warn("mesh bridge has no relay token; retrying later", { retryInMs: MESH_BRIDGE_UNCONFIGURED_RETRY_MS });
      meshBridgeNextStartAt = Date.now() + MESH_BRIDGE_UNCONFIGURED_RETRY_MS;
      meshBridgeUnconfiguredMtimeMs = desired.configMtimeMs;
      writeMeshBridgeState({ state: "unconfigured", pid: null, reason: "no relay token" });
      return;
    }
    warn(error ? "mesh bridge failed to start" : "mesh bridge exited", error ?? { code, signal });
    meshBridgeNextStartAt = Date.now() + meshBridgeRestartDelayMs;
    meshBridgeRestartDelayMs = Math.min(meshBridgeRestartDelayMs * 2, RESTART_MAX_DELAY_MS);
    writeMeshBridgeState({ state: "restarting", pid: null, lastExit: { code, signal }, nextStartAt: meshBridgeNextStartAt });
  };
  child.once("error", (error) => settle(null, null, error.message));
  child.once("exit", (code, signal) => settle(code, signal));
}

async function reconcileMeshBridge(): Promise<void> {
  if (shuttingDown || meshBridgeReconcileInFlight) return;
  meshBridgeReconcileInFlight = true;
  try {
    await reconcileMeshBridgeOnce();
  } catch (error) {
    warn("mesh bridge reconciliation failed", error instanceof Error ? error.message : String(error));
  } finally {
    meshBridgeReconcileInFlight = false;
  }
}

async function reconcileMeshBridgeOnce(): Promise<void> {
  const desired = resolveMeshBridgeDesiredState({ supportDirectory: config.supportDirectory, env: process.env });
  const running = meshBridgeProcess && !isChildExited(meshBridgeProcess) ? meshBridgeProcess : null;

  if (!desired.run) {
    if (running) {
      log("stopping mesh bridge", { reason: desired.reason });
      meshBridgeProcess = null;
      await terminateChildProcess(running, "mesh bridge", MESH_BRIDGE_STOP_TIMEOUT_MS);
    }
    if (meshBridgeLastIdleReason !== desired.reason) {
      meshBridgeLastIdleReason = desired.reason;
      if (desired.reason === "legacy-launch-agent") {
        warn("mesh bridge is still installed as its own LaunchAgent; run `scout mesh bridge install` to hand it to scout-base");
      }
      writeMeshBridgeState({ state: "idle", pid: null, reason: desired.reason });
    }
    meshBridgeNextStartAt = 0;
    meshBridgeRestartDelayMs = RESTART_MIN_DELAY_MS;
    return;
  }

  if (running) {
    if (desired.configMtimeMs !== meshBridgeConfigMtimeMs) {
      log("mesh bridge config changed; restarting it");
      meshBridgeProcess = null;
      await terminateChildProcess(running, "mesh bridge", MESH_BRIDGE_STOP_TIMEOUT_MS);
      meshBridgeNextStartAt = 0;
    } else {
      if (Date.now() - meshBridgeStartedAt >= MESH_BRIDGE_STABLE_AFTER_MS) {
        meshBridgeRestartDelayMs = RESTART_MIN_DELAY_MS;
      }
      return;
    }
  }

  // Rewriting the config (e.g. `scout mesh bridge install` after adding the
  // token) lifts the unconfigured cooldown instead of waiting it out.
  if (meshBridgeUnconfiguredMtimeMs !== null && desired.configMtimeMs !== meshBridgeUnconfiguredMtimeMs) {
    meshBridgeUnconfiguredMtimeMs = null;
    meshBridgeNextStartAt = 0;
  }

  if (shuttingDown || Date.now() < meshBridgeNextStartAt) return;
  // The legacy plist can be gone while its job is still loaded (deleted by
  // hand). Only a confirmed-absent job clears the way; unknown defers too.
  if (process.platform === "darwin") {
    const legacyJob = inspectLaunchdJob(legacyMeshBridgeLaunchdTarget());
    if (legacyJob !== "absent") {
      const reason = `legacy-launchd-job-${legacyJob}`;
      if (meshBridgeLastIdleReason !== reason) {
        meshBridgeLastIdleReason = reason;
        warn("mesh bridge deferred: the legacy launchd job is not confirmed absent", { state: legacyJob });
        writeMeshBridgeState({ state: "idle", pid: null, reason });
      }
      return;
    }
  }
  // A previous scout-base that died without shutdown (SIGKILL, crash) leaves
  // its bridge holding the relay until that bridge's parent watcher notices.
  // Fence it before starting ours so two never hold this node's connection.
  await fencePreviousMeshBridge();
  if (shuttingDown) return;
  spawnMeshBridge(desired);
}

async function fencePreviousMeshBridge(): Promise<void> {
  const pid = findRecordedLiveMeshBridgePid(config.supportDirectory);
  if (pid === null || pid === process.pid) return;
  warn("stopping a mesh bridge left by a previous scout-base", { pid });
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + MESH_BRIDGE_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await sleep(100);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Exited between the last probe and the signal.
  }
}

function startMeshBridgeSupervision(): void {
  meshBridgeReconcileTimer = setInterval(() => {
    void reconcileMeshBridge();
  }, MESH_BRIDGE_RECONCILE_INTERVAL_MS);
  meshBridgeReconcileTimer.unref();
  void reconcileMeshBridge();
}

function isChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (isChildExited(child)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timeout.unref();
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function terminateChildProcess(
  child: ChildProcess | null,
  label: string,
  timeoutMs = CHILD_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  if (!child || isChildExited(child)) {
    return;
  }
  if (!child.killed) {
    child.kill("SIGTERM");
  }
  if (await waitForChildExit(child, timeoutMs)) {
    return;
  }
  warn(`${label} did not exit after SIGTERM; forcing shutdown`, { pid: child.pid });
  try {
    child.kill("SIGKILL");
  } catch {
    return;
  }
  await waitForChildExit(child, 2_000);
}

async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (baseKeepAlive) {
    clearInterval(baseKeepAlive);
    baseKeepAlive = null;
  }
  if (edgeLanWatchTimer) {
    clearInterval(edgeLanWatchTimer);
    edgeLanWatchTimer = null;
  }
  if (parentWatcher) {
    clearInterval(parentWatcher);
    parentWatcher = null;
  }
  if (webStartRetryTimer) {
    clearTimeout(webStartRetryTimer);
    webStartRetryTimer = null;
  }
  if (pairingReconcileTimer) {
    clearInterval(pairingReconcileTimer);
    pairingReconcileTimer = null;
  }
  if (meshBridgeReconcileTimer) {
    clearInterval(meshBridgeReconcileTimer);
    meshBridgeReconcileTimer = null;
  }
  // Broker owns scout-web; base owns pairing, the mesh bridge and the edge children. Scout.app
  // owns only its embedded helper through LaunchServices.
  const activeCaddyProcess = caddyProcess;
  stopEdgeProcesses();
  await Promise.all([
    roomListeningSupervisor.stop(),
    stopPairingController(),
    terminateChildProcess(meshBridgeProcess, "mesh bridge", MESH_BRIDGE_STOP_TIMEOUT_MS),
    terminateChildProcess(brokerProcess, "broker"),
    terminateChildProcess(activeCaddyProcess, "local edge", 2_000),
  ]);
  // Strictly after the broker: its final publisher checkpoint needs a live
  // server to acknowledge against, and the broker's drain budget is longer
  // than the edge's.
  if (jetStreamSidecar) {
    await jetStreamSidecar.stop().catch((error) => {
      warn("jetstream sidecar shutdown failed", String(error));
    });
    jetStreamSidecar = null;
  }
  if (pairingSupervisionClaimed) {
    releaseScoutPairingSupervision(process.pid, pairingPaths.supervisorPidPath);
    pairingSupervisionClaimed = false;
  }
  process.exit(exitCode);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function anchorBaseDaemonLifetime(): void {
  if (baseKeepAlive) {
    return;
  }

  // scout-base's lifetime must never depend on incidental handle refs. During
  // broker/edge restart backoff the only pending work is an unref'd restart
  // timer (scheduleBrokerRestart / scheduleEdgeRestart above both call
  // `.unref()`), so once a child exits the event loop can drain to zero
  // referenced handles before the timer fires — a drained loop is a clean exit,
  // which makes launchd tear down the whole broker/web/edge tree. This is
  // load-bearing on any runtime, not a Bun bug workaround. Keep one explicit
  // referenced anchor so the process stays alive across those windows; shutdown()
  // clears it and calls process.exit() itself.
  baseKeepAlive = setInterval(() => undefined, 60_000);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shutdown(0).catch((error) => {
      warn("shutdown failed", error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  });
}

// scoutd exports OPENSCOUT_PARENT_PID when it spawns scout-base. Watch it the
// same way broker-daemon and the pairing controller watch this process, so a
// dead scoutd cannot leave the base/broker/web/edge/pairing tree orphaned.
if (Number.isFinite(parentPid) && parentPid > 0 && parentPid !== process.pid) {
  parentWatcher = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      log(`parent ${parentPid} is gone, shutting down base`);
      shutdown(0).catch((error) => {
        warn("shutdown failed", error instanceof Error ? error.message : String(error));
        process.exit(1);
      });
    }
  }, 2_000);
  parentWatcher.unref();
}

log("starting Scout base service", {
  label: config.label,
  brokerUrl: config.brokerUrl,
  bootout: `launchctl bootout ${config.serviceTarget}`,
});
anchorBaseDaemonLifetime();
// Awaited before the broker: the child's env depends on whether the sidecar
// actually came up, and guessing that would either race it for the port or
// silently attach it to a foreign server. Resolves immediately when the
// feature is off, which is the default.
await startJetStreamSidecar();
spawnBroker();
roomListeningSupervisor.start();
startLocalEdge();
startPairingSupervision();
startMeshBridgeSupervision();
startMenuBarApp();
void startWebWhenBrokerIsReady();
