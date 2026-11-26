// Worker tests against @vercel/board's own Vercel backend, with a stub in
// place of Vercel's API. No network: the stub answers every request.
import assert from "node:assert/strict";
import { test } from "node:test";
import { READ_ONLY_CAN, boardReader, clientsFor, failureOf, openClient, parseBootstrap, runOperation, scoutFetch } from "../src/worker.mjs";

const TASK = "msg_00000000-0000-4000-8000-000000000001_1";
const bootstrap = { generation: 1, profile: "scout", can: "work=read,post,react,label;scout-probe=read,post,react,label", target: { kind: "vercel", team: "team_test", board: "scout" } };

function stubApi(answerClaim) {
  const calls = [];
  const upstream = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    calls.push({ method: init.method ?? "GET", url: String(url), authorization: headers.get("authorization"), profile: headers.get("x-board-profile"), can: headers.get("x-board-can"), redirect: init.redirect });
    const path = new URL(url).pathname;
    if (path.endsWith("/claim")) return answerClaim();
    if (path.endsWith("/boards")) return Response.json({ boards: [{ id: "brd_test", name: "scout" }] });
    if (path.endsWith("/boards/brd_test")) return Response.json({ board: { id: "brd_test", name: "scout" } });
    return Response.json({ error: { code: "not_found", message: "Not here." } }, { status: 404 });
  };
  return { calls, upstream, claims: () => calls.filter(call => call.url.includes("/claim")).length };
}

test("the board list names the team's boards, and another board's channels are read by name, narrowed to read, and never made", async () => {
  const calls = [];
  const boards = [{ id: "brd_test", name: "scout" }, { id: "brd_other", name: "Design" }, { id: "brd_general", name: "General" }];
  const upstream = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    const parsed = new URL(url);
    calls.push({ method: init.method ?? "GET", path: parsed.pathname, query: parsed.search, can: headers.get("x-board-can"), authorization: headers.get("authorization") });
    if (parsed.pathname === "/v1/messageboard/boards") {
      const name = parsed.searchParams.get("name");
      return Response.json({ boards: name ? boards.filter(board => board.name.toLowerCase() === name.toLowerCase()) : boards, defaultBoardId: "brd_general" });
    }
    const one = /^\/v1\/messageboard\/boards\/([^/]+)$/.exec(parsed.pathname);
    if (one) return Response.json({ board: boards.find(board => board.id === one[1]) });
    if (parsed.pathname === "/v1/messageboard/boards/brd_other/channels") return Response.json({ channels: [{ id: "ch_1", name: "design/reviews" }, { id: "ch_2", name: "scout/decisions" }] });
    return Response.json({ error: { code: "not_found", message: "Not here." } }, { status: 404 });
  };
  const handle = { as: () => { throw new Error("the connected board's handle is not used for another board"); } };
  const reader = boardReader(bootstrap, handle, { token: "test-token", upstream });
  const listed = await runOperation(null, "boards", {}, undefined, reader);
  assert.deepEqual(listed, { ok: true, value: { boards: [
    { id: "brd_test", name: "scout", isDefault: false, connected: true },
    { id: "brd_other", name: "Design", isDefault: false, connected: false },
    { id: "brd_general", name: "General", isDefault: true, connected: false },
  ] } });
  const channels = await runOperation(null, "channels", { board: "brd_other" }, undefined, reader);
  assert.deepEqual(channels, { ok: true, value: { channels: [{ channel: "design/reviews" }, { channel: "scout/decisions" }], next: null } });
  assert.equal(calls.filter(call => call.method !== "GET").length, 0, "a read makes no board and no channel");
  for (const call of calls) assert.equal(call.authorization, "Bearer test-token");
  const channelReads = calls.filter(call => call.path.endsWith("/channels"));
  assert.ok(channelReads.length >= 1);
  for (const call of channelReads) assert.equal(call.can, READ_ONLY_CAN);
  assert.deepEqual(await runOperation(null, "channels", { board: "../x" }, undefined, reader), { ok: false, error: { kind: "http", status: 400, code: "invalid_request", message: "board must be a board ID" } });
});

