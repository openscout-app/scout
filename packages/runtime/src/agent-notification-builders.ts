/**
 * Builders that turn what the host already knows into an AgentNotification:
 * a session attention item (read against the session snapshot, where the
 * command, diff, and question options live), a harness permission request,
 * and an operator signal.
 *
 * Levels (see AgentNotificationLevel):
 *   - time-sensitive: only a `need`, where an agent asked the operator and
 *     cannot go on without the answer.
 *   - active: approvals, permission requests, and mid-turn questions. The
 *     operator must act, but nobody addressed the operator.
 *   - passive: failures, consults, updates, and inferred attention.
 */

import { attentionContextBeforeBlock } from "@openscout/agent-sessions";
import { hostname as osHostname } from "node:os";
import { basename } from "node:path";

import type {
  ActionBlock,
  Block,
  SessionState,
  TurnState,
} from "@openscout/agent-sessions";
import {
  AGENT_NOTIFICATION_VERSION,
  type AgentNotification,
  type AgentNotificationFileChange,
  type AgentNotificationLevel,
  type AgentNotificationRisk,
  type AgentNotificationView,
  type ScoutOperatorSignal,
} from "@openscout/protocol";

import { parseContinuationDialog, stripTerminalControls } from "./continuation/dialog.js";

/**
 * How a level travels in the plain push: whether it rings, and the urgency
 * the relay maps to APNs priority. The phone's extension sets the iOS
 * interruption level from the sealed record.
 */
export function pushDeliveryForLevel(level: AgentNotificationLevel): { sound: string | null; urgency: "interrupt" | "silent" } {
  return level === "passive" ? { sound: null, urgency: "silent" } : { sound: "default", urgency: "interrupt" };
}

/** The fields every attention item carries (the mobile inbox item shape). */
export type AttentionNotificationItem = {
  id: string;
  kind: string;
  title: string;
  description: string;
  detail?: string | null;
  sessionId: string;
  sessionName: string;
  turnId: string | null;
  blockId: string | null;
  risk: AgentNotificationRisk;
  createdAt: number;
};

/** This Mac as the phone names it: the hostname without `.local`. */
export function notificationHostName(hostname = osHostname()): string {
  return hostname.replace(/\.local\.?$/i, "").trim();
}

function findTurn(snapshot: SessionState | null | undefined, turnId: string | null): TurnState | null {
  if (!snapshot || !turnId) return null;
  return snapshot.turns.find((turn) => turn.id === turnId) ?? null;
}

function findBlock(turn: TurnState | null, blockId: string | null): Block | null {
  if (!turn || !blockId) return null;
  return turn.blocks.find((state) => state.block.id === blockId)?.block ?? null;
}

/** Lines added and removed in a unified diff. */
export function countDiffLines(diff: string | undefined): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of (diff ?? "").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

function lastLines(text: string, count: number): string[] {
  return text.split("\n").map((line) => line.trimEnd()).filter(Boolean).slice(-count);
}

