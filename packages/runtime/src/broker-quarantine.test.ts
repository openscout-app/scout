import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrokerQuarantine } from "./broker-quarantine.js";
import { FileBackedBrokerJournal, type BrokerJournalEntry } from "./broker-journal.js";
import { encodeJournalEntries } from "./broker-journal-framing.js";
import { HistoryLeaf } from "./message-history/store.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scout-quarantine-"));
  cleanup.push(() => rm(root, { recursive: true, force: true })); return root;
}
const message = (id: string): BrokerJournalEntry => ({ kind: "message.record", message: {
  id, actorId: "session:broken", originNodeId: "node", conversationId: "conversation", body: "all context 雪🚀",
  createdAt: 1, class: "agent", visibility: "private", policy: "durable", metadata: { targetSessionId: "session-broken" },
} });

test("quarantine keeps exact evidence across acknowledgement and restart with bounded indexed diagnostics", async () => {
  const root = await fixture(), path = join(root, "quarantine.sqlite");
  const ledger = new BrokerQuarantine(path); cleanup.push(() => ledger.close());
  const bytes = Buffer.from(JSON.stringify(message("bad")));
  const record = ledger.preserve({ kind: "message.record", reason: "invalid field", bytes, source: { path: "journal" }, entries: [message("bad")] });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(ledger.status().openCount).toBe(1);
  expect(ledger.list({ sessionId: "session-broken" }).map(row => row.id)).toEqual([record.id]);
  expect(ledger.acknowledge(record.id)?.status).toBe("acknowledged");
  ledger.close();
  const restarted = new BrokerQuarantine(path); cleanup.push(() => restarted.close());
  expect(restarted.status()).toMatchObject({ openCount: 0, acknowledgedCount: 1, samples: [] });
  expect(Buffer.from(restarted.read(record.id)!.payload, "base64")).toEqual(bytes);
  expect(restarted.preserve({ kind: "message.record", reason: "same failed retry", bytes, source: { path: "journal" }, entries: [message("bad")] }).status).toBe("acknowledged");
  expect(restarted.status().acknowledgedCount).toBe(1);
});

test("one malformed session message isolates its complete frame while healthy replay, indexing and compaction continue", async () => {
  const root = await fixture(), path = join(root, "journal.jsonl");
  const broken = message("broken") as Extract<BrokerJournalEntry, { kind: "message.record" }>;
  (broken.message as unknown as { body: unknown }).body = { malformed: "exact bytes must survive" };
  const badFrame = encodeJournalEntries([message("same-atomic-frame"), broken]);
  const first: BrokerJournalEntry = { kind: "actor.upsert", actor: { id: "actor", kind: "agent", displayName: "first" } };
  await writeFile(path, encodeJournalEntries([first]) + badFrame + "{broken-json\n" + encodeJournalEntries([
    { kind: "actor.upsert", actor: { id: "actor", kind: "agent", displayName: "latest" } }, message("healthy"),
  ]));
  const journal = new FileBackedBrokerJournal(path, { compactionPolicy: { minimumReclaimBytes: 1, minimumReclaimRatio: 0 } });
  expect((await journal.load()).invalidLines).toBe(2);
  expect(journal.snapshot().messages.healthy?.body).toBe("all context 雪🚀");
  expect(journal.snapshot().messages.broken).toBeUndefined();
  expect(journal.snapshot().messages["same-atomic-frame"]).toBeUndefined();
  const rows = journal.listQuarantine(); expect(rows).toHaveLength(2);
  const frame = rows.find(row => row.kind === "journal.semantic_frame")!;
  expect(Buffer.from(journal.readQuarantine(frame.id)!.payload, "base64").toString()).toBe(badFrame);
  // Startup compaction is allowed only after the exact bad bytes have a
  // durable preservation proof; healthy deduplication still makes progress.
  expect((await readFile(path, "utf8")).includes("broken-json")).toBe(false);
  await journal.appendEntries(message("healthy-later"));
  const restored = new FileBackedBrokerJournal(path); await restored.load();
  expect(restored.snapshot().messages["healthy-later"]).toBeDefined();
  expect(restored.quarantineStatus().openCount).toBe(2);
  expect(restored.acknowledgeQuarantine(frame.id)?.status).toBe("acknowledged");
  expect(Buffer.from(restored.readQuarantine(frame.id)!.payload, "base64").toString()).toBe(badFrame);
  // Exercise the production disk-history reader against a preserved frame.
  const diskPath = join(root, "disk-journal.jsonl");
  await writeFile(diskPath, badFrame + encodeJournalEntries([message("healthy-disk")]));
  const history = new HistoryLeaf(diskPath, join(root, "index.sqlite"), { messageScope: true }); cleanup.push(() => history.close());
  expect((await history.rebuild()).ready).toBe(true);
  expect((await history.get("message", "healthy-disk")).kind).toBe("found");
  expect((await history.get("message", "broken")).kind).toBe("unavailable");
});

