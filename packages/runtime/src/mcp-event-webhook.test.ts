import { expect, test } from "bun:test";
import { Webhook } from "standardwebhooks";
import { isPublicWebhookAddress, parseWebhookUrl, postWebhook, validateWebhookSecret, verifyWebhook, webhookHeaders } from "./mcp-event-webhook.js";
const secret = `whsec_${Buffer.alloc(32, 1).toString("base64")}`;
const rotated = `whsec_${Buffer.alloc(32, 2).toString("base64")}`;

test("callback policy rejects local/private/reserved destinations including mapped IPv6", async () => {
  for (const ip of ["127.0.0.1", "0.0.0.0", "10.1.1.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.1.1", "192.0.2.1", "198.18.0.1", "224.0.0.1", "255.255.255.255", "::1", "::", "fc00::1", "fe80::1", "2001:db8::1", "::ffff:127.0.0.1", "64:ff9b::a00:1"]) expect(isPublicWebhookAddress(ip)).toBe(false);
  expect(isPublicWebhookAddress("1.1.1.1")).toBe(true);
  expect(isPublicWebhookAddress("2606:4700:4700::1111")).toBe(true);
  for (const url of ["http://example.com", "https://user:pass@example.com", "https://example.com:8443", "https://example.com/#fragment"]) expect(() => parseWebhookUrl(url)).toThrow();
  await expect(postWebhook("https://127.0.0.1/", "{}", {})).rejects.toThrow("not public");
});

test("secret validation and Standard Webhooks rotation use exact bytes", () => {
  validateWebhookSecret(secret);
  for (const key of ["", "whsec_eA==", `whsec_${Buffer.alloc(65).toString("base64")}`, "whsec_!!!!"]) expect(() => validateWebhookSecret(key)).toThrow();
  const body = '{"text":"café"}';
  const headers = webhookHeaders("evt_1", "sub_1", body, rotated, secret);
  expect(new Webhook(secret).verify(body, headers)).toEqual({ text: "café" });
  expect(new Webhook(rotated).verify(body, headers)).toEqual({ text: "café" });
  expect(() => new Webhook(secret).verify(`${body} `, headers)).toThrow();
});

test("verification requires a signed, fresh challenge with a 2xx exact echo", async () => {
  const ids = new Set();
  for (let i = 0; i < 2; i++) await verifyWebhook("https://example.com", "sub_1", secret, async (_url, body, headers) => {
    const payload = new Webhook(secret).verify(body, headers) as { type: string; challenge: string };
    expect(payload.type).toBe("verification"); expect(ids.has(payload.challenge)).toBe(false); ids.add(payload.challenge);
    return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
  });
  for (const status of [200, 302, 410]) await expect(verifyWebhook("https://example.com", "sub_1", secret, async () => ({ status, body: '{"challenge":"wrong"}' }))).rejects.toMatchObject({ code: -32027, data: { reason: status === 410 ? "http_4xx" : "challenge_failed" } });
});
