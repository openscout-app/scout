import type { RuntimeHttpRequestLike, RuntimeHttpResponseLike } from "./portable-types.js";

import type {
  ControlEvent,
  DeliveryIntent,
  DeliveryReason,
  DeliveryStatus,
  InboxItem,
  InvocationRequest,
  MessageRecord,
} from "@openscout/protocol";
import { isEphemeralControlEvent } from "@openscout/protocol";

export const DEFAULT_INBOX_STATUSES = new Set<DeliveryStatus>([
  "pending",
  "accepted",
  "deferred",
  "leased",
]);

export type BrokerControlStreamServiceDeps = {
  enqueueEvent: (event: ControlEvent) => void;
  findDeliveryById: (deliveryId: string) => DeliveryIntent | undefined;
  listDeliveries: (options: { limit: number; targetId?: string; statuses?: DeliveryStatus[]; reasons?: DeliveryReason[] }) => Promise<DeliveryIntent[]> | DeliveryIntent[];
  messageById: (messageId: string) => MessageRecord | undefined | Promise<MessageRecord | undefined>;
  invocationById: (invocationId: string) => InvocationRequest | undefined;
  /**
   * Current value of every ephemeral fact a fresh subscriber needs, replayed on
   * connect. Not a backlog: one entry per subject, overwritten in place.
   *
   * Presence publishes on transition only, so an agent that has been executing
   * for nine minutes puts nothing on the wire during those nine minutes. Without
   * this replay an SSE client that connects mid-window is blind until the next
   * transition — and a nine-minute-old state is exactly the one an operator
   * needs on connect. The tRPC subscribe path already does this; the SSE path
   * did not, which made the two transports disagree about what a new subscriber
   * knows.
   */
  presenceSnapshot?: () => ControlEvent[];
};

export function parseInboxStatuses(url: URL): Set<DeliveryStatus> | undefined {
  const values = url.searchParams.getAll("status")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? new Set(values as DeliveryStatus[]) : undefined;
}

export function parseInboxReasons(url: URL): Set<DeliveryReason> | undefined {
  const values = url.searchParams.getAll("reason")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? new Set(values as DeliveryReason[]) : undefined;
}

/** Legal journal records may be 16 MiB; snapshots can contain several of them. */
export const MAX_SSE_FRAME_BYTES = 64 * 1024 * 1024;
const closedStreamClients = new WeakSet<RuntimeHttpResponseLike>();
type SseWriteLimits = { maxFrameBytes?: number; drainTimeoutMs?: number };

function drainAcceptedFrame(response: RuntimeHttpResponseLike, timeoutMs: number): void {
  // write(false) accepted this frame into Node's bounded socket buffer. Stop
  // all later fan-out but let that one complete frame reach a healthy reader.
  closedStreamClients.add(response);
  const clear = () => {
    clearTimeout(timer);
    response.off?.("finish", clear);
    response.off?.("close", clear);
  };
  const timer = setTimeout(() => {
    clear();
    response.destroy?.();
  }, timeoutMs);
  timer.unref();
  response.on?.("finish", clear);
  response.on?.("close", clear);
  try { response.end(); } catch { clear(); response.destroy?.(); }
}

function writeSsePayload(response: RuntimeHttpResponseLike, payload: string, limits: SseWriteLimits = {}): boolean {
  if (closedStreamClients.has(response) || response.destroyed || response.writableEnded) return false;
  try {
    if (Buffer.byteLength(payload) <= Math.min(limits.maxFrameBytes ?? MAX_SSE_FRAME_BYTES, MAX_SSE_FRAME_BYTES)) {
      if (response.write(payload) !== false) return true;
      drainAcceptedFrame(response, Math.min(limits.drainTimeoutMs ?? 30_000, 30_000));
      return false;
    }
  } catch { /* Disconnect a failed consumer without interrupting canonical delivery. */ }
  // Invalid/oversized frames never enter the socket buffer. Canonical history
  // stays queryable, and no further events accumulate for this subscriber.
  closedStreamClients.add(response);
  if (response.destroy) response.destroy(); else response.end();
  return false;
}

export function writeSseFrame(response: RuntimeHttpResponseLike, eventName: string, payload: unknown, limits: SseWriteLimits = {}): boolean {
  return writeSsePayload(response, `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`, limits);
}

export function invocationIdsForEvent(
  event: ControlEvent,
  options: { findDeliveryById?: (deliveryId: string) => DeliveryIntent | undefined } = {},
): string[] {
  switch (event.kind) {
    case "invocation.requested":
      return [event.payload.invocation.id];
    case "flight.updated":
      return event.payload.flight.invocationId ? [event.payload.flight.invocationId] : [];
    case "delivery.planned":
      return event.payload.delivery.invocationId ? [event.payload.delivery.invocationId] : [];
    case "delivery.attempted": {
      const deliveryId = event.payload.attempt.deliveryId;
      const delivery = options.findDeliveryById?.(deliveryId);
      return delivery?.invocationId ? [delivery.invocationId] : [];
    }
    case "delivery.state.changed":
      return event.payload.delivery.invocationId ? [event.payload.delivery.invocationId] : [];
    case "scout.dispatched":
      return event.payload.dispatch.invocationId ? [event.payload.dispatch.invocationId] : [];
    case "message.posted": {
      const dispatch = (event.payload.message.metadata as { scoutDispatch?: { invocationId?: string } } | undefined)
        ?.scoutDispatch;
      return dispatch?.invocationId ? [dispatch.invocationId] : [];
    }
    default:
      return [];
  }
}

