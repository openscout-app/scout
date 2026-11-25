// Own Worker isolate: mock publishers never alter the unit runner's modules.
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { TailEvent } from "../tail/types.js";

const {
  routerPath,
  bufferPath,
  mode,
  runtimeDirectory,
  clientModule,
  remoteModule,
} = workerData;
const { TailReplayBuffer } = await import(bufferPath);
const { StreamResyncRequired } = await import(
  join(runtimeDirectory, "bounded-event-iterable.ts")
);
const buffer = new TailReplayBuffer(10_000);
const legacy = new Set<(event: TailEvent) => void>();
let attachError: Error | undefined;
let controlError: Error | undefined;
let ownerSignal: AbortSignal | undefined;
let snapshotHook: (() => void) | undefined;
const snapshot = buffer.snapshot.bind(buffer);
buffer.snapshot = (limit: number) => {
  const image = snapshot(limit);
  const hook = snapshotHook;
  snapshotHook = undefined;
  hook?.();
  return image;
};
const listeners = () => legacy.size + buffer.subscriberCount;
const event = (id: string, summary = id, source = "fixture"): TailEvent => ({
  id,
  source,
  summary,
  ts: 0,
  sessionId: "fixture",
  pid: 0,
  parentPid: null,
  project: "",
  cwd: "",
  harness: "unattributed",
  kind: "assistant",
});
const emit = (id: string, summary = id) => {
  const value = event(id, summary);
  buffer.publish(value);
  for (const fn of [...legacy]) fn(value);
  return value;
};
mock.module(join(runtimeDirectory, "tail/index.js"), () => ({
  snapshotRecentEvents: (limit: number) => buffer.recent(limit),
  subscribeTail: (fn: (event: TailEvent) => void) => {
    legacy.add(fn);
    return () => legacy.delete(fn);
  },
  readRecentLiveEvents: async () => [],
  getTailDiscovery: async () => ({ readStatus: { initialized: true }, transcripts: [], processes: [] }),
  refreshTailDiscovery: async () => ({ transcripts: [], processes: [] }),
  readTailEventsForSession: async () => null,
  readRecentTranscriptEvents: async () => [],
}));
mock.module(join(runtimeDirectory, "tail/service.js"), () => ({
  tailReplayEpoch: () => buffer.epoch,
  attachTailReplay: (options: {
    limit: number;
    sources?: string[];
    signal?: AbortSignal;
  }) => {
    if (attachError) throw attachError;
    return buffer.attach({
      ...options,
      signal: ownerSignal ?? options.signal,
      accepts: (value: TailEvent) =>
        !options.sources?.length || options.sources.includes(value.source),
    });
  },
}));
mock.module(join(runtimeDirectory, "broker-control-events.js"), () => ({
  snapshotPresenceControlEvents: () => [],
  snapshotRecentControlEvents: () => {
    if (controlError) throw controlError;
    return [];
  },
  subscribeControlEvents: () => () => {},
}));
mock.module(join(runtimeDirectory, "harness-topology/index.js"), () => ({
  getHarnessTopologySnapshot: () => ({}),
  snapshotRecentHarnessTopologyEvents: () => [],
  subscribeHarnessTopology: () => () => {},
}));
const { brokerRouter } = await import(routerPath);
const caller = brokerRouter.createCaller({});
const payload = (item: any): TailEvent => item.value[1];
const pause = () => new Promise((resolve) => setTimeout(resolve, 1));
async function until(check: () => boolean) {
  for (let i = 0; i < 2000 && !check(); i++) await pause();
  assert.ok(check(), "owned fixture did not reach expected state");
}

