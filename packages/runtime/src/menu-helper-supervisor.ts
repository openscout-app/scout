import { spawn } from "node:child_process";
import { openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, normalize } from "node:path";

import { resolveMenuHelperBundlePath, type OpenScoutAppsSettings } from "./apps-settings.js";

/**
 * The menu bar helper runs under scout-base, like the pairing controller and
 * the mesh bridge. Quitting, rebuilding or relaunching any Scout.app does not
 * stop it, and stopping it is not the app's business.
 *
 * Which helper runs comes from settings.json (`apps`), never from the bundle
 * identifier. Every build of the helper shares one identifier, so an open by
 * identifier starts whichever copy LaunchServices prefers: another checkout's,
 * or one whose bundle was replaced. A helper from another bundle is left alone.
 *
 * Restarts follow launchd's KeepAlive { SuccessfulExit: false }: a helper that
 * crashes comes back, and one that quits stays quit until it is opened again or
 * the service restarts. The helper is opened through LaunchServices, so its
 * exit status never reaches this process; a crash shows instead as a fresh
 * crash report that names the helper's bundle.
 */

export const MENU_HELPER_RECONCILE_INTERVAL_MS = 5_000;
/** No second launch request inside this window: the helper may still be starting. */
export const MENU_HELPER_LAUNCH_GRACE_MS = 15_000;
export const MENU_HELPER_RESTART_MAX_DELAY_MS = 5 * 60_000;
/** A helper that stays up this long resets the restart delay. */
export const MENU_HELPER_STABLE_AFTER_MS = 60_000;
/** How long an exit waits for ReportCrash before it counts as a quit. */
export const MENU_HELPER_CRASH_REPORT_WAIT_MS = 10_000;

export type MenuHelperDesiredState =
  | { run: true; bundlePath: string; source: "env" | "settings" }
  | { run: false; reason: "not-macos" | "disabled-by-env" | "disabled-in-settings" | "not-declared" }
  | { run: false; reason: "bundle-missing"; bundlePath: string; source: "env" | "settings" };

export function resolveMenuHelperDesiredState(input: {
  settings: OpenScoutAppsSettings;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /**
   * False for a development instance. It runs a helper only when its env or
   * its own settings name one, so it never starts the installed app's helper.
   */
  isProd: boolean;
  exists: (path: string) => boolean;
}): MenuHelperDesiredState {
  if (input.platform !== "darwin") return { run: false, reason: "not-macos" };
  if (input.env.OPENSCOUT_BASE_MENU_ENABLED === "0") return { run: false, reason: "disabled-by-env" };

  // A development instance or a test names its helper directly.
  const explicit = input.env.OPENSCOUT_MENU_BUNDLE_PATH?.trim();
  if (explicit && isAbsolute(explicit)) {
    const bundlePath = normalize(explicit).replace(/\/+$/u, "");
    return input.exists(bundlePath)
      ? { run: true, bundlePath, source: "env" }
      : { run: false, reason: "bundle-missing", bundlePath, source: "env" };
  }

  if (!input.settings.menu.enabled) return { run: false, reason: "disabled-in-settings" };
  if (!input.isProd && !input.settings.menu.bundlePath && !input.settings.scoutAppPath) {
    return { run: false, reason: "not-declared" };
  }
  const bundlePath = resolveMenuHelperBundlePath(input.settings);
  return input.exists(bundlePath)
    ? { run: true, bundlePath, source: "settings" }
    : { run: false, reason: "bundle-missing", bundlePath, source: "settings" };
}

export type ProcessCommand = { pid: number; command: string };

/** The helper processes started from this bundle, matched on the executable path. */
export function findMenuHelperProcesses(processes: ProcessCommand[], bundlePaths: string[]): ProcessCommand[] {
  const prefixes = bundlePaths.map((bundlePath) => `${join(bundlePath, "Contents", "MacOS")}/`);
  return processes.filter((entry) => prefixes.some((prefix) => entry.command.startsWith(prefix)));
}

const CRASH_REPORT_READ_BYTES = 256 * 1024;