function formatElapsed(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function approvalView(
  block: ActionBlock,
  item: AttentionNotificationItem,
  snapshot: SessionState | null | undefined,
): AgentNotificationView {
  const action = block.action;
  const risk = action.approval?.risk ?? item.risk;
  const turn = snapshot?.turns.find(turn => turn.blocks.some(entry => entry.block.id === block.id));
  const why = (turn ? attentionContextBeforeBlock(turn, block.id)?.text : null) ?? (action.approval?.description?.trim() || undefined);
  switch (action.kind) {
    case "command":
      return {
        view: "turn.approve.command",
        command: action.command,
        risk,
        ...(snapshot?.session.cwd ? { cwd: snapshot.session.cwd } : {}),
        ...(why ? { why } : {}),
      };
    case "file_change": {
      const file: AgentNotificationFileChange = { path: action.path, ...countDiffLines(action.diff) };
      return { view: "turn.approve.edit", files: [file], risk, ...(why ? { summary: why } : {}) };
    }
    case "tool_call":
      return { view: "turn.approve.tool", tool: action.toolName, risk, ...(why ? { why, summary: why } : {}) };
    case "subagent":
      return {
        view: "turn.approve.tool",
        tool: action.agentName ?? "a subagent",
        risk,
        ...(why ?? action.prompt ? { summary: why ?? action.prompt } : {}),
      };
  }
}

function failedView(
  item: AttentionNotificationItem,
  turn: TurnState | null,
  block: Block | null,
): AgentNotificationView {
  const excerpt = block?.type === "action"
    ? lastLines(block.action.output, 4)
    : block?.type === "error"
      ? lastLines(block.message, 4)
      : [];
  const elapsed = turn ? formatElapsed((turn.endedAt ?? item.createdAt) - turn.startedAt) : undefined;
  const error = item.description.trim() || item.title.trim();
  return {
    view: "turn.failed",
    error,
    ...(excerpt.length > 0 ? { excerpt } : {}),
    ...(elapsed ? { elapsed } : {}),
  };
}

function viewForAttention(
  item: AttentionNotificationItem,
  snapshot: SessionState | null | undefined,
): { view: AgentNotificationView; level: AgentNotificationLevel } {
  const turn = findTurn(snapshot, item.turnId);
  const block = findBlock(turn, item.blockId);

  switch (item.kind) {
    case "approval":
      if (block?.type === "action") {
        return { view: approvalView(block, item, snapshot), level: "active" };
      }
      break;
    case "question":
      if (block?.type === "question") {
        const context = block.header?.trim() || undefined;
        const options = block.options.map((option) => option.label).filter(Boolean);
        return {
          view: options.length > 0
            ? { view: "turn.question.choice", question: block.question, options, multiSelect: block.multiSelect, ...(context ? { context } : {}) }
            : { view: "turn.question.open", question: block.question, ...(context ? { context } : {}) },
          level: "active",
        };
      }
      return { view: { view: "turn.question.open", question: item.description || item.title }, level: "active" };
    case "failed_action":
    case "failed_turn":
    case "session_error":
      return { view: failedView(item, turn, block), level: "passive" };
    default:
      break;
  }

  const body = item.description && item.description !== item.title ? item.description : item.detail ?? undefined;
  return {
    view: { view: "text", title: item.title, ...(body ? { body } : {}) },
    // An approval we couldn't read still blocks the turn; inferred attention never rings.
    level: item.kind === "approval" ? "active" : "passive",
  };
}

export function agentNotificationForSessionAttention(input: {
  item: AttentionNotificationItem;
  snapshot?: SessionState | null;
  host?: string;
}): AgentNotification {
  const { item, snapshot } = input;
  const { view, level } = viewForAttention(item, snapshot);
  const cwd = snapshot?.session.cwd;
  return {
    ...view,
    v: AGENT_NOTIFICATION_VERSION,
    itemId: item.id,
    sender: { name: item.sessionName || snapshot?.session.name || "Agent" },
    ...(cwd ? { project: basename(cwd) } : {}),
    host: input.host ?? notificationHostName(),
    level,
    createdAt: item.createdAt,
    // The inbox row for this item holds its approve, deny, and reply actions.
    route: {
      open: "inbox",
      sessionId: item.sessionId,
      ...(item.turnId ? { turnId: item.turnId } : {}),
      ...(item.blockId ? { blockId: item.blockId } : {}),
    },
  };
}

const DIALOG_HEADER = /^(Bash command|Edit file|Write file|Create file|Read file|Fetch|Web ?search|Tool use|MCP tool)$/i;
const DIALOG_BODY_END = /\bPermission rule\b|\bThis command requires approval\b|\bDo you want to\b/i;

function lastIndex(values: readonly string[], predicate: (value: string, index: number) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index] ?? "", index)) return index;
  }
  return -1;
}

/** A dialog line without its box border. */
function dialogLine(line: string): string {
  return line.replace(/^\s*[│┃|]\s?/u, "").replace(/\s?[│┃|]\s*$/u, "").trim();
}

/**
 * The view for a harness permission dialog, read from its text. Only the live
 * dialog counts: its header and the lines under it. Anything above the header
 * is the session's scrollback and never reaches the notification.
 */
