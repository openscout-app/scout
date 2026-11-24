import { SCOUT_APP_VERSION } from "../../lib/shared/product.ts";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  OPENSCOUT_PORTS,
  resolveConfiguredScoutWebHostname,
  resolveScoutWebNamedHostname,
  resolveWebPort,
  resolveOpenScoutLocalEdgeDirectory,
  resolveOpenScoutScoutHome,
} from "@openscout/runtime/config";
import {
  buildOpenScoutLocalEdgeMdnsCommands,
  renderOpenScoutCaddyfile,
  resolveOpenScoutLocalEdgeConfig,
  type OpenScoutLocalEdgeConfig,
  type OpenScoutLocalEdgeScheme,
  ensureScoutLocalEdgeTrust,
  type ScoutLocalEdgeTrustReport,
} from "@openscout/runtime/daemon";
import { readTailscaleSelfWebHostsSync } from "@openscout/runtime/mesh";
import { resolveLegacyWebEntry, resolveInstalledWebFullClient } from "@openscout/runtime/client";
import {
  resolveBunExecutable as resolveResolvedBunExecutable,
} from "@openscout/runtime/harnesses";
import { resolveOpenScoutSetupContextRoot } from "@openscout/runtime/setup";

import { loadScoutBrokerContext, resolveScoutBrokerUrl } from "../../lib/core/broker/service.ts";
import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

type ScoutServerMode = "openscout-web";
type ScoutServerAction = "start" | "restart" | "open" | "caddyfile" | "edge" | "trust";

export type ScoutWebControlStatus = {
  ok: boolean;
  running: boolean;
  starting: boolean;
  managed: boolean;
  webUrl: string;
  port: number;
  pid: number | null;
  error: string | null;
};

// Allow the owned child to drain (10s), force-exit (2s), and become ready (15s).
const SERVER_CONTROL_TIMEOUT_MS = 45_000;
const SERVER_OPEN_TIMEOUT_MS = 15_000;
const SERVER_HEALTH_TIMEOUT_MS = 1_500;

type ScoutFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type ScoutServerHealth = {
  ok: true;
  surface: "control-plane" | "openscout-web";
  currentDirectory: string;
  brokerUrl?: string;
};

type ScoutServerOpenResult = {
  url: string;
  port: number;
  mode: ScoutServerMode;
  reusedExistingServer: boolean;
};

export function renderServerCommandHelp(): string {
  return [
    "scout server — Scout web UI (Bun runtime)",
    "",
    "Usage:",
    "  scout server start [options]",
    "  scout server restart [options]",
    "  scout server open [options]",
    "  scout server caddyfile [options]",
    "  scout server edge [options]",
    "  scout server trust [options]",
    "  scout server control-plane open [options]  # deprecated alias for `scout server open`",
    "",
    "Subcommands:",
    "  start              Start the Scout web UI server.",
    "  restart            Restart the Scout web UI server via the broker service.",
    "  open               Open the Scout web UI (starts server on demand if needed).",
    "  caddyfile          Print the local edge Caddyfile for scout.local.",
    "  edge               Publish local names and run the Caddy edge.",
    "  trust              Trust Caddy's local CA root for Scout HTTPS.",
    "",
    "Options:",
    "  --host <h>        Bind host (default 127.0.0.1; explicit non-loopback opts into LAN)",
    "  --local-name NAME Node hostname or short alias to advertise (default <machine>.scout.local)",
    `  --port <n>        Listen port (default ${OPENSCOUT_PORTS.web}; optional override OPENSCOUT_WEB_PORT)`,
    "  --static          Serve built UI from disk",
    "  --static-root DIR Static client root (optional override OPENSCOUT_WEB_STATIC_ROOT)",
    "  --vite-url URL    Dev proxy target for non-API routes (optional override OPENSCOUT_WEB_VITE_URL)",
    "  --public-origin URL",
    "                    Public origin behind Caddy, e.g. https://scout.local",
    "  --http            Run/print only the plain HTTP edge on port 80 (default)",
    "  --https           Run/print only the HTTPS edge with Caddy local TLS",
    "  --both            Run/print HTTP and HTTPS edges",
    "  --advertised-host HOST",
    "                    Explicit node host to advertise/trust (default <machine>.scout.local)",
    "  --trusted-host HOST",
    "                    Additional trusted API host; may be repeated",
    "  --trusted-origin URL",
    "                    Additional trusted browser origin; may be repeated",
    "  --cwd DIR         Workspace / setup root (optional override OPENSCOUT_SETUP_CWD)",
    "  --path PATH       Browser path for `open` (default /)",
    "",
    "Requires `bun` on PATH.",
  ].join("\n");
}

