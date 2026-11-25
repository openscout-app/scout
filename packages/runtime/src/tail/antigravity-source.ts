import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execSystemFile } from "../system-probes/exec.js";
import { buildParentChain, classifyAttribution, commandBasename, listProcesses, processResourceFields, readCwd } from "./discover.js";
import type { DiscoveredProcess, DiscoveredTranscript, TailContext, TailDiscoveryScope, TailEvent, TranscriptSource } from "./types.js";

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

function parseLine(line: string, ctx: TailContext): TailEvent | null {
  let step;
  try { step = JSON.parse(line); } catch { return null; }
  if (!step || !Number.isSafeInteger(step.step_index) || step.step_index < 0) return null;
  const ts = Date.parse(step.created_at);
  const sessionId = ctx.transcript.sessionId;
  if (!sessionId || !Number.isFinite(ts)) return null;
  const content = typeof step.content === "string" ? step.content.trim() : "";
  let kind: TailEvent["kind"];
  let text: string;
  switch (step.type) {
    case "USER_INPUT": {
      if (step.source !== "USER_EXPLICIT") return null;
      const request = /<USER_REQUEST>([\s\S]*?)(?:<\/USER_REQUEST>|<ADDITIONAL_METADATA>|$)/u.exec(content);
      text = (request?.[1] ?? content.split("<ADDITIONAL_METADATA>", 1)[0]).trim();
      kind = "user";
      break;
    }
    case "PLANNER_RESPONSE": {
      const tools = Array.isArray(step.tool_calls) ? step.tool_calls.flatMap((call: { name?: string } | null) =>
        typeof call?.name === "string" ? [call.name] : []) : [];
      kind = content ? "assistant" : "tool";
      text = content || tools.join(", ");
      break;
    }
    case "ERROR_MESSAGE":
      kind = "system";
      text = typeof step.error === "string" ? step.error : "Antigravity reported an error";
      break;
    default: return null;
  }
  if (!text) return null;
  return { id: `${SOURCE}:${sessionId}:${step.step_index}`, ts, sessionId, source: SOURCE, kind,
    summary: text.slice(0, 500), raw: { content: text }, pid: ctx.process.pid, parentPid: ctx.process.ppid || null,
    cwd: ctx.transcript.cwd ?? "", project: ctx.transcript.project, harness: ctx.process.harness };
}

export const AntigravitySource: TranscriptSource = {
  name: SOURCE, discoverProcesses: processes, discoverTranscripts: discover, parseLine,
  findTranscript(id) {
    const row = transcript(id);
    return row ? enrich([row])[0] : null;
  },
};
