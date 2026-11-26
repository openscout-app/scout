import { VERCEL_BOARD_LABELS, vercelBoardCanHeader, type VercelBoardConnectionConfig, type VercelBoardPlanTask } from "@openscout/protocol";
import { boardResultExcerpt, parseVercelBoardEvent, parseVercelBoardMessage, parseVercelBoardMessagesPage, parseVercelBoardTaskSummary, type VercelBoardWireEvent, type VercelBoardWireMessage } from "./wire.js";

/**
 * A refusal or failure from the board, by Board's status and code. The body's
 * message is kept only when it is short; a credential never appears in one.
 */
export class VercelBoardHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfterMs?: number, readonly hint?: string) {
    super(message);
    this.name = "VercelBoardHttpError";
  }
}
/** The request may or may not have landed: no answer came back. */
export class VercelBoardUnknownOutcomeError extends Error {
  constructor(readonly operation: string, cause: unknown) {
    super(`vercel_board_outcome_unknown: ${operation} sent, no answer (${cause instanceof Error ? cause.name : "error"})`);
    this.name = "VercelBoardUnknownOutcomeError";
  }
}

export interface VercelBoardClaimGrant { epoch: number; token: string; until: number }
export interface VercelBoardMe { actor: string; principal: string; profile: string | null; expiresAt: number | null }

/**
 * The closed set of operations the runtime uses. A transport carries them;
 * it holds no claim token, cursor or retry policy of its own. A second
 * transport (the Vercel API worker) implements the same interface.
 */
export type VercelBoardBlockKind = "needs_input" | "awaiting_approval";

export interface VercelBoardTransport {
  me(signal?: AbortSignal): Promise<VercelBoardMe>;
  ensureChannel(channel: string): Promise<void>;
  events(query: { channel: string; after?: string; wait?: number; signal?: AbortSignal }): Promise<{ events: VercelBoardWireEvent[]; cursor: string }>;
  tasks(query: { channel: string; state?: string; after?: string; limit?: number }): Promise<{ tasks: VercelBoardWireMessage[]; cursor: string | null }>;
  /** One channel's messages across its threads, oldest first: the newest `limit`, or with `after` the ones since. One call. */
  channelMessages(query: { channel: string; after?: string; limit?: number }): Promise<{ messages: VercelBoardWireMessage[]; cursor: string | null }>;
  message(id: string): Promise<VercelBoardWireMessage | null>;
  post(input: { channel?: string; re?: string; text: string; labels?: Record<string, string>; id: string; noSync?: boolean }): Promise<VercelBoardWireMessage>;
  postById(id: string): Promise<VercelBoardWireMessage | null>;
  createTask(input: { channel: string; text: string; labels?: Record<string, string>; id: string; needs?: string[]; noSync?: boolean }): Promise<VercelBoardWireMessage>;
  createBatch(input: { channel: string; tasks: VercelBoardPlanTask[]; id: string; noSync?: boolean }): Promise<VercelBoardWireMessage[]>;
  batch(id: string): Promise<VercelBoardWireMessage[] | null>;
  /** No idempotency key and the token shows once. Callers must never retry it after an unknown outcome. */
  claim(taskId: string, leaseSeconds: number): Promise<{ task: VercelBoardWireMessage; claim: VercelBoardClaimGrant }>;
  renew(taskId: string, grant: { epoch: number; token: string }, leaseSeconds: number): Promise<{ task: VercelBoardWireMessage; until: number }>;
  complete(taskId: string, grant: { epoch: number; token: string }, result?: string): Promise<VercelBoardWireMessage>;
  fail(taskId: string, grant: { epoch: number; token: string }, reason: string): Promise<VercelBoardWireMessage>;
  release(taskId: string, grant: { epoch: number; token: string }): Promise<VercelBoardWireMessage>;
  /** Holds a claimed task for a person, which ends the claim. `kind`: `needs_input` or `awaiting_approval`. */
  block(taskId: string, grant: { epoch: number; token: string }, reason: string, kind: VercelBoardBlockKind): Promise<VercelBoardWireMessage>;
  /** Lifts a hold. Board allows it to the task's owner, so the runtime sends it as the principal (`as(null)`). */
  unblock(taskId: string): Promise<VercelBoardWireMessage>;
  /**
   * The same transport writing as another profile from the connection's role
   * list, or as the principal itself with null. Narrowing (`x-board-can`) is unchanged.
   */
  as(profile: string | null): VercelBoardTransport;
  labels(messageId: string, change: { set?: Record<string, string>; unset?: string[]; if?: Record<string, string | null> }): Promise<void>;
  /** The team's boards this credential can see. Read-only: names only. */
  boards(signal?: AbortSignal): Promise<VercelBoardBoardRef[]>;
  /** One page of a board's channels: names and the counts the board keeps. Narrowed to read. */
  channels(query: { board: string; prefix?: string; after?: string; limit?: number }): Promise<{ channels: VercelBoardChannelRef[]; next: string | null }>;
  /** A channel's newest messages on any of the team's boards, in one call. Narrowed to read; keeps nothing. */
  boardMessages(query: { board: string; channel: string; limit?: number }): Promise<{ messages: VercelBoardWireMessage[]; cursor: string | null }>;
}

