import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import {
  manualReviewBoardScope,
  type CollaborationRecord,
  type DurableAction,
  type ManualReviewBoardRoutineSaveRequest,
  type ManualReviewBoardRunRequest,
  type ScoutAttribution,
  type ScoutDeliverRequest,
  type ScoutDeliverResponse,
  type WorkItemRecord,
} from "@openscout/protocol";

import { BrokerDurableActionHttpService } from "./broker-durable-action-http-service.js";
import { BrokerDurableStore } from "./broker-durable-store.js";
import { FileBackedBrokerJournal } from "./broker-journal.js";
import { migrateControlPlaneDatabaseSchema } from "./control-plane-migrations.js";
import { ManualReviewBoardService } from "./manual-review-board.js";
import { ManualReviewBoardError, ManualReviewBoardRoutineStore, manualReviewBoardRoutineActionId } from "./manual-review-board-routines.js";
import { ManualReviewDispatchError, ManualReviewDispatchService, manualReviewAskRequestId, manualReviewDeliveryGuard, manualReviewWorkId } from "./manual-review-dispatch.js";
import { ManualReviewOccurrenceService, manualReviewOccurrenceId } from "./manual-review-occurrences.js";
import { ManualReviewProjectError, canonicalManualReviewProject, readManualReviewProjectHead } from "./manual-review-project.js";
import { openControlPlaneSqliteDatabase, type ControlPlaneSqliteTransactionalDatabase } from "./sqlite-adapter.js";
import { RecoverableSQLiteProjection } from "./sqlite-projection.js";
import { FakeVercelBoard } from "./test-support/fake-vercel-board.js";
import { BrokerVercelBoardService } from "./vercel-board/service.js";

const NODE = "node-local";
const BOARD_URL = "http://127.0.0.1:9/board";
const PROJECT = "/projects/reviewer";
const HEAD = "1f2e3d4c5b6a79880123456789abcdef01234567";
const NEXT_HEAD = "89abcdef0123456789abcdef0123456789abcdef";
const OPERATOR: ScoutAttribution = { actorId: "operator", rootActorId: "operator", source: "local-admin" };

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openscout-manual-review-board-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** What outlives a restart of the runtime: the board, the projects on disk, and the asks the ask path accepted. */
type World = {
  board: FakeVercelBoard;
  boardService: BrokerVercelBoardService;
  /** The commit checked out in each project that is a Git work tree. */
  heads: Map<string, string>;
  /** Accepted asks by request ID, as the receipt ledger keeps them. One entry is one started review. */
  asks: Map<string, { request: ScoutDeliverRequest; response: ScoutDeliverResponse }>;
  deliverAttempts: number;
  /** Stops the ask path once: before it accepts the ask, or after. */
  failDelivery?: "before_accept" | "after_accept";
  pauseItemRead?: () => Promise<void>;
  protectItemRead?: boolean;
};

async function createWorld(channels = ["work", "ops"]): Promise<World> {
  const board = new FakeVercelBoard();
  const database = openControlPlaneSqliteDatabase(":memory:", { create: true }) as ControlPlaneSqliteTransactionalDatabase;
  migrateControlPlaneDatabaseSchema(database);
  cleanup.push(() => database.close?.());
  const records = new Map<string, CollaborationRecord>();
  const controls: Pick<World, "pauseItemRead" | "protectItemRead"> = {};
  const boardService = new BrokerVercelBoardService({
    nodeId: NODE, operatorId: "operator", database, connectionsDirectory: createRoot(), autoStart: false,
    fetch: async (url, init) => {
      const response = await board.fetch(String(url), init);
      if (!/\/messages\/[^/]+$/.test(new URL(String(url)).pathname)) return response;
      if (controls.pauseItemRead) await controls.pauseItemRead();
      if (!controls.protectItemRead || !response.ok) return response;
      const body = await response.json();
      return Response.json({ ...body, message: { ...body.message, noSync: true } });
    },
    vercelBoardWorker: { node: "/nonexistent/node" },
    credentialOptions: { env: { VERCEL_BOARD_TEST_TOKEN: board.token } },
    recordWork: async (record, options) => { records.set(record.id, options?.reconcile ? options.reconcile(records.get(record.id), record) : record); },
    appendWorkEvent: async () => {},
    work: id => records.get(id),
    workItems: () => [...records.values()].filter((record): record is WorkItemRecord => record.kind === "work_item"),
    persistActor: async () => undefined,
    placeWorkChange: (_before, after) => ({ record: after }) as never,
    deliver: async () => { throw new Error("the Board adapter starts nothing in these tests"); },
    flight: () => undefined,
    cancelFlight: async () => {},
    ensureRoom: async () => {},
    publish: () => {},
  });
  cleanup.push(() => { void boardService.stop(); });
  await boardService.connect({ url: BOARD_URL, id: "c1", channels, credential: { backend: "env", key: "VERCEL_BOARD_TEST_TOKEN" } });
  return Object.assign(controls, { board, boardService, heads: new Map([[PROJECT, HEAD]]), asks: new Map(), deliverAttempts: 0 });
}

