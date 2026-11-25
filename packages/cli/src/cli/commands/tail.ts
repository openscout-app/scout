import { isPlainTailEvent } from "@openscout/runtime/harnesses";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import {
  readScoutTailEvents,
  watchScoutTailEvents,
  type TailEvent,
  type TailEventKind,
} from "../../lib/core/tail/service.ts";

const HELP_FLAGS = new Set(["--help", "-h"]);
const TAIL_EVENT_KINDS = new Set<TailEventKind>([
  "user",
  "assistant",
  "tool",
  "tool-result",
  "system",
  "other",
]);

export type ScoutTailCommandOptions = {
  limit: number;
  sources?: string[];
  kinds?: TailEventKind[];
  sessionId?: string;
  project?: string;
  cwd?: string;
  query?: string;
  since?: string;
  once: boolean;
  transcripts?: boolean;
  raw: boolean;
  verbose: boolean;
};

export type RenderTailEventOptions = {
  raw?: boolean;
  verbose?: boolean;
  columns?: number;
  color?: boolean;
};

const FALLBACK_COLUMNS = 80;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

const SOURCE_COLOR: Record<string, string> = {
  grok: "38;5;216",
  claude: "38;5;173",
  kimi: "38;5;140",
  omp: "38;5;73",
  codex: "38;5;110",
  cursor: "38;5;108",
};

export function renderTailCommandHelp(): string {
  return [
    "Usage: scout tail [options]",
    "",
    "Stream observed harness events from the broker tail firehose.",
    "Plain output hides harness lifecycle noise; --json stays complete.",
    "",
    "Filters:",
    "  --source <name>                   Runtime source such as claude or codex; repeatable",
    "  --kind <kind>                     user, assistant, tool, tool-result, system, or other; repeatable",
    "  --session <id>                    Limit to one harness session id",
    "  --project <text>                  Match project name",
    "  --cwd <path>                      Match working directory text",
    "  --query <text>                    Match source, kind, session, project, cwd, origin, or summary",
    "",
    "Output:",
    "  --limit <count>                   Initial backlog count (default 80)",
    "  --since <event-id>                Resume live streaming after a TailEvent id cursor",
    "  --once                            Print the backlog and exit",
    "  --transcripts                     Always include recent transcript history (automatic when the backlog has no visible events)",
    "  --no-transcripts                  Read only the live backlog",
    "  --verbose, --debug                Show the full firehose including lifecycle noise",
    "  --raw                             Unfiltered plain output plus bounded raw payload JSON",
    "  --json                            Emit JSON (streaming mode uses NDJSON); complete events",
    "",
    "Examples:",
    "  scout tail",
    "  scout tail --verbose",
    "  scout tail --source codex --kind tool-result",
    "  scout tail --project openscout --query permission --once",
    "  scout tail --transcripts --limit 200 --json",
  ].join("\n");
}

