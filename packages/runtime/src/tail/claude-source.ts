import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";

import { resolveTailThinkingMode } from "../user-config.js";
import { discoverClaudeProcesses } from "./discover.js";
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

const SOURCE_NAME = "claude";
const MAX_SUMMARY_LEN = 200;
const DEFAULT_HOT_DISCOVERY_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_SHALLOW_DISCOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DEEP_DISCOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HOT_DISCOVERY_LIMIT = 64;
const DEFAULT_SHALLOW_DISCOVERY_LIMIT = 160;
const DEFAULT_DEEP_DISCOVERY_LIMIT = 160;
const HEAD_READ_BYTES = 256 * 1024;
const TAIL_READ_BYTES = 512 * 1024;
const METADATA_CACHE_LIMIT = 512;

type TranscriptFileStat = { path: string; mtimeMs: number; size: number };
type TranscriptMetadata = {
  cwd: string | null;
  sessionId: string | null;
  lastEventAt: number | null;
  aiTitle?: string | null;
  customTitle?: string | null;
  agentName?: string | null;
  title?: string | null;
};

type ClaudeTranscriptFile = TranscriptFileStat & {
  workflowRunId?: string;
  parentSessionId?: string;
  subagentId?: string;
  cwd?: string | null;
};

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

function encodeProjectDir(cwd: string): string {
  // Claude encodes the cwd by replacing "/" with "-" and prefixing the result.
  // Example: /Users/arach/dev/openscout → -Users-arach-dev-openscout
  return cwd.replace(/\//g, "-");
}

function projectsRoot(): string {
  return process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT
    ?? join(homedir(), ".claude", "projects");
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

function listClaudeSubagentFiles(dir: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((entry) => /^agent-[a-zA-Z0-9_-]+\.jsonl$/u.test(entry));
}

function pickMostRecentJsonl(dir: string): string | null {
  const files = listJsonlFiles(dir);
  if (files.length === 0) return null;
  let best: { name: string; mtime: number } | null = null;
  for (const file of files) {
    try {
      const mtime = statSync(join(dir, file)).mtimeMs;
      if (!best || mtime > best.mtime) best = { name: file, mtime };
    } catch {
      continue;
    }
  }
  return best ? join(dir, best.name) : null;
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

function readFileTail(file: TranscriptFileStat): { content: string; startsAtBeginning: boolean } {
  let fd: number | null = null;
  try {
    fd = openSync(file.path, "r");
    const start = Math.max(0, file.size - TAIL_READ_BYTES);
    const buffer = new Uint8Array(Math.min(file.size, TAIL_READ_BYTES));
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    return {
      content: Buffer.from(buffer.subarray(0, bytesRead)).toString("utf8"),
      startsAtBeginning: start === 0,
    };
  } catch {
    return { content: "", startsAtBeginning: false };
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

function readClaudeMetadata(file: TranscriptFileStat): TranscriptMetadata {
  const cached = metadataCache.get(file.path);
  if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
    return cached;
  }

  const titles: Pick<TranscriptMetadata, "aiTitle" | "customTitle" | "agentName"> =
    cached && cached.size <= file.size
      ? { aiTitle: cached.aiTitle, customTitle: cached.customTitle, agentName: cached.agentName }
      : {};
  const captureTitle = (record: Record<string, unknown>) => {
    const key = record.type === "custom-title" ? "customTitle"
      : record.type === "agent-name" ? "agentName" : record.type === "ai-title" ? "aiTitle" : null;
    if (!key) return;
    const value = record[key] ?? record.title;
    if (typeof value === "string" && value.trim()) titles[key] = value.trim();
  };
  const head = readFileHead(file.path);
  let cwd: string | null = null;
  let sessionId: string | null = null;
  for (const line of head.split(/\r?\n/)) {
    const record = parseJsonRecord(line.trim());
    if (!record) continue;
    if (!cached || cached.size > file.size) captureTitle(record);
    cwd ??= typeof record.cwd === "string" && record.cwd.trim()
      ? record.cwd
      : null;
    sessionId ??=
      typeof record.sessionId === "string" && record.sessionId.trim()
        ? record.sessionId
        : typeof record.session_id === "string" && record.session_id.trim()
          ? record.session_id
          : null;
  }

  const tail = readFileTail(file);
  const tailLines = tail.content.split(/\r?\n/);
  if (!tail.startsAtBeginning) tailLines.shift();
  for (const line of tailLines) {
    const record = parseJsonRecord(line.trim());
    if (record) captureTitle(record);
  }
  let lastEventAt: number | null = null;
  for (let index = tailLines.length - 1; index >= 0; index -= 1) {
    const record = parseJsonRecord(tailLines[index]?.trim() ?? "");
    if (!record) continue;
    lastEventAt = pickTimestamp(record);
    if (lastEventAt != null) break;
  }

  return rememberMetadata(file, {
    cwd, sessionId, lastEventAt, ...titles,
    title: titles.customTitle ?? titles.agentName ?? titles.aiTitle ?? null,
  });
}

function decodeProjectDir(dirName: string): string | null {
  if (!dirName.startsWith("-")) return null;
  return `/${dirName.slice(1).replace(/-/g, "/")}`;
}

function projectDirNameForPath(filePath: string): string | null {
  const rel = relative(projectsRoot(), filePath);
  if (!rel || rel.startsWith("..")) return null;
  return rel.split(/[\\/]/)[0] ?? null;
}

function fallbackCwdForPath(filePath: string): string | null {
  const dirName = projectDirNameForPath(filePath);
  return dirName ? decodeProjectDir(dirName) : null;
}

/**
 * Session transcripts live directly under each encoded project dir. Claude's
 * child workers live under `<session>/subagents/agent-*.jsonl`; they are
 * distinct active harness sessions and must be surfaced independently rather
 * than being folded into their parent's lane.
 */
function listRecentClaudeProjectTranscripts(
  root: string,
  scope: TailDiscoveryScope,
): ClaudeTranscriptFile[] {
  const cutoff = Date.now() - discoveryWindowMs(scope);
  const found: ClaudeTranscriptFile[] = [];
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
        const subagentsDir = join(projectDir, basename(path, ".jsonl"), "subagents");
        const activeSubagents: Array<{ path: string; mtimeMs: number; size: number; id: string; workflowRunId?: string }> = [];
        const directories: Array<{ path: string; workflowRunId?: string }> = [{ path: subagentsDir }];
        try {
          for (const run of readdirSync(join(subagentsDir, "workflows"), { withFileTypes: true })) {
            if (run.isDirectory()) directories.push({ path: join(subagentsDir, "workflows", run.name), workflowRunId: run.name });
          }
        } catch { /* No workflow directory on most sessions. */ }
        for (const directory of directories) {
          for (const subagentFile of listClaudeSubagentFiles(directory.path)) {
            const subagentPath = join(directory.path, subagentFile);
            try {
              const subagentStats = statSync(subagentPath);
              if (subagentStats.mtimeMs < cutoff) continue;
              activeSubagents.push({
                path: subagentPath,
                mtimeMs: subagentStats.mtimeMs,
                size: subagentStats.size,
                workflowRunId: directory.workflowRunId,
                id: subagentFile.slice("agent-".length, -".jsonl".length),
              });
            } catch {
              continue;
            }
          }
        }
        if (stats.mtimeMs < cutoff && activeSubagents.length === 0) continue;

        // Reading a Claude transcript head is comparatively expensive. Do it
        // only after the parent or a child has passed the activity window.
        const parentMeta = readClaudeMetadata({ path, mtimeMs: stats.mtimeMs, size: stats.size });
        const parentSessionId = parentMeta.sessionId ?? basename(path).replace(/\.jsonl$/u, "");
        const cwd = parentMeta.cwd ?? fallbackCwdForPath(path);
        if (stats.mtimeMs >= cutoff) {
          found.push({ path, mtimeMs: stats.mtimeMs, size: stats.size, cwd });
        }
        for (const subagent of activeSubagents) {
          found.push({
            path: subagent.path,
            mtimeMs: subagent.mtimeMs,
            size: subagent.size,
            parentSessionId,
            subagentId: subagent.id,
            workflowRunId: subagent.workflowRunId,
            cwd,
          });
        }
      } catch {
        continue;
      }
    }
  }

  return found
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, discoveryLimit(scope));
}

