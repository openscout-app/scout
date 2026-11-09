import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHerdrAttachCommand,
  buildHerdrCreateAttachCommand,
  buildHerdrStartServerCommand,
  buildHerdrWorkspaceCreateCommand,
  herdrProbeKey,
  parseHerdrAgentList,
  parseHerdrPersistedTopology,
  parseHerdrSessionListJson,
  parseHerdrSnapshotLayouts,
  parseHerdrTopology,
  readHerdrSessions,
} from "./herdr.js";

describe("herdr session helpers", () => {
  test("parses herdr session list JSON", () => {
    expect(parseHerdrSessionListJson(JSON.stringify({
      sessions: [
        {
          default: true,
          name: "default",
          running: true,
          session_dir: "/Users/you/.config/herdr",
          socket_path: "/Users/you/.config/herdr/herdr.sock",
        },
        {
          default: false,
          name: "scout-local-1",
          running: false,
        },
      ],
    }))).toEqual([
      { name: "default", isDefault: true, running: true, sessionDir: "/Users/you/.config/herdr" },
      { name: "scout-local-1", isDefault: false, running: false, sessionDir: null },
    ]);
  });

  test("survives an unavailable or unparseable herdr", () => {
    expect(parseHerdrSessionListJson("")).toEqual([]);
    expect(parseHerdrSessionListJson("not json")).toEqual([]);
    expect(parseHerdrSessionListJson(JSON.stringify({ sessions: [{ running: true }] }))).toEqual([]);
  });

  test("builds attach commands without socket paths", () => {
    expect(buildHerdrAttachCommand({ name: "default", isDefault: true })).toEqual(["herdr"]);
    expect(buildHerdrAttachCommand({ name: "scout-local-1", isDefault: false })).toEqual([
      "herdr",
      "session",
      "attach",
      "scout-local-1",
    ]);
    expect(buildHerdrCreateAttachCommand("scout-main-1")).toEqual(["herdr", "--session", "scout-main-1"]);
    expect(buildHerdrCreateAttachCommand("  ")).toEqual(["herdr"]);
  });

  test("keys the probe on the environment, not on caller-supplied input", () => {
    // The key is DERIVED from an environment rather than taken from a caller,
    // which is what keeps a browser from steering the probe at an arbitrary
    // socket — the property the old "always 'default'" key was reaching for. It
    // achieved that by making every environment share one cache entry, so a
    // probe of a PATH with no herdr on it was served the inventory collected
    // for a completely different environment.
    const here = herdrProbeKey({ env: { PATH: "/usr/bin", HOME: "/tmp" } as NodeJS.ProcessEnv });
    const elsewhere = herdrProbeKey({ env: { PATH: "/nowhere", HOME: "/tmp" } as NodeJS.ProcessEnv });
    const otherHome = herdrProbeKey({ env: { PATH: "/usr/bin", HOME: "/other" } as NodeJS.ProcessEnv });
    const otherBin = herdrProbeKey({
      env: { PATH: "/usr/bin", HOME: "/tmp", OPENSCOUT_HERDR_BIN: "/opt/herdr" } as NodeJS.ProcessEnv,
    });

    expect(here).toBe(herdrProbeKey({ env: { PATH: "/usr/bin", HOME: "/tmp" } as NodeJS.ProcessEnv }));
    expect(new Set([here, elsewhere, otherHome, otherBin]).size).toBe(4);
    // No socket path appears in a key, whatever a caller puts in the env.
    expect(here).not.toContain(".sock");
    // A bare string key is still accepted and is not a socket either.
    expect(herdrProbeKey("default")).toBe("default");
    expect(herdrProbeKey(null)).toBe(herdrProbeKey({ env: process.env }));
  });
});

describe("herdr session creation argv", () => {
  test("starts a named session headlessly rather than launching a client", () => {
    // `herdr --session <name>` needs a TTY; the server half does not.
    expect(buildHerdrStartServerCommand("scout-desk-1")).toEqual(["herdr", "--session", "scout-desk-1", "server"]);
    expect(buildHerdrStartServerCommand("  ")).toEqual(["herdr", "server"]);
  });

  test("creates the first workspace without stealing focus", () => {
    expect(buildHerdrWorkspaceCreateCommand("scout-desk-1", { cwd: "/repo", label: "Scout" }))
      .toEqual(["herdr", "--session", "scout-desk-1", "workspace", "create", "--cwd", "/repo", "--label", "Scout", "--no-focus"]);
    expect(buildHerdrWorkspaceCreateCommand("scout-desk-1"))
      .toEqual(["herdr", "--session", "scout-desk-1", "workspace", "create", "--no-focus"]);
  });
});

