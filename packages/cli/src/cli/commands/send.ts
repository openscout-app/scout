import { claimedSessionHarness, claimedSessionId } from "../../lib/core/broker/sender.js";
import { classifySendInteraction } from "../../lib/core/broker/send-interaction.ts";

import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { resolveMessageBody } from "../input-file.ts";
import {
  parseSendCommandOptions,
  type ScoutSendCommandOptions,
  type ScoutTellCommandOptions,
} from "../options.ts";
import { scoutAskHandler } from "../../lib/core/broker/ask.ts";
import type { ScoutAskReceipt } from "../../lib/core/broker/ask-types.ts";
import {
  loadScoutInvocationSnapshot,
  parseScoutHarness,
  resolveScoutBrokerUrl,
  resolveScoutSenderId,
  sendScoutMessage,
  waitForScoutInvocation,
  type ScoutFlightRecord,
  type ScoutInvocationSnapshot,
  type ScoutMessagePostResult,
} from "../../lib/core/broker/service.ts";
import { renderScoutMessagePostResult } from "../../lib/ui/terminal/broker.ts";
import {
  formatScoutAskReceiptError,
  loadInitialScoutAskFlight,
} from "./ask.ts";

const HELP_FLAGS = new Set(["--help", "-h"]);
const DEFAULT_SEND_WAIT_TIMEOUT_SECONDS = 600;

export function renderSendCommandHelp(): string {
  return [
    "Usage: scout send [--as <sender>] [--to <agent> | --ref <ref>] [--alias-project <path>] [--alias-host <node>] [--channel <name>] [--tracked [--no-notifs | --wait [--timeout <seconds>]]] [--speak] [--wake] [--harness <runtime>] [--message-file <path> | <message>]",
    "",
    "Legacy. Use `scout ask` when anything is expected back and `scout tell` for FYIs; send stays for older scripts.",
    "",
    "Tell or update another agent or an explicit channel.",
    "",
    "Routing:",
    "  --to <agent>                      -> DM; body @mentions stay text",
    "  --to target:<name> or --to ⌖name   -> saved situated target",
    "  --to alias:<name>                  -> explicit broker route alias; optional qualified alias scope",
    "  one explicit @agent + no channel   -> DM",
    "  --channel <name>                   -> named group thread",
    "  no target + no channel             -> error",
    "  multiple targets + no channel      -> error",
    "",
    "Use send only when no reply, judgment, investigation, or owned work is expected.",
    "Use `scout ask` when the meaning is \"do this and get back to me.\" When in doubt, use ask.",
    "For asynchronous work, do not downgrade an ask to send: use `scout ask --notify` so Scout returns now and reports completion later.",
    "`scout tell` is the explicit FYI spelling of a plain send; it never creates work and rejects --wake/--tracked.",
    "Targeted DMs dispatch automatically when the broker can reach the agent.",
    "Add --wake only when you need to force an explicit wake turn or runtime harness.",
    "",
    "Tracked (opt-in):",
    "  --tracked                          -> directed --to only: create tracked work on the ask invocation",
    "                                        lifecycle (same as `scout ask --notify`); returns with durable",
    "                                        handles and reports completion back to you",
    "  --tracked --no-notifs              -> tracked, result retained; no completion callback (ask --reply-mode none)",
    "  --tracked --wait [--timeout <s>]   -> tracked; wait for the result within a bounded budget (default 600s)",
    "  channels, --ref replies, broadcasts, and [ask:<id>] completion bodies never become tracked work;",
    "  --tracked on them fails closed.",
    "",
    "Input:",
    "  inline message                    -> message body",
    "  --message-file <path>             -> read the message body from a UTF-8 file",
    "  --body-file <path>                -> alias for --message-file",
    "",
    "Examples:",
    '  scout send --to hudson "review completed; literal @codex stays text"',
    '  scout send --to target:mw-talkie "status update for that worker"',
    '  scout send --ref 7f3a9c21 "FYI: the build passed; no action needed"',
    '  scout send --to lattices#codex?5.5 "review completed; findings recorded in the PR"',
    '  scout send --to hudson --wake "FYI: the chrome feedback is already applied"',
    "  scout send --channel triage --message-file ./status.md",
    '  scout send --as premotion.master.mini --to hudson "editor branch is green"',
    '  scout send --channel triage "both reviews are complete"',
    '  scout send "@hudson build passed"  # legacy body-mention shorthand',
    '  scout tell --to hudson "branch pushed"  # same FYI, explicit verb',
    '  scout send --tracked --to hudson "run the nightly sweep and report back"',
    "",
    "For work instead:",
    '  scout ask --to hudson --notify "apply the chrome feedback and report back"',
  ].join("\n");
}

