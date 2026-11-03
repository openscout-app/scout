import { createHash } from "node:crypto";
import { flightCompletion, flightSessionTrace, SCOUT_TASKS_CAPABILITY, validateTaskReply,
  type FlightRecord, type InvocationRequest, type MessageRecord, type ScoutDeliverRequest,
  type ScoutDeliverResponse, type ScoutTaskReply } from "@openscout/protocol";
import { readMessageRecord } from "./broker-message-records.js";
import type { RuntimeRegistrySnapshot } from "./registry.js";
import { resolveBrokerMessageRefAsync, messageVisibilityForConversation } from "./broker-conversation-helpers.js";

export const taskTerminal = (flight: FlightRecord) => ["completed", "failed", "cancelled"].includes(flight.state);
export const taskMessageId = (actor: string, request: string) => `msg.request.${createHash("sha256").update(JSON.stringify([actor, request])).digest("hex")}`;
export function finishedTaskError(id: string): Error {
  return new Error(`task ${id} is finished; to start follow-up work use --continue ${id}`);
}

type Task = { invocation: InvocationRequest; flight: FlightRecord };
export type BrokerTaskServiceOptions = {
  nodeId: string;
  operatorActorId: string;
  snapshot: () => RuntimeRegistrySnapshot;
  invocation: (id: string) => InvocationRequest | undefined;
  flight: (id: string) => FlightRecord | undefined;
  currentFlight: (invocationId: string) => FlightRecord | undefined;
  openOperatorTasks: () => Iterable<InvocationRequest>;
  postMessage: (message: MessageRecord) => Promise<unknown>;
  withTaskImage?: <T>(message: MessageRecord, image: NonNullable<ScoutTaskReply["image"]>, commit: () => Promise<T>) => Promise<T>;
  recordFlight: (flight: FlightRecord, eligible?: () => boolean) => Promise<void>;
  accept: (request: ScoutDeliverRequest) => Promise<ScoutDeliverResponse>;
  interrupt?: (invocation: InvocationRequest, flight: FlightRecord) => Promise<boolean>;
  forward?: (nodeId: string, kind: "ask" | "reply", payload: unknown) => Promise<unknown>;
  now?: () => number;
};