/** The apps supply the web server; the broker remains its only process owner. */
export function resolveScoutWebServerEntry(): string {
  return resolveScoutControlPlaneWebServerEntry();
}
export function resolveScoutControlPlaneWebServerEntry(): string {
  const selected = resolveLegacyWebEntry(process.env, dirname(fileURLToPath(import.meta.url)));
  if (selected) return selected;
  throw new ScoutCliError(
    "The web app is supplied by the Scout apps, not the Scout core. Install the apps and configure OPENSCOUT_WEB_SERVER_ENTRY.",
  );
}

function parseServerFlags(args: string[]): {
  env: Record<string, string>;
  openPath: string;
  openPathSpecified: boolean;
} {
  const env: Record<string, string> = {};
  let openPath = "/";
  let openPathSpecified = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port") {
      const v = args[++i];
      if (!v) throw new ScoutCliError("--port requires a value");
      env.OPENSCOUT_WEB_PORT = v;
      continue;
    }
    if (a === "--host") {
      const v = args[++i];
      if (!v) throw new ScoutCliError("--host requires a value");
      env.OPENSCOUT_WEB_HOST = v;
      continue;
    }
    if (a === "--local-name") {
      const v = args[++i];
      if (!v) throw new ScoutCliError("--local-name requires a value");
      env.OPENSCOUT_WEB_LOCAL_NAME = v;
      continue;
    }
    if (a === "--static") {
      env.NODE_ENV = "production";
      continue;
    }
    if (a === "--static-root") {
      const v = args[++i];
      if (!v) throw new ScoutCliError("--static-root requires a value");
      env.OPENSCOUT_WEB_STATIC_ROOT = v;
      continue;
    }
    if (a === "--vite-url") {
      const v = args[++i];
      if (!v) throw new ScoutCliError("--vite-url requires a value");
      env.OPENSCOUT_WEB_VITE_URL = v;
      continue;
    }
    if (a === "--public-origin") {
      const v = args[++i];
      if (!v) throw new ScoutCliError("--public-origin requires a value");
      env.OPENSCOUT_WEB_PUBLIC_ORIGIN = v;
      continue;
    }
    if (a === "--http") {
      env.OPENSCOUT_WEB_EDGE_SCHEME = "http";
      continue;
    }
    if (a === "--https") {
      env.OPENSCOUT_WEB_EDGE_SCHEME = "https";
      continue;
    }
    if (a === "--both") {
      env.OPENSCOUT_WEB_EDGE_SCHEME = "both";
      continue;
    }
    if (a === "--advertised-host") {
      const v = args[++i];
      if (!v) throw new ScoutCliError("--advertised-host requires a value");
      env.OPENSCOUT_WEB_ADVERTISED_HOST = v;
      continue;
    }
    if (a === "--trusted-host") {
      const v = args[++i];
      if (!v) throw new ScoutCliError("--trusted-host requires a value");
      appendEnvList(env, "OPENSCOUT_WEB_TRUSTED_HOSTS", v);
      continue;
    }
    if (a === "--trusted-origin") {
      const v = args[++i];
      if (!v) throw new ScoutCliError("--trusted-origin requires a value");
      appendEnvList(env, "OPENSCOUT_WEB_TRUSTED_ORIGINS", v);
      continue;
    }
    if (a === "--cwd") {
      const v = args[++i];
      if (!v) throw new ScoutCliError("--cwd requires a value");
      env.OPENSCOUT_SETUP_CWD = v;
      continue;
    }
    if (a === "--path") {
      const v = args[++i];
      if (!v) throw new ScoutCliError("--path requires a value");
      openPath = v;
      openPathSpecified = true;
      continue;
    }
    if (a.startsWith("--port=")) {
      env.OPENSCOUT_WEB_PORT = a.slice("--port=".length);
      continue;
    }
    if (a.startsWith("--host=")) {
      env.OPENSCOUT_WEB_HOST = a.slice("--host=".length);
      continue;
    }
    if (a.startsWith("--local-name=")) {
      env.OPENSCOUT_WEB_LOCAL_NAME = a.slice("--local-name=".length);
      continue;
    }
    if (a.startsWith("--static-root=")) {
      env.OPENSCOUT_WEB_STATIC_ROOT = a.slice("--static-root=".length);
      continue;
    }
    if (a.startsWith("--vite-url=")) {
      env.OPENSCOUT_WEB_VITE_URL = a.slice("--vite-url=".length);
      continue;
    }
    if (a.startsWith("--public-origin=")) {
      env.OPENSCOUT_WEB_PUBLIC_ORIGIN = a.slice("--public-origin=".length);
      continue;
    }
    if (a.startsWith("--edge-scheme=")) {
      const v = a.slice("--edge-scheme=".length);
      if (v !== "http" && v !== "https" && v !== "both") {
        throw new ScoutCliError("--edge-scheme must be http, https, or both");
      }
      env.OPENSCOUT_WEB_EDGE_SCHEME = v;
      continue;
    }
    if (a.startsWith("--advertised-host=")) {
      env.OPENSCOUT_WEB_ADVERTISED_HOST = a.slice("--advertised-host=".length);
      continue;
    }
    if (a.startsWith("--trusted-host=")) {
      appendEnvList(env, "OPENSCOUT_WEB_TRUSTED_HOSTS", a.slice("--trusted-host=".length));
      continue;
    }
    if (a.startsWith("--trusted-origin=")) {
      appendEnvList(env, "OPENSCOUT_WEB_TRUSTED_ORIGINS", a.slice("--trusted-origin=".length));
      continue;
    }
    if (a.startsWith("--cwd=")) {
      env.OPENSCOUT_SETUP_CWD = a.slice("--cwd=".length);
      continue;
    }
    if (a.startsWith("--path=")) {
      openPath = a.slice("--path=".length);
      openPathSpecified = true;
      continue;
    }
    throw new ScoutCliError(`unknown option: ${a}`);
  }

  return { env, openPath, openPathSpecified };
}

