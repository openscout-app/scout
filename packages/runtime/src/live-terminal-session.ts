import { isRexSurface, rexHarnessPresent, type RexSurface } from "./rex-terminal.js";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";

import type { AgentEndpoint } from "@openscout/protocol";

import { execSystemFile } from "./system-probes/exec.js";

/**
 * A live terminal session is a harness the operator started themselves (a
 * `claude` or `grok` they typed into a terminal). Attaching one gives it a
 * Scout address that delivers INTO that same process — never a background
 * spawn, resume or fork beside it.
 *
 * Two surfaces can take input without touching focus:
 * - a tmux pane (paste-buffer + send-keys), and
 * - a Ghostty terminal surface (AppleScript `input text` + `send key`), by its
 *   stable id. Ghostty does not expose a surface's tty, so attach finds the id
 *   by writing a one-off title marker to the harness tty and reading it back.
 */
export const LIVE_TERMINAL_HARNESSES = ["claude", "grok", "codex", "pi", "kimi", "opencode"] as const;
export type LiveTerminalHarness = (typeof LIVE_TERMINAL_HARNESSES)[number];

type DetectedTerminalSurface =
  | { backend: "tmux"; pane: string; session: string }
  | { backend: "ghostty"; terminalId: string };
export type LiveTerminalSurface = DetectedTerminalSurface | RexSurface;

type HarnessProcess = {
  harness: LiveTerminalHarness;
  pid: number;
  nativeSessionId?: string;
};

type DetectedTerminalSession = HarnessProcess & { surface: DetectedTerminalSurface; tty: string };
/** Rex identifies a launched harness by the process in its block. */
export type LiveTerminalSession = DetectedTerminalSession | (HarnessProcess & { surface: RexSurface; tty?: never });

export type LiveTerminalDetection =
  | { ok: true; session: DetectedTerminalSession }
  | { ok: false; reason: "no_harness" | "no_surface" | "surface_unreadable"; detail: string };

type ProcessRow = { pid: number; ppid: number; tty: string; command: string };

function harnessForCommand(command: string): LiveTerminalHarness | null {
  const name = basename(command.trim().split(/\s+/u)[0] ?? "").toLowerCase();
  return (LIVE_TERMINAL_HARNESSES as readonly string[]).includes(name) ? name as LiveTerminalHarness : null;
}

export function parseProcessRows(output: string): Map<number, ProcessRow> {
  const rows = new Map<number, ProcessRow>();
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u);
    if (!match) continue;
    const pid = Number(match[1]);
    rows.set(pid, { pid, ppid: Number(match[2]), tty: match[3]!, command: match[4]! });
  }
  return rows;
}

/** Walk from `startPid` up the process tree to the nearest harness process. */
export function findHarnessAncestor(rows: Map<number, ProcessRow>, startPid: number): ProcessRow & { harness: LiveTerminalHarness } | null {
  const seen = new Set<number>();
  let current = rows.get(startPid);
  while (current && !seen.has(current.pid) && current.pid > 1) {
    seen.add(current.pid);
    const harness = harnessForCommand(current.command);
    if (harness) return { ...current, harness };
    current = rows.get(current.ppid);
  }
  return null;
}

/** ps prints macOS ttys as `s018`; tmux reports `/dev/ttys018`. */
export function normalizeTty(tty: string): string {
  const bare = tty.trim().replace(/^\/dev\//u, "");
  return /^s\d+$/u.test(bare) ? `tty${bare}` : bare;
}

/** One tmux read for a pane: its tty and owning session, or null when gone. */
async function readTmuxPane(pane: string): Promise<{ tty: string; session: string } | null> {
  const { stdout } = await execSystemFile("tmux", ["display-message", "-p", "-t", pane, "#{pane_tty}|#{session_name}"], {
    timeoutMs: 2_000,
  }).catch(() => ({ stdout: "" }));
  const line = stdout.trim();
  const split = line.indexOf("|");
  if (split <= 0 || split === line.length - 1) return null;
  return { tty: normalizeTty(line.slice(0, split)), session: line.slice(split + 1) };
}

export function appleScriptString(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"")}"`;
}

async function runAppleScript(lines: string[], timeoutMs = 5_000): Promise<string> {
  const { stdout } = await execSystemFile("osascript", lines.flatMap((line) => ["-e", line]), { timeoutMs });
  return stdout.trim();
}

/**
 * Find the Ghostty terminal surface showing `tty`: set a unique window title
 * on that tty (an OSC 2 sequence, invisible), look the marker up among
 * Ghostty terminals, then put the previous title back.
 */
