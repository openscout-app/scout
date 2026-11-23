/**
 * Claude Managed Agents sessions, read from the Scout Hub mirror that the
 * runtime's puller writes (see ../hub/managed-agents.ts). Each session is one
 * JSONL file of raw API events in server order, with a `.session.json` sidecar
 * holding its title, status and agent. Nothing runs locally, so there are no
 * processes to discover.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { resolveManagedAgentsMirrorRoot, type ManagedAgentsSessionMeta } from "../hub/state.js";
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

const SOURCE_NAME = "managed-agents";
const MAX_SUMMARY_LEN = 200;
const WINDOW_MS: Record<TailDiscoveryScope, number> = { hot: 10 * 60_000, shallow: 24 * 3_600_000, deep: 7 * 24 * 3_600_000 };
const LIMIT: Record<TailDiscoveryScope, number> = { hot: 64, shallow: 160, deep: 160 };

type JsonRecord = Record<string, unknown>;

function mirrorRoot(): string | null {
  // Tests that point the Claude source at a temp folder must not read this
  // host's mirror, the same rule as the Claude Hub mirror.
  const explicit = process.env.OPENSCOUT_HUB_MANAGED_AGENTS_MIRROR_ROOT?.trim();
  if (explicit) return explicit;
  if (process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT?.trim()) return null;
  return resolveManagedAgentsMirrorRoot();
}

function clip(text: string): string {
  const one = text.replace(/\s+/gu, " ").trim();
  return one.length > MAX_SUMMARY_LEN ? `${one.slice(0, MAX_SUMMARY_LEN - 1)}…` : one;
}

function readMeta(eventsPath: string): ManagedAgentsSessionMeta | null {
  try {
    return JSON.parse(readFileSync(eventsPath.replace(/\.jsonl$/u, ".session.json"), "utf8")) as ManagedAgentsSessionMeta;
  } catch {
    return null;
  }
}

function statusFor(meta: ManagedAgentsSessionMeta | null): DiscoveredTranscript["status"] {
  if (!meta) return null;
  if (meta.status === "running" || meta.status === "rescheduling") return "busy";
  if (meta.status === "idle") return "idle";
  return null;
}

function transcriptFor(path: string, mtimeMs: number, size: number): DiscoveredTranscript {
  const meta = readMeta(path);
  const label = basename(dirname(path));
  const sessionId = basename(path, ".jsonl");
  const updatedAt = meta ? Date.parse(meta.updatedAt) : Number.NaN;
  return {
    source: SOURCE_NAME,
    transcriptPath: path,
    sessionId,
    cwd: null,
    // A managed session has no repo; its agent is what it belongs to.
    project: meta?.agent?.name || label,
    title: meta?.title ?? null,
    agentName: meta?.agent?.name ?? null,
    status: statusFor(meta),
    statusUpdatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
    harness: "unattributed",
    lastEventAt: Number.isFinite(updatedAt) ? updatedAt : null,
    mtimeMs,
    size,
  };
}

function listMirrorFiles(root: string): Array<{ path: string; mtimeMs: number; size: number }> {
  const found: Array<{ path: string; mtimeMs: number; size: number }> = [];
  let labels: string[] = [];
  try { labels = readdirSync(root); } catch { return found; }
  for (const label of labels) {
    let names: string[] = [];
    try { names = readdirSync(join(root, label)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(root, label, name);
      try {
        const stats = statSync(path);
        if (stats.isFile()) found.push({ path, mtimeMs: stats.mtimeMs, size: stats.size });
      } catch { /* removed while listing */ }
    }
  }
  return found;
}

function discoverManagedAgentsTranscripts(scope: TailDiscoveryScope): DiscoveredTranscript[] {
  const root = mirrorRoot();
  if (!root || !existsSync(root)) return [];
  const cutoff = Date.now() - WINDOW_MS[scope];
  return listMirrorFiles(root)
    .filter((file) => file.mtimeMs >= cutoff)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, LIMIT[scope])
    .map((file) => transcriptFor(file.path, file.mtimeMs, file.size));
}

function findManagedAgentsTranscript(sessionRef: string): DiscoveredTranscript | null {
  const root = mirrorRoot();
  const ref = sessionRef.trim();
  if (!root || !ref || ref.includes("/") || ref.includes("..")) return null;
  for (const file of listMirrorFiles(root)) {
    if (basename(file.path, ".jsonl") === ref) return transcriptFor(file.path, file.mtimeMs, file.size);
  }
  return null;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const value = block as JsonRecord;
    if (value.type === "text" && typeof value.text === "string" && value.text.trim()) parts.push(value.text.trim());
    else if (value.type === "image") parts.push("[image]");
    else if (value.type === "document") parts.push("[document]");
  }
  return parts.join(" ");
}

