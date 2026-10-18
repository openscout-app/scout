/**
 * Originator outbox + retry worker (Issue 3 of broker-three-contracts).
 *
 * Decouples the caller-facing `POST /v1/invocations` path from the
 * peer-broker-to-peer-broker hop. The HTTP handler enqueues a delivery in
 * `accepted` state and returns 202; this worker drains the outbox in the
 * background, retries on transient peer failures, and surfaces durable
 * acceptance (`peer_acked`), explicit rejection, and unknown submission outcomes
 * via the deliveries projection.
 *
 * Peer reachability is treated as a *delivery* concern, not a caller concern:
 * a peer being down causes the delivery to cycle `accepted ↔ deferred` until
 * it succeeds, the retry budget expires, or the peer explicitly refuses.
 */

import type {
  AgentDefinition,
  ControlEvent,
  DeliveryAttempt,
  DeliveryFailureReason,
  DeliveryIntent,
  FlightRecord,
  InvocationRequest,
  NodeDefinition,
} from "@openscout/protocol";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MAX_SSE_FRAME_BYTES } from "./broker-control-stream-service.js";

import type { FileBackedBrokerJournal } from "./broker-journal.js";
import {
  buildMeshInvocationBundle,
  buildMeshInvocationBundleAsync,
  forwardMeshInvocation,
  type MeshForwardTarget,
  PeerRejectedError,
  PeerUnreachableError,
} from "./mesh-forwarding.js";
import { meshPeerFetch, type MeshPeerFetch } from "./mesh-peer-client.js";
import type { RuntimeRegistrySnapshot } from "./registry.js";

/* ── Configuration ── */

export interface PeerDeliveryConfig {
  /** First retry delay after the first failure. Default 2_000 ms. */
  initialBackoffMs: number;
  /** Cap on retry delay. Default 60_000 ms. */
  maxBackoffMs: number;
  /** Total retry window before retaining an unknown submission outcome. Default 30 minutes. */
  retryWindowMs: number;
  /** How often the worker scans the outbox. Default 1_000 ms. */
  tickIntervalMs: number;
  /** How long a worker holds an exclusive lease on a delivery while forwarding. Default 30_000 ms. */
  leaseMs: number;
  /** Bounded concurrent authority observation subscriptions. */
  maxStatusMirrors: number;
  /** Rotate observation slots without interrupting remote execution. */
  statusMirrorLeaseMs: number;
}

export const DEFAULT_PEER_DELIVERY_CONFIG: PeerDeliveryConfig = {
  initialBackoffMs: 2_000,
  maxBackoffMs: 60_000,
  retryWindowMs: 30 * 60_000,
  tickIntervalMs: 1_000,
  leaseMs: 30_000,
  maxStatusMirrors: 64,
  statusMirrorLeaseMs: 30_000,
};

/* ── Dependencies (injected so the worker is testable) ── */

export interface PeerDeliveryDeps {
  journal: Pick<FileBackedBrokerJournal, "getDelivery" | "findDelivery" | "listDeliveryAttempts" | "listPendingPeerMirrorDeliveries" | "listPendingPeerForwardDeliveries">;
  /** Returns the current registry snapshot (for bundle building). */
  snapshot: () => Readonly<RuntimeRegistrySnapshot>;
  /** Returns the local node definition (origin of the envelope). */
  localNode: () => NodeDefinition;
  /** Local node id — used to skip non-peer deliveries quickly. */
  localNodeId: string;
  /** Looks up a node definition by id (target peer). */
  nodeFor: (nodeId: string) => NodeDefinition | undefined;
  /** Looks up an agent definition by id (used to fail when target vanished). */
  agentFor: (agentId: string) => AgentDefinition | undefined;
  /** Looks up the in-flight invocation by id (used by enqueue + dispatcher). */
  invocationFor: (invocationId: string) => InvocationRequest | undefined;
  flightForInvocation?: (invocationId: string) => FlightRecord | undefined;

