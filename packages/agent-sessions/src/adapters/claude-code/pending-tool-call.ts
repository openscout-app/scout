/**
 * The tool call a Claude Code session is waiting on.
 *
 * Claude Code writes an assistant turn's `tool_use` blocks to the transcript
 * before it runs them, and writes each `tool_result` when the call finishes.
 * While the session shows a permission prompt, the call it asks about is a
 * `tool_use` with no `tool_result` yet. This module reads that call from the
 * transcript's tail and describes it the way the session's own prompt does:
 * the tool, then the command, file, or address it wants.
 *
 * The transcript is observed source material. Nothing here answers the prompt.
 */

import { redactSecrets } from "../../secret-redaction.js";

export type ClaudePendingToolCall = {
  /** The `tool_use` block id. */
  toolUseId: string;
  /** The tool's name as the transcript records it, e.g. `Bash`, `Edit`, `mcp__github__create_issue`. */
  tool: string;
  /** The heading the session's prompt shows, e.g. "Bash command", "Edit file", "Fetch". */
  title: string;
  /** What it wants: the command, the file path, the address, or the call's arguments. */
  subject: string | null;
  /** The call's own explanation, when it gives one (Bash's `description`). */
  detail: string | null;
  /** Whether the subject is a shell command, a path, an address, a query, or arguments. */
  subjectKind: "command" | "path" | "url" | "query" | "arguments" | null;
  /** When the assistant line holding the call was written (ms), when the line has a timestamp. */
  at: number | null;
  /** Other calls that have no result yet. */
  alsoPending: number;
};

const SUBJECT_MAX = 2_000;
const DETAIL_MAX = 400;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bounded(value: string | null, max: number): string | null {
  if (!value) return null;
  const clean = redactSecrets(value);
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function compactArguments(input: Record<string, unknown>): string | null {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!entries.length) return null;
  return entries.map(([key, value]) => `${key}: ${JSON.stringify(value) ?? String(value)}`).join(", ");
}

/**
 * The prompt's heading and subject for one call, after Claude Code's own
 * permission dialogs: "Bash command", "Edit file", "Fetch", and, for an MCP
 * tool, `server - tool (MCP)` with its arguments.
 */
export function describeClaudeToolCall(tool: string, rawInput: unknown): Pick<ClaudePendingToolCall, "title" | "subject" | "detail" | "subjectKind"> {
  const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput as Record<string, unknown> : {};
  const path = text(input.file_path) ?? text(input.notebook_path) ?? text(input.path);
  switch (tool) {
    case "Bash":
      return { title: "Bash command", subject: bounded(text(input.command), SUBJECT_MAX), detail: bounded(text(input.description), DETAIL_MAX), subjectKind: "command" };
    case "Edit":
    case "MultiEdit":
      return { title: "Edit file", subject: bounded(path, SUBJECT_MAX), detail: null, subjectKind: "path" };
    case "Write":
      return { title: "Write file", subject: bounded(path, SUBJECT_MAX), detail: null, subjectKind: "path" };
    case "NotebookEdit":
      return { title: "Edit notebook", subject: bounded(path, SUBJECT_MAX), detail: null, subjectKind: "path" };
    case "Read":
      return { title: "Read file", subject: bounded(path, SUBJECT_MAX), detail: null, subjectKind: "path" };
    case "WebFetch":
      return { title: "Fetch", subject: bounded(text(input.url), SUBJECT_MAX), detail: null, subjectKind: "url" };
    case "WebSearch":
      return { title: "Web search", subject: bounded(text(input.query), SUBJECT_MAX), detail: null, subjectKind: "query" };
    case "Glob":
    case "Grep":
      return { title: tool === "Glob" ? "Find files" : "Search files", subject: bounded(text(input.pattern), SUBJECT_MAX), detail: bounded(path, DETAIL_MAX), subjectKind: "query" };
    case "AskUserQuestion": {
      const questions = Array.isArray(input.questions) ? input.questions as Array<Record<string, unknown>> : [];
      return { title: "Question", subject: bounded(text(questions[0]?.question) ?? text(input.question), SUBJECT_MAX), detail: null, subjectKind: null };
    }
    case "ExitPlanMode":
      return { title: "Plan approval", subject: bounded(text(input.plan), SUBJECT_MAX), detail: null, subjectKind: null };
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/u.exec(tool);
      return {
        title: mcp ? `${mcp[1]} - ${mcp[2]} (MCP)` : tool,
        subject: bounded(compactArguments(input), SUBJECT_MAX),
        detail: null,
        subjectKind: "arguments",
      };
    }
  }
}

type Line = {
  type?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  timestamp?: unknown;
  message?: { content?: unknown };
};

function blocksOf(line: Line): Array<Record<string, unknown>> {
  const content = line.message?.content;
  return Array.isArray(content) ? content.filter((b): b is Record<string, unknown> => Boolean(b) && typeof b === "object") : [];
}

/**
 * The call the session is waiting on, from the transcript's JSONL text. A
 * tail is enough: a partial first line is skipped. Subagent lines are
 * skipped, because the session's prompt is about its own calls. When several
 * calls are open, the first is the one the session asks about first; the rest
 * are counted.
 *
 * Returns null when every call has a result, or when a typed prompt came after
 * the open calls (an interrupted turn leaves calls open with no prompt on screen).
 */
export function findClaudePendingToolCall(jsonl: string): ClaudePendingToolCall | null {
  type Call = { id: string; tool: string; input: unknown; at: number | null };
  let open: Call[] = [];
  const resolved = new Set<string>();
  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    let line: Line;
    try { line = JSON.parse(raw) as Line; } catch { continue; }
    if (!line || typeof line !== "object" || line.isSidechain === true) continue;
    const at = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : NaN;
    if (line.type === "assistant") {
      for (const block of blocksOf(line)) {
        if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          open.push({ id: block.id, tool: block.name, input: block.input, at: Number.isFinite(at) ? at : null });
        }
      }
    } else if (line.type === "user") {
      const blocks = blocksOf(line);
      let result = false;
      for (const block of blocks) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          resolved.add(block.tool_use_id);
          result = true;
        }
      }
      const typed = typeof line.message?.content === "string" || blocks.some((b) => b.type === "text");
      if (!result && typed && line.isMeta !== true) open = [];
    }
    if (resolved.size) {
      open = open.filter((call) => !resolved.has(call.id));
      resolved.clear();
    }
  }
  const first = open[0];
  if (!first) return null;
  return { toolUseId: first.id, tool: first.tool, ...describeClaudeToolCall(first.tool, first.input), at: first.at, alsoPending: open.length - 1 };
}
