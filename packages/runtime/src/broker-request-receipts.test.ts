import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerRequestReceipts } from "./broker-request-receipts.js";

describe("broker requester-scoped request receipts", () => {
  test("concurrent calls and reopened ledger return original receipt; changed content conflicts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-receipts-"));
    try {
      const ledger = new BrokerRequestReceipts(dir);
      let calls = 0;
      const execute = async () => { calls++; await Bun.sleep(10); return { flightId: "flt-1" }; };
      const results = await Promise.all([ledger.run("scoutbot", "key", "deliver", { body: "build" }, execute), ledger.run("scoutbot", "key", "deliver", { body: "build" }, execute)]);
      expect(results).toEqual([{ flightId: "flt-1" }, { flightId: "flt-1" }]);
      expect(calls).toBe(1);
      expect(await new BrokerRequestReceipts(dir).run("scoutbot", "key", "deliver", { body: "build" }, execute)).toEqual(results[0]);
      await expect(ledger.run("scoutbot", "key", "deliver", { body: "different" }, execute)).rejects.toThrow("different content");
      await ledger.run("other-agent", "key", "deliver", { body: "build" }, execute);
      expect(calls).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("a lost receipt is reconciled from canonical evidence without repeating execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-receipt-recovery-"));
    try {
      let calls = 0; const accepted = { flightId: "flight-original", messageId: "message-original", receipt: { executionResolution: "exact" } };
      await expect(new BrokerRequestReceipts(dir).run("operator", "key", "deliver", {}, async () => {
        calls++; throw new Error("crash after canonical append");
      })).rejects.toThrow();
      const ledger = new BrokerRequestReceipts(dir);
      const retry = () => ledger.run("operator", "key", "deliver", {}, async () => { calls++; return accepted; }, async () => accepted);
      expect(await Promise.all([retry(), retry()])).toEqual([accepted, accepted]);
      expect(calls).toBe(1);
      expect(await new BrokerRequestReceipts(dir).run("operator", "key", "deliver", {}, async () => { throw new Error("must not execute"); })).toEqual(accepted);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("ambiguous acceptance is never re-executed, even across reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-receipts-"));
    try {
      let calls = 0;
      await expect(new BrokerRequestReceipts(dir).run("scoutbot", "key", "deliver", {}, async () => { calls++; throw new Error("lost receipt"); })).rejects.toThrow();
      await expect(new BrokerRequestReceipts(dir).run("scoutbot", "key", "deliver", {}, async () => { calls++; return {}; })).rejects.toThrow("request_outcome_unknown");
      expect(calls).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

test("slow receipt fsync leaves timers and other keys responsive; dispatch waits for both flushes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-receipt-async-"));
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  };
  const fileEntered = deferred(), fileRelease = deferred();
  const directoryEntered = deferred(), directoryRelease = deferred();
  const doneEntered = deferred(), doneRelease = deferred();
  let executions = 0, settled = false;
  const ledger = new BrokerRequestReceipts(dir, { sync: async (file, kind, record) => {
    if (record.requestId === "slow") {
      if (record.state === "unknown" && kind === "file") { fileEntered.resolve(); await fileRelease.promise; }
      if (record.state === "unknown" && kind === "directory") { directoryEntered.resolve(); await directoryRelease.promise; }
      if (record.state === "done" && kind === "file") { doneEntered.resolve(); await doneRelease.promise; }
    }
    await file.sync();
  } });
  const execute = async () => { executions++; return { flightId: "one" }; };
  const slow = ledger.run("operator", "slow", "deliver", { body: "same" }, execute);
  slow.then(() => { settled = true; });
  const replay = ledger.run("operator", "slow", "deliver", { body: "same" }, execute);
  try {
    await expect(ledger.run("operator", "slow", "deliver", { body: "changed" }, execute)).rejects.toThrow("different content");
    await fileEntered.promise;
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(await ledger.run("operator", "other", "deliver", {}, async () => ({ fast: true }))).toEqual({ fast: true });
    expect(executions).toBe(0);
    fileRelease.resolve(); await directoryEntered.promise;
    expect(executions).toBe(0);
    directoryRelease.resolve(); await doneEntered.promise;
    expect(executions).toBe(1); expect(settled).toBe(false);
    expect((await ledger.get("operator", "slow", "deliver"))?.state).toBe("unknown");
    doneRelease.resolve();
    expect(await Promise.all([slow, replay])).toEqual([{ flightId: "one" }, { flightId: "one" }]);
    expect((await ledger.get("operator", "slow", "deliver"))?.state).toBe("done");
    expect(ledger.status().pendingOperations).toBe(0);
    expect(ledger.status().pendingBytes).toBe(0);
  } finally {
    fileRelease.resolve(); directoryRelease.resolve(); doneRelease.resolve();
    await Promise.allSettled([slow, replay]); rmSync(dir, { recursive: true, force: true });
  }
});

