/** Emitted owner API witness, after test:pairing-cutover:compiled builds it. */
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pairingTrustOwner} from "../packages/runtime/dist/pairing-security/trust-owner.js";
assert.equal(Number(process.versions.node.split(".")[0]),24);
const root=mkdtempSync(join(tmpdir(),"pairing-capsule-view-compiled-"));
try {
 writeFileSync(join(root,"identity.json"),JSON.stringify({publicKey:"00".repeat(32),privateKey:randomBytes(32).toString("hex"),createdAt:"2026-01-01T00:00:00Z"}),{mode:0o600});
 const owner=pairingTrustOwner(root),peer={publicKey:"a".repeat(64),pairedAt:"date"};
 owner.mutate(0,"seed",{type:"grant",peer});owner.migrateToCapsule("view-cut");
 const view=owner.readAuthority();assert.equal(view.stamp,owner.pairingAuthorityStamp());assert.deepEqual(view.peers,owner.read().peers);
 owner.mutate(1,"revoke",{type:"revoke",publicKey:peer.publicKey});
 assert.equal(owner.readAuthority().peers.length,0);assert.notEqual(owner.readAuthority().stamp,view.stamp);
 console.log(JSON.stringify({node:process.version,emittedAuthorityView:true,stampEquivalent:true,freshRevocation:true}));
} finally {rmSync(root,{recursive:true,force:true});}