export {
  classifySendInteraction,
  type ScoutSendInteraction,
} from "../../lib/core/broker/send-interaction.ts";

function renderTargetLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) {
    return "";
  }
  if (
    trimmed.startsWith("@")
    || /^(?:ref|session|target|target-handle|target_handle|channel):/i.test(trimmed)
    || /^broadcast$/i.test(trimmed)
  ) {
    return trimmed;
  }
  return `@${trimmed}`;
}

function renderAmbiguousCandidate(label: string): string {
  const rendered = renderTargetLabel(label);
  return rendered || label.trim();
}

export function formatScoutSendRoutingError(
  result: Pick<ScoutMessagePostResult, "targetDiagnostic" | "unresolvedTargets">,
): string {
  const diagnostic = result.targetDiagnostic;
  if (diagnostic?.state === "unknown") {
    return `there is no ${renderTargetLabel(diagnostic.agentId)}; nothing was sent.`;
  }
  if (diagnostic?.state === "ambiguous") {
    const renderedCandidates = diagnostic.candidates
      .map((candidate) => renderAmbiguousCandidate(candidate.label || candidate.agentId))
      .filter((label) => label.length > 0);
    if (renderedCandidates.length > 0) {
      return `target ${renderTargetLabel(result.unresolvedTargets[0] ?? "")} matches multiple agents: ${renderedCandidates.join(", ")}. Re-run with the fully qualified form (e.g. \`scout send --to ${renderedCandidates[0]} "..."\`).`;
    }
    if (diagnostic.detail) {
      return `${diagnostic.detail} Nothing was sent.`;
    }
    return `target ${renderTargetLabel(result.unresolvedTargets[0] ?? "")} matches multiple agents; nothing was sent. Re-run with a fully qualified @handle to disambiguate.`;
  }
  if (diagnostic?.state === "unavailable") {
    const runtime = diagnostic.transport ? ` (${diagnostic.transport})` : "";
    const wakePolicy = diagnostic.wakePolicy ? ` [wake:${diagnostic.wakePolicy}]` : "";
    return `target ${renderTargetLabel(result.unresolvedTargets[0] ?? diagnostic.agentId)} is known but currently unavailable${runtime}${wakePolicy}; nothing was sent. ${diagnostic.detail}`;
  }
  if (diagnostic?.state === "invalid" || diagnostic?.state === "missing") {
    return `${diagnostic.detail}; nothing was sent.`;
  }

  const rendered = result.unresolvedTargets
    .map(renderTargetLabel)
    .filter((label) => label.length > 0);
  if (rendered.length === 1) {
    return `target ${rendered[0]} is not uniquely routable; nothing was sent.`;
  }
  return `targets ${rendered.join(", ")} are not uniquely routable; nothing was sent.`;
}

function formatScoutRouteChoiceError(
  routingError:
    | "missing_destination"
    | "multi_target_requires_explicit_channel",
): string {
  if (routingError === "missing_destination") {
    return "message has no explicit destination; use @agent for a DM, --channel <name> for a group thread, or scout broadcast for channel.shared.";
  }
  return "message targets multiple agents without an explicit channel; send separate DMs, use --channel <name> for a group thread, or use scout broadcast for channel.shared.";
}

