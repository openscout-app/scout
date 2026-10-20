import type { ScoutCommandContext } from "../context.ts";
import { listScoutExtensions, scoutExtensionsHome } from "../extensions.ts";
import { renderScoutExtensionLines } from "../help.ts";

const EXTENSIONS_HELP = `scout extensions — List installed CLI extensions

An extension adds a verb: \`scout <verb>\` runs it when no built-in owns that verb.
Install one as a directory in ~/.scout/extensions with an extension.json
({ "api": 1, "summary": "...", "command": "bin/scout-<verb>" }). The command
must be inside that directory. A symlink to the directory works.
~/.openscout/extensions is still read as a fallback. PATH is not searched.`;

export async function runExtensionsCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    context.output.writeText(EXTENSIONS_HELP);
    return;
  }
  const installed = listScoutExtensions(context.env);
  context.output.writeValue({ home: scoutExtensionsHome(context.env), extensions: installed }, (value) => [
    `Extensions home: ${value.home}`,
    renderScoutExtensionLines(value.extensions),
    ...value.extensions.filter((extension) => extension.refused).map((extension) => `\n${extension.refused}`),
  ].join("\n"));
}
