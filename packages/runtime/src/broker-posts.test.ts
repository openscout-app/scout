import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { AgentEndpoint } from "@openscout/protocol";
import { BrokerShowStore } from "./broker-show-store.js";
import { BrokerPostStore } from "./broker-post-store.js";
import { handlePostRoute, resolveCallerSession, type PostHttpDeps } from "./broker-posts-http.js";
import { handleShowRoute } from "./broker-shows-http.js";
import type { RuntimeHttpRequestLike, RuntimeHttpResponseLike } from "./portable-types.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const endpoint = (agentId: string, sessionId: string, metadata: Record<string, unknown> = {}, harness = "claude") =>
  ({ id: `endpoint.${sessionId}`, agentId, nodeId: "node-test", harness, transport: "tmux", state: "idle", sessionId, metadata }) as unknown as AgentEndpoint;

async function fixture(endpoints: Record<string, AgentEndpoint> = {}, records = 100) {
  const dir = await mkdtemp(join(tmpdir(), "scout-posts-")); dirs.push(dir);
  const workspace = join(dir, "workspace"); await mkdir(workspace);
  const shows = new BrokerShowStore(join(dir, "shows"), "node-test");
  const store = new BrokerPostStore(join(dir, "posts"), "node-test", { records });
  const deps: PostHttpDeps = { store, shows, snapshot: () => ({ agents: {}, endpoints }), authorName: ({ agentId }) => `name of ${agentId}` };
  return { dir, workspace, shows, store, deps };
}

async function http(deps: PostHttpDeps, path: string, options: { method?: string; body?: unknown; origin?: string; remote?: boolean } = {}, route = handlePostRoute) {
  const req = new EventEmitter() as EventEmitter & RuntimeHttpRequestLike;
  Object.assign(req, { method: options.method || "GET", headers: { "content-type": "application/json", ...(options.origin ? { origin: options.origin } : {}) }, transportContext: { transport: options.remote ? "remote" : "loopback" }, resume() {}, destroy() {} });
  const res = new EventEmitter() as EventEmitter & RuntimeHttpResponseLike;
  let status = 0; const chunks: Buffer[] = [];
  Object.assign(res, { writeHead(code: number) { status = code; }, write(chunk: string | Buffer) { chunks.push(Buffer.from(chunk)); return true; }, end(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)); }, getHeader() { return undefined; } });
  const pending = route(req, res, new URL(path, "http://localhost"), deps as never);
  if (options.body) { req.emit("data", Buffer.from(JSON.stringify(options.body))); req.emit("end"); }
  await pending;
  return { status, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") };
}

test("a native harness id matches the endpoint that stores it under any session key", () => {
  // Endpoints keep the harness id as externalSessionId, threadId or observedSessionId, never harnessSessionId.
  const endpoints = { a: endpoint("agent-a", "session-scout-a", { externalSessionId: "native-a" }), b: endpoint("agent-a", "session-scout-b", { threadId: "native-b" }, "codex") };
  const snapshot = { endpoints };
  expect(resolveCallerSession(snapshot, { actorId: "agent-a", currentDirectory: "/", metadata: { sessionId: "native-a", harness: "claude" } }, "show").endpoint?.id).toBe("endpoint.session-scout-a");
  expect(resolveCallerSession(snapshot, { actorId: "agent-a", currentDirectory: "/", metadata: { sessionId: "native-b" } }, "show")).toMatchObject({ sessionId: "native-b", harness: "codex" });
  // A session the runtime has not recorded yet is the caller's own word, not a mismatch.
  expect(resolveCallerSession(snapshot, { actorId: "agent-a", currentDirectory: "/", metadata: { sessionId: "native-new", harness: "claude" } }, "show")).toEqual({ sessionId: "native-new", harness: "claude" });
  expect(() => resolveCallerSession({ endpoints: { ...endpoints, c: endpoint("agent-c", "session-c", { externalSessionId: "native-c" }) } }, { actorId: "agent-a", currentDirectory: "/", metadata: { sessionId: "native-c" } }, "post")).toThrow("post_session_mismatch_check_caller");
  expect(() => resolveCallerSession(snapshot, { actorId: "agent-a", currentDirectory: "/", metadata: { sessionId: "native-a", harness: "codex" } }, "show")).toThrow("show_harness_mismatch_check_caller");
});

test("show accepts a caller whose native id lives in endpoint metadata", async () => {
  const { workspace, shows } = await fixture();
  await writeFile(join(workspace, "shot.png"), "png");
  const deps = { store: shows, snapshot: () => ({ agents: {}, endpoints: { a: endpoint("agent-a", "session-scout-a", { externalSessionId: "native-a" }) } }) };
  const created = await http(deps as never, "/v1/shows", { method: "POST", body: { path: "shot.png", caller: { actorId: "agent-a", currentDirectory: workspace, metadata: { sessionId: "native-a", harness: "claude" } } } }, handleShowRoute as never);
  expect(created.status).toBe(201);
  expect(created.body.show).toMatchObject({ agentId: "agent-a", sessionId: "native-a", harness: "claude" });
});