/** The journal and writer as the broker wires them, in front of the real occurrence and dispatch services. */
async function openRuntime(root: string, world: World) {
  const journal = new FileBackedBrokerJournal(join(root, "broker-journal.jsonl"));
  await journal.load();
  const projection = new RecoverableSQLiteProjection(join(root, "control-plane.sqlite"), journal, {
    conversationFeedPublishDelayMs: 0,
    conversationThreadPublishDelayMs: 0,
  });
  await projection.warm();
  await projection.flush();
  const durable = new BrokerDurableStore({ journal, projection, threadEvents: { publish() {} } });
  const stores = {
    authorityCellId: NODE,
    runDurableWrite: durable.runWrite,
    commitEntries: durable.commitEntries,
    getDurableAction: (actionId: string) => journal.getDurableAction(actionId),
    now: () => 1_000,
  };
  const occurrences = new ManualReviewOccurrenceService(stores);
  const dispatch = new ManualReviewDispatchService({
    ...stores,
    // One request ID is one ask, which is the receipt ledger's rule in the broker.
    deliver: async (request) => {
      world.deliverAttempts += 1;
      const failure = world.failDelivery;
      world.failDelivery = undefined;
      if (failure === "before_accept") throw new Error("the broker stopped before acceptance");
      let accepted = world.asks.get(request.requestId!);
      if (!accepted) {
        (request as ScoutDeliverRequest & { [manualReviewDeliveryGuard]?: () => void })[manualReviewDeliveryGuard]?.();
        const flightId = `flight-${world.asks.size + 1}`;
        accepted = {
          request,
          response: {
            kind: "delivery", accepted: true, routeKind: "dm", targetAgentId: "fresh-reviewer",
            conversation: { id: "dm.operator.fresh-reviewer" }, message: { id: `msg-${flightId}` },
            flight: { id: flightId, invocationId: `inv-${flightId}`, targetAgentId: "fresh-reviewer" },
            workItem: { id: request.workItem?.id },
            receipt: { acceptedAt: 1_000 },
          } as unknown as ScoutDeliverResponse,
        };
        world.asks.set(request.requestId!, accepted);
      }
      if (failure === "after_accept") throw new Error("the broker stopped after acceptance");
      return accepted.response;
    },
    readAskReceipt: async (_requesterId, requestId) => world.asks.has(requestId) ? { state: "unknown" } : null,
  });
  const routines = new ManualReviewBoardRoutineStore({ ...stores, listDurableActions: (kind) => journal.listDurableActionsByKind(kind) });
  const review = new ManualReviewBoardService({
    routines,
    occurrences,
    dispatch,
    board: () => world.boardService,
    project: {
      canonical: async (projectPath) => {
        const canonical = projectPath.replace(/\/link$/, "");
        if (!world.heads.has(canonical)) throw new ManualReviewProjectError("project_not_git", `The project ${canonical} is not inside a Git work tree.`);
        return canonical;
      },
      head: async (canonicalPath) => world.heads.get(canonicalPath)!,
    },
    now: () => 1_000,
  });
  return {
    journal,
    stores,
    occurrences,
    review,
    async close(): Promise<void> {
      await durable.flushProjectedEntries();
      projection.close();
      await journal.close();
    },
  };
}

function routineSave(overrides: Partial<ManualReviewBoardRoutineSaveRequest> = {}): ManualReviewBoardRoutineSaveRequest {
  return { id: "nightly-review", name: "Review the work channel", connectionId: "c1", channel: "work", projectPath: PROJECT, harness: "codex", enabled: true, expectedVersion: 0, ...overrides };
}

async function refusalOf(attempt: Promise<unknown>): Promise<ManualReviewBoardError | ManualReviewDispatchError> {
  const error = await attempt.then(
    () => { throw new Error("expected the request to be refused"); },
    (caught: unknown) => caught,
  );
  if (!(error instanceof ManualReviewBoardError) && !(error instanceof ManualReviewDispatchError)) throw error;
  return error;
}

