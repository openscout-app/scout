import { LOOPBACK_HTTP_PROXY_POLICY } from "./mesh-loopback-proxy.js";
/**
 * Read-only ingress inventory for the broker's privileged loopback deployment.
 * A clean snapshot is NOT evidence of isolation: unknown/reconfigured relays can
 * proxy into TCP or Unix sockets after this scan. Consequently scans never authorize
 * scoped activation. Only gate-derived protection of every local transport
 * can establish the broker authentication boundary; an env
 * flag or a relay's claimed authentication is not a substitute for that design.
 */
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isMeshBridgeCommand } from "./scout-bridge-command.js";
import { resolveOpenScoutSupportPaths } from "./support-paths.js";

export type MeshAccessObservedRelayStatus = "active" | "configured" | "not-observed" | "unknown";
export type MeshAccessRelayStatus = MeshAccessObservedRelayStatus | "broker-auth-required";
export type MeshAccessIngressRelay = {
  id: string;
  status: MeshAccessRelayStatus;
  observedStatus: MeshAccessObservedRelayStatus;
  /** Source identifiers only: never command lines, credentials or config text. */
  proof: string[];
  reason: string;
  /** No existing relay has a reviewed scoped-caller authentication proof. */
  callerAuthentication: "unproven" | "broker-enforced";
};
export type MeshAccessIngressPosture = {
  enforced: boolean;
  localHttpProxyPolicy: typeof LOOPBACK_HTTP_PROXY_POLICY;
  observedAt: number;
  deployment: "privileged-loopback";
  activation: "blocked" | "permitted";
  relays: MeshAccessIngressRelay[];
  reason: string;
};
export type MeshAccessIngressCommandResult = { ok: boolean; stdout: string };
export type MeshAccessIngressFileResult =
  | { status: "missing" | "unreadable" }
  | { status: "present"; text?: string };
export type MeshAccessIngressProbe = {
  command: (file: string, args: string[]) => Promise<MeshAccessIngressCommandResult>;
  file: (path: string, readContents: boolean) => Promise<MeshAccessIngressFileResult>;
};
export type MeshAccessIngressOptions = {
  /** Must come from the running gate, with its cryptographic admin credential
   * configured and uncredentialled TCP/Unix traffic treated as remote; upgrades denied.
   * Never derive this from an environment assertion, process scan, or relay.
   */
  protectedLocalIngress?: boolean;
  env?: NodeJS.ProcessEnv;
  supportDirectory?: string;
  home?: string;
  /** This node's configured entrypoints, not a remote-peer inventory. */
  entrypoints?: readonly { kind: string }[];
  now?: number;
};
const execFileAsync = promisify(execFile);
const defaultProbe: MeshAccessIngressProbe = {
  async command(file, args) {
    try {
      const result = await execFileAsync(file, args, { encoding: "utf8", timeout: 1500, maxBuffer: 2 * 1024 * 1024 });
      return { ok: true, stdout: result.stdout };
    } catch { return { ok: false, stdout: "" }; }
  },
  async file(path, readContents) {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > 1024 * 1024) return { status: "unreadable" };
      return { status: "present", ...(readContents ? { text: await readFile(path, "utf8") } : {}) };
    } catch (error) {
      return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
    }
  },
};
function relay(id: string): MeshAccessIngressRelay {
  return { id, status: "not-observed", observedStatus: "not-observed", proof: [], reason: "No matching relay was observed in the available snapshot; absence is not proof of isolation.", callerAuthentication: "unproven" };
}
const severity: Record<MeshAccessObservedRelayStatus, number> = { "not-observed": 0, configured: 1, unknown: 2, active: 3 };
function evidence(item: MeshAccessIngressRelay, status: MeshAccessObservedRelayStatus, proof: string, reason: string): void {
  item.proof.push(proof);
  if (severity[status] >= severity[item.observedStatus]) { item.status = status; item.observedStatus = status; item.reason = reason; }
}
function parsedObject(text: string | undefined): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text ?? "");
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch { return undefined; }
}
function hasConfiguration(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasConfiguration);
  if (value && typeof value === "object") return Object.values(value).some(hasConfiguration);
  return value !== null && value !== undefined && value !== false && value !== "";
}

