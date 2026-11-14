import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionState } from "@openscout/agent-sessions";
import type { FlightRecord, InvocationRequest, MessageRecord } from "@openscout/protocol";
import type { WebAgent } from "../../db-queries.ts";

let queryAgentsResult: WebAgent[] = [];
let brokerContextResult: {
  snapshot: {
    endpoints: Record<string, Record<string, unknown>>;
    actors?: Record<string, { kind?: string; displayName?: string }>;
    nodes?: Record<string, { name?: string }>;
    agents?: Record<string, { displayName?: string }>;
    invocations?: Record<string, InvocationRequest>;
    flights?: Record<string, FlightRecord>;
    messages?: Record<string, MessageRecord>;
  };
} | null = null;
let localSnapshotResult: SessionState | null = null;
let localSnapshotResultsByEndpointId = new Map<string, SessionState | null>();
let localAgentSnapshotResult: SessionState | null = null;
let pairingSnapshotResult: SessionState | null = null;
let tailDiscoveryResult: {
  generatedAt: number;
  processes: unknown[];
  transcripts: Array<{
    source: string;
    transcriptPath: string;
    sessionId: string | null;
    cwd: string | null;
    project: string;
    harness: "scout-managed" | "hudson-managed" | "unattributed";
    mtimeMs: number;
    size: number;
  }>;
  totals: {
    total: number;
    scoutManaged: number;
    hudsonManaged: number;
    unattributed: number;
    transcripts: number;
  };
} | null = null;
type TailDiscoveryStub = NonNullable<typeof tailDiscoveryResult>;
let tailRefreshDiscoveryResult: TailDiscoveryStub | null = null;
let localTailDiscoveryCalls = 0;

mock.module("../../db-queries.ts", () => ({
  queryAgents: () => queryAgentsResult,
  queryAgentById: (agentId: string) => (
    queryAgentsResult.find((agent) => agent.id === agentId) ?? null
  ),
}));

mock.module("../broker/service.ts", () => ({
  loadScoutBrokerContext: async () => brokerContextResult,
  readScoutBrokerTailDiscovery: async () => tailDiscoveryResult,
}));

mock.module("@openscout/runtime/local-agents", () => ({
  getLocalAgentEndpointSessionSnapshot: async (endpoint: { id: string }) => (
    localSnapshotResultsByEndpointId.has(endpoint.id)
      ? localSnapshotResultsByEndpointId.get(endpoint.id) ?? null
      : localSnapshotResult
  ),
  getLocalAgentSessionSnapshot: async () => localAgentSnapshotResult,
}));

mock.module("@openscout/runtime/tail", () => ({
  getTailDiscovery: async () => {
    localTailDiscoveryCalls += 1;
    return tailDiscoveryResult ?? {
      generatedAt: Date.now(),
      processes: [],
      transcripts: [],
      totals: {
        total: 0,
        scoutManaged: 0,
        hudsonManaged: 0,
        unattributed: 0,
        transcripts: 0,
      },
    };
  },
  refreshTailDiscovery: async () => tailRefreshDiscoveryResult ?? tailDiscoveryResult ?? {
    generatedAt: Date.now(),
    processes: [],
    transcripts: [],
    totals: {
      total: 0,
      scoutManaged: 0,
      hudsonManaged: 0,
      unattributed: 0,
      transcripts: 0,
    },
  },
  readTailEventsForSession: async (
    sessionRef: string,
    options?: { discovery?: TailDiscoveryStub },
  ) => {
    const normalizedRef = sessionRef.trim().replace(/\.jsonl$/u, "");
    const discovery = options?.discovery ?? tailDiscoveryResult;
    const transcript = discovery?.transcripts.find((entry) => {
      const sessionId = entry.sessionId?.trim().replace(/\.jsonl$/u, "");
      return sessionId === normalizedRef || entry.transcriptPath.includes(normalizedRef);
    });
    if (!transcript || !["grok", "kimi", "opencode", "cursor"].includes(transcript.source)) {
      return null;
    }
    return {
      transcript,
      events: [
        {
          id: "grok:test:0",
          ts: Date.now(),
          source: transcript.source,
          sessionId: transcript.sessionId ?? normalizedRef,
          pid: 1,
          parentPid: null,
          project: transcript.project,
          cwd: transcript.cwd,
          harness: transcript.harness,
          kind: "tool",
          summary: "Read started",
        },
      ],
    };
  },
}));

mock.module("../../pairing.ts", () => ({
  getScoutWebPairingSessionSnapshot: async () => pairingSnapshotResult,
}));

const { loadAgentObservePayload, loadSessionRefObservePayload } = await import("./service.ts");

mock.restore();

afterAll(() => {
  mock.restore();
});

const tempRoots = new Set<string>();
const originalHome = process.env.HOME;
const originalClaudeProjectsRoot = process.env.OPENSCOUT_CLAUDE_PROJECTS_ROOT;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.add(dir);
  return dir;
}

function makeAgent(overrides: Partial<WebAgent> = {}): WebAgent {
  return {
    id: "agent-1",
    definitionId: "agent",
    name: "Agent One",
    handle: "agent.one",
    agentClass: "general",
    harness: "claude",
    state: "working",
    projectRoot: "/Users/guest/dev/openscout",
    cwd: "/Users/guest/dev/openscout",
    updatedAt: Date.now(),
    transport: "claude_stream_json",
    selector: null,
    defaultSelector: null,
    nodeQualifier: null,
    workspaceQualifier: null,
    wakePolicy: null,
    capabilities: [],
    project: "openscout",
    branch: "main",
    role: null,
    harnessSessionId: "history-session",
    harnessLogPath: null,
    conversationId: "dm.operator.agent-1",
    authorityNodeId: "node-1",
    authorityNodeName: "node-1",
    homeNodeId: "node-1",
    homeNodeName: "node-1",
    ownerId: null,
    ownerName: null,
    ownerHandle: null,
    staleLocalRegistration: false,
    retiredFromFleet: false,
    replacedByAgentId: null,
    ...overrides,
  };
}

function writeClaudeHistory(
  path: string,
  assistantText: string,
  options: { sessionId?: string; cwd?: string } = {},
): void {
  const content = [
    JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: "2026-04-22T12:00:00.000Z",
      session_id: options.sessionId ?? "claude-upstream-session",
      cwd: options.cwd ?? "/Users/guest/dev/openscout",
      model: "claude-sonnet-test",
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-04-22T12:00:01.000Z",
      message: { role: "user", content: "inspect" },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-22T12:00:02.000Z",
      message: {
        content: [{ type: "text", text: assistantText }],
      },
    }),
    JSON.stringify({
      type: "result",
      timestamp: "2026-04-22T12:00:03.000Z",
      subtype: "success",
      is_error: false,
    }),
  ].join("\n");
  writeFileSync(path, `${content}\n`, "utf8");
}

function writeActiveClaudeHistory(path: string, assistantText: string): void {
  const content = [
    JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: "2026-04-22T12:00:00.000Z",
      session_id: "claude-upstream-session",
      cwd: "/Users/guest/dev/openscout",
      model: "claude-sonnet-test",
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-04-22T12:00:01.000Z",
      message: { role: "user", content: "inspect" },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-22T12:00:02.000Z",
      message: {
        content: [{ type: "text", text: assistantText }],
      },
    }),
  ].join("\n");
  writeFileSync(path, `${content}\n`, "utf8");
}

function writeCodexHistory(path: string, input: {
  sessionId: string;
  cwd: string;
  assistantText: string;
}): void {
  const content = [
    JSON.stringify({
      timestamp: "2026-04-22T12:00:00.000Z",
      type: "session_meta",
      payload: {
        id: input.sessionId,
        cwd: input.cwd,
        originator: "Codex Desktop",
        cli_version: "0.142.0",
        source: "vscode",
        model_provider: "openai",
      },
    }),
    JSON.stringify({
      timestamp: "2026-04-22T12:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: "turn-codex-1",
        started_at: 1776862801,
      },
    }),
    JSON.stringify({
      timestamp: "2026-04-22T12:00:02.000Z",
      type: "turn_context",
      payload: {
        cwd: input.cwd,
        model: "gpt-5.5",
        approval_policy: "never",
        sandbox_policy: { type: "danger-full-access" },
      },
    }),
    JSON.stringify({
      timestamp: "2026-04-22T12:00:03.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: input.assistantText,
        phase: "final",
      },
    }),
  ].join("\n");
  writeFileSync(path, `${content}\n`, "utf8");
}

beforeEach(() => {
  queryAgentsResult = [];
  brokerContextResult = null;
  localSnapshotResult = null;
  localSnapshotResultsByEndpointId = new Map();
  localAgentSnapshotResult = null;
  pairingSnapshotResult = null;
  tailDiscoveryResult = null;
  tailRefreshDiscoveryResult = null;
  localTailDiscoveryCalls = 0;
});

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.OPENSCOUT_CLAUDE_PROJECTS_ROOT = originalClaudeProjectsRoot;
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

