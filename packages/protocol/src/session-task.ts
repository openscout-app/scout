import type { ScoutId } from "./common.js";
import { notificationPlainLine } from "./agent-notifications.js";

/**
 * What a session or agent is working on, read from the ask that started or
 * last steered it. Clients name a session by its task with these fields
 * instead of falling back to session ids, harness slugs or last replies.
 *
 * Every field is null when no ask reached the session. The work item fields
 * are null when that ask carried no work item.
 */
export interface SessionTaskLink {
  /** The work item (collaboration record) id the latest ask belongs to. */
  workItemId: ScoutId | null;
  /** That work item's title. */
  workItemTitle: string | null;
  /** The first meaningful line of the latest ask's task, as plain text. */
  currentTask: string | null;
}

export const EMPTY_SESSION_TASK_LINK: SessionTaskLink = Object.freeze({
  workItemId: null,
  workItemTitle: null,
  currentTask: null,
});

export const SESSION_TASK_HEADLINE_MAX = 120;
const WORK_ITEM_TITLE_MAX = 160;

/**
 * The runtime prefixes a continued task with the predecessor's result
 * (`Previous task <id> (<state>):\n<output>\n\nSuccessor task:\n<body>`).
 * Only the successor body says what the session works on now.
 */
const SUCCESSOR_TASK_MARKER = "\n\nSuccessor task:\n";

/**
 * The first line of an ask's task that says something, as plain text, cut to
 * `max` characters. Returns null when nothing is left.
 */
export function sessionTaskHeadline(
  task: string | null | undefined,
  max = SESSION_TASK_HEADLINE_MAX,
): string | null {
  if (!task) return null;
  const normalized = task.replace(/\r/g, "");
  const marker = normalized.lastIndexOf(SUCCESSOR_TASK_MARKER);
  const body = marker >= 0 ? normalized.slice(marker + SUCCESSOR_TASK_MARKER.length) : normalized;
  return notificationPlainLine(body, max) || null;
}

/** An invocation, reduced to the fields that name its session. */
export interface SessionTaskSource {
  task: string | null | undefined;
  collaborationRecordId?: string | null;
  action?: string | null;
  createdAt?: number | null;
}

/**
 * Build the link from the latest ask that steered the session. A wake carries
 * no task of its own, so it never replaces the ask before it.
 */
export function resolveSessionTaskLink(
  sources: Iterable<SessionTaskSource>,
  workItemTitle: (workItemId: string) => string | null | undefined,
): SessionTaskLink {
  let latest: SessionTaskSource | null = null;
  for (const source of sources) {
    if (source.action === "wake") continue;
    if (!latest || (source.createdAt ?? 0) > (latest.createdAt ?? 0)) latest = source;
  }
  if (!latest) return { ...EMPTY_SESSION_TASK_LINK };
  const workItemId = latest.collaborationRecordId?.trim() || null;
  const rawTitle = workItemId ? workItemTitle(workItemId) : null;
  // Older work items were titled with a raw slice of the ask body, newlines
  // and markdown included. Flatten them the same way as the task line.
  const title = rawTitle ? notificationPlainLine(rawTitle, WORK_ITEM_TITLE_MAX) || null : null;
  return {
    workItemId,
    workItemTitle: title,
    currentTask: sessionTaskHeadline(latest.task),
  };
}
