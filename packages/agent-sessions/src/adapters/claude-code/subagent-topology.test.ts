import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readClaudeSubagentTopology } from "./subagent-topology.ts";

const tempPaths = new Set<string>();

afterEach(() => {
  for (const path of tempPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  tempPaths.clear();
});

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "openscout-claude-subagents-"));
  tempPaths.add(home);
  return home;
}

function jsonl(events: unknown[]): string {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

describe("readClaudeSubagentTopology", () => {
  test("normalizes Claude direct subagents into observed topology", () => {
    const home = makeTempHome();
    const sessionId = "9fb91ece-a1de-4701-88af-949218efc3d7";
    const projectDir = join(home, ".claude", "projects", "-Users-you-dev-openscout");
    const subagentsDir = join(projectDir, sessionId, "subagents");
    mkdirSync(subagentsDir, { recursive: true });

    writeFileSync(join(projectDir, `${sessionId}.jsonl`), jsonl([
      {
        uuid: "assistant-1",
        type: "assistant",
        timestamp: "2026-07-04T00:00:00.000Z",
        cwd: "/repo",
        sessionId,
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "toolu_01audit",
            name: "Task",
            input: {
              description: "Audit agent-sessions package",
              prompt: "Review package boundaries and report risks.",
              subagent_type: "general-purpose",
            },
          }],
        },
      },
      {
        type: "user",
        timestamp: "2026-07-04T00:05:00.000Z",
        cwd: "/repo",
        sessionId,
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "toolu_01audit",
            content: "Found two merge-readiness issues and committed fixes.",
            is_error: false,
          }],
        },
      },
    ]), "utf8");

    writeFileSync(join(subagentsDir, "agent-a672d9af0e219a577.meta.json"), JSON.stringify({
      agentType: "general-purpose",
      description: "Audit agent-sessions package",
      toolUseId: "toolu_01audit",
    }), "utf8");
    writeFileSync(join(subagentsDir, "agent-a672d9af0e219a577.jsonl"), jsonl([
      {
        type: "user",
        isSidechain: true,
        agentId: "a672d9af0e219a577",
        timestamp: "2026-07-04T00:01:00.000Z",
        cwd: "/repo",
        sessionId,
        message: { role: "user", content: "Review package boundaries and report risks." },
      },
      {
        type: "assistant",
        isSidechain: true,
        agentId: "a672d9af0e219a577",
        timestamp: "2026-07-04T00:04:00.000Z",
        cwd: "/repo",
        sessionId,
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "Done." }],
        },
      },
    ]), "utf8");

    const topology = readClaudeSubagentTopology({
      homeDir: home,
      claudeSessionId: sessionId,
      now: () => new Date("2026-07-04T00:10:00.000Z"),
    });

    expect(topology).toMatchObject({
      schemaVersion: "openscout.observed-harness-topology.v1",
      ownership: "harness_observed",
      source: "claude-code-subagents",
      observedAt: "2026-07-04T00:10:00.000Z",
    });
    expect(topology?.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `claude-subagents:${sessionId}`,
        kind: "session",
        providerMeta: expect.objectContaining({
          claudeSessionId: sessionId,
          subagentCount: 1,
          activeSubagentCount: 0,
        }),
      }),
    ]));
    expect(topology?.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `claude-subagent-lead:${sessionId}`,
        role: "lead",
        status: "completed",
        externalSessionId: sessionId,
      }),
      expect.objectContaining({
        id: `claude-subagent:${sessionId}:a672d9af0e219a577`,
        name: "Audit agent-sessions package",
        role: "subagent",
        type: "general-purpose",
        status: "completed",
        model: "claude-sonnet-4-6",
        providerMeta: expect.objectContaining({
          claudeAgentId: "a672d9af0e219a577",
          claudeToolUseId: "toolu_01audit",
          resultPreview: "Done.",
        }),
      }),
    ]));
    expect(topology?.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `claude-subagent-task:${sessionId}:toolu_01audit`,
        title: "Audit agent-sessions package",
        state: "completed",
        assigneeId: `claude-subagent:${sessionId}:a672d9af0e219a577`,
      }),
    ]));
    expect(topology?.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "spawned",
        fromId: `claude-subagent-lead:${sessionId}`,
        toId: `claude-subagent:${sessionId}:a672d9af0e219a577`,
      }),
      expect.objectContaining({
        kind: "assigned_to",
        fromId: `claude-subagent-task:${sessionId}:toolu_01audit`,
        toId: `claude-subagent:${sessionId}:a672d9af0e219a577`,
      }),
    ]));
  });

  test("can filter direct subagent topology by parent session id", () => {
    const home = makeTempHome();
    for (const [sessionId, agentId] of [["session-a", "a111"], ["session-b", "b222"]] as const) {
      const projectDir = join(home, ".claude", "projects", "-Users-you-dev-openscout");
      const subagentsDir = join(projectDir, sessionId, "subagents");
      mkdirSync(subagentsDir, { recursive: true });
      writeFileSync(join(projectDir, `${sessionId}.jsonl`), jsonl([{ type: "system", sessionId, cwd: "/repo" }]), "utf8");
      writeFileSync(join(subagentsDir, `agent-${agentId}.jsonl`), jsonl([
        { type: "user", agentId, sessionId, cwd: "/repo", message: { role: "user", content: `work ${sessionId}` } },
      ]), "utf8");
    }

    const topology = readClaudeSubagentTopology({
      homeDir: home,
      claudeSessionId: "session-b",
    });

    expect(topology?.groups).toHaveLength(1);
    expect(topology?.groups[0]?.providerMeta?.claudeSessionId).toBe("session-b");
    expect(topology?.agents.some((agent) => agent.id.includes("session-a"))).toBe(false);
    expect(topology?.agents.some((agent) => agent.id.includes("session-b"))).toBe(true);
  });
});
