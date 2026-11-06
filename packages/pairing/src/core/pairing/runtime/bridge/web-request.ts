// web.request: a paired device reads this host's own web API over the
// encrypted bridge channel, so a browser away from the host can show the same
// views the local portal shows. The bridge calls its own web server with the
// runtime's credential, the same way the runtime's host web RPC does
// (packages/runtime/src/broker-web-control-service.ts `requestForHost`).
//
// GET only for now: a paired browser watches. Credential routes never pass,
// whatever the method, and streams are refused rather than held open.

import { resolveWebAuthToken, resolveWebPort } from "@openscout/runtime/local-config";

export const BRIDGE_WEB_REQUEST_MAX_BYTES = 16 * 1024 * 1024;
const BRIDGE_WEB_REQUEST_TIMEOUT_MS = 15_000;
const MAX_PATH_LENGTH = 4096;

export interface BridgeWebRequestInput {
  path: string;
  method: string;
}

export interface BridgeWebResponse {
  status: number;
  contentType: string | null;
  /** Text bodies (JSON, text, JavaScript). */
  body?: string;
  /** Anything else, base64-encoded. */
  base64?: string;
}

export interface BridgeWebRequestDeps {
  fetch?: typeof fetch;
  baseUrl?: () => string;
  token?: () => string;
}

/** Routes that mint, read or change credentials, pairing or access. */
const CREDENTIAL_ROUTES: RegExp[] = [
  /^\/api\/bootstrap\.js$/,
  /^\/api\/(login|logout)$/,
  /^\/api\/access(\/|$)/,
  /^\/api\/pairing(\/|-state|$)/,
  /^\/api\/invites(\/|$)/,
  /^\/api\/scoutbot\/credentials(\/|$)/,
  /^\/api\/solo-pro\/(login|access)(\/|$)/,
  /^\/api\/chat\/bootstrap$/,
];

/** Path hygiene mirrors `isAllowedHostWebRequest` in the runtime. */
export function isAllowedBridgeWebPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length > MAX_PATH_LENGTH) return false;
  if (!path.startsWith("/api/") || /[\\#]|%2[fFeE]|%5[cC]/.test(path)) return false;
  const pathname = path.split("?")[0] ?? "";
  if (new URL(path, "http://localhost").pathname !== pathname) return false;
  return !CREDENTIAL_ROUTES.some((route) => route.test(pathname));
}

function errorResponse(status: number, error: string): BridgeWebResponse {
  return { status, contentType: "application/json", body: JSON.stringify({ error }) };
}

function isTextual(contentType: string | null): boolean {
  if (!contentType) return true;
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return type.startsWith("text/") || type === "application/json" || type.endsWith("+json")
    || type === "application/javascript" || type === "application/x-ndjson";
}

export async function bridgeWebRequest(
  input: BridgeWebRequestInput,
  deps: BridgeWebRequestDeps = {},
): Promise<BridgeWebResponse> {
  if (input.method.toUpperCase() !== "GET") {
    return errorResponse(405, "A paired browser can read this host but not change anything yet");
  }
  if (!isAllowedBridgeWebPath(input.path)) {
    return errorResponse(400, "unsupported_web_path");
  }

  const fetchImpl = deps.fetch ?? fetch;
  const baseUrl = deps.baseUrl?.() ?? `http://127.0.0.1:${resolveWebPort()}`;
  const token = deps.token?.() ?? resolveWebAuthToken();
  try {
    const response = await fetchImpl(new URL(input.path, baseUrl), {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json, text/plain, */*" },
      redirect: "error",
      signal: AbortSignal.timeout(BRIDGE_WEB_REQUEST_TIMEOUT_MS),
    });
    const contentType = response.headers.get("content-type");
    if (contentType?.toLowerCase().includes("text/event-stream")) {
      await response.body?.cancel();
      return errorResponse(406, "Live streams are carried by web.stream, not web.request");
    }
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > BRIDGE_WEB_REQUEST_MAX_BYTES) {
      await response.body?.cancel();
      return errorResponse(413, "Response is too large to carry");
    }
    // Content-Length is only a hint: cap bytes while reading chunked or
    // incorrectly declared responses, before buffering the rest of the body.
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value.byteLength > BRIDGE_WEB_REQUEST_MAX_BYTES - size) {
            await reader.cancel();
            return errorResponse(413, "Response is too large to carry");
          }
          chunks.push(value);
          size += value.byteLength;
        }
      } finally {
        reader.releaseLock();
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return isTextual(contentType)
      ? { status: response.status, contentType, body: new TextDecoder().decode(bytes) }
      : { status: response.status, contentType, base64: Buffer.from(bytes).toString("base64") };
  } catch {
    return errorResponse(502, "This host's web service is unavailable");
  }
}
