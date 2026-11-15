import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { readScoutBrokerSnapshotResult, resolveScoutSenderId, type ScoutBrokerSnapshot } from "../../lib/core/broker/service.ts";
import { deriveOpenScoutInstanceLayout } from "@openscout/runtime/instance";
import { resolveBrokerControlUrl } from "@openscout/runtime/local-config";

export type StatusOptions = {
  help: boolean;
  all: boolean;
  overview?: boolean;
  ref?: string;
  state?: "blocked" | "failed";
  nextActor?: string;
};

export type WorkStatus = {
  id: string;
  kind: "flight" | "invocation" | "work_item" | "question" | "operator_question";
  state: string;
  blocked: boolean;
  summary: string;
  reason: string | null;
  answer?: string;
  assignee?: { harness: string; model: string | null; cwd: string | null; pid: number | null; sessionId: string | null };
  nextActor: string | null;
  agentId: string | null;
  updatedAt: number | null;
  conversationId: string | null;
  handles: string[];
  nextAction: string | null;
};

export function renderStatusCommandHelp(): string {
  return [
    "Usage: scout status [--json]",
    "       scout status <handle> [--json]",
    "       scout status --all [--blocked | --failed] [--next-actor operator|self|<actor-id>] [--json]",
    "",
    "Without a handle, show local orientation and useful next commands.",
    "With a handle or --all, inspect work without waiting or changing its state.",
    "Handles: flight, invocation, work item, question, message, or ref:<binding>.",
    "--all includes all work in this broker's snapshot, not a live poll of every machine.",
    "--blocked uses explicit waiting states and unanswered questions, never inactivity or message keywords.",
    "Unknown next actors stay unknown. No age cutoff is applied to unresolved work.",
    "Native harness prompts are included only when captured in these broker records.",
    "",
    "Examples:",
    "  scout status ref:7f3a9c21",
    "  scout status --all --blocked",
    "  scout status --all --blocked --next-actor operator --json",
  ].join("\n");
}

