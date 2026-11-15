import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureClaudeStatuslineSnapshot,
  claudeStatuslineCommandWrapperPath,
  claudeStatuslineObservedRuntime,
  formatClaudeStatuslineFallback,
  isClaudeStatuslineWrapperIsolatedFromSettings,
  isOpenScoutClaudeStatuslineCommand,
  readClaudeStatuslineDelegate,
  readClaudeStatuslineSessionSnapshot,
  resolveClaudeStatuslineHistoryPath,
  resolveClaudeStatuslineLatestPath,
  resolveClaudeStatuslineSessionSnapshotPath,
} from "./claude-statusline.js";

const originalHome = process.env.HOME;
const originalSupportDirectory = process.env.OPENSCOUT_SUPPORT_DIRECTORY;
const testDirectories = new Set<string>();

afterEach(() => {
  process.env.HOME = originalHome;
  if (originalSupportDirectory === undefined) {
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
  } else {
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = originalSupportDirectory;
  }

  for (const directory of testDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  testDirectories.clear();
});

describe("Claude statusline delegate", () => {
  test("ignores a delegate that is another Scout install's wrapper", async () => {
    const home = join(tmpdir(), `openscout-claude-statusline-delegate-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    testDirectories.add(home);
    mkdirSync(home, { recursive: true });
    const path = join(home, "claude-delegate.json");
    // What an old smoke run left behind in the real support directory.
    writeFileSync(path, JSON.stringify({
      version: 1,
      command: "'/var/folders/xx/T/openscout-web-bundle-smoke-abc/support/runtime/statusline/claude-statusline.sh'",
      source: "claude-settings.statusLine",
    }), "utf8");
    expect(await readClaudeStatuslineDelegate(path)).toBeNull();

    writeFileSync(path, JSON.stringify({ version: 1, command: "~/.claude/custom-statusline.sh" }), "utf8");
    expect((await readClaudeStatuslineDelegate(path))?.command).toBe("~/.claude/custom-statusline.sh");
  });

  test("recognises a wrapper path as Scout's, whichever install wrote it", () => {
    expect(claudeStatuslineCommandWrapperPath("'/tmp/x y/support/runtime/statusline/claude-statusline.sh'"))
      .toBe("/tmp/x y/support/runtime/statusline/claude-statusline.sh");
    expect(claudeStatuslineCommandWrapperPath("~/.claude/custom-statusline.sh")).toBeNull();
    expect(isOpenScoutClaudeStatuslineCommand("'/tmp/other/claude-statusline.sh'", "/real/claude-statusline.sh")).toBe(true);
  });
});

describe("Claude statusline capture", () => {
  test("keeps the newest payload per session id so a session's model and effort can be observed", async () => {
    const home = join(tmpdir(), `openscout-claude-statusline-session-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    testDirectories.add(home);
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");

    const sessionId = "7b81300d-0a9c-4953-8d7f-9274b11ebdfb";
    const payload = (model: string, level: string) => JSON.stringify({
      session_id: sessionId,
      session_name: "project-woolf-20-relay-agent",
      transcript_path: `/Users/you/.claude/projects/-Users-you-dev-openscout/${sessionId}.jsonl`,
      cwd: "/Users/you/dev/openscout",
      effort: { level },
      model: { id: model, display_name: model },
    });
    await captureClaudeStatuslineSnapshot(payload("claude-opus-5", "high"), { capturedAt: 1_000 });
    await captureClaudeStatuslineSnapshot(payload("claude-sonnet-5", "medium"), { capturedAt: 2_000 });

    const snapshot = await readClaudeStatuslineSessionSnapshot(sessionId);
    expect(snapshot).not.toBeNull();
    expect(claudeStatuslineObservedRuntime(snapshot!)).toEqual({
      model: "claude-sonnet-5",
      reasoningEffort: "medium",
      sessionName: "project-woolf-20-relay-agent",
      cwd: "/Users/you/dev/openscout",
      transcriptPath: `/Users/you/.claude/projects/-Users-you-dev-openscout/${sessionId}.jsonl`,
      capturedAt: 2_000,
    });
    // History still has both ticks; the per-session file is the latest only.
    expect(readFileSync(resolveClaudeStatuslineHistoryPath(), "utf8").trim().split("\n")).toHaveLength(2);
    expect(await readClaudeStatuslineSessionSnapshot("0a898412-b3a2-4659-aad3-405e9a24d015")).toBeNull();
    expect(resolveClaudeStatuslineSessionSnapshotPath("../escape")).toBeNull();
    expect(resolveClaudeStatuslineSessionSnapshotPath("")).toBeNull();
  });

  test("writes latest and history snapshots for the quota view", async () => {
    const home = join(tmpdir(), `openscout-claude-statusline-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    testDirectories.add(home);
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");

    const capturedAt = Date.UTC(2026, 5, 19, 12, 0, 0);
    const result = await captureClaudeStatuslineSnapshot(JSON.stringify({
      model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
      workspace: { current_dir: "/Users/you/dev/openscout" },
      context_window: { used_percentage: 31 },
      rate_limits: {
        five_hour: { used_percentage: 12 },
        seven_day: { used_percentage: 70 },
      },
    }), { capturedAt });

    expect(result.captured).toBe(true);
    const latest = JSON.parse(readFileSync(resolveClaudeStatuslineLatestPath(), "utf8")) as Record<string, unknown>;
    const history = readFileSync(resolveClaudeStatuslineHistoryPath(), "utf8").trim().split("\n");

    expect(latest).toEqual(expect.objectContaining({
      cwd: "/Users/you/dev/openscout",
      openscoutCapturedAt: capturedAt,
    }));
    expect(history).toHaveLength(1);
    expect(formatClaudeStatuslineFallback(latest)).toBe("Scout | Opus 4.8 | openscout | ctx 31% | 5h 12% | 7d 70%");
  });
});

describe("Claude statusline install guards", () => {
  const tempWrapper = join(tmpdir(), "scout-smoke-x", "support", "runtime", "statusline", "claude-statusline.sh");

  test("flags a temp wrapper wired into settings outside the temp directory", () => {
    expect(isClaudeStatuslineWrapperIsolatedFromSettings("/Users/operator/.claude/settings.json", tempWrapper)).toBe(true);
  });

  test("allows a fully sandboxed home and a normal install", () => {
    expect(isClaudeStatuslineWrapperIsolatedFromSettings(
      join(tmpdir(), "scout-smoke-x", "home", ".claude", "settings.json"),
      tempWrapper,
    )).toBe(false);
    expect(isClaudeStatuslineWrapperIsolatedFromSettings(
      "/Users/operator/.claude/settings.json",
      "/Users/operator/Library/Application Support/OpenScout/runtime/statusline/claude-statusline.sh",
    )).toBe(false);
  });

  test("recognizes a Scout wrapper from another support directory as Scout's own", () => {
    const current = "/Users/operator/Library/Application Support/OpenScout/runtime/statusline/claude-statusline.sh";
    expect(isOpenScoutClaudeStatuslineCommand(`'${tempWrapper}'`, current)).toBe(true);
    expect(isOpenScoutClaudeStatuslineCommand("bun ~/.claude/statusline/index.ts", current)).toBe(false);
  });
});
