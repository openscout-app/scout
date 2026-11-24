// Lives in @openscout/runtime so this machine's own readers (broker, web
// server) speak the same Noise transport as the bridge.
export {
  dh,
  generateKeyPair,
  NoiseHandshake,
  type HandshakePattern,
  type KeyPair,
  type NoiseSession,
  type Role,
} from "@openscout/runtime/pairing-security";
