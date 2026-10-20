import { existsSync } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { execSystemFile } from "./system-probes/exec.js";

/**
 * Harness-native identity for Claude Code sessions.
 *
 * Claude Code writes one record per live process under
 * `~/.claude/sessions/<pid>.json`. The record is the harness describing
 * itself: its own session id, the cwd it runs in, the tmux pane it was
 * started in (`"tmux": "<session>:@<window>.%<pane>"`), and the `--name` it
 * was launched with. Scout launches every tmux-hosted Claude into a tmux
 * session it named itself, so that record is the correlation key between a
 * Scout endpoint and the harness session it actually runs — evidence written
 * by the harness, not a claim made by a caller.
 */

export type ClaudeTmuxLocation = {
  session: string;
  window: string | null;
  pane: string | null;
};

export type ClaudeSessionRecord = {
  pid: number;
  sessionId: string;
  cwd: string | null;
  startedAt: number | null;
  procStart: string | null;
  kind: string | null;
  entrypoint: string | null;
  version: string | null;
  tmux: ClaudeTmuxLocation | null;
  name: string | null;
  nameSource: string | null;
  status?: "busy" | "idle" | "shell" | "waiting" | null;
  statusUpdatedAt?: number | null;
  updatedAt?: number | null;
  waitingFor?: string | null;
  recordPath: string;
};

export function resolveClaudeConfigDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  if (configured) return configured;
  return join(homedir(), ".claude");
}

export function resolveClaudeSessionRecordsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveClaudeConfigDirectory(env), "sessions");
}

/** Claude Code names a project directory by replacing every non-alphanumeric character in the cwd. */
export function claudeProjectDirectoryForCwd(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveClaudeConfigDirectory(env), "projects", cwd.replace(/[^A-Za-z0-9]/gu, "-"));
}

export function claudeTranscriptPathForSession(
  cwd: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const trimmedCwd = cwd.trim();
  const trimmedSessionId = sessionId.trim();
  if (!trimmedCwd || !trimmedSessionId || !/^[A-Za-z0-9._-]+$/u.test(trimmedSessionId)) return null;
  const path = join(claudeProjectDirectoryForCwd(trimmedCwd, env), `${trimmedSessionId}.jsonl`);
  return existsSync(path) ? path : null;
}

/** `"<session>:@<window>.%<pane>"` as Claude Code records it from $TMUX / $TMUX_PANE. */
export function parseClaudeTmuxLocation(value: unknown): ClaudeTmuxLocation | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const separator = trimmed.indexOf(":");
  if (separator < 0) return { session: trimmed, window: null, pane: null };
  const session = trimmed.slice(0, separator);
  if (!session) return null;
  const rest = trimmed.slice(separator + 1);
  const dot = rest.indexOf(".");
  const window = dot >= 0 ? rest.slice(0, dot) : rest;
  const pane = dot >= 0 ? rest.slice(dot + 1) : "";
  return { session, window: window || null, pane: pane || null };
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseClaudeSessionRecord(raw: string, recordPath: string): ClaudeSessionRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const pid = typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0 ? record.pid : null;
  const sessionId = stringField(record.sessionId);
  if (!pid || !sessionId) return null;
  return {
    pid,
    sessionId,
    cwd: stringField(record.cwd),
    startedAt: numberField(record.startedAt),
    procStart: stringField(record.procStart),
    kind: stringField(record.kind),
    entrypoint: stringField(record.entrypoint),
    version: stringField(record.version),
    tmux: parseClaudeTmuxLocation(record.tmux),
    name: stringField(record.name),
    nameSource: stringField(record.nameSource),
    status: ["busy", "idle", "shell", "waiting"].includes(String(record.status))
      ? record.status as ClaudeSessionRecord["status"] : null,
    statusUpdatedAt: numberField(record.statusUpdatedAt),
    updatedAt: numberField(record.updatedAt),
    waitingFor: typeof record.waitingFor === "string" ? record.waitingFor : null,
    recordPath,
  };
}

/** Bounded reads keep process records and malformed files off the event loop. */
export async function readBoundedClaudeFile(path: string, maxBytes = 64 * 1024): Promise<string | null> {
  let file;
  try {
    file = await open(path, "r");
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return bytesRead > maxBytes ? null : buffer.subarray(0, bytesRead).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    await file?.close();
  }
}

