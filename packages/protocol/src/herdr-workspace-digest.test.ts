import { describe, expect, test } from "bun:test";

import {
  describeHerdrArrangement,
  digestHerdrTopology,
  renderHerdrWorkspaceDigest,
} from "./herdr-workspace-digest.js";
import type {
  HerdrAgentStatus,
  HerdrLayoutPane,
  HerdrPaneProjection,
  HerdrSessionTopology,
  HerdrTabLayout,
} from "./terminal-host-topology.js";

function pane(
  paneId: string,
  overrides: Partial<HerdrPaneProjection> = {},
): HerdrPaneProjection {
  return {
    paneId,
    terminalId: `term-${paneId}`,
    tabId: "w1:t1",
    workspaceId: "w1",
    label: null,
    agent: null,
    agentStatus: "idle",
    agentSession: null,
    cwd: "/Users/art/dev/openscout",
    foregroundCwd: null,
    focused: false,
    scroll: null,
    ...overrides,
  };
}

function layoutPane(paneId: string, x: number, y: number): HerdrLayoutPane {
  return { paneId, focused: false, rect: { x, y, width: 40, height: 12 } };
}

function layout(panes: HerdrLayoutPane[], overrides: Partial<HerdrTabLayout> = {}): HerdrTabLayout {
  return {
    tabId: "w1:t1",
    workspaceId: "w1",
    area: { x: 0, y: 0, width: 80, height: 24 },
    focusedPaneId: null,
    zoomed: false,
    panes,
    splits: [],
    ...overrides,
  };
}

function topology(panes: HerdrPaneProjection[], overrides: Partial<HerdrSessionTopology> = {}): HerdrSessionTopology {
  return {
    session: "openscout",
    running: true,
    observedAt: 1_700_000_000_000,
    workspaces: [{
      workspaceId: "w1",
      label: "main",
      number: 1,
      focused: true,
      activeTabId: "w1:t1",
      agentStatus: "idle",
      tabs: [{
        tabId: "w1:t1",
        workspaceId: "w1",
        label: "build",
        number: 1,
        focused: true,
        agentStatus: "idle",
        panes,
        layout: null,
      }],
    }],
    ...overrides,
  };
}

describe("describeHerdrArrangement", () => {
  test("names the degenerate cases plainly", () => {
    expect(describeHerdrArrangement(null, 0)).toBe("no panes");
    expect(describeHerdrArrangement(null, 1)).toBe("single pane");
  });

  test("a missing or mismatched layout is declared, never guessed", () => {
    expect(describeHerdrArrangement(null, 4)).toBe("4 panes (layout unavailable)");
    expect(describeHerdrArrangement(layout([layoutPane("w1:p1", 0, 0)]), 4))
      .toBe("4 panes (layout unavailable)");
  });

  test("one column is rows, one row is columns", () => {
    expect(describeHerdrArrangement(
      layout([layoutPane("w1:p1", 0, 0), layoutPane("w1:p2", 0, 12), layoutPane("w1:p3", 0, 24)]),
      3,
    )).toBe("3 stacked rows");
    expect(describeHerdrArrangement(
      layout([layoutPane("w1:p1", 0, 0), layoutPane("w1:p2", 40, 0)]),
      2,
    )).toBe("2 side-by-side columns");
  });

  test("an even split is named as a grid", () => {
    expect(describeHerdrArrangement(
      layout([
        layoutPane("w1:p1", 0, 0), layoutPane("w1:p2", 40, 0),
        layoutPane("w1:p3", 0, 12), layoutPane("w1:p4", 40, 12),
      ]),
      4,
    )).toBe("2×2 grid");
  });

  test("an irregular split is named by its column depths rather than invented", () => {
    expect(describeHerdrArrangement(
      layout([
        layoutPane("w1:p1", 0, 0), layoutPane("w1:p2", 0, 12),
        layoutPane("w1:p3", 40, 0),
      ]),
      3,
    )).toBe("2 columns (2 · 1)");
  });
});