describe("parseHerdrAgentList", () => {
  test("reads host-reported agent state from the socket API JSON", () => {
    expect(parseHerdrAgentList(JSON.stringify({
      id: "cli:agent:list",
      result: {
        type: "agent_list",
        agents: [
          { agent_status: "working", cwd: "/repo", name: "claude", pane_id: "w1:p2", terminal_id: "term_a" },
          { agent_status: "idle", name: "codex", pane_id: "w1:p3" },
          { agent_status: "spinning", name: "scratch", terminal_id: "term_c" },
        ],
      },
    }))).toEqual([
      { target: "w1:p2", name: "claude", status: "working", cwd: "/repo" },
      { target: "w1:p3", name: "codex", status: "idle", cwd: null },
      // A status the schema grows later reads as unknown, never as a guess.
      { target: "term_c", name: "scratch", status: "unknown", cwd: null },
    ]);
  });

  test("is empty when the session server is not running", () => {
    expect(parseHerdrAgentList("")).toEqual([]);
    expect(parseHerdrAgentList("Error: Connection refused")).toEqual([]);
    expect(parseHerdrAgentList(JSON.stringify({ result: { agents: [] } }))).toEqual([]);
  });
});

describe("parseHerdrTopology", () => {
  // Fixtures mirror herdr 0.7.3 CLI output verbatim (`{id, result:{...}}`).
  const workspaceList = JSON.stringify({
    id: "cli:workspace:list",
    result: {
      type: "workspace_list",
      workspaces: [
        {
          active_tab_id: "w2:t1",
          agent_status: "working",
          focused: true,
          label: "OpenScout · herd",
          number: 1,
          pane_count: 4,
          tab_count: 2,
          workspace_id: "w2",
        },
      ],
    },
  });
  const tabList = JSON.stringify({
    id: "cli:tab:list",
    result: {
      type: "tab_list",
      tabs: [
        { agent_status: "working", focused: true, label: "herd", number: 1, pane_count: 3, tab_id: "w2:t1", workspace_id: "w2" },
        { agent_status: "unknown", focused: false, label: "ops", number: 2, pane_count: 1, tab_id: "w2:t2", workspace_id: "w2" },
      ],
    },
  });
  const paneList = JSON.stringify({
    id: "cli:pane:list",
    result: {
      type: "pane_list",
      panes: [
        {
          agent: "claude",
          agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "0a7c0c5c-c3f0-4c50-b141-9d6993c8da75" },
          agent_status: "idle",
          cwd: "/Users/you/dev/openscout",
          focused: false,
          foreground_cwd: "/Users/you/dev/openscout",
          label: "Claude · primary",
          pane_id: "w2:p2",
          scroll: { max_offset_from_bottom: 42, offset_from_bottom: 0, viewport_rows: 69 },
          tab_id: "w2:t1",
          terminal_id: "term_659403fc6aa9f1",
          workspace_id: "w2",
        },
        {
          agent: "kimi",
          agent_status: "working",
          cwd: "/Users/you/dev/openscout",
          focused: true,
          foreground_cwd: "/Users/you/.kimi-code/plugins/managed/action-browser",
          label: "Kimi · K2",
          pane_id: "w2:p5",
          tab_id: "w2:t1",
          terminal_id: "term_659403fc6c5e33",
          workspace_id: "w2",
        },
        {
          agent_status: "unknown",
          cwd: "/Users/you/dev/openscout",
          focused: false,
          foreground_cwd: "/Users/you/dev/openscout",
          label: "scout shell",
          pane_id: "w2:p6",
          tab_id: "w2:t2",
          terminal_id: "term_659403fc6d1694",
          workspace_id: "w2",
        },
      ],
    },
  });

  test("builds the workspace/tab/pane tree from the three list payloads", () => {
    const workspaces = parseHerdrTopology({ workspaceList, tabList, paneList });
    expect(workspaces).toHaveLength(1);
    const [workspace] = workspaces;
    expect(workspace).toMatchObject({
      workspaceId: "w2",
      label: "OpenScout · herd",
      focused: true,
      activeTabId: "w2:t1",
      agentStatus: "working",
    });
    expect(workspace.tabs.map((tab) => tab.label)).toEqual(["herd", "ops"]);

    const [herd, ops] = workspace.tabs;
    expect(herd.panes.map((pane) => [pane.label, pane.agent, pane.agentStatus])).toEqual([
      ["Claude · primary", "claude", "idle"],
      ["Kimi · K2", "kimi", "working"],
    ]);
    expect(herd.panes[1]).toMatchObject({ focused: true, foregroundCwd: "/Users/you/.kimi-code/plugins/managed/action-browser" });
    // Scroll state projects when herdr reports it, and reads as null when the
    // host (or an older herdr) does not.
    expect(herd.panes[0]?.scroll).toEqual({ maxOffsetFromBottom: 42, offsetFromBottom: 0, viewportRows: 69 });
    expect(herd.panes[1]?.scroll).toBeNull();
    expect(ops.panes).toHaveLength(1);
    expect(ops.panes[0]).toMatchObject({ label: "scout shell", agent: null, agentStatus: "unknown" });
  });

  test.each([
    [{ terminal_title_stripped: "Build worker", terminal_title: "● Build worker", label: "legacy" }, "Build worker"],
    [{ terminal_title_stripped: "", terminal_title: "● Build worker", label: "legacy" }, "● Build worker"],
    [{ terminal_title: "● Build worker", label: "legacy" }, "● Build worker"],
    [{ terminal_title_stripped: " ", terminal_title: "", label: "legacy" }, "legacy"],
    [{ label: "legacy" }, "legacy"],
    [{}, null],
  ])("uses available pane titles with legacy fallback: %j", (titles, expected) => {
    const payload = JSON.parse(paneList);
    const pane = payload.result.panes[0];
    delete pane.label;
    Object.assign(pane, titles);
    const [workspace] = parseHerdrTopology({ workspaceList, tabList, paneList: JSON.stringify(payload) });
    expect(workspace.tabs[0]?.panes[0]?.label).toBe(expected);
  });

  test("carries the agent session reference opaquely", () => {
    const [workspace] = parseHerdrTopology({ workspaceList, tabList, paneList });
    expect(workspace.tabs[0]?.panes[0]?.agentSession).toEqual({
      agent: "claude",
      kind: "id",
      source: "herdr:claude",
      value: "0a7c0c5c-c3f0-4c50-b141-9d6993c8da75",
    });
  });

  test("preserves the assigned panel name separately from a changing title", () => {
    const payload = JSON.parse(paneList);
    Object.assign(payload.result.panes[0], { name: "devon-2-openscout", terminal_title_stripped: "Router investigation" });
    const [workspace] = parseHerdrTopology({ workspaceList, tabList, paneList: JSON.stringify(payload) });
    expect(workspace.tabs[0]?.panes[0]).toMatchObject({
      name: "devon-2-openscout", label: "Router investigation",
      agentSession: { agent: "claude", kind: "id", source: "herdr:claude", value: "0a7c0c5c-c3f0-4c50-b141-9d6993c8da75" },
    });
  });

  test("reads an assigned label as the name when herdr also reports a title", () => {
    const payload = JSON.parse(paneList);
    Object.assign(payload.result.panes[2], { label: "help-center", terminal_title_stripped: "~/dev/openscout  ·  main  ·  4.38" });
    const [workspace] = parseHerdrTopology({ workspaceList, tabList, paneList: JSON.stringify(payload) });
    expect(workspace.tabs[1]?.panes[0]).toMatchObject({ name: "help-center", label: "~/dev/openscout  ·  main  ·  4.38" });
    // Without a title, label is an older herdr's title and never a name.
    const [legacy] = parseHerdrTopology({ workspaceList, tabList, paneList });
    expect(legacy.tabs[1]?.panes[0]).toMatchObject({ name: null, label: "scout shell" });
  });

  test("joins names from agent list by terminal and pane rather than title or directory", () => {
    const payload = JSON.parse(paneList);
    const first = payload.result.panes[0];
    const agentList = JSON.stringify({ result: { agents: [
      { terminal_id: first.terminal_id, pane_id: first.pane_id, name: "devon-2-openscout" },
    ] } });
    const parse = (agentList: string) => parseHerdrTopology({ workspaceList, tabList, paneList, agentList })[0]!.tabs[0]!.panes[0]!;
    expect(parse(agentList).name).toBe("devon-2-openscout");
    for (const mismatch of [
      { terminal_id: "replaced", pane_id: first.pane_id },
      { terminal_id: first.terminal_id, pane_id: "w9:p9" },
    ]) {
      expect(parse(JSON.stringify({ result: { agents: [{ ...mismatch, name: "wrong", cwd: first.cwd, label: first.label }] } })).name).toBeNull();
    }
    expect(parse("invalid").name).toBeNull();
  });

  // Mirrors `herdr --session <n> api snapshot` output verbatim.
  const snapshot = JSON.stringify({
    id: "cli:api:snapshot",
    result: {
      snapshot: {
        focused_pane_id: "w2:p5",
        focused_tab_id: "w2:t1",
        focused_workspace_id: "w2",
        layouts: [
          {
            area: { height: 138, width: 251, x: 22, y: 1 },
            focused_pane_id: "w2:p5",
            panes: [
              { focused: false, pane_id: "w2:p2", rect: { height: 69, width: 126, x: 22, y: 1 } },
              { focused: false, pane_id: "w2:p4", rect: { height: 69, width: 126, x: 22, y: 70 } },
              { focused: true, pane_id: "w2:p5", rect: { height: 138, width: 125, x: 148, y: 1 } },
            ],
            splits: [
              { direction: "right", id: "split_0_root", ratio: 0.5, rect: { height: 138, width: 251, x: 22, y: 1 } },
              { direction: "down", id: "split_1_0", ratio: 0.5, rect: { height: 138, width: 126, x: 22, y: 1 } },
            ],
            tab_id: "w2:t1",
            workspace_id: "w2",
            zoomed: false,
          },
        ],
      },
    },
  });

  test("attaches per-tab layout geometry from the api snapshot", () => {
    const [workspace] = parseHerdrTopology({ workspaceList, tabList, paneList, snapshot });
    const [herd, ops] = workspace.tabs;
    expect(herd.layout).toEqual({
      tabId: "w2:t1",
      workspaceId: "w2",
      area: { x: 22, y: 1, width: 251, height: 138 },
      focusedPaneId: "w2:p5",
      zoomed: false,
      panes: [
        { paneId: "w2:p2", focused: false, rect: { x: 22, y: 1, width: 126, height: 69 } },
        { paneId: "w2:p4", focused: false, rect: { x: 22, y: 70, width: 126, height: 69 } },
        { paneId: "w2:p5", focused: true, rect: { x: 148, y: 1, width: 125, height: 138 } },
      ],
      splits: [
        { id: "split_0_root", direction: "right", ratio: 0.5, rect: { x: 22, y: 1, width: 251, height: 138 } },
        { id: "split_1_0", direction: "down", ratio: 0.5, rect: { x: 22, y: 1, width: 126, height: 138 } },
      ],
    });
    // A tab the snapshot does not cover projects without geometry, not dropped.
    expect(ops.layout).toBeNull();
  });

  test("tolerates missing or unparseable snapshots", () => {
    expect(parseHerdrSnapshotLayouts("").size).toBe(0);
    expect(parseHerdrSnapshotLayouts("not json").size).toBe(0);
    expect(parseHerdrSnapshotLayouts(JSON.stringify({ result: { snapshot: {} } })).size).toBe(0);
    const [workspace] = parseHerdrTopology({ workspaceList, tabList, paneList, snapshot: "junk" });
    expect(workspace.tabs.every((tab) => tab.layout === null)).toBe(true);
  });

  test("drops entries without ids and reads unknown statuses as unknown", () => {
    const workspaces = parseHerdrTopology({
      workspaceList,
      tabList: JSON.stringify({ result: { tabs: [{ label: "no ids" }] } }),
      paneList: JSON.stringify({ result: { panes: [{ pane_id: "w2:p9", tab_id: "w2:t1", workspace_id: "w2", agent_status: "spinning" }] } }),
    });
    // The id-less tab is dropped; the pane's tab no longer exists, so it lands nowhere.
    expect(workspaces[0]?.tabs).toEqual([]);
  });

  test("is empty for stopped sessions and unparseable output", () => {
    expect(parseHerdrTopology({})).toEqual([]);
    expect(parseHerdrTopology({ workspaceList: "Error: Connection refused", tabList: "", paneList: "not json" })).toEqual([]);
  });
});

