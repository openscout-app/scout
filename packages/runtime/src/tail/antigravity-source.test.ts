import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AntigravitySource } from "./antigravity-source.js";
import { readTailEventsForSession } from "./service.js";
import type { DiscoveredProcess, DiscoverySnapshot } from "./types.js";

test("Antigravity discovery and history preserve native identity across conversations in one workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "scout-agy-"));
  const previous = process.env.OPENSCOUT_TAIL_ANTIGRAVITY_ROOT;
  process.env.OPENSCOUT_TAIL_ANTIGRAVITY_ROOT = root;
  const first = "11111111-1111-4111-8111-111111111111", second = "22222222-2222-4222-8222-222222222222";
  const empty = "33333333-3333-4333-8333-333333333333";
  const cwd = join(root, "a project");
  const logPath = (id: string) => join(root, "brain", id, ".system_generated", "logs");
  try {
    const index = new Database(join(root, "conversation_summaries.db"));
    try {
      index.exec("CREATE TABLE conversation_summaries (conversation_id, title, workspace_uris, status, last_modified_time)");
      for (const id of [first, second, empty]) {
        index.query("INSERT INTO conversation_summaries VALUES (?,?,?,?,?)").run(id, "Native title",
          JSON.stringify([pathToFileURL(cwd).href]), "CASCADE_RUN_STATUS_IDLE", new Date().toISOString());
        mkdirSync(logPath(id), { recursive: true });
      }
    } finally { index.close(); }

    const steps = [
      { type: "USER_INPUT", source: "USER_EXPLICIT", content: "<USER_REQUEST>Question</USER_REQUEST><ADDITIONAL_METADATA>private</ADDITIONAL_METADATA>" },
      { type: "PLANNER_RESPONSE", thinking: "private", tool_calls: [{ name: "list_files", args: { token: "private" } }] },
      { type: "PLANNER_RESPONSE", thinking: "private", content: "Answer" },
      { type: "PLANNER_RESPONSE", thinking: "private" },
      { type: "GENERIC", content: "private" },
    ].map((step, step_index) => JSON.stringify({ ...step, step_index, created_at: "2025-01-01T00:00:00Z" })).join("\n");
    for (const id of [first, second]) writeFileSync(join(logPath(id), "transcript.jsonl"), steps + "\n");

    const processes: DiscoveredProcess[] = [{ pid: 7, ppid: 1, command: "agy", etime: "01:00", cwd,
      parentChain: [], source: "antigravity", harness: "unattributed", nativeSessionId: first }];
    const transcripts = await AntigravitySource.discoverTranscripts(processes, "hot");
    expect(transcripts.map(row => row.sessionId).sort()).toEqual([first, second]);
    expect(transcripts[0]).toMatchObject({ cwd, project: "a project", title: "Native title", status: "idle" });
    const discovery: DiscoverySnapshot = { processes, transcripts, generatedAt: Date.now(),
      totals: { total: 1, scoutManaged: 0, hudsonManaged: 0, unattributed: 1, transcripts: 2 } };
    const a = await readTailEventsForSession(first, { discovery });
    const b = await readTailEventsForSession(second, { discovery });
    expect(a?.events.map(e => [e.kind, e.summary, e.pid])).toEqual([
      ["user", "Question", 7], ["tool", "list_files", 7], ["assistant", "Answer", 7],
    ]);
    expect(b?.events[0].pid).toBeLessThan(0);
    expect(JSON.stringify(a?.events)).not.toContain("private");
    expect(await readTailEventsForSession("transcript", { discovery })).toBeNull();
    expect((await readTailEventsForSession(join(logPath(second), "transcript.jsonl"), { discovery }))?.transcript.sessionId).toBe(second);

    const old = new Date(0);
    utimesSync(join(logPath(first), "transcript.jsonl"), old, old);
    expect((await AntigravitySource.discoverTranscripts([], "hot")).map(t => t.sessionId)).toEqual([second]);
    expect(AntigravitySource.findTranscript?.(first)?.sessionId).toBe(first);
    expect(AntigravitySource.findTranscript?.("../" + first)).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.OPENSCOUT_TAIL_ANTIGRAVITY_ROOT;
    else process.env.OPENSCOUT_TAIL_ANTIGRAVITY_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
