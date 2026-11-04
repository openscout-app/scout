import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";

import {
  claimScoutPairingSupervision,
  isScoutPairingFileFromPreviousBoot,
  readScoutPairingProcessPid,
  readScoutPairingSupervisorIntent,
  releaseScoutPairingSupervision,
  resolveScoutPairingSupervisorPaths,
  updateScoutPairingSupervisorIntent,
} from "./pairing-supervisor.ts";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createPaths() {
  const root = mkdtempSync(join(tmpdir(), "openscout-pairing-supervisor-"));
  tempRoots.add(root);
  return resolveScoutPairingSupervisorPaths({ OPENSCOUT_PAIRING_HOME: root });
}

describe("pairing supervisor intent", () => {
  test("persists start, stop, and monotonic restart requests", () => {
    const paths = createPaths();

    expect(readScoutPairingSupervisorIntent(paths.intentPath)).toEqual({
      desiredState: null,
      restartGeneration: 0,
    });
    expect(updateScoutPairingSupervisorIntent("start", paths.intentPath)).toEqual({
      desiredState: "running",
      restartGeneration: 0,
    });

    const firstRestart = updateScoutPairingSupervisorIntent("restart", paths.intentPath);
    const secondRestart = updateScoutPairingSupervisorIntent("restart", paths.intentPath);
    expect(firstRestart.desiredState).toBe("running");
    expect(secondRestart.restartGeneration).toBeGreaterThan(firstRestart.restartGeneration);

    const stopped = updateScoutPairingSupervisorIntent("stop", paths.intentPath);
    expect(stopped).toEqual({
      desiredState: "stopped",
      restartGeneration: secondRestart.restartGeneration,
    });
  });

  test("fails closed on malformed intent and repairs it on an explicit request", () => {
    const paths = createPaths();
    writeFileSync(paths.intentPath, "not-json\n");
    expect(readScoutPairingSupervisorIntent(paths.intentPath)).toEqual({
      desiredState: "stopped",
      restartGeneration: 0,
    });


    expect(updateScoutPairingSupervisorIntent("stop", paths.intentPath)).toEqual({
      desiredState: "stopped",
      restartGeneration: 0,
    });
    expect(JSON.parse(readFileSync(paths.intentPath, "utf8"))).toEqual({
      desiredState: "stopped",
    });
  });
});

describe("pairing supervision ownership", () => {
  test("replaces a stale claim and rejects a second live owner", () => {
    const paths = createPaths();
    writeFileSync(paths.supervisorPidPath, "999999999\n");

    claimScoutPairingSupervision(process.pid, paths.supervisorPidPath);
    expect(readScoutPairingProcessPid(paths.supervisorPidPath)).toBe(process.pid);
    expect(() => claimScoutPairingSupervision(process.pid + 1, paths.supervisorPidPath)).toThrow(
      `Scout pairing is already supervised by pid ${process.pid}.`,
    );

    releaseScoutPairingSupervision(process.pid + 1, paths.supervisorPidPath);
    expect(existsSync(paths.supervisorPidPath)).toBe(true);
    releaseScoutPairingSupervision(process.pid, paths.supervisorPidPath);
    expect(existsSync(paths.supervisorPidPath)).toBe(false);
  });

  test("ignores a pid file from before this boot, even when that pid is alive now", () => {
    const paths = createPaths();
    writeFileSync(paths.supervisorPidPath, `${process.pid}\n`);
    const beforeBootSeconds = (Date.now() - uptime() * 1000 - 120_000) / 1000;
    utimesSync(paths.supervisorPidPath, beforeBootSeconds, beforeBootSeconds);

    expect(readScoutPairingProcessPid(paths.supervisorPidPath)).toBeNull();
    claimScoutPairingSupervision(process.pid + 1, paths.supervisorPidPath);
    expect(readScoutPairingProcessPid(paths.supervisorPidPath)).toBe(process.pid + 1);
  });

  test("dates a file against the boot time, with slack for clock steps", () => {
    const paths = createPaths();
    writeFileSync(paths.supervisorPidPath, `${process.pid}\n`);
    const bootTimeMs = 1_800_000_000_000;
    const setWrittenAt = (ms: number) => utimesSync(paths.supervisorPidPath, ms / 1000, ms / 1000);

    setWrittenAt(bootTimeMs - 31_000);
    expect(isScoutPairingFileFromPreviousBoot(paths.supervisorPidPath, bootTimeMs)).toBe(true);
    setWrittenAt(bootTimeMs - 29_000);
    expect(isScoutPairingFileFromPreviousBoot(paths.supervisorPidPath, bootTimeMs)).toBe(false);
    setWrittenAt(bootTimeMs + 5_000);
    expect(isScoutPairingFileFromPreviousBoot(paths.supervisorPidPath, bootTimeMs)).toBe(false);
  });

  test("counts a file as current when the boot time is unknown or the file is missing", () => {
    const paths = createPaths();
    writeFileSync(paths.supervisorPidPath, `${process.pid}\n`);
    utimesSync(paths.supervisorPidPath, 0, 0);

    expect(isScoutPairingFileFromPreviousBoot(paths.supervisorPidPath, null)).toBe(false);
    expect(isScoutPairingFileFromPreviousBoot(join(paths.supervisorPidPath, "missing"), 1_800_000_000_000)).toBe(false);
  });
});
