import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { scoutBrokerPaths } from "@openscout/protocol";

import {
  extractRouteInventory,
  literalRouteBranches,
  type LiteralRouteBranch,
} from "./broker-route-inventory.js";
import {
  meshRouteMatrixEntries,
  MESH_ROUTE_TIERS,
  TRPC_UPGRADE_ROUTE,
} from "./mesh-route-matrix.js";

function routerSource(fileName: string): string {
  return readFileSync(join(import.meta.dir, fileName), "utf8");
}

function brokerHttpRouterSource(): string {
  return routerSource("broker-http-router.ts");
}

// The checked-in broker HTTP route inventory ("METHOD path", sorted). This is
// the wire contract served by broker-http-router.ts +
// broker-http-entity-write-routes.ts. If a test run diffs against this list,
// a route was added, dropped, or renamed: update the list only when the change
// is intentional, and remember mesh (/v1/mesh/*) and A2A paths are external
// contracts consumed by peer brokers and outside clients. Every route here
// must also carry a tier in mesh-route-matrix.ts (deny by default).
const expectedRouteInventory = [
  "DELETE /v1/aliases/:id",
  "DELETE /v1/endpoints/:id",
  "DELETE /v1/machines/:id",
  "GET /.host-info",
  "GET /.well-known/agent-card.json",
  "GET /health",
  "GET /v1/a2a/agent-card.json",
  "GET /v1/a2a/agents/:id/agent-card.json",
  "GET /v1/activity",
  "GET /v1/agent-cards",
  "GET /v1/aliases",
  "GET /v1/aliases/:id/history",
  "GET /v1/approvals/remote",
  "GET /v1/broker/messages",
  "GET /v1/capabilities",
  "GET /v1/capabilities/availability",
  "GET /v1/collaboration/events",
  "GET /v1/collaboration/records",
  "GET /v1/conversation-projection",
  "GET /v1/conversations/:id/read-cursors",
  "GET /v1/conversations/:id/thread-events",
  "GET /v1/conversations/:id/thread-snapshot",
  "GET /v1/deliveries",
  "GET /v1/delivery-attempts",
  "GET /v1/endpoints",
  "GET /v1/events",
  "GET /v1/events/stream",
  "GET /v1/guest-grants",
  "GET /v1/guest/agents",
  "GET /v1/guest/asks/:id",
  "GET /v1/guest/whoami",
  "GET /v1/home",
  "GET /v1/inbox",
  "GET /v1/inbox/stream",
  "GET /v1/invocations/:id",
  "GET /v1/invocations/:id/lifecycle",
  "GET /v1/invocations/:id/stream",
  "GET /v1/machines",
  "GET /v1/machines/:id",
  "GET /v1/mesh/approvals/stream",
  "GET /v1/mesh/invocations/:id/stream",
  "GET /v1/mesh/node-state",
  "GET /v1/mesh/nodes",
  "GET /v1/mesh/snapshot",
  "GET /v1/message-reactions",
  "GET /v1/messages",
  "GET /v1/missions/:id/log",
  "GET /v1/node",
  "GET /v1/notification-routing",
  "GET /v1/pairing/sessions",
  "GET /v1/repo-watch/snapshot",
  "GET /v1/repo-watch/warm",
  "GET /v1/request-receipts/:id",
  "GET /v1/roles/assignments",
  "GET /v1/roles/catalog",
  "GET /v1/runtime-catalog",
  "GET /v1/snapshot",
  "GET /v1/tail/discover",
  "GET /v1/tail/recent",
  "GET /v1/thread-watches/:id/stream",
  "GET /v1/topology/snapshot",
  "GET /v1/trust/enroll/sessions",
  "GET /v1/trust/enroll/status",
  "GET /v1/trust/peers",
  "GET /v1/web/status",
  "OPTIONS /v1/web/restart",
  "OPTIONS /v1/web/start",
  "OPTIONS /v1/web/status",
  "PATCH /v1/aliases/:id",
  "PATCH /v1/machines/:id",
  "POST /a2a",
  "POST /v1/a2a/agents/:id/rpc",
  "POST /v1/a2a/rpc",
  "POST /v1/access/admin",
  "POST /v1/access/policy",
  "POST /v1/access/rpc",
  "POST /v1/actors",
  "POST /v1/agent-cards",
  "POST /v1/agents",
  "POST /v1/aliases",
  "POST /v1/aliases/resolve",
  "POST /v1/approvals/remote/decide",
  "POST /v1/bindings",
  "POST /v1/collaboration/events",
  "POST /v1/collaboration/records",
  "POST /v1/collaboration/records/:id/invoke",
  "POST /v1/commands",
  "POST /v1/conversations",
  "POST /v1/conversations/:id/corrections",
  "POST /v1/conversations/:id/pins",
  "POST /v1/conversations/:id/questions/:id/respond",
  "POST /v1/conversations/:id/read-cursors",
  "POST /v1/conversations/:id/title",
  "POST /v1/deliver",
  "POST /v1/deliveries/claim",
  "POST /v1/deliveries/status",
  "POST /v1/delivery-attempts",
  "POST /v1/durable-actions",
  "POST /v1/durable-actions/:id/heartbeat",
  "POST /v1/endpoints",
  "POST /v1/external-sessions/ack",
  "POST /v1/external-sessions/attach",
  "POST /v1/external-sessions/get",
  "POST /v1/external-sessions/poll",
  "POST /v1/external-sessions/reply",
  "POST /v1/flights",
  "POST /v1/guest-grants",
  "POST /v1/guest-grants/revoke",
  "POST /v1/guest/asks",
  "POST /v1/guest/sessions/ack",
  "POST /v1/guest/sessions/attach",
  "POST /v1/guest/sessions/get",
  "POST /v1/guest/sessions/poll",
  "POST /v1/guest/sessions/reply",
  "POST /v1/hosts/web-request",
  "POST /v1/inbox/ack",
  "POST /v1/inbox/claim",
  "POST /v1/inbox/nack",
  "POST /v1/integrations/setup",
  "POST /v1/integrations/t3/:id",
  "POST /v1/invocations",
  "POST /v1/local-sessions/attach",
  "POST /v1/local-sessions/detach",
  "POST /v1/local-sessions/ensure",
  "POST /v1/machines/scan",
  "POST /v1/mcp-events",
  "POST /v1/mesh/aliases/resolve",
  "POST /v1/mesh/approvals/decide",
  "POST /v1/mesh/bind",
  "POST /v1/mesh/collaboration/events",
  "POST /v1/mesh/collaboration/records",
  "POST /v1/mesh/discover",
  "POST /v1/mesh/flights",
  "POST /v1/mesh/invocations",
  "POST /v1/mesh/messages",
  "POST /v1/mesh/sessions/start",
  "POST /v1/mesh/sessions/wake",
  "POST /v1/mesh/web-request",
  "POST /v1/message-reactions",
  "POST /v1/message-reactions/remove",
  "POST /v1/messages",
  "POST /v1/messages/reply",
  "POST /v1/missions/:id/log",
  "POST /v1/native-session-attention",
  "POST /v1/nodes",
  "POST /v1/pairing/attach",
  "POST /v1/pairing/detach",
  "POST /v1/permissions/decide",
  "POST /v1/rendezvous/match",
  "POST /v1/repo-watch/warm",
  "POST /v1/roles/assignments",
  "POST /v1/roles/assignments/:id/revoke",
  "POST /v1/surfaces/deck",
  "POST /v1/thread-watches/close",
  "POST /v1/thread-watches/open",
  "POST /v1/thread-watches/renew",
  "POST /v1/topology/nudge",
  "POST /v1/trust/enroll/approve",
  "POST /v1/trust/enroll/begin",
  "POST /v1/trust/enroll/reject",
  "POST /v1/trust/enroll/reveal",
  "POST /v1/trust/grant",
  "POST /v1/trust/revoke",
  "POST /v1/web/restart",
  "POST /v1/web/start",
];

