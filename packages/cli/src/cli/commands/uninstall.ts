import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readlinkSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

import { deriveOpenScoutInstanceLayout } from "@openscout/runtime/instance";
import {
  claudeStatuslineCommandWrapperPath,
  isOpenScoutClaudeStatuslineCommand,
  readClaudeStatuslineDelegate,
} from "@openscout/runtime/claude-statusline";
import { assertTestIsolatedUserData, isTestRunnerProcess } from "@openscout/runtime/support-paths";
import {
  CLAUDE_PERMISSION_HOOK_WRAPPER,
  HarnessHooks,
  scoutClaudeHookCommands,
} from "../../../../runtime/src/harness-hooks.ts";
import { systemdUserUnitDirectory, resolveSystemdUserUnitName } from "../../../../runtime/src/systemd-user-service.ts";
import type { ManagedInstallRecord } from "../../../../runtime/src/managed-installs.ts";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { LEGACY_APP_BUNDLE_NAMES, OPENSCOUT_APP_BUNDLE_ID, OPENSCOUT_APP_NAME, processIdsForInstalledApp } from "./install.ts";
import { resolveExecutableFromSearchPath } from "./mcp-install.ts";
import { planZedScoutContextServerRemoval, readZedScoutContextServer, zedSettingsPath } from "./zed-settings.ts";

/*
 * `scout uninstall` takes Scout off this machine: the service, the Mac app,
 * every hook and integration it put in harness settings, its code, and its
 * config. It keeps what Scout collected (messages, work, history) unless
 * --delete-data is given. Each step checks that the thing is Scout's before it
 * touches it, and a step that fails does not stop the others.
 */

export type UninstallCategory = "app" | "service" | "integration" | "code" | "config" | "data" | "package";
export type UninstallStatus = "planned" | "removed" | "restored" | "missing" | "skipped" | "kept" | "manual" | "failed";

export type UninstallStepResult = {
  id: string;
  category: UninstallCategory;
  title: string;
  path?: string;
  status: UninstallStatus;
  detail?: string;
};

type StepOutcome = { status: Exclude<UninstallStatus, "planned" | "missing" | "kept">; detail?: string };

export type UninstallStep = {
  id: string;
  category: UninstallCategory;
  title: string;
  path?: string;
  /** missing: nothing to do. kept/manual/skipped: reported, never run. */
  state: "present" | "missing" | "kept" | "manual" | "skipped";
  /** A plain path removal: skipped as missing when an earlier step took the path. */
  pathStep?: boolean;
  detail?: string;
  run?: () => Promise<StepOutcome> | StepOutcome;
};

export type UninstallPlan = {
  instance: string;
  isProd: boolean;
  deleteData: boolean;
  steps: UninstallStep[];
};

export type UninstallOptions = { deleteData: boolean; dryRun: boolean; yes: boolean; help: boolean };

type CommandResult = { status: number | null; stdout: string; stderr: string; error?: Error };

export type UninstallDependencies = {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  run: (command: string, args: string[]) => CommandResult;
  findExecutable: (name: string) => string | null;
  /** Stop and remove the runtime service for the selected instance. */
  uninstallService: () => Promise<unknown>;
  removeClaudeHooks: (paths: { settingsPath: string; wrapperPath: string }) => Promise<{ outcome: string }>;
  /** The script this CLI runs from; decides bun vs npm for the global package. */
  scriptPath: string;
  appCandidates: string[];
  sleep: (ms: number) => void;
};

const PACKAGE_NAME = "@openscout/scout";
const SKILL_FILE = "SKILL.md";

export function renderUninstallHelp(): string {
  return [
    "Usage: scout uninstall [--dry-run] [--yes] [--delete-data] [--json]",
    "",
    "Take Scout off this machine. In order:",
    "  1. quit the Scout Mac app, stop and remove the runtime service, remove the app",
    "  2. take Scout's entries out of harness settings: Claude statusline (restoring the",
    "     one it replaced), Claude permission hook, MCP registrations (Claude, Codex, Zed),",
    "     and the Scout skill files",
    "  3. remove Scout's code and config under ~/.openscout, ~/.scout and the support folder",
    "  4. remove the global @openscout/scout package (bun or npm, whichever installed it)",
    "",
    "Collected data (messages, work, history) is kept and listed at the end.",
    "",
    "  --dry-run      print the plan and change nothing",
    "  --yes, -y      do not ask before starting",
    "  --delete-data  also delete the collected data",
    "  --json         machine-readable plan and results (needs --yes or --dry-run)",
    "",
    "Run it again at any time: steps that are already done are reported as missing.",
    "AGENTS.md blocks added with `scout setup agents-md` live in your projects and stay;",
    "remove one with `scout setup agents-md --remove` in that project.",
  ].join("\n");
}

export function parseUninstallArgs(args: string[]): UninstallOptions {
  const options: UninstallOptions = { deleteData: false, dryRun: false, yes: false, help: false };
  for (const arg of args) {
    if (arg === "--help" || arg === "-h" || arg === "help") options.help = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--delete-data") options.deleteData = true;
    else if (arg === "--json") continue;
    else throw new ScoutCliError(`unknown option for scout uninstall: ${arg}`);
  }
  return options;
}

