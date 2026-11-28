import { requestScoutBrokerJson } from "@openscout/runtime/client";
import { resolveBrokerControlUrl } from "@openscout/runtime/config";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

export function renderPermissionsCommandHelp(): string {
  return [
    "Usage:",
    "  scout permissions log [--since 7d] [--decision approved|asked|denied|closed|answered]",
    "                        [--agent <id or name>] [--rule <rule>] [--tool <tool>] [--project <path>] [--signal <name>] [--limit N] [--json]",
    "  scout permissions stats [--since 7d] [--agent <id or name>] [--project <path>] [--json]",
    "  scout permissions rules [--json]",
    "  scout permissions dry-run <allow|ask|deny> '<rule>' [--project <path>] [--since 30d] [--json]",
    "",
    "The permission watcher's record: every call it approved or denied, every one it asked",
    "you about, every one that closed on its own, and every answer you gave, with the rule",
    "that decided it (or mode:auto). Rules use Claude Code's Tool(pattern) syntax, as in",
    "~/.claude/settings.json: Bash(git push:*), Read(~/dev/app/**), mcp__scout__ask.",
    "",
    "dry-run lists the past records a new rule would have matched, and the deny or ask rule",
    "that would still win over it. It writes nothing. Only the operator adds rules.",
    "",
    "Escalation signals (download-execute, agent-config, secret-egress, trifecta,",
    "encoded-egress, push-scope, denial-burst) turn an automatic approval into a question;",
    "they never deny. A held call shows \"signal <name> (held)\" in the log.",
  ].join("\n");
}

type Options = {
  command: "log" | "stats" | "rules" | "dry-run";
  query: URLSearchParams;
};

const VALUE_FLAGS = new Set(["--since", "--until", "--decision", "--agent", "--rule", "--tool", "--project", "--limit", "--via", "--signal"]);

/** `7d`, `12h`, `30m`, or an epoch in milliseconds. */
export function parseSince(value: string, now = Date.now()): number {
  const relative = /^(\d+)([dhm])$/.exec(value.trim());
  if (relative) {
    const unit = relative[2] === "d" ? 86_400_000 : relative[2] === "h" ? 3_600_000 : 60_000;
    return now - Number(relative[1]) * unit;
  }
  const absolute = Number(value);
  if (Number.isFinite(absolute) && absolute > 0) return absolute;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return date;
  throw new ScoutCliError(`--since needs 7d, 12h, 30m, a date or an epoch, not ${value}`);
}

function parse(args: string[]): Options | "help" {
  if (!args.length || args.includes("--help") || args.includes("-h")) return "help";
  const [command, ...rest] = args;
  if (command !== "log" && command !== "stats" && command !== "rules" && command !== "dry-run") {
    throw new ScoutCliError(`unknown permissions command ${command} (see scout permissions --help)`);
  }
  const query = new URLSearchParams();
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "--json") continue;
    const [flag, inline] = arg.includes("=") && arg.startsWith("--") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (VALUE_FLAGS.has(flag)) {
      const value = inline ?? rest[++index];
      if (value === undefined || (inline === undefined && value.startsWith("--"))) throw new ScoutCliError(`${flag} needs a value`);
      const name = flag.slice(2);
      query.set(name, name === "since" || name === "until" ? String(parseSince(value)) : value);
      continue;
    }
    if (arg.startsWith("--")) throw new ScoutCliError(`unexpected flag for permissions: ${arg}`);
    positional.push(arg);
  }
  if (command === "dry-run") {
    const [list, rule] = positional;
    if (list !== "allow" && list !== "ask" && list !== "deny") throw new ScoutCliError("scout permissions dry-run needs a list: allow, ask or deny");
    if (!rule) throw new ScoutCliError("scout permissions dry-run needs a rule, e.g. 'Bash(bun run *build)'");
    query.set("list", list);
    query.set("rule", rule);
  } else if (positional.length) {
    throw new ScoutCliError(`scout permissions ${command} takes no arguments`);
  }
  return { command, query };
}

type Row = { at: number; decision: string; via?: string; answer?: string; rule: string; list: string; label?: string; signal?: string; signalLine?: string; held?: boolean; agentName?: string; agentId?: string; tool?: string; command: string | null; reason: string };
type Counts = Record<string, number>;
type Stats = {
  since: number; until: number; total: number; byDecision: Counts;
  byRule: Array<{ rule: string; list: string; total: number }>;
  byAgent: Array<{ agentId: string | null; agentName: string | null; total: number; byDecision: Counts }>;
  byVia: Array<{ via: string; total: number }>;
  bySignal?: Array<{ signal: string; total: number; held: number; yes: number; no: number }>;
};
type RulesView = { path: string; defaultMode: string; precedence: string; scopes: Array<{ scope: string; mode: string; lists: Record<string, Array<{ rule: string; builtin: boolean }>> }> };
type DryRun = { rule: string; list: string; scope: string; total: number; matches: Array<Row & { wouldBe: string; wouldBeLabel?: string; shadowedBy?: { rule: string; list: string } }> };

