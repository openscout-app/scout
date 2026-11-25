/**
 * The question or tool call an Antigravity session is waiting on.
 *
 * Antigravity writes a `PLANNER_RESPONSE` step with `tool_calls` to
 * `transcript.jsonl` before executing tools, and writes `GENERIC` steps as
 * tool calls complete (or steps with `status: "WAITING"` when execution pauses
 * on the user). Arguments in `transcript.jsonl` may be JSON-encoded strings per
 * key, while hook payloads carry plain JSON values; both are normalized here.
 *
 * The transcript is observed source material. Nothing here answers the prompt.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

import { shapeAttentionContext, type AttentionContext } from "../../attention-context.js";
import { redactSecrets } from "../../secret-redaction.js";

export type AntigravityPendingQuestion = {
  header?: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
};

export type AntigravityPendingToolCall = {
  toolUseId: string;
  tool: string;
  title: string;
  subject: string | null;
  detail: string | null;
  subjectKind: "command" | "path" | "url" | "query" | "arguments" | null;
  at: number | null;
  alsoPending: number;
  questions?: AntigravityPendingQuestion[];
};

const SUBJECT_MAX = 2_000;
const DETAIL_MAX = 400;

function unwrapArg(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("[") && trimmed.endsWith("]"))
    || (trimmed.startsWith("{") && trimmed.endsWith("}"))
    || trimmed === "true"
    || trimmed === "false"
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

export function unwrapAntigravityToolArgs(rawInput: unknown): Record<string, unknown> {
  const unwrapped = unwrapArg(rawInput);
  if (!unwrapped || typeof unwrapped !== "object" || Array.isArray(unwrapped)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(unwrapped as Record<string, unknown>)) {
    out[key] = unwrapArg(value);
  }
  return out;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bool(value: unknown): boolean {
  return value === true || value === "true";
}

function bounded(value: string | null, max: number): string | null {
  if (!value) return null;
  const clean = redactSecrets(value);
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function compactArguments(input: Record<string, unknown>): string | null {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!entries.length) return null;
  return entries.map(([key, value]) => `${key}: ${JSON.stringify(value) ?? String(value)}`).join(", ");
}

export function parseAntigravityQuestions(rawQuestions: unknown): AntigravityPendingQuestion[] {
  const unwrapped = unwrapArg(rawQuestions);
  if (!Array.isArray(unwrapped)) return [];
  const questions: AntigravityPendingQuestion[] = [];
  for (const entry of unwrapped.slice(0, 4)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const question = text(unwrapArg(record.question));
    if (!question) continue;
    const header = text(unwrapArg(record.header));
    const rawOptions = unwrapArg(record.options);
    const options = (Array.isArray(rawOptions) ? rawOptions : [])
      .slice(0, 8)
      .flatMap((opt): Array<{ label: string; description?: string }> => {
        const cleanOpt = unwrapArg(opt);
        if (typeof cleanOpt === "string" && cleanOpt.trim()) {
          return [{ label: bounded(cleanOpt.trim(), 120)! }];
        }
        if (cleanOpt && typeof cleanOpt === "object" && !Array.isArray(cleanOpt)) {
          const obj = cleanOpt as Record<string, unknown>;
          const label = text(unwrapArg(obj.label));
          const description = text(unwrapArg(obj.description));
          if (label) {
            return [{
              label: bounded(label, 120)!,
              ...(description ? { description: bounded(description, 240)! } : {}),
            }];
          }
        }
        return [];
      });
    questions.push({
      ...(header ? { header: bounded(header, 60)! } : {}),
      question: bounded(question, 500)!,
      options,
    });
  }
  return questions;
}

function intArg(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function describeAntigravityToolCall(
  tool: string,
  rawInput: unknown,
): Pick<AntigravityPendingToolCall, "title" | "subject" | "detail" | "subjectKind" | "questions"> {
  const input = unwrapAntigravityToolArgs(rawInput);
  const normalized = tool.trim().toLowerCase();
  const path = text(input.Path) ?? text(input.TargetFile) ?? text(input.file_path) ?? text(input.path) ?? text(input.Uri);

  switch (normalized) {
    case "ask_question": {
      const questions = parseAntigravityQuestions(input.questions);
      const first = questions[0];
      const optionLabels = first?.options.map((option) => option.label).filter(Boolean) ?? [];
      return {
        title: "Question",
        subject: bounded(first?.question ?? text(input.question), SUBJECT_MAX),
        detail: optionLabels.length ? bounded(optionLabels.join(" · "), DETAIL_MAX) : null,
        subjectKind: null,
        ...(questions.length ? { questions } : {}),
      };
    }
    case "run_command":
    case "shell_exec": {
      const command = text(input.CommandLine) ?? text(input.command);
      const summary = text(input.toolSummary) ?? text(input.description);
      const bypass = bool(input.BypassSandbox);
      return {
        title: bypass ? "Unsandboxed command" : "Run command",
        subject: bounded(command, SUBJECT_MAX),
        detail: bounded(summary, DETAIL_MAX),
        subjectKind: "command",
      };
    }
    case "write_file":
    case "edit_file":
    case "file_change":
    case "code_action": {
      const metadata = unwrapAntigravityToolArgs(input.ArtifactMetadata);
      if (bool(metadata.RequestFeedback)) {
        return {
          title: "Plan approval",
          subject: bounded(path, SUBJECT_MAX),
          detail: bounded(text(metadata.Summary), DETAIL_MAX),
          subjectKind: path ? "path" : null,
        };
      }
      return {
        title: normalized === "write_file" ? "Write file" : "Edit file",
        subject: bounded(path, SUBJECT_MAX),
        detail: null,
        subjectKind: "path",
      };
    }
    case "read_file":
    case "view_file":
    case "read_resource":
    case "list_resources": {
      const startLine = intArg(input.StartLine);
      const endLine = intArg(input.EndLine);
      const range = startLine && endLine ? `:${startLine}-${endLine}` : startLine ? `:${startLine}` : "";
      return {
        title: normalized === "list_resources" ? "List resources" : "Read file",
        subject: bounded(path ? `${path}${range}` : text(input.ServerName), SUBJECT_MAX),
        detail: null,
        subjectKind: path ? "path" : null,
      };
    }
    case "search_web":
      return { title: "Web search", subject: bounded(text(input.query), SUBJECT_MAX), detail: bounded(text(input.domain), DETAIL_MAX), subjectKind: "query" };
    case "read_url_content":
    case "open_browser_url":
      return { title: "Open URL", subject: bounded(text(input.Url) ?? text(input.url), SUBJECT_MAX), detail: null, subjectKind: "url" };
    case "call_mcp_tool":
    case "mcp_tool": {
      const server = text(input.ServerName);
      const toolName = text(input.ToolName);
      const args = unwrapAntigravityToolArgs(input.Arguments);
      return {
        title: server && toolName ? `${server} - ${toolName} (MCP)` : toolName ?? "MCP tool",
        subject: bounded(compactArguments(Object.keys(args).length ? args : input), SUBJECT_MAX),
        detail: null,
        subjectKind: "arguments",
      };
    }
    case "invoke_subagent": {
      const role = text(input.Role) ?? text(input.TypeName);
      const prompt = text(input.Prompt);
      return {
        title: "Subagent",
        subject: bounded(role ?? prompt, SUBJECT_MAX),
        detail: role && prompt ? bounded(prompt, DETAIL_MAX) : null,
        subjectKind: "arguments",
      };
    }
    case "notify_user":
    case "plan_input":
      return {
        title: "Plan approval",
        subject: bounded(text(input.Message) ?? text(input.content) ?? path, SUBJECT_MAX),
        detail: null,
        subjectKind: null,
      };
    default:
      return {
        title: tool,
        subject: bounded(compactArguments(input), SUBJECT_MAX),
        detail: null,
        subjectKind: "arguments",
      };
  }
}

export function formatAntigravityWaitingFor(pending: AntigravityPendingToolCall): string {
  return pending.subject ? `${pending.title}: ${pending.subject}` : pending.title;
}

type TranscriptStep = {
  step_index?: unknown;
  source?: unknown;
  type?: unknown;
  status?: unknown;
  created_at?: unknown;
  content?: unknown;
  tool_calls?: unknown;
};

type PlannerCall = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  at: number | null;
};

function stepTimestamp(step: TranscriptStep): number | null {
  const parsed = typeof step.created_at === "string" ? Date.parse(step.created_at) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function isFeedbackArtifactCall(call: PlannerCall): boolean {
  if (call.tool !== "write_file" && call.tool !== "edit_file") return false;
  const metadata = unwrapAntigravityToolArgs(call.args.ArtifactMetadata);
  return bool(metadata.RequestFeedback);
}

const PASSIVE_APPROVAL_MIN_WAIT_MS = 1_500;

function isWithinAllowedRoots(targetPath: string, roots: string[]): boolean {
  const home = homedir();
  const expanded = targetPath.startsWith("~/") ? `${home}${targetPath.slice(1)}` : targetPath;
  const resolved = resolve(expanded);
  for (const root of roots) {
    const cleanRoot = resolve(root);
    if (resolved === cleanRoot || resolved.startsWith(`${cleanRoot}/`)) return true;
  }
  return false;
}

function isPassivePermissionGatedCall(call: PlannerCall, workspaceRoot?: string | null): boolean {
  const normalized = call.tool.trim().toLowerCase();
  if (normalized === "run_command" || normalized === "shell_exec") {
    return bool(call.args.BypassSandbox) && !bool(call.args.IsDaemon);
  }
  if (normalized === "write_file" || normalized === "edit_file" || normalized === "read_file" || normalized === "view_file") {
    const rawPath = text(call.args.Path) ?? text(call.args.TargetFile);
    if (!rawPath || !workspaceRoot?.trim()) return false;
    const home = homedir();
    const allowedRoots = [
      workspaceRoot.trim(),
      resolve(home, ".gemini", "antigravity-cli", "brain"),
      resolve(home, ".gemini", "antigravity", "brain"),
      resolve(home, ".gemini", "antigravity-ide", "brain"),
      "/tmp",
      "/private/tmp",
    ];
    return !isWithinAllowedRoots(rawPath, allowedRoots);
  }
  return false;
}

/**
 * Inspect the bounded tail of an Antigravity `transcript.jsonl` for an open
 * user question, plan feedback gate, unsandboxed/out-of-workspace approval
 * prompt, or step halted in `WAITING` status.
 */
