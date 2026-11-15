import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import {
  buildParentChain,
  classifyAttribution,
  commandBasename,
  listProcesses,
  processResourceFields,
  readCwd,
  type RawProcess,
} from "./discover.js";
import type {
  DiscoveredProcess,
  DiscoveredTranscript,
  TailContext,
  TailDiscoveryScope,
  TailEvent,
  TranscriptSource,
} from "./types.js";

const SOURCE_NAME = "cursor";
const MAX_SUMMARY_LEN = 200;
const DEFAULT_HOT_DISCOVERY_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_SHALLOW_DISCOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DEEP_DISCOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HOT_DISCOVERY_LIMIT = 32;
const DEFAULT_SHALLOW_DISCOVERY_LIMIT = 80;
const DEFAULT_DEEP_DISCOVERY_LIMIT = 80;
const HEAD_READ_BYTES = 512 * 1024;

type TranscriptFileStat = { path: string; mtimeMs: number; size: number };

function readPositiveIntEnv(names: string[], fallback: number): number {
  for (const name of names) {
    const raw = Number.parseInt(process.env[name] ?? "", 10);
    if (Number.isFinite(raw) && raw > 0) return raw;
  }
  return fallback;
}

function discoveryWindowMs(scope: TailDiscoveryScope): number {
  const fallback = scope === "hot"
    ? DEFAULT_HOT_DISCOVERY_WINDOW_MS
    : scope === "deep"
      ? DEFAULT_DEEP_DISCOVERY_WINDOW_MS
      : DEFAULT_SHALLOW_DISCOVERY_WINDOW_MS;
  const scopedName = `OPENSCOUT_TAIL_${scope.toUpperCase()}_DISCOVERY_WINDOW_MS`;
  return readPositiveIntEnv([scopedName, "OPENSCOUT_TAIL_DISCOVERY_WINDOW_MS"], fallback);
}

function discoveryLimit(scope: TailDiscoveryScope): number {
  const fallback = scope === "hot"
    ? DEFAULT_HOT_DISCOVERY_LIMIT
    : scope === "deep"
      ? DEFAULT_DEEP_DISCOVERY_LIMIT
      : DEFAULT_SHALLOW_DISCOVERY_LIMIT;
  const scopedName = `OPENSCOUT_TAIL_${scope.toUpperCase()}_DISCOVERY_LIMIT`;
  return readPositiveIntEnv([scopedName, "OPENSCOUT_TAIL_DISCOVERY_LIMIT"], fallback);
}

function cursorProcessMonitorRoots(): string[] {
  const explicit = process.env.OPENSCOUT_TAIL_CURSOR_PROCESS_MONITOR_ROOT;
  if (explicit?.trim()) return [explicit.trim()];
  return [join(homedir(), "Library", "Application Support", "Cursor", "process-monitor")]
    .filter((root) => existsSync(root));
}

function isCursorProcess(command: string): boolean {
  const base = commandBasename(command);
  return base === "Cursor"
    || base === "cursor"
    || command.includes("/Cursor.app/")
    || command.includes("cursor-agent");
}

export async function discoverCursorProcesses(): Promise<DiscoveredProcess[]> {
  const all = await listProcesses();
  const byPid = new Map<number, RawProcess>();
  for (const proc of all) byPid.set(proc.pid, proc);

  const cursors = all.filter((proc) => isCursorProcess(proc.command));
  const out: DiscoveredProcess[] = [];
  await Promise.all(
    cursors.map(async (proc) => {
      const cwd = await readCwd(proc.pid, proc.etime);
      const parentChain = buildParentChain(proc.pid, byPid);
      out.push({
        pid: proc.pid,
        ppid: proc.ppid,
        command: proc.command,
        etime: proc.etime,
        ...processResourceFields(proc),
        cwd,
        harness: classifyAttribution(parentChain),
        parentChain,
        source: SOURCE_NAME,
      });
    }),
  );
  out.sort((a, b) => a.pid - b.pid);
  return out;
}

