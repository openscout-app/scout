import { FLIGHT_WAITING_ON_SUMMARY_MAX_LENGTH, parseReplyWaitingOn } from "./invocations.js";
import { replyPointProblems, type ReplyPointInput } from "./reply-points.js";
import { applyDecisionToTask, normalizeDecisionCard, validateDecisionCard, type DecisionCardSubmission } from "./decision-cards.js";
/** Versioned ask/reply semantics. Old peers must be refused before dispatch. */
export const SCOUT_TASKS_CAPABILITY = "ask-reply/1";
export type ScoutTaskAsk = {
  version: 1;
  ref?: string;
  continue?: string;
  /** Successor launch overrides, transported separately from the predecessor route. */
  successor?: { host?: string; projectPath?: string };
  cancel?: boolean;
  fyi?: boolean;
  operator?: boolean;
  notify?: boolean;
  defaultAction?: string;
  /** Answer window in seconds. */
  window?: number;
  options?: string[];
  permission?: boolean;
  /**
   * Why the asker is asking. For an operator question it is the blocked
   * reason; for an agent task it rides to the worker as context.
   */
  because?: string;
  /**
   * JavaScript that the runtime on the worker's host runs when the task ends.
   * It is not part of the worker's prompt. See {@link ScoutTaskCallback}.
   */
  callback?: ScoutTaskCallback;
  /**
   * A decision card for an operator task. Its pictures index the request's
   * `decisionImages`; the runtime stores them as attachments. The card's labels
   * become `options` and its default (two-way doors only) becomes
   * `defaultAction`. See docs/agent/decision-cards.agent.md.
   */
  decision?: DecisionCardSubmission;
};
/**
 * `ask --callback <file>`: the source of the asker's callback file, read on
 * the asker's side. It is a JavaScript module whose default export is called
 * with `{ result, scout }` when the task ends. It cannot import anything.
 * `result` holds `taskId`, `state`
 * (completed, failed or cancelled), `reply` (the final reply text) and `files`
 * (existing files the reply names by absolute path). It runs in a sandbox with
 * no file, process or network access; `scout.open(path)` opens an html, pdf or
 * image file on that host, and `console.log` writes to the runtime log.
 */
export type ScoutTaskCallback = { code: string };
export const SCOUT_TASK_CALLBACK_MAX_CODE_LENGTH = 16_000;
export type ScoutTaskReply = {
  requestId: string;
  senderId: string;
  ref?: string;
  to?: string;
  body: string;
  progress?: boolean;
  failed?: boolean;
  /** The work is blocked: the task stays open and its flight waits on this. */
  waitingOn?: import("./invocations.js").ReplyWaitingOn;
  /** Typed points the reply makes. See reply-points.ts. The runtime stores them as `metadata.replyPoints`. */
  points?: ReplyPointInput[];
  metadata?: import("./common.js").MetadataMap;
  attachments?: import("./messages.js").MessageAttachment[];
  image?: import("./attachments.js").AttachmentUpload;
};
export type ScoutNotificationPolicy = { requested: boolean; priority: "normal" | "interrupting" };

