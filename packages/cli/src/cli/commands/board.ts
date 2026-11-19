import { scoutBrokerPaths, type BoardClaimResponse, type BoardConnectResponse, type BoardConnectionStatus, type BoardCredentialReference } from "@openscout/protocol";
import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { resolveScoutBrokerUrl } from "../../lib/core/broker/service.ts";

export const BOARD_HELP = [
  "scout board connect --team <team ID or slug> [--board scout] --credential secret_cli:<entry>|env:<NAME>|file:<absolute path>",
  "scout board connect --url <board url> --credential ...",
  "    [--id <connection>] [--channels work,decisions] [--probe-channel scout-probe] [--allow <principal>,...] [--no-probe]",
  "    [--experimental-marker [--takeover]]",
  "scout board status [--connection <id>]",
  "scout board claim --connection <id> --task <board task id> --agent <scout agent id> [--confirm-owner]",
  "",
  "Connects this node as the custodian of one Vercel Board, as the operator's principal with the `scout` profile.",
  "--team names your Vercel team's board by name (default: scout). Scout finds the board or makes it, makes the channels,",
  "and reaches it through the Board worker, which runs @vercel/board on Node 24 (set SCOUT_BOARD_NODE on the broker).",
  "--url names a board that serves Board's documented protocol, such as a `vb serve` board.",
  "The credential is a reference: Scout reads it on the broker and never prints it. Do not pass a token here.",
  "For Vercel, create an access token once and store it with: secret set <entry>. Do not reuse the Vercel CLI login.",
  "Connect runs a probe: it creates, claims and completes one task in the probe channel, and saves the connection only if that works.",
  "--allow takes principal IDs (vercel:user:u_...), never handles. The default is your own principal.",
  "--experimental-marker keeps a custodian marker on the board. It is untested against Vercel's board.",
  "claim starts a claim for the operator and dispatches the task to the agent. Only the operator starts claims.",
].join("\n");

type Parsed = { method: "GET" | "POST"; path: string; body?: Record<string, unknown>; kind: "connect" | "status" | "claim" };

const VALUE_FLAGS: Record<string, string[]> = {
  connect: ["--url", "--team", "--board", "--credential", "--id", "--channels", "--probe-channel", "--allow"],
  status: ["--connection"],
  claim: ["--connection", "--task", "--agent"],
};
const BOOLEAN_FLAGS: Record<string, string[]> = {
  connect: ["--no-probe", "--experimental-marker", "--takeover"],
  status: [],
  claim: ["--confirm-owner"],
};

export function parseCredentialReference(value: string): BoardCredentialReference {
  const index = value.indexOf(":");
  const backend = value.slice(0, index);
  const key = value.slice(index + 1);
  if (index < 1 || !["secret_cli", "env", "file"].includes(backend) || !key) {
    throw new ScoutCliError("--credential takes secret_cli:<entry>, env:<NAME> or file:<absolute path>. It names where the token is; never pass the token.");
  }
  return { backend: backend as BoardCredentialReference["backend"], key };
}