/** A Board item the connection has mirrored, and the count of requests the board has seen so far. */
async function mirroredItem(world: World, channel = "work"): Promise<string> {
  const itemId = world.board.createTask({ channel, text: "Please review the release branch" });
  await world.boardService.pump("c1");
  return itemId;
}

/** Requests the board received while `work` ran, as "METHOD path". */
async function boardRequestsDuring(world: World, work: () => Promise<unknown>): Promise<string[]> {
  const before = world.board.requests.length;
  await work();
  return world.board.requests.slice(before).map(request => `${request.method} ${request.path}`);
}

async function previewedRun(runtime: Awaited<ReturnType<typeof openRuntime>>, itemId: string, requestId = "run-1"): Promise<ManualReviewBoardRunRequest> {
  const preview = await runtime.review.preview({ routineId: "nightly-review", itemId });
  return { routineId: "nightly-review", itemId, requestId, routineVersion: preview.routine.version, inputVersion: preview.input.version, revision: preview.artifact.revision };
}

describe("Board review routines", () => {
  test("a save checks the project and the channel, keeps the canonical project, and moves the version by one", async () => {
    const world = await createWorld();
    const root = createRoot();
    const runtime = await openRuntime(root, world);
    const requests = await boardRequestsDuring(world, async () => {
      const created = await runtime.review.save(routineSave({ projectPath: `${PROJECT}/link` }), OPERATOR);
      expect(created).toEqual({
        created: true,
        routine: { id: "nightly-review", name: "Review the work channel", version: 1, connectionId: "c1", channel: "work", projectPath: PROJECT, harness: "codex", enabled: true },
      });

      // A save from a version that is no longer the saved one writes nothing and shows the saved one.
      for (const expectedVersion of [0, 2]) {
        const stale = await refusalOf(runtime.review.save(routineSave({ name: "Stale", expectedVersion }), OPERATOR));
        expect(stale.status).toBe(409);
        expect(stale.body).toMatchObject({ error: "manual_review_routine_version_conflict", routine: created.routine });
      }
      const updated = await runtime.review.save(routineSave({ harness: "claude", expectedVersion: 1 }), OPERATOR);
      expect(updated).toMatchObject({ created: false, routine: { version: 2, harness: "claude" } });
      expect((await refusalOf(runtime.review.save(routineSave({ id: "missing", expectedVersion: 3 }), OPERATOR))).body)
        .toMatchObject({ error: "manual_review_routine_version_conflict" });

      for (const [invalid, error, status] of [
        [{ name: "  " }, "invalid_manual_review_request", 400],
        [{ projectPath: "projects/reviewer" }, "invalid_manual_review_request", 400],
        [{ harness: "grok" as never }, "invalid_manual_review_request", 400],
        [{ enabled: "yes" as never }, "invalid_manual_review_request", 400],
        [{ projectPath: "/projects/not-a-repository" }, "manual_review_project_not_git", 400],
        [{ connectionId: "elsewhere" }, "not_found", 404],
        [{ channel: "private" }, "review_channel_not_permitted", 403],
      ] as const) {
        const refused = await refusalOf(runtime.review.save(routineSave({ id: "second", ...invalid }), OPERATOR));
        expect([refused.status, refused.body.error]).toEqual([status, error]);
      }
    });
    // A save reads this host's configuration. It asks the board nothing.
    expect(requests).toEqual([]);

    await runtime.review.save(routineSave({ id: "ops-review", channel: "ops" }), OPERATOR);
    expect(runtime.review.list().map(routine => routine.id)).toEqual(["nightly-review", "ops-review"]);
    expect(runtime.review.list({ channel: "ops" }).map(routine => routine.id)).toEqual(["ops-review"]);
    expect(runtime.review.list({ connectionId: "elsewhere" })).toEqual([]);

    // The record names the connection. It holds neither the credential nor its reference.
    const action = runtime.journal.getDurableAction(manualReviewBoardRoutineActionId(NODE, "nightly-review"))!;
    expect(action).toMatchObject({ kind: "manual_review_routine", state: "pending", leaseGeneration: 0 });
    expect(action.nextDueAt).toBeUndefined();
    expect(JSON.stringify(action)).not.toContain(world.board.token);
    expect(JSON.stringify(action)).not.toContain("VERCEL_BOARD_TEST_TOKEN");

    // The general durable action write cannot make or replace a routine.
    const general = new BrokerDurableActionHttpService({ ...runtime.stores, heartbeatDurableAction: async () => null });
    await expect(general.recordAction({ ...action, metadata: {} })).rejects.toThrow("manual review entry points");
    await expect(general.recordAction({ ...action, kind: "checkback" } as DurableAction)).rejects.toThrow("manual review entry points");
    await runtime.close();

    const restarted = await openRuntime(root, world);
    expect(restarted.review.list()).toMatchObject([{ id: "nightly-review", version: 2, harness: "claude" }, { id: "ops-review", version: 1 }]);
    await restarted.close();
  });
});

