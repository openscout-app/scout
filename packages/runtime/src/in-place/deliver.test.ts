import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ClaudeSessionRecord } from "../claude-session-records.js";

import { codexActivityFromRollout, codexActivityFromTranscript, deliverInPlace, probeInPlace, resolveInPlaceOrder, type DeliverInPlaceDeps } from "./deliver.js";
import { parseOrcaWorktreeAgents } from "./orca.js";
import { innermostProcessHost, parseProcessHostEnv, processHostLocations } from "./process-host.js";

const SESSION = "4cc36bba-a893-461f-a5b1-79c1f6b7e088";

test("strict session input refuses wrong or unobserved Herdr harness identity before any prompt", async () => {
  let prompts = 0;
  for (const observation of [{ harness: "claude", sessionKind: "id" }, { harness: "codex", sessionKind: "name" }, {}]) {
    const result = await deliverInPlace({ sessionId: SESSION, harness: "codex", body: "input", requireExactHarness: true }, noHosts({
      findHerdrPane: async (_sessionId, harness) => {
        expect(harness).toBe("codex");
        return { session: "herdr", paneId: "p1", status: "idle", ...observation };
      },
      promptHerdr: async () => { prompts++; },
    }));
    expect(result).toEqual({ ok: false, code: "session_runtime_unobserved" });
  }
  expect(prompts).toBe(0);
});

test("strict session input accepts a correlated Herdr native id and harness, and refuses ambiguous observations", async () => {
  let prompts = 0;
  const input = { sessionId: SESSION, harness: "codex", body: "input", requireExactHarness: true };
  const result = await deliverInPlace(input, noHosts({
    findHerdrPane: async () => ({ session: "herdr", paneId: "p1", status: "idle", harness: "codex", sessionKind: "id" }),
    promptHerdr: async () => { prompts++; },
  }));
  expect(result).toMatchObject({ ok: true, via: "herdr" });
  expect(prompts).toBe(1);
  expect(await deliverInPlace(input, noHosts({ findHerdrPane: async () => { throw new Error("session_ambiguous: two panes"); } })))
    .toEqual({ ok: false, code: "session_ambiguous" });
  expect(await deliverInPlace(input, noHosts({ findHerdrPane: async () => { throw new Error("probe timed out"); } })))
    .toEqual({ ok: false, code: "session_runtime_unobserved" });
});

test("a Claude record that cannot be read, or a pane that cannot be shown to hold it, is never typed into", async () => {
  const strict = { sessionId: SESSION, harness: "claude", body: "input", requireExactHarness: true };
  expect(await deliverInPlace(strict, noHosts({ findClaudeRecord: async () => { throw new Error("ps timed out"); } })))
    .toEqual({ ok: false, code: "session_runtime_unobserved" });
  const unverified = noHosts({
    findClaudeRecord: async () => claudeRecord({ status: "idle", paneUnverified: true, tmux: { session: "work", pane: "%3" } as ClaudeSessionRecord["tmux"] }),
    ttyForPid: async () => "ttys004",
  });
  expect(await deliverInPlace(strict, unverified)).toEqual({ ok: false, code: "not_live" });
});

describe("codexActivityFromRollout", () => {
  let folder: string | null = null;
  afterEach(async () => {
    if (folder) await rm(folder, { recursive: true, force: true });
    folder = null;
  });
  const row = (type: string) => `${JSON.stringify({ type: "event_msg", payload: { type } })}\n`;

  test("each reading takes in only what the rollout gained, and a line still being written is not idle", async () => {
    folder = await mkdtemp(join(tmpdir(), "scout-codex-activity-"));
    const path = join(folder, "rollout.jsonl");
    await writeFile(path, row("task_started") + row("task_complete"));
    expect(await codexActivityFromRollout(path)).toBe("idle");
    expect(await codexActivityFromRollout(path)).toBe("idle");

    // The start of the next turn, half written.
    const started = row("task_started");
    await appendFile(path, started.slice(0, 20));
    expect(await codexActivityFromRollout(path)).toBe("unknown");
    await appendFile(path, started.slice(20));
    expect(await codexActivityFromRollout(path)).toBe("busy");

    await appendFile(path, "not json\n");
    expect(await codexActivityFromRollout(path)).toBe("unknown");
    await appendFile(path, row("turn_aborted"));
    expect(await codexActivityFromRollout(path)).toBe("idle");

    await rm(path);
    expect(await codexActivityFromRollout(path)).toBe("unknown");
  });

  test("two probes at once leave the next reading right", async () => {
    folder = await mkdtemp(join(tmpdir(), "scout-codex-activity-"));
    const path = join(folder, "rollout.jsonl");
    await writeFile(path, row("task_started") + row("task_complete"));
    expect(await Promise.all([codexActivityFromRollout(path), codexActivityFromRollout(path)])).toEqual(["idle", "idle"]);
    await appendFile(path, row("task_started"));
    expect(await codexActivityFromRollout(path)).toBe("busy");
  });

  test("a rollout that was replaced is read from its start", async () => {
    folder = await mkdtemp(join(tmpdir(), "scout-codex-activity-"));
    const path = join(folder, "rollout.jsonl");
    await writeFile(path, row("task_started") + row("task_complete") + row("task_started"));
    expect(await codexActivityFromRollout(path)).toBe("busy");
    await writeFile(path, row("task_started") + row("task_complete"));
    expect(await codexActivityFromRollout(path)).toBe("idle");
  });
});

