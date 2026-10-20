// Shared setup for the web server HTTP tests. It must be imported before the
// server module: it installs the module mocks, then imports the server.
import { isolatedTestHome } from "./web-server-test-env.ts";
import { afterAll, beforeEach, afterEach, mock } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionBlock, BlockState, QuestionBlock, SessionState } from "@openscout/agent-sessions";
import {
  CHANNEL_NATURAL_KEY_METADATA,
  CHANNEL_SPACE_SLUG_METADATA,
  SCOUT_RUNTIME_CATALOG,
  namedChannelNaturalKey,
  spaceNaturalKey,
  spacedChannelNaturalKey,
  stableChannelId,
  type ConversationProjectionItem,
  type ConversationProjectionSnapshot,
  type MachineRecord,
} from "@openscout/protocol";
import type { DiscoverySnapshot } from "@openscout/runtime/tail";
import {
  buildRelayAgentInstance,
  writeRelayAgentOverrides,
} from "@openscout/runtime/setup";
import { encodeMessageHistoryCursor } from "../shared/message-pagination.ts";
import { encodeChannelPollCursor } from "./core/conversations/channel-polling.ts";
// After the env module: pairing.ts reads the isolated home at load.
import * as realScoutPairingModule from "./pairing.ts";

export { isolatedTestHome };