describe("readHerdrSessions environment", () => {
  // Regression: the probe used to force XDG_CONFIG_HOME=HOME when the probed
  // environment had none. herdr resolves its config as $XDG_CONFIG_HOME/herdr
  // and only falls back to ~/.config when XDG is unset, so discovery listed a
  // phantom default under ~/herdr and hid every session the user actually had.
  function stubHerdr(): { env: NodeJS.ProcessEnv; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "herdr-probe-"));
    const bin = join(dir, "herdr-stub");
    writeFileSync(
      bin,
      "#!/bin/sh\nprintf '{\"sessions\":[{\"name\":\"xdg-%s\",\"running\":true}]}' \"${XDG_CONFIG_HOME:-unset}\"\n",
    );
    chmodSync(bin, 0o755);
    return {
      env: { PATH: "/usr/bin:/bin", HOME: dir, OPENSCOUT_HERDR_BIN: bin } as NodeJS.ProcessEnv,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  test("leaves XDG_CONFIG_HOME unset when the probed environment has none", async () => {
    const { env, cleanup } = stubHerdr();
    try {
      const sessions = await readHerdrSessions({ env });
      expect(sessions.map((session) => session.name)).toEqual(["xdg-unset"]);
    } finally {
      cleanup();
    }
  });

  test("forwards XDG_CONFIG_HOME only when the probed environment sets it", async () => {
    const { env, cleanup } = stubHerdr();
    try {
      const sessions = await readHerdrSessions({
        env: { ...env, XDG_CONFIG_HOME: "/tmp/xdg-elsewhere" },
      });
      expect(sessions.map((session) => session.name)).toEqual(["xdg-/tmp/xdg-elsewhere"]);
    } finally {
      cleanup();
    }
  });
});

