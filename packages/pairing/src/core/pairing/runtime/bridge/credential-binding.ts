/** Credential ownership is socket-authenticated, never a request/display ID.
 * This narrow gate does not qualify the general live-transport registry. */
import { pairingTrustOwner, type PairingAuthorityView } from "@openscout/runtime/pairing-security/trust-owner";

interface Authority { readAuthority(): PairingAuthorityView }
interface Identity { readonly publicKey: string; admit(): void }
const identities = new WeakMap<object, Identity>();
const current = new WeakMap<object, Map<string, object>>();

export function createCredentialBinding(
  bridge: object,
  publicKey: string,
  isLive: () => boolean,
  owner: Authority = pairingTrustOwner(),
): object {
  if (!/^[a-f0-9]{64}$/.test(publicKey)) throw new Error("Full authenticated Noise key required");
  const initial = owner.readAuthority();
  if (!isLive() || !initial.peers.some(peer => peer.publicKey === publicKey)) {
    throw new Error("Live paired transport required for SSH credential ownership");
  }
  let bindings = current.get(bridge);
  if (!bindings) { bindings = new Map(); current.set(bridge, bindings); }
  const handle = Object.freeze({});
  let invalid = false;
  const identity = Object.freeze({ publicKey, admit() {
    try {
      if (invalid || !isLive() || bindings!.get(publicKey) !== handle) throw new Error("stale transport");
      const view = owner.readAuthority();
      if (view.stamp !== initial.stamp || !view.peers.some(peer => peer.publicKey === publicKey)) {
        throw new Error("pairing authority changed");
      }
    } catch {
      invalid = true; // A later regrant must never revive this connection.
      throw new Error("SSH credential transport expired; reconnect the paired device");
    }
  } });
  identities.set(handle, identity);
  bindings.set(publicKey, handle);
  return handle;
}

export function requireCredentialIdentity(binding: unknown): Identity {
  const identity = binding && typeof binding === "object" ? identities.get(binding) : undefined;
  if (!identity) throw new Error("Live authenticated SSH credential binding required");
  identity.admit();
  return identity;
}
