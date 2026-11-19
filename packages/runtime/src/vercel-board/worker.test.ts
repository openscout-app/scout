import { afterEach, expect, test } from "bun:test";
import type { CollaborationEvent, CollaborationRecord, FlightRecord, ScoutDeliverRequest, ScoutDeliverResponse, WorkItemRecord } from "@openscout/protocol";
import { validateVercelBoardConnectionConfig, vercelTeamBoardUrl } from "@openscout/protocol";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControlPlaneSqliteDatabase } from "../sqlite-adapter.js";
import { migrateControlPlaneDatabaseSchema } from "../control-plane-migrations.js";
import { VercelBoardHttpError, VercelBoardUnknownOutcomeError } from "./client.js";
import { vercelBoardWorkId } from "./projection.js";
import { BrokerVercelBoardService } from "./service.js";
import { VercelBoardStore } from "./store.js";
import { VercelBoardWorkerSupervisor, VercelBoardWorkerTransport, vercelBoardWorkerCommand } from "./worker.js";

// These tests run the real worker process, with `@vercel/board`'s in-memory
// board (`local({ memory: true })`). No network. The worker needs Node 22.18
// or newer; SCOUT_VERCEL_BOARD_TEST_NODE picks the binary.
const NODE = process.env.SCOUT_VERCEL_BOARD_TEST_NODE ?? Bun.which("node");
const run = NODE ? test : test.skip;
const CAN = "work=read,post,react,label;decisions=read,post,react,label;scout-probe=read,post,react,label";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "scout-board-worker-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function memoryWorker(options: { restartBackoffMs?: number } = {}) {
  const worker = new VercelBoardWorkerSupervisor({ target: { kind: "memory" }, profile: "scout", can: CAN, credential: null }, { node: NODE!, restartBackoffMs: options.restartBackoffMs ?? 0 });
  cleanup.push(() => worker.stop());
  return { worker, transport: new VercelBoardWorkerTransport(worker) };
}

run("the worker carries the closed set: tasks, claims, posts, labels and the event feed", async () => {
  const { transport } = memoryWorker();
  expect((await transport.me()).principal).toBe("board:client:scout");
  await transport.ensureChannel("work");
  await transport.ensureChannel("work"); // makes or finds
  const head = await transport.events({ channel: "work", wait: 0 });

  const task = await transport.createTask({ channel: "work", text: "Fix the build", id: "scout-task-1", labels: { "scout.agent": "agent-1" } });
  expect(task.task?.state).toBe("ready");
  expect((await transport.createTask({ channel: "work", text: "Fix the build", id: "scout-task-1" })).id).toBe(task.id); // the client ID is an idempotency key

  const claimed = await transport.claim(task.id, 60);
  expect(claimed.claim.epoch).toBe(1);
  expect(claimed.claim.token.length).toBeGreaterThan(8);
  expect(claimed.task.task?.state).toBe("claimed");
  expect(JSON.stringify(claimed.task)).not.toContain(claimed.claim.token);
  const renewed = await transport.renew(task.id, claimed.claim, 120);
  expect(renewed.until).toBeGreaterThan(claimed.claim.until);
  await expect(transport.renew(task.id, { epoch: 1, token: "not-the-token" }, 60)).rejects.toBeInstanceOf(VercelBoardHttpError);
  expect((await transport.complete(task.id, claimed.claim, "Build fixed.")).task).toMatchObject({ state: "completed", result: "Build fixed." });

  const post = await transport.post({ channel: "work", text: "A note", id: "scout-post-1" });
  expect((await transport.postById("scout-post-1"))?.id).toBe(post.id);
  expect(await transport.postById("scout-post-missing")).toBeNull();
  await transport.labels(post.id, { set: { "scout.seen": "1" } });
  await expect(transport.labels(post.id, { set: { "scout.seen": "2" }, if: { "scout.seen": "9" } })).rejects.toMatchObject({ status: 409, code: "label_conflict" });

  const batch = await transport.createBatch({ channel: "work", id: "scout-plan-1", tasks: [{ key: "a", text: "A" }, { key: "b", text: "B", needs: [{ key: "a" }] }] });
  expect(batch[1]!.task?.needs).toEqual([batch[0]!.id]);
  expect(await transport.batch("scout-plan-1")).toBeNull(); // no lookup on Vercel's API; a resend with the same ID is the same batch
  const resent = await transport.createBatch({ channel: "work", id: "scout-plan-1", tasks: [{ key: "a", text: "A" }, { key: "b", text: "B", needs: [{ key: "a" }] }] });
  expect(resent.map(task => task.id)).toEqual(batch.map(task => task.id));

  const feed = await transport.events({ channel: "work", after: head.cursor, wait: 0 });
  expect(feed.events.map(event => event.type)).toEqual(expect.arrayContaining(["task.created", "task.claimed", "task.completed", "message.posted"]));
  expect(JSON.stringify(feed)).not.toContain(claimed.claim.token);
  expect((await transport.message(task.id))?.task?.state).toBe("completed");
  expect(await transport.message("999999")).toBeNull();
});

