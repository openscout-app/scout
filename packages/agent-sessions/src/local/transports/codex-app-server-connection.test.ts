import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { getEventListeners } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WebSocketFrameDecoder,
  connectCodexAppServerSocket,
  encodeWebSocketFrame,
  parseCodexAppServerDaemonVersion,
  resolveCodexAppServerConnectionConfig,
  defaultCodexAppServerControlSocketPath,
} from "./codex-app-server-connection.ts";
import { inspectLoadedCodexThread, sendToLoadedCodexThread } from "./codex-loaded-thread.ts";
import { CodexAppServerClient, CodexAppServerTransport, type CodexAppServerSessionOptions } from "./codex-app-server.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function tempDir(): Promise<string> {
  // Unix socket paths are length-limited; keep them short.
  const dir = await mkdtemp(join(tmpdir(), "cxa-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

type FakeRequest = { id?: string | number; method?: string; params?: Record<string, unknown> };

/**
 * Minimal WebSocket-over-unix app-server: completes the HTTP upgrade, decodes
 * masked client frames, and answers with unmasked server frames.
 */
async function startFakeAppServer(
  socketPath: string,
  respond: (request: FakeRequest, reply: (message: unknown) => void) => void,
): Promise<{ server: Server; received: FakeRequest[]; connections: Socket[]; maskedFrames: boolean[] }> {
  const received: FakeRequest[] = [];
  const connections: Socket[] = [];
  const maskedFrames: boolean[] = [];
  const server = createServer((socket) => {
    connections.push(socket);
    let upgraded = false;
    let head = Buffer.alloc(0);
    const decoder = new WebSocketFrameDecoder();
    const reply = (message: unknown) => {
      socket.write(encodeWebSocketFrame(0x1, Buffer.from(JSON.stringify(message)), { mask: false }));
    };
    socket.on("data", (chunk: Buffer) => {
      if (!upgraded) {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end === -1) return;
        upgraded = true;
        socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
        chunk = head.subarray(end + 4);
        if (chunk.length === 0) return;
      }
      maskedFrames.push(chunk.length > 1 && (chunk[1]! & 0x80) !== 0);
      for (const frame of decoder.push(chunk)) {
        if (frame.opcode === 0x8) {
          socket.write(encodeWebSocketFrame(0x8, frame.payload, { mask: false }));
          socket.end();
          continue;
        }
        const request = JSON.parse(frame.payload.toString("utf8")) as FakeRequest;
        received.push(request);
        respond(request, reply);
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  cleanups.push(() => connections.forEach((socket) => socket.destroy()));
  return { server, received, connections, maskedFrames };
}

function clientOptions(dir: string, extra: Partial<CodexAppServerSessionOptions> = {}): CodexAppServerSessionOptions {
  return {
    agentName: "deadline-test", sessionId: "deadline-test", cwd: dir, systemPrompt: "test",
    runtimeDirectory: join(dir, "rt"), logsDirectory: join(dir, "logs"),
    connection: { mode: "attach", socketPath: join(dir, "deadline.sock") },
    startupTimeoutMs: 1_000, controlRequestTimeoutMs: 100,
    ...extra,
  };
}

test("another client continues the loaded Codex thread and steers only its observed turn", async () => {
  const socket = join(await tempDir(), "control.sock");
  let status: { type: string; activeFlags?: string[] } = { type: "idle" };
  let activeTurn = "first", historyMode = "paginated";
  const fake = await startFakeAppServer(socket, ({ id, method, params }, reply) => {
    if (!id) return;
    const responses: Record<string, unknown> = {
      initialize: {}, "thread/read": { thread: { id: "thread", status, historyMode,
        turns: params?.includeTurns ? [{ id: activeTurn, status: "inProgress" }] : [] } },
      "thread/turns/list": { data: [{ id: activeTurn, status: "inProgress" }] },
      "turn/start": { turn: { id: activeTurn } }, "turn/steer": { turnId: params?.expectedTurnId },
    };
    reply({ id, result: responses[method!] });
  });
  expect(await sendToLoadedCodexThread("thread", { state: "idle" }, "continue", socket)).toBe("accepted");
  status = { type: "active", activeFlags: [] };
  const active = await inspectLoadedCodexThread("thread", socket);
  if (active?.state !== "active") throw new Error("expected the running turn");
  expect(await sendToLoadedCodexThread("thread", active, "steer", socket)).toBe("accepted");
  historyMode = "legacy";
  expect(await inspectLoadedCodexThread("thread", socket)).toEqual(active);
  activeTurn = "replacement";
  expect(await sendToLoadedCodexThread("thread", active, "stale", socket)).toBe("changed");
  status.activeFlags = ["waitingOnApproval"];
  expect(await inspectLoadedCodexThread("thread", socket)).toEqual({ state: "blocked", reason: "approval" });
  expect(await sendToLoadedCodexThread("thread", active, "blocked", socket)).toBe("changed");
  status = { type: "notLoaded" };
  expect(await inspectLoadedCodexThread("thread", socket)).toBeNull();
  expect(await sendToLoadedCodexThread("other-thread", { state: "idle" }, "wrong", socket)).toBe("changed");
  expect(fake.received.filter(r => ["turn/start", "turn/steer", "thread/start", "thread/resume"].includes(r.method!))
    .map(({ method, params }) => [method, params])).toEqual([
    ["turn/start", { threadId: "thread", input: [{ type: "text", text: "continue", text_elements: [] }] }],
    ["turn/steer", { threadId: "thread", expectedTurnId: "first", input: [{ type: "text", text: "steer", text_elements: [] }] }],
  ]);
});

test("in-flight control abort removes the RPC and its abort listener", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "logs"));
  const controller = new AbortController();
  const transport = new CodexAppServerTransport(clientOptions(dir, { signal: controller.signal }));
  const sent: Array<{ id: string; method: string }> = [];
  const seam = transport as unknown as {
    connection: unknown;
    request(method: string, params: unknown): Promise<unknown>;
    pendingRequests: Map<string, unknown>;
    handleMessageText(text: string): void;
    wireLog: { flush(): Promise<void> };
  };
  seam.connection = { isOpen: () => true, send: (text: string) => sent.push(JSON.parse(text)), setReadingPaused: () => {} };
  const pending = seam.request("initialize", {});
  expect(seam.pendingRequests.size).toBe(1);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "CODEX_APP_SERVER_CONTROL_ABORTED", method: "initialize", submissionUnknown: false });
  expect(seam.pendingRequests.size).toBe(0);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  seam.handleMessageText(JSON.stringify({ id: sent[0]!.id, result: {} }));
  expect(seam.pendingRequests.size).toBe(0);
  await seam.wireLog.flush();
});

test("a control deadline distinguishes an unacknowledged turn from pre-submission startup", async () => {
  const dir = await tempDir();
  for (const method of ["initialize", "turn/start", "turn/steer"]) {
    const controller = new AbortController();
    const transport = new CodexAppServerTransport(clientOptions(dir, { signal: controller.signal, controlRequestTimeoutMs: 10 }));
    const seam = transport as unknown as { connection: unknown; request(method: string, params: unknown): Promise<unknown>; pendingRequests: Map<string, unknown> };
    seam.connection = { isOpen: () => true, send: () => undefined };
    await expect(seam.request(method, {})).rejects.toMatchObject({
      code: "CODEX_APP_SERVER_CONTROL_TIMEOUT", method, timeoutMs: 10, submissionUnknown: method !== "initialize",
    });
    expect(seam.pendingRequests.size).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(transport.nativeControlBlocked).toBe(method !== "initialize");
  }
});

test("startup deadline spans the whole handshake and releases queued client operations", async () => {
  const dir = await tempDir();
  const fake = await startFakeAppServer(join(dir, "deadline.sock"), (request, reply) => {
    if (request.method === "initialize") reply({ id: request.id, result: {} });
    // Neither thread/start nor turn/start is acknowledged.
  });
  // Allow filesystem/socket setup on a loaded host. Startup must still time
  // out before either the RPC fallback or the explicit outer test timeout.
  const client = new CodexAppServerClient(clientOptions(dir, { startupTimeoutMs: 1_000, controlRequestTimeoutMs: 60_000 }));
  const first = client.invoke("first");
  const second = client.invoke("second");
  const results = await Promise.allSettled([first, second]);
  expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  for (const result of results) {
    if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "CODEX_APP_SERVER_CONTROL_TIMEOUT", submissionUnknown: false });
  }
  expect(fake.received.filter((request) => request.method === "initialize")).toHaveLength(2);
  expect(fake.received.some((request) => request.method === "turn/start")).toBe(false);
  expect(client.isAlive()).toBe(false);
}, 30_000);

