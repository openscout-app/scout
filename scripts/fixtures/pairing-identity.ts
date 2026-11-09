/** Test-only host identity. The trust owner keys its persisted root and object
 * ids from the pairing identity in the same directory, so each temporary
 * store needs one. The key is random per call and never leaves the fixture. */
import {randomBytes} from "node:crypto";
import {existsSync,writeFileSync} from "node:fs";
import {join} from "node:path";

export function writeTestIdentity(root:string, privateKey=randomBytes(32).toString("hex")):string {
  const path=join(root,"identity.json");
  if(!existsSync(path))writeFileSync(path,JSON.stringify({publicKey:"00".repeat(32),privateKey,createdAt:"2026-01-01T00:00:00Z"}),{mode:0o600});
  return path;
}
/** In-process key source for a root the owner itself creates. */
export const testRootKey=(seed="test")=>()=>Buffer.alloc(32,seed);
