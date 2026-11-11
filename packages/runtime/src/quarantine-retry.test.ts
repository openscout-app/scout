import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { BrokerJournalEntry, BrokerJournalReplayBoundary } from "./broker-journal.js";
import type { QuarantineEvidence } from "./broker-quarantine.js";
import { planQuarantineRetry } from "./quarantine-retry.js";
const message = (body: string): BrokerJournalEntry => ({ kind: "message.record", message: {
  id: "m", actorId: "a", conversationId: "c", originNodeId: "n", body, class: "agent",
  visibility: "private", policy: "durable", createdAt: 1, metadata: {},
} });
function evidence(entry: BrokerJournalEntry): QuarantineEvidence {
  const bytes = Buffer.from(JSON.stringify(entry));
  return { id: "quarantine-test", status: "open", kind: entry.kind, reason: "missing parent", bytes: bytes.length,
    digest: createHash("sha256").update(bytes).digest("hex"), createdAt: 1, acknowledgedAt: null,
    scope: { recordIds: ["m"], actorIds: [], sessionIds: [], invocationIds: [] },
    encoding: "base64", payload: bytes.toString("base64"), source: { path: "fixture" } };
}
const boundary = {} as BrokerJournalReplayBoundary;
function plan(original: QuarantineEvidence, entries: BrokerJournalEntry[]) {
  return planQuarantineRetry(original, async visit => { for (const entry of entries) await visit(entry); }, boundary, async () => {});
}
test("retry selects the latest canonical value instead of stale preserved bytes", async () => {
  const old = message("old"), latest = message("new");
  expect(await plan(evidence(old), [old, latest])).toEqual(latest);
});
test("untrusted, unsupported and archived records remain quarantined", async () => {
  const old = message("old"), saved = evidence(old);
  await expect(plan({ ...saved, digest: "wrong" }, [old])).rejects.toThrow("digest");
  await expect(plan(saved, [])).rejects.toThrow("not in the retained");
  await expect(plan(saved, [old, { kind: "history.rotate", cutoff: 2, rotatedAt: 3 }])).rejects.toThrow("rotated");
  const flight = { kind: "flight.record", flight: { id: "f", requesterId: "a", targetAgentId: "b", invocationId: "i", state: "running", metadata: {} } } as BrokerJournalEntry;
  await expect(plan(evidence(flight), [flight])).rejects.toThrow("not supported");
});
test("malformed unrelated records do not prevent a supported retry", async () => {
  const old = message("old");
  expect(await plan(evidence(old), [{ kind: "message.record" } as BrokerJournalEntry, old])).toEqual(old);
});
