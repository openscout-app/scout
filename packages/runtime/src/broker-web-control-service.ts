import { isAllowedHostWebRequest, type HostWebRequest, type HostWebResponse } from "./host-web-request.js";
import type { RuntimeChildProcessLike, RuntimeEnv, RuntimeHttpRequestLike, RuntimeSpawnFunction } from "./portable-types.js";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ScoutBrokerChildServiceSnapshots } from "./broker-api.js";
import { resolveBrokerServiceConfig } from "./broker-process-manager.js";
import { loadLocalConfig, resolveWebAuthToken, resolveWebPort } from "./local-config.js";
import { resolveBunExecutable } from "./tool-resolution.js";
import { resolveLegacyWebEntry } from "./legacy-app-services.js";

export type WebRecoveryStatus = {
  state: "checking" | "healthy" | "suspect" | "recovering" | "unavailable" | "paused";
  checkedAt: number | null;
  lastHealthyAt: number | null;
  consecutiveFailures: number;
  automaticRestarts: number;
  lastRecovery: { startedAt: number; recoveredAt: number | null; previousPid: number | null; replacementPid: number | null; method: "automatic" | "manual" } | null;
};

export type WebControlStatus = {
  ok: boolean;
  running: boolean;
  starting: boolean;
  managed: boolean;
  webUrl: string;
  port: number;
  pid: number | null;
  error: string | null;
  recovery?: WebRecoveryStatus;
};

export type WebStartContext = {
  publicOrigin?: string;
  trustedHost?: string;
};

type BunExecutable = {
  path: string;
};

export type BrokerWebControlServiceOptions = {
  brokerControlUrl: string;
  tailnetWebHosts?: string[];
  trustedHosts?: Iterable<string>;
  webProcessName?: string;
  env?: RuntimeEnv;
  fetch?: typeof fetch;
  spawnProcess?: RuntimeSpawnFunction<RuntimeChildProcessLike>;
  moduleDirectory?: string;
  cwd?: () => string;
  sleep?: (ms: number) => Promise<void>;
  healthCheck?: (webUrl: string) => Promise<boolean>;
  resolveEntry?: () => string | null;
  resolveBun?: () => BunExecutable | null;
  resolveLogPath?: () => string;
  resolveWebPort?: () => number;
  startPollTimeoutMs?: number;
  startPollIntervalMs?: number;
  respawnBaseDelayMs?: number;
  respawnMaxDelayMs?: number;
  respawnMaxFailures?: number;
  respawnFailureWindowMs?: number;
  stopTimeoutMs?: number;
  /** Zero disables the timer for callers that drive checkManagedHealth themselves. */
  healthMonitorIntervalMs?: number;
  healthStartupGraceMs?: number;
  healthFailureDurationMs?: number;
  healthRestartWindowMs?: number;
  healthMaxRestarts?: number;
  now?: () => number;
  log?: (message: string, detail?: unknown) => void;
  warn?: (message: string) => void;
  error?: (message: string, detail?: unknown) => void;
};

const DEFAULT_WEB_PROCESS_NAME = "scout-web";
const DEFAULT_START_POLL_TIMEOUT_MS = 15_000;
const DEFAULT_START_POLL_INTERVAL_MS = 250;
const DEFAULT_RESPAWN_BASE_DELAY_MS = 1_000;
const DEFAULT_RESPAWN_MAX_DELAY_MS = 30_000;
const DEFAULT_RESPAWN_MAX_FAILURES = 5;
const DEFAULT_RESPAWN_FAILURE_WINDOW_MS = 60_000;
// Keep this below the broker's outer shutdown allowance. The web server has
// its own drain window, so clearing our child handle immediately after TERM
// would make a replacement or parent shutdown race the still-live process.
const DEFAULT_STOP_TIMEOUT_MS = 10_000;