export function parseBoardCommand(args: string[]): Parsed {
  const [command, ...rest] = args;
  if (!command || !(command in VALUE_FLAGS)) throw new ScoutCliError("Use scout board connect, status or claim. See scout board --help.");
  const flags: Record<string, string> = {};
  const switches = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (BOOLEAN_FLAGS[command]!.includes(flag)) { switches.add(flag); continue; }
    if (!VALUE_FLAGS[command]!.includes(flag) || flags[flag] !== undefined) throw new ScoutCliError(`Unknown or repeated option ${flag}. See scout board --help.`);
    const value = rest[++i];
    if (!value?.trim() || value.startsWith("--")) throw new ScoutCliError(`${flag} requires a value`);
    flags[flag] = value;
  }
  const list = (value: string | undefined) => value?.split(",").map(item => item.trim()).filter(Boolean);
  if (command === "status") {
    return { kind: "status", method: "GET", path: `${scoutBrokerPaths.v1.boardStatus}${flags["--connection"] ? `?connection=${encodeURIComponent(flags["--connection"])}` : ""}` };
  }
  if (command === "claim") {
    for (const flag of ["--connection", "--task", "--agent"]) if (!flags[flag]) throw new ScoutCliError(`scout board claim requires ${flag}.`);
    return { kind: "claim", method: "POST", path: scoutBrokerPaths.v1.boardClaim, body: {
      connectionId: flags["--connection"], taskId: flags["--task"], agentId: flags["--agent"], actorId: "operator",
      ...(switches.has("--confirm-owner") ? { confirmOwner: true } : {}),
    } };
  }
  if (flags["--url"] && (flags["--team"] || flags["--board"])) throw new ScoutCliError("Name the board with --team and --board, or with --url, not both.");
  if (flags["--board"] && !flags["--team"]) throw new ScoutCliError("--board needs --team.");
  if ((!flags["--url"] && !flags["--team"]) || !flags["--credential"]) throw new ScoutCliError("scout board connect requires --team (or --url) and --credential.");
  if (switches.has("--takeover") && !switches.has("--experimental-marker")) throw new ScoutCliError("--takeover applies only with --experimental-marker.");
  return { kind: "connect", method: "POST", path: scoutBrokerPaths.v1.boardConnect, body: {
    ...(flags["--url"] ? { url: flags["--url"] } : { team: flags["--team"], ...(flags["--board"] ? { board: flags["--board"] } : {}) }),
    credential: parseCredentialReference(flags["--credential"]),
    ...(flags["--id"] ? { id: flags["--id"] } : {}),
    ...(flags["--channels"] ? { channels: list(flags["--channels"]) } : {}),
    ...(flags["--probe-channel"] ? { probeChannel: flags["--probe-channel"] } : {}),
    ...(flags["--allow"] ? { ownerAllowlist: list(flags["--allow"]) } : {}),
    ...(switches.has("--no-probe") ? { probe: false } : {}),
    ...(switches.has("--experimental-marker") ? { experimentalMarker: true } : {}),
    ...(switches.has("--takeover") ? { takeover: true } : {}),
  } };
}

function formatStatus(status: BoardConnectionStatus): string {
  const cursors = status.cursors.map(cursor => `${cursor.channel}${cursor.stored ? "" : " (no cursor yet)"}`).join(", ");
  return [
    `${status.id}: ${status.state}${status.verified ? "" : " (not verified)"}`,
    `  Board: ${status.url} as ${status.principal}+${status.profile}`,
    `  Custodian: ${status.custodianNodeId}${status.custodianNodeId === status.nodeId ? " (this node)" : ""}`,
    `  Channels: ${cursors}`,
    `  Claims: ${status.custody.held} held, ${status.custody.settling} settling, ${status.custody.lost} lost; outbox: ${status.outbox.pending} pending, ${status.outbox.unknown} unknown, ${status.outbox.failed} failed`,
    ...(status.lastGoodReadAt ? [`  Last good read: ${new Date(status.lastGoodReadAt).toISOString()}`] : []),
    ...(status.detail ? [`  ${status.detail}`] : []),
    ...(status.fix ? [`  Fix: ${status.fix}`] : []),
  ].join("\n");
}

export async function runBoardCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (!args.length || args.some(arg => ["--help", "-h", "help"].includes(arg))) { context.output.writeText(BOARD_HELP); return; }
  const request = parseBoardCommand(args);
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
    const connections = (payload.connections ?? []) as BoardConnectionStatus[];
    context.output.writeValue(payload, () => connections.length ? connections.map(formatStatus).join("\n\n") : "No board connections. Run: scout board connect --help");
    return;
  }
  if (request.kind === "claim") {
    const claim = payload as BoardClaimResponse;
    context.output.writeValue(payload, () => `Claimed ${claim.taskId} for ${claim.agentId} (epoch ${claim.epoch}, until ${new Date(claim.until).toISOString()}). Work item: ${claim.workId}`);
    return;
  }
  const connected = payload as BoardConnectResponse;
  context.output.writeValue(payload, () => [
    `Connected ${connected.connection.id} as ${connected.connection.principal}+${connected.connection.profile}.`,
    connected.probe ? `Probe task ${connected.probe.taskId}: ${connected.probe.state}.` : "Probe skipped: the connection is not verified.",
    formatStatus(connected.status),
  ].join("\n"));
}
