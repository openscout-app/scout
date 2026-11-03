import { describe, expect, test } from "bun:test";

import type { ChildProcess, SpawnOptions } from "node:child_process";

import {
  appendCsvValues,
  BrokerWebControlService,
  normalizeTrustedWebHost,
  scoutWebControlCorsHeaders,
  webStartContextFromRequest,
} from "./broker-web-control-service.js";

function fakeRequest(headers: Record<string, string | string[] | undefined>) {
  return { headers };
}

type FakeChildProcess = ChildProcess & { emitExit: (code?: number) => void };

function fakeChild(pid = 1234): FakeChildProcess {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  return {
    pid,
    exitCode: null,
    signalCode: null,
    killed: false,
    kill(this: ChildProcess) {
      (this as unknown as { killed: boolean }).killed = true;
      return true;
    },
    once(this: ChildProcess, event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, listener);
      return this;
    },
    unref(this: ChildProcess) {
      return this;
    },
    emitExit(this: ChildProcess, code = 0) {
      (this as unknown as { exitCode: number | null }).exitCode = code;
      listeners.get("exit")?.(code, null);
    },
  } as unknown as FakeChildProcess;
}

describe("BrokerWebControlService", () => {
  test("normalizes trusted hosts and CORS headers", () => {
    const trustedHosts = new Set(["mesh.example.test"]);

    expect(normalizeTrustedWebHost("https://Scout.Local/path", trustedHosts)).toBe("scout.local");
    expect(normalizeTrustedWebHost("demo.scout.local", trustedHosts)).toBe("demo.scout.local");
    expect(normalizeTrustedWebHost("mesh.example.test", trustedHosts)).toBe("mesh.example.test");
    expect(normalizeTrustedWebHost("evil.example.test", trustedHosts)).toBeNull();

    expect(scoutWebControlCorsHeaders(fakeRequest({
      origin: "https://mesh.example.test",
    }), trustedHosts)).toEqual(expect.objectContaining({
      "access-control-allow-origin": "https://mesh.example.test",
      vary: "Origin",
    }));
    expect(scoutWebControlCorsHeaders(fakeRequest({
      origin: "https://evil.example.test",
    }), trustedHosts)).toEqual({});
  });

  test("derives web start context from forwarded headers", () => {
    const context = webStartContextFromRequest(fakeRequest({
      "x-forwarded-host": "mesh.example.test",
      "x-forwarded-proto": "https",
    }), new Set(["mesh.example.test"]));

    expect(context).toEqual({
      publicOrigin: "https://mesh.example.test",
      trustedHost: "mesh.example.test",
    });
    expect(webStartContextFromRequest(fakeRequest({
      "x-forwarded-host": "evil.example.test",
      "x-forwarded-proto": "https",
    }), new Set(["mesh.example.test"]))).toEqual({});
  });

  test("merges trusted host CSV values without duplicate casing", () => {
    expect(appendCsvValues("scout.local, Mesh.Example.Test", [
      "mesh.example.test",
      "tailnet.example.test",
      "",
    ])).toBe("scout.local,Mesh.Example.Test,tailnet.example.test");
  });

  test("reports child service snapshots without probing web health", () => {
    const service = new BrokerWebControlService({
      brokerControlUrl: "http://127.0.0.1:4321",
      env: { OPENSCOUT_WEB_AUTH_TOKEN: "test-web-token", OPENSCOUT_WEB_PORT: "4321" },
      healthCheck: async () => false,
      resolveWebPort: () => 4321,
    });

    expect(service.readChildServiceSnapshots().web).toEqual(expect.objectContaining({
      managedBy: "broker",
      expected: false,
      state: "stopped",
      pid: null,
      port: 4321,
      healthy: null,
    }));
  });

  test("retains explicit web intent when the configured entry is missing", async () => {
    const service = new BrokerWebControlService({
      brokerControlUrl: "http://127.0.0.1:4321",
      env: { OPENSCOUT_WEB_AUTH_TOKEN: "test-web-token" },
      healthCheck: async () => false,
      resolveWebPort: () => 4321,
      resolveEntry: () => null,
    });
    expect(service.readChildServiceSnapshots().web?.expected).toBe(false);
    await service.startIfNeeded();
    expect(service.readChildServiceSnapshots().web).toEqual(expect.objectContaining({expected: true, state: "stopped"}));
    await service.stop();
  });

  test("refuses to restart a healthy web server the broker does not own", async () => {
    const service = new BrokerWebControlService({
      brokerControlUrl: "http://127.0.0.1:4321",
      env: { OPENSCOUT_WEB_AUTH_TOKEN: "test-web-token", OPENSCOUT_WEB_PORT: "4321" },
      healthCheck: async () => true,
      resolveWebPort: () => 4321,
    });

    const status = await service.restartIfManaged();
    expect(status).toEqual(expect.objectContaining({
      ok: false,
      running: true,
      managed: false,
      pid: null,
    }));
    expect(status.error).toContain("outside broker management");
  });

  test("deduplicates concurrent starts and passes broker web environment", async () => {
    const child = fakeChild(2468);
    const spawns: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
    let healthChecks = 0;
    const service = new BrokerWebControlService({
      brokerControlUrl: "http://127.0.0.1:4321",
      tailnetWebHosts: ["tailnet.example.test"],
      env: {
        OPENSCOUT_WEB_AUTH_TOKEN: "test-web-token",
        OPENSCOUT_WEB_LAN_SCOPE: "pairing",
        OPENSCOUT_WEB_PORT: "4321",
        OPENSCOUT_SETUP_CWD: "/repo",
        OPENSCOUT_WEB_TRUSTED_HOSTS: "scout.local",
      },
      healthCheck: async () => {
        healthChecks += 1;
        return healthChecks >= 2;
      },
      spawnProcess(command, args, options) {
        spawns.push({ command, args, options });
        return child;
      },
      resolveEntry: () => "/repo/packages/web/server/index.ts",
      resolveBun: () => ({ path: "/usr/local/bin/bun" }),
      resolveLogPath: () => "/dev/null",
      startPollTimeoutMs: 1_000,
      startPollIntervalMs: 1,
      sleep: async () => {
        if (child.killed && child.exitCode === null) {
          child.emitExit();
        }
      },
      log() {},
    });

    const [first, second] = await Promise.all([
      service.startIfNeeded({ publicOrigin: "https://mesh.example.test", trustedHost: "mesh.example.test" }),
      service.startIfNeeded({ publicOrigin: "https://mesh.example.test", trustedHost: "mesh.example.test" }),
    ]);

    expect(spawns).toHaveLength(1);
    expect(first.running).toBe(true);
    expect(second.running).toBe(true);
    expect(first.pid).toBe(2468);
    expect(spawns[0]?.command).toBe("/usr/local/bin/bun");
    expect(spawns[0]?.args).toEqual(["run", "/repo/packages/web/server/index.ts"]);
    expect(spawns[0]?.options.argv0).toBe("scout-web");
    expect(spawns[0]?.options.detached).toBeUndefined();
    expect(spawns[0]?.options.env).toEqual(expect.objectContaining({
      OPENSCOUT_WEB_HOST: "0.0.0.0",
      OPENSCOUT_WEB_ALLOW_LAN: "1",
      OPENSCOUT_WEB_LAN_SCOPE: "pairing",
      OPENSCOUT_WEB_PORT: "4321",
      OPENSCOUT_WEB_BUN_URL: "http://127.0.0.1:4321",
      OPENSCOUT_BROKER_INTERNAL_URL: "http://127.0.0.1:4321",
      OPENSCOUT_WEB_PUBLIC_ORIGIN: "https://mesh.example.test",
      OPENSCOUT_WEB_ADVERTISED_HOST: "mesh.example.test",
      OPENSCOUT_WEB_TRUSTED_HOSTS: "scout.local,tailnet.example.test,mesh.example.test",
      OPENSCOUT_SETUP_CWD: "/repo",
    }));

    await service.stop();
    expect(child.killed).toBe(true);
  });

  test("waits for its owned web child to exit during broker shutdown", async () => {
    const child = fakeChild(2468);
    let healthChecks = 0;
    const service = new BrokerWebControlService({
      brokerControlUrl: "http://127.0.0.1:4321",
      env: { OPENSCOUT_WEB_AUTH_TOKEN: "test-web-token", OPENSCOUT_WEB_PORT: "4321" },
      healthCheck: async () => {
        healthChecks += 1;
        return healthChecks >= 2;
      },
      spawnProcess() {
        return child;
      },
      resolveEntry: () => "/repo/packages/web/server/index.ts",
      resolveBun: () => ({ path: "/usr/local/bin/bun" }),
      resolveLogPath: () => "/dev/null",
      startPollTimeoutMs: 1_000,
      startPollIntervalMs: 1,
      sleep: async () => {
        if (child.killed && child.exitCode === null) {
          child.emitExit();
        }
      },
    });

    await service.startIfNeeded();
    await service.stop();

    expect(child.killed).toBe(true);
    expect(child.exitCode).toBe(0);
    expect((await service.status()).managed).toBe(false);
  });

  test("forces its owned web child to exit after the graceful stop deadline", async () => {
    const child = fakeChild(2468);
    const signals: NodeJS.Signals[] = [];
    child.kill = (signal?: number | NodeJS.Signals) => {
      signals.push(signal as NodeJS.Signals);
      child.killed = true;
      if (signal === "SIGKILL") child.emitExit();
      return true;
    };
    let healthChecks = 0;
    const service = new BrokerWebControlService({
      brokerControlUrl: "http://127.0.0.1:4321",
      env: { OPENSCOUT_WEB_AUTH_TOKEN: "test-web-token", OPENSCOUT_WEB_PORT: "4321" },
      healthCheck: async () => {
        healthChecks += 1;
        return healthChecks >= 2;
      },
      spawnProcess: () => child,
      resolveEntry: () => "/repo/packages/web/server/index.ts",
      resolveBun: () => ({ path: "/usr/local/bin/bun" }),
      resolveLogPath: () => "/dev/null",
      startPollTimeoutMs: 1_000,
      startPollIntervalMs: 1,
      stopTimeoutMs: 0,
      sleep: async () => {},
    });

    await service.startIfNeeded();
    await service.stop();

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect((await service.status()).managed).toBe(false);
  });

  test("does not spawn a web child after shutdown starts during a health probe", async () => {
    let resolveHealthCheck: ((healthy: boolean) => void) | null = null;
    let spawnCount = 0;
    const service = new BrokerWebControlService({
      brokerControlUrl: "http://127.0.0.1:4321",
      env: { OPENSCOUT_WEB_AUTH_TOKEN: "test-web-token", OPENSCOUT_WEB_PORT: "4321" },
      healthCheck: () => new Promise<boolean>((resolve) => {
        resolveHealthCheck = resolve;
      }),
      spawnProcess() {
        spawnCount += 1;
        return fakeChild(2468);
      },
    });

    const start = service.startIfNeeded();
    await Promise.resolve();
    await service.stop();
    resolveHealthCheck?.(false);
    const status = await start;

    expect(spawnCount).toBe(0);
    expect(status.ok).toBe(false);
    expect(status.error).toContain("broker is stopping");
  });

  test("waits for the managed web process to exit before spawning its replacement", async () => {
    const children = [fakeChild(1001), fakeChild(1002)];
    let spawnCount = 0;
    let healthy = false;
    const service = new BrokerWebControlService({
      brokerControlUrl: "http://127.0.0.1:4321",
      env: { OPENSCOUT_WEB_AUTH_TOKEN: "test-web-token", OPENSCOUT_WEB_PORT: "4321" },
      healthCheck: async () => healthy,
      spawnProcess() {
        return children[spawnCount++]!;
      },
      resolveEntry: () => "/repo/packages/web/server/index.ts",
      resolveBun: () => ({ path: "/usr/local/bin/bun" }),
      resolveLogPath: () => "/dev/null",
      startPollTimeoutMs: 1_000,
      startPollIntervalMs: 1,
      sleep: async () => {
        const first = children[0]!;
        if (first.killed && first.exitCode === null) {
          healthy = false;
          first.emitExit();
        } else {
          healthy = true;
        }
      },
      log() {},
    });

    await service.startIfNeeded();
    expect(spawnCount).toBe(1);
    const restarted = await service.restartIfManaged();
    expect(restarted.ok).toBe(true);
    expect(spawnCount).toBe(2);
    expect(restarted.pid).toBe(1002);
  });
});

