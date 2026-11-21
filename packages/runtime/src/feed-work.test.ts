import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkItemRecord } from "@openscout/protocol";

import { feedWorkRead, handleFeedWorkRoute } from "./broker-feed-work-http.js";
import { projectFeedWorkRow, queryFeedWork, readFeedPresentation, type FeedWorkRow } from "./feed-work.js";
import { openControlPlaneSqliteDatabase } from "./sqlite-adapter.js";
import { SQLiteControlPlaneStore } from "./sqlite-store.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const OPERATORS = ["operator"];

/** A real control plane: an agent with an endpoint, a conversation, and work items written through the store. */
function controlPlane() {
  const root = mkdtempSync(join(tmpdir(), "openscout-feed-work-"));
  roots.push(root);
  const dbPath = join(root, "control-plane.sqlite");
  const store = new SQLiteControlPlaneStore(dbPath);
  store.upsertNode({ id: "node-1", meshId: "mesh-1", name: "Test node", advertiseScope: "local", registeredAt: 1 });
  store.upsertActor({ id: "operator", kind: "person", displayName: "Operator" });
  store.upsertActor({ id: "agent-1", kind: "agent", displayName: "Agent One" });
  store.upsertAgent({
    id: "agent-1", kind: "agent", definitionId: "agent-1", displayName: "Agent One", agentClass: "general",
    capabilities: ["chat"], wakePolicy: "on_demand", homeNodeId: "node-1", authorityNodeId: "node-1", advertiseScope: "local",
  });
  store.upsertEndpoint({
    id: "endpoint-1", agentId: "agent-1", nodeId: "node-1", harness: "claude", transport: "claude_stream_json" as never,
    state: "active", sessionId: "session-1", cwd: "/repo-wt", projectRoot: "/repo", metadata: { branch: "fix/header" },
  });
  store.upsertConversation({
    id: "conv-1", kind: "direct", title: "Direct", visibility: "private", shareMode: "local",
    authorityNodeId: "node-1", participantIds: ["agent-1", "operator"],
  });
  const message = (id: string, actorId: string, body: string, createdAt: number, extra: Record<string, unknown> = {}) =>
    store.recordMessage({ id, conversationId: "conv-1", actorId, originNodeId: "node-1", class: "agent", body, visibility: "private", policy: "durable", createdAt, ...extra });
  const work = (id: string, state: WorkItemRecord["state"], at: number, invocationId?: string) =>
    store.recordCollaborationRecord({
      id, kind: "work_item", title: `Work ${id}`, state, acceptanceState: "none", createdById: "operator", ownerId: "agent-1",
      nextMoveOwnerId: "operator", requestedById: "operator", conversationId: "conv-1", createdAt: at, updatedAt: at,
      ...(invocationId ? { metadata: { lastInvocationId: invocationId } } : {}),
    } as WorkItemRecord);
  const read = () => openControlPlaneSqliteDatabase(dbPath, { readonly: true, create: false });
  return { store, message, work, read };
}

describe("queryFeedWork", () => {
  test("a finished turn comes with its owner's reply, where it worked, and the operator's next line", () => {
    const cp = controlPlane();
    cp.message("ask-1", "operator", "Fix the header.", 1_000);
    // The runtime writes the work item before its invocation; the store keeps the link only to a record it has.
    cp.work("w1", "done", 2_000, "inv-1");
    cp.store.recordInvocation({
      id: "inv-1", requesterId: "operator", requesterNodeId: "node-1", targetAgentId: "agent-1", action: "consult",
      task: "Fix the header.", collaborationRecordId: "w1", messageId: "ask-1", ensureAwake: true, stream: false, createdAt: 1_000,
    });
    cp.message("reply-1", "agent-1", "Fixed the header.", 1_900, { replyToMessageId: "ask-1" });
    cp.message("op-1", "operator", "Looks good.", 2_500);

    const { tasks, gone } = queryFeedWork(cp.read(), { mode: "window", since: 0, limit: -1 }, OPERATORS);
    expect(gone).toEqual([]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: "w1", state: "done", operatorAsked: true, ownerId: "agent-1", ownerName: "Agent One",
      harness: "claude", cwd: "/repo-wt", projectRoot: "/repo", branch: "fix/header",
      replyId: "reply-1", reply: "Fixed the header.", finishedAt: 1_900,
      operator: { id: "op-1", text: "Looks good.", at: 2_500 },
      presentation: { status: "missing", title: null, caption: null },
    });
  });

  test("an item in a state a feed does not keep comes back as gone", () => {
    const cp = controlPlane();
    cp.work("w-open", "open", 2_000);
    cp.work("w-done", "done", 2_000);
    const { tasks, gone } = queryFeedWork(cp.read(), { mode: "window", since: 0, limit: -1 }, OPERATORS);
    expect(tasks.map((task) => task.id)).toEqual(["w-done"]);
    expect(gone).toEqual(["w-open"]);
  });

  test("a window slice stops before its end", () => {
    const cp = controlPlane();
    cp.work("w-early", "done", 1_000);
    cp.work("w-late", "done", 3_000);
    const ids = (until?: number) => queryFeedWork(cp.read(), { mode: "window", since: 0, until, limit: -1 }, OPERATORS).tasks.map((task) => task.id).sort();
    expect(ids()).toEqual(["w-early", "w-late"]);
    expect(ids(3_000)).toEqual(["w-early"]);
  });

  test("a changed read takes items changed since the mark, and those whose conversation moved since it", () => {
    const cp = controlPlane();
    cp.work("w-old", "done", 1_000);
    expect(queryFeedWork(cp.read(), { mode: "changed", mark: 5_000, since: 0, limit: -1 }, OPERATORS).tasks).toEqual([]);
    cp.message("late", "operator", "One more thing.", 6_000);
    expect(queryFeedWork(cp.read(), { mode: "changed", mark: 5_000, since: 0, limit: -1 }, OPERATORS).tasks.map((task) => task.id)).toEqual(["w-old"]);
    // Older than the window: left out however its conversation moved.
    expect(queryFeedWork(cp.read(), { mode: "changed", mark: 5_000, since: 2_000, limit: -1 }, OPERATORS).tasks).toEqual([]);
  });
});

