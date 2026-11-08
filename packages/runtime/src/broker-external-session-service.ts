import { createHash, randomBytes } from "node:crypto";
import type { ActorIdentity, AgentDefinition, AgentEndpoint, DeliveryIntent, FlightRecord, InvocationRequest, MessageRecord } from "@openscout/protocol";
import { taskMessageId } from "./broker-tasks.js";
import { validateTaskReply, type ScoutTaskReply } from "@openscout/protocol";
import { endpointMatchesTargetSession } from "./broker-endpoint-selection.js";
import { runtimeSessionHandleForEndpoint } from "./runtime-session-handle.js";
import { invocationTargetSessionId } from "./broker-local-invocation-helpers.js";
import { isExternalSessionEndpoint, type ExternalSessionConnection, type ExternalSessionTransport, ExternalSessionTransportError } from "./external-session-transport.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export interface ExternalSessionServiceOptions {
  nodeId: string;
  connections: () => ExternalSessionConnection[];
  transport: (connection: ExternalSessionConnection) => ExternalSessionTransport;
  endpoints: () => AgentEndpoint[];
  agent: (id: string) => AgentDefinition | undefined;
  actor: (id: string) => ActorIdentity | undefined;
  persistActor: (actor: ActorIdentity) => Promise<void>;
  visitDeliveries: (visitor: (delivery: DeliveryIntent) => void) => Promise<void>;
  persistEndpoint: (endpoint: AgentEndpoint) => Promise<void>;
  delivery: (id: string) => DeliveryIntent | undefined;
  recordDelivery: (delivery: DeliveryIntent) => Promise<void>;
  mutateDelivery: (id: string, update: (current: DeliveryIntent) => DeliveryIntent | null) => Promise<DeliveryIntent | undefined>;
  invocations: () => Iterable<InvocationRequest>;
  invocation: (id: string) => InvocationRequest | undefined;
  flight: (id: string) => FlightRecord | undefined;
  recordFlight: (flight: FlightRecord) => Promise<void>;
  postMessage: (message: MessageRecord) => Promise<unknown>;
  replyTask?: (input: ScoutTaskReply) => Promise<unknown>;
  now?: () => number;
}

