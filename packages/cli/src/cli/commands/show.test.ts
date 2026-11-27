import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScoutCommandContext } from "../context.ts";
import { runShowCommand } from "./show.ts";
const originalFetch = globalThis.fetch;
const ENV_KEYS = ["OPENSCOUT_BROKER_URL", "OPENSCOUT_BROKER_SOCKET_PATH", "OPENSCOUT_BROKER_SOCKET_ONLY"] as const;
const savedEnv = new Map<string, string | undefined>();
let dir: string;
let server: ReturnType<typeof Bun.serve> | undefined;
beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  dir = mkdtempSync(join(tmpdir(), "scout-show-"));
  // A mesh-advertised https URL that must never be dialed: TLS to it would fail.
  process.env.OPENSCOUT_BROKER_URL = "https://192.0.2.10:43110";
  process.env.OPENSCOUT_BROKER_SOCKET_PATH = join(dir, "broker.sock");
  delete process.env.OPENSCOUT_BROKER_SOCKET_ONLY;
  globalThis.fetch = (() => { throw new Error("show must use the broker socket, not fetch the broker URL"); }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  server?.stop(true); server = undefined;
  for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(dir, { recursive: true, force: true });
});
function serveSocket(handler: (request: Request) => Response | Promise<Response>) {
  server = Bun.serve({ unix: process.env.OPENSCOUT_BROKER_SOCKET_PATH!, fetch: handler });
}
test("show posts path and caption over the local broker socket even when the broker URL is mesh https", async () => {
  let body: unknown; let pathname: string | undefined;
  serveSocket(async request => { pathname = new URL(request.url).pathname; body = await request.json(); return Response.json({ show: { id: "version-one" } }, { status: 201 }); });
  const output: string[] = [];
  await runShowCommand(createScoutCommandContext({ cwd: "/work/project", env: { OPENSCOUT_AGENT: "agent-test", CODEX_THREAD_ID: "session-test" }, stdout: line => output.push(line) }), ["preview.png", "--caption", "Ready to review"]);
  expect(pathname).toBe("/v1/shows");
  expect(body).toMatchObject({ path: "/work/project/preview.png", caption: "Ready to review", caller: { actorId: "agent-test", currentDirectory: "/work/project", metadata: { sessionId: "session-test", harness: "codex" } } });
  expect(output.join("\n")).toContain("version-one");
});
test("show reports the broker's refusal code", async () => {
  serveSocket(() => Response.json({ error: "show_outside_worktree" }, { status: 403 }));
  const context = createScoutCommandContext({ cwd: "/work/project", env: { OPENSCOUT_AGENT: "agent-test" }, stdout: () => {} });
  await expect(runShowCommand(context, ["/tmp/x.html"])).rejects.toThrow("show_outside_worktree");
});
test("show validates arguments and offers setup-free help without fetching", async () => {
  const output: string[] = []; const context = createScoutCommandContext({ stdout: line => output.push(line) });
  await runShowCommand(context, ["--help"]); expect(output.join("\n")).toContain("scout show <path>");
  for (const args of [[], ["x", "--bad"], ["x", "--caption"]]) await expect(runShowCommand(context, args)).rejects.toThrow("Usage:");
});
