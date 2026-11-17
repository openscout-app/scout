import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveSessionName,
  type AgentEndpoint,
  type CollaborationRecord,
  type NodeDefinition,
  type WorkItemRecord,
} from "@openscout/protocol";

import { buildObservedSessionInventory } from "./broker-observed-sessions-read.js";
import { readMeshNodeState } from "./mesh-node-state.js";
import { configureControlPlaneDatabase, migrateControlPlaneDatabaseSchema } from "./control-plane-migrations.js";
import { runtimeSessionAddressForEndpoint } from "./runtime-session-address.js";
import { SessionNameService, SessionNameStore, SessionNameTargetError } from "./session-names.js";
import { openControlPlaneSqliteDatabase, type ControlPlaneSqliteTransactionalDatabase } from "./sqlite-adapter.js";
import type { DiscoveredTranscript } from "./tail/types.js";

const NODE = "node-1";
const nodes: Record<string, NodeDefinition> = {
  [NODE]: { id: NODE, meshId: "mesh", name: "host-a.local", hostName: "host-a.local", advertiseScope: "mesh", registeredAt: 1 },
};

function transcript(source: string, sessionId: string, title: string | null): DiscoveredTranscript {
  return {
    source, sessionId, title, transcriptPath: `/t/${source}-${sessionId}.jsonl`, cwd: "/repo", project: "repo",
    harness: "unattributed", mtimeMs: 1, size: 1,
  } as DiscoveredTranscript;
}

function endpoint(id: string, agentId: string, harness: string, sessionId: string, metadata: Record<string, unknown> = {}): AgentEndpoint {
  return {
    id, agentId, nodeId: NODE, harness: harness as AgentEndpoint["harness"], transport: "claude_stream_json",
    state: "active", projectRoot: "/repo", cwd: "/repo", sessionId, metadata: { cardless: true, handle: agentId, ...metadata },
  };
}

function work(id: string, ownerId: string, title: string, state: WorkItemRecord["state"], updatedAt: number): CollaborationRecord {
  return {
    id, kind: "work_item", title, state, ownerId, createdById: "operator", createdAt: 1, updatedAt,
    acceptanceState: "none",
  } as unknown as CollaborationRecord;
}

const databases: ControlPlaneSqliteTransactionalDatabase[] = [];
const dirs: string[] = [];

function openDatabase(path = ":memory:"): ControlPlaneSqliteTransactionalDatabase {
  const database = openControlPlaneSqliteDatabase(path, { create: true }) as ControlPlaneSqliteTransactionalDatabase;
  configureControlPlaneDatabase(database);
  migrateControlPlaneDatabaseSchema(database);
  databases.push(database);
  return database;
}

