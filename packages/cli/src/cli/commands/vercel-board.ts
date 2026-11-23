import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scoutBrokerPaths, type VercelBoardChannelDispatchConfig, type VercelBoardClaimStatus, type VercelBoardDispatchConfig, type VercelBoardDispatchDecision, type VercelBoardDispatcherStatus, type VercelBoardDispatchRunResponse, type VercelBoardClaimResponse, type VercelBoardConnectResponse, type VercelBoardConnectionStatus, type VercelBoardCredentialReference, type VercelBoardHandoff, type VercelBoardHandoffsResponse, type VercelBoardMessagesResponse, type VercelBoardPromoteResponse, type VercelBoardRoleResponse } from "@openscout/protocol";
import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { claimedSessionId } from "../../lib/core/broker/sender.ts";
import { resolveScoutBrokerUrl } from "../../lib/core/broker/service.ts";

export const VERCEL_BOARD_HELP = [
  "scout integration connect vercel-board --team <team ID or slug> [--board scout|General] --credential secret_cli:<entry>|env:<NAME>|file:<absolute path>",
  "scout integration connect vercel-board --url <board url> --credential ...",
  "    [--id <connection>] [--channels scout/work,scout/decisions] [--mirror <channel>,...] [--probe-channel scout/probe] [--allow <principal>,...] [--no-probe]",
  "    [--roles scout,builder,reviewer] [--self-serve <channel>,...] [--sync-channels <channel>,...]",
  "scout integration status vercel-board [--connection <id>]",
  "scout integration claim vercel-board --connection <id> --task <board task id> --agent <scout agent id> [--confirm-owner]",
  "scout integration promote vercel-board --connection <id> --task <board task id>",
  "scout integration role vercel-board --connection <id> --role builder|reviewer [--agent <scout agent id>] [--remove]",
  "scout integration messages vercel-board --connection <id> --channel <channel> [--limit 100]",
  "scout integration handoffs vercel-board --connection <id> [--task <board task id>] [--limit 200]",
  "scout integration dispatcher vercel-board --connection <id> [--explain <board task id>] [--run]",
  "    [--policy manual|role-only|label-matched|trusted-channel|<defined>] [--channel <channel> [--labels <label>,...] [--trust-authors operator|allowlist|any]",
  "    [--trust-any-epoch] [--trust-synced <sync key>,...] [--default]] [--pause|--resume] [--file <rules.json>]",
  "",
  "Connects this host to one Vercel Board, as the operator's principal with the `scout` profile. Each host connects on its own; the board's claims decide which host does a task.",
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
  "dispatcher shows each channel's dispatch policy, its recent decisions, and each held claim's lease and next renewal.",
  "The runtime's dispatcher wakes when the feed shows a task ready (created, readied, released, expired) and on a",
  "5-second sweep, and claims what the channel's policy claims. Policies: manual (the default) claims nothing;",
  "role-only (the default in a --self-serve channel) claims a task kept for a declared role; label-matched claims a",
  "task with one of the channel's --labels, for the agent the capability map names; trusted-channel also gives an",
  "open task to any free agent. Every policy keeps three guards unless you relax them: the operator or Scout wrote",
  "the task, it was not imported from Slack, GitHub or Linear, and the board has never seen it claimed.",
  "--trust-authors, --trust-any-epoch and --trust-synced relax them for one --channel; status marks the channel relaxed.",
  "--explain runs one task through the policy without claiming. --run starts a pass now. --pause stops new claims;",
  "held claims keep renewing. --default drops --channel's own settings. --file replaces the whole settings block",
  "(capabilities, defined policies, per-label trust) with a JSON file; see docs/vercel-board.md.",
  "--sync-channels opts followed channels into Board's outbound sync. Every other Scout write stays noSync; enable this",
  "only where Board, not Scout's Slack bridge, owns outbound Slack messages. Completed and failed claims post one reply.",
].join("\n");

type Parsed = {
  method: "GET" | "POST"; path: string; body?: Record<string, unknown>;
  kind: "connect" | "status" | "claim" | "promote" | "role" | "messages" | "handoffs" | "dispatcher" | "dispatcher-explain" | "dispatcher-run" | "dispatcher-set";
  /** dispatcher-set: the change to make to the saved settings, read first. */
  change?: (current: VercelBoardDispatchConfig) => VercelBoardDispatchConfig;
  /** dispatcher-set: a settings file that replaces the block. */
  file?: string;
};

