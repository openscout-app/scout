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
  continuationPermissionScopes,
  continuationPolicyPath,
  loadContinuationPolicy,
  resolveContinuationGrant,
  type ContinuationPolicyFile,
} from "./continuation/grants.js";
import {
  matchPermissionRules,
  permissionToolName,
  type PermissionCall,
  type PermissionList,
  type PermissionMode,
  parsePermissionRule,
} from "./continuation/rules.js";
import { absolutePath, agentConfigTarget, autoProjectRoot, readFiles, scoutPolicyTarget, secretTarget, shellSegments, writtenFiles } from "./continuation/shell.js";

export const PERMISSION_SUPERVISOR_ACTOR_ID = "permission-supervisor";

export type PermissionSupervisorVerdict = {
  /** `deny` comes only from a deny rule. */
  act: "continue" | "notify" | "deny";
  /** The grant level that let a `continue` through. */
  level?: ContinuationLevel;
  reason: string;
  risk: ContinuationRisk;
  grant: string;
  /** The rule that decided, exactly as written, or `mode:auto` / `mode:default`. */
  rule?: string;
  /** The list the rule sits in, or `mode` when no rule covered the call. */
  list?: PermissionList | "mode";
  /** Where the rule is defined: `policy` or `project:<path>`. */
  ruleScope?: string;
  /** The built-in deny rules an operator allow lifted for this call. */
  overrides?: string[];
};

type Grant = ReturnType<typeof resolveContinuationGrant>;

/**
 * Deny, then ask, then allow, then the mode. `judge` is the mode's own
 * judgement (today's risk classes) and runs only when no deny or ask rule
 * covers the call and no explicit allow rule does.
 */
/** `allow Bash(rm -rf ./dist:*) (overrides default deny Bash(rm -rf:*))`, as the record shows it. */
export function permissionRuleLabel(match: { list: string; rule: string; overrides?: string[] }): string {
  const label = `${match.list} ${match.rule}`;
  return match.overrides?.length ? `${label} (overrides default deny ${match.overrides.join(", ")})` : label;
}

function withRules(
  policy: ContinuationPolicyFile,
  resolved: Grant,
  call: Omit<PermissionCall, "root"> | null,
  root: string,
  offered: { once: boolean; deny: boolean },
  judge: (grant: Grant) => PermissionSupervisorVerdict,
): PermissionSupervisorVerdict {
  // Only an explicit `defaultMode: "auto"` judges calls outside every grant,
  // and never with `/`, the home folder or a folder above it as the project.
  const outside = resolved.level === "ask" && resolved.source === "default" && policy.defaultMode === "auto" && autoProjectRoot(root);
  const grant: Grant = outside ? { ...resolved, level: "workspace" } : resolved;
  const mode: PermissionMode = grant.level === "ask" ? "default" : "auto";
  const match = call ? matchPermissionRules(continuationPermissionScopes(policy, resolved.source, mode), { ...call, root }) : null;
  const named = match
    ? { rule: match.rule, list: match.list, ruleScope: match.scope, ...(match.overrides ? { overrides: match.overrides } : {}) }
    : null;
  const risk: ContinuationRisk = call?.tool === "Bash" ? classifyContinuationRisk(call.command) : "unknown";
  if (match?.list === "deny") {
    return offered.deny
      ? { act: "deny", reason: `deny rule ${match.rule}`, risk, grant: grant.source, ...named }
      : { act: "notify", reason: `deny rule ${match.rule}; the harness offers no deny`, risk, grant: grant.source, ...named };
  }
  if (match?.list === "ask") {
    return { act: "notify", reason: `ask rule ${match.rule}`, risk, grant: grant.source, ...named };
  }
  let verdict: PermissionSupervisorVerdict;
  if (match?.list === "allow" && !match.builtin) {
    verdict = offered.once
      ? { act: "continue", level: grant.level, reason: permissionRuleLabel(match), risk, grant: grant.source, ...named }
      : { act: "notify", reason: "one-time approval is not offered", risk, grant: grant.source, ...named };
  } else {
    const judged = judge(grant);
    // A built-in allow rule names what auto passed; it never passes anything itself.
    verdict = judged.act === "continue" && match?.builtin ? { ...judged, ...named! } : { ...judged, rule: `mode:${mode}`, list: "mode" };
  }
  if (verdict.act !== "continue" || !call) return verdict;
  // Whatever passed it, a call that touches a secret or agent config continues
  // only under an operator rule that names that exact path or command, and a
  // write to Scout's own policy file never continues on its own.
  const guard = guardedCall(call, root);
  if (!guard) return verdict;
  const exact = match && !match.builtin && match.list === "allow" && namesExactly(match.rule, call, root);
  if (guard.kind !== "policy" && exact) return verdict;
  const { level: _level, ...held } = verdict;
  return { ...held, act: "notify", reason: guard.reason, risk: guard.kind === "secret" ? "secrets" : verdict.risk };
}

