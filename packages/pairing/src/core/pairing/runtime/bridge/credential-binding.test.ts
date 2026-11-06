import { expect, test } from "bun:test";
import { createCredentialBinding, requireCredentialIdentity } from "./credential-binding.ts";
const a = "1234567890abcdef" + "a".repeat(48), b = "1234567890abcdef" + "b".repeat(48);
function fixture() {
  let stamp = "first", live = true, keys = [a, b];
  const owner = { readAuthority: () => ({ stamp, revision: 1, peers: keys.map(publicKey => ({ publicKey, pairedAt: "now", lastSeen: "now" })) }) };
  const bridge = {};
  return { owner, bridge, alive: () => live, stop: () => { live = false; },
    change: () => { stamp = "second"; }, revoke: () => { stamp = "revoked"; keys = []; },
    regrant: () => { stamp = "regranted"; keys = [a, b]; } };
}
test("credential bindings preserve distinct full keys sharing a display prefix", () => {
  const f = fixture();
  const first = createCredentialBinding(f.bridge, a, f.alive, f.owner);
  const second = createCredentialBinding(f.bridge, b, f.alive, f.owner);
  expect(requireCredentialIdentity(first).publicKey).toBe(a);
  expect(requireCredentialIdentity(second).publicKey).toBe(b);
  expect(() => requireCredentialIdentity({ publicKey: a, admit() {} })).toThrow("binding required");
  expect(() => createCredentialBinding(f.bridge, a.slice(0, 16), f.alive, f.owner)).toThrow("Full authenticated");
});
test("closed or replaced transports cannot retain credential authority", () => {
  const f = fixture();
  const old = createCredentialBinding(f.bridge, a, f.alive, f.owner);
  const next = createCredentialBinding(f.bridge, a, f.alive, f.owner);
  expect(() => requireCredentialIdentity(old)).toThrow("expired");
  expect(requireCredentialIdentity(next).publicKey).toBe(a);
  f.stop();
  expect(() => requireCredentialIdentity(next)).toThrow("expired");
});
test("revoke/regrant between admissions never revives a prior binding", () => {
  const f = fixture(); const old = createCredentialBinding(f.bridge, a, f.alive, f.owner);
  f.revoke(); f.regrant();
  expect(() => requireCredentialIdentity(old)).toThrow("expired");
  expect(requireCredentialIdentity(createCredentialBinding(f.bridge, a, f.alive, f.owner)).publicKey).toBe(a);
});
test("every admission rereads canonical authority and a failure stays terminal", () => {
  const f = fixture(); let fail = false;
  const owner = { readAuthority() { if (fail) throw new Error("unavailable"); return f.owner.readAuthority(); } };
  const binding = createCredentialBinding(f.bridge, a, f.alive, owner);
  const identity = requireCredentialIdentity(binding);
  fail = true; expect(() => identity.admit()).toThrow("expired");
  fail = false; expect(() => identity.admit()).toThrow("expired");
});
