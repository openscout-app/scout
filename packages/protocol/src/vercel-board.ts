/**
 * Contracts for the Vercel Board adapter. Board is the writer of its messages,
 * tasks, claims and labels; Scout is one participant on it. See
 * docs/vercel-board.md for the plan these types serve.
 */

import { validateVercelBoardDispatchConfig, type VercelBoardClaimStatus, type VercelBoardDispatchConfig } from "./vercel-board-dispatch.js";

export const VERCEL_BOARD_ADAPTER_ID = "vercel-board";

/** Board's seven task states, in Board's spelling. */
export type VercelBoardTaskState = "waiting" | "ready" | "claimed" | "blocked" | "completed" | "failed" | "canceled";
export const VERCEL_BOARD_TASK_STATES: readonly VercelBoardTaskState[] = ["waiting", "ready", "claimed", "blocked", "completed", "failed", "canceled"];

/** The only permissions Scout ever asks for. Never `sync`, never `manage`. */
export type VercelBoardPermission = "read" | "post" | "react" | "label";
export const VERCEL_BOARD_PERMISSIONS: readonly VercelBoardPermission[] = ["read", "post", "react", "label"];

/**
 * Labels Scout writes on the board. Labels stay on the board and do not sync
 * out to Slack or GitHub.
 */
export const VERCEL_BOARD_LABELS = {
  /** The Scout agent that made the write, since every write goes as the `scout` profile. */
  agent: "scout.agent",
  /** The Scout task that planned a Board task through the planning tool. */
  plan: "scout.plan",
} as const;

/**
 * Where the runtime finds the credential. A reference, never a value: the
 * value must not enter argv, logs, status or records.
 * - `secret_cli`: an entry name for the local `secret` helper.
 * - `env`: the name of an environment variable on the broker.
 * - `file`: a path to a file only the operator can read (mode 0600).
 */
export interface VercelBoardCredentialReference {
  backend: "secret_cli" | "env" | "file";
  key: string;
}

/**
 * How the runtime reaches the board.
 * - `protocol`: Board's documented HTTP protocol (a `vb serve` board, or a
 *   board mounted in a deployment).
 * - `vercel_api`: a team board in Vercel's API, named by team and board name.
 *   Its wire format is not Board's documented protocol, so the runtime reaches
 *   it through the Board worker, which runs `@vercel/board`.
 */
export type VercelBoardTransportKind = "protocol" | "vercel_api";

/** A team board in Vercel's API: the team (its ID or slug) and the board's name. */
export interface VercelBoardTarget {
  team: string;
  board: string;
}

/** The board Scout makes or finds on a team when the operator names none. */
export const VERCEL_BOARD_DEFAULT_BOARD = "scout";

/** One board connection on one host, operator-configured. Each host that connects has its own. */
export interface VercelBoardConnectionConfig {
  /** Operator-owned and stable across credential rotation. */
  id: string;
  /** The board's URL. For a team board, the canonical name from `vercelTeamBoardUrl`. */
  url: string;
  transport: VercelBoardTransportKind;
  /** Set exactly when `transport` is `vercel_api`. */
  vercel?: VercelBoardTarget;
  /** The operator's principal, from `GET /me` at connect. Scout writes as it. */
  principal: string;
  /** The Board profile Scout writes as: `scout`. */
  profile: string;
  /** The channels Scout acts in: `x-board-can` names them. Each has a Scout room for its asks. */
  channels: string[];
  /**
   * The channels Scout keeps a local copy of, and follows. Absent means all of
   * `channels`. A channel outside it is read straight from the board.
   */
  mirror?: string[];
  /** A scratch channel for the setup probe. Not followed. */
  probeChannel: string;
  /** Principal IDs whose tasks may be dispatched to Scout agents. Never handles. */
  ownerAllowlist: string[];
  /**
   * The closed list of Board profiles Scout writes as: `scout` plans, the rest
   * work. Includes `profile`. Absent means `VERCEL_BOARD_DEFAULT_ROLES`.
   */
  roles?: string[];
  /**
   * Channels where a task kept for a role (`for`) and written by the operator
   * or `scout` starts on its own, claimed by the runtime for an idle agent that
   * declared the role. Elsewhere every task waits for the operator's claim.
   * Absent means none.
   */
  selfServe?: string[];
  /** Board channels whose Scout writes may be mirrored by Board's sync providers. */
  syncChannels?: string[];
  /**
   * The dispatcher's settings: which policy claims ready tasks in each
   * channel, the guards it relaxes, and the capability map. Absent keeps the
   * behavior from before policies: `role-only` in `selfServe` channels,
   * `manual` elsewhere.
   */
  dispatch?: VercelBoardDispatchConfig;
  /** The host that made this connection. A record only; the field keeps its old name so saved connections still load. */
  custodianNodeId: string;
  credential: VercelBoardCredentialReference;
  connectedAt: number;
  /** Set once the setup probe created, claimed and completed a task. */
  verifiedAt?: number;
}