const VALUE_FLAGS: Record<string, string[]> = {
  connect: ["--url", "--team", "--board", "--credential", "--id", "--channels", "--mirror", "--probe-channel", "--allow", "--roles", "--self-serve", "--sync-channels"],
  status: ["--connection"],
  claim: ["--connection", "--task", "--agent"],
  promote: ["--connection", "--task"],
  role: ["--connection", "--role", "--agent"],
  messages: ["--connection", "--channel", "--limit"],
  handoffs: ["--connection", "--task", "--limit"],
  dispatcher: ["--connection", "--explain", "--policy", "--channel", "--labels", "--trust-authors", "--trust-synced", "--file"],
};
const BOOLEAN_FLAGS: Record<string, string[]> = {
  connect: ["--no-probe"],
  status: [],
  claim: ["--confirm-owner"],
  promote: [],
  role: ["--remove"],
  messages: [],
  handoffs: [],
  dispatcher: ["--run", "--pause", "--resume", "--trust-any-epoch", "--default"],
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
  if (!command || !(command in VALUE_FLAGS)) throw new ScoutCliError("Use scout integration connect, status, claim, promote, role, messages, handoffs or dispatcher vercel-board. See scout integration vercel-board --help.");
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
  if (command === "dispatcher") return parseDispatcher(flags, switches);
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
  } };
}

const TRUST_AUTHORS = ["operator", "allowlist", "any"];

function parseDispatcher(flags: Record<string, string>, switches: Set<string>): Parsed {
  const connectionId = flags["--connection"];
  if (!connectionId) throw new ScoutCliError("scout integration dispatcher vercel-board requires --connection.");
  const list = (value: string | undefined) => value?.split(",").map(item => item.trim()).filter(Boolean);
  const channel = flags["--channel"];
  const channelOnly = ["--labels", "--trust-authors", "--trust-synced"].filter(flag => flags[flag] !== undefined)
    .concat(["--trust-any-epoch", "--default"].filter(flag => switches.has(flag)));
  if (channelOnly.length && !channel) throw new ScoutCliError(`${channelOnly[0]} sets one channel's dispatch: add --channel.`);
  if (switches.has("--pause") && switches.has("--resume")) throw new ScoutCliError("Use --pause or --resume, not both.");
  if (flags["--trust-authors"] && !TRUST_AUTHORS.includes(flags["--trust-authors"])) throw new ScoutCliError("--trust-authors takes operator, allowlist or any.");
  if (switches.has("--default") && (flags["--policy"] || channelOnly.length > 1)) throw new ScoutCliError("--default drops the channel's own settings; give it alone with --channel.");
  const setting = Boolean(flags["--policy"] || channel || switches.has("--pause") || switches.has("--resume") || flags["--file"]);
  const modes = [flags["--explain"] !== undefined, switches.has("--run"), setting].filter(Boolean).length;
  if (modes > 1) throw new ScoutCliError("Use one of --explain, --run, or a settings change at a time.");
  if (flags["--file"] && (flags["--policy"] || channel || switches.has("--pause") || switches.has("--resume"))) throw new ScoutCliError("--file replaces the whole settings block; give it alone.");
  if (flags["--explain"] !== undefined) {
    const query = new URLSearchParams({ connection: connectionId, explain: flags["--explain"] });
    return { kind: "dispatcher-explain", method: "GET", path: `${scoutBrokerPaths.v1.vercelBoardDispatcher}?${query}` };
  }
  if (switches.has("--run")) return { kind: "dispatcher-run", method: "POST", path: scoutBrokerPaths.v1.vercelBoardDispatcherRun, body: { connectionId, actorId: "operator" } };
  if (!setting) return { kind: "dispatcher", method: "GET", path: `${scoutBrokerPaths.v1.vercelBoardDispatcher}?${new URLSearchParams({ connection: connectionId })}` };
  const body = { connectionId, actorId: "operator" };
  if (flags["--file"]) return { kind: "dispatcher-set", method: "POST", path: scoutBrokerPaths.v1.vercelBoardDispatcher, body, file: flags["--file"] };
  const change = (current: VercelBoardDispatchConfig): VercelBoardDispatchConfig => {
    const next: VercelBoardDispatchConfig = structuredClone(current);
    if (switches.has("--pause")) next.enabled = false;
    if (switches.has("--resume")) delete next.enabled;
    if (!channel) {
      if (flags["--policy"]) next.policy = flags["--policy"];
      return next;
    }
    const channels = { ...next.channels };
    if (switches.has("--default")) {
      delete channels[channel];
    } else {
      const own: VercelBoardChannelDispatchConfig = { ...channels[channel] };
      if (flags["--policy"]) { own.policy = flags["--policy"]; delete own.steps; }
      if (flags["--labels"] !== undefined) own.labels = list(flags["--labels"]);
      const trust = { ...own.trust };
      if (flags["--trust-authors"]) trust.authors = flags["--trust-authors"] as NonNullable<typeof trust.authors>;
      if (flags["--trust-authors"] === "operator") delete trust.authors;
      if (switches.has("--trust-any-epoch")) trust.anyEpoch = true;
      if (flags["--trust-synced"] !== undefined) trust.synced = list(flags["--trust-synced"]);
      if (!trust.synced?.length) delete trust.synced;
      if (Object.keys(trust).length) own.trust = trust; else delete own.trust;
      channels[channel] = own;
    }
    if (Object.keys(channels).length) next.channels = channels; else delete next.channels;
    return next;
  };
  return { kind: "dispatcher-set", method: "POST", path: scoutBrokerPaths.v1.vercelBoardDispatcher, body, change };
}