export function inboxTargetsForEvent(event: ControlEvent): string[] {
  switch (event.kind) {
    case "delivery.planned":
    case "delivery.state.changed":
      return [event.payload.delivery.targetId];
    default:
      return [];
  }
}

export class BrokerControlStreamService {
  private readonly eventClients = new Set<RuntimeHttpResponseLike>();
  private readonly invocationStreamClients = new Map<string, Set<RuntimeHttpResponseLike>>();
  private readonly inboxStreamClients = new Map<string, Set<RuntimeHttpResponseLike>>();

  private readonly inboxPublications = new Map<string, Promise<void>>();
  private readonly inboxPublicationBacklog = new Map<string, { count: number; bytes: number }>();

  constructor(private readonly deps: BrokerControlStreamServiceDeps) {}

  eventSubscriberCount(): number {
    return this.eventClients.size;
  }

  invocationSubscriberCount(invocationId: string): number {
    return this.invocationStreamClients.get(invocationId)?.size ?? 0;
  }

  inboxSubscriberCount(targetId: string): number {
    return this.inboxStreamClients.get(targetId)?.size ?? 0;
  }

  async inboxItemForDelivery(delivery: DeliveryIntent): Promise<InboxItem> {
    const message = delivery.messageId ? await this.deps.messageById(delivery.messageId) : undefined;
    const invocation = delivery.invocationId ? this.deps.invocationById(delivery.invocationId) : undefined;
    return {
      id: delivery.id,
      kind: delivery.invocationId ? "invocation" : "message",
      targetId: delivery.targetId,
      targetNodeId: delivery.targetNodeId,
      conversationId: message?.conversationId ?? invocation?.conversationId,
      messageId: delivery.messageId,
      invocationId: delivery.invocationId,
      reason: delivery.reason,
      status: delivery.status,
      leaseOwner: delivery.leaseOwner,
      leaseExpiresAt: delivery.leaseExpiresAt,
      leaseGeneration: delivery.metadata?.leaseGeneration,
      delivery,
      message,
      invocation,
      metadata: delivery.metadata,
    };
  }

  async listInboxItems(options: {
    targetId: string;
    statuses?: Set<DeliveryStatus>;
    reasons?: Set<DeliveryReason>;
    limit?: number;
  }): Promise<InboxItem[]> {
    const statuses = options.statuses ?? DEFAULT_INBOX_STATUSES;
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const deliveries = await this.deps.listDeliveries({
      limit, targetId: options.targetId, statuses: [...statuses],
      ...(options.reasons ? { reasons: [...options.reasons] } : {}),
    });
    const selected = deliveries
      .filter((delivery) => delivery.targetId === options.targetId)
      .filter((delivery) => statuses.has(delivery.status))
      .filter((delivery) => !options.reasons || options.reasons.has(delivery.reason))
      .slice(0, limit);
    const items: InboxItem[] = [];
    for (const delivery of selected) items.push(await this.inboxItemForDelivery(delivery));
    return items;
  }

  addInboxStream(options: {
    request: RuntimeHttpRequestLike;
    response: RuntimeHttpResponseLike;
    targetId: string;
    snapshot: unknown;
  }): void {
    options.response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    if (!writeSseFrame(options.response, "snapshot", options.snapshot)) return;

    const subscribers = this.inboxStreamClients.get(options.targetId) ?? new Set<RuntimeHttpResponseLike>();
    subscribers.add(options.response);
    this.inboxStreamClients.set(options.targetId, subscribers);
    options.request.on("close", () => {
      const set = this.inboxStreamClients.get(options.targetId);
      if (set) {
        set.delete(options.response);
        if (set.size === 0) this.inboxStreamClients.delete(options.targetId);
      }
      options.response.end();
    });
  }

  addInvocationStream(options: {
    request: RuntimeHttpRequestLike;
    response: RuntimeHttpResponseLike;
    invocationId: string;
    snapshot: unknown;
  }): void {
    options.response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    if (!writeSseFrame(options.response, "snapshot", options.snapshot)) return;

    let subscribers = this.invocationStreamClients.get(options.invocationId);
    if (!subscribers) {
      subscribers = new Set();
      this.invocationStreamClients.set(options.invocationId, subscribers);
    }
    subscribers.add(options.response);
    options.request.on("close", () => {
      const set = this.invocationStreamClients.get(options.invocationId);
      if (set) {
        set.delete(options.response);
        if (set.size === 0) this.invocationStreamClients.delete(options.invocationId);
      }
      options.response.end();
    });
  }

