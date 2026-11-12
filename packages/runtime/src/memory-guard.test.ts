import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryGuardAction, memoryGuardLimits, MemoryGuardRecord, runMemoryProbes } from "./memory-guard.js";

const GB = 1024 ** 3;
const limits = { softBytes: 3 * GB, hardBytes: 4 * GB };
const at = (rss: number, extra: Partial<Parameters<typeof memoryGuardAction>[0]> = {}) =>
  memoryGuardAction({ rss, now: 1_000_000, limits, lastSoftAt: 0, lastHeldAt: 0, recentExits: [], ...extra });

describe("memory guard", () => {
  test("acts only over a limit, and notes a soft snapshot at most once a minute", () => {
    expect(at(2.9 * GB)).toBe("none");
    expect(at(3.1 * GB)).toBe("soft");
    expect(at(3.1 * GB, { lastSoftAt: 1_000_000 - 30_000 })).toBe("none");
    expect(at(3.1 * GB, { lastSoftAt: 1_000_000 - 61_000 })).toBe("soft");
  });

  test("over the hard limit it exits, unless it has exited twice in the window, then it holds", () => {
    expect(at(4.2 * GB)).toBe("hard-exit");
    expect(at(4.2 * GB, { recentExits: [1] })).toBe("hard-exit");
    expect(at(4.2 * GB, { recentExits: [1, 2] })).toBe("hard-held");
    expect(at(4.2 * GB, { recentExits: [1, 2], lastHeldAt: 1_000_000 - 10_000 })).toBe("none");
  });

  test("a limit of 0 is off", () => {
    expect(memoryGuardAction({ rss: 9 * GB, now: 1, limits: { softBytes: 0, hardBytes: 0 }, lastSoftAt: 0, lastHeldAt: 0, recentExits: [] })).toBe("none");
  });

  test("limits come from the environment by process name", () => {
    expect(memoryGuardLimits("runtime", {})).toEqual(limits);
    expect(memoryGuardLimits("runtime", { OPENSCOUT_RUNTIME_MEMORY_SOFT_MB: "1024", OPENSCOUT_RUNTIME_MEMORY_HARD_MB: "0" })).toEqual({ softBytes: GB, hardBytes: 0 });
    expect(memoryGuardLimits("runtime", { OPENSCOUT_RUNTIME_MEMORY_HARD_MB: "lots" }).hardBytes).toBe(4 * GB);
  });

  test("the record keeps exits inside the window and the newest snapshots", () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-guard-"));
    const record = new MemoryGuardRecord(dir, "runtime");
    record.noteExit(1_000);
    record.noteExit(2_000_000);
    expect(record.recentExits(2_000_100)).toEqual([2_000_000]);
    const lines: string[] = [];
    for (let i = 0; i < 15; i++) record.write({ reason: "soft", at: new Date(i * 1000).toISOString(), rssMb: 3100 }, (l) => lines.push(l));
    expect(lines[0]).toStartWith("[memory-guard] runtime soft rss=3100MB {");
    expect(readdirSync(dir).filter((f) => f.endsWith("-soft.json")).length).toBe(12);
  });

  test("a probe that throws reports its error", () => {
    expect(runMemoryProbes({ ok: () => 1, broken: () => { throw new Error("gone"); } })).toEqual({ ok: 1, broken: { error: "gone" } });
  });
});
