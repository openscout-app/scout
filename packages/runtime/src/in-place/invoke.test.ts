import { describe, expect, test } from "bun:test";

import { isDeliveryBlockedError } from "../delivery-blocked.js";
import { isRequesterWaitTimeoutError } from "../requester-timeout.js";

import type { InPlaceCheckpoint } from "./checkpoint.js";
import type { InPlaceDelivery, InPlaceProbe } from "./deliver.js";
import { inPlaceSessionForEndpoint, invokeSessionInPlace, type InPlaceInvokeDeps, type InPlaceInvokeInput } from "./invoke.js";
import type { SessionReply } from "./reply.js";

const SESSION = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
const PLACE = { via: "herdr", location: "Herdr work · w1:p2" } as const;
const live = (activity: "idle" | "busy" | "blocked" | "composing" | "unknown"): InPlaceProbe => ({ live: true, ...PLACE, activity });
const typedOk: InPlaceDelivery = { ok: true, ...PLACE };

/**
 * A scripted session. `probes` and `replies` are consumed one per call, and the
 * last entry repeats. Time moves only when the code under test sleeps.
 */
function harness(script: {
  probes: Array<InPlaceProbe | Error>;
  deliveries?: InPlaceDelivery[];
  replies?: SessionReply[];
  transcript?: boolean;
  holder?: Array<{ live: boolean; idle: boolean } | Error>;
  explicit?: Array<string | null>;
  cancelAfterProbes?: number;
  /** The ask is cancelled after the probe, while the delivery finds the place again. */
  cancelDuringDelivery?: boolean;
  input?: Partial<InPlaceInvokeInput>;
  /** What an earlier runtime left on the task, and the time this one starts at. */
  checkpoint?: InPlaceCheckpoint;
  clock?: number;
  /** Checkpoint writes that fail. */
  failSave?: (checkpoint: InPlaceCheckpoint | null) => boolean;
}) {
  let clock = script.clock ?? 0;
  let probes = 0;
  const typed: string[] = [];
  const progress: string[] = [];
  const saved: Array<InPlaceCheckpoint | null> = [];
  /** Checkpoint writes and keystrokes, in the order they happened. */
  const events: string[] = [];
  const readFrom: Array<number | undefined> = [];
  const next = <T>(list: T[], index: number): T => list[Math.min(index, list.length - 1)]!;
  let deliveries = 0;
  let replies = 0;
  let holders = 0;
  let explicits = 0;
  let cancelled = false;
  const deps: InPlaceInvokeDeps = {
    probe: async () => {
      const probe = next(script.probes, probes++);
      if (probe instanceof Error) throw probe;
      return probe;
    },
    deliver: async ({ body, beforeKeystroke }) => {
      const result = next(script.deliveries ?? [typedOk], deliveries++);
      if (script.cancelDuringDelivery) cancelled = true;
      // As the real delivery does: once every check passed, before the first keystroke.
      if (result.ok || (result.code === "in_place_failed" && result.nothingSent !== true)) {
        try {
          await beforeKeystroke?.(PLACE);
        } catch (error) {
          return { ok: false, code: "in_place_failed", ...PLACE, nothingSent: true, detail: String(error) };
        }
      }
      if (result.ok) {
        typed.push(body);
        events.push("keystroke");
      }
      return result;
    },
    openReplyReader: async ({ fromOffset }) => {
      readFrom.push(fromOffset);
      return script.transcript === false ? null : {
        path: "/work/transcript.jsonl",
        offset: fromOffset ?? 4_096,
        size: () => 0,
        read: async () => next(script.replies ?? [{ state: "pending", accepted: true }], replies++),
      };
    },
    checkpoint: () => script.checkpoint ?? null,
    saveCheckpoint: async (checkpoint) => {
      if (script.failSave?.(checkpoint)) throw new Error("journal unavailable");
      saved.push(checkpoint);
      events.push(checkpoint?.phase ?? "cleared");
    },
    holderState: async () => {
      const state = next(script.holder ?? [{ live: true, idle: false }], holders++);
      if (state instanceof Error) throw state;
      return state;
    },
    explicitReply: async () => next(script.explicit ?? [null], explicits++),
    onProgress: (summary) => { progress.push(summary); },
    shouldContinue: () => !cancelled && (script.cancelAfterProbes === undefined || probes < script.cancelAfterProbes),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  };
  const input: InPlaceInvokeInput = {
    sessionId: SESSION,
    harness: "claude",
    label: "app:0199aaaa",
    prompt: "the ask\n\nScout task inv-1",
    explicitReplyPrompt: "the ask, reply with scout reply. Scout task inv-1",
    marker: "inv-1",
    wake: false,
    ...script.input,
  };
  const startedAt = clock;
  return {
    run: () => invokeSessionInPlace(input, deps),
    typed,
    progress,
    saved,
    events,
    readFrom,
    probeCount: () => probes,
    elapsed: () => clock - startedAt,
  };
}

