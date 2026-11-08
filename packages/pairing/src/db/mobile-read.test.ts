import { expect, test } from "bun:test";
import { MobileReadWorker } from "./mobile-read.ts";
import { SQLiteControlPlaneStore } from "../../../runtime/src/sqlite-store.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a synchronous stalled read does not stall bridge timers; the queue is bounded", async () => {
  const reader = new MobileReadWorker(new URL("../fixtures/slow-mobile-read.ts", import.meta.url));
  try {
    let settled = false;
    const first = reader.read("fleet").then(value => { settled = true; return value; });
    const start = performance.now();
    await Bun.sleep(40);
    expect(performance.now() - start).toBeLessThan(200);
    expect(settled).toBe(false);
    const rest = Array.from({ length: 31 }, () => reader.read("fleet").catch(() => null));
    await expect(reader.read("fleet")).rejects.toThrow("queue is full");
    await expect(first).resolves.toEqual({ done: true } as any);
    reader.close();
    await Promise.all(rest);
  } finally { reader.close(); }
});

test("worker exit rejects pending reads and permits a fresh reader", async () => {
  const reader = new MobileReadWorker(new URL("../fixtures/slow-mobile-read.ts", import.meta.url));
  try {
    await expect(reader.read("fleet", { limit: 2 })).rejects.toThrow("fixture read failure");
    await expect(reader.read("fleet")).resolves.toEqual({ done: true } as any);
  } finally { reader.close(); }
});

test("the real worker opens an isolated readonly database and serves fleet and heartrate", async () => {
  const root = mkdtempSync(join(tmpdir(), "scout-mobile-read-"));
  const original = process.env.OPENSCOUT_CONTROL_HOME;
  process.env.OPENSCOUT_CONTROL_HOME = root;
  const store = new SQLiteControlPlaneStore(join(root, "control-plane.sqlite"));
  const reader = new MobileReadWorker();
  try {
    expect((await reader.read("fleet")).activity).toEqual([]);
    expect((await reader.read("heartrate")).buckets).toHaveLength(56);
    expect(await reader.read("agentDetail", "missing")).toBeNull();
    expect(await reader.read("terminalSessions", { limit: 12 })).toEqual([]);
  } finally {
    reader.close();
    store.close();
    if (original === undefined) delete process.env.OPENSCOUT_CONTROL_HOME;
    else process.env.OPENSCOUT_CONTROL_HOME = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a wedged reader fails with a diagnostic without a synchronous fallback", async () => {
  const reader = new MobileReadWorker(new URL("../fixtures/slow-mobile-read.ts", import.meta.url), 30);
  try {
    await expect(reader.read("fleet")).rejects.toThrow("bridge remains available");
  } finally { reader.close(); }
});
