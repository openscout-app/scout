import { flightSessionTrace } from "@openscout/protocol";
import { createHash, randomUUID } from "node:crypto";
import { buildFlightLinks } from "./flight.ts";
import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import {
  parseAskCommandOptions,
  type ScoutAskCommandOptions,
} from "../options.ts";
import { resolvePromptBody } from "../input-file.ts";
import { scoutAskHandler } from "../../lib/core/broker/ask.ts";
import type {
  ScoutAskReceipt,
} from "../../lib/core/broker/ask-types.ts";
import {
  loadScoutFlight,
  parseScoutHarness,
  resolveHumanAskSenderName,
  resolveScoutBrokerUrl,
  resolveScoutSenderId,
  type ScoutAskResult,
  type ScoutFlightRecord,
  waitForScoutFlight,
} from "../../lib/core/broker/service.ts";

const HELP_FLAGS = new Set(["--help", "-h"]);
const DEFAULT_ASK_ACK_TIMEOUT_SECONDS = 30;
const DEFAULT_ASK_DISPATCH_SETTLE_MS = 4_000;

export function renderAskCommandHelp(): string {
  return [
    'Usage: scout ask (--to <agent> | --operator | --channel <name> --fyi | --project <path> | --ref <task> | --continue <task>) [flags] "message"',
    "", "Ask creates a task and returns on acceptance, not completion. Use scout wait <handle> to wait.",
    "  --to <agent>          recipient; repeat for one independent task/receipt per target",
    "  --project <path>      capability route; add --harness, --model, --effort, or --on <host>",
    "  --ref <task>          follow up on unfinished work without creating another task",
    "  --ref <task> --cancel explicitly cancel; receipt reports worker interruption",
    "  --continue <task>     successor to a completed, failed, or cancelled task",
    "  --fyi                 deliberate no-answer message; no task/work record",
    "  --operator            human-owned task; notification always requested",
    "  --option <choice>     operator answer choices; repeatable",
    "  --default-action <X>  proceed with X at the answer deadline unless answered",
    "  --window <seconds>    default-action answer window (default 1800 seconds)",
    "  --permission          blocking permission request; --because explains why",
    "  --notify              operator push only; FYIs otherwise do not push",
    "  --image <path>        attach PNG, JPEG, GIF, or WebP evidence",
    "  --prompt-file <path>  read the message from a UTF-8 file (--body-file also accepted)",
    "  --label <label>      attach a searchable task label; repeatable",
    "  --reply-mode <notify|inline|none>  notify means acceptance, NOT operator push",
    "  --request-id <id>     reuse after an uncertain receipt; do not change content",
    "  --completion explicit require an explicit final reply on an exact local recipient",
    "  --join-to <task>      child of an active explicit-completion task",
    "  --continue-for <task> continuation obligation on an active parent, NOT --continue",
    "  --placement <background|foreground|attached>  new-session placement",
    "  --runtime <harness/model/effort> or --profile <name>  runtime selection",
    "Unknown flags are errors. Routing modes cannot be combined. Message text never cancels work.",
    "An automatic final turn still answers the task; do not also call reply.",
    "", "Examples:",
    '  scout ask --to reviewer "review the parser"',
    '  scout ask --project ../app --harness codex "run the suite"',
    '  scout ask --ref inv-123 "scope change: skip the tests"',
    '  scout ask --continue inv-123 "port the fix"',
    '  scout ask --operator --option yes --option no "Ship to production?"',
    '  scout ask --operator --fyi --notify "Production is down" --image ./graph.png',
    '  scout ask --channel shared --fyi "Deploy done"',
    '  scout reply --ref inv-123 "Two findings, one blocking"',
  ].join("\n");
}

