import { resolveHost, resolveWebPort } from "@openscout/runtime/local-config";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import {
  cancelScoutFlight,
  loadScoutFlight,
  resolveScoutBrokerUrl,
  waitForScoutFlight,
  type ScoutFlightRecord,
} from "../../core/broker/service.ts";

const HELP_FLAGS = new Set(["--help", "-h"]);
const DEFAULT_FLIGHT_WAIT_TIMEOUT_SECONDS = 30;
const MAX_FLIGHT_WAIT_TIMEOUT_SECONDS = 3600;

type FlightSubcommand = "get" | "wait" | "cancel";

type ScoutFlightCommandOptions =
  | { command: "help" }
  | { command: FlightSubcommand; flightId: string; timeoutSeconds?: number };

type ScoutFlightLinks = {
  follow: string | null;
  work: string | null;
  tail: string | null;
  session: string | null;
  agent: string | null;
};

type ScoutFlightFollowHandles = {
  invocationId: string;
  requesterId: string;
  targetAgentId: string;
  bindingRef: string;
  conversationId: string | null;
  messageId: string | null;
  workId: string | null;
  sessionId: string | null;
  links: ScoutFlightLinks;
};

type ScoutFlightCommandResult = {
  flightId: string;
  found: boolean;
  timedOut: boolean;
  terminal: boolean;
  flight: ScoutFlightRecord | null;
  output: string | null;
  summary: string | null;
  error: string | null;
  follow: ScoutFlightFollowHandles | null;
  nextAction: string | null;
};

export function renderFlightCommandHelp(): string {
  return [
    "Usage: scout flight <command> [options]",
    "",
    "Follow an existing Scout ask flight.",
    "",
    "Commands:",
    "  cancel <flightId>                  Cancel queued, not-yet-submitted work",
    "  get <flightId>                     Show current state without waiting",
    `  wait <flightId> [--timeout <sec>]  Wait for completion, failed, or cancelled (default ${DEFAULT_FLIGHT_WAIT_TIMEOUT_SECONDS}s)`,
    "",
    "Examples:",
    "  scout flight get flt_123",
    "  scout flight wait flt_123 --timeout 60",
  ].join("\n");
}

export function renderFlightGetCommandHelp(): string {
  return [
    "Usage: scout flight get <flightId>",
    "",
    "Show the current state for an existing Scout ask flight without blocking.",
  ].join("\n");
}

export function renderFlightWaitCommandHelp(): string {
  return [
    "Usage: scout flight wait <flightId> [--timeout <seconds>]",
    "",
    "Wait for a Scout ask flight to complete, fail, or be cancelled.",
    `The wait is bounded. Default timeout is ${DEFAULT_FLIGHT_WAIT_TIMEOUT_SECONDS}s; maximum is ${MAX_FLIGHT_WAIT_TIMEOUT_SECONDS}s.`,
    "On timeout, Scout prints the latest known state and follow-up handles.",
  ].join("\n");
}

export function parseFlightCommandOptions(args: string[]): ScoutFlightCommandOptions {
  if (args.length === 0 || args.some((arg) => HELP_FLAGS.has(arg))) {
    const subcommand = args.find((arg) => arg === "get" || arg === "wait" || arg === "cancel");
    if (subcommand === "get" || subcommand === "wait" || subcommand === "cancel") {
      return { command: subcommand, flightId: "" };
    }
    return { command: "help" };
  }

  const [command, ...rest] = args;
  if (command !== "get" && command !== "wait" && command !== "cancel") {
    throw new ScoutCliError(`unknown flight command: ${command ?? ""}`);
  }

  let flightId: string | undefined;
  let timeoutSeconds: number | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--timeout") {
      const rawValue = rest[index + 1];
      if (!rawValue) {
        throw new ScoutCliError("--timeout requires a number of seconds");
      }
      timeoutSeconds = parseFlightTimeout(rawValue);
      index += 1;
      continue;
    }
    if (arg?.startsWith("--timeout=")) {
      timeoutSeconds = parseFlightTimeout(arg.slice("--timeout=".length));
      continue;
    }
    if (arg?.startsWith("-")) {
      throw new ScoutCliError(`unknown flight ${command} option: ${arg}`);
    }
    if (flightId) {
      throw new ScoutCliError(`unexpected extra argument: ${arg}`);
    }
    flightId = arg;
  }

  if (!flightId?.trim()) {
    throw new ScoutCliError(`flight ${command} requires <flightId>`);
  }
  if (command !== "wait" && timeoutSeconds !== undefined) {
    throw new ScoutCliError(`flight ${command} does not accept --timeout`);
  }

  return {
    command,
    flightId: flightId.trim(),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
  };
}