function liveRouteInventory(): string[] {
  const routes = new Set<string>([
    ...extractRouteInventory(brokerHttpRouterSource()),
    ...extractRouteInventory(routerSource("broker-http-entity-write-routes.ts")),
    ...extractRouteInventory(routerSource("broker-guest-http-routes.ts")),
    ...extractRouteInventory(routerSource("mesh-approvals.ts")),
  ]);
  return [...routes].sort();
}

describe("broker HTTP route inventory", () => {
  test("does not define duplicate exact literal method/path branches", () => {
    const byRoute = new Map<string, LiteralRouteBranch[]>();

    for (const branch of literalRouteBranches(brokerHttpRouterSource())) {
      const key = `${branch.method} ${branch.path}`;
      byRoute.set(key, [...(byRoute.get(key) ?? []), branch]);
    }

    const duplicates = [...byRoute.entries()]
      .filter(([, branches]) => branches.length > 1)
      .map(([route, branches]) => `${route} at lines ${branches.map((branch) => branch.line).join(", ")}`);

    expect(duplicates).toEqual([]);
  });

  test("checked-in inventory stays sorted for readable diffs", () => {
    expect(expectedRouteInventory).toEqual([...expectedRouteInventory].sort());
  });

  test("matches the checked-in route inventory snapshot", () => {
    expect(liveRouteInventory()).toEqual(expectedRouteInventory);
  });

  test("binds enrolled mesh requests to both the peer identity and durable TLS pin", () => {
    const daemon = routerSource("broker-daemon.ts");
    expect(daemon).toContain("expectedPeerKeyId:");
    expect(daemon).toContain("expectedPeerTlsPin:");
  });

  test("every scoutBrokerPaths entry points at a live route", () => {
    const livePaths = new Set(
      liveRouteInventory().map((route) => route.split(" ")[1]),
    );
    const clientPaths = [scoutBrokerPaths.health, ...Object.values(scoutBrokerPaths.v1)];

    const dead = clientPaths.filter((path) => !livePaths.has(path));
    expect(dead).toEqual([]);
  });

  // Mesh trust cone §4 (deny by default): a route without a declared tier in
  // mesh-route-matrix.ts fails here, so new routes are authenticated by
  // construction. Matrix entries map 1:1 to live routes; the only exemption
  // is the /trpc WebSocket upgrade, which bypasses the HTTP router and is
  // gated at the server upgrade edge instead.
  test("every live route has a mesh route matrix tier, and the matrix has no dead entries", () => {
    const matrix = meshRouteMatrixEntries();
    const live = liveRouteInventory();

    const missing = live.filter((route) => !(route in matrix));
    expect(missing).toEqual([]);

    const dead = Object.keys(matrix).filter(
      (route) => route !== TRPC_UPGRADE_ROUTE && !live.includes(route),
    );
    expect(dead).toEqual([]);

    // exactly one tier per route, always a known tier
    for (const [route, tier] of Object.entries(matrix)) {
      expect(MESH_ROUTE_TIERS, route).toContain(tier);
    }
    expect(Object.keys(matrix)).toHaveLength(live.length + 1);
  });
});
