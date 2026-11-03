#!/usr/bin/env node

import { enforceBunVersion } from "./bun-preflight.mjs";
enforceBunVersion();

import { constants, existsSync, readFileSync, accessSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { applyInstanceFlag, parseScoutArgv, preflightLifecycle, QUICK_LINKS } from "./lifecycle-preflight.mjs";

const binDir = dirname(fileURLToPath(import.meta.url));
const bunDistEntry = resolve(binDir, "../dist/main.mjs");
const bunStatuslineEntry = resolve(binDir, "../dist/statusline.mjs");
const nodeDistEntry = resolve(binDir, "../dist/node/main.mjs");
const nodeStatuslineEntry = resolve(binDir, "../dist/node/statusline.mjs");
const packageJsonPath = resolve(binDir, "../package.json");

const packageVersion = readPackageVersion();
if (!process.env.SCOUT_APP_VERSION && packageVersion) {
  process.env.SCOUT_APP_VERSION = packageVersion;
}

try {
  applyInstanceFlag(process);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
await main();

// Persistent transports retain their natural lifecycle. Inspection commands
// explicitly drain and exit even if a runtime import retained live handles.
async function main() {
  const command = process.argv[2];
  try {
    const help = preflightLifecycle(process.argv.slice(2));
    if (help !== null) { console.log(help); return; }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`${packageVersion ?? "0.0.0"}\n`);
    return;
  }

  // Chat is a standalone HTTP client: do not load broker/setup entrypoints.
  if (command === "chat") {
    await import(pathToFileURL(resolve(binDir, "../dist/chat.mjs")).href);
    return;
  }

  const wantsHelp = !command || command === "--help" || command === "-h" || command === "help";
  const wantsStatusline = command === "statusline" && process.argv[3] === "claude";
  const preferredHost = normalizeHost(process.env.OPENSCOUT_RUNTIME_HOST);
  const bunPath = preferredHost === "node" ? null : resolveBunExecutable();
  const shouldTryNode = preferredHost === "node" || !bunPath || wantsStatusline;

  if (shouldTryNode && preferredHost !== "bun") {
    const nodeEntry = wantsStatusline && existsSync(bunStatuslineEntry)
      ? bunStatuslineEntry
      : wantsStatusline
        ? nodeStatuslineEntry
        : nodeDistEntry;
    if (existsSync(nodeEntry)) {
      try {
        if (!bunPath) {
          process.env.OPENSCOUT_RUNTIME_HOST ??= "node";
        }
        await import(pathToFileURL(nodeEntry).href);
        await finishInspectionOutput();
        return;
      } catch (error) {
        if (preferredHost !== "node" && bunPath) {
          // A dev checkout can have a stale or incomplete dist/node bundle. Prefer
          // the known-good Bun CLI unless the caller explicitly requested Node.
        } else {
          if (wantsHelp) {
            process.stdout.write(renderNodeFallbackHelp(packageVersion));
            return;
          }
          console.error(describeNodeEntrypointFailure(error));
          process.exit(1);
        }
      }
    } else if (preferredHost === "node" && wantsHelp) {
      process.stdout.write(renderNodeFallbackHelp(packageVersion));
      return;
    }
  }

  if (bunPath) {
    const bunEntry = wantsStatusline ? bunStatuslineEntry : bunDistEntry;
    if (!existsSync(bunEntry)) {
      console.error(`Scout ${wantsStatusline ? "statusline" : "CLI"} Bun entry is missing. Reinstall @openscout/scout or rebuild the package.`);
      process.exit(1);
    }

    if (isCurrentRuntimeBun()) {
      await import(pathToFileURL(bunEntry).href);
      await finishInspectionOutput();
      return;
    }

    // Inspection needs the same drain/exit boundary when Node delegates to Bun.
    // Keep other command entrypoints and persistent transport lifecycles intact.
    const childEntry = isInspectionCommand() ? fileURLToPath(import.meta.url) : bunEntry;
    const result = spawnSync(bunPath, [childEntry, ...process.argv.slice(2)], {
      env: process.env,
      stdio: "inherit",
    });
    if (result.error) {
      console.error(`Scout could not run Bun at ${bunPath}: ${result.error.message}`);
      process.exit(1);
    }
    process.exit(result.status ?? (result.signal ? 1 : 0));
  }

  if (preferredHost === "bun") {
    console.error(
      "Scout was asked to use the Bun runtime, but Bun was not found.\n" +
      "Install Bun: curl -fsSL https://bun.sh/install | bash\n" +
      "Or unset OPENSCOUT_RUNTIME_HOST to allow the Node headless runtime when it is packaged.\n\n" + QUICK_LINKS,
    );
    process.exit(1);
  }

  if (wantsHelp) {
    process.stdout.write(renderNodeFallbackHelp(packageVersion));
    return;
  }

  console.error(
    "Scout could not find a runnable headless runtime.\n" +
    "This package version still needs Bun for the full CLI because the Node headless entrypoint is not packaged yet.\n" +
    "Install Bun: curl -fsSL https://bun.sh/install | bash\n" +
    "Future @openscout/scout packages should run the headless broker through Node when Bun is unavailable.\n\n" + QUICK_LINKS,
  );
  process.exit(1);

}

function isInspectionCommand() {
  const input = parseScoutArgv(process.argv.slice(2));
  const command = input.command === "relay" ? input.args[0] : input.command;
  return command === "who" || command === "check" || command === "recent" || command === "where" || command === "locate" || command === "route";
}

async function finishInspectionOutput() {
  if (!isInspectionCommand()) return;
  // Import completion is not stdout completion: writes to pipes are async.
  // Use the CLI context's drainable streams before forcing a one-shot exit.
  // MCP/chat and main-dispatch's ask/send --tracked lifecycle stay unchanged.
  await Promise.all([process.stdout, process.stderr].map((stream) => new Promise((resolve, reject) => {
    stream.end((error) => error ? reject(error) : resolve());
  })));
  process.exit(process.exitCode ?? 0);
}

function readPackageVersion() {
  if (!existsSync(packageJsonPath)) return null;
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return typeof packageJson.version === "string" && packageJson.version.trim()
      ? packageJson.version.trim()
      : null;
  } catch {
    return null;
  }
}