/** One of the team's boards, as a transport lists it. */
export interface VercelBoardBoardRef { id: string; name: string; isDefault: boolean; connected: boolean }
/** One channel of a board, as a transport lists it. Counts are absent where the board keeps none. */
export interface VercelBoardChannelRef { channel: string; lastIndex?: number; messages?: number; threads?: number }

/** The narrowing for read-only calls: board lists, and channels the connection does not follow. */
export const VERCEL_BOARD_READ_ONLY_CAN = "*=read";
/** The board ID a protocol board (one URL, one board) lists itself under. */
export const VERCEL_BOARD_PROTOCOL_BOARD_ID = "board";

const count = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 ? value as number : undefined;
/** A channel row from Board's `GET /channels` or the worker, checked. */
export function parseVercelBoardChannelRef(value: unknown): VercelBoardChannelRef | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const channel = typeof row.channel === "string" ? row.channel : typeof row.path === "string" ? row.path : typeof row.name === "string" ? row.name : null;
  if (!channel || channel.length > 256) return null;
  const lastIndex = count(row.lastIndex), messages = count(row.messages), threads = count(row.threads);
  return { channel, ...(lastIndex !== undefined ? { lastIndex } : {}), ...(messages !== undefined ? { messages } : {}), ...(threads !== undefined ? { threads } : {}) };
}

export type VercelBoardFetch = (input: string, init: RequestInit) => Promise<Response>;

const READ_TIMEOUT_MS = 20_000;
const WRITE_TIMEOUT_MS = 20_000;

/** Seconds or an HTTP date, as `Retry-After` gives it. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 3_600_000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - now, 3_600_000)) : undefined;
}

/**
 * Board's documented HTTP protocol. Every request carries the credential,
 * the `scout` profile and `x-board-can`. Board's IDs go in paths
 * URL-encoded. Nothing here retries: the runtime decides what is safe to
 * send again.
 */
export class VercelBoardHttpTransport implements VercelBoardTransport {
  private readonly base: string;
  private readonly can: string;
  constructor(
    private readonly connection: Pick<VercelBoardConnectionConfig, "url" | "profile" | "channels" | "probeChannel">,
    private readonly token: () => Promise<string>,
    private readonly fetchImpl: VercelBoardFetch = (input, init) => fetch(input, init),
    /** The profile this transport writes as: the connection's own unless `as()` chose another. Null is the principal. */
    private readonly profile: string | null = connection.profile,
  ) {
    this.base = connection.url.replace(/\/+$/, "");
    this.can = vercelBoardCanHeader(connection);
  }

