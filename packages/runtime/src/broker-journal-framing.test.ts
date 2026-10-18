import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackedBrokerJournal, type BrokerJournalEntry } from "./broker-journal.js";
import { BrokerDurableStore } from "./broker-durable-store.js";
import { decodeJournalLine, encodeJournalEntries, JOURNAL_FRAME_LIMITS, journalLines } from "./broker-journal-framing.js";
import { HistoryLeaf } from "./message-history/store.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "scout-frame-test-")); roots.push(root);
  const path = join(root, "broker.jsonl");
  const journal = new FileBackedBrokerJournal(path);
  await journal.load();
  return { root, path, journal };
}
const retire = (actorId: string): BrokerJournalEntry => ({ kind: "actor.delete", actorId });
const entries = [retire("one"), retire("snow-雪-\ud800")];
const message = (id: string, body: string): Extract<BrokerJournalEntry, { kind: "message.record" }> => ({
  kind: "message.record", message: { id, body, createdAt: 1, actorId: "a", conversationId: "c", originNodeId: "n", class: "agent", policy: "durable", visibility: "workspace" },
});

test("every truncation inside a batch fails whole-frame decoding", () => {
  const encoded = encodeJournalEntries(entries).trimEnd();
  for (let end = 1; end < encoded.length; end++) expect(() => decodeJournalLine(encoded.slice(0, end))).toThrow();
  expect(decodeJournalLine(encoded)).toEqual(entries);
  expect(decodeJournalLine(encodeJournalEntries(entries))).toEqual(entries);
  expect(decodeJournalLine("\ufeff " + JSON.stringify(entries[0]) + "\r")).toEqual([entries[0]!]);
});

test("checksum/count/nested-frame failures do not expose an earlier valid entry", () => {
  const frame = JSON.parse(encodeJournalEntries(entries));
  expect(() => decodeJournalLine(JSON.stringify({ ...frame, count: 3 }))).toThrow("invalid_journal_batch_entries");
  expect(() => decodeJournalLine(JSON.stringify({ ...frame, payload: frame.payload.replace("one", "two") }))).toThrow("invalid_journal_batch");
  const payload = JSON.stringify([entries[0], { kind: "journal.batch" }]);
  expect(() => decodeJournalLine(JSON.stringify({ ...frame, payload, sha256: createHash("sha256").update(payload).digest("hex") }))).toThrow("invalid_journal_batch_entries");
});

test("bounded scans reject oversized records instead of certifying truncated history", async () => {
  let emitted = 0;
  async function* chunks() { for (let i = 0; i < 300; i++) { emitted++; yield Buffer.alloc(64 * 1024, 120); } }
  await expect((async () => { for await (const _ of journalLines(chunks())) {} })()).rejects.toThrow("journal_frame_byte_limit");
  expect(emitted).toBe(JOURNAL_FRAME_LIMITS.bytes / (64 * 1024) + 1);
  const { journal } = await setup();
  await expect(journal.appendEntries(Array.from({ length: JOURNAL_FRAME_LIMITS.entries + 1 }, (_, i) => retire(String(i))))).rejects.toThrow("journal_batch_entry_limit");
  expect([...journal.retiredActorIds()]).toEqual([]);
  await journal.appendEntries(retire("after"));
  expect([...journal.retiredActorIds()]).toEqual(["after"]);
});

test("restart rejects a torn frame and accepts complete legacy and later batches", async () => {
  const { path } = await setup();
  const encoded = encodeJournalEntries(entries);
  await writeFile(path, JSON.stringify(retire("legacy")) + "\n" + encoded.slice(0, -8));
  const recovered = new FileBackedBrokerJournal(path);
  const report = await recovered.load();
  expect(report.validEntries).toBe(1); expect(report.invalidLines).toBe(1);
  expect([...recovered.retiredActorIds()]).toEqual(["legacy"]);
  await recovered.appendEntries([retire("after-a"), retire("after-b")]);
  const restart = new FileBackedBrokerJournal(path);
  expect((await restart.load()).validEntries).toBe(3);
  expect([...restart.retiredActorIds()]).toEqual(["legacy", "after-a", "after-b"]);
});

test("runtime, publication, projection and acknowledgement wait for file sync", async () => {
  const { path, journal } = await setup();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const realOpen = fsPromises.open;
  const open = spyOn(fsPromises, "open").mockImplementation(async (...args) => {
    const file = await realOpen(...args);
    if (args[0] === path && args[1] === "r+") {
      const realSync = file.sync.bind(file);
      file.sync = async () => { entered.resolve(); await release.promise; await realSync(); };
    }
    return file;
  });
  const effects: string[] = [];
  const store = new BrokerDurableStore({ journal, projection: { async applyEntries() { effects.push("projection"); return []; } }, threadEvents: { publish() {} }, eventPublisher: { notifyCommitted() { effects.push("committed"); } } });
  let acknowledged = false;
  const committed = store.runWrite(() => store.commitEntries(entries, async () => { effects.push("runtime"); })).then(() => { acknowledged = true; });
  try {
    await entered.promise;
    expect(acknowledged).toBe(false); expect(effects).toEqual([]);
    expect([...journal.retiredActorIds()]).toEqual([]);
  } finally { release.resolve(); await committed; open.mockRestore(); }
  expect(acknowledged).toBe(true);
  await store.flushProjectedEntries();
  expect(effects).toEqual(["committed", "runtime", "projection"]);
});

