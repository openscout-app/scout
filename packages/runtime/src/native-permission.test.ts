import { describe, expect, test } from "bun:test";
import { assertValidCollaborationRecord, type QuestionRecord } from "@openscout/protocol";

import { BrokerPermissionService, PermissionDeliveryUnconfirmedError, PermissionRequestEndedError } from "./broker-permission-service.js";
import type { ClaudeSessionRecord } from "./claude-session-records.js";
import { describeNativePermission, NativePermissionAskError, NativePermissionRequests } from "./native-permission.js";

function session(overrides: Partial<ClaudeSessionRecord> = {}): ClaudeSessionRecord {
  return {
    pid: 4242, sessionId: "0f10496b-1111-2222-3333-444455556666", cwd: "/tmp/project", startedAt: 1, procStart: "Sat Nov  7 10:00:00 2026",
    kind: "interactive", entrypoint: "cli", version: "2.1.0", tmux: null, name: null, nameSource: null,
    status: "waiting", statusUpdatedAt: 2, waitingFor: "permission prompt", recordPath: "/sessions/4242.json", ...overrides,
  };
}

const ask = {
  harness: "claude" as const, sessionId: "0f10496b-1111-2222-3333-444455556666", cwd: "/tmp/project",
  toolName: "Bash", toolInput: { command: "rm -rf dist", description: "Remove the build output" },
};

function harness(options: { records?: ClaudeSessionRecord[]; launchedByScout?: boolean; leaseMs?: number; deliveryTimeoutMs?: number } = {}) {
  const records = new Map<string, QuestionRecord>();
  let ids = 0;
  const service = new BrokerPermissionService({
    operatorId: "operator", nodeId: "node", createId: () => `permission-${++ids}`,
    record: async (record) => { assertValidCollaborationRecord(record); records.set(record.id, record); },
    read: (id) => records.get(id), requests: () => [...records.values()], flight: () => undefined,
    localInvocation: () => false, reattach: async () => ({ sessionOpen: false }),
    transition: async () => undefined, notify: () => undefined, sleep: async () => undefined,
  });
  let registry: ClaudeSessionRecord | null = (options.records ?? [session()])[0] ?? null;
  const notified: string[] = [];
  const watched: string[] = [];
  let unwatched = 0;
  const native = new NativePermissionRequests({
    permissions: service, directory: "/sessions",
    readRecords: async () => options.records ?? [session()],
    readRecord: async () => registry,
    watch: (directory) => { watched.push(directory); return () => { unwatched++; }; },
    launchedByScout: async () => options.launchedByScout ?? false,
    notify: ({ requestId }) => { notified.push(requestId); },
    leaseMs: options.leaseMs ?? 60_000, deliveryTimeoutMs: options.deliveryTimeoutMs ?? 1_000,
  });
  return {
    service, native, records, notified, watched, unwatched: () => unwatched,
    /** Claude Code rewrites the session's registry file. */
    registry: async (next: ClaudeSessionRecord | null) => { registry = next; await native.registryChanged("4242.json"); },
  };
}

async function opened(h: ReturnType<typeof harness>): Promise<string> {
  const result = await h.native.open(ask);
  if (!("requestId" in result)) throw new Error(`skipped: ${result.skipped}`);
  return result.requestId;
}

