import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readClaudeWorkflowTopology } from "./workflow-topology.ts";

const tempPaths = new Set<string>();

afterEach(() => {
  for (const path of tempPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  tempPaths.clear();
});

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "openscout-claude-workflows-"));
  tempPaths.add(home);
  return home;
}

function jsonl(events: unknown[]): string {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

describe("readClaudeWorkflowTopology", () => {
  test("normalizes Claude dynamic workflow runs into observed topology", () => {
    const home = makeTempHome();
    const sessionId = "542b3de4-e4c4-4325-842b-c33ef87cfdff";
    const runId = "wf_fixture-123";
    const projectDir = join(home, ".claude", "projects", "-Users-you-dev-fixture");
    const workflowDir = join(projectDir, sessionId, "subagents", "workflows", runId);
    const scriptDir = join(home, ".claude", "projects", "-Users-you-dev-fixture-packages-web-client", sessionId, "workflows", "scripts");
    const scriptPath = join(scriptDir, `tokenize-scout-css-${runId}.js`);
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(scriptDir, { recursive: true });

    const script = `export const meta = {
  name: 'tokenize-scout-css',
  description: 'Tokenize CSS files',
  phases: [{ title: 'Tokenize CSS', detail: 'one agent per file' }],
}

const BASE = '/repo/packages/web/client/'
const REL = [
  'src/a.css',
  'src/b.css',
]
`;
    writeFileSync(scriptPath, script, "utf8");
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), jsonl([
      {
        uuid: "assistant-1",
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Workflow", input: { script } }],
        },
        cwd: "/repo/packages/web/client",
        sessionId,
        timestamp: "2026-06-03T17:00:00.000Z",
      },
      {
        type: "user",
        sourceToolAssistantUUID: "assistant-1",
        toolUseResult: {
          status: "async_launched",
          taskId: "task-1",
          runId,
          summary: "Tokenize CSS files",
          transcriptDir: workflowDir,
          scriptPath,
        },
        message: {
          role: "user",
          content: [{ type: "tool_result", content: `Workflow launched\nRun ID: ${runId}` }],
        },
        cwd: "/repo/packages/web/client",
        sessionId,
        timestamp: "2026-06-03T17:00:01.000Z",
      },
    ]), "utf8");

    writeFileSync(join(workflowDir, "journal.jsonl"), jsonl([
      { type: "started", key: "v2:a", agentId: "a111" },
      { type: "started", key: "v2:b", agentId: "b222" },
      { type: "result", key: "v2:a", agentId: "a111", result: { file: "src/a.css", valuesTokenized: 3, flags: ["review"] } },
    ]), "utf8");
    writeFileSync(join(workflowDir, "agent-a111.meta.json"), JSON.stringify({ agentType: "workflow-subagent" }), "utf8");
    writeFileSync(join(workflowDir, "agent-b222.meta.json"), JSON.stringify({ agentType: "workflow-subagent" }), "utf8");
    writeFileSync(join(workflowDir, "agent-a111.jsonl"), jsonl([
      {
        type: "user",
        message: { role: "user", content: "ASSIGNED FILE (edit ONLY this file):\n/repo/packages/web/client/src/a.css\n" },
        cwd: "/repo/packages/web/client",
        sessionId,
        timestamp: "2026-06-03T17:01:00.000Z",
      },
      {
        type: "assistant",
        message: { role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "done" }] },
        cwd: "/repo/packages/web/client",
        sessionId,
        timestamp: "2026-06-03T17:01:10.000Z",
      },
    ]), "utf8");
    writeFileSync(join(workflowDir, "agent-b222.jsonl"), jsonl([
      {
        type: "user",
        message: { role: "user", content: "ASSIGNED FILE (edit ONLY this file):\n/repo/packages/web/client/src/b.css\n" },
        cwd: "/repo/packages/web/client",
        sessionId,
        timestamp: "2026-06-03T17:02:00.000Z",
      },
    ]), "utf8");

    const topology = readClaudeWorkflowTopology({
      homeDir: home,
      cwd: "/repo",
      now: () => new Date("2026-06-03T18:00:00.000Z"),
    });

    expect(topology).toMatchObject({
      schemaVersion: "openscout.observed-harness-topology.v1",
      ownership: "harness_observed",
      source: "claude-code-workflows",
      observedAt: "2026-06-03T18:00:00.000Z",
    });
    expect(topology?.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "claude-workflow:wf_fixture-123",
        kind: "workflow",
        name: "tokenize-scout-css",
      }),
      expect.objectContaining({
        kind: "workflow_phase",
        name: "Tokenize CSS",
      }),
    ]));
    expect(topology?.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "lead",
        type: "workflow-parent-session",
        externalSessionId: sessionId,
      }),
      expect.objectContaining({
        id: "claude-workflow-agent:wf_fixture-123:a111",
        role: "subagent",
        type: "workflow-subagent",
        status: "completed",
        model: "claude-sonnet-4-6",
      }),
      expect.objectContaining({
        id: "claude-workflow-agent:wf_fixture-123:b222",
        status: "running",
      }),
    ]));
    expect(topology?.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "src/a.css",
        state: "completed",
        assigneeId: "claude-workflow-agent:wf_fixture-123:a111",
      }),
      expect.objectContaining({
        title: "src/b.css",
        state: "running",
        assigneeId: "claude-workflow-agent:wf_fixture-123:b222",
      }),
    ]));
    expect(topology?.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "spawned",
        fromId: expect.stringContaining("claude-workflow-lead:wf_fixture-123"),
        toId: "claude-workflow-agent:wf_fixture-123:a111",
      }),
      expect.objectContaining({
        kind: "assigned_to",
        fromId: "claude-workflow-task:wf_fixture-123:src-a.css",
        toId: "claude-workflow-agent:wf_fixture-123:a111",
      }),
    ]));
  });

  test("can filter workflow runs by cwd", () => {
    const home = makeTempHome();
    const sessionId = "session-1";
    const runId = "wf_other-123";
    const projectDir = join(home, ".claude", "projects", "-Users-you-dev-fixture");
    const workflowDir = join(projectDir, sessionId, "subagents", "workflows", runId);
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), jsonl([
      {
        type: "user",
        toolUseResult: {
          runId,
          summary: "Other workflow",
          transcriptDir: workflowDir,
        },
        cwd: "/repo",
        sessionId,
      },
    ]), "utf8");
    writeFileSync(join(workflowDir, "journal.jsonl"), "", "utf8");

    expect(readClaudeWorkflowTopology({
      homeDir: home,
      cwd: "/elsewhere",
      includeUnmatchedWorkflows: false,
    })).toBeNull();
    expect(readClaudeWorkflowTopology({
      homeDir: home,
      cwd: "/elsewhere",
      includeUnmatchedWorkflows: true,
    })?.groups[0]?.name).toBe("Other workflow");
  });
});
