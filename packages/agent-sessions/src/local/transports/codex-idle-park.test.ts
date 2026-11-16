import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getOrCreateCodexAppServerClient,
  isCodexAppServerLocalAgentAlive,
  resolveCodexIdleParkMs,
  shutdownCodexAppServerLocalAgent,
  type CodexAppServerSessionOptions,
} from "./codex-app-server.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A stdio Codex that logs each app-server launch and resume, and holds "slow"
 * turns open. Like Codex, it writes the thread's rollout on the first turn;
 * `writesRollout: false` models a thread Codex never wrote.
 */
function fakeCodex(dir: string, writesRollout: boolean): { executable: string; log: string } {
  const executable = join(dir, "fake-codex");
  const log = join(dir, "calls.log");
  writeFileSync(executable, `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";
const log = ${JSON.stringify(log)};
const rollout = ${JSON.stringify(join(dir, "thread-park.jsonl"))};
const writesRollout = ${JSON.stringify(writesRollout)};
if (process.argv[2] === "mcp") process.exit(1);
appendFileSync(log, "launch " + process.pid + " " + process.argv.slice(2).join(" ") + "\\n");
const say = (message) => console.log(JSON.stringify(message));
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const { id, method, params = {} } = JSON.parse(line);
  if (method === "thread/start" || method === "thread/resume") {
    if (method === "thread/resume") appendFileSync(log, "resume " + params.threadId + "\\n");
    const thread = { id: params.threadId ?? "thread-park", path: rollout };
    say({ id, result: { thread } });
    continue;
  }
  if (method === "turn/start") {
    const threadId = params.threadId;
    const text = params.input?.[0]?.text ?? "";
    if (writesRollout) writeFileSync(rollout, "{}\\n");
    say({ id, result: { turn: { id: "turn-" + id } } });
    say({ method: "turn/started", params: { threadId, turn: { id: "turn-" + id } } });
    const finish = () => {
      say({ method: "item/completed", params: { threadId, turnId: "turn-" + id, item: { type: "agentMessage", id: "m-" + id, text: "reply to " + text } } });
      say({ method: "turn/completed", params: { threadId, turn: { id: "turn-" + id, status: "completed" } } });
    };
    if (text === "slow") setTimeout(finish, 500); else finish();
    continue;
  }
  say({ id, result: {} });
}
`, "utf8");
  chmodSync(executable, 0o755);
  writeFileSync(log, "", "utf8");
  return { executable, log };
}

let sessionCounter = 0;
function session(idleParkMs: number, writesRollout = true): { options: CodexAppServerSessionOptions; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "cx-park-"));
  const { executable, log } = fakeCodex(dir, writesRollout);
  const name = `park-test-${process.pid}-${++sessionCounter}`;
  const options: CodexAppServerSessionOptions = {
    agentName: name, sessionId: name, cwd: dir, systemPrompt: "test",
    runtimeDirectory: join(dir, "rt"), logsDirectory: join(dir, "logs"),
    env: { OPENSCOUT_CODEX_BIN: executable, OPENSCOUT_SCOUT_MCP: "off" },
    startupTimeoutMs: 5_000, idleParkMs,
  };
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => shutdownCodexAppServerLocalAgent(options));
  return { options, log };
}

const launches = (log: string) => readFileSync(log, "utf8").split("\n").filter((line) => line.startsWith("launch ") && line.endsWith(" app-server"));
const resumes = (log: string) => readFileSync(log, "utf8").split("\n").filter((line) => line.startsWith("resume "));
const processExists = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Parked and finished stopping: while the stop runs, the session observes as unknown. */
const settledParked = (client: ReturnType<typeof getOrCreateCodexAppServerClient>) =>
  client.isParked && !client.isAlive() && client.observeExisting().state === "idle";

async function eventually(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(20);
  }
}

test("the window defaults to 60 minutes and reads OPENSCOUT_CODEX_IDLE_PARK_MS", () => {
  expect(resolveCodexIdleParkMs(undefined, {})).toBe(60 * 60 * 1000);
  expect(resolveCodexIdleParkMs(undefined, { OPENSCOUT_CODEX_IDLE_PARK_MS: "0" })).toBe(0);
  expect(resolveCodexIdleParkMs(undefined, { OPENSCOUT_CODEX_IDLE_PARK_MS: "junk" })).toBe(60 * 60 * 1000);
  expect(resolveCodexIdleParkMs(250, { OPENSCOUT_CODEX_IDLE_PARK_MS: "0" })).toBe(250);
});

test("an idle session parks, stays routable, and the next send resumes the same thread", async () => {
  const { options, log } = session(150);
  const client = getOrCreateCodexAppServerClient(options);
  expect((await client.send("hello")).output).toBe("reply to hello");
  const threadId = client.threadId;
  const firstPid = client.identity?.pid ?? 0;
  expect(firstPid).toBeGreaterThan(0);

  await eventually(() => settledParked(client));
  await eventually(() => !processExists(firstPid));
  expect(client.isAlive()).toBe(false);
  expect(isCodexAppServerLocalAgentAlive(options)).toBe(true);
  expect(client.observeExisting().state).toBe("idle");

  // A promoted provider thread id names the same session; it must not replace (and reset) it.
  expect(getOrCreateCodexAppServerClient({ ...options, threadId: threadId! })).toBe(client);

  const again = await client.send("again");
  expect(again.output).toBe("reply to again");
  expect(again.threadId).toBe(threadId);
  expect(client.isParked).toBe(false);
  expect(launches(log)).toHaveLength(2);
  expect(resumes(log)).toEqual([`resume ${threadId}`]);
});