export function appendCsvValue(input: string | undefined, value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return input;
  }
  const existing = (input ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!existing.some((entry) => entry.toLowerCase() === normalized.toLowerCase())) {
    existing.push(normalized);
  }
  return existing.length > 0 ? existing.join(",") : undefined;
}

export function appendCsvValues(input: string | undefined, values: Array<string | undefined>): string | undefined {
  return values.reduce((current, value) => appendCsvValue(current, value), input);
}

export function normalizeTrustedWebHost(
  value: string | undefined,
  trustedHosts: Set<string> = new Set(),
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const candidate = trimmed.includes("://") ? new URL(trimmed) : new URL(`http://${trimmed}`);
    const hostName = candidate.hostname.toLowerCase();
    if (
      hostName === "scout.local"
      || hostName.endsWith(".scout.local")
      || hostName === "localhost"
      || hostName === "127.0.0.1"
      || hostName === "::1"
      || trustedHosts.has(hostName)
    ) {
      return hostName;
    }
  } catch {
    return null;
  }
  return null;
}

export function webStartContextFromRequest(
  request: Pick<RuntimeHttpRequestLike, "headers">,
  trustedHosts: Set<string> = new Set(),
): WebStartContext {
  const forwardedHost = Array.isArray(request.headers["x-forwarded-host"])
    ? request.headers["x-forwarded-host"][0]
    : request.headers["x-forwarded-host"];
  const forwardedProto = Array.isArray(request.headers["x-forwarded-proto"])
    ? request.headers["x-forwarded-proto"][0]
    : request.headers["x-forwarded-proto"];
  const trustedHost = normalizeTrustedWebHost(forwardedHost, trustedHosts);
  if (!trustedHost) {
    return {};
  }
  const proto = forwardedProto?.trim().toLowerCase() === "https" ? "https" : "http";
  return {
    publicOrigin: `${proto}://${trustedHost}`,
    trustedHost,
  };
}

