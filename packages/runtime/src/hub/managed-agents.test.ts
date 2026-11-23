import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Anthropic from "@anthropic-ai/sdk";

import { ManagedAgentsSource } from "../tail/managed-agents-source.js";
import type { DiscoveredTranscript, TailContext } from "../tail/types.js";
import { connectManagedAgents, loadManagedAgentsConfig, ManagedAgentsPuller, saveManagedAgentsConfig, type ManagedAgentsConfig } from "./managed-agents.js";

const KEY = "sk-ant-test-key";
type FakeEvent = { id: string; type: string; processed_at: string | null; [key: string]: unknown };
type FakeSession = { id: string; title: string | null; status: string; updated_at: string; created_at: string; agent: { id: string; name: string; version: number }; archived_at: null; events: FakeEvent[] };

// A small stand-in for the Managed Agents API: page cursors, the processed_at
// filter, the beta header and the API key, and a switch to fail one page.
const fake = {
  sessions: [] as FakeSession[],
  failEventsPage: null as string | null,
  requests: [] as string[],
};

function page<T>(items: T[], url: URL, size: number) {
  const start = Number(url.searchParams.get("page") ?? "0");
  const data = items.slice(start, start + size);
  return { data, next_page: start + size < items.length ? String(start + size) : null };
}

let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      fake.requests.push(`${url.pathname}${url.search}`);
      // SDK 1.x sends the key as a bearer token; older clients use x-api-key.
      const key = request.headers.get("x-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer /u, "");
      if (key !== KEY) {
        return Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 });
      }
      if (!(request.headers.get("anthropic-beta") ?? "").includes("managed-agents-2026-04-01")) {
        return Response.json({ type: "error", error: { type: "not_found_error", message: "no beta" } }, { status: 404 });
      }
      if (url.pathname === "/v1/sessions") {
        const since = url.searchParams.get("created_at[gte]") ?? "";
        const sorted = fake.sessions.filter((s) => s.created_at >= since).sort((a, b) => b.created_at.localeCompare(a.created_at));
        return Response.json({ ...page(sorted.map(({ events: _events, ...rest }) => ({ type: "session", ...rest })), url, 1), prev_page: null });
      }
      const match = /^\/v1\/sessions\/([^/]+)\/events$/u.exec(url.pathname);
      const session = match ? fake.sessions.find((s) => s.id === match[1]) : undefined;
      if (session) {
        if (fake.failEventsPage !== null && (url.searchParams.get("page") ?? "0") === fake.failEventsPage) {
          fake.failEventsPage = null;
          return Response.json({ type: "error", error: { type: "api_error", message: "boom" } }, { status: 500 });
        }
        const gte = url.searchParams.get("created_at[gte]");
        // Like the API: queued events have no processed_at and still list without a filter.
        const events = session.events.filter((event) => !gte || (event.processed_at !== null && event.processed_at >= gte));
        return Response.json(page(events, url, 2));
      }
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.OPENSCOUT_HUB_MANAGED_AGENTS_MIRROR_ROOT;
  fake.sessions = [];
  fake.failEventsPage = null;
  fake.requests = [];
});

const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const at = (minute: number) => new Date(NOW - 60 * 60_000 + minute * 60_000).toISOString();

function setup(apiKey = KEY) {
  const home = mkdtempSync(join(tmpdir(), "scout-ma-home-"));
  const mirror = mkdtempSync(join(tmpdir(), "scout-ma-mirror-"));
  dirs.push(home, mirror);
  const config: ManagedAgentsConfig = { v: 1, label: "acme", apiKey, baseURL: server.url.origin, lookbackDays: 7, createdAt: "" };
  saveManagedAgentsConfig(config, home);
  const puller = new ManagedAgentsPuller({
    home, mirrorRoot: mirror, now: () => NOW,
    client: (c) => new Anthropic({ apiKey: c.apiKey, baseURL: c.baseURL, maxRetries: 0 }),
  });
  return { home, mirror, puller };
}

function session(id: string, minute: number, events: FakeEvent[], overrides: Partial<FakeSession> = {}): FakeSession {
  return {
    id, title: `Task ${id}`, status: "running", created_at: at(minute), updated_at: at(minute + 1),
    agent: { id: "agent_1", name: "repo-reviewer", version: 3 }, archived_at: null, events, ...overrides,
  };
}

const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as FakeEvent);

