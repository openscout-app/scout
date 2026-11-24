import { claudeProjectForPath, claudeProjectRoots } from "../claude-projects.js";
import { createReadStream } from "node:fs";
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { defineProbeFamily, type ProbeCtx } from "./registry.js";

export type SessionFileScanKey = {
  home?: string | null;
  workspaceRoot?: string | null;
  maxAgeDays: number;
  limit: number;
};

export type SessionSearchKey = SessionFileScanKey & {
  query: string;
  candidateLimit: number;
};

export type SessionFileRecord = {
  path: string;
  project: string;
  agent: string;
  modifiedAt: number;
  sizeBytes: number;
  lineCount: number;
};

export type SessionSearchMatch = {
  path: string;
  project: string;
  agent: string;
  matchCount: number;
  preview: string[];
};

function positiveInteger(value: number, fallback: number, max: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(max, Math.floor(value)) : fallback;
}

function normalizeScanKey(input: SessionFileScanKey): SessionFileScanKey {
  return {
    home: resolve(input.home?.trim() || homedir()),
    workspaceRoot: input.workspaceRoot?.trim() ? resolve(input.workspaceRoot) : null,
    maxAgeDays: positiveInteger(input.maxAgeDays, 14, 3650),
    limit: positiveInteger(input.limit, 250, 10_000),
  };
}

function normalizeSessionFileScanKey(input: SessionFileScanKey): string {
  return JSON.stringify(normalizeScanKey(input));
}

function normalizeSessionSearchKey(input: SessionSearchKey): string {
  const scan = normalizeScanKey(input);
  return JSON.stringify({
    ...scan,
    query: input.query,
    candidateLimit: positiveInteger(input.candidateLimit, Math.max(scan.limit * 10, 1000), 20_000),
  });
}

function parseKey<T>(key: string): T {
  return JSON.parse(key) as T;
}

function extractProjectName(filePath: string): string {
  const claudeMatch = filePath.match(/\.claude\/projects\/[^/]*-dev-([^/]+)/);
  if (claudeMatch?.[1]) return claudeMatch[1];
  return basename(dirname(filePath)) || "unknown";
}

function detectAgent(filePath: string, fallback = "unknown"): string {
  if (filePath.includes(".claude")) return "claude-code";
  if (filePath.includes(".codex") || filePath.includes("codex")) return "codex";
  if (filePath.includes(".aider") || filePath.includes("aider")) return "aider";
  return fallback;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function scanJsonlFiles(input: {
  root: string;
  agent: string;
  cutoffMs: number;
  maxDepth: number;
  skipSubagents: boolean;
  mirror?: boolean;
  signal: AbortSignal;
  cap: number;
}): Promise<SessionFileRecord[]> {
  const out: SessionFileRecord[] = [];
  async function visit(directory: string, depth: number): Promise<void> {
    if (input.signal.aborted || out.length >= input.cap || depth < 0) return;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (input.signal.aborted || out.length >= input.cap) return;
      const filePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (input.skipSubagents && entry.name === "subagents") continue;
        await visit(filePath, depth - 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const info = await stat(filePath);
        if (!info.isFile() || info.mtimeMs < input.cutoffMs) continue;
        out.push({
          path: filePath,
          project: (input.mirror ? claudeProjectForPath(filePath, [{ root: input.root, mirror: true }])?.folder : undefined) ?? extractProjectName(filePath),
          agent: input.mirror ? input.agent : detectAgent(filePath, input.agent),
          modifiedAt: info.mtimeMs,
          sizeBytes: info.size,
          lineCount: 0,
        });
      } catch {
        // Ignore files that disappear while scanning.
      }
    }
  }
  await visit(input.root, input.maxDepth);
  return out;
}

