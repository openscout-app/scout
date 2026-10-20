/**
 * Deny-by-default mesh route matrix (docs/proposals/mesh-trust-cone.md §4).
 *
 * Every broker route is classified into exactly one tier:
 *
 * - `local`   — loopback/unix-socket only, unauthenticated. The default for
 *               all control/mutation surface; remote peers can never reach it.
 * - `observe` — remote peers holding an `observe` or `control` grant may read.
 * - `control` — remote peers holding a `control` grant.
 * - `public`  — unauthenticated, remote-reachable by design: the node card and
 *               the trust enrollment handshake (rate-limited, single-use).
 * - `guest`   — signed by an owner-approved guest key from `guest_grants`
 *               (docs/proposals/scout-tailscale.md), on every transport. Peer
 *               grants never satisfy it, and guest keys satisfy nothing else.
 *
 * The matrix is tied to the checked-in route inventory
 * (broker-daemon-route-inventory.test.ts): a route without a declared tier
 * fails that test, so new routes are authenticated by construction. Method
 * does not imply tier — routes like `GET /v1/repo-watch/warm` mutate, so they
 * stay `local` and must never be promoted to `observe`.
 */

export type MeshRouteTier = "local" | "observe" | "control" | "public" | "guest" | "scoped";

export const MESH_ROUTE_TIERS: readonly MeshRouteTier[] = ["local", "observe", "control", "public", "guest", "scoped"];

/** Rank for grant-tier satisfaction checks; `local`/`public` never compare. */
const GRANT_TIER_RANK: Record<"observe" | "control", number> = { observe: 1, control: 2 };

/** The /trpc WebSocket upgrade bypasses the HTTP router; it is gated separately. */
export const TRPC_UPGRADE_ROUTE = "GET /trpc";

/**
 * "METHOD path" → tier. Parameterized paths use the inventory's `:id` shape.
 * Keys must match broker-daemon-route-inventory.test.ts exactly (plus the
 * TRPC_UPGRADE_ROUTE allowlist entry, which the inventory test exempts).
 */