export const originalFetch = globalThis.fetch;
export const originalHome = process.env.HOME;
export const originalOpenScoutHome = process.env.OPENSCOUT_HOME;
export const originalSupportDirectory = process.env.OPENSCOUT_SUPPORT_DIRECTORY;
export const originalControlHome = process.env.OPENSCOUT_CONTROL_HOME;
export const originalRelayHub = process.env.OPENSCOUT_RELAY_HUB;
export const originalNodeQualifier = process.env.OPENSCOUT_NODE_QUALIFIER;
export const originalOperatorName = process.env.OPENSCOUT_OPERATOR_NAME;
export const originalOpenAIKey = process.env.OPENAI_API_KEY;
export const originalOpenAIModel = process.env.OPENAI_MODEL;
export const originalScoutbotAssistantModel = process.env.OPENSCOUT_SCOUTBOT_ASSISTANT_MODEL;
const originalScoutbotProcess = process.env.OPENSCOUT_SCOUTBOT_PROCESS;
export const originalProbesSocket = process.env.OPENSCOUT_PROBES_SOCKET;
export const sendScoutMessageCalls: Array<Record<string, unknown>> = [];
export const sendScoutConversationMessageCalls: Array<Record<string, unknown>> = [];
export const sendScoutMessageReactionCalls: Array<Record<string, unknown>> = [];
export const sendScoutConversationSteerCalls: Array<Record<string, unknown>> = [];
export const sendScoutDirectMessageCalls: Array<Record<string, unknown>> = [];
export const askScoutQuestionCalls: Array<Record<string, unknown>> = [];
export const openScoutDirectSessionCalls: Array<Record<string, unknown>> = [];
export const upsertScoutConversationCalls: Array<Record<string, unknown>> = [];
export const queryRunsCalls: Array<Record<string, unknown>> = [];
/** Mutable stub state the module mocks read; tests assign through it. */
export const stubs = {
  queryRunsResult: [] as Array<Record<string, unknown>>,
  queryFlightsResult: [] as Array<Record<string, unknown>>,
  queryFlightRecordByIdResult: null as Record<string, unknown> | null,
  queryInvocationsResult: [] as Array<Record<string, unknown>>,
  queryFlightRecordsResult: [] as Array<Record<string, unknown>>,
  decidePairingApprovalFailure: false,
  permissionDecisions: [] as Array<Record<string, unknown>>,
  permissionDecisionFailure: false,
  permissionDecisionUnconfirmed: false,
  questionHistoryRecords: [] as any[],
  questionHistoryFailure: false,
  interruptPairingFailure: false,
  scoutBrokerContextResult: null as unknown,
  // When set — including to null — a conversations-scoped broker read returns
  // this instead of scoutBrokerContextResult, so a test can keep the channel
  // resolvable while the transcript read sees a broker that cannot answer.
  conversationsScopeBrokerContextResult: undefined as unknown,
  loadScoutBrokerContextGate: null as Promise<void> | null,
  loadScoutBrokerContextCalls: 0,
  scoutBrokerMessagesResult: null as Array<Record<string, unknown>> | null,
  scoutBrokerHomeResult: null as Record<string, unknown> | null,
  scoutBrokerSnapshotResult: null as Record<string, unknown> | null,
  scoutBrokerSnapshotReader: null as ((options: { signal?: AbortSignal }) => Promise<Record<string, unknown> | null>) | null,
  scoutConversationProjectionResult: null as ConversationProjectionSnapshot | null,
  scoutBrokerHealthResult: makeOfflineBrokerHealth() as Record<string, unknown>,
  agentObservePayloadResult: null as unknown,
  loadAgentObservePayloadCalls: 0,
  sessionRefObservePayloadResult: null as unknown,
  queryAgentsResult: [] as Array<Record<string, unknown>>,
  querySessionsResult: [] as Array<Record<string, unknown>>,
  querySessionsCalls: 0,
  queryTerminalSessionsResult: [] as Array<Record<string, unknown>>,
  queryDiscoveredTerminalSessionsResult: [] as Array<Record<string, unknown>>,
  brokerDiagnosticsResult: makeBrokerDiagnostics() as Record<string, unknown>,
  pairingStateResult: makePairingState() as Record<string, unknown>,
  getPairingStateCalls: 0,
  refreshPairingStateCalls: 0,
  pairingSessionSnapshotsResult: [] as SessionState[],
  queryFleetResult: null as Record<string, unknown> | null,
  queryRecentMessagesResult: [] as Array<Record<string, unknown>>,
  querySessionByIdImpl: (() => null) as (conversationId: string) => {
  id?: string;
  kind: string;
  agentId: string | null;
  participantIds: string[];
} | null,
  queryConversationDefinitionByIdImpl: (() => null) as (conversationId: string) => {
  id: string;
  kind: string;
  title: string;
  visibility: string;
  shareMode: string;
  authorityNodeId: string;
  topic: string | null;
  parentConversationId: string | null;
  messageId: string | null;
  metadata: Record<string, unknown>;
  participantIds: string[];
} | null,
  openScoutDirectSessionResult: ({
  agent: { id: "agent-1" },
  conversation: {
    id: "c.agent-1",
    kind: "direct",
    title: "Agent One",
    visibility: "private",
    shareMode: "local",
    authorityNodeId: "node-1",
    participantIds: ["agent-1", "operator"],
    metadata: { naturalKey: "direct:agent-1,operator" },
  },
  existed: true,
}) as Record<string, unknown>,
  sendScoutMessageResult: ({
  usedBroker: true,
  invokedTargets: [],
  unresolvedTargets: [],
}) as unknown,
  sendScoutDirectMessageResult: ({
  conversationId: "c.agent-1",
  messageId: "msg-1",
  flight: {
    id: "flt-1",
    invocationId: "inv-1",
    targetAgentId: "agent-1",
    state: "queued",
  },
}) as unknown,
  askScoutQuestionResult: ({
  usedBroker: true,
  conversationId: "c.agent-1",
  messageId: "msg-ask-1",
  flight: {
    id: "flt-ask-1",
    invocationId: "inv-ask-1",
    targetAgentId: "agent-1",
    state: "queued",
  },
}) as unknown,
  scoutRelayConfigResult: {} as Record<string, unknown>,
};
export const questionHistoryCalls: unknown[] = [];
export const interruptPairingCalls: Array<Record<string, unknown>> = [];
export const decidePairingApprovalCalls: Array<Record<string, unknown>> = [];
export const lanBeaconSuppressPredicates: Array<() => boolean | Promise<boolean>> = [];
export const testDirectories = new Set<string>();
export const loadScoutBrokerContextOptions: unknown[] = [];
export const queryAgentsLimits: Array<number | undefined> = [];
export const queryRecentMessagesCalls: Array<Record<string, unknown>> = [];
mock.module("./db-queries.ts", () => ({
  configureReadonlyDb: (db: { exec(sql: string): void }) => {
    db.exec("PRAGMA busy_timeout = 250");
    db.exec("PRAGMA query_only = ON");
  },
  queryAgentById: (agentId: string) =>
    stubs.queryAgentsResult.find((agent) => agent.id === agentId) ?? null,
  queryAgents: (limit?: number) => {
    queryAgentsLimits.push(limit);
    return limit === undefined ? stubs.queryAgentsResult : stubs.queryAgentsResult.slice(0, limit);
  },
  queryActivity: () => [],
  queryBrokerAttentionHints: () => stubs.brokerDiagnosticsResult,
  queryBrokerDiagnostics: () => stubs.brokerDiagnosticsResult,
  queryConversationDefinitionById: (conversationId: string) =>
    stubs.queryConversationDefinitionByIdImpl(conversationId),
  queryHeartrate: () => [],
  queryFleet: () => stubs.queryFleetResult ?? ({
    generatedAt: Date.now(),
    totals: { active: 0, recentCompleted: 0, needsAttention: 0, activity: 0 },
    activeAsks: [],
    recentCompleted: [],
    needsAttention: [],
    activity: [],
  }),
  queryFlightRecordById: () => stubs.queryFlightRecordByIdResult,
  queryFlightRecords: () => stubs.queryFlightRecordsResult,
  queryFollowTarget: () => null,
  queryFlights: () => stubs.queryFlightsResult,
  queryInvocationById: () => null,
  queryInvocations: () => stubs.queryInvocationsResult,
  queryRuns: (opts: Record<string, unknown>) => {
    queryRunsCalls.push(opts);
    return stubs.queryRunsResult;
  },
  queryTerminalSessions: () => stubs.queryTerminalSessionsResult,
  queryRecentMessages: (limit?: number, opts?: Record<string, unknown>) => {
    queryRecentMessagesCalls.push({ limit, ...opts });
    return opts?.messageId ? stubs.queryRecentMessagesResult.filter(message => message.id === opts.messageId) : stubs.queryRecentMessagesResult;
  },
  querySessions: () => {
    stubs.querySessionsCalls += 1;
    return stubs.querySessionsResult;
  },
  querySessionById: (conversationId: string) =>
    stubs.querySessionByIdImpl(conversationId),
  queryWorkItems: () => [],
  queryWorkItemById: () => null,
}));

mock.module("./terminal-session-discovery.ts", () => ({
  parseTmuxSessionList: (output: string) => output
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.includes("|") ? splitDelimitedLine(line, "|", 5) : splitDelimitedLine(line, "\t", 5);
      const [name, windows, attached, currentCommand, currentPath] = parts;
      return {
        name,
        windows: Number.parseInt(windows ?? "1", 10),
        attached: Number.parseInt(attached ?? "0", 10),
        currentCommand: cleanOptionalString(currentCommand),
        currentPath: cleanOptionalString(currentPath),
      };
    }),
  parseZellijSessionList: (output: string) => output
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "")
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({
      name: line.split(/\s+/u)[0] ?? "",
      state: /\bEXITED\b/iu.test(line) ? "exited" : "live",
      raw: line,
    })),
  queryDiscoveredTerminalSessions: () => stubs.queryDiscoveredTerminalSessionsResult,
  reconcileTerminalSessionInventory: (
    registered: Array<Record<string, unknown>>,
    discovered: Array<Record<string, unknown>>,
    limit: number,
  ) => [...registered, ...discovered].slice(0, limit),
  terminalSurfaceKey: (backend: string, sessionName: string) => `${backend}:${sessionName}`,
}));