export async function runMessageOnlySend(
  context: ScoutCommandContext,
  options: ScoutTellCommandOptions,
  body: string,
): Promise<void> {
  const currentDirectory =
    options.currentDirectory ?? defaultScoutContextDirectory(context);
  const senderId = await resolveScoutSenderId(
    options.agentName,
    currentDirectory,
    context.env,
  );
  const result = await sendScoutMessage({
    senderId,
    body,
    targetLabel: options.targetLabel,
    targetRef: options.targetRef,
    channel: options.channel,
    shouldSpeak: options.shouldSpeak,
    wake: options.wake,
    executionHarness: parseScoutHarness(options.harness),
    currentDirectory: options.currentDirectory,
    aliasScope: options.aliasProject || options.aliasHost ? {
      ...(options.aliasProject ? { projectRoot: options.aliasProject } : {}),
      ...(options.aliasHost ? { nodeId: options.aliasHost } : {}),
    } : undefined,
  });

  if (!result.usedBroker) {
    throw new Error("broker is not reachable");
  }
  if (result.unresolvedTargets.length > 0) {
    throw new Error(formatScoutSendRoutingError(result));
  }
  if (result.routingError) {
    throw new Error(formatScoutRouteChoiceError(result.routingError));
  }

  context.output.writeValue(
    {
      senderId,
      conversationId: result.conversationId,
      messageId: result.messageId,
      message: body,
      bindingRef: result.bindingRef,
      flightId: result.flight?.id,
      invokedTargets: result.invokedTargets,
      unresolvedTargets: result.unresolvedTargets,
      routeKind: result.routeKind,
    },
    renderScoutMessagePostResult,
  );
}

type ScoutTrackedSendResult = {
  senderId: string;
  receipt: ScoutAskReceipt;
  replyMode: "inline" | "notify" | "none";
  flight: ScoutFlightRecord | null;
  waited: boolean;
  timedOut: boolean;
  snapshot: ScoutInvocationSnapshot | null;
  output: string;
};

export function renderTrackedSendReceipt(value: {
  senderId: string;
  receipt: ScoutAskReceipt;
  replyMode: "inline" | "notify" | "none";
  flight: ScoutFlightRecord | null;
}): string {
  const { ids } = value.receipt;
  const pieces = [
    ids.targetAgentId ? `tracked send to ${ids.targetAgentId}` : "tracked send queued",
    ids.flightId ? `flight ${ids.flightId}` : null,
    ids.invocationId ? `invocation ${ids.invocationId}` : null,
    ids.conversationId
      ? ids.conversationId.startsWith("dm.")
        ? `DM ${ids.conversationId}`
        : `conversation ${ids.conversationId}`
      : null,
    ids.bindingRef
      ? ids.bindingRef.startsWith("ref:") ? ids.bindingRef : `ref:${ids.bindingRef}`
      : null,
  ].filter((piece): piece is string => Boolean(piece));
  const dispatch = value.flight ? `Dispatch state: ${value.flight.state}.` : null;
  const notification = value.replyMode === "notify"
    ? `Completion will be reported back to ${value.senderId}; a requested callback is not proof of receipt.`
    : "Completion notifications suppressed; the result stays tracked.";
  const next = ids.invocationId || ids.flightId
    ? `Next: scout wait ${ids.invocationId ?? ids.flightId} --timeout ${DEFAULT_SEND_WAIT_TIMEOUT_SECONDS}`
    : "Follow the receipt handles to continue.";
  return [
    `${pieces.join(" · ")}.`,
    dispatch,
    notification,
    next,
  ].filter((line): line is string => Boolean(line)).join(" ");
}

function renderTrackedSendWaitedResult(value: ScoutTrackedSendResult): string {
  const flight = value.snapshot?.flight ?? value.flight;
  if (flight?.state === "completed") {
    return flight.output ?? flight.summary ?? "";
  }
  const reference = value.receipt.ids.invocationId ?? value.receipt.ids.flightId ?? "";
  const state = flight?.state ?? "pending";
  const detail = flight?.error ?? flight?.summary ?? null;
  return [
    value.timedOut
      ? `wait budget elapsed; the tracked send is still ${state}.`
      : `tracked send is ${state}.`,
    detail,
    reference ? `Next: scout wait ${reference} --timeout ${DEFAULT_SEND_WAIT_TIMEOUT_SECONDS}` : null,
  ].filter((line): line is string => Boolean(line)).join(" ");
}

