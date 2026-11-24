import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveOpenScoutSupportPaths } from "@openscout/runtime/config";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import {
  findCachedReleaseBinary,
  installReleaseBinary,
  listCachedReleaseVersions,
  releaseTargetFor,
  removeCachedReleaseBinaries,
  unsupportedPlatformMessage,
  type ReleaseFetch,
} from "../release-binary.ts";
import { SCOUT_APP_VERSION } from "../../lib/shared/product.ts";

const HELP_FLAGS = new Set(["--help", "-h", "help"]);
const SCOUT_TUI_BIN_NAME = "scout-tui";

/** Where Scout.app carries the TUI: a signed helper bundle, so hkit and notarization treat it like any other nested code. */
export const SCOUT_APP_TUI_RELATIVE_PATH = "Contents/Helpers/ScoutTUI.app/Contents/MacOS/scout-tui";

export type TuiLaunchOptions =
  | { mode: "help" }
  | { mode: "install"; force: boolean }
  | { mode: "status" }
  | { mode: "uninstall" }
  | { mode: "monitor"; args: string[] }
  | { mode: "instrument"; passthrough: string[] };

export type ScoutTuiSource = "env" | "checkout" | "path" | "app" | "cache";

export type ScoutTuiLaunch =
  | { kind: "bin"; command: string; args: string[]; source: ScoutTuiSource }
  | { kind: "cargo"; command: string; args: string[]; cwd: string }
  | { kind: "download"; version: string };

export type ScoutTuiResolveInput = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  platform?: NodeJS.Platform;
  version?: string;
  supportDirectory?: string;
  /** Overrides checkout discovery (null = not in a checkout). */
  checkout?: string | null;
  /** Overrides the Scout.app bundles searched. */
  appBundles?: string[];
};

export type TuiCommandDependencies = {
  spawnSync?: typeof spawnSync;
  exit?: (code: number) => void;
  fetchImpl?: ReleaseFetch;
  supportDirectory?: string;
  version?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  checkout?: string | null;
  appBundles?: string[];
  stallTimeoutMs?: number;
  retryDelayMs?: number;
};

export function renderTuiCommandHelp(): string {
  return [
    "Usage:",
    "  scout tui [--take now|horizon|twin|mesh|quota|harvest|grid]",
    "  scout tui [--composition focus|watch|review|quad]",
    "  scout tui --ambient shimmer  Subtle background light; Ctrl+S toggles it",
    "  scout tui --probe",
    "  scout tui install [--force]   Download scout-tui for this Scout version now",
    "  scout tui status              Show which scout-tui would run",
    "  scout tui uninstall           Remove downloaded copies",
    "",
    "Launch the Scout TUI in this terminal.",
    "",
    "This is the ratatui night instrument. The legacy v1 OpenTUI console `scout monitor` is retired.",
    "",
    "Binary resolution, in order:",
    "  SCOUT_TUI_BIN (offline or custom builds)",
    "  <checkout>/target/release/scout-tui",
    "  <checkout>/target/debug/scout-tui",
    "  scout-tui on PATH",
    `  Scout.app (${SCOUT_APP_TUI_RELATIVE_PATH})`,
    "  a downloaded copy for this Scout version",
    "  cargo run from crates/scout-tui in an OpenScout checkout",
    "  download from the openscout-app/scout GitHub release (sha256-checked, first run only)",
    "",
    "Examples:",
    "  scout tui",
    "  scout tui --take mesh",
    "  scout tui --composition watch",
  ].join("\n");
}

export function parseTuiLaunchOptions(args: string[]): TuiLaunchOptions {
  if (args.some((arg) => HELP_FLAGS.has(arg))) return { mode: "help" };

  const [first, ...rest] = args;
  if (first === "install") return { mode: "install", force: rest.includes("--force") };
  if (first === "status") return { mode: "status" };
  if (first === "uninstall") return { mode: "uninstall" };

  const monitorIndex = args.findIndex((arg) => arg === "--monitor" || arg === "monitor");
  if (monitorIndex >= 0) {
    return {
      mode: "monitor",
      args: args.filter((_, index) => index !== monitorIndex),
    };
  }

  return { mode: "instrument", passthrough: args };
}

export function scoutTuiCacheRoot(supportDirectory?: string): string {
  return join(supportDirectory ?? resolveOpenScoutSupportPaths().supportDirectory, "tools", SCOUT_TUI_BIN_NAME);
}

function defaultAppBundles(checkout: string | null, env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME?.trim() || homedir();
  return [
    ...(checkout ? [join(checkout, "apps/macos/dist/Scout.app")] : []),
    "/Applications/Scout.app",
    join(home, "Applications/Scout.app"),
  ];
}

/**
 * Resolve without touching the network. `download` means nothing local was
 * found and the caller should fetch this version's release build.
 */
