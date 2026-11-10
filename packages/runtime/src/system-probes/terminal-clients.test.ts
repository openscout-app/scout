import { describe, expect, test } from "bun:test";

import { herdrClientRefs, parseHerdrClientSession, withHerdrPaneBranches, parseHerdrTopology } from "./herdr.js";
import { parseTmuxClientList } from "./tmux.js";
import {
  buildClientProcessTable,
  findAppAncestor,
  macAppDisplayName,
  outermostAppBundle,
  parseLaunchctlList,
  parseLsappinfoList,
  summarizeTerminalClients,
  type ClientProcessTable,
  type MacAppIndex,
} from "./terminal-clients.js";

// Fixtures use invented apps and paths only.
const LSAPPINFO_FIXTURE = [
  ` 1) "loginwindow" ASN:0x0-0x1001: `,
  `    bundleID="com.example.loginwindow"`,
  `    bundle path="/System/Library/CoreServices/loginwindow.app"`,
  `    executable path="/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow"`,
  `    pid = 100 type="UIElement" flavor=3 Version="1" fileType="APPL" creator="????" Arch=ARM64 `,
  `    coalition: 100`,
  ` 2) "Example Term" ASN:0x0-0x2002: (in front) `,
  `    bundleID="com.example.term"`,
  `    bundle path="/Applications/Example Term.app"`,
  `    executable path="/Applications/Example Term.app/Contents/MacOS/Example Term"`,
  `    pid = 200 type="Foreground" flavor=3 Version="1.0" fileType="APPL" creator="????" Arch=ARM64 `,
  `    parentASN="loginwindow" ASN:0x0-0x1001: `,
  ` 3) "Grid Beta" ASN:0x0-0x3003: `,
  `    bundleID="com.example.grid"`,
  `    bundle path="/Applications/Grid Beta.app"`,
  `    executable path="/Applications/Grid Beta.app/Contents/MacOS/Grid"`,
  `    pid = 300 type="Foreground" flavor=2 Version="2" fileType="APPL" creator="????" Arch=ARM64 `,
  `    loadedJobs:"com.example.unrelated" "com.example.grid.server.abc123" `,
  `    parentASN="loginwindow" ASN:0x0-0x1001: `,
  ` 4) "Pane Agent" ASN:0x0-0x4004: `,
  `    bundleID="com.example.pane.agent"`,
  `    bundle path="/Applications/Pane.app/Contents/Library/Pane Agent.app"`,
  `    executable path="/Applications/Pane.app/Contents/Library/Pane Agent.app/Contents/MacOS/Pane Agent"`,
  `    pid = 450 type="UIElement" flavor=3 Version="1" fileType="APPL" creator="????" Arch=ARM64 `,
  `    parentASN="Pane" ASN:0x0-0x5005: `,
  ` 5) "Pane" ASN:0x0-0x5005: `,
  `    bundleID="com.example.pane"`,
  `    bundle path="/Applications/Pane.app"`,
  `    executable path="/Applications/Pane.app/Contents/MacOS/Pane"`,
  `    pid = 500 type="Foreground" flavor=3 Version="1" fileType="APPL" creator="????" Arch=ARM64 `,
  ` 6) "nameless" ASN:0x0-0x6006: `,
  `    bundleID=[ NULL ] `,
  `    bundle path="/usr/libexec/nameless"`,
  `    pid = 600 !signalled type="BackgroundOnly" flavor=3 Version=[ NULL ]  fileType="????" creator="????" Arch=ARM64 `,
].join("\n");

const LAUNCHCTL_FIXTURE = [
  "PID\tStatus\tLabel",
  "-\t0\tcom.example.idle",
  "300\t0\tapplication.com.example.grid.1.2",
  "310\t0\tcom.example.grid.server.abc123",
  "320\t0\tcom.example.orphan",
].join("\n");

function index(): MacAppIndex {
  return { apps: parseLsappinfoList(LSAPPINFO_FIXTURE), launchdLabels: parseLaunchctlList(LAUNCHCTL_FIXTURE) };
}

