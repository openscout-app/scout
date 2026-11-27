import type { ContinuationDialog, ContinuationDialogOption } from "./dialog.js";
import { parseContinuationDialog } from "./dialog.js";
import {
  DEFAULT_CONTINUATION_LEVEL,
  type ContinuationLevel,
} from "./policy.js";

export type ContinuationRisk =
  | "workspace"
  | "network"
  | "publish"
  | "destructive"
  | "secrets"
  | "identity"
  | "unknown";

export type ContinuationAct = "continue" | "deny" | "notify";

export type ContinuationVerdict = {
  kind: ContinuationDialog["kind"];
  live: boolean;
  policy: ContinuationLevel;
  risk: ContinuationRisk;
  act: ContinuationAct;
  /** Keys to send for `continue`. Never "don't ask again". */
  keys: string[] | null;
  command: string | null;
  reason: string;
  source: "rules" | "model";
};

const DESTRUCTIVE = /\brm\s+-[a-z]*r|\bgit\s+reset\s+--hard\b|\bgit\s+push\b[^\n]*--force|\bdrop\s+(table|database)\b|\bsudo\b|\bmkfs\b|\bdd\s+if=/i;
const SECRETS = /\.env\b|\bid_rsa\b|\.npmrc\b|\baws_secret|\bauthorization:\s*bearer\b|\bcredentials\b/i;
/** Publish, network and identity are judged by the executable, never by text elsewhere. */
const PUBLISH = /^(?:git\s+push|gh\s+pr\s+create|npm\s+publish|bun\s+publish)(?:\s|$)/i;
const NETWORK = /^(?:curl|wget)(?:\s|$)/i;
const IDENTITY = /^(?:ssh|chmod|chown)(?:\s|$)/i;
/**
 * Chaining, redirection, substitution, expansion, quoting, comments, or a
 * second line, globs or brace expansion: effects the rules cannot read. Quoting is refused outright so
 * a quoted absolute path cannot slip past the path check.
 */
