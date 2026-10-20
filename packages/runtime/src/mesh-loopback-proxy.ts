import type { RuntimeHttpHeaders, RuntimeTransportKind } from "./portable-types.js";

export const LOOPBACK_HTTP_PROXY_POLICY = "reject-forwarding-headers" as const;
export const LOOPBACK_HTTP_PROXY_REFUSAL = "loopback_proxy_refused";
export const LOOPBACK_HTTP_PROXY_DETAIL = "Do not proxy Serve, Funnel, or another HTTP relay to the runtime's local listener. Connect directly to its authenticated mesh TLS endpoint.";

const FORWARDING_HEADERS = new Set([
  "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip",
]);

/** Headers are only negative evidence, never proof of caller identity. Their
 * presence can remove local authority but cannot confer any authority. This
 * also covers tagged Serve clients, which receive no Tailscale user headers.
 */
export function refusesLoopbackHttpProxy(transport: RuntimeTransportKind, headers: RuntimeHttpHeaders): boolean {
  if (transport === "remote") return false;
  return Object.keys(headers).some((name) => {
    const normalized = name.toLowerCase();
    return FORWARDING_HEADERS.has(normalized) || normalized.startsWith("tailscale-");
  });
}
