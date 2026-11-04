import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { planZedScoutContextServer, zedSettingsPath } from "./zed-settings.ts";

export type ScoutMcpInstallHost = "claude" | "codex" | "zed";

const SUPPORTED_HOSTS = ["codex", "claude", "zed"] as const;

type ScoutMcpInstallOptions = {
  dryRun: boolean;
  force: boolean;
  hosts: ScoutMcpInstallHost[];
};

type ScoutMcpLaunchCommand = {
  command: string;
  args: string[];
};

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

function resolveExecutableFromSearchPath(
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
    "Usage: scout mcp install [--host <codex|claude|zed>] [--force] [--dry-run]",
    "",
    "Register the current Scout MCP server command with supported local hosts.",
    "",
    "Defaults to every detected host. Codex is installed through its global",
    "config, and Claude Code is installed at user scope. Zed is installed as",
    "context_servers.scout in its user settings.json; the rest of that file,",
    "comments included, stays as it was, and Zed reloads it without a restart.",
    "",
    "Examples:",
    "  scout mcp install",
    "  scout mcp install --host codex --force",
    "  scout mcp install --host claude --dry-run",
    "  scout mcp install --host zed",
  ].join("\n");
}

export function parseMcpInstallCommandOptions(
  args: string[],
  env: NodeJS.ProcessEnv,
): ScoutMcpInstallOptions {
  const hosts: ScoutMcpInstallHost[] = [];
  let force = false;
  let dryRun = false;

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

function installForCodex(input: {
  executablePath: string;
  launch: ScoutMcpLaunchCommand;
  force: boolean;
  dryRun: boolean;
  run: CommandRunner;
}): HostInstallOutcome {
  const existing = input.run(input.executablePath, ["mcp", "get", "scout"]);
  if (!commandFailed(existing) && !input.force) {
    return {
      host: "codex",
      status: "already_installed",
      detail: "Codex already has a scout MCP entry.",
    };
  }

  if (input.dryRun) {
    return {
      host: "codex",
      status: "installed",
      detail: `Would run: ${input.executablePath} mcp add scout -- ${input.launch.command} ${input.launch.args.join(" ")}`,
    };
  }

  if (!commandFailed(existing) && input.force) {
    const removed = input.run(input.executablePath, ["mcp", "remove", "scout"]);
    if (commandFailed(removed)) {
      return {
        host: "codex",
        status: "failed",
        detail: removed.stderr.trim() || removed.stdout.trim() || "Failed to replace existing Codex MCP config.",
      };
    }
  }

  const added = input.run(input.executablePath, [
    "mcp",
    "add",
    "scout",
    "--",
    input.launch.command,
    ...input.launch.args,
  ]);
  if (commandFailed(added)) {
    return {
      host: "codex",
      status: "failed",
      detail: added.stderr.trim() || added.stdout.trim() || "Failed to install scout MCP into Codex.",
    };
  }

  return {
    host: "codex",
    status: "installed",
    detail: "Installed scout MCP for Codex.",
  };
}

function installForClaude(input: {
  executablePath: string;
  launch: ScoutMcpLaunchCommand;
  force: boolean;
  dryRun: boolean;
  run: CommandRunner;
}): HostInstallOutcome {
  const existing = input.run(input.executablePath, ["mcp", "get", "scout"]);
  if (!commandFailed(existing) && !input.force) {
    return {
      host: "claude",
      status: "already_installed",
      detail: "Claude Code already has a scout MCP entry.",
    };
  }

  if (input.dryRun) {
    return {
      host: "claude",
      status: "installed",
      detail: `Would run: ${input.executablePath} mcp add --scope user scout -- ${input.launch.command} ${input.launch.args.join(" ")}`,
    };
  }

  if (!commandFailed(existing) && input.force) {
    const removed = input.run(input.executablePath, ["mcp", "remove", "--scope", "user", "scout"]);
    if (commandFailed(removed)) {
      return {
        host: "claude",
        status: "failed",
        detail: removed.stderr.trim() || removed.stdout.trim() || "Failed to replace existing Claude Code MCP config.",
      };
    }
  }

  const added = input.run(input.executablePath, [
    "mcp",
    "add",
    "--scope",
    "user",
    "scout",
    "--",
    input.launch.command,
    ...input.launch.args,
  ]);
  if (commandFailed(added)) {
    return {
      host: "claude",
      status: "failed",
      detail: added.stderr.trim() || added.stdout.trim() || "Failed to install scout MCP into Claude Code.",
    };
  }

  return {
    host: "claude",
    status: "installed",
    detail: "Installed scout MCP for Claude Code.",
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
}): HostInstallOutcome[] {
  const launch = (input.resolveLaunchCommand ?? resolveCurrentScoutMcpLaunchCommand)(input.env);
  const run = input.run
    ?? (input.context ? defaultCommandRunner(input.context) : undefined);
  const resolvePath = input.resolveHostPath ?? resolveHostPath;
  if (!run) {
    throw new ScoutCliError("A command runner or command context is required.");
  }

  return input.hosts.map((host) => {
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
        launch,
        force: input.force,
        dryRun: input.dryRun,
      });
    }
    if (host === "codex") {
      return installForCodex({
        executablePath,
        launch,
        force: input.force,
        dryRun: input.dryRun,
        run,
      });
    }
    return installForClaude({
      executablePath,
      launch,
      force: input.force,
      dryRun: input.dryRun,
      run,
    });
  });
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

  context.output.writeText(
    outcomes.map((outcome) => `[${outcome.host}] ${outcome.detail}`).join("\n"),
  );
}