test("each interaction restarts the window", async () => {
  const { options } = session(400);
  const client = getOrCreateCodexAppServerClient(options);
  await client.send("one");
  await sleep(250);
  await client.send("two");
  await sleep(300); // 550 ms after the first send, 300 ms after the second
  expect(client.isParked).toBe(false);
  expect(client.isAlive()).toBe(true);
  await eventually(() => settledParked(client));
});

test("a turn in progress is never parked", async () => {
  const { options } = session(100);
  const client = getOrCreateCodexAppServerClient(options);
  const reply = client.send("slow");
  await eventually(() => client.isAlive() && client.hasActiveTurn());
  await sleep(250); // past the 100 ms window, inside the 500 ms turn
  expect(client.isParked).toBe(false);
  expect(client.isAlive()).toBe(true);
  expect((await reply).output).toBe("reply to slow");
  await eventually(() => settledParked(client));
});

test("a room revive wakes a parked session and starts its turn", async () => {
  const { options, log } = session(100);
  const client = getOrCreateCodexAppServerClient(options);
  await client.send("hello");
  await eventually(() => settledParked(client));

  const observed = client.observeExisting();
  expect(observed.state).toBe("idle");
  expect((await client.submitExisting(observed, "revive", "room message")).accepted).toBe(true);
  expect(client.isAlive()).toBe(true);
  expect(resumes(log)).toHaveLength(1);
  // A token from before the wake is stale.
  expect((await client.submitExisting(observed, "revive", "late")).accepted).toBe(false);
});

test("a thread Codex never wrote is not parked, since a wake could not resume it", async () => {
  const { options } = session(100, false);
  const client = getOrCreateCodexAppServerClient(options);
  await client.send("hello");
  await sleep(350);
  expect(client.isParked).toBe(false);
  expect(client.isAlive()).toBe(true);
});

for (const resumeError of ["thread already has an active writer", "no rollout found for thread id thread-park"]) {
  test(`a wake never forks the thread when resume fails (${resumeError})`, async () => {
    const { options } = session(100);
    const client = getOrCreateCodexAppServerClient(options);
    await client.send("hello");
    const original = client.threadId;
    await eventually(() => settledParked(client));

    const executable = options.env!.OPENSCOUT_CODEX_BIN!;
    const working = readFileSync(executable, "utf8");
    writeFileSync(executable, working.replace(
      'const thread = { id: params.threadId ?? "thread-park", path: rollout };',
      `if (method === "thread/resume") { say({ id, error: { message: ${JSON.stringify(resumeError)} } }); continue; }
const thread = { id: params.threadId ?? "forked-thread", path: rollout };`,
    ));
    await expect(client.send("again")).rejects.toThrow();
    expect(client.threadId).toBe(original);
    expect(client.isParked).toBe(true);
    expect(isCodexAppServerLocalAgentAlive(options)).toBe(true);

    // Once the thread can be resumed again, the next message lands on it.
    writeFileSync(executable, working);
    expect((await client.send("later")).threadId).toBe(original);
  });
}

test("a second revive during a wake cannot write before the thread is resumed", async () => {
  const { options, log } = session(100);
  const client = getOrCreateCodexAppServerClient(options);
  await client.send("hello");
  await eventually(() => settledParked(client));

  const executable = options.env!.OPENSCOUT_CODEX_BIN!;
  let fake = readFileSync(executable, "utf8");
  fake = fake.replace("const say =", "let resuming = false;\nconst say =");
  fake = fake.replace("say({ id, result: { thread } });",
    'if (method === "thread/resume") { resuming = true; setTimeout(() => { resuming = false; say({ id, result: { thread } }); }, 400); } else say({ id, result: { thread } });');
  fake = fake.replace("const threadId = params.threadId;",
    'if (resuming) appendFileSync(log, "premature turn/start\\n");\nconst threadId = params.threadId;');
  writeFileSync(executable, fake);

  const first = client.submitExisting(client.observeExisting(), "revive", "first");
  await eventually(() => resumes(log).length === 1);
  expect(client.observeExisting().state).toBe("unknown");
  const second = await client.submitExisting(client.observeExisting(), "revive", "second");
  expect(second.accepted).toBe(false);
  expect((await first).accepted).toBe(true);
  expect(readFileSync(log, "utf8")).not.toContain("premature turn/start");
});

for (const resetThread of [false, true]) {
  test(`an explicit stop clears parked (resetThread ${resetThread})`, async () => {
    const { options } = session(100);
    const client = getOrCreateCodexAppServerClient(options);
    await client.send("hello");
    await eventually(() => settledParked(client));
    await shutdownCodexAppServerLocalAgent(options, { resetThread });
    expect(client.isParked).toBe(false);
    expect(isCodexAppServerLocalAgentAlive(options)).toBe(false);
    expect(client.observeExisting().state).toBe("gone");
    if (resetThread) expect(client.threadId).toBe(null);
  });
}

test("a session's own env can set the window", async () => {
  const saved = process.env.OPENSCOUT_CODEX_IDLE_PARK_MS;
  process.env.OPENSCOUT_CODEX_IDLE_PARK_MS = "100";
  try {
    const { options } = session(0);
    delete options.idleParkMs;
    options.env!.OPENSCOUT_CODEX_IDLE_PARK_MS = "0";
    const client = getOrCreateCodexAppServerClient(options);
    await client.send("hello");
    await sleep(350);
    expect(client.isParked).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.OPENSCOUT_CODEX_IDLE_PARK_MS;
    else process.env.OPENSCOUT_CODEX_IDLE_PARK_MS = saved;
  }
});

test("a window of 0 keeps the session running", async () => {
  const { options } = session(0);
  const client = getOrCreateCodexAppServerClient(options);
  await client.send("hello");
  await sleep(300);
  expect(client.isParked).toBe(false);
  expect(client.isAlive()).toBe(true);
});
