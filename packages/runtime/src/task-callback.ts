import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  SCOUT_TASK_CALLBACK_MAX_CODE_LENGTH,
  type AgentDefinition,
  type FlightRecord,
  type InvocationRequest,
} from "@openscout/protocol";
import { scoutHost, type ScoutHostRevealMode } from "./system-probes/scout-host.js";
import { runSandboxedFunction, type SandboxLimits } from "./task-callback-sandbox.js";

/**
 * `scout ask --callback <file>`: the asker's JavaScript module, run by the
 * runtime on the worker's host when the task ends. The asker's side reads the
 * file and sends its source, so the worker's host needs no copy. It is not part
 * of the worker's prompt. The module runs in the QuickJS sandbox; its default
 * export gets the task's result as data, and `scout.open` is its one way to
 * act on the host.
 */
const TERMINAL_STATES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);
/** `scout.open` opens documents only: opening a script or an app would run it. */
const OPENABLE_EXTENSION = /\.(?:html?|pdf|png|jpe?g|gif|webp|svg)$/iu;
// A path in backticks is taken whole, spaces included; a bare path ends at
// whitespace or a bracket. A path inside a URL is not preceded by either.
const PATH_CANDIDATE = /`((?:file:\/\/)?[~/][^`\n]*)`|(?<=^|[\s(<[`'"])(?:file:\/\/)?[~/][^\s<>"'`()[\]]*/gu;
const MAX_RESULT_FILES = 20;
const MAX_OPENS = 5;

export function invocationCallbackCode(invocation: Pick<InvocationRequest, "metadata">): string | undefined {
  const callback = invocation.metadata?.callback;
  if (!callback || typeof callback !== "object") return undefined;
  const code = (callback as { code?: unknown }).code;
  return typeof code === "string" && code.trim() && code.length <= SCOUT_TASK_CALLBACK_MAX_CODE_LENGTH ? code : undefined;
}

function absolutePath(raw: string): string | undefined {
  let path = raw.trim().replace(/[.,;:!?*_]+$/u, "");
  if (path.startsWith("file://")) {
    try {
      path = decodeURIComponent(path.slice("file://".length));
    } catch {
      return undefined;
    }
  }
  if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  return path.startsWith("/") ? path : undefined;
}

/** Absolute paths that a reply names, in order and without repeats. Existence is not checked here. */
export function namedPaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(PATH_CANDIDATE)) {
    const path = absolutePath(match[1] ?? match[0]);
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

/**
 * The callback runs where the task ran, once, when the task ends. A task that
 * ran on another host is recorded on both runtimes; only the worker's runs it.
 */
export function callbackRunsHere(
  flight: Pick<FlightRecord, "state" | "metadata">,
  invocation: Pick<InvocationRequest, "metadata" | "targetNodeId">,
  nodeId: string,
  targetAgent?: Pick<AgentDefinition, "authorityNodeId" | "homeNodeId">,
  targetEndpointNodeId?: string,
): boolean {
  if (!invocationCallbackCode(invocation) || !TERMINAL_STATES.has(flight.state)) return false;
  return Boolean(nodeId) && taskWorkerNodeId(flight, invocation, targetAgent, targetEndpointNodeId) === nodeId;
}

/**
 * The node whose runtime ran the task, from the strongest evidence there is:
 * an explicit target node, then the node that acknowledged the dispatch, then
 * the target agent's authority, then the node of the target's home endpoint (a
 * session target can have an endpoint and no agent card). Never the
 * requester's node: an ordinary ask to a remote agent names no target node,
 * and the requester did not run it.
 */
export function taskWorkerNodeId(
  flight: Pick<FlightRecord, "metadata">,
  invocation: Pick<InvocationRequest, "targetNodeId">,
  targetAgent?: Pick<AgentDefinition, "authorityNodeId" | "homeNodeId">,
  targetEndpointNodeId?: string,
): string | undefined {
  const ack = flight.metadata?.dispatchAck;
  const ackNode = ack && typeof ack === "object" ? (ack as { nodeId?: unknown }).nodeId : undefined;
  return invocation.targetNodeId
    || (typeof ackNode === "string" && ackNode ? ackNode : undefined)
    || targetAgent?.authorityNodeId
    || targetAgent?.homeNodeId
    || targetEndpointNodeId
    || undefined;
}

/** What the callback gets as `result`. */
export type TaskCallbackResult = {
  taskId: string;
  state: FlightRecord["state"];
  /** The final reply text. */
  reply: string;
  /** Existing files that the reply names by absolute path, `~/` or file:// URL. */
  files: string[];
};

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function taskCallbackResult(
  flight: Pick<FlightRecord, "state" | "output" | "summary">,
  invocation: Pick<InvocationRequest, "id">,
): Promise<TaskCallbackResult> {
  const reply = flight.output ?? flight.summary ?? "";
  const files: string[] = [];
  for (const path of namedPaths(reply)) {
    if (files.length >= MAX_RESULT_FILES) break;
    if (await isFile(path)) files.push(path);
  }
  return { taskId: invocation.id, state: flight.state, reply, files };
}

export type TaskCallbackRun = { ok: boolean; opened: string[]; logs: string[]; error?: string };

function revealModeFor(platform: NodeJS.Platform): ScoutHostRevealMode | undefined {
  if (platform === "darwin") return "darwinOpen";
  if (platform === "linux") return "xdgOpen";
  return undefined;
}

export async function runTaskCallback(input: {
  flight: FlightRecord;
  invocation: InvocationRequest;
  nodeId: string;
  /** The target agent, when this runtime knows it; it names the worker's node. */
  targetAgent?: Pick<AgentDefinition, "authorityNodeId" | "homeNodeId">;
  /** The node of the target's home endpoint, for a target with no agent card. */
  targetEndpointNodeId?: string;
  platform?: NodeJS.Platform;
  open?: (path: string, mode: ScoutHostRevealMode) => Promise<{ exitCode?: number | null } | unknown>;
  limits?: Partial<SandboxLimits>;
}): Promise<TaskCallbackRun | undefined> {
  if (!callbackRunsHere(input.flight, input.invocation, input.nodeId, input.targetAgent, input.targetEndpointNodeId)) return undefined;
  const code = invocationCallbackCode(input.invocation)!;
  const platform = input.platform ?? process.platform;
  const reveal = input.open ?? ((path: string, mode: ScoutHostRevealMode) => scoutHost.reveal.open(path, mode));
  const opened: string[] = [];
  let opens = 0;
  // Opening goes through the host's `reveal.open` probe (scoutd when it runs),
  // which takes an absolute file path. No new process launch is added here.
  const open = async (target: unknown): Promise<string> => {
    if (typeof target !== "string") throw new Error("scout.open takes a file path");
    const path = absolutePath(target);
    if (!path) throw new Error(`scout.open takes an absolute path or a file:// URL, not ${target}`);
    if (!OPENABLE_EXTENSION.test(path)) throw new Error(`scout.open opens html, pdf and image files only, not ${path}`);
    if (!(await isFile(path))) throw new Error(`scout.open found no file at ${path}`);
    if (++opens > MAX_OPENS) throw new Error(`scout.open opens at most ${MAX_OPENS} files per callback`);
    const mode = revealModeFor(platform);
    if (!mode) throw new Error(`scout.open has no opener on ${platform}`);
    const result = await reveal(path, mode);
    const exitCode = result && typeof result === "object" && "exitCode" in result ? result.exitCode : 0;
    if (exitCode !== 0 && exitCode !== undefined) {
      throw new Error(exitCode === null ? "the opener was stopped" : `the opener exited ${exitCode}`);
    }
    opened.push(path);
    return path;
  };
  const run = await runSandboxedFunction({
    code,
    data: { result: await taskCallbackResult(input.flight, input.invocation) },
    scout: { open },
    limits: input.limits,
  });
  return run.ok ? { ok: true, opened, logs: run.logs } : { ok: false, opened, logs: run.logs, error: run.error };
}

/** Lines for the runtime log. */
export function describeTaskCallbackRun(invocationId: string, run: TaskCallbackRun): string[] {
  const prefix = `[openscout-runtime] callback for task ${invocationId}`;
  const opened = run.opened.length ? `opened ${run.opened.join(", ")}` : "opened nothing";
  return [
    run.ok ? `${prefix} ran; ${opened}` : `${prefix} failed: ${run.error}${run.opened.length ? `; ${opened}` : ""}`,
    ...run.logs.map((line) => `${prefix} log: ${line}`),
  ];
}
