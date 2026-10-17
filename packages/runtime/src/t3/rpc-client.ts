import WebSocket, { type RawData } from "ws";
import {
  redactSecrets,
  registerSecretValue,
} from "@openscout/agent-sessions/secret-redaction";

/** Effect RPC JSON wire format used by T3 Orchestrator at upstream 46e3533. */
export type T3RpcErrorCode =
  | "invalid-endpoint" | "authentication" | "connection" | "disconnected"
  | "timeout" | "aborted" | "protocol" | "remote" | "limit" | "closed";

export class T3RpcError extends Error {
  readonly code: T3RpcErrorCode;
  readonly method?: string;
  readonly remoteTag?: string;
  readonly requestSent?: boolean;

  constructor(code: T3RpcErrorCode, message: string, options?: { method?: string; remoteTag?: string; requestSent?: boolean }) {
    super(message);
    this.name = "T3RpcError";
    this.code = code;
    this.method = options?.method;
    this.remoteTag = options?.remoteTag;
    this.requestSent = options?.requestSent;
  }
}

export interface T3RpcClientOptions {
  /** T3 environment origin, or its /ws endpoint. Credentials belong in token/cookie. */
  url: string;
  token?: string;
  cookie?: string;
  timeoutMs?: number;
  streamTimeoutMs?: number;
  connectTimeoutMs?: number;
  maxFrameBytes?: number;
  maxBufferedItems?: number;
  maxInFlight?: number;
}

export interface T3RpcRequestOptions {
  signal?: AbortSignal;
  /** Total request lifetime, including connection establishment. */
  timeoutMs?: number;
}

type PendingRequest = {
  chunk(values: unknown[]): void;
  success(value: unknown): void;
  fail(error: T3RpcError): void;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > 2_147_483_647) {
    throw new T3RpcError("limit", `${name} must be a positive finite integer no greater than 2147483647.`);
  }
  return resolved;
}

/** Reject secret-bearing URLs rather than persisting credentials in an external identity. */
export function normalizeT3WebSocketUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new T3RpcError("invalid-endpoint", "T3 requires an absolute HTTP(S) or WS(S) environment URL."); }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)
    || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "/ws")) {
    throw new T3RpcError("invalid-endpoint", "T3 requires an environment origin or /ws URL without embedded credentials, query, or fragment.");
  }
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  return url.toString();
}

/**
 * Thin, bounded Effect RPC client. Every mutation is sent once. Disconnects reject
 * in-flight requests; callers reconcile with T3 snapshots before choosing to retry.
 * A transport acknowledgement only acknowledges a consumed stream chunk.
 */
export class T3RpcClient {
  readonly url: string;
  #headers: Record<string, string> = {};
  #secrets: string[] = [];
  #socket?: WebSocket;
  #connecting?: Promise<void>;
  #closed = false;
  #nextId = 0;
  #pending = new Map<string, PendingRequest>();
  #timeoutMs: number;
  #streamTimeoutMs: number;
  #connectTimeoutMs: number;
  #maxFrameBytes: number;
  #maxBufferedItems: number;
  #maxInFlight: number;

  constructor(options: T3RpcClientOptions) {
    this.url = normalizeT3WebSocketUrl(options.url);
    for (const [name, value] of [["token", options.token], ["cookie", options.cookie]] as const) {
      if (value !== undefined && (!value.trim() || /[\r\n]/.test(value))) {
        throw new T3RpcError("authentication", `T3 ${name} must be nonempty and contain no line breaks.`);
      }
      if (value) {
        this.#secrets.push(value);
        registerSecretValue(value, `t3:${name}`);
        if (name === "cookie") {
          for (const part of value.split(";")) {
            const index = part.indexOf("=");
            const secret = index >= 0 ? part.slice(index + 1).trim() : "";
            if (secret) {
              this.#secrets.push(secret);
              registerSecretValue(secret, "t3:cookie-value");
            }
          }
        }
      }
    }
    if (options.token) this.#headers.Authorization = `Bearer ${options.token}`;
    if (options.cookie) this.#headers.Cookie = options.cookie;
    this.#timeoutMs = positiveLimit(options.timeoutMs, 30_000, "timeoutMs");
    this.#streamTimeoutMs = positiveLimit(options.streamTimeoutMs, 300_000, "streamTimeoutMs");
    this.#connectTimeoutMs = positiveLimit(options.connectTimeoutMs, 10_000, "connectTimeoutMs");
    this.#maxFrameBytes = positiveLimit(options.maxFrameBytes, 8 * 1024 * 1024, "maxFrameBytes");
    this.#maxBufferedItems = positiveLimit(options.maxBufferedItems, 512, "maxBufferedItems");
    this.#maxInFlight = positiveLimit(options.maxInFlight, 64, "maxInFlight");
  }

