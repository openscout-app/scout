export * from "./local-edge-trust.js";
import {
  DEFAULT_SCOUT_WEB_PORTAL_HOST,
  DEFAULT_SCOUT_WEB_VITE_HMR_PATH,
  resolveConfiguredScoutWebHostname,
  resolveBrokerPort,
  resolveScoutWebDevHostname,
  resolveScoutWebNamedHostname,
  resolveWebPort,
} from "./local-config.js";
import {
  renderScoutAsciiMarkHtml,
  renderScoutAsciiMarkScript,
} from "./scout-ascii-mark.js";
import { resolveScoutLanNetworks, type ScoutLanNetwork } from "./lan-network.js";

export type OpenScoutLocalEdgeRouteMode = "default" | "vite-dev";

export type OpenScoutLocalEdgeRoute = {
  host: string;
  upstream: string;
  mode?: OpenScoutLocalEdgeRouteMode;
};

export type OpenScoutLocalEdgeScheme = "http" | "https" | "both";

/** The local edge owns shared 80/443 listeners, Caddy state and mDNS names.
 * Named instances use their own web port until an isolated edge exists. */
export function shouldStartOpenScoutLocalEdge(input: {
  isProd: boolean;
  platform: NodeJS.Platform;
  enabled?: string;
}): boolean {
  return input.isProd && input.platform === "darwin" && input.enabled !== "0";
}

export type OpenScoutLocalEdgeConfig = {
  lanOnly?: boolean;
  portalHost: string;
  nodeHost: string;
  wildcardHost: string;
  scheme: OpenScoutLocalEdgeScheme;
  brokerUpstream: string;
  routes: OpenScoutLocalEdgeRoute[];
  /** Dev-only: upstream host for Vite HMR, e.g. 127.0.0.1:43122 */
  viteUpstream?: string;
  /** Dev-only: browser-visible HMR path, e.g. /ws/hmr */
  viteHmrPath?: string;
};

function normalizeViteHmrPath(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return DEFAULT_SCOUT_WEB_VITE_HMR_PATH;
  }
  const normalized = `${trimmed.startsWith("/") ? "" : "/"}${trimmed}`
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/g, "");
  return normalized || DEFAULT_SCOUT_WEB_VITE_HMR_PATH;
}

function resolveViteUpstream(input: {
  viteDevUrl?: string;
  vitePort?: number;
}): string | undefined {
  const url = input.viteDevUrl?.trim();
  if (url) {
    try {
      return new URL(url).host;
    } catch {
      return undefined;
    }
  }
  if (typeof input.vitePort === "number" && input.vitePort > 0) {
    return `127.0.0.1:${input.vitePort}`;
  }
  return undefined;
}

function normalizeRouteHost(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/\.$/, "").toLowerCase();
  if (!normalized || normalized.includes("/") || /\s/.test(normalized)) {
    return null;
  }
  return normalized;
}

/** Explicit names advertised by the local edge; mDNS has no wildcard records. */
export function resolveOpenScoutLocalEdgeDiscoveryHosts(input: {
  portalHost: string;
  nodeHost: string;
}): string[] {
  const portalHost = normalizeRouteHost(input.portalHost);
  return [...new Set([
    portalHost,
    normalizeRouteHost(input.nodeHost),
    portalHost ? `chat.${portalHost}` : null,
  ].filter((host): host is string => host !== null))];
}

export type OpenScoutLocalEdgeMdnsCommand = { command: string; args: string[] };

/**
 * Commands that advertise one local-edge host over mDNS as a proxy for
 * the selected address (loopback by default). macOS registers the host record and the service in one
 * `dns-sd -P`; Avahi needs the address records and the service published
 * separately. Other platforms have no supported publisher.
 */