// --- classification --------------------------------------------------------

/**
 * What Scout keeps in each of its folders. Code and config entries are
 * removed. Anything not named here is treated as collected data: kept by
 * default, removed with the whole folder under --delete-data. Unknown entries
 * fall on the safe side.
 */
export const OPENSCOUT_HOME_CODE = ["bin", "extensions", "local-builds"];
export const OPENSCOUT_HOME_CONFIG = ["config.json", "user.json", "run", "zellij-sockets", "channel-member-leases", "logs", "companion"];
export const SCOUT_HOME_CODE = ["extensions"];
export const SCOUT_HOME_CONFIG = ["cli-mtime", "local-edge", "logs", "companion", "provider-accounts.json"];
/** Pairing keys, certificates, trusted peers and bridge state go; these stay. */
export const PAIRING_DATA = ["attachments", "codex"];
export const SUPPORT_CODE = ["tools", "web"];
export const SUPPORT_CONFIG = [
  "settings.json", "relay-agents.json", ".host-info", "rpc-runtime-cutover-v1", "mcp-bridge.json",
  "mesh-approvals.json", "mesh-bind.json", "node-identity.json", "node-tls-identity.json",
  "service-link-signing.key", "legacy-app-services.json", "voice-webrtc.pid", "agent-status.json",
  "workspace-state.json", "catalog", "cache", "logs", "diagnostics", "retired-launch-agents",
];
/** support/runtime is service state and binaries, except these. */
export const SUPPORT_RUNTIME_DATA = ["agents", "codex-background-home", "statusline"];
/** In runtime/statusline, Scout's scripts and delegate go; captured history stays. */
export const STATUSLINE_CODE = ["claude-statusline.sh", "claude-statusline-capture.sh", "claude-delegate.json"];

type Roots = {
  openscoutHome: string;
  scoutHome: string;
  supportDirectory: string;
  controlHome: string;
  relayHub: string;
  pairingHome: string;
};

