import { PairingTrustError } from "@openscout/runtime/pairing-security";
import type { Context, Hono } from "hono";
import {
  controlScoutWebPairingService,
  decideHostPairingRequest,
  controlScoutWebApprovalPairing,
  removeScoutPairingTrustedPeer,
  type ScoutPairingControlAction,
} from "../pairing.ts";
import {
  PairRequestCapacityError,
  pairRequesterDisplay,
  parseScoutPairClient,
  SCOUT_PAIR_CLIENT_HEADER,
  SCOUT_PAIR_PUBLIC_KEY_HEADER,
  parseScoutPairPublicKey,
  SCOUT_PAIR_RELAY_HEADER,
} from "../pairing-pair-requests.ts";
import { isLoopbackScoutAddress, isSameMacScoutRequest, resolveScoutRequestPeerAddress } from "../pairing-request-trust.ts";
import { pairingDeepLinks, SCOUT_PAIRING_DEEP_LINK_PATH, SCOUT_PAIRING_DEEP_LINK_SCHEME } from "../shared/pairing-link.js";
import { loadPairingState } from "../pairing-state.ts";
import { pairingControlBody } from "../shared/api/pairing.ts";
import { readJsonBody } from "../request-body.ts";
import type { PendingPairRequestStore } from "../pairing-pair-requests.ts";

function pairingQrValueWithWebPort(
  qrValue: string | null | undefined,
  webPort: number | undefined,
): string | undefined {
  const payload = typeof qrValue === "string" ? qrValue.trim() : "";
  if (!payload) return undefined;
  const normalizedWebPort = normalizePairingWebPort(webPort);
  if (normalizedWebPort === null) return qrValue ?? undefined;

  try {
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return qrValue ?? undefined;
    }
    return JSON.stringify({ ...parsed, webPort: normalizedWebPort });
  } catch {
    return qrValue ?? undefined;
  }
}

function normalizePairingWebPort(value: number | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65_535
    ? value
    : null;
}

export type PairingRouteDeps = {
  options: { resolvePeerAddress?: (c: Context) => string | undefined; webPort?: number };
  currentDirectory: string;
  pendingPairRequests: PendingPairRequestStore;
  shellStateCache: { invalidate: () => void };
};

