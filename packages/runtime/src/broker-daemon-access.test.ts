import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { signScopedPeerRequest, signPeerRequest } from "./mesh-peer-auth.js";
import { nodeFingerprint, nodeKeyId } from "./node-identity.js";
import { signAccessArtifact, type AccessGrant, type AccessPolicy, type AccessDelegation, type AccessRevocation } from "./mesh-access.js";
import { accessTestFixture, accessTestKey } from "./test-helpers/access-fixture.test.ts";
import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test";
const broker = createBrokerDaemonTestHarness();

test("scoped signed daemon roundtrip: no discovery leaks, no message wake, owned work, revocation and legacy bypass denial", async () => {
  const h = await broker.startBroker({ protectedLocal: true, env: { OPENSCOUT_MESH_GATE: "enforce" } });
  await broker.seedBasicConversation(h);
  const node = await broker.getJson<{ card: { keyId: string; capabilities: string[] } }>(h.baseUrl, "/v1/node");
  expect(node.card.capabilities).toContain("scout-access/1");
  const relayed = await fetch(h.baseUrl + "/v1/snapshot", { headers: { "x-forwarded-for": "127.0.0.1", "x-openscout-local-admin": "wrong" } });
  expect(relayed.status).toBe(403);
  expect(await relayed.json()).toMatchObject({ error: "loopback_proxy_refused" });
  // Preserve the original malformed-admin-proof denial independently of the
  // proxy rule, which now takes precedence when forwarding evidence exists.
  const invalidAdmin = await fetch(h.baseUrl + "/v1/snapshot", { headers: { "x-openscout-local-admin": "wrong" } });
  expect(invalidAdmin.status).toBe(401);
  const legacyProxy = await fetch(h.baseUrl + "/v1/mesh/web-request", { method: "POST", body: "{}" });
  expect(legacyProxy.status).toBe(401);
  const f = accessTestFixture(node.card.keyId);
  const admin = (body: object) => broker.postJson<any>(h.baseUrl, "/v1/access/admin", body);
  await admin({ operation: "policy.import", artifact: f.policy });
  await admin({ operation: "resources.enroll", networkId: f.policy.networkId, agentIds: ["fabric"], projects: [] });
  await admin({ operation: "grant.import", artifact: f.grant });
  async function rpc(payload: object, legacy = false) {
    const path = "/v1/access/rpc", body = JSON.stringify({ delegation: f.delegation, ...payload });
    const response = await fetch(h.baseUrl + path, { method: "POST", body, headers: { "content-type": "application/json",
      ...(legacy ? signPeerRequest(f.device, { method: "POST", path, body, destinationKeyId: node.card.keyId })
        : signScopedPeerRequest(f.device, { method: "POST", path, body, destinationKeyId: node.card.keyId, delegation: f.delegation })) } });
    return { status: response.status, body: await response.json() as any };
  }
  expect((await rpc({ operation: "discover" }, true)).status).toBe(401);
  const discovery = await rpc({ operation: "discover" });
  expect(discovery.status).toBe(200);
  expect(discovery.body.agents.map((a: any) => a.id)).toEqual(["fabric"]);
  expect(JSON.stringify(discovery.body)).not.toContain("projectRoot");
  expect((await rpc({ operation: "request", requestId: "spoof-body-01", target: "fabric", body: "work", requesterId: "operator" })).status).toBe(400);
  const outside = await rpc({ operation: "request", requestId: "outside-01", target: "missing", body: "work" });
  const hidden = await rpc({ operation: "request", requestId: "outside-02", target: "operator", body: "work" });
  expect(outside.status).toBe(404); expect(hidden).toEqual(outside);
  const message = { operation: "message", requestId: "message-01", target: "fabric", body: "FYI @secret do not dispatch this as work" };
  const sent = await rpc(message); expect(sent.status).toBe(202);
  const retried = await rpc(message); expect(retried.status).toBe(202); expect(retried.body.duplicate).toBe(true);
  const snapshot = await broker.getJson<any>(h.baseUrl, "/v1/snapshot");
  expect(Object.values(snapshot.invocations).filter((i: any) => i.metadata?.source === "scout-access/1")).toHaveLength(0);
  const recorded = snapshot.messages[sent.body.messageId];
  expect(recorded.audience.delivery).toBe("none"); expect(recorded.metadata.wake).toBe("never"); expect(recorded.mentions).toEqual([]);
  const deliveries = await broker.getJson<any>(h.baseUrl, "/v1/deliveries");
  expect(JSON.stringify(deliveries)).not.toContain(sent.body.messageId);
  await broker.seedHangingReceiver(h, "fabric");
  const accepted = await rpc({ operation: "request", requestId: "request-01", target: "fabric", body: "Inspect this input" });
  expect(accepted.status).toBe(202);
  const withWork = await broker.getJson<any>(h.baseUrl, "/v1/snapshot");
  const invocation = withWork.invocations[accepted.body.invocationId];
  expect(invocation.requesterId).toBe(`principal.${f.subject.id}`);
  await broker.postJson(h.baseUrl, "/v1/messages", { id: "scoped-reply", conversationId: invocation.conversationId,
    actorId: "fabric", originNodeId: h.nodeId, class: "agent", body: "Result from allowed work", replyToMessageId: invocation.messageId,
    audience: { notify: [invocation.requesterId], reason: "thread_reply" }, visibility: "private", policy: "durable", createdAt: Date.now() });
  const result = await rpc({ operation: "result", requestId: "request-01" });
  expect(result.status).toBe(200); expect(result.body.output).toBe("Result from allowed work");
  expect((await rpc({ operation: "result", requestId: "unowned-01" })).status).toBe(404);
  for (const path of ["/v1/snapshot", "/v1/mesh/snapshot", "/v1/mesh/web-request", "/v1/mesh/sessions/wake", "/v1/guest/agents", "/trpc"]) {
    const method = path.endsWith("web-request") || path.endsWith("wake") ? "POST" : "GET";
    const response = await fetch(h.baseUrl + path, { method, headers: signPeerRequest(f.device, { method, path, destinationKeyId: node.card.keyId }) });
    expect(response.status).toBe(403);
  }
  const legacyEnroll = await broker.postJsonStatus(h.baseUrl, "/v1/trust/grant", { keyId: nodeKeyId(f.device.publicKey), publicKey: f.device.publicKey, fingerprint: nodeFingerprint(f.device.publicKey), label: "Must reject", tier: "control" });
  expect(legacyEnroll.status).toBe(400);
  // An authorized owner in network A cannot use it as authority over network B.
  const foreign = accessTestFixture(node.card.keyId), ownerDevice = accessTestKey();
  await admin({ operation: "policy.import", artifact: foreign.policy });
  const { signature: _signature, ...unsignedDelegation } = f.delegation;
  const ownerDelegation = signAccessArtifact<AccessDelegation>(f.owner, { ...unsignedDelegation, id: "owner-device-01", principalId: f.policy.root.id, devicePublicKey: ownerDevice.publicKey });
  const { signature: _policySignature, ...foreignUnsigned } = foreign.policy;
  const foreignUpdate = signAccessArtifact<AccessPolicy>(foreign.owner, { ...foreignUnsigned, revision: 2 });
  const crossBody = JSON.stringify({ operation: "policy.import", delegation: ownerDelegation, artifact: foreignUpdate });
  const cross = await fetch(h.baseUrl + "/v1/access/rpc", { method: "POST", body: crossBody, headers: { "content-type": "application/json",
    ...signScopedPeerRequest(ownerDevice, { method: "POST", path: "/v1/access/rpc", body: crossBody, destinationKeyId: node.card.keyId, delegation: ownerDelegation }) } });
  expect(cross.status).toBe(403);
  // Public carriage can advance any already trusted root, but only its signed material.
  const submit = (artifact: unknown) => fetch(h.baseUrl + "/v1/access/policy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ artifact }) });
  expect((await submit({ ...foreignUpdate, signature: "invalid" })).status).toBe(400);
  expect((await submit(accessTestFixture(node.card.keyId).policy)).status).toBe(403);
  expect((await submit({ arbitrary: "unsigned" })).status).toBe(400);
  expect((await submit(foreignUpdate)).status).toBe(200);
  expect((await submit(foreign.policy)).status).toBe(409);
  const revocation = signAccessArtifact<AccessRevocation>(f.service, { protocol: "scout-access/1", kind: "revocation", networkId: f.policy.networkId,
    issuerId: f.subject.id, issuerPublicKey: f.service.publicKey, targetKind: "device", targetId: nodeKeyId(f.device.publicKey), issuedAt: Date.now() });
  const wrongOwner = signAccessArtifact<AccessRevocation>(f.owner, { protocol: "scout-access/1", kind: "revocation", networkId: f.policy.networkId,
    issuerId: f.policy.root.id, issuerPublicKey: f.owner.publicKey, targetKind: "device", targetId: nodeKeyId(f.device.publicKey), issuedAt: Date.now() });
  expect((await submit(wrongOwner)).status).toBe(200); // It revokes only the owner/device pair.
  expect((await rpc({ operation: "discover" })).status).toBe(200);
  expect((await submit(revocation)).status).toBe(200);
  expect((await rpc({ operation: "result", requestId: "request-01" })).status).toBe(403);
}, 25_000);

test("verify-warn broker refuses scoped activation and advertises no scoped capability", async () => {
  const h = await broker.startBroker({ env: { OPENSCOUT_MESH_GATE: "verify-warn" } });
  const f = accessTestFixture();
  const response = await fetch(h.baseUrl + "/v1/access/admin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "policy.import", artifact: f.policy }) });
  expect(response.status).toBe(409);
  const node = await broker.getJson<any>(h.baseUrl, "/v1/node");
  expect(node.card.capabilities).not.toContain("scout-access/1");
}, 15_000);

test("protected broker with unavailable access persistence advertises no scoped capability", async () => {
  const h = await broker.startBroker({ protectedLocal: true, env: { OPENSCOUT_DISABLE_SQLITE: "1", OPENSCOUT_MESH_GATE: "verify-warn" } });
  const node = await broker.getJson<any>(h.baseUrl, "/v1/node");
  expect(node.card.capabilities).not.toContain("scout-access/1");
  expect((await fetch(h.baseUrl + "/v1/snapshot")).status).toBe(403);
  expect((await broker.postJsonStatus(h.baseUrl, "/v1/access/admin", { operation: "status" })).status).toBe(503);
}, 15_000);

test("principal and legacy/guest credentials cannot be reused in either enrollment order", async () => {
  const h = await broker.startBroker({ protectedLocal: true, env: { OPENSCOUT_MESH_GATE: "enforce" } });
  await broker.seedBasicConversation(h);
  const node = await broker.getJson<{ card: { keyId: string } }>(h.baseUrl, "/v1/node");
  const admin = (body: object) => broker.postJsonStatus(h.baseUrl, "/v1/access/admin", body);
  const trust = (f: ReturnType<typeof accessTestFixture>) => broker.postJsonStatus(h.baseUrl, "/v1/trust/grant", {
    keyId: f.subject.id, publicKey: f.service.publicKey, fingerprint: nodeFingerprint(f.service.publicKey), label: "Existing peer", tier: "control",
  });
  const guest = (f: ReturnType<typeof accessTestFixture>, id: string) => broker.postJsonStatus(h.baseUrl, "/v1/guest-grants", {
    requestId: id, clientPublicKey: f.service.publicKey, label: "Guest", allowedTargets: ["fabric"],
  });
  const legacy = accessTestFixture(node.card.keyId);
  expect((await trust(legacy)).status).toBe(200);
  expect((await admin({ operation: "policy.import", artifact: legacy.policy })).status).toBe(403);
  await broker.postJson(h.baseUrl, "/v1/trust/revoke", { keyId: legacy.subject.id });
  expect((await admin({ operation: "policy.import", artifact: legacy.policy })).status).toBe(403);
  const guestFirst = accessTestFixture(node.card.keyId);
  expect((await guest(guestFirst, "guest-first")).status).toBe(200);
  expect((await admin({ operation: "policy.import", artifact: guestFirst.policy })).status).toBe(403);
  const principal = accessTestFixture(node.card.keyId);
  expect((await admin({ operation: "policy.import", artifact: principal.policy })).status).toBe(200);
  expect((await trust(principal)).status).toBe(400);
  expect((await guest(principal, "principal-reuse")).status).toBe(409);
  // Revoking scoped access never changes a distinct, already authorized legacy peer.
  const distinct = accessTestFixture(node.card.keyId);
  expect((await trust(distinct)).status).toBe(200);
  expect((await admin({ operation: "revoke", networkId: principal.policy.networkId, kind: "principal", id: principal.subject.id })).status).toBe(200);
  expect((await trust(principal)).status).toBe(400);
  expect((await guest(principal, "revoked-principal-reuse")).status).toBe(409);
  const path = "/v1/mesh/snapshot";
  expect((await fetch(h.baseUrl + path, { headers: signPeerRequest(distinct.service, { method: "GET", path, destinationKeyId: node.card.keyId }) })).status).toBe(200);
  // Seed only this test broker's database as if an older build had allowed overlap.
  const { Database } = await import("bun:sqlite");
  const db = new Database(join(h.controlHome, "control-plane.sqlite"));
  try {
    const before = db.query("SELECT * FROM trusted_peers WHERE key_id=?1").get(distinct.subject.id);
    const guestBefore = db.query("SELECT * FROM guest_grants WHERE key_id=?1").get(guestFirst.subject.id);
    for (const old of [distinct, guestFirst]) {
      db.query("INSERT INTO mesh_access_principals(network_id,principal_id,public_key) VALUES(?1,?2,?3)").run(principal.policy.networkId, old.subject.id, old.service.publicKey);
      db.query("INSERT INTO mesh_access_denials(network_id,kind,id,at) VALUES(?1,'principal',?2,?3)").run(principal.policy.networkId, old.subject.id, Date.now());
    }
    for (const [old, route] of [[distinct, path], [guestFirst, "/v1/guest/agents"]] as const) {
      const response = await fetch(h.baseUrl + route, { headers: signPeerRequest(old.service, { method: "GET", path: route, destinationKeyId: node.card.keyId }) });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "credential_class_conflict" });
    }
    expect(db.query("SELECT * FROM trusted_peers WHERE key_id=?1").get(distinct.subject.id)).toEqual(before);
    expect(db.query("SELECT * FROM guest_grants WHERE key_id=?1").get(guestFirst.subject.id)).toEqual(guestBefore);
  } finally { db.close(); }
}, 30_000);

test("protected broker startup does not construct the unauthenticated Slack worker supervisor", async () => {
  for (const protectedLocal of [true, false]) {
    const controlHome = mkdtempSync(join(tmpdir(), "scout-access-slack-"));
    const marker = join(controlHome, "slack-created");
    const preload = join(controlHome, "preload.ts");
    writeFileSync(preload, `import { mock } from "bun:test"; import { writeFileSync } from "node:fs";
      mock.module(${JSON.stringify(resolve(import.meta.dir, "slack-worker-supervisor.ts"))}, () => ({
        SlackWorkerSupervisor: class { constructor() { writeFileSync(${JSON.stringify(marker)}, "created"); } start() {} async stop() {} }
      }));`);
    await broker.startBroker({ controlHome, protectedLocal, preload });
    expect(existsSync(marker)).toBe(!protectedLocal);
  }
}, 30_000);
