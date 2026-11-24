import { expect, test } from "bun:test";
import { VERCEL_BOARD_VERBS } from "./integration.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVercelBoardCommand, readVercelBoardDispatchFile, VERCEL_BOARD_HELP } from "./vercel-board.ts";

test("connect names a team board by team and board, and the credential by reference", () => {
  const parsed = parseVercelBoardCommand(["connect", "--team", "team_abc", "--board", "scout", "--credential", "secret_cli:scout-vercel"]);
  expect(parsed.body).toEqual({ team: "team_abc", board: "scout", credential: { backend: "secret_cli", key: "scout-vercel" } });
  expect(parseVercelBoardCommand(["connect", "--team", "team_abc", "--credential", "secret_cli:scout-vercel"]).body).toEqual({ team: "team_abc", credential: { backend: "secret_cli", key: "scout-vercel" } });
});

test("connect takes a url or a team, not both", () => {
  expect(() => parseVercelBoardCommand(["connect", "--url", "http://127.0.0.1:4100/api/board", "--team", "team_abc", "--credential", "env:BOARD"])).toThrow(/not both/);
  expect(() => parseVercelBoardCommand(["connect", "--board", "scout", "--credential", "env:BOARD"])).toThrow(/--board needs --team/);
  expect(() => parseVercelBoardCommand(["connect", "--credential", "env:BOARD"])).toThrow(/requires --team/);
  expect(parseVercelBoardCommand(["connect", "--url", "http://127.0.0.1:4100/api/board", "--credential", "env:BOARD"]).body).toMatchObject({ url: "http://127.0.0.1:4100/api/board" });
});

test("connect takes the mirrored channels as a list", () => {
  expect(parseVercelBoardCommand(["connect", "--team", "team_abc", "--credential", "env:BOARD", "--channels", "scout/work,scout/notes", "--mirror", "scout/work"]).body)
    .toMatchObject({ channels: ["scout/work", "scout/notes"], mirror: ["scout/work"] });
});

test("messages and handoffs are reads with their filters in the query", () => {
  const messages = parseVercelBoardCommand(["messages", "--connection", "c1", "--channel", "scout/work", "--limit", "50"]);
  expect(messages).toMatchObject({ kind: "messages", method: "GET" });
  expect(messages.path).toBe("/v1/integrations/vercel-board/messages?connection=c1&channel=scout%2Fwork&limit=50");
  expect(() => parseVercelBoardCommand(["messages", "--connection", "c1"])).toThrow(/requires --channel/);
  expect(parseVercelBoardCommand(["handoffs", "--connection", "c1", "--task", "42"]).path).toBe("/v1/integrations/vercel-board/handoffs?connection=c1&task=42");
  expect(() => parseVercelBoardCommand(["handoffs", "--connection", "c1", "--limit", "many"])).toThrow(/whole number/);
});

test("claim reports the calling session separately from the assigned agent", () => {
  const command = parseVercelBoardCommand(["claim", "--connection", "c1", "--task", "42", "--agent", "worker"],
    { CODEX_THREAD_ID: "calling-session", OPENSCOUT_AGENT: "planner" });
  expect(command.body).toMatchObject({ agentId: "worker", reportedCallerId: "session:calling-session" });
});

test("role declares the calling agent, or another agent as the operator", () => {
  const own = parseVercelBoardCommand(["role", "--connection", "c1", "--role", "reviewer"], { OPENSCOUT_AGENT: "agent-r" });
  expect(own).toMatchObject({ kind: "role", method: "POST", path: "/v1/integrations/vercel-board/roles", body: { connectionId: "c1", role: "reviewer", agentId: "agent-r", actorId: "agent-r" } });
  const other = parseVercelBoardCommand(["role", "--connection", "c1", "--role", "builder", "--agent", "agent-b", "--remove"], {});
  expect(other.body).toEqual({ connectionId: "c1", role: "builder", agentId: "agent-b", actorId: "operator", remove: true });
  expect(() => parseVercelBoardCommand(["role", "--connection", "c1", "--role", "reviewer"], {})).toThrow(/--agent/);
  const connect = parseVercelBoardCommand(["connect", "--team", "t", "--credential", "env:T", "--roles", "scout,reviewer", "--self-serve", "scout/work", "--sync-channels", "scout/work"], {});
  expect(connect.body).toMatchObject({ roles: ["scout", "reviewer"], selfServe: ["scout/work"], syncChannels: ["scout/work"] });
});

test("the integration command dispatches every verb the Board help names", () => {
  const named = [...VERCEL_BOARD_HELP.matchAll(/^scout integration (\w+) vercel-board/gm)].map(match => match[1]);
  expect(named).toContain("role");
  expect(named).toContain("dispatcher");
  expect(named.filter(verb => !VERCEL_BOARD_VERBS.has(verb))).toEqual([]);
});