export function mountPairingRoutes(app: Hono, deps: PairingRouteDeps) {
  const { currentDirectory, options, pendingPairRequests, shellStateCache } = deps;

  app.get("/api/pairing-state", async (c) =>
    c.json(await loadPairingState(currentDirectory, false)),
  );
  app.get("/api/pairing-state/refresh", async (c) =>
    c.json(await loadPairingState(currentDirectory, true)),
  );
  const pickPairingQrLocation = (qrValue: string | null | undefined, route: string | null): string | null => {
    const links = pairingDeepLinks(pairingQrValueWithWebPort(qrValue, options.webPort));
    return route === "lan"
      ? links.lan ?? links.default
      : route === "ts" || route === "tsn" || route === "tailnet"
        ? links.tailnet ?? links.default
        : links.default;
  };
  // GET /pair is the phone's LAN knock. It is not operator login: the Mac
  // identifies the connecting app, then allow/deny. Do not put this behind
  // the web session cookie.
  app.get(`/${SCOUT_PAIRING_DEEP_LINK_PATH}`, async (c) => {
    c.header("cache-control", "no-store");
    const route = c.req.query("route")?.trim().toLowerCase() ?? null;
    // Only the trusted account-admission callback may create an account row.
    if (route === "account") return c.json({ error: "Account requests require an encrypted account connection" }, 400);
    const token = c.req.query("token")?.trim() || null;
    const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
    const peerAddress = (options.resolvePeerAddress ?? resolveScoutRequestPeerAddress)(c);
    const xff = c.req.header("x-forwarded-for");
    const forwardedIp = (xff ? xff.split(",").at(-1)?.trim() : null)
      || c.req.header("x-real-ip")?.trim()
      || null;
    const loopbackPeer = Boolean(peerAddress && isLoopbackScoutAddress(peerAddress));
    const sameMacRequest = isSameMacScoutRequest(c.req.raw, peerAddress);
    const relayedLanRequest = Boolean(
      loopbackPeer
      && c.req.header(SCOUT_PAIR_RELAY_HEADER) === "1",
    );
    const directLanRequest = Boolean(peerAddress && !isLoopbackScoutAddress(peerAddress));
    // A local reverse proxy is still carrying the browser's identity. The
    // shared same-Mac classifier accepts this Mac's own interface addresses,
    // while remote, malformed, or multi-hop forwarding stays approval-gated.
    const proxiedLanRequest = Boolean(
      loopbackPeer
      && !relayedLanRequest
      && !sameMacRequest,
    );
    const unidentifiedPairingIngress = !peerAddress;
    const requiresApproval = relayedLanRequest
      || directLanRequest
      || proxiedLanRequest
      || unidentifiedPairingIngress;
    const requesterApp = parseScoutPairClient(
      c.req.header(SCOUT_PAIR_CLIENT_HEADER),
      c.req.header("user-agent"),
    );

    // `/pair` is unauthenticated and polled frequently. Use the coalesced
    // reader so LAN traffic cannot force filesystem/process discovery work on
    // every request; the phone already tolerates this short refresh window.
    const state = await loadPairingState(currentDirectory, false);
    const location = pickPairingQrLocation(state.pairing?.qrValue, route);

    // A polling token is a bearer credential for one operator decision. Check
    // that decision before considering the live payload, and make the approved
    // check + one-time consumption one atomic store transition.
    if (token) {
      const request = pendingPairRequests.get(token);
      if (!request) {
        return wantsJson
          ? c.json({ status: "expired", token }, 410)
          : c.text("Pairing request expired.", 410);
      }
      if (request.route === "account") {
        return c.json({ error: "Account admission is completed on its encrypted connection" }, 400);
      }
      if (request.status === "denied") {
        return wantsJson
          ? c.json({ status: "denied", token }, 403)
          : c.text("Pairing request was denied.", 403);
      }
      const invitation = request.status === "approved"
        ? await controlScoutWebApprovalPairing("read", request, currentDirectory).catch(() => null)
        : null;
      // Spent is known only within the controller's current lifetime. Do not
      // touch this request into an endless approved poll or persist that hint.
      if (invitation && "status" in invitation && invitation.status === "spent") {
        return wantsJson
          ? c.json({ status: "expired", token }, 410)
          : c.text("Pairing request expired.", 410);
      }
      const requestLocation = invitation && "payload" in invitation
        ? pickPairingQrLocation(JSON.stringify(invitation.payload), route) : null;
      if (requestLocation && request.status === "approved") {
        if (!pendingPairRequests.fulfill(token, "approved")) {
          // A consume that cannot win the shared CAS fails closed without
          // deleting the request. Keep an approved device polling; if a peer
          // won with a denial or delivery, reflect that terminal state instead.
          const current = pendingPairRequests.get(token);
          if (current?.status === "approved" || current?.status === "pending") {
            return c.json({ status: current.status, token, pollAfterMs: 1200 }, 202);
          }
          if (current?.status === "denied") {
            return wantsJson
              ? c.json({ status: "denied", token }, 403)
              : c.text("Pairing request was denied.", 403);
          }
          return wantsJson
            ? c.json({ status: "expired", token }, 410)
            : c.text("Pairing request expired.", 410);
        }
        return c.redirect(requestLocation, 302);
      }
      // pending, or approved but the relay payload isn't up yet — keep polling.
      // Touch so an actively-polling device doesn't age out mid-approval.
      pendingPairRequests.touch(token);
      return c.json({ status: request.status, token, pollAfterMs: 1200 }, 202);
    }

    // Same-Mac browser flows may still use the existing live-payload fast path.
    // A direct LAN peer or the narrow relay ingress always needs an approved
    // token, even while some other pairing session is already live.
    if (location && !requiresApproval) {
      return c.redirect(location, 302);
    }

    // First contact from an unpaired device — register an approval request.
    const requesterIp = unidentifiedPairingIngress
      ? null
      : relayedLanRequest || proxiedLanRequest
        ? forwardedIp
        : directLanRequest
          ? peerAddress ?? null
          : forwardedIp;
    if (requiresApproval && !requesterIp) {
      return wantsJson
        ? c.json({ status: "unavailable" }, 503)
        : c.text("Unable to identify pairing requester.", 503);
    }

    let requesterPublicKey: string | null;
    try { requesterPublicKey = parseScoutPairPublicKey(c.req.header(SCOUT_PAIR_PUBLIC_KEY_HEADER)); }
    catch { return c.json({ error: "Expected a full Noise public key" }, 400); }
    let request: ReturnType<typeof pendingPairRequests.create>;
    try {
      request = pendingPairRequests.create({
        requesterIp,
        requesterPublicKey,
        requesterLabel: c.req.header("x-scout-device-name")?.trim() || null,
        requesterApp,
        route,
      });
    } catch (error) {
      if (!(error instanceof PairRequestCapacityError)) throw error;
      c.header("retry-after", String(Math.ceil(error.retryAfterMs / 1000)));
      return wantsJson
        ? c.json({ status: "busy", retryAfterMs: error.retryAfterMs }, 429)
        : c.text("Too many pairing requests. Try again shortly.", 429);
    }
    if (request.status === "denied") {
      return wantsJson
        ? c.json({ status: "denied", token: request.token }, 403)
        : c.text("Pairing request was denied.", 403);
    }
    return wantsJson
      ? c.json({ status: request.status, token: request.token, pollAfterMs: 1200 }, 202)
      : c.text(
          `${SCOUT_PAIRING_DEEP_LINK_SCHEME}://${SCOUT_PAIRING_DEEP_LINK_PATH} pairing requires approval on the Mac.`,
          202,
        );
  });
  app.get("/api/notifications", (c) => {
    const rawType = c.req.query("type") ?? "";
    const requestedTypes = new Set(
      rawType
        .split(",")
        .map((type) => type.trim())
        .filter(Boolean),
    );
    const includePairingRequests =
      requestedTypes.size === 0 || requestedTypes.has("pairing_request");
    const notifications = includePairingRequests
      ? pendingPairRequests.list()
        .filter((request) => request.status === "pending")
        .map((request) => ({
          id: `pairing_request:${request.token}`,
          type: "pairing_request",
          title: `${pairRequesterDisplay(request)} wants to pair`,
          body: request.route === "account" ? "Through your account. Allow only devices you recognize."
            : `On your network${request.requesterIp ? ` · ${request.requesterIp}` : ""}.`,
          createdAt: request.createdAt,
          updatedAt: request.updatedAt,
          expiresAt: request.expiresAt,
          data: { request },
        }))
      : [];
    return c.json({ notifications });
  });
  app.get("/api/pairing/requests", (c) =>
    c.json({ requests: pendingPairRequests.list() }),
  );
  app.post("/api/pairing/requests/:token/decide", async (c) => {
    const token = c.req.param("token");
    const body = (await c.req.json().catch(() => ({}))) as { decision?: string };
    const decision =
      body.decision === "approve" ? "approve"
      : body.decision === "deny" ? "deny"
      : null;
    if (!decision) {
      return c.json({ error: "decision must be 'approve' or 'deny'" }, 400);
    }
    const result = await decideHostPairingRequest(pendingPairRequests, token, decision, currentDirectory);
    shellStateCache.invalidate();
    return result.ok ? c.json({ request: result.request }) : c.json({ error: result.error }, result.status);
  });

  app.post("/api/pairing/control", async (c) => {
    const parsed = await readJsonBody(c, pairingControlBody);
    if (!parsed.ok) return parsed.response;
    const result = await controlScoutWebPairingService(
      parsed.body.action satisfies ScoutPairingControlAction,
      currentDirectory,
    );
    shellStateCache.invalidate();
    return c.json(result);
  });
  app.delete("/api/pairing/peers/:fingerprint", async (c) => {
    const fingerprint = c.req.param("fingerprint");
    try {
      const removed = removeScoutPairingTrustedPeer(fingerprint);
      if (!removed) return c.json({ error: "Peer not found" }, 404);
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof PairingTrustError && error.code === "ambiguous_prefix") {
        return c.json({ error: "Peer prefix is ambiguous; use the full public key" }, 409);
      }
      return c.json({ error: "Pairing trust store is unavailable" }, 503);
    }
  });
}
