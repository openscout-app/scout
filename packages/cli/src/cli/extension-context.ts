import type { ExtensionInputMetadata } from "./extension-input-session.ts";
import { resolve, join, isAbsolute } from "node:path";
import type { OpenScoutInstanceLayout } from "@openscout/runtime/config";
import { resolveScoutHome } from "@openscout/runtime/config";
import { SCOUT_EXTENSION_CONTEXT_SCHEMA, type ScoutExtensionContextFeature, type ScoutExtensionInvocation } from "@openscout/runtime/extensions";
import { ScoutCommandUnavailableError } from "./command-unavailable.ts";

export const EXTENSION_CONTEXT_MAX_BYTES = 64 * 1024;
const CONFIG = {
  "web.selection/v1": { profile: ["OPENSCOUT_WEB_CLIENT_PROFILE"] },
  "distribution.endpoint/v1": { endpoint: ["OPENSCOUT_DIST_URL"] },
  "pair.configuration/v1": {
    port: ["OPENSCOUT_PAIRING_PORT", "SCOUT_PAIRING_PORT"], relayUrl: ["OPENSCOUT_PAIRING_RELAY_URL"], mobileRelayUrl: ["OPENSCOUT_MOBILE_PAIRING_RELAY_URL"],
    discovery: ["OPENSCOUT_NETWORK_DISCOVERY_ENABLED", "OPENSCOUT_OSN_DISCOVERY_ENABLED"], logLevel: ["OPENSCOUT_BRIDGE_LOG_LEVEL"],
  },
  "runtime.tools/v1": {
    bun: ["OPENSCOUT_BUN_BIN", "SCOUT_BUN_BIN"], caddy: ["OPENSCOUT_CADDY_BIN"], tailscale: ["OPENSCOUT_TAILSCALE_BIN"],
    tmux: ["OPENSCOUT_TMUX_BIN"], scoutd: ["OPENSCOUT_SCOUTD_BIN"], scout: ["OPENSCOUT_SCOUT_BIN"],
  },
  "menu.bootstrap/v1": { telemetryBootstrap: ["OPENSCOUT_PROVIDER_TELEMETRY_BOOTSTRAP"], scoutCommand: ["OPENSCOUT_SCOUT_COMMAND"], statuslineInstance: ["OPENSCOUT_STATUSLINE_INSTANCE"] },
  "server.configuration/v1": {
    host: ["OPENSCOUT_WEB_HOST", "SCOUT_WEB_HOST"], port: ["OPENSCOUT_WEB_PORT", "SCOUT_WEB_PORT"],
    viteUrl: ["OPENSCOUT_WEB_VITE_URL"], edgeScheme: ["OPENSCOUT_WEB_EDGE_SCHEME"], portalHost: ["OPENSCOUT_WEB_PORTAL_HOST"],
    advertisedHost: ["OPENSCOUT_WEB_ADVERTISED_HOST"], localName: ["OPENSCOUT_WEB_LOCAL_NAME"], viteHmrPath: ["OPENSCOUT_WEB_VITE_HMR_PATH"],
    publicOrigin: ["OPENSCOUT_WEB_PUBLIC_ORIGIN"], trustedHosts: ["OPENSCOUT_WEB_TRUSTED_HOSTS"],
    trustedOrigins: ["OPENSCOUT_WEB_TRUSTED_ORIGINS"], staticRoot: ["OPENSCOUT_WEB_STATIC_ROOT"],
  },
} as const;
const PATH_KEYS = ["SCOUT_HOME", "OPENSCOUT_HOME", "OPENSCOUT_SCOUT_HOME", "OPENSCOUT_SUPPORT_DIRECTORY", "OPENSCOUT_CONTROL_HOME", "OPENSCOUT_CONTROL_PLANE_DB", "OPENSCOUT_PAIRING_HOME", "SCOUT_PAIRING_HOME", "OPENSCOUT_PAIRING_DIR", "OPENSCOUT_RELAY_HUB", "OPENSCOUT_SETUP_CWD", "OPENSCOUT_BROKER_SOCKET_PATH", "OPENSCOUT_APP_SOCKET", "OPENSCOUT_PROBES_SOCKET", "OPENSCOUT_SERVICE_LABEL", "OPENSCOUT_BROKER_SERVICE_LABEL", "OPENSCOUT_SYSTEMD_UNIT", "OPENSCOUT_BROKER_SERVICE_MODE", "OPENSCOUT_BROKER_INTERNAL_URL"];
export type ScoutExtensionSelection = { layout: OpenScoutInstanceLayout; home: string; uid: number; cwd: string; values: Record<string, string | undefined> };
let selected: ScoutExtensionSelection | undefined;
/** Called only after the existing bootstrap/isolation fence. No I/O or reselection. */
export function captureScoutExtensionSelection(input: Omit<ScoutExtensionSelection, "values"> & { env: NodeJS.ProcessEnv }): ScoutExtensionSelection {
  const keys = new Set([...PATH_KEYS, ...Object.values(CONFIG).flatMap(fields => Object.values(fields).flat())]);
  const values = Object.fromEntries([...keys].map(key => [key, input.env[key]])); // Deliberately not an environment dump.
  return { layout: structuredClone(input.layout), home: input.home, uid: input.uid, cwd: input.cwd, values };
}
export function rememberScoutExtensionSelection(selection: ScoutExtensionSelection): void { selected = selection; }
export function selectedScoutExtensionInvocation(): ScoutExtensionSelection | undefined { return selected; }
export function contextRefusal(name: string, reason: "context_invalid" | "selection_changed" | "context_delivery_failed" | "context_backend_unproven" = "context_invalid"): never {
  throw new ScoutCommandUnavailableError(name, reason, reason === "context_backend_unproven"
    ? "API-2 context transport is unavailable on this runtime; use a qualified loader/runtime. API 1 remains supported."
    : "The selected API-2 invocation context is invalid or unsupported; inspect its declaration and selected instance.");
}
function safeText(value: string): boolean { return value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value)
  && (value.match(/[a-z][a-z0-9+.-]*:\/\/[^\s,]+/gi) ?? []).every(safeUrl); }