export function buildOpenScoutLocalEdgeMdnsCommands(
  input: { name: string; host: string; port: number; scheme: "http" | "https"; address?: string },
  platform: NodeJS.Platform = process.platform,
): OpenScoutLocalEdgeMdnsCommand[] {
  const address = input.address ?? "127.0.0.1";
  const type = input.scheme === "https" ? "_https._tcp" : "_http._tcp";
  if (platform === "darwin") {
    return [{
      command: "/usr/bin/dns-sd",
      args: ["-P", input.name, type, "local", String(input.port), input.host, address, "path=/"],
    }];
  }
  if (platform === "linux") {
    return [
      { command: "avahi-publish", args: ["-a", "-R", input.host, address] },
      // Without an AAAA answer every lookup waits out the resolver's IPv6 timeout.
      ...(address === "127.0.0.1" ? [{ command: "avahi-publish", args: ["-a", "-R", input.host, "::1"] }] : []),
      { command: "avahi-publish", args: ["-s", "-H", input.host, input.name, type, String(input.port), "path=/"] },
    ];
  }
  return [];
}

/** Each explicit mDNS name has one owner. LAN mode never advertises a remote
 * machine's doorway as loopback, even while its physical interface is down. */
export function resolveOpenScoutLocalEdgeAdvertisements(
  config: Pick<OpenScoutLocalEdgeConfig, "portalHost" | "nodeHost" | "lanOnly">,
  networks: readonly ScoutLanNetwork[] = resolveScoutLanNetworks(),
): Array<{ host: string; address: string }> {
  const ipv4 = networks.filter(n => n.family === "IPv4");
  const lanAddress = (ipv4.find(n => !n.address.startsWith("169.254.")) ?? ipv4[0])?.address;
  return resolveOpenScoutLocalEdgeDiscoveryHosts(config).flatMap(host => {
    if (config.lanOnly && host === config.nodeHost && host !== config.portalHost) {
      return lanAddress ? [{ host, address: lanAddress }] : [];
    }
    return [{ host, address: "127.0.0.1" }];
  });
}

/** Own just the mDNS children. Readdressing never restarts Caddy or the broker. */
export function createLocalEdgeAdvertisementOwner<T>(ops: {
  start: (advertisement: { host: string; address: string }, scheme: "http" | "https") => T;
  stop: (child: T) => void;
}) {
  let children: T[] = [];
  let fingerprint = "";
  const stop = () => {
    for (const child of children) ops.stop(child);
    children = [];
    fingerprint = "";
  };
  return {
    stop,
    update(advertisements: Array<{ host: string; address: string }>, schemes: readonly ("http" | "https")[]) {
      const next = JSON.stringify([advertisements, schemes]);
      if (next === fingerprint) return;
      stop();
      children = schemes.flatMap(scheme => advertisements.map(ad => ops.start(ad, scheme)));
      fingerprint = next;
    },
  };
}

