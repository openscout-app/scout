import { resolve } from "node:path";

import {
  parseScoutComposerRouteTarget,
  type RouteAliasBinding,
  type RouteAliasResolveResult,
  type ScoutCallerContext,
  type ScoutRouteTarget,
} from "@openscout/protocol";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { resolveScoutBrokerUrl } from "../../lib/core/broker/service.ts";

const HELP_FLAGS = new Set(["help", "--help", "-h"]);

export function renderAliasCommandHelp(): string {
  return [
    "Usage:",
    "  scout alias set <name> --to <agent|session:id> [--project <path>] [--host <node>] [--expires-in 8h] [--replace] [--if-revision N]",
    "  scout alias set <name> --self|--self-agent [scope options]",
    "  scout alias list [--project <path>] [--host <node>] [--target <id>] [--include-inactive]",
    "  scout alias resolve <name> [--project <path>] [--host <node>]",
    "  scout alias repoint <name> --to <target> [--if-revision N] [scope options]",
    "  scout alias unset <name> [--if-revision N] [scope options]",
    "",
    "Route aliases are mutable broker-owned pointers. They do not create or rename agent cards.",
    "Bare native agent names keep precedence; use alias:<name> for explicit alias routing.",
    "",
    "Examples:",
    "  scout alias set review --to scope.main.arts-mac-mini-local",
    "  scout alias set patch --to session:019eff52-9347-7470-ba5c-6bfe99d8dd83",
    "  scout alias repoint patch --to session:<new-id> --if-revision 4",
    "  scout ask --to alias:review \"take a fresh pass\"",
  ].join("\n");
}

function flagValue(args: string[], name: string): string | undefined {
  const equals = args.find((arg) => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new ScoutCliError(`${name} requires a value`);
  return value;
}

function parseRevision(args: string[]): number | undefined {
  const value = flagValue(args, "--if-revision");
  if (value === undefined) return undefined;
  const revision = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new ScoutCliError("--if-revision must be a positive integer");
  return revision;
}

function parseDuration(value: string): number {
  const match = value.trim().match(/^(\d+)(ms|s|m|h|d)$/i);
  if (!match) throw new ScoutCliError("--expires-in must be a duration such as 30m, 8h, or 7d");
  const amount = Number.parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  return amount * ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1);
}

function parseTarget(value: string | undefined): ScoutRouteTarget | undefined {
  if (!value) return undefined;
  const target = parseScoutComposerRouteTarget(value);
  if (!target) throw new ScoutCliError(`invalid alias target: ${value}`);
  if (target.kind === "route_alias") throw new ScoutCliError("a route alias cannot target another alias");
  if (target.kind === "channel" || target.kind === "broadcast" || target.kind === "binding_ref" || target.kind === "project_path") {
    throw new ScoutCliError("alias targets must be one existing durable agent or exact session");
  }
  return target;
}

function caller(context: ScoutCommandContext): ScoutCallerContext {
  const sessionId = context.env.OPENSCOUT_SESSION_ID?.trim()
    || context.env.CODEX_THREAD_ID?.trim()
    || context.env.CLAUDE_CODE_SESSION_ID?.trim()
    || context.env.ANTIGRAVITY_CONVERSATION_ID?.trim();
  return {
    actorId: context.env.OPENSCOUT_AGENT_ID?.trim() || "operator",
    currentDirectory: context.cwd,
    ...(sessionId ? { metadata: { sessionId } } : {}),
  };
}

function scope(context: ScoutCommandContext, args: string[]) {
  const project = flagValue(args, "--project");
  const host = flagValue(args, "--host");
  return {
    ...(project ? { projectRoot: resolve(context.cwd, project) } : {}),
    ...(host ? { nodeId: host } : {}),
  };
}

async function requestJson<T>(context: ScoutCommandContext, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(path, resolveScoutBrokerUrl()), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; detail?: string };
  if (!response.ok) throw new ScoutCliError(payload.detail ?? payload.error ?? `broker returned HTTP ${response.status}`);
  return payload;
}

function renderBinding(binding: RouteAliasBinding): string {
  const target = binding.target.kind === "agent"
    ? `agent:${binding.target.agentId}`
    : `session:${binding.target.sessionId}`;
  return [
    `alias ${binding.alias} → ${target}`,
    `scope ${binding.scopeProjectRoot ?? binding.scopeProjectKey} · ${binding.scopeNodeId}   revision ${binding.revision}   state ${binding.state}`,
    binding.expiresAt ? `expires ${new Date(binding.expiresAt).toISOString()}` : binding.target.kind === "session" ? "expires with session" : "durable",
  ].join("\n");
}

