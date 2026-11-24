import { describe, expect, test } from "bun:test";

import type { DurableAction, DurableAttempt } from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";
import { nextDueAt, RoutineRunner } from "./routine-runner.js";

const MINUTE = 60_000;

function harness() {
  let now = 1_000_000;
  const actions = new Map<string, DurableAction>();
  const attempts: DurableAttempt[] = [];
  const posts: Array<{ text: string; title: unknown }> = [];
  const timers: Array<{ at: number; run: () => void }> = [];
  const runner = new RoutineRunner({
    nodeId: "node-a",
    listActions: () => actions.values(),
    getAction: id => actions.get(id) ?? null,
    runDurableWrite: work => work(),
    commitEntries: async (entries: BrokerJournalEntry | BrokerJournalEntry[]) => {
      for (const entry of Array.isArray(entries) ? entries : [entries]) {
        if (entry.kind === "durable.action.record") actions.set(entry.action.id, entry.action);
        if (entry.kind === "durable.attempt.record") attempts.push(entry.attempt);
      }
      return [];
    },
    post: async ({ routine, text }) => {
      posts.push({ text, title: routine.metadata?.title });
      return { id: `post-${posts.length}` };
    },
    facts: () => ({ agents: 2 }),
    now: () => now,
    setTimer: (run, ms) => { const timer = { at: now + ms, run }; timers.push(timer); return timer; },
    clearTimer: handle => { const index = timers.indexOf(handle as never); if (index >= 0) timers.splice(index, 1); },
  });
  return {
    runner, actions, attempts, posts,
    advance: async (ms: number) => { now += ms; await runner.fireDue(); },
    nextTimerAt: () => Math.min(...timers.map(timer => timer.at)),
    get now() { return now; },
  };
}

const CODE = `export default async ({ routine, runtime, scout }) => {
  await scout.post("Run " + routine.run + " of " + routine.title + "; agents " + runtime.agents);
};`;

describe("RoutineRunner", () => {
  test("a recurring routine posts each time it comes due and moves on by its interval", async () => {
    const h = harness();
    h.runner.start();
    const routine = await h.runner.create({ title: "Check-in", code: CODE, dueAt: h.now + MINUTE, everyMs: 15 * MINUTE });
    expect(h.nextTimerAt()).toBe(h.now + MINUTE);

    await h.advance(MINUTE);
    expect(h.posts.map(post => post.text)).toEqual(["Run 1 of Check-in; agents 2"]);
    const after = h.actions.get(routine.id)!;
    expect(after.state).toBe("pending");
    expect(after.metadata?.dueAt).toBe(routine.metadata!.dueAt as number + 15 * MINUTE);
    expect(after.metadata?.lastRun).toMatchObject({ ok: true, posts: ["post-1"] });
    expect(h.attempts.map(attempt => attempt.state)).toEqual(["completed"]);
    expect(h.nextTimerAt()).toBe(after.metadata?.dueAt as number);

    // Not due yet: nothing fires.
    await h.advance(MINUTE);
    expect(h.posts).toHaveLength(1);
    await h.advance(14 * MINUTE);
    expect(h.posts).toHaveLength(2);
  });

  test("a one-time routine ends after it fires, and a failing module is recorded", async () => {
    const h = harness();
    h.runner.start();
    const once = await h.runner.create({ title: "Once", code: CODE });
    const broken = await h.runner.create({ title: "Broken", code: "export default () => { throw new Error('no'); };" });
    await h.advance(0);
    expect(h.actions.get(once.id)!.state).toBe("completed");
    expect(h.actions.get(broken.id)!.state).toBe("failed");
    expect(String(h.actions.get(broken.id)!.metadata?.lastRun && (h.actions.get(broken.id)!.metadata!.lastRun as { error: string }).error)).toContain("no");
    await h.advance(60 * MINUTE);
    expect(h.posts).toHaveLength(1);
  });

  test("a cancelled routine does not fire, and short intervals are refused", async () => {
    const h = harness();
    h.runner.start();
    const routine = await h.runner.create({ title: "Later", code: CODE, dueAt: h.now + MINUTE, everyMs: MINUTE });
    await h.runner.cancel(routine.id);
    await h.advance(5 * MINUTE);
    expect(h.posts).toHaveLength(0);
    await expect(h.runner.create({ title: "Fast", code: CODE, everyMs: 1_000 })).rejects.toThrow("routine_every_too_short");
  });

  test("a routine whose run was cut off fires again once its lease runs out", async () => {
    const h = harness();
    const routine = await h.runner.create({ title: "Crash", code: CODE, everyMs: 15 * MINUTE });
    h.actions.set(routine.id, { ...routine, state: "running", leaseOwner: "routines@node-a", leaseGeneration: 1, leaseExpiresAt: h.now + MINUTE });
    h.runner.start();
    await h.advance(30_000);
    expect(h.posts).toHaveLength(0);
    await h.advance(30_000);
    expect(h.posts).toHaveLength(1);
    expect(h.actions.get(routine.id)!.state).toBe("pending");
  });

  test("missed slots are skipped, not replayed", () => {
    expect(nextDueAt(0, 10, 35)).toBe(40);
    expect(nextDueAt(0, 10, 40)).toBe(50);
    expect(nextDueAt(100, 10, 35)).toBe(100);
  });
});
