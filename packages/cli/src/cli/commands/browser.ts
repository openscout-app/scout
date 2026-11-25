import {
  BROWSER_ADAPTER_IDS,
  type BrowserActionKind,
  type BrowserActionRequest,
  type BrowserAdapterId,
  type BrowserSurfaceMode,
} from "@openscout/protocol";
import { createDefaultBrowserRouter, type BrowserRouter } from "@openscout/runtime";
import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

const BROWSER_HELP = `scout browser — Scout Computer's browser surface (companion, managed Chrome, browser-use)

Usage:
  scout browser status [--json]
  scout browser profiles [--json]
  scout browser open <url> [--profile <name>] [--adapter <id>] [--mode <companion|managed|regular|remote>] [--allow-origin <origin>] [--json]
  scout browser snapshot [--adapter <id>] [--url <url>] [--json]
  scout browser click <selector> [--adapter <id>] [--json]
  scout browser fill <selector> <text> [--adapter <id>] [--json]
  scout browser screenshot [--adapter <id>] [--url <url>] [--json]
  scout browser run <goal> [--adapter <id>] [--allow-origin <origin>] [--json]
  scout browser close [--scope <tab|browser>] [--adapter <id>] [--json]

Adapters:
  scout-companion   Scout Chrome Companion MV3 extension over the local bridge (default when connected)
  scout-native      Scout-owned Chrome profiles over CDP (reads existing Action profiles too)
  browser-use       External browser-use CLI behind Scout's lease and origin policy`;

function isAdapterId(value: string): value is BrowserAdapterId {
  return (BROWSER_ADAPTER_IDS as readonly string[]).includes(value);
}

function isSurfaceMode(value: string): value is BrowserSurfaceMode {
  return value === "companion" || value === "managed" || value === "regular" || value === "remote";
}

function parseFlags(args: string[]): {
  positional: string[];
  adapter?: BrowserAdapterId;
  mode?: BrowserSurfaceMode;
  profile?: string;
  url?: string;
  scope?: "tab" | "browser";
  allowOrigins: string[];
  help: boolean;
} {
  const positional: string[] = [];
  const allowOrigins: string[] = [];
  let adapter: BrowserAdapterId | undefined;
  let mode: BrowserSurfaceMode | undefined;
  let profile: string | undefined;
  let url: string | undefined;
  let scope: "tab" | "browser" | undefined;
  let help = false;

  const takeValue = (index: number, flag: string): [string, number] => {
    const raw = args[index] ?? "";
    const eq = raw.indexOf("=");
    if (eq >= 0) return [raw.slice(eq + 1), index];
    const next = args[index + 1];
    if (!next) throw new ScoutCliError(`${flag} needs a value`);
    return [next, index + 1];
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--help" || arg === "-h") { help = true; continue; }
    if (arg === "--json") continue;
    if (arg === "--adapter" || arg.startsWith("--adapter=")) {
      const [val, next] = takeValue(i, "--adapter");
      i = next;
      if (!isAdapterId(val)) throw new ScoutCliError(`unknown browser adapter: ${val} (expected ${BROWSER_ADAPTER_IDS.join("|")})`);
      adapter = val;
      continue;
    }
    if (arg === "--mode" || arg.startsWith("--mode=")) {
      const [val, next] = takeValue(i, "--mode");
      i = next;
      if (!isSurfaceMode(val)) throw new ScoutCliError(`unknown browser mode: ${val} (expected companion|managed|regular|remote)`);
      mode = val;
      continue;
    }
    if (arg === "--profile" || arg.startsWith("--profile=")) {
      const [val, next] = takeValue(i, "--profile");
      i = next;
      profile = val;
      continue;
    }
    if (arg === "--url" || arg.startsWith("--url=")) {
      const [val, next] = takeValue(i, "--url");
      i = next;
      url = val;
      continue;
    }
    if (arg === "--scope" || arg.startsWith("--scope=")) {
      const [val, next] = takeValue(i, "--scope");
      i = next;
      if (val !== "tab" && val !== "browser") throw new ScoutCliError(`unknown close scope: ${val} (expected tab|browser)`);
      scope = val;
      continue;
    }
    if (arg === "--allow-origin" || arg.startsWith("--allow-origin=")) {
      const [val, next] = takeValue(i, "--allow-origin");
      i = next;
      allowOrigins.push(val);
      continue;
    }
    if (arg.startsWith("--")) throw new ScoutCliError(`unknown option for scout browser: ${arg}`);
    positional.push(arg);
  }
  return { positional, adapter, mode, profile, url, scope, allowOrigins, help };
}

