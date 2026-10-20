// Must stay the first import: materializes OPENSCOUT_INSTANCE before any module reads paths/ports.
import { openScoutCheckoutInstanceDefault, openScoutInstanceBootstrap } from "./instance-checkout-bootstrap.js";
import { flightCompletion, SCOUT_COMPLETION_CAPABILITY } from "@openscout/protocol";
import { SCOUT_SESSION_INPUT_RECEIPTS_CAPABILITY } from "@openscout/protocol";
import { deliverInPlace } from "./in-place/deliver.js";
import { isolatedCodexPermissionMetadata } from "./permission-policy.js";
import { BrokerPermissionService } from "./broker-permission-service.js";
import { configureManagedPermissionHandler } from "./managed-permission.js";
import { requireProtectedAccessState, protectAccessDirectories, removeLocalAdminEnvironment } from "./mesh-access-startup.js";
import { inspectMeshAccessIngressPosture } from "./mesh-access-ingress-posture.js";
import { BrokerMcpEvents } from "./broker-mcp-events.js";
import { readLocalAdminKey, preserveProtectedIngress } from "./mesh-access-local-auth.js";
import { MeshAccessStore } from "./mesh-access-store.js";
import { IntegrationSlackEvents } from "./integration-slack-events.js";
import { IntegrationSlackDeliveryService } from "./integration-slack-delivery.js";
import { SlackWorkerSupervisor } from "./slack-worker-supervisor.js";
import { verifySlackWorkerCredentials } from "./slack-worker-process.js";
import { BrokerIntegrationSetupService } from "./broker-integration-setup.js";
import { GuestGrantStore } from "./guest-access.js";
import { BrokerExternalSessionService } from "./broker-external-session-service.js";
import { BrokerT3Service } from "./t3/broker-service.js";
import { externalSessionConnections, devinSessionTransport } from "./external-session-transport.js";
import { BrokerMessageHistory } from "./broker-message-history.js";
import { startBrokerOtlpReceiver } from "./otlp/broker-lifecycle.js";
import { memoryMaintenanceFromEnv } from "./broker-memory-maintenance.js";
import { scoutbotIsolationMetadata } from "./scoutbot-isolation.js";
import { randomUUID } from "node:crypto";
import { BrokerCommandAdmission, BrokerStorageMonitor } from "./broker-storage-pressure.js";
import { BrokerStorageMaintenance } from "./broker-storage-maintenance.js";
import { ControlPlaneHistoryReader, historicalRecordKey } from "./control-plane-history-store.js";
import { constrainHistoryRotationBatch, selectHistoryRotationBatch } from "./history-rotation-batch.js";
import { publishHistoryRotationPages } from "./history-rotation-publication.js";
import { revalidateHistoryRotation } from "./history-rotation-revalidation.js";
import { createServer, type IncomingMessage } from "node:http";
import { statSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Duplex } from "node:stream";

import { applyWSSHandler } from "@trpc/server/adapters/ws";

import type { RuntimeHttpRequestLike, RuntimeHttpResponseLike } from "./portable-types.js";

import { brokerRouter } from "./broker-trpc-router.js";

import {
  type ActorIdentity,
  type AgentEndpoint,
  type AgentHarness,
  type ControlCommand,
  type ConversationDefinition,
  type DeliveryIntent,
  type FlightRecord,
  type InvocationRequest,
  type MessageRecord,
  type NodeDefinition,
  type ScoutDispatchEnvelope,
  type ScoutDispatchRecord,
  AGENT_HARNESSES,
  scoutSessionHostForNode,
  mintChannelId,
  OPENSCOUT_COORDINATOR_AGENT_ID,
  SCOUT_DISPATCHER_AGENT_ID,
} from "@openscout/protocol";

import { createInMemoryControlRuntime } from "./broker.js";
import {
  publishControlEvent,
  publishEphemeralControlEvent,
  replaceControlEventBacklog,
  setPresenceSnapshotSource,
  snapshotPresenceControlEvents,
} from "./broker-control-events.js";
import { BrokerPresenceService } from "./broker-presence-service.js";
import { BrokerDeliveryStore } from "./broker-delivery-store.js";
import { FileBackedBrokerJournal, type BrokerJournalEntry } from "./broker-journal.js";
import { BrokerDurableRecordStore } from "./broker-durable-record-store.js";
import { BrokerDurableStore } from "./broker-durable-store.js";
import { BrokerStartupTrafficGate } from "./broker-startup-traffic-gate.js";
import { BrokerReadCursorStore } from "./broker-read-cursor-store.js";
import { BrokerWorkItemStore } from "./broker-work-item-store.js";
import { BrokerDeliveryRouter, type ExactSessionWakeInput } from "./broker-delivery-routing.js";
import { BrokerDeliveryAcceptanceService } from "./broker-delivery-acceptance-service.js";
import { BrokerDeliveryHttpService } from "./broker-delivery-http-service.js";
import { BrokerDurableActionHttpService } from "./broker-durable-action-http-service.js";
import { BrokerFlightLifecycleService } from "./broker-flight-lifecycle-service.js";
import { bootstrapSecretRedaction } from "./secret-redaction-bootstrap.js";
import { applyRoleLifecycleForTerminalFlight } from "./role-lifecycle.js";
import { BrokerRepoTailService } from "./broker-repo-tail-service.js";
import { BrokerRendezvousService } from "./broker-rendezvous-service.js";
import { BrokerOperatorAttentionService } from "./broker-operator-attention-service.js";
import { BrokerLocalAgentSyncService } from "./broker-local-agent-sync-service.js";
import { createRelayAgentRegistrySignatureReader } from "./relay-agent-registry-signature.js";
import {
  DEFAULT_CARDLESS_SESSION_IDLE_TTL_MS,
  idleCardlessSessionExpiryCandidates,
} from "./broker-cardless-session-reaper.js";
import {
  applyRegistryRetentionPlan,
  createRegistryRetentionEvaluator,
  registryRetentionPlan,
} from "./broker-registry-retention.js";
import {
  resolveArchiveWeeks,
  resolveRetentionWeeks,
  retentionCutoff,
} from "./retention-clock.js";
import { planHistoryRotation, refineVerifiedRotation } from "./history-rotation.js";
import {
  resolveAgentLabel,
  type BrokerRouteTargetInput,
} from "./scout-dispatcher.js";
import { assertNoReservedStoredAgentNames } from "./reserved-agent-audit.js";
import { buildCollaborationInvocation } from "./collaboration-invocations.js";
import { resolveOperatorName } from "./user-config.js";
import {
  resolveIrohMeshEntrypointFromEnv,
  startIrohBridgeServeFromEnv,
  type IrohBridgeService,
} from "./iroh-bridge.js";
import { createPeerDeliveryWorker, type PeerDeliveryWorker } from "./peer-delivery.js";
import {
  areHarnessBinariesAvailable,
  ensureLocalSessionEndpointOnline,
  ensureLocalAgentBindingOnline,
  isLocalAgentEndpointAlive,
  isLocalAgentEndpointAliveAsync,
  isLocalAgentSessionAlive,
  isLocalAgentSessionAliveAsync,
  invokeLocalAgentEndpoint,
  listRelayAgentTmuxSessionOwners,
  listScoutLaunchedTmuxSessions,
  observeLocalAgentEndpointSession,
  loadRegisteredLocalAgentBindings,
  shutdownLocalSessionEndpoint,
  shouldDisableGeneratedCodexEndpoint,
  sleepLocalAgentSession,
} from "./local-agents.js";
import {
  DEFAULT_RELAY_AGENT_SESSION_IDLE_TTL_MS,
  RelayAgentSessionReaper,
} from "./broker-relay-agent-reaper.js";
import { reconcileRelayAgentProcessLeases } from "./relay-agent-process-leases.js";
import { touchBrokerRuntimeHeartbeat } from "./relay-agent-watchdog.js";
import { tmuxSessionsProbe } from "./system-probes/index.js";
import {
  ensurePairingSessionForCodexThread,
  findPairingSession,
  getPairingSessionSnapshot,
  invokePairingSessionEndpoint,
  listPairingSessions,
  listPairingSessionSnapshots,
  decidePairingApproval,
} from "./pairing-session-agents.js";
import {
  createMeshApprovalShare,
  createMeshApprovalWatch,
  meshApprovalsConfigPath,
  readMeshApprovalsConfig,
} from "./mesh-approvals.js";
import { normalizeCodexAppServerLaunchArgs } from "./codex-app-server.js";
import { WorkerSQLiteProjection } from "./sqlite-projection-worker.js";
import {
  ObservedSessionReducer,
  subscribeObservedSessionReducer,
} from "./observed-session-reducer.js";
import { replacePersistedActiveObservedSessionSeeds } from "./tail/service.js";
import { ThreadEventPlane } from "./thread-events.js";
import { invokeA2AHttpEndpoint } from "./a2a-http-endpoint.js";
import { ensureOpenScoutCleanSlateSync, resolveOpenScoutSupportPaths, controlPlaneArchiveDirectory } from "./support-paths.js";
import { expandHomePath } from "./tool-resolution.js";
import {
  requestScoutBrokerJson,
  registerActiveScoutBrokerService,
  unregisterActiveScoutBrokerService,
} from "./broker-api.js";
import { createBrokerCoreService } from "./broker-core-service.js";
import {
  buildLocalBrokerControlUrl,
  DEFAULT_BROKER_PORT,
  isLoopbackHost,
  resolveBrokerServiceConfig,
  resolveAdvertiseScope,
  resolveBrokerHost,
  resolveBrokerUrl,
} from "./broker-process-manager.js";
import {
  readMobilePairingMeshEntrypoint,
  resolveMeshRendezvousPublishConfig,
  startMeshRendezvousPublisher,
  type MeshRendezvousPublisher,
} from "./mesh-rendezvous.js";
import { clearGitBranchCache, readRelayAgentOverrides, writeRelayAgentOverrides } from "./setup.js";
import { broadcastApnsAlertToActiveMobileDevices } from "./mobile-push.js";
import {
  getHarnessTopologySnapshot,
  nudgeHarnessTopologyScan,
} from "./harness-topology/index.js";
import {
  getTailDiscovery,
  readRecentLiveEvents,
  readRecentTranscriptEvents,
} from "./tail/index.js";
import {
  getRepoWatchSnapshot,
  repoWatchHintsFromBrokerSnapshot,
  repoWatchHintsFromTailDiscovery,
} from "./repo-watch/index.js";
import { readTailscaleSelfWebHostsSync } from "./tailscale.js";
import {
  resolveConfiguredScoutWebHostname,
  resolveScoutWebNamedHostname,
} from "./local-config.js";
import { BrokerWebControlService } from "./broker-web-control-service.js";
import { BrokerScoutbotService, SCOUTBOT_PROCESS_ENV } from "./broker-scoutbot-service.js";
import { BrokerJetStreamService, resolveJetStreamConfig } from "./jetstream/index.js";
import { BrokerA2AService } from "./broker-a2a-service.js";
import { BrokerCapabilityMatrixService } from "./broker-capability-matrix-service.js";
import {
  BrokerRuntimeCatalogService,
  resolveRuntimeCatalogRefreshMs,
} from "./broker-runtime-catalog-service.js";
import { isGeneratedLocalAgentMetadata } from "./broker-managed-session-helpers.js";
import { BrokerManagedSessionService } from "./broker-managed-session-service.js";
import { BrokerManagedSessionHttpService } from "./broker-managed-session-http-service.js";
import { BrokerLocalEndpointResolver } from "./broker-local-endpoint-resolver.js";
import { BrokerLocalInvocationService } from "./broker-local-invocation-service.js";
import { BrokerTerminalReportDeliveryService, prepareTerminalReport, matchesPendingTerminalReport } from "./broker-terminal-report-delivery-service.js";
import { BrokerInvocationResultDeliveryService, matchesPendingInvocationResultReply } from "./broker-invocation-result-delivery-service.js";
import {
  buildCardlessSessionEndpoint,
  cardlessSessionDisplayName,
  registerCardlessSession,
  resolveCardlessSessionSpawnTarget,
} from "./broker-cardless-session.js";
import {
  collectOccupiedDefinitionIdsFromBrokerSnapshot,
  resolveProjectProvisionalAgentName,
} from "./provisional-agent-names.js";
import { locateHarnessSession } from "./session-locator.js";
import { findHarnessEntry } from "./harness-catalog.js";
import { BrokerControlStreamService } from "./broker-control-stream-service.js";
import { json } from "./broker-http-helpers.js";
import { createBrokerHttpRouter } from "./broker-http-router.js";
import { BrokerRequestReceipts, RetryablePreEffectFailure } from "./broker-request-receipts.js";
import { BrokerMachineService } from "./broker-machine-service.js";
import {
  closeServer,
  isAddressInUse,
  listenTcp,
  listenUnixSocket,
} from "./broker-server-lifecycle.js";
import { BrokerMeshBundleService } from "./broker-mesh-bundle-service.js";
import {
  BrokerMeshForwardingService,
  isReachableMeshNode,
  postMeshPeerJson,
} from "./broker-mesh-forwarding-service.js";
import {
  resolveMeshHost,
  suggestHostForProjectPath,
  startSessionOnPeers,
  wakeLocalHarnessSession,
  wakeSessionOnPeers,
  type LocalSessionWakeResult,
  type MeshProjectSessionStartInput,
} from "./broker-session-wake.js";
import { BrokerMeshDiscoveryService } from "./broker-mesh-discovery-service.js";
import { BrokerMeshHttpService } from "./broker-mesh-http-service.js";
import { fetchPeerAgents } from "./mesh-forwarding.js";
import { BrokerConversationService } from "./broker-conversation-service.js";
import { BrokerMessageService } from "./broker-message-service.js";
import { BrokerReplyCompletionRecovery } from "./broker-reply-completion-recovery.js";
import { BrokerInvocationDispatchService } from "./broker-invocation-dispatch-service.js";
import { BrokerCommandService } from "./broker-command-service.js";
import { BrokerChannelInviteService } from "./broker-channel-invite-service.js";
import { BrokerDispatchRecoveryService } from "./broker-dispatch-recovery-service.js";
import {
  brokerActorDisplayName as resolveBrokerActorDisplayName,
  brokerRouteKind,
  brokerTargetLabel,
  brokerTargetProjectRoot,
  buildBrokerReturnAddressForActor,
  isLocalScoutProductTarget,
  isOperatorDeliveryTarget,
  isFinalReplyForInvocation,
  messageRefCandidateForRouteTarget,
  messageVisibilityForConversation,
  metadataStringValue,
  resolveBrokerMessageRefAsync,
  scoutbotReplyProvenanceMetadata,
  titleCaseName,
} from "./broker-conversation-helpers.js";
import {
  applyInvocationStatusPatch,
  isReconciledStaleFlightActivityItem,
  isTerminalFlightState,
  isWorkingFlightState,
  staleLocalEndpointReason,
  type InvocationStatusPatch,
} from "./broker-local-invocation-helpers.js";
import {
  homeEndpointForAgent,
  isInactiveLocalAgent,
} from "./broker-endpoint-selection.js";
import { readMeshNodeState } from "./mesh-node-state.js";
import { BrokerHomeService } from "./broker-home-service.js";
import { isDirectLocalAgentTransport } from "./local-agent-transports.js";
import { BrokerUnavailableTargetService, localEndpointCanReceive, localEndpointSupportsQueue } from "./broker-unavailable-target-service.js";
import { BrokerRouteAliasStore } from "./broker-route-alias-store.js";
import { BrokerRouteAliasError, BrokerRouteAliasService } from "./broker-route-alias-service.js";
import { LazyControlPlaneStore } from "./lazy-control-plane-store.js";
import {
  buildSignedNodeCard,
  loadOrCreateNodeIdentity,
  nodeFingerprint,
  nodeKeyId,
  resolveStableLocalNodeId,
} from "./node-identity.js";
import {
  createMeshBindController,
  readPersistedAdvertiseScope,
  type MeshBindController,
  type MeshBindState,
} from "./mesh-bind-controller.js";
import {
  PEER_AUTH_MAX_SKEW_MS,
  PeerNonceCache,
} from "./mesh-peer-auth.js";
import { createMeshPeerFetch, trustedMeshPeerForBrokerUrl } from "./mesh-peer-client.js";
import {
  TrustEndpointRateLimiter,
  TrustEnrollmentService,
} from "./mesh-trust-enrollment.js";
import {
  createMeshIngressGate,
  resolveMeshGateMode,
} from "./mesh-ingress-gate.js";
import { SQLiteControlPlaneStore } from "./sqlite-store.js";
import { loadOpenScoutRuntimeBuildIdentity } from "./build-info.js";
import {
  describeOpenScoutInstance,
  enforceOpenScoutInstanceIsolation,
  openScoutInstanceMeshRefusal,
} from "./instance.js";

const PROCESS_NAME = "scout-broker";

process.title = PROCESS_NAME;

function createRuntimeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveControlPlaneHome(): string {
  // Instance-aware: an unset OPENSCOUT_CONTROL_HOME resolves to the current
  // OPENSCOUT_INSTANCE's control plane, never a hard-coded prod path.
  return resolveOpenScoutSupportPaths().controlHome;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

const controlHome = resolveControlPlaneHome();
const dbPath = join(controlHome, "control-plane.sqlite");
const journalPath = join(controlHome, "broker-journal.jsonl");
const historyDirectory = join(controlHome, "history");
const historicalReader = new ControlPlaneHistoryReader(historyDirectory);
const storageMonitor = new BrokerStorageMonitor(controlHome, {
  journal: { path: journalPath, warningBytes: 64 * 1024 * 1024 },
  database: { path: dbPath, warningBytes: 512 * 1024 * 1024 },
  databaseWal: { path: `${dbPath}-wal`, warningBytes: 128 * 1024 * 1024 },
  historicalIndex: { path: join(historyDirectory, "catalog.sqlite"), warningBytes: 256 * 1024 * 1024 },
  quarantine: { path: `${journalPath}.quarantine.sqlite`, warningBytes: 64 * 1024 * 1024 },
  quarantineWal: { path: `${journalPath}.quarantine.sqlite-wal`, warningBytes: 64 * 1024 * 1024 },
});
const commandAdmission = new BrokerCommandAdmission({ pressure: () => storageMonitor.admissionPressure() });
const port = Number.parseInt(
  process.env.OPENSCOUT_BROKER_PORT?.trim() || String(openScoutInstanceBootstrap.layout.ports.broker),
  10,
);
const supportDirectory = resolveOpenScoutSupportPaths().supportDirectory;
// §11.5: persisted bind posture wins over env so reboot restores announce.
const bootAdvertiseScope = resolveAdvertiseScope(
  process.env,
  () => readPersistedAdvertiseScope(supportDirectory),
);
// §11.3: plaintext always on loopback; non-loopback TLS is owned by the bind controller.
const host = resolveBrokerHost(bootAdvertiseScope);
let advertiseScope = bootAdvertiseScope;
let brokerUrl = resolveBrokerUrl(host, port, advertiseScope);
const brokerControlUrl = buildLocalBrokerControlUrl(host, port);
const meshId = process.env.OPENSCOUT_MESH_ID ?? "openscout";
const nodeName = process.env.OPENSCOUT_NODE_NAME ?? hostname();
const tailnetName = process.env.TAILSCALE_TAILNET ?? undefined;
const brokerSocketPath = process.env.OPENSCOUT_BROKER_SOCKET_PATH
  ?? resolveBrokerServiceConfig().brokerSocketPath;
let nodeId = process.env.OPENSCOUT_NODE_ID?.trim() ?? "";
const tailnetWebHosts = readTailscaleSelfWebHostsSync();
// The named web doorway this node answers for — same resolution the local edge
// and the web server use for `advertisedHost`. Peers read it to open this
// node's Scout by name (the local edge proxies `<webHost>` to a live route).
const localWebHost = process.env.OPENSCOUT_WEB_ADVERTISED_HOST?.trim()
  || (process.env.OPENSCOUT_WEB_LOCAL_NAME?.trim()
    ? resolveScoutWebNamedHostname(process.env.OPENSCOUT_WEB_LOCAL_NAME)
    : resolveConfiguredScoutWebHostname());
const nodeLocalProductAgentIds = new Set([
  SCOUT_DISPATCHER_AGENT_ID,
  OPENSCOUT_COORDINATOR_AGENT_ID,
  "scoutbot",
]);
const seedUrls = (process.env.OPENSCOUT_MESH_SEEDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const webStartTrustedHosts = new Set(
  [
    ...(process.env.OPENSCOUT_WEB_TRUSTED_HOSTS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    ...tailnetWebHosts,
  ].map((value) => value.replace(/\.$/, "").toLowerCase()),
);
const configuredCoreAgentIds = (process.env.OPENSCOUT_CORE_AGENTS ?? "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const discoveryIntervalMs = Number.parseInt(process.env.OPENSCOUT_MESH_DISCOVERY_INTERVAL_MS ?? "60000", 10);
const parentPid = Number.parseInt(process.env.OPENSCOUT_PARENT_PID ?? "0", 10);
const localAgentSyncIntervalMs = Number.parseInt(process.env.OPENSCOUT_LOCAL_AGENT_SYNC_INTERVAL_MS ?? "30000", 10);
const cardlessSessionSweepIntervalMs = Number.parseInt(
  process.env.OPENSCOUT_CARDLESS_SESSION_SWEEP_INTERVAL_MS ?? "300000",
  10,
);
const cardlessSessionIdleTtlMs = Number.parseInt(
  process.env.OPENSCOUT_CARDLESS_SESSION_IDLE_TTL_MS ?? String(DEFAULT_CARDLESS_SESSION_IDLE_TTL_MS),
  10,
);
const relayAgentSweepIntervalMs = Number.parseInt(
  process.env.OPENSCOUT_RELAY_AGENT_SWEEP_INTERVAL_MS ?? "300000",
  10,
);
const relayAgentIdleTtlMs = Number.parseInt(
  process.env.OPENSCOUT_RELAY_AGENT_IDLE_TTL_MS ?? String(DEFAULT_RELAY_AGENT_SESSION_IDLE_TTL_MS),
  10,
);
// Registry retention reaps rotation-old unreferenced registrations. The week
// clock (OPENSCOUT_RETENTION_WEEKS, default 2 live calendar weeks) is the one
// clock; OPENSCOUT_REGISTRY_RETENTION_MS remains only as an explicit rolling
// override — 0 disables the sweep entirely, any positive value is clamped to
// a one-hour floor.
const retentionWeeks = resolveRetentionWeeks(process.env);
const archiveWeeks = resolveArchiveWeeks(process.env);
const registryRetentionOverrideMs = (() => {
  const raw = process.env.OPENSCOUT_REGISTRY_RETENTION_MS;
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (parsed === 0) return 0;
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.max(60 * 60_000, parsed);
})();
if (registryRetentionOverrideMs !== undefined) {
  console.log(`[openscout-runtime] OPENSCOUT_REGISTRY_RETENTION_MS=${registryRetentionOverrideMs} overrides the week-based retention clock (OPENSCOUT_RETENTION_WEEKS=${retentionWeeks})`);
}
const runtimeHeartbeatIntervalMs = 30_000;
const repoWatchServeCacheTtlMs = Number.parseInt(process.env.OPENSCOUT_REPO_WATCH_CACHE_TTL_MS ?? "1200000", 10);
const tailRecentServeCacheTtlMs = Number.parseInt(process.env.OPENSCOUT_TAIL_RECENT_SERVE_CACHE_TTL_MS ?? "4000", 10);
const repoWatchRehydrateAfterMs = Number.parseInt(process.env.OPENSCOUT_REPO_WATCH_REHYDRATE_AFTER_MS ?? "30000", 10);
const startupBoundaryTestDelayMs = Number.parseInt(
  process.env.OPENSCOUT_TEST_STARTUP_BOUNDARY_DELAY_MS ?? "0",
  10,
);
// Mesh trust cone rollout (docs/proposals/mesh-trust-cone.md §10): the ingress
// gate verifies everything but only warns until OPENSCOUT_MESH_GATE=enforce.
const meshGateMode = resolveMeshGateMode(process.env);
// Instance isolation (OPENSCOUT_INSTANCE): a non-prod instance must never bind
// prod's ports or write prod's directories. Checked before any state is touched.
enforceOpenScoutInstanceIsolation("the broker", {
  extraPorts: [{ label: "broker port", port }],
  extraPaths: [
    { label: "control home", value: controlHome },
    { label: "support directory", value: supportDirectory },
    { label: "broker socket", value: brokerSocketPath },
  ],
});
console.log(
  `[openscout-runtime] instance ${describeOpenScoutInstance(openScoutInstanceBootstrap.layout)}`
    + (openScoutCheckoutInstanceDefault ? " (source-checkout default; set OPENSCOUT_INSTANCE=prod to override)" : ""),
);
const meshInstanceRefusal = openScoutInstanceMeshRefusal();
if (meshInstanceRefusal) {
  console.log(`[openscout-runtime] mesh off: ${meshInstanceRefusal}`);
}
const localAdminKey = readLocalAdminKey(process.env.OPENSCOUT_LOCAL_ADMIN_KEY_FILE);
removeLocalAdminEnvironment(process.env);
requireProtectedAccessState(dbPath, Boolean(localAdminKey));
if (localAdminKey) { process.umask(0o077); protectAccessDirectories(controlHome, supportDirectory, dbPath); }
preserveProtectedIngress(resolveOpenScoutSupportPaths().supportDirectory, localAdminKey);

ensureOpenScoutCleanSlateSync();
const existingBroker = await probeExistingBroker();
const expectedNodeId = process.env.OPENSCOUT_NODE_ID?.trim();
if (existingBroker && !openScoutInstanceBootstrap.layout.isProd && expectedNodeId && existingBroker.nodeId !== expectedNodeId) {
  // Another broker (another instance, or prod) answers on this instance's
  // port: never mistake it for ourselves.
  console.error(
    `[openscout-runtime] refusing to start instance "${openScoutInstanceBootstrap.layout.name}": `
      + `${brokerUrl} is already served by node ${existingBroker.nodeId}, not ${expectedNodeId}. `
      + "Another OpenScout instance holds this port block; set OPENSCOUT_INSTANCE_PORT_BASE "
      + "or stop the other instance.",
  );
  process.exit(1);
}
if (existingBroker) {
  console.log(`[openscout-runtime] broker already running on ${existingBroker.brokerUrl}`);
  console.log(`[openscout-runtime] node ${existingBroker.nodeId} in mesh ${existingBroker.meshId ?? "unknown"}`);
  process.exit(0);
}

// Persist the default qualifier once. macOS may append a changing numeric
// suffix to os.hostname() after mDNS collisions; routing authority and agent
// ids must survive that display-hostname drift.
nodeId = resolveStableLocalNodeId({
  configuredNodeId: process.env.OPENSCOUT_NODE_ID,
  nodeName,
  meshId,
  supportDirectory,
});

const memoryMaintenance = memoryMaintenanceFromEnv(process.env);
const historyCount=(value:string|undefined,fallback:number)=>{const n=Number(value);return Number.isSafeInteger(n)&&n>0?n:fallback;};
// Experimental until the full packaged memory budget passes.
const messageHistory=process.env.OPENSCOUT_BROKER_DISK_HISTORY !== "1" ? undefined : await BrokerMessageHistory.create(journalPath,{snapshotReaders:historyCount(process.env.OPENSCOUT_BROKER_HISTORY_SNAPSHOT_READERS,2),coldReaders:historyCount(process.env.OPENSCOUT_BROKER_HISTORY_COLD_READERS,4)});
if (messageHistory && retentionWeeks > 0) {
  console.warn("[openscout-runtime] history rotation: message eviction is not implemented under OPENSCOUT_BROKER_DISK_HISTORY; messages are retained until that lands");
}
const journal = new FileBackedBrokerJournal(journalPath, {
  dispatchJobHistory: historicalReader,
  messageHistory,
  progressiveStartup: true,
  memoryMaintenance,
  ...(process.env.OPENSCOUT_BROKER_BODY_CACHE === "1" ? { messageBodyCache: { encodedSnapshots: process.env.OPENSCOUT_BROKER_ENCODED_SNAPSHOT === "1" } } : {}),
  shareLoadedStrings: process.env.OPENSCOUT_BROKER_SHARED_STRINGS === "1",
});
const journalLoadReport = await journal.load();
const initialSnapshot = journal.snapshot();
assertNoReservedStoredAgentNames(initialSnapshot.agents, { localNodeId: nodeId });

const sqliteDisabled = process.env.OPENSCOUT_DISABLE_SQLITE === "1";
// Retired actor tombstones aren't visible in the snapshot projection — the
// journal tracked them during replay so the runtime can fence stale
// whole-record roster writes that would resurrect a deleted member.
const runtime = createInMemoryControlRuntime(initialSnapshot, {
  localNodeId: nodeId,
  retiredActorIds: journal.retiredActorIds(),
});
replaceControlEventBacklog(runtime.recentEvents(500), 500);
if (!sqliteDisabled) {
  await mkdir(dirname(dbPath), { recursive: true });
}
const sharedControlPlaneStore = sqliteDisabled
  ? null
  : new LazyControlPlaneStore(() => new SQLiteControlPlaneStore(dbPath));
const projection = new WorkerSQLiteProjection(dbPath, journalPath, journal, { disabled: sqliteDisabled, historyDirectory });
let observedSessionReducer: ObservedSessionReducer | null = null;
let unsubscribeObservedSessionReducer: (() => void) | null = null;
let projectionWarmStarted = false;
let deferStartupProjection = true;
let controlEventWrites: Promise<void> = Promise.resolve();
const bootstrapProjectionOptions = () => (
  projectionWarmStarted ? undefined : { enqueueProjection: false as const }
);
const routeAliasDatabase = sharedControlPlaneStore?.routeAliasDatabase ?? null;
const integrationSetupService = routeAliasDatabase
  ? new BrokerIntegrationSetupService({ database: routeAliasDatabase, ownerRealmId: meshId, nodeId, snapshot: () => runtime.snapshot(), verifyCredentials: verifySlackWorkerCredentials })
  : undefined;
const integrationSlackEvents = integrationSetupService && routeAliasDatabase ? new IntegrationSlackEvents(routeAliasDatabase, integrationSetupService) : undefined;
const integrationSlackDelivery = integrationSetupService && routeAliasDatabase ? new IntegrationSlackDeliveryService(routeAliasDatabase, integrationSetupService) : undefined;
// Slack workers do not carry protected-local request signatures yet.
const slackWorkerSupervisor = !localAdminKey && integrationSetupService ? new SlackWorkerSupervisor(integrationSetupService, () => brokerUrl) : undefined;
const routeAliasService = routeAliasDatabase
  ? new BrokerRouteAliasService({
      store: new BrokerRouteAliasStore(routeAliasDatabase),
      ownerRealmId: meshId,
      nodeId,
      operatorActorId: "operator",
      runtimeSnapshot: () => runtime.routingSnapshot(),
      createId: createRuntimeId,
    })
  : undefined;

// ─── Mesh trust cone: node identity, ingress gate, enrollment ─────────────
// (docs/proposals/mesh-trust-cone.md). The long-term Ed25519 identity anchors
// everything: the gate verifies peer signatures against it, and enrollment
// publishes cards signed by it.
const nodeIdentity = loadOrCreateNodeIdentity();
const nodeIdentityKeyId = nodeKeyId(nodeIdentity.publicKey);
const nodeIdentityFingerprint = nodeFingerprint(nodeIdentity.publicKey);
const brokerBootedAt = Date.now();
const trustedPeerStore = sharedControlPlaneStore;
// Guest grants (docs/proposals/scout-tailscale.md) share the control-plane
// database but never the trusted_peers table or its tiers.
const guestGrantStore: GuestGrantStore | null = sharedControlPlaneStore
  ? new GuestGrantStore(
      sharedControlPlaneStore.routeAliasDatabase,
      (keyId) => Boolean(trustedPeerStore?.knownTrustedPeerKey(keyId)) || Boolean(meshAccessStore?.knownDevice(keyId)) || Boolean(meshAccessStore?.knownPrincipal(keyId)),
    )
  : null;
const meshAccessStore: MeshAccessStore | null = sharedControlPlaneStore
  ? new MeshAccessStore(sharedControlPlaneStore.routeAliasDatabase, nodeIdentityKeyId,
      (keyId) => keyId === nodeIdentityKeyId || Boolean(trustedPeerStore?.knownTrustedPeerKey(keyId)) || Boolean(guestGrantStore?.knownKey(keyId)))
  : null;
// Bind controller is assigned after the HTTP server stack is built; the gate
// reads forceRemoteEnforce via this ref so §11.6 can key off live listeners.
let meshBindController: MeshBindController | null = null;
let localIrohEntrypoint = resolveIrohMeshEntrypointFromEnv();
const meshIngressGate = createMeshIngressGate({
  irohEndpointId: () => localIrohEntrypoint?.endpointId,
  localAdminKey,
  keyConflict: (id) => [Boolean(trustedPeerStore?.knownTrustedPeerKey(id)), Boolean(guestGrantStore?.knownKey(id)), Boolean(meshAccessStore?.knownDevice(id)), Boolean(meshAccessStore?.knownPrincipal(id))].filter(Boolean).length > 1,
  scopedAccess: meshAccessStore ? {
    knownDevice: (keyId) => meshAccessStore.knownDevice(keyId),
    accept: (proof) => meshAccessStore.acceptDelegation(proof.delegation),
    verify: (envelope) => {
      if (!scopedAccessAvailable()) throw new Error("scoped access requires protected local ingress");
      return meshAccessStore.verifyDelegation((envelope as { delegation: import("./mesh-access.js").AccessDelegation }).delegation);
    },
  } : undefined,
  mode: meshGateMode,
  destinationKeyId: nodeIdentityKeyId,
  bootedAt: brokerBootedAt,
  lookupPeer: (keyId) => {
    const peer = trustedPeerStore?.trustedPeer(keyId);
    return peer ? { publicKey: peer.publicKey, tier: peer.tier } : undefined;
  },
  lookupGuest: (keyId) => {
    const grant = guestGrantStore?.activeByKeyId(keyId);
    return grant ? { publicKey: grant.publicKey, grantId: grant.id } : undefined;
  },
  nonceClaim: trustedPeerStore
    ? {
        claim: (keyId, nonce, now) =>
          trustedPeerStore.claimPeerNonce(keyId, nonce, now, PEER_AUTH_MAX_SKEW_MS),
      }
    : new PeerNonceCache(),
  logger: {
    warn: (message, detail) =>
      detail === undefined ? console.warn(message) : console.warn(message, detail),
  },
  forceRemoteEnforce: () => meshBindController?.hasNonLoopbackListener() ?? false,
});
const trustEnrollmentService = new TrustEnrollmentService({
  keyId: nodeIdentityKeyId,
  publicKey: nodeIdentity.publicKey,
  nodeId,
  fingerprint: nodeIdentityFingerprint,
});
const trustEndpointRateLimiter = new TrustEndpointRateLimiter();
function scopedAccessAvailable(): boolean {
  if (!meshAccessStore || !localAdminKey || effectiveGateMode() !== "enforce") return false;
  return meshAccessStore.healthy();
}
function currentSignedNodeCard() {
  const bind = meshBindController?.getState();
  const endpoints = bind && bind.endpoints.length > 0 ? bind.endpoints : [brokerUrl];
  return buildSignedNodeCard(nodeIdentity, {
    nodeId,
    label: nodeName,
    version: loadOpenScoutRuntimeBuildIdentity().version ?? "dev",
    capabilities: [...(currentLocalNode().capabilities ?? []), ...(scopedAccessAvailable() ? ["scout-access/1"] : [])],
    endpoints,
    ...(bind?.tlsSpkiFingerprint
      ? { tls: { spkiFingerprint: bind.tlsSpkiFingerprint } }
      : {}),
  });
}
function effectiveGateMode() {
  return localAdminKey || meshBindController?.hasNonLoopbackListener() ? "enforce" as const : meshGateMode;
}

/**
 * This daemon's own signed peer client for broker→broker sends (mesh trust
 * cone §5). Peers enrolled in trusted_peers — joined to snapshot nodes by
 * broker URL or advertised HTTP alias — are pinned to their enrolled key ID.
 * Missing, unreachable, or mismatched cards never permit unsigned sends.
 * Peers with no enrolled key ID keep the legacy rollout fallback. The shared
 * `meshPeerFetch` singleton stays unwired (the store is keyed by key ID, not
 * base URL, so the join only exists here in the daemon).
 */
function trustedPeerForBrokerBaseUrl(baseUrl: string) {
  return trustedPeerStore ? trustedMeshPeerForBrokerUrl(
    baseUrl,
    Object.values(runtime.snapshot().nodes),
    trustedPeerStore.listTrustedPeers(),
  ) : undefined;
}

const daemonMeshPeerFetch = createMeshPeerFetch({
  loadIdentity: () => nodeIdentity,
  expectedPeerKeyId: (baseUrl) => trustedPeerForBrokerBaseUrl(baseUrl)?.keyId,
  expectedPeerTlsPin: (baseUrl) => trustedPeerForBrokerBaseUrl(baseUrl)?.tlsSpkiFingerprint,
});

const threadEvents = new ThreadEventPlane({
  nodeId,
  runtime,
  projection,
});
// Opt-in event transport. Disabled by default; constructing it is cheap and
// `start()` is the only thing that touches a process, a socket, or a file.
const jetStreamConfig = (() => {
  try {
    return resolveJetStreamConfig();
  } catch (error) {
    // A malformed opt-in configuration disables the transport; it never stops
    // the broker, which remains the canonical writer with or without JetStream.
    console.error("[openscout-jetstream] configuration rejected; transport disabled:", error);
    return null;
  }
})();
const jetStreamService = !localAdminKey && jetStreamConfig?.enabled
  ? new BrokerJetStreamService({
      config: jetStreamConfig,
      journal,
      publisherNodeId: nodeId,
      // scout-base owns the sidecar process when it started one. A bare broker
      // run (no base supervisor) manages its own.
      manageSidecar: jetStreamConfig.manageServer,
      log: (message, detail) => (detail === undefined ? console.log(message) : console.log(message, detail)),
      warn: (message, detail) => (detail === undefined ? console.warn(message) : console.warn(message, detail)),
      error: (message, detail) => (detail === undefined ? console.error(message) : console.error(message, detail)),
    })
  : null;
const mcpEvents = process.env.OPENSCOUT_MCP_EVENTS === "1" && sharedControlPlaneStore
  ? new BrokerMcpEvents(sharedControlPlaneStore.routeAliasDatabase, {
      flight: (id) => runtime.flight(id),
      work: (id) => runtime.collaborationRecord(id),
      channel: (id) => runtime.conversation(id),
    })
  : undefined;
const durableStore = new BrokerDurableStore({
  memoryMaintenance,
  deferProjection: () => deferStartupProjection,
  afterRuntime: () => controlEventWrites,
  journal,
  projection,
  threadEvents,
  eventPublisher: { notifyCommitted(entries) {
    try { jetStreamService?.notifyCommitted(entries); }
    finally { mcpEvents?.capture(entries); }
  } },
});
// Before the broker admits a single write: a first-enable `now` boundary has
// to be committed ahead of the records it is meant to exclude, not after the
// transport happens to come up.
if (jetStreamService) {
  await jetStreamService.establishStartBoundary();
}
messageHistory?.setCaptureGate(durableStore.runWrite);
const runDurableWrite = durableStore.runWrite;
const commitDurableEntries = durableStore.commitEntries;
const applyProjectedEntries = durableStore.applyProjectedEntries;
const meshBundleService = new BrokerMeshBundleService({
  nodeId,
  runtime,
  commitEntries: commitDurableEntries,
});
const applyMeshBundleDurably = meshBundleService.applyBundle;
const activeInvocationTasks = new Map<string, Promise<void>>();
const knownInvocations = new Map<string, InvocationRequest>(Object.entries(initialSnapshot.invocations));
const meshHttpService = new BrokerMeshHttpService({
  nodeId,
  runtime,
  runDurableWrite,
  applyMeshBundle: applyMeshBundleDurably,
  commitEntries: commitDurableEntries,
  applyProjectedEntries,
  invocationSnapshotFor: async (invocationId) => {
    const invocation = knownInvocations.get(invocationId);
    const flight = runtime.flightForInvocation(invocationId);
    if ((invocation && flight) || sqliteDisabled) return { invocation, flight };
    const historical = await projection.readInvocationSnapshot(invocationId);
    return {
      invocation: invocation ?? historical.invocation ?? undefined,
      flight: flight ?? historical.flight ?? undefined,
    };
  },
  messageFor: async (messageId) => await runtime.readMessage(messageId)
    ?? (sqliteDisabled ? undefined : (await projection.readMessages([messageId])).get(messageId)),
  rememberInvocation: (invocation) => {
    knownInvocations.set(invocation.id, invocation);
  },
  completeInvocationsForBrokerReply: (message) => messageService.completeInvocationsForBrokerReply(message),
  localEndpointForActor: (actorId) => Object.values(runtime.snapshot().endpoints).find((endpoint) =>
    endpoint.agentId === actorId
    && endpoint.nodeId === nodeId
    && endpoint.state !== "offline"
    && endpoint.state !== "failed"
    && endpoint.state !== "stopped"),
  runDispatchJob: (job, invocation) => invocationDispatchService.runDispatchJob(job, invocation),
  warn: (message, detail) => console.warn(message, detail),
});
const meshForwardingService = new BrokerMeshForwardingService({
  nodeId,
  runtime,
  currentLocalNode,
  invocationFor: (invocationId) => knownInvocations.get(invocationId),
  endpointForAgent: (agentId) => homeEndpointForAgent(runtime.snapshot(), agentId),
  projectRootForTarget: brokerTargetProjectRoot,
  peerFetch: daemonMeshPeerFetch,
});
const controlStreams = new BrokerControlStreamService({
  enqueueEvent: (event) => {
    // Runtime emissions occur inside the serialized durable commit. Its
    // afterRuntime hook drains these writes before admitting the next command.
    // Retain at most one command's events, not the entire hydration interval.
    controlEventWrites = journal.appendEntries([{ kind: "control.event.record", event }]).then(() => {});
    void controlEventWrites.catch(() => {});
  },
  findDeliveryById: (deliveryId) => journal.getDelivery(deliveryId),
  listDeliveries: (options) => projection.listDeliveries(options),
  messageById: (messageId) => runtime.readMessage(messageId),
  invocationById: (invocationId) => knownInvocations.get(invocationId),
  // Reads the same registered source the tRPC subscribe path uses, so both
  // transports hand a new subscriber the identical current value.
  presenceSnapshot: () => snapshotPresenceControlEvents(),
});
const operatorActorId = "operator";
const durableRecords = new BrokerDurableRecordStore({
  localNodeId: nodeId,
  completionCurrentFlight: id => journal.getCurrentFlightForInvocation(id),
  completionFlight: id => journal.getFlight(id),
  completionInvocation: id => journal.getInvocation(id),
  runtime,
  durableStore,
  knownInvocations,
  invocationDispatchJobFor: (jobId) => journal.getInvocationDispatchJob(jobId),
  // Queried before agent/actor deletes so journaled entries carry the
  // membership preimage the conversation projection needs (member rows
  // cascade-delete with the actor).
  memberConversationIds: sharedControlPlaneStore
    ? (actorId: string) => sharedControlPlaneStore.memberConversationIds(actorId)
    : undefined,
});
const upsertNodeDurably = durableRecords.upsertNode;
const upsertActorDurably = durableRecords.upsertActor;
const upsertAgentDurably = durableRecords.upsertAgent;
const upsertEndpointDurably = durableRecords.upsertEndpoint;
const deleteEndpointDurably = durableRecords.deleteEndpoint;
const deleteAgentDurably = durableRecords.deleteAgent;
const deleteActorDurably = durableRecords.deleteActor;
const upsertConversationDurably = durableRecords.upsertConversation;
const upsertBindingDurably = durableRecords.upsertBinding;
const recordCollaborationDurably = durableRecords.recordCollaboration;
const appendCollaborationEventDurably = durableRecords.appendCollaborationEvent;
const recordMessageDurably = durableRecords.recordMessage;
const recordInvocationDurably = durableRecords.recordInvocation;
const recordInvocationDispatchJobDurably = durableRecords.recordInvocationDispatchJob;
const conversationService = new BrokerConversationService({
  nodeId,
  operatorActorId,
  dispatcherAgentId: SCOUT_DISPATCHER_AGENT_ID,
  runtime,
  operatorDisplayName: operatorActorDisplayName,
  createChannelId: () => mintChannelId(randomUUID),
  upsertActor: upsertActorDurably,
  updateConversation: durableRecords.updateConversation,
});
const meshDiscoveryService = new BrokerMeshDiscoveryService({
  nodeId,
  brokerUrl,
  defaultPort: port,
  meshId,
  seedUrls,
  nodeLocalProductAgentIds,
  runtime,
  upsertNode: upsertNodeDurably,
  upsertAgent: upsertAgentDurably,
  notifyPeerOnline: (peerNodeId) => peerDelivery.notifyPeerOnline(peerNodeId),
  trustedPeerNodeIds: () => new Set(
    trustedPeerStore?.listTrustedPeers().flatMap((peer) => peer.nodeId ? [peer.nodeId] : []) ?? [],
  ),
  fetchPeerAgents: (peerBrokerUrl) => fetchPeerAgents(peerBrokerUrl, daemonMeshPeerFetch),
  log: (message) => console.log(message),
});
const deliveryStore = new BrokerDeliveryStore({
  journal,
  durableStore,
  nodeId,
  createEventId: () => createRuntimeId("evt"),
  publishEvent: (event) => controlStreams.streamEvent(event),
});
const recordDeliveryDurably = deliveryStore.recordDelivery;
const recordDeliveryAttemptDurably = deliveryStore.recordDeliveryAttempt;
const heartbeatDurableActionDurably = deliveryStore.heartbeatDurableAction;
const updateDeliveryStatusDurably = deliveryStore.updateDeliveryStatus;
const claimDeliveryDurably = deliveryStore.claimDelivery;
const readCursorStore = new BrokerReadCursorStore({
  runtime,
  projection,
  durableStore,
  operatorActorId,
  nodeId,
  ensureActor: ensureBrokerActorForDelivery,
  journal,
  updateDeliveryStatusIf: deliveryStore.updateDeliveryStatusIf,
});
const listReadCursorsForConversation = readCursorStore.listForConversation;
const resolveReadCursor = readCursorStore.resolve;
const recordReadCursorDurably = readCursorStore.record;
const acknowledgeDeliveriesForReadCursor = readCursorStore.acknowledgeDeliveries;
const deliveryHttpService = new BrokerDeliveryHttpService({
  listInboxItems: (options) => controlStreams.listInboxItems(options),
  inboxItemForDelivery: (delivery) => controlStreams.inboxItemForDelivery(delivery),
  claimDelivery: claimDeliveryDurably,
  updateDeliveryStatus: updateDeliveryStatusDurably,
  listDeliveries: (options) => journal.listDeliveries(options),
  listDeliveryAttempts: (deliveryId) => journal.listDeliveryAttempts(deliveryId),
  recordDeliveryAttempt: recordDeliveryAttemptDurably,
});
const durableActionHttpService = new BrokerDurableActionHttpService({
  runDurableWrite,
  commitEntries: commitDurableEntries,
  heartbeatDurableAction: heartbeatDurableActionDurably,
  getDurableAction: (actionId) => journal.getDurableAction(actionId),
});
const workItemStore = new BrokerWorkItemStore({
  runtime,
  durableStore,
  durableFlight: (flightId) => journal.getFlight(flightId),
  durableWorkItem: (workId) => journal.getCollaborationRecord(workId),
  createId: createRuntimeId,
  warn: (message, error) => console.warn(message, error),
});
const recordDeliveryWorkItemIfNeeded = workItemStore.recordDeliveryWorkItemIfNeeded;
const deliveryWorkItemResolutionForTell = workItemStore.deliveryWorkItemResolutionForTell;
const promoteInvocationFlightToWork = workItemStore.promoteInvocationFlightToWork;
let workPromotionRecovery: Promise<void> | undefined;
function recoverTerminalWorkPromotions(): void {
  if (workPromotionRecovery) return;
  workPromotionRecovery = workItemStore.recoverTerminalWorkPromotions(journal.listPendingWorkPromotionFlights())
    .catch((error) => console.warn("[openscout-runtime] work promotion recovery failed:", error))
    .finally(() => { workPromotionRecovery = undefined; });
}
const wakeLocalSessionForBroker = (input: ExactSessionWakeInput): Promise<LocalSessionWakeResult> =>
  wakeLocalHarnessSession({
    nodeId,
    registry: { upsertActor: upsertActorDurably, upsertEndpoint: persistEndpoint },
    snapshotEndpoints: () => runtime.snapshot().endpoints,
    actorFor: (actorId) => runtime.peek().actors[actorId],
    harnessSupportsResume: (harness) => Boolean(findHarnessEntry(harness)?.resume),
    observeEndpointSession: observeLocalAgentEndpointSession,
    log: (message) => console.log(message),
  }, input);

const deliveryRouter = new BrokerDeliveryRouter({
  runtimeSnapshot: () => runtime.routingSnapshot(),
  nodeId,
  isInactiveLocalAgent,
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
  routeAliasService,
  wakeExactHarnessSession: async (input) => {
    const wake = await wakeLocalSessionForBroker(input);
    if (wake.ok) {
      return wake.forkedSession ? { ok: true, forkedSession: wake.forkedSession } : { ok: true };
    }
    if (wake.reason !== "session_unknown") {
      return wake;
    }
    // T4: this machine's harness store misses — ask trusted reachable peers to
    // wake the session in theirs and adopt the winning peer-owned endpoint.
    const peerWake = await wakeSessionOnPeers({
      localNodeId: nodeId,
      peers: trustedReachableMeshPeers(),
      postJson: (brokerBaseUrl, path, payload) => postMeshPeerJson(brokerBaseUrl, path, payload, daemonMeshPeerFetch),
      registry: { upsertActor: upsertActorDurably, upsertEndpoint: persistEndpoint },
      log: (message) => console.log(message),
    }, input);
    if (peerWake.ok) {
      return { ok: true };
    }
    return {
      ...wake,
      detail: peerWake.peersTried > 0
        ? `${wake.detail} (this node and ${peerWake.peersTried} mesh peer(s) checked their harness stores)`
        : wake.detail,
    };
  },
  resolveRemoteRouteAlias: async (target, caller) => {
    const selector = target.scope?.nodeId?.trim();
    if (!selector) return null;
    const matches = Object.values(runtime.snapshot().nodes).filter((candidate) =>
      candidate.id === selector || candidate.name === selector || candidate.hostName === selector
    );
    if (matches.length !== 1) {
      throw new BrokerRouteAliasError(
        "ambiguous_alias_scope",
        `host ${selector} is ${matches.length ? "ambiguous" : "unknown"}; use an exact node id`,
        { candidates: matches.map((candidate) => candidate.id) },
      );
    }
    const authority = matches[0]!;
    if (authority.id === nodeId) return null;
    if (authority.meshId !== meshId || !authority.brokerUrl) {
      throw new BrokerRouteAliasError(
        authority.meshId !== meshId ? "not_authorized" : "alias_target_unavailable",
        authority.meshId !== meshId
          ? "alias authority is outside the local owner realm"
          : `authoritative broker ${authority.id} is not reachable`,
      );
    }
    let response: Response;
    const requestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openscout-mesh-id": meshId,
        "x-openscout-forwarded-node-id": nodeId,
      },
      body: JSON.stringify({ alias: target.alias, bindingId: target.bindingId, scope: target.scope, caller }),
      signal: AbortSignal.timeout(30_000),
    };
    try {
      // Signed via the mesh peer client. Alias resolution is served to peers
      // at the remote tier (/v1/mesh/aliases/resolve, §4); pre-trust-cone
      // peers lack that route, so fall back to the legacy local path on 404.
      response = await daemonMeshPeerFetch(authority.brokerUrl, "/v1/mesh/aliases/resolve", requestInit);
      if (response.status === 404) {
        response = await daemonMeshPeerFetch(authority.brokerUrl, "/v1/aliases/resolve", requestInit);
      }
    } catch (error) {
      throw new BrokerRouteAliasError(
        "alias_target_unavailable",
        `failed to reach authoritative broker ${authority.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const result = await response.json().catch(() => ({})) as import("@openscout/protocol").RouteAliasResolveResult & {
      error?: import("@openscout/protocol").RouteAliasDiagnosticCode;
      detail?: string;
    };
    if (!response.ok || !result.resolved || !result.binding || !result.proof) {
      throw new BrokerRouteAliasError(
        result.diagnostic?.code ?? result.error ?? "unknown_alias",
        result.diagnostic?.detail ?? result.detail ?? `alias ${target.alias} did not resolve at ${authority.id}`,
      );
    }
    const targetAgent = runtime.snapshot().agents[result.binding.target.agentId];
    if (!targetAgent) {
      throw new BrokerRouteAliasError(
        "alias_target_unavailable",
        `alias ${target.alias} resolved at ${authority.id}, but canonical agent ${result.binding.target.agentId} is not visible in this mesh snapshot`,
      );
    }
    return {
      resolution: { kind: "resolved", agent: targetAgent },
      proof: result.proof,
      binding: result.binding,
    };
  },
});
const resolveBrokerDeliveryTargetWithImplicitProjectAgent =
  deliveryRouter.resolveWithImplicitProjectAgent.bind(deliveryRouter);
const resolveInvocationTarget = deliveryRouter.resolveInvocationTarget.bind(deliveryRouter);
const webControl = new BrokerWebControlService({
  brokerControlUrl,
  tailnetWebHosts,
  trustedHosts: webStartTrustedHosts,
  env: process.env,
  log: (message, detail) => {
    if (detail === undefined) {
      console.log(message);
    } else {
      console.log(message, detail);
    }
  },
  warn: (message) => console.warn(message),
  error: (message, detail) => {
    if (detail === undefined) {
      console.error(message);
    } else {
      console.error(message, detail);
    }
  },
});
// Scoutbot runs beside the broker on the local socket. scout-web inherits
// this environment, so the flag tells it to leave answering to Scoutbot.
const scoutbotService = new BrokerScoutbotService({
  brokerSocketPath,
  brokerUrl,
  env: process.env,
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message, detail) => {
    if (detail === undefined) console.error(message);
    else console.error(message, detail);
  },
});
const scoutbotProcessEnabled = scoutbotService.enabled();
if (scoutbotProcessEnabled) process.env[SCOUTBOT_PROCESS_ENV] = "managed";
const a2aService = new BrokerA2AService({
  nodeId,
  brokerUrl,
  runtime,
  knownInvocations,
  activeInvocationTasks,
  createId: createRuntimeId,
  acceptInvocation: acceptInvocationDurably,
  dispatchInvocation: dispatchAcceptedInvocation,
  recordFlight: recordFlightDurably,
  loadRegisteredLocalAgentBindings,
  sleep,
  error: (message, detail) => {
    if (detail === undefined) {
      console.error(message);
    } else {
      console.error(message, detail);
    }
  },
});
const capabilityMatrixService = new BrokerCapabilityMatrixService({
  nodeId,
  env: process.env,
});
const readBrokerCapabilityMatrixSnapshot = capabilityMatrixService.read.bind(capabilityMatrixService);
const runtimeCatalogService = new BrokerRuntimeCatalogService({ env: process.env });
const readBrokerRuntimeCatalogSnapshot = runtimeCatalogService.read.bind(runtimeCatalogService);
const runtimeCatalogRefreshMs = resolveRuntimeCatalogRefreshMs(process.env);
if (runtimeCatalogRefreshMs > 0) {
  setInterval(() => {
    void runtimeCatalogService.read();
  }, runtimeCatalogRefreshMs).unref();
}
void runtimeCatalogService.read();
let shuttingDown = false;
const sseKeepAliveIntervalMs = Number.parseInt(process.env.OPENSCOUT_SSE_KEEPALIVE_MS ?? "15000", 10);
// Presence observation cadence. The TTL is sized at three missed samples, so a
// dropped sample never flaps an agent out of freshness.
const presenceSampleIntervalMs = Number.parseInt(process.env.OPENSCOUT_PRESENCE_SAMPLE_MS ?? "30000", 10);
const presenceStaleAfterMs = Number.isFinite(presenceSampleIntervalMs) && presenceSampleIntervalMs > 0
  ? Math.max(90_000, presenceSampleIntervalMs * 3)
  : 90_000;
let meshRendezvousPublisher: MeshRendezvousPublisher | null = null;
let parentWatcher: ReturnType<typeof setInterval> | null = null;
let routeAliasSweepTimer: ReturnType<typeof setInterval> | null = null;

type LegacyRelayMessage = {
  id: string;
  ts: number;
  from: string;
  type: "MSG" | "SYS";
  body: string;
  tags?: string[];
  to?: string[];
  channel?: string;
};

runtime.subscribe((event) => {
  controlStreams.streamEvent(event);
  publishControlEvent(event);
});

// Presence: broker-observed, ephemeral, latest-per-agent. Deliberately not on
// the `runtime.subscribe` path above — that pairing writes a durable row for
// every event, and presence must create none. Transitions go straight to the
// in-memory bus and the live SSE clients.
const presenceService = new BrokerPresenceService({
  snapshot: () => runtime.snapshot(),
  publish: (event) => {
    controlStreams.streamEphemeralEvent(event);
    publishEphemeralControlEvent(event);
  },
  createId: createRuntimeId,
  actorId: nodeId,
  nodeId,
  map: { staleAfterMs: presenceStaleAfterMs },
});
setPresenceSnapshotSource(() => presenceService.snapshotEvents());

function samplePresenceSafely(): void {
  try {
    presenceService.sample();
  } catch (error) {
    console.warn("[openscout-runtime] presence sample failed:", error);
  }
}

function startPresenceSampling(): void {
  if (!Number.isFinite(presenceSampleIntervalMs) || presenceSampleIntervalMs <= 0) return;
  // Yield once after both listeners bind so even an unexpectedly expensive
  // initial projection can never delay the broker's health boundary.
  setTimeout(samplePresenceSafely, 0).unref();
  setInterval(samplePresenceSafely, presenceSampleIntervalMs).unref();
}

if (sseKeepAliveIntervalMs > 0) {
  setInterval(() => {
    controlStreams.streamKeepAlive();
  }, sseKeepAliveIntervalMs).unref();
}

let irohBridgeService: IrohBridgeService | undefined;
if (!localAdminKey && !localIrohEntrypoint) {
  try {
    irohBridgeService = await startIrohBridgeServeFromEnv({ brokerUrl });
    localIrohEntrypoint = irohBridgeService?.entrypoint;
    if (irohBridgeService) {
      irohBridgeService.child.on("exit", (code, signal) => {
        if (!shuttingDown) {
          console.warn(`[openscout-runtime] Iroh bridge exited (${code ?? signal ?? "unknown"}); HTTP/Tailscale forwarding remains available`);
        }
      });
    }
  } catch (error) {
    console.warn(`[openscout-runtime] Iroh bridge unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const localNode: NodeDefinition = {
  id: nodeId,
  meshId,
  name: nodeName,
  hostName: hostname(),
  advertiseScope,
  brokerUrl,
  webUrl: webControl.url(),
  webHost: localWebHost,
  ...(localIrohEntrypoint ? { meshEntrypoints: [localIrohEntrypoint] } : {}),
  tailnetName,
  capabilities: [SCOUT_COMPLETION_CAPABILITY, "broker", "mesh", "local_runtime", SCOUT_SESSION_INPUT_RECEIPTS_CAPABILITY],
  registeredAt: Date.now(),
  lastSeenAt: Date.now(),
};

function currentHostInfo() {
  const supportPaths = resolveOpenScoutSupportPaths();
  const webUrl = webControl.url();
  const webPort = webControl.port();
  const now = Date.now();
  return {
    schemaVersion: 1,
    source: "openscout-runtime",
    updatedAtMs: now,
    nodeId,
    meshId,
    nodeName,
    hostName: hostname(),
    advertiseScope,
    tailnetName,
    brokerUrl,
    webUrl,
    webHost: localWebHost,
    brokerSocketPath,
    supportDirectory: supportPaths.supportDirectory,
    runtimeDirectory: supportPaths.runtimeDirectory,
    ports: {
      broker: port,
      web: webPort,
    },
    services: {
      broker: {
        url: brokerUrl,
        host,
        port,
        socketPath: brokerSocketPath,
      },
      web: {
        url: webUrl,
        host: "127.0.0.1",
        port: webPort,
      },
    },
  };
}

async function writeHostInfo(): Promise<void> {
  const hostInfoPath = resolveOpenScoutSupportPaths().hostInfoPath;
  await mkdir(dirname(hostInfoPath), { recursive: true });
  const temporaryPath = `${hostInfoPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(currentHostInfo(), null, 2)}\n`, "utf8");
  await rename(temporaryPath, hostInfoPath);
}

const systemActor: ActorIdentity = {
  id: "system",
  kind: "system",
  displayName: "System",
  handle: "system",
  labels: ["runtime"],
  metadata: {
    source: "broker",
  },
};

async function migrateUnqualifiedRelayAgentKeys(): Promise<void> {
  const canonical = await readRelayAgentOverrides();
  await writeRelayAgentOverrides(canonical);
}

const readRelayAgentRegistrySignature = createRelayAgentRegistrySignatureReader({
  resolvePath: () => resolveOpenScoutSupportPaths().relayAgentsRegistryPath,
});

async function syncRegisteredLocalAgentsIfChanged(reason: string): Promise<void> {
  await localAgentSyncService.syncIfChanged(reason);
}

async function bootstrapRegisteredLocalAgents(): Promise<void> {
  await localAgentSyncService.bootstrap();
}

function currentLocalNode(): NodeDefinition {
  return runtime.node(nodeId) ?? localNode;
}

function localNodeWithBindState(node: NodeDefinition, state: MeshBindState): NodeDefinition {
  const httpEntrypoints = state.endpoints.map((url) => ({
    kind: "http" as const,
    url,
    lastSeenAt: Date.now(),
  }));
  const otherEntrypoints = (node.meshEntrypoints ?? []).filter((entrypoint) => entrypoint.kind !== "http");
  return {
    ...node,
    advertiseScope: state.scope,
    brokerUrl: state.brokerUrl,
    meshEntrypoints: [...httpEntrypoints, ...otherEntrypoints],
    lastSeenAt: Date.now(),
  };
}

function currentRendezvousNode(): NodeDefinition {
  const node = currentLocalNode();
  const mobilePairingEntrypoint = readMobilePairingMeshEntrypoint();
  if (!mobilePairingEntrypoint) {
    return node;
  }

  return {
    ...node,
    meshEntrypoints: [
      ...(node.meshEntrypoints ?? []).filter((entrypoint) => entrypoint.kind !== "mobile_pairing"),
      mobilePairingEntrypoint,
    ],
    lastSeenAt: Date.now(),
  };
}

async function recordScoutDispatchDurably(
  envelope: ScoutDispatchEnvelope,
  options: {
    invocationId?: string;
    conversationId?: string;
    requesterId?: string;
  } = {},
): Promise<{
  record: ScoutDispatchRecord;
  message: MessageRecord | null;
  entries: BrokerJournalEntry[];
}> {
  const record: ScoutDispatchRecord = {
    id: createRuntimeId("scout-dispatch"),
    invocationId: options.invocationId,
    conversationId: options.conversationId,
    requesterId: options.requesterId,
    ...envelope,
  };

  const dispatchEntries: BrokerJournalEntry[] = [
    { kind: "scout.dispatch.record", dispatch: record },
  ];

  let syntheticMessage: MessageRecord | null = null;
  if (options.conversationId) {
    syntheticMessage = {
      id: createRuntimeId("msg-scout"),
      conversationId: options.conversationId,
      actorId: SCOUT_DISPATCHER_AGENT_ID,
      originNodeId: nodeId,
      class: "system",
      body: record.detail,
      visibility: "workspace",
      policy: "best_effort",
      createdAt: record.dispatchedAt,
      metadata: {
        scoutDispatch: record,
      },
    };
  }

  return runDurableWrite(async () => {
    const appended = await commitDurableEntries(dispatchEntries, async () => {});
    if (!syntheticMessage) {
      return { record, message: null, entries: appended };
    }

    const deliveries = runtime.planMessage(syntheticMessage, { localOnly: true });
    const messageEntries = await commitDurableEntries(
      [
        { kind: "message.record", message: syntheticMessage },
        { kind: "deliveries.record", deliveries },
      ],
      async () => {
        await runtime.commitMessage(syntheticMessage!, deliveries);
      },
    );
    return { record, message: syntheticMessage, entries: [...appended, ...messageEntries] };
  });
}

const flightLifecycleService = new BrokerFlightLifecycleService({
  runtime,
  journal,
  durableStore,
  invocationFor: (invocationId) => knownInvocations.get(invocationId),
  updateDeliveryStatus: updateDeliveryStatusDurably,
  updateDeliveryStatusIf: deliveryStore.updateDeliveryStatusIf,
  prepareWorkPromotion: workItemStore.prepareTerminalWorkPromotion,
  promoteInvocationFlightToWork,
  prepareTerminalReport: (flight, invocation) => prepareTerminalReport(flight, invocation, {
    nodeId, systemActorId: systemActor.id, conversation: (id) => runtime.conversation(id), now: Date.now,
  }),
  deliverTerminalReport: (flightId) => terminalReportDeliveryService.deliver(flightId),
  maybeForwardFlightToAuthority: (flight) => meshForwardingService.maybeForwardFlightToAuthority(flight),
  isInvocationActive: (invocationId) => flightCompletion(runtime.flightForInvocation(invocationId))?.awaitingFinal === true
    || replyCompletionRecovery.isPending(invocationId)
    || localInvocationService.hasActiveInvocation(invocationId) || externalSessionService.hasPendingInvocation(invocationId)
    || t3Service.hasPendingInvocation(invocationId),
  onTerminalFlight: async ({ flight, invocation }) => {
    if (invocation && flight.state === "cancelled") void t3Service.cancel(invocation)
      .catch(error => console.error("[openscout-runtime] T3 cancellation unconfirmed", error));
    if (invocation) void externalSessionService.forwardResult(invocation, flight)
      .catch((error) => console.error("[openscout-runtime] external result delivery failed", error));
    // Role lifecycle (orchestrator post_ask_summary, etc.). Best-effort; never
    // fail the flight record path. Uses a short-lived SQLite connection so we
    // don't hold the projection store lock.
    if (sqliteDisabled) return;
    try {
      const { Database } = await import("bun:sqlite");
      const db = new Database(dbPath);
      try {
        db.exec("PRAGMA busy_timeout = 2500;");
        const result = applyRoleLifecycleForTerminalFlight(db as never, {
          flight,
          invocation,
        });
        if (result.written > 0) {
          console.log(
            `[openscout-runtime] role lifecycle flight ${flight.id}: wrote ${result.written} mission log entr${result.written === 1 ? "y" : "ies"}`,
          );
        }
        if (result.errors.length > 0) {
          console.warn(
            `[openscout-runtime] role lifecycle flight ${flight.id} errors:`,
            result.errors.join("; "),
          );
        }
      } finally {
        db.close();
      }
    } catch (error) {
      console.warn(
        `[openscout-runtime] role lifecycle flight ${flight.id} failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  },
  warn: (message, detail) => {
    if (detail === undefined) {
      console.warn(message);
    } else {
      console.warn(message, detail);
    }
  },
});

async function recordFlightDurably(flight: FlightRecord, eligible?: () => boolean): Promise<void> {
  await flightLifecycleService.recordFlight(flight, eligible);
}

async function reconcileStaleLocalDeliveries(): Promise<void> {
  await flightLifecycleService.reconcileStaleLocalDeliveries();
}

async function persistFlight(flight: FlightRecord, eligible?: () => boolean): Promise<void> {
  await recordFlightDurably(flight, eligible);
}

// Phase 3 write collapse: status changes are expressed as patches against the
// invocation's current flight rather than hand-built whole FlightRecords, and
// still funnel through recordFlightDurably so the lifecycle hooks fire.
async function transitionInvocation(
  invocationId: string,
  patch: InvocationStatusPatch,
): Promise<FlightRecord> {
  const current = runtime.flightForInvocation(invocationId);
  if (!current) {
    // Dispatch persists the initial flight before launching local execution,
    // so a missing flight here is an invariant breach, not a normal state.
    throw new Error(`cannot transition invocation ${invocationId}: no flight recorded`);
  }
  const next = applyInvocationStatusPatch(current, patch);
  await recordFlightDurably(next);
  // Recording can reject a stale patch after another writer completes/cancels
  // the invocation. Never return the uncommitted proposal to a side-effect caller.
  return runtime.flightForInvocation(invocationId)!;
}

async function persistEndpoint(endpoint: AgentEndpoint): Promise<void> {
  await upsertEndpointDurably(endpoint);
  if (startupTrafficGate.snapshot().mutationsAdmitted && (endpoint.state === "idle" || endpoint.state === "active")) {
    dispatchRecoveryService.recoverQueuedFlights({
      reason: "endpoint_online",
      agentId: endpoint.agentId,
    }).catch((error) => {
      console.error("[openscout-runtime] queued dispatch recovery failed:", error);
    });
  }
}

async function sweepIdleCardlessSessions(): Promise<void> {
  const configuredTtlMs = Number.isFinite(cardlessSessionIdleTtlMs)
    ? cardlessSessionIdleTtlMs
    : DEFAULT_CARDLESS_SESSION_IDLE_TTL_MS;
  const initialCandidates = idleCardlessSessionExpiryCandidates(runtime.snapshot(), {
    nodeId,
    idleTtlMs: configuredTtlMs,
  });
  let reaped = 0;

  for (const initialCandidate of initialCandidates) {
    // Re-evaluate immediately before shutdown so a newly assigned flight or work
    // item wins the race against the periodic reaper.
    const candidate = idleCardlessSessionExpiryCandidates(runtime.snapshot(), {
      nodeId,
      idleTtlMs: configuredTtlMs,
    }).find((endpoint) => endpoint.id === initialCandidate.id);
    if (!candidate) continue;

    try {
      await shutdownLocalSessionEndpoint(candidate);
    } catch (error) {
      console.warn(`[openscout-runtime] failed to stop expired cardless session ${candidate.agentId}:`, error);
      continue;
    }

    const retiredAt = Date.now();
    await persistEndpoint({
      ...candidate,
      state: "stopped",
      metadata: {
        ...(candidate.metadata ?? {}),
        cardlessSessionExpired: true,
        staleLocalRegistration: true,
        retiredAt,
        lastError: `idle cardless session expired after ${configuredTtlMs}ms`,
        lastFailedAt: retiredAt,
      },
    });
    reaped += 1;
  }

  if (reaped > 0) {
    console.log(`[openscout-runtime] retired ${reaped} idle cardless session${reaped === 1 ? "" : "s"}`);
  }
}

/**
 * Remove rotation-old, unreferenced registry records — retired endpoints, then
 * agents, then actors. The plan comes from the in-memory snapshot; agents and
 * actors get a second, authoritative reference check against SQLite so journal
 * replay lag can never turn into a dangling FK delete.
 */
async function sweepRegistryRetention(): Promise<void> {
  if (registryRetentionOverrideMs === 0) return;
  if (registryRetentionOverrideMs === undefined && retentionWeeks <= 0) return;
  // The boundary is recomputed per sweep: the week clock means a new cutoff
  // only when the calendar week rolls over; the ms override stays rolling.
  const cutoff = registryRetentionOverrideMs !== undefined
    ? Date.now() - registryRetentionOverrideMs
    : retentionCutoff(Date.now(), retentionWeeks);
  // SQLite's actors.created_at is authoritative age evidence for rows
  // journaled before actor upserts carried createdAt.
  let actorCreatedAtById: Map<string, number> | undefined;
  try {
    actorCreatedAtById = sharedControlPlaneStore?.actorCreatedAtById();
  } catch {
    actorCreatedAtById = undefined;
  }
  const plan = registryRetentionPlan(runtime.snapshot(), {
    nodeId,
    cutoff,
    actorCreatedAtById,
  });
  const total = plan.endpointIds.length + plan.agentIds.length + plan.actorIds.length;
  if (total === 0) return;

  const referenceCount = (kind: "agent" | "actor", id: string): number => {
    if (!sharedControlPlaneStore) return 0;
    try {
      return kind === "agent"
        ? sharedControlPlaneStore.agentReferenceCount(id)
        : sharedControlPlaneStore.actorReferenceCount(id);
    } catch {
      // An unreadable store must fail closed: keep the record.
      return Number.MAX_SAFE_INTEGER;
    }
  };

  // Guards run inside the serialized durable writer against fresh canonical
  // state — a revival or reference queued ahead of the delete wins, and the
  // SQLite reference count stays an additional veto evaluated in the same
  // write (the projection can lag the journal, so it is a veto, not the sole
  // live-reference authority).
  const evaluator = createRegistryRetentionEvaluator({
    nodeId,
    cutoff,
    actorCreatedAtById,
  });

  let failureCount = 0;
  const removed = await applyRegistryRetentionPlan(plan, {
    deleteEndpoint: (endpointId) =>
      deleteEndpointDurably(endpointId, {
        eligible: (snapshot) => evaluator.endpointEligible(snapshot, endpointId),
      }),
    deleteAgent: (agentId) =>
      deleteAgentDurably(agentId, {
        eligible: (snapshot) => {
          const verdict = evaluator.agentEligible(snapshot, agentId);
          if (!verdict.ok) return verdict;
          return referenceCount("agent", agentId) > 0
            ? { ok: false, reason: "sqlite-reference" }
            : { ok: true };
        },
      }),
    deleteActor: (actorId) =>
      deleteActorDurably(actorId, {
        eligible: (snapshot) => {
          const verdict = evaluator.actorEligible(snapshot, actorId);
          if (!verdict.ok) return verdict;
          return referenceCount("actor", actorId) > 0
            ? { ok: false, reason: "sqlite-reference" }
            : { ok: true };
        },
      }),
  }, {
    onProgress: (completed, totalCount) => {
      console.log(`[openscout-runtime] registry retention ${completed}/${totalCount}`);
    },
    onPaceAdjust: (newBatchSize) => {
      console.warn(`[openscout-runtime] registry retention batch exceeded 5s — batch size halved to ${newBatchSize}, yielding 250ms between batches`);
    },
    onFailure: (category, id, error) => {
      // First few failures logged individually; the rollup lands in the
      // summary line so a pathological sweep can't flood the log.
      if (failureCount++ < 5) {
        console.warn(`[openscout-runtime] registry retention ${category} delete failed for ${id}:`, error instanceof Error ? error.message : error);
      }
    },
  });
  const skippedCount = removed.skipped.endpoints + removed.skipped.agents + removed.skipped.actors;
  if (removed.endpoints + removed.agents + removed.actors > 0 || skippedCount > 0 || removed.failures > 0) {
    console.log(`[openscout-runtime] registry retention removed ${removed.endpoints} endpoints, ${removed.agents} agents, ${removed.actors} actors (older than ${new Date(cutoff).toISOString()})${skippedCount > 0 ? ` — skipped ${skippedCount} (vetoed at write time)` : ""}${removed.failures > 0 ? ` — ${removed.failures} delete(s) failed` : ""}`);
  }
}

// Verify storage outside the command writer. Recheck versions and dependency
// eligibility in its short commit phase; historical IO must not block asks.
let historyRotationCursor: string | null = null;
let historyRotationPressure: unknown = null;
async function rotateHistory(): Promise<number> {
  if (shuttingDown || retentionWeeks <= 0 || sqliteDisabled) {
    return 0;
  }
  const cutoff = retentionCutoff(Date.now(), retentionWeeks);
  const countsOf = (plan: {
    messageIds: ReadonlySet<string>;
    invocationIds: ReadonlySet<string>;
    flightIds: ReadonlySet<string>;
    deliveryIds: ReadonlySet<string>;
    deliveryAttemptIds: ReadonlySet<string>;
    collaborationEventIds: ReadonlySet<string>;
  }) => ({
    messages: plan.messageIds.size,
    flights: plan.flightIds.size,
    invocations: plan.invocationIds.size,
    deliveries: plan.deliveryIds.size,
    deliveryAttempts: plan.deliveryAttemptIds.size,
    collaborationEvents: plan.collaborationEventIds.size,
  });
  type RotationOutcome =
    | { skipped: string }
    | {
        rotated: true;
        evicted: ReturnType<typeof countsOf>;
        retained: ReturnType<typeof countsOf>;
        retainedIds: {
          messageIds: string[];
          invocationIds: string[];
          flightIds: string[];
          deliveryIds: string[];
          deliveryAttemptIds: string[];
          collaborationEventIds: string[];
        };
      }
    | null;
  const snapshotAtPreparation = journal.snapshot();
  const eligible = planHistoryRotation(snapshotAtPreparation, cutoff, journal.historyRotationContext());
  const batch = selectHistoryRotationBatch(eligible, journal.verificationRecords(eligible), { cursor: historyRotationCursor, maxBytes: 64 * 1024 * 1024 });
  historyRotationCursor = batch.cursor;
  historyRotationPressure = batch.pressure;
  const plan = batch.plan;
  if (!batch.selectedRecords) return 0;
  const preparedRecords = structuredClone(journal.verificationRecords(plan));
  const boundary = await durableStore.awaitProjectionBoundary();
  if (!boundary.ok) {
    console.warn(`[openscout-runtime] history rotation skipped: ${boundary.reason}`);
    return 0;
  }
  const publication = await publishHistoryRotationPages(plan, remaining => projection.publishHistoryRotation(remaining));
  historyRotationPressure = { selection: batch.pressure, publication: publication.blocked.slice(0, 16) };
  const verification = await durableStore.verifyPersisted(plan);
  if (shuttingDown) return 0;
  // SQLite verification alone is not a historical publication receipt.
  for (const key of Object.keys(plan) as (keyof typeof plan)[]) {
    for (const id of verification.present[key]) if (!publication.published[key].has(id)) verification.present[key].delete(id);
  }
  const outcome: RotationOutcome = await durableStore.runWrite(async () => {
    if (shuttingDown) return null;
    const snapshot = journal.snapshot();
    const stillEligible = planHistoryRotation(snapshot, cutoff, journal.historyRotationContext());
    const { present, missing } = revalidateHistoryRotation(plan, verification.present, stillEligible,
      preparedRecords, journal.verificationRecords(plan));
    // Partial batches must keep the same safe removal order after late writes:
    // attempts before deliveries, and invocations before their last flight.
    const constrained = constrainHistoryRotationBatch(present, stillEligible, journal.verificationRecords(stillEligible));
    for (const key of Object.keys(plan) as (keyof typeof plan)[]) {
      for (const id of present[key]) if (!constrained[key].has(id)) { present[key].delete(id); missing[key].add(id); }
    }
    // Re-run the dependency closure over the verified answer: a record that
    // could not be proven durable stays live, so every candidate connected
    // to it — referents and dependents — stays journaled too. Eviction is
    // failed verification retains connected members of this bounded selection.
    const attemptsById = journal.deliveryAttemptsById();
    const { evictable, retained } = refineVerifiedRotation(present, missing, {
      invocation: (id) => snapshot.invocations[id],
      flight: (id) => snapshot.flights[id],
      delivery: (id) => journal.getDelivery(id),
      deliveryAttempt: (id) => attemptsById.get(id),
    });
    const evicted = {
      messageIds: [...evictable.messageIds],
      invocationIds: [...evictable.invocationIds],
      flightIds: [...evictable.flightIds],
      deliveryIds: [...evictable.deliveryIds],
      deliveryAttemptIds: [...evictable.deliveryAttemptIds],
      collaborationEventIds: [...evictable.collaborationEventIds],
    };
    if (!Object.values(evicted).some(ids => ids.length > 0)) return null;
    let rotated = false;
    await commitDurableEntries(
      [{ kind: "history.rotate", cutoff, rotatedAt: Date.now(), evicted, publications: publication.publications }],
      async () => {
        runtime.applyHistoryRotation(evictable);
        for (const invocationId of evictable.invocationIds) {
          knownInvocations.delete(invocationId);
        }
        rotated = true;
      },
    );
    const firstFive = (ids: ReadonlySet<string>) => [...ids].slice(0, 5);
    return rotated
      ? {
          rotated: true,
          evicted: countsOf(evictable),
          retained: countsOf(retained),
          retainedIds: {
            messageIds: firstFive(retained.messageIds),
            invocationIds: firstFive(retained.invocationIds),
            flightIds: firstFive(retained.flightIds),
            deliveryIds: firstFive(retained.deliveryIds),
            deliveryAttemptIds: firstFive(retained.deliveryAttemptIds),
            collaborationEventIds: firstFive(retained.collaborationEventIds),
          },
        }
      : null;
  });
  if (outcome !== null && "skipped" in outcome) {
    console.warn(`[openscout-runtime] history rotation skipped: ${outcome.skipped}`);
  } else if (outcome !== null) {
    const { evicted, retained, retainedIds } = outcome;
    console.log(`[openscout-runtime] history rotated: cutoff ${new Date(cutoff).toISOString()}, evicted ${evicted.messages}/${evicted.flights}/${evicted.invocations}/${evicted.deliveries}/${evicted.deliveryAttempts}/${evicted.collaborationEvents} (M/F/I/D/A/C), retained-unverified ${retained.messages}/${retained.flights}/${retained.invocations}/${retained.deliveries}/${retained.deliveryAttempts}/${retained.collaborationEvents}`);
    const retainedTotal = retained.messages + retained.flights + retained.invocations
      + retained.deliveries + retained.deliveryAttempts + retained.collaborationEvents;
    if (retainedTotal > 0) {
      const samples: string[] = [];
      if (retainedIds.messageIds.length > 0) samples.push(`messages: ${retainedIds.messageIds.join(", ")}`);
      if (retainedIds.flightIds.length > 0) samples.push(`flights: ${retainedIds.flightIds.join(", ")}`);
      if (retainedIds.invocationIds.length > 0) samples.push(`invocations: ${retainedIds.invocationIds.join(", ")}`);
      if (retainedIds.deliveryIds.length > 0) samples.push(`deliveries: ${retainedIds.deliveryIds.join(", ")}`);
      if (retainedIds.deliveryAttemptIds.length > 0) samples.push(`delivery attempts: ${retainedIds.deliveryAttemptIds.join(", ")}`);
      if (retainedIds.collaborationEventIds.length > 0) samples.push(`collaboration events: ${retainedIds.collaborationEventIds.join(", ")}`);
      console.warn(`[openscout-runtime] history rotation retained ${retainedTotal} record(s) the projection has not durably persisted — they stay journaled and retry next rotation. First ids — ${samples.join("; ")}`);
    }
  }
  return outcome && "rotated" in outcome ? Object.values(outcome.evicted).reduce((sum, count) => sum + count, 0) : 0;
}

async function archiveDispatchJobs(): Promise<number> {
  if (shuttingDown || retentionWeeks <= 0 || sqliteDisabled) return 0;
  const cutoff = retentionCutoff(Date.now(), retentionWeeks);
  const jobs = journal.captureArchivableInvocationDispatchJobs({ cutoff });
  if (!jobs.length) return 0;
  const records = journal.dispatchJobHistoricalRecords(jobs);
  // A prior publication may have won just before a job changed, so its old
  // catalog version is a compare-and-swap precondition rather than a permanent
  // collision. Fresh hot-state revalidation still owns permission to evict.
  const expectedDigests = new Map<string, string>();
  for (const record of records) {
    const location = historicalReader.locate(record.kind, record.id);
    if (location) expectedDigests.set(historicalRecordKey(record.kind, record.id), location.digest);
  }
  await projection.publishHistoricalPage(records, { expectedDigests });
  if (shuttingDown) return 0;
  return durableStore.runWrite(async () => {
    if (shuttingDown) return 0;
    const dispatchJobIds = journal.revalidateArchivedInvocationDispatchJobs(jobs, cutoff);
    if (!dispatchJobIds.length) throw new Error("Dispatch history changed during publication; keeping hot state for retry.");
    await commitDurableEntries({ kind: "history.rotate", cutoff, rotatedAt: Date.now(), evicted: {
      messageIds: [], invocationIds: [], flightIds: [], deliveryIds: [], deliveryAttemptIds: [], collaborationEventIds: [], dispatchJobIds,
    } }, async () => {});
    return dispatchJobIds.length;
  });
}

// Export one bounded page per maintenance turn on the projection worker.
// Free SQLite pages are reused; a whole-file VACUUM belongs to offline upkeep.
async function archiveControlPlane(): Promise<number> {
  if (shuttingDown || archiveWeeks <= 0 || !sharedControlPlaneStore) return 0;
  const boundary = await durableStore.awaitProjectionBoundary();
  if (!boundary.ok) {
    throw new Error(`Control-plane archive deferred: ${boundary.reason}`);
  }
  if (shuttingDown) return 0;
  const cutoff = retentionCutoff(Date.now(), archiveWeeks);
  const archived = await projection.archiveEvents({
    cutoff,
    archiveDir: controlPlaneArchiveDirectory(), pageSize: 1000, maxPages: 1,
  });
  if (shuttingDown) return 0;
  const controlEventIds = archived.verifiedEventIds ?? [];
  if (controlEventIds.length) await durableStore.runWrite(async () => {
    if (shuttingDown) return;
    await commitDurableEntries({ kind: "history.rotate", cutoff, rotatedAt: Date.now(), evicted: {
      messageIds: [], invocationIds: [], flightIds: [], deliveryIds: [], deliveryAttemptIds: [], collaborationEventIds: [], controlEventIds,
    } }, async () => {});
  });
  if (archived.rows > 0) console.log(`[openscout-runtime] control-plane events archived: ${archived.rows} rows, ${archived.bytesWritten} bytes across ${archived.weeks.length} week(s)`);
  return archived.rows;
}

const storageMaintenance = new BrokerStorageMaintenance({
  page: async signal => {
    signal.throwIfAborted();
    if (shuttingDown || !startupTrafficGate.snapshot().mutationsAdmitted) return 0;
    const rotated = await rotateHistory();
    signal.throwIfAborted();
    const jobs = await archiveDispatchJobs();
    signal.throwIfAborted();
    const events = await archiveControlPlane();
    return rotated + jobs + events;
  },
  compact: async signal => {
    signal.throwIfAborted();
    if (shuttingDown) return;
    // Capture before flushing, so only receipts inside a proven byte boundary
    // may be discarded. Newer receipts remain protected even if a concurrent
    // canonical write reaches the compaction prefix in between these awaits.
    const historicalCleanupBoundary = await journal.captureReplayBoundary();
    const boundary = await durableStore.awaitProjectionBoundary();
    signal.throwIfAborted();
    if (!boundary.ok) throw new Error(`Journal compaction deferred: ${boundary.reason}`);
    const report = await journal.compactIfNeeded({ signal, historicalCleanupApplied: true, historicalCleanupBoundary });
    if (report.state === "budget") console.warn(`[openscout-runtime] journal compaction retained source: ${report.reason}`);
  },
  onError: error => console.error("[openscout-runtime] storage maintenance deferred; working records retained:", error),
});

// Relay agents live in detached tmux sessions parented to launchd, so nothing
// reaps them for free. The reaper puts idle relays back to sleep (the wake
// path recreates them on demand) and its startup pass collects orphans left
// behind by previous runs.
const relayAgentReaper = new RelayAgentSessionReaper({
  snapshot: () => runtime.snapshot(),
  listTmuxSessions: async () => {
    const [probe, launched] = await Promise.all([
      tmuxSessionsProbe.for({}).fresh({ maxAgeMs: 5_000 }),
      listScoutLaunchedTmuxSessions(),
    ]);
    return (probe.value ?? []).map((session) => ({
      name: session.name,
      attached: session.attached,
      createdAtMs: session.createdAt ? session.createdAt * 1_000 : null,
      activityAtMs: session.activityAt ? session.activityAt * 1_000 : null,
      launchedByScout: launched.has(session.name),
    }));
  },
  listSessionOwners: () => listRelayAgentTmuxSessionOwners(),
  killSession: (sessionName) => sleepLocalAgentSession(sessionName),
  reconcileLeases: ({ liveSessionNames, owners }) => {
    reconcileRelayAgentProcessLeases({ liveSessionNames, owners });
  },
  idleTtlMs: Number.isFinite(relayAgentIdleTtlMs) && relayAgentIdleTtlMs > 0
    ? relayAgentIdleTtlMs
    : DEFAULT_RELAY_AGENT_SESSION_IDLE_TTL_MS,
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
});

const managedSessionService = new BrokerManagedSessionService({
  nodeId,
  runtime,
  createId: createRuntimeId,
  isInactiveLocalAgent,
  upsertAgent: upsertAgentDurably,
  persistEndpoint,
  findPairingSession,
  getPairingSessionSnapshot,
  ensurePairingSessionForCodexThread,
  shutdownLocalSessionEndpoint,
  log: (message) => console.log(message),
});

const managedSessionHttpService = new BrokerManagedSessionHttpService({
  nodeId,
  runtimeSnapshot: () => runtime.snapshot(),
  processCwd: () => process.cwd(),
  listPairingSessions,
  attachManagedPairingSession: (input) => managedSessionService.attachManagedPairingSession(input),
  detachManagedPairingSession: (input) => managedSessionService.detachManagedPairingSession(input),
  attachManagedLocalSession: (input) => managedSessionService.attachManagedLocalSession(input),
  detachManagedLocalSession: (input) => managedSessionService.detachManagedLocalSession(input),
  ensureLocalSessionEndpointOnline,
  persistEndpoint,
});

const localEndpointResolver = new BrokerLocalEndpointResolver({
  nodeId,
  runtime,
  isLocalAgentEndpointAlive,
  isLocalAgentEndpointAliveAsync,
  ensureLocalSessionEndpointOnline,
  observeLocalEndpointSession: observeLocalAgentEndpointSession,
  ensureLocalAgentBindingOnline,
  createIsolatedAgentEndpoint: createIsolatedAgentEndpointForInvocation,
  upsertActor: upsertActorDurably,
  upsertAgent: upsertAgentDurably,
  persistEndpoint,
});

const messageService = new BrokerMessageService({
  nodeId,
  systemActorId: systemActor.id,
  runtime,
  mesh: meshForwardingService,
  createId: createRuntimeId,
  recordMessage: recordMessageDurably,
  applyProjectedEntries,
  reconcileStaleLocalDeliveries,
  persistFlight,
  persistAcceptedReply: (invocation, receipt, eligible) => runDurableWrite(async () => {
    if (!eligible()) return;
    const current = runtime.flightForInvocation(invocation.id);
    if (!current || !isWorkingFlightState(current.state)
      || !isFinalReplyForInvocation(receipt.message, invocation)
      || !externalSessionService.authorizesReplyCompletion(invocation, receipt.message)
      || !t3Service.authorizesReplyCompletion(invocation, receipt.message)) return;
    if (current.metadata?.acceptedReply !== undefined) return;
    // Store only the authority acknowledgement, not a local message or delivery.
    // Its exact reply survives a subsequent completion-write failure/restart.
    const flight = { ...current, metadata: { ...current.metadata, acceptedReply: receipt } };
    await commitDurableEntries({ kind: "flight.record", flight }, async () => { await runtime.upsertFlight(flight); });
  }),
  completionCurrentFlight: id => journal.getCurrentFlightForInvocation(id),
  completionFlight: id => journal.getFlight(id),
  authorizeReplyCompletion: (invocation, reply) => externalSessionService.authorizesReplyCompletion(invocation, reply) && t3Service.authorizesReplyCompletion(invocation, reply),
  activeLocalEndpointForAgent: (agentId) => localEndpointResolver.activeLocalEndpointForAgent(agentId),
});

const replyCompletionRecovery = new BrokerReplyCompletionRecovery({
  flights: function* () {
    for (const flight of Object.values(runtime.peek().flights)) {
      if (isWorkingFlightState(flight.state)) yield flight;
    }
  },
  invocation: (id) => knownInvocations.get(id),
  recoverReply: (invocation) => messageService.recoverInvocationReply(invocation),
  warn: (id, error) => console.warn(`[openscout-runtime] accepted reply recovery held ${id}:`, error),
});

const externalSessionService = new BrokerExternalSessionService({
  nodeId,
  connections: () => externalSessionConnections(process.env),
  transport: (connection) => devinSessionTransport(connection),
  endpoints: () => Object.values(runtime.snapshot().endpoints),
  agent: (id) => runtime.agent(id),
  actor: (id) => runtime.actor(id),
  persistActor: upsertActorDurably,
  visitDeliveries: (visitor) => journal.visitDeliveries(visitor),
  invocations: () => knownInvocations.values(),
  persistEndpoint,
  delivery: (id) => journal.getDelivery(id),
  recordDelivery: async (delivery) => {
    await recordDeliveryDurably(delivery);
    if (delivery.transport === "mcp_poll" && delivery.status === "accepted") {
      // The hint carries ids, not content: keep the mailbox body off the control stream.
      const { mailboxBody: _body, ...metadata } = delivery.metadata ?? {};
      controlStreams.streamEvent({
        id: createRuntimeId("evt"), kind: "delivery.state.changed", ts: Date.now(),
        actorId: "system", nodeId, payload: { delivery: { ...delivery, metadata }, previousStatus: undefined },
      });
    }
  },
  mutateDelivery: deliveryStore.mutateDelivery,
  invocation: (id) => knownInvocations.get(id),
  flight: (id) => runtime.flightForInvocation(id),
  recordFlight: recordFlightDurably,
  postMessage: postConversationMessage,
});

const t3Service = new BrokerT3Service({
  nodeId,
  endpoints: () => Object.values(runtime.snapshot().endpoints),
  persistEndpoint,
  persistActor: upsertActorDurably,
  recordWork: recordCollaborationDurably,
  work: id => runtime.collaborationRecord(id),
  delivery: id => journal.getDelivery(id),
  recordDelivery: recordDeliveryDurably,
  mutateDelivery: deliveryStore.mutateDelivery,
  flight: id => runtime.flightForInvocation(id),
  recordFlight: recordFlightDurably,
  postMessage: postConversationMessage,
  deliver: request => deliveryAcceptanceService.accept(request),
});

const terminalReportDeliveryService = new BrokerTerminalReportDeliveryService({
  nodeId,
  flightById: (id) => journal.getFlight(id),
  quarantineRecord: (entry, reason) => projection.quarantineRecord(entry, reason),
  postMessage: postConversationMessage,
  markDelivered: (flightId, expected) => durableStore.runWrite(async () => {
    const current = journal.getFlight(flightId);
    if (!current || !matchesPendingTerminalReport(current, expected)) return false;
    const flight: FlightRecord = { ...current, metadata: { ...current.metadata,
      terminalReport: { ...expected, status: "delivered", deliveredAt: Date.now() },
    } };
    await durableStore.commitEntries({ kind: "flight.record", flight, preserveCurrent: true }, async () => {
      await runtime.upsertFlight(flight, { preserveCurrent: true });
    });
    return true;
  }),
  warn: (message, error) => console.warn(message, error),
});
let terminalReportRecoveryFlights: Iterator<FlightRecord> | undefined;
function recoverTerminalReports(): void {
  terminalReportRecoveryFlights ??= journal.pendingTerminalReports();
  let scanned = 0;
  while (scanned < 256 && terminalReportDeliveryService.availableCapacity > 0) {
    const next = terminalReportRecoveryFlights.next();
    if (next.done) { terminalReportRecoveryFlights = undefined; break; }
    scanned++;
    void terminalReportDeliveryService.deliver(next.value.id);
  }
}

const invocationResultDeliveryService = new BrokerInvocationResultDeliveryService({
  flightForInvocation: (id) => runtime.flightForInvocation(id),
  quarantineRecord: (entry, reason) => projection.quarantineRecord(entry, reason),
  postMessage: postConversationMessage,
  markDelivered: (invocationId, expected) => durableStore.runWrite(async () => {
    const current = runtime.flightForInvocation(invocationId);
    if (!current || !matchesPendingInvocationResultReply(current, expected)) return false;
    const flight: FlightRecord = { ...current, metadata: {
      ...current.metadata, resultReply: { ...expected, status: "delivered", deliveredAt: Date.now() },
    } };
    await durableStore.commitEntries({ kind: "flight.record", flight }, async () => { await runtime.upsertFlight(flight); });
    return true;
  }),
  warn: (message, error) => console.warn(message, error),
});
let resultRecoveryFlights: Iterator<FlightRecord> | undefined;
function recoverInvocationResultReplies(): void {
  resultRecoveryFlights ??= journal.pendingInvocationResultFlights();
  let scanned = 0;
  while (scanned < 256 && invocationResultDeliveryService.availableCapacity > 0) {
    const next = resultRecoveryFlights.next();
    if (next.done) { resultRecoveryFlights = undefined; break; }
    scanned += 1;
    void invocationResultDeliveryService.deliver(next.value.invocationId);
  }
}

const localInvocationService = new BrokerLocalInvocationService({
  nodeId,
  runtime,
  endpointResolver: localEndpointResolver,
  activeInvocationTasks,
  transitionInvocation,
  persistEndpoint,
  persistEndpointWithoutRecovery: upsertEndpointDurably,
  // Lazily bound: dispatchRecoveryService is constructed later in this module,
  // and deferral only fires during dispatch, long after initialization.
  deferInvocationRetry: (invocationId, notBeforeTs) =>
    dispatchRecoveryService.deferInvocation(invocationId, notBeforeTs),
  postInvocationStatusMessage,
  deliverInvocationResult: (invocationId) => invocationResultDeliveryService.deliver(invocationId),
  existingBrokerReplyForInvocation,
  completeInvocationForBrokerReply,
  messageVisibilityForConversation,
  scoutbotReplyProvenanceMetadata,
  invokePairingSessionEndpoint,
  invokeA2AHttpEndpoint,
  invokeLocalAgentEndpoint,
  error: (message, detail) => console.error(message, detail),
  warn: (message) => console.warn(message),
});

const localAgentSyncService = new BrokerLocalAgentSyncService({
  nodeId,
  configuredCoreAgentIds,
  runtime,
  registrySignature: readRelayAgentRegistrySignature,
  migrateRelayAgentKeys: migrateUnqualifiedRelayAgentKeys,
  readRelayAgentOverrides,
  loadRegisteredLocalAgentBindings,
  clearGitBranchCache,
  isGeneratedLocalAgentMetadata,
  isLocalAgentEndpointAlive,
  isLocalAgentEndpointAliveAsync,
  isLocalAgentSessionAlive,
  isLocalAgentSessionAliveAsync,
  shouldDisableGeneratedCodexEndpoint,
  upsertActor: upsertActorDurably,
  upsertAgent: upsertAgentDurably,
  persistEndpoint,
  retireLegacyPairingSessionAgents: () => managedSessionService.retireLegacyPairingSessionAgents(),
  reconcileManagedPairingEndpoints: () => managedSessionService.reconcileManagedPairingEndpoints(),
  reconcileStaleWorkingFlights,
  reconcileStaleLocalDeliveries,
  log: (message) => console.log(message),
});

// Prime required bootstrap identities in memory before routes are built. Their
// journal/SQLite write runs after the listeners bind, so replaying a large
// pilot journal cannot make launchd report a dead broker for several minutes.
await runtime.upsertNode(localNode);
await runtime.upsertActor(systemActor);

function operatorActorDisplayName(): string {
  return resolveOperatorName().trim() || operatorActorId;
}

function brokerActorDisplayName(snapshot: ReturnType<typeof runtime.snapshot>, actorId: string): string {
  return resolveBrokerActorDisplayName(snapshot, actorId, {
    operatorActorId,
    operatorDisplayName: operatorActorDisplayName(),
  });
}

async function createCardlessProjectSessionForDelivery(input: {
  projectPath: string;
  execution?: InvocationRequest["execution"];
  projectAgent?: { handle?: string };
  requesterId: string;
  createdAt: number;
}) {
  void input.requesterId;
  void input.createdAt;
  const projectRoot = resolve(expandHomePath(input.projectPath));
  const requestedHarness = input.execution?.harness;
  const { harness, transport } = resolveCardlessSessionSpawnTarget(requestedHarness, {
    claudeTransport: process.env.OPENSCOUT_CLAUDE_CARDLESS_TRANSPORT,
    cwd: projectRoot,
  });
  const reasoningEffort = input.execution?.reasoningEffort?.trim();
  // Grok carries effort over ACP on `session/set_model`; Kimi exposes no
  // equivalent, so it stays a hard rejection there.
  if (reasoningEffort && harness === "kimi") {
    throw new Error(
      "kimi runtime profile does not support reasoning effort through its ACP transport",
    );
  }
  const launchArgs = launchArgsForCardlessSession(harness, input.execution);
  const sessionId = createRuntimeId("session");
  const projectName = basename(projectRoot) || projectRoot;
  const snapshot = runtime.snapshot();
  const projectSessionIndex = Object.values(snapshot.endpoints).filter((endpoint) => {
    const endpointProjectRoot = endpoint.projectRoot
      ?? (typeof endpoint.metadata?.projectRoot === "string" ? endpoint.metadata.projectRoot : undefined)
      ?? endpoint.cwd;
    return endpoint.metadata?.cardless === true
      && endpoint.harness === harness
      && Boolean(endpointProjectRoot)
      && resolve(expandHomePath(endpointProjectRoot!)) === projectRoot;
  }).length;
  const occupied = collectOccupiedDefinitionIdsFromBrokerSnapshot(snapshot);
  const requestedHandle = input.projectAgent?.handle?.trim();
  const provisionalName = resolveProjectProvisionalAgentName({
    explicitName: requestedHandle,
    occupied,
    seedParts: [
      "cardless-project-session",
      input.requesterId,
      projectRoot,
      harness,
      projectSessionIndex,
    ],
  });
  const registered = await registerCardlessSession({
    upsertActor: upsertActorDurably,
    upsertEndpoint: persistEndpoint,
  }, {
    sessionId,
    handle: provisionalName,
    transport,
    harness,
    cwd: projectRoot,
    projectRoot,
    nodeId,
    ...(input.execution?.model?.trim() ? { model: input.execution.model.trim() } : {}),
    ...(input.execution?.reasoningEffort?.trim() ? { reasoningEffort: input.execution.reasoningEffort.trim() } : {}),
    ...(input.execution?.placement ? { placement: input.execution.placement } : {}),
    ...(launchArgs.length > 0 ? { launchArgs } : {}),
  });
  const endpoint = runtime.snapshot().endpoints[registered.endpointId];
  if (!endpoint) {
    throw new Error(`cardless session endpoint ${registered.endpointId} was not registered`);
  }
  return {
    kind: "resolved_session" as const,
    session: {
      sessionId: registered.sessionId,
      actorId: registered.actorId,
      endpoint,
      label: cardlessSessionDisplayName({ handle: provisionalName, projectName }),
      nodeId: endpoint.nodeId,
    },
  };
}

/** Trusted, reachable peers in this mesh — the only nodes a session may be woken or started on. */
function trustedReachableMeshPeers() {
  const trustedNodeIds = new Set(
    trustedPeerStore?.listTrustedPeers().flatMap((peer) => peer.nodeId ? [peer.nodeId] : []) ?? [],
  );
  return Object.values(runtime.snapshot().nodes).filter((node) =>
    node.id !== nodeId
    && node.meshId === meshId
    && trustedNodeIds.has(node.id)
    && isReachableMeshNode(node)
  );
}

function isLocalDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Project-path asks start a new session where the project lives. A path that
 * exists here starts locally; otherwise trusted peers are asked (most likely
 * owner first) and the winning peer-owned endpoint is adopted, so dispatch
 * forwards the invocation to that machine.
 */
async function createProjectSessionForDelivery(
  input: Parameters<typeof createCardlessProjectSessionForDelivery>[0] & { host?: string },
) {
  const { host, ...localInput } = input;
  let onlyPeer: NodeDefinition | undefined;
  if (host?.trim()) {
    const snapshot = runtime.snapshot();
    const resolution = resolveMeshHost({
      host,
      localNode: snapshot.nodes[nodeId],
      nodes: Object.values(snapshot.nodes).filter((node) => node.meshId === meshId),
      trustedNodeIds: new Set(trustedPeerStore?.listTrustedPeers().flatMap((peer) => peer.nodeId ? [peer.nodeId] : []) ?? []),
      isReachable: isReachableMeshNode,
    });
    // Host resolution precedes every effect of this request: no actor, conversation,
    // message, session or peer call exists yet. Only the idempotent local-agent
    // registry refresh has run, which is not caused by this request. So these
    // refusals are pre-effect, and the same request ID may be retried once fixed.
    if (resolution.kind === "local") {
      if (!isLocalDirectory(resolve(expandHomePath(input.projectPath)))) {
        throw new RetryablePreEffectFailure(`--on ${host} is this machine, and ${input.projectPath} is not a folder here.`);
      }
      return createCardlessProjectSessionForDelivery(localInput);
    }
    if (resolution.kind === "ambiguous") {
      throw new RetryablePreEffectFailure(
        `--on ${host} matches more than one machine: `
        + resolution.nodes.map((node) => `${scoutSessionHostForNode(node)} (${node.id}${node.id === nodeId ? ", this machine" : ""})`).join(", ")
        + ". Use the node id with --on.",
      );
    }
    if (resolution.kind === "unknown") {
      throw new RetryablePreEffectFailure(
        `--on ${host}: no mesh machine by that name.`
        + (resolution.knownHosts.length ? ` Known machines: ${resolution.knownHosts.join(", ")}.` : " This broker knows no mesh peers yet.")
        + " See them with `scout machines`.",
      );
    }
    if (resolution.kind === "not_trusted") {
      throw new RetryablePreEffectFailure(
        `--on ${host}: ${scoutSessionHostForNode(resolution.node)} is in the mesh but not a trusted peer, so Scout will not start work there. `
        + "The operator can enroll it with `scout mesh enroll`.",
      );
    }
    if (resolution.kind === "unreachable") {
      throw new RetryablePreEffectFailure(
        `--on ${host}: ${scoutSessionHostForNode(resolution.node)} is trusted but not reachable right now`
        + (resolution.node.lastSeenAt ? ` (last seen ${new Date(resolution.node.lastSeenAt).toISOString()})` : "")
        + ". Check it with `scout mesh peers`.",
      );
    }
    onlyPeer = resolution.node;
  } else {
    const projectRoot = resolve(expandHomePath(input.projectPath));
    if (isLocalDirectory(projectRoot)) {
      return createCardlessProjectSessionForDelivery(localInput);
    }
  }
  const execution = input.execution;
  const request: MeshProjectSessionStartInput = {
    projectPath: input.projectPath.trim(),
    ...(execution?.harness ? { harness: execution.harness } : {}),
    ...(execution?.model?.trim() ? { model: execution.model.trim() } : {}),
    ...(execution?.reasoningEffort?.trim() ? { reasoningEffort: execution.reasoningEffort.trim() } : {}),
    ...(execution?.placement ? { placement: execution.placement } : {}),
    requesterId: input.requesterId,
  };
  const snapshot = runtime.snapshot();
  const started = await startSessionOnPeers({
    localNodeId: nodeId,
    peers: onlyPeer ? [onlyPeer] : trustedReachableMeshPeers(),
    peerProjectRoots: (peerNodeId) => Object.values(snapshot.agents).flatMap((agent) => {
      const root = agent.homeNodeId === peerNodeId ? agent.metadata?.projectRoot : undefined;
      return typeof root === "string" && root.trim() ? [root.trim()] : [];
    }),
    postJson: (brokerBaseUrl, path, payload) => postMeshPeerJson(brokerBaseUrl, path, payload, daemonMeshPeerFetch),
    registry: { upsertActor: upsertActorDurably, upsertEndpoint: persistEndpoint },
    log: (message) => console.log(message),
  }, request);
  if (!started.ok) {
    if (onlyPeer) {
      const failure = started.failures[0];
      throw new Error(
        `--on ${host}: ${scoutSessionHostForNode(onlyPeer)} could not start a session in ${input.projectPath}`
        + (failure?.detail ? `: ${failure.detail}` : failure?.reason ? ` (${failure.reason})` : "")
        + ".",
      );
    }
    const peerRootsNow = (peerNodeId: string) => Object.values(runtime.snapshot().agents).flatMap((agent) => {
      const root = agent.homeNodeId === peerNodeId ? agent.metadata?.projectRoot : undefined;
      return typeof root === "string" && root.trim() ? [root.trim()] : [];
    });
    const suggestion = suggestHostForProjectPath(
      input.projectPath,
      Object.values(runtime.snapshot().nodes).filter((node) => node.id !== nodeId),
      peerRootsNow,
    );
    const peerNotes = started.failures
      .filter((failure) => failure.reason !== "project_unknown")
      .map((failure) => `${failure.host}: ${failure.detail || failure.reason}`);
    throw new Error(
      `project path ${input.projectPath} does not exist on this node`
      + (started.peersTried > 0
        ? `, and none of ${started.peersTried} trusted mesh peer(s) could start a session there`
        : ", and no trusted mesh peer is reachable")
      + (peerNotes.length ? ` (${peerNotes.join("; ")})` : "")
      + (suggestion
        ? `. ${suggestion.root} is on ${suggestion.host}: add \`--on ${suggestion.host} --project ${suggestion.root}\`.`
        : ". To name the machine, add `--on <host>` (machines and their projects: `scout hosts`)."),
    );
  }
  const endpoint = runtime.snapshot().endpoints[started.endpoint.id] ?? started.endpoint;
  const projectName = basename(input.projectPath.trim()) || input.projectPath;
  return {
    kind: "resolved_session" as const,
    session: {
      sessionId: endpoint.sessionId ?? started.endpoint.id,
      actorId: endpoint.agentId,
      endpoint,
      label: cardlessSessionDisplayName({
        handle: started.actor?.displayName?.trim() || endpoint.agentId,
        projectName,
      }),
      nodeId: endpoint.nodeId,
    },
  };
}

/** Peer side of mesh session start: start locally only, never fan out. */
async function startMeshProjectSessionForPeer(input: MeshProjectSessionStartInput) {
  const projectRoot = resolve(expandHomePath(input.projectPath));
  if (!isLocalDirectory(projectRoot)) {
    return {
      ok: false as const,
      reason: "project_unknown",
      detail: `project path ${input.projectPath} does not exist on ${nodeId}`,
    };
  }
  // Peer-supplied harness rides in as a plain string; only a known kind narrows.
  const harness = input.harness && (AGENT_HARNESSES as readonly string[]).includes(input.harness)
    ? input.harness as AgentHarness
    : undefined;
  const placement = input.placement === "foreground" || input.placement === "background"
    ? input.placement
    : undefined;
  try {
    const resolved = await createCardlessProjectSessionForDelivery({
      projectPath: projectRoot,
      execution: {
        ...(harness ? { harness } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        ...(placement ? { placement } : {}),
      } as InvocationRequest["execution"],
      requesterId: input.requesterId?.trim() || "mesh-peer",
      createdAt: Date.now(),
    });
    const actor = runtime.snapshot().actors[resolved.session.actorId];
    return {
      ok: true as const,
      endpoint: resolved.session.endpoint,
      ...(actor ? { actor } : {}),
    };
  } catch (error) {
    return {
      ok: false as const,
      reason: "start_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function launchArgsForCardlessSession(
  harness: AgentHarness,
  execution: InvocationRequest["execution"] | undefined,
): string[] {
  const model = execution?.model?.trim();
  const reasoningEffort = execution?.reasoningEffort?.trim();
  if (harness === "codex") {
    return normalizeCodexAppServerLaunchArgs([
      ...(model ? ["--model", model] : []),
      ...(reasoningEffort ? ["--reasoning-effort", reasoningEffort] : []),
    ]);
  }
  if (harness === "claude") {
    return [
      ...(model ? ["--model", model] : []),
      ...(reasoningEffort ? ["--effort", reasoningEffort] : []),
    ];
  }
  if (harness === "grok") {
    return [
      ...(model ? ["--model", model] : []),
      ...(reasoningEffort ? ["--reasoning-effort", reasoningEffort] : []),
    ];
  }
  if (harness === "pi") {
    return [
      ...(model ? ["--model", model] : []),
      ...(reasoningEffort ? ["--thinking", reasoningEffort === "none" ? "off" : reasoningEffort] : []),
    ];
  }
  return [];
}

async function createIsolatedAgentEndpointForInvocation(
  invocation: InvocationRequest,
): Promise<AgentEndpoint | null> {
  const agent = runtime.agent(invocation.targetAgentId);
  // Session-kind targets have no AgentDefinition. They already own an
  // isolated endpoint, so the resolver may continue with that endpoint.
  if (!agent) return null;

  const requestedHarness = invocation.execution?.harness;
  const candidateEndpoints = runtime.endpointsForAgent(agent.id, {
    nodeId,
    ...(requestedHarness ? { harness: requestedHarness } : {}),
  });
  const baseEndpoint = (agent.id === "scoutbot"
    ? candidateEndpoints.find((endpoint) => endpoint.metadata?.source === "scoutbot")
    : candidateEndpoints[0])
    ?? runtime.endpointsForAgent(agent.id, { nodeId })[0]
    ?? null;
  const projectRoot = brokerTargetProjectRoot(agent, baseEndpoint);
  if (!projectRoot) {
    throw new Error(
      `isolated_runtime_unavailable: ${brokerTargetLabel(agent)} has no project root from which to spawn an isolated session`,
    );
  }

  const { harness, transport } = resolveCardlessSessionSpawnTarget(
    requestedHarness ?? baseEndpoint?.harness,
    { claudeTransport: process.env.OPENSCOUT_CLAUDE_CARDLESS_TRANSPORT, cwd: projectRoot },
  );
  const sessionId = createRuntimeId("session");
  const launchArgs = launchArgsForCardlessSession(harness, invocation.execution);
  const definitionId = agent.definitionId || agent.id;
  const isolatedAgentName = `${definitionId}-isolated-${sessionId.slice(-8)}`;
  const sessionEndpoint = buildCardlessSessionEndpoint({
    sessionId,
    handle: isolatedAgentName,
    displayName: `${agent.displayName} (isolated)`,
    transport,
    harness,
    cwd: projectRoot,
    projectRoot,
    nodeId,
    ...(invocation.execution?.model?.trim() ? { model: invocation.execution.model.trim() } : {}),
    ...(invocation.execution?.reasoningEffort?.trim()
      ? { reasoningEffort: invocation.execution.reasoningEffort.trim() }
      : {}),
    ...(invocation.execution?.placement ? { placement: invocation.execution.placement } : {}),
    ...(launchArgs.length > 0 ? { launchArgs } : {}),
    viaCard: definitionId,
  });
  return {
    ...sessionEndpoint,
    id: `endpoint.${agent.id}.${sessionId}.${nodeId}.${transport}`,
    agentId: agent.id,
    metadata: {
      ...(sessionEndpoint.metadata ?? {}),
      source: "scout-isolated-agent-session",
      ...isolatedCodexPermissionMetadata(harness, baseEndpoint, invocation.execution?.permissionProfile),
      ...scoutbotIsolationMetadata(baseEndpoint, invocation.execution, launchArgs),
      cardless: false,
      isolatedExecution: true,
      definitionId,
      agentName: isolatedAgentName,
      runtimeInstanceId: sessionId,
      ...(invocation.executionResolution
        ? { executionResolution: invocation.executionResolution }
        : {}),
    },
  };
}

async function ensureBrokerActorForDelivery(actorId: string): Promise<void> {
  await conversationService.ensureActorForDelivery(actorId);
}

async function ensureBrokerDeliveryConversation(input: {
  requesterId: string;
  targetAgentId?: string;
  channel?: string;
}): Promise<ConversationDefinition> {
  return await conversationService.ensureDeliveryConversation(input);
}

async function reconcileStaleWorkingFlights(): Promise<void> {
  await flightLifecycleService.reconcileStaleWorkingFlights();
}

async function syncRegisteredLocalAgents(): Promise<void> {
  await localAgentSyncService.sync();
}

async function postConversationMessage(
  message: MessageRecord,
): Promise<{
  ok: true;
  message: MessageRecord;
  deliveries: DeliveryIntent[];
  forwarded?: true;
  authorityNodeId?: string;
  duplicate?: boolean;
}> {
  const result = await messageService.postConversationMessage(message);
  if (message.actorId === operatorActorId && message.replyToMessageId) {
    const record = runtime.collaborationRecord(`operator-question:${message.replyToMessageId}`);
    if (record?.kind === "question" && record.state === "open" && record.conversationId === message.conversationId) {
      await recordCollaborationDurably({ ...record, state: "closed", answer: message.body,
        answeredById: operatorActorId, answeredAt: message.createdAt, closedAt: message.createdAt,
        nextMoveOwnerId: undefined, updatedAt: message.createdAt });
    }
  }
  return result;
}

async function postInvocationStatusMessage(
  invocation: InvocationRequest,
  flight: {
    id?: string;
    summary?: string;
    error?: string;
  },
): Promise<void> {
  // Terminal reports are already journaled with the outcome. Every legacy
  // failure callsite joins that outbox; it must not mint a second status message.
  if (flight.id) {
    const current = runtime.flight(flight.id);
    if (current?.state === "failed" || current?.state === "cancelled") {
      await terminalReportDeliveryService.deliver(current.id);
      return;
    }
  }
  await messageService.postInvocationStatusMessage(invocation, flight);
}

async function existingBrokerReplyForInvocation(
  invocation: InvocationRequest,
  agentId: string,
  sinceMs: number,
): Promise<MessageRecord | null> {
  return messageService.existingBrokerReplyForInvocation(invocation, agentId, sinceMs);
}

async function completeInvocationForBrokerReply(
  invocation: InvocationRequest,
  reply: MessageRecord,
): Promise<boolean> {
  return await messageService.completeInvocationForBrokerReply(invocation, reply);
}

function onlineConversationNotifyTargets(
  conversation: ConversationDefinition,
  requesterId: string,
): string[] {
  return messageService.onlineConversationNotifyTargets(conversation, requesterId);
}

async function probeExistingBroker() {
  try {
    const [health, node] = await Promise.all([
      requestScoutBrokerJson<{
        ok?: boolean;
        nodeId?: string;
        meshId?: string;
      }>(brokerUrl, "/health", { socketPath: brokerSocketPath }),
      requestScoutBrokerJson<NodeDefinition>(brokerUrl, "/v1/node", { socketPath: brokerSocketPath }),
    ]);

    if (!health.ok || !node.id) {
      return null;
    }

    return {
      nodeId: node.id,
      meshId: node.meshId ?? health.meshId,
      brokerUrl: node.brokerUrl ?? brokerUrl,
    };
  } catch {
    return null;
  }
}

async function handleCommand(command: ControlCommand): Promise<unknown> {
  return await commandService.execute(command);
}

async function handleInvocationRequest(
  payload: InvocationRequest & BrokerRouteTargetInput,
) {
  return await invocationDispatchService.handleInvocationRequest(payload);
}

async function acceptInvocationDurably(invocation: InvocationRequest, message?: MessageRecord, workItem?: import("./broker-work-item-store.js").DeliveryWorkItemResolution["pendingCreation"]): Promise<FlightRecord> {
  // A remote authority owns its conversation. Preserve the mesh forwarding
  // boundary; only local records can share this broker's atomic transaction.
  let receiptMessage: MessageRecord | undefined;
  if (message && meshForwardingService.authorityNodeForConversation(message.conversationId)) {
    await postConversationMessage(message);
    receiptMessage = message;
    message = undefined;
  }
  const { flight } = await invocationDispatchService.acceptInvocation(invocation, message, workItem, receiptMessage);
  return flight;
}

async function dispatchAcceptedInvocation(invocation: InvocationRequest): Promise<void> {
  const job = journal.getInvocationDispatchJobForInvocation(invocation.id);
  if (job) {
    await invocationDispatchService.runDispatchJob(job, invocation);
    return;
  }
  await invocationDispatchService.dispatchAcceptedInvocation(invocation);
}

async function failAcceptedInvocation(invocation: InvocationRequest, detail: string): Promise<void> {
  await invocationDispatchService.failAcceptedInvocation(invocation, detail);
}

const peerDelivery: PeerDeliveryWorker = createPeerDeliveryWorker({
  flightForInvocation: (id) => runtime.flightForInvocation(id),
  journal,
  snapshot: () => runtime.peek(),
  localNode: currentLocalNode,
  localNodeId: nodeId,
  nodeFor: (id) => runtime.node(id),
  agentFor: (id) => runtime.agent(id),
  invocationFor: (id) => knownInvocations.get(id),
  recordDelivery: recordDeliveryDurably,
  updateDeliveryStatus: updateDeliveryStatusDurably,
  recordDeliveryAttempt: recordDeliveryAttemptDurably,
  recordFlight: recordFlightDurably,
  failInvocation: failAcceptedInvocation,
  emit: (event) => controlStreams.streamEvent(event),
  peerFetch: daemonMeshPeerFetch,
});

const invocationDispatchService = new BrokerInvocationDispatchService({
  nodeId,
  runtime,
  createId: createRuntimeId,
  syncRegisteredLocalAgentsIfChanged,
  resolveInvocationTarget,
  recordScoutDispatch: recordScoutDispatchDurably,
  recordInvocation: recordInvocationDurably,
  recordInvocationDispatchJob: recordInvocationDispatchJobDurably,
  recordInvocationDispatchJobIf: durableRecords.recordInvocationDispatchJobIf,
  applyProjectedEntries,
  recordFlight: recordFlightDurably,
  postInvocationStatusMessage,
  describeRemoteAuthorityIssue: (agent, authorityNode) =>
    meshForwardingService.describeRemoteAuthorityIssue(agent, authorityNode),
  describeUnavailableInvocationTarget: (snapshot, agent, targetSessionId) =>
    unavailableTargetService.describe(snapshot, agent, targetSessionId),
  buildUnavailableDispatchEnvelope: (askedLabel, unavailable) =>
    unavailableTargetService.buildEnvelope(askedLabel, unavailable),
  enqueuePeerInvocation: async (invocation, authorityNode) => {
    await peerDelivery.enqueue(invocation, authorityNode);
  },
  launchLocalInvocation: (invocation) => {
    const t3Endpoint = t3Service.endpointFor(invocation);
    if (t3Endpoint) {
      void t3Service.dispatch(invocation, t3Endpoint).catch(async error => {
        const code = error instanceof Error && /^t3_[a-zA-Z0-9_]+$/.test(error.message) ? error.message : "t3_dispatch_rejected";
        await transitionInvocation(invocation.id, { state: "failed", error: code, completedAt: Date.now() });
      }).catch(error => console.error("[openscout-runtime] T3 dispatch failed", error));
      return;
    }
    const endpoint = externalSessionService.endpointFor(invocation);
    if (!endpoint) { localInvocationService.launch(invocation); return; }
    void externalSessionService.dispatch(invocation, endpoint).catch(async (error) => {
      await transitionInvocation(invocation.id, { state: "failed", error: error instanceof Error ? error.message : "external_dispatch_failed", completedAt: Date.now() });
    }).catch((error) => console.error("[openscout-runtime] external session dispatch failed", error));
  },
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message, detail) => console.error(message, detail),
});

const dispatchRecoveryService = new BrokerDispatchRecoveryService({
  runtimeSnapshot: () => runtime.snapshot(),
  dispatchJobs: () => journal.listRecoverableInvocationDispatchJobs({ limit: 5000 }),
  dispatchJobForInvocation: (invocationId) => journal.getInvocationDispatchJobForInvocation(invocationId),
  invocationFor: (invocationId) => knownInvocations.get(invocationId),
  isInvocationActive: (invocationId) => flightCompletion(runtime.flightForInvocation(invocationId))?.awaitingFinal === true
    || replyCompletionRecovery.isPending(invocationId)
    || localInvocationService.hasActiveInvocation(invocationId) || externalSessionService.hasPendingInvocation(invocationId)
    || t3Service.hasPendingInvocation(invocationId),
  runDispatchJob: (job, invocation) => invocationDispatchService.runDispatchJob(job, invocation),
  requeueDispatchJob: (job, invocation, flight) => invocationDispatchService.requeueDispatchJob(job, invocation, flight),
  dispatchAcceptedInvocation: (invocation) => invocationDispatchService.dispatchAcceptedInvocation(invocation),
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
});

const channelInviteService = new BrokerChannelInviteService({
  runtime,
  updateConversation: durableRecords.updateConversation,
});

const commandService = new BrokerCommandService({
  runtime,
  channelInvites: channelInviteService,
  mesh: meshForwardingService,
  upsertNode: upsertNodeDurably,
  upsertActor: upsertActorDurably,
  upsertAgent: upsertAgentDurably,
  persistEndpoint,
  upsertConversation: upsertConversationDurably,
  upsertBinding: upsertBindingDurably,
  recordCollaboration: recordCollaborationDurably,
  appendCollaborationEvent: appendCollaborationEventDurably,
  recordMessage: recordMessageDurably,
  applyProjectedEntries,
  reconcileStaleLocalDeliveries,
  acceptAndDispatchInvocation: (invocation, options) =>
    invocationDispatchService.acceptAndDispatch(invocation, options),
  log: (message) => console.log(message),
});

const operatorAttentionService = new BrokerOperatorAttentionService({
  nodeId,
  systemActorId: systemActor.id,
  operatorActorId,
  createId: createRuntimeId,
  ensureBrokerActorForDelivery,
  ensureBrokerDeliveryConversation,
  conversationById: (conversationId) => runtime.conversation(conversationId),
  messageVisibilityForConversation,
  postConversationMessage,
  broadcastApnsAlertToActiveMobileDevices,
  warn: (message) => console.warn(message),
});

const permissionService = new BrokerPermissionService({
  operatorId: operatorActorId,
  createId: () => createRuntimeId("permission"),
  record: recordCollaborationDurably,
  read: id => { const record = runtime.collaborationRecord(id); return record?.kind === "question" ? record : undefined; },
  flight: id => runtime.flightForInvocation(id),
  transition: (id, state, requestId) => transitionInvocation(id, {
    state, summary: requestId ? "Waiting on permission" : "Permission wait resolved; continuing live session.",
    metadata: { permissionRequestId: requestId, waitingOnPermission: Boolean(requestId), nextMoveOwnerId: requestId ? operatorActorId : null },
  }),
  notify: (invocation, record, prompt) => operatorAttentionService.queueOperatorSignal({
    signal: { kind: "need", blocking: true, replyExpectation: "required", question: prompt.text, requestKind: "permission" },
    messageId: record.id, conversationId: invocation.conversationId!,
    requesterId: invocation.targetAgentId, requesterNodeId: nodeId,
    body: prompt.text, projectRoot: prompt.projectRoot, createdAt: record.createdAt,
  }),
});
configureManagedPermissionHandler((invocation, prompt) => permissionService.wait(invocation, prompt));

const unavailableTargetService = new BrokerUnavailableTargetService({
  nodeId,
  verifiedLaunchRoute: (agent, endpoint) => {
    if (agent.authorityNodeId !== nodeId || !endpoint || endpoint.nodeId !== nodeId) return null;
    const managed = endpoint.metadata?.source === "local-session" && endpoint.metadata?.managedByScout === true;
    const configured = agent.metadata?.source === "relay-agent-registry" || agent.metadata?.source === "project-inferred";
    if (!managed && !(configured && agent.wakePolicy !== "manual")) return null;
    if (endpoint.transport !== "tmux" && !isDirectLocalAgentTransport(endpoint.transport)) return null;
    const projectRoot = endpoint.projectRoot ?? endpoint.cwd;
    if (!projectRoot) return null;
    try { if (!statSync(projectRoot).isDirectory()) return null; } catch { return null; }
    if (!areHarnessBinariesAvailable({ harness: endpoint.harness, transport: endpoint.transport })) return null;
    return { projectRoot, harness: endpoint.harness };
  },
  isEndpointAlive: (endpoint) => localEndpointCanReceive(endpoint, isLocalAgentEndpointAlive),
  supportsQueue: (endpoint) => endpoint.nodeId === nodeId && localEndpointSupportsQueue(
    endpoint, candidate => localInvocationService.supportsQueuedEndpoint(candidate),
  ),
  describeRemoteAuthorityIssue: (agent, authorityNode) =>
    meshForwardingService.describeRemoteAuthorityIssue(agent, authorityNode),
});

const requestReceipts = new BrokerRequestReceipts();
const deliveryAcceptanceService = new BrokerDeliveryAcceptanceService({
  submitSessionInput: input => deliverInPlace({ ...input, requireExactHarness: true }),
  upsertSessionInputActor: upsertActorDurably,
  commandAdmission,
  readAcceptedMessage: async id => await runtime.readMessage(id) ?? (await projection.readMessages([id])).get(id),
  readAcceptedInvocation: async id => knownInvocations.get(id) ?? (await projection.readInvocations([id])).get(id),
  nodeId,
  operatorActorId,
  requestReceipts,
  runtimeSnapshot: () => runtime.snapshot(),
  readRuntimeCatalog: readBrokerRuntimeCatalogSnapshot,
  createId: createRuntimeId,
  syncRegisteredLocalAgentsIfChanged,
  metadataStringValue,
  messageRefCandidateForRouteTarget,
  resolveBrokerMessageRef: resolveBrokerMessageRefAsync,
  ensureBrokerActorForDelivery,
  ensureBrokerDeliveryConversation,
  brokerRouteKind,
  messageVisibilityForConversation,
  brokerActorDisplayName,
  brokerTargetLabel,
  homeEndpointForAgent,
  titleCaseName,
  buildBrokerReturnAddressForActor,
  isOperatorDeliveryTarget,
  isLocalScoutProductTarget,
  onlineConversationNotifyTargets,
  resolveBrokerDeliveryTargetWithImplicitProjectAgent,
  createCardlessProjectSession: createProjectSessionForDelivery,
  recordScoutDispatch: recordScoutDispatchDurably,
  describeUnavailableDeliveryTarget: (snapshot, agent, targetSessionId) =>
    unavailableTargetService.describe(snapshot, agent, targetSessionId),
  buildUnavailableDispatchEnvelope: (askedLabel, unavailable) =>
    unavailableTargetService.buildEnvelope(askedLabel, unavailable),
  recordDeliveryWorkItemIfNeeded,
  prepareDeliveryWorkItemIfNeeded: workItemStore.prepareDeliveryWorkItemIfNeeded,
  deliveryWorkItemResolutionForTell,
  postConversationMessage,
  acceptInvocation: acceptInvocationDurably,
  dispatchAcceptedInvocation,
  queueOperatorDeliveryIssue: (input) => operatorAttentionService.queueDeliveryIssue(input),
  recordOperatorNeed: async (message, signal) => {
    if (signal.kind !== "need" || runtime.collaborationRecord(`operator-question:${message.id}`)) return;
    await recordCollaborationDurably({
      id: `operator-question:${message.id}`, kind: "question", state: "open", acceptanceState: "none",
      title: signal.requestKind === "permission" ? "Permission request" : signal.question,
      summary: signal.question, createdById: message.actorId, askedById: message.actorId,
      ownerId: operatorActorId, nextMoveOwnerId: operatorActorId, conversationId: message.conversationId,
      createdAt: message.createdAt, updatedAt: message.createdAt,
      metadata: { operatorNeedMessageId: message.id, requestKind: signal.requestKind ?? "question" },
    });
  },
  queueOperatorSignal: (input) => operatorAttentionService.queueOperatorSignal(input),
  warn: (message, detail) => console.warn(message, detail),
});

const startupTrafficGate = new BrokerStartupTrafficGate(true);

const homeService = new BrokerHomeService({
  runtimeSnapshot: () => runtime.snapshot(),
  listActivityItems: (options) => projection.listActivityItems(options),
  projectionStatus: () => projection.statusSnapshot(),
  actorDisplayName: brokerActorDisplayName,
  operatorActorId,
});

const brokerService = createBrokerCoreService({
  baseUrl: brokerUrl,
  nodeId,
  meshId,
  localNode,
  runtime,
  projection,
  journal,
  threadEvents,
  isReconciledStaleFlightActivityItem,
  readChildServices: () => ({
    ...webControl.readChildServiceSnapshots(),
    ...(jetStreamService ? { jetstream: jetStreamService.status() } : {}),
  }),
  readProjectionStatus: () => projection.statusSnapshot(),
  readMemoryStatus: () => ({ storage: storageMonitor.status(), admission: commandAdmission.status(), requestReceipts: requestReceipts.status(), quarantine: projection.statusSnapshot().quarantine ?? null, journalCompaction: journal.liveCompactionStatus(), historyRotation: historyRotationPressure, storageMaintenance: storageMaintenance.status(), maintenance: memoryMaintenance?.status() ?? { enabled: false }, messageBodies: journal.messageBodyCacheStatus(), messageHistory: messageHistory?.status() ?? {enabled:false} }),
  readStartupStatus: () => ({ ...startupTrafficGate.snapshot(), journal: journal.startupStatus() }),
  readStorageStatus: () => ({ journal: journal.writeStatus() }),
  readHome: () => homeService.read(),
  // Observe-tier twin of the home feed: bounded, scoped to agents homed here,
  // and readable by a signed peer where /v1/home never is (mesh trust cone §4).
  readMeshNodeState: (query) => readMeshNodeState({
    snapshot: () => runtime.snapshot(),
    nodeId,
    meshId,
    actorDisplayName: brokerActorDisplayName,
  }, query),
  readCapabilities: readBrokerCapabilityMatrixSnapshot,
  readRuntimeCatalog: readBrokerRuntimeCatalogSnapshot,
  executeCommand: handleCommand,
  postConversationMessage,
  upsertMessageReaction: async (input) => {
    if (!sharedControlPlaneStore) {
      throw Object.assign(new Error("broker sqlite disabled"), { status: 503, reason: "sqlite_disabled" });
    }
    return sharedControlPlaneStore.get().upsertMessageReaction(input);
  },
  removeMessageReaction: async (input) => {
    if (!sharedControlPlaneStore) {
      throw Object.assign(new Error("broker sqlite disabled"), { status: 503, reason: "sqlite_disabled" });
    }
    return sharedControlPlaneStore.get().removeMessageReaction(input);
  },
  listMessageReactions: async (channelId) => {
    if (!sharedControlPlaneStore) return [];
    return sharedControlPlaneStore.get().listMessageReactions(channelId);
  },
  deliver: (payload, options) => deliveryAcceptanceService.accept(payload, options),
  invokeAgent: handleInvocationRequest,
});

const brokerRepoTailService = new BrokerRepoTailService({
  readBrokerSnapshot: async () => runtime.snapshot(),
  getRepoWatchSnapshot,
  repoWatchHintsFromBrokerSnapshot,
  repoWatchHintsFromTailDiscovery,
  getTailDiscovery,
  readRecentLiveEvents,
  readRecentTranscriptEvents,
  repoWatchServeCacheTtlMs,
  repoWatchRehydrateAfterMs,
  tailRecentServeCacheTtlMs,
  warn: (message) => console.warn(message),
});

const rendezvousService = new BrokerRendezvousService();

// Machine inventory (docs/eng/sco-104-machines.md). Shares the control-plane
// store with trusted peers; when that store is absent the service reports
// itself unavailable and its routes answer 503 rather than an empty roster.
const machineService = new BrokerMachineService({
  store: sharedControlPlaneStore,
  nodes: () => runtime.snapshot().nodes,
  localNodeId: nodeId,
  localHostName: hostname(),
});

const meshApprovalsConfigFile = meshApprovalsConfigPath(supportDirectory);
const readMeshApprovals = () => readMeshApprovalsConfig(meshApprovalsConfigFile);
const meshApprovalShare = createMeshApprovalShare({
  nodeId,
  listSnapshots: () => listPairingSessionSnapshots(),
  decide: (input) => decidePairingApproval(input),
  readConfig: readMeshApprovals,
  auditPath: join(supportDirectory, "logs", "mesh-approvals.log"),
});
const meshApprovalWatch = createMeshApprovalWatch({
  peerFetch: daemonMeshPeerFetch,
  readConfig: readMeshApprovals,
  listPeers: () => (trustedPeerStore?.listTrustedPeers() ?? []).flatMap((peer) => {
    if (peer.revokedAt || !peer.nodeId || peer.nodeId === nodeId) return [];
    if (peer.expiresAt && peer.expiresAt <= Date.now()) return [];
    const node = runtime.node(peer.nodeId);
    return [{ keyId: peer.keyId, nodeId: peer.nodeId, label: node?.name || peer.label, brokerUrl: node?.brokerUrl }];
  }),
});

const routeRequest = createBrokerHttpRouter({
  requestReceipts,
  deliveryReceiptsOwnedByService: true,
  readHistoricalInvocationSnapshot: id => projection.readInvocationSnapshot(id),
  historyQueries: { read: (kind, ids) => projection.readHistoricalRecords(kind, ids),
    page: options => projection.pageHistoricalRecords(options) },
  quarantineQueries: {
    status: () => projection.statusSnapshot().quarantine ?? { openCount: 0, acknowledgedCount: 0, samples: [] },
    list: options => projection.listQuarantine(options),
    read: id => projection.readQuarantine(id),
    acknowledge: id => projection.acknowledgeQuarantine(id),
  },
  mcpEvents,
  permissionService,
  meshApprovals: { share: meshApprovalShare, watch: meshApprovalWatch },
  encodedSnapshotBodies: process.env.OPENSCOUT_BROKER_ENCODED_SNAPSHOT === "1",
  onSnapshotFlushedBytes: memoryMaintenance ? (bytes) => memoryMaintenance.snapshotEncoded(bytes) : undefined,
  host,
  port,
  nodeId,
  meshId,
  operatorActorId,
  runtime,
  journal,
  knownInvocations,
  brokerService,
  webControl,
  readHostInfo: currentHostInfo,
  a2aService,
  brokerRepoTailService,
  getHarnessTopologySnapshot,
  getTailDiscovery,
  nudgeHarnessTopologyScan,
  deliveryHttpService,
  durableActionHttpService,
  controlStreams,
  managedSessionHttpService,
  meshDiscoveryService,
  meshHttpService,
  wakeMeshHarnessSession: (input) => wakeLocalSessionForBroker({
    nativeSessionId: input.nativeSessionId,
    // Peer-supplied harness rides in as a plain string; only a known kind narrows.
    ...(input.harness && (AGENT_HARNESSES as readonly string[]).includes(input.harness)
      ? { harness: input.harness as AgentHarness }
      : {}),
    ...(input.projectPath ? { projectPath: input.projectPath } : {}),
  }),
  startMeshProjectSession: startMeshProjectSessionForPeer,
  threadEvents,
  handleCommand,
  handleInvocationRequest,
  deleteEndpoint: async (endpointId) => {
    await deleteEndpointDurably(endpointId);
  },
  recordFlight: recordFlightDurably,
  listReadCursorsForConversation,
  resolveReadCursor,
  recordReadCursor: recordReadCursorDurably,
  updateChatPreferences: readCursorStore.updatePreferences,
  setConversationTitle: durableRecords.setConversationTitle,
    updateConversationPins: durableRecords.updateConversationPins,
    correctChatMessage: durableRecords.correctMessage,
    respondToChatQuestion: durableRecords.respondToChatQuestion,
  acknowledgeDeliveriesForReadCursor,
  deliveryAcceptanceService,
  rendezvousService,
  externalSessionService,
  t3Service,
  routeAliasService,
  integrationSetupService,
  integrationSlackDelivery,
  integrationSlackEvents,
  machines: machineService,
  access: {
    access: meshAccessStore, nodeId, nodeKeyId: nodeIdentityKeyId,
    enforced: scopedAccessAvailable,
    legacyPeers: () => trustedPeerStore?.listTrustedPeers() ?? [],
    ingressPosture: () => inspectMeshAccessIngressPosture({ protectedLocalIngress: Boolean(localAdminKey),
      supportDirectory: resolveOpenScoutSupportPaths().supportDirectory, entrypoints: currentLocalNode().meshEntrypoints ?? [] }),
    listAgents: () => Object.values(runtime.snapshot().agents).filter((agent) => agent.authorityNodeId === nodeId).map((agent) => {
      const roots = new Set(runtime.endpointsForAgent(agent.id, { nodeId }).map((endpoint) => brokerTargetProjectRoot(agent, endpoint)).filter((root): root is string => Boolean(root)));
      const metadataRoot = brokerTargetProjectRoot(agent, null);
      if (metadataRoot) roots.add(metadataRoot);
      // Ambiguous agent/project binding supplies no project authority.
      return { id: agent.id, displayName: agent.displayName, ...(roots.size === 1 ? { projectRoot: [...roots][0] } : {}) };
    }),
    ensureGuestActor: (actor) => upsertActorDurably(actor),
    openThread: ({ requesterId, targetAgentId }) => ensureBrokerDeliveryConversation({ requesterId, targetAgentId }),
    postMessage: (message) => postConversationMessage(message),
    invoke: (invocation) => handleInvocationRequest(invocation),
    existingInvocation: (id) => runtime.snapshot().invocations[id],
    flightForInvocation: (id) => runtime.flightForInvocation(id),
  },
  guest: {
    sessions: externalSessionService,
    grants: guestGrantStore,
    nodeId,
    nodeKeyId: nodeIdentityKeyId,
    nodeCard: currentSignedNodeCard,
    // Milestone one: only agents whose authority is this node. A guest ask is
    // never forwarded to, or recreated on, another node.
    listAgents: () => Object.values(runtime.snapshot().agents)
      .filter((agent) => agent.authorityNodeId === nodeId)
      .map((agent) => ({ id: agent.id, displayName: agent.displayName, ...(agent.handle ? { handle: agent.handle } : {}) })),
    ensureGuestActor: (actor) => upsertActorDurably(actor),
    openThread: ({ requesterId, targetAgentId }) => ensureBrokerDeliveryConversation({ requesterId, targetAgentId }),
    postMessage: (message) => postConversationMessage(message),
    invoke: (invocation) => handleInvocationRequest(invocation),
    existingInvocation: (invocationId) => runtime.snapshot().invocations[invocationId],
    flightForInvocation: (invocationId) => runtime.flightForInvocation(invocationId),
  },
  meshTrust: {
    enrollment: trustEnrollmentService,
    rateLimiter: trustEndpointRateLimiter,
    nodeCard: currentSignedNodeCard,
    gateMode: effectiveGateMode,
    persistGrant: (grant) => {
      if (!trustedPeerStore) {
        return false;
      }
      if (meshAccessStore?.knownDevice(grant.keyId) || meshAccessStore?.knownPrincipal(grant.keyId)) return false;
      trustedPeerStore.upsertTrustedPeer(grant);
      return true;
    },
    peers: trustedPeerStore,
  },
  meshBind: {
    applyScope: async (scope) => {
      if (!meshBindController) {
        throw new Error("mesh bind controller is not ready");
      }
      return meshBindController.applyScope(scope);
    },
    getState: () => meshBindController?.getState() ?? {
      scope: advertiseScope,
      port,
      tlsAddresses: [],
      endpoints: [brokerUrl],
      brokerUrl,
      tlsSpkiFingerprint: null,
      mdnsAdvertising: false,
      hasNonLoopbackListener: false,
    },
  },
  forwardHostWebRequest: async (input) => {
    const authority = runtime.node(input.nodeId);
    if (!authority || authority.meshId !== meshId) {
      return { status: 404, body: { error: "Destination is not in this mesh" } };
    }
    if (authority.id === nodeId) return webControl.requestForHost(input);
    if (!authority.brokerUrl) return { status: 503, body: { error: "Destination broker is unavailable" } };
    try {
      const forwarded = await daemonMeshPeerFetch(authority.brokerUrl, "/v1/mesh/web-request", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: input.path, method: input.method, body: input.body }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!forwarded.ok) return { status: forwarded.status, body: { error: "Destination broker rejected host routing; check its version and mesh trust" } };
      const result = await forwarded.json() as { status: number; body: unknown };
      if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599) {
        return { status: 502, body: { error: "Destination broker returned an invalid host response" } };
      }
      return result;
    } catch {
      return { status: 502, body: { error: "Destination broker could not be reached" } };
    }
  },
  forwardRouteAliasRequest: async ({ nodeSelector, path, method, body }) => {
    const matches = Object.values(runtime.snapshot().nodes).filter((candidate) =>
      candidate.id === nodeSelector || candidate.name === nodeSelector || candidate.hostName === nodeSelector
    );
    if (matches.length !== 1) {
      return {
        status: 400,
        body: {
          error: "ambiguous_alias_scope",
          detail: `host ${nodeSelector} is ${matches.length ? "ambiguous" : "unknown"}; use an exact node id`,
          candidates: matches.map((candidate) => candidate.id),
        },
      };
    }
    const authority = matches[0]!;
    if (authority.id === nodeId) return null;
    if (authority.meshId !== meshId) {
      return { status: 403, body: { error: "not_authorized", detail: "alias authority is outside the local owner realm" } };
    }
    if (!authority.brokerUrl) {
      return { status: 503, body: { error: "alias_target_unavailable", detail: `authoritative broker ${authority.id} is not reachable` } };
    }
    try {
      // Signed via the mesh peer client. Alias resolution is served to peers
      // at the remote tier (/v1/mesh/aliases/resolve, §4); other forwarded
      // paths (alias mutations, /v1/deliver) stay local-tier by design and
      // are unreachable to remote peers in enforce mode. Pre-trust-cone
      // peers lack the mesh route — fall back to the original path on 404.
      const peerPath = path === "/v1/aliases/resolve" ? "/v1/mesh/aliases/resolve" : path;
      const requestInit = {
        method,
        headers: {
          "content-type": "application/json",
          "x-openscout-mesh-id": meshId,
          "x-openscout-forwarded-node-id": nodeId,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      };
      let forwarded = await daemonMeshPeerFetch(authority.brokerUrl, peerPath, requestInit);
      if (forwarded.status === 404 && peerPath !== path) {
        forwarded = await daemonMeshPeerFetch(authority.brokerUrl, path, requestInit);
      }
      return {
        status: forwarded.status,
        body: await forwarded.json().catch(() => ({
          error: "alias_target_unavailable",
          detail: `authoritative broker ${authority.id} returned a non-JSON response`,
        })),
      };
    } catch (error) {
      return {
        status: 503,
        body: {
          error: "alias_target_unavailable",
          detail: `failed to forward alias request to ${authority.id}: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  },
  openRolesDb: openRolesControlPlaneDb,
});

let rolesControlPlaneDb: import("bun:sqlite").Database | null = null;
function openRolesControlPlaneDb() {
  if (sqliteDisabled) return null;
  try {
    if (!rolesControlPlaneDb) {
      const require = createRequire(import.meta.url);
      const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
      rolesControlPlaneDb = new Database(dbPath);
      rolesControlPlaneDb.exec("PRAGMA busy_timeout = 2500;");
      rolesControlPlaneDb.exec("PRAGMA journal_mode = WAL;");
    }
    return rolesControlPlaneDb as never;
  } catch {
    return null;
  }
}

function createBrokerHttpServer(): ReturnType<typeof createServer> {
  return createServer((request, response) => {
    // Mesh trust cone ingress gate: classifies the transport, and for remote
    // peers verifies the signed request before the router sees it (default
    // verify-warn: logs and allows). Local transports pass through untouched.
    meshIngressGate
      .gateHttpRequest(request, response, (gatedRequest) =>
        routeBrokerHttpRequest(gatedRequest, response))
      .catch((error) => {
        json(response, 500, {
          error: "internal_error",
          detail: error instanceof Error ? error.message : String(error),
        });
      });
  });
}

async function routeBrokerHttpRequest(
  request: RuntimeHttpRequestLike,
  response: RuntimeHttpResponseLike,
): Promise<void> {
  if (!startupTrafficGate.admits(request.method, request.url ?? "/")) {
    json(response, 503, {
      error: "broker_restoring",
      detail: "This route requires context that is still restoring. Registration and covered reads are available as reported by startup capabilities.",
      startup: startupTrafficGate.snapshot(),
      retryable: true,
    });
    return;
  }
  await routeRequest(request, response).catch((error) => {
    json(response, 500, {
      error: "internal_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  });
}

const server = createBrokerHttpServer();
const socketServer = createBrokerHttpServer();
server.on("close", () => {
  unregisterActiveScoutBrokerService(brokerService);
});

// ─── tRPC over WebSocket — broker firehose endpoints ───────────────────────
// Mounted at /trpc. Tail and topology firehoses live here. Future endpoints
// (agent activity, control events) get added to broker-trpc-router.ts and
// consumers pick up the new procedures via end-to-end type inference.
//
// See docs/tail-firehose.md.

const wsRequire = createRequire(import.meta.url);
const { WebSocketServer } = wsRequire("ws") as typeof import("ws");

const trpcWss = new WebSocketServer({ noServer: true });

function handleBrokerUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const url = new URL(request.url || "/", `http://${host}:${port}`);
  if (url.pathname === "/trpc") {
    if (!startupTrafficGate.snapshot().mutationsAdmitted) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    // The WS upgrade bypasses the HTTP router, so the mesh gate runs here at
    // the server edge; on enforce-mode deny the gate answers and destroys the
    // socket itself.
    if (!meshIngressGate.gateUpgrade(request, socket)) {
      return;
    }
    trpcWss.handleUpgrade(request, socket, head, (ws) => {
      trpcWss.emit("connection", ws, request);
    });
    return;
  }
  socket.destroy();
}

server.on("upgrade", handleBrokerUpgrade);
socketServer.on("upgrade", handleBrokerUpgrade);

const trpcHandler = applyWSSHandler({
  wss: trpcWss,
  router: brokerRouter,
  createContext: () => ({}),
});

// Arm credential redaction (varlock .env.schema + declared credential env
// vars) and patch console.* before the broker emits any output. Best-effort:
// never throws, and the broker must boot even if varlock cannot load.
const secretRedaction = await bootstrapSecretRedaction({ patchConsole: true });
console.log(`[openscout-runtime] secret redaction armed (${secretRedaction.registered} value(s)${
  secretRedaction.schemaPath ? `, schema ${secretRedaction.schemaPath}` : ", no .env.schema found"
})`);

try {
  // §11.3: plaintext always on loopback; mesh TLS listeners are added by the
  // bind controller (never a 0.0.0.0 plaintext default).
  await listenTcp(server, { host: isLoopbackHost(host) || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host, port });
  await listenUnixSocket(socketServer, brokerSocketPath);
  startupTrafficGate.markListening();

  const bootstrapIdentityWrite = upsertNodeDurably(localNode, bootstrapProjectionOptions())
    .then(() => upsertActorDurably(systemActor, bootstrapProjectionOptions()))
    .catch((error) => {
      console.error("[openscout-runtime] bootstrap identity persistence failed:", error);
      throw error;
    });
  // Local registration needs the complete control replay and durable local
  // identity. Mesh binding/host-info publication can proceed afterward.
  await bootstrapIdentityWrite;
  startupTrafficGate.admitCore();
  console.log(`[openscout-runtime] startup core ready ${JSON.stringify(startupTrafficGate.snapshot())}`);


  function handleBrokerHttp(
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ): void {
    meshIngressGate
      .gateHttpRequest(request, response, (gatedRequest) =>
        routeBrokerHttpRequest(gatedRequest, response))
      .catch((error) => {
        json(response, 500, {
          error: "internal_error",
          detail: error instanceof Error ? error.message : String(error),
        });
      });
  }

  meshBindController = createMeshBindController({
    port,
    keyId: nodeIdentityKeyId,
    handleHttp: handleBrokerHttp,
    handleUpgrade: handleBrokerUpgrade,
    loopbackBrokerUrl: brokerControlUrl,
    supportDirectory,
    logger: console,
    onStateChange: async (state) => {
      advertiseScope = state.scope;
      brokerUrl = state.brokerUrl;
      const nextNode = localNodeWithBindState(currentLocalNode(), state);
      Object.assign(localNode, nextNode);
      await upsertNodeDurably(nextNode, bootstrapProjectionOptions()).catch((error) => {
        console.warn("[openscout-runtime] mesh bind: failed to update node registry:", error);
      });
      await writeHostInfo().catch((error) => {
        console.warn("[openscout-runtime] mesh bind: failed to write .host-info:", error);
      });
    },
  });
  await meshBindController.start(bootAdvertiseScope);
  // Refresh mutable advertise/url from the controller's actual state.
  {
    const state = meshBindController.getState();
    advertiseScope = state.scope;
    brokerUrl = state.brokerUrl;
    Object.assign(localNode, localNodeWithBindState(localNode, state));
    await upsertNodeDurably(localNode, bootstrapProjectionOptions()).catch(() => undefined);
  }

  await writeHostInfo().catch((error) => {
    console.warn("[openscout-runtime] failed to write .host-info:", error);
  });
  const meshRendezvousConfig = meshInstanceRefusal ? undefined : resolveMeshRendezvousPublishConfig();
  if (meshRendezvousConfig) {
    meshRendezvousPublisher = startMeshRendezvousPublisher(currentRendezvousNode, {
      config: meshRendezvousConfig,
      logger: console,
    });
  }
  // Expensive maintenance and initial message coverage run with listeners and
  // safe registry commands available. Compaction completes before projection
  // captures a byte boundary, so rename can never invalidate its replay cursor.
  await journal.finishStartup();
  startupTrafficGate.admitHistory();
  console.log(`[openscout-runtime] startup history ready ${JSON.stringify(startupTrafficGate.snapshot())}`);
  if (Number.isFinite(startupBoundaryTestDelayMs) && startupBoundaryTestDelayMs > 0) {
    await sleep(startupBoundaryTestDelayMs);
  }
  await bootstrapIdentityWrite;
  let canonicalStartupFailure = false;
  try {
    projectionWarmStarted = true;
    await projection.warm();
    if (!sqliteDisabled) {
      // Wait for the original replay, then schedule its accepted startup suffix
      // before enabling live writes. No payload closure is retained for that
      // suffix, and writes after its barrier queue strictly behind catch-up.
      await projection.flush();
      let catchUp: Promise<void> = Promise.resolve();
      await durableStore.runWrite(async () => {
        await controlEventWrites;
        const boundary = await projection.captureStartupCatchUpBoundary();
        catchUp = projection.catchUpStartup(boundary);
        void catchUp.catch(() => {});
        deferStartupProjection = false;
      }).catch((error) => {
        // A failed canonical event append or journal barrier is not a derived
        // projection failure: never keep accepting writes on that evidence.
        canonicalStartupFailure = true;
        throw error;
      });
      await catchUp;
      startupTrafficGate.restoringSessions();
      observedSessionReducer = new ObservedSessionReducer(projection);
      const persistedObservedSessions = await projection.persistedActiveObservedSessionUpdates();
      if (persistedObservedSessions !== null) {
        const hydration = observedSessionReducer.hydratePersistedActiveSessions(
          persistedObservedSessions,
        );
        const lifecycleSeeds = replacePersistedActiveObservedSessionSeeds(
          persistedObservedSessions.map((update) => ({
            source: update.source,
            sourceSessionId: update.sourceSessionId,
            lastActivityAt: update.lastActivityAt,
            project: update.project,
            projectRoot: update.projectRoot,
            cwd: update.cwd,
          })),
        );
        if (hydration.dropped > 0 || lifecycleSeeds.dropped > 0) {
          console.warn(
            `[openscout-runtime] bounded observed-session restart seed: `
            + `${hydration.hydrated} reducer rows, ${lifecycleSeeds.seeded} lifecycle rows, `
            + `${hydration.dropped + lifecycleSeeds.dropped} dropped`,
          );
        }
      }
      unsubscribeObservedSessionReducer = subscribeObservedSessionReducer(observedSessionReducer);
    }
    deferStartupProjection = false;
    startupTrafficGate.admitMutations();
  } catch (error) {
    if (canonicalStartupFailure) throw error;
    // SQLite is derived. A healthy canonical journal still supports core
    // registration and snapshots, but cannot certify projection-backed work.
    deferStartupProjection = true;
    durableStore.abandonProjectedEntries();
    projection.close();
    startupTrafficGate.degradeProjection(error);
    console.error("[openscout-runtime] startup projection degraded; core remains available", startupTrafficGate.snapshot());
  }
  if (startupTrafficGate.snapshot().mutationsAdmitted) {
    startPresenceSampling();
    registerActiveScoutBrokerService(brokerService);
    peerDelivery.start();
  }
  console.log(`[openscout-runtime] broker listening on 127.0.0.1:${port} (scope: ${advertiseScope}, url: ${brokerUrl})`);
  console.log(`[openscout-runtime] broker local socket ${brokerSocketPath}`);
  if (scoutbotProcessEnabled) scoutbotService.start();
  const bindState = meshBindController.getState();
  if (bindState.tlsAddresses.length > 0) {
    console.log(`[openscout-runtime] mesh TLS on ${bindState.tlsAddresses.map((a) => `https://${a}:${port}`).join(", ")}`);
  } else if (advertiseScope === "mesh") {
    console.warn(`[openscout-runtime] WARNING: mesh scope active but no non-loopback IPv4 (LAN/Tailscale) for TLS — peers cannot reach this broker until an interface is available.`);
  }
  console.log(`[openscout-runtime] node ${nodeId} in mesh ${meshId}`);
  console.log(`[openscout-runtime] mesh trust: keyId ${nodeIdentityKeyId} fingerprint ${nodeIdentityFingerprint} (gate: ${effectiveGateMode()})`);
  console.log(`[openscout-runtime] journal ${journalPath}`);
  // Re-read the report after finishStartup(): under progressive startup the
  // deferred compaction folds its real compactionMs/compactedBytes back in.
  const finalLoadReport = journal.loadReport() ?? journalLoadReport;
  console.log(
    `[openscout-runtime] journal load ${finalLoadReport.totalMs}ms `
    + `(scan ${finalLoadReport.scanMs}ms, compaction ${finalLoadReport.compactionMs}ms, `
    + `${finalLoadReport.validEntries} entries, ${finalLoadReport.sourceBytes} -> ${finalLoadReport.compactedBytes} bytes, `
    + `compactionReason ${finalLoadReport.compactionReason})`,
  );
  console.log(`[openscout-runtime] sqlite ${sqliteDisabled ? "disabled" : dbPath}`);
} catch (error) {
  startupTrafficGate.fail(error);
  console.error("[openscout-runtime] startup failed", startupTrafficGate.snapshot());
  unregisterActiveScoutBrokerService(brokerService);
  await Promise.all([closeServer(socketServer), closeServer(server)]).catch(() => undefined);
  if (isAddressInUse(error)) {
    const existing = await probeExistingBroker();
    if (existing) {
      console.log(`[openscout-runtime] broker already running on ${brokerUrl}`);
      console.log(`[openscout-runtime] node ${existing.nodeId} in mesh ${existing.meshId ?? "unknown"}`);
      process.exit(0);
    }

    console.error(`[openscout-runtime] port ${port} is already in use by another process on ${host}`);
    process.exit(1);
  }

  throw error;
}

void storageMonitor.refresh();
setInterval(() => { void storageMonitor.refresh(); }, 30_000).unref();

const otlpReceiver = localAdminKey ? undefined : await startBrokerOtlpReceiver(controlHome);

setTimeout(() => {
  if (!startupTrafficGate.snapshot().mutationsAdmitted) return;
  recoverInvocationResultReplies();
  recoverTerminalReports();
  recoverTerminalWorkPromotions();
  // Reconcile persisted external attempts without repeating a provider send.
  void externalSessionService.recover([...knownInvocations.values()])
    .then((failed) => { if (failed.length) console.error("[openscout-runtime] external session recovery incomplete", failed); })
    .catch((error) => console.error("[openscout-runtime] external session recovery failed", error));
  replyCompletionRecovery.recover()
    .then(() => {
      t3Service.recover(knownInvocations.values());
      return bootstrapRegisteredLocalAgents();
    })
    .then(() => dispatchRecoveryService.recoverQueuedFlights({ reason: "startup" }))
    .catch((error) => {
      console.error("[openscout-runtime] local agent bootstrap or dispatch recovery failed:", error);
    });
  replyCompletionRecovery.recover().then(() => reconcileStaleWorkingFlights()).catch((error) => {
    console.error("[openscout-runtime] stale flight reconciliation failed:", error);
  });
  reconcileStaleLocalDeliveries().catch((error) => {
    console.error("[openscout-runtime] stale delivery reconciliation failed:", error);
  });
  sweepIdleCardlessSessions().catch((error) => {
    console.error("[openscout-runtime] initial cardless session sweep failed:", error);
  });
  sweepRegistryRetention()
    .catch((error) => {
      console.error("[openscout-runtime] initial registry retention sweep failed:", error);
    })
    .then(() => { if (!shuttingDown) storageMaintenance.start(); });
  sweepAndCompactMeshNodes();
  relayAgentReaper.sweep("startup").catch((error) => {
    console.error("[openscout-runtime] startup relay-agent sweep failed:", error);
  });
  routeAliasService?.sweepExpired();
}, 0).unref();

function sweepAndCompactMeshNodes(): void {
  if (!trustedPeerStore) return;
  try {
    const result = trustedPeerStore.compactAndPruneMeshNodes({ localNodeId: nodeId });
    if (result.rehomedNodeCount > 0 || result.prunedNodeCount > 0) {
      console.log(
        `[openscout-runtime] mesh node compaction: rehomed ${result.rehomedNodeCount} node(s), pruned ${result.prunedNodeCount} ghost row(s)`,
      );
    }
  } catch (error) {
    console.error("[openscout-runtime] mesh node compaction failed:", error);
  }
}

// Opt-in event transport. `start()` swallows its own failures: an absent or
// broken NATS must degrade the transport, never the broker.
if (jetStreamService) {
  void jetStreamService.start();
}

// Heartbeat for relay-agent watchdogs: relays self-terminate once this file's
// mtime goes stale, so a dead runtime cannot leave live relay processes behind.
try {
  touchBrokerRuntimeHeartbeat();
} catch (error) {
  console.warn("[openscout-runtime] unable to write runtime heartbeat:", error);
}
setInterval(() => {
  try {
    touchBrokerRuntimeHeartbeat();
  } catch (error) {
    console.warn("[openscout-runtime] unable to refresh runtime heartbeat:", error);
  }
}, runtimeHeartbeatIntervalMs).unref();

// Background coordination must obey the same capability boundary as HTTP.
if (startupTrafficGate.snapshot().mutationsAdmitted) {
  if (!meshInstanceRefusal) {
    meshDiscoveryService.discoverPeers().catch((error) => {
      console.error("[openscout-runtime] initial mesh discovery failed:", error);
    });
  }

  if (!meshInstanceRefusal && Number.isFinite(discoveryIntervalMs) && discoveryIntervalMs > 0) {
    setInterval(() => {
      meshDiscoveryService.discoverPeers().catch((error) => {
        console.error("[openscout-runtime] periodic mesh discovery failed:", error);
      });
    }, discoveryIntervalMs).unref();
  }

  if (Number.isFinite(localAgentSyncIntervalMs) && localAgentSyncIntervalMs > 0) {
    setInterval(() => {
      syncRegisteredLocalAgentsIfChanged("periodic").catch((error) => {
        console.error("[openscout-runtime] periodic local agent sync failed:", error);
      });
    }, localAgentSyncIntervalMs).unref();
  }

  if (Number.isFinite(cardlessSessionSweepIntervalMs) && cardlessSessionSweepIntervalMs > 0) {
    setInterval(() => {
      sweepIdleCardlessSessions().catch((error) => {
        console.error("[openscout-runtime] periodic cardless session sweep failed:", error);
      });
      sweepRegistryRetention().catch((error) => {
        console.error("[openscout-runtime] periodic registry retention sweep failed:", error);
      });
    }, Math.max(60_000, cardlessSessionSweepIntervalMs)).unref();
  }

  if (Number.isFinite(relayAgentSweepIntervalMs) && relayAgentSweepIntervalMs > 0) {
    setInterval(() => {
      relayAgentReaper.sweep("periodic").catch((error) => {
        console.error("[openscout-runtime] periodic relay-agent sweep failed:", error);
      });
    }, Math.max(60_000, relayAgentSweepIntervalMs)).unref();
  }

  // Periodic mesh node compaction sweep to prune Bonjour collision sediments
  setInterval(() => {
    sweepAndCompactMeshNodes();
  }, 15 * 60_000).unref();

  // The serialized maintenance service schedules prompt bounded catch-up while
  // progress continues, then sleeps between idle checks. No interval can queue
  // overlapping scans or retain a promise backlog behind slow storage.

  // Backstop retry for queued deliveries with no endpoint event to wake them —
  // deferred thread_held_externally parks and any flight whose attach event was
  // missed. Deferrals gate per-invocation cadence inside the recovery service.
  setInterval(() => {
    recoverInvocationResultReplies();
    recoverTerminalReports();
    recoverTerminalWorkPromotions();
    replyCompletionRecovery.recover()
      .then(() => dispatchRecoveryService.recoverQueuedFlights({ reason: "queued_retry_sweep" })).catch((error) => {
      console.error("[openscout-runtime] queued dispatch retry sweep failed:", error);
    });
  }, 60_000).unref();

  slackWorkerSupervisor?.start();
  if (routeAliasService) {
    routeAliasSweepTimer = setInterval(() => {
      routeAliasService.sweepExpired();
    }, 60_000);
    routeAliasSweepTimer.unref();
  }
}

async function shutdownBroker(exitCode = 0): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  storageMaintenance.stop();
  meshApprovalWatch.stop();
  meshApprovalShare.stop();
  await slackWorkerSupervisor?.stop();
  await otlpReceiver?.close().catch(() => {
    console.warn("[openscout-runtime] OTLP receiver shutdown failed");
  });
  if (parentWatcher) {
    clearInterval(parentWatcher);
    parentWatcher = null;
  }
  if (routeAliasSweepTimer) {
    clearInterval(routeAliasSweepTimer);
    routeAliasSweepTimer = null;
  }
  await scoutbotService.stop();
  await webControl.stop();
  // Publisher-first, transport-last: the final checkpoint pass needs a live
  // server to ack against, and an owned sidecar must outlive the broker's drain.
  await jetStreamService?.stop().catch((error) => {
    console.warn("[openscout-runtime] jetstream shutdown failed:", error);
  });
  peerDelivery.stop();
  meshRendezvousPublisher?.stop();
  await meshBindController?.stop().catch(() => undefined);
  irohBridgeService?.stop();
  controlStreams.closeAll();
  trpcHandler.broadcastReconnectNotification();
  unsubscribeObservedSessionReducer?.();
  unsubscribeObservedSessionReducer = null;
  await observedSessionReducer?.close({ flush: false }).catch((error) => {
    console.warn("[openscout-runtime] observed session reducer shutdown failed:", error);
  });
  observedSessionReducer = null;
  // The journal and harness transcripts are authoritative. The SQLite/native
  // views are rebuildable and may still be queued behind startup replay, so a
  // process stop must abandon that derived work instead of waiting without a
  // bound and forcing the supervisor to SIGKILL the broker.
  durableStore.abandonProjectedEntries();
  projection.close();
  sharedControlPlaneStore?.close();
  historicalReader.close();
  await Promise.all([closeServer(socketServer), closeServer(server)]);
  await journal.close();
  await unlink(brokerSocketPath).catch(() => undefined);
  await unlink(resolveOpenScoutSupportPaths().hostInfoPath).catch(() => undefined);
  process.exit(exitCode);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shutdownBroker(0).catch((error) => {
      console.error("[openscout-runtime] shutdown failed:", error);
      process.exit(1);
    });
  });
}

if (Number.isFinite(parentPid) && parentPid > 0 && parentPid !== process.pid) {
  parentWatcher = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      console.log(`[openscout-runtime] parent ${parentPid} is gone, exiting broker`);
      shutdownBroker(0).catch((error) => {
        console.error("[openscout-runtime] shutdown failed:", error);
        process.exit(1);
      });
    }
  }, 2_000);
  parentWatcher.unref();
}
