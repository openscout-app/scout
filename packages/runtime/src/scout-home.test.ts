import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  moveLegacyScoutHomeOffline,
  resolveOpenScoutCacheDir,
  resolveOpenScoutHomeRoot,
  resolveOpenScoutStateDir,
  resolveOpenScoutToolDir,
  resolveScoutHome,
  scoutHomeReadPath,
  scoutHomeReadRoots,
  scoutHomeWritePath,
  scoutStateReadPath,
  scoutStateReadRoots,
  scoutStateWritePath,
} from "./scout-home.ts";

const homes: string[] = [];
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "scout-home-migration-"));
  homes.push(home);
  return { home, env: {} };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

test("one-home default (~/.openscout) and env precedence; resolution has no side effects", () => {
  const options = sandbox();
  expect(resolveScoutHome(options)).toBe(join(options.home, ".openscout"));
  expect(resolveOpenScoutHomeRoot(options)).toBe(join(options.home, ".openscout"));
  expect(existsSync(join(options.home, ".openscout"))).toBe(false);
  expect(resolveScoutHome({ ...options, env: { OPENSCOUT_HOME: " /primary ", SCOUT_HOME: "/alias" } })).toBe("/primary");
  expect(resolveScoutHome({ ...options, env: { OPENSCOUT_HOME: " ", SCOUT_HOME: " /alias " } })).toBe("/alias");
  expect(resolveScoutHome({ ...options, env: { OPENSCOUT_SCOUT_HOME: " /legacy " } })).toBe("/legacy");
});

test("state, cache, and sibling tool directories derive under ~/.openscout with explicit overrides", () => {
  const options = sandbox();
  expect(resolveOpenScoutStateDir(options)).toBe(join(options.home, ".openscout", "state"));
  expect(resolveOpenScoutCacheDir(options)).toBe(join(options.home, ".openscout", "cache"));
  expect(resolveOpenScoutToolDir("desk", options)).toBe(join(options.home, ".openscout", ".desk"));
  expect(resolveOpenScoutToolDir(".studio", options)).toBe(join(options.home, ".openscout", ".studio"));
  expect(() => resolveOpenScoutToolDir("../escape", options)).toThrow("Invalid OpenScout tool name");

  expect(resolveOpenScoutStateDir({ ...options, env: { OPENSCOUT_HOME: "/one" } })).toBe("/one/state");
  expect(resolveOpenScoutCacheDir({ ...options, env: { OPENSCOUT_HOME: "/one" } })).toBe("/one/cache");
  expect(resolveOpenScoutStateDir({ ...options, env: { OPENSCOUT_STATE_DIR: "/state", OPENSCOUT_SUPPORT_DIRECTORY: "/old" } })).toBe("/state");
  expect(resolveOpenScoutStateDir({ ...options, env: { OPENSCOUT_SUPPORT_DIRECTORY: "/old" } })).toBe("/old");
  expect(resolveOpenScoutCacheDir({ ...options, env: { OPENSCOUT_CACHE_DIR: "/fast-cache" } })).toBe("/fast-cache");
});

test("read both (~/.openscout then legacy ~/.scout), prefer ~/.openscout, write only ~/.openscout", () => {
  const options = sandbox();
  for (const root of [".openscout", ".scout"]) mkdirSync(join(options.home, root));
  writeFileSync(join(options.home, ".scout/config.json"), "legacy");
  expect(scoutHomeReadPath("config.json", options)).toBe(join(options.home, ".scout/config.json"));
  expect(scoutHomeWritePath("config.json", options)).toBe(join(options.home, ".openscout/config.json"));
  writeFileSync(join(options.home, ".openscout/config.json"), "new");
  expect(scoutHomeReadPath("config.json", options)).toBe(join(options.home, ".openscout/config.json"));
});

