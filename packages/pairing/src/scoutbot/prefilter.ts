import type {
  ScoutBrokerAgentRecord,
  ScoutBrokerEndpointRecord,
  ScoutBrokerFlightRecord,
  ScoutBrokerMessageRecord,
  ScoutBrokerSnapshot,
} from "../core/broker/service.ts";
import {
  parseScoutbotDirectives,
  scoutbotDirectiveMetadata,
  type ScoutbotDirectiveParseResult,
} from "./directives.ts";
import { SCOUTBOT_AGENT_ID } from "@openscout/runtime/harnesses";
import { queryFlightRecordById } from "../db-queries.ts";

export type ScoutbotBrokerSnapshot = ScoutBrokerSnapshot & {
  endpoints?: Record<string, ScoutBrokerEndpointRecord>;
  flights?: Record<string, ScoutBrokerFlightRecord>;
  messages?: Record<string, ScoutBrokerMessageRecord>;
};

export type ScoutbotPrefilterReply = {
  body: string;
  metadata: {
    matched_rule: string;
    snapshot_at: number;
    [key: string]: string | number;
  };
};

/** Work-first row used by /status, /recent, /agents — mirrors HUD FOCUS framing. */
type WorkRow = {
  id: string;
  title: string;
  agent: string;
  project: string;
  ago: string;
  lane: "on-you" | "recent";
  live: boolean;
};

