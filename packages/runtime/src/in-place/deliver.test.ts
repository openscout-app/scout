import { describe, expect, test } from "bun:test";

import type { ClaudeSessionRecord } from "../claude-session-records.js";

import { codexActivityFromTranscript, deliverInPlace, resolveInPlaceOrder, type DeliverInPlaceDeps } from "./deliver.js";
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
    promptHerdr: never,
    promptOrca: never,
    promptTmux: never,
    ttyForPid: async () => null,
    typeIntoTty: never,
    codexHeldByApp: async () => false,
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
  test("defaults to herdr, orca, tmux, terminal", () => {
    expect(resolveInPlaceOrder({})).toEqual(["herdr", "orca", "tmux", "terminal"]);
  });

  test("a partial override moves named hosts first and keeps the rest", () => {
    expect(resolveInPlaceOrder({ OPENSCOUT_IN_PLACE_ORDER: "orca, bogus" })).toEqual(["orca", "herdr", "tmux", "terminal"]);
    expect(resolveInPlaceOrder({ OPENSCOUT_IN_PLACE_ORDER: "lattices,tmux" })).toEqual(["terminal", "tmux", "herdr", "orca"]);
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
  test("fills only the composer without querying Accessibility or submitting", async () => {
    const drafts: string[][] = [];
    const never = async (): Promise<never> => { throw new Error("must not submit or query Accessibility"); };
    const result = await deliverInPlace({ sessionId: SESSION, harness: "codex", body: "review & reply?", mode: "draft" }, noHosts({
      codexHeldByApp: async () => true,
      draftCodexApp: async (...args) => { drafts.push(args); },
      askScoutApp: never,
      typeIntoCodexApp: never,
      findHerdrPane: never,
    }));
    expect(result).toMatchObject({ ok: true, delivered: "draft" });
    expect(drafts).toEqual([[SESSION, "review & reply?"]]);
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
  test.each(["busy", "unknown"] as const)("never opens or submits a %s thread", async activity => {
    let submitted = false;
    const result = await deliverInPlace({ sessionId: SESSION, harness: "codex", body: "reply" }, noHosts({ codexHeldByApp: async () => true, codexActivity: async () => activity, typeIntoCodexApp: async () => { submitted = true; } }));
    expect(result).toMatchObject({ ok: false, code: activity === "busy" ? "busy" : "activity_unknown" });
    expect(submitted).toBe(false);
  });
  test("falls back only when Scout.app is unavailable", async () => {
    let submitted = false;
    const result = await deliverInPlace({ sessionId: SESSION, harness: "codex", body: "reply" }, noHosts({ codexHeldByApp: async () => true, codexActivity: async () => "idle", askScoutApp: async () => ({ ok: false, code: "unavailable", message: "offline" }), latticesCall: async () => ({ ok: true }), typeIntoCodexApp: async () => { submitted = true; } }));
    expect(result).toMatchObject({ ok: true, via: "lattices" });
    expect(submitted).toBe(true);
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