/** pid → [ppid, comm, command] */
function table(rows: Record<number, [number, string, string?]>): ClientProcessTable {
  return buildClientProcessTable(
    Object.entries(rows).map(([pid, [ppid, comm]]) => ({ pid: Number(pid), ppid, pgid: Number(pid), tty: null, comm })),
    Object.entries(rows).map(([pid, [ppid, comm, command]]) => ({ pid: Number(pid), ppid, pgid: Number(pid), tty: null, comm, command: command ?? comm })),
  );
}

describe("herdr client command parse", () => {
  test("recognizes every client form and the session it attaches to", () => {
    expect(parseHerdrClientSession("herdr")).toBe("default");
    expect(parseHerdrClientSession("/usr/local/bin/herdr")).toBe("default");
    expect(parseHerdrClientSession("herdr --session work")).toBe("work");
    expect(parseHerdrClientSession("herdr -s work")).toBe("work");
    expect(parseHerdrClientSession("herdr --session=work")).toBe("work");
    expect(parseHerdrClientSession("/opt/bin/herdr session attach work")).toBe("work");
    expect(parseHerdrClientSession("herdr --session default")).toBe("default");
  });

  test("rejects servers, one-shot commands and other binaries", () => {
    for (const command of [
      "herdr server",
      "herdr --session work server",
      "herdr session list",
      "herdr session list --json",
      "herdr session attach",
      "herdr --session work pane list",
      "herdr --version",
      "herdr -V",
      "herdr --help",
      "herdr --remote build-box",
      "herdr --machine build-box agent list",
      "herdr --session",
      "herdr --session=",
      "herdr --session --version",
      "herdr status",
      "herdr-helper",
      "/usr/bin/herdrx --session work",
      "vim herdr",
      "",
    ]) {
      expect(parseHerdrClientSession(command)).toBeNull();
    }
  });

  test("collects client refs from command rows", () => {
    expect(herdrClientRefs([
      { pid: 11, command: "/usr/local/bin/herdr session attach work" },
      { pid: 12, command: "/usr/local/bin/herdr server" },
      { pid: 13, command: "herdr" },
      { pid: 14, command: "-zsh" },
    ])).toEqual([{ pid: 11, session: "work" }, { pid: 13, session: "default" }]);
  });

  test("uses the executable to keep a herdr path that holds a space together", () => {
    const bin = "/workspace/my tools/bin/herdr";
    expect(parseHerdrClientSession(`${bin} --session work`, bin)).toBe("work");
    expect(parseHerdrClientSession(`${bin} session attach work`, bin)).toBe("work");
    expect(parseHerdrClientSession(bin, bin)).toBe("default");
    expect(parseHerdrClientSession(`${bin} server`, bin)).toBeNull();
    expect(parseHerdrClientSession("/workspace/my tools/bin/vim herdr", "/workspace/my tools/bin/vim")).toBeNull();
    // Without the executable, the split stops at the space and finds no herdr.
    expect(parseHerdrClientSession(`${bin} --session work`)).toBeNull();
    // A short kernel name (Linux) does not begin the line, so the split is used.
    expect(parseHerdrClientSession(`${bin} --session work`, "herdr")).toBeNull();
    expect(parseHerdrClientSession("/usr/local/bin/herdr --session work", "herdr")).toBe("work");
    // An executable that is only a prefix of the first word is not used.
    expect(parseHerdrClientSession("/workspace/bin/herdrx --session work", "/workspace/bin/herdr")).toBeNull();
  });

  test("collects client refs whose herdr path holds a space from the process table", () => {
    const processes = table({
      21: [1, "/workspace/my tools/bin/herdr", "/workspace/my tools/bin/herdr --session work"],
      22: [1, "/workspace/my tools/bin/herdr", "/workspace/my tools/bin/herdr server"],
      23: [1, "-zsh"],
    });
    const rows = [...processes].map(([pid, entry]) => ({ pid, command: entry.command ?? "" }));
    expect(herdrClientRefs(rows, processes)).toEqual([{ pid: 21, session: "work" }]);
    expect(herdrClientRefs(rows)).toEqual([]);
  });
});

describe("tmux client list parse", () => {
  test("keeps pid and session, skips malformed lines", () => {
    expect(parseTmuxClientList("101\tmain\n102\tside pane\n\nnot-a-pid\tmain\n0\tmain\n103\t\n104\n")).toEqual([
      { pid: 101, session: "main" },
      { pid: 102, session: "side pane" },
    ]);
  });
});

