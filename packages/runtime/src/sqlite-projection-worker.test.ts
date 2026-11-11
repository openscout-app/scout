import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Worker } from "node:worker_threads";
import type { DeliveryAttempt, DeliveryIntent, FlightRecord, InvocationRequest } from "@openscout/protocol";
import { FileBackedBrokerJournal, type BrokerJournalEntry } from "./broker-journal.js";
import { WorkerSQLiteProjection, type WorkerSQLiteProjectionOptions } from "./sqlite-projection-worker.js";
import { BrokerDurableStore } from "./broker-durable-store.js";
import { emptyHistoryRotationPlan, planHistoryRotation, refineVerifiedRotation, type HistoryRotationPlan } from "./history-rotation.js";
import { constrainHistoryRotationBatch, selectHistoryRotationBatch } from "./history-rotation-batch.js";
import { publishHistoryRotationPages } from "./history-rotation-publication.js";
import { revalidateHistoryRotation } from "./history-rotation-revalidation.js";
import { SQLiteControlPlaneStore } from "./sqlite-store.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const message = (id: string): Extract<BrokerJournalEntry, { kind: "message.record" }> => ({ kind: "message.record", message: {
  id, actorId: "actor", conversationId: "conversation", originNodeId: "node", createdAt: 1_700_000_000_000,
  body: `body-${id}`, visibility: "workspace", class: "agent", policy: "durable", metadata: {},
} });
const parents: BrokerJournalEntry[] = [
  { kind: "node.upsert", node: { id: "node", name: "Node", meshId: "mesh", advertiseScope: "local", registeredAt: 1 } },
  { kind: "actor.upsert", actor: { id: "actor", kind: "agent", displayName: "Actor", createdAt: 1_700_000_000_000, metadata: {} } },
  { kind: "conversation.upsert", conversation: { id: "conversation", kind: "channel", title: "Conversation", visibility: "workspace", shareMode: "local", authorityNodeId: "node", participantIds: ["actor"], createdAt: 1_700_000_000_000, metadata: {} } },
];
async function setup(workerSource?: string, options: WorkerSQLiteProjectionOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "scout-projection-worker-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const journalPath = join(root, "journal.jsonl"), dbPath = join(root, "control.sqlite");
  const journal = new FileBackedBrokerJournal(journalPath); await journal.load();
  await journal.appendEntries([...parents, message("old")]);
  let workerUrl: URL | undefined;
  if (workerSource) {
    const path = join(root, "worker.ts");
    // Signal only after the wrapper has imported the real entry and installed
    // every listener. An interception listener alone can consume an early warm.
    await writeFile(path, workerSource + `
      import { parentPort as fixturePort } from "node:worker_threads";
      fixturePort!.postMessage({ kind: "testFixtureReady" });`);
    workerUrl = pathToFileURL(path);
  }
  const projection = new WorkerSQLiteProjection(dbPath, journalPath, journal, { historyDirectory: join(root, "history"), ...options, workerUrl });
  cleanup.push(() => projection.close());
  const published: unknown[] = [];
  const durable = new BrokerDurableStore({ journal, projection, threadEvents: { publish: events => { published.push(...events); } } });
  if (workerSource) {
    // Gate this fixture's transport for every worker generation, including a
    // watchdog restart. RPC deadlines still start at the original call time.
    const transport = projection as unknown as { postMessage(worker: Worker, packet: unknown): void };
    const post = transport.postMessage.bind(projection);
    const startups = new WeakMap<Worker, { ready: boolean; pending: unknown[] }>();
    transport.postMessage = (worker, packet) => {
      let startup = startups.get(worker);
      if (!startup) {
        const state = { ready: false, pending: [] as unknown[] };
        startups.set(worker, state); startup = state;
        const detach = () => {
          worker.off("message", ready); worker.off("error", abandoned); worker.off("exit", abandoned);
        };
        const ready = (message: unknown) => {
          if (!message || typeof message !== "object" || !("kind" in message) || message.kind !== "testFixtureReady") return;
          detach(); state.ready = true;
          for (const queued of state.pending.splice(0)) post(worker, queued);
        };
        const abandoned = () => { detach(); state.pending.length = 0; };
        worker.on("message", ready); worker.once("error", abandoned); worker.once("exit", abandoned);
      }
      if (startup.ready) post(worker, packet);
      else startup.pending.push(packet);
    };
  }
  return { root, journalPath, dbPath, journal, projection, durable, published };
}

function withheldWorkerSource(): string {
  const entry = new URL("./sqlite-projection-worker-entry.ts", import.meta.url).href;
  return `import {parentPort} from "node:worker_threads";
    let gate;
    parentPort.on("message", packet => {
      if (packet.kind === "test-arm-hold") {
        gate = new Int32Array(packet.gate);
        parentPort.postMessage({kind:"test-hold-armed"});
      } else if (packet.method === "catchUpStartup" && gate && Atomics.load(gate,0) === 0) {
        Atomics.store(gate,1,1);
        parentPort.postMessage({kind:"test-worker-held"});
        while (Atomics.load(gate,0) === 0) Atomics.wait(gate,0,0);
        Atomics.store(gate,2,1);
      }
    });
    await import(${JSON.stringify(entry)});`;
}

