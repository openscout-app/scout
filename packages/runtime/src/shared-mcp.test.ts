import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveOpenScoutInstanceLayout } from "./instance.js";
import {
  createSharedMcpSupervisor,
  drainSharedMcpOptIn,
  liveSharedMcpClients,
  readSharedMcpOptIn,
  registerSharedMcpClient,
  removeSharedMcpOptIn,
  resolveSharedMcpCommand,
  sharedMcpLaunchEnvironment,
  sharedMcpOptInPath,
  sharedMcpPort,
  settleSharedMcpOptIn,
  sharedMcpClientsDirectory,
  SHARED_MCP_DRAIN_GRACE_MS,
  SHARED_MCP_MAX_RESTART_MS,
  SHARED_MCP_STABLE_AFTER_MS,
  writeSharedMcpOptIn,
} from "./shared-mcp.js";

describe("shared MCP opt-in", () => {
  test("round-trips, and feeds the launch environment only while it exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-shared-mcp-"));
    expect(readSharedMcpOptIn(dir)).toBeNull();
    expect(sharedMcpLaunchEnvironment(dir)).toEqual({});

    writeSharedMcpOptIn(dir, 43115, 7);
    expect(readSharedMcpOptIn(dir)).toEqual({
      url: "http://127.0.0.1:43115/mcp", port: 43115, enabledAt: 7, state: "on",
    });
    expect(sharedMcpLaunchEnvironment(dir)).toEqual({
      OPENSCOUT_MCP_SHARED_URL: "http://127.0.0.1:43115/mcp",
      OPENSCOUT_MCP_SHARED_CLIENTS_DIR: join(dir, "shared-mcp-clients"),
    });

    expect(removeSharedMcpOptIn(dir)).toBe(true);
    expect(removeSharedMcpOptIn(dir)).toBe(false);
    expect(sharedMcpLaunchEnvironment(dir)).toEqual({});
  });

  test("an unreadable or portless file counts as off", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-shared-mcp-"));
    writeFileSync(sharedMcpOptInPath(dir), "{not json");
    expect(readSharedMcpOptIn(dir)).toBeNull();
    writeFileSync(sharedMcpOptInPath(dir), JSON.stringify({ port: "43115" }));
    expect(readSharedMcpOptIn(dir)).toBeNull();
  });

  test("the port follows the instance: 43115 on the main instance, offset in a dev block", () => {
    const home = mkdtempSync(join(tmpdir(), "scout-shared-mcp-home-"));
    expect(sharedMcpPort({ HOME: home })).toBe(43115);
    const env = { HOME: home, OPENSCOUT_INSTANCE: "dev1" };
    const dev = sharedMcpPort(env);
    expect(dev).not.toBe(43115);
    expect(dev - deriveOpenScoutInstanceLayout({ env }).ports.broker).toBe(5);
  });
});

