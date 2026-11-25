// Own Worker isolate: mock publishers never alter the unit runner's modules.
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { TailEvent } from "../tail/types.js";

const { routerPath, bufferPath, mode, runtimeDirectory } = workerData;
const { TailReplayBuffer } = await import(bufferPath);
const { StreamResyncRequired } = await import(
  join(runtimeDirectory, "bounded-event-iterable.ts")
);
const buffer = new TailReplayBuffer(10_000);
const legacy = new Set<(event: TailEvent) => void>();
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
  }) =>
    buffer.attach({
      ...options,
      signal: ownerSignal ?? options.signal,
      accepts: (value: TailEvent) =>
        !options.sources?.length || options.sources.includes(value.source),
    }),
}));
mock.module(join(runtimeDirectory, "broker-control-events.js"), () => ({
  snapshotPresenceControlEvents: () => [],
  snapshotRecentControlEvents: () => [],
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

async function direct() {
  emit("A");
  emit("B");
  const stream = await caller.tail.events(undefined);
  try {
    const received = [payload(await stream.next()).id];
    const atInjection = listeners();
    emit("C");
    received.push(payload(await stream.next()).id);
    const next = stream.next();
    await until(() => listeners() === 1);
    emit("D");
    received.push(payload(await next).id);
    if (received.at(-1) !== "D") received.push(payload(await stream.next()).id);
    assert.deepEqual(received, ["A", "B", "C", "D"]);
    return { received, atInjection };
  } finally {
    await stream.return();
    assert.equal(listeners(), 0);
  }
}

async function duplicate() {
  emit("dup", "first occurrence");
  emit("B");
  const stream = await caller.tail.events({});
  try {
    const values = [payload(await stream.next())];
    emit("dup", "second occurrence");
    values.push(payload(await stream.next()));
    const next = stream.next();
    await until(() => listeners() === 1);
    emit("D");
    values.push(payload(await next));
    if (values.at(-1)!.id !== "D") values.push(payload(await stream.next()));
    assert.deepEqual(
      values.map((value) => value.summary),
      ["first occurrence", "B", "second occurrence", "D"],
    );
    return { summaries: values.map((value) => value.summary) };
  } finally {
    await stream.return();
    assert.equal(listeners(), 0);
  }
}

async function cursor(live: boolean) {
  if (!live) {
    emit("A");
    emit("B");
  }
  const stream = await caller.tail.events({});
  try {
    const pending = stream.next();
    if (live) {
      await until(() => listeners() === 1);
      emit("live");
    }
    assert.equal(payload(await pending).id, live ? "live" : "A");
    await assert.rejects(
      stream.throw(new StreamResyncRequired("not-the-outer-cursor")),
      (error: any) => {
        assert.equal(error.lastDeliveredId, live ? "live" : "A");
        return true;
      },
    );
    return { lastDeliveredId: live ? "live" : "A" };
  } finally {
    await stream.return();
    assert.equal(listeners(), 0);
  }
}

async function overflow() {
  emit("A");
  emit("B");
  const stream = await caller.tail.events({});
  try {
    assert.equal(payload(await stream.next()).id, "A");
    for (let i = 0; i < 257; i++) emit("queued-" + i);
    await assert.rejects(stream.next(), (error: any) => {
      assert.equal(error.code, "resync_required");
      assert.equal(error.lastDeliveredId, "A");
      return true;
    });
    assert.equal(listeners(), 0);
    return { lastDeliveredId: "A", terminalBeforeReplayB: true };
  } finally {
    await stream.return();
  }
}

async function lifecycle() {
  const neverStarted = await caller.tail.events({});
  await neverStarted.return();
  assert.equal(listeners(), 0);
  emit("A");
  emit("B");
  const replay = await caller.tail.events({});
  assert.equal(payload(await replay.next()).id, "A");
  await replay.return();
  assert.equal(listeners(), 0);
  buffer.reset();
  const pending = await caller.tail.events({});
  const read = pending.next();
  await until(() => listeners() === 1);
  const returned = pending.return();
  assert.equal((await read).done, true);
  assert.equal((await returned).done, true);
  assert.equal(listeners(), 0);
  const controller = new AbortController();
  ownerSignal = controller.signal;
  const aborted = await caller.tail.events({});
  const abortRead = aborted.next();
  await until(() => listeners() === 1);
  controller.abort();
  assert.equal((await abortRead).done, true);
  assert.equal(listeners(), 0);
  await aborted.return();
  buffer.reset();
  emit("A");
  emit("B");
  const replayController = new AbortController();
  ownerSignal = replayController.signal;
  const abortReplay = await caller.tail.events({});
  assert.equal(payload(await abortReplay.next()).id, "A");
  replayController.abort();
  assert.equal((await abortReplay.next()).done, true);
  await abortReplay.return();
  assert.equal(listeners(), 0);
  ownerSignal = undefined;
  return {
    returnDuringReplay: true,
    returnWakesPendingNext: true,
    abortWakesPendingNext: true,
  };
}

async function inputMatrix() {
  const cases: [unknown, string[]][] = [
    [undefined, ["A", "B", "C"]],
    [{}, ["A", "B", "C"]],
    [{ since: "" }, ["A", "B", "C"]],
    [{ since: "A" }, ["B", "C"]],
    [{ since: "C" }, []],
    [{ since: "missing" }, ["A", "B", "C"]],
    [{ sources: [] }, ["A", "B", "C"]],
    [{ sources: ["none"] }, []],
    [{ since: "B", sources: ["one"] }, ["C"]],
    [{ since: "A", sources: ["two"] }, ["B"]],
  ];
  for (const [input, expected] of cases) {
    buffer.reset();
    for (const [id, source] of [
      ["A", "one"],
      ["B", "two"],
      ["C", "one"],
    ])
      buffer.publish(event(id, id, source));
    const controller = new AbortController();
    ownerSignal = controller.signal;
    const stream = await caller.tail.events(input);
    try {
      const values: string[] = [];
      for (let i = 0; i < expected.length; i++)
        values.push(payload(await stream.next()).id);
      assert.deepEqual(values, expected);
      if (!expected.length) {
        const pending = stream.next();
        controller.abort();
        assert.equal((await pending).done, true);
      }
    } finally {
      controller.abort();
      await stream.return();
      assert.equal(listeners(), 0);
    }
  }
  ownerSignal = undefined;
  buffer.reset();
  emit("dup", "first");
  emit("dup", "second");
  emit("C");
  const duplicateCursor = await caller.tail.events({ since: "dup" });
  try {
    assert.equal(payload(await duplicateCursor.next()).summary, "second");
    assert.equal(payload(await duplicateCursor.next()).id, "C");
  } finally {
    await duplicateCursor.return();
    assert.equal(listeners(), 0);
  }
  buffer.reset();
  for (let i = 0; i < 501; i++) emit(String(i));
  const expired = await caller.tail.events({ since: "0" });
  try {
    assert.equal(payload(await expired.next()).id, "1");
  } finally {
    await expired.return();
    assert.equal(listeners(), 0);
  }
  return { cases: cases.length + 2, legacy: true };
}

async function exceptional() {
  emit("A");
  emit("B");
  const stream = await caller.tail.events({});
  try {
    assert.equal(payload(await stream.next()).id, "A");
    assert.doesNotThrow(() => buffer.publish({ ...event("invalid"), raw: 1n }));
    await assert.rejects(stream.next(), (error: any) => {
      assert.equal(error.lastDeliveredId, "A");
      return error.code === "resync_required";
    });
    assert.equal(listeners(), 0);
  } finally {
    await stream.return();
  }
  buffer.reset();
  snapshotHook = () => {
    for (let i = 0; i < 257; i++) emit(String(i));
  };
  const pre = await caller.tail.events({ since: "not-delivered" });
  try {
    await assert.rejects(pre.next(), (error: any) => {
      assert.equal(error.lastDeliveredId, undefined);
      return error.code === "resync_required";
    });
  } finally {
    await pre.return();
  }
  assert.equal(listeners(), 0);
  buffer.reset();
  buffer.publish({
    ...event("bad"),
    get id(): string {
      throw new Error("format failure");
    },
  });
  const formatting = await caller.tail.events({});
  try {
    await assert.rejects(formatting.next(), /format failure/);
  } finally {
    await formatting.return();
  }
  assert.equal(listeners(), 0);
  return {
    accountingFailureIsTerminal: true,
    nullCursorBeforeFirstYield: true,
    formattingCleanup: true,
  };
}

async function afterLast() {
  emit("A");
  emit("B");
  const stream = await caller.tail.events({});
  try {
    assert.equal(payload(await stream.next()).id, "A");
    assert.equal(payload(await stream.next()).id, "B");
    emit("C");
    const pending = stream.next();
    await until(() => listeners() === 1);
    emit("D");
    assert.equal(payload(await pending).id, "C");
    assert.equal(payload(await stream.next()).id, "D");
    return { covered: true };
  } finally {
    await stream.return();
    assert.equal(listeners(), 0);
  }
}

async function websocket(disconnect = false) {
  const require = createRequire(join(runtimeDirectory, "../package.json"));
  const { WebSocketServer, WebSocket } = require("ws");
  const { applyWSSHandler } = await import(
    join(runtimeDirectory, "../node_modules/@trpc/server/dist/adapters/ws.mjs")
  );
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  applyWSSHandler({
    wss: server,
    router: brokerRouter,
    createContext: () => ({}),
  });
  const expected = [emit("A"), emit("B")];
  let atInjection = -1;
  snapshotHook = () =>
    queueMicrotask(() => {
      atInjection = listeners();
      expected.push(emit("C"));
    });
  const client = new WebSocket("ws://127.0.0.1:" + server.address().port);
  const frames: any[] = [];
  let done!: () => void, failed!: (error: Error) => void, stopped!: () => void;
  const finished = new Promise<void>((yes, no) => {
    done = yes;
    failed = no;
  });
  const stop = new Promise<void>((yes) => {
    stopped = yes;
  });
  client.on("error", failed);
  client.on("message", (bytes: any) => {
    const frame = JSON.parse(String(bytes));
    if (frame.error) failed(new Error(JSON.stringify(frame.error)));
    if (frame.result?.type === "stopped") stopped();
    if (frame.result?.type === "data") {
      frames.push(frame);
      if (frame.result.id === "D") done();
    }
  });
  try {
    await new Promise<void>((yes, no) => {
      client.once("open", yes);
      client.once("error", no);
    });
    client.send(
      JSON.stringify({
        id: 1,
        method: "subscription",
        params: { path: "tail.events", input: {} },
      }),
    );
    await until(() => listeners() === 1);
    expected.push(emit("D"));
    await finished;
    if (disconnect) {
      const closed = new Promise<void>((resolve) =>
        client.once("close", resolve),
      );
      client.close();
      await closed;
    } else {
      // Explicit stop also exercises the adapter's abort/wake path.
      client.send(JSON.stringify({ id: 1, method: "subscription.stop" }));
      await stop;
    }
    await until(() => listeners() === 0);
    assert.deepEqual(
      frames.map((frame) => frame.result.id),
      ["A", "B", "C", "D"],
    );
    assert.equal(atInjection, 1);
    assert.deepEqual(
      frames,
      expected.map((value) => ({
        id: 1,
        result: {
          type: "data",
          id: value.id,
          data: { id: value.id, data: value },
        },
      })),
    );
    return {
      received: frames.map((frame) => frame.result.id),
      atInjection,
      legacyFramesUnchanged: true,
      disconnectCleanup: disconnect,
    };
  } finally {
    if (client.readyState === WebSocket.OPEN) {
      const closed = new Promise<void>((resolve) =>
        client.once("close", resolve),
      );
      client.close();
      await closed;
    } else if (client.readyState !== WebSocket.CLOSED) {
      client.terminate();
      await new Promise<void>((resolve) => client.once("close", resolve));
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error: any) => (error ? reject(error) : resolve())),
    );
    // Bun 1.4 delivers the final server-side close after the close callback.
    await until(() => server.clients.size === 0);
    assert.equal(server.clients.size, 0);
    assert.equal(listeners(), 0);
  }
}

let result: unknown;
try {
  if (mode === "direct") result = await direct();
  else if (mode === "duplicate") result = await duplicate();
  else if (mode === "cursor-replay") result = await cursor(false);
  else if (mode === "cursor-live") result = await cursor(true);
  else if (mode === "overflow") result = await overflow();
  else if (mode === "ws") result = await websocket();
  else if (mode === "ws-disconnect") result = await websocket(true);
  else if (mode === "after-last") result = await afterLast();
  else if (mode === "lifecycle") result = await lifecycle();
  else if (mode === "matrix") result = await inputMatrix();
  else if (mode === "exceptional") result = await exceptional();
  else throw new Error("Unknown fixture mode");
  parentPort!.postMessage({ mode, result, clean: true });
} finally {
  parentPort!.close();
}
