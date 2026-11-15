import { describe, expect, test } from "bun:test";

import type { LifecycleProcess, LifecycleTree } from "../app-lifecycle.ts";
import { lifecycleProblems, parseAppCommand, runAppCommand, selectInstalledAppBundle, startTreeReady } from "./app.ts";

function process(layer: LifecycleProcess["layer"], pid: number): LifecycleProcess {
  return {
    pid,
    ppid: 1,
    command: layer,
    args: layer,
    executable: layer,
    elapsedSeconds: 1,
    layer,
    canonical: true,
    superseded: false,
  };
}

function treeWith(input: {
  owned?: LifecycleProcess[];
  foreign?: LifecycleProcess[];
} = {}): LifecycleTree {
  const layers: LifecycleTree["layers"] = {
    scoutd: [],
    base: [],
    probes: [],
    broker: [],
    edge: [],
    web: [],
    app: [],
    menu: [],
    pairing: [],
    bridge: [],
  };
  for (const entry of input.owned ?? []) layers[entry.layer].push(entry);
  return {
    layers,
    foreign: input.foreign ?? [],
    expected: {
      appBundlePath: "/repo/Scout.app",
      menuBundlePath: "/repo/ScoutMenu.app",
      appExecutable: "/repo/Scout.app/Scout",
      menuExecutable: "/repo/ScoutMenu.app/ScoutMenu",
      serviceRoot: "/repo",
    },
  };
}

describe("lifecycleProblems", () => {
  test("does not fail stop because a sibling checkout is still running", () => {
    const foreign = { ...process("app", 900), canonical: false };
    expect(lifecycleProblems("stop", "all", treeWith({ foreign: [foreign] }))).toEqual([]);
  });

  test("fails stop when one of our targeted processes survives", () => {
    expect(lifecycleProblems("stop", "all", treeWith({ owned: [process("broker", 300)] })))
      .toEqual(["broker pid 300 is still running after stop"]);
  });

  test("fails stop when an owned service survives after its scoutd root exits", () => {
    const detached = {
      ...process("broker", 301),
      args: "scout-broker run /repo/packages/runtime/bin/openscout-runtime.mjs broker",
      canonical: false,
    };
    expect(lifecycleProblems("stop", "all", treeWith({ foreign: [detached] })))
      .toEqual(["broker pid 301 is still running after stop"]);
  });

  test("apps-only stop ignores intentionally running services", () => {
    expect(lifecycleProblems("stop", "apps", treeWith({ owned: [process("broker", 300)] })))
      .toEqual([]);
  });

  test("status fails for a detached process from this checkout", () => {
    const detached = {
      ...process("broker", 301),
      args: "scout-broker run /repo/packages/runtime/bin/openscout-runtime.mjs broker",
      canonical: false,
    };
    expect(lifecycleProblems("status", "all", treeWith({ foreign: [detached] })))
      .toEqual([
        "broker pid 301 references this checkout but is detached from its expected process tree: broker",
      ]);
  });
});

describe("startTreeReady", () => {
  const supervisedProcesses = [
    process("scoutd", 100),
    process("base", 101),
    process("probes", 102),
    process("broker", 103),
    process("edge", 104),
    process("pairing", 105),
  ];
  const appProcesses = [process("app", 200), process("menu", 201)];

  test("keeps a full start waiting when the web child is still missing", () => {
    expect(startTreeReady(treeWith({
      owned: [...supervisedProcesses, ...appProcesses],
    }), "all")).toBe(false);
  });

  test("accepts a full start only after the complete supervised tree is present", () => {
    expect(startTreeReady(treeWith({
      owned: [...supervisedProcesses, process("web", 106), ...appProcesses],
    }), "all")).toBe(true);
  });

  test("keeps apps-only starts scoped to Scout and its menu helper", () => {
    expect(startTreeReady(treeWith({ owned: appProcesses }), "apps")).toBe(true);
  });
});

describe("selectInstalledAppBundle", () => {
  test("prefers the conventional installed app over Spotlight worktree matches", () => {
    const installed = "/Applications/OpenScout.app";
    const existing = new Set([
      installed,
      "/Users/you/dev/openscout/apps/macos/dist/Scout.app",
    ]);

    expect(selectInstalledAppBundle(
      [...existing].reverse(),
      "/Users/you",
      (path) => existing.has(path),
    )).toBe(installed);
  });

  test("never treats a repo-built Scout.app as an installed fallback", () => {
    const worktreeBuild = "/Users/you/dev/openscout/apps/macos/dist/Scout.app";

    expect(selectInstalledAppBundle(
      [worktreeBuild],
      "/Users/you",
      (path) => path === worktreeBuild,
    )).toBeNull();
  });

  test("accepts a relocated OpenScout.app when no conventional install exists", () => {
    const relocated = "/Volumes/Apps/OpenScout.app";

    expect(selectInstalledAppBundle(
      [relocated],
      "/Users/you",
      (path) => path === relocated,
    )).toBe(relocated);
  });
});

describe("parseAppCommand", () => {
  test("restart waits for in-flight work by default", () => {
    const command = parseAppCommand(["restart"]);
    expect(command.action).toBe("restart");
    expect(command.now).toBe(false);
    expect(command.drainTimeoutMs).toBe(30 * 60_000);
  });

  test("--now and --timeout are parsed, and the timeout value is not a subcommand", () => {
    expect(parseAppCommand(["restart", "--now"]).now).toBe(true);
    expect(parseAppCommand(["restart", "--timeout", "90s"]).drainTimeoutMs).toBe(90_000);
    expect(parseAppCommand(["--timeout=2h", "stop"])).toMatchObject({ action: "stop", drainTimeoutMs: 7_200_000 });
  });

  test("rejects an unreadable --timeout", () => {
    expect(() => parseAppCommand(["restart", "--timeout", "soon"])).toThrow("invalid --timeout");
  });
});

describe("runAppCommand help", () => {
  test("--help after a verb prints help instead of running the verb", async () => {
    const written: string[] = [];
    const context = {
      output: {
        writeText: (text: string) => written.push(text),
        writeValue: () => { throw new Error("lifecycle verb ran"); },
      },
    } as unknown as Parameters<typeof runAppCommand>[0];
    await runAppCommand(context, ["restart", "--help"]);
    expect(written[0]).toContain("scout app — OpenScout application lifecycle");
  });
});

test("app rejects unsupported flags and extra actions before lifecycle work", () => {
  for (const args of [["restart", "--unsupported"], ["stop", "-x"], ["start", "restart"]]) {
    expect(() => parseAppCommand(args)).toThrow("unexpected");
  }
});
