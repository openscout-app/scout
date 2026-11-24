import type { AgentState, DeliveryTransport } from "./common.js";

/**
 * Honest reception state for a channel member.
 *
 * Channel membership is a durable fact. Whether a member can actually receive
 * a message right now is a live judgement, and the two must never be conflated
 * — a roster that renders every member as "listening" because a row exists is
 * the specific failure this module prevents.
 *
 * Two independent axes carry the truth:
 *
 * - {@link ChannelReceptionRouteKind} — what the attached transport *can* do.
 *   A `claude_resume` or `codex_exec` endpoint has no persistent listener at
 *   all: a delivery wakes a fresh run. That is a legitimate route, but calling
 *   it "listening" would be a lie.
 * - {@link ChannelReceptionState} — what the route is doing at this instant,
 *   read from endpoint state and heartbeat freshness.
 */

export type ChannelReceptionState =
  /** A member with no agent session attached yet — the invite is unredeemed. */
  | "waiting_for_agent"
  /** An attached session that is still warming up or waking. */
  | "connecting"
  /** A live route that will carry a message now. */
  | "ready_to_receive"
  /** Attached, but no usable route exists — explain why, never imply delivery. */
  | "unavailable"
  /** A route that existed and has since gone quiet or been stopped. */
  | "disconnected";

export type ChannelReceptionRouteKind =
  /** The agent holds an open channel and sees a post without being started. */
  | "persistent"
  /**
   * Delivery reaches the invited session by resuming or steering it. Context is
   * preserved and the session is never replaced, but nothing is watching
   * between messages.
   */
  | "wake_on_delivery"
  /** No route at all. */
  | "none";

/**
 * Transports where a process is actually attached and watching. Everything
 * else either spawns per delivery or injects into a surface with no listener
 * contract, and is reported as `wake_on_delivery`.
 */
const PERSISTENT_RECEIVE_TRANSPORTS = new Set<DeliveryTransport>([
  "local_socket",
  "websocket",
  "pairing_bridge",
  "peer_broker",
  "claude_channel",
  "claude_stream_json",
  "codex_app_server",
  "pi_rpc",
  "grok_acp",
  "kimi_acp",
  "cursor_acp",
  "opencode_acp",
  "antigravity_acp",
  "devin_acp",
  "cursor_sdk_local",
]);

export function channelReceptionRouteKind(
  transport: DeliveryTransport | null | undefined,
): ChannelReceptionRouteKind {
  if (!transport) return "none";
  return PERSISTENT_RECEIVE_TRANSPORTS.has(transport) ? "persistent" : "wake_on_delivery";
}

/** How long an idle persistent route may stay silent before we stop vouching for it. */
export const CHANNEL_RECEPTION_STALE_AFTER_MS = 10 * 60 * 1000;

export interface ChannelReceptionEndpointEvidence {
  state: AgentState;
  transport: DeliveryTransport;
  sessionId?: string | null;
  lastSeenAt?: number | null;
}

export interface ChannelReceptionEvidence {
  /** The member's attached harness session, when the invite was redeemed. */
  attachedSessionId?: string | null;
  endpoint?: ChannelReceptionEndpointEvidence | null;
  nowMs: number;
  staleAfterMs?: number;
}

export interface ChannelReception {
  state: ChannelReceptionState;
  routeKind: ChannelReceptionRouteKind;
  /** True only when a process is attached and watching right now. */
  listening: boolean;
  /** Badge-length label. */
  summary: string;
  /** One sentence a person can act on. Always populated. */
  detail: string;
  /** When the evidence behind this reading was last observed. */
  evidenceAt: number | null;
}

/**
 * Derive a member's reception state from live evidence only.
 *
 * Every branch returns a `detail` sentence, including the happy path: a
 * surface should never have to invent an explanation, and a `wake_on_delivery`
 * route always says so out loud.
 */
