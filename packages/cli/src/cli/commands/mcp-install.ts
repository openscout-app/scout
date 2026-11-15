import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { deriveOpenScoutInstanceLayout } from "@openscout/runtime/instance";
import {
  readSharedMcpOptIn,
  removeSharedMcpOptIn,
  sharedMcpOptInPath,
  sharedMcpPort,
  sharedMcpUrl,
  writeSharedMcpOptIn,
} from "@openscout/runtime/shared-mcp";
import { resolveOpenScoutSupportPaths } from "@openscout/runtime/support-paths";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { planZedScoutContextServer, zedSettingsPath } from "./zed-settings.ts";

export type ScoutMcpInstallHost = "claude" | "codex" | "zed";

const SUPPORTED_HOSTS = ["codex", "claude", "zed"] as const;

type ScoutMcpInstallOptions = {
  dryRun: boolean;
  force: boolean;
  shared: boolean;
  hosts: ScoutMcpInstallHost[];
};

type ScoutMcpLaunchCommand = {
  command: string;
  args: string[];
};

/** How a host reaches Scout MCP: its own stdio server, or the shared HTTP server. */
type ScoutMcpTransport =
  | ({ kind: "stdio" } & ScoutMcpLaunchCommand)
  | { kind: "http"; url: string };

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

type CommandRunner = (
  command: string,
  args: string[],
) => CommandResult;

type HostInstallOutcome =
  | {
      host: ScoutMcpInstallHost;
      status: "installed" | "already_installed";
      detail: string;
    }
  | {
      host: ScoutMcpInstallHost;
      status: "skipped" | "failed";
      detail: string;
    };

const HELP_FLAGS = new Set(["--help", "-h"]);

