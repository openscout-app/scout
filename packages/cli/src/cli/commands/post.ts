import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { resolveScoutBrokerUrl, resolveScoutSenderId } from "../../lib/core/broker/service.ts";

const USAGE = "Usage: scout post <text> [--file <path>] [--link <url>]... [--milestone] [--text-file <path>]";
export const POST_HELP = `${USAGE}
Post a short update to the operator's Feed, as yourself. Attach the thing itself with --file (a screenshot, clip or doc from your workspace); the text is its caption.
Post when you shipped something people can see, found something surprising, made a call the operator would want to know about, are blocked, or hit a real milestone (--milestone).
Don't post acknowledgements, step-by-step narration, or a status that hasn't changed. Keep it short, plain and confident. Never attach secrets.`;

export function parsePostArgs(args: string[]): { text?: string; textFile?: string; file?: string; links: string[]; milestone: boolean } {
  const parsed: { text?: string; textFile?: string; file?: string; links: string[]; milestone: boolean } = { links: [], milestone: false };
  const words: string[] = [];
  // Accept both `--flag value` and `--flag=value`.
  args = args.flatMap(arg => /^--(file|link|text-file)=/.test(arg) ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const value = () => { const next = args[++index]; if (next === undefined || next.startsWith("--")) throw new ScoutCliError(USAGE); return next; };
    if (arg === "--file") parsed.file = value();
    else if (arg === "--link") parsed.links.push(value());
    else if (arg === "--text-file") parsed.textFile = value();
    else if (arg === "--milestone") parsed.milestone = true;
    else if (arg.startsWith("--")) throw new ScoutCliError(USAGE);
    else words.push(arg);
  }
  if (words.length) parsed.text = words.join(" ");
  if (!parsed.text === !parsed.textFile) throw new ScoutCliError(USAGE);
  return parsed;
}

export function callerHarness(env: NodeJS.ProcessEnv): string | undefined {
  return env.CODEX_THREAD_ID ? "codex" : env.CLAUDE_CODE_SESSION_ID ? "claude" : undefined;
}

export async function runPostCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) { context.output.writeText(POST_HELP); return; }
  const parsed = parsePostArgs(args);
  const text = parsed.text ?? await readFile(resolve(context.cwd, parsed.textFile!), "utf8");
  const agentId = await resolveScoutSenderId(null, context.cwd, context.env);
  const sessionId = context.env.OPENSCOUT_SESSION_ID || context.env.CODEX_THREAD_ID || context.env.CLAUDE_CODE_SESSION_ID;
  const response = await fetch(new URL("/v1/posts", resolveScoutBrokerUrl()), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text,
      ...(parsed.file ? { file: resolve(context.cwd, parsed.file) } : {}),
      ...(parsed.links.length ? { links: parsed.links.map(url => ({ url })) } : {}),
      ...(parsed.milestone ? { milestone: true } : {}),
      caller: { actorId: agentId, currentDirectory: context.cwd, metadata: { sessionId, harness: callerHarness(context.env) } },
    }),
  });
  const result = await response.json() as { error?: string; detail?: string; post?: { id: string } };
  if (!response.ok) throw new ScoutCliError(result.detail ? `${result.error}: ${result.detail}` : result.error || `post failed (${response.status})`);
  context.output.writeValue(result, value => `Posted ${value.post?.id}`);
}