describe("digestHerdrTopology", () => {
  test("blocked panes lead, and the focused pane wins a tie", () => {
    const digest = digestHerdrTopology(topology([
      pane("w1:p1", { agent: "claude", agentStatus: "working" }),
      pane("w1:p2", { agent: "codex", agentStatus: "blocked" }),
      pane("w1:p3", { agent: "claude", agentStatus: "blocked", focused: true }),
      pane("w1:p4"),
    ]));

    expect(digest.needsYou.map((entry) => entry.paneId)).toEqual(["w1:p3", "w1:p2"]);
    expect(digest.working.map((entry) => entry.paneId)).toEqual(["w1:p1"]);
    expect(digest.counts).toEqual({ blocked: 2, working: 1, idle: 1, done: 0, unknown: 0 });
    expect(digest.totals).toEqual({ workspaces: 1, tabs: 1, panes: 4, agents: 3 });
  });

  test("the target is the terminal id, falling back to the pane id", () => {
    const digest = digestHerdrTopology(topology([
      pane("w1:p1", { agentStatus: "blocked" }),
      pane("w1:p2", { agentStatus: "blocked", terminalId: null }),
    ]));
    expect(digest.needsYou.map((entry) => entry.target)).toEqual(["term-w1:p1", "w1:p2"]);
  });

  test("groups by literal directory, ordered by what is waiting", () => {
    const digest = digestHerdrTopology(topology([
      pane("w1:p1", { cwd: "/Users/art/dev/openscout" }),
      pane("w1:p2", { cwd: "/Users/art/dev/openscout" }),
      pane("w1:p3", { cwd: "/Users/art/dev/hudson", agentStatus: "blocked" }),
      pane("w1:p4", { cwd: null }),
    ]));

    expect(digest.groups.map((group) => group.name)).toEqual(["hudson", "openscout", "no directory"]);
    expect(digest.groups[0]!.counts.blocked).toBe(1);
    expect(digest.groups[2]!.directory).toBeNull();
  });

  test("foregroundCwd wins over the pane cwd", () => {
    const digest = digestHerdrTopology(topology([
      pane("w1:p1", { cwd: "/Users/art/dev/openscout", foregroundCwd: "/Users/art/dev/openscout/packages/web" }),
    ]));
    expect(digest.groups[0]!.directory).toBe("/Users/art/dev/openscout/packages/web");
    expect(digest.groups[0]!.name).toBe("web");
  });

  test("the pane cap drops the lowest-attention panes and says so", () => {
    const panes = [
      pane("w1:p1", { agentStatus: "blocked" }),
      pane("w1:p2", { agentStatus: "working" }),
      pane("w1:p3", { agentStatus: "idle" }),
      pane("w1:p4", { agentStatus: "unknown" }),
    ];
    const digest = digestHerdrTopology(topology(panes), { paneCap: 2 });

    expect(digest.truncated).toBe(true);
    expect(digest.groups[0]!.panes.map((entry) => entry.paneId)).toEqual(["w1:p1", "w1:p2"]);
    expect(digest.groups[0]!.omitted).toBe(2);
    // Counts still describe every pane; only the emitted rows are capped.
    expect(digest.groups[0]!.counts).toEqual({ blocked: 1, working: 1, idle: 1, done: 0, unknown: 1 });
    // What was dropped, not just how many — the label has to be decidable.
    expect(digest.groups[0]!.omittedCounts).toEqual({ blocked: 0, working: 0, idle: 1, done: 0, unknown: 1 });
    // Truncation is carried inline by the group, never as a trailing footnote.
    expect(digest.notes.some((note) => note.includes("omitted"))).toBe(false);
  });

  test("unknown is called out as an absent signal, never as completion", () => {
    const digest = digestHerdrTopology(topology([pane("w1:p1", { agent: "claude", agentStatus: "unknown" })]));
    expect(digest.counts.done).toBe(0);
    expect(digest.notes.some((note) => note.includes("not completion"))).toBe(true);
  });

  test("a stopped session is labeled last-known rather than passed off as live", () => {
    const digest = digestHerdrTopology(topology([pane("w1:p1")], { running: false, savedAt: 1_699_000_000_000 }));
    expect(digest.live).toBe(false);
    expect(digest.savedAt).toBe(1_699_000_000_000);
    expect(digest.notes[0]).toContain("persisted last-known layout");
    expect(digest.notes[0]).toContain("Last saved 2023-11-03T");
  });

  test("an empty session digests to an ordinary empty state, not an error", () => {
    const digest = digestHerdrTopology({
      session: "scratch",
      running: false,
      workspaces: [],
      observedAt: 1,
    });
    expect(digest.totals.panes).toBe(0);
    expect(digest.needsYou).toEqual([]);
    expect(digest.groups).toEqual([]);
    expect(digest.truncated).toBe(false);
  });

  test("shapes describe every tab, carrying zoom and focus", () => {
    const base = topology([pane("w1:p1"), pane("w1:p2")]);
    base.workspaces[0]!.tabs[0]!.layout = layout(
      [layoutPane("w1:p1", 0, 0), layoutPane("w1:p2", 40, 0)],
      { zoomed: true },
    );
    const digest = digestHerdrTopology(base);
    expect(digest.shapes).toEqual([{
      workspaceId: "w1",
      workspaceLabel: "main",
      tabId: "w1:t1",
      tabLabel: "build",
      paneCount: 2,
      arrangement: "2 side-by-side columns",
      zoomed: true,
      focused: true,
    }]);
  });

  test("digesting is pure — the same topology always gives the same digest", () => {
    const build = () => digestHerdrTopology(topology([
      pane("w1:p1", { agentStatus: "blocked" }),
      pane("w1:p2", { agentStatus: "working" }),
    ]));
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });

  test("carries attached clients, their apps and each pane's branch when the host read them", () => {
    const apps = ["Example Term"];
    const digest = digestHerdrTopology(topology([
      pane("w1:p1", { agentStatus: "blocked", cwd: "/workspace/app", gitBranch: "main" }),
      pane("w1:p2", { cwd: "/workspace/notes", gitBranch: null }),
      pane("w1:p3", { cwd: "/workspace/other" }),
    ], { clients: 2, apps }));
    expect(digest.clients).toBe(2);
    expect(digest.apps).toEqual(["Example Term"]);
    expect(digest.apps).not.toBe(apps);
    const branches = Object.fromEntries(digest.groups.flatMap((group) => group.panes)
      .map((entry) => [entry.paneId, "gitBranch" in entry ? entry.gitBranch : "absent"]));
    expect(branches).toEqual({ "w1:p1": "main", "w1:p2": null, "w1:p3": "absent" });
    expect(digest.needsYou[0]?.gitBranch).toBe("main");
  });

  test("leaves clients, apps and branches absent when the host did not read them", () => {
    const digest = digestHerdrTopology(topology([pane("w1:p1")]));
    expect("clients" in digest).toBe(false);
    expect("apps" in digest).toBe(false);
    expect("gitBranch" in digest.groups[0]!.panes[0]!).toBe(false);
  });
});

