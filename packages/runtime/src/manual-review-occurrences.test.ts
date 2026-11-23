import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  manualReviewOccurrenceOf,
  type DurableAction,
  type ManualReviewOccurrenceConflict,
  type ManualReviewOccurrenceRequest,
} from "@openscout/protocol";

import { BrokerDurableActionHttpService } from "./broker-durable-action-http-service.js";
import { BrokerDurableStore } from "./broker-durable-store.js";
import { FileBackedBrokerJournal } from "./broker-journal.js";
import {
  ManualReviewOccurrenceError,
  ManualReviewOccurrenceService,
  manualReviewIdempotencyKey,
  manualReviewOccurrenceId,
} from "./manual-review-occurrences.js";
import { RecoverableSQLiteProjection } from "./sqlite-projection.js";
import { SQLiteControlPlaneStore } from "./sqlite-store.js";

const NODE = "node-local";
const HEAD_A = "1f2e3d4c5b6a79880123456789abcdef01234567";
const HEAD_B = "89abcdef0123456789abcdef0123456789abcdef";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openscout-manual-review-"));
  roots.add(root);
  return root;
}

function reviewRequest(overrides: Partial<ManualReviewOccurrenceRequest> = {}): ManualReviewOccurrenceRequest {
  return {
    scope: "review",
    requestId: "run-1",
    input: { source: "board:connection-1", id: "message-42", version: "3" },
    artifact: { kind: "pull_request", ref: "example/repo#12", revision: HEAD_A, observedAt: 900 },
    requestedById: "operator",
    ...overrides,
  };
}

/** The journal, the SQLite projection and the writer, wired as the broker wires them. */
async function openRuntime(root: string, now: () => number = () => 1_000) {
  const journal = new FileBackedBrokerJournal(join(root, "broker-journal.jsonl"));
  await journal.load();
  const dbPath = join(root, "control-plane.sqlite");
  const projection = new RecoverableSQLiteProjection(dbPath, journal, {
    conversationFeedPublishDelayMs: 0,
    conversationThreadPublishDelayMs: 0,
  });
  await projection.warm();
  await projection.flush();
  const durable = new BrokerDurableStore({ journal, projection, threadEvents: { publish() {} } });
  const getDurableAction = (actionId: string) => journal.getDurableAction(actionId);
  return {
    journal,
    dbPath,
    occurrences: new ManualReviewOccurrenceService({
      authorityCellId: NODE,
      runDurableWrite: durable.runWrite,
      commitEntries: durable.commitEntries,
      getDurableAction,
      now,
    }),
    /** The general durable action writer, which replaces a record by ID. */
    actions: new BrokerDurableActionHttpService({
      runDurableWrite: durable.runWrite,
      commitEntries: durable.commitEntries,
      heartbeatDurableAction: async () => null,
      getDurableAction,
    }),
    async close(): Promise<void> {
      await durable.flushProjectedEntries();
      projection.close();
      await journal.close();
    },
  };
}

async function journaledActions(journal: FileBackedBrokerJournal): Promise<DurableAction[]> {
  const actions: DurableAction[] = [];
  for (const entry of await journal.readEntries()) {
    if (entry.kind === "durable.action.record") actions.push(entry.action);
  }
  return actions;
}

/** What was journaled, without the projection's own replay markers. */
async function journaledKinds(journal: FileBackedBrokerJournal): Promise<string[]> {
  return (await journal.readEntries()).map((entry) => entry.kind).filter((kind) => kind !== "journal.replay_barrier");
}

function readProjected<T>(dbPath: string, read: (store: SQLiteControlPlaneStore) => T): T {
  const store = new SQLiteControlPlaneStore(dbPath);
  try {
    return read(store);
  } finally {
    store.close();
  }
}

async function conflictOf(attempt: Promise<unknown>): Promise<ManualReviewOccurrenceConflict> {
  const error = await attempt.then(
    () => { throw new Error("expected the request to be refused"); },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ManualReviewOccurrenceError);
  const refused = error as ManualReviewOccurrenceError;
  expect(refused.status).toBe(409);
  return refused.body as ManualReviewOccurrenceConflict;
}

function olderAction(input: Partial<DurableAction> & Pick<DurableAction, "id" | "kind">): DurableAction {
  return {
    subjectId: "subject-1",
    authorityCellId: NODE,
    state: "pending",
    leaseGeneration: 0,
    createdAt: 100,
    updatedAt: 100,
    ...input,
  };
}