describe("loadAgentObservePayload", () => {
  test("joins a history observe session to its runtime flight through endpoint aliases", async () => {
    const requestedAt = Date.parse("2026-04-22T11:59:58.000Z");
    const tempRoot = makeTempDir("openscout-observe-provenance-");
    const historyPath = join(tempRoot, "claude-history.jsonl");
    writeClaudeHistory(historyPath, "working from harness history");
    queryAgentsResult = [makeAgent()];
    brokerContextResult = {
      snapshot: {
        endpoints: {
          "endpoint-1": {
            id: "endpoint-1",
            agentId: "agent-1",
            state: "active",
            sessionId: "runtime-session-1",
            transport: "claude_stream_json",
          },
        },
        actors: {
          operator: { displayName: "Arach" },
        },
        invocations: {
          "inv-1": {
            id: "inv-1",
            requesterId: "operator",
            requesterNodeId: "node-1",
            targetAgentId: "agent-1",
            action: "execute",
            task: "Add run provenance to the observe page.",
            conversationId: "chn-design",
            messageId: "msg-ask",
            ensureAwake: true,
            stream: true,
            createdAt: requestedAt + 500,
          },
          "inv-concurrent": {
            id: "inv-concurrent",
            requesterId: "operator",
            requesterNodeId: "node-1",
            targetAgentId: "agent-1",
            action: "execute",
            task: "A concurrent ask for another session.",
            ensureAwake: true,
            stream: true,
            createdAt: requestedAt + 5_000,
          },
          "inv-older": {
            id: "inv-older",
            requesterId: "operator",
            requesterNodeId: "node-1",
            targetAgentId: "agent-1",
            action: "execute",
            task: "The original initiating ask for the reused session.",
            conversationId: "chn-original",
            messageId: "msg-original",
            ensureAwake: true,
            stream: true,
            createdAt: requestedAt - 20_000,
          },
        },
        flights: {
          "flt-1": {
            id: "flt-1",
            invocationId: "inv-1",
            requesterId: "operator",
            targetAgentId: "agent-1",
            state: "running",
            startedAt: requestedAt + 1_000,
            metadata: {
              sessionTrace: [{
                sessionId: "runtime-session-1",
                startedAt: requestedAt + 1_000,
                lastAcknowledgedAt: requestedAt + 1_000,
              }],
            },
          },
          "flt-concurrent": {
            id: "flt-concurrent",
            invocationId: "inv-concurrent",
            requesterId: "operator",
            targetAgentId: "agent-1",
            state: "running",
            startedAt: requestedAt + 5_000,
            metadata: {
              sessionTrace: [{
                sessionId: "runtime-session-2",
                startedAt: requestedAt + 5_000,
                lastAcknowledgedAt: requestedAt + 5_000,
              }],
            },
          },
          "flt-older": {
            id: "flt-older",
            invocationId: "inv-older",
            requesterId: "operator",
            targetAgentId: "agent-1",
            state: "completed",
            startedAt: requestedAt - 20_000,
            completedAt: requestedAt - 10_000,
            metadata: {
              sessionTrace: [{
                sessionId: "runtime-session-1",
                startedAt: requestedAt - 20_000,
                lastAcknowledgedAt: requestedAt - 10_000,
                endedAt: requestedAt - 10_000,
              }],
            },
          },
        },
        messages: {
          "msg-original": {
            id: "msg-original",
            conversationId: "chn-original",
            actorId: "operator",
            originNodeId: "node-1",
            class: "agent",
            body: "The original initiating ask for the reused session.",
            visibility: "private",
            policy: "durable",
            createdAt: requestedAt - 20_000,
          },
          "msg-ask": {
            id: "msg-ask",
            conversationId: "chn-design",
            actorId: "operator",
            originNodeId: "node-1",
            class: "agent",
            body: "Add run provenance to the observe page.",
            visibility: "private",
            policy: "durable",
            createdAt: requestedAt,
          },
        },
      },
    };
    localAgentSnapshotResult = {
      session: {
        id: "harness-history-session",
        name: "Live Claude Session",
        adapterType: "claude-code",
        status: "active",
        cwd: "/Users/guest/dev/openscout",
        providerMeta: {
          resumeSessionPath: historyPath,
        },
      },
      turns: [],
    };

    const payload = await loadAgentObservePayload("agent-1");

    expect(payload?.source).toBe("history");
    expect(payload?.sessionId).toBe("harness-history-session");
    expect(payload?.initiatingAsk).toEqual({
      task: "The original initiating ask for the reused session.",
      requesterId: "operator",
      requesterName: "Arach",
      requestedAt: requestedAt - 20_000,
      invocationId: "inv-older",
      flightId: "flt-older",
      conversationId: "chn-original",
      messageId: "msg-original",
    });
  });

  test("links a parent agent route to the initiating flight of its observed child history", async () => {
    const sessionStart = Date.parse("2026-04-22T12:00:00.000Z");
    const tempRoot = makeTempDir("openscout-observe-parent-child-");
    const historyPath = join(tempRoot, "child-history.jsonl");
    writeClaudeHistory(historyPath, "child work visible through the parent route");
    queryAgentsResult = [makeAgent({
      id: "parent-agent",
      harnessSessionId: "relay-parent",
    })];
    brokerContextResult = {
      snapshot: {
        endpoints: {
          "endpoint-parent": {
            id: "endpoint-parent",
            agentId: "parent-agent",
            state: "offline",
            sessionId: "relay-parent",
            harness: "claude",
            transport: "tmux",
            cwd: "/Users/guest/dev/openscout",
          },
          "endpoint-child-bare": {
            id: "endpoint-child-bare",
            agentId: "child-session",
            state: "offline",
            sessionId: "runtime-child-session",
            harness: "claude",
            transport: "tmux",
            cwd: "/Users/guest/dev/openscout",
            metadata: { startedAt: sessionStart - 500 },
          },
          "endpoint-child-qualified": {
            id: "endpoint-child-qualified",
            agentId: "child-session.main.node-1",
            state: "waiting",
            sessionId: "runtime-child-session",
            harness: "claude",
            transport: "tmux",
            cwd: "/Users/guest/dev/openscout",
            metadata: { startedAt: Math.floor((sessionStart - 500) / 1_000) },
          },
        },
        actors: {
          "parent-agent": { displayName: "Parent Agent" },
        },
        invocations: {
          "inv-original": {
            id: "inv-original",
            requesterId: "parent-agent",
            requesterNodeId: "node-1",
            targetAgentId: "child-session",
            action: "consult",
            task: "Create the first work-observability design study.",
            conversationId: "chn-original",
            messageId: "msg-original",
            ensureAwake: true,
            stream: false,
            createdAt: sessionStart - 1_000,
          },
          "inv-current": {
            id: "inv-current",
            requesterId: "parent-agent",
            requesterNodeId: "node-1",
            targetAgentId: "child-session.main.node-1",
            action: "consult",
            task: "Apply a later correction pass.",
            ensureAwake: true,
            stream: false,
            createdAt: sessionStart + 60_000,
          },
        },
        flights: {
          "flt-original": {
            id: "flt-original",
            invocationId: "inv-original",
            requesterId: "parent-agent",
            targetAgentId: "child-session",
            state: "completed",
            startedAt: sessionStart - 800,
            metadata: {
              sessionTrace: [{
                sessionId: "runtime-child-session",
                endpointId: "endpoint-child-bare",
                startedAt: sessionStart - 800,
                lastAcknowledgedAt: sessionStart - 800,
              }],
            },
          },
          "flt-current": {
            id: "flt-current",
            invocationId: "inv-current",
            requesterId: "parent-agent",
            targetAgentId: "child-session.main.node-1",
            state: "running",
            startedAt: sessionStart + 60_000,
            metadata: {
              sessionTrace: [{
                sessionId: "runtime-child-session",
                endpointId: "endpoint-child-qualified",
                startedAt: sessionStart + 60_000,
                lastAcknowledgedAt: sessionStart + 60_000,
              }],
            },
          },
        },
        messages: {
          "msg-original": {
            id: "msg-original",
            conversationId: "chn-original",
            actorId: "parent-agent",
            originNodeId: "node-1",
            class: "agent",
            body: "Create the first work-observability design study.",
            visibility: "private",
            policy: "durable",
            createdAt: sessionStart - 1_000,
          },
        },
      },
    };
    localAgentSnapshotResult = {
      session: {
        id: "harness-history-session",
        name: "Observed child history",
        adapterType: "claude-code",
        status: "active",
        cwd: "/Users/guest/dev/openscout",
        providerMeta: { resumeSessionPath: historyPath },
      },
      turns: [],
    };

    const payload = await loadAgentObservePayload("parent-agent");

    expect(payload?.source).toBe("history");
    expect(payload?.sessionId).toBe("harness-history-session");
    expect(payload?.initiatingAsk).toMatchObject({
      task: "Create the first work-observability design study.",
      invocationId: "inv-original",
      flightId: "flt-original",
      conversationId: "chn-original",
      messageId: "msg-original",
    });
  });

  test("does not attribute an ask from a different harness session", async () => {
    queryAgentsResult = [makeAgent()];
    brokerContextResult = {
      snapshot: {
        endpoints: {
          "endpoint-1": {
            id: "endpoint-1",
            agentId: "agent-1",
            state: "active",
            sessionId: "live-session-1",
            transport: "claude_stream_json",
          },
        },
        invocations: {
          "inv-old": {
            id: "inv-old",
            requesterId: "operator",
            requesterNodeId: "node-1",
            targetAgentId: "agent-1",
            action: "execute",
            task: "An older unrelated ask.",
            ensureAwake: true,
            stream: true,
            createdAt: Date.now() - 10_000,
          },
        },
        flights: {
          "flt-old": {
            id: "flt-old",
            invocationId: "inv-old",
            requesterId: "operator",
            targetAgentId: "agent-1",
            state: "running",
            metadata: {
              sessionTrace: [{
                sessionId: "different-session",
                startedAt: Date.now() - 10_000,
                lastAcknowledgedAt: Date.now() - 10_000,
              }],
            },
          },
        },
        messages: {},
      },
    };
    localSnapshotResult = {
      session: {
        id: "live-session-1",
        name: "Live Claude Session",
        adapterType: "claude-code",
        status: "active",
        cwd: "/Users/guest/dev/openscout",
      },
      turns: [],
    };

    const payload = await loadAgentObservePayload("agent-1");

    expect(payload?.initiatingAsk).toBeNull();
  });

  test("uses the sole active canonical flight when observe has no session identity", async () => {
    const requestedAt = Date.parse("2026-04-22T11:59:58.000Z");
    queryAgentsResult = [makeAgent({ harnessSessionId: null })];
    brokerContextResult = {
      snapshot: {
        endpoints: {},
        invocations: {
          "inv-active": {
            id: "inv-active",
            requesterId: "operator",
            requesterNodeId: "node-1",
            targetAgentId: "agent-1",
            action: "execute",
            task: "Recover the active ask even before a harness session is observable.",
            ensureAwake: true,
            stream: true,
            createdAt: requestedAt,
          },
        },
        flights: {
          "flt-active": {
            id: "flt-active",
            invocationId: "inv-active",
            requesterId: "operator",
            targetAgentId: "agent-1",
            state: "waking",
            startedAt: requestedAt,
          },
        },
        messages: {},
      },
    };

    const payload = await loadAgentObservePayload("agent-1");

    expect(payload?.source).toBe("unavailable");
    expect(payload?.initiatingAsk).toMatchObject({
      task: "Recover the active ask even before a harness session is observable.",
      invocationId: "inv-active",
      flightId: "flt-active",
    });
  });

  test("does not guess between concurrent active flights without session identity", async () => {
    const requestedAt = Date.parse("2026-04-22T11:59:58.000Z");
    queryAgentsResult = [makeAgent({ harnessSessionId: null })];
    brokerContextResult = {
      snapshot: {
        endpoints: {},
        invocations: Object.fromEntries([1, 2].map((index) => [`inv-${index}`, {
          id: `inv-${index}`,
          requesterId: "operator",
          requesterNodeId: "node-1",
          targetAgentId: "agent-1",
          action: "execute" as const,
          task: `Concurrent ask ${index}`,
          ensureAwake: true,
          stream: true,
          createdAt: requestedAt + index,
        }])),
        flights: Object.fromEntries([1, 2].map((index) => [`flt-${index}`, {
          id: `flt-${index}`,
          invocationId: `inv-${index}`,
          requesterId: "operator",
          targetAgentId: "agent-1",
          state: "running" as const,
          startedAt: requestedAt + index,
        }])),
        messages: {},
      },
    };

    const payload = await loadAgentObservePayload("agent-1");

    expect(payload?.source).toBe("unavailable");
    expect(payload?.initiatingAsk).toBeNull();
  });

  test("prefers harness-native history when a readable Claude history file is available", async () => {
    const tempRoot = makeTempDir("openscout-observe-history-");
    const historyPath = join(tempRoot, "claude-history.jsonl");
    writeClaudeHistory(historyPath, "hello from history");

    queryAgentsResult = [makeAgent()];
    brokerContextResult = {
      snapshot: {
        endpoints: {
          "endpoint-1": {
            id: "endpoint-1",
            agentId: "agent-1",
            state: "active",
            sessionId: "live-session-1",
            transport: "claude_stream_json",
          },
        },
      },
    };
    localSnapshotResult = {
      session: {
        id: "live-session-1",
        name: "Live Claude Session",
        adapterType: "claude-code",
        status: "active",
        cwd: "/Users/guest/dev/openscout",
        providerMeta: {
          resumeSessionPath: historyPath,
        },
      },
      turns: [
        {
          id: "live-turn-1",
          status: "streaming",
          startedAt: Date.parse("2026-04-22T12:00:04.000Z"),
          blocks: [
            {
              status: "streaming",
              block: {
                id: "live-think-1",
                turnId: "live-turn-1",
                index: 0,
                type: "reasoning",
                text: "from live snapshot",
                status: "streaming",
              },
            },
          ],
        },
      ],
      currentTurnId: "live-turn-1",
    };

    const payload = await loadAgentObservePayload("agent-1");

    expect(payload).not.toBeNull();
    expect(payload?.source).toBe("history");
    expect(payload?.fidelity).toBe("timestamped");
    expect(payload?.historyPath).toBe(historyPath);
    expect(payload?.sessionId).toBe("live-session-1");
    expect(payload?.data.events.some((event) => event.text.includes("hello from history"))).toBe(true);
    expect(payload?.data.events.some((event) => event.text.includes("from live snapshot"))).toBe(false);
  });

  test("marks an active history-backed source as live when the hinted snapshot is idle", async () => {
    const tempRoot = makeTempDir("openscout-observe-active-history-");
    const historyPath = join(tempRoot, "active-history.jsonl");
    writeActiveClaudeHistory(historyPath, "still running from history");

    queryAgentsResult = [makeAgent()];
    brokerContextResult = {
      snapshot: {
        endpoints: {
          "endpoint-1": {
            id: "endpoint-1",
            agentId: "agent-1",
            state: "idle",
            sessionId: "idle-live-snapshot",
            transport: "claude_stream_json",
          },
        },
      },
    };
    localSnapshotResult = {
      session: {
        id: "idle-live-snapshot",
        name: "Idle Claude Session",
        adapterType: "claude-code",
        status: "idle",
        cwd: "/Users/guest/dev/openscout",
        providerMeta: {
          resumeSessionPath: historyPath,
        },
      },
      turns: [],
    };

    const payload = await loadAgentObservePayload("agent-1");

    expect(payload).not.toBeNull();
    expect(payload?.source).toBe("history");
    expect(payload?.historyPath).toBe(historyPath);
    expect(payload?.data.live).toBe(true);
    expect(payload?.data.events.some((event) => event.text.includes("still running from history"))).toBe(true);
  });

  test("falls back to the live snapshot when the hinted history file is not replayable", async () => {
    const tempRoot = makeTempDir("openscout-observe-live-");
    const historyPath = join(tempRoot, "codex-history.jsonl");
    writeFileSync(historyPath, `${JSON.stringify({ cwd: "/Users/guest/dev/openscout" })}\n`, "utf8");

    queryAgentsResult = [
      makeAgent({
        harness: "codex",
        transport: "codex_app_server",
      }),
    ];
    brokerContextResult = {
      snapshot: {
        endpoints: {
          "endpoint-1": {
            id: "endpoint-1",
            agentId: "agent-1",
            state: "active",
            sessionId: "codex-live-session-1",
            transport: "codex_app_server",
          },
        },
      },
    };
    localSnapshotResult = {
      session: {
        id: "codex-live-session-1",
        name: "Live Codex Session",
        adapterType: "codex",
        status: "active",
        cwd: "/Users/guest/dev/openscout",
        providerMeta: {
          resumeSessionPath: historyPath,
        },
      },
      turns: [
        {
          id: "live-turn-1",
          status: "streaming",
          startedAt: Date.parse("2026-04-22T12:00:04.000Z"),
          blocks: [
            {
              status: "streaming",
              block: {
                id: "live-think-1",
                turnId: "live-turn-1",
                index: 0,
                type: "reasoning",
                text: "from live snapshot",
                status: "streaming",
              },
            },
          ],
        },
      ],
      currentTurnId: "live-turn-1",
    };

    const payload = await loadAgentObservePayload("agent-1");

    expect(payload).not.toBeNull();
    expect(payload?.source).toBe("live");
    expect(payload?.fidelity).toBe("synthetic");
    expect(payload?.historyPath).toBe(historyPath);
    expect(payload?.sessionId).toBe("codex-live-session-1");
    expect(payload?.data.events.some((event) => event.text.includes("from live snapshot"))).toBe(true);
  });

  test("uses the configured local agent snapshot for full instance ids", async () => {
    queryAgentsResult = [
      makeAgent({
        id: "talkie-codex.feat-design-tokens-reimagined.mini",
        harness: "codex",
        transport: "codex_app_server",
        harnessSessionId: "relay-talkie-codex-feat-design-tokens-reimagined-mini-codex",
      }),
    ];
    brokerContextResult = {
      snapshot: {
        endpoints: {
          "endpoint-1": {
            id: "endpoint-1",
            agentId: "talkie-codex.feat-design-tokens-reimagined.mini",
            state: "idle",
            sessionId: "relay-talkie-codex-feat-design-tokens-reimagined-mini-codex",
            transport: "codex_app_server",
            metadata: {
              agentName: "talkie-codex",
              runtimeInstanceId: "relay-talkie-codex-feat-design-tokens-reimagined-mini-codex",
            },
          },
        },
      },
    };
    localSnapshotResult = {
      session: {
        id: "relay-talkie-codex-feat-design-tokens-reimagined-mini-codex",
        name: "talkie-codex",
        adapterType: "codex",
        status: "idle",
        cwd: "/Users/guest/dev/openscout",
      },
      turns: [],
    };
    localAgentSnapshotResult = {
      session: {
        id: "relay-talkie-codex-feat-design-tokens-reimagined-mini-codex",
        name: "talkie-codex.feat-design-tokens-reimagined.mini",
        adapterType: "codex",
        status: "active",
        cwd: "/Users/guest/dev/talkie",
      },
      turns: [
        {
          id: "turn-1",
          status: "streaming",
          startedAt: Date.parse("2026-04-22T12:00:04.000Z"),
          blocks: [
            {
              status: "completed",
              block: {
                id: "message-1",
                turnId: "turn-1",
                index: 0,
                type: "text",
                text: "configured full instance snapshot",
                status: "completed",
              },
            },
          ],
        },
      ],
      currentTurnId: "turn-1",
    };

    const payload = await loadAgentObservePayload("talkie-codex.feat-design-tokens-reimagined.mini");

    expect(payload).not.toBeNull();
    expect(payload?.source).toBe("live");
    expect(payload?.sessionId).toBe("relay-talkie-codex-feat-design-tokens-reimagined-mini-codex");
    expect(payload?.data.metadata?.session?.cwd).toBe("/Users/guest/dev/talkie");
    expect(payload?.data.events.some((event) => event.text.includes("configured full instance snapshot"))).toBe(true);
  });

  test("uses harness-adapted discovered history for Claude agents carried by tmux", async () => {
    const tempRoot = makeTempDir("openscout-observe-claude-tmux-");
    process.env.OPENSCOUT_CLAUDE_PROJECTS_ROOT = join(tempRoot, "empty-projects");
    const historyPath = join(tempRoot, "claude-upstream-session.jsonl");
    writeClaudeHistory(historyPath, "hello from discovered Claude history");

    queryAgentsResult = [
      makeAgent({
        harness: "claude",
        transport: "tmux",
        cwd: "/Users/guest/dev/talkie",
        projectRoot: "/Users/guest/dev/talkie",
        project: "talkie",
        harnessSessionId: "relay-talkie-claude",
      }),
    ];
    brokerContextResult = {
      snapshot: {
        endpoints: {
          "endpoint-stale-codex": {
            id: "endpoint-stale-codex",
            agentId: "agent-1",
            nodeId: "node-1",
            harness: "codex",
            transport: "codex_app_server",
            state: "active",
            sessionId: "019ead09-5750-7862-99c3-78c804b34c84",
            cwd: "/Users/guest/dev/talkie",
            projectRoot: "/Users/guest/dev/talkie",
            metadata: {
              threadId: "019ead09-5750-7862-99c3-78c804b34c84",
              runtimeInstanceId: "relay-talkie-codex",
              lastCompletedAt: Date.parse("2026-04-22T12:00:00.000Z"),
            },
          },
          "endpoint-current-claude": {
            id: "endpoint-current-claude",
            agentId: "agent-1",
            nodeId: "node-1",
            harness: "claude",
            transport: "tmux",
            state: "idle",
            sessionId: "relay-talkie-claude",
            cwd: "/Users/guest/dev/talkie",
            projectRoot: "/Users/guest/dev/talkie",
            metadata: {
              runtimeInstanceId: "relay-talkie-claude",
              tmuxSession: "relay-talkie-claude",
              startedAt: Date.parse("2026-04-22T12:01:00.000Z"),
            },
          },
        },
      },
    };
    tailDiscoveryResult = {
      generatedAt: Date.now(),
      processes: [],
      transcripts: [
        {
          source: "claude",
          transcriptPath: historyPath,
          sessionId: "claude-upstream-session",
          cwd: "/Users/guest/dev/talkie",
          project: "talkie",
          harness: "unattributed",
          mtimeMs: Date.now(),
          size: 100,
        },
      ],
      totals: {
        total: 0,
        scoutManaged: 0,
        hudsonManaged: 0,
        unattributed: 0,
        transcripts: 1,
      },
    };

    const payload = await loadAgentObservePayload("agent-1");

    expect(payload).not.toBeNull();
    expect(payload?.source).toBe("history");
    expect(payload?.historyPath).toBe(historyPath);
    expect(payload?.sessionId).toBe("claude-upstream-session");
    expect(payload?.data.events.some((event) => event.text.includes("hello from discovered Claude history"))).toBe(true);
  });

  test("does not attach cwd-discovered Codex history to direct relay sessions without a session match", async () => {
    const tempRoot = makeTempDir("openscout-observe-codex-direct-mismatch-");
    const historyPath = join(tempRoot, "wrong-codex-session.jsonl");
    writeCodexHistory(historyPath, {
      sessionId: "wrong-codex-session",
      cwd: "/Users/guest/dev/scope",
      assistantText: "wrong raw codex history",
    });

    queryAgentsResult = [
      makeAgent({
        id: "scope.main.arts-mac-mini-local",
        harness: "codex",
        transport: "codex_app_server",
        cwd: "/Users/guest/dev/scope",
        projectRoot: "/Users/guest/dev/scope",
        project: "scope",
        harnessSessionId: "relay-scope-codex",
      }),
    ];
    brokerContextResult = {
      snapshot: {
        endpoints: {
          "endpoint-scope-codex": {
            id: "endpoint-scope-codex",
            agentId: "scope.main.arts-mac-mini-local",
            nodeId: "node-1",
            harness: "codex",
            transport: "codex_app_server",
            state: "waiting",
            sessionId: "relay-scope-codex",
            cwd: "/Users/guest/dev/scope",
            projectRoot: "/Users/guest/dev/scope",
            metadata: {
              runtimeInstanceId: "relay-scope-codex",
              runtimeMode: "direct_session",
            },
          },
        },
      },
    };
    tailDiscoveryResult = {
      generatedAt: Date.now(),
      processes: [],
      transcripts: [
        {
          source: "codex",
          transcriptPath: historyPath,
          sessionId: "wrong-codex-session",
          cwd: "/Users/guest/dev/scope",
          project: "scope",
          harness: "unattributed",
          mtimeMs: Date.now(),
          size: 100,
        },
      ],
      totals: {
        total: 0,
        scoutManaged: 0,
        hudsonManaged: 0,
        unattributed: 0,
        transcripts: 1,
      },
    };

    const payload = await loadAgentObservePayload("scope.main.arts-mac-mini-local");

    expect(payload).not.toBeNull();
    expect(payload?.source).toBe("unavailable");
    expect(payload?.historyPath).toBeNull();
    expect(payload?.sessionId).toBeNull();
    expect(payload?.data.events.some((event) => event.text.includes("wrong raw codex history"))).toBe(false);
  });

  test("uses session-matched discovered Codex history for direct relay sessions", async () => {
    const tempRoot = makeTempDir("openscout-observe-codex-direct-match-");
    const historyPath = join(tempRoot, "relay-scope-codex.jsonl");
    writeCodexHistory(historyPath, {
      sessionId: "relay-scope-codex",
      cwd: "/Users/guest/dev/scope",
      assistantText: "matched direct codex history",
    });

    queryAgentsResult = [
      makeAgent({
        id: "scope.main.arts-mac-mini-local",
        harness: "codex",
        transport: "codex_app_server",
        cwd: "/Users/guest/dev/scope",
        projectRoot: "/Users/guest/dev/scope",
        project: "scope",
        harnessSessionId: "relay-scope-codex",
      }),
    ];
    brokerContextResult = {
      snapshot: {
        endpoints: {
          "endpoint-scope-codex": {
            id: "endpoint-scope-codex",
            agentId: "scope.main.arts-mac-mini-local",
            nodeId: "node-1",
            harness: "codex",
            transport: "codex_app_server",
            state: "waiting",
            sessionId: "relay-scope-codex",
            cwd: "/Users/guest/dev/scope",
            projectRoot: "/Users/guest/dev/scope",
            metadata: {
              runtimeInstanceId: "relay-scope-codex",
              runtimeMode: "direct_session",
            },
          },
        },
      },
    };
    tailDiscoveryResult = {
      generatedAt: Date.now(),
      processes: [],
      transcripts: [
        {
          source: "codex",
          transcriptPath: historyPath,
          sessionId: "relay-scope-codex",
          cwd: "/Users/guest/dev/scope",
          project: "scope",
          harness: "unattributed",
          mtimeMs: Date.now(),
          size: 100,
        },
      ],
      totals: {
        total: 0,
        scoutManaged: 0,
        hudsonManaged: 0,
        unattributed: 0,
        transcripts: 1,
      },
    };

    const payload = await loadAgentObservePayload("scope.main.arts-mac-mini-local");

    expect(payload).not.toBeNull();
    expect(payload?.source).toBe("history");
    expect(payload?.historyPath).toBe(historyPath);
    expect(payload?.sessionId).toBe("relay-scope-codex");
    expect(payload?.data.events.some((event) => event.text.includes("matched direct codex history"))).toBe(true);
  });

  test("uses routed session id to discover Codex history when the agent record has no harness session", async () => {
    const tempRoot = makeTempDir("openscout-observe-codex-routed-session-");
    const historyPath = join(tempRoot, "relay-scope-codex.jsonl");
    writeCodexHistory(historyPath, {
      sessionId: "relay-scope-codex",
      cwd: "/Users/guest/dev/scope",
      assistantText: "routed direct codex history",
    });

    queryAgentsResult = [
      makeAgent({
        id: "scope.main.arts-mac-mini-local",
        harness: "codex",
        transport: "codex_app_server",
        cwd: "/Users/guest/dev/scope",
        projectRoot: "/Users/guest/dev/scope",
        project: "scope",
        harnessSessionId: null,
      }),
    ];
    brokerContextResult = {
      snapshot: {
        endpoints: {
          "endpoint-scope-codex": {
            id: "endpoint-scope-codex",
            agentId: "scope.main.arts-mac-mini-local",
            nodeId: "node-1",
            harness: "codex",
            transport: "codex_app_server",
            state: "waiting",
            sessionId: "relay-scope-codex",
            cwd: "/Users/guest/dev/scope",
            projectRoot: "/Users/guest/dev/scope",
            metadata: {
              runtimeInstanceId: "relay-scope-codex",
              runtimeMode: "direct_session",
            },
          },
        },
      },
    };
    tailDiscoveryResult = {
      generatedAt: Date.now(),
      processes: [],
      transcripts: [
        {
          source: "codex",
          transcriptPath: historyPath,
          sessionId: "relay-scope-codex",
          cwd: "/Users/guest/dev/scope",
          project: "scope",
          harness: "unattributed",
          mtimeMs: Date.now(),
          size: 100,
        },
      ],
      totals: {
        total: 0,
        scoutManaged: 0,
        hudsonManaged: 0,
        unattributed: 0,
        transcripts: 1,
      },
    };

    const payload = await loadAgentObservePayload("scope.main.arts-mac-mini-local", {
      sessionId: "relay-scope-codex",
    });

    expect(payload).not.toBeNull();
    expect(payload?.source).toBe("history");
    expect(payload?.historyPath).toBe(historyPath);
    expect(payload?.sessionId).toBe("relay-scope-codex");
    expect(payload?.data.events.some((event) => event.text.includes("routed direct codex history"))).toBe(true);
  });

  test("maps a Claude session ref id directly to its history file", async () => {
    const home = makeTempDir("openscout-observe-home-");
    process.env.HOME = home;
    const projectDir = join(home, ".claude", "projects", "-Users-guest-dev-openscout");
    process.env.OPENSCOUT_CLAUDE_PROJECTS_ROOT = join(home, ".claude", "projects");
    mkdirSync(projectDir, { recursive: true });
    const historyPath = join(projectDir, "3b0fcaa9-024a-4e67-88f7-08a72d75fbbb.jsonl");
    writeClaudeHistory(historyPath, "hello from ref lookup");

    const payload = await loadSessionRefObservePayload("3b0fcaa9-024a-4e67-88f7-08a72d75fbbb");

    expect(payload).not.toBeNull();
    expect(payload?.kind).toBe("history");
    expect(payload?.source).toBe("history");
    expect(payload?.historyPath).toBe(historyPath);
    expect(payload?.sessionId).toBe("3b0fcaa9-024a-4e67-88f7-08a72d75fbbb");
    expect(payload?.data.events.some((event) => event.text.includes("hello from ref lookup"))).toBe(true);
  });

  test("maps a Tail-discovered raw session ref to its transcript file", async () => {
    const tempRoot = makeTempDir("openscout-observe-tail-");
    process.env.OPENSCOUT_CLAUDE_PROJECTS_ROOT = join(tempRoot, "empty-projects");
    const historyPath = join(tempRoot, "tail-session.jsonl");
    writeClaudeHistory(historyPath, "hello from tail discovery");
    tailDiscoveryResult = {
      generatedAt: Date.now(),
      processes: [],
      transcripts: [
        {
          source: "claude",
          transcriptPath: historyPath,
          sessionId: "tail-session",
          cwd: "/Users/guest/dev/openscout",
          project: "openscout",
          harness: "unattributed",
          mtimeMs: Date.now(),
          size: 100,
        },
      ],
      totals: {
        total: 0,
        scoutManaged: 0,
        hudsonManaged: 0,
        unattributed: 0,
        transcripts: 1,
      },
    };

    const payload = await loadSessionRefObservePayload("tail-session");

    expect(payload).not.toBeNull();
    expect(payload?.kind).toBe("history");
    expect(payload?.source).toBe("history");
    expect(payload?.historyPath).toBe(historyPath);
    expect(payload?.sessionId).toBe("tail-session");
    expect(payload?.data.events.some((event) => event.text.includes("hello from tail discovery"))).toBe(true);
    expect(localTailDiscoveryCalls).toBe(0);
  });

  test("maps a native Grok session ref to tail observe data", async () => {
    const transcriptPath = "/Users/you/.grok/sessions/openscout/019edd6b/events.jsonl";
    tailDiscoveryResult = {
      generatedAt: Date.now(),
      processes: [],
      transcripts: [
        {
          source: "grok",
          transcriptPath,
          sessionId: "019edd6b-fc26-7a53-a4a0-dd36c5378515",
          cwd: "/Users/you/dev/openscout",
          project: "openscout",
          harness: "unattributed",
          mtimeMs: Date.now(),
          size: 100,
        },
      ],
      totals: {
        total: 0,
        scoutManaged: 0,
        hudsonManaged: 0,
        unattributed: 0,
        transcripts: 1,
      },
    };

    const payload = await loadSessionRefObservePayload("019edd6b-fc26-7a53-a4a0-dd36c5378515");

    expect(payload).not.toBeNull();
    expect(payload?.kind).toBe("tail");
    expect(payload?.source).toBe("tail");
    expect(payload?.historyPath).toBe(transcriptPath);
    expect(payload?.sessionId).toBe("019edd6b-fc26-7a53-a4a0-dd36c5378515");
    expect(payload?.data.events.some((event) => event.text.includes("Read started"))).toBe(true);
  });
});