describe("renderHerdrWorkspaceDigest", () => {
  test("idle panel names and reported session identities remain visible in text", () => {
    const digest = digestHerdrTopology(topology([pane("w1:p2", {
      name: "devon-2-openscout", label: "Router investigation", agent: "devin", agentStatus: "idle",
      agentSession: { agent: "devin", kind: "id", source: "herdr:devin", value: "plum-chef" },
    })]));
    expect(digest.groups[0]?.panes[0]).toMatchObject({ name: "devon-2-openscout", agentSession: { value: "plum-chef" } });
    const text = renderHerdrWorkspaceDigest(digest);
    expect(text).toContain("devon-2-openscout");
    expect(text).toContain("Router investigation");
    expect(text).toContain("reported devin id:plum-chef");
    expect(text).toContain("2023-11-14T22:13:20.000Z");
  });

  test("a saved pane never retains a live target or activity claim", () => {
    const digest = digestHerdrTopology(topology([pane("w1:p2", { name: "devon-2", agentStatus: "working" })], { running: false }));
    expect(digest.groups[0]?.panes[0]).toMatchObject({ name: "devon-2", target: null, status: "unknown" });
    expect(digest.working).toEqual([]);
    expect(digest.counts.working).toBe(0);
  });
  test("puts what is waiting above what is moving, above the inventory", () => {
    const text = renderHerdrWorkspaceDigest(digestHerdrTopology(topology([
      pane("w1:p1", { agent: "claude", agentStatus: "working" }),
      pane("w1:p2", { agent: "codex", agentStatus: "blocked", label: "review" }),
    ])));

    expect(text).toContain("herdr · openscout — live · 1 workspace, 1 tab, 2 panes (1 blocked · 1 working)");
    expect(text.indexOf("Requests")).toBeLessThan(text.indexOf("Working now"));
    expect(text.indexOf("Working now")).toBeLessThan(text.indexOf("Grouped by directory"));
    expect(text.indexOf("Grouped by directory")).toBeLessThan(text.indexOf("Arranged like this"));
  });

  test("heads every section with a verb phrase, never a bare noun", () => {
    const text = renderHerdrWorkspaceDigest(digestHerdrTopology(topology([
      pane("w1:p1", { agent: "codex", agentStatus: "blocked" }),
      pane("w1:p2", { agent: "claude", agentStatus: "working" }),
    ])));
    const heads = text.split("\n").filter((line) => line && !line.startsWith(" ") && !line.startsWith("herdr ·"));
    expect(heads).toEqual(["Requests", "Working now", "Grouped by directory", "Arranged like this"]);
  });

  test("leads a row with its label, and with the short pane id when it has none", () => {
    const text = renderHerdrWorkspaceDigest(digestHerdrTopology(topology([
      pane("w1:p1", { agent: "codex", agentStatus: "blocked", label: "review" }),
      pane("w1:p2", { agent: "claude", agentStatus: "blocked" }),
    ])));
    // Never the terminal id: rows sharing a long prefix train the eye to skip
    // the one column that identifies them.
    expect(text).not.toContain("term-");
    expect(text).toContain("  review  codex  w1:p1  openscout");
    expect(text).toContain("  w1:p2  claude  openscout");
  });

  test("carries the full path once, in the grouped section only", () => {
    const text = renderHerdrWorkspaceDigest(digestHerdrTopology(topology([
      pane("w1:p1", { agent: "codex", agentStatus: "blocked" }),
    ])));
    expect(text.split("/Users/art/dev/openscout").length - 1).toBe(1);
    expect(text).toContain("openscout (/Users/art/dev/openscout) — 1 pane · 1 blocked");
  });

  test("omits sections it has nothing to say in", () => {
    const text = renderHerdrWorkspaceDigest(digestHerdrTopology(topology([pane("w1:p1")])));
    expect(text).not.toContain("Requests");
    expect(text).not.toContain("Working now");
    expect(text).toContain("Grouped by directory");
  });

  test("puts a caveat under the count it qualifies, never in a trailing block", () => {
    const text = renderHerdrWorkspaceDigest(digestHerdrTopology(topology(
      [
        pane("w1:p1", { agent: "claude", agentStatus: "unknown" }),
        pane("w1:p2", { agent: "claude", agentStatus: "unknown" }),
      ],
      { running: false },
    )));
    const lines = text.split("\n");
    expect(text).not.toContain("Caveats");
    // Directly under the header line, above every section.
    expect(lines[1]).toContain("persisted last-known layout");
    expect(lines[2]).toContain("2 panes report unknown");
    expect(lines.indexOf("Grouped by directory")).toBeGreaterThan(2);
  });

  test("a collapsed row count says what was collapsed", () => {
    const text = renderHerdrWorkspaceDigest(digestHerdrTopology(topology([
      pane("w1:p1", { agentStatus: "blocked" }),
      pane("w1:p2", { agentStatus: "idle" }),
      pane("w1:p3", { agentStatus: "idle" }),
    ]), { paneCap: 1 }));
    expect(text).toContain("+2 idle not shown");
  });

  test("a mixed collapse names each status rather than a bare total", () => {
    const text = renderHerdrWorkspaceDigest(digestHerdrTopology(topology([
      pane("w1:p1", { agentStatus: "blocked" }),
      pane("w1:p2", { agentStatus: "idle" }),
      pane("w1:p3", { agent: "claude", agentStatus: "unknown" }),
    ]), { paneCap: 1 }));
    expect(text).toContain("+2 not shown (1 idle · 1 unknown)");
  });
});

