import { removedScoutVerbError } from "./removed-verbs.ts";
import { prepareScoutExtensionContext } from "./extension-context-runner.ts";
import { selectedScoutExtensionInvocation } from "./extension-context.ts";
import { resolveEffectiveLocalConfig } from "@openscout/runtime/local-config";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { parseScoutArgv } from "./argv.ts";
import { createScoutCommandContext, defaultScoutContextDirectory } from "./context.ts";
import { ScoutCliError } from "./errors.ts";
import { resolveReservedScoutExtension, ScoutCommandUnavailableError, renderScoutCommandUnavailable } from "./command-unavailable.ts";
import { runAskWithOptions } from "./commands/ask.ts";
import { loadScoutCommandHandler } from "./commands/index.ts";
import { renderScoutHelp } from "./help.ts";
import { parseImplicitAskCommandOptions } from "./options.ts";
import { findScoutCommandRegistration, unknownScoutCommandMessage } from "./registry.ts";
import { findScoutExtension, runScoutExtension, scoutExtensionEnv } from "./extensions.ts";
import { resolveBrokerControlUrl } from "@openscout/runtime/local-config";
import {
  normalizeCliBinaryMtimeMs,
  shouldEnsureBrokerUptodateForCommand,
} from "./uptodate.ts";
import { brokerUpdateDebugEnabled, ensureBrokerUptodate } from "./broker-update.ts";
import { runNativeScoutdJson } from "./scoutd.ts";
import { SCOUT_APP_VERSION } from "../lib/shared/product.ts";
import { resolveOpenScoutScoutHome } from "@openscout/runtime/support-paths";

async function main() {
  const input = parseScoutArgv(process.argv.slice(2));
  const context = createScoutCommandContext({ outputMode: input.outputMode });
  let command = input.command;
  let commandArgs = input.args;

  if (command === "__doctor-check") {
    const { collectDoctorCheck, DOCTOR_CHECK_NAMES } = await import("./doctor-checks.ts");
    const name = commandArgs[0];
    if (commandArgs.length !== 1 || !DOCTOR_CHECK_NAMES.some(candidate => candidate === name)) throw new ScoutCliError("invalid diagnostic check");
    context.output.writeText(JSON.stringify(await collectDoctorCheck(name as typeof DOCTOR_CHECK_NAMES[number], context)));
    process.exit(0);
  }

  if (input.versionRequested) {
    context.output.writeText(SCOUT_APP_VERSION);
    return;
  }
  if (input.helpRequested && command && command !== "--detail") {
    commandArgs = ["--help", ...commandArgs];
  } else if (input.helpRequested || !command) {
    context.output.writeText(renderScoutHelp(SCOUT_APP_VERSION, command === "--detail"));
    return;
  }

  if (command === "relay") {
    command = commandArgs[0] ?? null;
    commandArgs = commandArgs.slice(1);
    if (!command || command === "help" || command === "--help" || command === "-h") {
      context.output.writeText(renderScoutHelp(SCOUT_APP_VERSION));
      return;
    }
  }

  const removed = removedScoutVerbError(command, commandArgs);
  if (removed) throw removed;

  // Resolve reserved extensions before maintenance can refresh/restart core.
  const registration = findScoutCommandRegistration(command);
  const reservedExtension = registration?.provider === "extension"
    ? resolveReservedScoutExtension(registration, context.env) : undefined;

  const dispatchExtension = reservedExtension ?? (!registration ? findScoutExtension(command, context.env) : undefined);
  if (dispatchExtension?.refused) throw new ScoutCliError(dispatchExtension.refused);
  const brokerUrl = dispatchExtension?.api === 2 ? context.env.OPENSCOUT_BROKER_URL?.trim() || resolveBrokerControlUrl() : "";
  const frame = dispatchExtension?.api === 2 ? prepareScoutExtensionContext({ extension: dispatchExtension, env: context.env,
    selection: selectedScoutExtensionInvocation(), brokerUrl, ports: resolveEffectiveLocalConfig().ports,
    cli: { version: SCOUT_APP_VERSION, executable: process.argv[1]!, runtimeExecutable: process.execPath,
      output: input.outputMode === "json" ? "json" : "plain", cwd: context.cwd } }) : undefined;

  // Help and diagnostics must not refresh/restart the service they describe.
  if (dispatchExtension?.api !== 2 && shouldEnsureBrokerUptodateForCommand(command, commandArgs)) {
    await ensureBrokerUptodate({
      checkpointPath: cliMtimeCheckpointPath(),
      debug: brokerUpdateDebugEnabled(context.env),
      readCurrentMtime: readCurrentCliMtime,
      report: (message) => context.stderr(message),
      restart: async () => runNativeScoutdJson("restart"),
      status: async () => runNativeScoutdJson("status", { timeoutMs: 5_000 }),
    });
  }

  if (!registration && (command === "need" || command === "attention")) {
    throw new ScoutCliError(command === "need"
      ? "scout need has been replaced by scout ask --operator <text>"
      : "scout attention has been replaced by scout status --all --blocked; use scout diff for repository changes");
  }
  if (!registration || registration.provider === "extension") {
    // Built-ins are never shadowed; extensions fill verbs the core does not own.
    const extension = dispatchExtension;
    if (extension?.refused) throw new ScoutCliError(extension.refused);
    if (extension) {
      process.exitCode = await runScoutExtension(extension, commandArgs, scoutExtensionEnv({
        env: context.env,
        extension,
        cliVersion: SCOUT_APP_VERSION,
        outputMode: input.outputMode === "json" ? "json" : "plain",
        brokerUrl: frame ? brokerUrl : context.env.OPENSCOUT_BROKER_URL?.trim() || resolveBrokerControlUrl(),
      }), frame ? { frame, selectionEnv: context.env } : undefined);
      return;
    }
  }
  if (!registration) {
    if (commandArgs.includes("--help") || commandArgs.includes("-h")) {
      throw new ScoutCliError(unknownScoutCommandMessage(command, SCOUT_APP_VERSION));
    }
    const implicitPromptArgs = [command, ...commandArgs];
    const routeFlags = ["--to", "--operator", "--channel", "--project", "--ref", "--continue",
      "--harness", "--runtime", "--profile", "--model", "--effort", "--reasoning-effort", "--session", "--new", "--on", "--host"];
    const literal = implicitPromptArgs.indexOf("--");
    const routeArgs = literal < 0 ? implicitPromptArgs : implicitPromptArgs.slice(0, literal);
    if (!command.startsWith("@") && !routeArgs.some(arg => routeFlags.includes(arg.split("=")[0]!))) {
      throw new ScoutCliError(unknownScoutCommandMessage(command, SCOUT_APP_VERSION));
    }
    const options = parseImplicitAskCommandOptions(implicitPromptArgs, defaultScoutContextDirectory(context));
    await runAskWithOptions(context, options);
    exitAfterCompletedCommand("ask");
    return;
  }

  if (registration.status === "deprecated" && registration.deprecationMessage) {
    context.stderr(`warning: ${registration.deprecationMessage}`);
  }

  const resolvedCommand = registration.canonicalName ?? registration.name;
  const handler = await loadScoutCommandHandler(resolvedCommand as Parameters<typeof loadScoutCommandHandler>[0]);
  await handler(context, commandArgs);
  exitAfterCompletedCommand(resolvedCommand, commandArgs);
}

