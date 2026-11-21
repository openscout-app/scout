import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScoutCommandContext } from "../context.ts";
import { VERCEL_BOARD_VERBS } from "./integration.ts";
import { formatPlanPreview, parseVercelBoardCommand, runVercelBoardCommand, VERCEL_BOARD_HELP } from "./vercel-board.ts";

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

const PLAN_FILE = JSON.stringify({ planningTaskId: "work-1", tasks: [
  { key: "build", text: "Build the thing\nWith details", for: "builder" },
  { key: "review", text: "Review it", for: "reviewer", needs: [{ key: "build" }, "msg_earlier"] },
] });

test("plan previews by default and posts only with --post, as the operator with the calling session reported", () => {
  const env = { CODEX_THREAD_ID: "planner-session" };
  const read = (path: string) => { expect(path).toBe("plan.json"); return PLAN_FILE; };
  const preview = parseVercelBoardCommand(["plan", "--connection", "c1", "--channel", "scout/work", "--file", "plan.json"], env, read);
  expect(preview).toMatchObject({ kind: "plan", method: "POST", path: "/v1/integrations/vercel-board/plan", post: false });
  expect(preview.body).toMatchObject({ connectionId: "c1", channel: "scout/work", planningTaskId: "work-1", actorId: "operator", reportedCallerId: "session:planner-session" });
  expect((preview.body as any).tasks).toEqual(JSON.parse(PLAN_FILE).tasks);
  const posted = parseVercelBoardCommand(["plan", "--connection", "c1", "--channel", "scout/work", "--file", "plan.json", "--post"], env, read);
  expect(posted.post).toBe(true);
  // The same plan gets the same request ID, so a second --post returns the same tasks.
  expect(posted.body!.requestId).toBe(preview.body!.requestId);
  expect(String(preview.body!.requestId)).toMatch(/^cli-plan-[0-9a-f]{24}$/);
  const overridden = parseVercelBoardCommand(["plan", "--connection", "c1", "--channel", "scout/work", "--file", "plan.json", "--planning-task", "work-2", "--request-id", "req-9"], {}, read);
  expect(overridden.body).toMatchObject({ planningTaskId: "work-2", requestId: "req-9" });
  expect(overridden.body).not.toHaveProperty("reportedCallerId");
});

test("the plan preview shows each task's title, key, role and needs, and says nothing was written", () => {
  const plan = parseVercelBoardCommand(["plan", "--connection", "c1", "--channel", "scout/work", "--file", "p"], {}, () => PLAN_FILE).body as any;
  const text = formatPlanPreview(plan);
  expect(text).toContain("Nothing was written.");
  expect(text).toContain("  1. Build the thing (key build; for builder)");
  expect(text).toContain("  2. Review it (key review; for reviewer; needs {build}, msg_earlier)");
  expect(text).toContain("--post");
});

test("plan refuses a file the runtime would refuse, before anything is sent", () => {
  const parse = (file: unknown, extra: string[] = []) => parseVercelBoardCommand(["plan", "--connection", "c1", "--channel", "w", "--file", "p", ...extra], {}, () => typeof file === "string" ? file : JSON.stringify(file));
  expect(() => parseVercelBoardCommand(["plan", "--connection", "c1", "--channel", "w"], {}, () => "[]")).toThrow(/requires --file/);
  expect(() => parse("{nope")).toThrow(/not JSON/);
  expect(() => parse([{ text: "x" }])).toThrow(/--planning-task/);
  expect(parse([{ text: "x" }], ["--planning-task", "p1"]).body).toMatchObject({ planningTaskId: "p1", tasks: [{ text: "x" }] });
  expect(() => parse({ planningTaskId: "p", tasks: [] })).toThrow(/1 to 50 tasks/);
  expect(() => parse({ planningTaskId: "p", tasks: Array.from({ length: 51 }, () => ({ text: "x" })) })).toThrow(/1 to 50 tasks/);
  expect(() => parse({ planningTaskId: "p", tasks: [{ text: " " }] })).toThrow(/tasks\[0\]\.text/);
  expect(() => parse({ planningTaskId: "p", tasks: [{ key: "a", text: "x" }, { key: "a", text: "y" }] })).toThrow(/unique/);
  expect(() => parse({ planningTaskId: "p", tasks: [{ text: "x", needs: [{ key: "later" }] }, { key: "later", text: "y" }] })).toThrow(/earlier task/);
  expect(() => parse({ planningTaskId: "p", tasks: [{ text: "x", labels: { a: 1 } }] })).toThrow(/labels/);
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
  expect(named).toContain("plan");
  expect(VERCEL_BOARD_HELP).toContain("OUTWARD-FACING");
  expect(named.filter(verb => !VERCEL_BOARD_VERBS.has(verb))).toEqual([]);
});

async function withBrokerSocket(handler: (request: Request) => Response | Promise<Response>, run: (env: NodeJS.ProcessEnv, output: string[]) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "vb-cli-"));
  const socket = join(dir, "broker.sock");
  const server = Bun.serve({ unix: socket, fetch: handler });
  const output: string[] = [];
  // The https LAN address is unreachable here: only the socket can answer.
  const env = { OPENSCOUT_BROKER_URL: "https://192.0.2.1:9", OPENSCOUT_BROKER_SOCKET_PATH: socket, OPENSCOUT_AGENT: "agent-b" };
  try { await run(env, output); } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
}

test("commands reach the runtime over the broker socket when the broker URL is https", async () => {
  const seen: unknown[] = [];
  await withBrokerSocket(async request => {
    seen.push({ method: request.method, path: new URL(request.url).pathname, body: await request.json() });
    return Response.json({ declared: [{ agentId: "agent-b", role: "builder" }] });
  }, async (env, output) => {
    await runVercelBoardCommand(createScoutCommandContext({ env, outputMode: "plain", stdout: line => output.push(line) }), ["role", "--connection", "c1", "--role", "builder"]);
    expect(output.join("\n")).toBe("agent-b: builder");
  });
  expect(seen).toEqual([{ method: "POST", path: "/v1/integrations/vercel-board/roles", body: { connectionId: "c1", role: "builder", agentId: "agent-b", actorId: "agent-b" } }]);
});

test("broker errors keep the runtime's message and fix", async () => {
  await withBrokerSocket(() => Response.json({ error: "unknown_connection", message: "No Vercel Board connection c1.", fix: "Run: scout integration status vercel-board" }, { status: 404 }), async env => {
    const context = createScoutCommandContext({ env, outputMode: "plain", stdout: () => {} });
    await expect(runVercelBoardCommand(context, ["status", "--connection", "c1"])).rejects.toThrow("No Vercel Board connection c1.\nFix: Run: scout integration status vercel-board");
  });
  await withBrokerSocket(() => new Response("", { status: 502 }), async env => {
    const context = createScoutCommandContext({ env, outputMode: "plain", stdout: () => {} });
    await expect(runVercelBoardCommand(context, ["status"])).rejects.toThrow("Broker returned HTTP 502");
  });
});