export function scoutWebControlCorsHeaders(
  request: Pick<RuntimeHttpRequestLike, "headers">,
  trustedHosts: Set<string> = new Set(),
): Record<string, string> {
  const origin = request.headers.origin;
  if (typeof origin !== "string") {
    return {};
  }
  const allowed = Boolean(normalizeTrustedWebHost(origin, trustedHosts));
  if (!allowed) {
    return {};
  }
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, accept",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export function isChildProcessRunning(
  child: RuntimeChildProcessLike | null,
): child is RuntimeChildProcessLike {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

export class BrokerWebControlService {
  private readonly env: RuntimeEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: RuntimeSpawnFunction<RuntimeChildProcessLike>;
  private readonly trustedHosts: Set<string>;
  private readonly tailnetWebHosts: string[];
  private readonly webProcessName: string;
  private readonly moduleDirectory: string;
  private readonly cwd: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly startPollTimeoutMs: number;
  private readonly startPollIntervalMs: number;
  private readonly respawnBaseDelayMs: number;
  private readonly respawnMaxDelayMs: number;
  private readonly respawnMaxFailures: number;
  private readonly respawnFailureWindowMs: number;
  private readonly stopTimeoutMs: number;
  private readonly webAuthToken: string;
  private readonly respawnFailures: number[] = [];
  private webServerProcess: RuntimeChildProcessLike | null = null;
  private webStartInFlight: Promise<WebControlStatus> | null = null;
  private webRestartInFlight: Promise<WebControlStatus> | null = null;
  private stopping = false;
  private webExpected = false;
  private readonly intentionalStops = new Set<RuntimeChildProcessLike>();
  private monitorTimer: ReturnType<typeof setTimeout> | null = null;
  private monitorInFlight = false;
  private childStartedAt = 0;
  private webStartContext: WebStartContext = {};
  private childWasHealthy = false;
  private firstHealthFailureAt: number | null = null;
  private readonly healthRestarts: number[] = [];
  private recovery: WebRecoveryStatus = {
    state: "checking", checkedAt: null, lastHealthyAt: null, consecutiveFailures: 0,
    automaticRestarts: 0, lastRecovery: null,
  };

  private now(): number { return (this.options.now ?? Date.now)(); }

  /** Cached evidence only: broker status never waits for a nested HTTP probe. */
  recoveryStatus(): WebRecoveryStatus {
    return { ...this.recovery, lastRecovery: this.recovery.lastRecovery ? { ...this.recovery.lastRecovery } : null };
  }

  private recoveryDetail(): string {
    switch (this.recovery.state) {
      case "healthy": return this.recovery.lastRecovery?.recoveredAt
        ? (this.recovery.lastRecovery.method === "manual"
          ? "Web is responding after a manual restart."
          : "Web is responding; a previous interruption recovered automatically.")
        : "Web is responding to its authenticated health probe.";
      case "suspect": return "Web is slow to respond; checking again before attempting recovery.";
      case "recovering": return "Web is being restarted automatically after repeated health failures.";
      case "paused": return "Web recovery is paused after repeated interruptions. Inspect diagnostics, then restart Web to retry.";
      case "unavailable": return "Web is not responding; automatic recovery has not yet restored service.";
      default: return "Waiting for a web health observation.";
    }
  }

  private scheduleHealthMonitor(): void {
    if (this.monitorTimer) clearTimeout(this.monitorTimer);
    const interval = this.options.healthMonitorIntervalMs ?? 10_000;
    if (this.stopping || interval <= 0 || !isChildProcessRunning(this.webServerProcess)) return;
    this.monitorTimer = setTimeout(() => {
      this.monitorTimer = null;
      void this.checkManagedHealth().catch(() => {
        // A monitor error is uncertainty, not permission to kill a child.
      }).finally(() => this.scheduleHealthMonitor());
    }, interval);
    this.monitorTimer.unref?.();
  }

  /** Only the exact child owned by this broker can be recovered. */
  async checkManagedHealth(): Promise<void> {
    const child = this.webServerProcess;
    if (this.stopping || this.monitorInFlight || this.webRestartInFlight || this.webStartInFlight
      || !isChildProcessRunning(child)) return;
    this.monitorInFlight = true;
    try {
      const healthy = await this.isHealthy();
      if (this.stopping || this.webServerProcess !== child || this.webRestartInFlight) return;
      const now = this.now();
      // Sleep or a stalled parent interrupts observation; do not turn that gap
      // into evidence of consecutive child failures.
      const interval = this.options.healthMonitorIntervalMs || 10_000;
      if (this.recovery.checkedAt !== null && now - this.recovery.checkedAt > interval * 3) {
        this.firstHealthFailureAt = null;
        this.recovery.consecutiveFailures = 0;
      }
      this.recovery.checkedAt = now;
      if (healthy) {
        this.childWasHealthy = true;
        this.recovery.lastHealthyAt = now;
        this.recovery.consecutiveFailures = 0;
        this.firstHealthFailureAt = null;
        this.recovery.state = "healthy";
        const incident = this.recovery.lastRecovery;
        if (incident && incident.recoveredAt === null) {
          incident.recoveredAt = now;
          incident.replacementPid = child.pid ?? null;
          this.options.log?.("[scout-web-health] recovered", this.recoveryStatus());
        }
        return;
      }
      if (!this.childWasHealthy && now - this.childStartedAt < (this.options.healthStartupGraceMs ?? 60_000)) return;
      this.firstHealthFailureAt ??= now;
      this.recovery.consecutiveFailures += 1;
      if (this.recovery.state === "paused") return;
      this.recovery.state = "suspect";
      if (this.recovery.consecutiveFailures < 3
        || now - this.firstHealthFailureAt < (this.options.healthFailureDurationMs ?? 20_000)) return;
      const window = this.options.healthRestartWindowMs ?? 10 * 60_000;
      while (this.healthRestarts.length && now - this.healthRestarts[0]! > window) this.healthRestarts.shift();
      if (this.healthRestarts.length >= (this.options.healthMaxRestarts ?? 2)) {
        this.recovery.state = "paused";
        this.options.warn?.("[scout-web-health] Automatic recovery paused after repeated interruptions; inspect diagnostics and restart Web to retry.");
        return;
      }
      this.healthRestarts.push(now);
      this.recovery.automaticRestarts += 1;
      this.recovery.state = "recovering";
      this.recovery.lastRecovery = { startedAt: now, recoveredAt: null, previousPid: child.pid ?? null, replacementPid: null, method: "automatic" };
      this.options.log?.("[scout-web-health] recovering", this.recoveryStatus());
      const result = await this.restartIfManaged(this.webStartContext, true);
      if (this.stopping) return;
      this.recovery.state = result.running ? "healthy" : "unavailable";
      if (result.running) {
        this.childWasHealthy = true;
        this.recovery.checkedAt = this.now();
        this.recovery.lastHealthyAt = this.now();
        this.recovery.lastRecovery!.recoveredAt = this.now();
        this.recovery.lastRecovery!.replacementPid = result.pid;
        this.options.log?.("[scout-web-health] recovered", this.recoveryStatus());
      }
    } finally {
      this.monitorInFlight = false;
    }
  }

  constructor(private readonly options: BrokerWebControlServiceOptions) {
    this.env = options.env ?? process.env;
    this.webAuthToken = this.env.OPENSCOUT_WEB_AUTH_TOKEN?.trim()
      || resolveWebAuthToken(this.env);
    this.fetchImpl = options.fetch ?? fetch;
    this.spawnImpl = options.spawnProcess ?? (spawn as unknown as RuntimeSpawnFunction<RuntimeChildProcessLike>);
    this.trustedHosts = new Set(
      [...(options.trustedHosts ?? [])]
        .map((host) => host.trim().replace(/\.$/, "").toLowerCase())
        .filter(Boolean),
    );
    this.tailnetWebHosts = (options.tailnetWebHosts ?? []).map((host) => host.trim()).filter(Boolean);
    this.webProcessName = options.webProcessName ?? DEFAULT_WEB_PROCESS_NAME;
    this.moduleDirectory = options.moduleDirectory ?? dirname(fileURLToPath(import.meta.url));
    this.cwd = options.cwd ?? (() => process.cwd());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
    this.startPollTimeoutMs = options.startPollTimeoutMs ?? DEFAULT_START_POLL_TIMEOUT_MS;
    this.startPollIntervalMs = options.startPollIntervalMs ?? DEFAULT_START_POLL_INTERVAL_MS;
    this.respawnBaseDelayMs = options.respawnBaseDelayMs ?? DEFAULT_RESPAWN_BASE_DELAY_MS;
    this.respawnMaxDelayMs = options.respawnMaxDelayMs ?? DEFAULT_RESPAWN_MAX_DELAY_MS;
    this.respawnMaxFailures = options.respawnMaxFailures ?? DEFAULT_RESPAWN_MAX_FAILURES;
    this.respawnFailureWindowMs = options.respawnFailureWindowMs ?? DEFAULT_RESPAWN_FAILURE_WINDOW_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  }

  port(): number {
    const envPort = Number.parseInt(this.env.OPENSCOUT_WEB_PORT ?? "", 10);
    return Number.isInteger(envPort) && envPort > 0 && envPort < 65536
      ? envPort
      : (this.options.resolveWebPort ?? resolveWebPort)();
  }

  /** Execute only on this broker's own web process using its local credential. */
  async requestForHost(input: HostWebRequest): Promise<HostWebResponse> {
    if (!isAllowedHostWebRequest(input)) return { status: 400, body: { error: "unsupported_host_operation" } };
    try {
      const response = await this.fetchImpl(new URL(input.path, this.url()), {
        method: input.method,
        headers: { authorization: `Bearer ${this.webAuthToken}`, "content-type": "application/json" },
        ...(input.method === "POST" ? { body: JSON.stringify(input.body ?? {}) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (input.method === "GET" && input.path.startsWith("/api/blobs/") && response.ok) {
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > 25 * 1024 * 1024) return { status: 413, body: { error: "Attachment is too large" } };
        return { status: response.status, body: null, binary: {
          data: Buffer.from(bytes).toString("base64"),
          contentType: response.headers.get("content-type") || "application/octet-stream",
        } };
      }
      return { status: response.status, body: await response.json() };
    } catch {
      return { status: 502, body: { error: "Destination web service is unavailable" } };
    }
  }

  url(): string {
    return `http://127.0.0.1:${this.port()}`;
  }

  async status(error: string | null = null): Promise<WebControlStatus> {
    const running = await this.isHealthy();
    const managed = isChildProcessRunning(this.webServerProcess);
    return {
      ok: running,
      running,
      starting: Boolean(this.webStartInFlight),
      managed,
      webUrl: this.url(),
      port: this.port(),
      pid: managed ? this.webServerProcess?.pid ?? null : null,
      error,
      recovery: this.recoveryStatus(),
    };
  }

  failureStatus(error: unknown): WebControlStatus {
    const managed = isChildProcessRunning(this.webServerProcess);
    return {
      ok: false,
      running: false,
      starting: false,
      managed,
      webUrl: this.url(),
      port: this.port(),
      pid: managed ? this.webServerProcess?.pid ?? null : null,
      error: error instanceof Error ? error.message : String(error),
      recovery: this.recoveryStatus(),
    };
  }

  readChildServiceSnapshots(): ScoutBrokerChildServiceSnapshots {
    const webRunning = isChildProcessRunning(this.webServerProcess);
    return {
      web: {
        expected: this.webExpected,
        managed: true,
        managedBy: "broker",
        state: this.webStartInFlight || this.webRestartInFlight ? "starting" : webRunning ? (this.recovery.state === "paused" || this.recovery.state === "unavailable" ? "unavailable" : "running") : "stopped",
        pid: this.webServerProcess?.pid ?? null,
        port: this.port(),
        url: this.url(),
        healthy: webRunning && this.recovery.checkedAt !== null
          && this.now() - this.recovery.checkedAt <= (this.options.healthMonitorIntervalMs || 10_000) * 3
          ? this.recovery.state === "healthy" ? true
            : this.recovery.state === "unavailable" || this.recovery.state === "paused" ? false : null
          : null,
        detail: webRunning ? this.recoveryDetail() : "web child has not been started by this broker",
        recovery: this.recoveryStatus(),
      },
      terminalRelay: {
        managed: true,
        managedBy: "web",
        state: "unknown",
        pid: null,
        healthy: null,
        detail: "terminal relay is managed inside scout-web; broker /health does not probe it",
      },
      localEdge: {
        managed: true,
        managedBy: "base",
        state: "unknown",
        pid: null,
        healthy: null,
        detail: "local edge/Caddy is managed by scout-base; no broker-visible cached state is available",
      },
    };
  }

  startContextFromRequest(request: Pick<RuntimeHttpRequestLike, "headers">): WebStartContext {
    return webStartContextFromRequest(request, this.trustedHosts);
  }

  corsHeaders(request: Pick<RuntimeHttpRequestLike, "headers">): Record<string, string> {
    return scoutWebControlCorsHeaders(request, this.trustedHosts);
  }

  async startIfNeeded(context: WebStartContext = {}, fromRestart = false): Promise<WebControlStatus> {
    this.webExpected = true;
    if (this.stopping) {
      return this.failureStatus("Scout web cannot start while the broker is stopping.");
    }
    if (this.webRestartInFlight && !fromRestart) return this.webRestartInFlight;
    if (this.webStartInFlight) {
      return this.webStartInFlight;
    }

    this.webStartInFlight = (async () => {
      try {
        if (await this.isHealthy()) {
          return this.status();
        }
        // stop() can run while the initial health probe is in flight. Recheck
        // the lifecycle boundary after that await so shutdown cannot return
        // before a late web child is spawned.
        if (this.stopping) {
          return this.failureStatus("Scout web cannot start while the broker is stopping.");
        }
        if (!isChildProcessRunning(this.webServerProcess)) {
          this.webServerProcess = this.spawnWebServer(context);
        }
        const deadline = Date.now() + this.startPollTimeoutMs;
        while (Date.now() < deadline) {
          if (await this.isHealthy()) {
            return this.status();
          }
          await this.sleep(this.startPollIntervalMs);
        }
        return this.status("Timed out waiting for Scout web to become healthy.");
      } catch (error) {
        return this.status(error instanceof Error ? error.message : String(error));
      } finally {
        this.webStartInFlight = null;
      }
    })();

    return this.webStartInFlight;
  }

  /**
   * Restart only a web process this broker launched. An already-healthy process
   * with no child handle is deliberately not adopted: it may belong to another
   * terminal or a previous broker, and killing it would violate process
   * ownership.
   */
  async restartIfManaged(context: WebStartContext = {}, automatic = false): Promise<WebControlStatus> {
    if (this.webRestartInFlight) {
      return this.webRestartInFlight;
    }

    if (this.stopping) return this.failureStatus("Scout web cannot restart while the broker is stopping.");
    context = { ...this.webStartContext, ...context };
    if (!automatic) {
      if (this.recovery.lastRecovery?.recoveredAt === null) this.recovery.lastRecovery.method = "manual";
      this.healthRestarts.length = 0;
      this.recovery.state = "checking";
    }
    this.webRestartInFlight = (async () => {
      // A concurrent start owns its startup boundary; never race it for the port.
      if (this.webStartInFlight) await this.webStartInFlight;
      if (this.stopping) return this.failureStatus("Scout web cannot restart while the broker is stopping.");
      const child = this.webServerProcess;
      if (!isChildProcessRunning(child)) {
        if (await this.isHealthy()) {
          return {
            ...await this.status(),
            ok: false,
            error: "Scout web is running outside broker management and cannot be restarted safely. Stop that process, then run `scout server start`.",
          };
        }
        return this.startIfNeeded(context, true);
      }

      await this.terminateOwnedChild(child);
      if (isChildProcessRunning(child)) {
        return this.failureStatus("Timed out stopping the broker-managed Scout web process; no replacement was started.");
      }
      if (this.webServerProcess === child) this.webServerProcess = null;
      return this.startIfNeeded(context, true);

    })().finally(() => {
      this.webRestartInFlight = null;
    });

    return this.webRestartInFlight;
  }

  /**
   * Stop only the web process this broker launched. This deliberately awaits
   * the owned child before releasing its handle, giving the parent a real
   * shutdown boundary rather than a best-effort signal.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.monitorTimer) clearTimeout(this.monitorTimer);
    this.monitorTimer = null;
    const child = this.webServerProcess;
    if (isChildProcessRunning(child)) await this.terminateOwnedChild(child);
    if (!isChildProcessRunning(child) && this.webServerProcess === child) this.webServerProcess = null;
  }

  private async terminateOwnedChild(child: RuntimeChildProcessLike): Promise<void> {
    this.intentionalStops.add(child);
    try {
      await this.signalAndWaitForChild(child);
    } finally {
      this.intentionalStops.delete(child);
    }
  }

  private async signalAndWaitForChild(child: RuntimeChildProcessLike): Promise<void> {
    try {
      child.kill("SIGTERM");
    } catch (error) {
      this.options.warn?.(`[openscout-runtime] could not stop broker-managed Scout web: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const deadline = Date.now() + this.stopTimeoutMs;
    while (isChildProcessRunning(child) && Date.now() < deadline) {
      await this.sleep(this.startPollIntervalMs);
    }
    if (isChildProcessRunning(child)) {
      this.options.warn?.(`[openscout-runtime] Scout web did not exit within ${this.stopTimeoutMs}ms; forcing broker-managed child shutdown.`);
      try {
        child.kill("SIGKILL");
      } catch {
        // Preserve the handle below if the process still appears alive.
      }
      const forceDeadline = Date.now() + 2_000;
      while (isChildProcessRunning(child) && Date.now() < forceDeadline) {
        await this.sleep(this.startPollIntervalMs);
      }
    }
    if (!isChildProcessRunning(child) && this.webServerProcess === child) {
      this.webServerProcess = null;
    }
  }

  private async isHealthy(): Promise<boolean> {
    if (this.options.healthCheck) {
      return this.options.healthCheck(this.url());
    }
    try {
      const response = await this.fetchImpl(`${this.url()}/api/health`, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.webAuthToken}`,
        },
        signal: AbortSignal.timeout(1_000),
      });
      if (!response.ok) {
        return false;
      }
      const body = await response.json() as { ok?: boolean; surface?: string };
      return body.ok === true && body.surface === "openscout-web";
    } catch {
      return false;
    }
  }

  private resolveEntry(): string | null {
    if (this.options.resolveEntry) {
      return this.options.resolveEntry();
    }
    return resolveLegacyWebEntry(this.env, this.moduleDirectory);
  }

  private resolveSetupCwd(): string {
    return this.env.OPENSCOUT_SETUP_CWD?.trim() || this.cwd();
  }

  private resolveLogPath(): string {
    if (this.options.resolveLogPath) {
      return this.options.resolveLogPath();
    }
    const config = resolveBrokerServiceConfig();
    const logDirectory = join(config.supportDirectory, "logs", "web");
    mkdirSync(logDirectory, { recursive: true });
    return join(logDirectory, "supervised-web.log");
  }

  private spawnWebServer(context: WebStartContext = {}): RuntimeChildProcessLike {
    const entry = this.resolveEntry();
    if (!entry) {
      throw new Error("The web app is supplied by the Scout apps, not the Scout core. Install the apps and configure OPENSCOUT_WEB_SERVER_ENTRY.");
    }
    const bun = this.options.resolveBun ? this.options.resolveBun() : resolveBunExecutable();
    if (!bun) {
      throw new Error("Unable to locate Bun for Scout web startup.");
    }

    const trustedHosts = appendCsvValues(this.env.OPENSCOUT_WEB_TRUSTED_HOSTS, [
      ...this.tailnetWebHosts,
      context.trustedHost,
    ]);
    // The supervised service owns the always-on Bonjour `/pair` ingress. Its
    // default listener is reachable on the LAN, but the web socket boundary
    // admits only exact GET /pair from non-loopback peers. An operator-provided
    // bind host remains an explicit configuration and must carry its own LAN
    // opt-in when non-loopback.
    const configuredBindHost = this.env.OPENSCOUT_WEB_HOST?.trim()
      || this.env.SCOUT_WEB_HOST?.trim()
      || null;
    const brokerPairingIngress = configuredBindHost === null;
    const env = {
      ...this.env,
      OPENSCOUT_WEB_HOST: configuredBindHost ?? "0.0.0.0",
      ...(brokerPairingIngress
        ? {
            OPENSCOUT_WEB_ALLOW_LAN: "1",
            // env wins, then ~/.openscout/config.json, then the closed default.
            // Read per spawn so flipping the config only needs a web restart.
            OPENSCOUT_WEB_LAN_SCOPE: this.env.OPENSCOUT_WEB_LAN_SCOPE?.trim()
              || loadLocalConfig().webLanScope
              || "pairing",
          }
        : {}),
      OPENSCOUT_WEB_PORT: String(this.port()),
      OPENSCOUT_WEB_BUN_URL: this.url(),
      OPENSCOUT_WEB_AUTH_TOKEN: this.webAuthToken,
      OPENSCOUT_BROKER_INTERNAL_URL: this.options.brokerControlUrl,
      OPENSCOUT_PARENT_PID: String(process.pid),
      ...(context.publicOrigin && !this.env.OPENSCOUT_WEB_PUBLIC_ORIGIN?.trim()
        ? { OPENSCOUT_WEB_PUBLIC_ORIGIN: context.publicOrigin }
        : {}),
      ...(context.trustedHost && context.trustedHost !== "scout.local" && !this.env.OPENSCOUT_WEB_ADVERTISED_HOST?.trim()
        ? { OPENSCOUT_WEB_ADVERTISED_HOST: context.trustedHost }
        : {}),
      ...(trustedHosts ? { OPENSCOUT_WEB_TRUSTED_HOSTS: trustedHosts } : {}),
      OPENSCOUT_SETUP_CWD: this.resolveSetupCwd(),
    };
    this.options.log?.("[openscout-runtime] starting Scout web server", {
      webUrl: this.url(),
      publicOrigin: env.OPENSCOUT_WEB_PUBLIC_ORIGIN,
      advertisedHost: env.OPENSCOUT_WEB_ADVERTISED_HOST,
      brokerInternalUrl: env.OPENSCOUT_BROKER_INTERNAL_URL,
      trustedHost: context.trustedHost,
    });
    const logFd = openSync(this.resolveLogPath(), "a");
    let child: RuntimeChildProcessLike;
    try {
      child = this.spawnImpl(
        bun.path,
        ["run", entry],
        {
          argv0: this.webProcessName,
          env,
          stdio: ["ignore", logFd, logFd],
        },
      );
    } finally {
      closeSync(logFd);
    }
    child.once("exit", (code, signal) => {
      if (this.webServerProcess !== child) {
        // Either we already replaced this handle, or shutdown nulled it intentionally.
        return;
      }
      this.webServerProcess = null;
      if (this.stopping || this.webRestartInFlight || this.intentionalStops.has(child)) {
        return;
      }
      // Track failures within a sliding window so a broken entrypoint doesn't
      // produce an infinite respawn loop. Linear backoff escalates the delay
      // with each consecutive failure; we pause auto-respawn entirely once we
      // exceed the threshold and require an operator to call `scout server start`.
      const now = Date.now();
      while (this.respawnFailures.length > 0 && now - this.respawnFailures[0]! > this.respawnFailureWindowMs) {
        this.respawnFailures.shift();
      }
      this.respawnFailures.push(now);
      if (this.respawnFailures.length > this.respawnMaxFailures) {
        this.options.error?.(
          `[openscout-runtime] Scout web server has exited ${this.respawnFailures.length} times within ${this.respawnFailureWindowMs / 1000}s - pausing auto-respawn. Use 'scout server start' to retry.`,
        );
        this.respawnFailures.length = 0;
        return;
      }
      const delay = Math.min(
        this.respawnBaseDelayMs * this.respawnFailures.length,
        this.respawnMaxDelayMs,
      );
      this.options.warn?.(
        `[openscout-runtime] Scout web server exited unexpectedly (code=${code}, signal=${signal}) - respawning in ${delay}ms (failure ${this.respawnFailures.length}/${this.respawnMaxFailures})`,
      );
      setTimeout(() => {
        if (this.stopping) return;
        this.startIfNeeded(context).catch((error) => {
          this.options.error?.("[openscout-runtime] web server respawn failed:", error);
        });
      }, delay).unref?.();
    });
    this.webStartContext = { ...context };
    this.childStartedAt = this.now();
    if (this.recovery.state !== "recovering") this.recovery.state = "checking";
    this.childWasHealthy = false;
    this.firstHealthFailureAt = null;
    this.recovery.consecutiveFailures = 0;
    this.recovery.checkedAt = null;
    // The caller installs the handle before the first timer fires.
    queueMicrotask(() => this.scheduleHealthMonitor());
    child.unref();
    return child;
  }
}
