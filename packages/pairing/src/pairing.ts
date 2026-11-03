import type { PendingPairRequestStore, PairRequest } from "./pairing-pair-requests.ts";
import { requestLocalApprovalPairingOpportunity, requestLocalPairingOpportunity } from "@openscout/runtime/pairing-local-socket";
import { pairingTrustOwner } from "@openscout/runtime/pairing-security/trust-owner";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractPendingApprovalRequests,
  type NormalizedApprovalRequest,
  type SessionState,
  type SessionSummary,
} from "@openscout/agent-sessions";
import { findNearestProjectRoot } from "@openscout/runtime/setup";
import {
  isScoutPairingFileFromPreviousBoot,
  isScoutPairingProcessRunning as isLivePairingProcess,
  readLiveScoutPairingSupervisorPid,
  readScoutPairingProcessPid as readSupervisedPairingProcessPid,
  readScoutPairingSupervisorIntent,
  resolveScoutPairingSupervisorPaths,
  updateScoutPairingSupervisorIntent,
} from "@openscout/runtime/pairing-supervisor";
import { loadLocalConfig, resolvePairingPort } from "@openscout/runtime/local-config";
import { openPairingLocalChannel } from "@openscout/runtime/pairing-local-socket";
import { resolveBunExecutable as resolveResolvedBunExecutable } from "@openscout/runtime/tool-resolution";

import { coalesce } from "./coalesce.ts";
import { resolveOpenScoutPairingHome } from "@openscout/runtime/support-paths";
import { selectInstanceAwareEntrypoint } from "@openscout/runtime/instance";

export const SCOUT_PAIRING_HOME_DIRECTORY = ".scout/pairing";
export const SCOUT_PAIRING_CONFIG_FILE = "config.json";
export const SCOUT_PAIRING_IDENTITY_FILE = "identity.json";
export const SCOUT_PAIRING_TRUSTED_PEERS_FILE = "trusted-peers.json";
export const SCOUT_PAIRING_LOG_FILE = "bridge.log";
export const SCOUT_PAIRING_RUNTIME_STATE_FILE = "runtime.json";
export const SCOUT_PAIRING_RUNTIME_PID_FILE = "runtime.pid";
export const SCOUT_PAIRING_DEFAULT_PORT = 7_888;
export const SCOUT_PAIRING_LOG_TAIL_LINE_LIMIT = 160;
export const SCOUT_PAIRING_RUNTIME_BOOTSTRAP_DELAY_MS = 350;
export const SCOUT_PAIRING_PROCESS_EXIT_TIMEOUT_MS = 5_000;
export const SCOUT_PAIRING_SUPERVISOR_ACTION_TIMEOUT_MS = 8_000;
export const SCOUT_PAIRING_PROCESS_EXIT_POLL_MS = 100;
export const SCOUT_PAIRING_COMMAND_LABEL = "openscout-web pair";
export const SCOUT_PAIRING_RUNTIME_VERSION = 1 as const;
export const SCOUT_PAIRING_RUNTIME_SCRIPT = "pairing-runtime-controller.ts";

export type ScoutPairingControlAction = "start" | "stop" | "restart";

export type ScoutPairingConfig = {
  relay?: string;
  secure?: boolean;
  port?: number;
  adapters?: Record<string, { type: string; options?: Record<string, unknown> }>;
  workspace?: {
    root?: string;
  };
  sessions?: unknown[];
};

export type ScoutPairingPaths = {
  rootDir: string;
  configPath: string;
  identityPath: string;
  trustedPeersPath: string;
  logPath: string;
  runtimeStatePath: string;
  runtimePidPath: string;
};

export type ScoutPairingSnapshot = {
  relay: string;
  fallbackRelays?: string[];
  room: string;
  publicKey: string;
  expiresAt: number;
  qrArt: string;
  qrValue: string;
};

export type ScoutPairingTrustedPeer = {
  publicKey: string;
  fingerprint: string;
  name: string | null;
  pairedAt: string | null;
  pairedAtLabel: string | null;
  lastSeen: string | null;
  lastSeenLabel: string | null;
};

export type ScoutPairingApprovalRequest = NormalizedApprovalRequest;

export type ScoutPairingApprovalDecision = "approve" | "deny";

export type DecideScoutPairingApprovalInput = {
  sessionId: string;
  turnId: string;
  blockId: string;
  version: number;
  decision: ScoutPairingApprovalDecision;
  reason?: string | null;
};

export type ScoutPairingRuntimeStatus =
  | "unconfigured"
  | "stopped"
  | "starting"
  | "connecting"
  | "connected"
  | "paired"
  | "closed"
  | "error";

export type ScoutPairingRuntimeSnapshot = {
  version: 1;
  pid: number;
  childPid: number | null;
  status: ScoutPairingRuntimeStatus;
  statusLabel: string;
  statusDetail: string | null;
  connectedPeerFingerprint: string | null;
  relay: string | null;
  secure: boolean;
  lanDiscoveryAdvertised?: boolean;
  workspaceRoot: string | null;
  sessionCount: number;
  identityFingerprint: string | null;
  trustedPeerCount: number;
  pairing: ScoutPairingSnapshot | null;
  startedAt: number;
  updatedAt: number;
};