describe("Board review preview", () => {
  test("a preview reads the item once and the checked-out commit, and writes nothing", async () => {
    const world = await createWorld();
    const runtime = await openRuntime(createRoot(), world);
    const { routine } = await runtime.review.save(routineSave(), OPERATOR);
    const itemId = await mirroredItem(world);
    const version = world.board.message(itemId)!.version;

    let preview: unknown;
    const requests = await boardRequestsDuring(world, async () => { preview = await runtime.review.preview({ routineId: routine.id, itemId }); });

    expect(preview).toEqual({
      routine,
      input: { source: "vercel-board:c1:work", id: itemId, version: String(version) },
      artifact: { kind: "git_commit", ref: PROJECT, revision: HEAD },
    });
    expect(requests).toEqual([`GET /messages/${itemId}`]);
    expect(world.board.message(itemId)!.version).toBe(version);
    expect(world.board.task(itemId)).toMatchObject({ state: "ready", claim: null });
    expect(runtime.journal.listDurableActionsByKind("manual_review")).toEqual([]);
    await runtime.close();
  });

  test("a request the local checks refuse never reaches the board", async () => {
    const world = await createWorld();
    const runtime = await openRuntime(createRoot(), world);
    await runtime.review.save(routineSave(), OPERATOR);
    await runtime.review.save(routineSave({ id: "off", enabled: false }), OPERATOR);
    await runtime.review.save(routineSave({ id: "gone", projectPath: "/projects/gone" }), OPERATOR).catch(() => {});
    const itemId = await mirroredItem(world);
    const elsewhere = await mirroredItem(world, "ops");
    const deleted = await mirroredItem(world);
    world.board.deleteRoot(deleted);
    await world.boardService.pump("c1");
    // On the board, and never mirrored by this host.
    const unseen = world.board.createTask({ channel: "work", text: "Not mirrored yet" });

    const requests = await boardRequestsDuring(world, async () => {
      for (const [request, status, error] of [
        [{ routineId: "unknown", itemId }, 404, "manual_review_routine_not_found"],
        [{ routineId: "off", itemId }, 409, "manual_review_routine_disabled"],
        [{ routineId: "nightly-review", itemId: unseen }, 404, "review_item_unknown"],
        [{ routineId: "nightly-review", itemId: elsewhere }, 409, "review_item_moved"],
        [{ routineId: "nightly-review", itemId: deleted }, 409, "review_item_deleted"],
        [{ routineId: "nightly-review", itemId: " padded" }, 400, "invalid_manual_review_request"],
      ] as const) {
        const refused = await refusalOf(runtime.review.preview(request));
        expect([refused.status, refused.body.error]).toEqual([status, error]);
      }

      // The project the routine was saved with is no longer a work tree.
      world.heads.delete(PROJECT);
      expect((await refusalOf(runtime.review.preview({ routineId: "nightly-review", itemId }))).body.error).toBe("manual_review_project_not_git");
      world.heads.set(PROJECT, HEAD);

      // The connection stops following: its channel grant stops with it.
      await world.boardService.stop();
      const stopped = await refusalOf(runtime.review.preview({ routineId: "nightly-review", itemId }));
      expect([stopped.status, stopped.body.error]).toEqual([409, "not_custodian"]);
    });
    expect(requests).toEqual([]);
    await runtime.close();
  });

  test("an item that moved or was deleted after it was mirrored is refused by the fresh read, with no write", async () => {
    const world = await createWorld();
    const runtime = await openRuntime(createRoot(), world);
    await runtime.review.save(routineSave(), OPERATOR);
    const moved = await mirroredItem(world);
    const deleted = await mirroredItem(world);
    world.board.message(moved)!.channel = "ops";
    world.board.deleteRoot(deleted);

    const requests = await boardRequestsDuring(world, async () => {
      expect((await refusalOf(runtime.review.preview({ routineId: "nightly-review", itemId: moved }))).body.error).toBe("review_item_moved");
      expect((await refusalOf(runtime.review.preview({ routineId: "nightly-review", itemId: deleted }))).body.error).toBe("review_item_deleted");
    });
    expect(requests).toEqual([`GET /messages/${moved}`, `GET /messages/${deleted}`]);
    await runtime.close();
  });
});