function callNames(ctx: TailContext): Map<string, string> {
  const state = (ctx.state ??= {});
  if (!(state.calls instanceof Map)) state.calls = new Map<string, string>();
  return state.calls as Map<string, string>;
}

function summarize(event: JsonRecord, ctx: TailContext): { kind: TailEventKind; summary: string } | null {
  const type = typeof event.type === "string" ? event.type : "";
  switch (type) {
    case "user.message":
      return { kind: "user", summary: clip(textOf(event.content) || "[user]") };
    case "agent.message":
      return { kind: "assistant", summary: clip(textOf(event.content) || "[assistant]") };
    case "agent.tool_use":
    case "agent.mcp_tool_use":
    case "agent.custom_tool_use": {
      const name = typeof event.name === "string" ? event.name : "tool";
      const summary = formatToolCall(name, event.input);
      if (typeof event.id === "string") callNames(ctx).set(event.id, summary);
      return { kind: "tool", summary: clip(type === "agent.mcp_tool_use" && typeof event.mcp_server_name === "string" ? `${event.mcp_server_name}: ${summary}` : summary) };
    }
    case "agent.tool_result":
    case "agent.mcp_tool_result":
    case "user.custom_tool_result": {
      const ref = typeof event.tool_use_id === "string" ? event.tool_use_id
        : typeof event.mcp_tool_use_id === "string" ? event.mcp_tool_use_id
          : typeof event.custom_tool_use_id === "string" ? event.custom_tool_use_id : null;
      const result = formatToolResult(textOf(event.content), ref ? callNames(ctx).get(ref) : null);
      return { kind: "tool-result", summary: clip(event.is_error ? `error: ${result}` : result) };
    }
    case "session.error": {
      const error = event.error && typeof event.error === "object" ? event.error as JsonRecord : {};
      const detail = typeof error.message === "string" ? error.message : typeof error.type === "string" ? error.type : "error";
      return { kind: "system", summary: clip(`session error: ${detail}`) };
    }
    case "session.status_idle": {
      const reason = event.stop_reason && typeof event.stop_reason === "object" ? (event.stop_reason as JsonRecord).type : null;
      return { kind: "system", summary: typeof reason === "string" ? `idle (${reason})` : "idle" };
    }
    case "session.status_terminated":
      return { kind: "system", summary: "session ended" };
    case "agent.thread_context_compacted":
      return { kind: "system", summary: "context compacted" };
    case "session.thread_created":
      return { kind: "system", summary: "thread started" };
    default:
      // Running markers, spans, usage snapshots and thinking signals carry no
      // content worth a row.
      return null;
  }
}

function parseManagedAgentsLine(line: string, ctx: TailContext): TailEvent | null {
  let event: JsonRecord;
  try {
    const parsed = JSON.parse(line.trim()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    event = parsed as JsonRecord;
  } catch {
    return null;
  }
  const parsed = summarize(event, ctx);
  if (!parsed) return null;
  const sessionId = ctx.transcript.sessionId ?? basename(ctx.transcriptPath, ".jsonl");
  const ts = typeof event.processed_at === "string" ? Date.parse(event.processed_at) : Number.NaN;
  const id = typeof event.id === "string" && event.id ? event.id : String(ctx.lineOffset);
  return {
    id: `${SOURCE_NAME}:${sessionId}:${id}`,
    ts: Number.isFinite(ts) ? ts : Date.now(),
    source: SOURCE_NAME,
    sessionId,
    pid: ctx.process.pid,
    parentPid: ctx.process.ppid || null,
    project: ctx.transcript.project,
    cwd: "",
    harness: ctx.process.harness,
    kind: parsed.kind,
    summary: parsed.summary,
    raw: event,
  };
}

export const ManagedAgentsSource: TranscriptSource = {
  name: SOURCE_NAME,
  discoverProcesses(): DiscoveredProcess[] {
    return [];
  },
  discoverTranscripts(_processes: DiscoveredProcess[], scope: TailDiscoveryScope = "shallow"): DiscoveredTranscript[] {
    return discoverManagedAgentsTranscripts(scope);
  },
  parseLine(line: string, ctx: TailContext): TailEvent | null {
    return parseManagedAgentsLine(line, ctx);
  },
  findTranscript(sessionRef: string): DiscoveredTranscript | null {
    return findManagedAgentsTranscript(sessionRef);
  },
};
