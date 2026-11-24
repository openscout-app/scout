import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pairingTrustCensus } from "./pairing-trust-owner-census.ts";
const root = fileURLToPath(new URL("..",import.meta.url));
test("no direct trust writer or default adapter installer/adopter remains outside the owner", () => {
  const result = pairingTrustCensus(root);
  expect(result.directWriters).toEqual([]); expect(result.adapterInstallers).toEqual([]); expect(result.managedAdopters).toEqual([]);
  expect(result.ownerConsumers).toContain("packages/runtime/src/pairing-security/identity.ts");
  expect(result.ownerConsumers).toContain("packages/pairing/src/pairing.ts");
  const source = readFileSync(join(root,result.canonicalOwner),"utf8");
  expect(source).not.toMatch(/process\.env|import\s*\(|require\s*\(|process\.argv/);
}, 30000); // Full-tree AST census: hosted Linux observed 7.6 s; retain ~4x headroom.
test("negative control: planted direct sink, installer and adoption fail the census", () => {
  const scratch = mkdtempSync(join(tmpdir(),"pairing-owner-census-"));
  try {
    mkdirSync(join(scratch,"packages")); mkdirSync(join(scratch,"apps"));
    writeFileSync(join(scratch,"packages/planted.ts"), 'import {pairingTrustOwner} from "@openscout/runtime/pairing-security"; writeFileSync(join(root,"trusted-peers.json"), "[]"); pairingTrustOwner(root).register(adapter); owner.mutate(0,"id",{type:"manage"});');
    const result = pairingTrustCensus(scratch);
    expect(result.directWriters.length).toBe(1); expect(result.adapterInstallers.length).toBe(1); expect(result.managedAdopters.length).toBe(1);
  } finally { rmSync(scratch,{recursive:true,force:true}); }
});