export function parseStatusCommandOptions(args: string[]): StatusOptions {
  const result: StatusOptions = { help: false, all: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") return { ...result, help: true };
    if (arg === "--json") continue;
    if (arg === "--all") { result.all = true; continue; }
    if (arg === "--blocked" || arg === "--failed") {
      if (result.state) throw new ScoutCliError("choose only one of --blocked and --failed");
      result.state = arg === "--blocked" ? "blocked" : "failed";
      continue;
    }
    if (arg === "--next-actor") {
      const value = args[++i]?.trim();
      if (!value || value.startsWith("-")) throw new ScoutCliError("--next-actor requires operator, self, or an actor id");
      result.nextActor = value;
      continue;
    }
    if (arg.startsWith("-")) throw new ScoutCliError(`unknown status option: ${arg}`);
    if (result.ref) throw new ScoutCliError("status accepts one handle; use --all for an overview");
    result.ref = arg;
  }
  if (result.ref && result.all) throw new ScoutCliError("choose a handle or --all, not both");
  if (!result.ref && !result.all) {
    if (result.state || result.nextActor) throw new ScoutCliError("status filters require --all or a handle");
    result.overview = true;
  }
  return result;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Only broker-owned lifecycle evidence determines state; text is descriptive. */
export function buildWorkStatuses(snapshot: ScoutBrokerSnapshot): WorkStatus[] {
  const rows: WorkStatus[] = [];
  for (const record of Object.values(snapshot.collaborationRecords ?? {})) {
    const blocked = record.state === "waiting" || record.state === "review"
      || (record.kind === "question" && record.state === "open");
    const waiting = record.kind === "work_item" ? record.waitingOn : undefined;
    rows.push({
      id: record.id, kind: record.kind, state: record.state, blocked,
      summary: record.title,
      ...(record.kind === "question" && record.answer ? { answer: record.answer } : {}),
      reason: blocked ? waiting?.label || record.summary || record.title : null,
      nextActor: record.nextMoveOwnerId ?? (waiting?.kind === "actor" ? waiting.targetId : null) ?? null,
      agentId: record.ownerId ?? record.createdById,
      updatedAt: record.updatedAt, conversationId: record.conversationId ?? null,
      handles: [record.id],
      nextAction: blocked ? (record.kind === "question" ? "Answer the existing question." : "Resolve the recorded dependency, then continue this work.") : null,
    });
  }
  const flown = new Set<string>();
  for (const flight of Object.values(snapshot.flights ?? {})) {
    flown.add(flight.invocationId);
    const invocation = snapshot.invocations?.[flight.invocationId];
    const linked = invocation?.collaborationRecordId ? snapshot.collaborationRecords?.[invocation.collaborationRecordId] : undefined;
    const blocked = flight.state === "waiting";
    const endpoints = Object.values(snapshot.endpoints ?? {}).filter(endpoint => endpoint.agentId === flight.targetAgentId);
    const ack = flight.metadata?.dispatchAck as Record<string, unknown> | undefined;
    const sessionId = text(ack?.sessionId) ?? invocation?.execution?.targetSessionId;
    const endpointId = text(ack?.endpointId);
    const endpoint = (endpointId ? endpoints.find(endpoint => endpoint.id === endpointId) : undefined)
      ?? (sessionId ? endpoints.find(endpoint => endpoint.sessionId === sessionId) : undefined)
      ?? (endpoints.length === 1 ? endpoints[0] : undefined);
    const replyId = text(flight.metadata?.replyMessageId);
    const answer = flight.output ?? (replyId ? snapshot.messages?.[replyId]?.body : undefined);
    rows.push({
      id: flight.id, kind: "flight", state: flight.state, blocked,
      summary: invocation?.task || flight.summary || flight.id,
      reason: flight.error || (blocked ? flight.summary || null : null),
      nextActor: text(flight.metadata?.nextMoveOwnerId) ?? (blocked ? linked?.nextMoveOwnerId ?? null : null),
      agentId: flight.targetAgentId,
      ...(answer ? { answer } : {}),
      ...(endpoint ? { assignee: {
        harness: endpoint.harness, model: text(endpoint.metadata?.model),
        cwd: endpoint.cwd ?? endpoint.projectRoot ?? null,
        pid: typeof endpoint.metadata?.pid === "number" ? endpoint.metadata.pid : null,
        sessionId: endpoint.sessionId ?? null,
      } } : {}),
      updatedAt: flight.completedAt ?? flight.startedAt ?? invocation?.createdAt ?? null,
      conversationId: invocation?.conversationId ?? null,
      handles: [flight.id, flight.invocationId, invocation?.messageId, text(flight.metadata?.bindingRef), flight.id.slice(-8)].filter((v): v is string => Boolean(v)),
      nextAction: blocked ? "Inspect the recorded blocker and continue the existing session when resolved." : null,
    });
  }
  for (const invocation of Object.values(snapshot.invocations ?? {})) {
    if (flown.has(invocation.id)) continue;
    rows.push({
      id: invocation.id, kind: "invocation", state: "recorded", blocked: false,
      summary: invocation.task, reason: null, nextActor: null, agentId: invocation.targetAgentId,
      updatedAt: invocation.createdAt, conversationId: invocation.conversationId ?? null,
      handles: [invocation.id, ...(invocation.messageId ? [invocation.messageId] : [])], nextAction: null,
    });
  }
  const messages = Object.values(snapshot.messages ?? {});
  for (const message of messages) {
    const value = message.metadata?.operatorSignal;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const signal = value as Record<string, unknown>;
    if (signal.kind !== "need") continue;
    // Only an explicit operator reply to this message resolves this question.
    const reply = messages.find(candidate => candidate.actorId === "operator"
      && candidate.conversationId === message.conversationId && candidate.replyToMessageId === message.id);
    rows.push({
      id: message.id, kind: "operator_question", state: reply ? "answered" : "open", blocked: !reply,
      summary: text(signal.question) ?? message.body,
      ...(reply ? { answer: reply.body } : {}),
      reason: reply ? null : text(signal.blockedReason) ?? text(signal.question) ?? message.body,
      nextActor: reply ? message.actorId : "operator", agentId: message.actorId,
      updatedAt: reply?.createdAt ?? message.createdAt, conversationId: message.conversationId,
      handles: [message.id], nextAction: reply ? "Read the operator reply and continue." : "Reply to this message in its conversation.",
    });
  }
  return rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id));
}

