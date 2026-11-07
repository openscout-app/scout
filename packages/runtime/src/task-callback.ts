import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SCOUT_TASK_CALLBACKS, type FlightRecord, type InvocationRequest, type ScoutTaskCallback } from "@openscout/protocol";
import { scoutHost, type ScoutHostRevealMode } from "./system-probes/scout-host.js";

/**
 * `scout ask --callback open`: when the task completes, the runtime on the
 * worker's host opens the page that the final reply names. The worker's agent
 * never opens it. Opening goes through the host's `reveal.open` probe, which
 * takes an absolute file path, so the reply names the page by path or by a
 * file:// URL, and only documents (html, pdf, images) are opened.
 */
const OPENABLE_EXTENSION = /\.(?:html?|pdf|png|jpe?g|gif|webp|svg)$/iu;
// A path in backticks is taken whole, spaces included; a bare path ends at
// whitespace or a bracket.
const PATH_CANDIDATE = /`((?:file:\/\/)?[~/][^`\n]*)`|(?<=^|[\s(<[`'"])(?:file:\/\/)?[~/][^\s<>"'`()[\]]*/gu;

export function invocationCallback(invocation: Pick<InvocationRequest, "metadata">): ScoutTaskCallback | undefined {
  const raw = invocation.metadata?.callback;
  return (SCOUT_TASK_CALLBACKS as readonly unknown[]).includes(raw) ? raw as ScoutTaskCallback : undefined;
}

/** The block in the full delivery prompt, after the reply-mode lines. */
export function buildCallbackPromptLines(callback: ScoutTaskCallback | undefined): string[] {
  if (callback !== "open") return [];
  return [
    "",
    "<!-- SCOUT CALLBACK -->",
    "> **Callback: open.** When this task completes, the runtime on this host opens the page your final reply names. Do not open it yourself.",
    "> Name the page by its absolute file path (an .html, .pdf or image file), in backticks if it has spaces. The runtime opens the first such file in your final reply that exists.",
  ];
}

/** One line for deliveries that carry the raw task instead of the full prompt. */
export function callbackLine(invocation: Pick<InvocationRequest, "metadata">): string | undefined {
  if (invocationCallback(invocation) !== "open") return undefined;
  return "When this task completes, the runtime opens the page your final reply names. Do not open it yourself; name it by its absolute file path (an .html, .pdf or image file).";
}

/** Absolute paths to documents that a reply names, in order. Existence is not checked here. */
export function openableFiles(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(PATH_CANDIDATE)) {
    let path = (match[1] ?? match[0]).trim().replace(/[.,;:!?*_]+$/u, "");
    if (path.startsWith("file://")) {
      try {
        path = decodeURIComponent(path.slice("file://".length));
      } catch {
        continue;
      }
    }
    if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
    if (path.startsWith("/") && OPENABLE_EXTENSION.test(path)) paths.push(path);
  }
  return paths;
}

/**
 * The callback runs where the task ran. A task that ran on another host is
 * recorded on both runtimes; only the worker's runtime runs it.
 */
export function callbackRunsHere(
  flight: Pick<FlightRecord, "state">,
  invocation: Pick<InvocationRequest, "metadata" | "requesterNodeId" | "targetNodeId">,
  nodeId: string,
): boolean {
  if (invocationCallback(invocation) !== "open" || flight.state !== "completed") return false;
  return Boolean(nodeId) && (invocation.targetNodeId ?? invocation.requesterNodeId) === nodeId;
}

export type TaskCallbackRun = {
  callback: ScoutTaskCallback;
  outcome: "opened" | "nothing_to_open" | "failed";
  target?: string;
  detail?: string;
};

function revealModeFor(platform: NodeJS.Platform): ScoutHostRevealMode | undefined {
  if (platform === "darwin") return "darwinOpen";
  if (platform === "linux") return "xdgOpen";
  return undefined;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function runTaskCallback(input: {
  flight: FlightRecord;
  invocation: InvocationRequest;
  nodeId: string;
  platform?: NodeJS.Platform;
  open?: (path: string, mode: ScoutHostRevealMode) => Promise<{ exitCode?: number | null } | unknown>;
}): Promise<TaskCallbackRun | undefined> {
  if (!callbackRunsHere(input.flight, input.invocation, input.nodeId)) return undefined;
  let target: string | undefined;
  for (const path of openableFiles(input.flight.output ?? input.flight.summary ?? "")) {
    if (await isFile(path)) {
      target = path;
      break;
    }
  }
  if (!target) return { callback: "open", outcome: "nothing_to_open" };
  const platform = input.platform ?? process.platform;
  const mode = revealModeFor(platform);
  if (!mode) return { callback: "open", outcome: "failed", target, detail: `no opener on ${platform}` };
  try {
    const result = await (input.open ?? ((path, revealMode) => scoutHost.reveal.open(path, revealMode)))(target, mode);
    const exitCode = result && typeof result === "object" && "exitCode" in result ? result.exitCode : 0;
    return exitCode === 0 || exitCode === undefined
      ? { callback: "open", outcome: "opened", target }
      : { callback: "open", outcome: "failed", target, detail: exitCode === null ? "the opener was stopped" : `exited ${exitCode}` };
  } catch (error) {
    return { callback: "open", outcome: "failed", target, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** One line for the runtime log. */
export function describeTaskCallbackRun(invocationId: string, run: TaskCallbackRun): string {
  const what = run.outcome === "opened" ? `opened ${run.target}`
    : run.outcome === "nothing_to_open" ? "found no existing html, pdf or image path in the final reply"
    : `failed to open ${run.target ?? "the page"}${run.detail ? `: ${run.detail}` : ""}`;
  return `[openscout-runtime] callback ${run.callback} for task ${invocationId} ${what}`;
}