async function refusal(run: () => Promise<unknown>): Promise<{ stage: string; message: string }> {
  try {
    await run();
  } catch (error) {
    if (isDeliveryBlockedError(error)) return { stage: error.stage, message: error.message };
    throw error;
  }
  throw new Error("expected the delivery to be refused");
}

describe("inPlaceSessionForEndpoint", () => {
  const flat = (metadata: Record<string, unknown>, harness = "claude") =>
    inPlaceSessionForEndpoint({ harness, metadata: { flatDispatch: true, ...metadata } });

  test("an endpoint made for an exact session names that session", () => {
    expect(flat({ nativeSessionId: SESSION })).toEqual({ sessionId: SESSION, harness: "claude" });
    expect(flat({ externalSessionId: SESSION }, "codex")).toEqual({ sessionId: SESSION, harness: "codex" });
  });

  test("an agent card, a fork, another harness and a session with no id are never delivered in place", () => {
    expect(inPlaceSessionForEndpoint({ harness: "claude", metadata: { nativeSessionId: SESSION } })).toBeNull();
    expect(flat({ nativeSessionId: SESSION, forkedFromSessionId: "0199aaaa-0000-7000-8000-000000000000" })).toBeNull();
    expect(flat({ nativeSessionId: SESSION }, "kimi")).toBeNull();
    expect(flat({ nativeSessionId: "  " })).toBeNull();
    expect(inPlaceSessionForEndpoint({ harness: "claude" })).toBeNull();
  });
});