describe("draining the shared server", () => {
  const alive = (pids: number[]) => (pid: number) => pids.includes(pid);
  const clients = (dir: string) => sharedMcpClientsDirectory(dir);

  test("registered clients are listed while alive, and exited ones are cleared", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-shared-mcp-"));
    expect(liveSharedMcpClients(dir)).toEqual([]);
    registerSharedMcpClient(clients(dir), 300);
    registerSharedMcpClient(clients(dir), 200);
    writeFileSync(join(clients(dir), "not-a-pid"), "");
    expect(liveSharedMcpClients(dir, alive([200, 300]))).toEqual([200, 300]);
    expect(liveSharedMcpClients(dir, alive([300]))).toEqual([300]);
    expect(readdirSync(clients(dir))).toEqual(["300"]);
  });

  test("off for new launches at once, removed only when no registered client is alive", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-shared-mcp-"));
    expect(drainSharedMcpOptIn(dir)).toBe(false);
    writeSharedMcpOptIn(dir, 43115);
    registerSharedMcpClient(clients(dir), 200);
    expect(settleSharedMcpOptIn(dir, { isAlive: alive([200]) })?.state).toBe("on");

    expect(drainSharedMcpOptIn(dir, 1_000)).toBe(true);
    expect(sharedMcpLaunchEnvironment(dir)).toEqual({});
    const later = () => 1_000 + SHARED_MCP_DRAIN_GRACE_MS;
    // Whether or not the server is up, a live registered client keeps the drain going.
    expect(settleSharedMcpOptIn(dir, { isAlive: alive([200]), now: later })?.state).toBe("draining");

    let drained = false;
    expect(settleSharedMcpOptIn(dir, { isAlive: alive([]), now: later, log: () => { drained = true; } })).toBeNull();
    expect(readSharedMcpOptIn(dir)).toBeNull();
    expect(drained).toBe(true);
  });

  test("a drain with no client left still waits out the grace, for launches that have not registered yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-shared-mcp-"));
    writeSharedMcpOptIn(dir, 43115);
    drainSharedMcpOptIn(dir, 1_000);
    expect(readSharedMcpOptIn(dir)).toMatchObject({ state: "draining", drainingSince: 1_000 });
    const at = (ms: number) => ({ isAlive: alive([]), now: () => ms });
    expect(settleSharedMcpOptIn(dir, at(1_000 + SHARED_MCP_DRAIN_GRACE_MS - 1))?.state).toBe("draining");
    // A second drain does not restart the grace.
    drainSharedMcpOptIn(dir, 9_000);
    expect(readSharedMcpOptIn(dir)?.drainingSince).toBe(1_000);
    expect(settleSharedMcpOptIn(dir, at(1_000 + SHARED_MCP_DRAIN_GRACE_MS))).toBeNull();
  });

  test("a re-enable that lands while the clients are listed wins over the drain", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-shared-mcp-"));
    writeSharedMcpOptIn(dir, 43115);
    drainSharedMcpOptIn(dir, 1_000);
    registerSharedMcpClient(clients(dir), 200);
    const reenableWhileListing = () => {
      writeSharedMcpOptIn(dir, 43115);
      return false;
    };
    expect(settleSharedMcpOptIn(dir, { isAlive: reenableWhileListing, now: () => 1_000 + SHARED_MCP_DRAIN_GRACE_MS })?.state).toBe("on");
    expect(readSharedMcpOptIn(dir)?.state).toBe("on");
  });

  test("an opt-in that is on is never removed, even with no clients", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-shared-mcp-"));
    writeSharedMcpOptIn(dir, 43115);
    expect(settleSharedMcpOptIn(dir, { isAlive: alive([]) })?.state).toBe("on");
  });

  test("turning it back on while draining keeps the start time and selected profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-shared-mcp-"));
    writeSharedMcpOptIn(dir, { port: 43115, profile: "work" }, 5);
    drainSharedMcpOptIn(dir);
    writeSharedMcpOptIn(dir, 43115, 9);
    expect(readSharedMcpOptIn(dir)).toEqual({ url: "http://127.0.0.1:43115/mcp", port: 43115, profile: "work", enabledAt: 5, state: "on" });
  });
});

describe("resolveSharedMcpCommand", () => {
  const base = { port: 43115, bunExecutable: "/bin/bun", repoRoot: "/repo", runtimePackageDir: "/pkg/runtime", env: {} };
  const serve = ["mcp", "serve", "--host", "127.0.0.1", "--port", "43115"];

  test("prefers an explicit CLI, then the checkout's CLI, then the packaged one", () => {
    expect(resolveSharedMcpCommand({ ...base, env: { OPENSCOUT_CLI_BIN: "/opt/scout" }, exists: () => true }))
      .toEqual({ command: "/opt/scout", args: serve, cwd: "/pkg/runtime" });
    expect(resolveSharedMcpCommand({ ...base, exists: () => true }))
      .toEqual({ command: "/bin/bun", args: ["/repo/packages/cli/bin/scout.mjs", ...serve], cwd: "/pkg/runtime" });
    expect(resolveSharedMcpCommand({ ...base, repoRoot: null, exists: (path) => path === "/pkg/runtime/bin/scout.mjs" }))
      .toEqual({ command: "/bin/bun", args: ["/pkg/runtime/bin/scout.mjs", ...serve], cwd: "/pkg/runtime" });
  });

  test("returns null without Bun or an entrypoint, and passes launch options through", () => {
    expect(resolveSharedMcpCommand({ ...base, bunExecutable: null, exists: () => true })).toBeNull();
    expect(resolveSharedMcpCommand({ ...base, exists: () => false })).toBeNull();
    expect(resolveSharedMcpCommand({ ...base, profile: "git,work", env: { OPENSCOUT_MCP_ENABLE_NOTIFICATIONS: "1" }, exists: () => true })?.args.slice(-3))
      .toEqual(["--profile", "git,work", "--notifications"]);
  });
});

