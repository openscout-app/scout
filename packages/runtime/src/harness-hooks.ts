import { chmod, lstat, mkdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { resolveAntigravitySessionRecordsDirectory } from "./antigravity-session-records.js";
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
 * Scout.
 *
 * Antigravity: one named `openscout` entry in `~/.gemini/config/hooks.json`
 * (`PreToolUse`, `PostToolUse`, `Stop`) running a non-blocking Scout wrapper
 * script so questions and approval gates in native Antigravity sessions show up
 * in Scout immediately without blocking Antigravity's own UI.
 */

export const CLAUDE_PERMISSION_HOOK_EVENT = "PermissionRequest" as const;
export const CLAUDE_PERMISSION_HOOK_WRAPPER = "openscout-claude-permission-request.sh";

export const ANTIGRAVITY_HOOK_EVENT = "PreToolUse/PostToolUse/Stop" as const;
export const ANTIGRAVITY_HOOK_NAME = "openscout" as const;
export const ANTIGRAVITY_HOOK_MATCHER = "ask_question|run_command|write_file|edit_file|read_file" as const;
export const ANTIGRAVITY_PERMISSION_HOOK_WRAPPER = "openscout-antigravity-permission-hook.sh";

export type HarnessHookTarget = "claude" | "antigravity";
export type HarnessHookState = "applied" | "absent" | "stale";

export type HarnessHookStatus = {
  harness: HarnessHookTarget;
  hook: "permission-request" | "session-attention";
  event: typeof CLAUDE_PERMISSION_HOOK_EVENT | typeof ANTIGRAVITY_HOOK_EVENT;
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
  antigravityHooksPath?: string;
  antigravityWrapperPath?: string;
  antigravitySessionsDir?: string;
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

export function resolveAntigravityHooksPath(): string {
  return join(process.env.HOME?.trim() || homedir(), ".gemini", "config", "hooks.json");
}

export function resolveAntigravityPermissionHookWrapperPath(): string {
  return join(resolveOpenScoutSupportPaths().runtimeDirectory, "hooks", ANTIGRAVITY_PERMISSION_HOOK_WRAPPER);
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** An entry Scout wrote: its wrapper, or the bare CLI command from before there was one. */
export function isScoutClaudeHookCommand(command: string): boolean {
  return command.includes(CLAUDE_PERMISSION_HOOK_WRAPPER) || /\bpermission-hook\s+claude\b/.test(command);
}

export function isScoutAntigravityHookCommand(command: string): boolean {
  return command.includes(ANTIGRAVITY_PERMISSION_HOOK_WRAPPER) || /\bpermission-hook\s+antigravity\b/.test(command);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function commandOf(entry: unknown): string | null {
  return isRecord(entry) && typeof entry.command === "string" ? entry.command : null;
}

/** Every Scout hook command in the Claude settings, across every event. */
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

/** Every distinct Scout hook command in Antigravity's `hooks.json`. */
export function scoutAntigravityHookCommands(hooksFile: Settings): string[] {
  const found = new Set<string>();
  for (const [name, spec] of Object.entries(hooksFile)) {
    if (!isRecord(spec)) continue;
    for (const eventValue of Object.values(spec)) {
      if (!Array.isArray(eventValue)) continue;
      for (const item of eventValue) {
        const directCommand = commandOf(item);
        if (directCommand && (name === ANTIGRAVITY_HOOK_NAME || isScoutAntigravityHookCommand(directCommand))) {
          found.add(directCommand);
          continue;
        }
        if (isRecord(item) && Array.isArray(item.hooks)) {
          for (const handler of item.hooks) {
            const cmd = commandOf(handler);
            if (cmd && (name === ANTIGRAVITY_HOOK_NAME || isScoutAntigravityHookCommand(cmd))) {
              found.add(cmd);
            }
          }
        }
      }
    }
  }
  return [...found];
}

function expectedAntigravityHookEntry(command: string): Record<string, unknown> {
  return {
    PreToolUse: [{ matcher: ANTIGRAVITY_HOOK_MATCHER, hooks: [{ type: "command", command, timeout: 10 }] }],
    PostToolUse: [{ matcher: ANTIGRAVITY_HOOK_MATCHER, hooks: [{ type: "command", command, timeout: 10 }] }],
    Stop: [{ type: "command", command, timeout: 10 }],
  };
}

function hasExactAntigravityEntry(hooksFile: Settings, command: string): boolean {
  const entry = hooksFile[ANTIGRAVITY_HOOK_NAME];
  if (!isRecord(entry)) return false;
  return JSON.stringify(entry) === JSON.stringify(expectedAntigravityHookEntry(command));
}

export function withoutScoutAntigravityHooks(hooksFile: Settings): { settings: Settings; removed: number } {
  let removed = 0;
  const next: Settings = {};
  for (const [name, spec] of Object.entries(hooksFile)) {
    if (name === ANTIGRAVITY_HOOK_NAME) {
      removed += 1;
      continue;
    }
    if (!isRecord(spec)) {
      next[name] = spec;
      continue;
    }
    let specTouched = false;
    const cleanedSpec: Record<string, unknown> = {};
    for (const [event, items] of Object.entries(spec)) {
      if (!Array.isArray(items)) {
        cleanedSpec[event] = items;
        continue;
      }
      const keptItems: unknown[] = [];
      let eventTouched = false;
      for (const item of items) {
        const direct = commandOf(item);
        if (direct && isScoutAntigravityHookCommand(direct)) {
          removed += 1;
          specTouched = true;
          eventTouched = true;
          continue;
        }
        if (isRecord(item) && Array.isArray(item.hooks)) {
          const keptHandlers = item.hooks.filter((handler) => {
            const cmd = commandOf(handler);
            return !(cmd && isScoutAntigravityHookCommand(cmd));
          });
          const dropped = item.hooks.length - keptHandlers.length;
          if (dropped > 0) {
            removed += dropped;
            specTouched = true;
            eventTouched = true;
            if (keptHandlers.length > 0) keptItems.push({ ...item, hooks: keptHandlers });
            continue;
          }
        }
        keptItems.push(item);
      }
      if (eventTouched && keptItems.length === 0) continue;
      cleanedSpec[event] = keptItems;
    }
    if (specTouched && Object.keys(cleanedSpec).length === 0) continue;
    next[name] = specTouched ? cleanedSpec : spec;
  }
  if (removed === 0) return { settings: hooksFile, removed: 0 };
  return { settings: next, removed };
}

export function withScoutAntigravityHooks(hooksFile: Settings, command: string): Settings {
  const present = scoutAntigravityHookCommands(hooksFile);
  if (present.length === 1 && present[0] === command && hasExactAntigravityEntry(hooksFile, command)) {
    return hooksFile;
  }
  const base = withoutScoutAntigravityHooks(hooksFile).settings;
  return { ...base, [ANTIGRAVITY_HOOK_NAME]: expectedAntigravityHookEntry(command) };
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

export function antigravityPermissionHookWrapper(scoutInvocation: string): string {
  return [
    "#!/bin/sh",
    "# Scout's Antigravity session attention hook. `scout hooks remove` takes it out.",
    `exec ${scoutInvocation} permission-hook antigravity`,
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
 * symlink to the real file. When it changed since `before` was read, nothing
 * is written and the caller starts over.
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

async function editSettings(
  path: string,
  edit: (settings: Settings) => Settings,
  options: { unlinkWhenEmpty?: boolean } = {},
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readSettingsFile(path);
    const next = edit(before.settings);
    if (next === before.settings) return false;
    if (!before.exists && Object.keys(next).length === 0) return false;
    if (options.unlinkWhenEmpty && before.exists && Object.keys(next).length === 0) {
      const linkStat = await lstat(path).catch(() => null);
      if (linkStat && !linkStat.isSymbolicLink()) {
        const current = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (current !== before.text) continue;
        await rm(path, { force: true });
        await rmdir(dirname(path)).catch(() => undefined);
        return true;
      }
    }
    if (await replaceSettingsFile(path, before, next)) return true;
  }
  throw new HarnessHooksError(`${path} kept changing while Scout edited it; try again.`, "settings-busy");
}

/** The script a Scout entry runs, when the entry is a bare (or single-quoted) path to one. */
function wrapperPathOf(command: string, expectedBasename: string): string | null {
  const trimmed = command.trim();
  const quoted = /^'.*'$/s.test(trimmed);
  const raw = quoted ? trimmed.slice(1, -1).replace(/'\\''/g, "'") : trimmed;
  return basename(raw) === expectedBasename && (quoted || !/\s/.test(raw)) ? raw : null;
}

export class HarnessHooks {
  private readonly manageClaude: boolean;
  private readonly manageAntigravity: boolean;
  private readonly settingsPath: string;
  private readonly wrapperPath: string;
  private readonly command: string;
  private readonly antigravityHooksPath: string;
  private readonly antigravityWrapperPath: string;
  private readonly antigravitySessionsDir: string;
  private readonly antigravityCommand: string;

  constructor(private readonly options: HarnessHooksOptions = {}) {
    this.manageClaude = options.settingsPath !== undefined || options.antigravityHooksPath === undefined;
    this.manageAntigravity = options.antigravityHooksPath !== undefined || options.settingsPath === undefined;
    this.settingsPath = options.settingsPath ?? resolveClaudeSettingsPath();
    this.wrapperPath = options.wrapperPath ?? resolveClaudePermissionHookWrapperPath();
    this.command = shellQuote(this.wrapperPath);
    this.antigravityHooksPath = options.antigravityHooksPath ?? resolveAntigravityHooksPath();
    this.antigravityWrapperPath = options.antigravityWrapperPath ?? resolveAntigravityPermissionHookWrapperPath();
    this.antigravitySessionsDir = options.antigravitySessionsDir
      ?? (options.antigravityWrapperPath
        ? join(dirname(dirname(options.antigravityWrapperPath)), "antigravity-sessions")
        : resolveAntigravitySessionRecordsDirectory());
    this.antigravityCommand = shellQuote(this.antigravityWrapperPath);
  }

  async status(harness?: HarnessHookTarget): Promise<HarnessHookStatus[]> {
    const out: HarnessHookStatus[] = [];
    const invocation = this.options.scoutInvocation?.() ?? null;
    const doClaude = this.manageClaude && (!harness || harness === "claude");
    const doAntigravity = this.manageAntigravity && (!harness || harness === "antigravity");

    if (doClaude) {
      const { settings } = await readSettingsFile(this.settingsPath);
      const entries = scoutClaudeHookCommands(settings);
      const base = {
        harness: "claude" as const, hook: "permission-request" as const, event: CLAUDE_PERMISSION_HOOK_EVENT,
        settingsPath: this.settingsPath, wrapperPath: this.wrapperPath, command: this.command, entries,
      };
      if (entries.length === 0) {
        out.push({ ...base, state: "absent" });
      } else {
        const wrapper = await readFile(this.wrapperPath, "utf8").catch(() => null);
        let detail: string | undefined;
        if (entries.length > 1) detail = "Claude settings hold more than one Scout entry.";
        else if (entries[0] !== this.command || !hasPermissionEntry(settings, this.command)) detail = "The Scout entry runs a different command.";
        else if (wrapper === null) detail = "The hook script is missing.";
        else if (invocation && wrapper !== claudePermissionHookWrapper(invocation)) detail = "The hook script starts a different Scout CLI.";
        out.push({ ...base, state: detail ? "stale" : "applied", ...(detail ? { detail } : {}) });
      }
    }

    if (doAntigravity) {
      const { settings } = await readSettingsFile(this.antigravityHooksPath);
      const entries = scoutAntigravityHookCommands(settings);
      const base = {
        harness: "antigravity" as const, hook: "session-attention" as const, event: ANTIGRAVITY_HOOK_EVENT,
        settingsPath: this.antigravityHooksPath, wrapperPath: this.antigravityWrapperPath, command: this.antigravityCommand, entries,
      };
      if (entries.length === 0) {
        out.push({ ...base, state: "absent" });
      } else {
        const wrapper = await readFile(this.antigravityWrapperPath, "utf8").catch(() => null);
        let detail: string | undefined;
        if (entries.length > 1) detail = "Antigravity hooks hold more than one Scout command.";
        else if (entries[0] !== this.antigravityCommand || !hasExactAntigravityEntry(settings, this.antigravityCommand)) {
          detail = "The Scout entry runs a different command or matcher.";
        } else if (wrapper === null) detail = "The hook script is missing.";
        else if (invocation && wrapper !== antigravityPermissionHookWrapper(invocation)) detail = "The hook script starts a different Scout CLI.";
        out.push({ ...base, state: detail ? "stale" : "applied", ...(detail ? { detail } : {}) });
      }
    }

    return out;
  }

  private gate(): HarnessHooksSkipReason | null {
    const instance = this.options.instance ?? resolveOpenScoutInstanceName();
    const override = (this.options.instanceOverride ?? process.env.OPENSCOUT_HOOKS_INSTANCE)?.trim().toLowerCase();
    if (!isProdOpenScoutInstance(instance) && override !== instance) return "non-prod-instance";
    return null;
  }

  async apply(harness?: HarnessHookTarget): Promise<HarnessHooksResult> {
    const doClaude = this.manageClaude && (!harness || harness === "claude");
    const doAntigravity = this.manageAntigravity && (!harness || harness === "antigravity");
    const skip = async (reason: HarnessHooksSkipReason): Promise<HarnessHooksResult> =>
      ({ action: "apply", outcome: "skipped", reason, hooks: await this.status(harness) });
    const gated = this.gate();
    if (gated) return skip(gated);
    if (doClaude && isClaudeStatuslineWrapperIsolatedFromSettings(this.settingsPath, this.wrapperPath)) {
      return skip("isolated-support-directory");
    }
    if (doAntigravity && isClaudeStatuslineWrapperIsolatedFromSettings(this.antigravityHooksPath, this.antigravityWrapperPath)) {
      return skip("isolated-support-directory");
    }
    const invocation = this.options.scoutInvocation?.() ?? null;
    if (!invocation) return skip("scout-cli-not-found");

    if (doClaude) {
      const { settings } = await readSettingsFile(this.settingsPath);
      for (const existing of scoutClaudeHookCommands(settings)) {
        const other = wrapperPathOf(existing, CLAUDE_PERMISSION_HOOK_WRAPPER);
        if (other && other !== this.wrapperPath && existsSync(other)) return skip("owned-by-other-install");
      }
    }
    if (doAntigravity) {
      const { settings } = await readSettingsFile(this.antigravityHooksPath);
      for (const existing of scoutAntigravityHookCommands(settings)) {
        const other = wrapperPathOf(existing, ANTIGRAVITY_PERMISSION_HOOK_WRAPPER);
        if (other && other !== this.antigravityWrapperPath && existsSync(other)) return skip("owned-by-other-install");
      }
    }

    let anyChanged = false;

    if (doClaude) {
      const script = claudePermissionHookWrapper(invocation);
      const previousScript = await readFile(this.wrapperPath, "utf8").catch(() => null);
      if (previousScript !== script) {
        await mkdir(dirname(this.wrapperPath), { recursive: true });
        await writeFile(this.wrapperPath, script, "utf8");
      }
      await chmod(this.wrapperPath, 0o755);
      const settingsChanged = await editSettings(this.settingsPath, (current) => withScoutClaudeHooks(current, this.command));
      if (settingsChanged || previousScript !== script) anyChanged = true;

      if (this.options.managedInstalls !== false) {
        await upsertManagedInstall({
          kind: "hook", owner: "openscout", name: "claude-permission-request",
          title: "Claude Code permission requests answered from Scout",
          status: "active", harness: "claude", provider: "anthropic", targetPath: this.wrapperPath, version: "1",
          uninstall: { strategy: "manual", command: "scout hooks remove claude", notes: `Removes the ${CLAUDE_PERMISSION_HOOK_EVENT} entry from ${this.settingsPath} and the script.` },
          metadata: { settingsPath: this.settingsPath, event: CLAUDE_PERMISSION_HOOK_EVENT, command: this.command, scoutInvocation: invocation },
        });
      }
    }

    if (doAntigravity) {
      const script = antigravityPermissionHookWrapper(invocation);
      const previousScript = await readFile(this.antigravityWrapperPath, "utf8").catch(() => null);
      if (previousScript !== script) {
        await mkdir(dirname(this.antigravityWrapperPath), { recursive: true });
        await writeFile(this.antigravityWrapperPath, script, "utf8");
      }
      await chmod(this.antigravityWrapperPath, 0o755);
      const settingsChanged = await editSettings(this.antigravityHooksPath, (current) => withScoutAntigravityHooks(current, this.antigravityCommand));
      if (settingsChanged || previousScript !== script) anyChanged = true;

      if (this.options.managedInstalls !== false) {
        await upsertManagedInstall({
          kind: "hook", owner: "openscout", name: "antigravity-session-attention",
          title: "Antigravity questions and approval gates surfaced in Scout",
          status: "active", harness: "antigravity", provider: "google", targetPath: this.antigravityWrapperPath, version: "1",
          uninstall: { strategy: "manual", command: "scout hooks remove antigravity", notes: `Removes the ${ANTIGRAVITY_HOOK_NAME} entry from ${this.antigravityHooksPath}, the script, and any session state.` },
          metadata: { settingsPath: this.antigravityHooksPath, event: ANTIGRAVITY_HOOK_EVENT, command: this.antigravityCommand, scoutInvocation: invocation },
        });
      }
    }

    return {
      action: "apply",
      outcome: anyChanged ? "changed" : "unchanged",
      hooks: await this.status(harness),
    };
  }

  async remove(harness?: HarnessHookTarget): Promise<HarnessHooksResult> {
    const doClaude = this.manageClaude && (!harness || harness === "claude");
    const doAntigravity = this.manageAntigravity && (!harness || harness === "antigravity");
    const gated = this.gate();
    if (gated) return { action: "remove", outcome: "skipped", reason: gated, hooks: await this.status(harness) };
    let anyChanged = false;

    if (doClaude) {
      const settingsChanged = await editSettings(this.settingsPath, (current) => withoutScoutClaudeHooks(current).settings);
      const hadScript = existsSync(this.wrapperPath);
      await rm(this.wrapperPath, { force: true });
      await rmdir(dirname(this.wrapperPath)).catch(() => undefined);
      if (settingsChanged || hadScript) anyChanged = true;
    }

    if (doAntigravity) {
      const settingsChanged = await editSettings(
        this.antigravityHooksPath,
        (current) => withoutScoutAntigravityHooks(current).settings,
        { unlinkWhenEmpty: true },
      );
      const hadScript = existsSync(this.antigravityWrapperPath);
      const hadSessionsDir = existsSync(this.antigravitySessionsDir);
      await rm(this.antigravityWrapperPath, { force: true });
      await rmdir(dirname(this.antigravityWrapperPath)).catch(() => undefined);
      await rm(this.antigravitySessionsDir, { recursive: true, force: true });
      if (settingsChanged || hadScript || hadSessionsDir) anyChanged = true;
    }

    if (this.options.managedInstalls !== false) {
      for (const install of await readManagedInstalls()) {
        if (
          install.kind === "hook"
          && install.owner === "openscout"
          && (
            (doClaude && install.name === "claude-permission-request")
            || (doAntigravity && install.name === "antigravity-session-attention")
          )
        ) {
          await removeManagedInstall(install.id);
        }
      }
    }
    return { action: "remove", outcome: anyChanged ? "changed" : "unchanged", hooks: await this.status(harness) };
  }
}