/** Shared pre-effect validation for CLI, MCP and the runtime. */
export function validateTaskAsk(task: ScoutTaskAsk, route: {
  to?: string; channel?: string; capability?: boolean; execution?: boolean; relation?: boolean; decisionImages?: number;
}): void {
  const modes = [route.to, task.operator, route.channel, route.capability, task.ref, task.continue].filter(Boolean);
  if (modes.length !== 1) throw new Error("ask requires exactly one routing mode: --to, --operator, --channel, --project, --ref, or --continue");
  if (task.successor && !task.continue) throw new Error("successor launch overrides require --continue");
  if (task.successor?.host && !task.successor.projectPath?.trim()) throw new Error("successor --on requires --project <path on that host>");
  if (task.cancel && !task.ref) throw new Error("--cancel requires --ref");
  if (task.fyi && (task.ref || task.continue || task.cancel || route.capability)) throw new Error("--fyi cannot use --ref, --continue, --cancel or capability routing");
  if (route.execution && (task.ref || task.fyi)) throw new Error("execution flags cannot be combined with --ref or --fyi");
  if (task.continue && route.relation) throw new Error("--continue cannot be combined with --continue-for or --join-to");
  if (task.options?.length && (!task.operator || task.fyi)) throw new Error("--option requires an operator task expecting an answer");
  if (task.options?.some(option => !option.trim())) throw new Error("--option cannot be empty");
  // --notify on an agent ask is honored as written: the ask returns on
  // acceptance and the reply arrives later. Only operator asks push.
  if (task.defaultAction !== undefined && (!task.defaultAction.trim() || !task.operator || task.fyi)) throw new Error("--default-action requires an operator task expecting an answer");
  if (task.defaultAction !== undefined && task.permission) throw new Error("--default-action cannot be combined with --permission: permission requests block");
  if (task.defaultAction && task.options?.length && !task.options.includes(task.defaultAction)) throw new Error("--default-action must be one of the options");
  // A permission request is an approval only the operator can grant. A reason
  // (--because) is context the receiver reads, so it rides on any ask.
  if (task.permission && !task.operator) throw new Error("--permission requires --operator: only the operator can grant a permission request");
  if (task.because !== undefined && !task.because.trim()) throw new Error("--because cannot be empty");
  if (route.channel && !task.fyi) throw new Error("--channel requires --fyi until task ownership for channels is defined");
  if (task.window !== undefined && (!task.defaultAction || !task.operator || task.fyi || !Number.isFinite(task.window) || task.window <= 0)) throw new Error("--window requires --default-action and a positive number of seconds");
  if (task.callback !== undefined && (typeof task.callback?.code !== "string" || !task.callback.code.trim() || task.callback.code.length > SCOUT_TASK_CALLBACK_MAX_CODE_LENGTH)) throw new Error(`--callback takes a JavaScript module file of up to ${SCOUT_TASK_CALLBACK_MAX_CODE_LENGTH} characters`);
  if (task.callback !== undefined && (task.fyi || task.ref || task.cancel || task.operator || route.channel)) throw new Error("--callback belongs to a new task an agent carries out; it cannot be combined with --fyi, --ref, --cancel, --operator or --channel");
  if (task.decision !== undefined) validateTaskDecision(task, route.decisionImages);
}
/**
 * The rules for `--decision`: an operator task that expects an answer, a valid
 * agent card, and task fields that agree with the card. `decisionImages` is the
 * number of images the request carries, when known.
 */
export function validateTaskDecision(task: ScoutTaskAsk, decisionImages?: number): void {
  if (!task.operator || task.fyi) throw new Error("--decision requires an operator task expecting an answer");
  // Long fields are clipped where the card is stored, never refused: only structure refuses the ask.
  const decision = normalizeDecisionCard(task.decision);
  const problems = validateDecisionCard(decision, { origin: "agent", pictures: "image", imageCount: decisionImages });
  if (problems.length) throw new Error(`--decision is not valid:\n- ${problems.join("\n- ")}`);
  applyDecisionToTask(task, decision!);
}
export function validateTaskReply(reply: Pick<ScoutTaskReply, "ref" | "to" | "progress" | "failed" | "waitingOn" | "points">): void {
  if (Number(Boolean(reply.ref)) + Number(Boolean(reply.to)) !== 1) throw new Error("reply requires exactly one of --ref <task> or --to <message>");
  if (Number(Boolean(reply.progress)) + Number(Boolean(reply.failed)) + Number(reply.waitingOn !== undefined) > 1) {
    throw new Error("--progress, --failed and --waiting-on cannot be combined");
  }
  if (reply.to && (reply.progress || reply.failed || reply.waitingOn !== undefined)) throw new Error("--progress, --failed and --waiting-on require --ref <task>");
  if (reply.waitingOn !== undefined && !parseReplyWaitingOn(reply.waitingOn)) {
    throw new Error(`--waiting-on takes permission, question or review, and a summary of up to ${FLIGHT_WAITING_ON_SUMMARY_MAX_LENGTH} characters`);
  }
  const pointProblems = replyPointProblems(reply.points);
  if (pointProblems.length) throw new Error(`reply points are not valid:\n- ${pointProblems.join("\n- ")}`);
}
export function taskNotificationPolicy(task: ScoutTaskAsk): ScoutNotificationPolicy {
  return { requested: !task.fyi || Boolean(task.notify), priority: task.defaultAction ? "normal" : "interrupting" };
}

/** A correlated authority refusal, not a transport failure or successful delivery. */
export type TaskClosedRefusal = {
  error: "task_closed";
  taskId: string;
  flightId: string;
  messageId: string;
  reason: "completed" | "failed" | "cancelled" | "already_answered";
};
export function taskClosedRefusal(value: unknown): TaskClosedRefusal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  return v.error === "task_closed" && [v.taskId, v.flightId, v.messageId].every(id => typeof id === "string" && id.length > 0)
    && ["completed", "failed", "cancelled", "already_answered"].includes(v.reason as string) ? v as TaskClosedRefusal : undefined;
}
export class TaskClosedError extends Error {
  constructor(readonly refusal: TaskClosedRefusal, detail: string) { super(detail); }
  toJSON(): TaskClosedRefusal { return this.refusal; }
}