function appendEnvList(env: Record<string, string>, key: string, value: string): void {
  env[key] = env[key] ? `${env[key]},${value}` : value;
}

function splitEnvList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function appendEnvListValues(input: string | undefined, values: string[]): string | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [...splitEnvList(input), ...values]) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out.length > 0 ? out.join(",") : undefined;
}

function buildServerCommandEnv(flagEnv: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...flagEnv } as NodeJS.ProcessEnv;
  const trustedHosts = appendEnvListValues(
    env.OPENSCOUT_WEB_TRUSTED_HOSTS,
    readTailscaleSelfWebHostsSync(),
  );
  if (trustedHosts) {
    env.OPENSCOUT_WEB_TRUSTED_HOSTS = trustedHosts;
  }
  return env;
}

function assertBrokerManagedLifecycleFlags(
  action: ScoutServerAction,
  flagEnv: Record<string, string>,
  openPathSpecified: boolean,
): void {
  if (action !== "start" && action !== "restart" && action !== "open") {
    return;
  }
  const unsupported = Object.keys(flagEnv);
  if (unsupported.length > 0 || (action !== "open" && openPathSpecified)) {
    throw new ScoutCliError(
      `${action} is broker-managed and does not accept per-command web configuration. Configure the broker service instead.`,
    );
  }
}

function resolveBundledStaticClientRoot(entry: string, _mode: ScoutServerMode): string | null {
  return resolveInstalledWebFullClient(SCOUT_APP_VERSION);
}

export function resolveBunExecutable(env: NodeJS.ProcessEnv): string {
  const bun = resolveResolvedBunExecutable(env);
  if (bun) {
    return bun.path;
  }

  throw new ScoutCliError("Unable to locate Bun. Install Bun (https://bun.sh) or set OPENSCOUT_BUN_BIN.");
}

