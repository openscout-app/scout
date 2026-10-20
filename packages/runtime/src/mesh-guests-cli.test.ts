import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test.ts";
import { createScoutCommandContext } from "../../../apps/desktop/src/cli/context.ts";
import { runMeshGuestsCommand } from "../../../apps/desktop/src/cli/commands/mesh-guests.ts";

function output(mode: "plain" | "json" = "json") {
  const lines: string[] = [];
  return { lines, context: createScoutCommandContext({ outputMode: mode, stdout: (line) => lines.push(line) }) };
}

const broker = createBrokerDaemonTestHarness();

test("HTTP-only list, grant, retry, conflict and revoke against an isolated runtime", async () => {
  const h = await broker.startBroker();
  const key = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const args = ["grant", "--public-key", key, "--label", "fixture guest", "--agent", "fabric", "--expires-at", String(Date.now() + 60_000), "--request-id", "cli-guest-1"];
  const call = async (argv: string[], mode: "plain" | "json" = "json") => {
    const out = output(mode);
    await runMeshGuestsCommand(out.context, argv, { brokerUrl: h.baseUrl });
    return out.lines.join("\n");
  };
  expect(JSON.parse(await call([]))).toEqual([]);
  const grant = JSON.parse(await call(args));
  expect(grant.created).toBe(true);
  expect(grant.grant.allowedTargets).toEqual(["fabric"]);
  expect(grant.allowed_targets).toEqual(grant.grant.allowedTargets);
  expect(grant.expires_at).toBe(new Date(grant.grant.expiresAt).toISOString());
  expect(grant.bootstrap.grantId).toBe(grant.grant.id);
  expect(grant.bootstrap.card.keyId).toBe(grant.bootstrap.nodeKeyId);
  // --json works even when called by an extension without the top-level parser.
  expect(JSON.parse(await call(["list", "--json"], "plain"))).toEqual([grant.grant]);
  const confirmed = JSON.parse(await call(args));
  expect(confirmed.created).toBe(false);
  expect(confirmed.grant).toEqual(grant.grant);
  expect(await call(args, "plain")).toContain("scout-tailscale connect --bootstrap grant.json --node-key");
  await expect(call(args.map((arg) => arg === "fabric" ? "other" : arg))).rejects.toThrow("HTTP 409");
  expect(JSON.parse(await call(["revoke", grant.grant.id])).grant.status).toBe("revoked");
  expect(JSON.parse(await call(["revoke", "--request-id", "cli-guest-1"])).ok).toBe(true);
  expect(await call(["list"], "plain")).toContain("revoked");
  await expect(call(["revoke", "gg_missing"])).rejects.toThrow("HTTP 404");
}, 20_000);