function claudeRecord(overrides: Partial<ClaudeSessionRecord> = {}): ClaudeSessionRecord {
  return {
    pid: 77085,
    sessionId: SESSION,
    cwd: "/Users/me/orca/workspaces/app/task",
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
  const never = async () => { throw new Error("must not type here"); };
  return {
    findHerdrPane: async () => null,
    findClaudeRecord: async () => null,
    codexThreadPids: async () => [],
    locateProcess: async () => null,
    self: [],
    selfTty: async () => null,
    readOrcaAgents: async () => [],
    composerEmpty: async () => true,
    promptHerdr: never,
    promptOrca: never,
    promptTmux: never,
    tmuxComposerDraft: async () => null,
    scoutLaunchedTmuxSessions: async () => new Set<string>(),
    ttyForPid: async () => null,
    typeIntoTty: never,
    codexHeldByApp: async () => false,
    askClaudeChannel: async () => ({ ok: false, code: "channel_unavailable", message: "no channel" }),
    order: ["herdr", "orca", "tmux", "terminal"],
    ...overrides,
  };
}

describe("parseProcessHostEnv", () => {
  test("reads host variables from ps -E output and ignores the rest", () => {
    const env = parseProcessHostEnv(
      "claude --resume x HOME=/Users/me ORCA_TERMINAL_HANDLE=term_1 ORCA_PANE_KEY=a:b HERDR_SESSION=scout HERDR_PANE_ID=w1:p2 SECRET=nope",
    );
    expect(env).toEqual({ ORCA_TERMINAL_HANDLE: "term_1", ORCA_PANE_KEY: "a:b", HERDR_SESSION: "scout", HERDR_PANE_ID: "w1:p2" });
  });

  test("reads a NUL-separated /proc environ", () => {
    expect(parseProcessHostEnv("HERDR_SESSION=fab\0HERDR_PANE_ID=w2:p2\0PATH=/bin\0"))
      .toEqual({ HERDR_SESSION: "fab", HERDR_PANE_ID: "w2:p2" });
  });

  test("a Herdr pane needs both its session and its pane id", () => {
    expect(processHostLocations({ HERDR_SESSION: "fab" })).toEqual([]);
    expect(processHostLocations({ HERDR_SESSION: "fab", HERDR_PANE_ID: "w2:p2" }))
      .toEqual([{ host: "herdr", session: "fab", paneId: "w2:p2" }]);
  });
});

describe("innermostProcessHost", () => {
  // The case that typed into the sender's own pane: Orca launched from a
  // Herdr shell, so its agents inherit HERDR_* alongside their own ORCA_*.
  const orcaInsideHerdr = parseProcessHostEnv(
    "claude TERM_PROGRAM=Orca ORCA_TERMINAL_HANDLE=term_66 ORCA_PANE_KEY=a:b HERDR_SESSION=scout HERDR_PANE_ID=w1:p1",
  );

  test("TERM_PROGRAM picks the host that spawned the process over inherited ones", () => {
    expect(innermostProcessHost(orcaInsideHerdr)).toEqual({ host: "orca", terminalHandle: "term_66", paneKey: "a:b", worktreeId: null });
    expect(innermostProcessHost({ ...orcaInsideHerdr, TERM_PROGRAM: "herdr" })).toEqual({ host: "herdr", session: "scout", paneId: "w1:p1" });
  });

  test("a plain terminal holding inherited host variables is no host", () => {
    expect(innermostProcessHost({ ...orcaInsideHerdr, TERM_PROGRAM: "ghostty" })).toBeNull();
    expect(innermostProcessHost({ HERDR_SESSION: "scout", HERDR_PANE_ID: "w1:p1" })).toBeNull();
  });
});

describe("resolveInPlaceOrder", () => {
  test("defaults to herdr, orca, tmux, channel, terminal", () => {
    expect(resolveInPlaceOrder({})).toEqual(["herdr", "orca", "tmux", "channel", "terminal"]);
  });

  test("a partial override moves named hosts first and keeps the rest", () => {
    expect(resolveInPlaceOrder({ OPENSCOUT_IN_PLACE_ORDER: "orca, bogus" })).toEqual(["orca", "herdr", "tmux", "channel", "terminal"]);
    expect(resolveInPlaceOrder({ OPENSCOUT_IN_PLACE_ORDER: "lattices,tmux" })).toEqual(["terminal", "tmux", "herdr", "orca", "channel"]);
  });
});

describe("parseOrcaWorktreeAgents", () => {
  test("flattens worktree ps into agents with their pane keys", () => {
    const agents = parseOrcaWorktreeAgents({
      worktrees: [{
        worktreeId: "repo::/w/task",
        path: "/w/task",
        agents: [{ paneKey: "a:b", agentType: "claude", state: "blocked", lastAssistantMessage: "ok?" }, { paneKey: "c:d", state: "strange" }],
      }],
    });
    expect(agents).toEqual([
      { paneKey: "a:b", agentType: "claude", state: "blocked", worktreeId: "repo::/w/task", worktreePath: "/w/task", lastAssistantMessage: "ok?" },
      { paneKey: "c:d", agentType: null, state: "unknown", worktreeId: "repo::/w/task", worktreePath: "/w/task", lastAssistantMessage: null },
    ]);
  });
});

describe("deliverInPlace", () => {
  test("types into the Orca terminal its process environment names", async () => {
    const sent: Array<[string, string]> = [];
    const result = await deliverInPlace({ sessionId: SESSION, harness: "claude", body: "next step" }, noHosts({
      findClaudeRecord: async () => claudeRecord(),
      locateProcess: async (pid) => pid === 77085
        ? { host: "orca", terminalHandle: "term_66", paneKey: "a:b", worktreeId: "repo::/w/task" }
        : null,
      readOrcaAgents: async () => [{ paneKey: "a:b", agentType: "claude", state: "done", worktreeId: "repo::/w/task", worktreePath: "/Users/me/orca/workspaces/app/task", lastAssistantMessage: null }],
      promptOrca: async (handle, body) => { sent.push([handle, body]); },
    }));
    expect(result).toEqual({ ok: true, via: "orca", location: "Orca app/task · term_66" });
    expect(sent).toEqual([["term_66", "next step"]]);
  });

  test("an Orca agent waiting on a question is blocked, not typed over", async () => {
    const result = await deliverInPlace({ sessionId: SESSION, harness: "claude", body: "hi" }, noHosts({
      findClaudeRecord: async () => claudeRecord(),
      locateProcess: async () => ({ host: "orca", terminalHandle: "term_66", paneKey: "a:b", worktreeId: null }),
      readOrcaAgents: async () => [{ paneKey: "a:b", agentType: "claude", state: "waiting", worktreeId: "r::/w", worktreePath: "/w", lastAssistantMessage: null }],
    }));
    expect(result).toMatchObject({ ok: false, code: "session_blocked", via: "orca" });
  });

  test("finds a Herdr pane from the process when Herdr reports no session id", async () => {
    const prompted: string[] = [];
    const result = await deliverInPlace({ sessionId: SESSION, harness: "claude", body: "go" }, noHosts({
      findClaudeRecord: async () => claudeRecord(),
      locateProcess: async () => ({ host: "herdr", session: "fab", paneId: "w2:p2" }),
      promptHerdr: async (match) => { prompted.push(`${match.session}/${match.paneId}`); },
    }));
    expect(result).toEqual({ ok: true, via: "herdr", location: "Herdr fab · w2:p2" });
    expect(prompted).toEqual(["fab/w2:p2"]);
  });

  test("a Codex thread in an Orca terminal is found through its lock holder", async () => {
    const result = await deliverInPlace({ sessionId: SESSION, harness: "codex", body: "go" }, noHosts({
      codexThreadPids: async () => [4242],
      locateProcess: async (pid) => pid === 4242 ? { host: "orca", terminalHandle: "term_cx", paneKey: null, worktreeId: null } : null,
      promptOrca: async () => {},
    }));
    expect(result).toEqual({ ok: true, via: "orca", location: "Orca term_cx" });
  });

  test("the order decides between two hosts that both hold the session", async () => {
    const deps = (order: DeliverInPlaceDeps["order"]) => noHosts({
      findClaudeRecord: async () => claudeRecord({ tmux: { session: "work", pane: "%3" } as ClaudeSessionRecord["tmux"] }),
      locateProcess: async () => ({ host: "herdr", session: "fab", paneId: "w1:p1" }),
      promptHerdr: async () => {},
      promptTmux: async () => {},
      order,
    });
    expect((await deliverInPlace({ sessionId: SESSION, harness: "claude", body: "x" }, deps(["herdr", "orca", "tmux", "terminal"]))))
      .toMatchObject({ ok: true, via: "herdr" });
    expect((await deliverInPlace({ sessionId: SESSION, harness: "claude", body: "x" }, deps(["tmux", "herdr", "orca", "terminal"]))))
      .toMatchObject({ ok: true, via: "tmux", location: "tmux work · %3" });
  });

  test("a tmux composer holding unsent text is not typed into", async () => {
    const typed: string[] = [];
    const result = await deliverInPlace({ sessionId: SESSION, harness: "claude", body: "x" }, noHosts({
      findClaudeRecord: async () => claudeRecord({ tmux: { session: "work", pane: "%3" } as ClaudeSessionRecord["tmux"] }),
      tmuxComposerDraft: async () => "half a thought",
      promptTmux: async (_target, body) => { typed.push(body); },
    }));
    expect(result).toEqual({
      ok: false,
      code: "busy",
      via: "tmux",
      location: "tmux work · %3",
      detail: "The composer holds unsent text. Nothing was typed.",
    });
    expect(typed).toEqual([]);
  });

  test("the caller is told just before the first keystroke, and only when every check has passed", async () => {
    const events: string[] = [];
    const tmuxPane = (overrides: Partial<DeliverInPlaceDeps> = {}) => noHosts({
      findClaudeRecord: async () => claudeRecord({ tmux: { session: "work", pane: "%3" } as ClaudeSessionRecord["tmux"] }),
      promptTmux: async () => { events.push("keystroke"); },
      ...overrides,
    });
    const before = (place: { via: string; location: string }) => { events.push(`before ${place.via} ${place.location}`); };

    expect(await deliverInPlace({ sessionId: SESSION, harness: "claude", body: "x", beforeKeystroke: before }, tmuxPane()))
      .toEqual({ ok: true, via: "tmux", location: "tmux work · %3" });
    expect(events).toEqual(["before tmux tmux work · %3", "keystroke"]);

    // A composer holding a draft is refused before the caller is told anything.
    events.length = 0;
    await deliverInPlace({ sessionId: SESSION, harness: "claude", body: "x", beforeKeystroke: before }, tmuxPane({ tmuxComposerDraft: async () => "half a thought" }));
    expect(events).toEqual([]);
  });

  test("a caller that refuses the keystroke stops it, and the refusal says nothing was sent", async () => {
    const typed: string[] = [];
    const result = await deliverInPlace({
      sessionId: SESSION,
      harness: "claude",
      body: "x",
      beforeKeystroke: () => { throw new Error("journal unavailable"); },
    }, noHosts({
      findClaudeRecord: async () => claudeRecord(),
      locateProcess: async () => ({ host: "herdr", session: "fab", paneId: "w2:p2" }),
      promptHerdr: async (_match, body) => { typed.push(body); },
    }));
    expect(result).toEqual({
      ok: false,
      code: "in_place_failed",
      via: "herdr",
      location: "Herdr fab · w2:p2",
      nothingSent: true,
      detail: "journal unavailable",
    });
    expect(typed).toEqual([]);
  });

  test("Scout's own background copies are never targets", async () => {
    const result = await deliverInPlace({ sessionId: SESSION, harness: "claude", body: "x" }, noHosts({
      findClaudeRecord: async () => claudeRecord({ tmux: { session: "flat-claude-1", pane: "%1" } as ClaudeSessionRecord["tmux"] }),
    }));
    expect(result).toEqual({ ok: false, code: "not_live" });
  });

  test("never types into the caller's own pane", async () => {
    const result = await deliverInPlace({ sessionId: SESSION, harness: "claude", body: "x" }, noHosts({
      findHerdrPane: async () => ({ session: "scout", paneId: "w1:p1", status: "idle" }),
      findClaudeRecord: async () => claudeRecord(),
      locateProcess: async () => ({ host: "orca", terminalHandle: "term_self", paneKey: null, worktreeId: null }),
      self: [{ host: "herdr", session: "scout", paneId: "w1:p1" }, { host: "orca", terminalHandle: "term_self", paneKey: null, worktreeId: null }],
      order: ["herdr", "orca", "tmux"],
    }));
    expect(result).toEqual({ ok: false, code: "not_live" });
  });

  test("never types into the caller's own terminal tab", async () => {
    const typed: string[] = [];
    const deps = (selfTty: string | null) => noHosts({
      findClaudeRecord: async () => claudeRecord(),
      ttyForPid: async () => "ttys002",
      typeIntoTty: async (tty) => { typed.push(tty); },
      selfTty: async () => selfTty,
    });
    expect(await deliverInPlace({ sessionId: SESSION, body: "x" }, deps("ttys002"))).toEqual({ ok: false, code: "not_live" });
    expect(await deliverInPlace({ sessionId: SESSION, body: "x" }, deps("ttys009"))).toMatchObject({ ok: true, via: "lattices" });
    expect(typed).toEqual(["ttys002"]);
  });

  test("nothing holding the session is not_live", async () => {
    expect(await deliverInPlace({ sessionId: SESSION, body: "x" }, noHosts())).toEqual({ ok: false, code: "not_live" });
  });
});

describe("native app drafts", () => {
  test.each([
    ["short", "review & reply?"],
    ["ellipsis-shaped", "x".repeat(237) + "..."],
    ["long", "x".repeat(300)],
  ])("drafts a %s reply without querying Accessibility, activity, or submitting", async (_label, body) => {
    const drafts: string[][] = [];
    const never = async (): Promise<never> => { throw new Error("must not submit or query Accessibility"); };
    const result = await deliverInPlace({ sessionId: SESSION, harness: "codex", body, mode: "draft" }, noHosts({
      codexHeldByApp: async () => true,
      draftCodexApp: async (...args) => { drafts.push(args); },
      askScoutApp: never,
      latticesCall: never,
      codexActivity: never,
      typeIntoCodexApp: never,
      findHerdrPane: never,
    }));
    expect(result).toMatchObject({ ok: true, delivered: "draft" });
    expect(drafts).toEqual([[SESSION, body]]);
  });

  test("never falls back to terminal submission or starts a missing thread", async () => {
    for (const harness of [undefined, "claude", "codex"]) {
      const result = await deliverInPlace({ sessionId: SESSION, harness, body: "hello", mode: "draft" }, noHosts());
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ code: harness === "codex" ? "not_live" : "draft_unsupported" });
    }
  });

  test("reports a URL transport failure without claiming delivery", async () => {
    expect(await deliverInPlace({ sessionId: SESSION, harness: "codex", body: "hi", mode: "draft" }, noHosts({
      codexHeldByApp: async () => true,
      draftCodexApp: async () => { throw new Error("URL handler unavailable"); },
    }))).toMatchObject({ ok: false, code: "in_place_failed", detail: "URL handler unavailable" });
  });
});

