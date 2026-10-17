import type { ActorIdentity, AgentEndpoint, CollaborationRecord, DeliveryIntent, FlightRecord, InvocationRequest, MessageRecord, ScoutDeliverRequest, ScoutDeliverResponse } from "@openscout/protocol";
import { endpointMatchesTargetSession } from "../broker-endpoint-selection.js";
import { invocationTargetSessionId } from "../broker-local-invocation-helpers.js";
import { runtimeSessionHandleForEndpoint } from "../runtime-session-handle.js";
import { T3Adapter, object, sourceId, t3CardWorkItem, t3Connections, t3ScopedId } from "./adapter.js";
import { admitT3CardRun, runT3BoardCard } from "./card-run.js";
import { resolveT3TurnResult, type T3SourceTerminalState } from "./turn-result.js";
import { T3RpcError } from "./rpc-client.js";

export interface BrokerT3ServiceOptions {
  nodeId: string;
  env?: NodeJS.ProcessEnv;
  adapter?: (connectionId: string) => T3Adapter;
  endpoints(): AgentEndpoint[];
  persistEndpoint(endpoint: AgentEndpoint): Promise<void>;
  persistActor(actor: ActorIdentity): Promise<void>;
  recordWork(record: CollaborationRecord): Promise<unknown>;
  work(id: string): CollaborationRecord | undefined;
  delivery(id: string): DeliveryIntent | undefined;
  recordDelivery(delivery: DeliveryIntent): Promise<void>;
  mutateDelivery(id: string, update: (current: DeliveryIntent) => DeliveryIntent | null): Promise<DeliveryIntent | undefined>;
  flight(id: string): FlightRecord | undefined;
  recordFlight(flight: FlightRecord): Promise<void>;
  postMessage(message: MessageRecord): Promise<unknown>;
  deliver?(request: ScoutDeliverRequest): Promise<ScoutDeliverResponse>;
  pollMs?: number;
  cancellationReconcileMs?: number;
}
const terminal = (flight?: FlightRecord) => !flight || ["completed", "failed", "cancelled"].includes(flight.state);
const deliveryId = (id: string) => t3ScopedId("t3-invocation", id);
export function isT3Endpoint(endpoint: AgentEndpoint | undefined | null): boolean {
  return endpoint?.transport === "http" && endpoint.metadata?.t3Session === true;
}

