import { basename } from "node:path";

import type { PermissionAnswerKind, PermissionCard, QuestionRecord } from "@openscout/protocol";

/**
 * A permission request as a `permission` card, built only from the request's
 * own payload: the native display, the prompt text, the decisions the runtime
 * can deliver and the rules an "always" would save. Nothing here is guessed.
 * A reason appears only when the request carries the session's own words.
 */

type NativeDisplay = {
  action?: string;
  command?: string;
  target?: string;
  note?: string;
  questions?: Array<{ header?: string; question: string; options?: Array<{ label: string }> }>;
  fields?: Array<{ key: string; value: string }>;
};

type PermissionRequestMetadata = {
  projectRoot?: string;
  decisions?: string[];
  decisionLabels?: Record<string, string>;
  native?: {
    harness?: string;
    tool?: string;
    display?: NativeDisplay;
    context?: { text?: string; source?: string } | null;
    alwaysRules?: string[];
  };
};

/** Where the request runs, as a surface should name it. Never a raw id. */
export type PermissionCardWhere = { session?: string; harness?: string; host?: string };

const ANSWER_FOR_DECISION: Record<string, PermissionAnswerKind> = { once: "allow_once", project: "allow_always", deny: "deny" };
const DEFAULT_LABEL: Record<PermissionAnswerKind, string> = { allow_once: "Allow once", allow_always: "Allow always", deny: "Deny" };
export const PERMISSION_DECISION_FOR_ANSWER: Record<PermissionAnswerKind, "once" | "project" | "deny"> = { allow_once: "once", allow_always: "project", deny: "deny" };

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** `mcp__scout__ask` reads as "ask (scout)". */
function toolName(tool: string | undefined): string | undefined {
  if (!tool) return undefined;
  const mcp = /^mcp__(.+?)__(.+)$/u.exec(tool);
  return mcp ? `${mcp[2]} (${mcp[1]})` : tool;
}

function questionFor(summary: string): string {
  const line = summary.replace(/[.?!]+$/u, "");
  return clip(`${line}?`, 60);
}

/** For a native or Scout-managed permission request (`metadata.permissionRequest`). */
export function permissionCardFromRequest(record: QuestionRecord, where: PermissionCardWhere = {}): PermissionCard | undefined {
  const request = record.metadata?.permissionRequest as PermissionRequestMetadata | undefined;
  if (!request || typeof request !== "object") return undefined;
  const native = request.native;
  const display = native?.display;
  const tool = text(native?.tool);
  const summary = text(display?.action) ?? text(record.summary) ?? (tool ? `Use ${toolName(tool)}` : "Use a tool");
  const fields = [
    ...(display?.fields ?? []).filter((entry) => text(entry?.key) && text(entry?.value)),
    ...(display?.questions ?? []).map((entry) => ({
      key: text(entry.header) ?? "Question",
      value: [entry.question, ...(entry.options ?? []).map((option) => `· ${option.label}`)].join("\n"),
    })),
  ];
  const decisions = (Array.isArray(request.decisions) ? request.decisions : ["once", "deny"])
    .filter((decision): decision is keyof typeof ANSWER_FOR_DECISION => decision in ANSWER_FOR_DECISION);
  const rules = (native?.alwaysRules ?? []).filter((rule) => typeof rule === "string" && rule.trim());
  const answers = decisions.map((decision) => {
    const kind = ANSWER_FOR_DECISION[decision]!;
    return {
      kind,
      label: text(request.decisionLabels?.[decision]) ?? DEFAULT_LABEL[kind],
      ...(kind === "allow_always" && rules.length ? { grants: rules } : {}),
    };
  });
  const always = answers.some((answer) => answer.kind === "allow_always");
  const scope = always
    ? rules.length
      ? `Allow once covers this call only. Allow always also saves ${rules.length === 1 ? "the rule" : "the rules"} ${rules.join(", ")}, so the session stops asking for ${rules.length === 1 ? "it" : "them"}.`
      : "Allow once covers this call only. Allow always saves the session's own rule, so it stops asking for this."
    : "This call only. The session asks again next time.";
  // The session's own words only: a command's description, or what it said
  // just before the call. Never a reason made up here.
  const context = native?.context;
  const reason = text(display?.note) ?? (context?.source === "assistant" ? text(context.text) : undefined);
  const project = text(request.projectRoot);
  return {
    kind: "permission",
    version: 1,
    question: questionFor(summary),
    action: {
      summary,
      ...(tool ? { tool: toolName(tool) } : {}),
      ...(text(display?.command) ? { command: text(display?.command) } : {}),
      ...(text(display?.target) ? { target: text(display?.target) } : {}),
      ...(fields.length ? { fields } : {}),
    },
    where: {
      ...(project ? { project: basename(project) } : {}),
      ...(where.session ? { session: where.session } : {}),
      ...(text(native?.harness) ?? where.harness ? { harness: text(native?.harness) ?? where.harness } : {}),
      ...(where.host ? { host: where.host } : {}),
    },
    scope,
    ...(reason ? { reason: clip(reason, 600) } : {}),
    answers,
  };
}

/**
 * For an agent's `scout ask --operator --permission`: the ask names the action
 * in words. The runtime can only relay a yes or a no to that agent, so the card
 * offers allow once and deny.
 */
export function permissionCardFromAsk(input: { question: string; because?: string; project?: string } & PermissionCardWhere): PermissionCard {
  const summary = clip(input.question.trim(), 400);
  return {
    kind: "permission",
    version: 1,
    question: questionFor(clip(summary.split(/\n/u)[0]!, 59)),
    action: { summary },
    where: {
      ...(input.project ? { project: input.project } : {}),
      ...(input.session ? { session: input.session } : {}),
      ...(input.harness ? { harness: input.harness } : {}),
      ...(input.host ? { host: input.host } : {}),
    },
    scope: "This request only. The agent asks again for anything else.",
    ...(text(input.because) ? { reason: text(input.because) } : {}),
    answers: [{ kind: "allow_once", label: "Allow" }, { kind: "deny", label: "Deny" }],
  };
}