export function parseTailCommandOptions(args: string[]): ScoutTailCommandOptions {
  let limit = 80;
  const sources: string[] = [];
  const kinds: TailEventKind[] = [];
  let sessionId: string | undefined;
  let project: string | undefined;
  let cwd: string | undefined;
  let query: string | undefined;
  let since: string | undefined;
  let once = false;
  let transcripts: boolean | undefined;
  let raw = false;
  let verbose = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--once") {
      once = true;
      continue;
    }
    if (arg === "--follow" || arg === "-f") {
      once = false;
      continue;
    }
    if (arg === "--transcripts") {
      transcripts = true;
      continue;
    }
    if (arg === "--no-transcripts") {
      transcripts = false;
      continue;
    }
    if (arg === "--raw") {
      raw = true;
      continue;
    }
    if (arg === "--verbose" || arg === "--debug") {
      verbose = true;
      continue;
    }
    if (arg === "--source") {
      sources.push(...parseCsvFlag(args[++index], "--source"));
      continue;
    }
    if (arg.startsWith("--source=")) {
      sources.push(...parseCsvFlag(arg.slice("--source=".length), "--source"));
      continue;
    }
    if (arg === "--kind") {
      kinds.push(...parseKindFlag(args[++index]));
      continue;
    }
    if (arg.startsWith("--kind=")) {
      kinds.push(...parseKindFlag(arg.slice("--kind=".length)));
      continue;
    }
    if (arg === "--session" || arg === "--session-id") {
      sessionId = parseStringFlag(args[++index], arg);
      continue;
    }
    if (arg.startsWith("--session=")) {
      sessionId = parseStringFlag(arg.slice("--session=".length), "--session");
      continue;
    }
    if (arg.startsWith("--session-id=")) {
      sessionId = parseStringFlag(arg.slice("--session-id=".length), "--session-id");
      continue;
    }
    if (arg === "--project") {
      project = parseStringFlag(args[++index], "--project");
      continue;
    }
    if (arg.startsWith("--project=")) {
      project = parseStringFlag(arg.slice("--project=".length), "--project");
      continue;
    }
    if (arg === "--cwd") {
      cwd = parseStringFlag(args[++index], "--cwd");
      continue;
    }
    if (arg.startsWith("--cwd=")) {
      cwd = parseStringFlag(arg.slice("--cwd=".length), "--cwd");
      continue;
    }
    if (arg === "--query" || arg === "-q") {
      query = parseStringFlag(args[++index], arg);
      continue;
    }
    if (arg.startsWith("--query=")) {
      query = parseStringFlag(arg.slice("--query=".length), "--query");
      continue;
    }
    if (arg === "--since") {
      since = parseStringFlag(args[++index], "--since");
      continue;
    }
    if (arg.startsWith("--since=")) {
      since = parseStringFlag(arg.slice("--since=".length), "--since");
      continue;
    }
    if (arg === "--limit") {
      limit = parseLimit(args[++index]);
      continue;
    }
    if (arg.startsWith("--limit=")) {
      limit = parseLimit(arg.slice("--limit=".length));
      continue;
    }
    if (arg.startsWith("-")) {
      throw new ScoutCliError(`unknown tail option: ${arg}`);
    }
    query = [query, arg].filter(Boolean).join(" ");
  }

  return {
    limit,
    ...(sources.length > 0 ? { sources: unique(sources) } : {}),
    ...(kinds.length > 0 ? { kinds: unique(kinds) } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(project ? { project } : {}),
    ...(cwd ? { cwd } : {}),
    ...(query ? { query } : {}),
    ...(since ? { since } : {}),
    once,
    transcripts,
    raw,
    verbose,
  };
}

export async function runTailCommand(
  context: ScoutCommandContext,
  args: string[],
  readRecent = readScoutTailEvents,
): Promise<void> {
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(renderTailCommandHelp());
    return;
  }

  const options = parseTailCommandOptions(args);
  const readBacklog = (transcripts: boolean) => readRecent({
    limit: options.limit,
    sources: options.sources,
    kinds: options.kinds,
    sessionId: options.sessionId,
    project: options.project,
    cwd: options.cwd,
    query: options.query,
    transcripts,
    plain: context.output.mode === "plain" && !options.raw && !options.verbose,
  });
  let initial = options.since && !options.once
    ? { generatedAt: Date.now(), limit: options.limit, cursor: options.since, events: [] }
    : await readBacklog(options.transcripts === true);
  const renderOptions: RenderTailEventOptions = {
    raw: options.raw,
    verbose: options.verbose,
    color: process.stdout.isTTY === true,
  };

  if (!options.since && options.transcripts === undefined) {
    const visible = context.output.mode === "json" ? initial.events.length > 0
      : initial.events.some(event => includeTailEvent(event, renderOptions));
    if (!visible) initial = await readBacklog(true);
  }

  if (options.once) {
    context.output.writeValue(initial, (value) => {
      if (value.events.length === 0) return "No tail events found.";
      const rendered = renderTailEvents(value.events, renderOptions);
      return rendered || "No tail events found.";
    });
    return;
  }

  const emitEvent = (event: TailEvent) => {
    if (!tailEventMatches(event, options)) return;
    if (context.output.mode === "json") {
      context.stdout(JSON.stringify(event));
      return;
    }
    if (!includeTailEvent(event, renderOptions)) return;
    context.stdout(renderTailEvent(event, renderOptions));
  };

  for (const event of initial.events) {
    emitEvent(event);
  }

  // A file-backed cursor may be outside the live replay window.
  const initialIds = new Set(initial.events.map(event => event.id));
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.on("SIGINT", shutdown);

  try {
    // no banner — the rail should just start moving
    await watchScoutTailEvents({
      since: options.since ?? initial.cursor ?? undefined,
      sources: options.sources,
      signal: controller.signal,
      onEvent: (event) => {
        if (!initialIds.delete(event.id)) emitEvent(event);
      },
    });
  } finally {
    process.off("SIGINT", shutdown);
  }
}

