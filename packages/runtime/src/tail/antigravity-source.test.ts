import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AntigravitySource } from "./antigravity-source.js";
import { brokerRouter } from "../broker-trpc-router.js";
import { __testing, readTailEventsForSession, readTailSessionUsage } from "./service.js";
import type { DiscoveredProcess, DiscoveredTranscript, DiscoverySnapshot, TailEvent } from "./types.js";

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
      { type: "USER_INPUT", source: "USER_EXPLICIT", content: "Question" },
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
      ["user", "Question", 7], ["tool", "list_files", 7], ["assistant", "Answer", 7], ["user", "Question", 7],
    ]);
    expect(b?.events[0].pid).toBeLessThan(0);
    const resumed = { ...discovery, processes: [{ ...processes[0]!, pid: 9, nativeSessionId: second }] };
    expect((await readTailEventsForSession(second, { discovery: resumed }))?.events[0]?.pid).toBe(9);
    expect((await readTailEventsForSession(first, { discovery: resumed }))?.events[0]?.pid).toBeLessThan(0);
    expect(JSON.stringify(a?.events)).not.toContain("private");
    expect(await readTailEventsForSession("transcript", { discovery })).toBeNull();
    expect((await readTailEventsForSession(join(logPath(second), "transcript.jsonl"), { discovery }))?.transcript.sessionId).toBe(second);

    // Exercise the same recent query that scout tail uses, with another harness
    // occupying the newest slot and a file-backed conversation outside discovery.
    const caller = brokerRouter.createCaller({});
    const removeSubscriber = __testing.addPublicSubscriberWithoutLoop(() => {});
    try {
      await __testing.refreshDiscovery([{ ...AntigravitySource, discoverProcesses: () => processes }]);
      const history = await caller.tail.recent({ sources: ["antigravity"], transcripts: true, limit: 20 });
      const repeats = history.events.filter(e => e.sessionId === first && e.summary === "Question");
      expect(repeats.map(e => e.id).sort()).toEqual([`antigravity:${first}:0`, `antigravity:${first}:5`]);
    } finally {
      removeSubscriber();
      __testing.clearWatchers();
    }
    await __testing.refreshDiscovery([{ ...AntigravitySource, discoverProcesses: () => processes }]);
    const reply = a!.events.at(-1)!;
    __testing.pushEvent({ ...reply, id: "hidden", ts: reply.ts + 1, source: "codex", kind: "tool" });
    expect((await caller.tail.recent({ plain: true, limit: 1 })).events).toEqual([]);
    const visible = await caller.tail.recent({ plain: true, limit: 1, transcripts: true });
    expect(visible.events).toHaveLength(1);
    expect(visible.events[0]?.source).toBe("antigravity");
    __testing.pushEvent(reply);
    __testing.pushEvent({ ...reply, id: "newer", source: "codex", ts: reply.ts + 1 });
    const filter = { limit: 1, sources: ["antigravity"] };
    expect((await caller.tail.recent(filter)).events.map(event => event.id)).toEqual([reply.id]);
    expect((await caller.tail.recent({ ...filter, transcripts: true })).events).toHaveLength(1);
    const old = new Date(0);
    utimesSync(join(logPath(first), "transcript.jsonl"), old, old);
    expect((await AntigravitySource.discoverTranscripts([], "hot")).map(t => t.sessionId)).toEqual([second]);
    __testing.resetTailEventBuffers();
    await __testing.refreshDiscovery([{ ...AntigravitySource, discoverProcesses: () => processes }]);
    const exact = { ...filter, transcripts: true, sessionId: first };
    expect((await caller.tail.recent(exact)).events[0]?.sessionId).toBe(first);
    expect((await caller.tail.recent({ ...exact, sources: ["other"] })).events).toEqual([]);
    expect(AntigravitySource.findTranscript?.("../" + first)).toBeNull();
  } finally {
    __testing.clearWatchers();
    __testing.resetDiscovery();
    __testing.resetTailEventBuffers();
    if (previous === undefined) delete process.env.OPENSCOUT_TAIL_ANTIGRAVITY_ROOT;
    else process.env.OPENSCOUT_TAIL_ANTIGRAVITY_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Antigravity emits structured tool events, diffs, multi-tool batches, failed exit codes, and usage", async () => {
  const root = mkdtempSync(join(tmpdir(), "scout-agy-tools-"));
  const previous = process.env.OPENSCOUT_TAIL_ANTIGRAVITY_ROOT;
  process.env.OPENSCOUT_TAIL_ANTIGRAVITY_ROOT = root;
  const sessionId = "44444444-4444-4444-8444-444444444444";
  const cwd = join(root, "workspace");
  const logDir = join(root, "brain", sessionId, ".system_generated", "logs");
  try {
    mkdirSync(logDir, { recursive: true });
    const index = new Database(join(root, "conversation_summaries.db"));
    try {
      index.exec("CREATE TABLE conversation_summaries (conversation_id, title, workspace_uris, status, last_modified_time)");
      index.query("INSERT INTO conversation_summaries VALUES (?,?,?,?,?)").run(
        sessionId,
        "Rich tool trace",
        JSON.stringify([pathToFileURL(cwd).href]),
        "CASCADE_RUN_STATUS_BUSY",
        new Date().toISOString(),
      );
    } finally {
      index.close();
    }

    const steps = [
      {
        type: "USER_INPUT",
        source: "USER_EXPLICIT",
        content: "<USER_REQUEST>Update the session header and run tests</USER_REQUEST>",
      },
      {
        type: "PLANNER_RESPONSE",
        source: "MODEL",
        model: "gemini-4-carbon-high",
        input_tokens: 1200,
        cache_read_tokens: 4000,
        output_tokens: 320,
        content: "Reading the header and updating the checklist.",
        tool_calls: [
          {
            name: "update_steps",
            args: {
              steps: JSON.stringify([
                { title: "Audit header", status: "done" },
                { title: "Patch header", status: "in_progress" },
              ]),
            },
          },
          {
            name: "read_file",
            args: {
              Path: JSON.stringify("/workspace/src/Header.tsx"),
              StartLine: JSON.stringify(1),
              EndLine: JSON.stringify(60),
            },
          },
          {
            name: "edit_file",
            args: {
              Path: JSON.stringify("/workspace/src/Header.tsx"),
              Target: JSON.stringify("const tint = null;\nreturn <div />;"),
              Replacement: JSON.stringify("const tint = \"#4285f4\";\nconst size = 14;\nreturn <div />;"),
            },
          },
        ],
      },
      { type: "GENERIC", source: "MODEL", content: "OK" },
      { type: "GENERIC", source: "MODEL", content: "Showing lines 1-60" },
      { type: "GENERIC", source: "MODEL", content: "Made 1 replacement" },
      {
        type: "PLANNER_RESPONSE",
        source: "MODEL",
        model: "gemini-4-carbon-high",
        input_tokens: 800,
        cache_read_tokens: 5200,
        output_tokens: 140,
        tool_calls: [
          {
            name: "run_command",
            args: {
              CommandLine: JSON.stringify("bun test src/Header.test.tsx"),
              toolSummary: JSON.stringify("Run header unit tests"),
            },
          },
        ],
      },
      {
        type: "GENERIC",
        source: "MODEL",
        content: "Created At: 2026-11-24T20:00:01Z\nCommand exited with code 2.\n\nCommand output:\n1 fail",
      },
    ].map((step, step_index) => JSON.stringify({
      ...step,
      step_index,
      created_at: `2026-11-24T20:00:0${step_index}Z`,
    })).join("\n");
    writeFileSync(join(logDir, "transcript.jsonl"), `${steps}\n`);

    const transcripts = await AntigravitySource.discoverTranscripts([], "hot");
    expect(transcripts[0]?.status).toBe("busy");
    const discovery: DiscoverySnapshot = {
      processes: [],
      transcripts,
      generatedAt: Date.now(),
      totals: { total: 0, scoutManaged: 0, hudsonManaged: 0, unattributed: 0, transcripts: transcripts.length },
    };

    const replay = await readTailEventsForSession(sessionId, { discovery });
    expect(replay?.events.map((event) => [event.kind, event.summary])).toEqual([
      ["user", "Update the session header and run tests"],
      ["assistant", "Reading the header and updating the checklist."],
      ["tool", "update_steps"],
      ["tool", "read_file · /workspace/src/Header.tsx:1-60"],
      ["tool", "edit_file · /workspace/src/Header.tsx"],
      ["tool", "run_command · bun test src/Header.test.tsx"],
      ["tool-result", "run_command → exit 2 · 1 output line"],
    ]);

    const editEvent = replay?.events.find((event) => event.summary === "edit_file · /workspace/src/Header.tsx");
    expect(editEvent?.raw).toMatchObject({
      tool: "Edit",
      toolName: "edit_file",
      path: "/workspace/src/Header.tsx",
      diff: { add: 2, del: 1 },
    });

    await __testing.refreshDiscovery([AntigravitySource]);
    const usage = await readTailSessionUsage([sessionId]);
    expect(usage.sessions[0]).toMatchObject({
      sessionId,
      source: "antigravity",
      model: "gemini-4-carbon-high",
      tokens: {
        input: 2000,
        cacheRead: 9200,
        output: 460,
        cacheWrite: 0,
      },
    });
  } finally {
    __testing.clearWatchers();
    __testing.resetDiscovery();
    __testing.resetTailEventBuffers();
    if (previous === undefined) delete process.env.OPENSCOUT_TAIL_ANTIGRAVITY_ROOT;
    else process.env.OPENSCOUT_TAIL_ANTIGRAVITY_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("live Tail and history pair parallel Antigravity calls across a watcher restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "scout-agy-tools-"));
  const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const logs = join(root, "brain", sessionId, ".system_generated", "logs");
  const path = join(logs, "transcript.jsonl");
  mkdirSync(logs, { recursive: true });
  const line = (index: number, step: object) => JSON.stringify({
    step_index: index + 9, created_at: "2025-01-01T12:00:00Z", source: "MODEL", ...step,
  }) + "\n";
  const planner = {
    type: "PLANNER_RESPONSE", content: "Checking the changes", thinking: "private",
    tool_calls: [
      { name: "run_command", args: { CommandLine: "git diff --stat", extra: "private" } },
      { name: "read_file", args: { Path: "src/main.ts", StartLine: 2, EndLine: 5 } },
    ],
  };
  const result = (output: string, status = "DONE") => ({
    type: "GENERIC", status, content: "Created At: 2025-01-01T12:00:00Z\nCompleted At: 2025-01-01T12:00:01Z\n" + output,
  });
  const output = "Command exited with code 0.\n\nCommand output:\n2 files changed";
  const process: DiscoveredProcess = { pid: 7, ppid: 1, command: "agy", etime: "01:00", cwd: root,
    parentChain: [], source: "antigravity", harness: "unattributed", nativeSessionId: sessionId };
  const transcript: DiscoveredTranscript = { source: "antigravity", cwd: root, project: "demo", harness: "unattributed",
    sessionId, transcriptPath: path, mtimeMs: Date.now(), size: 0 };
  const discovery: DiscoverySnapshot = { processes: [process], transcripts: [transcript], generatedAt: Date.now(),
    totals: { total: 1, scoutManaged: 0, hudsonManaged: 0, unattributed: 1, transcripts: 1 } };
  const live: TailEvent[] = [];
  const unsubscribe = __testing.addPublicSubscriberWithoutLoop(event => live.push(event));
  try {
    writeFileSync(path, line(0, planner));
    const watcher = await __testing.installWatcher({ source: AntigravitySource, process, transcript });
    appendFileSync(path, line(1, result(output)) + line(2, { ...result("Read failed", "ERROR"), error: "Missing file" })
      + line(3, planner) + line(5, result("Reading", "RUNNING"))
      + line(6, result("Unattributed output")) + line(7, { type: "GENERIC", content: "private" })
      + line(8, { type: "PLANNER_RESPONSE", tool_calls: [planner.tool_calls[1]] })
      + line(9, result("Showing lines 2-5 of 10\nAPI_TOKEN=fixture-unregistered-secret\nfile body")));
    await __testing.pumpWatcher(watcher);
    const history = (await readTailEventsForSession(sessionId, { discovery }))!.events;
    const [message, command, file, finished, failed] = history;
    expect(history.map(e => e.kind)).toEqual(["assistant", "tool", "tool", "tool-result", "tool-result",
      "assistant", "tool", "tool", "tool-result", "tool-result", "tool", "tool-result"]);
    expect(new Set(history.map(e => e.id)).size).toBe(history.length);
    expect(message?.id).toBe(`antigravity:${sessionId}:9`);
    expect(command).toMatchObject({ summary: "run_command · git diff --stat", raw: { input: { CommandLine: "git diff --stat" } } });
    expect(file?.summary).toBe("read_file · src/main.ts:2-5");
    expect(finished).toMatchObject({ summary: "run_command → exit 0 · 2 files changed",
      raw: { tool_use_id: command?.id, tool_name: "run_command", status: "DONE", output } });
    expect(failed).toMatchObject({ summary: "read_file → error · Missing file",
      raw: { tool_use_id: file?.id, error: "Missing file" } });
    expect(history[8]).toMatchObject({ summary: "read_file → running", raw: { tool_use_id: history[7]?.id } });
    expect(history[9]?.summary).toBe("tool → done");
    expect(JSON.stringify(history)).not.toContain("fixture-unregistered-secret");
    expect(history[11]?.summary).toBe("read_file → read lines 2–5");
    expect(history[11]?.raw).toMatchObject({ output: "Showing lines 2-5 of 10\nAPI_TOKEN=[REDACTED]\nfile body" });
    expect(history[9]?.raw).not.toHaveProperty("tool_use_id");
    expect(live.map(e => [e.id, e.summary])).toEqual(history.slice(3).map(e => [e.id, e.summary]));
    expect(JSON.stringify(history)).not.toContain("private");
    __testing.pushEvent(message!);
    __testing.pushEvent(command!);
    __testing.pushEvent(file!);
    const recent = await brokerRouter.createCaller({}).tail.recent({ sources: ["antigravity"], limit: 20 });
    expect(recent.events.map(e => e.id)).toEqual(history.map(e => e.id));
  } finally {
    unsubscribe();
    __testing.clearWatchers();
    __testing.resetTailEventBuffers();
    rmSync(root, { recursive: true, force: true });
  }
});