class FakeChild extends EventEmitter {
  static next = 100;
  pid = FakeChild.next++;
  exit(code = 1) {
    this.emit("exit", code, null);
  }
}

function harness(initiallyDesired = true) {
  let clock = 0;
  let desired = initiallyDesired;
  const children: FakeChild[] = [];
  const terminated: number[] = [];
  let spawnFails = false;
  const supervisor = createSharedMcpSupervisor({
    desired: () => desired,
    spawn: () => {
      if (spawnFails) throw new Error("no entrypoint");
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
    terminate: async (child) => {
      terminated.push(child.pid!);
      (child as unknown as FakeChild).exit(0);
    },
    log: () => {},
    warn: () => {},
    now: () => clock,
  });
  return {
    supervisor,
    children,
    terminated,
    advance: (ms: number) => { clock += ms; },
    setDesired: (value: boolean) => { desired = value; },
    setSpawnFails: (value: boolean) => { spawnFails = value; },
  };
}

describe("createSharedMcpSupervisor", () => {
  test("starts one server while desired and stops it when the opt-in goes", async () => {
    const h = harness();
    await h.supervisor.reconcile();
    await h.supervisor.reconcile();
    expect(h.children.length).toBe(1);
    expect(h.supervisor.running()).toBe(true);

    h.setDesired(false);
    await h.supervisor.reconcile();
    expect(h.terminated).toEqual([h.children[0]!.pid]);
    expect(h.supervisor.running()).toBe(false);
    await h.supervisor.reconcile();
    expect(h.children.length).toBe(1);
  });

  test("starts nothing while not desired", async () => {
    const h = harness(false);
    await h.supervisor.reconcile();
    expect(h.children.length).toBe(0);
  });

  test("restarts a crashed server after a doubling delay, capped, and resets after a stable run", async () => {
    const h = harness();
    await h.supervisor.reconcile();
    const delays: number[] = [];
    for (let crash = 0; crash < 8; crash += 1) {
      h.children.at(-1)!.exit(1);
      let waited = 0;
      const before = h.children.length;
      while (h.children.length === before) {
        await h.supervisor.reconcile();
        if (h.children.length === before) { h.advance(500); waited += 500; }
      }
      delays.push(waited);
    }
    expect(delays.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(Math.max(...delays)).toBe(SHARED_MCP_MAX_RESTART_MS);

    h.advance(SHARED_MCP_STABLE_AFTER_MS);
    h.children.at(-1)!.exit(1);
    await h.supervisor.reconcile();
    const before = h.children.length;
    h.advance(1_000);
    await h.supervisor.reconcile();
    expect(h.children.length).toBe(before + 1);
  });

  test("a spawn that throws is retried later, not tight-looped", async () => {
    const h = harness();
    h.setSpawnFails(true);
    await h.supervisor.reconcile();
    await h.supervisor.reconcile();
    h.setSpawnFails(false);
    await h.supervisor.reconcile();
    expect(h.children.length).toBe(0);
    h.advance(1_000);
    await h.supervisor.reconcile();
    expect(h.children.length).toBe(1);
  });

  test("stop terminates the server and keeps it down", async () => {
    const h = harness();
    await h.supervisor.reconcile();
    await h.supervisor.stop();
    expect(h.terminated.length).toBe(1);
    h.advance(120_000);
    await h.supervisor.reconcile();
    expect(h.children.length).toBe(1);
  });
});