/** Task addressing and policy; all writes still enter the canonical message/flight writers. */
export class BrokerTaskService {
  constructor(private readonly options: BrokerTaskServiceOptions) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  async resolve(raw: string): Promise<Task> {
    const ref = raw.replace(/^ref:/, "");
    const snapshot = this.options.snapshot();
    let invocation = this.options.invocation(ref) ?? (ref.startsWith("msg-request-") ? this.options.invocation(ref.replace(/^msg-request-/, "inv-request-")) : undefined);
    const directFlight = this.options.flight(ref);
    if (!invocation && directFlight) invocation = this.options.invocation(directFlight.invocationId);
    const binding = Object.values(snapshot.bindings).find(item => item.externalThreadId === ref || item.id === ref);
    const candidates = Object.values(snapshot.flights).filter(item => item.id === ref || (ref.length >= 8 && item.id.endsWith(ref)) || item.invocationId === ref
      || item.metadata?.bindingRef === ref || (binding && item.invocationId === binding.metadata?.invocationId));
    if (!invocation && new Set(candidates.map(item => item.invocationId)).size > 1) throw new Error(`ambiguous task ${raw}; use the full invocation or flight ID`);
    if (!invocation && candidates.length > 0) invocation = this.options.invocation(candidates[0]!.invocationId);
    const message = !invocation ? await resolveBrokerMessageRefAsync(snapshot, ref) : null;
    if (message) invocation = Object.values(snapshot.invocations).find(item => item.messageId === message.id);
    if (!invocation) throw new Error(message ? "an FYI has no task; use --to with a new ask" : `unknown task ${raw}; use an invocation, flight, task message or retained binding ref`);
    const flight = this.options.currentFlight(invocation.id);
    if (!flight) throw new Error(`task ${invocation.id} has no current execution record`);
    return { invocation, flight };
  }
  private home(task: Task): string {
    return (task.invocation.metadata?.taskHomeNodeId as string | undefined)
      ?? task.invocation.targetNodeId
      ?? flightSessionTrace(task.flight).at(-1)?.nodeId
      ?? this.options.nodeId;
  }
  private async forward(task: Task, kind: "ask" | "reply", payload: unknown): Promise<unknown> {
    const home = this.home(task);
    const node = this.options.snapshot().nodes[home];
    if (!node?.capabilities?.includes(SCOUT_TASKS_CAPABILITY)) throw new Error(`task home ${home} does not advertise ${SCOUT_TASKS_CAPABILITY}; upgrade that runtime before dispatch`);
    if (!this.options.forward) throw new Error(`task ${task.invocation.id} is remote; home node ${home} is unavailable`);
    return this.options.forward(home, kind, payload);
  }
  async ask(payload: ScoutDeliverRequest): Promise<ScoutDeliverResponse | null> {
    const request = payload.task;
    if (!request?.ref && !request?.continue) return null;
    const task = await this.resolve(request.ref ?? request.continue!);
    if (this.home(task) !== this.options.nodeId) return await this.forward(task, "ask", payload) as ScoutDeliverResponse;
    const { invocation, flight } = task;
    const actor = payload.caller?.actorId ?? payload.requesterId ?? this.options.operatorActorId;
    const asker = actor === invocation.requesterId || actor === this.options.operatorActorId;
    const conversation = invocation.conversationId && this.options.snapshot().conversations[invocation.conversationId];
    if (!asker && (request.cancel || request.continue || !conversation || !conversation.participantIds.includes(actor))) throw new Error("task follow-up is not authorized for this sender");
    if (request.continue) {
      if (!taskTerminal(flight)) throw new Error(`task ${invocation.id} is unfinished; use --ref ${invocation.id}`);
      const context = `Previous task ${invocation.id} (${flight.state}):\n${flight.output ?? flight.error ?? flight.summary ?? "No result recorded."}`;
      const overrides = request.successor;
      if (overrides?.host && !overrides.projectPath?.trim()) throw new Error("successor --on requires --project <path on that host>");
      const projectPath = overrides?.projectPath;
      const target = overrides?.host || overrides?.projectPath
        ? { kind: "project_path" as const, projectPath: projectPath!, ...(overrides.host ? { host: overrides.host } : {}) }
        : { kind: "agent_id" as const, agentId: invocation.targetAgentId };
      return this.options.accept({ ...payload, task: { version: 1 },
        target, targetAgentId: target.kind === "agent_id" ? invocation.targetAgentId : undefined,
        body: `${context}\n\nSuccessor task:\n${payload.body}`, execution: { ...payload.execution, session: "new" },
        invocationMetadata: { ...payload.invocationMetadata, predecessorTaskId: invocation.id, predecessorState: flight.state } });
    }
    const messageId = taskMessageId(actor, payload.requestId!);
    const existing = await readMessageRecord(this.options.snapshot().messages, messageId);
    const retry = existing?.metadata?.taskFollowup as { invocationId?: string; cancel?: boolean } | undefined;
    if (existing) {
      if (retry?.invocationId !== invocation.id || Boolean(retry.cancel) !== Boolean(request.cancel)
        || existing.body !== payload.body) throw new Error("request ID conflicts with an earlier task follow-up");
      return this.followupReceipt(existing, task);
    }
    const cancelledByRequest = request.cancel && flight.state === "cancelled"
      && flight.metadata?.taskCancellationRequestId === payload.requestId;
    if (taskTerminal(flight) && !cancelledByRequest) throw finishedTaskError(invocation.id);
    if (!conversation || !invocation.messageId) throw new Error("task has no replyable conversation");
    let interrupted = false;
    if (request.cancel && !cancelledByRequest) {
      await this.options.recordFlight({ ...flight, state: "cancelled", completedAt: this.now(), error: payload.body,
        summary: "Task cancelled by its asker.", metadata: { ...flight.metadata, taskCancellationRequestId: payload.requestId } },
        () => { const current = this.options.currentFlight(invocation.id); return Boolean(current && !taskTerminal(current) && !current.metadata?.taskFinalReplyMessageId); });
      const current = this.options.currentFlight(invocation.id)!;
      if (current.state !== "cancelled" || current.metadata?.taskCancellationRequestId !== payload.requestId) throw finishedTaskError(invocation.id);
      interrupted = await this.options.interrupt?.(invocation, flight).catch(() => false) ?? false;
    }
    const message: MessageRecord = {
      id: messageId, requestId: payload.requestId,
      conversationId: conversation.id, replyToMessageId: invocation.messageId, actorId: actor, originNodeId: this.options.nodeId,
      class: "status", body: payload.body, attachments: payload.attachments,
      audience: request.cancel || flight.state === "queued" || flight.state === "waking"
        ? { delivery: "none" } : { notify: [invocation.targetAgentId], reason: "thread_reply" },
      visibility: messageVisibilityForConversation(conversation), policy: "durable", createdAt: this.now(),
      metadata: { source: "scout-task-followup", taskFollowup: { invocationId: invocation.id, cancel: Boolean(request.cancel) },
        targetSessionId: flightSessionTrace(flight).at(-1)?.sessionId ?? invocation.execution?.targetSessionId,
        workerInterrupted: interrupted, clientMessageId: taskMessageId(actor, payload.requestId!) },
    };
    await this.postMessage(message, payload.image);
    return this.followupReceipt(message, task);
  }
  private followupReceipt(message: MessageRecord, { invocation, flight }: Task): ScoutDeliverResponse {
    const conversation = this.options.snapshot().conversations[message.conversationId]!;
    return { kind: "delivery", accepted: true, routeKind: "dm", conversation, message, targetAgentId: invocation.targetAgentId,
      flight: this.options.currentFlight(invocation.id), receipt: { requestId: message.requestId!, routeKind: "dm", requesterId: message.actorId,
        requesterNodeId: this.options.nodeId, targetAgentId: invocation.targetAgentId, conversationId: conversation.id,
        messageId: message.id, flightId: flight.id, acceptedAt: message.createdAt } };
  }
  async recoverFollowup(actor: string, requestId: string): Promise<ScoutDeliverResponse | null> {
    const message = await readMessageRecord(this.options.snapshot().messages, taskMessageId(actor, requestId));
    const ref = (message?.metadata?.taskFollowup as { invocationId?: string } | undefined)?.invocationId;
    return message && ref ? this.followupReceipt(message, await this.resolve(ref)) : null;
  }

