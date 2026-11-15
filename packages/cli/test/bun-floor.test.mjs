import { strict as assert } from "node:assert";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { bunVersionError, supportedBunVersion, MINIMUM_BUN_VERSION } from "../bin/bun-preflight.mjs";

const root = new URL("../../../", import.meta.url);

/**
 * The caller's environment without Scout state or color requests, so a
 * child prints the same plain stderr whatever terminal runs the suite.
 */
function childEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("OPENSCOUT_") && !key.startsWith("SCOUT_") && key !== "FORCE_COLOR" && key !== "CLICOLOR_FORCE"));
  env.NO_COLOR = "1";
  return env;
}

test("Bun floor accepts stable versions at or above 1.4.4, not older or prerelease builds", () => {
  assert.equal(MINIMUM_BUN_VERSION, "1.4.4");
  for (const version of ["1.4.4", "1.4.5", "1.4.99", "1.5.0", "2.0.0", "1.4.4+revision"]) {
    assert.equal(supportedBunVersion(version), true, version);
    assert.equal(bunVersionError(version), null);
  }
  for (const version of ["1.4.3", "1.4.3+revision", "1.4.0", "1.4.1", "1.4.2", "1.3.13", "1.3.14", "1.3.999", "0.9.0", "1.4", "1.4.4-canary.1", "garbage", ""]) {
    assert.equal(supportedBunVersion(version), false, version);
    assert.match(bunVersionError(version), /installed: .*\. Upgrade: bun upgrade$/);
  }
  assert.equal(supportedBunVersion(undefined), false);
});

test("standalone runtime and CLI packages ship the same preflight", () => {
  assert.equal(readFileSync(new URL("../bin/bun-preflight.mjs", import.meta.url), "utf8"),
    readFileSync(new URL("packages/runtime/bin/bun-preflight.mjs", root), "utf8"));
});

test("bundled pairing declares the shared Bun floor", () => {
  const manifest = JSON.parse(readFileSync(new URL("packages/pairing/package.json", root), "utf8"));
  assert.equal(manifest.engines.bun, `>=${MINIMUM_BUN_VERSION}`);
});

test("remote update and knowledge child entries enforce first, before argument or state access", () => {
  const directory = mkdtempSync(join(tmpdir(), "scout-child-floor-"));
  try {
    const preload = join(directory, "old-bun.cjs");
    writeFileSync(preload, 'Object.defineProperty(process.versions, "bun", { value: "1.4.3" });\n');
    const env = childEnv();
    env.HOME = directory;
    env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0";
    for (const entry of ["packages/cli/src/update-helper.ts", "packages/runtime/src/knowledge-index-child.ts"]) {
      const path = new URL(entry, root);
      assert.match(readFileSync(path, "utf8").match(/^import .+;$/m)?.[0] ?? "", /^import "\.\/bun-bootstrap\.ts";$/);
      const result = spawnSync("bun", ["--preload", preload, path.pathname, "malformed-json"], { env, encoding: "utf8", timeout: 5_000 });
      assert.equal(result.status, 1, `${entry}: ${result.stderr}`);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "Scout requires Bun 1.4.4 or newer; installed: 1.4.3. Upgrade: bun upgrade\n");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Bun entry wrappers refuse before help, dist resolution or daemon imports", () => {
  const directory = mkdtempSync(join(tmpdir(), "scout-bun-floor-"));
  try {
    const preload = join(directory, "old-bun.cjs");
    writeFileSync(preload, 'Object.defineProperty(process.versions, "bun", { value: "1.4.3" });\n');
    const env = childEnv();
    env.HOME = directory;
    for (const entry of ["packages/cli/bin/scout.mjs", "packages/cli/bin/openscout-runtime.mjs", "packages/runtime/bin/openscout-runtime.mjs"]) {
      const result = spawnSync(process.execPath, ["--require", preload, new URL(entry, root).pathname, "--help"], { env, encoding: "utf8", timeout: 5_000 });
      assert.equal(result.status, 1, `${entry}: ${result.stderr}`);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "Scout requires Bun 1.4.4 or newer; installed: 1.4.3. Upgrade: bun upgrade\n");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