type Guard = { kind: "policy" | "config" | "secret"; reason: string };

/** The protected thing a call touches: Scout's policy file, agent config, or a secret. */
export function guardedCall(call: Omit<PermissionCall, "root">, root: string): Guard | null {
  const policyPath = continuationPolicyPath();
  const writes: string[] = [];
  const reads: string[] = [];
  if ((call.tool === "Edit" || call.tool === "Write") && call.path) writes.push(absolutePath(call.path, root));
  if (call.tool === "Read" && call.path) reads.push(absolutePath(call.path, root));
  if (call.tool === "Bash" && call.command) {
    for (const segment of shellSegments(call.command)) {
      writes.push(...writtenFiles(segment, root));
      reads.push(...readFiles(segment).map((file) => absolutePath(file, root)));
      // Any command can carry a secret as an operand (`git add ~/.ssh/id_ed25519`,
      // `scp ~/.aws/credentials host:`), so every plain word and `--flag=value` is checked.
      for (const word of [...segment.words.slice(1), ...segment.redirects]) {
        const value = word.startsWith("-") ? (word.includes("=") ? word.slice(word.indexOf("=") + 1) : "") : word;
        if (value && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) reads.push(absolutePath(value, root));
      }
    }
    if (SECRET_PATH.test(call.command) && !reads.some((file) => secretTarget(file, root))) reads.push(call.command);
  }
  for (const file of writes) {
    if (scoutPolicyTarget(file, policyPath)) return { kind: "policy", reason: "writes Scout's permission rules" };
  }
  for (const file of writes) {
    const target = agentConfigTarget(file, root, policyPath);
    if (target) return { kind: "config", reason: `writes agent config (${target})` };
  }
  for (const file of [...reads, ...writes]) {
    const secret = file === call.command ? "a secret path" : secretTarget(file, root);
    if (secret) return { kind: "secret", reason: `touches a secret (${secret})` };
  }
  return null;
}