export function findAntigravityPendingToolCall(
  jsonl: string,
  options: {
    hookTool?: { id?: string | null; name: string; args?: unknown; at?: number | null } | null;
    workspaceRoot?: string | null;
    sessionBusy?: boolean;
    now?: number;
  } = {},
): AntigravityPendingToolCall | null {
  let activeCalls: PlannerCall[] = [];
  let resolvedCount = 0;
  let waitingStep: PlannerCall | null = null;
  let pendingFeedbackPlan: PlannerCall | null = null;

  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    let step: TranscriptStep;
    try {
      step = JSON.parse(raw) as TranscriptStep;
    } catch {
      continue;
    }
    if (!step || typeof step !== "object") continue;
    const type = typeof step.type === "string" ? step.type : "";
    const status = typeof step.status === "string" ? step.status : "";
    const at = stepTimestamp(step);

    if (type === "USER_INPUT" || type === "SYSTEM_MESSAGE") {
      activeCalls = [];
      resolvedCount = 0;
      waitingStep = null;
      pendingFeedbackPlan = null;
      continue;
    }

    if (type === "ERROR_MESSAGE") {
      activeCalls = [];
      resolvedCount = 0;
      waitingStep = null;
      continue;
    }

    if ((status === "WAITING" || status === "CORTEX_STEP_STATUS_WAITING") && type && type !== "USER_INPUT") {
      const stepIndex = typeof step.step_index === "number" ? step.step_index : 0;
      waitingStep = {
        id: `step-${stepIndex}`,
        tool: type.toLowerCase(),
        args: typeof step.content === "string" ? { content: step.content } : {},
        at,
      };
      continue;
    }

    if (type === "PLANNER_RESPONSE") {
      waitingStep = null;
      const rawCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      const stepIndex = typeof step.step_index === "number" ? step.step_index : 0;
      activeCalls = rawCalls.flatMap((entry, index): PlannerCall[] => {
        if (!entry || typeof entry !== "object") return [];
        const record = entry as { id?: unknown; name?: unknown; args?: unknown };
        if (typeof record.name !== "string" || !record.name.trim()) return [];
        return [{
          id: typeof record.id === "string" && record.id ? record.id : `step-${stepIndex}-call-${index}`,
          tool: record.name.trim(),
          args: unwrapAntigravityToolArgs(record.args),
          at,
        }];
      });
      resolvedCount = 0;
      const feedbackCall = activeCalls.find(isFeedbackArtifactCall) ?? null;
      if (feedbackCall) {
        pendingFeedbackPlan = feedbackCall;
      } else if (activeCalls.length > 0) {
        pendingFeedbackPlan = null;
      }
      continue;
    }

    if (type === "GENERIC") {
      waitingStep = null;
      if (resolvedCount < activeCalls.length) {
        resolvedCount += 1;
      }
    }
  }

  if (waitingStep) {
    return {
      toolUseId: waitingStep.id,
      tool: waitingStep.tool,
      ...describeAntigravityToolCall(waitingStep.tool, waitingStep.args),
      at: waitingStep.at,
      alsoPending: 0,
    };
  }

  const remaining = activeCalls.slice(resolvedCount);
  if (options.hookTool) {
    const matched = remaining.find((call) => (
      (options.hookTool?.id && call.id === options.hookTool.id)
      || call.tool.toLowerCase() === options.hookTool?.name.toLowerCase()
    ));
    const toolName = matched?.tool ?? options.hookTool.name;
    const toolArgs = options.hookTool.args ?? matched?.args ?? {};
    return {
      toolUseId: options.hookTool.id ?? matched?.id ?? "hook-pending",
      tool: toolName,
      ...describeAntigravityToolCall(toolName, toolArgs),
      at: options.hookTool.at ?? matched?.at ?? null,
      alsoPending: Math.max(0, remaining.length - 1),
    };
  }

  const askCallIndex = remaining.findIndex((call) => {
    const lower = call.tool.toLowerCase();
    return lower === "ask_question" || lower === "notify_user" || lower === "plan_input";
  });
  if (askCallIndex >= 0) {
    const askCall = remaining[askCallIndex]!;
    return {
      toolUseId: askCall.id,
      tool: askCall.tool,
      ...describeAntigravityToolCall(askCall.tool, askCall.args),
      at: askCall.at,
      alsoPending: Math.max(0, remaining.length - askCallIndex - 1),
    };
  }

  if (options.sessionBusy === true) {
    const now = options.now ?? Date.now();
    const gatedIndex = remaining.findIndex((call) => (
      isPassivePermissionGatedCall(call, options.workspaceRoot)
      && (call.at === null || now - call.at >= PASSIVE_APPROVAL_MIN_WAIT_MS)
    ));
    if (gatedIndex >= 0) {
      const gatedCall = remaining[gatedIndex]!;
      return {
        toolUseId: gatedCall.id,
        tool: gatedCall.tool,
        ...describeAntigravityToolCall(gatedCall.tool, gatedCall.args),
        at: gatedCall.at,
        alsoPending: Math.max(0, remaining.length - gatedIndex - 1),
      };
    }
  }

  // An artifact written with RequestFeedback=true at the end of a turn waits on the user's Proceed action.
  if (pendingFeedbackPlan && activeCalls.length === 0) {
    return {
      toolUseId: pendingFeedbackPlan.id,
      tool: pendingFeedbackPlan.tool,
      ...describeAntigravityToolCall(pendingFeedbackPlan.tool, pendingFeedbackPlan.args),
      at: pendingFeedbackPlan.at,
      alsoPending: 0,
    };
  }

  return null;
}

