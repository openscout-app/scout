import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";

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
  TailEventKind,
  TranscriptSource,
} from "./types.js";

const SOURCE_NAME = "opencode";
const MAX_SUMMARY_LEN = 200;
const DEFAULT_HOT_DISCOVERY_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_SHALLOW_DISCOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DEEP_DISCOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HOT_DISCOVERY_LIMIT = 32;
const DEFAULT_SHALLOW_DISCOVERY_LIMIT = 80;
const DEFAULT_DEEP_DISCOVERY_LIMIT = 80;
const DEFAULT_MESSAGES_PER_SESSION = 50;
const HEAD_READ_BYTES = 128 * 1024;

type TranscriptFileStat = { path: string; mtimeMs: number; size: number };
type JsonRecord = Record<string, unknown>;
type OpenCodeMessage = JsonRecord & {
  __filePath: string;
  __mtimeMs: number;
};
type OpenCodePart = JsonRecord & {
  __filePath: string;
  __mtimeMs: number;
};

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

function messagesPerSession(): number {
  return readPositiveIntEnv(["OPENSCOUT_TAIL_OPENCODE_MESSAGES_PER_SESSION"], DEFAULT_MESSAGES_PER_SESSION);
}

function opencodeStorageRoots(): string[] {
  const explicit = process.env.OPENSCOUT_TAIL_OPENCODE_STORAGE_ROOT;
  if (explicit?.trim()) return [explicit.trim()];
  return [join(homedir(), ".local", "share", "opencode", "storage")]
    .filter((root) => existsSync(root));
}

function isOpenCodeProcess(command: string): boolean {
  const base = commandBasename(command).toLowerCase();
  return base === "opencode" || /\bopencode\b/i.test(command);
}