  addEventStream(options: {
    request: RuntimeHttpRequestLike;
    response: RuntimeHttpResponseLike;
    hello: unknown;
  }): void {
    options.response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    if (!writeSseFrame(options.response, "hello", options.hello)) return;
    // Current value before live fan-out, in the same frame shape a live event
    // uses, so a client has exactly one code path for both. Ephemeral by
    // construction — nothing here was read from disk, and a cold broker replays
    // nothing because it knows nothing.
    for (const event of this.deps.presenceSnapshot?.() ?? []) {
      if (!writeSseFrame(options.response, event.kind, event)) return;
    }
    this.eventClients.add(options.response);
    options.request.on("close", () => {
      this.eventClients.delete(options.response);
      options.response.end();
    });
  }

  streamEvent(event: ControlEvent): void {
    if (isEphemeralControlEvent(event)) {
      // `enqueueEvent` writes a durable row. Ephemeral kinds must never reach
      // it, and this is the guard rather than a convention every caller has to
      // remember — presence creating zero durable records is a hard constraint.
      this.streamEphemeralEvent(event);
      return;
    }

    this.deps.enqueueEvent(event);
    const payload = `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.eventClients) {
      this.writeClient(client, payload);
    }
    for (const invocationId of invocationIdsForEvent(event, {
      findDeliveryById: this.deps.findDeliveryById,
    })) {
      const subscribers = this.invocationStreamClients.get(invocationId);
      if (!subscribers) continue;
      for (const client of subscribers) {
        this.writeClient(client, payload);
      }
    }
    if (inboxTargetsForEvent(event).length > 0) {
      const delivery = (event as Extract<ControlEvent, { kind: "delivery.planned" | "delivery.state.changed" }>)
        .payload.delivery;
      this.publishInboxDeliveryEvent(delivery, event.kind === "delivery.planned" ? "inbox.item" : "inbox.item.updated");
    }
  }

  /**
   * Fan an event out to live SSE clients without persisting it.
   *
   * The invocation and inbox routers are deliberately skipped: those streams
   * are scoped to a durable object's lifecycle, and presence belongs to the
   * agent, not to any one invocation.
   */
  streamEphemeralEvent(event: ControlEvent): void {
    const payload = `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.eventClients) {
      this.writeClient(client, payload);
    }
  }

  streamKeepAlive(): void {
    for (const client of this.eventClients) {
      this.writeClient(client, ": keepalive\n\n");
    }
    for (const subscribers of this.invocationStreamClients.values()) {
      for (const client of subscribers) {
        this.writeClient(client, ": keepalive\n\n");
      }
    }
  }

  closeAll(): void {
    for (const client of this.eventClients) {
      client.end();
    }
    for (const subscribers of this.invocationStreamClients.values()) {
      for (const client of subscribers) {
        client.end();
      }
    }
    for (const subscribers of this.inboxStreamClients.values()) {
      for (const client of subscribers) {
        client.end();
      }
    }
    this.eventClients.clear();
    this.invocationStreamClients.clear();
    this.inboxStreamClients.clear();
  }

  private publishInboxDeliveryEvent(delivery: DeliveryIntent, eventName: string): void {
    const subscribers = this.inboxStreamClients.get(delivery.targetId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(delivery));
    const backlog = this.inboxPublicationBacklog.get(delivery.targetId) ?? { count: 0, bytes: 0 };
    if (backlog.count >= 64 || backlog.bytes + bytes > 256 * 1024) {
      for (const client of subscribers) this.closeClient(client);
      return;
    }
    backlog.count += 1;
    backlog.bytes += bytes;
    this.inboxPublicationBacklog.set(delivery.targetId, backlog);
    // Preserve accepted event order across asynchronous history reads. Queued
    // work retains the delivery reference, never a captured history generation.
    const previous = this.inboxPublications.get(delivery.targetId) ?? Promise.resolve();
    const pending = previous.then(async () => {
      if (subscribers.size === 0) return;
      const item = await this.inboxItemForDelivery(delivery);
      const payload = `event: ${eventName}\ndata: ${JSON.stringify(item)}\n\n`;
      for (const client of subscribers) this.writeClient(client, payload);
    }).catch((error) => {
      console.error("[broker] Inbox history read failed; reconnect required", error);
      for (const client of subscribers) this.closeClient(client);
    }).finally(() => {
      backlog.count -= 1;
      backlog.bytes -= bytes;
      if (backlog.count === 0) this.inboxPublicationBacklog.delete(delivery.targetId);
      if (this.inboxPublications.get(delivery.targetId) === pending) {
        this.inboxPublications.delete(delivery.targetId);
      }
    });
    this.inboxPublications.set(delivery.targetId, pending);
  }

  private writeClient(client: RuntimeHttpResponseLike, payload: string): void {
    if (!writeSsePayload(client, payload)) this.closeClient(client);
  }

  private closeClient(client: RuntimeHttpResponseLike): void {
    this.eventClients.delete(client);
    for (const groups of [this.invocationStreamClients, this.inboxStreamClients]) {
      for (const [key, subscribers] of groups) {
        subscribers.delete(client);
        if (subscribers.size === 0) groups.delete(key);
      }
    }
    if (!closedStreamClients.has(client)) {
      closedStreamClients.add(client);
      if (client.destroy) client.destroy(); else client.end();
    }
  }
}