async function armWorkerHold(projection: WorkerSQLiteProjection) {
  const worker = (projection as unknown as { worker: Worker }).worker;
  const gate = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
  let armed!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { armed = resolve; });
  const held = new Promise<void>(resolve => { entered = resolve; });
  const receive = (packet: { kind?: string }) => {
    if (packet.kind === "test-hold-armed") armed();
    if (packet.kind === "test-worker-held") entered();
  };
  const release = () => { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); };
  worker.on("message", receive);
  cleanup.push(() => { release(); worker.off("message", receive); });
  worker.postMessage({ kind: "test-arm-hold", gate: gate.buffer });
  await ready;
  return { worker, gate, held, release };
}

async function expectJournalAcknowledgement(
  projection: WorkerSQLiteProjection, write: () => Promise<unknown>, release: () => void,
  inspect: () => void = () => {},
) {
  // A held promise alone would make a broken writer hang. Observe consumption
  // of the real projection promises as the alternate causal failure event.
  let waited!: () => void;
  const projectionWait = new Promise<"projection-awaited">(resolve => { waited = () => resolve("projection-awaited"); });
  const observe = <T extends Promise<unknown>>(promise: T): T => new Proxy(promise, {
    get(target, key) {
      if (key === "then") return (...args: unknown[]) => { waited(); return Reflect.apply(target.then, target, args); };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const flush = projection.flush, applyEntries = projection.applyEntries;
  projection.flush = () => observe(flush.call(projection));
  projection.applyEntries = entries => observe(applyEntries.call(projection, entries));
  let pending: Promise<unknown> | undefined;
  try {
    pending = write();
    expect(await Promise.race([pending.then(() => "journal-acknowledged"), projectionWait])).toBe("journal-acknowledged");
    inspect();
  } finally {
    projection.flush = flush; projection.applyEntries = applyEntries;
    release();
    await pending?.catch(() => {});
  }
}

test("worker replays the canonical journal, follows committed suffixes and verifies exact history", async () => {
  const { projection, durable, published, dbPath } = await setup();
  await projection.warm(); await projection.flush();
  expect(projection.statusSnapshot().state).toBe("ready");
  expect((await projection.readMessages(["old"])).get("old")).toMatchObject(message("old").message);
  await durable.runWrite(() => durable.commitEntries(message("new"), async () => {}));
  await durable.flushProjectedEntries();
  expect((await projection.readMessages(["new"])).get("new")).toMatchObject(message("new").message);
  expect(published.length).toBeGreaterThan(0);
  const plan = emptyHistoryRotationPlan(); plan.messageIds.add("new");
  expect((await projection.verifyPersisted(plan)).present.messageIds.has("new")).toBe(true);
  const store = new SQLiteControlPlaneStore(dbPath);
  try { expect(store.readMessages(["old", "new"]).size).toBe(2); } finally { store.close(); }
});

test("withheld worker work leaves acknowledgement responsive and pending payloads on disk", async () => {
  const { projection, durable, journal } = await setup(withheldWorkerSource());
  await projection.warm(); await projection.flush();
  const hold = await armWorkerHold(projection);
  projection.notifyCommitted(); await hold.held;
  await expectJournalAcknowledgement(projection, async () => {
    await durable.runWrite(() => durable.commitEntries(message("trigger"), async () => {}));
    await Promise.all(Array.from({ length: 40 }, (_, i) => durable.runWrite(() => durable.commitEntries(message(`queued-${i}`), async () => {}))));
  }, hold.release, () => {
    expect(Atomics.load(hold.gate, 0)).toBe(0); // Test has not released the worker.
    expect(Atomics.load(hold.gate, 1)).toBe(1); // Worker confirmed entry.
    expect(Atomics.load(hold.gate, 2)).toBe(0); // Worker has not resumed.
    expect((projection as unknown as { worker: Worker }).worker).toBe(hold.worker);
    expect(projection.statusSnapshot().worker.pendingRequests).toBeLessThanOrEqual(2);
    expect(projection.statusSnapshot().worker.dirty).toBe(true);
    expect(journal.snapshot().messages["queued-39"]).toBeDefined();
  });
  await projection.flush();
  expect(Atomics.load(hold.gate, 2)).toBe(1);
  expect((await projection.readMessages(["queued-39"])).has("queued-39")).toBe(true);
});

test("worker termination preserves historical SQLite and recovers subsequent accepted work", async () => {
  const { projection, durable, journalPath, dbPath } = await setup();
  await projection.warm(); await projection.flush();
  // Historical SQLite can contain the sole surviving copy after verified
  // rotation; restarting the worker must never delete or replace that DB.
  const database = new SQLiteControlPlaneStore(dbPath);
  try { database.recordMessage(message("sqlite-only-history").message); } finally { database.close(); }
  const worker = (projection as unknown as { worker: { terminate(): Promise<number> } }).worker;
  await worker.terminate();
  await durable.runWrite(() => durable.commitEntries(message("after-crash"), async () => {}));
  await projection.flush();
  expect((await projection.readMessages(["sqlite-only-history", "after-crash"])).size).toBe(2);
  const restored = new FileBackedBrokerJournal(journalPath); await restored.load();
  expect(restored.snapshot().messages["after-crash"]).toBeDefined();
});

test("commits replay only their byte suffix and inode replacement invalidates the cursor", async () => {
  const { projection, durable, journal, journalPath } = await setup();
  const large = message("large-prefix"); large.message.body = "a".repeat(512 * 1024);
  await journal.appendEntries(large);
  await projection.warm(); await projection.flush();
  const before = projection.statusSnapshot().worker.replay;
  await durable.runWrite(() => durable.commitEntries(message("tail"), async () => {}));
  await projection.flush();
  const after = projection.statusSnapshot().worker.replay;
  expect(after.fullReplays).toBe(before.fullReplays);
  expect(after.tailReplays - before.tailReplays).toBe(2);
  expect(after.bytes - before.bytes).toBeLessThan(8 * 1024);
  // Same complete journal, new inode: the persisted barrier can still be found,
  // but old byte offsets cannot be trusted after a compaction-style rename.
  await writeFile(`${journalPath}.replacement`, await readFile(journalPath));
  await rename(`${journalPath}.replacement`, journalPath);
  await durable.runWrite(() => durable.commitEntries(message("after-replace"), async () => {}));
  await projection.flush();
  const replaced = projection.statusSnapshot().worker.replay;
  expect(replaced.fullReplays - after.fullReplays).toBe(2);
  expect((await projection.readMessages(["after-replace"])).has("after-replace")).toBe(true);
});

test("flush finishes its captured revision even while more commits keep arriving", async () => {
  const entry = new URL("./sqlite-projection-worker-entry.ts", import.meta.url).href;
  const source = `import {parentPort} from "node:worker_threads";
    parentPort.on("message", packet => { if (packet.method === "catchUpStartup") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50); });
    await import(${JSON.stringify(entry)});`;
  const { projection } = await setup(source);
  await projection.warm(); await projection.flush();
  projection.notifyCommitted();
  const interval = setInterval(() => projection.notifyCommitted(), 1);
  try {
    const result = await Promise.race([
      projection.flush().then(() => "flushed"),
      new Promise(resolve => setTimeout(() => resolve("timed-out"), 400)),
    ]);
    expect(result).toBe("flushed");
  } finally { clearInterval(interval); }
});

test("blocked projection bounds waiting readers and oversized publication preserves the hot record", async () => {
  const entry = new URL("./sqlite-projection-worker-entry.ts", import.meta.url).href;
  const source = `import {parentPort} from "node:worker_threads";
    parentPort.on("message", packet => { if (packet.method === "catchUpStartup") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150); });
    await import(${JSON.stringify(entry)});`;
  const { projection, durable, journal } = await setup(source, { maxPendingRequests: 2 });
  await projection.warm(); await projection.flush();
  await durable.runWrite(() => durable.commitEntries(message("pending"), async () => {}));
  const first = projection.readMessages(["old"]), second = projection.readMessages(["pending"]);
  await expect(projection.readMessages(["old"])).rejects.toThrow("read capacity");
  expect(projection.statusSnapshot().worker.pendingRequests).toBeLessThanOrEqual(2);
  await Promise.all([first, second]);
  await expect(projection.publishHistoricalPage([{ kind: "message", id: "pending", record: "a".repeat(2 * 1024 * 1024) }])).rejects.toThrow("byte capacity");
  expect(journal.snapshot().messages.pending).toBeDefined();
});

test("historical worker publishes full records and serves exact IDs and subject pages", async () => {
  const { projection, journal } = await setup();
  const record = { ...message("historical").message, metadata: { replyTo: "previous", context: ["link"] } };
  const publication = await projection.publishHistoricalPage([{ kind: "message", id: record.id, record, conversationId: record.conversationId, timestamp: record.createdAt }]);
  expect(publication.records).toHaveLength(1);
  expect((await projection.readHistoricalRecords("message", [record.id])).get(record.id)).toEqual(record);
  expect((await projection.pageHistoricalRecords({ kind: "message", conversationId: record.conversationId })).map(row => row.id)).toEqual([record.id]);
  expect(journal.snapshot().messages.old).toBeDefined();
  projection.close();
  await expect(projection.readMessages(["old"])).rejects.toThrow("unavailable");
  await expect(projection.readHistoricalRecords("message", [record.id])).rejects.toThrow("unavailable");
});

test("verification pages a large plan and compares an individually oversized body through canonical digests", async () => {
  const { projection, journal, dbPath } = await setup();
  const entries = Array.from({ length: 260 }, (_, index) => {
    const record = message(`verify-${index}`); record.message.body = "x".repeat(9000); return record;
  });
  const large = message("verify-large"); large.message.body = "a".repeat(3 * 1024 * 1024);
  await journal.appendEntries([...entries, large]);
  await projection.warm(); await projection.flush();
  const plan = emptyHistoryRotationPlan();
  for (const entry of [...entries, large]) plan.messageIds.add(entry.message.id);
  plan.messageIds.add("missing");
  const result = await projection.verifyPersisted(plan);
  expect(result.present.messageIds.size).toBe(261);
  expect([...result.missing.messageIds]).toEqual(["missing"]);
  const store = new SQLiteControlPlaneStore(dbPath);
  try { store.recordMessage({ ...large.message, body: `${large.message.body}!` }); } finally { store.close(); }
  const after = await projection.verifyPersisted(plan);
  expect(after.present.messageIds.size).toBe(260);
  expect(after.missing.messageIds.has("verify-large")).toBe(true);
});

test("watchdog rejects a stalled live worker and restarts against the same historical database", async () => {
  // Hold watchdog time still until both worker entry and journal acknowledgement
  // are proven. Startup/recovery load must not consume the fixture's budget.
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const { projection, durable, journal, dbPath } = await setup(withheldWorkerSource(), { requestTimeoutMs: 400 });
    await projection.warm(); await projection.flush();
    const store = new SQLiteControlPlaneStore(dbPath);
    try { store.recordMessage(message("historical-only").message); } finally { store.close(); }
    const hold = await armWorkerHold(projection);
    await journal.appendEntries(message("accepted-before-stall"));
    projection.notifyCommitted(); await hold.held;
    let settled = false;
    const flush = projection.flush().finally(() => { settled = true; });
    void flush.catch(() => {}); // Observe the intentional later watchdog failure.
    const failures = projection.health().failures;
    let acknowledgedWhileHeld = false;
    await expectJournalAcknowledgement(projection,
      () => durable.runWrite(() => durable.commitEntries(message("accepted-while-stalled"), async () => {})),
      // Keep a successful hold for the watchdog. A failed causal proof must
      // still release the worker so the helper's cleanup cannot hang.
      () => { if (!acknowledgedWhileHeld) hold.release(); }, () => {
        expect(journal.snapshot().messages["accepted-while-stalled"]).toBeDefined();
        expect(settled).toBe(false);
        expect((projection as unknown as { worker: Worker }).worker).toBe(hold.worker);
        expect(projection.health().failures).toBe(failures);
        expect(projection.statusSnapshot().worker.pendingRequests).toBeGreaterThan(0);
        expect(Atomics.load(hold.gate, 0)).toBe(0);
        expect(Atomics.load(hold.gate, 1)).toBe(1);
        expect(Atomics.load(hold.gate, 2)).toBe(0);
        acknowledgedWhileHeld = true;
      });
    // Only the confirmed stall advances the real watchdog predicate.
    now += 400;
    await expect(flush).rejects.toThrow("stalled");
    expect(projection.statusSnapshot().state).toBe("degraded");
    // The watchdog has retired the held worker. A recovery dependency is still
    // forbidden on acknowledgement, even if a replacement could answer quickly.
    expect((projection as unknown as { worker: Worker | null }).worker).toBeNull();
    await expectJournalAcknowledgement(projection,
      () => durable.runWrite(() => durable.commitEntries(message("accepted-after-stall"), async () => {})), hold.release,
      () => { expect(journal.snapshot().messages["accepted-after-stall"]).toBeDefined(); });
    await projection.flush();
    expect((await projection.readMessages(["historical-only", "accepted-before-stall", "accepted-while-stalled", "accepted-after-stall"])).size).toBe(4);
  } finally { clock.mockRestore(); }
});

test("watchdog extends an operation only when reported replay progress advances", async () => {
  const source = `import {parentPort} from "node:worker_threads";
    parentPort.on("message", packet => { if (packet.kind !== "request") return;
      let progress=0; const timer=setInterval(()=>parentPort.postMessage({kind:"state",progress:++progress}),25);
      setTimeout(()=>{clearInterval(timer);parentPort.postMessage({kind:"result",id:packet.id,status:{state:"ready",detail:null},health:{failures:0}})},450);
    });`;
  const { projection } = await setup(source, { requestTimeoutMs: 150 });
  await projection.warm();
  expect(projection.statusSnapshot().state).toBe("ready");
  expect(projection.statusSnapshot().worker.pendingRequests).toBe(0);
});

test("restart applies durable rotation receipt after a crash before SQL cleanup", async () => {
  const { projection, journal, journalPath, dbPath, root } = await setup();
  await projection.warm(); await projection.flush();
  const plan = emptyHistoryRotationPlan(); plan.messageIds.add("old");
  const published = await projection.publishHistoryRotation(plan);
  expect(published.publication).not.toBeNull();
  const priorWorker = (projection as unknown as { worker: { terminate(): Promise<number> } }).worker;
  projection.close(); await priorWorker.terminate();
  await journal.appendEntries({ kind: "history.rotate", cutoff: 1_800_000_000_000, rotatedAt: 1_800_000_000_000,
    publications: [published.publication!], evicted: { messageIds: ["old"], invocationIds: [], flightIds: [], deliveryIds: [], deliveryAttemptIds: [], collaborationEventIds: [] } });
  const before = new SQLiteControlPlaneStore(dbPath);
  try { expect(before.readMessages(["old"]).get("old")?.body).toBe("body-old"); } finally { before.close(); }
  const restart = new WorkerSQLiteProjection(dbPath, journalPath, journal, { historyDirectory: join(root, "history") });
  cleanup.push(() => restart.close());
  await restart.warm(); await restart.flush();
  expect((await restart.readMessages(["old"])).get("old")?.body).toBe("body-old");
  const after = new SQLiteControlPlaneStore(dbPath);
  try {
    expect(after.writerDb.query<{ body: string }>("SELECT body FROM messages WHERE id='old'").get()?.body).toBe("");
    expect(after.writerDb.query<{ n: number }>("SELECT count(*) AS n FROM broker_history_anchors WHERE kind='message' AND id='old'").get()?.n).toBe(1);
  } finally { after.close(); }
});

test("event archive survives crashes both before its marker and before marker cleanup", async () => {
  const { projection, journal, journalPath, dbPath, root, durable } = await setup();
  await projection.warm(); await projection.flush();
  const event = { id: "archived-event", kind: "message.created", actorId: "actor", nodeId: "node", ts: 1_700_000_000_000, payload: { conversationId: "conversation", context: ["prior"] } } as const;
  await durable.runWrite(() => durable.commitEntries({ kind: "control.event.record", event } as BrokerJournalEntry, async () => {}));
  await projection.flush();
  const options = { cutoff: 1_800_000_000_000, archiveDir: join(root, "archives") };
  const published = await projection.archiveEvents(options);
  expect(published.verifiedEventIds).toContain(event.id);
  const firstWorker = (projection as unknown as { worker: { terminate(): Promise<number> } }).worker;
  projection.close(); await firstWorker.terminate();
  const before = new SQLiteControlPlaneStore(dbPath);
  try { expect(before.writerDb.query("SELECT id FROM events WHERE id=?1").get(event.id)).not.toBeNull(); } finally { before.close(); }
  const restarted = new WorkerSQLiteProjection(dbPath, journalPath, journal, { historyDirectory: join(root, "history") });
  cleanup.push(() => restarted.close()); await restarted.warm(); await restarted.flush();
  const repeated = await restarted.archiveEvents(options);
  expect(repeated.verifiedEventIds).toContain(event.id);
  const secondWorker = (restarted as unknown as { worker: { terminate(): Promise<number> } }).worker;
  restarted.close(); await secondWorker.terminate();
  await journal.appendEntries({ kind: "history.rotate", cutoff: options.cutoff, rotatedAt: options.cutoff, evicted: {
    messageIds: [], invocationIds: [], flightIds: [], deliveryIds: [], deliveryAttemptIds: [], collaborationEventIds: [], controlEventIds: repeated.verifiedEventIds,
  } });
  const completed = new WorkerSQLiteProjection(dbPath, journalPath, journal, { historyDirectory: join(root, "history") });
  cleanup.push(() => completed.close()); await completed.warm(); await completed.flush();
  const after = new SQLiteControlPlaneStore(dbPath);
  try { expect(after.writerDb.query("SELECT id FROM events WHERE id=?1").get(event.id)).toBeNull(); } finally { after.close(); }
  expect((await completed.readHistoricalRecords("control_event", [event.id])).get(event.id)).toEqual(event);
});

test("bounded maintenance pages drain more than 250 connected records and restart with exact cold context", async () => {
  const { projection, journal, journalPath, dbPath, root, durable } = await setup();
  const cutoff = 1_800_000_000_000;
  const request = message("large-history-request").message;
  request.metadata = { originalContext: { unicode: "雪🚀", links: ["earlier-context"] } };
  const invocation: InvocationRequest = {
    id: "large-history-invocation", requesterId: "actor", requesterNodeId: "node", targetAgentId: "actor",
    action: "consult", task: "preserve the entire task", createdAt: request.createdAt,
    messageId: request.id, conversationId: request.conversationId,
    context: { original: ["all", { unicode: "雪🚀" }] },
  };
  const flights: FlightRecord[] = Array.from({ length: 300 }, (_, index) => ({
    id: `large-history-flight-${String(index).padStart(3, "0")}`, invocationId: invocation.id,
    requesterId: "actor", targetAgentId: "actor", state: "completed",
    output: `complete output ${index}: 雪🚀`, startedAt: request.createdAt + index,
    completedAt: request.createdAt + index + 1, metadata: { context: [request.id, index] },
  }));
  const delivery: DeliveryIntent = {
    id: "large-history-delivery", messageId: request.id, invocationId: invocation.id,
    targetId: "actor", targetNodeId: "node", targetKind: "agent", transport: "local_socket",
    reason: "invocation", policy: "durable", status: "completed", metadata: { context: [request.id, invocation.id] },
  };
  const attempts: DeliveryAttempt[] = Array.from({ length: 300 }, (_, index) => ({
    id: `large-history-attempt-${String(index).padStart(3, "0")}`, deliveryId: delivery.id,
    attempt: index + 1, status: "acknowledged", createdAt: request.createdAt + index,
    externalRef: `receipt-${index}`, metadata: { context: [request.id, invocation.id, index] },
  }));
  await journal.appendEntries([
    { kind: "message.record", message: request }, { kind: "invocation.record", invocation },
    ...flights.map(flight => ({ kind: "flight.record" as const, flight })),
    { kind: "deliveries.record", deliveries: [delivery] },
    ...attempts.map(attempt => ({ kind: "delivery.attempt.record" as const, attempt })),
  ]);
  await projection.warm(); await projection.flush();
  const initialStore = new SQLiteControlPlaneStore(dbPath);
  const expected = (() => {
    try { return {
      messages: initialStore.readMessages(["old", request.id]),
      invocation: initialStore.readInvocations([invocation.id]).get(invocation.id),
      flights: initialStore.readFlights(flights.map(flight => flight.id)),
      delivery: initialStore.readDeliveries([delivery.id]).get(delivery.id),
      attempts: initialStore.readDeliveryAttempts(attempts.map(attempt => attempt.id)),
    }; } finally { initialStore.close(); }
  })();
  const keys = Object.keys(emptyHistoryRotationPlan()) as (keyof HistoryRotationPlan)[];
  const count = (plan: HistoryRotationPlan) => keys.reduce((total, key) => total + plan[key].size, 0);
  let cursor: string | null = null, turns = 0, publicationPages = 0;
  for (; turns < 12; turns++) {
    const eligible = planHistoryRotation(journal.snapshot(), cutoff, journal.historyRotationContext());
    if (!count(eligible)) break;
    const batch = selectHistoryRotationBatch(eligible, journal.verificationRecords(eligible), { cursor, maxRecords: 250 });
    cursor = batch.cursor;
    expect(batch.selectedRecords).toBeGreaterThan(0);
    expect(batch.selectedRecords).toBeLessThanOrEqual(250);
    const prepared = structuredClone(journal.verificationRecords(batch.plan));
    const publication = await publishHistoryRotationPages(batch.plan, remaining => projection.publishHistoryRotation(remaining));
    publicationPages += publication.publications.length;
    expect(count(publication.published)).toBe(batch.selectedRecords);
    const verified = await projection.verifyPersisted(batch.plan);
    for (const key of keys) for (const id of verified.present[key]) {
      if (!publication.published[key].has(id)) verified.present[key].delete(id);
    }
    await durable.runWrite(async () => {
      const snapshot = journal.snapshot();
      const stillEligible = planHistoryRotation(snapshot, cutoff, journal.historyRotationContext());
      const { present, missing } = revalidateHistoryRotation(batch.plan, verified.present, stillEligible,
        prepared, journal.verificationRecords(batch.plan));
      const constrained = constrainHistoryRotationBatch(present, stillEligible, journal.verificationRecords(stillEligible));
      for (const key of keys) for (const id of present[key]) if (!constrained[key].has(id)) {
        present[key].delete(id); missing[key].add(id);
      }
      const allAttempts = journal.deliveryAttemptsById();
      const { evictable } = refineVerifiedRotation(present, missing, {
        invocation: id => snapshot.invocations[id], flight: id => snapshot.flights[id],
        delivery: id => journal.getDelivery(id), deliveryAttempt: id => allAttempts.get(id),
      });
      expect(count(evictable)).toBeGreaterThan(0);
      await durable.commitEntries({ kind: "history.rotate", cutoff, rotatedAt: cutoff + turns,
        publications: publication.publications,
        evicted: {
          messageIds: [...evictable.messageIds], invocationIds: [...evictable.invocationIds],
          flightIds: [...evictable.flightIds], deliveryIds: [...evictable.deliveryIds],
          deliveryAttemptIds: [...evictable.deliveryAttemptIds], collaborationEventIds: [...evictable.collaborationEventIds],
        } }, async () => {});
    });
    await projection.flush();
  }
  expect(turns).toBeGreaterThanOrEqual(3);
  expect(turns).toBeLessThan(12);
  expect(publicationPages).toBeGreaterThan(turns);
  expect(count(planHistoryRotation(journal.snapshot(), cutoff, journal.historyRotationContext()))).toBe(0);
  expect(Object.keys(journal.snapshot().messages)).toHaveLength(0);
  expect(Object.keys(journal.snapshot().invocations)).toHaveLength(0);
  expect(Object.keys(journal.snapshot().flights)).toHaveLength(0);
  expect(journal.listDeliveries({ limit: Infinity })).toHaveLength(0);
  expect(journal.deliveryAttemptsById().size).toBe(0);
  const historicalCleanupBoundary = await journal.captureReplayBoundary();
  await projection.flush();
  expect((await journal.compactIfNeeded({ minimumBytes: 0, minimumIntervalMs: 0,
    historicalCleanupApplied: true, historicalCleanupBoundary })).state).toBe("compacted");
  const worker = (projection as unknown as { worker: { terminate(): Promise<number> } }).worker;
  projection.close(); await worker.terminate();
  const restartedJournal = new FileBackedBrokerJournal(journalPath); await restartedJournal.load();
  const restarted = new WorkerSQLiteProjection(dbPath, journalPath, restartedJournal, { historyDirectory: join(root, "history") });
  cleanup.push(() => restarted.close()); await restarted.warm(); await restarted.flush();
  const store = new SQLiteControlPlaneStore(dbPath); store.configureHistory(join(root, "history"));
  try {
    expect(store.writerDb.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const hot = store.loadSnapshot();
    expect(Object.keys(hot.messages)).toHaveLength(0);
    expect(Object.keys(hot.invocations)).toHaveLength(0);
    expect(Object.keys(hot.flights)).toHaveLength(0);
    expect(store.writerDb.query<{ n: number }>("SELECT count(*) AS n FROM deliveries").get()?.n).toBe(0);
    expect(store.writerDb.query<{ n: number }>("SELECT count(*) AS n FROM delivery_attempts").get()?.n).toBe(0);
    expect(store.readMessages(["old", request.id])).toEqual(expected.messages);
    expect(store.readInvocations([invocation.id]).get(invocation.id)).toEqual(expected.invocation);
    expect(store.readFlights(flights.map(flight => flight.id))).toEqual(expected.flights);
    expect(store.readDeliveries([delivery.id]).get(delivery.id)).toEqual(expected.delivery);
    expect(store.readDeliveryAttempts(attempts.map(attempt => attempt.id))).toEqual(expected.attempts);
  } finally { store.close(); }
  expect((await restarted.readInvocationSnapshot(invocation.id)).flight?.id).toBe(flights.at(-1)!.id);
  for (let start = 0; start < flights.length; start += 100) {
    const records = await restarted.readHistoricalRecords("flight", flights.slice(start, start + 100).map(flight => flight.id));
    for (const [id, record] of records) expect(record).toEqual(expected.flights.get(id));
    expect(records.size).toBe(100);
  }
  for (let start = 0; start < attempts.length; start += 100) {
    const records = await restarted.readHistoricalRecords("delivery_attempt", attempts.slice(start, start + 100).map(attempt => attempt.id));
    for (const [id, record] of records) expect(record).toEqual(expected.attempts.get(id));
    expect(records.size).toBe(100);
  }
}, 20_000);

test("worker quarantines a malformed session record durably while unrelated replay and new writes continue", async () => {
  const { projection, durable, journalPath, dbPath, journal, root } = await setup();
  await projection.warm(); await projection.flush();
  const bad: BrokerJournalEntry = { kind: "delivery.attempt.record", attempt: {
    id: "bad-attempt", deliveryId: "missing-delivery", transport: "local_socket", targetId: "session:broken",
    status: "failed", startedAt: 1, completedAt: 2, metadata: { targetSessionId: "broken-session", originalContext: "exact preserved context 雪" },
  } as DeliveryAttempt };
  await durable.runWrite(() => durable.commitEntries([bad, message("healthy-after-quarantine")], async () => {}));
  await projection.flush();
  expect((await projection.readMessages(["healthy-after-quarantine"])).has("healthy-after-quarantine")).toBe(true);
  const records = await projection.listQuarantine({ sessionId: "broken-session" });
  expect(records).toHaveLength(1);
  const evidence = await projection.readQuarantine(records[0]!.id);
  expect(JSON.parse(Buffer.from(evidence!.payload, "base64").toString())).toEqual(bad);
  await projection.close();
  const restarted = new WorkerSQLiteProjection(dbPath, journalPath, journal, { historyDirectory: join(root, "history") });
  cleanup.push(() => restarted.close());
  await restarted.warm(); await restarted.flush();
  expect(restarted.statusSnapshot().quarantine?.openCount).toBe(1);
  expect((await restarted.acknowledgeQuarantine(records[0]!.id))?.status).toBe("acknowledged");
  expect(restarted.statusSnapshot().quarantine?.openCount).toBe(0);
  expect(JSON.parse(Buffer.from((await restarted.readQuarantine(records[0]!.id))!.payload, "base64").toString())).toEqual(bad);
  const direct = await restarted.quarantineRecord(message("outbox-bad"), "malformed pending reply");
  expect(direct.status).toBe("open");
  expect((await restarted.listQuarantine()).length).toBe(2);
  await journal.appendEntries(message("healthy-after-acknowledgement")); restarted.notifyCommitted();
  await restarted.flush();
  expect((await restarted.readMessages(["healthy-after-acknowledgement"])).has("healthy-after-acknowledgement")).toBe(true);
});

test("disabled quarantine storage reports unavailability without starting a worker", async () => {
  const { projection } = await setup(undefined, { disabled: true });
  await expect(projection.listQuarantine()).rejects.toThrow("unavailable");
  await expect(projection.readQuarantine("missing")).rejects.toThrow("unavailable");
  await expect(projection.acknowledgeQuarantine("missing")).rejects.toThrow("unavailable");
  await expect(projection.quarantineRecord(message("bad"), "invalid")).rejects.toThrow("unavailable");
  expect(projection.statusSnapshot().state).toBe("disabled");
});


test("one legal large quarantine record bypasses only the ordinary byte cap while additional preservation waits outside the worker queue", async () => {
  const entry = new URL("./sqlite-projection-worker-entry.ts", import.meta.url).href;
  const source = `import {parentPort} from "node:worker_threads";
    parentPort.on("message", packet => { if (packet.method === "quarantineRecord") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150); });
    await import(${JSON.stringify(entry)});`;
  const { projection, journal } = await setup(source);
  await projection.warm(); await projection.flush();
  const large: BrokerJournalEntry = { kind: "flight.record", flight: { id: "large-malformed-reply", invocationId: "invocation",
    requesterId: "actor", targetAgentId: "session:broken", state: "completed", startedAt: 1, completedAt: 2,
    output: "x".repeat(3 * 1024 * 1024), metadata: { resultReply: { status: "pending", malformed: "preserved" } },
  } };
  await journal.appendEntries(large);
  const pending = projection.quarantineRecord(large, "Malformed pending reply");
  await expect(projection.quarantineRecord(large, "duplicate while first blocked")).rejects.toThrow("one record is already in flight");
  // Every other operation still has the ordinary two-MiB admission ceiling.
  await expect(projection.publishHistoricalPage([{ kind: "flight", id: "large", record: large }])).rejects.toThrow("byte capacity");
  const saved = await pending;
  expect(saved.bytes).toBeGreaterThan(3 * 1024 * 1024);
  expect(JSON.parse(Buffer.from((await projection.readQuarantine(saved.id))!.payload, "base64").toString())).toEqual(large);
  expect(journal.snapshot().flights["large-malformed-reply"]).toEqual(large.flight);
  const later = await projection.quarantineRecord(message("after-large-preservation"), "next isolated record");
  expect(later.status).toBe("open");
});


test("exact flight projection reads cover live rows and archived records without a registry snapshot", async () => {
  const { projection, journal } = await setup();
  const invocation: InvocationRequest = { id: "exact-invocation", requesterId: "actor", requesterNodeId: "node", targetAgentId: "actor", action: "consult", task: "owned test", createdAt: 1_700_000_000_000 };
  const flight: FlightRecord = { id: "exact-flight", invocationId: invocation.id, requesterId: "actor", targetAgentId: "actor", state: "completed", output: "canonical output", metadata: { nested: ["preserved"] } };
  await journal.appendEntries([{ kind: "invocation.record", invocation }, { kind: "flight.record", flight }]);
  await projection.warm(); await projection.flush();
  expect((await projection.readFlights([flight.id])).get(flight.id)).toEqual(expect.objectContaining(flight));
  const archived = { ...flight, id: "archived-flight", output: "complete archived output" };
  await projection.publishHistoricalPage([{ kind: "flight", id: archived.id, record: archived, invocationId: invocation.id, timestamp: invocation.createdAt }]);
  expect((await projection.readFlights([archived.id])).get(archived.id)).toEqual(archived);
  expect((await projection.readFlights(["absent"])).size).toBe(0);
  let capacityError: unknown;
  try { await projection.readFlights(Array(129).fill(flight.id)); } catch (error) { capacityError = error; }
  expect(capacityError).toBeInstanceOf(Error);
  expect((capacityError as Error).message).toContain("capacity");
  projection.close();
  await expect(projection.readFlights([flight.id])).rejects.toThrow("unavailable");
});

test("explicit retry repairs a read cursor after its parent arrives without appending or redispatching work", async () => {
  const { projection, durable, journalPath, dbPath } = await setup();
  await projection.warm(); await projection.flush();
  const orphan: BrokerJournalEntry = { kind: "conversation.read_cursor.upsert", cursor: {
    conversationId: "conversation", actorId: "actor", lastReadMessageId: "late-message",
    lastReadAt: 2, updatedAt: 2, metadata: {},
  } };
  await durable.runWrite(() => durable.commitEntries([orphan], async () => {}));
  await projection.flush();
  const quarantined = (await projection.listQuarantine()).find(row => row.kind === orphan.kind)!;
  expect(quarantined).toBeDefined();
  expect((await durable.runWrite(() => projection.retryQuarantine(quarantined.id)))?.outcome).toBe("failed");
  await durable.runWrite(() => durable.commitEntries([message("late-message")], async () => {}));
  await projection.flush();
  const before = await readFile(journalPath, "utf8");
  const repaired = await durable.runWrite(() => projection.retryQuarantine(quarantined.id));
  expect(repaired?.outcome).toBe("resolved");
  const reader = new SQLiteControlPlaneStore(dbPath);
  try { expect(reader.listReadCursors("conversation")[0]?.lastReadMessageId).toBe("late-message"); }
  finally { reader.close(); }
  expect(await readFile(journalPath, "utf8")).toBe(before);
  expect((await projection.readQuarantine(quarantined.id))?.decisions?.map(d => d.outcome)).toEqual(["failed", "resolved"]);
  expect((await projection.retryQuarantine(quarantined.id))?.outcome).toBe("resolved");
  expect((await projection.readQuarantine(quarantined.id))?.decisions).toHaveLength(2);
});
