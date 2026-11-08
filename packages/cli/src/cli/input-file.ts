import { readFile } from "node:fs/promises";

import { ScoutCliError } from "./errors.ts";

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