run("x-board-can narrows every call: a channel outside it is refused", async () => {
  const { transport } = memoryWorker();
  await expect(transport.post({ channel: "elsewhere", text: "no", id: "scout-post-2" })).rejects.toMatchObject({ status: 403 });
});

run("a write in flight when the worker dies reads as outcome unknown; the next call starts a new generation", async () => {
  const { worker, transport } = memoryWorker();
  await transport.ensureChannel("work");
  expect(worker.status().generation).toBe(1);
  const write = transport.post({ channel: "work", text: "in flight", id: "scout-post-3" });
  (worker as unknown as { running: { child: { kill(signal: string): void } } }).running.child.kill("SIGKILL");
  const outcome = await write.then(() => "landed", error => error);
  if (outcome !== "landed") expect(outcome).toBeInstanceOf(VercelBoardUnknownOutcomeError);
  await Bun.sleep(50);
  expect(worker.status().running).toBe(false);
  await transport.ensureChannel("work");
  expect(worker.status().generation).toBe(2);
});

run("a restart waits out its backoff, and a call refused meanwhile was never sent", async () => {
  const { worker, transport } = memoryWorker({ restartBackoffMs: 60_000 });
  await transport.ensureChannel("work");
  (worker as unknown as { running: { child: { kill(signal: string): void } } }).running.child.kill("SIGKILL");
  await Bun.sleep(100);
  const refused = await transport.createTask({ channel: "work", text: "x", id: "scout-task-2" }).catch(error => error);
  expect(refused).toBeInstanceOf(VercelBoardHttpError);
  expect(refused).toMatchObject({ status: 503, code: "worker_unavailable" });
  expect(worker.status().restartAt).toBeGreaterThan(Date.now());
});

run("a team-board worker refuses to start without VERCEL_BOARD_TOKEN, and says how it must be started", async () => {
  const worker = new VercelBoardWorkerSupervisor({ target: { kind: "vercel", team: "team_test", board: "scout" }, profile: "scout", can: CAN, credential: null }, { node: NODE!, env: { ...process.env, VERCEL_BOARD_TOKEN: "must-not-pass" } });
  cleanup.push(() => worker.stop());
  const error = await worker.start().then(() => undefined, error => error);
  expect(error).toBeInstanceOf(VercelBoardHttpError);
  expect(String(error.message)).toContain("secret run --map <entry>=VERCEL_BOARD_TOKEN");
});

