import { expect, test } from "bun:test";
import {
  parseTmuxSessionList,
  parseZellijSessionList,
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

test("parses colorized zellij session inventory", () => {
  expect(parseZellijSessionList(
    "\x1B[32;1mexample-session\x1B[m [Created \x1B[35;1m13h\x1B[m ago] (\x1B[31;1mEXITED\x1B[m - attach to resurrect)\n",
  )).toEqual([{
    name: "example-session",
    state: "exited",
    raw: "example-session [Created 13h ago] (EXITED - attach to resurrect)",
  }]);
});