function normalizeHost(value) {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "bun") return "bun";
  if (normalized === "node") return "node";
  return null;
}

function isCurrentRuntimeBun() {
  return typeof globalThis.Bun !== "undefined";
}

function resolveBunExecutable() {
  for (const key of ["OPENSCOUT_BUN_BIN", "SCOUT_BUN_BIN", "BUN_BIN"]) {
    const explicit = process.env[key]?.trim();
    if (!explicit) continue;
    const resolved = explicit.includes("/") || explicit.startsWith(".")
      ? resolve(expandHomePath(explicit))
      : findOnPath(explicit);
    if (isExecutable(resolved)) return resolved;
  }

  return findOnPath("bun", [
    ...(process.env.HOME ? [join(process.env.HOME, ".bun", "bin")] : []),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]);
}

function findOnPath(name, extraDirectories = []) {
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of [...pathEntries, ...extraDirectories]) {
    for (const ext of extensions) {
      const candidate = join(expandHomePath(directory), `${name}${ext}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function expandHomePath(value) {
  if (value === "~") return process.env.HOME ?? value;
  if (value.startsWith("~/") && process.env.HOME) return join(process.env.HOME, value.slice(2));
  return value;
}

function isExecutable(candidate) {
  if (!candidate) return false;
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function describeNodeEntrypointFailure(error) {
  const reason = error instanceof Error && error.message
    ? `\nNode entrypoint failure: ${error.message}`
    : "";
  return "Scout could not start the Node headless entrypoint.\n" +
    "The Node headless entrypoint is not packaged yet or is incomplete, so this package version still needs Bun for the full CLI.\n" +
    "Install Bun: curl -fsSL https://bun.sh/install | bash\n" +
    "Future @openscout/scout packages should run the headless broker through Node when Bun is unavailable." +
    reason + "\n\n" + QUICK_LINKS;
}

function renderNodeFallbackHelp(version) {
  const label = version ? `Scout ${version}` : "Scout";
  return `${label}

Usage:
  scout <command> [options]

Available without Bun:
  scout --version           Print the installed Scout package version.
  scout --help              Print this fallback help.
  scout statusline claude   Print the Claude statusline segment.

Full CLI commands:
  scout setup
  scout doctor
  scout whoami
  scout ask
  scout reply

This package can be installed with npm, but the full CLI currently needs Bun
until the Node headless entrypoint is packaged. Install Bun with:
  curl -fsSL https://bun.sh/install | bash

${QUICK_LINKS}
`;
}
