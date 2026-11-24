import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { parseHerdrPersistedTopology } from "@openscout/runtime/setup";

/**
 * What a stopped herdr session still knows about itself.
 *
 * A herdr session server going down does not erase the session: the layout it
 * owned — workspaces, tabs, panes, each pane's cwd and resident agent — is
 * persisted to `<sessionDir>/session.json`, and that file's mtime is the last
 * moment the session's state changed. "Detached" is the whole reason herdr
 * sessions exist (they reattach), so a row that can only say "detached" is
 * withholding the one answer the operator actually wants: what was in it, and
 * how long ago. This summary is that answer, distilled from the same persisted
 * projection the runtime builds for the topology route.
 */
export type HerdrLastKnownState = {
  /** mtime of session.json in epoch ms — the session's last state change. */
  savedAt: number;
  workspaces: number;
  tabs: number;
  panes: number;
  /** Distinct pane cwds, in layout order. */
  cwds: string[];
  /** Distinct harness agent names resident in panes, e.g. ["claude"]. */
  agents: string[];
};

const LAST_KNOWN_LIST_CAP = 8;

/**
 * Summarize the persisted layout. Returns null when the value is not a session
 * state at all — an ordinary state (older herdr, deleted session), not a
 * failure.
 */
export function parseHerdrSessionState(
  value: unknown,
  savedAt: number,
): HerdrLastKnownState | null {
  const workspaces = parseHerdrPersistedTopology(value);
  if (workspaces === null) return null;

  let tabs = 0;
  let panes = 0;
  const cwds: string[] = [];
  const agents: string[] = [];
  for (const workspace of workspaces) {
    tabs += workspace.tabs.length;
    for (const tab of workspace.tabs) {
      panes += tab.panes.length;
      for (const pane of tab.panes) {
        if (pane.cwd && !cwds.includes(pane.cwd)) cwds.push(pane.cwd);
        if (pane.agent && !agents.includes(pane.agent)) agents.push(pane.agent);
      }
    }
  }

  return {
    savedAt,
    workspaces: workspaces.length,
    tabs,
    panes,
    cwds: cwds.slice(0, LAST_KNOWN_LIST_CAP),
    agents: agents.slice(0, LAST_KNOWN_LIST_CAP),
  };
}

/**
 * Read the last-known layout for a session whose server is not running.
 * Returns null when the file is missing or unreadable — an ordinary state
 * (session deleted out from under us, older herdr version), not a failure.
 */
export async function readHerdrLastKnownState(
  sessionDir: string,
): Promise<HerdrLastKnownState | null> {
  try {
    const path = join(sessionDir, "session.json");
    const [raw, stats] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return parseHerdrSessionState(JSON.parse(raw), stats.mtimeMs);
  } catch {
    return null;
  }
}
