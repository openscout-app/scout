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
  because?: string;
};
export type ScoutTaskReply = {
  requestId: string;
  senderId: string;
  ref?: string;
  to?: string;
  body: string;
  progress?: boolean;
  failed?: boolean;
  attachments?: import("./messages.js").MessageAttachment[];
  image?: import("./attachments.js").AttachmentUpload;
};
export type ScoutNotificationPolicy = { requested: boolean; priority: "normal" | "interrupting" };

/** Shared pre-effect validation for CLI, MCP and the runtime. */
export function validateTaskAsk(task: ScoutTaskAsk, route: {
  to?: string; channel?: string; capability?: boolean; execution?: boolean; relation?: boolean;
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
  if (task.notify && !task.operator) throw new Error("--notify now pushes to the operator; asks return on acceptance by default");
  if (task.defaultAction !== undefined && (!task.defaultAction.trim() || !task.operator || task.fyi)) throw new Error("--default-action requires an operator task expecting an answer");
  if (task.defaultAction !== undefined && task.permission) throw new Error("--default-action cannot be combined with --permission: permission requests block");
  if (task.defaultAction && task.options?.length && !task.options.includes(task.defaultAction)) throw new Error("--default-action must be one of the options");
  if ((task.permission || task.because) && !task.operator) throw new Error("--permission and --because require --operator");
  if (route.channel && !task.fyi) throw new Error("--channel requires --fyi until task ownership for channels is defined");
  if (task.window !== undefined && (!task.defaultAction || !task.operator || task.fyi || !Number.isFinite(task.window) || task.window <= 0)) throw new Error("--window requires --default-action and a positive number of seconds");
}
export function validateTaskReply(reply: Pick<ScoutTaskReply, "ref" | "to" | "progress" | "failed">): void {
  if (Number(Boolean(reply.ref)) + Number(Boolean(reply.to)) !== 1) throw new Error("reply requires exactly one of --ref <task> or --to <message>");
  if (reply.progress && reply.failed) throw new Error("--progress and --failed cannot be combined");
  if (reply.to && (reply.progress || reply.failed)) throw new Error("--progress and --failed require --ref <task>");
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
