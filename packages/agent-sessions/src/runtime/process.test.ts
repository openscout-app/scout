import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnHarnessProcess } from "./process.ts";

function uncoloredEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "FORCE_COLOR" && key !== "CLICOLOR_FORCE") env[key] = value;
  }
  env.NO_COLOR = "1";
  return env;
}

describe("spawnHarnessProcess", () => {
  test("uses Bun subprocesses under Bun and reads newline-delimited stdout", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-harness-process-"));

    try {
      const child = await spawnHarnessProcess(process.execPath, [
        "--eval",
        `
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  console.log(JSON.stringify({ line }));
  console.error("diagnostic from harness");
  process.exit(0);
}
`,
      ], {
        cwd: tempRoot,
        // The child's console output is compared as text, so the caller's
        // color requests must not reach it.
        env: uncoloredEnv(),
      });

      expect(child.runtime).toBe("bun");
      expect(child.stdin.writable).toBe(true);

      const lines: string[] = [];
      const stdoutEnded = new Promise<void>((resolve) => {
        child.readStdoutLines((line) => lines.push(line), resolve);
      });
      const stderrLines: string[] = [];
      const stderrEnded = new Promise<void>((resolve) => {
        child.readStderrLines((line) => stderrLines.push(line), resolve);
      });
      const exitCode = new Promise<number | null>((resolve) => {
        child.onExit((code) => resolve(code));
      });

      child.stdin.write("hello from scout\n");

      expect(await child.waitForExit(5_000)).toBe(true);
      await stdoutEnded;
      await stderrEnded;
      expect(await exitCode).toBe(0);
      expect(lines).toEqual([JSON.stringify({ line: "hello from scout" })]);
      expect(stderrLines).toEqual(["diagnostic from harness"]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