/** Broker writes coordination state; T3 owns its board, transcript and approvals. */
export class BrokerT3Service {
  private readonly active = new Map<string, Promise<void>>();
  private readonly busyThreads = new Map<string, string>();
  private readonly cancellations = new Map<string, Promise<void>>();
  private readonly submissions = new Map<string, { controller: AbortController; settled: Promise<void> }>();
  private readonly env: NodeJS.ProcessEnv;
  constructor(private readonly deps: BrokerT3ServiceOptions) { this.env = deps.env ?? process.env; }
  private adapter(connectionId: string) {
    if (this.deps.adapter) return this.deps.adapter(connectionId);
    const config = t3Connections(this.env).find(c => c.id === connectionId);
    if (!config) throw new Error("t3_connection_not_configured");
    return new T3Adapter(config, this.env);
  }
  inspect(connectionId: string) { return this.adapter(connectionId).inspect(); }
  board(connectionId: string, projectId: string) { return this.adapter(connectionId).board(projectId); }
  runCard(connectionId: string, projectId: string, cardId: string, requestId: string) {
    if (!this.deps.deliver) throw new Error("t3_delivery_service_unavailable");
    this.adapter(connectionId); // Operator-configured connections only, before creating Scout state.
    return admitT3CardRun({ connectionId, projectId, cardId, requestId }, { ...this.deps, deliver: this.deps.deliver });
  }
  async refresh(connectionId: string, projectId: string) {
    const { project, board } = await this.board(connectionId, projectId);
    const records = [];
    for (const card of board.cards) {
      const record = t3CardWorkItem(connectionId, projectId, card, Date.now());
      const existing = this.deps.work(record.id);
      // Preserve Scout conversation/correlation links while refreshing source facts.
      await this.deps.recordWork({ ...existing, ...record, waitingOn: record.waitingOn, completedAt: record.completedAt,
        summary: record.summary, relations: record.relations, metadata: { ...existing?.metadata, ...record.metadata },
        ...(existing?.conversationId ? { conversationId: existing.conversationId } : {}) });
      records.push(record);
    }
    return { connectionId, projectId: project.id, records };
  }
  async attach(connectionId: string, threadId: string) {
    const adapter = this.adapter(connectionId), thread = await adapter.thread(threadId);
    const actorId = t3ScopedId("t3", connectionId, thread.projectId);
    const id = t3ScopedId("t3-endpoint", this.deps.nodeId, connectionId, thread.projectId, threadId);
    const prior = this.deps.endpoints().find(e => e.id === id);
    await this.deps.persistActor({ id: actorId, kind: "agent", displayName: `T3 ${thread.projectId}`, metadata: { hostIntegration: "t3-orchestrator" } });
    const endpoint: AgentEndpoint = { id, agentId: actorId, nodeId: this.deps.nodeId, harness: "bridge", transport: "http", state: "idle",
      sessionId: `t3:${connectionId}:${thread.projectId}:${threadId}`,
      metadata: { ...prior?.metadata, hostIntegration: "t3-orchestrator", t3Session: true, externalSession: true,
        connectionId, projectId: thread.projectId, nativeSessionId: threadId,
        externalSessionId: t3ScopedId("t3-session", connectionId, thread.projectId, threadId),
        nativeProvider: thread.session?.providerName ?? thread.modelSelection?.instanceId, nativeModel: thread.modelSelection?.model,
        attachedAt: Date.now() } };
    await this.deps.persistEndpoint(endpoint);
    return { sessionId: runtimeSessionHandleForEndpoint(endpoint), endpointId: id, connectionId, projectId: thread.projectId, threadId,
      title: thread.title, provider: endpoint.metadata?.nativeProvider, model: endpoint.metadata?.nativeModel,
      instructions: "Use this sessionId as the exact target of scout ask. T3 retains its configured model, runtime mode and approval policy." };
  }
  endpointFor(invocation: InvocationRequest) {
    const sessionId = invocationTargetSessionId(invocation);
    return sessionId ? this.deps.endpoints().find(e => isT3Endpoint(e) && e.nodeId === this.deps.nodeId
      && e.agentId === invocation.targetAgentId && endpointMatchesTargetSession(e, sessionId)) : undefined;
  }
  hasPendingInvocation(id: string) {
    return this.active.has(id) || Boolean(this.deps.delivery(deliveryId(id)) && !terminal(this.deps.flight(id)));
  }
  authorizesReplyCompletion(invocation: InvocationRequest, message: MessageRecord): boolean {
    const endpoint = this.endpointFor(invocation);
    if (!endpoint) return true;
    const receipt = this.deps.delivery(deliveryId(invocation.id));
    return message.id === t3ScopedId("t3-reply", invocation.id)
      && message.actorId === endpoint.agentId && message.originNodeId === this.deps.nodeId
      && message.conversationId === invocation.conversationId && message.replyToMessageId === invocation.messageId
      && receipt?.metadata?.resultBody === message.body
      && message.metadata?.invocationId === invocation.id && message.metadata?.t3DeliveryId === receipt?.id
      && message.metadata?.t3ThreadId === receipt?.metadata?.threadId
      && message.metadata?.t3TurnId === receipt?.metadata?.turnId;
  }
  async dispatch(invocation: InvocationRequest, endpoint: AgentEndpoint): Promise<void> {
    if (this.active.has(invocation.id) || terminal(this.deps.flight(invocation.id))) return;
    const task = endpoint.metadata?.t3CardId ? this.runBoard(invocation, endpoint) : this.run(invocation, endpoint);
    this.active.set(invocation.id, task);
    try { await task; } finally { if (this.active.get(invocation.id) === task) this.active.delete(invocation.id); }
  }
  private async update(invocationId: string, patch: Partial<FlightRecord>) {
    const current = this.deps.flight(invocationId);
    if (terminal(current)) return;
    const next = { ...current!, ...patch, metadata: { ...current!.metadata, ...patch.metadata } };
    // A reconnect retry should not rewrite identical waiting state forever.
    if (JSON.stringify(current) !== JSON.stringify(next)) await this.deps.recordFlight(next);
  }
  private async runBoard(invocation: InvocationRequest, endpoint: AgentEndpoint) {
    if (!invocation.conversationId || !invocation.messageId) throw new Error("t3_reply_context_required");
    const connectionId = sourceId(endpoint.metadata?.connectionId), projectId = sourceId(endpoint.metadata?.projectId), cardId = sourceId(endpoint.metadata?.t3CardId);
    const key = JSON.stringify([connectionId, projectId, "card", cardId]);
    const owner = this.busyThreads.get(key);
    if (owner && owner !== invocation.id) throw new Error("t3_card_busy");
    this.busyThreads.set(key, invocation.id);
    try {
      const receipt = this.deps.delivery(deliveryId(invocation.id));
      if (typeof receipt?.metadata?.resultBody === "string" && typeof receipt.metadata.turnId === "string") {
        await this.complete(invocation, endpoint, receipt.metadata.resultBody, receipt.metadata.turnId);
        return;
      }
      await runT3BoardCard(invocation, endpoint, { ...this.deps, adapter: this.adapter(connectionId), deliveryId: deliveryId(invocation.id),
        update: patch => this.update(invocation.id, patch), complete: (output, turnId) => this.complete(invocation, endpoint, output, turnId) });
    } finally { if (this.busyThreads.get(key) === invocation.id) this.busyThreads.delete(key); }
  }
  private async run(invocation: InvocationRequest, endpoint: AgentEndpoint) {
    if (!invocation.conversationId || !invocation.messageId) throw new Error("t3_reply_context_required");
    const connectionId = sourceId(endpoint.metadata?.connectionId), threadId = sourceId(endpoint.metadata?.nativeSessionId);
    const key = JSON.stringify([connectionId, threadId]);
    const owner = this.busyThreads.get(key);
    if (owner && owner !== invocation.id) throw new Error("t3_thread_busy");
    this.busyThreads.set(key, invocation.id);
    try {
      const adapter = this.adapter(connectionId), id = deliveryId(invocation.id);
      let receipt = this.deps.delivery(id);
      if (receipt?.metadata?.phase === "rejected") {
        await this.update(invocation.id, { state: "failed", error: "t3_dispatch_rejected", summary: "T3 rejected the original submission.", completedAt: Date.now() });
        return;
      }
      if (typeof receipt?.metadata?.resultBody === "string" && typeof receipt.metadata.turnId === "string") {
        await this.complete(invocation, endpoint, receipt.metadata.resultBody, receipt.metadata.turnId);
        return;
      }
      if (!receipt) {
        if (invocation.execution?.harness || invocation.execution?.model || invocation.execution?.reasoningEffort
          || invocation.execution?.permissionProfile || invocation.execution?.session === "fork"
          || ["foreground", "attached"].includes(invocation.execution?.placement ?? "")) throw new Error("t3_runtime_override_unsupported");
        const thread = await adapter.thread(threadId);
        if (thread.projectId !== endpoint.metadata?.projectId) throw new Error("t3_project_identity_mismatch");
        if (thread.latestTurn?.state === "running" || ["running", "starting"].includes(thread.session?.status)) throw new Error("t3_thread_busy");
        if (thread.deletedAt || thread.archivedAt || thread.session?.autoWakePaused || thread.session?.status === "stopped") throw new Error("t3_thread_stopped_or_archived");
        if (!invocation.ensureAwake) throw new Error("t3_awake_only_delivery_unsupported");
        receipt = { id, invocationId: invocation.id, messageId: invocation.messageId, targetId: endpoint.agentId, targetNodeId: this.deps.nodeId,
          targetKind: "agent", transport: "http", reason: "invocation", policy: "durable", status: "sent",
          metadata: { externalSession: true, t3Session: true, endpointId: endpoint.id, connectionId, threadId, projectId: thread.projectId,
            commandId: t3ScopedId("scout-command", invocation.id), messageId: t3ScopedId("scout-message", invocation.id),
            requestedAt: new Date().toISOString(), phase: "submitting" } };
        // Record the attempt before sending. Any interrupted acceptance is reconciled, never resent.
        await this.deps.recordDelivery(receipt);
        if (terminal(this.deps.flight(invocation.id))) return;
        let settle!: () => void;
        const submission = { controller: new AbortController(), settled: new Promise<void>(resolve => { settle = resolve; }) };
        this.submissions.set(invocation.id, submission);
        const notSubmitted = async () => {
          await this.deps.mutateDelivery(id, current => ({ ...current, status: "failed", metadata: { ...current.metadata,
            phase: "cancelled_before_submission", dispatchOutcome: "not_submitted" } }));
        };
        try {
          await this.update(invocation.id, { state: "running", summary: "Submitting to the attached T3 thread.", metadata: { t3Session: true, t3DeliveryId: id, t3ThreadId: threadId,
            dispatchOutcome: { status: "submission_unknown", method: "t3.thread.turn.start", checkedAt: Date.now() } } });
          // Flight persistence yields to cancellation. Check again immediately
          // before starting the source RPC, and carry cancellation to its write.
          if (terminal(this.deps.flight(invocation.id)) || submission.controller.signal.aborted) { await notSubmitted(); return; }
          try {
            await adapter.start(thread, { commandId: String(receipt.metadata!.commandId), messageId: String(receipt.metadata!.messageId), text: invocation.task, createdAt: String(receipt.metadata!.requestedAt) }, submission.controller.signal);
            await this.deps.mutateDelivery(id, current => ({ ...current, status: "acknowledged", metadata: { ...current.metadata, phase: "accepted", dispatchOutcome: "submitted" } }));
            await this.update(invocation.id, { metadata: { dispatchOutcome: { status: "submitted", method: "t3.thread.turn.start", checkedAt: Date.now() } } });
          } catch (error) {
            if (error instanceof T3RpcError && error.code === "aborted" && error.requestSent === false) {
              await notSubmitted();
              return;
            }
            if (error instanceof T3RpcError && ["remote", "authentication"].includes(error.code)) {
              await this.deps.mutateDelivery(id, current => ({ ...current, status: "failed", metadata: { ...current.metadata,
                phase: "rejected", dispatchOutcome: "rejected", rejectionCode: error.code, ...(error.remoteTag ? { rejectionTag: error.remoteTag } : {}) } }));
              await this.update(invocation.id, { state: "failed", error: "t3_dispatch_rejected", summary: "T3 rejected the submitted request.", completedAt: Date.now(),
                metadata: { dispatchOutcome: { status: "rejected", method: "t3.thread.turn.start", checkedAt: Date.now() } } });
              return;
            }
            await this.update(invocation.id, { state: "waiting", summary: "T3 submission is unconfirmed. Reconciling the exact source message; the request will not be resent." });
          }
        } finally {
          settle();
          if (this.submissions.get(invocation.id) === submission) this.submissions.delete(invocation.id);
        }
      }
      // Full snapshots recover source facts after every reconnect, without replaying a mutation.
      while (!terminal(this.deps.flight(invocation.id))) {
        try {
          const thread = await adapter.thread(threadId);
          if (thread.projectId !== endpoint.metadata?.projectId) throw new Error("t3_project_identity_mismatch");
          receipt = this.deps.delivery(id)!;
          const expectedMessage = String(receipt.metadata?.messageId);
          const resolved = resolveT3TurnResult(thread, { messageId: expectedMessage,
            turnId: typeof receipt.metadata?.turnId === "string" ? receipt.metadata.turnId : undefined,
            terminalState: receipt.metadata?.terminalState as T3SourceTerminalState | undefined });
          const turnId = resolved.turnId;
          const sourceTerminal = turnId && thread.latestTurn?.turnId === turnId
            && ["completed", "error", "interrupted"].includes(thread.latestTurn.state) ? thread.latestTurn.state : undefined;
          if (turnId && (receipt.metadata?.turnId !== turnId || sourceTerminal && receipt.metadata?.terminalState !== sourceTerminal)) {
            await this.deps.mutateDelivery(id, current => ({ ...current, status: "acknowledged", metadata: { ...current.metadata, phase: "accepted", turnId,
              ...(sourceTerminal ? { terminalState: sourceTerminal } : {}), dispatchOutcome: "submitted" } }));
            await this.update(invocation.id, { metadata: { dispatchOutcome: { status: "submitted", method: "t3.thread.turn.start", checkedAt: Date.now() } } });
          }
          if (resolved.state === "completed" && turnId && resolved.output) {
            await this.complete(invocation, endpoint, resolved.output, turnId);
            return;
          }
          if (resolved.state === "failed" || resolved.state === "cancelled") {
            await this.update(invocation.id, { state: resolved.state, error: resolved.state === "failed" ? "t3_turn_error" : "t3_turn_interrupted", completedAt: Date.now() });
            return;
          }
          if (resolved.state === "unconfirmed") {
            await this.update(invocation.id, { state: "waiting", summary: "T3 has not exposed the exact submitted message. Delivery remains unconfirmed; automatic resend is disabled." });
          } else {
            const pending = pendingT3Attention(thread, turnId);
            const waiting = Boolean(pending) || resolved.state === "waiting";
            await this.update(invocation.id, { state: waiting ? "waiting" : "running", summary: pending ? "T3 is waiting for a decision in its native thread."
              : waiting ? "T3 has no correlated final response for the recorded turn; inspect the source thread." : "T3 is executing the correlated request.",
              metadata: { t3ThreadId: threadId, t3TurnId: turnId, t3Attention: pending ?? null } });
          }
        } catch {
          await this.update(invocation.id, { state: "waiting", summary: "T3 is unavailable. Scout will reconcile the existing request after reconnect; no new execution will be started." });
        }
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, this.deps.pollMs ?? 1500); timer.unref?.(); });
      }
    } finally { if (this.busyThreads.get(key) === invocation.id) this.busyThreads.delete(key); }
  }
  private async complete(invocation: InvocationRequest, endpoint: AgentEndpoint, output: string, turnId: string) {
    const id = deliveryId(invocation.id);
    await this.deps.mutateDelivery(id, current => ({ ...current, metadata: { ...current.metadata, resultBody: output, turnId, resultAt: current.metadata?.resultAt ?? Date.now() } }));
    const receipt = this.deps.delivery(id)!;
    const messageId = t3ScopedId("t3-reply", invocation.id);
    if (terminal(this.deps.flight(invocation.id))) return;
    await this.deps.postMessage({ id: messageId, actorId: endpoint.agentId, originNodeId: this.deps.nodeId, conversationId: invocation.conversationId!,
      replyToMessageId: invocation.messageId, class: "agent", visibility: "private", policy: "durable", body: output, createdAt: Number(receipt.metadata?.resultAt),
      metadata: { clientMessageId: messageId, invocationId: invocation.id, t3DeliveryId: id, t3ThreadId: receipt.metadata?.threadId, t3TurnId: turnId } });
    await this.update(invocation.id, { state: "completed", output, summary: "The attached T3 thread returned its final response.", completedAt: Date.now() });
    await this.deps.mutateDelivery(id, current => ({ ...current, status: "completed", metadata: { ...current.metadata, phase: "replied", replyMessageId: messageId } }));
  }
  /** Cancel only a source turn proven to belong to this invocation. */
  cancel(invocation: InvocationRequest): Promise<void> {
    const current = this.cancellations.get(invocation.id);
    if (current) return current;
    const task = Promise.resolve().then(() => this.cancelSource(invocation));
    this.cancellations.set(invocation.id, task);
    void task.finally(() => { if (this.cancellations.get(invocation.id) === task) this.cancellations.delete(invocation.id); }).catch(() => {});
    return task;
  }
  private async cancelSource(invocation: InvocationRequest): Promise<void> {
    if (this.deps.flight(invocation.id)?.state !== "cancelled") return;
    const submission = this.submissions.get(invocation.id);
    submission?.controller.abort();
    const until = Date.now() + (this.deps.cancellationReconcileMs ?? 5_000);
    if (submission) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([submission.settled, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(1, until - Date.now())); })]); }
      finally { if (timer) clearTimeout(timer); }
    }
    const endpoint = this.endpointFor(invocation), id = deliveryId(invocation.id), receipt = this.deps.delivery(id);
    if (!endpoint || !receipt || receipt.metadata?.cancellation) return;
    const annotate = async (state: string, details: Record<string, unknown> = {}) => {
      await this.deps.mutateDelivery(id, current => ({ ...current, metadata: { ...current.metadata, cancellation: { state, ...details } } }));
      const flight = this.deps.flight(invocation.id);
      if (flight?.state === "cancelled") await this.deps.recordFlight({ ...flight, metadata: { ...flight.metadata, t3Cancellation: { state, ...details } } });
    };
    if (endpoint.metadata?.t3CardId) {
      await annotate("native_workflow_requires_t3", { detail: "Scout tracking cancelled. Stop the board workflow in T3 to prevent later stages." });
      return;
    }
    if (["cancelled_before_submission", "rejected"].includes(String(receipt.metadata?.phase))) {
      await annotate("not_submitted", { detail: "The source turn was not submitted or T3 rejected it." });
      return;
    }
    try {
      const adapter = this.adapter(sourceId(endpoint.metadata?.connectionId)), threadId = sourceId(endpoint.metadata?.nativeSessionId);
      let thread: Awaited<ReturnType<T3Adapter["thread"]>> | undefined;
      let resolved: ReturnType<typeof resolveT3TurnResult> | undefined;
      do {
        try {
          thread = await adapter.thread(threadId, { timeoutMs: Math.max(1, until - Date.now()) });
          if (thread.projectId !== endpoint.metadata?.projectId) break;
          const current = this.deps.delivery(id) ?? receipt;
          resolved = resolveT3TurnResult(thread, { messageId: String(current.metadata?.messageId),
            turnId: typeof current.metadata?.turnId === "string" ? current.metadata.turnId : undefined });
          if (resolved.turnId) break;
        } catch { /* Read-only reconciliation can retry within its bounded window. */ }
        const remaining = until - Date.now();
        if (remaining > 0) await new Promise<void>(resolve => setTimeout(resolve, Math.min(this.deps.pollMs ?? 250, remaining)));
      } while (Date.now() < until);
      if (!thread) { await annotate("unconfirmed"); return; }
      if (thread.projectId !== endpoint.metadata?.projectId) {
        await annotate("unconfirmed", { detail: "The source thread no longer belongs to the attached project." });
        return;
      }
      if (!resolved?.turnId || thread.latestTurn?.turnId !== resolved.turnId) {
        await annotate("unconfirmed", { detail: "The original active source turn could not be identified. Inspect T3 before interrupting it." });
        return;
      }
      if (thread.latestTurn.state !== "running") {
        await annotate("source_already_terminal", { turnId: resolved.turnId, sourceState: thread.latestTurn.state });
        return;
      }
      // A crash or lost response after this marker must never cancel a newer turn.
      await annotate("submission_unknown", { turnId: resolved.turnId });
      await adapter.call("orchestration.dispatchCommand", { type: "thread.turn.interrupt", commandId: t3ScopedId("scout-interrupt", invocation.id),
        threadId, turnId: resolved.turnId, createdAt: new Date().toISOString() });
      await annotate("submitted", { turnId: resolved.turnId });
    } catch {
      // Retain a pre-send marker if present; an RPC acknowledgement is not proof
      // that the provider stopped. A human can inspect the original source turn.
      if (!this.deps.delivery(id)?.metadata?.cancellation) await annotate("unconfirmed");
    }
  }
  recover(invocations: Iterable<InvocationRequest>) {
    for (const invocation of invocations) {
      const endpoint = this.endpointFor(invocation);
      if (endpoint && this.deps.delivery(deliveryId(invocation.id)) && !terminal(this.deps.flight(invocation.id))) {
        void this.dispatch(invocation, endpoint).catch(() => this.update(invocation.id, { state: "waiting", summary: "T3 recovery requires the configured source connection." }));
      }
      if (endpoint && this.deps.flight(invocation.id)?.state === "cancelled") void this.cancel(invocation).catch(() => {});
    }
  }
}

/** Observed decisions stay source-owned; this adapter never manufactures an answer. */
export function pendingT3Attention(thread: Record<string, any>, turnId?: string) {
  const pending = new Map<string, Record<string, any>>();
  for (const value of thread.activities) {
    const activity = object(value);
    if (turnId && activity.turnId !== turnId) continue;
    const payload = activity.payload && typeof activity.payload === "object" ? activity.payload : {};
    const requestId = payload.requestId;
    if (typeof requestId !== "string") continue;
    if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved"
      || (["provider.approval.respond.failed", "provider.user-input.respond.failed"].includes(activity.kind)
        && /stale pending .* request|unknown pending .* request/i.test(String(payload.detail ?? "")))) pending.delete(requestId);
    else if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") pending.set(requestId, { requestId, kind: activity.kind, summary: activity.summary });
  }
  return pending.size ? [...pending.values()] : undefined;
}
