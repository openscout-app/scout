import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifySshFailure,
  machineReadinessArgv,
  MACHINE_READINESS_SCRIPT,
  probeMachineReadiness,
} from "./machine-readiness.ts";
import { defaultSshExec, type SshExecInput } from "../mesh-ssh-enroll.ts";

const MINI = [
  "os=Darwin",
  "arch=arm64",
  "host=mini",
  "macos=27.0.1",
  "tool.scout=/Users/guest/.bun/bin/scout",
  "tool.herdr=/opt/homebrew/bin/herdr",
  "tool.tmux=/opt/homebrew/bin/tmux",
  "tool.claude=/opt/homebrew/bin/claude",
  "tool.codex=/opt/homebrew/bin/codex",
  "scout.version=0.3.6",
  "",
].join("\n");

describe("machine readiness", () => {
  test("ssh runs the fixed script from stdin, in batch mode", async () => {
    const calls: SshExecInput[] = [];
    const reading = await probeMachineReadiness({
      destination: "mini",
      now: () => 1000,
      exec: async (input) => {
        calls.push(input);
        return { stdout: MINI, stderr: "", exitCode: 0 };
      },
    });
    expect(calls[0]!.argv).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "mini", "/bin/sh", "-s"]);
    expect(calls[0]!.stdin).toBe(MACHINE_READINESS_SCRIPT);
    expect(reading).toMatchObject({
      testedAt: 1000,
      via: "ssh",
      reachable: true,
      os: "Darwin",
      osVersion: "27.0.1",
      scoutVersion: "0.3.6",
    });
    expect(reading.tools.orca).toBeNull();
    expect(reading.tools.codex).toBe("/opt/homebrew/bin/codex");
  });

  test("this machine is read locally", () => {
    expect(machineReadinessArgv(null)).toEqual(["/bin/sh", "-s"]);
  });

  test("a destination that could be an ssh option is refused", async () => {
    const reading = await probeMachineReadiness({
      destination: "-oProxyCommand=evil",
      exec: async () => {
        throw new Error("must not run");
      },
    });
    expect(reading.reachable).toBe(false);
    expect(reading.failure).toBe("error");
  });

  test("ssh failures become short reasons", async () => {
    const reading = await probeMachineReadiness({
      destination: "art",
      exec: async () => ({
        stdout: "",
        stderr: "ssh: Could not resolve hostname arts-mac-mini.tail1e8e67.ts.net: nodename nor servname provided, or not known\n",
        exitCode: 255,
      }),
    });
    expect(reading).toMatchObject({ reachable: false, failure: "unresolved" });
    expect(classifySshFailure("arach@x: Permission denied (publickey).").failure).toBe("denied");
    expect(classifySshFailure("ssh: connect to host x port 22: Operation timed out").failure).toBe("timeout");
    expect(classifySshFailure("Host key verification failed.").failure).toBe("host-key");
  });

  test("a scout on PATH without a readable version reads as unknown, not missing", async () => {
    const reading = await probeMachineReadiness({
      destination: null,
      exec: async () => ({ stdout: "os=Linux\ntool.scout=/usr/bin/scout\n", stderr: "", exitCode: 0 }),
    });
    expect(reading.tools.scout).toBe("/usr/bin/scout");
    expect(reading.scoutVersion).toBeNull();
  });
});

describe("probe timeouts", () => {
  test("a process that ignores TERM, and what it started, are gone after the timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-probe-"));
    const script = `trap '' TERM; (trap '' TERM; echo $$ > ${dir}/child; while :; do sleep 1; done) & echo $$ > ${dir}/leader; while :; do sleep 1; done`;
    await expect(defaultSshExec({ argv: ["/bin/sh", "-c", script], timeoutMs: 300 })).rejects.toThrow("timed out");
    await Bun.sleep(900);
    const alive = (file: string) => {
      try {
        process.kill(Number(readFileSync(join(dir, file), "utf8").trim()), 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive("leader")).toBe(false);
    expect(alive("child")).toBe(false);
  });
});