export function resolveClaudeTranscriptPath(p: DiscoveredProcess): string | null {
  if (!p.cwd) return null;
  const dir = join(projectsRoot(), encodeProjectDir(p.cwd));
  if (!existsSync(dir)) return null;
  return pickMostRecentJsonl(dir);
}

function clip(text: string, max = MAX_SUMMARY_LEN): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

function summarizeBlocks(content: unknown): string {
  if (typeof content === "string") return clip(content);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const blockObj = block as Record<string, unknown>;
    const blockType = blockObj.type;
    if (blockType === "text" && typeof blockObj.text === "string") {
      parts.push(blockObj.text);
    } else if (blockType === "thinking" && typeof blockObj.thinking === "string") {
      // Claude returns thinking blocks with an EMPTY `thinking` field whenever
      // the caller leaves `display` at its default of "omitted" — the default on
      // every current model, so in practice every Claude transcript is signed
      // but textless (measured 2026-08-04: 10,428 blocks on this machine, none
      // with text). `[thinking]` with nothing behind it promises reasoning we
      // cannot show, so the default is to drop the beat entirely; operators who
      // want to see that the agent stopped to think can set it back.
      // NB: this is Claude-specific. Kimi's source reads `part.think`, which
      // does carry text, and is deliberately not gated on this setting.
      const thinking = blockObj.thinking.trim();
      if (thinking) {
        parts.push(`[thinking] ${blockObj.thinking}`);
      } else if (resolveTailThinkingMode() === "tag") {
        parts.push("[thinking]");
      }
    } else if (blockType === "tool_use") {
      const name = typeof blockObj.name === "string" ? blockObj.name : "tool";
      parts.push(formatToolCall(name, blockObj.input));
    } else if (blockType === "tool_result") {
      parts.push(formatToolResult(blockObj.content));
    } else if (blockType === "image") {
      parts.push("[image]");
    }
  }
  return clip(parts.join(" · "));
}