describe("Board review connection state", () => {
  test("a board that refuses the credential ends the read, and a connection that is not following is not read again", async () => {
    const world = await createWorld();
    const runtime = await openRuntime(createRoot(), world);
    await runtime.review.save(routineSave(), OPERATOR);
    const itemId = await mirroredItem(world);
    const run = await previewedRun(runtime, itemId);

    world.board.fault({ route: "GET /messages/:id", mode: "status", status: 401, code: "unauthorized" });
    const refused = await boardRequestsDuring(world, async () => {
      const error = await refusalOf(runtime.review.preview({ routineId: "nightly-review", itemId }));
      expect([error.status, error.body.error]).toEqual([502, "review_read_failed"]);
    });
    expect(refused).toEqual([`GET /messages/${itemId}`]);
    expect((await world.boardService.status("c1"))[0]?.state).toBe("auth_expired");

    const held = await boardRequestsDuring(world, async () => {
      for (const attempt of [runtime.review.preview({ routineId: "nightly-review", itemId }), runtime.review.run(run, OPERATOR)]) {
        const error = await refusalOf(attempt);
        expect([error.status, error.body.error]).toEqual([409, "review_connection_not_live"]);
      }
    });
    expect(held).toEqual([]);
    expect(world.deliverAttempts).toBe(0);
    await runtime.close();
  });
});

