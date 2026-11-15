import { describe, expect, test } from "bun:test";
import type { CollaborationRecord, ConversationDefinition, InvocationRequest } from "@openscout/protocol";

import { existingConversationForChannelId, scoutWhoTaskLinks } from "./service.ts";

function invocation(input: Partial<InvocationRequest> & Pick<InvocationRequest, "id" | "targetAgentId" | "task" | "createdAt">): InvocationRequest {
  return {
    origin: { source: "unknown" },
    requesterId: "operator",
    requesterNodeId: "node-1",
    action: "consult",
    ensureAwake: true,
    stream: false,
    ...input,
  };
}

describe("scoutWhoTaskLinks", () => {
  test("links each agent to the work item and task of its latest ask", () => {
    const links = scoutWhoTaskLinks({
      invocations: {
        a: invocation({ id: "a", targetAgentId: "agent-1", task: "Start the work", collaborationRecordId: "work-1", createdAt: 1 }),
        b: invocation({ id: "b", targetAgentId: "agent-1", task: "**Steer** it", collaborationRecordId: "work-2", createdAt: 2 }),
        c: invocation({ id: "c", targetAgentId: "agent-1", task: "wake", action: "wake", createdAt: 3 }),
        d: invocation({ id: "d", targetAgentId: "agent-2", task: "Quick question", createdAt: 1 }),
      },
      collaborationRecords: {
        "work-2": { id: "work-2", kind: "work_item", title: "Second work" } as CollaborationRecord,
      },
    });
    expect(links.get("agent-1")).toEqual({ workItemId: "work-2", workItemTitle: "Second work", currentTask: "Steer it" });
    expect(links.get("agent-2")).toEqual({ workItemId: null, workItemTitle: null, currentTask: "Quick question" });
    expect(links.has("agent-3")).toBe(false);
  });
});

describe("existingConversationForChannelId", () => {
  const direct = {
    id: "chn-e8beab131219420aa21cc82bc238d965",
    kind: "direct",
    title: "Agent One",
    visibility: "private",
    shareMode: "local",
    authorityNodeId: "node-1",
    participantIds: ["agent-1", "operator"],
  } as ConversationDefinition;
  const snapshot = { conversations: { [direct.id]: direct } };

  test("leaves channel names alone", () => {
    expect(existingConversationForChannelId(snapshot, "docs", "agent-1")).toBeNull();
    expect(existingConversationForChannelId(snapshot, undefined, "agent-1")).toBeNull();
  });

  test("resolves a chn- id to its conversation, or fails with a reason", () => {
    expect(existingConversationForChannelId(snapshot, ` ${direct.id} `, "agent-1")).toBe(direct);
    expect(existingConversationForChannelId(snapshot, direct.id, "operator")).toBe(direct);
    expect(() => existingConversationForChannelId(snapshot, direct.id, "agent-2")).toThrow("is not a participant");
    expect(() => existingConversationForChannelId(snapshot, "chn-0000missing", "agent-1")).toThrow("Unknown conversation chn-0000missing");
  });
});
