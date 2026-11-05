import type {
  ScoutActivityItem,
  ScoutBrokerMessageRecord,
  ScoutWhoEntry,
} from "../../core/broker/service.ts";
import {
  formatScoutTimestamp,
  normalizeUnixTimestamp,
} from "../../core/broker/view.ts";

export function renderScoutMessage(message: ScoutBrokerMessageRecord): string {
  const timestamp =
    normalizeUnixTimestamp(message.createdAt) ?? Math.floor(Date.now() / 1000);
  const body = message.body;
  const type =
    message.class === "system" || message.class === "status" ? "SYS" : "MSG";
  if (type === "SYS") {
    return `${formatScoutTimestamp(timestamp)} · ${body}`;
  }
  return `${formatScoutTimestamp(timestamp)} ${message.actorId}  ${body}`;
}

export function renderScoutMessageList(messages: ScoutBrokerMessageRecord[]): string {
  if (messages.length === 0) {
    return "No Scout messages yet.";
  }
  return messages.map(renderScoutMessage).join("\n");
}

export function renderScoutAgentList(entries: ScoutWhoEntry[], options: { groupByMachine?: boolean } = {}): string {
  if (entries.length === 0) {
    return options.groupByMachine ? "No agents match the selected machines in this broker snapshot." : "No agents are known to the broker yet.";
  }

  if (options.groupByMachine) {
    const groups = new Map<string | null, ScoutWhoEntry[]>();
    for (const entry of entries) {
      const group = groups.get(entry.nodeId) ?? [];
      group.push(entry);
      groups.set(entry.nodeId, group);
    }
    return [...groups].map(([nodeId, group]) => {
      const name = group[0]?.nodeName;
      const label = name ? `${name} (${nodeId})` : nodeId ?? "unknown machine";
      return `${label}:\n${renderScoutAgentList(group)}`;
    }).join("\n\n");
  }

  return entries
    .map((entry) => {
      const messageLabel =
        entry.messages === 1 ? "1 message" : `${entry.messages} messages`;
      const lastSeenLabel = entry.lastSeen
        ? `last seen ${formatScoutTimestamp(entry.lastSeen)}`
        : "not seen yet";
      const registrationLabel =
        entry.registrationKind === "discovered" ? "auto-discovered" : null;
      const primary = [
        entry.roster ? `${entry.roster.label}  ${entry.agentId}` : entry.agentId,
        `machine ${entry.nodeName ? `${entry.nodeName} (${entry.nodeId})` : entry.nodeId ?? "unknown"}`,
        `project ${entry.projectRoot ?? "unknown"}`,
        entry.state,
        messageLabel,
        lastSeenLabel,
        registrationLabel,
      ]
        .filter(Boolean)
        .join(" · ");
      const aliases = entry.aliases?.length
        ? `\n  Aliases: ${entry.aliases.map((alias) => `${alias.alias} → ${alias.target.kind === "agent" ? alias.target.agentId : `session:${alias.target.sessionId}`} (r${alias.revision})`).join(", ")}`
        : "";
      return `${primary}${aliases}`;
    })
    .join("\n");
}

export function renderScoutMessagePostResult(result: {
  message: string;
  senderId?: string;
  conversationId?: string;
  messageId?: string;
  bindingRef?: string;
  flightId?: string;
  invokedTargets: string[];
  unresolvedTargets: string[];
  routeKind?: "dm" | "channel" | "broadcast";
}): string {
  const sentToScout = result.invokedTargets.some((target) => target === "scout");
  const lines = [sentToScout ? "Sent to Scout." : "Sent."];
  if (result.conversationId) {
    lines.push(`Conversation: ${result.conversationId}`);
  }
  if (result.messageId) {
    lines.push(`Message: ${result.messageId}`);
  }
  if (result.bindingRef) {
    lines.push(`Ref: ref:${result.bindingRef}`);
  }
  if (result.flightId) {
    lines.push(`Delivery flight: ${result.flightId}`);
    lines.push(`Next: scout wait ${result.flightId} --timeout 600`);
  }
  if (result.unresolvedTargets.length > 0) {
    lines.push(`Unresolved: ${result.unresolvedTargets.join(", ")}`);
  }
  return lines.join("\n");
}

export function renderScoutBroadcastResult(result: {
  message: string;
  invokedTargets: string[];
  unresolvedTargets: string[];
  routeKind?: "dm" | "channel" | "broadcast";
}): string {
  const lines = [`Broadcast: ${result.message}`];
  if (result.routeKind) {
    lines.push(`Route: ${result.routeKind}`);
  }
  if (result.invokedTargets.length > 0) {
    lines.push(`Routed to ${result.invokedTargets.length} agents`);
  }
  if (result.unresolvedTargets.length > 0) {
    lines.push(`Unresolved: ${result.unresolvedTargets.join(", ")}`);
  }
  return lines.join("\n");
}

function renderScoutActivityKind(kind: ScoutActivityItem["kind"]): string {
  switch (kind) {
    case "ask_opened":
      return "asked";
    case "ask_working":
      return "working";
    case "ask_replied":
      return "replied";
    case "ask_failed":
      return "failed";
    case "handoff_sent":
      return "handoff";
    case "agent_message":
      return "agent";
    case "status_message":
      return "status";
    case "invocation_recorded":
      return "invoke";
    case "flight_updated":
      return "flight";
    case "collaboration_event":
      return "collab";
    case "message_posted":
    default:
      return "message";
  }
}

function renderScoutActivityParticipants(
  item: ScoutActivityItem,
): string | null {
  const actor = item.actorId?.trim();
  const counterpart = item.counterpartId?.trim();

  if (actor && counterpart && actor !== counterpart) {
    return `${actor} -> ${counterpart}`;
  }
  return actor || counterpart || item.agentId?.trim() || null;
}

export function renderScoutActivityItem(item: ScoutActivityItem): string {
  const timestamp =
    normalizeUnixTimestamp(item.ts) ?? Math.floor(Date.now() / 1000);
  const label = renderScoutActivityKind(item.kind).padEnd(7, " ");
  const participants = renderScoutActivityParticipants(item);
  const title = item.title?.trim() || item.summary?.trim() || item.kind;
  const summary = item.summary?.trim();
  const detail = summary && summary !== title ? summary : null;

  return [
    formatScoutTimestamp(timestamp),
    label,
    participants,
    title,
    detail ? `(${detail})` : null,
  ]
    .filter(Boolean)
    .join("  ");
}

export function renderScoutActivityList(items: ScoutActivityItem[]): string {
  if (items.length === 0) {
    return "No Scout activity yet.";
  }
  return items.map(renderScoutActivityItem).join("\n");
}