describe("presentation defects the live herdr session surfaced", () => {
  test("one unknown pane agrees with its verb", () => {
    const digest = digestHerdrTopology(topology([pane("w1:p1", { agent: "claude", agentStatus: "unknown" })]));
    expect(digest.notes.some((note) => note.startsWith("1 pane reports unknown"))).toBe(true);
  });

  test("a last-known layout with no savedAt says so without inventing a time", () => {
    const digest = digestHerdrTopology(topology([pane("w1:p1")], { running: false }));
    expect(digest.notes[0]).toContain("persisted last-known layout");
    expect(digest.notes[0]).not.toContain("Last saved");
  });

  test("two workspaces sharing a label stay distinguishable in the layout section", () => {
    const base = topology([pane("w1:p1")]);
    base.workspaces.push({
      workspaceId: "w2",
      label: "openscout",
      number: 2,
      focused: false,
      activeTabId: "w2:t1",
      agentStatus: "idle",
      tabs: [{
        tabId: "w2:t1", workspaceId: "w2", label: "1", number: 1, focused: false,
        agentStatus: "idle", panes: [pane("w2:p1", { tabId: "w2:t1", workspaceId: "w2" })], layout: null,
      }],
    });
    base.workspaces[0]!.label = "openscout";
    base.workspaces[0]!.tabs[0]!.label = "1";

    const text = renderHerdrWorkspaceDigest(digestHerdrTopology(base));
    expect(text).toContain("w1:t1  openscout / 1 —");
    expect(text).toContain("w2:t1  openscout / 1 —");
  });
});

describe("a running session that will not answer", () => {
  test("is never presented as stopped", () => {
    const digest = digestHerdrTopology(topology([pane("w1:p1")], {
      running: false,
      unavailable: "unreadable",
      savedAt: 1_699_000_000_000,
    }));
    expect(digest.unavailable).toBe("unreadable");

    const text = renderHerdrWorkspaceDigest(digest);
    expect(text).toContain("herdr · openscout — running, not readable");
    expect(text).not.toContain("not running");
    expect(text).toContain("is running but did not answer");
    expect(text).toContain("protocol skew");
  });

  test("an ordinary stopped session keeps the plain caveat", () => {
    const digest = digestHerdrTopology(topology([pane("w1:p1")], { running: false }));
    expect(digest.unavailable).toBe("not_running");
    expect(renderHerdrWorkspaceDigest(digest)).toContain("herdr · openscout — not running");
  });

  test("a live projection carries no unavailable reason", () => {
    expect(digestHerdrTopology(topology([pane("w1:p1")])).unavailable).toBeNull();
  });
});