/** An allow rule with no wildcard that names this very path or command. */
function namesExactly(rule: string, call: Omit<PermissionCall, "root">, root: string): boolean {
  const parsed = parsePermissionRule(rule);
  if (!parsed || parsed.pattern === null || /[*?]/.test(parsed.pattern)) return false;
  if (parsed.tool === "Bash") return call.tool === "Bash" && call.command?.trim().replace(/\s+/g, " ") === parsed.pattern.replace(/\s+/g, " ");
  if (!call.path || (parsed.tool !== call.tool && !(parsed.tool === "Edit" && call.tool === "Write"))) return false;
  const pattern = parsed.pattern;
  const target = pattern.startsWith("//") ? pattern.slice(1) : pattern.startsWith("~/") ? absolutePath(pattern, root)
    : resolve(root, pattern.replace(/^\//, ""));
  return resolve(target) === absolutePath(call.path, root);
}

function dialogCall(dialog: ReturnType<typeof parseContinuationDialog>): Omit<PermissionCall, "root"> | null {
  if (!dialog.commandExact || !dialog.command) return null;
  if (dialog.action === "edit") return { tool: "Edit", path: dialog.command };
  if (dialog.action === "write") return { tool: "Write", path: dialog.command };
  return { tool: "Bash", command: dialog.command };
}

export function decidePermissionSupervisor(
  prompt: Pick<ManagedPermissionPrompt, "projectRoot" | "cwd" | "text" | "decisions">,
  policy: ContinuationPolicyFile = loadContinuationPolicy(),
): PermissionSupervisorVerdict {
  const codex = codexCommand(prompt.text);
  const commandCwd = codex && !("invalid" in codex) ? codex.cwd : prompt.cwd;
  const resolved = resolveContinuationGrant(policy, {
    herdrSession: "",
    paneId: "",
    cwd: prompt.projectRoot,
    foregroundCwd: commandCwd,
  });
  const dialog = codex ? null : parseContinuationDialog(prompt.text);
  const call = codex
    ? ("invalid" in codex ? null : { tool: "Bash", command: codex.command })
    : dialogCall(dialog!);
  const offered = { once: prompt.decisions.includes("once"), deny: prompt.decisions.includes("deny") };
  return withRules(policy, resolved, call, commandCwd ?? prompt.projectRoot, offered, (grant) => {
    const notify = (reason: string, risk: ContinuationRisk = "unknown"): PermissionSupervisorVerdict => ({
      act: "notify", reason, risk, grant: grant.source,
    });
    if (codex && "invalid" in codex) return notify("unparsed Codex command");
    if (codex && !codex.cwd) return notify("command has no working directory");
    if (commandCwd !== undefined && !withinProject(prompt.projectRoot, commandCwd)) {
      return notify("command leaves the granted project");
    }
    if (grant.level === "ask") return notify("no project continuation grant");
    if (!offered.once) return notify("one-time approval is not offered");

    const inProject = projectPathScope(prompt.projectRoot, policy, grant.source);
    if (codex) {
      const risk = classifyPermissionCommandRisk(codex.command, inProject);
      if (!continuationAllowsRisk(grant.level, risk)) {
        return notify(`${grant.level} does not auto-continue ${risk}`, risk);
      }
      return { act: "continue", level: grant.level, reason: `${grant.level} continues ${risk}`, risk, grant: grant.source };
    }

    const verdict = decideContinuation({ paneBody: prompt.text, policy: grant.level });
    const localizedOnly = verdict.act === "notify" && verdict.risk === "unknown" && dialog!.commandExact
      && dialog!.action !== "edit" && dialog!.action !== "write" && verdict.reason === `${grant.level} does not auto-continue unknown`;
    if (verdict.act !== "continue" && !localizedOnly) return notify(verdict.reason, verdict.risk);
    const risk = dialog!.commandExact && dialog!.action !== "edit" && dialog!.action !== "write"
      ? classifyPermissionCommandRisk(dialog!.command, inProject)
      : verdict.risk;
    if (!continuationAllowsRisk(grant.level, risk)) return notify(`${grant.level} does not auto-continue ${risk}`, risk);
    return { act: "continue", level: grant.level, reason: `${grant.level} continues ${risk}`, risk, grant: grant.source };
  });
}

/** The command or path a managed prompt asks about, for the record: Codex's command, or the dialog's exact one. */
export function permissionPromptCommand(text: string): string | null {
  const codex = codexCommand(text);
  if (codex) return "invalid" in codex ? null : codex.command;
  const dialog = parseContinuationDialog(text);
  return dialog.command ?? null;
}

/** The rule tool a managed prompt is for: Bash, Edit or Write, or none when the dialog names no tool. */
export function permissionPromptTool(text: string): string | undefined {
  if (codexCommand(text)) return "Bash";
  const action = parseContinuationDialog(text).action;
  return action === "bash" ? "Bash" : action === "edit" ? "Edit" : action === "write" ? "Write" : undefined;
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
const SECRET_PATH = /\.env\b|\bid_(?:rsa|ed25519|ecdsa|dsa)\b|\.npmrc\b|\baws_secret|\bcredentials\b|(?:^|[\s/'"=])\.(?:ssh|aws|gnupg|kube|azure)(?:\/|\b)/i;

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
  const resolved = resolveContinuationGrant(policy, {
    herdrSession: "",
    paneId: "",
    cwd: input.projectRoot,
    foregroundCwd: input.cwd ?? input.projectRoot,
  });
  const tool = input.toolName.trim().toLowerCase();
  const ruleTool = permissionToolName(input.toolName);
  const call: Omit<PermissionCall, "root"> = ruleTool === "Bash"
    ? { tool: ruleTool, command: stringField(input.toolInput, ["CommandLine", "command"]) }
    : ruleTool === "Read" || ruleTool === "Edit" || ruleTool === "Write"
      ? { tool: ruleTool, path: stringField(input.toolInput, ["Path", "file_path", "TargetFile", "path"]) }
      : ruleTool === "WebFetch"
        ? { tool: ruleTool, url: stringField(input.toolInput, ["url", "Url"]) }
        : { tool: ruleTool };
  return withRules(policy, resolved, call, input.cwd ?? input.projectRoot, { once: true, deny: true }, (grant) => {
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

    if (tool === "run_command" || tool === "bash" || tool === "shell_exec") {
      const command = call.command;
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
  });
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
