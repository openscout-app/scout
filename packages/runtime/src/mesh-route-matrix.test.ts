import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { delegatedRouteInventory } from "./broker-route-inventory.js";
import {
  compileMeshRouteMatrix,
  grantSatisfiesRouteTier,
  meshRouteMatrixEntries,
  meshRouteTierFor,
  MESH_ROUTE_TIERS,
  TRPC_UPGRADE_ROUTE,
  type MeshRouteTier,
} from "./mesh-route-matrix.js";

function liveRouteInventory(): string[] {
  return delegatedRouteInventory(file => readFileSync(join(import.meta.dir, file), "utf8")).routes;
}

// GET routes that mutate broker state — they must never be readable by a
// remote observe-tier peer, regardless of method.
const MUTATING_GET_ROUTES = ["GET /v1/repo-watch/warm", "GET /v1/request-receipts/:id"];

describe("mesh route matrix", () => {
  test("classifies every inventory route exactly once, with a known tier", () => {
    const matrix = meshRouteMatrixEntries();
    const live = liveRouteInventory();

    expect(live.filter((route) => !(route in matrix))).toEqual([]);
    // matrix keys are unique by construction (a record); every value is a
    // declared tier, and non-inventory entries are only the WS upgrade gate
    expect(Object.keys(matrix)).toHaveLength(live.length + 1);
    for (const tier of Object.values(matrix)) {
      expect(MESH_ROUTE_TIERS).toContain(tier);
    }
    expect(Object.keys(matrix).filter((route) => !live.includes(route))).toEqual([TRPC_UPGRADE_ROUTE]);
  });

  // Remove only the eight newly explicit registrations to reconstruct the
  // previous policy with the same lookup algorithm, including parameter matching.
  const newlyRegistered = [
    "GET /v1/attachments/capability", "POST /v1/attachments/read",
    "POST /v1/messages/with-attachments", "GET /v1/history/records",
    "GET /v1/history/records/:kind/:id", "GET /v1/quarantine",
    "GET /v1/quarantine/:id", "POST /v1/quarantine/:id/acknowledge",
  ];
  for (const route of newlyRegistered) {
    test(`registration preserves the previous default-local tier: ${route}`, () => {
      const matrix = meshRouteMatrixEntries();
      const previous = { ...matrix };
      for (const added of newlyRegistered) delete previous[added];
      const before = compileMeshRouteMatrix(previous);
      const [method, pattern] = route.split(" ");
      const path = pattern!.replace(/:[^/]+/g, "sample");
      expect(previous[route]).toBeUndefined();
      expect(before(method!, path)).toBe("local");
      expect(matrix[route]).toBe("local");
      expect(meshRouteTierFor(method!, path)).toBe(before(method!, path));
      expect(grantSatisfiesRouteTier("control", meshRouteTierFor(method!, path))).toBe(false);
    });
  }

  test("the public surface is exactly node card, enrollment handshake and bounded signed-policy carriage", () => {
    const publicRoutes = Object.entries(meshRouteMatrixEntries())
      .filter(([, tier]) => tier === "public")
      .map(([route]) => route)
      .sort();
    expect(publicRoutes).toEqual([
      "GET /v1/node",
      "POST /v1/access/policy",
      "POST /v1/trust/enroll/begin",
      "POST /v1/trust/enroll/reveal",
    ]);
  });

  test("observe-tier routes are read-only methods", () => {
    for (const [route, tier] of Object.entries(meshRouteMatrixEntries())) {
      if (tier !== "observe") continue;
      const method = route.split(" ")[0];
      expect(method === "GET" || method === "HEAD", `${route} is observe but ${method}`).toBe(true);
    }
  });

  test("mutating GET routes are never observe-tier", () => {
    for (const route of MUTATING_GET_ROUTES) {
      const [method, path] = route.split(" ", 2);
      expect(meshRouteTierFor(method!, path!), `${route} must not be observe`).not.toBe("observe");
      expect(meshRouteTierFor(method!, path!), `${route} stays local`).toBe("local");
    }
  });

  test("T3 integration actions are explicitly local and cannot be reached with peer grants", () => {
    expect(meshRouteMatrixEntries()["POST /v1/integrations/t3/:id"]).toBe("local");
    for (const action of ["inspect", "board", "refresh", "attach", "run"]) {
      const tier = meshRouteTierFor("POST", `/v1/integrations/t3/${action}`);
      expect(tier).toBe("local");
      expect(grantSatisfiesRouteTier("observe", tier)).toBe(false);
      expect(grantSatisfiesRouteTier("control", tier)).toBe(false);
    }
  });

  test("permission decisions, request dismissals and receipt recovery remain machine-local", () => {
    expect(meshRouteTierFor("POST", "/v1/permissions/decide")).toBe("local");
    expect(meshRouteTierFor("POST", "/v1/operator-requests/dismiss")).toBe("local");
    expect(meshRouteTierFor("GET", "/v1/request-receipts/request-1")).toBe("local");
  });

  test("supervision handoff discovery is explicitly local and cannot be reached with peer grants", () => {
    expect(meshRouteMatrixEntries()["GET /v1/supervision-handoff"]).toBe("local");
    const tier = meshRouteTierFor("GET", "/v1/supervision-handoff");
    expect(tier).toBe("local");
    expect(grantSatisfiesRouteTier("observe", tier)).toBe(false);
    expect(grantSatisfiesRouteTier("control", tier)).toBe(false);
  });

  test("runtime lookup resolves parameterized routes and denies unknown routes by default", () => {
    expect(meshRouteTierFor("GET", "/v1/mesh/nodes")).toBe("observe");
    expect(meshRouteTierFor("GET", "/v1/mesh/snapshot")).toBe("observe");
    expect(meshRouteTierFor("GET", "/v1/mesh/invocations/inv-123/stream")).toBe("observe");
    expect(meshRouteTierFor("POST", "/v1/mesh/aliases/resolve")).toBe("control");
    expect(meshRouteTierFor("POST", "/v1/mesh/messages")).toBe("control");
    expect(meshRouteTierFor("GET", "/trpc")).toBe("control");
    expect(meshRouteTierFor("get", "/v1/node")).toBe("public");
    expect(meshRouteTierFor("GET", "/v1/invocations/inv-123")).toBe("local");
    expect(meshRouteTierFor("GET", "/v1/invocations/inv-123/lifecycle")).toBe("local");
    expect(meshRouteTierFor("DELETE", "/v1/aliases/alias-1")).toBe("local");
    // unknown / unmapped routes fall back to local (deny by default)
    expect(meshRouteTierFor("GET", "/v1/does-not-exist")).toBe("local");
    expect(meshRouteTierFor("POST", "/")).toBe("local");
    // parameterized prefixes must not over-match sibling paths
    expect(meshRouteTierFor("GET", "/v1/invocations")).toBe("local");
    expect(meshRouteTierFor("GET", "/v1/invocations/a/b/lifecycle")).toBe("local");
  });

  test("grant tier satisfaction: local is never satisfiable, control covers observe", () => {
    expect(grantSatisfiesRouteTier("observe", "observe")).toBe(true);
    expect(grantSatisfiesRouteTier("control", "observe")).toBe(true);
    expect(grantSatisfiesRouteTier("observe", "control")).toBe(false);
    expect(grantSatisfiesRouteTier("control", "control")).toBe(true);
    expect(grantSatisfiesRouteTier("control", "local")).toBe(false);
    expect(grantSatisfiesRouteTier("observe", "local")).toBe(false);
    expect(grantSatisfiesRouteTier("observe", "public")).toBe(true);
    expect(grantSatisfiesRouteTier("control", "public")).toBe(true);
  });

  test("tier counts reflect the P1 posture: almost everything local", () => {
    const counts = new Map<MeshRouteTier, number>();
    for (const tier of Object.values(meshRouteMatrixEntries())) {
      counts.set(tier, (counts.get(tier) ?? 0) + 1);
    }
    expect(counts.get("public")).toBe(4);
    expect(counts.get("observe")).toBe(4); // nodes, node-state, snapshot and invocation-stream
    expect(counts.get("control")).toBe(13); // 10 mesh POST routes + the /trpc upgrade + approvals stream/decide
    expect(counts.get("guest")).toBe(9); // discovery, asks, and five mailbox routes
    expect(counts.get("scoped")).toBe(1);
    expect(counts.get("local")).toBe(Object.keys(meshRouteMatrixEntries()).length - 31);
  });
});
