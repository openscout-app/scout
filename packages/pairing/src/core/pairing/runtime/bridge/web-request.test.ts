import { afterEach, describe, expect, test } from "bun:test";

import type { Bridge } from "./bridge.ts";
import { bridgeRouter } from "./router.ts";
import { BRIDGE_WEB_REQUEST_MAX_BYTES, bridgeWebRequest, isAllowedBridgeWebPath } from "./web-request.ts";

type Call = { url: string; init: RequestInit };

function stubFetch(response: () => Response) {
  const calls: Call[] = [];
  const impl = (async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  }) as typeof fetch;
  return { calls, impl };
}

const deps = (impl: typeof fetch) => ({ fetch: impl, baseUrl: () => "http://127.0.0.1:43120", token: () => "tok" });

describe("bridge web path policy", () => {
  test("allows ordinary API reads", () => {
    expect(isAllowedBridgeWebPath("/api/agents")).toBe(true);
    expect(isAllowedBridgeWebPath("/api/tail/recent?limit=40&since=2")).toBe(true);
  });

  test("refuses credential, pairing and access routes", () => {
    for (const path of [
      "/api/bootstrap.js",
      "/api/login",
      "/api/access/session",
      "/api/pairing-state",
      "/api/pairing/requests",
      "/api/invites/abc",
      "/api/scoutbot/credentials",
      "/api/solo-pro/login",
      "/api/solo-pro/login?source=phone",
      "/api/solo-pro/access/check",
      "/api/solo-pro/access/check?source=phone",
      "/api/chat/bootstrap",
    ]) {
      expect(isAllowedBridgeWebPath(path)).toBe(false);
    }
  });

  test("refuses paths that leave /api or hide segments", () => {
    for (const path of ["/", "/pair", "/api", "/api/../pair", "/api/x/%2e%2e/y", "/api/a%2Fb", "/api\\x", "/api/x#y", 42]) {
      expect(isAllowedBridgeWebPath(path)).toBe(false);
    }
  });
});

describe("bridgeWebRequest", () => {
  test("reads this host's web API with the runtime credential", async () => {
    const { calls, impl } = stubFetch(() => Response.json({ agents: [1] }));
    const result = await bridgeWebRequest({ path: "/api/agents?limit=5", method: "GET" }, deps(impl));
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body ?? "")).toEqual({ agents: [1] });
    expect(calls[0]?.url).toBe("http://127.0.0.1:43120/api/agents?limit=5");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer tok");
    expect(calls[0]?.init.redirect).toBe("error");
  });

  test("keeps the status of a failed read", async () => {
    const { impl } = stubFetch(() => Response.json({ error: "nope" }, { status: 404 }));
    const result = await bridgeWebRequest({ path: "/api/agents/x", method: "GET" }, deps(impl));
    expect(result.status).toBe(404);
    expect(result.body).toContain("nope");
  });

  test("carries binary bodies as base64", async () => {
    const { impl } = stubFetch(() => new Response(new Uint8Array([0, 1, 2, 255]), { headers: { "content-type": "image/png" } }));
    const result = await bridgeWebRequest({ path: "/api/blobs/abc", method: "GET" }, deps(impl));
    expect(result.body).toBeUndefined();
    expect(Buffer.from(result.base64 ?? "", "base64")).toEqual(Buffer.from([0, 1, 2, 255]));
  });

  test("refuses writes, refused paths and streams without calling a held-open read", async () => {
    const { calls, impl } = stubFetch(() => new Response("data: 1\n\n", { headers: { "content-type": "text/event-stream" } }));
    expect((await bridgeWebRequest({ path: "/api/send", method: "POST" }, deps(impl))).status).toBe(405);
    expect((await bridgeWebRequest({ path: "/api/bootstrap.js", method: "GET" }, deps(impl))).status).toBe(400);
    for (const action of ["access/check", "login", "install", "restart"]) {
      expect((await bridgeWebRequest({ path: `/api/solo-pro/${action}`, method: "POST" }, deps(impl))).status).toBe(405);
    }
    for (const action of ["access/check", "login"]) {
      expect((await bridgeWebRequest({ path: `/api/solo-pro/${action}`, method: "GET" }, deps(impl))).status).toBe(400);
    }
    expect(calls.length).toBe(0);
    expect((await bridgeWebRequest({ path: "/api/broadcast/stream", method: "GET" }, deps(impl))).status).toBe(406);
  });

  for (const declared of [undefined, "1"]) {
    test(`cancels an oversized stream before buffering it (length ${declared ?? "absent"})`, async () => {
      let pulls = 0;
      let cancelled = false;
      const chunk = new Uint8Array(1024 * 1024);
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(chunk);
          if (pulls === 32) controller.close();
        },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 });
      const { impl } = stubFetch(() => new Response(body, {
        headers: declared ? { "content-length": declared } : {},
      }));
      const result = await bridgeWebRequest({ path: "/api/blobs/large", method: "GET" }, deps(impl));
      expect(result.status).toBe(413);
      expect(cancelled).toBe(true);
      expect(pulls).toBe(BRIDGE_WEB_REQUEST_MAX_BYTES / chunk.byteLength + 1);
    });
  }

  test("refuses oversized bodies and reports an unreachable web service", async () => {
    const big = stubFetch(() => new Response("x", { headers: { "content-length": String(64 * 1024 * 1024) } }));
    expect((await bridgeWebRequest({ path: "/api/agents", method: "GET" }, deps(big.impl))).status).toBe(413);
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect((await bridgeWebRequest({ path: "/api/agents", method: "GET" }, deps(down))).status).toBe(502);
  });
});

describe("web.request procedure", () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.OPENSCOUT_WEB_AUTH_TOKEN;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.OPENSCOUT_WEB_AUTH_TOKEN;
    else process.env.OPENSCOUT_WEB_AUTH_TOKEN = originalToken;
  });

  const caller = (trusted: boolean) =>
    bridgeRouter.createCaller({
      bridge: {} as Bridge,
      cwd: "/tmp/openscout",
      deviceId: trusted ? "abcd1234abcd1234" : undefined,
      secureTransport: trusted,
      trustedPeer: trusted,
    });

  test("needs an encrypted trusted device", async () => {
    await expect(caller(false).web.request({ path: "/api/agents" })).rejects.toThrow(/trusted/);
  });

  test("answers a trusted device", async () => {
    process.env.OPENSCOUT_WEB_AUTH_TOKEN = "test-token";
    const { calls, impl } = stubFetch(() => Response.json({ ok: true }));
    globalThis.fetch = impl;
    const result = await caller(true).web.request({ path: "/api/agents" });
    expect(result.status).toBe(200);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer test-token");
  });
});