describe("native app submission activity guard", () => {
  test("refuses Scout.app's unguarded idle → focus → busy → Return sequence before any actuator", async () => {
    const calls: string[] = [];
    let activity: "idle" | "busy" = "idle";
    const ask: NonNullable<DeliverInPlaceDeps["askScoutApp"]> = async request => {
      calls.push(request.op);
      if (request.op === "status") return { ok: true, accessibility: "granted" };
      if (request.op === "composer.submit") {
        // Model the legacy Swift operation: focus can start a turn, but the
        // combined operation still presses Return without checking activity.
        calls.push("focus");
        activity = "busy";
        calls.push("Return");
        return { ok: true };
      }
      throw new Error(`unexpected operation: ${request.op}`);
    };
    const result = await deliverInPlace({ sessionId: SESSION, harness: "codex", body: "reply" }, noHosts({
      codexHeldByApp: async () => true,
      codexActivity: async () => { calls.push(`activity:${activity}`); return activity; },
      askScoutApp: ask,
      draftCodexApp: async () => { calls.push("draft"); },
      latticesCall: async () => { calls.push("daemon.status"); return { ok: false }; },
      typeIntoCodexApp: async () => {
        calls.push("open");
        await ask({ op: "composer.submit", text: "reply" });
      },
    }));
    expect(result).toMatchObject({ ok: false, code: "in_place_failed", via: "scout-app" });
    if (!result.ok && "detail" in result) expect(result.detail).toContain("after focus and before Return");
    expect(calls).toEqual(["activity:idle", "daemon.status", "status"]);
  });

  test.each(["busy", "unknown"] as const)("never opens or submits a %s thread", async activity => {
    let submitted = false;
    const result = await deliverInPlace({ sessionId: SESSION, harness: "codex", body: "reply" }, noHosts({ codexHeldByApp: async () => true, codexActivity: async () => activity, typeIntoCodexApp: async () => { submitted = true; } }));
    expect(result).toMatchObject({ ok: false, code: activity === "busy" ? "busy" : "activity_unknown" });
    expect(submitted).toBe(false);
  });
  test.each([true, false])("uses Lattices without consulting a running Scout.app (already held: %s)", async alreadyHeld => {
    const folder = await mkdtemp(join(tmpdir(), "scout-app-send-"));
    try {
      const transcript = join(folder, "rollout.jsonl");
      await writeFile(transcript, "");
      const calls: string[] = [];
      let held = alreadyHeld;
      let opening = false;
      const input = { sessionId: SESSION, harness: "codex", body: "reply" };
      const deps = noHosts({
        codexHeldByApp: async () => {
          if (opening && !held) {
            held = true;
            return false; // The first post-open ownership probe is too early.
          }
          return held;
        },
        codexActivity: async () => { calls.push("idle"); return "idle"; },
        askScoutApp: async request => { calls.push(request.op); return { ok: true, accessibility: "granted" }; },
        findCodexTranscript: async id => { expect(id).toBe(SESSION); return transcript; },
        draftCodexApp: async (id, body) => {
          calls.push("open");
          expect([id, body]).toEqual([SESSION, "reply"]);
          opening = !alreadyHeld;
        },
        latticesCall: async method => {
          calls.push(method);
          if (method === "computer.windowState") return { ok: true, snapshotId: "snapshot", target: { wid: 1 },
            elements: [{ role: "AXTextArea", id: "composer", value: input.body, focused: true }] };
          if (method === "computer.pressKey") await appendFile(transcript, JSON.stringify({ payload: { type: "user_message", message: input.body } }) + "\n");
          return { ok: true };
        },
      });

      if (!alreadyHeld) {
        expect(await deliverInPlace(input, deps)).toEqual({ ok: false, code: "not_live" });
        expect(calls).toEqual([]);
      }
      expect(await deliverInPlace({ ...input, openAppIfNeeded: !alreadyHeld }, deps)).toMatchObject({ ok: true, via: "lattices" });
      expect(calls).toEqual(["idle", "daemon.status", "open", "idle", "computer.windowState",
        "computer.elementAction", "computer.windowState", "idle", "computer.pressKey"]);
    } finally { await rm(folder, { recursive: true, force: true }); }
  });

  test("open and send refuses to open beside a non-app Codex writer", async () => {
    const never = async () => { throw new Error("must not touch the app"); };
    const result = await deliverInPlace({ sessionId: SESSION, harness: "codex", body: "reply", openAppIfNeeded: true }, noHosts({
      codexThreadPids: async () => [12345],
      draftCodexApp: never,
      latticesCall: never,
      askScoutApp: never,
    }));
    expect(result).toEqual({ ok: false, code: "not_live" });
  });
});

