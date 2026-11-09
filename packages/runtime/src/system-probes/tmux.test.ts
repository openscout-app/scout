import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetScoutdProbeClientForTests } from "./scoutd-client.ts";
import {
  invalidateTmuxSessions,
  parseTmuxSessionList,
  parseZellijSessionList,
  readTmuxSessionsWithClients,
  reportedTmuxPaneTitle,
  TMUX_SESSION_LIST_FORMAT,
} from "./tmux.ts";

function tmuxRow(fields: {
  name: string;
  command?: string;
  path?: string;
  windowName?: string;
  host?: string;
  title?: string;
}): string {
  return [
    fields.name,
    "1",
    "0",
    "1710000000",
    "1710003600",
    fields.command ?? "zsh",
    fields.path ?? "/workspace",
    fields.windowName ?? "",
    fields.host ?? "",
    fields.title ?? "",
  ].join("\t");
}

test("keeps delimiters inside tmux current paths", () => {
  expect(parseTmuxSessionList("dev|2|1|100|200|zsh|/workspace/foo|bar\n")).toEqual([
    {
      name: "dev",
      windows: 2,
      attached: 1,
      createdAt: 100,
      activityAt: 200,
      currentCommand: "zsh",
      currentPath: "/workspace/foo|bar",
      windowName: null,
      paneTitle: null,
    },
  ]);
});

test("reads tab-delimited rows with the active window name and pane title", () => {
  expect(TMUX_SESSION_LIST_FORMAT.split("\t")).toEqual([
    "#{session_name}",
    "#{session_windows}",
    "#{session_attached}",
    "#{session_created}",
    "#{session_activity}",
    "#{pane_current_command}",
    "#{pane_current_path}",
    "#{window_name}",
    "#{host}",
    "#{pane_title}",
  ]);
  expect(parseTmuxSessionList(`${tmuxRow({
    name: "work",
    command: "node",
    path: "/workspace/app",
    windowName: "editor",
    host: "box.local",
    title: "claude | fix tests",
  })}\n`)).toEqual([{
    name: "work",
    windows: 1,
    attached: 0,
    createdAt: 1710000000,
    activityAt: 1710003600,
    currentCommand: "node",
    currentPath: "/workspace/app",
    windowName: "editor",
    paneTitle: "claude | fix tests",
  }]);
});

test("never splits a tab row on a pipe in the window name or title", () => {
  const [session] = parseTmuxSessionList(tmuxRow({
    name: "work",
    windowName: "api | web",
    host: "box.local",
    title: "a | b | c",
  }));
  expect(session?.currentPath).toBe("/workspace");
  expect(session?.windowName).toBe("api | web");
  expect(session?.paneTitle).toBe("a | b | c");
});

test("folds a tab inside the pane title back into the title", () => {
  const [session] = parseTmuxSessionList(`${tmuxRow({ name: "work", host: "box.local", title: "step 1" })}\tstep 2`);
  expect(session?.paneTitle).toBe("step 1\tstep 2");
});

test("reports tmux's host-name default pane title as no title", () => {
  const sessions = parseTmuxSessionList([
    tmuxRow({ name: "fresh", windowName: "zsh", host: "box.local", title: "box.local" }),
    tmuxRow({ name: "cased", windowName: "zsh", host: "box.local", title: "Box.Local" }),
    tmuxRow({ name: "moved", windowName: "zsh", host: "box.lan", title: "box.local" }),
    tmuxRow({ name: "short", windowName: "zsh", host: "box.local", title: "box" }),
    tmuxRow({ name: "empty", windowName: "", host: "box.local", title: "" }),
  ].join("\n"));
  expect(sessions.map((session) => [session.name, session.windowName, session.paneTitle])).toEqual([
    ["fresh", "zsh", null],
    ["cased", "zsh", null],
    ["moved", "zsh", null],
    ["short", "zsh", null],
    ["empty", null, null],
  ]);
  for (const session of sessions) {
    expect(JSON.stringify(session)).not.toContain("box");
  }
});

test("keeps a title that only mentions the host name", () => {
  expect(reportedTmuxPaneTitle("box build", "box.local")).toBe("box build");
  expect(reportedTmuxPaneTitle("boxer.local", "box.local")).toBe("boxer.local");
  expect(reportedTmuxPaneTitle("ssh box.local", "box.local")).toBe("ssh box.local");
  expect(reportedTmuxPaneTitle("box.local", undefined)).toBe("box.local");
});

/**
 * A tmux that lists two sessions and no clients. Like tmux without a UTF-8
 * locale, it prints each tab as "_" unless the client passed -u.
 */
function writeFakeTmux(directory: string): string {
  const path = join(directory, "tmux");
  writeFileSync(path, [
    "#!/bin/sh",
    "utf8=0",
    "if [ \"$1\" = \"-u\" ]; then utf8=1; shift; fi",
    "if [ \"$1\" = \"-S\" ]; then shift 2; fi",
    "case \"$1\" in",
    "  list-sessions)",
    "    rows='alpha\\t1\\t0\\t1710000000\\t1710003600\\tclaude\\t/workspace/alpha\\teditor\\tbox.local\\tclaude | fix tests\\nbeta\\t1\\t0\\t\\t\\tzsh\\t/workspace/beta\\tzsh\\tbox.local\\tbox.local\\n'",
    "    if [ \"$utf8\" = 1 ]; then printf \"$rows\"; else printf \"$rows\" | tr '\\t' '_'; fi",
    "    ;;",
    "  list-clients) ;;",
    "  *) exit 64 ;;",
    "esac",
  ].join("\n") + "\n", "utf8");
  chmodSync(path, 0o755);
  return path;
}

test("keeps the window name and pane title when it adds each session's clients", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tmux-clients-"));
  const socketPath = join(directory, "tmux.sock");
  const previous = {
    OPENSCOUT_TMUX_BIN: process.env.OPENSCOUT_TMUX_BIN,
    OPENSCOUT_PROBES_SOCKET: process.env.OPENSCOUT_PROBES_SOCKET,
  };
  process.env.OPENSCOUT_TMUX_BIN = writeFakeTmux(directory);
  // Read locally: a running scoutd would answer with this host's own sessions.
  process.env.OPENSCOUT_PROBES_SOCKET = join(directory, "missing-probes.sock");
  resetScoutdProbeClientForTests();
  invalidateTmuxSessions({ socketPath });
  try {
    const snapshot = await readTmuxSessionsWithClients({ env: {}, socketPath, maxAgeMs: 0 });
    expect(snapshot.value?.map((session) => ({
      name: session.name,
      windowName: session.windowName,
      paneTitle: session.paneTitle,
      clients: session.clients,
      apps: session.apps,
    }))).toEqual([
      { name: "alpha", windowName: "editor", paneTitle: "claude | fix tests", clients: 0, apps: [] },
      { name: "beta", windowName: "zsh", paneTitle: null, clients: 0, apps: [] },
    ]);
  } finally {
    invalidateTmuxSessions({ socketPath });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetScoutdProbeClientForTests();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("parses colorized zellij session inventory", () => {
  expect(parseZellijSessionList(
    "\x1B[32;1mexample-session\x1B[m [Created \x1B[35;1m13h\x1B[m ago] (\x1B[31;1mEXITED\x1B[m - attach to resurrect)\n",
  )).toEqual([{
    name: "example-session",
    state: "exited",
    raw: "example-session [Created 13h ago] (EXITED - attach to resurrect)",
  }]);
});
