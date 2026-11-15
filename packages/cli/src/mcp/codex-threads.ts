/**
 * Which Codex thread made an MCP call, and where it works.
 *
 * One Codex app-server runs many threads, so a connection's process says
 * nothing about the thread. Codex opens one MCP session per thread and puts
 * the thread on every `tools/call`: `_meta.threadId`, and the same id in
 * `_meta["x-codex-turn-metadata"].thread_id` with the turn id (seen on
 * codex-cli 0.169). The thread's folder is in its rollout file,
 * `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`:
 * `session_meta` on the first line, and a `turn_context` with the turn's
 * `cwd` at the start of every turn.
 */
import { join } from "node:path";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAIL_BYTES = 256 * 1024;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function threadIdValue(value: unknown): string | null {
  return typeof value === "string" && THREAD_ID.test(value) ? value.toLowerCase() : null;
}

/** The Codex thread named in a request's `_meta`, if any. */
export function codexThreadIdFromMeta(meta: unknown): string | null {
  const fields = record(meta);
  if (!fields) return null;
  return threadIdValue(fields.threadId) ?? threadIdValue(record(fields["x-codex-turn-metadata"])?.thread_id);
}

/** The Codex turn named in a request's `_meta`, if any. */
export function codexTurnIdFromMeta(meta: unknown): string | null {
  const turnId = record(record(meta)?.["x-codex-turn-metadata"])?.turn_id;
  return typeof turnId === "string" && turnId ? turnId : null;
}

/** Milliseconds encoded in a UUIDv7, or null for another version. */
export function uuidV7Time(id: string): number | null {
  if (!THREAD_ID.test(id) || id[14] !== "7") return null;
  return Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}

function localDay(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

/**
 * The rollout file of a thread. Codex files rollouts by the local date the
 * thread started, which a UUIDv7 thread id encodes; the day either side
 * covers a clock or zone change. Ephemeral threads have no rollout.
 */
export async function findCodexRollout(threadId: string, codexHome: string): Promise<string | null> {
  const time = uuidV7Time(threadId);
  if (time === null) return null;
  const sessions = join(codexHome, "sessions");
  const pattern = new Bun.Glob(`rollout-*-${threadId}.jsonl`);
  const days = [...new Set([time, time - 86_400_000, time + 86_400_000].map(localDay))];
  for (const day of days) {
    const directory = join(sessions, day);
    try {
      for await (const name of pattern.scan({ cwd: directory, onlyFiles: true })) return join(directory, name);
    } catch {
      // No rollouts that day.
    }
  }
  return null;
}

function cwdOf(line: string, type: string): string | null {
  if (!line.includes(`"type":"${type}"`)) return null;
  try {
    const cwd = record(record(JSON.parse(line))?.payload)?.cwd;
    return typeof cwd === "string" && cwd ? cwd : null;
  } catch {
    return null;
  }
}

/** The folder of a thread's latest turn, else the folder it started in. */
export async function readCodexRolloutCwd(path: string): Promise<string | null> {
  const file = Bun.file(path);
  try {
    const size = file.size;
    const tail = (await file.slice(Math.max(0, size - TAIL_BYTES), size).text()).split("\n");
    for (let index = tail.length - 1; index >= 0; index -= 1) {
      const cwd = cwdOf(tail[index]!, "turn_context");
      if (cwd) return cwd;
    }
    const first = (await file.slice(0, Math.min(size, TAIL_BYTES)).text()).split("\n", 1)[0] ?? "";
    return cwdOf(first, "session_meta");
  } catch {
    return null;
  }
}
