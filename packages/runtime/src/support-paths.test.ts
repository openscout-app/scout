import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import {
  assertTestIsolatedUserData,
  ensureOpenScoutCleanSlateSync,
  resolveOpenScoutCacheDirectory,
  resolveOpenScoutConfigReadPath,
  resolveOpenScoutPairingHomeForEnv,
  resolveOpenScoutStateDirectory,
  resolveOpenScoutSupportPaths,
  resolveOpenScoutToolDirectory,
} from "./support-paths.js";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  OPENSCOUT_HOME: process.env.OPENSCOUT_HOME,
  OPENSCOUT_STATE_DIR: process.env.OPENSCOUT_STATE_DIR,
  OPENSCOUT_CACHE_DIR: process.env.OPENSCOUT_CACHE_DIR,
  SCOUT_HOME: process.env.SCOUT_HOME,
  OPENSCOUT_SUPPORT_DIRECTORY: process.env.OPENSCOUT_SUPPORT_DIRECTORY,
  OPENSCOUT_CONTROL_HOME: process.env.OPENSCOUT_CONTROL_HOME,
  OPENSCOUT_RELAY_HUB: process.env.OPENSCOUT_RELAY_HUB,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
};
const testDirectories = new Set<string>();

function isolatedSupportPaths() {
  const root = mkdtempSync(join(tmpdir(), "openscout-support-preservation-"));
  testDirectories.add(root);
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(root, "support");
  process.env.OPENSCOUT_CONTROL_HOME = join(root, "control");
  process.env.OPENSCOUT_RELAY_HUB = join(root, "relay");
  return { root, ...resolveOpenScoutSupportPaths() };
}

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { configurable: true, enumerable: true, value: platform });
  const restore = () => {
    if (previous) Object.defineProperty(process, "platform", previous);
  };
  try {
    const result = run();
    if (result instanceof Promise) return result.finally(restore) as T;
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

afterEach(() => {
  for (const directory of testDirectories) rmSync(directory, { recursive: true, force: true });
  testDirectories.clear();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("ensureOpenScoutCleanSlateSync", () => {
  test("preserves existing agent homes, startup logs, mesh state and coordination data without a marker", () => {
    const paths = isolatedSupportPaths();
    const sentinels = [
      join(paths.supportDirectory, "settings.json"),
      join(paths.relayAgentsDirectory, "scoutbot", "prompt.txt"),
      join(paths.relayAgentsDirectory, "scoutbot", "state.json"),
      join(paths.runtimeDirectory, "codex-background-home", "config.toml"),
      join(paths.logsDirectory, "base", "broker.stdout.log"),
      join(paths.runtimeDirectory, "mesh-bridge.json"),
      join(paths.controlHome, "control-plane.sqlite"),
      join(paths.controlHome, "control-plane.sqlite-wal"),
      join(paths.controlHome, "control-plane.sqlite-shm"),
      join(paths.relayHubDirectory, "keep.txt"),
    ];
    for (const path of sentinels) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `preserve ${path}\n`);
    }
    const identities = sentinels.map((path) => lstatSync(path).ino);
    // Synthetic credential fixture and relative link, entirely inside this test's root.
    const authSource = join(paths.root, "operator-auth.json");
    const authTarget = join(paths.runtimeDirectory, "codex-background-home", "auth.json");
    const authLink = relative(dirname(authTarget), authSource);
    writeFileSync(authSource, "synthetic auth fixture\n");
    symlinkSync(authLink, authTarget);
    expect(existsSync(paths.cutoverMarkerPath)).toBe(false);

    ensureOpenScoutCleanSlateSync();

    expect(sentinels.map((path) => existsSync(path))).toEqual(sentinels.map(() => true));
    expect(sentinels.map((path) => lstatSync(path).ino)).toEqual(identities);
    for (const path of sentinels) expect(readFileSync(path, "utf8")).toBe(`preserve ${path}\n`);
    expect(readlinkSync(authTarget)).toBe(authLink);
    expect(readFileSync(authSource, "utf8")).toBe("synthetic auth fixture\n");
    expect(existsSync(paths.cutoverMarkerPath)).toBe(true);
  });

  test("initializes an empty support directory and compatibility marker", () => {
    const paths = isolatedSupportPaths();
    expect(existsSync(paths.supportDirectory)).toBe(false);

    ensureOpenScoutCleanSlateSync();

    expect(lstatSync(paths.supportDirectory).isDirectory()).toBe(true);
    expect(readFileSync(paths.cutoverMarkerPath, "utf8")).toMatch(/^\d+\n$/);
    expect(existsSync(paths.controlHome)).toBe(false);
    expect(existsSync(paths.relayHubDirectory)).toBe(false);
  });

  test("leaves an existing compatibility marker and data unchanged on repeated startup", () => {
    const paths = isolatedSupportPaths();
    mkdirSync(paths.supportDirectory, { recursive: true });
    writeFileSync(paths.cutoverMarkerPath, "existing marker\n");
    writeFileSync(paths.settingsPath, "existing settings\n");
    const marker = lstatSync(paths.cutoverMarkerPath);

    ensureOpenScoutCleanSlateSync();
    ensureOpenScoutCleanSlateSync();

    expect(readFileSync(paths.cutoverMarkerPath, "utf8")).toBe("existing marker\n");
    expect(lstatSync(paths.cutoverMarkerPath).ino).toBe(marker.ino);
    expect(lstatSync(paths.cutoverMarkerPath).mtimeMs).toBe(marker.mtimeMs);
    expect(readFileSync(paths.settingsPath, "utf8")).toBe("existing settings\n");
  });

  test("refuses initialization without test isolation", () => {
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
    delete process.env.OPENSCOUT_STATE_DIR;
    delete process.env.OPENSCOUT_HOME;
    delete process.env.SCOUT_HOME;
    expect(() => ensureOpenScoutCleanSlateSync()).toThrow(/without OPENSCOUT_SUPPORT_DIRECTORY set/);
  });

  test("passes test isolation when only OPENSCOUT_HOME or OPENSCOUT_STATE_DIR is set", () => {
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
    delete process.env.OPENSCOUT_CONTROL_HOME;
    const root = mkdtempSync(join(tmpdir(), "openscout-one-home-"));
    testDirectories.add(root);
    process.env.OPENSCOUT_HOME = join(root, ".openscout");

    ensureOpenScoutCleanSlateSync();
    expect(resolveOpenScoutStateDirectory()).toBe(join(root, ".openscout", "state"));
    expect(resolveOpenScoutSupportPaths().controlHome).toBe(join(root, ".openscout", "state", "control-plane"));
    expect(existsSync(resolveOpenScoutSupportPaths().cutoverMarkerPath)).toBe(true);

    delete process.env.OPENSCOUT_HOME;
    process.env.OPENSCOUT_STATE_DIR = join(root, "explicit-state");
    ensureOpenScoutCleanSlateSync();
    expect(resolveOpenScoutStateDirectory()).toBe(join(root, "explicit-state"));
    expect(existsSync(join(root, "explicit-state", "rpc-runtime-cutover-v1"))).toBe(true);
  });
});

describe("one-home dual-location resolvers", () => {
  test("resolveOpenScoutConfigReadPath reads ~/.openscout first and falls back to legacy ~/.scout", () => {
    const home = mkdtempSync(join(tmpdir(), "openscout-dual-config-"));
    testDirectories.add(home);
    mkdirSync(join(home, ".scout"), { recursive: true });
    writeFileSync(join(home, ".scout", "config.json"), "{}");

    expect(resolveOpenScoutConfigReadPath("config.json", { HOME: home }))
      .toBe(join(home, ".scout", "config.json"));

    mkdirSync(join(home, ".openscout"), { recursive: true });
    writeFileSync(join(home, ".openscout", "config.json"), "{}");
    expect(resolveOpenScoutConfigReadPath("config.json", { HOME: home }))
      .toBe(join(home, ".openscout", "config.json"));
  });

  test("resolveOpenScoutPairingHomeForEnv prefers migrated ~/.openscout/state/pairing over legacy ~/.scout/pairing", () => {
    const home = mkdtempSync(join(tmpdir(), "openscout-dual-pairing-"));
    testDirectories.add(home);
    expect(resolveOpenScoutPairingHomeForEnv({ HOME: home })).toBe(join(home, ".scout", "pairing"));

    mkdirSync(join(home, ".openscout", "state", "pairing"), { recursive: true });
    expect(resolveOpenScoutPairingHomeForEnv({ HOME: home })).toBe(join(home, ".openscout", "state", "pairing"));
    expect(resolveOpenScoutPairingHomeForEnv({ HOME: home, OPENSCOUT_STATE_DIR: join(home, "custom-state") }))
      .toBe(join(home, "custom-state", "pairing"));
  });

  test("cache and tool directories derive inside OPENSCOUT_HOME", () => {
    const env = { OPENSCOUT_HOME: "/tmp/one-home" };
    expect(resolveOpenScoutCacheDirectory(env)).toBe("/tmp/one-home/cache");
    expect(resolveOpenScoutCacheDirectory({ ...env, OPENSCOUT_CACHE_DIR: "/tmp/custom-cache" })).toBe("/tmp/custom-cache");
    expect(resolveOpenScoutToolDirectory("desk", env)).toBe("/tmp/one-home/.desk");
    expect(resolveOpenScoutToolDirectory("studio", env)).toBe("/tmp/one-home/.studio");
  });
});

describe("assertTestIsolatedUserData", () => {
  test("refuses an unisolated write under the test runner", () => {
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
    expect(() => assertTestIsolatedUserData("write test data", "OPENSCOUT_SUPPORT_DIRECTORY"))
      .toThrow(/Refusing to write test data/);
  });

  test("refuses even when NODE_ENV is preset to something other than test", () => {
    // bun test does not override a preset NODE_ENV; the leak that corrupted a
    // real settings.json ran exactly this way. The guard must recognize the
    // runner by its test-file entrypoint, not NODE_ENV alone.
    process.env.NODE_ENV = "development";
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
    expect(() => assertTestIsolatedUserData("write test data", "OPENSCOUT_SUPPORT_DIRECTORY"))
      .toThrow(/Refusing to write test data/);
  });

  test("allows the write once the isolation env var redirects it", () => {
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = "/tmp/openscout-isolated-test";
    expect(() => assertTestIsolatedUserData("write test data", "OPENSCOUT_SUPPORT_DIRECTORY"))
      .not.toThrow();
  });
});

describe("resolveOpenScoutSupportPaths platform default", () => {
  test("darwin keeps ~/Library/Application Support/OpenScout", () => {
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
    process.env.XDG_DATA_HOME = "/var/lib/openscout-should-not-apply";
    withPlatform("darwin", () => {
      expect(resolveOpenScoutSupportPaths().supportDirectory)
        .toBe(join(homedir(), "Library", "Application Support", "OpenScout"));
    });
  });

  test("linux uses ~/.local/share/openscout when the support env and XDG_DATA_HOME are unset", () => {
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
    delete process.env.XDG_DATA_HOME;
    withPlatform("linux", () => {
      expect(resolveOpenScoutSupportPaths().supportDirectory)
        .toBe(join(homedir(), ".local", "share", "openscout"));
    });
  });

  test("linux uses XDG_DATA_HOME, and OPENSCOUT_SUPPORT_DIRECTORY still wins", () => {
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
    process.env.XDG_DATA_HOME = "/custom/xdg-data";
    withPlatform("linux", () => {
      expect(resolveOpenScoutSupportPaths().supportDirectory).toBe("/custom/xdg-data/openscout");
    });
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = "/opt/openscout-override";
    withPlatform("linux", () => {
      expect(resolveOpenScoutSupportPaths().supportDirectory).toBe("/opt/openscout-override");
    });
  });
});
