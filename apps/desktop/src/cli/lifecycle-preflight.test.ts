import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseDrainTimeout, parseSetupCommandOptions, parseUpCommandOptions } from "../../../../packages/cli/bin/lifecycle-preflight.mjs";

test("source CLI validates before broker maintenance, including global flags and help aliases", () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-source-help-"));
  try {
    const home = join(dir, "home");
    mkdirSync(home);
    const preload = join(dir, "preload.ts");
    // If any input reaches maintenance, stop there without touching a real service.
    writeFileSync(preload, `import { mock } from "bun:test";
      mock.module(${JSON.stringify(resolve(import.meta.dir, "broker-update.ts"))}, () => ({
        brokerUpdateDebugEnabled: () => false,
        ensureBrokerUptodate: async () => { throw new Error("VALIDATION REACHED MAINTENANCE"); },
      }));`);
    const run = (args: string[]) => spawnSync(process.execPath, ["--preload", preload, resolve(import.meta.dir, "main.ts"), ...args], {
      cwd: dir, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", HOME: home, OPENSCOUT_CONTROL_HOME: join(home, "control"), OPENSCOUT_SUPPORT_DIR: join(home, "support"), OPENSCOUT_CONTROL_PLANE_DB: join(home, "db.sqlite"), OPENSCOUT_SETUP_CWD: dir },
    });
    for (const args of [
      ["app", "help"], ["app", "restart", "--help"], ["help", "setup"], ["--help", "up"],
      ["--json", "app", "restart", "--help"], ["relay", "app", "help"],
    ]) {
      const result = run(args);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Usage:");
    }
    for (const args of [
      ["up", ".", "--unsupported"], ["app", "restart", "extra"], ["app", "restart", "--timeout="],
      ["setup", "--source-root="], ["--json", "app", "restart", "--unsupported"],
      ["up", ".", "--name", "--harness=codex"], ["relay", "app", "restart", "extra"],
    ]) {
      const result = run(args);
      expect(result.status, JSON.stringify(args)).toBe(1);
      expect(result.stderr).not.toContain("VALIDATION REACHED MAINTENANCE");
      expect(result.stderr).toMatch(/unexpected|missing|invalid/);
    }
    expect(readdirSync(home)).toEqual([]);
    for (const args of [["up", ".", "--json"], ["--json", "up", "."], ["app", "restart", "--timeout=90s"], ["setup", "--source-root=."]]) {
      expect(run(args).stderr).toContain("VALIDATION REACHED MAINTENANCE");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test("lifecycle handlers share value and positional grammar", () => {
  expect(parseUpCommandOptions([".", "--name=worker", "--effort", "high", "--json"])).toEqual({ target: ".", agentName: "worker", reasoningEffort: "high" });
  expect(parseUpCommandOptions(["help"]).target).toBe("help");
  expect(parseSetupCommandOptions(["--source-root", ".", "--default-harness=pi", "--context-root=/work"], "/default")).toEqual({ currentDirectory: "/work", sourceRoots: [resolve(".")], defaultHarness: "pi" });
  expect(() => parseSetupCommandOptions(["--source-root="], "/default")).toThrow("missing value");
  expect(parseDrainTimeout("9".repeat(400))).toBeNull();
});
