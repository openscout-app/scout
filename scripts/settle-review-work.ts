#!/usr/bin/env bun
// One-time settle pass for work items that went to review under the old
// default. Until this change, every new work item started with acceptance
// "pending", so finished work waited in review on its requester, usually the
// operator, even though nobody asked for a review.
//
// This script moves those items to done through the runtime API. It changes
// nothing unless you pass --apply.
//
//   bun scripts/settle-review-work.ts                     # report only
//   bun scripts/settle-review-work.ts --apply             # settle them
//   bun scripts/settle-review-work.ts --older-than-days 0 # include recent items
//   bun scripts/settle-review-work.ts --waiting-on operator
//
// Plain `bun` talks to the installed runtime. Set OPENSCOUT_INSTANCE to target
// another instance.

import type { CollaborationRecord } from "../packages/protocol/src/index.ts";
import {
  requireScoutBrokerContext,
  resolveScoutBrokerUrl,
  updateScoutWorkItem,
} from "../packages/cli/src/lib/core/broker/service.ts";

type Options = {
  apply: boolean;
  olderThanDays: number;
  waitingOn: string;
};

function parseOptions(argv: string[]): Options {
  const options: Options = { apply: false, olderThanDays: 7, waitingOn: "operator" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--older-than-days") {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value) || value < 0) throw new Error("--older-than-days needs a number of days, 0 or more");
      options.olderThanDays = value;
    } else if (arg === "--waiting-on") {
      const value = argv[++index]?.trim();
      if (!value) throw new Error("--waiting-on needs an actor id");
      options.waitingOn = value;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

export function settleCandidates(
  records: Iterable<CollaborationRecord>,
  options: { waitingOn: string; olderThanDays: number; now: number },
): CollaborationRecord[] {
  const cutoff = options.now - options.olderThanDays * 86_400_000;
  return [...records]
    .filter((record) => record.kind === "work_item"
      && record.state === "review"
      && record.acceptanceState === "pending"
      && record.nextMoveOwnerId === options.waitingOn
      && record.updatedAt <= cutoff)
    .sort((left, right) => left.updatedAt - right.updatedAt);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const baseUrl = resolveScoutBrokerUrl();
  const broker = await requireScoutBrokerContext(baseUrl);
  const all = Object.values(broker.snapshot.collaborationRecords ?? {}) as CollaborationRecord[];
  const inReview = settleCandidates(all, { ...options, olderThanDays: 0, now: Date.now() });
  const candidates = settleCandidates(all, { ...options, now: Date.now() });

  console.log(`Runtime: ${baseUrl}`);
  console.log(`In review waiting on ${options.waitingOn}: ${inReview.length}`);
  console.log(`Unchanged for ${options.olderThanDays} days or more: ${candidates.length}`);
  if (candidates.length > 0) {
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    console.log(`Oldest ${day(candidates[0]!.updatedAt)}, newest ${day(candidates.at(-1)!.updatedAt)}`);
  }

  if (!options.apply) {
    console.log("Nothing changed. Run again with --apply to move these items to done.");
    return;
  }

  let settled = 0;
  const failures: string[] = [];
  for (const record of candidates) {
    try {
      await updateScoutWorkItem({
        workId: record.id,
        actorId: options.waitingOn,
        state: "done",
        acceptanceState: "none",
        nextMoveOwnerId: null,
        eventSummary: "Settled from review: finished work no longer waits for a review nobody asked for.",
        source: "settle-review-work",
        metadata: { settledFromReview: { at: Date.now(), reviewRequestedAt: record.reviewRequestedAt ?? null } },
      });
      settled += 1;
      if (settled % 50 === 0) console.log(`Settled ${settled} of ${candidates.length}`);
    } catch (error) {
      failures.push(`${record.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`Settled ${settled} of ${candidates.length}.`);
  if (failures.length > 0) {
    console.log(`Failed ${failures.length}:`);
    for (const failure of failures) console.log(`  ${failure}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
