import { createHash } from "node:crypto";
import { flightCompletion, flightSessionTrace, parseScoutComposerRouteTarget, SCOUT_TASKS_CAPABILITY, validateTaskReply,
  type AgentHarness, type FlightRecord, type InvocationRequest, type MessageRecord, type ScoutDeliverRequest,
  type ScoutDeliverResponse, type ScoutTaskReply, parseReplyWaitingOn, flightWaitingOn } from "@openscout/protocol";
import { ProvenRequestFailure } from "./broker-request-receipts.js";
import { readMessageRecord } from "./broker-message-records.js";
import { endpointStronglyMatchesSession } from "./broker-endpoint-selection.js";
import { callerContextForDelivery } from "./broker-delivery-routing.js";
import type { RuntimeRegistrySnapshot } from "./registry.js";
import { resolveBrokerMessageRefAsync, messageVisibilityForConversation } from "./broker-conversation-helpers.js";

export const taskTerminal = (flight: FlightRecord) => ["completed", "failed", "cancelled"].includes(flight.state);
export const taskMessageId = (actor: string, request: string) => `msg.request.${createHash("sha256").update(JSON.stringify([actor, request])).digest("hex")}`;
export function finishedTaskError(id: string): Error {
  return new Error(`task ${id} is finished; to start follow-up work use --continue ${id}`);
}

/** `named` is the flight the ref spelled out, when it named one; `flight` is always current. */
type Task = { invocation: InvocationRequest; flight: FlightRecord; named?: FlightRecord };

/**
 * A flight the ref named that is no longer its invocation's current flight:
 * the local placeholder a peer handoff leaves behind. It lives on this node,
 * so a cancel of it is answered here and never touches the current flight.
 */
function supersededPlaceholder(task: Task): FlightRecord | undefined {
  const named = task.named;
  return named && named.id !== task.flight.id && named.invocationId === task.invocation.id ? named : undefined;
}

export type FollowupSession = { id: string; harness: "claude" | "codex" };

export function isRequesterSession(invocation: InvocationRequest, nodeId: string, session?: FollowupSession): boolean {
  return Boolean(session?.id && (session.harness === "claude" || session.harness === "codex")
    && nodeId === invocation.requesterNodeId && session.id === invocation.metadata?.replyToSessionId
    && session.harness === invocation.metadata?.replyToSessionHarness);
}

function claimedFollowupSession(payload: ScoutDeliverRequest): FollowupSession | undefined {
  // Both CLI and MCP attach the harness only when the return address agrees
  // with a harness-provided session ID. A reply address alone isn't identity.
  const id = payload.replyToSessionId?.trim();
  const harness = payload.invocationMetadata?.replyToSessionHarness;
  return id && (harness === "claude" || harness === "codex") ? { id, harness } : undefined;
}


/** Inbox notification is not input to an already-dispatched harness turn. */
/**
 * Keys only the runtime may write on a reply message. A client's reply
 * metadata never carries them, so a client cannot plant a decision answer.
 */
const RUNTIME_REPLY_METADATA_KEYS = ["decisionAnswer"] as const;

export function clientReplyMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata) return {};
  const clean = { ...metadata };
  for (const key of RUNTIME_REPLY_METADATA_KEYS) delete clean[key];
  return clean;
}