describe("native session permission requests", () => {
  test("a native dialog opens one request to the operator, with what the session wants to do", async () => {
    const h = harness();
    const id = await opened(h);
    const record = h.records.get(id)!;
    expect(record).toMatchObject({
      state: "open", ownerId: "operator", nextMoveOwnerId: "operator", createdById: `native:claude:${ask.sessionId}`,
      summary: "Run a command:\nrm -rf dist\n\nRemove the build output",
      metadata: { permissionRequest: { sessionId: ask.sessionId, projectRoot: "/tmp/project", nodeId: "node", decisions: ["once", "deny"],
        native: { harness: "claude", pid: 4242, tool: "Bash" } } },
    });
    expect(record.conversationId).toBeUndefined();
    expect(h.notified).toEqual([id]);
    expect(h.watched).toEqual(["/sessions"]);
  });

  test.each([["once", "allow"], ["deny", "deny"]] as const)("deciding %s on the board hands %s to the hook and closes the request", async (decision, behavior) => {
    const h = harness();
    const id = await opened(h);
    const version = (h.records.get(id)!.metadata!.permissionRequest as { version: string }).version;
    const poll = h.native.wait(id, 5_000);
    const decided = h.service.decide(id, version, decision);
    expect(await poll).toEqual({ state: "decided", decision: behavior });
    await decided;
    expect(h.records.get(id)).toMatchObject({ state: "closed", answer: decision });
    // Claude Code applies the decision and the session moves on; nothing else happens.
    await h.registry(session({ status: "busy" }));
    expect(h.records.get(id)).toMatchObject({ state: "closed", answer: decision });
    await expect(h.service.decide(id, version, decision)).rejects.toThrow(PermissionRequestEndedError);
  });

  test("a dialog answered in the session ends the request, and the hook stands down", async () => {
    const h = harness();
    const id = await opened(h);
    const version = (h.records.get(id)!.metadata!.permissionRequest as { version: string }).version;
    const poll = h.native.wait(id, 5_000);
    await h.registry(session({ status: "waiting" }));
    expect(h.records.get(id)?.state).toBe("open");
    await h.registry(session({ status: "busy", waitingFor: null }));
    expect(await poll).toEqual({ state: "ended", reason: "Answered in the session." });
    expect(h.records.get(id)).toMatchObject({ state: "closed", answer: "Answered in the session." });
    await expect(h.service.decide(id, version, "once")).rejects.toThrow(PermissionRequestEndedError);
  });

  test("a session that ends, or is replaced by another process, ends its request", async () => {
    for (const next of [null, session({ pid: 4242, procStart: "Sat Nov  7 11:00:00 2026" })]) {
      const h = harness();
      const id = await opened(h);
      await h.registry(next);
      expect(await h.native.wait(id, 0)).toEqual({ state: "ended", reason: "The session ended." });
      expect(h.records.get(id)?.state).toBe("closed");
    }
  });

  test("a hook that stops polling lets its request lapse", async () => {
    const h = harness({ leaseMs: 5 });
    const id = await opened(h);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.records.get(id)).toMatchObject({ state: "closed", answer: "The session stopped waiting." });
  });

  test("a decision the hook never takes is reported unconfirmed, never delivered later", async () => {
    const h = harness({ deliveryTimeoutMs: 10 });
    const id = await opened(h);
    const version = (h.records.get(id)!.metadata!.permissionRequest as { version: string }).version;
    await expect(h.service.decide(id, version, "once")).rejects.toThrow(PermissionDeliveryUnconfirmedError);
    expect(h.records.get(id)?.state).toBe("declined");
  });

  test("a dialog answered in the session before the hook takes a board decision is never answered twice", async () => {
    const h = harness();
    const id = await opened(h);
    const version = (h.records.get(id)!.metadata!.permissionRequest as { version: string }).version;
    const decided = h.service.decide(id, version, "once");
    await h.registry(session({ status: "busy" }));
    expect(await h.native.wait(id, 0)).toEqual({ state: "ended", reason: "Answered in the session." });
    await expect(decided).rejects.toThrow(PermissionDeliveryUnconfirmedError);
  });

  test("Scout's own sessions and unknown sessions raise nothing here", async () => {
    const managed = harness({ launchedByScout: true });
    expect(await managed.native.open(ask)).toEqual({ skipped: "scout_managed" });
    const unknown = harness({ records: [] });
    expect(await unknown.native.open(ask)).toEqual({ skipped: "no_live_session" });
    expect(managed.records.size + unknown.records.size).toBe(0);
    expect(managed.notified.length + unknown.notified.length).toBe(0);
  });

  test("an ask without a session, a project or a tool is refused", async () => {
    const h = harness();
    for (const bad of [{ ...ask, harness: "codex" }, { ...ask, sessionId: "../x" }, { ...ask, cwd: "relative" }, { ...ask, toolName: "" }]) {
      await expect(h.native.open(bad as typeof ask)).rejects.toThrow(NativePermissionAskError);
    }
  });

  test("the watcher stops once nothing is waiting, and a poll after the end reads it as ended", async () => {
    const h = harness();
    const id = await opened(h);
    await h.registry(null);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(h.unwatched()).toBe(1);
    expect(await h.native.wait(id, 0)).toEqual({ state: "ended", reason: "Nothing waits on this request." });
  });

  test("the board text reads like the dialog", () => {
    expect(describeNativePermission({ toolName: "Edit", toolInput: { file_path: "/tmp/project/a.ts" } })).toBe("Edit /tmp/project/a.ts");
    expect(describeNativePermission({ toolName: "WebFetch", toolInput: { url: "https://example.com" } })).toBe("Fetch https://example.com");
    expect(describeNativePermission({ toolName: "mcp__scout__ask", toolInput: { to: "a" } })).toBe("Use mcp__scout__ask\n{\"to\":\"a\"}");
    expect(describeNativePermission({ toolName: "Bash", toolInput: { command: "x".repeat(5_000) } }).length).toBe(2_000);
  });
});
