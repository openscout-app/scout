import { BOARD_LABELS, boardCanHeader, type BoardConnectionConfig, type BoardPlanTask } from "@openscout/protocol";
import { parseBoardEvent, parseBoardMessage, parseBoardTaskSummary, type BoardWireEvent, type BoardWireMessage } from "./wire.js";

/**
 * A refusal or failure from the board, by Board's status and code. The body's
 * message is kept only when it is short; a credential never appears in one.
 */
export class BoardHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfterMs?: number, readonly hint?: string) {
    super(message);
    this.name = "BoardHttpError";
  }
}
/** The request may or may not have landed: no answer came back. */
export class BoardUnknownOutcomeError extends Error {
  constructor(readonly operation: string, cause: unknown) {
    super(`board_outcome_unknown: ${operation} sent, no answer (${cause instanceof Error ? cause.name : "error"})`);
    this.name = "BoardUnknownOutcomeError";
  }
}

export interface BoardClaimGrant { epoch: number; token: string; until: number }
export interface BoardMe { actor: string; principal: string; profile: string | null; expiresAt: number | null }

/**
 * The closed set of operations the custodian uses. A transport carries them;
 * it holds no claim token, cursor or retry policy of its own. A second
 * transport (the Vercel API worker) implements the same interface.
 */
export interface BoardTransport {
  me(signal?: AbortSignal): Promise<BoardMe>;
  ensureChannel(channel: string): Promise<void>;
  events(query: { channel: string; after?: string; wait?: number; signal?: AbortSignal }): Promise<{ events: BoardWireEvent[]; cursor: string }>;
  tasks(query: { channel: string; state?: string; after?: string; limit?: number }): Promise<{ tasks: BoardWireMessage[]; cursor: string | null }>;
  message(id: string): Promise<BoardWireMessage | null>;
  post(input: { channel?: string; re?: string; text: string; labels?: Record<string, string>; id: string }): Promise<BoardWireMessage>;
  postById(id: string): Promise<BoardWireMessage | null>;
  createTask(input: { channel: string; text: string; labels?: Record<string, string>; id: string; needs?: string[] }): Promise<BoardWireMessage>;
  createBatch(input: { channel: string; tasks: BoardPlanTask[]; id: string }): Promise<BoardWireMessage[]>;
  batch(id: string): Promise<BoardWireMessage[] | null>;
  /** No idempotency key and the token shows once. Callers must never retry it after an unknown outcome. */
  claim(taskId: string, leaseSeconds: number): Promise<{ task: BoardWireMessage; claim: BoardClaimGrant }>;
  renew(taskId: string, grant: { epoch: number; token: string }, leaseSeconds: number): Promise<{ task: BoardWireMessage; until: number }>;
  complete(taskId: string, grant: { epoch: number; token: string }, result?: string): Promise<BoardWireMessage>;
  fail(taskId: string, grant: { epoch: number; token: string }, reason: string): Promise<BoardWireMessage>;
  release(taskId: string, grant: { epoch: number; token: string }): Promise<BoardWireMessage>;
  labels(messageId: string, change: { set?: Record<string, string>; unset?: string[]; if?: Record<string, string | null> }): Promise<void>;
}

export type BoardFetch = (input: string, init: RequestInit) => Promise<Response>;

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
 * URL-encoded. Nothing here retries: the custodian decides what is safe to
 * send again.
 */
export class BoardHttpTransport implements BoardTransport {
  private readonly base: string;
  private readonly can: string;
  constructor(
    private readonly connection: Pick<BoardConnectionConfig, "url" | "profile" | "channels" | "probeChannel">,
    private readonly token: () => Promise<string>,
    private readonly fetchImpl: BoardFetch = (input, init) => fetch(input, init),
  ) {
    this.base = connection.url.replace(/\/+$/, "");
    this.can = boardCanHeader(connection);
  }

