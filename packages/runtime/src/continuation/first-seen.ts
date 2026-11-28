/**
 * First-seen permission shape tracker.
 *
 * When the permission watcher auto-approves a call that fits the operator's
 * policy:
 *   - First time seeing a (project, tool, command-shape) tuple: allow it
 *     without blocking AND flag `firstSeen: true` so the runtime can send a
 *     quiet heads-up notification to the phone.
 *   - Subsequent repeats of that same shape: allow quietly into the permission
 *     ledger (and live in-app toasts) without sending another push.
 */

import { basename } from "node:path";
import type { ContinuationAuditEntry } from "./grants.js";

const SUBCOMMAND_BINS = new Set([
  "git",
  "gh",
  "bun",
  "npm",
  "pnpm",
  "yarn",
  "cargo",
  "swift",
  "docker",
  "kubectl",
  "xcodebuild",
  "scout",
  "python",
  "python3",
  "node",
]);

const FILE_TOOL_ALIASES: Record<string, string> = {
  read: "read",
  read_file: "read",
  view_file: "read",
  edit: "edit",
  edit_file: "edit",
  multiedit: "edit",
  notebookedit: "edit",
  write: "write",
  write_file: "write",
  glob: "search",
  grep: "search",
  grep_search: "search",
  find_by_name: "search",
  list_dir: "search",
};

const SHELL_TOOLS = new Set(["bash", "shell", "run_command", "exec_command"]);

export type PermissionShapeInput = {
  projectRoot?: string | null;
  tool?: string | null;
  command?: string | null;
};

export type PermissionShapeObservation = {
  firstSeen: boolean;
  shapeKey: string;
  label: string;
};

function normalizeProjectKey(projectRoot: string | null | undefined): string {
  const trimmed = (projectRoot ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return "global";
  return trimmed;
}

function extractCommandShape(command: string | null | undefined): string {
  const raw = (command ?? "").replace(/\r/g, "").trim();
  if (!raw) return "command";
  // Take first segment before &&, ;, |, or newline, stripping leading `cd ... &&` and env vars.
  const segments = raw
    .split(/\s*(?:&&|\|\||;|\n)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const seg of segments) {
    const cleaned = seg.replace(/^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "").trim();
    const tokens = cleaned.split(/\s+/).filter(Boolean);
    const first = tokens[0];
    if (!first || first === "cd") continue;
    const bin = basename(first).toLowerCase();
    if (!bin) continue;
    if (SUBCOMMAND_BINS.has(bin)) {
      const rest = tokens.slice(1);
      // Skip git -C <dir> flags
      let i = 0;
      if (bin === "git") {
        while (i < rest.length) {
          const tok = rest[i]!;
          if (tok === "-C" || tok === "-c" || tok === "--git-dir" || tok === "--work-tree") {
            i += 2;
            continue;
          }
          if (tok.startsWith("-")) {
            i += 1;
            continue;
          }
          break;
        }
      }
      const sub = rest[i] && !rest[i]!.startsWith("-") ? rest[i]!.toLowerCase() : null;
      if (bin === "gh" && sub && rest[i + 1] && !rest[i + 1]!.startsWith("-")) {
        return `${bin} ${sub} ${rest[i + 1]!.toLowerCase()}`;
      }
      return sub ? `${bin} ${sub}` : bin;
    }
    return bin;
  }
  return "command";
}

export function permissionShape(input: PermissionShapeInput): { shapeKey: string; label: string } {
  const projectKey = normalizeProjectKey(input.projectRoot);
  const rawTool = (input.tool ?? "").trim();
  const lowerTool = rawTool.toLowerCase();

  if (FILE_TOOL_ALIASES[lowerTool]) {
    const family = FILE_TOOL_ALIASES[lowerTool]!;
    const labelMap: Record<string, string> = {
      read: "Read files",
      edit: "Edit files",
      write: "Write files",
      search: "Search files",
    };
    return {
      shapeKey: `${projectKey}::file:${family}`,
      label: labelMap[family] ?? rawTool,
    };
  }

  if (SHELL_TOOLS.has(lowerTool) || (!rawTool && input.command)) {
    const cmdShape = extractCommandShape(input.command);
    return {
      shapeKey: `${projectKey}::cmd:${cmdShape}`,
      label: cmdShape,
    };
  }

  const normalizedTool = lowerTool || "tool";
  return {
    shapeKey: `${projectKey}::tool:${normalizedTool}`,
    label: rawTool || "Tool",
  };
}

export class FirstSeenPermissionTracker {
  private readonly seen = new Set<string>();

  seed(entries: readonly ContinuationAuditEntry[]): void {
    for (const entry of entries) {
      const allowed = entry.decision === "approved"
        || (entry.decision === "answered" && (entry.answer === "once" || entry.answer === "project"))
        || (!entry.decision && entry.outcome === "sent");
      if (!allowed) continue;
      const { shapeKey } = permissionShape({
        projectRoot: entry.projectRoot,
        tool: entry.tool,
        command: entry.command,
      });
      this.seen.add(shapeKey);
    }
  }

  observeAutoAllow(input: PermissionShapeInput): PermissionShapeObservation {
    const { shapeKey, label } = permissionShape(input);
    const firstSeen = !this.seen.has(shapeKey);
    this.seen.add(shapeKey);
    return { firstSeen, shapeKey, label };
  }

  hasSeen(input: PermissionShapeInput): boolean {
    return this.seen.has(permissionShape(input).shapeKey);
  }
}
