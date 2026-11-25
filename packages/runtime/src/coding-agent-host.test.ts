import { describe, expect, test } from "bun:test";

import { detectCodingAgentHost, isCodingAgentHost } from "./coding-agent-host.js";

describe("detectCodingAgentHost", () => {
  test("returns null for a plain operator shell", () => {
    expect(detectCodingAgentHost({} as NodeJS.ProcessEnv)).toBeNull();
    expect(isCodingAgentHost({} as NodeJS.ProcessEnv)).toBe(false);
  });

  test("detects Scout-managed and bound-agent sessions", () => {
    expect(detectCodingAgentHost({ OPENSCOUT_AGENT: "openscout.main.mini" } as NodeJS.ProcessEnv)).toEqual({
      harness: "scout",
      signal: "OPENSCOUT_AGENT",
    });
    expect(detectCodingAgentHost({ OPENSCOUT_MANAGED_AGENT: "1" } as NodeJS.ProcessEnv)).toEqual({
      harness: "scout",
      signal: "OPENSCOUT_MANAGED_AGENT",
    });
  });

  test("detects Cursor agent shells", () => {
    expect(detectCodingAgentHost({ CURSOR_AGENT: "1" } as NodeJS.ProcessEnv)).toEqual({
      harness: "cursor",
      signal: "CURSOR_AGENT",
    });
  });

  test("detects Claude Code host and cloud session markers", () => {
    expect(detectCodingAgentHost({ CLAUDECODE: "1" } as NodeJS.ProcessEnv)).toEqual({
      harness: "claude",
      signal: "CLAUDECODE",
    });
    expect(detectCodingAgentHost({ CLAUDE_CODE_CHILD_SESSION: "1" } as NodeJS.ProcessEnv)).toEqual({
      harness: "claude",
      signal: "CLAUDE_CODE_CHILD_SESSION",
    });
    expect(detectCodingAgentHost({ CLAUDE_CODE_REMOTE: "true" } as NodeJS.ProcessEnv)).toEqual({
      harness: "claude",
      signal: "CLAUDE_CODE_REMOTE",
    });
    expect(detectCodingAgentHost({ CLAUDE_CODE_SESSION_ID: "sess-2" } as NodeJS.ProcessEnv)).toEqual({
      harness: "claude",
      signal: "CLAUDE_CODE_SESSION_ID",
    });
    expect(detectCodingAgentHost({ CLAUDE_SESSION_ID: "sess-1" } as NodeJS.ProcessEnv)).toEqual({
      harness: "claude",
      signal: "CLAUDE_SESSION_ID",
    });
  });

  test("detects Codex subprocess and integration markers", () => {
    expect(detectCodingAgentHost({ AGENT: "codex" } as NodeJS.ProcessEnv)).toEqual({
      harness: "codex",
      signal: "AGENT",
    });
    expect(detectCodingAgentHost({ CODEX_THREAD_ID: "thread-1" } as NodeJS.ProcessEnv)).toEqual({
      harness: "codex",
      signal: "CODEX_THREAD_ID",
    });
    expect(detectCodingAgentHost({ CODEX_CI: "1" } as NodeJS.ProcessEnv)).toEqual({
      harness: "codex",
      signal: "CODEX_CI",
    });
    expect(detectCodingAgentHost({ CODEX_SANDBOX: "seatbelt" } as NodeJS.ProcessEnv)).toEqual({
      harness: "codex",
      signal: "CODEX_SANDBOX",
    });
  });

  test("detects Herdr-managed coding agents by kind", () => {
    const base = {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p2",
      HERDR_AGENT_NAME: "worker",
    } as NodeJS.ProcessEnv;
    expect(detectCodingAgentHost({ ...base, HERDR_AGENT: "kimi" })).toEqual({
      harness: "kimi",
      signal: "HERDR_AGENT_NAME",
    });
    expect(detectCodingAgentHost({ ...base, HERDR_AGENT: "pi" })).toEqual({
      harness: "pi",
      signal: "HERDR_AGENT_NAME",
    });
    expect(detectCodingAgentHost({ ...base, HERDR_AGENT: "claude" })).toEqual({
      harness: "claude",
      signal: "HERDR_AGENT_NAME",
    });
    expect(detectCodingAgentHost({ ...base, HERDR_AGENT: "antigravity" })).toEqual({
      harness: "antigravity",
      signal: "HERDR_AGENT_NAME",
    });
    expect(detectCodingAgentHost({ ...base, HERDR_AGENT: "agy" })).toEqual({
      harness: "antigravity",
      signal: "HERDR_AGENT_NAME",
    });
  });

  test("detects Antigravity CLI and conversation host markers", () => {
    expect(detectCodingAgentHost({ ANTIGRAVITY_AGENT: "1" } as NodeJS.ProcessEnv)).toEqual({
      harness: "antigravity",
      signal: "ANTIGRAVITY_AGENT",
    });
    expect(detectCodingAgentHost({ ANTIGRAVITY_CONVERSATION_ID: "3a102f26-6237-46c4-ae20-6152148eecaa" } as NodeJS.ProcessEnv)).toEqual({
      harness: "antigravity",
      signal: "ANTIGRAVITY_CONVERSATION_ID",
    });
  });

  test("rejects incomplete or unknown Herdr managed-agent markers", () => {
    expect(detectCodingAgentHost({
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p2",
      HERDR_AGENT: "kimi",
    } as NodeJS.ProcessEnv)).toBeNull();
    expect(detectCodingAgentHost({
      HERDR_ENV: "1",
      HERDR_AGENT: "kimi",
      HERDR_AGENT_NAME: "worker",
    } as NodeJS.ProcessEnv)).toBeNull();
    expect(detectCodingAgentHost({
      HERDR_ENV: "0",
      HERDR_PANE_ID: "w1:p2",
      HERDR_AGENT: "kimi",
      HERDR_AGENT_NAME: "worker",
    } as NodeJS.ProcessEnv)).toBeNull();
    expect(detectCodingAgentHost({
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p2",
      HERDR_AGENT: "unknown-kind",
      HERDR_AGENT_NAME: "worker",
    } as NodeJS.ProcessEnv)).toBeNull();
  });

  test("detects Devin CLI shells via the exported session-db path", () => {
    expect(detectCodingAgentHost({ CHISEL_SESSION_DB: "/Users/x/.local/share/devin/cli/sessions.db" } as NodeJS.ProcessEnv)).toEqual({
      harness: "devin",
      signal: "CHISEL_SESSION_DB",
    });
    expect(detectCodingAgentHost({ CHISEL_SESSION_DB: "/tmp/unrelated.db" } as NodeJS.ProcessEnv)).toBeNull();
  });

  test("prefers Scout binding over vendor flags", () => {
    expect(detectCodingAgentHost({
      OPENSCOUT_AGENT: "openscout.main.mini",
      CURSOR_AGENT: "1",
      CLAUDECODE: "1",
    } as NodeJS.ProcessEnv)).toEqual({
      harness: "scout",
      signal: "OPENSCOUT_AGENT",
    });
  });

  test("prefers Scout binding over Herdr managed-agent markers", () => {
    expect(detectCodingAgentHost({
      OPENSCOUT_AGENT: "openscout.main.mini",
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p2",
      HERDR_AGENT: "kimi",
      HERDR_AGENT_NAME: "worker",
    } as NodeJS.ProcessEnv)).toEqual({
      harness: "scout",
      signal: "OPENSCOUT_AGENT",
    });
  });
});