describe("lsappinfo and launchctl parse", () => {
  test("reads names, pids, types, parents and loaded jobs", () => {
    const apps = parseLsappinfoList(LSAPPINFO_FIXTURE);
    expect(apps.map((app) => app.name)).toEqual(["loginwindow", "Example Term", "Grid Beta", "Pane Agent", "Pane", "nameless"]);
    expect(apps[1]).toEqual({
      name: "Example Term",
      asn: "ASN:0x0-0x2002",
      bundleId: "com.example.term",
      bundlePath: "/Applications/Example Term.app",
      executablePath: "/Applications/Example Term.app/Contents/MacOS/Example Term",
      pid: 200,
      type: "Foreground",
      parentAsn: "ASN:0x0-0x1001",
      loadedJobs: [],
    });
    expect(apps[2]?.loadedJobs).toEqual(["com.example.unrelated", "com.example.grid.server.abc123"]);
    expect(apps[5]).toMatchObject({ bundleId: null, pid: 600, type: "BackgroundOnly", parentAsn: null });
    expect(parseLsappinfoList("")).toEqual([]);
  });

  test("maps running launchd jobs by pid", () => {
    expect([...parseLaunchctlList(LAUNCHCTL_FIXTURE)]).toEqual([
      [300, "application.com.example.grid.1.2"],
      [310, "com.example.grid.server.abc123"],
      [320, "com.example.orphan"],
    ]);
  });
});

