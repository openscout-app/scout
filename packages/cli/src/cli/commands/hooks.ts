import { requestScoutBrokerJson, ScoutBrokerHttpError } from "@openscout/runtime/client";
import { resolveBrokerControlUrl } from "@openscout/runtime/config";
import type { HarnessHookStatus, HarnessHookTarget, HarnessHooksResult, HarnessHooksSkipReason } from "../../../../runtime/src/harness-hooks.js";
import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

type HooksOptions = {
  command: "status" | "apply" | "remove";
  harness?: HarnessHookTarget;
  json: boolean;
  help: boolean;
};

function normalizeHookHarness(value: string): HarnessHookTarget | null {
  const lower = value.trim().toLowerCase();
  if (lower === "claude" || lower === "claude-code") return "claude";
  if (lower === "antigravity" || lower === "agy") return "antigravity";
  return null;
}

export function renderHooksCommandHelp(): string {
  return [
    "Usage:",
    "  scout hooks [status] [claude|antigravity] [--json]",
    "  scout hooks apply [claude|antigravity] [--json]",
    "  scout hooks remove [claude|antigravity] [--json]",
    "",
    "Scout's hooks in harness settings. The runtime writes them and takes them out.",
    "Claude Code: a PermissionRequest hook, so permission dialogs in any Claude session",
    "can be answered from Scout.",
    "Antigravity: non-blocking PreToolUse/PostToolUse/Stop hooks, so questions and",
    "approval gates in native Antigravity sessions show up in Scout.",
    "",
    "apply   Add Scout's entries. Running it again changes nothing.",
    "remove  Take out Scout's entries, scripts, and hook state. Nothing of Scout's stays behind.",
  ].join("\n");
}

export function parseHooksCommandOptions(args: string[]): HooksOptions {
  const result: HooksOptions = { command: "status", json: false, help: false };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h" || arg === "help") return { ...result, help: true };
    if (arg === "--json") { result.json = true; continue; }
    if (arg === "--harness") {
      const next = args[i + 1];
      if (!next) throw new ScoutCliError("--harness requires claude or antigravity");
      const target = normalizeHookHarness(next);
      if (!target) throw new ScoutCliError(`Unknown hooks harness: ${next}`);
      result.harness = target;
      i += 1;
      continue;
    }
    if (arg.startsWith("--harness=")) {
      const raw = arg.slice("--harness=".length);
      const target = normalizeHookHarness(raw);
      if (!target) throw new ScoutCliError(`Unknown hooks harness: ${raw}`);
      result.harness = target;
      continue;
    }
    if (arg.startsWith("-")) throw new ScoutCliError(`Unknown hooks option: ${arg}`);
    positional.push(arg);
  }
  if (positional.length > 2) {
    throw new ScoutCliError("scout hooks takes at most a command (status, apply, remove) and a harness (claude, antigravity)");
  }
  if (positional.length === 1) {
    const only = positional[0]!;
    const asHarness = normalizeHookHarness(only);
    if (asHarness) {
      result.command = "status";
      result.harness = result.harness ?? asHarness;
      return result;
    }
  }
  const command = positional[0] ?? "status";
  if (command !== "status" && command !== "apply" && command !== "remove") {
    throw new ScoutCliError(`Unknown hooks command: ${command}`);
  }
  result.command = command;
  if (positional[1]) {
    const target = normalizeHookHarness(positional[1]);
    if (!target) throw new ScoutCliError(`Unknown hooks harness: ${positional[1]}`);
    result.harness = target;
  }
  return result;
}

const SKIP_REASONS: Record<HarnessHooksSkipReason, string> = {
  "non-prod-instance": "This runtime is not the main Scout instance, so it leaves harness settings to that one. Set OPENSCOUT_HOOKS_INSTANCE to this instance's name to let it.",
  "isolated-support-directory": "This runtime keeps its files in a temporary folder, so it does not point harness settings at them.",
  "scout-cli-not-found": "The runtime could not find a scout command to run from the hook. Install the Scout CLI, then apply again.",
  "owned-by-other-install": "Another Scout install's hook is in the settings and its script still exists. Remove it from that install first.",
};

function describeHook(hook: HarnessHookStatus): string {
  const label = hook.state === "applied" ? "applied" : hook.state === "absent" ? "not applied" : "needs apply";
  const product = hook.harness === "antigravity" ? "Antigravity" : "Claude Code";
  const lines = [`${product} ${hook.event}: ${label}`, `  settings: ${hook.settingsPath}`];
  if (hook.state !== "absent") lines.push(`  script:   ${hook.wrapperPath}`);
  if (hook.detail) lines.push(`  ${hook.detail} Run \`scout hooks apply ${hook.harness}\` to fix it, or \`scout hooks remove ${hook.harness}\`.`);
  return lines.join("\n");
}

export function renderHooksResult(result: HarnessHooksResult): string {
  const verb = result.action === "apply" ? "Applied" : "Removed";
  const head = result.outcome === "skipped"
    ? `Nothing changed. ${result.reason ? SKIP_REASONS[result.reason] : ""}`.trim()
    : result.outcome === "unchanged"
      ? (result.action === "apply" ? "Already applied; nothing changed." : "Nothing to remove.")
      : `${verb} Scout's hooks.`;
  return [head, ...result.hooks.map(describeHook)].join("\n");
}

export async function runHooksCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const options = parseHooksCommandOptions(args);
  if (options.help) { context.output.writeText(renderHooksCommandHelp()); return; }
  const baseUrl = context.env.OPENSCOUT_BROKER_URL?.trim() || resolveBrokerControlUrl();
  const path = options.command === "status"
    ? (options.harness ? `/v1/hooks?harness=${encodeURIComponent(options.harness)}` : "/v1/hooks")
    : `/v1/hooks/${options.command}`;
  let result: { hooks: HarnessHookStatus[] } | HarnessHooksResult;
  try {
    result = await requestScoutBrokerJson<typeof result>(baseUrl, path, {
      method: options.command === "status" ? "GET" : "POST",
      ...(options.command === "status" ? {} : { body: options.harness ? { harness: options.harness } : {} }),
      socketPath: context.env.OPENSCOUT_BROKER_SOCKET_PATH?.trim() || undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (error instanceof ScoutBrokerHttpError && error.status === 404) {
      throw new ScoutCliError("This runtime does not manage hooks yet. Update Scout and restart the runtime (HTTP 404).");
    }
    if (error instanceof ScoutBrokerHttpError && error.status === 409) {
      let detail = error.body;
      try { detail = String((JSON.parse(error.body) as { error?: unknown }).error ?? error.body); } catch { /* raw body */ }
      throw new ScoutCliError(`The runtime left the settings alone. ${detail}`);
    }
    throw error;
  }
  if (options.json) { context.output.writeText(JSON.stringify(result, null, 2)); return; }
  context.output.writeText("action" in result ? renderHooksResult(result) : result.hooks.map(describeHook).join("\n"));
}
