import "../bun-bootstrap.ts";
import { homedir } from "node:os";
import { captureScoutExtensionSelection, rememberScoutExtensionSelection } from "./extension-context.ts";
import { ScoutCommandUnavailableError, renderScoutCommandUnavailable } from "./command-unavailable.ts";
import type { ScoutCommandContext } from "./context.ts";
import { runCoreBootstrap } from "./core-bootstrap.ts";
import { runScoutDiscovery } from "./discovery.ts";
import { SCOUT_APP_VERSION } from "../lib/shared/product.ts";
import { applyInstanceFlag, preflightLifecycle } from "../../bin/lifecycle-preflight.mjs";
import {
  applyOpenScoutInstanceEnvironment,
  assertOpenScoutInstanceIsolation,
  selectCliOpenScoutInstance,
  selectStatuslineOpenScoutInstance,
} from "@openscout/runtime/config";

async function runCoreReadiness(command: string, context: ScoutCommandContext, args: string[]): Promise<void> {
  if (command === "__doctor-check") {
    const { collectDoctorCheck, DOCTOR_CHECK_NAMES } = await import("./doctor-checks.ts");
    const name = args[0];
    if (args.length !== 1 || !DOCTOR_CHECK_NAMES.some(candidate => candidate === name)) throw new Error("invalid diagnostic check");
    context.output.writeText(JSON.stringify(await collectDoctorCheck(name as typeof DOCTOR_CHECK_NAMES[number], context)));
    process.exit(0); // Preserve the owned diagnostic worker's bounded lifecycle.
  } else if (command === "setup") {
    const { runSetupCommand } = await import("./commands/setup.ts");
    await runSetupCommand(context, args);
  } else {
    const { runDoctorCommand } = await import("./commands/doctor.ts");
    await runDoctorCommand(context, args);
  }
}

// Service imports can initialize local state, so load them only after help and
// lifecycle validation have completed, including when running from source.
try {
  // `scout --instance <name>` / OPENSCOUT_INSTANCE picks the target instance:
  // its broker port, socket, homes and identity. Materialize it before any
  // service module reads env, and refuse a non-prod instance that would reach
  // prod (for example an inherited OPENSCOUT_BROKER_URL on 43110).
  if (await runScoutDiscovery(process.argv.slice(2), SCOUT_APP_VERSION) || await runCoreBootstrap(process.argv.slice(2), runCoreReadiness)) {
    // Discovery is read-only and must not bootstrap runtime services.
  } else {
    applyInstanceFlag(process);
    if (process.argv[2] === "statusline") {
      // The Claude statusline targets prod unless asked otherwise.
      selectStatuslineOpenScoutInstance(process.env);
    } else {
      // Explicit --instance / OPENSCOUT_INSTANCE, else the client pointer a
      // Scout terminal or agent was launched with, else prod.
      selectCliOpenScoutInstance(process.env);
    }
    const selected = applyOpenScoutInstanceEnvironment(process.env);
    assertOpenScoutInstanceIsolation("scout");
    rememberScoutExtensionSelection(captureScoutExtensionSelection({ layout: selected.layout, env: process.env, home: homedir(), uid: process.getuid?.() ?? -1, cwd: process.cwd() }));
    const help = preflightLifecycle(process.argv.slice(2));
    if (help !== null) console.log(help);
    else await import("./main-dispatch.ts");
  }
} catch (error) {
  if (error instanceof ScoutCommandUnavailableError) {
    if (process.argv.includes("--json")) {
      process.stderr.write(JSON.stringify(error.toJSON()) + "\n");
    } else {
      console.error(renderScoutCommandUnavailable(error, false));
    }
    process.exit(error.exitCode);
  }
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
