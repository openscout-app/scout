import { accessSync, constants, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveScoutHome, scoutHomeReadRoots } from "@openscout/runtime/scout-home";

/**
 * Scout CLI extensions. `scout <verb>` runs an installed extension when no
 * built-in command owns the verb. Installed commands use the same public
 * runtime API as other clients.
 *
 * An extension is a directory in the Scout home's `extensions` folder holding
 * `extension.json` ({ "api": 1, "summary": "...", "command": "bin/run" }). PATH is
 * not searched: an unknown verb is an implicit ask, so a stray `scout-<verb>`
 * script must not take it over. Installing an extension is deliberate.
 *
 * It receives the remaining argv and the environment from scoutExtensionEnv,
 * and talks to the runtime through its public API at OPENSCOUT_BROKER_URL,
 * like any other app.
 */

/** The contract version in extension.json's "api" field. Bump it on any breaking change to scoutExtensionEnv. */
export const SCOUT_EXTENSION_API_VERSION = 1;

export type ScoutExtension = {
  name: string;
  command: string;
  summary?: string;
  /** The extensions folder it was found in. */
  root: string;
  /** Set when the extension is installed but must not run, with the reason. */
  refused?: string;
};

type Env = NodeJS.ProcessEnv;

const NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** Where extensions are installed: `extensions` in the Scout home (~/.scout). */
export function scoutExtensionsHome(env: Env = process.env): string {
  const configured = env.OPENSCOUT_EXTENSIONS_HOME?.trim();
  return configured ? resolve(configured) : join(resolveScoutHome({ env }), "extensions");
}

/** Where extensions are read from: ~/.scout first, then the legacy ~/.openscout. */
export function scoutExtensionRoots(env: Env = process.env): string[] {
  const configured = env.OPENSCOUT_EXTENSIONS_HOME?.trim();
  return configured ? [resolve(configured)] : scoutHomeReadRoots({ env }).map((root) => join(root, "extensions"));
}

function permissionDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM";
}

function executableProblem(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) return "is not an executable file (chmod +x)";
    accessSync(path, constants.X_OK);
    return undefined;
  } catch (error) {
    return permissionDenied(error)
      ? `cannot be accessed: permission denied (${(error as NodeJS.ErrnoException).code})`
      : "is not an executable file (chmod +x)";
  }
}

/** The extension API versions this scout runs. A compatible bump adds a version here instead of refusing every installed extension. */
const SUPPORTED_EXTENSION_APIS: ReadonlySet<unknown> = new Set([SCOUT_EXTENSION_API_VERSION]);

/** Whether `path` is the folder `dir` or inside it. Both are real paths. */
function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function ancestors(path: string): string[] {
  const found: string[] = [];
  for (let current = dirname(path); ; current = dirname(current)) {
    found.push(current);
    if (current === dirname(current)) return found;
  }
}

/** Why `path` cannot be trusted, if it cannot. A sticky folder such as /tmp lets others add entries but not replace ours, so `allowSticky` accepts it. */
function untrusted(path: string, allowSticky = false): string | undefined {
  let info: ReturnType<typeof statSync>;
  try { info = statSync(path); } catch { return `Scout cannot read the permissions of ${path}`; }
  if (!allowSticky) {
    const uid = process.getuid?.();
    if (uid === undefined || (info.uid !== uid && info.uid !== 0)) {
      return `${path} is not owned by the current user or root`;
    }
  }
  const mode = info.mode;
  if ((mode & 0o002) === 0 || (allowSticky && (mode & 0o1000) !== 0)) return undefined;
  return `anyone on this machine can write to ${path}`;
}

/**
 * Anyone else who can write along the way could swap what runs: the command,
 * each folder from it up to the extension's folder, and the extensions folder
 * must not be writable by others. Folders above those may be sticky.
 */
function untrustedChain(root: string, dir: string, command: string): string | undefined {
  const strict = [command, root];
  for (let current = dirname(command); isInside(dir, current); current = dirname(current)) strict.push(current);
  const loose = new Set([...ancestors(dir), ...ancestors(root)].filter((path) => !strict.includes(path)));
  for (const path of strict) {
    const problem = untrusted(path);
    if (problem) return problem;
  }
  for (const path of loose) {
    const problem = untrusted(path, true);
    if (problem) return problem;
  }
  return undefined;
}