function buildMergedServerEnv(entry: string, mode: ScoutServerMode, flagEnv: Record<string, string>): NodeJS.ProcessEnv {
  const bundledStaticClientRoot = resolveBundledStaticClientRoot(entry, mode);
  const autoEnv: Record<string, string> = {};
  const wantsVite = Boolean(flagEnv.OPENSCOUT_WEB_VITE_URL ?? process.env.OPENSCOUT_WEB_VITE_URL);
  if (!wantsVite) {
    const mergedForLookup = { ...process.env, ...flagEnv } as NodeJS.ProcessEnv;
    const staticClientRoot = bundledStaticClientRoot;
    if (staticClientRoot) {
      autoEnv.NODE_ENV = "production";
      autoEnv.OPENSCOUT_WEB_STATIC_ROOT = staticClientRoot;
    }
  }
  if (flagEnv.SCOUT_WEB_PORT) {
    autoEnv.OPENSCOUT_WEB_PORT = flagEnv.SCOUT_WEB_PORT;
  }
  if (
    !flagEnv.OPENSCOUT_WEB_HOST
    && !process.env.OPENSCOUT_WEB_HOST?.trim()
    && !process.env.SCOUT_WEB_HOST?.trim()
  ) {
    autoEnv.OPENSCOUT_WEB_HOST = "127.0.0.1";
  }
  if (flagEnv.OPENSCOUT_WEB_HOST && flagEnv.OPENSCOUT_WEB_HOST !== "127.0.0.1" && flagEnv.OPENSCOUT_WEB_HOST !== "localhost" && flagEnv.OPENSCOUT_WEB_HOST !== "::1") {
    autoEnv.OPENSCOUT_WEB_ALLOW_LAN = "1";
  }
  if (flagEnv.OPENSCOUT_SETUP_CWD) {
    autoEnv.OPENSCOUT_SETUP_CWD = flagEnv.OPENSCOUT_SETUP_CWD;
  }
  const mergedEnv = { ...process.env, ...autoEnv, ...flagEnv } as NodeJS.ProcessEnv;
  const trustedHosts = appendEnvListValues(
    mergedEnv.OPENSCOUT_WEB_TRUSTED_HOSTS,
    readTailscaleSelfWebHostsSync(),
  );
  if (trustedHosts) {
    mergedEnv.OPENSCOUT_WEB_TRUSTED_HOSTS = trustedHosts;
  }
  return mergedEnv;
}

async function withLiveBrokerInternalUrl(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (env.OPENSCOUT_BROKER_INTERNAL_URL?.trim() || env.OPENSCOUT_BROKER_URL?.trim()) {
    return env;
  }

  const broker = await loadScoutBrokerContext().catch(() => null);
  const brokerUrl = broker?.node.brokerUrl?.trim();
  if (!brokerUrl) {
    return env;
  }

  return {
    ...env,
    OPENSCOUT_BROKER_INTERNAL_URL: brokerUrl,
  };
}

function normalizedUrl(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).toString();
  } catch {
    return trimmed;
  }
}

function brokerUrlMatches(actual: string | undefined, expected: string | undefined): boolean {
  const expectedUrl = normalizedUrl(expected);
  if (!expectedUrl) return true;
  const actualUrl = normalizedUrl(actual);
  return !actualUrl || actualUrl === expectedUrl;
}

function parseServerSelection(args: string[]): {
  action: ScoutServerAction;
  flagArgs: string[];
} {
  if (args[0] === "start") {
    return {
      action: "start",
      flagArgs: args.slice(1),
    };
  }
  if (args[0] === "restart") {
    return {
      action: "restart",
      flagArgs: args.slice(1),
    };
  }
  if (args[0] === "open") {
    return {
      action: "open",
      flagArgs: args.slice(1),
    };
  }
  if (args[0] === "caddyfile") {
    return {
      action: "caddyfile",
      flagArgs: args.slice(1),
    };
  }
  if (args[0] === "edge") {
    return {
      action: "edge",
      flagArgs: args.slice(1),
    };
  }
  if (args[0] === "trust") {
    return {
      action: "trust",
      flagArgs: args.slice(1),
    };
  }
  if (args[0] === "control-plane") {
    const sub = args[1] === "start" || args[1] === "open" ? args[1] : "start";
    return {
      action: sub,
      flagArgs: args.slice(2),
    };
  }
  throw new ScoutCliError(`unknown subcommand: ${args[0]} (try: scout server open)`);
}

export function normalizeServerOpenPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "/";
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    throw new ScoutCliError("--path must be a local path, not an absolute URL");
  }
  if (trimmed.startsWith("/")) {
    return trimmed;
  }
  return `/${trimmed}`;
}

function resolveServerPort(env: NodeJS.ProcessEnv): number {
  const envValue = (env.OPENSCOUT_WEB_PORT ?? env.SCOUT_WEB_PORT)?.trim();
  if (envValue) {
    const port = Number.parseInt(envValue, 10);
    if (!Number.isFinite(port) || port <= 0) {
      throw new ScoutCliError(`invalid port: ${envValue}`);
    }
    return port;
  }
  return resolveWebPort();
}

function resolveServerEdgeScheme(env: NodeJS.ProcessEnv): OpenScoutLocalEdgeScheme {
  const value = env.OPENSCOUT_WEB_EDGE_SCHEME?.trim().toLowerCase();
  if (!value) return "both";
  if (value === "http" || value === "https" || value === "both") return value;
  throw new ScoutCliError(`invalid edge scheme: ${value}`);
}