test("owner abort during initialize prevents subsequent thread or turn creation", async () => {
  const dir = await tempDir();
  const controller = new AbortController();
  const fake = await startFakeAppServer(join(dir, "deadline.sock"), (request) => {
    if (request.method === "initialize") controller.abort();
  });
  const client = new CodexAppServerClient(clientOptions(dir, { signal: controller.signal }));
  await expect(client.invoke("never submitted")).rejects.toMatchObject({ code: "CODEX_APP_SERVER_CONTROL_ABORTED", submissionUnknown: false });
  expect(fake.received.map((request) => request.method)).toEqual(["initialize"]);
  expect(client.isAlive()).toBe(false);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

test("concurrent startup waiters share deadline cleanup before a fresh connection", async () => {
  const dir = await tempDir();
  let initializations = 0;
  const fake = await startFakeAppServer(join(dir, "deadline.sock"), (request, reply) => {
    if (request.method === "initialize") {
      initializations += 1;
      if (initializations > 1) reply({ id: request.id, result: {} });
    }
    if (request.method === "thread/start") reply({ id: request.id, result: { thread: { id: "recovered-thread" } } });
    if (request.method === "thread/unsubscribe") reply({ id: request.id, result: {} });
  });
  const client = new CodexAppServerClient(clientOptions(dir, { controlRequestTimeoutMs: 20 }));
  const outcomes = await Promise.allSettled([client.ensureOnline(), client.ensureOnline()]);
  expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
  expect(initializations).toBe(1);
  expect((await client.ensureOnline()).threadId).toBe("recovered-thread");
  expect(initializations).toBe(2);
  expect(fake.connections).toHaveLength(2);
  expect(client.isAlive()).toBe(true);
  await client.shutdown();
});

test("promoting a generated provider thread ID preserves the live transport while other launch dimensions stay strict", async () => {
  const dir = await tempDir();
  await startFakeAppServer(join(dir, "deadline.sock"), (request, reply) => {
    if (request.method === "initialize") reply({ id: request.id, result: {} });
    if (request.method === "thread/start") reply({ id: request.id, result: { thread: { id: "promoted-thread" } } });
    if (request.method === "thread/unsubscribe") reply({ id: request.id, result: {} });
  });
  const options = clientOptions(dir);
  const transport = new CodexAppServerTransport(options);
  await transport.ensureOnline();
  const promoted = { ...options, threadId: "promoted-thread", requireExistingThread: true };
  expect(transport.matches(promoted)).toBe(true);
  expect(transport.matches({ ...promoted, threadId: "different-thread" })).toBe(false);
  expect(transport.matches({ ...promoted, cwd: join(dir, "other") })).toBe(false);
  expect(transport.matches({ ...promoted, launchArgs: ["-c", "model=gpt-6.1-sol"] })).toBe(false);
  transport.update(promoted);
  expect(transport.matches(options)).toBe(true);
  await transport.shutdown();
  expect(transport.matches(options)).toBe(false);
});

test("a stored-thread resume timeout never falls back to a fresh thread", async () => {
  const dir = await tempDir();
  await mkdir(join(dir, "rt"));
  await writeFile(join(dir, "rt", "codex-thread-id.txt"), "existing-thread");
  const fake = await startFakeAppServer(join(dir, "deadline.sock"), (request, reply) => {
    if (request.method === "initialize") reply({ id: request.id, result: {} });
  });
  const client = new CodexAppServerClient(clientOptions(dir, { controlRequestTimeoutMs: 20 }));
  await expect(client.ensureOnline()).rejects.toMatchObject({ code: "CODEX_APP_SERVER_CONTROL_TIMEOUT", method: "thread/resume" });
  expect(fake.received.some((request) => request.method === "thread/start")).toBe(false);
  expect(await readFile(join(dir, "rt", "codex-thread-id.txt"), "utf8")).toBe("existing-thread");
});

test("turn acknowledgement timeout preserves unknown ownership and does not resend", async () => {
  const dir = await tempDir();
  const fake = await startFakeAppServer(join(dir, "deadline.sock"), (request, reply) => {
    if (request.method === "initialize" || request.method === "thread/unsubscribe") reply({ id: request.id, result: {} });
    if (request.method === "thread/start") reply({ id: request.id, result: { thread: { id: "thread-1" } } });
  });
  const client = new CodexAppServerClient(clientOptions(dir, { controlRequestTimeoutMs: 20 }));
  await expect(client.invoke("may have been accepted")).rejects.toMatchObject({ code: "CODEX_APP_SERVER_CONTROL_TIMEOUT", method: "turn/start", submissionUnknown: true });
  expect(client.hasActiveTurn()).toBe(true);
  await expect(client.invoke("must not overwrite unknown turn")).rejects.toThrow("already has an active turn");
  expect(fake.received.filter((request) => request.method === "turn/start")).toHaveLength(1);
  await client.shutdown();
});

test("control deadlines do not impose a completion deadline on a long turn", async () => {
  const dir = await tempDir();
  await startFakeAppServer(join(dir, "deadline.sock"), (request, reply) => {
    if (request.method === "initialize" || request.method === "thread/unsubscribe") reply({ id: request.id, result: {} });
    if (request.method === "thread/start") reply({ id: request.id, result: { thread: { id: "thread-1" } } });
    if (request.method === "turn/start") {
      reply({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        reply({ method: "item/completed", params: { turnId: "turn-1", item: { type: "agentMessage", id: "answer", text: "late answer" } } });
        reply({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
      }, 80);
    }
  });
  const client = new CodexAppServerClient(clientOptions(dir, { controlRequestTimeoutMs: 20 }));
  expect((await client.invoke("long work")).output).toBe("late answer");
  await client.shutdown();
});

test("socket handshake abort closes the pending connection", async () => {
  const dir = await tempDir();
  const socketPath = join(dir, "blocked.sock");
  const controller = new AbortController();
  const connections: Socket[] = [];
  const server = createServer((socket) => { connections.push(socket); controller.abort(new Error("owner ended")); });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  cleanups.push(() => connections.forEach((socket) => socket.destroy()));
  await expect(connectCodexAppServerSocket({ socketPath, signal: controller.signal, handlers: { onMessage() {}, onClose() {} } })).rejects.toThrow("owner ended");
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

test("WebSocket frames round-trip across all three length encodings and split chunks", () => {
  for (const size of [0, 5, 125, 126, 300, 65_535, 65_536, 70_000]) {
    const payload = Buffer.alloc(size, 0x61);
    const encoded = encodeWebSocketFrame(0x1, payload, { mask: true });
    expect((encoded[1]! & 0x80) !== 0).toBe(true);
    const decoder = new WebSocketFrameDecoder();
    // Feed byte-uneven slices to prove partial frames stay buffered.
    const frames = [
      ...decoder.push(encoded.subarray(0, 1)),
      ...decoder.push(encoded.subarray(1, 3)),
      ...decoder.push(encoded.subarray(3)),
    ];
    expect(frames).toHaveLength(1);
    expect(frames[0]!.fin).toBe(true);
    expect(frames[0]!.opcode).toBe(0x1);
    expect(frames[0]!.payload.equals(payload)).toBe(true);
  }
});

test("masking uses the RFC 6455 XOR key and two frames in one chunk both decode", () => {
  const maskKey = Buffer.from([1, 2, 3, 4]);
  const frame = encodeWebSocketFrame(0x1, Buffer.from("hi"), { mask: true, maskKey });
  expect([...frame]).toEqual([0x81, 0x82, 1, 2, 3, 4, "h".charCodeAt(0) ^ 1, "i".charCodeAt(0) ^ 2]);
  const decoder = new WebSocketFrameDecoder();
  const frames = decoder.push(Buffer.concat([
    encodeWebSocketFrame(0x1, Buffer.from("one"), { mask: false }),
    encodeWebSocketFrame(0x1, Buffer.from("two"), { mask: false }),
  ]));
  expect(frames.map((entry) => entry.payload.toString())).toEqual(["one", "two"]);
});

test("attach config defaults to the Codex control socket; spawn stays the default mode", () => {
  expect(resolveCodexAppServerConnectionConfig(undefined)).toEqual({ mode: "spawn" });
  expect(resolveCodexAppServerConnectionConfig({ mode: "attach" })).toEqual({
    mode: "attach",
    socketPath: defaultCodexAppServerControlSocketPath(),
  });
  expect(defaultCodexAppServerControlSocketPath("/Users/x")).toBe(
    "/Users/x/.codex/app-server-control/app-server-control.sock",
  );
});

test("daemon version output parses the socket and app-server version", () => {
  expect(parseCodexAppServerDaemonVersion(
    '{"status":"running","socketPath":"/s.sock","cliVersion":"0.155.0","appServerVersion":"0.147.0"}\n',
  )).toEqual({ status: "running", socketPath: "/s.sock", cliVersion: "0.155.0", appServerVersion: "0.147.0" });
  expect(parseCodexAppServerDaemonVersion("not json")).toBeNull();
});

test("socket connection completes the upgrade, sends masked text frames, and reassembles fragments", async () => {
  const dir = await tempDir();
  const socketPath = join(dir, "a.sock");
  const fake = await startFakeAppServer(socketPath, (request, _reply) => {
    const socket = fake.connections[0]!;
    // Answer in two fragments: TEXT(fin=0) + CONTINUATION(fin=1).
    const body = Buffer.from(JSON.stringify({ id: request.id, result: { ok: true } }));
    const first = encodeWebSocketFrame(0x1, body.subarray(0, 5), { mask: false });
    first[0] = first[0]! & 0x7f;
    socket.write(Buffer.concat([first, encodeWebSocketFrame(0x0, body.subarray(5), { mask: false })]));
  });
  const messages: string[] = [];
  const connection = await connectCodexAppServerSocket({
    socketPath,
    handlers: { onMessage: (text) => messages.push(text), onClose: () => undefined },
  });
  expect(connection.mode).toBe("attached");
  expect(connection.pid).toBeNull();
  connection.send(JSON.stringify({ id: "1", method: "ping" }));
  await Bun.sleep(30);
  expect(fake.maskedFrames.every(Boolean)).toBe(true);
  expect(messages.map((text) => JSON.parse(text))).toEqual([{ id: "1", result: { ok: true } }]);
  await connection.close();
  expect(connection.isOpen()).toBe(false);
});

test("socket connection rejects a refused upgrade with the status line", async () => {
  const dir = await tempDir();
  const socketPath = join(dir, "r.sock");
  const server = createServer((socket) => {
    socket.once("data", () => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await expect(connectCodexAppServerSocket({
    socketPath,
    handlers: { onMessage: () => undefined, onClose: () => undefined },
  })).rejects.toThrow("refused the WebSocket upgrade: HTTP/1.1 400 Bad Request");
});

test("attached client runs a turn over the socket, records identity, and only detaches on shutdown", async () => {
  const dir = await tempDir();
  const socketPath = join(dir, "c.sock");
  const fake = await startFakeAppServer(socketPath, (request, reply) => {
    switch (request.method) {
      case "initialize":
        reply({ id: request.id, result: {
          userAgent: "Codex Desktop/0.147.0 (Mac OS 26.0.0; arm64)",
          codexHome: "/Users/fake/.codex",
          platformFamily: "unix",
          platformOs: "macos",
        } });
        return;
      case "thread/start":
        reply({ id: request.id, result: { thread: { id: "thr_1", path: null } } });
        return;
      case "thread/name/set":
      case "thread/unsubscribe":
        reply({ id: request.id, result: {} });
        return;
      case "turn/start":
        reply({ id: request.id, result: { turn: { id: "turn_1" } } });
        reply({ method: "item/completed", params: { turnId: "turn_1", item: { type: "agentMessage", id: "m1", text: "pong" } } });
        reply({ method: "turn/completed", params: { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } } });
        return;
      default:
        if (request.id !== undefined) reply({ id: request.id, error: { message: `unexpected ${request.method}` } });
    }
  });

  const client = new CodexAppServerClient({
    agentName: "attach-test",
    sessionId: "attach-test",
    cwd: dir,
    systemPrompt: "test",
    runtimeDirectory: join(dir, "rt"),
    logsDirectory: join(dir, "logs"),
    launchArgs: ["-c", 'model="gpt-5.6-sol"', "-c", 'model_reasoning_effort="low"'],
    connection: { mode: "attach", socketPath },
    threadName: "Scout attach smoke test",
  });

  const result = await client.invoke("ping");
  expect(result.output).toBe("pong");
  expect(result.threadId).toBe("thr_1");
  expect(result.codexAppServer).toMatchObject({
    connection: "attached",
    socketPath,
    pid: null,
    userAgent: "Codex Desktop/0.147.0 (Mac OS 26.0.0; arm64)",
    appServerVersion: "0.147.0",
    codexHome: "/Users/fake/.codex",
    platformOs: "macos",
    capabilityGaps: ["scout_mcp_injection", "launch_args", "process_env"],
  });

  const methods = fake.received.map((entry) => entry.method);
  expect(methods.slice(0, 5)).toEqual(["initialize", "initialized", "thread/start", "thread/name/set", "turn/start"]);
  const threadStart = fake.received.find((entry) => entry.method === "thread/start")!;
  expect(threadStart.params).toMatchObject({ cwd: dir, model: "gpt-5.6-sol", threadSource: "user" });
  const turnStart = fake.received.find((entry) => entry.method === "turn/start")!;
  expect(turnStart.params).toMatchObject({ threadId: "thr_1", model: "gpt-5.6-sol", effort: "low" });
  expect(fake.received.find((entry) => entry.method === "thread/name/set")!.params)
    .toEqual({ threadId: "thr_1", name: "Scout attach smoke test" });

  const state = JSON.parse(await readFile(join(dir, "rt", "state.json"), "utf8"));
  expect(state.pid).toBeNull();
  expect(state.codexAppServer.connection).toBe("attached");

  await client.shutdown({ reason: "test done" });
  expect(fake.received.at(-1)).toMatchObject({ method: "thread/unsubscribe", params: { threadId: "thr_1" } });
  expect(client.isAlive()).toBe(false);
  // The shared server is untouched: it still accepts new clients.
  expect(fake.server.listening).toBe(true);
  const again = await connectCodexAppServerSocket({
    socketPath,
    handlers: { onMessage: () => undefined, onClose: () => undefined },
  });
  await again.close();
});

test("attached client surfaces server errors verbatim instead of guessing", async () => {
  const dir = await tempDir();
  const socketPath = join(dir, "e.sock");
  await startFakeAppServer(socketPath, (request, reply) => {
    if (request.method === "initialize") {
      reply({ id: request.id, result: { userAgent: "Codex/0.147.0", codexHome: "/h" } });
    } else if (request.method === "thread/start") {
      reply({ id: request.id, result: { thread: { id: "thr_2", path: null } } });
    } else if (request.method === "turn/start") {
      reply({ id: request.id, error: { message: "The 'gpt-6-luna' model requires a newer version of Codex." } });
    } else if (request.id !== undefined) {
      reply({ id: request.id, result: {} });
    }
  });
  const client = new CodexAppServerClient({
    agentName: "attach-err",
    sessionId: "attach-err",
    cwd: dir,
    systemPrompt: "test",
    runtimeDirectory: join(dir, "rt"),
    logsDirectory: join(dir, "logs"),
    launchArgs: ["-c", 'model="gpt-6-luna"'],
    connection: { mode: "attach", socketPath },
  });
  await expect(client.invoke("hi")).rejects.toThrow("requires a newer version of Codex");
  await client.shutdown();
});

test("an attached socket that drops fails the session without killing anything", async () => {
  const dir = await tempDir();
  const socketPath = join(dir, "d.sock");
  const fake = await startFakeAppServer(socketPath, (request, reply) => {
    if (request.method === "initialize") reply({ id: request.id, result: { userAgent: "Codex/0.147.0" } });
    else if (request.method === "thread/start") reply({ id: request.id, result: { thread: { id: "thr_3", path: null } } });
    else if (request.method === "turn/start") {
      reply({ id: request.id, result: { turn: { id: "turn_3" } } });
      setTimeout(() => fake.connections[0]!.destroy(), 10);
    } else if (request.id !== undefined) reply({ id: request.id, result: {} });
  });
  const client = new CodexAppServerClient({
    agentName: "attach-drop",
    sessionId: "attach-drop",
    cwd: dir,
    systemPrompt: "test",
    runtimeDirectory: join(dir, "rt"),
    logsDirectory: join(dir, "logs"),
    connection: { mode: "attach", socketPath },
  });
  await expect(client.invoke("hi")).rejects.toMatchObject({ code: "CODEX_APP_SERVER_EXIT" });
  expect(client.isAlive()).toBe(false);
  expect(fake.server.listening).toBe(true);
});

test("spawned mode still speaks newline JSON over stdio and records a Scout-spawned identity", async () => {
  const dir = await tempDir();
  const fakeCodex = join(dir, "codex");
  await Bun.write(fakeCodex, `#!/usr/bin/env bun
if (process.argv.includes("--version")) { console.log("codex-cli 0.155.0"); process.exit(0); }
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    if (req.method === "initialize") out({ id: req.id, result: { userAgent: "codex_cli_rs/0.155.0 (test)", codexHome: "${dir}/home", platformOs: "macos" } });
    else if (req.method === "thread/start") out({ id: req.id, result: { thread: { id: "thr_s", path: null, params: req.params } } });
    else if (req.method === "turn/start") {
      out({ id: req.id, result: { turn: { id: "turn_s" } } });
      out({ method: "item/completed", params: { turnId: "turn_s", item: { type: "agentMessage", id: "m", text: "model=" + (req.params.model ?? "unset") } } });
      out({ method: "turn/completed", params: { threadId: "thr_s", turn: { id: "turn_s", status: "completed" } } });
    } else if (req.id !== undefined) out({ id: req.id, result: {} });
  }
});
`);
  await Bun.spawn(["chmod", "+x", fakeCodex]).exited;
  const previous = process.env.OPENSCOUT_CODEX_BIN;
  process.env.OPENSCOUT_CODEX_BIN = fakeCodex;
  cleanups.push(() => {
    if (previous === undefined) delete process.env.OPENSCOUT_CODEX_BIN;
    else process.env.OPENSCOUT_CODEX_BIN = previous;
  });

  const client = new CodexAppServerClient({
    agentName: "spawn-test",
    sessionId: "spawn-test",
    cwd: dir,
    systemPrompt: "test",
    runtimeDirectory: join(dir, "rt"),
    logsDirectory: join(dir, "logs"),
    launchArgs: ["-c", 'model="gpt-5.6-sol"'],
  });
  const result = await client.invoke("hi");
  // Spawned servers get the model through launch args, not on turn/start.
  expect(result.output).toBe("model=unset");
  expect(result.codexAppServer).toMatchObject({
    connection: "spawned",
    socketPath: null,
    userAgent: "codex_cli_rs/0.155.0 (test)",
    appServerVersion: "0.155.0",
    codexHome: `${dir}/home`,
    capabilityGaps: [],
  });
  expect(typeof result.codexAppServer?.pid).toBe("number");
  await client.shutdown({ reason: "test done" });
  expect(client.isAlive()).toBe(false);
});


test("published future choices and Default reach the app-server without model or config preflight", async () => {
  for (const runtime of [undefined, { model: "gpt-published-next", effort: "ultra" }]) {
    const dir = await tempDir();
    const socketPath = join(dir, "p.sock");
    const fake = await startFakeAppServer(socketPath, (request, reply) => {
      if (request.method === "initialize") reply({ id: request.id, result: { userAgent: "Codex/test" } });
      else if (request.method === "thread/start") reply({ id: request.id, result: { thread: { id: "published-thread", path: null } } });
      else if (request.method === "turn/start") {
        reply({ id: request.id, result: { turn: { id: "published-turn" } } });
        reply({ method: "item/completed", params: { turnId: "published-turn", item: { type: "agentMessage", id: "reply", text: "done" } } });
        reply({ method: "turn/completed", params: { threadId: "published-thread", turn: { id: "published-turn", status: "completed" } } });
      } else if (request.method === "model/list" || request.method === "config/read") {
        reply({ id: request.id, error: { message: "Discovery must not be required for published choices" } });
      } else if (request.id !== undefined) reply({ id: request.id, result: {} });
    });
    const client = new CodexAppServerClient({ agentName: "published", sessionId: "published", cwd: dir, systemPrompt: "test",
      runtimeDirectory: join(dir, "runtime"), logsDirectory: join(dir, "logs"),
      ...(runtime ? { launchArgs: ["-c", `model="${runtime.model}"`, "-c", `model_reasoning_effort="${runtime.effort}"`] } : {}),
      connection: { mode: "attach", socketPath } });
    try {
      expect((await client.invoke("hi")).output).toBe("done");
      expect(fake.received.some((request) => request.method === "model/list" || request.method === "config/read")).toBe(false);
      const start = fake.received.find((request) => request.method === "thread/start")!.params!;
      const turn = fake.received.find((request) => request.method === "turn/start")!.params!;
      if (runtime) {
        expect(start.model).toBe(runtime.model);
        expect(turn.model).toBe(runtime.model);
        expect(turn.effort).toBe(runtime.effort);
      } else {
        expect(start).not.toHaveProperty("model");
        expect(turn).not.toHaveProperty("model");
        expect(turn).not.toHaveProperty("effort");
      }
    } finally { await client.shutdown(); }
  }
});

test("a continuation keeps existing thread configuration without discovery or overrides", async () => {
  const dir = await tempDir();
  const socketPath = join(dir, "c.sock");
  const fake = await startFakeAppServer(socketPath, (request, reply) => {
    if (request.method === "initialize") reply({ id: request.id, result: { userAgent: "Codex/test" } });
    else if (request.method === "thread/resume") reply({ id: request.id, result: { thread: { id: "existing-thread", path: null }, model: "retired-context-model" } });
    else if (request.method === "turn/start") {
      reply({ id: request.id, result: { turn: { id: "continuation-turn" } } });
      reply({ method: "item/completed", params: { turnId: "continuation-turn", item: { type: "agentMessage", id: "reply", text: "continued" } } });
      reply({ method: "turn/completed", params: { threadId: "existing-thread", turn: { id: "continuation-turn", status: "completed" } } });
    } else if (request.method === "model/list" || request.method === "config/read") reply({ id: request.id, error: { message: "not required" } });
    else if (request.id !== undefined) reply({ id: request.id, result: {} });
  });
  const client = new CodexAppServerClient({ agentName: "continued", sessionId: "continued", cwd: dir, systemPrompt: "test",
    runtimeDirectory: join(dir, "runtime"), logsDirectory: join(dir, "logs"), threadId: "existing-thread", requireExistingThread: true,
    connection: { mode: "attach", socketPath } });
  try {
    expect((await client.invoke("continue")).output).toBe("continued");
    expect(fake.received.some((request) => request.method === "thread/start" || request.method === "model/list" || request.method === "config/read")).toBe(false);
    expect(fake.received.find((request) => request.method === "turn/start")!.params).not.toHaveProperty("model");
    expect(fake.received.find((request) => request.method === "turn/start")!.params).not.toHaveProperty("effort");
  } finally { await client.shutdown(); }
});