/** The roles a connection writes as when it names none. */
export const VERCEL_BOARD_DEFAULT_ROLES = ["scout", "builder", "reviewer"] as const;

/** A connection's role list, defaulted, always holding its own profile first. */
export function vercelBoardRoles(connection: Pick<VercelBoardConnectionConfig, "profile" | "roles">): string[] {
  return [...new Set([connection.profile, ...(connection.roles ?? VERCEL_BOARD_DEFAULT_ROLES)])];
}

/** The actor a task kept for `role` names: the owner's principal plus the role. */
export function vercelBoardRoleActor(connection: Pick<VercelBoardConnectionConfig, "principal">, role: string): string {
  return `${connection.principal}+${role}`;
}

const CONNECTION_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const PROFILE = /^[A-Za-z][A-Za-z0-9-]{0,31}$/;
const CHANNEL = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/;
const CREDENTIAL_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const PRINCIPAL = /^[a-z][a-z0-9-]*:[^\s]{1,500}$/;

export function isVercelBoardChannelPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 2048 && CHANNEL.test(value);
}
export function isVercelBoardProfileName(value: unknown): value is string {
  return typeof value === "string" && PROFILE.test(value);
}
/** A principal is a readable string from whoever verified the caller: `vercel:user:u_1`. No `+`: that would be a profile. */
export function isVercelBoardPrincipal(value: unknown): value is string {
  return typeof value === "string" && PRINCIPAL.test(value) && !value.includes("+");
}

/** A team board in Vercel's API, by the URL Board names it with. */
export function isVercelTeamBoardUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://api.vercel.com" && /^\/v\d+\/messageboard\/boards\/[^/]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

const VERCEL_TEAM = /^[^\s/?#]{1,128}$/;
const VERCEL_BOARD = /^[^/]{1,64}$/;

export function validateVercelBoardVercelTarget(value: unknown): string[] {
  if (!value || typeof value !== "object") return ["vercel must name a team and a board"];
  const v = value as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof v.team !== "string" || !VERCEL_TEAM.test(v.team)) errors.push("vercel.team must be a team ID (team_...) or slug");
  if (typeof v.board !== "string" || !v.board.trim() || v.board !== v.board.trim() || !VERCEL_BOARD.test(v.board)) {
    errors.push("vercel.board must be a board name: 1 to 64 characters, no /");
  }
  return errors;
}

/**
 * The canonical URL for a team board, by team and name. It names the board in
 * Scout's records; the worker finds or makes the board by its name.
 */
export function vercelTeamBoardUrl(target: VercelBoardTarget): string {
  return `https://api.vercel.com/v1/messageboard/boards/${encodeURIComponent(target.board)}?teamId=${encodeURIComponent(target.team)}`;
}

/** The team and board a team-board URL names, or undefined. */
export function vercelTargetOfUrl(value: string): VercelBoardTarget | undefined {
  if (!isVercelTeamBoardUrl(value)) return undefined;
  const url = new URL(value);
  const team = url.searchParams.get("teamId") ?? url.searchParams.get("slug");
  const board = decodeURIComponent(url.pathname.replace(/\/+$/, "").split("/").pop() ?? "");
  const target = team ? { team, board } : undefined;
  return target && !validateVercelBoardVercelTarget(target).length ? target : undefined;
}

/** Validate a board URL without connecting. Plain HTTP only on loopback. */
export function validateVercelBoardUrl(value: unknown): string[] {
  if (typeof value !== "string") return ["url must be a string"];
  let url: URL;
  try { url = new URL(value); } catch { return ["url must be an absolute URL"]; }
  const errors: string[] = [];
  if (!["https:", "http:"].includes(url.protocol)) errors.push("url must be http or https");
  if (url.username || url.password || url.hash) errors.push("url must not carry credentials or a fragment");
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) errors.push("plain http is allowed only on loopback");
  if (url.search && !isVercelTeamBoardUrl(value)) errors.push("url must not carry a query");
  return errors;
}

