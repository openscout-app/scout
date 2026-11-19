import type { BoardTaskState } from "@openscout/protocol";
import { BOARD_TASK_STATES } from "@openscout/protocol";

/**
 * Board's documented wire shapes, as the HTTP reference gives them (Board
 * 0.52). Only the fields Scout reads. IDs are strings on the wire; a board
 * that sends numbers is read as strings.
 */
export interface BoardWireTask {
  state: BoardTaskState;
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

export interface BoardWireMessage {
  id: string;
  channel: string;
  text: string;
  re: string | null;
  labels: Record<string, string>;
  deleted: boolean;
  createdAt?: string;
  editedAt?: string | null;
  version: number;
  revision?: number;
  by?: { actor: string; principal: string; profile: string | null };
  task?: BoardWireTask;
}

export interface BoardWireEvent {
  cursor: string;
  type: string;
  createdAt?: string;
  payload: Record<string, unknown>;
  message?: BoardWireMessage;
}

export class BoardWireError extends Error {
  constructor(message: string) { super(`board_invalid_response: ${message}`); }
}

const record = (value: unknown, what: string): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BoardWireError(`${what} is not an object`);
  return value as Record<string, any>;
};
const id = (value: unknown, what: string): string => {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value !== "string" || !value || value.length > 256) throw new BoardWireError(`${what} is not an ID`);
  return value;
};
const optionalId = (value: unknown, what: string): string | null => value === null || value === undefined ? null : id(value, what);
const text = (value: unknown, what: string, max = 20_000): string => {
  if (typeof value !== "string" || value.length > max) throw new BoardWireError(`${what} is not text`);
  return value;
};
const nullableText = (value: unknown, what: string): string | null => value === null || value === undefined ? null : text(value, what, 4000);

export function parseBoardTask(value: unknown): BoardWireTask {
  const t = record(value, "task");
  if (!BOARD_TASK_STATES.includes(t.state)) throw new BoardWireError("task.state is unknown");
  if (!Number.isSafeInteger(t.epoch) || t.epoch < 0) throw new BoardWireError("task.epoch is not a count");
  const needs = t.needs === undefined ? [] : t.needs;
  if (!Array.isArray(needs) || needs.length > 100) throw new BoardWireError("task.needs is not a list");
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

export function parseBoardMessage(value: unknown): BoardWireMessage {
  const m = record(value, "message");
  const labels = m.labels === undefined ? {} : record(m.labels, "message.labels");
  for (const [key, label] of Object.entries(labels)) if (typeof label !== "string") throw new BoardWireError(`label ${key} is not a string`);
  if (m.version !== undefined && (!Number.isSafeInteger(m.version) || m.version < 0)) throw new BoardWireError("message.version is not a count");
  const by = m.by && typeof m.by === "object" ? m.by : undefined;
  return {
    id: id(m.id, "message.id"),
    channel: text(m.channel, "message.channel", 2048),
    text: text(m.text ?? "", "message.text"),
    re: optionalId(m.re, "message.re"),
    labels: labels as Record<string, string>,
    deleted: m.deleted === true,
    ...(typeof m.createdAt === "string" ? { createdAt: m.createdAt } : {}),
    ...(typeof m.editedAt === "string" || m.editedAt === null ? { editedAt: m.editedAt } : {}),
    version: m.version ?? 0,
    ...(Number.isSafeInteger(m.revision) ? { revision: m.revision } : {}),
    ...(by && typeof by.actor === "string" && typeof by.principal === "string"
      ? { by: { actor: by.actor, principal: by.principal, profile: typeof by.profile === "string" ? by.profile : null } } : {}),
    ...(m.task ? { task: parseBoardTask(m.task) } : {}),
  };
}

export function parseBoardEvent(value: unknown): BoardWireEvent {
  const e = record(value, "event");
  return {
    cursor: id(e.cursor, "event.cursor"),
    type: text(e.type, "event.type", 64),
    ...(typeof e.createdAt === "string" ? { createdAt: e.createdAt } : {}),
    payload: e.payload && typeof e.payload === "object" ? e.payload : {},
    ...(e.message ? { message: parseBoardMessage(e.message) } : {}),
  };
}

/** A task list entry is a thread summary, `{ message, replies, last }`. */
export function parseBoardTaskSummary(value: unknown): BoardWireMessage {
  const s = record(value, "task summary");
  return parseBoardMessage(s.message ?? s);
}