// Spread the real module so the mock stays a superset of pairing.ts exports.
// mock.module replacements leak across test files in a full `bun test` sweep;
// a partial mock makes any later file importing an unlisted export die with
// "Export named … not found". Imported statically after web-server-test-env.ts
// so the isolated home is set before pairing.ts loads.
export const realScoutPairing = realScoutPairingModule;
mock.module("./pairing.ts", () => ({
  ...realScoutPairing,
  controlScoutWebPairingService: async () => stubs.pairingStateResult,
  interruptScoutWebPairingTurn: async (input: Record<string, unknown>) => {
    interruptPairingCalls.push(input);
    if (stubs.interruptPairingFailure) throw new Error("Controlled interrupt uncertainty");
  },
  decideScoutWebPairingApproval: async (input: Record<string, unknown>) => {
    decidePairingApprovalCalls.push(input);
    if (stubs.decidePairingApprovalFailure) throw new Error("Controlled adapter failure");
    return stubs.pairingStateResult;
  },
  getScoutWebPairingState: async () => {
    stubs.getPairingStateCalls += 1;
    return stubs.pairingStateResult;
  },
  getScoutWebPairingSessionSnapshot: async (sessionId: string) =>
    stubs.pairingSessionSnapshotsResult.find((snapshot) => snapshot.session.id === sessionId) ?? null,
  getScoutWebPairingSessionSnapshots: async () => stubs.pairingSessionSnapshotsResult,
  refreshScoutWebPairingState: async () => {
    stubs.refreshPairingStateCalls += 1;
    return stubs.pairingStateResult;
  },
  removeScoutPairingTrustedPeer: () => false,
}));

mock.module("./pairing-lan-beacon.ts", () => ({
  startScoutPairLanBeacon: (shouldSuppressBeacon: () => boolean | Promise<boolean>) => {
    lanBeaconSuppressPredicates.push(shouldSuppressBeacon);
    return { stop() {} };
  },
}));

/// A module mock replaces the module wholesale, so a named export the server
/// graph imports but this file forgot to list fails at link time — a bare
/// "Export named 'x' not found" with no test name attached. These stand in for
/// the broker functions no test here drives: present so the graph links, loud
/// if a test ever starts depending on one.
export function unstubbedBrokerCall(name: string) {
  return () => {
    throw new Error(`broker service ${name} is not stubbed in this test`);
  };
}

export const chatReadCursors: Record<string, Array<Record<string, unknown>>> = {};
export const chatMarkReadCalls: Array<Record<string, unknown>> = [];