describe("projection", () => {
  const row = (partial: Partial<FeedWorkRow> = {}): FeedWorkRow => ({
    id: "w1", title: "Work", state: "review", acceptance_state: null, owner_id: "agent-1", owner_name: null, conversation_id: "c",
    parent_id: null, parent_title: null, created_at: "100", updated_at: 200, requested_by: "Arach", placement_revision: 3,
    presentation: null, reply_id: null, reply_body: "  ", reply_at: null, operator_id: null, operator_body: null, operator_at: null,
    harness: null, session_id: null, cwd: null, project_root: null, branch: "  ", asked_from: null, ...partial,
  });

  test("an ask by any configured operator id counts as the operator's, and blank text reads as none", () => {
    const task = projectFeedWorkRow(row(), ["operator", "Arach"])!;
    expect(task).toMatchObject({ operatorAsked: true, createdAt: 100, finishedAt: 200, reply: null, branch: null });
    expect(projectFeedWorkRow(row(), ["operator"])!.operatorAsked).toBe(false);
  });

  test("a presentation is current only while it names the item's version", () => {
    const record = (version: string) => JSON.stringify({ schema: "openscout.derived.v1", kind: "presentation", sourceId: "w1", sourceVersion: version, body: { headline: "Header fixed", summary: "The header no longer wraps." } });
    expect(readFeedPresentation(record("r3.u200"), "w1", 200, 3)).toEqual({ status: "current", title: "Header fixed", caption: "The header no longer wraps." });
    expect(readFeedPresentation(record("r2.u100"), "w1", 200, 3).status).toBe("stale");
    expect(readFeedPresentation("not json", "w1", 200, 3).status).toBe("missing");
  });
});

describe("GET /v1/feed/work", () => {
  const reply = () => {
    const out = { status: 0, body: "" };
    return {
      out,
      response: {
        writeHead(status: number) { out.status = status; return this; },
        setHeader() {},
        end(body?: string) { out.body = body ?? ""; },
      } as never,
    };
  };
  const local = { transport: "local" } as never;

  test("the query string names the read", () => {
    expect(feedWorkRead(new URL("http://x/v1/feed/work?since=10"))).toEqual({ mode: "window", since: 10, limit: -1 });
    expect(feedWorkRead(new URL("http://x/v1/feed/work?since=10&mark=20&limit=50"))).toEqual({ mode: "changed", mark: 20, since: 10, limit: 50 });
    expect(feedWorkRead(new URL("http://x/v1/feed/work?since=10&until=30"))).toEqual({ mode: "window", since: 10, until: 30, limit: -1 });
    expect(() => feedWorkRead(new URL("http://x/v1/feed/work?since=10&until=30&mark=20"))).toThrow("invalid_feed_work_until");
    expect(() => feedWorkRead(new URL("http://x/v1/feed/work?since=-1"))).toThrow("invalid_feed_work_since");
    expect(() => feedWorkRead(new URL("http://x/v1/feed/work?limit=0"))).toThrow("invalid_feed_work_limit");
  });

  test("answers a local caller, and refuses a remote one", () => {
    const page = { tasks: [], gone: ["w-open"] };
    const ok = reply();
    expect(handleFeedWorkRoute({ method: "GET", transportContext: local } as never, ok.response, new URL("http://x/v1/feed/work?since=0"), { read: () => page })).toBe(true);
    expect(ok.out.status).toBe(200);
    expect(JSON.parse(ok.out.body)).toEqual(page);

    const remote = reply();
    handleFeedWorkRoute({ method: "GET", transportContext: { transport: "remote" } } as never, remote.response, new URL("http://x/v1/feed/work"), { read: () => page });
    expect(remote.out.status).toBe(403);

    const none = reply();
    handleFeedWorkRoute({ method: "GET", transportContext: local } as never, none.response, new URL("http://x/v1/feed/work"), {});
    expect(none.out.status).toBe(503);
  });

  test("leaves other paths to the next route", () => {
    expect(handleFeedWorkRoute({ method: "GET", transportContext: local } as never, reply().response, new URL("http://x/v1/feed"), {})).toBe(false);
    expect(handleFeedWorkRoute({ method: "POST", transportContext: local } as never, reply().response, new URL("http://x/v1/feed/work"), {})).toBe(false);
  });
});
