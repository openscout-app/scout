import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ManagedPermissionPrompt } from "./managed-permission.js";
import {
  classifyContinuationRisk,
  continuationAllowsRisk,
  decideContinuation,
  type ContinuationRisk,
} from "./continuation/decide.js";
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
  prompt: Pick<ManagedPermissionPrompt, "projectRoot" | "text" | "decisions">,
  policy: ContinuationPolicyFile = loadContinuationPolicy(),
): PermissionSupervisorVerdict {
  const grant = resolveContinuationGrant(policy, {
    herdrSession: "",
    paneId: "",
    cwd: prompt.projectRoot,
  });
  const notify = (reason: string, risk: ContinuationRisk = "unknown"): PermissionSupervisorVerdict => ({
    act: "notify", reason, risk, grant: grant.source,
  });
  if (grant.level === "ask") return notify("no project continuation grant");
  if (!prompt.decisions.includes("once")) return notify("one-time approval is not offered");

  const codex = codexCommand(prompt.text);
  if (codex) {
    if ("invalid" in codex) return notify("unparsed Codex command");
    if (!withinProject(prompt.projectRoot, codex.cwd)) return notify("command leaves the granted project");
    const risk = classifyContinuationRisk(codex.command);
    if (!continuationAllowsRisk(grant.level, risk)) {
      return notify(`${grant.level} does not auto-continue ${risk}`, risk);
    }
    return { act: "continue", reason: `${grant.level} continues ${risk}`, risk, grant: grant.source };
  }

  const verdict = decideContinuation({ paneBody: prompt.text, policy: grant.level });
  if (verdict.act !== "continue") return notify(verdict.reason, verdict.risk);
  return { act: "continue", reason: verdict.reason, risk: verdict.risk, grant: grant.source };
}

function withinProject(projectRoot: string, cwd: string | undefined): boolean {
  if (cwd !== undefined && (!cwd || !isAbsolute(cwd))) return false;
  const root = resolve(projectRoot);
  const target = resolve(cwd ?? root);
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