async function scanSessionFilesLocal(input: SessionFileScanKey, ctx: ProbeCtx): Promise<SessionFileRecord[]> {
  const normalized = normalizeScanKey(input);
  const cutoffMs = Date.now() - normalized.maxAgeDays * 24 * 60 * 60_000;
  const roots = [
    ...claudeProjectRoots(normalized.home!).map((entry) => ({ ...entry, agent: "claude-code", maxDepth: 8, skipSubagents: true })),
    { root: join(normalized.home!, ".codex"), agent: "codex", maxDepth: 8, skipSubagents: true },
    { root: join(normalized.home!, ".openai-codex"), agent: "codex", maxDepth: 8, skipSubagents: true },
  ];
  const results: SessionFileRecord[] = [];
  const cap = Math.max(normalized.limit * 4, normalized.limit + 100);

  for (const root of roots) {
    if (!(await directoryExists(root.root))) continue;
    results.push(...await scanJsonlFiles({
      ...root,
      cutoffMs,
      signal: ctx.signal,
      cap,
    }));
  }

  if (normalized.workspaceRoot && await directoryExists(normalized.workspaceRoot)) {
    const existing = new Set(results.map((result) => result.path));
    const workspaceResults = await scanJsonlFiles({
      root: normalized.workspaceRoot,
      agent: "unknown",
      cutoffMs,
      maxDepth: 4,
      skipSubagents: false,
      signal: ctx.signal,
      cap,
    });
    for (const result of workspaceResults) {
      if (existing.has(result.path)) continue;
      existing.add(result.path);
      results.push(result);
    }
  }

  results.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return results.slice(0, normalized.limit);
}

async function searchFile(path: string, query: string, signal: AbortSignal): Promise<{ count: number; preview: string[] }> {
  const needle = query.toLowerCase();
  let count = 0;
  const preview: string[] = [];
  const stream = createReadStream(path, { encoding: "utf8" });
  signal.addEventListener("abort", () => stream.destroy(signal.reason as Error | undefined), { once: true });
  const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of reader) {
      if (signal.aborted) break;
      if (!String(line).toLowerCase().includes(needle)) continue;
      count += 1;
      if (preview.length < 3) {
        preview.push(String(line));
      }
    }
  } catch {
    return { count: 0, preview: [] };
  }
  return { count, preview };
}

async function searchSessionFilesLocal(input: SessionSearchKey, ctx: ProbeCtx): Promise<SessionSearchMatch[]> {
  const query = input.query.trim();
  if (!query) return [];
  const candidateLimit = positiveInteger(input.candidateLimit, Math.max(input.limit * 10, 1000), 20_000);
  const sessions = await scanSessionFilesLocal({ ...input, limit: candidateLimit }, ctx);
  const matches: SessionSearchMatch[] = [];
  for (const session of sessions) {
    if (ctx.signal.aborted) break;
    const result = await searchFile(session.path, query, ctx.signal);
    if (result.count <= 0) continue;
    matches.push({
      path: session.path,
      project: session.project,
      agent: session.agent,
      matchCount: result.count,
      preview: result.preview,
    });
  }
  matches.sort((a, b) => b.matchCount - a.matchCount);
  return matches.slice(0, positiveInteger(input.limit, 50, 10_000));
}

export const sessionsScanProbe = defineProbeFamily<SessionFileScanKey, SessionFileRecord[]>({
  id: "sessions.scan",
  ttlMs: 10_000,
  timeoutMs: 10_000,
  maxKeys: 64,
  idleKeyTtlMs: 5 * 60_000,
  maxConcurrentKeys: 2,
  normalizeKey: normalizeSessionFileScanKey,
  run: (key, ctx) => scanSessionFilesLocal(parseKey<SessionFileScanKey>(key), ctx),
});

export const sessionsSearchProbe = defineProbeFamily<SessionSearchKey, SessionSearchMatch[]>({
  id: "sessions.search",
  ttlMs: 10_000,
  timeoutMs: 10_000,
  maxKeys: 128,
  idleKeyTtlMs: 5 * 60_000,
  maxConcurrentKeys: 2,
  normalizeKey: normalizeSessionSearchKey,
  run: (key, ctx) => searchSessionFilesLocal(parseKey<SessionSearchKey>(key), ctx),
});

export async function readSessionFileScan(input: SessionFileScanKey, maxAgeMs = 10_000): Promise<SessionFileRecord[]> {
  const snapshot = await sessionsScanProbe.for(input).fresh({ maxAgeMs });
  return snapshot.value ?? [];
}

export async function readSessionSearch(input: SessionSearchKey, maxAgeMs = 10_000): Promise<SessionSearchMatch[]> {
  const snapshot = await sessionsSearchProbe.for(input).fresh({ maxAgeMs });
  return snapshot.value ?? [];
}
