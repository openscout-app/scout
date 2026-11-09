import { afterEach, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PairingTrustOwner, pairingRootId, type PairingTrustAdapter, type TrustedPeer } from "./trust-owner.ts";

// Persisted root ids used dev:ino. st_dev is assigned at mount time, so a
// reboot that changes the volume mount order made every store unreadable.
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, {recursive: true, force: true}); });
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const keyA = "a".repeat(64), keyB = "b".repeat(64), keyC = "c".repeat(64);
const peer = (publicKey: string): TrustedPeer => ({publicKey, pairedAt: "2026-01-01T00:00:00Z"});
function root(prefix = "pairing-root-id-") { const path = mkdtempSync(join(tmpdir(), prefix)); roots.push(path); return path; }
const secret = (seed: string) => () => Buffer.alloc(32, seed);
function adapter(): PairingTrustAdapter {
  let holder: object | null = null;
  return {id: "root-id.test", currentHolder: () => holder,
    withGate(_root, body) { holder = {}; try { return body(holder); } finally { holder = null; } }};
}

/** Writes a store exactly as the previous owner did, with a legacy dev:ino
 * root id. `dev` defaults to a different device: the store of an earlier boot. */
function legacyStore(path: string, options: {managed?: boolean; dev?: number} = {}) {
  const stat = lstatSync(path), rootId = `${options.dev ?? stat.dev + 1}:${stat.ino}`;
  const marker = options.managed ? {schema: "scout.pairing-trust-managed/v1", rootId, adapterId: "root-id.test"} : null;
  const peers: TrustedPeer[] = [];
  let previousHash = hash("[]"), managed: typeof marker = null;
  const steps: Array<{type: "grant" | "manage"; key: string | null}> = [{type: "grant", key: keyA}, {type: "grant", key: keyB}];
  if (marker) steps.push({type: "manage", key: null});
  steps.forEach((step, index) => {
    const revision = index + 1;
    if (step.type === "grant") peers.push(peer(step.key!)); else managed = marker;
    const generation = {schema: "scout.pairing-trust-owner/v1", rootId, revision, previousHash,
      peersHash: hash(JSON.stringify(peers, null, 2)), peers, managed,
      mutation: {request: JSON.stringify([index, step.type, step.key ? peer(step.key) : null, null]),
        outcome: {mutationId: `legacy-${revision}`, revision, type: step.type, publicKey: step.key, changed: true}}};
    const bytes = JSON.stringify({generation, sha256: hash(JSON.stringify(generation))});
    writeFileSync(join(path, `trusted-peers.owner.${revision}.json`), bytes, {mode: 0o600});
    previousHash = hash(bytes);
  });
  writeFileSync(join(path, "trusted-peers.json"), JSON.stringify(peers, null, 2), {mode: 0o600});
  if (marker) writeFileSync(join(path, "trusted-peers.managed.json"), JSON.stringify(marker), {mode: 0o600});
  return {rootId, revision: steps.length, dev: stat.dev, ino: stat.ino};
}
const generation = (path: string, revision: number) =>
  JSON.parse(readFileSync(join(path, `trusted-peers.owner.${revision}.json`), "utf8")).generation;

test("the root id is bound to the host identity and nothing else", () => {
  expect(pairingRootId(Buffer.alloc(32, "a"))).toMatch(/^r2:[a-f0-9]{64}$/);
  expect(pairingRootId(Buffer.alloc(32, "a"))).toBe(pairingRootId(Buffer.alloc(32, "a")));
  expect(pairingRootId(Buffer.alloc(32, "a"))).not.toBe(pairingRootId(Buffer.alloc(32, "b")));
  expect(() => pairingRootId(Buffer.alloc(8))).toThrow("root_key_unavailable");
});

test("a store from an earlier boot with another device number loads", () => {
  const path = root(), legacy = legacyStore(path);
  expect(legacy.rootId).not.toBe(`${lstatSync(path).dev}:${lstatSync(path).ino}`);
  const owner = new PairingTrustOwner(path, {rootKey: secret("a")});
  expect(owner.read()).toEqual({revision: 2, peers: [peer(keyA), peer(keyB)]});
});

test("a v2 store loads after a device change: no record holds the device number", () => {
  const path = root();
  const first = new PairingTrustOwner(path, {rootKey: secret("a")});
  first.mutate(0, "one", {type: "grant", peer: peer(keyA)});
  // A fresh owner models a new process after the reboot. Only the root key,
  // not the stat of the directory, determines the persisted id.
  const second = new PairingTrustOwner(path, {rootKey: secret("a")});
  expect(second.read().peers).toEqual([peer(keyA)]);
  expect(generation(path, 1).rootId).toBe(pairingRootId(Buffer.alloc(32, "a")));
});

test("a legacy store keeps its peers and the next write is r2", () => {
  const path = root(), legacy = legacyStore(path);
  const owner = new PairingTrustOwner(path, {rootKey: secret("a")});
  owner.mutate(2, "after-reboot", {type: "grant", peer: peer(keyC)});
  expect(owner.read()).toEqual({revision: 3, peers: [peer(keyA), peer(keyB), peer(keyC)]});
  expect(generation(path, 2).rootId).toBe(legacy.rootId);
  expect(generation(path, 3).rootId).toBe(pairingRootId(Buffer.alloc(32, "a")));
  expect(new PairingTrustOwner(path, {rootKey: secret("a")}).read().revision).toBe(3);
});

