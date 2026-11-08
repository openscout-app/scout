import { chmod, mkdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { isClaudeStatuslineWrapperIsolatedFromSettings } from "./claude-statusline.js";
import { isProdOpenScoutInstance, resolveOpenScoutInstanceName } from "./instance.js";
import { readManagedInstalls, removeManagedInstall, upsertManagedInstall } from "./managed-installs.js";
import { resolveOpenScoutSupportPaths } from "./support-paths.js";

/**
 * Hooks Scout puts into a harness's own settings. The runtime is the only
 * writer: `scout hooks apply` adds Scout's entries, `scout hooks remove` takes
 * out exactly those entries and leaves every other hook as it found it.
 *
 * Claude Code: one PermissionRequest entry that runs a Scout-owned wrapper
 * script, so a permission dialog in any Claude session can be answered from
 * Scout. The wrapper's file name marks the entry as Scout's.
 */

export const CLAUDE_PERMISSION_HOOK_EVENT = "PermissionRequest" as const;
export const CLAUDE_PERMISSION_HOOK_WRAPPER = "openscout-claude-permission-request.sh";

export type HarnessHookState = "applied" | "absent" | "stale";

export type HarnessHookStatus = {
  harness: "claude";
  hook: "permission-request";
  event: typeof CLAUDE_PERMISSION_HOOK_EVENT;
  state: HarnessHookState;
  settingsPath: string;
  wrapperPath: string;
  command: string;
  /** Scout entries in the settings now; more than one, or a different command, is stale. */
  entries: string[];
  detail?: string;
};

export type HarnessHooksSkipReason =
  | "non-prod-instance"
  | "isolated-support-directory"
  | "scout-cli-not-found"
  | "owned-by-other-install";

export type HarnessHooksResult = {
  action: "apply" | "remove";
  outcome: "changed" | "unchanged" | "skipped";
  reason?: HarnessHooksSkipReason;
  hooks: HarnessHookStatus[];
};

export class HarnessHooksError extends Error {
  constructor(message: string, readonly code: "settings-unreadable" | "settings-busy") {
    super(message);
    this.name = "HarnessHooksError";
  }
}

type Settings = Record<string, unknown>;

export type HarnessHooksOptions = {
  settingsPath?: string;
  wrapperPath?: string;
  /** How the wrapper starts the Scout CLI, shell-quoted; null when no CLI was found. */
  scoutInvocation?: () => string | null;
  instance?: string;
  /** The env var that lets a non-prod instance claim the harness settings. */
  instanceOverride?: string;
  managedInstalls?: boolean;
};

export function resolveClaudeSettingsPath(): string {
  return join(process.env.HOME?.trim() || homedir(), ".claude", "settings.json");
}

export function resolveClaudePermissionHookWrapperPath(): string {
  return join(resolveOpenScoutSupportPaths().runtimeDirectory, "hooks", CLAUDE_PERMISSION_HOOK_WRAPPER);
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** An entry Scout wrote: its wrapper, or the bare CLI command from before there was one. */
export function isScoutClaudeHookCommand(command: string): boolean {
  return command.includes(CLAUDE_PERMISSION_HOOK_WRAPPER) || /\bpermission-hook\s+claude\b/.test(command);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function commandOf(entry: unknown): string | null {
  return isRecord(entry) && typeof entry.command === "string" ? entry.command : null;
}

/** Every Scout hook command in the settings, across every event. */
export function scoutClaudeHookCommands(settings: Settings): string[] {
  if (!isRecord(settings.hooks)) return [];
  const found: string[] = [];
  for (const groups of Object.values(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      for (const entry of group.hooks) {
        const command = commandOf(entry);
        if (command && isScoutClaudeHookCommand(command)) found.push(command);
      }
    }
  }
  return found;
}

/**
 * The settings with every Scout hook taken out. A group, an event or the
 * `hooks` key goes only when Scout's removal is what emptied it; anything
 * else, including an empty group someone else left, stays as it was.
 */
export function withoutScoutClaudeHooks(settings: Settings): { settings: Settings; removed: number } {
  if (!isRecord(settings.hooks)) return { settings, removed: 0 };
  let removed = 0;
  const hooks: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue; }
    const kept: unknown[] = [];
    let touched = false;
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) { kept.push(group); continue; }
      const entries = group.hooks.filter((entry) => {
        const command = commandOf(entry);
        return !(command && isScoutClaudeHookCommand(command));
      });
      const dropped = group.hooks.length - entries.length;
      if (dropped === 0) { kept.push(group); continue; }
      removed += dropped;
      touched = true;
      if (entries.length > 0) kept.push({ ...group, hooks: entries });
    }
    if (touched && kept.length === 0) continue;
    hooks[event] = kept;
  }
  if (removed === 0) return { settings, removed: 0 };
  const next: Settings = { ...settings };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  else next.hooks = hooks;
  return { settings: next, removed };
}