/** Harness-owned identity/status snapshot; also used for exact-native wake discovery. */
export async function readClaudeSessionRecords(options: { directory?: string } = {}): Promise<ClaudeSessionRecord[]> {
  const directory = options.directory ?? resolveClaudeSessionRecordsDirectory();
  let entries;
  try { entries = await opendir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: ClaudeSessionRecord[] = [];
  let count = 0;
  try {
    for await (const entry of entries) {
      if (++count > 1024) throw new Error("Claude session record scan limit exceeded");
      if (!entry.isFile() || !/^\d+\.json$/u.test(entry.name)) continue;
      const path = join(directory, entry.name);
      const raw = await readBoundedClaudeFile(path);
      const record = raw ? parseClaudeSessionRecord(raw, path) : null;
      if (record && `${record.pid}.json` === entry.name) records.push(record);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return records;
}

export type ClaudeLivePane = { session: string; window: string; pane: string; pid: number; procStart: string };
export type ClaudePaneProbe = (tmuxSession: string) => Promise<ClaudeLivePane[]>;

/** Compare both the pane's current process and its birth time: kill(pid, 0) alone permits PID reuse. */
async function probeClaudePanes(tmuxSession: string): Promise<ClaudeLivePane[]> {
  // -u: without a UTF-8 locale (launchd gives the broker none) tmux prints
  // tabs as "_", so every row would fail to split.
  const output = await execSystemFile("tmux", ["-u", "list-panes", "-s", "-t", `=${tmuxSession}`,
    "-F", "#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}"],
    { timeoutMs: 2000, maxStdoutBytes: 16384 });
  const rows = output.stdout.trim().split("\n").filter(Boolean);
  if (rows.length > 32) throw new Error("Claude tmux pane inspection limit exceeded");
  return Promise.all(rows.map(async (row) => {
    const [session, window, pane, rawPid] = row.split("\t");
    const pid = Number(rawPid);
    if (!session || !window || !pane || !Number.isInteger(pid) || pid <= 0) throw new Error("Invalid tmux pane identity");
    const processResult = await execSystemFile("ps", ["-p", String(pid), "-o", "lstart="],
      { timeoutMs: 2000, env: { ...process.env, TZ: "UTC", LC_ALL: "C" }, maxStdoutBytes: 1024 });
    return { session, window, pane, pid, procStart: processResult.stdout.trim() };
  }));
}

function missingTmuxSession(error: unknown): boolean {
  const stderr = (error as { stderr?: unknown })?.stderr;
  return /can't find (?:session|window|pane)|no server running|no sessions/u.test(`${String(error)}\n${typeof stderr === "string" ? stderr : ""}`);
}

function sameProcess(record: ClaudeSessionRecord, pane: ClaudeLivePane): boolean {
  const normalized = (value: string) => value.trim().replace(/\s+/gu, " ");
  return record.pid === pane.pid && record.tmux?.session === pane.session
    && record.tmux.window === pane.window && record.tmux.pane === pane.pane
    && Boolean(record.procStart) && normalized(record.procStart!) === normalized(pane.procStart);
}

export async function observeClaudeSessionForTmuxSession(input: {
  tmuxSession: string; launchName?: string | null; cwd?: string | null;
  directory?: string; probe?: ClaudePaneProbe;
}): Promise<ClaudeTmuxSessionCorrelation> {
  let panes: ClaudeLivePane[];
  try { panes = await (input.probe ?? probeClaudePanes)(input.tmuxSession); } catch (error) {
    if (missingTmuxSession(error)) {
      return { ok: false, reason: "no_live_record", candidates: 0, live: 0 };
    }
    throw error;
  }
  const directory = input.directory ?? resolveClaudeSessionRecordsDirectory();
  const records: ClaudeSessionRecord[] = [];
  for (const pane of panes) {
    const path = join(directory, `${pane.pid}.json`);
    const raw = await readBoundedClaudeFile(path);
    const record = raw ? parseClaudeSessionRecord(raw, path) : null;
    if (record && sameProcess(record, pane)) records.push(record);
  }
  return correlateClaudeSessionForTmuxSession({ ...input, records, isProcessAlive: () => true });
}

export async function findLiveClaudeSession(nativeSessionId: string, options: {
  directory?: string; probe?: ClaudePaneProbe;
} = {}): Promise<ClaudeSessionRecord | null> {
  const matches = (await readClaudeSessionRecords(options)).filter(record => record.sessionId === nativeSessionId);
  for (const record of matches) {
    // A live non-tmux Claude also owns its native session: never start a competing resume.
    if (!record.tmux) {
      try {
        const result = await execSystemFile("ps", ["-p", String(record.pid), "-o", "lstart="],
          { timeoutMs: 2000, env: { ...process.env, TZ: "UTC", LC_ALL: "C" }, maxStdoutBytes: 1024 });
        if (record.procStart && result.stdout.trim().replace(/\s+/gu, " ") === record.procStart.trim().replace(/\s+/gu, " ")) return record;
      } catch (error) {
        if ((error as { exitCode?: number }).exitCode !== 1) throw error;
      }
      continue;
    }
    try {
      const panes = await (options.probe ?? probeClaudePanes)(record.tmux.session);
      if (panes.some(pane => sameProcess(record, pane))) return record;
    } catch (error) {
      // Missing tmux sessions are stale records; timeouts and unavailable probes fail closed.
      if (!missingTmuxSession(error)) throw error;
    }
  }
  return null;
}

export type ClaudeTmuxSessionEvidence = {
  source: "claude-session-record";
  tmuxSession: string;
  tmuxPane: string | null;
  pid: number;
  recordPath: string;
  nameMatched: boolean;
  cwdMatched: boolean;
  liveCandidates: number;
};

export type ClaudeTmuxSessionCorrelation =
  | { ok: true; record: ClaudeSessionRecord; evidence: ClaudeTmuxSessionEvidence }
  | {
      ok: false;
      reason: "no_record" | "no_live_record" | "ambiguous";
      candidates: number;
      live: number;
    };

/**
 * Which live Claude Code process runs in this tmux session, by the harness's
 * own account. The production observer supplies only records whose pane PID
 * and process birth time were verified. Supplied launch name and cwd are hard
 * constraints, including when only one record exists. Ambiguity fails closed.
 */
export function correlateClaudeSessionForTmuxSession(input: {
  tmuxSession: string;
  launchName?: string | null;
  cwd?: string | null;
  records: ClaudeSessionRecord[];
  isProcessAlive?: (pid: number) => boolean;
}): ClaudeTmuxSessionCorrelation {
  const tmuxSession = input.tmuxSession.trim();
  if (!tmuxSession) return { ok: false, reason: "no_record", candidates: 0, live: 0 };
  const records = input.records;
  const candidates = records.filter((record) => record.tmux?.session === tmuxSession);
  if (candidates.length === 0) return { ok: false, reason: "no_record", candidates: 0, live: 0 };
  const alive = input.isProcessAlive ?? (() => false);
  const live = candidates.filter((record) => alive(record.pid));
  if (live.length === 0) {
    return { ok: false, reason: "no_live_record", candidates: candidates.length, live: 0 };
  }
  const launchName = input.launchName?.trim() || null;
  const cwd = input.cwd?.trim() || null;
  const narrowed = live.filter(record => (!launchName || (record.name === launchName && record.nameSource === "user"))
    && (!cwd || record.cwd === cwd) && record.kind === "interactive");
  if (narrowed.length !== 1) {
    return { ok: false, reason: "ambiguous", candidates: candidates.length, live: live.length };
  }
  const record = narrowed[0]!;
  return {
    ok: true,
    record,
    evidence: {
      source: "claude-session-record",
      tmuxSession,
      tmuxPane: record.tmux?.pane ?? null,
      pid: record.pid,
      recordPath: record.recordPath,
      nameMatched: launchName !== null && record.name === launchName,
      cwdMatched: cwd !== null && record.cwd === cwd,
      liveCandidates: live.length,
    },
  };
}

const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/**
 * The model the API actually answered with, from the newest assistant record
 * in the transcript tail. Synthetic placeholders (`<synthetic>`) are not a
 * model. Returns null when the transcript is missing or has no assistant turn
 * in the tail.
 */
export async function readClaudeTranscriptObservedModel(
  transcriptPath: string,
  options: { maxBytes?: number; since?: number } = {},
): Promise<string | null> {
  let file;
  let lines: string[];
  try {
    file = await open(transcriptPath, "r");
    const stat = await file.stat();
    if (!stat.isFile() || stat.size <= 0) return null;
    const maxBytes = Math.min(TRANSCRIPT_TAIL_BYTES, Math.max(1024, options.maxBytes ?? TRANSCRIPT_TAIL_BYTES));
    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(stat.size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (start > 0) lines.shift();
  } catch { return null; } finally { await file?.close(); }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (!line || !line.includes("\"assistant\"")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const record = parsed as Record<string, unknown>;
    if (record.type !== "assistant") continue;
    if (options.since !== undefined) {
      const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
      if (!Number.isFinite(timestamp) || timestamp < options.since) continue;
    }
    const message = record.message;
    if (!message || typeof message !== "object") continue;
    const model = stringField((message as Record<string, unknown>).model);
    if (model && !model.startsWith("<")) return model;
  }
  return null;
}