const MESH_ROUTE_MATRIX: Record<string, MeshRouteTier> = {
  "POST /v1/access/rpc": "scoped",
  "POST /v1/access/policy": "public",
  "POST /v1/access/admin": "local",
  "POST /v1/mcp-events": "local",
  "POST /v1/native-session-attention": "local",
  "POST /v1/surfaces/deck": "local",

  // ── public: node card + enrollment handshake ────────────────────────────
  "GET /v1/node": "public",
  "POST /v1/trust/enroll/begin": "public",
  "POST /v1/trust/enroll/reveal": "public",

  // ── observe: read-only mesh surface for enrolled peers ──────────────────
  "GET /v1/mesh/nodes": "observe",
  // Remote-tier twins of local read routes (mesh trust cone §4): narrow
  // mounts for peer-needed reads so signed peers work in enforce mode. The
  // local-tier originals below are never widened.
  "GET /v1/mesh/invocations/:id/stream": "observe",
  // Compact node state: identity + bounded workload counts for the agents
  // homed on the answering node. The local-tier `GET /v1/home` stays
  // loopback-only; this is the narrow twin a peer's Network view may read.
  "GET /v1/mesh/node-state": "observe",
  "GET /v1/mesh/snapshot": "observe",

  // ── control: mesh peer write/forwarding surface ─────────────────────────
  // Alias resolution is an RPC-style POST read; the matrix reserves observe
  // for GET/HEAD, so its remote-tier twin rides control.
  "POST /v1/mesh/aliases/resolve": "control",
  "POST /v1/mesh/collaboration/events": "control",
  "POST /v1/mesh/collaboration/records": "control",
  "POST /v1/mesh/discover": "control",
  "POST /v1/mesh/flights": "control",
  "POST /v1/mesh/invocations": "control",
  "POST /v1/mesh/messages": "control",
  // T4 flat session dispatch: a peer asks this node to wake a session found in
  // its local harness store. Registers a cardless endpoint — control tier, the
  // same trust as forwarding an invocation here.
  "POST /v1/mesh/sessions/wake": "control",
  // New-session twin: a peer asks this node to start a cardless session in a
  // project that exists here. Same trust as forwarding an invocation.
  "POST /v1/mesh/sessions/start": "control",
  "POST /v1/mesh/web-request": "control",
  // Cross-machine approvals: control tier AND a per-peer share opt-in on this
  // machine (mesh-approvals.ts) — the tier alone never exposes them.
  "GET /v1/mesh/approvals/stream": "control",
  "POST /v1/mesh/approvals/decide": "control",
  "GET /v1/approvals/remote": "local",
  "POST /v1/approvals/remote/decide": "local",
  "POST /v1/hosts/web-request": "local",
  [TRPC_UPGRADE_ROUTE]: "control",

  // ── local: machine-local bind flip (handler also refuse-remote, §11.5/§11.9)
  "POST /v1/mesh/bind": "local",

  // ── local: everything else (deny by default) ────────────────────────────
  "DELETE /v1/aliases/:id": "local",
  "DELETE /v1/endpoints/:id": "local",
  "DELETE /v1/machines/:id": "local",
  "GET /.host-info": "local",
  "GET /.well-known/agent-card.json": "local",
  "GET /health": "local",
  "GET /v1/a2a/agent-card.json": "local",
  "GET /v1/a2a/agents/:id/agent-card.json": "local",
  "GET /v1/activity": "local",
  "GET /v1/agent-cards": "local",
  "GET /v1/aliases": "local",
  "GET /v1/aliases/:id/history": "local",
  "GET /v1/broker/messages": "local",
  "GET /v1/capabilities": "local",
  "GET /v1/capabilities/availability": "local",
  "GET /v1/runtime-catalog": "local",
  "GET /v1/collaboration/events": "local",
  "GET /v1/collaboration/records": "local",
  "GET /v1/conversation-projection": "local",
  "GET /v1/conversations/:id/read-cursors": "local",
  "GET /v1/conversations/:id/thread-events": "local",
  "GET /v1/conversations/:id/thread-snapshot": "local",
  "GET /v1/deliveries": "local",
  "GET /v1/delivery-attempts": "local",
  "GET /v1/endpoints": "local",
  "GET /v1/events": "local",
  "GET /v1/events/stream": "local",
  "GET /v1/home": "local",
  "GET /v1/inbox": "local",
  "GET /v1/inbox/stream": "local",
  "GET /v1/invocations/:id": "local",
  "GET /v1/invocations/:id/lifecycle": "local",
  "GET /v1/invocations/:id/stream": "local",
  "GET /v1/machines": "local",
  "GET /v1/machines/:id": "local",
  "GET /v1/message-reactions": "local",
  "GET /v1/messages": "local",
  "GET /v1/missions/:id/log": "local",
  "GET /v1/pairing/sessions": "local",
  "GET /v1/repo-watch/snapshot": "local",
  // mutates despite being a GET — never observe
  "GET /v1/repo-watch/warm": "local",
  // Receipt recovery exposes requester results and may persist recovered state.
  "GET /v1/request-receipts/:id": "local",
  "GET /v1/roles/assignments": "local",
  "GET /v1/roles/catalog": "local",
  "GET /v1/snapshot": "local",
  "GET /v1/notification-routing": "local",
  "GET /v1/tail/discover": "local",
  "GET /v1/tail/recent": "local",
  "GET /v1/thread-watches/:id/stream": "local",
  "GET /v1/topology/snapshot": "local",
  "GET /v1/trust/enroll/sessions": "local",
  "GET /v1/trust/enroll/status": "local",
  "GET /v1/trust/peers": "local",
  "GET /v1/web/status": "local",
  "OPTIONS /v1/web/restart": "local",
  "OPTIONS /v1/web/start": "local",
  "OPTIONS /v1/web/status": "local",
  "PATCH /v1/aliases/:id": "local",
  "PATCH /v1/machines/:id": "local",
  "POST /a2a": "local",
  "POST /v1/a2a/agents/:id/rpc": "local",
  "POST /v1/a2a/rpc": "local",
  "POST /v1/actors": "local",
  "POST /v1/agent-cards": "local",
  "POST /v1/agents": "local",
  "POST /v1/aliases": "local",
  "POST /v1/aliases/resolve": "local",
  "POST /v1/bindings": "local",
  "POST /v1/collaboration/events": "local",
  "POST /v1/collaboration/records": "local",
  "POST /v1/collaboration/records/:id/invoke": "local",
  "POST /v1/commands": "local",
  "POST /v1/conversations": "local",
  "POST /v1/conversations/:id/read-cursors": "local",
  "POST /v1/conversations/:id/corrections": "local",
  "POST /v1/conversations/:id/questions/:id/respond": "local",
  "POST /v1/conversations/:id/pins": "local",
  "POST /v1/conversations/:id/title": "local",
  "POST /v1/deliver": "local",
  "POST /v1/deliveries/claim": "local",
  "POST /v1/deliveries/status": "local",
  "POST /v1/delivery-attempts": "local",
  "POST /v1/durable-actions": "local",
  "POST /v1/durable-actions/:id/heartbeat": "local",
  "POST /v1/endpoints": "local",
  "POST /v1/external-sessions/ack": "local",
  "POST /v1/external-sessions/attach": "local",
  "POST /v1/external-sessions/get": "local",
  "POST /v1/external-sessions/poll": "local",
  "POST /v1/external-sessions/reply": "local",
  "POST /v1/flights": "local",
  "POST /v1/inbox/ack": "local",
  "POST /v1/inbox/claim": "local",
  "POST /v1/inbox/nack": "local",
  "POST /v1/integrations/setup": "local",
  "POST /v1/integrations/t3/:id": "local",
  "POST /v1/invocations": "local",
  "POST /v1/local-sessions/attach": "local",
  "POST /v1/local-sessions/detach": "local",
  "POST /v1/local-sessions/ensure": "local",
  "POST /v1/machines/scan": "local",
  "POST /v1/message-reactions": "local",
  "POST /v1/message-reactions/remove": "local",
  "POST /v1/messages": "local",
  "POST /v1/messages/reply": "local",
  "POST /v1/missions/:id/log": "local",
  "POST /v1/nodes": "local",
  "POST /v1/pairing/attach": "local",
  "POST /v1/pairing/detach": "local",
  // Operator authorization; the handler also refuses remote transport.
  "POST /v1/permissions/decide": "local",
  "POST /v1/rendezvous/match": "local",
  "POST /v1/repo-watch/warm": "local",
  "POST /v1/roles/assignments": "local",
  "POST /v1/roles/assignments/:id/revoke": "local",
  "POST /v1/thread-watches/close": "local",
  "POST /v1/thread-watches/open": "local",
  "POST /v1/thread-watches/renew": "local",
  "POST /v1/topology/nudge": "local",
  // operator approval is a local act (loopback only)
  "POST /v1/trust/enroll/approve": "local",
  "POST /v1/trust/enroll/reject": "local",
  // trusted_peers operator surface (peers/grant/revoke) — local acts
  "POST /v1/trust/grant": "local",
  "POST /v1/trust/revoke": "local",
  "POST /v1/web/restart": "local",
  "POST /v1/web/start": "local",

  // ── guest: owner-approved guest keys only (never mesh peers)
  "GET /v1/guest/agents": "guest",
  "GET /v1/guest/asks/:id": "guest",
  "GET /v1/guest/whoami": "guest",
  "POST /v1/guest/asks": "guest",
  "POST /v1/guest/sessions/attach": "guest",
  "POST /v1/guest/sessions/get": "guest",
  "POST /v1/guest/sessions/poll": "guest",
  "POST /v1/guest/sessions/ack": "guest",
  "POST /v1/guest/sessions/reply": "guest",

  // guest grant administration is a local owner act (loopback only)
  "GET /v1/guest-grants": "local",
  "POST /v1/guest-grants": "local",
  "POST /v1/guest-grants/revoke": "local",
};

