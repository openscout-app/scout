import { applyInstanceFlag, extractInstanceFlag, parseScoutArgv } from "../../bin/lifecycle-preflight.mjs";
import { applyOpenScoutInstanceEnvironment, assertOpenScoutInstanceIsolation, selectCliOpenScoutInstance } from "@openscout/runtime/config";

/** Select before the legacy ask/lifecycle graph loads. Setup, doctor and runtimes use their retained
 * core handlers; no private command dispatch or lifecycle preflight is loaded. */
export function coreBootstrapInput(argv: string[], readiness = false) {
  const input = parseScoutArgv(extractInstanceFlag(argv).argv);
  const command = input.command === "relay" ? input.args[0] : input.command;
  return (command === "runtimes" || readiness && ["setup", "doctor", "__doctor-check"].includes(command ?? "")) && !input.versionRequested ? input : null;
}

export async function runCoreBootstrap(argv: string[], readiness?: (
  command: string, context: import("./context.ts").ScoutCommandContext, args: string[],
) => Promise<void>): Promise<boolean> {
  const input = coreBootstrapInput(argv, Boolean(readiness));
  if (!input) return false;
  const command = input.command === "relay" ? input.args[0] : input.command;
  applyInstanceFlag(process);
  selectCliOpenScoutInstance(process.env);
  applyOpenScoutInstanceEnvironment(process.env);
  assertOpenScoutInstanceIsolation("scout");
  const { createScoutCommandContext } = await import("./context.ts");
  const args = input.command === "relay" ? input.args.slice(1) : input.args;
  const context = createScoutCommandContext({ outputMode: input.outputMode });
  const passed = input.helpRequested ? ["--help", ...args] : args;
  if (command !== "runtimes") {
    // The Bun entry supplies these handlers. Node's shared bootstrap never
    // statically imports the Bun diagnostic/native graph into its bundle.
    await readiness!(command!, context, passed);
  } else {
    const { runRuntimesCommand } = await import("./commands/runtimes.ts");
    await runRuntimesCommand(context, passed);
  }
  return true;
}
