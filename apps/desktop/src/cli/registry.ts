export type ScoutCommandRegistration = {
  name: string;
  hidden?: boolean;
  summary: string;
  status?: "stable" | "deprecated";
  canonicalName?: string;
  deprecationMessage?: string;
  /** Provided by an installed extension (`scout-<name>`), not built in. `install` says how to get it. */
  provider?: "extension";
  install?: string;
};

export const SCOUT_COMMANDS: ScoutCommandRegistration[] = [
  { name: "help", summary: "Show help text" },
  { name: "version", summary: "Print the Scout CLI version" },
  { name: "integration", summary: "Prepare and resume local project-agent integrations" },
  { name: "setup", summary: "Bootstrap local settings and broker" },
  { name: "report", summary: "Upload diagnostics with a private local fallback" },
  { name: "feedback", summary: "Send a note, optionally with diagnostics" },
  { name: "doctor", summary: "Show broker health and project inventory" },
  { name: "quarantine", summary: "Inspect preserved failures and acknowledge reviewed evidence" },
  { name: "status", summary: "Inspect work by handle or filter all blocked/failed work" },
  { name: "operator", summary: "Reach your operator: a message, or --question when blocked" },
  { name: "notify", summary: "Send your operator a message and optional image" },
  { name: "diff", summary: "Inspect worktree or session-scoped diffs" },
  { name: "runtimes", summary: "Show harness catalog and readiness" },
  { name: "providers", summary: "Show provider usage quota windows" },
  { name: "role", summary: "Assign roles (orchestrator) and read/write mission logs" },
  { name: "env", summary: "Show executable and agent identity context" },
  { name: "instance", summary: "List or release non-prod OpenScout instances (OPENSCOUT_INSTANCE)" },
  { name: "whoami", summary: "Resolve your current Scout sender identity" },
  { name: "where", summary: "Find the top 3 local projects, agents or sessions by topic" },
  { name: "locate", summary: "Find a roughly remembered recipient across machines with local topic evidence" },
  { name: "route", summary: "Deprecated alias for where", canonicalName: "where", status: "deprecated", hidden: true, deprecationMessage: "`scout route` is deprecated; use `scout where`." },
  { name: "search", summary: "Past harness sessions — explicit index → FTS (prefer over grepping ~/.codex|claude|kimi)" },
  { name: "inbox", summary: "Read recent direct or addressed messages for this identity" },
  { name: "match", summary: "Rendezvous with one participant by shared project topic" },
  { name: "send", summary: "Tell one target or post to an explicit channel" },
  { name: "tell", summary: "Post a durable FYI or status; never creates work (explicit send)" },
  { name: "session", summary: "Actions on a harness session" },
  { name: "statusline", summary: "Capture harness statusline metadata" },
  { name: "speak", summary: "Send and speak aloud via TTS" },
  { name: "voice", summary: "Codex voice chat in the ChatGPT app: status, talk, mic, speakers, stop" },
  { name: "ask", summary: "Hand work to one agent and wait for acknowledgement" },

  { name: "alias", summary: "Manage scoped broker-owned route aliases" },
  { name: "wait", summary: "Wait for an ask by invocation, flight, message, or ref" },
  { name: "flight", summary: "Follow an existing ask flight" },
  { name: "label", summary: "Watch, feed, or brief related work by label" },
  { name: "card", summary: "Create a dedicated reply-ready Scout agent card" },
  { name: "watch", summary: "Stream broker messages" },
  { name: "tail", summary: "Stream observed harness events" },
  { name: "who", summary: "List the agent roster (not a live work probe)" },
  { name: "check", summary: "Read live work, optionally resolving a topic first" },
  { name: "recent", summary: "Alias for check", canonicalName: "check", hidden: true },
  { name: "hosts", summary: "Mesh machines: activity, projects, and how to start work there (ask --on)" },
  { name: "latest", summary: "Read the broker activity timeline" },
  { name: "mcp", summary: "Run a Scout MCP server over stdio" },
  { name: "chat", summary: "Join Chat invitations, read, post, reply, and watch" },
  { name: "channel", summary: "Read channel messages or run a Claude Code channel server" },
  { name: "broadcast", summary: "Broadcast to channel.shared" },
  { name: "up", summary: "Spawn a local agent for a project" },
  { name: "down", summary: "Stop one or all local agents" },
  { name: "ps", summary: "List configured local agents" },
  { name: "restart", summary: "Restart configured local agents" },
  { name: "app", summary: "Start, stop, restart, or inspect the OpenScout app and its services" },
  { name: "menu", summary: "Launch the OpenScout macOS menu bar app" },
  { name: "install", summary: "Download and install the OpenScout macOS app" },
  { name: "update", summary: "Update this machine, or report on named machines" },
  { name: "config", summary: "View or set user config (name, handle, agent name pool, etc.)" },
  { name: "machines", summary: "The computers Scout can see — mesh nodes, tailnet peers, LAN neighbours" },
  { name: "extensions", summary: "List installed CLI extensions" },
  { name: "mesh", summary: "Mesh status, diagnostics, and trust-cone peers/enrollment" },
  {
    name: "monitor",
    summary: "Retired: legacy OpenTUI console (use 'scout tui')",
    status: "deprecated",
    deprecationMessage: "`scout monitor` has been retired. Use `scout tui`.",
  },
  { name: "pair", summary: "Pair a companion device via QR" },
  { name: "server", summary: "Run the Scout web UI (Bun; see: scout server start/open)" },
  { name: "web", summary: "Install the full web app with a download key (login/install/status)" },
  { name: "tui", summary: "Launch the Scout TUI" },
  { name: "init", summary: "Write ~/.openscout/config.json with broker/web/pairing ports" },
];

