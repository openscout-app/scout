import { afterEach, expect, test } from "bun:test";
import { createScoutCommandContext } from "../context.ts";
import { runShowCommand } from "./show.ts";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
test("show sends path and caption with the ordinary sender and current session", async () => {
  let body: unknown; let url: string | undefined;
  globalThis.fetch = (async (input, init) => { url = String(input); body = JSON.parse(String(init?.body)); return Response.json({ show: { id: "version-one" } }, { status: 201 }); }) as typeof fetch;
  const output: string[] = [];
  await runShowCommand(createScoutCommandContext({ cwd: "/work/project", env: { OPENSCOUT_AGENT: "agent-test", CODEX_THREAD_ID: "session-test" }, stdout: line => output.push(line) }), ["preview.png", "--caption", "Ready to review"]);
  expect(url).toEndWith("/v1/shows");
  expect(body).toMatchObject({ path: "/work/project/preview.png", caption: "Ready to review", caller: { actorId: "agent-test", currentDirectory: "/work/project", metadata: { sessionId: "session-test", harness: "codex" } } });
  expect(output.join("\n")).toContain("version-one");
});
test("show validates arguments and offers setup-free help without fetching", async () => {
  globalThis.fetch = (() => { throw new Error("unexpected fetch"); }) as unknown as typeof fetch;
  const output: string[] = []; const context = createScoutCommandContext({ stdout: line => output.push(line) });
  await runShowCommand(context, ["--help"]); expect(output.join("\n")).toContain("scout show <path>");
  for (const args of [[], ["x", "--bad"], ["x", "--caption"]]) await expect(runShowCommand(context, args)).rejects.toThrow("Usage:");
});
