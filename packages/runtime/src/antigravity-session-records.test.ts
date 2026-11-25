import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ANTIGRAVITY_WAITING_TTL_MS,
  readAntigravitySessionRecords,
  removeAntigravitySessionRecord,
  writeAntigravitySessionRecord,
} from "./antigravity-session-records.js";

const dirs = new Set<string>();
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.clear();
});

describe("antigravity session records", () => {
  test("writes, reads, expires, and removes waiting records cleanly", async () => {
    const directory = mkdtempSync(join(tmpdir(), "scout-agy-records-"));
    dirs.add(directory);
    const sessionId = "3a102f26-6237-46c4-ae20-6152148eecaa";
    const now = 1_800_000_000_000;

    await writeAntigravitySessionRecord({
      sessionId,
      cwd: "/tmp/project",
      transcriptPath: `/tmp/brain/${sessionId}/.system_generated/logs/transcript.jsonl`,
      status: "waiting",
      waitingFor: "Unsandboxed command: gh pr create",
      statusUpdatedAt: now,
      toolCall: { id: "toolu_1", name: "run_command", args: { CommandLine: "gh pr create", BypassSandbox: true } },
    }, { directory });

    const active = await readAntigravitySessionRecords({ directory, now: now + 5_000 });
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      sessionId,
      status: "waiting",
      waitingFor: "Unsandboxed command: gh pr create",
      toolCall: { id: "toolu_1", name: "run_command" },
    });

    const expired = await readAntigravitySessionRecords({ directory, now: now + ANTIGRAVITY_WAITING_TTL_MS + 1 });
    expect(expired).toEqual([]);

    await removeAntigravitySessionRecord(sessionId, { directory });
    expect(await readAntigravitySessionRecords({ directory, now })).toEqual([]);
  });
});
