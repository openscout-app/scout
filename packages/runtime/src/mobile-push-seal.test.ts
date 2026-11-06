import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findTrustedPhoneKeyForDevice,
  loadPushSealingKeys,
  openPushContent,
  sealAgentNotificationForDevice,
  sealPushContent,
} from "./mobile-push-seal.js";

function rawKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const priv = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  return { publicKey: Uint8Array.from(pub), privateKey: Uint8Array.from(priv) };
}

describe("sealed push content", () => {
  const mac = rawKeyPair();
  const phone = rawKeyPair();
  const keys = { macPublicKey: mac.publicKey, macPrivateKey: mac.privateKey };
  const plaintext = JSON.stringify({ v: 1, view: "ask", note: "I need you" });

  test("the paired phone opens what the Mac sealed", () => {
    const sealed = sealPushContent({ plaintext, itemId: "item-1", keys, phonePublicKey: phone.publicKey });
    expect(sealed).not.toContain("I need you");
    expect(openPushContent({
      sealed,
      itemId: "item-1",
      phonePrivateKey: phone.privateKey,
      phonePublicKey: phone.publicKey,
      expectedMacPublicKey: mac.publicKey,
    })).toBe(plaintext);
  });

  test("another phone, another item id, or another Mac can't open it", () => {
    const sealed = sealPushContent({ plaintext, itemId: "item-1", keys, phonePublicKey: phone.publicKey });
    const stranger = rawKeyPair();
    expect(() => openPushContent({ sealed, itemId: "item-1", phonePrivateKey: stranger.privateKey, phonePublicKey: stranger.publicKey })).toThrow();
    expect(() => openPushContent({ sealed, itemId: "item-2", phonePrivateKey: phone.privateKey, phonePublicKey: phone.publicKey })).toThrow();
    expect(() => openPushContent({
      sealed,
      itemId: "item-1",
      phonePrivateKey: phone.privateKey,
      phonePublicKey: phone.publicKey,
      expectedMacPublicKey: stranger.publicKey,
    })).toThrow("unexpected Mac");
  });

  test("a registration's deviceId finds its trusted phone by key prefix", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-push-seal-"));
    const phoneHex = Buffer.from(phone.publicKey).toString("hex");
    writeFileSync(join(dir, "identity.json"), JSON.stringify({
      publicKey: Buffer.from(mac.publicKey).toString("hex"),
      privateKey: Buffer.from(mac.privateKey).toString("hex"),
    }));
    writeFileSync(join(dir, "trusted-peers.json"), JSON.stringify([{ publicKey: phoneHex, pairedAt: "2026-09-24" }]));

    expect(loadPushSealingKeys(dir)?.macPublicKey).toEqual(mac.publicKey);
    expect(findTrustedPhoneKeyForDevice(phoneHex.slice(0, 16), dir)).toEqual(phone.publicKey);
    expect(findTrustedPhoneKeyForDevice("0000000000000000", dir)).toBeNull();
    expect(findTrustedPhoneKeyForDevice("not-a-device", dir)).toBeNull();
  });

  test("an agent notification seals for a trusted device and falls back to text when too large", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-push-seal-"));
    const phoneHex = Buffer.from(phone.publicKey).toString("hex");
    writeFileSync(join(dir, "trusted-peers.json"), JSON.stringify([{ publicKey: phoneHex, pairedAt: "2026-09-24" }]));
    const base = { v: 1 as const, itemId: "item-9", sender: { name: "fab" }, level: "time-sensitive" as const, createdAt: 1 };
    const open = (sealed: string) => JSON.parse(openPushContent({
      sealed, itemId: "item-9", phonePrivateKey: phone.privateKey, phonePublicKey: phone.publicKey,
    }));

    const small = sealAgentNotificationForDevice({ ...base, view: "ask", note: "I need you" }, phoneHex.slice(0, 16), { keys, pairingDir: dir });
    expect(open(small!)).toMatchObject({
      view: "ask",
      note: "I need you",
      urgent: true,
      lockScreen: { title: "fab is waiting on your answer", body: "I need you", category: "scout.question", threadId: "scout.agent.fab", level: "time-sensitive" },
    });

    const big = sealAgentNotificationForDevice({
      ...base,
      view: "turn.approve.edit",
      risk: "medium",
      files: Array.from({ length: 8 }, (_, i) => ({ path: `${"深い/".repeat(60)}file-${i}.ts`, added: 1, removed: 1 })),
      summary: "要約".repeat(150),
    }, phoneHex.slice(0, 16), { keys, pairingDir: dir });
    expect(big!.length).toBeLessThanOrEqual(2800);
    expect(open(big!)).toMatchObject({ view: "text", title: "Wants to edit 8 files" });

    expect(sealAgentNotificationForDevice({ ...base, view: "ask", note: "x" }, "0000000000000000", { keys, pairingDir: dir })).toBeNull();
    expect(sealAgentNotificationForDevice({ ...base, view: "ask", note: "x" }, phoneHex.slice(0, 16), { keys: null, pairingDir: dir })).toBeNull();
  });
});