test("native lifecycle uses harness events, fails closed on partial tails", () => {
  const event = (type: string) => JSON.stringify({ type: "event_msg", payload: { type } }) + "\n";
  expect(codexActivityFromTranscript("")).toBe("unknown");
  expect(codexActivityFromTranscript(event("task_started"))).toBe("busy");
  expect(codexActivityFromTranscript(event("task_started") + event("task_complete"))).toBe("idle");
  expect(codexActivityFromTranscript(event("turn_aborted"))).toBe("idle");
  expect(codexActivityFromTranscript(event("task_complete") + event("task_started"))).toBe("busy");
  expect(codexActivityFromTranscript(event("task_complete") + "{partial")).toBe("unknown");
});


test("unsafe surfaces refuse without positive empty-composer evidence before checkpoint or input", async () => {
  let touched = 0;
  const touch = async () => { touched++; };
  const surfaces: Partial<DeliverInPlaceDeps>[] = [
    { findHerdrPane: async () => ({ session: "herdr", paneId: "p1", status: "idle" }) },
    { findClaudeRecord: async () => claudeRecord({ status: "idle" }),
      locateProcess: async () => ({ host: "orca", terminalHandle: "t1", paneKey: null }) },
    { findClaudeRecord: async () => claudeRecord({ status: "idle" }), ttyForPid: async () => "ttys004" },
  ];
  for (const surface of surfaces) {
    for (const composerEmpty of [undefined, async () => false, async () => { throw new Error("read failed"); }]) {
      const result = await deliverInPlace({
        sessionId: SESSION, harness: "claude", body: "task", beforeKeystroke: touch,
      }, noHosts({ ...surface, composerEmpty, promptHerdr: touch, promptOrca: touch, typeIntoTty: touch }));
      expect(result).toMatchObject({ ok: false, code: "in_place_failed", nothingSent: true });
    }
  }
  expect(touched).toBe(0);
});