test("a claim that answers 503 is sent once and reads as outcome unknown", async () => {
  const api = stubApi(() => Response.json({ error: { code: "unavailable", message: "Busy." } }, { status: 503 }));
  const client = await openClient(bootstrap, { token: "test-token", upstream: api.upstream });
  const answer = await runOperation(client, "claim", { taskId: TASK, lease: 60 });
  assert.deepEqual(answer, { ok: false, error: { kind: "unknown", code: "claim_unanswered" } });
  assert.equal(api.claims(), 1);
});

test("a claim that answers 429 is sent once and reads as a refusal", async () => {
  const api = stubApi(() => Response.json({ error: { code: "rate_limited", message: "Slow down." } }, { status: 429, headers: { "retry-after": "7" } }));
  const client = await openClient(bootstrap, { token: "test-token", upstream: api.upstream });
  const answer = await runOperation(client, "claim", { taskId: TASK, lease: 60 });
  assert.equal(answer.ok, false);
  assert.equal(answer.error.kind, "http");
  assert.equal(answer.error.status, 429);
  assert.equal(answer.error.retryAfterMs, 7000);
  assert.equal(api.claims(), 1);
});

test("a claim with no answer is sent once and reads as outcome unknown", async () => {
  const api = stubApi(() => { throw new TypeError("fetch failed"); });
  const client = await openClient(bootstrap, { token: "test-token", upstream: api.upstream });
  const answer = await runOperation(client, "claim", { taskId: TASK, lease: 60 });
  assert.equal(answer.error.kind, "unknown");
  assert.equal(api.claims(), 1);
});

test("every request carries the token, the scout profile and the fixed x-board-can, and refuses redirects", async () => {
  const api = stubApi(() => Response.json({ error: { code: "unavailable" } }, { status: 503 }));
  const client = await openClient(bootstrap, { token: "test-token", upstream: api.upstream });
  const lookup = api.calls.length;
  await runOperation(client, "claim", { taskId: TASK });
  assert.ok(api.calls.length > lookup);
  for (const call of api.calls.slice(lookup)) {
    assert.ok(call.url.startsWith("https://api.vercel.com/"));
    assert.equal(call.authorization, "Bearer test-token");
    assert.equal(call.profile, "scout");
    assert.equal(call.can, bootstrap.can);
    assert.equal(call.redirect, "error");
  }
});

test("the board is found as the person, before narrowing, so a narrowed caller never has to make it", async () => {
  const api = stubApi(() => Response.json({ error: { code: "unavailable" } }, { status: 503 }));
  await openClient(bootstrap, { token: "test-token", upstream: api.upstream });
  assert.ok(api.calls.length >= 1);
  for (const call of api.calls) {
    assert.ok(new URL(call.url).pathname.includes("/boards"));
    assert.equal(call.can, null);
    assert.equal(call.method, "GET");
  }
});

test("a board that cannot be found or made names the fix", async () => {
  const upstream = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/boards/ensure")) return Response.json({ error: { code: "forbidden", message: "Plan limit." } }, { status: 403 });
    if (path.endsWith("/me")) return Response.json({ actor: { principal: { type: "user", id: "u_1" } }, teamId: "team_test" });
    return Response.json({ boards: [] });
  };
  await assert.rejects(openClient(bootstrap, { token: "test-token", upstream }), /--board General/);
});

test("the token goes to api.vercel.com only", async () => {
  let sent = 0;
  const fetch = scoutFetch("test-token", { upstream: async () => { sent++; return new Response("{}"); } });
  await assert.rejects(fetch("https://example.com/v1/messageboard/me", {}), /api\.vercel\.com only/);
  await assert.rejects(fetch("http://api.vercel.com/v1/messageboard/me", {}), /api\.vercel\.com only/);
  assert.equal(sent, 0);
});

