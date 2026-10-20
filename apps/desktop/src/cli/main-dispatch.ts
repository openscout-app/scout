import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { parseScoutArgv } from "./argv.ts";
import { createScoutCommandContext, defaultScoutContextDirectory } from "./context.ts";
import { ScoutCliError } from "./errors.ts";
import { runAskWithOptions } from "./commands/ask.ts";
import { loadScoutCommandHandler } from "./commands/index.ts";
import { renderScoutHelp } from "./help.ts";
import { parseImplicitAskCommandOptions } from "./options.ts";
import { findScoutCommandRegistration, missingScoutExtensionMessage, unknownScoutCommandMessage } from "./registry.ts";
import { findScoutExtension, runScoutExtension, scoutExtensionEnv } from "./extensions.ts";
import { resolveBrokerControlUrl } from "@openscout/runtime/local-config";
import {
  normalizeCliBinaryMtimeMs,
  shouldEnsureBrokerUptodateForCommand,
} from "./uptodate.ts";
import { brokerUpdateDebugEnabled, ensureBrokerUptodate } from "./broker-update.ts";
import { runNativeScoutdJson } from "./scoutd.ts";
import { SCOUT_APP_VERSION } from "../shared/product.ts";
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

  // Help and diagnostics must not refresh/restart the service they describe.
  if (shouldEnsureBrokerUptodateForCommand(command, commandArgs)) {
    await ensureBrokerUptodate({
      checkpointPath: cliMtimeCheckpointPath(),
      debug: brokerUpdateDebugEnabled(context.env),
      readCurrentMtime: readCurrentCliMtime,
      report: (message) => context.stderr(message),
      restart: async () => runNativeScoutdJson("restart"),
      status: async () => runNativeScoutdJson("status", { timeoutMs: 5_000 }),
    });
  }

  const registration = findScoutCommandRegistration(command);
  if (!registration && (command === "need" || command === "attention")) {
    throw new ScoutCliError(command === "need"
      ? "scout need has been replaced by scout operator --question <text>"
      : "scout attention has been replaced by scout status --all --blocked; use scout diff for repository changes");
  }
  if (!registration || registration.provider === "extension") {
    // Built-ins are never shadowed; extensions fill verbs the core does not own.
    const extension = findScoutExtension(command, context.env);
    if (extension?.refused) throw new ScoutCliError(extension.refused);
    if (extension) {
      process.exitCode = await runScoutExtension(extension, commandArgs, scoutExtensionEnv({
        env: context.env,
        extension,
        cliVersion: SCOUT_APP_VERSION,
        outputMode: input.outputMode === "json" ? "json" : "plain",
        brokerUrl: context.env.OPENSCOUT_BROKER_URL?.trim() || resolveBrokerControlUrl(),
      }));
      return;
    }
    if (registration) throw new ScoutCliError(missingScoutExtensionMessage(registration));
  }
  if (!registration) {
    if (commandArgs.includes("--help") || commandArgs.includes("-h")) {
      throw new ScoutCliError(unknownScoutCommandMessage(command, SCOUT_APP_VERSION));
    }
    const implicitPromptArgs = [command, ...commandArgs];
    try {
      const options = parseImplicitAskCommandOptions(implicitPromptArgs, defaultScoutContextDirectory(context));
      await runAskWithOptions(context, options);
      exitAfterCompletedCommand("ask");
      return;
    } catch (error) {
      if (error instanceof ScoutCliError && error.message.startsWith("implicit ask requires")) {
        throw new ScoutCliError(unknownScoutCommandMessage(command, SCOUT_APP_VERSION));
      }
      throw error;
    }
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
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exit(1);
}
