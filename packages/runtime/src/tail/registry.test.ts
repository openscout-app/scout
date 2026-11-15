import { describe, expect, test } from "bun:test";

import { sessionRegistryKey, transcriptPathKey } from "./registry.js";
import type { DiscoveredTranscript } from "./types.js";

function transcript(overrides: Partial<DiscoveredTranscript>): DiscoveredTranscript {
  return {
    source: "claude",
    transcriptPath: "/tmp/session.jsonl",
    sessionId: "sess-1",
    cwd: null,
    project: "openscout",
    harness: "unattributed",
    mtimeMs: 1,
    size: 1,
    ...overrides,
  };
}

describe("sessionRegistryKey", () => {
  test("keys cursor process-monitor logs by path, not shared app sessionId", () => {
    const sharedSessionId = "cursor-4b4e2a4d-713b-6356-9b9f-3a5b2a2e2a2e";
    const older = transcript({
      source: "cursor",
      sessionId: sharedSessionId,
      transcriptPath: "/Users/you/Library/Application Support/Cursor/process-monitor/1783270000.log",
    });
    const newer = transcript({
      source: "cursor",
      sessionId: sharedSessionId,
      transcriptPath: "/Users/you/Library/Application Support/Cursor/process-monitor/1783271000.log",
    });

    expect(sessionRegistryKey(older)).toBe(transcriptPathKey(older));
    expect(sessionRegistryKey(newer)).toBe(transcriptPathKey(newer));
    expect(sessionRegistryKey(older)).not.toBe(sessionRegistryKey(newer));
  });

  test("keys provider harness transcripts by source and sessionId", () => {
    const claude = transcript({
      source: "claude",
      sessionId: "019edd8c-7042-7451-a4bb-c54c6344927f",
      transcriptPath: "/Users/you/.claude/projects/openscout/019edd8c.jsonl",
    });

    expect(sessionRegistryKey(claude)).toBe("claude:019edd8c-7042-7451-a4bb-c54c6344927f");
  });

  test("keeps Kimi main and subagent wire logs on distinct session keys", () => {
    const main = transcript({
      source: "kimi",
      sessionId: "session_123",
      transcriptPath: "/Users/you/.kimi-code/sessions/wd_project/session_123/agents/main/wire.jsonl",
    });
    const subagent = transcript({
      source: "kimi",
      sessionId: "session_123:agent-0",
      transcriptPath: "/Users/you/.kimi-code/sessions/wd_project/session_123/agents/agent-0/wire.jsonl",
    });

    expect(sessionRegistryKey(main)).toBe("kimi:session_123");
    expect(sessionRegistryKey(subagent)).toBe("kimi:session_123:agent-0");
  });
});
