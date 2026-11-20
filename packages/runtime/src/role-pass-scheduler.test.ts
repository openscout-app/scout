import { describe, expect, test } from "bun:test";

import type { ControlEvent, ScoutRoleAssignment } from "@openscout/protocol";

import { RolePassError, RolePassScheduler } from "./role-pass-scheduler.js";

const PM: ScoutRoleAssignment = {
  id: "role-pm-1", roleId: "pm", agentId: "pm-agent", scope: { kind: "agent" }, active: true, assignedById: "operator", assignedAt: 0,
} as ScoutRoleAssignment;
const POLICY = { quietMs: 20_000, maxWaitMs: 120_000 };

function harness(options: { behind?: boolean } = {}) {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const started: string[] = [];
  const flights = new Map<string, { invocationId: string; state: string }>();
  let running: string | null = null;
  let behind = options.behind ?? true;
  let release: (() => void) | null = null;
  let holdStart = false;

  const scheduler = new RolePassScheduler({
    passAssignments: () => [{ assignment: PM, policy: POLICY }],
    runningPass: () => (running ? { flightId: running } : null),
    behind: () => behind,
    startPass: async (_assignment, reason) => {
      if (holdStart) await new Promise<void>((resolve) => { release = resolve; });
      const flightId = `flight-${started.length + 1}`;
      started.push(reason);
      flights.set(flightId, { invocationId: `inv-${flightId}`, state: "running" });
      running = flightId;
      return { flightId };
    },
    invocationMetadata: (invocationId) => (invocationId.startsWith("inv-flight-") ? { rolePass: PM.id } : undefined),
    isWorkItem: (id) => id.startsWith("work-"),
    now: () => now,
    setTimer: (run, ms) => {
      nextTimer += 1;
      timers.set(nextTimer, { at: now + ms, run });
      return nextTimer;
    },
    clearTimer: (handle) => { timers.delete(handle as number); },
  });

  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].run();
      await Promise.resolve();
      await Promise.resolve();
    }
    now = until;
  };
  const workEvent = (actorId = "dev-agent", recordId = "work-1"): ControlEvent => ({
    id: `e-${now}`, kind: "collaboration.event.appended", ts: now, actorId,
    payload: { event: { id: `ce-${now}`, recordId, recordKind: "work_item", kind: "progress", actorId, at: now } },
  } as unknown as ControlEvent);
  const endPass = (state: "completed" | "failed") => {
    const flightId = running!;
    running = null;
    scheduler.noteEvent({
      id: `f-${now}`, kind: "flight.updated", ts: now, actorId: "pm-agent",
      payload: { flight: { id: flightId, invocationId: flights.get(flightId)!.invocationId, state } },
    } as unknown as ControlEvent);
  };

  return {
    scheduler, started, advance, workEvent, endPass,
    setBehind: (value: boolean) => { behind = value; },
    hold: () => { holdStart = true; },
    release: () => { holdStart = false; release?.(); },
    pendingTimers: () => timers.size,
  };
}

describe("role pass scheduler", () => {
  test("a burst of changes starts one pass after the board goes quiet", async () => {
    const h = harness();
    h.scheduler.noteEvent(h.workEvent());
    await h.advance(10_000);
    h.scheduler.noteEvent(h.workEvent());
    await h.advance(19_000);
    expect(h.started).toEqual([]);
    await h.advance(1_000);
    expect(h.started).toEqual(["work.changed"]);
    expect(h.scheduler.dirty(PM.id)).toBe(false);
  });

  test("a board that never goes quiet still gets a pass at the longest wait", async () => {
    const h = harness();
    for (let elapsed = 0; elapsed < 120_000; elapsed += 10_000) {
      h.scheduler.noteEvent(h.workEvent());
      await h.advance(10_000);
    }
    expect(h.started).toEqual(["work.changed"]);
  });

  test("the holder's own changes and non-work events never mark it", async () => {
    const h = harness();
    h.scheduler.noteEvent(h.workEvent("pm-agent"));
    h.scheduler.noteEvent(h.workEvent("dev-agent", "question-1"));
    h.scheduler.noteEvent({ id: "m", kind: "message.posted", ts: 0, actorId: "dev-agent", payload: {} } as unknown as ControlEvent);
    await h.advance(200_000);
    expect(h.started).toEqual([]);
    expect(h.pendingTimers()).toBe(0);
  });

  test("changes during a pass wait for it; a completed pass with changes runs one more", async () => {
    const h = harness();
    h.scheduler.noteEvent(h.workEvent());
    await h.advance(20_000);
    expect(h.started).toHaveLength(1);

    h.scheduler.noteEvent(h.workEvent());
    await h.advance(30_000);
    expect(h.started).toHaveLength(1);
    expect(h.scheduler.dirty(PM.id)).toBe(true);

    h.endPass("completed");
    await h.advance(20_000);
    expect(h.started).toHaveLength(2);
  });

  test("a failed pass schedules nothing until the next change", async () => {
    const h = harness();
    h.scheduler.noteEvent(h.workEvent());
    await h.advance(20_000);
    h.scheduler.noteEvent(h.workEvent());
    await h.advance(30_000);
    h.endPass("failed");
    await h.advance(200_000);
    expect(h.started).toHaveLength(1);

    h.scheduler.noteEvent(h.workEvent());
    await h.advance(20_000);
    expect(h.started).toHaveLength(2);
  });

  test("a page open returns the running pass, or starts one only when the slot is behind", async () => {
    const h = harness({ behind: false });
    expect(await h.scheduler.ensure(PM.id)).toEqual({ flightId: null, started: false, behind: false });

    h.setBehind(true);
    expect(await h.scheduler.ensure(PM.id)).toEqual({ flightId: "flight-1", started: true, behind: true });
    expect(await h.scheduler.ensure(PM.id)).toEqual({ flightId: "flight-1", started: false, behind: true });
    expect(h.started).toEqual(["page.open"]);

    await expect(h.scheduler.ensure("role-missing")).rejects.toBeInstanceOf(RolePassError);
  });

  test("two page opens at once start one pass", async () => {
    const h = harness();
    h.hold();
    const first = h.scheduler.ensure(PM.id);
    await Promise.resolve();
    const second = h.scheduler.ensure(PM.id);
    h.release();
    expect(await first).toEqual({ flightId: "flight-1", started: true, behind: true });
    expect(await second).toEqual({ flightId: "flight-1", started: false, behind: true });
    expect(h.started).toHaveLength(1);
  });

  test("a page open takes over a scheduled pass", async () => {
    const h = harness();
    h.scheduler.noteEvent(h.workEvent());
    await h.advance(5_000);
    await h.scheduler.ensure(PM.id);
    await h.advance(200_000);
    expect(h.started).toEqual(["page.open"]);
  });
});
