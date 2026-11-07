import { describe, expect, test } from "bun:test";
import type { InvocationRequest } from "@openscout/protocol";
import { buildLocalAgentDirectInvocationPrompt, buildLocalAgentNudge, buildScoutReplyContext } from "./local-agents.js";
import { buildWhenDonePromptLines, invocationWhenDone, whenDoneLine } from "./task-when-done.js";

const invocation = (patch: Partial<InvocationRequest> = {}): InvocationRequest => ({
  id: "inv-1",
  requesterId: "operator",
  requesterNodeId: "node-home",
  targetAgentId: "ranger",
  targetNodeId: "node-home",
  action: "execute",
  task: "Write the study.",
  conversationId: "dm.operator.ranger",
  messageId: "msg-1",
  ensureAwake: true,
  stream: false,
  createdAt: 1,
  ...patch,
});

describe("ask --when-done", () => {
  test("reads the step from task metadata and flattens it to one line", () => {
    expect(invocationWhenDone(invocation({ metadata: { whenDone: " open the page\n  in my browser " } })))
      .toEqual({ step: "open the page in my browser" });
    expect(invocationWhenDone(invocation())).toBeUndefined();
    expect(invocationWhenDone(invocation({ metadata: { whenDone: "   " } }))).toBeUndefined();
    expect(invocationWhenDone(invocation({ metadata: { whenDone: 7 } }))).toBeUndefined();
  });

  test("names the requester's host only when the worker is elsewhere", () => {
    const remote = invocation({ targetNodeId: "node-remote", metadata: { whenDone: "open it" } });
    expect(invocationWhenDone(remote)).toEqual({ step: "open it", requesterNodeId: "node-home" });
    expect(invocationWhenDone(invocation({ targetNodeId: undefined, metadata: { whenDone: "open it" } })))
      .toEqual({ step: "open it" });
    expect(whenDoneLine(remote)).toContain("You cannot act on their host");
    expect(buildWhenDonePromptLines(invocationWhenDone(remote)).join("\n")).toContain("another host (node-home)");
  });

  test("the reply context carries the step for current_reply_context", () => {
    expect(buildScoutReplyContext("ranger", invocation({ metadata: { whenDone: "open it" } }))?.whenDone)
      .toEqual({ step: "open it" });
    expect(buildScoutReplyContext("ranger", invocation())).not.toHaveProperty("whenDone");
  });

  test("the delivered prompt states the closing step before the task", () => {
    const prompt = buildLocalAgentDirectInvocationPrompt("ranger", invocation({
      metadata: { whenDone: "open the finished page in the operator's browser" },
    }));
    const block = prompt.indexOf("<!-- SCOUT WHEN DONE -->");
    expect(block).toBeGreaterThan(prompt.indexOf("<!-- SCOUT BROKER REPLY MODE -->"));
    expect(block).toBeLessThan(prompt.indexOf("<!-- SCOUT SESSION SEARCH -->"));
    expect(prompt).toContain("> open the finished page in the operator's browser");
    expect(prompt).toContain("before your final reply");
    expect(prompt).not.toContain("another host");
    expect(buildLocalAgentDirectInvocationPrompt("ranger", invocation())).not.toContain("SCOUT WHEN DONE");
  });

  test("the tmux nudge carries the step on one line", () => {
    const nudge = buildLocalAgentNudge("ranger", invocation({ metadata: { whenDone: "open it" } }), "flt-1");
    expect(nudge).toContain("When you finish, before your final reply: open it.");
    expect(buildLocalAgentNudge("ranger", invocation(), "flt-1")).not.toContain("When you finish");
  });
});
