import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ManagedPermissionPrompt } from "./managed-permission.js";
import {
  classifyContinuationRisk,
  continuationAllowsRisk,
  decideContinuation,
  type ContinuationRisk,
} from "./continuation/decide.js";
import { parseContinuationDialog } from "./continuation/dialog.js";
import {
  loadContinuationPolicy,
  resolveContinuationGrant,
  type ContinuationPolicyFile,
} from "./continuation/grants.js";

export const PERMISSION_SUPERVISOR_ACTOR_ID = "permission-supervisor";

export type PermissionSupervisorVerdict = {
  act: "continue" | "notify";
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

  if (codex) {
    const risk = classifyPermissionCommandRisk(codex.command);
    if (!continuationAllowsRisk(grant.level, risk)) {
      return notify(`${grant.level} does not auto-continue ${risk}`, risk);
    }
    return { act: "continue", reason: `${grant.level} continues ${risk}`, risk, grant: grant.source };
  }

  const dialog = parseContinuationDialog(prompt.text);
  const verdict = decideContinuation({ paneBody: prompt.text, policy: grant.level });
  if (verdict.act !== "continue") return notify(verdict.reason, verdict.risk);
  const risk = dialog.commandExact && dialog.action !== "edit" && dialog.action !== "write"
    ? classifyPermissionCommandRisk(dialog.command)
    : verdict.risk;
  if (!continuationAllowsRisk(grant.level, risk)) return notify(`${grant.level} does not auto-continue ${risk}`, risk);
  return { act: "continue", reason: `${grant.level} continues ${risk}`, risk, grant: grant.source };
}

const LOCAL_SCRIPT = /^(?:test|lint|typecheck|check|build)(?::[\w.-]+)*$/;
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
    const risk = classifyPermissionCommandRisk(command);
    if (!continuationAllowsRisk(grant.level, risk)) {
      return notify(`${grant.level} does not auto-continue ${risk}`, risk);
    }
    return { act: "continue", reason: `${grant.level} continues ${risk}`, risk, grant: grant.source };
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
    return { act: "continue", reason: `${grant.level} continues workspace`, risk: "workspace", grant: grant.source };
  }

  return notify(`${input.toolName} requires operator approval`);
}

function classifyPermissionCommandRisk(command: string | null): ContinuationRisk {
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