/**
 * Whether macOS wrote a crash report for this helper process after `sinceMs`.
 * Reports are named after the executable and record the pid. They anonymize
 * paths under the home folder, so the pid, not the path, tells this helper's
 * crash from another checkout's.
 */
export function hasMenuHelperCrashReport(input: {
  pid: number;
  bundlePath: string;
  sinceMs: number;
  directory?: string;
}): boolean {
  const directory = input.directory ?? join(homedir(), "Library", "Logs", "DiagnosticReports");
  const processName = basename(input.bundlePath, ".app");
  const pidField = new RegExp(`"pid"\\s*:\\s*${input.pid}(?!\\d)`, "u");
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.startsWith(`${processName}-`) || !(name.endsWith(".ips") || name.endsWith(".crash"))) continue;
    const path = join(directory, name);
    try {
      if (statSync(path).mtimeMs < input.sinceMs) continue;
      const fd = openSync(path, "r");
      try {
        const buffer = Buffer.alloc(CRASH_REPORT_READ_BYTES);
        const length = readSync(fd, buffer, 0, buffer.length, 0);
        if (pidField.test(buffer.subarray(0, length).toString("utf8"))) return true;
      } finally {
        closeSync(fd);
      }
    } catch {
      // A report that vanished or cannot be read is not evidence of a crash.
    }
  }
  return false;
}

export type MenuHelperReconcileOutcome =
  | { action: "idle"; reason: string }
  | { action: "running"; pid: number }
  | { action: "exited"; pid: number }
  | { action: "stopped"; bundlePath: string }
  | { action: "waiting"; nextLaunchAt: number }
  | { action: "launched"; bundlePath: string }
  | { action: "launch-failed"; bundlePath: string; detail: string };

export type MenuHelperSupervisorDeps = {
  desiredState: () => MenuHelperDesiredState;
  /** Other spellings of the bundle path, such as its real path, that a process may carry. */
  bundlePathAliases?: (bundlePath: string) => string[];
  listProcesses: () => Promise<ProcessCommand[]>;
  isAlive: (pid: number) => boolean;
  /** Whether this helper process crashed, as opposed to quitting. */
  crashed: (helper: { pid: number; bundlePath: string; sinceMs: number }) => boolean;
  open: (bundlePath: string) => Promise<{ ok: true } | { ok: false; detail: string }>;
  now: () => number;
  log: (message: string, details?: unknown) => void;
  warn: (message: string, details?: unknown) => void;
};

export class MenuHelperSupervisor {
  private tracked: { pid: number; bundlePath: string; since: number } | null = null;
  /** A tracked helper that went away, until it is classed as a crash or a quit. */
  private exited: { pid: number; bundlePath: string; since: number; at: number } | null = null;
  /** The bundle whose helper quit. Nothing is opened for it until a helper runs again. */
  private stoppedBundle: string | null = null;
  private restartDelayMs = MENU_HELPER_LAUNCH_GRACE_MS;
  private nextLaunchAt = 0;
  private reportedState: string | null = null;
  private reconciling = false;

  constructor(private readonly deps: MenuHelperSupervisorDeps) {}

  async reconcile(): Promise<MenuHelperReconcileOutcome> {
    if (this.reconciling) return { action: "idle", reason: "reconcile-in-progress" };
    this.reconciling = true;
    try {
      return await this.reconcileOnce();
    } finally {
      this.reconciling = false;
    }
  }

