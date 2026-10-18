import { flightSessionTrace } from "@openscout/protocol";
import { randomUUID } from "node:crypto";
import { buildFlightLinks } from "./flight.ts";
import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import {
  parseAskCommandOptions,
  type ScoutAskCommandOptions,
} from "../options.ts";
import { resolvePromptBody } from "../input-file.ts";
import { scoutAskHandler } from "../../core/broker/ask.ts";
import type {
  ScoutAskReceipt,
} from "../../core/broker/ask-types.ts";
import {
  loadScoutFlight,
  parseScoutHarness,
  resolveHumanAskSenderName,
  resolveScoutBrokerUrl,
  resolveScoutSenderId,
  type ScoutAskResult,
  type ScoutFlightRecord,
  waitForScoutFlight,
} from "../../core/broker/service.ts";

const HELP_FLAGS = new Set(["--help", "-h"]);
const DEFAULT_ASK_ACK_TIMEOUT_SECONDS = 30;
const DEFAULT_ASK_DISPATCH_SETTLE_MS = 4_000;

export function renderAskCommandHelp(): string {
  return [
    "Usage: scout ask [(--to <existing-target> | --ref <ref> | --project <path> [--on <host>] | --profile <runtime-profile>)] [--runtime <harness/model/effort>] [--harness <runtime>] [--model <model>] [--effort <level>] [--new] [--placement <background|foreground|attached> | --foreground] [--notify | --reply-mode <inline|notify|none>] [--prompt-file <path> | <message>]",
    "",
    "Ask one agent to do work or return a concrete answer.",
    "Async receipts show the routed target, harness evidence, and a scout wait command (including --notify).",
    "",
    "On another machine (never ssh in to launch an agent; Scout carries the brief, receipt and replies):",
    '  scout ask --on archie --project ~/renders/arsenal-x --harness codex --prompt-file ./brief.md',
    "  --on <host> starts a fresh session in that folder on that machine. The path is the path ON that machine.",
    "  Machines and their projects: scout hosts (MCP: hosts_list).",
    "",
    "First collaboration (replace the project path; keep the returned ref):",
    '  scout ask --project /path/to/repo --harness claude --notify "Review the changes and report back."',
    "  scout status RETURNED_REF --json",
    "  scout wait RETURNED_REF --timeout 30",
    '  scout ask --ref RETURNED_REF "Continue with this correction."',
    "Queued or acknowledged is not completed. A wait timeout does not cancel work; observe the same ref again, do not duplicate the ask.",
    "If acknowledgement is lost, reconcile any returned ids and broker activity before retrying. An unresolved receipt is not proof that nothing ran.",
    "For exact runtimes, inspect executionResolution: requested/resolved show launch intent; observed/drift show harness evidence. Missing observed values remain unknown.",
    "",
    "Operator questions: scout ask --operator --question <text> [--option <choice> ...] [--permission]",
    "",
    "Routing:",
    "  one target + no channel            -> DM",
    "  --channel <name>                   -> named group thread",
    "  --to <name>                        -> existing agent/session target routing",
    "  agent <name> to <request>          -> exact normalized existing handle lookup",
    "  Fable|Kimi|Grok|Opus <request>     -> broker runtime profile; starts a fresh current-project session",
    "  --profile <name> [--effort <level>] -> explicit profile route; effort is supported by Fable/Opus",
    "  --to target:<name> or --to ⌖name    -> saved situated target; continues that worker",
    "  --to session:<id>                  -> continue one exact existing session",
    "  --to alias:<name>                  -> explicit broker route alias; use --alias-project/--alias-host for cross-scope routing",
    "  --project <path>                   -> ask by repo/workspace path; Scout resolves the concrete worker",
    "  --project <path> --on <host>       -> fresh session in that folder on another mesh machine",
    "  --project <path> --harness <rt>     -> capability request; broker chooses/creates worker",
    "  --runtime <harness/model/effort>    -> exact shell-safe runtime; fixed slash positions",
    "  codex/gpt-5.6-sol/xhigh to ...      -> natural RuntimeSpec form for the current project",
    "  --model/--effort                    -> exact dimensions; legal with --harness or as profile overrides",
    "  --harness <runtime> with no target  -> ask a compatible worker for the current project",
    "  '>> project:<path> ...'             -> composer route form for the same project-path ask",
    "",
    "Use ask whenever a reply, judgment, investigation, review, implementation, or owned next step is expected.",
    "If the meaning is \"do this and get back to me,\" use ask. When in doubt, use ask.",
    "Do not use send merely to avoid blocking: `--notify` returns after the broker receipt and reports completion later.",
    "The command creates durable broker work; the target should acknowledge quickly in the same DM or channel.",
    `Default inline mode returns once the target has acknowledged, completed immediately, or stays unacknowledged for ${DEFAULT_ASK_ACK_TIMEOUT_SECONDS}s.`,
    "Use the returned ref/flight id/conversation/session handle for follow-up.",
    "Agent-card targets are fresh-session requests. Use a session id only when you intend to keep exact prior context.",
    "Exact runtime asks use: explicit flag/literal > profile preset > endpoint > harness config > default.",
    "Exact runtime on a named agent spawns an isolated session. An exact session id must already have matching observed runtime evidence.",
    "Bare target priority: profile id, then harness id; model names are never bare agent targets.",
    "Conflicting overlapping runtime values fail; a redundant same-value flag is accepted.",
    "Use --project when you know the project path but do not want to look up or pin an agent id first.",
    "Do not guess generic names like claude.main; let the broker route, then pin/name a good worker later.",
    "Use --harness without a target when the current project should be handled by that runtime.",
    "New sessions default to background. Use --foreground when you want a top-level task in the destination harness UI.",
    "Codex foreground tasks appear in the operator's Codex app; Scout does not open or focus the app.",
    "",
    "Input:",
    "  inline message                    -> primary prompt body",
    "  --prompt-file <path>              -> read the primary prompt body from a UTF-8 file",
    "  --body-file <path>                -> alias for --prompt-file",
    "  --label <label>                   -> attach a durable work label; repeatable",
    "  --notify                          -> asynchronous ask; return now and surface completion later",
    "  --reply-mode <mode>                -> inline (default), notify, or none",
    "  --request-id <id>                  -> reuse a command ID after an uncertain receipt; content must match",
    "  --completion explicit             -> require an explicit final reply (exact local id:<agent> or session:<id> only)",
    "  --join-to <parent-flight-id>       -> join this child to the parent; parent final waits for it to settle",
    "  --continue-for <parent-flight-id>  -> add a continuation obligation; mutually exclusive with --join-to",
    "Explicit completion requires a broker advertising explicit-completion/1. Progress never completes work.",
    "Use MCP current_reply_context for the latest revision, then messages_reply with completion and a stable requestId.",
    "After joined work settles, submit a new final reply. An early final is rejected and is not saved for later.",
    "  --placement <placement>           -> background (default), foreground, or attached (Codex: use the running Codex app-server daemon)",
    "  --foreground                      -> alias for --placement foreground",
    "",
    "Examples:",
    '  scout ask --to hudson "review the parser"',
    '  scout ask agent Composer Review to fix the tests',
    '  scout ask Fable to review the parser',
    '  scout ask Opus high to review the parser',
    '  scout ask --profile kimi "review the parser"',
    '  scout ask --to target:mw-talkie "continue the editorial pass"',
    '  scout ask --to alias:review --alias-project ../talkie --alias-host mini "take another pass"',
    '  scout ask --ref 7f3a9c21 "continue from that result"',
    '  scout ask --project ../talkie "how did you handle auth?"',
    '  scout ask --harness codex "review this from a fresh Codex session"',
    '  scout ask --harness codex --foreground "review this where I can chime in from Codex"',
    '  scout ask --project ../talkie --harness codex --model gpt-5.6-sol --effort xhigh "review auth"',
    '  scout ask codex/gpt-5.6-sol/xhigh to review the diff',
    '  scout ask --project ../talkie --harness claude "review Talkie from Claude"',
    "  scout ask '>> project:../talkie compare auth against this branch'",
    "  scout ask --to hudson --prompt-file ./handoff.md",
    '  scout ask --as premotion.master.mini --to hudson "build the editor"',
    '  scout ask --to hudson --reply-mode notify "take the next pass and report back"',
    '  scout ask --to hudson --no-wait "start the longer implementation"',
    '  scout ask --to hudson --label release:0.2.66 "review the package bump"',
    '  scout ask --to vox.harness:codex "take another pass on the runtime fix"',
    '  scout ask --to lattices#codex?5.5 "take task A"',
    '  scout ask --to lattices#claude?sonnet "take task B"',
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
    ids.flightId ? `flight ${ids.flightId}` : null,
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
  if (args.includes("--operator")) {
    const { runOperatorQuestionCommand } = await import("./operator-question.ts");
    await runOperatorQuestionCommand(context, args.filter(arg => arg !== "--operator"));
    return;
  }
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
  const currentDirectory =
    options.currentDirectory ?? defaultScoutContextDirectory(context);
  const senderId = await resolveScoutSenderId(
    resolveHumanAskSenderName(options.agentName, context.env),
    currentDirectory,
    context.env,
  );
  const body = await resolvePromptBody(options);
  const to = options.targetRef
    ? `ref:${options.targetRef}`
    : options.targetLabel;
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
  const replyMode = options.replyMode ?? "inline";
  const requestId = options.requestId ?? `ask-${randomUUID()}`;
  context.stderr(`request ${requestId} (reuse with --request-id after an uncertain receipt)`);
  const receipt = await scoutAskHandler({
    requestId,
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

  if (!receipt.ok || !receipt.ids.flightId) {
    throw new Error(formatScoutAskReceiptError(
      receipt,
      options.targetLabel
        ?? options.existingTargetHandle
        ?? (options.runtimeProfile ? `profile:${options.runtimeProfile}` : undefined),
    ));
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