describe("invokeSessionInPlace", () => {
  test("an idle session takes the ask at once and its transcript answer is the reply", async () => {
    const session = harness({ probes: [live("idle")], replies: [{ state: "pending", accepted: true }, { state: "answered", text: "It passes." }] });
    expect(await session.run()).toEqual({ output: "It passes.", delivery: { ...PLACE, heldMs: 0, replySource: "transcript" } });
    expect(session.typed).toEqual(["the ask\n\nScout task inv-1"]);
    expect(session.progress).toEqual(["Delivered to app:0199aaaa in Herdr work · w1:p2. Waiting for its reply."]);
  });

  test("a busy session is not typed into until it is idle, and the hold is reported once", async () => {
    const session = harness({ probes: [live("busy"), live("busy"), live("busy"), live("idle")], replies: [{ state: "answered", text: "done" }] });
    const result = await session.run();
    expect(result?.delivery).toMatchObject({ heldMs: 6_000, replySource: "transcript" });
    expect(session.typed).toHaveLength(1);
    expect(session.probeCount()).toBe(4);
    expect(session.progress[0]).toBe("app:0199aaaa is mid-turn in Herdr work · w1:p2. The task is held until the turn ends.");
    expect(session.progress.filter((line) => line.includes("mid-turn"))).toHaveLength(1);
  });

  test("unsent text in the composer holds the task until it is sent or cleared", async () => {
    const session = harness({ probes: [live("composing"), live("composing"), live("idle")], replies: [{ state: "answered", text: "done" }] });
    const result = await session.run();
    expect(result?.delivery).toMatchObject({ heldMs: 4_000 });
    expect(session.typed).toHaveLength(1);
    expect(session.progress[0]).toBe(
      "app:0199aaaa has unsent text in its composer in Herdr work · w1:p2. The task is held until that is sent or cleared.",
    );
  });

  test("text typed between the probe and the paste sends the task back to waiting", async () => {
    const draft: InPlaceDelivery = { ok: false, code: "busy", ...PLACE, detail: "The composer holds unsent text. Nothing was typed." };
    const session = harness({
      probes: [live("idle"), live("composing"), live("idle")],
      deliveries: [draft, typedOk],
      replies: [{ state: "answered", text: "done" }],
    });
    await session.run();
    expect(session.typed).toHaveLength(1);
    expect(session.probeCount()).toBe(3);
  });

  test("a draft left in the composer past the hold is refused by name", async () => {
    const session = harness({ probes: [live("composing")], input: { holdMs: 10_000 } });
    const refused = await refusal(session.run);
    expect(refused.stage).toBe("in_place_hold_expired");
    expect(refused.message).toBe("app:0199aaaa had unsent text in its composer in Herdr work · w1:p2 for 1 minute. Nothing was typed.");
    expect(session.typed).toEqual([]);
  });

  test("a session sitting at a prompt is held the same way", async () => {
    const session = harness({ probes: [live("blocked"), live("idle")], replies: [{ state: "answered", text: "done" }] });
    await session.run();
    expect(session.progress[0]).toContain("is waiting on a prompt");
    expect(session.typed).toHaveLength(1);
  });

  test("a session that never goes idle fails after the hold with nothing typed", async () => {
    const session = harness({ probes: [live("busy")], input: { holdMs: 60_000 } });
    const refused = await refusal(session.run);
    expect(refused.stage).toBe("in_place_hold_expired");
    expect(refused.message).toContain("Nothing was typed");
    expect(session.typed).toEqual([]);
    expect(session.elapsed()).toBeLessThanOrEqual(62_000);
  });

  test("a session whose activity cannot be read is refused quickly with nothing typed", async () => {
    const session = harness({ probes: [live("unknown")] });
    const refused = await refusal(session.run);
    expect(refused.stage).toBe("in_place_activity_unknown");
    expect(session.typed).toEqual([]);
    expect(session.elapsed()).toBeLessThan(30_000);
  });

  test("a session that is not open anywhere is left to the caller", async () => {
    const session = harness({ probes: [{ live: false, code: "not_live", held: false }] });
    expect(await session.run()).toBeNull();
    expect(session.typed).toEqual([]);
  });

  test("a Claude session is left to the caller only on two readings of not open, never on one", async () => {
    // One reading can catch Claude's own record half written.
    const closed = harness({ probes: [{ live: false, code: "not_live", held: false }] });
    expect(await closed.run()).toBeNull();
    expect(closed.probeCount()).toBe(2);
    const open = harness({
      probes: [{ live: false, code: "not_live", held: false }, live("idle")],
      replies: [{ state: "answered", text: "done" }],
    });
    expect((await open.run())?.output).toBe("done");
    expect(open.typed).toHaveLength(1);
    const outOfReach = harness({ probes: [{ live: false, code: "not_live", held: false }, { live: false, code: "not_live", held: true }] });
    expect((await refusal(outOfReach.run)).stage).toBe("in_place_unreachable");
    // Codex parks a second writer on its own thread lock, so one reading is enough.
    const codex = harness({ probes: [{ live: false, code: "not_live", held: false }], input: { harness: "codex" } });
    expect(await codex.run()).toBeNull();
    expect(codex.probeCount()).toBe(1);
  });

  test("a session that closes while the ask is held is left to the caller, with nothing typed", async () => {
    const session = harness({ probes: [live("busy"), live("busy"), { live: false, code: "not_live", held: false }] });
    expect(await session.run()).toBeNull();
    expect(session.typed).toEqual([]);
  });

  test("a Claude session running out of reach is refused, never handed back to be resumed beside itself", async () => {
    const session = harness({ probes: [{ live: false, code: "not_live", held: true }] });
    const refused = await refusal(session.run);
    expect(refused.stage).toBe("in_place_unreachable");
    expect(refused.message).toContain("no copy was started");
    expect(session.typed).toEqual([]);
  });

  test("a Codex thread running out of reach goes back to the caller, whose thread lock parks it", async () => {
    const session = harness({ probes: [{ live: false, code: "not_live", held: true }], input: { harness: "codex" } });
    expect(await session.run()).toBeNull();
  });

  test.each(["session_ambiguous", "session_runtime_unobserved"] as const)("%s at the probe is refused with nothing typed", async (code) => {
    const session = harness({ probes: [{ live: false, code }] });
    expect((await refusal(session.run)).stage).toBe("in_place_unverified");
    expect(session.typed).toEqual([]);
    expect(session.elapsed()).toBeLessThan(30_000);
  });

  test("one reading that cannot be verified is looked at again, not refused and not resumed", async () => {
    for (const first of [new Error("tmux: timed out"), { live: false, code: "session_runtime_unobserved" } as const]) {
      const session = harness({ probes: [first, live("idle")], replies: [{ state: "answered", text: "done" }] });
      expect((await session.run())?.output).toBe("done");
      expect(session.typed).toHaveLength(1);
    }
    // Unverified, then closed: still two clean readings before the caller continues it.
    const closed = harness({ probes: [new Error("tmux: timed out"), { live: false, code: "not_live", held: false }] });
    expect(await closed.run()).toBeNull();
    expect(closed.probeCount()).toBe(3);
    // The same at the keystroke: the delivery could not verify the place once.
    const atKeystroke = harness({
      probes: [live("idle")],
      deliveries: [{ ok: false, code: "session_runtime_unobserved" }, typedOk],
      replies: [{ state: "answered", text: "done" }],
    });
    expect((await atKeystroke.run())?.output).toBe("done");
    expect(atKeystroke.typed).toHaveLength(1);
    const never = harness({ probes: [live("idle")], deliveries: [{ ok: false, code: "session_ambiguous" }] });
    expect((await refusal(never.run)).stage).toBe("in_place_unverified");
    expect(never.typed).toEqual([]);
  });

  test("a probe that fails is a refusal, never a reason to resume the session", async () => {
    const session = harness({ probes: [new Error("ps: operation not permitted")] });
    const refused = await refusal(session.run);
    expect(refused.stage).toBe("in_place_unverified");
    expect(refused.message).toContain("ps: operation not permitted");
    expect(refused.message).toContain("Nothing was typed");
    expect(session.typed).toEqual([]);
    expect(session.events).toEqual([]);
    expect(session.elapsed()).toBeLessThan(30_000);
  });

  test("a keystroke that throws is refused as a failed delivery that may have landed", async () => {
    const refused = await refusal(() => invokeSessionInPlace(
      { sessionId: SESSION, harness: "claude", label: "app", prompt: "ask inv-1", explicitReplyPrompt: "ask inv-1", marker: "inv-1", wake: false },
      {
        probe: async () => live("idle"),
        deliver: async () => { throw new Error("herdr exited 1"); },
        openReplyReader: async () => null,
        holderState: async () => ({ live: true, idle: false }),
      },
    ));
    expect(refused.stage).toBe("in_place_failed");
    expect(refused.message).toContain("herdr exited 1");
    expect(refused.message).toContain("may have reached the composer");
  });

  test("an ask cancelled while held is never typed", async () => {
    const session = harness({ probes: [live("busy"), live("busy"), live("idle")], cancelAfterProbes: 2 });
    expect(await session.run()).toEqual({ output: "", delivery: null });
    expect(session.typed).toEqual([]);
  });

  test("readings that swing between unseen and not open are refused, never held for good and never resumed", async () => {
    const swing: Array<InPlaceProbe | Error> = [];
    for (let reading = 0; reading < 40; reading += 1) {
      swing.push(reading % 2 === 0 ? new Error("tmux: timed out") : { live: false, code: "not_live", held: false });
    }
    const session = harness({ probes: swing });
    expect((await refusal(session.run)).stage).toBe("in_place_unverified");
    expect(session.elapsed()).toBeLessThan(30_000);
    expect(session.typed).toEqual([]);
  });

  test("an ask cancelled while the delivery finds the place again is never typed", async () => {
    const session = harness({ probes: [live("idle")], cancelDuringDelivery: true });
    expect(await session.run()).toEqual({ output: "", delivery: null });
    expect(session.typed).toEqual([]);
    expect(session.events).toEqual([]);
  });

  test("a session that turns busy between the probe and the keystroke is held again, and typed into once", async () => {
    const session = harness({
      probes: [live("idle"), live("busy"), live("idle")],
      deliveries: [{ ok: false, code: "busy", ...PLACE, detail: "Nothing submitted." }, typedOk],
      replies: [{ state: "answered", text: "done" }],
    });
    expect((await session.run())?.output).toBe("done");
    expect(session.typed).toHaveLength(1);
  });

  test("a failed keystroke is refused and says the words may have landed", async () => {
    const session = harness({ probes: [live("idle")], deliveries: [{ ok: false, code: "in_place_failed", ...PLACE, detail: "pane did not accept the prompt" }] });
    const refused = await refusal(session.run);
    expect(refused.stage).toBe("in_place_failed");
    expect(refused.message).toContain("may have reached the composer");
  });

  test("a Codex thread in an app that cannot be typed into right now goes back to the caller", async () => {
    const app = { via: "scout-app", location: "the ChatGPT app’s Codex" } as const;
    for (const delivery of [
      { ok: false, code: "in_place_failed", ...app, detail: "nothing opened or submitted", nothingSent: true },
      { ok: false, code: "scout_app_unavailable", ...app },
    ] satisfies InPlaceDelivery[]) {
      const session = harness({ probes: [{ live: true, ...app, activity: "idle" }], deliveries: [delivery], input: { harness: "codex" } });
      expect(await session.run()).toBeNull();
    }
  });

  test("a reply the session posts through Scout wins over waiting for the transcript", async () => {
    const session = harness({ probes: [live("idle")], explicit: [null, "posted through Scout"] });
    expect(await session.run()).toMatchObject({ output: "posted through Scout", delivery: { replySource: "scout_reply" } });
  });

  test("with no transcript to read, the typed words ask for a Scout reply", async () => {
    const session = harness({ probes: [live("idle")], transcript: false, explicit: [null, "explicit"] });
    expect((await session.run())?.output).toBe("explicit");
    expect(session.typed).toEqual(["the ask, reply with scout reply. Scout task inv-1"]);
  });

  test("a plain terminal gets the ask on one line", async () => {
    const tty = { via: "lattices", location: "terminal ttys004" } as const;
    const session = harness({
      probes: [{ live: true, ...tty, activity: "idle" }],
      deliveries: [{ ok: true, ...tty }],
      replies: [{ state: "answered", text: "done" }],
    });
    await session.run();
    expect(session.typed).toEqual(["the ask Scout task inv-1"]);
  });

  test("a message that expects no reply returns as soon as it is typed", async () => {
    const session = harness({ probes: [live("idle")], input: { wake: true } });
    expect(await session.run()).toEqual({ output: "", delivery: { ...PLACE, heldMs: 0, replySource: "none" } });
    expect(session.typed).toHaveLength(1);
  });

  test("an interrupted turn fails the ask and says it was typed", async () => {
    const session = harness({ probes: [live("idle")], replies: [{ state: "aborted" }] });
    const refused = await refusal(session.run);
    expect(refused.stage).toBe("in_place_turn_aborted");
    expect(refused.message).toContain("was typed into");
  });

  test("a session closed after the ask was typed fails, but only on two clean readings", async () => {
    const closed = harness({ probes: [live("idle")], holder: [{ live: false, idle: false }] });
    expect((await refusal(closed.run)).stage).toBe("in_place_session_closed");

    const flaky = harness({
      probes: [live("idle")],
      holder: [{ live: false, idle: false }, new Error("ps failed"), { live: true, idle: false }],
      replies: Array.from({ length: 14 }, (): SessionReply => ({ state: "pending", accepted: true })).concat({ state: "answered", text: "still here" }),
    });
    expect((await flaky.run())?.output).toBe("still here");
  });

  test("the answer written just before the session closed is still returned", async () => {
    const session = harness({
      probes: [live("idle")],
      holder: [{ live: false, idle: false }],
      // Eleven polls see nothing; the read made once the session is known
      // closed finds the answer.
      replies: Array.from({ length: 11 }, (): SessionReply => ({ state: "pending", accepted: true })).concat({ state: "answered", text: "last words" }),
    });
    expect((await session.run())?.output).toBe("last words");
  });

  test("no answer within the wait leaves the task open as still working", async () => {
    const session = harness({ probes: [live("idle")], input: { replyWaitMs: 30_000 } });
    try {
      await session.run();
      throw new Error("expected a wait timeout");
    } catch (error) {
      expect(isRequesterWaitTimeoutError(error)).toBe(true);
    }
    expect(session.typed).toHaveLength(1);
  });
});

