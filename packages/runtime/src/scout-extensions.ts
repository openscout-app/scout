import { parseScoutExtensionInvocation, type ScoutExtensionInvocation } from "./scout-extension-invocation.js";
export { SCOUT_EXTENSION_CONTEXT_SCHEMA, SCOUT_EXTENSION_CONTEXT_FEATURES, SCOUT_EXTENSION_INPUT_SCHEMA, normalizeScoutExtensionDestination } from "./scout-extension-invocation.js";
export type { ScoutExtensionInvocation, ScoutExtensionContextFeature, ScoutExtensionCredentialDeclaration, ScoutExtensionDestinationDeclaration } from "./scout-extension-invocation.js";
import { normalizeOpenScoutInstanceName, resolveOpenScoutInstanceName } from "./instance.js";
import { untrustedPathMetadata } from "./path-trust.js";
import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveScoutHome, scoutHomeReadRoots } from "./scout-home.js";

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

export type ScoutExtensionRefusalReason = "refused" | "incompatible" | "corrupt" | "wrong_instance" | "context_invalid" | "selection_changed" | "context_delivery_failed" | "context_backend_unproven" | "input_not_authorized" | "input_protocol_invalid" | "input_delivery_failed" | "input_source_changed" | "input_value_invalid" | "input_policy_invalid" | "input_policy_busy" | "input_provenance_unverified" | "input_backend_unproven";

export type ScoutExtension = {
  name: string;
  /** Missing on historical API-1 objects; never changes their transport. */
  api?: 1 | 2;
  invocation?: ScoutExtensionInvocation;
  command: string;
  summary?: string;
  /** The extensions folder it was found in. */
  root: string;
  version?: string;
  removed?: boolean;
  /** Static completion words, or a trusted executable in `complete` (exclusive). */
  completion?: string[];
  complete?: string;
  /** Resolved, trusted Markdown file. Help never executes the extension. */
  docs?: string;
  /** Set when the extension is installed but must not run, with the reason. */
  refused?: string;
  /** Stable classification; never infer machine behavior from refused prose. */
  refusalReason?: ScoutExtensionRefusalReason;
};

type Env = NodeJS.ProcessEnv;

const NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** Where extensions are installed: `extensions` in the Scout home (~/.openscout). */
export function scoutExtensionsHome(env: Env = process.env): string {
  const configured = env.OPENSCOUT_EXTENSIONS_HOME?.trim();
  return configured ? resolve(configured) : join(resolveScoutHome({ env }), "extensions");
}

/** Where extensions are read from: ~/.openscout first, then the legacy ~/.scout. */
export function scoutExtensionRoots(env: Env = process.env): string[] {
  const configured = env.OPENSCOUT_EXTENSIONS_HOME?.trim();
  return configured ? [resolve(configured)] : scoutHomeReadRoots({ env }).map((root) => join(root, "extensions"));
}

function permissionDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM";
}

function executableProblem(path: string): string | undefined {
  let checkingExecute = false;
  try {
    if (!statSync(path).isFile()) return "is not an executable file (chmod +x)";
    checkingExecute = true;
    accessSync(path, constants.X_OK);
    return undefined;
  } catch (error) {
    return permissionDenied(error)
      ? `cannot be accessed: permission denied (${(error as NodeJS.ErrnoException).code})${checkingExecute ? " (chmod +x)" : ""}`
      : "is not an executable file (chmod +x)";
  }
}

/** The extension API versions this scout runs. A compatible bump adds a version here instead of refusing every installed extension. */
const SUPPORTED_EXTENSION_APIS: ReadonlySet<unknown> = new Set([SCOUT_EXTENSION_API_VERSION, 2]);

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

/** Why `path` cannot be trusted, if it cannot. A sticky folder such as /tmp lets
 * others add entries but not replace ours, so `allowSticky` accepts it.
 * Strict ownership requires process.getuid. On platforms without getuid, the
 * loader refuses every installed extension rather than guessing ownership.
 */
function untrusted(path: string, allowSticky = false): string | undefined {
  let info: ReturnType<typeof statSync>;
  try { info = statSync(path); } catch { return `Scout cannot read the permissions of ${path}`; }
  return untrustedPathMetadata(path, info, allowSticky);
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

/** Bounded regular-file reads also refuse FIFOs and final symlinks. */
function readExtensionFile(path: string, limit: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("not a regular file");
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = readSync(fd, buffer, size, buffer.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size > limit) throw new Error("file exceeds size limit");
    return buffer.subarray(0, size).toString("utf8");
  } finally { closeSync(fd); }
}