export async function discoverOpenCodeProcesses(): Promise<DiscoveredProcess[]> {
  const all = await listProcesses();
  const byPid = new Map<number, RawProcess>();
  for (const proc of all) byPid.set(proc.pid, proc);

  const opencodes = all.filter((proc) => isOpenCodeProcess(proc.command));
  const out: DiscoveredProcess[] = [];
  await Promise.all(
    opencodes.map(async (proc) => {
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

function metadataRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function parseJsonRecord(text: string): JsonRecord | null {
  try {
    return metadataRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function readJsonFile(filePath: string): JsonRecord | null {
  try {
    return parseJsonRecord(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
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

function stringValue(record: JsonRecord | null | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(record: JsonRecord | null | undefined, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nestedRecord(record: JsonRecord | null | undefined, key: string): JsonRecord | null {
  return metadataRecord(record?.[key]);
}

function messageTimestamp(message: JsonRecord): number | null {
  const time = nestedRecord(message, "time");
  return numberValue(time, "completed")
    ?? numberValue(time, "created")
    ?? numberValue(time, "updated");
}

function partTimestamp(part: JsonRecord): number | null {
  const time = nestedRecord(part, "time")
    ?? nestedRecord(nestedRecord(part, "state"), "time");
  return numberValue(time, "end")
    ?? numberValue(time, "start")
    ?? numberValue(time, "created");
}

function walkRecentSessionFiles(root: string, scope: TailDiscoveryScope): TranscriptFileStat[] {
  const cutoff = Date.now() - discoveryWindowMs(scope);
  const found: TranscriptFileStat[] = [];
  const stack = [join(root, "session")];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.endsWith(".json") || stats.mtimeMs < cutoff) continue;
      found.push({ path, mtimeMs: stats.mtimeMs, size: stats.size });
    }
  }
  return found;
}

function walkRecentMessageSessionFiles(root: string, scope: TailDiscoveryScope): TranscriptFileStat[] {
  const cutoff = Date.now() - discoveryWindowMs(scope);
  const messageRoot = join(root, "message");
  let sessionDirs: string[] = [];
  try {
    sessionDirs = readdirSync(messageRoot);
  } catch {
    return [];
  }

  const found = new Map<string, TranscriptFileStat>();
  for (const sessionId of sessionDirs) {
    const dir = join(messageRoot, sessionId);
    let entries: string[] = [];
    let messageDirectoryMtime = 0;
    try {
      const stats = statSync(dir);
      if (!stats.isDirectory()) continue;
      messageDirectoryMtime = stats.mtimeMs;
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    let latestDependencyMtime = messageDirectoryMtime;
    let dependencySize = entries.length;
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const stats = statSync(join(dir, entry));
        if (!stats.isFile()) continue;
        latestDependencyMtime = Math.max(latestDependencyMtime, stats.mtimeMs);
        dependencySize += stats.size;

        const messageId = entry.replace(/\.json$/u, "");
        const partDir = join(root, "part", messageId);
        const partDirStats = statSync(partDir);
        if (!partDirStats.isDirectory()) continue;
        latestDependencyMtime = Math.max(latestDependencyMtime, partDirStats.mtimeMs);
        const partEntries = readdirSync(partDir);
        dependencySize += partEntries.length;
        for (const partEntry of partEntries) {
          if (!partEntry.endsWith(".json")) continue;
          try {
            const partStats = statSync(join(partDir, partEntry));
            if (!partStats.isFile()) continue;
            latestDependencyMtime = Math.max(latestDependencyMtime, partStats.mtimeMs);
            dependencySize += partStats.size;
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }
    if (latestDependencyMtime < cutoff) continue;

    const sessionPath = join(root, "session", "global", `${sessionId}.json`);
    try {
      const sessionStats = statSync(sessionPath);
      if (!sessionStats.isFile()) continue;
      found.set(sessionPath, {
        path: sessionPath,
        mtimeMs: Math.max(sessionStats.mtimeMs, latestDependencyMtime),
        size: sessionStats.size + dependencySize,
      });
    } catch {
      continue;
    }
  }
  return [...found.values()];
}

function sessionIdFromPath(filePath: string): string {
  return basename(filePath).replace(/\.json$/u, "");
}

function storageRootFromSessionPath(filePath: string): string | null {
  const marker = `${sep}session${sep}`;
  const index = filePath.lastIndexOf(marker);
  if (index >= 0) return filePath.slice(0, index);
  return opencodeStorageRoots()[0] ?? null;
}

function discoverOpenCodeTranscripts(scope: TailDiscoveryScope): DiscoveredTranscript[] {
  const byPath = new Map<string, TranscriptFileStat>();
  for (const root of opencodeStorageRoots()) {
    for (const file of [
      ...walkRecentSessionFiles(root, scope),
      ...walkRecentMessageSessionFiles(root, scope),
    ]) {
      const existing = byPath.get(file.path);
      if (!existing) {
        byPath.set(file.path, file);
      } else {
        byPath.set(file.path, {
          path: file.path,
          mtimeMs: Math.max(existing.mtimeMs, file.mtimeMs),
          size: Math.max(existing.size, file.size),
        });
      }
    }
  }
  return [...byPath.values()]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, discoveryLimit(scope))
    .map((file) => {
      const session = readJsonFile(file.path) ?? parseJsonRecord(readFileHead(file.path));
      const sessionId = stringValue(session, "id") ?? sessionIdFromPath(file.path);
      const cwd = stringValue(session, "directory");
      const title = stringValue(session, "title");
      return {
        source: SOURCE_NAME,
        transcriptPath: file.path,
        sessionId,
        cwd,
        project: cwd ? basename(cwd) : title ?? "OpenCode",
        harness: "unattributed",
        mtimeMs: file.mtimeMs,
        size: file.size,
      };
    });
}

function readOpenCodeMessages(root: string, sessionId: string): OpenCodeMessage[] {
  const dir = join(root, "message", sessionId);
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const messages: OpenCodeMessage[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const path = join(dir, entry);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    const record = readJsonFile(path);
    if (!record) continue;
    messages.push({ ...record, __filePath: path, __mtimeMs: stats.mtimeMs });
  }
  return messages
    .sort((a, b) => (messageTimestamp(a) ?? a.__mtimeMs) - (messageTimestamp(b) ?? b.__mtimeMs))
    .slice(-messagesPerSession());
}

function readOpenCodeParts(root: string, messageId: string): OpenCodePart[] {
  const dir = join(root, "part", messageId);
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const parts: OpenCodePart[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const path = join(dir, entry);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    const record = readJsonFile(path);
    if (!record) continue;
    parts.push({ ...record, __filePath: path, __mtimeMs: stats.mtimeMs });
  }
  return parts.sort((a, b) => (partTimestamp(a) ?? a.__mtimeMs) - (partTimestamp(b) ?? b.__mtimeMs));
}

function clip(text: string, max = MAX_SUMMARY_LEN): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function modelId(message: JsonRecord): string | null {
  return stringValue(message, "modelID") ?? stringValue(nestedRecord(message, "model"), "modelID");
}

function summarizeToolPart(part: JsonRecord): string {
  const state = nestedRecord(part, "state");
  const metadata = nestedRecord(state, "metadata");
  const tool = stringValue(part, "tool") ?? "tool";
  const status = stringValue(state, "status");
  const title = stringValue(state, "title")
    ?? stringValue(metadata, "description")
    ?? stringValue(metadata, "preview");
  return clip(`${tool}${status ? ` ${status}` : ""}${title ? ` · ${title}` : ""}`, 80);
}

function summarizeOpenCodeMessage(message: JsonRecord, parts: JsonRecord[]): string {
  const textParts = parts
    .filter((part) => stringValue(part, "type") === "text")
    .map((part) => stringValue(part, "text"))
    .filter((text): text is string => Boolean(text));
  if (textParts.length > 0) return clip(textParts.join(" "));

  const summary = nestedRecord(message, "summary");
  const title = stringValue(summary, "title");
  if (title) return clip(title);

  const toolParts = parts.filter((part) => stringValue(part, "type") === "tool");
  if (toolParts.length > 0) {
    return clip(toolParts.slice(-3).map(summarizeToolPart).join(" · "));
  }

  const role = stringValue(message, "role") ?? "message";
  const model = modelId(message);
  const finish = stringValue(message, "finish");
  return clip(`${role}${model ? ` · ${model}` : ""}${finish ? ` · ${finish}` : ""}`);
}

function eventKindForRole(role: string | null): TailEventKind {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  return "system";
}

function openCodeEventFromMessage(
  message: OpenCodeMessage,
  parts: OpenCodePart[],
  ctx: TailContext,
  fallbackCwd: string,
  index: number,
): TailEvent {
  const messageId = stringValue(message, "id") ?? basename(message.__filePath).replace(/\.json$/u, "");
  const sessionId = stringValue(message, "sessionID") ?? ctx.transcript.sessionId ?? sessionIdFromPath(ctx.transcriptPath);
  const pathRecord = nestedRecord(message, "path");
  const cwd = stringValue(pathRecord, "cwd") ?? fallbackCwd;
  const role = stringValue(message, "role");
  const ts = messageTimestamp(message) ?? message.__mtimeMs;

  return {
    id: `${SOURCE_NAME}:${sessionId}:${messageId}:${ts || index}`,
    ts: ts || Date.now(),
    source: SOURCE_NAME,
    sessionId,
    pid: ctx.process.pid,
    parentPid: ctx.process.ppid || null,
    project: cwd ? basename(cwd) : ctx.transcript.project,
    cwd,
    harness: ctx.process.harness,
    kind: eventKindForRole(role),
    summary: summarizeOpenCodeMessage(message, parts),
    raw: {
      message,
      parts,
    },
  };
}

function parseOpenCodeSession(text: string, ctx: TailContext): TailEvent[] {
  const session = parseJsonRecord(text);
  if (!session) return [];

  const root = storageRootFromSessionPath(ctx.transcriptPath);
  const sessionId = stringValue(session, "id") ?? ctx.transcript.sessionId ?? sessionIdFromPath(ctx.transcriptPath);
  const fallbackCwd = stringValue(session, "directory") ?? ctx.transcript.cwd ?? ctx.process.cwd ?? "";
  if (root) {
    const messages = readOpenCodeMessages(root, sessionId);
    if (messages.length > 0) {
      return messages.map((message, index) => {
        const messageId = stringValue(message, "id") ?? basename(message.__filePath).replace(/\.json$/u, "");
        return openCodeEventFromMessage(
          message,
          readOpenCodeParts(root, messageId),
          ctx,
          fallbackCwd,
          index,
        );
      });
    }
  }

  const updated = numberValue(nestedRecord(session, "time"), "updated")
    ?? numberValue(nestedRecord(session, "time"), "created")
    ?? Date.now();
  const title = stringValue(session, "title") ?? "session updated";
  return [{
    id: `${SOURCE_NAME}:${sessionId}:session:${updated}`,
    ts: updated,
    source: SOURCE_NAME,
    sessionId,
    pid: ctx.process.pid,
    parentPid: ctx.process.ppid || null,
    project: fallbackCwd ? basename(fallbackCwd) : ctx.transcript.project,
    cwd: fallbackCwd,
    harness: ctx.process.harness,
    kind: "system",
    summary: clip(title),
    raw: session,
  }];
}

export const OpenCodeSource: TranscriptSource = {
  name: SOURCE_NAME,
  discoverProcesses(): Promise<DiscoveredProcess[]> {
    return discoverOpenCodeProcesses();
  },
  discoverTranscripts(_processes: DiscoveredProcess[], scope: TailDiscoveryScope = "shallow"): DiscoveredTranscript[] {
    return discoverOpenCodeTranscripts(scope);
  },
  parseLine(line: string, ctx: TailContext): TailEvent | null {
    return parseOpenCodeSession(line, ctx)[0] ?? null;
  },
  parseFile(text: string, ctx: TailContext): TailEvent[] {
    return parseOpenCodeSession(text, ctx);
  },
};
