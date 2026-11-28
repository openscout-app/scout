import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOCAL_CONFIG_VERSION,
  loadLocalConfig,
  normalizeLocalHostname,
  normalizeLocalHostnameLabel,
  resolveBrokerControlUrl,
  resolveConfiguredScoutWebHostname,
  resolveEffectiveLocalConfig,
  resolveScoutWebDevHostname,
  resolveScoutWebMdnsHostname,
  resolveScoutWebNamedHostname,
  resolveScoutWebVirtualHostname,
  writeLocalConfig,
} from "./local-config.ts";

const originalHome = process.env.HOME;
const originalOpenScoutHome = process.env.OPENSCOUT_HOME;
const originalBrokerPort = process.env.OPENSCOUT_BROKER_PORT;
const originalBrokerInternalUrl = process.env.OPENSCOUT_BROKER_INTERNAL_URL;
const tempHomes = new Set<string>();

afterEach(() => {
  process.env.HOME = originalHome;
  if (originalOpenScoutHome === undefined) {
    delete process.env.OPENSCOUT_HOME;
  } else {
    process.env.OPENSCOUT_HOME = originalOpenScoutHome;
  }
  if (originalBrokerPort === undefined) {
    delete process.env.OPENSCOUT_BROKER_PORT;
  } else {
    process.env.OPENSCOUT_BROKER_PORT = originalBrokerPort;
  }
  if (originalBrokerInternalUrl === undefined) {
    delete process.env.OPENSCOUT_BROKER_INTERNAL_URL;
  } else {
    process.env.OPENSCOUT_BROKER_INTERNAL_URL = originalBrokerInternalUrl;
  }
  for (const home of tempHomes) {
    rmSync(home, { recursive: true, force: true });
  }
  tempHomes.clear();
});

function useIsolatedConfigHome(): string {
  const home = mkdtempSync(join(tmpdir(), "openscout-local-config-"));
  tempHomes.add(home);
  process.env.HOME = home;
  process.env.OPENSCOUT_HOME = join(home, ".openscout");
  return home;
}

describe("broker control config", () => {
  test("builds the control URL from ~/.openscout/config.json", () => {
    useIsolatedConfigHome();
    writeLocalConfig({
      version: LOCAL_CONFIG_VERSION,
      host: "127.0.0.1",
      ports: { broker: 43110 },
    });

    expect(resolveBrokerControlUrl()).toBe("http://127.0.0.1:43110");
  });

  test("lets process env overlay config ports", () => {
    useIsolatedConfigHome();
    writeLocalConfig({
      version: LOCAL_CONFIG_VERSION,
      host: "127.0.0.1",
      ports: { broker: 43110 },
    });
    process.env.OPENSCOUT_BROKER_PORT = "65535";

    expect(resolveEffectiveLocalConfig().ports?.broker).toBe(65535);
    expect(resolveBrokerControlUrl()).toBe("http://127.0.0.1:65535");
  });

  test("still accepts ephemeral internal URL injection from a parent broker child", () => {
    useIsolatedConfigHome();
    writeLocalConfig({
      version: LOCAL_CONFIG_VERSION,
      host: "127.0.0.1",
      ports: { broker: 43110 },
    });
    process.env.OPENSCOUT_BROKER_INTERNAL_URL = "http://127.0.0.1:4321";

    expect(resolveBrokerControlUrl()).toBe("http://127.0.0.1:4321");
  });

  test("reads config.json from ~/.openscout first and falls back to legacy ~/.scout", () => {
    const home = mkdtempSync(join(tmpdir(), "openscout-dual-local-config-"));
    tempHomes.add(home);
    process.env.HOME = home;
    delete process.env.OPENSCOUT_HOME;

    mkdirSync(join(home, ".scout"), { recursive: true });
    writeFileSync(join(home, ".scout", "config.json"), JSON.stringify({ version: 1, ports: { broker: 44110 } }));
    expect(loadLocalConfig().ports?.broker).toBe(44110);

    mkdirSync(join(home, ".openscout"), { recursive: true });
    writeFileSync(join(home, ".openscout", "config.json"), JSON.stringify({ version: 1, ports: { broker: 45110 } }));
    expect(loadLocalConfig().ports?.broker).toBe(45110);
  });
});

describe("local web hostnames", () => {
  test("derives the machine mDNS hostname from the machine hostname", () => {
    expect(resolveScoutWebMdnsHostname("hudson-mini")).toBe("hudson-mini.local");
    expect(resolveScoutWebMdnsHostname("Hudson-Mini.local")).toBe("hudson-mini.local");
  });

  test("derives the Scout virtual host for an edge proxy", () => {
    expect(resolveScoutWebVirtualHostname("hudson-mini")).toBe("hudson-mini.scout.local");
    expect(resolveScoutWebVirtualHostname("Hudson-Mini.local")).toBe("hudson-mini.scout.local");
  });

  test("derives the dev edge hostname from the portal host", () => {
    expect(resolveScoutWebDevHostname("scout.local")).toBe("dev.scout.local");
    expect(resolveScoutWebDevHostname("dev.scout.local")).toBe("dev.scout.local");
  });

  test("derives user-defined Scout names", () => {
    expect(resolveScoutWebNamedHostname("m1")).toBe("m1.scout.local");
    expect(resolveScoutWebNamedHostname("m1.local")).toBe("m1.local");
    expect(resolveScoutWebNamedHostname("scout.m1.local")).toBe("scout.m1.local");
    expect(resolveScoutWebNamedHostname("m1.scout.local")).toBe("m1.scout.local");
    expect(resolveScoutWebNamedHostname("Scout Local")).toBe("scout-local.scout.local");
  });

  test("prefers the configured web local name", () => {
    expect(resolveConfiguredScoutWebHostname({ version: 1, webLocalName: "m1" })).toBe("m1.scout.local");
    expect(resolveConfiguredScoutWebHostname({ version: 1, webLocalName: "m1.scout.local" })).toBe("m1.scout.local");
  });

  test("defaults the Scout node host from the machine hostname", () => {
    expect(resolveConfiguredScoutWebHostname({ version: 1 }, "Workstation-Mini.local")).toBe(
      "workstation-mini.scout.local",
    );
  });

  test("normalizes hostnames into DNS labels", () => {
    expect(normalizeLocalHostnameLabel("Art's MacBook Pro.local")).toBe("art-s-macbook-pro");
    expect(normalizeLocalHostnameLabel("mini.office.example")).toBe("mini");
    expect(normalizeLocalHostnameLabel("")).toBe("localhost");
    expect(normalizeLocalHostname("Scout M1.local")).toBe("scout-m1.local");
    expect(normalizeLocalHostname("Scout.M1.local")).toBe("scout.m1.local");
  });

});
