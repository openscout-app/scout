import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultAppsSettings, normalizeAppsSettings } from "./apps-settings.ts";
import {
  MENU_HELPER_CRASH_REPORT_WAIT_MS,
  MENU_HELPER_LAUNCH_GRACE_MS,
  MENU_HELPER_RESTART_MAX_DELAY_MS,
  MENU_HELPER_STABLE_AFTER_MS,
  MenuHelperSupervisor,
  findMenuHelperProcesses,
  hasMenuHelperCrashReport,
  resolveMenuHelperDesiredState,
  type MenuHelperDesiredState,
  type ProcessCommand,
} from "./menu-helper-supervisor.ts";

const INSTALLED_HELPER = "/Applications/Scout.app/Contents/Library/LoginItems/ScoutMenu.app";
const DEV_APP = "/work/checkout/apps/macos/dist/Scout.app";
const DEV_HELPER = `${DEV_APP}/Contents/Library/LoginItems/ScoutMenu.app`;
const OTHER_HELPER = "/work/other-checkout/apps/macos/dist/Scout.app/Contents/Library/LoginItems/ScoutMenu.app";

function desired(overrides: Partial<Parameters<typeof resolveMenuHelperDesiredState>[0]> = {}): MenuHelperDesiredState {
  return resolveMenuHelperDesiredState({
    settings: defaultAppsSettings(),
    env: {},
    platform: "darwin",
    isProd: true,
    exists: () => true,
    ...overrides,
  });
}

describe("resolveMenuHelperDesiredState", () => {
  test("runs the installed app's helper by default", () => {
    expect(desired()).toEqual({ run: true, bundlePath: INSTALLED_HELPER, source: "settings" });
  });

  test("runs the helper inside the declared app", () => {
    expect(desired({ settings: normalizeAppsSettings({ scoutAppPath: DEV_APP }) }))
      .toEqual({ run: true, bundlePath: DEV_HELPER, source: "settings" });
  });

  test("off the Mac, by env, or in settings, it runs nothing", () => {
    expect(desired({ platform: "linux" })).toEqual({ run: false, reason: "not-macos" });
    expect(desired({ env: { OPENSCOUT_BASE_MENU_ENABLED: "0" } })).toEqual({ run: false, reason: "disabled-by-env" });
    expect(desired({ settings: normalizeAppsSettings({ menu: { enabled: false } }) }))
      .toEqual({ run: false, reason: "disabled-in-settings" });
  });

  test("an absolute env path wins over settings; a relative one is ignored", () => {
    expect(desired({ env: { OPENSCOUT_MENU_BUNDLE_PATH: "/x/ScoutMenu.app/" } }))
      .toEqual({ run: true, bundlePath: "/x/ScoutMenu.app", source: "env" });
    expect(desired({ env: { OPENSCOUT_MENU_BUNDLE_PATH: "ScoutMenu.app" } }))
      .toEqual({ run: true, bundlePath: INSTALLED_HELPER, source: "settings" });
  });

  test("a missing bundle is reported, never replaced by another copy", () => {
    expect(desired({ exists: () => false }))
      .toEqual({ run: false, reason: "bundle-missing", bundlePath: INSTALLED_HELPER, source: "settings" });
  });

  test("a development instance runs a helper only when one is declared", () => {
    expect(desired({ isProd: false })).toEqual({ run: false, reason: "not-declared" });
    expect(desired({ isProd: false, settings: normalizeAppsSettings({ scoutAppPath: DEV_APP }) }))
      .toEqual({ run: true, bundlePath: DEV_HELPER, source: "settings" });
    expect(desired({ isProd: false, env: { OPENSCOUT_MENU_BUNDLE_PATH: DEV_HELPER } }))
      .toEqual({ run: true, bundlePath: DEV_HELPER, source: "env" });
  });
});

describe("findMenuHelperProcesses", () => {
  test("matches the executable inside this bundle only", () => {
    const rows: ProcessCommand[] = [
      { pid: 1, command: `${DEV_HELPER}/Contents/MacOS/ScoutMenu` },
      { pid: 2, command: `${OTHER_HELPER}/Contents/MacOS/ScoutMenu` },
      { pid: 3, command: `${DEV_APP}/Contents/MacOS/Scout` },
      { pid: 4, command: `claude --prompt "look at ${DEV_HELPER}/Contents/MacOS/ScoutMenu"` },
      { pid: 5, command: `${DEV_HELPER}-old/Contents/MacOS/ScoutMenu` },
    ];
    expect(findMenuHelperProcesses(rows, [DEV_HELPER]).map((row) => row.pid)).toEqual([1]);
    expect(findMenuHelperProcesses(rows, ["/nowhere", DEV_HELPER]).map((row) => row.pid)).toEqual([1]);
  });
});