export function prefilterHandle(
  prompt: string,
  brokerSnapshot: ScoutbotBrokerSnapshot,
  now = Date.now(),
): ScoutbotPrefilterReply | null {
  const parsed = parseScoutbotDirectives(prompt);
  const normalized = parsed.body.trim();
  if (!normalized && !parsed.command) return null;

  if (parsed.command) {
    const arg = parsed.command.args;
    switch (parsed.command.name) {
      case "report":
      case "feedback":
        return reply(`slash.${parsed.command.name}`, now, "Preparing report…", parsed);
      case "help":
        return reply("slash.help", now, renderHelp(), parsed);
      case "agents":
        return reply("slash.agents", now, renderAgents(brokerSnapshot, now), parsed);
      case "status":
        return reply("slash.status", now, renderStatus(brokerSnapshot, arg, now), parsed);
      case "recent":
        return reply("slash.recent", now, renderRecent(brokerSnapshot, arg, 8, now), parsed);
      case "doing":
        return reply("slash.doing", now, renderDoing(brokerSnapshot, arg, now), parsed);
      case "flight":
        return reply("slash.flight", now, renderFlight(brokerSnapshot, arg, now), parsed);
      case "steer":
        return reply("slash.steer", now, renderSteer(parsed, arg), parsed);
    }
  }

  const whoOnline = normalized.match(/^who\s+is\s+online\??$/i);
  if (whoOnline) {
    return reply("status.who_online", now, renderAgents(brokerSnapshot, now), parsed);
  }

  const doing = normalized.match(/^what\s+is\s+@?([A-Za-z0-9._-]+)\s+doing\??$/i);
  if (doing?.[1]) {
    return reply("status.agent_doing", now, renderDoing(brokerSnapshot, doing[1], now), parsed);
  }

  const blocked = normalized.match(/^is\s+@?([A-Za-z0-9._-]+)\s+blocked\??$/i);
  if (blocked?.[1]) {
    return reply("status.agent_blocked", now, renderBlocked(brokerSnapshot, blocked[1], now), parsed);
  }

  const recent = normalized.match(/^recent\s+from\s+@?([A-Za-z0-9._-]+)\??$/i);
  if (recent?.[1]) {
    return reply("status.recent_from", now, renderRecent(brokerSnapshot, recent[1], 5, now), parsed);
  }

  const latest = normalized.match(/^(?:what(?:'s| is)\s+)?(?:the\s+)?latest\s+(?:on|from|for)\s+@?([A-Za-z0-9._-]+)\??$/i);
  if (latest?.[1]) {
    return reply("status.latest_agent", now, renderLatest(brokerSnapshot, latest[1], now), parsed);
  }

  const lastSaid = normalized.match(/^what\s+did\s+@?([A-Za-z0-9._-]+)\s+say\s+last\??$/i);
  if (lastSaid?.[1]) {
    return reply("status.last_said", now, renderRecent(brokerSnapshot, lastSaid[1], 1, now), parsed);
  }

  return null;
}

function reply(
  matchedRule: string,
  snapshotAt: number,
  body: string,
  parsed: ScoutbotDirectiveParseResult,
): ScoutbotPrefilterReply {
  return {
    body: body.trim(),
    metadata: {
      matched_rule: matchedRule,
      snapshot_at: snapshotAt,
      ...scoutbotDirectiveMetadata(parsed),
    },
  };
}

function renderHelp(): string {
  return [
    "Scout commands — work-first (FOCUS shape):",
    "- `/report [note]` — send diagnostics; use `--local-only` to save without upload",
    "- `/feedback <note>` — send a note; add `--diagnostics` for traces",
    "- `/status` — ON YOU (requests), then RECENT work",
    "- `/recent` — recent work fleet-wide; `/recent @agent` for one hand",
    "- `/agents` — agents as facets of current work (not an endpoint roster)",
    "- `/doing @agent` — what work a hand is on",
    "- `/flight <id>` — inspect one work unit by id",
    "- `/steer session:<session>` — target this ScoutBot thread at a conversation",
    "",
    "HUD tabs: focus · threads · tail · scout · scoutbot",
    "",
    "Addressing in the dock:",
    "- default — steer where you are (place); no address needed",
    "- `@work` / `@agent` — reach a specific work / its hand across contexts",
    "- `#project` — scope to a project",
    "- `/` — slash commands",
    "",
    "Directives can appear anywhere: `eff:low`, `eff:high`, `session:<session>`.",
  ].join("\n");
}

/**
 * Agents as facets of work — not a transport:state roster.
 * Leads with hands that have active work, then quiet hands briefly.
 */
function renderAgents(snapshot: ScoutbotBrokerSnapshot, now: number): string {
  const works = collectWorkRows(snapshot, now);
  const byAgent = new Map<string, WorkRow>();
  for (const work of works) {
    const key = normalizeAgent(work.agent);
    if (!byAgent.has(key)) byAgent.set(key, work);
  }

  const agents = Object.values(snapshot.agents ?? {})
    .filter((agent): agent is ScoutBrokerAgentRecord => Boolean(agent?.id))
    .sort((a, b) => agentLabel(a).localeCompare(agentLabel(b)));

  if (agents.length === 0) return "No agents registered — no hands on work yet.";

  const activeLines: string[] = [];
  const quietLabels: string[] = [];

  for (const agent of agents.slice(0, 40)) {
    const label = agentLabel(agent);
    const work = byAgent.get(normalizeAgent(agent.id))
      ?? byAgent.get(normalizeAgent(agent.handle ?? ""))
      ?? byAgent.get(normalizeAgent(label));
    if (work) {
      const laneNote = work.lane === "on-you" ? "asking" : work.live ? "moving" : "recent";
      activeLines.push(`· ${label} — ${work.title}\n  #${work.project} · ${laneNote} · ${work.ago}`);
    } else {
      quietLabels.push(label);
    }
  }

  const parts: string[] = [];
  if (activeLines.length > 0) {
    parts.push(`HANDS ON WORK · ${activeLines.length}`, ...activeLines);
  } else {
    parts.push("HANDS ON WORK · 0", "No active work in the broker snapshot.");
  }
  if (quietLabels.length > 0) {
    parts.push("", `quiet · ${quietLabels.slice(0, 12).join(" · ")}${quietLabels.length > 12 ? " …" : ""}`);
  }
  if (agents.length > 40) {
    parts.push(`…and ${agents.length - 40} more hands.`);
  }
  return parts.join("\n");
}

/**
 * /status mirrors the FOCUS screen: ON YOU first, then RECENT.
 * Presence/endpoint counts are plumbing — never the headline.
 * Optional @agent arg still zooms to that hand (latest).
 */
function renderStatus(snapshot: ScoutbotBrokerSnapshot, rawArg = "", now: number): string {
  const agentArg = firstAgentishToken(rawArg);
  if (agentArg) return renderLatest(snapshot, agentArg, now);

  const works = collectWorkRows(snapshot, now);
  const onYou = works.filter((w) => w.lane === "on-you");
  const recent = works.filter((w) => w.lane === "recent");
  const hidden = countHiddenScoutbotArtifacts(snapshot);

  const lines: string[] = [
    `ON YOU · ${onYou.length}`,
    ...(onYou.length > 0 ? onYou.slice(0, 8).map(formatWorkRow) : ["No open requests."]),
    "",
    "RECENT",
    ...(recent.length > 0 ? recent.slice(0, 10).map(formatWorkRow) : ["No recent work in the broker snapshot."]),
  ];
  if (hidden > 0) {
    lines.push("", `(${hidden} Scoutbot delivery artifact${hidden === 1 ? "" : "s"} hidden)`);
  }
  return lines.join("\n");
}

function renderSteer(parsed: ScoutbotDirectiveParseResult, rawArg: string): string {
  const targetSessionId = parsed.directives.targetSessionId ?? firstSessionishToken(rawArg);
  if (!targetSessionId) {
    return "Usage: `/steer session:<session>` — target this conversation.";
  }
  return `Steering this ScoutBot thread to conversation session ${targetSessionId}.`;
}

function renderDoing(snapshot: ScoutbotBrokerSnapshot, rawAgent: string, now: number): string {
  const agentId = normalizeAgent(rawAgent);
  if (!agentId) return "Usage: `/doing @agent` — what work a hand is on.";
  const agent = findAgent(snapshot, agentId);
  if (!agent) return `I do not see a hand matching ${formatAgent(rawAgent)}.`;

  const works = collectWorkRows(snapshot, now).filter((w) => {
    const key = normalizeAgent(w.agent);
    return key === normalizeAgent(agent.id)
      || key === normalizeAgent(agent.handle ?? "")
      || key === normalizeAgent(agentLabel(agent));
  });
  if (works.length === 0) {
    return `${agentLabel(agent)} has no active work in the broker snapshot.`;
  }
  return `${agentLabel(agent)} is on:\n${works.slice(0, 5).map(formatWorkRow).join("\n")}`;
}

function renderBlocked(snapshot: ScoutbotBrokerSnapshot, rawAgent: string, now: number): string {
  const agentId = normalizeAgent(rawAgent);
  const agent = findAgent(snapshot, agentId);
  if (!agent) return `I do not see a hand matching ${formatAgent(rawAgent)}.`;

  const onYou = collectWorkRows(snapshot, now).filter((w) => {
    if (w.lane !== "on-you") return false;
    const key = normalizeAgent(w.agent);
    return key === normalizeAgent(agent.id)
      || key === normalizeAgent(agent.handle ?? "")
      || key === normalizeAgent(agentLabel(agent));
  });
  if (onYou.length === 0) {
    return `${agentLabel(agent)} has no open requests in the broker snapshot.`;
  }
  return `${agentLabel(agent)} — requests:\n${onYou.slice(0, 5).map(formatWorkRow).join("\n")}`;
}

/**
 * Fleet RECENT when no agent; for one hand, recent work + recent messages
 * as work-row-shaped lines (title first, facets second).
 */
function renderRecent(
  snapshot: ScoutbotBrokerSnapshot,
  rawAgent: string,
  limit = 8,
  now = Date.now(),
): string {
  const agentToken = firstAgentishToken(rawAgent);
  if (!agentToken) {
    const recent = collectWorkRows(snapshot, now).filter((w) => w.lane === "recent").slice(0, limit);
    if (recent.length === 0) return "RECENT\nNo recent work in the broker snapshot.";
    return `RECENT · ${recent.length}\n${recent.map(formatWorkRow).join("\n")}`;
  }

  const agent = findAgent(snapshot, agentToken);
  if (!agent) return `I do not see a hand matching ${formatAgent(rawAgent)}.`;

  const works = collectWorkRows(snapshot, now)
    .filter((w) => {
      const key = normalizeAgent(w.agent);
      return key === normalizeAgent(agent.id)
        || key === normalizeAgent(agent.handle ?? "")
        || key === normalizeAgent(agentLabel(agent));
    })
    .slice(0, limit);

  const messages = Object.values(snapshot.messages ?? {})
    .filter((message) => message.actorId === agent.id)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .slice(0, Math.max(0, limit - works.length));

  const lines: string[] = [];
  for (const work of works) lines.push(formatWorkRow(work));
  for (const message of messages) {
    lines.push(
      formatWorkRow({
        id: message.id,
        title: compact(message.body, 120),
        agent: agentLabel(agent),
        project: projectForAgent(snapshot, agent),
        ago: formatAgo(message.createdAt, now),
        lane: "recent",
        live: false,
      }),
    );
  }

  if (lines.length === 0) {
    return `No recent work from ${agentLabel(agent)} in the broker snapshot.`;
  }
  return `RECENT · ${agentLabel(agent)}\n${lines.join("\n")}`;
}

function renderLatest(snapshot: ScoutbotBrokerSnapshot, rawAgent: string, now: number): string {
  const agentId = normalizeAgent(rawAgent);
  const agent = findAgent(snapshot, agentId);
  if (!agent) return `I do not see a hand matching ${formatAgent(rawAgent)}.`;

  const works = collectWorkRows(snapshot, now).filter((w) => {
    const key = normalizeAgent(w.agent);
    return key === normalizeAgent(agent.id)
      || key === normalizeAgent(agent.handle ?? "")
      || key === normalizeAgent(agentLabel(agent));
  });
  const recentMessages = Object.values(snapshot.messages ?? {})
    .filter((message) => message.actorId === agent.id)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .slice(0, 3);

  const lines: string[] = [`Latest on ${agentLabel(agent)}:`];
  if (works.length > 0) {
    lines.push(formatWorkRow(works[0]!));
  } else {
    lines.push("· no active work in the broker snapshot");
  }
  for (const message of recentMessages) {
    lines.push(`· said ${formatAgo(message.createdAt, now)}: ${compact(message.body)}`);
  }
  if (recentMessages.length === 0) {
    lines.push("· no recent messages in the broker snapshot");
  }
  return lines.join("\n");
}

function durableFlightRecordById(id: string): ScoutBrokerFlightRecord | null {
  try {
    return queryFlightRecordById(id);
  } catch {
    return null;
  }
}

/** Keep /flight for id lookup; frame as a work unit, not a roster entry. */
function renderFlight(snapshot: ScoutbotBrokerSnapshot, rawFlightId: string, now: number): string {
  const id = rawFlightId.trim();
  if (!id) return "Usage: `/flight <id>` — inspect one work unit by id.";
  const flight = (snapshot.flights ?? {})[id]
    ?? Object.values(snapshot.flights ?? {}).find((candidate) => candidate.id.endsWith(id))
    // Rotated out of the broker's hot window — SQLite retains the record.
    // The control-plane database can be absent on a fresh install.
    ?? durableFlightRecordById(id);
  if (!flight) return `I do not see work ${id}.`;

  const agent = findAgent(snapshot, flight.targetAgentId);
  const agentName = agent ? agentLabel(agent) : formatAgent(flight.targetAgentId);
  const project = agent ? projectForAgent(snapshot, agent) : "—";
  const title = workTitleFromFlight(flight);
  const lane = isOnYouFlight(flight) ? "asking" : isTerminalFlight(flight.state) ? "wound down" : "moving";
  const ts = flight.completedAt ?? flight.startedAt;

  return [
    title,
    `${agentName} · #${project} · ${lane} · ${formatAgo(ts, now)}`,
    `id ${flight.id}`,
    flight.error ? `error: ${flight.error}` : null,
    flight.output ? `output: ${compact(flight.output, 500)}` : null,
  ].filter(Boolean).join("\n");
}

// ─── Work model (from broker snapshot only) ─────────────────────────
// Attention index is not on the prefilter input yet (see hud-redesign
// research footer). ON YOU is derived from flight states that typically
// need the operator: waiting / failed. Degrades gracefully when empty.

function collectWorkRows(snapshot: ScoutbotBrokerSnapshot, now: number): WorkRow[] {
  const flights = Object.values(snapshot.flights ?? {})
    .filter((flight) => !isScoutbotDirectDeliveryArtifact(flight))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));

  const rows: WorkRow[] = [];
  const seen = new Set<string>();

  for (const flight of flights) {
    if (isTerminalFlight(flight.state) && !isOnYouFlight(flight)) {
      // Keep a few recent completions in RECENT; skip old terminals.
      const age = now - (flight.completedAt ?? flight.startedAt ?? 0);
      if (age > 1000 * 60 * 60 * 12) continue;
    }
    const agent = findAgent(snapshot, flight.targetAgentId);
    const agentName = agent ? agentLabel(agent) : formatAgent(flight.targetAgentId);
    const row: WorkRow = {
      id: flight.id,
      title: workTitleFromFlight(flight),
      agent: agentName,
      project: agent ? projectForAgent(snapshot, agent) : "—",
      ago: formatAgo(flight.completedAt ?? flight.startedAt, now),
      lane: isOnYouFlight(flight) ? "on-you" : "recent",
      live: flight.state === "running" || flight.state === "waking",
    };
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }

  // Prefer ON YOU first, then live, then by recency (already sorted by startedAt).
  rows.sort((a, b) => {
    if (a.lane !== b.lane) return a.lane === "on-you" ? -1 : 1;
    if (a.live !== b.live) return a.live ? -1 : 1;
    return 0;
  });

  return rows;
}

function formatWorkRow(work: WorkRow): string {
  // Two-line FOCUS row: title, then agent · #project · ago
  return `· ${work.title}\n  ${work.agent} · #${work.project} · ${work.ago}`;
}

function workTitleFromFlight(flight: ScoutBrokerFlightRecord): string {
  if (flight.summary?.trim()) return compact(flight.summary, 120);
  if (flight.error?.trim()) return compact(flight.error, 120);
  if (flight.state === "waiting") return "Waiting — needs input";
  if (flight.state === "failed") return "Failed work";
  if (flight.state === "running") return "In progress";
  if (flight.state === "waking") return "Waking";
  if (flight.state === "queued") return "Queued";
  return flight.state ? `Work (${flight.state})` : "Work";
}

function isOnYouFlight(flight: ScoutBrokerFlightRecord): boolean {
  if (flight.state === "waiting" || flight.state === "failed") return true;
  if (flight.error && !isTerminalFlight(flight.state)) return true;
  return false;
}

function projectForAgent(snapshot: ScoutbotBrokerSnapshot, agent: ScoutBrokerAgentRecord): string {
  const endpoints = Object.values(snapshot.endpoints ?? {}).filter((ep) => ep.agentId === agent.id);
  for (const ep of endpoints) {
    const root = ep.projectRoot?.trim() || ep.cwd?.trim();
    if (root) return basen(root);
  }
  const qual = agent.workspaceQualifier?.trim();
  if (qual) return basen(qual);
  return "—";
}

function basen(path: string): string {
  const cleaned = path.replace(/\/+$/, "");
  const parts = cleaned.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || cleaned || "—";
}

function formatAgo(ts: number | undefined, now: number): string {
  if (!ts || !Number.isFinite(ts)) return "—";
  const delta = Math.max(0, now - ts);
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${Math.max(s, 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function countHiddenScoutbotArtifacts(snapshot: ScoutbotBrokerSnapshot): number {
  return Object.values(snapshot.flights ?? {}).filter(isScoutbotDirectDeliveryArtifact).length;
}

function findAgent(snapshot: ScoutbotBrokerSnapshot, raw: string): ScoutBrokerAgentRecord | null {
  const normalized = normalizeAgent(raw);
  return Object.values(snapshot.agents ?? {}).find((agent) => {
    const labels = [agent.id, agent.handle, agent.selector, agent.defaultSelector, agent.displayName]
      .filter((value): value is string => typeof value === "string")
      .map(normalizeAgent);
    return labels.includes(normalized);
  }) ?? null;
}

function agentLabel(agent: ScoutBrokerAgentRecord): string {
  const selector = agent.defaultSelector ?? agent.selector ?? (agent.handle ? `@${agent.handle}` : null);
  return selector?.startsWith("@") ? selector : selector ? `@${selector}` : agent.displayName || agent.id;
}

function normalizeAgent(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function formatAgent(value: string): string {
  const normalized = normalizeAgent(value);
  return normalized ? `@${normalized}` : "that agent";
}

function firstAgentishToken(value: string): string | null {
  const token = value.trim().split(/\s+/).find(Boolean);
  if (!token) return null;
  return token.replace(/^@/, "").replace(/[.,!?;:]+$/g, "") || null;
}

function firstSessionishToken(value: string): string | null {
  const token = value.trim().split(/\s+/).find(Boolean);
  const normalized = token?.replace(/^(?:sid|session):/i, "").replace(/[.,!?;]+$/g, "").trim();
  return normalized || null;
}

function compact(value: string, max = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function isTerminalFlight(state: string | undefined): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function isScoutbotDirectDeliveryArtifact(flight: ScoutBrokerFlightRecord): boolean {
  if (flight.targetAgentId !== SCOUTBOT_AGENT_ID) return false;
  if (flight.state !== "queued") return false;
  const metadata = flight.metadata ?? {};
  const source = typeof metadata.source === "string" ? metadata.source : "";
  if (source === "scoutbot") return false;
  const destinationKind = typeof metadata.destinationKind === "string" ? metadata.destinationKind : "";
  const destinationId = typeof metadata.destinationId === "string" ? metadata.destinationId : "";
  const relayTarget = typeof metadata.relayTarget === "string" ? metadata.relayTarget : "";
  return (destinationKind === "direct" && destinationId === SCOUTBOT_AGENT_ID)
    || relayTarget === SCOUTBOT_AGENT_ID;
}