const SHELL_META = /[;&|<>`\n\\$"'#*?{}[\]!]/;
/** An argument that points outside the pane's directory. */
const OUTSIDE_PATH = /(?:^|\s|=|@)(?:~|\/)|\.\./;
/**
 * The only commands `workspace` may continue: local tests, builds, checks,
 * and reads. Everything else is `unknown`, which no level continues.
 */
const WORKSPACE_COMMAND = new RegExp([
  "^(?:bun|npm|pnpm|yarn)\\s+(?:test|run\\s+[\\w:.-]+|lint|typecheck|check|build)(?:\\s|$)",
  "^(?:bunx|npx)\\s+tsc(?:\\s|$)",
  // A project's own framework build, run from its node_modules; bun never fetches a missing bin.
  "^bun\\s+(?:next|vite)\\s+build(?:\\s|$)",
  "^(?:cargo|go|swift)\\s+(?:test|build|check|vet)(?:\\s|$)",
  "^(?:pytest|tsc|make)(?:\\s|$)",
  "^(?:ls|pwd|cat|head|tail|wc|grep|rg)(?:\\s|$)",
  "^git\\s+(?:status|diff|log|show)(?:\\s|$)",
].join("|"));

export function classifyContinuationRisk(command: string | null | undefined): ContinuationRisk {
  const value = command?.trim();
  if (!value) return "unknown";
  if (DESTRUCTIVE.test(value)) return "destructive";
  if (SECRETS.test(value)) return "secrets";
  if (SHELL_META.test(value)) return "unknown";
  if (PUBLISH.test(value)) return "publish";
  if (OUTSIDE_PATH.test(value.replace(/\bhttps?:\/\/\S+/giu, ""))) return "unknown";
  if (NETWORK.test(value)) return "network";
  if (IDENTITY.test(value)) return "identity";
  if (/^gh(?:\s|$)/.test(value)) return classifyGh(value.split(/\s+/));
  if (WORKSPACE_COMMAND.test(value)) return "workspace";
  return "unknown";
}

/**
 * `gh` subcommands that read, or change a pull request in ways the operator can
 * undo (a comment, an edit, ready for review). `workspace` continues these.
 */
const GH_WORKSPACE: Readonly<Record<string, readonly string[]>> = {
  pr: ["list", "view", "diff", "checks", "status", "comment", "edit", "ready"],
  run: ["list", "view"],
  issue: ["list", "view"],
};
/** `gh api` options that keep the request a plain GET. Any other option escalates. */
const GH_API_GET_OPTIONS = new Set(["--paginate", "--slurp", "-i", "--include", "--silent", "--verbose"]);
const GH_API_GET_VALUE_OPTIONS = new Set(["--jq", "-q", "--template", "-t", "--cache", "--hostname"]);

/**
 * `gh pr create` is `publish` (matched above). Merging or closing a pull
 * request, hosted CI triggers (`gh workflow run`, `gh run rerun`), any
 * `gh api` call other than a GET, and every subcommand not listed stay
 * `unknown`, which no level continues.
 */
function classifyGh(words: readonly string[]): ContinuationRisk {
  const [, group = "", action = ""] = words;
  if (GH_WORKSPACE[group]?.includes(action)) return "workspace";
  if (group !== "api") return "unknown";
  let endpoint: string | null = null;
  for (let index = 2; index < words.length; index++) {
    const word = words[index] ?? "";
    const [name, inline] = word.startsWith("--") && word.includes("=")
      ? [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)]
      : [word, undefined];
    if (name === "-X" || name === "--method") {
      const method = inline ?? words[++index];
      if (method?.toUpperCase() !== "GET") return "unknown";
      continue;
    }
    if (GH_API_GET_OPTIONS.has(name) && inline === undefined) continue;
    if (GH_API_GET_VALUE_OPTIONS.has(name)) {
      if (inline === undefined) index++;
      continue;
    }
    if (word.startsWith("-") || endpoint !== null) return "unknown";
    endpoint = word;
  }
  // GraphQL is always a POST and may carry a mutation.
  if (!endpoint || endpoint === "graphql") return "unknown";
  return "workspace";
}

/** An Edit/Write target is workspace only as a plain relative path. */
export function classifyContinuationPathRisk(path: string | null | undefined): ContinuationRisk {
  const value = path?.trim();
  if (!value) return "unknown";
  if (SECRETS.test(value)) return "secrets";
  if (SHELL_META.test(value) || /\s/.test(value) || OUTSIDE_PATH.test(value)) return "unknown";
  return "workspace";
}

export function decideContinuation(input: {
  paneBody: string;
  policy?: ContinuationLevel | null;
}): ContinuationVerdict {
  const policy = input.policy ?? DEFAULT_CONTINUATION_LEVEL;
  const dialog = parseContinuationDialog(input.paneBody);
  // An inexact command (no header, several lines, clamped) is never cleared.
  const risk: ContinuationRisk = !dialog.commandExact
    ? "unknown"
    : dialog.action === "edit" || dialog.action === "write"
      ? classifyContinuationPathRisk(dialog.command)
      : classifyContinuationRisk(dialog.command);
  const base = {
    kind: dialog.kind,
    live: dialog.live,
    policy,
    risk,
    command: dialog.command,
    source: "rules" as const,
  };

  if (!dialog.live) {
    return { ...base, act: "notify", keys: null, reason: "no live dialog" };
  }
  if (dialog.kind === "unknown" || dialog.options.length === 0) {
    return { ...base, act: "notify", keys: null, reason: "unparsed dialog" };
  }
  if (dialog.kind === "question" || dialog.kind === "plan" || dialog.kind === "hold") {
    return {
      ...base,
      act: "notify",
      keys: null,
      reason: dialog.kind === "hold" ? "classifier hold" : `${dialog.kind} needs a human`,
    };
  }

  const allow = dialog.options.find((option) => option.kind === "allow") ?? null;
  if (!allow) {
    return { ...base, act: "notify", keys: null, reason: "unparsed dialog" };
  }

  if (policy === "ask") {
    return { ...base, act: "notify", keys: null, reason: "ask level notifies every stop" };
  }

  const continueable = riskAllowed(policy, risk);
  if (!continueable) {
    return {
      ...base,
      act: "notify",
      keys: null,
      reason: `${policy} does not auto-continue ${risk}`,
    };
  }

  return {
    ...base,
    act: "continue",
    keys: keysFor(allow, dialog.options),
    reason: `${policy} continues ${risk}`,
  };
}

export function continuationAllowsRisk(policy: ContinuationLevel, risk: ContinuationRisk): boolean {
  return riskAllowed(policy, risk);
}

function riskAllowed(policy: ContinuationLevel, risk: ContinuationRisk): boolean {
  if (risk === "unknown") return false;
  if (policy === "workspace") return risk === "workspace";
  if (policy === "unattended") {
    return risk === "workspace" || risk === "network";
  }
  if (policy === "silent") {
    return risk === "workspace" || risk === "network" || risk === "publish";
  }
  return false;
}

function keysFor(option: ContinuationDialogOption, options: readonly ContinuationDialogOption[]): string[] {
  // Enter only when the cursor sits, unambiguously, on this option.
  const selected = options.filter((candidate) => candidate.selected);
  return option.selected && selected.length === 1 ? ["enter"] : [String(option.index)];
}

/** True when two reads still describe the same live decision. */
export function sameContinuationDecision(
  left: ContinuationVerdict,
  right: ContinuationVerdict,
): boolean {
  return left.live
    && right.live
    && left.act === right.act
    && left.kind === right.kind
    && left.command === right.command
    && left.policy === right.policy
    && left.risk === right.risk
    && (left.keys ?? []).join(",") === (right.keys ?? []).join(",");
}