async function matrix() {
  let cases = 0;
  for (const sources of [undefined, [], ["one"], ["missing"]]) {
    for (const since of [undefined, "", "A", "B", "C", "unknown"]) {
      buffer.reset();
      for (const [id, source] of [
        ["A", "one"],
        ["B", "two"],
        ["C", "one"],
      ])
        buffer.publish(event(id, id, source));
      const stream = await caller.tail.events({
        tailProtocol: 1,
        since,
        sources,
      });
      try {
        const status = (await stream.next()).value;
        const start =
          since === "A" ? 1 : since === "B" ? 2 : since === "C" ? 3 : 0;
        const expected = buffer
          .recent(500)
          .slice(start)
          .filter(
            (value: TailEvent) =>
              !sources?.length || sources.includes(value.source),
          );
        assert.deepEqual(status, {
          type: "tail.subscription",
          schema: "scout.tail-subscription/v1",
          epoch: buffer.epoch,
          cursorFound: !since ? null : since === "unknown" ? false : true,
          cursorStatus: !since
            ? "not_requested"
            : since === "unknown"
              ? "not_retained"
              : "found",
          epochBinding: "not_supplied",
          replayLimit: 500,
          replayCount: expected.length,
          barrier: "bounded-replay-live/v1",
        });
        for (const value of expected)
          assert.deepEqual(payload(await stream.next()), value);
        const next = stream.next();
        buffer.publish(event("live", "live", sources?.[0] ?? "fixture"));
        assert.equal(payload(await next).id, "live");
        // Exactly one untracked status, and only before all replay/live data.
        cases++;
      } finally {
        await stream.return();
        assert.equal(listeners(), 0);
      }
    }
  }
  for (const count of [0, 1, 499, 500, 501, 10_001]) {
    buffer.reset();
    for (let i = 0; i < count; i++) emit(String(i));
    const stream = await caller.tail.events({ tailProtocol: 1, since: "0" });
    try {
      const status = (await stream.next()).value;
      assert.equal(
        status.cursorStatus,
        count >= 1 && count <= 500 ? "found" : "not_retained",
      );
      assert.equal(
        status.replayCount,
        count >= 1 && count <= 500 ? count - 1 : Math.min(count, 500),
      );
      cases++;
    } finally {
      await stream.return();
      assert.equal(listeners(), 0);
    }
  }
  buffer.reset();
  emit("dup", "first");
  emit("dup", "second");
  emit("C");
  const stream = await caller.tail.events({
    tailProtocol: 1,
    since: "dup",
    sinceEpoch: buffer.epoch,
  });
  try {
    const status = (await stream.next()).value;
    assert.equal(status.cursorStatus, "ambiguous");
    assert.equal(status.cursorFound, false);
    assert.equal(status.epochBinding, "matched");
    assert.equal(status.replayCount, 3);
    assert.equal(payload(await stream.next()).summary, "first");
    assert.equal(payload(await stream.next()).summary, "second");
    cases++;
  } finally {
    await stream.return();
    assert.equal(listeners(), 0);
  }
  return { cases };
}

async function negotiation() {
  for (const input of [
    undefined,
    {},
    { since: "", sources: [] },
    { since: "unknown" },
  ]) {
    buffer.reset();
    emit("A");
    const stream = await caller.tail.events(input);
    try {
      assert.equal(
        payload(await stream.next()).id,
        "A",
        "legacy first frame must remain tracked",
      );
    } finally {
      await stream.return();
      assert.equal(listeners(), 0);
    }
  }
  const invalid = [
    { tailProtocol: 0 },
    { tailProtocol: 2 },
    { tailProtocol: "1" },
    { tailProtocol: null },
    { sinceEpoch: buffer.epoch, since: "A" },
    { tailProtocol: 1, sinceEpoch: buffer.epoch },
    { tailProtocol: 1, since: "", sinceEpoch: buffer.epoch },
    { tailProtocol: 1, since: "A", sinceEpoch: "not-an-epoch" },
  ];
  for (const input of invalid) {
    await assert.rejects(
      caller.tail.events(input),
      (error: any) => error.code === "BAD_REQUEST",
    );
    assert.equal(listeners(), 0);
  }
  return { invalid: invalid.length, legacy: 4 };
}

async function epochs() {
  const first = buffer.epoch;
  const a = await caller.tail.events({ tailProtocol: 1 });
  const b = await caller.tail.events({ tailProtocol: 1 });
  try {
    assert.equal((await a.next()).value.epoch, first);
    assert.equal(
      (await b.next()).value.epoch,
      first,
      "epoch belongs to process aggregate, not subscription",
    );
    buffer.reset();
    assert.notEqual(buffer.epoch, first);
    await assert.rejects(a.next(), (error: any) => {
      assert.equal(
        error.epoch,
        first,
        "old failure must carry old captured epoch",
      );
      assert.equal(error.lastDeliveredId, undefined);
      return true;
    });
    await assert.rejects(b.next());
  } finally {
    await a.return();
    await b.return();
    assert.equal(listeners(), 0);
  }
  emit("same-id");
  for (const sinceEpoch of [first, buffer.epoch]) {
    const stream = await caller.tail.events({
      tailProtocol: 1,
      since: "same-id",
      sinceEpoch,
    });
    try {
      const status = (await stream.next()).value;
      assert.equal(status.cursorFound, sinceEpoch === buffer.epoch);
      assert.equal(
        status.cursorStatus,
        sinceEpoch === buffer.epoch ? "found" : "epoch_mismatch",
      );
      assert.equal(
        status.epochBinding,
        sinceEpoch === buffer.epoch ? "matched" : "mismatch",
      );
      assert.equal(status.replayCount, sinceEpoch === buffer.epoch ? 0 : 1);
      if (sinceEpoch !== buffer.epoch)
        assert.equal(payload(await stream.next()).id, "same-id");
    } finally {
      await stream.return();
      assert.equal(listeners(), 0);
    }
  }
  return { processEpoch: first };
}

