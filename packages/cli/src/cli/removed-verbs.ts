import { ScoutCliError } from "./errors.ts";
export const REMOVED_SCOUT_VERBS = ["tell", "send", "operator", "notify", "broadcast", "speak"] as const;
const quote = (value: string) => /^[a-zA-Z0-9_./:@=-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
export const renderScoutCommand = (verb: string, args: string[]) => ["scout", verb, ...args.map(quote)].join(" ");
const command = renderScoutCommand;
/** Tombstones, not aliases: no replacement is ever executed. Preserve caller payload literally. */
export function removedScoutVerbError(verb: string, original: string[]): ScoutCliError | null {
  if (!REMOVED_SCOUT_VERBS.some(name => name === verb)) return null;
  const args = original.filter(arg => !["--help", "-h"].includes(arg));
  let candidates: string[];
  if (verb === "tell" && args.some(arg => arg === "--ref" || arg.startsWith("--ref="))) {
    candidates = [command("reply", args) + " (final answer; closes the task)",
      command("reply", ["--progress", ...args]) + " (recipient progress; keeps the task open)",
      command("ask", args) + " (follow-up from the asker)"];
  } else if (verb === "send") {
    const tracked = args.includes("--tracked");
    const rest = args.filter(arg => arg !== "--tracked");
    candidates = tracked ? [command("ask", rest)] : [command("ask", rest), command("ask", ["--fyi", ...rest])];
  } else if (verb === "operator") {
    const question = args.some(arg => ["--question", "-q", "--option", "--permission"].includes(arg) || arg.startsWith("--question=") || arg.startsWith("--option="));
    const rest = args.flatMap(arg => arg === "--question" || arg === "-q" || arg === "--message" ? [] : arg.startsWith("--question=") ? [arg.slice(11)] : arg.startsWith("--message=") ? [arg.slice(10)] : [arg]);
    candidates = [command("ask", ["--operator", ...(question ? [] : ["--fyi"]), ...rest])];
  } else if (verb === "notify" || verb === "speak") {
    const rest = args.flatMap(arg => arg === "--message" || arg === "--speak" ? [] : arg.startsWith("--message=") ? [arg.slice(10)] : [arg]);
    candidates = [command("ask", ["--operator", "--fyi", "--notify", ...rest])];
  } else {
    candidates = [command("ask", [...(verb === "broadcast" ? ["--channel", "shared"] : []), "--fyi", ...args])];
  }
  const note = verb === "speak" ? "\nSender-controlled speech was removed; speaking aloud is the operator’s device setting." : "";
  return new ScoutCliError(`scout ${verb} was removed. Nothing was sent. Use:\n${candidates.map(value => `  ${value}`).join("\n")}${note}`);
}