test("posts text with links and a file, keeps the author, and survives restart", async () => {
  const { dir, workspace, deps } = await fixture({ a: endpoint("agent-a", "session-scout-a", { externalSessionId: "native-a" }) });
  await writeFile(join(workspace, "shot.png"), "png");
  const caller = { actorId: "agent-a", currentDirectory: workspace, metadata: { sessionId: "native-a", harness: "claude" } };
  const text = await http(deps, "/v1/posts", { method: "POST", body: { text: "  Found the stall: the cache never expires.  ", links: [{ url: "https://example.test/pr/1", title: "PR" }], caller } });
  expect(text.status).toBe(201);
  expect(text.body.post).toMatchObject({ source: "post", text: "Found the stall: the cache never expires.", links: [{ url: "https://example.test/pr/1", title: "PR" }], author: { agentId: "agent-a", sessionId: "native-a", harness: "claude", name: "name of agent-a", nodeId: "node-test" }, project: "workspace" });
  const withFile = await http(deps, "/v1/posts", { method: "POST", body: { text: "The new header", file: "shot.png", milestone: true, caller } });
  expect(withFile.body.post).toMatchObject({ milestone: true, file: { kind: "image", mediaType: "image/png", name: "shot.png" } });
  // The file is a show too, so the Canvas keeps working; the list folds it into the post.
  expect(await deps.shows!.list(workspace)).toHaveLength(1);
  const listed = await http(deps, "/v1/posts");
  expect(listed.body.posts.map((p: { id: string }) => p.id)).toEqual([text.body.post.id, withFile.body.post.id]);
  const restarted = new BrokerPostStore(join(dir, "posts"), "node-test");
  expect((await restarted.list()).map(p => p.id)).toEqual([text.body.post.id, withFile.body.post.id]);
  expect(await restarted.list(text.body.post.createdAt)).toHaveLength(1);
});

test("a show no post carries reads as a post, with since and limit", async () => {
  const { workspace, shows, deps } = await fixture();
  await writeFile(join(workspace, "clip.mp4"), "mp4");
  const show = await shows.show({ path: "clip.mp4", caption: "The flow works", currentDirectory: workspace, agentId: "agent-b", harness: "codex" });
  const posted = await http(deps, "/v1/posts", { method: "POST", body: { text: "Later", caller: { actorId: "agent-b", currentDirectory: workspace } } });
  const listed = await http(deps, "/v1/posts");
  expect(listed.body.posts[0]).toMatchObject({ id: show.id, source: "show", text: "The flow works", author: { agentId: "agent-b", harness: "codex", name: "name of agent-b" }, file: { showId: show.id, kind: "video" } });
  expect((await http(deps, "/v1/posts?limit=1")).body.posts.map((p: { id: string }) => p.id)).toEqual([posted.body.post.id]);
  expect((await http(deps, `/v1/posts?since=${show.createdAt}`)).body.posts).toHaveLength(1);
  expect((await http(deps, "/v1/posts?limit=0")).status).toBe(400);
});

test("refuses remote, browser-origin, empty, oversized and non-http posts", async () => {
  const { workspace, deps } = await fixture();
  const caller = { actorId: "agent-a", currentDirectory: workspace };
  expect((await http(deps, "/v1/posts", { remote: true })).status).toBe(403);
  expect((await http(deps, "/v1/posts", { method: "POST", origin: "https://example.test", body: { text: "x", caller } })).status).toBe(403);
  expect((await http(deps, "/v1/posts", { method: "POST", body: { text: "   ", caller } })).body.error).toBe("post_text_required");
  expect((await http(deps, "/v1/posts", { method: "POST", body: { text: "x".repeat(2001), caller } })).body.error).toBe("invalid_post_request");
  expect((await http(deps, "/v1/posts", { method: "POST", body: { text: "x", links: [{ url: "file:///etc/passwd" }], caller } })).body.error).toBe("post_link_must_be_http");
  await writeFile(join(workspace, ".env"), "SECRET=1");
  expect((await http(deps, "/v1/posts", { method: "POST", body: { text: "x", file: ".env", caller } })).body.error).toBe("show_path_forbidden");
  expect(await deps.store!.list()).toEqual([]);
});

test("keeps the newest records past the cap and recovers from a torn line", async () => {
  const { dir, workspace, store } = await fixture({}, 2);
  const author = { agentId: "agent-a" };
  const first = await store.post({ text: "one", currentDirectory: workspace, author });
  await store.post({ text: "two", currentDirectory: workspace, author });
  await store.post({ text: "three", currentDirectory: workspace, author });
  expect((await store.list()).map(p => p.text)).toEqual(["two", "three"]);
  expect((await store.list()).some(p => p.id === first.id)).toBe(false);
  await appendFile(join(dir, "posts", "posts.jsonl"), '{"id":"torn');
  const restarted = new BrokerPostStore(join(dir, "posts"), "node-test", { records: 10 });
  expect((await restarted.list()).map(p => p.text)).toEqual(["two", "three"]);
  await restarted.post({ text: "four", currentDirectory: workspace, author });
  expect((await new BrokerPostStore(join(dir, "posts"), "node-test").list()).map(p => p.text)).toEqual(["two", "three", "four"]);
});
