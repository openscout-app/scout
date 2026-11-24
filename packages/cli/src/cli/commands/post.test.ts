import { afterEach, expect, test } from "bun:test";
import { createScoutCommandContext } from "../context.ts";
import { runPostCommand } from "./post.ts";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
test("post sends text, file, links and milestone with the ordinary sender and current session", async () => {
  let body: unknown; let url: string | undefined;
  globalThis.fetch = (async (input, init) => { url = String(input); body = JSON.parse(String(init?.body)); return Response.json({ post: { id: "post-one" } }, { status: 201 }); }) as typeof fetch;
  const output: string[] = [];
  await runPostCommand(createScoutCommandContext({ cwd: "/work/project", env: { OPENSCOUT_AGENT: "agent-test", CLAUDE_CODE_SESSION_ID: "session-test" }, stdout: line => output.push(line) }), ["The header ships", "--file", "shot.png", "--link=https://example.test/pr/1", "--milestone"]);
  expect(url).toEndWith("/v1/posts");
  expect(body).toEqual({ text: "The header ships", file: "/work/project/shot.png", links: [{ url: "https://example.test/pr/1" }], milestone: true, caller: { actorId: "agent-test", currentDirectory: "/work/project", metadata: { sessionId: "session-test", harness: "claude" } } });
  expect(output.join("\n")).toContain("post-one");
});
test("post validates arguments and prints its guidance without fetching", async () => {
  globalThis.fetch = (() => { throw new Error("unexpected fetch"); }) as unknown as typeof fetch;
  const output: string[] = []; const context = createScoutCommandContext({ stdout: line => output.push(line) });
  await runPostCommand(context, ["--help"]); expect(output.join("\n")).toContain("Don't post acknowledgements");
  for (const args of [[], ["x", "--bad"], ["x", "--file"], ["x", "--text-file", "y"]]) await expect(runPostCommand(context, args)).rejects.toThrow("Usage:");
});