afterEach(() => {
  for (const database of databases.splice(0)) {
    try { database.close(); } catch { /* already closed */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(options: {
  database?: ControlPlaneSqliteTransactionalDatabase;
  transcripts?: DiscoveredTranscript[];
  endpoints?: AgentEndpoint[];
  records?: CollaborationRecord[];
} = {}) {
  const registry = {
    nodes,
    endpoints: Object.fromEntries((options.endpoints ?? []).map((entry) => [entry.id, entry])),
    collaborationRecords: Object.fromEntries((options.records ?? []).map((entry) => [entry.id, entry])),
  };
  let now = 1_000;
  const service = new SessionNameService({
    store: new SessionNameStore(options.database ?? openDatabase()),
    nodeId: NODE,
    operatorActorId: "operator",
    registry: () => registry,
    transcripts: () => options.transcripts ?? [],
    now: () => ++now,
  });
  return { service, registry };
}

describe("resolveSessionName", () => {
  test("uses the operator name, then the work title, then the harness title", () => {
    expect(resolveSessionName({ operatorName: "Session names", derivedName: "Work", harnessTitle: "kernel-panic-last-boot" }))
      .toMatchObject({ name: "Session names", source: "operator", harnessTitle: "kernel-panic-last-boot" });
    expect(resolveSessionName({ operatorName: "  ", derivedName: "Work", harnessTitle: "kernel-panic-last-boot" }))
      .toMatchObject({ name: "Work", source: "work" });
    expect(resolveSessionName({ harnessTitle: "kernel-panic-last-boot" }))
      .toMatchObject({ name: "kernel-panic-last-boot", source: "harness" });
    expect(resolveSessionName({})).toMatchObject({ name: null, source: null });
  });
});

describe("SessionNameService", () => {
  const transcripts = [
    transcript("claude", "claude-1", "kernel-panic-last-boot"),
    transcript("codex", "codex-1", "Fix the build"),
  ];

  test("sets a name that wins over the harness title, and clears it", () => {
    const { service } = harness({ transcripts });
    const set = service.set({ selector: "claude-1", name: "  Session   names " });
    expect(set).toMatchObject({
      action: "set",
      session: { harness: "claude", nativeSessionId: "claude-1" },
      record: { name: "Session names", setByActorId: "operator" },
      resolution: { name: "Session names", source: "operator", harnessTitle: "kernel-panic-last-boot" },
    });
    expect(service.set({ selector: "claude-1", name: "Session names" }).action).toBe("unchanged");

    const [named, other] = service.applyToTranscripts(transcripts);
    expect(named).toMatchObject({
      title: "Session names", harnessTitle: "kernel-panic-last-boot", sessionName: "Session names", sessionNameSource: "operator",
    });
    expect(other).toMatchObject({ title: "Fix the build", harnessTitle: "Fix the build", sessionName: null, sessionNameSource: null });

    const cleared = service.set({ selector: "claude-1", name: "" });
    expect(cleared).toMatchObject({ action: "cleared", record: null, resolution: { name: "kernel-panic-last-boot", source: "harness" } });
    expect(service.list()).toEqual([]);
    expect(service.set({ selector: "claude-1", name: null }).action).toBe("unchanged");
  });

  test("refuses control characters and over-long names", () => {
    const { service } = harness({ transcripts });
    expect(() => service.set({ selector: "claude-1", name: "a\u0007b" })).toThrow(SessionNameTargetError);
    expect(() => service.set({ selector: "claude-1", name: "x".repeat(121) })).toThrow(/at most 120/);
  });

  test("accepts a native id, <harness>:<id>, an exact pair, an agent id and a session address", () => {
    const managed = endpoint("ep-1", "session-abc", "claude", "scout-session-1", { nativeSessionId: "claude-1" });
    const { service, registry } = harness({ transcripts, endpoints: [managed] });
    const target = { harness: "claude", nativeSessionId: "claude-1" };
    expect(service.resolveTarget({ selector: "claude-1" })).toEqual(target);
    expect(service.resolveTarget({ selector: "claude:claude-1" })).toEqual(target);
    expect(service.resolveTarget({ harness: "claude-code", nativeSessionId: "claude-1" })).toEqual(target);
    expect(service.resolveTarget({ selector: "session-abc" })).toEqual(target);
    expect(service.resolveTarget({ selector: "@session-abc" })).toEqual(target);
    expect(service.resolveTarget({ selector: "scout-session-1" })).toEqual(target);
    const address = runtimeSessionAddressForEndpoint(registry, managed);
    expect(address).toMatch(/^sess\./);
    expect(service.resolveTarget({ selector: address! })).toEqual(target);
  });

  test("names an unobserved session only from an exact harness and id", () => {
    const { service } = harness({ transcripts });
    expect(() => service.resolveTarget({ selector: "missing" })).toThrow(expect.objectContaining({ code: "session_not_found" }));
    expect(service.resolveTarget({ selector: "missing", harness: "codex" })).toEqual({ harness: "codex", nativeSessionId: "missing" });
  });

  test("an id two harnesses share is ambiguous until the harness is named", () => {
    const { service } = harness({ transcripts: [transcript("claude", "same", "A"), transcript("codex", "same", "B")] });
    try {
      service.resolveTarget({ selector: "same" });
      throw new Error("expected ambiguity");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionNameTargetError);
      expect((error as SessionNameTargetError).code).toBe("ambiguous_session");
      expect((error as SessionNameTargetError).candidates).toHaveLength(2);
    }
    expect(service.resolveTarget({ selector: "same", harness: "codex" })).toEqual({ harness: "codex", nativeSessionId: "same" });
  });

  test("a session takes the title of its current work, below an operator name", () => {
    const endpoints = [
      endpoint("ep-1", "session-abc", "claude", "claude-1"),
      // One agent with two sessions cannot say which one does the work.
      endpoint("ep-2", "shared-agent", "codex", "codex-1"),
      endpoint("ep-3", "shared-agent", "codex", "codex-2"),
    ];
    const records = [
      work("w-old", "session-abc", "Old work", "working", 5),
      work("w-new", "session-abc", "Home: a better-organized Running list", "working", 9),
      work("w-done", "session-abc", "Finished work", "done", 20),
      work("w-open", "session-abc", "Not started", "open", 30),
      work("w-shared", "shared-agent", "Shared work", "working", 9),
    ];
    const { service } = harness({ transcripts, endpoints, records });
    const [claude, codex] = service.applyToTranscripts(transcripts);
    expect(claude).toMatchObject({
      title: "Home: a better-organized Running list", sessionNameSource: "work", harnessTitle: "kernel-panic-last-boot",
    });
    expect(codex).toMatchObject({ title: "Fix the build", sessionNameSource: null });

    service.set({ selector: "claude-1", name: "Rename sessions" });
    expect(service.applyToTranscripts(transcripts)[0]).toMatchObject({ title: "Rename sessions", sessionNameSource: "operator" });
    service.set({ selector: "claude-1", name: null });
    expect(service.set({ selector: "claude-1", name: null }).resolution).toMatchObject({
      source: "work", derivedFrom: { kind: "work_item", id: "w-new", agentId: "session-abc" },
    });
  });

  test("observed-session rows carry the resolved title and the harness title", () => {
    const { service } = harness({ transcripts });
    service.set({ selector: "codex-1", name: "Build fix" });
    const inventory = service.applyToObservedInventory(buildObservedSessionInventory({
      nodeId: NODE,
      readCache: () => ({ generatedAt: 1, processes: [], transcripts, totals: {} as never }),
    }));
    expect(inventory.sessions.map((row) => [row.identity.nativeSessionId, row.title, row.titleSource, row.harnessTitle])).toEqual([
      ["claude-1", "kernel-panic-last-boot", "harness", "kernel-panic-last-boot"],
      ["codex-1", "Build fix", "operator", "Fix the build"],
    ]);
  });

  test("endpoints answer with their session's name, which route context reads", () => {
    const managed = endpoint("ep-1", "session-abc", "claude", "scout-session-1", { nativeSessionId: "claude-1", displayName: "repo:claude-1" });
    const plain = endpoint("ep-2", "other", "codex", "codex-1", { displayName: "repo:codex-1" });
    const { service, registry } = harness({ transcripts, endpoints: [managed, plain] });
    service.set({ selector: "session-abc", name: "Session names" });
    const name = service.endpointNamer();
    expect(name(managed)).toBe("Session names");
    expect(name(plain)).toBeNull();
    const report = readMeshNodeState({
      snapshot: () => ({ ...registry, actors: {}, agents: {}, flights: {} }) as never,
      nodeId: NODE,
      meshId: "mesh",
      actorDisplayName: (_snapshot, id) => id,
      sessionNamer: () => service.endpointNamer(),
    });
    expect(report.sessions.items.map((item) => [item.id, item.title])).toEqual(expect.arrayContaining([
      ["ep-1", "Session names"],
      ["ep-2", "repo:codex-1"],
    ]));
  });

  test("names persist across a runtime restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-session-names-"));
    dirs.push(dir);
    const path = join(dir, "control-plane.sqlite");
    const first = openDatabase(path);
    harness({ database: first, transcripts }).service.set({ selector: "claude-1", name: "Session names" });
    first.close();

    const { service } = harness({ database: openDatabase(path), transcripts });
    expect(service.list()).toEqual([expect.objectContaining({ harness: "claude", nativeSessionId: "claude-1", name: "Session names" })]);
    expect(service.applyToTranscripts(transcripts)[0]).toMatchObject({ title: "Session names", sessionNameSource: "operator" });
  });
});
