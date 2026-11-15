/**
 * The shared Scout MCP server as a supervised service.
 *
 * One `scout mcp serve` process can serve every local Claude and Codex
 * session (see packages/cli/src/mcp/shared-http.ts). It is opt-in:
 * `scout mcp install --shared` writes an opt-in file in the instance's
 * support directory, and scout-base runs the server on the instance's `mcp`
 * port while that file exists.
 *
 * `scout mcp install --force` turns it off by draining, not stopping: new
 * launches stop getting the shared URL, but sessions already pointed at it
 * keep it (a Codex app-server's launch flags and a running session's loaded
 * config can't be changed from outside). Every process pointed at the server
 * is registered as an empty file named by its pid in `shared-mcp-clients/`:
 * by the runtime when it starts a Codex app-server with the URL, and by the
 * server when a session opens, before it answers. scout-base removes the
 * opt-in, which stops the server, once no registered process is alive.
 */
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { deriveOpenScoutInstanceLayout } from "./instance.js";

export const SHARED_MCP_OPT_IN_FILE = "shared-mcp.json";

export type SharedMcpOptIn = {
  url: string;
  port: number;
  enabledAt: number;
  /** "draining": off for new launches, kept up while a registered client is alive. */
  state: "on" | "draining";
};

export const SHARED_MCP_CLIENTS_DIRECTORY = "shared-mcp-clients";

export function sharedMcpClientsDirectory(supportDirectory: string): string {
  return join(supportDirectory, SHARED_MCP_CLIENTS_DIRECTORY);
}

/**
 * Registers a process as pointed at the shared server: an empty file named by
 * its pid. One file per process, so writers never race. The server and
 * agent-sessions write the same file shape (OPENSCOUT_MCP_SHARED_CLIENTS_DIR).
 */
export function registerSharedMcpClient(clientsDirectory: string, pid: number): void {
  mkdirSync(clientsDirectory, { recursive: true });
  writeFileSync(join(clientsDirectory, String(pid)), "");
}

/** Registered clients still alive; the files of exited ones are removed. */
export function liveSharedMcpClients(supportDirectory: string, isAlive: (pid: number) => boolean = isSharedMcpClientAlive): number[] {
  const directory = sharedMcpClientsDirectory(supportDirectory);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const live: number[] = [];
  for (const name of names) {
    const pid = Number(name);
    if (Number.isInteger(pid) && pid > 1 && isAlive(pid)) {
      live.push(pid);
    } else {
      rmSync(join(directory, name), { force: true });
    }
  }
  return live.sort((a, b) => a - b);
}

export function sharedMcpOptInPath(supportDirectory: string): string {
  return join(supportDirectory, SHARED_MCP_OPT_IN_FILE);
}

/** The shared server's port for the current instance (prod: 43115). */
export function sharedMcpPort(env: NodeJS.ProcessEnv = process.env): number {
  return deriveOpenScoutInstanceLayout({ env }).ports.mcp;
}

export function sharedMcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

/** The opt-in, or null when the shared server is off (or the file is unreadable). */
export function readSharedMcpOptIn(supportDirectory: string): SharedMcpOptIn | null {
  try {
    const value = JSON.parse(readFileSync(sharedMcpOptInPath(supportDirectory), "utf8")) as Partial<SharedMcpOptIn>;
    if (typeof value.port !== "number" || !Number.isInteger(value.port) || value.port <= 0) return null;
    return {
      url: sharedMcpUrl(value.port),
      port: value.port,
      enabledAt: Number(value.enabledAt) || 0,
      state: value.state === "draining" ? "draining" : "on",
    };
  } catch {
    return null;
  }
}

