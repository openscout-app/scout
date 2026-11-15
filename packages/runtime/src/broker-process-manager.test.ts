import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { isolateOpenScoutUserDataForTests } from "./test-user-data-isolation.ts";

isolateOpenScoutUserDataForTests();

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { LOCAL_CONFIG_VERSION, writeLocalConfig } from "./local-config.ts";
import { CONTROL_PLANE_SCHEMA_VERSION } from "./schema-version.ts";

import {
  isBrokerServiceEntrypoint,
  buildDefaultBrokerUrl,
  buildLocalBrokerControlUrl,
  DEFAULT_BROKER_HOST,
  DEFAULT_BROKER_HOST_MESH,
  DEFAULT_BROKER_PORT,
  DEFAULT_BROKER_URL,
  resolveBundledRuntimeDirFromModuleDir,
  persistentBrokerServiceConfig,
  resolveBrokerServiceConfig,
  resolveBrokerHost,
  resolveBrokerUrl,
  resolveBrokerSocketPathForBaseUrl,
  resolveScoutBrokerControlUrl,
  resolveAdvertiseScope,
  findLanIPv4Address,
  findTailscaleIPv4Address,
  resolveScoutdCommand,
  runScoutdServiceCommand,
  selectLastRelevantLogLine,
  type BrokerServiceConfig,
} from "./broker-process-manager";

const config: BrokerServiceConfig = {
  label: "app.openscout",
  mode: "dev",
  uid: 501,
  domainTarget: "gui/501",
  serviceTarget: "gui/501/app.openscout",
  launchAgentPath: "/Users/guest/Library/LaunchAgents/app.openscout.plist",
  supportDirectory: "/Users/guest/Library/Application Support/OpenScout",
  runtimeDirectory: "/Users/guest/Library/Application Support/OpenScout/runtime",
  logsDirectory: "/Users/guest/Library/Application Support/OpenScout/logs/broker",
  stdoutLogPath: "/Users/guest/Library/Application Support/OpenScout/logs/broker/stdout.log",
  stderrLogPath: "/Users/guest/Library/Application Support/OpenScout/logs/broker/stderr.log",
  controlHome: "/Users/guest/.openscout/control-plane",
  runtimePackageDir: "/Users/guest/dev/openscout/packages/runtime",
  bunExecutable: "/Users/guest/.bun/bin/bun",
  brokerHost: DEFAULT_BROKER_HOST,
  brokerPort: DEFAULT_BROKER_PORT,
  brokerUrl: DEFAULT_BROKER_URL,
  brokerSocketPath: "/Users/guest/Library/Application Support/OpenScout/runtime/broker.sock",
  advertiseScope: "local",
  coreAgents: [],
};

function writeExecutable(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(path, 0o755);
  return path;
}

function writeExecutableScript(path: string, script: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, script, "utf8");
  chmodSync(path, 0o755);
  return path;
}

let envQueue: Promise<unknown> = Promise.resolve();

async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(patch)) {
      previous.set(key, process.env[key]);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    try {
      return await fn();
    } finally {
      restore(previous);
    }
  };

  const next = envQueue.then(run, run);
  envQueue = next.catch(() => undefined);
  return await next;
}

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { configurable: true, enumerable: true, value: platform });
  const restorePlatform = () => {
    if (previous) Object.defineProperty(process, "platform", previous);
  };
  try {
    const result = run();
    if (result instanceof Promise) return result.finally(restorePlatform) as T;
    restorePlatform();
    return result;
  } catch (error) {
    restorePlatform();
    throw error;
  }
}

function restore(previous: Map<string, string | undefined>): void {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
}

