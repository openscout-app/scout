import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { join } from "node:path";

import { indexRecentSessionKnowledge, scanRecentSessionKnowledge, SQLiteKnowledgeStore } from "./index.ts";

const roots = new Set<string>();
const originalEnv = {
  controlHome: process.env.OPENSCOUT_CONTROL_HOME,
  support: process.env.OPENSCOUT_SUPPORT_DIRECTORY,
  kimiRoot: process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT,
  codexRoot: process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT,
  claudeRoot: process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT,
  rg: process.env.OPENSCOUT_RG_PATH,
};

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
  restoreEnv("OPENSCOUT_RG_PATH", originalEnv.rg);
  restoreEnv("OPENSCOUT_CONTROL_HOME", originalEnv.controlHome);
  restoreEnv("OPENSCOUT_SUPPORT_DIRECTORY", originalEnv.support);
  restoreEnv("OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT", originalEnv.kimiRoot);
  restoreEnv("OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT", originalEnv.codexRoot);
  restoreEnv("OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT", originalEnv.claudeRoot);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.add(root);
  mkdirSync(join(root, "support"), { recursive: true });
  writeFileSync(join(root, "support", "settings.json"), JSON.stringify({ knowledgeIndexEnabled: true }));
  return root;
}

function writeKimiWireFixture(sessionsRoot: string): string {
  const sessionId = "session_test-kimi-ios-build";
  const wireDir = join(sessionsRoot, "wd_openscout_test", sessionId, "agents", "main");
  mkdirSync(wireDir, { recursive: true });
  writeFileSync(
    join(sessionsRoot, "wd_openscout_test", sessionId, "state.json"),
    JSON.stringify({
      version: 2,
      cwd: "/Users/art/dev/openscout",
      title: "iOS navigation slice",
    }),
    "utf8",
  );
  const lines = [
    {
      type: "turn.prompt",
      input: [{ type: "text", text: "Implement iOS v3 navigation and run build steps." }],
      time: Date.now() - 60_000,
    },
    {
      type: "context.append_loop_event",
      time: Date.now() - 50_000,
      event: {
        type: "tool.call",
        uuid: "tool_xcodegen",
        toolCallId: "tool_xcodegen",
        name: "Bash",
        args: { command: "cd apps/ios && xcodegen" },
      },
    },
    {
      type: "context.append_loop_event",
      time: Date.now() - 40_000,
      event: {
        type: "tool.call",
        uuid: "tool_xcodebuild",
        toolCallId: "tool_xcodebuild",
        name: "Bash",
        args: {
          command:
            "xcodebuild -project apps/ios/Scout.xcodeproj -scheme Scout -destination 'platform=iOS Simulator,name=iPhone 16' build",
        },
      },
    },
    {
      type: "context.append_loop_event",
      time: Date.now() - 30_000,
      event: {
        type: "content.part",
        uuid: "part_1",
        part: { type: "text", text: "Build succeeded after fixing the V3 chrome compile error." },
      },
    },
  ];
  const wirePath = join(wireDir, "wire.jsonl");
  writeFileSync(wirePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return wirePath;
}

describe("session knowledge indexer (kimi)", () => {
  test("indexes kimi state v2 wire.jsonl and finds iOS build-step queries", async () => {
    const root = tempRoot("openscout-kimi-knowledge-");
    process.env.OPENSCOUT_CONTROL_HOME = join(root, "control-plane");
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(root, "support");
    process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT = join(root, "kimi-sessions");
    // Keep other harnesses empty so discovery is kimi-only even without filter.
    process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT = join(root, "empty-codex");
    process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT = join(root, "empty-claude");
    mkdirSync(process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT, { recursive: true });

    writeKimiWireFixture(process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT);

    const indexed = await indexRecentSessionKnowledge({
      hours: 12,
      harness: "kimi",
      force: true,
    });
    expect(indexed.discovered).toBe(1);
    expect(indexed.failed).toBe(0);
    expect(indexed.sessions[0]?.harness).toBe("kimi");
    expect(indexed.sessions[0]?.project).toBe("openscout");
    expect(indexed.sessions[0]?.chunks ?? 0).toBeGreaterThan(0);

    writeFileSync(
      join(
        process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT,
        "wd_openscout_test",
        "session_test-kimi-ios-build",
        "state.json",
      ),
      JSON.stringify({
        workDir: "/Users/art/dev/openscout",
        title: "iOS navigation slice",
      }),
      "utf8",
    );
    const legacyIndexed = await indexRecentSessionKnowledge({
      hours: 12,
      harness: "kimi",
      force: true,
    });
    expect(legacyIndexed.sessions[0]?.project).toBe("openscout");

    const store = new SQLiteKnowledgeStore();
    try {
      const hits = store.searchLexical({
        q: "xcodebuild iOS Simulator",
        facets: { harness: "kimi" },
        limit: 10,
      });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((hit) => /xcodebuild/i.test(hit.snippet) || /xcodebuild/i.test(hit.title))).toBe(true);
      expect(hits[0]?.facets.harness === "kimi" || hits[0]?.facets.harness?.[0] === "kimi").toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("basic session scan (no index)", () => {
  function writeClaudeFixture(projectsRoot: string): void {
    const dir = join(projectsRoot, "-Users-art-dev-openscout");
    mkdirSync(dir, { recursive: true });
    const sessionId = "0f2c7a1e-basic-scan";
    const base = {
      cwd: "/Users/art/dev/openscout",
      sessionId,
      timestamp: new Date(Date.now() - 30_000).toISOString(),
    };
    const lines = [
      { ...base, type: "attachment", note: "Multibyte offset fixture: 🧭 café" },
      { ...base, type: "user", message: { role: "user", content: "Why does the knowledge index child exit 1?" } },
      { ...base, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "The child script path moved after the route split." }] } },
      { ...base, type: "user", message: { role: "user", content: "Unrelated note about the header." } },
    ];
    writeFileSync(join(dir, `${sessionId}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  }

  for (const engine of ["ripgrep", "reader"] as const) {
    test(`finds matching transcript records without an index (${engine})`, async () => {
      const root = tempRoot("openscout-basic-scan-");
      const originalRg = process.env.OPENSCOUT_RG_PATH;
      if (engine === "reader") process.env.OPENSCOUT_RG_PATH = "none";
      try {
        process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT = join(root, "claude");
        process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT = join(root, "empty-codex");
        process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT = join(root, "empty-kimi");
        writeClaudeFixture(process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT);

        const result = await scanRecentSessionKnowledge({ q: "index CHILD" });
        expect(result.scannedFiles).toBe(1);
        expect(result.totalFiles).toBe(1);
        expect(result.truncated).toBe(false);
        expect(result.hits).toHaveLength(1);
        const hit = result.hits[0]!;
        expect(hit.snippet).toContain("knowledge index child");
        expect(hit.facets.harness).toBe("claude");
        expect(hit.facets.project).toBe("openscout");
        expect(hit.facets.match).toBe("basic");
        expect(hit.sourceRefs[0]?.kind).toBe("harness_transcript");
        const ref = hit.sourceRefs[0]!;
        if (ref.kind !== "harness_transcript") throw new Error("missing transcript reference");
        const transcript = readFileSync(join(process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT!, "-Users-art-dev-openscout", "0f2c7a1e-basic-scan.jsonl"));
        expect(ref.recordRange).toEqual([1, 1]);
        const [start, end] = ref.byteRange!;
        expect(JSON.parse(transcript.subarray(start, end).toString()).message.content).toBe("Why does the knowledge index child exit 1?");

        const none = await scanRecentSessionKnowledge({ q: "nothing-matches-this" });
        expect(none.hits).toHaveLength(0);
      } finally {
        restoreEnv("OPENSCOUT_RG_PATH", originalRg);
      }
    });
  }
});

describe("basic scan lifecycle", () => {
  function claudeRoot() {
    const root = tempRoot("openscout-scan-lifecycle-");
    process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT = root;
    process.env.OPENSCOUT_RG_PATH = "none";
    return root;
  }

  test("discovery yields and counts against the request deadline", async () => {
    const root = claudeRoot();
    for (let i = 0; i < 300; i++) mkdirSync(join(root, `old-project-${i}`));
    let heartbeat = false;
    const timer = setTimeout(() => { heartbeat = true; }, 0);
    try {
      const complete = await scanRecentSessionKnowledge({ q: "missing", harness: "claude" });
      // The timer must run before this empty-tree scan completes, not afterward.
      expect(heartbeat).toBe(true);
      expect(complete.truncated).toBe(false);
      const bounded = await scanRecentSessionKnowledge({ q: "missing", harness: "claude", budgetMs: 1 });
      expect(bounded.truncated).toBe(true);
    } finally { clearTimeout(timer); }
  });

  test("an abandoned request cancels directory discovery", async () => {
    const root = claudeRoot();
    for (let i = 0; i < 100; i++) mkdirSync(join(root, `project-${i}`));
    const controller = new AbortController();
    const pending = scanRecentSessionKnowledge({ q: "missing", harness: "claude", signal: controller.signal });
    controller.abort(new Error("superseded query"));
    await expect(pending).rejects.toThrow("superseded query");
  });

  test("fallback cancellation closes an in-progress transcript stream", async () => {
    const root = claudeRoot();
    writeFileSync(join(root, "session.jsonl"), (JSON.stringify({ type: "user", message: { content: "needle" } }) + "\n").repeat(40_000));
    const controller = new AbortController();
    const realCreateReadStream = fs.createReadStream;
    let stream: fs.ReadStream | undefined;
    const create = spyOn(fs, "createReadStream").mockImplementation(((...args: Parameters<typeof fs.createReadStream>) => {
      stream = realCreateReadStream(...args);
      stream.once("data", () => controller.abort(new Error("replaced during read")));
      return stream;
    }) as typeof fs.createReadStream);
    try {
      await expect(scanRecentSessionKnowledge({ q: "needle", harness: "claude", signal: controller.signal })).rejects.toThrow("replaced during read");
      expect(create).toHaveBeenCalledTimes(1);
      expect(stream?.destroyed).toBe(true);
    } finally { create.mockRestore(); }
  });

  test("aborting ripgrep waits for its owned child to exit without starting a fallback", async () => {
    const root = claudeRoot();
    writeFileSync(join(root, "session.jsonl"), '{"type":"user","message":{"content":"needle"}}\n');
    const pidPath = join(root, "child.pid");
    const executable = join(root, "fixture-rg");
    writeFileSync(executable, `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nprocess.on("SIGTERM", () => {});\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
    chmodSync(executable, 0o755);
    process.env.OPENSCOUT_RG_PATH = executable;
    const controller = new AbortController();
    const pending = scanRecentSessionKnowledge({ q: "needle", harness: "claude", signal: controller.signal, budgetMs: 5000 });
    let pid: number | undefined;
    try {
      const deadline = Date.now() + 2000;
      while (!existsSync(pidPath) && Date.now() < deadline) await Bun.sleep(5);
      expect(existsSync(pidPath)).toBe(true);
      pid = Number(readFileSync(pidPath, "utf8"));
      controller.abort(new Error("replaced during ripgrep"));
      await expect(pending).rejects.toThrow("replaced during ripgrep");
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      controller.abort();
      await pending.catch(() => {});
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
  });

  test("ripgrep output capped before the deadline is reported as truncated", async () => {
    const root = claudeRoot();
    writeFileSync(join(root, "session.jsonl"), '{"type":"user","message":{"content":"needle"}}\n');
    const executable = join(root, "fixture-rg-cap");
    // Bounded generated pipe output, with no large on-disk transcript or agent.
    writeFileSync(executable, `#!${process.execPath}\nconst block = "x".repeat(1024 * 1024) + "\\n";\nfor (let i = 0; i < 66; i++) await Bun.write(Bun.stdout, block);\n`);
    chmodSync(executable, 0o755);
    process.env.OPENSCOUT_RG_PATH = executable;
    const result = await scanRecentSessionKnowledge({ q: "needle", harness: "claude", budgetMs: 5000 });
    expect(result.truncated).toBe(true);
    expect(result.hits).toEqual([]);
  });


  test("retains collected ripgrep matches when the collection deadline expires", async () => {
    const root = claudeRoot();
    const transcript = join(root, "partial.jsonl");
    const record = JSON.stringify({ type: "user", cwd: root, sessionId: "partial-rg", message: { content: "needle survives deadline" } });
    writeFileSync(transcript, record + "\n");
    const pidPath = join(root, "partial-rg.pid");
    const executable = join(root, "fixture-rg-partial");
    // Warm the executable outside the collection budget (first-launch validation
    // on macOS can itself exceed 250ms). Shell builtins then publish immediately;
    // exec keeps the blocked producer PID owned by the scanner for reaping.
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    writeFileSync(executable, `#!/bin/sh\nif [ "$1" = "--warmup" ]; then exit 0; fi\nprintf '%s\\n' "$$" > ${quote(pidPath)}\nprintf '%s\\000%s\\n' ${quote(transcript)} ${quote(`1:0:${record}`)}\nexec /bin/sleep 30\n`);
    chmodSync(executable, 0o755);
    expect(await Bun.spawn([executable, "--warmup"], { stdout: "ignore", stderr: "pipe" }).exited).toBe(0);
    process.env.OPENSCOUT_RG_PATH = executable;
    const result = await scanRecentSessionKnowledge({ q: "needle", harness: "claude", budgetMs: 250 });
    expect(existsSync(pidPath)).toBe(true);
    expect(() => process.kill(Number(readFileSync(pidPath, "utf8")), 0)).toThrow();
    expect(result).toMatchObject({
      truncated: true, scannedFiles: 1,
      hits: [{ snippet: "needle survives deadline" }],
    });
  });

  test("retains streamed fallback matches when the collection deadline expires", async () => {
    const root = claudeRoot();
    const record = JSON.stringify({ type: "user", cwd: root, sessionId: "partial-reader", message: { content: "needle survives deadline" } });
    writeFileSync(join(root, "partial.jsonl"), record + "\n");
    let stream: Readable | undefined;
    const create = spyOn(fs, "createReadStream").mockImplementation(((_path, options) => {
      const signal = (options as { signal: AbortSignal }).signal;
      let sent = false;
      // Emit one real record, then hold the stream open until the real budget
      // timer aborts it. No dependency on disk speed or an oversized fixture.
      stream = new Readable({ read() { if (!sent) { sent = true; this.push(record + "\n"); } } });
      const abort = () => stream!.destroy(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      stream.once("close", () => signal.removeEventListener("abort", abort));
      return stream as fs.ReadStream;
    }) as typeof fs.createReadStream);
    try {
      const result = await scanRecentSessionKnowledge({ q: "needle", harness: "claude", budgetMs: 100 });
      expect(create).toHaveBeenCalledTimes(1);
      expect(stream?.destroyed).toBe(true);
      expect(result).toMatchObject({
        truncated: true, scannedFiles: 1,
        hits: [{ snippet: "needle survives deadline" }],
      });
    } finally { create.mockRestore(); }
  });

});

test("re-extracts stale versions, strips turn/tool boilerplate and preserves every collection path", async () => {
  const root = tempRoot("scout-knowledge-content-");
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(root, "support");
  process.env.OPENSCOUT_CONTROL_HOME = join(root, "control");
  const sessions = join(root, "codex"); mkdirSync(sessions);
  process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT = sessions;
  const lines = [
    { type: "session_meta", payload: { id: "content-fixture", cwd: "/repo/fixture" } },
    { type: "event_msg", payload: { type: "user_message", message: "<recommended_plugins>boilerplateunique</recommended_plugins>\nFix meaningful regression" } },
    { type: "function_call_output", payload: { output: "<system-reminder>reminderunique</system-reminder>usefulresultunique" } },
    ...["Case.ts", "case.ts"].map(name => ({ type: "function_call", payload: { name: "Read", arguments: JSON.stringify({ file_path: `/repo/fixture/${name}` }) } })),
    ...Array.from({ length: 125 }, (_, i) => ({ type: "function_call", payload: { name: "Read", arguments: JSON.stringify({ file_path: `/repo/fixture/path-${i}.ts` }) } })),
  ];
  writeFileSync(join(sessions, "content-fixture.jsonl"), lines.map(line => JSON.stringify(line)).join("\n"));
  const first = await indexRecentSessionKnowledge({ harness: "codex", hours: 1 });
  expect(first.failed).toBe(0); expect(first.indexed).toBe(1);
  const store = new SQLiteKnowledgeStore();
  try {
    const collection = store.getCollection(first.sessions[0]!.collectionId)!;
    expect(collection.title).toContain("Fix meaningful regression"); expect(collection.title).not.toContain("boilerplateunique");
    expect(collection.facets.touchedPath).toHaveLength(127);
    expect(collection.facets.touchedPath).toContain("/repo/fixture/Case.ts");
    expect(collection.facets.touchedPath).toContain("/repo/fixture/case.ts");
    expect(store.searchLexical({ q: "usefulresultunique", facets: { touchedPath: "/repo/fixture/path-124.ts" } }).length).toBeGreaterThan(0);
    expect(store.searchLexical({ q: "boilerplateunique" })).toEqual([]);
    expect(store.searchLexical({ q: "reminderunique" })).toEqual([]);
    store.upsertCollection({ ...collection, extractorVersion: "session-qmd-v3", chunkPolicyVersion: "session-qmd-record-window-v1" });
  } finally { store.close(); }
  const second = await indexRecentSessionKnowledge({ harness: "codex", hours: 1 });
  expect(second.failed).toBe(0); expect(second.sessions[0]?.skipped).not.toBe(true);
  const reader = new SQLiteKnowledgeStore(undefined, undefined, { readonly: true });
  try { expect(reader.getCollection(first.sessions[0]!.collectionId)?.extractorVersion).toBe("session-qmd-v4"); } finally { reader.close(); }
});