export const SCOUT_EXTENSION_DOCS_MAX_BYTES = 64 * 1024;
/** One line per word; never shell source. Delimiters and control characters are forbidden. */
// Use an absolute end assertion: JavaScript `$` also accepts a final newline.
export const SCOUT_COMPLETION_WORD = /^[a-zA-Z0-9_./:@%+=,-]{1,128}(?![\s\S])/;

function artifactAsset(root: string, dir: string, value: unknown, executable: boolean): string {
  if (typeof value !== "string" || value.length > 512 || isAbsolute(value)
    || value.split(/[\\/]/).some(part => !part || part === "." || part === "..")) throw new Error("invalid artifact-relative path");
  const path = realpathSync(resolve(dir, value));
  if (!isInside(dir, path)) throw new Error("asset outside artifact");
  const problem = untrustedChain(root, dir, path) ?? (executable ? executableProblem(path) : undefined);
  if (problem) throw new Error(problem);
  return path;
}

/** Re-resolve at read time; callers cannot use an old object to bypass current trust checks. */
export function readScoutExtensionDocs(extension: ScoutExtension, env: Env = process.env): string | undefined {
  const current = findScoutExtension(extension.name, env);
  if (!current || current.refused) throw new Error("extension documentation is unavailable or refused");
  return current.docs ? readExtensionFile(current.docs, SCOUT_EXTENSION_DOCS_MAX_BYTES) : undefined;
}

