import { describe, expect, test } from "bun:test";
import { inspectMeshAccessIngressPosture, type MeshAccessIngressProbe, type MeshAccessIngressPosture } from "./mesh-access-ingress-posture.js";

function probe(input: { processes?: string; tailscale?: string; files?: Record<string, string>; fail?: boolean } = {}): MeshAccessIngressProbe {
  return {
    command: async (file) => input.fail ? { ok: false, stdout: "" } : { ok: true, stdout: file === "ps" ? input.processes ?? "10 /usr/bin/node broker.js\n" : input.tailscale ?? "{}" },
    file: async (path, contents) => input.fail ? { status: "unreadable" } : Object.hasOwn(input.files ?? {}, path) ? { status: "present", ...(contents ? { text: input.files![path] } : {}) } : { status: "missing" },
  };
}
const options = { env: {}, home: "/home/test", supportDirectory: "/state/scout", now: 12345 };
const item = (report: MeshAccessIngressPosture, id: string) => report.relays.find((value) => value.id === id)!;

describe("scoped access ingress posture", () => {
  test("clean snapshots cannot prove privileged loopback isolated or authorize activation", async () => {
    const report = await inspectMeshAccessIngressPosture(options, probe());
    expect(report.localHttpProxyPolicy).toBe("reject-forwarding-headers");
    expect(report.enforced).toBe(false);
    expect(report.activation).toBe("blocked");
    expect(report.observedAt).toBe(12345);
    expect(item(report, "unclassified-loopback-ingress").status).toBe("unknown");
    expect(report.relays.every((relay) => relay.callerAuthentication === "unproven")).toBe(true);
  });
  test("gate-derived authentication protects every relay, including unknown and failed probes", async () => {
    const report = await inspectMeshAccessIngressPosture({ ...options, protectedLocalIngress: true }, probe({ fail: true }));
    expect(report.enforced).toBe(true);
    expect(report.activation).toBe("permitted");
    expect(report.relays.every((relay) => relay.status === "broker-auth-required" && relay.callerAuthentication === "broker-enforced")).toBe(true);
    expect(item(report, "unclassified-loopback-ingress").observedStatus).toBe("unknown");
    expect(report.relays.every((relay) => relay.proof.some((proof) => proof.startsWith("ingress-gate:")))).toBe(true);
  });
  test("active relay processes remain diagnostic and expose neither argv nor tokens", async () => {
    const report = await inspectMeshAccessIngressPosture(options, probe({ processes: [
      "10 /usr/local/bin/iroh-bridge serve --broker-url http://localhost:43120",
      "11 /usr/local/bin/bun /opt/scout/bin/scout.ts mesh bridge --token secret-do-not-emit",
      "12 /usr/bin/cloudflared tunnel run --token secret-do-not-emit",
      "13 caddy run --config /home/test/.scout/local-edge/Caddyfile",
      "14 ssh -N -R 43120:localhost:43120 host",
    ].join("\n") }));
    for (const id of ["iroh", "mesh-mcp-bridge", "cloudflare-tunnel", "local-edge-web-proxy", "other-proxy-processes"]) expect(item(report, id).status).toBe("active");
    expect(report.enforced).toBe(false);
    expect(JSON.stringify(report)).not.toContain("secret-do-not-emit");
    expect(JSON.stringify(report)).not.toContain("--token");
  });
  test("real configuration sources are recorded without treating disable or safe env switches as proof", async () => {
    const report = await inspectMeshAccessIngressPosture({ ...options, env: {
      OPENSCOUT_IROH_BRIDGE_BIN: "/secret/path", OPENSCOUT_IROH_BRIDGE_AUTO_START: "false",
      OPENSCOUT_BASE_EDGE_ENABLED: "0", OPENSCOUT_BASE_MESH_BRIDGE_ENABLED: "0", OPENSCOUT_SCOPED_INGRESS_SAFE: "1",
    }, entrypoints: [{ kind: "cloudflare_tunnel" }] }, probe({ files: {
      "/state/scout/mcp-bridge.json": '{"enabled":false,"token":"secret-do-not-emit"}',
      "/state/scout/runtime/mesh-bridge.json": '{"pid":999,"state":"running"}',
      "/home/test/.scout/local-edge/Caddyfile": "private config",
    } }));
    for (const id of ["iroh", "mesh-mcp-bridge", "cloudflare-tunnel", "local-edge-web-proxy"]) expect(item(report, id).status).toBe("configured");
    expect(report.enforced).toBe(false);
    expect(JSON.stringify(report)).not.toContain("secret-do-not-emit");
    expect(JSON.stringify(report)).not.toContain("/secret/path");
  });
  test("tailscale serve/funnel JSON is inspected and missing or invalid evidence stays unknown", async () => {
    const active = await inspectMeshAccessIngressPosture(options, probe({ tailscale: '{"Web":{"host:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:43120"}}}}}' }));
    expect(item(active, "tailscale-serve-funnel").status).toBe("active");
    expect(item(active, "tailscale-serve-funnel").reason).toContain("are refused");
    expect(item(active, "tailscale-serve-funnel").reason).toContain("TCP forwarding");
    expect(active.activation).toBe("blocked");
    const invalid = await inspectMeshAccessIngressPosture(options, probe({ tailscale: "not-json" }));
    expect(item(invalid, "tailscale-serve-funnel").status).toBe("unknown");
    const unreadable = await inspectMeshAccessIngressPosture(options, probe({ fail: true }));
    expect(unreadable.relays.every((relay) => relay.status === "unknown")).toBe(true);
    expect(unreadable.enforced).toBe(false);
  });
  test("only bounded read-only command names are requested and thrown probes fail closed", async () => {
    const commands: string[] = [];
    const injected: MeshAccessIngressProbe = {
      command: async (file, args) => { commands.push([file, ...args].join(" ")); throw new Error("secret-do-not-emit"); },
      file: async () => { throw new Error("secret-do-not-emit"); },
    };
    const report = await inspectMeshAccessIngressPosture(options, injected);
    expect(commands.sort()).toEqual(["ps -axo pid=,args=", "tailscale funnel status --json", "tailscale serve status --json"]);
    expect(report.enforced).toBe(false);
    expect(JSON.stringify(report)).not.toContain("secret-do-not-emit");
  });
  test("a protected active relay retains its observation without receiving an authentication exemption", async () => {
    const report = await inspectMeshAccessIngressPosture({ ...options, protectedLocalIngress: true }, probe({ processes: "11 cloudflared tunnel run" }));
    expect(item(report, "cloudflare-tunnel").status).toBe("broker-auth-required");
    expect(item(report, "cloudflare-tunnel").observedStatus).toBe("active");
    expect(item(report, "cloudflare-tunnel").proof).toContain("process:pid:11");
  });
});
