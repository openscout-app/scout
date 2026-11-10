import { expect, test } from "bun:test";
import { directChannelNaturalKey } from "@openscout/protocol";
import { conversationIdForSession } from "./session-conversation.js";

test.each(["sessionId", "nativeSessionId", "externalSessionId"])("joins %s to the agent direct conversation", field => {
  const snapshot = {
    endpoints: { endpoint: { agentId: "agent-one", ...(field === "sessionId" ? { sessionId: "native-one" } : { metadata: { [field]: "native-one" } }) } },
    conversations: { chat: { id: "chat", participantIds: ["operator", "agent-one"], metadata: { naturalKey: directChannelNaturalKey(["operator", "agent-one"]) } } },
    messages: {},
  };
  expect(conversationIdForSession(snapshot, "native-one")).toBe("chat");
  expect(conversationIdForSession(snapshot, "unknown")).toBeNull();
});
test("uses recent participating non-channel chat and rejects ambiguous joins", () => {
  const snapshot = {
    endpoints: { e: { agentId: "a", sessionId: "native-one" } },
    conversations: {
      old: { id: "old", kind: "direct", participantIds: ["operator", "a"] },
      recent: { id: "recent", kind: "direct", participantIds: ["operator", "a"] },
      channel: { id: "channel", kind: "channel", participantIds: ["operator", "a"] },
    },
    messages: { m1: { conversationId: "old", createdAt: 1 }, m2: { conversationId: "recent", createdAt: 2 }, m3: { conversationId: "channel", createdAt: 3 } },
  };
  expect(conversationIdForSession(snapshot, "native-one")).toBe("recent");
  expect(conversationIdForSession({ ...snapshot, endpoints: { ...snapshot.endpoints, e2: { agentId: "b", sessionId: "native-one" } }, conversations: { ...snapshot.conversations, b: { id: "b", participantIds: ["b", "operator"] } } }, "native-one")).toBeNull();
});