function resolveRoots(deps: UninstallDependencies) {
  const env = deps.env;
  const layout = deriveOpenScoutInstanceLayout({ env, home: deps.home, platform: deps.platform });
  const pick = (key: string, fallback: string) => env[key]?.trim() || fallback;
  const scoutHome = pick("OPENSCOUT_SCOUT_HOME", layout.scoutHome);
  const roots: Roots = {
    openscoutHome: pick("OPENSCOUT_HOME", layout.openscoutHome),
    scoutHome,
    supportDirectory: pick("OPENSCOUT_SUPPORT_DIRECTORY", layout.supportDirectory),
    controlHome: pick("OPENSCOUT_CONTROL_HOME", layout.controlHome),
    relayHub: pick("OPENSCOUT_RELAY_HUB", layout.relayHub),
    pairingHome: env.OPENSCOUT_PAIRING_HOME?.trim() || env.SCOUT_PAIRING_HOME?.trim() || env.OPENSCOUT_PAIRING_DIR?.trim()
      || (env.OPENSCOUT_SCOUT_HOME?.trim() ? join(scoutHome, "pairing") : layout.pairingHome),
  };
  return { layout, roots };
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function removePathStep(id: string, category: UninstallCategory, title: string, path: string): UninstallStep {
  const present = existsSync(path);
  return {
    id, category, title, path, pathStep: true,
    state: present ? "present" : "missing",
    run: () => {
      rmSync(path, { recursive: true, force: true });
      return { status: "removed" };
    },
  };
}

/** Code and config steps for one folder, plus the data entries it leaves. */
function folderSteps(input: {
  idPrefix: string;
  root: string;
  code: string[];
  config: string[];
  /** Children that are handled by another rule (another root inside this one). */
  handledElsewhere?: string[];
  /** Config entries matched by prefix (temp files Scout leaves beside a config file). */
  configPrefixes?: string[];
}): { steps: UninstallStep[]; data: string[] } {
  const steps: UninstallStep[] = [];
  const data: string[] = [];
  for (const name of input.code) {
    steps.push(removePathStep(`${input.idPrefix}:${name}`, "code", name, join(input.root, name)));
  }
  for (const name of input.config) {
    steps.push(removePathStep(`${input.idPrefix}:${name}`, "config", name, join(input.root, name)));
  }
  const known = new Set([...input.code, ...input.config, ...(input.handledElsewhere ?? [])]);
  for (const name of listDir(input.root)) {
    if (known.has(name)) continue;
    if (input.configPrefixes?.some((prefix) => name.startsWith(prefix))) {
      steps.push(removePathStep(`${input.idPrefix}:${name}`, "config", name, join(input.root, name)));
      continue;
    }
    data.push(join(input.root, name));
  }
  return { steps, data };
}

// --- integrations -----------------------------------------------------------

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readLedger(supportDirectory: string): ManagedInstallRecord[] {
  const file = readJsonFile(join(supportDirectory, "managed-installs.json"));
  if (!isRecord(file) || !Array.isArray(file.installs)) return [];
  return file.installs.filter((entry): entry is ManagedInstallRecord =>
    isRecord(entry) && typeof entry.id === "string" && typeof entry.kind === "string" && typeof entry.name === "string");
}

/** Ledger names the statusline step owns, including older installs' capture-script entries. */
function isStatuslineLedgerEntry(entry: ManagedInstallRecord): boolean {
  return entry.owner === "openscout" && (entry.kind === "statusline" || entry.name.startsWith("claude-statusline"));
}

/** The statusline Scout replaced, as recorded by any of its ledger entries. */
function ledgerPreviousStatusline(ledger: ManagedInstallRecord[]): string | null {
  for (const entry of ledger.filter(isStatuslineLedgerEntry)) {
    for (const key of ["previousCommand", "delegateCommand"]) {
      const value = entry.metadata?.[key];
      if (typeof value === "string" && value.trim() && !claudeStatuslineCommandWrapperPath(value)) return value.trim();
    }
  }
  return null;
}

function statuslineStep(input: { settingsPath: string; wrapperPath: string; capturePath: string; delegatePath: string; ledger: ManagedInstallRecord[] }): UninstallStep {
  const settings = readJsonFile(input.settingsPath);
  const statusLine = isRecord(settings) && isRecord(settings.statusLine) ? settings.statusLine : null;
  const command = typeof statusLine?.command === "string" ? statusLine.command : "";
  const wrapper = command ? claudeStatuslineCommandWrapperPath(command) : null;
  // Ours: it runs this install's wrapper, or a Scout wrapper that no longer
  // exists. Another live install's wrapper is left to that install.
  // Older installs ran a capture script with the delegate in an env var.
  const isScout = Boolean(command) && (isOpenScoutClaudeStatuslineCommand(command, input.wrapperPath) || command.includes(input.capturePath));
  const ours = isScout && (wrapper === null || wrapper === input.wrapperPath || !existsSync(wrapper));
  const base = { id: "integration:claude-statusline", category: "integration" as const, title: "Claude Code statusline", path: input.settingsPath };
  if (!isScout) return { ...base, state: "missing" };
  if (!ours) return { ...base, state: "skipped", detail: `It runs another Scout install's wrapper (${wrapper}); left for that install.` };
  return {
    ...base,
    state: "present",
    run: async () => {
      const delegate = await readClaudeStatuslineDelegate(input.delegatePath);
      const ledgerPrevious = ledgerPreviousStatusline(input.ledger);
      let previous: Record<string, unknown> | null = null;
      if (delegate?.statusLine && typeof delegate.statusLine.command === "string") previous = delegate.statusLine;
      else if (delegate) previous = { type: "command", command: delegate.command };
      else if (ledgerPrevious) previous = { type: "command", command: ledgerPrevious };
      const current = readJsonFile(input.settingsPath);
      if (!isRecord(current)) throw new Error(`could not read ${input.settingsPath}`);
      const next = { ...current };
      if (previous) next.statusLine = previous;
      else delete next.statusLine;
      writeFileSync(input.settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      return previous
        ? { status: "restored", detail: `Restored the previous statusline: ${String(previous.command)}` }
        : { status: "removed", detail: "Removed Scout's statusLine entry; there was no earlier one to restore." };
    },
  };
}

function hookStep(deps: UninstallDependencies, settingsPath: string, wrapperPath: string): UninstallStep {
  const settings = readJsonFile(settingsPath);
  const entries = isRecord(settings) ? scoutClaudeHookCommands(settings as Parameters<typeof scoutClaudeHookCommands>[0]) : [];
  const base = { id: "integration:claude-permission-hook", category: "integration" as const, title: "Claude Code permission-request hook", path: settingsPath };
  if (entries.length === 0 && !existsSync(wrapperPath)) return { ...base, state: "missing" };
  return {
    ...base,
    state: "present",
    run: async () => {
      const result = await deps.removeClaudeHooks({ settingsPath, wrapperPath });
      if (result.outcome === "skipped") return { status: "skipped", detail: "The hook code left the settings alone." };
      return { status: "removed", detail: `Removed the hook entry and ${wrapperPath}.` };
    },
  };
}

/** A SKILL.md Scout wrote: frontmatter names the skill `scout`. */
export function isScoutSkillFile(path: string): boolean {
  try {
    const head = readFileSync(path, "utf8").slice(0, 400);
    return /^---\s*\n(?:[^\n]*\n)*?name:\s*["']?scout["']?\s*\n/u.test(head);
  } catch {
    return false;
  }
}

export function scoutSkillTargets(home: string): string[] {
  return [
    join(home, ".claude", "skills", "scout", SKILL_FILE),
    join(home, ".agents", "skills", "scout", SKILL_FILE),
    join(home, ".grok", "skills", "scout", SKILL_FILE),
    join(home, ".pi", "agent", "skills", "scout", SKILL_FILE),
    join(home, ".config", "opencode", "skills", "scout", SKILL_FILE),
  ];
}

function skillSteps(home: string, ledger: ManagedInstallRecord[]): UninstallStep[] {
  const fromLedger = ledger
    .filter((entry) => entry.owner === "openscout" && entry.kind === "skill" && typeof entry.targetPath === "string")
    .map((entry) => entry.targetPath!);
  const targets = [...new Set([...scoutSkillTargets(home), ...fromLedger])];
  return targets.map((target) => {
    const base = { id: `integration:skill:${target}`, category: "integration" as const, title: "Scout skill", path: target };
    if (!existsSync(target)) return { ...base, state: "missing" as const };
    if (!isScoutSkillFile(target)) return { ...base, state: "skipped" as const, detail: "This SKILL.md is not Scout's; left alone." };
    return {
      ...base,
      state: "present" as const,
      run: () => {
        rmSync(target, { force: true });
        try { rmdirSync(dirname(target)); } catch { /* the folder holds other files */ }
        return { status: "removed" as const };
      },
    };
  });
}

const SCOUT_LAUNCHER = /(?:^|\/)scout(?:\.mjs)?$/u;

/**
 * `claude mcp get scout` / `codex mcp get scout` output describes the Scout
 * CLI's MCP server: `Command:` is a scout launcher (or a runtime running one)
 * and `Args:` ends in `mcp`.
 */
export function looksLikeScoutMcpEntry(output: string): boolean {
  const command = /^\s*command:\s*(.+?)\s*$/imu.exec(output)?.[1] ?? "";
  const args = (/^\s*args:\s*(.+?)\s*$/imu.exec(output)?.[1] ?? "").split(/\s+/u).filter(Boolean);
  if (args[args.length - 1] !== "mcp") return false;
  return SCOUT_LAUNCHER.test(command) || args.slice(0, -1).some((arg) => SCOUT_LAUNCHER.test(arg));
}

function cliMcpStep(deps: UninstallDependencies, host: "claude" | "codex"): UninstallStep {
  const title = host === "claude" ? "Claude Code MCP server `scout`" : "Codex MCP server `scout`";
  const base = { id: `integration:mcp:${host}`, category: "integration" as const, title };
  const executable = deps.findExecutable(host);
  if (!executable) return { ...base, state: "missing", detail: `${host} is not installed.` };
  const existing = deps.run(executable, ["mcp", "get", "scout"]);
  if (existing.error || existing.status !== 0) return { ...base, state: "missing" };
  const output = `${existing.stdout}\n${existing.stderr}`;
  if (!looksLikeScoutMcpEntry(output)) return { ...base, state: "skipped", detail: "The `scout` entry does not run the Scout CLI; left alone." };
  const removeArgs = host === "claude" ? ["mcp", "remove", "--scope", "user", "scout"] : ["mcp", "remove", "scout"];
  return {
    ...base,
    state: "present",
    detail: `${executable} ${removeArgs.join(" ")}`,
    run: () => {
      const removed = deps.run(executable, removeArgs);
      if (removed.error || removed.status !== 0) {
        throw new Error(removed.stderr.trim() || removed.stdout.trim() || removed.error?.message || `exit ${removed.status}`);
      }
      return { status: "removed" };
    },
  };
}

function zedMcpStep(deps: UninstallDependencies): UninstallStep {
  const settingsPath = zedSettingsPath({ ...deps.env, HOME: deps.home }, deps.platform);
  const base = { id: "integration:mcp:zed", category: "integration" as const, title: "Zed context server `scout`", path: settingsPath };
  let text: string;
  try {
    text = readFileSync(settingsPath, "utf8");
  } catch {
    return { ...base, state: "missing" };
  }
  let entry: unknown;
  try {
    entry = readZedScoutContextServer(text);
  } catch (error) {
    return { ...base, state: "skipped", detail: `Could not read Zed settings: ${errorText(error)}` };
  }
  if (entry === undefined) return { ...base, state: "missing" };
  const command = isRecord(entry) && typeof entry.command === "string" ? entry.command : "";
  const args = isRecord(entry) && Array.isArray(entry.args) ? entry.args : [];
  if (args[args.length - 1] !== "mcp" || !(SCOUT_LAUNCHER.test(command) || args.some((arg) => typeof arg === "string" && SCOUT_LAUNCHER.test(arg)))) {
    return { ...base, state: "skipped", detail: "context_servers.scout does not run the Scout CLI; left alone." };
  }
  return {
    ...base,
    state: "present",
    run: () => {
      const plan = planZedScoutContextServerRemoval(readFileSync(settingsPath, "utf8"));
      if (plan.action === "absent") return { status: "skipped", detail: "Already gone." };
      writeFileSync(settingsPath, plan.text);
      return { status: "removed" };
    },
  };
}

/** Ledger entries no other step owns: handled by their recorded strategy. */
function otherLedgerSteps(ledger: ManagedInstallRecord[]): UninstallStep[] {
  return ledger
    .filter((entry) => entry.owner === "openscout" && !isStatuslineLedgerEntry(entry) && !["skill", "hook"].includes(entry.kind))
    .map((entry): UninstallStep => {
      const base = { id: `integration:ledger:${entry.id}`, category: "integration" as const, title: entry.title || entry.name, path: entry.targetPath };
      const strategy = entry.uninstall?.strategy;
      if (strategy === "delete-target" && entry.targetPath) {
        if (!existsSync(entry.targetPath)) return { ...base, state: "missing" };
        return { ...base, state: "present", run: () => { rmSync(entry.targetPath!, { recursive: true, force: true }); return { status: "removed" }; } };
      }
      if (strategy === "restore-backup" && entry.targetPath && entry.backupPath) {
        if (!existsSync(entry.backupPath)) return { ...base, state: "missing", detail: `No backup at ${entry.backupPath}.` };
        return {
          ...base,
          state: "present",
          run: () => {
            writeFileSync(entry.targetPath!, readFileSync(entry.backupPath!));
            rmSync(entry.backupPath!, { force: true });
            return { status: "restored" };
          },
        };
      }
      return { ...base, state: "manual", detail: entry.uninstall?.command ?? entry.uninstall?.notes ?? "No recorded way to remove it." };
    });
}

// --- app, service, package --------------------------------------------------

function bundleId(deps: UninstallDependencies, appPath: string): string | null {
  const plist = join(appPath, "Contents", "Info.plist");
  if (!existsSync(plist)) return null;
  const result = deps.run("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist]);
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function runningPids(deps: UninstallDependencies, appPath: string): number[] {
  const ps = deps.run("ps", ["-axo", "pid=,args="]);
  return ps.status === 0 ? processIdsForInstalledApp(ps.stdout, appPath) : [];
}

function quitApp(deps: UninstallDependencies, appPath: string): StepOutcome {
  let pids = runningPids(deps, appPath);
  if (pids.length === 0) return { status: "skipped", detail: "Not running." };
  for (const signal of ["-TERM", "-KILL"]) {
    for (const pid of pids) deps.run("kill", [signal, String(pid)]);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      pids = runningPids(deps, appPath);
      if (pids.length === 0) return { status: "removed", detail: "Quit." };
      deps.sleep(100);
    }
  }
  throw new Error(`could not quit ${appPath} (still running: ${pids.join(", ")})`);
}

function appSteps(deps: UninstallDependencies): { quit: UninstallStep[]; remove: UninstallStep[] } {
  const quit: UninstallStep[] = [];
  const remove: UninstallStep[] = [];
  for (const appPath of deps.appCandidates) {
    if (!existsSync(appPath)) {
      remove.push({ id: `app:${appPath}`, category: "app", title: "Scout Mac app", path: appPath, state: "missing" });
      continue;
    }
    const id = bundleId(deps, appPath);
    if (id !== OPENSCOUT_APP_BUNDLE_ID) {
      remove.push({ id: `app:${appPath}`, category: "app", title: "Scout Mac app", path: appPath, state: "skipped", detail: `Bundle id is ${id ?? "(none)"}, not ${OPENSCOUT_APP_BUNDLE_ID}; left alone.` });
      continue;
    }
    quit.push({ id: `app-quit:${appPath}`, category: "app", title: "Quit the Scout Mac app", path: appPath, state: "present", run: () => quitApp(deps, appPath) });
    remove.push({
      id: `app:${appPath}`, category: "app", title: "Scout Mac app", path: appPath, state: "present",
      run: () => { rmSync(appPath, { recursive: true, force: true }); return { status: "removed" }; },
    });
  }
  return { quit, remove };
}

function serviceStep(deps: UninstallDependencies, layout: ReturnType<typeof deriveOpenScoutInstanceLayout>): UninstallStep {
  const definition = deps.platform === "darwin"
    ? join(deps.home, "Library", "LaunchAgents", `${layout.serviceLabel}.plist`)
    : deps.platform === "linux"
      ? join(systemdUserUnitDirectory({ ...deps.env, HOME: deps.home }, deps.home), resolveSystemdUserUnitName(deps.env))
      : null;
  const base = { id: "service", category: "service" as const, title: `Runtime service ${layout.serviceLabel}`, ...(definition ? { path: definition } : {}) };
  if (!definition || !existsSync(definition)) return { ...base, state: "missing" };
  return {
    ...base,
    state: "present",
    run: async () => {
      await deps.uninstallService();
      return { status: "removed", detail: "Stopped and removed (openscout-runtime service uninstall)." };
    },
  };
}

/** Which package manager installed the running CLI, from its install path. */
export function detectGlobalPackageManager(scriptPath: string): { manager: "bun" | "npm"; root: string } | null {
  let resolved = scriptPath;
  try { resolved = realpathSync(scriptPath); } catch { /* use as given */ }
  const marker = `/node_modules/${PACKAGE_NAME}/`;
  const at = resolved.indexOf(marker);
  if (at < 0) return null;
  const root = resolved.slice(0, at + marker.length - 1);
  if (resolved.includes(`/.bun/install/global${marker}`)) return { manager: "bun", root };
  // npm's global prefix on macOS and Linux: <prefix>/lib/node_modules.
  if (resolved.includes(`/lib${marker}`)) return { manager: "npm", root };
  return null;
}

function packageStep(deps: UninstallDependencies): UninstallStep {
  const base = { id: "package", category: "package" as const, title: `Global package ${PACKAGE_NAME}` };
  const detected = detectGlobalPackageManager(deps.scriptPath);
  if (!detected) {
    return { ...base, path: deps.scriptPath, state: "skipped", detail: "This CLI is not a global bun or npm install (a checkout, or a local install); remove it the way you installed it." };
  }
  const args = detected.manager === "bun" ? ["remove", "-g", PACKAGE_NAME] : ["uninstall", "-g", PACKAGE_NAME];
  return {
    ...base,
    path: detected.root,
    state: "present",
    detail: `${detected.manager} ${args.join(" ")}`,
    run: () => {
      const executable = deps.findExecutable(detected.manager) ?? detected.manager;
      const result = deps.run(executable, args);
      if (result.error || result.status !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || result.error?.message || `exit ${result.status}`);
      }
      return { status: "removed" };
    },
  };
}

/**
 * A `scout` link someone made in ~/.local/bin into the global package. Scout
 * did not write it, so it is reported, not removed.
 */
function launcherLinkStep(deps: UninstallDependencies): UninstallStep {
  const link = join(deps.home, ".local", "bin", "scout");
  const base = { id: "manual:local-bin-scout", category: "package" as const, title: "scout link in ~/.local/bin", path: link };
  let target: string | null = null;
  try {
    if (lstatSync(link).isSymbolicLink()) target = readlinkSync(link);
  } catch {
    return { ...base, state: "missing" };
  }
  if (!target || !/scout/u.test(target)) return { ...base, state: "missing" };
  return { ...base, state: "manual", detail: `Points at ${target}; Scout did not create it. Remove it with: rm ${link}` };
}

// --- plan -------------------------------------------------------------------

export function buildUninstallPlan(deps: UninstallDependencies, options: { deleteData: boolean }): UninstallPlan {
  const { layout, roots } = resolveRoots(deps);
  const isProd = layout.isProd;
  const ledger = readLedger(roots.supportDirectory);
  const steps: UninstallStep[] = [];
  const data: string[] = [];

  // The Claude settings file, the skills, the MCP names, the app and the
  // global package are one per login and belong to the main instance. A dev
  // instance's uninstall leaves them to it.
  const apps = isProd && deps.platform === "darwin" ? appSteps(deps) : { quit: [], remove: [] };
  steps.push(...apps.quit);
  steps.push(serviceStep(deps, layout));
  steps.push(...apps.remove);

  const runtimeDirectory = join(roots.supportDirectory, "runtime");
  const statuslineDirectory = join(runtimeDirectory, "statusline");
  if (isProd) {
    const claudeSettings = join(deps.home, ".claude", "settings.json");
    steps.push(statuslineStep({
      settingsPath: claudeSettings,
      wrapperPath: join(statuslineDirectory, "claude-statusline.sh"),
      capturePath: join(statuslineDirectory, "claude-statusline-capture.sh"),
      delegatePath: join(statuslineDirectory, "claude-delegate.json"),
      ledger,
    }));
    steps.push(hookStep(deps, claudeSettings, join(runtimeDirectory, "hooks", CLAUDE_PERMISSION_HOOK_WRAPPER)));
    steps.push(cliMcpStep(deps, "claude"), cliMcpStep(deps, "codex"), zedMcpStep(deps));
    steps.push(...skillSteps(deps.home, ledger));
    steps.push(...otherLedgerSteps(ledger));
  }

  // Code and config, folder by folder. A root nested in another (the control
  // plane in ~/.openscout) is collected data and handled once.
  const nested = (root: string, inside: string) => (isInside(root, inside) && root !== inside ? [root.slice(inside.length + 1).split("/")[0]!] : []);
  const dataRoots = [roots.controlHome, roots.relayHub, roots.pairingHome, roots.supportDirectory];
  const childNames = (parent: string) => dataRoots.flatMap((root) => nested(root, parent));

  // A dev instance keeps both homes in one root.
  const sharedRoot = roots.scoutHome === roots.openscoutHome;
  const openscout = folderSteps({
    idPrefix: "openscout-home", root: roots.openscoutHome,
    code: sharedRoot ? [...new Set([...OPENSCOUT_HOME_CODE, ...SCOUT_HOME_CODE])] : OPENSCOUT_HOME_CODE,
    config: sharedRoot ? [...new Set([...OPENSCOUT_HOME_CONFIG, ...SCOUT_HOME_CONFIG])] : OPENSCOUT_HOME_CONFIG,
    handledElsewhere: childNames(roots.openscoutHome),
  });
  steps.push(...openscout.steps);
  data.push(...openscout.data);

  if (!sharedRoot) {
    const scout = folderSteps({
      idPrefix: "scout-home", root: roots.scoutHome,
      code: SCOUT_HOME_CODE, config: SCOUT_HOME_CONFIG,
      handledElsewhere: childNames(roots.scoutHome),
    });
    steps.push(...scout.steps);
    data.push(...scout.data);
  }

  for (const name of listDir(roots.pairingHome)) {
    const path = join(roots.pairingHome, name);
    if (PAIRING_DATA.includes(name)) data.push(path);
    else steps.push(removePathStep(`pairing:${name}`, "config", `pairing ${name}`, path));
  }

  const support = folderSteps({
    idPrefix: "support", root: roots.supportDirectory,
    code: SUPPORT_CODE, config: SUPPORT_CONFIG,
    handledElsewhere: ["runtime", "managed-installs.json", ...childNames(roots.supportDirectory)],
    configPrefixes: ["mesh-bind.json.", "node-tls-identity."],
  });
  steps.push(...support.steps);
  data.push(...support.data);
  for (const name of listDir(runtimeDirectory)) {
    const path = join(runtimeDirectory, name);
    if (SUPPORT_RUNTIME_DATA.includes(name)) {
      if (name !== "statusline") data.push(path);
      continue;
    }
    steps.push(removePathStep(`runtime:${name}`, name === "scoutd" || name === "scoutd-dd" ? "code" : "config", `runtime ${name}`, path));
  }
  for (const name of listDir(statuslineDirectory)) {
    const path = join(statuslineDirectory, name);
    if (STATUSLINE_CODE.includes(name)) steps.push(removePathStep(`statusline:${name}`, "code", `statusline ${name}`, path));
    else data.push(path);
  }
  for (const root of [roots.controlHome, roots.relayHub]) if (existsSync(root)) data.push(root);

  // Collected data.
  const uniqueData = [...new Set(data)].filter((path) => !data.some((other) => other !== path && isInside(path, other)));
  if (options.deleteData) {
    const folders = [...new Set([roots.controlHome, roots.relayHub, roots.pairingHome, roots.openscoutHome, roots.scoutHome, roots.supportDirectory])]
      .filter((root, _index, all) => !all.some((other) => other !== root && isInside(root, other)));
    for (const root of folders) steps.push(removePathStep(`data:${root}`, "data", "Scout folder and its collected data", root));
  } else {
    for (const path of uniqueData) steps.push({ id: `data:${path}`, category: "data", title: "Collected data", path, state: "kept" });
  }

  // The ledger goes once the entries it lists are gone; the package goes last
  // because it is the code running now.
  if (!options.deleteData) {
    steps.push(removePathStep("support:managed-installs.json", "config", "Managed-installs ledger", join(roots.supportDirectory, "managed-installs.json")));
  }
  if (isProd) {
    steps.push(packageStep(deps));
    steps.push(launcherLinkStep(deps));
  }

  return { instance: layout.name, isProd, deleteData: options.deleteData, steps };
}

// --- execute ----------------------------------------------------------------

function planStatus(step: UninstallStep): UninstallStatus {
  if (step.state === "present") return "planned";
  return step.state;
}

export function describePlan(plan: UninstallPlan): UninstallStepResult[] {
  return plan.steps.map((step) => ({
    id: step.id, category: step.category, title: step.title,
    ...(step.path ? { path: step.path } : {}),
    status: planStatus(step),
    ...(step.detail ? { detail: step.detail } : {}),
  }));
}

/** Refuse to run against a real home under a test runner. */
export function assertUninstallIsolated(deps: Pick<UninstallDependencies, "home">): void {
  assertTestIsolatedUserData("run scout uninstall", "OPENSCOUT_SUPPORT_DIRECTORY");
  if (!isTestRunnerProcess()) return;
  let realHome = homedir();
  try { realHome = userInfo().homedir; } catch { /* fall back to homedir() */ }
  if (deps.home === realHome || isInside(realHome, deps.home)) {
    throw new Error("Refusing to run scout uninstall under a test runner against the real home directory.");
  }
}

export async function executeUninstallPlan(plan: UninstallPlan, deps: UninstallDependencies): Promise<UninstallStepResult[]> {
  assertUninstallIsolated(deps);
  const results: UninstallStepResult[] = [];
  for (const step of plan.steps) {
    const base = { id: step.id, category: step.category, title: step.title, ...(step.path ? { path: step.path } : {}) };
    if (step.state !== "present" || !step.run) {
      results.push({ ...base, status: planStatus(step) === "planned" ? "skipped" : planStatus(step), ...(step.detail ? { detail: step.detail } : {}) });
      continue;
    }
    // A path step whose target an earlier step already took (a data folder
    // under --delete-data) is reported as missing, not run twice.
    if (step.pathStep && step.path && !existsSync(step.path)) {
      results.push({ ...base, status: "missing" });
      continue;
    }
    try {
      const outcome = await step.run();
      results.push({ ...base, status: outcome.status, ...(outcome.detail ?? step.detail ? { detail: outcome.detail ?? step.detail } : {}) });
    } catch (error) {
      results.push({ ...base, status: "failed", detail: errorText(error) });
    }
  }
  return results;
}

// --- rendering --------------------------------------------------------------

const CATEGORY_LABEL: Record<UninstallCategory, string> = {
  app: "Mac app", service: "Service", integration: "Harness integrations", code: "Code", config: "Config", data: "Collected data", package: "Package",
};

export function renderUninstallResults(results: UninstallStepResult[], options: { dryRun: boolean; instance: string }): string {
  const lines: string[] = [options.dryRun ? `scout uninstall plan (instance ${options.instance}); nothing was changed:` : `scout uninstall (instance ${options.instance}):`];
  const order: UninstallCategory[] = ["app", "service", "integration", "code", "config", "data", "package"];
  for (const category of order) {
    const rows = results.filter((row) => row.category === category && row.status !== "missing");
    if (rows.length === 0) continue;
    lines.push("", `${CATEGORY_LABEL[category]}:`);
    for (const row of rows) {
      const verb = row.status === "planned" ? (category === "data" ? "delete" : "remove") : row.status;
      const what = category === "code" || category === "config" || category === "data" || !row.path ? row.path ?? row.title : `${row.title}: ${row.path}`;
      lines.push(`  ${verb.padEnd(9)}${what}`);
      if (row.detail) lines.push(`           ${row.detail}`);
    }
  }
  const missing = results.filter((row) => row.status === "missing").length;
  if (missing > 0) lines.push("", `${missing} item${missing === 1 ? " was" : "s were"} already absent.`);
  const kept = results.filter((row) => row.status === "kept");
  if (kept.length > 0) lines.push("", "Your collected data was kept in the paths above. Rerun with --delete-data to remove it.");
  lines.push("", "AGENTS.md blocks from `scout setup agents-md` stay in your projects; run `scout setup agents-md --remove` in a project to take one out.");
  const failed = results.filter((row) => row.status === "failed").length;
  if (failed > 0) lines.push("", `${failed} step${failed === 1 ? "" : "s"} failed; see above. Fix the cause and run scout uninstall again.`);
  return lines.join("\n");
}

// --- command ----------------------------------------------------------------

function defaultRun(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ...(result.error ? { error: result.error } : {}) };
}

export function defaultUninstallDependencies(env: NodeJS.ProcessEnv = process.env): UninstallDependencies {
  const home = env.HOME?.trim() || homedir();
  return {
    env,
    home,
    platform: process.platform,
    run: defaultRun,
    findExecutable: (name) => resolveExecutableFromSearchPath([name], env),
    uninstallService: async () => {
      const { runRuntimeBrokerService } = await import("../../lib/app/host/runtime-service-client.ts");
      return runRuntimeBrokerService("uninstall");
    },
    removeClaudeHooks: ({ settingsPath, wrapperPath }) => new HarnessHooks({ settingsPath, wrapperPath }).remove(),
    scriptPath: process.argv[1] ?? "",
    appCandidates: [
      join("/Applications", OPENSCOUT_APP_NAME),
      ...LEGACY_APP_BUNDLE_NAMES.map((name) => join("/Applications", name)),
      join(home, "Applications", OPENSCOUT_APP_NAME),
    ],
    sleep: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
  };
}

async function confirm(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/iu.test((await prompt.question(question)).trim());
  } finally {
    prompt.close();
  }
}

export async function runUninstallCommand(
  context: ScoutCommandContext,
  args: string[],
  deps: UninstallDependencies = defaultUninstallDependencies(context.env),
  ask: (question: string) => Promise<boolean> = confirm,
): Promise<void> {
  const options = parseUninstallArgs(args);
  if (options.help) {
    context.output.writeText(renderUninstallHelp());
    return;
  }
  const json = context.output.mode === "json";
  const plan = buildUninstallPlan(deps, { deleteData: options.deleteData });
  const planned = describePlan(plan);
  const payload = (steps: UninstallStepResult[], dryRun: boolean) => ({
    schema: "scout.uninstall.v1",
    instance: plan.instance,
    dryRun,
    deleteData: plan.deleteData,
    steps,
    kept: steps.filter((step) => step.status === "kept").map((step) => step.path),
    failed: steps.filter((step) => step.status === "failed").length,
  });

  if (options.dryRun) {
    context.output.writeValue(payload(planned, true), () => renderUninstallResults(planned, { dryRun: true, instance: plan.instance }));
    return;
  }
  if (!options.yes) {
    if (json || !context.isTty || !process.stdin.isTTY) {
      throw new ScoutCliError("scout uninstall changes this machine. Review it with `scout uninstall --dry-run`, then run `scout uninstall --yes`.");
    }
    context.output.writeText(renderUninstallResults(planned, { dryRun: true, instance: plan.instance }));
    const question = options.deleteData
      ? "\nRemove Scout AND delete its collected data? This cannot be undone. [y/N] "
      : "\nRemove Scout from this machine? [y/N] ";
    if (!(await ask(question))) {
      context.output.writeText("Nothing was changed.");
      return;
    }
  }

  const results = await executeUninstallPlan(plan, deps);
  context.output.writeValue(payload(results, false), () => renderUninstallResults(results, { dryRun: false, instance: plan.instance }));
  if (results.some((row) => row.status === "failed")) process.exitCode = 1;
}
