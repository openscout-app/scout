import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostLaunchAdmission, type HostPressure } from "./host-launch-admission.js";

test("host reservations survive broker restart and require sustained healthy readings after critical pressure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scout-budget-test-"));
  let now = 1_000;
  let level: HostPressure = "critical";
  const options = { path: join(directory, "budget.sqlite"), pressure: async () => level, now: () => now };
  const first = new HostLaunchAdmission(options);
  const second = new HostLaunchAdmission(options);
  const restarted = new HostLaunchAdmission(options);
  try {
    await expect(first.reserve()).rejects.toThrow("host memory pressure");
    first.close();
    level = "normal";
    now += 1_000;
    await expect(restarted.reserve()).rejects.toThrow("recovering");
    now += 60_000; // No readings during sleep or broker downtime.
    await expect(second.reserve()).rejects.toThrow("recovering");
    level = "warning"; now += 1_000;
    await expect(restarted.reserve()).rejects.toThrow("host memory pressure");
    level = "normal";
    for (let i = 0; i < 30; i++) {
      now += 1_000;
      await expect(second.reserve()).rejects.toThrow("recovering");
    }
    now += 1_000;
    const reservations = await Promise.allSettled([second.reserve(), restarted.reserve()]);
    expect(reservations.filter(result => result.status === "fulfilled")).toHaveLength(1);
    now += 9_999;
    await expect(second.reserve()).rejects.toThrow("another local worker");
    now += 1;
    await restarted.reserve();
  } finally {
    first.close(); second.close(); restarted.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