describe("broker service scoutd adapter", () => {
  test("builds local broker control URLs from wildcard bind hosts", () => {
    expect(buildLocalBrokerControlUrl("0.0.0.0", 43110)).toBe("http://127.0.0.1:43110");
    expect(buildLocalBrokerControlUrl("::", 43110)).toBe("http://127.0.0.1:43110");
    expect(buildLocalBrokerControlUrl("192.168.1.12", 43110)).toBe("http://192.168.1.12:43110");
  });

  test("resolves the local broker socket for control and advertise URLs on this machine", () => {
    const previousHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "openscout-broker-socket-"));
    process.env.HOME = home;
    writeLocalConfig({
      version: LOCAL_CONFIG_VERSION,
      host: "127.0.0.1",
      ports: { broker: DEFAULT_BROKER_PORT },
    });

    try {
      const meshConfig: BrokerServiceConfig = {
        ...config,
        brokerHost: DEFAULT_BROKER_HOST_MESH,
        brokerPort: DEFAULT_BROKER_PORT,
        brokerUrl: "http://mini.tailnet.test:43110",
        advertiseScope: "mesh",
      };
      const controlUrl = resolveScoutBrokerControlUrl(meshConfig);

      expect(controlUrl).toBe("http://127.0.0.1:43110");
      expect(resolveBrokerSocketPathForBaseUrl(controlUrl, meshConfig))
        .toBe(meshConfig.brokerSocketPath);
      expect(resolveBrokerSocketPathForBaseUrl(meshConfig.brokerUrl, meshConfig))
        .toBe(meshConfig.brokerSocketPath);
      expect(resolveBrokerSocketPathForBaseUrl("http://peer.example.test:43110", meshConfig))
        .toBeNull();
    } finally {
      process.env.HOME = previousHome ?? homedir();
    }
  });

  test("uses OSN settings over stale local launch environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-osn-service-config-"));
    const tailscaleStatus = join(root, "tailscale-status.json");
    writeFileSync(tailscaleStatus, JSON.stringify({
      BackendState: "Running",
      Self: {
        ID: "node-1",
        HostName: "mini",
        DNSName: "mini.tailnet.test.",
        TailscaleIPs: ["100.64.0.10"],
        Online: true,
        OS: "macOS",
      },
      CurrentTailnet: {
        Name: "test",
        MagicDNSSuffix: "tailnet.test",
      },
    }));

    await withEnv({
      OPENSCOUT_NETWORK_DISCOVERY_ENABLED: "1",
      OPENSCOUT_ADVERTISE_SCOPE: "local",
      OPENSCOUT_BROKER_HOST: "127.0.0.1",
      OPENSCOUT_BROKER_URL: "http://127.0.0.1:65535",
      OPENSCOUT_TAILSCALE_STATUS_JSON: tailscaleStatus,
    }, () => {
      expect(resolveAdvertiseScope()).toBe("mesh");
      // P1.5: plaintext mesh default is loopback; non-loopback TLS is separate.
      expect(resolveBrokerHost("mesh")).toBe("127.0.0.1");
      expect(resolveBrokerUrl("127.0.0.1", 65535, "mesh", process.env, "192.168.18.22"))
        .toBe("https://192.168.18.22:65535");
      expect(resolveBrokerUrl("127.0.0.1", 65535, "mesh", process.env, null))
        .toBe("https://mini.tailnet.test:65535");
      const serviceConfig = resolveBrokerServiceConfig();
      expect(serviceConfig.advertiseScope).toBe("mesh");
      expect(serviceConfig.brokerHost).toBe("127.0.0.1");
      const lan = findLanIPv4Address();
      expect(serviceConfig.brokerUrl).toBe(
        lan
          ? `https://${lan}:${DEFAULT_BROKER_PORT}`
          : `https://mini.tailnet.test:${DEFAULT_BROKER_PORT}`,
      );
    });

    await withEnv({
      OPENSCOUT_NETWORK_DISCOVERY_ENABLED: "1",
      OPENSCOUT_BROKER_URL: "http://0.0.0.0:65535",
      OPENSCOUT_TAILSCALE_STATUS_JSON: tailscaleStatus,
    }, () => {
      expect(resolveBrokerUrl("127.0.0.1", 65535, "mesh", process.env, null))
        .toBe("https://mini.tailnet.test:65535");
      expect(resolveBrokerUrl("127.0.0.1", 65535, "mesh", process.env, "192.168.18.22"))
        .toBe("https://192.168.18.22:65535");
    });
  });

  test("announces the LAN address in mesh scope when Tailscale is absent", () => {
    const interfaces = {
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      en0: [
        { address: "192.168.18.22", family: "IPv4", internal: false },
        { address: "169.254.10.10", family: "IPv4", internal: false },
      ],
      en1: [{ address: "192.168.18.30", family: "IPv4", internal: false }],
      utun3: [{ address: "100.64.0.10", family: "IPv4", internal: false }],
      bridge0: [{ address: "192.168.64.1", family: "IPv4", internal: false }],
    } as never;

    expect(findLanIPv4Address(interfaces)).toBe("192.168.18.22");
    expect(findLanIPv4Address({})).toBeNull();
    expect(findTailscaleIPv4Address(interfaces)).toBe("100.64.0.10");
    expect(findTailscaleIPv4Address({})).toBeNull();
    // Without a LAN host, mesh falls back to the plaintext loopback control URL.
    expect(resolveBrokerUrl("127.0.0.1", 43110, "mesh", {}, null))
      .toBe("http://127.0.0.1:43110");
    expect(resolveBrokerUrl("127.0.0.1", 43110, "mesh", {}, "192.168.18.22"))
      .toBe("https://192.168.18.22:43110");
    expect(resolveBrokerUrl("127.0.0.1", 43110, "local", {}, "192.168.18.22"))
      .toBe("http://127.0.0.1:43110");
  });

  test("P1.5: mesh host no longer upgrades to 0.0.0.0 wildcard", () => {
    expect(resolveBrokerHost("mesh", {})).toBe("127.0.0.1");
    expect(resolveBrokerHost("mesh", { OPENSCOUT_BROKER_HOST: "0.0.0.0" })).toBe("127.0.0.1");
    expect(resolveBrokerHost("mesh", { OPENSCOUT_BROKER_HOST: "127.0.0.1" })).toBe("127.0.0.1");
    expect(DEFAULT_BROKER_HOST_MESH).toBe("0.0.0.0"); // retained for legacy comparisons
  });

  test("resolves the package root from a bundled scout dist runtime module", () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-runtime-package-"));
    const packageRoot = join(root, "scout");
    const moduleDir = join(packageRoot, "dist", "runtime");

    mkdirSync(join(packageRoot, "bin"), { recursive: true });
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), "{}");
    writeFileSync(join(packageRoot, "bin", "openscout-runtime.mjs"), "");

    expect(resolveBundledRuntimeDirFromModuleDir(moduleDir)).toBe(packageRoot);
  });

  test("keeps a source workspace service owned by packages/runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-source-runtime-package-"));
    const cliRoot = join(root, "packages", "cli");
    const runtimeRoot = join(root, "packages", "runtime");
    const moduleDir = join(cliRoot, "dist");

    mkdirSync(join(cliRoot, "bin"), { recursive: true });
    mkdirSync(moduleDir, { recursive: true });
    mkdirSync(join(runtimeRoot, "bin"), { recursive: true });
    mkdirSync(join(runtimeRoot, "src"), { recursive: true });
    writeFileSync(join(cliRoot, "package.json"), JSON.stringify({ name: "@openscout/scout" }));
    writeFileSync(join(cliRoot, "bin", "openscout-runtime.mjs"), "");
    writeFileSync(join(runtimeRoot, "package.json"), JSON.stringify({ name: "@openscout/runtime" }));
    writeFileSync(join(runtimeRoot, "bin", "openscout-runtime.mjs"), "");

    expect(resolveBundledRuntimeDirFromModuleDir(moduleDir)).toBe(runtimeRoot);
  });

  test("resolves packaged scoutd from the bundled package bin directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-packaged-scoutd-"));
    const packageRoot = join(root, "scout");
    const scoutd = writeExecutable(join(packageRoot, "bin", "scoutd"));
    writeExecutable(join(root, "path", "scoutd"));

    const packagedConfig: BrokerServiceConfig = {
      ...config,
      runtimePackageDir: packageRoot,
    };

    const resolved = await withPlatform("darwin", () => withEnv({
      OPENSCOUT_SCOUTD_BIN: undefined,
      PATH: join(root, "path"),
    }, () => resolveScoutdCommand(packagedConfig)));

    expect(resolved).toEqual({ path: scoutd, source: "package" });
  });

  test("resolves packaged scoutd from the monorepo CLI package before workspace builds", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-monorepo-scoutd-"));
    mkdirSync(join(root, "crates", "scoutd"), { recursive: true });
    writeFileSync(join(root, "Cargo.toml"), "[workspace]\n");
    writeFileSync(join(root, "crates", "scoutd", "Cargo.toml"), "[package]\nname = \"scoutd\"\n");
    const scoutd = writeExecutable(join(root, "packages", "cli", "bin", "scoutd"));
    writeExecutable(join(root, "target", "debug", "scoutd"));
    writeExecutable(join(root, "path", "scoutd"));
    const workspaceConfig: BrokerServiceConfig = {
      ...config,
      runtimePackageDir: join(root, "packages", "runtime"),
    };

    const resolved = await withPlatform("darwin", () => withEnv({
      OPENSCOUT_SCOUTD_BIN: undefined,
      OPENSCOUT_ALLOW_WORKSPACE_SCOUTD: undefined,
      PATH: join(root, "path"),
    }, () => resolveScoutdCommand(workspaceConfig)));

    expect(resolved).toEqual({ path: scoutd, source: "package" });
  });

  test("resolves scoutd from an explicit environment override", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-scoutd-env-"));
    const scoutd = writeExecutable(join(root, "custom-scoutd"));

    const resolved = await withPlatform("darwin", () => withEnv({
      OPENSCOUT_SCOUTD_BIN: scoutd,
      PATH: "",
    }, () => resolveScoutdCommand(config)));

    expect(resolved).toEqual({ path: scoutd, source: "env" });
  });

  test("does not resolve workspace-built scoutd without an explicit opt-in", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-scoutd-workspace-"));
    mkdirSync(join(root, "crates", "scoutd"), { recursive: true });
    writeFileSync(join(root, "Cargo.toml"), "[workspace]\n");
    writeFileSync(join(root, "crates", "scoutd", "Cargo.toml"), "[package]\nname = \"scoutd\"\n");
    writeExecutable(join(root, "target", "debug", "scoutd"));
    const scoutd = writeExecutable(join(root, "bin", "scoutd"));
    const workspaceConfig: BrokerServiceConfig = {
      ...config,
      runtimePackageDir: join(root, "packages", "runtime"),
    };

    const resolved = await withPlatform("darwin", () => withEnv({
      OPENSCOUT_SCOUTD_BIN: undefined,
      OPENSCOUT_ALLOW_WORKSPACE_SCOUTD: undefined,
      PATH: join(root, "bin"),
    }, () => resolveScoutdCommand(workspaceConfig)));

    expect(resolved).toEqual({ path: scoutd, source: "path" });
  });

  test("resolves a workspace-built scoutd binary after opt-in", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-scoutd-workspace-opt-in-"));
    mkdirSync(join(root, "crates", "scoutd"), { recursive: true });
    writeFileSync(join(root, "Cargo.toml"), "[workspace]\n");
    writeFileSync(join(root, "crates", "scoutd", "Cargo.toml"), "[package]\nname = \"scoutd\"\n");
    const debugScoutd = writeExecutable(join(root, "target", "debug", "scoutd"));
    const releaseScoutd = writeExecutable(join(root, "target", "release", "scoutd"));
    const workspaceConfig: BrokerServiceConfig = {
      ...config,
      runtimePackageDir: join(root, "packages", "runtime"),
    };

    const resolved = await withPlatform("darwin", () => withEnv({
      OPENSCOUT_SCOUTD_BIN: undefined,
      OPENSCOUT_ALLOW_WORKSPACE_SCOUTD: "1",
      PATH: "",
    }, () => resolveScoutdCommand(workspaceConfig)));

    expect(debugScoutd).toContain("target/debug/scoutd");
    expect(resolved).toEqual({ path: releaseScoutd, source: "workspace" });
  });

  test("prefers informative runtime log lines over package script banners", () => {
    expect(
      selectLastRelevantLogLine([
        "$ bun run src/broker-daemon.ts",
        `[openscout-runtime] broker listening on ${DEFAULT_BROKER_URL}`,
      ]),
    ).toBe(`[openscout-runtime] broker listening on ${DEFAULT_BROKER_URL}`);

    expect(
      selectLastRelevantLogLine([
        "$ npm run broker",
      ]),
    ).toBe("$ npm run broker");

    expect(
      selectLastRelevantLogLine([
        "$ bun run src/broker-daemon.ts",
      ]),
    ).toBe("$ bun run src/broker-daemon.ts");
  });
});

