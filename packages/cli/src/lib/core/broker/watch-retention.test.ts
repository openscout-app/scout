import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveScoutBrokerUrl, watchScoutMessages } from "./service.ts";
import { resolveBrokerSocketPathForBaseUrl } from "@openscout/runtime/daemon";
import { WatchFrameAccumulator, WatchReferenceCache, WATCH_FRAME_CHARACTER_LIMIT, WATCH_REFERENCE_LIMIT } from "./watch-retention.ts";
const originalFetch = globalThis.fetch;
let fixtureHome: string;
let originalEnvironment: Record<string, string | undefined>;
const ownsEnvironmentKey = (key: string) => key === "HOME" || key.startsWith("SCOUT_") || key.startsWith("OPENSCOUT_");
beforeEach(() => {
  originalEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => ownsEnvironmentKey(key)));
  for (const key of Object.keys(process.env)) if (ownsEnvironmentKey(key)) delete process.env[key];
  fixtureHome = mkdtempSync(join(tmpdir(), "scout-watch-test-"));
  process.env.HOME = fixtureHome;
  process.env.OPENSCOUT_HOME = join(fixtureHome, ".openscout");
  process.env.OPENSCOUT_BROKER_INTERNAL_URL = "http://watch-retention.test";
  process.env.OPENSCOUT_BROKER_URL = "http://watch-retention.test";
  process.env.OPENSCOUT_BROKER_SOCKET_PATH = join(fixtureHome, "absent.sock");
  // Unix transport checks existence before connecting. Its only fallback is the
  // fetch stub each test owns, never the developer's broker URL or live socket.
  const socket = resolveBrokerSocketPathForBaseUrl(resolveScoutBrokerUrl());
  expect(socket).toBe(join(fixtureHome, "absent.sock"));
  expect(existsSync(socket!)).toBe(false);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (ownsEnvironmentKey(key)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  rmSync(fixtureHome, { recursive: true, force: true });
});
const frame = (kind: string, key: string, value: unknown) =>
  new TextEncoder().encode(`event: ${kind}\ndata: ${JSON.stringify({ kind, payload: { [key]: value } })}\n\n`);
const message = (id: string) => ({ id, conversationId: "conversation", body: "payload", metadata: { clientMessageId: `client-${id}` } });
const invocation = (id: string) => ({ id: `inv-${id}`, messageId: id, conversationId: "conversation", targetAgentId: "worker" });

test("watch caches evict by count and identifier size, including replacement", () => {
  const cache = new WatchReferenceCache<{ id: string; clientMessageId: string }>();
  for (let i = 0; i <= WATCH_REFERENCE_LIMIT; i++) cache.set({ id: String(i), clientMessageId: "client" });
  expect(cache.get("0")).toBeUndefined();
  expect(cache.get(String(WATCH_REFERENCE_LIMIT))?.clientMessageId).toBe("client");
  cache.set({ id: "last", clientMessageId: "x".repeat(70_000) });
  cache.set({ id: "new", clientMessageId: "x".repeat(70_000) });
  expect(cache.get("last")).toBeUndefined();
  cache.set({ id: "new", clientMessageId: "small" });
  expect(cache.get("new")?.clientMessageId).toBe("small");
  cache.set({ id: "unbounded", clientMessageId: "x".repeat(200_000) });
  expect(cache.get("unbounded")).toBeUndefined();
});

test("frames are bounded across reads, not the total size of multiple valid frames", () => {
  const frames = new WatchFrameAccumulator(128 * 1024);
  expect([...frames.push("data: a\n")]).toEqual([]);
  expect([...frames.push("\ndata: b\n\n")]).toEqual(["data: a", "data: b"]);
  expect(WATCH_FRAME_CHARACTER_LIMIT).toBe(64 * 1024 * 1024);
  const valid = "a".repeat(70_000);
  expect([...frames.push(`${valid}\n\n${valid}\n\n`)]).toEqual([valid, valid]);
  const chunk = "x".repeat(64 * 1024);
  for (let i = 0; i < 128 * 1024 / chunk.length; i++) expect([...frames.push(chunk)]).toEqual([]);
  expect(() => [...frames.push("xx")]).toThrow("Scout watch SSE frame exceeds");
  expect([...frames.push("data: healthy\n\n")]).toEqual(["data: healthy"]);
});