test("failed sync rejects the whole batch and repairs before a later commit", async () => {
  const { path, journal } = await setup();
  await journal.appendEntries(retire("before"));
  const before = await readFile(path, "utf8");
  const realOpen = fsPromises.open;
  let fail = true;
  const open = spyOn(fsPromises, "open").mockImplementation(async (...args) => {
    const file = await realOpen(...args);
    if (args[0] === path && args[1] === "r+" && fail) { fail = false; file.sync = async () => { throw Error("injected fsync failure"); }; }
    return file;
  });
  try { await expect(journal.appendEntries(entries)).rejects.toThrow("injected fsync failure"); }
  finally { open.mockRestore(); }
  expect(await readFile(path, "utf8")).toBe(before);
  expect([...journal.retiredActorIds()]).toEqual(["before"]);
  await journal.appendEntries(retire("after"));
  const reloaded = new FileBackedBrokerJournal(path); await reloaded.load();
  expect([...reloaded.retiredActorIds()]).toEqual(["before", "after"]);
});

test("process death immediately after acknowledgement preserves the entire batch", async () => {
  const { path } = await setup();
  const modulePath = new URL("./broker-journal.ts", import.meta.url).href;
  const source = `import { FileBackedBrokerJournal } from ${JSON.stringify(modulePath)};
    import { writeSync } from "node:fs";
    const journal = new FileBackedBrokerJournal(${JSON.stringify(path)});
    await journal.load(); await journal.appendEntries(${JSON.stringify(entries)});
    writeSync(1, "acknowledged"); process.kill(process.pid, "SIGKILL");`;
  const child = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text(); await child.exited;
  expect(output).toBe("acknowledged");
  const recovered = new FileBackedBrokerJournal(path);
  expect((await recovered.load()).validEntries).toBe(2);
  expect(await recovered.readEntries()).toEqual(entries);
});

test("process death during a physical append cannot orphan the first logical record", async () => {
  const { path, journal } = await setup();
  await journal.appendEntries(retire("before"));
  const modulePath = new URL("./broker-journal.ts", import.meta.url).href;
  const source = `import { FileBackedBrokerJournal } from ${JSON.stringify(modulePath)};
    import * as fs from "node:fs/promises"; import { spyOn } from "bun:test";
    const journal = new FileBackedBrokerJournal(${JSON.stringify(path)}); await journal.load();
    const original = fs.appendFile;
    spyOn(fs, "appendFile").mockImplementationOnce(async (path, value) => {
      const data = String(value); await original(path, data.slice(0, -8));
      process.kill(process.pid, "SIGKILL");
    });
    await journal.appendEntries(${JSON.stringify(entries)});`;
  const child = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" });
  const error = await new Response(child.stderr).text(); await child.exited;
  expect(error).toBe("");
  const recovered = new FileBackedBrokerJournal(path);
  expect((await recovered.load()).invalidLines).toBe(1);
  expect([...recovered.retiredActorIds()]).toEqual(["before"]);
  await recovered.appendEntries(entries);
  const restarted = new FileBackedBrokerJournal(path); await restarted.load();
  expect([...restarted.retiredActorIds()]).toEqual(["before", "one", "snow-雪-\ud800"]);
});

test("disk history retains exact frame entry versions through captured reads and restart", async () => {
  const { root, path, journal } = await setup();
  const first = message("same", "old 雪"), second = message("same", "new \ud800"), other = message("other", "context\0link");
  await journal.appendEntries([first, second, other]);
  const leaf = new HistoryLeaf(path, join(root, "history.sqlite"), { messageScope: true, observeAppendOnly: true });
  try {
    expect((await leaf.rebuild()).ready).toBe(true);
    const captured = await leaf.capture(); expect(captured.kind).toBe("found");
    expect(await leaf.get("message", "same")).toMatchObject({ kind: "found", value: second.message });
    expect(await leaf.get("message", "other")).toMatchObject({ kind: "found", value: other.message });
    await journal.appendEntries([message("same", "after"), retire("unrelated")]);
    const source = await fsPromises.stat(path);
    expect((await leaf.catchUp({ source: "broker_journal", fileIdentity: `${source.dev}:${source.ino}`, endByteExclusive: source.size })).ready).toBe(true);
    if (captured.kind === "found") {
      expect(await leaf.get("message", "same", captured.value)).toMatchObject({ kind: "found", value: second.message });
      leaf.release(captured.value);
    }
    expect(await leaf.get("message", "same")).toMatchObject({ kind: "found", value: message("same", "after").message });
    expect((await leaf.rebuild()).ready).toBe(true);
    expect(await leaf.get("message", "other")).toMatchObject({ kind: "found", value: other.message });
  } finally { await leaf.close(); }
});