async function lifetime() {
  const neverStarted = await caller.tail.events({ tailProtocol: 1 });
  await assert.rejects(
    neverStarted.throw(new StreamResyncRequired("not-yielded")),
    (error: any) => {
      assert.equal(error.epoch, buffer.epoch);
      assert.equal(error.lastDeliveredId, undefined);
      return true;
    },
  );
  assert.equal(listeners(), 0);

  for (let cycle = 0; cycle < 30; cycle++) {
    buffer.reset();
    emit("A");
    const stream = await caller.tail.events({ tailProtocol: 1 });
    assert.equal((await stream.next()).value.type, "tail.subscription");
    if (cycle % 3 === 0) {
      // Status alone does not commit a delivered cursor, even with since.
      await assert.rejects(
        stream.throw(new StreamResyncRequired("not-delivered")),
        (error: any) => {
          assert.equal(error.lastDeliveredId, undefined);
          assert.equal(error.epoch, buffer.epoch);
          return true;
        },
      );
    } else if (cycle % 3 === 1) {
      assert.equal(payload(await stream.next()).id, "A");
      const next = stream.next();
      await stream.return();
      assert.equal((await next).done, true);
    } else {
      emit("queued");
      await stream.return();
    }
    assert.equal(listeners(), 0);
  }
  buffer.reset();
  const abort = new AbortController();
  abort.abort();
  ownerSignal = abort.signal;
  const pre = await caller.tail.events({ tailProtocol: 1 });
  assert.equal((await pre.next()).done, true);
  await pre.return();
  assert.equal(listeners(), 0);
  const active = new AbortController();
  ownerSignal = active.signal;
  const stream = await caller.tail.events({ tailProtocol: 1 });
  await stream.next();
  const pending = stream.next();
  active.abort();
  assert.equal((await pending).done, true);
  await stream.return();
  ownerSignal = undefined;
  assert.equal(listeners(), 0);
  snapshotHook = () => {
    throw new Error("snapshot failure");
  };
  const bad = await caller.tail.events({ tailProtocol: 1 });
  await assert.rejects(bad.next(), /snapshot failure/);
  await bad.return();
  assert.equal(listeners(), 0);
  snapshotHook = () => {
    for (let i = 0; i < 257; i++) emit(String(i));
  };
  const overflow = await caller.tail.events({
    tailProtocol: 1,
    since: "not-delivered",
  });
  await assert.rejects(overflow.next(), (error: any) => {
    assert.equal(error.epoch, buffer.epoch);
    assert.equal(error.lastDeliveredId, undefined);
    return true;
  });
  await overflow.return();
  assert.equal(listeners(), 0);
  return { cycles: 30, clean: true };
}

