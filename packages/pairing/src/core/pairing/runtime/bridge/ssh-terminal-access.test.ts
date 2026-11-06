import { describe, expect, test } from "bun:test";

import {
  createSshHostKeyPin,
  credentialOwnerId,
  SshCredentialOwnershipReviewRequired,
  credentialOwnerId,
  findSshTerminalSessionForDevice,
  isScoutManagedAuthorizedKeyForDevice,
  provisionSshTerminalAccess,
  revokeSshTerminalAccess,
  validateIosGeneratedSshPublicKey,
} from "./ssh-terminal-access.ts";

const KEY_ONE="a".repeat(64),KEY_TWO="b".repeat(64);
const IOS_KEY_A = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC0uMiA4QE9WW2JpcHF4f4aNlJuiqbC4ucLJ0tng5+Y=";
const IOS_KEY_B = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHmAh46VnK29zdbj6vMAGSSvycjZ4eXq7gGrIoF0";
const IOS_ECDSA_KEY = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBE3wjqxVZncxeOC4YB77/HQDvCxP7BbeEN02Qxbb9yfDqYhmWF/hTFwHo+WxpyurKBXEY9JXCJabOEepnKxURVw=";
const NON_SCOUT_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKRihhbVbtf5WmTv+mQv0m92lFf8ZML1C7F+zU5s someone@host";

