// Pure, Node-safe lifecycle grammar shared by launchers and command handlers.
// Keep service, settings, filesystem and runtime imports out of this module.
import { resolve } from "node:path";

export const DEFAULT_DRAIN_TIMEOUT_MS = 30 * 60_000;

export const QUICK_LINKS = [
  "Quick links:",
  "  Install & setup: https://openscout.app/install.md",
  "  Quickstart:      https://openscout.app/docs/quickstart",
  "  Docs:            https://openscout.app/docs",
  "Troubleshooting: scout doctor",
].join("\n");

/**
 * Pull the global `--instance <name>` / `--instance=<name>` flag out of argv
 * (it selects which OpenScout instance the CLI talks to; same as
 * OPENSCOUT_INSTANCE). Only flags before the first `--` are considered.
 * Returns the remaining argv and the requested instance, if any.
 */
export function extractInstanceFlag(argv) {
  const rest = [];
  let instance = null;
  let passthrough = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (passthrough || token === "--") {
      passthrough = true;
      rest.push(token);
      continue;
    }
    if (token === "--instance") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("missing value for --instance (for example: scout --instance dev status)");
      }
      instance = value;
      index += 1;
      continue;
    }
    if (token.startsWith("--instance=")) {
      instance = token.slice("--instance=".length);
      if (!instance) throw new Error("missing value for --instance (for example: scout --instance=dev status)");
      continue;
    }
    rest.push(token);
  }
  return { argv: rest, instance };
}

/** Apply `--instance` to process.argv/process.env in place. Returns the instance name or null. */
export function applyInstanceFlag(processLike = process) {
  const { argv, instance } = extractInstanceFlag(processLike.argv.slice(2));
  processLike.argv = [...processLike.argv.slice(0, 2), ...argv];
  if (instance !== null) {
    processLike.env.OPENSCOUT_INSTANCE = instance;
    // Marks an explicit choice so surfaces that default to prod (the Claude
    // statusline) honour it across the Bun re-exec.
    processLike.env.OPENSCOUT_INSTANCE_EXPLICIT = "1";
  }
  return instance;
}

export function parseScoutArgv(argv) {
  let command = null;
  let helpRequested = false;
  let versionRequested = false;
  let outputMode = "plain";
  const args = [];

  for (const token of argv) {
    if (token === "--json") {
      outputMode = "json";
      continue;
    }

    if (command === null && (token === "--help" || token === "-h" || token === "help")) {
      helpRequested = true;
      continue;
    }

    if (command === null && (token === "--version" || token === "-v" || token === "version")) {
      versionRequested = true;
      continue;
    }

    if (command === null) {
      command = token;
      continue;
    }

    args.push(token);
  }

  return {
    command,
    args,
    helpRequested,
    versionRequested,
    outputMode,
  };
}

export function parseDrainTimeout(value) {
  const match = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] ?? "m";
  const scale = unit === "s" ? 1_000 : unit === "h" ? 3_600_000 : 60_000;
  const duration = Math.round(amount * scale);
  return Number.isSafeInteger(duration) ? duration : null;
}

export function renderAppCommandHelp() {
  return [
    "scout app — OpenScout application lifecycle",
    "",
    "Usage:",
    "  scout app status",
    "  scout app stop",
    "  scout app start",
    "  scout app restart",
    "",
    "Options:",
    "  --apps-only   Act only on the macOS app and its menu helper, leaving the",
    "                launchd services alone — on start and restart as well as on",
    "                stop. This is what a rebuild needs: the new bundle",
    "                invalidates the processes running from it, but not the",
    "                services, and bouncing those disconnects every agent.",
    "  --now         Do not wait for in-flight work. Without it, stop and",
    "                restart first wait for every waking/running flight to",
    "                finish, because the tree going down kills harnesses the",
    "                broker spawned mid-turn. Queued flights do not block; the",
    "                broker re-dispatches them at startup.",
    "  --timeout <t>  How long to wait for in-flight work (90s, 15m, 2h; bare",
    "                number = minutes; default 30m). On timeout nothing is",
    "                stopped and the blocking flights are listed.",
    "  --json        Structured output.",
    "",
    "Aliases:",
    "  stop = down = quit",
    "  start = up",
    "",
    "Ownership:",
    "  launchd        -> scoutd -> base/probes -> pairing/broker/edge -> web",
    "  LaunchServices -> Scout  -> embedded ScoutMenu",
    "",
    "Behavior:",
    "  Stop walks the tree leaf-first. The LaunchServices apps are signalled",
    "  individually (TERM, then KILL if they linger); the launchd tree comes down",
    "  with one bootout, because killing a supervised child only makes scoutd",
    "  start a new one. Processes are matched by executable path, so a Scout from",
    "  another checkout is reported rather than killed.",
    "",
    "  `scout up` / `scout down` manage local agents. This command manages the app.",
    "",
    "Examples:",
    "  scout app status",
    "  scout app restart",
    "  scout app restart --timeout 1h",
    "  scout app restart --now",
    "  scout app status --json",
  ].join("\n");
}

