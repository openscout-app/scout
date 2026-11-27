import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ManagedPermissionPrompt } from "./managed-permission.js";
import {
  classifyContinuationRisk,
  continuationAllowsRisk,
  decideContinuation,
  type ContinuationRisk,
} from "./continuation/decide.js";
import { parseContinuationDialog } from "./continuation/dialog.js";
import type { ContinuationLevel } from "./continuation/policy.js";
import {
  loadContinuationPolicy,
  resolveContinuationGrant,
  type ContinuationPolicyFile,
} from "./continuation/grants.js";

export const PERMISSION_SUPERVISOR_ACTOR_ID = "permission-supervisor";

export type PermissionSupervisorVerdict = {
  act: "continue" | "notify";
  /** The grant level that let a `continue` through. */
  level?: ContinuationLevel;
  reason: string;
  risk: ContinuationRisk;
  grant: string;
};

export function decidePermissionSupervisor(
  prompt: Pick<ManagedPermissionPrompt, "projectRoot" | "cwd" | "text" | "decisions">,
  policy: ContinuationPolicyFile = loadContinuationPolicy(),
): PermissionSupervisorVerdict {
  const codex = codexCommand(prompt.text);
  const commandCwd = codex && !("invalid" in codex) ? codex.cwd : prompt.cwd;
  const grant = resolveContinuationGrant(policy, {
    herdrSession: "",
    paneId: "",
    cwd: prompt.projectRoot,
    foregroundCwd: commandCwd,
  });
  const notify = (reason: string, risk: ContinuationRisk = "unknown"): PermissionSupervisorVerdict => ({
    act: "notify", reason, risk, grant: grant.source,
  });
  if (codex && "invalid" in codex) return notify("unparsed Codex command");
  if (codex && !codex.cwd) return notify("command has no working directory");
  if (commandCwd !== undefined && !withinProject(prompt.projectRoot, commandCwd)) {
    return notify("command leaves the granted project");
  }
  if (grant.level === "ask") return notify("no project continuation grant");
  if (!prompt.decisions.includes("once")) return notify("one-time approval is not offered");

  const inProject = projectPathScope(prompt.projectRoot, policy, grant.source);
  if (codex) {
    const risk = classifyPermissionCommandRisk(codex.command, inProject);
    if (!continuationAllowsRisk(grant.level, risk)) {
      return notify(`${grant.level} does not auto-continue ${risk}`, risk);
    }
    return { act: "continue", level: grant.level, reason: `${grant.level} continues ${risk}`, risk, grant: grant.source };
  }

  const dialog = parseContinuationDialog(prompt.text);
  const verdict = decideContinuation({ paneBody: prompt.text, policy: grant.level });
  const localizedOnly = verdict.act === "notify" && verdict.risk === "unknown" && dialog.commandExact
    && dialog.action !== "edit" && dialog.action !== "write" && verdict.reason === `${grant.level} does not auto-continue unknown`;
  if (verdict.act !== "continue" && !localizedOnly) return notify(verdict.reason, verdict.risk);
  const risk = dialog.commandExact && dialog.action !== "edit" && dialog.action !== "write"
    ? classifyPermissionCommandRisk(dialog.command, inProject)
    : verdict.risk;
  if (!continuationAllowsRisk(grant.level, risk)) return notify(`${grant.level} does not auto-continue ${risk}`, risk);
  return { act: "continue", level: grant.level, reason: `${grant.level} continues ${risk}`, risk, grant: grant.source };
}

