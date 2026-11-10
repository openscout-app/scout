import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";

import {
  buildParentChain,
  classifyAttribution,
  commandBasename,
  listProcesses,
  readCwd,
  type RawProcess,
} from "./discover.js";
import { formatToolCall, formatToolResult } from "./tool-format.js";
import type {
  DiscoveredProcess,
  DiscoveredTranscript,
  TailContext,
  TailDiscoveryScope,
  TailEvent,
  TailEventKind,
  TranscriptSource,
} from "./types.js";

const SOURCE_NAME = "pi";
const MAX_SUMMARY_LEN = 200;
const DEFAULT_HOT_DISCOVERY_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_SHALLOW_DISCOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DEEP_DISCOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HOT_DISCOVERY_LIMIT = 64;
const DEFAULT_SHALLOW_DISCOVERY_LIMIT = 160;
const DEFAULT_DEEP_DISCOVERY_LIMIT = 160;
const HEAD_READ_BYTES = 256 * 1024;
const METADATA_CACHE_LIMIT = 512;

type TranscriptFileStat = { path: string; mtimeMs: number; size: number };
type TranscriptMetadata = { cwd: string | null; sessionId: string | null };

const metadataCache = new Map<string, TranscriptFileStat & TranscriptMetadata>();

function rememberMetadata(file: TranscriptFileStat, metadata: TranscriptMetadata): TranscriptMetadata {
  metadataCache.delete(file.path);
  metadataCache.set(file.path, { ...file, ...metadata });
  while (metadataCache.size > METADATA_CACHE_LIMIT) {
    const oldest = metadataCache.keys().next().value;
    if (!oldest) break;
    metadataCache.delete(oldest);
  }
  return metadata;
}

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

function projectsRoot(): string {
  return process.env.OPENSCOUT_TAIL_PI_SESSIONS_ROOT
    ?? join(homedir(), ".pi", "agent", "sessions");
}

function listJsonlFiles(dir: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.endsWith(".jsonl"));
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

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clip(text: string, max = MAX_SUMMARY_LEN): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Pi encodes cwd as `--Users-art-dev-openscout--` under ~/.pi/agent/sessions/. */
export function decodePiProjectDir(dirName: string): string | null {
  if (!dirName.startsWith("--") || !dirName.endsWith("--")) return null;
  const inner = dirName.slice(2, -2);
  if (!inner) return null;
  return `/${inner.replace(/-/g, "/")}`;
}

export function sessionIdFromPiPath(filePath: string): string {
  const name = basename(filePath).replace(/\.jsonl$/, "");
  const separator = name.lastIndexOf("_");
  if (separator >= 0) return name.slice(separator + 1);
  return name;
}

function readPiMetadata(file: TranscriptFileStat): TranscriptMetadata {
  const cached = metadataCache.get(file.path);
  if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
    return { cwd: cached.cwd, sessionId: cached.sessionId };
  }

  const head = readFileHead(file.path);
  let cwd: string | null = null;
  let sessionId: string | null = null;
  for (const line of head.split(/\r?\n/)) {
    const record = parseJsonRecord(line.trim());
    if (!record) continue;
    if (record.type === "session") {
      cwd ??= typeof record.cwd === "string" && record.cwd.trim() ? record.cwd : null;
      sessionId ??= typeof record.id === "string" && record.id.trim() ? record.id : null;
      if (cwd && sessionId) break;
    }
  }
  return rememberMetadata(file, {
    cwd,
    sessionId: sessionId ?? sessionIdFromPiPath(file.path),
  });
}

function projectDirNameForPath(filePath: string): string | null {
  const rel = relative(projectsRoot(), filePath);
  if (!rel || rel.startsWith("..")) return null;
  return rel.split(/[\\/]/)[0] ?? null;
}

function fallbackCwdForPath(filePath: string): string | null {
  const dirName = projectDirNameForPath(filePath);
  const guessed = dirName ? decodePiProjectDir(dirName) : null;
  try {
    return guessed && statSync(guessed).isDirectory() ? guessed : null;
  } catch {
    return null;
  }
}

