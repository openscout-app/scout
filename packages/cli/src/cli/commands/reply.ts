import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { FLIGHT_WAITING_ON_SUMMARY_MAX_LENGTH, parseReplyPointArg, replyPointsOf, validateTaskReply, type FlightWaitingOnKind, type ReplyPointInput, type ReplyWaitingOn } from "@openscout/protocol";
import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { readTaskImage } from "../task-image.ts";
import { replyToScoutTask, resolveScoutSenderId } from "../../lib/core/broker/service.ts";

export function renderReplyCommandHelp(): string {
  return [
    'Usage: scout reply (--ref <task> | --to <message>) [--progress | --failed | --waiting-on <kind> [--waiting-ref <id>]] [--point <point>]... [--image <path>] [--request-id <id>] "answer"',
    "A final reply completes the task; --failed fails it; --progress updates its work record without closing it.",
    "--waiting-on permission|question|review says the work is blocked: the task stays open and waits. --waiting-ref names the request that unblocks it.",
    "While the task waits on an open permission request, a final reply is recorded as blocked on that request.",
    "Only the current recipient may answer. The first final reply wins; cancelled tasks reject replies.",
    "--to is a plain conversation reply and has no task lifecycle.",
    "--point states what the reply does, once per point: '<stance>: <text>' or '<stance>[re=<point id>,about=<key>]: <text>'.",
    "  Stances: claim, agree, concede, dispute, question (a question for the operator). re names the point this one answers;",
    "  about is a short lowercase key for the question, shared with the other agents. The reply prints each point's id.",
    "If the ask requires a task reply, only a final reply with --ref completes it. Otherwise the harness final turn is already the answer: do not answer twice.",
  ].join("\n");
}
export function parseReplyCommandOptions(args: string[]) {
  const result: { ref?: string; to?: string; progress?: boolean; failed?: boolean; image?: string; requestId?: string; sender?: string; cwd?: string;
    waitingKind?: string; waitingRef?: string; waitingOn?: ReplyWaitingOn; points?: ReplyPointInput[]; body: string } = { body: "" };
  const parts: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") { parts.push(...args.slice(index + 1)); break; }
    if (arg === "--progress" || arg === "--failed") { result[arg.slice(2) as "progress" | "failed"] = true; continue; }
    if (arg === "--point" || arg.startsWith("--point=")) {
      const value = arg.startsWith("--point=") ? arg.slice("--point=".length) : args[++index];
      if (!value?.trim()) throw new Error("--point needs a value");
      (result.points ??= []).push(parseReplyPointArg(value)); continue;
    }
    const flag = ["--ref", "--to", "--image", "--request-id", "--as", "--cwd", "--context-root", "--waiting-on", "--waiting-ref"].find(flag => arg === flag || arg.startsWith(`${flag}=`));
    if (flag) {
      const value = arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : args[++index];
      if (!value?.trim() || value.startsWith("--")) throw new Error(`${flag} needs a value`);
      const key = ({ "--ref": "ref", "--to": "to", "--image": "image", "--request-id": "requestId", "--as": "sender", "--cwd": "cwd", "--context-root": "cwd",
        "--waiting-on": "waitingKind", "--waiting-ref": "waitingRef" } as const)[flag as "--ref"];
      if (result[key]) throw new Error(`${flag} may appear only once`);
      result[key] = value; continue;
    }
    if (arg.startsWith("-")) throw new Error(`unknown flag ${arg}; run scout reply --help`);
    parts.push(arg);
  }
  result.body = parts.join(" ").trim();
  if (result.waitingRef && !result.waitingKind) throw new Error("--waiting-ref requires --waiting-on");
  if (result.waitingKind) {
    result.waitingOn = { kind: result.waitingKind as FlightWaitingOnKind,
      summary: (result.body.split("\n")[0] ?? "").trim().slice(0, FLIGHT_WAITING_ON_SUMMARY_MAX_LENGTH),
      ...(result.waitingRef ? { requestRef: result.waitingRef } : {}) };
  }
  validateTaskReply(result);
  if (!result.body) throw new Error("reply requires an answer");
  if (result.requestId && result.requestId.length > 256) throw new Error("--request-id must contain 1 to 256 characters");
  return result;
}
export async function runReplyCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.some(arg => ["--help", "-h"].includes(arg))) { context.output.writeText(renderReplyCommandHelp()); return; }
  const options = parseReplyCommandOptions(args);
  const cwd = options.cwd ?? defaultScoutContextDirectory(context);
  const requestId = options.requestId ?? `reply-${randomUUID()}`;
  const senderId = await resolveScoutSenderId(options.sender, cwd, context.env);
  context.stderr(`request ${requestId} (reuse after an uncertain receipt)`);
  const receipt = await replyToScoutTask({ requestId, senderId, ref: options.ref, to: options.to,
    body: options.body, progress: options.progress, failed: options.failed, ...(options.waitingOn ? { waitingOn: options.waitingOn } : {}),
    ...(options.points ? { points: options.points } : {}),
    ...(options.image ? { image: await readTaskImage(resolve(cwd, options.image)) } : {}) });
  const points = replyPointsOf((receipt as { message?: { metadata?: Record<string, unknown> } } | null)?.message?.metadata)?.points ?? [];
  const recorded = options.to ? "Conversation reply recorded." : options.progress ? "Task progress recorded; task remains open."
    : options.waitingOn ? `Blocked on ${options.waitingOn.kind}; task remains open and waiting.` : "Final task reply recorded.";
  context.output.writeValue({ requestId, receipt }, () => [recorded, ...points.map(point => `${point.id}  ${point.stance}: ${point.text}`)].join("\n"));
}
