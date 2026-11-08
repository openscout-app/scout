import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { ScoutBrokerSnapshot } from "../broker/service.ts";
import { decideMobilePermission, queryPermissionInboxItems } from "./runtime-permissions.ts";

function permissionRecord(id: string, overrides: {
  createdById?: string;
  conversationId?: string;
  state?: string;
  summary?: string;
  createdAt?: number;
  permissionRequest?: Record<string, unknown>;
} = {}) {
  return {
    id,
    kind: "question",
    state: overrides.state ?? "open",
    acceptanceState: "none",
    title: "Permission request",
    summary: overrides.summary ?? "Run a command:\nbun test",
    createdById: overrides.createdById ?? "native:claude:sess-1",
    askedById: overrides.createdById ?? "native:claude:sess-1",
    ownerId: "operator",
    nextMoveOwnerId: "operator",
    ...(overrides.conversationId ? { conversationId: overrides.conversationId } : {}),
    createdAt: overrides.createdAt ?? 1_000,
    updatedAt: overrides.createdAt ?? 1_000,
    metadata: {
      permissionRequest: overrides.permissionRequest ?? {
        sessionId: "sess-1",
        projectRoot: "/Users/op/dev/scout-apps",
        version: "v-1",
        decisions: ["once", "deny"],
        native: {
          harness: "claude",
          tool: "Bash",
          display: { action: "Run a command", command: "bun test", note: "Run the tests" },
        },
      },
    },
  };
}

function snapshot(records: ReturnType<typeof permissionRecord>[], extra: Partial<Record<"agents" | "actors" | "endpoints", Record<string, unknown>>> = {}) {
  return {
    collaborationRecords: Object.fromEntries(records.map((record) => [record.id, record])),
    agents: extra.agents ?? {},
    actors: extra.actors ?? {},
    endpoints: extra.endpoints ?? {},
  } as unknown as ScoutBrokerSnapshot;
}

const broker = (records: ReturnType<typeof permissionRecord>[], baseUrl = "http://127.0.0.1:1", extra = {}) =>
  async () => ({ baseUrl, snapshot: snapshot(records, extra) });

describe("queryPermissionInboxItems", () => {
  test("maps a native request: display action as title, the harness as the agent's name", async () => {
    const items = await queryPermissionInboxItems({ loadBroker: broker([permissionRecord("perm-1")]) });

    expect(items).toEqual([{
      id: "perm-1",
      kind: "permission",
      createdAt: 1_000,
      sessionId: "sess-1",
      sessionName: "Claude",
      adapterType: "claude",
      turnId: null,
      blockId: null,
      version: null,
      risk: "medium",
      title: "Run a command",
      description: "Run a command:\nbun test",
      detail: "scout-apps",
      permission: {
        display: { action: "Run a command", command: "bun test", note: "Run the tests" },
        decisions: ["approve", "deny"],
      },
    }]);
  });

  test("maps a managed request without a display, naming the agent and its harness", async () => {
    const record = permissionRecord("perm-2", {
      createdById: "agent.scout.main",
      conversationId: "conv-9",
      summary: "Allow edits to src/a.ts?",
      permissionRequest: { sessionId: "", projectRoot: "/tmp/proj", version: "v-2", decisions: ["once", "project", "deny"] },
    });
    const items = await queryPermissionInboxItems({
      loadBroker: broker([record], undefined, {
        agents: { "agent.scout.main": { displayName: "Scout" } },
        endpoints: { e1: { agentId: "agent.scout.main", harness: "codex" } },
      }),
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "perm-2",
      sessionId: "conv-9",
      sessionName: "Scout",
      adapterType: "codex",
      title: "Permission request",
      description: "Allow edits to src/a.ts?",
      detail: "proj",
      permission: { decisions: ["approve", "deny"] },
    });
    expect(items[0]!.permission).not.toHaveProperty("display");
  });

  test("never shows a raw actor id, and falls back to the request id for the session", async () => {
    const record = permissionRecord("perm-3", {
      createdById: "agent.unknown",
      permissionRequest: { version: "v-3", decisions: ["once", "deny"] },
    });
    const [item] = await queryPermissionInboxItems({ loadBroker: broker([record]) });

    expect(item).toMatchObject({ sessionId: "perm-3", sessionName: "Agent", adapterType: "tmux", detail: null });
  });

  test("lists only open permission requests, newest first", async () => {
    const items = await queryPermissionInboxItems({
      loadBroker: broker([
        permissionRecord("old", { createdAt: 1 }),
        permissionRecord("new", { createdAt: 2 }),
        permissionRecord("closed", { state: "closed" }),
        { ...permissionRecord("plain-question"), metadata: {} } as ReturnType<typeof permissionRecord>,
      ]),
    });

    expect(items.map((item) => item.id)).toEqual(["new", "old"]);
  });

  test("returns nothing when the runtime is missing or fails", async () => {
    expect(await queryPermissionInboxItems({ loadBroker: async () => null })).toEqual([]);
    expect(await queryPermissionInboxItems({ loadBroker: async () => { throw new Error("down"); } })).toEqual([]);
  });
});