test("state reader checks ~/.openscout/state first, then legacy Application Support / ~/.openscout / ~/.scout", () => {
  const options = { ...sandbox(), platform: "darwin" as const };
  const legacySupport = join(options.home, "Library", "Application Support", "OpenScout");
  mkdirSync(legacySupport, { recursive: true });
  writeFileSync(join(legacySupport, "settings.json"), "legacy-support");
  expect(scoutStateReadPath("settings.json", options)).toBe(join(legacySupport, "settings.json"));
  expect(scoutStateWritePath("settings.json", options)).toBe(join(options.home, ".openscout", "state", "settings.json"));

  mkdirSync(join(options.home, ".openscout", "state"), { recursive: true });
  writeFileSync(join(options.home, ".openscout", "state", "settings.json"), "new-state");
  expect(scoutStateReadPath("settings.json", options)).toBe(join(options.home, ".openscout", "state", "settings.json"));
});

test("explicit overrides do not fall back to ambient home or legacy state", () => {
  const options = sandbox();
  const isolated = join(options.home, "isolated");
  expect(scoutHomeReadRoots({ ...options, env: { OPENSCOUT_HOME: isolated } })).toEqual([isolated]);
  expect(scoutStateReadRoots({ ...options, env: { OPENSCOUT_HOME: isolated } })).toEqual([join(isolated, "state")]);
  expect(scoutStateReadRoots({ ...options, env: { OPENSCOUT_STATE_DIR: join(isolated, "custom-state") } }))
    .toEqual([join(isolated, "custom-state")]);
});

test("reject absolute paths and parent traversal", () => {
  const options = sandbox();
  for (const name of ["", "/tmp/outside", "../outside", "x/../../outside"]) {
    expect(() => scoutHomeWritePath(name, options)).toThrow();
    expect(() => scoutHomeReadPath(name, options)).toThrow();
    expect(() => scoutStateWritePath(name, options)).toThrow();
    expect(() => scoutStateReadPath(name, options)).toThrow();
  }
});

test("exclusive owner moves legacy ~/.scout into ~/.openscout as one directory; repeat is no-op", () => {
  const options = sandbox();
  mkdirSync(join(options.home, ".scout"));
  for (const name of ["broker.sqlite", "broker.sqlite-wal", "broker.sqlite-shm", "config.json"]) {
    writeFileSync(join(options.home, ".scout", name), name);
  }
  let checks = 0;
  const migration = { ...options, assertExclusiveOwnership: () => { checks++; } };
  expect(moveLegacyScoutHomeOffline(migration)).toBe("moved");
  expect(checks).toBe(1);
  for (const name of ["broker.sqlite", "broker.sqlite-wal", "broker.sqlite-shm", "config.json"]) {
    expect(readFileSync(join(options.home, ".openscout", name), "utf8")).toBe(name);
  }
  expect(moveLegacyScoutHomeOffline(migration)).toBe("absent");
});

test("live/unowned migration is refused without touching data", () => {
  const options = sandbox();
  mkdirSync(join(options.home, ".scout"));
  expect(() => moveLegacyScoutHomeOffline({ ...options, assertExclusiveOwnership: () => { throw new Error("broker still running"); } })).toThrow("broker still running");
  expect(existsSync(join(options.home, ".scout"))).toBe(true);
  expect(existsSync(join(options.home, ".openscout"))).toBe(false);
});

test("existing destination is not merged, replaced, or deleted", () => {
  const options = sandbox();
  for (const root of [".openscout", ".scout"]) mkdirSync(join(options.home, root));
  expect(() => moveLegacyScoutHomeOffline({ ...options, assertExclusiveOwnership: () => {} })).toThrow("journal");
  expect(existsSync(join(options.home, ".openscout"))).toBe(true);
  expect(existsSync(join(options.home, ".scout"))).toBe(true);
});

test("overrides never migrate; symlink sources are refused", () => {
  const options = sandbox();
  expect(moveLegacyScoutHomeOffline({ ...options, env: { OPENSCOUT_HOME: "/unused" }, assertExclusiveOwnership: () => { throw new Error("not reached"); } })).toBe("overridden");
  mkdirSync(join(options.home, "source"));
  symlinkSync(join(options.home, "source"), join(options.home, ".scout"));
  expect(() => moveLegacyScoutHomeOffline({ ...options, assertExclusiveOwnership: () => {} })).toThrow("symlink");
});
