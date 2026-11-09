import { describe, expect, test } from "bun:test";

import { createRuntimeRegistrySnapshot } from "@openscout/runtime/registry";

import {
  buildScoutAttentionReport,
  type ScoutAttentionGitState,
} from "./attention.ts";

describe("buildScoutAttentionReport", () => {
  test("groups unfinished work, active flights, and git signals by project", () => {
    const now = 2_000_000;
    const projectRoot = "/tmp/openscout";
    const git: ScoutAttentionGitState = {
      projectRoot,
      isGitRepo: true,
      branch: "codex/attention",
      upstream: "origin/codex/attention",
      ahead: 1,
      behind: 0,
      changedFiles: 3,
      stagedFiles: 1,
      unstagedFiles: 1,
      untrackedFiles: 1,
      hasChanges: true,
      lastCommitAt: now - 60_000,
      shortStatus: ["M file.ts"],
      error: null,
    };

    const report = buildScoutAttentionReport(
      createRuntimeRegistrySnapshot({
        agents: {
          "openscout.codex": {
            id: "openscout.codex",
            kind: "agent",
            definitionId: "openscout",
            displayName: "OpenScout Codex",
            agentClass: "builder",
            capabilities: ["invoke"],
            wakePolicy: "on_demand",
            homeNodeId: "node-1",
            authorityNodeId: "node-1",
            advertiseScope: "local",
          },
        },
        endpoints: {
          "endpoint-1": {
            id: "endpoint-1",
            agentId: "openscout.codex",
            nodeId: "node-1",
            harness: "codex",
            transport: "codex_app_server",
            state: "active",
            projectRoot,
          },
        },
        collaborationRecords: {
          "work-1": {
            id: "work-1",
            kind: "work_item",
            title: "Finish attention report",
            createdById: "operator",
            ownerId: "openscout.codex",
            nextMoveOwnerId: "openscout.codex",
            state: "waiting",
            acceptanceState: "pending",
            waitingOn: {
              kind: "approval",
              label: "operator review",
            },
            createdAt: now - 120_000,
            updatedAt: now - 30_000,
          },
        },
        invocations: {
          "inv-1": {
            id: "inv-1",
            requesterId: "operator",
            requesterNodeId: "node-1",
            targetAgentId: "openscout.codex",
            action: "execute",
            task: "Run the attention report.",
            ensureAwake: true,
            stream: true,
            createdAt: now - 20_000,
          },
        },
        flights: {
          "flt-1": {
            id: "flt-1",
            invocationId: "inv-1",
            requesterId: "operator",
            targetAgentId: "openscout.codex",
            state: "running",
            summary: "Running report.",
            startedAt: now - 10_000,
          },
        },
      }),
      {
        since: now - 2 * 24 * 60 * 60 * 1000,
        now,
        gitStates: [git],
      },
    );

    expect(report.projects).toHaveLength(1);
    expect(report.projects[0]?.projectRoot).toBe(projectRoot);
    expect(report.projects[0]?.status).toBe("needs_attention");
    expect(report.projects[0]?.reasons).toContain("work item waiting");
    expect(report.projects[0]?.reasons).toContain("active flight");
    expect(report.projects[0]?.reasons).toContain("dirty git worktree");
    expect(report.projects[0]?.nextAction).toContain("waiting work item work-1");
  });

  test("does not surface wrapped completed work without risk text", () => {
    const now = 2_000_000;
    const report = buildScoutAttentionReport(
      createRuntimeRegistrySnapshot({
        agents: {
          "done.codex": {
            id: "done.codex",
            kind: "agent",
            definitionId: "done",
            displayName: "Done Codex",
            agentClass: "builder",
            capabilities: ["invoke"],
            wakePolicy: "on_demand",
            homeNodeId: "node-1",
            authorityNodeId: "node-1",
            advertiseScope: "local",
            metadata: { projectRoot: "/tmp/done" },
          },
        },
        invocations: {
          "inv-1": {
            id: "inv-1",
            requesterId: "operator",
            requesterNodeId: "node-1",
            targetAgentId: "done.codex",
            action: "execute",
            task: "Finish it.",
            ensureAwake: true,
            stream: true,
            createdAt: now - 20_000,
          },
        },
        flights: {
          "flt-1": {
            id: "flt-1",
            invocationId: "inv-1",
            requesterId: "operator",
            targetAgentId: "done.codex",
            state: "completed",
            summary: "Done.",
            completedAt: now - 10_000,
          },
        },
      }),
      { since: now - 60_000, now },
    );

    expect(report.projects).toHaveLength(0);
  });

  test("does not surface dismissed failed flight attention", () => {
    const now = 2_000_000;
    const report = buildScoutAttentionReport(
      createRuntimeRegistrySnapshot({
        agents: {
          "failed.codex": {
            id: "failed.codex",
            kind: "agent",
            definitionId: "failed",
            displayName: "Failed Codex",
            agentClass: "builder",
            capabilities: ["invoke"],
            wakePolicy: "on_demand",
            homeNodeId: "node-1",
            authorityNodeId: "node-1",
            advertiseScope: "local",
            metadata: { projectRoot: "/tmp/failed" },
          },
        },
        invocations: {
          "inv-1": {
            id: "inv-1",
            requesterId: "operator",
            requesterNodeId: "node-1",
            targetAgentId: "failed.codex",
            action: "execute",
            task: "Start the session.",
            ensureAwake: true,
            stream: true,
            createdAt: now - 20_000,
          },
        },
        flights: {
          "flt-1": {
            id: "flt-1",
            invocationId: "inv-1",
            requesterId: "operator",
            targetAgentId: "failed.codex",
            state: "failed",
            error: "Codex app-server cwd does not exist.",
            startedAt: now - 10_000,
            completedAt: now - 5_000,
            metadata: {
              operatorAttentionDismissedAt: now - 4_000,
            },
          },
        },
      }),
      { since: now - 60_000, now },
    );

    expect(report.projects).toHaveLength(0);
  });

  test("does not surface risky messages tied to dismissed flight attention", () => {
    const now = 2_000_000;
    const report = buildScoutAttentionReport(
      createRuntimeRegistrySnapshot({
        agents: {
          "failed.codex": {
            id: "failed.codex",
            kind: "agent",
            definitionId: "failed",
            displayName: "Failed Codex",
            agentClass: "builder",
            capabilities: ["invoke"],
            wakePolicy: "on_demand",
            homeNodeId: "node-1",
            authorityNodeId: "node-1",
            advertiseScope: "local",
            metadata: { projectRoot: "/tmp/failed" },
          },
        },
        invocations: {
          "inv-1": {
            id: "inv-1",
            requesterId: "operator",
            requesterNodeId: "node-1",
            targetAgentId: "failed.codex",
            action: "execute",
            task: "Start the session.",
            ensureAwake: true,
            stream: true,
            createdAt: now - 20_000,
          },
        },
        flights: {
          "flt-1": {
            id: "flt-1",
            invocationId: "inv-1",
            requesterId: "operator",
            targetAgentId: "failed.codex",
            state: "failed",
            error: "Codex app-server cwd does not exist.",
            startedAt: now - 10_000,
            completedAt: now - 5_000,
            metadata: {
              operatorAttentionDismissedAt: now - 4_000,
            },
          },
        },
        messages: {
          "msg-1": {
            id: "msg-1",
            conversationId: "c.failed",
            actorId: "system",
            originNodeId: "node-1",
            body: "failed to respond: Codex app-server cwd does not exist.",
            class: "status",
            visibility: "private",
            policy: "durable",
            createdAt: now - 4_500,
            metadata: {
              flightId: "flt-1",
              invocationId: "inv-1",
            },
          },
        },
      }),
      { since: now - 60_000, now },
    );

    expect(report.projects).toHaveLength(0);
  });

  test("maps risky system messages to a mentioned known project root", () => {
    const now = 2_000_000;
    const report = buildScoutAttentionReport(
      createRuntimeRegistrySnapshot({
        agents: {
          "openscout.codex": {
            id: "openscout.codex",
            kind: "agent",
            definitionId: "openscout",
            displayName: "OpenScout Codex",
            agentClass: "builder",
            capabilities: ["invoke"],
            wakePolicy: "on_demand",
            homeNodeId: "node-1",
            authorityNodeId: "node-1",
            advertiseScope: "local",
            metadata: { projectRoot: "/Users/guest/dev/openscout" },
          },
        },
        messages: {
          "msg-1": {
            id: "msg-1",
            conversationId: "channel.system",
            actorId: "system",
            originNodeId: "node-1",
            body: "Please work in /Users/guest/dev/openscout. Previous run failed.",
            class: "status",
            visibility: "private",
            policy: "durable",
            createdAt: now - 10_000,
          },
        },
      }),
      { since: now - 60_000, now },
    );

    expect(report.projects).toHaveLength(1);
    expect(report.projects[0]?.projectRoot).toBe("/Users/guest/dev/openscout");
    expect(report.projects[0]?.reasons).toContain("recent risky message");
  });

  test("skips broker stale-flight reconciliation failures", () => {
    const now = 2_000_000;
    const report = buildScoutAttentionReport(
      createRuntimeRegistrySnapshot({
        agents: {
          "talkie.codex": {
            id: "talkie.codex",
            kind: "agent",
            definitionId: "talkie",
            displayName: "Talkie Codex",
            agentClass: "builder",
            capabilities: ["invoke"],
            wakePolicy: "on_demand",
            homeNodeId: "node-1",
            authorityNodeId: "node-1",
            advertiseScope: "local",
            metadata: { projectRoot: "/Users/guest/dev/talkie" },
          },
        },
        invocations: {
          "inv-1": {
            id: "inv-1",
            requesterId: "operator",
            requesterNodeId: "node-1",
            targetAgentId: "talkie.codex",
            action: "execute",
            task: "Do the work.",
            ensureAwake: true,
            stream: true,
            createdAt: now - 20_000,
          },
        },
        flights: {
          "flt-stale": {
            id: "flt-stale",
            invocationId: "inv-1",
            requesterId: "operator",
            targetAgentId: "talkie.codex",
            state: "failed",
            error: "Stale running flight reconciled: endpoint started newer work",
            completedAt: now - 10_000,
          },
        },
      }),
      { since: now - 60_000, now },
    );

    expect(report.projects).toHaveLength(0);
  });
});
