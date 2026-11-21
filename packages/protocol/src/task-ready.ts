/**
 * Ready: a task the operator asked to hear about when it is done.
 *
 * The operator opts in per task. The mark is `notify`: `notify: true` on a
 * task ask (`scout ask --to … --notify`, MCP `ask` notify=true), or set later
 * on a running task through `POST /v1/tasks/notify`. Unmarked tasks behave as
 * they always have.
 *
 * When a marked task's flight finishes (a final reply, or a reply waiting on
 * review), the runtime writes Ready on the flight: `metadata.ready` with the
 * time and the agent's last summary line, and the next move points at the
 * operator. The runtime decides this from the flight's state, never from the
 * reply's wording. Ready is separate from done and stays until the operator
 * acts:
 *
 *   - Continue: the next move goes back to the agent, and "Continue" is
 *     delivered into the same session. A work item in review returns to
 *     working with an accepted event.
 *   - Hold: Ready leaves the operator's list but stays on the flight and
 *     findable. A later change to the task's work item brings it back.
 *
 * Ready is not a question: it has no options and no answer text. It is not
 * the board station `ready` (planned, ready to start) either.
 */
import type { FlightRecord, InvocationRequest } from "./invocations.js";
import { flightWaitingOn } from "./invocations.js";

/** Flight or invocation metadata: the operator wants to hear when this task is done. */
export const TASK_READY_NOTIFY_KEY = "readyNotify";
/** Flight metadata: the task is Ready for the operator. */
export const TASK_READY_KEY = "ready";
/** The longest summary line Ready keeps. */
export const TASK_READY_SUMMARY_MAX_LENGTH = 240;

export interface TaskReadyNotifyMark {
  on: boolean;
  /** Who set it: the operator, or an agent dispatching on the operator's behalf. */
  byId: string;
  at: number;
}

export type TaskReadyState = "ready" | "continued";

/** `metadata.ready` on a flight. */
export interface TaskReady {
  state: TaskReadyState;
  /** When the flight entered Ready. */
  at: number;
  /** The summary line of the agent's last reply. */
  summary: string;
  /** The node whose runtime wrote it; only that runtime notifies. */
  nodeId: string;
  heldAt?: number;
  heldById?: string;
  continuedAt?: number;
  continuedById?: string;
}

export type TaskReadyDecision = "continue" | "hold";

export interface TaskNotifyRequest {
  /** The task: an invocation, flight, work item, task message or binding ref. */
  ref: string;
  notify: boolean;
}

export interface TaskNotifyResponse {
  ok: true;
  invocationId: string;
  flightId: string;
  notify: boolean;
}

export interface TaskReadyDecideRequest {
  ref: string;
  decision: TaskReadyDecision;
  /** Idempotency key for the Continue delivery. */
  requestId?: string;
}

export interface TaskReadyDecideResponse {
  ok: true;
  invocationId: string;
  flightId: string;
  decision: TaskReadyDecision;
  ready: TaskReady;
  /** The task that carries "Continue": the same task, or its successor. */
  continuation?: { invocationId?: string; flightId?: string; messageId?: string };
}

export function isTaskReadyDecision(value: unknown): value is TaskReadyDecision {
  return value === "continue" || value === "hold";
}

function notifyMarkOf(metadata: Record<string, unknown> | undefined): TaskReadyNotifyMark | undefined {
  const value = metadata?.[TASK_READY_NOTIFY_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const mark = value as Partial<TaskReadyNotifyMark>;
  return typeof mark.on === "boolean" ? mark as TaskReadyNotifyMark : undefined;
}

/** Whether the task is marked. A mark on the flight (set later) wins over the ask's. */
export function taskReadyNotify(invocation: Pick<InvocationRequest, "metadata"> | undefined, flight: Pick<FlightRecord, "metadata"> | undefined): boolean {
  const mark = notifyMarkOf(flight?.metadata) ?? notifyMarkOf(invocation?.metadata);
  return mark?.on === true;
}

export function taskReadyNotifyMark(metadata: Record<string, unknown> | undefined): TaskReadyNotifyMark | undefined {
  return notifyMarkOf(metadata);
}

/** The Ready record on a flight, when it carries a well-formed one. */
export function taskReadyOf(flight: Pick<FlightRecord, "metadata"> | undefined | null): TaskReady | undefined {
  const value = flight?.metadata?.[TASK_READY_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const ready = value as Partial<TaskReady>;
  if ((ready.state !== "ready" && ready.state !== "continued") || typeof ready.at !== "number"
    || typeof ready.summary !== "string" || typeof ready.nodeId !== "string") return undefined;
  return ready as TaskReady;
}

/** A finished flight: completed, or waiting on review. A permission or question wait is not finished. */
export function flightFinishedForReady(flight: FlightRecord): boolean {
  if (flight.state === "completed") return true;
  return flight.state === "waiting" && flightWaitingOn(flight)?.kind === "review";
}

/**
 * Whether Ready is on the operator's list. A held Ready leaves the list until
 * its work item changes after the hold.
 */
export function taskReadyListed(ready: TaskReady | undefined, workUpdatedAt?: number): boolean {
  if (!ready || ready.state !== "ready") return false;
  if (ready.heldAt === undefined) return true;
  return typeof workUpdatedAt === "number" && workUpdatedAt > ready.heldAt;
}

/** The summary line of the agent's last reply: the review wait, else the final reply text. */
export function taskReadySummary(flight: FlightRecord): string {
  const waiting = flight.state === "waiting" ? flightWaitingOn(flight)?.summary : undefined;
  for (const candidate of [waiting, flight.output, flight.summary]) {
    const line = taskReadyLine(candidate);
    if (line) return line;
  }
  return "";
}

/**
 * The first line of prose (outside code fences), collapsed and cut to the
 * limit. A heading is used only when the text has no prose line.
 */
export function taskReadyLine(value: string | undefined | null, max = TASK_READY_SUMMARY_MAX_LENGTH): string {
  if (!value) return "";
  let inFence = false;
  let heading = "";
  for (const raw of value.replace(/\r/g, "").split("\n")) {
    if (/^\s*(?:```|~~~)/.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const isHeading = /^\s{0,3}#{1,6}\s+/.test(raw);
    const line = raw
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s*(?:>\s?)+/, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
      .replace(/\s+/g, " ")
      .trim();
    if (!line || /^[-*_=|:+\s]+$/.test(line)) continue;
    if (isHeading) { heading ||= line; continue; }
    return clipReadyLine(line, max);
  }
  return heading ? clipReadyLine(heading, max) : "";
}

function clipReadyLine(line: string, max: number): string {
  if (line.length <= max) return line;
  const head = line.slice(0, max - 1);
  const space = head.lastIndexOf(" ");
  return `${(space >= max * 0.6 ? head.slice(0, space) : head).trimEnd()}…`;
}