describe("decideMobilePermission", () => {
  // A stand-in runtime decide route: replies with the status and body the
  // real route sends for each outcome, and records what it was sent.
  let server: ReturnType<typeof Bun.serve>;
  let reply: { status: number; body: unknown } = { status: 200, body: { ok: true } };
  const received: unknown[] = [];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method !== "POST" || url.pathname !== "/v1/permissions/decide") return new Response("nope", { status: 404 });
        received.push(await request.json());
        return typeof reply.body === "string"
          ? new Response(reply.body, { status: reply.status })
          : Response.json(reply.body, { status: reply.status });
      },
    });
  });
  afterAll(() => server.stop(true));

  const baseUrl = () => `http://127.0.0.1:${server.port}`;

  test.each([
    { decision: "approve" as const, sent: "once" },
    { decision: "deny" as const, sent: "deny" },
  ])("$decision sends $sent with the request's version", async ({ decision, sent }) => {
    reply = { status: 200, body: { ok: true } };
    received.length = 0;

    const result = await decideMobilePermission(
      { requestId: "perm-1", decision },
      { loadBroker: broker([permissionRecord("perm-1")], baseUrl()) },
    );

    expect(result).toEqual({ ok: true });
    expect(received).toEqual([{ requestId: "perm-1", version: "v-1", decision: sent }]);
  });

  test.each([
    { status: 410, body: { error: "Permission request is already settled.", outcome: "ended", sessionOpen: false }, code: "ended", message: "The session isn't waiting on this anymore." },
    { status: 409, body: { error: "Permission request changed. Refresh.", outcome: "refused" }, code: "refused", message: "It was answered elsewhere or changed. Refresh and look again." },
    { status: 502, body: { error: "hook did not take it", outcome: "unconfirmed" }, code: "unconfirmed", message: "The decision may not have reached the session. Check it there." },
    { status: 403, body: { error: "forbidden", detail: "route is machine-local" }, code: "refused", message: "It was answered elsewhere or changed. Refresh and look again." },
    { status: 500, body: "boom", code: "unconfirmed", message: "The decision may not have reached the session. Check it there." },
  ])("HTTP $status is $code", async ({ status, body, code, message }) => {
    reply = { status, body };

    const result = await decideMobilePermission(
      { requestId: "perm-1", decision: "approve" },
      { loadBroker: broker([permissionRecord("perm-1")], baseUrl()) },
    );

    expect(result).toEqual({ ok: false, code, message });
  });

  test("a request the runtime no longer holds open is ended, and nothing is sent", async () => {
    received.length = 0;
    const result = await decideMobilePermission(
      { requestId: "perm-1", decision: "approve" },
      { loadBroker: broker([permissionRecord("perm-1", { state: "closed" })], baseUrl()) },
    );

    expect(result).toMatchObject({ ok: false, code: "ended" });
    expect(received).toEqual([]);
  });

  test("an unreachable runtime is unreachable", async () => {
    expect(await decideMobilePermission({ requestId: "perm-1", decision: "deny" }, { loadBroker: async () => null }))
      .toEqual({ ok: false, code: "unreachable", message: "Couldn't reach the runtime." });

    // A runtime that refuses the connection: nothing was sent.
    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const closedUrl = `http://127.0.0.1:${closed.port}`;
    closed.stop(true);
    expect(await decideMobilePermission(
      { requestId: "perm-1", decision: "deny" },
      { loadBroker: broker([permissionRecord("perm-1")], closedUrl) },
    )).toMatchObject({ ok: false, code: "unreachable" });
  });
});
