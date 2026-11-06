import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  broadcastApnsAlertToActiveMobileDevices,
  closeMobilePushDb,
  listActiveMobilePushRegistrations,
  listMobilePushRegistrations,
  syncMobilePushRegistration,
} from "./mobile-push.ts";
import { openPushContent } from "./mobile-push-seal.ts";
import { SQLiteControlPlaneStore } from "./sqlite-store.ts";

const tempRoots = new Set<string>();
const originalControlHome = process.env.OPENSCOUT_CONTROL_HOME;
const originalFetch = globalThis.fetch;
const originalPairingDir = process.env.OPENSCOUT_PAIRING_DIR;
const originalRelayUrl = process.env.OPENSCOUT_PUSH_RELAY_URL;
const originalRelaySession = process.env.OPENSCOUT_PUSH_RELAY_SESSION;
const originalRelayMeshId = process.env.OPENSCOUT_PUSH_RELAY_MESH_ID;
const originalApnsTeamId = process.env.OPENSCOUT_APNS_TEAM_ID;
const originalApnsKeyId = process.env.OPENSCOUT_APNS_KEY_ID;
const originalApnsPrivateKey = process.env.OPENSCOUT_APNS_PRIVATE_KEY;
const originalApnsPrivateKeyPath = process.env.OPENSCOUT_APNS_PRIVATE_KEY_PATH;

afterEach(() => {
  closeMobilePushDb();
  globalThis.fetch = originalFetch;
  if (originalControlHome === undefined) {
    delete process.env.OPENSCOUT_CONTROL_HOME;
  } else {
    process.env.OPENSCOUT_CONTROL_HOME = originalControlHome;
  }
  for (const [key, value] of [
    ["OPENSCOUT_PAIRING_DIR", originalPairingDir],
    ["OPENSCOUT_PUSH_RELAY_URL", originalRelayUrl],
    ["OPENSCOUT_PUSH_RELAY_SESSION", originalRelaySession],
    ["OPENSCOUT_PUSH_RELAY_MESH_ID", originalRelayMeshId],
    ["OPENSCOUT_APNS_TEAM_ID", originalApnsTeamId],
    ["OPENSCOUT_APNS_KEY_ID", originalApnsKeyId],
    ["OPENSCOUT_APNS_PRIVATE_KEY", originalApnsPrivateKey],
    ["OPENSCOUT_APNS_PRIVATE_KEY_PATH", originalApnsPrivateKeyPath],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createControlPlaneRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openscout-mobile-push-"));
  tempRoots.add(root);
  process.env.OPENSCOUT_CONTROL_HOME = root;
  const store = new SQLiteControlPlaneStore(join(root, "control-plane.sqlite"));
  store.close();
  return root;
}

describe("mobile push registrations", () => {
  test("upserts and updates the active registration for a device/environment", () => {
    createControlPlaneRoot();

    const first = syncMobilePushRegistration({
      deviceId: "device-1",
      platform: "ios",
      appBundleId: "app.openscout.scout",
      apnsEnvironment: "development",
      authorizationStatus: "authorized",
      pushToken: "AA BB CC 11",
      appVersion: "0.2.5",
      buildNumber: "12",
    });
    expect(first.registered).toBe(true);

    let rows = listMobilePushRegistrations();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pushToken).toBe("aabbcc11");
    expect(rows[0]?.appVersion).toBe("0.2.5");

    const second = syncMobilePushRegistration({
      deviceId: "device-1",
      platform: "ios",
      appBundleId: "app.openscout.scout",
      apnsEnvironment: "development",
      authorizationStatus: "authorized",
      pushToken: "ddeeff22",
      appVersion: "0.2.6",
      buildNumber: "13",
    });
    expect(second.registered).toBe(true);

    rows = listMobilePushRegistrations();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pushToken).toBe("ddeeff22");
    expect(rows[0]?.appVersion).toBe("0.2.6");
    expect(listActiveMobilePushRegistrations()).toHaveLength(1);
  });

  test("removes a registration when notification authorization is revoked", () => {
    createControlPlaneRoot();

    syncMobilePushRegistration({
      deviceId: "device-1",
      platform: "ios",
      appBundleId: "app.openscout.scout",
      apnsEnvironment: "development",
      authorizationStatus: "authorized",
      pushToken: "deadbeef",
    });
    expect(listActiveMobilePushRegistrations()).toHaveLength(1);

    const result = syncMobilePushRegistration({
      deviceId: "device-1",
      platform: "ios",
      appBundleId: "app.openscout.scout",
      apnsEnvironment: "development",
      authorizationStatus: "denied",
      pushToken: null,
    });

    expect(result.removed).toBe(true);
    expect(listMobilePushRegistrations()).toHaveLength(0);
    expect(listActiveMobilePushRegistrations()).toHaveLength(0);
  });

  test("reassigns an existing token to the latest device registration", () => {
    createControlPlaneRoot();

    syncMobilePushRegistration({
      deviceId: "device-1",
      platform: "ios",
      appBundleId: "app.openscout.scout",
      apnsEnvironment: "development",
      authorizationStatus: "authorized",
      pushToken: "cafebabe",
    });

    const result = syncMobilePushRegistration({
      deviceId: "device-2",
      platform: "ios",
      appBundleId: "app.openscout.scout",
      apnsEnvironment: "development",
      authorizationStatus: "authorized",
      pushToken: "cafebabe",
    });

    expect(result.registered).toBe(true);

    const rows = listMobilePushRegistrations();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deviceId).toBe("device-2");
    expect(rows[0]?.pushToken).toBe("cafebabe");
  });
});