describe("Board review run", () => {
  test("a run starts one review of the previewed pins as the routine's reviewer, and a retry reads the stored ticket", async () => {
    const world = await createWorld();
    const runtime = await openRuntime(createRoot(), world);
    await runtime.review.save(routineSave(), OPERATOR);
    const itemId = await mirroredItem(world);
    const run = await previewedRun(runtime, itemId);
    const occurrenceId = manualReviewOccurrenceId(NODE, manualReviewBoardScope("nightly-review"), "run-1");

    let first!: Awaited<ReturnType<typeof runtime.review.run>>;
    const requests = await boardRequestsDuring(world, async () => { first = await runtime.review.run(run, OPERATOR); });

    // The run reads the item again, once, and writes nothing to the board.
    expect(requests).toEqual([`GET /messages/${itemId}`]);
    expect(world.board.task(itemId)).toMatchObject({ state: "ready", claim: null });
    expect(first.replayed).toBe(false);
    expect(first.ticket).toMatchObject({ workId: manualReviewWorkId(occurrenceId), flightId: "flight-1", targetAgentId: "fresh-reviewer" });
    expect(first.occurrence).toMatchObject({
      id: occurrenceId,
      scope: "board-review:nightly-review",
      requestId: "run-1",
      state: "dispatched",
      routine: { id: "nightly-review", version: 1 },
      input: { source: "vercel-board:c1:work", id: itemId, version: run.inputVersion },
      artifact: { kind: "git_commit", ref: PROJECT, revision: HEAD },
      requestedById: "operator",
      dispatch: { target: { kind: "project_path", projectPath: PROJECT, harness: "codex" }, attribution: OPERATOR },
    });
    expect([...world.asks.keys()]).toEqual([manualReviewAskRequestId(occurrenceId)]);
    expect(world.asks.get(manualReviewAskRequestId(occurrenceId))!.request).toMatchObject({
      caller: { actorId: "operator" },
      target: { kind: "project_path", projectPath: PROJECT },
      execution: { harness: "codex", session: "new" },
      workItem: { id: manualReviewWorkId(occurrenceId), acceptanceState: "pending" },
    });
    const ask = world.asks.get(manualReviewAskRequestId(occurrenceId))!.request;
    const path = JSON.parse(ask.body.match(/this local file: (".*")\./)![1]!) as string;
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("> Please review the release branch\n");
    for (const value of [ask, first, runtime.journal.getDurableAction(occurrenceId)]) {
      expect(JSON.stringify(value)).not.toContain("Please review the release branch");
      expect(JSON.stringify(value)).not.toContain(world.board.token);
    }
    // The stable scope reads the run back through the ordinary occurrence lookup.
    expect(runtime.occurrences.lookup({ scope: "board-review:nightly-review", requestId: "run-1" })).toEqual(first.occurrence);

    // A retry is answered from the record, even if we disable the routine
    // after losing both its connection and its project.
    world.heads.delete(PROJECT);
    await world.boardService.stop();
    expect(await runtime.review.save(routineSave({ enabled: false, expectedVersion: 1 }), OPERATOR))
      .toMatchObject({ routine: { enabled: false, version: 2, projectPath: PROJECT } });
    const retries = await boardRequestsDuring(world, async () => {
      expect(await runtime.review.run(run, OPERATOR)).toEqual({ occurrence: first.occurrence, ticket: first.ticket, replayed: true });
    });
    expect(retries).toEqual([]);
    expect(world.deliverAttempts).toBe(1);
    await runtime.close();
  });

  test("a run is refused when the routine, the item or the commit is no longer what the preview showed", async () => {
    const world = await createWorld();
    const runtime = await openRuntime(createRoot(), world);
    await runtime.review.save(routineSave(), OPERATOR);
    const itemId = await mirroredItem(world);
    const run = await previewedRun(runtime, itemId);

    world.heads.set(PROJECT, NEXT_HEAD);
    const commit = await refusalOf(runtime.review.run(run, OPERATOR));
    expect(commit.status).toBe(409);
    expect(commit.body).toMatchObject({ error: "manual_review_preview_changed", differs: ["artifact.revision"], current: { artifact: { revision: NEXT_HEAD } } });
    world.heads.set(PROJECT, HEAD);

    world.board.editAsOther(itemId, "Please review the hotfix branch instead");
    const item = await refusalOf(runtime.review.run(run, OPERATOR));
    expect(item.body).toMatchObject({
      error: "manual_review_preview_changed", differs: ["input.version"],
      current: { input: { id: itemId, version: String(world.board.message(itemId)!.version) } },
    });

    // A saved routine version is never run as another one: the board is not even read.
    await runtime.review.save(routineSave({ harness: "claude", expectedVersion: 1 }), OPERATOR);
    const requests = await boardRequestsDuring(world, async () => {
      const routine = await refusalOf(runtime.review.run(run, OPERATOR));
      expect(routine.body).toMatchObject({ error: "manual_review_preview_changed", differs: ["routine.version"] });
      expect(routine.body).not.toHaveProperty("current");
    });
    expect(requests).toEqual([]);

    expect(runtime.journal.listDurableActionsByKind("manual_review")).toEqual([]);
    expect(world.deliverAttempts).toBe(0);
    await runtime.close();
  });

  test("a request ID keeps every pin, and a later save of the routine does not retarget its run", async () => {
    const world = await createWorld();
    world.heads.set("/projects/other", NEXT_HEAD);
    const runtime = await openRuntime(createRoot(), world);
    await runtime.review.save(routineSave(), OPERATOR);
    const itemId = await mirroredItem(world);
    const otherItem = await mirroredItem(world);
    const run = await previewedRun(runtime, itemId);
    const first = await runtime.review.run(run, OPERATOR);

    // The routine now names another reviewer. The admitted run keeps the one it was admitted with.
    await runtime.review.save(routineSave({ projectPath: "/projects/other", harness: "claude", expectedVersion: 1 }), OPERATOR);

    const requests = await boardRequestsDuring(world, async () => {
      for (const [change, differs] of [
        [{ routineVersion: 2 }, ["routine.version"]],
        [{ inputVersion: "999" }, ["input.version"]],
        [{ revision: NEXT_HEAD }, ["artifact.revision"]],
        [{ itemId: otherItem }, ["input.id"]],
        [{ routineVersion: 2, revision: NEXT_HEAD }, ["artifact.revision", "routine.version"]],
      ] as const) {
        const refused = await refusalOf(runtime.review.run({ ...run, ...change }, OPERATOR));
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({ error: "manual_review_conflict", differs, occurrence: first.occurrence });
      }
      const replay = await runtime.review.run(run, OPERATOR);
      expect(replay).toEqual({ occurrence: first.occurrence, ticket: first.ticket, replayed: true });
      expect(replay.occurrence.dispatch?.target).toEqual({ kind: "project_path", projectPath: PROJECT, harness: "codex" });
    });
    expect(requests).toEqual([]);
    expect(world.deliverAttempts).toBe(1);
    await runtime.close();
  });

  test("after a routine is disabled or its connection stops, a new run reads nothing and starts nothing", async () => {
    const world = await createWorld();
    const runtime = await openRuntime(createRoot(), world);
    await runtime.review.save(routineSave(), OPERATOR);
    const itemId = await mirroredItem(world);
    const run = await previewedRun(runtime, itemId);

    await runtime.review.save(routineSave({ enabled: false, expectedVersion: 1 }), OPERATOR);
    const requests = await boardRequestsDuring(world, async () => {
      const disabled = await refusalOf(runtime.review.run(run, OPERATOR));
      expect([disabled.status, disabled.body.error]).toEqual([409, "manual_review_routine_disabled"]);
      expect((await refusalOf(runtime.review.run({ ...run, routineVersion: 2 }, OPERATOR))).body.error).toBe("manual_review_routine_disabled");

      // Enabled again, and the connection has stopped following.
      await runtime.review.save(routineSave({ expectedVersion: 2 }), OPERATOR);
      await world.boardService.stop();
      const stopped = await refusalOf(runtime.review.run({ ...run, routineVersion: 3 }, OPERATOR));
      expect([stopped.status, stopped.body.error]).toEqual([409, "not_custodian"]);
    });
    expect(requests).toEqual([]);
    expect(runtime.journal.listDurableActionsByKind("manual_review")).toEqual([]);
    expect(world.deliverAttempts).toBe(0);
    await runtime.close();
  });

  test("an admitted retry recovers an accepted ask while disabled but cannot start fresh work under a changed grant", async () => {
    for (const failure of ["after_accept", "before_accept"] as const) {
      const world = await createWorld();
      const root = createRoot();
      const before = await openRuntime(root, world);
      await before.review.save(routineSave(), OPERATOR);
      const itemId = await mirroredItem(world);
      const run = await previewedRun(before, itemId);
      const occurrenceId = manualReviewOccurrenceId(NODE, manualReviewBoardScope("nightly-review"), "run-1");

      world.failDelivery = failure;
      const stopped = await refusalOf(before.review.run(run, OPERATOR));
      expect(stopped.body.error).toBe(failure === "after_accept" ? "manual_review_dispatch_unknown" : "manual_review_dispatch_not_started");
      expect(before.occurrences.lookup({ scope: "board-review:nightly-review", requestId: "run-1" })?.state).toBe("admitted");
      await before.close();

      const after = await openRuntime(root, world);
      const requests = await boardRequestsDuring(world, async () => {
        await after.review.save(routineSave({ enabled: false, expectedVersion: 1 }), OPERATOR);
        if (failure === "before_accept") {
          expect((await refusalOf(after.review.run(run, OPERATOR))).body.error).toBe("manual_review_routine_disabled");
          await after.review.save(routineSave({ channel: "ops", expectedVersion: 2 }), OPERATOR);
          expect((await refusalOf(after.review.run(run, OPERATOR))).body).toMatchObject({ differs: ["routine.version"] });
          expect(world.asks.size).toBe(0);
          expect(world.deliverAttempts).toBe(1);
        } else {
          await world.boardService.stop();
          const recovered = await after.review.run(run, OPERATOR);
          expect(recovered.ticket).toMatchObject({ workId: manualReviewWorkId(occurrenceId), flightId: "flight-1" });
          expect(await after.review.run(run, OPERATOR)).toEqual({ ...recovered, replayed: true });
          expect(world.asks.size).toBe(1);
        }
      });
      expect(requests).toEqual([]);
      await after.close();
    }
  });

  test.each(["disable", "stop", "replace"] as const)("%s during a Board read invalidates the pending run", async (change) => {
    const world = await createWorld();
    const runtime = await openRuntime(createRoot(), world);
    await runtime.review.save(routineSave(), OPERATOR);
    const itemId = await mirroredItem(world);
    const run = await previewedRun(runtime, itemId);
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    world.pauseItemRead = () => { reading.resolve(); return release.promise; };
    const outcome = refusalOf(runtime.review.run(run, OPERATOR));
    await reading.promise;
    if (change === "disable") {
      world.heads.delete(PROJECT);
      const disabled = await runtime.review.save(routineSave({ enabled: false, expectedVersion: 1 }), OPERATOR);
      expect(disabled.routine).toMatchObject({ enabled: false, version: 2, projectPath: PROJECT });
      expect((await refusalOf(runtime.review.save(routineSave({ enabled: false, expectedVersion: 1 }), OPERATOR))).body.error)
        .toBe("manual_review_routine_version_conflict");
    } else {
      await world.boardService.stop();
      if (change === "replace") await world.boardService.start();
    }
    release.resolve();
    expect((await outcome).body.error).toBe({
      disable: "manual_review_routine_disabled", stop: "not_custodian", replace: "review_connection_not_live",
    }[change]);
    expect(runtime.journal.listDurableActionsByKind("manual_review")).toEqual([]);
    expect(world.deliverAttempts).toBe(0);
    await runtime.close();
  });

  test("revoking after admission but before entering delivery does not start the reviewer", async () => {
    const world = await createWorld();
    const runtime = await openRuntime(createRoot(), world);
    await runtime.review.save(routineSave(), OPERATOR);
    const run = await previewedRun(runtime, await mirroredItem(world));
    const outcome = await refusalOf(runtime.review.run(run, OPERATOR, {
      admitAsk: async (_actorId, deliver) => {
        await runtime.review.save(routineSave({ enabled: false, expectedVersion: 1 }), OPERATOR);
        return deliver();
      },
    }));
    expect(outcome.body.error).toBe("manual_review_routine_disabled");
    expect(runtime.occurrences.lookup({ scope: "board-review:nightly-review", requestId: "run-1" })?.state).toBe("admitted");
    expect(world.deliverAttempts).toBe(0);
    await runtime.close();
  });

  test("a task newly marked noSync is not pinned or dispatched", async () => {
    const world = await createWorld();
    const runtime = await openRuntime(createRoot(), world);
    await runtime.review.save(routineSave(), OPERATOR);
    const run = await previewedRun(runtime, await mirroredItem(world));
    world.protectItemRead = true;
    expect((await refusalOf(runtime.review.run(run, OPERATOR))).body.error).toBe("review_item_protected");
    expect(runtime.journal.listDurableActionsByKind("manual_review")).toEqual([]);
    expect(world.deliverAttempts).toBe(0);
    await runtime.close();
  });
});