describe("hasMenuHelperCrashReport", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "menu-crash-reports-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  // The shape macOS writes: a JSON header line, then a JSON body with the pid
  // and an anonymized path.
  function report(name: string, pid: number, mtimeSeconds: number): void {
    const path = join(directory, name);
    writeFileSync(path, `{"app_name":"ScoutMenu","bug_type":"309"}\n{\n  "pid" : ${pid},\n  "procPath" : "\\/Users\\/USER\\/*\\/ScoutMenu.app\\/Contents\\/MacOS\\/ScoutMenu"\n}\n`);
    utimesSync(path, mtimeSeconds, mtimeSeconds);
  }

  const check = (pid: number, sinceMs: number) => hasMenuHelperCrashReport({ pid, bundlePath: DEV_HELPER, sinceMs, directory });

  test("finds a report for this pid written after the helper was seen", () => {
    report("ScoutMenu-2026-11-08-131750.ips", 4242, 2_000);
    expect(check(4242, 1_000_000)).toBe(true);
  });

  test("ignores older reports, other pids and other processes", () => {
    report("ScoutMenu-2026-11-08-120000.ips", 4242, 500);
    report("ScoutMenu-2026-11-08-131750.ips", 42420, 2_000);
    report("Scout-2026-11-08-131750.ips", 4242, 2_000);
    report("ScoutMenu-2026-11-08-131751.spin", 4242, 2_000);
    expect(check(4242, 1_000_000)).toBe(false);
  });

  test("a missing folder means no crash", () => {
    expect(hasMenuHelperCrashReport({ pid: 1, bundlePath: DEV_HELPER, sinceMs: 0, directory: join(directory, "missing") })).toBe(false);
  });
});

function harness(initial: { desired?: MenuHelperDesiredState } = {}) {
  let t = 1_000_000;
  const state = {
    desired: initial.desired ?? ({ run: true, bundlePath: DEV_HELPER, source: "settings" } as MenuHelperDesiredState),
    processes: [] as ProcessCommand[],
    alive: new Set<number>(),
    crashed: new Set<number>(),
    opens: [] as string[],
    openResult: { ok: true } as { ok: true } | { ok: false; detail: string },
    listCalls: 0,
    logs: [] as string[],
    warnings: [] as string[],
  };
  const supervisor = new MenuHelperSupervisor({
    desiredState: () => state.desired,
    listProcesses: async () => {
      state.listCalls += 1;
      return state.processes;
    },
    isAlive: (pid) => state.alive.has(pid),
    crashed: ({ pid }) => state.crashed.has(pid),
    open: async (bundlePath) => {
      state.opens.push(bundlePath);
      return state.openResult;
    },
    now: () => t,
    log: (message) => state.logs.push(message),
    warn: (message) => state.warnings.push(message),
  });
  const helper = (pid: number, bundlePath = DEV_HELPER) => {
    state.processes = [{ pid, command: `${bundlePath}/Contents/MacOS/ScoutMenu` }];
    state.alive = new Set([pid]);
  };
  const exit = (options: { crash?: boolean } = {}) => {
    for (const pid of state.alive) if (options.crash) state.crashed.add(pid);
    state.processes = [];
    state.alive = new Set();
  };
  return { supervisor, state, helper, exit, advance: (ms: number) => { t += ms; } };
}

