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

const BROWSER_HELP = `scout browser — Scout Computer's real non-headless browser surface (companion, managed Chrome, Safari, browser-use)

Usage:
  scout browser status [--json]
  scout browser profiles [--json]
  scout browser open <url> [--profile <name>] [--adapter <id>] [--mode <companion|managed|regular|remote>] [--new-tab] [--background] [--allow-origin <origin>] [--json]
  scout browser tabs [--profile <name>] [--adapter <id>] [--json]
  scout browser snapshot [--profile <name>] [--tab <id>] [--adapter <id>] [--url <url>] [--json]
  scout browser click <selector-or-label> [--label <text>] [--profile <name>] [--adapter <id>] [--json]
  scout browser fill <selector-or-label> <text> [--label <text>] [--profile <name>] [--adapter <id>] [--json]
  scout browser resize [--width <n> --height <n>] [--mobile] [--reset] [--profile <name>] [--adapter <id>] [--json]
  scout browser screenshot [--output <path>] [--profile <name>] [--tab <id>] [--adapter <id>] [--url <url>] [--json]
  scout browser run <goal> [--adapter <id>] [--allow-origin <origin>] [--json]
  scout browser close [--scope <tab|browser>] [--profile <name>] [--tab <id>] [--adapter <id>] [--json]

Adapters:
  scout-companion   Scout Browser Companion MV3 extension over the local bridge (default when connected)
  scout-native      Scout-owned non-headless Chrome over CDP (auto-launches; reads existing Action profiles too)
  scout-safari      Direct macOS Safari tab control and DOM inspection
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
  tabId?: string;
  label?: string;
  outputPath?: string;
  width?: number;
  height?: number;
  mobile?: boolean;
  reset?: boolean;
  background?: boolean;
  newTab?: boolean;
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
  let tabId: string | undefined;
  let label: string | undefined;
  let outputPath: string | undefined;
  let width: number | undefined;
  let height: number | undefined;
  let mobile: boolean | undefined;
  let reset: boolean | undefined;
  let background: boolean | undefined;
  let newTab: boolean | undefined;
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
    if (arg === "--mobile") { mobile = true; continue; }
    if (arg === "--reset") { reset = true; continue; }
    if (arg === "--background") { background = true; continue; }
    if (arg === "--new-tab") { newTab = true; continue; }
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
    if (arg === "--tab" || arg.startsWith("--tab=")) {
      const [val, next] = takeValue(i, "--tab");
      i = next;
      tabId = val;
      continue;
    }
    if (arg === "--label" || arg.startsWith("--label=")) {
      const [val, next] = takeValue(i, "--label");
      i = next;
      label = val;
      continue;
    }
    if (arg === "--output" || arg.startsWith("--output=")) {
      const [val, next] = takeValue(i, "--output");
      i = next;
      outputPath = val;
      continue;
    }
    if (arg === "--width" || arg.startsWith("--width=")) {
      const [val, next] = takeValue(i, "--width");
      i = next;
      width = Number(val);
      continue;
    }
    if (arg === "--height" || arg.startsWith("--height=")) {
      const [val, next] = takeValue(i, "--height");
      i = next;
      height = Number(val);
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
  return { positional, adapter, mode, profile, url, tabId, label, outputPath, width, height, mobile, reset, background, newTab, scope, allowOrigins, help };
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
    tabs: "tabs",
    snapshot: "snapshot",
    click: "click",
    fill: "fill",
    resize: "resize",
    screenshot: "screenshot",
    run: "goal",
    close: "close",
  };
  const action = actionMap[subcommand];
  if (!action) {
    throw new ScoutCliError(`unknown browser subcommand: ${subcommand} (try: scout browser status|profiles|open|tabs|snapshot|click|fill|resize|screenshot|run|close)`);
  }

  const request: BrowserActionRequest = {
    action,
    driverId,
    adapter: parsed.adapter,
    mode: parsed.mode,
    profile: parsed.profile,
    url: parsed.url,
    tabId: parsed.tabId,
    label: parsed.label,
    outputPath: parsed.outputPath,
    reset: parsed.reset,
    background: parsed.background,
    newTab: parsed.newTab,
    viewport: parsed.width && parsed.height
      ? { width: parsed.width, height: parsed.height, mobile: parsed.mobile }
      : undefined,
    scope: parsed.scope,
    policy: parsed.allowOrigins.length ? { allowOrigins: parsed.allowOrigins } : undefined,
  };

  if (action === "open") {
    const url = parsed.positional[0] ?? parsed.url;
    if (!url) throw new ScoutCliError("scout browser open requires a <url>");
    request.url = url;
  } else if (action === "click") {
    const selector = parsed.positional[0];
    if (!selector && !parsed.label) throw new ScoutCliError("scout browser click requires a <selector> or --label");
    request.selector = selector;
  } else if (action === "fill") {
    const selector = parsed.positional[0];
    const text = parsed.positional.slice(1).join(" ");
    if ((!selector && !parsed.label) || !text) throw new ScoutCliError("scout browser fill requires <selector> <text>");
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