async function resolveBinding(context: ScoutCommandContext, name: string, args: string[]): Promise<RouteAliasResolveResult> {
  return requestJson<RouteAliasResolveResult>(context, "/v1/aliases/resolve", {
    method: "POST",
    body: JSON.stringify({ alias: name, scope: scope(context, args), caller: caller(context) }),
  });
}

export async function runAliasCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const command = args[0] ?? "";
  if (!command || HELP_FLAGS.has(command) || args.some((arg) => arg === "--help" || arg === "-h")) {
    context.output.writeText(renderAliasCommandHelp());
    return;
  }
  const rest = args.slice(1);

  if (command === "list") {
    const params = new URLSearchParams();
    const project = flagValue(rest, "--project");
    if (project) params.set("projectRoot", resolve(context.cwd, project));
    else params.set("currentDirectory", context.cwd);
    const host = flagValue(rest, "--host");
    if (host) params.set("nodeId", host);
    const target = flagValue(rest, "--target");
    if (target?.startsWith("session:")) params.set("targetSessionId", target.slice("session:".length));
    else if (target) params.set("targetAgentId", target.replace(/^agent:/, ""));
    if (rest.includes("--include-inactive")) params.set("includeInactive", "true");
    const result = await requestJson<{ bindings: RouteAliasBinding[] }>(context, `/v1/aliases?${params}`);
    context.output.writeValue(result, ({ bindings }) => bindings.length ? bindings.map(renderBinding).join("\n\n") : "No route aliases in this scope.");
    return;
  }

  const name = rest[0]?.trim();
  if (!name || name.startsWith("--")) throw new ScoutCliError(renderAliasCommandHelp());
  const options = rest.slice(1);

  if (command === "resolve") {
    const result = await resolveBinding(context, name, options);
    context.output.writeValue(result, (value) => value.binding
      ? `${renderBinding(value.binding)}\navailable ${value.available ? "yes" : "no"}${value.fullyQualifiedSelector ? `\nselector ${value.fullyQualifiedSelector}` : ""}`
      : value.diagnostic?.detail ?? `Unknown alias ${name}`);
    return;
  }

  if (command === "set") {
    const self = options.includes("--self") ? "session" : options.includes("--self-agent") ? "agent" : undefined;
    const target = parseTarget(flagValue(options, "--to"));
    if (Boolean(self) === Boolean(target)) throw new ScoutCliError("alias set requires exactly one of --to, --self, or --self-agent");
    const expiresIn = flagValue(options, "--expires-in");
    const expiresAtRaw = flagValue(options, "--expires-at");
    const expiresAt = expiresIn
      ? Date.now() + parseDuration(expiresIn)
      : expiresAtRaw
      ? Date.parse(expiresAtRaw)
      : undefined;
    if (expiresAtRaw && !Number.isFinite(expiresAt)) throw new ScoutCliError("--expires-at must be an ISO timestamp");
    const result = await requestJson<{ binding: RouteAliasBinding }>(context, "/v1/aliases", {
      method: "POST",
      body: JSON.stringify({
        alias: name,
        target,
        self,
        scope: scope(context, options),
        caller: caller(context),
        replace: options.includes("--replace"),
        expectedRevision: parseRevision(options),
        expiresAt,
      }),
    });
    context.output.writeValue(result.binding, renderBinding);
    return;
  }

  if (command === "repoint" || command === "unset") {
    const resolved = await resolveBinding(context, name, options);
    if (!resolved.binding) throw new ScoutCliError(resolved.diagnostic?.detail ?? `unknown alias ${name}`);
    const mutation = {
      expectedRevision: parseRevision(options),
      caller: caller(context),
      scope: scope(context, options),
      ...(command === "repoint" ? { target: parseTarget(flagValue(options, "--to")) } : {}),
    };
    if (command === "repoint" && !mutation.target) throw new ScoutCliError("alias repoint requires --to <target>");
    const result = await requestJson<{ binding: RouteAliasBinding }>(context, `/v1/aliases/${encodeURIComponent(resolved.binding.id)}`, {
      method: command === "repoint" ? "PATCH" : "DELETE",
      body: JSON.stringify(mutation),
    });
    context.output.writeValue(result.binding, renderBinding);
    return;
  }

  throw new ScoutCliError(`unknown alias command: ${command}`);
}