/** A package script that tests, checks or builds, optionally namespaced (`landing:build`, `test:unit`). */
const LOCAL_SCRIPT = /^(?:[\w.-]+:)*(?:test|lint|typecheck|check|build)(?::[\w.-]+)*$/;
/** Characters after which a command's words are no longer plain; the classifier refuses these itself. */
const UNPLAIN = /[;&|<>`\n\\$"'#*?{}[\]!]/;
/** Options that only move a package manager or git into another directory. */
const DIRECTORY_OPTION = new Set(["--cwd", "--prefix", "--dir", "-C"]);
const DIRECTORY_TOOLS = new Set(["bun", "npm", "pnpm", "yarn", "git"]);
const OUTSIDE_PROJECT_PATH = /(?:^|\s|=|@)(?:~|\/)|\.\./;
const ATTACHED_ABSOLUTE_PATH = /^--?[A-Za-z][A-Za-z0-9-]*=?(?:\/|~)/;
const HTTP_URL = /^https?:\/\/\S+$/i;
const FILE_URL = /\bfile:/i;
const SECRET_PATH = /\.env\b|\bid_rsa\b|\.npmrc\b|\baws_secret|\bcredentials\b/i;

function stringField(input: unknown, keys: readonly string[]): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const obj = input as Record<string, unknown>;
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return null;
}

/**
 * Policy evaluator for native harness tool hooks (Antigravity PreToolUse,
 * Claude PermissionRequest). Returns `continue` only when the active
 * operator-owned continuation grant explicitly covers the tool call's risk
 * inside the granted project; every escalation returns `notify`.
 */
export function decideNativeToolSupervisor(
  input: {
    projectRoot: string;
    cwd?: string;
    toolName: string;
    toolInput: unknown;
  },
  policy: ContinuationPolicyFile = loadContinuationPolicy(),
): PermissionSupervisorVerdict {
  const grant = resolveContinuationGrant(policy, {
    herdrSession: "",
    paneId: "",
    cwd: input.projectRoot,
    foregroundCwd: input.cwd ?? input.projectRoot,
  });
  const notify = (reason: string, risk: ContinuationRisk = "unknown"): PermissionSupervisorVerdict => ({
    act: "notify",
    reason,
    risk,
    grant: grant.source,
  });
  if (input.cwd !== undefined && !withinProject(input.projectRoot, input.cwd)) {
    return notify("command leaves the granted project");
  }
  if (grant.level === "ask") return notify("no project continuation grant");

  const tool = input.toolName.trim().toLowerCase();
  if (tool === "run_command" || tool === "bash" || tool === "shell_exec") {
    const command = stringField(input.toolInput, ["CommandLine", "command"]);
    if (!command) return notify("command is missing");
    const risk = classifyPermissionCommandRisk(command, projectPathScope(input.projectRoot, policy, grant.source));
    if (!continuationAllowsRisk(grant.level, risk)) {
      return notify(`${grant.level} does not auto-continue ${risk}`, risk);
    }
    return { act: "continue", level: grant.level, reason: `${grant.level} continues ${risk}`, risk, grant: grant.source };
  }

  if (
    tool === "read_file"
    || tool === "view_file"
    || tool === "edit_file"
    || tool === "write_file"
    || tool === "edit"
    || tool === "write"
    || tool === "multiedit"
  ) {
    const rawPath = stringField(input.toolInput, ["Path", "file_path", "TargetFile"]);
    if (!rawPath) return notify("file path is missing");
    if (SECRET_PATH.test(rawPath)) return notify("path matches secret pattern", "secrets");
    const resolvedTarget = isAbsolute(rawPath) ? resolve(rawPath) : resolve(input.projectRoot, rawPath);
    if (!withinProject(input.projectRoot, resolvedTarget)) {
      return notify("file path leaves the granted project", "unknown");
    }
    if (!continuationAllowsRisk(grant.level, "workspace")) {
      return notify(`${grant.level} does not auto-continue workspace`, "workspace");
    }
    return { act: "continue", level: grant.level, reason: `${grant.level} continues workspace`, risk: "workspace", grant: grant.source };
  }

  return notify(`${input.toolName} requires operator approval`);
}

/** Answers whether an absolute path lies inside the project under the same grant that covers the request. */
type ProjectPathScope = (path: string) => string | null;

function projectPathScope(projectRoot: string, policy: ContinuationPolicyFile, grantSource: string): ProjectPathScope {
  return (path) => {
    if (path.split("/").includes("..") || !withinProject(projectRoot, path)) return null;
    // A path under a narrower (or different) grant keeps that grant's say.
    const own = resolveContinuationGrant(policy, { herdrSession: "", paneId: "", cwd: projectRoot, foregroundCwd: path });
    if (own.source !== grantSource) return null;
    return relative(resolve(projectRoot), resolve(path)) || ".";
  };
}

/**
 * Rewrites absolute paths that stay inside the granted project as project-relative
 * ones, then drops a leading directory option (`bun --cwd x`, `bun run --cwd x`,
 * `git -C x`) that only moves the command deeper into the project. Agents that
 * run from a parent folder address every worktree by absolute path; without this
 * every one of their commands reads as leaving the project. Anything that is not
 * plain words is returned unchanged, for the classifier to refuse.
 */
export function localizeProjectCommand(command: string, inProject: ProjectPathScope): string {
  if (UNPLAIN.test(command)) return command;
  const words = command.trim().split(/\s+/).map((word) => {
    const attached = /^(--?[A-Za-z][A-Za-z0-9-]*=)(\/.*)$/.exec(word);
    const prefix = attached?.[1] ?? "";
    const path = attached?.[2] ?? word;
    if (!path.startsWith("/")) return word;
    const local = inProject(path);
    return local === null ? word : `${prefix}${local}`;
  });
  if (!DIRECTORY_TOOLS.has(words[0] ?? "")) return words.join(" ");
  const at = words[0] !== "git" && words[1] === "run" ? 2 : 1;
  const option = words[at] ?? "";
  const [name, inline] = option.includes("=") ? [option.slice(0, option.indexOf("=")), option.slice(option.indexOf("=") + 1)] : [option, undefined];
  if (!DIRECTORY_OPTION.has(name) || (name === "-C") !== (words[0] === "git" || words[0] === "pnpm")) return words.join(" ");
  const target = inline ?? words[at + 1];
  if (!target || target.startsWith("/") || target.startsWith("~") || target.split("/").includes("..") || target.startsWith("-")) {
    return words.join(" ");
  }
  words.splice(at, inline === undefined ? 2 : 1);
  return words.join(" ");
}

function classifyPermissionCommandRisk(rawCommand: string | null, inProject?: ProjectPathScope): ContinuationRisk {
  const command = rawCommand && inProject ? localizeProjectCommand(rawCommand, inProject) : rawCommand;
  const risk = classifyContinuationRisk(command);
  if (!command) return risk;
  const words = command.trim().split(/\s+/);
  const pathText = words.filter((word, index) => !HTTP_URL.test(word) || !remoteHttpOperand(words, index)).join(" ");
  if (FILE_URL.test(pathText) || OUTSIDE_PROJECT_PATH.test(pathText)
    || words.some(word => ATTACHED_ABSOLUTE_PATH.test(word))) return "unknown";
  if (risk !== "workspace") return risk;
  if (/^(?:bun|npm|pnpm|yarn)$/.test(words[0] ?? "") && words[1] === "run" && !LOCAL_SCRIPT.test(words[2] ?? "")) {
    return "unknown";
  }
  return risk;
}

function remoteHttpOperand(words: string[], index: number): boolean {
  const executable = words[0]?.toLowerCase();
  if (executable === "curl") {
    if (index !== words.length - 1) return false;
    const previous = words[index - 1] ?? "";
    return previous === "--url" || !previous.startsWith("-");
  }
  if (executable === "git" && words[1]?.toLowerCase() === "push") {
    return index === 2 || (words[2] === "--" && index === 3);
  }
  return false;
}

function withinProject(projectRoot: string, cwd: string): boolean {
  if (!cwd || !isAbsolute(cwd) || !isAbsolute(projectRoot)) return false;
  const root = resolve(projectRoot);
  const target = resolve(cwd);
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function codexCommand(text: string): { command: string; cwd?: string } | { invalid: true } | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const request = value as Record<string, unknown>;
  if (request.method !== "item/commandExecution/requestApproval") return undefined;
  if (typeof request.command !== "string" || !request.command.trim() || request.command.length > 500) return { invalid: true };
  if (request.cwd !== undefined && typeof request.cwd !== "string") return { invalid: true };
  return { command: request.command, ...(typeof request.cwd === "string" ? { cwd: request.cwd } : {}) };
}