test("receipt capacity bounds reads and pending acceptance while a same-key replay shares its slot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-receipt-capacity-"));
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const ledger = new BrokerRequestReceipts(dir, { maxOperations: 1, sync: async (file, kind, record) => {
    if (kind === "file" && record.state === "unknown") { entered(); await barrier; }
    await file.sync();
  } });
  let calls = 0;
  const execute = async () => { calls++; return "original"; };
  const first = ledger.run("actor", "one", "deliver", {}, execute);
  const replay = ledger.run("actor", "one", "deliver", {}, execute);
  try {
    await waiting;
    await expect(ledger.run("actor", "two", "deliver", {}, execute)).rejects.toThrow("capacity");
    await expect(ledger.get("actor", "one", "deliver")).rejects.toThrow("capacity");
    expect(ledger.status().pendingOperations).toBe(1); expect(calls).toBe(0);
    release(); expect(await Promise.all([first, replay])).toEqual(["original", "original"]);
    expect(await ledger.get("actor", "two", "deliver")).toBeNull();
    expect(calls).toBe(1); expect(ledger.status().pendingBytes).toBe(0);
    const byteBound = new BrokerRequestReceipts(dir, { maxBytes: 8 });
    await expect(byteBound.run("actor", "oversize", "deliver", { body: "large" }, execute)).rejects.toThrow("capacity");
    await expect(byteBound.get("actor", "one", "deliver")).rejects.toThrow("byte queue");
    expect(await ledger.get("actor", "oversize", "deliver")).toBeNull();
    expect(byteBound.status().pendingOperations).toBe(0);
  } finally { release(); await Promise.allSettled([first, replay]); rmSync(dir, { recursive: true, force: true }); }
});

