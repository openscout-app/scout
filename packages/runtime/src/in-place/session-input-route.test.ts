import { expect, test } from "bun:test";
import { inspectSessionInputRoute, type InspectSessionInputRouteDeps } from "@openscout/runtime/in-place";
import type { ClaudeSessionRecord } from "../claude-session-records.js";

const sessionId = "4cc36bba-a893-461f-a5b1-79c1f6b7e088";
const claude = { harness: "claude", sessionId };
const codex = { harness: "codex", sessionId };
const herdr = { harness: "claude", sessionKind: "id", session: "work", paneId: "w1:p2", status: "idle" };
const tmux = { session: "work", window: "@1", pane: "%3" };
const orca = { host: "orca", terminalHandle: "term:1", paneKey: null } as const;
const record = (fields: Partial<ClaudeSessionRecord> = {}): ClaudeSessionRecord => ({
  pid: 42, sessionId, cwd: "/work/repo", startedAt: null, procStart: null, kind: "interactive",
  entrypoint: "cli", version: null, tmux: null, status: "idle", name: null, nameSource: null, recordPath: "/tmp/42.json",
  ...fields,
});

function deps(overrides: InspectSessionInputRouteDeps = {}): InspectSessionInputRouteDeps {
  return {
    findHerdrPane: async () => null,
    findClaudeRecord: async () => null,
    scoutLaunchedTmuxSessions: async () => new Set(),
    codexThreadPids: async () => [],
    codexHeldByApp: async () => false,
    findCodexTranscript: async () => null,
    locateProcess: async () => null,
    askClaudeChannel: async () => ({ ok: false, code: "channel_unavailable", message: "offline" }),
    readOrcaAgents: async () => [],
    ttyForPid: async () => null,
    self: [],
    selfTty: async () => null,
    tmuxComposerDraft: async () => null,
    codexActivity: async () => "idle",
    latticesCall: async () => ({ ok: false }),
    ...overrides,
  };
}

test.each(["permission", "question"] as const)("an exact open %s takes precedence over every input route", async kind => {
  const tried: string[] = [];
  const route = await inspectSessionInputRoute(codex, deps({
    readAnswerGate: async input => { expect(input).toEqual(codex); return { kind, location: "operator card" }; },
    readDirectInput: async () => { tried.push("direct"); return { location: "endpoint", activity: "idle" }; },
  }));
  expect(route).toMatchObject({ kind: "answer_gate", via: kind, location: "operator card", activity: "waiting",
    provenance: "observed", canSteerWhileBusy: false, canQueue: false, alternatives: [] });
  expect(tried).toEqual([]);
});

test("a harness wait overrides a busy-capable direct route even on a lower-priority host", async () => {
  const route = await inspectSessionInputRoute(claude, deps({
    findHerdrPane: async () => herdr,
    findClaudeRecord: async () => record(),
    locateProcess: async () => ({ ...orca, paneKey: "pane-1" }),
    readOrcaAgents: async () => [{ paneKey: "pane-1", agentType: "claude", state: "waiting",
      worktreeId: "tree-1", worktreePath: null, lastAssistantMessage: null }],
    readDirectInput: async () => ({ location: "endpoint", activity: "busy", canSteerWhileBusy: true }),
  }));
  expect(route).toMatchObject({ kind: "answer_gate", via: "harness", location: "Orca term:1", activity: "waiting" });
});

test.each(["runtime", "codex-daemon"] as const)("prefers %s direct input to observed host and desktop alternatives", async wanted => {
  const route = await inspectSessionInputRoute(codex, deps({
    findHerdrPane: async () => ({ ...herdr, harness: "codex" }),
    readDirectInput: async (input, via) => {
      expect(input).toEqual(codex);
      if (wanted === "codex-daemon" && via === "runtime") return null;
      return { location: via, activity: "busy", canSteerWhileBusy: true, canQueue: via === "runtime" };
    },
    codexHeldByApp: async () => true,
    latticesCall: async () => ({ ok: true }),
  }));
  expect(route).toMatchObject({ kind: "live_direct", via: wanted, location: wanted, activity: "busy", provenance: "observed",
    canSteerWhileBusy: true, canQueue: wanted === "runtime", alternatives: ["live_host", "gui_app", "draft"] });
});

test("a PID-bound Claude channel takes precedence over a pane but is not a durable queue", async () => {
  const reads: unknown[] = [];
  const route = await inspectSessionInputRoute(claude, deps({
    findClaudeRecord: async () => record({ status: "busy", tmux }),
    askClaudeChannel: async request => { reads.push(request); return { ok: true, hostPid: 42 }; },
  }));
  expect(reads).toEqual([{ op: "ping", sessionId }]);
  expect(route).toMatchObject({ kind: "live_direct", via: "claude-channel", activity: "busy",
    canSteerWhileBusy: true, canQueue: false, alternatives: ["live_host"] });
});