function safeUrl(value: string): boolean {
  try { const url = new URL(value); return ["http:", "https:", "ws:", "wss:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
}
export type ScoutExtensionIdentity = { name: string; selectedRoot: string; readRoots: string[]; artifact: string; version: string | null; treeDigest: string };
/** Finite pure projection from an already selected snapshot. Never reads config, keys, env or the instance ledger. */
export function projectScoutExtensionContext(input: {
  selection: ScoutExtensionSelection; extension: ScoutExtensionIdentity; invocation: ScoutExtensionInvocation;
  cli: { version: string; executable: string; runtimeExecutable: string; output: "plain" | "json"; cwd: string };
  brokerUrl: string; ports?: { broker?: number; web?: number; pairing?: number };
}) {
  const { selection: s, extension, invocation, cli } = input, env = s.values, layout = s.layout;
  const fail = () => contextRefusal(extension.name);
  if (!Number.isSafeInteger(s.uid) || s.uid < 0 || !isAbsolute(s.home) || !isAbsolute(s.cwd)
    || cli.cwd !== s.cwd || !layout.name || (layout.isProd !== (layout.name === "prod"))) fail();
  const raw = (keys: string[], fallback?: string) => keys.map(key => env[key]?.trim()).find(Boolean) ?? fallback;
  const path = (keys: string[], fallback: string) => resolve(s.cwd, raw(keys, fallback)!);
  const controlHome = path(["OPENSCOUT_CONTROL_HOME"], layout.controlHome);
  const configuration: Record<string, Record<string, { present: boolean; source: string | null; value: string | null }>> = {};
  for (const id of invocation.requires) {
    if (id === "selection/v1") continue;
    const fields = CONFIG[id]; if (!fields) fail();
    const entries: typeof configuration[string] = {};
    for (const [field, keys] of Object.entries(fields)) {
      const source = (keys as readonly string[]).find((key: string) => env[key]?.trim()); const value = source ? env[source]!.trim() : null;
      if (value !== null && (!safeText(value)
        || (["endpoint", "relayUrl", "mobileRelayUrl", "viteUrl", "publicOrigin"].includes(field) && !safeUrl(value))
        || (field === "trustedOrigins" && !value.split(",").every(item => safeUrl(item.trim()))))) fail();
      entries[field] = { present: source !== undefined, source: source ?? null, value };
    }
    configuration[id] = entries;
  }
  const internalUrl = raw(["OPENSCOUT_BROKER_INTERNAL_URL"]) ?? null;
  if (!safeUrl(input.brokerUrl) || (internalUrl !== null && !safeUrl(internalUrl))) fail();
  const ports = { ...layout.ports, broker: input.ports?.broker ?? layout.ports.broker, web: input.ports?.web ?? layout.ports.web, pairingBridge: input.ports?.pairing ?? layout.ports.pairingBridge };
  if (!Object.values(ports).every(port => Number.isInteger(port) && port > 0 && port <= 65535)) fail();
  const selectedMode = raw(["OPENSCOUT_BROKER_SERVICE_MODE"]);
  const mode = selectedMode === undefined ? null : ["prod", "production"].includes(selectedMode.toLowerCase()) ? "prod" : selectedMode.toLowerCase() === "custom" ? "custom" : "dev";
  const explicitUnit = raw(["OPENSCOUT_SYSTEMD_UNIT"]);
  const systemdUnit = explicitUnit === undefined ? layout.systemdUnitName : explicitUnit.endsWith(".service") ? explicitUnit : `${explicitUnit}.service`;
  const frame = {
    schema: SCOUT_EXTENSION_CONTEXT_SCHEMA, api: 2 as const, features: [...new Set(["selection/v1", ...invocation.requires])] as ScoutExtensionContextFeature[],
    cli: { ...cli }, selection: { uid: s.uid, home: s.home, instance: layout.name, instanceRoot: layout.root, meshAllowed: layout.meshAllowed },
    paths: {
      scoutHome: resolve(s.cwd, resolveScoutHome({ env, home: s.home })), runtimeScoutHome: path(["OPENSCOUT_SCOUT_HOME"], layout.scoutHome), openScoutHome: path(["OPENSCOUT_HOME"], layout.openscoutHome),
      supportDirectory: path(["OPENSCOUT_SUPPORT_DIRECTORY"], layout.supportDirectory), controlHome,
      controlPlaneDb: path(["OPENSCOUT_CONTROL_PLANE_DB"], join(controlHome, "control-plane.sqlite")),
      pairingHome: path(["OPENSCOUT_PAIRING_HOME", "SCOUT_PAIRING_HOME", "OPENSCOUT_PAIRING_DIR"], raw(["OPENSCOUT_SCOUT_HOME"]) ? join(raw(["OPENSCOUT_SCOUT_HOME"])!, "pairing") : layout.pairingHome),
      relayHub: path(["OPENSCOUT_RELAY_HUB"], layout.relayHub), setupCwd: path(["OPENSCOUT_SETUP_CWD"], s.cwd),
    }, extensions: { ...extension, readRoots: [...extension.readRoots] },
    broker: { controlUrl: input.brokerUrl, internalUrl, socketPath: path(["OPENSCOUT_BROKER_SOCKET_PATH"], layout.brokerSocketPath) },
    services: { appSocket: path(["OPENSCOUT_APP_SOCKET"], layout.appSocketPath), probesSocket: path(["OPENSCOUT_PROBES_SOCKET"], layout.probesSocketPath),
      label: raw(["OPENSCOUT_SERVICE_LABEL", "OPENSCOUT_BROKER_SERVICE_LABEL"], layout.isProd && raw(["OPENSCOUT_BROKER_SERVICE_MODE"])?.toLowerCase() === "custom" ? "app.openscout.custom" : layout.serviceLabel)!, systemdUnit,
      mode, ports }, configuration, credentialInputs: [] as ExtensionInputMetadata[],
  };
  const stringsSafe = (value: unknown): boolean => typeof value === "string" ? safeText(value)
    : Array.isArray(value) ? value.every(stringsSafe) : value && typeof value === "object" ? Object.values(value).every(stringsSafe) : true;
  if (!stringsSafe(frame)) fail();
  return frame;
}
export type ScoutExtensionContext = ReturnType<typeof projectScoutExtensionContext>;
export function encodeScoutExtensionContext(frame: ScoutExtensionContext): Buffer {
  const wire = Buffer.from(JSON.stringify(frame) + "\n");
  if (wire.length > EXTENSION_CONTEXT_MAX_BYTES) contextRefusal(frame.extensions.name);
  return wire;
}