  private async reconcileOnce(): Promise<MenuHelperReconcileOutcome> {
    const desired = this.deps.desiredState();
    this.reportDesiredState(desired);
    if (!desired.run) {
      this.tracked = null;
      this.exited = null;
      this.stoppedBundle = null;
      return { action: "idle", reason: desired.reason };
    }
    const bundlePath = desired.bundlePath;
    if (this.exited && this.exited.bundlePath !== bundlePath) this.exited = null;
    if (this.stoppedBundle && this.stoppedBundle !== bundlePath) this.stoppedBundle = null;

    const now = this.deps.now();
    const tracked = this.tracked;
    if (tracked && tracked.bundlePath === bundlePath && this.deps.isAlive(tracked.pid)) {
      if (now - tracked.since >= MENU_HELPER_STABLE_AFTER_MS) {
        // A crash after a good run restarts at once, not after the last backoff.
        this.restartDelayMs = MENU_HELPER_LAUNCH_GRACE_MS;
        this.nextLaunchAt = 0;
      }
      return { action: "running", pid: tracked.pid };
    }

    const bundlePaths = [bundlePath, ...(this.deps.bundlePathAliases?.(bundlePath) ?? [])];
    const [found] = findMenuHelperProcesses(await this.deps.listProcesses(), bundlePaths);
    if (found) {
      if (!tracked || tracked.pid !== found.pid || tracked.bundlePath !== bundlePath) {
        this.deps.log("menu helper running", { pid: found.pid, bundlePath });
      }
      this.tracked = { pid: found.pid, bundlePath, since: now };
      this.exited = null;
      this.stoppedBundle = null;
      return { action: "running", pid: found.pid };
    }

    this.tracked = null;
    if (tracked && tracked.bundlePath === bundlePath) {
      this.exited = { pid: tracked.pid, bundlePath, since: tracked.since, at: now };
    }

    if (this.exited) {
      const exited = this.exited;
      if (this.deps.crashed({ pid: exited.pid, bundlePath, sinceMs: exited.since })) {
        this.deps.warn("menu helper crashed; restarting it", { pid: exited.pid, bundlePath });
        this.exited = null;
      } else if (now - exited.at < MENU_HELPER_CRASH_REPORT_WAIT_MS) {
        return { action: "exited", pid: exited.pid };
      } else {
        this.deps.log("menu helper quit; it stays down until it is opened again or the service restarts", {
          pid: exited.pid,
          bundlePath,
        });
        this.exited = null;
        this.stoppedBundle = bundlePath;
      }
    }
    if (this.stoppedBundle === bundlePath) return { action: "stopped", bundlePath };

    if (now < this.nextLaunchAt) return { action: "waiting", nextLaunchAt: this.nextLaunchAt };
    this.nextLaunchAt = now + this.restartDelayMs;
    this.restartDelayMs = Math.min(this.restartDelayMs * 2, MENU_HELPER_RESTART_MAX_DELAY_MS);

    const result = await this.deps.open(bundlePath);
    if (!result.ok) {
      this.deps.warn("menu helper launch failed", { bundlePath, detail: result.detail });
      return { action: "launch-failed", bundlePath, detail: result.detail };
    }
    this.deps.log("menu helper launch requested", { bundlePath, source: desired.source });
    return { action: "launched", bundlePath };
  }

  /** One line per change, so a missing bundle is reported once, not every few seconds. */
  private reportDesiredState(desired: MenuHelperDesiredState): void {
    const key = JSON.stringify(desired);
    if (key === this.reportedState) return;
    this.reportedState = key;
    if (desired.run) {
      this.deps.log("menu helper target", { bundlePath: desired.bundlePath, source: desired.source });
    } else if (desired.reason === "bundle-missing") {
      this.deps.warn("menu helper bundle not found; set apps.menu.bundlePath or apps.scoutAppPath in settings.json", {
        bundlePath: desired.bundlePath,
        source: desired.source,
      });
    } else {
      this.deps.log("menu helper not supervised", { reason: desired.reason });
    }
  }
}

/**
 * Opens the bundle through LaunchServices as a new instance, in the background.
 * The supervisor opens only when no helper from this bundle is running, and a
 * new instance keeps LaunchServices from handing the open to another bundle's
 * helper. LaunchServices, not a direct exec, keeps macOS attributing the
 * helper's permissions to the helper.
 */
export function openMenuHelperBundle(bundlePath: string, timeoutMs = 10_000): Promise<{ ok: true } | { ok: false; detail: string }> {
  return new Promise((resolveOpen) => {
    let settled = false;
    const settle = (result: { ok: true } | { ok: false; detail: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveOpen(result);
    };
    let stderr = "";
    const child = spawn("open", ["-n", "-g", bundlePath], { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 2_000) stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ ok: false, detail: `open timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (error) => settle({ ok: false, detail: error.message }));
    child.once("exit", (code) => settle(code === 0 ? { ok: true } : { ok: false, detail: stderr.trim() || `open exited ${code}` }));
  });
}