function readInstalled(root: string, name: string): ScoutExtension | undefined {
  const dir = join(root, name);
  const manifestPath = join(dir, "extension.json");
  // From here the folder is an installed extension. When it cannot run, say why instead of
  // skipping it, so it does not look uninstalled and an older copy in ~/.openscout cannot run in its place.
  const refuse = (command: string, reason: string, summary?: string): ScoutExtension =>
    ({ name, command, summary, root, refused: `the ${name} extension ${reason}` });
  try { statSync(manifestPath); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    return refuse(manifestPath, permissionDenied(error)
      ? `cannot read its extension.json: permission denied (${code}).`
      : `cannot read its extension.json (${manifestPath}).`);
  }
  let manifest: { summary?: unknown; command?: unknown; api?: unknown };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return refuse(manifestPath, permissionDenied(error)
      ? `cannot read its extension.json: permission denied (${(error as NodeJS.ErrnoException).code}).`
      : `has an extension.json Scout cannot read as JSON (${manifestPath}).`);
  }
  if (!manifest || typeof manifest !== "object") return refuse(manifestPath, `has an extension.json that is not a JSON object (${manifestPath}).`);
  const summary = typeof manifest.summary === "string" ? manifest.summary : undefined;
  if (typeof manifest.command !== "string" || !manifest.command) return refuse(manifestPath, `has no "command" in its extension.json.`, summary);
  const command = resolve(dir, manifest.command);
  let realRoot: string, realDir: string, realCommand: string;
  try {
    [realRoot, realDir, realCommand] = [realpathSync(root), realpathSync(dir), realpathSync(command)];
  } catch (error) {
    return refuse(command, permissionDenied(error)
      ? `cannot resolve ${command}: permission denied (${(error as NodeJS.ErrnoException).code}).`
      : `runs ${command}, which does not exist.`, summary);
  }
  if (!isInside(realDir, realCommand)) {
    return refuse(command, `runs ${command}, which is outside the extension's folder. Scout runs only files inside it.`, summary);
  }
  const executable = executableProblem(realCommand);
  if (executable) return refuse(command, `runs ${command}, which ${executable}.`, summary);
  if (!SUPPORTED_EXTENSION_APIS.has(manifest.api)) {
    return refuse(command, `is built for extension API ${String(manifest.api ?? "(none)")}; this scout supports API ${[...SUPPORTED_EXTENSION_APIS].join(", ")}. Update scout or the extension.`, summary);
  }
  const problem = untrustedChain(realRoot, realDir, realCommand);
  if (problem) return refuse(command, `cannot be trusted: ${problem}. Fix its permissions (chmod o-w) before Scout will run it.`, summary);
  return { name, command, summary, root };
}

/** The installed extension for one verb, if any. ~/.scout wins over ~/.openscout. */
export function findScoutExtension(name: string, env: Env = process.env): ScoutExtension | undefined {
  if (!NAME.test(name)) return undefined;
  for (const root of scoutExtensionRoots(env)) {
    const extension = readInstalled(root, name);
    if (extension) return extension;
  }
  return undefined;
}

/** Every installed extension, for help and `scout extensions`. */
export function listScoutExtensions(env: Env = process.env): ScoutExtension[] {
  const found = new Map<string, ScoutExtension>();
  for (const root of scoutExtensionRoots(env)) {
    let entries: string[];
    try { entries = readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      if (found.has(entry) || !NAME.test(entry)) continue;
      const extension = readInstalled(root, entry);
      if (extension) found.set(entry, extension);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What an extension may rely on. The OPENSCOUT_ and SCOUT_ namespace belongs to
 * Scout and can carry the runtime's secrets when a supervisor runs scout, so
 * only the contract's variables and the Scout home overrides pass through it.
 * The rest of the environment is passed as is.
 */
export function scoutExtensionEnv(input: {
  env: Env;
  extension: ScoutExtension;
  cliVersion: string;
  outputMode: "plain" | "json";
  brokerUrl: string;
  /** The directory of the runtime running scout; put first on PATH so `#!/usr/bin/env bun` resolves under launchd. */
  runtimeDir?: string;
}): Env {
  const runtimeDir = input.runtimeDir ?? dirname(process.execPath);
  const passed = Object.entries(input.env).filter(([key]) =>
    !/^(OPENSCOUT|SCOUT)_/.test(key) || key === "SCOUT_HOME" || key === "OPENSCOUT_HOME");
  return {
    ...Object.fromEntries(passed),
    PATH: [runtimeDir, input.env.PATH].filter(Boolean).join(delimiter),
    SCOUT_EXTENSION_API: String(SCOUT_EXTENSION_API_VERSION),
    SCOUT_EXTENSION_NAME: input.extension.name,
    SCOUT_CLI_VERSION: input.cliVersion,
    SCOUT_OUTPUT: input.outputMode,
    OPENSCOUT_BROKER_URL: input.brokerUrl,
  };
}

/**
 * Run an extension in the foreground and return its exit status. SIGTERM and
 * SIGHUP are forwarded, so a supervisor such as launchd that signals scout's PID
 * stops the extension too instead of orphaning it. Ctrl-C already reaches the
 * extension through the terminal's process group, so scout only waits for it.
 */
export async function runScoutExtension(extension: ScoutExtension, args: readonly string[], env: Env): Promise<number> {
  const child = spawn(extension.command, args, { env, stdio: "inherit" });
  const forward = (signal: NodeJS.Signals) => { child.kill(signal); };
  const wait = () => {};
  process.on("SIGTERM", forward);
  process.on("SIGHUP", forward);
  process.on("SIGINT", wait);
  try {
    return await new Promise<number>((resolveStatus, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        resolveStatus(signal ? 128 + (osConstants.signals[signal] ?? 1) : code ?? 1));
    });
  } finally {
    process.off("SIGTERM", forward);
    process.off("SIGHUP", forward);
    process.off("SIGINT", wait);
  }
}