function isExecutable(filePath: string | undefined | null): filePath is string {
  if (!filePath) {
    return false;
  }

  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveExecutableFromSearchPath(
  names: string[],
  env: NodeJS.ProcessEnv,
): string | null {
  const pathEntries = (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean);
  const commonDirectories = [
    join(homedir(), ".local", "bin"),
    join(homedir(), ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/Applications/Codex.app/Contents/Resources",
  ];

  for (const directory of [...pathEntries, ...commonDirectories]) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

/**
 * Zed has no command for adding an MCP server, so Scout edits its user
 * settings file. Zed counts as installed when its config directory, its app,
 * or its CLI is present.
 */
function resolveZedSettingsPath(env: NodeJS.ProcessEnv): string | null {
  const settingsPath = zedSettingsPath(env);
  const home = env.HOME || homedir();
  const installed = existsSync(dirname(settingsPath))
    || (process.platform === "darwin"
      && [join("/Applications", "Zed.app"), join(home, "Applications", "Zed.app")].some((app) => existsSync(app)))
    || resolveExecutableFromSearchPath(["zed", "zeditor"], env) !== null;
  return installed ? settingsPath : null;
}

/** The host's executable, or for Zed its settings file. */
function resolveHostPath(
  host: ScoutMcpInstallHost,
  env: NodeJS.ProcessEnv,
): string | null {
  if (host === "codex") {
    return resolveExecutableFromSearchPath(["codex"], env);
  }
  if (host === "zed") {
    return resolveZedSettingsPath(env);
  }
  return resolveExecutableFromSearchPath(["claude"], env);
}

export function resolveCurrentScoutMcpLaunchCommand(
  env: NodeJS.ProcessEnv,
): ScoutMcpLaunchCommand {
  const explicitCandidates = [
    env.OPENSCOUT_CLI_BIN,
    env.SCOUT_CLI_BIN,
    env.OPENSCOUT_SCOUT_BIN,
    env.SCOUT_BIN,
  ];
  for (const candidate of explicitCandidates) {
    if (isExecutable(candidate)) {
      return {
        command: candidate,
        args: ["mcp"],
      };
    }
  }

  const scoutExecutable = resolveExecutableFromSearchPath(["scout"], env);
  if (scoutExecutable) {
    return {
      command: scoutExecutable,
      args: ["mcp"],
    };
  }

  throw new ScoutCliError(
    "Could not resolve a stable Scout launcher. Install @openscout/scout globally or set OPENSCOUT_CLI_BIN; do not register a node_modules script.",
  );
}

function parseFlagValue(args: string[], index: number, flag: string): {
  value: string;
  nextIndex: number;
} {
  const current = args[index] ?? "";
  if (current === flag) {
    const value = args[index + 1];
    if (!value) {
      throw new ScoutCliError(`missing value for ${flag}`);
    }
    return { value, nextIndex: index + 1 };
  }

  const prefix = `${flag}=`;
  if (current.startsWith(prefix)) {
    return { value: current.slice(prefix.length), nextIndex: index };
  }

  throw new ScoutCliError(`missing value for ${flag}`);
}

function parseHostValue(value: string): ScoutMcpInstallHost {
  if ((SUPPORTED_HOSTS as readonly string[]).includes(value)) {
    return value as ScoutMcpInstallHost;
  }
  throw new ScoutCliError(`unsupported MCP host "${value}" (expected codex, claude, or zed)`);
}

export function renderMcpInstallHelp(): string {
  return [
    "Usage: scout mcp install [--host <codex|claude|zed>] [--shared] [--force] [--dry-run]",
    "",
    "Register the current Scout MCP server command with supported local hosts.",
    "",
    "Defaults to every detected host. Codex is installed through its global",
    "config, and Claude Code is installed at user scope. Zed is installed as",
    "context_servers.scout in its user settings.json; the rest of that file,",
    "comments included, stays as it was, and Zed reloads it without a restart.",
    "",
    "--shared turns on one shared Scout MCP server for every session on this",
    "host, run by scout-base at http://127.0.0.1:43115/mcp, and points Codex",
    "and Claude Code at it instead of starting a server per session. Zed keeps",
    "its own server. Sessions that are already running keep theirs until they",
    "restart. Run on the main instance only, since the host configs are global.",
    "",
    "--force without --shared replaces the entries with the per-session",
    "command, then turns the shared server off.",
    "",
    "Examples:",
    "  scout mcp install",
    "  scout mcp install --host codex --force",
    "  scout mcp install --host claude --dry-run",
    "  scout mcp install --host zed",
    "  scout mcp install --shared",
    "  scout mcp install --force",
  ].join("\n");
}

export function parseMcpInstallCommandOptions(
  args: string[],
  env: NodeJS.ProcessEnv,
): ScoutMcpInstallOptions {
  const hosts: ScoutMcpInstallHost[] = [];
  let force = false;
  let dryRun = false;
  let shared = false;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index] ?? "";
    if (!current) {
      continue;
    }
    if (HELP_FLAGS.has(current)) {
      continue;
    }
    if (current === "--force") {
      force = true;
      continue;
    }
    if (current === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (current === "--shared") {
      shared = true;
      continue;
    }
    if (current === "--host" || current.startsWith("--host=")) {
      const parsed = parseFlagValue(args, index, "--host");
      hosts.push(parseHostValue(parsed.value));
      index = parsed.nextIndex;
      continue;
    }
    throw new ScoutCliError(`unexpected argument for mcp install: ${current}`);
  }

  const resolvedHosts = hosts.length > 0
    ? [...new Set(hosts)]
    : SUPPORTED_HOSTS.filter((host) => resolveHostPath(host, env) !== null);

  return {
    dryRun,
    force,
    shared,
    hosts: [...resolvedHosts],
  };
}

function defaultCommandRunner(
  context: ScoutCommandContext,
): CommandRunner {
  return (command, args) => {
    const result = spawnSync(command, args, {
      cwd: context.cwd,
      env: context.env,
      encoding: "utf8",
      stdio: "pipe",
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error,
    };
  };
}

function commandFailed(result: CommandResult): boolean {
  return Boolean(result.error) || result.status !== 0;
}

type CliHost = "codex" | "claude";

const CLI_HOSTS: Record<CliHost, {
  label: string;
  remove: string[];
  add: (transport: ScoutMcpTransport) => string[];
}> = {
  codex: {
    label: "Codex",
    remove: ["mcp", "remove", "scout"],
    add: (transport) => transport.kind === "http"
      ? ["mcp", "add", "scout", "--url", transport.url]
      : ["mcp", "add", "scout", "--", transport.command, ...transport.args],
  },
  claude: {
    label: "Claude Code",
    remove: ["mcp", "remove", "--scope", "user", "scout"],
    add: (transport) => transport.kind === "http"
      ? ["mcp", "add", "--scope", "user", "--transport", "http", "scout", transport.url]
      : ["mcp", "add", "--scope", "user", "scout", "--", transport.command, ...transport.args],
  },
};

/** Codex and Claude Code are installed through their own `mcp` commands. */
function installThroughHostCli(input: {
  host: CliHost;
  executablePath: string;
  transport: ScoutMcpTransport;
  force: boolean;
  dryRun: boolean;
  run: CommandRunner;
}): HostInstallOutcome {
  const { label, remove, add } = CLI_HOSTS[input.host];
  const existing = input.run(input.executablePath, ["mcp", "get", "scout"]);
  if (!commandFailed(existing) && !input.force) {
    return {
      host: input.host,
      status: "already_installed",
      detail: `${label} already has a scout MCP entry.`,
    };
  }

  const addArgs = add(input.transport);
  if (input.dryRun) {
    return {
      host: input.host,
      status: "installed",
      detail: `Would run: ${input.executablePath} ${addArgs.join(" ")}`,
    };
  }

  if (!commandFailed(existing) && input.force) {
    const removed = input.run(input.executablePath, remove);
    if (commandFailed(removed)) {
      return {
        host: input.host,
        status: "failed",
        detail: removed.stderr.trim() || removed.stdout.trim() || `Failed to replace existing ${label} MCP config.`,
      };
    }
  }

  const added = input.run(input.executablePath, addArgs);
  if (commandFailed(added)) {
    return {
      host: input.host,
      status: "failed",
      detail: added.stderr.trim() || added.stdout.trim() || `Failed to install scout MCP into ${label}.`,
    };
  }

  return {
    host: input.host,
    status: "installed",
    detail: input.transport.kind === "http"
      ? `Pointed scout MCP for ${label} at the shared server.`
      : `Installed scout MCP for ${label}.`,
  };
}

function installForZed(input: {
  settingsPath: string;
  launch: ScoutMcpLaunchCommand;
  force: boolean;
  dryRun: boolean;
}): HostInstallOutcome {
  let text = "";
  try {
    text = readFileSync(input.settingsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        host: "zed",
        status: "failed",
        detail: `Could not read ${input.settingsPath}: ${(error as Error).message}`,
      };
    }
  }

  let plan: ReturnType<typeof planZedScoutContextServer>;
  try {
    plan = planZedScoutContextServer(text, { command: input.launch.command, args: input.launch.args }, { force: input.force });
  } catch (error) {
    return {
      host: "zed",
      status: "failed",
      detail: `${(error as Error).message} (${input.settingsPath})`,
    };
  }

  if (plan.action === "unchanged") {
    return {
      host: "zed",
      status: "already_installed",
      detail: "Zed already has a scout MCP entry.",
    };
  }
  if (plan.action === "conflict") {
    return {
      host: "zed",
      status: "skipped",
      detail: `Zed has a different scout entry in ${input.settingsPath}. Rerun with --force to replace it.`,
    };
  }

  const change = plan.replaced ? "replace" : "add";
  if (input.dryRun) {
    return {
      host: "zed",
      status: "installed",
      detail: `Would ${change} context_servers.scout in ${input.settingsPath}: ${input.launch.command} ${input.launch.args.join(" ")}`,
    };
  }

  try {
    mkdirSync(dirname(input.settingsPath), { recursive: true });
    if (text !== "") {
      writeFileSync(`${input.settingsPath}.scout-backup`, text);
    }
    // writeFileSync follows a symlinked settings file instead of replacing it.
    writeFileSync(input.settingsPath, plan.text);
  } catch (error) {
    return {
      host: "zed",
      status: "failed",
      detail: `Could not write ${input.settingsPath}: ${(error as Error).message}`,
    };
  }

  return {
    host: "zed",
    status: "installed",
    detail: text === ""
      ? `Installed scout MCP for Zed in ${input.settingsPath}.`
      : `Installed scout MCP for Zed in ${input.settingsPath} (previous file saved as settings.json.scout-backup).`,
  };
}

export function installScoutMcpForHosts(input: {
  env: NodeJS.ProcessEnv;
  hosts: ScoutMcpInstallHost[];
  force: boolean;
  dryRun: boolean;
  run?: CommandRunner;
  context?: ScoutCommandContext;
  resolveHostPath?: (host: ScoutMcpInstallHost, env: NodeJS.ProcessEnv) => string | null;
  resolveLaunchCommand?: (env: NodeJS.ProcessEnv) => ScoutMcpLaunchCommand;
  /** Point Codex and Claude Code at this shared server URL (replacing their entries); Zed is left alone. */
  sharedUrl?: string | null;
}): HostInstallOutcome[] {
  const sharedUrl = input.sharedUrl ?? null;
  let launch: ScoutMcpLaunchCommand | null = null;
  // Resolved only when a host needs the stdio command, so --shared works without a stable launcher.
  const stdioLaunch = () => (launch ??= (input.resolveLaunchCommand ?? resolveCurrentScoutMcpLaunchCommand)(input.env));
  const run = input.run
    ?? (input.context ? defaultCommandRunner(input.context) : undefined);
  const resolvePath = input.resolveHostPath ?? resolveHostPath;
  if (!run) {
    throw new ScoutCliError("A command runner or command context is required.");
  }

  return input.hosts.map((host): HostInstallOutcome => {
    if (sharedUrl && host === "zed") {
      return { host, status: "skipped", detail: "Skipped zed: it keeps its own Scout MCP server." };
    }
    const executablePath = resolvePath(host, input.env);
    if (!executablePath) {
      return {
        host,
        status: "skipped",
        detail: host === "zed" ? "Skipped zed: Zed not found." : `Skipped ${host}: executable not found.`,
      };
    }
    if (host === "zed") {
      return installForZed({
        settingsPath: executablePath,
        launch: stdioLaunch(),
        force: input.force,
        dryRun: input.dryRun,
      });
    }
    return installThroughHostCli({
      host,
      executablePath,
      transport: sharedUrl ? { kind: "http", url: sharedUrl } : { kind: "stdio", ...stdioLaunch() },
      // A shared install always replaces the per-session entry.
      force: input.force || sharedUrl !== null,
      dryRun: input.dryRun,
      run,
    });
  });
}

const SHARED_MCP_START_TIMEOUT_MS = 20_000;

/** True once the shared server answers /stats; scout-base starts it within a reconcile tick. */
export async function waitForSharedMcpServer(port: number, timeoutMs = SHARED_MCP_START_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/stats`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return true;
    } catch {
      // Not listening yet.
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function hostFailed(outcomes: HostInstallOutcome[]): boolean {
  return outcomes.some((outcome) => outcome.status === "failed");
}

/**
 * `scout mcp install --shared`: leave the opt-in that makes scout-base run
 * the shared server, wait until it answers, then point the hosts at it. If
 * the server never answers, the opt-in this call wrote is taken back and no
 * host config changes.
 */
export async function enableSharedScoutMcp(input: {
  env: NodeJS.ProcessEnv;
  hosts: ScoutMcpInstallHost[];
  dryRun: boolean;
  run?: CommandRunner;
  context?: ScoutCommandContext;
  resolveHostPath?: (host: ScoutMcpInstallHost, env: NodeJS.ProcessEnv) => string | null;
  supportDirectory?: string;
  instance?: { name: string; isProd: boolean };
  port?: number;
  waitForServer?: (port: number) => Promise<boolean>;
}): Promise<string[]> {
  const instance = input.instance ?? deriveOpenScoutInstanceLayout({ env: input.env });
  if (!instance.isProd) {
    throw new ScoutCliError(
      `scout mcp install --shared changes the global Codex and Claude Code configs, so it runs only on the main instance (this is "${instance.name}"). Run \`scout mcp serve\` to try the shared server here.`,
    );
  }
  const supportDirectory = input.supportDirectory ?? resolveOpenScoutSupportPaths().supportDirectory;
  const previous = readSharedMcpOptIn(supportDirectory);
  const port = previous?.port ?? input.port ?? sharedMcpPort(input.env);
  const url = sharedMcpUrl(port);
  const install = () => installScoutMcpForHosts({
    env: input.env,
    hosts: input.hosts,
    force: true,
    dryRun: input.dryRun,
    run: input.run,
    context: input.context,
    resolveHostPath: input.resolveHostPath,
    sharedUrl: url,
  });
  const hostLines = (outcomes: HostInstallOutcome[]) => outcomes.map((outcome) => `[${outcome.host}] ${outcome.detail}`);

  if (input.dryRun) {
    return [
      previous
        ? `The shared Scout MCP server is already on at ${url}.`
        : `Would write ${sharedMcpOptInPath(supportDirectory)}; scout-base then runs the shared Scout MCP server at ${url}.`,
      ...hostLines(install()),
    ];
  }

  if (!previous) writeSharedMcpOptIn(supportDirectory, port);
  if (!(await (input.waitForServer ?? waitForSharedMcpServer)(port))) {
    if (!previous) removeSharedMcpOptIn(supportDirectory);
    throw new ScoutCliError(
      `The shared Scout MCP server did not answer at ${url} within ${SHARED_MCP_START_TIMEOUT_MS / 1000} s, so no host config was changed. scout-base runs it only from a Scout version with this command; see ${join(supportDirectory, "logs", "base", "shared-mcp.stderr.log")}.`,
    );
  }

  const outcomes = install();
  return [
    `The shared Scout MCP server is on at ${url}, run by scout-base.`,
    ...hostLines(outcomes),
    hostFailed(outcomes)
      ? "A host was not switched; it keeps its own Scout MCP server. Rerun after fixing it, or run scout mcp install --force to switch every host back."
      : "New Codex and Claude Code sessions use it. Sessions that are already running keep their own server until they restart.",
  ];
}