describe("a delivery keeps its place on the task", () => {
  test("held is recorded once, and typing is recorded before the first keystroke", async () => {
    const session = harness({ probes: [live("busy"), live("busy"), live("idle")], replies: [{ state: "answered", text: "Done." }] });
    await session.run();
    expect(session.events).toEqual(["held", "typing", "keystroke", "typed"]);
    expect(session.saved).toEqual([
      { phase: "held", since: 0 },
      { phase: "typing", since: 0, at: 4_000, ...PLACE, transcriptOffset: 4_096 },
      { phase: "typed", since: 0, at: 4_000, ...PLACE, transcriptOffset: 4_096 },
    ]);
  });

  test("an idle session is never recorded as held, and a session that answers through Scout has no transcript offset", async () => {
    const session = harness({ probes: [live("idle")], transcript: false, explicit: ["Posted."] });
    await session.run();
    expect(session.events).toEqual(["typing", "keystroke", "typed"]);
    expect(session.saved[0]).toEqual({ phase: "typing", since: 0, at: 0, ...PLACE, transcriptOffset: null });
  });

  test("when typing cannot be recorded, nothing is typed", async () => {
    const session = harness({ probes: [live("idle")], failSave: (checkpoint) => checkpoint?.phase === "typing" });
    const refused = await refusal(session.run);
    expect(refused.stage).toBe("in_place_failed");
    expect(refused.message).toContain("journal unavailable");
    expect(refused.message).toContain("Nothing was typed.");
    expect(session.typed).toEqual([]);
  });

  test("losing the typed or the held record does not fail the delivery", async () => {
    const session = harness({
      probes: [live("busy"), live("idle")],
      replies: [{ state: "answered", text: "Done." }],
      failSave: (checkpoint) => checkpoint?.phase !== "typing",
    });
    expect((await session.run())?.output).toBe("Done.");
    // What is left says typing, which a restart treats as typed.
    expect(session.events).toEqual(["typing", "keystroke"]);
  });

  test("a session that closed while the task was held clears the record before Scout continues it itself", async () => {
    const session = harness({ probes: [live("busy"), { live: false, code: "not_live", held: false }] });
    expect(await session.run()).toBeNull();
    expect(session.events).toEqual(["held", "cleared"]);
    // Never held: there is nothing to clear.
    const closed = harness({ probes: [{ live: false, code: "not_live", held: false }] });
    expect(await closed.run()).toBeNull();
    expect(closed.events).toEqual([]);
  });

  test("when the record cannot be cleared, Scout does not continue the session itself", async () => {
    const session = harness({
      probes: [live("busy"), { live: false, code: "not_live", held: false }],
      failSave: (checkpoint) => checkpoint === null,
    });
    const refused = await refusal(session.run);
    expect(refused.stage).toBe("in_place_failed");
    expect(refused.message).toContain("Nothing was typed.");
  });
});

