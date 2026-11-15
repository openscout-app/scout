import { describe, expect, test } from "bun:test";

import type { LocalAgentBinding } from "./local-agents";
import { buildScoutAgentCard } from "./scout-agent-cards";

describe("buildScoutAgentCard", () => {
  test("builds a usable card from a local agent binding", () => {
    const binding: LocalAgentBinding = {
      actor: {
        id: "dewey.node.workspace",
        kind: "agent",
        displayName: "Dewey",
        handle: "dewey",
        metadata: {
          project: "Dewey",
        },
      },
      agent: {
        id: "dewey.node.workspace",
        kind: "agent",
        definitionId: "dewey",
        displayName: "Dewey",
        handle: "dewey",
        selector: "@dewey.node.workspace",
        defaultSelector: "@dewey",
        agentClass: "general",
        capabilities: ["chat", "invoke", "deliver"],
        wakePolicy: "on_demand",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
        metadata: {
          project: "Dewey",
          projectRoot: "/Users/guest/dev/dewey",
          branch: "main",
          description: "General coding assistant for the Dewey workspace.",
          version: "2026.04",
          documentationUrl: "https://example.com/dewey",
          skills: [
            {
              name: "review",
              description: "Reviews patches in the Dewey workspace.",
            },
          ],
          defaultInputModes: ["text"],
          defaultOutputModes: ["text"],
        },
      },
      endpoint: {
        id: "endpoint.dewey",
        agentId: "dewey.node.workspace",
        nodeId: "node-1",
        harness: "claude",
        transport: "claude_stream_json",
        state: "idle",
        cwd: "/Users/guest/dev/dewey",
        projectRoot: "/Users/guest/dev/dewey",
        sessionId: "relay-dewey-claude",
      },
    };

    const card = buildScoutAgentCard(binding, {
      currentDirectory: "/Users/guest/dev/dewey/worktrees/feature-x",
      createdById: "arc.node.workspace",
      brokerRegistered: true,
      inboxConversationId: "dm.arc.node.workspace.dewey.node.workspace",
    });

    expect(card.agentId).toBe("dewey.node.workspace");
    expect(card.handle).toBe("dewey");
    expect(card.currentDirectory).toBe("/Users/guest/dev/dewey/worktrees/feature-x");
    expect(card.inboxConversationId).toBe("dm.arc.node.workspace.dewey.node.workspace");
    expect(card.returnAddress.selector).toBe("@dewey.node.workspace");
    expect(card.returnAddress.conversationId).toBe("dm.arc.node.workspace.dewey.node.workspace");
    expect(card.brokerRegistered).toBe(true);
    expect(card.description).toBe("General coding assistant for the Dewey workspace.");
    expect(card.skills?.[0]?.name).toBe("review");
    expect(card.defaultInputModes).toEqual(["text"]);
  });
});
