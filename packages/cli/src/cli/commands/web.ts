import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

import {
  DIST_KEY_KEYCHAIN_SERVICE,
  SCOUT_DIST_DEFAULT_URL,
  distBaseUrl,
  distKeyPath,
  fileDistKeyStore,
  keychainDistKeyStore,
  resolveDistKey,
  secretServiceDistKeyStore,
  type DistKeyStore,
} from "@openscout/runtime/routing";
import {
  readWebFullClientProfile,
  resolveInstalledWebFullClient,
  webFullClientDirectory,
  webFullClientsDirectory,
} from "@openscout/runtime/client";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { SCOUT_APP_VERSION } from "../../lib/shared/product.ts";
import {
  distKeyStores,
  distRequest,
  explainFailure,
  isInteractive,
  readFlagValue,
  runAuthLogin,
  runAuthLogout,
  supportDirectoryOf,
  type ScoutAuthDeps,
} from "./auth.ts";
import { requestScoutWebControl } from "./server.ts";

export { DIST_KEY_KEYCHAIN_SERVICE, SCOUT_DIST_DEFAULT_URL, distKeyPath, fileDistKeyStore, keychainDistKeyStore, secretServiceDistKeyStore };
export type { DistKeyStore };
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

export type ScoutWebCommandDeps = ScoutAuthDeps & {
  version?: string;
  restartWeb?: () => Promise<string>;
  /** May shorten the complete download budget; never extends the production cap. */
  downloadTimeoutMs?: number;
};

export function renderWebCommandHelp(): string {
  return [
    "scout web — the full Scout web app",
    "",
    "The Scout core contains no web app. The Scout apps supply the web server; signed-in",
    "accounts download the full app for this Scout version from console.openscout.app.",
    "",
    "Usage:",
    "  scout web install [--version <x.y.z>] [--no-restart] [--no-browser]",
    "                                  Download, verify and install the full web app;",
    "                                  signs in first when there is no saved key",
    "  scout web status                Show installed versions, client selection, and next step",
    "  scout web uninstall             Remove installed web clients",
    "  scout web login                 Same as scout auth login (a piped key is saved as is)",
    "  scout web logout                Same as scout auth logout",
    "",
    "Sign in with scout auth login. SCOUT_DIST_KEY overrides the saved key (handy for",
    "VMs and CI). OPENSCOUT_DIST_URL points at another download host.",
  ].join("\n");
}

/* ------------------------------------------------------------------ */

async function defaultRestartWeb(): Promise<string> {
  const status = await requestScoutWebControl("restart");
  return status.webUrl;
}

async function runInstall(context: ScoutCommandContext, args: string[], deps: ScoutWebCommandDeps): Promise<void> {
  const supportDirectory = supportDirectoryOf(deps);
  const version = readFlagValue(args, "--version") ?? deps.version ?? SCOUT_APP_VERSION;
  const target = webFullClientDirectory(version, supportDirectory);
  if (!args.includes("--force") && resolveInstalledWebFullClient(version, { env: {}, supportDirectory })) {
    context.output.writeText(`The full web app ${version} is already installed. --force reinstalls it.`);
    return;
  }

  const stores = await distKeyStores(deps, context.env);
  let resolved = await resolveDistKey(context.env, stores);
  if (!resolved) {
    // Someone at a terminal signs in here and the install carries on; scripts get the command to run.
    if (!isInteractive(context, deps)) throw new ScoutCliError("No download key. Sign in first: scout auth login");
    context.stderr("Signing in first…");
    await runAuthLogin(context, args.includes("--no-browser") ? ["--no-browser"] : [], deps, { next: null });
    resolved = await resolveDistKey(context.env, stores);
    if (!resolved) throw new ScoutCliError("Signed in, but the saved key couldn't be read back. Run: scout auth status");
  }

  const timeoutMs = Number.isFinite(deps.downloadTimeoutMs)
    ? Math.max(1, Math.min(DOWNLOAD_TIMEOUT_MS, deps.downloadTimeoutMs!)) : DOWNLOAD_TIMEOUT_MS;
  // One budget covers headers, body consumption AND the file writer. Passing
  // a signal only to fetch leaves a stalled stream/pipeline without a deadline.
  const downloadSignal = AbortSignal.timeout(timeoutMs);
  const response = await distRequest(context, deps, resolved.key, `/v1/dist/web-full/${encodeURIComponent(version)}`, timeoutMs, downloadSignal);
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    const reason = explainFailure(response.status, body);
    throw new ScoutCliError(reason === "not_published"
      ? `The full web app isn't published for Scout ${version} yet.`
      : reason);
  }
  const expected = response.headers.get("x-openscout-sha256")?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new ScoutCliError("The download came without a checksum; not installing it.");
  if (!response.body) throw new ScoutCliError("The download was empty.");

  const root = webFullClientsDirectory(supportDirectory);
  mkdirSync(root, { recursive: true });
  const workDirectory = join(root, `.install-${process.pid}-${Date.now()}`);
  mkdirSync(workDirectory, { recursive: true });
  try {
    const tarball = join(workDirectory, "web-full.tar.gz");
    const hash = createHash("sha256");
    const source = Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>);
    source.on("data", (chunk: Buffer) => hash.update(chunk));
    await pipeline(source, createWriteStream(tarball), { signal: downloadSignal });
    const actual = hash.digest("hex");
    if (actual !== expected) {
      throw new ScoutCliError(`Checksum mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…); not installing.`);
    }

    const unpacked = join(workDirectory, "client");
    mkdirSync(unpacked, { recursive: true });
    // Extraction is asynchronous so downloads do not block the CLI event loop.
    try {
      await promisify(execFile)("tar", ["-xzf", tarball, "-C", unpacked], {
        encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 128 * 1024,
      });
    } catch (error) {
      throw new ScoutCliError(`Couldn't unpack the download: ${error instanceof Error ? error.message : String(error)}`);
    }
    const profile = readWebFullClientProfile(unpacked);
    if (!existsSync(join(unpacked, "index.html")) || profile?.version !== version) {
      throw new ScoutCliError(`The download isn't the full web app for ${version}; not installing it.`);
    }

    // Swap in place: the old copy (if any) moves aside before the new one lands.
    const previous = existsSync(target) ? join(workDirectory, "previous") : null;
    if (previous) renameSync(target, previous);
    try {
      renameSync(unpacked, target);
    } catch (error) {
      if (previous) renameSync(previous, target);
      throw error;
    }
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }

  // Only the installed CLI's version is ever served; older copies are dead weight.
  for (const entry of readdirSync(root)) {
    if (entry !== version && !entry.startsWith(".")) rmSync(join(root, entry), { recursive: true, force: true });
  }

  context.output.writeText(`Installed the full web app ${version} → ${target}`);
  if (args.includes("--no-restart")) {
    context.output.writeText("Restart Scout's web server to serve it: scout server restart");
    return;
  }
  try {
    const url = await (deps.restartWeb ?? defaultRestartWeb)();
    context.output.writeText(`Restarted Scout web; the full app is at ${url}`);
  } catch (error) {
    context.output.writeText(`Installed, but Scout's web server didn't restart (${error instanceof Error ? error.message : String(error)}). Run: scout server restart`);
  }
}