export function renderTailEvents(events: TailEvent[], options: RenderTailEventOptions = {}): string {
  const visible = events.filter((event) => includeTailEvent(event, options));
  return visible.map((event) => renderTailEvent(event, options)).join("\n");
}

export function renderTailEvent(event: TailEvent, options: RenderTailEventOptions = {}): string {
  const columns = resolveColumns(options.columns);
  const color = options.color ?? false;
  const clock = formatClock(event.ts);
  const name = event.source.slice(0, 6);
  const source = name.padEnd(6, " ");
  const rest = options.verbose || options.raw
    ? compactTailSummary(event.summary, Math.max(8, columns - 16))
    : sceneRest(event, Math.max(8, columns - 14));
  const painted = color
    ? `${dim(clock)}  ${paint(sourceColor(event.source), name)}${" ".repeat(Math.max(0, 6 - name.length))}  ${rest}`
    : `${clock}  ${source}  ${rest}`;
  const line = clipVisible(painted, columns);
  if (!options.raw || event.raw === undefined) {
    return line;
  }
  return `${line}\n${JSON.stringify(event.raw, null, 2)}`;
}

function includeTailEvent(event: TailEvent, options: RenderTailEventOptions): boolean {
  return Boolean(options.verbose || options.raw) || isPlainTailEvent(event);
}

