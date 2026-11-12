import { describe, expect, test } from "bun:test";

import type { ClaudeSessionRecord } from "../claude-session-records.js";

import { findClaudeSessionOutsideScout, probeInPlace, probeInPlaceConfirmed, type DeliverInPlaceDeps, type InPlaceProbe } from "./deliver.js";

const SESSION = "4cc36bba-a893-461f-a5b1-79c1f6b7e088";

function claudeRecord(overrides: Partial<ClaudeSessionRecord> = {}): ClaudeSessionRecord {
  return {
    pid: 77085,
    sessionId: SESSION,
    cwd: "/work/app",
    startedAt: null,
    procStart: null,
    kind: "interactive",
    entrypoint: "cli",
    version: null,
    tmux: null,
    name: "task",
    nameSource: null,
    recordPath: "/tmp/77085.json",
    ...overrides,
  };
}

/** Deps that find nothing and fail loudly if anything types. */
function noHosts(overrides: Partial<DeliverInPlaceDeps> = {}): DeliverInPlaceDeps {
  const never = async () => { throw new Error("a probe must not type"); };
  return {
    findHerdrPane: async () => null,
    findClaudeRecord: async () => null,
    codexThreadPids: async () => [],
    locateProcess: async () => null,
    self: [],
    selfTty: async () => null,
    readOrcaAgents: async () => [],
    promptHerdr: never,
    promptOrca: never,
    promptTmux: never,
    tmuxComposerDraft: async () => null,
    scoutLaunchedTmuxSessions: async () => new Set<string>(),
    ttyForPid: async () => null,
    typeIntoTty: never,
    typeIntoCodexApp: never,
    draftCodexApp: never,
    codexHeldByApp: async () => false,
    codexActivity: async () => "unknown",
    order: ["herdr", "orca", "tmux", "terminal"],
    ...overrides,
  };
}

const herdrPane = (status: string | null) => ({ session: "work", paneId: "w1:p2", status, harness: "claude", sessionKind: "id" });

