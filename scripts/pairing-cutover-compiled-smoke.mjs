/** Compiled first-party runtime witness. Run after the runtime build on Node 24. */
import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, chmodSync} from "node:fs";
import {randomBytes} from "node:crypto";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pairingTrustOwner, PairingTrustOwner} from "../packages/runtime/dist/pairing-security/trust-owner.js";

// The trust root id is keyed by the host identity in the trust root.
const identity = dir => writeFileSync(join(dir, "identity.json"), JSON.stringify({publicKey: "00".repeat(32),
  privateKey: randomBytes(32).toString("hex"), createdAt: "2026-01-01T00:00:00Z"}), {mode: 0o600});
assert.equal(Number(process.versions.node.split(".")[0]), 24, "qualification requires Node 24");
const parent = mkdtempSync(join(tmpdir(), "pairing-capsule-parent-"));
chmodSync(parent, 0o775);
const root = mkdtempSync(join(parent, "pairing-capsule-compiled-"));
try {
  identity(root);
  const owner = pairingTrustOwner(root), peer = {publicKey: "a".repeat(64), pairedAt: "date"};
  owner.mutate(0, "seed", {type: "grant", peer});
  const legacy = readFileSync(join(root, "trusted-peers.owner.1.json")), stamp = owner.pairingAuthorityStamp();
  const receipt = owner.migrateToCapsule("compiled-cut");
  assert.equal(owner.pairingAuthorityStamp(), stamp);
  assert.deepEqual(owner.migrateToCapsule("compiled-cut"), receipt);
  assert.ok(!readdirSync(root).includes(".pairing-cutover"));
  // Compiled operation witness; real process-death evidence lives in the Bun suite.
  owner.operation(undefined, identity => {for(let i=0;i<8;i++)owner.claimCapsuleSlot(identity);});
  assert.throws(() => owner.mutate(1, "stranded", {type: "revoke", publicKey: peer.publicKey}), /capsule_staging_capacity/);
  const reclaimed = owner.reclaimCapsuleStaging("compiled-recovery", {quiescent: true});
  assert.equal(reclaimed.moved.filter(item => item.kind === "claim").length, 8);
  assert.equal(owner.read().revision, 1);
  assert.deepEqual(owner.reclaimCapsuleStaging("compiled-recovery", {quiescent: true}), reclaimed);
  const revoked = owner.mutate(1, "revoke", {type: "revoke", publicKey: peer.publicKey});
  assert.deepEqual(owner.mutate(1, "revoke", {type: "revoke", publicKey: peer.publicKey}), revoked);
  assert.equal(owner.read().peers.length, 0);
  const head = JSON.parse(readFileSync(join(root, "trusted-peers.v2.commit.2.json"), "utf8")).capsule;
  const path = join(root, head.parts[0].name), bytes = readFileSync(path, "utf8");
  writeFileSync(path, bytes.replace('"seed"', '"bad!"'));
  assert.throws(() => owner.read(), /capsule_chunk_checksum/);
  assert.throws(() => new PairingTrustOwner(root).read(), /capsule_chunk_checksum/);
  writeFileSync(path, bytes);
  writeFileSync(join(root, "trusted-peers.owner.1.json"), legacy, {mode: 0o600});
  assert.throws(() => owner.read(), /capsule_unexpected_history/);
  console.log(JSON.stringify({node: process.version, compiledOwner: true, realMigration: true,
    stampPreserved: true, groupWritableParent: true, quiescentReclamation: true, exactRetry: true, realRevoke: true, freshCorruptionAndResurrectionRefusal: true}));
} finally {rmSync(root, {recursive: true, force: true});rmSync(root+".pairing-reclamation", {recursive: true, force: true});rmSync(parent, {recursive: true, force: true});}

// Keep an immediate tmpdir() parent too: hosted Linux witnesses real /tmp 1777.
const direct = mkdtempSync(join(tmpdir(), "pairing-capsule-direct-"));
try {
 identity(direct);
 const owner = pairingTrustOwner(direct);
 owner.mutate(0, "seed", {type: "grant", peer: {publicKey: "b".repeat(64), pairedAt: "date"}});
 owner.migrateToCapsule("direct-cut");
 assert.equal(owner.reclaimCapsuleStaging("direct-recovery", {quiescent: true}).moved.length, 0);
 assert.equal(owner.read().revision, 1);
 console.log(JSON.stringify({directTmpParent: true, node: process.version}));
} finally {rmSync(direct, {recursive: true, force: true});rmSync(direct+".pairing-reclamation", {recursive: true, force: true});}
