import type { VercelBoardTaskState } from "@openscout/protocol";
import { VERCEL_BOARD_TASK_STATES } from "@openscout/protocol";

/**
 * Board's documented wire shapes, as the HTTP reference gives them (Board
 * 0.52). Only the fields Scout reads. IDs are strings on the wire; a board
 * that sends numbers is read as strings.
 */
export interface VercelBoardWireTask {
  state: VercelBoardTaskState;
  owner: string;
  by: string;
  for: string | null;
  needs: string[];
  epoch: number;
  claim: { actor: string; until: string } | null;
  blocked: { kind: string | null; reason: string } | null;
  result: string | null;
  reason: string | null;
}

export interface VercelBoardWireMessage {
  id: string;
  channel: string;
  text: string;
  re: string | null;
  /** The exact message replied to, when it is not the root. */
  replyTo?: string | null;
  labels: Record<string, string>;
  deleted: boolean;
  /** Set when the message must not be copied out to a synced platform. */
  noSync?: boolean;
  /** The sync that brought it in (`slack`), when one did. */
  from?: string | null;
  createdAt?: string;
  editedAt?: string | null;
  version: number;
  revision?: number;
  by?: { actor: string; principal: string; profile: string | null };
  task?: VercelBoardWireTask;
}

export interface VercelBoardWireEvent {
  cursor: string;
  type: string;
  createdAt?: string;
  payload: Record<string, unknown>;
  message?: VercelBoardWireMessage;
  /** Who did it, for events with an author. */
  actor?: { id: string; handle?: string; name?: string };
}

export class VercelBoardWireError extends Error {
  constructor(message: string) { super(`vercel_board_invalid_response: ${message}`); }
}

const record = (value: unknown, what: string): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VercelBoardWireError(`${what} is not an object`);
  return value as Record<string, any>;
};
const id = (value: unknown, what: string): string => {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value !== "string" || !value || value.length > 256) throw new VercelBoardWireError(`${what} is not an ID`);
  return value;
};
const optionalId = (value: unknown, what: string): string | null => value === null || value === undefined ? null : id(value, what);
const text = (value: unknown, what: string, max = 20_000): string => {
  if (typeof value !== "string" || value.length > max) throw new VercelBoardWireError(`${what} is not text`);
  return value;
};
const nullableText = (value: unknown, what: string): string | null => value === null || value === undefined ? null : text(value, what, 4000);

export function parseVercelBoardTask(value: unknown): VercelBoardWireTask {
  const t = record(value, "task");
  if (!VERCEL_BOARD_TASK_STATES.includes(t.state)) throw new VercelBoardWireError("task.state is unknown");
  if (!Number.isSafeInteger(t.epoch) || t.epoch < 0) throw new VercelBoardWireError("task.epoch is not a count");
  const needs = t.needs === undefined ? [] : t.needs;
  if (!Array.isArray(needs) || needs.length > 100) throw new VercelBoardWireError("task.needs is not a list");
  const claim = t.claim ? record(t.claim, "task.claim") : null;
  const blocked = t.blocked ? record(t.blocked, "task.blocked") : null;
  return {
    state: t.state,
    owner: text(t.owner, "task.owner", 600),
    by: text(t.by ?? t.owner, "task.by", 700),
    for: t.for === null || t.for === undefined ? null : text(t.for, "task.for", 700),
    needs: needs.map((need: unknown) => id(need, "task.needs[]")),
    epoch: t.epoch,
    // The token is never part of a view; drop anything a board sends anyway.
    claim: claim ? { actor: text(claim.actor, "task.claim.actor", 700), until: text(claim.until, "task.claim.until", 64) } : null,
    blocked: blocked ? { kind: blocked.kind === null || blocked.kind === undefined ? null : text(blocked.kind, "task.blocked.kind", 64), reason: text(blocked.reason ?? "", "task.blocked.reason", 4000) } : null,
    result: nullableText(t.result, "task.result"),
    reason: nullableText(t.reason, "task.reason"),
  };
}

