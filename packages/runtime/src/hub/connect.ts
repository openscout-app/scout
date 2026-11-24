/**
 * `scout hub connect claude-code`: put the reporter into a repo so that every
 * Claude Code cloud session of that repo reports to this runtime's inbox.
 *
 * Writes, for the person to review and commit:
 *   .claude/scout/report.mjs  the reporter, byte for byte REPORTER_SOURCE
 *   .claude/scout/hub.json    inbox URL, write-only token, this runtime's public key, label
 *   .claude/settings.json     hooks that run the reporter only when CLAUDE_CODE_REMOTE=true
 * Other hooks and settings in .claude/settings.json are left as they are.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { REPORTER_SOURCE, REPORTER_VERSION } from "./reporter-source.js";
import type { HubConfig } from "./state.js";

export const REPORTER_RELATIVE_PATH = ".claude/scout/report.mjs";
const MARKER = REPORTER_RELATIVE_PATH;

const HOOKS: Array<{ event: string; args: string }> = [
  { event: "PostToolUse", args: "flush" },
  { event: "SubagentStop", args: "flush" },
  { event: "Stop", args: "flush --wait" },
  { event: "SessionEnd", args: "flush --wait" },
];

export function reporterCommand(args: string): string {
  return `[ "$CLAUDE_CODE_REMOTE" = true ] && node "$CLAUDE_PROJECT_DIR/${REPORTER_RELATIVE_PATH}" ${args} || true`;
}

export function reporterSha256(): string {
  return createHash("sha256").update(REPORTER_SOURCE).digest("hex");
}

export function defaultLabelForRepo(repoRoot: string): string {
  const cleaned = basename(repoRoot).replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^[.-]+/u, "").slice(0, 100);
  return cleaned || "repo";
}

type HookGroup = { matcher?: string; hooks?: Array<{ type?: string; command?: string }> };
type Settings = { hooks?: Record<string, HookGroup[]>; [key: string]: unknown };

function isScoutGroup(group: HookGroup): boolean {
  return Array.isArray(group?.hooks) && group.hooks.some((hook) => typeof hook?.command === "string" && hook.command.includes(MARKER));
}

function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Settings;
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix it, then run connect again.`);
  }
}

function withoutScoutHooks(settings: Settings): Settings {
  if (!settings.hooks) return settings;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = Array.isArray(groups) ? groups.filter((group) => !isScoutGroup(group)) : groups;
    if (!Array.isArray(kept) || kept.length > 0) hooks[event] = kept;
  }
  const next: Settings = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

function writeIfChanged(path: string, content: string, changed: string[], label: string): void {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return;
  writeFileSync(path, content);
  changed.push(label);
}

export type ConnectClaudeCodeResult = {
  repoRoot: string;
  label: string;
  inbox: string;
  reporterVersion: number;
  reporterSha256: string;
  files: { reporter: string; config: string; settings: string };
  changed: string[];
};

export function connectClaudeCode(input: {
  repoRoot: string;
  config: HubConfig;
  recipientPublicKey: Uint8Array;
  label?: string;
}): ConnectClaudeCodeResult {
  const { repoRoot, config } = input;
  if (!existsSync(join(repoRoot, ".git"))) throw new Error(`${repoRoot} is not the root of a git repository.`);
  const label = input.label ?? defaultLabelForRepo(repoRoot);
  if (!/^[A-Za-z0-9._-]{1,100}$/u.test(label) || label === "." || label === "..") {
    throw new Error("The label must be 1 to 100 letters, digits, dots, dashes or underscores.");
  }
  const scoutDir = join(repoRoot, ".claude", "scout");
  mkdirSync(scoutDir, { recursive: true });
  const files = {
    reporter: join(repoRoot, REPORTER_RELATIVE_PATH),
    config: join(scoutDir, "hub.json"),
    settings: join(repoRoot, ".claude", "settings.json"),
  };
  const changed: string[] = [];
  const sha256 = reporterSha256();
  writeIfChanged(files.reporter, REPORTER_SOURCE, changed, ".claude/scout/report.mjs");
  writeIfChanged(files.config, `${JSON.stringify({
    v: 1,
    inbox: config.inbox,
    token: config.writeToken,
    recipient: Buffer.from(input.recipientPublicKey).toString("base64url"),
    label,
    reporter: { version: REPORTER_VERSION, sha256 },
  }, null, 2)}\n`, changed, ".claude/scout/hub.json");

  const settings = withoutScoutHooks(readSettings(files.settings));
  const hooks = { ...(settings.hooks ?? {}) };
  for (const { event, args } of HOOKS) {
    hooks[event] = [...(hooks[event] ?? []), { hooks: [{ type: "command", command: reporterCommand(args) }] }];
  }
  writeIfChanged(files.settings, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`, changed, ".claude/settings.json");
  return { repoRoot, label, inbox: config.inbox, reporterVersion: REPORTER_VERSION, reporterSha256: sha256, files, changed };
}

export function disconnectClaudeCode(repoRoot: string): { changed: string[] } {
  const changed: string[] = [];
  const settingsPath = join(repoRoot, ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    const before = readSettings(settingsPath);
    const after = withoutScoutHooks(before);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      writeFileSync(settingsPath, `${JSON.stringify(after, null, 2)}\n`);
      changed.push(".claude/settings.json");
    }
  }
  const scoutDir = join(repoRoot, ".claude", "scout");
  for (const name of ["report.mjs", "hub.json"]) {
    const path = join(scoutDir, name);
    if (existsSync(path)) { rmSync(path); changed.push(`.claude/scout/${name}`); }
  }
  try { rmdirSync(scoutDir); } catch { /* not empty or gone */ }
  return { changed };
}
