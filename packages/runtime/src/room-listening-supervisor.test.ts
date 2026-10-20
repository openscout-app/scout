import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRoomListeningSupervisor } from "./room-listening-supervisor.js";

test("base child has bounded backoff, one error/exit retry, and owned shutdown", async () => {
  const children: EventEmitter[] = [], delays: number[] = [];
  let callback: (() => void) | undefined, terminated = 0, cancelled = 0, now = 0;
  const supervisor = createRoomListeningSupervisor({
    spawn: () => { const child = new EventEmitter(); children.push(child); return child as ChildProcess; },
    terminate: async child => { terminated++; child.emit("exit", 0); },
    warn: () => {}, now: () => now,
    schedule: (cb, delay) => { callback = cb; delays.push(delay); return { unref() {} } as any; },
    cancel: () => { cancelled++; callback = undefined; },
  });
  supervisor.start(); supervisor.start(); expect(children).toHaveLength(1);
  children[0]!.emit("error", new Error("fake")); children[0]!.emit("exit", 1);
  expect(delays).toEqual([1000]); callback!();
  children[1]!.emit("exit", 1); expect(delays).toEqual([1000, 2000]); callback!();
  now = 31_000; children[2]!.emit("exit", 1); expect(delays.at(-1)).toBe(1000); callback!();
  await supervisor.stop(); expect(terminated).toBe(1); expect(cancelled).toBe(0);
  supervisor.start(); expect(children).toHaveLength(4);
});
test("shutdown cancels retry and spawn exceptions do not strand service", async () => {
  let cancelled = false, attempts = 0;
  const supervisor = createRoomListeningSupervisor({ spawn: () => { attempts++; throw Error("fake"); },
    terminate: async () => {}, warn: () => {},
    schedule: () => ({ unref() {} }) as any, cancel: () => { cancelled = true; } });
  supervisor.start(); await supervisor.stop(); supervisor.start();
  expect(attempts).toBe(1); expect(cancelled).toBe(true);
});
test("only base owns listener; broker contains no listening registration or timer", () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
  expect(read("base-daemon.ts")).toContain('runtimeEntrypoint(config), "listening"');
  expect(read("base-daemon.ts")).toContain("roomListeningSupervisor.stop()");
  expect(read("broker-daemon.ts")).not.toContain("chatListening");
  expect(read("sqlite-store.ts")).not.toContain("recordChatListeningChange");
  expect(read("room-listening-service.ts")).not.toContain("control-plane.sqlite");
  expect(read("room-listening-service.ts")).toContain("createRoomHttpSource");
  expect(read("broker-http-router.ts")).not.toContain("handleChatListeningRoute");
  expect(read("../bin/openscout-runtime.mjs")).toContain('listening: resolve(sourceDir, "room-listening-daemon.ts")');
});

test("unsupported command suspends without respawn until runtime artifacts change", async () => {
  const children: EventEmitter[] = [], statuses: string[] = [];
  let revision = "v1", callback: (() => void) | undefined;
  const supervisor = createRoomListeningSupervisor({
    spawn: () => { const child = new EventEmitter(); children.push(child); return child as ChildProcess; },
    terminate: async () => {}, warn: () => {}, runtimeRevision: () => revision,
    statusChanged: status => { statuses.push(status.state); },
    schedule: cb => { callback = cb; return { unref() {} } as any; }, cancel: () => { callback = undefined; },
  });
  supervisor.start(); children[0]!.emit("exit", 78, null);
  expect(supervisor.status()).toMatchObject({ state: "suspended", detail: expect.stringContaining("upgrade") });
  supervisor.start(); callback!(); callback!(); expect(children).toHaveLength(1);
  revision = "v2"; callback!(); expect(children).toHaveLength(2);
  expect(supervisor.status().state).toBe("running");
  children[1]!.emit("exit", 78, null); await supervisor.stop();
  expect(callback).toBeUndefined(); expect(statuses.at(-1)).toBe("stopped");
});

test("runtime unknown command exits structurally before importing any daemon", async () => {
  const child = Bun.spawn(["node", new URL("../bin/openscout-runtime.mjs", import.meta.url).pathname, "unsupported-test-command"], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited).toBe(78);
  expect(JSON.parse(stderr)).toEqual({ code: "unsupported_runtime_command", command: "unsupported-test-command", exitCode: 78 });
});

test("an older runtime that exits 1 immediately is suspended after a crash loop, not retried forever", async () => {
  // When base is newer than the runtime, the child can print a human
  // "Unknown openscout-runtime command" and exits 1, never the structured 78.
  const children: EventEmitter[] = [];
  let revision = "old", now = 0, callback: (() => void) | undefined;
  const supervisor = createRoomListeningSupervisor({
    spawn: () => { const child = new EventEmitter(); children.push(child); return child as ChildProcess; },
    terminate: async () => {}, warn: () => {}, runtimeRevision: () => revision, now: () => now,
    schedule: cb => { callback = cb; return { unref() {} } as any; }, cancel: () => { callback = undefined; },
  });
  supervisor.start();
  for (let i = 0; i < 4; i += 1) { children.at(-1)!.emit("exit", 1, null); now += 100; callback!(); }
  expect(supervisor.status().state).toBe("running");
  children.at(-1)!.emit("exit", 1, null);
  expect(supervisor.status()).toMatchObject({ state: "suspended", detail: expect.stringContaining("consecutive starts") });
  const spawned = children.length;
  callback!(); expect(children).toHaveLength(spawned); // same runtime: stays suspended
  now += 30 * 60_000; callback!(); expect(children).toHaveLength(spawned + 1); // backstop retry
  expect(supervisor.status().state).toBe("running");
  children.at(-1)!.emit("exit", 1, null); now += 100; callback!();
  revision = "new"; // an upgrade also resumes, without waiting for the backstop
  for (let i = 0; i < 3; i += 1) { children.at(-1)!.emit("exit", 1, null); now += 100; callback!(); }
  expect(supervisor.status().state).not.toBe("stopped");
  await supervisor.stop();
});

test("a child that runs past the quick-exit window resets the crash-loop count", () => {
  const children: EventEmitter[] = [];
  let now = 0, callback: (() => void) | undefined;
  const supervisor = createRoomListeningSupervisor({
    spawn: () => { const child = new EventEmitter(); children.push(child); return child as ChildProcess; },
    terminate: async () => {}, warn: () => {}, now: () => now,
    schedule: cb => { callback = cb; return { unref() {} } as any; },
  });
  supervisor.start();
  for (let i = 0; i < 4; i += 1) { children.at(-1)!.emit("exit", 1, null); callback!(); }
  now += 60_000; children.at(-1)!.emit("exit", 1, null); callback!(); // ran a full minute
  for (let i = 0; i < 4; i += 1) { children.at(-1)!.emit("exit", 1, null); callback!(); }
  expect(supervisor.status().state).not.toBe("suspended");
});
