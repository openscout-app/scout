// Scout's Board worker.
//
// The runtime starts this process and talks to it over stdio, one JSON object
// per line. The first line is the bootstrap; every later line is one call from
// a closed set of typed operations. The worker is not a Board proxy: it applies
// the fixed profile and `x-board-can` from the bootstrap to every call, holds
// no claim token, cursor or renew timer, and retries nothing a caller sent.
//
// The credential reaches it only as BOARD_TOKEN in its own environment, put
// there by `secret run --map <entry>=BOARD_TOKEN`. The worker reads it once,
// removes it from the environment, and sends it to api.vercel.com only. It
// never reads the Vercel CLI's login: it passes its own `fetch`, so
// `@vercel/board` never runs its credential lookup, and it runs with an empty
// HOME besides.

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

export const WORKER_PROTOCOL = 1;
export const VERCEL_API = "https://api.vercel.com";

/** The closed set. Anything else is refused. */
export const OPERATIONS = Object.freeze([
  "me", "ensureChannel", "events", "tasks", "message", "post", "postById", "createTask", "createBatch", "batch",
  "claim", "renew", "complete", "fail", "release", "labels",
]);
const WRITES = new Set(["ensureChannel", "post", "createTask", "createBatch", "claim", "renew", "complete", "fail", "release", "labels"]);
const SECRET_ENV = ["BOARD_TOKEN", "BOARD_URL", "VERCEL_OIDC_TOKEN", "VERCEL_AUTH_TOKEN", "VERCEL_TOKEN"];
const CLAIM_PATH = /\/messageboard\/.*\/claim\/?$/;
const TEAM = /^[^\s/]{1,128}$/;
const BOARD_NAME = /^[^/]{1,64}$/;
const PROFILE = /^[A-Za-z][A-Za-z0-9-]{0,31}$/;

/** Thrown inside `fetch` to end a claim the SDK would otherwise send again. */
class ClaimStop extends Error {
  constructor(status, retryAfter) {
    super(`claim stopped after HTTP ${status}`);
    this.name = "ClaimStop";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Per-call state, so `fetch` knows which operation it serves. */
export const callContext = new AsyncLocalStorage();

/**
 * The only `fetch` `@vercel/board` gets. It adds the bearer token for
 * api.vercel.com and refuses every other origin and every redirect.
 *
 * A claim is sent once. `@vercel/board` retries a POST that carries an
 * operation ID on 429 and 503, and a claim carries one. Here a claim that
 * answers 429 or 503 ends the call instead, and a second claim send in the
 * same call is refused before it leaves.
 */
export function scoutFetch(token, { upstream = globalThis.fetch, context = callContext } = {}) {
  if (typeof token !== "string" || !token) throw new Error("scoutFetch needs a token");
  return async (input, init = {}) => {
    const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    if (url.origin !== VERCEL_API) throw new Error(`board worker: refused a request to ${url.origin}. The credential goes to ${VERCEL_API} only.`);
    const method = String(init.method ?? request?.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers ?? request?.headers);
    headers.set("authorization", `Bearer ${token}`);
    const call = context.getStore();
    const claim = method === "POST" && CLAIM_PATH.test(url.pathname);
    if (claim) {
      if (!call || call.op !== "claim") throw new Error("board worker: a claim outside the claim operation was refused.");
      if (call.claimSent) {
        call.claimStop ??= { status: 0 };
        throw new ClaimStop(0);
      }
      call.claimSent = true;
    }
    const response = await upstream(request ? new Request(request, { headers, redirect: "error" }) : url.toString(), request ? undefined : { ...init, headers, redirect: "error" });
    if (claim && (response.status === 429 || response.status === 503)) {
      const retryAfter = response.headers.get("retry-after");
      call.claimStop = { status: response.status, retryAfter };
      await response.body?.cancel().catch(() => {});
      throw new ClaimStop(response.status, retryAfter);
    }
    return response;
  };
}

const retryAfterMs = (header) => {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 3_600_000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - Date.now(), 3_600_000)) : undefined;
};

/** How a failed call reads to the runtime. A message never carries a credential. */
export function failureOf(op, error, call) {
  if (error?.name === "AbortError") return { kind: "aborted" };
  if (op === "claim" && call?.claimStop) {
    if (call.claimStop.status === 429) {
      return { kind: "http", status: 429, code: "rate_limited", message: "The board rate limited the claim. It was not taken.", retryAfterMs: retryAfterMs(call.claimStop.retryAfter) };
    }
    return { kind: "unknown", code: "claim_unanswered" };
  }
  const status = Number.isInteger(error?.status) ? error.status : undefined;
  const code = typeof error?.code === "string" && /^[a-z_]{1,64}$/.test(error.code) ? error.code : "remote_error";
  // A write that got no answer, or a gateway error, may have landed.
  if (WRITES.has(op) && (status === undefined || code === "unreachable" || (status >= 500 && status !== 501 && status !== 503))) {
    return { kind: "unknown", code };
  }
  if (op === "claim" && status === 503) return { kind: "unknown", code };
  return {
    kind: "http", status: status ?? 502, code,
    message: typeof error?.message === "string" ? error.message.slice(0, 500) : "The board call failed.",
    ...(typeof error?.hint === "string" ? { hint: error.hint.slice(0, 500) } : {}),
  };
}

