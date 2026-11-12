import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installMemorySnapshot, MEMORY_SNAPSHOT_DIR_ENV, runMemoryProbes } from "./memory-snapshot.js";

describe("memory snapshot", () => {
  test("without the snapshot folder it neither registers nor handles SIGUSR2", () => {
    const before = process.listenerCount("SIGUSR2");
    const uninstall = installMemorySnapshot({ role: "scout-test", env: {} });
    expect(process.listenerCount("SIGUSR2")).toBe(before);
    uninstall();
  });

  test("registers, writes a snapshot with its probes on SIGUSR2, and unregisters", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openscout-memory-"));
    const lines: string[] = [];
    try {
      const uninstall = installMemorySnapshot({
        role: "scout-test",
        env: { [MEMORY_SNAPSHOT_DIR_ENV]: dir },
        probes: { tail: () => ({ watchers: 3 }) },
        log: (line) => lines.push(line),
      });
      const registration = join(dir, "registered", String(process.pid));
      expect(readFileSync(registration, "utf8")).toBe("scout-test");
      process.kill(process.pid, "SIGUSR2");
      for (let i = 0; i < 100 && !lines.length; i++) await Bun.sleep(10);
      const file = readdirSync(dir).find((name) => name.startsWith(`scout-test-${process.pid}-`));
      expect(file).toBeDefined();
      const snapshot = JSON.parse(readFileSync(join(dir, file!), "utf8"));
      expect(snapshot).toMatchObject({ role: "scout-test", pid: process.pid, probes: { tail: { watchers: 3 } } });
      expect(snapshot.rssMb).toBeGreaterThan(0);
      expect(Object.keys(snapshot.jsc).length).toBeGreaterThan(0);
      uninstall();
      expect(existsSync(registration)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a probe that throws reports its error", () => {
    expect(runMemoryProbes({ ok: () => 1, broken: () => { throw new Error("gone"); } })).toEqual({ ok: 1, broken: { error: "gone" } });
  });
});