describe("parseHerdrPersistedTopology", () => {
  // A stopped session's session.json (v3), captured from a real herdr install.
  const persisted = {
    version: 3,
    workspaces: [
      {
        id: "w1",
        custom_name: null,
        identity_cwd: "/Users/you/dev/talkie",
        public_pane_numbers: { "1": 1, "2": 2 },
        public_tab_numbers: [1, 2],
        tabs: [
          {
            custom_name: "main",
            layout: { Pane: 1 },
            panes: {
              "1": {
                cwd: "/Users/you/dev/talkie",
                agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "sess-1" },
              },
              "2": { cwd: "/Users/you/dev/openscout", agent_session: null },
            },
            zoomed: false,
            focused: 1,
            root_pane: 1,
          },
          {
            custom_name: null,
            panes: { "1": { agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: "sess-2" } } },
            focused: 1,
          },
        ],
        active_tab: 0,
      },
    ],
    active: 0,
    selected: 0,
  };

  test("projects workspaces, tabs, and panes in the live topology shape", () => {
    const workspaces = parseHerdrPersistedTopology(persisted);
    expect(workspaces).toHaveLength(1);
    const workspace = workspaces![0]!;
    expect(workspace.workspaceId).toBe("w1");
    expect(workspace.focused).toBe(true);
    expect(workspace.tabs).toHaveLength(2);
    expect(workspace.activeTabId).toBe(workspace.tabs[0]!.tabId);

    const [main, second] = workspace.tabs;
    expect(main!.label).toBe("main");
    expect(main!.number).toBe(1);
    expect(main!.panes).toHaveLength(2);
    expect(second!.label).toBeNull();
    expect(second!.number).toBe(2);

    const [claude, shell] = main!.panes;
    expect(claude!.agent).toBe("claude");
    expect(claude!.agentSession).toEqual({ source: "herdr:claude", agent: "claude", kind: "id", value: "sess-1" });
    expect(claude!.cwd).toBe("/Users/you/dev/talkie");
    expect(claude!.focused).toBe(true);
    expect(shell!.agent).toBeNull();
    expect(shell!.focused).toBe(false);
  });

  test("marks everything unknown and geometry-less: a stopped session has no live truth", () => {
    const workspaces = parseHerdrPersistedTopology(persisted)!;
    const pane = workspaces[0]!.tabs[0]!.panes[0]!;
    expect(pane.agentStatus).toBe("unknown");
    expect(pane.terminalId).toBeNull();
    expect(pane.scroll).toBeNull();
    expect(workspaces[0]!.tabs[0]!.layout).toBeNull();
  });

  test("falls back to the workspace identity cwd when a pane did not record one", () => {
    const workspaces = parseHerdrPersistedTopology(persisted)!;
    expect(workspaces[0]!.tabs[1]!.panes[0]!.cwd).toBe("/Users/you/dev/talkie");
  });

  test("returns null for values that are not a session state", () => {
    expect(parseHerdrPersistedTopology(null)).toBeNull();
    expect(parseHerdrPersistedTopology({})).toBeNull();
    expect(parseHerdrPersistedTopology({ workspaces: "nope" })).toBeNull();
    expect(parseHerdrPersistedTopology({ workspaces: [] })).toEqual([]);
  });
});