/** A Git work tree with one commit checked out, written by hand so the test starts no process. Returns the commit. */
function writeRepository(directory: string): string {
  const commit = Buffer.from([
    "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    "author Reviewer <reviewer@example.test> 0 +0000",
    "committer Reviewer <reviewer@example.test> 0 +0000",
    "",
    "Initial commit",
    "",
  ].join("\n"));
  const object = Buffer.concat([Buffer.from(`commit ${commit.length}\0`), commit]);
  const id = createHash("sha1").update(object).digest("hex");
  mkdirSync(join(directory, ".git", "objects", id.slice(0, 2)), { recursive: true });
  mkdirSync(join(directory, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(directory, ".git", "objects", id.slice(0, 2), id.slice(2)), deflateSync(object));
  writeFileSync(join(directory, ".git", "refs", "heads", "main"), `${id}\n`);
  writeFileSync(join(directory, ".git", "HEAD"), "ref: refs/heads/main\n");
  return id;
}

describe("the reviewed project", () => {
  test("the project is read at its canonical path, and its commit is the one Git names", async () => {
    const root = realpathSync(createRoot());
    const repository = join(root, "repository");
    const commit = writeRepository(repository);
    mkdirSync(join(repository, "packages", "app"), { recursive: true });
    symlinkSync(join(repository, "packages", "app"), join(root, "link"));
    mkdirSync(join(root, "plain"));

    // A link resolves to the directory it names, and a directory inside a work tree is a project.
    const canonical = await canonicalManualReviewProject(join(root, "link"));
    expect(canonical).toBe(join(repository, "packages", "app"));
    expect(await readManualReviewProjectHead(canonical)).toBe(commit);
    expect(await readManualReviewProjectHead(repository)).toBe(commit);

    for (const [projectPath, code] of [
      [join(root, "plain"), "project_not_git"],
      [join(root, "missing"), "project_not_found"],
      [join(repository, ".git", "HEAD"), "project_not_found"],
      ["relative/path", "project_not_found"],
      ["--upload-pack=touch", "project_not_found"],
    ] as const) {
      const error = await canonicalManualReviewProject(projectPath).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ManualReviewProjectError);
      expect((error as ManualReviewProjectError).code).toBe(code);
    }
    await expect(readManualReviewProjectHead(join(root, "plain"))).rejects.toMatchObject({ code: "project_head_unreadable" });

    // A branch with no commit yet has nothing to review.
    writeFileSync(join(repository, ".git", "HEAD"), "ref: refs/heads/unborn\n");
    await expect(readManualReviewProjectHead(repository)).rejects.toMatchObject({ code: "project_head_unreadable" });
  });
});