export async function findGhosttyTerminalForTty(tty: string): Promise<string | null> {
  const marker = `scout-attach-${process.pid}-${Date.now().toString(36)}`;
  const device = `/dev/${normalizeTty(tty)}`;
  const titles = await runAppleScript([
    "tell application \"Ghostty\"",
    "set out to \"\"",
    "repeat with t in terminals",
    "set out to out & (id of t) & tab & (name of t) & linefeed",
    "end repeat",
    "return out",
    "end tell",
  ]).catch(() => null);
  if (titles === null) return null;

  try {
    await writeFile(device, `\u001b]2;${marker}\u0007`);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = await runAppleScript([
        `tell application "Ghostty" to get id of (first terminal whose name is ${appleScriptString(marker)})`,
      ]).catch(() => "");
      if (id) {
        const priorTitle = titles.split("\n").map((row) => row.split("\t")).find(([rowId]) => rowId === id)?.[1];
        if (priorTitle) await writeFile(device, `\u001b]2;${priorTitle}\u0007`).catch(() => undefined);
        return id;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  } catch {
    return null;
  }
}

async function ghosttyTerminalExists(terminalId: string): Promise<boolean> {
  const out = await runAppleScript([
    `tell application "Ghostty" to exists terminal id ${appleScriptString(terminalId)}`,
  ]).catch(() => "false");
  return out === "true";
}

/** Paste `text` into a Ghostty terminal surface and press Enter, by id, without focusing it. */
export async function sendGhosttyPrompt(terminalId: string, text: string): Promise<void> {
  await runAppleScript([
    "tell application \"Ghostty\"",
    `set t to terminal id ${appleScriptString(terminalId)}`,
    `input text ${appleScriptString(text)} to t`,
    "delay 0.15",
    "send key \"enter\" to t",
    "end tell",
  ], 10_000);
}

export async function detectCurrentLiveTerminalSession(input: {
  env?: NodeJS.ProcessEnv;
  pid?: number;
} = {}): Promise<LiveTerminalDetection> {
  const env = input.env ?? process.env;
  const { stdout } = await execSystemFile("ps", ["-axo", "pid=,ppid=,tty=,command="], {
    timeoutMs: 3_000,
    maxStdoutBytes: 4 * 1024 * 1024,
  });
  const harness = findHarnessAncestor(parseProcessRows(stdout), input.pid ?? process.pid);
  if (!harness) {
    return { ok: false, reason: "no_harness", detail: "no claude, grok, codex, pi, kimi or opencode process above this one" };
  }
  const tty = normalizeTty(harness.tty);
  const nativeSessionId = harness.harness === "claude"
    ? env.CLAUDE_CODE_SESSION_ID?.trim() || env.CLAUDE_SESSION_ID?.trim() || undefined
    : undefined;
  const base = { harness: harness.harness, pid: harness.pid, tty, ...(nativeSessionId ? { nativeSessionId } : {}) };

  const tmuxPane = env.TMUX_PANE?.trim();
  if (tmuxPane) {
    const pane = await readTmuxPane(tmuxPane);
    if (!pane || pane.tty !== tty) {
      return {
        ok: false,
        reason: "surface_unreadable",
        detail: `tmux pane ${tmuxPane} could not be matched to ${harness.harness} (pid ${harness.pid}, ${tty}).`,
      };
    }
    return { ok: true, session: { ...base, surface: { backend: "tmux", pane: tmuxPane, session: pane.session } } };
  }

  if (env.TERM_PROGRAM?.trim().toLowerCase() === "ghostty" && process.platform === "darwin") {
    const terminalId = await findGhosttyTerminalForTty(tty);
    if (!terminalId) {
      return {
        ok: false,
        reason: "surface_unreadable",
        detail: `could not find the Ghostty terminal showing ${harness.harness} (${tty}); Ghostty scripting may be off or not permitted.`,
      };
    }
    return { ok: true, session: { ...base, surface: { backend: "ghostty", terminalId } } };
  }

  return {
    ok: false,
    reason: "no_surface",
    detail: `${harness.harness} is running in ${env.TERM_PROGRAM?.trim() || "a terminal"} outside tmux, `
      + "and Scout can only deliver into tmux panes and Ghostty terminals.",
  };
}

export function isAttachedLiveTerminalEndpoint(endpoint: AgentEndpoint): boolean {
  if (endpoint.metadata?.attachedLive !== true) return false;
  if (endpoint.transport === "rex") return isRexSurface(endpoint.metadata.terminalSurface);
  if (endpoint.transport === "tmux") return typeof endpoint.pane === "string" && endpoint.pane.trim().length > 0;
  if (endpoint.transport === "ghostty") return typeof endpoint.metadata?.ghosttyTerminalId === "string";
  return false;
}

/** Where an attached endpoint delivers, for messages: "tmux pane %3" / "Ghostty terminal 76495F47". */
export function describeAttachedLiveTerminal(endpoint: AgentEndpoint): string {
  if (endpoint.transport === "rex") return `Rex block ${endpoint.sessionId}`;
  return endpoint.transport === "ghostty"
    ? `Ghostty terminal ${String(endpoint.metadata?.ghosttyTerminalId ?? "").slice(0, 8)}`
    : `tmux pane ${endpoint.pane}`;
}

function livePid(endpoint: AgentEndpoint): number | null {
  const pid = Number(endpoint.metadata?.livePid);
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Cheap synchronous check: the attached harness process still exists. */
export function isAttachedLiveTerminalEndpointAliveSnapshot(endpoint: AgentEndpoint): boolean {
  const pid = livePid(endpoint);
  return endpoint.state !== "offline" && pid !== null && processAlive(pid);
}

/**
 * Full check: the attached harness process is still running and its surface
 * (tmux pane on the same tty, or Ghostty terminal id) still exists.
 */
export async function isAttachedLiveTerminalEndpointAlive(endpoint: AgentEndpoint): Promise<boolean> {
  const pid = livePid(endpoint);
  if (!pid || !processAlive(pid)) return false;
  if (endpoint.transport === "rex") {
    const surface = endpoint.metadata?.terminalSurface;
    return isRexSurface(surface) && rexHarnessPresent(surface, pid, String(endpoint.harness));
  }
  if (endpoint.transport === "ghostty") {
    const terminalId = endpoint.metadata?.ghosttyTerminalId;
    return typeof terminalId === "string" && await ghosttyTerminalExists(terminalId);
  }
  if (!endpoint.pane) return false;
  const pane = await readTmuxPane(endpoint.pane);
  return Boolean(pane && pane.tty === endpoint.metadata?.liveTty);
}

export type LiveHarnessProcess = {
  pid: number;
  harness: LiveTerminalHarness;
  tty: string;
  cwd: string;
  /** The harness's own resumable session id. */
  sessionId: string;
};

async function readJsonFile(path: string): Promise<unknown> {
  const { readFile } = await import("node:fs/promises");
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function readProcessRow(pid: number): Promise<ProcessRow | null> {
  const { stdout } = await execSystemFile("ps", ["-o", "pid=,ppid=,tty=,command=", "-p", String(pid)], {
    timeoutMs: 3_000,
  }).catch(() => ({ stdout: "" }));
  return parseProcessRows(stdout).get(pid) ?? null;
}

/**
 * Map a running harness pid to the session it is writing, from the harness's
 * own live-process registry: `~/.claude/sessions/<pid>.json` for Claude and
 * `~/.grok/active_sessions.json` for Grok.
 */
export async function resolveLiveHarnessProcess(
  pid: number,
  options: { env?: NodeJS.ProcessEnv; home?: string } = {},
): Promise<{ ok: true; process: LiveHarnessProcess } | { ok: false; detail: string }> {
  const env = options.env ?? process.env;
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const home = options.home ?? homedir();
  const row = await readProcessRow(pid);
  if (!row) return { ok: false, detail: `no process ${pid}` };
  const harness = harnessForCommand(row.command);
  if (!harness) return { ok: false, detail: `process ${pid} (${row.command.slice(0, 60)}) is not a known harness` };
  const tty = normalizeTty(row.tty);

  if (harness === "claude") {
    const configDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
    const record = await readJsonFile(join(configDir, "sessions", `${pid}.json`)) as { sessionId?: unknown; cwd?: unknown } | null;
    if (typeof record?.sessionId === "string" && typeof record.cwd === "string") {
      return { ok: true, process: { pid, harness, tty, cwd: record.cwd, sessionId: record.sessionId } };
    }
    return { ok: false, detail: `Claude has no live session record for pid ${pid}` };
  }

  if (harness === "grok") {
    const active = await readJsonFile(join(home, ".grok", "active_sessions.json"));
    const entry = Array.isArray(active)
      ? active.find((candidate) => (candidate as { pid?: unknown })?.pid === pid) as { session_id?: unknown; cwd?: unknown } | undefined
      : undefined;
    if (typeof entry?.session_id === "string" && typeof entry.cwd === "string") {
      return { ok: true, process: { pid, harness, tty, cwd: entry.cwd, sessionId: entry.session_id } };
    }
    return { ok: false, detail: `Grok has no active session entry for pid ${pid}` };
  }

  return { ok: false, detail: `transfer does not know where ${harness} records its live session yet` };
}

/** The harness process running on `tty`, if any (e.g. inside a fresh tmux pane). */
export async function findHarnessOnTty(tty: string, harness: LiveTerminalHarness): Promise<number | null> {
  const { stdout } = await execSystemFile("ps", ["-axo", "pid=,ppid=,tty=,command="], {
    timeoutMs: 3_000,
    maxStdoutBytes: 4 * 1024 * 1024,
  });
  const wanted = normalizeTty(tty);
  for (const row of parseProcessRows(stdout).values()) {
    if (normalizeTty(row.tty) === wanted && harnessForCommand(row.command) === harness) return row.pid;
  }
  return null;
}

/** SIGTERM `pid` and wait for it to exit. Never escalates to SIGKILL. */
export async function stopProcessGracefully(pid: number, timeoutMs = 15_000): Promise<boolean> {
  if (!processAlive(pid)) return true;
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return !processAlive(pid);
}
