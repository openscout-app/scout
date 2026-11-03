import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const manifests = ["package.json", ...["agent-sessions", "cli", "protocol", "runtime", "session-trace", "pairing"].map(p => `packages/${p}/package.json`)];

test("dev bumps lockstep versions and workspace pack ranges, orders dev numerically and promotes to stable", () => {
  const fixture = mkdtempSync(join(tmpdir(), "scout-dev-bump."));
  try {
    for (const file of [...manifests, "docs.json", "packages/cli/server.json", "bun.lock", "packages/cli/src/lib/shared/product.ts", "scripts/bump-version.mjs", "scripts/prepare-publish-manifest.mjs", "scripts/restore-publish-manifest.mjs"]) {
      mkdirSync(dirname(join(fixture, file)), { recursive: true });
      copyFileSync(new URL(`../${file}`, import.meta.url), join(fixture, file));
    }
    const run = (script, ...args) => spawnSync(process.execPath, [`scripts/${script}.mjs`, ...args], { cwd: fixture, encoding: "utf8" });
    const current = JSON.parse(readFileSync(join(fixture, "package.json"))).version;
    const [major, minor, patch] = current.split(".").map(Number);
    const base = `${major}.${minor}.${patch + 1}`;
    for (const version of [`${base}-dev.9`, `${base}-dev.10`]) {
      const r = run("bump-version", version);
      assert.equal(r.status, 0, r.stderr);
      for (const file of manifests) assert.equal(JSON.parse(readFileSync(join(fixture, file))).version, version);
      assert.equal(JSON.parse(readFileSync(join(fixture, "docs.json"))).version, version);
      const server = JSON.parse(readFileSync(join(fixture, "packages/cli/server.json")));
      assert.equal(server.version, version);
      assert.equal(server.packages.find(p => p.identifier === "@openscout/scout").version, version);
      const lock = readFileSync(join(fixture, "bun.lock"), "utf8");
      for (const file of manifests.filter(p => p.startsWith("packages/"))) {
        const block = lock.split(`    "${dirname(file)}": {`)[1].split('\n    "')[0];
        assert.match(block, new RegExp(`"version": "${version.replaceAll(".", "\\.")}"`));
      }
    }
    assert.notEqual(run("bump-version", `${base}-dev.2`).status, 0);
    assert.notEqual(run("bump-version", `${base}-dev.01`).status, 0);
    for (const file of manifests.filter(p => p.startsWith("packages/"))) {
      const r = run("prepare-publish-manifest", dirname(file));
      assert.equal(r.status, 0, r.stderr);
      const pkg = JSON.parse(readFileSync(join(fixture, file)));
      for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        for (const [name, range] of Object.entries(pkg[section] ?? {})) {
          assert.ok(!range.startsWith("workspace:"), `${name}: ${range}`);
          if (name.startsWith("@openscout/")) assert.ok(range.includes(`${base}-dev.10`), `${name}: ${range}`);
        }
      }
      assert.equal(run("restore-publish-manifest", dirname(file)).status, 0);
    }
    assert.equal(run("bump-version", base).status, 0);
    assert.equal(JSON.parse(readFileSync(join(fixture, "packages/cli/server.json"))).version, base);
    assert.notEqual(run("bump-version", `${base}-dev.11`).status, 0);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("a server.json version out of lockstep refuses the bump before any write", () => {
  const fixture = mkdtempSync(join(tmpdir(), "scout-registry-bump."));
  try {
    for (const file of [...manifests, "docs.json", "packages/cli/server.json", "bun.lock", "packages/cli/src/lib/shared/product.ts", "scripts/bump-version.mjs"]) {
      mkdirSync(dirname(join(fixture, file)), { recursive: true });
      copyFileSync(new URL(`../${file}`, import.meta.url), join(fixture, file));
    }
    const serverPath = join(fixture, "packages/cli/server.json");
    const server = JSON.parse(readFileSync(serverPath));
    server.packages.find(p => p.identifier === "@openscout/scout").version = "0.0.1";
    writeFileSync(serverPath, JSON.stringify(server, null, 2));
    const before = readFileSync(join(fixture, "package.json"), "utf8");
    const r = spawnSync(process.execPath, ["scripts/bump-version.mjs", "patch"], { cwd: fixture, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /server\.json/);
    assert.equal(readFileSync(join(fixture, "package.json"), "utf8"), before);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