export function resolveScoutTuiLaunch(input: ScoutTuiResolveInput = {}): ScoutTuiLaunch {
  const env = input.env ?? process.env;
  const cwd = resolve(input.cwd ?? process.cwd());
  const configured = env.SCOUT_TUI_BIN?.trim();
  if (configured) {
    if (!isExecutable(configured)) {
      throw new ScoutCliError(`SCOUT_TUI_BIN is not executable: ${configured}`);
    }
    return { kind: "bin", command: configured, args: [], source: "env" };
  }

  const checkout = input.checkout !== undefined ? input.checkout : findScoutTuiCheckout(cwd, env);
  if (checkout) {
    for (const candidate of [
      join(checkout, "target/release", SCOUT_TUI_BIN_NAME),
      join(checkout, "target/debug", SCOUT_TUI_BIN_NAME),
    ]) {
      if (isExecutable(candidate)) {
        return { kind: "bin", command: candidate, args: [], source: "checkout" };
      }
    }
  }

  const onPath = commandOnPath(SCOUT_TUI_BIN_NAME, env);
  if (onPath) {
    return { kind: "bin", command: onPath, args: [], source: "path" };
  }

  if ((input.platform ?? process.platform) === "darwin") {
    for (const bundle of input.appBundles ?? defaultAppBundles(checkout, env)) {
      const candidate = join(bundle, SCOUT_APP_TUI_RELATIVE_PATH);
      if (isExecutable(candidate)) {
        return { kind: "bin", command: candidate, args: [], source: "app" };
      }
    }
  }

  const version = input.version ?? SCOUT_APP_VERSION;
  const cached = findCachedReleaseBinary({
    name: SCOUT_TUI_BIN_NAME,
    version,
    cacheRoot: scoutTuiCacheRoot(input.supportDirectory),
  });
  if (cached) {
    return { kind: "bin", command: cached.path, args: [], source: "cache" };
  }

  if (checkout) {
    const cargo = cargoRunner(checkout, env);
    if (cargo) {
      return {
        kind: "cargo",
        command: cargo.command,
        args: [
          ...cargo.prefixArgs,
          "run",
          "--manifest-path",
          "crates/scout-tui/Cargo.toml",
          "--bin",
          SCOUT_TUI_BIN_NAME,
        ],
        cwd: checkout,
      };
    }
  }

  return { kind: "download", version };
}

async function downloadScoutTui(
  context: ScoutCommandContext,
  version: string,
  dependencies: TuiCommandDependencies,
): Promise<string> {
  const installed = await installReleaseBinary({
    name: SCOUT_TUI_BIN_NAME,
    version,
    cacheRoot: scoutTuiCacheRoot(dependencies.supportDirectory),
    env: context.env,
    platform: dependencies.platform,
    arch: dependencies.arch,
    fetchImpl: dependencies.fetchImpl,
    stallTimeoutMs: dependencies.stallTimeoutMs,
    retryDelayMs: dependencies.retryDelayMs,
    log: (line) => context.stderr(line),
  });
  return installed.path;
}

function resolveInputFrom(context: ScoutCommandContext, dependencies: TuiCommandDependencies): ScoutTuiResolveInput {
  return {
    env: context.env,
    cwd: context.cwd,
    platform: dependencies.platform,
    version: dependencies.version,
    supportDirectory: dependencies.supportDirectory,
    checkout: dependencies.checkout,
    appBundles: dependencies.appBundles,
  };
}

const SOURCE_LABEL: Record<ScoutTuiSource, string> = {
  env: "SCOUT_TUI_BIN",
  checkout: "checkout build",
  path: "PATH",
  app: "Scout.app",
  cache: "downloaded",
};

async function runTuiInstall(
  context: ScoutCommandContext,
  force: boolean,
  dependencies: TuiCommandDependencies,
): Promise<void> {
  const version = dependencies.version ?? SCOUT_APP_VERSION;
  const cacheRoot = scoutTuiCacheRoot(dependencies.supportDirectory);
  const cached = findCachedReleaseBinary({ name: SCOUT_TUI_BIN_NAME, version, cacheRoot });
  if (cached && !force) {
    context.output.writeText(`scout-tui ${version} is already installed → ${cached.path}. --force reinstalls it.`);
    return;
  }
  const path = await downloadScoutTui(context, version, dependencies);
  context.output.writeText(`Installed scout-tui ${version} → ${path}`);
}