export function permissionDialogView(text: string): AgentNotificationView {
  const lines = stripTerminalControls(text).split("\n").map(dialogLine);
  const proceed = lastIndex(lines, (line) => /\bDo you want to\b/i.test(line));
  const workspace = lastIndex(lines, (line) => /^Accessing workspace:/i.test(line));
  const trustChoice = lastIndex(lines, (line) => /^(?:❯\s*)?(?:\d+[.)]\s*)?Yes,\s*I trust this folder$/i.test(line));
  const trustEnd = lastIndex(lines, (line) => /Enter to confirm.*Esc to cancel/i.test(line));
  // A workspace mention in scrollback is not a folder-trust dialog. Require
  // its actual choices and footer, newer than any tool-permission question.
  if (workspace >= 0 && workspace > proceed && trustChoice > workspace && trustEnd > trustChoice
    && lines.slice(trustChoice + 1, trustEnd).some((line) => /^(?:❯\s*)?(?:\d+[.)]\s*)?No, exit$/i.test(line))) {
    const path = lines[workspace]!.replace(/^Accessing workspace:\s*/i, "").trim()
      || lines.slice(workspace + 1, trustChoice).find(Boolean) || "";
    return { view: "turn.approve.tool", tool: "this folder", ...(path ? { summary: path } : {}) };
  }

  const dialog = parseContinuationDialog(text);
  const header = lastIndex(lines, (line, index) => (proceed < 0 || index < proceed) && DIALOG_HEADER.test(line));
  const detail: string[] = [];
  if (header >= 0 && (proceed < 0 || proceed - header <= 16)) {
    for (const line of lines.slice(header + 1)) {
      if (DIALOG_BODY_END.test(line)) break;
      if (line && !/^\/permissions\b/i.test(line)) detail.push(line);
    }
  }
  const name = header >= 0 ? lines[header]!.toLowerCase() : "";

  if (name.startsWith("bash") && detail.length > 0) {
    // Claude puts the command first and its description on the last line.
    const why = detail.length > 1 ? detail.at(-1) : undefined;
    return { view: "turn.approve.command", command: detail[0]!, ...(why ? { why } : {}) };
  }
  if (/^(edit|write|create) file$/.test(name) && detail[0]) {
    return { view: "turn.approve.edit", files: [{ path: detail[0], added: 0, removed: 0 }] };
  }
  if (name === "read file") return { view: "turn.approve.tool", tool: "Read", ...(detail[0] ? { summary: detail[0] } : {}) };
  if (name === "fetch") return { view: "turn.approve.tool", tool: "WebFetch", ...(detail[0] ? { summary: detail[0] } : {}) };
  if (name.startsWith("web")) return { view: "turn.approve.tool", tool: "WebSearch", ...(detail[0] ? { summary: detail[0] } : {}) };
  if (header >= 0 && detail[0]) {
    // An MCP call reads "server - tool(args) (MCP)".
    const mcp = detail[0].match(/^(.+?)\s+-\s+([\w.-]+)\(/);
    return { view: "turn.approve.tool", tool: mcp ? `${mcp[1]!.trim()} ${mcp[2]}` : "a tool", summary: detail[0] };
  }
  // No header to read: say what is known and nothing from the screen.
  return { view: "turn.approve.tool", tool: dialog.permissionRule ?? "a tool" };
}

/**
 * A harness permission dialog in a session the runtime dispatched to. The
 * operator must answer it before the flight goes on, but nobody addressed the
 * operator, so it is `active`, not time-sensitive. A tap opens the request in
 * the inbox.
 */
export function agentNotificationForPermissionRequest(input: {
  requestId: string;
  text: string;
  agentName: string;
  agentId: string;
  project?: string | null;
  host?: string;
  createdAt: number;
  conversationId?: string | null;
  messageId?: string | null;
  sessionId?: string | null;
  /** Known as data (a native hook): used as is, and `text` is not parsed. */
  view?: AgentNotificationView;
}): AgentNotification {
  return {
    ...(input.view ?? permissionDialogView(input.text)),
    v: AGENT_NOTIFICATION_VERSION,
    itemId: input.requestId,
    sender: { name: input.agentName, agentId: input.agentId },
    ...(input.project ? { project: input.project } : {}),
    host: input.host ?? notificationHostName(),
    level: "active",
    createdAt: input.createdAt,
    route: {
      open: "inbox",
      requestId: input.requestId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    },
  };
}

/**
 * An operator signal an agent sent on its own, outside any turn. `need` and
 * `consult` are asks. Only a need is time-sensitive: the agent addressed the
 * operator and waits on the answer. `notify` goes out as passive text. A tap
 * opens the message in its chat.
 */
export function agentNotificationForOperatorSignal(input: {
  messageId: string;
  conversationId?: string | null;
  signal: ScoutOperatorSignal;
  agentName: string;
  agentId?: string | null;
  body: string;
  project?: string | null;
  host?: string;
  createdAt: number;
}): AgentNotification {
  const { signal } = input;
  const body = input.body.trim();
  let view: AgentNotificationView;
  if (signal.kind === "need") {
    const options = (signal.options ?? []).map((option) => option.trim()).filter(Boolean);
    view = {
      view: "ask",
      note: signal.question.trim() || body,
      reply: "required",
      ...(signal.requestKind === "permission" ? { permission: true } : {}),
      ...(options.length > 0 ? { options } : {}),
    };
  } else if (signal.kind === "consult") {
    view = { view: "ask", note: body, reply: "optional" };
  } else {
    view = { view: "text", title: "Shared an update", ...(body ? { body } : {}) };
  }
  return {
    ...view,
    v: AGENT_NOTIFICATION_VERSION,
    itemId: input.messageId,
    sender: { name: input.agentName, ...(input.agentId ? { agentId: input.agentId } : {}) },
    ...(input.project ? { project: input.project } : {}),
    host: input.host ?? notificationHostName(),
    level: signal.kind === "need" ? "time-sensitive" : "passive",
    createdAt: input.createdAt,
    route: {
      open: "chat",
      messageId: input.messageId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    },
  };
}