/** Bounded read-only probes. Probe failures and unreadable configs fail closed.
 * Dependency injection exists for deterministic tests, not operator overrides.
 */
export async function inspectMeshAccessIngressPosture(
  input: MeshAccessIngressOptions = {}, probe: MeshAccessIngressProbe = defaultProbe,
): Promise<MeshAccessIngressPosture> {
  const env = input.env ?? process.env;
  const home = input.home ?? homedir();
  const support = input.supportDirectory ?? resolveOpenScoutSupportPaths().supportDirectory;
  const items = {
    iroh: relay("iroh"), mesh: relay("mesh-mcp-bridge"), cloudflare: relay("cloudflare-tunnel"),
    tailscale: relay("tailscale-serve-funnel"), edge: relay("local-edge-web-proxy"), other: relay("other-proxy-processes"),
  };
  // Enable/disable environment switches can explain config; none prove safety.
  for (const name of ["OPENSCOUT_IROH_BRIDGE_BIN", "OPENSCOUT_IROH_ENDPOINT_ADDR_JSON", "OPENSCOUT_IROH_ENDPOINT_ID"]) {
    if (env[name]?.trim()) evidence(items.iroh, "configured", `environment:${name}`, "Iroh can forward remote requests to the privileged broker without scoped caller authentication.");
  }
  for (const entrypoint of input.entrypoints ?? []) {
    const item = entrypoint.kind === "iroh" ? items.iroh : entrypoint.kind === "cloudflare_tunnel" ? items.cloudflare : entrypoint.kind === "http" ? undefined : items.other;
    if (item) evidence(item, "configured", "local-node-entrypoints", "A local relay entrypoint is configured; its scoped caller authentication is unproven.");
  }
  const fileSpecs = [
    { item: items.mesh, path: join(support, "mcp-bridge.json"), source: "support:mcp-bridge.json", contents: true },
    { item: items.mesh, path: join(support, "runtime", "mesh-bridge.json"), source: "support:runtime/mesh-bridge.json", contents: true },
    { item: items.mesh, path: join(home, "Library", "LaunchAgents", "app.openscout.mcp-bridge.plist"), source: "launchagent:app.openscout.mcp-bridge", contents: false },
    { item: items.edge, path: join(home, ".scout", "local-edge", "Caddyfile"), source: "local-edge:Caddyfile", contents: false },
    ...[join(home, ".cloudflared", "config.yml"), join(home, ".cloudflared", "config.yaml"), "/etc/cloudflared/config.yml", "/etc/cloudflared/config.yaml"].map((path, index) => ({ item: items.cloudflare, path, source: `cloudflared:config-location-${index + 1}`, contents: false })),
  ];
  const safeCommand = async (file: string, args: string[]) => {
    try { return await probe.command(file, args); } catch { return { ok: false, stdout: "" }; }
  };
  const [processes, serve, funnel, files] = await Promise.all([
    safeCommand("ps", ["-axo", "pid=,args="]),
    safeCommand("tailscale", ["serve", "status", "--json"]),
    safeCommand("tailscale", ["funnel", "status", "--json"]),
    Promise.all(fileSpecs.map(async (spec) => {
      try { return await probe.file(spec.path, spec.contents); } catch { return { status: "unreadable" } as const; }
    })),
  ]);
  for (let i = 0; i < fileSpecs.length; i++) {
    const spec = fileSpecs[i]!, result = files[i]!;
    if (result.status === "unreadable") evidence(spec.item, "unknown", spec.source, "Relay configuration could not be inspected.");
    else if (result.status === "present") {
      if (spec.contents && !parsedObject(result.text)) evidence(spec.item, "unknown", spec.source, "Relay configuration/state is invalid or unreadable.");
      else evidence(spec.item, "configured", spec.source, "Relay configuration/state exists; neither a disabled flag nor a saved process state proves independent caller authentication or absence of another instance.");
    }
  }
  for (const [result, source] of [[serve, "tailscale:serve-status"], [funnel, "tailscale:funnel-status"]] as const) {
    const config = result.ok ? parsedObject(result.stdout) : undefined;
    if (!config) evidence(items.tailscale, "unknown", source, "Tailscale serve/funnel configuration could not be established (missing CLI, daemon, permission, timeout, or invalid output).");
    else if (hasConfiguration(config)) evidence(items.tailscale, "active", source, "Tailscale reports serve/funnel configuration. Local HTTP requests carrying proxy headers are refused, including upgrades. TCP forwarding or a relay stripping these headers remains indistinguishable from a local client without protected ingress.");
    else items.tailscale.proof.push(`${source}:empty`);
  }
  const processRows = processes.ok ? processes.stdout.split(/\r?\n/).filter((line) => line.trim()).map((line) => /^\s*(\d+)\s+(.+)$/.exec(line)) : [];
  if (!processRows.length || processRows.some((row) => !row)) {
    for (const item of Object.values(items)) evidence(item, "unknown", "process-table:unavailable", "The process table is unavailable or incomplete; active relays cannot be excluded.");
  } else {
    for (const row of processRows) {
      const pid = row![1]!, args = row![2]!;
      const executable = args.trim().split(/\s+/, 1)[0]!.split("/").pop()!.toLowerCase();
      let item: MeshAccessIngressRelay | undefined;
      if (isMeshBridgeCommand(args)) item = items.mesh;
      else if (/iroh/.test(executable) && /(?:^|\s)serve(?:\s|$)/.test(args)) item = items.iroh;
      else if (executable === "cloudflared") item = items.cloudflare;
      else if (["caddy", "scout-edge", "openscout-edge"].includes(executable)) item = items.edge;
      else if (["nginx", "haproxy", "socat", "rathole", "frpc", "ngrok"].includes(executable) || (executable === "ssh" && /(?:^|\s)-(?:[A-Za-z]*[LRD]|o(?:\s|=)?(?:LocalForward|RemoteForward|DynamicForward))/.test(args))) item = items.other;
      if (item) evidence(item, "active", `process:pid:${pid}`, "A potential ingress relay process is active; its forwarding destination and scoped caller authentication are not proven.");
    }
  }
  const unclassified = relay("unclassified-loopback-ingress");
  evidence(unclassified, "unknown", "architecture:privileged-tcp-and-unix-local-transports", "Config and process snapshots cannot exclude custom, renamed, external, or subsequently started relays into trusted TCP/Unix transports. Scoped activation requires a listener that authenticates every request without a privileged loopback fallback; this shared deployment is unsupported.");
  const relays = [...Object.values(items), unclassified];
  const protectedLocalIngress = input.protectedLocalIngress === true;
  if (protectedLocalIngress) {
    for (const item of relays) {
      item.status = "broker-auth-required";
      item.callerAuthentication = "broker-enforced";
      item.proof.push("ingress-gate:cryptographic-local-administration:no-tcp-unix-upgrade-loopback-bypass");
      item.reason = "The broker gate requires cryptographic administration credentials for privileged local access and treats uncredentialled TCP/Unix as remote and denies upgrades. Relay identity is not trusted; scoped callers must present their own verified proof.";
    }
  }
  return {
    localHttpProxyPolicy: LOOPBACK_HTTP_PROXY_POLICY,
    enforced: protectedLocalIngress, observedAt: input.now ?? Date.now(), deployment: "privileged-loopback", activation: protectedLocalIngress ? "permitted" : "blocked",
    relays,
    reason: protectedLocalIngress
      ? "Every ingress path meets the broker authentication boundary, including unknown relays; process/config observations grant no trust."
      : "Effective remote ingress enforcement is unproven on the privileged-loopback broker. Known relay absence never authorizes activation; protect every local broker transport before activation.",
  };
}