function pickTimestamp(obj: Record<string, unknown>): number | null {
  const candidates = [
    obj.timestamp,
    (obj.message as Record<string, unknown> | undefined)?.timestamp,
    (obj.snapshot as Record<string, unknown> | undefined)?.timestamp,
    obj.t,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) return parsed;
    } else if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate < 1e12 ? candidate * 1000 : candidate;
    }
  }
  return null;
}

function classifyKind(rawType: string, blocks: unknown): TailEventKind {
  if (rawType === "user") {
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (block && typeof block === "object") {
          const t = (block as Record<string, unknown>).type;
          if (t === "tool_result") return "tool-result";
        }
      }
    }
    return "user";
  }
  if (rawType === "assistant") {
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (block && typeof block === "object") {
          const t = (block as Record<string, unknown>).type;
          if (t === "tool_use") return "tool";
        }
      }
    }
    return "assistant";
  }
  if (rawType === "tool_use") return "tool";
  if (rawType === "tool_result") return "tool-result";
  if (rawType === "system" || rawType === "permission-mode" || rawType === "file-history-snapshot") {
    return "system";
  }
  return "other";
}

function summaryForType(rawType: string, obj: Record<string, unknown>, blocks: unknown): string {
  if (rawType === "user" || rawType === "assistant") {
    return summarizeBlocks(blocks);
  }
  if (rawType === "permission-mode") {
    return `permission-mode → ${String(obj.permissionMode ?? "")}`;
  }
  if (rawType === "mode") {
    return `mode → ${String(obj.mode ?? "")}`;
  }
  if (rawType === "ai-title" && typeof obj.aiTitle === "string") {
    return clip(`ai-title: ${obj.aiTitle}`);
  }
  if (rawType === "pr-link") {
    const num = obj.prNumber != null ? `#${String(obj.prNumber)}` : "";
    const repo = typeof obj.prRepository === "string" ? obj.prRepository : "";
    return clip(`pr-link → ${[num, repo].filter(Boolean).join(" ") || String(obj.prUrl ?? "")}`);
  }
  if (rawType === "file-history-snapshot") {
    const snap = obj.snapshot as Record<string, unknown> | undefined;
    const tracked = snap && typeof snap === "object" ? snap.trackedFileBackups : undefined;
    const count = tracked && typeof tracked === "object" ? Object.keys(tracked as object).length : 0;
    return `file-history-snapshot · ${count} file(s)`;
  }
  if (rawType === "last-prompt") {
    const last = typeof obj.lastPrompt === "string" ? obj.lastPrompt : "";
    return clip(`last-prompt: ${last}`);
  }
  if (rawType === "system" && obj.subtype === "turn_duration") {
    return `turn duration · ${String(obj.durationMs ?? "?")} ms`;
  }
  if (rawType === "system" && obj.subtype === "away_summary") {
    return clip(`away summary · ${String(obj.summary ?? obj.text ?? obj.content ?? "")}`);
  }
  if (rawType === "system" && typeof obj.text === "string") {
    return clip(obj.text);
  }
  if (typeof obj.text === "string") return clip(obj.text);
  if (typeof obj.content === "string") return clip(obj.content);
  return clip(`[${rawType}]`);
}