describe("probeInPlace", () => {
  test("a session no process holds is not live and not held", async () => {
    expect(await probeInPlace({ sessionId: SESSION, harness: "claude" }, noHosts()))
      .toEqual({ live: false, code: "not_live", held: false });
  });

  test.each([
    ["working", "busy"],
    ["blocked", "blocked"],
    ["idle", "idle"],
    ["done", "idle"],
  ] as const)("a Herdr pane reporting %s reads as %s", async (status, activity) => {
    const probe = await probeInPlace({ sessionId: SESSION, harness: "claude" }, noHosts({ findHerdrPane: async () => herdrPane(status) }));
    expect(probe).toEqual({ live: true, via: "herdr", location: "Herdr work · w1:p2", activity });
  });

  test("when Herdr has no status, Claude's own record decides", async () => {
    const deps = (status: ClaudeSessionRecord["status"]) => noHosts({
      findHerdrPane: async () => herdrPane("unknown"),
      findClaudeRecord: async () => claudeRecord({ status }),
    });
    expect(await probeInPlace({ sessionId: SESSION, harness: "claude" }, deps("busy"))).toMatchObject({ live: true, activity: "busy" });
    expect(await probeInPlace({ sessionId: SESSION, harness: "claude" }, deps("waiting"))).toMatchObject({ live: true, activity: "blocked" });
    expect(await probeInPlace({ sessionId: SESSION, harness: "claude" }, deps("idle"))).toMatchObject({ live: true, activity: "idle" });
    // A finished turn with a background shell still running has a free prompt.
    expect(await probeInPlace({ sessionId: SESSION, harness: "claude" }, deps("shell"))).toMatchObject({ live: true, activity: "idle" });
    expect(await probeInPlace({ sessionId: SESSION, harness: "claude" }, deps(null))).toMatchObject({ live: true, activity: "unknown" });
  });

  test("a Claude session in a tmux pane is found through its own record", async () => {
    const probe = await probeInPlace({ sessionId: SESSION, harness: "claude" }, noHosts({
      findClaudeRecord: async () => claudeRecord({ status: "idle", tmux: { session: "main", window: "@1", pane: "%4" } as ClaudeSessionRecord["tmux"] }),
    }));
    expect(probe).toMatchObject({ live: true, via: "tmux", activity: "idle" });
  });

  test("unsent text in a tmux composer reads as composing, and is looked for only at a free prompt", async () => {
    const tmux = { session: "main", window: "@1", pane: "%4" } as ClaudeSessionRecord["tmux"];
    const reads: string[] = [];
    const deps = (status: string, draft: string | null) => noHosts({
      findClaudeRecord: async () => claudeRecord({ status, tmux }),
      tmuxComposerDraft: async (target) => { reads.push(target); return draft; },
    });
    expect(await probeInPlace({ sessionId: SESSION, harness: "claude" }, deps("idle", "half a thought")))
      .toMatchObject({ live: true, via: "tmux", activity: "composing" });
    expect(await probeInPlace({ sessionId: SESSION, harness: "claude" }, deps("idle", null))).toMatchObject({ activity: "idle" });
    expect(reads).toEqual(["%4", "%4"]);
    expect(await probeInPlace({ sessionId: SESSION, harness: "claude" }, deps("busy", "queued words"))).toMatchObject({ activity: "busy" });
    expect(reads).toHaveLength(2);
  });

  test("a composer that cannot be read does not hold the session", async () => {
    const probe = await probeInPlace({ sessionId: SESSION, harness: "claude" }, noHosts({
      findClaudeRecord: async () => claudeRecord({ status: "idle", tmux: { session: "main", window: "@1", pane: "%4" } as ClaudeSessionRecord["tmux"] }),
      tmuxComposerDraft: async () => { throw new Error("no server running"); },
    }));
    expect(probe).toMatchObject({ live: true, activity: "idle" });
  });

  test("a session Scout once continued is a place again where the operator reopens it", async () => {
    // Claude Code keeps the name Scout launched it under.
    const probe = await probeInPlace({ sessionId: SESSION, harness: "claude" }, noHosts({
      findClaudeRecord: async () => claudeRecord({
        status: "idle",
        name: `flat-claude-${SESSION}-relay-agent`,
        tmux: { session: "main", window: "@1", pane: "%4" } as ClaudeSessionRecord["tmux"],
      }),
    }));
    expect(probe).toMatchObject({ live: true, via: "tmux", location: "tmux main · %4", activity: "idle" });
  });

  test("a tmux session Scout launched is not a place, whatever it is called", async () => {
    const probe = await probeInPlace({ sessionId: SESSION, harness: "claude" }, noHosts({
      findClaudeRecord: async () => claudeRecord({ status: "idle", tmux: { session: "relay-app-claude", window: "@1", pane: "%1" } as ClaudeSessionRecord["tmux"] }),
      scoutLaunchedTmuxSessions: async () => new Set(["relay-app-claude"]),
    }));
    expect(probe).toEqual({ live: false, code: "not_live", held: false });
  });

  test("Scout's own background copy is not a place", async () => {
    const probe = await probeInPlace({ sessionId: SESSION, harness: "claude" }, noHosts({
      findClaudeRecord: async () => claudeRecord({ tmux: { session: `flat-claude-${SESSION}`, window: "@1", pane: "%1" } as ClaudeSessionRecord["tmux"] }),
    }));
    expect(probe).toEqual({ live: false, code: "not_live", held: false });
  });

  test("the caller's own pane is never offered, and the session still reads as held", async () => {
    const probe = await probeInPlace({ sessionId: SESSION, harness: "claude" }, noHosts({
      findClaudeRecord: async () => claudeRecord({ status: "idle" }),
      locateProcess: async () => ({ host: "herdr", session: "work", paneId: "w1:p2" }),
      self: [{ host: "herdr", session: "work", paneId: "w1:p2" }],
    }));
    expect(probe).toEqual({ live: false, code: "not_live", held: true });
  });

  test("a Claude session with no pane and no terminal is held but out of reach", async () => {
    const probe = await probeInPlace({ sessionId: SESSION, harness: "claude" }, noHosts({
      findClaudeRecord: async () => claudeRecord({ status: "idle" }),
    }));
    expect(probe).toEqual({ live: false, code: "not_live", held: true });
  });

  test("a Claude process whose pane could not be shown to hold it is held, and neither its pane nor its terminal is offered", async () => {
    const probe = await probeInPlace({ sessionId: SESSION, harness: "claude", requireExactHarness: true }, noHosts({
      findClaudeRecord: async () => claudeRecord({
        status: "idle",
        paneUnverified: true,
        tmux: { session: "main", window: "@1", pane: "%4" } as ClaudeSessionRecord["tmux"],
      }),
      ttyForPid: async () => "ttys004",
    }));
    expect(probe).toEqual({ live: false, code: "not_live", held: true });
  });

  test("a Claude record that cannot be read is not a closed session", async () => {
    const failing = noHosts({ findClaudeRecord: async () => { throw new Error("tmux list-panes timed out"); } });
    // The caller that would resume the session is told it could not be seen.
    expect(await probeInPlace({ sessionId: SESSION, harness: "claude", requireExactHarness: true }, failing))
      .toEqual({ live: false, code: "session_runtime_unobserved" });
    // A caller that only looks for a place to type finds none.
    expect(await probeInPlace({ sessionId: SESSION, harness: "claude" }, failing))
      .toEqual({ live: false, code: "not_live", held: false });
  });

  test("a Claude session in a plain terminal tab is reachable by its tty", async () => {
    const probe = await probeInPlace({ sessionId: SESSION, harness: "claude" }, noHosts({
      findClaudeRecord: async () => claudeRecord({ status: "busy" }),
      ttyForPid: async () => "ttys004",
    }));
    expect(probe).toEqual({ live: true, via: "lattices", location: "terminal ttys004", activity: "busy" });
  });

  test("a Codex thread in a terminal pane takes its activity from the transcript", async () => {
    const probe = await probeInPlace({ sessionId: SESSION, harness: "codex" }, noHosts({
      codexThreadPids: async () => [4242],
      locateProcess: async () => ({ host: "herdr", session: "work", paneId: "w2:p1" }),
      codexActivity: async () => "busy",
    }));
    expect(probe).toEqual({ live: true, via: "herdr", location: "Herdr work · w2:p1", activity: "busy" });
  });

  test("a Codex thread held by the ChatGPT app is live there", async () => {
    const probe = await probeInPlace({ sessionId: SESSION, harness: "codex" }, noHosts({
      codexHeldByApp: async () => true,
      codexActivity: async () => "idle",
    }));
    expect(probe).toMatchObject({ live: true, via: "scout-app", activity: "idle" });
  });

  test("a Codex thread in a terminal Scout cannot address is held, not live", async () => {
    const probe = await probeInPlace({ sessionId: SESSION, harness: "codex" }, noHosts({ codexThreadPids: async () => [4242] }));
    expect(probe).toEqual({ live: false, code: "not_live", held: true });
  });

  test("the holder outside Scout passes over Scout's own copies of the session", async () => {
    const tmux = (session: string) => ({ session, window: "@1", pane: "%1" }) as ClaudeSessionRecord["tmux"];
    const records = [
      claudeRecord({ pid: 1, tmux: tmux(`flat-claude-${SESSION}`) }),
      claudeRecord({ pid: 2, tmux: tmux("relay-app-claude") }),
      claudeRecord({ pid: 3, status: "busy", tmux: tmux("main") }),
    ];
    const find = (held: ClaudeSessionRecord[]) => findClaudeSessionOutsideScout(SESSION, {
      scoutLaunchedTmuxSessions: async () => new Set(["relay-app-claude"]),
      find: async (_sessionId, options) => held.find((record) => !options.skip(record)) ?? null,
    });
    expect((await find(records))?.pid).toBe(3);
    expect(await find(records.slice(0, 2))).toBeNull();
  });

  test("with an exact harness required, an ambiguous or mismatched Herdr report is refused", async () => {
    const strict = { sessionId: SESSION, harness: "claude", requireExactHarness: true };
    expect(await probeInPlace(strict, noHosts({ findHerdrPane: async () => { throw new Error("session_ambiguous: two panes"); } })))
      .toEqual({ live: false, code: "session_ambiguous" });
    expect(await probeInPlace(strict, noHosts({ findHerdrPane: async () => ({ ...herdrPane("idle"), harness: "codex" }) })))
      .toEqual({ live: false, code: "session_runtime_unobserved" });
  });
});

