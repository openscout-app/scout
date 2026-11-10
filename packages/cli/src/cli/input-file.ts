import { readFile, stat } from "node:fs/promises";
import { SCOUT_TASK_CALLBACK_MAX_CODE_LENGTH, type ScoutTaskCallback } from "@openscout/protocol";

import { ScoutCliError } from "./errors.ts";

/**
 * `ask --callback <file>`: reads the asker's callback module. The source goes
 * on the wire, because the task may run on another host.
 */
export async function readTaskCallbackFile(filePath: string): Promise<ScoutTaskCallback> {
  // UTF-8 takes at most four bytes per character, so a larger file is too long
  // without reading it.
  const size = await stat(filePath).then((info) => info.size, () => 0);
  const code = size > SCOUT_TASK_CALLBACK_MAX_CODE_LENGTH * 4 ? undefined : await readCliInputFile(filePath, "callback");
  if (code === undefined || code.length > SCOUT_TASK_CALLBACK_MAX_CODE_LENGTH) {
    throw new ScoutCliError(`callback file ${filePath} is over ${SCOUT_TASK_CALLBACK_MAX_CODE_LENGTH} characters`);
  }
  return { code };
}

export async function readCliInputFile(
  filePath: string,
  label: "message" | "prompt" | "callback",
): Promise<string> {
  let body: string;
  try {
    body = await readFile(filePath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ScoutCliError(`could not read ${label} file ${filePath}: ${detail}`);
  }

  const normalized = body.replace(/^\uFEFF/, "");
  if (!normalized.trim()) {
    throw new ScoutCliError(`${label} file is empty: ${filePath}`);
  }
  return normalized;
}

export async function resolvePromptBody(input: {
  message: string;
  promptFile?: string;
}): Promise<string> {
  return input.promptFile
    ? readCliInputFile(input.promptFile, "prompt")
    : input.message;
}

export async function resolveMessageBody(input: {
  message: string;
  messageFile?: string;
}): Promise<string> {
  return input.messageFile
    ? readCliInputFile(input.messageFile, "message")
    : input.message;
}
