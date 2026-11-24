// Private phone/web policy. The public relay has no default HTTP target.
import { resolveWebPort } from "@openscout/runtime/config";
import type { RelayHttpHandler } from "@openscout/runtime/mesh";

export function createPairRelayHttpHandler(pairHttpOrigin?: string | null): RelayHttpHandler {
  return (request, { clientAddress }) => {
    const url = new URL(request.url);
    if (url.pathname === "/pair" && request.method === "GET") {
      return proxyPairHttp(request, url, pairHttpOrigin, clientAddress);
    }
    return undefined;
  };
}

async function proxyPairHttp(
  req: Request,
  url: URL,
  pairHttpOrigin: string | null | undefined,
  clientIp?: string | null,
): Promise<Response> {
  const origin = pairHttpOrigin === undefined
    ? `http://127.0.0.1:${resolveWebPort()}`
    : pairHttpOrigin?.trim() || null;
  if (!origin) {
    return new Response("Pairing HTTP is not configured", { status: 503 });
  }

  const target = new URL("/pair", origin);
  target.search = url.search;
  const headers = pairProxyHeaders(req, clientIp);
  try {
    const response = await fetch(target, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(3_000),
    });
    const out = new Headers();
    for (const name of ["location", "cache-control", "content-type"]) {
      const value = response.headers.get(name);
      if (value) out.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers: out });
  } catch {
    return new Response("Pairing service unreachable", { status: 502 });
  }
}

function pairProxyHeaders(req: Request, clientIp?: string | null): Headers {
  const headers = new Headers();
  for (const name of ["accept", "user-agent", "x-scout-client", "x-scout-device-name"]) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Loopback web uses this trusted edge marker to distinguish a relayed LAN
  // knock from a same-Mac browser request. Always overwrite the client value.
  headers.set("x-scout-pair-relay", "1");
  // This relay is the network edge for /pair. Forwarding headers supplied by
  // the LAN client are untrusted: preserving them would let one device mint
  // distinct approval rows and spoof the address shown to the operator.
  if (clientIp) {
    headers.set("x-forwarded-for", clientIp);
    headers.set("x-real-ip", clientIp);
  }
  return headers;
}