test("a preservation failure cannot discard a bad middle frame during compaction", async () => {
  const root = await fixture(), path = join(root, "journal.jsonl");
  const original = encodeJournalEntries([message("before")]) + "{bad-json\n" + encodeJournalEntries([message("after")]);
  await writeFile(path, original);
  await writeFile(`${path}.quarantine.sqlite`, "not a sqlite database");
  const journal = new FileBackedBrokerJournal(path, { compactionPolicy: { minimumReclaimBytes: 0, minimumReclaimRatio: 0 } });
  await expect(journal.load()).rejects.toThrow("Could not preserve quarantined source");
  expect(await readFile(path, "utf8")).toBe(original);
});

test("invalid UTF8 inside valid legacy JSON retains its original bytes before compaction", async () => {
  const root = await fixture(), path = join(root, "journal.jsonl");
  const raw = Buffer.from(JSON.stringify(message("invalid-utf8")) + "\n");
  raw[raw.indexOf(Buffer.from("all context"))] = 0xff;
  await writeFile(path, Buffer.concat([raw, Buffer.from(encodeJournalEntries([message("healthy-utf8")]))]));
  const journal = new FileBackedBrokerJournal(path); cleanup.push(() => journal.close());
  expect((await journal.load()).invalidLines).toBe(1);
  expect(journal.snapshot().messages["invalid-utf8"]).toBeUndefined();
  expect(journal.snapshot().messages["healthy-utf8"]).toBeDefined();
  const [record] = journal.listQuarantine();
  expect(record!.reason).toBe("invalid_journal_utf8");
  expect(Buffer.from(journal.readQuarantine(record!.id)!.payload, "base64")).toEqual(raw);
});

test("all supported entry shapes are checked before any sibling in their atomic frame applies", async () => {
  const root = await fixture(), path = join(root, "journal.jsonl");
  const malformed = [
    { kind: "invocation.record", invocation: null },
    { kind: "deliveries.record", deliveries: { invalid: "not-an-array" } },
    { kind: "agent.endpoint.upsert", endpoint: null },
    { kind: "flight.record", flight: { id: "bad-flight" } },
    { kind: "durable.checkpoint.record", checkpoint: null },
    { kind: "collaboration.event.record", event: null },
  ];
  const frames = malformed.map((entry, index) => encodeJournalEntries([message(`sibling-${index}`), entry as BrokerJournalEntry]));
  await writeFile(path, frames.join("") + encodeJournalEntries([message("healthy-after-bad-shapes")]));
  const journal = new FileBackedBrokerJournal(path); cleanup.push(() => journal.close());
  expect((await journal.load()).invalidLines).toBe(malformed.length);
  expect(Object.keys(journal.snapshot().messages)).toEqual(["healthy-after-bad-shapes"]);
  const records = journal.listQuarantine(); expect(records).toHaveLength(malformed.length);
  expect(new Set(records.map(record => Buffer.from(journal.readQuarantine(record.id)!.payload, "base64").toString()))).toEqual(new Set(frames));
});

