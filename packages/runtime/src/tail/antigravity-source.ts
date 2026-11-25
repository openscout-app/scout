import { redactSecrets } from "@openscout/agent-sessions/secret-redaction";
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
  parseAntigravityQuestions,
  unwrapAntigravityToolArgs,
} from "@openscout/agent-sessions";
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

function dataRoots(): string[] {
  const configured = process.env.OPENSCOUT_TAIL_ANTIGRAVITY_ROOT?.trim();
  if (configured) return [configured];
  const home = homedir();
  return [
    join(home, ".gemini", "antigravity-cli"),
    join(home, ".gemini", "antigravity"),
    join(home, ".gemini", "antigravity-ide"),
  ];
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

function transcript(root: string, id: string): DiscoveredTranscript | null {
  if (!nativeId.test(id)) return null;
  const path = join(root, "brain", id, ".system_generated", "logs", "transcript.jsonl");
  const file = statSync(path, { throwIfNoEntry: false });
  if (!file?.isFile() || file.size === 0) return null;
  return { source: SOURCE, sessionId: id, transcriptPath: path, cwd: null, project: "", harness: "unattributed",
    mtimeMs: file.mtimeMs, size: file.size };
}

// The JSONL file is the activity clock. The shared index can change for an unrelated conversation.
function enrich(root: string, rows: DiscoveredTranscript[]): DiscoveredTranscript[] {
  if (!rows.length) return rows;
  const path = join(root, "conversation_summaries.db");
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
        row.status = meta.status === "CASCADE_RUN_STATUS_IDLE"
          ? "idle"
          : meta.status === "CASCADE_RUN_STATUS_RUNNING" || meta.status === "CASCADE_RUN_STATUS_BUSY"
            ? "busy"
            : null;
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
  const cutoff = Date.now() - bound(scope, "WINDOW_MS", scope === "hot" ? 600_000 : 86_400_000);
  const limit = bound(scope, "LIMIT", scope === "hot" ? 96 : 256);
  const byId = new Map<string, DiscoveredTranscript>();
  for (const root of dataRoots()) {
    const brain = join(root, "brain");
    if (!existsSync(brain)) continue;
    const rows: DiscoveredTranscript[] = [];
    for (const entry of readdirSync(brain, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const row = transcript(root, entry.name);
      if (row && row.mtimeMs >= cutoff) rows.push(row);
    }
    for (const row of enrich(root, rows)) {
      const existing = byId.get(row.sessionId!);
      if (!existing || row.mtimeMs > existing.mtimeMs) byId.set(row.sessionId!, row);
    }
  }
  return [...byId.values()].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

function isAntigravityProcess(command: string): boolean {
  const base = commandBasename(command).toLowerCase();
  return base === "agy" || base === "antigravity" || (base.startsWith("language_server_") && command.toLowerCase().includes("antigravity"));
}

async function processes(): Promise<DiscoveredProcess[]> {
  const all = await listProcesses();
  const clients = all.filter(p => isAntigravityProcess(p.command));
  if (!clients.length) return [];
  const byPid = new Map(all.map(p => [p.pid, p]));
  const presenceDirs = new Set(dataRoots().map(root => join(root, "presence")).filter(dir => existsSync(dir)));
  const held = new Map<number, Set<string>>();
  // Old lock files can survive an exit. Only an open native lock identifies this process's session.
  if (presenceDirs.size > 0) {
    try {
      const { stdout } = await execSystemFile("lsof", ["-nP", "-p", clients.map(p => p.pid).join(","), "-Fpn"],
        { timeoutMs: 1500, maxStdoutBytes: 512 * 1024 });
      let pid = 0;
      for (const field of stdout.split("\n")) {
        if (field.startsWith("p")) pid = Number(field.slice(1));
        if (!pid || !field.startsWith("n") || !presenceDirs.has(dirname(field.slice(1))) || !field.endsWith(".lock")) continue;
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
    const base = commandBasename(p.command);
    return { pid: p.pid, ppid: p.ppid, command: base.toLowerCase() === "agy" ? "agy" : base, etime: p.etime, ...processResourceFields(p),
      cwd: await readCwd(p.pid, p.etime), harness: classifyAttribution(parentChain), parentChain, source: SOURCE,
      nativeSessionId: ids?.size === 1 ? [...ids][0] : null };
  }));
}

type ToolDiffSummary = { add: number; del: number; preview: string };

function cleanStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cleanInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function singleLine(value: string, max = 240): string {
  const flat = value.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function computeEditDiff(target: string, replacement: string): ToolDiffSummary | undefined {
  const oldLines = target.split(/\r?\n/u);
  const newLines = replacement.split(/\r?\n/u);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const removed = oldLines.slice(prefix, oldEnd);
  const added = newLines.slice(prefix, newEnd);
  if (removed.length === 0 && added.length === 0) return undefined;
  const preview = [
    ...removed.slice(0, 8).map((line) => `-${line.slice(0, 160)}`),
    ...added.slice(0, 8).map((line) => `+${line.slice(0, 160)}`),
  ].join("\n");
  return { add: added.length, del: removed.length, preview };
}

function computeWriteDiff(fileContent: string): ToolDiffSummary | undefined {
  if (!fileContent) return undefined;
  const lines = fileContent.split(/\r?\n/u);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return undefined;
  const preview = lines.slice(0, 10).map((line) => `+${line.slice(0, 160)}`).join("\n");
  return { add: lines.length, del: 0, preview };
}

const SAFE_MCP_HINT_KEYS = [
  "query",
  "sessionRef",
  "target",
  "agent",
  "path",
  "uri",
  "Uri",
  "where",
  "channel",
  "id",
] as const;

function formatAntigravityToolEvent(
  rawName: string,
  rawArgs: unknown,
): { summary: string; raw: Record<string, unknown> } {
  const name = rawName.trim();
  const lower = name.toLowerCase();
  const args = unwrapAntigravityToolArgs(rawArgs);
  const path = cleanStr(args.Path)
    ?? cleanStr(args.TargetFile)
    ?? cleanStr(args.file_path)
    ?? cleanStr(args.path);

  switch (lower) {
    case "run_command":
    case "shell_exec": {
      const command = cleanStr(args.CommandLine) ?? cleanStr(args.command);
      const description = cleanStr(args.toolSummary) ?? cleanStr(args.description);
      const bypass = args.BypassSandbox === true || args.BypassSandbox === "true";
      const summary = command
        ? singleLine(command, 400)
        : description
          ? `Bash ${singleLine(description, 300)}`
          : name;
      return {
        summary,
        raw: {
          content: summary,
          tool: "Bash",
          toolName: name,
          ...(command ? { command: command.slice(0, 1000), arg: singleLine(command, 400) } : description ? { arg: singleLine(description, 300) } : {}),
          ...(description ? { description: singleLine(description, 300) } : {}),
          ...(bypass ? { bypassSandbox: true } : {}),
        },
      };
    }
    case "read_file":
    case "view_file": {
      const startLine = cleanInt(args.StartLine);
      const endLine = cleanInt(args.EndLine);
      const range = startLine && endLine ? `:${startLine}-${endLine}` : startLine ? `:${startLine}` : "";
      const arg = path ? `${path}${range}` : null;
      const summary = arg ? `Read ${arg}` : name;
      return {
        summary,
        raw: {
          content: summary,
          tool: "Read",
          toolName: name,
          ...(path ? { path } : {}),
          ...(arg ? { arg } : {}),
          ...(startLine ? { startLine } : {}),
          ...(endLine ? { endLine } : {}),
        },
      };
    }
    case "edit_file":
    case "file_change":
    case "code_action": {
      const target = typeof args.Target === "string" ? args.Target : null;
      const replacement = typeof args.Replacement === "string" ? args.Replacement : null;
      const diff = target !== null && replacement !== null ? computeEditDiff(target, replacement) : undefined;
      const summary = path ? `Edit ${path}` : name;
      return {
        summary,
        raw: {
          content: summary,
          tool: "Edit",
          toolName: name,
          ...(path ? { path, arg: path } : {}),
          ...(diff ? { diff } : {}),
        },
      };
    }
    case "write_file": {
      const fileContent = typeof args.Content === "string" ? args.Content : null;
      const diff = fileContent !== null ? computeWriteDiff(fileContent) : undefined;
      const summary = path ? `Write ${path}` : name;
      return {
        summary,
        raw: {
          content: summary,
          tool: "Write",
          toolName: name,
          ...(path ? { path, arg: path } : {}),
          ...(diff ? { diff } : {}),
        },
      };
    }
    case "search_web": {
      const query = cleanStr(args.query);
      const domain = cleanStr(args.domain);
      const arg = query ? (domain ? `${query} (${domain})` : query) : null;
      const summary = arg ? `WebSearch ${singleLine(arg, 300)}` : name;
      return {
        summary,
        raw: {
          content: summary,
          tool: "WebSearch",
          toolName: name,
          ...(arg ? { arg: singleLine(arg, 300) } : {}),
          ...(domain ? { domain } : {}),
        },
      };
    }
    case "read_url_content":
    case "open_browser_url": {
      const url = cleanStr(args.Url) ?? cleanStr(args.url);
      const summary = url ? `WebFetch ${url}` : name;
      return {
        summary,
        raw: {
          content: summary,
          tool: "WebFetch",
          toolName: name,
          ...(url ? { arg: url } : {}),
        },
      };
    }
    case "call_mcp_tool":
    case "mcp_tool": {
      const server = cleanStr(args.ServerName);
      const mcpTool = cleanStr(args.ToolName);
      const mcpArgs = unwrapAntigravityToolArgs(args.Arguments);
      let hint: string | null = null;
      for (const key of SAFE_MCP_HINT_KEYS) {
        const candidate = cleanStr(mcpArgs[key]);
        if (candidate) {
          hint = singleLine(candidate, 200);
          break;
        }
      }
      const toolId = server && mcpTool
        ? `mcp__${server}__${mcpTool}`
        : mcpTool
          ? `mcp__${mcpTool}`
          : name;
      const summary = hint ? `${toolId} ${hint}` : toolId;
      return {
        summary,
        raw: {
          content: summary,
          tool: toolId,
          toolName: name,
          ...(server ? { mcpServer: server } : {}),
          ...(mcpTool ? { mcpTool } : {}),
          ...(hint ? { arg: hint } : {}),
        },
      };
    }
    case "read_resource":
    case "list_resources": {
      const server = cleanStr(args.ServerName);
      const uri = cleanStr(args.Uri);
      const arg = uri ? (server ? `${server}:${uri}` : uri) : server;
      const tool = lower === "list_resources" ? "LS" : "Read";
      const summary = arg ? `${tool} ${arg}` : name;
      return {
        summary,
        raw: {
          content: summary,
          tool,
          toolName: name,
          ...(arg ? { arg } : {}),
        },
      };
    }
    case "invoke_subagent": {
      const role = cleanStr(args.Role) ?? cleanStr(args.TypeName);
      const prompt = cleanStr(args.Prompt);
      const arg = [role, prompt ? singleLine(prompt, 140) : null].filter(Boolean).join(" · ") || null;
      const summary = arg ? `Agent ${arg}` : "Agent subagent";
      return {
        summary,
        raw: {
          content: summary,
          tool: "Agent",
          toolName: name,
          ...(arg ? { arg } : {}),
        },
      };
    }
    case "define_subagent":
    case "manage_subagents":
    case "send_message": {
      const head = cleanStr(args.Name) ?? cleanStr(args.Action) ?? cleanStr(args.Recipient);
      const body = cleanStr(args.Description) ?? cleanStr(args.Message);
      const arg = [head, body ? singleLine(body, 120) : null].filter(Boolean).join(" · ") || null;
      const summary = arg ? `Agent ${arg}` : name;
      return {
        summary,
        raw: {
          content: summary,
          tool: "Agent",
          toolName: name,
          ...(arg ? { arg } : {}),
        },
      };
    }
    case "update_steps": {
      const rawSteps = Array.isArray(args.steps) ? args.steps : [];
      const cleanSteps = rawSteps
        .slice(0, 12)
        .flatMap((entry): Array<{ title: string; status: string }> => {
          const item = unwrapAntigravityToolArgs(entry);
          const title = cleanStr(item.title);
          const status = cleanStr(item.status) ?? "pending";
          return title ? [{ title: singleLine(title, 120), status }] : [];
        });
      const done = cleanSteps.filter((item) => item.status === "done").length;
      const active = cleanSteps.find((item) => item.status === "in_progress")
        ?? cleanSteps.find((item) => item.status !== "done")
        ?? cleanSteps.at(-1);
      const arg = cleanSteps.length > 0
        ? `${done}/${cleanSteps.length}${active ? ` · ${active.title}` : ""}`
        : null;
      const summary = arg ? `TodoWrite ${arg}` : "TodoWrite steps";
      return {
        summary,
        raw: {
          content: summary,
          tool: "TodoWrite",
          toolName: name,
          ...(arg ? { arg } : {}),
          ...(cleanSteps.length ? { steps: cleanSteps } : {}),
        },
      };
    }
    case "ask_question": {
      const questions = parseAntigravityQuestions(args.questions);
      const first = questions[0]?.question ?? cleanStr(args.question);
      const arg = first ? singleLine(first, 240) : null;
      const summary = arg ? `AskUserQuestion ${arg}` : "AskUserQuestion";
      return {
        summary,
        raw: {
          content: summary,
          tool: "AskUserQuestion",
          toolName: name,
          ...(arg ? { arg } : {}),
          ...(questions.length ? { questions } : {}),
        },
      };
    }
    case "manage_task":
    case "schedule":
    case "run_workflow":
    case "swarm": {
      const action = cleanStr(args.Action) ?? cleanStr(args.action) ?? cleanStr(args.Description) ?? cleanStr(args.Prompt);
      const target = cleanStr(args.TaskId) ?? cleanStr(args.name) ?? cleanStr(args.ScriptPath) ?? cleanStr(args.CronExpression);
      const arg = [action, target].filter(Boolean).map((item) => singleLine(item!, 120)).join(" · ") || null;
      const summary = arg ? `${name} ${arg}` : name;
      return {
        summary,
        raw: {
          content: summary,
          tool: name,
          toolName: name,
          ...(arg ? { arg } : {}),
        },
      };
    }
    default: {
      const searchDir = path
        ?? cleanStr(args.SearchPath)
        ?? cleanStr(args.SearchDirectory)
        ?? cleanStr(args.DirectoryPath);
      const query = cleanStr(args.Query) ?? cleanStr(args.Pattern) ?? cleanStr(args.query) ?? cleanStr(args.pattern);
      if (query) {
        const arg = searchDir ? `${singleLine(query, 120)} ${searchDir}` : singleLine(query, 200);
        const summary = `Grep ${arg}`;
        return { summary, raw: { content: summary, tool: "Grep", toolName: name, arg } };
      }
      if (searchDir) {
        const tool = /list|dir/iu.test(name) ? "LS" : "Read";
        const summary = `${tool} ${searchDir}`;
        return { summary, raw: { content: summary, tool, toolName: name, path: searchDir, arg: searchDir } };
      }
      return { summary: name, raw: { content: name, tool: name } };
    }
  }
}

function makeTailEvent(
  ctx: TailContext,
  id: string,
  ts: number,
  sessionId: string,
  kind: TailEvent["kind"],
  summary: string,
  raw: Record<string, unknown>,
): TailEvent {
  return {
    id,
    ts,
    sessionId,
    source: SOURCE,
    kind,
    summary: summary.slice(0, 500),
    raw,
    pid: ctx.process.pid,
    parentPid: ctx.process.ppid || null,
    cwd: ctx.transcript.cwd ?? "",
    project: ctx.transcript.project,
    harness: ctx.process.harness,
  };
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
        const unwrapped = unwrapAntigravityToolArgs(call.args ?? {});
        const { summary, input } = describeCall(name, unwrapped);
        const structured = formatAntigravityToolEvent(name, call.args ?? {});
        // Preserve the existing cursor on the first visible event of a step.
        const callId = events.length ? `${id}:call:${String(i).padStart(6, "0")}` : id;
        pending.set(step.step_index + i + 1, { id: callId, name, summary });
        events.push(event("tool", summary, { ...structured.raw, tool_name: name, tool_use_id: callId, input }, callId));
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
    let best: { root: string; row: DiscoveredTranscript } | null = null;
    for (const root of dataRoots()) {
      const row = transcript(root, id);
      if (row && (!best || row.mtimeMs > best.row.mtimeMs)) best = { root, row };
    }
    return best ? enrich(best.root, [best.row])[0] : null;
  },
};