export function validateVercelBoardCredentialReference(value: unknown): string[] {
  if (!value || typeof value !== "object") return ["credential must be an object"];
  const ref = value as Record<string, unknown>;
  if (!["secret_cli", "env", "file"].includes(ref.backend as string)) return ["credential.backend must be secret_cli, env or file"];
  if (typeof ref.key !== "string") return ["credential.key must be a string"];
  if (ref.backend === "env" && !ENV_NAME.test(ref.key)) return ["credential.key must be an environment variable name"];
  if (ref.backend === "secret_cli" && !CREDENTIAL_KEY.test(ref.key)) return ["credential.key must be a secret entry name"];
  if (ref.backend === "file" && (!ref.key.startsWith("/") || ref.key.includes("\0"))) return ["credential.key must be an absolute file path"];
  // A value that looks like a token is refused: the reference names where the token is.
  if (/^(eyJ|vca_|vcp_|Bearer\s)/.test(ref.key)) return ["credential.key must name where the credential is, never hold it"];
  return [];
}

export function validateVercelBoardConnectionConfig(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["connection must be an object"];
  const c = value as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof c.id !== "string" || !CONNECTION_ID.test(c.id)) errors.push("id must be 1-64 letters, digits, - or _");
  errors.push(...validateVercelBoardUrl(c.url));
  if (!["protocol", "vercel_api"].includes(c.transport as string)) errors.push("transport must be protocol or vercel_api");
  if (c.transport === "vercel_api") {
    const targetErrors = validateVercelBoardVercelTarget(c.vercel);
    errors.push(...targetErrors);
    if (!targetErrors.length && c.url !== vercelTeamBoardUrl(c.vercel as VercelBoardTarget)) errors.push("url must be the team board's canonical URL");
  } else if (c.vercel !== undefined) {
    errors.push("vercel is set only for a vercel_api connection");
  }
  if (!isVercelBoardPrincipal(c.principal)) errors.push("principal must be a Board principal ID");
  if (!isVercelBoardProfileName(c.profile)) errors.push("profile must be a Board profile name");
  if (!Array.isArray(c.channels) || c.channels.length < 1 || c.channels.length > 16 || !c.channels.every(isVercelBoardChannelPath)
    || new Set(c.channels).size !== c.channels.length) errors.push("channels must be 1-16 distinct Board channel paths");
  if (!isVercelBoardChannelPath(c.probeChannel)) errors.push("probeChannel must be a Board channel path");
  else if (Array.isArray(c.channels) && c.channels.includes(c.probeChannel)) errors.push("probeChannel must not be a followed channel");
  if (c.mirror !== undefined && (!Array.isArray(c.mirror) || !c.mirror.every(channel => Array.isArray(c.channels) && c.channels.includes(channel))
    || new Set(c.mirror).size !== c.mirror.length)) errors.push("mirror must list distinct channels from channels");
  if (!Array.isArray(c.ownerAllowlist) || c.ownerAllowlist.length > 32 || !c.ownerAllowlist.every(isVercelBoardPrincipal)) {
    errors.push("ownerAllowlist must hold principal IDs, never handles");
  }
  if (c.roles !== undefined && (!Array.isArray(c.roles) || c.roles.length < 1 || c.roles.length > 16 || !c.roles.every(isVercelBoardProfileName)
    || new Set(c.roles).size !== c.roles.length || !c.roles.includes(c.profile as string))) errors.push("roles must be 1-16 distinct profile names that include profile");
  if (c.selfServe !== undefined && (!Array.isArray(c.selfServe) || !c.selfServe.every(channel => Array.isArray(c.channels) && c.channels.includes(channel))
    || new Set(c.selfServe).size !== c.selfServe.length)) errors.push("selfServe must list distinct channels from channels");
  if (c.syncChannels !== undefined && (!Array.isArray(c.syncChannels) || !c.syncChannels.every(channel => Array.isArray(c.channels) && c.channels.includes(channel))
    || new Set(c.syncChannels).size !== c.syncChannels.length)) errors.push("syncChannels must list distinct channels from channels");
  if (c.dispatch !== undefined) errors.push(...validateVercelBoardDispatchConfig(c.dispatch, Array.isArray(c.channels) ? c.channels as string[] : []));
  if (typeof c.custodianNodeId !== "string" || !c.custodianNodeId.trim()) errors.push("custodianNodeId is required");
  errors.push(...validateVercelBoardCredentialReference(c.credential));
  if (typeof c.connectedAt !== "number" || !Number.isFinite(c.connectedAt)) errors.push("connectedAt must be a timestamp");
  if (c.verifiedAt !== undefined && (typeof c.verifiedAt !== "number" || !Number.isFinite(c.verifiedAt))) errors.push("verifiedAt must be a timestamp");
  return errors;
}