function uniqRoutes(routes: OpenScoutLocalEdgeRoute[]): OpenScoutLocalEdgeRoute[] {
  const seen = new Set<string>();
  const out: OpenScoutLocalEdgeRoute[] = [];
  for (const route of routes) {
    const host = normalizeRouteHost(route.host);
    if (!host) {
      continue;
    }
    const key = `${host} ${route.upstream}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ ...route, host });
  }
  return out;
}

function formatCaddyHost(host: string): string {
  if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) {
    return `[${host}]`;
  }
  return host;
}

export function resolveOpenScoutLocalEdgeConfig(input: {
  lanOnly?: boolean;
  portalHost?: string;
  nodeHost?: string;
  scheme?: OpenScoutLocalEdgeScheme;
  brokerPort?: number;
  webPort?: number;
  vitePort?: number;
  viteDevUrl?: string;
  viteHmrPath?: string;
  extraHosts?: string[];
} = {}): OpenScoutLocalEdgeConfig {
  const portalHost = resolveScoutWebNamedHostname(input.portalHost ?? DEFAULT_SCOUT_WEB_PORTAL_HOST);
  const nodeHost = resolveScoutWebNamedHostname(input.nodeHost ?? resolveConfiguredScoutWebHostname());
  const wildcardHost = `*.${portalHost}`;
  const scheme = input.scheme ?? "http";
  const upstream = `127.0.0.1:${input.webPort ?? resolveWebPort()}`;
  const brokerUpstream = `127.0.0.1:${input.brokerPort ?? resolveBrokerPort()}`;
  const viteUpstream = resolveViteUpstream(input);
  return {
    ...(input.lanOnly ? { lanOnly: true } : {}),
    portalHost,
    nodeHost,
    wildcardHost,
    scheme,
    brokerUpstream,
    routes: uniqRoutes([
      { host: portalHost, upstream },
      ...(input.lanOnly && nodeHost !== portalHost ? [{ host: nodeHost, upstream }] : []),
      { host: wildcardHost, upstream },
      ...(viteUpstream
        ? [{
            host: resolveScoutWebDevHostname(portalHost),
            upstream: viteUpstream,
            mode: "vite-dev" as const,
          }]
        : []),
      ...(input.extraHosts ?? []).map((host) => ({ host, upstream })),
    ]),
    ...(viteUpstream
      ? {
          viteUpstream,
          viteHmrPath: normalizeViteHmrPath(input.viteHmrPath),
        }
      : {}),
  };
}

export function renderOpenScoutStartPage(config: OpenScoutLocalEdgeConfig): string {
  const pageConfig = JSON.stringify({
    startPath: "/__openscout/web/start",
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Start Scout</title>
  <script>
    (function () {
      var theme = "dark";
      try {
        var query = new URLSearchParams(window.location.search).get("theme");
        var stored = JSON.parse(window.localStorage.getItem("openscout.theme") || "{}").theme;
        var preference = query || stored;
        if (preference === "light") theme = "light";
        if (preference === "system") {
          theme = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
        }
      } catch {}
      document.documentElement.dataset.scoutTheme = theme;
    })();
  </script>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #080a07;
      --surface: #10130e;
      --ink: #f5f1e8;
      --muted: #aaa69b;
      --edge: #303729;
      --accent: #a6e15e;
      --orb-0: #2a2723;
      --orb-1: #444038;
      --orb-2: #6d675a;
      --orb-3: #9a9181;
      --orb-4: #d8d0c0;
      font-family: "Inter Tight", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--ink);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px 28px;
      background: var(--bg);
    }
    main {
      width: min(640px, 100%);
    }
    .brand {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding-bottom: 14px;
      margin-bottom: 36px;
      border-bottom: 1px solid color-mix(in srgb, var(--edge) 80%, transparent);
    }
    .host {
      overflow: hidden;
      color: var(--muted);
      font: 500 11px/1.2 ui-monospace, "SF Mono", Menlo, monospace;
      letter-spacing: 0.08em;
      text-overflow: ellipsis;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .service {
      color: var(--muted);
      font-size: 12px;
      letter-spacing: 0.01em;
      white-space: nowrap;
    }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 24px 36px;
      align-items: center;
    }
    /* The mark is a second way into the app, not just decoration — it is the
       largest, most inviting thing on the page, so clicking it should do what
       clicking it looks like it should do. It stays aria-hidden and outside the
       tab order on purpose: 2820 glyph cells are noise to a screen reader, and
       the real #start button sits beside it as the accessible, keyboard-
       reachable path. This is a redundant mouse affordance, never the only one. */
    .orb {
      position: relative;
      justify-self: end;
      user-select: none;
      cursor: pointer;
      transition: transform 160ms ease, filter 160ms ease;
    }
    .orb:hover { transform: translateY(-1px); filter: brightness(1.18); }
    .orb:active { transform: translateY(0); filter: brightness(1.05); }
    .orb[data-busy="true"] { cursor: progress; }
    .orb[data-busy="true"]:hover { transform: none; filter: none; }
    @media (prefers-reduced-motion: reduce) {
      .orb { transition: none; }
      .orb:hover, .orb:active { transform: none; }
    }
    .orb-l {
      margin: 0;
      color: var(--orb-0);
      font: 400 5px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      letter-spacing: 0;
      white-space: pre;
      -webkit-font-smoothing: none;
      -moz-osx-font-smoothing: unset;
      font-smooth: never;
      text-rendering: geometricPrecision;
      font-variant-ligatures: none;
      font-kerning: none;
    }
    .orb-l + .orb-l { position: absolute; inset: 0; }
    .orb-l[data-t="1"] { color: var(--orb-1); }
    .orb-l[data-t="2"] { color: var(--orb-2); }
    .orb-l[data-t="3"] { color: var(--orb-3); }
    .orb-l[data-t="4"] { color: var(--orb-4); }
    h1 {
      margin-bottom: 10px;
      color: var(--ink);
      font-size: clamp(24px, 3.6vw, 28px);
      font-weight: 560;
      letter-spacing: -0.04em;
      line-height: 1.12;
    }
    p {
      max-width: 34ch;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.55;
      margin-bottom: 22px;
    }
    button {
      min-height: 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      border: 1px solid var(--edge);
      border-radius: 8px;
      padding: 0 14px;
      background: var(--surface);
      color: var(--ink);
      font: inherit;
      font-size: 13px;
      font-weight: 550;
      letter-spacing: -0.015em;
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease, color 120ms ease, opacity 120ms ease;
    }
    button:hover:not(:disabled) {
      border-color: color-mix(in srgb, var(--accent) 42%, var(--edge));
      background: color-mix(in srgb, var(--surface) 88%, var(--accent));
    }
    button:active:not(:disabled) {
      background: color-mix(in srgb, var(--surface) 78%, var(--accent));
    }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    button:disabled { cursor: progress; opacity: 0.55; }
    .button-arrow {
      color: var(--accent);
      font-size: 14px;
      font-weight: 500;
      line-height: 1;
      transition: transform 120ms ease;
    }
    button:hover:not(:disabled) .button-arrow { transform: translateX(1px); }
    .progress {
      width: min(220px, 100%);
      height: 1px;
      margin-top: 18px;
      border-radius: 1px;
      background: color-mix(in srgb, var(--edge) 70%, transparent);
      overflow: hidden;
      opacity: 0;
      transition: opacity 120ms ease;
    }
    main.is-waiting .progress { opacity: 1; }
    @keyframes sweep {
      0%   { transform: translateX(-100%); }
      100% { transform: translateX(500%); }
    }
    .progress-bar {
      height: 100%;
      width: 20%;
      border-radius: 1px;
      background: var(--accent);
      transform: translateX(-100%);
    }
    .progress-bar.running {
      animation: sweep 1.5s ease-in-out infinite;
    }
    output {
      display: block;
      min-height: 16px;
      margin-top: 10px;
      color: var(--muted);
      font-family: ui-monospace, "SF Mono", Menlo, "Cascadia Code", monospace;
      font-size: 11px;
      line-height: 1.4;
    }
    :root[data-scout-theme="dark"] { color-scheme: dark; }
    :root[data-scout-theme="light"] {
      color-scheme: light;
      --bg: #f3f1ea;
      --surface: #fbfaf5;
      --ink: #171914;
      --muted: #65655d;
      --edge: #c6c8ba;
      --accent: #3a6807;
      --orb-0: #d2cec4;
      --orb-1: #a19d94;
      --orb-2: #717068;
      --orb-3: #484b44;
      --orb-4: #1c2019;
    }
    @media (max-width: 520px) {
      body { place-items: start center; padding: 24px 20px; }
      main { padding-top: 10vh; }
      .brand { margin-bottom: 28px; }
      .service { display: none; }
      .hero { grid-template-columns: 1fr; gap: 28px; }
      .orb { order: -1; justify-self: start; }
      .orb-l { font-size: 4.5px; }
      h1 { font-size: clamp(22px, 6.5vw, 26px); }
      p { max-width: none; }
      button { width: 100%; }
      .progress { width: 100%; }
    }
    @media (prefers-reduced-motion: reduce) {
      button, .button-arrow, .progress { transition: none; }
      button:hover:not(:disabled) .button-arrow { transform: none; }
      .progress-bar.running { animation: none; transform: none; width: 100%; }
    }
  </style>
</head>
<body>
  <main id="shell">
    <div class="brand">
      <span class="host" id="host">Scout local</span>
      <span class="service">Local web service</span>
    </div>
    <div class="hero">
      <section>
        <h1>Bring Scout online.</h1>
        <p>The web interface is not running yet. Start it to return to your agents, messages, and activity.</p>
        <button id="start" type="button"><span>Start Scout</span><span class="button-arrow" aria-hidden="true">→</span></button>
        <div class="progress"><div class="progress-bar" id="bar"></div></div>
        <output id="status" role="status"></output>
      </section>
      <div class="orb" aria-hidden="true">${renderScoutAsciiMarkHtml()}</div>
    </div>
  </main>
  ${renderScoutAsciiMarkScript()}
  <script>
    const config = ${pageConfig};
    const shell = document.getElementById('shell');
    const host = document.getElementById('host');
    const button = document.getElementById('start');
    const bar = document.getElementById('bar');
    const status = document.getElementById('status');
    const targetPath = window.location.pathname + window.location.search + window.location.hash;
    const healthUrl = new URL('/api/health', window.location.origin);
    const startUrl = new URL(config.startPath, window.location.origin);
    host.textContent = window.location.host;

    function setStatus(message) {
      status.textContent = message;
    }

    function setWaiting(on) {
      shell.classList.toggle('is-waiting', on);
      bar.classList.toggle('running', on);
    }

    async function waitForWeb() {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(healthUrl, { headers: { accept: 'application/json' }, cache: 'no-store' });
          if (response.ok) {
            const body = await response.json();
            if (body && body.ok === true) {
              window.location.replace(targetPath || '/');
              return true;
            }
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      return false;
    }

    const orb = document.querySelector('.orb');

    async function startScout() {
      // Both entry points share one guard: the mark can be clicked while the
      // button is mid-flight, and a second POST would race the first.
      if (button.disabled) return;
      button.disabled = true;
      if (orb) orb.dataset.busy = 'true';
      setWaiting(true);
      setStatus('Starting Scout web...');
      try {
        const response = await fetch(startUrl, {
          method: 'POST',
          headers: { accept: 'application/json' },
        });
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          throw new Error('Scout broker is not reachable yet.');
        }
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.error) {
          throw new Error(body.error || 'Scout web did not start.');
        }
        setStatus('Waiting for the web app...');
        const ready = await waitForWeb();
        if (!ready) {
          setWaiting(false);
          setStatus('Scout web did not become ready. Try again in a moment.');
          button.disabled = false;
          if (orb) orb.dataset.busy = 'false';
        }
      } catch (error) {
        setWaiting(false);
        setStatus(error instanceof Error ? error.message : String(error));
        button.disabled = false;
        if (orb) orb.dataset.busy = 'false';
      }
    }

    button.addEventListener('click', startScout);
    if (orb) orb.addEventListener('click', startScout);
  </script>
</body>
</html>`;
}

function renderCaddyDefaultRouteBlock(
  config: OpenScoutLocalEdgeConfig,
  route: OpenScoutLocalEdgeRoute,
  scheme: "http" | "https",
  startPage: string,
): string {
  const routeHost = formatCaddyHost(route.host);
  const host = scheme === "http" ? `http://${routeHost}` : routeHost;
  return `${host} {\n`
    + (scheme === "https" ? `  tls internal\n` : "")
    + `  @openscout_web_start_local {\n`
    + `    path /__openscout/web/start\n`
    + `    remote_ip 127.0.0.1 ::1\n`
    // Never launder inbound proxy evidence while stripping Caddy's own headers.
    + `    header !X-Forwarded-For\n`
    + `    header !X-Forwarded-Host\n`
    + `    header !X-Forwarded-Proto\n`
    + `    header !Via\n`
    + `  }\n`
    + `  handle @openscout_web_start_local {\n`
    + `    rewrite * /v1/web/start\n`
    + `    reverse_proxy ${config.brokerUpstream} {\n`
    // These loopback-only control routes are a deliberate local bridge, not
    // runtime ingress for the web proxy. Remove Caddy's automatic forwarding/Via
    // headers only here; the runtime's proxy refusal policy stays unchanged.
    + `      header_up -X-Forwarded-For\n`
    + `      header_up -X-Forwarded-Host\n`
    + `      header_up -X-Forwarded-Proto\n`
    + `      header_up -Via\n`
    + `      header_up X-Openscout-Web-Host {host}\n`
    + `      header_up X-Openscout-Web-Proto {scheme}\n`
    + `    }\n`
    + `  }\n`
    + `  handle /__openscout/web/start {\n`
    + `    respond "Forbidden" 403\n`
    + `  }\n`
    + `  @openscout_web_status_local {\n`
    + `    path /__openscout/web/status\n`
    + `    remote_ip 127.0.0.1 ::1\n`
    // Never launder inbound proxy evidence while stripping Caddy's own headers.
    + `    header !X-Forwarded-For\n`
    + `    header !X-Forwarded-Host\n`
    + `    header !X-Forwarded-Proto\n`
    + `    header !Via\n`
    + `  }\n`
    + `  handle @openscout_web_status_local {\n`
    + `    rewrite * /v1/web/status\n`
    + `    reverse_proxy ${config.brokerUpstream} {\n`
    // These loopback-only control routes are a deliberate local bridge, not
    // runtime ingress for the web proxy. Remove Caddy's automatic forwarding/Via
    // headers only here; the runtime's proxy refusal policy stays unchanged.
    + `      header_up -X-Forwarded-For\n`
    + `      header_up -X-Forwarded-Host\n`
    + `      header_up -X-Forwarded-Proto\n`
    + `      header_up -Via\n`
    + `      header_up X-Openscout-Web-Host {host}\n`
    + `      header_up X-Openscout-Web-Proto {scheme}\n`
    + `    }\n`
    + `  }\n`
    + `  handle /__openscout/web/status {\n`
    + `    respond "Forbidden" 403\n`
    + `  }\n`
    + `  handle {\n`
    + `    reverse_proxy ${route.upstream} {\n`
    + `      lb_try_duration 15s\n`
    + `      lb_try_interval 500ms\n`
    + `    }\n`
    + `  }\n`
    + `  handle_errors {\n`
    + `    header Content-Type "text/html; charset=utf-8"\n`
    + `    respond <<HTML\n`
    + `${startPage}\n`
    + `HTML 200\n`
    + `  }\n`
    + `}`;
}

function renderCaddyViteDevRouteBlock(
  route: OpenScoutLocalEdgeRoute,
  scheme: "http" | "https",
): string {
  const routeHost = formatCaddyHost(route.host);
  const host = scheme === "http" ? `http://${routeHost}` : routeHost;
  return `${host} {\n`
    + (scheme === "https" ? `  tls internal\n` : "")
    + `  handle {\n`
    + `    reverse_proxy ${route.upstream} {\n`
    + `      lb_try_duration 15s\n`
    + `      lb_try_interval 500ms\n`
    + `    }\n`
    + `  }\n`
    + `}`;
}

export function renderOpenScoutCaddyfile(config: OpenScoutLocalEdgeConfig, siteImportsGlob?: string): string {
  const schemes = config.scheme === "both" ? ["http", "https"] as const : [config.scheme] as const;
  const startPage = renderOpenScoutStartPage(config);
  const blocks = schemes
    .flatMap((scheme) =>
      config.routes.map((route) => (
        config.lanOnly && scheme === "http" && route.host === config.nodeHost
          ? `http://${formatCaddyHost(route.host)} {\n  redir https://${formatCaddyHost(route.host)}{uri} 308\n}`
          : route.mode === "vite-dev"
          ? renderCaddyViteDevRouteBlock(route, scheme)
          : renderCaddyDefaultRouteBlock(config, route, scheme, startPage)
      )),
    )
    .join("\n\n");
  // Caddy's admin API logs every successful config inspection at info level.
  // Local developer tools may audit those routes periodically; keeping that
  // healthy control traffic on stderr grew the edge log without adding useful
  // diagnostics. Warnings and errors remain visible.
  const imports = siteImportsGlob ? `\nimport ${JSON.stringify(siteImportsGlob)}\n` : "";
  // A background daemon must never try to install the local CA itself (it
  // would raise a password prompt out of nowhere); the operator trusts it once.
  const trust = config.scheme === "http" ? "" : "  skip_install_trust\n";
  return `{\n${trust}  log {\n    level WARN\n  }\n}\n\n${blocks}\n${imports}`;
}