function resolveServerLocalEdgeConfig(env: NodeJS.ProcessEnv): OpenScoutLocalEdgeConfig {
  const port = resolveServerPort(env);
  const portalHost = env.OPENSCOUT_WEB_PORTAL_HOST?.trim() || "scout.local";
  const nodeHost = env.OPENSCOUT_WEB_ADVERTISED_HOST?.trim()
    || (env.OPENSCOUT_WEB_LOCAL_NAME?.trim()
      ? resolveScoutWebNamedHostname(env.OPENSCOUT_WEB_LOCAL_NAME)
      : resolveConfiguredScoutWebHostname());
  return resolveOpenScoutLocalEdgeConfig({
    portalHost,
    nodeHost,
    scheme: resolveServerEdgeScheme(env),
    webPort: port,
    viteDevUrl: env.OPENSCOUT_WEB_VITE_URL,
    viteHmrPath: env.OPENSCOUT_WEB_VITE_HMR_PATH,
    extraHosts: splitEnvList(env.OPENSCOUT_WEB_TRUSTED_HOSTS),
  });
}

function resolveExpectedCurrentDirectory(env: NodeJS.ProcessEnv): string {
  return resolveOpenScoutSetupContextRoot({
    env,
    fallbackDirectory: process.cwd(),
  });
}

function renderModeLabel(mode: ScoutServerMode): string {
  return "Scout web";
}

function renderSurfaceLabel(surface: ScoutServerHealth["surface"]): string {
  switch (surface) {
    case "control-plane":
      return "control-plane";
    case "openscout-web":
      return "@openscout/web";
  }
}

function renderServerOpenResult(result: ScoutServerOpenResult): string {
  return `Opened Scout web at ${result.url}${result.reusedExistingServer ? "" : " (started server)"}`;
}

function renderLocalEdgeTrustResult(result: ScoutLocalEdgeTrustReport): string {
  const lines = [
    "Scout local HTTPS trust",
    `Status: ${result.status}`,
    `Detail: ${result.detail}`,
    `Root CA: ${result.rootCertificatePath}`,
  ];
  if (result.trustCommand) {
    lines.push(`Trust: ${result.trustCommand}`);
  }
  return lines.join("\n");
}

function isCurrentScoutWebSurface(surface: ScoutServerHealth["surface"]): boolean {
  return surface === "openscout-web" || surface === "control-plane";
}

function healthUrlForPort(port: number): URL {
  return new URL(`/api/health`, `http://127.0.0.1:${port}`);
}

export function resolveServerBrowserUrl(env: NodeJS.ProcessEnv, port: number, openPath: string): string {
  const publicOrigin = env.OPENSCOUT_WEB_PUBLIC_ORIGIN?.trim();
  const portalHost = env.OPENSCOUT_WEB_PORTAL_HOST?.trim() || "scout.local";
  const base = publicOrigin
    ? publicOrigin.replace(/\/+$/, "")
    : `http://${resolveScoutWebNamedHostname(portalHost)}:${port}`;
  return new URL(normalizeServerOpenPath(openPath), base).toString();
}

async function probeScoutServer(port: number): Promise<
  | { status: "healthy"; health: ScoutServerHealth }
  | { status: "unreachable" }
  | { status: "non-scout"; statusCode: number | null }
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERVER_HEALTH_TIMEOUT_MS);

  try {
    const response = await fetch(healthUrlForPort(port), {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        status: "non-scout",
        statusCode: response.status,
      };
    }

    let body: Partial<ScoutServerHealth>;
    try {
      body = await response.json() as Partial<ScoutServerHealth>;
    } catch {
      return {
        status: "non-scout",
        statusCode: response.status,
      };
    }

    if (
      body.ok === true
      && (body.surface === "control-plane" || body.surface === "openscout-web")
      && typeof body.currentDirectory === "string"
    ) {
      return {
        status: "healthy",
        health: {
          ok: true,
          surface: body.surface,
          currentDirectory: body.currentDirectory,
          brokerUrl: typeof body.brokerUrl === "string" ? body.brokerUrl : undefined,
        },
      };
    }
    return {
      status: "non-scout",
      statusCode: response.status,
    };
  } catch {
    return { status: "unreachable" };
  } finally {
    clearTimeout(timeout);
  }
}

