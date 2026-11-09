import type { RuntimeEnv } from "../portable-types.js";
import { homedir } from "node:os";
import { join } from "node:path";

import { defineProbeFamily, type ProbeCtx } from "./registry.js";
import { execProbeFile, ProbeCommandError } from "./exec.js";
import { runWithScoutdFallback } from "./scoutd-client.js";
import { resolveOpenScoutHomeForEnv } from "../support-paths.js";

const TMUX_TTL_MS = 5_000;
const TMUX_TIMEOUT_MS = 1_500;
const ZELLIJ_TIMEOUT_MS = 1_500;

export type TmuxSessionInfo = {
  name: string;
  windows: number;
  attached: number;
  createdAt: number | null;
  activityAt: number | null;
  currentCommand: string | null;
  currentPath: string | null;
  /**
   * The active window's name. With tmux's automatic-rename on, this follows the
   * running command; a name a harness or person set stays put.
   */
  windowName?: string | null;
  /**
   * The active pane's title, as a harness or person set it. Null when nobody
   * set one: tmux titles a new pane with the host name, and that is not a title.
   */
  paneTitle?: string | null;
};

export type ZellijSessionInfo = {
  name: string;
  state: "live" | "exited";
  raw: string;
};

export type TmuxPaneDetail = {
  panePid: number;
  paneTty: string;
  paneCurrentPath: string | null;
};

export type TmuxPaneCapture = {
  body: string;
};

type TmuxPaneProbeKey =
  | {
      kind: "detail";
      target: string;
      socketPath?: string | null;
    }
  | {
      kind: "capture";
      target: string;
      start: string;
      end: string;
      joinWrapped?: boolean;
      maxBytes?: number;
      socketPath?: string | null;
    };

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function cleanOptionalString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function splitDelimitedLine(line: string, delimiter: "|" | "\t", fieldCount: number): string[] {
  const parts = line.split(delimiter);
  if (parts.length <= fieldCount) return parts;
  return [...parts.slice(0, fieldCount - 1), parts.slice(fieldCount - 1).join(delimiter)];
}

