import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { assertValidCollaborationRecord, type QuestionRecord } from "@openscout/protocol";

import { BrokerPermissionService, PermissionDeliveryUnconfirmedError, PermissionRequestEndedError } from "./broker-permission-service.js";
import { claudeProjectDirectoryForCwd, type ClaudeSessionRecord } from "./claude-session-records.js";
import { nativePermissionContext, describeNativePermission, nativePermissionDisplay, nativePermissionView, NativePermissionAskError, NativePermissionRequests } from "./native-permission.js";

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
    expect(describeNativePermission({ toolName: "mcp__scout__ask", toolInput: { to: "a", body: "line one\nline two", n: 2, empty: "" } })).toBe("Use ask from scout\nto: a\nbody: line one line two\nn: 2");
    expect(describeNativePermission({ toolName: "Bash", toolInput: { command: "x".repeat(5_000) } }).length).toBe(2_000);
    expect(describeNativePermission({ toolName: "Edit", toolInput: {} })).toBe("Edit a file");
  });

  const question = {
    toolName: "AskUserQuestion",
    toolInput: { questions: [{ question: "Which of these should I delete?", header: "Delete", multiSelect: true, options: [
      { label: "Old build scratch (1.4G)", description: "A SwiftPM scratch build, untouched since Nov 5." },
      { label: "Old screenshots (494M)" },
      { description: "no label" },
    ] }] },
  };

  test("a question it wants to ask reads as the question and its answers, not its JSON", () => {
    expect(describeNativePermission(question)).toBe([
      "Ask you a question:", "", "Which of these should I delete?",
      "- Old build scratch (1.4G): A SwiftPM scratch build, untouched since Nov 5.", "- Old screenshots (494M)",
    ].join("\n"));
    expect(nativePermissionDisplay(question)).toEqual({
      action: "Ask you a question",
      questions: [{ header: "Delete", question: "Which of these should I delete?", options: [
        { label: "Old build scratch (1.4G)", description: "A SwiftPM scratch build, untouched since Nov 5." },
        { label: "Old screenshots (494M)" },
      ] }],
    });
    // No question in it: shown as its fields, like any other tool.
    expect(nativePermissionDisplay({ toolName: "AskUserQuestion", toolInput: { questions: [] } })).toEqual({ action: "Use AskUserQuestion" });
  });

  test("the lock screen gets a view from the display, never a parse of the text", () => {
    expect(nativePermissionView(ask)).toEqual({ view: "turn.approve.command", command: "rm -rf dist", why: "Remove the build output" });
    expect(nativePermissionView({ toolName: "Edit", toolInput: { file_path: "/tmp/a.ts" } }))
      .toEqual({ view: "turn.approve.edit", files: [{ path: "/tmp/a.ts", added: 0, removed: 0 }] });
    expect(nativePermissionView(question)).toEqual({
      view: "turn.question.choice", question: "Which of these should I delete?", context: "Delete",
      options: ["Old build scratch (1.4G)", "Old screenshots (494M)"],
    });
    expect(nativePermissionView({ toolName: "WebFetch", toolInput: { url: "https://example.com" } }))
      .toEqual({ view: "turn.approve.tool", tool: "WebFetch", summary: "https://example.com" });
    expect(nativePermissionView({ toolName: "mcp__scout__ask", toolInput: { to: "a" } }))
      .toEqual({ view: "turn.approve.tool", tool: "ask from scout", summary: "to: a" });
  });

  test("the request carries the display laid out, bounded", async () => {
    expect(nativePermissionDisplay(ask)).toEqual({ action: "Run a command", command: "rm -rf dist", note: "Remove the build output" });
    expect(nativePermissionDisplay({ toolName: "WebSearch", toolInput: { query: "bun test" } })).toEqual({ action: "Search the web", target: "bun test" });
    const wide = nativePermissionDisplay({ toolName: "Thing", toolInput: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, "v".repeat(500)])) });
    expect(wide.fields).toHaveLength(8);
    expect(wide.fields![0]!.value.length).toBe(200);
    const h = harness();
    const id = await opened(h);
    expect((h.records.get(id)!.metadata!.permissionRequest as { native: { display: unknown } }).native.display)
      .toEqual({ action: "Run a command", command: "rm -rf dist", note: "Remove the build output" });
  });
});

test("hook transcript path is constrained to projects, its session filename, and real symlink target", async () => {
  const dir = await mkdtemp(join(tmpdir(), "native-context-"));
  const root = join(dir, "projects");
  const path = join(root, "project", `${ask.sessionId}.jsonl`);
  const fixture = [
    { type: "user", message: { content: "Create an isolated workspace." } },
    { type: "assistant", timestamp: "2026-11-01T00:00:00Z", message: { content: [{ type: "text", text: "I will create a worktree before making changes." }, { type: "tool_use", id: "tool-one", name: "EnterWorktree", input: {} }] } },
  ].map(line => JSON.stringify(line)).join("\n");
  try {
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(path, fixture);
    const hookAsk = { ...ask, toolName: "EnterWorktree", cwd: "/different/worktree", transcriptPath: path };
    const record = { cwd: null };
    expect(await nativePermissionContext(hookAsk, record, root)).toEqual({
      text: "I will create a worktree before making changes.", source: "assistant", at: Date.parse("2026-11-01T00:00:00Z"),
    });
    expect(await nativePermissionContext({ ...hookAsk, toolName: "Bash" }, record, root)).toBeNull();
    const outside = join(dir, `${ask.sessionId}.jsonl`);
    await writeFile(outside, fixture);
    expect(await nativePermissionContext({ ...hookAsk, transcriptPath: outside }, record, root)).toBeNull();
    await rm(path);
    await symlink(outside, path);
    expect(await nativePermissionContext(hookAsk, record, root)).toBeNull();
    expect(nativePermissionView(hookAsk, "Creating an isolated workspace.")).toMatchObject({ view: "turn.approve.tool", why: "Creating an isolated workspace." });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("open stores hook-time context from registry cwd even after the hook cwd moved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "native-context-registry-"));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const h = harness({ records: [session({ cwd: "/workspace/original" })] });
  try {
    process.env.CLAUDE_CONFIG_DIR = dir;
    const project = claudeProjectDirectoryForCwd("/workspace/original");
    await mkdir(project, { recursive: true });
    // Hook-boundary fixture: both lines are on disk before open is called.
    await writeFile(join(project, `${ask.sessionId}.jsonl`), [
      { type: "user", message: { content: "Clean the build." } },
      { type: "assistant", message: { content: [{ type: "text", text: "Removing the old build before testing." }, { type: "tool_use", id: "pending", name: "Bash", input: ask.toolInput }] } },
    ].map(line => JSON.stringify(line)).join("\n"));
    const opened = await h.native.open({ ...ask, cwd: "/workspace/moved", transcriptPath: "/outside/invented-session.jsonl" });
    if (!("requestId" in opened)) throw new Error("Expected an open permission");
    expect(h.records.get(opened.requestId)?.metadata?.permissionRequest).toMatchObject({
      sessionId: ask.sessionId,
      native: { context: { text: "Removing the old build before testing.", source: "assistant", at: null } },
    });
  } finally {
    await h.native.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