export function parseAppCommand(args) {
  const json = args.includes("--json");
  const scope = args.includes("--apps-only") ? "apps" : "all";
  const now = args.includes("--now");
  let drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS;
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--timeout" || arg.startsWith("--timeout=")) {
      const value = arg === "--timeout" ? args[++index] : arg.slice("--timeout=".length);
      const parsed = value === undefined ? null : parseDrainTimeout(value);
      if (parsed === null) {
        throw new Error(`invalid --timeout: ${value ?? "(missing)"} (try 90s, 15m, 2h)`);
      }
      drainTimeoutMs = parsed;
      continue;
    }
    if (arg.startsWith("-")) {
      if (!["--json", "--apps-only", "--now"].includes(arg)) {
        throw new Error(`unexpected argument for app: ${arg}`);
      }
    } else positional.push(arg);
  }
  if (positional.length > 1) throw new Error(`unexpected arguments for app: ${positional.join(" ")}`);
  const first = positional[0];
  const base = { scope, json, now, drainTimeoutMs };

  if (!first) {
    return { action: "status", ...base };
  }

  switch (first) {
    case "status":
      return { action: "status", ...base };
    case "stop":
    case "down":
    case "quit":
      return { action: "stop", ...base };
    case "start":
    case "up":
      return { action: "start", ...base };
    case "restart":
      return { action: "restart", ...base };
    default:
      throw new Error(`unknown subcommand: ${first} (try: scout app)`);
  }
}


export const UP_HELP = "Usage: scout up <name|path> [--name <alias>] [--harness <harness>] [--provider <provider>] [--model <model>] [--reasoning-effort <effort>] [--permission-profile <profile>]\nStart a local agent.\nAlias: --effort <effort> = --reasoning-effort <effort>.";
export const NODE_DOCTOR_HELP = [
  "Usage: scout doctor [--json] [--context-root <path>] [--fix [--yes]]",
  "", "Node headless CLI:",
  "Inspect the headless broker and harness readiness.",
  "--json    One headless report JSON object (not Bun's core/v1 NDJSON stream).",
  "--fix     Repair is not run by the Node headless CLI; use Bun or service help.",
  "--yes     Requires --fix.",
  "--detail  Available only in the Bun CLI.",
  "--help    Show this help without checking or maintaining services.",
].join("\n");

export const DOCTOR_HELP = [
    "Usage: scout doctor [--detail | --json] [--context-root <path>] [--fix [--yes]]",
    "", "Bun CLI:", "Default: concise checks as they finish, with a 6-second deadline per check.",
    "FAIL means observed impairment; ? means inconclusive, not confirmed failure.",
    "--detail  Full core report, including project inventory and internal paths.",
    "--json    Core-only scout.doctor.core/v1 NDJSON stream; ends with phase complete.",
    "Detailed output retains the full-scan wait behavior. Private app readiness is not checked.",
    "--fix     Explicit native core-daemon repair request; never installs app artifacts.",
    "--yes     Non-interactive confirmation for --fix.",
    "--help    Show this help without checking or maintaining services.",
  ].join("\n") + "\n\n" + NODE_DOCTOR_HELP;

export const SETUP_HELP = "Usage: scout setup [--source-root <path>] [--default-harness <name>] [--context-root <path>] [--json]\n\nConfigure project discovery and install/start the local broker. Private app readiness is not required.\nRepeat --source-root to add workspace roots. Prompts for a root in an interactive terminal.\nUse scout doctor to inspect readiness without requesting setup." + "\n\n" + QUICK_LINKS;

function flagValue(args, index, flag) {
  const inline = args[index].startsWith(flag + "=");
  const value = inline ? args[index].slice(flag.length + 1) : args[index + 1];
  if (!value?.trim() || (!inline && value.startsWith("-"))) throw new Error(`missing value for ${flag}`);
  return { value, nextIndex: inline ? index : index + 1 };
}

