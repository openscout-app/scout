/**
 * Locate harness-native sessions on disk (T3 rung for flat session dispatch).
 *
 * A session known to its harness but not to the broker is still addressable:
 * resolve live endpoints first, then fall back here before declaring unknown.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import type { AgentHarness } from "@openscout/protocol";

import { expandHomePath } from "./tool-resolution.js";

export type LocatedHarnessSession = {
  harness: AgentHarness;
  nativeSessionId: string;
  cwd: string;
  path: string;
  lastActivityAt: number;
  /** How the id matched (filename, session_meta id, session_meta session_id, …). */
  match: string;
};

export type SessionLocateFailureReason =
  | "session_unknown"
  | "session_ambiguous_harness"
  | "session_cwd_conflict"
  | "session_not_resumable";

export type SessionLocateResult =
  | { ok: true; session: LocatedHarnessSession }
  | {
      ok: false;
      reason: SessionLocateFailureReason;
      detail: string;
      candidates?: LocatedHarnessSession[];
      remediation?: string;
    };

export type SessionLocateInput = {
  nativeSessionId: string;
  harness?: AgentHarness | string | null;
  /** Caller-supplied project/cwd (--project). Required for Codex when store cwd missing. */
  projectPath?: string | null;
  homeDir?: string;
  /** Test seam: override roots instead of ~/.codex/sessions and ~/.claude/projects. */
  codexSessionsRoot?: string;
  claudeProjectsRoot?: string;
};

const CODEX_HARNESS: AgentHarness = "codex";
const CLAUDE_HARNESS: AgentHarness = "claude";

function normalizeSessionId(value: string): string {
  return value.trim();
}

function pathExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function safeStatMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function walkFiles(root: string, predicate: (name: string) => boolean, into: string[] = [], depth = 0): string[] {
  if (depth > 8 || !pathExists(root)) return into;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return into;
  }
  for (const name of entries) {
    if (name === "." || name === ".." || name.startsWith(".")) continue;
    const full = join(root, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      walkFiles(full, predicate, into, depth + 1);
    } else if (predicate(name)) {
      into.push(full);
    }
  }
  return into;
}

function readFirstJsonlRecords(path: string, maxLines = 8): unknown[] {
  let text: string;
  try {
    // Session meta is always near the top; avoid reading multi-MB rollouts fully.
    const fdChunk = readFileSync(path, { encoding: "utf8" });
    text = fdChunk.length > 256_000 ? fdChunk.slice(0, 256_000) : fdChunk;
  } catch {
    return [];
  }
  const records: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      continue;
    }
    if (records.length >= maxLines) break;
  }
  return records;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function extractCodexMeta(path: string): { ids: string[]; cwd?: string } {
  const ids = new Set<string>();
  const base = basename(path);
  // rollout-…-<uuid>.jsonl
  const fromName = base.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  if (fromName?.[1]) ids.add(fromName[1]);

  let cwd: string | undefined;
  for (const record of readFirstJsonlRecords(path)) {
    if (!record || typeof record !== "object") continue;
    const type = stringField(record, "type");
    const payload = (record as { payload?: unknown }).payload;
    if (type === "session_meta" || type === "session_start") {
      for (const key of ["id", "session_id", "sessionId", "thread_id", "threadId"] as const) {
        const id = stringField(payload, key) ?? stringField(record, key);
        if (id) ids.add(id);
      }
      cwd = stringField(payload, "cwd") ?? stringField(record, "cwd") ?? cwd;
    }
  }
  return { ids: [...ids], ...(cwd ? { cwd } : {}) };
}

function extractClaudeMeta(path: string): { ids: string[]; cwd?: string } {
  const ids = new Set<string>();
  const base = basename(path, ".jsonl");
  if (base) ids.add(base);

  let cwd: string | undefined;
  for (const record of readFirstJsonlRecords(path, 12)) {
    if (!record || typeof record !== "object") continue;
    for (const key of ["sessionId", "session_id", "id"] as const) {
      const id = stringField(record, key);
      if (id) ids.add(id);
    }
    const cwdValue = stringField(record, "cwd");
    if (cwdValue) cwd = cwdValue;
  }

  // Claude stores under ~/.claude/projects/<slug>/<id>.jsonl — slug encodes cwd.
  const parent = basename(resolve(path, ".."));
  if (parent.startsWith("-")) {
    // e.g. -Users-art-dev-openscout → /Users/art/dev/openscout (best-effort)
    const guessed = parent.replace(/^-/, "/").replace(/-/g, "/");
    if (guessed.startsWith("/") && guessed.length > 1 && pathIsDirectory(guessed)) {
      cwd = cwd ?? guessed;
    }
  }

  return { ids: [...ids], ...(cwd ? { cwd } : {}) };
}

