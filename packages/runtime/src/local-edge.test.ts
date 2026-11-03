import { describe, expect, test } from "bun:test";

import {
  buildOpenScoutLocalEdgeMdnsCommands,
  renderOpenScoutCaddyfile,
  resolveOpenScoutLocalEdgeConfig,
  resolveOpenScoutLocalEdgeDiscoveryHosts,
  resolveOpenScoutLocalEdgeAdvertisements,
  createLocalEdgeAdvertisementOwner,
  shouldStartOpenScoutLocalEdge,
} from "./local-edge.ts";

describe("OpenScout local edge", () => {
  test("named instances cannot claim the shared edge even when explicitly enabled", () => {
    for (const enabled of [undefined, "0", "1"]) {
      expect(shouldStartOpenScoutLocalEdge({ isProd: false, platform: "darwin", enabled })).toBe(false);
    }
    expect(shouldStartOpenScoutLocalEdge({ isProd: true, platform: "darwin" })).toBe(true);
    expect(shouldStartOpenScoutLocalEdge({ isProd: true, platform: "darwin", enabled: "0" })).toBe(false);
    expect(shouldStartOpenScoutLocalEdge({ isProd: true, platform: "linux" })).toBe(false);
  });
  test("repeated address changes replace only owned advertisements and shutdown releases them", () => {
    let serial = 0;
    const active = new Set<number>();
    const owner = createLocalEdgeAdvertisementOwner({
      start: () => { const id = ++serial; active.add(id); return id; },
      stop: (id: number) => { expect(active.delete(id)).toBe(true); },
    });
    const first = [{ host: "air.scout.local", address: "192.168.18.11" }];
    owner.update(first, ["http", "https"]);
    expect(active.size).toBe(2);
    owner.update(first, ["http", "https"]);
    expect(serial).toBe(2);
    for (let i = 2; i < 8; i++) {
      owner.update([{ host: "air.scout.local", address: `192.168.18.${i}` }], ["http", "https"]);
      expect(active.size).toBe(2);
    }
    owner.update([], ["http", "https"]);
    expect(active.size).toBe(0);
    owner.update(first, ["http", "https"]);
    owner.stop();
    expect(active.size).toBe(0);
  });
  test("LAN-only advertises the owner's physical address and withdraws it offline", () => {
    const config = { portalHost: "scout.local", nodeHost: "air.scout.local", lanOnly: true };
    const networks = [{ name: "en0", address: "192.168.18.11", cidr: "192.168.18.11/24", netmask: "255.255.255.0", family: "IPv4" as const }];
    expect(resolveOpenScoutLocalEdgeAdvertisements(config, networks)).toEqual([
      { host: "scout.local", address: "127.0.0.1" },
      { host: "air.scout.local", address: "192.168.18.11" },
      { host: "chat.scout.local", address: "127.0.0.1" },
    ]);
    expect(resolveOpenScoutLocalEdgeAdvertisements(config, [])).toEqual([
      { host: "scout.local", address: "127.0.0.1" },
      { host: "chat.scout.local", address: "127.0.0.1" },
    ]);
    const moved = [{ ...networks[0]!, address: "10.1.0.2", cidr: "10.1.0.2/24" }];
    expect(resolveOpenScoutLocalEdgeAdvertisements(config, moved)[1]?.address).toBe("10.1.0.2");
    const selfAssigned = { ...networks[0]!, address: "169.254.1.2", cidr: "169.254.1.2/16" };
    expect(resolveOpenScoutLocalEdgeAdvertisements(config, [selfAssigned, ...moved])[1]?.address).toBe("10.1.0.2");
  });

  test("LAN-only node HTTP redirects to its own HTTPS preserving the request URI", () => {
    const config = resolveOpenScoutLocalEdgeConfig({ nodeHost: "air.scout.local", lanOnly: true, scheme: "both" });
    const output = renderOpenScoutCaddyfile(config);
    expect(output).toContain("http://air.scout.local {\n  redir https://air.scout.local{uri} 308\n}");
    expect(output).toContain("\nair.scout.local {\n  tls internal");
    expect(output).toContain("http://scout.local {");
  });
  test("advertises the chat doorway explicitly because mDNS has no wildcard", () => {
    expect(resolveOpenScoutLocalEdgeDiscoveryHosts({
      portalHost: "scout.local", nodeHost: "m1.scout.local",
    })).toEqual(["scout.local", "m1.scout.local", "chat.scout.local"]);
  });

  test("uses the configured portal domain and advertises each name once", () => {
    expect(resolveOpenScoutLocalEdgeDiscoveryHosts({
      portalHost: " TEAM.LOCAL. ", nodeHost: "chat.team.local",
    })).toEqual(["team.local", "chat.team.local"]);
  });

  test("advertises through dns-sd on macOS and Avahi on Linux", () => {
    const input = { name: "Scout Local HTTP", host: "scout.local", port: 80, scheme: "http" as const };
    expect(buildOpenScoutLocalEdgeMdnsCommands(input, "darwin")).toEqual([{
      command: "/usr/bin/dns-sd",
      args: ["-P", "Scout Local HTTP", "_http._tcp", "local", "80", "scout.local", "127.0.0.1", "path=/"],
    }]);
    expect(buildOpenScoutLocalEdgeMdnsCommands(input, "linux")).toEqual([
      { command: "avahi-publish", args: ["-a", "-R", "scout.local", "127.0.0.1"] },
      { command: "avahi-publish", args: ["-a", "-R", "scout.local", "::1"] },
      { command: "avahi-publish", args: ["-s", "-H", "scout.local", "Scout Local HTTP", "_http._tcp", "80", "path=/"] },
    ]);
    expect(buildOpenScoutLocalEdgeMdnsCommands(input, "win32")).toEqual([]);
  });

  test("preserves optional operator-owned site imports outside generated routes", () => {
    const output = renderOpenScoutCaddyfile(resolveOpenScoutLocalEdgeConfig({}), "/path with spaces/sites/*.caddy");
    expect(output).toEndWith('\nimport "/path with spaces/sites/*.caddy"\n');
    expect(output).toContain("http://scout.local {");
  });
  test("registers scout.local and the node host", () => {
    expect(
      resolveOpenScoutLocalEdgeConfig({
        nodeHost: "m1.scout.local",
        brokerPort: 43110,
        webPort: 43120,
      }),
    ).toEqual({
      portalHost: "scout.local",
      nodeHost: "m1.scout.local",
      wildcardHost: "*.scout.local",
      scheme: "http",
      brokerUpstream: "127.0.0.1:43110",
      routes: [
        { host: "scout.local", upstream: "127.0.0.1:43120" },
        { host: "*.scout.local", upstream: "127.0.0.1:43120" },
      ],
    });
  });

  test("renders a Caddyfile for the local portal", () => {
    const caddyfile = renderOpenScoutCaddyfile(
      resolveOpenScoutLocalEdgeConfig({
        nodeHost: "m1.scout.local",
        brokerPort: 43110,
        webPort: 43120,
      }),
    );

    expect(caddyfile).toStartWith("{\n  log {\n    level WARN\n  }\n}\n");
    expect(caddyfile).toContain("http://*.scout.local {");
    expect(caddyfile).toContain("reverse_proxy 127.0.0.1:43120 {");
    expect(caddyfile).not.toContain("tls internal");
    expect(caddyfile).toContain("Start Scout");
    expect(caddyfile).toContain("Bring Scout online.");
    expect(caddyfile).toContain('localStorage.getItem("openscout.theme")');
    expect(caddyfile).toContain(':root[data-scout-theme="light"]');
    expect(caddyfile).toContain('class="orb"');
    expect(caddyfile).toContain('class="orb-l" data-t="4"');
    expect(caddyfile).toContain("reverse_proxy 127.0.0.1:43110");
    expect(caddyfile).toContain("new URL(config.startPath, window.location.origin)");
    expect(caddyfile).toContain("path /__openscout/web/start\n    remote_ip 127.0.0.1 ::1");
    expect(caddyfile).toContain("handle /__openscout/web/start {\n    respond \"Forbidden\" 403");
    expect(caddyfile).toContain("path /__openscout/web/status\n    remote_ip 127.0.0.1 ::1");
    expect(caddyfile).toContain("handle /__openscout/web/status {\n    respond \"Forbidden\" 403");
  });

  test("only loopback control bridges suppress Caddy's automatic forwarding headers", () => {
    for (const scheme of ["http", "https", "both"] as const) {
      const caddyfile = renderOpenScoutCaddyfile(resolveOpenScoutLocalEdgeConfig({ scheme }));
      const controlBlocks = [...caddyfile.matchAll(/handle @openscout_web_(?:start|status)_local \{[\s\S]*?\n  \}/g)];
      expect(controlBlocks.length).toBeGreaterThan(0);
      for (const [block] of controlBlocks) {
        expect(block).toContain("header_up -X-Forwarded-For");
        expect(block).toContain("header_up -X-Forwarded-Host");
        expect(block).toContain("header_up -X-Forwarded-Proto");
        expect(block).toContain("header_up -Via");
        expect(block).toContain("header_up X-Openscout-Web-Host {host}");
        expect(block).toContain("header_up X-Openscout-Web-Proto {scheme}");
      }
      expect(caddyfile.match(/header_up -X-Forwarded-For/g)).toHaveLength(controlBlocks.length);
      for (const field of ["For", "Host", "Proto"]) {
        expect(caddyfile.match(new RegExp(`header !X-Forwarded-${field}`, "g"))).toHaveLength(controlBlocks.length);
      }
      expect(caddyfile.match(/header !Via/g)).toHaveLength(controlBlocks.length);
      expect(caddyfile).not.toContain("header_up -Forwarded");
      expect(caddyfile).not.toContain("header_up -Tailscale-");
      expect(caddyfile).toContain('handle /__openscout/web/start {\n    respond "Forbidden" 403');
      expect(caddyfile).toContain('handle /__openscout/web/status {\n    respond "Forbidden" 403');
    }
  });

  test("registers additional tailnet hosts as edge routes", () => {
    const config = resolveOpenScoutLocalEdgeConfig({
      nodeHost: "m1.scout.local",
      brokerPort: 43110,
      webPort: 43120,
      extraHosts: ["m1.tailnet.ts.net.", "100.64.0.10", "m1.tailnet.ts.net"],
    });

    expect(config.routes).toEqual([
      { host: "scout.local", upstream: "127.0.0.1:43120" },
      { host: "*.scout.local", upstream: "127.0.0.1:43120" },
      { host: "m1.tailnet.ts.net", upstream: "127.0.0.1:43120" },
      { host: "100.64.0.10", upstream: "127.0.0.1:43120" },
    ]);

    const caddyfile = renderOpenScoutCaddyfile(config);
    expect(caddyfile).toContain("http://m1.tailnet.ts.net {");
    expect(caddyfile).toContain("http://100.64.0.10 {");
  });

  test("renders HTTPS blocks only when requested", () => {
    const caddyfile = renderOpenScoutCaddyfile(
      resolveOpenScoutLocalEdgeConfig({
        nodeHost: "m1.scout.local",
        brokerPort: 43110,
        scheme: "both",
        webPort: 43120,
      }),
    );

    expect(caddyfile).toContain("http://*.scout.local {");
    expect(caddyfile).toContain("*.scout.local {\n  tls internal");
    expect(caddyfile).toContain("skip_install_trust");
  });

  test("registers a dev.scout.local route to Vite when a vite upstream is configured", () => {
    const caddyfile = renderOpenScoutCaddyfile(
      resolveOpenScoutLocalEdgeConfig({
        nodeHost: "m1.scout.local",
        brokerPort: 43110,
        webPort: 43120,
        vitePort: 43122,
        viteHmrPath: "/ws/hmr",
      }),
    );

    expect(caddyfile).not.toContain("handle /ws/hmr* {");
    expect(caddyfile).toContain("reverse_proxy 127.0.0.1:43120 {");
    expect(caddyfile).toContain("http://dev.scout.local {");
    expect(caddyfile).toContain("http://dev.scout.local {\n  handle {\n    reverse_proxy 127.0.0.1:43122");
  });

  test("keeps /ws/hmr on the Bun upstream in production edge mode", () => {
    const caddyfile = renderOpenScoutCaddyfile(
      resolveOpenScoutLocalEdgeConfig({
        nodeHost: "m1.scout.local",
        brokerPort: 43110,
        webPort: 43120,
      }),
    );

    expect(caddyfile).not.toContain("handle /ws/hmr*");
    expect(caddyfile).not.toContain("reverse_proxy 127.0.0.1:43122");
    expect(caddyfile).toContain("reverse_proxy 127.0.0.1:43120 {");
  });

  test("renders an HTTP Caddyfile for browser stores that do not trust local TLS yet", () => {
    expect(
      renderOpenScoutCaddyfile(
        resolveOpenScoutLocalEdgeConfig({
          nodeHost: "m1.scout.local",
          brokerPort: 43110,
          scheme: "http",
          webPort: 4311,
        }),
      ),
    ).toContain("http://*.scout.local {");
    expect(
      renderOpenScoutCaddyfile(
        resolveOpenScoutLocalEdgeConfig({
          nodeHost: "m1.scout.local",
          brokerPort: 43110,
          scheme: "http",
          webPort: 4311,
        }),
      ),
    ).toContain("reverse_proxy 127.0.0.1:4311 {");
  });
});