describe("mobile push relay", () => {
  test("preserves quiet operator-signal correlation without forwarding content", async () => {
    process.env.OPENSCOUT_PUSH_RELAY_URL = "https://push.example.test";
    process.env.OPENSCOUT_PUSH_RELAY_SESSION = "osn_session_test";
    process.env.OPENSCOUT_PUSH_RELAY_MESH_ID = "mesh-1";
    let requestUrl = "";
    let requestBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        attemptedCount: 1,
        deliveredCount: 1,
        failedCount: 0,
        failures: [],
      });
    }) as typeof fetch;

    const result = await broadcastApnsAlertToActiveMobileDevices({
      title: "Agent update",
      body: "This content must not leave the broker.",
      sound: null,
      urgency: "silent",
      payload: {
        destination: "inbox",
        kind: "operator_signal",
        signalKind: "notify",
        messageId: "msg-1",
        conversationId: "dm.agent.operator",
        requesterId: "human-readable-agent-name",
      },
    });

    expect(result.deliveredCount).toBe(1);
    expect(requestUrl).toBe("https://push.example.test/v1/push");
    expect(requestBody).toEqual({
      meshId: "mesh-1",
      itemId: "msg-1",
      kind: "operator_signal",
      urgency: "silent",
      payload: {
        destination: "inbox",
        kind: "operator_signal",
        signalKind: "notify",
        messageId: "msg-1",
        conversationId: "dm.agent.operator",
        itemId: "msg-1",
      },
    });
    expect(JSON.stringify(requestBody)).not.toContain("This content");
    expect(JSON.stringify(requestBody)).not.toContain("human-readable-agent-name");
  });
  test("seals an agent notification per paired phone and sends it to that device only", async () => {
    const root = createControlPlaneRoot();
    const rawKeys = () => {
      const pair = generateKeyPairSync("x25519");
      return {
        publicKey: pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32),
        privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32),
      };
    };
    const mac = rawKeys();
    const phone = rawKeys();
    const phoneHex = phone.publicKey.toString("hex");
    process.env.OPENSCOUT_PAIRING_DIR = join(root, ".scout", "pairing");
    mkdirSync(join(root, ".scout", "pairing"), { recursive: true });
    writeFileSync(join(root, ".scout", "pairing", "identity.json"), JSON.stringify({
      publicKey: mac.publicKey.toString("hex"),
      privateKey: mac.privateKey.toString("hex"),
    }));
    writeFileSync(join(root, ".scout", "pairing", "trusted-peers.json"), JSON.stringify([
      { publicKey: phoneHex, pairedAt: "2026-09-24" },
    ]));
    for (const [deviceId, token] of [[phoneHex.slice(0, 16), "aa11"], ["unpaired-device", "bb22"]] as const) {
      syncMobilePushRegistration({
        deviceId,
        platform: "ios",
        appBundleId: "app.openscout.scout",
        apnsEnvironment: "production",
        authorizationStatus: "authorized",
        pushToken: token,
      });
    }

    process.env.OPENSCOUT_PUSH_RELAY_URL = "https://push.example.test";
    process.env.OPENSCOUT_PUSH_RELAY_SESSION = "osn_session_test";
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ attemptedCount: 1, deliveredCount: 1, failedCount: 0, failures: [] });
    }) as typeof fetch;

    const result = await broadcastApnsAlertToActiveMobileDevices({
      title: "Scout needs attention",
      body: "A local agent is asking for input.",
      urgency: "interrupt",
      payload: { destination: "inbox", itemId: "item-1", kind: "approval" },
      notification: {
        v: 1,
        itemId: "item-1",
        sender: { name: "machiavelli" },
        project: "openscout",
        level: "active",
        createdAt: 1,
        view: "turn.approve.command",
        command: "bash apps/ios/scripts/release.sh",
        risk: "high",
      },
    });

    expect(result.deliveredCount).toBe(2);
    expect(bodies.map((body) => body.deviceId).sort()).toEqual([phoneHex.slice(0, 16), "unpaired-device"].sort());
    const sealedBody = bodies.find((body) => body.deviceId === phoneHex.slice(0, 16))!;
    const plainBody = bodies.find((body) => body.deviceId === "unpaired-device")!;
    expect(sealedBody.category).toBe("scout.approval");
    expect(plainBody.sealed).toBeUndefined();
    expect(JSON.stringify(bodies)).not.toContain("release.sh");
    const opened = JSON.parse(openPushContent({
      sealed: String(sealedBody.sealed),
      itemId: "item-1",
      phonePrivateKey: phone.privateKey,
      phonePublicKey: phone.publicKey,
      expectedMacPublicKey: mac.publicKey,
    }));
    expect(opened).toMatchObject({ view: "turn.approve.command", command: "bash apps/ios/scripts/release.sh" });
  });

  test("reports the relay's refusal and stops there when there is no APNs key", async () => {
    createControlPlaneRoot();
    process.env.OPENSCOUT_PUSH_RELAY_URL = "https://push.example.test";
    process.env.OPENSCOUT_PUSH_RELAY_SESSION = "osn_session_expired";
    delete process.env.OPENSCOUT_APNS_TEAM_ID;
    delete process.env.OPENSCOUT_APNS_KEY_ID;
    delete process.env.OPENSCOUT_APNS_PRIVATE_KEY;

    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }) as typeof fetch;

    const result = await broadcastApnsAlertToActiveMobileDevices({
      title: "An agent is asking",
      body: "Open Scout for details.",
      sound: "default",
      urgency: "interrupt",
      payload: { destination: "inbox", kind: "operator_signal", messageId: "msg-9" },
    });

    expect(calls).toBe(1);
    expect(result.deliveredCount).toBe(0);
    expect(result.failures.map(failure => failure.status)).toEqual([401]);
  });

  test("falls through to direct APNs when the relay rejects our credential", async () => {
    createControlPlaneRoot();
    syncMobilePushRegistration({
      deviceId: "device-fallback",
      platform: "ios",
      appBundleId: "app.openscout.scout",
      apnsEnvironment: "development",
      authorizationStatus: "authorized",
      pushToken: "deadbeef",
    });

    process.env.OPENSCOUT_PUSH_RELAY_URL = "https://push.example.test";
    process.env.OPENSCOUT_PUSH_RELAY_SESSION = "osn_session_expired";
    process.env.OPENSCOUT_APNS_TEAM_ID = "TEAM123456";
    process.env.OPENSCOUT_APNS_KEY_ID = "KEY1234567";
    process.env.OPENSCOUT_APNS_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----";

    globalThis.fetch = (async (input) => {
      if (String(input).startsWith("https://push.example.test")) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return Response.json({ reason: "BadDeviceToken" }, { status: 400 });
    }) as typeof fetch;

    const result = await broadcastApnsAlertToActiveMobileDevices({
      title: "An agent is asking",
      body: "Open Scout for details.",
      sound: "default",
      urgency: "interrupt",
      payload: { destination: "inbox", kind: "operator_signal", messageId: "msg-10" },
    });

    // The registered device was actually tried, and the relay's refusal is
    // still on the record rather than swallowed by the fallback.
    expect(result.attemptedCount).toBe(1);
    expect(result.failures.some(failure => failure.status === 401)).toBe(true);
    expect(result.failures.length).toBeGreaterThan(1);
  });
  test("does not re-send directly when the relay delivered but reported a per-device 403", async () => {
    createControlPlaneRoot();
    syncMobilePushRegistration({
      deviceId: "device-a",
      platform: "ios",
      appBundleId: "app.openscout.scout",
      apnsEnvironment: "development",
      authorizationStatus: "authorized",
      pushToken: "aaaaaaaa",
    });

    process.env.OPENSCOUT_PUSH_RELAY_URL = "https://push.example.test";
    process.env.OPENSCOUT_PUSH_RELAY_SESSION = "osn_session_live";
    process.env.OPENSCOUT_APNS_TEAM_ID = "TEAM123456";
    process.env.OPENSCOUT_APNS_KEY_ID = "KEY1234567";
    process.env.OPENSCOUT_APNS_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----";

    let apnsCalls = 0;
    globalThis.fetch = (async (input) => {
      if (String(input).startsWith("https://push.example.test")) {
        // The relay accepted the alert; one of ITS devices came back 403.
        return Response.json({
          attemptedCount: 2,
          deliveredCount: 1,
          failedCount: 1,
          failures: [{ deviceId: "device-b", status: 403, reason: "InvalidProviderToken" }],
        });
      }
      apnsCalls += 1;
      return Response.json({}, { status: 200 });
    }) as typeof fetch;

    const result = await broadcastApnsAlertToActiveMobileDevices({
      title: "An agent is asking",
      body: "Open Scout for details.",
      sound: "default",
      urgency: "interrupt",
      payload: { destination: "inbox", kind: "operator_signal", messageId: "msg-11" },
    });

    expect(apnsCalls).toBe(0);
    expect(result.deliveredCount).toBe(1);
    expect(result.failures.map(failure => failure.deviceId)).toEqual(["device-b"]);
  });

  test("treats an unreadable APNs key path as no key rather than throwing", async () => {
    createControlPlaneRoot();
    process.env.OPENSCOUT_PUSH_RELAY_URL = "https://push.example.test";
    process.env.OPENSCOUT_PUSH_RELAY_SESSION = "osn_session_expired";
    delete process.env.OPENSCOUT_APNS_PRIVATE_KEY;
    process.env.OPENSCOUT_APNS_TEAM_ID = "TEAM123456";
    process.env.OPENSCOUT_APNS_KEY_ID = "KEY1234567";
    process.env.OPENSCOUT_APNS_PRIVATE_KEY_PATH = join(tmpdir(), "openscout-missing-apns-key.p8");

    globalThis.fetch = (async () =>
      Response.json({ error: "unauthorized" }, { status: 401 })) as typeof fetch;

    const result = await broadcastApnsAlertToActiveMobileDevices({
      title: "An agent is asking",
      body: "Open Scout for details.",
      sound: "default",
      urgency: "interrupt",
      payload: { destination: "inbox", kind: "operator_signal", messageId: "msg-12" },
    });

    expect(result.failures.map(failure => failure.status)).toEqual([401]);
  });
});