/** The settings with exactly one Scout PermissionRequest entry, running `command`. */
export function withScoutClaudeHooks(settings: Settings, command: string): Settings {
  const present = scoutClaudeHookCommands(settings);
  if (present.length === 1 && present[0] === command && hasPermissionEntry(settings, command)) return settings;
  const base = withoutScoutClaudeHooks(settings).settings;
  const hooks = isRecord(base.hooks) ? { ...base.hooks } : {};
  const groups = Array.isArray(hooks[CLAUDE_PERMISSION_HOOK_EVENT]) ? [...(hooks[CLAUDE_PERMISSION_HOOK_EVENT] as unknown[])] : [];
  groups.push({ hooks: [{ type: "command", command }] });
  hooks[CLAUDE_PERMISSION_HOOK_EVENT] = groups;
  return { ...base, hooks };
}

function hasPermissionEntry(settings: Settings, command: string): boolean {
  const groups = isRecord(settings.hooks) ? settings.hooks[CLAUDE_PERMISSION_HOOK_EVENT] : undefined;
  return Array.isArray(groups) && groups.some((group) =>
    isRecord(group) && Array.isArray(group.hooks) && group.hooks.some((entry) => commandOf(entry) === command));
}

export function claudePermissionHookWrapper(scoutInvocation: string): string {
  return [
    "#!/bin/sh",
    "# Scout's Claude Code PermissionRequest hook. `scout hooks remove` takes it out.",
    `exec ${scoutInvocation} permission-hook claude`,
    "",
  ].join("\n");
}

type SettingsFile = { exists: boolean; text: string | null; settings: Settings };

async function readSettingsFile(path: string): Promise<SettingsFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, text: null, settings: {} };
    throw new HarnessHooksError(`Could not read ${path}: ${(error as Error).message}`, "settings-unreadable");
  }
  let parsed: unknown;
  try {
    parsed = text.trim() ? JSON.parse(text) : {};
  } catch (error) {
    throw new HarnessHooksError(`${path} is not valid JSON, so Scout left it alone: ${(error as Error).message}`, "settings-unreadable");
  }
  if (!isRecord(parsed)) throw new HarnessHooksError(`${path} does not hold a JSON object, so Scout left it alone.`, "settings-unreadable");
  return { exists: true, text, settings: parsed };
}

/**
 * Replace the settings file in one rename, keeping its mode and following a
 * symlink to the real file. Claude Code also writes this file: when it changed
 * since `before` was read, nothing is written and the caller starts over.
 */
async function replaceSettingsFile(path: string, before: SettingsFile, next: Settings): Promise<boolean> {
  const target = before.exists ? await realpath(path) : path;
  const current = await readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (current !== before.text) return false;
  await mkdir(dirname(target), { recursive: true });
  const mode = before.exists ? (await stat(target)).mode & 0o777 : 0o644;
  const temp = join(dirname(target), `.${basename(target)}.scout-${process.pid}-${Date.now()}.tmp`);
  const trailing = before.text === null || before.text.endsWith("\n") ? "\n" : "";
  try {
    await writeFile(temp, JSON.stringify(next, null, 2) + trailing, { encoding: "utf8", mode });
    await chmod(temp, mode);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  return true;
}

async function editSettings(path: string, edit: (settings: Settings) => Settings): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readSettingsFile(path);
    const next = edit(before.settings);
    if (next === before.settings) return false;
    if (!before.exists && Object.keys(next).length === 0) return false;
    if (await replaceSettingsFile(path, before, next)) return true;
  }
  throw new HarnessHooksError(`${path} kept changing while Scout edited it; try again.`, "settings-busy");
}