export function followupAudience(invocation: InvocationRequest, flight: FlightRecord): MessageRecord["audience"] {
  if (invocation.metadata?.humanOwned === true) return { notify: [invocation.targetAgentId], reason: "thread_reply" };
  if (flight.state === "queued" || flight.state === "waking") return { delivery: "none" };
  if (taskTerminal(flight) || flight.metadata?.taskFinalReplyMessageId) throw finishedTaskError(invocation.id);
  // A worker that blocked with `reply --waiting-on question|review` ended its turn to wait for
  // this answer, so the answer starts the next turn instead of joining a live one. A permission
  // wait is answered through its permission request.
  const waiting = flight.state === "waiting" ? flightWaitingOn(flight) : undefined;
  if (waiting && waiting.kind !== "permission") return { notify: [invocation.targetAgentId], reason: "thread_reply" };
  const session = flightSessionTrace(flight).at(-1);
  const sessionId = session?.sessionId ?? invocation.execution?.targetSessionId;
  const harness = session?.harness ?? invocation.execution?.harness;
  const next = sessionId
    ? `Send a separate ask with --to session:${harness ? harness + ":" : ""}${sessionId}, or use --continue ${invocation.id} after it finishes.`
    : `Use --continue ${invocation.id} after it finishes.`;
  // The flight is durable evidence and no follow-up message has been committed.
  throw new ProvenRequestFailure(
    `Follow-up not sent: Scout cannot add context to the active turn for task ${invocation.id}. ${next}`,
    "task_followup_not_sent", flight.id,
  );
}

/**
 * The task home resolves the same invocation by its id; a local flight or
 * binding ref may be unknown there. The ref target is the whole route, so the
 * locally rendered `ref:` label is dropped: a home that predates label
 * matching reads any label as a second recipient.
 */
export function taskHomeAskPayload(payload: ScoutDeliverRequest, invocationId: string): ScoutDeliverRequest {
  const task = payload.task;
  if (!task || (!task.ref && !task.continue)) return payload;
  const { targetLabel: _label, ...rest } = payload;
  return { ...rest, target: { kind: "binding_ref", ref: invocationId },
    task: { ...task, ...(task.ref ? { ref: invocationId } : {}), ...(task.continue ? { continue: invocationId } : {}) } };
}

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
  /** Cancel a superseded flight without moving the invocation's current flight. */
  cancelSupersededFlight?: (flight: FlightRecord, summary: string) => Promise<FlightRecord | null>;
  now?: () => number;
};