export type ScoutPairingState = {
  status: ScoutPairingRuntimeStatus;
  statusLabel: string;
  statusDetail: string | null;
  connectedPeerFingerprint: string | null;
  isRunning: boolean;
  commandLabel: string;
  configPath: string;
  identityPath: string;
  trustedPeersPath: string;
  logPath: string;
  relay: string | null;
  configuredRelay: string | null;
  secure: boolean;
  lanDiscoveryAdvertised: boolean;
  workspaceRoot: string | null;
  sessionCount: number;
  identityFingerprint: string | null;
  trustedPeerCount: number;
  trustedPeers: ScoutPairingTrustedPeer[];
  pendingApprovals: ScoutPairingApprovalRequest[];
  pairing: ScoutPairingSnapshot | null;
  logTail: string;
  logUpdatedAtLabel: string | null;
  logMissing: boolean;
  logTruncated: boolean;
  lastUpdatedLabel: string | null;
};

export type UpdateScoutPairingConfigInput = {
  relay: string;
  workspaceRoot?: string | null;
};

type ScoutPairingResolvedConfig = {
  relay: string | null;
  secure: boolean;
  port: number;
  workspaceRoot: string | null;
  sessions: unknown[];
};

type ScoutPairingLogTail = {
  body: string;
  updatedAtLabel: string | null;
  missing: boolean;
  truncated: boolean;
};

type ScoutPairingIdentity = {
  publicKey?: string;
};

type ScoutPairingTrustedPeerRecord = {
  publicKey?: string;
  name?: string;
  pairedAt?: string;
  lastSeen?: string;
};

type ScoutPairingTrpcResultEnvelope<T> =
  | { type: "data"; data: T }
  | { type: "started" | "stopped" };

type ScoutPairingTrpcResponse<T> =
  | {
      id: number;
      jsonrpc?: string;
      result?: ScoutPairingTrpcResultEnvelope<T>;
      error?: never;
    }
  | {
      id: number | null;
      jsonrpc?: string;
      error: {
        code?: number;
        message?: string;
        data?: { code?: string; httpStatus?: number } & Record<string, unknown>;
      } & Record<string, unknown>;
      result?: never;
    };

type ScoutPairingBridgeClient = {
  query<T>(path: string, input?: Record<string, unknown>): Promise<T>;
  mutation<T>(path: string, input?: Record<string, unknown>): Promise<T>;
  close(): void;
};

const SCOUT_PAIRING_BRIDGE_CONNECT_TIMEOUT_MS = 1_500;
const SCOUT_PAIRING_BRIDGE_REQUEST_TIMEOUT_MS = 2_500;

function resolveScoutPairingHomeDirectory(): string {
  return resolveOpenScoutPairingHome();
}

export function resolveScoutPairingPaths(): ScoutPairingPaths {
  const rootDir = resolveScoutPairingHomeDirectory();
  return {
    rootDir,
    configPath: join(rootDir, SCOUT_PAIRING_CONFIG_FILE),
    identityPath: join(rootDir, SCOUT_PAIRING_IDENTITY_FILE),
    trustedPeersPath: join(rootDir, SCOUT_PAIRING_TRUSTED_PEERS_FILE),
    logPath: join(rootDir, SCOUT_PAIRING_LOG_FILE),
    runtimeStatePath: join(rootDir, SCOUT_PAIRING_RUNTIME_STATE_FILE),
    runtimePidPath: join(rootDir, SCOUT_PAIRING_RUNTIME_PID_FILE),
  };
}

