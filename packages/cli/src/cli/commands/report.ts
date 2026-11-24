import {
  submitDiagnosticReport,
  formatDiagnosticReceipt,
  reporterHarness,
  type DiagnosticReporter,
  findNearestProjectRoot,
} from "@openscout/runtime/setup";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename } from "node:path";
import { SCOUT_APP_VERSION } from "../../lib/shared/product.ts";
import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

const FLAGS = ["--local-only", "--diagnostics"];

export async function runReportCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  await run(context, args, true);
}
export async function runFeedbackCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  await run(context, args, false);
}

export function renderReportCommandHelp(): string {
  return [
    "Usage: scout report [note] [--local-only]",
    "       scout feedback <note> [--diagnostics] [--local-only]",
    "       scout feedback --file <path>     (the note is the file's contents)",
    "       scout feedback -                  (the note is read from stdin)",
    "",
    "Reports include redacted, bounded service traces and data health; feedback sends only your note unless --diagnostics is set.",
    "When an agent files it, the report also names the sender (OPENSCOUT_AGENT, harness, project, host).",
    "A private local copy is saved before upload. Collection works without the broker.",
  ].join("\n");
}

async function run(context: ScoutCommandContext, args: string[], diagnostics: boolean) {
  if (args.some((arg) => arg === "--help" || arg === "-h")) {
    context.output.writeText(renderReportCommandHelp());
    return;
  }
  const words: string[] = [];
  let file: string | null = null;
  let fromStdin = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--file" || arg === "--message-file") {
      file = args[i + 1] ?? null;
      if (!file) throw new ScoutCliError(`${arg} needs a path.`);
      i += 1;
    } else if (arg === "-") {
      fromStdin = true;
    } else if (arg.startsWith("--")) {
      if (!FLAGS.includes(arg)) throw new ScoutCliError(`Unknown report option: ${arg}`);
    } else {
      words.push(arg);
    }
  }
  // Long notes arrive by file or pipe, so nobody has to paste them through a
  // shell quote — the SSH relay that feedback used to take.
  const body = file ? await readFile(file, "utf8") : fromStdin ? await Bun.stdin.text() : "";
  const message = [words.join(" "), body].map((part) => part.trim()).filter(Boolean).join("\n\n");
  if (!diagnostics && !message) throw new ScoutCliError("Feedback requires a note.");
  const result = await submitDiagnosticReport({
    message,
    diagnostics: diagnostics || args.includes("--diagnostics"),
    localOnly: args.includes("--local-only"),
    version: SCOUT_APP_VERSION,
    client: "cli",
    reporter: await cliReporter(context),
  });
  context.output.writeValue(result, formatDiagnosticReceipt);
}

/** Environment-only: feedback must never wait on the broker to say who sent it. */
async function cliReporter(context: ScoutCommandContext): Promise<DiagnosticReporter> {
  const cwd = process.cwd();
  const root = await findNearestProjectRoot(cwd).catch(() => null);
  return {
    agentName: context.env.OPENSCOUT_AGENT?.trim() || undefined,
    harness: reporterHarness(context.env),
    project: basename(root ?? cwd),
    host: hostname(),
  };
}