/** Task addressing and policy; all writes still enter the canonical message/flight writers. */
export class BrokerTaskService {
  constructor(private readonly options: BrokerTaskServiceOptions) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  async resolve(raw: string): Promise<Task> {
    const ref = raw.replace(/^ref:/, "");
    const snapshot = this.options.snapshot();
    // A session route is parsed before flight-suffix matching, so `session:`
    // cannot be swallowed by an unrelated flight id that happens to end the same way.
    const sessionRoute = ref.startsWith("session:") ? parseScoutComposerRouteTarget(ref) : null;
    if (sessionRoute?.kind === "session_id") {
      return this.taskForInvocation(raw, this.invocationForSession(snapshot, raw, sessionRoute.sessionId, sessionRoute.harness));
    }
    let invocation = this.options.invocation(ref) ?? (ref.startsWith("msg-request-") ? this.options.invocation(ref.replace(/^msg-request-/, "inv-request-")) : undefined);
    const directFlight = this.options.flight(ref);
    if (!invocation && directFlight) {
      const named = this.options.invocation(directFlight.invocationId);
      if (named) return { ...this.taskForInvocation(raw, named), named: directFlight };
    }
    const binding = Object.values(snapshot.bindings).find(item => item.externalThreadId === ref || item.id === ref);
    const candidates = Object.values(snapshot.flights).filter(item => item.id === ref || (ref.length >= 8 && item.id.endsWith(ref)) || item.invocationId === ref
      || item.metadata?.bindingRef === ref || (binding && item.invocationId === binding.metadata?.invocationId));
    if (!invocation && new Set(candidates.map(item => item.invocationId)).size > 1) throw new Error(`ambiguous task ${raw}; use the full invocation or flight ID`);
    if (!invocation && candidates.length > 0) invocation = this.options.invocation(candidates[0]!.invocationId);
    const message = !invocation ? await resolveBrokerMessageRefAsync(snapshot, ref) : null;
    if (message) invocation = Object.values(snapshot.invocations).find(item => item.messageId === message.id);
    if (!invocation && message) throw new Error("an FYI has no task; use --to with a new ask");
    if (!invocation) invocation = this.invocationForWork(snapshot, raw, ref) ?? this.invocationForSession(snapshot, raw, ref);
    return this.taskForInvocation(raw, invocation);
  }
  private taskForInvocation(raw: string, invocation: InvocationRequest | undefined): Task {
    if (!invocation) throw new Error(`unknown task ${raw}; use an invocation, flight, work item, task message, binding ref, or session id`);
    const flight = this.options.currentFlight(invocation.id);
    if (!flight) throw new Error(`task ${invocation.id} has no current execution record`);
    return { invocation, flight };
  }
  private selectInvocation(raw: string, matches: InvocationRequest[]): InvocationRequest | undefined {
    const unique = [...new Map(matches.map(item => {
      const loaded = this.options.invocation(item.id) ?? item;
      return [loaded.id, loaded] as const;
    })).values()];
    if (unique.length === 0) return undefined;
    const open = unique.filter(item => {
      const flight = this.options.currentFlight(item.id);
      return Boolean(flight && !taskTerminal(flight));
    });
    const pool = open.length > 0 ? open : unique;
    if (pool.length > 1) throw new Error(`ambiguous task ${raw}; use the full invocation or flight ID`);
    return pool[0];
  }
  private invocationForWork(snapshot: RuntimeRegistrySnapshot, raw: string, ref: string): InvocationRequest | undefined {
    const record = snapshot.collaborationRecords[ref];
    // A question or other collaboration record is not a work handle, even when
    // an invocation points at it. A missing record still counts: the invocation
    // link is enough.
    if (record && record.kind !== "work_item") return undefined;
    const matches = Object.values(snapshot.invocations).filter(item => item.collaborationRecordId === ref
      || item.metadata?.collaborationRecordId === ref || item.metadata?.workId === ref);
    if (!record && matches.length === 0) return undefined;
    return this.selectInvocation(raw, matches);
  }
  private invocationForSession(snapshot: RuntimeRegistrySnapshot, raw: string, sessionId: string, harness?: AgentHarness): InvocationRequest | undefined {
    const agentIds = new Set<string>();
    for (const endpoint of Object.values(snapshot.endpoints)) {
      if (endpointStronglyMatchesSession(endpoint, sessionId, harness)) agentIds.add(endpoint.agentId);
    }
    if (!harness && snapshot.agents[sessionId]) agentIds.add(sessionId);
    const matches = Object.values(snapshot.invocations).filter(item => agentIds.has(item.targetAgentId)
      || (!harness && item.execution?.targetSessionId === sessionId));
    if (matches.length === 0) return undefined;
    return this.selectInvocation(raw, matches);
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
    return this.options.forward(home, kind, kind === "ask" ? taskHomeAskPayload(payload as ScoutDeliverRequest, task.invocation.id) : payload);
  }
  /**
   * Ready's Continue: "Continue" goes into the task's own session. An open
   * task (waiting on review) gets a follow-up that starts its next turn; a
   * finished one gets a successor in the same session, bound to the same
   * work item and still marked notify when it was.
   */
  async continueReady(input: { invocationId: string; requestId: string; actorId: string; notify: boolean; workId?: string; body?: string }): Promise<ScoutDeliverResponse> {
    const task = await this.resolve(input.invocationId);
    const body = input.body ?? "Continue";
    const finished = taskTerminal(task.flight);
    const response = await this.ask({
      requestId: input.requestId, body, intent: "consult", requesterId: input.actorId, caller: { actorId: input.actorId },
      task: { version: 1, ...(finished ? { continue: task.invocation.id } : { ref: task.invocation.id }), ...(input.notify ? { notify: true } : {}) },
      ...(finished && input.workId ? { collaborationRecordId: input.workId, invocationMetadata: { collaborationRecordId: input.workId } } : {}),
    }, { sameSession: true });
    if (!response) throw new Error(`task ${task.invocation.id} could not be continued`);
    return response;
  }
  async ask(payload: ScoutDeliverRequest, options: { sameSession?: boolean } = {}): Promise<ScoutDeliverResponse | null> {
    const request = payload.task;
    if (!request?.ref && !request?.continue) return null;
    const task = await this.resolve(request.ref ?? request.continue!);
    const placeholder = request.cancel ? supersededPlaceholder(task) : undefined;
    if (!placeholder && this.home(task) !== this.options.nodeId) return await this.forward(task, "ask", payload) as ScoutDeliverResponse;
    const { invocation, flight } = task;
    const { requesterId: actor, requesterNodeId } = callerContextForDelivery(payload, this.options);
    const claimedSession = claimedFollowupSession(payload);
    const requesterSession = !request.cancel && !request.continue && requesterNodeId === this.options.nodeId
      && isRequesterSession(invocation, requesterNodeId, claimedSession) ? claimedSession : undefined;
    const asker = actor === invocation.requesterId || actor === this.options.operatorActorId;
    const conversation = invocation.conversationId && this.options.snapshot().conversations[invocation.conversationId];
    if (!asker && !requesterSession && (request.cancel || request.continue || !conversation || !conversation.participantIds.includes(actor))) {
      // Name who may act; never tell the caller to claim another identity.
      const requester = invocation.requesterId === this.options.operatorActorId
        ? `the operator (${invocation.requesterId})`
        : `the original requester (${invocation.requesterId}) or the operator`;
      const eligible = request.cancel || request.continue
        ? `Only ${requester} may ${request.cancel ? "cancel" : "continue"} it.`
        : `Only ${requester}, the harness session that asked it, or a participant in the task conversation may add context to it.`;
      throw new ProvenRequestFailure(
        `Task ${invocation.id} is not authorized for sender ${actor}. ${eligible} Ask one of them to send it.`,
        "task_followup_unauthorized", flight.id,
      );
    }
    if (request.continue) {
      if (!taskTerminal(flight)) throw new Error(`task ${invocation.id} is unfinished; use --ref ${invocation.id} to add context where supported, or wait for it to finish before continuing`);
      const context = `Previous task ${invocation.id} (${flight.state}):\n${flight.output ?? flight.error ?? flight.summary ?? "No result recorded."}`;
      const overrides = request.successor;
      if (overrides?.host && !overrides.projectPath?.trim()) throw new Error("successor --on requires --project <path on that host>");
      const projectPath = overrides?.projectPath;
      // A cardless session has no agent card to resolve. Address that session
      // directly instead of giving the agent resolver the predecessor's ref.
      const trace = flightSessionTrace(flight).at(-1);
      const sessionActor = this.options.snapshot().actors[invocation.targetAgentId]?.kind === "session"
        || invocation.execution?.targetSessionId === invocation.targetAgentId
        || Boolean(options.sameSession && (trace?.sessionId ?? invocation.execution?.targetSessionId));
      const sessionId = sessionActor ? trace?.sessionId ?? invocation.execution?.targetSessionId ?? invocation.targetAgentId : undefined;
      const harness = trace?.harness ?? invocation.execution?.harness;
      const target = projectPath
        ? { kind: "project_path" as const, projectPath, ...(overrides?.host ? { host: overrides.host } : {}) }
        : sessionId ? { kind: "session_id" as const, sessionId, ...(harness ? { harness } : {}) }
        : { kind: "agent_id" as const, agentId: invocation.targetAgentId };
      const execution = target.kind === "session_id"
        ? { ...payload.execution, ...(harness ? { harness } : {}), session: "existing" as const, targetSessionId: target.sessionId }
        : { ...payload.execution, session: "new" as const };
      return this.options.accept({ ...payload, task: { version: 1, ...(request.callback ? { callback: request.callback } : {}),
        ...(request.because ? { because: request.because } : {}), ...(request.notify ? { notify: true } : {}) },
        target, targetLabel: undefined, targetAgentId: target.kind === "agent_id" ? invocation.targetAgentId : undefined,
        body: `${context}\n\nSuccessor task:\n${payload.body}`, execution,
        invocationMetadata: { ...payload.invocationMetadata, predecessorTaskId: invocation.id, predecessorState: flight.state } });
    }
    const messageId = taskMessageId(actor, payload.requestId!);
    // A follow-up's reason travels in the text the worker reads.
    const body = request.because ? `${payload.body}\n\nBecause: ${request.because}` : payload.body;
    const existing = await readMessageRecord(this.options.snapshot().messages, messageId);
    const retry = existing?.metadata?.taskFollowup as { invocationId?: string; cancel?: boolean; flightId?: string } | undefined;
    if (existing) {
      if (retry?.invocationId !== invocation.id || Boolean(retry.cancel) !== Boolean(request.cancel)
        || existing.body !== body) throw new Error("request ID conflicts with an earlier task follow-up");
      const named = retry?.flightId ? this.options.flight(retry.flightId) : undefined;
      return this.followupReceipt(existing, named ? { ...task, flight: named } : task);
    }
    if (placeholder) return this.cancelPlaceholder(task, placeholder, payload, actor, messageId, body, conversation || undefined);
    const cancelledByRequest = request.cancel && flight.state === "cancelled"
      && flight.metadata?.taskCancellationRequestId === payload.requestId;
    if (taskTerminal(flight) && !cancelledByRequest) throw finishedTaskError(invocation.id);
    if (!conversation || !invocation.messageId) throw new Error("task has no replyable conversation");
    let interrupted = false;
    if (request.cancel && !cancelledByRequest) {
      await this.options.recordFlight({ ...flight, state: "cancelled", completedAt: this.now(), error: body,
        summary: "Task cancelled by its asker.", metadata: { ...flight.metadata, taskCancellationRequestId: payload.requestId } },
        () => { const current = this.options.currentFlight(invocation.id); return Boolean(current && !taskTerminal(current) && !current.metadata?.taskFinalReplyMessageId); });
      const current = this.options.currentFlight(invocation.id)!;
      if (current.state !== "cancelled" || current.metadata?.taskCancellationRequestId !== payload.requestId) throw finishedTaskError(invocation.id);
      interrupted = await this.options.interrupt?.(invocation, flight).catch(() => false) ?? false;
    }
    const message: MessageRecord = {
      id: messageId, requestId: payload.requestId,
      conversationId: conversation.id, replyToMessageId: invocation.messageId, actorId: actor, originNodeId: this.options.nodeId,
      class: "status", body, attachments: payload.attachments,
      audience: request.cancel ? { delivery: "none" } : followupAudience(invocation, flight),
      visibility: messageVisibilityForConversation(conversation), policy: "durable", createdAt: this.now(),
      metadata: { ...(payload.invocationMetadata?.attribution ? { attribution: payload.invocationMetadata.attribution } : {}),
        source: "scout-task-followup", taskFollowup: { invocationId: invocation.id, cancel: Boolean(request.cancel),
          ...(requesterSession ? { requesterSession } : {}) },
        targetSessionId: flightSessionTrace(flight).at(-1)?.sessionId ?? invocation.execution?.targetSessionId,
        workerInterrupted: interrupted, clientMessageId: taskMessageId(actor, payload.requestId!) },
    };
    await this.postMessage(message, payload.image);
    return this.followupReceipt(message, task);
  }
  /** The named placeholder is cancelled here; the invocation's current flight is left alone. */
  private async cancelPlaceholder(task: Task, placeholder: FlightRecord, payload: ScoutDeliverRequest, actor: string,
    messageId: string, body: string, conversation: import("@openscout/protocol").ConversationDefinition | undefined): Promise<ScoutDeliverResponse> {
    const { invocation, flight } = task;
    if (taskTerminal(placeholder)) throw new Error(`flight ${placeholder.id} is already ${placeholder.state}; invocation ${invocation.id} continues on ${flight.id}`);
    if (placeholder.state !== "queued" && placeholder.state !== "waking") {
      throw new Error(`flight ${placeholder.id} is superseded by ${flight.id} but is ${placeholder.state}; read scout flight get ${placeholder.id}`);
    }
    if (!this.options.cancelSupersededFlight) throw new Error(`flight ${placeholder.id} is superseded by ${flight.id}; cancel it with scout flight cancel ${placeholder.id}`);
    if (!conversation || !invocation.messageId) throw new Error("task has no replyable conversation");
    const cancelled = await this.options.cancelSupersededFlight(placeholder,
      `Cancelled by its asker. This flight was superseded by ${flight.id} and never ran.`);
    const latest = cancelled ?? this.options.flight(placeholder.id) ?? placeholder;
    if (!taskTerminal(latest)) throw new Error(`flight ${placeholder.id} could not be cancelled; read scout flight get ${placeholder.id}`);
    const message: MessageRecord = {
      id: messageId, requestId: payload.requestId,
      conversationId: conversation.id, replyToMessageId: invocation.messageId, actorId: actor, originNodeId: this.options.nodeId,
      class: "status", body, attachments: payload.attachments, audience: { delivery: "none" },
      visibility: messageVisibilityForConversation(conversation), policy: "durable", createdAt: this.now(),
      metadata: { ...(payload.invocationMetadata?.attribution ? { attribution: payload.invocationMetadata.attribution } : {}),
        source: "scout-task-followup", taskFollowup: { invocationId: invocation.id, cancel: true, flightId: placeholder.id },
        workerInterrupted: false, clientMessageId: messageId },
    };
    await this.postMessage(message, payload.image);
    return this.followupReceipt(message, { ...task, flight: latest });
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

  /**
   * `extra.metadata` is for runtime callers only (a decision answer rides on
   * its reply this way); it never comes from a client and is not forwarded.
   */
  async reply(input: ScoutTaskReply, extra: { metadata?: Record<string, unknown> } = {}): Promise<unknown> {
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
        metadata: { ...clientReplyMetadata(input.metadata), ...extra.metadata, clientMessageId: taskMessageId(input.senderId, input.requestId), source: "scout-reply",
          completionReply: { invocationId: invocation.id, flightId: flight.id, revision: flightCompletion(flight)?.revision ?? 0,
            kind: input.waitingOn ? "blocked" : input.progress ? "progress" : "final",
            ...(input.waitingOn ? { waitingOn: parseReplyWaitingOn(input.waitingOn) } : {}), ...(input.failed ? { outcome: "failed" } : {}) } } }, input.image);
    }
    const message = await resolveBrokerMessageRefAsync(this.options.snapshot(), input.to!);
    if (!message) throw new Error(`unknown conversation message ${input.to}`);
    const conversation = this.options.snapshot().conversations[message.conversationId];
    if (!conversation?.participantIds.includes(input.senderId) && input.senderId !== this.options.operatorActorId) throw new Error("conversation reply sender is not a participant");
    return this.postMessage({ id: taskMessageId(input.senderId, input.requestId), requestId: input.requestId,
      conversationId: message.conversationId, replyToMessageId: message.id, actorId: input.senderId, originNodeId: this.options.nodeId,
      class: "status", body: input.body, attachments: input.attachments, audience: { notify: [message.actorId], reason: "thread_reply" },
      visibility: messageVisibilityForConversation(conversation), policy: "durable", createdAt: this.now(),
      metadata: { ...clientReplyMetadata(input.metadata), source: "scout-conversation-reply", clientMessageId: taskMessageId(input.senderId, input.requestId) } }, input.image);
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