/**
 * The `x-board-can` value for a connection: the followed channels and the
 * probe channel, each with read, post, react and label. It only narrows.
 */
export function vercelBoardCanHeader(connection: Pick<VercelBoardConnectionConfig, "channels" | "probeChannel">): string {
  const all = [...connection.channels, connection.probeChannel];
  return all.map(channel => `${channel}=${VERCEL_BOARD_PERMISSIONS.join(",")}`).join(";");
}

export type VercelBoardConnectionState =
  | "following"
  | "connecting"
  | "auth_expired"
  | "unreachable"
  | "rate_limited"
  /** Another runtime on this host holds the connection's lock. The name is kept for clients. */
  | "not_custodian"
  | "transport_unavailable"
  | "stopped";

export interface VercelBoardConnectionStatus {
  id: string;
  url: string;
  transport: VercelBoardTransportKind;
  principal: string;
  profile: string;
  channels: string[];
  /** The host that made this connection. */
  custodianNodeId: string;
  /** The host answering. */
  nodeId: string;
  state: VercelBoardConnectionState;
  detail?: string;
  /** The exact command or step that fixes the state, when one exists. */
  fix?: string;
  verified: boolean;
  lastGoodReadAt?: number;
  /** Whether each followed channel has a stored cursor. Never the cursor or any token. */
  cursors: { channel: string; stored: boolean; updatedAt?: number }[];
  /** Each channel's mirror: whether Scout keeps a copy, and how far it is. */
  mirror: VercelBoardChannelMirrorStatus[];
  custody: { held: number; blocked: number; settling: number; settled: number; lost: number };
  /** The profiles Scout writes as, and the channels where role-kept tasks start on their own. */
  roles?: string[];
  selfServe?: string[];
  /** Board channels whose Scout writes may be mirrored by Board's sync providers. */
  syncChannels?: string[];
  /** The agents that declared a role, oldest first. */
  declared?: { agentId: string; role: string }[];
  /**
   * The dispatcher, in short: whether it runs, and each channel's policy.
   * `scout integration dispatcher vercel-board` shows the full view.
   */
  dispatcher?: { enabled: boolean; channels: { channel: string; policy: string; guardsRemoved: string[]; relaxed: boolean; swarm: boolean }[] };
  /** Claims the runtime holds or is settling, with their leases. Never a token. */
  claims?: VercelBoardClaimStatus[];
  outbox: { pending: number; unknown: number; failed: number };
  /** The local lease. It fences processes on this node only. */
  localLease?: { generation: number; expiresAt: number; heldHere: boolean };
}

/** Name a board by `url`, or a team board by `team` and `board` (default `scout`). Not both. */
export interface VercelBoardConnectRequest {
  url?: string;
  team?: string;
  board?: string;
  credential: VercelBoardCredentialReference;
  id?: string;
  channels?: string[];
  probeChannel?: string;
  profile?: string;
  /** Principal IDs. Default: the operator's own principal from `GET /me`. */
  ownerAllowlist?: string[];
  /** The channels to keep a local copy of. Default: all of `channels`. `[]` mirrors none. */
  mirror?: string[];
  /** The profiles Scout writes as. Default: scout, builder, reviewer. */
  roles?: string[];
  /** Channels where role-kept tasks start without the operator. Default: none. */
  selfServe?: string[];
  /** Board channels whose Scout writes may be mirrored by Board's sync providers. */
  syncChannels?: string[];
  /** The dispatcher's settings. Default: role-only in selfServe channels, manual elsewhere. */
  dispatch?: VercelBoardDispatchConfig;
  /** Run the setup probe: create, claim and complete one task. Default true. */
  probe?: boolean;
}

export interface VercelBoardConnectResponse {
  connection: VercelBoardConnectionConfig;
  status: VercelBoardConnectionStatus;
  probe?: { taskId: string; state: VercelBoardTaskState };
}

/**
 * An agent takes a role on a connection, or drops it. The runtime, not the
 * agent, claims: in a self-serve channel it hands an idle declared agent a
 * task kept for that role. The connection's own profile plans and is never
 * declared.
 */