mock.module("./core/broker/service.ts", () => ({
  requestScoutHostWeb: async () => ({ status: 503, body: { error: "No test host transport" } }),
  loadScoutRemoteApprovals: async () => [],
  decideScoutPermission: async (input: Record<string, unknown>) => {
    stubs.permissionDecisions.push(input);
    if (stubs.permissionDecisionUnconfirmed) throw Object.assign(new Error("Acknowledgement timed out"), { status: 502 });
    if (stubs.permissionDecisionFailure) throw Object.assign(new Error("Permission request has no live waiting process"), { status: 409 });
  },
  decideScoutRemoteApproval: async () => ({ ok: false, error: "not_watching" }),
  readScoutChatQuestionHistory: async (baseUrl: string, channelId: string, after: unknown) => {
    questionHistoryCalls.push({ baseUrl, channelId, after });
    if (stubs.questionHistoryFailure) throw new Error("Controlled history read failure");
    return stubs.questionHistoryRecords;
  },
  appendScoutCollaborationEvent: async () => null,
  cancelScoutChatFlight: async (flightId: string) => {
    chatMarkReadCalls.push({ kind: "cancel", flightId });
    const state = (stubs.scoutBrokerContextResult as any)?.snapshot.flights?.[flightId]?.state;
    return state === "queued" ? { ok: true, state: "cancelled" } : { ok: false, status: 409, error: "Active session cannot be stopped from Chat." };
  },
  readScoutBrokerTailRecent: unstubbedBrokerCall("readScoutBrokerTailRecent"),
  recordScoutBrokerReadCursor: unstubbedBrokerCall("recordScoutBrokerReadCursor"),
  watchScoutMessages: unstubbedBrokerCall("watchScoutMessages"),
  renameScoutConversation: unstubbedBrokerCall("renameScoutConversation"),
  ScoutDirectDeliveryUnavailableError: class ScoutDirectDeliveryUnavailableError extends Error {},
  loadScoutBrokerContext: async (_baseUrl?: string, options?: unknown) => {
    stubs.loadScoutBrokerContextCalls += 1;
    loadScoutBrokerContextOptions.push(options);
    if (stubs.loadScoutBrokerContextGate) await stubs.loadScoutBrokerContextGate;
    if (stubs.conversationsScopeBrokerContextResult !== undefined
      && (options as { scope?: string } | undefined)?.scope === "conversations") {
      return stubs.conversationsScopeBrokerContextResult;
    }
    return stubs.scoutBrokerContextResult;
  },
  invalidateScoutBrokerContextCache: () => {},
  loadScoutReadCursors: async (input: { conversationId: string }) => chatReadCursors[input.conversationId] ?? [],
  loadScoutRelayConfig: async () => stubs.scoutRelayConfigResult,
  respondScoutChatQuestion: async (input: Record<string, unknown>) => { chatMarkReadCalls.push({ kind: "question-response", ...input }); return { ok: true, record: { id: input.questionId, kind: "question", state: "closed", title: "Question", createdById: input.actorId, conversationId: input.channelId, updatedAt: 2, createdAt: 1 } }; },
  correctScoutChatMessage: async (input: Record<string, unknown>) => { chatMarkReadCalls.push({ kind: "correction", ...input }); return { ok: true, message: { id: input.messageId, conversationId: input.conversationId, actorId: input.actorId, body: "Corrected", createdAt: 1 } }; },
  updateScoutChannelPins: async (input: Record<string, unknown>) => { chatMarkReadCalls.push({ kind: "pins", ...input }); return { ok: true, conversation: { metadata: { chatPins: [] } } }; },
  updateScoutChatPreferences: async (input: Record<string, unknown>) => { chatMarkReadCalls.push({ kind: "preferences", ...input }); return { ok: true }; },
  markScoutConversationRead: async (input: Record<string, unknown>) => { chatMarkReadCalls.push(input); return { ok: true }; },
  normalizeOutgoingAttachments: (attachments: Array<Record<string, unknown>> | undefined) => {
    const normalized = attachments
      ?.filter((attachment) => typeof attachment.mediaType === "string" && (attachment.url || attachment.blobKey))
      .map((attachment, index) => ({
        id: typeof attachment.id === "string" && attachment.id.trim() ? attachment.id : `att-test-${index}`,
        mediaType: attachment.mediaType,
        fileName: attachment.fileName,
        url: attachment.url,
        blobKey: attachment.blobKey,
      }));
    return normalized?.length ? normalized : undefined;
  },
  registerScoutLocalAgentBinding: async () => null,
  readScoutBrokerHealth: async () => stubs.scoutBrokerHealthResult,
  readScoutBrokerNodeId: async () =>
    (stubs.scoutBrokerContextResult as { node?: { id?: string } } | null)?.node?.id ?? null,
  readScoutBrokerHome: async () => stubs.scoutBrokerHomeResult,
  readScoutConversationProjection: async () => stubs.scoutConversationProjectionResult,
  readScoutBrokerRuntimeCatalog: async () => null,
  readScoutBrokerMessages: async () => stubs.scoutBrokerMessagesResult,
  readScoutBrokerSnapshot: async (_url: unknown, options: { signal?: AbortSignal }) => stubs.scoutBrokerSnapshotReader ? stubs.scoutBrokerSnapshotReader(options) : stubs.scoutBrokerSnapshotResult,
  resolveScoutBrokerUrl: () => "http://broker.test",
  resolveScoutBrokerAdvertiseUrl: () => "http://broker.test",
  retireScoutLocalAgentBinding: async () => false,
  sendScoutMessage: async (input: Record<string, unknown>) => {
    sendScoutMessageCalls.push(input);
    return stubs.sendScoutMessageResult;
  },
  sendScoutConversationMessage: async (input: Record<string, unknown>) => {
    sendScoutConversationMessageCalls.push(input);
    return stubs.sendScoutMessageResult;
  },
  sendScoutMessageReaction: async (input: Record<string, unknown>) => {
    sendScoutMessageReactionCalls.push(input);
    return { usedBroker: true, replayed: false };
  },
  listScoutMessageReactions: async () => [],
  sendScoutConversationSteer: async (input: Record<string, unknown>) => {
    sendScoutConversationSteerCalls.push(input);
    return stubs.sendScoutMessageResult;
  },
  sendScoutDirectMessage: async (input: Record<string, unknown>) => {
    sendScoutDirectMessageCalls.push(input);
    return stubs.sendScoutDirectMessageResult;
  },
  askScoutQuestion: async (input: Record<string, unknown>) => {
    askScoutQuestionCalls.push(input);
    return stubs.askScoutQuestionResult;
  },
  openScoutDirectSession: async (input: Record<string, unknown>) => {
    openScoutDirectSessionCalls.push(input);
    return {
      ...stubs.openScoutDirectSessionResult,
      input,
    };
  },
  openScoutPeerSession: async (input: Record<string, unknown>) => ({
    ...stubs.openScoutDirectSessionResult,
    sourceId: input.sourceId,
    targetId: input.targetId,
  }),
  upsertScoutConversation: async (input: Record<string, unknown>) => {
    upsertScoutConversationCalls.push(input);
  },
  upsertScoutCollaborationRecord: unstubbedBrokerCall("upsertScoutCollaborationRecord"),
  upsertScoutFlight: async () => null,
}));

mock.module("./core/observe/service.ts", () => ({
  loadAgentObservePayload: async () => {
    stubs.loadAgentObservePayloadCalls += 1;
    return stubs.agentObservePayloadResult;
  },
  loadAgentObserveSummaries: async () => [],
  loadSessionRefObservePayload: async () => stubs.sessionRefObservePayloadResult,
}));

// The server modules load behind the mocks above. This lives in an awaited
// loader rather than top-level awaits: Bun starts a test file's body before an
// imported module's top-level awaits settle, so each test file awaits
// `loadWebServerUnderTest()` itself before registering hooks.
type ServerModule = typeof import("./create-openscout-web-server.ts");
type VoiceSessionModule = typeof import("./scout-voice-session.ts");
type ChannelMemberSessionModule = typeof import("./core/conversations/channel-member-session.ts");
type SystemProbesModule = typeof import("@openscout/runtime/system-probes");
export let createOpenScoutWebServer: ServerModule["createOpenScoutWebServer"];
export let resetScoutVoiceSessionStateForTests: VoiceSessionModule["resetScoutVoiceSessionStateForTests"];
export let CHANNEL_MEMBER_COOKIE: ChannelMemberSessionModule["CHANNEL_MEMBER_COOKIE"];
export let channelMemberCookie: ChannelMemberSessionModule["channelMemberCookie"];
export let createChannelMemberSessionAuthority: ChannelMemberSessionModule["createChannelMemberSessionAuthority"];
export let gitBuildInfoProbe: SystemProbesModule["gitBuildInfoProbe"];
export let resetScoutdProbeClientForTests: SystemProbesModule["resetScoutdProbeClientForTests"];