export async function runFlightCommand(
  context: ScoutCommandContext,
  args: string[],
): Promise<void> {
  const options = parseFlightCommandOptions(args);
  if (options.command === "help") {
    context.output.writeText(renderFlightCommandHelp());
    return;
  }
  if (!options.flightId) {
    context.output.writeText(
      options.command === "cancel"
        ? "Usage: scout flight cancel <flightId> (only before submission)"
        : options.command === "get"
        ? renderFlightGetCommandHelp()
        : renderFlightWaitCommandHelp(),
    );
    return;
  }

  const brokerUrl = resolveScoutBrokerUrl();
  if (options.command === "cancel") {
    const result = await cancelScoutFlight(brokerUrl, options.flightId);
    context.output.writeValue(result, value => value.ok ? `Flight ${value.flightId}: ${value.state}` : value.detail);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (options.command === "get") {
    const flight = await loadScoutFlight(brokerUrl, options.flightId);
    context.output.writeValue(
      buildFlightCommandResult(flight, context.env, { requestedFlightId: options.flightId }),
      renderFlightCommandResult,
    );
    return;
  }

  let timedOut = false;
  let flight: ScoutFlightRecord | null = null;
  try {
    flight = await waitForScoutFlight(brokerUrl, options.flightId, {
      timeoutSeconds: options.timeoutSeconds ?? DEFAULT_FLIGHT_WAIT_TIMEOUT_SECONDS,
      waitUntil: "completed",
      onUpdate: (_flight, detail) => context.stderr(detail),
    });
  } catch (error) {
    flight = await loadScoutFlight(brokerUrl, options.flightId);
    if (isFlightWaitTimeout(error)) {
      timedOut = true;
    } else if (!flight || !isTerminalFlightState(flight.state)) {
      throw error;
    }
  }

  context.output.writeValue(
    buildFlightCommandResult(flight, context.env, { timedOut, requestedFlightId: options.flightId }),
    renderFlightCommandResult,
  );
}

export function renderFlightCommandResult(result: ScoutFlightCommandResult): string {
  if (!result.found || !result.flight || !result.follow) {
    return `Flight ${result.flightId} was not found.`;
  }

  const lines = [
    `Flight: ${result.flight.id}`,
    `State: ${result.flight.state}`,
    `Target: ${result.flight.targetAgentId}`,
    `Requester: ${result.flight.requesterId}`,
    `Invocation: ${result.flight.invocationId}`,
    `Ref: ref:${result.follow.bindingRef}`,
  ];

  if (result.follow.conversationId) lines.push(`Conversation: ${result.follow.conversationId}`);
  if (result.follow.messageId) lines.push(`Message: ${result.follow.messageId}`);
  if (result.follow.workId) lines.push(`Work: ${result.follow.workId}`);
  if (result.follow.sessionId) lines.push(`Session: ${result.follow.sessionId}`);
  if (result.summary) lines.push(`Summary: ${result.summary}`);
  if (result.output) lines.push(`Output:\n${result.output}`);
  if (result.error) lines.push(`Error: ${result.error}`);
  if (result.follow.links.follow) lines.push(`Follow the task: ${result.follow.links.follow}`);
  if (result.nextAction) lines.push(`Next: ${result.nextAction}`);

  return lines.join("\n");
}

function buildFlightCommandResult(
  flight: ScoutFlightRecord | null,
  env: NodeJS.ProcessEnv,
  options: { timedOut?: boolean; requestedFlightId?: string } = {},
): ScoutFlightCommandResult {
  const flightId = flight?.id ?? options.requestedFlightId ?? "";
  const terminal = isTerminalFlightState(flight?.state);
  const follow = flight ? buildFlightFollowHandles(flight, env) : null;
  const timedOut = options.timedOut ?? false;
  return {
    flightId,
    found: Boolean(flight),
    timedOut,
    terminal,
    flight,
    output: flight?.output ?? null,
    summary: flight?.summary ?? null,
    error: flight?.error ?? null,
    follow,
    nextAction: flight ? renderNextAction(flight, follow, timedOut) : null,
  };
}

function buildFlightFollowHandles(
  flight: ScoutFlightRecord,
  env: NodeJS.ProcessEnv,
): ScoutFlightFollowHandles {
  const conversationId = metadataStringValue(flight.metadata, "conversationId")
    ?? metadataReturnAddressStringValue(flight.metadata, "conversationId");
  const messageId = metadataStringValue(flight.metadata, "messageId")
    ?? metadataReturnAddressStringValue(flight.metadata, "replyToMessageId");
  const workId = metadataStringValue(flight.metadata, "workId")
    ?? metadataStringValue(flight.metadata, "collaborationRecordId");
  const sessionId = metadataStringValue(flight.metadata, "sessionId")
    ?? metadataDispatchAckStringValue(flight.metadata, "sessionId");
  const bindingRef = metadataStringValue(flight.metadata, "bindingRef")
    ?? flight.id.slice(-8);
  const links = buildFlightLinks({
    flightId: flight.id,
    invocationId: flight.invocationId,
    conversationId,
    workId,
    sessionId,
    targetAgentId: flight.targetAgentId,
  }, env);

  return {
    invocationId: flight.invocationId,
    requesterId: flight.requesterId,
    targetAgentId: flight.targetAgentId,
    bindingRef,
    conversationId,
    messageId,
    workId,
    sessionId,
    links,
  };
}

export function buildFlightLinks(
  ids: {
    flightId?: string | null;
    invocationId?: string | null;
    conversationId?: string | null;
    workId?: string | null;
    sessionId?: string | null;
    targetAgentId?: string | null;
  },
  env: NodeJS.ProcessEnv,
): ScoutFlightLinks {
  const origin = resolveScoutWebOrigin(env);
  const tailPath = buildFollowPath(ids, "tail");
  const sessionPath = buildFollowPath(ids, "session");
  const work = ids.workId ? buildScoutPath(origin, `/work/${encodeURIComponent(ids.workId)}`) : null;
  return {
    follow: work ?? (sessionPath ? buildScoutPath(origin, sessionPath) : null),
    work,
    tail: tailPath ? buildScoutPath(origin, tailPath) : null,
    session: sessionPath ? buildScoutPath(origin, sessionPath) : null,
    agent: ids.targetAgentId ? buildScoutPath(origin, `/agents/${encodeURIComponent(ids.targetAgentId)}?tab=message`) : null,
  };
}

function buildFollowPath(
  ids: Parameters<typeof buildFlightLinks>[0],
  preferredView: "tail" | "session",
): string | null {
  const params = new URLSearchParams();
  params.set("view", preferredView);
  if (ids.flightId) params.set("flightId", ids.flightId);
  if (ids.invocationId) params.set("invocationId", ids.invocationId);
  if (ids.conversationId) params.set("conversationId", ids.conversationId);
  if (ids.workId) params.set("workId", ids.workId);
  if (ids.sessionId) params.set("sessionId", ids.sessionId);
  if (ids.targetAgentId) params.set("targetAgentId", ids.targetAgentId);
  return params.size > 1 ? `/follow?${params.toString()}` : null;
}

function buildScoutPath(origin: string, path: string): string {
  return `${origin}${path.startsWith("/") ? path : `/${path}`}`;
}

function resolveScoutWebOrigin(env: NodeJS.ProcessEnv): string {
  const publicOrigin = env.OPENSCOUT_WEB_PUBLIC_ORIGIN?.trim();
  if (publicOrigin) return trimTrailingSlash(publicOrigin);

  const configuredPort = Number.parseInt(
    env.OPENSCOUT_WEB_PORT?.trim() || env.SCOUT_WEB_PORT?.trim() || "",
    10,
  );
  const port = Number.isFinite(configuredPort)
    ? configuredPort
    : resolveWebPort();
  const rawHost =
    env.OPENSCOUT_WEB_HOST?.trim() ||
    env.SCOUT_WEB_HOST?.trim() ||
    resolveHost();
  const host = rawHost === "0.0.0.0" || rawHost === "::"
    ? "127.0.0.1"
    : rawHost;
  return `http://${host}:${port}`;
}

function renderNextAction(
  flight: ScoutFlightRecord,
  follow: ScoutFlightFollowHandles | null,
  timedOut: boolean,
): string | null {
  if (flight.state === "completed") return null;
  if (flight.state === "failed" || flight.state === "cancelled") {
    return "Inspect the error above, then retry or follow up in the conversation.";
  }
  const waitCommand = `scout flight wait ${flight.id}`;
  const followText = follow?.links.follow ? ` or open ${follow.links.follow}` : "";
  if (timedOut) {
    return `Still ${flight.state}; run \`${waitCommand} --timeout ${DEFAULT_FLIGHT_WAIT_TIMEOUT_SECONDS}\` again${followText}.`;
  }
  return `Run \`${waitCommand} --timeout ${DEFAULT_FLIGHT_WAIT_TIMEOUT_SECONDS}\` to wait for terminal completion${followText}.`;
}

function parseFlightTimeout(value: string): number {
  const timeoutSeconds = Number(value);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new ScoutCliError("--timeout must be a positive number of seconds");
  }
  if (timeoutSeconds > MAX_FLIGHT_WAIT_TIMEOUT_SECONDS) {
    throw new ScoutCliError(`--timeout must be ${MAX_FLIGHT_WAIT_TIMEOUT_SECONDS} seconds or less`);
  }
  return timeoutSeconds;
}

function isFlightWaitTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Timed out waiting for flight");
}

function isTerminalFlightState(state: string | null | undefined): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function metadataStringValue(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function metadataReturnAddressStringValue(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = metadata?.["returnAddress"];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return metadataStringValue(value as Record<string, unknown>, key);
}

function metadataDispatchAckStringValue(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = metadata?.["dispatchAck"];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return metadataStringValue(value as Record<string, unknown>, key);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}
