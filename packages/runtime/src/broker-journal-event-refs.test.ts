import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlightRecord } from "@openscout/protocol";
import { FileBackedBrokerJournal, type BrokerJournalEntry } from "./broker-journal.js";
import { ControlEventHydrator, ControlEventThinner } from "./broker-journal-event-refs.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const flight = (overrides: Partial<FlightRecord> = {}): FlightRecord => ({
  id: "f-1", invocationId: "i-1", requesterId: "operator", targetAgentId: "agent", state: "running", startedAt: 1,
  metadata: { resultReply: { status: "pending", message: { body: "x".repeat(4000) } } }, ...overrides,
});
const event = (id: string, payload: Record<string, unknown>): BrokerJournalEntry => ({
  kind: "control.event.record",
  event: { id, kind: "flight.updated", ts: 2, actorId: "operator", nodeId: "node", payload } as never,
});
const record = (value: FlightRecord): BrokerJournalEntry => ({ kind: "flight.record", flight: value });

async function journalAt() {
  const root = await mkdtemp(join(tmpdir(), "scout-event-refs-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "journal.jsonl");
  const journal = new FileBackedBrokerJournal(path, { compactionPolicy: { minimumReclaimBytes: 1 } });
  await journal.load();
  return { path, journal };
}
const lines = async (path: string) => (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
const events = (entries: BrokerJournalEntry[]) => entries.filter(entry => entry.kind === "control.event.record");

test("an event carrying the record just written is journaled by reference and read back complete", async () => {
  const { path, journal } = await journalAt();
  const value = flight();
  await journal.appendEntries(record(value));
  await journal.appendEntries(event("e-1", { flight: value }));
  const onDisk = (await lines(path)).find(line => line.kind === "control.event.record");
  expect(onDisk.payloadRecord).toMatchObject({ field: "flight", id: "f-1" });
  expect(onDisk.event.payload.flight).toBeUndefined();
  expect(JSON.stringify(onDisk).length).toBeLessThan(400);
  expect(events(await journal.readEntries())).toEqual([event("e-1", { flight: value })]);
  const reopened = new FileBackedBrokerJournal(path); await reopened.load();
  expect(events(await reopened.readEntries())).toEqual([event("e-1", { flight: value })]);
});

test("an event whose payload differs from the journaled record keeps its copy", async () => {
  const { path, journal } = await journalAt();
  await journal.appendEntries(record(flight()));
  const changed = flight({ state: "completed", completedAt: 3 });
  await journal.appendEntries(event("e-1", { flight: changed }));
  const onDisk = (await lines(path)).find(line => line.kind === "control.event.record");
  expect(onDisk.payloadRecord).toBeUndefined();
  expect(onDisk.event.payload.flight).toEqual(changed);
});

test("a record and its event in one batch share the frame and the reference", async () => {
  const { path, journal } = await journalAt();
  const value = flight();
  await journal.appendEntries([record(value), event("e-1", { flight: value })]);
  expect(events(await journal.readEntries())).toEqual([event("e-1", { flight: value })]);
  expect((await readFile(path, "utf8")).split("x".repeat(4000)).length).toBe(2);
});

test("a tail replay resolves a record written before its cursor", async () => {
  const { path, journal } = await journalAt();
  const value = flight();
  await journal.appendEntries(record(value));
  const first = await journal.captureReplayBoundary({ barrier: { id: "b-1", projectionId: "control-plane", projectionVersion: 1, createdAt: 1 } });
  await journal.appendEntries(event("e-1", { flight: value }));
  const second = await journal.captureReplayBoundary({ barrier: { id: "b-2", projectionId: "control-plane", projectionVersion: 1, createdAt: 2 } });
  const reader = new FileBackedBrokerJournal(path);
  await reader.replay(() => {}, first);
  const seen: BrokerJournalEntry[] = [];
  await reader.replay(entry => { seen.push(entry); }, second, { startByteInclusive: first.endByteExclusive });
  expect(events(seen)).toEqual([event("e-1", { flight: value })]);
});

test("compaction keeps references to retained records", async () => {
  const { path, journal } = await journalAt();
  const value = flight();
  for (let index = 0; index < 3; index++) {
    await journal.appendEntries({ kind: "actor.upsert", actor: { id: "actor", kind: "agent", displayName: `Actor ${index}` } });
  }
  await journal.appendEntries(record(value));
  await journal.appendEntries(event("e-1", { flight: value }));
  await journal.compactIfNeeded({ minimumBytes: 0, minimumIntervalMs: 0 });
  const onDisk = await lines(path);
  expect(onDisk.filter(line => line.kind === "actor.upsert")).toHaveLength(1);
  expect(onDisk.find(line => line.kind === "control.event.record").payloadRecord).toMatchObject({ field: "flight" });
  expect(events(await journal.readEntries())).toEqual([event("e-1", { flight: value })]);
});

test("a writer that no longer holds the record writes the event complete", () => {
  const thinner = new ControlEventThinner();
  const value = flight();
  expect(thinner.encodeOne(event("e-1", { flight: value }))).toEqual(event("e-1", { flight: value }));
  // An unaccepted append never becomes a reference target.
  thinner.encode([record(value)]);
  expect(thinner.encodeOne(event("e-2", { flight: value }))).toEqual(event("e-2", { flight: value }));
});

test("ambiguous payloads keep their copies and a lost reference is reported, not invented", () => {
  const thinner = new ControlEventThinner();
  const value = flight();
  thinner.encodeOne(record(value));
  const two = event("e-1", { flight: value, invocation: { id: "i-1" } });
  expect(thinner.encodeOne(two)).toEqual(two);
  const thin = thinner.encodeOne(event("e-2", { flight: value }));
  const hydrator = new ControlEventHydrator();
  expect(hydrator.decode(thin)).toEqual(event("e-2", { flight: { id: "f-1" } as never, recordUnavailable: true }));
  expect(hydrator.unresolved).toBe(1);
});