  private async request<T>(method: "GET" | "POST", path: string, options: { query?: Record<string, string | undefined>; body?: unknown; signal?: AbortSignal; timeoutMs?: number; operation: string; can?: string }): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, value);
    const timeout = AbortSignal.timeout(options.timeoutMs ?? (method === "GET" ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS));
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.token()}`,
      ...(this.profile !== null ? { "x-board-profile": this.profile } : {}),
      "x-board-can": options.can ?? this.can,
      accept: "application/json",
    };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), { method, headers, redirect: "error", signal, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
    } catch (error) {
      if (method === "GET") throw new VercelBoardHttpError(502, "unreachable", "The board did not answer.");
      throw new VercelBoardUnknownOutcomeError(options.operation, error);
    }
    const raw = await response.text().catch(() => "");
    let body: any;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
    if (response.ok) {
      if (body === undefined) throw new VercelBoardHttpError(502, "remote_error", "The board answered with something that is not JSON.");
      return body as T;
    }
    const error = body?.error && typeof body.error === "object" ? body.error : {};
    const code = typeof error.code === "string" && /^[a-z_]{1,64}$/.test(error.code) ? error.code : response.status === 401 ? "unauthorized" : "remote_error";
    const message = typeof error.message === "string" ? error.message.slice(0, 500) : `The board answered ${response.status}.`;
    // A gateway error on a write may mean it landed.
    if (method === "POST" && response.status >= 500 && response.status !== 503 && response.status !== 501) {
      throw new VercelBoardUnknownOutcomeError(options.operation, new Error(code));
    }
    throw new VercelBoardHttpError(response.status, code, message, retryAfterMs(response.headers.get("retry-after")), typeof error.hint === "string" ? error.hint.slice(0, 500) : undefined);
  }

  async me(signal?: AbortSignal): Promise<VercelBoardMe> {
    const me = await this.request<Record<string, any>>("GET", "/me", { signal, operation: "me" });
    if (typeof me.principal !== "string" || typeof me.actor !== "string") throw new VercelBoardHttpError(502, "remote_error", "GET /me named no principal.");
    const expires = typeof me.expiresAt === "string" ? Date.parse(me.expiresAt) : typeof me.expiresAt === "number" ? me.expiresAt : NaN;
    return { actor: me.actor, principal: me.principal, profile: typeof me.profile === "string" ? me.profile : null, expiresAt: Number.isFinite(expires) ? expires : null };
  }

  async ensureChannel(channel: string): Promise<void> {
    await this.request("POST", "/channels", { body: { path: channel }, operation: "channel" });
  }

  async events(query: { channel: string; after?: string; wait?: number; signal?: AbortSignal }) {
    const wait = query.wait === undefined ? undefined : Math.max(0, Math.min(Math.floor(query.wait), 300));
    const answer = await this.request<Record<string, any>>("GET", "/events", {
      query: { channel: query.channel, after: query.after, ...(wait !== undefined ? { wait: String(wait) } : {}) },
      signal: query.signal, timeoutMs: (wait ?? 0) * 1000 + READ_TIMEOUT_MS, operation: "events",
    });
    if (!Array.isArray(answer.events) || answer.events.length > 1000) throw new VercelBoardHttpError(502, "remote_error", "GET /events answered no event list.");
    if (typeof answer.cursor !== "string" && typeof answer.cursor !== "number") throw new VercelBoardHttpError(502, "remote_error", "GET /events answered no cursor.");
    return { events: answer.events.map(parseVercelBoardEvent), cursor: String(answer.cursor) };
  }

  async tasks(query: { channel: string; state?: string; after?: string; limit?: number }) {
    const answer = await this.request<Record<string, any>>("GET", "/tasks", {
      query: { channel: query.channel, state: query.state, after: query.after, limit: query.limit ? String(query.limit) : undefined }, operation: "tasks",
    });
    if (!Array.isArray(answer.tasks)) throw new VercelBoardHttpError(502, "remote_error", "GET /tasks answered no task list.");
    return { tasks: answer.tasks.map(parseVercelBoardTaskSummary), cursor: answer.cursor === null || answer.cursor === undefined ? null : String(answer.cursor) };
  }

  async channelMessages(query: { channel: string; after?: string; limit?: number }) {
    const limit = Math.max(1, Math.min(Math.floor(query.limit ?? 500), 500));
    const answer = await this.request<Record<string, any>>("GET", "/messages", {
      query: { channel: query.channel, after: query.after, limit: String(limit) }, operation: "messages",
    });
    try { return parseVercelBoardMessagesPage(answer); }
    catch { throw new VercelBoardHttpError(502, "remote_error", "GET /messages answered no message list."); }
  }

  async message(id: string): Promise<VercelBoardWireMessage | null> {
    try {
      const answer = await this.request<Record<string, any>>("GET", `/messages/${encodeURIComponent(id)}`, { query: { limit: "1" }, operation: "message" });
      return parseVercelBoardMessage(answer.message);
    } catch (error) {
      if (error instanceof VercelBoardHttpError && error.status === 404) return null;
      throw error;
    }
  }

  async post(input: { channel?: string; re?: string; text: string; labels?: Record<string, string>; id: string; noSync?: boolean }) {
    const answer = await this.request<Record<string, any>>("POST", "/messages", { body: { ...input, noSync: input.noSync ?? VERCEL_BOARD_NO_SYNC }, operation: "post" });
    return parseVercelBoardMessage(answer.message);
  }

  async postById(id: string): Promise<VercelBoardWireMessage | null> {
    try {
      const answer = await this.request<Record<string, any>>("GET", `/posts/${encodeURIComponent(id)}`, { operation: "post_lookup" });
      return parseVercelBoardMessage(answer.message);
    } catch (error) {
      if (error instanceof VercelBoardHttpError && error.status === 404) return null;
      throw error;
    }
  }

  async createTask(input: { channel: string; text: string; labels?: Record<string, string>; id: string; needs?: string[]; noSync?: boolean }) {
    const answer = await this.request<Record<string, any>>("POST", "/tasks", { body: { ...input, noSync: input.noSync ?? VERCEL_BOARD_NO_SYNC }, operation: "task_create" });
    return parseVercelBoardMessage(answer.task);
  }

  async createBatch(input: { channel: string; tasks: VercelBoardPlanTask[]; id: string; noSync?: boolean }) {
    const answer = await this.request<Record<string, any>>("POST", "/tasks/batch", { body: { ...input, tasks: input.tasks.map(task => ({ ...task, noSync: input.noSync ?? VERCEL_BOARD_NO_SYNC })) }, operation: "task_batch" });
    if (!Array.isArray(answer.tasks)) throw new VercelBoardHttpError(502, "remote_error", "POST /tasks/batch answered no tasks.");
    return answer.tasks.map(parseVercelBoardMessage);
  }

  async batch(id: string): Promise<VercelBoardWireMessage[] | null> {
    try {
      const answer = await this.request<Record<string, any>>("GET", `/tasks/batch/${encodeURIComponent(id)}`, { operation: "batch_lookup" });
      return Array.isArray(answer.tasks) ? answer.tasks.map(parseVercelBoardMessage) : null;
    } catch (error) {
      if (error instanceof VercelBoardHttpError && error.status === 404) return null;
      throw error;
    }
  }

  async claim(taskId: string, leaseSeconds: number) {
    const answer = await this.request<Record<string, any>>("POST", `/tasks/${encodeURIComponent(taskId)}/claim`, { body: { lease: leaseSeconds }, operation: "claim" });
    const claim = answer.claim;
    const until = Date.parse(claim?.until);
    if (!claim || !Number.isSafeInteger(claim.epoch) || typeof claim.token !== "string" || !claim.token || !Number.isFinite(until)) {
      throw new VercelBoardHttpError(502, "remote_error", "POST /tasks/:id/claim answered no claim.");
    }
    return { task: parseVercelBoardMessage(answer.task), claim: { epoch: claim.epoch, token: claim.token, until } };
  }

  async renew(taskId: string, grant: { epoch: number; token: string }, leaseSeconds: number) {
    const answer = await this.request<Record<string, any>>("POST", `/tasks/${encodeURIComponent(taskId)}/renew`, { body: { epoch: grant.epoch, token: grant.token, lease: leaseSeconds }, operation: "renew" });
    const until = Date.parse(answer.until);
    if (!Number.isFinite(until)) throw new VercelBoardHttpError(502, "remote_error", "renew answered no until.");
    return { task: parseVercelBoardMessage(answer.task), until };
  }

  private async settle(taskId: string, verb: "complete" | "fail" | "release", body: Record<string, unknown>) {
    const answer = await this.request<Record<string, any>>("POST", `/tasks/${encodeURIComponent(taskId)}/${verb}`, { body, operation: verb });
    return parseVercelBoardMessage(answer.task);
  }
  complete(taskId: string, grant: { epoch: number; token: string }, result?: string) {
    return this.settle(taskId, "complete", { epoch: grant.epoch, token: grant.token, ...(result !== undefined ? { result: boardResultExcerpt(result) } : {}) });
  }
  fail(taskId: string, grant: { epoch: number; token: string }, reason: string) {
    return this.settle(taskId, "fail", { epoch: grant.epoch, token: grant.token, reason: boardResultExcerpt(reason) });
  }
  release(taskId: string, grant: { epoch: number; token: string }) {
    return this.settle(taskId, "release", { epoch: grant.epoch, token: grant.token });
  }
  async block(taskId: string, grant: { epoch: number; token: string }, reason: string, kind: VercelBoardBlockKind) {
    const answer = await this.request<Record<string, any>>("POST", `/tasks/${encodeURIComponent(taskId)}/block`, { body: { epoch: grant.epoch, token: grant.token, reason: boardResultExcerpt(reason), kind }, operation: "block" });
    return parseVercelBoardMessage(answer.task);
  }
  async unblock(taskId: string) {
    const answer = await this.request<Record<string, any>>("POST", `/tasks/${encodeURIComponent(taskId)}/unblock`, { body: {}, operation: "unblock" });
    return parseVercelBoardMessage(answer.task);
  }
  as(profile: string | null): VercelBoardTransport {
    return new VercelBoardHttpTransport(this.connection, this.token, this.fetchImpl, profile);
  }

  async labels(messageId: string, change: { set?: Record<string, string>; unset?: string[]; if?: Record<string, string | null> }) {
    await this.request("POST", `/messages/${encodeURIComponent(messageId)}/labels`, { body: change, operation: "labels" });
  }

  /** A protocol board is one board at one URL: it lists itself. */
  async boards(): Promise<VercelBoardBoardRef[]> {
    return [{ id: VERCEL_BOARD_PROTOCOL_BOARD_ID, name: new URL(this.base).host, isDefault: true, connected: true }];
  }

  private onlyBoard(board: string): void {
    if (board !== VERCEL_BOARD_PROTOCOL_BOARD_ID) throw new VercelBoardHttpError(404, "board_not_found", `This board lists itself as ${VERCEL_BOARD_PROTOCOL_BOARD_ID}; there is no board ${board}.`);
  }

  async channels(query: { board: string; prefix?: string; after?: string; limit?: number }) {
    this.onlyBoard(query.board);
    const limit = Math.max(1, Math.min(Math.floor(query.limit ?? 500), 500));
    const answer = await this.request<Record<string, any>>("GET", "/channels", {
      query: { prefix: query.prefix, after: query.after, limit: String(limit) }, can: VERCEL_BOARD_READ_ONLY_CAN, operation: "channels",
    });
    if (!Array.isArray(answer.channels)) throw new VercelBoardHttpError(502, "remote_error", "GET /channels answered no channel list.");
    const channels = answer.channels.map(parseVercelBoardChannelRef).filter((row): row is VercelBoardChannelRef => row !== null);
    return { channels, next: typeof answer.next === "string" && answer.next ? answer.next : null };
  }

  async boardMessages(query: { board: string; channel: string; limit?: number }) {
    this.onlyBoard(query.board);
    const limit = Math.max(1, Math.min(Math.floor(query.limit ?? 500), 500));
    const answer = await this.request<Record<string, any>>("GET", "/messages", {
      query: { channel: query.channel, limit: String(limit) }, can: VERCEL_BOARD_READ_ONLY_CAN, operation: "messages",
    });
    try { return parseVercelBoardMessagesPage(answer); }
    catch { throw new VercelBoardHttpError(502, "remote_error", "GET /messages answered no message list."); }
  }
}

/** The agent label every outbound write carries, cut to Board's label value limit. */
/**
 * Scout's writes stay on the board unless the operator explicitly enables a
 * channel for Board sync. This is the default, not a second outbound writer.
 */
export const VERCEL_BOARD_NO_SYNC = true;

export function agentLabel(agentId: string): Record<string, string> {
  return { [VERCEL_BOARD_LABELS.agent]: agentId.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 256) };
}
