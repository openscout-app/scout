import { describe, expect, test } from "bun:test";

import { exitAfterCompletedCommand, shouldExitAfterCommand } from "./completed-command-exit.ts";

describe("exit after a completed command", () => {
  test("ask and the commands that probe every host exit once answered", () => {
    for (const command of ["ask", "hosts", "check", "locate"]) {
      expect(shouldExitAfterCommand(command, [])).toBe(true);
    }
  });

  test("a tracked send exits; a plain send and other commands keep their natural exit", () => {
    expect(shouldExitAfterCommand("send", ["--tracked"])).toBe(true);
    expect(shouldExitAfterCommand("send", [])).toBe(false);
    expect(shouldExitAfterCommand("mcp", [])).toBe(false);
    expect(shouldExitAfterCommand(null, [])).toBe(false);
  });

  test("exits only after stdout and stderr have flushed, with the command's exit code", async () => {
    const events: string[] = [];
    const stream = (name: string) => ({
      write(_chunk: string, callback: () => void) {
        setTimeout(() => {
          events.push(`${name} flushed`);
          callback();
        }, 5);
        return false;
      },
    });
    await exitAfterCompletedCommand("hosts", [], {
      stdout: stream("stdout"),
      stderr: stream("stderr"),
      exit: (code) => events.push(`exit ${code}`),
      exitCode: () => 3,
    });
    expect(events.at(-1)).toBe("exit 3");
    expect(events.slice(0, 2).sort()).toEqual(["stderr flushed", "stdout flushed"]);
  });

  test("leaves the process alone for a command that keeps running", async () => {
    let exited = false;
    await exitAfterCompletedCommand("mcp", [], {
      stdout: { write: (_c, cb) => (cb(), true) },
      stderr: { write: (_c, cb) => (cb(), true) },
      exit: () => {
        exited = true;
      },
      exitCode: () => undefined,
    });
    expect(exited).toBe(false);
  });
});