describe("runScoutdServiceCommand shell-out", () => {
  let previousPlatform: PropertyDescriptor | undefined;
  beforeEach(() => {
    previousPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { configurable: true, enumerable: true, value: "darwin" });
  });
  afterEach(() => {
    if (previousPlatform) Object.defineProperty(process, "platform", previousPlatform);
  });

  test("preserves connected native health timeout provenance", async () => {
    const scoutd = writeExecutable(join(mkdtempSync(join(tmpdir(), "openscout-scoutd-timeout-")), "scoutd"));
    const result = await withEnv({ OPENSCOUT_SCOUTD_BIN: scoutd }, () =>
      runScoutdServiceCommand("status", config, 45_000, async () => JSON.stringify({
        health: { reachable: true, ok: false, state: "timed_out", checkedAt: 1700000000, durationMs: 1001 },
      })));
    expect(result.health).toMatchObject({ reachable: true, ok: false, state: "timed_out", checkedAt: 1700000000, durationMs: 1001 });
  });

  test("preserves journal failure from the native health response body", async () => {
    const scoutd = writeExecutable(join(mkdtempSync(join(tmpdir(), "openscout-scoutd-storage-")), "scoutd"));
    const storage = { journal: { state: "failing", since: 1, lastFailedAt: 2, failures: 3, code: "ENOSPC", error: "disk full" } };
    for (const fields of [{ body: JSON.stringify({ ok: true, storage }) }, { storage }]) {
      const result = await withEnv({ OPENSCOUT_SCOUTD_BIN: scoutd }, () =>
        runScoutdServiceCommand("status", config, 45_000, async () => JSON.stringify({
          health: { reachable: true, ok: true, ...fields },
        })));
      expect(result.health.storage).toEqual(storage);
      const { doctorBrokerCheck } = await import("../../cli/src/cli/doctor-checks.ts");
      expect(doctorBrokerCheck(result).state).toBe("impaired");
    }
    for (const body of ["not JSON", "null", JSON.stringify({ storage: { journal: { state: "failing" } } })]) {
      const result = await withEnv({ OPENSCOUT_SCOUTD_BIN: scoutd }, () =>
        runScoutdServiceCommand("status", config, 45_000, async () => JSON.stringify({ health: { reachable: true, ok: true, body } })));
      expect(result.health.storage).toBeUndefined();
    }
  });

  test("preserves cached web recovery from native health bodies without another probe", async () => {
    const scoutd = writeExecutable(join(mkdtempSync(join(tmpdir(), "openscout-scoutd-web-")), "scoutd"));
    const services = { web: { state: "running", managed: true, healthy: true, recovery: {
      state: "healthy", checkedAt: 10, lastHealthyAt: 10, consecutiveFailures: 0, automaticRestarts: 1, lastRecovery: null,
    } } };
    for (const fields of [{ body: JSON.stringify({ ok: true, services }) }, { services }]) {
      const result = await withEnv({ OPENSCOUT_SCOUTD_BIN: scoutd }, () =>
        runScoutdServiceCommand("status", config, 45_000, async () => JSON.stringify({
          health: { reachable: true, ok: true, ...fields },
        })));
      expect(result.health.services).toEqual(services);
    }
    for (const body of ["not JSON", "null", JSON.stringify({ services: [] })]) {
      const result = await withEnv({ OPENSCOUT_SCOUTD_BIN: scoutd }, () =>
        runScoutdServiceCommand("status", config, 45_000, async () => JSON.stringify({ health: { reachable: true, ok: true, body } })));
      expect(result.health.services).toBeUndefined();
    }
  });

  test("parses scoutd JSON into the normalized status shape", async () => {
    const status = {
      label: "app.openscout",
      mode: "dev",
      installed: true,
      loaded: true,
      pid: 4242,
      launchdState: "running",
      lastExitStatus: 0,
      health: {
        reachable: true,
        ok: true,
        checkedAt: 1700000000,
        transport: "unix_socket",
        nodeId: "node-1",
        meshId: "mesh-1",
        counts: {
          nodes: 1,
          actors: 2,
          agents: 3,
          conversations: 4,
          messages: 5,
          flights: 6,
          collaborationRecords: 7,
        },
        build: {
          packageName: "@openscout/runtime",
          version: "0.test",
          mode: "dev",
        },
        services: {
          web: {
            managed: true,
            managedBy: "broker",
            state: "running",
            pid: 111,
          },
        },
      },
      runtimeFreshness: {
        state: "pinned",
        intentional: true,
        basis: "explicit_pin",
        reasonCode: null,
        artifactCommit: "abc123",
        expectedCommit: "abc123",
        pin: "abc123",
        pinReason: "bisecting a regression",
        manifestPath: "/opt/openscout/dist/build-manifest.json",
        version: "0.test",
        actualBuiltAt: "2026-07-15T20:00:00.000Z",
        expectedBuiltAt: null,
        builtAt: "2026-07-15T20:00:00.000Z",
        sourceDirty: false,
        detail: "Running the explicitly pinned runtime build.",
      },
    };
    const scoutd = writeExecutable(join(mkdtempSync(join(tmpdir(), "openscout-scoutd-json-")), "scoutd"));
    const result = await withEnv({
      OPENSCOUT_SCOUTD_BIN: scoutd,
      // Unset, so the pin below is the code's default and not this test's env.
      OPENSCOUT_INSTANCE: undefined,
    }, () => runScoutdServiceCommand("status", config, 45_000, async (
      scoutdPath,
      command,
      env,
      timeoutMs,
    ) => {
      expect(scoutdPath).toBe(scoutd);
      expect(command).toBe("status");
      expect(env.OPENSCOUT_SCOUTD_BIN).toBe(scoutd);
      // scoutd (and the launchd plist it writes) always gets an explicit instance.
      expect(env.OPENSCOUT_INSTANCE).toBe("prod");
      expect(timeoutMs).toBe(45_000);
      return JSON.stringify(status);
    }));

    expect(result.label).toBe("app.openscout");
    expect(result.mode).toBe("dev");
    expect(result.installed).toBe(true);
    expect(result.loaded).toBe(true);
    expect(result.pid).toBe(4242);
    expect(result.launchdState).toBe("running");
    expect(result.lastExitStatus).toBe(0);
    expect(result.reachable).toBe(true);
    expect(result.health.ok).toBe(true);
    expect(result.health.reachable).toBe(true);
    expect(result.health.checkedAt).toBe(1700000000);
    expect(result.health.transport).toBe("unix_socket");
    expect(result.health.nodeId).toBe("node-1");
    expect(result.health.meshId).toBe("mesh-1");
    expect(result.health.counts?.collaborationRecords).toBe(7);
    expect(result.health.build?.version).toBe("0.test");
    expect(result.health.services?.web?.pid).toBe(111);
    expect(result.runtimeFreshness).toEqual(status.runtimeFreshness);
  });

  test("rejects with a meaningful error on malformed JSON", async () => {
    await expect(
      withEnv({
        OPENSCOUT_SCOUTD_BIN: writeExecutable(
          join(mkdtempSync(join(tmpdir(), "openscout-scoutd-malformed-")), "scoutd"),
        ),
      }, () => runScoutdServiceCommand("status", config, 45_000, async () => "not json at all")),
    ).rejects.toThrow(/returned non-JSON stdout/);
  });

  test("propagates scoutd runner failures", async () => {
    const scoutd = writeExecutable(join(mkdtempSync(join(tmpdir(), "openscout-scoutd-fail-")), "scoutd"));
    await expect(
      withEnv({ OPENSCOUT_SCOUTD_BIN: scoutd }, () =>
        runScoutdServiceCommand("start", config, 45_000, async () => {
          throw new Error("scoutd start failed: service failed");
        })),
    ).rejects.toThrow(/scoutd start failed: service failed/);
  });

  test("refuses to activate a runtime older than the control-plane database", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-newer-schema-"));
    const database = new Database(join(controlHome, "control-plane.sqlite"));
    database.exec(`PRAGMA user_version = ${CONTROL_PLANE_SCHEMA_VERSION + 1}`);
    database.close();
    const guardedCommands = ["install", "start", "restart"] as const;

    for (const command of guardedCommands) {
      let runnerCalled = false;
      await expect(
        runScoutdServiceCommand(
          command,
          { ...config, controlHome },
          45_000,
          async () => {
            runnerCalled = true;
            return "{}";
          },
        ),
      ).rejects.toThrow(
        new RegExp(
          `candidate runtime schema v${CONTROL_PLANE_SCHEMA_VERSION}.*` +
            `database schema v${CONTROL_PLANE_SCHEMA_VERSION + 1}.*existing service was left untouched`,
          "i",
        ),
      );
      expect(runnerCalled).toBe(false);
    }
  });

  test("keeps inspection and recovery commands available with a newer database", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-newer-schema-status-"));
    const database = new Database(join(controlHome, "control-plane.sqlite"));
    database.exec(`PRAGMA user_version = ${CONTROL_PLANE_SCHEMA_VERSION + 1}`);
    database.close();
    const scoutd = writeExecutable(join(mkdtempSync(join(tmpdir(), "openscout-scoutd-status-")), "scoutd"));
    const runnerCalls: string[] = [];

    await withEnv({ OPENSCOUT_SCOUTD_BIN: scoutd }, async () => {
      for (const command of ["status", "stop", "uninstall"] as const) {
        await runScoutdServiceCommand(
          command,
          { ...config, controlHome },
          45_000,
          async (_path, invokedCommand) => {
            runnerCalls.push(invokedCommand);
            return "{}";
          },
        );
      }
    });

    expect(runnerCalls).toEqual(["status", "stop", "uninstall"]);
  });

  test("rejects a runaway child without hanging", async () => {
    const scoutd = writeExecutableScript(
      join(mkdtempSync(join(tmpdir(), "openscout-scoutd-hangs-")), "scoutd-hangs"),
      "#!/bin/sh\n/bin/sleep 5\n",
    );
    const started = Date.now();
    await expect(
      withEnv({ OPENSCOUT_SCOUTD_BIN: scoutd }, () =>
        runScoutdServiceCommand("start", config, 100),
      ),
    ).rejects.toThrow(/scoutd start timed out after 100ms/);
    // Must reject promptly, not let a runaway child pin the caller.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("tmp support directory handling", () => {
  test("the running process honours an explicit /tmp support directory and control home", async () => {
    // Regression: the broker used to swap these for the platform defaults, so
    // its socket and journal landed in ~/.local/share/openscout and
    // ~/.openscout/control-plane despite the overrides.
    await withEnv({
      OPENSCOUT_SUPPORT_DIRECTORY: "/tmp/openscout-remote-install",
      OPENSCOUT_CONTROL_HOME: "/tmp/openscout-remote-install/control-plane",
      OPENSCOUT_BROKER_SOCKET_PATH: undefined,
      XDG_DATA_HOME: undefined,
    }, () => withPlatform("linux", () => {
      const serviceConfig = resolveBrokerServiceConfig();
      expect(serviceConfig.supportDirectory).toBe("/tmp/openscout-remote-install");
      expect(serviceConfig.controlHome).toBe("/tmp/openscout-remote-install/control-plane");
      expect(serviceConfig.brokerSocketPath).toBe("/tmp/openscout-remote-install/runtime/broker.sock");
    }));
  });

  test("a persisted service definition swaps transient /tmp paths for durable defaults", async () => {
    await withEnv({
      OPENSCOUT_SUPPORT_DIRECTORY: "/tmp/openscout-remote-install",
      OPENSCOUT_CONTROL_HOME: "/tmp/openscout-remote-install/control-plane",
      OPENSCOUT_BROKER_SOCKET_PATH: undefined,
      OPENSCOUT_INSTANCE: undefined,
      XDG_DATA_HOME: undefined,
    }, () => withPlatform("linux", () => {
      const persistent = persistentBrokerServiceConfig(resolveBrokerServiceConfig());
      const supportDirectory = join(homedir(), ".local", "share", "openscout");
      expect(persistent.supportDirectory).toBe(supportDirectory);
      expect(persistent.runtimeDirectory).toBe(join(supportDirectory, "runtime"));
      expect(persistent.logsDirectory).toBe(join(supportDirectory, "logs", "broker"));
      expect(persistent.brokerSocketPath).toBe(join(supportDirectory, "runtime", "broker.sock"));
      expect(persistent.controlHome).toBe(join(homedir(), ".openscout", "control-plane"));
    }));

    await withEnv({
      OPENSCOUT_SUPPORT_DIRECTORY: "/tmp/openscout-remote-install",
      OPENSCOUT_INSTANCE: undefined,
      XDG_DATA_HOME: "/var/lib/openscout-should-not-apply",
    }, () => withPlatform("darwin", () => {
      expect(persistentBrokerServiceConfig(resolveBrokerServiceConfig()).supportDirectory)
        .toBe(join(homedir(), "Library", "Application Support", "OpenScout"));
    }));
  });

  test("a non-prod instance derives its own label, socket and control home", async () => {
    await withEnv({
      OPENSCOUT_INSTANCE: "dev",
      OPENSCOUT_SUPPORT_DIRECTORY: undefined,
      OPENSCOUT_CONTROL_HOME: undefined,
      OPENSCOUT_BROKER_SOCKET_PATH: undefined,
      OPENSCOUT_SERVICE_LABEL: undefined,
      OPENSCOUT_BROKER_SERVICE_LABEL: undefined,
    }, () => {
      const serviceConfig = resolveBrokerServiceConfig();
      const root = join(homedir(), ".openscout", "instances", "dev");
      expect(serviceConfig.label).toBe("app.openscout.dev");
      expect(serviceConfig.supportDirectory).toBe(join(root, "support"));
      expect(serviceConfig.controlHome).toBe(join(root, "control-plane"));
      expect(serviceConfig.brokerSocketPath).toBe(join(root, "support", "runtime", "broker.sock"));
    });
  });
});

