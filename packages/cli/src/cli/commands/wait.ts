import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import {
  resolveScoutBrokerUrl,
  loadScoutInvocationSnapshot,
  resolveScoutWaitReference,
  waitForScoutInvocation,
  type ScoutFlightRecord,
  type ScoutInvocationSnapshot,
  type ScoutWaitResolution,
} from "../../lib/core/broker/service.ts";

const HELP_FLAGS = new Set(["--help", "-h"]);
const DEFAULT_WAIT_TIMEOUT_SECONDS = 600;
const MAX_WAIT_TIMEOUT_SECONDS = 86_400;

type ScoutWaitCommandOptions =
  | { command: "help" }
  | { command: "wait"; ref: string; timeoutSeconds?: number };

type ScoutWaitCommandResult = {
  input: string;
  found: boolean;
  timedOut: boolean;
  resolution: Extract<ScoutWaitResolution, { found: true }> | null;
  invocationId: string | null;
  flight: ScoutFlightRecord | null;
  output: string | null;
  summary: string | null;
  error: string | null;
  nextAction: string | null;
};

export function renderWaitCommandHelp(): string {
  return [
    "Usage: scout wait <ref> [--timeout <seconds>]",
    "",
    "Wait for a Scout ask to finish from an invocation id, flight id, message id, ref:<short-id>, or the session-… id it was sent to (its current task, else its last).",
    "The timeout is only your wait budget. It does not cancel or fail the underlying work.",
    "If still pending, wait on the same ref again or run scout status <ref> --json; do not submit a duplicate ask.",
    "Inspect the returned terminal state, output, and error before reporting completion.",
    "",
    "Examples:",
    "  scout wait inv_123",
    "  scout wait flt_123 --timeout 600",
    "  scout wait ref:7f3a9c21",
  ].join("\n");
}

export function parseWaitCommandOptions(args: string[]): ScoutWaitCommandOptions {
  if (args.length === 0 || args.some((arg) => HELP_FLAGS.has(arg))) {
    return { command: "help" };
  }

  let ref: string | undefined;
  let timeoutSeconds: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--timeout") {
      const rawValue = args[index + 1];
      if (!rawValue) {
        throw new ScoutCliError("--timeout requires a number of seconds");
      }
      timeoutSeconds = parseWaitTimeout(rawValue);
      index += 1;
      continue;
    }
    if (arg.startsWith("--timeout=")) {
      timeoutSeconds = parseWaitTimeout(arg.slice("--timeout=".length));
      continue;
    }
    if (arg.startsWith("-")) {
      throw new ScoutCliError(`unknown wait option: ${arg}`);
    }
    if (ref) {
      throw new ScoutCliError(`unexpected extra argument: ${arg}`);
    }
    ref = arg;
  }

  if (!ref?.trim()) {
    throw new ScoutCliError("wait requires <ref>");
  }
  return { command: "wait", ref: ref.trim(), ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}) };
}

export async function runWaitCommand(
  context: ScoutCommandContext,
  args: string[],
): Promise<void> {
  const options = parseWaitCommandOptions(args);
  if (options.command === "help") {
    context.output.writeText(renderWaitCommandHelp());
    return;
  }

  const brokerUrl = resolveScoutBrokerUrl();
  const resolution = await resolveScoutWaitReference(brokerUrl, options.ref);
  if (!resolution.found) {
    const candidates = resolution.candidates.length > 0
      ? ` Candidates: ${resolution.candidates.join(", ")}`
      : "";
    throw new ScoutCliError(`could not resolve wait ref: ${options.ref}.${candidates}`);
  }

  let timedOut = false;
  let snapshot: ScoutInvocationSnapshot | null = null;
  try {
    snapshot = await waitForScoutInvocation(brokerUrl, resolution.invocationId, {
      timeoutSeconds: options.timeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS,
      onUpdate: (_snapshot, detail) => context.stderr(detail),
    });
  } catch (error) {
    if (isInvocationWaitTimeout(error)) {
      timedOut = true;
      snapshot = await loadScoutInvocationSnapshot(brokerUrl, resolution.invocationId);
    } else {
      throw error;
    }
  }

  context.output.writeValue(
    buildWaitCommandResult({
      input: options.ref,
      resolution,
      snapshot,
      timedOut,
    }),
    renderWaitCommandResult,
  );
}

export function renderWaitCommandResult(result: ScoutWaitCommandResult): string {
  if (!result.found || !result.resolution) {
    return `Wait ref ${result.input} was not found.`;
  }

  const lines = [
    `Invocation: ${result.invocationId}`,
    result.flight ? `Flight: ${result.flight.id}` : null,
    result.flight ? `State: ${result.flight.state}` : null,
    `Resolved: ${result.resolution.kind}`,
    result.resolution.messageId ? `Message: ${result.resolution.messageId}` : null,
    result.resolution.bindingRef ? `Ref: ref:${result.resolution.bindingRef}` : null,
    result.summary ? `Summary: ${result.summary}` : null,
    result.output ? `Output:\n${result.output}` : null,
    result.error ? `Error: ${result.error}` : null,
    result.nextAction ? `Next: ${result.nextAction}` : null,
  ].filter((line): line is string => Boolean(line));

  return lines.join("\n");
}

function buildWaitCommandResult(input: {
  input: string;
  resolution: Extract<ScoutWaitResolution, { found: true }>;
  snapshot: ScoutInvocationSnapshot | null;
  timedOut: boolean;
}): ScoutWaitCommandResult {
  const flight = input.snapshot?.flight ?? null;
  return {
    input: input.input,
    found: true,
    timedOut: input.timedOut,
    resolution: input.resolution,
    invocationId: input.resolution.invocationId,
    flight,
    output: flight?.output ?? null,
    summary: flight?.summary ?? null,
    error: flight?.error ?? null,
    nextAction: renderWaitNextAction(input.resolution.invocationId, flight, input.timedOut),
  };
}

function renderWaitNextAction(
  invocationId: string,
  flight: ScoutFlightRecord | null,
  timedOut: boolean,
): string | null {
  if (flight?.state === "completed") return null;
  if (flight?.state === "failed" || flight?.state === "cancelled") {
    return "Inspect the error above, then retry or follow up in the conversation.";
  }
  const command = `scout wait ${invocationId} --timeout ${DEFAULT_WAIT_TIMEOUT_SECONDS}`;
  if (timedOut) {
    return `Still ${flight?.state ?? "pending"}; run \`${command}\` again.`;
  }
  return `Run \`${command}\` to keep waiting.`;
}

function parseWaitTimeout(value: string): number {
  const timeoutSeconds = Number(value);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new ScoutCliError("--timeout must be a positive number of seconds");
  }
  if (timeoutSeconds > MAX_WAIT_TIMEOUT_SECONDS) {
    throw new ScoutCliError(`--timeout must be ${MAX_WAIT_TIMEOUT_SECONDS} seconds or less`);
  }
  return timeoutSeconds;
}

function isInvocationWaitTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Timed out waiting for invocation");
}
