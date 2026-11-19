/**
 * Contracts for the Vercel Board adapter. Board is the writer of its messages,
 * tasks, claims and labels; Scout is one participant on it. See
 * docs/vercel-board.md for the plan these types serve.
 */

export const BOARD_ADAPTER_ID = "vercel-board";

/** Board's seven task states, in Board's spelling. */
export type BoardTaskState = "waiting" | "ready" | "claimed" | "blocked" | "completed" | "failed" | "canceled";
export const BOARD_TASK_STATES: readonly BoardTaskState[] = ["waiting", "ready", "claimed", "blocked", "completed", "failed", "canceled"];

/** The only permissions Scout ever asks for. Never `sync`, never `manage`. */
export type BoardPermission = "read" | "post" | "react" | "label";
export const BOARD_PERMISSIONS: readonly BoardPermission[] = ["read", "post", "react", "label"];

/**
 * Labels Scout writes on the board. Labels stay on the board and do not sync
 * out to Slack or GitHub.
 */
export const BOARD_LABELS = {
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
export interface BoardCredentialReference {
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
export type BoardTransportKind = "protocol" | "vercel_api";

/** A team board in Vercel's API: the team (its ID or slug) and the board's name. */
export interface BoardVercelTarget {
  team: string;
  board: string;
}

/** The board Scout makes or finds on a team when the operator names none. */
export const BOARD_DEFAULT_VERCEL_BOARD = "scout";

/** One board connection, operator-configured. One custodian per (board, principal). */
export interface BoardConnectionConfig {
  /** Operator-owned and stable across credential rotation. */
  id: string;
  /** The board's URL. For a team board, the canonical name from `vercelTeamBoardUrl`. */
  url: string;
  transport: BoardTransportKind;
  /** Set exactly when `transport` is `vercel_api`. */
  vercel?: BoardVercelTarget;
  /** The operator's principal, from `GET /me` at connect. Scout writes as it. */
  principal: string;
  /** The Board profile Scout writes as: `scout`. */
  profile: string;
  /** Followed channels. A channel is a filter, not a Scout channel. */
  channels: string[];
  /** A scratch channel for the setup probe. Not followed. */
  probeChannel: string;
  /** Principal IDs whose tasks may be dispatched to Scout agents. Never handles. */
  ownerAllowlist: string[];
  /** The node recorded as custodian. A record, not a cross-host fence. */
  custodianNodeId: string;
  credential: BoardCredentialReference;
  connectedAt: number;
  /** Set once the setup probe created, claimed and completed a task. */
  verifiedAt?: number;
}

const CONNECTION_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const PROFILE = /^[A-Za-z][A-Za-z0-9-]{0,31}$/;
const CHANNEL = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/;
const CREDENTIAL_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const PRINCIPAL = /^[a-z][a-z0-9-]*:[^\s]{1,500}$/;

export function isBoardChannelPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 2048 && CHANNEL.test(value);
}
export function isBoardProfileName(value: unknown): value is string {
  return typeof value === "string" && PROFILE.test(value);
}
/** A principal is a readable string from whoever verified the caller: `vercel:user:u_1`. No `+`: that would be a profile. */
export function isBoardPrincipal(value: unknown): value is string {
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

export function validateBoardVercelTarget(value: unknown): string[] {
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
export function vercelTeamBoardUrl(target: BoardVercelTarget): string {
  return `https://api.vercel.com/v1/messageboard/boards/${encodeURIComponent(target.board)}?teamId=${encodeURIComponent(target.team)}`;
}

/** The team and board a team-board URL names, or undefined. */
export function vercelTargetOfUrl(value: string): BoardVercelTarget | undefined {
  if (!isVercelTeamBoardUrl(value)) return undefined;
  const url = new URL(value);
  const team = url.searchParams.get("teamId") ?? url.searchParams.get("slug");
  const board = decodeURIComponent(url.pathname.replace(/\/+$/, "").split("/").pop() ?? "");
  const target = team ? { team, board } : undefined;
  return target && !validateBoardVercelTarget(target).length ? target : undefined;
}

/** Validate a board URL without connecting. Plain HTTP only on loopback. */
export function validateBoardUrl(value: unknown): string[] {
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

export function validateBoardCredentialReference(value: unknown): string[] {
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

export function validateBoardConnectionConfig(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["connection must be an object"];
  const c = value as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof c.id !== "string" || !CONNECTION_ID.test(c.id)) errors.push("id must be 1-64 letters, digits, - or _");
  errors.push(...validateBoardUrl(c.url));
  if (!["protocol", "vercel_api"].includes(c.transport as string)) errors.push("transport must be protocol or vercel_api");
  if (c.transport === "vercel_api") {
    const targetErrors = validateBoardVercelTarget(c.vercel);
    errors.push(...targetErrors);
    if (!targetErrors.length && c.url !== vercelTeamBoardUrl(c.vercel as BoardVercelTarget)) errors.push("url must be the team board's canonical URL");
  } else if (c.vercel !== undefined) {
    errors.push("vercel is set only for a vercel_api connection");
  }
  if (!isBoardPrincipal(c.principal)) errors.push("principal must be a Board principal ID");
  if (!isBoardProfileName(c.profile)) errors.push("profile must be a Board profile name");
  if (!Array.isArray(c.channels) || c.channels.length < 1 || c.channels.length > 16 || !c.channels.every(isBoardChannelPath)
    || new Set(c.channels).size !== c.channels.length) errors.push("channels must be 1-16 distinct Board channel paths");
  if (!isBoardChannelPath(c.probeChannel)) errors.push("probeChannel must be a Board channel path");
  else if (Array.isArray(c.channels) && c.channels.includes(c.probeChannel)) errors.push("probeChannel must not be a followed channel");
  if (!Array.isArray(c.ownerAllowlist) || c.ownerAllowlist.length > 32 || !c.ownerAllowlist.every(isBoardPrincipal)) {
    errors.push("ownerAllowlist must hold principal IDs, never handles");
  }
  if (typeof c.custodianNodeId !== "string" || !c.custodianNodeId.trim()) errors.push("custodianNodeId is required");
  errors.push(...validateBoardCredentialReference(c.credential));
  if (typeof c.connectedAt !== "number" || !Number.isFinite(c.connectedAt)) errors.push("connectedAt must be a timestamp");
  if (c.verifiedAt !== undefined && (typeof c.verifiedAt !== "number" || !Number.isFinite(c.verifiedAt))) errors.push("verifiedAt must be a timestamp");
  return errors;
}

/**
 * The `x-board-can` value for a connection: the followed channels and the
 * probe channel, each with read, post, react and label. It only narrows.
 */
export function boardCanHeader(connection: Pick<BoardConnectionConfig, "channels" | "probeChannel">): string {
  const all = [...connection.channels, connection.probeChannel];
  return all.map(channel => `${channel}=${BOARD_PERMISSIONS.join(",")}`).join(";");
}

export type BoardConnectionState =
  | "following"
  | "connecting"
  | "auth_expired"
  | "unreachable"
  | "rate_limited"
  | "not_custodian"
  | "transport_unavailable"
  | "stopped";

export interface BoardConnectionStatus {
  id: string;
  url: string;
  transport: BoardTransportKind;
  principal: string;
  profile: string;
  channels: string[];
  custodianNodeId: string;
  /** This node. Status is answered by the node asked, which may not be the custodian. */
  nodeId: string;
  state: BoardConnectionState;
  detail?: string;
  /** The exact command or step that fixes the state, when one exists. */
  fix?: string;
  verified: boolean;
  lastGoodReadAt?: number;
  /** Whether each followed channel has a stored cursor. Never the cursor or any token. */
  cursors: { channel: string; stored: boolean; updatedAt?: number }[];
  custody: { held: number; settling: number; settled: number; lost: number };
  outbox: { pending: number; unknown: number; failed: number };
  /** The local lease. It fences processes on this node only. */
  localLease?: { generation: number; expiresAt: number; heldHere: boolean };
}

/** Name a board by `url`, or a team board by `team` and `board` (default `scout`). Not both. */
export interface BoardConnectRequest {
  url?: string;
  team?: string;
  board?: string;
  credential: BoardCredentialReference;
  id?: string;
  channels?: string[];
  probeChannel?: string;
  profile?: string;
  /** Principal IDs. Default: the operator's own principal from `GET /me`. */
  ownerAllowlist?: string[];
  /** Run the setup probe: create, claim and complete one task. Default true. */
  probe?: boolean;
}

export interface BoardConnectResponse {
  connection: BoardConnectionConfig;
  status: BoardConnectionStatus;
  probe?: { taskId: string; state: BoardTaskState };
}

/** One planned task. `needs` takes Board task IDs or `{ key }` for one of the same plan. */
export interface BoardPlanTask {
  key?: string;
  text: string;
  labels?: Record<string, string>;
  needs?: (string | { key: string })[];
  for?: string;
}

/**
 * The planning tool's request. It creates only Board tasks; the work items
 * appear through projection when the tasks' events arrive.
 */
export interface BoardPlanRequest {
  connectionId: string;
  channel: string;
  tasks: BoardPlanTask[];
  /** The Scout task (invocation or work item) that planned this. Written on each task as a label. */
  planningTaskId: string;
  /** Idempotency key for the whole plan. The same key returns the same tasks. */
  requestId: string;
  /** The acting Scout agent, written as a label. */
  actorId: string;
}

export interface BoardPlanResponse {
  connectionId: string;
  channel: string;
  tasks: { taskId: string; workId: string; key?: string; state: BoardTaskState }[];
}

/** The operator starts each claim in v1. */
export interface BoardClaimRequest {
  connectionId: string;
  taskId: string;
  /** The Scout agent that will do the work. */
  agentId: string;
  /** Who started the claim. Must be the operator in v1. */
  actorId: string;
}

export interface BoardClaimResponse {
  connectionId: string;
  taskId: string;
  workId: string;
  epoch: number;
  until: number;
  agentId: string;
}
