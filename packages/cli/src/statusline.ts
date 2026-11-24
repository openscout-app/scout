import "./bun-bootstrap.ts";
// Must stay first: the Claude statusline targets the prod instance unless
// asked otherwise (`scout --instance <name>` or OPENSCOUT_STATUSLINE_INSTANCE).
import { applyOpenScoutInstanceEnvironment, selectStatuslineOpenScoutInstance } from "@openscout/runtime/config";
selectStatuslineOpenScoutInstance(process.env);
applyOpenScoutInstanceEnvironment(process.env);
// Load the command only after the instance env is settled.
const { runStatuslineCommand } = await import("./cli/commands/statusline.ts");

try {
  const args = process.argv[2] === "statusline"
    ? process.argv.slice(3)
    : process.argv.slice(2);
  const context: Parameters<typeof runStatuslineCommand>[0] = {
    env: process.env,
    output: {
      writeText(value: string) {
        process.stdout.write(`${value}\n`);
      },
    },
    stderr(message: string) {
      process.stderr.write(`${message}\n`);
    },
  } as Parameters<typeof runStatuslineCommand>[0];
  await runStatuslineCommand(context, args);
} catch {
  process.stdout.write("Scout | Claude status\n");
}