let loaded: Promise<void> | null = null;
export function loadWebServerUnderTest(): Promise<void> {
  loaded ??= (async () => {
    ({ createOpenScoutWebServer } = await import("./create-openscout-web-server.ts"));
    ({ resetScoutVoiceSessionStateForTests } = await import("./scout-voice-session.ts"));
    ({ CHANNEL_MEMBER_COOKIE, channelMemberCookie, createChannelMemberSessionAuthority } =
      await import("./core/conversations/channel-member-session.ts"));
    ({ gitBuildInfoProbe, resetScoutdProbeClientForTests } = await import("@openscout/runtime/system-probes"));
    mock.restore();
  })();
  return loaded;
}

export function makeStaticRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openscout-web-static-"));
  testDirectories.add(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "index.html"),
    "<!doctype html><html><body>ok</body></html>",
    "utf8",
  );
  return root;
}

export function makePortalPeerMachine(overrides: Partial<MachineRecord> & { name: string }): MachineRecord {
  const now = Date.now();
  return {
    id: `mach-${overrides.name}`,
    displayName: null,
    platform: "macos",
    identityKeys: [],
    isSelf: false,
    hostNames: [],
    addresses: [],
    macAddresses: [],
    capabilities: [],
    routes: [],
    evidence: [],
    pinned: false,
    firstSeenAt: now - 86_400_000,
    lastSeenAt: now,
    ...overrides,
  };
}

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function cleanOptionalString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function splitDelimitedLine(line: string, delimiter: "|" | "\t", fieldCount: number): string[] {
  const parts = line.split(delimiter);
  if (parts.length <= fieldCount) return parts;
  return [...parts.slice(0, fieldCount - 1), parts.slice(fieldCount - 1).join(delimiter)];
}

export function makeDiscoverySnapshot(generatedAt: number): DiscoverySnapshot {
  return {
    generatedAt,
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
}

export async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export function parseSseEvents(body: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  for (const block of body.replace(/\r\n/g, "\n").split("\n\n")) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length === 0) continue;
    events.push({ event, data: JSON.parse(dataLines.join("\n")) as unknown });
  }
  return events;
}

export function useIsolatedOpenScoutHome(): string {
  const home = mkdtempSync(join(tmpdir(), "openscout-web-server-"));
  testDirectories.add(home);
  process.env.HOME = home;
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
  process.env.OPENSCOUT_CONTROL_HOME = join(home, ".openscout", "control-plane");
  process.env.OPENSCOUT_RELAY_HUB = join(home, ".openscout", "relay");
  process.env.OPENSCOUT_NODE_QUALIFIER = "test-node";
  // Route tests mock fetch for the provider ladder; the Pi brain has its own tests.
  process.env.OPENSCOUT_SCOUTBOT_BRAIN = "0";
  return home;
}

export async function waitForTestCondition(condition: () => boolean, timeoutMs = 250): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("condition was not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function makePairingState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "stopped",
    statusLabel: "Stopped",
    statusDetail: null,
    connectedPeerFingerprint: null,
    isRunning: false,
    commandLabel: "openscout-web pair",
    configPath: "/tmp/pairing/config.json",
    identityPath: "/tmp/pairing/identity.json",
    trustedPeersPath: "/tmp/pairing/trusted-peers.json",
    logPath: "/tmp/pairing/bridge.log",
    relay: null,
    configuredRelay: null,
    secure: true,
    lanDiscoveryAdvertised: false,
    workspaceRoot: null,
    sessionCount: 0,
    identityFingerprint: null,
    trustedPeerCount: 0,
    trustedPeers: [],
    pendingApprovals: [],
    pairing: null,
    logTail: "",
    logUpdatedAtLabel: null,
    logMissing: true,
    logTruncated: false,
    lastUpdatedLabel: null,
    ...overrides,
  };
}

export function makeBrokerDiagnostics(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generatedAt: Date.now(),
    windowMs: 86_400_000,
    ledger: {
      mode: "latest",
      limit: 160,
      cursor: null,
      cursors: {
        attempts: null,
        failedQueries: null,
        failedDeliveries: null,
        dialogue: null,
      },
      hasMore: {
        attempts: false,
        failedQueries: false,
        failedDeliveries: false,
        dialogue: false,
      },
    },
    totals: {
      successfulDispatches: 0,
      failedQueries: 0,
      failedDeliveries: 0,
      deliveryAttempts: 0,
      failedDeliveryAttempts: 0,
      dialogueMessages: 0,
    },
    rates: {
      messagesPerHour: 0,
      failedQueriesPerHour: 0,
      failedDeliveriesPerHour: 0,
      failureRate: 0,
    },
    attempts: [],
    failedQueries: [],
    failedDeliveries: [],
    dialogue: [],
    ...overrides,
  };
}

export function makeOfflineBrokerHealth(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    baseUrl: "http://broker.test",
    reachable: false,
    ok: false,
    nodeId: null,
    meshId: null,
    counts: null,
    error: "offline",
    ...overrides,
  };
}