function runTuiStatus(context: ScoutCommandContext, dependencies: TuiCommandDependencies): void {
  const version = dependencies.version ?? SCOUT_APP_VERSION;
  const cacheRoot = scoutTuiCacheRoot(dependencies.supportDirectory);
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  let launch: ScoutTuiLaunch | null = null;
  let problem: string | null = null;
  try {
    launch = resolveScoutTuiLaunch(resolveInputFrom(context, dependencies));
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }
  const status = {
    version,
    target: releaseTargetFor(platform, arch),
    runs: launch?.kind === "bin"
      ? { source: launch.source, path: launch.command }
      : launch?.kind === "cargo"
        ? { source: "cargo", path: launch.cwd }
        : null,
    downloadNeeded: launch?.kind === "download",
    cacheRoot,
    cachedVersions: listCachedReleaseVersions(cacheRoot),
    problem,
  };
  context.output.writeValue(status, (value) => {
    const runs = value.runs
      ? value.runs.source === "cargo"
        ? `cargo run in ${value.runs.path}`
        : `${value.runs.path} (${SOURCE_LABEL[value.runs.source as ScoutTuiSource]})`
      : value.downloadNeeded
        ? value.target
          ? "nothing local yet; `scout tui` (or `scout tui install`) downloads it"
          : unsupportedPlatformMessage(SCOUT_TUI_BIN_NAME, platform, arch)
        : `error: ${value.problem}`;
    return [
      `scout-tui for Scout ${value.version}${value.target ? ` (${value.target})` : ""}`,
      `runs       ${runs}`,
      `downloads  ${value.cachedVersions.length > 0 ? value.cachedVersions.join(", ") : "none"} in ${value.cacheRoot}`,
    ].join("\n");
  });
}

function runTuiUninstall(context: ScoutCommandContext, dependencies: TuiCommandDependencies): void {
  const removed = removeCachedReleaseBinaries(scoutTuiCacheRoot(dependencies.supportDirectory));
  context.output.writeText(removed ? "Removed downloaded scout-tui copies." : "No downloaded scout-tui to remove.");
}

export const SCOUT_TUI_INSTALL_OFFER = "Optional: the terminal UI isn't installed. `scout tui install` downloads it (a few MB), or `scout tui` fetches it on first run.";

/** True when `scout tui` would have to download before it can start. Local checks only. */
export function scoutTuiNeedsDownload(input: ScoutTuiResolveInput = {}): boolean {
  try {
    return resolveScoutTuiLaunch(input).kind === "download";
  } catch {
    return false;
  }
}

export async function runTuiCommand(
  context: ScoutCommandContext,
  args: string[],
  dependencies: TuiCommandDependencies = {},
): Promise<void> {
  const options = parseTuiLaunchOptions(args);
  if (options.mode === "status") {
    runTuiStatus(context, dependencies);
    return;
  }
  if (context.output.mode === "json") {
    throw new ScoutCliError("scout tui does not support --json");
  }

  if (options.mode === "help") {
    context.output.writeText(renderTuiCommandHelp());
    return;
  }
  if (options.mode === "install") {
    await runTuiInstall(context, options.force, dependencies);
    return;
  }
  if (options.mode === "uninstall") {
    runTuiUninstall(context, dependencies);
    return;
  }

  if (options.mode === "monitor") {
    context.stderr("`scout monitor` (the legacy v1 OpenTUI console) has been retired. Use `scout tui`.");
    return;
  }

  const resolved = resolveScoutTuiLaunch(resolveInputFrom(context, dependencies));
  const launch: Exclude<ScoutTuiLaunch, { kind: "download" }> = resolved.kind === "download"
    ? { kind: "bin", command: await downloadScoutTui(context, resolved.version, dependencies), args: [], source: "cache" }
    : resolved;
  const argv = launch.kind === "cargo"
    ? [...launch.args, "--", ...options.passthrough]
    : [...launch.args, ...options.passthrough];
  const result = (dependencies.spawnSync ?? spawnSync)(launch.command, argv, {
    stdio: "inherit",
    env: context.env,
    cwd: launch.kind === "cargo" ? launch.cwd : context.cwd,
  });
  finishSpawn(result, dependencies.exit ?? ((code) => process.exit(code)));
}

function finishSpawn(
  result: SpawnSyncReturns<string | Buffer>,
  exit: (code: number) => void,
): void {
  if (result.error) {
    throw new ScoutCliError(`failed to launch scout-tui: ${result.error.message}`);
  }
  if (result.status !== null && result.status !== 0) {
    exit(result.status);
  }
  if (result.signal) {
    throw new ScoutCliError(`scout-tui terminated by ${result.signal}`);
  }
}

function findScoutTuiCheckout(cwd: string, env: NodeJS.ProcessEnv): string | null {
  const starts = [
    cwd,
    env.OPENSCOUT_SETUP_CWD?.trim(),
    dirname(fileURLToPath(import.meta.url)),
  ].filter((value): value is string => Boolean(value));

  for (const start of starts) {
    let current = resolve(start);
    while (true) {
      if (existsSync(join(current, "crates/scout-tui/Cargo.toml"))) {
        return current;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return null;
}

function cargoRunner(checkout: string, env: NodeJS.ProcessEnv): {
  command: string;
  prefixArgs: string[];
} | null {
  const script = join(checkout, "scripts/cargo.sh");
  if (isExecutable(script)) {
    return { command: script, prefixArgs: [] };
  }
  const cargo = env.CARGO?.trim() || commandOnPath("cargo", env);
  return cargo ? { command: cargo, prefixArgs: [] } : null;
}

function commandOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const pathValue = env.PATH ?? "";
  for (const directory of pathValue.split(":")) {
    const trimmed = directory.trim();
    if (!trimmed) continue;
    const candidate = join(trimmed, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