test("a claim outside the claim operation is refused before it leaves", async () => {
  let sent = 0;
  const fetch = scoutFetch("test-token", { upstream: async () => { sent++; return new Response("{}"); } });
  await assert.rejects(fetch(`https://api.vercel.com/v2/messageboard/boards/b/tasks/t/claim`, { method: "POST" }), /outside the claim operation/);
  assert.equal(sent, 0);
});

test("operations outside the closed set are refused", async () => {
  const answer = await runOperation({}, "request", { path: "/anything" });
  assert.equal(answer.error.code, "unknown_operation");
  const proxy = await runOperation({}, "__proto__", {});
  assert.equal(proxy.error.code, "unknown_operation");
});

test("a write without an answer may have landed; a read without one did not", () => {
  const unreachable = Object.assign(new Error("Vercel's API didn't answer"), { status: 502, code: "unreachable" });
  assert.equal(failureOf("post", unreachable).kind, "unknown");
  assert.equal(failureOf("complete", Object.assign(new Error("gateway"), { status: 504, code: "remote_error" })).kind, "unknown");
  assert.equal(failureOf("events", unreachable).kind, "http");
  assert.equal(failureOf("post", Object.assign(new Error("busy"), { status: 503, code: "unavailable" })).kind, "http");
  assert.equal(failureOf("claim", Object.assign(new Error("busy"), { status: 503, code: "unavailable" })).kind, "unknown");
  assert.equal(failureOf("renew", Object.assign(new Error("lost"), { status: 409, code: "claim_lost" })).code, "claim_lost");
});

test("the bootstrap names a board and a narrowing, never a credential", () => {
  assert.throws(() => parseBootstrap(JSON.stringify({ ...bootstrap, protocol: 2 })), /protocol 1/);
  assert.throws(() => parseBootstrap(JSON.stringify({ ...bootstrap, protocol: 1, target: { kind: "vercel", team: "team_test" } })), /team and a board/);
  assert.throws(() => parseBootstrap(JSON.stringify({ ...bootstrap, protocol: 1, target: { kind: "url", url: "https://example.com" } })), /vercel or memory/);
  assert.throws(() => parseBootstrap(JSON.stringify({ ...bootstrap, protocol: 1, profile: "not a profile" })), /profile/);
  const parsed = parseBootstrap(JSON.stringify({ ...bootstrap, protocol: 1, token: "ignored" }));
  assert.equal("token" in parsed, false);
});

test("a call writes only as a profile from the bootstrap's list, or as the principal", () => {
  const line = { protocol: 1, generation: 1, profile: "scout", can: "work=read,post", target: { kind: "memory" } };
  assert.deepEqual(parseBootstrap(JSON.stringify(line)).profiles, ["scout"]);
  assert.throws(() => parseBootstrap(JSON.stringify({ ...line, profiles: ["reviewer"] })), /include its profile/);
  assert.throws(() => parseBootstrap(JSON.stringify({ ...line, profiles: ["scout", "no spaces"] })), /profile names/);
  const asked = [];
  const handle = { as: (profile, options) => { asked.push([profile, options.can]); return { profile }; } };
  const clientFor = clientsFor(handle, parseBootstrap(JSON.stringify({ ...line, profiles: ["scout", "reviewer"] })));
  assert.equal(clientFor(undefined).profile, "scout");
  assert.equal(clientFor("reviewer").profile, "reviewer");
  assert.equal(clientFor(null).profile, null);
  assert.equal(clientFor("builder"), undefined);
  assert.equal(clientFor("reviewer").profile, "reviewer");
  // Each is narrowed by the bootstrap's can, and made once.
  assert.deepEqual(asked, [["scout", "work=read,post"], ["reviewer", "work=read,post"], [null, "work=read,post"]]);
});
