import type { ActorIdentity, ConversationDefinition, FlightRecord, InvocationRequest, MessageRecord } from "@openscout/protocol";

import { messageVisibilityForConversation } from "./broker-conversation-helpers.js";
import { json, readRequestBody } from "./broker-http-helpers.js";
import {
  GUEST_ASK_MAX_TASK_BYTES,
  GUEST_ASK_MAX_WAIT_MS,
  GUEST_ASK_REQUEST_ID_PATTERN,
  GUEST_PROTOCOL_VERSION,
  GuestAccessError,
  guestGrantStatus,
  guestInvocationId,
  type GuestGrantRecord,
  type GuestGrantStore,
} from "./guest-access.js";
import type { BrokerExternalSessionService } from "./broker-external-session-service.js";
import type { SignedNodeCard } from "./node-identity.js";
import type { RuntimeHttpRequestLike, RuntimeHttpResponseLike } from "./portable-types.js";

/**
 * Scout guest HTTP surface (docs/proposals/scout-tailscale.md).
 *
 * - `/v1/guest/*` is the `guest` route tier. The ingress gate verifies the
 *   existing mesh request signature against `guest_grants` (never
 *   `trusted_peers`) on every transport, and attaches the verified guest
 *   principal. These handlers refuse any request without that principal and
 *   derive requester identity and scope from the grant, never from the body.
 * - `/v1/guest-grants*` is `local` tier: owner install/list/revoke from the
 *   Scout app on this machine. A remote caller is refused here too.
 */

export type BrokerGuestAgentSummary = {
  id: string;
  displayName: string;
  handle?: string;
};