async function runTrackedSend(
  context: ScoutCommandContext,
  options: ScoutSendCommandOptions,
  body: string,
): Promise<void> {
  const currentDirectory =
    options.currentDirectory ?? defaultScoutContextDirectory(context);
  const senderId = await resolveScoutSenderId(
    options.agentName,
    currentDirectory,
    context.env,
  );
  const replyMode = options.wait
    ? options.noNotifs ? "none" : "inline"
    : options.noNotifs
      ? "none"
      : "notify";

  const callerSessionId = claimedSessionId(context.env);
  const receipt = await scoutAskHandler({
    senderId,
    to: options.targetLabel ?? "",
    body,
    harness: parseScoutHarness(options.harness),
    shouldSpeak: options.shouldSpeak,
    // Preserve the calling session so the completion notification comes back
    // to it rather than to the project's home endpoint.
    replyToSessionId: callerSessionId,
    ...(claimedSessionHarness(callerSessionId, context.env) ? { replyToSessionHarness: claimedSessionHarness(callerSessionId, context.env) } : {}),
    ...(context.env.TRACEPARENT ? { traceparent: context.env.TRACEPARENT } : {}),
    replyMode,
    currentDirectory,
    source: "scout-send",
    aliasScope: options.aliasProject || options.aliasHost ? {
      ...(options.aliasProject ? { projectRoot: options.aliasProject } : {}),
      ...(options.aliasHost ? { nodeId: options.aliasHost } : {}),
    } : undefined,
  });

  if (!receipt.ok || !receipt.ids.flightId) {
    throw new Error(formatScoutAskReceiptError(receipt, options.targetLabel));
  }

  context.stderr(
    `tracked send to ${receipt.ids.targetAgentId ?? options.targetLabel ?? "target"} as ${senderId}... (flight ${receipt.ids.flightId})`,
  );

  const brokerUrl = resolveScoutBrokerUrl();
  const flight = await loadInitialScoutAskFlight(brokerUrl, receipt.ids.flightId)
    .catch(() => null);

  if (!options.wait) {
    context.output.writeValue(
      {
        senderId,
        receipt,
        replyMode,
        flight,
        waited: false,
        timedOut: false,
        snapshot: null,
        output: renderTrackedSendReceipt({ senderId, receipt, replyMode, flight }),
      } satisfies ScoutTrackedSendResult,
      (value) => value.output,
    );
    return;
  }

  const waitReference = receipt.ids.invocationId ?? receipt.ids.flightId;
  let timedOut = false;
  let snapshot: ScoutInvocationSnapshot | null = null;
  try {
    snapshot = await waitForScoutInvocation(brokerUrl, waitReference, {
      timeoutSeconds: options.timeoutSeconds ?? DEFAULT_SEND_WAIT_TIMEOUT_SECONDS,
      onUpdate: (_snapshot, detail) => context.stderr(detail),
    });
  } catch (error) {
    if (
      error instanceof Error
      && error.message.includes("Timed out waiting for invocation")
    ) {
      timedOut = true;
      snapshot = await loadScoutInvocationSnapshot(brokerUrl, waitReference)
        .catch(() => null);
    } else {
      throw error;
    }
  }

  const result: ScoutTrackedSendResult = {
    senderId,
    receipt,
    replyMode,
    flight,
    waited: true,
    timedOut,
    snapshot,
    output: "",
  };
  result.output = renderTrackedSendWaitedResult(result);
  context.output.writeValue(result, (value) => value.output);
}

export async function runSendCommand(
  context: ScoutCommandContext,
  args: string[],
): Promise<void> {
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(renderSendCommandHelp());
    return;
  }

  const options = parseSendCommandOptions(
    args,
    defaultScoutContextDirectory(context),
  );
  const body = await resolveMessageBody(options);

  // Main's contract: a plain send is a message (FYI/update). Tracked work is
  // opt-in via --tracked, and only for a directed single-target send; every
  // reply-shaped or group-shaped route stays message-only so completion
  // replies can never recursively launch work.
  if (!options.tracked) {
    await runMessageOnlySend(context, options, body);
    return;
  }

  const interaction = classifySendInteraction({
    targetLabel: options.targetLabel,
    targetRef: options.targetRef,
    channel: options.channel,
    body,
  });
  if (interaction !== "work") {
    throw new ScoutCliError(
      "--tracked needs exactly one directed --to target; channels, --ref replies, broadcasts, and [ask:...] completion bodies are message-only and never create work. Drop --tracked, or use `scout ask`.",
    );
  }
  await runTrackedSend(context, options, body);
}
