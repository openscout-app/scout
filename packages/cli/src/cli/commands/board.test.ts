import { expect, test } from "bun:test";
import { parseBoardCommand } from "./board.ts";

test("connect names a team board by team and board, and the credential by reference", () => {
  const parsed = parseBoardCommand(["connect", "--team", "team_abc", "--board", "scout", "--credential", "secret_cli:scout-vercel"]);
  expect(parsed.body).toEqual({ team: "team_abc", board: "scout", credential: { backend: "secret_cli", key: "scout-vercel" } });
  expect(parseBoardCommand(["connect", "--team", "team_abc", "--credential", "secret_cli:scout-vercel"]).body).toEqual({ team: "team_abc", credential: { backend: "secret_cli", key: "scout-vercel" } });
});

test("connect takes a url or a team, not both", () => {
  expect(() => parseBoardCommand(["connect", "--url", "http://127.0.0.1:4100/api/board", "--team", "team_abc", "--credential", "env:BOARD"])).toThrow(/not both/);
  expect(() => parseBoardCommand(["connect", "--board", "scout", "--credential", "env:BOARD"])).toThrow(/--board needs --team/);
  expect(() => parseBoardCommand(["connect", "--credential", "env:BOARD"])).toThrow(/requires --team/);
  expect(parseBoardCommand(["connect", "--url", "http://127.0.0.1:4100/api/board", "--credential", "env:BOARD"]).body).toMatchObject({ url: "http://127.0.0.1:4100/api/board" });
});