function readInstalled(root: string, name: string, env: Env): ScoutExtension | undefined {
  const dir = join(root, name);
  const manifestPath = join(dir, "extension.json");
  // From here the folder is an installed extension. When it cannot run, say why instead of
  // skipping it, so it does not look uninstalled and an older copy in ~/.openscout cannot run in its place.
  const refuse = (command: string, reason: string, summary?: string, refusalReason: ScoutExtensionRefusalReason = "refused"): ScoutExtension =>
    ({ name, command, summary, root, refused: `the ${name} extension ${reason}`, refusalReason });
  // A missing manifest or dangling generation is damaged, not an absent install.
  // Preserve its precedence over a legacy-home artifact.
  try { lstatSync(dir); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    return refuse(dir, "cannot read its installation directory.");
  }
  try { statSync(manifestPath); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return refuse(manifestPath, "has a missing manifest or damaged generation; install it again.", undefined, "corrupt");
    return refuse(manifestPath, permissionDenied(error)
      ? `cannot read its extension.json: permission denied (${code}).`
      : `cannot read its extension.json (${manifestPath}).`);
  }
  let manifest: { summary?: unknown; command?: unknown; api?: unknown; version?: unknown; disabled?: unknown; completion?: unknown; complete?: unknown; docs?: unknown; instance?: unknown; invocation?: unknown };
  try {
    manifest = JSON.parse(readExtensionFile(realpathSync(manifestPath), 16 * 1024));
  } catch (error) {
    return refuse(manifestPath, permissionDenied(error)
      ? `cannot read its extension.json: permission denied (${(error as NodeJS.ErrnoException).code}).`
      : `has an extension.json Scout cannot read as JSON (${manifestPath}).`, undefined, permissionDenied(error) ? "refused" : "corrupt");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return refuse(manifestPath, `has an extension.json that is not a JSON object (${manifestPath}).`, undefined, "corrupt");
  const summary = typeof manifest.summary === "string" ? manifest.summary : undefined;
  if (manifest.disabled === true) return { ...refuse(manifestPath, "was removed; install it again to enable it.", summary), removed: true };
  if (typeof manifest.command !== "string" || !manifest.command) return refuse(manifestPath, `has no "command" in its extension.json.`, summary, "corrupt");
  const command = resolve(dir, manifest.command);
  let realRoot: string, realDir: string, realCommand: string;
  try {
    [realRoot, realDir, realCommand] = [realpathSync(root), realpathSync(dir), realpathSync(command)];
  } catch (error) {
    return refuse(command, permissionDenied(error)
      ? `cannot resolve ${command}: permission denied (${(error as NodeJS.ErrnoException).code}).`
      : `runs ${command}, which does not exist.`, summary, permissionDenied(error) ? "refused" : "corrupt");
  }
  if (!isInside(realDir, realCommand)) {
    return refuse(command, `runs ${command}, which is outside the extension's folder. Scout runs only files inside it.`, summary);
  }
  const executable = executableProblem(realCommand);
  if (executable) return refuse(command, `runs ${command}, which ${executable}.`, summary);
  if (!SUPPORTED_EXTENSION_APIS.has(manifest.api)) {
    return refuse(command, `is built for extension API ${String(manifest.api ?? "(none)")}; this scout supports API ${[...SUPPORTED_EXTENSION_APIS].join(", ")}. Update scout or the extension.`, summary, "incompatible");
  }
  let invocation: ScoutExtensionInvocation | undefined;
  if (manifest.api === 2) {
    try { invocation = parseScoutExtensionInvocation(manifest.invocation, manifest.complete); }
    catch { return refuse(command, "has unsupported API-2 invocation metadata.", summary, "incompatible"); }
  }
  const problem = untrustedChain(realRoot, realDir, realCommand);
  if (problem) return refuse(command, `cannot be trusted: ${problem}. Fix its ownership and remove write permission for others before Scout will run it.`, summary);
  let docs: string | undefined, complete: string | undefined, completion: string[] | undefined;
  try {
    // The manifest and optional assets share the executable's ownership/containment checks.
    const realManifest = realpathSync(manifestPath);
    if (!isInside(realDir, realManifest) || untrustedChain(realRoot, realDir, realManifest)) throw new Error("untrusted manifest");
    if (manifest.completion !== undefined) {
      if (!Array.isArray(manifest.completion) || manifest.completion.length > 256
        || !manifest.completion.every(word => typeof word === "string" && SCOUT_COMPLETION_WORD.test(word))
        || manifest.complete !== undefined) throw new Error("invalid completion words or conflicting complete entry");
      completion = [...new Set(manifest.completion as string[])];
    }
    if (manifest.complete !== undefined) complete = artifactAsset(realRoot, realDir, manifest.complete, true);
    if (manifest.docs !== undefined) {
      if (typeof manifest.docs !== "string" || !/\.md$/i.test(manifest.docs)) throw new Error("docs must name a Markdown file");
      docs = artifactAsset(realRoot, realDir, manifest.docs, false);
      readExtensionFile(docs, SCOUT_EXTENSION_DOCS_MAX_BYTES);
    }
  } catch {
    return refuse(command, "has invalid or untrusted completion/documentation metadata.", summary);
  }
  // Optional instance binding is a local selection guard, not authorization.
  // Unbound API-1 artifacts remain portable; never scan another instance home.
  if (manifest.instance !== undefined) {
    let instance: string;
    try {
      if (typeof manifest.instance !== "string" || !manifest.instance) throw new Error("invalid instance");
      instance = normalizeOpenScoutInstanceName(manifest.instance);
      if (instance !== manifest.instance) throw new Error("noncanonical instance");
    } catch { return refuse(command, "has an invalid instance binding.", summary, "corrupt"); }
    if (instance !== resolveOpenScoutInstanceName(env)) return refuse(command,
      `is installed for instance ${instance}, not the selected instance ${resolveOpenScoutInstanceName(env)}. Install the matching artifact.`, summary, "wrong_instance");
  }
  return { name, command, summary, root, docs, complete, completion, ...(invocation ? { api: 2 as const, invocation } : {}), ...(typeof manifest.version === "string" ? { version: manifest.version } : {}) };
}

/** The installed extension for one verb, if any. ~/.scout wins over ~/.openscout. */
export function findScoutExtension(name: string, env: Env = process.env): ScoutExtension | undefined {
  if (!NAME.test(name)) return undefined;
  for (const root of scoutExtensionRoots(env)) {
    const extension = readInstalled(root, name, env);
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
      const extension = readInstalled(root, entry, env);
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
    SCOUT_EXTENSION_API: String(input.extension.api ?? SCOUT_EXTENSION_API_VERSION),
    SCOUT_EXTENSION_NAME: input.extension.name,
    SCOUT_CLI_VERSION: input.cliVersion,
    SCOUT_OUTPUT: input.outputMode,
    OPENSCOUT_BROKER_URL: input.brokerUrl,
  };
}

/** Validate an installation root before writing into it. */
export function scoutExtensionDirectoryProblem(path: string): string | undefined {
  const real = realpathSync(path);
  return untrusted(real) ?? ancestors(real).map(parent => untrusted(parent, true)).find(Boolean);
}

/** Bundled extensions are one executable plus a manifest. Paths are not identity. */
export function scoutExtensionDigest(extension: ScoutExtension): string {
  const manifest = join(extension.root, extension.name, "extension.json");
  if (statSync(manifest).size > 16 * 1024 || statSync(extension.command).size > 32 * 1024 * 1024) throw new Error("extension exceeds digest size bound");
  return createHash("sha256").update(readFileSync(manifest)).update("\0").update(readFileSync(extension.command)).digest("hex");
}