test("a failed reservation directory flush cannot execute work and remains unknown on reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-receipt-flush-failure-"));
  let calls = 0;
  try {
    const ledger = new BrokerRequestReceipts(dir, { sync: async (file, kind) => {
      if (kind === "directory") throw new Error("disk sync failed");
      await file.sync();
    } });
    await expect(ledger.run("actor", "key", "deliver", {}, async () => { calls++; })).rejects.toThrow("disk sync failed");
    expect(calls).toBe(0); expect(ledger.status().pendingOperations).toBe(0);
    const reopened = new BrokerRequestReceipts(dir);
    expect((await reopened.get("actor", "key", "deliver"))?.state).toBe("unknown");
    await expect(reopened.run("actor", "key", "deliver", {}, async () => { calls++; })).rejects.toThrow("request_outcome_unknown");
    expect(calls).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("corrupt or mismatched receipt data preserves the reservation and fails only its key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-receipt-corrupt-"));
  let calls = 0, reconciliations = 0;
  const execute = async () => { calls++; return { flightId: "original" }; };
  try {
    await new BrokerRequestReceipts(dir).run("actor", "key", "deliver", {}, execute);
    const path = join(dir, readdirSync(dir)[0]!);
    const original = readFileSync(path, "utf8");
    const receipt = JSON.parse(original);
    const malformed = [
      "null", "false", "0", "[]", '"receipt"', "{", "{}",
      JSON.stringify({ ...receipt, state: "absent" }),
      JSON.stringify({ ...receipt, fingerprint: "not-a-digest" }),
      JSON.stringify({ ...receipt, requesterId: "another-actor" }),
      JSON.stringify({ ...receipt, requestId: "another-key" }),
      JSON.stringify({ ...receipt, operation: "another-operation" }),
      JSON.stringify({ ...receipt, requesterId: " " }),
      JSON.stringify({ ...receipt, requestId: "" }),
      JSON.stringify({ ...receipt, operation: null }),
    ];
    for (const payload of malformed) {
      writeFileSync(path, payload);
      const reopened = new BrokerRequestReceipts(dir);
      await expect(reopened.run("actor", "key", "deliver", {}, execute, async () => {
        reconciliations++; return { flightId: "reconciled" };
      })).rejects.toThrow("request_outcome_unknown: corrupt request receipt");
      await expect(reopened.get("actor", "key", "deliver")).rejects.toThrow("corrupt request receipt");
      await expect(reopened.recover("actor", "key", "deliver", { flightId: "recovered" })).rejects.toThrow("corrupt request receipt");
      expect(readFileSync(path, "utf8")).toBe(payload);
      expect(calls).toBe(1); expect(reconciliations).toBe(0);
      expect(reopened.status().pendingOperations).toBe(0);
      expect(reopened.status().pendingBytes).toBe(0);
    }
    expect(await new BrokerRequestReceipts(dir).run("actor", "other-key", "deliver", {}, async () => "unaffected")).toBe("unaffected");
    // Inspection/repair can restore the original receipt without changing its
    // identity or allowing another execution.
    writeFileSync(path, original);
    expect(await new BrokerRequestReceipts(dir).run("actor", "key", "deliver", {}, execute)).toEqual({ flightId: "original" });
    expect(calls).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("first directory parent flush is shared and blocks execution without blocking ready ledgers", async () => {
  const root = mkdtempSync(join(tmpdir(), "scout-receipt-parent-sync-"));
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let parentFlushes = 0, executions = 0;
  const ledger = new BrokerRequestReceipts(join(root, "new-receipts"), { sync: async (file, kind) => {
    if (kind === "parent_directory") { parentFlushes++; entered(); await barrier; }
    await file.sync();
  } });
  const ready = new BrokerRequestReceipts(join(root, "ready-receipts"));
  await ready.run("actor", "warmup", "deliver", {}, async () => "warm");
  const execute = async () => { executions++; return "accepted"; };
  const first = ledger.run("actor", "one", "deliver", {}, execute);
  const second = ledger.run("actor", "two", "deliver", {}, execute);
  try {
    await waiting;
    let timerRan = false;
    await new Promise<void>(resolve => setTimeout(() => { timerRan = true; resolve(); }, 5));
    expect(timerRan).toBe(true);
    expect(await ready.run("actor", "other", "deliver", {}, async () => "responsive")).toBe("responsive");
    expect(executions).toBe(0); expect(parentFlushes).toBe(1);
    expect(await ledger.get("actor", "one", "deliver")).toBeNull();
    release(); expect(await Promise.all([first, second])).toEqual(["accepted", "accepted"]);
    expect(await ledger.run("actor", "three", "deliver", {}, execute)).toBe("accepted");
    expect(executions).toBe(3); expect(parentFlushes).toBe(1);
  } finally { release(); await Promise.allSettled([first, second]); rmSync(root, { recursive: true, force: true }); }
});

test("failed initial parent flush retains every new ancestor for an asynchronous retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "scout-receipt-parent-retry-"));
  let parentFlushes = 0, executions = 0;
  const ledger = new BrokerRequestReceipts(join(root, "new", "control", "receipts"), { sync: async (file, kind) => {
    if (kind === "parent_directory" && ++parentFlushes === 2) throw new Error("parent sync failed");
    await file.sync();
  } });
  const execute = async () => { executions++; return "accepted"; };
  try {
    await expect(ledger.run("actor", "key", "deliver", {}, execute)).rejects.toThrow("parent sync failed");
    expect(executions).toBe(0); expect(parentFlushes).toBe(2);
    expect(await ledger.get("actor", "key", "deliver")).toBeNull();
    expect(await ledger.run("actor", "key", "deliver", {}, execute)).toBe("accepted");
    expect(executions).toBe(1); expect(parentFlushes).toBe(5);
    expect(ledger.status().pendingOperations).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { RetryablePreEffectFailure, ProvenRequestFailure } from "./broker-request-receipts.js";
test("pre-effect failure releases only the reservation, preserving fingerprint across restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-pre-effect-"));
  try {
    const ledger = new BrokerRequestReceipts(dir);
    await expect(ledger.run("op", "id", "send", { body: "a" }, async () => {
      throw new RetryablePreEffectFailure("admission refused before any effect");
    })).rejects.toBeInstanceOf(RetryablePreEffectFailure);
    const reopened = new BrokerRequestReceipts(dir);
    expect((await reopened.get("op", "id", "send"))?.state).toBe("retryable");
    await expect(reopened.run("op", "id", "send", { body: "b" }, async () => "bad")).rejects.toThrow("different content");
    let executions = 0;
    const run = () => reopened.run("op", "id", "send", { body: "a" }, async () => { executions++; return "ok"; });
    expect(await Promise.all([run(), run()])).toEqual(["ok", "ok"]);
    expect(executions).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("proven failure is terminal and replays evidence, never invoking reconciliation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-proven-failure-"));
  try {
    let executions = 0;
    const run = () => new BrokerRequestReceipts(dir).run("op", "id", "send", {}, async () => {
      executions++; throw new ProvenRequestFailure("rejected", "denied", "canonical rejection record reject-1");
    }, async () => { throw Error("must not reconcile"); });
    for (let i = 0; i < 2; i++) await expect(run()).rejects.toMatchObject({ code: "denied", evidence: "canonical rejection record reject-1" });
    expect(executions).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
