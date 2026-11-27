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
 * Only the host title uses emphasis. The sender, request and its context
 * are regular-weight lines in the body:
 *   Scout on studio
 *   Claude · webshop
 *   Allow EnterWorktree?
 *   Create an isolated workspace.
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
  | { view: "turn.approve.command"; command: string; cwd?: string; risk?: AgentNotificationRisk; why?: string; canAlwaysAllow?: boolean }
  | { view: "turn.approve.edit"; summary?: string; files: AgentNotificationFileChange[]; risk?: AgentNotificationRisk; canAlwaysAllow?: boolean }
  | { view: "turn.approve.tool"; tool: string; why?: string; summary?: string; risk?: AgentNotificationRisk; canAlwaysAllow?: boolean }
  | { view: "turn.question.choice"; question: string; context?: string; options: string[]; multiSelect?: boolean }
  | { view: "turn.question.open"; question: string; context?: string }
  | { view: "turn.failed"; error: string; excerpt?: string[]; elapsed?: string }
  /**
   * `ready` marks a task the operator asked to hear about: finished and waiting
   * on their Continue or Hold (see task-ready). Without it, the work is done.
   */
  | { view: "work.done"; summary: string; artifacts?: AgentNotificationArtifact[]; ready?: boolean }
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
  /**
   * The agent, as the operator knows it: its display name, never a raw id.
   * `code` is its roster number ("012") when it holds one; `harness` names a
   * session whose name is only a generated handle. The lock screen shows the
   * short form from {@link notificationSenderLabel}.
   */
  sender: { name: string; agentId?: string; code?: string; harness?: string };
  /** The project's name: the repository, never a worktree folder or a path. */
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
  /**
   * Lock-screen / Watch Short Look title: Scout and the originating host, when
   * known. An approval leads with the compact action and target so it fits on
   * one glanceable line: "Open PR · owner/repo", "Edit a.ts", "Run bun test".
   */
  title: string;
  /**
   * Empty for general alerts so the OS does not add a second emphasized line.
   * An approval carries sender and project (or host) here: "Antigravity 0f6d · scout".
   */
  subtitle: string;
  /**
   * Regular-weight body: sender and project, followed by the request and
   * context. An approval puts human intent first, then compact structured
   * details or the cleaned command.
   */
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

function editTarget(files: AgentNotificationFileChange[]): string {
  return files.length === 1 && files[0] ? fileName(files[0].path) : plural(files.length, "file", "files");
}