export function makeObservedProjectionItem(index: number): ConversationProjectionItem {
  const sessionId = `observed-${index}`;
  const timestamp = 1_800_000_000_000 + index;
  return {
    feedId: `obs:codex:${sessionId}`,
    entityKind: "observed_session",
    kind: "observed_session",
    conversationId: null,
    runtimeSessionId: sessionId,
    source: "codex",
    sourceSessionId: sessionId,
    title: `Observed ${index}`,
    alias: null,
    naturalKey: null,
    projectRoot: "/tmp/project",
    harness: "codex",
    model: null,
    effort: null,
    agentId: null,
    agentName: null,
    currentBranch: null,
    authorityNodeId: null,
    authorityNodeName: null,
    parentConversationId: null,
    anchorMessageId: null,
    activityState: "working",
    lastMessageId: null,
    lastMessageAt: null,
    lastActivityAt: timestamp,
    messageCount: 0,
    unreadCount: 0,
    participantCount: 0,
    preview: null,
    lastEngagedAt: null,
    sourceFreshAt: timestamp,
    visibilityState: "visible",
    updatedSeq: index + 1,
    updatedAt: timestamp,
  };
}

export function makeScoutProjectionItem(
  conversationId: string,
  overrides: Partial<ConversationProjectionItem> = {},
): ConversationProjectionItem {
  const timestamp = 1_800_000_000_000;
  return {
    feedId: `conv:${conversationId}`,
    entityKind: "scout_conversation",
    kind: "direct",
    conversationId,
    runtimeSessionId: "session-projected",
    source: null,
    sourceSessionId: null,
    title: "Projected conversation",
    alias: null,
    naturalKey: null,
    projectRoot: "/tmp/project",
    harness: "codex",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    agentId: "agent-projected",
    agentName: "Projected Agent",
    currentBranch: "main",
    authorityNodeId: "node-1",
    authorityNodeName: "Local node",
    parentConversationId: null,
    anchorMessageId: null,
    activityState: "idle",
    lastMessageId: "msg-projected",
    lastMessageAt: timestamp,
    lastActivityAt: timestamp,
    messageCount: 1,
    unreadCount: 0,
    participantCount: 2,
    preview: "Served from the durable projection",
    lastEngagedAt: timestamp,
    sourceFreshAt: timestamp,
    visibilityState: "visible",
    updatedSeq: 1,
    updatedAt: timestamp,
    ...overrides,
  };
}

export function makeConversationProjectionSnapshot(
  items: ConversationProjectionItem[],
  total = items.length,
): ConversationProjectionSnapshot {
  return {
    projectionId: "projection-web-test",
    projectionVersion: 1,
    sequence: 7,
    generatedAt: 1_800_000_100_000,
    sourceFreshAt: items.at(-1)?.sourceFreshAt ?? null,
    items,
    total,
    hasMore: total > items.length,
    engagedFeedId: null,
    identityRedirects: [],
  };
}

export function makeCompatibilitySession(id: string): Record<string, unknown> {
  return {
    id,
    kind: "direct",
    title: "Compatibility Scout chat",
    participantIds: ["operator", "agent-1"],
    agentId: "agent-1",
    agentName: "Agent One",
    harness: "codex",
    harnessSessionId: "session-1",
    harnessLogPath: null,
    currentBranch: "main",
    preview: "Recovered from the compatibility view",
    messageCount: 3,
    lastMessageAt: 1_700_000_000,
    workspaceRoot: "/tmp/project",
  };
}

