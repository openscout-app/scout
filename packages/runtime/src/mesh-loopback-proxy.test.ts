import { afterEach, describe, expect, test } from "bun:test";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import { refusesLoopbackHttpProxy } from "./mesh-loopback-proxy.js";
import { createMeshIngressGate } from "./mesh-ingress-gate.js";
import { signLocalAdminRequest } from "./mesh-access-local-auth.js";
import { PeerNonceCache } from "./mesh-peer-auth.js";
import { requestScoutBrokerJson } from "./broker-api.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function runtime(mode: "verify-warn" | "enforce" = "verify-warn", localAdminKey?: string) {
  let handled = 0;
  const gate = createMeshIngressGate({ mode, destinationKeyId: "b".repeat(64),
    localAdminKey, bootedAt: Date.now() - 60_000, lookupPeer: () => undefined,
    nonceClaim: new PeerNonceCache(), logger: { warn() {} } });
  const server = createServer((req, res) => { void gate.gateHttpRequest(req, res, async () => {
    handled++; res.setHeader("content-type", "application/json"); res.end('{"ok":true}');
  }); });
  server.on("upgrade", (req, socket) => {
    if (gate.gateUpgrade(req, socket)) {
      handled++; socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: close\r\n\r\n");
    }
  });
  return { gate, url: await listen(server), handled: () => handled };
}
// Mirrors addProxyForwardedHeaders + addTailscaleIdentityHeaders from pinned
// Tailscale source linked in docs/runtime-proxy-refusal.md. Tagged nodes have
// no user identity headers; HTTP Serve has no X-Forwarded-Proto.
const profiles: Record<string, Record<string, string>> = {
  "HTTPS Serve user": { "x-forwarded-host": "node.example.ts.net", "x-forwarded-for": "100.64.0.2", "x-forwarded-proto": "https", "tailscale-user-login": "guest@example.invalid", "tailscale-headers-info": "https://tailscale.com/s/serve-headers" },
  "HTTP Serve tagged node": { "x-forwarded-host": "node.example.ts.net", "x-forwarded-for": "100.64.0.2" },
  "HTTPS Funnel": { "x-forwarded-host": "node.example.ts.net", "x-forwarded-for": "198.51.100.2", "x-forwarded-proto": "https", "tailscale-funnel-request": "?1" },
};
async function proxy(target: string, headers: IncomingHttpHeaders): Promise<string> {
  return listen(createServer((req, res) => {
    const upstream = httpRequest(new URL(req.url ?? "/", target), { method: req.method, headers }, (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(res);
    });
    upstream.on("error", () => { res.writeHead(502).end(); }); req.pipe(upstream);
  }));
}

describe("loopback proxy refusal", () => {
  for (const mode of ["verify-warn", "enforce"] as const) {
    for (const [name, headers] of Object.entries(profiles)) {
      test(`${name} cannot inherit loopback authority in ${mode}`, async () => {
        const f = await runtime(mode), relay = await proxy(f.url, headers);
        for (const path of ["/health", "/v1/snapshot", "/v1/guest-grants", "/v1/node"]) {
          const response = await fetch(relay + path);
          expect(response.status).toBe(403);
          expect(await response.json()).toMatchObject({ error: "loopback_proxy_refused" });
        }
        expect(f.handled()).toBe(0);
        expect((await fetch(f.url + "/health")).status).toBe(200);
      });
    }
  }
  test("even empty or mixed-case proxy evidence denies rather than authenticates", async () => {
    const f = await runtime();
    for (const headers of [{ "X-Forwarded-Host": "" }, { Forwarded: 'for="198.51.100.2"' }, { "Tailscale-Funnel-Request": "?0" }, { "Tailscale-App-Capabilities": "{}" }]) {
      expect((await fetch(f.url + "/v1/commands", { method: "POST", headers, body: "{}" })).status).toBe(403);
    }
    expect(f.handled()).toBe(0);
  });
  test("the web server's fresh broker client headers still reach local HTTP", async () => {
    const f = await runtime();
    // The web broker service uses requestScoutBrokerJson with no inbound
    // browser headers; it passes only socketPath/signal or method/body.
    expect(await requestScoutBrokerJson(f.url, "/health")).toEqual({ ok: true });
    expect(await requestScoutBrokerJson(f.url, "/v1/commands", { method: "POST", body: {} })).toEqual({ ok: true });
    expect(f.handled()).toBe(2);
  });
  test("WebSocket proxy evidence is refused before an upgrade", async () => {
    const f = await runtime();
    let reply = "";
    const socket = { remoteAddress: "127.0.0.1", end: (data: string) => { reply += data; } } as unknown as Duplex;
    const request = { method: "GET", url: "/trpc", headers: { "x-forwarded-host": "node.example.ts.net" } } as IncomingMessage;
    expect(f.gate.gateUpgrade(request, socket)).toBe(false);
    expect(reply).toContain("403 Forbidden"); expect(f.handled()).toBe(0);
  });
});

test("forwarding evidence cannot grant remote authority and also restricts Unix sockets", () => {
  expect(refusesLoopbackHttpProxy("remote", { "x-forwarded-for": "127.0.0.1" })).toBe(false);
  expect(refusesLoopbackHttpProxy("unix-socket", { "X-Forwarded-Host": "" })).toBe(true);
  expect(refusesLoopbackHttpProxy("loopback", { accept: "application/json" })).toBe(false);
});
test("valid local admin proof cannot override proxy refusal", async () => {
  const key = "a".repeat(64), f = await runtime("enforce", key);
  const headers = signLocalAdminRequest(key, { method: "GET", path: "/health", destinationKeyId: "b".repeat(64) });
  expect((await fetch(f.url + "/health", { headers })).status).toBe(200);
  const response = await fetch(f.url + "/health", { headers: { ...headers, "x-forwarded-host": "node.example.ts.net" } });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: "loopback_proxy_refused" });
});