describe("ssh terminal access provisioning", () => {
  test("adds a deterministic Scout-managed authorized_keys line", () => {
    const initial = `${NON_SCOUT_KEY}\n`;

    const first = provisionSshTerminalAccess({
      authorizedKeys: initial,
      deviceId: KEY_ONE,
      pairingNoisePublicKey: KEY_ONE,
      sshPublicKey: IOS_KEY_A,
      terminalSessionName: "scout-iphone-1234abcd",
    });
    const second = provisionSshTerminalAccess({
      authorizedKeys: initial,
      deviceId: KEY_ONE,
      pairingNoisePublicKey: KEY_ONE,
      sshPublicKey: IOS_KEY_A,
      terminalSessionName: "scout-iphone-1234abcd",
    });

    expect(first.authorizedKeys).toBe(second.authorizedKeys);
    expect(first.changed).toBe(true);
    expect(first.authorizedKeys).toStartWith(`${NON_SCOUT_KEY}\n`);
    expect(first.authorizedKeys).toContain("scout:terminal-access:v1");
    expect(first.grant.authorizedKeyLine).toStartWith("restrict,pty ");
    expect(first.authorizedKeys).toContain(`owner=${credentialOwnerId(KEY_ONE)}`);
    expect(first.authorizedKeys).toContain("session=c2NvdXQtaXBob25lLTEyMzRhYmNk");
    expect(findSshTerminalSessionForDevice(first.authorizedKeys, KEY_ONE))
      .toBe("scout-iphone-1234abcd");
    expect(findSshTerminalSessionForDevice(first.authorizedKeys, KEY_TWO))
      .toBeUndefined();
    expect(first.grant.sshPublicKey.normalizedPublicKey).toBe(IOS_KEY_A);
    expect(first.grant.pairingNoiseFingerprintSha256).toStartWith("SHA256:");
  });

  test("updates one device key while preserving other content", () => {
    const otherDevice = provisionSshTerminalAccess({
      authorizedKeys: "",
      deviceId: KEY_TWO,
      pairingNoisePublicKey: KEY_TWO,
      sshPublicKey: IOS_KEY_A,
    });
    const initial = `${NON_SCOUT_KEY}\n${otherDevice.grant.authorizedKeyLine}\n`;
    const added = provisionSshTerminalAccess({
      authorizedKeys: initial,
      deviceId: KEY_ONE,
      pairingNoisePublicKey: KEY_ONE,
      sshPublicKey: IOS_KEY_A,
    });

    const updated = provisionSshTerminalAccess({
      authorizedKeys: added.authorizedKeys,
      deviceId: KEY_ONE,
      pairingNoisePublicKey: KEY_ONE,
      sshPublicKey: IOS_KEY_B,
    });

    expect(updated.changed).toBe(true);
    expect(updated.authorizedKeys).toContain(NON_SCOUT_KEY);
    expect(updated.authorizedKeys).toContain(otherDevice.grant.authorizedKeyLine);
    expect(updated.authorizedKeys).not.toContain(added.grant.authorizedKeyLine);
    expect(updated.authorizedKeys).toContain(updated.grant.authorizedKeyLine);
    expect(updated.authorizedKeys.match(/scout:terminal-access:v1/g)).toHaveLength(2);
  });

  test("re-provisioning the same key is unchanged after normalization", () => {
    const added = provisionSshTerminalAccess({
      authorizedKeys: `${NON_SCOUT_KEY}\n`,
      deviceId: KEY_ONE,
      pairingNoisePublicKey: KEY_ONE,
      sshPublicKey: IOS_KEY_A,
    });

    const repeated = provisionSshTerminalAccess({
      authorizedKeys: added.authorizedKeys,
      deviceId: KEY_ONE,
      pairingNoisePublicKey: KEY_ONE,
      sshPublicKey: IOS_KEY_A,
    });

    expect(repeated.changed).toBe(false);
    expect(repeated.authorizedKeys).toBe(added.authorizedKeys);
  });

  test("adds an assigned terminal session to a full-key-owned grant", () => {
    const legacy = provisionSshTerminalAccess({
      authorizedKeys: `${NON_SCOUT_KEY}\n`,
      deviceId: KEY_ONE,
      pairingNoisePublicKey: KEY_ONE,
      sshPublicKey: IOS_KEY_A,
    });

    expect(findSshTerminalSessionForDevice(legacy.authorizedKeys, KEY_ONE))
      .toBeUndefined();

    const upgraded = provisionSshTerminalAccess({
      authorizedKeys: legacy.authorizedKeys,
      deviceId: KEY_ONE,
      pairingNoisePublicKey: KEY_ONE,
      sshPublicKey: IOS_KEY_A,
      terminalSessionName: "scout-iphone-1234abcd",
    });

    expect(upgraded.changed).toBe(true);
    const upgradedLines = upgraded.authorizedKeys.split("\n");
    expect(upgradedLines).not.toContain(legacy.grant.authorizedKeyLine);
    expect(upgradedLines).toContain(upgraded.grant.authorizedKeyLine);
    expect(upgraded.authorizedKeys.match(/scout:terminal-access:v1/g)).toHaveLength(1);
    expect(findSshTerminalSessionForDevice(upgraded.authorizedKeys, KEY_ONE))
      .toBe("scout-iphone-1234abcd");
  });

  test("revokes only Scout-managed keys for the requested device", () => {
    const deviceOne = provisionSshTerminalAccess({
      authorizedKeys: `${NON_SCOUT_KEY}\n# keep this comment\n`,
      deviceId: KEY_ONE,
      pairingNoisePublicKey: KEY_ONE,
      sshPublicKey: IOS_KEY_A,
    });
    const deviceTwo = provisionSshTerminalAccess({
      authorizedKeys: deviceOne.authorizedKeys,
      deviceId: KEY_TWO,
      pairingNoisePublicKey: KEY_TWO,
      sshPublicKey: IOS_KEY_B,
    });

    const revoked = revokeSshTerminalAccess({
      authorizedKeys: deviceTwo.authorizedKeys,
      deviceId: KEY_ONE,
      pairingNoisePublicKey: KEY_ONE,
    });

    expect(revoked.changed).toBe(true);
    expect(revoked.removed).toBe(1);
    expect(revoked.authorizedKeys).toContain(NON_SCOUT_KEY);
    expect(revoked.authorizedKeys).toContain("# keep this comment");
    expect(revoked.authorizedKeys).not.toContain(deviceOne.grant.authorizedKeyLine);
    expect(revoked.authorizedKeys).toContain(deviceTwo.grant.authorizedKeyLine);
  });

  test("validates public keys and host key pins without private key persistence", () => {
    const validated = validateIosGeneratedSshPublicKey(`${IOS_KEY_A} ios-comment`);
    const pin = createSshHostKeyPin(IOS_KEY_A);

    expect(validated.normalizedPublicKey).toBe(IOS_KEY_A);
    expect(validated.fingerprintSha256).toStartWith("SHA256:");
    expect(pin).toEqual({
      algorithm: "ssh-ed25519",
      fingerprintSha256: validated.fingerprintSha256,
      publicKey: IOS_KEY_A,
      source: "local-host-ssh-key",
    });
    expect(Object.keys(pin)).not.toContain("privateKey");
    expect(() => validateIosGeneratedSshPublicKey("not-a-key")).toThrow("SSH public key");
    expect(() => validateIosGeneratedSshPublicKey("ssh-dss AAAAB3NzaC1kc3MAAACBA")).toThrow("Unsupported");
  });

  test("accepts supported ECDSA iOS public keys", () => {
    const validated = validateIosGeneratedSshPublicKey(`${IOS_ECDSA_KEY} scoutnext-ios`);

    expect(validated.algorithm).toBe("ecdsa-sha2-nistp256");
    expect(validated.normalizedPublicKey).toBe(IOS_ECDSA_KEY);
    expect(validated.fingerprintSha256).toStartWith("SHA256:");
  });

  test("identifies only Scout-managed authorized key lines for a device", () => {
    const provisioned = provisionSshTerminalAccess({
      authorizedKeys: "",
      deviceId: KEY_ONE,
      pairingNoisePublicKey: KEY_ONE,
      sshPublicKey: IOS_KEY_A,
    });

    expect(isScoutManagedAuthorizedKeyForDevice(provisioned.grant.authorizedKeyLine, KEY_ONE)).toBe(true);
    expect(isScoutManagedAuthorizedKeyForDevice(provisioned.grant.authorizedKeyLine, KEY_TWO)).toBe(false);
    expect(isScoutManagedAuthorizedKeyForDevice(NON_SCOUT_KEY, KEY_ONE)).toBe(false);
  });
});

