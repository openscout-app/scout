import { mkdir, open, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import { resolveOpenScoutSupportPaths } from "@openscout/runtime/config";

type ScoutCoreCommandName = "setup" | "doctor" | "runtimes";

type ScoutCoreCommandLockPayload = {
  command: ScoutCoreCommandName;
  pid: number;
  startedAt: number;
  host: string;
};

const SCOUT_CORE_COMMAND_LOCK_FILE = "scout-core-command.lock.json";

export class ScoutCoreCommandBusyError extends Error {
  readonly runningCommand: ScoutCoreCommandName;
  readonly runningPid: number;
  readonly startedAt: number;

  constructor(payload: ScoutCoreCommandLockPayload) {
    const startedAtLabel = new Date(payload.startedAt).toISOString();
    super(
      `another core Scout command is already running (${payload.command}, pid ${payload.pid}, started ${startedAtLabel} on ${payload.host})`,
    );
    this.name = "ScoutCoreCommandBusyError";
    this.runningCommand = payload.command;
    this.runningPid = payload.pid;
    this.startedAt = payload.startedAt;
  }
}

function scoutCoreCommandLockPath(): string {
  return join(resolveOpenScoutSupportPaths().runtimeDirectory, "locks", SCOUT_CORE_COMMAND_LOCK_FILE);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const code = String((error as { code?: string }).code ?? "");
      if (code === "ESRCH") {
        return false;
      }
      if (code === "EPERM") {
        return true;
      }
    }
    return false;
  }
}

async function readLockPayload(lockPath: string): Promise<ScoutCoreCommandLockPayload | null> {
  try {
    const raw = JSON.parse(await readFile(lockPath, "utf8")) as Partial<ScoutCoreCommandLockPayload>;
    if (
      (raw.command === "setup" || raw.command === "doctor" || raw.command === "runtimes")
      && typeof raw.pid === "number"
      && typeof raw.startedAt === "number"
      && typeof raw.host === "string"
    ) {
      return {
        command: raw.command,
        pid: raw.pid,
        startedAt: raw.startedAt,
        host: raw.host,
      };
    }
  } catch {
    return null;
  }

  return null;
}

export async function acquireScoutCoreCommandLock(command: ScoutCoreCommandName): Promise<() => Promise<void>> {
  const lockPath = scoutCoreCommandLockPath();
  await mkdir(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const payload: ScoutCoreCommandLockPayload = {
      command,
      pid: process.pid,
      startedAt: Date.now(),
      host: hostname(),
    };

    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
      } finally {
        await handle.close();
      }

      let released = false;
      return async () => {
        if (released) {
          return;
        }
        released = true;
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || (error as { code?: string }).code !== "EEXIST") {
        throw error;
      }

      const existing = await readLockPayload(lockPath);
      if (existing && isProcessAlive(existing.pid)) {
        throw new ScoutCoreCommandBusyError(existing);
      }

      await rm(lockPath, { force: true });
    }
  }

  throw new Error(`failed to acquire Scout core command lock at ${lockPath}`);
}

export async function withScoutCoreCommandLock<T>(
  command: ScoutCoreCommandName,
  run: () => Promise<T>,
): Promise<T> {
  const release = await acquireScoutCoreCommandLock(command);
  try {
    return await run();
  } finally {
    await release();
  }
}