function parseProcessNumber(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isUnavailable(error: unknown): boolean {
  return error instanceof ProbeCommandError
    && (error.code === "ENOENT" || error.code === "spawn" || error.code === "exit");
}

function tmuxBin(): string {
  return process.env.OPENSCOUT_TMUX_BIN?.trim() || "tmux";
}

function zellijBin(): string {
  return process.env.OPENSCOUT_ZELLIJ_BIN?.trim() || "zellij";
}

function tmuxSocketFromEnv(env: RuntimeEnv): string | null {
  const explicit = env.OPENSCOUT_TMUX_SOCKET?.trim();
  if (explicit) return explicit;
  const tmux = env.TMUX?.trim();
  if (!tmux) return null;
  const [socketPath] = tmux.split(",");
  return socketPath?.trim() || null;
}

export function tmuxSocketKey(input?: string | { env?: RuntimeEnv; socketPath?: string | null } | null): string {
  if (typeof input === "string") return input.trim() || "default";
  const socketPath = input?.socketPath?.trim() || tmuxSocketFromEnv(input?.env ?? process.env);
  return socketPath || "default";
}

function tmuxSocketArgs(key: string): string[] {
  return key === "default" ? [] : ["-S", key];
}

function zellijSocketDirFromEnv(env: RuntimeEnv): string {
  return env.ZELLIJ_SOCKET_DIR?.trim()
    || env.OPENSCOUT_ZELLIJ_SOCKET_DIR?.trim()
    || join(resolveOpenScoutHomeForEnv(env), "zellij-sockets");
}

export function zellijSocketKey(input?: string | { env?: RuntimeEnv; socketDir?: string | null } | null): string {
  if (typeof input === "string") return input.trim() || zellijSocketDirFromEnv(process.env);
  return input?.socketDir?.trim() || zellijSocketDirFromEnv(input?.env ?? process.env);
}

/**
 * One `list-sessions` row per session, tab-delimited because a window name or
 * pane title can hold "|". The pane title is last, so a tab inside it folds
 * back into it. `#{host}` is read only to recognize tmux's default pane title
 * and is never reported. Run it with `-u`: without a UTF-8 locale tmux prints
 * each tab as "_".
 */
export const TMUX_SESSION_LIST_FORMAT = [
  "#{session_name}",
  "#{session_windows}",
  "#{session_attached}",
  "#{session_created}",
  "#{session_activity}",
  "#{pane_current_command}",
  "#{pane_current_path}",
  "#{window_name}",
  "#{host}",
  "#{pane_title}",
].join("\t");

const TMUX_SESSION_FIELD_COUNT = 10;
/** Rows from before window names and titles: seven "|"-delimited fields. */
const LEGACY_TMUX_SESSION_FIELD_COUNT = 7;

function firstHostLabel(value: string): string {
  return value.split(".")[0] ?? value;
}

/**
 * The pane title to report, or null when it is tmux's default. tmux titles a
 * new pane with the host name at the time, so the match ignores case and the
 * domain suffix: a pane titled "box.local" still matches a host that is now
 * "box.lan".
 */
export function reportedTmuxPaneTitle(title: string | undefined, host: string | undefined): string | null {
  const cleaned = cleanOptionalString(title);
  if (!cleaned) return null;
  const hostName = cleanOptionalString(host)?.toLowerCase();
  if (!hostName) return cleaned;
  const lowered = cleaned.toLowerCase();
  if (lowered === hostName) return null;
  const isBareHostName = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/u.test(lowered);
  return isBareHostName && firstHostLabel(lowered) === firstHostLabel(hostName) ? null : cleaned;
}

export function parseTmuxSessionList(output: string): TmuxSessionInfo[] {
  return output
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): TmuxSessionInfo | null => {
      // A tab row is never split on "|": its window name or title may hold one.
      const [name, windows, attached, createdAt, activityAt, currentCommand, currentPath, windowName, host, paneTitle] = line.includes("\t")
        ? splitDelimitedLine(line, "\t", TMUX_SESSION_FIELD_COUNT)
        : splitDelimitedLine(line, "|", LEGACY_TMUX_SESSION_FIELD_COUNT);
      if (!name) return null;
      return {
        name,
        windows: parsePositiveInteger(windows, 1),
        attached: parsePositiveInteger(attached, 0),
        createdAt: createdAt ? Number.parseInt(createdAt, 10) || null : null,
        activityAt: activityAt ? Number.parseInt(activityAt, 10) || null : null,
        currentCommand: cleanOptionalString(currentCommand),
        currentPath: cleanOptionalString(currentPath),
        windowName: cleanOptionalString(windowName),
        paneTitle: reportedTmuxPaneTitle(paneTitle, host),
      };
    })
    .filter((session): session is TmuxSessionInfo => Boolean(session));
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");
}

export function parseZellijSessionList(output: string): ZellijSessionInfo[] {
  return stripAnsi(output)
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name] = line.split(/\s+/u);
      if (!name) return null;
      return {
        name,
        state: /\bEXITED\b/iu.test(line) ? "exited" : "live",
        raw: line,
      } satisfies ZellijSessionInfo;
    })
    .filter((session): session is ZellijSessionInfo => Boolean(session));
}

async function readTmuxSessionsLocal(key: string, ctx: ProbeCtx): Promise<TmuxSessionInfo[]> {
  try {
    const { stdout } = await execProbeFile(ctx, tmuxBin(), [
      "-u", // keep the tabs in the format: tmux prints them as "_" without a UTF-8 locale
      ...tmuxSocketArgs(key),
      "list-sessions",
      "-F",
      TMUX_SESSION_LIST_FORMAT,
    ], {
      maxStdoutBytes: 512 * 1024,
      maxStderrBytes: 64 * 1024,
    });
    return parseTmuxSessionList(stdout);
  } catch (error) {
    if (isUnavailable(error)) return [];
    throw error;
  }
}