test("LAN mDNS preserves platform support without advertising remote loopback IPv6", () => {
  const input = { name: "Scout LAN", host: "node.scout.local", address: "192.168.50.20", port: 443, scheme: "https" as const };
  const linux = buildOpenScoutLocalEdgeMdnsCommands(input, "linux");
  expect(linux).toHaveLength(2);
  expect(linux[0]?.args).toEqual(["-a", "-R", "node.scout.local", "192.168.50.20"]);
  expect(linux.flatMap(c => c.args)).not.toContain("::1");
  expect(buildOpenScoutLocalEdgeMdnsCommands(input, "darwin")[0]?.args).toContain("192.168.50.20");
});

test("advertisement ownership withdraws every Linux publisher when the LAN disappears", () => {
  const stopped: string[] = [];
  const owner = createLocalEdgeAdvertisementOwner({
    start: (ad, scheme) => buildOpenScoutLocalEdgeMdnsCommands({ ...ad, name: ad.host, port: 443, scheme }, "linux").map(c => c.args.join(" ")),
    stop: children => stopped.push(...children),
  });
  const ads = [{ host: "node.scout.local", address: "192.168.50.20" }];
  owner.update(ads, ["https"]);
  owner.update(ads, ["https"]);
  expect(stopped).toEqual([]);
  owner.update([], ["https"]);
  expect(stopped).toHaveLength(2);
  owner.stop();
  expect(stopped).toHaveLength(2);
});