test.each([
  ["herdr", true, true, true],
  ["orca", false, true, true],
  ["tmux", false, false, true],
  ["terminal", false, false, false],
] as const)("chooses %s in the host ladder", async (via, inHerdr, inOrca, inTmux) => {
  const route = await inspectSessionInputRoute(claude, deps({
    findHerdrPane: async () => inHerdr ? herdr : null,
    locateProcess: async () => inOrca ? orca : null,
    findClaudeRecord: async () => record({ tmux: inTmux ? tmux : null }),
    ttyForPid: async () => "ttys001",
    askClaudeChannel: async () => ({ ok: true, hostPid: 999 }), // An old channel is not a route.
  }));
  expect(route).toMatchObject({ kind: "live_host", via, activity: "idle", provenance: "observed",
    canSteerWhileBusy: false, canQueue: false, alternatives: [] });
});

test.each([
  [true, true, "lattices", "observed", ["draft"]],
  [true, false, "codex-app", "observed", ["draft"]],
  [false, true, "lattices", "inferred", ["resume"]],
] as const)("desktop routing only probes daemon status (held: %s, reachable: %s)", async (held, reachable, via, provenance, alternatives) => {
  const calls: string[] = [];
  const options = {
    ...deps({
      codexHeldByApp: async () => held,
      findCodexTranscript: async () => "/tmp/rollout.jsonl",
      latticesCall: async method => { calls.push(method); return { ok: reachable }; },
    }),
    draftCodexApp: async () => { calls.push("open"); },
    typeIntoCodexApp: async () => { calls.push("type"); },
  };
  const route = await inspectSessionInputRoute(codex, options);
  expect(route).toMatchObject({ kind: "gui_app", via, provenance, activity: "idle", alternatives,
    canSteerWhileBusy: false, canQueue: false });
  expect(calls).toEqual(["daemon.status"]);
});

test("a future exact window observation can report a gate before the app actuator is consulted", async () => {
  expect(await inspectSessionInputRoute(codex, deps({
    readCodexDesktop: async () => ({ location: "Codex window", activity: "waiting" }),
  }))).toMatchObject({ kind: "answer_gate", via: "harness", location: "Codex window" });
});

test.each(["claude", "codex", "grok", "opencode", "pi"])("a stopped %s session has a native resume route", async harness => {
  const route = await inspectSessionInputRoute({ sessionId, harness }, deps({
    readSessionState: async () => "stopped",
  }));
  expect(route).toMatchObject({ kind: "resume", via: "harness", provenance: "inferred", activity: "unknown",
    alternatives: [], canSteerWhileBusy: false, canQueue: false });
});

test("an unheld Codex rollout defaults to native resume when Lattices is absent", async () => {
  expect(await inspectSessionInputRoute(codex, deps({ findCodexTranscript: async () => "/tmp/rollout.jsonl" })))
    .toMatchObject({ kind: "resume", provenance: "inferred" });
});

test("even with live capabilities installed, an unknown ID is not openable", async () => {
  expect(await inspectSessionInputRoute(codex, deps({ latticesCall: async () => ({ ok: true }) })))
    .toMatchObject({ kind: "handoff_only", via: null, provenance: "unobserved", alternatives: [] });
});

test("a stopped non-resumable session is observed but handoff-only", async () => {
  expect(await inspectSessionInputRoute({ sessionId, harness: "cursor" }, deps({ readSessionState: async () => "stopped" })))
    .toMatchObject({ kind: "handoff_only", provenance: "observed" });
});

test("a Codex writer with no verified surface cannot be resumed or opened beside", async () => {
  expect(await inspectSessionInputRoute(codex, deps({
    codexThreadPids: async () => [42], findCodexTranscript: async () => "/tmp/rollout.jsonl",
    latticesCall: async () => ({ ok: true }),
  }))).toMatchObject({ kind: "handoff_only", provenance: "observed", alternatives: [] });
});

test("a conflicting Herdr harness is not proof that Codex is stopped", async () => {
  expect(await inspectSessionInputRoute(codex, deps({
    findHerdrPane: async () => herdr, readSessionState: async () => "stopped",
    latticesCall: async () => ({ ok: true }),
  }))).toMatchObject({ kind: "handoff_only", provenance: "unobserved", alternatives: [] });
});
