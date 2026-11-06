/**
 * Agent notifications: what an agent's notification IS, so the phone can pick
 * the view that fits it.
 *
 * Every notification declares a `view` and the typed fields that view needs.
 * The same record renders in three places: the lock screen (text only, via
 * {@link collapseAgentNotification}), the long-press view, and the app's
 * Notifications row. A client that doesn't know a `view` renders `text`.
 *
 * Everything that wants the operator is a question of some kind; the prefix
 * says WHEN it was asked:
 *   - `turn.*` is mid-turn: the turn is paused until the operator answers.
 *   - `ask` is outside a turn: the agent finished and reached out on its own.
 * Only declared things become notifications. Inferred attention never does.
 *
 * Every kind reads by one formula (see {@link collapseAgentNotification}):
 *   title    who wants what       "pike wants to run a command"
 *   subtitle the project          "openscout"
 *   body     what it is about     "Show working tree status"
 * The body is one plain line taken from a summary, a question, or the start
 * of a note. Markdown is stripped. It is never a slice from inside a body.
 *
 * The record travels sealed (see the runtime's mobile-push sealing): the relay
 * that delivers the push never reads any of it.
 */

export const AGENT_NOTIFICATION_VERSION = 1 as const;

export type AgentNotificationRisk = "low" | "medium" | "high";

export type AgentNotificationFileChange = {
  path: string;
  added: number;
  removed: number;
};

export type AgentNotificationArtifact = {
  kind: "pr" | "build" | "file" | "link";
  label: string;
  meta?: string;
  url?: string;
};

/** Risk is left out when the harness did not state it. It is never guessed. */
export type AgentNotificationView =
  | { view: "turn.approve.command"; command: string; cwd?: string; risk?: AgentNotificationRisk; why?: string }
  | { view: "turn.approve.edit"; summary?: string; files: AgentNotificationFileChange[]; risk?: AgentNotificationRisk }
  | { view: "turn.approve.tool"; tool: string; summary?: string; risk?: AgentNotificationRisk }
  | { view: "turn.question.choice"; question: string; context?: string; options: string[]; multiSelect?: boolean }
  | { view: "turn.question.open"; question: string; context?: string }
  | { view: "turn.failed"; error: string; excerpt?: string[]; elapsed?: string }
  | { view: "work.done"; summary: string; artifacts?: AgentNotificationArtifact[] }
  /**
   * `reply` says whether the agent waits on the answer (`required`) or will
   * go on without one (`optional`). `permission` marks a declared request for
   * permission rather than a question.
   */
  | { view: "ask"; note: string; options?: string[]; reply?: "required" | "optional"; permission?: boolean }
  | { view: "text"; title: string; body?: string };

export type AgentNotificationViewName = AgentNotificationView["view"];

export type AgentNotificationAction =
  | "approve"
  | "deny"
  | "reply"
  | "open_chat"
  | "open_link";

/**
 * How the phone delivers a notification. The levels match iOS interruption
 * levels:
 *   - `time-sensitive`: an agent declared it cannot go on until the operator
 *     answers, and asked the operator. It breaks through Focus.
 *   - `active`: the operator must act before the work goes on, but nobody
 *     addressed the operator: a harness permission dialog, or a mid-turn
 *     question in a session. Sound and lock screen, no Focus breakthrough.
 *   - `passive`: news. It goes to the notification list without a sound.
 */
export type AgentNotificationLevel = "time-sensitive" | "active" | "passive";

/**
 * Where a tap lands. `chat` opens the conversation at the message. `inbox`
 * opens the inbox row for the item (an approval, a question, a permission
 * request), where the operator can answer it.
 */
export type AgentNotificationOpen = "chat" | "inbox";

export type AgentNotification = AgentNotificationView & {
  v: typeof AGENT_NOTIFICATION_VERSION;
  /** Stable id of the thing that wants attention (inbox item, message, request). */
  itemId: string;
  /** The agent, as the operator knows it: its display name, never a raw id. */
  sender: { name: string; agentId?: string };
  project?: string;
  /** The host it happened on. */
  host?: string;
  level: AgentNotificationLevel;
  createdAt: number;
  /** Routing back into the app. */
  route?: {
    open?: AgentNotificationOpen;
    sessionId?: string;
    turnId?: string;
    blockId?: string;
    conversationId?: string;
    messageId?: string;
    /** The open request record (a permission request or a question) the tap lands on. */
    requestId?: string;
  };
};

