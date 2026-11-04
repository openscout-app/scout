import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

import {
  isScoutPairingFileFromPreviousBoot,
  readScoutPairingProcessPid,
} from "@openscout/runtime/pairing-supervisor";

import { pairingPaths, resolvedPairingConfig } from "./config.ts";
import { loadOrCreateIdentity, trustedPeerCount, bytesToHex } from "./security.ts";

export type PairingRuntimeStatus =
  | "stopped"
  | "starting"
  | "connecting"
  | "connected"
  | "paired"
  | "closed"
  | "error";

export type PairingSnapshot = {
  relay: string;
  fallbackRelays?: string[];
  room: string;
  publicKey: string;
  expiresAt: number;
  qrArt: string;
  qrValue: string;
};

/** Account discovery lease, never a QR invitation. */
export type AccountPairingSnapshot = {
  relay: string;
  fallbackRelays?: string[];
  accountRoom: string;
  publicKey: string;
  expiresAt: number;
};

export type PairingRuntimeSnapshot = {
  version: 1;
  pid: number;
  childPid: number | null;
  status: PairingRuntimeStatus;
  statusLabel: string;
  statusDetail: string | null;
  connectedPeerFingerprint: string | null;
  relay: string | null;
  secure: boolean;
  lanDiscoveryAdvertised: boolean;
  workspaceRoot: string | null;
  sessionCount: number;
  identityFingerprint: string | null;
  trustedPeerCount: number;
  pairing: PairingSnapshot | null;
  accountPairing?: AccountPairingSnapshot | null;
  startedAt: number;
  updatedAt: number;
};

type SnapshotSeed = {
  pid: number;
  childPid?: number | null;
  startedAt?: number;
};

export function readPairingRuntimeSnapshot(): PairingRuntimeSnapshot | null {
  const { runtimeStatePath } = pairingPaths();
  if (!existsSync(runtimeStatePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(runtimeStatePath, "utf8")) as PairingRuntimeSnapshot;
    return parsed?.version === 1
      ? { ...parsed, lanDiscoveryAdvertised: parsed.lanDiscoveryAdvertised === true }
      : null;
  } catch {
    return null;
  }
}

export function writePairingRuntimeSnapshot(
  snapshot:
    | (Omit<PairingRuntimeSnapshot, "version" | "lanDiscoveryAdvertised">
      & Partial<Pick<PairingRuntimeSnapshot, "lanDiscoveryAdvertised">>)
    | PairingRuntimeSnapshot,
): PairingRuntimeSnapshot {
  const { rootDir, runtimeStatePath } = pairingPaths();
  mkdirSync(rootDir, { recursive: true });
  const fullSnapshot: PairingRuntimeSnapshot = {
    version: 1,
    ...snapshot,
    lanDiscoveryAdvertised: snapshot.lanDiscoveryAdvertised === true,
  };
  writeJsonAtomically(runtimeStatePath, fullSnapshot);
  return fullSnapshot;
}

export function clearPairingRuntimeSnapshot() {
  const { runtimeStatePath } = pairingPaths();
  try {
    unlinkSync(runtimeStatePath);
  } catch {
    // noop
  }
}

export function readPairingRuntimePid(): number | null {
  return readScoutPairingProcessPid(pairingPaths().runtimePidPath);
}

export function writePairingRuntimePid(pid: number) {
  const { rootDir, runtimePidPath } = pairingPaths();
  mkdirSync(rootDir, { recursive: true });
  writeFileSync(runtimePidPath, `${pid}\n`);
}

export function clearPairingRuntimePid() {
  const { runtimePidPath } = pairingPaths();
  try {
    unlinkSync(runtimePidPath);
  } catch {
    // noop
  }
}

export function isProcessRunning(pid: number | null | undefined) {
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

export function stalePairingRuntimeOwnerPid() {
  const pid = readPairingRuntimePid();
  if (!pid) {
    return null;
  }
  return isProcessRunning(pid) ? null : pid;
}

export function clearStalePairingRuntimeFiles() {
  const { runtimePidPath } = pairingPaths();
  if (!isScoutPairingFileFromPreviousBoot(runtimePidPath) && stalePairingRuntimeOwnerPid() === null) {
    return;
  }
  clearPairingRuntimePid();
  clearPairingRuntimeSnapshot();
}

export function createPairingRuntimeSnapshot(
  seed: SnapshotSeed,
  patch: Pick<
    PairingRuntimeSnapshot,
    "status" | "statusLabel" | "statusDetail" | "connectedPeerFingerprint" | "relay" | "pairing"
  >,
): PairingRuntimeSnapshot {
  const config = resolvedPairingConfig();
  const identity = loadOrCreateIdentity();
  const startedAt = seed.startedAt ?? Date.now();
  return {
    version: 1,
    pid: seed.pid,
    childPid: seed.childPid ?? null,
    status: patch.status,
    statusLabel: patch.statusLabel,
    statusDetail: patch.statusDetail,
    connectedPeerFingerprint: patch.connectedPeerFingerprint,
    relay: patch.relay,
    secure: config.secure,
    lanDiscoveryAdvertised: false,
    workspaceRoot: config.workspaceRoot,
    sessionCount: config.sessions.length,
    identityFingerprint: bytesToHex(identity.publicKey).slice(0, 16),
    trustedPeerCount: trustedPeerCount(),
    pairing: patch.pairing,
    startedAt,
    updatedAt: Date.now(),
  };
}

function writeJsonAtomically(filePath: string, value: unknown) {
  const tempPath = `${filePath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(value, null, 2) + "\n");
  renameSync(tempPath, filePath);
}