/**
 * Extract the recent user prompt or assistant thought/message leading up to a
 * pending Antigravity tool call.
 */
export function findAntigravityPendingToolContext(jsonl: string, toolName: string): AttentionContext | null {
  let prompt: AttentionContext | null = null;
  let assistant: AttentionContext | null = null;
  const target = toolName.trim().toLowerCase();

  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    let step: TranscriptStep;
    try {
      step = JSON.parse(raw) as TranscriptStep;
    } catch {
      continue;
    }
    if (!step || typeof step !== "object") continue;
    const at = stepTimestamp(step);
    if (step.type === "USER_INPUT" && step.source === "USER_EXPLICIT" && typeof step.content === "string") {
      const requestMatch = /<USER_REQUEST>([\s\S]*?)(?:<\/USER_REQUEST>|<ADDITIONAL_METADATA>|$)/u.exec(step.content);
      const clean = (requestMatch?.[1] ?? step.content.split("<ADDITIONAL_METADATA>", 1)[0] ?? "").trim();
      if (clean) {
        prompt = shapeAttentionContext(clean, "prompt", at);
        assistant = null;
      }
      continue;
    }
    if (step.type === "PLANNER_RESPONSE") {
      if (typeof step.content === "string" && step.content.trim()) {
        assistant = shapeAttentionContext(step.content.trim(), "assistant", at);
      }
      const rawCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      if (rawCalls.some((call) => Boolean(call && typeof call === "object" && String((call as { name?: unknown }).name ?? "").toLowerCase() === target))) {
        return assistant ?? prompt;
      }
    }
  }
  return assistant ?? prompt;
}

/** Read at most 256 KiB from the tail of an Antigravity transcript. */
export async function readAntigravityPendingToolContext(path: string, toolName: string): Promise<AttentionContext | null> {
  const { open } = await import("node:fs/promises");
  let file;
  try {
    file = await open(path, "r");
    const stat = await file.stat();
    if (!stat.isFile() || stat.size <= 0) return null;
    const start = Math.max(0, stat.size - 256 * 1024);
    const buffer = Buffer.alloc(stat.size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    let tail = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) tail = tail.slice(tail.indexOf("\n") + 1);
    return findAntigravityPendingToolContext(tail, toolName);
  } catch {
    return null;
  } finally {
    await file?.close();
  }
}