describe("client to app mapping", () => {
  test("finds the outermost bundle in an executable path only", () => {
    expect(outermostAppBundle("/Applications/Example Term.app/Contents/MacOS/Example Term")).toBe("/Applications/Example Term.app");
    expect(outermostAppBundle("/Applications/Pane.app/Contents/Frameworks/Pane Helper.app/Contents/MacOS/Pane Helper")).toBe("/Applications/Pane.app");
    expect(outermostAppBundle("/usr/bin/open /Applications/Example Term.app")).toBeNull();
    expect(outermostAppBundle("-zsh")).toBeNull();
    expect(outermostAppBundle(null)).toBeNull();
  });

  test("walks parent pids to the first process inside an app bundle", () => {
    const processes = table({
      200: [1, "/Applications/Example Term.app/Contents/MacOS/Example Term"],
      201: [200, "/usr/bin/login"],
      202: [201, "-zsh"],
      203: [202, "/usr/local/bin/herdr", "/usr/local/bin/herdr session attach work"],
    });
    expect(findAppAncestor(203, processes)).toEqual({ pid: 200, bundlePath: "/Applications/Example Term.app" });
    expect(findAppAncestor(999, processes)).toBeNull();
    // A client outside any app (an ssh login) has no app.
    expect(findAppAncestor(3, table({ 2: [1, "/usr/sbin/sshd"], 3: [2, "-zsh"] }))).toBeNull();
    // A parent loop ends the walk instead of spinning.
    expect(findAppAncestor(5, table({ 5: [6, "-zsh"], 6: [5, "-zsh"] }))).toBeNull();
  });

  test("a visible app names itself", () => {
    expect(macAppDisplayName({ pid: 200, bundlePath: "/Applications/Example Term.app" }, index())).toBe("Example Term");
  });

  test("a windowless helper started by launchd maps to the app that loaded its job", () => {
    const helper = { pid: 310, bundlePath: "/Library/Application Support/com.example.grid/Grid Server.app" };
    expect(macAppDisplayName(helper, index())).toBe("Grid Beta");
  });

  test("a registered helper maps to its LaunchServices parent", () => {
    expect(macAppDisplayName({ pid: 450, bundlePath: "/Applications/Pane.app/Contents/Library/Pane Agent.app" }, index())).toBe("Pane");
  });

  test("without an owner the bundle's own name stands", () => {
    expect(macAppDisplayName({ pid: 320, bundlePath: "/opt/apps/Orphan Helper.app" }, index())).toBe("Orphan Helper");
    expect(macAppDisplayName({ pid: 200, bundlePath: "/Applications/Example Term.app" }, null)).toBe("Example Term");
  });

  test("summarizes one session's clients with de-duplicated apps, and caches the walk by pid", async () => {
    const processes = table({
      200: [1, "/Applications/Example Term.app/Contents/MacOS/Example Term"],
      210: [200, "-zsh"],
      211: [210, "herdr", "herdr --session work"],
      220: [200, "-zsh"],
      221: [220, "herdr", "herdr session attach work"],
      310: [1, "/Library/Application Support/com.example.grid/Grid Server.app/Contents/MacOS/grid", "/Library/Application Support/com.example.grid/Grid Server.app/Contents/MacOS/grid serve"],
      311: [310, "-zsh"],
      312: [311, "herdr", "herdr -s work"],
      400: [1, "/usr/sbin/sshd"],
      401: [400, "herdr", "herdr --session work"],
      501: [200, "herdr", "herdr --session other"],
    });
    const refs = herdrClientRefs([...processes].map(([pid, entry]) => ({ pid, command: entry.command ?? "" })));
    const cache = new Map();
    let indexReads = 0;
    const apps = async () => { indexReads += 1; return index(); };

    const first = await summarizeTerminalClients(refs, "work", { table: processes, apps, platform: "darwin", cache });
    expect(first).toEqual({ clients: 4, apps: ["Example Term", "Grid Beta"] });
    expect(indexReads).toBe(1);
    expect(cache.size).toBe(4);

    const second = await summarizeTerminalClients(refs, "work", { table: processes, apps, platform: "darwin", cache });
    expect(second).toEqual(first);
    expect(indexReads).toBe(1);

    // A recycled pid running something else is walked again.
    processes.set(211, { ppid: 210, comm: "herdr", command: "herdr --session=work" });
    const third = await summarizeTerminalClients(refs, "work", { table: processes, apps, platform: "darwin", cache });
    expect(third).toEqual({ clients: 4, apps: ["Example Term", "Grid Beta"] });
    expect(indexReads).toBe(2);
  });

  test("other platforms count clients and report no apps, without reading an app index", async () => {
    const processes = table({ 200: [1, "/Applications/Example Term.app/Contents/MacOS/Example Term"], 211: [200, "herdr"] });
    let indexReads = 0;
    const summary = await summarizeTerminalClients([{ pid: 211, session: "default" }, { pid: 211, session: "default" }], "default", {
      table: processes,
      apps: async () => { indexReads += 1; return index(); },
      platform: "linux",
      cache: new Map(),
    });
    expect(summary).toEqual({ clients: 1, apps: [] });
    expect(indexReads).toBe(0);
  });

  test("a failed app index falls back to bundle names and is not cached", async () => {
    const processes = table({ 200: [1, "/Applications/Example Term.app/Contents/MacOS/Example Term"], 211: [200, "herdr"] });
    const cache = new Map();
    const summary = await summarizeTerminalClients([{ pid: 211, session: "default" }], "default", {
      table: processes,
      apps: async () => { throw new Error("lsappinfo failed"); },
      platform: "darwin",
      cache,
    });
    expect(summary).toEqual({ clients: 1, apps: ["Example Term"] });
    expect(cache.size).toBe(0);
  });
});

describe("herdr pane branches", () => {
  test("sets gitBranch on panes whose directory was read, foreground cwd first", () => {
    const workspaces = parseHerdrTopology({
      workspaceList: JSON.stringify({ result: { workspaces: [{ workspace_id: "w1" }] } }),
      tabList: JSON.stringify({ result: { tabs: [{ workspace_id: "w1", tab_id: "t1" }] } }),
      paneList: JSON.stringify({ result: { panes: [
        { workspace_id: "w1", tab_id: "t1", pane_id: "p1", cwd: "/repo", foreground_cwd: "/repo/sub" },
        { workspace_id: "w1", tab_id: "t1", pane_id: "p2", cwd: "/plain" },
        { workspace_id: "w1", tab_id: "t1", pane_id: "p3", cwd: "/unread" },
      ] } }),
    });
    const panes = withHerdrPaneBranches(workspaces, new Map([["/repo/sub", "feature"], ["/plain", null]]))[0]!.tabs[0]!.panes;
    expect(panes.map((pane) => [pane.paneId, pane.gitBranch])).toEqual([["p1", "feature"], ["p2", null], ["p3", undefined]]);
    expect("gitBranch" in panes[2]!).toBe(false);
  });
});