async function openBrowser(url: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let command: string;
    let args: string[];

    if (process.platform === "darwin") {
      command = "open";
      args = [url];
    } else if (process.platform === "win32") {
      command = "cmd";
      args = ["/c", "start", "", url];
    } else {
      command = "xdg-open";
      args = [url];
    }

    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        rejectPromise(new ScoutCliError(`could not open a browser automatically; ${command} is not available`));
        return;
      }
      rejectPromise(error);
    });
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}

function resolveScoutWebServerLogPath(): string {
  const dir = join(resolveOpenScoutScoutHome(), "logs");
  mkdirSync(dir, { recursive: true });
  return join(dir, "web-server.log");
}

function resolveScoutLocalEdgeCaddyfilePath(): string {
  const dir = resolveOpenScoutLocalEdgeDirectory();
  mkdirSync(dir, { recursive: true });
  return join(dir, "Caddyfile");
}

function resolveCaddyExecutable(env: NodeJS.ProcessEnv): string {
  return env.OPENSCOUT_CADDY_BIN?.trim() || "caddy";
}

function spawnMdnsProxy(input: {
  name: string;
  host: string;
  port: number;
  scheme: "http" | "https";
}): ReturnType<typeof spawn>[] {
  return buildOpenScoutLocalEdgeMdnsCommands(input).map(({ command, args }) => {
    const child = spawn(command, args, { stdio: "ignore" });
    // Discovery is best effort: a missing publisher must not take the edge down.
    child.once("error", (error) => {
      console.warn(`[local-edge] mDNS advertisement for ${input.host} failed: ${error.message}`);
    });
    return child;
  });
}

async function runScoutLocalEdge(env: NodeJS.ProcessEnv): Promise<void> {
  const config = resolveServerLocalEdgeConfig(env);
  const schemes = config.scheme === "both" ? ["http", "https"] as const : [config.scheme] as const;
  const caddyfilePath = resolveScoutLocalEdgeCaddyfilePath();
  writeFileSync(caddyfilePath, renderOpenScoutCaddyfile(config), "utf8");

  const mdnsProcesses = schemes.flatMap((scheme) => {
    const edgePort = scheme === "https" ? 443 : 80;
    const suffix = scheme.toUpperCase();
    return [
      ...spawnMdnsProxy({
        name: `Scout Local ${suffix}`,
        host: config.portalHost,
        port: edgePort,
        scheme,
      }),
      ...spawnMdnsProxy({
        name: `Scout ${config.nodeHost} ${suffix}`,
        host: config.nodeHost,
        port: edgePort,
        scheme,
      }),
    ];
  });

  const cleanup = () => {
    for (const processRef of mdnsProcesses) {
      if (!processRef.killed) {
        processRef.kill("SIGTERM");
      }
    }
  };

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const caddy = spawn(resolveCaddyExecutable(env), [
      "run",
      "--config",
      caddyfilePath,
      "--adapter",
      "caddyfile",
    ], {
      stdio: "inherit",
      env,
    });
    caddy.once("error", (error: NodeJS.ErrnoException) => {
      cleanup();
      if (error.code === "ENOENT") {
        rejectPromise(new ScoutCliError("Caddy is not installed. Install Caddy or set OPENSCOUT_CADDY_BIN."));
        return;
      }
      rejectPromise(error);
    });

    caddy.once("exit", (code, signal) => {
      cleanup();
      if (signal === "SIGINT" || signal === "SIGTERM") {
        resolvePromise();
        return;
      }
      if (signal) {
        rejectPromise(new ScoutCliError(`local edge exited on signal ${signal}`));
        return;
      }
      if (code !== 0 && code !== null) {
        rejectPromise(new ScoutCliError(`local edge exited with code ${code}`));
        return;
      }
      resolvePromise();
    });
  });
}

async function spawnDetachedServer(entry: string, env: NodeJS.ProcessEnv): Promise<void> {
  const bunExecutable = resolveBunExecutable(env);
  const logPath = resolveScoutWebServerLogPath();
  const logFd = openSync(logPath, "a");

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(
      bunExecutable,
      ["run", entry],
      {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env,
        windowsHide: true,
      },
    );
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        rejectPromise(
          new ScoutCliError(
            "`bun` was not found on PATH. Install Bun (https://bun.sh) to run scout server.",
          ),
        );
        return;
      }
      rejectPromise(error);
    });
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}

