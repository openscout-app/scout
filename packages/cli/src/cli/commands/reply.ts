import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { validateTaskReply } from "@openscout/protocol";
import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { readTaskImage } from "../task-image.ts";
import { replyToScoutTask, resolveScoutSenderId } from "../../lib/core/broker/service.ts";

export function renderReplyCommandHelp(): string {
  return [
    'Usage: scout reply (--ref <task> | --to <message>) [--progress | --failed] [--image <path>] [--request-id <id>] "answer"',
    "A final reply completes the task; --failed fails it; --progress updates its work record without closing it.",
    "Only the current recipient may answer. The first final reply wins; cancelled tasks reject replies.",
    "--to is a plain conversation reply and has no task lifecycle.",
    "The harness final turn is already an automatic answer. Do not answer twice.",
  ].join("\n");
}
export function parseReplyCommandOptions(args: string[]) {
  const result: { ref?: string; to?: string; progress?: boolean; failed?: boolean; image?: string; requestId?: string; sender?: string; cwd?: string; body: string } = { body: "" };
  const parts: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") { parts.push(...args.slice(index + 1)); break; }
    if (arg === "--progress" || arg === "--failed") { result[arg.slice(2) as "progress" | "failed"] = true; continue; }
    const flag = ["--ref", "--to", "--image", "--request-id", "--as", "--cwd", "--context-root"].find(flag => arg === flag || arg.startsWith(`${flag}=`));
    if (flag) {
      const value = arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : args[++index];
      if (!value?.trim() || value.startsWith("--")) throw new Error(`${flag} needs a value`);
      const key = ({ "--ref": "ref", "--to": "to", "--image": "image", "--request-id": "requestId", "--as": "sender", "--cwd": "cwd", "--context-root": "cwd" } as const)[flag as "--ref"];
      if (result[key]) throw new Error(`${flag} may appear only once`);
      result[key] = value; continue;
    }
    if (arg.startsWith("-")) throw new Error(`unknown flag ${arg}; run scout reply --help`);
    parts.push(arg);
  }
  result.body = parts.join(" ").trim();
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
    body: options.body, progress: options.progress, failed: options.failed,
    ...(options.image ? { image: await readTaskImage(resolve(cwd, options.image)) } : {}) });
  context.output.writeValue({ requestId, receipt }, () => options.to ? "Conversation reply recorded." : options.progress ? "Task progress recorded; task remains open." : "Final task reply recorded.");
}
