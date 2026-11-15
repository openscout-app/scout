import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defineProbe,
  defineProbeFamily,
  GitCatalogValidationError,
  gitBuildInfoProbe,
  gitDiffNumstat,
  gitDiffShortstatProbe,
  gitLogLastCommitUnixProbe,
  gitMergeBaseProbe,
  gitRevParse,
  gitRevParseProbe,
  gitStatusPorcelainProbe,
  gitWorktreeListPorcelainProbe,
  netListenersProbe,
  processCwdProbe,
  psDiscoveryProbe,
  psRuntimeProbe,
  resetScoutdProbeClientForTests,
  resetGitBuildInfoProbeForTests,
  tailscaleStatusProbe,
  parseTmuxSessionList,
  tmuxPanesProbe,
  tmuxSessionsProbe,
  zellijSessionsProbe
} from "./system-probes/index";

const tempDirectories = new Set<string>();
const originalTailscaleBin = process.env.OPENSCOUT_TAILSCALE_BIN;
const originalTailscaleFixture = process.env.OPENSCOUT_TAILSCALE_STATUS_JSON;
const originalProbesSocket = process.env.OPENSCOUT_PROBES_SOCKET;
const originalOpenScoutHome = process.env.OPENSCOUT_HOME;
const originalGitBin = process.env.OPENSCOUT_GIT_BIN;
const originalTestGitMode = process.env.OPENSCOUT_TEST_GIT_MODE;
const originalPsBin = process.env.OPENSCOUT_PS_BIN;
const originalLsofBin = process.env.OPENSCOUT_LSOF_BIN;
const originalPsDiscoveryMaxRows = process.env.OPENSCOUT_PS_DISCOVERY_MAX_ROWS;
const originalTmuxBin = process.env.OPENSCOUT_TMUX_BIN;
const originalZellijBin = process.env.OPENSCOUT_ZELLIJ_BIN;
const originalZellijSocketDir = process.env.ZELLIJ_SOCKET_DIR;
const repositoryRoot = join(import.meta.dir, "../../..");
let scoutdBinaryPromise: Promise<string> | null = null;
const runScoutdConformance = /^(1|true|yes)$/iu.test(process.env.OPENSCOUT_CONFORMANCE ?? "");
const describeScoutdConformance = runScoutdConformance ? describe : describe.skip;

if (!runScoutdConformance) {
  console.warn("[openscout] skipping real scoutd conformance harness; set OPENSCOUT_CONFORMANCE=1 to run it.");
}

