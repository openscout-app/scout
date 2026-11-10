import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { BrokerShowStore, assertShowPath } from "./broker-show-store.js";
import { handleShowRoute, showByteRange } from "./broker-shows-http.js";
import type { RuntimeHttpRequestLike, RuntimeHttpResponseLike } from "./portable-types.js";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture(limits = { fileBytes: 128, storeBytes: 256, records: 100 }) {
  const dir = await mkdtemp(join(tmpdir(), "scout-shows-")); dirs.push(dir);
  const workspace = join(dir, "workspace"); await mkdir(workspace);
  const store = new BrokerShowStore(join(dir, "store"), "node-test", limits);
  return { dir, workspace, store, input: { path: "result.txt", currentDirectory: workspace, agentId: "agent-test", sessionId: "session-test", harness: "codex" } };
}
test("keeps fixed bytes, versions and identity across restart, emits only committed records", async () => {
  const { dir, workspace, store, input } = await fixture();
  const events: string[] = []; store.subscribe(show => events.push(show.id));
  await writeFile(join(workspace, input.path), "first");
  const first = await store.show({ ...input, caption: "Review this" });
  await writeFile(join(workspace, input.path), "second");
  const second = await store.show(input);
  expect(second.itemId).toBe(first.itemId); expect(second.supersedes).toBe(first.id);
  expect(await readFile(store.blobPath(first.id), "utf8")).toBe("first");
  expect(second.sha256).not.toBe(first.sha256);
  expect(first).toMatchObject({ agentId: "agent-test", sessionId: "session-test", nodeId: "node-test", caption: "Review this", kind: "document" });
  const restarted = new BrokerShowStore(join(dir, "store"), "node-test");
  expect(await restarted.list(workspace, first.createdAt)).toEqual([second]);
  expect(events).toEqual([first.id, second.id]);
});
test("caps individual files and evicts only superseded versions, never newest", async () => {
  const { workspace, store, input } = await fixture({ fileBytes: 10, storeBytes: 12, records: 100 });
  await writeFile(join(workspace, input.path), "123456"); const first = await store.show(input);
  const second = await store.show(input);
  const third = await store.show(input);
  await expect(store.get(first.id)).rejects.toThrow("show_not_found");
  expect(await store.get(second.id)).toBeDefined(); expect(await store.get(third.id)).toBeDefined();
  await writeFile(join(workspace, "another.txt"), "123456");
  const another = await store.show({ ...input, path: "another.txt" });
  expect(await store.get(third.id)).toBeDefined(); expect(await store.get(another.id)).toBeDefined();
  await expect(store.show({ ...input, path: "another.txt" })).rejects.toThrow("show_store_full_newest_protected");
  await writeFile(join(workspace, input.path), "12345678901");
  await expect(store.show(input)).rejects.toThrow("show_file_too_large");
});
test("denies secret paths, symlink laundering, outside-workspace paths and directories", async () => {
  const { dir, workspace, store, input } = await fixture();
  for (const path of ["/project/.env", "/project/.env.local", "/project/.ssh/key", "/project/.codex/sessions/log", "/project/credentials.json", "/project/key.pem"]) expect(() => assertShowPath(path)).toThrow("show_path_forbidden");
  await writeFile(join(workspace, ".env"), "secret"); await symlink(join(workspace, ".env"), join(workspace, "safe.txt"));
  await expect(store.show({ ...input, path: "safe.txt" })).rejects.toThrow("show_path_forbidden");
  await writeFile(join(dir, "outside.txt"), "outside");
  await expect(store.show({ ...input, path: "../outside.txt" })).rejects.toThrow("show_outside_worktree");
  await expect(store.show({ ...input, path: "." })).rejects.toThrow("show_requires_regular_file");
});
test("parses bounded, open-ended and suffix ranges; rejects invalid or multipart ranges", () => {
  expect(showByteRange(undefined, 10)).toBeUndefined();
  expect(showByteRange("bytes=2-5", 10)).toEqual([2, 5]);
  expect(showByteRange("bytes=2-", 10)).toEqual([2, 9]);
  expect(showByteRange("bytes=-3", 10)).toEqual([7, 9]);
  expect(showByteRange("bytes=0-100", 10)).toEqual([0, 9]);
  for (const range of ["bytes=10-", "bytes=5-2", "bytes=-0", "bytes=0-1,3-4", "bytes=-", "words=1-2"]) expect(() => showByteRange(range, 10)).toThrow();
  expect(() => showByteRange("bytes=0-", 0)).toThrow();
});
async function http(store: BrokerShowStore, path: string, options: { method?: string; body?: unknown; range?: string; remote?: boolean } = {}) {
  const req = new EventEmitter() as EventEmitter & RuntimeHttpRequestLike;
  Object.assign(req, { method: options.method || "GET", headers: { "content-type": "application/json", range: options.range }, transportContext: { transport: options.remote ? "remote" : "loopback" }, resume() {}, destroy() {} });
  const res = new EventEmitter() as EventEmitter & RuntimeHttpResponseLike;
  let status = 0; let headers: Record<string, unknown> = {}; const chunks: Buffer[] = [];
  Object.assign(res, { writeHead(code: number, values: Record<string, unknown>) { status = code; headers = values; }, write(chunk: string | Buffer) { chunks.push(Buffer.from(chunk)); return true; }, end(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)); }, getHeader(name: string) { return headers[name]; } });
  const pending = handleShowRoute(req, res, new URL(path, "http://localhost"), { store, snapshot: () => ({ agents: { "agent-test": { id: "agent-test" } } as never, endpoints: {} }) });
  if (options.body) { req.emit("data", Buffer.from(JSON.stringify(options.body))); req.emit("end"); }
  await pending;
  return { status, headers, bytes: Buffer.concat(chunks) };
}
test("local create/list/capability and byte GET, remote refusal, range 206 and 416", async () => {
  const { workspace, store, input } = await fixture(); await writeFile(join(workspace, input.path), "abcdef");
  const created = await http(store, "/v1/shows", { method: "POST", body: { path: input.path, caption: "Look", caller: { actorId: input.agentId, currentDirectory: workspace } } });
  expect(created.status).toBe(201); const show = JSON.parse(created.bytes.toString()).show;
  expect((await http(store, "/v1/shows/capability")).bytes.toString()).toContain('"shows.v1":true');
  expect((await http(store, `/v1/shows?projectRoot=${encodeURIComponent(workspace)}`)).bytes.toString()).toContain(show.id);
  const bytes = await http(store, `/v1/shows/${show.id}/bytes`, { range: "bytes=1-3" });
  expect(bytes.status).toBe(206); expect(bytes.bytes.toString()).toBe("bcd");
  expect(bytes.headers["content-range"]).toBe("bytes 1-3/6");
  expect(bytes.headers["content-disposition"]).toBe("attachment");
  expect((await http(store, `/v1/shows/${show.id}/bytes`, { range: "bytes=99-" })).status).toBe(416);
  expect((await http(store, "/v1/shows/capability", { remote: true })).status).toBe(403);
  expect((await http(store, `/v1/shows/${show.id}/bytes`, { remote: true })).status).toBe(403);
});

