/**
 * The shared Scout MCP server as a supervised service.
 *
 * One `scout mcp serve` process can serve every local Claude and Codex
 * session (see packages/cli/src/mcp/shared-http.ts). It is opt-in:
 * `scout mcp install --shared` writes an opt-in file in the instance's
 * support directory, and scout-base runs the server on the instance's `mcp`
 * port while that file exists. `scout mcp install --force` removes it.
 */
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { deriveOpenScoutInstanceLayout } from "./instance.js";

export const SHARED_MCP_OPT_IN_FILE = "shared-mcp.json";

export type SharedMcpOptIn = { url: string; port: number; enabledAt: number };

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
    return { url: sharedMcpUrl(value.port), port: value.port, enabledAt: Number(value.enabledAt) || 0 };
  } catch {
    return null;
  }
}

export function writeSharedMcpOptIn(supportDirectory: string, port: number, now = Date.now()): SharedMcpOptIn {
  const optIn: SharedMcpOptIn = { url: sharedMcpUrl(port), port, enabledAt: now };
  writeFileSync(sharedMcpOptInPath(supportDirectory), `${JSON.stringify(optIn, null, 2)}\n`);
  return optIn;
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
 * MCP at the shared server. Empty when the shared server is off.
 */
export function sharedMcpLaunchEnvironment(supportDirectory: string): Record<string, string> {
  const optIn = readSharedMcpOptIn(supportDirectory);
  return optIn ? { OPENSCOUT_MCP_SHARED_URL: optIn.url } : {};
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