/** The script a Scout entry runs, when the entry is a bare (or single-quoted) path to one. */
function wrapperPathOf(command: string): string | null {
  const trimmed = command.trim();
  const quoted = /^'.*'$/s.test(trimmed);
  const raw = quoted ? trimmed.slice(1, -1).replace(/'\\''/g, "'") : trimmed;
  return basename(raw) === CLAUDE_PERMISSION_HOOK_WRAPPER && (quoted || !/\s/.test(raw)) ? raw : null;
}

export class HarnessHooks {
  private readonly settingsPath: string;
  private readonly wrapperPath: string;
  private readonly command: string;

  constructor(private readonly options: HarnessHooksOptions = {}) {
    this.settingsPath = options.settingsPath ?? resolveClaudeSettingsPath();
    this.wrapperPath = options.wrapperPath ?? resolveClaudePermissionHookWrapperPath();
    this.command = shellQuote(this.wrapperPath);
  }

  async status(): Promise<HarnessHookStatus[]> {
    const { settings } = await readSettingsFile(this.settingsPath);
    const entries = scoutClaudeHookCommands(settings);
    const base = {
      harness: "claude" as const, hook: "permission-request" as const, event: CLAUDE_PERMISSION_HOOK_EVENT,
      settingsPath: this.settingsPath, wrapperPath: this.wrapperPath, command: this.command, entries,
    };
    if (entries.length === 0) return [{ ...base, state: "absent" }];
    const wrapper = await readFile(this.wrapperPath, "utf8").catch(() => null);
    const invocation = this.options.scoutInvocation?.() ?? null;
    let detail: string | undefined;
    if (entries.length > 1) detail = "Claude settings hold more than one Scout entry.";
    else if (entries[0] !== this.command || !hasPermissionEntry(settings, this.command)) detail = "The Scout entry runs a different command.";
    else if (wrapper === null) detail = "The hook script is missing.";
    else if (invocation && wrapper !== claudePermissionHookWrapper(invocation)) detail = "The hook script starts a different Scout CLI.";
    return [{ ...base, state: detail ? "stale" : "applied", ...(detail ? { detail } : {}) }];
  }

  private gate(): HarnessHooksSkipReason | null {
    const instance = this.options.instance ?? resolveOpenScoutInstanceName();
    const override = (this.options.instanceOverride ?? process.env.OPENSCOUT_HOOKS_INSTANCE)?.trim().toLowerCase();
    // ~/.claude/settings.json is one per login and belongs to the prod
    // instance, as the statusline does, unless the operator points it here.
    if (!isProdOpenScoutInstance(instance) && override !== instance) return "non-prod-instance";
    return null;
  }

  async apply(): Promise<HarnessHooksResult> {
    const skip = async (reason: HarnessHooksSkipReason): Promise<HarnessHooksResult> =>
      ({ action: "apply", outcome: "skipped", reason, hooks: await this.status() });
    const gated = this.gate();
    if (gated) return skip(gated);
    // A temp support directory would point the real settings at a script
    // that disappears with it.
    if (isClaudeStatuslineWrapperIsolatedFromSettings(this.settingsPath, this.wrapperPath)) return skip("isolated-support-directory");
    const invocation = this.options.scoutInvocation?.() ?? null;
    if (!invocation) return skip("scout-cli-not-found");

    // Another install's script that still exists keeps its entry.
    const { settings } = await readSettingsFile(this.settingsPath);
    for (const existing of scoutClaudeHookCommands(settings)) {
      const other = wrapperPathOf(existing);
      if (other && other !== this.wrapperPath && existsSync(other)) return skip("owned-by-other-install");
    }

    const script = claudePermissionHookWrapper(invocation);
    const previousScript = await readFile(this.wrapperPath, "utf8").catch(() => null);
    if (previousScript !== script) {
      await mkdir(dirname(this.wrapperPath), { recursive: true });
      await writeFile(this.wrapperPath, script, "utf8");
    }
    await chmod(this.wrapperPath, 0o755);
    const settingsChanged = await editSettings(this.settingsPath, (current) => withScoutClaudeHooks(current, this.command));

    if (this.options.managedInstalls !== false) {
      await upsertManagedInstall({
        kind: "hook", owner: "openscout", name: "claude-permission-request",
        title: "Claude Code permission requests answered from Scout",
        status: "active", harness: "claude", provider: "anthropic", targetPath: this.wrapperPath, version: "1",
        uninstall: { strategy: "manual", command: "scout hooks remove", notes: `Removes the ${CLAUDE_PERMISSION_HOOK_EVENT} entry from ${this.settingsPath} and the script.` },
        metadata: { settingsPath: this.settingsPath, event: CLAUDE_PERMISSION_HOOK_EVENT, command: this.command, scoutInvocation: invocation },
      });
    }
    return {
      action: "apply",
      outcome: settingsChanged || previousScript !== script ? "changed" : "unchanged",
      hooks: await this.status(),
    };
  }

  async remove(): Promise<HarnessHooksResult> {
    const gated = this.gate();
    if (gated) return { action: "remove", outcome: "skipped", reason: gated, hooks: await this.status() };
    const settingsChanged = await editSettings(this.settingsPath, (current) => withoutScoutClaudeHooks(current).settings);
    const hadScript = existsSync(this.wrapperPath);
    await rm(this.wrapperPath, { force: true });
    // the hooks folder goes too once nothing else is in it
    await rmdir(dirname(this.wrapperPath)).catch(() => undefined);
    if (this.options.managedInstalls !== false) {
      for (const install of await readManagedInstalls()) {
        if (install.kind === "hook" && install.owner === "openscout" && install.name === "claude-permission-request") {
          await removeManagedInstall(install.id);
        }
      }
    }
    return { action: "remove", outcome: settingsChanged || hadScript ? "changed" : "unchanged", hooks: await this.status() };
  }
}