/** Broker-owned attachments and receipts reuse endpoints, sessions, deliveries and flights. */
export class BrokerExternalSessionService {
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(private readonly deps: ExternalSessionServiceOptions) {}
  private now() { return (this.deps.now ?? Date.now)(); }
  private async serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    const task = prior.catch(() => undefined).then(fn);
    this.locks.set(key, task);
    try { return await task; } finally { if (this.locks.get(key) === task) this.locks.delete(key); }
  }
  private connection(id: string, ownerId?: string) {
    const connection = this.deps.connections().find((c) => c.id === id && (ownerId === undefined || c.ownerId === ownerId));
    if (!connection) throw new Error("external_session_connection_unavailable");
    return connection;
  }
  async attach(input: { ownerId: string; connectionId?: string; nativeSessionId: string; authorize?: () => void }) {
    if (!input.connectionId) return this.attachMailbox(input);
    const connection = this.connection(input.connectionId, input.ownerId);
    const agent = this.deps.agent(connection.agentId);
    if (!agent) throw new Error("external_session_agent_unregistered: register the integration agent first");
    if (agent.authorityNodeId !== this.deps.nodeId) throw new Error("external_session_wrong_authority");
    const observed = await this.deps.transport(connection).inspect(input.nativeSessionId);
    // Include the organization and connection in the resolver alias to avoid cross-account native-id collisions.
    const alias = `${connection.id}:${connection.organizationId}:${observed.nativeSessionId}`;
    const id = `external-${digest(`${this.deps.nodeId}:${alias}`).slice(0, 24)}`;
    return this.serial(id, async () => {
      const existing = this.deps.endpoints().find((e) => e.id === id);
      const endpoint: AgentEndpoint = {
        id, agentId: connection.agentId, nodeId: this.deps.nodeId, harness: "devin", transport: connection.deliveryMode === "cloud_cli" ? "devin_cloud_cli" : "http",
        state: "idle", sessionId: alias,
        metadata: { ...existing?.metadata, externalSession: true, connectionId: connection.id, ownerId: connection.ownerId,
          nativeSessionId: observed.nativeSessionId, externalSessionId: alias, providerState: observed.state, attachedAt: this.now() },
      };
      await this.deps.persistEndpoint(endpoint);
      return this.receipt(endpoint);
    });
  }
  private async attachMailbox(input: { ownerId: string; nativeSessionId: string; authorize?: () => void }) {
    if (!input.ownerId.trim() || !input.nativeSessionId.trim() || input.nativeSessionId.length > 512) throw new Error("invalid_external_session_identity");
    return this.serial(`owner:${input.ownerId}`, async () => {
      input.authorize?.();
      const alias = `mcp:${digest(JSON.stringify([input.ownerId, input.nativeSessionId.trim()]))}`;
      const id = `external-${digest(`${this.deps.nodeId}:${alias}`).slice(0, 24)}`;
      const existing = this.deps.endpoints().find((e) => e.id === id);
      if (!existing && this.deps.endpoints().filter((e) => e.metadata?.ownerId === input.ownerId && e.state !== "stopped").length >= 64) throw new Error("external_session_attachment_limit");
      if (!this.deps.actor(input.ownerId)) await this.deps.persistActor({ id: input.ownerId, kind: "agent", displayName: input.ownerId, metadata: { source: "external-mcp-integration" } });
      const endpoint: AgentEndpoint = {
        id, agentId: input.ownerId, nodeId: this.deps.nodeId, harness: "bridge", transport: "mcp_poll", state: "registered", sessionId: alias,
        metadata: { ...existing?.metadata, externalSession: true, ownerId: input.ownerId, nativeSessionId: input.nativeSessionId.trim(), externalSessionId: alias,
          deliveryMode: "poll", identityEvidence: "caller_asserted", attachedAt: this.now() },
      };
      await this.deps.persistEndpoint(endpoint);
      return this.receipt(endpoint);
    });
  }
  private receipt(endpoint: AgentEndpoint) {
    return { sessionId: runtimeSessionHandleForEndpoint(endpoint), endpointId: endpoint.id, agentId: endpoint.agentId,
      provider: endpoint.harness, nativeSessionId: endpoint.metadata?.nativeSessionId, state: endpoint.state,
      providerState: endpoint.metadata?.providerState, returnTransport: endpoint.transport === "mcp_poll" ? "mcp_poll" : endpoint.transport === "devin_cloud_cli" ? "cloud_cli" : "provider_api",
      wake: endpoint.transport === "mcp_poll" ? "none" : "resume_on_message",
      ...(endpoint.transport === "mcp_poll" ? { instructions: "Poll sessions_poll with this sessionId. Acknowledge receipt with sessions_ack; reply to work with reply and its task ref. Use this handle as replyToSessionId on every ask to receive the result here. Polling never wakes a stopped host." } : {}) };
  }
  get(input: { ownerId: string; sessionId: string }) {
    const endpoint = this.ownedEndpoint(input.ownerId, input.sessionId);
    return this.receipt(endpoint);
  }
  private ownedEndpoint(ownerId: string, sessionId: string) {
    const endpoint = this.deps.endpoints().find((e) => isExternalSessionEndpoint(e) && endpointMatchesTargetSession(e, sessionId) && e.metadata?.ownerId === ownerId);
    if (!endpoint) throw new Error("external_session_not_found");
    if (endpoint.transport !== "mcp_poll") this.connection(String(endpoint.metadata?.connectionId), ownerId);
    return endpoint;
  }
  endpointFor(invocation: InvocationRequest): AgentEndpoint | undefined {
    const sessionId = invocationTargetSessionId(invocation);
    if (!sessionId) return undefined; // Never choose a cloud session by recency or silently create one.
    return this.deps.endpoints().find((e) => isExternalSessionEndpoint(e) && e.nodeId === this.deps.nodeId
      && e.agentId === invocation.targetAgentId && endpointMatchesTargetSession(e, sessionId));
  }
  async dispatch(invocation: InvocationRequest, endpoint: AgentEndpoint): Promise<void> {
    await this.serial(`invoke:${invocation.id}`, async () => {
      const currentFlight = this.deps.flight(invocation.id);
      if (!currentFlight || ["completed", "failed", "cancelled"].includes(currentFlight.state)) return;
      if (invocation.execution?.harness && invocation.execution.harness !== endpoint.harness) throw new Error("external_session_harness_mismatch");
      const id = `external-invocation-${digest(invocation.id).slice(0, 24)}`;
      const existing = this.deps.delivery(id);
      if (!existing) { // A persisted attempt, including an interrupted send, must never be replayed blindly.
        if (!invocation.conversationId || !invocation.messageId) throw new Error("external_session_requires_reply_context");
        if ((endpoint.transport === "mcp_poll" && invocation.execution?.harness) || invocation.execution?.model || invocation.execution?.reasoningEffort || invocation.execution?.session === "fork" || (invocation.execution?.placement === "foreground" || invocation.execution?.placement === "attached") || invocation.execution?.permissionProfile) {
          throw new Error("external_session_runtime_override_unsupported");
        }
        if (endpoint.transport !== "mcp_poll" && !invocation.ensureAwake) {
          // Cloud ACP's sessionStatus has not established an awake-only send contract.
          // Do not turn a caller's no-wake request into an implicit CLI resume.
          if (endpoint.transport === "devin_cloud_cli") throw new Error("devin_cli_awake_only_delivery_unsupported");
          const connection = this.connection(String(endpoint.metadata?.connectionId));
          const observed = await this.deps.transport(connection).inspect(String(endpoint.metadata?.nativeSessionId));
          if (observed.state === "suspended") throw new Error("external_session_suspended: ensureAwake is false");
        }
        const token = randomBytes(32).toString("base64url");
        const sessionId = runtimeSessionHandleForEndpoint(endpoint)!;
        const body = `${invocation.task}\n\nScout reply address (coordination metadata):\n${JSON.stringify({ tool: "reply", ref: invocation.id, sessionId, deliveryId: id, ...(endpoint.transport === "mcp_poll" ? {} : { replyToken: token }) })}\nWhen finished, call reply with that task ref and your final body. This completes the original Scout flight. Do not start another session.`;
        await this.deliver(endpoint, id, body, { invocationId: invocation.id, messageId: invocation.messageId,
          metadata: { ...(endpoint.transport === "mcp_poll" ? {} : { replyTokenHash: digest(token) }), sessionId } });
      }
      const delivery = this.deps.delivery(id)!;
      const flight = this.deps.flight(invocation.id);
      if (flight && !["completed", "failed", "cancelled"].includes(flight.state)) {
        await this.deps.recordFlight({ ...flight, state: delivery.status === "failed" ? "failed" : "waiting",
          summary: endpoint.transport === "mcp_poll" ? "Waiting for the attached session to poll its MCP mailbox and reply; automatic wake is unavailable."
            : delivery.status === "acknowledged" ? "Provider accepted the message; waiting for the attached session's reply."
            : "External delivery is unconfirmed; do not resend automatically.",
          ...(delivery.status === "failed" ? { error: String(delivery.metadata?.error), completedAt: this.now() } : {}),
          metadata: { ...flight.metadata, externalSession: true, externalDeliveryId: id, externalSessionId: runtimeSessionHandleForEndpoint(endpoint) } });
      }
    });
  }
  private async deliver(endpoint: AgentEndpoint, id: string, body: string, fields: Partial<DeliveryIntent>) {
    const canSubmit = () => {
      if (fields.metadata?.resultNotification === true) return true;
      if (!fields.invocationId) return true;
      const flight = this.deps.flight(fields.invocationId);
      return Boolean(flight && !["completed", "failed", "cancelled"].includes(flight.state));
    };
    if (!canSubmit()) return;
    const connection = endpoint.transport === "mcp_poll" ? undefined : this.connection(String(endpoint.metadata?.connectionId), String(endpoint.metadata?.ownerId));
    const intent: DeliveryIntent = { id, targetId: endpoint.agentId, targetNodeId: this.deps.nodeId, targetKind: "agent", transport: endpoint.transport,
      reason: "invocation", policy: "durable", status: endpoint.transport === "mcp_poll" ? "accepted" : "sent", ...fields,
      metadata: { ...fields.metadata, externalSession: true, endpointId: endpoint.id, phase: endpoint.transport === "mcp_poll" ? "mailbox_queued" : "sending", attemptedAt: this.now(),
        ...(endpoint.transport === "mcp_poll" ? { mailboxBody: body } : {}) } };
    // Write before network I/O: a crash in the acceptance window becomes visible uncertainty, not a duplicate.
    if (!connection) {
      await this.serial(`mailbox:${endpoint.id}`, async () => {
        let pending = 0;
        await this.deps.visitDeliveries((d) => {
          if (d.metadata?.endpointId === endpoint.id && this.isOutstanding(d)) pending++;
        });
        if (pending >= 1000) throw new Error("external_session_mailbox_full");
        if (!canSubmit()) return;
        await this.deps.recordDelivery(intent);
        if (!canSubmit()) await this.deps.mutateDelivery(id, current => ({ ...current, status: "cancelled" }));
      });
      return;
    }
    await this.deps.recordDelivery(intent);
    if (!canSubmit()) {
      await this.deps.mutateDelivery(id, current => ({ ...current, status: "cancelled", metadata: { ...current.metadata, phase: "not_submitted" } }));
      return;
    }
    try {
      const result = await this.deps.transport(connection).send(String(endpoint.metadata?.nativeSessionId), body);
      // A very fast reply may already have completed this receipt while POST was in flight.
      await this.deps.mutateDelivery(id, (current) => ["completed", "failed", "cancelled"].includes(current.status) ? null
        : { ...current, status: "acknowledged", metadata: { ...current.metadata, phase: "provider_accepted", providerState: result.state, acceptedAt: this.now() } });
    } catch (error) {
      const uncertain = !(error instanceof ExternalSessionTransportError) || error.uncertain;
      await this.deps.mutateDelivery(id, (current) => ["completed", "failed", "cancelled"].includes(current.status) ? null
        : { ...current, status: uncertain ? "sent" : "failed",
          metadata: { ...current.metadata, phase: uncertain ? "unconfirmed" : "rejected", error: error instanceof ExternalSessionTransportError ? error.message : "external_delivery_unconfirmed" } });
    }
  }
  async recover(invocations: InvocationRequest[]): Promise<string[]> {
    const failed: string[] = [];
    for (const invocation of invocations) {
      try {
        const flight = this.deps.flight(invocation.id);
        if (!flight) continue;
        if (["completed", "failed", "cancelled"].includes(flight.state)) {
          await this.forwardResult(invocation, flight);
          continue;
        }
        // Only reconcile attempts already persisted. Unsent jobs remain owned by normal dispatch recovery.
        const id = `external-invocation-${digest(invocation.id).slice(0, 24)}`;
        if (!this.deps.delivery(id)) continue;
        const endpoint = this.endpointFor(invocation);
        if (endpoint) await this.dispatch(invocation, endpoint);
      } catch { failed.push(invocation.id); }
    }
    return failed;
  }
  authorizesReplyCompletion(invocation: InvocationRequest, message: MessageRecord): boolean {
    if (!this.endpointFor(invocation)) return true;
    const delivery = this.deps.delivery(`external-invocation-${digest(invocation.id).slice(0, 24)}`);
    return Boolean(delivery && delivery.metadata?.replyBodyHash === digest(message.body)
      && (message.id === `external-reply-${digest(delivery.id).slice(0, 24)}`
        || message.id === delivery.metadata?.taskReplyMessageId));
  }
  hasPendingInvocation(invocationId: string): boolean {
    const receipt = this.deps.delivery(`external-invocation-${digest(invocationId).slice(0, 24)}`);
    return Boolean(receipt && !["completed", "failed", "cancelled"].includes(receipt.status));
  }
  private closedMailboxStatus(delivery: DeliveryIntent): "completed" | "failed" | "cancelled" | undefined {
    if (delivery.transport !== "mcp_poll" || delivery.metadata?.resultNotification || !delivery.invocationId) return undefined;
    const state = this.deps.flight(delivery.invocationId)?.state;
    return state === "completed" || state === "failed" || state === "cancelled" ? state : undefined;
  }
  private isOutstanding(delivery: DeliveryIntent): boolean {
    return !["completed", "failed", "cancelled"].includes(delivery.status) && !this.closedMailboxStatus(delivery);
  }
  private async reconcileClosedMailbox(invocation: InvocationRequest) {
    const id = `external-invocation-${digest(invocation.id).slice(0, 24)}`;
    await this.deps.mutateDelivery(id, (current) => {
      const state = this.closedMailboxStatus(current);
      if (!state || ["completed", "failed", "cancelled"].includes(current.status)) return null;
      return { ...current, status: state, metadata: { ...current.metadata, phase: "flight_closed", closedAt: this.now() } };
    });
  }
  private async backfillResults(endpoint: AgentEndpoint) {
    // Retry bounded missing notifications on polling, including after capacity frees.
    let attempted = 0;
    for (const invocation of this.deps.invocations()) {
      const address = invocation.metadata?.returnAddress as { sessionId?: unknown } | undefined;
      if (invocation.requesterId !== endpoint.metadata?.ownerId || typeof address?.sessionId !== "string"
        || !endpointMatchesTargetSession(endpoint, address.sessionId)) continue;
      const flight = this.deps.flight(invocation.id);
      if (!flight || !["completed", "failed", "cancelled"].includes(flight.state)) continue;
      const id = `external-result-${digest(`${flight.id}:${endpoint.id}`).slice(0, 24)}`;
      if (this.deps.delivery(id)) continue;
      try { await this.forwardResult(invocation, flight); }
      catch (error) { if (error instanceof Error && error.message === "external_session_mailbox_full") break; throw error; }
      if (++attempted >= 20) break;
    }
  }
  async forwardResult(invocation: InvocationRequest, flight: FlightRecord): Promise<void> {
    if (!["completed", "failed", "cancelled"].includes(flight.state)) return;
    await this.reconcileClosedMailbox(invocation);
    const address = invocation.metadata?.returnAddress;
    if (!address || typeof address !== "object" || Array.isArray(address)) return;
    const sessionId = (address as Record<string, unknown>).sessionId;
    if (typeof sessionId !== "string") return;
    const endpoint = this.deps.endpoints().find((e) => isExternalSessionEndpoint(e)
      && e.nodeId === this.deps.nodeId && endpointMatchesTargetSession(e, sessionId)
      && e.metadata?.ownerId === invocation.requesterId);
    if (!endpoint) return;
    const id = `external-result-${digest(`${flight.id}:${endpoint.id}`).slice(0, 24)}`;
    await this.serial(id, async () => {
      if (this.deps.delivery(id)) return;
      const body = `Scout result for ${flight.id} (${flight.state})\n${flight.output || flight.error || flight.summary || "No output."}\nConversation: ${invocation.conversationId || "unknown"}\nInvocation: ${invocation.id}`;
      await this.deliver(endpoint, id, body, { reason: "thread_reply", invocationId: invocation.id,
        metadata: { sessionId, resultNotification: true } });
    });
  }
  async poll(input: { ownerId: string; sessionId: string; cursor?: string; limit?: number }) {
    const endpoint = this.ownedEndpoint(input.ownerId, input.sessionId);
    if (endpoint.transport !== "mcp_poll") throw new Error("external_session_not_polling");
    await this.backfillResults(endpoint);
    const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 20)));
    if (!Number.isFinite(limit) || (input.cursor?.length ?? 0) > 256) throw new Error("invalid_poll_page");
    const key = (d: DeliveryIntent) => `${String(d.metadata?.attemptedAt ?? 0).padStart(16, "0")}:${d.id}`;
    const page: DeliveryIntent[] = [];
    await this.deps.visitDeliveries((delivery) => {
      if (delivery.metadata?.endpointId !== endpoint.id || delivery.transport !== "mcp_poll"
        || !this.isOutstanding(delivery) || (input.cursor && key(delivery) <= input.cursor)) return;
      page.push(delivery); page.sort((a, b) => key(a).localeCompare(key(b)));
      if (page.length > limit + 1) page.pop();
    });
    const more = page.length > limit; const selected = page.slice(0, limit);
    return { sessionId: input.sessionId, automaticWake: false, items: selected.map((d) => ({ deliveryId: d.id, invocationId: d.invocationId,
      kind: d.metadata?.resultNotification ? "result" : "work", body: d.metadata?.mailboxBody, status: d.status,
      acknowledged: Boolean(d.metadata?.receivedAt) })), nextCursor: more ? key(selected[selected.length - 1]!) : null };
  }
  async acknowledge(input: { ownerId: string; sessionId: string; deliveryId: string; authorize?: () => void }) {
    const endpoint = this.ownedEndpoint(input.ownerId, input.sessionId);
    if (endpoint.transport !== "mcp_poll") throw new Error("external_session_not_polling");
    const receipt = await this.deps.mutateDelivery(input.deliveryId, (current) => {
      input.authorize?.();
      if (current.metadata?.endpointId !== endpoint.id) throw new Error("external_reply_address_invalid");
      if (["completed", "failed", "cancelled"].includes(current.status)) return null;
      const closed = this.closedMailboxStatus(current);
      if (closed) return { ...current, status: closed, metadata: { ...current.metadata, phase: "flight_closed", closedAt: this.now() } };
      return { ...current, status: current.metadata?.resultNotification ? "completed" : "acknowledged",
        metadata: { ...current.metadata, phase: current.metadata?.resultNotification ? "received" : "session_received", receivedAt: this.now() } };
    });
    if (!receipt) throw new Error("external_delivery_not_found");
    return { deliveryId: receipt.id, status: receipt.status };
  }
  async reply(input: { ownerId: string; sessionId: string; deliveryId: string; replyToken?: string; body: string; ref?: string; requestId?: string; progress?: boolean; failed?: boolean; attachments?: ScoutTaskReply["attachments"]; image?: ScoutTaskReply["image"]; authorize?: () => void }) {
    const endpoint = this.ownedEndpoint(input.ownerId, input.sessionId);
    if (typeof input.body !== "string" || !input.body.trim() || input.body.length > 100_000) throw new Error("invalid_reply_body");
    if (endpoint.transport !== "mcp_poll" && (typeof input.replyToken !== "string" || input.replyToken.length > 256)) throw new Error("invalid_reply_token");
    return this.serial(`reply:${input.deliveryId}`, async () => {
      input.authorize?.();
      const delivery = this.deps.delivery(input.deliveryId);
      if (!delivery || delivery.metadata?.resultNotification || delivery.metadata?.endpointId !== endpoint.id || (endpoint.transport !== "mcp_poll" && delivery.metadata.replyTokenHash !== digest(input.replyToken!))) throw new Error("external_reply_address_invalid");
      const invocation = delivery.invocationId ? this.deps.invocation(delivery.invocationId) : undefined;
      if (!invocation?.conversationId || !invocation.messageId) throw new Error("external_reply_invocation_missing");
      if (input.ref) {
        validateTaskReply({ ref: input.ref, progress: input.progress, failed: input.failed });
        if (input.ref !== invocation.id) throw new Error("external_reply_task_mismatch");
        if (!input.requestId?.trim() || !this.deps.replyTask) throw new Error("external task reply requires requestId and ask-reply/1");
        const messageId = taskMessageId(endpoint.agentId, input.requestId);
        input.authorize?.();
        if (!input.progress) await this.deps.mutateDelivery(delivery.id, current => {
          if (current.metadata?.taskReplyMessageId && (current.metadata.taskReplyMessageId !== messageId
            || current.metadata.replyBodyHash !== digest(input.body))) throw new Error("task already has a final reply");
          return { ...current, metadata: { ...current.metadata, taskReplyMessageId: messageId, replyBodyHash: digest(input.body) } };
        });
        let result: unknown;
        try {
          result = await this.deps.replyTask({ ref: invocation.id, senderId: endpoint.agentId,
            requestId: input.requestId, body: input.body, progress: input.progress, failed: input.failed,
            attachments: input.attachments, image: input.image });
        } catch (error) {
          const flight = this.deps.flight(invocation.id);
          // Preserve an observed committed claim after an uncertain apply/ack.
          // Otherwise a failed write must not own the next final attempt.
          if (!input.progress && flight?.metadata?.taskFinalReplyMessageId !== messageId
            && flight?.metadata?.replyMessageId !== messageId) await this.deps.mutateDelivery(delivery.id, current => {
            if (current.metadata?.taskReplyMessageId !== messageId) return current;
            const { taskReplyMessageId: _claim, replyBodyHash: _hash, ...metadata } = current.metadata;
            return { ...current, metadata };
          });
          throw error;
        }
        if (!input.progress) await this.deps.mutateDelivery(delivery.id, current => ({ ...current,
          status: input.failed ? "failed" : "completed", metadata: { ...current.metadata, phase: "replied", replyMessageId: messageId } }));
        return result;
      }
      const flight = this.deps.flight(invocation.id);
      if (!flight || flight.state === "cancelled" || flight.state === "failed") throw new Error("external_reply_flight_terminal");
      const messageId = `external-reply-${digest(delivery.id).slice(0, 24)}`;
      if (delivery.metadata?.replyBodyHash && delivery.metadata.replyBodyHash !== digest(input.body)) throw new Error("external_reply_conflict");
      if (delivery.status === "completed") return { messageId, flightId: flight.id, duplicate: true };
      // Pin the first body before posting so an interrupted retry cannot replace the reply.
      await this.deps.mutateDelivery(delivery.id, (current) => {
        if (current.metadata?.replyBodyHash && current.metadata.replyBodyHash !== digest(input.body)) throw new Error("external_reply_conflict");
        return { ...current, metadata: { ...current.metadata, replyBodyHash: digest(input.body) } };
      });
      input.authorize?.();
      await this.deps.postMessage({ id: messageId, actorId: endpoint.agentId, originNodeId: this.deps.nodeId,
        conversationId: invocation.conversationId, replyToMessageId: invocation.messageId, class: "agent", body: input.body,
        visibility: "private", policy: "durable", createdAt: this.now(),
        metadata: { clientMessageId: messageId, invocationId: invocation.id, externalDeliveryId: delivery.id, sessionId: input.sessionId } });
      const latest = this.deps.flight(invocation.id)!;
      if (latest.state === "failed" || latest.state === "cancelled") throw new Error("external_reply_flight_terminal");
      if (latest.state !== "completed") await this.deps.recordFlight({ ...latest, state: "completed", output: input.body, summary: "Attached session replied.", completedAt: this.now() });
      await this.deps.mutateDelivery(delivery.id, (current) => ({ ...current, status: "completed", metadata: { ...current.metadata, phase: "replied", replyMessageId: messageId } }));
      return { messageId, flightId: flight.id, duplicate: false };
    });
  }
}