function runUninstall(context: ScoutCommandContext, deps: ScoutWebCommandDeps): void {
  const root = webFullClientsDirectory(supportDirectoryOf(deps));
  const existed = existsSync(root) && readdirSync(root).some((entry) => !entry.startsWith("."));
  rmSync(root, { recursive: true, force: true });
  context.output.writeText(existed
    ? "Removed the full web app. Restart the app-supplied web server: scout server restart"
    : "The full web app isn't installed.");
}

function installedFullVersions(supportDirectory: string): string[] {
  const root = webFullClientsDirectory(supportDirectory);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .filter((entry) => {
      const directory = join(root, entry.name);
      return existsSync(join(directory, "index.html"))
        && readWebFullClientProfile(directory)?.version === entry.name;
    })
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

async function runStatus(context: ScoutCommandContext, deps: ScoutWebCommandDeps): Promise<void> {
  const supportDirectory = supportDirectoryOf(deps);
  const version = deps.version ?? SCOUT_APP_VERSION;
  const key = await resolveDistKey(context.env, await distKeyStores(deps, context.env));
  // Installation and selection are separate: forcing Basic does not uninstall
  // Full, and upgrading the CLI does not remove a Full client for an older version.
  const installed = resolveInstalledWebFullClient(version, { env: {}, supportDirectory });
  const installedVersions = installedFullVersions(supportDirectory);
  const basicForced = context.env.OPENSCOUT_WEB_CLIENT_PROFILE?.trim() === "basic";
  const serves = !basicForced && installed ? "full" : "none";
  const reason = basicForced ? "basic-forced"
    : installed ? "full-installed"
    : installedVersions.length ? "version-mismatch" : "not-installed";
  const nextSteps = installed ? []
    : key ? ["scout web install"]
    : ["scout auth login", "scout web install"];
  if (basicForced) {
    nextSteps.push("To use Full, remove OPENSCOUT_WEB_CLIENT_PROFILE=basic from the web server's environment and restart it.");
  }
  const status = {
    version,
    downloadHost: distBaseUrl(context.env),
    key: key?.where ?? null,
    installed,
    installedVersions,
    serves,
    reason,
    nextSteps,
  };
  context.output.writeValue(status, (value) => [
    `Scout ${value.version}`,
    `key        ${value.key ?? "none (scout auth login)"}`,
    `installed  ${value.installed ?? "no"}`,
    ...(value.installedVersions.length ? [`versions   ${value.installedVersions.join(", ")}`] : []),
    `serves     ${value.serves === "full" ? "the full web app" : "no bundled web app (install the Scout apps)"}`,
    ...(value.reason === "version-mismatch"
      ? [`The installed full web app does not match Scout ${value.version}. Install the matching version to use Full again.`]
      : value.reason === "basic-forced" ? ["Basic is selected by OPENSCOUT_WEB_CLIENT_PROFILE=basic."] : []),
    "Selection uses this CLI's version and environment; the running web server may differ.",
    ...value.nextSteps.map((step) => `Next: ${step}`),
  ].join("\n"));
}

export async function runWebCommand(
  context: ScoutCommandContext,
  args: string[],
  deps: ScoutWebCommandDeps = {},
): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h" || rest.includes("--help")) {
    context.output.writeText(renderWebCommandHelp());
    return;
  }
  switch (subcommand) {
    case "login":
      await runAuthLogin(context, rest, deps, { readPipedKey: true });
      return;
    case "logout":
      return runAuthLogout(context, deps);
    case "install":
      return runInstall(context, rest, deps);
    case "uninstall":
      return runUninstall(context, deps);
    case "status":
      return runStatus(context, deps);
    default:
      throw new ScoutCliError(`unknown subcommand: scout web ${subcommand}; see scout web --help`);
  }
}