describe("probeInPlaceConfirmed", () => {
  const notOpen: InPlaceProbe = { live: false, code: "not_live", held: false };
  const unseen: InPlaceProbe = { live: false, code: "session_runtime_unobserved" };
  const open: InPlaceProbe = { live: true, via: "tmux", location: "tmux main", activity: "idle" };
  const scripted = (readings: Array<InPlaceProbe | Error>, harness = "claude") => {
    let count = 0;
    const result = probeInPlaceConfirmed({ sessionId: SESSION, harness, requireExactHarness: true }, {}, {
      sleep: async () => undefined,
      probe: async () => {
        const reading = readings[Math.min(count++, readings.length - 1)]!;
        if (reading instanceof Error) throw reading;
        return reading;
      },
    });
    return { result, count: () => count };
  };

  test("a Claude session is not open only on two readings in a row", async () => {
    const closed = scripted([notOpen]);
    expect(await closed.result).toEqual(notOpen);
    expect(closed.count()).toBe(2);
    // The first reading caught the record half written.
    expect(await scripted([notOpen, open]).result).toEqual(open);
    expect(await scripted([notOpen, { ...notOpen, held: true }]).result).toEqual({ ...notOpen, held: true });
  });

  test("a Codex thread is taken at its first reading: its own lock guards it", async () => {
    const codex = scripted([notOpen], "codex");
    expect(await codex.result).toEqual(notOpen);
    expect(codex.count()).toBe(1);
  });

  test("a reading that could not see the session is taken again, and never turns into not open", async () => {
    expect(await scripted([new Error("tmux timed out"), open]).result).toEqual(open);
    expect(await scripted([unseen, open]).result).toEqual(open);
    expect(await scripted([unseen]).result).toEqual(unseen);
    // Unseen twice and then one "not open": not established.
    expect(await scripted([unseen, unseen, notOpen]).result).toEqual(unseen);
    expect(await scripted([new Error("tmux timed out"), notOpen, notOpen]).result).toEqual(notOpen);
    await expect(scripted([new Error("tmux timed out")]).result).rejects.toThrow("tmux timed out");
  });
});