function monitoredService(options: { startupHealthy?: boolean; healthMaxRestarts?: number } = {}) {
  let now = 100_000;
  const children: FakeChildProcess[] = [];
  const responsive = new Map<number, boolean>();
  const signals: Array<{ pid: number; signal: string }> = [];
  const events: string[] = [];
  let probes = 0;
  const service = new BrokerWebControlService({
    brokerControlUrl: "http://127.0.0.1:4321",
    env: { OPENSCOUT_WEB_AUTH_TOKEN: "test-token", OPENSCOUT_WEB_PORT: "4321", OPENSCOUT_WEB_LAN_SCOPE: "pairing" },
    now: () => now,
    healthMonitorIntervalMs: 0,
    healthMaxRestarts: options.healthMaxRestarts,
    startPollTimeoutMs: 0,
    stopTimeoutMs: 0,
    healthCheck: async () => {
      probes += 1;
      const child = children.at(-1);
      return Boolean(child && child.exitCode === null && responsive.get(child.pid!));
    },
    spawnProcess() {
      const child = fakeChild(2000 + children.length);
      responsive.set(child.pid!, children.length > 0 || options.startupHealthy !== false);
      child.kill = (signal) => {
        signals.push({ pid: child.pid!, signal: String(signal) });
        if (signal === "SIGKILL") child.emitExit();
        return true;
      };
      children.push(child);
      return child;
    },
    resolveEntry: () => "/repo/packages/web/server/index.ts",
    resolveBun: () => ({ path: "/usr/local/bin/bun" }),
    resolveLogPath: () => "/dev/null",
    log: (event) => events.push(event),
    warn: (event) => events.push(event),
  });
  return {
    service, children, signals, events,
    probes: () => probes,
    advance: (ms: number) => { now += ms; },
    setHealthy: (value: boolean) => responsive.set(children.at(-1)!.pid!, value),
    async failThree() {
      this.setHealthy(false);
      for (let n = 0; n < 3; n++) {
        this.advance(10_000);
        await service.checkManagedHealth();
      }
    },
  };
}