const text = (value, what) => {
  if (typeof value !== "string" || !value) throw Object.assign(new Error(`${what} is required`), { status: 400, code: "invalid_request" });
  return value;
};
const notFound = (error) => error?.status === 404;
const withoutMentions = (message) => {
  if (!message || typeof message !== "object") return message;
  const { mentions: _mentions, ...rest } = message;
  return rest;
};
const lease = (value) => Number.isInteger(value) && value > 0 ? value : undefined;

/** The operations. Each takes the narrowed client and plain arguments, and answers plain JSON. */
export const operations = {
  async me(client) {
    const me = await client.me();
    return { actor: me.actor, principal: me.principal, profile: me.profile ?? null, expiresAt: me.expiresAt ?? null };
  },
  async ensureChannel(client, args) {
    const answer = await client.createChannel(text(args.channel, "channel"));
    return { created: answer.created === true };
  },
  async events(client, args, signal) {
    const wait = args.wait === undefined ? undefined : Math.max(0, Math.min(Math.floor(args.wait), 300));
    const page = await client.poll({ channel: text(args.channel, "channel"), ...(args.after ? { after: String(args.after) } : {}), ...(wait !== undefined ? { wait } : {}) }, signal);
    return { events: page.events, cursor: page.cursor };
  },
  async tasks(client, args) {
    const page = await client.tasks.list({
      channel: text(args.channel, "channel"),
      ...(args.state ? { state: args.state } : {}), ...(args.after ? { after: String(args.after) } : {}), ...(args.limit ? { limit: args.limit } : {}),
    });
    return { tasks: page.tasks, cursor: page.cursor ?? null };
  },
  async message(client, args) {
    try { return { message: (await client.thread(text(args.id, "id"))).message }; }
    catch (error) { if (notFound(error)) return { message: null }; throw error; }
  },
  async post(client, args) {
    const input = { text: typeof args.text === "string" ? args.text : "", ...(args.labels ? { labels: args.labels } : {}), id: text(args.id, "id") };
    const message = args.re ? await client.reply(String(args.re), input) : await client.post(text(args.channel, "channel"), input);
    return { message: withoutMentions(message) };
  },
  async postById(client, args) {
    try { return { message: withoutMentions(await client.posted(text(args.id, "id"))) }; }
    catch (error) { if (notFound(error)) return { message: null }; throw error; }
  },
  async createTask(client, args) {
    const answer = await client.tasks.create(text(args.channel, "channel"), {
      text: text(args.text, "text"), id: text(args.id, "id"),
      ...(args.labels ? { labels: args.labels } : {}), ...(args.needs?.length ? { needs: args.needs } : {}),
    });
    return { task: answer.task };
  },
  async createBatch(client, args) {
    if (!Array.isArray(args.tasks)) throw Object.assign(new Error("tasks is required"), { status: 400, code: "invalid_request" });
    return { tasks: await client.tasks.createMany(text(args.channel, "channel"), args.tasks, { id: text(args.id, "id") }) };
  },
  // Vercel's API has no batch lookup by client ID. A batch sent again with the same ID is the same batch.
  async batch() {
    return { tasks: null };
  },
  async claim(client, args, signal) {
    const held = await client.tasks.claim(text(args.taskId, "taskId"), { ...(lease(args.lease) ? { lease: args.lease } : {}), ...(signal ? { signal } : {}) });
    // The token goes to the runtime, which keeps custody of it. Nothing here keeps it.
    return { task: held.task, claim: { epoch: held.epoch, token: held.token, until: held.until } };
  },
  async renew(client, args) {
    const renewed = await client.tasks.held(text(args.taskId, "taskId"), { epoch: args.epoch, token: text(args.token, "token") }).renew(lease(args.lease));
    return { task: renewed.task, until: renewed.until };
  },
  async complete(client, args) {
    return { task: await client.tasks.held(text(args.taskId, "taskId"), { epoch: args.epoch, token: text(args.token, "token") }).complete(typeof args.result === "string" ? args.result : undefined) };
  },
  async fail(client, args) {
    return { task: await client.tasks.held(text(args.taskId, "taskId"), { epoch: args.epoch, token: text(args.token, "token") }).fail(text(args.reason, "reason")) };
  },
  async release(client, args) {
    return { task: await client.tasks.held(text(args.taskId, "taskId"), { epoch: args.epoch, token: text(args.token, "token") }).release() };
  },
  async labels(client, args) {
    const change = args.change && typeof args.change === "object" ? args.change : {};
    await client.label(text(args.id, "id"), {
      ...(change.set ? { set: change.set } : {}), ...(change.unset ? { unset: change.unset } : {}), ...(change.if ? { if: change.if } : {}),
    });
    return {};
  },
};

