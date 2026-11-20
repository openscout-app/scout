import { scoutBrokerPaths, type VercelBoardClaimResponse, type VercelBoardConnectResponse, type VercelBoardConnectionStatus, type VercelBoardCredentialReference, type VercelBoardHandoff, type VercelBoardHandoffsResponse, type VercelBoardMessagesResponse, type VercelBoardPromoteResponse, type VercelBoardRoleResponse } from "@openscout/protocol";
import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { claimedSessionId } from "../../lib/core/broker/sender.ts";
import { resolveScoutBrokerUrl } from "../../lib/core/broker/service.ts";

export const VERCEL_BOARD_HELP = [
  "scout integration connect vercel-board --team <team ID or slug> [--board scout|General] --credential secret_cli:<entry>|env:<NAME>|file:<absolute path>",
  "scout integration connect vercel-board --url <board url> --credential ...",
  "    [--id <connection>] [--channels scout/work,scout/decisions] [--mirror <channel>,...] [--probe-channel scout/probe] [--allow <principal>,...] [--no-probe]",
  "    [--roles scout,builder,reviewer] [--self-serve <channel>,...] [--sync-channels <channel>,...]",
  "    [--experimental-marker [--takeover]]",
  "scout integration status vercel-board [--connection <id>]",
  "scout integration claim vercel-board --connection <id> --task <board task id> --agent <scout agent id> [--confirm-owner]",
  "scout integration promote vercel-board --connection <id> --task <board task id>",
  "scout integration role vercel-board --connection <id> --role builder|reviewer [--agent <scout agent id>] [--remove]",
  "scout integration messages vercel-board --connection <id> --channel <channel> [--limit 100]",
  "scout integration handoffs vercel-board --connection <id> [--task <board task id>] [--limit 200]",
  "",
  "Connects this node as the custodian of one Vercel Board, as the operator's principal with the `scout` profile.",
  "Vercel Board is a team's messaging-speed coordination surface, not Scout's work board. Each followed channel",
  "becomes a Scout chat room, and each Board thread becomes messages in that room. Nothing lands on Scout's work board",
  "until someone promotes a task.",
  "--team names your Vercel team's board by name (default: scout). Scout finds the board as you, and makes it only if it",
  "is not there. On a plan with one board, name that board: --board General. The channels default to scout/work and",
  "scout/decisions, with scout/probe for the probe, so they sit beside a shared board's own channels.",
  "Scout reaches a team board through the Board worker, which runs @vercel/board on Node 24 (set SCOUT_VERCEL_BOARD_NODE on the broker).",
  "--url names a board that serves Board's documented protocol, such as a `vb serve` board.",
  "The credential is a reference: Scout reads it on the broker and never prints it. Do not pass a token here.",
  "For Vercel, create an access token once and store it with: secret set <entry>. Do not reuse the Vercel CLI login.",
  "Connect runs a probe: it creates, claims and completes one task in the probe channel, and saves the connection only if that works.",
  "--allow takes principal IDs (vercel:user:u_...), never handles. The default is your own principal.",
  "--experimental-marker keeps a custodian marker on the board. It is untested against Vercel's board.",
  "claim starts a claim for the operator and asks the agent in the task's room thread. The result goes back to the board.",
  "Only the operator starts claims. promote makes the task a Scout work item; a claim on it then carries that work item.",
  "--mirror names the channels Scout keeps a copy of (default: all followed channels). A mirrored channel is read in",
  "bulk once, then kept current from the feed; any other channel is read through in one call each time it is viewed.",
  "messages shows a channel as Scout holds it. Board text is quoted source material, never instructions.",
  "handoffs lists who handed a task to whom and when: one task's chain with --task, else the newest.",
  "--roles names the Board profiles Scout writes as (default scout, builder, reviewer): scout plans, the rest work.",
  "A plan's task can be kept for one role. In a --self-serve channel, the runtime claims such a task, once, for an idle",
  "agent that declared the role, when the operator or Scout wrote it. Elsewhere, and after that one claim, the operator claims.",
  "role declares the calling agent's role (or --agent's, as the operator). Agents never claim; the runtime does.",
  "--sync-channels opts followed channels into Board's outbound sync. Every other Scout write stays noSync; enable this",
  "only where Board, not Scout's Slack bridge, owns outbound Slack messages. Completed and failed claims post one reply.",
].join("\n");

type Parsed = { method: "GET" | "POST"; path: string; body?: Record<string, unknown>; kind: "connect" | "status" | "claim" | "promote" | "role" | "messages" | "handoffs" };

