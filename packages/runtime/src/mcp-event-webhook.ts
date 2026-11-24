import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Webhook } from "standardwebhooks";

export class McpEventError extends Error {
  readonly data?: Record<string, unknown>;
  constructor(readonly code: number, message: string, detail?: Record<string, unknown> | string) {
    super(message);
    this.data = typeof detail === "string" ? { reason: detail } : detail;
  }
  get reason(): string | undefined { return typeof this.data?.reason === "string" ? this.data.reason : undefined; }
}

export function parseWebhookUrl(value: unknown): URL {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw new McpEventError(-32602, "Invalid callback URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) {
    throw new McpEventError(-32602, "Callback must be HTTPS on port 443 without credentials or a fragment");
  }
  return url;
}

export function validateWebhookSecret(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new McpEventError(-32602, "Invalid webhook signing secret");
  }
  const encoded = value.slice(6);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < 24 || bytes.length > 64 || bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
    throw new McpEventError(-32602, "Webhook signing key must contain 24–64 bytes");
  }
}

export function isPublicWebhookAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === "unicast"; } catch { return false; }
}

export type WebhookPost = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>;

/** Resolve on every connection and pin the socket to the validated address. TLS still verifies the original host. */
export const postWebhook: WebhookPost = async (rawUrl, body, headers) => {
  const url = parseWebhookUrl(rawUrl);
  if (Buffer.byteLength(body) > 256 * 1024) throw new McpEventError(-32602, "Event payload exceeds 256 KiB");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const signal = AbortSignal.timeout(10_000);
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    lookup(hostname, { all: true }).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
  if (!addresses.length || addresses.some(({ address }) => !isPublicWebhookAddress(address))) {
    throw new McpEventError(-32602, "Callback address is not public");
  }
  const address = addresses[0]!;
  const destination = new URL(url);
  destination.hostname = address.family === 6 ? `[${address.address}]` : address.address;
  return new Promise((resolve, reject) => {
    const req = request(destination, {
      method: "POST", agent: false, family: address.family,
      // Connect to the literal validated IP, even on runtimes that ignore custom lookup functions.
      // TLS verifies the original hostname; HTTP routes using the original authority.
      servername: isIP(hostname) ? undefined : hostname,
      headers: { ...headers, host: url.host, "content-length": String(Buffer.byteLength(body)) },
      signal,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16 * 1024) { res.destroy(new Error("Callback response too large")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
};

export function webhookHeaders(id: string, subscriptionId: string, body: string, secret: string, previousSecret?: string, now = Date.now()) {
  const at = new Date(now);
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(Math.floor(now / 1000)),
    "webhook-signature": [secret, previousSecret].filter((key): key is string => Boolean(key))
      .map((key) => new Webhook(key).sign(id, at, body)).join(" "),
    "X-MCP-Subscription-Id": subscriptionId,
  };
}

export async function verifyWebhook(url: string, subscriptionId: string, secret: string, post: WebhookPost = postWebhook) {
  const challenge = randomUUID();
  const id = `msg_verification_${randomUUID()}`;
  const body = JSON.stringify({ type: "verification", challenge });
  try {
    const response = await post(url, body, webhookHeaders(id, subscriptionId, body, secret));
    if (response.status >= 400) throw new McpEventError(-32027, "Callback verification failed", { reason: response.status >= 500 ? "http_5xx" : "http_4xx" });
    let actual: unknown;
    try { actual = JSON.parse(response.body)?.challenge; } catch { /* The receiver did not echo the challenge. */ }
    if (response.status < 200 || response.status >= 300 || typeof actual !== "string" ||
      Buffer.byteLength(actual) !== Buffer.byteLength(challenge) || !timingSafeEqual(Buffer.from(actual), Buffer.from(challenge))) {
      throw new McpEventError(-32027, "Callback verification failed", { reason: "challenge_failed" });
    }
  } catch (error) {
    if (error instanceof McpEventError) throw error;
    const code = String((error as NodeJS.ErrnoException)?.code ?? "");
    let reason = "connection_refused";
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) || code === "ETIMEDOUT") reason = "timeout";
    else if (/TLS|CERT|SSL/.test(code)) reason = "tls_error";
    throw new McpEventError(-32027, "Callback verification failed", { reason });
  }
}
