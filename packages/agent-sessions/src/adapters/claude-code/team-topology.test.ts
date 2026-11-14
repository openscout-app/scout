import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readClaudeAgentTeamTopology } from "./team-topology.ts";

const tempPaths = new Set<string>();

afterEach(() => {
  for (const path of tempPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  tempPaths.clear();
});

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "openscout-claude-teams-"));
  tempPaths.add(home);
  return home;
}

describe("readClaudeAgentTeamTopology", () => {
  test("normalizes Claude agent-team config and task files into observed topology", () => {
    const home = makeTempHome();
    const teamDir = join(home, ".claude", "teams", "todo-cli-review");
    const taskDir = join(home, ".claude", "tasks", "todo-cli-review", "pending");
    mkdirSync(teamDir, { recursive: true });
    mkdirSync(taskDir, { recursive: true });

    writeFileSync(join(teamDir, "config.json"), JSON.stringify({
      name: "todo-cli-review",
      cwd: "/Users/you/dev/todo-cli",
      lead: {
        sessionId: "lead-session-1",
      },
      members: [
        {
          name: "UX",
          agentId: "ux-1",
          agentType: "ux-reviewer",
          sessionId: "ux-session-1",
          status: "running",
        },
        {
          name: "Architecture",
          agentId: "arch-1",
          agentType: "architect",
        },
      ],
    }), "utf8");

    writeFileSync(join(taskDir, "ux.json"), JSON.stringify({
      id: "ux-task",
      title: "Review command ergonomics",
      status: "pending",
      assigneeId: "ux-1",
      dependencies: ["architecture-task"],
    }), "utf8");

    const topology = readClaudeAgentTeamTopology({
      homeDir: home,
      cwd: "/Users/you/dev/todo-cli",
      claudeSessionId: "lead-session-1",
      now: () => new Date("2026-05-05T12:00:00.000Z"),
    });

    expect(topology).toMatchObject({
      schemaVersion: "openscout.observed-harness-topology.v1",
      ownership: "harness_observed",
      source: "claude-code-agent-teams",
      observedAt: "2026-05-05T12:00:00.000Z",
    });
    expect(topology?.groups).toEqual([
      expect.objectContaining({
        id: "claude-team:todo-cli-review",
        kind: "team",
        name: "todo-cli-review",
      }),
    ]);
    expect(topology?.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "lead",
        externalSessionId: "lead-session-1",
      }),
      expect.objectContaining({
        id: "claude-agent:todo-cli-review:ux-1",
        name: "UX",
        type: "ux-reviewer",
        externalSessionId: "ux-session-1",
      }),
    ]));
    expect(topology?.tasks).toEqual([
      expect.objectContaining({
        id: "claude-task:todo-cli-review:ux-task",
        title: "Review command ergonomics",
        state: "pending",
        assigneeId: "claude-agent:todo-cli-review:ux-1",
        dependencyIds: ["claude-task:todo-cli-review:architecture-task"],
      }),
    ]);
    expect(topology?.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "leads",
        fromId: expect.stringContaining(":lead:lead-session-1"),
        toId: "claude-agent:todo-cli-review:ux-1",
      }),
      expect.objectContaining({
        kind: "assigned_to",
        fromId: "claude-task:todo-cli-review:ux-task",
        toId: "claude-agent:todo-cli-review:ux-1",
      }),
    ]));
  });

  test("does not surface unrelated Claude teams unless explicitly requested", () => {
    const home = makeTempHome();
    const teamDir = join(home, ".claude", "teams", "old-team");
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, "config.json"), JSON.stringify({
      name: "old-team",
      cwd: "/elsewhere",
      members: [{ name: "Research", agentId: "research-1" }],
    }), "utf8");

    expect(readClaudeAgentTeamTopology({
      homeDir: home,
      cwd: "/Users/you/dev/todo-cli",
      claudeSessionId: "lead-session-1",
    })).toBeNull();

    expect(readClaudeAgentTeamTopology({
      homeDir: home,
      includeUnmatchedTeams: true,
    })?.groups[0]?.name).toBe("old-team");
  });
});