test("dispatcher shows the policy, explains one task, or runs a pass", () => {
  expect(parseVercelBoardCommand(["dispatcher", "--connection", "c1"])).toMatchObject({ kind: "dispatcher", method: "GET", path: "/v1/integrations/vercel-board/dispatcher?connection=c1" });
  expect(parseVercelBoardCommand(["dispatcher", "--connection", "c1", "--explain", "42"]).path).toBe("/v1/integrations/vercel-board/dispatcher?connection=c1&explain=42");
  expect(parseVercelBoardCommand(["dispatcher", "--connection", "c1", "--run"])).toMatchObject({ kind: "dispatcher-run", method: "POST", path: "/v1/integrations/vercel-board/dispatcher/run", body: { connectionId: "c1", actorId: "operator" } });
  expect(() => parseVercelBoardCommand(["dispatcher"])).toThrow(/--connection/);
  expect(() => parseVercelBoardCommand(["dispatcher", "--connection", "c1", "--run", "--explain", "42"])).toThrow(/one of/);
});

test("dispatcher changes one channel's settings on top of the saved block, and relaxing a guard names a channel", () => {
  const current = { policy: "manual", capabilities: { "area=docs": ["agent-docs"] }, channels: { "scout/ops": { policy: "role-only" } } };
  const set = parseVercelBoardCommand(["dispatcher", "--connection", "c1", "--channel", "scout/work", "--policy", "trusted-channel", "--trust-authors", "allowlist", "--trust-synced", "github", "--trust-any-epoch"]);
  expect(set).toMatchObject({ kind: "dispatcher-set", method: "POST", path: "/v1/integrations/vercel-board/dispatcher", body: { connectionId: "c1", actorId: "operator" } });
  expect(set.change!(current)).toEqual({ policy: "manual", capabilities: { "area=docs": ["agent-docs"] }, channels: {
    "scout/ops": { policy: "role-only" },
    "scout/work": { policy: "trusted-channel", trust: { authors: "allowlist", anyEpoch: true, synced: ["github"] } },
  } });
  expect(current.channels).toEqual({ "scout/ops": { policy: "role-only" } }); // the saved block is not changed in place
  const reset = parseVercelBoardCommand(["dispatcher", "--connection", "c1", "--channel", "scout/ops", "--default"]);
  expect(reset.change!(current)).toEqual({ policy: "manual", capabilities: { "area=docs": ["agent-docs"] } });
  expect(parseVercelBoardCommand(["dispatcher", "--connection", "c1", "--policy", "role-only"]).change!({})).toEqual({ policy: "role-only" });
  expect(parseVercelBoardCommand(["dispatcher", "--connection", "c1", "--pause"]).change!({ policy: "role-only" })).toEqual({ policy: "role-only", enabled: false });
  expect(parseVercelBoardCommand(["dispatcher", "--connection", "c1", "--resume"]).change!({ enabled: false })).toEqual({});
  expect(() => parseVercelBoardCommand(["dispatcher", "--connection", "c1", "--trust-authors", "any"])).toThrow(/add --channel/);
  expect(() => parseVercelBoardCommand(["dispatcher", "--connection", "c1", "--channel", "w", "--trust-authors", "everyone"])).toThrow(/operator, allowlist or any/);
  expect(parseVercelBoardCommand(["dispatcher", "--connection", "c1", "--file", "rules.json"])).toMatchObject({ kind: "dispatcher-set", file: "rules.json" });
  expect(() => parseVercelBoardCommand(["dispatcher", "--connection", "c1", "--file", "rules.json", "--pause"])).toThrow(/alone/);
});

test("--swarm turns the swarm for operator plans off or on, for the connection or one channel", () => {
  const swarm = (...args: string[]) => parseVercelBoardCommand(["dispatcher", "--connection", "c1", "--swarm", ...args]);
  expect(swarm("off").change!({ policy: "role-only" })).toEqual({ policy: "role-only", swarm: { enabled: false } });
  expect(swarm("on").change!({ swarm: { enabled: false, channels: { work: false } } })).toEqual({});
  expect(swarm("off", "--channel", "work").change!({})).toEqual({ swarm: { channels: { work: false } } });
  expect(swarm("on", "--channel", "work").change!({ swarm: { enabled: false } })).toEqual({ swarm: { enabled: false, channels: { work: true } } });
  expect(() => swarm("maybe")).toThrow(/on or off/);
  expect(() => swarm("off", "--file", "rules.json")).toThrow(/alone/);
});

test("a dispatch settings file holds the block or wraps it in dispatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-dispatch-"));
  try {
    writeFileSync(join(dir, "a.json"), JSON.stringify({ dispatch: { policy: "role-only" } }));
    writeFileSync(join(dir, "b.json"), JSON.stringify({ channels: { "scout/work": { policy: "manual" } } }));
    writeFileSync(join(dir, "c.json"), "[1]");
    expect(readVercelBoardDispatchFile("a.json", dir)).toEqual({ policy: "role-only" });
    expect(readVercelBoardDispatchFile(join(dir, "b.json"))).toEqual({ channels: { "scout/work": { policy: "manual" } } });
    expect(() => readVercelBoardDispatchFile("c.json", dir)).toThrow(/JSON object/);
    expect(() => readVercelBoardDispatchFile("missing.json", dir)).toThrow(/Could not read/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
