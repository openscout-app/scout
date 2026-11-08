import { scoutBrokerPaths } from "@openscout/protocol";

import { resolveScoutBrokerUrl } from "../../lib/core/broker/service.ts";
import type { ScoutCommandContext } from "../context.ts";

/**
 * `scout permission-hook claude`: Claude Code's `PermissionRequest` hook.
 *
 * Claude Code runs it while its permission dialog is on screen. It opens a
 * request on this machine's runtime, so the operator can answer it on the
 * board, and waits. A decision is printed for Claude Code to apply. Anything
 * else prints nothing and leaves the dialog to the session: the runtime is
 * down, Scout launched the session itself, the dialog was answered in the
 * session, or the request ended.
 */

const MAX_INPUT_BYTES = 256 * 1024;
const OPEN_TIMEOUT_MS = 3_000;
const WAIT_MS = 8_000;
const WAIT_TIMEOUT_MS = WAIT_MS + 4_000;
const MAX_FAILED_POLLS = 3;
const DENIED_MESSAGE = "The operator denied this from Scout.";

type HookInput = {
  hook_event_name?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  transcript_path?: unknown;
};

type Opened = { requestId?: string; skipped?: string };
type Outcome = { state?: "open" | "decided" | "ended"; decision?: "allow" | "deny"; reason?: string };

export type PermissionHookDeps = {
  post?: <T>(path: string, body: unknown, timeoutMs: number) => Promise<T>;
  write?: (text: string) => void;
};

export async function runPermissionHookCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args[0] !== "claude" || process.stdin.isTTY) {
    process.stderr.write("usage: scout permission-hook claude < hook.json (run by Claude Code as a PermissionRequest hook)\n");
    return;
  }
  const raw = await readBoundedStdin(MAX_INPUT_BYTES);
  if (raw === null) return;
  await handleClaudePermissionHook(raw);
}

/** Resolves once the request is decided or ended; the decision, if any, is written to stdout. */
export async function handleClaudePermissionHook(raw: string, deps: PermissionHookDeps = {}): Promise<void> {
  const post = deps.post ?? postJson;
  const write = deps.write ?? ((text: string) => { process.stdout.write(text); });
  let input: HookInput;
  try { input = JSON.parse(raw) as HookInput; } catch { return; }
  if (input?.hook_event_name !== "PermissionRequest") return;
  if (typeof input.session_id !== "string" || typeof input.cwd !== "string" || typeof input.tool_name !== "string") return;

  let opened: Opened;
  try {
    opened = await post<Opened>(scoutBrokerPaths.v1.permissionsNative, {
      harness: "claude", sessionId: input.session_id, cwd: input.cwd,
      toolName: input.tool_name, toolInput: input.tool_input ?? null,
      ...(typeof input.transcript_path === "string" ? { transcriptPath: input.transcript_path } : {}),
    }, OPEN_TIMEOUT_MS);
  } catch {
    return;
  }
  const requestId = opened?.requestId;
  if (typeof requestId !== "string" || !requestId) return;

  let failed = 0;
  for (;;) {
    let outcome: Outcome;
    try {
      outcome = await post<Outcome>(scoutBrokerPaths.v1.permissionsNativeWait, { requestId, waitMs: WAIT_MS }, WAIT_TIMEOUT_MS);
      failed = 0;
    } catch {
      // The runtime went away or restarted: its request went with it.
      if (++failed >= MAX_FAILED_POLLS) return;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }
    if (outcome?.state === "decided") {
      const decision = outcome.decision === "allow"
        ? { behavior: "allow" }
        : { behavior: "deny", message: DENIED_MESSAGE };
      write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } })}\n`);
      return;
    }
    if (outcome?.state !== "open") return;
  }
}

async function postJson<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  const response = await fetch(new URL(path, resolveScoutBrokerUrl()), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`runtime returned HTTP ${response.status}`);
  return await response.json() as T;
}

/** Null when the input is larger than `maxBytes`: the hook then stays out of the way. */
async function readBoundedStdin(maxBytes: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