describe("MenuHelperSupervisor", () => {
  test("adopts a helper that is already running instead of opening another", async () => {
    const h = harness();
    h.helper(42);
    expect(await h.supervisor.reconcile()).toEqual({ action: "running", pid: 42 });
    expect(h.state.opens).toEqual([]);
  });

  test("checks a tracked helper by pid, without scanning the process table", async () => {
    const h = harness();
    h.helper(42);
    await h.supervisor.reconcile();
    const scans = h.state.listCalls;
    h.advance(5_000);
    expect(await h.supervisor.reconcile()).toEqual({ action: "running", pid: 42 });
    expect(h.state.listCalls).toBe(scans);
  });

  test("leaves another bundle's helper alone and starts its own", async () => {
    const h = harness();
    h.helper(7, OTHER_HELPER);
    expect(await h.supervisor.reconcile()).toEqual({ action: "launched", bundlePath: DEV_HELPER });
    expect(h.state.opens).toEqual([DEV_HELPER]);
  });

  test("opens once per grace window while the helper starts", async () => {
    const h = harness();
    expect((await h.supervisor.reconcile()).action).toBe("launched");
    h.advance(5_000);
    expect((await h.supervisor.reconcile()).action).toBe("waiting");
    h.advance(5_000);
    expect((await h.supervisor.reconcile()).action).toBe("waiting");
    h.helper(42);
    expect(await h.supervisor.reconcile()).toEqual({ action: "running", pid: 42 });
    expect(h.state.opens).toHaveLength(1);
  });

  test("a helper that crashes comes back", async () => {
    const h = harness();
    h.helper(42);
    await h.supervisor.reconcile();
    h.advance(5_000);
    h.exit({ crash: true });
    expect(await h.supervisor.reconcile()).toEqual({ action: "launched", bundlePath: DEV_HELPER });
    expect(h.state.warnings).toContain("menu helper crashed; restarting it");
  });

  test("waits for a late crash report before deciding", async () => {
    const h = harness();
    h.helper(42);
    await h.supervisor.reconcile();
    h.exit();
    h.advance(5_000);
    expect(await h.supervisor.reconcile()).toEqual({ action: "exited", pid: 42 });
    h.state.crashed.add(42);
    h.advance(3_000);
    expect((await h.supervisor.reconcile()).action).toBe("launched");
  });

  test("a helper that quits stays down until it is opened again", async () => {
    const h = harness();
    h.helper(42);
    await h.supervisor.reconcile();
    h.exit();
    h.advance(5_000);
    expect((await h.supervisor.reconcile()).action).toBe("exited");
    h.advance(MENU_HELPER_CRASH_REPORT_WAIT_MS);
    expect(await h.supervisor.reconcile()).toEqual({ action: "stopped", bundlePath: DEV_HELPER });
    h.advance(MENU_HELPER_RESTART_MAX_DELAY_MS);
    expect((await h.supervisor.reconcile()).action).toBe("stopped");
    expect(h.state.opens).toEqual([]);

    // The person opens it again; it is supervised from then on.
    h.helper(43);
    expect(await h.supervisor.reconcile()).toEqual({ action: "running", pid: 43 });
    h.advance(5_000);
    h.exit({ crash: true });
    expect((await h.supervisor.reconcile()).action).toBe("launched");
  });

  test("a helper that never shows up is opened again, backing off", async () => {
    const h = harness();
    const launchTimes: number[] = [];
    let elapsed = 0;
    for (let i = 0; i < 200; i += 1) {
      const outcome = await h.supervisor.reconcile();
      if (outcome.action === "launched") launchTimes.push(elapsed);
      h.advance(5_000);
      elapsed += 5_000;
    }
    const gaps = launchTimes.slice(1).map((value, index) => value - launchTimes[index]!);
    expect(gaps[0]).toBe(MENU_HELPER_LAUNCH_GRACE_MS);
    expect(gaps[1]).toBe(2 * MENU_HELPER_LAUNCH_GRACE_MS);
    expect(Math.max(...gaps)).toBe(MENU_HELPER_RESTART_MAX_DELAY_MS);
  });

  test("a helper that stays up resets the backoff", async () => {
    const h = harness();
    for (let pid = 1; pid <= 3; pid += 1) {
      await h.supervisor.reconcile();
      h.helper(pid);
      await h.supervisor.reconcile();
      h.exit({ crash: true });
      h.advance(MENU_HELPER_RESTART_MAX_DELAY_MS);
    }
    await h.supervisor.reconcile();
    h.helper(42);
    await h.supervisor.reconcile();
    h.advance(MENU_HELPER_STABLE_AFTER_MS);
    await h.supervisor.reconcile();
    h.exit({ crash: true });
    expect((await h.supervisor.reconcile()).action).toBe("launched");
    h.advance(MENU_HELPER_LAUNCH_GRACE_MS);
    expect((await h.supervisor.reconcile()).action).toBe("launched");
  });

  test("a failed open is reported and retried after the delay", async () => {
    const h = harness();
    h.state.openResult = { ok: false, detail: "LSOpenURLsWithRole() failed" };
    expect(await h.supervisor.reconcile()).toEqual({
      action: "launch-failed",
      bundlePath: DEV_HELPER,
      detail: "LSOpenURLsWithRole() failed",
    });
    h.advance(MENU_HELPER_LAUNCH_GRACE_MS);
    h.state.openResult = { ok: true };
    expect((await h.supervisor.reconcile()).action).toBe("launched");
  });

  test("a new target leaves the old helper running and starts the new one", async () => {
    const h = harness({ desired: { run: true, bundlePath: INSTALLED_HELPER, source: "settings" } });
    h.helper(42, INSTALLED_HELPER);
    await h.supervisor.reconcile();
    h.state.desired = { run: true, bundlePath: DEV_HELPER, source: "settings" };
    expect(await h.supervisor.reconcile()).toEqual({ action: "launched", bundlePath: DEV_HELPER });
    expect(h.state.alive.has(42)).toBe(true);
  });

  test("when nothing should run it opens nothing and reports the reason once", async () => {
    const h = harness({ desired: { run: false, reason: "bundle-missing", bundlePath: INSTALLED_HELPER, source: "settings" } });
    expect(await h.supervisor.reconcile()).toEqual({ action: "idle", reason: "bundle-missing" });
    h.advance(5_000);
    await h.supervisor.reconcile();
    expect(h.state.opens).toEqual([]);
    expect(h.state.warnings).toHaveLength(1);
    expect(h.state.listCalls).toBe(0);
  });
});