describe("a delivery picked up after the runtime restarted", () => {
  const MINUTE = 60_000;
  const typedAt = (phase: "typing" | "typed", offset: number | null = 777): InPlaceCheckpoint =>
    ({ phase, since: 1_000, at: 5_000, ...PLACE, transcriptOffset: offset });

  test("a held task is delivered from the start, and is not recorded as held again", async () => {
    const session = harness({
      checkpoint: { phase: "held", since: 1_000 },
      clock: 61_000,
      probes: [live("busy"), live("idle")],
      replies: [{ state: "answered", text: "Done." }],
    });
    expect(await session.run()).toEqual({ output: "Done.", delivery: { ...PLACE, heldMs: 62_000, replySource: "transcript" } });
    expect(session.typed).toHaveLength(1);
    expect(session.events).toEqual(["typing", "keystroke", "typed"]);
    // The hold is reported again: the restart replaced the task's summary.
    expect(session.progress[0]).toContain("The task is held until the turn ends.");
  });

  test("the hold is one budget across restarts", async () => {
    const session = harness({ checkpoint: { phase: "held", since: 1_000 }, clock: 1_000 + 20 * MINUTE, probes: [live("busy")] });
    expect((await refusal(session.run)).stage).toBe("in_place_hold_expired");
    expect(session.elapsed()).toBe(10 * MINUTE);
    expect(session.typed).toEqual([]);
  });

  test("a held task whose session closed in the meantime is handed to Scout's own path, record cleared", async () => {
    const session = harness({ checkpoint: { phase: "held", since: 1_000 }, clock: 61_000, probes: [{ live: false, code: "not_live", held: false }] });
    expect(await session.run()).toBeNull();
    expect(session.events).toEqual(["cleared"]);
  });

  test("a typed task is never typed again: the answer is read from where the first reader started", async () => {
    const session = harness({
      checkpoint: typedAt("typed"),
      clock: 61_000,
      probes: [live("idle")],
      replies: [{ state: "pending", accepted: true }, { state: "answered", text: "It passes." }],
    });
    expect(await session.run()).toEqual({ output: "It passes.", delivery: { ...PLACE, heldMs: 4_000, replySource: "transcript" } });
    expect(session.typed).toEqual([]);
    expect(session.probeCount()).toBe(0);
    expect(session.readFrom).toEqual([777]);
    expect(session.events).toEqual([]);
    expect(session.progress).toEqual(["Delivered to app:0199aaaa in Herdr work · w1:p2. Waiting for its reply."]);
  });

  test("a typed task with no transcript offset waits for the reply the session posts through Scout", async () => {
    const session = harness({ checkpoint: typedAt("typed", null), clock: 61_000, probes: [live("idle")], explicit: [null, "Posted."] });
    expect(await session.run()).toMatchObject({ output: "Posted.", delivery: { replySource: "scout_reply" } });
    expect(session.typed).toEqual([]);
    expect(session.readFrom).toEqual([]);
  });

  test("the reply wait counts from when the words were typed", async () => {
    const session = harness({ checkpoint: typedAt("typed"), clock: 5_000 + 2 * 60 * MINUTE, probes: [live("idle")] });
    try {
      await session.run();
      throw new Error("expected the wait to have run out");
    } catch (error) {
      expect(isRequesterWaitTimeoutError(error)).toBe(true);
    }
    expect(session.elapsed()).toBe(0);
    expect(session.typed).toEqual([]);
  });

  test("a typed task whose session was closed before it answered is refused by name", async () => {
    const session = harness({
      checkpoint: typedAt("typed"),
      clock: 61_000,
      probes: [live("idle")],
      replies: [{ state: "pending", accepted: true }],
      holder: [{ live: false, idle: false }],
    });
    expect((await refusal(session.run)).stage).toBe("in_place_session_closed");
    expect(session.typed).toEqual([]);
  });

  test("interrupted mid-keystroke: a transcript that recorded the words is watched like any typed task", async () => {
    const session = harness({
      checkpoint: typedAt("typing"),
      clock: 61_000,
      probes: [live("idle")],
      replies: [{ state: "pending", accepted: true }, { state: "answered", text: "It landed." }],
      holder: [{ live: true, idle: true }],
    });
    expect((await session.run())?.output).toBe("It landed.");
    expect(session.typed).toEqual([]);
  });

  test("interrupted mid-keystroke: an idle session that never recorded the words is refused, and nothing is typed", async () => {
    const session = harness({
      checkpoint: typedAt("typing"),
      clock: 61_000,
      probes: [live("idle")],
      replies: [{ state: "pending", accepted: false }],
      holder: [{ live: true, idle: true }],
    });
    const refused = await refusal(session.run);
    expect(refused.stage).toBe("in_place_failed");
    expect(refused.message).toContain("They may be in the composer");
    expect(session.elapsed()).toBe(15_000);
    expect(session.typed).toEqual([]);
    expect(session.probeCount()).toBe(0);
  });

  test("interrupted mid-keystroke: a session still mid-turn is not refused while its transcript is silent", async () => {
    const session = harness({
      checkpoint: typedAt("typing"),
      clock: 61_000,
      probes: [live("idle")],
      replies: [
        ...Array.from({ length: 40 }, (): SessionReply => ({ state: "pending", accepted: false })),
        { state: "pending", accepted: true },
        { state: "answered", text: "Queued behind a turn, then answered." },
      ],
      holder: [{ live: true, idle: false }],
    });
    expect((await session.run())?.output).toBe("Queued behind a turn, then answered.");
  });

  test("a message that expects no reply is done once typed, and is refused when the keystroke was interrupted", async () => {
    const done = harness({ checkpoint: typedAt("typed"), clock: 61_000, probes: [live("idle")], input: { wake: true } });
    expect(await done.run()).toEqual({ output: "", delivery: { ...PLACE, heldMs: 4_000, replySource: "none" } });
    expect(done.typed).toEqual([]);

    const interrupted = harness({ checkpoint: typedAt("typing"), clock: 61_000, probes: [live("idle")], input: { wake: true } });
    const refused = await refusal(interrupted.run);
    expect(refused.stage).toBe("in_place_failed");
    expect(refused.message).toContain("may have reached the composer");
    expect(interrupted.typed).toEqual([]);
  });
});
