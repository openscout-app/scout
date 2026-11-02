import { describe, expect, test } from "bun:test";

import { webStartContextFromRequest } from "./broker-web-control-service.js";
import { classifyMeshTransport } from "./mesh-ingress-gate.js";
import { refusesLoopbackHttpProxy } from "./mesh-loopback-proxy.js";
import { webStartRequestHeaders } from "./web-start-context.js";

describe("web start context", () => {
  test("the base's start request passes the loopback gate and names the portal", () => {
    const headers = { accept: "application/json", ...webStartRequestHeaders("scout.local", "https") };

    expect(refusesLoopbackHttpProxy(classifyMeshTransport("127.0.0.1"), headers)).toBe(false);
    expect(refusesLoopbackHttpProxy(classifyMeshTransport("::1"), headers)).toBe(false);
    expect(webStartContextFromRequest({ headers })).toEqual({
      publicOrigin: "https://scout.local",
      trustedHost: "scout.local",
    });
  });

  test("the forwarding headers the base used to send are refused", () => {
    const headers = { "x-forwarded-host": "scout.local", "x-forwarded-proto": "https" };

    expect(refusesLoopbackHttpProxy(classifyMeshTransport("127.0.0.1"), headers)).toBe(true);
  });
});