function tailEventMatches(event: TailEvent, options: ScoutTailCommandOptions): boolean {
  if (options.sources?.length && !options.sources.includes(event.source)) return false;
  if (options.kinds?.length && !options.kinds.includes(event.kind)) return false;
  if (options.sessionId && event.sessionId !== options.sessionId) return false;
  if (options.project && !event.project.toLowerCase().includes(options.project.toLowerCase())) return false;
  if (options.cwd && !event.cwd.toLowerCase().includes(options.cwd.toLowerCase())) return false;
  if (options.query) {
    const query = options.query.toLowerCase();
    const haystack = [
      event.source,
      event.kind,
      event.sessionId,
      event.project,
      event.cwd,
      event.harness,
      event.summary,
    ].join("\n").toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  return true;
}

function parseCsvFlag(value: string | undefined, flag: string): string[] {
  const trimmed = parseStringFlag(value, flag);
  return trimmed
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseKindFlag(value: string | undefined): TailEventKind[] {
  return parseCsvFlag(value, "--kind").map((kind) => {
    if (!TAIL_EVENT_KINDS.has(kind as TailEventKind)) {
      throw new ScoutCliError(`unknown tail kind "${kind}". Use one of: ${[...TAIL_EVENT_KINDS].join(", ")}`);
    }
    return kind as TailEventKind;
  });
}

function parseStringFlag(value: string | undefined, flag: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new ScoutCliError(`${flag} requires a value`);
  }
  return trimmed;
}

function parseLimit(value: string | undefined): number {
  const raw = parseStringFlag(value, "--limit");
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 1_000) {
    throw new ScoutCliError("--limit must be a number between 1 and 1000");
  }
  return parsed;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function resolveColumns(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  const detected = process.stdout.columns;
  if (typeof detected === "number" && Number.isFinite(detected) && detected > 0) {
    return detected;
  }
  return FALLBACK_COLUMNS;
}

function compactTailSummary(summary: string, maxLength: number): string {
  const normalized = flatten(summary).replace(/\/Users\/[^/\s]+\//g, "~/");
  const shortened = normalized.replace(/(?:~|\/)[^\s]+/g, shortenPathToken);
  return compact(shortened, maxLength);
}

function sceneRest(event: TailEvent, maxLength: number): string {
  if (event.kind === "assistant" || event.kind === "user"
      || (event.source === "antigravity" && (event.kind === "tool" || event.kind === "tool-result"))) {
    return compact(flatten(event.summary), maxLength);
  }
  const { verb, noun } = sceneWork(event.summary);
  if (!noun) return compact(verb, maxLength);
  return compact(`${verb}  ${noun}`, maxLength);
}

const WORK_VERBS: Array<[RegExp, string]> = [
  [/^(read_file|read)\b/i, "read"],
  [/^(search_replace|strreplace|edit)\b/i, "edit"],
  [/^(write_file|write)\b/i, "write"],
  [/^(run_terminal_command|bash|shell)\b/i, "run"],
  [/^(grep)\b/i, "grep"],
  [/^(glob|find)\b/i, "find"],
  [/^(web_search|websearch)\b/i, "search"],
  [/^(web_fetch|webfetch|open_page|open_page_with_find)\b/i, "fetch"],
];

function sceneWork(summary: string): { verb: string; noun: string } {
  const normalized = flatten(summary)
    .replace(/\s+·\s+(success|error|failed)$/i, "")
    .replace(/\/Users\/[^/\s]+\//g, "~/");
  const [head = "", ...tail] = normalized.split(/\s+·\s+/);
  const rawVerb = head.trim();
  const rest = tail.join(" · ").trim();
  let verb = rawVerb.toLowerCase();
  for (const [pattern, name] of WORK_VERBS) {
    if (pattern.test(rawVerb)) {
      verb = name;
      break;
    }
  }
  return { verb, noun: sceneNoun(verb, rest || rawVerb) };
}

function sceneNoun(verb: string, rest: string): string {
  const pathMatch = rest.match(/(\S+\.\w+)\b/);
  if (pathMatch?.[1]) {
    const parts = pathMatch[1].split(/[\\/]/);
    return parts.at(-1) ?? pathMatch[1];
  }
  if (verb === "run") {
    const tokens = rest.split(/\s+/).filter((token) => token.length > 0 && !token.includes("="));
    const cmd = tokens.find((token) => !token.startsWith("-")) ?? tokens[0];
    if (cmd && cmd !== "run" && cmd !== "run_terminal_command") {
      return cmd.replace(/^.*\//, "");
    }
    return "";
  }
  const shortened = rest.replace(/(?:~|\/)[^\s]+/g, shortenPathToken);
  if (shortened === verb) return "";
  return shortened;
}

function shortenPathToken(token: string): string {
  const folded = token.replace(/\/Users\/[^/\s]+\//g, "~/");
  const segments = folded.split(/[\\/]/).filter(Boolean);
  if (segments.length <= 2) return folded;
  if (!folded.startsWith("~/") && !folded.startsWith("/")) return folded;
  return segments.slice(-2).join("/");
}

function flatten(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sourceColor(source: string): string {
  return SOURCE_COLOR[source.toLowerCase()] ?? "38;5;245";
}

function paint(code: string, text: string): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}

function dim(text: string): string {
  return paint("2", text);
}

function visibleWidth(value: string): number {
  return value.replace(ANSI_RE, "").length;
}

function clipVisible(line: string, columns: number): string {
  const budget = Math.max(1, columns);
  if (visibleWidth(line) <= budget) return line;
  const limit = Math.max(0, budget - 1);
  let width = 0;
  let out = "";
  let i = 0;
  while (i < line.length && width < limit) {
    if (line[i] === "\x1b") {
      const match = line.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    out += line[i];
    width += 1;
    i += 1;
  }
  return `${out}…${out.includes("\x1b[") ? "\x1b[0m" : ""}`;
}

function compact(value: string, maxLength: number): string {
  const normalized = flatten(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}