async function transport() {
  const require = createRequire(join(runtimeDirectory, "../package.json"));
  const { WebSocketServer, WebSocket } = require("ws");
  const { applyWSSHandler } = await import(
    join(runtimeDirectory, "../node_modules/@trpc/server/dist/adapters/ws.mjs")
  );
  const { createWSClient, wsLink, createTRPCUntypedClient } = await import(
    clientModule
  );
  const serverVersion = require("@trpc/server/package.json").version;
  const clientVersion = createRequire(clientModule)("../package.json").version;
  assert.equal(serverVersion, "11.16.0");
  const servers: any[] = [],
    sockets: any[] = [];
  const wire: any[] = [];
  const closed: Promise<void>[] = [];
  class ObservedSocket extends WebSocket {
    constructor(url: string, options?: any) {
      super(url, options);
      sockets.push(this);
      closed.push(
        new Promise<void>((yes) =>
          this.addEventListener("close", () => yes(), { once: true }),
        ),
      );
      this.addEventListener("message", (message: any) => {
        const raw = message.data;
        const text =
          typeof raw === "string" ? raw : Buffer.from(raw).toString();
        if (text === "PING" || text === "PONG") return;
        const value = JSON.parse(text);
        wire.push(...(Array.isArray(value) ? value : [value]));
      });
    }
  }
  const clients: any[] = [],
    subscriptions: any[] = [];
  async function client() {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    await new Promise<void>((yes) => server.once("listening", yes));
    applyWSSHandler({
      wss: server,
      router: brokerRouter,
      createContext: () => ({}),
    });
    // Zero-delay retry lets the installed client retire its close-triggered
    // retry sleep normally; a 60-second fixture retry budget would leak a timer.
    const ws = createWSClient({
      url: "ws://127.0.0.1:" + server.address().port,
      WebSocket: ObservedSocket,
      retryDelayMs: () => 0,
    });
    clients.push(ws);
    return createTRPCUntypedClient({ links: [wsLink({ client: ws })] });
  }
  try {
    emit("A");
    emit("B");
    const data: any[] = [],
      errors: any[] = [];
    const api = await client();
    subscriptions.push(
      api.subscription(
        "tail.events",
        { tailProtocol: 1 },
        {
          onData: (value: any) => data.push(value),
          onError: (error: any) => errors.push(error),
        },
      ),
    );
    await until(() => data.length === 3 || errors.length > 0);
    assert.equal(errors.length, 0);
    assert.equal(data[0].schema, "scout.tail-subscription/v1");
    assert.equal(data[0].epoch, buffer.epoch);
    const frames = wire.filter((value) => value.result?.type === "data");
    assert.equal(frames[0].result.id, undefined);
    assert.deepEqual(frames[0].result.data, data[0]);
    assert.equal(
      frames.slice(1).every((value) => typeof value.result.id === "string"),
      true,
    );
    // The server may yield B before a consumer chooses to consume A. The
    // structured server cursor is not permission to advance that local cursor.
    assert.deepEqual(
      frames.slice(1).map((value) => value.result.id),
      ["A", "B"],
    );
    const secondData: any[] = [];
    const api2 = await client();
    subscriptions.push(
      api2.subscription(
        "tail.events",
        { tailProtocol: 1, sources: ["none"] },
        {
          onData: (value: any) => secondData.push(value),
          onError: (error: any) => errors.push(error),
        },
      ),
    );
    await until(() => secondData.length === 1);
    assert.equal(
      secondData[0].epoch,
      data[0].epoch,
      "both listeners share process epoch",
    );
    buffer.publish({ ...event("oversize"), summary: "x".repeat(1024 * 1024) });
    await until(() => errors.length === 1);
    const tail = errors[0].data.tail;
    assert.deepEqual(tail, {
      schema: "scout.tail-error/v1",
      code: "resync_required",
      lastDeliveredId: "B",
      resyncRequired: true,
      epoch: data[0].epoch,
    });
    const rawError = wire.find((value) => value.error?.data?.tail);
    assert.deepEqual(rawError.error.data.tail, tail);
    assert.equal(rawError.error.code, -32603);
    assert.equal(errors[0].data.code, "INTERNAL_SERVER_ERROR");
    assert.equal(rawError.error.data.path, "tail.events");
    assert.deepEqual(Object.keys(tail).sort(), [
      "code",
      "epoch",
      "lastDeliveredId",
      "resyncRequired",
      "schema",
    ]);
    // The source-filtered socket is still healthy; no second status appears.
    emit("unselected");
    await pause();
    assert.equal(secondData.length, 1);
    for (const subscription of subscriptions.splice(0))
      subscription.unsubscribe();
    await until(() => listeners() === 0);

    // Overflow before any status/event gives null, never initial since.
    buffer.reset();
    snapshotHook = () => {
      for (let i = 0; i < 257; i++) emit(String(i));
    };
    const before: any[] = [],
      refused: any[] = [];
    subscriptions.push(
      api.subscription(
        "tail.events",
        { tailProtocol: 1, since: "not-delivered" },
        {
          onData: (value: any) => before.push(value),
          onError: (error: any) => refused.push(error),
        },
      ),
    );
    await until(() => refused.length === 1);
    assert.equal(before.length, 0);
    assert.equal(refused[0].data.tail.lastDeliveredId, null);
    assert.equal(refused[0].data.tail.epoch, buffer.epoch);
    assert.equal(listeners(), 0);
    const { TRPCError } = await import(
      join(runtimeDirectory, "../node_modules/@trpc/server/dist/index.mjs")
    );
    const { TailResyncRequired } = await import(
      join(runtimeDirectory, "tail/wire-contract.ts")
    );
    // Actual installed formatter/transport, not a replacement router.
    const failures = [
      {
        path: "tail.events",
        error: Object.assign(
          new Error(
            "resync_required Stream consumer fell behind; resnapshot before reconnecting.",
          ),
          { code: "resync_required" },
        ),
        code: "INTERNAL_SERVER_ERROR",
      },
      {
        path: "tail.events",
        error: new TRPCError({ code: "UNAUTHORIZED" }),
        code: "UNAUTHORIZED",
      },
      {
        path: "tail.events",
        error: new TRPCError({ code: "FORBIDDEN" }),
        code: "FORBIDDEN",
      },
      {
        path: "control.events",
        error: new TailResyncRequired(buffer.epoch, "not-a-tail-cursor"),
        code: "INTERNAL_SERVER_ERROR",
      },
    ];
    for (const failure of failures) {
      const values: any[] = [],
        refused: any[] = [];
      if (failure.path === "tail.events") attachError = failure.error;
      else controlError = failure.error;
      subscriptions.push(
        api.subscription(
          failure.path,
          { tailProtocol: 1 },
          {
            onData: (value: any) => values.push(value),
            onError: (error: any) => refused.push(error),
          },
        ),
      );
      await until(() => refused.length === 1);
      assert.equal(values.length, 0);
      assert.equal(refused[0].data.code, failure.code);
      assert.equal(
        refused[0].data.tail,
        undefined,
        "unbranded/non-tail error must stay unchanged",
      );
      assert.equal(listeners(), 0);
      attachError = undefined;
      controlError = undefined;
    }
    return {
      serverVersion,
      clientVersion,
      realClient: true,
      rawError: true,
      firstOnly: true,
    };
  } finally {
    for (const subscription of subscriptions) subscription.unsubscribe();
    for (const client of clients) await client.close();
    await Promise.all(closed);
    for (const server of servers) {
      await new Promise<void>((yes, no) =>
        server.close((error: any) => (error ? no(error) : yes())),
      );
      // Bun 1.4 delivers the final server-side close after the close callback.
      await until(() => server.clients.size === 0);
      assert.equal(server.clients.size, 0);
    }
    assert.equal(listeners(), 0);
  }
}