export function listScoutPrimaryCommands(): ScoutCommandRegistration[] {
  return SCOUT_COMMANDS.filter((command) => !command.hidden && !command.provider && (command.status ?? "stable") === "stable");
}

/** Verbs Scout knows about but leaves to extensions. */
export function listScoutExtensionCommands(): ScoutCommandRegistration[] {
  return SCOUT_COMMANDS.filter((command) => command.provider === "extension");
}

export function missingScoutExtensionMessage(command: ScoutCommandRegistration): string {
  return `scout ${command.name} is provided by an extension that is not installed. ${command.install ?? ""}`.trim();
}

export function listScoutDeprecatedCommands(): ScoutCommandRegistration[] {
  return SCOUT_COMMANDS.filter((command) => !command.hidden && command.status === "deprecated");
}

export function findScoutCommandRegistration(name: string): ScoutCommandRegistration | undefined {
  return SCOUT_COMMANDS.find((command) => command.name === name);
}

/** Optimal string alignment distance: an adjacent swap ("hsots") costs one edit. */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
      }
    }
  }
  return d[a.length]![b.length]!;
}

/** Closest primary command for a typo, or undefined when nothing is near. */
export function suggestScoutCommand(name: string): string | undefined {
  const wanted = name.trim().toLowerCase();
  if (!wanted || wanted.includes(" ")) return undefined;
  let best: { name: string; distance: number } | undefined;
  for (const command of listScoutPrimaryCommands()) {
    const distance = editDistance(wanted, command.name);
    if (!best || distance < best.distance) best = { name: command.name, distance };
  }
  return best && best.distance <= Math.max(1, Math.floor(wanted.length / 3)) ? best.name : undefined;
}

/**
 * The teaching error for an unknown command: a near miss gets "did you mean",
 * anything else gets the version, because an agent copying a command from
 * newer docs onto an older install is the common cause.
 */
export function unknownScoutCommandMessage(name: string, version: string): string {
  const suggestion = suggestScoutCommand(name);
  if (suggestion) return `unknown command: ${name}. Did you mean \`scout ${suggestion}\`? (scout help --detail lists all)`;
  return `unknown command: ${name}. This scout is ${version}; if \`${name}\` is from newer docs, run \`scout update\`. All commands: scout help --detail`;
}
