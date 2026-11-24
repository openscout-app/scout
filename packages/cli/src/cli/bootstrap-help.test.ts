import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSystemFile } from "@openscout/runtime/setup";
import { DOCTOR_HELP, NODE_DOCTOR_HELP, SETUP_HELP, preflightLifecycle } from "../../bin/lifecycle-preflight.mjs";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

test("doctor and setup human help selects before mixed readiness reports", () => {
  for (const [command, expected] of [["doctor", DOCTOR_HELP], ["setup", SETUP_HELP]]) {
    for (const argv of [[command!, "--help"], [command!, "-h"], ["help", command!], ["--help", command!], ["relay", command!, "--help"], ["--instance", "dev", command!, "--help"], [command!, "--instance=dev", "-h"]]) {
      expect(preflightLifecycle(argv), argv.join(" ")).toBe(expected!);
    }
  }
});

test("Node doctor help describes its actual JSON report and unsupported native repair", () => {
  for (const argv of [["doctor", "--help"], ["doctor", "--help", "--json"], ["--help", "doctor", "--json"], ["help", "doctor"], ["relay", "doctor", "-h"]]) {
    expect(preflightLifecycle(argv, "/tmp", { runtimeHost: "node" })).toBe(NODE_DOCTOR_HELP);
  }
  expect(NODE_DOCTOR_HELP).toContain("One headless report JSON object");
  expect(NODE_DOCTOR_HELP).toContain("Repair is not run");
  expect(DOCTOR_HELP).toContain("scout.doctor.core/v1 NDJSON");
  expect(DOCTOR_HELP).toContain("Node headless CLI");
});

test("Bun structured help remains with the registry; version and real commands are not consumed", () => {
  expect(preflightLifecycle(["doctor", "--help", "--json"])).toBeNull();
  expect(preflightLifecycle(["--help", "doctor", "--json"])).toBeNull();
  expect(preflightLifecycle(["--version", "doctor", "--help"])).toBeNull();
  for (const argv of [["doctor"], ["doctor", "--fix", "--yes"], ["doctor", "--json"], ["setup", "--source-root", "."]]) expect(preflightLifecycle(argv)).toBeNull();
  expect(() => preflightLifecycle(["setup", "--source-root="])).toThrow("missing value");
});

test("launcher bootstrap help succeeds with poisoned Bun/Node bundles and empty HOME/PATH", async () => {
  const root = mkdtempSync(join(tmpdir(), "scout-bootstrap-help-")); roots.push(root);
  for (const dir of ["bin", "home", "dist/node"]) mkdirSync(join(root, dir), { recursive: true });
  const marker = join(root, "entry-loaded");
  const poison = `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "loaded"); throw Error("MIXED ENTRY LOADED");`;
  for (const name of ["main.mjs", "node/main.mjs"]) writeFileSync(join(root, "dist", name), poison);
  for (const name of ["scout.mjs", "lifecycle-preflight.mjs", "bun-preflight.mjs"]) copyFileSync(new URL(`../../bin/${name}`, import.meta.url), join(root, "bin", name));
  writeFileSync(join(root, "package.json"), '{"version":"test"}');
  for (const command of ["setup", "doctor"]) for (const flag of ["--help", "-h"]) {
    const result = await execSystemFile(process.execPath, [join(root, "bin/scout.mjs"), command, flag], {
      cwd: root, env: { HOME: join(root, "home"), PATH: "", OPENSCOUT_RUNTIME_HOST: "node", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, timeoutMs: 3_000,
    });
    expect(result.exitCode).toBe(0); expect(result.stderr).toBe(""); expect(result.stdout).toContain("Usage:");
    expect(existsSync(marker)).toBe(false); expect(readdirSync(join(root, "home"))).toEqual([]);
  }
});
