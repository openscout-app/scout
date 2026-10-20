import { randomUUID } from "node:crypto";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

/** HTTP only: this command must not depend on runtime internals or local storage. */
export const MESH_GUESTS_HELP = `scout mesh guests — direct guest grants (not trusted peers)

  scout mesh guests [list] [--json]
  scout mesh guests grant <public-key> --label <name> --agent <agent-id> ...
      --expires-at <ISO-8601|epoch-ms> [--request-id <id>] [--json]
  scout mesh guests revoke <grant-id> [--json]
  scout mesh guests revoke --request-id <id> [--json]

Grant also accepts --public-key <base64-Ed25519-SPKI> instead of a positional key.
Repeat --agent for each exact agent ID. Expiry is required; the broker caps it
at 30 days. Reuse --request-id after a lost response; retries never extend expiry.
Grant --json prints a bootstrap file accepted by scout-tailscale connect.
Run on the runtime's machine. These commands only call its local HTTP API.
`;

type GuestGrant = {
  id: string;
  requestId: string;
  keyId: string;
  label: string;
  allowedTargets: string[];
  expiresAt: number;
  status: string;
};

type GrantResult = {
  created: boolean;
  grant: GuestGrant;
  bootstrap: { protocol: string; grantId: string; nodeId: string; nodeKeyId: string; card: { tls?: { spkiFingerprint: string }; endpoints?: string[] } | null };
};

type GuestCommand =
  | { kind: "list" }
  | { kind: "grant"; body: { requestId: string; clientPublicKey: string; label: string; allowedTargets: string[]; expiresAt: number } }
  | { kind: "revoke"; body: { grantId: string } | { requestId: string } };

export function parseMeshGuestsArgs(args: string[], now = Date.now()): GuestCommand {
  const [kind = "list", ...rest] = args;
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  const allowed = kind === "grant"
    ? ["--public-key", "--label", "--agent", "--expires-at", "--request-id"]
    : kind === "revoke" ? ["--request-id"] : [];
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index]!;
    if (!token.startsWith("-")) { positional.push(token); continue; }
    const equals = token.indexOf("=");
    const flag = equals === -1 ? token : token.slice(0, equals);
    if (!allowed.includes(flag)) throw new ScoutCliError(`unknown flag for mesh guests ${kind}: ${flag}`);
    const value = equals === -1 ? rest[++index] : token.slice(equals + 1);
    if (!value?.trim() || value.startsWith("--")) throw new ScoutCliError(`missing value for ${flag}`);
    if (flags.has(flag) && flag !== "--agent") throw new ScoutCliError(`duplicate flag: ${flag}`);
    flags.set(flag, [...(flags.get(flag) ?? []), value.trim()]);
  }
  if (kind === "list" && positional.length === 0) return { kind };
  if (kind === "grant") {
    const clientPublicKey = flags.get("--public-key")?.[0] ?? positional[0];
    const label = flags.get("--label")?.[0];
    const allowedTargets = flags.get("--agent") ?? [];
    const expiry = flags.get("--expires-at")?.[0] ?? "";
    const expiresAt = /^\d+$/.test(expiry) ? Number(expiry) : Date.parse(expiry);
    if (positional.length > (flags.has("--public-key") ? 0 : 1)) throw new ScoutCliError("provide one public key, not both positional and --public-key");
    if (!clientPublicKey || !label || !allowedTargets.length || !expiry) throw new ScoutCliError("grant requires a public key, --label, at least one --agent, and --expires-at");
    if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new ScoutCliError("--expires-at must be a future ISO-8601 timestamp or epoch millisecond time");
    return { kind, body: { clientPublicKey, label, allowedTargets, expiresAt, requestId: flags.get("--request-id")?.[0] ?? randomUUID() } };
  }
  if (kind === "revoke") {
    const requestId = flags.get("--request-id")?.[0];
    if (requestId && positional.length === 0) return { kind, body: { requestId } };
    if (!requestId && positional.length === 1) return { kind, body: { grantId: positional[0]! } };
    throw new ScoutCliError("revoke requires one grant ID or --request-id <id>, not both");
  }
  throw new ScoutCliError(`unexpected arguments for mesh guests: ${args.join(" ")}`);
}