function hashId(sessionId: string, offset: number): string {
  // Cheap stable id; full crypto isn't needed in-memory.
  return `${sessionId}:${offset}`;
}

function parseClaudeLine(line: string, ctx: TailContext): TailEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }

  const rawType = typeof obj.type === "string" ? obj.type : "other";
  const message = obj.message as Record<string, unknown> | undefined;
  const blocks = message?.content ?? obj.content;
  const explicitSessionId = typeof obj.sessionId === "string"
    ? obj.sessionId
    : typeof obj.session_id === "string"
      ? obj.session_id
      : "";

  // Current child-agent journals carry timestamps. Older timestamp-less
  // variants use mtime only as a fallback; native timestamps always win.
  const inferredSubagentTimestamp = ctx.transcript.subagentId
    && Number.isFinite(ctx.transcript.mtimeMs)
    ? ctx.transcript.mtimeMs + ctx.lineOffset
    : null;
  const ts = pickTimestamp(obj) ?? inferredSubagentTimestamp;
  if (ts === null) return null;
  const kind = classifyKind(rawType, blocks);
  const summary = summaryForType(rawType, obj, blocks)
    || `[${rawType}]`;

  const finalSessionId = explicitSessionId
    || ctx.transcript.sessionId
    || (typeof message?.id === "string" ? (message.id as string) : "")
    || basename(ctx.transcriptPath).replace(/\.jsonl$/, "");
  const cwd = ctx.transcript.cwd ?? ctx.process.cwd ?? "";
  const project = cwd ? basename(cwd) : ctx.transcript.project;

  return {
    id: hashId(finalSessionId, ctx.lineOffset),
    ts,
    source: SOURCE_NAME,
    sessionId: finalSessionId,
    pid: ctx.process.pid,
    parentPid: ctx.process.ppid,
    project,
    cwd,
    harness: ctx.process.harness,
    kind,
    summary,
    raw: obj,
  };
}

export const ClaudeSource: TranscriptSource = {
  name: SOURCE_NAME,
  discoverProcesses(): Promise<DiscoveredProcess[]> {
    return discoverClaudeProcesses();
  },
  discoverTranscripts(_processes: DiscoveredProcess[], scope: TailDiscoveryScope = "shallow"): DiscoveredTranscript[] {
    const root = projectsRoot();
    if (!existsSync(root)) return [];
    return listRecentClaudeProjectTranscripts(root, scope).map(claudeTranscriptForFile);
  },
  parseLine(line: string, ctx: TailContext): TailEvent | null {
    return parseClaudeLine(line, ctx);
  },
};

function claudeTranscriptForFile(file: ClaudeTranscriptFile): DiscoveredTranscript {
  const meta = readClaudeMetadata(file);
  const cwd = file.cwd ?? meta.cwd ?? fallbackCwdForPath(file.path);
  const sessionId = file.subagentId
    ?? meta.sessionId
    ?? basename(file.path).replace(/\.jsonl$/, "");
  return {
    source: SOURCE_NAME,
    transcriptPath: file.path,
    sessionId,
    parentSessionId: file.parentSessionId ?? null,
    subagentId: file.subagentId ?? null,
    workflowRunId: file.workflowRunId ?? null,
    title: meta.title ?? null,
    cwd,
    project: cwd ? basename(cwd) : projectDirNameForPath(file.path) ?? "(unknown)",
    harness: "unattributed",
    lastEventAt: meta.lastEventAt,
    mtimeMs: file.mtimeMs,
    size: file.size,
  };
}
