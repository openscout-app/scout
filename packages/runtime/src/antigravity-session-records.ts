import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveOpenScoutSupportPaths } from "./support-paths.js";

/**
 * Lightweight local session-status records written by Scout's non-blocking
 * Antigravity lifecycle hook (`scout permission-hook antigravity`).
 *
 * Antigravity runs `PreToolUse` right before a tool step executes (including
 * before showing its sandbox-bypass or file-access confirmation dialog, or
 * before `ask_question` blocks on user input), and runs `PostToolUse` / `Stop`
 * as soon as the step finishes or the loop ends. Recording that window lets
 * Scout surface live Antigravity approvals and questions without delaying or
 * double-prompting Antigravity's own UI.
 */

const SESSION_UUID_RE = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu;
const MAX_RECORD_BYTES = 64 * 1024;
/** Ignore abandoned waiting markers if an Antigravity process crashed mid-prompt. */
export const ANTIGRAVITY_WAITING_TTL_MS = 2 * 60 * 60_000;

export type AntigravitySessionRecordToolCall = {
  id: string | null;
  name: string;
  args: Record<string, unknown>;
};

export type AntigravitySessionRecord = {
  sessionId: string;
  cwd: string | null;
  transcriptPath: string | null;
  status: "waiting" | "busy" | "idle";
  waitingFor: string | null;
  statusUpdatedAt: number;
  toolCall: AntigravitySessionRecordToolCall | null;
  recordPath: string;
};

export function resolveAntigravitySessionRecordsDirectory(): string {
  const override = process.env.OPENSCOUT_ANTIGRAVITY_SESSIONS_DIR?.trim();
  if (override) return override;
  return join(resolveOpenScoutSupportPaths().runtimeDirectory, "antigravity-sessions");
}

export function isValidAntigravitySessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_UUID_RE.test(value.trim());
}

export function parseAntigravitySessionRecord(
  raw: string,
  recordPath: string,
  now = Date.now(),
): AntigravitySessionRecord | null {
  if (!raw || raw.length > MAX_RECORD_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const sessionId = typeof obj.sessionId === "string" ? obj.sessionId.trim() : "";
  if (!isValidAntigravitySessionId(sessionId)) return null;
  const status = obj.status === "waiting" || obj.status === "busy" || obj.status === "idle"
    ? obj.status
    : null;
  if (!status) return null;
  const statusUpdatedAt = typeof obj.statusUpdatedAt === "number" && Number.isFinite(obj.statusUpdatedAt)
    ? obj.statusUpdatedAt
    : 0;
  if (status === "waiting" && (statusUpdatedAt <= 0 || now - statusUpdatedAt > ANTIGRAVITY_WAITING_TTL_MS)) {
    return null;
  }
  const rawTool = obj.toolCall && typeof obj.toolCall === "object" && !Array.isArray(obj.toolCall)
    ? obj.toolCall as Record<string, unknown>
    : null;
  const toolCall: AntigravitySessionRecordToolCall | null = rawTool && typeof rawTool.name === "string" && rawTool.name.trim()
    ? {
      id: typeof rawTool.id === "string" && rawTool.id.trim() ? rawTool.id.trim() : null,
      name: rawTool.name.trim(),
      args: rawTool.args && typeof rawTool.args === "object" && !Array.isArray(rawTool.args)
        ? rawTool.args as Record<string, unknown>
        : {},
    }
    : null;

  return {
    sessionId,
    cwd: typeof obj.cwd === "string" && obj.cwd.trim() ? obj.cwd.trim() : null,
    transcriptPath: typeof obj.transcriptPath === "string" && obj.transcriptPath.trim() ? obj.transcriptPath.trim() : null,
    status,
    waitingFor: status === "waiting" && typeof obj.waitingFor === "string" && obj.waitingFor.trim()
      ? obj.waitingFor.trim()
      : null,
    statusUpdatedAt,
    toolCall: status === "waiting" ? toolCall : null,
    recordPath,
  };
}

export async function writeAntigravitySessionRecord(
  record: Omit<AntigravitySessionRecord, "recordPath">,
  options: { directory?: string } = {},
): Promise<string> {
  if (!isValidAntigravitySessionId(record.sessionId)) {
    throw new Error("Invalid Antigravity sessionId");
  }
  const directory = options.directory ?? resolveAntigravitySessionRecordsDirectory();
  await mkdir(directory, { recursive: true });
  const target = join(directory, `${record.sessionId}.json`);
  const temp = join(directory, `.${record.sessionId}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temp, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, target);
  return target;
}

export async function removeAntigravitySessionRecord(
  sessionId: string,
  options: { directory?: string } = {},
): Promise<void> {
  if (!isValidAntigravitySessionId(sessionId)) return;
  const directory = options.directory ?? resolveAntigravitySessionRecordsDirectory();
  await rm(join(directory, `${sessionId.trim()}.json`), { force: true }).catch(() => undefined);
}

export async function readAntigravitySessionRecords(
  options: { directory?: string; now?: number } = {},
): Promise<AntigravitySessionRecord[]> {
  const directory = options.directory ?? resolveAntigravitySessionRecordsDirectory();
  const now = options.now ?? Date.now();
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }
  const records = await Promise.all(entries.map(async (entry) => {
    if (!entry.endsWith(".json") || entry.startsWith(".")) return null;
    const recordPath = join(directory, entry);
    try {
      const raw = await readFile(recordPath, "utf8");
      return parseAntigravitySessionRecord(raw, recordPath, now);
    } catch {
      return null;
    }
  }));
  return records.filter((record): record is AntigravitySessionRecord => record !== null);
}