test("event stream filters by canonical project and only publishes committed shows", async () => {
  const { workspace, store, input } = await fixture();
  const req = new EventEmitter() as EventEmitter & RuntimeHttpRequestLike;
  Object.assign(req, { method: "GET", headers: {}, transportContext: { transport: "loopback" }, resume() {}, destroy() {} });
  const res = new EventEmitter() as EventEmitter & RuntimeHttpResponseLike;
  let text = ""; let status = 0;
  Object.assign(res, { writeHead(code: number) { status = code; }, write(chunk: string) { text += chunk; return true; }, end() {} });
  await handleShowRoute(req, res, new URL(`/v1/shows/events?projectRoot=${encodeURIComponent(workspace)}`, "http://localhost"), { store, snapshot: () => ({ agents: {}, endpoints: {} }) });
  try {
    expect(status).toBe(200);
    await writeFile(join(workspace, input.path), "finished"); const show = await store.show(input);
    expect(text).toContain("event: show.created"); expect(text).toContain(show.id);
    const before = text;
    await writeFile(join(workspace, input.path), "x".repeat(129));
    await expect(store.show(input)).rejects.toThrow("show_file_too_large"); expect(text).toBe(before);
  } finally { res.emit("close"); }
});

test("linked worktrees join one canonical project while preserving worktree and branch", async () => {
  const { execSystemFile } = await import("./system-probes/exec.js");
  const { dir, workspace, store, input } = await fixture();
  const git = (args: string[]) => execSystemFile("git", args, { cwd: workspace, timeoutMs: 3000 });
  await git(["init"]);
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "Initial fixture"]);
  const linked = join(dir, "linked"); await git(["worktree", "add", "-b", "show-fixture", linked]);
  await writeFile(join(linked, input.path), "linked");
  const show = await store.show({ ...input, currentDirectory: linked });
  const { realpath } = await import("node:fs/promises");
  expect(show.projectRoot).toBe(await realpath(workspace)); expect(show.worktree).toBe(await realpath(linked)); expect(show.branch).toBe("show-fixture");
  expect(await store.list(workspace)).toEqual([show]);
});

test("concurrent copies fail boundedly and hardlinks cannot launder source provenance", async () => {
  const { workspace, store, input } = await fixture();
  await writeFile(join(workspace, input.path), "result");
  const pending = store.show(input);
  await expect(store.show(input)).rejects.toThrow("show_busy_retry"); await pending;
  const { link } = await import("node:fs/promises");
  await link(join(workspace, input.path), join(workspace, "linked.txt"));
  await expect(store.show({ ...input, path: "linked.txt" })).rejects.toThrow("show_hardlink_forbidden");
});
