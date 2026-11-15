import { afterEach, describe, expect, test } from "bun:test";

import { listProcesses, withProcessListPass, parseEtimeSeconds, readCwd, resetDiscoverCachesForTest } from "./discover.js";

afterEach(() => {
  resetDiscoverCachesForTest();
});

describe("tail process discovery", () => {
  test("pins one slow pass but refreshes expired rows for the next pass", async () => {
    const originalNow = Date.now;
    let now = 10_000;
    let reads = 0;
    Date.now = () => now;
    resetDiscoverCachesForTest(undefined, async () => [
      { pid: ++reads, ppid: 1, etime: "00:01", command: "claude" },
    ]);
    try {
      await withProcessListPass(async () => {
        expect((await listProcesses())[0]?.pid).toBe(1);
        now += 60_000;
        await withProcessListPass(async () => {
          expect((await listProcesses())[0]?.pid).toBe(1);
        });
        expect((await listProcesses())[0]?.pid).toBe(1);
      });
      await withProcessListPass(async () => {
        expect((await listProcesses())[0]?.pid).toBe(2);
      });
      expect(reads).toBe(2);
    } finally {
      Date.now = originalNow;
    }
  });

  test("parses every ps etime form", () => {
    expect(parseEtimeSeconds("00:05")).toBe(5);
    expect(parseEtimeSeconds("12:34")).toBe(754);
    expect(parseEtimeSeconds("01:02:03")).toBe(3723);
    expect(parseEtimeSeconds("2-01:02:03")).toBe(2 * 86_400 + 3723);
    expect(parseEtimeSeconds("nonsense")).toBeNull();
  });

  test("reads a process's cwd once while the same process keeps running", async () => {
    const reads: number[] = [];
    resetDiscoverCachesForTest(async (pid) => {
      reads.push(pid);
      return `/work/${pid}-${reads.length}`;
    });

    expect(await readCwd(42, "10:00")).toBe("/work/42-1");
    // Later scan: etime has advanced with the clock, so the start time is the same.
    expect(await readCwd(42, "10:01")).toBe("/work/42-1");
    expect(reads).toEqual([42]);

    // The pid now belongs to a process that started a minute ago: read again.
    expect(await readCwd(42, "01:00")).toBe("/work/42-2");
    expect(reads).toEqual([42, 42]);

    expect(await readCwd(43)).toBe("/work/43-3");
    expect(await readCwd(43)).toBe("/work/43-3");
    expect(reads).toEqual([42, 42, 43]);
  });
});
