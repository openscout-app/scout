/**
 * Host-side adapter for broker install/start/stop/status via the
 * `openscout-runtime service …` CLI. This is shell/distribution plumbing, not
 * Scout core domain logic.
 */
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrokerServiceStatus } from "@openscout/runtime/broker-process-manager";
import {
  resolveExecutableFromSearch,
  resolveJavaScriptRuntime,
  resolveNodeModulesPackageEntrypoint,
  resolveOpenScoutRepoRoot,
  resolveRepoEntrypoint,
} from "@openscout/runtime/tool-resolution";

const BROKER_STATUS_CACHE_TTL_MS = 2_000;

let cachedBrokerStatus: { value: BrokerServiceStatus; expiresAt: number } | null = null;
let inflightBrokerStatus: Promise<BrokerServiceStatus> | null = null;

type ResolveRuntimeServiceEntrypointOptions = {
  env?: NodeJS.ProcessEnv;
  moduleUrl?: string | URL;
  currentWorkingDirectory?: string;
};

function resolveJavaScriptRuntimeExecutable(): string {
  const runtime = resolveJavaScriptRuntime({
    env: process.env,
    explicitEnvKeys: ["OPENSCOUT_RUNTIME_NODE_BIN"],
    allowNode: true,
    allowBun: true,
  });
  if (runtime) {
    return runtime.path;
  }

  throw new Error(
    "No JavaScript runtime found for openscout-runtime script entry. Install Node.js or set OPENSCOUT_RUNTIME_NODE_BIN.",
  );
}

/**
 * Path to the `openscout-runtime` entry (wrapper .mjs or an executable on PATH).
 * Does not import broker logic; it only locates the runtime control entrypoint.
 */
export function resolveRuntimeServiceEntrypoint(options: ResolveRuntimeServiceEntrypointOptions = {}): string {
  const env = options.env ?? process.env;
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const currentWorkingDirectory = options.currentWorkingDirectory ?? process.cwd();

  const explicitRuntimeEntrypoint = resolveExecutableFromSearch({
    env,
    envKeys: ["OPENSCOUT_RUNTIME_BIN"],
    names: [],
  });
  if (explicitRuntimeEntrypoint) {
    return explicitRuntimeEntrypoint.path;
  }

  const fromNodeModules = resolveNodeModulesPackageEntrypoint(
    moduleUrl,
    ["@openscout", "runtime"],
    "bin/openscout-runtime.mjs",
  );
  if (fromNodeModules) {
    return fromNodeModules;
  }

  const repoRoot = resolveOpenScoutRepoRoot({
    startDirectories: [
      env.OPENSCOUT_SETUP_CWD,
      currentWorkingDirectory,
      dirname(fileURLToPath(moduleUrl)),
    ],
  });
  const repoEntrypoint = resolveRepoEntrypoint(repoRoot, "packages/runtime/bin/openscout-runtime.mjs");
  if (repoEntrypoint) {
    return repoEntrypoint;
  }

  const installedExecutable = resolveExecutableFromSearch({
    env,
    names: ["openscout-runtime"],
  });
  if (installedExecutable) {
    return installedExecutable.path;
  }

  throw new Error(
    "openscout-runtime not found on PATH. Install Scout with `bun add -g @openscout/scout`, or set OPENSCOUT_RUNTIME_BIN.",
  );
}

function spawnArgsForRuntime(entry: string, serviceArgs: string[]): { command: string; args: string[] } {
  const isScript = entry.endsWith(".mjs") || entry.endsWith(".js") || entry.endsWith(".cjs");
  if (isScript) {
    return { command: resolveJavaScriptRuntimeExecutable(), args: [entry, "service", ...serviceArgs] };
  }
  return { command: entry, args: ["service", ...serviceArgs] };
}

/**
 * Run `openscout-runtime service <subcommand> --json` and parse stdout as {@link BrokerServiceStatus}.
 */
export async function runRuntimeBrokerService(
  subcommand: "start" | "stop" | "restart" | "status" | "install" | "uninstall",
): Promise<BrokerServiceStatus> {
  if (subcommand !== "status") {
    invalidateRuntimeBrokerServiceStatus();
  }

  const entry = resolveRuntimeServiceEntrypoint();
  const { command, args } = spawnArgsForRuntime(entry, [subcommand, "--json"]);

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const code = await new Promise<number>((resolveExit, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutChunks.push(chunk);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrChunks.push(chunk);
    });
    child.on("error", reject);
    child.on("exit", (exitCode) => {
      resolveExit(exitCode ?? 1);
    });
  });

  const stdout = stdoutChunks.join("").trim();
  const stderr = stderrChunks.join("").trim();

  if (code !== 0) {
    const detail = stderr || stdout || `exit ${code}`;
    throw new Error(`openscout-runtime service ${subcommand} failed: ${detail}`);
  }

  try {
    const parsed = JSON.parse(stdout) as BrokerServiceStatus;
    cachedBrokerStatus = {
      value: parsed,
      expiresAt: Date.now() + BROKER_STATUS_CACHE_TTL_MS,
    };
    return parsed;
  } catch {
    throw new Error(
      `openscout-runtime service ${subcommand} returned non-JSON stdout: ${stdout.slice(0, 400)}`,
    );
  }
}

export function invalidateRuntimeBrokerServiceStatus(): void {
  cachedBrokerStatus = null;
}

export async function getRuntimeBrokerServiceStatus(options: { force?: boolean } = {}): Promise<BrokerServiceStatus> {
  const force = options.force ?? false;

  if (!force && cachedBrokerStatus && cachedBrokerStatus.expiresAt > Date.now()) {
    return cachedBrokerStatus.value;
  }

  if (!force && inflightBrokerStatus) {
    return inflightBrokerStatus;
  }

  inflightBrokerStatus = runRuntimeBrokerService("status")
    .finally(() => {
      inflightBrokerStatus = null;
    });

  return inflightBrokerStatus;
}
