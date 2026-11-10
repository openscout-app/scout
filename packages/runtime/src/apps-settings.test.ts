import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAppsSettingsReader,
  defaultAppsSettings,
  normalizeAppsSettings,
  resolveMenuHelperBundlePath,
  resolveScoutAppPath,
} from "./apps-settings.ts";

describe("normalizeAppsSettings", () => {
  test("defaults to the installed app and its embedded helper", () => {
    const settings = normalizeAppsSettings(undefined);
    expect(settings).toEqual(defaultAppsSettings());
    expect(resolveScoutAppPath(settings)).toBe("/Applications/Scout.app");
    expect(resolveMenuHelperBundlePath(settings)).toBe("/Applications/Scout.app/Contents/Library/LoginItems/ScoutMenu.app");
  });

  test("takes absolute paths and strips trailing slashes", () => {
    const settings = normalizeAppsSettings({
      scoutAppPath: " /work/dist/Scout.app/ ",
      menu: { enabled: false, bundlePath: "/work/dist/./ScoutMenu.app" },
    });
    expect(settings).toEqual({
      scoutAppPath: "/work/dist/Scout.app",
      menu: { enabled: false, bundlePath: "/work/dist/ScoutMenu.app" },
    });
  });

  test("the helper follows the declared app unless it is named itself", () => {
    expect(resolveMenuHelperBundlePath(normalizeAppsSettings({ scoutAppPath: "/work/dist/Scout.app" })))
      .toBe("/work/dist/Scout.app/Contents/Library/LoginItems/ScoutMenu.app");
    expect(resolveMenuHelperBundlePath(normalizeAppsSettings({
      scoutAppPath: "/work/dist/Scout.app",
      menu: { bundlePath: "/other/ScoutMenu.app" },
    }))).toBe("/other/ScoutMenu.app");
  });

  test("drops relative paths and wrong types instead of guessing", () => {
    expect(normalizeAppsSettings({ scoutAppPath: "dist/Scout.app", menu: { enabled: "no", bundlePath: 3 } }))
      .toEqual(defaultAppsSettings());
    expect(normalizeAppsSettings("apps")).toEqual(defaultAppsSettings());
  });
});

describe("createAppsSettingsReader", () => {
  let root: string;
  let settingsPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "apps-settings-"));
    settingsPath = join(root, "settings.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(value: unknown, mtimeSeconds: number): void {
    writeFileSync(settingsPath, typeof value === "string" ? value : JSON.stringify(value));
    utimesSync(settingsPath, mtimeSeconds, mtimeSeconds);
  }

  test("a missing file gives the defaults", () => {
    expect(createAppsSettingsReader(settingsPath)()).toEqual(defaultAppsSettings());
  });

  test("rereads on change and keeps the last good value through a bad write", () => {
    const read = createAppsSettingsReader(settingsPath);
    write({ version: 1, apps: { scoutAppPath: "/a/Scout.app" } }, 1_000);
    expect(read().scoutAppPath).toBe("/a/Scout.app");

    write("{ half a write", 2_000);
    expect(read().scoutAppPath).toBe("/a/Scout.app");

    write({ version: 1, apps: { scoutAppPath: "/b/Scout.app" } }, 3_000);
    expect(read().scoutAppPath).toBe("/b/Scout.app");

    rmSync(settingsPath);
    expect(read()).toEqual(defaultAppsSettings());
  });

  test("does not reparse an unchanged file", () => {
    const read = createAppsSettingsReader(settingsPath);
    write({ apps: { scoutAppPath: "/a/Scout.app" } }, 1_000);
    const first = read();
    expect(read()).toBe(first);
  });
});