export const tmuxSessionsProbe = defineProbeFamily<string | { env?: RuntimeEnv; socketPath?: string | null }, TmuxSessionInfo[]>({
  id: "tmux.sessions",
  ttlMs: TMUX_TTL_MS,
  timeoutMs: TMUX_TIMEOUT_MS,
  maxKeys: 16,
  idleKeyTtlMs: 5 * 60_000,
  maxConcurrentKeys: 2,
  normalizeKey: tmuxSocketKey,
  run: (key, ctx) => runWithScoutdFallback({
    probeId: "tmux.sessions",
    key,
    ctx,
    local: () => readTmuxSessionsLocal(key, ctx),
  }),
});

async function readZellijSessionsLocal(socketDir: string, ctx: ProbeCtx): Promise<ZellijSessionInfo[]> {
  try {
    const { stdout } = await execProbeFile(ctx, zellijBin(), ["list-sessions"], {
      env: { ...process.env, ZELLIJ_SOCKET_DIR: socketDir },
      maxStdoutBytes: 512 * 1024,
      maxStderrBytes: 64 * 1024,
    });
    return parseZellijSessionList(stdout);
  } catch (error) {
    if (isUnavailable(error)) return [];
    throw error;
  }
}

export const zellijSessionsProbe = defineProbeFamily<string | { env?: RuntimeEnv; socketDir?: string | null }, ZellijSessionInfo[]>({
  id: "zellij.sessions",
  ttlMs: TMUX_TTL_MS,
  timeoutMs: ZELLIJ_TIMEOUT_MS,
  maxKeys: 16,
  idleKeyTtlMs: 5 * 60_000,
  maxConcurrentKeys: 2,
  normalizeKey: zellijSocketKey,
  run: (socketDir, ctx) => runWithScoutdFallback({
    probeId: "zellij.sessions",
    key: socketDir,
    ctx,
    local: () => readZellijSessionsLocal(socketDir, ctx),
  }),
});

function normalizeTmuxPaneKey(input: TmuxPaneProbeKey): string {
  const socketPath = tmuxSocketKey(input.socketPath ?? null);
  if (input.kind === "detail") {
    return JSON.stringify({ kind: "detail", socketPath, target: input.target.trim() });
  }
  return JSON.stringify({
    kind: "capture",
    socketPath,
    target: input.target.trim(),
    start: input.start,
    end: input.end,
    joinWrapped: input.joinWrapped !== false,
    maxBytes: input.maxBytes ?? null,
  });
}

function parseTmuxPaneKey(key: string): TmuxPaneProbeKey & { socketPath: string } {
  const parsed = JSON.parse(key) as TmuxPaneProbeKey & { socketPath: string };
  return parsed;
}

export const tmuxPanesProbe = defineProbeFamily<TmuxPaneProbeKey, TmuxPaneDetail | TmuxPaneCapture | null>({
  id: "tmux.panes",
  ttlMs: TMUX_TTL_MS,
  timeoutMs: 1_500,
  maxKeys: 128,
  idleKeyTtlMs: 2 * 60_000,
  maxConcurrentKeys: 4,
  normalizeKey: normalizeTmuxPaneKey,
  run: (key, ctx) => runWithScoutdFallback({
    probeId: "tmux.panes",
    key,
    ctx,
    local: () => readTmuxPaneLocal(key, ctx),
  }),
});