async function waitForScoutServer(
  port: number,
  mode: ScoutServerMode,
  expectedCurrentDirectory: string,
  expectedBrokerUrl?: string,
): Promise<void> {
  const deadline = Date.now() + SERVER_OPEN_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const probe = await probeScoutServer(port);
    if (probe.status === "healthy") {
      const actualCurrentDirectory = resolve(probe.health.currentDirectory);
      if (!isCurrentScoutWebSurface(probe.health.surface)) {
        throw new ScoutCliError(
          `port ${port} is serving Scout ${renderSurfaceLabel(probe.health.surface)}, not ${renderModeLabel(mode)}.`,
        );
      }
      if (actualCurrentDirectory !== expectedCurrentDirectory) {
        throw new ScoutCliError(
          `port ${port} is already serving Scout for ${actualCurrentDirectory}, not ${expectedCurrentDirectory}.`,
        );
      }
      if (!brokerUrlMatches(probe.health.brokerUrl, expectedBrokerUrl)) {
        throw new ScoutCliError(
          `port ${port} is serving Scout with broker ${probe.health.brokerUrl}, not ${expectedBrokerUrl}. Restart the Scout web server.`,
        );
      }
      return;
    }
    if (probe.status === "non-scout") {
      throw new ScoutCliError(`port ${port} is already serving another HTTP app or an older Scout server; choose a different --port.`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }

  throw new ScoutCliError(
    `timed out waiting for ${renderModeLabel(mode)} on port ${port}; check ${resolveScoutWebServerLogPath()} for the child process output`,
  );
}

async function openScoutServer(options: {
  entry: string;
  mode: ScoutServerMode;
  env: NodeJS.ProcessEnv;
  openPath: string;
}): Promise<ScoutServerOpenResult> {
  const port = resolveServerPort(options.env);
  const expectedCurrentDirectory = resolveExpectedCurrentDirectory(options.env);
  const expectedBrokerUrl = options.env.OPENSCOUT_BROKER_INTERNAL_URL?.trim();
  const browserUrl = resolveServerBrowserUrl(options.env, port, options.openPath);
  const probe = await probeScoutServer(port);

  if (probe.status === "healthy") {
    const actualCurrentDirectory = resolve(probe.health.currentDirectory);
    if (!isCurrentScoutWebSurface(probe.health.surface)) {
      throw new ScoutCliError(
        `port ${port} is already serving Scout ${renderSurfaceLabel(probe.health.surface)}, not ${renderModeLabel(options.mode)}.`,
      );
    }
    if (actualCurrentDirectory !== expectedCurrentDirectory) {
      throw new ScoutCliError(
        `port ${port} is already serving Scout for ${actualCurrentDirectory}, not ${expectedCurrentDirectory}.`,
      );
    }
    if (!brokerUrlMatches(probe.health.brokerUrl, expectedBrokerUrl)) {
      throw new ScoutCliError(
        `port ${port} is already serving Scout with broker ${probe.health.brokerUrl}, not ${expectedBrokerUrl}. Restart the Scout web server.`,
      );
    }
    await openBrowser(browserUrl);
    return {
      url: browserUrl,
      port,
      mode: options.mode,
      reusedExistingServer: true,
    };
  }

  if (probe.status === "non-scout") {
    throw new ScoutCliError(`port ${port} is already serving another HTTP app or an older Scout server; choose a different --port.`);
  }

  await spawnDetachedServer(options.entry, options.env);
  await waitForScoutServer(port, options.mode, expectedCurrentDirectory, expectedBrokerUrl);
  await openBrowser(browserUrl);
  return {
    url: browserUrl,
    port,
    mode: options.mode,
    reusedExistingServer: false,
  };
}

export async function requestScoutWebControl(
  action: "start" | "restart",
  options: {
    brokerUrl?: string;
    fetchImpl?: ScoutFetch;
  } = {},
): Promise<ScoutWebControlStatus> {
  const brokerUrl = options.brokerUrl ?? resolveScoutBrokerUrl();
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(new URL(`/v1/web/${action}`, brokerUrl), {
      method: "POST",
      headers: { accept: "application/json", connection: "close" },
      signal: AbortSignal.timeout(SERVER_CONTROL_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ScoutCliError(
      `Scout broker did not respond while trying to ${action} the web server: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const status = await response.json().catch(() => null) as ScoutWebControlStatus | null;
  if (!response.ok || !status?.ok) {
    throw new ScoutCliError(status?.error ?? `Scout broker could not ${action} the web server (HTTP ${response.status}).`);
  }
  return status;
}

function renderServerControlResult(action: "start" | "restart", status: ScoutWebControlStatus): string {
  const verb = action === "start" ? "Started" : "Restarted";
  const ownership = status.managed ? "broker-managed" : "already running outside broker management";
  return `${verb} Scout web at ${status.webUrl} (${ownership}).`;
}

export async function runServerCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    context.output.writeText(renderServerCommandHelp());
    return;
  }

  const selection = parseServerSelection(args);
  const { env: flagEnv, openPath, openPathSpecified } = parseServerFlags(selection.flagArgs);
  assertBrokerManagedLifecycleFlags(selection.action, flagEnv, openPathSpecified);
  const mergedEnv = buildServerCommandEnv(flagEnv);

  if (selection.action === "open") {
    const status = await requestScoutWebControl("start");
    const browserUrl = resolveServerBrowserUrl(mergedEnv, status.port, openPath);
    await openBrowser(browserUrl);
    context.output.writeText(`Opened Scout web at ${browserUrl} (${status.managed ? "broker-managed" : "already running outside broker management"}).`);
    return;
  }

  if (selection.action === "caddyfile") {
    context.output.writeText(renderOpenScoutCaddyfile(resolveServerLocalEdgeConfig(mergedEnv)));
    return;
  }

  if (selection.action === "edge") {
    await runScoutLocalEdge(mergedEnv);
    return;
  }

  if (selection.action === "trust") {
    context.output.writeText(renderLocalEdgeTrustResult(ensureScoutLocalEdgeTrust({ env: mergedEnv })));
    return;
  }

  if (selection.action === "restart") {
    const status = await requestScoutWebControl("restart");
    context.output.writeText(renderServerControlResult("restart", status));
    return;
  }
  const status = await requestScoutWebControl("start");
  context.output.writeText(renderServerControlResult("start", status));
}

type ScoutServerWebControlStatus = {
  ok: boolean;
  running: boolean;
  starting: boolean;
  webUrl: string | null;
  port: number | null;
  pid: number | null;
  error?: string | null;
};

type ScoutServerRestartResult = {
  webUrl: string | null;
  port: number | null;
  previousPid: number | null;
  newPid: number | null;
  drainMs: number;
  totalMs: number;
};

async function fetchWebControlStatus(): Promise<ScoutServerWebControlStatus> {
  const brokerUrl = resolveScoutBrokerUrl();
  const response = await fetch(new URL("/v1/web/status", brokerUrl));
  if (!response.ok) {
    throw new ScoutCliError(`broker web control endpoint returned HTTP ${response.status}`);
  }
  return await response.json() as ScoutServerWebControlStatus;
}

async function waitForWebControl(
  predicate: (status: ScoutServerWebControlStatus) => boolean,
  timeoutMs: number,
  intervalMs = 150,
): Promise<ScoutServerWebControlStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: ScoutServerWebControlStatus | null = null;
  while (Date.now() < deadline) {
    last = await fetchWebControlStatus().catch(() => last);
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (!last) {
    throw new ScoutCliError("broker web control endpoint did not respond within the timeout");
  }
  return last;
}

async function restartScoutWebServer(): Promise<ScoutServerRestartResult> {
  const started = Date.now();
  const before = await fetchWebControlStatus().catch(() => null);
  if (!before || !before.pid) {
    throw new ScoutCliError(
      "Scout web server is not running under the broker service - start it with `scout server start`.",
    );
  }
  const previousPid = before.pid;

  try {
    process.kill(previousPid, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
      throw new ScoutCliError(`not permitted to signal pid ${previousPid}`);
    }
    if (code === "ESRCH") {
      // Already gone — let the broker bring it back.
    } else {
      throw error;
    }
  }

  const drained = await waitForWebControl(
    (status) => status.pid === null || status.pid !== previousPid,
    12_000,
  );
  const drainMs = Date.now() - started;

  const respawned = drained.pid && drained.pid !== previousPid
    ? drained
    : await waitForWebControl((status) => status.running && status.pid !== null && status.pid !== previousPid, 15_000);

  return {
    webUrl: respawned.webUrl,
    port: respawned.port,
    previousPid,
    newPid: respawned.pid,
    drainMs,
    totalMs: Date.now() - started,
  };
}

function renderServerRestartResult(value: ScoutServerRestartResult): string {
  return [
    `Restarted Scout web server`,
    `  Previous PID: ${value.previousPid}`,
    `  New PID:      ${value.newPid ?? "(unknown)"}`,
    `  URL:          ${value.webUrl ?? "(unknown)"}`,
    `  Drain:        ${value.drainMs}ms`,
    `  Total:        ${value.totalMs}ms`,
  ].join("\n");
}