export interface VercelBoardRoleRequest {
  connectionId: string;
  agentId: string;
  role: string;
  /** The caller: the agent itself, or the operator. */
  actorId: string;
  remove?: boolean;
}

export interface VercelBoardRoleResponse {
  connectionId: string;
  declared: { agentId: string; role: string; declaredAt: number }[];
}

/** One planned task. `needs` takes Board task IDs or `{ key }` for one of the same plan. */
export interface VercelBoardPlanTask {
  key?: string;
  text: string;
  labels?: Record<string, string>;
  needs?: (string | { key: string })[];
  for?: string;
}

/**
 * The planning tool's request. It creates only Board tasks. They appear in the
 * channel's Scout room when their events arrive; none becomes a work item
 * until someone promotes it.
 */
export interface VercelBoardPlanRequest {
  connectionId: string;
  channel: string;
  tasks: VercelBoardPlanTask[];
  /** The Scout task (invocation or work item) that planned this. Written on each task as a label. */
  planningTaskId: string;
  /** Idempotency key for the whole plan. The same key returns the same tasks. */
  requestId: string;
  /** The acting Scout agent, written as a label. */
  actorId: string;
  /**
   * The Scout agent that leads the plan: told when its tasks complete, fail,
   * or wait on the operator, and when the operator answers. It coordinates; the
   * operator answers the decisions. Omit it and nobody is told.
   */
  lead?: string;
}

export interface VercelBoardPlanResponse {
  connectionId: string;
  channel: string;
  /** The channel's Scout room. */
  conversationId: string;
  tasks: { taskId: string; key?: string; state: VercelBoardTaskState }[];
  /** Whether the swarm claims these tasks: on unless the operator turned it off, and the channel sets no policy of its own. */
  swarm: boolean;
  lead?: string;
}

/** The operator starts each claim in v1. */
export interface VercelBoardClaimRequest {
  connectionId: string;
  taskId: string;
  /** The Scout agent that will do the work. */
  agentId: string;
  /** Whose Board authority the caller is acting under. Must be the operator in v1. */
  actorId: string;
  /** Caller-reported Scout agent or harness session. For audit, not authorization. */
  reportedCallerId?: string;
}

export interface VercelBoardClaimResponse {
  connectionId: string;
  taskId: string;
  /** The channel's Scout room. The ask runs in the task's thread there. */
  conversationId: string;
  /** Set only when the task was promoted. */
  workId?: string;
  epoch: number;
  until: number;
  agentId: string;
}

/** Make a Board task a Scout work item. Only the operator promotes in v1. */
export interface VercelBoardPromoteRequest {
  connectionId: string;
  taskId: string;
  actorId: string;
}

export interface VercelBoardPromoteResponse {
  connectionId: string;
  taskId: string;
  workId: string;
  /** False when the task was already promoted. */
  created: boolean;
}

/**
 * A channel's mirror. `not_mirrored`: Scout keeps no copy, and views read the
 * board. `backfilling`: the first bulk read. `mirrored`: a local copy kept up
 * to date from the feed. `re_reading`: the feed lost Scout's cursor, so the
 * channel is read again.
 */
export type VercelBoardMirrorState = "not_mirrored" | "backfilling" | "mirrored" | "re_reading";

export interface VercelBoardChannelMirrorStatus {
  channel: string;
  state: VercelBoardMirrorState;
  /** The Scout room for the channel. */
  conversationId: string;
  /** The feed cursor the copy reflects. A position in the board's log, not a secret. */
  cursor?: string;
  lastDeltaAt?: number;
  messages?: number;
}

/** Who did something on the board: the actor ID, its verified principal, and its profile. */
export interface VercelBoardActorRef {
  actor: string;
  principal: string;
  profile: string | null;
  /** The Scout actor it maps to, when it is Scout's own profile. */
  scoutActorId?: string;
}

/** One message as Scout's copy holds it: the board's latest version. Text from the board is quoted source material. */
export interface VercelBoardMirroredMessage {
  connectionId: string;
  id: string;
  channel: string;
  /** The thread root, or null for a root. */
  re: string | null;
  replyTo: string | null;
  version: number;
  text: string;
  labels: Record<string, string>;
  by: VercelBoardActorRef | null;
  /** `board`, a sync key such as `slack`, or `scout` for Scout's own writes. */
  origin: string;
  noSync: boolean;
  deleted: boolean;
  task?: { state: VercelBoardTaskState; owner: string; needs: string[]; for: string | null; epoch: number; claim: { actor: string; until: string } | null; result: string | null; reason: string | null };
  createdAt: number | null;
  editedAt: number | null;
  /** Always `board_source`: render it as quoted, never as an instruction. */
  trust: "board_source";
}