export function makeA2aBrokerContext(overrides: {
  agent?: Record<string, unknown>;
  endpoint?: Record<string, unknown>;
  snapshot?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  const agentId = "weather-a2a.local";
  const nodeId = "node-1";
  const agent = {
    id: agentId,
    kind: "agent",
    definitionId: agentId,
    displayName: "Weather A2A Agent",
    handle: "weather-a2a",
    labels: ["weather-a2a"],
    selector: "weather-a2a",
    agentClass: "general",
    capabilities: ["chat", "invoke"],
    wakePolicy: "on_demand",
    homeNodeId: nodeId,
    authorityNodeId: nodeId,
    advertiseScope: "local",
    ownerId: "operator",
    metadata: {
      brokerRegistered: true,
      project: "openscout-a2a-sidecar",
      role: "weather",
      branch: "main",
      createdAt: 1_700_000_000_000,
      a2aAgentCard: {
        provider: {
          organization: "OpenScout Protocol Lab",
          url: "https://openscout.local",
        },
        skills: [
          {
            id: "weatherTool",
            name: "weatherTool",
            description: "Get current weather for a location",
          },
        ],
      },
      supportedInterfaces: [
        {
          name: "A2A JSON-RPC",
          protocol: "a2a",
          url: "http://127.0.0.1:4111/api/a2a/weather-agent",
        },
      ],
    },
    ...(overrides.agent ?? {}),
  };
  const endpoint = {
    id: "endpoint.weather-a2a.local.a2a",
    agentId,
    nodeId,
    harness: "http",
    transport: "http",
    state: "active",
    address: "http://127.0.0.1:4111/api/a2a/weather-agent",
    projectRoot: "/tmp/openscout-a2a-sidecar",
    cwd: "/tmp/openscout-a2a-sidecar",
    metadata: {
      a2aContextId: "ctx-weather",
      a2aExecutionUrl: "http://127.0.0.1:4111/api/a2a/weather-agent",
      lastCompletedAt: 1_700_000_100_000,
    },
    ...(overrides.endpoint ?? {}),
  };
  return {
    baseUrl: "http://broker.test",
    node: {
      id: nodeId,
      meshId: "mesh-1",
      name: "Test node",
      advertiseScope: "local",
      registeredAt: 1_700_000_000_000,
    },
    snapshot: {
      nodes: {
        [nodeId]: {
          id: nodeId,
          meshId: "mesh-1",
          name: "Test node",
          advertiseScope: "local",
          registeredAt: 1_700_000_000_000,
        },
      },
      actors: {
        operator: {
          id: "operator",
          kind: "operator",
          displayName: "Operator",
          handle: "art",
        },
      },
      agents: {
        [agentId]: agent,
      },
      endpoints: {
        [String(endpoint.id)]: endpoint,
      },
      flights: {},
      ...(overrides.snapshot ?? {}),
    },
  };
}

export function sessionSnapshotWithAttention(): {
  snapshot: SessionState;
  approval: Record<string, unknown>;
} {
  const sessionId = "pairing-session-1";
  const turnId = "turn-1";
  const approvalBlockId = "cmd-approval";
  const questionBlock: QuestionBlock = {
    id: "question-1",
    turnId,
    type: "question",
    status: "streaming",
    index: 0,
    header: "Deploy",
    question: "Ship the fix?",
    options: [{ label: "Yes" }, { label: "No" }],
    multiSelect: false,
    questionStatus: "awaiting_answer",
  };
  const approvalBlock: ActionBlock = {
    id: approvalBlockId,
    turnId,
    type: "action",
    status: "streaming",
    index: 1,
    action: {
      kind: "command",
      status: "awaiting_approval",
      output: "",
      command: "bun test",
      approval: {
        version: 3,
        description: "Run focused tests",
        risk: "high",
      },
    },
  };
  const failedBlock: ActionBlock = {
    id: "tool-failed",
    turnId,
    type: "action",
    status: "failed",
    index: 2,
    action: {
      kind: "tool_call",
      status: "failed",
      output: "Native tool failed",
      toolName: "apply_patch",
      toolCallId: "tool-call-1",
    },
  };
  const blocks: BlockState[] = [
    { block: questionBlock, status: "streaming" },
    { block: approvalBlock, status: "streaming" },
    { block: failedBlock, status: "completed" },
  ];
  return {
    snapshot: {
      session: {
        id: sessionId,
        name: "Codex Pairing",
        adapterType: "codex",
        status: "active",
        cwd: "/tmp/project",
      },
      turns: [
        {
          id: turnId,
          status: "streaming",
          startedAt: 1_700_000_000_000,
          blocks,
        },
      ],
      currentTurnId: turnId,
    },
    approval: {
      sessionId,
      sessionName: "Codex Pairing",
      adapterType: "codex",
      turnId,
      blockId: approvalBlockId,
      version: 3,
      risk: "high",
      title: "Approve Command",
      description: "Run focused tests",
      detail: "bun test",
      actionKind: "command",
      actionStatus: "awaiting_approval",
    },
  };
}
/** Each test file calls this once: resets stub state around every test and cleans up the isolated home. */
export function installWebServerTestHooks(): void {
  afterAll(() => {
    mock.restore();
    rmSync(isolatedTestHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const key of Object.keys(chatReadCursors)) delete chatReadCursors[key];
    chatMarkReadCalls.length = 0;
    globalThis.fetch = originalFetch;
    process.env.HOME = originalHome;
    // Route fixtures bootstrap their own runner, not the managed process of the launching service.
    delete process.env.OPENSCOUT_SCOUTBOT_PROCESS;
    if (originalOpenScoutHome === undefined) {
      delete process.env.OPENSCOUT_HOME;
    } else {
      process.env.OPENSCOUT_HOME = originalOpenScoutHome;
    }
    if (originalSupportDirectory === undefined) {
      delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
    } else {
      process.env.OPENSCOUT_SUPPORT_DIRECTORY = originalSupportDirectory;
    }
    if (originalControlHome === undefined) {
      delete process.env.OPENSCOUT_CONTROL_HOME;
    } else {
      process.env.OPENSCOUT_CONTROL_HOME = originalControlHome;
    }
    if (originalRelayHub === undefined) {
      delete process.env.OPENSCOUT_RELAY_HUB;
    } else {
      process.env.OPENSCOUT_RELAY_HUB = originalRelayHub;
    }
    if (originalNodeQualifier === undefined) {
      delete process.env.OPENSCOUT_NODE_QUALIFIER;
    } else {
      process.env.OPENSCOUT_NODE_QUALIFIER = originalNodeQualifier;
    }
    if (originalOperatorName === undefined) {
      delete process.env.OPENSCOUT_OPERATOR_NAME;
    } else {
      process.env.OPENSCOUT_OPERATOR_NAME = originalOperatorName;
    }
    if (originalOpenAIKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAIKey;
    }
    if (originalOpenAIModel === undefined) {
      delete process.env.OPENAI_MODEL;
    } else {
      process.env.OPENAI_MODEL = originalOpenAIModel;
    }
    if (originalScoutbotAssistantModel === undefined) {
      delete process.env.OPENSCOUT_SCOUTBOT_ASSISTANT_MODEL;
    } else {
      process.env.OPENSCOUT_SCOUTBOT_ASSISTANT_MODEL = originalScoutbotAssistantModel;
    }
    process.env.OPENSCOUT_PROBES_SOCKET = join(
      tmpdir(),
      `openscout-web-test-missing-probes-${process.pid}.sock`,
    );
    resetScoutdProbeClientForTests();
    stubs.querySessionByIdImpl = () => null;
    stubs.queryConversationDefinitionByIdImpl = () => null;
    stubs.scoutBrokerContextResult = null;
    stubs.conversationsScopeBrokerContextResult = undefined;
    stubs.permissionDecisions = [];
    stubs.permissionDecisionFailure = false;
    stubs.permissionDecisionUnconfirmed = false;
    stubs.loadScoutBrokerContextGate = null;
    stubs.loadScoutBrokerContextCalls = 0;
    loadScoutBrokerContextOptions.length = 0;
    queryRecentMessagesCalls.length = 0;
    stubs.queryRecentMessagesResult = [];
    stubs.scoutBrokerMessagesResult = null;
    stubs.scoutBrokerHomeResult = null;
    stubs.scoutBrokerSnapshotResult = null;
    stubs.scoutBrokerSnapshotReader = null;
    stubs.scoutConversationProjectionResult = null;
    stubs.scoutBrokerHealthResult = makeOfflineBrokerHealth();
    stubs.agentObservePayloadResult = null;
    stubs.loadAgentObservePayloadCalls = 0;
    stubs.sessionRefObservePayloadResult = null;
    stubs.sendScoutMessageResult = {
      usedBroker: true,
      invokedTargets: [],
      unresolvedTargets: [],
    };
    stubs.openScoutDirectSessionResult = {
      agent: { id: "agent-1" },
      conversation: {
        id: "c.agent-1",
        kind: "direct",
        title: "Agent One",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["agent-1", "operator"],
        metadata: { naturalKey: "direct:agent-1,operator" },
      },
      existed: true,
    };
    stubs.sendScoutDirectMessageResult = {
      conversationId: "c.agent-1",
      messageId: "msg-1",
      flight: {
        id: "flt-1",
        invocationId: "inv-1",
        targetAgentId: "agent-1",
        state: "queued",
      },
    };
    stubs.askScoutQuestionResult = {
      usedBroker: true,
      conversationId: "c.agent-1",
      messageId: "msg-ask-1",
      flight: {
        id: "flt-ask-1",
        invocationId: "inv-ask-1",
        targetAgentId: "agent-1",
        state: "queued",
      },
    };
    stubs.scoutRelayConfigResult = {};
    stubs.brokerDiagnosticsResult = makeBrokerDiagnostics();
    stubs.queryFleetResult = null;
    stubs.queryAgentsResult = [];
    stubs.querySessionsResult = [];
    stubs.querySessionsCalls = 0;
    queryAgentsLimits.length = 0;
    stubs.queryTerminalSessionsResult = [];
    stubs.queryDiscoveredTerminalSessionsResult = [];
    stubs.pairingStateResult = makePairingState();
    stubs.getPairingStateCalls = 0;
    stubs.refreshPairingStateCalls = 0;
    stubs.pairingSessionSnapshotsResult = [];
    sendScoutMessageCalls.length = 0;
    sendScoutConversationMessageCalls.length = 0;
    sendScoutMessageReactionCalls.length = 0;
    sendScoutConversationSteerCalls.length = 0;
    sendScoutDirectMessageCalls.length = 0;
    askScoutQuestionCalls.length = 0;
    openScoutDirectSessionCalls.length = 0;
    upsertScoutConversationCalls.length = 0;
    queryRunsCalls.length = 0;
    stubs.queryRunsResult = [];
    stubs.queryFlightsResult = [];
    stubs.queryFlightRecordByIdResult = null;
    stubs.queryInvocationsResult = [];
    stubs.queryFlightRecordsResult = [];
    decidePairingApprovalCalls.length = 0;
    interruptPairingCalls.length = 0; stubs.interruptPairingFailure = false;
    stubs.questionHistoryRecords = []; stubs.questionHistoryFailure = false; questionHistoryCalls.length = 0;
    stubs.decidePairingApprovalFailure = false;
    lanBeaconSuppressPredicates.length = 0;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalScoutbotProcess === undefined) delete process.env.OPENSCOUT_SCOUTBOT_PROCESS;
    else process.env.OPENSCOUT_SCOUTBOT_PROCESS = originalScoutbotProcess;
    if (originalOpenScoutHome === undefined) {
      delete process.env.OPENSCOUT_HOME;
    } else {
      process.env.OPENSCOUT_HOME = originalOpenScoutHome;
    }
    if (originalSupportDirectory === undefined) {
      delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
    } else {
      process.env.OPENSCOUT_SUPPORT_DIRECTORY = originalSupportDirectory;
    }
    if (originalControlHome === undefined) {
      delete process.env.OPENSCOUT_CONTROL_HOME;
    } else {
      process.env.OPENSCOUT_CONTROL_HOME = originalControlHome;
    }
    if (originalRelayHub === undefined) {
      delete process.env.OPENSCOUT_RELAY_HUB;
    } else {
      process.env.OPENSCOUT_RELAY_HUB = originalRelayHub;
    }
    if (originalNodeQualifier === undefined) {
      delete process.env.OPENSCOUT_NODE_QUALIFIER;
    } else {
      process.env.OPENSCOUT_NODE_QUALIFIER = originalNodeQualifier;
    }
    if (originalOperatorName === undefined) {
      delete process.env.OPENSCOUT_OPERATOR_NAME;
    } else {
      process.env.OPENSCOUT_OPERATOR_NAME = originalOperatorName;
    }
    if (originalOpenAIKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAIKey;
    }
    if (originalOpenAIModel === undefined) {
      delete process.env.OPENAI_MODEL;
    } else {
      process.env.OPENAI_MODEL = originalOpenAIModel;
    }
    if (originalScoutbotAssistantModel === undefined) {
      delete process.env.OPENSCOUT_SCOUTBOT_ASSISTANT_MODEL;
    } else {
      process.env.OPENSCOUT_SCOUTBOT_ASSISTANT_MODEL = originalScoutbotAssistantModel;
    }
    if (originalProbesSocket === undefined) {
      delete process.env.OPENSCOUT_PROBES_SOCKET;
    } else {
      process.env.OPENSCOUT_PROBES_SOCKET = originalProbesSocket;
    }
    resetScoutdProbeClientForTests();

    resetScoutVoiceSessionStateForTests();

    for (const directory of testDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
    testDirectories.clear();
  });
}