export function parseVercelBoardMessage(value: unknown): VercelBoardWireMessage {
  const m = record(value, "message");
  const labels = m.labels === undefined ? {} : record(m.labels, "message.labels");
  for (const [key, label] of Object.entries(labels)) if (typeof label !== "string") throw new VercelBoardWireError(`label ${key} is not a string`);
  if (m.version !== undefined && (!Number.isSafeInteger(m.version) || m.version < 0)) throw new VercelBoardWireError("message.version is not a count");
  const by = m.by && typeof m.by === "object" ? m.by : undefined;
  return {
    id: id(m.id, "message.id"),
    channel: text(m.channel, "message.channel", 2048),
    text: text(m.text ?? "", "message.text"),
    re: optionalId(m.re, "message.re"),
    ...(m.replyTo !== undefined ? { replyTo: optionalId(m.replyTo, "message.replyTo") } : {}),
    labels: labels as Record<string, string>,
    deleted: m.deleted === true,
    ...(typeof m.noSync === "boolean" ? { noSync: m.noSync } : {}),
    ...(typeof m.from === "string" && m.from.length <= 64 ? { from: m.from } : m.from === null ? { from: null } : {}),
    ...(typeof m.createdAt === "string" ? { createdAt: m.createdAt } : {}),
    ...(typeof m.editedAt === "string" || m.editedAt === null ? { editedAt: m.editedAt } : {}),
    version: m.version ?? 0,
    ...(Number.isSafeInteger(m.revision) ? { revision: m.revision } : {}),
    ...(by && typeof by.actor === "string" && typeof by.principal === "string"
      ? { by: { actor: by.actor, principal: by.principal, profile: typeof by.profile === "string" ? by.profile : null } } : {}),
    ...(m.task ? { task: parseVercelBoardTask(m.task) } : {}),
  };
}

export function parseVercelBoardEvent(value: unknown): VercelBoardWireEvent {
  const e = record(value, "event");
  return {
    cursor: id(e.cursor, "event.cursor"),
    type: text(e.type, "event.type", 64),
    ...(typeof e.createdAt === "string" ? { createdAt: e.createdAt } : {}),
    payload: e.payload && typeof e.payload === "object" ? e.payload : {},
    ...(e.message ? { message: parseVercelBoardMessage(e.message) } : {}),
    ...(e.actor && typeof e.actor === "object" && typeof e.actor.id === "string" && e.actor.id.length <= 700
      ? { actor: { id: e.actor.id, ...(typeof e.actor.handle === "string" ? { handle: e.actor.handle.slice(0, 200) } : {}), ...(typeof e.actor.name === "string" ? { name: e.actor.name.slice(0, 200) } : {}) } } : {}),
  };
}

/** One page of a channel's messages, oldest first, with the cursor to read on from. */
export function parseVercelBoardMessagesPage(value: unknown): { messages: VercelBoardWireMessage[]; cursor: string | null } {
  const page = record(value, "messages page");
  if (!Array.isArray(page.messages) || page.messages.length > 1000) throw new VercelBoardWireError("messages page has no message list");
  return { messages: page.messages.map(parseVercelBoardMessage), cursor: page.cursor === null || page.cursor === undefined ? null : id(page.cursor, "messages cursor") };
}

/** A task list entry is a thread summary, `{ message, replies, last }`. */
export function parseVercelBoardTaskSummary(value: unknown): VercelBoardWireMessage {
  const s = record(value, "task summary");
  return parseVercelBoardMessage(s.message ?? s);
}

/** Board accepts at most 1,000 characters. Scout custody retains the original. */
export function boardResultExcerpt(text: string): string {
  if (text.length <= 1000) return text;
  const marker = "\n[Truncated; full text in Scout handoffs]";
  const prefix = text.slice(0, 1000 - marker.length).replace(/[\uD800-\uDBFF]$/, "");
  return prefix + marker;
}