export async function createScoutPairingBridgeClient(
  port: number,
  options: { expectedMode?: "secure" | "plaintext" } = {},
): Promise<ScoutPairingBridgeClient> {
  let nextRequestId = 1;
  const pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();

  const rejectPending = (error: Error) => {
    for (const entry of pending.values()) {
      entry.reject(error);
    }
    pending.clear();
  };

  const handleMessage = (raw: string) => {
    let payload: ScoutPairingTrpcResponse<unknown>;
    try {
      payload = JSON.parse(raw) as ScoutPairingTrpcResponse<unknown>;
    } catch {
      return;
    }

    if (typeof payload?.id !== "number") {
      return;
    }

    const request = pending.get(payload.id);
    if (!request) {
      return;
    }

    pending.delete(payload.id);
    if ("error" in payload && payload.error) {
      request.reject(new Error(payload.error.message || "Scout pairing bridge RPC failed."));
      return;
    }

    const result = payload.result;
    if (!result || result.type !== "data") {
      request.reject(new Error("Scout pairing bridge returned an unexpected response."));
      return;
    }

    request.resolve(result.data);
  };

  const channel = await openPairingLocalChannel(port, {
    onMessage: handleMessage,
    onClose: () => rejectPending(new Error("Scout pairing bridge connection closed.")),
  }, {
    timeoutMs: SCOUT_PAIRING_BRIDGE_CONNECT_TIMEOUT_MS,
    subscribeEvents: false,
    expectedMode: options.expectedMode,
  });

  function call<T>(
    method: "query" | "mutation",
    path: string,
    input?: Record<string, unknown>,
  ): Promise<T> {
    if (!channel.isOpen()) {
      return Promise.reject(new Error("Scout pairing bridge is not connected."));
    }

    const id = nextRequestId++;
    const requestPayload = {
      id,
      jsonrpc: "2.0",
      method,
      params: {
        path,
        ...(input ? { input } : {}),
      },
    };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Scout pairing bridge request timed out for ${path}.`));
      }, SCOUT_PAIRING_BRIDGE_REQUEST_TIMEOUT_MS);

      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      channel.send(JSON.stringify(requestPayload));
    });
  }

  return {
    query<T>(path: string, input?: Record<string, unknown>) {
      return call<T>("query", path, input);
    },
    mutation<T>(path: string, input?: Record<string, unknown>) {
      return call<T>("mutation", path, input);
    },
    close() {
      channel.close();
      rejectPending(new Error("Scout pairing bridge client closed."));
    },
  };
}

async function withScoutPairingBridgeClient<T>(
  port: number,
  run: (client: ScoutPairingBridgeClient) => Promise<T>,
): Promise<T> {
  const client = await createScoutPairingBridgeClient(port);
  try {
    return await run(client);
  } finally {
    client.close();
  }
}

/**
 * Attention, inbox, and pairing-state reads all poll this, often several per
 * second across UI surfaces. Share one bridge round-trip per window instead of
 * opening a fresh socket for each caller. Failures are not cached.
 */
const SESSION_SNAPSHOT_TTL_MS = 5_000;
const sessionSnapshotCache = new Map<number, { promise: Promise<SessionState[]>; expiresAt: number }>();

export function loadScoutPairingSessionSnapshots(port: number): Promise<SessionState[]> {
  const cached = sessionSnapshotCache.get(port);
  if (cached && Date.now() < cached.expiresAt) return cached.promise;
  const entry = { promise: readScoutPairingSessionSnapshots(port), expiresAt: Number.POSITIVE_INFINITY };
  sessionSnapshotCache.set(port, entry);
  entry.promise.then(
    () => { entry.expiresAt = Date.now() + SESSION_SNAPSHOT_TTL_MS; },
    () => { if (sessionSnapshotCache.get(port) === entry) sessionSnapshotCache.delete(port); },
  );
  return entry.promise;
}

async function readScoutPairingSessionSnapshots(port: number): Promise<SessionState[]> {
  return await withScoutPairingBridgeClient(port, async (client) => {
    const status = await client.query<{ sessions: SessionSummary[] }>("bridgeStatus");
    const snapshots = await Promise.all(status.sessions.map((session) =>
      client.query<SessionState>("session.snapshot", { sessionId: session.sessionId })
        .catch(() => null)
    ));

    return snapshots
      .filter((snapshot): snapshot is SessionState => snapshot !== null)
      .filter((snapshot) => snapshot.session.status !== "closed");
  });
}

async function loadScoutPairingPendingApprovals(port: number): Promise<ScoutPairingApprovalRequest[]> {
  return (await loadScoutPairingSessionSnapshots(port))
    .flatMap((snapshot) => extractPendingApprovalRequests(snapshot));
}

function loadScoutPairingConfig(): ScoutPairingConfig {
  const { configPath } = resolveScoutPairingPaths();
  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const payload = JSON.parse(readFileSync(configPath, "utf8")) as ScoutPairingConfig;
    return typeof payload === "object" && payload ? payload : {};
  } catch {
    return {};
  }
}

function saveScoutPairingConfig(config: ScoutPairingConfig): void {
  const { rootDir, configPath } = resolveScoutPairingPaths();
  mkdirSync(rootDir, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function resolveScoutPairingConfig(): ScoutPairingResolvedConfig {
  const config = loadScoutPairingConfig();
  const portFromEnv = Number.parseInt(
    process.env.OPENSCOUT_PAIRING_PORT?.trim()
      || process.env.SCOUT_PAIRING_PORT?.trim()
      || "",
    10,
  );
  const portFromLocalConfig = loadLocalConfig().ports?.pairing;
  const portFromPairingFile = Number.isFinite(config.port) && (config.port ?? 0) > 0
    ? Number(config.port)
    : null;
  return {
    relay: typeof config.relay === "string" && config.relay.trim().length > 0
      ? config.relay.trim()
      : null,
    secure: config.secure !== false,
    port: (Number.isFinite(portFromEnv) && portFromEnv > 0)
      ? portFromEnv
      : portFromLocalConfig ?? portFromPairingFile ?? resolvePairingPort(),
    workspaceRoot: typeof config.workspace?.root === "string" && config.workspace.root.trim().length > 0
      ? config.workspace.root.trim()
      : null,
    sessions: Array.isArray(config.sessions) ? config.sessions : [],
  };
}

async function resolveDefaultScoutPairingWorkspaceRoot(currentDirectory?: string): Promise<string | null> {
  const trimmed = currentDirectory?.trim();
  if (!trimmed) {
    return null;
  }

  return await findNearestProjectRoot(trimmed) ?? trimmed;
}

function readScoutPairingRuntimeSnapshot(): ScoutPairingRuntimeSnapshot | null {
  const { runtimeStatePath } = resolveScoutPairingPaths();
  // A snapshot from before this boot names pids that may now belong to any process.
  if (!existsSync(runtimeStatePath) || isScoutPairingFileFromPreviousBoot(runtimeStatePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(runtimeStatePath, "utf8")) as ScoutPairingRuntimeSnapshot;
    return parsed?.version === SCOUT_PAIRING_RUNTIME_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

function clearScoutPairingRuntimeSnapshot(): void {
  const { runtimeStatePath } = resolveScoutPairingPaths();
  try {
    unlinkSync(runtimeStatePath);
  } catch {
    // noop
  }
}

function readScoutPairingRuntimePid(): number | null {
  return readSupervisedPairingProcessPid(resolveScoutPairingPaths().runtimePidPath);
}

function clearScoutPairingRuntimePid(): void {
  const { runtimePidPath } = resolveScoutPairingPaths();
  try {
    unlinkSync(runtimePidPath);
  } catch {
    // noop
  }
}

function isScoutPairingProcessRunning(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function staleScoutPairingRuntimeOwnerPid(): number | null {
  const pid = readScoutPairingRuntimePid();
  if (!pid) {
    return null;
  }
  return isScoutPairingProcessRunning(pid) ? null : pid;
}

function isScoutPairingRuntimeRunning(): boolean {
  const pid = readScoutPairingRuntimePid();
  if (isScoutPairingProcessRunning(pid)) {
    return true;
  }

  const snapshot = readScoutPairingRuntimeSnapshot();
  return Boolean(snapshot && isScoutPairingProcessRunning(snapshot.childPid ?? snapshot.pid));
}

function clearStaleScoutPairingRuntimeFiles(): void {
  const staleOwnerPid = staleScoutPairingRuntimeOwnerPid();
  if (staleOwnerPid === null) {
    return;
  }

  const snapshot = readScoutPairingRuntimeSnapshot();
  if (snapshot && isScoutPairingProcessRunning(snapshot.childPid ?? snapshot.pid)) {
    return;
  }

  clearScoutPairingRuntimePid();
  clearScoutPairingRuntimeSnapshot();
}

function readScoutPairingIdentityFingerprint(identityPath: string): string | null {
  if (!existsSync(identityPath)) {
    return null;
  }

  try {
    const payload = JSON.parse(readFileSync(identityPath, "utf8")) as ScoutPairingIdentity;
    return typeof payload.publicKey === "string" && payload.publicKey.length > 0
      ? payload.publicKey.slice(0, 16)
      : null;
  } catch {
    return null;
  }
}

function readScoutPairingTrustedPeerCount(trustedPeersPath: string): number {
  if (!existsSync(trustedPeersPath)) {
    return 0;
  }

  try {
    const payload = pairingTrustOwner(dirname(trustedPeersPath)).read().peers;
    return Array.isArray(payload) ? payload.length : 0;
  } catch {
    return 0;
  }
}

function formatScoutPairingHistoryTimestamp(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function readScoutPairingTrustedPeers(trustedPeersPath: string): ScoutPairingTrustedPeer[] {
  if (!existsSync(trustedPeersPath)) {
    return [];
  }

  try {
    const payload = pairingTrustOwner(dirname(trustedPeersPath)).read().peers;
    if (!Array.isArray(payload)) {
      return [];
    }

    return payload
      .filter((entry): entry is Required<Pick<ScoutPairingTrustedPeerRecord, "publicKey">> & ScoutPairingTrustedPeerRecord => (
        typeof entry?.publicKey === "string" && entry.publicKey.length > 0
      ))
      .map((entry) => ({
        publicKey: entry.publicKey,
        fingerprint: entry.publicKey.slice(0, 16),
        name: typeof entry.name === "string" && entry.name.trim().length > 0 ? entry.name.trim() : null,
        pairedAt: typeof entry.pairedAt === "string" && entry.pairedAt.length > 0 ? entry.pairedAt : null,
        pairedAtLabel: formatScoutPairingHistoryTimestamp(entry.pairedAt),
        lastSeen: typeof entry.lastSeen === "string" && entry.lastSeen.length > 0 ? entry.lastSeen : null,
        lastSeenLabel: formatScoutPairingHistoryTimestamp(entry.lastSeen),
      }))
      .sort((left, right) => {
        const leftTime = Date.parse(left.lastSeen ?? left.pairedAt ?? "");
        const rightTime = Date.parse(right.lastSeen ?? right.pairedAt ?? "");
        const safeLeft = Number.isNaN(leftTime) ? 0 : leftTime;
        const safeRight = Number.isNaN(rightTime) ? 0 : rightTime;
        return safeRight - safeLeft;
      });
  } catch {
    return [];
  }
}

export function removeScoutPairingTrustedPeer(fingerprint: string): boolean {
  return pairingTrustOwner(resolveScoutPairingPaths().rootDir).revokePrefix(fingerprint);
}

/** How many trailing bytes of the bridge log are ever read for the tail view. */
export const SCOUT_PAIRING_LOG_TAIL_WINDOW_BYTES = 256 * 1024;

/** Exported for tests. */
export function readScoutPairingLogTail(logPath: string): ScoutPairingLogTail {
  if (!existsSync(logPath)) {
    return {
      body: "",
      updatedAtLabel: null,
      missing: true,
      truncated: false,
    };
  }

  // The bridge log grows without rotation (hundreds of MB in the wild), so
  // never read the whole file: stat for size, read only the trailing window,
  // and drop the leading partial line the window boundary may have cut. One
  // sentinel byte before the window tells whether the window starts exactly
  // at a line boundary — then the first line is complete and must be kept.
  const stats = statSync(logPath);
  const windowBytes = Math.min(stats.size, SCOUT_PAIRING_LOG_TAIL_WINDOW_BYTES);
  const windowed = stats.size > windowBytes;
  const readStart = windowed ? stats.size - windowBytes - 1 : 0;
  const readLength = windowed ? windowBytes + 1 : windowBytes;
  const buffer = Buffer.alloc(readLength);
  const fd = openSync(logPath, "r");
  let bytesRead = 0;
  try {
    bytesRead = readSync(fd, buffer, 0, readLength, readStart);
  } finally {
    closeSync(fd);
  }

  let windowText: string;
  if (windowed) {
    // The sentinel is a raw byte, so check it before UTF-8 decoding; if it is
    // not "\n" the window began mid-line and that partial line gets dropped
    // (any multi-byte character the boundary split goes with it).
    const startsAtLineBoundary = buffer[0] === 0x0a;
    windowText = buffer.subarray(1, bytesRead).toString("utf8");
    if (!startsAtLineBoundary) {
      const firstNewline = windowText.indexOf("\n");
      windowText = firstNewline === -1 ? "" : windowText.slice(firstNewline + 1);
    }
  } else {
    windowText = buffer.subarray(0, bytesRead).toString("utf8");
  }

  const lines = windowText.split(/\r?\n/g);
  const visibleLines = lines.slice(-SCOUT_PAIRING_LOG_TAIL_LINE_LIMIT);
  return {
    body: visibleLines.join("\n").trim(),
    updatedAtLabel: formatScoutPairingLogTimestamp(stats.mtime),
    missing: false,
    truncated: windowed || lines.length > visibleLines.length,
  };
}

function formatScoutPairingTimeLabel(date: Date | number): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatScoutPairingLogTimestamp(date: Date | number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function resolveScoutBunExecutable(): string {
  const bun = resolveResolvedBunExecutable(process.env);
  if (bun) {
    return bun.path;
  }

  throw new Error("Unable to locate Bun for Scout pair mode.");
}

function resolveScoutPairingRuntimeScriptPath(): string {
  const candidates = [
    join(resolveOpenScoutWebServerDirectory(), SCOUT_PAIRING_RUNTIME_SCRIPT.replace(/\.ts$/, ".mjs")),
    join(resolveOpenScoutWebServerDirectory(), SCOUT_PAIRING_RUNTIME_SCRIPT.replace(/\.ts$/, ".js")),
    join(resolveOpenScoutWebServerDirectory(), SCOUT_PAIRING_RUNTIME_SCRIPT),
  ];

  // A non-prod OPENSCOUT_INSTANCE skips a stale pre-instance build: it would
  // run with prod's ~/.scout/pairing and ports.
  const selected = selectInstanceAwareEntrypoint(candidates);
  if (selected) return selected;

  throw new Error(
    "Unable to locate an instance-aware Scout pairing runtime controller entrypoint"
      + " (rebuild, or run from source, for a non-prod OPENSCOUT_INSTANCE).",
  );
}

function resolveOpenScoutWebServerDirectory(moduleUrl: string | URL = import.meta.url): string {
  return dirname(fileURLToPath(moduleUrl));
}

function resolveOpenScoutWebPackageRoot(moduleUrl: string | URL = import.meta.url): string {
  return resolve(resolveOpenScoutWebServerDirectory(moduleUrl), "..");
}

function pairingStateFromRuntime(
  snapshot: ScoutPairingRuntimeSnapshot,
  paths: ScoutPairingPaths,
  log: ScoutPairingLogTail,
  resolvedConfig: ScoutPairingResolvedConfig,
  fallbackWorkspaceRoot: string | null,
  pendingApprovals: ScoutPairingApprovalRequest[],
): ScoutPairingState {
  const relay = snapshot.relay ?? resolvedConfig.relay;
  const effectiveWorkspaceRoot = snapshot.workspaceRoot ?? resolvedConfig.workspaceRoot ?? fallbackWorkspaceRoot;
  const trustedPeers = readScoutPairingTrustedPeers(paths.trustedPeersPath);
  return {
    status: snapshot.status,
    statusLabel: snapshot.statusLabel,
    statusDetail: snapshot.statusDetail,
    connectedPeerFingerprint: snapshot.connectedPeerFingerprint ?? null,
    isRunning: true,
    commandLabel: SCOUT_PAIRING_COMMAND_LABEL,
    configPath: paths.configPath,
    identityPath: paths.identityPath,
    trustedPeersPath: paths.trustedPeersPath,
    logPath: paths.logPath,
    relay,
    configuredRelay: resolvedConfig.relay,
    secure: snapshot.secure,
    lanDiscoveryAdvertised: snapshot.lanDiscoveryAdvertised === true,
    workspaceRoot: effectiveWorkspaceRoot,
    sessionCount: snapshot.sessionCount,
    identityFingerprint: snapshot.identityFingerprint,
    trustedPeerCount: snapshot.trustedPeerCount,
    trustedPeers,
    pendingApprovals,
    pairing: snapshot.pairing,
    logTail: log.body,
    logUpdatedAtLabel: log.updatedAtLabel,
    logMissing: log.missing,
    logTruncated: log.truncated,
    lastUpdatedLabel: formatScoutPairingTimeLabel(snapshot.updatedAt),
  };
}

function pairingStateFromConfig(
  paths: ScoutPairingPaths,
  resolvedConfig: ScoutPairingResolvedConfig,
  log: ScoutPairingLogTail,
  fallbackWorkspaceRoot: string | null,
  pendingApprovals: ScoutPairingApprovalRequest[],
): ScoutPairingState {
  const hasConfiguredRelay = resolvedConfig.relay !== null;
  const effectiveWorkspaceRoot = resolvedConfig.workspaceRoot ?? fallbackWorkspaceRoot;
  const trustedPeers = readScoutPairingTrustedPeers(paths.trustedPeersPath);
  return {
    status: hasConfiguredRelay ? "stopped" : "unconfigured",
    statusLabel: hasConfiguredRelay ? "Stopped" : "Not configured",
    statusDetail: hasConfiguredRelay
      ? "Start Scout pair mode to launch the pairing relay and generate a fresh QR code."
      : "Set a relay to prepare Scout pair mode.",
    connectedPeerFingerprint: null,
    isRunning: false,
    commandLabel: SCOUT_PAIRING_COMMAND_LABEL,
    configPath: paths.configPath,
    identityPath: paths.identityPath,
    trustedPeersPath: paths.trustedPeersPath,
    logPath: paths.logPath,
    relay: resolvedConfig.relay,
    configuredRelay: resolvedConfig.relay,
    secure: resolvedConfig.secure,
    lanDiscoveryAdvertised: false,
    workspaceRoot: effectiveWorkspaceRoot,
    sessionCount: resolvedConfig.sessions.length,
    identityFingerprint: readScoutPairingIdentityFingerprint(paths.identityPath),
    trustedPeerCount: readScoutPairingTrustedPeerCount(paths.trustedPeersPath),
    trustedPeers,
    pendingApprovals,
    pairing: null,
    logTail: log.body,
    logUpdatedAtLabel: log.updatedAtLabel,
    logMissing: log.missing,
    logTruncated: log.truncated,
    lastUpdatedLabel: formatScoutPairingTimeLabel(new Date()),
  };
}

async function readScoutPairingState(currentDirectory?: string): Promise<ScoutPairingState> {
  clearStaleScoutPairingRuntimeFiles();

  const paths = resolveScoutPairingPaths();
  const resolvedConfig = resolveScoutPairingConfig();
  const log = readScoutPairingLogTail(paths.logPath);
  const snapshot = readScoutPairingRuntimeSnapshot();
  const runtimeAlive = isScoutPairingRuntimeRunning();
  const fallbackWorkspaceRoot = await resolveDefaultScoutPairingWorkspaceRoot(currentDirectory);
  const pendingApprovals = snapshot && runtimeAlive
    ? await loadScoutPairingPendingApprovals(resolvedConfig.port).catch(() => [])
    : [];

  if (snapshot && runtimeAlive) {
    return pairingStateFromRuntime(snapshot, paths, log, resolvedConfig, fallbackWorkspaceRoot, pendingApprovals);
  }

  return pairingStateFromConfig(paths, resolvedConfig, log, fallbackWorkspaceRoot, pendingApprovals);
}

async function updateScoutPairingConfig(input: UpdateScoutPairingConfigInput, currentDirectory?: string): Promise<void> {
  const current = loadScoutPairingConfig();
  const next: ScoutPairingConfig = {
    ...current,
  };

  const relay = input.relay.trim();
  if (relay) {
    next.relay = relay;
  } else {
    delete next.relay;
  }

  const workspaceRoot = input.workspaceRoot?.trim() || await resolveDefaultScoutPairingWorkspaceRoot(currentDirectory);
  if (workspaceRoot) {
    next.workspace = {
      ...(typeof current.workspace === "object" && current.workspace ? current.workspace : {}),
      root: workspaceRoot,
    };
  } else {
    delete next.workspace;
  }

  saveScoutPairingConfig(next);
}

async function ensureDefaultScoutPairingWorkspaceConfig(currentDirectory?: string): Promise<void> {
  const current = loadScoutPairingConfig();
  const existingWorkspaceRoot = typeof current.workspace?.root === "string" && current.workspace.root.trim().length > 0
    ? current.workspace.root.trim()
    : null;
  if (existingWorkspaceRoot) {
    return;
  }

  const workspaceRoot = await resolveDefaultScoutPairingWorkspaceRoot(currentDirectory);
  if (!workspaceRoot) {
    return;
  }

  saveScoutPairingConfig({
    ...current,
    workspace: {
      ...(typeof current.workspace === "object" && current.workspace ? current.workspace : {}),
      root: workspaceRoot,
    },
  });
}

async function waitForScoutPairingProcessExit(pid: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < SCOUT_PAIRING_PROCESS_EXIT_TIMEOUT_MS) {
    if (!isScoutPairingProcessRunning(pid)) {
      return;
    }
    await sleep(SCOUT_PAIRING_PROCESS_EXIT_POLL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function startScoutPairingRuntime(): Promise<void> {
  const bunExecutable = resolveScoutBunExecutable();
  const runtimeScriptPath = resolveScoutPairingRuntimeScriptPath();
  const child = spawn(bunExecutable, [runtimeScriptPath], {
    cwd: resolveOpenScoutWebPackageRoot(),
    env: {
      ...process.env,
      OPENSCOUT_PARENT_PID: String(process.pid),
    },
    stdio: "ignore",
  });

  child.unref();
  await sleep(SCOUT_PAIRING_RUNTIME_BOOTSTRAP_DELAY_MS);
}

async function stopScoutPairingRuntime(): Promise<void> {
  const pid = readScoutPairingRuntimePid();
  if (pid && isScoutPairingProcessRunning(pid)) {
    process.kill(pid, "SIGTERM");
    await waitForScoutPairingProcessExit(pid);
  }
}

async function restartScoutPairingRuntime(): Promise<void> {
  await stopScoutPairingRuntime();
  await startScoutPairingRuntime();
}

async function ensureScoutPairingRuntimeStarted(): Promise<void> {
  if (isScoutPairingRuntimeRunning()) {
    return;
  }
  await startScoutPairingRuntime();
}
async function requestPairingActionFromSupervisor(
  action: ScoutPairingControlAction,
): Promise<boolean> {
  const paths = resolveScoutPairingSupervisorPaths();
  const previousPid = readSupervisedPairingProcessPid(paths.runtimePidPath);
  updateScoutPairingSupervisorIntent(action, paths.intentPath);
  const supervisorPid = readLiveScoutPairingSupervisorPid(paths.supervisorPidPath);
  if (!supervisorPid) return false;
  const deadline = Date.now() + SCOUT_PAIRING_SUPERVISOR_ACTION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const currentPid = readSupervisedPairingProcessPid(paths.runtimePidPath);
    const running = isLivePairingProcess(currentPid);
    if (action === "stop" ? !running : running && (action !== "restart" || currentPid !== previousPid)) {
      return true;
    }
    await sleep(SCOUT_PAIRING_PROCESS_EXIT_POLL_MS);
  }
  throw new Error(
    `Scout pairing supervisor ${supervisorPid} did not complete ${action} within ${SCOUT_PAIRING_SUPERVISOR_ACTION_TIMEOUT_MS}ms.`,
  );
}

// Serializes all mutations to the pairing runtime controller process (start/stop/restart)
// so that concurrent /api/pairing/control requests cannot race on the check-then-spawn
// in ensureScoutPairingRuntimeStarted.
let pairingMutationChain: Promise<unknown> = Promise.resolve();

function serializePairingMutation<T>(fn: () => Promise<T>): Promise<T> {
  const next = pairingMutationChain.then(fn);
  pairingMutationChain = next.catch(() => undefined);
  return next;
}

// Every plain /api/pairing-state read used to open a fresh WebSocket to the
// pairing bridge. Coalesce those reads (one reader per directory key) behind a
// short TTL; `?refresh` still forces a live read and re-primes the memo, and
// pairing mutations drop the memo so a follow-up read never sees pre-mutation
// state.
const SCOUT_PAIRING_STATE_CACHE_TTL_MS = 3_000;

const coalescedPairingStateReads = new Map<string, () => Promise<ScoutPairingState>>();

function coalescedPairingStateReader(currentDirectory?: string): () => Promise<ScoutPairingState> {
  const key = currentDirectory ?? "";
  let reader = coalescedPairingStateReads.get(key);
  if (!reader) {
    reader = coalesce(
      () => readScoutPairingState(currentDirectory),
      SCOUT_PAIRING_STATE_CACHE_TTL_MS,
    );
    coalescedPairingStateReads.set(key, reader);
  }
  return reader;
}

function invalidateScoutWebPairingStateCache(): void {
  coalescedPairingStateReads.clear();
  sessionSnapshotCache.clear();
}

export async function getScoutWebPairingState(currentDirectory?: string): Promise<ScoutPairingState> {
  return coalescedPairingStateReader(currentDirectory)();
}

export async function refreshScoutWebPairingState(currentDirectory?: string): Promise<ScoutPairingState> {
  coalescedPairingStateReads.delete(currentDirectory ?? "");
  return coalescedPairingStateReader(currentDirectory)();
}

export async function getScoutWebPairingSessionSnapshot(
  sessionId: string,
): Promise<SessionState | null> {
  if (!isScoutPairingRuntimeRunning()) {
    return null;
  }

  const resolvedConfig = resolveScoutPairingConfig();
  try {
    return await withScoutPairingBridgeClient(resolvedConfig.port, async (client) =>
      client.query<SessionState>("session.snapshot", { sessionId }),
    );
  } catch {
    return null;
  }
}

export async function getScoutWebPairingSessionSnapshots(): Promise<SessionState[]> {
  if (!isScoutPairingRuntimeRunning()) {
    return [];
  }

  const resolvedConfig = resolveScoutPairingConfig();
  return loadScoutPairingSessionSnapshots(resolvedConfig.port);
}

/** Explicit host approval; never opens or reads the QR window. */
export async function controlScoutWebApprovalPairing(
  action: "open" | "read" | "cancel",
  request: {token: string; requesterPublicKey?: string | null},
  currentDirectory?: string,
) {
  const binding = {requestId: request.token, ...(request.requesterPublicKey ? {publicKey: request.requesterPublicKey} : {})};
  if (action !== "open") {
    if (!isScoutPairingRuntimeRunning()) return null;
    return requestLocalApprovalPairingOpportunity(resolveScoutPairingConfig().port, action, binding);
  }
  return serializePairingMutation(async () => {
    // Preserve the approved authority baseline across asynchronous startup.
    const authorityStamp = pairingTrustOwner().pairingAuthorityStamp();
    await ensureDefaultScoutPairingWorkspaceConfig(currentDirectory);
    if (!await requestPairingActionFromSupervisor("start")) await ensureScoutPairingRuntimeStarted();
    const result = await requestLocalApprovalPairingOpportunity(resolveScoutPairingConfig().port, "open", {...binding, authorityStamp});
    invalidateScoutWebPairingStateCache();
    return result;
  });
}

export async function controlScoutWebPairingService(
  action: ScoutPairingControlAction,
  currentDirectory?: string,
): Promise<ScoutPairingState> {
  return serializePairingMutation(async () => {
    switch (action) {
      case "start":
        await ensureDefaultScoutPairingWorkspaceConfig(currentDirectory);
        if (!await requestPairingActionFromSupervisor(action)) {
          await ensureScoutPairingRuntimeStarted();
        }
        await requestLocalPairingOpportunity(resolveScoutPairingConfig().port, "open");
        break;
      case "stop":
        if (!await requestPairingActionFromSupervisor(action)) {
          await stopScoutPairingRuntime();
        }
        break;
      case "restart":
        await ensureDefaultScoutPairingWorkspaceConfig(currentDirectory);
        if (!await requestPairingActionFromSupervisor(action)) {
          await restartScoutPairingRuntime();
        }
        break;
    }

    invalidateScoutWebPairingStateCache();
    return coalescedPairingStateReader(currentDirectory)();
  });
}

export async function updateScoutWebPairingConfig(
  input: UpdateScoutPairingConfigInput,
  currentDirectory?: string,
): Promise<ScoutPairingState> {
  await updateScoutPairingConfig(input, currentDirectory);
  return serializePairingMutation(async () => {
    const supervisorPaths = resolveScoutPairingSupervisorPaths();
    const desiredRunning = readScoutPairingSupervisorIntent(supervisorPaths.intentPath).desiredState === "running";
    if (desiredRunning || isScoutPairingRuntimeRunning()) {
      if (!await requestPairingActionFromSupervisor("restart")) {
        await restartScoutPairingRuntime();
      }
    }
    invalidateScoutWebPairingStateCache();
    return coalescedPairingStateReader(currentDirectory)();
  });
}

export async function decideScoutWebPairingApproval(
  input: DecideScoutPairingApprovalInput,
  currentDirectory?: string,
): Promise<ScoutPairingState> {
  const resolvedConfig = resolveScoutPairingConfig();
  await withScoutPairingBridgeClient(resolvedConfig.port, async (client) => {
    await client.mutation<{ ok: true }>("actionDecide", {
      sessionId: input.sessionId,
      turnId: input.turnId,
      blockId: input.blockId,
      version: input.version,
      decision: input.decision,
      ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    });
  });
  invalidateScoutWebPairingStateCache();
  return coalescedPairingStateReader(currentDirectory)();
}

/** Acknowledges forwarding only; observed session events establish whether it stopped. */
export async function interruptScoutWebPairingTurn(input: { sessionId: string; turnId: string }): Promise<void> {
  const resolvedConfig = resolveScoutPairingConfig();
  await withScoutPairingBridgeClient(resolvedConfig.port, async client => {
    await client.mutation<{ ok: true }>("turnInterrupt", input);
  });
}

/** One host-local decision path for terminal and authenticated HTTP callers. */
export async function decideHostPairingRequest(
  store: PendingPairRequestStore, token: string, decision: "approve" | "deny", currentDirectory: string,
): Promise<{ ok: true; request: PairRequest } | { ok: false; status: 404 | 409 | 503; error: string }> {
  const before = store.get(token);
  if (!before) return { ok: false, status: 404, error: "Unknown or expired pairing request" };
  const request = store.decide(token, decision, "pending");
  if (!request) return { ok: false, status: 409, error: "Pairing request was already answered or expired" };
  // An account peer is already connected and waiting. This row's conditional
  // fulfillment, not a LAN/QR invitation, is its delivery boundary.
  if (request.route === "account") return { ok: true, request };
  try {
    const window = await controlScoutWebApprovalPairing(decision === "approve" ? "open" : "cancel", request, currentDirectory);
    if (decision === "approve" && (!window || "status" in window)) {
      return { ok: false, status: 409, error: "Pairing request window closed; make a new request" };
    }
    if (decision === "approve" && store.get(token)?.status === "denied") {
      await controlScoutWebApprovalPairing("cancel", request, currentDirectory);
      return { ok: false, status: 409, error: "Pairing request was denied" };
    }
  } catch { return { ok: false, status: 503, error: "Pairing authority unavailable" }; }
  return { ok: true, request };
}