export function selectWorkStatuses(rows: WorkStatus[], options: StatusOptions): WorkStatus[] {
  let selected = rows;
  if (options.ref) {
    const ref = options.ref.replace(/^ref:/, "");
    const exact = rows.filter(row => row.id === ref);
    selected = exact.length ? exact : rows.filter(row => row.handles.includes(ref));
    if (!selected.length && ref.startsWith("session-")) {
      // A harness session handle: the task it is running now, else the last one it ran (rows are newest first).
      const ran = rows.filter(row => row.kind === "flight" && (row.agentId === ref || row.assignee?.sessionId === ref));
      const current = ran.find(row => !["completed", "failed", "cancelled"].includes(row.state)) ?? ran[0];
      selected = current ? [current] : [];
    }
    if (!selected.length) throw new ScoutCliError(`no work found for ${options.ref} in this broker snapshot`);
    if (selected.length > 1) throw new ScoutCliError(`ambiguous status handle ${options.ref}: ${selected.map(row => row.id).join(", ")}`);
  }
  return selected.filter(row => (!options.state || (options.state === "blocked" ? row.blocked : row.state === "failed"))
    && (!options.nextActor || row.nextActor === options.nextActor));
}

/** Which OpenScout instance (OPENSCOUT_INSTANCE / --instance) and broker this CLI is talking to. */
function currentInstanceSummary(): { name: string; brokerUrl: string; root: string | null } {
  const layout = deriveOpenScoutInstanceLayout();
  return { name: layout.name, brokerUrl: resolveBrokerControlUrl(), root: layout.root };
}

function renderInstanceLine(instance: { name: string; brokerUrl: string }): string {
  return `Instance: ${instance.name} (broker ${instance.brokerUrl})`;
}

export async function runStatusCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const options = parseStatusCommandOptions(args);
  if (options.help) { context.output.writeText(renderStatusCommandHelp()); return; }
  if (options.overview) {
    const value = {
      scope: "orientation", instance: currentInstanceSummary(), currentDirectory: defaultScoutContextDirectory(context),
      health: "not_checked",
      commands: { health: "scout doctor", agents: "scout who", work: "scout status --all", blocked: "scout status --all --blocked" },
    };
    context.output.writeValue(value, row => [
      "Scout status", renderInstanceLine(row.instance), `Project context: ${row.currentDirectory}`,
      "Health has not been checked. Run scout doctor for a live assessment.",
      "Agents: scout who", "Work: scout status <handle> or scout status --all",
      "Needs attention: scout status --all --blocked",
    ].join("\n"));
    return;
  }
  if (options.nextActor === "self") {
    options.nextActor = await resolveScoutSenderId(undefined, defaultScoutContextDirectory(context), context.env);
  }
  const snapshotResult = await readScoutBrokerSnapshotResult();
  if (!snapshotResult.ok) throw new ScoutCliError(`broker snapshot unavailable — /v1/snapshot read failed: ${snapshotResult.detail}; work status is unknown (not an empty result)`);
  const snapshot = snapshotResult.snapshot;
  const work = selectWorkStatuses(buildWorkStatuses(snapshot), options);
  const result = {
    scope: "broker_snapshot", instance: currentInstanceSummary(), liveRemotePoll: false,
    coverage: "Broker-owned work only; native prompts must be captured. Remote machines are not polled.",
    work,
  };
  context.output.writeValue(result, value => [
    renderInstanceLine(value.instance),
    "Scope: this broker's snapshot; remote machines are not polled.",
    ...(value.work.length ? value.work.map(row => [
      `${row.id} · ${row.kind} · ${row.blocked ? "blocked" : row.state} (${row.state})`,
      `  ${row.summary.replace(/\s+/g, " ")}`,
      `  Assignee: ${row.agentId ?? "unknown"}`,
      ...(row.assignee ? [`  Runtime: ${row.assignee.harness} · model: ${row.assignee.model ?? "unknown"} · cwd: ${row.assignee.cwd ?? "unknown"} · pid: ${row.assignee.pid ?? "unknown"}`] : []),
      `  Next actor: ${row.nextActor ?? "unknown"}`,
      ...(row.answer ? [`  Answer: ${row.answer.replace(/\s+/g, " ")}`] : []),
      ...(row.reason ? [`  Reason: ${row.reason.replace(/\s+/g, " ")}`] : []),
      ...(row.nextAction ? [`  Next: ${row.nextAction}`] : []),
    ].join("\n")) : ["No matching work in this snapshot."]),
  ].join("\n"));
}