export function parseUpCommandOptions(args) {
  const fields = { "--name": "agentName", "--harness": "harness", "--model": "model", "--provider": "provider", "--reasoning-effort": "reasoningEffort", "--effort": "reasoningEffort", "--permission-profile": "permissionProfile" };
  const options = { target: null };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") continue;
    const flag = arg.split("=")[0];
    if (Object.hasOwn(fields, flag)) {
      const parsed = flagValue(args, index, flag);
      options[fields[flag]] = parsed.value;
      index = parsed.nextIndex;
    } else if (arg.startsWith("-")) {
      throw new Error(`unexpected argument for up: ${arg}`);
    } else if (options.target !== null) {
      throw new Error(`unexpected arguments for up: ${args.join(" ")}`);
    } else options.target = arg;
  }
  if (!options.target?.trim()) throw new Error(UP_HELP);
  return options;
}

export function parseSetupCommandOptions(args, defaultCurrentDirectory) {
  let currentDirectory = defaultCurrentDirectory;
  const sourceRoots = [];
  let defaultHarness = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") continue;
    const flag = arg.split("=")[0];
    if (!["--context-root", "--source-root", "--default-harness"].includes(flag)) {
      throw new Error(`unexpected arguments for setup: ${args.join(" ")}`);
    }
    const parsed = flagValue(args, index, flag);
    index = parsed.nextIndex;
    if (flag === "--context-root") currentDirectory = resolve(parsed.value);
    else if (flag === "--source-root") sourceRoots.push(resolve(parsed.value));
    else {
      if (!["claude", "codex", "cursor", "grok", "pi", "opencode", "devin"].includes(parsed.value)) {
        throw new Error(`invalid default harness: ${parsed.value}`);
      }
      defaultHarness = parsed.value;
    }
  }
  return { currentDirectory, sourceRoots, defaultHarness };
}

export const INSTALL_HELP = [
  "scout install — download and install the Scout macOS app",
  "",
  "Usage:",
  "  scout install                 # install or update to the latest signed release",
  "  scout install --check         # report installed vs latest, install nothing",
  "  scout install --version <tag> # install a specific release (e.g. v0.2.70)",
  "  scout install --force         # reinstall even if already up to date",
  "  scout install --no-restart    # do not relaunch Scout after installing",
  "  Aliases: -f = --force; --tag <tag> = --version <tag>",
  "  scout install --candidate <receipt.json> --dmg <file> # explicit local signed candidate",
  "",
  "Behavior:",
  "  Downloads the signed + notarized OpenScout.dmg from the GitHub release,",
  "  verifies the published byte size and sha256 digest when GitHub provides one,",
  "  then codesign and Gatekeeper-assess the DMG before mounting. Scout.app",
  "  must match the pinned bundle id and Team ID, pass codesign --deep --strict,",
  "  and pass Gatekeeper execute after staging. A running copy of the installed",
  "  app and any stale ScoutMenu helpers from other checkouts are stopped first;",
  "  replacement is staged and rolled back on failure.",
  "  Quarantine attributes are not cleared.",
  "",
  "  The app connects to the local service from @openscout/scout.",
  "  Install with `bun add -g @openscout/scout`.",
  "  The normal macOS local service requires Bun 1.4.4 or newer.",
  "",
  QUICK_LINKS,
].join("\n");

// Return help or validate the complete lexical grammar before service maintenance.
export function preflightLifecycle(argv, currentDirectory = process.cwd(), { runtimeHost = "auto" } = {}) {
  const input = parseScoutArgv(extractInstanceFlag(argv).argv);
  if (input.versionRequested) return null;
  let { command, args } = input;
  if (command === "relay") { command = args[0] ?? null; args = args.slice(1); }
  if (command === "doctor" && (input.helpRequested || args.includes("--help") || args.includes("-h"))) {
    // Bun/launcher JSON help stays with the declarative registry. Node's
    // headless entry has no structured-help surface; return its honest text.
    if (input.outputMode === "json" && runtimeHost !== "node") return null;
    return runtimeHost === "node" ? NODE_DOCTOR_HELP : DOCTOR_HELP;
  }
  // Structured help comes from the command registry, never a lifecycle handler.
  if (input.outputMode === "json" && input.helpRequested) return null;
  // Installation help is also available before Bun or a runtime bundle exists.
  // Actual install parsing and execution stay with the install command handler.
  if (command === "install" && (input.helpRequested || args.some(arg => ["help", "--help", "-h"].includes(arg)))) return INSTALL_HELP;
  if (!["setup", "up", "app"].includes(command)) return null;
  if (input.helpRequested || args.includes("--help") || args.includes("-h") || (command === "app" && args.includes("help"))) {
    return command === "app" ? renderAppCommandHelp() : command === "up" ? UP_HELP : SETUP_HELP;
  }
  if (command === "app") parseAppCommand(args);
  else if (command === "up") parseUpCommandOptions(args);
  else parseSetupCommandOptions(args, currentDirectory);
  return null;
}