describe("loadSessionRefObservePayload", () => {
  test("uses harness-qualified refs and rejects a colliding bare native id", async () => {
    const sharedSessionId = "shared-native-session";
    const tempRoot = makeTempDir("openscout-observe-qualified-session-");
    process.env.OPENSCOUT_CLAUDE_PROJECTS_ROOT = join(tempRoot, "empty-projects");
    const codexPath = join(tempRoot, "codex-shared.jsonl");
    const claudePath = join(tempRoot, "claude-shared.jsonl");
    writeCodexHistory(codexPath, {
      sessionId: sharedSessionId,
      cwd: "/Users/you/dev/openscout",
      assistantText: "exact Codex response",
    });
    writeClaudeHistory(claudePath, "exact Claude response", {
      sessionId: sharedSessionId,
      cwd: "/Users/you/dev/openscout",
    });
    tailDiscoveryResult = {
      generatedAt: Date.now(),
      processes: [],
      transcripts: [
        {
          source: "codex",
          transcriptPath: codexPath,
          sessionId: sharedSessionId,
          cwd: "/Users/you/dev/openscout",
          project: "openscout",
          harness: "unattributed",
          mtimeMs: Date.now(),
          size: 100,
        },
        {
          source: "claude",
          transcriptPath: claudePath,
          sessionId: sharedSessionId,
          cwd: "/Users/you/dev/openscout",
          project: "openscout",
          harness: "unattributed",
          mtimeMs: Date.now() + 1,
          size: 100,
        },
      ],
      totals: {
        total: 0,
        scoutManaged: 0,
        hudsonManaged: 0,
        unattributed: 0,
        transcripts: 2,
      },
    };

    const codexPayload = await loadSessionRefObservePayload(`session:codex:${sharedSessionId}`);
    const claudePayload = await loadSessionRefObservePayload(`session:claude:${sharedSessionId}`);

    expect(codexPayload?.historyPath).toBe(codexPath);
    expect(codexPayload?.data.events.some((event) => event.text.includes("exact Codex response"))).toBe(true);
    expect(claudePayload?.historyPath).toBe(claudePath);
    expect(claudePayload?.data.events.some((event) => event.text.includes("exact Claude response"))).toBe(true);
    await expect(loadSessionRefObservePayload(sharedSessionId)).resolves.toBeNull();

    tailDiscoveryResult.transcripts = [tailDiscoveryResult.transcripts[1]!];
    tailDiscoveryResult.totals.transcripts = 1;
    queryAgentsResult = [makeAgent({
      id: "registered-codex-owner",
      harness: "codex",
      harnessSessionId: sharedSessionId,
    })];
    await expect(loadSessionRefObservePayload(sharedSessionId)).resolves.toBeNull();

    queryAgentsResult = [];
    brokerContextResult = {
      snapshot: {
        endpoints: {
          "endpoint-codex-owner": {
            id: "endpoint-codex-owner",
            agentId: "broker-codex-owner",
            nodeId: "node-1",
            harness: "codex",
            state: "waiting",
            sessionId: "runtime-codex-owner",
            transport: "codex_app_server",
            cwd: "/Users/you/dev/openscout",
            projectRoot: "/Users/you/dev/openscout",
            metadata: {
              externalSessionId: sharedSessionId,
              threadId: sharedSessionId,
            },
          },
        },
      },
    };
    await expect(loadSessionRefObservePayload(sharedSessionId)).resolves.toBeNull();
  });

  test("scopes broker endpoint tail reads across same-id Kimi, OpenCode, and Grok transcripts", async () => {
    const sharedSessionId = "shared-acp-native-session";
    const grokPath = `/tmp/grok/${sharedSessionId}/events.jsonl`;
    const opencodePath = `/tmp/opencode/${sharedSessionId}.jsonl`;
    const kimiPath = `/tmp/kimi/${sharedSessionId}.jsonl`;
    const collidingDiscovery: TailDiscoveryStub = {
      generatedAt: Date.now(),
      processes: [],
      transcripts: [
        {
          source: "grok",
          transcriptPath: grokPath,
          sessionId: sharedSessionId,
          cwd: "/Users/you/dev/openscout",
          project: "openscout",
          harness: "unattributed",
          mtimeMs: Date.now() + 3,
          size: 300,
        },
        {
          source: "opencode",
          transcriptPath: opencodePath,
          sessionId: sharedSessionId,
          cwd: "/Users/you/dev/openscout",
          project: "openscout",
          harness: "unattributed",
          mtimeMs: Date.now() + 2,
          size: 200,
        },
        {
          source: "kimi",
          transcriptPath: kimiPath,
          sessionId: sharedSessionId,
          cwd: "/Users/you/dev/openscout",
          project: "openscout",
          harness: "unattributed",
          mtimeMs: Date.now() + 1,
          size: 100,
        },
      ],
      totals: {
        total: 0,
        scoutManaged: 0,
        hudsonManaged: 0,
        unattributed: 0,
        transcripts: 3,
      },
    };
    // The cached inventory sees only the wrong-source collision. The exact
    // endpoint transcript appears on the forced deep refresh.
    tailDiscoveryResult = {
      ...collidingDiscovery,
      transcripts: [collidingDiscovery.transcripts[0]!],
      totals: { ...collidingDiscovery.totals, transcripts: 1 },
    };
    tailRefreshDiscoveryResult = collidingDiscovery;
    brokerContextResult = {
      snapshot: {
        endpoints: Object.fromEntries([
          ["grok", "grok_acp"],
          ["opencode", "opencode_acp"],
          ["kimi", "kimi_acp"],
        ].map(([harness, transport]) => [
          `endpoint-${harness}`,
          {
            id: `endpoint-${harness}`,
            agentId: `owner-${harness}`,
            nodeId: "node-1",
            harness,
            state: "idle",
            sessionId: `runtime-${harness}`,
            transport,
            metadata: { externalSessionId: sharedSessionId },
          },
        ])),
      },
    };

    const expectedPaths = new Map([
      ["grok", grokPath],
      ["opencode", opencodePath],
      ["kimi", kimiPath],
    ]);
    for (const [harness, expectedPath] of expectedPaths) {
      const payload = await loadSessionRefObservePayload(
        `session:${harness}:${sharedSessionId}`,
      );

      expect(payload?.kind).toBe("broker");
      expect(payload?.agentId).toBe(`owner-${harness}`);
      expect(payload?.historyPath).toBe(expectedPath);
      expect(payload?.data.metadata?.session?.adapterType).toBe(harness);
    }
  });

  test("attaches discovered native history to a broker session ref", async () => {
    const tempRoot = makeTempDir("openscout-observe-broker-native-");
    process.env.OPENSCOUT_CLAUDE_PROJECTS_ROOT = join(tempRoot, "empty-projects");
    const historyPath = join(tempRoot, "claude-upstream-session.jsonl");
    writeClaudeHistory(historyPath, "live work from the native Claude session");

    queryAgentsResult = [
      makeAgent({
        id: "session-broker-1",
        harness: "claude",
        transport: "tmux",
        cwd: "/Users/guest/dev/stale-checkout",
        projectRoot: "/Users/guest/dev/stale-checkout",
        harnessSessionId: null,
      }),
    ];
    brokerContextResult = {
      snapshot: {
        endpoints: {
          "endpoint-1": {
            id: "endpoint-1",
            agentId: "session-broker-1",
            nodeId: "node-1",
            harness: "claude",
            state: "active",
            sessionId: "session-broker-1",
            transport: "tmux",
            cwd: "/Users/guest/dev/openscout",
            projectRoot: "/Users/guest/dev/openscout",
            metadata: {
              pendingExternalSession: true,
            },
          },
        },
      },
    };
    tailDiscoveryResult = {
      generatedAt: Date.now(),
      processes: [],
      transcripts: [
        {
          source: "claude",
          transcriptPath: historyPath,
          sessionId: "claude-upstream-session",
          cwd: "/Users/guest/dev/openscout",
          project: "openscout",
          harness: "unattributed",
          mtimeMs: Date.now(),
          size: 100,
        },
      ],
      totals: {
        total: 0,
        scoutManaged: 0,
        hudsonManaged: 0,
        unattributed: 0,
        transcripts: 1,
      },
    };

    const payload = await loadSessionRefObservePayload("session-broker-1");

    expect(payload?.kind).toBe("agent");
    expect(payload?.agentId).toBe("session-broker-1");
    expect(payload?.source).toBe("history");
    expect(payload?.historyPath).toBe(historyPath);
    expect(payload?.sessionId).toBe("claude-upstream-session");
    expect(payload?.data.events.some((event) => (
      event.text.includes("live work from the native Claude session")
    ))).toBe(true);
  });

  test("attaches pending tmux history only after a concrete native session id is known", async () => {
    const actorId = "session-pending-tmux";
    const providerSessionId = "claude-native-owned";
    const decoySessionId = "claude-native-decoy";
    const cwd = "/Users/you/dev/shared-flight-project";
    const tempRoot = makeTempDir("openscout-observe-pending-tmux-");
    const historyPath = join(tempRoot, `${providerSessionId}.jsonl`);
    const decoyPath = join(tempRoot, `${decoySessionId}.jsonl`);
    writeClaudeHistory(historyPath, "identity-matched flight history", {
      sessionId: providerSessionId,
      cwd,
    });
    writeClaudeHistory(decoyPath, "newer same-cwd decoy history", {
      sessionId: decoySessionId,
      cwd,
    });

    const metadata: Record<string, unknown> = {
      pendingExternalSession: true,
      handle: "project-pending-tmux",
    };
    brokerContextResult = {
      snapshot: {
        actors: {
          [actorId]: { displayName: "Pending tmux flight" },
        },
        endpoints: {
          "endpoint-current": {
            id: "endpoint-current",
            agentId: actorId,
            nodeId: "node-1",
            harness: "claude",
            state: "active",
            sessionId: actorId,
            transport: "tmux",
            cwd,
            projectRoot: cwd,
            metadata,
          },
        },
      },
    };
    tailDiscoveryResult = {
      generatedAt: Date.now(),
      processes: [],
      transcripts: [
        {
          source: "claude",
          transcriptPath: decoyPath,
          sessionId: decoySessionId,
          cwd,
          project: "shared-flight-project",
          harness: "scout-managed",
          mtimeMs: Date.now() + 1_000,
          size: 1_000,
        },
        {
          source: "claude",
          transcriptPath: historyPath,
          sessionId: providerSessionId,
          cwd,
          project: "shared-flight-project",
          harness: "scout-managed",
          mtimeMs: Date.now(),
          size: 900,
        },
      ],
      totals: {
        total: 0,
        scoutManaged: 0,
        hudsonManaged: 0,
        unattributed: 0,
        transcripts: 2,
      },
    };

    const pending = await loadSessionRefObservePayload(actorId);
    expect(pending?.kind).toBe("broker");
    expect(pending?.source).toBe("broker");
    expect(pending?.historyPath).toBeNull();
    expect(pending?.data.events.some((event) => event.text.includes("decoy"))).toBe(false);

    metadata.nativeSessionId = providerSessionId;
    const attached = await loadSessionRefObservePayload(actorId);
    expect(attached?.kind).toBe("broker");
    expect(attached?.source).toBe("history");
    expect(attached?.historyPath).toBe(historyPath);
    expect(attached?.sessionId).toBe(providerSessionId);
    expect(attached?.data.events.some((event) => (
      event.text.includes("identity-matched flight history")
    ))).toBe(true);
    expect(attached?.data.events.some((event) => (
      event.text.includes("newer same-cwd decoy history")
    ))).toBe(false);
  });

  test("surfaces a matching failed flight instead of claiming a pending session is live", async () => {
    const actorId = "session-pending-failed";
    const completedAt = Date.parse("2026-04-22T12:03:00.000Z");
    brokerContextResult = {
      snapshot: {
        actors: {
          [actorId]: { kind: "session", displayName: "Pending failed flight" },
        },
        nodes: {
          "node-1": { name: "devon-mini" },
        },
        endpoints: {
          "endpoint-1": {
            id: "endpoint-1",
            agentId: actorId,
            nodeId: "node-1",
            harness: "claude",
            state: "active",
            sessionId: actorId,
            transport: "tmux",
            cwd: "/Users/you/dev/project",
            projectRoot: "/Users/you/dev/project",
            metadata: {
              pendingExternalSession: true,
              handle: "project-pending-failed",
            },
          },
        },
        invocations: {
          "inv-1": {
            id: "inv-1",
            requesterId: "operator",
            requesterNodeId: "node-1",
            targetAgentId: actorId,
            action: "execute",
            task: "Run the pending work.",
            ensureAwake: true,
            stream: true,
            createdAt: completedAt - 60_000,
          },
        },
        flights: {
          "flt-1": {
            id: "flt-1",
            invocationId: "inv-1",
            requesterId: "operator",
            targetAgentId: actorId,
            state: "failed",
            error: "Stale running flight reconciled without a live broker task",
            startedAt: completedAt - 30_000,
            completedAt,
            metadata: {
              sessionTrace: [{
                sessionId: actorId,
                endpointId: "endpoint-1",
                startedAt: completedAt - 30_000,
                lastAcknowledgedAt: completedAt,
                endedAt: completedAt,
              }],
            },
          },
        },
      },
    };

    const payload = await loadSessionRefObservePayload(actorId);

    expect(payload?.kind).toBe("broker");
    expect(payload?.source).toBe("broker");
    expect(payload?.data.live).toBe(false);
    const handoff = payload?.data.events.find((event) => event.id === `${actorId}:handoff`);
    expect(handoff?.text).toBe("Invocation failed; no harness turns were captured.");
    expect(handoff?.at).toBe(completedAt);
    expect(handoff?.t).toBe(30);
    expect(handoff?.detail).toContain(
      "Stale running flight reconciled without a live broker task",
    );
    const registered = payload?.data.events.find((event) => event.id === `${actorId}:registered`);
    expect(registered?.at).toBe(completedAt - 30_000);
    expect(payload?.data.metadata?.session?.sessionStart).toBe(completedAt - 30_000);
    expect(payload?.data.events.some((event) => (
      event.text.includes("Waiting for the harness")
    ))).toBe(false);
    expect(payload?.data.metadata?.session?.nodeId).toBe("node-1");
    expect(payload?.data.metadata?.session?.hostName).toBe("devon-mini");
  });

  test("does not attach an unrelated failed flight to a pending session", async () => {
    const actorId = "session-pending-unrelated";
    const completedAt = Date.parse("2026-04-22T12:03:00.000Z");
    brokerContextResult = {
      snapshot: {
        actors: {
          [actorId]: { kind: "session", displayName: "Pending flight" },
        },
        endpoints: {
          "endpoint-1": {
            id: "endpoint-1",
            agentId: actorId,
            nodeId: "node-1",
            harness: "claude",
            state: "active",
            sessionId: actorId,
            transport: "tmux",
            cwd: "/Users/you/dev/project",
            projectRoot: "/Users/you/dev/project",
            metadata: {
              pendingExternalSession: true,
              handle: "project-pending-unrelated",
            },
          },
        },
        invocations: {
          "inv-other": {
            id: "inv-other",
            requesterId: "operator",
            requesterNodeId: "node-1",
            targetAgentId: "agent-other",
            action: "execute",
            task: "Unrelated work for a different session.",
            ensureAwake: true,
            stream: true,
            createdAt: completedAt - 60_000,
            execution: { targetSessionId: "session-other" },
          },
        },
        flights: {
          "flt-other": {
            id: "flt-other",
            invocationId: "inv-other",
            requesterId: "operator",
            targetAgentId: "agent-other",
            state: "failed",
            error: "Unrelated flight failure",
            startedAt: completedAt - 30_000,
            completedAt,
            metadata: {
              sessionTrace: [{
                sessionId: "session-other",
                endpointId: "endpoint-other",
                startedAt: completedAt - 30_000,
                lastAcknowledgedAt: completedAt,
                endedAt: completedAt,
              }],
            },
          },
        },
      },
    };

    const payload = await loadSessionRefObservePayload(actorId);

    expect(payload?.kind).toBe("broker");
    expect(payload?.source).toBe("broker");
    expect(payload?.data.live).toBe(true);
    const handoff = payload?.data.events.find((event) => event.id === `${actorId}:handoff`);
    expect(handoff?.text).toBe("Waiting for the harness to attach and emit its first turn.");
    expect(handoff?.t).toBe(1);
    expect(handoff?.detail ?? "").not.toContain("Unrelated flight failure");
  });

  test("prefers a newer matching active flight over an older matching failure", async () => {
    const actorId = "session-pending-superseded";
    const failedAt = Date.parse("2026-04-22T12:03:00.000Z");
    const restartedAt = Date.parse("2026-04-22T12:10:00.000Z");
    brokerContextResult = {
      snapshot: {
        actors: {
          [actorId]: { kind: "session", displayName: "Pending superseded flight" },
        },
        endpoints: {
          "endpoint-1": {
            id: "endpoint-1",
            agentId: actorId,
            nodeId: "node-1",
            harness: "claude",
            state: "active",
            sessionId: actorId,
            transport: "tmux",
            cwd: "/Users/you/dev/project",
            projectRoot: "/Users/you/dev/project",
            metadata: {
              pendingExternalSession: true,
              handle: "project-pending-superseded",
            },
          },
        },
        invocations: {
          "inv-failed": {
            id: "inv-failed",
            requesterId: "operator",
            requesterNodeId: "node-1",
            targetAgentId: actorId,
            action: "execute",
            task: "First attempt.",
            ensureAwake: true,
            stream: true,
            createdAt: failedAt - 60_000,
          },
          "inv-active": {
            id: "inv-active",
            requesterId: "operator",
            requesterNodeId: "node-1",
            targetAgentId: actorId,
            action: "execute",
            task: "Retried attempt.",
            ensureAwake: true,
            stream: true,
            createdAt: restartedAt - 1_000,
          },
        },
        flights: {
          "flt-failed": {
            id: "flt-failed",
            invocationId: "inv-failed",
            requesterId: "operator",
            targetAgentId: actorId,
            state: "failed",
            error: "First flight failure",
            startedAt: failedAt - 30_000,
            completedAt: failedAt,
            metadata: {
              sessionTrace: [{
                sessionId: actorId,
                endpointId: "endpoint-1",
                startedAt: failedAt - 30_000,
                lastAcknowledgedAt: failedAt,
                endedAt: failedAt,
              }],
            },
          },
          "flt-active": {
            id: "flt-active",
            invocationId: "inv-active",
            requesterId: "operator",
            targetAgentId: actorId,
            state: "running",
            startedAt: restartedAt,
            metadata: {
              sessionTrace: [{
                sessionId: actorId,
                endpointId: "endpoint-1",
                startedAt: restartedAt,
                lastAcknowledgedAt: restartedAt,
              }],
            },
          },
        },
      },
    };

    const payload = await loadSessionRefObservePayload(actorId);

    expect(payload?.kind).toBe("broker");
    expect(payload?.data.live).toBe(true);
    const handoff = payload?.data.events.find((event) => event.id === `${actorId}:handoff`);
    expect(handoff?.text).toBe("Waiting for the harness to attach and emit its first turn.");
    expect(handoff?.detail ?? "").not.toContain("First flight failure");
  });

  test("keeps exact native history authoritative over a matching failed flight", async () => {
    const actorId = "session-native-authoritative";
    const providerSessionId = "claude-native-authoritative";
    const completedAt = Date.parse("2026-04-22T12:03:00.000Z");
    const tempRoot = makeTempDir("openscout-observe-flight-native-");
    const historyPath = join(tempRoot, `${providerSessionId}.jsonl`);
    writeClaudeHistory(historyPath, "native turns outrank synthetic broker receipts", {
      sessionId: providerSessionId,
    });
    brokerContextResult = {
      snapshot: {
        actors: {
          [actorId]: { kind: "session", displayName: "Native authoritative flight" },
        },
        endpoints: {
          "endpoint-1": {
            id: "endpoint-1",
            agentId: actorId,
            nodeId: "node-1",
            harness: "claude",
            state: "active",
            sessionId: actorId,
            transport: "tmux",
            cwd: "/Users/you/dev/project",
            projectRoot: "/Users/you/dev/project",
            metadata: {
              pendingExternalSession: false,
              externalSessionId: providerSessionId,
              handle: "project-native-authoritative",
            },
          },
        },
        invocations: {
          "inv-1": {
            id: "inv-1",
            requesterId: "operator",
            requesterNodeId: "node-1",
            targetAgentId: actorId,
            action: "execute",
            task: "Work with native history.",
            ensureAwake: true,
            stream: true,
            createdAt: completedAt - 60_000,
          },
        },
        flights: {
          "flt-1": {
            id: "flt-1",
            invocationId: "inv-1",
            requesterId: "operator",
            targetAgentId: actorId,
            state: "failed",
            error: "Stale running flight reconciled without a live broker task",
            startedAt: completedAt - 30_000,
            completedAt,
            metadata: {
              sessionTrace: [{
                sessionId: actorId,
                endpointId: "endpoint-1",
                startedAt: completedAt - 30_000,
                lastAcknowledgedAt: completedAt,
                endedAt: completedAt,
              }],
            },
          },
        },
      },
    };
    tailDiscoveryResult = {
      generatedAt: Date.now(),
      processes: [],
      transcripts: [
        {
          source: "claude",
          transcriptPath: historyPath,
          sessionId: providerSessionId,
          cwd: "/Users/you/dev/project",
          project: "project",
          harness: "scout-managed",
          mtimeMs: Date.now(),
          size: 1_000,
        },
      ],
      totals: {
        total: 0,
        scoutManaged: 0,
        hudsonManaged: 0,
        unattributed: 0,
        transcripts: 1,
      },
    };

    const payload = await loadSessionRefObservePayload(actorId);

    expect(payload?.kind).toBe("broker");
    expect(payload?.source).toBe("history");
    expect(payload?.historyPath).toBe(historyPath);
    expect(payload?.data.events.some((event) => (
      event.text.includes("native turns outrank synthetic broker receipts")
    ))).toBe(true);
    expect(payload?.data.events.some((event) => (
      event.text.includes("Invocation failed")
    ))).toBe(false);
  });

  test("selects the current cardless endpoint and exposes its real live trace for actor, alias, and provider refs", async () => {
    const actorId = "session-cardless-current";
    const actorAlias = "project-spinoza";
    const providerSessionId = "019f-cardless-current-provider";
    const tempRoot = makeTempDir("openscout-observe-cardless-presentation-ref-");
    const actorDecoyPath = join(tempRoot, `${actorId}.jsonl`);
    const aliasDecoyPath = join(tempRoot, `${actorAlias}.jsonl`);
    writeCodexHistory(actorDecoyPath, {
      sessionId: actorId,
      cwd: "/Users/you/dev/shared-project",
      assistantText: "actor-id transcript decoy",
    });
    writeCodexHistory(aliasDecoyPath, {
      sessionId: actorAlias,
      cwd: "/Users/you/dev/shared-project",
      assistantText: "actor-alias transcript decoy",
    });
    brokerContextResult = {
      snapshot: {
        actors: {
          [actorId]: { displayName: "Project Spinoza" },
        },
        endpoints: {
          "endpoint-stale": {
            id: "endpoint-stale",
            agentId: actorId,
            nodeId: "node-1",
            harness: "codex",
            state: "active",
            sessionId: actorId,
            transport: "codex_app_server",
            metadata: {
              cardless: true,
              handle: actorAlias,
              pendingExternalSession: true,
              staleLocalRegistration: true,
              lastStartedAt: Date.parse("2026-04-22T12:02:00.000Z"),
            },
          },
          "endpoint-current": {
            id: "endpoint-current",
            agentId: actorId,
            nodeId: "node-1",
            harness: "codex",
            state: "idle",
            sessionId: actorId,
            transport: "codex_app_server",
            metadata: {
              cardless: true,
              handle: actorAlias,
              pendingExternalSession: false,
              externalSessionId: providerSessionId,
              threadId: providerSessionId,
              lastCompletedAt: Date.parse("2026-04-22T12:01:00.000Z"),
            },
          },
        },
      },
    };
    localSnapshotResultsByEndpointId.set("endpoint-stale", {
      session: {
        id: actorId,
        name: "Stale cardless session",
        adapterType: "codex_app_server",
        status: "active",
        providerMeta: { threadId: "019f-stale-provider" },
      },
      turns: [{
        id: "turn-stale",
        status: "streaming",
        blocks: [{
          status: "streaming",
          block: {
            id: "message-stale",
            turnId: "turn-stale",
            index: 0,
            type: "text",
            text: "stale endpoint event",
            status: "streaming",
          },
        }],
      }],
      currentTurnId: "turn-stale",
    });
    localSnapshotResultsByEndpointId.set("endpoint-current", {
      session: {
        id: actorId,
        name: "Current cardless session",
        adapterType: "codex_app_server",
        status: "active",
        providerMeta: { threadId: providerSessionId },
      },
      turns: [{
        id: "turn-current",
        status: "streaming",
        blocks: [{
          status: "streaming",
          block: {
            id: "message-current",
            turnId: "turn-current",
            index: 0,
            type: "text",
            text: "current endpoint event",
            status: "streaming",
          },
        }],
      }],
      currentTurnId: "turn-current",
    });
    tailDiscoveryResult = {
      generatedAt: Date.now(),
      processes: [],
      transcripts: [
        {
          source: "codex",
          transcriptPath: actorDecoyPath,
          sessionId: actorId,
          cwd: "/Users/you/dev/shared-project",
          project: "shared-project",
          harness: "scout-managed",
          mtimeMs: Date.now(),
          size: 1_000,
        },
        {
          source: "codex",
          transcriptPath: aliasDecoyPath,
          sessionId: actorAlias,
          cwd: "/Users/you/dev/shared-project",
          project: "shared-project",
          harness: "scout-managed",
          mtimeMs: Date.now(),
          size: 900,
        },
      ],
      totals: {
        total: 0,
        scoutManaged: 0,
        hudsonManaged: 0,
        unattributed: 0,
        transcripts: 2,
      },
    };

    for (const ref of [actorId, actorAlias, providerSessionId]) {
      const payload = await loadSessionRefObservePayload(ref);

      expect(payload?.kind).toBe("broker");
      expect(payload?.agentId).toBe(actorId);
      expect(payload?.source).toBe("live");
      expect(payload?.sessionId).toBe(providerSessionId);
      expect(payload?.data.events.some((event) => event.text === "current endpoint event")).toBe(true);
      expect(payload?.data.events.some((event) => event.text === "stale endpoint event")).toBe(false);
      expect(payload?.data.events.some((event) => event.text.includes("transcript decoy"))).toBe(false);
      expect(payload?.data.events.some((event) => event.text.startsWith("Session registered"))).toBe(false);
    }
  });

  test("matches opaque provider session ids exactly even when they differ only by case", async () => {
    const actorId = "session-case-sensitive-provider";
    const exactProviderId = "Native-Session-ABC";
    const collidingProviderId = "native-session-abc";
    brokerContextResult = {
      snapshot: {
        actors: {
          [actorId]: { displayName: "Case-sensitive provider" },
        },
        endpoints: {
          "endpoint-exact": {
            id: "endpoint-exact",
            agentId: actorId,
            nodeId: "node-1",
            harness: "codex",
            state: "idle",
            sessionId: actorId,
            transport: "codex_app_server",
            metadata: {
              cardless: true,
              pendingExternalSession: false,
              externalSessionId: exactProviderId,
              threadId: exactProviderId,
              lastCompletedAt: Date.parse("2026-04-22T12:00:00.000Z"),
            },
          },
          "endpoint-collision": {
            id: "endpoint-collision",
            agentId: actorId,
            nodeId: "node-1",
            harness: "codex",
            state: "active",
            sessionId: actorId,
            transport: "codex_app_server",
            metadata: {
              cardless: true,
              pendingExternalSession: false,
              externalSessionId: collidingProviderId,
              threadId: collidingProviderId,
              lastStartedAt: Date.parse("2026-04-22T12:01:00.000Z"),
            },
          },
        },
      },
    };
    localSnapshotResultsByEndpointId.set("endpoint-exact", {
      session: {
        id: actorId,
        name: "Exact-case endpoint",
        adapterType: "codex_app_server",
        status: "active",
        providerMeta: { threadId: exactProviderId },
      },
      turns: [{
        id: "turn-exact",
        status: "streaming",
        blocks: [{
          status: "streaming",
          block: {
            id: "message-exact",
            turnId: "turn-exact",
            index: 0,
            type: "text",
            text: "exact-case endpoint event",
            status: "streaming",
          },
        }],
      }],
      currentTurnId: "turn-exact",
    });
    localSnapshotResultsByEndpointId.set("endpoint-collision", {
      session: {
        id: actorId,
        name: "Case-colliding endpoint",
        adapterType: "codex_app_server",
        status: "active",
        providerMeta: { threadId: collidingProviderId },
      },
      turns: [{
        id: "turn-collision",
        status: "streaming",
        blocks: [{
          status: "streaming",
          block: {
            id: "message-collision",
            turnId: "turn-collision",
            index: 0,
            type: "text",
            text: "case-colliding endpoint event",
            status: "streaming",
          },
        }],
      }],
      currentTurnId: "turn-collision",
    });

    const payload = await loadSessionRefObservePayload(exactProviderId);

    expect(payload?.kind).toBe("broker");
    expect(payload?.source).toBe("live");
    expect(payload?.sessionId).toBe(exactProviderId);
    expect(payload?.data.events.some((event) => event.text === "exact-case endpoint event")).toBe(true);
    expect(payload?.data.events.some((event) => event.text === "case-colliding endpoint event")).toBe(false);
  });

  test("fails closed when an unscoped opaque provider id belongs to multiple owners", async () => {
    const sharedProviderId = "Native-Session-Shared";
    brokerContextResult = {
      snapshot: {
        actors: {
          "agent-codex": { displayName: "Codex owner" },
          "agent-claude": { displayName: "Claude owner" },
        },
        endpoints: {
          "endpoint-codex": {
            id: "endpoint-codex",
            agentId: "agent-codex",
            nodeId: "node-1",
            harness: "codex",
            state: "idle",
            sessionId: "runtime-codex",
            transport: "codex_app_server",
            metadata: {
              externalSessionId: sharedProviderId,
              threadId: sharedProviderId,
              handle: "codex-owner",
              lastCompletedAt: Date.parse("2026-04-22T12:00:00.000Z"),
            },
          },
          "endpoint-claude": {
            id: "endpoint-claude",
            agentId: "agent-claude",
            nodeId: "node-1",
            harness: "claude",
            state: "active",
            sessionId: "runtime-claude",
            transport: "claude_stream_json",
            metadata: {
              externalSessionId: sharedProviderId,
              nativeSessionId: sharedProviderId,
              handle: "claude-owner",
              lastStartedAt: Date.parse("2026-04-22T12:01:00.000Z"),
            },
          },
        },
      },
    };
    localSnapshotResultsByEndpointId.set("endpoint-codex", {
      session: {
        id: "runtime-codex",
        name: "Codex owner",
        adapterType: "codex_app_server",
        status: "active",
        providerMeta: { threadId: sharedProviderId },
      },
      turns: [],
    });
    localSnapshotResultsByEndpointId.set("endpoint-claude", {
      session: {
        id: "runtime-claude",
        name: "Claude owner",
        adapterType: "claude_stream_json",
        status: "active",
        providerMeta: { externalSessionId: sharedProviderId },
      },
      turns: [],
    });

    await expect(loadSessionRefObservePayload(sharedProviderId)).resolves.toBeNull();

    const codexPayload = await loadSessionRefObservePayload("codex-owner");
    expect(codexPayload?.kind).toBe("broker");
    expect(codexPayload?.agentId).toBe("agent-codex");

    const claudePayload = await loadSessionRefObservePayload("agent-claude");
    expect(claudePayload?.kind).toBe("broker");
    expect(claudePayload?.agentId).toBe("agent-claude");
  });

  test("fails closed when a broker handle identifies multiple owners", async () => {
    const sharedHandle = "duplicate-friendly-handle";
    brokerContextResult = {
      snapshot: {
        endpoints: Object.fromEntries(["owner-a", "owner-b"].map((agentId, index) => [
          `endpoint-${agentId}`,
          {
            id: `endpoint-${agentId}`,
            agentId,
            nodeId: "node-1",
            harness: "codex",
            state: index === 0 ? "active" : "idle",
            sessionId: `runtime-${agentId}`,
            transport: "codex_app_server",
            metadata: { handle: sharedHandle },
          },
        ])),
      },
    };

    await expect(
      loadSessionRefObservePayload(`session:codex:${sharedHandle}`),
    ).resolves.toBeNull();
  });

  test("prefers an exact broker actor id over another owner's colliding handle", async () => {
    const exactActorId = "canonical-actor-id";
    brokerContextResult = {
      snapshot: {
        actors: {
          [exactActorId]: { displayName: "Canonical actor" },
          "handle-owner": { displayName: "Handle owner" },
        },
        endpoints: {
          "endpoint-exact-actor": {
            id: "endpoint-exact-actor",
            agentId: exactActorId,
            nodeId: "node-1",
            harness: "codex",
            state: "idle",
            sessionId: "runtime-exact-actor",
            transport: "codex_app_server",
            metadata: { handle: "canonical-owner" },
          },
          "endpoint-colliding-handle": {
            id: "endpoint-colliding-handle",
            agentId: "handle-owner",
            nodeId: "node-1",
            harness: "codex",
            state: "active",
            sessionId: "runtime-handle-owner",
            transport: "codex_app_server",
            metadata: { handle: exactActorId },
          },
        },
      },
    };

    const payload = await loadSessionRefObservePayload(`session:codex:${exactActorId}`);

    expect(payload?.kind).toBe("broker");
    expect(payload?.agentId).toBe(exactActorId);
  });

  test("fails closed when database and broker owners claim the same qualified provider id", async () => {
    const sharedProviderId = "Native-Session-Cross-Source";
    queryAgentsResult = [makeAgent({
      id: "database-owner",
      harness: "codex",
      harnessSessionId: sharedProviderId,
    })];
    brokerContextResult = {
      snapshot: {
        endpoints: {
          "endpoint-broker-owner": {
            id: "endpoint-broker-owner",
            agentId: "broker-owner",
            nodeId: "node-1",
            harness: "codex",
            state: "active",
            sessionId: "runtime-broker-owner",
            transport: "codex_app_server",
            metadata: {
              externalSessionId: sharedProviderId,
              threadId: sharedProviderId,
            },
          },
        },
      },
    };

    await expect(loadSessionRefObservePayload(`session:codex:${sharedProviderId}`)).resolves.toBeNull();
  });

  test("keeps an explicit broker presentation ref ahead of a colliding database provider id", async () => {
    const brokerOwner = "broker-presentation-owner";
    queryAgentsResult = [makeAgent({
      id: "database-owner",
      harness: "codex",
      harnessSessionId: brokerOwner,
    })];
    brokerContextResult = {
      snapshot: {
        actors: {
          [brokerOwner]: { displayName: "Broker presentation owner" },
        },
        endpoints: {
          "endpoint-broker-presentation": {
            id: "endpoint-broker-presentation",
            agentId: brokerOwner,
            nodeId: "node-1",
            harness: "codex",
            state: "waiting",
            sessionId: "runtime-broker-presentation",
            transport: "codex_app_server",
            metadata: {
              threadId: "native-broker-presentation",
            },
          },
        },
      },
    };

    const payload = await loadSessionRefObservePayload(`session:codex:${brokerOwner}`);

    expect(payload?.kind).toBe("broker");
    expect(payload?.agentId).toBe(brokerOwner);
  });

  test("reads an exact provider transcript for cardless actor and provider refs without cwd guessing", async () => {
    const actorId = "session-cardless-history";
    const routingSessionId = "runtime-cardless-history";
    const providerSessionId = "019ff3f8-322d-7572-990f-447725ffd348";
    const decoySessionId = "019ff3f8-89d8-7e21-9825-7a5c752af6c3";
    const tempRoot = makeTempDir("openscout-observe-cardless-history-");
    const historyPath = join(tempRoot, `${providerSessionId}.jsonl`);
    const routingDecoyPath = join(tempRoot, `${routingSessionId}.jsonl`);
    const decoyPath = join(tempRoot, `${decoySessionId}.jsonl`);
    writeCodexHistory(historyPath, {
      sessionId: providerSessionId,
      cwd: "/Users/you/dev/shared-project",
      assistantText: "exact provider transcript event",
    });
    writeCodexHistory(routingDecoyPath, {
      sessionId: routingSessionId,
      cwd: "/Users/you/dev/shared-project",
      assistantText: "routing session transcript decoy",
    });
    writeCodexHistory(decoyPath, {
      sessionId: decoySessionId,
      cwd: "/Users/you/dev/shared-project",
      assistantText: "newer same-cwd decoy event",
    });

    brokerContextResult = {
      snapshot: {
        actors: {
          [actorId]: { displayName: "Project Spinoza" },
        },
        endpoints: {
          "endpoint-current": {
            id: "endpoint-current",
            agentId: actorId,
            nodeId: "node-1",
            harness: "codex",
            state: "active",
            sessionId: routingSessionId,
            transport: "codex_app_server",
            cwd: "/Users/you/dev/shared-project",
            metadata: {
              cardless: true,
              pendingExternalSession: false,
              externalSessionId: providerSessionId,
              threadId: providerSessionId,
              lastStartedAt: Date.parse("2026-04-22T12:00:00.000Z"),
            },
          },
        },
      },
    };
    localSnapshotResultsByEndpointId.set("endpoint-current", {
      session: {
        id: actorId,
        name: "Current cardless session",
        adapterType: "codex_app_server",
        status: "active",
        cwd: "/Users/you/dev/shared-project",
        providerMeta: { threadId: providerSessionId },
      },
      turns: [],
    });
    tailDiscoveryResult = {
      generatedAt: Date.now(),
      processes: [],
      transcripts: [
        {
          source: "codex",
          transcriptPath: routingDecoyPath,
          sessionId: routingSessionId,
          cwd: "/Users/you/dev/shared-project",
          project: "shared-project",
          harness: "scout-managed",
          mtimeMs: Date.now() + 2_000,
          size: 1_100,
        },
        {
          source: "codex",
          transcriptPath: decoyPath,
          sessionId: decoySessionId,
          cwd: "/Users/you/dev/shared-project",
          project: "shared-project",
          harness: "scout-managed",
          mtimeMs: Date.now() + 1_000,
          size: 1_000,
        },
        {
          source: "codex",
          transcriptPath: historyPath,
          sessionId: providerSessionId,
          cwd: "/Users/you/dev/shared-project",
          project: "shared-project",
          harness: "scout-managed",
          mtimeMs: Date.now(),
          size: 900,
        },
      ],
      totals: {
        total: 0,
        scoutManaged: 0,
        hudsonManaged: 0,
        unattributed: 0,
        transcripts: 3,
      },
    };

    for (const ref of [actorId, routingSessionId, providerSessionId]) {
      const payload = await loadSessionRefObservePayload(ref);

      expect(payload?.kind).toBe("broker");
      expect(payload?.agentId).toBe(actorId);
      expect(payload?.source).toBe("history");
      expect(payload?.fidelity).toBe("timestamped");
      expect(payload?.historyPath).toBe(historyPath);
      expect(payload?.sessionId).toBe(providerSessionId);
      expect(payload?.data.events.some((event) => event.text.includes("exact provider transcript event"))).toBe(true);
      expect(payload?.data.events.some((event) => event.text.includes("routing session transcript decoy"))).toBe(false);
      expect(payload?.data.events.some((event) => event.text.includes("newer same-cwd decoy event"))).toBe(false);
    }
  });

  test("preserves the writable agent and harness session for broker session refs", async () => {
    brokerContextResult = {
      snapshot: {
        actors: {},
        endpoints: {
          "endpoint-1": {
            id: "endpoint-1",
            agentId: "agent-1",
            nodeId: "node-1",
            harness: "codex",
            state: "active",
            sessionId: "runtime-session-1",
            transport: "codex_app_server",
            metadata: {
              externalSessionId: "019f5b95-dce0-73d3-a4da-aff357e1d464",
            },
          },
        },
      },
    };

    const payload = await loadSessionRefObservePayload("019f5b95-dce0-73d3-a4da-aff357e1d464");

    expect(payload?.kind).toBe("broker");
    expect(payload?.agentId).toBe("agent-1");
    expect(payload?.sessionId).toBe("019f5b95-dce0-73d3-a4da-aff357e1d464");
  });

  test("does not describe an offline broker endpoint as attached or live", async () => {
    brokerContextResult = {
      snapshot: {
        actors: {},
        endpoints: {
          "endpoint-offline": {
            id: "endpoint-offline",
            agentId: "session-offline",
            nodeId: "node-1",
            harness: "codex",
            state: "offline",
            sessionId: "runtime-session-offline",
            transport: "codex_app_server",
            metadata: {
              externalSessionId: "Native-Session-Offline",
              threadId: "Native-Session-Offline",
            },
          },
        },
      },
    };

    const payload = await loadSessionRefObservePayload("Native-Session-Offline");

    expect(payload?.kind).toBe("broker");
    expect(payload?.source).toBe("broker");
    expect(payload?.data.live).toBe(false);
    expect(payload?.data.events.some((event) => (
      event.text === "Harness session is not currently reachable; no trace events were captured."
    ))).toBe(true);
    expect(payload?.data.events.some((event) => event.text.includes("session attached"))).toBe(false);
    expect(payload?.data.events.some((event) => event.detail?.includes("endpoint state: offline"))).toBe(true);
  });

  test("does not describe a stale active registration as attached or live", async () => {
    brokerContextResult = {
      snapshot: {
        actors: {},
        endpoints: {
          "endpoint-stale-active": {
            id: "endpoint-stale-active",
            agentId: "session-stale-active",
            nodeId: "node-1",
            harness: "codex",
            state: "active",
            sessionId: "runtime-session-stale-active",
            transport: "codex_app_server",
            metadata: {
              externalSessionId: "Native-Session-Stale",
              threadId: "Native-Session-Stale",
              staleLocalRegistration: true,
            },
          },
        },
      },
    };

    const payload = await loadSessionRefObservePayload("Native-Session-Stale");

    expect(payload?.kind).toBe("broker");
    expect(payload?.source).toBe("broker");
    expect(payload?.data.live).toBe(false);
    expect(payload?.data.events.some((event) => (
      event.text === "Harness session is not currently reachable; no trace events were captured."
    ))).toBe(true);
    expect(payload?.data.events.some((event) => event.text.includes("session attached"))).toBe(false);
    expect(payload?.data.events.some((event) => event.detail?.includes("registration is stale"))).toBe(true);
  });
});
