import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { BrokerJournalEntry, BrokerJournalReplayBoundary } from "./broker-journal.js";
import { decodeJournalLine } from "./broker-journal-framing.js";
import { journalEntryProblem } from "./broker-journal-record-contract.js";
import type { QuarantineEvidence } from "./broker-quarantine.js";

type RetryEntry = Extract<BrokerJournalEntry, { kind: "message.record" | "conversation.read_cursor.upsert" }>;
function key(entry: BrokerJournalEntry): string | null {
  if (entry.kind === "message.record" && typeof entry.message?.id === "string") return `message:${entry.message.id}`;
  if (entry.kind === "conversation.read_cursor.upsert" && entry.cursor?.conversationId && entry.cursor?.actorId) return `cursor:${entry.cursor.conversationId}\0${entry.cursor.actorId}`;
  return null;
}

/** Never inject preserved bytes as a new command. Find the latest canonical
 * value at a fixed journal boundary, so retry cannot overwrite newer state.
 * Destructive/lifecycle/delivery records require a separate reconciliation policy.
 */
export async function planQuarantineRetry(evidence: QuarantineEvidence,
  replay: (visit: (entry: BrokerJournalEntry) => Promise<void>, boundary: BrokerJournalReplayBoundary) => Promise<unknown>,
  boundary: BrokerJournalReplayBoundary, progress: () => Promise<void>): Promise<RetryEntry> {
  const bytes = Buffer.from(evidence.payload, "base64");
  if (bytes.length > 1024 * 1024 || bytes.length !== evidence.bytes
    || createHash("sha256").update(bytes).digest("hex") !== evidence.digest) throw new Error("Quarantine evidence failed its size or digest check.");
  const entries = decodeJournalLine(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (entries.length !== 1 || journalEntryProblem(entries[0])) throw new Error("The preserved record is malformed; leave it quarantined for inspection.");
  const original = entries[0]!;
  const target = key(original);
  if (!target) throw new Error(`Safe retry is not supported for ${original.kind}; the evidence remains quarantined.`);
  let foundOriginal = false;
  let latest: RetryEntry | null = null;
  let crossedRotation = false;
  await replay(async entry => {
    if (entry.kind === "history.rotate" && latest) crossedRotation = true;
    if (key(entry) === target) {
      if (journalEntryProblem(entry)) throw new Error("A later canonical value is malformed; retry refused.");
      if (isDeepStrictEqual(entry, original)) foundOriginal = true;
      latest = entry as RetryEntry;
      crossedRotation = false;
    }
    await progress();
  }, boundary);
  if (!foundOriginal || !latest) throw new Error("The original record is not in the retained canonical journal; inspect its archived evidence before retrying.");
  if (crossedRotation) throw new Error("History was rotated after this record; retry requires archive reconciliation.");
  return latest;
}