  /** Persist a `deliveries.record` journal entry. */
  recordDelivery: (delivery: DeliveryIntent) => Promise<void>;
  /** Persist a `delivery.status.update` journal entry. */
  updateDeliveryStatus: (input: {
    deliveryId: string;
    status: DeliveryIntent["status"];
    metadata?: Record<string, unknown>;
    leaseOwner?: string | null;
    leaseExpiresAt?: number | null;
  }) => Promise<void>;
  /** Persist a `delivery.attempt.record` journal entry. */
  recordDeliveryAttempt: (attempt: {
    id: string;
    deliveryId: string;
    attempt: number;
    status: "sent" | "acknowledged" | "failed";
    error?: string;
    externalRef?: string;
    createdAt: number;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  /** Persist the receiver-returned flight; evaluate eligibility inside the durable writer. */
  recordFlight: (flight: FlightRecord, eligible?: () => boolean) => Promise<void>;
  /** Mark the originator-side flight as failed (terminal). */
  failInvocation: (invocation: InvocationRequest, detail: string) => Promise<void>;
  /**
   * Emit a control event so per-invocation stream subscribers can mirror
   * delivery state transitions in real time. Optional — when absent, state
   * is still durable via the journal but only observable by polling.
   */
  emit?: (event: ControlEvent) => void;

  /**
   * Forward the bundle to the receiver. Default is `forwardMeshInvocation`;
   * tests inject a stub. Throws `PeerUnreachableError` for network failures
   * and `PeerRejectedError` for HTTP error responses.
   */
  forward?: (target: MeshForwardTarget, bundle: ReturnType<typeof buildMeshInvocationBundle>) =>
    Promise<{ ok: true; flight?: FlightRecord; duplicate?: boolean }>;

  /**
   * Signed peer client for the authority status-mirror stream (mesh trust
   * cone §5). Defaults to the shared meshPeerFetch singleton; tests inject
   * a stub to stay hermetic.
   */
  peerFetch?: MeshPeerFetch;

  /** Inject a clock for tests. */
  now?: () => number;
}

/* ── Helpers ── */

function pickFailureReason(error: unknown): DeliveryFailureReason {
  if (error instanceof PeerUnreachableError) return "peer_unreachable";
  if (error instanceof PeerRejectedError) {
    return error.retryable ? "peer_unreachable" : "peer_rejected";
  }
  return "peer_unreachable";
}

function nextBackoffMs(attempt: number, config: PeerDeliveryConfig): number {
  // attempt is 1-based: first retry uses initialBackoffMs.
  const exp = config.initialBackoffMs * 2 ** Math.max(0, attempt - 1);
  // Decorrelated jitter: ±25% so a fleet of brokers doesn't sync up.
  const base = Math.min(exp, config.maxBackoffMs);
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(config.initialBackoffMs, Math.round(base + jitter));
}

function readNumber(metadata: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hasMeshEntrypoint(node: NodeDefinition | undefined): node is NodeDefinition {
  return Boolean(node?.meshEntrypoints?.length);
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Saved with peer_acked before attempt logging, flight persistence or observation. */
type PeerAcknowledgement = {
  version: 1;
  attempt: DeliveryAttempt;
  flight?: FlightRecord;
  /** Exact origin observation before submission; compare again inside the writer. */
  previousFlight?: FlightRecord | null;
};

function flightMatchesInvocation(value: unknown, invocation: InvocationRequest): value is FlightRecord {
  if (!value || typeof value !== "object") return false;
  const flight = value as FlightRecord;
  return typeof flight.id === "string" && flight.id.length > 0
    && flight.invocationId === invocation.id && flight.targetAgentId === invocation.targetAgentId
    && flight.requesterId === invocation.requesterId
    && ["queued", "waking", "running", "waiting", "completed", "failed", "cancelled"].includes(flight.state)
    && (flight.startedAt === undefined || (typeof flight.startedAt === "number" && Number.isFinite(flight.startedAt)));
}

function pendingAcknowledgement(delivery: DeliveryIntent): PeerAcknowledgement | undefined {
  const value = delivery.metadata?.peerAcknowledgement as PeerAcknowledgement | undefined;
  return value?.version === 1 && value.attempt?.deliveryId === delivery.id
    && value.attempt.status === "acknowledged" ? value : undefined;
}

function emitDeliveryStateChanged(
  emit: PeerDeliveryDeps["emit"],
  delivery: DeliveryIntent,
  previousStatus: DeliveryIntent["status"] | undefined,
  ts: number,
): void {
  if (!emit) return;
  emit({
    id: createId("evt"),
    kind: "delivery.state.changed",
    ts,
    actorId: "system",
    payload: { delivery, previousStatus },
  });
}

/* ── Authority status mirror ──
 *
 * After a delivery reaches `peer_acked`, we subscribe to the authority
 * broker's per-invocation stream and rebroadcast `flight.updated` and
 * `delivery.state.changed` events into our own local stream so callers
 * observing the originator see the full lifecycle.
 */

const MIRRORED_EVENT_KINDS = new Set(["flight.updated", "delivery.state.changed"]);
const TERMINAL_FLIGHT_STATES = new Set(["completed", "failed", "cancelled"]);

interface StatusMirrorHandle {
  stop: () => void;
}

function parseSseFrame(frame: string): { event: string; data: string } | undefined {
  let event = "message";
  const dataLines: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).replace(/^\s/, ""));
  }
  if (dataLines.length === 0) return undefined;
  return { event, data: dataLines.join("\n") };
}

function startStatusMirror(args: {
  peerUrl: string;
  invocation: InvocationRequest;
  expectedFlightId?: string;
  originFlightId?: string;
  emit?: (event: ControlEvent) => void;
  recordFlight: (flight: FlightRecord, eligible?: () => boolean) => Promise<void>;
  currentFlight?: () => FlightRecord | undefined;
  peerFetch: MeshPeerFetch;
  durationMs: number;
  onClose?: () => void;
}): StatusMirrorHandle {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const onAbort = () => { void reader?.cancel().catch(() => undefined); };
  controller.signal.addEventListener("abort", onAbort, { once: true });
  // Observation leases rotate fairly. This never cancels the authority's work.
  const timer = setTimeout(() => controller.abort(), args.durationMs);
  timer.unref?.();
  const baseUrl = args.peerUrl.replace(/\/$/, "");
  const streamPath = (prefix: string) =>
    `${prefix}/invocations/${encodeURIComponent(args.invocation.id)}/stream`;

  const matchingFlight = (value: unknown): value is FlightRecord => {
    return flightMatchesInvocation(value, args.invocation)
      && (!args.expectedFlightId || value.id === args.expectedFlightId);
  };
  const mirrorFlight = async (flight: FlightRecord, event?: Extract<ControlEvent, { kind: "flight.updated" }>) => {
    const before = args.currentFlight?.();
    if (flightMatchesInvocation(before, args.invocation)
      && (TERMINAL_FLIGHT_STATES.has(before.state)
        || (before.id !== flight.id && before.id !== args.originFlightId))) return true;
    await args.recordFlight(flight, () => isDeepStrictEqual(args.currentFlight?.(), before));
    const current = args.currentFlight?.();
    if (current && !matchingFlight(current)) return true;
    const recorded = matchingFlight(current) ? current : flight;
    args.emit?.(event ? { ...event, payload: { ...event.payload, flight: recorded } } : {
      id: createId("evt"), kind: "flight.updated", ts: Date.now(), actorId: "system", payload: { flight: recorded },
    });
    return TERMINAL_FLIGHT_STATES.has(recorded.state);
  };

  void (async () => {
    try {
      let response = await args.peerFetch(baseUrl, streamPath("/v1/mesh"), {
        headers: { accept: "text/event-stream" }, signal: controller.signal,
      });
      if (response.status === 404) {
        await response.body?.cancel();
        response = await args.peerFetch(baseUrl, streamPath("/v1"), {
          headers: { accept: "text/event-stream" }, signal: controller.signal,
        });
      }
      if (!response.ok || !response.body || controller.signal.aborted) {
        await response.body?.cancel();
        return;
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let bufferedBytes = 0;
      while (!controller.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        const decoded = decoder.decode(value, { stream: true });
        buffer += decoded;
        bufferedBytes += Buffer.byteLength(decoded);
        let idx = buffer.indexOf("\n\n");
        while (idx !== -1 && !controller.signal.aborted) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const frameBytes = Buffer.byteLength(frame) + 2;
          bufferedBytes -= frameBytes;
          if (frameBytes > MAX_SSE_FRAME_BYTES) throw new Error("Peer status frame exceeds the observation buffer");
          const parsed = parseSseFrame(frame);
          let data: unknown;
          try { data = parsed ? JSON.parse(parsed.data) : undefined; } catch { data = undefined; }
          if (parsed?.event === "snapshot") {
            const snapshot = data as { invocationId?: string; flight?: unknown } | undefined;
            if (snapshot?.invocationId === args.invocation.id && matchingFlight(snapshot.flight)) {
              if (await mirrorFlight(snapshot.flight)) return;
            }
          } else if (parsed && MIRRORED_EVENT_KINDS.has(parsed.event) && data && typeof data === "object") {
            const event = data as ControlEvent;
            if (event.kind === "flight.updated" && parsed.event === event.kind) {
              const flight = (event.payload as { flight?: unknown } | undefined)?.flight;
              if (matchingFlight(flight) && await mirrorFlight(flight, event)) return;
            } else if (event.kind === "delivery.state.changed" && parsed.event === event.kind) {
              const delivery = (event.payload as { delivery?: DeliveryIntent } | undefined)?.delivery;
              if (delivery?.invocationId === args.invocation.id && delivery.targetId === args.invocation.targetAgentId) args.emit?.(event);
            }
          }
          idx = buffer.indexOf("\n\n");
        }
        // Match the sender's legal singleton budget, including UTF-8 bytes.
        // Several complete frames in one network chunk are checked separately.
        if (bufferedBytes > MAX_SSE_FRAME_BYTES) throw new Error("Peer status frame exceeds the observation buffer");
      }
    } catch {
      // Network/storage failures leave the durable acknowledgement pending for
      // observation recovery. Never resubmit an acknowledged invocation.
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      controller.abort();
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
      args.onClose?.();
    }
  })();
  return { stop: () => controller.abort() };
}

/* ── Public API ── */

export interface PeerDeliveryWorker {
  /**
   * Record a `peer_broker` delivery for an invocation that needs to cross
   * a node boundary, then trigger an immediate forward attempt. Returns the
   * persisted delivery so the caller can correlate it with the invocation.
   */
  enqueue: (invocation: InvocationRequest, peer: NodeDefinition) => Promise<DeliveryIntent>;
  /** Drain the outbox once. Safe to call concurrently — leasing prevents dupes. */
  tick: () => Promise<void>;
  /**
   * Hint that a previously-unreachable peer has come back online (e.g. from
   * the discovery loop). Forces an immediate flush so deferred deliveries
   * to that peer don't wait for their next backoff window.
   */
  notifyPeerOnline: (nodeId: string) => void;
  /** Start the periodic tick loop. */
  start: () => void;
  /** Stop the periodic tick loop. */
  stop: () => void;
}

export function createPeerDeliveryWorker(
  deps: PeerDeliveryDeps,
  config: Partial<PeerDeliveryConfig> = {},
): PeerDeliveryWorker {
  const cfg: PeerDeliveryConfig = { ...DEFAULT_PEER_DELIVERY_CONFIG, ...config };
  const forward = deps.forward ?? forwardMeshInvocation;
  const peerFetch = deps.peerFetch ?? meshPeerFetch;
  const now = deps.now ?? (() => Date.now());
  const leaseOwner = `peer-delivery-${createId("worker")}`;

  // In-process re-entrancy guard: the journal lease is the source of truth
  // across processes, but we also want to skip work we're actively doing in
  // this same process so a fast tick doesn't pile up.
  const inFlight = new Set<string>();
  const statusMirrors = new Map<string, StatusMirrorHandle>();
  const acknowledgementRecoveries = new Map<string, Promise<void>>();
  const mirrorRetries = new Map<string, { attempts: number; nextAt: number }>();
  const pendingEnqueues = new Map<string, Promise<DeliveryIntent>>();
  const onlinePeerHints = new Set<string>();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking: Promise<void> | undefined;

  function ensureStatusMirror(delivery: DeliveryIntent, peerUrl: string, invocation: InvocationRequest): void {
    const deliveryId = delivery.id;
    if (stopped || statusMirrors.size >= cfg.maxStatusMirrors) return;
    if (statusMirrors.has(deliveryId)) return;
    if ((mirrorRetries.get(deliveryId)?.nextAt ?? 0) > now()) return;
    const expectedFlightId = readString(delivery.metadata, "peerFlightId");
    const originFlightId = readString(delivery.metadata, "peerOriginFlightId");
    const flight = deps.flightForInvocation?.(invocation.id);
    if (flightMatchesInvocation(flight, invocation)
      && (TERMINAL_FLIGHT_STATES.has(flight.state)
        || (expectedFlightId && flight.id !== expectedFlightId && flight.id !== originFlightId))) return;
    const handle = startStatusMirror({
      peerUrl,
      invocation,
      expectedFlightId,
      originFlightId,
      emit: deps.emit,
      recordFlight: async (flight, eligible) => {
        if (eligible && !eligible()) return;
        const previousFlight = deps.flightForInvocation?.(invocation.id) ?? null;
        const current = deps.journal.getDelivery(deliveryId);
        // A correlated authority snapshot resolves an interrupted/lost ACK;
        // observation is never a second invocation submission.
        if (current?.status === "sent") {
          await transition(current, { status: "peer_acked", metadata: {
            peerAckedAt: now(), peerFlightId: flight.id, peerSubmission: null,
            peerAcknowledgement: { version: 1, flight, previousFlight, attempt: {
              id: `peer-observed-${deliveryId}`, deliveryId, attempt: deps.journal.listDeliveryAttempts(deliveryId).length + 1,
              status: "acknowledged", createdAt: now(), metadata: { source: "authority_observation" },
            } } satisfies PeerAcknowledgement,
          }, leaseOwner: null, leaseExpiresAt: null });
          await recoverAcknowledgement(deps.journal.getDelivery(deliveryId)!);
        } else {
          await deps.recordFlight(flight, eligible);
        }
      },
      currentFlight: () => deps.flightForInvocation?.(invocation.id),
      peerFetch,
      durationMs: cfg.statusMirrorLeaseMs,
      onClose: () => {
        if (statusMirrors.get(deliveryId) !== handle) return;
        statusMirrors.delete(deliveryId);
        const attempts = (mirrorRetries.get(deliveryId)?.attempts ?? 0) + 1;
        mirrorRetries.delete(deliveryId);
        mirrorRetries.set(deliveryId, { attempts, nextAt: now() + nextBackoffMs(attempts, cfg) });
        // This is a scheduling cache only; acknowledged work stays durable.
        if (mirrorRetries.size > 1024) mirrorRetries.delete(mirrorRetries.keys().next().value!);
      },
    });
    statusMirrors.set(deliveryId, handle);
  }

  async function recoverAcknowledgement(delivery: DeliveryIntent): Promise<void> {
    const existing = acknowledgementRecoveries.get(delivery.id);
    if (existing) return existing;
    const recovery = recoverAcknowledgementOnce(delivery.id);
    acknowledgementRecoveries.set(delivery.id, recovery);
    try { await recovery; } finally { acknowledgementRecoveries.delete(delivery.id); }
  }

  async function recoverAcknowledgementOnce(deliveryId: string): Promise<void> {
    const delivery = deps.journal.getDelivery(deliveryId);
    if (!delivery || delivery.status !== "peer_acked") return;
    const pending = pendingAcknowledgement(delivery);
    if (!pending) return;
    if (!deps.journal.listDeliveryAttempts(delivery.id).some(attempt => attempt.id === pending.attempt.id)) {
      await deps.recordDeliveryAttempt(pending.attempt);
    }
    const invocation = delivery.invocationId ? deps.invocationFor(delivery.invocationId) : undefined;
    const validFlight = invocation && flightMatchesInvocation(pending.flight, invocation) ? pending.flight : undefined;
    if (pending.flight && !validFlight) {
      console.warn(`[openscout-runtime] peer-delivery: ignored uncorrelated ACK flight for ${delivery.id}`);
    }
    if (validFlight) {
      // The returned ACK is an earlier observation, not a later authority
      // snapshot. Never replace an observation made since submission, even
      // for the same flight ID. The writer repeats this comparison atomically.
      await deps.recordFlight(validFlight, () => {
        const current = deps.flightForInvocation?.(invocation!.id);
        return isDeepStrictEqual(current ?? null, pending.previousFlight ?? null)
          && !(current && TERMINAL_FLIGHT_STATES.has(current.state));
      });
    }
    await deps.updateDeliveryStatus({ deliveryId: delivery.id, status: "peer_acked",
      metadata: { peerAcknowledgement: null, ...(pending.flight && !validFlight ? { peerFlightId: null } : {}) }, leaseOwner: null, leaseExpiresAt: null });
  }

  async function enqueue(invocation: InvocationRequest, peer: NodeDefinition): Promise<DeliveryIntent> {
    const id = `dlv-peer-${createHash("sha256").update(JSON.stringify([invocation.id, peer.id])).digest("hex")}`;
    const pending = pendingEnqueues.get(id);
    if (pending) return pending;
    const work = enqueueOnce(id, invocation, peer);
    pendingEnqueues.set(id, work);
    try { return await work; } finally { if (pendingEnqueues.get(id) === work) pendingEnqueues.delete(id); }
  }

  function existingPeerDelivery(invocationId: string, peerId: string): DeliveryIntent | undefined {
    const id = `dlv-peer-${createHash("sha256").update(JSON.stringify([invocationId, peerId])).digest("hex")}`;
    return deps.journal.getDelivery(id) ?? deps.journal.findDelivery(delivery => delivery.transport === "peer_broker"
      && delivery.invocationId === invocationId && delivery.targetNodeId === peerId);
  }

  async function enqueueOnce(id: string, invocation: InvocationRequest, peer: NodeDefinition): Promise<DeliveryIntent> {
    const existing = existingPeerDelivery(invocation.id, peer.id);
    if (existing) { void tick(); return existing; }
    const delivery: DeliveryIntent = {
      id,
      invocationId: invocation.id,
      targetId: invocation.targetAgentId,
      targetNodeId: peer.id,
      targetKind: "agent",
      transport: "peer_broker",
      reason: "invocation",
      policy: "must_ack",
      status: "accepted",
      metadata: {
        peerBrokerUrl: peer.brokerUrl,
        firstAttemptQueuedAt: now(),
      },
    };
    await deps.recordDelivery(delivery);
    emitDeliveryStateChanged(deps.emit, delivery, undefined, now());
    // Fire-and-forget tick so the caller's 202 path is not blocked by the
    // forward attempt. Errors here are already journalled by the worker.
    void tick();
    return delivery;
  }

  /** Update a delivery's status and emit a state-change event when the status differs. */
  async function transition(
    delivery: DeliveryIntent,
    next: {
      status: DeliveryIntent["status"];
      metadata?: Record<string, unknown>;
      leaseOwner?: string | null;
      leaseExpiresAt?: number | null;
    },
  ): Promise<void> {
    const previousStatus = delivery.status;
    await deps.updateDeliveryStatus({ deliveryId: delivery.id, ...next });
    if (next.status !== previousStatus) {
      const merged: DeliveryIntent = {
        ...delivery,
        status: next.status,
        metadata: { ...(delivery.metadata ?? {}), ...(next.metadata ?? {}) },
        leaseOwner: next.leaseOwner ?? undefined,
        leaseExpiresAt: next.leaseExpiresAt ?? undefined,
      };
      emitDeliveryStateChanged(deps.emit, merged, previousStatus, now());
    }
  }

  function shouldAttempt(delivery: DeliveryIntent, currentTime: number): boolean {
    if (delivery.status === "accepted") return true;
    if (delivery.status !== "deferred") return false;
    const nextAt = readNumber(delivery.metadata, "nextAttemptAt");
    return typeof nextAt === "number" ? nextAt <= currentTime : true;
  }

  function isLeaseHeldByOther(delivery: DeliveryIntent, currentTime: number): boolean {
    if (!delivery.leaseOwner || delivery.leaseOwner === leaseOwner) return false;
    const expires = delivery.leaseExpiresAt;
    return typeof expires === "number" && expires > currentTime;
  }

  async function attemptDelivery(delivery: DeliveryIntent): Promise<void> {
    if (inFlight.has(delivery.id)) return;
    inFlight.add(delivery.id);

    try {
      const invocation = delivery.invocationId
        ? deps.invocationFor(delivery.invocationId)
        : undefined;
      if (!invocation) {
        await transition(delivery, {
          status: "failed",
          metadata: {
            failureReason: "peer_rejected",
            failureDetail: "originator dropped the invocation before it could be forwarded",
          },
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        return;
      }

      const closeIfTerminal = async (): Promise<boolean> => {
        const flight = deps.flightForInvocation?.(invocation.id);
        if (!flight || flight.invocationId !== invocation.id || flight.targetAgentId !== invocation.targetAgentId
          || flight.requesterId !== invocation.requesterId || !TERMINAL_FLIGHT_STATES.has(flight.state)) return false;
        await transition(delivery, {
          status: flight.state === "cancelled" ? "cancelled" : flight.state === "failed" ? "failed" : "completed",
          metadata: { phase: "flight_closed", closedAt: now() }, leaseOwner: null, leaseExpiresAt: null,
        });
        return true;
      };
      if (await closeIfTerminal()) return;
      if (delivery.targetNodeId) {
        const canonical = existingPeerDelivery(invocation.id, delivery.targetNodeId);
        if (canonical && canonical.id !== delivery.id) {
          await transition(delivery, { status: "cancelled", metadata: { supersededPeerDeliveryId: canonical.id }, leaseOwner: null, leaseExpiresAt: null });
          return;
        }
      }

      if (!delivery.targetNodeId) {
        await transition(delivery, {
          status: "failed",
          metadata: { failureReason: "peer_rejected", failureDetail: "delivery missing targetNodeId" },
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        await deps.failInvocation(invocation, "peer delivery is missing targetNodeId");
        return;
      }

      const peer = deps.nodeFor(delivery.targetNodeId);
      const peerUrl = peer?.brokerUrl ?? readString(delivery.metadata, "peerBrokerUrl");
      const peerTarget: MeshForwardTarget | undefined = peerUrl || hasMeshEntrypoint(peer)
        ? (peer ?? peerUrl)
        : undefined;
      if (!peerTarget) {
        // No URL on record — peer hasn't been discovered yet. Defer until
        // a discovery cycle populates an HTTP URL or mesh entrypoint; don't
        // burn through the retry budget.
        const waitMs = Math.min(cfg.maxBackoffMs, 5_000);
        await transition(delivery, {
          status: "deferred",
          metadata: {
            failureReason: "peer_unreachable",
            failureDetail: `no broker URL or mesh entrypoint known for node ${delivery.targetNodeId}`,
            nextAttemptAt: now() + waitMs,
          },
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        return;
      }

      const attempts = deps.journal.listDeliveryAttempts(delivery.id);
      const attemptNumber = attempts.length + 1;
      const startedAt = now();

      // Take a lease so concurrent ticks (or peer brokers in HA) don't
      // double-forward. This does not change status, so no event fires.
      await deps.updateDeliveryStatus({
        deliveryId: delivery.id,
        status: delivery.status === "deferred" ? "deferred" : "accepted",
        leaseOwner,
        leaseExpiresAt: startedAt + cfg.leaseMs,
      });

      let result: Awaited<ReturnType<typeof forward>>;
      let previousFlight: FlightRecord | null = null;
      try {
        // async: carries the request message so the executor can resolve `--ref msg-…` replies
        const bundle = await buildMeshInvocationBundleAsync(deps.snapshot(), deps.localNode(), invocation);
        if (stopped) return;
        // If the process exits after sending, or cannot persist the ACK, replay
        // observes this receipt rather than forwarding an uncertain submission.
        await deps.updateDeliveryStatus({ deliveryId: delivery.id, status: "sent", metadata: {
          peerSubmission: { version: 1, status: "unknown", startedAt, attempt: attemptNumber },
        }, leaseOwner, leaseExpiresAt: startedAt + cfg.leaseMs });
        // Cold request history can yield after lease acquisition. No await may
        // sit between this final check and the external submission.
        if (stopped) return;
        const beforeForward = deps.flightForInvocation?.(invocation.id);
        if (beforeForward?.invocationId === invocation.id && beforeForward.targetAgentId === invocation.targetAgentId
          && beforeForward.requesterId === invocation.requesterId && TERMINAL_FLIGHT_STATES.has(beforeForward.state)) {
          await closeIfTerminal();
          return;
        }
        previousFlight = beforeForward ?? null;
        result = await forward(peerTarget, bundle);
      } catch (error) {
        const reason = pickFailureReason(error);
        const detail = error instanceof Error ? error.message : String(error);

        await deps.recordDeliveryAttempt({
          id: createId("dlv-att"),
          deliveryId: delivery.id,
          attempt: attemptNumber,
          status: "failed",
          error: detail,
          createdAt: now(),
          metadata: {
            peerBrokerUrl: peerUrl,
            durationMs: now() - startedAt,
            failureReason: reason,
            httpStatus: error instanceof PeerRejectedError ? error.status : undefined,
          },
        });

        if (reason === "peer_rejected") {
          // Terminal — config/trust problem, never auto-retry.
          await transition(delivery, {
            status: "failed",
            metadata: { failureReason: reason, failureDetail: detail },
            leaseOwner: null,
            leaseExpiresAt: null,
          });
          await deps.failInvocation(
            invocation,
            `peer broker rejected invocation: ${detail}`,
          );
          return;
        }

        const firstQueuedAt = readNumber(delivery.metadata, "firstAttemptQueuedAt") ?? startedAt;
        const elapsed = now() - firstQueuedAt;
        if (elapsed >= cfg.retryWindowMs) {
          // A lost response does not prove the peer rejected or stopped work.
          // Stop resubmitting, retain uncertainty and recover via observation.
          await transition(delivery, {
            status: "sent",
            metadata: {
              failureReason: null,
              failureDetail: null,
              peerSubmission: { version: 1, status: "unknown", startedAt, attempt: attemptNumber, reason: "retry_window_expired", detail },
              attempts: attemptNumber,
              elapsedMs: elapsed,
            },
            leaseOwner: null,
            leaseExpiresAt: null,
          });
          return;
        }

        const backoff = nextBackoffMs(attemptNumber, cfg);
        await transition(delivery, {
          status: "deferred",
          metadata: {
            failureReason: reason,
            failureDetail: detail,
            nextAttemptAt: now() + backoff,
            attempts: attemptNumber,
            backoffMs: backoff,
            peerSubmission: null,
          },
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        return;
      }

      // This is deliberately outside the transport catch. Nothing after the
      // peer's ACK may become a transport failure or another executor attempt.
      try {
        const acknowledgedFlight = flightMatchesInvocation(result.flight, invocation) ? result.flight : undefined;
        if (result.flight && !acknowledgedFlight) {
          console.warn(`[openscout-runtime] peer-delivery: ignored uncorrelated ACK flight for ${delivery.id}`);
        }
        await transition(deps.journal.getDelivery(delivery.id) ?? delivery, {
          status: "peer_acked",
          metadata: {
            peerAckedAt: now(), peerFlightId: acknowledgedFlight?.id ?? null, peerOriginFlightId: previousFlight?.id ?? null, peerSubmission: null,
            peerAcknowledgement: { version: 1, flight: acknowledgedFlight, previousFlight, attempt: {
              id: `peer-ack-${delivery.id}-${attemptNumber}`, deliveryId: delivery.id, attempt: attemptNumber,
              status: "acknowledged", createdAt: now(), metadata: {
                peerBrokerUrl: peerUrl, peerTransport: typeof peerTarget === "string" ? "http" : "node_entrypoint",
                durationMs: now() - startedAt, duplicate: result.duplicate ?? false,
              },
            } } satisfies PeerAcknowledgement,
            authorityStreamUrl: peerUrl
              ? `${peerUrl.replace(/\/$/, "")}/v1/mesh/invocations/${encodeURIComponent(invocation.id)}/stream`
              : undefined,
          }, leaseOwner: null, leaseExpiresAt: null,
        });
        const acknowledged = deps.journal.getDelivery(delivery.id)!;
        await recoverAcknowledgement(acknowledged);
        if (peerUrl) ensureStatusMirror(acknowledged, peerUrl, invocation);
      } catch (error) {
        // peer_acked carries the exact pending local effects; if that first
        // write failed, the pre-send receipt still retains submission_unknown.
        console.error(`[openscout-runtime] peer-delivery: acknowledgement recovery pending for ${delivery.id}:`, error);
      }
    } finally {
      inFlight.delete(delivery.id);
    }
  }

  async function tickInternal(): Promise<void> {
    if (stopped) return;
    const currentTime = now();
    const forcePeers = new Set(onlinePeerHints);
    onlinePeerHints.clear();
    for (const delivery of deps.journal.listPendingPeerMirrorDeliveries({ limit: 500 })) {
      if (inFlight.has(delivery.id) || isLeaseHeldByOther(delivery, currentTime)) continue;
      const invocation = delivery.invocationId ? deps.invocationFor(delivery.invocationId) : undefined;
      if (!invocation || invocation.targetAgentId !== delivery.targetId) continue;
      try {
        await recoverAcknowledgement(delivery);
      } catch (error) {
        console.error(`[openscout-runtime] peer-delivery: local observation pending for ${delivery.id}:`, error);
        continue;
      }
      const peer = delivery.targetNodeId ? deps.nodeFor(delivery.targetNodeId) : undefined;
      const peerUrl = peer?.brokerUrl ?? readString(delivery.metadata, "peerBrokerUrl");
      if (peerUrl) ensureStatusMirror(deps.journal.getDelivery(delivery.id) ?? delivery, peerUrl, invocation);
    }
    const candidates = deps.journal
      .listPendingPeerForwardDeliveries({ limit: 500 })
      .filter((delivery) => delivery.status === "accepted" || delivery.status === "deferred")
      .filter((delivery) => (delivery.targetNodeId && forcePeers.has(delivery.targetNodeId)) || shouldAttempt(delivery, currentTime))
      .filter((delivery) => !isLeaseHeldByOther(delivery, currentTime));

    // Keep network fanout bounded. A pool allows a fast peer to proceed while
    // another worker waits for a slow peer; the candidate index rotates fairly.
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(16, candidates.length) }, async () => {
      while (!stopped && cursor < candidates.length) {
        const delivery = candidates[cursor++]!;
        await attemptDelivery(delivery).catch((error) => {
          console.error(`[openscout-runtime] peer-delivery: unhandled error on delivery ${delivery.id}:`, error);
        });
      }
    }));
  }

  async function tick(): Promise<void> {
    if (ticking) return ticking;
    ticking = tickInternal().finally(() => {
      ticking = undefined;
      if (!stopped && onlinePeerHints.size) void tick();
    });
    return ticking;
  }

  function notifyPeerOnline(nodeId: string): void {
    // Bypass nextAttemptAt — heartbeat says the peer is back, no point waiting.
    if (stopped) return;
    onlinePeerHints.add(nodeId);
    void tick().catch((error) => {
      console.error(`[openscout-runtime] peer-delivery: flush for ${nodeId} failed:`, error);
    });
  }

  function start(): void {
    if (timer) return;
    stopped = false;
    void tick();
    timer = setInterval(() => {
      void tick();
    }, cfg.tickIntervalMs);
    timer.unref?.();
  }

  function stop(): void {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    for (const mirror of statusMirrors.values()) {
      try {
        mirror.stop();
      } catch {
        // best-effort cleanup
      }
    }
    statusMirrors.clear();
    mirrorRetries.clear();
    onlinePeerHints.clear();
  }

  return { enqueue, tick, notifyPeerOnline, start, stop };
}