/** A settings file holds the block itself, or `{ "dispatch": { ... } }`. */
export function readVercelBoardDispatchFile(path: string, cwd = process.cwd()): VercelBoardDispatchConfig {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(resolve(cwd, path), "utf8"));
  } catch (error) {
    throw new ScoutCliError(`Could not read the dispatch settings in ${path}: ${error instanceof Error ? error.message : "unreadable"}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ScoutCliError(`${path} must hold a JSON object.`);
  const block = (value as Record<string, unknown>).dispatch ?? value;
  return block as VercelBoardDispatchConfig;
}

function formatDecision(decision: VercelBoardDispatchDecision): string {
  const head = `${new Date(decision.at).toISOString()} ${decision.taskId} (${decision.channel || "?"}, ${decision.policy || "no policy"}): `;
  if (decision.outcome === "claim") {
    const result = decision.claimed === false ? `claim failed: ${decision.error ?? "unknown"}` : decision.claimed ? "claimed" : "would claim";
    return `${head}${result} for ${decision.agentId} as ${decision.profile}`;
  }
  return `${head}skipped${decision.step ? ` at ${decision.step}` : ""}: ${decision.reason ?? "no reason"}`;
}

function formatClaim(claim: VercelBoardClaimStatus, now = Date.now()): string {
  const at = (ms: number | null) => (ms === null ? "unknown" : new Date(ms).toISOString());
  const left = claim.until === null ? "" : `, ${Math.max(0, Math.round((claim.until - now) / 1000))}s left`;
  return `    ${claim.taskId}: ${claim.state} by ${claim.agentId} as ${claim.profile}, epoch ${claim.epoch ?? "pending"}; lease ${claim.leaseSeconds}s until ${at(claim.until)}${left}`
    + `; renewed ${at(claim.renewedAt)}${claim.renewDueAt !== null ? `, next renewal ${at(claim.renewDueAt)}` : ""}`
    + `${claim.startedBy === "scout:vercel-board-matcher" ? "; started by the dispatcher" : ""}`;
}

function formatDispatcher(status: VercelBoardDispatcherStatus): string {
  return [
    `${status.connectionId}: dispatcher ${status.enabled ? "on" : "paused (held claims keep renewing)"}; default policy ${status.policy}`,
    `  Wakes on feed events that leave a task ready, and every ${Math.round(status.wakes.sweepMs / 1000)}s${status.lastPassAt ? `; last pass ${new Date(status.lastPassAt).toISOString()}` : ""}`,
    "  Channels:",
    ...status.channels.map(channel => {
      const extra = [
        ...(channel.guardsRemoved.length ? [`guards removed: ${channel.guardsRemoved.join(", ")}`] : []),
        ...(channel.trust ? [`trust: ${JSON.stringify(channel.trust)}`] : []),
        ...(channel.labelTrust?.length ? [`label trust: ${channel.labelTrust.map(entry => `${entry.label} ${JSON.stringify(entry.trust)}`).join("; ")}`] : []),
        ...(channel.labels?.length ? [`labels: ${channel.labels.join(", ")}`] : []),
        ...(channel.mirrored ? [] : ["not mirrored, so never dispatched"]),
      ];
      return `    ${channel.channel}: ${channel.policy} (${channel.steps.join(" > ")})${extra.length ? `\n      ${extra.join("\n      ")}` : ""}`;
    }),
    ...(Object.keys(status.capabilities).length ? [`  Capabilities: ${Object.entries(status.capabilities).map(([selector, agents]) => `${selector} -> ${agents.join(", ")}`).join("; ")}`] : []),
    ...(Object.keys(status.policies).length ? [`  Defined policies: ${Object.entries(status.policies).map(([name, steps]) => `${name} (${steps.join(" > ")})`).join("; ")}`] : []),
    `  Claims:${status.claims.length ? "" : " none held"}`,
    ...status.claims.map(claim => formatClaim(claim)),
    ...(status.recent.length ? ["  Recent decisions:", ...status.recent.slice(-10).map(decision => `    ${formatDecision(decision)}`)] : []),
  ].join("\n");
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
    `  Connected on: ${status.custodianNodeId}${status.custodianNodeId === status.nodeId ? " (this host)" : ""}`,
    "  Channels:",
    ...channels,
    ...(status.roles ? [`  Roles: ${status.roles.join(", ")}; self-serve: ${status.selfServe?.length ? status.selfServe.join(", ") : "none"}`] : []),
    `  Board sync: ${status.syncChannels?.length ? status.syncChannels.join(", ") : "off"}`,
    ...(status.declared?.length ? [`  Declared: ${status.declared.map(entry => `${entry.agentId} (${entry.role})`).join(", ")}`] : []),
    ...(status.dispatcher ? [`  Dispatch${status.dispatcher.enabled ? "" : " (paused)"}: ${status.dispatcher.channels.map(entry => `${entry.channel} ${entry.policy}${entry.relaxed ? " (relaxed)" : ""}`).join(", ")}`] : []),
    `  Claims: ${status.custody.held} held, ${status.custody.blocked ?? 0} held for a person, ${status.custody.settling} settling, ${status.custody.lost} lost; outbox: ${status.outbox.pending} pending, ${status.outbox.unknown} unknown, ${status.outbox.failed} failed`,
    ...(status.claims?.length ? ["  Leases:", ...status.claims.map(claim => formatClaim(claim))] : []),
    ...(status.lastGoodReadAt ? [`  Last good read: ${new Date(status.lastGoodReadAt).toISOString()}`] : []),
    ...(status.detail ? [`  ${status.detail}`] : []),
    ...(status.fix ? [`  Fix: ${status.fix}`] : []),
  ].join("\n");
}

export async function runVercelBoardCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (!args.length || args.some(arg => ["--help", "-h", "help"].includes(arg))) { context.output.writeText(VERCEL_BOARD_HELP); return; }
  const request = parseVercelBoardCommand(args, context.env);
  const call = async (method: "GET" | "POST", path: string, body?: Record<string, unknown>) => {
    const response = await fetch(new URL(path, resolveScoutBrokerUrl()), {
      method, headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(request.kind === "connect" ? 90_000 : 30_000),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, any>;
    if (!response.ok) {
      throw new ScoutCliError([payload.message ?? payload.error ?? `Broker returned HTTP ${response.status}`, ...(payload.fix ? [`Fix: ${payload.fix}`] : [])].join("\n"));
    }
    return payload;
  };
  if (request.kind === "dispatcher-set") {
    let dispatch: VercelBoardDispatchConfig;
    if (request.file) dispatch = readVercelBoardDispatchFile(request.file, context.cwd);
    else {
      const connectionId = String(request.body!.connectionId);
      const current = await call("GET", `${scoutBrokerPaths.v1.vercelBoardDispatcher}?${new URLSearchParams({ connection: connectionId })}`) as VercelBoardDispatcherStatus;
      dispatch = request.change!(current.config ?? {});
    }
    const status = await call("POST", request.path, { ...request.body, dispatch }) as VercelBoardDispatcherStatus;
    context.output.writeValue(status, () => formatDispatcher(status));
    return;
  }
  const payload = await call(request.method, request.path, request.body);
  if (request.kind === "dispatcher") {
    context.output.writeValue(payload, () => formatDispatcher(payload as VercelBoardDispatcherStatus));
    return;
  }
  if (request.kind === "dispatcher-explain" || request.kind === "dispatcher-run") {
    const { decisions } = payload as VercelBoardDispatchRunResponse;
    context.output.writeValue(payload, () => {
      if (!decisions.length) return request.kind === "dispatcher-run" ? "The pass changed no decision." : "No decision.";
      return decisions.map(decision => [formatDecision(decision), ...decision.trail.map(entry => `    ${entry.step}: ${entry.result}${entry.note ? ` (${entry.note})` : ""}`)].join("\n")).join("\n");
    });
    return;
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
