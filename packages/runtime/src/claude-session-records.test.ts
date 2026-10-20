import { execSystemFile, ProbeCommandError } from "./system-probes/exec.js";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  claudeProjectDirectoryForCwd,
  claudeTranscriptPathForSession,
  correlateClaudeSessionForTmuxSession,
  observeClaudeSessionForTmuxSession,
  findLiveClaudeSession,
  parseClaudeSessionRecord,
  parseClaudeTmuxLocation,
  readClaudeSessionRecords,
  readClaudeTranscriptObservedModel,
} from "./claude-session-records.js";

const directories = new Set<string>();

afterEach(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
  directories.clear();
});

function scratchDirectory(): string {
  const directory = join(tmpdir(), `claude-session-records-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(directory, { recursive: true });
  directories.add(directory);
  return directory;
}

/** Shaped like the record Claude Code 2.1.258 writes to ~/.claude/sessions/<pid>.json. */
function record(input: {
  pid: number;
  sessionId: string;
  tmux?: string | null;
  name?: string | null;
  cwd?: string;
  kind?: string;
}): string {
  return JSON.stringify({
    pid: input.pid,
    sessionId: input.sessionId,
    cwd: input.cwd ?? "/Users/art/dev/openscout",
    startedAt: 1789344878460,
    procStart: "Mon Sep 14 00:14:35 2026",
    version: "2.1.258",
    kind: input.kind ?? "interactive",
    entrypoint: "cli",
    pidDomain: "darwin",
    ...(input.tmux === null ? {} : { tmux: input.tmux ?? "session-mtus22pe-emx8hl:@16.%16" }),
    messagingSocketPath: `/tmp/cc-socks/${input.pid}.sock`,
    ...(input.name === null ? {} : { name: input.name ?? "project-woolf-20-relay-agent", nameSource: "user" }),
    status: "busy",
  });
}

describe("Claude session records", () => {
  test("parses the tmux pane and launch name the harness recorded for itself", () => {
    expect(parseClaudeTmuxLocation("session-mtus22pe-emx8hl:@16.%16")).toEqual({
      session: "session-mtus22pe-emx8hl",
      window: "@16",
      pane: "%16",
    });
    expect(parseClaudeTmuxLocation("relay-openscout-claude")).toEqual({
      session: "relay-openscout-claude",
      window: null,
      pane: null,
    });
    expect(parseClaudeTmuxLocation(undefined)).toBeNull();
    expect(parseClaudeTmuxLocation(":@1.%1")).toBeNull();

    const parsed = parseClaudeSessionRecord(record({ pid: 17446, sessionId: "7b81300d-0a9c-4953-8d7f-9274b11ebdfb" }), "/records/17446.json");
    expect(parsed).toEqual(expect.objectContaining({
      pid: 17446,
      sessionId: "7b81300d-0a9c-4953-8d7f-9274b11ebdfb",
      cwd: "/Users/art/dev/openscout",
      kind: "interactive",
      name: "project-woolf-20-relay-agent",
      tmux: { session: "session-mtus22pe-emx8hl", window: "@16", pane: "%16" },
      recordPath: "/records/17446.json",
    }));
    expect(parseClaudeSessionRecord("{not json", "/records/x.json")).toBeNull();
    expect(parseClaudeSessionRecord(JSON.stringify({ pid: 1 }), "/records/1.json")).toBeNull();
  });

  test("reads every parseable record in the sessions directory", async () => {
    const directory = scratchDirectory();
    writeFileSync(join(directory, "10.json"), record({ pid: 10, sessionId: "session-a" }));
    writeFileSync(join(directory, "11.json"), "garbage");
    writeFileSync(join(directory, "notes.txt"), record({ pid: 12, sessionId: "session-c" }));

    const records = await readClaudeSessionRecords({ directory });
    expect(records.map((entry) => entry.sessionId)).toEqual(["session-a"]);
    expect(await readClaudeSessionRecords({ directory: join(directory, "missing") })).toEqual([]);
  });

  test("correlates the one live harness process in the endpoint's tmux session", async () => {
    const directory = scratchDirectory();
    writeFileSync(join(directory, "100.json"), record({ pid: 100, sessionId: "native-woolf" }));
    // Same cwd, different tmux session: a human's interactive session in the
    // same project must never be attributed to the agent.
    writeFileSync(join(directory, "200.json"), record({ pid: 200, sessionId: "native-human", tmux: null, name: null }));

    const correlation = correlateClaudeSessionForTmuxSession({
      tmuxSession: "session-mtus22pe-emx8hl",
      launchName: "project-woolf-20-relay-agent",
      cwd: "/Users/art/dev/openscout",
      records: await readClaudeSessionRecords({ directory }),
      isProcessAlive: () => true,
    });
    expect(correlation).toEqual({
      ok: true,
      record: expect.objectContaining({ pid: 100, sessionId: "native-woolf" }),
      evidence: {
        source: "claude-session-record",
        tmuxSession: "session-mtus22pe-emx8hl",
        tmuxPane: "%16",
        pid: 100,
        recordPath: join(directory, "100.json"),
        nameMatched: true,
        cwdMatched: true,
        liveCandidates: 1,
      },
    });
  });

  test("a record whose process is gone is not evidence", async () => {
    const directory = scratchDirectory();
    writeFileSync(join(directory, "100.json"), record({ pid: 100, sessionId: "native-stale" }));

    expect(correlateClaudeSessionForTmuxSession({
      tmuxSession: "session-mtus22pe-emx8hl",
      records: await readClaudeSessionRecords({ directory }),
      isProcessAlive: () => false,
    })).toEqual({ ok: false, reason: "no_live_record", candidates: 1, live: 0 });
    expect(correlateClaudeSessionForTmuxSession({
      tmuxSession: "session-nobody",
      records: await readClaudeSessionRecords({ directory }),
      isProcessAlive: () => true,
    })).toEqual({ ok: false, reason: "no_record", candidates: 0, live: 0 });
  });

  test("prefers the launch name Scout passed when several harnesses share the pane, and declines otherwise", async () => {
    const directory = scratchDirectory();
    writeFileSync(join(directory, "100.json"), record({ pid: 100, sessionId: "native-agent", name: "project-woolf-20-relay-agent" }));
    // A nested claude the agent started from its own pane: same tmux session.
    writeFileSync(join(directory, "101.json"), record({ pid: 101, sessionId: "native-nested", name: null, tmux: "session-mtus22pe-emx8hl:@16.%16" }));

    const named = correlateClaudeSessionForTmuxSession({
      tmuxSession: "session-mtus22pe-emx8hl",
      launchName: "project-woolf-20-relay-agent",
      records: await readClaudeSessionRecords({ directory }),
      isProcessAlive: () => true,
    });
    expect(named.ok && named.record.sessionId).toBe("native-agent");
    expect(named.ok && named.evidence.liveCandidates).toBe(2);

    // Without the launch name, two interactive processes in one cwd are a tie.
    expect(correlateClaudeSessionForTmuxSession({
      tmuxSession: "session-mtus22pe-emx8hl",
      records: await readClaudeSessionRecords({ directory }),
      isProcessAlive: () => true,
    })).toEqual({ ok: false, reason: "ambiguous", candidates: 2, live: 2 });
  });

  test("reads the answering model from the transcript tail and locates transcripts the way Claude names them", async () => {
    const directory = scratchDirectory();
    const env = { CLAUDE_CONFIG_DIR: directory } as NodeJS.ProcessEnv;
    expect(claudeProjectDirectoryForCwd("/Users/art/.codex/worktrees/8722/openscout", env))
      .toBe(join(directory, "projects", "-Users-art--codex-worktrees-8722-openscout"));

    const projectDirectory = claudeProjectDirectoryForCwd("/Users/art/dev/openscout", env);
    mkdirSync(projectDirectory, { recursive: true });
    const transcriptPath = join(projectDirectory, "native-woolf.jsonl");
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-opus-5", content: [] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", model: "<synthetic>", content: [] } }),
      JSON.stringify({ type: "progress", data: { model: "claude-haiku-4-5-20251001" } }),
    ];
    writeFileSync(transcriptPath, `${lines.join("\n")}\n`);

    expect(claudeTranscriptPathForSession("/Users/art/dev/openscout", "native-woolf", env)).toBe(transcriptPath);
    expect(claudeTranscriptPathForSession("/Users/art/dev/openscout", "missing", env)).toBeNull();
    expect(claudeTranscriptPathForSession("/Users/art/dev/openscout", "../escape", env)).toBeNull();
    expect(await readClaudeTranscriptObservedModel(transcriptPath)).toBe("claude-opus-5");
    // Tail reads skip the partial first line without losing the newest record.
    expect(await readClaudeTranscriptObservedModel(transcriptPath, { maxBytes: 1024 })).toBe("claude-opus-5");
    expect(await readClaudeTranscriptObservedModel(join(directory, "nope.jsonl"))).toBeNull();
  });
});

const tmuxSession = "session-mtus22pe-emx8hl";
const livePane = { session: tmuxSession, window: "@16", pane: "%16", pid: 100, procStart: "Mon Sep 14 00:14:35 2026" };

test("observes the actual pane process and rejects stale records, reused PIDs, and mismatched launch identity", async () => {
  const directory = scratchDirectory();
  writeFileSync(join(directory, "100.json"), record({ pid: 100, sessionId: "native-agent" }));
  const base = { tmuxSession, directory, launchName: "project-woolf-20-relay-agent", cwd: "/Users/art/dev/openscout" };
  expect((await observeClaudeSessionForTmuxSession({ ...base, probe: async () => [livePane] })).ok).toBe(true);
  for (const changed of [{ pid: 101 }, { pane: "%17" }, { window: "@17" }, { procStart: "Tue Sep 15 00:14:35 2026" }]) {
    expect((await observeClaudeSessionForTmuxSession({ ...base, probe: async () => [{ ...livePane, ...changed }] })).ok).toBe(false);
  }
  expect((await observeClaudeSessionForTmuxSession({ ...base, launchName: "foreign-relay-agent", probe: async () => [livePane] })).ok).toBe(false);
  expect((await observeClaudeSessionForTmuxSession({ ...base, cwd: "/foreign", probe: async () => [livePane] })).ok).toBe(false);
  expect(await findLiveClaudeSession("native-agent", { directory, probe: async () => [livePane] })).toEqual(expect.objectContaining({ sessionId: "native-agent" }));
  expect(await findLiveClaudeSession("native-agent", { directory, probe: async () => [{ ...livePane, procStart: "different" }] })).toBeNull();
  await expect(findLiveClaudeSession("native-agent", { directory, probe: async () => { throw new Error("probe timed out"); } })).rejects.toThrow("probe timed out");
});

test("observation reads only the pane PID file and rejects oversized process records", async () => {
  const directory = scratchDirectory();
  writeFileSync(join(directory, "100.json"), " ".repeat(65537));
  writeFileSync(join(directory, "999.json"), record({ pid: 999, sessionId: "unrelated" }));
  expect((await observeClaudeSessionForTmuxSession({ tmuxSession, directory, probe: async () => [livePane] })).ok).toBe(false);
  writeFileSync(join(directory, "100.json"), record({ pid: 100, sessionId: "correct" }));
  expect((await observeClaudeSessionForTmuxSession({ tmuxSession, directory, probe: async () => [livePane] })).ok).toBe(true);
});


test("resumed processes cannot claim runtime from an earlier transcript turn", async () => {
  const directory = scratchDirectory();
  const path = join(directory, "session.jsonl");
  writeFileSync(path, JSON.stringify({ type: "assistant", timestamp: "2026-09-13T00:00:00Z", message: { model: "old-model" } }) + "\n");
  expect(await readClaudeTranscriptObservedModel(path, { since: Date.parse("2026-09-14T00:00:00Z") })).toBeNull();
  expect(await readClaudeTranscriptObservedModel(path, { since: Date.parse("2026-09-12T00:00:00Z") })).toBe("old-model");
});


test("a missing tmux session is stale evidence, while command failures retain diagnostics", async () => {
  const directory = scratchDirectory();
  writeFileSync(join(directory, "100.json"), record({ pid: 100, sessionId: "stale" }));
  const probe = async () => { throw new ProbeCommandError("tmux exited with 1", { code: "exit", exitCode: 1, stderr: "can't find window: missing" }); };
  expect(await observeClaudeSessionForTmuxSession({ tmuxSession, directory, probe })).toEqual({ ok: false, reason: "no_live_record", candidates: 0, live: 0 });
  expect(await findLiveClaudeSession("stale", { directory, probe })).toBeNull();
  await expect(execSystemFile(process.execPath, ["-e", "process.stderr.write('diagnostic'); process.exit(7)"], { timeoutMs: 2000 }))
    .rejects.toMatchObject({ code: "exit", exitCode: 7, stderr: "diagnostic" });
});

test("preserves native registry status timestamps and waitingFor verbatim", () => {
  for (const status of ["busy", "idle", "shell", "waiting"]) {
    const parsed = parseClaudeSessionRecord(JSON.stringify({
      pid: 123, sessionId: "native", status,
      statusUpdatedAt: 1792000000100, updatedAt: 1792000000200,
      waitingFor: "  permission: Bash\n",
    }), "/records/123.json");
    expect(parsed).toMatchObject({ status, statusUpdatedAt: 1792000000100,
      updatedAt: 1792000000200, waitingFor: "  permission: Bash\n" });
  }
  expect(parseClaudeSessionRecord('{"pid":123,"sessionId":"native","status":"unknown"}', "/records/123.json")?.status).toBeNull();
});