  async reply(input: ScoutTaskReply): Promise<unknown> {
    validateTaskReply(input);
    if (!input.requestId?.trim() || !input.body?.trim() || !input.senderId?.trim()) throw new Error("reply requires requestId, senderId and non-empty body");
    if (input.ref) {
      const task = await this.resolve(input.ref);
      if (this.home(task) !== this.options.nodeId) return this.forward(task, "reply", input);
      const { invocation, flight } = task;
      if (input.senderId !== invocation.targetAgentId) throw new Error("only the task's current recipient may reply");
      if (!invocation.conversationId || !invocation.messageId) throw new Error("task has no replyable conversation");
      const conversation = this.options.snapshot().conversations[invocation.conversationId];
      // Admission and duplicate checks occur in the existing typed completion writer.
      return this.postMessage({ id: taskMessageId(input.senderId, input.requestId), requestId: input.requestId,
        conversationId: invocation.conversationId, replyToMessageId: invocation.messageId,
        actorId: input.senderId, originNodeId: this.options.nodeId, class: "agent", body: input.body, attachments: input.attachments,
        audience: { notify: [invocation.requesterId], reason: "thread_reply" },
        visibility: messageVisibilityForConversation(conversation), policy: "durable", createdAt: this.now(),
        metadata: { clientMessageId: taskMessageId(input.senderId, input.requestId), source: "scout-reply",
          completionReply: { invocationId: invocation.id, flightId: flight.id, revision: flightCompletion(flight)?.revision ?? 0,
            kind: input.progress ? "progress" : "final", ...(input.failed ? { outcome: "failed" } : {}) } } }, input.image);
    }
    const message = await resolveBrokerMessageRefAsync(this.options.snapshot(), input.to!);
    if (!message) throw new Error(`unknown conversation message ${input.to}`);
    const conversation = this.options.snapshot().conversations[message.conversationId];
    if (!conversation?.participantIds.includes(input.senderId) && input.senderId !== this.options.operatorActorId) throw new Error("conversation reply sender is not a participant");
    return this.postMessage({ id: taskMessageId(input.senderId, input.requestId), requestId: input.requestId,
      conversationId: message.conversationId, replyToMessageId: message.id, actorId: input.senderId, originNodeId: this.options.nodeId,
      class: "status", body: input.body, attachments: input.attachments, audience: { notify: [message.actorId], reason: "thread_reply" },
      visibility: messageVisibilityForConversation(conversation), policy: "durable", createdAt: this.now(),
      metadata: { source: "scout-conversation-reply", clientMessageId: taskMessageId(input.senderId, input.requestId) } }, input.image);
  }
  private postMessage(message: MessageRecord, image?: ScoutTaskReply["image"]): Promise<unknown> {
    if (!image) return this.options.postMessage(message);
    if (!this.options.withTaskImage) throw new Error("task image uploads are unavailable");
    return this.options.withTaskImage(message, image, () => this.options.postMessage(message));
  }
  /** Derived deadlines survive daemon restart; callers run this on startup and periodically. */
  async expireOperatorTasks(): Promise<void> {
    for (const invocation of this.options.openOperatorTasks()) {
      const deadline = invocation.metadata?.operatorAnswerDeadline;
      const flight = this.options.currentFlight(invocation.id);
      if (typeof invocation.metadata?.defaultAction !== "string" || invocation.metadata?.humanOwned !== true || typeof deadline !== "number" || deadline > this.now() || !flight || taskTerminal(flight)) continue;
      const action = invocation.metadata?.defaultAction;
      await this.options.recordFlight({ ...flight, state: typeof action === "string" ? "completed" : "failed", completedAt: this.now(),
        output: typeof action === "string" ? `Proceeded with default: ${action}` : undefined,
        error: typeof action === "string" ? undefined : "Operator answer window expired.",
        summary: typeof action === "string" ? "Proceeded with default." : "Operator task expired.",
        metadata: { ...flight.metadata, operatorOutcome: typeof action === "string" ? "proceeded_with_default" : "expired" } },
        () => { const current = this.options.currentFlight(invocation.id); return Boolean(current && !taskTerminal(current) && !current.metadata?.taskFinalReplyMessageId); });
    }
  }
}

/** Automatic harness finals use the same typed admission fence as explicit replies. */
export function taskCompletionMessage(message: MessageRecord, invocations: Record<string, InvocationRequest>, current: (id: string) => FlightRecord | undefined): MessageRecord {
  if (message.metadata?.completionReply || message.class !== "agent" || !message.replyToMessageId) return message;
  const task = Object.values(invocations).find(invocation => invocation.metadata?.taskVersion === 1
    && invocation.targetAgentId === message.actorId && invocation.conversationId === message.conversationId
    && invocation.messageId === message.replyToMessageId);
  if (!task || (task.metadata?.completion as { mode?: string } | undefined)?.mode === "explicit") return message;
  const flight = current(task.id);
  if (!flight) return message;
  return { ...message, metadata: { ...message.metadata, completionReply: { kind: "final", invocationId: task.id,
    flightId: flight.id, revision: flightCompletion(flight)?.revision ?? 0 } } };
}
