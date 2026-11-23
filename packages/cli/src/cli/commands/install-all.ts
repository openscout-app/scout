/**
 * `scout install --all`: bring every installed part of Scout on this host to
 * one published release.
 *
 * The parts are the `@openscout/scout` package (the `scout` command, the
 * runtime and scoutd), the runtime service that runs from that package,
 * Scout.app, and the full web app when one is installed. They are installed in
 * that order: the package first, because it carries the runtime and the
 * installers the later steps run; the runtime next, so the app it relaunches
 * reaches the new runtime; then the app and the web app.
 *
 * Every step after the package runs from the newly installed package, never
 * from the CLI that started the install. An old CLI must not configure a newer
 * runtime.
 *
 * Without `--force` the command never changes who owns a part. A `scout`
 * command linked to a checkout, or a runtime service that runs from one, is
 * held and reported. `--force` makes that one-time move onto the release,
 * keeps a copy of the service file, and reinstalls parts already current.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

export const SCOUT_PACKAGE_NAME = "@openscout/scout";
export const SHARED_SERVICE_LABEL = "app.openscout";

/** Service settings that name the owner. Every other setting is kept as the service had it. */
const OWNER_ENV_KEYS = new Set([
  "OPENSCOUT_RUNTIME_PACKAGE_DIR",
  "OPENSCOUT_SCOUTD_BIN",
  "PATH",
  "HOME",
]);

export type InstallAllPart = "cli" | "runtime" | "app" | "web";

export type InstallAllStatus =
  | "up-to-date"
  | "installed"
  | "updated"
  | "moved"
  | "held"
  | "skipped"
  | "would-change"
  | "failed";

export type InstallAllPartResult = {
  part: InstallAllPart;
  status: InstallAllStatus;
  before: string | null;
  after: string | null;
  message: string;
};

export type InstallAllResult = {
  action: "install-all";
  target: string;
  force: boolean;
  check: boolean;
  parts: InstallAllPartResult[];
  backup: string | null;
};

export type InstallAllOptions = {
  version: string | null;
  force: boolean;
  check: boolean;
  restart: boolean;
};

export type InstallAllRunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type InstallAllRunner = (
  command: string,
  args: readonly string[],
  options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
) => InstallAllRunResult;

export type InstallAllDependencies = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  run?: InstallAllRunner;
  /** Resolves the release to install, as `scout install` does. Returns a bare x.y.z. */
  resolveTarget: (version: string | null) => Promise<string>;
  readFile?: (path: string) => string | null;
  exists?: (path: string) => boolean;
  /** The resolved path, or null when nothing is there. */
  realPath?: (path: string) => string | null;
  /** Whether a path is a link, whatever it points at. */
  isLink?: (path: string) => boolean;
  /** Replace whatever is at `link` with a symlink to `target`. */
  link?: (link: string, target: string) => void;
  copyFile?: (from: string, to: string) => void;
  mkdir?: (path: string) => void;
  now?: () => Date;
};

type Resolved = Required<Omit<InstallAllDependencies, "resolveTarget">> & Pick<InstallAllDependencies, "resolveTarget">;