export type BrokerGuestHttpDeps = {
  grants: GuestGrantStore | null;
  nodeId: string;
  nodeKeyId: string;
  nodeCard?: () => SignedNodeCard;
  listAgents: () => BrokerGuestAgentSummary[];
  ensureGuestActor: (actor: ActorIdentity) => Promise<void>;
  /** The guest's direct thread with the target, through the canonical conversation writer. */
  openThread: (input: { requesterId: string; targetAgentId: string }) => Promise<ConversationDefinition>;
  /** The canonical message writer; an identical retry of the same id is a no-op. */
  postMessage: (message: MessageRecord) => Promise<unknown>;
  invoke: (invocation: InvocationRequest) => Promise<unknown>;
  existingInvocation: (invocationId: string) => InvocationRequest | undefined;
  flightForInvocation: (invocationId: string) => FlightRecord | undefined;
  sessions?: BrokerExternalSessionService;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const TERMINAL_FLIGHT_STATES = new Set<FlightRecord["state"]>(["completed", "failed", "cancelled"]);
const WAIT_POLL_MS = 250;

function nowFrom(deps: BrokerGuestHttpDeps): number {
  return deps.now?.() ?? Date.now();
}

function guestError(response: RuntimeHttpResponseLike, error: unknown): void {
  if (error instanceof GuestAccessError) {
    json(response, error.status, { error: error.code, detail: error.message });
    return;
  }
  json(response, 400, { error: "invalid_request", detail: error instanceof Error ? error.message : String(error) });
}

/** Owner-facing projection; the public key is safe to show, nothing here is secret. */
export function guestGrantView(grant: GuestGrantRecord, now: number) {
  return {
    id: grant.id,
    requestId: grant.requestId,
    keyId: grant.keyId,
    label: grant.label,
    actorId: grant.actorId,
    allowedTargets: grant.allowedTargets,
    ownerHandle: grant.ownerHandle,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    revokedAt: grant.revokedAt,
    lastUsedAt: grant.lastUsedAt,
    status: guestGrantStatus(grant, now),
  };
}

function askView(requestId: string, invocation: InvocationRequest | undefined, flight: FlightRecord | undefined) {
  return {
    requestId,
    invocationId: invocation?.id ?? null,
    target: invocation?.targetAgentId ?? null,
    state: flight?.state ?? (invocation ? "queued" : "unknown"),
    ...(flight?.output !== undefined ? { output: flight.output } : {}),
    ...(flight?.summary !== undefined ? { summary: flight.summary } : {}),
    ...(flight?.error !== undefined ? { error: flight.error } : {}),
    ...(flight?.completedAt !== undefined ? { completedAt: flight.completedAt } : {}),
  };
}

/**
 * Returns true when the request was a guest or guest-grant route (and has
 * been answered), false to let the main router continue.
 */
export async function handleBrokerGuestRoute(
  request: RuntimeHttpRequestLike,
  response: RuntimeHttpResponseLike,
  url: URL,
  method: string,
  deps: BrokerGuestHttpDeps,
): Promise<boolean> {
  const isAdmin = url.pathname === "/v1/guest-grants" || url.pathname.startsWith("/v1/guest-grants/");
  const isGuest = url.pathname.startsWith("/v1/guest/");
  if (!isAdmin && !isGuest) return false;

  const grants = deps.grants;
  if (!grants) {
    json(response, 503, { error: "guest_persistence_unavailable", detail: "broker SQLite persistence is disabled" });
    return true;
  }

  if (isAdmin) {
    if (request.transportContext?.transport === "remote") {
      json(response, 403, { error: "forbidden", detail: "route is machine-local" });
      return true;
    }
    await handleGrantAdmin(request, response, url, method, grants, deps);
    return true;
  }

  // Guest tier: only a principal attached by the ingress gate counts.
  const principal = request.transportContext?.guest;
  if (!principal) {
    json(response, 401, { error: "unauthorized", detail: "a signed guest request is required" });
    return true;
  }
  const grant = grants.byId(principal.grantId);
  const now = nowFrom(deps);
  if (!grant || grant.keyId !== principal.keyId || guestGrantStatus(grant, now) !== "active") {
    json(response, 401, { error: "grant_inactive", detail: "this guest grant is revoked, expired, or unknown" });
    return true;
  }
  grants.touch(grant.id, now);

  if (method === "GET" && url.pathname === "/v1/guest/whoami") {
    json(response, 200, {
      protocol: GUEST_PROTOCOL_VERSION,
      grant: {
        id: grant.id,
        label: grant.label,
        actorId: grant.actorId,
        allowedTargets: grant.allowedTargets,
        expiresAt: grant.expiresAt,
      },
      node: { id: deps.nodeId, keyId: deps.nodeKeyId },
    });
    return true;
  }

  if (method === "GET" && url.pathname === "/v1/guest/agents") {
    const query = (url.searchParams.get("query") ?? "").trim().toLowerCase().slice(0, 100);
    const allowed = new Set(grant.allowedTargets);
    const agents = deps.listAgents()
      .filter((agent) => allowed.has(agent.id))
      .filter((agent) => !query
        || agent.id.toLowerCase().includes(query)
        || agent.displayName.toLowerCase().includes(query)
        || (agent.handle ?? "").toLowerCase().includes(query))
      .map((agent) => ({ id: agent.id, displayName: agent.displayName, ...(agent.handle ? { handle: agent.handle } : {}) }));
    json(response, 200, { agents });
    return true;
  }

  if (method === "POST" && (url.pathname === "/v1/guest/sessions/attach" || url.pathname === "/v1/guest/sessions/get"
    || url.pathname === "/v1/guest/sessions/poll" || url.pathname === "/v1/guest/sessions/ack" || url.pathname === "/v1/guest/sessions/reply")) {
    const sessionAction = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
    try {
      const service = deps.sessions;
      if (!service) throw new GuestAccessError("unavailable", "session mailbox is unavailable", 503);
      const input = await readRequestBody<Record<string, unknown>>(request);
      const string = (key: string, max = 512) => {
        const value = input[key];
        if (typeof value !== "string" || !value.trim() || value.length > max) {
          throw new GuestAccessError("invalid_request", `${key} is required and must be at most ${max} characters`);
        }
        return value;
      };
      // Never accept an owner, provider connection, or identity from guest input.
      // Actor identity is unique to this grant, so replacement grants cannot read old mailboxes.
      const authorize = () => {
        const current = grants.byId(grant.id);
        if (!current || current.keyId !== principal.keyId || guestGrantStatus(current, nowFrom(deps)) !== "active") {
          throw new GuestAccessError("grant_inactive", "this guest grant is revoked or expired", 401);
        }
      };
      authorize();
      const ownerId = `${grant.actorId}.${grant.id}`;
      const result = sessionAction === "attach"
        ? await service.attach({ ownerId, nativeSessionId: string("nativeSessionId"), authorize })
        : sessionAction === "reply"
        ? await service.reply({ ownerId, sessionId: string("sessionId"), deliveryId: string("deliveryId"), body: string("body", 100_000), authorize })
        : sessionAction === "ack"
        ? await service.acknowledge({ ownerId, sessionId: string("sessionId"), deliveryId: string("deliveryId"), authorize })
        : sessionAction === "poll"
        ? await service.poll({ ownerId, sessionId: string("sessionId"), cursor: typeof input.cursor === "string" ? input.cursor : undefined,
            limit: typeof input.limit === "number" ? input.limit : undefined })
        : service.get({ ownerId, sessionId: string("sessionId") });
      authorize();
      json(response, 200, result);
    } catch (error) { guestError(response, error); }
    return true;
  }

  if (method === "POST" && url.pathname === "/v1/guest/asks") {
    await handleGuestAsk(request, response, grant, deps);
    return true;
  }

  const askMatch = method === "GET" ? url.pathname.match(/^\/v1\/guest\/asks\/([^/]+)$/) : null;
  if (askMatch) {
    await handleGuestAskRead(request, response, url, decodeURIComponent(askMatch[1] ?? ""), grant, grants, deps);
    return true;
  }

  json(response, 404, { error: "not_found" });
  return true;
}

async function handleGrantAdmin(
  request: RuntimeHttpRequestLike,
  response: RuntimeHttpResponseLike,
  url: URL,
  method: string,
  grants: GuestGrantStore,
  deps: BrokerGuestHttpDeps,
): Promise<void> {
  const now = nowFrom(deps);
  if (method === "GET" && url.pathname === "/v1/guest-grants") {
    json(response, 200, { grants: grants.list().map((grant) => guestGrantView(grant, now)) });
    return;
  }
  if (method === "POST" && url.pathname === "/v1/guest-grants") {
    try {
      const body = await readRequestBody<Record<string, unknown>>(request);
      const { grant, created } = grants.install({
        requestId: body.requestId,
        clientPublicKey: body.clientPublicKey,
        label: body.label,
        allowedTargets: body.allowedTargets,
        ownerHandle: body.ownerHandle,
        expiresAt: body.expiresAt,
      }, now);
      // The bootstrap is what the owner's app projects to the hosted service
      // for the client's claim: this node's signed card (identity, endpoints,
      // TLS SPKI pin) plus the grant reference. It carries no secret.
      json(response, 200, {
        created,
        grant: guestGrantView(grant, now),
        bootstrap: {
          protocol: GUEST_PROTOCOL_VERSION,
          grantId: grant.id,
          nodeId: deps.nodeId,
          nodeKeyId: deps.nodeKeyId,
          card: deps.nodeCard?.() ?? null,
        },
      });
    } catch (error) {
      guestError(response, error);
    }
    return;
  }
  if (method === "POST" && url.pathname === "/v1/guest-grants/revoke") {
    try {
      const body = await readRequestBody<{ grantId?: unknown; requestId?: unknown }>(request);
      const grantId = typeof body.grantId === "string" ? body.grantId : undefined;
      const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
      if (!grantId && !requestId) throw new GuestAccessError("invalid_request", "grantId or requestId is required");
      const revoked = grants.revoke({ grantId, requestId }, now);
      if (!revoked) {
        json(response, 404, { error: "not_found" });
        return;
      }
      json(response, 200, { ok: true, grant: guestGrantView(revoked, now) });
    } catch (error) {
      guestError(response, error);
    }
    return;
  }
  json(response, 404, { error: "not_found" });
}

const acceptances = new WeakMap<BrokerGuestHttpDeps, Map<string, Promise<void>>>();

/** Runs `accept` for one invocation id at a time within this broker. */
async function oncePerInvocation(deps: BrokerGuestHttpDeps, invocationId: string, accept: () => Promise<void>): Promise<void> {
  let queue = acceptances.get(deps);
  if (!queue) {
    queue = new Map();
    acceptances.set(deps, queue);
  }
  const run = (queue.get(invocationId) ?? Promise.resolve()).then(accept);
  const settled = run.then(() => undefined, () => undefined);
  queue.set(invocationId, settled);
  try {
    await run;
  } finally {
    if (queue.get(invocationId) === settled) queue.delete(invocationId);
  }
}

export function guestMessageId(invocationId: string): string {
  return `msg-${invocationId}`;
}

async function handleGuestAsk(
  request: RuntimeHttpRequestLike,
  response: RuntimeHttpResponseLike,
  grant: GuestGrantRecord,
  deps: BrokerGuestHttpDeps,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readRequestBody<Record<string, unknown>>(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("expected a JSON object");
  } catch (error) {
    guestError(response, error);
    return;
  }
  const unknown = Object.keys(body).filter((key) => !["requestId", "target", "task"].includes(key));
  if (unknown.length > 0) {
    json(response, 400, { error: "invalid_request", detail: `unsupported fields: ${unknown.join(", ")}` });
    return;
  }
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  const target = typeof body.target === "string" ? body.target.trim() : "";
  const task = typeof body.task === "string" ? body.task : "";
  if (!GUEST_ASK_REQUEST_ID_PATTERN.test(requestId)) {
    json(response, 400, { error: "invalid_request", detail: "requestId must be 8-64 letters, digits, dashes, or underscores" });
    return;
  }
  if (!task.trim() || Buffer.byteLength(task, "utf8") > GUEST_ASK_MAX_TASK_BYTES) {
    json(response, 400, { error: "invalid_request", detail: `task must be 1-${GUEST_ASK_MAX_TASK_BYTES} bytes` });
    return;
  }
  // Scope before existence: a target outside the grant is forbidden whether
  // or not such an agent exists, so the guest learns nothing about others.
  if (!grant.allowedTargets.includes(target)) {
    json(response, 403, { error: "target_not_allowed", detail: "this grant cannot ask that target" });
    return;
  }

  const invocationId = guestInvocationId(grant.id, requestId);
  // Identical concurrent submissions are accepted one at a time, so the
  // second sees the first's invocation instead of posting or dispatching again.
  await oncePerInvocation(deps, invocationId, () => acceptGuestAsk(response, grant, deps, { requestId, target, task, invocationId }));
}

async function acceptGuestAsk(
  response: RuntimeHttpResponseLike,
  grant: GuestGrantRecord,
  deps: BrokerGuestHttpDeps,
  { requestId, target, task, invocationId }: { requestId: string; target: string; task: string; invocationId: string },
): Promise<void> {
  // Ownership is checked before duplicate lookup: the id is namespaced by
  // this grant, and a stored requester must still match.
  // A queued submission can outlive the grant checked at ingress. Recheck
  // before returning saved output or writing/dispatching any new work.
  const current = deps.grants?.byId(grant.id);
  if (!current || current.keyId !== grant.keyId || guestGrantStatus(current, nowFrom(deps)) !== "active") {
    json(response, 401, { error: "grant_inactive", detail: "this guest grant is revoked, expired, or unknown" });
    return;
  }
  if (!current.allowedTargets.includes(target)) {
    json(response, 403, { error: "target_not_allowed", detail: "this grant cannot ask that target" });
    return;
  }
  const existing = deps.existingInvocation(invocationId);
  if (existing) {
    if (existing.requesterId !== grant.actorId) {
      json(response, 404, { error: "unknown_request" });
      return;
    }
    if (existing.targetAgentId !== target || existing.task !== task) {
      json(response, 409, { error: "request_conflict", detail: "this requestId was already used with a different target or task" });
      return;
    }
    json(response, 200, { duplicate: true, ...askView(requestId, existing, deps.flightForInvocation(invocationId)) });
    return;
  }

  if (!deps.listAgents().some((agent) => agent.id === target)) {
    json(response, 409, { error: "target_unavailable", detail: "that agent is not registered on this node" });
    return;
  }

  const now = nowFrom(deps);
  const guestMetadata = { source: "scout-guest", guestGrantId: grant.id, guestRequestId: requestId };
  try {
    await deps.ensureGuestActor({
      id: grant.actorId,
      kind: "bridge",
      displayName: grant.label,
      handle: grant.actorId,
      labels: ["guest"],
      metadata: { guest: true, guestGrantId: grant.id },
    });
    // The ask is a message in the guest's direct thread with the target, so
    // the target is told how to reply and its reply completes the flight
    // through the broker's normal reply matching. Both ids are derived from
    // the invocation id: a retry after an uncertain acceptance finds the same
    // thread and re-posts the same message, which the writer treats as a no-op.
    const conversation = await deps.openThread({ requesterId: grant.actorId, targetAgentId: target });
    const messageId = guestMessageId(invocationId);
    await deps.postMessage({
      id: messageId,
      conversationId: conversation.id,
      actorId: grant.actorId,
      originNodeId: deps.nodeId,
      class: "agent",
      body: task,
      mentions: [{ actorId: target, label: `@${target}` }],
      audience: { notify: [target], reason: "direct_message" },
      visibility: messageVisibilityForConversation(conversation),
      policy: "durable",
      createdAt: now,
      metadata: {
        ...guestMetadata,
        clientMessageId: invocationId,
        relayChannel: "dm",
        relayTarget: target,
        relayTargetIds: [target],
        relayMessageId: messageId,
      },
    });
    const invocation: InvocationRequest = {
      origin: { source: "unknown" },
      id: invocationId,
      requesterId: grant.actorId,
      requesterNodeId: deps.nodeId,
      targetAgentId: target,
      action: "consult",
      task,
      conversationId: conversation.id,
      messageId,
      ensureAwake: true,
      stream: false,
      createdAt: now,
      metadata: guestMetadata,
    };
    const result = await deps.invoke(invocation) as { dispatch?: { kind?: string; detail?: string } } | undefined;
    const recorded = deps.existingInvocation(invocationId);
    if (!recorded) {
      // The broker answered with a routing dispatch instead of accepting work
      // (target offline or ambiguous). Nothing was executed.
      json(response, 409, {
        error: "target_unavailable",
        detail: result?.dispatch?.detail ?? "the target could not accept work now",
      });
      return;
    }
    json(response, 202, { duplicate: false, ...askView(requestId, recorded, deps.flightForInvocation(invocationId)) });
  } catch (error) {
    // Acceptance may or may not have committed. The client reconciles with
    // GET /v1/guest/asks/:requestId on this same node; never elsewhere.
    json(response, 500, {
      error: "acceptance_uncertain",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleGuestAskRead(
  request: RuntimeHttpRequestLike,
  response: RuntimeHttpResponseLike,
  url: URL,
  requestId: string,
  grant: GuestGrantRecord,
  grants: GuestGrantStore,
  deps: BrokerGuestHttpDeps,
): Promise<void> {
  if (!GUEST_ASK_REQUEST_ID_PATTERN.test(requestId)) {
    json(response, 400, { error: "invalid_request", detail: "invalid requestId" });
    return;
  }
  const invocationId = guestInvocationId(grant.id, requestId);
  const invocation = deps.existingInvocation(invocationId);
  if (!invocation || invocation.requesterId !== grant.actorId) {
    json(response, 404, { error: "unknown_request" });
    return;
  }
  const waitSeconds = Number(url.searchParams.get("wait") ?? "0");
  const waitMs = Number.isFinite(waitSeconds) && waitSeconds > 0
    ? Math.min(waitSeconds * 1_000, GUEST_ASK_MAX_WAIT_MS)
    : 0;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = nowFrom(deps) + waitMs;
  let closed = false;
  response.on("close", () => { closed = true; });
  let flight = deps.flightForInvocation(invocationId);
  while (waitMs > 0 && !closed && !(flight && TERMINAL_FLIGHT_STATES.has(flight.state)) && nowFrom(deps) < deadline) {
    await sleep(WAIT_POLL_MS);
    // Revocation ends an in-progress wait on the next tick.
    const current = grants.byId(grant.id);
    if (!current || guestGrantStatus(current, nowFrom(deps)) !== "active") {
      json(response, 401, { error: "grant_inactive", detail: "this guest grant is revoked, expired, or unknown" });
      return;
    }
    flight = deps.flightForInvocation(invocationId);
  }
  if (closed || response.writableEnded || response.destroyed) return;
  json(response, 200, askView(requestId, invocation, flight));
}