async function legacyCodec() {
  assert.ok(
    remoteModule,
    "caller must supply unchanged C module for compatibility evidence",
  );
  const { subscribeRemoteTail } = await import(remoteModule);
  const require = createRequire(join(runtimeDirectory, "../package.json"));
  const { WebSocketServer } = require("ws");
  const { applyWSSHandler } = await import(
    join(runtimeDirectory, "../node_modules/@trpc/server/dist/adapters/ws.mjs")
  );
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((yes) => server.once("listening", yes));
  applyWSSHandler({
    wss: server,
    router: brokerRouter,
    createContext: () => ({}),
  });
  const controller = new AbortController();
  emit("A");
  emit("B");
  const source = subscribeRemoteTail({
    brokerUrl: "http://127.0.0.1:" + server.address().port,
    ingress: { kind: "trusted-loopback" },
    signal: controller.signal,
    reconnect: { maxAttempts: 1, maxElapsedMs: 10_000 },
  });
  const iterator = source[Symbol.asyncIterator]();
  let delivered: string | null = null;
  try {
    for (;;) {
      const item = await iterator.next();
      assert.equal(item.done, false);
      if (item.value.type === "event") {
        delivered = item.value.id;
        break;
      }
    }
    assert.equal(delivered, "A");
    // C leaves B queued, while server evidence already points at B.
    buffer.publish({ ...event("oversize"), summary: "x".repeat(1024 * 1024) });
    await until(() => listeners() === 0);
    // A native WS close is observable proof the codec processed its terminal
    // error (fail() retires its socket), not an arbitrary scheduler sleep.
    await until(() => server.clients.size === 0);
    await assert.rejects(iterator.next(), (error: any) => {
      assert.equal(error.reason, "server_error");
      assert.equal(error.lastDeliveredId, "A");
      assert.equal(error.resyncRequired, true);
      return true;
    });
    return {
      unchangedCodec: true,
      deliveredCursor: delivered,
      serverAheadIgnored: true,
    };
  } finally {
    controller.abort();
    await iterator.return();
    await new Promise<void>((yes, no) =>
      server.close((error: any) => (error ? no(error) : yes())),
    );
    // Bun 1.4 delivers the final server-side close after the close callback.
    await until(() => server.clients.size === 0);
    assert.equal(server.clients.size, 0);
    assert.equal(listeners(), 0);
  }
}

try {
  const result =
    mode === "matrix"
      ? await matrix()
      : mode === "negotiation"
        ? await negotiation()
        : mode === "epochs"
          ? await epochs()
          : mode === "lifetime"
            ? await lifetime()
            : mode === "transport"
              ? await transport()
              : mode === "legacy-codec"
                ? await legacyCodec()
                : (() => {
                    throw new Error("Unknown wire fixture mode");
                  })();
  parentPort!.postMessage({ mode, result, clean: true });
} finally {
  parentPort!.close();
}