function listRecentPiProjectTranscripts(
  root: string,
  scope: TailDiscoveryScope,
): TranscriptFileStat[] {
  const cutoff = Date.now() - discoveryWindowMs(scope);
  const found: TranscriptFileStat[] = [];
  let projectDirs: string[] = [];
  try {
    projectDirs = readdirSync(root);
  } catch {
    return [];
  }

  for (const entry of projectDirs) {
    const projectDir = join(root, entry);
    try {
      if (!statSync(projectDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of listJsonlFiles(projectDir)) {
      const path = join(projectDir, file);
      try {
        const stats = statSync(path);
        if (stats.mtimeMs < cutoff) continue;
        found.push({ path, mtimeMs: stats.mtimeMs, size: stats.size });
      } catch {
        continue;
      }
    }
  }

  return found
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, discoveryLimit(scope));
}

function isPiProcess(command: string): boolean {
  return commandBasename(command) === "pi";
}

export async function discoverPiProcesses(): Promise<DiscoveredProcess[]> {
  const all = await listProcesses();
  const byPid = new Map<number, RawProcess>();
  for (const proc of all) byPid.set(proc.pid, proc);

  const matches = all.filter((proc) => isPiProcess(proc.command));
  const out: DiscoveredProcess[] = [];

  await Promise.all(
    matches.map(async (proc) => {
      const cwd = await readCwd(proc.pid);
      const parentChain = buildParentChain(proc.pid, byPid);
      out.push({
        pid: proc.pid,
        ppid: proc.ppid,
        command: proc.command,
        etime: proc.etime,
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

function discoverPiTranscripts(scope: TailDiscoveryScope): DiscoveredTranscript[] {
  const root = projectsRoot();
  if (!existsSync(root)) return [];
  return listRecentPiProjectTranscripts(root, scope).map((file) => {
    const meta = readPiMetadata(file);
    const cwd = meta.cwd ?? fallbackCwdForPath(file.path);
    const sessionId = meta.sessionId ?? sessionIdFromPiPath(file.path);
    return {
      source: SOURCE_NAME,
      transcriptPath: file.path,
      sessionId,
      cwd,
      project: cwd ? basename(cwd) : projectDirNameForPath(file.path) ?? "(unknown)",
      harness: "unattributed",
      mtimeMs: file.mtimeMs,
      size: file.size,
    };
  });
}

function textFromPiContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const value = block as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string" && value.text.trim()) {
      parts.push(value.text.trim());
    }
  }
  return parts.join(" ").trim();
}

function summarizePiMessage(message: Record<string, unknown>): { kind: TailEventKind; summary: string } | null {
  const role = typeof message.role === "string" ? message.role : "";
  const content = message.content;

  if (role === "user") {
    const text = textFromPiContent(content);
    return { kind: "user", summary: clip(text || "[user]") };
  }

  if (role === "toolResult") {
    const text = textFromPiContent(content);
    const toolName = typeof message.toolName === "string" ? message.toolName : undefined;
    return {
      kind: "tool-result",
      summary: clip(formatToolResult(text, toolName)),
    };
  }

  if (role === "assistant") {
    if (!Array.isArray(content)) {
      return { kind: "assistant", summary: "[assistant]" };
    }

    const textParts: string[] = [];
    const toolParts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const value = block as Record<string, unknown>;
      if (value.type === "text" && typeof value.text === "string" && value.text.trim()) {
        textParts.push(value.text.trim());
      }
      if (value.type === "toolCall") {
        const name = typeof value.name === "string" ? value.name : "tool";
        toolParts.push(formatToolCall(name, value.arguments));
      }
    }

    if (toolParts.length > 0) {
      return { kind: "tool", summary: clip(toolParts.join(" · ")) };
    }
    return { kind: "assistant", summary: clip(textParts.join(" ") || "[assistant]") };
  }

  return null;
}

function parsePiLine(line: string, ctx: TailContext): TailEvent | null {
  const record = parseJsonRecord(line.trim());
  if (!record || record.type !== "message" || typeof record.message !== "object" || !record.message) {
    return null;
  }

  const message = record.message as Record<string, unknown>;
  const parsed = summarizePiMessage(message);
  if (!parsed) return null;

  const sessionId = ctx.transcript.sessionId
    ?? sessionIdFromPiPath(ctx.transcriptPath);
  const cwd = ctx.transcript.cwd ?? ctx.process.cwd ?? "";
  const ts = parseTimestamp(record.timestamp)
    ?? parseTimestamp(message.timestamp)
    ?? Date.now();
  const recordId = typeof record.id === "string" && record.id.trim() ? record.id : String(ctx.lineOffset);

  return {
    id: `${SOURCE_NAME}:${sessionId}:${recordId}`,
    ts,
    source: SOURCE_NAME,
    sessionId,
    pid: ctx.process.pid,
    parentPid: ctx.process.ppid || null,
    project: cwd ? basename(cwd) : ctx.transcript.project,
    cwd,
    harness: ctx.process.harness,
    kind: parsed.kind,
    summary: parsed.summary,
    raw: record,
  };
}

export const PiSource: TranscriptSource = {
  name: SOURCE_NAME,
  discoverProcesses(): Promise<DiscoveredProcess[]> {
    return discoverPiProcesses();
  },
  discoverTranscripts(_processes: DiscoveredProcess[], scope: TailDiscoveryScope = "shallow"): DiscoveredTranscript[] {
    return discoverPiTranscripts(scope);
  },
  parseLine(line: string, ctx: TailContext): TailEvent | null {
    return parsePiLine(line, ctx);
  },
};