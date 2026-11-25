import { homedir } from "node:os";
import { resolve } from "node:path";

import { scoutBrokerPaths } from "@openscout/protocol";
import {
  describeAntigravityToolCall,
  formatAntigravityWaitingFor,
  isValidAntigravitySessionId,
  removeAntigravitySessionRecord,
  unwrapAntigravityToolArgs,
  writeAntigravitySessionRecord,
} from "@openscout/runtime";

import { resolveScoutBrokerUrl } from "../../lib/core/broker/service.ts";
import type { ScoutCommandContext } from "../context.ts";

/**
 * `scout permission-hook <claude|antigravity>`:
 *
 * - `claude`: Claude Code's `PermissionRequest` hook. Opens a native permission
 *   request on this machine's runtime and waits so the operator can answer it
 *   from Scout or in the terminal.
 * - `antigravity`: Antigravity's `PreToolUse` / `PostToolUse` / `Stop` hook.
 *   Records when a conversation pauses on a question, unsandboxed command,
 *   plan review, or out-of-workspace file access, and immediately writes `{}`
 *   so Antigravity's own UI is never delayed or double-prompted.
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
  permission_suggestions?: unknown;
};

type AntigravityHookInput = {
  hookEventName?: unknown;
  conversationId?: unknown;
  cwd?: unknown;
  workspacePaths?: unknown;
  transcriptPath?: unknown;
  artifactDirectoryPath?: unknown;
  toolCall?: unknown;
};

type Opened = { requestId?: string; skipped?: string };
type Outcome = { state?: "open" | "decided" | "ended"; decision?: "allow" | "deny"; updatedPermissions?: unknown; reason?: string };

export type PermissionHookDeps = {
  post?: <T>(path: string, body: unknown, timeoutMs: number) => Promise<T>;
  write?: (text: string) => void;
  recordsDirectory?: string;
  now?: () => number;
};

export async function runPermissionHookCommand(_context: ScoutCommandContext, args: string[]): Promise<void> {
  const target = args[0];
  if ((target !== "claude" && target !== "antigravity") || process.stdin.isTTY) {
    process.stderr.write("usage: scout permission-hook <claude|antigravity> < hook.json\n");
    return;
  }
  const raw = await readBoundedStdin(MAX_INPUT_BYTES);
  if (raw === null) {
    if (target === "antigravity") process.stdout.write("{}\n");
    return;
  }
  if (target === "antigravity") {
    await handleAntigravityPermissionHook(raw);
    return;
  }
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
      // The runtime keeps only the persistent allow rules among them, for "Allow always".
      ...(Array.isArray(input.permission_suggestions) ? { suggestions: input.permission_suggestions } : {}),
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
      // "Allow always" comes back with the rules to keep: Claude Code writes them as its own "don't ask again".
      const decision = outcome.decision === "allow"
        ? { behavior: "allow", ...(Array.isArray(outcome.updatedPermissions) && outcome.updatedPermissions.length ? { updatedPermissions: outcome.updatedPermissions } : {}) }
        : { behavior: "deny", message: DENIED_MESSAGE };
      write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } })}\n`);
      return;
    }
    if (outcome?.state !== "open") return;
  }
}

function isWithinAllowedRoots(targetPath: string, roots: string[]): boolean {
  const expanded = targetPath.startsWith("~/") ? `${homedir()}${targetPath.slice(1)}` : targetPath;
  const resolved = resolve(expanded);
  for (const root of roots) {
    const cleanRoot = resolve(root);
    if (resolved === cleanRoot || resolved.startsWith(`${cleanRoot}/`)) return true;
  }
  return false;
}

function shouldRecordAntigravityWaiting(
  toolName: string,
  args: Record<string, unknown>,
  allowedRoots: string[],
): boolean {
  const normalized = toolName.trim().toLowerCase();
  if (normalized === "ask_question" || normalized === "notify_user" || normalized === "plan_input") {
    return true;
  }
  if (normalized === "run_command" || normalized === "shell_exec") {
    return args.BypassSandbox === true || args.BypassSandbox === "true";
  }
  if (normalized === "write_file" || normalized === "edit_file" || normalized === "read_file" || normalized === "view_file") {
    const metadata = unwrapAntigravityToolArgs(args.ArtifactMetadata);
    if (metadata.RequestFeedback === true || metadata.RequestFeedback === "true") return true;
    const rawPath = typeof args.Path === "string" ? args.Path.trim() : "";
    if (rawPath && allowedRoots.length > 0 && !isWithinAllowedRoots(rawPath, allowedRoots)) {
      return true;
    }
  }
  return false;
}

export async function handleAntigravityPermissionHook(raw: string, deps: PermissionHookDeps = {}): Promise<void> {
  const write = deps.write ?? ((text: string) => { process.stdout.write(text); });
  const now = (deps.now ?? Date.now)();
  const directory = deps.recordsDirectory;
  try {
    const input = JSON.parse(raw) as AntigravityHookInput;
    const sessionId = typeof input?.conversationId === "string" ? input.conversationId.trim() : "";
    const event = typeof input?.hookEventName === "string" ? input.hookEventName.trim() : "";
    if (!isValidAntigravitySessionId(sessionId)) {
      write("{}\n");
      return;
    }
    if (event === "PostToolUse" || event === "Stop") {
      await removeAntigravitySessionRecord(sessionId, { directory });
      write("{}\n");
      return;
    }
    if (event === "PreToolUse") {
      const toolObj = input.toolCall && typeof input.toolCall === "object" && !Array.isArray(input.toolCall)
        ? input.toolCall as { id?: unknown; name?: unknown; args?: unknown }
        : null;
      const toolName = typeof toolObj?.name === "string" ? toolObj.name.trim() : "";
      const args = unwrapAntigravityToolArgs(toolObj?.args);
      const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : null;
      const workspaces = Array.isArray(input.workspacePaths)
        ? input.workspacePaths.filter((p): p is string => typeof p === "string" && Boolean(p.trim()))
        : [];
      const artifactDir = typeof input.artifactDirectoryPath === "string" && input.artifactDirectoryPath.trim()
        ? [input.artifactDirectoryPath.trim()]
        : [];
      const allowedRoots = [...workspaces, ...(cwd ? [cwd] : []), ...artifactDir, "/tmp", "/private/tmp"];

      if (toolName && shouldRecordAntigravityWaiting(toolName, args, allowedRoots)) {
        const described = describeAntigravityToolCall(toolName, args);
        const waitingFor = formatAntigravityWaitingFor({
          toolUseId: typeof toolObj?.id === "string" ? toolObj.id : "hook",
          tool: toolName,
          ...described,
          at: now,
          alsoPending: 0,
        });
        await writeAntigravitySessionRecord({
          sessionId,
          cwd,
          transcriptPath: typeof input.transcriptPath === "string" && input.transcriptPath.trim()
            ? input.transcriptPath.trim()
            : null,
          status: "waiting",
          waitingFor,
          statusUpdatedAt: now,
          toolCall: {
            id: typeof toolObj?.id === "string" && toolObj.id.trim() ? toolObj.id.trim() : null,
            name: toolName,
            args,
          },
        }, { directory });
      } else {
        await removeAntigravitySessionRecord(sessionId, { directory });
      }
    }
  } catch {
    // Never block Antigravity when hook input or disk state fails.
  }
  write("{}\n");
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