function readFileHead(filePath: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const buffer = new Uint8Array(HEAD_READ_BYTES);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return Buffer.from(buffer.subarray(0, bytesRead)).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function cursorWorkspaceNames(record: Record<string, unknown>): string[] {
  const rows = Array.isArray(record.rows) ? record.rows : [];
  const names = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const processName = (row as Record<string, unknown>).processName;
    if (typeof processName !== "string") continue;
    const match = processName.match(/extension-host \((?:agent-exec|user|always-local|retrieval)\) ([^\[]+)/u);
    if (match?.[1]?.trim()) names.add(match[1].trim());
  }
  return [...names].sort();
}

function firstCursorMonitorRecord(filePath: string): Record<string, unknown> | null {
  const head = readFileHead(filePath);
  for (const line of head.split(/\r?\n/)) {
    const record = parseJsonRecord(line.trim());
    if (record) return record;
  }
  return null;
}

function walkRecentMonitorLogs(root: string, scope: TailDiscoveryScope): TranscriptFileStat[] {
  const cutoff = Date.now() - discoveryWindowMs(scope);
  const found: TranscriptFileStat[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.endsWith(".log")) continue;
    const path = join(root, entry);
    try {
      const stats = statSync(path);
      if (!stats.isFile() || stats.mtimeMs < cutoff) continue;
      found.push({ path, mtimeMs: stats.mtimeMs, size: stats.size });
    } catch {
      continue;
    }
  }
  return found;
}

function discoverCursorTranscripts(scope: TailDiscoveryScope): DiscoveredTranscript[] {
  const files: TranscriptFileStat[] = [];
  for (const root of cursorProcessMonitorRoots()) {
    files.push(...walkRecentMonitorLogs(root, scope));
  }
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, discoveryLimit(scope))
    .map((file) => {
      const record = firstCursorMonitorRecord(file.path);
      const sessionId = typeof record?.sessionId === "string" && record.sessionId.trim()
        ? record.sessionId
        : basename(file.path).replace(/\.log$/u, "");
      const workspaces = record ? cursorWorkspaceNames(record) : [];
      return {
        source: SOURCE_NAME,
        transcriptPath: file.path,
        sessionId,
        cwd: null,
        project: workspaces[0] ?? "Cursor",
        harness: "unattributed",
        mtimeMs: file.mtimeMs,
        size: file.size,
      };
    });
}

function clip(text: string, max = MAX_SUMMARY_LEN): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function parseCursorLine(line: string, ctx: TailContext): TailEvent | null {
  const record = parseJsonRecord(line.trim());
  if (!record) return null;

  const start = typeof record.sampleStart === "number" && Number.isFinite(record.sampleStart)
    ? record.sampleStart
    : Date.now();
  const end = typeof record.sampleEnd === "number" && Number.isFinite(record.sampleEnd)
    ? record.sampleEnd
    : start;
  const sessionId = typeof record.sessionId === "string" && record.sessionId.trim()
    ? record.sessionId
    : ctx.transcript.sessionId ?? basename(ctx.transcriptPath).replace(/\.log$/u, "");
  const workspaces = cursorWorkspaceNames(record);
  const summary = workspaces.length > 0
    ? `process sample · ${workspaces.join(", ")}`
    : "process sample";

  return {
    id: `${SOURCE_NAME}:${sessionId}:${ctx.lineOffset}`,
    ts: end,
    source: SOURCE_NAME,
    sessionId,
    pid: ctx.process.pid,
    parentPid: ctx.process.ppid || null,
    project: workspaces[0] ?? ctx.transcript.project,
    cwd: ctx.transcript.cwd ?? ctx.process.cwd ?? "",
    harness: ctx.process.harness,
    kind: "system",
    summary: clip(summary),
    raw: record,
  };
}

export const CursorSource: TranscriptSource = {
  name: SOURCE_NAME,
  discoverProcesses(): Promise<DiscoveredProcess[]> {
    return discoverCursorProcesses();
  },
  discoverTranscripts(_processes: DiscoveredProcess[], scope: TailDiscoveryScope = "shallow"): DiscoveredTranscript[] {
    return discoverCursorTranscripts(scope);
  },
  parseLine(line: string, ctx: TailContext): TailEvent | null {
    return parseCursorLine(line, ctx);
  },
};
