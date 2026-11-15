// Core actuator regressions formerly exercised only by the web session wrapper.
import { describe, expect, test } from "bun:test";
import { deliverInPlace as submitInPlace } from "./in-place/deliver.js";
import type { ClaudeSessionRecord } from "./claude-session-records.js";
// Never inspect operator processes when a fixture omits a host-specific seam.
const deliverInPlace = (input: Parameters<typeof submitInPlace>[0], deps: Parameters<typeof submitInPlace>[1]) =>
  submitInPlace(input, { codexThreadPids: async () => [], locateProcess: async () => null, ...deps });
const SOURCE = "4fad8bb9-b4d3-4432-be75-8cfd636e78c0";

describe("deliverInPlace", () => {
  const record = (over: Partial<ClaudeSessionRecord>): ClaudeSessionRecord => ({
    pid: 42, sessionId: SOURCE, cwd: "/w", startedAt: null, procStart: null, kind: "interactive",
    entrypoint: "cli", version: null, tmux: null, name: null, nameSource: null, recordPath: "/r/42.json", ...over,
  });

  test("Herdr first: idle alone cannot prove the composer empty", async () => {
    const prompted: string[] = [];
    const result = await deliverInPlace({ sessionId: SOURCE, harness: "codex", body: "hi" }, {
      findHerdrPane: async () => ({ session: "scout", paneId: "w1:p1", status: "idle" }),
      codexThreadPids: async () => [],
      self: [],
      selfTty: async () => null,
      promptHerdr: async (pane, body) => { prompted.push(`${pane.paneId}:${body}`); },
      findClaudeRecord: async () => { throw new Error("not reached"); },
    });
    expect(result).toMatchObject({ ok: false, via: "herdr", nothingSent: true });
    expect(prompted).toEqual([]);
  });

  test("an app-held Codex thread refuses Scout.app submission without an actuator activity guard", async () => {
    const typed: string[] = [];
    const result = await deliverInPlace({ sessionId: SOURCE, harness: "codex", body: "hi" }, {
      findHerdrPane: async () => null,
      codexThreadPids: async () => [],
      self: [],
      selfTty: async () => null,
      codexHeldByApp: async () => true,
      codexActivity: async () => "idle",
      askScoutApp: async () => ({ ok: true, accessibility: "granted" }),
      typeIntoCodexApp: async (id, body) => { typed.push(`${id}:${body}`); },
    });
    expect(result).toMatchObject({ ok: false, code: "in_place_failed", via: "scout-app" });
    expect(typed).toEqual([]);
  });

  test("without the Scout app's grant, nothing reaches the ChatGPT composer", async () => {
    const typeIntoCodexApp = async () => { throw new Error("must not open the link"); };
    const base = {
      findHerdrPane: async () => null, self: [], selfTty: async () => null,
      codexThreadPids: async () => [], codexHeldByApp: async () => true,
      codexActivity: async () => "idle" as const, typeIntoCodexApp,
      latticesCall: async () => { throw new Error("Lattices unavailable"); },
    };
    expect(await deliverInPlace({ sessionId: SOURCE, harness: "codex", body: "hi" }, {
      ...base,
      askScoutApp: async () => ({ ok: true, accessibility: "not-granted" }),
    })).toMatchObject({ ok: false, code: "scout_app_accessibility" });
    expect(await deliverInPlace({ sessionId: SOURCE, harness: "codex", body: "hi" }, {
      ...base,
      askScoutApp: async () => ({ ok: false, code: "scout_app_unavailable", message: "not running" }),
    })).toMatchObject({ ok: false, code: "scout_app_unavailable" });
  });

  test("a Herdr pane at a prompt is not typed into", async () => {
    const result = await deliverInPlace({ sessionId: SOURCE, body: "hi" }, {
      findHerdrPane: async () => ({ session: "scout", paneId: "w1:p1", status: "blocked" }),
      codexThreadPids: async () => [],
      self: [],
      selfTty: async () => null,
      promptHerdr: async () => { throw new Error("must not type"); },
    });
    expect(result).toMatchObject({ ok: false, code: "session_blocked" });
  });

  test("then tmux, by the pane Claude's own record names", async () => {
    const targets: string[] = [];
    const result = await deliverInPlace({ sessionId: SOURCE, harness: "claude", body: "hi" }, {
      findHerdrPane: async () => null,
      codexThreadPids: async () => [],
      self: [],
      selfTty: async () => null,
      findClaudeRecord: async () => record({ tmux: { session: "work", window: "@1", pane: "%3" } }),
      tmuxComposerDraft: async () => null,
      promptTmux: async (target) => { targets.push(target); },
    });
    expect(result).toEqual({ ok: true, via: "tmux", location: "tmux work · %3" });
    expect(targets).toEqual(["%3"]);
  });

  test("plain terminal refuses without empty-composer evidence", async () => {
    const typed: string[] = [];
    const result = await deliverInPlace({ sessionId: SOURCE, harness: "claude", body: "hi" }, {
      findHerdrPane: async () => null,
      codexThreadPids: async () => [],
      self: [],
      selfTty: async () => null,
      findClaudeRecord: async () => record({}),
      ttyForPid: async () => "ttys007",
      typeIntoTty: async (tty, body) => { typed.push(`${tty}:${body}`); },
    });
    expect(result).toMatchObject({ ok: false, via: "lattices", nothingSent: true });
    expect(typed).toEqual([]);
  });

  test("Scout's own background copy is never a place to deliver", async () => {
    const result = await deliverInPlace({ sessionId: SOURCE, harness: "claude", body: "hi" }, {
      findHerdrPane: async () => null,
      codexThreadPids: async () => [],
      self: [],
      selfTty: async () => null,
      findClaudeRecord: async () => record({ tmux: { session: `flat-claude-${SOURCE}`, window: null, pane: "%58" } }),
      promptTmux: async () => { throw new Error("must not type"); },
    });
    expect(result).toEqual({ ok: false, code: "not_live" });
  });

  test("a Codex session nothing holds has no live place", async () => {
    const result = await deliverInPlace({ sessionId: SOURCE, harness: "codex", body: "hi" }, {
      findHerdrPane: async () => null,
      codexThreadPids: async () => [],
      self: [],
      selfTty: async () => null,
      codexHeldByApp: async () => false,
      findClaudeRecord: async () => { throw new Error("not reached"); },
    });
    expect(result).toEqual({ ok: false, code: "not_live" });
  });
});
