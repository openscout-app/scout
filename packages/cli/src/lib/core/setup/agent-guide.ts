import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * The project's AGENTS.md block: a few lines every harness reads at session
 * start, pointing at Scout's own help instead of copying it, so it never goes
 * stale. Added only when the operator runs `scout setup agents-md`, once, and
 * removable with `--remove`. Never written to a home-level file.
 */
export const SCOUT_BLOCK_BEGIN = "<!-- scout:begin -->";
export const SCOUT_BLOCK_END = "<!-- scout:end -->";

export const SCOUT_BLOCK_BODY = [
  "## Scout",
  "",
  "- Work for another agent, or on another machine, goes through Scout: `scout ask` (MCP `ask`).",
  "- An ask creates a task; use `--fyi` only for news. Answer with `scout reply --ref <task>`; `--progress` keeps it open. A harness final is already an answer: do not reply twice.",
  "- Another machine: `scout ask --on <host> --project <path on that host> --harness <claude|codex>`; `scout hosts` lists machines and their projects. Don't ssh in to launch agents.",
  "- Syntax: `scout ask --help`, `scout help --detail`. Added by `scout setup agents-md`; `scout setup agents-md --remove` takes it out.",
].join("\n");

export function scoutBlock(): string {
  return `${SCOUT_BLOCK_BEGIN}\n${SCOUT_BLOCK_BODY}\n${SCOUT_BLOCK_END}`;
}

/**
 * Add or refresh the block; text outside the markers is never touched. A new
 * block is appended as exactly "\n<block>\n" (just "<block>\n" in an empty
 * file), so removing it can take back exactly those bytes.
 */
export function applyScoutBlock(text: string): { text: string; change: "added" | "updated" | "unchanged" } {
  const block = scoutBlock();
  const span = blockSpan(text);
  if (span) {
    const next = text.slice(0, span.start) + block + text.slice(span.end);
    return { text: next, change: next === text ? "unchanged" : "updated" };
  }
  return { text: text ? `${text}\n${block}\n` : `${block}\n`, change: "added" };
}

function blockSpan(text: string): { start: number; end: number } | null {
  const start = text.indexOf(SCOUT_BLOCK_BEGIN);
  const endMarker = start < 0 ? -1 : text.indexOf(SCOUT_BLOCK_END, start);
  return start < 0 || endMarker < 0 ? null : { start, end: endMarker + SCOUT_BLOCK_END.length };
}

/** Remove the block plus the one newline on each side that adding brought; every other byte stays. */
export function removeScoutBlock(text: string): { text: string; change: "removed" | "absent" } {
  const span = blockSpan(text);
  if (!span) return { text, change: "absent" };
  let before = text.slice(0, span.start);
  let after = text.slice(span.end);
  if (before.endsWith("\n")) before = before.slice(0, -1);
  if (after.startsWith("\n")) after = after.slice(1);
  return { text: before + after, change: "removed" };
}

function gitRoot(start: string): string | null {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** lstat without following links: a dangling symlink still counts as an entry. */
function pathEntry(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

export type AgentGuideResult = {
  path: string;
  change: "added" | "updated" | "unchanged" | "removed" | "absent";
  dryRun: boolean;
  /** The file's text after the change (or as it would be, on a dry run). */
  preview: string;
};

export function runAgentGuide(options: {
  directory: string;
  remove?: boolean;
  dryRun?: boolean;
  homeDirectory?: string;
}): AgentGuideResult {
  const root = gitRoot(options.directory) ?? resolve(options.directory);
  const home = resolve(options.homeDirectory ?? homedir());
  if (root === home) {
    throw new Error(`refusing to edit ${join(root, "AGENTS.md")}: that is a home-level file read by every project. Run this inside a project.`);
  }
  const path = join(root, "AGENTS.md");
  // A symlinked AGENTS.md can point anywhere, including a home-level file;
  // only a regular file inside the project is edited.
  if (pathEntry(path) && !pathEntry(path)!.isFile()) {
    throw new Error(`refusing to edit ${path}: it is a symlink or not a regular file. Add the block to the file it points at by hand, or replace the link with a file.`);
  }
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const outcome = options.remove ? removeScoutBlock(current) : applyScoutBlock(current);
  const changed = outcome.change === "added" || outcome.change === "updated" || outcome.change === "removed";
  if (changed && !options.dryRun) writeFileSync(path, outcome.text);
  return { path, change: outcome.change, dryRun: Boolean(options.dryRun), preview: outcome.text };
}

/**
 * Read-only Scout MCP tools a harness can allow without a prompt. Everything
 * that sends or starts work (`ask`, `reply`, …) is left to the
 * harness's normal approval on purpose.
 */
export const SCOUT_READ_ONLY_TOOLS = [
  "whoami",
  "hosts_list",
  "where",
  "check",
  "agents_search",
  "agents_resolve",
  "invocations_get",
  "invocations_wait",
  "sessions_inventory",
  "sessions_search",
] as const;

export function claudeAllowList(serverName = "scout"): string[] {
  return SCOUT_READ_ONLY_TOOLS.map((tool) => `mcp__${serverName}__${tool}`);
}