/** Run one operation in its own call context. Answers `{ ok, value }` or `{ ok: false, error }`. */
export async function runOperation(client, op, args, signal) {
  if (!OPERATIONS.includes(op)) return { ok: false, error: { kind: "protocol", code: "unknown_operation", message: `${String(op).slice(0, 64)} is not a worker operation.` } };
  const call = { op, claimSent: false, claimStop: undefined };
  try {
    const value = await callContext.run(call, () => operations[op](client, args && typeof args === "object" ? args : {}, signal));
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: failureOf(op, error, call) };
  }
}

/** Check the bootstrap line. It names the board and the narrowing; never a credential. */
export function parseBootstrap(line) {
  let value;
  try { value = JSON.parse(line); } catch { throw new Error("The bootstrap is not JSON."); }
  if (!value || value.protocol !== WORKER_PROTOCOL) throw new Error(`The bootstrap must name protocol ${WORKER_PROTOCOL}.`);
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) throw new Error("The bootstrap needs a generation.");
  if (!PROFILE.test(value.profile ?? "")) throw new Error("The bootstrap needs a Board profile name.");
  if (typeof value.can !== "string" || !value.can || value.can.length > 4096) throw new Error("The bootstrap needs the x-board-can text.");
  const target = value.target;
  if (target?.kind === "vercel") {
    if (!TEAM.test(target.team ?? "") || !BOARD_NAME.test(String(target.board ?? "").trim())) throw new Error("The bootstrap needs a Vercel team and a board name.");
  } else if (target?.kind !== "memory") {
    throw new Error("The bootstrap target must be vercel or memory.");
  }
  return { generation: value.generation, profile: value.profile, can: value.can, target };
}

/** Make the narrowed client. Only `scout`'s profile and `can` from the bootstrap; callers cannot change them. */
export async function openClient(bootstrap, { token, upstream } = {}) {
  const { board } = await import("@vercel/board");
  let handle;
  if (bootstrap.target.kind === "memory") {
    const { local } = await import("@vercel/board/backend-local");
    handle = board({ backend: local({ memory: true }) });
  } else {
    handle = board({ team: bootstrap.target.team, name: bootstrap.target.board.trim(), fetch: scoutFetch(token, { upstream }) });
  }
  return handle.as(bootstrap.profile, { can: bootstrap.can });
}

async function main() {
  // Nothing but protocol lines goes to stdout.
  const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  console.log = console.info = console.debug = (...args) => console.error(...args);
  const fatal = (message) => {
    try { write({ fatal: String(message).slice(0, 500) }); } catch { /* the runtime is gone */ }
    process.exit(1);
  };

  const token = process.env.BOARD_TOKEN || undefined;
  for (const name of SECRET_ENV) delete process.env[name];
  delete process.env.NODE_OPTIONS;
  const home = mkdtempSync(join(tmpdir(), "scout-board-worker-"));
  for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) process.env[name] = home;
  process.on("exit", () => { try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } });
  process.on("uncaughtException", (error) => fatal(`uncaught: ${error?.name ?? "error"}: ${error?.message ?? ""}`));
  process.on("unhandledRejection", (error) => fatal(`unhandled: ${error?.name ?? "error"}: ${error?.message ?? ""}`));

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done) process.exit(0);
  let bootstrap;
  try { bootstrap = parseBootstrap(first.value); } catch (error) { fatal(error.message); }
  if (bootstrap.target.kind === "vercel" && !token) {
    fatal("BOARD_TOKEN is not set. The worker starts only under: secret run --map <entry>=BOARD_TOKEN -- <node> <worker>");
  }
  let client;
  try { client = await openClient(bootstrap, { token }); }
  catch (error) { fatal(`The board client did not open: ${error?.message ?? error}`); }
  write({ ready: true, protocol: WORKER_PROTOCOL, generation: bootstrap.generation });

  const running = new Map();
  for await (const line of lines) {
    let message;
    try { message = JSON.parse(line); } catch { fatal("A call line is not JSON."); }
    if (message && typeof message.cancel === "number") { running.get(message.cancel)?.abort(); continue; }
    const id = message?.id;
    if (!Number.isSafeInteger(id)) fatal("A call has no id.");
    if (message.gen !== bootstrap.generation) {
      write({ id, ok: false, error: { kind: "protocol", code: "stale_generation", message: `This worker is generation ${bootstrap.generation}.` } });
      continue;
    }
    const controller = new AbortController();
    running.set(id, controller);
    void runOperation(client, message.op, message.args, controller.signal).then((answer) => {
      running.delete(id);
      write({ id, ...answer });
    });
  }
  // The runtime closed stdin: stop.
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