function locateCodexSessions(root: string, nativeSessionId: string): LocatedHarnessSession[] {
  if (!pathExists(root)) return [];
  const needle = normalizeSessionId(nativeSessionId).toLowerCase();
  const files = walkFiles(root, (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"));
  const hits: LocatedHarnessSession[] = [];
  for (const path of files) {
    const meta = extractCodexMeta(path);
    const matched = meta.ids.find((id) => id.toLowerCase() === needle);
    if (!matched) continue;
    const cwd = meta.cwd?.trim() || "";
    hits.push({
      harness: CODEX_HARNESS,
      nativeSessionId: matched,
      cwd,
      path,
      lastActivityAt: safeStatMtimeMs(path),
      match: meta.ids[0] === matched && basename(path).includes(matched) ? "filename+meta" : "session_meta",
    });
  }
  return hits;
}

function locateClaudeSessions(root: string, nativeSessionId: string): LocatedHarnessSession[] {
  if (!pathExists(root)) return [];
  const needle = normalizeSessionId(nativeSessionId).toLowerCase();
  const files = walkFiles(root, (name) => name.endsWith(".jsonl"));
  const hits: LocatedHarnessSession[] = [];
  for (const path of files) {
    const meta = extractClaudeMeta(path);
    const matched = meta.ids.find((id) => id.toLowerCase() === needle);
    if (!matched) continue;
    hits.push({
      harness: CLAUDE_HARNESS,
      nativeSessionId: matched,
      cwd: meta.cwd?.trim() || "",
      path,
      lastActivityAt: safeStatMtimeMs(path),
      match: basename(path, ".jsonl").toLowerCase() === needle ? "filename" : "jsonl",
    });
  }
  return hits;
}

function normalizeHarness(value: string | null | undefined): AgentHarness | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (trimmed === "codex" || trimmed === "claude" || trimmed === "pi" || trimmed === "grok" || trimmed === "kimi") {
    return trimmed as AgentHarness;
  }
  return undefined;
}

function pathsEqual(left: string, right: string): boolean {
  try {
    return resolve(expandHomePath(left)) === resolve(expandHomePath(right));
  } catch {
    return left === right;
  }
}

/**
 * Locate one exact harness session on disk.
 * Prefer harness-qualified lookups; fail closed on multi-harness hits.
 */
export function locateHarnessSession(input: SessionLocateInput): SessionLocateResult {
  const nativeSessionId = normalizeSessionId(input.nativeSessionId);
  if (!nativeSessionId) {
    return {
      ok: false,
      reason: "session_unknown",
      detail: "session id is empty",
      remediation: "pass session:<harness>:<native-id>",
    };
  }

  const home = input.homeDir?.trim() || homedir();
  const codexRoot = input.codexSessionsRoot?.trim() || join(home, ".codex", "sessions");
  const claudeRoot = input.claudeProjectsRoot?.trim() || join(home, ".claude", "projects");
  const requestedHarness = normalizeHarness(input.harness ?? undefined);
  const projectPath = input.projectPath?.trim() || undefined;

  const candidates: LocatedHarnessSession[] = [];
  if (!requestedHarness || requestedHarness === CODEX_HARNESS) {
    candidates.push(...locateCodexSessions(codexRoot, nativeSessionId));
  }
  if (!requestedHarness || requestedHarness === CLAUDE_HARNESS) {
    candidates.push(...locateClaudeSessions(claudeRoot, nativeSessionId));
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "session_unknown",
      detail: `no harness session store entry for ${nativeSessionId}`,
      remediation: requestedHarness
        ? `confirm the id is a ${requestedHarness} session, or pass session:${requestedHarness}:<id>`
        : "pass session:<harness>:<native-id> with --project <cwd> if known",
    };
  }

  const harnesses = [...new Set(candidates.map((c) => c.harness))];
  if (harnesses.length > 1) {
    return {
      ok: false,
      reason: "session_ambiguous_harness",
      detail: `session ${nativeSessionId} matches multiple harnesses: ${harnesses.join(", ")}`,
      candidates,
      remediation: `disambiguate with session:<harness>:${nativeSessionId}`,
    };
  }

  // Prefer most recently active store file.
  candidates.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const session = { ...candidates[0]! };

  // Codex resume requires cwd; prefer store cwd, then caller project.
  if (!session.cwd && projectPath) {
    session.cwd = resolve(expandHomePath(projectPath));
  }
  if (session.harness === CODEX_HARNESS && !session.cwd) {
    return {
      ok: false,
      reason: "session_not_resumable",
      detail: `codex session ${nativeSessionId} has no cwd in the rollout and no --project was provided`,
      candidates: [session],
      remediation: `retry with --project <cwd> or session:codex:${nativeSessionId} --project <cwd>`,
    };
  }

  if (projectPath && session.cwd && !pathsEqual(projectPath, session.cwd)) {
    return {
      ok: false,
      reason: "session_cwd_conflict",
      detail: `session cwd ${session.cwd} does not match --project ${resolve(expandHomePath(projectPath))}`,
      candidates: [session],
      remediation: `omit --project, or use --project ${session.cwd}`,
    };
  }

  if (session.cwd) {
    session.cwd = resolve(expandHomePath(session.cwd));
  }

  return { ok: true, session };
}

export function defaultCodexSessionsRoot(homeDir = homedir()): string {
  return join(homeDir, ".codex", "sessions");
}

export function defaultClaudeProjectsRoot(homeDir = homedir()): string {
  return join(homeDir, ".claude", "projects");
}

/** Slug decoding is lossy; never promote a nonexistent guess to a cwd. */
function pathIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