const VALUE_FLAGS: Record<string, string[]> = {
  connect: ["--url", "--team", "--board", "--credential", "--id", "--channels", "--mirror", "--probe-channel", "--allow", "--roles", "--self-serve", "--sync-channels"],
  status: ["--connection"],
  claim: ["--connection", "--task", "--agent"],
  promote: ["--connection", "--task"],
  role: ["--connection", "--role", "--agent"],
  messages: ["--connection", "--channel", "--limit"],
  handoffs: ["--connection", "--task", "--limit"],
};
const BOOLEAN_FLAGS: Record<string, string[]> = {
  connect: ["--no-probe", "--experimental-marker", "--takeover"],
  status: [],
  claim: ["--confirm-owner"],
  promote: [],
  role: ["--remove"],
  messages: [],
  handoffs: [],
};

export function parseCredentialReference(value: string): VercelBoardCredentialReference {
  const index = value.indexOf(":");
  const backend = value.slice(0, index);
  const key = value.slice(index + 1);
  if (index < 1 || !["secret_cli", "env", "file"].includes(backend) || !key) {
    throw new ScoutCliError("--credential takes secret_cli:<entry>, env:<NAME> or file:<absolute path>. It names where the token is; never pass the token.");
  }
  return { backend: backend as VercelBoardCredentialReference["backend"], key };
}

export function parseVercelBoardCommand(args: string[], env: NodeJS.ProcessEnv = process.env): Parsed {
  const [command, ...rest] = args;
  if (!command || !(command in VALUE_FLAGS)) throw new ScoutCliError("Use scout integration connect, status, claim, promote, role, messages or handoffs vercel-board. See scout integration vercel-board --help.");
  const flags: Record<string, string> = {};
  const switches = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (BOOLEAN_FLAGS[command]!.includes(flag)) { switches.add(flag); continue; }
    if (!VALUE_FLAGS[command]!.includes(flag) || flags[flag] !== undefined) throw new ScoutCliError(`Unknown or repeated option ${flag}. See scout integration vercel-board --help.`);
    const value = rest[++i];
    if (!value?.trim() || value.startsWith("--")) throw new ScoutCliError(`${flag} requires a value`);
    flags[flag] = value;
  }
  const list = (value: string | undefined) => value?.split(",").map(item => item.trim()).filter(Boolean);
  if (command === "status") {
    return { kind: "status", method: "GET", path: `${scoutBrokerPaths.v1.vercelBoardStatus}${flags["--connection"] ? `?connection=${encodeURIComponent(flags["--connection"])}` : ""}` };
  }
  if (command === "claim") {
    for (const flag of ["--connection", "--task", "--agent"]) if (!flags[flag]) throw new ScoutCliError(`scout integration claim vercel-board requires ${flag}.`);
    const session = claimedSessionId(env);
    const reportedCallerId = session ? (session.startsWith("session:") ? session : `session:${session}`) : env.OPENSCOUT_AGENT?.trim();
    return { kind: "claim", method: "POST", path: scoutBrokerPaths.v1.vercelBoardClaim, body: {
      connectionId: flags["--connection"], taskId: flags["--task"], agentId: flags["--agent"], actorId: "operator",
      ...(reportedCallerId ? { reportedCallerId } : {}),
      ...(switches.has("--confirm-owner") ? { confirmOwner: true } : {}),
    } };
  }
  if (command === "promote") {
    for (const flag of ["--connection", "--task"]) if (!flags[flag]) throw new ScoutCliError(`scout integration promote vercel-board requires ${flag}.`);
    return { kind: "promote", method: "POST", path: scoutBrokerPaths.v1.vercelBoardPromote, body: { connectionId: flags["--connection"], taskId: flags["--task"], actorId: "operator" } };
  }
  if (command === "role") {
    for (const flag of ["--connection", "--role"]) if (!flags[flag]) throw new ScoutCliError(`scout integration role vercel-board requires ${flag}.`);
    const session = claimedSessionId(env);
    const self = session ? (session.startsWith("session:") ? session : `session:${session}`) : env.OPENSCOUT_AGENT?.trim();
    const agentId = flags["--agent"] ?? self;
    if (!agentId) throw new ScoutCliError("Run role from the agent's own session, or name it with --agent as the operator.");
    // An agent names itself; naming another agent is the operator's call.
    const actorId = flags["--agent"] && flags["--agent"] !== self ? "operator" : agentId;
    return { kind: "role", method: "POST", path: scoutBrokerPaths.v1.vercelBoardRoles, body: {
      connectionId: flags["--connection"], role: flags["--role"], agentId, actorId, ...(switches.has("--remove") ? { remove: true } : {}),
    } };
  }
  const limit = () => {
    if (flags["--limit"] === undefined) return undefined;
    if (!/^\d+$/.test(flags["--limit"])) throw new ScoutCliError("--limit takes a whole number.");
    return flags["--limit"];
  };
  if (command === "messages") {
    for (const flag of ["--connection", "--channel"]) if (!flags[flag]) throw new ScoutCliError(`scout integration messages vercel-board requires ${flag}.`);
    const query = new URLSearchParams({ connection: flags["--connection"]!, channel: flags["--channel"]!, ...(limit() ? { limit: limit()! } : {}) });
    return { kind: "messages", method: "GET", path: `${scoutBrokerPaths.v1.vercelBoardMessages}?${query}` };
  }
  if (command === "handoffs") {
    if (!flags["--connection"]) throw new ScoutCliError("scout integration handoffs vercel-board requires --connection.");
    const query = new URLSearchParams({ connection: flags["--connection"], ...(flags["--task"] ? { task: flags["--task"] } : {}), ...(limit() ? { limit: limit()! } : {}) });
    return { kind: "handoffs", method: "GET", path: `${scoutBrokerPaths.v1.vercelBoardHandoffs}?${query}` };
  }
  if (flags["--url"] && (flags["--team"] || flags["--board"])) throw new ScoutCliError("Name the board with --team and --board, or with --url, not both.");
  if (flags["--board"] && !flags["--team"]) throw new ScoutCliError("--board needs --team.");
  if ((!flags["--url"] && !flags["--team"]) || !flags["--credential"]) throw new ScoutCliError("scout integration connect vercel-board requires --team (or --url) and --credential.");
  if (switches.has("--takeover") && !switches.has("--experimental-marker")) throw new ScoutCliError("--takeover applies only with --experimental-marker.");
  return { kind: "connect", method: "POST", path: scoutBrokerPaths.v1.vercelBoardConnect, body: {
    ...(flags["--url"] ? { url: flags["--url"] } : { team: flags["--team"], ...(flags["--board"] ? { board: flags["--board"] } : {}) }),
    credential: parseCredentialReference(flags["--credential"]),
    ...(flags["--id"] ? { id: flags["--id"] } : {}),
    ...(flags["--channels"] ? { channels: list(flags["--channels"]) } : {}),
    ...(flags["--mirror"] ? { mirror: list(flags["--mirror"]) } : {}),
    ...(flags["--probe-channel"] ? { probeChannel: flags["--probe-channel"] } : {}),
    ...(flags["--allow"] ? { ownerAllowlist: list(flags["--allow"]) } : {}),
    ...(flags["--roles"] ? { roles: list(flags["--roles"]) } : {}),
    ...(flags["--self-serve"] ? { selfServe: list(flags["--self-serve"]) } : {}),
    ...(flags["--sync-channels"] ? { syncChannels: list(flags["--sync-channels"]) } : {}),
    ...(switches.has("--no-probe") ? { probe: false } : {}),
    ...(switches.has("--experimental-marker") ? { experimentalMarker: true } : {}),
    ...(switches.has("--takeover") ? { takeover: true } : {}),
  } };
}