export function renderScoutAskReceipt(value: {
  receipt: ScoutAskReceipt;
  replyMode: NonNullable<ScoutAskCommandOptions["replyMode"]>;
  flight?: ScoutFlightRecord | null;
  links?: ReturnType<typeof buildFlightLinks>;
  /** The machine named with `--on`, said first so the asker sees where the work landed. */
  onHost?: string;
}): string {
  const { ids } = value.receipt;
  const bindingRef = renderBindingRef(ids.bindingRef);
  const pieces = [
    value.onHost ? `On ${value.onHost}` : null,
    ids.targetAgentId ? `${value.onHost ? "routed" : "Routed"} to ${ids.targetAgentId}` : value.onHost ? "ask queued" : "Ask queued",
    renderScoutAskHarness(value.receipt, value.flight),
    bindingRef,
    ids.flightId ? `task ${ids.invocationId ?? ids.flightId}` : null,
    ids.conversationId ? renderConversationRoute(ids.conversationId) : null,
    ids.sessionAlias ? `alias ${ids.sessionAlias}` : null,
  ].filter((piece): piece is string => Boolean(piece));
  const waitRef = bindingRef ?? ids.invocationId ?? ids.flightId;
  const delivery = renderScoutAskDeliveryStatus(value.flight);
  const terminal = value.flight && ["completed", "failed", "cancelled"].includes(value.flight.state);
  return [
    `${pieces.join(" · ")}.`,
    delivery,
    value.replyMode === "notify" && !terminal ? "Scout will surface the completion when it arrives." : null,
    value.links?.work ? `Follow the task: ${value.links.work}` : null,
    waitRef ? `Follow: scout wait ${quoteWaitReference(waitRef)} --timeout 600` : "No wait reference returned; inspect the ask receipt.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function renderScoutAskHarness(receipt: ScoutAskReceipt, flight?: ScoutFlightRecord | null): string {
  const trace = flightSessionTrace(flight).at(-1);
  // A receipt may describe an earlier session. Do not carry its observed
  // harness across a newer dispatch without matching session identity.
  const receiptResolution = receipt.executionResolution;
  const resolution = trace
    ? trace.executionResolution ?? (receiptResolution?.sessionId === trace.sessionId ? receiptResolution : undefined)
    : receiptResolution;
  const harness = resolution?.harness;
  const name = harness?.observed ?? trace?.harness ?? harness?.resolved ?? harness?.requested;
  if (!name) return "harness unconfirmed";
  const evidence = harness?.observed ? "observed" : trace?.harness ? "dispatched" : harness?.resolved ? "selected" : "requested; unconfirmed";
  const differences = [
    harness?.requested && harness.requested !== name ? `requested ${harness.requested}` : null,
    harness?.resolved && harness.resolved !== name && harness.resolved !== harness.requested ? `selected ${harness.resolved}` : null,
  ].filter(Boolean);
  return `harness ${name} (${[evidence, ...differences].join("; ")})`;
}

function quoteWaitReference(ref: string): string {
  return /^[a-zA-Z0-9_.:-]+$/.test(ref) ? ref : "'" + ref.replace(/'/g, "'\\''") + "'";
}

function renderScoutAskDeliveryStatus(
  flight?: ScoutFlightRecord | null,
): string | null {
  if (!flight) {
    return null;
  }

  const detail = flight.error ?? flight.summary ?? flight.output;
  const renderedDetail = detail ? ` ${detail}` : "";
  if (flight.state === "running" || flight.state === "waiting") {
    return `Dispatch acknowledged:${renderedDetail}`;
  }
  if (flight.state === "completed") {
    return `Completed:${renderedDetail}`;
  }
  if (flight.state === "failed" || flight.state === "cancelled") {
    return `Dispatch ${flight.state}:${renderedDetail}`;
  }
  if (flight.state === "queued" && isStoredUntilOnlineFlight(flight)) {
    return `Queued until target is online:${renderedDetail}`;
  }
  if (flight.state === "queued" || flight.state === "waking") {
    return `Dispatch ${flight.state}:${renderedDetail}`;
  }
  return `Dispatch state ${flight.state}:${renderedDetail}`;
}

function renderScoutTargetLabel(targetLabel: string): string {
  const trimmed = targetLabel.trim();
  if (
    trimmed.startsWith("@")
    || /^(?:ref|session|target|target-handle|target_handle|channel):/i.test(trimmed)
    || /^broadcast$/i.test(trimmed)
  ) {
    return trimmed;
  }
  return `@${trimmed}`;
}

function renderScoutUpCommand(projectRoot: string): string {
  return `scout up "${projectRoot}"`;
}

function renderAmbiguousCandidate(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function renderConversationRoute(conversationId?: string): string {
  if (!conversationId) {
    return "conversation";
  }
  return conversationId.startsWith("dm.")
    ? `DM ${conversationId}`
    : `conversation ${conversationId}`;
}

function waitReferenceForFlight(flight: ScoutFlightRecord): string {
  return flight.invocationId || flight.id;
}

function isStoredUntilOnlineFlight(flight: ScoutFlightRecord): boolean {
  const dispatchOutcome = flight.metadata?.dispatchOutcome;
  if (
    dispatchOutcome
    && typeof dispatchOutcome === "object"
    && !Array.isArray(dispatchOutcome)
    && (dispatchOutcome as { status?: unknown }).status === "queued_until_online"
  ) {
    return true;
  }
  return /will deliver when online|message stored/i.test(flight.summary ?? "");
}

function isSettledInitialDispatchFlight(flight: ScoutFlightRecord): boolean {
  if (flight.state === "running"
    || flight.state === "waiting"
    || flight.state === "completed"
    || flight.state === "failed"
    || flight.state === "cancelled") {
    return true;
  }
  return flight.state === "queued";
}

export async function loadInitialScoutAskFlight(
  brokerUrl: string,
  flightId: string,
  timeoutMs = DEFAULT_ASK_DISPATCH_SETTLE_MS,
): Promise<ScoutFlightRecord | null> {
  const deadline = Date.now() + timeoutMs;
  let latest: ScoutFlightRecord | null = null;
  while (Date.now() < deadline) {
    latest = await loadScoutFlight(brokerUrl, flightId);
    if (!latest || isSettledInitialDispatchFlight(latest)) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return latest ?? await loadScoutFlight(brokerUrl, flightId);
}

function renderBindingRef(bindingRef?: string | null): string | null {
  if (!bindingRef) {
    return null;
  }
  return bindingRef.startsWith("ref:") ? bindingRef : `ref:${bindingRef}`;
}

export function formatScoutAskReceiptError(
  receipt: ScoutAskReceipt,
  targetLabel: string | undefined,
): string {
  const renderedTarget = targetLabel
    ? renderScoutTargetLabel(targetLabel)
    : "the requested project";
  if (receipt.state === "ambiguous") {
    return receipt.next?.reason
      ? `${receipt.next.reason} Nothing was sent.`
      : `target ${renderedTarget} matches multiple agents; nothing was sent. Re-run with a fully qualified @handle or exact session:<id> to disambiguate.`;
  }
  if (receipt.error) {
    return receipt.error.message;
  }
  if (receipt.next) {
    return `target ${renderedTarget} is not currently routable; nothing was sent. ${receipt.next.reason}`;
  }
  return `target ${renderedTarget} is not currently routable; nothing was sent.`;
}

export function formatScoutAskRoutingError(
  result: Pick<ScoutAskResult, "targetDiagnostic">,
  targetLabel: string,
): string {
  const renderedTarget = renderScoutTargetLabel(targetLabel);
  const diagnostic = result.targetDiagnostic;

  if (diagnostic?.state === "ambiguous") {
    const rendered = diagnostic.candidates
      .map((candidate) =>
        renderAmbiguousCandidate(candidate.label || candidate.agentId),
      )
      .filter((label) => label.length > 0);
    if (rendered.length > 0) {
      return `target ${renderedTarget} matches multiple agents: ${rendered.join(", ")}. Re-run with the fully qualified form (e.g. \`scout ask --to ${rendered[0].replace(/^@/, "")} ...\`).`;
    }
    if (diagnostic.detail) {
      return `${diagnostic.detail} Nothing was sent.`;
    }
    return `target ${renderedTarget} matches multiple agents; nothing was sent. Re-run with a fully qualified @handle to disambiguate.`;
  }

  if (diagnostic?.state === "discovered") {
    if (diagnostic.projectRoot) {
      return `target ${renderedTarget} is discovered but not online yet; nothing was sent. Start it with \`${renderScoutUpCommand(diagnostic.projectRoot)}\` or wait for it to come online.`;
    }
    return `target ${renderedTarget} is discovered but not online yet; nothing was sent. Run \`scout who\` to inspect the target, then start its project before retrying.`;
  }

  if (diagnostic?.state === "offline") {
    if (diagnostic.projectRoot) {
      return `target ${renderedTarget} is offline; nothing was sent. Start it with \`${renderScoutUpCommand(diagnostic.projectRoot)}\` or bring it back online before retrying.`;
    }
    return `target ${renderedTarget} is offline; nothing was sent. Run \`scout who\` to inspect the target before retrying.`;
  }

  if (diagnostic?.state === "unavailable") {
    const runtime = diagnostic.transport ? ` (${diagnostic.transport})` : "";
    const wakePolicy = diagnostic.wakePolicy ? ` [wake:${diagnostic.wakePolicy}]` : "";
    return `target ${renderedTarget} is known but currently unavailable${runtime}${wakePolicy}; nothing was sent. ${diagnostic.detail}`;
  }

  if (diagnostic?.state === "unknown") {
    return `there is no ${renderedTarget}; nothing was sent.`;
  }

  if (diagnostic?.state === "invalid" || diagnostic?.state === "missing") {
    return `${diagnostic.detail}; nothing was sent.`;
  }

  return `target ${renderedTarget} is not currently routable; nothing was sent.`;
}

export async function runAskCommand(
  context: ScoutCommandContext,
  args: string[],
): Promise<void> {
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(renderAskCommandHelp());
    return;
  }

  const options = parseAskCommandOptions(
    args,
    defaultScoutContextDirectory(context),
  );
  await runAskWithOptions(context, options);
}

export async function runAskWithOptions(
  context: ScoutCommandContext,
  options: ScoutAskCommandOptions,
): Promise<void> {
  if ((options.targets?.length ?? 0) > 1) {
    const requestId = options.requestId ?? `ask-${randomUUID()}`;
    const results: Array<{ target: string; accepted: boolean; receipt?: unknown; error?: string }> = [];
    for (const target of [...new Set(options.targets)]) {
      let receipt: unknown;
      try {
        await runAskWithOptions({ ...context, output: { ...context.output,
          writeValue: (value: unknown) => { receipt = value; }, writeText: () => {} } }, {
          ...options, targets: undefined, targetLabel: target,
          requestId: `ask-${createHash("sha256").update(JSON.stringify([requestId, target])).digest("hex")}`,
        });
        results.push({ target, accepted: true, receipt });
      } catch (error) { results.push({ target, accepted: false, error: error instanceof Error ? error.message : String(error) }); }
    }
    context.output.writeValue({ requestId, results }, value => value.results.map(result => `${result.target}: ${result.accepted ? "task accepted" : result.error}`).join("\n"));
    if (results.some(result => !result.accepted)) throw new Error("Some targets rejected the ask; inspect per-target receipts. Do not retry accepted targets with a new request ID.");
    return;
  }
  const currentDirectory =
    options.currentDirectory ?? defaultScoutContextDirectory(context);
  const senderId = await resolveScoutSenderId(
    resolveHumanAskSenderName(options.agentName, context.env),
    currentDirectory,
    context.env,
  );
  const body = await resolvePromptBody(options);
  const to = options.targetLabel;
  const target:
    | { to: string; projectPath?: never; runtimeProfile?: never; existingHandle?: never }
    | { to?: never; projectPath: string; runtimeProfile?: never; existingHandle?: never }
    | { to?: never; projectPath?: string; runtimeProfile: string; existingHandle?: never }
    | { to?: never; projectPath?: never; runtimeProfile?: never; existingHandle: string } =
    options.runtimeProfile
      ? {
          runtimeProfile: options.runtimeProfile,
          ...(options.projectPath ? { projectPath: options.projectPath } : {}),
        }
      : options.existingTargetHandle
      ? { existingHandle: options.existingTargetHandle }
      : options.projectPath
      ? { projectPath: options.projectPath }
      : { to: to ?? "" };
  const replyMode = options.replyMode ?? "notify";
  const requestId = options.requestId ?? `ask-${randomUUID()}`;
  context.stderr(`request ${requestId} (reuse with --request-id after an uncertain receipt)`);
  const receipt = await scoutAskHandler({
    requestId,
    task: options.task ?? { version: 1 },
    ...(options.image ? { image: await (await import("../task-image.ts")).readTaskImage(options.image) } : {}),
    completion: options.completion,
    relation: options.relation,
    senderId,
    senderResolution: options.agentName?.trim() && options.agentName.trim() !== "operator" ? "legacy" : "exact",
    ...target,
    body,
    channel: options.channel,
    harness: parseScoutHarness(options.harness),
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    placement: options.placement,
    runtimeLiteral: options.runtimeLiteral,
    executionSource: options.executionSource,
    session: options.session,
    labels: options.labels,
    // The project agent's home endpoint can belong to a different harness.
    // Preserve the calling session instead of letting that endpoint answer for it.
    replyToSessionId: context.env.OPENSCOUT_SESSION_ID?.trim()
      || context.env.CODEX_THREAD_ID?.trim()
      || context.env.OPENSCOUT_CODEX_THREAD_ID?.trim()
      || context.env.CLAUDE_CODE_SESSION_ID?.trim()
      || context.env.CLAUDE_SESSION_ID?.trim()
      || context.env.CLAUDE_CODE_REMOTE_SESSION_ID?.trim()
      || undefined,
    replyMode,
    currentDirectory,
    source: "scout-cli",
    ...(options.onHost ? { host: options.onHost } : {}),
    aliasScope: options.aliasProject || options.aliasHost ? {
      ...(options.aliasProject ? { projectRoot: options.aliasProject } : {}),
      ...(options.aliasHost ? { nodeId: options.aliasHost } : {}),
    } : undefined,
  });

  if (!receipt.ok) {
    throw new Error(formatScoutAskReceiptError(
      receipt,
      options.targetLabel
        ?? options.existingTargetHandle
        ?? (options.runtimeProfile ? `profile:${options.runtimeProfile}` : undefined),
    ));
  }

  if (options.task?.fyi) {
    context.output.writeValue({ requestId, senderId, receipt }, value => `FYI recorded: ${value.receipt.ids.messageId}. No task was created.`);
    return;
  }

  if (options.task?.ref) {
    context.output.writeValue({ requestId, senderId, receipt }, value => options.task?.cancel
      ? `Task cancelled. Worker interrupted: ${value.receipt.workerInterrupted === true ? "yes" : "no"}.`
      : `Follow-up accepted for task ${value.receipt.ids.invocationId ?? options.task?.ref}.`);
    return;
  }
  context.stderr(
    `asking ${receipt.ids.targetAgentId ?? options.targetLabel ?? options.existingTargetHandle ?? options.runtimeProfile ?? (options.onHost && options.projectPath ? `${options.projectPath} on ${options.onHost}` : options.projectPath) ?? "target"} as ${senderId} via ${renderConversationRoute(receipt.ids.conversationId)}... (flight ${receipt.ids.flightId})`,
  );

  if (replyMode !== "inline") {
    // Notify returns the canonical durable receipt. Native startup and its
    // first status transition are observed through the returned handle.
    const flight = replyMode !== "notify" && receipt.ids.flightId
      ? await loadInitialScoutAskFlight(resolveScoutBrokerUrl(), receipt.ids.flightId)
        .catch(() => null)
      : null;
    context.output.writeValue(
      {
        requestId,
        senderId,
        conversationId: receipt.ids.conversationId ?? null,
        messageId: receipt.ids.messageId ?? null,
        bindingRef: renderBindingRef(receipt.ids.bindingRef),
        receipt,
        replyMode,
        flight,
        links: buildFlightLinks(receipt.ids, context.env),
        ...(options.onHost ? { onHost: options.onHost } : {}),
      },
      renderScoutAskReceipt,
    );
    return;
  }

  if (!receipt.ids.flightId) throw new Error("Accepted task returned no task handle; inspect the receipt before retrying.");
  const brokerUrl = resolveScoutBrokerUrl();
  let completed: ScoutFlightRecord;
  let timedOut = false;
  try {
    completed = await waitForScoutFlight(
      brokerUrl,
      receipt.ids.flightId,
      {
        timeoutSeconds: options.timeoutSeconds ?? DEFAULT_ASK_ACK_TIMEOUT_SECONDS,
        waitUntil: "acknowledged",
        onUpdate: (_flight, detail) => context.stderr(detail),
      },
    );
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Timed out waiting for flight")) {
      throw error;
    }
    timedOut = true;
    completed = await loadScoutFlight(brokerUrl, receipt.ids.flightId) ?? {
      id: receipt.ids.flightId,
      invocationId: receipt.ids.invocationId ?? receipt.ids.flightId,
      requesterId: senderId,
      targetAgentId: receipt.ids.targetAgentId ?? options.targetLabel ?? options.existingTargetHandle ?? options.runtimeProfile ?? (options.onHost && options.projectPath ? `${options.projectPath} on ${options.onHost}` : options.projectPath) ?? "target",
      state: "queued",
    };
  }

  context.output.writeValue(
    {
      senderId,
      conversationId: receipt.ids.conversationId ?? null,
      messageId: receipt.ids.messageId ?? null,
      bindingRef: renderBindingRef(receipt.ids.bindingRef),
      receipt,
      flight: completed,
      links: buildFlightLinks(receipt.ids, context.env),
      output: renderScoutAskInlineResult({
        conversationId: receipt.ids.conversationId ?? null,
        messageId: receipt.ids.messageId ?? null,
        bindingRef: renderBindingRef(receipt.ids.bindingRef),
        sessionAlias: receipt.ids.sessionAlias ?? null,
        flight: completed,
        timedOut,
      }),
    },
    (value) => [value.output, value.links.work ? `Follow the task: ${value.links.work}` : null].filter(Boolean).join("\n"),
  );
}

function renderScoutAskInlineResult(value: {
  conversationId?: string | null;
  messageId?: string | null;
  bindingRef?: string | null;
  sessionAlias?: string | null;
  flight: ScoutFlightRecord;
  timedOut?: boolean;
}): string {
  if (value.flight.state === "completed") {
    return value.flight.output ?? value.flight.summary ?? "";
  }

  const pieces = [
    value.timedOut
      ? `not yet acknowledged ${value.flight.targetAgentId}`
      : `acknowledged ${value.flight.targetAgentId}`,
    `state ${value.flight.state}`,
    `flight ${value.flight.id}`,
    value.conversationId ? renderConversationRoute(value.conversationId) : null,
    value.sessionAlias ? `alias ${value.sessionAlias}` : null,
    value.bindingRef,
  ].filter((piece): piece is string => Boolean(piece));
  return `${pieces.join(" · ")}. Next: scout wait ${waitReferenceForFlight(value.flight)} --timeout 600.`;
}