describe("scoutd resolution on linux", () => {
  test("does not resolve or spawn scoutd when process.platform is linux", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-scoutd-linux-"));
    const marker = join(root, "spawned");
    const scoutd = writeExecutableScript(join(root, "scoutd"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    try {
      await withPlatform("linux", async () => {
        const resolved = await withEnv({
          OPENSCOUT_SCOUTD_BIN: scoutd,
          PATH: root,
        }, () => resolveScoutdCommand(config));
        expect(resolved).toBeNull();
        await expect(withEnv({ OPENSCOUT_SCOUTD_BIN: scoutd }, () =>
          runScoutdServiceCommand("status", config, 1_000),
        )).rejects.toThrow("native supervisor: not applicable on linux");
      });
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});


test("service autorun recognizes only its own source, dist and bundled entries", () => {
  for (const extension of ["ts", "js", "mjs"]) {
    const path = `/owned/runtime/broker-process-manager.${extension}`;
    expect(isBrokerServiceEntrypoint(`file://${path}`, path)).toBe(true);
    expect(isBrokerServiceEntrypoint(`file://${path}`, "/owned/runtime/other.mjs")).toBe(false);
    expect(isBrokerServiceEntrypoint(`file://${path}`, undefined)).toBe(false);
  }
  for (const name of ["broker-daemon.mjs", "base-daemon.mjs", "mesh-discover.mjs", "main.mjs"]) {
    const path = `/owned/runtime/${name}`;
    expect(isBrokerServiceEntrypoint(`file://${path}`, path)).toBe(false);
  }
});