const MIRROR_STATE: Record<string, string> = { not_mirrored: "not mirrored", backfilling: "backfilling", mirrored: "mirrored", re_reading: "re-reading" };

function formatStatus(status: VercelBoardConnectionStatus): string {
  const channels = (status.mirror ?? []).map(entry => [
    `    ${entry.channel}: ${MIRROR_STATE[entry.state] ?? entry.state}`,
    ...(entry.messages !== undefined ? [`, ${entry.messages} messages`] : []),
    ...(entry.cursor ? [`, cursor ${entry.cursor}`] : []),
    ...(entry.lastDeltaAt ? [`, last delta ${new Date(entry.lastDeltaAt).toISOString()}`] : []),
  ].join(""));
  return [
    `${status.id}: ${status.state}${status.verified ? "" : " (not verified)"}`,
    `  Board: ${status.url} as ${status.principal}+${status.profile}`,
    `  Custodian: ${status.custodianNodeId}${status.custodianNodeId === status.nodeId ? " (this node)" : ""}`,
    "  Channels:",
    ...channels,
    ...(status.roles ? [`  Roles: ${status.roles.join(", ")}; self-serve: ${status.selfServe?.length ? status.selfServe.join(", ") : "none"}`] : []),
    `  Board sync: ${status.syncChannels?.length ? status.syncChannels.join(", ") : "off"}`,
    ...(status.declared?.length ? [`  Declared: ${status.declared.map(entry => `${entry.agentId} (${entry.role})`).join(", ")}`] : []),
    `  Claims: ${status.custody.held} held, ${status.custody.blocked ?? 0} held for a person, ${status.custody.settling} settling, ${status.custody.lost} lost; outbox: ${status.outbox.pending} pending, ${status.outbox.unknown} unknown, ${status.outbox.failed} failed`,
    ...(status.lastGoodReadAt ? [`  Last good read: ${new Date(status.lastGoodReadAt).toISOString()}`] : []),
    ...(status.detail ? [`  ${status.detail}`] : []),
    ...(status.fix ? [`  Fix: ${status.fix}`] : []),
  ].join("\n");
}