const FORCE_EXIT_AFTER_COMPLETED_COMMANDS = new Set(["ask"]);

function shouldForceExitAfterCommand(command: string | null, args: readonly string[]): boolean {
  if (!command) {
    return false;
  }
  if (FORCE_EXIT_AFTER_COMPLETED_COMMANDS.has(command)) {
    return true;
  }
  // A tracked send runs the ask lifecycle and exits like ask. A plain send
  // keeps its natural exit so a large --json receipt (which echoes the body)
  // is never truncated on a pipe by a forced exit.
  return command === "send" && args.includes("--tracked");
}

function exitAfterCompletedCommand(command: string | null, args: readonly string[] = []): void {
  if (!shouldForceExitAfterCommand(command, args)) {
    return;
  }
  process.exit(process.exitCode ?? 0);
}

/** Cached scout shim path — resolved once per process. */
let _scoutBinPath: string | null = null;

function getScoutBinPath(): string {
  if (_scoutBinPath) return _scoutBinPath;
  // Bun scripts: process.execPath is the bun binary, not the shim.
  // The shim is always at ~/.bun/bin/scout on macOS.
  _scoutBinPath = join(homedir(), ".bun", "bin", "scout");
  if (!existsSync(_scoutBinPath)) {
    // Fallback: resolve via $PATH
    _scoutBinPath = spawnSync("which", ["scout"], { encoding: "utf8" }).stdout.trim();
  }
  return _scoutBinPath;
}

function readCurrentCliMtime(): number | null {
  try {
    return normalizeCliBinaryMtimeMs(statSync(getScoutBinPath()).mtimeMs);
  } catch {
    return null;
  }
}

function cliMtimeCheckpointPath(): string {
  return join(resolveOpenScoutScoutHome(), "cli-mtime");
}

try {
  await main();
} catch (error) {
  if (error instanceof ScoutCommandUnavailableError) {
    if (process.argv.includes("--json")) {
      process.stderr.write(JSON.stringify(error.toJSON()) + "\n");
    } else {
      console.error(renderScoutCommandUnavailable(error, false));
    }
    process.exit(error.exitCode);
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exit(1);
}