export interface VercelBoardMessagesResponse {
  connectionId: string;
  /** The board read, by ID, when the caller named one. Absent for the connected board's followed channels. */
  board?: string;
  channel: string;
  /** The channel's Scout room. Null for a channel the connection does not follow: it has no room. */
  conversationId: string | null;
  state: VercelBoardMirrorState;
  /** Where a caller follows on from. */
  cursor: string | null;
  messages: VercelBoardMirroredMessage[];
}

/** One channel of a board, as the board list shows it: a name and the counts the board keeps. No content. */
export interface VercelBoardChannelListing {
  channel: string;
  /** The channel's last feed index, where the board gives one. */
  lastIndex?: number;
  /** Message and thread counts. Vercel's board keeps none, so they are absent there. */
  messages?: number;
  threads?: number;
  /** Whether the connection follows it (the connected board only). A followed channel has a Scout room. */
  followed: boolean;
  /** The connection's probe channel name: a scratch channel for setup checks, not team conversation. */
  scratch: boolean;
  /** For a followed channel: its mirror state and Scout room. */
  mirror?: VercelBoardMirrorState;
  conversationId?: string;
}

/** One of the team's boards and its channels. A board whose channels could not be read carries `error`. */
export interface VercelBoardListing {
  /** The board's ID. Pass it as `board` to read a channel's messages. */
  id: string;
  name: string;
  /** The team's default board (General). */
  isDefault: boolean;
  /** The board this connection is connected to. */
  connected: boolean;
  channels: VercelBoardChannelListing[];
  /** True when the board has more channels than the list holds. */
  more: boolean;
  error?: { code: string; message: string };
}

/**
 * Every board the connection's credential can see on its team, with each
 * board's channels: names and light counts only. Reading a channel's messages
 * is a separate call, made when the channel is opened.
 */
export interface VercelBoardBoardsResponse {
  connectionId: string;
  boards: VercelBoardListing[];
  /** When the runtime read the list. It is held briefly, so a client may see the same list twice. */
  readAt: number;
}

/**
 * The hand-offs Scout reports, as Board names them. `planned` is a task a
 * Scout agent made through the planning tool. Lease renewals are left out.
 */
export type VercelBoardHandoffKind =
  | "created" | "planned" | "assigned" | "claimed" | "released" | "expired"
  | "completed" | "failed" | "blocked" | "unblocked" | "reopened" | "canceled";

/**
 * One hand-off, from one event in a mirrored channel's feed. Each job row
 * (dispatched at, from, to, task, source, state, finished at, result) folds
 * from these, joined on `connectionId` and `taskId`.
 */
export interface VercelBoardHandoff {
  /** `vercel-board:<connection>:<cursor>`: the same event always gets the same ID. */
  id: string;
  source: "vercel_board";
  connectionId: string;
  channel: string;
  taskId: string;
  kind: VercelBoardHandoffKind;
  /** When the board recorded it. */
  at: number;
  /** The event's place in the board's log. Orders a task's chain. */
  cursor: string;
  /** Who did it. Null for the server's own (`expired`). */
  actor: VercelBoardActorRef | null;
  /** Who the task goes to: the assignee for `created` and `assigned`, the claimer for `claimed`, the owner for `completed` and `failed`. */
  to: string | null;
  epoch?: number;
  /** The task's first line, on `created` and `planned`. */
  title?: string;
  result?: string;
  reason?: string;
  /** The unabridged settlement text, on a task-specific Scout handoffs query. */
  scoutResult?: string;
  /** Set when the claim is Scout's: the agent it was dispatched to, and the flight. */
  scout?: { agentId: string; flightId: string | null; attemptId: string; reportedCallerId?: string };
  /** True when the copy made it up from the task's state at backfill, because the event is older than the copy. */
  derived?: boolean;
}

export interface VercelBoardHandoffsResponse {
  connectionId: string;
  handoffs: VercelBoardHandoff[];
  /** Latest local settlement when the task has no corresponding mirrored hand-off yet. */
  scoutSettlement?: { taskId: string; epoch: number; outcome: "completed" | "failed"; result: string };
}