test("tmux session parser preserves host-reported last activity", () => {
  expect(parseTmuxSessionList(
    "alpha|2|1|1710000000|1710003600|zsh|/workspace/alpha\n",
  )).toEqual([{
    name: "alpha",
    windows: 2,
    attached: 1,
    createdAt: 1710000000,
    activityAt: 1710003600,
    currentCommand: "zsh",
    currentPath: "/workspace/alpha",
    windowName: null,
    paneTitle: null,
  }]);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 250);
    server.close(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function startScoutdProbeServer(socketPath: string, handler: (request: any) => any | Promise<any>): Promise<Server> {
  rmSync(socketPath, { force: true });
  const server = createServer((socket: Socket) => {
    let raw = "";
    let handled = false;
    const respond = () => {
      if (handled) return;
      handled = true;
      const body = raw.trim();
      try {
        const request = JSON.parse(body);
        Promise.resolve(handler(request)).then((response) => {
          socket.end(`${JSON.stringify(response)}\n`);
        }, (error) => {
          socket.end(JSON.stringify({
            schema: "openscout.probe.error/v1",
            error: {
              code: "test_error",
              message: error instanceof Error ? error.message : String(error),
            },
            daemonVersion: "test",
          }));
        });
      } catch (error) {
        socket.end(JSON.stringify({
          schema: "openscout.probe.error/v1",
          error: {
            code: "test_error",
            message: error instanceof Error ? error.message : String(error),
          },
          daemonVersion: "test",
        }));
      }
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      raw += chunk;
      if (raw.includes("\n")) {
        respond();
      }
    });
    socket.on("end", respond);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function requestProbeSocket(socketPath: string, payload: Record<string, unknown>, timeoutMs = 5_000): Promise<any> {
  return await new Promise<any>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let raw = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`socket request timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();

    function finish(error: Error | null, value?: any): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    }

    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      raw += chunk;
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => {
      try {
        finish(null, JSON.parse(raw.trim()));
      } catch (error) {
        finish(new Error(`socket response was not JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    socket.on("close", () => {
      if (!settled && raw.length > 0) {
        try {
          finish(null, JSON.parse(raw.trim()));
        } catch (error) {
          finish(new Error(`socket response was not JSON: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
    });
  });
}

async function waitForSocket(socketPath: string, stderr: () => string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(socketPath)) {
      try {
        await requestProbeSocket(socketPath, { schema: "openscout.probe.capabilities/v1" }, 250);
        return;
      } catch {
        // Keep polling until the server accepts connections.
      }
    }
    await sleep(25);
  }
  throw new Error(`scoutd probe server did not become ready at ${socketPath}: ${stderr()}`);
}

async function ensureScoutdBinary(): Promise<string> {
  if (!scoutdBinaryPromise) {
    scoutdBinaryPromise = Promise.resolve().then(() => {
      execFileSync("bash", [
        join(repositoryRoot, "scripts/cargo.sh"),
        "build",
        "--manifest-path",
        join(repositoryRoot, "crates/scoutd/Cargo.toml"),
      ], {
        cwd: repositoryRoot,
        stdio: "inherit",
      });
      return join(repositoryRoot, "target/debug/scoutd");
    });
  }
  return await scoutdBinaryPromise;
}

async function startRealScoutdProbeServer(input: {
  socketPath: string;
  env: Record<string, string | undefined>;
}): Promise<{ stop: () => Promise<void>; stderr: () => string }> {
  const scoutd = await ensureScoutdBinary();
  let stderr = "";
  const child = spawn(scoutd, ["probes", "serve"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OPENSCOUT_PROBES_SOCKET: input.socketPath,
      ...input.env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.once("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      stderr += `\nscoutd exited with ${code}`;
    } else if (signal) {
      stderr += `\nscoutd exited with ${signal}`;
    }
  });
  await waitForSocket(input.socketPath, () => stderr);
  return {
    stderr: () => stderr,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        sleep(1_000).then(() => {
          child.kill("SIGKILL");
        }),
      ]);
    },
  };
}

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.add(directory);
  return directory;
}

let shortTempCounter = 0;
function shortTempDir(prefix: string): string {
  shortTempCounter += 1;
  const safePrefix = prefix.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 12);
  const directory = join("/tmp", `${safePrefix}-${process.pid}-${shortTempCounter}`);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  tempDirectories.add(directory);
  return directory;
}

beforeEach(() => {
  const directory = tempDir("openscout-probes-disabled-");
  process.env.OPENSCOUT_PROBES_SOCKET = join(directory, "missing.sock");
  resetScoutdProbeClientForTests();
});

afterEach(() => {
  if (originalTailscaleBin === undefined) {
    delete process.env.OPENSCOUT_TAILSCALE_BIN;
  } else {
    process.env.OPENSCOUT_TAILSCALE_BIN = originalTailscaleBin;
  }
  if (originalTailscaleFixture === undefined) {
    delete process.env.OPENSCOUT_TAILSCALE_STATUS_JSON;
  } else {
    process.env.OPENSCOUT_TAILSCALE_STATUS_JSON = originalTailscaleFixture;
  }
  if (originalProbesSocket === undefined) {
    delete process.env.OPENSCOUT_PROBES_SOCKET;
  } else {
    process.env.OPENSCOUT_PROBES_SOCKET = originalProbesSocket;
  }
  if (originalOpenScoutHome === undefined) {
    delete process.env.OPENSCOUT_HOME;
  } else {
    process.env.OPENSCOUT_HOME = originalOpenScoutHome;
  }
  if (originalGitBin === undefined) {
    delete process.env.OPENSCOUT_GIT_BIN;
  } else {
    process.env.OPENSCOUT_GIT_BIN = originalGitBin;
  }
  if (originalTestGitMode === undefined) {
    delete process.env.OPENSCOUT_TEST_GIT_MODE;
  } else {
    process.env.OPENSCOUT_TEST_GIT_MODE = originalTestGitMode;
  }
  if (originalPsBin === undefined) {
    delete process.env.OPENSCOUT_PS_BIN;
  } else {
    process.env.OPENSCOUT_PS_BIN = originalPsBin;
  }
  if (originalLsofBin === undefined) {
    delete process.env.OPENSCOUT_LSOF_BIN;
  } else {
    process.env.OPENSCOUT_LSOF_BIN = originalLsofBin;
  }
  if (originalPsDiscoveryMaxRows === undefined) {
    delete process.env.OPENSCOUT_PS_DISCOVERY_MAX_ROWS;
  } else {
    process.env.OPENSCOUT_PS_DISCOVERY_MAX_ROWS = originalPsDiscoveryMaxRows;
  }
  if (originalTmuxBin === undefined) {
    delete process.env.OPENSCOUT_TMUX_BIN;
  } else {
    process.env.OPENSCOUT_TMUX_BIN = originalTmuxBin;
  }
  if (originalZellijBin === undefined) {
    delete process.env.OPENSCOUT_ZELLIJ_BIN;
  } else {
    process.env.OPENSCOUT_ZELLIJ_BIN = originalZellijBin;
  }
  if (originalZellijSocketDir === undefined) {
    delete process.env.ZELLIJ_SOCKET_DIR;
  } else {
    process.env.ZELLIJ_SOCKET_DIR = originalZellijSocketDir;
  }
  tailscaleStatusProbe.invalidate("test.reset");
  gitBuildInfoProbe.for(process.cwd()).invalidate("test.reset");
  gitRevParseProbe.invalidate({ repoRoot: process.cwd(), kind: "showToplevel" }, "test.reset");
  gitDiffShortstatProbe.invalidate({ repoRoot: process.cwd(), selector: { kind: "unstaged" } }, "test.reset");
  psRuntimeProbe.invalidate("test.reset");
  psDiscoveryProbe.invalidate("test.reset");
  processCwdProbe.invalidate(String(process.pid), "test.reset");
  netListenersProbe.invalidate("1", "test.reset");
  tmuxSessionsProbe.invalidate("default", "test.reset");
  zellijSessionsProbe.invalidate(process.env.ZELLIJ_SOCKET_DIR ?? "", "test.reset");
  tmuxPanesProbe.invalidate({ kind: "detail", target: "test" }, "test.reset");
  resetGitBuildInfoProbeForTests();
  resetScoutdProbeClientForTests();
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirectories.clear();
});

describe("system probe registry", () => {
  test("deduplicates concurrent fresh readers with a single-flight run", async () => {
    let runs = 0;
    const gate = deferred<number>();
    const probe = defineProbe<number>({
      id: "test.singleFlight",
      ttlMs: 1_000,
      timeoutMs: 1_000,
      run: async () => {
        runs += 1;
        return await gate.promise;
      },
    });

    const readers = Array.from({ length: 8 }, () => probe.fresh());
    await sleep(10);
    expect(runs).toBe(1);
    gate.resolve(42);

    const snapshots = await Promise.all(readers);
    expect(snapshots.map((snapshot) => snapshot.value)).toEqual(Array(8).fill(42));
    expect(probe.metrics().runCount).toBe(1);
  });

  test("serves stale snapshots while revalidating in the background", async () => {
    let runs = 0;
    const secondRun = deferred<number>();
    const probe = defineProbe<number>({
      id: "test.staleWhileRevalidate",
      ttlMs: 50,
      timeoutMs: 1_000,
      maxStaleMs: 1_000,
      run: async () => {
        runs += 1;
        if (runs === 1) {
          return 1;
        }
        return await secondRun.promise;
      },
    });

    expect((await probe.fresh()).value).toBe(1);
    await sleep(75);

    const stale = probe.read();
    expect(stale.status).toBe("stale");
    expect(stale.value).toBe(1);
    expect(stale.refreshing).toBe(true);
    expect(runs).toBe(2);

    secondRun.resolve(2);
    await probe.fresh();
    expect(probe.snapshot().value).toBe(2);
    expect(probe.snapshot().status).toBe("fresh");
  });

  test("fresh reruns when an in-flight read was invalidated by a side effect", async () => {
    let runs = 0;
    const firstRun = deferred<number>();
    const secondRun = deferred<number>();
    const probe = defineProbe<number>({
      id: "test.invalidateInFlight",
      ttlMs: 1_000,
      timeoutMs: 1_000,
      run: async () => {
        runs += 1;
        return await (runs === 1 ? firstRun.promise : secondRun.promise);
      },
    });

    const cold = probe.read();
    expect(cold.status).toBe("empty");
    await sleep(10);
    expect(runs).toBe(1);

    probe.invalidate("test.side-effect");
    const fresh = probe.fresh({ maxAgeMs: 0 });
    firstRun.resolve(1);
    await sleep(10);

    expect(runs).toBe(2);
    secondRun.resolve(2);
    expect((await fresh).value).toBe(2);
    expect(probe.metrics().runCount).toBe(2);
  });

  test("marks snapshots failed after maxStaleMs", async () => {
    const probe = defineProbe<number>({
      id: "test.maxStale",
      ttlMs: 5,
      timeoutMs: 1_000,
      maxStaleMs: 20,
      run: async () => 7,
    });

    expect((await probe.fresh()).status).toBe("fresh");
    await sleep(35);

    const snapshot = probe.snapshot();
    expect(snapshot.status).toBe("failed");
    expect(snapshot.value).toBeNull();
    expect(snapshot.error?.code).toBe("max_stale_exceeded");
  });

  test("evicts keyed family entries by LRU", async () => {
    const family = defineProbeFamily<string, string>({
      id: "test.family",
      ttlMs: 1_000,
      timeoutMs: 1_000,
      maxKeys: 2,
      idleKeyTtlMs: 60_000,
      maxConcurrentKeys: 1,
      normalizeKey: (key) => key.toLowerCase(),
      run: async (key) => key,
    });

    family.for("A").snapshot();
    await sleep(2);
    family.for("B").snapshot();
    await sleep(2);
    family.for("C").snapshot();

    expect(family.keys().sort()).toEqual(["b", "c"]);
    expect(family.metrics().keyCount).toBe(2);
  });
});

describe("tailscale.status probe", () => {
  test("single-flights concurrent readers and caches for the 30s ttl", async () => {
    const directory = tempDir("openscout-tailscale-probe-");
    const counter = join(directory, "count");
    const tailscale = join(directory, "tailscale");
    writeFileSync(tailscale, `#!/bin/sh
if [ "$1" = "status" ]; then
  count=$(cat ${JSON.stringify(counter)} 2>/dev/null || echo 0)
  count=$((count + 1))
  echo "$count" > ${JSON.stringify(counter)}
  sleep 0.05
  cat <<'JSON'
{"BackendState":"Running","Health":[],"Self":{"ID":"self-node","HostName":"workstation","DNSName":"workstation.tailnet.ts.net.","TailscaleIPs":["100.64.0.10"],"Online":true},"Peer":{}}
JSON
  exit 0
fi
exit 64
`, "utf8");
    chmodSync(tailscale, 0o755);
    delete process.env.OPENSCOUT_TAILSCALE_STATUS_JSON;
    process.env.OPENSCOUT_TAILSCALE_BIN = tailscale;
    tailscaleStatusProbe.invalidate("test.concurrent");

    const snapshots = await Promise.all(
      Array.from({ length: 10 }, () => tailscaleStatusProbe.fresh({ maxAgeMs: 0 })),
    );

    expect(snapshots.every((snapshot) => snapshot.value?.running === true)).toBe(true);
    expect(readFileSync(counter, "utf8").trim()).toBe("1");

    for (let i = 0; i < 10; i += 1) {
      expect(tailscaleStatusProbe.read().value?.self?.hostName).toBe("workstation");
    }
    expect(readFileSync(counter, "utf8").trim()).toBe("1");
  });
});

describe("scoutd probe backend", () => {
  function capabilities() {
    return {
      schema: "openscout.probe.capabilities/v1",
      daemonVersion: "test-daemon",
      families: [
        { probeId: "tailscale.status", schemaVersion: 1, ttlMs: 30_000 },
        { probeId: "git.buildInfo", schemaVersion: 1, ttlMs: 60_000 },
      ],
    };
  }

  test("routes supported tailscale and git probes over the scoutd socket", async () => {
    const directory = mkdtempSync("/tmp/openscout-scoutd-probe-");
    tempDirectories.add(directory);
    const socketPath = join(directory, "probes.sock");
    process.env.OPENSCOUT_PROBES_SOCKET = socketPath;
    resetScoutdProbeClientForTests();

    const server = await startScoutdProbeServer(socketPath, (request) => {
      if (request.schema === "openscout.probe.capabilities/v1") {
        return capabilities();
      }
      if (request.probeId === "tailscale.status") {
        return {
          schema: "openscout.probe.snapshot/v1",
          probeId: "tailscale.status",
          key: null,
          generatedAt: Date.now(),
          ttlMs: 30_000,
          value: {
            backendState: "Running",
            running: true,
            health: [],
            peers: [],
            self: {
              id: "daemon-self",
              name: "daemon",
              addresses: ["100.64.0.1"],
              online: true,
              hostName: "daemon",
            },
          },
          error: null,
          daemonVersion: "test-daemon",
        };
      }
      if (request.probeId === "git.buildInfo") {
        return {
          schema: "openscout.probe.snapshot/v1",
          probeId: "git.buildInfo",
          key: request.key,
          generatedAt: Date.now(),
          ttlMs: 60_000,
          value: {
            repoRoot: request.key,
            commit: "abc123",
            bootBranch: "main",
            branch: "main",
            dirty: false,
            metadataAt: 123,
            statusAt: 456,
          },
          error: null,
          daemonVersion: "test-daemon",
        };
      }
      throw new Error(`unexpected probe ${request.probeId}`);
    });

    try {
      tailscaleStatusProbe.invalidate("test.scoutd");
      const tailscale = await tailscaleStatusProbe.fresh({ maxAgeMs: 0 });
      expect(tailscale.backend).toBe("scoutd");
      expect(tailscale.value?.self?.hostName).toBe("daemon");

      const git = await gitBuildInfoProbe.for(process.cwd()).fresh({ maxAgeMs: 0 });
      expect(git.backend).toBe("scoutd");
      expect(git.value?.commit).toBe("abc123");
    } finally {
      await closeServer(server);
    }
  });

  test("falls back visibly when a previously observed scoutd socket fails and re-adopts it later", async () => {
    const directory = mkdtempSync("/tmp/openscout-scoutd-fallback-");
    tempDirectories.add(directory);
    const socketPath = join(directory, "probes.sock");
    const fixture = join(directory, "tailscale.json");
    writeFileSync(fixture, JSON.stringify({
      BackendState: "Running",
      Health: [],
      Self: {
        ID: "local-self",
        HostName: "local",
        TailscaleIPs: ["100.64.0.2"],
        Online: true,
      },
      Peer: {},
    }), "utf8");
    process.env.OPENSCOUT_TAILSCALE_STATUS_JSON = fixture;
    process.env.OPENSCOUT_PROBES_SOCKET = socketPath;
    resetScoutdProbeClientForTests();

    const makeServer = (hostName: string) => startScoutdProbeServer(socketPath, (request) => {
      if (request.schema === "openscout.probe.capabilities/v1") {
        return capabilities();
      }
      return {
        schema: "openscout.probe.snapshot/v1",
        probeId: "tailscale.status",
        key: null,
        generatedAt: Date.now(),
        ttlMs: 30_000,
        value: {
          backendState: "Running",
          running: true,
          health: [],
          peers: [],
          self: {
            id: `${hostName}-self`,
            name: hostName,
            addresses: ["100.64.0.3"],
            online: true,
            hostName,
          },
        },
        error: null,
        daemonVersion: "test-daemon",
      };
    });

    let server = await makeServer("daemon-a");
    tailscaleStatusProbe.invalidate("test.initial-scoutd");
    const first = await tailscaleStatusProbe.fresh({ maxAgeMs: 0 });
    expect(first.backend).toBe("scoutd");
    expect(first.value?.self?.hostName).toBe("daemon-a");
    await closeServer(server);
    rmSync(socketPath, { force: true });
    writeFileSync(socketPath, "stale socket placeholder", "utf8");

    tailscaleStatusProbe.invalidate("test.socket-failed");
    const fallback = await tailscaleStatusProbe.fresh({ maxAgeMs: 0 });
    expect(fallback.backend).toBe("local-fallback");
    expect(typeof fallback.fallbackSince).toBe("number");
    expect(fallback.fallbackReason?.length).toBeGreaterThan(0);
    expect(fallback.value?.self?.hostName).toBe("local");

    rmSync(socketPath, { force: true });
    server = await makeServer("daemon-b");
    try {
      tailscaleStatusProbe.invalidate("test.re-adopt");
      const readopted = await tailscaleStatusProbe.fresh({ maxAgeMs: 0 });
      expect(readopted.backend).toBe("scoutd");
      expect(readopted.value?.self?.hostName).toBe("daemon-b");
    } finally {
      await closeServer(server);
    }
  });

  test("falls back locally instead of sending a request when a probe schema version differs", async () => {
    const directory = tempDir("openscout-scoutd-schema-skew-");
    const socketPath = join(directory, "probes.sock");
    const fixture = join(directory, "tailscale.json");
    writeFileSync(fixture, JSON.stringify({
      BackendState: "Running",
      Health: [],
      Self: {
        ID: "local-self",
        HostName: "schema-local",
        TailscaleIPs: ["100.64.0.9"],
        Online: true,
      },
      Peer: {},
    }), "utf8");
    process.env.OPENSCOUT_TAILSCALE_STATUS_JSON = fixture;
    process.env.OPENSCOUT_PROBES_SOCKET = socketPath;
    resetScoutdProbeClientForTests();
    const requests: any[] = [];

    const server = await startScoutdProbeServer(socketPath, (request) => {
      requests.push(request);
      if (request.schema === "openscout.probe.capabilities/v1") {
        return {
          schema: "openscout.probe.capabilities/v1",
          daemonVersion: "skewed-daemon",
          families: [
            { probeId: "tailscale.status", schemaVersion: 2, ttlMs: 30_000 },
          ],
        };
      }
      throw new Error("probe request should not be sent when schema versions differ");
    });

    try {
      tailscaleStatusProbe.invalidate("test.schema-skew");
      const snapshot = await tailscaleStatusProbe.fresh({ maxAgeMs: 0 });

      expect(snapshot.backend).toBe("local-fallback");
      expect(snapshot.fallbackReason).toContain("schema v2");
      expect(snapshot.value?.self?.hostName).toBe("schema-local");
      expect(requests).toEqual([{ schema: "openscout.probe.capabilities/v1" }]);
    } finally {
      await closeServer(server);
    }
  });

  test("keeps capabilities cached across per-probe scoutd errors", async () => {
    const directory = tempDir("openscout-scoutd-probe-error-cache-");
    const socketPath = join(directory, "probes.sock");
    const fixture = join(directory, "tailscale.json");
    writeFileSync(fixture, JSON.stringify({
      BackendState: "Running",
      Health: [],
      Self: {
        ID: "local-self",
        HostName: "local-after-probe-error",
        TailscaleIPs: ["100.64.0.10"],
        Online: true,
      },
      Peer: {},
    }), "utf8");
    process.env.OPENSCOUT_TAILSCALE_STATUS_JSON = fixture;
    process.env.OPENSCOUT_PROBES_SOCKET = socketPath;
    resetScoutdProbeClientForTests();
    const requestSchemas: string[] = [];
    let probeRequests = 0;

    const server = await startScoutdProbeServer(socketPath, (request) => {
      requestSchemas.push(request.schema);
      if (request.schema === "openscout.probe.capabilities/v1") return capabilities();
      probeRequests += 1;
      if (probeRequests === 1) {
        return {
          schema: "openscout.probe.snapshot/v1",
          probeId: "tailscale.status",
          key: null,
          generatedAt: Date.now(),
          ttlMs: 30_000,
          value: null,
          error: { code: "timeout", message: "slow probe", timed_out: true },
          daemonVersion: "test-daemon",
        };
      }
      return {
        schema: "openscout.probe.snapshot/v1",
        probeId: "tailscale.status",
        key: null,
        generatedAt: Date.now(),
        ttlMs: 30_000,
        value: {
          backendState: "Running",
          running: true,
          health: [],
          peers: [],
          self: {
            id: "daemon-after-error",
            name: "daemon-after-error",
            addresses: ["100.64.0.11"],
            online: true,
            hostName: "daemon-after-error",
          },
        },
        error: null,
        daemonVersion: "test-daemon",
      };
    });

    try {
      tailscaleStatusProbe.invalidate("test.first-probe-error");
      const fallback = await tailscaleStatusProbe.fresh({ maxAgeMs: 0 });
      expect(fallback.backend).toBe("local-fallback");
      expect(fallback.value?.self?.hostName).toBe("local-after-probe-error");

      tailscaleStatusProbe.invalidate("test.second-with-cached-capabilities");
      const recovered = await tailscaleStatusProbe.fresh({ maxAgeMs: 0 });
      expect(recovered.backend).toBe("scoutd");
      expect(recovered.value?.self?.hostName).toBe("daemon-after-error");
      expect(requestSchemas).toEqual([
        "openscout.probe.capabilities/v1",
        "openscout.probe.request/v1",
        "openscout.probe.request/v1",
      ]);
    } finally {
      await closeServer(server);
    }
  });

  test("keeps the socket timeout above the probe operation timeout to avoid duplicate local exec", async () => {
    const directory = tempDir("openscout-scoutd-timeout-hierarchy-");
    const socketPath = join(directory, "probes.sock");
    process.env.OPENSCOUT_PROBES_SOCKET = socketPath;
    resetScoutdProbeClientForTests();
    let localRuns = 0;
    const tailscale = join(directory, "tailscale");
    writeFileSync(tailscale, `#!/bin/sh
printf x >> ${JSON.stringify(join(directory, "local-count"))}
exit 64
`, "utf8");
    chmodSync(tailscale, 0o755);
    process.env.OPENSCOUT_TAILSCALE_BIN = tailscale;

    const server = await startScoutdProbeServer(socketPath, async (request) => {
      if (request.schema === "openscout.probe.capabilities/v1") return capabilities();
      localRuns += 1;
      await sleep(950);
      return {
        schema: "openscout.probe.snapshot/v1",
        probeId: "tailscale.status",
        key: null,
        generatedAt: Date.now(),
        ttlMs: 30_000,
        value: {
          backendState: "Running",
          running: true,
          health: [],
          peers: [],
          self: {
            id: "slow-daemon",
            name: "slow-daemon",
            addresses: ["100.64.0.4"],
            online: true,
            hostName: "slow-daemon",
          },
        },
        error: null,
        daemonVersion: "test-daemon",
      };
    });

    try {
      tailscaleStatusProbe.invalidate("test.timeout-hierarchy");
      const snapshot = await tailscaleStatusProbe.fresh({ maxAgeMs: 0 });

      expect(snapshot.backend).toBe("scoutd");
      expect(snapshot.value?.self?.hostName).toBe("slow-daemon");
      expect(localRuns).toBe(1);
      expect(existsSync(join(directory, "local-count"))).toBe(false);
    } finally {
      await closeServer(server);
    }
  });
});

describe("git.buildInfo probe", () => {
  function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  test("caches build metadata and refreshes branch/dirty by repo key", async () => {
    const repo = tempDir("openscout-git-probe-");
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "probe@example.com"]);
    git(repo, ["config", "user.name", "Probe Test"]);
    writeFileSync(join(repo, "README.md"), "hello\n", "utf8");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "initial"]);

    const first = await gitBuildInfoProbe.for(join(repo, ".")).fresh({ maxAgeMs: 0 });
    expect(first.value?.repoRoot).toBe(realpathSync(repo));
    expect(first.value?.branch).toBe("main");
    expect(first.value?.commit).toBe(git(repo, ["rev-parse", "--short", "HEAD"]));
    expect(first.value?.dirty).toBe(false);

    writeFileSync(join(repo, "dirty.txt"), "dirty\n", "utf8");
    gitBuildInfoProbe.for(repo).invalidate("test.dirty");
    const second = await gitBuildInfoProbe.for(repo).fresh({ maxAgeMs: 0 });
    expect(second.value?.dirty).toBe(true);
    expect(second.value?.commit).toBe(first.value?.commit);
  });
});

describe("git catalog option-injection guardrails", () => {
  function writeGitArgLogger(directory: string): { gitBin: string; logPath: string } {
    const script = join(directory, "git-arg-logger.sh");
    const logPath = join(directory, "git-args.log");
    writeFileSync(script, `#!/bin/sh
printf '%s\\n' "$@" >> "${logPath}"
if [ "$1" = "-C" ]; then
  shift 2
fi
if [ "$1" = "rev-parse" ]; then
  printf 'abc123\\n'
  exit 0
fi
if [ "$1" = "diff" ]; then
  exit 0
fi
exit 0
`, "utf8");
    chmodSync(script, 0o755);
    return { gitBin: script, logPath };
  }

  function loggedArgs(logPath: string): string[] {
    return readFileSync(logPath, "utf8").trim().split(/\n/).filter(Boolean);
  }

  test("uses --end-of-options for refs and -- for pathspecs", async () => {
    const directory = tempDir("openscout-git-guards-");
    const { gitBin, logPath } = writeGitArgLogger(directory);
    process.env.OPENSCOUT_GIT_BIN = gitBin;
    process.env.OPENSCOUT_PROBES_SOCKET = join(directory, "missing-probes.sock");
    resetScoutdProbeClientForTests();

    await gitRevParse({ repoRoot: directory, kind: "verifyCommit", ref: "feature/ref" }, { maxAgeMs: 0 });
    await gitDiffNumstat({
      repoRoot: directory,
      selector: { kind: "range", notation: "ellipsis", baseRef: "origin/main", compareRef: "HEAD" },
      paths: ["src/index.ts", ":(exclude)node_modules/**"],
    });

    const args = loggedArgs(logPath);
    const endOfOptions = args.indexOf("--end-of-options");
    const refValue = args.indexOf("feature/ref^{commit}");
    expect(endOfOptions).toBeGreaterThanOrEqual(0);
    expect(refValue).toBeGreaterThan(endOfOptions);
    const pathSeparator = args.lastIndexOf("--");
    expect(pathSeparator).toBeGreaterThan(args.lastIndexOf("origin/main...HEAD"));
    expect(args.slice(pathSeparator + 1)).toEqual(["src/index.ts", ":(exclude)node_modules/**"]);
  });

  test("rejects option-like refs and pathspecs before git executes", async () => {
    const directory = tempDir("openscout-git-reject-");
    const { gitBin, logPath } = writeGitArgLogger(directory);
    process.env.OPENSCOUT_GIT_BIN = gitBin;
    process.env.OPENSCOUT_PROBES_SOCKET = join(directory, "missing-probes.sock");
    resetScoutdProbeClientForTests();

    const expectRejected = async (run: () => Promise<unknown>) => {
      try {
        await run();
        throw new Error("expected git catalog validation to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(GitCatalogValidationError);
      }
    };

    await expectRejected(() => gitRevParse({
      repoRoot: directory,
      kind: "verifyCommit",
      ref: "-c core.fsmonitor=touch /tmp/x",
    }));
    await expectRejected(() => gitRevParse({
      repoRoot: directory,
      kind: "verifyCommit",
      ref: "--output=/tmp/x",
    }));
    await expectRejected(() => gitDiffNumstat({
      repoRoot: directory,
      selector: { kind: "fromRef", ref: "-leading-dash-branch" },
    }));
    await expectRejected(() => gitDiffNumstat({
      repoRoot: directory,
      selector: { kind: "unstaged" },
      paths: ["--upload-pack=x"],
    }));
    await expectRejected(() => gitDiffNumstat({
      repoRoot: directory,
      selector: { kind: "unstaged" },
      paths: ["-leading-dash-path"],
    }));

    expect(existsSync(logPath) ? readFileSync(logPath, "utf8") : "").toBe("");
  });
});

describeScoutdConformance("scoutd conformance diff harness", () => {
  type GitFixtureMode = "success" | "missing-binary" | "slow_success" | "timeout" | "output_cap";
  // A cold Linux runner can spend more than 40 seconds compiling scoutd before
  // the first fixture starts. Keep the per-fixture bound strict, but leave
  // enough room for that one-time build plus the actual conformance assertion.
  const SCOUTD_CONFORMANCE_TIMEOUT_MS = 90_000;

  function writeGitFixture(directory: string): string {
    const script = join(directory, "git-fixture.sh");
    writeFileSync(script, `#!/bin/sh
repo=""
if [ "$1" = "-C" ]; then
  repo="$2"
  shift 2
fi
mode="\${OPENSCOUT_TEST_GIT_MODE:-success}"
if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then
  printf '%s\\n' "$repo"
  exit 0
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ]; then
  printf 'feedfacecafebeef\\n'
  exit 0
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--short" ]; then
  printf 'abc123\\n'
  exit 0
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--abbrev-ref" ]; then
  printf 'main\\n'
  exit 0
fi
if [ "$1" = "status" ] && [ "$2" = "--porcelain" ]; then
  case "$mode" in
    timeout)
      sleep 3
      printf 'late\\n'
      exit 0
      ;;
    output_cap)
      dd if=/dev/zero bs=300000 count=1 2>/dev/null | tr '\\000' x
      exit 0
      ;;
    *)
      exit 0
      ;;
  esac
fi
if [ "$1" = "status" ] && { [ "$2" = "--porcelain=v1" ] || [ "$2" = "--porcelain=v2" ]; }; then
  case "$mode" in
    slow_success)
      sleep 2.2
      ;;
    timeout)
      sleep 6
      printf 'late\\n'
      exit 0
      ;;
    output_cap)
      dd if=/dev/zero bs=1200000 count=1 2>/dev/null | tr '\\000' x
      exit 0
      ;;
  esac
  if [ "$2" = "--porcelain=v2" ]; then
    printf '# branch.oid abc123\\n# branch.head main\\n1 .M N... 100644 100644 100644 aaa bbb src/index.ts\\n'
    exit 0
  fi
  printf ' M src/index.ts\\n'
  exit 0
fi
if [ "$1" = "diff" ] && [ "$2" = "--shortstat" ]; then
  printf ' 1 file changed, 2 insertions(+), 1 deletion(-)\\n'
  exit 0
fi
if [ "$1" = "merge-base" ] && [ "$2" = "--end-of-options" ]; then
  printf 'merge-base-sha\\n'
  exit 0
fi
if [ "$1" = "log" ] && [ "$2" = "-1" ] && [ "$3" = "--format=%ct" ]; then
  printf '1780460000\\n'
  exit 0
fi
if [ "$1" = "worktree" ] && [ "$2" = "list" ] && [ "$3" = "--porcelain" ]; then
  printf 'worktree %s\\nHEAD abc123\\nbranch refs/heads/main\\n\\n' "$repo"
  exit 0
fi
exit 1
`, "utf8");
    chmodSync(script, 0o755);
    return script;
  }

  function normalizeGitSnapshot(value: any): any {
    if (!value || typeof value !== "object") return value ?? null;
    return {
      ...value,
      metadataAt: 0,
      statusAt: value.statusAt === null ? null : 0,
    };
  }

  function normalizeProbeError(error: any): any {
    if (!error) return null;
    return {
      code: String(error.code ?? "error"),
      timedOut: error.timedOut === true || error.timed_out === true || error.code === "timeout",
    };
  }

  function normalizeLocalSnapshot(snapshot: Awaited<ReturnType<ReturnType<typeof gitBuildInfoProbe.for>["fresh"]>>): any {
    if (snapshot.status === "failed") {
      return {
        status: "failed",
        value: null,
        error: normalizeProbeError(snapshot.error),
      };
    }
    return {
      status: snapshot.status,
      value: normalizeGitSnapshot(snapshot.value),
      error: null,
    };
  }

  function normalizeDaemonSnapshot(response: any): any {
    if (response.error) {
      return {
        status: "failed",
        value: null,
        error: normalizeProbeError(response.error),
      };
    }
    return {
      status: "fresh",
      value: normalizeGitSnapshot(response.value),
      error: null,
    };
  }

  async function runLocalGitFixture(repoRoot: string, gitBin: string): Promise<any> {
    process.env.OPENSCOUT_PROBES_SOCKET = join(repoRoot, "missing-probes.sock");
    process.env.OPENSCOUT_GIT_BIN = gitBin;
    resetScoutdProbeClientForTests();
    resetGitBuildInfoProbeForTests();
    gitBuildInfoProbe.invalidate(repoRoot, "test.conformance.local");
    const snapshot = await gitBuildInfoProbe.for(repoRoot).fresh({ maxAgeMs: 0 });
    return normalizeLocalSnapshot(snapshot);
  }

  async function runLocalGitRevParseFixture(
    directory: string,
    key: Parameters<typeof gitRevParseProbe.for>[0],
    env: Record<string, string | undefined>,
  ): Promise<any> {
    return await withLocalProbeEnv(directory, env, async () => {
      gitRevParseProbe.invalidate(key, "test.conformance.local");
      return normalizeLocalProbeSnapshot(await gitRevParseProbe.for(key).fresh({ maxAgeMs: 0 }));
    });
  }

  async function runLocalGitDiffShortstatFixture(
    directory: string,
    key: Parameters<typeof gitDiffShortstatProbe.for>[0],
    env: Record<string, string | undefined>,
  ): Promise<any> {
    return await withLocalProbeEnv(directory, env, async () => {
      gitDiffShortstatProbe.invalidate(key, "test.conformance.local");
      return normalizeLocalProbeSnapshot(await gitDiffShortstatProbe.for(key).fresh({ maxAgeMs: 0 }));
    });
  }

  async function runLocalGitStatusPorcelainFixture(
    directory: string,
    key: Parameters<typeof gitStatusPorcelainProbe.for>[0],
    env: Record<string, string | undefined>,
  ): Promise<any> {
    return await withLocalProbeEnv(directory, env, async () => {
      gitStatusPorcelainProbe.invalidate(key, "test.conformance.local");
      return normalizeLocalProbeSnapshot(await gitStatusPorcelainProbe.for(key).fresh({ maxAgeMs: 0 }));
    });
  }

  async function runLocalGitMergeBaseFixture(
    directory: string,
    key: Parameters<typeof gitMergeBaseProbe.for>[0],
    env: Record<string, string | undefined>,
  ): Promise<any> {
    return await withLocalProbeEnv(directory, env, async () => {
      gitMergeBaseProbe.invalidate(key, "test.conformance.local");
      return normalizeLocalProbeSnapshot(await gitMergeBaseProbe.for(key).fresh({ maxAgeMs: 0 }));
    });
  }

  async function runLocalGitLogLastCommitUnixFixture(
    directory: string,
    repoRoot: string,
    env: Record<string, string | undefined>,
  ): Promise<any> {
    return await withLocalProbeEnv(directory, env, async () => {
      gitLogLastCommitUnixProbe.invalidate(repoRoot, "test.conformance.local");
      return normalizeLocalProbeSnapshot(await gitLogLastCommitUnixProbe.for(repoRoot).fresh({ maxAgeMs: 0 }));
    });
  }

  async function runLocalGitWorktreeListPorcelainFixture(
    directory: string,
    repoRoot: string,
    env: Record<string, string | undefined>,
  ): Promise<any> {
    return await withLocalProbeEnv(directory, env, async () => {
      gitWorktreeListPorcelainProbe.invalidate(repoRoot, "test.conformance.local");
      return normalizeLocalProbeSnapshot(await gitWorktreeListPorcelainProbe.for(repoRoot).fresh({ maxAgeMs: 0 }));
    });
  }

  async function runDaemonGitFixture(input: {
    repoRoot: string;
    gitBin: string;
    mode: GitFixtureMode;
    directory: string;
  }): Promise<any> {
    const socketPath = join(input.directory, `scoutd-${input.mode}.sock`);
    const server = await startRealScoutdProbeServer({
      socketPath,
      env: {
        OPENSCOUT_HOME: input.directory,
        OPENSCOUT_GIT_BIN: input.gitBin,
        OPENSCOUT_TEST_GIT_MODE: input.mode,
      },
    });
    try {
      const response = await requestProbeSocket(socketPath, {
        schema: "openscout.probe.request/v1",
        schemaVersion: 1,
        probeId: "git.buildInfo",
        key: input.repoRoot,
        maxAgeMs: 0,
      }, 6_000);
      return normalizeDaemonSnapshot(response);
    } finally {
      await server.stop();
    }
  }

  function writePsFixture(directory: string): string {
    const script = join(directory, "ps-fixture.sh");
    writeFileSync(script, `#!/bin/sh
mode="\${OPENSCOUT_TEST_PS_MODE:-success}"
if [ "$1" = "-axo" ] && [ "$2" = "pid=,ppid=,pgid=,tty=,comm=" ]; then
  cat <<'ROWS'
101 1 101 ttys001 /bin/zsh
202 101 101 ?? /usr/bin/node
ROWS
  exit 0
fi
if [ "$1" = "-axo" ] && [ "$2" = "pid=,ppid=,pgid=,tty=,command=" ]; then
  if [ "$mode" = "runtime_long_command" ]; then
    printf '606 202 101 ?? '
    i=0
    while [ "$i" -lt 1100 ]; do
      printf 'x'
      i=$((i + 1))
    done
    printf '\\n'
    exit 0
  fi
  cat <<'ROWS'
101 1 101 ttys001 /bin/zsh -l
202 101 101 ?? /usr/bin/node /Users/you/dev/app.js
ROWS
  exit 0
fi
if [ "$1" = "-axww" ] && [ "$2" = "-o" ] && [ "$3" = "pid=,ppid=,etime=,command=" ]; then
  cat <<'ROWS'
101 1 00:01 /bin/zsh -l
202 101 00:02 /usr/bin/node /Users/you/dev/app.js
303 202 00:03 claude --dangerously-skip-permissions
404 202 00:04 /bin/sh -c echo hello
505 202 00:05 /usr/bin/python3 worker.py
ROWS
  exit 0
fi
exit 64
`, "utf8");
    chmodSync(script, 0o755);
    return script;
  }

  function writeLsofFixture(directory: string): string {
    const script = join(directory, "lsof-fixture.sh");
    writeFileSync(script, `#!/bin/sh
if [ "$1" = "-a" ] && [ "$2" = "-p" ] && [ "$4" = "-d" ] && [ "$5" = "cwd" ] && [ "$6" = "-Fn" ]; then
  printf 'p%s\\n' "$3"
  printf 'n/Users/you/dev/openscout\\n'
  exit 0
fi
if [ "$1" = "-nP" ] && [ "$3" = "-sTCP:LISTEN" ] && [ "$4" = "-Fp" ]; then
  printf 'p4242\\n'
  exit 0
fi
exit 64
`, "utf8");
    chmodSync(script, 0o755);
    return script;
  }

  function writeTmuxFixture(directory: string): string {
    const script = join(directory, "tmux-fixture.sh");
    writeFileSync(script, `#!/bin/sh
mode="\${OPENSCOUT_TEST_TMUX_MODE:-success}"
utf8=0
if [ "$1" = "-u" ]; then
  utf8=1
  shift
fi
if [ "$1" = "-S" ]; then
  shift 2
fi
if [ "$1" = "list-sessions" ]; then
  rows='alpha\\t2\\t1\\t1710000000\\t1710003600\\tzsh\\t/workspace/alpha\\teditor\\tbox.local\\tclaude | fix tests\\nbeta\\t1\\t0\\t\\t\\tnode\\t\\tnode\\tbox.local\\tbox.local\\n'
  # Like tmux for a client without UTF-8: tabs print as "_" unless -u was passed.
  if [ "$utf8" = 1 ]; then
    printf "$rows"
  else
    printf "$rows" | tr '\\t' '_'
  fi
  exit 0
fi
if [ "$1" = "display-message" ]; then
  row='123\\t/dev/ttys003\\t/workspace/project\\n'
  if [ "$utf8" = 1 ]; then
    printf "$row"
  else
    printf "$row" | tr '\\t' '_'
  fi
  exit 0
fi
if [ "$1" = "capture-pane" ]; then
  case "$mode" in
    timeout)
      sleep 2
      printf 'late\\n'
      exit 0
      ;;
    output_cap)
      dd if=/dev/zero bs=10000 count=1 2>/dev/null | tr '\\000' x
      exit 0
      ;;
  esac
  printf 'line one\\nline two\\n'
  exit 0
fi
exit 64
`, "utf8");
    chmodSync(script, 0o755);
    return script;
  }

  function writeZellijFixture(directory: string): string {
    const script = join(directory, "zellij-fixture.sh");
    writeFileSync(script, `#!/bin/sh
if [ "$1" = "list-sessions" ]; then
  printf 'alpha\\n\\033[31mbeta EXITED\\033[0m\\n'
  exit 0
fi
exit 64
`, "utf8");
    chmodSync(script, 0o755);
    return script;
  }

  function writeTailscaleStatusFixture(directory: string): string {
    const fixture = join(directory, "tailscale-status.json");
    writeFileSync(fixture, `{
  "BackendState": "Running",
  "Health": ["healthy enough"],
  "Self": {
    "ID": "self-id",
    "HostName": "workstation",
    "DNSName": "workstation.tailnet.example.",
    "TailscaleIPs": ["100.64.0.10"],
    "Online": true,
    "OS": "macOS"
  },
  "Peer": {
    "peer-z-key": {
      "ID": "peer-z-id",
      "HostName": "zulu",
      "DNSName": "zulu.tailnet.example.",
      "TailscaleIPs": ["100.64.0.20"],
      "Online": true,
      "OS": "linux",
      "Tags": ["tag:dev"]
    },
    "peer-a-key": {
      "ID": "peer-a-id",
      "HostName": "alpha",
      "DNSName": "alpha.tailnet.example.",
      "TailscaleIPs": ["100.64.0.21"],
      "Online": false,
      "OS": "darwin",
      "Tags": ["tag:ops"]
    }
  },
  "CurrentTailnet": {
    "Name": "tailnet.example",
    "MagicDNSSuffix": "tailnet.example"
  }
}
`, "utf8");
    return fixture;
  }

  function tmuxDetailKey(target: string, socketPath = "default"): string {
    return JSON.stringify({ kind: "detail", socketPath, target });
  }

  function tmuxCaptureKey(target: string, socketPath = "default"): string {
    return JSON.stringify({
      kind: "capture",
      socketPath,
      target,
      start: "-20",
      end: "-",
      joinWrapped: true,
      maxBytes: 4096,
    });
  }

  function normalizeProbeSnapshotValue(value: any): any {
    return value === undefined ? null : value;
  }

  function normalizeLocalProbeSnapshot(snapshot: { status: string; value: unknown; error: unknown }): any {
    if (snapshot.status === "failed") {
      return {
        status: "failed",
        value: null,
        error: normalizeProbeError(snapshot.error),
      };
    }
    return {
      status: snapshot.status,
      value: normalizeProbeSnapshotValue(snapshot.value),
      error: null,
    };
  }

  function normalizeDaemonProbeSnapshot(response: any): any {
    if (response.error) {
      return {
        status: "failed",
        value: null,
        error: normalizeProbeError(response.error),
      };
    }
    return {
      status: "fresh",
      value: normalizeProbeSnapshotValue(response.value),
      error: null,
    };
  }

  async function requestDaemonProbe(input: {
    directory: string;
    probeId: string;
    key?: string;
    env: Record<string, string | undefined>;
    opTimeoutMs?: number;
    requestTimeoutMs?: number;
  }): Promise<any> {
    const socketPath = join(input.directory, `scoutd-${input.probeId.replace(/\W/gu, "-")}-${Math.random().toString(36).slice(2)}.sock`);
    const server = await startRealScoutdProbeServer({
      socketPath,
      env: {
        OPENSCOUT_HOME: input.directory,
        ...input.env,
      },
    });
    try {
      const response = await requestProbeSocket(socketPath, {
        schema: "openscout.probe.request/v1",
        schemaVersion: 1,
        probeId: input.probeId,
        key: input.key ?? null,
        maxAgeMs: 0,
        opTimeoutMs: input.opTimeoutMs,
      }, input.requestTimeoutMs ?? 6_000);
      return normalizeDaemonProbeSnapshot(response);
    } finally {
      await server.stop();
    }
  }

  async function withLocalProbeEnv<T>(
    directory: string,
    env: Record<string, string | undefined>,
    run: () => Promise<T>,
  ): Promise<T> {
    const previousSocket = process.env.OPENSCOUT_PROBES_SOCKET;
    const previous = new Map<string, string | undefined>();
    for (const key of Object.keys(env)) {
      previous.set(key, process.env[key]);
    }
    process.env.OPENSCOUT_PROBES_SOCKET = join(directory, "missing-probes.sock");
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    resetScoutdProbeClientForTests();
    try {
      return await run();
    } finally {
      if (previousSocket === undefined) {
        delete process.env.OPENSCOUT_PROBES_SOCKET;
      } else {
        process.env.OPENSCOUT_PROBES_SOCKET = previousSocket;
      }
      for (const [key, value] of previous) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      resetScoutdProbeClientForTests();
    }
  }

  async function runLocalPsRuntimeFixture(directory: string, env: Record<string, string | undefined>): Promise<any> {
    return await withLocalProbeEnv(directory, env, async () => {
      psRuntimeProbe.invalidate("test.conformance.local");
      return normalizeLocalProbeSnapshot(await psRuntimeProbe.fresh({ maxAgeMs: 0 }));
    });
  }

  async function runLocalPsDiscoveryFixture(directory: string, env: Record<string, string | undefined>): Promise<any> {
    return await withLocalProbeEnv(directory, env, async () => {
      psDiscoveryProbe.invalidate("test.conformance.local");
      return normalizeLocalProbeSnapshot(await psDiscoveryProbe.fresh({ maxAgeMs: 0 }));
    });
  }

  async function runLocalPsCwdFixture(directory: string, pid: number, env: Record<string, string | undefined>): Promise<any> {
    return await withLocalProbeEnv(directory, env, async () => {
      processCwdProbe.invalidate(pid, "test.conformance.local");
      return normalizeLocalProbeSnapshot(await processCwdProbe.for(pid).fresh({ maxAgeMs: 0 }));
    });
  }

  async function runLocalNetListenerFixture(directory: string, port: number, env: Record<string, string | undefined>): Promise<any> {
    return await withLocalProbeEnv(directory, env, async () => {
      netListenersProbe.invalidate(port, "test.conformance.local");
      return normalizeLocalProbeSnapshot(await netListenersProbe.for(port).fresh({ maxAgeMs: 0 }));
    });
  }

  async function runLocalTmuxSessionsFixture(directory: string, socketPath: string, env: Record<string, string | undefined>): Promise<any> {
    return await withLocalProbeEnv(directory, env, async () => {
      tmuxSessionsProbe.invalidate(socketPath, "test.conformance.local");
      return normalizeLocalProbeSnapshot(await tmuxSessionsProbe.for(socketPath).fresh({ maxAgeMs: 0 }));
    });
  }

  async function runLocalTmuxPaneFixture(
    directory: string,
    paneKey: Parameters<typeof tmuxPanesProbe.for>[0],
    env: Record<string, string | undefined>,
  ): Promise<any> {
    return await withLocalProbeEnv(directory, env, async () => {
      tmuxPanesProbe.invalidate(paneKey, "test.conformance.local");
      return normalizeLocalProbeSnapshot(await tmuxPanesProbe.for(paneKey).fresh({ maxAgeMs: 0 }));
    });
  }

  async function runLocalZellijSessionsFixture(directory: string, socketDir: string, env: Record<string, string | undefined>): Promise<any> {
    return await withLocalProbeEnv(directory, env, async () => {
      zellijSessionsProbe.invalidate(socketDir, "test.conformance.local");
      return normalizeLocalProbeSnapshot(await zellijSessionsProbe.for(socketDir).fresh({ maxAgeMs: 0 }));
    });
  }

  async function runLocalTailscaleStatusFixture(directory: string, env: Record<string, string | undefined>): Promise<any> {
    return await withLocalProbeEnv(directory, env, async () => {
      tailscaleStatusProbe.invalidate("test.conformance.local");
      return normalizeLocalProbeSnapshot(await tailscaleStatusProbe.fresh({ maxAgeMs: 0 }));
    });
  }

  for (const mode of ["success", "missing-binary", "timeout", "output_cap"] as const) {
    test(`git.buildInfo ${mode} fixture matches between scoutd and the TS local twin`, async () => {
      const directory = shortTempDir(`oscd-${mode}`);
      const repoRoot = join(directory, "repo");
      const gitFixture = writeGitFixture(directory);
      writeFileSync(join(directory, "repo-placeholder"), "x", "utf8");
      const gitBin = mode === "missing-binary" ? join(directory, "missing-git") : gitFixture;
      mkdirSync(repoRoot);

      process.env.OPENSCOUT_TEST_GIT_MODE = mode;
      const [daemon, local] = await Promise.all([
        runDaemonGitFixture({ repoRoot, gitBin, mode, directory }),
        runLocalGitFixture(repoRoot, gitBin),
      ]);

      expect(daemon).toEqual(local);
      if (mode === "timeout") {
        expect(daemon.error).toEqual({ code: "timeout", timedOut: true });
      }
      if (mode === "output_cap") {
        expect(daemon.error).toEqual({ code: "output_cap", timedOut: false });
      }
      if (mode === "missing-binary") {
        expect(daemon).toMatchObject({
          status: "fresh",
          value: {
            commit: null,
            bootBranch: null,
            branch: null,
            dirty: null,
          },
          error: null,
        });
      }
    }, SCOUTD_CONFORMANCE_TIMEOUT_MS);
  }

  test("git.revParse fixture matches between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-gitrp");
    const repoRoot = join(directory, "repo");
    mkdirSync(repoRoot);
    const gitBin = writeGitFixture(directory);
    const env = { OPENSCOUT_GIT_BIN: gitBin };
    const key = { repoRoot, kind: "verifyCommit" as const, ref: "HEAD" };

    const [daemon, local] = await Promise.all([
      requestDaemonProbe({ directory, probeId: "git.revParse", key: JSON.stringify(key), env }),
      runLocalGitRevParseFixture(directory, key, env),
    ]);

    expect(daemon).toEqual(local);
    expect(daemon.value).toBe("feedfacecafebeef");
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("git.diffShortstat fixture matches between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-gitds");
    const repoRoot = join(directory, "repo");
    mkdirSync(repoRoot);
    const gitBin = writeGitFixture(directory);
    const env = { OPENSCOUT_GIT_BIN: gitBin };
    const key = {
      repoRoot,
      selector: { kind: "range" as const, notation: "dotdot" as const, baseRef: "base-sha", compareRef: "HEAD" },
      paths: ["src/index.ts"],
    };

    const [daemon, local] = await Promise.all([
      requestDaemonProbe({ directory, probeId: "git.diffShortstat", key: JSON.stringify(key), env }),
      runLocalGitDiffShortstatFixture(directory, key, env),
    ]);

    expect(daemon).toEqual(local);
    expect(daemon.value).toBe("1 file changed, 2 insertions(+), 1 deletion(-)");
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("git.statusPorcelain fixture matches between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-gitst");
    const repoRoot = join(directory, "repo");
    mkdirSync(repoRoot);
    const gitBin = writeGitFixture(directory);
    const env = { OPENSCOUT_GIT_BIN: gitBin };
    const key = {
      repoRoot,
      version: "v2" as const,
      branch: true,
      untrackedMode: "normal" as const,
      paths: ["src/index.ts"],
    };

    const [daemon, local] = await Promise.all([
      requestDaemonProbe({ directory, probeId: "git.statusPorcelain", key: JSON.stringify(key), env }),
      runLocalGitStatusPorcelainFixture(directory, key, env),
    ]);

    expect(daemon).toEqual(local);
    expect(daemon.value).toBe("# branch.oid abc123\n# branch.head main\n1 .M N... 100644 100644 100644 aaa bbb src/index.ts\n");
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("git.statusPorcelain slow fixture succeeds through scoutd within the TS op budget", async () => {
    const directory = shortTempDir("oscd-gitstslow");
    const repoRoot = join(directory, "repo");
    mkdirSync(repoRoot);
    const gitBin = writeGitFixture(directory);
    const env = {
      OPENSCOUT_GIT_BIN: gitBin,
      OPENSCOUT_TEST_GIT_MODE: "slow_success",
    };
    const key = {
      repoRoot,
      version: "v2" as const,
      branch: true,
      untrackedMode: "normal" as const,
      paths: ["src/index.ts"],
    };

    const [daemon, local] = await Promise.all([
      requestDaemonProbe({
        directory,
        probeId: "git.statusPorcelain",
        key: JSON.stringify(key),
        env,
        opTimeoutMs: 5_000,
        requestTimeoutMs: 7_000,
      }),
      runLocalGitStatusPorcelainFixture(directory, key, env),
    ]);

    expect(daemon).toEqual(local);
    expect(daemon.status).toBe("fresh");
    expect(daemon.value).toContain("# branch.head main");
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("git.statusPorcelain timeout fixture matches between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-gitsttimeout");
    const repoRoot = join(directory, "repo");
    mkdirSync(repoRoot);
    const gitBin = writeGitFixture(directory);
    const env = {
      OPENSCOUT_GIT_BIN: gitBin,
      OPENSCOUT_TEST_GIT_MODE: "timeout",
    };
    const key = { repoRoot, version: "v1" as const };

    const [daemon, local] = await Promise.all([
      requestDaemonProbe({
        directory,
        probeId: "git.statusPorcelain",
        key: JSON.stringify(key),
        env,
        opTimeoutMs: 5_000,
        requestTimeoutMs: 8_000,
      }),
      runLocalGitStatusPorcelainFixture(directory, key, env),
    ]);

    expect(daemon).toEqual(local);
    expect(daemon.error).toEqual({ code: "timeout", timedOut: true });
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("git.statusPorcelain output-cap fixture matches between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-gitstcap");
    const repoRoot = join(directory, "repo");
    mkdirSync(repoRoot);
    const gitBin = writeGitFixture(directory);
    const env = {
      OPENSCOUT_GIT_BIN: gitBin,
      OPENSCOUT_TEST_GIT_MODE: "output_cap",
    };
    const key = { repoRoot, version: "v1" as const };

    const [daemon, local] = await Promise.all([
      requestDaemonProbe({
        directory,
        probeId: "git.statusPorcelain",
        key: JSON.stringify(key),
        env,
        opTimeoutMs: 5_000,
        requestTimeoutMs: 7_000,
      }),
      runLocalGitStatusPorcelainFixture(directory, key, env),
    ]);

    expect(daemon).toEqual(local);
    expect(daemon.error).toEqual({ code: "output_cap", timedOut: false });
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("git.mergeBase fixture matches between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-gitmb");
    const repoRoot = join(directory, "repo");
    mkdirSync(repoRoot);
    const gitBin = writeGitFixture(directory);
    const env = { OPENSCOUT_GIT_BIN: gitBin };
    const key = { repoRoot, baseRef: "base-sha", compareRef: "HEAD" };

    const [daemon, local] = await Promise.all([
      requestDaemonProbe({ directory, probeId: "git.mergeBase", key: JSON.stringify(key), env }),
      runLocalGitMergeBaseFixture(directory, key, env),
    ]);

    expect(daemon).toEqual(local);
    expect(daemon.value).toBe("merge-base-sha");
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("git.logLastCommitUnix fixture matches between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-gitlog");
    const repoRoot = join(directory, "repo");
    mkdirSync(repoRoot);
    const gitBin = writeGitFixture(directory);
    const env = { OPENSCOUT_GIT_BIN: gitBin };

    const [daemon, local] = await Promise.all([
      requestDaemonProbe({ directory, probeId: "git.logLastCommitUnix", key: repoRoot, env }),
      runLocalGitLogLastCommitUnixFixture(directory, repoRoot, env),
    ]);

    expect(daemon).toEqual(local);
    expect(daemon.value).toBe("1780460000");
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("git.worktreeListPorcelain fixture matches between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-gitwt");
    const repoRoot = join(directory, "repo");
    mkdirSync(repoRoot);
    const gitBin = writeGitFixture(directory);
    const env = { OPENSCOUT_GIT_BIN: gitBin };

    const [daemon, local] = await Promise.all([
      requestDaemonProbe({ directory, probeId: "git.worktreeListPorcelain", key: repoRoot, env }),
      runLocalGitWorktreeListPorcelainFixture(directory, repoRoot, env),
    ]);

    expect(daemon).toEqual(local);
    expect(daemon.value).toBe(`worktree ${realpathSync(repoRoot)}\nHEAD abc123\nbranch refs/heads/main\n\n`);
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("git catalog missing-binary fixtures match between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-gitmiss");
    const repoRoot = join(directory, "repo");
    mkdirSync(repoRoot);
    const env = { OPENSCOUT_GIT_BIN: join(directory, "missing-git") };
    const revParseKey = { repoRoot, kind: "showToplevel" as const };
    const diffShortstatKey = { repoRoot, selector: { kind: "unstaged" as const } };
    const statusKey = { repoRoot, version: "v1" as const };
    const mergeBaseKey = { repoRoot, baseRef: "base-sha", compareRef: "HEAD" };

    const [
      revDaemon,
      revLocal,
      diffDaemon,
      diffLocal,
      statusDaemon,
      statusLocal,
      mergeDaemon,
      mergeLocal,
      logDaemon,
      logLocal,
      worktreeDaemon,
      worktreeLocal,
    ] = await Promise.all([
      requestDaemonProbe({ directory, probeId: "git.revParse", key: JSON.stringify(revParseKey), env }),
      runLocalGitRevParseFixture(directory, revParseKey, env),
      requestDaemonProbe({ directory, probeId: "git.diffShortstat", key: JSON.stringify(diffShortstatKey), env }),
      runLocalGitDiffShortstatFixture(directory, diffShortstatKey, env),
      requestDaemonProbe({ directory, probeId: "git.statusPorcelain", key: JSON.stringify(statusKey), env }),
      runLocalGitStatusPorcelainFixture(directory, statusKey, env),
      requestDaemonProbe({ directory, probeId: "git.mergeBase", key: JSON.stringify(mergeBaseKey), env }),
      runLocalGitMergeBaseFixture(directory, mergeBaseKey, env),
      requestDaemonProbe({ directory, probeId: "git.logLastCommitUnix", key: repoRoot, env }),
      runLocalGitLogLastCommitUnixFixture(directory, repoRoot, env),
      requestDaemonProbe({ directory, probeId: "git.worktreeListPorcelain", key: repoRoot, env }),
      runLocalGitWorktreeListPorcelainFixture(directory, repoRoot, env),
    ]);

    expect(revDaemon).toEqual(revLocal);
    expect(revDaemon.value).toBeNull();
    expect(diffDaemon).toEqual(diffLocal);
    expect(diffDaemon.value).toBeNull();
    expect(statusDaemon).toEqual(statusLocal);
    expect(statusDaemon.value).toBeNull();
    expect(mergeDaemon).toEqual(mergeLocal);
    expect(mergeDaemon.value).toBeNull();
    expect(logDaemon).toEqual(logLocal);
    expect(logDaemon.value).toBeNull();
    expect(worktreeDaemon).toEqual(worktreeLocal);
    expect(worktreeDaemon.value).toBeNull();
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("git recurring daemon probes reject option-like merge refs and status pathspecs", async () => {
    const directory = shortTempDir("oscd-gitsec");
    const repoRoot = join(directory, "repo");
    mkdirSync(repoRoot);
    const gitBin = writeGitFixture(directory);
    const env = { OPENSCOUT_GIT_BIN: gitBin };
    const invalidMergeKey = { repoRoot, baseRef: "-c core.fsmonitor=touch /tmp/x", compareRef: "HEAD" };
    const invalidStatusKey = { repoRoot, version: "v1" as const, paths: ["--upload-pack=x"] };

    const [mergeDaemon, statusDaemon] = await Promise.all([
      requestDaemonProbe({ directory, probeId: "git.mergeBase", key: JSON.stringify(invalidMergeKey), env }),
      requestDaemonProbe({ directory, probeId: "git.statusPorcelain", key: JSON.stringify(invalidStatusKey), env }),
    ]);
    let mergeLocalError: unknown = null;
    try {
      await runLocalGitMergeBaseFixture(directory, invalidMergeKey, env);
    } catch (error) {
      mergeLocalError = error;
    }
    let statusLocalError: unknown = null;
    try {
      await runLocalGitStatusPorcelainFixture(directory, invalidStatusKey, env);
    } catch (error) {
      statusLocalError = error;
    }

    expect(mergeDaemon.status).toBe("failed");
    expect(mergeDaemon.error.code).toBe("invalid_request");
    expect(mergeLocalError).toBeInstanceOf(GitCatalogValidationError);
    expect(statusDaemon.status).toBe("failed");
    expect(statusDaemon.error.code).toBe("invalid_request");
    expect(statusLocalError).toBeInstanceOf(GitCatalogValidationError);
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("tailscale.status preserves JSON peer order between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-tsok");
    const fixturePath = writeTailscaleStatusFixture(directory);
    const env = { OPENSCOUT_TAILSCALE_STATUS_JSON: fixturePath };

    const [daemon, local] = await Promise.all([
      requestDaemonProbe({ directory, probeId: "tailscale.status", env }),
      runLocalTailscaleStatusFixture(directory, env),
    ]);

    expect(daemon).toEqual(local);
    expect(daemon.value.peers.map((peer: any) => peer.id)).toEqual(["peer-z-id", "peer-a-id"]);
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("tailscale.status missing-binary fixture matches between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-tsmiss");
    const env = {
      OPENSCOUT_TAILSCALE_BIN: join(directory, "missing-tailscale"),
      OPENSCOUT_TAILSCALE_STATUS_JSON: undefined,
    };

    const [daemon, local] = await Promise.all([
      requestDaemonProbe({ directory, probeId: "tailscale.status", env }),
      runLocalTailscaleStatusFixture(directory, env),
    ]);

    expect(daemon).toEqual(local);
    expect(daemon.value).toBeNull();
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("ps.runtime fixture matches between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-psrt");
    const psBin = writePsFixture(directory);
    const env = { OPENSCOUT_PS_BIN: psBin };

    const [daemon, local] = await Promise.all([
      requestDaemonProbe({ directory, probeId: "ps.runtime", env }),
      runLocalPsRuntimeFixture(directory, env),
    ]);

    expect(daemon).toEqual(local);
    expect(daemon.value.rows).toEqual([
      { pid: 101, ppid: 1, pgid: 101, tty: "ttys001", comm: "/bin/zsh" },
      { pid: 202, ppid: 101, pgid: 101, tty: null, comm: "/usr/bin/node" },
    ]);
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("ps.runtime command truncation fixture matches between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-psrttrunc");
    const psBin = writePsFixture(directory);
    const env = {
      OPENSCOUT_PS_BIN: psBin,
      OPENSCOUT_TEST_PS_MODE: "runtime_long_command",
    };

    const [daemon, local] = await Promise.all([
      requestDaemonProbe({ directory, probeId: "ps.runtime", env }),
      runLocalPsRuntimeFixture(directory, env),
    ]);

    expect(daemon).toEqual(local);
    expect(daemon.value.commandRows[0].command.length).toBe(1024);
    expect(daemon.value.commandRows[0].comm.length).toBe(1024);
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("ps.discovery truncation fixture matches between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-psdisc");
    const psBin = writePsFixture(directory);
    const env = {
      OPENSCOUT_PS_BIN: psBin,
      OPENSCOUT_PS_DISCOVERY_MAX_ROWS: "3",
    };

    const [daemon, local] = await Promise.all([
      requestDaemonProbe({ directory, probeId: "ps.discovery", env }),
      runLocalPsDiscoveryFixture(directory, env),
    ]);

    expect(daemon).toEqual(local);
    expect(daemon.value).toMatchObject({
      truncated: true,
      totalCount: 5,
      returnedCount: 3,
    });
    expect(daemon.value.rows.map((row: any) => row.pid)).toEqual([101, 202, 303]);
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("ps probes missing-binary fixtures match between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-psmiss");
    const env = { OPENSCOUT_PS_BIN: join(directory, "missing-ps") };

    const [runtimeDaemon, runtimeLocal, discoveryDaemon, discoveryLocal] = await Promise.all([
      requestDaemonProbe({ directory, probeId: "ps.runtime", env }),
      runLocalPsRuntimeFixture(directory, env),
      requestDaemonProbe({ directory, probeId: "ps.discovery", env }),
      runLocalPsDiscoveryFixture(directory, env),
    ]);

    expect(runtimeDaemon).toEqual(runtimeLocal);
    expect(runtimeDaemon.value).toEqual({ rows: [], commandRows: [] });
    expect(discoveryDaemon).toEqual(discoveryLocal);
    expect(discoveryDaemon.value).toEqual({
      rows: [],
      truncated: false,
      totalCount: 0,
      returnedCount: 0,
    });
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("ps.cwd fixture matches between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-pscwd");
    const lsofBin = writeLsofFixture(directory);
    const env = { OPENSCOUT_LSOF_BIN: lsofBin };

    const [daemon, local] = await Promise.all([
      requestDaemonProbe({ directory, probeId: "ps.cwd", key: "202", env }),
      runLocalPsCwdFixture(directory, 202, env),
    ]);

    expect(daemon).toEqual(local);
    expect(daemon.value).toBe("/Users/you/dev/openscout");
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("net.listeners fixture matches between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-net");
    const lsofBin = writeLsofFixture(directory);
    const env = { OPENSCOUT_LSOF_BIN: lsofBin };

    const [daemon, local] = await Promise.all([
      requestDaemonProbe({ directory, probeId: "net.listeners", key: "5173", env }),
      runLocalNetListenerFixture(directory, 5173, env),
    ]);

    expect(daemon).toEqual(local);
    expect(daemon.value).toEqual({ port: 5173, pid: 4242 });
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("ps.cwd and net.listeners missing-binary fixtures match between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-lsofmiss");
    const env = { OPENSCOUT_LSOF_BIN: join(directory, "missing-lsof") };

    const [cwdDaemon, cwdLocal, netDaemon, netLocal] = await Promise.all([
      requestDaemonProbe({ directory, probeId: "ps.cwd", key: "202", env }),
      runLocalPsCwdFixture(directory, 202, env),
      requestDaemonProbe({ directory, probeId: "net.listeners", key: "5173", env }),
      runLocalNetListenerFixture(directory, 5173, env),
    ]);

    expect(cwdDaemon).toEqual(cwdLocal);
    expect(cwdDaemon.value).toBeNull();
    expect(netDaemon).toEqual(netLocal);
    expect(netDaemon.value).toEqual({ port: 5173, pid: null });
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("tmux.sessions fixture matches between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-tmuxs");
    const tmuxBin = writeTmuxFixture(directory);
    const env = { OPENSCOUT_TMUX_BIN: tmuxBin };

    const [daemon, local] = await Promise.all([
      requestDaemonProbe({ directory, probeId: "tmux.sessions", key: "default", env }),
      runLocalTmuxSessionsFixture(directory, "default", env),
    ]);

    expect(daemon).toEqual(local);
    expect(daemon.value).toEqual([
      {
        name: "alpha",
        windows: 2,
        attached: 1,
        createdAt: 1710000000,
        activityAt: 1710003600,
        currentCommand: "zsh",
        currentPath: "/workspace/alpha",
        windowName: "editor",
        paneTitle: "claude | fix tests",
      },
      {
        name: "beta",
        windows: 1,
        attached: 0,
        createdAt: null,
        activityAt: null,
        currentCommand: "node",
        currentPath: null,
        windowName: "node",
        paneTitle: null,
      },
    ]);
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("tmux.panes detail fixture matches between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-tmuxp");
    const tmuxBin = writeTmuxFixture(directory);
    const env = { OPENSCOUT_TMUX_BIN: tmuxBin };
    const paneKey = { kind: "detail" as const, target: "%1" };

    const [daemon, local] = await Promise.all([
      requestDaemonProbe({ directory, probeId: "tmux.panes", key: tmuxDetailKey("%1"), env }),
      runLocalTmuxPaneFixture(directory, paneKey, env),
    ]);

    expect(daemon).toEqual(local);
    expect(daemon.value).toEqual({
      panePid: 123,
      paneTty: "ttys003",
      paneCurrentPath: "/workspace/project",
    });
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("tmux.panes capture fixture matches between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-tmuxc");
    const tmuxBin = writeTmuxFixture(directory);
    const env = { OPENSCOUT_TMUX_BIN: tmuxBin };
    const paneKey = {
      kind: "capture" as const,
      target: "%timeout",
      start: "-20",
      end: "-",
      joinWrapped: true,
      maxBytes: 4096,
    };

    const [daemon, local] = await Promise.all([
      requestDaemonProbe({ directory, probeId: "tmux.panes", key: tmuxCaptureKey("%1"), env }),
      runLocalTmuxPaneFixture(directory, paneKey, env),
    ]);

    expect(daemon).toEqual(local);
    expect(daemon.value).toEqual({ body: "line one\nline two\n" });
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("tmux.panes capture timeout fixture matches between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-tmuxtimeout");
    const tmuxBin = writeTmuxFixture(directory);
    const env = {
      OPENSCOUT_TMUX_BIN: tmuxBin,
      OPENSCOUT_TEST_TMUX_MODE: "timeout",
    };
    const paneKey = {
      kind: "capture" as const,
      target: "%1",
      start: "-20",
      end: "-",
      joinWrapped: true,
      maxBytes: 4096,
    };

    const [daemon, local] = await Promise.all([
      requestDaemonProbe({
        directory,
        probeId: "tmux.panes",
        key: tmuxCaptureKey("%timeout"),
        env,
        opTimeoutMs: 1_500,
        requestTimeoutMs: 4_000,
      }),
      runLocalTmuxPaneFixture(directory, paneKey, env),
    ]);

    expect(daemon).toEqual(local);
    expect(daemon.error).toEqual({ code: "timeout", timedOut: true });
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("tmux.panes capture output-cap fixture matches between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-tmuxcap");
    const tmuxBin = writeTmuxFixture(directory);
    const env = {
      OPENSCOUT_TMUX_BIN: tmuxBin,
      OPENSCOUT_TEST_TMUX_MODE: "output_cap",
    };
    const paneKey = {
      kind: "capture" as const,
      target: "%cap",
      start: "-20",
      end: "-",
      joinWrapped: true,
      maxBytes: 4096,
    };

    const [daemon, local] = await Promise.all([
      requestDaemonProbe({
        directory,
        probeId: "tmux.panes",
        key: tmuxCaptureKey("%cap"),
        env,
        opTimeoutMs: 1_500,
        requestTimeoutMs: 4_000,
      }),
      runLocalTmuxPaneFixture(directory, paneKey, env),
    ]);

    expect(daemon).toEqual(local);
    expect(daemon.error).toEqual({ code: "output_cap", timedOut: false });
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("tmux read probes missing-binary fixtures match between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-tmuxmiss");
    const env = { OPENSCOUT_TMUX_BIN: join(directory, "missing-tmux") };
    const paneKey = { kind: "detail" as const, target: "%1" };

    const [sessionsDaemon, sessionsLocal, paneDaemon, paneLocal] = await Promise.all([
      requestDaemonProbe({ directory, probeId: "tmux.sessions", key: "default", env }),
      runLocalTmuxSessionsFixture(directory, "default", env),
      requestDaemonProbe({ directory, probeId: "tmux.panes", key: tmuxDetailKey("%1"), env }),
      runLocalTmuxPaneFixture(directory, paneKey, env),
    ]);

    expect(sessionsDaemon).toEqual(sessionsLocal);
    expect(sessionsDaemon.value).toEqual([]);
    expect(paneDaemon).toEqual(paneLocal);
    expect(paneDaemon.value).toBeNull();
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("zellij.sessions fixture matches between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-zellij");
    const zellijBin = writeZellijFixture(directory);
    const socketDir = join(directory, "zellij-sockets");
    mkdirSync(socketDir, { recursive: true });
    const env = { OPENSCOUT_ZELLIJ_BIN: zellijBin };

    const [daemon, local] = await Promise.all([
      requestDaemonProbe({ directory, probeId: "zellij.sessions", key: socketDir, env }),
      runLocalZellijSessionsFixture(directory, socketDir, env),
    ]);

    expect(daemon).toEqual(local);
    expect(daemon.value).toEqual([
      { name: "alpha", state: "live", raw: "alpha" },
      { name: "beta", state: "exited", raw: "beta EXITED" },
    ]);
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);

  test("zellij.sessions missing-binary fixture matches between scoutd and the TS local twin", async () => {
    const directory = shortTempDir("oscd-zelmiss");
    const socketDir = join(directory, "zellij-sockets");
    const env = { OPENSCOUT_ZELLIJ_BIN: join(directory, "missing-zellij") };

    const [daemon, local] = await Promise.all([
      requestDaemonProbe({ directory, probeId: "zellij.sessions", key: socketDir, env }),
      runLocalZellijSessionsFixture(directory, socketDir, env),
    ]);

    expect(daemon).toEqual(local);
    expect(daemon.value).toEqual([]);
  }, SCOUTD_CONFORMANCE_TIMEOUT_MS);
});
