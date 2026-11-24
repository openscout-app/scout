import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScoutCommandContext } from "../context.ts";
import { parseMeshAccessFlags, runMeshAccessCommand } from "./mesh-access.ts";
import {
  validateAccessPolicy,
  validateAccessDelegation,
  validateAccessGrant,
  validateAccessRevocation,
  ACCESS_ARTIFACT_MAX_BYTES,
  accessKeyId,
  verifyScopedPeerRequest,
  PeerNonceCache,
  PEER_AUTH_HEADERS,
  LOCAL_ADMIN_HEADER,
  verifyLocalAdminRequest,
} from "@openscout/runtime/mesh";


import type { PinnedHttpsClient } from "@openscout/runtime/mesh/pinned-https-client";

import { buildSignedNodeCard } from "@openscout/runtime";

const TLS_PIN = "c".repeat(64);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "scout-access-cli-")); dirs.push(cwd);
  const output: string[] = [];
  const context = createScoutCommandContext({ cwd, stdout: (value) => output.push(value), stderr: (value) => output.push(value) });
  const run = (args: string[], fetchImpl?: typeof fetch, pinnedFactory?: () => PinnedHttpsClient) => runMeshAccessCommand(context, args, fetchImpl, pinnedFactory ?? (() => ({
    fetch: async (url, peer, init) => {
      expect(peer.spkiFingerprint).toBe(TLS_PIN);
      expect(peer.expectedKeyId).toMatch(/^[0-9a-f]{64}$/);
      if (!fetchImpl) throw new Error("Unexpected test network request");
      return fetchImpl(url, init);
    },
    probeFetch: async () => { throw new Error("Unpinned probes forbidden"); },
    invalidate: () => {}, close: () => {},
  })));
  const read = (path: string) => JSON.parse(readFileSync(join(cwd, path), "utf8"));
  const save = (path: string, value: unknown) => writeFileSync(join(cwd, path), JSON.stringify(value));
  return { cwd, output, run, read, save };
}
async function network() {
  const s = setup();
  await s.run(["identity", "create", "--directory", "owner", "--kind", "person", "--label", "Owner"]);
  await s.run(["network", "create", "--identity", "owner/identity.json", "--label", "Test", "--out", "bootstrap-policy.json"]);
  await s.run(["identity", "create", "--directory", "worker", "--kind", "service", "--label", "Worker"]);
  const unsignedPolicy = s.read("bootstrap-policy.json");
  delete unsignedPolicy.signature;
  unsignedPolicy.revision = 2;
  unsignedPolicy.members = [{ principal: s.read("worker/public.json"), role: "service" }];
  s.save("policy-input.json", unsignedPolicy);
  await s.run(["policy", "sign", "--identity", "owner/identity.json", "--file", "policy-input.json", "--out", "policy.json"]);
  await s.run(["device", "create", "--directory", "device"]);
  await s.run(["device", "create", "--directory", "peer"]);
  const peer = s.read("peer/device.json").identity;
  const card = buildSignedNodeCard(peer, { nodeId: "peer", label: "Peer", version: "test", capabilities: ["scout-access/1"], endpoints: ["https://peer.example"], tls: { spkiFingerprint: TLS_PIN } });
  const policy = s.read("policy.json");
  const device = s.read("device/device.json").identity;
  const unsigned = { protocol: "scout-access/1", kind: "delegation", id: "test-delegation", networkId: policy.networkId, principalId: policy.root.id, devicePublicKey: device.publicKey, audience: card.keyId, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, scope: { all: false, agentIds: ["agent:one"], projectIds: [] }, actions: ["discover", "message"] };
  s.save("unsigned.json", unsigned);
  await s.run(["delegate", "--identity", "owner/identity.json", "--policy", "policy.json", "--file", "unsigned.json", "--out", "delegation.json"]);
  return { ...s, policy, device, peer, card, delegation: s.read("delegation.json") };
}