test("a managed legacy store crosses to r2 without a managed downgrade", () => {
  const path = root(), legacy = legacyStore(path, {managed: true});
  const owner = new PairingTrustOwner(path, {rootKey: secret("a")});
  const remove = owner.register(adapter());
  try {
    expect(owner.read().revision).toBe(3);
    owner.mutate(3, "managed-after-reboot", {type: "revoke", publicKey: keyA});
    expect(owner.read().peers).toEqual([peer(keyB)]);
    const next = generation(path, 4);
    expect(next.rootId).toMatch(/^r2:/);
    expect(next.managed).toEqual({schema: "scout.pairing-trust-managed/v1", rootId: next.rootId, adapterId: "root-id.test"});
    // The marker file is still the legacy one. It compares equal once normalized.
    expect(JSON.parse(readFileSync(join(path, "trusted-peers.managed.json"), "utf8")).rootId).toBe(legacy.rootId);
    owner.mutate(4, "managed-again", {type: "grant", peer: peer(keyC)});
    expect(owner.read().revision).toBe(5);
  } finally { remove(); }
});

test("a store opened with a different host identity is refused", () => {
  const path = root();
  new PairingTrustOwner(path, {rootKey: secret("a")}).mutate(0, "one", {type: "grant", peer: peer(keyA)});
  expect(() => new PairingTrustOwner(path, {rootKey: secret("b")}).read()).toThrow("generation_invalid");
});

test("the default key comes from identity.json in the trust root", () => {
  const path = root();
  expect(() => new PairingTrustOwner(path).mutate(0, "one", {type: "grant", peer: peer(keyA)})).toThrow("root_key_unavailable");
  const privateKey = randomBytes(32).toString("hex");
  writeFileSync(join(path, "identity.json"), JSON.stringify({publicKey: "00".repeat(32), privateKey, createdAt: "2026-01-01T00:00:00Z"}), {mode: 0o600});
  new PairingTrustOwner(path).mutate(0, "one", {type: "grant", peer: peer(keyA)});
  expect(generation(path, 1).rootId).toBe(pairingRootId(Buffer.from(privateKey, "hex")));
  // A new identity means peers pinned a different key: the store is refused.
  writeFileSync(join(path, "identity.json"), JSON.stringify({publicKey: "00".repeat(32), privateKey: randomBytes(32).toString("hex"), createdAt: "2026-01-02T00:00:00Z"}), {mode: 0o600});
  expect(() => new PairingTrustOwner(path).read()).toThrow("generation_invalid");
});

test("a legacy store copied to a new directory is refused; a v2 store moves with its identity", () => {
  const parent = root();
  const original = join(parent, "original"), copy = join(parent, "copy");
  mkdirSync(original, {mode: 0o700}); legacyStore(original);
  cpSync(original, copy, {recursive: true}); // New inode: not the legacy root.
  expect(() => new PairingTrustOwner(copy, {rootKey: secret("a")}).read()).toThrow("generation_invalid");
  const v2 = root(), moved = `${v2}-moved`; roots.push(moved);
  new PairingTrustOwner(v2, {rootKey: secret("a")}).mutate(0, "one", {type: "grant", peer: peer(keyA)});
  renameSync(v2, moved);
  expect(new PairingTrustOwner(moved, {rootKey: secret("a")}).read().peers).toEqual([peer(keyA)]);
});

test("an open owner still refuses a replaced root within one process", () => {
  const path = root(), owner = new PairingTrustOwner(path, {rootKey: secret("a")});
  owner.mutate(0, "one", {type: "grant", peer: peer(keyA)});
  const aside = `${path}-aside`; roots.push(aside);
  renameSync(path, aside); cpSync(aside, path, {recursive: true});
  expect(() => owner.read()).toThrow("root_replaced");
});

test("newly written records hold no device number or inode in plain text", () => {
  const path = root("pairing-capsule-root-id-"), owner = new PairingTrustOwner(path, {rootKey: secret("a")});
  owner.mutate(0, "one", {type: "grant", peer: peer(keyA)});
  owner.mutate(1, "two", {type: "grant", peer: peer(keyB)});
  owner.migrateToCapsule("cut");
  owner.mutate(2, "three", {type: "revoke", publicKey: keyA});
  owner.mutate(3, "four", {type: "grant", peer: peer(keyC)});
  expect(owner.read().peers).toEqual([peer(keyB), peer(keyC)]);
  const names = readdirSync(path, {recursive: true}).map(String).filter(name => !lstatSync(join(path, name)).isDirectory());
  expect(names.some(name => name.startsWith("trusted-peers.v2.commit."))).toBe(true);
  const numbers = new Set<string>();
  for (const name of ["", ...names]) { const stat = lstatSync(join(path, name)); numbers.add(String(stat.dev)); numbers.add(String(stat.ino)); }
  const ids: string[] = [];
  const walk = (value: unknown, key = ""): void => {
    if (Array.isArray(value)) value.forEach(item => walk(item));
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, k);
    else if (typeof value === "string" && (key === "rootId" || key === "identity")) ids.push(value);
  };
  for (const name of names) {
    const text = readFileSync(join(path, name), "utf8");
    for (const number of numbers) expect(text.includes(number), `${name} contains ${number}`).toBe(false);
    expect(text).not.toMatch(/"\d+:\d+"/);
    walk(JSON.parse(text));
  }
  expect(ids.length).toBeGreaterThan(5);
  for (const value of ids) expect(value).toMatch(/^(?:r2|o2):[a-f0-9]{64}$/);
});
