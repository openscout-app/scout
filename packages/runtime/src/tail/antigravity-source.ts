import { redactSecrets } from "@openscout/agent-sessions/secret-redaction";
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { redactDiagnosticText } from "../diagnostic-report.js";
import { oneLine } from "./tool-format.js";
import { execSystemFile } from "../system-probes/exec.js";
import { buildParentChain, classifyAttribution, commandBasename, listProcesses, processResourceFields, readCwd } from "./discover.js";
import type { DiscoveredProcess, DiscoveredTranscript, TailContext, TailDiscoveryScope, TailEvent, ParsedTailEvents, AnyTranscriptSource } from "./types.js";

const SOURCE = "antigravity";
const nativeId = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu;

export function antigravityIdFromLogPath(path: string): string | null {
  const logs = dirname(path), generated = dirname(logs), session = dirname(generated);
  const id = basename(session);
  return basename(path) === "transcript.jsonl" && basename(logs) === "logs" &&
    basename(generated) === ".system_generated" && basename(dirname(session)) === "brain" && nativeId.test(id) ? id : null;
}

function dataRoot(): string {
  return process.env.OPENSCOUT_TAIL_ANTIGRAVITY_ROOT?.trim() || join(homedir(), ".gemini", "antigravity-cli");
}

function bound(scope: TailDiscoveryScope, setting: string, fallback: number): number {
  const value = Number(process.env[`OPENSCOUT_TAIL_${scope.toUpperCase()}_DISCOVERY_${setting}`] ??
    process.env[`OPENSCOUT_TAIL_DISCOVERY_${setting}`]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

type SessionMeta = { title: string | null; workspace_uris: string | null; status: string | null; last_modified_time: string | null };

function workspace(uris: string | null): string | null {
  if (!uris) return null;
  try {
    const paths: unknown = JSON.parse(uris);
    if (Array.isArray(paths)) {
      for (const uri of paths) {
        if (typeof uri === "string" && uri.startsWith("file://")) return fileURLToPath(uri);
      }
    }
  } catch { /* An unknown workspace leaves the session unassigned. */ }
  return null;
}

function transcript(id: string): DiscoveredTranscript | null {
  if (!nativeId.test(id)) return null;
  const path = join(dataRoot(), "brain", id, ".system_generated", "logs", "transcript.jsonl");
  const file = statSync(path, { throwIfNoEntry: false });
  if (!file?.isFile() || file.size === 0) return null;
  return { source: SOURCE, sessionId: id, transcriptPath: path, cwd: null, project: "", harness: "unattributed",
    mtimeMs: file.mtimeMs, size: file.size };
}

// The JSONL file is the activity clock. The shared index can change for an unrelated conversation.
function enrich(rows: DiscoveredTranscript[]): DiscoveredTranscript[] {
  if (!rows.length) return rows;
  const path = join(dataRoot(), "conversation_summaries.db");
  if (!existsSync(path)) return rows;
  // Prefer the live WAL. A checkpointed WAL-mode database without sidecars can
  // require an immutable read on a read-only connection; close it after this pass.
  for (const filename of [path, pathToFileURL(path).href + "?immutable=1"]) {
    if (filename !== path && existsSync(path + "-wal")) break;
    let db: Database | undefined;
    try {
      db = new Database(filename, { readonly: true, create: false });
      const query = db.query("SELECT title, workspace_uris, status, last_modified_time FROM conversation_summaries WHERE conversation_id = ?");
      for (const row of rows) {
        const meta = query.get(row.sessionId!) as SessionMeta | null;
        if (!meta) continue;
        row.title = meta.title?.trim() || null;
        row.cwd = workspace(meta.workspace_uris);
        row.project = row.cwd ? basename(row.cwd) : "";
        row.status = meta.status === "CASCADE_RUN_STATUS_IDLE" ? "idle" : meta.status === "CASCADE_RUN_STATUS_RUNNING" ? "busy" : null;
        const time = Date.parse(meta.last_modified_time ?? "");
        row.statusUpdatedAt = row.status && Number.isFinite(time) && time > 0 ? time : null;
      }
      break;
    } catch { /* A missing, locked or older index does not prevent reading native transcripts. */ }
    finally { db?.close(); }
  }
  return rows;
}

function discover(_processes: DiscoveredProcess[], scope: TailDiscoveryScope = "shallow"): DiscoveredTranscript[] {
  const brain = join(dataRoot(), "brain");
  if (!existsSync(brain)) return [];
  const cutoff = Date.now() - bound(scope, "WINDOW_MS", scope === "hot" ? 600_000 : 86_400_000);
  const limit = bound(scope, "LIMIT", scope === "hot" ? 96 : 256);
  const rows: DiscoveredTranscript[] = [];
  for (const entry of readdirSync(brain, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const row = transcript(entry.name);
    if (row && row.mtimeMs >= cutoff) rows.push(row);
  }
  return enrich(rows.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit));
}

async function processes(): Promise<DiscoveredProcess[]> {
  const all = await listProcesses();
  const clients = all.filter(p => commandBasename(p.command) === "agy");
  if (!clients.length) return [];
  const byPid = new Map(all.map(p => [p.pid, p]));
  const presence = join(dataRoot(), "presence");
  const held = new Map<number, Set<string>>();
  // Old lock files can survive an exit. Only an open native lock identifies this process's session.
  if (existsSync(presence)) {
    try {
      const { stdout } = await execSystemFile("lsof", ["-nP", "-p", clients.map(p => p.pid).join(","), "-Fpn"],
        { timeoutMs: 1500, maxStdoutBytes: 512 * 1024 });
      let pid = 0;
      for (const field of stdout.split("\n")) {
        if (field.startsWith("p")) pid = Number(field.slice(1));
        if (!pid || !field.startsWith("n") || dirname(field.slice(1)) !== presence || !field.endsWith(".lock")) continue;
        const id = basename(field.slice(1), ".lock");
        if (!nativeId.test(id)) continue;
        const ids = held.get(pid) ?? new Set<string>();
        ids.add(id);
        held.set(pid, ids);
      }
    } catch { /* No lock evidence: report the client without binding it to a conversation. */ }
  }
  return Promise.all(clients.map(async p => {
    const parentChain = buildParentChain(p.pid, byPid);
    const ids = held.get(p.pid);
    return { pid: p.pid, ppid: p.ppid, command: "agy", etime: p.etime, ...processResourceFields(p),
      cwd: await readCwd(p.pid, p.etime), harness: classifyAttribution(parentChain), parentChain, source: SOURCE,
      nativeSessionId: ids?.size === 1 ? [...ids][0] : null };
  }));
}

type ToolCall = { id: string; name: string; summary: string };

// Keep only fields that describe the action. Edit bodies, MCP payloads and
// private planner fields are not part of a displayed tool call.
const actionKeys = [
  "CommandLine", "Path", "StartLine", "EndLine", "ByteOffset", "ToolName", "ServerName",
  "query", "domain", "Action", "TaskId", "Recipient", "Role", "ImageName", "CronExpression", "toolSummary",
] as const;

function cleanToolText(text: string): string {
  return redactDiagnosticText(redactSecrets(text));
}

// Plain Tail describes the outcome. File bodies, arbitrary stdout and MCP
// response payloads belong in the bounded, scrubbed raw details.
function resultSummary(name: string, status: string, output: string, error: string): string {
  if (status === "RUNNING") return "running";
  if (status === "ERROR") {
    const reason = /\b(?:ENOENT|EACCES|ETIMEDOUT|missing file|file not found|permission denied)\b/iu.exec(error || output);
    return reason ? `error · ${reason[0]}` : "error";
  }
  if (name === "run_command") {
    const command = /^Command exited with code (-?\d+)\.\s*(?:Command output:\s*)?/u.exec(output);
    if (command) {
      const stdout = output.slice(command[0].length).trim();
      if (!stdout) return `exit ${command[1]}`;
      const lines = stdout.split("\n");
      const diff = /^(?:\d+ files? changed)(?:, \d+ (?:insertions?\(\+\)|deletions?\(-\))){0,2}$/u.exec(lines.at(-1)!.trim());
      return `exit ${command[1]} · ${diff?.[0] ?? `${lines.length} output line${lines.length === 1 ? "" : "s"}`}`;
    }
  }
  if (name === "read_file") {
    const range = /^Showing lines (\d+)-(\d+)\b/u.exec(output);
    if (range) return `read lines ${range[1]}–${range[2]}`;
  }
  if (name === "edit_file") {
    const edits = /^Made (\d+) replacements?\b/u.exec(output);
    if (edits) return `${edits[1]} replacement${edits[1] === "1" ? "" : "s"}`;
  }
  if (name === "write_file" && output.startsWith("Created file")) return "created file";
  return status === "DONE" ? "done" : "result received";
}

function describeCall(name: string, args: Record<string, unknown>) {
  const input: Record<string, string | number> = {};
  for (const key of actionKeys) {
    const value = args[key];
    if (typeof value === "string") input[key] = cleanToolText(value);
    else if (typeof value === "number" && Number.isFinite(value)) input[key] = value;
  }
  let subject = input.CommandLine ?? input.Path ?? input.query ?? input.Action ?? input.Recipient
    ?? input.Role ?? input.ImageName ?? input.CronExpression ?? input.toolSummary;
  if (input.ToolName) subject = [input.ServerName, input.ToolName].filter(Boolean).join(".");
  if (input.Path && input.StartLine != null) {
    subject = `${input.Path}:${input.StartLine}${input.EndLine != null ? `-${input.EndLine}` : ""}`;
  }
  return { input, summary: subject ? oneLine(`${name} · ${subject}`) : name };
}

function parseLine(line: string, ctx: TailContext): ParsedTailEvents {
  let step;
  try { step = JSON.parse(line); } catch { return null; }
  if (!step || !Number.isSafeInteger(step.step_index) || step.step_index < 0) return null;
  const ts = Date.parse(step.created_at);
  const sessionId = ctx.transcript.sessionId;
  if (!sessionId || !Number.isFinite(ts)) return null;
  const content = typeof step.content === "string" ? step.content.trim() : "";
  const id = `${SOURCE}:${sessionId}:${step.step_index}`;
  const event = (kind: TailEvent["kind"], summary: string, raw: unknown, eventId = id): TailEvent => ({
    id: eventId, ts, sessionId, source: SOURCE, kind, summary: stripVTControlCharacters(redactSecrets(summary)).slice(0, 500), raw,
    pid: ctx.process.pid, parentPid: ctx.process.ppid || null,
    cwd: ctx.transcript.cwd ?? "", project: ctx.transcript.project, harness: ctx.process.harness,
  });

  // The N tool calls in a planner step own the next N native step indexes.
  // Key by index so a missing line cannot shift a result onto another call.
  const state = ctx.state;
  if (state && step.type !== "GENERIC") delete state.pendingAntigravityCalls;
  switch (step.type) {
    case "USER_INPUT": {
      if (step.source !== "USER_EXPLICIT") return null;
      const request = /<USER_REQUEST>([\s\S]*?)(?:<\/USER_REQUEST>|<ADDITIONAL_METADATA>|$)/u.exec(content);
      const text = (request?.[1] ?? content.split("<ADDITIONAL_METADATA>", 1)[0]).trim();
      return text ? event("user", text, { content: text }) : null;
    }
    case "PLANNER_RESPONSE": {
      const events = content ? [event("assistant", content, { content })] : [];
      if (!Array.isArray(step.tool_calls)) return events;
      const pending = new Map<number, ToolCall>();
      for (const [i, call] of step.tool_calls.entries()) {
        if (typeof call?.name !== "string" || !call.name.trim()) continue;
        const name = redactSecrets(call.name.trim());
        const { summary, input } = describeCall(name, call.args ?? {});
        // Preserve the existing cursor on the first visible event of a step.
        const callId = events.length ? `${id}:call:${String(i).padStart(6, "0")}` : id;
        pending.set(step.step_index + i + 1, { id: callId, name, summary });
        events.push(event("tool", summary, { tool_name: name, tool_use_id: callId, input }, callId));
      }
      if (state) state.pendingAntigravityCalls = pending;
      return events;
    }
    case "GENERIC": {
      // Tool results are MODEL steps with a native timestamp envelope. A
      // bounded replay can start here, before the planner line is available.
      if (step.source !== "MODEL" || !/^Created At: \d{4}-\d{2}-\d{2}T/u.test(content)) return null;
      const pending = state?.pendingAntigravityCalls as Map<number, ToolCall> | undefined;
      const call = pending?.get(step.step_index);
      pending?.delete(step.step_index);
      const body = content.replace(/^(?:(?:Created|Completed) At: [^\n]*(?:\n|$))+/u, "").trim();
      const output = cleanToolText(body);
      const error = typeof step.error === "string" ? cleanToolText(step.error) : "";
      const status = typeof step.status === "string" ? step.status : "";
      const name = call?.name ?? "tool";
      const preview = resultSummary(name, status, output, error);
      return event("tool-result", `${name} → ${preview}`, {
        status, output, ...(error && { error }), ...(call && { tool_name: name, tool_use_id: call.id, call: call.summary }),
      });
    }
    case "ERROR_MESSAGE": {
      const text = typeof step.error === "string" ? step.error : "Antigravity reported an error";
      return event("system", text, { content: text });
    }
    default: return null;
  }
}

export const AntigravitySource: AnyTranscriptSource = {
  name: SOURCE, discoverProcesses: processes, discoverTranscripts: discover, parseLine,
  findTranscript(id) {
    const row = transcript(id);
    return row ? enrich([row])[0] : null;
  },
};