export async function runBrowserCommand(
  context: ScoutCommandContext,
  args: string[],
  router: BrowserRouter = createDefaultBrowserRouter(),
): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    context.output.writeText(BROWSER_HELP);
    return;
  }

  const parsed = parseFlags(args.slice(1));
  if (parsed.help) {
    context.output.writeText(BROWSER_HELP);
    return;
  }

  const driverId = context.env.SCOUT_AGENT_ID?.trim() || "scout-cli";

  if (subcommand === "status") {
    const adapters = await router.health();
    const lease = router.currentLease();
    const payload = { adapters, lease };
    context.output.writeValue(payload, () =>
      adapters.map((a) => {
        const state = a.available ? "ready" : "unavailable";
        const extra = [
          a.bridgeUrl,
          a.profiles?.length ? `profiles: ${a.profiles.map((p) => p.name).join(", ")}` : null,
          a.reason,
        ].filter(Boolean).join(" · ");
        return `${a.id.padEnd(16)} ${state.padEnd(12)} ${extra}`.trimEnd();
      }).join("\n"),
    );
    return;
  }

  if (subcommand === "profiles") {
    const receipt = await router.execute({
      action: "profiles",
      driverId,
      adapter: parsed.adapter ?? "scout-native",
    });
    context.output.writeValue(receipt, () => {
      const profiles = (receipt.data as { profiles?: Array<{ name: string; source: string }> } | undefined)?.profiles ?? [];
      return profiles.length
        ? profiles.map((p) => `${p.name} (${p.source})`).join("\n")
        : "No managed Chrome profiles found.";
    });
    return;
  }

  const actionMap: Record<string, BrowserActionKind> = {
    open: "open",
    snapshot: "snapshot",
    click: "click",
    fill: "fill",
    screenshot: "screenshot",
    run: "goal",
    close: "close",
  };
  const action = actionMap[subcommand];
  if (!action) {
    throw new ScoutCliError(`unknown browser subcommand: ${subcommand} (try: scout browser status|profiles|open|snapshot|click|fill|screenshot|run|close)`);
  }

  const request: BrowserActionRequest = {
    action,
    driverId,
    adapter: parsed.adapter,
    mode: parsed.mode,
    profile: parsed.profile,
    url: parsed.url,
    scope: parsed.scope,
    policy: parsed.allowOrigins.length ? { allowOrigins: parsed.allowOrigins } : undefined,
  };

  if (action === "open") {
    const url = parsed.positional[0] ?? parsed.url;
    if (!url) throw new ScoutCliError("scout browser open requires a <url>");
    request.url = url;
  } else if (action === "click") {
    const selector = parsed.positional[0];
    if (!selector) throw new ScoutCliError("scout browser click requires a <selector>");
    request.selector = selector;
  } else if (action === "fill") {
    const selector = parsed.positional[0];
    const text = parsed.positional.slice(1).join(" ");
    if (!selector || !text) throw new ScoutCliError("scout browser fill requires <selector> <text>");
    request.selector = selector;
    request.text = text;
  } else if (action === "goal") {
    const goal = parsed.positional.join(" ");
    if (!goal) throw new ScoutCliError("scout browser run requires a <goal>");
    request.goal = goal;
  }

  const receipt = await router.execute(request);
  if (context.output.mode === "json") {
    context.output.writeValue(receipt, () => "");
  } else if (receipt.ok) {
    const detail = [receipt.adapter, receipt.url, receipt.title, receipt.artifactPath].filter(Boolean).join(" · ");
    context.output.writeText(`${receipt.action}: ok${detail ? ` (${detail})` : ""}`);
  } else {
    throw new ScoutCliError(receipt.error ?? `browser ${subcommand} failed`);
  }
}