describe("manual review occurrences", () => {
  test("first use records one occurrence with the pinned version and revision, and starts nothing", async () => {
    const root = createRoot();
    const runtime = await openRuntime(root);

    const { occurrence, created } = await runtime.occurrences.record(reviewRequest());

    expect(created).toBe(true);
    expect(occurrence).toEqual({
      id: manualReviewOccurrenceId(NODE, "review", "run-1"),
      scope: "review",
      requestId: "run-1",
      input: { source: "board:connection-1", id: "message-42", version: "3" },
      artifact: { kind: "pull_request", ref: "example/repo#12", revision: HEAD_A, observedAt: 900 },
      requestedById: "operator",
      state: "recorded",
      createdAt: 1_000,
    });
    expect(runtime.occurrences.lookup({ scope: "review", requestId: "run-1" })).toEqual(occurrence);

    // One durable action is the whole write: no message, invocation, flight or work item.
    expect(await journaledKinds(runtime.journal)).toEqual(["durable.action.record"]);
    const [action] = await journaledActions(runtime.journal);
    expect(action).toMatchObject({ kind: "manual_review", state: "pending", subjectId: "message-42", leaseGeneration: 0 });
    expect(action?.leaseOwner).toBeUndefined();
    expect(action?.leaseExpiresAt).toBeUndefined();
    expect(Object.keys(action?.metadata ?? {})).toEqual(["manualReview"]);

    await runtime.close();
    // No due time and no lease: a worker that lists due actions never sees it.
    const due = readProjected(runtime.dbPath, (store) => store.listDueDurableActions({ dueAtLte: Number.MAX_SAFE_INTEGER }));
    expect(due).toEqual([]);
  });

  test("a replay after the runtime reopens returns the same occurrence and pins", async () => {
    const root = createRoot();
    const first = await openRuntime(root, () => 1_000);
    const recorded = await first.occurrences.record(reviewRequest());
    await first.close();

    const reopened = await openRuntime(root, () => 9_000);
    expect(reopened.occurrences.lookup({ scope: "review", requestId: "run-1" })).toEqual(recorded.occurrence);

    // The retry read the same revision later and is attributed differently. It is still the same run.
    const replayed = await reopened.occurrences.record(reviewRequest({
      artifact: { kind: "pull_request", ref: "example/repo#12", revision: HEAD_A, observedAt: 8_500 },
      requestedById: "agent-retry",
    }));

    expect(replayed.created).toBe(false);
    expect(replayed.occurrence).toEqual(recorded.occurrence);
    expect(replayed.occurrence.input.version).toBe("3");
    expect(replayed.occurrence.artifact.revision).toBe(HEAD_A);
    expect(await journaledActions(reopened.journal)).toHaveLength(1);

    await reopened.close();
    const projected = readProjected(reopened.dbPath, (store) => store.getDurableActionByIdempotencyKey({
      authorityCellId: NODE,
      kind: "manual_review",
      idempotencyKey: manualReviewIdempotencyKey("review", "run-1"),
    }));
    expect(manualReviewOccurrenceOf(projected)).toEqual(recorded.occurrence);
  });

  test("a conflicting input under the same request ID is refused and the recorded run stays", async () => {
    const root = createRoot();
    const runtime = await openRuntime(root);
    const { occurrence } = await runtime.occurrences.record(reviewRequest());

    const movedHead = await conflictOf(runtime.occurrences.record(reviewRequest({
      artifact: { kind: "pull_request", ref: "example/repo#12", revision: HEAD_B },
    })));
    expect(movedHead.error).toBe("manual_review_conflict");
    expect(movedHead.differs).toEqual(["artifact.revision"]);
    expect(movedHead.occurrence).toEqual(occurrence);

    // A newer input version with the same head is a different run too: the two pins are separate.
    const editedInput = await conflictOf(runtime.occurrences.record(reviewRequest({
      input: { source: "board:connection-1", id: "message-42", version: "4" },
    })));
    expect(editedInput.differs).toEqual(["input.version"]);

    const both = await conflictOf(runtime.occurrences.record(reviewRequest({
      input: { source: "board:connection-1", id: "message-43", version: "4" },
      artifact: { kind: "pull_request", ref: "example/repo#13", revision: HEAD_B },
    })));
    expect(both.differs).toEqual(["input.id", "input.version", "artifact.ref", "artifact.revision"]);

    // The general durable action writer replaces by ID. It may not touch an occurrence.
    const [stored] = await journaledActions(runtime.journal);
    await expect(runtime.actions.recordAction({
      ...stored!,
      metadata: { manualReview: { ...(stored!.metadata!.manualReview as object), artifact: { kind: "pull_request", ref: "example/repo#12", revision: HEAD_B } } },
    })).rejects.toThrow("manual review entry point");
    await expect(runtime.actions.recordAction(olderAction({ id: occurrence.id, kind: "checkback" })))
      .rejects.toThrow("manual review entry point");
    await expect(runtime.actions.recordAction(olderAction({ id: "action-new", kind: "manual_review" })))
      .rejects.toThrow("manual review entry point");

    expect(runtime.occurrences.lookup({ scope: "review", requestId: "run-1" })).toEqual(occurrence);
    expect(await journaledActions(runtime.journal)).toEqual([stored!]);

    // The request ID is scoped: the same ID in another scope is another run.
    const elsewhere = await runtime.occurrences.record(reviewRequest({
      scope: "release-review",
      artifact: { kind: "pull_request", ref: "example/repo#12", revision: HEAD_B },
    }));
    expect(elsewhere.created).toBe(true);
    expect(elsewhere.occurrence.id).not.toBe(occurrence.id);

    await runtime.close();
    const afterRestart = await openRuntime(root);
    expect(afterRestart.occurrences.lookup({ scope: "review", requestId: "run-1" })).toEqual(occurrence);
    await afterRestart.close();
  });

  test("occurrences coexist with durable actions recorded before them", async () => {
    const root = createRoot();
    const occupiedId = manualReviewOccurrenceId(NODE, "review", "run-occupied");
    const futureId = manualReviewOccurrenceId(NODE, "review", "run-future");
    const older: DurableAction[] = [
      olderAction({ id: "checkback-1", kind: "checkback", metadata: { dueAt: 500, mode: "routine", title: "Nightly review" } }),
      // The same idempotency key as the occurrence below, on another kind of action.
      olderAction({ id: "delivery-1", kind: "message_delivery", idempotencyKey: manualReviewIdempotencyKey("review", "run-1") }),
      olderAction({ id: "ask-1", kind: "ask", subjectId: "message-42" }),
      olderAction({ id: occupiedId, kind: "ask" }),
      olderAction({ id: futureId, kind: "manual_review", metadata: { manualReview: { schemaVersion: 2, scope: "review", requestId: "run-future" } } }),
    ];
    const before = await openRuntime(root);
    for (const action of older) await before.journal.appendEntries([{ kind: "durable.action.record", action }]);
    await before.close();

    const runtime = await openRuntime(root);
    for (const action of older) expect(manualReviewOccurrenceOf(action)).toBeNull();
    expect(runtime.occurrences.lookup({ scope: "review", requestId: "run-1" })).toBeNull();
    expect(runtime.occurrences.lookup({ scope: "review", requestId: "run-occupied" })).toBeNull();

    const { occurrence, created } = await runtime.occurrences.record(reviewRequest());
    expect(created).toBe(true);

    // An ID held by an older record, or by a form this version cannot read, is never overwritten.
    for (const requestId of ["run-occupied", "run-future"]) {
      const refused = await conflictOf(runtime.occurrences.record(reviewRequest({ requestId })));
      expect(refused.differs).toEqual([]);
      expect(refused.occurrence).toBeUndefined();
    }

    expect(await journaledActions(runtime.journal)).toHaveLength(older.length + 1);
    for (const action of older) expect(runtime.journal.getDurableAction(action.id)).toEqual(action);

    await runtime.close();
    readProjected(runtime.dbPath, (store) => {
      for (const action of older) expect(store.getDurableAction(action.id)).toMatchObject({ id: action.id, kind: action.kind });
      expect(manualReviewOccurrenceOf(store.getDurableAction(occurrence.id))).toEqual(occurrence);
      // The older scheduled checkback is still the only action that comes due.
      expect(store.listDueDurableActions({ dueAtLte: Number.MAX_SAFE_INTEGER }).map((action) => action.id)).toEqual(["checkback-1"]);
    });
  });

  test("a request that cannot be pinned is refused before any write", async () => {
    const root = createRoot();
    const runtime = await openRuntime(root);
    const refusals: Array<[Partial<ManualReviewOccurrenceRequest>, string]> = [
      [{ requestId: "" }, "requestId"],
      [{ requestedById: undefined }, "requestedById is required"],
      [{ input: { source: "board:connection-1", id: "message-42", version: " 3" } }, "input.version"],
      [{ artifact: { kind: "pull_request", ref: "example/repo#12", revision: "" } }, "artifact.revision"],
      [{ artifact: undefined as never }, "artifact must be an object"],
    ];
    for (const [overrides, detail] of refusals) {
      const error = await runtime.occurrences.record(reviewRequest(overrides)).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ManualReviewOccurrenceError);
      expect((error as ManualReviewOccurrenceError).status).toBe(400);
      expect((error as ManualReviewOccurrenceError).message).toContain(detail);
    }
    expect(() => runtime.occurrences.lookup({ scope: "review", requestId: "" })).toThrow("scope and requestId are required");
    expect(await journaledKinds(runtime.journal)).toEqual([]);
    await runtime.close();
  });
});