  toJSON(): { url: string; connected: boolean } {
    return { url: this.url, connected: this.#socket?.readyState === WebSocket.OPEN };
  }

  async connect(): Promise<void> {
    if (this.#closed) throw new T3RpcError("closed", "T3 client is closed.");
    if (this.#socket?.readyState === WebSocket.OPEN) return;
    if (this.#connecting) return this.#connecting;
    const socket = new WebSocket(this.url, {
      headers: this.#headers,
      maxPayload: this.#maxFrameBytes,
      followRedirects: false,
      handshakeTimeout: this.#connectTimeoutMs,
    });
    this.#socket = socket;
    const connecting = new Promise<void>((resolve, reject) => {
      let opened = false;
      socket.on("open", () => { opened = true; resolve(); });
      socket.on("message", (data: RawData) => { if (this.#socket === socket) this.#receive(data); });
      // Bun's ws compatibility layer does not implement this Node-only event.
      if (typeof Bun === "undefined") {
        socket.on("unexpected-response", (_request, response) => {
          const code = response.statusCode;
          response.resume();
          const error = new T3RpcError(code === 401 || code === 403 ? "authentication" : "connection",
            `T3 WebSocket upgrade failed${code ? ` (HTTP ${code})` : ""}.`);
          reject(error);
          if (this.#socket === socket) this.#failAll(error);
          socket.terminate();
        });
      }
      socket.on("error", () => {
        const error = new T3RpcError(opened ? "disconnected" : "connection",
          opened ? "T3 connection failed; request outcome may be unknown. Reconcile with a snapshot before retrying." : "Could not establish the T3 WebSocket connection.");
        reject(error);
        if (this.#socket === socket) this.#failAll(error);
      });
      socket.on("close", () => {
        const current = this.#socket === socket;
        if (current) this.#socket = undefined;
        const error = new T3RpcError(this.#closed ? "closed" : "disconnected",
          this.#closed ? "T3 client is closed." : "T3 disconnected; request outcome may be unknown. Reconcile with a snapshot before retrying.");
        if (!opened) reject(error);
        if (current) this.#failAll(error);
      });
    });
    this.#connecting = connecting;
    try { await connecting; }
    finally { if (this.#connecting === connecting) this.#connecting = undefined; }
  }

  async call<T = unknown>(method: string, payload: unknown, options: T3RpcRequestOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#request(method, payload, options, this.#timeoutMs, {
        chunk: () => { this.#protocolError("T3 sent a stream chunk for a unary request."); },
        success: (value) => resolve(value as T),
        fail: reject,
      });
    });
  }

  async *stream<T = unknown>(method: string, payload: unknown, options: T3RpcRequestOptions = {}): AsyncIterable<T> {
    const batches: Array<{ values: unknown[]; index: number }> = [];
    let bufferedItems = 0;
    let failure: T3RpcError | undefined;
    let done = false;
    let wake: (() => void) | undefined;
    const notify = () => { wake?.(); wake = undefined; };
    const request = this.#request(method, payload, options, this.#streamTimeoutMs, {
      chunk: (values) => {
        if (bufferedItems + values.length > this.#maxBufferedItems) {
          request.cancel(new T3RpcError("limit", "T3 stream exceeded its buffered item limit.", { method }));
          return;
        }
        bufferedItems += values.length;
        batches.push({ values, index: 0 });
        notify();
      },
      success: () => { done = true; notify(); },
      fail: (error) => { failure = error; notify(); },
    });
    try {
      for (;;) {
        if (failure) throw failure;
        const batch = batches[0];
        if (batch) {
          const value = batch.values[batch.index++];
          bufferedItems--;
          yield value as T;
          if (batch.index === batch.values.length) {
            batches.shift();
            request.ack();
          }
        } else if (done) return;
        else await new Promise<void>((resolve) => { wake = resolve; });
      }
    } finally {
      request.cancel();
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new T3RpcError("closed", "T3 client is closed."));
    this.#socket?.terminate();
    this.#headers = {};
    this.#secrets = [];
  }

  #request(method: string, payload: unknown, options: T3RpcRequestOptions, defaultTimeoutMs: number, handler: PendingRequest): { ack(): void; cancel(error?: T3RpcError): void } {
    const id = String(++this.#nextId);
    let settled = false;
    let sent = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: T3RpcError, value?: unknown) => {
      if (settled) return;
      settled = true;
      this.#pending.delete(id);
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) handler.fail(error);
      else handler.success(value);
    };
    const cancel = (error?: T3RpcError) => {
      if (settled) return;
      if (sent) this.#send({ _tag: "Interrupt", requestId: id });
      finish(error ?? new T3RpcError("aborted", "T3 request cancelled.", { method }));
    };
    const onAbort = () => cancel(new T3RpcError("aborted", "T3 request aborted.", { method, requestSent: sent }));
    const controls = { ack: () => { if (!settled && sent) this.#send({ _tag: "Ack", requestId: id }); }, cancel };
    if (!method || method.length > 200) {
      finish(new T3RpcError("protocol", "T3 RPC requires a method name of 1 to 200 characters."));
      return controls;
    }
    let timeoutMs: number;
    try { timeoutMs = positiveLimit(options.timeoutMs, defaultTimeoutMs, "timeoutMs"); }
    catch (error) { finish(error as T3RpcError); return controls; }
    if (this.#pending.size >= this.#maxInFlight) {
      finish(new T3RpcError("limit", "T3 client exceeded its in-flight request limit.", { method }));
      return controls;
    }
    if (options.signal?.aborted) { onAbort(); return controls; }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => cancel(new T3RpcError("timeout", "T3 request timed out; a sent command may still have been accepted. Reconcile before retrying.", { method })), timeoutMs);
    this.#pending.set(id, {
      chunk: handler.chunk,
      success: (value) => finish(undefined, value),
      fail: (error) => finish(error),
    });
    void this.connect().then(() => {
      if (settled) return;
      let encoded: string;
      try { encoded = JSON.stringify({ _tag: "Request", id, tag: method, payload, headers: [] }); }
      catch { finish(new T3RpcError("protocol", "T3 request payload cannot be encoded as JSON.", { method })); return; }
      if (Buffer.byteLength(encoded) > this.#maxFrameBytes) {
        finish(new T3RpcError("limit", "T3 request exceeds the frame size limit.", { method }));
        return;
      }
      if (this.#socket?.readyState !== WebSocket.OPEN) {
        finish(new T3RpcError("disconnected", "T3 disconnected before the request was sent.", { method }));
        return;
      }
      sent = true;
      this.#socket.send(encoded, (error) => {
        if (error) finish(new T3RpcError("disconnected", "T3 request transport failed; reconcile before retrying.", { method }));
      });
    }, (error: unknown) => finish(error instanceof T3RpcError ? error : new T3RpcError("connection", "Could not connect to T3.", { method })));
    return controls;
  }

  #send(message: Record<string, unknown>): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(message), (error) => {
        if (error) this.#failAll(new T3RpcError("disconnected", "T3 transport failed; reconcile before retrying."));
      });
    }
  }

  #receive(data: RawData): void {
    let decoded: unknown;
    try {
      const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (buffer.byteLength > this.#maxFrameBytes) { this.#protocolError("T3 response exceeds the frame size limit."); return; }
      decoded = JSON.parse(buffer.toString("utf8"));
    } catch { this.#protocolError("T3 sent invalid JSON."); return; }
    const messages = Array.isArray(decoded) ? decoded : [decoded];
    if (messages.length > this.#maxBufferedItems) { this.#protocolError("T3 sent too many messages in one frame."); return; }
    for (const message of messages) {
      if (!record(message) || typeof message._tag !== "string") { this.#protocolError("T3 sent an invalid RPC envelope."); return; }
      if (message._tag === "Pong") continue;
      if (message._tag === "Defect" || message._tag === "ClientProtocolError") {
        this.#protocolError("T3 reported a connection protocol failure."); return;
      }
      if (message._tag !== "Chunk" && message._tag !== "Exit") { this.#protocolError("T3 sent an unknown RPC envelope."); return; }
      if (typeof message.requestId !== "string" && typeof message.requestId !== "number") { this.#protocolError("T3 response is missing its request ID."); return; }
      const pending = this.#pending.get(String(message.requestId));
      // A cancellation can race an already-sent chunk or terminal reply.
      if (!pending) continue;
      if (message._tag === "Chunk") {
        if (!Array.isArray(message.values) || !message.values.length) { this.#protocolError("T3 sent an invalid stream chunk."); return; }
        pending.chunk(message.values);
      } else {
        const exit = message.exit;
        if (!record(exit)) { this.#protocolError("T3 sent an invalid terminal response."); return; }
        if (exit._tag === "Success") pending.success(exit.value);
        else if (exit._tag === "Failure" && Array.isArray(exit.cause)) {
          const cause = exit.cause.find((item: unknown) => record(item) && item._tag === "Fail");
          const error = record(cause) && record(cause.error) ? cause.error : undefined;
          const remoteTag = typeof error?._tag === "string" ? this.#redact(error._tag).slice(0, 200) : undefined;
          const message = typeof error?.message === "string" ? ` ${this.#redact(error.message).slice(0, 1000)}` : "";
          pending.fail(new T3RpcError("remote", `T3 rejected the request${remoteTag ? ` (${remoteTag})` : ""}.${message}`, { remoteTag }));
        } else { this.#protocolError("T3 sent an invalid terminal exit."); return; }
      }
    }
  }

  #redact(message: string): string {
    let safe = redactSecrets(message);
    for (const secret of this.#secrets) safe = safe.split(secret).join("[redacted]");
    return safe;
  }

  #protocolError(message: string): void {
    this.#failAll(new T3RpcError("protocol", message));
    this.#socket?.terminate();
  }

  #failAll(error: T3RpcError): void {
    for (const request of this.#pending.values()) request.fail(error);
  }
}