async function readTmuxPaneLocal(key: string, ctx: ProbeCtx): Promise<TmuxPaneDetail | TmuxPaneCapture | null> {
  const parsed = parseTmuxPaneKey(key);
  try {
    if (parsed.kind === "detail") {
      const { stdout } = await execProbeFile(ctx, tmuxBin(), [
        "-u", // keep the tabs below: tmux prints them as "_" without a UTF-8 locale
        ...tmuxSocketArgs(parsed.socketPath),
        "display-message",
        "-p",
        "-t",
        parsed.target,
        "#{pane_pid}\t#{pane_tty}\t#{pane_current_path}",
      ], {
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 64 * 1024,
      });
      const [pidRaw, ttyRaw, pathRaw] = stdout.trim().split("\t");
      const panePid = parseProcessNumber(pidRaw);
      const paneTty = ttyRaw?.replace(/^\/dev\//u, "").trim();
      const paneCurrentPath = pathRaw?.trim() || null;
      return panePid && paneTty ? { panePid, paneTty, paneCurrentPath } : null;
    }

    const { stdout } = await execProbeFile(ctx, tmuxBin(), [
      ...tmuxSocketArgs(parsed.socketPath),
      "capture-pane",
      "-p",
      ...(parsed.joinWrapped === false ? [] : ["-J"]),
      "-t",
      parsed.target,
      "-S",
      parsed.start,
      "-E",
      parsed.end,
    ], {
      maxStdoutBytes: parsed.maxBytes ?? 1024 * 1024,
      maxStderrBytes: 64 * 1024,
    });
    return { body: stdout };
  } catch (error) {
    if (isUnavailable(error)) return null;
    throw error;
  }
}

export async function readTmuxSessionExists(sessionName: string, options: { env?: RuntimeEnv; socketPath?: string | null; maxAgeMs?: number } = {}): Promise<boolean> {
  const name = sessionName.trim();
  if (!name) return false;
  const snapshot = await tmuxSessionsProbe.for({ env: options.env, socketPath: options.socketPath }).fresh({ maxAgeMs: options.maxAgeMs ?? TMUX_TTL_MS });
  return Boolean(snapshot.value?.some((session) => session.name === name));
}

export function readTmuxSessionExistsSnapshot(sessionName: string, options: { env?: RuntimeEnv; socketPath?: string | null } = {}): boolean {
  const name = sessionName.trim();
  if (!name) return false;
  const snapshot = tmuxSessionsProbe.for({ env: options.env, socketPath: options.socketPath }).read();
  return Boolean(snapshot.value?.some((session) => session.name === name));
}

export function invalidateTmuxSessions(options: { env?: RuntimeEnv; socketPath?: string | null; reason?: string } = {}): void {
  tmuxSessionsProbe.invalidate({ env: options.env, socketPath: options.socketPath }, options.reason);
}

export async function readZellijSessionExists(sessionName: string, options: { env?: RuntimeEnv; socketDir?: string | null; maxAgeMs?: number } = {}): Promise<boolean> {
  const name = sessionName.trim();
  if (!name) return false;
  const snapshot = await zellijSessionsProbe.for({ env: options.env, socketDir: options.socketDir }).fresh({ maxAgeMs: options.maxAgeMs ?? TMUX_TTL_MS });
  return Boolean(snapshot.value?.some((session) => session.name === name));
}

export function invalidateZellijSessions(options: { env?: RuntimeEnv; socketDir?: string | null; reason?: string } = {}): void {
  zellijSessionsProbe.invalidate({ env: options.env, socketDir: options.socketDir }, options.reason);
}

export async function readTmuxPaneDetail(target: string, options: { maxAgeMs?: number; socketPath?: string | null } = {}): Promise<TmuxPaneDetail | null> {
  const snapshot = await tmuxPanesProbe.for({ kind: "detail", target, socketPath: options.socketPath }).fresh({ maxAgeMs: options.maxAgeMs ?? TMUX_TTL_MS });
  return snapshot.value && "panePid" in snapshot.value ? snapshot.value : null;
}

export async function captureTmuxPane(target: string, input: {
  start: string;
  end?: string;
  joinWrapped?: boolean;
  maxBytes?: number;
  maxAgeMs?: number;
  socketPath?: string | null;
}): Promise<string | null> {
  const key: TmuxPaneProbeKey = {
    kind: "capture",
    target,
    start: input.start,
    end: input.end ?? "-",
    joinWrapped: input.joinWrapped,
    maxBytes: input.maxBytes,
    socketPath: input.socketPath,
  };
  const snapshot = await tmuxPanesProbe.for(key).fresh({ maxAgeMs: input.maxAgeMs ?? TMUX_TTL_MS });
  return snapshot.value && "body" in snapshot.value ? snapshot.value.body : null;
}