function when(at: number): string {
  return new Date(at).toISOString().replace("T", " ").slice(0, 16);
}

function renderRow(row: Row): string {
  const who = row.agentName ?? row.agentId ?? "unknown agent";
  const how = row.decision === "answered" ? `answered ${row.answer ?? ""}${row.via ? ` via ${row.via}` : ""}` : row.decision;
  const line = `${when(row.at)}  ${how.padEnd(18)} ${(row.label ?? row.rule).padEnd(28)} ${who} · ${row.tool ?? "?"} ${row.command ?? ""}`.trimEnd();
  if (!row.signal) return line;
  return `${line}\n${" ".repeat(18)}signal ${row.signal}${row.held ? " (held)" : ""}: ${row.signalLine ?? ""}`.trimEnd();
}

function renderStats(stats: Stats): string {
  const lines = [`${when(stats.since)} → ${when(stats.until)}: ${stats.total} decisions`];
  lines.push(`  ${Object.entries(stats.byDecision).map(([key, value]) => `${key} ${value}`).join(" · ")}`);
  if (stats.byRule.length) lines.push("by rule:", ...stats.byRule.slice(0, 15).map((rule) => `  ${String(rule.total).padStart(5)}  ${rule.list.padEnd(8)} ${rule.rule}`));
  if (stats.byAgent.length) lines.push("by agent:", ...stats.byAgent.slice(0, 15).map((agent) => `  ${String(agent.total).padStart(5)}  ${agent.agentName ?? agent.agentId ?? "unknown"}`));
  if (stats.bySignal?.length) {
    lines.push("by signal (fired · asks it caused · operator yes/no):", ...stats.bySignal.map((signal) =>
      `  ${String(signal.total).padStart(5)}  ${signal.signal.padEnd(18)} held ${signal.held} · yes ${signal.yes} · no ${signal.no}`));
  }
  if (stats.byVia.length) lines.push(`by surface: ${stats.byVia.map((via) => `${via.via} ${via.total}`).join(" · ")}`);
  return lines.join("\n");
}

function renderRules(view: RulesView): string {
  const lines = [view.path, view.precedence];
  for (const scope of view.scopes) {
    lines.push("", `${scope.scope}  (mode ${scope.mode})`);
    for (const list of ["deny", "ask", "allow"]) {
      for (const rule of scope.lists[list] ?? []) lines.push(`  ${list.padEnd(6)} ${rule.rule}${rule.builtin ? (list === "allow" ? "  (default; names what auto passes)" : "  (default)") : ""}`);
    }
  }
  return lines.join("\n");
}

function renderDryRun(result: DryRun): string {
  const lines = [`${result.list} ${result.rule} (${result.scope}) would have matched ${result.total} past records`];
  for (const match of result.matches) {
    const outcome = match.shadowedBy ? `  — ${match.shadowedBy.list} ${match.shadowedBy.rule} still wins` : match.wouldBeLabel ? `  → ${match.wouldBeLabel}` : "";
    lines.push(`  ${renderRow(match)}${outcome}`);
  }
  return lines.join("\n");
}

export async function runPermissionsCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const options = parse(args);
  if (options === "help") { context.output.writeText(renderPermissionsCommandHelp()); return; }
  const baseUrl = context.env.OPENSCOUT_BROKER_URL?.trim() || resolveBrokerControlUrl();
  const socketPath = context.env.OPENSCOUT_BROKER_SOCKET_PATH?.trim() || undefined;
  const signal = AbortSignal.timeout(15_000);
  const path = (route: string) => `${route}${options.query.size ? `?${options.query}` : ""}`;
  if (options.command === "log") {
    const result = await requestScoutBrokerJson<{ records: Row[] }>(baseUrl, path("/v1/permissions/log"), { method: "GET", socketPath, signal });
    context.output.writeValue(result, (value) => value.records.length ? value.records.map(renderRow).join("\n") : "No permission decisions in that window.");
    return;
  }
  if (options.command === "stats") {
    const result = await requestScoutBrokerJson<Stats>(baseUrl, path("/v1/permissions/stats"), { method: "GET", socketPath, signal });
    context.output.writeValue(result, renderStats);
    return;
  }
  if (options.command === "rules") {
    const result = await requestScoutBrokerJson<RulesView>(baseUrl, "/v1/permissions/rules", { method: "GET", socketPath, signal });
    context.output.writeValue(result, renderRules);
    return;
  }
  const result = await requestScoutBrokerJson<DryRun>(baseUrl, path("/v1/permissions/rules/dry-run"), { method: "GET", socketPath, signal });
  context.output.writeValue(result, renderDryRun);
}