describe("Managed Agents puller", () => {
  test("it mirrors each session's events once, in order, and resumes where it stopped", async () => {
    const { mirror, puller } = setup();
    fake.sessions = [
      session("sesn_a", 1, [
        { id: "e1", type: "user.message", processed_at: at(2), content: [{ type: "text", text: "Review the auth module." }] },
        { id: "e2", type: "agent.tool_use", processed_at: at(3), name: "bash", input: { command: "ls src/auth" } },
        { id: "e3", type: "agent.tool_result", processed_at: at(4), tool_use_id: "e2", content: [{ type: "text", text: "login.ts\nsession.ts" }] },
        { id: "q1", type: "user.message", processed_at: null, content: [{ type: "text", text: "queued" }] },
      ]),
      session("sesn_b", 5, [{ id: "b1", type: "agent.message", processed_at: at(6), content: [{ type: "text", text: "Done." }] }], { status: "idle" }),
    ];

    const first = await puller.pullOnce();
    expect(first).toMatchObject({ configured: true, listed: 2, changed: 2, appended: 4, notes: [] });
    expect(first.error).toBeUndefined();
    const aPath = join(mirror, "acme", "sesn_a.jsonl");
    expect(lines(aPath).map((event) => event.id)).toEqual(["e1", "e2", "e3"]);
    expect(statSync(aPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(mirror, "acme", "sesn_a.session.json"), "utf8"))).toMatchObject({
      id: "sesn_a", title: "Task sesn_a", status: "running", agent: { name: "repo-reviewer" },
    });

    // Nothing changed: no event requests at all.
    fake.requests = [];
    expect(await puller.pullOnce()).toMatchObject({ listed: 2, changed: 0, appended: 0 });
    expect(fake.requests.every((path) => path.startsWith("/v1/sessions?"))).toBe(true);

    // New events, one sharing the last mirrored timestamp, and the queued one now processed.
    const a = fake.sessions[0]!;
    a.events[3]!.processed_at = at(7);
    a.events.push(
      { id: "e4", type: "agent.message", processed_at: at(4), content: [{ type: "text", text: "Two files." }] },
      { id: "e5", type: "session.status_idle", processed_at: at(8), stop_reason: { type: "end_turn" } },
    );
    a.events.sort((x, y) => String(x.processed_at).localeCompare(String(y.processed_at)));
    a.updated_at = at(9);
    expect(await puller.pullOnce()).toMatchObject({ changed: 1, appended: 3, sessions: ["acme/sesn_a"] });
    expect(lines(aPath).map((event) => event.id)).toEqual(["e1", "e2", "e3", "e4", "q1", "e5"]);
  });

  test("a failed page keeps what was written, and the next pass adds no duplicates", async () => {
    const { mirror, puller } = setup();
    const events: FakeEvent[] = [1, 2, 3, 4, 5].map((n) => ({ id: `e${n}`, type: "agent.message", processed_at: at(n + 1), content: [{ type: "text", text: `m${n}` }] }));
    fake.sessions = [session("sesn_a", 1, events)];
    fake.failEventsPage = "2";
    const failed = await puller.pullOnce();
    expect(failed.error).toContain("500");
    expect(lines(join(mirror, "acme", "sesn_a.jsonl")).map((event) => event.id)).toEqual(["e1", "e2"]);

    expect(await puller.pullOnce()).toMatchObject({ changed: 1, appended: 3 });
    expect(lines(join(mirror, "acme", "sesn_a.jsonl")).map((event) => event.id)).toEqual(["e1", "e2", "e3", "e4", "e5"]);
  });

  test("a rejected key is reported plainly and writes nothing", async () => {
    const { mirror, home, puller } = setup("sk-ant-wrong");
    fake.sessions = [session("sesn_a", 1, [])];
    const summary = await puller.pullOnce();
    expect(summary.error).toBe("the API key was rejected (401)");
    expect(existsSync(join(mirror, "acme"))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "managed-agents.status.json"), "utf8")).error).toBe(summary.error);
  });

  test("without a config it does nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "scout-ma-empty-"));
    dirs.push(home);
    expect(await new ManagedAgentsPuller({ home, mirrorRoot: home }).pullOnce()).toMatchObject({ configured: false, listed: 0 });
    expect(fake.requests).toEqual([]);
  });
});

