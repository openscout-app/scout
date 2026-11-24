import { requestScoutBrokerJson, ScoutBrokerHttpError } from "@openscout/runtime/client";
import { resolveBrokerControlUrl } from "@openscout/runtime/config";
import {
  scoutBrokerPaths,
  type SessionNameListResult,
  type SessionNameSetRequest,
  type SessionNameSetResult,
} from "@openscout/protocol";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

export const SESSION_RENAME_HELP = `scout session rename — name a session for what it is doing now

Usage:
  scout session rename <selector> <name...> [--harness <name>]
  scout session rename <selector> --clear [--harness <name>]
  scout session rename --self <name...>      Name the session this command runs in
  scout session names                       List the names you have set

A selector is a native session id, <harness>:<id>, an agent or session actor
id, or a session address (sess.<token>@<host>). Add --harness when one id
names sessions in two harnesses, or to name a session Scout has not observed.

The name wins over the harness's title on every Scout read (runtime API, CLI,
MCP, the web app). The harness's own title stays available as harnessTitle.
An empty name, or --clear, removes yours. With no name of yours, a session
shows the title of the work item it is doing now, then the harness title.

Names are local to this machine. Scout never writes them into the harness's
own session files.`;

/** Env keys that carry the current harness session, by harness. */
const SELF_SESSION_ENV: Array<[key: string, harness: string]> = [
  ["CODEX_THREAD_ID", "codex"],
  ["OPENSCOUT_CODEX_THREAD_ID", "codex"],
  ["CLAUDE_CODE_SESSION_ID", "claude"],
  ["CLAUDE_SESSION_ID", "claude"],
];

export type SessionRenameArgs = {
  request: SessionNameSetRequest;
};

export function parseSessionRenameArgs(args: string[], env: NodeJS.ProcessEnv): SessionRenameArgs {
  let harness: string | undefined;
  let clear = false;
  let self = false;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--harness") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new ScoutCliError("--harness needs a value");
      harness = value;
      index += 1;
    } else if (arg.startsWith("--harness=")) {
      harness = arg.slice("--harness=".length);
    } else if (arg === "--clear") {
      clear = true;
    } else if (arg === "--self") {
      self = true;
    } else if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    } else if (arg.startsWith("--")) {
      throw new ScoutCliError(`unknown option for session rename: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  let selector: string | undefined;
  let nativeSessionId: string | undefined;
  if (self) {
    const found = SELF_SESSION_ENV.find(([key]) => env[key]?.trim());
    if (!found) {
      throw new ScoutCliError("--self needs a harness session in the environment (CLAUDE_CODE_SESSION_ID or CODEX_THREAD_ID); name the session instead");
    }
    nativeSessionId = env[found[0]]!.trim();
    harness ??= found[1];
  } else {
    selector = positional.shift();
    if (!selector) throw new ScoutCliError("name a session: scout session rename <selector> <name...> (see --help)");
  }

  const nameText = positional.join(" ").trim();
  if (clear && nameText) throw new ScoutCliError("pass a name or --clear, not both");
  if (!clear && !nameText) throw new ScoutCliError("give the new name, or --clear to remove yours");

  return {
    request: {
      ...(selector ? { selector } : {}),
      ...(nativeSessionId ? { nativeSessionId } : {}),
      ...(harness ? { harness } : {}),
      name: clear ? null : nameText,
    },
  };
}

function brokerUrl(context: Pick<ScoutCommandContext, "env">): { baseUrl: string; socketPath?: string } {
  return {
    baseUrl: context.env.OPENSCOUT_BROKER_URL?.trim() || resolveBrokerControlUrl(),
    socketPath: context.env.OPENSCOUT_BROKER_SOCKET_PATH?.trim() || undefined,
  };
}

function cliErrorFrom(error: unknown): unknown {
  if (!(error instanceof ScoutBrokerHttpError)) return error;
  let detail: string | undefined;
  let candidates: Array<{ harness: string; nativeSessionId: string }> = [];
  try {
    const body = JSON.parse(error.body) as { detail?: unknown; candidates?: unknown };
    if (typeof body.detail === "string") detail = body.detail;
    if (Array.isArray(body.candidates)) candidates = body.candidates as typeof candidates;
  } catch {}
  const lines = [detail ?? `the runtime refused the rename: HTTP ${error.status}${error.code ? ` ${error.code}` : ""}`];
  for (const candidate of candidates.slice(0, 8)) lines.push(`  ${candidate.harness}:${candidate.nativeSessionId}`);
  if (error.status === 404 && error.code !== "session_not_found") {
    lines.push("This runtime has no session-name API yet; update Scout and restart its runtime.");
  }
  return new ScoutCliError(lines.join("\n"));
}

export function renderSessionRename(result: SessionNameSetResult): string {
  const target = `${result.session.harness}:${result.session.nativeSessionId}`;
  const { resolution } = result;
  if (result.action === "cleared" || (result.action === "unchanged" && !result.record)) {
    const shown = resolution.name ? `"${resolution.name}" (${resolution.source === "work" ? "from its current work" : "the harness title"})` : "no name";
    return `${result.action === "cleared" ? "Cleared the name of" : "No name of yours on"} ${target}. It shows ${shown}.`;
  }
  const from = resolution.harnessTitle && resolution.harnessTitle !== resolution.name
    ? ` (renamed from "${resolution.harnessTitle}")`
    : "";
  return `${result.action === "unchanged" ? "Already named" : "Named"} ${target} "${resolution.name}"${from}.`;
}

function renderSessionNames(result: SessionNameListResult): string {
  if (result.names.length === 0) return "No session names set. Use scout session rename <selector> <name>.";
  return result.names
    .map((entry) => `${`${entry.harness}:${entry.nativeSessionId}`.padEnd(50)} ${entry.name}`)
    .join("\n");
}

export async function runSessionRenameAction(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    context.output.writeText(SESSION_RENAME_HELP);
    return;
  }
  const { request } = parseSessionRenameArgs(args, context.env);
  const { baseUrl, socketPath } = brokerUrl(context);
  let result: SessionNameSetResult;
  try {
    result = await requestScoutBrokerJson<SessionNameSetResult>(baseUrl, scoutBrokerPaths.v1.sessionNames, {
      method: "POST",
      body: request,
      socketPath,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw cliErrorFrom(error);
  }
  context.output.writeValue(result, renderSessionRename);
}

export async function runSessionNamesAction(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    context.output.writeText(SESSION_RENAME_HELP);
    return;
  }
  const { baseUrl, socketPath } = brokerUrl(context);
  let result: SessionNameListResult;
  try {
    result = await requestScoutBrokerJson<SessionNameListResult>(baseUrl, scoutBrokerPaths.v1.sessionNames, {
      socketPath,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw cliErrorFrom(error);
  }
  context.output.writeValue(result, renderSessionNames);
}
