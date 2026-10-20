#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const binDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(binDir, "..");
const distDir = resolve(binDir, "../dist");
const sourceDir = resolve(binDir, "../src");
const sourceMain = {
  listening: resolve(sourceDir, "room-listening-daemon.ts"),
  base: resolve(sourceDir, "base-daemon.ts"),
  broker: resolve(sourceDir, "broker-daemon.ts"),
  service: resolve(sourceDir, "broker-process-manager.ts"),
  discover: resolve(sourceDir, "mesh-discover.ts"),
  otel: resolve(sourceDir, "otlp/entry.ts"),
};
const distMain = {
  listening: resolve(distDir, "room-listening-daemon.js"),
  base: resolve(distDir, "base-daemon.js"),
  broker: resolve(distDir, "broker-daemon.js"),
  service: resolve(distDir, "broker-process-manager.js"),
  discover: resolve(distDir, "mesh-discover.js"),
  otel: resolve(distDir, "otlp/entry.js"),
};
const processNames = {
  listening: "scout-listening",
  base: "scout-base",
  broker: "scout-broker",
  service: "scout-service",
  discover: "scout-discover",
  otel: "scout-otel",
};
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const [, , command = "service", ...args] = process.argv;
// Handle lifecycle help and validate arguments before importing or building any
// entrypoint. Daemon modules start work as a top-level import side effect.
const lifecycleCommands = new Set(["base", "broker", "service", "discover"]);
if (command === "--help" || command === "-h" || command === "help"
    || (lifecycleCommands.has(command) && args.some(arg => arg === "--help" || arg === "-h"))) {
  console.log("Usage: openscout-runtime <base|broker|service|discover> [options]\n"
    + "  base / broker        Run the daemon in the foreground (no flags).\n"
    + "  service [install|start|stop|restart|uninstall|status] [--json]\n"
    + "                       Manage the local broker service; default: status.\n"
    + "  discover [seed ...]  Discover mesh peers through the broker.\n"
    + "  --help, -h           Show help without starting or changing anything.");
  process.exit(0);
}
if (lifecycleCommands.has(command)) {
  const positional = args.filter(arg => !arg.startsWith("-"));
  const invalid = command === "service"
    ? args.some(arg => arg.startsWith("-") && arg !== "--json")
      || positional.length > 1
      || (positional.length === 1 && !["install", "start", "stop", "restart", "uninstall", "status"].includes(positional[0]))
    : command === "discover" ? args.some(arg => arg.startsWith("-")) : args.length > 0;
  if (invalid) {
    console.error(`Unsupported arguments for openscout-runtime ${command}: ${args.join(" ")} (try --help)`);
    process.exit(1);
  }
}


if (!Object.hasOwn(sourceMain, command)) {
  // EX_CONFIG; consumed by scout-base without parsing human stderr.
  console.error(JSON.stringify({ code: "unsupported_runtime_command", command, exitCode: 78 }));
  process.exit(78);
}

const processName = processNames[command] ?? "scout-runtime";
process.title = processName;

function runServiceEntrypoint(entry, entryArgs) {
  const result = spawnSync(process.execPath, [entry, ...entryArgs], {
    encoding: "utf8",
    argv0: processName,
    stdio: ["inherit", "pipe", "pipe"],
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }

  process.exit(result.status ?? 0);
}

async function runInProcessEntrypoint(entry, entryArgs) {
  // Long-lived commands (base/broker/discover) run in-process: this wrapper
  // BECOMES the daemon instead of spawning a second runtime, which removes one
  // redundant supervision layer per hop (scoutd → scout-base → scout-broker is
  // three processes instead of five). The daemon entries install their own
  // SIGINT/SIGTERM handlers (base-daemon.ts / broker-daemon.ts), and the
  // supervisors above already escalate TERM → wait → KILL, so the wrapper must
  // not register competing signal handlers or SIGKILL timers here.
  //
  // Rewrite argv so entries that parse process.argv (mesh-discover.ts reads
  // process.argv.slice(2) for seeds) see the same shape as when they were
  // spawned directly: [execPath, entry, ...entryArgs].
  process.argv = [process.argv[0], entry, ...entryArgs];
  try {
    await import(pathToFileURL(entry).href);
  } catch (error) {
    // A top-level throw during daemon startup must surface as a non-zero exit
    // so the parent supervisor sees the real failure.
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  }
}

async function runEntrypoint(entry, entryArgs) {
  if (command === "service") {
    runServiceEntrypoint(entry, entryArgs);
    return;
  }
  await runInProcessEntrypoint(entry, entryArgs);
}

function canRunTypeScriptSource() {
  return typeof globalThis.Bun !== "undefined";
}

function shouldPreferSourceEntry() {
  const preference = process.env.OPENSCOUT_RUNTIME_ENTRYPOINT?.trim().toLowerCase();
  if (preference === "source" || preference === "src") {
    return true;
  }
  if (preference === "dist") {
    return false;
  }
  return process.env.OPENSCOUT_BROKER_SERVICE_MODE?.trim().toLowerCase() === "dev";
}

// A dist entry built before instance support would ignore OPENSCOUT_INSTANCE
// (and a checkout's dev default) and run on prod's ports and directories.
function distEntryIsStale(entry) {
  try {
    return !/instance(?:-checkout)?-bootstrap|\.\/instance\.js|OPENSCOUT_INSTANCE_MESH/.test(readFileSync(entry, "utf8"));
  } catch {
    return false;
  }
}

// Only where the instance matters: an explicitly prod process (every
// supervisor pins it) keeps today's dist behaviour, and an explicit
// OPENSCOUT_RUNTIME_ENTRYPOINT=dist is honoured as asked.
function instanceCheckApplies() {
  const instance = process.env.OPENSCOUT_INSTANCE?.trim().toLowerCase();
  if (instance === "prod" || instance === "production" || instance === "default") return false;
  const preference = process.env.OPENSCOUT_RUNTIME_ENTRYPOINT?.trim().toLowerCase();
  return preference !== "dist";
}

const distEntry = distMain[command];
const sourceEntry = sourceMain[command];
const staleDist = instanceCheckApplies()
  && existsSync(distEntry) && existsSync(sourceEntry) && distEntryIsStale(distEntry);
if (staleDist && !canRunTypeScriptSource()) {
  console.error(
    `openscout-runtime: ${distEntry} predates instance support (OPENSCOUT_INSTANCE). `
      + "Rebuild with `npm run build`, or run with Bun to use the source entry.",
  );
  process.exit(1);
}
if (canRunTypeScriptSource() && (shouldPreferSourceEntry() || staleDist) && existsSync(sourceEntry)) {
  await runEntrypoint(sourceEntry, args);
} else if (existsSync(distEntry)) {
  await runEntrypoint(distEntry, args);
} else {
  const buildResult = spawnSync(npmCommand, ["run", "build"], {
    cwd: packageDir,
    stdio: "inherit",
  });

  if ((buildResult.status ?? 1) !== 0) {
    process.exit(buildResult.status ?? 1);
  }

  const rebuiltEntry = distMain[command];
  if (!existsSync(rebuiltEntry)) {
    console.error(`Missing openscout-runtime dist entry for ${command} after build.`);
    process.exit(1);
  }

  await runEntrypoint(rebuiltEntry, args);
}
