import { describe, expect, test } from "bun:test";

import {
  TURN_CREDENTIAL_PROTOCOL,
  base64UrlToBytes,
  bytesToBase64Url,
  decodeTurnCredential,
  encodeTurnCredential,
  turnCredentialSigningInput,
  verifyTurnCredentialOffline,
  type TurnCredentialClaims,
} from "./turn-credentials.js";

const NOW = 1_800_000_000_000;
const claims: TurnCredentialClaims = {
  protocol: TURN_CREDENTIAL_PROTOCOL,
  id: "turn-abc",
  issuerKeyId: "key-1",
  nodeId: "node-a",
  invocationId: "inv-1",
  flightId: "flt-1",
  agentId: "helper.main.node-a",
  initiatorId: "operator",
  initiatorSource: "local-admin",
  scope: ["read", "write"],
  issuedAt: NOW,
  expiresAt: NOW + 60_000,
};

async function keyPair() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return { pair, publicKey: Buffer.from(spki).toString("base64") };
}

async function issue(value: TurnCredentialClaims, privateKey: CryptoKey): Promise<string> {
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, turnCredentialSigningInput(value)));
  return encodeTurnCredential(value, signature);
}

describe("turn credentials", () => {
  test("base64url round-trips bytes and rejects loose encodings", () => {
    for (const length of [0, 1, 2, 3, 4, 31, 64]) {
      const bytes = new Uint8Array(length).map((_, index) => (index * 37 + 11) & 0xff);
      expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
      expect(bytesToBase64Url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
    }
    expect(base64UrlToBytes("AB")).toBeNull();
    expect(base64UrlToBytes("A+==")).toBeNull();
  });

  test("a signed credential verifies offline and decodes to its claims", async () => {
    const { pair, publicKey } = await keyPair();
    const token = await issue(claims, pair.privateKey);
    expect(token.startsWith("st1.")).toBe(true);
    expect(decodeTurnCredential(token).claims).toEqual(claims);
    expect(await verifyTurnCredentialOffline(token, publicKey, { now: NOW + 1 })).toEqual(claims);
  });

  test("another key, an edited claim or an expired credential is refused", async () => {
    const { pair } = await keyPair();
    const other = await keyPair();
    const token = await issue(claims, pair.privateKey);
    await expect(verifyTurnCredentialOffline(token, other.publicKey, { now: NOW })).rejects.toMatchObject({ code: "turn_credential_signature" });

    const [prefix, , signature] = token.split(".");
    const widened = bytesToBase64Url(turnCredentialSigningInput({ ...claims, scope: ["read", "write", "manage"] }));
    const { publicKey } = { publicKey: Buffer.from(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))).toString("base64") };
    await expect(verifyTurnCredentialOffline(`${prefix}.${widened}.${signature}`, publicKey, { now: NOW })).rejects.toMatchObject({ code: "turn_credential_signature" });
    await expect(verifyTurnCredentialOffline(token, publicKey, { now: claims.expiresAt })).rejects.toMatchObject({ code: "turn_credential_expired" });
    await expect(verifyTurnCredentialOffline(token, publicKey, { now: NOW - 60_000 })).rejects.toMatchObject({ code: "turn_credential_expired" });
  });

  test("malformed credentials are refused before any signature check", () => {
    const bad = [
      "",
      "st1.x",
      "st2.e30.AAAA",
      `st1.${bytesToBase64Url(new TextEncoder().encode(JSON.stringify(claims)))}.${bytesToBase64Url(new Uint8Array(64))}`,
      `st1.${bytesToBase64Url(turnCredentialSigningInput({ ...claims, expiresAt: claims.issuedAt + 3 * 60 * 60_000 }))}.${bytesToBase64Url(new Uint8Array(64))}`,
      `st1.${bytesToBase64Url(turnCredentialSigningInput({ ...claims, scope: ["delete" as "read"] }))}.${bytesToBase64Url(new Uint8Array(64))}`,
      `st1.${bytesToBase64Url(turnCredentialSigningInput(claims))}.${bytesToBase64Url(new Uint8Array(10))}`,
    ];
    for (const token of bad) expect(() => decodeTurnCredential(token)).toThrow();
  });
});
