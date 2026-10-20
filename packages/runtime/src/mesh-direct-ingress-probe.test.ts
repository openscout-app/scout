import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { request } from "node:https";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

import { createMeshIngressGate, classifyMeshTransport } from "./mesh-ingress-gate.js";
import { PeerNonceCache } from "./mesh-peer-auth.js";
import { buildSignedNodeCard, loadOrCreateNodeIdentity, nodeKeyId } from "./node-identity.js";
import { loadOrCreateTlsIdentity } from "./node-tls-identity.js";

const address = Object.values(networkInterfaces()).flat().find((entry) => entry && !entry.internal && entry.family === "IPv4")?.address;

// This uses the machine's own non-loopback address and an ephemeral test TLS
// listener, not the installed runtime or Tailscale. No remote-address mocking:
// a loopback-only fixture would not exercise the verified direct-ingress probe.
for (const mode of ["verify-warn", "enforce"] as const) {
  test.skipIf(!address)(`direct off-loopback TLS probe stays public/peer/local in ${mode}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-ingress-probe-"));
    const identity = loadOrCreateNodeIdentity(dir);
    const tls = await loadOrCreateTlsIdentity(dir, { algorithm: "ec-p256" });
    const dispatched: string[] = [];
    const transports: string[] = [];
    const server = createServer({ key: tls.keyPair.privateKey.export({ type: "pkcs8", format: "pem" }) as string, cert: tls.certificatePem });
    const gate = createMeshIngressGate({ mode, destinationKeyId: nodeKeyId(identity.publicKey),
      bootedAt: Date.now() - 60_000, lookupPeer: () => undefined, nonceClaim: new PeerNonceCache(),
      // Same live-listener condition used by the broker's bind controller.
      forceRemoteEnforce: () => server.listening, logger: { warn() {} } });
    server.on("request", (req, res) => {
      transports.push(classifyMeshTransport(req.socket.remoteAddress));
      void gate.gateHttpRequest(req, res, async () => {
        dispatched.push(req.url!);
        const card = buildSignedNodeCard(identity, { nodeId: "probe", label: "Probe fixture", version: "test", capabilities: [], endpoints: [], tls: { spkiFingerprint: tls.spkiFingerprint } });
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ card }));
      });
    });
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, address!, resolve); });
      const port = (server.address() as { port: number }).port;
      const get = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => {
        const req = request({ host: address, port, path, headers,
          // Trust only this fixture certificate; it has no interface-IP SAN.
          ca: tls.certificatePem, checkServerIdentity: () => undefined,
        }, (res) => {
          let body = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => { try { resolve({ status: res.statusCode!, body: JSON.parse(body) }); } catch (error) { reject(error); } });
        });
        req.setTimeout(3000, () => req.destroy(new Error("probe timed out"))); req.on("error", reject); req.end();
      });
      const node = await get("/v1/node");
      expect(node.status).toBe(200); expect(node.body.card.keyId).toBe(nodeKeyId(identity.publicKey));
      for (const path of ["/v1/mesh/nodes", "/v1/mesh/snapshot"]) {
        const reply = await get(path);
        expect(reply.status).toBe(401); expect(reply.body.detail).toBe("missing peer auth headers");
      }
      for (const path of ["/v1/snapshot", "/v1/agents", "/health", "/v1/guest-grants", "/v1/unknown-local-route"]) {
        const reply = await get(path);
        expect(reply.status).toBe(403); expect(reply.body.detail).toBe("route is local-only");
      }
      // Forged forwarding metadata cannot turn a remote socket into local trust.
      expect((await get("/health", { "x-forwarded-for": "127.0.0.1" })).status).toBe(403);
      expect((await get("/v1/mesh/nodes", { "x-forwarded-for": "127.0.0.1" })).status).toBe(401);
      expect(dispatched).toEqual(["/v1/node"]);
      expect(transports).toHaveLength(10); expect(transports.every((transport) => transport === "remote")).toBe(true);
    } finally {
      await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
}
