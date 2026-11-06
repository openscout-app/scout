import { describe, expect, test } from "bun:test";

import { bridgeEventStream, bridgeRuntimeStream, type RuntimeSubscribe, type SubscribeObserver } from "./web-stream.ts";

function fakeRuntime() {
  const opened: { stream: string; input: unknown; observer: SubscribeObserver; stopped: boolean }[] = [];
  const subscribe: RuntimeSubscribe = (stream, input, observer) => {
    const entry = { stream, input, observer, stopped: false };
    opened.push(entry);
    return { unsubscribe: () => { entry.stopped = true; } };
  };
  return { opened, subscribe };
}

async function take<T>(iterator: AsyncIterator<T>, count: number): Promise<T[]> {
  const items: T[] = [];
  for (let i = 0; i < count; i += 1) {
    const result = await iterator.next();
    if (result.done) break;
    items.push(result.value);
  }
  return items;
}

describe("bridgeRuntimeStream", () => {
  test("relays the runtime's tracked events with their ids, and stops the runtime stream when done", async () => {
    const runtime = fakeRuntime();
    const abort = new AbortController();
    const iterator = bridgeRuntimeStream("control.events", { since: "evt-0" }, abort.signal, { subscribe: runtime.subscribe });

    const first = iterator.next();
    const observer = runtime.opened[0]!.observer;
    observer.onData({ id: "evt-1", data: { kind: "message.posted" } });
    observer.onData({ kind: "untracked" });
    expect(await first).toEqual({ value: { id: "evt-1", data: { kind: "message.posted" } }, done: false });
    expect(await take(iterator, 1)).toEqual([{ data: { kind: "untracked" } }]);
    expect(runtime.opened[0]!.input).toEqual({ since: "evt-0" });

    const pending = iterator.next();
    abort.abort();
    expect(await pending).toEqual({ value: undefined, done: true });
    expect(runtime.opened[0]!.stopped).toBe(true);
  });

  test("ends with an error when the browser falls behind", async () => {
    const runtime = fakeRuntime();
    const iterator = bridgeRuntimeStream("tail.events", undefined, undefined, { subscribe: runtime.subscribe, maxQueued: 2 });
    const first = iterator.next();
    const observer = runtime.opened[0]!.observer;
    for (let i = 0; i < 5; i += 1) observer.onData({ id: `e${i}`, data: i });
    await first;

    await expect(take(iterator, 5)).rejects.toThrow(/fell behind/);
    expect(runtime.opened[0]!.stopped).toBe(true);
  });

  test("passes on a runtime error, and ends when the runtime does", async () => {
    const failing = fakeRuntime();
    const broken = bridgeRuntimeStream("tail.events", undefined, undefined, { subscribe: failing.subscribe });
    const next = broken.next();
    failing.opened[0]!.observer.onError(new Error("runtime restarted"));
    await expect(next).rejects.toThrow(/runtime restarted/);

    const ending = fakeRuntime();
    const finished = bridgeRuntimeStream("tail.events", undefined, undefined, { subscribe: ending.subscribe });
    const last = finished.next();
    ending.opened[0]!.observer.onComplete();
    expect(await last).toEqual({ value: undefined, done: true });
  });
});

describe("bridgeEventStream", () => {
  const deps = (response: () => Response, calls: { url: string; init?: RequestInit }[] = []) => ({
    fetch: (async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return response();
    }) as typeof fetch,
    baseUrl: () => "http://127.0.0.1:1",
    token: () => "test-token",
  });

  test("relays the stream's text as it arrives, with this host's credential", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: one\n\n"));
        controller.enqueue(new TextEncoder().encode("data: two\n\n"));
        controller.close();
      },
    });
    const chunks: string[] = [];
    for await (const chunk of bridgeEventStream("/api/broadcast/stream", undefined, deps(
      () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
      calls,
    ))) chunks.push(chunk);

    expect(chunks.join("")).toBe("data: one\n\ndata: two\n\n");
    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer test-token");
  });

  test("refuses credential paths and answers that aren't streams", async () => {
    const stream = (path: string, response: () => Response) => bridgeEventStream(path, undefined, deps(response)).next();
    await expect(stream("/api/pairing/state", () => new Response(""))).rejects.toThrow(/unsupported_web_path/);
    await expect(stream("/api/agents", () => Response.json({ ok: true }))).rejects.toThrow(/instead of a live stream/);
  });
});