describe("Managed Agents connect", () => {
  const options = (home: string, mirror: string) => ({
    home, mirrorRoot: mirror, now: () => NOW,
    client: (c: ManagedAgentsConfig) => new Anthropic({ apiKey: c.apiKey, baseURL: c.baseURL, maxRetries: 0 }),
  });
  const withKey = (apiKey: string, label = "acme"): ManagedAgentsConfig =>
    ({ v: 1, label, apiKey, baseURL: server.url.origin, lookbackDays: 7, createdAt: "" });

  test("reconnecting with a bad key leaves the previous config and status intact", async () => {
    const { home, mirror, puller } = setup();
    fake.sessions = [session("sesn_a", 1, [])];
    await puller.pullOnce();
    const configBefore = readFileSync(join(home, "managed-agents.json"), "utf8");
    const statusBefore = readFileSync(join(home, "managed-agents.status.json"), "utf8");

    const result = await connectManagedAgents(withKey("sk-ant-wrong", "other"), options(home, mirror));
    expect(result).toEqual({ status: "failed", error: "the API key was rejected (401)", restoredPrevious: true });
    expect(readFileSync(join(home, "managed-agents.json"), "utf8")).toBe(configBefore);
    expect(loadManagedAgentsConfig(home)).toMatchObject({ apiKey: KEY, label: "acme" });
    expect(statSync(join(home, "managed-agents.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, "managed-agents.status.json"), "utf8")).toBe(statusBefore);
  });

  test("a first connect with a bad key saves nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "scout-ma-home-"));
    dirs.push(home);
    const result = await connectManagedAgents(withKey("sk-ant-wrong"), options(home, home));
    expect(result).toMatchObject({ status: "failed", restoredPrevious: false });
    expect(loadManagedAgentsConfig(home)).toBeNull();
  });

  test("while another pull holds the lock, the key is checked directly instead of reported as proven", async () => {
    const { home, mirror } = setup();
    const before = readFileSync(join(home, "managed-agents.json"), "utf8");
    mkdirSync(join(home, "managed-agents.lock"));
    const bad = await connectManagedAgents(withKey("sk-ant-wrong"), options(home, mirror));
    expect(bad).toMatchObject({ status: "failed", error: "the API key was rejected (401)", restoredPrevious: true });
    expect(readFileSync(join(home, "managed-agents.json"), "utf8")).toBe(before);

    fake.requests = [];
    const good = await connectManagedAgents(withKey(KEY, "renamed"), options(home, mirror));
    expect(good).toMatchObject({ status: "verified", summary: { busy: true, listed: 0 } });
    expect(fake.requests).toEqual(["/v1/sessions?limit=1"]);
    expect(loadManagedAgentsConfig(home)).toMatchObject({ label: "renamed" });
  });

  test("a good key pulls at once", async () => {
    const home = mkdtempSync(join(tmpdir(), "scout-ma-home-"));
    const mirror = mkdtempSync(join(tmpdir(), "scout-ma-mirror-"));
    dirs.push(home, mirror);
    fake.sessions = [session("sesn_a", 1, [{ id: "e1", type: "agent.message", processed_at: at(2) }])];
    expect(await connectManagedAgents(withKey(KEY), options(home, mirror))).toMatchObject({ status: "pulled", summary: { listed: 1, appended: 1 } });
  });
});

describe("Managed Agents tail source", () => {
  test("it lists mirrored sessions under their agent and turns events into rows", async () => {
    const { mirror, puller } = setup();
    fake.sessions = [session("sesn_a", 50, [
      { id: "e1", type: "user.message", processed_at: at(51), content: [{ type: "text", text: "Review the auth module." }, { type: "image", source: { type: "base64" } }] },
      { id: "e2", type: "span.model_request_start", processed_at: at(52) },
      { id: "e3", type: "agent.tool_use", processed_at: at(53), name: "bash", input: { command: "ls src/auth" } },
      { id: "e4", type: "agent.tool_result", processed_at: at(54), tool_use_id: "e3", content: [{ type: "text", text: "login.ts" }] },
      { id: "e5", type: "agent.mcp_tool_use", processed_at: at(55), name: "create_issue", mcp_server_name: "github", input: { title: "x" } },
      { id: "e6", type: "agent.message", processed_at: at(56), content: [{ type: "text", text: "Found one problem." }] },
      { id: "e7", type: "session.error", processed_at: at(57), error: { type: "model_overloaded_error", message: "Overloaded" } },
      { id: "e8", type: "session.status_idle", processed_at: at(58), stop_reason: { type: "end_turn" } },
    ])];
    await puller.pullOnce();
    process.env.OPENSCOUT_HUB_MANAGED_AGENTS_MIRROR_ROOT = mirror;

    const found = await ManagedAgentsSource.discoverTranscripts([], "shallow");
    expect(found).toEqual([expect.objectContaining({
      source: "managed-agents", sessionId: "sesn_a", project: "repo-reviewer", title: "Task sesn_a", status: "busy", cwd: null,
    })]);
    expect(ManagedAgentsSource.findTranscript?.("sesn_a")).toMatchObject({ project: "repo-reviewer" });
    expect(ManagedAgentsSource.findTranscript?.("../sesn_a")).toBeNull();

    const transcript = found[0] as DiscoveredTranscript;
    const ctx: TailContext = {
      transcript, transcriptPath: transcript.transcriptPath, lineOffset: 0, state: {},
      process: { pid: -1, ppid: 0, command: "managed-agents transcript", etime: "0", cwd: null, harness: "unattributed", parentChain: [], source: "managed-agents" },
    };
    const rows = readFileSync(transcript.transcriptPath, "utf8").trim().split("\n")
      .map((line) => ManagedAgentsSource.parseLine(line, ctx))
      .filter((row) => row !== null)
      .map((row) => [row!.kind, row!.summary]);
    expect(rows).toEqual([
      ["user", "Review the auth module. [image]"],
      ["tool", expect.stringContaining("ls src/auth")],
      ["tool-result", expect.stringMatching(/ls src\/auth.*-> res: .*login\.ts/u)],
      ["tool", expect.stringMatching(/^github: /u)],
      ["assistant", "Found one problem."],
      ["system", "session error: Overloaded"],
      ["system", "idle (end_turn)"],
    ]);
  });

  test("a test that points the Claude source elsewhere does not read this host's mirror", async () => {
    process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT = tmpdir();
    try {
      expect(await ManagedAgentsSource.discoverTranscripts([], "deep")).toEqual([]);
    } finally {
      delete process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT;
    }
  });
});