const exactTiers = new Map<string, MeshRouteTier>();
const patternTiers: Array<{ regex: RegExp; tier: MeshRouteTier }> = [];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

for (const [route, tier] of Object.entries(MESH_ROUTE_MATRIX)) {
  const [method, path] = route.split(" ", 2);
  if (!method || !path) {
    throw new Error(`malformed mesh route matrix entry: ${route}`);
  }
  if (path.includes(":")) {
    const regex = new RegExp(
      `^${method} ${path.split("/:").map((segment, index) => {
        if (index === 0) {
          return escapeRegExp(segment);
        }
        // each "/:param" segment matches exactly one path segment
        const rest = segment.replace(/^[^/]+/, "");
        return `/[^/]+${escapeRegExp(rest)}`;
      }).join("")}$`,
    );
    patternTiers.push({ regex, tier });
  } else {
    exactTiers.set(route, tier);
  }
}

/** A snapshot of the declared matrix, for inventory cross-checks. */
export function meshRouteMatrixEntries(): Record<string, MeshRouteTier> {
  return { ...MESH_ROUTE_MATRIX };
}

/**
 * Tier for a concrete request. Unknown routes fall back to `local` — deny by
 * default, so an unmapped route is never accidentally remote-reachable.
 */
export function meshRouteTierFor(method: string, pathname: string): MeshRouteTier {
  const key = `${method.toUpperCase()} ${pathname}`;
  const exact = exactTiers.get(key);
  if (exact) {
    return exact;
  }
  for (const { regex, tier } of patternTiers) {
    if (regex.test(key)) {
      return tier;
    }
  }
  return "local";
}

/**
 * Whether a peer grant tier satisfies a route tier. `local` routes are never
 * satisfiable by a remote grant; `public` routes need no grant.
 */
export function grantSatisfiesRouteTier(
  grantTier: "observe" | "control",
  routeTier: MeshRouteTier,
): boolean {
  if (routeTier === "observe" || routeTier === "control") {
    return GRANT_TIER_RANK[grantTier] >= GRANT_TIER_RANK[routeTier];
  }
  return routeTier === "public";
}