export async function runMcpInstallCommand(
  context: ScoutCommandContext,
  args: string[],
): Promise<void> {
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(renderMcpInstallHelp());
    return;
  }

  const options = parseMcpInstallCommandOptions(args, context.env);
  if (options.shared) {
    const lines = await enableSharedScoutMcp({
      env: context.env,
      hosts: options.hosts,
      dryRun: options.dryRun,
      context,
    });
    context.output.writeText(lines.join("\n"));
    return;
  }
  if (options.hosts.length === 0) {
    context.output.writeText("No supported hosts detected. Looked for codex, claude, and zed.");
    return;
  }

  const outcomes = installScoutMcpForHosts({
    env: context.env,
    hosts: options.hosts,
    force: options.force,
    dryRun: options.dryRun,
    context,
  });

  const lines = outcomes.map((outcome) => `[${outcome.host}] ${outcome.detail}`);
  // --force puts the hosts back on their own server. The shared server stops
  // only once every detected Codex and Claude Code install was switched back.
  const supportDirectory = resolveOpenScoutSupportPaths().supportDirectory;
  if (options.force && readSharedMcpOptIn(supportDirectory)) {
    const switched = new Set(outcomes.filter((outcome) => outcome.status === "installed").map((outcome) => outcome.host));
    const pending = (Object.keys(CLI_HOSTS) as CliHost[])
      .filter((host) => !switched.has(host) && resolveHostPath(host, context.env) !== null);
    if (pending.length > 0) {
      lines.push(`The shared Scout MCP server stays on: ${pending.join(" and ")} may still point at it.`);
    } else if (options.dryRun) {
      lines.push(`Would remove ${sharedMcpOptInPath(supportDirectory)}; scout-base then stops the shared Scout MCP server.`);
    } else {
      removeSharedMcpOptIn(supportDirectory);
      lines.push("Turned off the shared Scout MCP server; scout-base stops it.");
    }
  }
  context.output.writeText(lines.join("\n"));
}