export type AgentNotificationCollapse = {
  /** Lock-screen title: who wants what. */
  title: string;
  /** Lock-screen subtitle: the project, or empty. */
  subtitle: string;
  /** Lock-screen body: what it is about, as one plain line. */
  body: string;
  /** Row headline in the app: what is wanted, without who. */
  headline: string;
  /** iOS notification category, which carries the actions. */
  category: string;
  /** One thread per agent, so stacks group by who sent them. */
  threadId: string;
  level: AgentNotificationLevel;
};

/**
 * What travels sealed in a push: the record plus its lock-screen text,
 * computed once here so the phone's extension applies it verbatim and no
 * client re-derives the words. `urgent` is for phones built before `level`:
 * it is true exactly when the level is `time-sensitive`.
 */
export type SealedAgentNotification = AgentNotification & {
  urgent: boolean;
  lockScreen: Pick<AgentNotificationCollapse, "title" | "subtitle" | "body" | "category" | "threadId" | "level">;
};

export function sealedAgentNotification(n: AgentNotification): SealedAgentNotification {
  const { title, subtitle, body, category, threadId, level } = collapseAgentNotification(n);
  return { ...n, urgent: level === "time-sensitive", lockScreen: { title, subtitle, body, category, threadId, level } };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function fileName(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

/** What is wanted, as a verb phrase that follows the agent's name. Empty for `text`. */
function wantPhrase(n: AgentNotification): string {
  switch (n.view) {
    case "turn.approve.command": return "wants to run a command";
    case "turn.approve.edit":
      return n.files.length === 1 && n.files[0]
        ? `wants to edit ${fileName(n.files[0].path)}`
        : `wants to edit ${plural(n.files.length, "file", "files")}`;
    case "turn.approve.tool": return `wants to use ${n.tool}`;
    case "turn.question.choice": return "asks you to choose";
    case "turn.question.open": return "has a question";
    case "turn.failed": return "stopped on an error";
    case "work.done": return "finished";
    case "ask":
      if (n.permission) return "needs your permission";
      return n.reply === "optional" ? "would like your input" : "is waiting on your answer";
    case "text": return "";
  }
}

/** Row headline in the app: what is wanted, without who. */
export function agentNotificationHeadline(n: AgentNotification): string {
  const want = wantPhrase(n);
  if (!want) return notificationPlainLine(n.view === "text" ? n.title : "") || n.sender.name;
  return `${want.charAt(0).toUpperCase()}${want.slice(1)}`;
}

/** What the notification is about, as plain text. One line, except for `text`. */
function aboutText(n: AgentNotification): string {
  switch (n.view) {
    case "turn.approve.command": return notificationPlainLine(n.why) || notificationPlainLine(n.command);
    case "turn.approve.edit": return notificationPlainLine(n.summary) || notificationPlainLine(n.files.map((f) => f.path).join(", "));
    case "turn.approve.tool": return notificationPlainLine(n.summary);
    case "turn.question.choice": return notificationPlainLine(n.question);
    case "turn.question.open": return notificationPlainLine(n.question);
    case "turn.failed": return notificationPlainLine(n.error);
    case "work.done": return notificationPlainLine(n.summary);
    case "ask": return notificationPlainLine(n.note);
    case "text": return [notificationPlainLine(n.title), notificationPlainLine(n.body)].filter(Boolean).join("\n");
  }
}

/** The actions a view offers, in order. The first is the primary one. */
export function agentNotificationActions(n: AgentNotification): AgentNotificationAction[] {
  switch (n.view) {
    case "turn.approve.command":
    case "turn.approve.edit":
    case "turn.approve.tool":
      return ["approve", "deny"];
    case "turn.question.choice":
    case "turn.question.open":
    case "ask":
      return ["reply"];
    case "turn.failed":
      return ["open_chat"];
    case "work.done":
      return (n.artifacts ?? []).some((a) => a.url) ? ["open_link", "open_chat"] : ["open_chat"];
    case "text":
      return [];
  }
}

/** iOS category ids. Registered by the app with their actions. */
export function agentNotificationCategory(n: AgentNotification): string {
  switch (n.view) {
    case "turn.approve.command":
    case "turn.approve.edit":
    case "turn.approve.tool":
      return "scout.approval";
    case "turn.question.choice":
    case "turn.question.open":
    case "ask":
      return "scout.question";
    case "turn.failed":
    case "work.done":
      return "scout.open";
    case "text":
      return "scout.text";
  }
}

export function collapseAgentNotification(n: AgentNotification): AgentNotificationCollapse {
  const who = n.sender.name.trim() || "An agent";
  const want = wantPhrase(n);
  return {
    title: want ? `${who} ${want}` : who,
    subtitle: n.project?.trim() ?? "",
    body: aboutText(n),
    headline: agentNotificationHeadline(n),
    category: agentNotificationCategory(n),
    threadId: `scout.agent.${n.sender.agentId ?? n.sender.name}`,
    level: n.level,
  };
}

const PLAIN_LINE_MAX = 160;

/**
 * The first line of `value` that says something, as plain text: markdown
 * markers, links, emphasis, and code fences are removed, whitespace is
 * collapsed, and a long line is cut at a sentence or a word. Lines inside a
 * code fence are used only when nothing else is there.
 */
export function notificationPlainLine(value: string | null | undefined, max = PLAIN_LINE_MAX): string {
  if (!value) return "";
  let inFence = false;
  let fenced = "";
  for (const raw of value.replace(/\r/g, "").split("\n")) {
    if (/^\s*(?:```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    const line = plainInline(stripBlockMarker(raw));
    if (!line || /^[-*_=|:+\s]+$/.test(line)) continue;
    if (inFence) {
      fenced ||= line;
      continue;
    }
    return cutLine(line, max);
  }
  return fenced ? cutLine(fenced, max) : "";
}

function stripBlockMarker(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*(?:>\s?)+/, "")
    .replace(/^\s*[-*+]\s+(?:\[[ xX]\]\s+)?/, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "");
}

function plainInline(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<(https?:[^>\s]+)>/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
    .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, "$1$2")
    .replace(/\s*\|\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cutLine(line: string, max: number): string {
  if (line.length <= max) return line;
  const head = line.slice(0, max);
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
  if (sentence >= 24) return head.slice(0, sentence + 1);
  const space = head.lastIndexOf(" ", max - 1);
  const cut = space >= max * 0.6 ? head.slice(0, space) : head.slice(0, max - 1);
  return `${cut.replace(/[\s,;:.-]+$/, "")}…`;
}

const MAX_TEXT = 600;

function clip(value: string, max = MAX_TEXT): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Bound every free-text field so a sealed record fits inside one APNs push
 * (4 KB, shared with the alert text). Lists are capped too; the app loads the
 * full item when it opens.
 */
export function clampAgentNotification(n: AgentNotification): AgentNotification {
  const base = {
    ...n,
    sender: { ...n.sender, name: clip(n.sender.name, 80) },
    ...(n.project ? { project: clip(n.project, 80) } : {}),
    ...(n.host ? { host: clip(n.host, 80) } : {}),
  };
  switch (base.view) {
    case "turn.approve.command":
      return { ...base, command: clip(base.command, 400), ...(base.why ? { why: clip(base.why, 300) } : {}) };
    case "turn.approve.edit":
      return { ...base, files: base.files.slice(0, 8).map((f) => ({ ...f, path: clip(f.path, 160) })), ...(base.summary ? { summary: clip(base.summary, 300) } : {}) };
    case "turn.approve.tool":
      return { ...base, tool: clip(base.tool, 80), ...(base.summary ? { summary: clip(base.summary, 300) } : {}) };
    case "turn.question.choice":
      return { ...base, question: clip(base.question, 400), options: base.options.slice(0, 6).map((o) => clip(o, 60)), ...(base.context ? { context: clip(base.context, 300) } : {}) };
    case "turn.question.open":
      return { ...base, question: clip(base.question, 400), ...(base.context ? { context: clip(base.context, 300) } : {}) };
    case "turn.failed":
      return { ...base, error: clip(base.error, 200), ...(base.excerpt ? { excerpt: base.excerpt.slice(-4).map((l) => clip(l, 120)) } : {}) };
    case "work.done":
      return { ...base, summary: clip(base.summary, 300), ...(base.artifacts ? { artifacts: base.artifacts.slice(0, 4) } : {}) };
    case "ask":
      return { ...base, note: clip(base.note, 500), ...(base.options ? { options: base.options.slice(0, 6).map((o) => clip(o, 60)) } : {}) };
    case "text":
      return { ...base, title: clip(base.title, 120), ...(base.body ? { body: clip(base.body, 400) } : {}) };
  }
}
