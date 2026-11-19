import { expect, test } from "bun:test";
import { parseVercelBoardCommand } from "./vercel-board.ts";

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