run("a secret_cli credential starts the worker under secret run; the runtime passes no token", async () => {
  const dir = scratch();
  const log = join(dir, "secret.log");
  const fake = join(dir, "secret");
  // A stand-in for the secret helper: it records its argv and whether a token reached it, then stops.
  // It does not run the worker: a team-board worker resolves its board on the network at start.
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\necho "parent_token=\${VERCEL_BOARD_TOKEN:-none}" >> "${log}"\necho '{"fatal":"stand-in helper"}'\nexit 1\n`);
  chmodSync(fake, 0o700);
  const worker = new VercelBoardWorkerSupervisor(
    { target: { kind: "vercel", team: "team_test", board: "scout" }, profile: "scout", can: CAN, credential: { backend: "secret_cli", key: "scout-vercel" } },
    { node: NODE!, secretExecutable: fake, env: { ...process.env, VERCEL_BOARD_TOKEN: "leaked-from-runtime" } },
  );
  cleanup.push(() => worker.stop());
  await expect(worker.start()).rejects.toMatchObject({ code: "worker_unavailable" });
  const lines = readFileSync(log, "utf8").trim().split("\n");
  expect(lines.slice(0, 4)).toEqual(["run", "--map", "scout-vercel=VERCEL_BOARD_TOKEN", "--"]);
  expect(lines[4]).toBe(NODE!);
  expect(lines[5]).toEndWith("vercel-board-worker/src/worker.mjs");
  expect(lines).toContain("parent_token=none");
});

test("the worker command never puts a token in argv", () => {
  expect(vercelBoardWorkerCommand({ backend: "secret_cli", key: "scout-vercel" }, "node", "/w.mjs").args).toEqual(["run", "--map", "scout-vercel=VERCEL_BOARD_TOKEN", "--", "node", "/w.mjs"]);
  expect(vercelBoardWorkerCommand({ backend: "env", key: "VERCEL_BOARD_TOKEN_ENV" }, "node", "/w.mjs")).toEqual({ executable: "node", args: ["/w.mjs"] });
  expect(() => vercelBoardWorkerCommand({ backend: "secret_cli", key: "vca_abc def" }, "node", "/w.mjs")).toThrow();
});

function serviceHarness(vercelBoardWorker: ConstructorParameters<typeof BrokerVercelBoardService>[0]["vercelBoardWorker"]) {
  const dir = scratch();
  const db = openControlPlaneSqliteDatabase(join(dir, "control.sqlite"));
  migrateControlPlaneDatabaseSchema(db);
  const records = new Map<string, CollaborationRecord>();
  const deliveries: ScoutDeliverRequest[] = [];
  const service = new BrokerVercelBoardService({
    nodeId: "node-a", operatorId: "operator", database: db, connectionsDirectory: join(dir, "board"), autoStart: false, vercelBoardWorker,
    credentialOptions: { env: { VERCEL_BOARD_TEST_TOKEN: "test-token-0123" } },
    recordWork: async (record, options) => { records.set(record.id, options?.reconcile ? options.reconcile(records.get(record.id), record) : record); },
    appendWorkEvent: async (_event: CollaborationEvent) => undefined,
    work: id => records.get(id),
    workItems: () => [...records.values()].filter((record): record is WorkItemRecord => record.kind === "work_item"),
    persistActor: async () => undefined,
    deliver: async request => {
      deliveries.push(request);
      return { kind: "delivery", accepted: true, flight: { id: `flight-${deliveries.length}`, state: "running" }, receipt: {} } as unknown as ScoutDeliverResponse;
    },
    flight: id => ({ id, state: "running" }) as FlightRecord,
  });
  cleanup.push(async () => { await service.stop(); db.close(); });
  return { service, records, deliveries, store: new VercelBoardStore(db) };
}

run("connect by team and board name: finds or makes the board, its channels, and runs the probe", async () => {
  const h = serviceHarness({ memory: true, node: NODE! });
  const response = await h.service.connect({ team: "team_test", board: "scout", id: "vb", credential: { backend: "env", key: "VERCEL_BOARD_TEST_TOKEN" } });
  expect(response.connection).toMatchObject({
    transport: "vercel_api", vercel: { team: "team_test", board: "scout" }, url: vercelTeamBoardUrl({ team: "team_test", board: "scout" }),
    principal: "board:client:scout", channels: ["scout/work", "scout/decisions"], probeChannel: "scout/probe",
  });
  expect(validateVercelBoardConnectionConfig(response.connection)).toEqual([]);
  expect(response.probe?.state).toBe("completed");
  expect(response.status.verified).toBe(true);
  expect(JSON.stringify(response)).not.toContain("test-token-0123");

  // The same worker serves the connection: plan, mirror, promote, claim. The claim token stays in runtime custody.
  const plan = await h.service.plan({ connectionId: "vb", channel: "scout/work", planningTaskId: "task-1", requestId: "req-1", actorId: "agent-1", tasks: [{ key: "a", text: "First" }, { key: "b", text: "Second", needs: [{ key: "a" }] }] });
  expect(plan.tasks.map(task => task.state)).toEqual(["ready", "waiting"]);
  await h.service.pump("vb");
  const first = plan.tasks[0]!;
  const view = await h.service.messages({ connectionId: "vb", channel: "scout/work" });
  expect(view.state).toBe("mirrored");
  expect(view.messages.filter(message => message.task).map(message => message.text)).toEqual(["First", "Second"]);
  expect([...h.records.values()].filter(record => record.kind === "work_item")).toEqual([]);
  const promoted = await h.service.promote({ connectionId: "vb", taskId: first.taskId, actorId: "operator" });
  expect(h.records.get(promoted.workId)).toMatchObject({ state: "open" });
  const claim = await h.service.claim({ connectionId: "vb", taskId: first.taskId, agentId: "agent-1", actorId: "operator" });
  expect(claim).toMatchObject({ workId: vercelBoardWorkId("vb", first.taskId), epoch: 1 });
  const custody = h.store.latestCustody("vb", first.taskId);
  expect(custody?.token?.length).toBeGreaterThan(8);
  expect(h.deliveries[0]!.collaborationRecordId).toBe(promoted.workId);
  expect(JSON.stringify(h.deliveries)).not.toContain(custody!.token!);
});

run("a team board URL is read as its team and board", async () => {
  const h = serviceHarness({ memory: true, node: NODE! });
  const response = await h.service.connect({ url: "https://api.vercel.com/v1/messageboard/boards/scout?teamId=team_test", id: "vb", credential: { backend: "env", key: "VERCEL_BOARD_TEST_TOKEN" }, probe: false });
  expect(response.connection.vercel).toEqual({ team: "team_test", board: "scout" });
});

test("a team board connect fails with the fix when the worker's Node is missing, and saves nothing", async () => {
  const h = serviceHarness({ memory: true, node: "/nonexistent/node" });
  await expect(h.service.connect({ team: "team_test", credential: { backend: "env", key: "VERCEL_BOARD_TEST_TOKEN" } }))
    .rejects.toMatchObject({ status: 503, code: "node_unavailable", fix: expect.stringContaining("SCOUT_VERCEL_BOARD_NODE") });
  expect(await h.service.status()).toEqual([]);
});

test("a board is named by url, or by team and board, not both", async () => {
  const h = serviceHarness({ memory: true, node: "/nonexistent/node" });
  await expect(h.service.connect({ url: "http://127.0.0.1:9/board", team: "team_test", credential: { backend: "env", key: "VERCEL_BOARD_TEST_TOKEN" } })).rejects.toMatchObject({ code: "invalid_request" });
  await expect(h.service.connect({ team: "a/b", credential: { backend: "env", key: "VERCEL_BOARD_TEST_TOKEN" } })).rejects.toMatchObject({ code: "invalid_request" });
  await expect(h.service.connect({ url: "https://api.vercel.com/v1/messageboard/boards/scout", credential: { backend: "env", key: "VERCEL_BOARD_TEST_TOKEN" } })).rejects.toMatchObject({ code: "invalid_request" });
});