const collisionA = "1234567890abcdef" + "a".repeat(48), collisionB = "1234567890abcdef" + "b".repeat(48);
const legacy = (device: string, pairing = "unbound", extra = "") =>
  `restrict,pty ${IOS_KEY_A} scout:terminal-access:v0 device=${Buffer.from(device).toString("base64url")} pairing=${pairing} session=${Buffer.from("scout").toString("base64url")} ${extra}`;
for (const proof of ["full-device", "full-fingerprint"]) {
  test(`v0 ${proof} migrates only its exact owner while preserving foreign grants`, () => {
    const line = proof === "full-device" ? legacy(collisionA) : legacy(collisionA.slice(0, 16), credentialOwnerId(collisionA));
    const foreign = legacy(collisionB, credentialOwnerId(collisionB));
    const result = provisionSshTerminalAccess({ authorizedKeys: `${line}\n${foreign}\n`, deviceId: "display-only",
      pairingNoisePublicKey: collisionA, sshPublicKey: IOS_KEY_A, terminalSessionName: "scout" });
    expect(result.authorizedKeys).not.toContain(line.trim());
    expect(result.authorizedKeys).toContain(foreign.trim());
    expect(result.authorizedKeys).toContain(`owner=${credentialOwnerId(collisionA)}`);
    expect(findSshTerminalSessionForDevice(result.authorizedKeys, collisionA)).toBe("scout");
  });
}
test("same-prefix full-key grants cannot replace, inspect or revoke each other", () => {
  const a = provisionSshTerminalAccess({ authorizedKeys: "", deviceId: collisionA.slice(0, 16),
    pairingNoisePublicKey: collisionA, sshPublicKey: IOS_KEY_A, terminalSessionName: "scout-iphone-1234abcd" });
  const b = provisionSshTerminalAccess({ authorizedKeys: a.authorizedKeys, deviceId: collisionB.slice(0, 16),
    pairingNoisePublicKey: collisionB, sshPublicKey: IOS_KEY_B, terminalSessionName: "scout-ipad-1234abcd" });
  expect(b.authorizedKeys).toContain(a.grant.authorizedKeyLine);
  expect(findSshTerminalSessionForDevice(b.authorizedKeys, collisionA)).toBe("scout-iphone-1234abcd");
  const revoked = revokeSshTerminalAccess({ authorizedKeys: b.authorizedKeys, pairingNoisePublicKey: collisionB });
  expect(revoked.authorizedKeys).toContain(a.grant.authorizedKeyLine);
  expect(revoked.authorizedKeys).not.toContain(b.grant.authorizedKeyLine);
});
test("ambiguous production v0 prefixes and conflicting proofs require local review without rewriting input", () => {
  for (const line of [legacy(collisionA.slice(0, 16)), legacy(collisionA, credentialOwnerId(collisionB)),
    legacy(collisionA.slice(0, 16), credentialOwnerId(collisionA), `pairing=${credentialOwnerId(collisionB)}`)]) {
    const input = { authorizedKeys: line + "\n", deviceId: collisionA.slice(0, 16), pairingNoisePublicKey: collisionA, sshPublicKey: IOS_KEY_B };
    expect(() => provisionSshTerminalAccess(input)).toThrow(SshCredentialOwnershipReviewRequired);
    expect(() => findSshTerminalSessionForDevice(input.authorizedKeys, collisionA)).toThrow(SshCredentialOwnershipReviewRequired);
    expect(input.authorizedKeys).toBe(line + "\n");
  }
});