export function deriveChannelReception(
  evidence: ChannelReceptionEvidence,
): ChannelReception {
  const endpoint = evidence.endpoint ?? null;
  const attachedSessionId = evidence.attachedSessionId?.trim() || null;
  const routeKind = channelReceptionRouteKind(endpoint?.transport);
  const evidenceAt = endpoint?.lastSeenAt ?? null;

  if (!endpoint) {
    return attachedSessionId
      ? {
          state: "unavailable",
          routeKind: "none",
          listening: false,
          summary: "No route",
          detail:
            `Session ${attachedSessionId} is attached to this channel but the broker has no registered endpoint for it, so messages cannot be delivered.`,
          evidenceAt,
        }
      : {
          state: "waiting_for_agent",
          routeKind: "none",
          listening: false,
          summary: "Waiting for agent",
          detail: "This member has joined the channel but no agent session has redeemed the invitation yet.",
          evidenceAt,
        };
  }

  const base = { routeKind, evidenceAt } as const;

  // An endpoint is only evidence about *this* member when the channel knows
  // which session it attached. Without that link there is a route on the
  // machine but nothing tying it to this membership, so it cannot be read as
  // this member being reachable.
  if (!attachedSessionId) {
    return {
      ...base,
      state: "waiting_for_agent",
      listening: false,
      summary: "Waiting for agent",
      detail: `This member has not redeemed an invitation from a session yet. A ${endpoint.transport} route exists elsewhere for them, but nothing attaches it to this channel, so a message here has no session to arrive in.`,
    };
  }

  // The invitation attached one concrete session. A live endpoint belonging to
  // a different session is somebody else's evidence: reporting it as this
  // member's readiness is exactly the false listening claim to avoid.
  const endpointSessionId = endpoint.sessionId?.trim() || null;
  if (endpointSessionId && endpointSessionId !== attachedSessionId) {
    return {
      ...base,
      state: "disconnected",
      listening: false,
      summary: "Session replaced",
      detail: `This channel attached session ${attachedSessionId}, but the live ${endpoint.transport} route now belongs to ${endpointSessionId}. Re-redeem the invitation from the session you want in the room.`,
    };
  }

  switch (endpoint.state) {
    case "attaching":
    case "waking":
      return {
        ...base,
        state: "connecting",
        listening: false,
        summary: "Connecting",
        detail: `The ${endpoint.transport} route is ${endpoint.state}; messages sent now will be delivered once it settles.`,
      };
    case "registered":
      // `registered` means the broker knows how to reach this endpoint, not
      // that a session is attached and watching. Only the live states below
      // are evidence of an active receive route.
      return {
        ...base,
        state: "connecting",
        listening: false,
        summary: "Registered",
        detail: `Session ${attachedSessionId} is registered over ${endpoint.transport} but has not been observed attached and watching, so it is not yet an active receive route.`,
      };
    case "offline":
    case "stopped":
      return {
        ...base,
        state: "disconnected",
        listening: false,
        summary: "Disconnected",
        detail: `The attached session's ${endpoint.transport} route is ${endpoint.state}. Restart or re-attach the session to receive messages.`,
      };
    case "superseded":
      return {
        ...base,
        state: "disconnected",
        listening: false,
        summary: "Superseded",
        detail: "A newer route replaced this one. The member's membership stands, but this endpoint no longer receives.",
      };
    case "unreachable":
    case "failed":
      return {
        ...base,
        state: "unavailable",
        listening: false,
        summary: endpoint.state === "failed" ? "Failed" : "Unreachable",
        detail: `The broker last saw this ${endpoint.transport} route as ${endpoint.state}; it cannot currently accept a delivery.`,
      };
    default:
      break;
  }

  // Past this point every branch makes a positive claim about the attached
  // session. An endpoint that does not say which session it serves cannot
  // support one: the route may well be fine, but "session X is receiving" is a
  // claim about a specific session and this is not evidence for it. The
  // negative states above are unaffected -- a dead route is dead either way.
  if (!endpointSessionId) {
    return {
      ...base,
      state: "connecting",
      listening: false,
      summary: "Unconfirmed",
      detail: `A ${endpoint.transport} route is registered for this member, but it does not identify which session it serves, so Scout cannot confirm that session ${attachedSessionId} is the one receiving.`,
    };
  }

  if (routeKind === "wake_on_delivery") {
    return {
      ...base,
      state: "ready_to_receive",
      listening: false,
      summary: "Wakes on delivery",
      // Say what actually happens. These transports resume or steer the exact
      // invited session, so context survives -- claiming a message "starts a
      // new run" would misdescribe them. What they lack is a listener between
      // messages, and that is the only claim being withheld here.
      detail: `Messages reach this member by ${endpoint.transport === "tmux" ? "steering" : "resuming"} session ${attachedSessionId} over ${endpoint.transport}. That session keeps its context and is never replaced, but nothing is watching the channel between messages.`,
    };
  }

  const staleAfterMs = evidence.staleAfterMs ?? CHANNEL_RECEPTION_STALE_AFTER_MS;
  const lastSeenAt = endpoint.lastSeenAt ?? null;

  // Registration is not observation. A persistent route claims a process is
  // watching right now; with no timestamp the broker has never seen it do so,
  // and an unobserved row is not grounds for telling a person their agent is
  // listening. A wake-on-delivery route makes no such claim, so its
  // registration alone remains sufficient.
  if (lastSeenAt === null) {
    return {
      ...base,
      state: "connecting",
      listening: false,
      summary: "Unconfirmed",
      detail: `The ${endpoint.transport} route is registered for this session but has never been observed live, so Scout cannot yet confirm it is listening.`,
    };
  }

  if (evidence.nowMs - lastSeenAt > staleAfterMs) {
    return {
      ...base,
      state: "disconnected",
      listening: false,
      summary: "Silent",
      detail: `The ${endpoint.transport} route is registered but has not been seen for ${formatDuration(evidence.nowMs - lastSeenAt)}, so it is no longer treated as listening.`,
      evidenceAt: lastSeenAt,
    };
  }

  return {
    ...base,
    state: "ready_to_receive",
    listening: true,
    summary: "Ready to receive",
    detail: `An attached ${endpoint.transport} session is watching this channel and will see new messages without being started.`,
    evidenceAt: lastSeenAt,
  };
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

export function channelReceptionStateLabel(state: ChannelReceptionState): string {
  switch (state) {
    case "waiting_for_agent": return "Waiting for agent";
    case "connecting": return "Connecting";
    case "ready_to_receive": return "Ready to receive";
    case "unavailable": return "Unavailable";
    case "disconnected": return "Disconnected";
  }
}