  private async request<T>(method: "GET" | "POST", path: string, options: { query?: Record<string, string | undefined>; body?: unknown; signal?: AbortSignal; timeoutMs?: number; operation: string }): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, value);
    const timeout = AbortSignal.timeout(options.timeoutMs ?? (method === "GET" ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS));
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.token()}`,
      "x-board-profile": this.connection.profile,
      "x-board-can": this.can,
      accept: "application/json",
    };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), { method, headers, redirect: "error", signal, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
    } catch (error) {
      if (method === "GET") throw new BoardHttpError(502, "unreachable", "The board did not answer.");
      throw new BoardUnknownOutcomeError(options.operation, error);
    }
    const raw = await response.text().catch(() => "");
    let body: any;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
    if (response.ok) {
      if (body === undefined) throw new BoardHttpError(502, "remote_error", "The board answered with something that is not JSON.");
      return body as T;
    }
    const error = body?.error && typeof body.error === "object" ? body.error : {};
    const code = typeof error.code === "string" && /^[a-z_]{1,64}$/.test(error.code) ? error.code : response.status === 401 ? "unauthorized" : "remote_error";
    const message = typeof error.message === "string" ? error.message.slice(0, 500) : `The board answered ${response.status}.`;
    // A gateway error on a write may mean it landed.
    if (method === "POST" && response.status >= 500 && response.status !== 503 && response.status !== 501) {
      throw new BoardUnknownOutcomeError(options.operation, new Error(code));
    }
    throw new BoardHttpError(response.status, code, message, retryAfterMs(response.headers.get("retry-after")), typeof error.hint === "string" ? error.hint.slice(0, 500) : undefined);
  }

  async me(signal?: AbortSignal): Promise<BoardMe> {
    const me = await this.request<Record<string, any>>("GET", "/me", { signal, operation: "me" });
    if (typeof me.principal !== "string" || typeof me.actor !== "string") throw new BoardHttpError(502, "remote_error", "GET /me named no principal.");
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
    if (!Array.isArray(answer.events) || answer.events.length > 1000) throw new BoardHttpError(502, "remote_error", "GET /events answered no event list.");
    if (typeof answer.cursor !== "string" && typeof answer.cursor !== "number") throw new BoardHttpError(502, "remote_error", "GET /events answered no cursor.");
    return { events: answer.events.map(parseBoardEvent), cursor: String(answer.cursor) };
  }

  async tasks(query: { channel: string; state?: string; after?: string; limit?: number }) {
    const answer = await this.request<Record<string, any>>("GET", "/tasks", {
      query: { channel: query.channel, state: query.state, after: query.after, limit: query.limit ? String(query.limit) : undefined }, operation: "tasks",
    });
    if (!Array.isArray(answer.tasks)) throw new BoardHttpError(502, "remote_error", "GET /tasks answered no task list.");
    return { tasks: answer.tasks.map(parseBoardTaskSummary), cursor: answer.cursor === null || answer.cursor === undefined ? null : String(answer.cursor) };
  }

  async message(id: string): Promise<BoardWireMessage | null> {
    try {
      const answer = await this.request<Record<string, any>>("GET", `/messages/${encodeURIComponent(id)}`, { query: { limit: "1" }, operation: "message" });
      return parseBoardMessage(answer.message);
    } catch (error) {
      if (error instanceof BoardHttpError && error.status === 404) return null;
      throw error;
    }
  }

  async post(input: { channel?: string; re?: string; text: string; labels?: Record<string, string>; id: string }) {
    const answer = await this.request<Record<string, any>>("POST", "/messages", { body: input, operation: "post" });
    return parseBoardMessage(answer.message);
  }

  async postById(id: string): Promise<BoardWireMessage | null> {
    try {
      const answer = await this.request<Record<string, any>>("GET", `/posts/${encodeURIComponent(id)}`, { operation: "post_lookup" });
      return parseBoardMessage(answer.message);
    } catch (error) {
      if (error instanceof BoardHttpError && error.status === 404) return null;
      throw error;
    }
  }

  async createTask(input: { channel: string; text: string; labels?: Record<string, string>; id: string; needs?: string[] }) {
    const answer = await this.request<Record<string, any>>("POST", "/tasks", { body: input, operation: "task_create" });
    return parseBoardMessage(answer.task);
  }

  async createBatch(input: { channel: string; tasks: BoardPlanTask[]; id: string }) {
    const answer = await this.request<Record<string, any>>("POST", "/tasks/batch", { body: input, operation: "task_batch" });
    if (!Array.isArray(answer.tasks)) throw new BoardHttpError(502, "remote_error", "POST /tasks/batch answered no tasks.");
    return answer.tasks.map(parseBoardMessage);
  }

  async batch(id: string): Promise<BoardWireMessage[] | null> {
    try {
      const answer = await this.request<Record<string, any>>("GET", `/tasks/batch/${encodeURIComponent(id)}`, { operation: "batch_lookup" });
      return Array.isArray(answer.tasks) ? answer.tasks.map(parseBoardMessage) : null;
    } catch (error) {
      if (error instanceof BoardHttpError && error.status === 404) return null;
      throw error;
    }
  }

  async claim(taskId: string, leaseSeconds: number) {
    const answer = await this.request<Record<string, any>>("POST", `/tasks/${encodeURIComponent(taskId)}/claim`, { body: { lease: leaseSeconds }, operation: "claim" });
    const claim = answer.claim;
    const until = Date.parse(claim?.until);
    if (!claim || !Number.isSafeInteger(claim.epoch) || typeof claim.token !== "string" || !claim.token || !Number.isFinite(until)) {
      throw new BoardHttpError(502, "remote_error", "POST /tasks/:id/claim answered no claim.");
    }
    return { task: parseBoardMessage(answer.task), claim: { epoch: claim.epoch, token: claim.token, until } };
  }

  async renew(taskId: string, grant: { epoch: number; token: string }, leaseSeconds: number) {
    const answer = await this.request<Record<string, any>>("POST", `/tasks/${encodeURIComponent(taskId)}/renew`, { body: { epoch: grant.epoch, token: grant.token, lease: leaseSeconds }, operation: "renew" });
    const until = Date.parse(answer.until);
    if (!Number.isFinite(until)) throw new BoardHttpError(502, "remote_error", "renew answered no until.");
    return { task: parseBoardMessage(answer.task), until };
  }

  private async settle(taskId: string, verb: "complete" | "fail" | "release", body: Record<string, unknown>) {
    const answer = await this.request<Record<string, any>>("POST", `/tasks/${encodeURIComponent(taskId)}/${verb}`, { body, operation: verb });
    return parseBoardMessage(answer.task);
  }
  complete(taskId: string, grant: { epoch: number; token: string }, result?: string) {
    return this.settle(taskId, "complete", { epoch: grant.epoch, token: grant.token, ...(result !== undefined ? { result: result.slice(0, 1000) } : {}) });
  }
  fail(taskId: string, grant: { epoch: number; token: string }, reason: string) {
    return this.settle(taskId, "fail", { epoch: grant.epoch, token: grant.token, reason: reason.slice(0, 1000) });
  }
  release(taskId: string, grant: { epoch: number; token: string }) {
    return this.settle(taskId, "release", { epoch: grant.epoch, token: grant.token });
  }

  async labels(messageId: string, change: { set?: Record<string, string>; unset?: string[]; if?: Record<string, string | null> }) {
    await this.request("POST", `/messages/${encodeURIComponent(messageId)}/labels`, { body: change, operation: "labels" });
  }
}

/** The agent label every outbound write carries, cut to Board's label value limit. */
export function agentLabel(agentId: string): Record<string, string> {
  return { [BOARD_LABELS.agent]: agentId.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 256) };
}
