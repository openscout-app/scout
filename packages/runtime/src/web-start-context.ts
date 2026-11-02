/**
 * Callers that start the web app name the portal host it should serve. The
 * loopback gate refuses every forwarding header (`x-forwarded-*`, `forwarded`,
 * `via`) as relay evidence, so this context travels in headers of its own.
 * The runtime still accepts only a trusted host, so naming one confers no
 * authority.
 */
export const WEB_START_HOST_HEADER = "x-openscout-web-host";
export const WEB_START_SCHEME_HEADER = "x-openscout-web-scheme";

export function webStartRequestHeaders(host: string, scheme: "http" | "https"): Record<string, string> {
  return { [WEB_START_HOST_HEADER]: host, [WEB_START_SCHEME_HEADER]: scheme };
}
