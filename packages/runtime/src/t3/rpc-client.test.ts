import { afterEach, describe, expect, test } from "bun:test";
import { T3RpcClient, T3RpcError, normalizeT3WebSocketUrl } from "./rpc-client.js";

type Envelope = Record<string, unknown>;
const clients: T3RpcClient[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) server.stop(true);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type FixtureSocket = { send(message: string): unknown; close(): void };
type FixtureRequest = { url: string; headers: Headers };

async function fixture(handler: (socket: FixtureSocket, message: Envelope, request: FixtureRequest) => void) {
  const server = Bun.serve<FixtureRequest>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, server) {
      if (server.upgrade(request, { data: { url: request.url, headers: new Headers(request.headers) } })) return;
      return new Response("Expected WebSocket", { status: 400 });
    },
    websocket: {
      message(socket, bytes) { handler(socket, JSON.parse(bytes.toString()) as Envelope, socket.data); },
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function client(url: string, options: Omit<ConstructorParameters<typeof T3RpcClient>[0], "url"> = {}) {
  const instance = new T3RpcClient({ url, ...options });
  clients.push(instance);
  return instance;
}

function success(socket: FixtureSocket, requestId: unknown, value: unknown) {
  socket.send(JSON.stringify({ _tag: "Exit", requestId, exit: { _tag: "Success", value } }));
}

describe("T3 Effect RPC transport", () => {
  test("normalizes environment origins and rejects credentials and unsupported endpoints", () => {
    expect(normalizeT3WebSocketUrl("http://127.0.0.1:3773")).toBe("ws://127.0.0.1:3773/ws");
    expect(normalizeT3WebSocketUrl("https://t3.example/ws")).toBe("wss://t3.example/ws");
    for (const value of ["bad", "file:///tmp/t3", "https://t3.example/other", "https://t3.example?wsTicket=private-ticket", "https://user:private-password@t3.example", "https://t3.example/#secret"]) {
      try { normalizeT3WebSocketUrl(value); throw new Error("expected rejection"); }
      catch (error) {
        expect(error).toBeInstanceOf(T3RpcError);
        expect((error as T3RpcError).code).toBe("invalid-endpoint");
        expect(String(error)).not.toContain("private-ticket");
        expect(String(error)).not.toContain("private-password");
      }
    }
    expect(() => client("http://127.0.0.1", { timeoutMs: Infinity })).toThrow("positive finite integer");
    expect(() => client("http://127.0.0.1", { token: "secret\r\nvalue" })).toThrow("line breaks");
  });

  test("authenticates and correlates concurrent calls using real Effect JSON envelopes", async () => {
    const calls: Envelope[] = [];
    let authorization: string | undefined;
    let cookie: string | undefined;
    let path: string | undefined;
    const url = await fixture((socket, message, request) => {
      calls.push(message);
      authorization = request.headers.get("authorization") ?? undefined;
      cookie = request.headers.get("cookie") ?? undefined;
      path = new URL(request.url).pathname;
      if (calls.length === 2) {
        // Effect serialization also permits a batch of envelopes in one frame.
        socket.send(JSON.stringify([
          { _tag: "Exit", requestId: message.id, exit: { _tag: "Success", value: "second" } },
          { _tag: "Exit", requestId: calls[0]!.id, exit: { _tag: "Success", value: "first" } },
        ]));
      }
    });
    const rpc = client(url, { token: "fixture-session-token", cookie: "session=fixture-cookie-token" });
    const results = await Promise.all([rpc.call("first.method", { value: 1 }), rpc.call("second.method", {})]);
    expect(results).toEqual(["first", "second"]);
    expect(authorization).toBe("Bearer fixture-session-token");
    expect(cookie).toBe("session=fixture-cookie-token");
    expect(path).toBe("/ws");
    expect(calls[0]).toEqual({ _tag: "Request", id: "1", tag: "first.method", payload: { value: 1 }, headers: [] });
    expect(JSON.stringify(rpc)).not.toContain("fixture-session-token");
    expect(JSON.stringify(rpc)).not.toContain("fixture-cookie-token");
  });

  test("acknowledges consumed chunks and interrupts a subscription when its iterator closes", async () => {
    const control: Envelope[] = [];
    const interrupted = deferred<Envelope>();
    const url = await fixture((socket, message) => {
      if (message._tag === "Request") {
        socket.send(JSON.stringify({ _tag: "Chunk", requestId: message.id, values: [{ kind: "snapshot", sequence: 10 }] }));
      } else if (message._tag === "Ack") {
        control.push(message);
        socket.send(JSON.stringify({ _tag: "Chunk", requestId: message.requestId, values: [{ kind: "event", sequence: 11 }] }));
      } else if (message._tag === "Interrupt") interrupted.resolve(message);
    });
    const rpc = client(url);
    const iterator = rpc.stream<{ sequence: number }>("orchestration.subscribeShell", {})[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.sequence).toBe(10);
    expect(control).toHaveLength(0);
    expect((await iterator.next()).value?.sequence).toBe(11);
    expect(control).toEqual([{ _tag: "Ack", requestId: "1" }]);
    await iterator.return?.();
    expect(await interrupted.promise).toEqual({ _tag: "Interrupt", requestId: "1" });
  });

  test("delivers a final chunk followed by successful stream termination", async () => {
    const url = await fixture((socket, message) => {
      if (message._tag === "Request") {
        socket.send(JSON.stringify({ _tag: "Chunk", requestId: message.id, values: ["a", "b"] }));
      } else if (message._tag === "Ack") success(socket, message.requestId, undefined);
    });
    const values: string[] = [];
    for await (const item of client(url).stream<string>("finite.stream", {})) values.push(item);
    expect(values).toEqual(["a", "b"]);
  });

  test("cancels an active mutation exactly once without replaying it", async () => {
    const received = deferred<void>();
    const interrupted = deferred<void>();
    let requests = 0;
    const url = await fixture((_socket, message) => {
      if (message._tag === "Request") { requests++; received.resolve(); }
      else if (message._tag === "Interrupt") interrupted.resolve();
    });
    const abort = new AbortController();
    const pending = client(url).call("orchestration.dispatchCommand", { type: "thread.turn.start" }, { signal: abort.signal });
    await received.promise;
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted", requestSent: true });
    await interrupted.promise;
    expect(requests).toBe(1);
  });

  test("an abort during a delayed upgrade prevents a later WebSocket mutation write", async () => {
    const upgrading = deferred<void>();
    const allowUpgrade = deferred<void>();
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request, server) {
        upgrading.resolve();
        await allowUpgrade.promise;
        if (server.upgrade(request)) return;
        return new Response("Expected WebSocket", { status: 400 });
      },
      websocket: { message() { requests++; } },
    });
    servers.push(server);
    const rpc = client(`http://127.0.0.1:${server.port}`);
    const abort = new AbortController();
    const pending = rpc.call("orchestration.dispatchCommand", { type: "thread.turn.start" }, { signal: abort.signal });
    await upgrading.promise;
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted", requestSent: false });
    allowUpgrade.resolve();
    await rpc.connect();
    expect(requests).toBe(0);
  });

  test("applies a finite request deadline and sends a transport interrupt", async () => {
    const interrupted = deferred<void>();
    let requests = 0;
    const url = await fixture((_socket, message) => {
      if (message._tag === "Request") requests++;
      if (message._tag === "Interrupt") interrupted.resolve();
    });
    await expect(client(url).call("slow.method", {}, { timeoutMs: 100 })).rejects.toMatchObject({ code: "timeout" });
    await interrupted.promise;
    expect(requests).toBe(1);
  });

  test("rejects a disconnected mutation without replay and permits an explicit later snapshot", async () => {
    const tags: unknown[] = [];
    const url = await fixture((socket, message) => {
      if (message._tag !== "Request") return;
      tags.push(message.tag);
      if (message.tag === "orchestration.dispatchCommand") socket.close();
      else success(socket, message.id, { sequence: 12 });
    });
    const rpc = client(url);
    await expect(rpc.call("orchestration.dispatchCommand", { commandId: "once" })).rejects.toMatchObject({ code: "disconnected" });
    expect(await rpc.call("snapshot", {})).toEqual({ sequence: 12 });
    expect(tags).toEqual(["orchestration.dispatchCommand", "snapshot"]);
  });

  test("sanitizes typed remote failure messages", async () => {
    const token = "fixture-private-session-token";
    const url = await fixture((socket, message) => socket.send(JSON.stringify({
      _tag: "Exit", requestId: message.id,
      exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "EnvironmentAuthorizationError", message: `Rejected ${token}` } }] },
    })));
    const rpc = client(url, { token });
    let failure: unknown;
    try { await rpc.call("forbidden", {}); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "remote", remoteTag: "EnvironmentAuthorizationError" });
    expect(String(failure)).toContain("[redacted]");
    expect(String(failure)).not.toContain(token);
  });

  test("redacts a cookie's credential value when the server echoes only that value", async () => {
    const token = "fixture-cookie-private-value";
    const url = await fixture((socket, message) => socket.send(JSON.stringify({
      _tag: "Exit", requestId: message.id,
      exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "Rejected", message: `Cookie rejected: ${token}` } }] },
    })));
    let failure: unknown;
    try { await client(url, { cookie: `t3_session=${token}; another=second-value` }).call("forbidden", {}); }
    catch (error) { failure = error; }
    expect(String(failure)).toContain("[redacted]");
    expect(String(failure)).not.toContain(token);
  });

  test("rejects an unauthenticated upgrade without exposing response bodies or credentials", async () => {
    const token = "fixture-invalid-private-session";
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(`invalid ${token}`, { status: 401 }) });
    servers.push(server);
    let failure: unknown;
    try { await client(`http://127.0.0.1:${server.port}`, { token }).call("forbidden", {}); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(T3RpcError);
    expect(["authentication", "connection", "disconnected"]).toContain((failure as T3RpcError).code);
    expect(String(failure)).not.toContain(token);
  });

  test("rejects malformed envelopes rather than leaving calls pending", async () => {
    const url = await fixture((socket) => socket.send(JSON.stringify({ _tag: "Exit", requestId: "1", exit: { _tag: "Unknown" } })));
    await expect(client(url).call("snapshot", {})).rejects.toMatchObject({ code: "protocol" });
  });

  test("bounds stream chunks and in-flight requests", async () => {
    const url = await fixture((socket, message) => {
      if (message._tag === "Request" && message.tag === "large.stream") {
        socket.send(JSON.stringify({ _tag: "Chunk", requestId: message.id, values: [1, 2, 3] }));
      }
    });
    const rpc = client(url, { maxBufferedItems: 2, maxInFlight: 1 });
    const iterator = rpc.stream("large.stream", {})[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ code: "limit" });
    const abort = new AbortController();
    const first = rpc.call("waiting", {}, { signal: abort.signal });
    await expect(rpc.call("too.many", {})).rejects.toMatchObject({ code: "limit" });
    abort.abort();
    await expect(first).rejects.toMatchObject({ code: "aborted" });
  });

  test("does not send a payload exceeding the frame bound", async () => {
    let requests = 0;
    const url = await fixture(() => { requests++; });
    await expect(client(url, { maxFrameBytes: 128 }).call("large.payload", { text: "x".repeat(200) })).rejects.toMatchObject({ code: "limit" });
    expect(requests).toBe(0);
  });
});
