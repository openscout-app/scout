import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseHerdrSessionState, readHerdrLastKnownState } from "./herdr-session-state.ts";

const SAVED_AT = 1_800_000_000_000;

describe("parseHerdrSessionState", () => {
  test("summarizes workspaces, tabs, panes, cwds, and resident agents", () => {
    const summary = parseHerdrSessionState({
      version: 3,
      workspaces: [
        {
          id: "w1",
          identity_cwd: "/Users/you/dev/talkie",
          tabs: [
            {
              panes: {
                "1": { cwd: "/Users/you/dev/talkie", agent_session: { source: "herdr:claude", agent: "claude" } },
                "2": { cwd: "/Users/you/dev/talkie", agent_session: null },
              },
            },
            {
              panes: {
                "3": { cwd: "/Users/you/dev/openscout", agent_session: { agent: "codex" } },
              },
            },
          ],
        },
        { id: "w2", tabs: [{ panes: { "1": { cwd: "/Users/you/dev/openscout" } } }] },
      ],
    }, SAVED_AT);

    expect(summary).toEqual({
      savedAt: SAVED_AT,
      workspaces: 2,
      tabs: 3,
      panes: 4,
      cwds: ["/Users/you/dev/talkie", "/Users/you/dev/openscout"],
      agents: ["claude", "codex"],
    });
  });

  test("returns null for shapes it cannot read rather than guessing", () => {
    expect(parseHerdrSessionState(null, SAVED_AT)).toBeNull();
    expect(parseHerdrSessionState({}, SAVED_AT)).toBeNull();
    expect(parseHerdrSessionState({ workspaces: "nope" }, SAVED_AT)).toBeNull();
  });

  test("tolerates sparse panes and duplicate cwds", () => {
    const summary = parseHerdrSessionState({
      workspaces: [{ tabs: [{ panes: { "1": {}, "2": { cwd: "/a" }, "3": { cwd: "/a" } } }] }],
    }, SAVED_AT);
    expect(summary?.panes).toBe(3);
    expect(summary?.cwds).toEqual(["/a"]);
    expect(summary?.agents).toEqual([]);
  });
});

describe("readHerdrLastKnownState", () => {
  test("reads session.json from the session dir and stamps it with its mtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scout-herdr-state-"));
    try {
      await writeFile(join(dir, "session.json"), JSON.stringify({
        version: 3,
        workspaces: [{ tabs: [{ panes: { "1": { cwd: "/Users/you/dev/talkie" } } }] }],
      }));
      const summary = await readHerdrLastKnownState(dir);
      expect(summary?.panes).toBe(1);
      expect(summary?.cwds).toEqual(["/Users/you/dev/talkie"]);
      expect(summary?.savedAt).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a missing or unreadable session.json is an ordinary null, not a failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scout-herdr-state-"));
    try {
      expect(await readHerdrLastKnownState(dir)).toBeNull();
      await writeFile(join(dir, "session.json"), "not json");
      expect(await readHerdrLastKnownState(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
