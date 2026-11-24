/**
 * Terminal sessions hosted in herdr that are blocked on a prompt.
 *
 * herdr reports each pane's agent status itself (`blocked` = the agent stopped
 * for input or a permission prompt), so this does not guess from timing. The
 * pane's visible text is read to say what it is asking. A Claude permission
 * dialog Scout can parse carries a `version` (a fingerprint of the dialog), and
 * the operator can answer it from another device through
 * `answerHerdrPermission`, which presses Yes or No only while that same dialog
 * is still up. Anything else is answered at the terminal.
 */

import type { HerdrPaneProjection } from "@openscout/protocol";
import { parseContinuationDialog, type ContinuationDialog } from "@openscout/runtime";
import { readHerdrSessions, readHerdrTopology } from "@openscout/runtime/setup";

import { herdrTerminalHost } from "../../terminal-hosts/herdr.ts";
import { detectClaudeTmuxHostAttention } from "./tmux-host-attention.ts";

export type HerdrHostAttentionItem = {
  id: string;
  /** The harness's own session id when herdr knows it, else the pane id. */
  sessionId: string;
  sessionName: string;
  harness: string;
  title: string;
  summary: string;
  detail: string | null;
  /** Where the prompt is: `<herdr session> · <pane>`. */
  location: string;
  herdrSession: string;
  paneId: string;
  /**
   * Fingerprint of a parsed permission dialog. Present only when the operator
   * can answer it remotely; an answer must name it, so a tap on one prompt can
   * never press a key on the next prompt in the same pane.
   */
  version: number | null;
  updatedAt: number;
};

const ANSI = /\x1B\[[0-?]*[ -/]*[@-~]|\x1B\][^\x07]*(?:\x07|\x1B\\)/gu;
const PROMPT_TAIL_LINES = 8;
const MAX_PANES = 16;

export type HerdrBlockedPane = { session: string; pane: HerdrPaneProjection };

export async function collectHerdrHostAttention(
  options: { now?: number } = {},
): Promise<HerdrHostAttentionItem[]> {
  const now = options.now ?? Date.now();
  const blocked = await readBlockedHerdrPanes();
  const items = await Promise.all(blocked.slice(0, MAX_PANES).map(async ({ session, pane }) => {
    const text = await captureHerdrPane(session, pane);
    return herdrAttentionItem(session, pane, text, now);
  }));
  return items;
}

/** Every pane herdr reports `blocked`, across running herdr sessions. */
export async function readBlockedHerdrPanes(): Promise<HerdrBlockedPane[]> {
  const sessions = await readHerdrSessions().catch(() => []);
  const blocked: Array<{ session: string; pane: HerdrPaneProjection }> = [];
  for (const session of sessions) {
    if (!session.running) continue;
    const topology = await readHerdrTopology(session.name).catch(() => null);
    if (!topology?.running) continue;
    for (const workspace of topology.workspaces) {
      for (const tab of workspace.tabs) {
        for (const pane of tab.panes) {
          if (pane.agentStatus === "blocked") blocked.push({ session: session.name, pane });
        }
      }
    }
  }
  return blocked;
}

export async function captureHerdrPane(session: string, pane: HerdrPaneProjection): Promise<string | null> {
  return await herdrTerminalHost.capture?.({ sessionName: session, paneId: pane.paneId })
    .catch(() => null) ?? null;
}

/** The id an item for this pane carries, minus its `herdr-permission:` / `herdr-blocked:` prefix. */
export function herdrPaneItemKey(session: string, pane: HerdrPaneProjection): string {
  const sessionId = pane.agentSession?.value ?? `${session}:${pane.paneId}`;
  return `${session}:${pane.paneId}:${sessionId}`;
}

/**
 * A live Claude permission dialog the operator can answer remotely: parsed,
 * still on screen, with a plain Yes to press.
 */
export function answerablePermissionDialog(paneText: string | null): ContinuationDialog | null {
  if (!paneText) return null;
  const dialog = parseContinuationDialog(paneText);
  if (!dialog.live || dialog.kind !== "permission") return null;
  return dialog.options.some((option) => option.kind === "allow") ? dialog : null;
}

/** A stable 31-bit fingerprint of what the dialog asks and offers. */
export function permissionDialogVersion(dialog: ContinuationDialog): number {
  const text = [
    dialog.title ?? "",
    dialog.command ?? "",
    dialog.permissionRule ?? "",
    ...dialog.options.map((option) => `${option.index}.${option.label}`),
  ].join("\u0000");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash & 0x7fffffff;
}

export function herdrAttentionItem(
  session: string,
  pane: HerdrPaneProjection,
  paneText: string | null,
  now: number,
): HerdrHostAttentionItem {
  const harness = pane.agent ?? pane.agentSession?.agent ?? "terminal";
  const sessionId = pane.agentSession?.value ?? `${session}:${pane.paneId}`;
  const sessionName = pane.name ?? pane.label ?? pane.paneId;
  const location = `${session} · ${pane.paneId}`;
  const key = herdrPaneItemKey(session, pane);
  const base = { sessionId, sessionName, harness, location, herdrSession: session, paneId: pane.paneId, updatedAt: now };

  const claudeText = harness === "claude" ? paneText : null;
  const claude = claudeText
    ? detectClaudeTmuxHostAttention(claudeText, { agentId: sessionId, agentName: sessionName, sessionId, now })
    : null;
  const dialog = answerablePermissionDialog(claudeText);
  if (claude || dialog) {
    return {
      ...base,
      id: `herdr-permission:${key}`,
      title: claude?.title ?? "Claude needs permission",
      summary: claude?.summary ?? dialog?.title ?? "A command requires approval.",
      detail: claude?.detail ?? dialog?.command ?? null,
      version: dialog ? permissionDialogVersion(dialog) : null,
    };
  }

  return {
    ...base,
    id: `herdr-blocked:${key}`,
    version: null,
    title: `${capitalize(harness)} is waiting for input`,
    summary: promptTail(paneText) ?? "The terminal is waiting for input.",
    detail: null,
  };
}

/** The last few non-empty lines — where a terminal prompt puts its question. */
function promptTail(text: string | null): string | null {
  if (!text) return null;
  const lines = text.replace(ANSI, "").replaceAll("\r", "").split("\n")
    .map((line) => line.replace(/[│┃╭╮╰╯─━]+/gu, " ").trimEnd())
    .filter((line) => line.trim().length > 0);
  const tail = lines.slice(-PROMPT_TAIL_LINES).map((line) => line.trim()).join("\n");
  return tail || null;
}

function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}