function defaultRun(
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {},
): InstallAllRunResult {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    env: options.env,
    cwd: options.cwd,
    timeout: options.timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

function resolveDependencies(dependencies: InstallAllDependencies): Resolved {
  return {
    env: dependencies.env ?? process.env,
    home: dependencies.home ?? homedir(),
    run: dependencies.run ?? defaultRun,
    resolveTarget: dependencies.resolveTarget,
    readFile: dependencies.readFile ?? ((path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    }),
    exists: dependencies.exists ?? existsSync,
    realPath: dependencies.realPath ?? ((path) => {
      try {
        return realpathSync(path);
      } catch {
        return null;
      }
    }),
    isLink: dependencies.isLink ?? ((path) => {
      try {
        return lstatSync(path).isSymbolicLink();
      } catch {
        return false;
      }
    }),
    link: dependencies.link ?? ((link, target) => {
      rmSync(link, { force: true });
      symlinkSync(target, link);
    }),
    copyFile: dependencies.copyFile ?? copyFileSync,
    mkdir: dependencies.mkdir ?? ((path) => {
      mkdirSync(path, { recursive: true });
    }),
    now: dependencies.now ?? (() => new Date()),
  };
}

/** Where `bun add -g` puts the package and its command links. */
export function bunGlobalLayout(env: NodeJS.ProcessEnv, home: string): {
  bunInstall: string;
  binDirectory: string;
  packageDirectory: string;
  bun: string;
} {
  const bunInstall = env.BUN_INSTALL?.trim() || join(home, ".bun");
  const binDirectory = join(bunInstall, "bin");
  return {
    bunInstall,
    binDirectory,
    packageDirectory: join(bunInstall, "install", "global", "node_modules", ...SCOUT_PACKAGE_NAME.split("/")),
    bun: env.OPENSCOUT_BUN_BIN?.trim() || join(binDirectory, "bun"),
  };
}

function readJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The last JSON object a command printed. Installers print progress before their result. */
export function lastJsonObject(stdout: string): Record<string, unknown> | null {
  const whole = readJson(stdout.trim());
  if (whole) return whole;
  const lines = stdout.trim().split("\n");
  for (let start = lines.length - 1; start >= 0; start -= 1) {
    if (!lines[start]!.trimStart().startsWith("{")) continue;
    const value = readJson(lines.slice(start).join("\n"));
    if (value) return value;
  }
  return null;
}

function packageVersion(deps: Resolved, packageDirectory: string): string | null {
  const version = readJson(deps.readFile(join(packageDirectory, "package.json")))?.version;
  return typeof version === "string" ? version : null;
}

function packageBins(deps: Resolved, packageDirectory: string): Record<string, string> {
  const bin = readJson(deps.readFile(join(packageDirectory, "package.json")))?.bin;
  if (!bin || typeof bin !== "object") return {};
  return Object.fromEntries(
    Object.entries(bin as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

/** True when `path` is the package directory or sits inside it, after resolving links. */
export function isInsideDirectory(path: string, directory: string, realPath: (path: string) => string | null): boolean {
  const real = realPath(path) ?? resolve(path);
  const root = realPath(directory) ?? resolve(directory);
  return real === root || real.startsWith(`${root}${sep}`);
}

function tail(text: string, lines = 3): string {
  return text.trim().split("\n").slice(-lines).join(" ").trim();
}

function failureText(result: InstallAllRunResult): string {
  if (result.error) return result.error.message;
  return tail(result.stderr) || tail(result.stdout) || `exit ${result.status ?? "unknown"}`;
}

type CommandLink = { name: string; link: string; expected: string; current: string | null };

/** Package commands whose link on PATH does not run this package. */
function foreignCommandLinks(deps: Resolved, layout: ReturnType<typeof bunGlobalLayout>): CommandLink[] {
  const links: CommandLink[] = [];
  for (const [name, path] of Object.entries(packageBins(deps, layout.packageDirectory))) {
    const link = join(layout.binDirectory, name);
    const expected = join(layout.packageDirectory, path);
    const present = deps.exists(link) || deps.isLink(link);
    if (present && isInsideDirectory(link, layout.packageDirectory, deps.realPath)) continue;
    links.push({ name, link, expected, current: present ? deps.realPath(link) ?? link : null });
  }
  return links;
}

function installPackage(
  deps: Resolved,
  layout: ReturnType<typeof bunGlobalLayout>,
  target: string,
  options: InstallAllOptions,
  context: ScoutCommandContext,
): InstallAllPartResult {
  const before = packageVersion(deps, layout.packageDirectory);
  const needsInstall = options.force || before !== target;
  const foreignBefore = foreignCommandLinks(deps, layout);

  if (options.check) {
    const held = foreignBefore.filter((entry) => entry.current);
    const notes = held.map((entry) => `\`${entry.name}\` runs ${entry.current}`);
    return {
      part: "cli",
      status: needsInstall || held.length > 0 ? "would-change" : "up-to-date",
      before,
      after: before,
      message: [
        needsInstall ? `${SCOUT_PACKAGE_NAME} ${before ?? "is not installed"} → ${target}` : `${SCOUT_PACKAGE_NAME} ${target} is installed`,
        ...notes,
      ].join("; "),
    };
  }

  let bunFailure: string | null = null;
  if (needsInstall) {
    context.stderr(`Installing ${SCOUT_PACKAGE_NAME} ${target}…`);
    const bun = deps.exists(layout.bun) ? layout.bun : "bun";
    const result = deps.run(bun, ["add", "-g", `${SCOUT_PACKAGE_NAME}@${target}`], { env: deps.env, timeoutMs: 600_000 });
    if ((result.status ?? 1) !== 0) bunFailure = failureText(result);
  }

  const after = packageVersion(deps, layout.packageDirectory);
  if (after !== target) {
    return {
      part: "cli",
      status: "failed",
      before,
      after,
      message: `bun did not install ${SCOUT_PACKAGE_NAME} ${target}${bunFailure ? `: ${bunFailure}` : ""}`,
    };
  }

  // Bun refuses to replace a command link it does not own, such as one a
  // checkout's `bun link` made. The package lands anyway; only the link is left.
  const notes: string[] = [];
  let held = false;
  for (const entry of foreignCommandLinks(deps, layout)) {
    if (entry.current && !options.force) {
      held = true;
      notes.push(`\`${entry.name}\` still runs ${entry.current}; --force points it at the package`);
      continue;
    }
    deps.link(entry.link, relative(dirname(entry.link), entry.expected));
    notes.push(entry.current ? `\`${entry.name}\` ran ${entry.current}; it now runs the package` : `linked \`${entry.name}\``);
  }

  const status: InstallAllStatus = held ? "held"
    : !needsInstall ? "up-to-date"
    : before ? "updated"
    : "installed";
  const head = status === "up-to-date" ? `${SCOUT_PACKAGE_NAME} ${target} is installed`
    : before && before !== target ? `${SCOUT_PACKAGE_NAME} ${before} → ${target}`
    : `${SCOUT_PACKAGE_NAME} ${target} installed`;
  return { part: "cli", status, before, after, message: [head, ...notes].join("; ") };
}

type ServiceFile = {
  path: string;
  workingDirectory: string | null;
  daemon: string | null;
  environment: Record<string, string>;
};

function readServiceFile(deps: Resolved, path: string): ServiceFile | null {
  if (!deps.exists(path)) return null;
  const converted = deps.run("/usr/bin/plutil", ["-convert", "json", "-o", "-", path]);
  if ((converted.status ?? 1) !== 0) return null;
  const plist = readJson(converted.stdout);
  if (!plist) return null;
  const environment = plist.EnvironmentVariables && typeof plist.EnvironmentVariables === "object"
    ? Object.fromEntries(
      Object.entries(plist.EnvironmentVariables as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    )
    : {};
  const args = Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments : [];
  return {
    path,
    workingDirectory: typeof plist.WorkingDirectory === "string" ? plist.WorkingDirectory : null,
    daemon: typeof args[0] === "string" ? args[0] : null,
    environment,
  };
}

/** What the service runs from: the explicit runtime directory, else its working directory. */
function serviceOwner(service: ServiceFile): string | null {
  return service.environment.OPENSCOUT_RUNTIME_PACKAGE_DIR ?? service.workingDirectory ?? service.daemon;
}

function serviceRunsPackage(deps: Resolved, service: ServiceFile, packageDirectory: string): boolean {
  const owner = serviceOwner(service);
  const daemon = service.daemon;
  return Boolean(owner && isInsideDirectory(owner, packageDirectory, deps.realPath))
    && Boolean(daemon && isInsideDirectory(daemon, packageDirectory, deps.realPath));
}

/** The environment that starts the service from the package and keeps every other setting it had. */
export function serviceEnvironment(input: {
  env: NodeJS.ProcessEnv;
  service: Record<string, string>;
  packageDirectory: string;
  repoint: boolean;
}): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(Object.entries(input.service).filter(([key]) => !OWNER_ENV_KEYS.has(key)));
  const env: NodeJS.ProcessEnv = {
    ...input.env,
    ...kept,
    OPENSCOUT_RUNTIME_PACKAGE_DIR: input.packageDirectory,
    OPENSCOUT_SCOUTD_BIN: join(input.packageDirectory, "bin", "scoutd"),
  };
  if (input.repoint) {
    env.OPENSCOUT_ALLOW_SHARED_SERVICE_REPOINT = "1";
  } else {
    delete env.OPENSCOUT_ALLOW_SHARED_SERVICE_REPOINT;
  }
  return env;
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
}

function installRuntime(
  deps: Resolved,
  layout: ReturnType<typeof bunGlobalLayout>,
  target: string,
  packageChanged: boolean,
  options: InstallAllOptions,
  context: ScoutCommandContext,
): { result: InstallAllPartResult; backup: string | null } {
  const servicePath = join(deps.home, "Library", "LaunchAgents", `${SHARED_SERVICE_LABEL}.plist`);
  const service = readServiceFile(deps, servicePath);
  const part = (status: InstallAllStatus, message: string, before: string | null = null, after: string | null = null) => ({
    result: { part: "runtime" as const, status, before, after, message },
    backup: null as string | null,
  });

  if (!service) {
    return part("skipped", `no runtime service at ${servicePath}; \`scout setup\` creates it`);
  }
  const owner = serviceOwner(service);
  const runsPackage = serviceRunsPackage(deps, service, layout.packageDirectory);

  if (!runsPackage && !options.force) {
    return part(
      options.check ? "would-change" : "held",
      `the runtime service runs from ${owner ?? "an unknown location"}; --force moves it onto the ${target} package`,
      owner,
      owner,
    );
  }
  if (runsPackage && !packageChanged && !options.force) {
    return part("up-to-date", `the runtime service runs the ${target} package`, owner, owner);
  }
  if (options.check) {
    return part(
      "would-change",
      runsPackage ? `the runtime service restarts on the ${target} package` : `the runtime service moves from ${owner} onto the ${target} package`,
      owner,
      owner,
    );
  }

  const backupDirectory = join(deps.home, ".openscout", "backup");
  deps.mkdir(backupDirectory);
  const backup = join(backupDirectory, `${SHARED_SERVICE_LABEL}.plist.${stamp(deps.now())}`);
  deps.copyFile(servicePath, backup);

  context.stderr(runsPackage ? "Restarting the runtime service…" : `Moving the runtime service from ${owner} onto the package…`);
  const env = serviceEnvironment({
    env: deps.env,
    service: service.environment,
    packageDirectory: layout.packageDirectory,
    repoint: !runsPackage,
  });
  const runtime = join(layout.packageDirectory, "bin", "openscout-runtime.mjs");
  const bun = deps.exists(layout.bun) ? layout.bun : "bun";
  const started = deps.run(bun, [runtime, "service", "start", "--json"], {
    env,
    cwd: layout.packageDirectory,
    timeoutMs: 300_000,
  });
  const status = lastJsonObject(started.stdout);
  const health = status?.health as { ok?: unknown } | undefined;
  const healthy = status?.reachable === true && health?.ok === true;
  const now = readServiceFile(deps, servicePath);
  const nowOwner = now ? serviceOwner(now) : null;
  const moved = Boolean(now && serviceRunsPackage(deps, now, layout.packageDirectory));

  if ((started.status ?? 1) !== 0 || !healthy || !moved) {
    const why = (started.status ?? 1) !== 0 ? failureText(started)
      : !moved ? `the service file still names ${nowOwner ?? "another owner"}`
      : "the runtime did not report healthy";
    return {
      result: {
        part: "runtime",
        status: "failed",
        before: owner,
        after: nowOwner,
        message: `${why}. The service file before this run is at ${backup}`,
      },
      backup,
    };
  }
  return {
    result: {
      part: "runtime",
      status: runsPackage ? "updated" : "moved",
      before: owner,
      after: nowOwner,
      message: runsPackage
        ? `the runtime service restarted on the ${target} package and is healthy`
        : `the runtime service moved from ${owner} onto the ${target} package and is healthy`,
    },
    backup,
  };
}

const INSTALLED_APP_PATH = "/Applications/Scout.app";

/**
 * Scout bundles running from somewhere other than /Applications, such as a
 * checkout's `apps/macos/dist/Scout.app`. That copy is the host's app by the
 * operator's choice, so installing beside it is an ownership move.
 */
export function runningAppsElsewhere(deps: Pick<Resolved, "run">): string[] {
  const ps = deps.run("/bin/ps", ["-axo", "args="]);
  if ((ps.status ?? 1) !== 0) return [];
  const bundles = new Set<string>();
  // Match the executable only: the first word of the line must be the app's or
  // its menu helper's binary. An argument that merely names one does not count.
  // A bundle path with a space is not recognised and is not held.
  const executable = /^(\/[^ ]*\/Scout\.app)\/Contents\/(?:MacOS\/Scout|Library\/LoginItems\/ScoutMenu\.app\/Contents\/MacOS\/ScoutMenu)(?: |$)/;
  for (const line of ps.stdout.split("\n")) {
    const match = line.trimStart().match(executable);
    if (match && match[1] !== INSTALLED_APP_PATH) bundles.add(match[1]!);
  }
  return [...bundles].sort();
}

function installApp(
  deps: Resolved,
  layout: ReturnType<typeof bunGlobalLayout>,
  target: string,
  options: InstallAllOptions,
  context: ScoutCommandContext,
): InstallAllPartResult {
  const scout = join(layout.packageDirectory, "bin", "scout");
  // Release tags carry the v; the installer looks a release up by its tag.
  const tag = `v${target}`;
  const check = lastJsonObject(deps.run(scout, ["install", "--check", "--version", tag, "--json"], { env: deps.env }).stdout);
  const before = typeof check?.installed === "string" ? check.installed : null;
  const elsewhere = runningAppsElsewhere(deps);
  if (elsewhere.length > 0 && !options.force) {
    return {
      part: "app",
      status: options.check ? "would-change" : "held",
      before,
      after: before,
      message: `Scout runs from ${elsewhere.join(", ")}; --force installs ${INSTALLED_APP_PATH} ${target}, and the installer stops menu helpers from other copies`,
    };
  }
  if (options.check) {
    return {
      part: "app",
      status: before === target && !options.force ? "up-to-date" : "would-change",
      before,
      after: before,
      message: typeof check?.message === "string" ? check.message : "the app's version could not be read",
    };
  }
  context.stderr(`Installing Scout.app ${target}…`);
  const args = ["install", "--version", tag, "--json"];
  if (options.force) args.push("--force");
  if (!options.restart) args.push("--no-restart");
  const result = deps.run(scout, args, { env: deps.env, timeoutMs: 900_000 });
  const value = lastJsonObject(result.stdout);
  const after = typeof value?.installed === "string" ? value.installed : null;
  const status = typeof value?.status === "string" ? value.status : null;
  if ((result.status ?? 1) !== 0 || after !== target) {
    return { part: "app", status: "failed", before: null, after, message: failureText(result) };
  }
  return {
    part: "app",
    status: status === "up-to-date" ? "up-to-date" : status === "installed" ? "installed" : "updated",
    before,
    after,
    message: typeof value?.message === "string" ? value.message : `Scout.app ${after}`,
  };
}

function installWeb(
  deps: Resolved,
  layout: ReturnType<typeof bunGlobalLayout>,
  target: string,
  options: InstallAllOptions,
  context: ScoutCommandContext,
): InstallAllPartResult {
  const scout = join(layout.packageDirectory, "bin", "scout");
  const status = lastJsonObject(deps.run(scout, ["web", "status", "--json"], { env: deps.env }).stdout);
  const versions = Array.isArray(status?.installedVersions)
    ? status.installedVersions.filter((value): value is string => typeof value === "string")
    : [];
  const before = versions.at(-1) ?? null;
  if (versions.length === 0) {
    return { part: "web", status: "skipped", before, after: before, message: "the full web app is not installed; `scout web install` adds it" };
  }
  const current = versions.includes(target) || (status?.installed === true && status?.version === target);
  if (current && !options.force) {
    return { part: "web", status: "up-to-date", before, after: target, message: `the full web app ${target} is installed` };
  }
  if (!status?.key) {
    return { part: "web", status: "held", before, after: before, message: "no saved sign-in key; run `scout auth login`, then `scout web install`" };
  }
  if (options.check) {
    return { part: "web", status: "would-change", before, after: before, message: `the full web app ${before} → ${target}` };
  }
  context.stderr(`Installing the full web app ${target}…`);
  const args = ["web", "install", "--version", target, "--no-browser"];
  if (options.force) args.push("--force");
  if (!options.restart) args.push("--no-restart");
  const result = deps.run(scout, args, { env: deps.env, timeoutMs: 600_000 });
  if ((result.status ?? 1) !== 0) {
    return { part: "web", status: "failed", before, after: before, message: failureText(result) };
  }
  return { part: "web", status: "updated", before, after: target, message: `the full web app ${target} is installed` };
}

const STATUS_WORDS: Record<InstallAllStatus, string> = {
  "up-to-date": "current",
  installed: "installed",
  updated: "updated",
  moved: "moved",
  held: "held",
  skipped: "skipped",
  "would-change": "would change",
  failed: "failed",
};

const PART_NAMES: Record<InstallAllPart, string> = {
  cli: "CLI",
  runtime: "Runtime",
  app: "App",
  web: "Web app",
};

export function renderInstallAllResult(result: InstallAllResult): string {
  const lines = [
    `Scout ${result.target}${result.check ? " (check only)" : ""}`,
    ...result.parts.map((part) => `  ${PART_NAMES[part.part].padEnd(8)} ${STATUS_WORDS[part.status].padEnd(12)} ${part.message}`),
  ];
  if (result.backup) lines.push(`  Service file before this run: ${result.backup}`);
  const held = result.parts.filter((part) => part.status === "held" || part.status === "would-change");
  if (!result.check && held.length > 0 && !result.force) {
    lines.push("  Run `scout install --all --force` to move the held parts onto the release.");
  }
  return lines.join("\n");
}

export async function runInstallAll(
  context: ScoutCommandContext,
  options: InstallAllOptions,
  dependencies: InstallAllDependencies,
): Promise<InstallAllResult> {
  const deps = resolveDependencies(dependencies);
  const layout = bunGlobalLayout(deps.env, deps.home);
  context.stderr(options.version ? `Fetching release ${options.version}…` : "Fetching the latest Scout release…");
  const target = await deps.resolveTarget(options.version);

  const parts: InstallAllPartResult[] = [];
  let backup: string | null = null;
  const cli = installPackage(deps, layout, target, options, context);
  parts.push(cli);

  const packageReady = cli.status !== "failed" && (options.check || cli.after === target);
  if (!packageReady) {
    const why = `skipped: the ${target} package did not install`;
    for (const part of ["runtime", "app", "web"] as const) {
      parts.push({ part, status: "skipped", before: null, after: null, message: why });
    }
  } else if (options.check && !cli.after) {
    // No package is installed yet, so nothing can read the app or the web app.
    const why = `reported after the ${target} package is installed`;
    const service = readServiceFile(deps, join(deps.home, "Library", "LaunchAgents", `${SHARED_SERVICE_LABEL}.plist`));
    parts.push({
      part: "runtime",
      status: service ? "would-change" : "skipped",
      before: service ? serviceOwner(service) : null,
      after: null,
      message: service ? `the runtime service runs from ${serviceOwner(service)}` : "no runtime service; `scout setup` creates it",
    });
    parts.push({ part: "app", status: "would-change", before: null, after: null, message: why });
    parts.push({ part: "web", status: "would-change", before: null, after: null, message: why });
  } else {
    const runtime = installRuntime(deps, layout, target, options.force || cli.before !== target, options, context);
    parts.push(runtime.result);
    backup = runtime.backup;
    parts.push(installApp(deps, layout, target, options, context));
    parts.push(installWeb(deps, layout, target, options, context));
  }

  const result: InstallAllResult = { action: "install-all", target, force: options.force, check: options.check, parts, backup };
  context.output.writeValue(result, renderInstallAllResult);
  const failed = parts.filter((part) => part.status === "failed");
  if (failed.length > 0) {
    throw new ScoutCliError(`${failed.map((part) => PART_NAMES[part.part]).join(", ")} did not reach ${target}.`);
  }
  return result;
}