test("an unknown authority schema stays a shared fault even after an earlier malformed sibling", async () => {
  const root = await fixture(), path = join(root, "journal.jsonl");
  const raw = encodeJournalEntries([{ kind: "invocation.record", invocation: null }, { kind: "future.authority", data: {} }] as unknown as BrokerJournalEntry[]);
  await writeFile(path, raw);
  const journal = new FileBackedBrokerJournal(path); cleanup.push(() => journal.close());
  await expect(journal.load()).rejects.toThrow("unsupported_journal_kind");
  expect(await readFile(path, "utf8")).toBe(raw);
});


test("whole-frame quarantine fences every record beyond the bounded warning sample", async () => {
  const root = await fixture(); const ledger = new BrokerQuarantine(join(root, "ledger.sqlite")); cleanup.push(() => ledger.close());
  const entries = Array.from({ length: 25 }, (_, index) => message(`sibling-${index}`));
  const evidence = ledger.preserve({ kind: "journal.semantic_frame", reason: "bad sibling", bytes: Buffer.from(encodeJournalEntries(entries)), source: { path: "journal" }, entries });
  expect(evidence.scope.recordIds).toHaveLength(16);
  expect(ledger.hasRecord("sibling-24")).toBe(true);
  ledger.acknowledge(evidence.id);
  expect(ledger.hasRecord("sibling-24")).toBe(true);
});

test("defer and review preserve fences, while a successful retry records its decision and resolves its fence", async () => {
  const root = await fixture(), path = join(root, "quarantine.sqlite");
  const ledger = new BrokerQuarantine(path); cleanup.push(() => ledger.close());
  const entry = message("review-me"), bytes = Buffer.from(JSON.stringify(entry));
  const row = ledger.preserve({ kind: entry.kind, bytes, reason: "missing parent", source: { path: "journal" }, entries: [entry] });
  expect(ledger.defer(row.id)?.status).toBe("deferred");
  expect(ledger.status().deferredCount).toBe(1);
  expect(ledger.hasRecord("review-me")).toBe(true);
  expect(ledger.acknowledge(row.id)?.status).toBe("acknowledged");
  expect(ledger.hasRecord("review-me")).toBe(true);
  expect(ledger.retryResult(row.id, "failed", "parent missing")?.status).toBe("open");
  expect(ledger.retryResult(row.id, "resolved", null)?.status).toBe("resolved");
  expect(ledger.hasRecord("review-me")).toBe(false);
  expect(ledger.status().resolvedCount).toBe(1);
  const read = ledger.read(row.id)!;
  expect(Buffer.from(read.payload, "base64")).toEqual(bytes);
  expect(read.decisions?.map(d => d.outcome)).toEqual(["deferred", "reviewed", "failed", "resolved"]);
  expect(ledger.defer(row.id)?.status).toBe("resolved");
});

test("a repaired record that fails again reopens rather than silently losing its fence", async () => {
  const root = await fixture();
  const ledger = new BrokerQuarantine(join(root, "quarantine.sqlite")); cleanup.push(() => ledger.close());
  const entry = message("fails-again"), bytes = Buffer.from(JSON.stringify(entry));
  const input = { kind: entry.kind, bytes, reason: "parent missing", source: { path: "journal" }, entries: [entry] };
  const row = ledger.preserve(input);
  ledger.retryResult(row.id, "resolved", null);
  expect(ledger.hasRecord("fails-again")).toBe(false);
  expect(ledger.preserve(input).status).toBe("open");
  expect(ledger.hasRecord("fails-again")).toBe(true);
  expect(ledger.read(row.id)?.decisions?.at(-1)?.detail).toContain("Failed again");
});
