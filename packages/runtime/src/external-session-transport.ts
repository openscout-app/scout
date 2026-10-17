import { devinCloudCliTransport } from "./devin-cloud-cli-transport.js";
import type { AgentEndpoint } from "@openscout/protocol";

/** A return transport is configured by the operator, never by an MCP caller. */
export interface ExternalSessionConnection {
  id: string;
  ownerId: string;
  agentId: string;
  provider: "devin";
  organizationId: string;
  tokenEnv?: string;
  deliveryMode?: "api" | "cloud_cli";
}
export interface ExternalSessionTransport {
  inspect(nativeSessionId: string): Promise<{ nativeSessionId: string; state: string }>;
  send(nativeSessionId: string, body: string): Promise<{ nativeSessionId: string; state: string }>;
}
export function isExternalSessionEndpoint(endpoint: AgentEndpoint | null | undefined): boolean {
  return (endpoint?.transport === "http" || endpoint?.transport === "mcp_poll" || endpoint?.transport === "devin_cloud_cli") && endpoint.metadata?.externalSession === true && endpoint.metadata?.t3Session !== true;
}
export function externalSessionConnections(env: NodeJS.ProcessEnv): ExternalSessionConnection[] {
  const parsed: unknown = JSON.parse(env.OPENSCOUT_EXTERNAL_SESSION_CONNECTIONS || "[]");
  if (!Array.isArray(parsed)) throw new Error("external_session_config_invalid");
  const ids = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object" || item.provider !== "devin"
      || ![item.id, item.ownerId, item.agentId, item.organizationId].every((v) => typeof v === "string" && v.trim())
      || !/^org-[a-zA-Z0-9_-]+$/.test(item.organizationId)
      || ![undefined, "api", "cloud_cli"].includes(item.deliveryMode)
      || (item.deliveryMode !== "cloud_cli" && (typeof item.tokenEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(item.tokenEnv)))
      || ids.has(item.id)) {
      throw new Error("external_session_config_invalid");
    }
    ids.add(item.id);
  }
  return parsed as ExternalSessionConnection[];
}
export function normalizeDevinSessionId(value: string): string {
  if (typeof value !== "string" || !/^(?:devin-)?[a-zA-Z0-9_-]{6,128}$/.test(value)) {
    throw new Error("invalid_devin_session_id: supply the native session id, not a URL");
  }
  return value.startsWith("devin-") ? value : `devin-${value}`;
}
export class ExternalSessionTransportError extends Error {
  constructor(public readonly uncertain: boolean, message: string) { super(message); }
}
export function devinSessionTransport(
  connection: ExternalSessionConnection,
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): ExternalSessionTransport {
  if (connection.deliveryMode === "cloud_cli") return devinCloudCliTransport(connection, env);
  const request = async (nativeId: string, body?: string) => {
    const token = connection.tokenEnv ? env[connection.tokenEnv]?.trim() : undefined;
    if (!token) throw new ExternalSessionTransportError(false, "external_session_credential_missing");
    const id = normalizeDevinSessionId(nativeId);
    const url = `https://api.devin.ai/v3/organizations/${encodeURIComponent(connection.organizationId)}/sessions/${encodeURIComponent(id)}${body === undefined ? "" : "/messages"}`;
    let response: Response;
    try {
      response = await fetcher(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify({ message: body }) }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ExternalSessionTransportError(body !== undefined, "devin_transport_unconfirmed");
    }
    if (!response.ok) {
      // Never expose response bodies, credentials or arbitrary provider errors.
      throw new ExternalSessionTransportError(body !== undefined && response.status >= 500, `devin_http_${response.status}`);
    }
    let value: { session_id?: string; status?: string };
    try { value = await response.json() as typeof value; }
    catch { throw new ExternalSessionTransportError(body !== undefined, "devin_invalid_response"); }
    if (typeof value.session_id !== "string" || normalizeDevinSessionId(value.session_id) !== id || typeof value.status !== "string") {
      throw new ExternalSessionTransportError(body !== undefined, "devin_session_identity_mismatch");
    }
    if (["exit", "error"].includes(value.status)) {
      throw new ExternalSessionTransportError(body !== undefined, `devin_session_${value.status}`);
    }
    return { nativeSessionId: id, state: value.status };
  };
  return { inspect: (id) => request(id), send: (id, body) => request(id, body) };
}
