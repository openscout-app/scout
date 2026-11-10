import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

/**
 * Which apps this host runs on top of the Scout service, as `apps` in
 * settings.json.
 *
 * The service runs on its own, and any number of Scout.app builds can run on
 * top of it: the installed one in /Applications, and development builds from a
 * checkout. Nothing here describes those builds. It names only the defaults the
 * service itself uses: the Scout.app it treats as the host's app, and the menu
 * bar helper it keeps running.
 */
export type OpenScoutAppsSettings = {
  /** The host's Scout.app bundle. Null means /Applications/Scout.app. */
  scoutAppPath: string | null;
  /** The menu bar helper the service keeps running. */
  menu: {
    enabled: boolean;
    /** The helper bundle to run. Null means the helper inside `scoutAppPath`. */
    bundlePath: string | null;
  };
};

export const DEFAULT_SCOUT_APP_PATH = "/Applications/Scout.app";
export const EMBEDDED_MENU_HELPER_RELATIVE_PATH = join("Contents", "Library", "LoginItems", "ScoutMenu.app");

export function defaultAppsSettings(): OpenScoutAppsSettings {
  return {
    scoutAppPath: null,
    menu: {
      enabled: true,
      bundlePath: null,
    },
  };
}

/** An absolute bundle path, or null. A relative path has no fixed meaning for a service. */
function normalizeBundlePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || !isAbsolute(trimmed)) return null;
  return normalize(trimmed).replace(/\/+$/u, "");
}

export function normalizeAppsSettings(value: unknown): OpenScoutAppsSettings {
  const base = defaultAppsSettings();
  const apps = typeof value === "object" && value ? value as Record<string, unknown> : {};
  const menu = typeof apps.menu === "object" && apps.menu ? apps.menu as Record<string, unknown> : {};
  return {
    scoutAppPath: normalizeBundlePath(apps.scoutAppPath),
    menu: {
      enabled: typeof menu.enabled === "boolean" ? menu.enabled : base.menu.enabled,
      bundlePath: normalizeBundlePath(menu.bundlePath),
    },
  };
}

/** The host's Scout.app: the declared one, or /Applications/Scout.app. */
export function resolveScoutAppPath(settings: OpenScoutAppsSettings): string {
  return settings.scoutAppPath ?? DEFAULT_SCOUT_APP_PATH;
}

/** The helper the service runs: the declared bundle, or the one inside the host's Scout.app. */
export function resolveMenuHelperBundlePath(settings: OpenScoutAppsSettings): string {
  return settings.menu.bundlePath ?? join(resolveScoutAppPath(settings), EMBEDDED_MENU_HELPER_RELATIVE_PATH);
}

/**
 * Reads `apps` from settings.json, parsing again only when the file changes.
 *
 * The service checks this every few seconds, and settings.json also carries
 * large sections it does not need. A missing or unreadable file gives the
 * defaults; a file that fails to parse keeps the last good value.
 */
export function createAppsSettingsReader(settingsPath: string): () => OpenScoutAppsSettings {
  let cachedMtimeMs: number | null = null;
  let cached = defaultAppsSettings();
  return () => {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(settingsPath).mtimeMs;
    } catch {
      cachedMtimeMs = null;
      cached = defaultAppsSettings();
      return cached;
    }
    if (mtimeMs === cachedMtimeMs) return cached;
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown> | null;
      cached = normalizeAppsSettings(parsed && typeof parsed === "object" ? parsed.apps : undefined);
      cachedMtimeMs = mtimeMs;
    } catch {
      // A write in progress or a hand edit with a typo: keep the last good value
      // and try again on the next read.
    }
    return cached;
  };
}