function saveOptIn(supportDirectory: string, optIn: SharedMcpOptIn): SharedMcpOptIn {
  const path = sharedMcpOptInPath(supportDirectory);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(optIn, null, 2)}\n`);
  renameSync(temp, path);
  return optIn;
}

/** Turns the shared server on, or back on from draining. */
export function writeSharedMcpOptIn(supportDirectory: string, port: number, now = Date.now()): SharedMcpOptIn {
  const previous = readSharedMcpOptIn(supportDirectory);
  return saveOptIn(supportDirectory, {
    url: sharedMcpUrl(port),
    port,
    enabledAt: previous?.port === port ? previous.enabledAt : now,
    state: "on",
  });
}

/** Puts back an opt-in exactly as it was read (used to undo a failed enable). */
export function restoreSharedMcpOptIn(supportDirectory: string, optIn: SharedMcpOptIn): void {
  saveOptIn(supportDirectory, optIn);
}

/** Off for new launches; scout-base stops the server once its clients have exited. False when it was not on. */
export function drainSharedMcpOptIn(supportDirectory: string): boolean {
  const optIn = readSharedMcpOptIn(supportDirectory);
  if (!optIn) return false;
  if (optIn.state !== "draining") saveOptIn(supportDirectory, { ...optIn, state: "draining" });
  return true;
}

export function isSharedMcpClientAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * One scout-base step before reconcile: a draining opt-in with no registered
 * client alive is removed, so reconcile stops the server. The opt-in is read
 * again after the clients are listed, so a `scout mcp install --shared` that
 * ran meanwhile wins.
 */
export function settleSharedMcpOptIn(
  supportDirectory: string,
  options: { isAlive?: (pid: number) => boolean; log?: (message: string, detail?: unknown) => void } = {},
): SharedMcpOptIn | null {
  const optIn = readSharedMcpOptIn(supportDirectory);
  if (!optIn) return null;
  const live = liveSharedMcpClients(supportDirectory, options.isAlive);
  if (optIn.state !== "draining" || live.length > 0) return optIn;
  if (readSharedMcpOptIn(supportDirectory)?.state !== "draining") return readSharedMcpOptIn(supportDirectory);
  removeSharedMcpOptIn(supportDirectory);
  options.log?.("shared MCP server drained: no process pointed at it is still running");
  return null;
}

/** True when there was an opt-in to remove. */
export function removeSharedMcpOptIn(supportDirectory: string): boolean {
  const path = sharedMcpOptInPath(supportDirectory);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/**
 * Environment for a harness that Scout starts, so its launch can point Scout
 * MCP at the shared server. Empty when the shared server is off or draining.
 */
export function sharedMcpLaunchEnvironment(supportDirectory: string): Record<string, string> {
  const optIn = readSharedMcpOptIn(supportDirectory);
  return optIn?.state === "on"
    ? { OPENSCOUT_MCP_SHARED_URL: optIn.url, OPENSCOUT_MCP_SHARED_CLIENTS_DIR: sharedMcpClientsDirectory(supportDirectory) }
    : {};
}

export type SharedMcpCommand = { command: string; args: string[]; cwd: string };

/**
 * How scout-base starts the shared server: the CLI entrypoint run with Bun,
 * since the server uses Bun.serve. An explicit OPENSCOUT_CLI_BIN wins; then
 * the source checkout's CLI; then the CLI packaged beside this runtime.
 */
export function resolveSharedMcpCommand(options: {
  port: number;
  bunExecutable: string | null;
  repoRoot: string | null;
  runtimePackageDir: string;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}): SharedMcpCommand | null {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const serveArgs = ["mcp", "serve", "--host", "127.0.0.1", "--port", String(options.port)];
  if (env.OPENSCOUT_MCP_ENABLE_NOTIFICATIONS === "1") serveArgs.push("--notifications");

  const explicit = [env.OPENSCOUT_CLI_BIN, env.SCOUT_CLI_BIN].map((value) => value?.trim()).find((value) => value && exists(value));
  if (explicit) return { command: explicit, args: serveArgs, cwd: options.runtimePackageDir };

  if (!options.bunExecutable) return null;
  const entrypoints = [
    options.repoRoot ? join(options.repoRoot, "packages", "cli", "bin", "scout.mjs") : null,
    join(options.runtimePackageDir, "bin", "scout.mjs"),
  ];
  const entrypoint = entrypoints.find((candidate): candidate is string => Boolean(candidate) && exists(candidate!));
  return entrypoint
    ? { command: options.bunExecutable, args: [entrypoint, ...serveArgs], cwd: options.runtimePackageDir }
    : null;
}

export const SHARED_MCP_MIN_RESTART_MS = 1_000;
export const SHARED_MCP_MAX_RESTART_MS = 60_000;
/** A server that ran this long was healthy; its next restart starts from the minimum delay. */
export const SHARED_MCP_STABLE_AFTER_MS = 60_000;

/**
 * Keeps one shared server running while `desired()` is true, and none while
 * it is false. Call `reconcile()` on a timer. A server that exits is
 * restarted with a doubling delay. Process and time edges are injectable, so
 * tests never touch the live supervisor.
 */
export function createSharedMcpSupervisor(options: {
  desired: () => boolean;
  spawn: () => ChildProcess;
  terminate: (child: ChildProcess) => Promise<void>;
  log: (message: string, detail?: unknown) => void;
  warn: (message: string, detail?: unknown) => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let child: ChildProcess | null = null;
  let startedAt = 0;
  let nextStartAt = 0;
  let delay = SHARED_MCP_MIN_RESTART_MS;
  let busy = false;
  let stopped = false;

  const scheduleRestart = () => {
    nextStartAt = now() + delay;
    delay = Math.min(delay * 2, SHARED_MCP_MAX_RESTART_MS);
  };

  const start = () => {
    let current: ChildProcess;
    try {
      current = options.spawn();
    } catch (error) {
      options.warn("shared MCP server could not start; retrying", error instanceof Error ? error.message : String(error));
      scheduleRestart();
      return;
    }
    child = current;
    startedAt = now();
    options.log("shared MCP server started", { pid: current.pid });
    let ended = false;
    const end = (code?: number | Error | null, signal?: NodeJS.Signals | null) => {
      if (ended) return;
      ended = true;
      if (child !== current) return;
      child = null;
      if (stopped) return;
      if (now() - startedAt >= SHARED_MCP_STABLE_AFTER_MS) delay = SHARED_MCP_MIN_RESTART_MS;
      scheduleRestart();
      options.warn("shared MCP server exited; restarting", { code: code instanceof Error ? code.message : code, signal, retryInMs: nextStartAt - now() });
    };
    current.once("exit", end);
    current.once("error", end);
  };

  return {
    async reconcile(): Promise<void> {
      if (busy || stopped) return;
      busy = true;
      try {
        if (!options.desired()) {
          delay = SHARED_MCP_MIN_RESTART_MS;
          nextStartAt = 0;
          const current = child;
          if (current) {
            child = null;
            options.log("stopping shared MCP server: the opt-in was removed", { pid: current.pid });
            await options.terminate(current);
          }
          return;
        }
        if (!child && now() >= nextStartAt) start();
      } finally {
        busy = false;
      }
    },
    running: () => child !== null,
    async stop(): Promise<void> {
      stopped = true;
      const current = child;
      child = null;
      if (current) await options.terminate(current);
    },
  };
}