/** What is wanted, as a verb phrase that follows the agent's name. Empty for `text`. */
function wantPhrase(n: AgentNotification): string {
  switch (n.view) {
    case "turn.approve.command": return commandWant(n.command);
    case "turn.approve.edit": return `wants to edit ${editTarget(n.files)}`;
    case "turn.approve.tool": return `wants to use ${n.tool}`;
    case "turn.question.choice": return "asks you to choose";
    case "turn.question.open": return "has a question";
    case "turn.failed": return "stopped on an error";
    case "work.done": return n.ready ? "is ready" : "finished";
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

/** The request and its context, also used for the size-limited text fallback. */
export function agentNotificationPreview(n: AgentNotification): { title: string; body: string } {
  switch (n.view) {
    case "turn.approve.command":
      return { title: "Run command?", body: notificationPlainLine(n.why) || notificationPlainLine(n.command) };
    case "turn.approve.edit":
      return {
        title: `Edit ${notificationPlainLine(editTarget(n.files))}?`,
        body: notificationPlainLine(n.summary) || notificationPlainLine(n.files.map((f) => f.path).join(", ")),
      };
    case "turn.approve.tool":
      return {
        title: `Allow ${notificationPlainLine(n.tool) || "tool use"}?`,
        body: notificationPlainLine(n.why) || notificationPlainLine(n.summary),
      };
    case "turn.question.choice":
    case "turn.question.open":
      return { title: notificationPlainLine(n.question) || "Question", body: notificationPlainLine(n.context) };
    case "turn.failed":
      return { title: "Run failed", body: notificationPlainLine(n.error) };
    case "work.done":
      return { title: n.ready ? "Ready" : "Work complete", body: notificationPlainLine(n.summary) };
    case "ask": {
      const title = n.permission ? "Permission requested" : n.reply === "optional" ? "Input welcome" : "Reply needed";
      return { title, body: notificationPlainLine(n.note) };
    }
    case "text":
      return { title: notificationPlainLine(n.title), body: notificationPlainLine(n.body) };
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

const HARNESS_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", grok: "Grok", kimi: "Kimi", opencode: "OpenCode", antigravity: "Antigravity", agy: "Antigravity", cursor: "Cursor", pi: "Pi" };

/**
 * A session the operator started outside Scout has no agent card, only the
 * actor id `native:<harness>:<session id>`. It reads as its harness, "Claude".
 * Null for any other id.
 */
export function nativeActorName(actorId: string): string | null {
  const match = /^native:([^:]+):/u.exec(actorId.trim());
  if (!match) return null;
  const harness = match[1]!.toLowerCase();
  return HARNESS_NAMES[harness] ?? `${harness.charAt(0).toUpperCase()}${harness.slice(1)}`;
}

function harnessName(value: string | null | undefined): string | null {
  const key = value?.trim().toLowerCase();
  if (!key) return null;
  const known = HARNESS_NAMES[key] ?? HARNESS_NAMES[key.split(/[-_]/u)[0]!];
  return known ?? `${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

const NAME_MAX = 24;
const ID_TAIL = 4;

/** A handle the runtime made up: `session-mw00fkgt-qbus4s`, a uuid, a long hex run. */
function isGeneratedHandle(handle: string): boolean {
  return /^session-/iu.test(handle)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-/iu.test(handle)
    || /^[0-9a-f]{12,}$/iu.test(handle);
}

/** The last characters of a session's own id, "us4s": enough to tell two apart. */
function idTail(id: string): string {
  const native = /^native:[^:]+:(.+)$/u.exec(id.trim());
  const token = native ? native[1]! : id.trim().split(".")[0]!;
  return token.replace(/[^0-9a-z]/giu, "").slice(-ID_TAIL).toLowerCase();
}

/**
 * Who sent it, in a few characters: a name, then the roster number.
 *   "pike.main.studio" with roster 005   -> "pike 005"
 *   "session-mw00fkgt-qbus4s.studio", Codex      -> "Codex 012", or "Codex us4s" unnumbered
 *   "native:claude:6f1c…a3b9"                  -> "Claude a3b9"
 * A dotted id loses its branch and host: the banner already says where. A generated
 * handle reads as its harness. Without a roster number, a generated handle
 * keeps the last characters of its id so two sessions stay apart.
 */
export function notificationSenderLabel(sender: AgentNotification["sender"]): string {
  const raw = sender.name.trim();
  const native = nativeActorName(raw);
  const code = sender.code?.trim() ?? "";
  if (/\s/u.test(raw) && !native) {
    const name = cutLine(raw, NAME_MAX);
    return code ? `${name} ${code}` : name;
  }
  const handle = native ? "" : raw.split(".")[0]!.trim();
  const generated = !handle || isGeneratedHandle(handle);
  const harness = harnessName(sender.harness) ?? native;
  let name: string;
  if (generated) name = harness ?? "Agent";
  else name = HARNESS_NAMES[handle.toLowerCase()] ?? cutLine(handle, NAME_MAX);
  const tail = code || (generated ? idTail(raw || sender.agentId || "") : "");
  return tail ? `${name} ${tail}` : name;
}

type ParsedCommand =
  | { kind: "open_pr"; repo?: string; title?: string; head?: string; base?: string; draft: boolean }
  | { kind: "merge_pr"; repo?: string; number?: string; method?: string; deleteBranch: boolean }
  | { kind: "git_push"; remote?: string; branch?: string; force: boolean; deleteRemote: boolean }
  | { kind: "git_commit"; message?: string }
  | { kind: "git_reset" }
  | { kind: "delete_files"; targets: string[] }
  | { kind: "shell"; label?: string };

function splitChainSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaped = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote === '"') {
      current += ch;
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      const trimmed = current.trim();
      if (trimmed) segments.push(trimmed);
      current = "";
      continue;
    }
    const next = command[i + 1];
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      const trimmed = current.trim();
      if (trimmed) segments.push(trimmed);
      current = "";
      i += 1;
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail) segments.push(tail);
  return segments;
}

function stripLeadingEnv(segment: string): string {
  return segment.trim().replace(/^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/u, "");
}

function tokenizeShell(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/u.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function flagValue(tokens: readonly string[], names: readonly string[]): string | undefined {
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    for (const name of names) {
      if (tok === name && i + 1 < tokens.length) return tokens[i + 1];
      if (tok.startsWith(`${name}=`)) return tok.slice(name.length + 1);
    }
  }
  return undefined;
}

function positionalAfter(tokens: readonly string[], startIndex: number, flagsWithValues: ReadonlySet<string>): string | undefined {
  let i = startIndex;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (tok.startsWith("-")) {
      const eq = tok.indexOf("=");
      if (eq < 0 && flagsWithValues.has(tok)) i += 2;
      else i += 1;
      continue;
    }
    return tok;
  }
  return undefined;
}

function stripGitGlobalFlags(args: readonly string[]): string[] {
  const out: string[] = [];
  const withValue = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
  let i = 0;
  let seenSubcommand = false;
  while (i < args.length) {
    const tok = args[i]!;
    if (!seenSubcommand) {
      if (withValue.has(tok)) {
        i += 2;
        continue;
      }
      if (tok.startsWith("--git-dir=") || tok.startsWith("--work-tree=") || tok.startsWith("-C")) {
        i += 1;
        continue;
      }
      if (tok.startsWith("-")) {
        i += 1;
        continue;
      }
      seenSubcommand = true;
    }
    out.push(tok);
    i += 1;
  }
  return out;
}

function shellCommandLabel(tokens: readonly string[]): string | undefined {
  const first = tokens[0];
  if (!first) return undefined;
  const bin = fileName(first);
  if (!bin) return undefined;
  if ((bin === "bash" || bin === "sh" || bin === "zsh") && tokens[1] && !tokens[1].startsWith("-")) {
    return cutLine(fileName(tokens[1]), 22);
  }
  const subcommands = new Set(["git", "gh", "bun", "npm", "pnpm", "yarn", "cargo", "swift", "docker", "kubectl", "xcodebuild", "scout", "python", "python3", "node"]);
  if (subcommands.has(bin)) {
    const parts = [bin];
    const args = bin === "git" ? stripGitGlobalFlags(tokens.slice(1)) : tokens.slice(1);
    for (const arg of args) {
      if (arg.startsWith("-")) break;
      parts.push(arg.includes("/") ? fileName(arg) : arg);
      if (parts.length >= 3 || (bin !== "gh" && bin !== "npm" && parts.length >= 2)) break;
    }
    return cutLine(parts.join(" "), 24);
  }
  return cutLine(bin, 22);
}

function parseCommandAction(command: string): ParsedCommand {
  const segments = splitChainSegments(command.replace(/\r/gu, "").trim());
  let fallbackLabel: string | undefined;

  for (const segment of segments) {
    const tokens = tokenizeShell(stripLeadingEnv(segment));
    const first = tokens[0];
    if (!first) continue;
    if (first === "cd") continue;

    if (first === "gh" && tokens[1] === "pr" && tokens[2] === "create") {
      return {
        kind: "open_pr",
        repo: flagValue(tokens, ["--repo", "-R"]),
        title: flagValue(tokens, ["--title", "-t"]),
        head: flagValue(tokens, ["--head", "-H"]),
        base: flagValue(tokens, ["--base", "-B"]),
        draft: tokens.includes("--draft") || tokens.includes("-d"),
      };
    }

    if (first === "gh" && tokens[1] === "pr" && tokens[2] === "merge") {
      const num = positionalAfter(tokens, 3, new Set(["--repo", "-R", "--subject", "-t", "--body", "-b", "--body-file", "-F", "--match-head-commit"]));
      const method = tokens.includes("--squash") || tokens.includes("-s")
        ? "squash"
        : tokens.includes("--rebase") || tokens.includes("-r")
          ? "rebase"
          : tokens.includes("--merge") || tokens.includes("-m")
            ? "merge"
            : undefined;
      return {
        kind: "merge_pr",
        repo: flagValue(tokens, ["--repo", "-R"]),
        number: num ? (num.startsWith("#") ? num : `#${num}`) : undefined,
        method,
        deleteBranch: tokens.includes("--delete-branch") || tokens.includes("-d"),
      };
    }

    if (first === "git") {
      const gitArgs = stripGitGlobalFlags(tokens.slice(1));
      const sub = gitArgs[0];
      if (sub === "push") {
        const rest = gitArgs.slice(1);
        const force = rest.some((t) => t === "--force" || t === "-f" || t.startsWith("--force-with-lease") || t.startsWith("+"));
        const deleteRemote = rest.includes("--delete") || rest.includes("-d");
        const positionals = rest.filter((t) => !t.startsWith("-"));
        return {
          kind: "git_push",
          remote: positionals[0],
          branch: positionals[1],
          force,
          deleteRemote,
        };
      }
      if (sub === "commit") {
        return {
          kind: "git_commit",
          message: flagValue(gitArgs.slice(1), ["-m", "--message"]),
        };
      }
      if (sub === "reset" && gitArgs.includes("--hard")) {
        return { kind: "git_reset" };
      }
    }

    if (first === "rm") {
      const targets = tokens.slice(1).filter((t) => !t.startsWith("-"));
      return { kind: "delete_files", targets };
    }

    fallbackLabel ??= shellCommandLabel(tokens);
  }

  return { kind: "shell", ...(fallbackLabel ? { label: fallbackLabel } : {}) };
}

/**
 * The verb phrase for a command, named for what it does when the command is
 * one the operator decides on often: a push, a pull request, a merge. A
 * command chained after `cd` or `&&` is read segment by segment.
 */
function commandWant(command: string): string {
  switch (parseCommandAction(command).kind) {
    case "git_push": return "wants to push";
    case "open_pr": return "wants to open a pull request";
    case "merge_pr": return "wants to merge a pull request";
    case "git_commit": return "wants to commit";
    case "git_reset": return "wants to reset the branch";
    case "delete_files": return "wants to delete files";
    case "shell": return "wants to run a command";
  }
}

const COMMAND_LINE_MAX = 160;

/**
 * A command as one clean line for the lock screen & Watch: drops boilerplate
 * `cd <dir> &&`, `git -C <dir>`, and `--body-file <path>`, shortens home paths
 * to `~/`, joins newlines with "; ", keeps markdown-looking tokens intact, and
 * cuts cleanly at a word boundary.
 */
function commandLine(command: string): string {
  let line = command
    .replace(/\r/gu, "")
    .split("\n")
    .map((part) => part.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .join("; ");
  line = line
    .replace(/^cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*&&\s*/u, "")
    .replace(/\bgit\s+-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+/gu, "git ")
    .replace(/\s+(?:--body-file|-F)(?:=|\s+)(?:"[^"]+"|'[^']+'|\S+)/gu, "")
    .replace(/\/(?:Users|home)\/[^/\s"']+\//gu, "~/")
    .replace(/\s+/gu, " ")
    .trim();
  if (line.length <= COMMAND_LINE_MAX) return line;
  const head = line.slice(0, COMMAND_LINE_MAX - 1);
  const space = head.lastIndexOf(" ");
  return `${(space >= COMMAND_LINE_MAX * 0.6 ? head.slice(0, space) : head).replace(/[\s;&|]+$/u, "")}…`;
}

function isApprovalView(n: AgentNotification): n is AgentNotification & { view: "turn.approve.command" | "turn.approve.edit" | "turn.approve.tool" } {
  return n.view === "turn.approve.command" || n.view === "turn.approve.edit" || n.view === "turn.approve.tool";
}

function uniqueLines(lines: readonly string[]): string {
  return lines.filter((line, index, all) => Boolean(line) && all.indexOf(line) === index).join("\n");
}

function approvalTitle(
  n: AgentNotification & { view: "turn.approve.command" | "turn.approve.edit" | "turn.approve.tool" },
  project?: string,
): string {
  switch (n.view) {
    case "turn.approve.command": {
      const parsed = parseCommandAction(n.command);
      switch (parsed.kind) {
        case "open_pr": {
          const verb = parsed.draft ? "Draft PR" : "Open PR";
          const target = parsed.repo || project;
          return target ? `${verb} · ${target}` : verb;
        }
        case "merge_pr": {
          const verb = parsed.number ? `Merge PR ${parsed.number}` : "Merge PR";
          const target = parsed.repo || project;
          return target ? `${verb} · ${target}` : verb;
        }
        case "git_push": {
          const verb = parsed.force ? "Force push" : parsed.deleteRemote ? "Delete branch" : "Push";
          const target = parsed.branch || parsed.remote || project;
          return target ? `${verb} · ${target}` : verb;
        }
        case "git_commit":
          return project ? `Commit · ${project}` : "Commit";
        case "git_reset":
          return project ? `Reset branch · ${project}` : "Reset branch";
        case "delete_files":
          return project ? `Delete files · ${project}` : "Delete files";
        case "shell":
          return parsed.label ? `Run ${parsed.label}` : "Run command";
      }
    }
    case "turn.approve.edit":
      return `Edit ${editTarget(n.files)}`;
    case "turn.approve.tool":
      return `Allow ${notificationPlainLine(n.tool, 28) || "tool"}`;
  }
}

/** What an approval asks for: human intent first, then compact structured details. */
function approvalBody(n: AgentNotification & { view: "turn.approve.command" | "turn.approve.edit" | "turn.approve.tool" }): string {
  switch (n.view) {
    case "turn.approve.command": {
      const parsed = parseCommandAction(n.command);
      const why = notificationPlainLine(n.why);
      switch (parsed.kind) {
        case "open_pr": {
          const prTitle = notificationPlainLine(parsed.title);
          const flow = parsed.head && parsed.base
            ? `${parsed.head} → ${parsed.base}`
            : parsed.head
              ? `from ${parsed.head}`
              : parsed.base
                ? `into ${parsed.base}`
                : "";
          const primary = prTitle || why;
          const secondary = flow || (prTitle && why && why !== prTitle ? why : "");
          if (primary || secondary) return uniqueLines([primary, secondary]);
          return commandLine(n.command);
        }
        case "merge_pr": {
          const detail = [parsed.method, parsed.deleteBranch ? "delete branch" : ""].filter(Boolean).join(" · ");
          if (why || detail) return uniqueLines([why, detail]);
          return commandLine(n.command);
        }
        case "git_commit": {
          const msg = notificationPlainLine(parsed.message);
          const primary = msg || why;
          const secondary = msg && why && why !== msg ? why : "";
          if (primary || secondary) return uniqueLines([primary, secondary]);
          return commandLine(n.command);
        }
        case "git_push":
        case "git_reset":
        case "delete_files":
        case "shell":
          return uniqueLines([why, commandLine(n.command)]);
      }
    }
    case "turn.approve.edit": {
      const summary = notificationPlainLine(n.summary);
      const shown = n.files.slice(0, 4).map((f) => {
        const stats = f.added > 0 || f.removed > 0 ? ` (+${f.added} -${f.removed})` : "";
        return `${f.path}${stats}`;
      });
      if (n.files.length > 4) shown.push(`+${n.files.length - 4} more`);
      const files = notificationPlainLine(shown.join(", "));
      return uniqueLines([summary, files]);
    }
    case "turn.approve.tool": {
      const why = notificationPlainLine(n.why);
      const summary = notificationPlainLine(n.summary);
      return uniqueLines([why, summary]);
    }
  }
}

export function collapseAgentNotification(n: AgentNotification): AgentNotificationCollapse {
  const host = n.host?.trim().replace(/\s+/gu, " ");
  const project = n.project?.trim().replace(/\s+/gu, " ");
  const sender = notificationSenderLabel(n.sender).replace(/\s+/gu, " ");
  if (isApprovalView(n)) {
    // Watch-first decision layout: compact action + target in the bold title
    // (Short Look), sender + project/host in the subtitle, human intent first
    // in the body.
    return {
      title: approvalTitle(n, project),
      subtitle: [sender, project || host].filter(Boolean).join(" · "),
      body: approvalBody(n),
      headline: agentNotificationHeadline(n),
      category: agentNotificationCategory(n),
      threadId: `scout.agent.${n.sender.agentId ?? n.sender.name}`,
      level: n.level,
    };
  }
  const source = [sender, project].filter(Boolean).join(" · ");
  const preview = agentNotificationPreview(n);
  return {
    title: host ? `Scout on ${host}` : "Scout",
    subtitle: "",
    body: [source, preview.title, preview.body].filter(Boolean).join("\n"),
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
      return { ...base, tool: clip(base.tool, 80), ...(base.why ? { why: clip(base.why, 240) } : {}), ...(base.summary ? { summary: clip(base.summary, 300) } : {}) };
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