describe("mesh access CLI", () => {
  test("strict flags accept equals and reject duplicate/unknown/missing values", () => {
    expect(parseMeshAccessFlags(["--file=data.json", "--json"], ["file"], ["file"])).toEqual({ file: "data.json" });
    for (const args of [["--file"], ["--file", "--out"], ["--wat", "x"], ["x"], ["--file", "one", "--file", "two"]]) {
      expect(() => parseMeshAccessFlags(args, ["file"], ["file"])).toThrow();
    }
  });
  test("creates independent exclusive 0600 keys, emits only public material, inspects safely", async () => {
    const s = setup();
    await s.run(["identity", "create", "--directory", "owner", "--kind", "person", "--label", "Owner"]);
    const privateKey = s.read("owner/identity.json").identity.privateKey;
    expect(statSync(join(s.cwd, "owner/identity.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(s.cwd, "owner")).mode & 0o777).toBe(0o700);
    await s.run(["inspect", "--file", "owner/identity.json"]);
    expect(s.output.join("\n")).not.toContain(privateKey);
    expect(s.output.join("\n")).not.toContain('"privateKey"');
    await expect(s.run(["identity", "create", "--directory", "owner", "--kind", "person", "--label", "Owner"])).rejects.toThrow("must be new");
    expect(s.read("owner/identity.json").identity.privateKey).toBe(privateKey);
    chmodSync(join(s.cwd, "owner/identity.json"), 0o644);
    await expect(s.run(["inspect", "--file", "owner/identity.json"])).rejects.toThrow("0600");
  });
  test("policy, delegation, grant signatures round trip; tampering and private extensions fail", async () => {
    const s = await network();
    expect(s.policy.revokedPrincipalIds).toEqual([]);
    expect(s.output.some((value) => value.includes('"warning":"root-key-custody"'))).toBe(true);
    validateAccessPolicy(s.policy);
    validateAccessDelegation(s.delegation, s.policy, s.delegation.audience);
    const grant = { protocol: "scout-access/1", kind: "grant", id: "grant-1", networkId: s.policy.networkId, issuerId: s.policy.root.id, subjectId: s.policy.members[0].principal.id, audience: s.delegation.audience, revision: 1, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, revoked: false, scope: s.delegation.scope, actions: ["discover"] };
    s.save("grant-input.json", grant);
    await s.run(["grant", "sign", "--identity", "owner/identity.json", "--policy", "policy.json", "--file", "grant-input.json", "--out", "grant.json"]);
    validateAccessGrant(s.read("grant.json"), s.policy);
    await s.run(["verify", "--file", "grant.json", "--policy", "policy.json"]);
    s.save("tampered.json", { ...s.delegation, actions: ["admin"] });
    await expect(s.run(["verify", "--file", "tampered.json", "--policy", "policy.json"])).rejects.toThrow();
    const missingRevocations = { ...s.policy };
    delete missingRevocations.revokedPrincipalIds;
    s.save("missing-revocations.json", missingRevocations);
    await expect(s.run(["inspect", "--file", "missing-revocations.json"])).rejects.toThrow("arrays of strings");
    s.save("leak.json", { ...s.policy, privateKey: "secret-key-do-not-emit" });
    await expect(s.run(["inspect", "--file", "leak.json"])).rejects.toThrow("Unexpected fields");
    expect(s.output.join("\n")).not.toContain("secret-key-do-not-emit");
    writeFileSync(join(s.cwd, "bad.json"), 'secret-key-do-not-emit invalid JSON');
    await expect(s.run(["inspect", "--file", "bad.json"])).rejects.toThrow("Cannot read access JSON");
  });
  test("service cannot become network owner and broker transport file is not a person identity", async () => {
    const s = setup();
    await s.run(["identity", "create", "--directory", "service", "--kind", "service", "--label", "Worker"]);
    await expect(s.run(["network", "create", "--identity", "service/identity.json", "--label", "Wrong", "--out", "wrong.json"])).rejects.toThrow("Only a person");
    s.save("raw.json", s.read("service/identity.json").identity); chmodSync(join(s.cwd, "raw.json"), 0o600);
    await expect(s.run(["network", "create", "--identity", "raw.json", "--label", "Wrong", "--out", "wrong.json"])).rejects.toThrow();
  });
  test("admin requests use exact operation names, reject remote URLs and operation override", async () => {
    const s = await network();
    const requests: unknown[] = [];
    const fetchImpl = (async (_url: unknown, init: RequestInit) => { requests.push(JSON.parse(String(init.body))); return Response.json({ ok: true }); }) as typeof fetch;
    await s.run(["import", "--file", "policy.json", "--broker", "http://127.0.0.1:1234"], fetchImpl);
    expect(requests).toEqual([{ operation: "policy.import", artifact: s.policy }]);
    await expect(s.run(["status", "--broker", "http://example.com"], fetchImpl)).rejects.toThrow("loopback");
    s.save("override.json", { operation: "policy.import" });
    await expect(s.run(["revoke", "--file", "override.json"], fetchImpl)).rejects.toThrow("Unexpected fields");
    expect(requests.length).toBe(1);
  });
  test("remote policy sync remains signed and rejects unsupported operation fields before sending", async () => {
    const s = await network();
    const requests: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: unknown, init: RequestInit) => {
      if (init.method === "GET") return Response.json({ card: s.card });
      expect(new Headers(init.headers).has(PEER_AUTH_HEADERS.signature)).toBe(true);
      requests.push(JSON.parse(String(init.body))); return Response.json({ ok: true });
    }) as typeof fetch;
    const call = () => s.run(["call", "--url", "https://peer.example", "--tls-pin", TLS_PIN, "--device", "device/device.json", "--delegation", "delegation.json", "--policy", "policy.json", "--file", "operation.json"], fetchImpl);
    s.save("operation.json", { operation: "policy.import", artifact: s.policy });
    await call();
    expect(requests[0]).toEqual({ operation: "policy.import", artifact: s.policy, delegation: s.delegation });
    s.save("operation.json", { operation: "message", requestId: "message-123", target: "agent:one", body: "Hello", ensureAwake: true });
    await expect(call()).rejects.toThrow("Unexpected fields");
    s.save("operation.json", { operation: "result", requestId: "short" });
    await expect(call()).rejects.toThrow("requestId");
    expect(requests.length).toBe(1);
  });
  test("old, unsigned, expired, tampered, or wrong-audience node cards block scoped POST", async () => {
    const s = await network();
    s.save("operation.json", { operation: "discover" });
    const fields = { nodeId: "peer", label: "Peer", version: "test", capabilities: ["scout-access/1"], endpoints: ["https://peer.example"], tls: { spkiFingerprint: TLS_PIN } };
    const cards = [
      undefined,
      buildSignedNodeCard(s.peer, { ...fields, capabilities: [] }),
      { ...s.card, signature: "invalid" },
      { ...s.card, capabilities: ["scout-access/1", "tampered"] },
      buildSignedNodeCard(s.device, fields),
      buildSignedNodeCard(s.peer, fields, Date.now() - 2 * 24 * 60 * 60_000),
    ];
    for (const card of cards) {
      const methods: string[] = [];
      const fetchImpl = (async (_url: unknown, init: RequestInit) => {
        methods.push(init.method!); expect(init.redirect).toBe("error");
        expect(init.body).toBeUndefined();
        expect(new Headers(init.headers).has(PEER_AUTH_HEADERS.signature)).toBe(false);
        return Response.json({ card });
      }) as typeof fetch;
      await expect(s.run(["call", "--url", "https://peer.example", "--tls-pin", TLS_PIN, "--device", "device/device.json", "--delegation", "delegation.json", "--policy", "policy.json", "--file", "operation.json"], fetchImpl)).rejects.toThrow("No scoped request was sent");
      expect(methods).toEqual(["GET"]);
    }
  });
  test("revocation signing supports person/service identities and verifies signature without policy", async () => {
    const s = await network();
    for (const directory of ["owner", "worker"]) {
      const principal = s.read(`${directory}/public.json`);
      const unsigned = { protocol: "scout-access/1", kind: "revocation", networkId: s.policy.networkId, issuerId: principal.id, issuerPublicKey: principal.publicKey, targetKind: "device", targetId: accessKeyId(s.device.publicKey), issuedAt: Date.now() };
      s.save(`${directory}-revocation-input.json`, unsigned);
      await s.run(["revocation", "sign", "--identity", `${directory}/identity.json`, "--file", `${directory}-revocation-input.json`, "--out", `${directory}-revocation.json`]);
      validateAccessRevocation(s.read(`${directory}-revocation.json`));
      await s.run(["verify", "--file", `${directory}-revocation.json`]);
      const verified = JSON.parse(s.output.at(-1)!);
      expect(verified.valid).toBe(true);
      expect(verified.verification).toBe("signature-only");
      expect(verified.receiverStateChecked).toBe(false);
      expect(s.output.join("\n")).not.toContain(s.read(`${directory}/identity.json`).identity.privateKey);
    }
    s.save("bad-revocation.json", { ...s.read("owner-revocation.json"), targetId: "tampered" });
    await expect(s.run(["verify", "--file", "bad-revocation.json"])).rejects.toThrow();
    s.save("bad-revocation.json", { ...s.read("owner-revocation.json"), privateKey: "do-not-emit" });
    await expect(s.run(["inspect", "--file", "bad-revocation.json"])).rejects.toThrow("Unexpected fields");
    expect(s.output.join("\n")).not.toContain("do-not-emit");
  });
  test("admin keys use exclusive 0600 files and authenticate local requests without sending the key", async () => {
    const s = await network();
    await s.run(["admin-key", "create", "--file", "admin.key"]);
    const key = readFileSync(join(s.cwd, "admin.key"), "utf8").trim();
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(statSync(join(s.cwd, "admin.key")).mode & 0o777).toBe(0o600);
    expect(s.output.join("\n")).not.toContain(key);
    await expect(s.run(["admin-key", "create", "--file", "admin.key"])).rejects.toThrow("choose a new file");
    expect(readFileSync(join(s.cwd, "admin.key"), "utf8").trim()).toBe(key);
    let calls = 0;
    const fetchImpl = (async (url: unknown, init: RequestInit) => {
      if (init.method === "GET") {
        expect(String(url)).toBe("http://127.0.0.1:1234/v1/node");
        expect(new Headers(init.headers).has(LOCAL_ADMIN_HEADER)).toBe(false);
        return Response.json({ card: s.card });
      }
      calls++; expect(String(url)).toBe("http://127.0.0.1:1234/v1/access/admin");
      const headers = Object.fromEntries(new Headers(init.headers));
      expect(JSON.stringify(headers)).not.toContain(key);
      expect(verifyLocalAdminRequest(key, { headers, method: "POST", path: "/v1/access/admin", body: String(init.body), destinationKeyId: s.card.keyId, bootedAt: Date.now(), nonceClaim: new PeerNonceCache() }).ok).toBe(true);
      expect(String(init.body)).not.toContain(key);
      return Response.json({ ok: true });
    }) as typeof fetch;
    await s.run(["status", "--broker", "http://127.0.0.1:1234", "--admin-key", "admin.key"], fetchImpl);
    chmodSync(join(s.cwd, "admin.key"), 0o644);
    await expect(s.run(["status", "--broker", "http://127.0.0.1:1234", "--admin-key", "admin.key"], fetchImpl)).rejects.toThrow("owner-only");
    expect(calls).toBe(1);
    expect(s.output.join("\n")).not.toContain(key);
  });
  test("submit delivers signed policy/grant/revocation without admin or device credentials", async () => {
    const s = await network();
    await s.run(["admin-key", "create", "--file", "admin.key"]);
    const adminKey = readFileSync(join(s.cwd, "admin.key"), "utf8").trim();
    const owner = s.policy.root;
    s.save("revocation-input.json", { protocol: "scout-access/1", kind: "revocation", networkId: s.policy.networkId, issuerId: owner.id, issuerPublicKey: owner.publicKey, targetKind: "delegation", targetId: s.delegation.id, issuedAt: Date.now() });
    await s.run(["revocation", "sign", "--identity", "owner/identity.json", "--file", "revocation-input.json", "--out", "revocation.json"]);
    s.save("grant-input.json", { protocol: "scout-access/1", kind: "grant", id: "grant-submit", networkId: s.policy.networkId, issuerId: owner.id, subjectId: s.policy.members[0].principal.id, audience: s.card.keyId, revision: 1, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, revoked: false, scope: s.delegation.scope, actions: ["discover"] });
    await s.run(["grant", "sign", "--identity", "owner/identity.json", "--policy", "policy.json", "--file", "grant-input.json", "--out", "grant.json"]);
    const submitted: unknown[] = [];
    const fetchImpl = (async (url: unknown, init: RequestInit) => {
      const headers = new Headers(init.headers);
      expect(headers.has(LOCAL_ADMIN_HEADER)).toBe(false);
      expect(headers.has(PEER_AUTH_HEADERS.signature)).toBe(false);
      expect(headers.has("authorization")).toBe(false);
      expect(init.redirect).toBe("error");
      if (init.method === "GET") return Response.json({ card: s.card });
      expect(String(url)).toBe("https://peer.example/v1/access/policy");
      expect(String(init.body)).not.toContain(adminKey);
      expect(String(init.body)).not.toContain(s.device.privateKey);
      submitted.push(JSON.parse(String(init.body)));
      return Response.json({ accepted: true });
    }) as typeof fetch;
    for (const file of ["policy.json", "grant.json", "revocation.json"]) await s.run(["submit", "--url", "https://peer.example", "--tls-pin", TLS_PIN, "--audience", s.card.keyId, "--file", file], fetchImpl);
    expect(submitted).toEqual(["policy.json", "grant.json", "revocation.json"].map((file) => ({ artifact: s.read(file) })));
    await expect(s.run(["submit", "--url", "https://peer.example", "--tls-pin", TLS_PIN, "--audience", s.card.keyId, "--file", "policy.json", "--admin-key", "admin.key"], fetchImpl)).rejects.toThrow("Unknown argument");
    const importFetch = (async (_url: unknown, init: RequestInit) => { expect(JSON.parse(String(init.body))).toEqual({ operation: "revocation.import", artifact: s.read("revocation.json") }); return Response.json({ ok: true }); }) as typeof fetch;
    await s.run(["import", "--file", "revocation.json", "--broker", "http://127.0.0.1:1234"], importFetch);
    expect(submitted.length).toBe(3);
  });
  test("submit rejects oversized, unsigned, wrong-audience and incompatible-peer artifacts before POST", async () => {
    const s = await network();
    let gets = 0, posts = 0;
    const fetchImpl = (async (_url: unknown, init: RequestInit) => { if (init.method === "GET") gets++; else posts++; return Response.json({ card: s.card }); }) as typeof fetch;
    const submit = (file: string, audience = s.card.keyId) => s.run(["submit", "--url", "https://peer.example", "--tls-pin", TLS_PIN, "--audience", audience, "--file", file], fetchImpl);
    s.save("oversized.json", { ...s.policy, label: "x".repeat(ACCESS_ARTIFACT_MAX_BYTES) });
    await expect(submit("oversized.json")).rejects.toThrow("256 KiB");
    await expect(submit("policy-input.json")).rejects.toThrow("requires a signed");
    await expect(submit("delegation.json")).rejects.toThrow("requires a signed");
    await expect(submit("policy.json", "invalid")).rejects.toThrow("full lowercase key ID");
    expect(gets).toBe(0); expect(posts).toBe(0);
    await expect(submit("policy.json", "a".repeat(64))).rejects.toThrow("No scoped request was sent");
    expect(gets).toBe(1); expect(posts).toBe(0);
  });
  test("remote call and submit refuse plaintext or missing/malformed explicit pins before networking", async () => {
    const s = await network();
    s.save("operation.json", { operation: "discover" });
    let requests = 0, clients = 0;
    const noFetch = (async () => { requests++; throw new Error("Unexpected network"); }) as unknown as typeof fetch;
    const noClient = () => { clients++; throw new Error("Unexpected TLS client"); };
    const callArgs = ["call", "--device", "device/device.json", "--delegation", "delegation.json", "--policy", "policy.json", "--file", "operation.json"];
    const submitArgs = ["submit", "--audience", s.card.keyId, "--file", "policy.json"];
    for (const args of [callArgs, submitArgs]) {
      await expect(s.run([...args, "--url", "http://peer.example"], noFetch, noClient)).rejects.toThrow("requires HTTPS");
      await expect(s.run([...args, "--url", "https://peer.example"], noFetch, noClient)).rejects.toThrow("requires --tls-pin");
      await expect(s.run([...args, "--url", "https://peer.example", "--tls-pin", "not-a-pin"], noFetch, noClient)).rejects.toThrow("requires --tls-pin");
    }
    expect(requests).toBe(0); expect(clients).toBe(0);
  });
  test("signed card TLS pin must exist and match the explicit pin, with bounded clock skew", async () => {
    const s = await network();
    const base = { nodeId: "peer", label: "Peer", version: "test", capabilities: ["scout-access/1"], endpoints: ["https://peer.example"] };
    let card = buildSignedNodeCard(s.peer, base), gets = 0, posts = 0;
    const fetchImpl = (async (_url: unknown, init: RequestInit) => {
      if (init.method === "GET") { gets++; return Response.json({ card }); }
      posts++; return Response.json({ accepted: true });
    }) as typeof fetch;
    const submit = () => s.run(["submit", "--url", "https://peer.example", "--tls-pin", TLS_PIN, "--audience", s.card.keyId, "--file", "policy.json"], fetchImpl);
    await expect(submit()).rejects.toThrow("expected audience and TLS pin");
    card = buildSignedNodeCard(s.peer, { ...base, tls: { spkiFingerprint: "d".repeat(64) } });
    await expect(submit()).rejects.toThrow("expected audience and TLS pin");
    card = buildSignedNodeCard(s.peer, { ...base, tls: { spkiFingerprint: TLS_PIN } }, Date.now() + 60_000);
    await expect(submit()).rejects.toThrow("No scoped request was sent");
    expect(posts).toBe(0);
    card = buildSignedNodeCard(s.peer, { ...base, tls: { spkiFingerprint: TLS_PIN } }, Date.now() + 1_000);
    await submit();
    expect(gets).toBe(4); expect(posts).toBe(1);
  });
  test("TLS pin failure closes the pinned client without fallback or sensitive POST", async () => {
    const s = await network();
    let fetches = 0, closed = 0, fallbacks = 0;
    const noFetch = (async () => { fallbacks++; throw new Error("Unexpected fallback"); }) as unknown as typeof fetch;
    const factory = (): PinnedHttpsClient => ({
      fetch: async (_url, peer, init) => { fetches++; expect(peer).toEqual({ expectedKeyId: s.card.keyId, spkiFingerprint: TLS_PIN }); expect(init?.method).toBe("GET"); throw new Error("served TLS key does not match pin"); },
      probeFetch: async () => { fallbacks++; throw new Error("Unexpected unpinned probe"); },
      invalidate: () => {}, close: () => { closed++; },
    });
    await expect(s.run(["submit", "--url", "https://peer.example", "--tls-pin", TLS_PIN, "--audience", s.card.keyId, "--file", "policy.json"], noFetch, factory)).rejects.toThrow("No scoped request was sent");
    expect(fetches).toBe(1); expect(closed).toBe(1); expect(fallbacks).toBe(0);
  });
  test("unrevoke removes local denies through authenticated local administration only", async () => {
    const s = await network();
    await s.run(["admin-key", "create", "--file", "admin.key"]);
    const key = readFileSync(join(s.cwd, "admin.key"), "utf8").trim();
    const deny = { networkId: s.policy.networkId, kind: "grant", id: `${s.policy.root.id}:grant-1` };
    s.save("deny.json", deny);
    let calls = 0;
    const fetchImpl = (async (url: unknown, init: RequestInit) => {
      if (init.method === "GET") {
        expect(String(url)).toBe("http://127.0.0.1:1234/v1/node");
        expect(new Headers(init.headers).has(LOCAL_ADMIN_HEADER)).toBe(false);
        return Response.json({ card: s.card });
      }
      calls++; expect(String(url)).toBe("http://127.0.0.1:1234/v1/access/admin");
      const headers = Object.fromEntries(new Headers(init.headers));
      expect(JSON.stringify(headers)).not.toContain(key);
      expect(verifyLocalAdminRequest(key, { headers, method: "POST", path: "/v1/access/admin", body: String(init.body), destinationKeyId: s.card.keyId, bootedAt: Date.now(), nonceClaim: new PeerNonceCache() }).ok).toBe(true);
      expect(JSON.parse(String(init.body))).toEqual({ ...deny, operation: "unrevoke" });
      return Response.json({ ok: true });
    }) as typeof fetch;
    await s.run(["unrevoke", "--file", "deny.json", "--broker", "http://127.0.0.1:1234", "--admin-key", "admin.key"], fetchImpl);
    await expect(s.run(["unrevoke", "--file", "deny.json", "--broker", "https://peer.example", "--admin-key", "admin.key"], fetchImpl)).rejects.toThrow("loopback");
    s.save("undo-operation.json", { ...deny, operation: "unrevoke" });
    await expect(s.run(["call", "--url", "https://peer.example", "--tls-pin", TLS_PIN, "--device", "device/device.json", "--delegation", "delegation.json", "--policy", "policy.json", "--file", "undo-operation.json"], fetchImpl)).rejects.toThrow("Unsupported scoped operation");
    expect(calls).toBe(1);
    s.save("bad-deny.json", { ...deny, operation: "revocation.import" });
    await expect(s.run(["unrevoke", "--file", "bad-deny.json"], fetchImpl)).rejects.toThrow("Unexpected fields");
    expect(s.output.join("\n")).not.toContain(key);
  });
  test("admin signing requires a valid broker card and never falls back to the static bearer", async () => {
    const s = await network();
    await s.run(["admin-key", "create", "--file", "admin.key"]);
    const key = readFileSync(join(s.cwd, "admin.key"), "utf8").trim();
    const methods: string[] = [];
    const fetchImpl = (async (_url: unknown, init: RequestInit) => {
      methods.push(init.method!);
      expect(JSON.stringify(init)).not.toContain(key);
      return Response.json({ card: { ...s.card, signature: "invalid" } });
    }) as typeof fetch;
    await expect(s.run(["status", "--broker", "http://127.0.0.1:1234", "--admin-key", "admin.key"], fetchImpl)).rejects.toThrow("valid signed node card");
    expect(methods).toEqual(["GET"]);
  });
  test("request grants and preview disclose potential owner-level execution without changing artifacts", async () => {
    const s = await network();
    s.save("request-grant.json", { protocol: "scout-access/1", kind: "grant", id: "request-grant", networkId: s.policy.networkId, issuerId: s.policy.root.id, subjectId: s.policy.members[0].principal.id, audience: s.card.keyId, revision: 1, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, revoked: false, scope: s.delegation.scope, actions: ["request"] });
    await s.run(["grant", "sign", "--identity", "owner/identity.json", "--policy", "policy.json", "--file", "request-grant.json", "--out", "signed-request-grant.json"]);
    expect(s.output.some((line) => line.includes('"warning":"request-execution-authority"') && line.includes("owner-level local execution"))).toBe(true);
    validateAccessGrant(s.read("signed-request-grant.json"), s.policy);
    s.output.length = 0;
    s.save("preview.json", { delegation: { ...s.delegation, actions: ["request"] } });
    const fetchImpl = (async () => Response.json({ agents: [] })) as unknown as typeof fetch;
    await s.run(["preview", "--file", "preview.json", "--broker", "http://127.0.0.1:1234"], fetchImpl);
    expect(s.output.some((line) => line.includes('"warning":"request-execution-authority"'))).toBe(true);
  });
  test("remote call binds envelope and audience to device proof without exposing private keys", async () => {
    const s = await network();
    s.save("operation.json", { operation: "discover" });
    let calls = 0;
    const fetchImpl = (async (url: unknown, init: RequestInit) => {
      if (init.method === "GET") { expect(String(url)).toBe("https://peer.example/v1/node"); return Response.json({ card: s.card }); }
      calls++;
      expect(String(url)).toBe("https://peer.example/v1/access/rpc");
      expect(init.redirect).toBe("error");
      expect(String(init.body)).not.toContain(s.device.privateKey);
      const verified = verifyScopedPeerRequest({ delegation: s.delegation, method: "POST", path: "/v1/access/rpc", body: String(init.body), headers: { peer: new Headers(init.headers).get(PEER_AUTH_HEADERS.peer) ?? undefined, ts: new Headers(init.headers).get(PEER_AUTH_HEADERS.ts) ?? undefined, nonce: new Headers(init.headers).get(PEER_AUTH_HEADERS.nonce) ?? undefined, signature: new Headers(init.headers).get(PEER_AUTH_HEADERS.signature) ?? undefined }, destinationKeyId: s.delegation.audience, lookupPeer: (id: string) => id === accessKeyId(s.device.publicKey) ? { publicKey: s.device.publicKey, tier: "observe" } : undefined, nonceClaim: new PeerNonceCache(), bootedAt: Date.now() });
      expect(verified.ok).toBe(true);
      expect(JSON.parse(String(init.body))).toEqual({ operation: "discover", delegation: s.delegation });
      return Response.json({ agents: [] });
    }) as typeof fetch;
    await s.run(["call", "--url", "https://peer.example", "--tls-pin", TLS_PIN, "--device", "device/device.json", "--delegation", "delegation.json", "--policy", "policy.json", "--file", "operation.json"], fetchImpl);
    expect(calls).toBe(1);
  });
});