export async function runMeshGuestsCommand(
  context: Pick<ScoutCommandContext, "output">,
  args: string[],
  options: { brokerUrl: string; fetchImpl?: (url: URL, init: RequestInit) => Promise<Response> },
): Promise<void> {
  if (args.some((arg) => arg === "--help" || arg === "-h")) {
    context.output.writeText(MESH_GUESTS_HELP);
    return;
  }
  const command = parseMeshGuestsArgs(args.filter((arg) => arg !== "--json"));
  const json = args.includes("--json") || context.output.mode === "json";
  const write = <T>(value: T, render: (value: T) => string) => {
    if (json) context.output.writeText(JSON.stringify(value, null, 2));
    else context.output.writeValue(value, render);
  };
  const path = command.kind === "revoke" ? "/v1/guest-grants/revoke" : "/v1/guest-grants";
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(new URL(path, options.brokerUrl), {
      method: command.kind === "list" ? "GET" : "POST",
      redirect: "error",
      headers: { accept: "application/json", "content-type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      ...(command.kind === "list" ? {} : { body: JSON.stringify(command.body) }),
    });
  } catch (error) {
    const retry = command.kind === "grant" ? `; retry with --request-id ${command.body.requestId}` : "";
    throw new ScoutCliError(`mesh guests ${command.kind} could not reach the runtime${retry}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json() as { error?: string; detail?: string };
      detail = body.detail || body.error || detail;
    } catch { /* Preserve the HTTP status for non-JSON errors. */ }
    throw new ScoutCliError(`mesh guests ${command.kind} failed (HTTP ${response.status}): ${detail}${command.kind === "grant" ? `; retry with --request-id ${command.body.requestId}` : ""}`);
  }
  if (command.kind === "list") {
    const result = await response.json() as { grants: GuestGrant[] };
    write(result.grants, (grants) => grants.length
      ? grants.map((grant) => `${grant.id}  ${grant.label}  ${grant.status}\n  Key ID: ${grant.keyId}\n  Request ID: ${grant.requestId}\n  Agents: ${grant.allowedTargets.join(", ")}\n  Expires: ${new Date(grant.expiresAt).toISOString()}`).join("\n")
      : "No guest grants.");
  } else if (command.kind === "grant") {
    const result = await response.json() as GrantResult;
    // The Python client's out-of-band claim format uses these two top-level
    // fields. Preserve the broker response and copy only broker-authoritative scope.
    const claim = { ...result, allowed_targets: result.grant.allowedTargets, expires_at: new Date(result.grant.expiresAt).toISOString() };
    write(claim, (value) => [
      `${value.created ? "Granted" : "Confirmed"} ${value.grant.label}: ${value.grant.id}`,
      `Request ID: ${value.grant.requestId}`,
      `Agents: ${value.grant.allowedTargets.join(", ")}`,
      `Expires: ${new Date(value.grant.expiresAt).toISOString()}`,
      "Bootstrap (save this JSON for the guest):", JSON.stringify(value, null, 2),
      "Verify the node key through a separate trusted channel, then on the guest run:",
      `scout-tailscale connect --bootstrap grant.json --node-key ${value.bootstrap.nodeKeyId} --proxy direct`,
      ...(value.bootstrap.card?.tls && value.bootstrap.card.endpoints?.some((endpoint) => endpoint.startsWith("https://"))
        ? [] : ["Mesh TLS is not ready. The guest needs a signed card with an HTTPS endpoint and TLS pin before it can connect."]),
    ].join("\n"));
  } else {
    const result = await response.json() as { ok: boolean; grant: GuestGrant };
    write(result, (value) => `Revoked guest ${value.grant.label}: ${value.grant.id}`);
  }
}