describe("managed web health recovery", () => {
  test("one delayed probe is quiet and a later success resets suspicion", async () => {
    const rig = monitoredService();
    try {
      await rig.service.startIfNeeded();
      await rig.service.checkManagedHealth();
      rig.setHealthy(false);
      rig.advance(10_000);
      await rig.service.checkManagedHealth();
      expect(rig.service.recoveryStatus().state).toBe("suspect");
      expect(rig.service.readChildServiceSnapshots().web?.healthy).toBeNull();
      expect(rig.signals).toHaveLength(0);
      rig.setHealthy(true);
      rig.advance(10_000);
      await rig.service.checkManagedHealth();
      expect(rig.service.recoveryStatus()).toMatchObject({ state: "healthy", consecutiveFailures: 0, automaticRestarts: 0 });
      expect(rig.events.filter((event) => event.includes("scout-web-health"))).toHaveLength(0);
      const before = rig.probes();
      expect(rig.service.readChildServiceSnapshots().web?.healthy).toBe(true);
      expect(rig.probes()).toBe(before);
    } finally { await rig.service.stop(); }
  });

  test("repeated failures force the stuck owned child out before one replacement", async () => {
    const rig = monitoredService();
    try {
      await rig.service.startIfNeeded();
      await rig.service.checkManagedHealth();
      await rig.failThree();
      expect(rig.signals).toEqual([{ pid: 2000, signal: "SIGTERM" }, { pid: 2000, signal: "SIGKILL" }]);
      expect(rig.children).toHaveLength(2);
      expect(rig.children[0]!.exitCode).not.toBeNull();
      expect(rig.service.recoveryStatus()).toMatchObject({ state: "healthy", automaticRestarts: 1,
        lastRecovery: { startedAt: 130_000, recoveredAt: 130_000, previousPid: 2000, replacementPid: 2001 } });
      expect(rig.events.filter((event) => event.includes("exited unexpectedly"))).toHaveLength(0);
    } finally { await rig.service.stop(); }
  });

  test("startup grace and interrupted observation do not trigger recovery", async () => {
    const rig = monitoredService({ startupHealthy: false });
    try {
      await rig.service.startIfNeeded();
      await rig.failThree();
      expect(rig.signals).toHaveLength(0);
      rig.advance(40_000);
      await rig.service.checkManagedHealth();
      expect(rig.service.recoveryStatus().consecutiveFailures).toBe(1);
      rig.advance(60_000); // parent asleep / unable to observe
      await rig.service.checkManagedHealth();
      expect(rig.service.recoveryStatus().consecutiveFailures).toBe(1);
      expect(rig.signals).toHaveLength(0);
    } finally { await rig.service.stop(); }
  });

  test("repeated interruptions pause recovery until an explicit restart", async () => {
    const rig = monitoredService({ healthMaxRestarts: 1 });
    try {
      await rig.service.startIfNeeded();
      await rig.service.checkManagedHealth();
      await rig.failThree();
      await rig.service.checkManagedHealth();
      await rig.failThree();
      expect(rig.service.recoveryStatus()).toMatchObject({ state: "paused", automaticRestarts: 1 });
      expect(rig.children).toHaveLength(2);
      await rig.failThree();
      expect(rig.events.filter((event) => event.includes("recovery paused"))).toHaveLength(1);
      await rig.service.restartIfManaged();
      await rig.service.checkManagedHealth();
      await rig.failThree();
      expect(rig.service.recoveryStatus().automaticRestarts).toBe(2);
    } finally { await rig.service.stop(); }
  });

  test("concurrent manual restart and start share the replacement and stop disables monitoring", async () => {
    const rig = monitoredService();
    await rig.service.startIfNeeded();
    const [one, two, three] = await Promise.all([
      rig.service.restartIfManaged(), rig.service.restartIfManaged(), rig.service.startIfNeeded(),
    ]);
    expect(rig.children).toHaveLength(2);
    expect([one.pid, two.pid, three.pid]).toEqual([2001, 2001, 2001]);
    await rig.service.stop();
    const before = rig.probes();
    await rig.service.checkManagedHealth();
    expect(rig.probes()).toBe(before);
    expect((await rig.service.restartIfManaged()).ok).toBe(false);
    expect(rig.children).toHaveLength(2);
  });

  test("unowned services are never monitored or killed", async () => {
    let probes = 0;
    const service = new BrokerWebControlService({
      brokerControlUrl: "http://localhost:4321",
      env: { OPENSCOUT_WEB_AUTH_TOKEN: "test-token", OPENSCOUT_WEB_PORT: "4321" },
      healthCheck: async () => { probes++; return false; },
    });
    await service.checkManagedHealth();
    expect(probes).toBe(0);
    expect(service.recoveryStatus().automaticRestarts).toBe(0);
  });
});