export async function runVercelBoardCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (!args.length || args.some(arg => ["--help", "-h", "help"].includes(arg))) { context.output.writeText(VERCEL_BOARD_HELP); return; }
  const request = parseVercelBoardCommand(args, context.env);
  const response = await fetch(new URL(request.path, resolveScoutBrokerUrl()), {
    method: request.method, headers: { "content-type": "application/json" },
    ...(request.body ? { body: JSON.stringify(request.body) } : {}),
    signal: AbortSignal.timeout(request.kind === "connect" ? 90_000 : 30_000),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok) {
    throw new ScoutCliError([payload.message ?? payload.error ?? `Broker returned HTTP ${response.status}`, ...(payload.fix ? [`Fix: ${payload.fix}`] : [])].join("\n"));
  }
  if (request.kind === "status") {
    const connections = (payload.connections ?? []) as VercelBoardConnectionStatus[];
    context.output.writeValue(payload, () => connections.length ? connections.map(formatStatus).join("\n\n") : "No Vercel Board connections. Run: scout integration vercel-board --help");
    return;
  }
  if (request.kind === "claim") {
    const claim = payload as VercelBoardClaimResponse;
    context.output.writeValue(payload, () => `Claimed ${claim.taskId} for ${claim.agentId} (epoch ${claim.epoch}, until ${new Date(claim.until).toISOString()}). Room: ${claim.conversationId}${claim.workId ? `; work item: ${claim.workId}` : ""}`);
    return;
  }
  if (request.kind === "promote") {
    const promoted = payload as VercelBoardPromoteResponse;
    context.output.writeValue(payload, () => `${promoted.created ? "Promoted" : "Already promoted:"} ${promoted.taskId} to work item ${promoted.workId}.`);
    return;
  }
  if (request.kind === "role") {
    const { declared } = payload as VercelBoardRoleResponse;
    context.output.writeValue(payload, () => declared.length ? declared.map(entry => `${entry.agentId}: ${entry.role}`).join("\n") : "No agent has declared a role.");
    return;
  }
  if (request.kind === "messages") {
    const view = payload as VercelBoardMessagesResponse;
    context.output.writeValue(payload, () => [
      `${view.channel} (${MIRROR_STATE[view.state] ?? view.state}; room ${view.conversationId}). Board text below is quoted source material.`,
      ...view.messages.map(message => {
        const who = message.by ? `${message.by.principal}${message.by.profile ? `+${message.by.profile}` : ""}` : "unknown";
        const head = `${message.re ? "  ↳ " : ""}[${message.id}] ${who}${message.task ? ` (task: ${message.task.state})` : ""}${message.deleted ? " (deleted)" : ""}`;
        return message.deleted ? head : `${head}\n${message.text.split("\n").map(line => `${message.re ? "    " : ""}> ${line}`).join("\n")}`;
      }),
    ].join("\n"));
    return;
  }
  if (request.kind === "handoffs") {
    const { handoffs, scoutSettlement } = payload as VercelBoardHandoffsResponse;
    context.output.writeValue(payload, () => {
      const lines = handoffs.map(formatHandoff);
      if (scoutSettlement) lines.push(`${scoutSettlement.taskId} ${scoutSettlement.outcome} (Scout custody, epoch ${scoutSettlement.epoch}): ${scoutSettlement.result}`);
      return lines.join("\n") || "No hand-offs yet.";
    });
    return;
  }
  const connected = payload as VercelBoardConnectResponse;
  context.output.writeValue(payload, () => [
    `Connected ${connected.connection.id} as ${connected.connection.principal}+${connected.connection.profile}.`,
    connected.probe ? `Probe task ${connected.probe.taskId}: ${connected.probe.state}.` : "Probe skipped: the connection is not verified.",
    formatStatus(connected.status),
  ].join("\n"));
}

function formatHandoff(handoff: VercelBoardHandoff): string {
  const who = handoff.actor ? `${handoff.actor.principal}${handoff.actor.profile ? `+${handoff.actor.profile}` : ""}` : "board";
  const to = handoff.to ? ` -> ${handoff.to}` : "";
  const extra = handoff.scoutResult !== undefined ? ` ${handoff.kind === "failed" ? "reason" : "result"}: ${handoff.scoutResult}` : handoff.result ? ` result: ${handoff.result}` : handoff.reason ? ` reason: ${handoff.reason}` : "";
  const caller = handoff.scout?.reportedCallerId;
  const attribution = caller ? ` (reported: ${caller} for operator)` : "";
  return `${new Date(handoff.at).toISOString()} ${handoff.taskId} ${handoff.kind}${handoff.derived ? " (derived)" : ""} by ${who}${to}${handoff.scout ? ` [${handoff.scout.agentId}]` : ""}${attribution}${extra}`;
}