test("lifecycle correlation survives both cache eviction and pre-watch records without a full snapshot", async () => {
  const lookups: string[] = [];
  const lifecycle: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/v1/events/stream") return new Response(new ReadableStream<Uint8Array>({ start(c) {
      for (let i = 0; i <= WATCH_REFERENCE_LIMIT; i++) {
        c.enqueue(frame("message.posted", "message", message(String(i))));
        c.enqueue(frame("invocation.requested", "invocation", invocation(String(i))));
      }
      c.enqueue(frame("flight.updated", "flight", { id: "flight-0", invocationId: "inv-0", state: "completed", targetAgentId: "worker" }));
      c.enqueue(frame("delivery.state.changed", "delivery", { invocationId: "inv-before", messageId: "before", targetId: "worker", status: "acknowledged" }));
      c.close();
    } }));
    lookups.push(path);
    if (path.startsWith("/v1/invocations/")) return Response.json({ invocation: invocation(path.split("inv-")[1]) });
    if (path.startsWith("/v1/messages/")) return Response.json({ message: message(path.split("/").at(-1)!) });
    throw Error(`unexpected full-snapshot or live route ${path}`);
  }) as unknown as typeof fetch;
  await watchScoutMessages({ allConversations: true, onMessage() {}, onLifecycle(record) { lifecycle.push(record); } });
  expect(lifecycle.slice(-2)).toEqual([
    expect.objectContaining({ conversationId: "conversation", messageId: "0", clientMessageId: "client-0", invocationId: "inv-0", flightId: "flight-0", state: "completed" }),
    expect.objectContaining({ conversationId: "conversation", messageId: "before", clientMessageId: "client-before", invocationId: "inv-before", state: "acknowledged" }),
  ]);
  expect(lookups).toEqual(["/v1/invocations/inv-0", "/v1/messages/0", "/v1/invocations/inv-before", "/v1/messages/before"]);
});

test("cancellation releases a pending reader and never calls back after abort", async () => {
  let cancelled = false;
  let ready!: () => void;
  const opened = new Promise<void>(resolve => { ready = resolve; });
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({ start() { ready(); }, cancel() { cancelled = true; } }))) as unknown as typeof fetch;
  const controller = new AbortController();
  const watching = watchScoutMessages({ allConversations: true, signal: controller.signal, onMessage() { throw Error("post-abort callback"); } });
  await opened; await Bun.sleep(0); controller.abort(); await watching;
  expect(cancelled).toBe(true);
  globalThis.fetch = (() => { throw Error("already aborted must not fetch"); }) as unknown as typeof fetch;
  await watchScoutMessages({ allConversations: true, signal: controller.signal, onMessage() {} });
});

test("cancellation also interrupts a durable correlation miss", async () => {
  let lookupStarted!: () => void;
  const lookingUp = new Promise<void>(resolve => { lookupStarted = resolve; });
  let cancelled = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === "/v1/events/stream") return new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(frame("flight.updated", "flight", { id: "flight", invocationId: "cold" })); },
      cancel() { cancelled = true; },
    }));
    lookupStarted();
    return new Promise<Response>((_, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    });
  }) as unknown as typeof fetch;
  const controller = new AbortController();
  const watching = watchScoutMessages({ allConversations: true, signal: controller.signal,
    onMessage() {}, onLifecycle() { throw Error("post-abort lifecycle"); },
  });
  await lookingUp; controller.abort(); await watching;
  expect(cancelled).toBe(true);
});

test("consumer failure cancels and releases the stream", async () => {
  let cancelled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(frame("message.posted", "message", message("0"))); }, cancel() { cancelled = true; } }))) as unknown as typeof fetch;
  await expect(watchScoutMessages({ allConversations: true, onMessage() { throw Error("consumer failure"); } })).rejects.toThrow("consumer failure");
  expect(cancelled).toBe(true);
});

test("500 messages and invocation prompts of 64 KiB do not remain in an open watcher", async () => {
  const home = mkdtempSync(join(tmpdir(), "scout-watch-heap-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENSCOUT_") && !key.startsWith("SCOUT_")));
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/watch-retained-heap.ts")], { env: { ...env, HOME: home }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0); expect(stderr).toBe("");
    const result = JSON.parse(stdout);
    console.log(JSON.stringify({ event: "watch-retained-heap", ...result }));
    expect(result.received).toBe(500); expect(result.lifecycles).toBe(500);
    expect(Math.max(...result.samples) - result.empty).toBeLessThan(3 * 1024 * 1024);
    expect(result.closed - result.empty).toBeLessThan(1024 * 1024);
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; rmSync(home, { recursive: true, force: true }); }
}, 20000);
