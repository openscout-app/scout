import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, uptime } from "node:os";
import { dirname, join } from "node:path";
import { resolveOpenScoutPairingHomeForEnv } from "./support-paths.js";

export const SCOUT_PAIRING_SUPERVISOR_INTENT_FILE = "supervisor.json";
export const SCOUT_PAIRING_RUNTIME_PID_FILE = "runtime.pid";
export const SCOUT_PAIRING_SUPERVISOR_PID_FILE = "supervisor.pid";

export type ScoutPairingControlAction = "start" | "stop" | "restart";
export type ScoutPairingDesiredState = "running" | "stopped";

export type ScoutPairingSupervisorIntent = {
  desiredState: ScoutPairingDesiredState | null;
  restartGeneration: number;
};

export type ScoutPairingSupervisorPaths = {
  rootDir: string;
  intentPath: string;
  runtimePidPath: string;
  supervisorPidPath: string;
};

type PairingIntentRecord = {
  desiredState?: ScoutPairingDesiredState;
  restartGeneration?: number;
};

export function resolveScoutPairingSupervisorPaths(
  env: NodeJS.ProcessEnv = process.env,
): ScoutPairingSupervisorPaths {
  const rootDir = resolveOpenScoutPairingHomeForEnv(env);
  return {
    rootDir,
    intentPath: join(rootDir, SCOUT_PAIRING_SUPERVISOR_INTENT_FILE),
    runtimePidPath: join(rootDir, SCOUT_PAIRING_RUNTIME_PID_FILE),
    supervisorPidPath: join(rootDir, SCOUT_PAIRING_SUPERVISOR_PID_FILE),
  };
}

export function readScoutPairingSupervisorIntent(
  intentPath: string = resolveScoutPairingSupervisorPaths().intentPath,
): ScoutPairingSupervisorIntent {
  const intent = readPairingIntent(intentPath);
  return {
    desiredState: intent.desiredState === "running" || intent.desiredState === "stopped"
      ? intent.desiredState
      : null,
    restartGeneration: validRestartGeneration(intent.restartGeneration),
  };
}

export function updateScoutPairingSupervisorIntent(
  action: ScoutPairingControlAction,
  intentPath: string = resolveScoutPairingSupervisorPaths().intentPath,
): ScoutPairingSupervisorIntent {
  const intent = readPairingIntent(intentPath);
  intent.desiredState = action === "stop" ? "stopped" : "running";
  if (action === "restart") {
    intent.restartGeneration = Math.max(
      Date.now(),
      validRestartGeneration(intent.restartGeneration) + 1,
    );
  }
  writePairingIntent(intentPath, intent);
  return readScoutPairingSupervisorIntent(intentPath);
}

// Absorbs small clock steps right after boot, so a pid file from this boot still counts.
const PID_FILE_BOOT_SLACK_MS = 30_000;

function currentBootTimeMs(): number | null {
  try {
    const seconds = uptime();
    return Number.isFinite(seconds) && seconds > 0 ? Date.now() - seconds * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * True when the file at `path` was last written before this boot. When the boot
 * time cannot be read, the file counts as current.
 */
export function isScoutPairingFileFromPreviousBoot(
  path: string,
  bootTimeMs: number | null = currentBootTimeMs(),
): boolean {
  if (bootTimeMs === null) return false;
  try {
    return statSync(path).mtimeMs < bootTimeMs - PID_FILE_BOOT_SLACK_MS;
  } catch {
    return false;
  }
}

/**
 * The pid recorded at `path`, or null. A file written before this boot names a
 * process that ended with the previous boot, and the pid may now belong to any
 * process, so it counts as absent.
 */
export function readScoutPairingProcessPid(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    if (isScoutPairingFileFromPreviousBoot(path)) return null;
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function isScoutPairingProcessRunning(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLiveScoutPairingSupervisorPid(
  supervisorPidPath: string = resolveScoutPairingSupervisorPaths().supervisorPidPath,
): number | null {
  const pid = readScoutPairingProcessPid(supervisorPidPath);
  return isScoutPairingProcessRunning(pid) ? pid : null;
}

export function claimScoutPairingSupervision(
  pid: number = process.pid,
  supervisorPidPath: string = resolveScoutPairingSupervisorPaths().supervisorPidPath,
): void {
  const currentPid = readLiveScoutPairingSupervisorPid(supervisorPidPath);
  if (currentPid && currentPid !== pid) {
    throw new Error(`Scout pairing is already supervised by pid ${currentPid}.`);
  }
  mkdirSync(dirname(supervisorPidPath), { recursive: true });
  writeFileAtomically(supervisorPidPath, `${pid}\n`);
}

export function releaseScoutPairingSupervision(
  pid: number = process.pid,
  supervisorPidPath: string = resolveScoutPairingSupervisorPaths().supervisorPidPath,
): void {
  if (readScoutPairingProcessPid(supervisorPidPath) !== pid) return;
  rmSync(supervisorPidPath, { force: true });
}

function readPairingIntent(intentPath: string): PairingIntentRecord {
  if (!existsSync(intentPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(intentPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { desiredState: "stopped" };
    }
    const intent = parsed as PairingIntentRecord;
    if (intent.desiredState !== "running" && intent.desiredState !== "stopped") {
      intent.desiredState = "stopped";
    }
    return intent;
  } catch {
    return { desiredState: "stopped" };
  }
}

function writePairingIntent(intentPath: string, intent: PairingIntentRecord): void {
  mkdirSync(dirname(intentPath), { recursive: true });
  writeFileAtomically(intentPath, `${JSON.stringify(intent, null, 2)}\n`);
}

function writeFileAtomically(path: string, contents: string): void {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, contents);
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function validRestartGeneration(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}
