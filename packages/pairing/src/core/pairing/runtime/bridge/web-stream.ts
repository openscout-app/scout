// web.subscribe and web.stream: the live half of web.request. A paired browser
// away from the host gets the same live feeds the local portal gets, carried
// inside the encrypted bridge channel as tRPC subscription frames, one stream
// per subscription id, each stopped by `subscription.stop` or the channel
// closing.
//
// web.subscribe relays one of the runtime's own streams (`control.events`,
// `tail.events`), which the local portal reads over the runtime's /trpc socket.
// web.stream carries a server-sent event stream from this host's web API, for
// the views that read one (voice, broadcast).

import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import type { BrokerRouter } from "@openscout/runtime/broker-trpc-router";
import { resolveWebAuthToken, resolveWebPort } from "@openscout/runtime/local-config";

import { resolveScoutBrokerUrl } from "../../../broker/service.ts";
import { isAllowedBridgeWebPath } from "./web-request.ts";

export const BRIDGE_WEB_STREAMS = ["control.events", "tail.events"] as const;
export type BridgeWebStream = (typeof BRIDGE_WEB_STREAMS)[number];

/**
 * Events held for a browser that reads slower than the host produces. Past
 * this the stream ends with an error; the browser resubscribes and reconciles
 * from a snapshot, which is cheaper than an unbounded queue on the host.
 */
export const BRIDGE_WEB_STREAM_MAX_QUEUED = 2_000;

export interface BridgeStreamItem {
  /** The runtime's event id, when the stream is resumable. */
  id?: string;
  data: unknown;
}

export interface SubscribeObserver {
  onData: (value: unknown) => void;
  onError: (error: unknown) => void;
  onComplete: () => void;
}

/** Opens one runtime subscription; returns how to stop it. */
export type RuntimeSubscribe = (
  stream: BridgeWebStream,
  input: Record<string, unknown> | undefined,
  observer: SubscribeObserver,
) => { unsubscribe: () => void };

let runtimeClient: ReturnType<typeof createTRPCClient<BrokerRouter>> | null = null;

function defaultRuntimeSubscribe(): RuntimeSubscribe {
  if (!runtimeClient) {
    const url = `${resolveScoutBrokerUrl().replace(/^http/i, "ws").replace(/\/$/, "")}/trpc`;
    // Lazy: the socket opens with the first browser stream and closes once the last one ends.
    const client = createWSClient({ url, lazy: { enabled: true, closeMs: 30_000 } });
    runtimeClient = createTRPCClient<BrokerRouter>({ links: [wsLink({ client })] });
  }
  const trpc = runtimeClient;
  return (stream, input, observer) => {
    const handlers = {
      onData: observer.onData,
      onError: observer.onError,
      onComplete: observer.onComplete,
      onStopped: observer.onComplete,
    };
    return stream === "control.events"
      ? trpc.control.events.subscribe(input as never, handlers)
      : trpc.tail.events.subscribe(input as never, handlers);
  };
}

/** A tRPC `tracked` envelope as the client sees it: `{ id, data }`. */
function asTracked(value: unknown): BridgeStreamItem {
  if (value && typeof value === "object" && "id" in value && "data" in value) {
    const { id, data } = value as { id: unknown; data: unknown };
    if (typeof id === "string") return { id, data };
  }
  return { data: value };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Callbacks in, an async iterable out, with a bounded queue between them so a
 * slow browser can't make the host hold everything the runtime says.
 */
class StreamQueue<T> {
  private items: T[] = [];
  private waiting: { resolve: (result: IteratorResult<T>) => void; reject: (error: Error) => void } | null = null;
  private failure: unknown = null;
  private done = false;

  constructor(private readonly maxQueued: number) {}

  push(item: T): void {
    if (this.done) return;
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = null;
      waiting.resolve({ value: item, done: false });
      return;
    }
    if (this.items.length >= this.maxQueued) {
      this.fail(new Error("The browser fell behind this host's live feed"));
      return;
    }
    this.items.push(item);
  }

  fail(error: unknown): void {
    if (this.done) return;
    this.done = true;
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting) waiting.reject(asError(error));
    else this.failure = error;
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.resolve({ value: undefined, done: true });
  }

  async next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) return { value: item, done: false };
    if (this.failure) {
      const failure = this.failure;
      this.failure = null;
      throw asError(failure);
    }
    if (this.done) return { value: undefined, done: true };
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }
}

export async function* bridgeRuntimeStream(
  stream: BridgeWebStream,
  input: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
  deps: { subscribe?: RuntimeSubscribe; maxQueued?: number } = {},
): AsyncGenerator<BridgeStreamItem> {
  const queue = new StreamQueue<BridgeStreamItem>(deps.maxQueued ?? BRIDGE_WEB_STREAM_MAX_QUEUED);
  const subscribe = deps.subscribe ?? defaultRuntimeSubscribe();
  const subscription = subscribe(stream, input, {
    onData: (value) => queue.push(asTracked(value)),
    onError: (error) => queue.fail(error),
    onComplete: () => queue.finish(),
  });
  const onAbort = () => queue.finish();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (!signal?.aborted) {
      const result = await queue.next();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    subscription.unsubscribe();
  }
}

export interface BridgeEventStreamDeps {
  fetch?: typeof fetch;
  baseUrl?: () => string;
  token?: () => string;
}

/**
 * One server-sent event stream from this host's web API, as the text chunks
 * it arrives in; the browser parses the events. Same paths as web.request.
 */
export async function* bridgeEventStream(
  path: string,
  signal: AbortSignal | undefined,
  deps: BridgeEventStreamDeps = {},
): AsyncGenerator<string> {
  if (!isAllowedBridgeWebPath(path)) throw new Error("unsupported_web_path");
  const fetchImpl = deps.fetch ?? fetch;
  const baseUrl = deps.baseUrl?.() ?? `http://127.0.0.1:${resolveWebPort()}`;
  const token = deps.token?.() ?? resolveWebAuthToken();
  const response = await fetchImpl(new URL(path, baseUrl), {
    method: "GET",
    headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
    redirect: "error",
    signal,
  });
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!response.ok || !contentType.includes("text/event-stream") || !response.body) {
    await response.body?.cancel();
    throw new Error(`This host answered ${response.status} instead of a live stream`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) yield text;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