test("tmux refuses failed or missing composer observations before checkpoint or paste", async () => {
  let touched = 0;
  for (const read of [async () => undefined, async () => { throw new Error("capture timeout"); }]) {
    const result = await deliverInPlace({
      sessionId: SESSION, harness: "claude", body: "task", beforeKeystroke: async () => { touched++; },
    }, noHosts({
      findClaudeRecord: async () => claudeRecord({ status: "idle", tmux: { session: "work", pane: "%3" } as ClaudeSessionRecord["tmux"] }),
      tmuxComposerDraft: read, promptTmux: async () => { touched++; },
    }));
    expect(result).toMatchObject({ ok: false, code: "in_place_failed", nothingSent: true });
  }
  expect(touched).toBe(0);
});

describe("the Scout channel", () => {
  const ORDER = ["herdr", "orca", "tmux", "channel", "terminal"] as const;
  /** A channel that answers for SESSION and records what it was given. */
  function channel(reply: "ok" | "not_accepted" | "no_answer" = "ok", hostPid: number | null = 77085) {
    const asked: Array<{ op: string; sessionId: string; body?: string }> = [];
    return {
      asked,
      askClaudeChannel: async (request: { op: "ping"; sessionId: string } | { op: "deliver"; sessionId: string; body: string }) => {
        asked.push(request);
        if (request.sessionId !== SESSION) return { ok: false as const, code: "channel_unavailable" as const, message: "none" };
        if (request.op === "ping" || reply === "ok") return { ok: true as const, sessionId: SESSION, hostPid };
        return reply === "no_answer"
          ? { ok: false as const, code: "channel_no_answer" as const, message: "no answer" }
          : { ok: false as const, code: "channel_not_accepted" as const, message: "not accepted" };
      },
    };
  }

  test("a Claude session in a plain terminal tab or a background job gets the words through its channel, not its tty", async () => {
    for (const kind of ["interactive", "bg"]) {
      const scout = channel();
      const typedTty: string[] = [];
      const result = await deliverInPlace({ sessionId: SESSION, harness: "claude", body: "check the build", requireExactHarness: true }, noHosts({
        order: [...ORDER],
        askClaudeChannel: scout.askClaudeChannel,
        findClaudeRecord: async () => claudeRecord({ kind, status: "busy" }),
        ttyForPid: async () => "ttys014",
        typeIntoTty: async (tty) => { typedTty.push(tty); },
      }));
      expect(result).toEqual({ ok: true, via: "claude-channel", location: "Claude channel 4cc36bba" });
      expect(scout.asked.filter((request) => request.op === "deliver")).toEqual([{ op: "deliver", sessionId: SESSION, body: "check the build" }]);
      expect(typedTty).toEqual([]);
    }
  });

  test("the delivery records itself before the words go", async () => {
    const scout = channel();
    const events: string[] = [];
    const result = await deliverInPlace({
      sessionId: SESSION, harness: "claude", body: "x",
      beforeKeystroke: (place) => { events.push(`before:${place.via}`); },
    }, noHosts({ order: [...ORDER], findClaudeRecord: async () => claudeRecord({ status: "idle" }), askClaudeChannel: async (request) => {
      if (request.op === "deliver") events.push("deliver");
      return scout.askClaudeChannel(request);
    } }));
    expect(result).toMatchObject({ ok: true, via: "claude-channel" });
    expect(events).toEqual(["before:claude-channel", "deliver"]);
  });

  test("a channel counts only beside a live record held by the process it runs in", async () => {
    const delivered = (scout: ReturnType<typeof channel>) => scout.asked.some((request) => request.op === "deliver");
    // No live record: a channel left naming a closed session is not proof.
    const orphan = channel();
    expect(await deliverInPlace({ sessionId: SESSION, harness: "claude", body: "x" }, noHosts({ order: [...ORDER], askClaudeChannel: orphan.askClaudeChannel })))
      .toEqual({ ok: false, code: "not_live" });
    expect(orphan.asked).toEqual([]);
    // After /clear or /resume the process holds another session; its old name is not this session.
    for (const hostPid of [4242, null]) {
      const moved = channel("ok", hostPid);
      const result = await deliverInPlace({ sessionId: SESSION, harness: "claude", body: "x" }, noHosts({
        order: [...ORDER], askClaudeChannel: moved.askClaudeChannel, findClaudeRecord: async () => claudeRecord({ kind: "bg", status: "idle" }),
      }));
      expect(result).toMatchObject({ ok: false, code: "not_live" });
      expect(delivered(moved)).toBe(false);
    }
    // Scout's own background copy of the session is never the operator's.
    const copy = channel();
    const fromCopy = await deliverInPlace({ sessionId: SESSION, harness: "claude", body: "x" }, noHosts({
      order: [...ORDER], askClaudeChannel: copy.askClaudeChannel,
      findClaudeRecord: async () => claudeRecord({ status: "idle", tmux: { session: "flat-4cc36bba", pane: "%9" } as ClaudeSessionRecord["tmux"] }),
    }));
    expect(fromCopy).toEqual({ ok: false, code: "not_live" });
    expect(copy.asked).toEqual([]);
  });

  test("a session at a permission prompt is refused as blocked with nothing sent", async () => {
    const scout = channel();
    const result = await deliverInPlace({ sessionId: SESSION, harness: "claude", body: "x" }, noHosts({
      order: [...ORDER], askClaudeChannel: scout.askClaudeChannel, findClaudeRecord: async () => claudeRecord({ status: "waiting" }),
    }));
    expect(result).toEqual({ ok: false, code: "session_blocked", via: "claude-channel", location: "Claude channel 4cc36bba" });
    expect(scout.asked.some((request) => request.op === "deliver")).toBe(false);
  });

  test("the sender's own session is never reached through its own channel", async () => {
    const scout = channel();
    const result = await deliverInPlace({ sessionId: SESSION, harness: "claude", body: "x" }, noHosts({
      order: [...ORDER], askClaudeChannel: scout.askClaudeChannel, ownSessionIds: [SESSION],
    }));
    expect(result).toEqual({ ok: false, code: "not_live" });
    expect(scout.asked).toEqual([]);
  });

  test("a refusal says nothing was sent; silence after the words were written does not", async () => {
    const findClaudeRecord = async () => claudeRecord({ kind: "bg", status: "idle" });
    const refused = await deliverInPlace({ sessionId: SESSION, harness: "claude", body: "x" }, noHosts({
      order: [...ORDER], askClaudeChannel: channel("not_accepted").askClaudeChannel, findClaudeRecord,
    }));
    expect(refused).toMatchObject({ ok: false, code: "in_place_failed", via: "claude-channel", nothingSent: true });
    const silent = await deliverInPlace({ sessionId: SESSION, harness: "claude", body: "x" }, noHosts({
      order: [...ORDER], askClaudeChannel: channel("no_answer").askClaudeChannel, findClaudeRecord,
    }));
    expect(silent).toMatchObject({ ok: false, code: "in_place_failed", via: "claude-channel" });
    expect("nothingSent" in silent).toBe(false);
  });

  test("a tmux pane that holds the session is still typed into first, and Codex never asks a channel", async () => {
    const scout = channel();
    const pasted: string[] = [];
    const result = await deliverInPlace({ sessionId: SESSION, harness: "claude", body: "x" }, noHosts({
      order: [...ORDER],
      askClaudeChannel: scout.askClaudeChannel,
      findClaudeRecord: async () => claudeRecord({ status: "idle", tmux: { session: "work", pane: "%3" } as ClaudeSessionRecord["tmux"] }),
      promptTmux: async (target) => { pasted.push(target); },
    }));
    expect(result).toMatchObject({ ok: true, via: "tmux" });
    expect(pasted).toEqual(["%3"]);

    const codex = channel();
    expect(await deliverInPlace({ sessionId: SESSION, harness: "codex", body: "x" }, noHosts({ order: [...ORDER], askClaudeChannel: codex.askClaudeChannel })))
      .toEqual({ ok: false, code: "not_live" });
    expect(codex.asked).toEqual([]);
  });

  test("the probe reports the channel as the place, with the harness's own activity", async () => {
    const scout = channel();
    const probe = await probeInPlace({ sessionId: SESSION, harness: "claude", requireExactHarness: true }, noHosts({
      order: [...ORDER], askClaudeChannel: scout.askClaudeChannel, findClaudeRecord: async () => claudeRecord({ kind: "bg", status: "idle" }),
    }));
    expect(probe).toEqual({ live: true, via: "claude-channel", location: "Claude channel 4cc36bba", activity: "idle" });
    // Leaving the channel out of the order leaves a background job out of reach.
    expect(await probeInPlace({ sessionId: SESSION, harness: "claude" }, noHosts({
      askClaudeChannel: scout.askClaudeChannel, findClaudeRecord: async () => claudeRecord({ kind: "bg", status: "idle" }), ttyForPid: async () => "ttys014",
    }))).toEqual({ live: false, code: "not_live", held: true });
  });
});
