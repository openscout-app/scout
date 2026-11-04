import { describe, expect, test } from "bun:test";

import type { Block, SessionState } from "@openscout/agent-sessions";

import { collapseAgentNotification } from "@openscout/protocol";

import {
  agentNotificationForOperatorSignal,
  agentNotificationForPermissionRequest,
  agentNotificationForSessionAttention,
  countDiffLines,
  notificationHostName,
  permissionDialogView,
  pushDeliveryForLevel,
  type AttentionNotificationItem,
} from "./agent-notification-builders.js";

function snapshotWith(block: Block, turn: Partial<SessionState["turns"][number]> = {}): SessionState {
  return {
    session: { id: "s1", name: "machiavelli", adapterType: "claude-code", status: "active", cwd: "/Users/art/dev/openscout" },
    turns: [{ id: "t1", status: "streaming", startedAt: 1_000, blocks: [{ block, status: "streaming" }], ...turn }],
  } as SessionState;
}

function item(kind: string, extra: Partial<AttentionNotificationItem> = {}): AttentionNotificationItem {
  return {
    id: `item-${kind}`,
    kind,
    title: "Approve Command",
    description: "Run the release script",
    sessionId: "s1",
    sessionName: "machiavelli",
    turnId: "t1",
    blockId: "b1",
    risk: "high",
    createdAt: 5_000,
    ...extra,
  };
}

const base = { id: "b1", turnId: "t1", index: 0, status: "streaming" } as const;

describe("agent notification builders", () => {
  test("a command awaiting approval becomes turn.approve.command with its cwd and risk", () => {
    const block = {
      ...base,
      type: "action",
      action: { kind: "command", command: "bash release.sh", status: "awaiting_approval", output: "", approval: { version: 1, risk: "high", description: "Ship the build" } },
    } as unknown as Block;
    const n = agentNotificationForSessionAttention({ item: item("approval"), snapshot: snapshotWith(block), host: "arts mini" });
    expect(n).toMatchObject({
      view: "turn.approve.command",
      command: "bash release.sh",
      cwd: "/Users/art/dev/openscout",
      risk: "high",
      why: "Ship the build",
      sender: { name: "machiavelli" },
      project: "openscout",
      host: "arts mini",
      level: "active",
      route: { open: "inbox", sessionId: "s1", turnId: "t1", blockId: "b1" },
    });
  });

  test("a file change counts its diff", () => {
    const block = {
      ...base,
      type: "action",
      action: { kind: "file_change", path: "src/a.ts", diff: "--- a\n+++ b\n+one\n+two\n-three\n context", status: "awaiting_approval", output: "" },
    } as unknown as Block;
    const n = agentNotificationForSessionAttention({ item: item("approval", { risk: "medium" }), snapshot: snapshotWith(block) });
    expect(n).toMatchObject({ view: "turn.approve.edit", risk: "medium", files: [{ path: "src/a.ts", added: 2, removed: 1 }] });
    expect(countDiffLines(undefined)).toEqual({ added: 0, removed: 0 });
  });

  test("a question with options is a choice; without options it is open", () => {
    const withOptions = { ...base, type: "question", question: "Which client?", header: "Embedding", options: [{ label: "In-process" }, { label: "XPC" }], multiSelect: false, questionStatus: "awaiting_answer" } as unknown as Block;
    expect(agentNotificationForSessionAttention({ item: item("question"), snapshot: snapshotWith(withOptions) })).toMatchObject({
      view: "turn.question.choice", question: "Which client?", options: ["In-process", "XPC"], context: "Embedding", level: "active",
    });
    const open = { ...base, type: "question", question: "What should it be called?", options: [], multiSelect: false, questionStatus: "awaiting_answer" } as unknown as Block;
    expect(agentNotificationForSessionAttention({ item: item("question"), snapshot: snapshotWith(open) })).toMatchObject({
      view: "turn.question.open", question: "What should it be called?",
    });
  });

  test("a failed action is quiet and carries the tail of its output and the elapsed time", () => {
    const block = { ...base, type: "action", action: { kind: "command", command: "probe", status: "failed", output: "a\nb\nc\nd\ne\n" } } as unknown as Block;
    const n = agentNotificationForSessionAttention({
      item: item("failed_action", { description: "The operation timed out" }),
      snapshot: snapshotWith(block, { endedAt: 121_000 }),
    });
    expect(n).toMatchObject({ view: "turn.failed", error: "The operation timed out", excerpt: ["b", "c", "d", "e"], elapsed: "2m", level: "passive" });
  });

  test("inferred attention is quiet text", () => {
    const n = agentNotificationForSessionAttention({ item: item("native_attention", { title: "Waiting", description: "Looks idle" }), snapshot: null });
    expect(n).toMatchObject({ view: "text", title: "Waiting", body: "Looks idle", level: "passive" });
  });

  test("an operator need is a time-sensitive ask with its question and options, opened in its chat", () => {
    const n = agentNotificationForOperatorSignal({
      messageId: "msg-1",
      conversationId: "dm",
      signal: { kind: "need", blocking: true, replyExpectation: "required", question: "Deploy now?", options: ["Yes", "Wait"] },
      agentName: "cajun",
      agentId: "agent.cajun",
      body: "Full message body",
      createdAt: 1,
      host: "mini",
    });
    expect(n).toMatchObject({
      view: "ask", note: "Deploy now?", options: ["Yes", "Wait"], reply: "required", level: "time-sensitive",
      sender: { name: "cajun", agentId: "agent.cajun" },
      route: { open: "chat", messageId: "msg-1", conversationId: "dm" },
    });
    expect(collapseAgentNotification(n)).toMatchObject({ title: "cajun is waiting on your answer", body: "Deploy now?" });
  });

  test("a consult is a passive ask; a notify is passive text", () => {
    const consult = agentNotificationForOperatorSignal({
      messageId: "m", signal: { kind: "consult", blocking: false, replyExpectation: "optional", defaultAction: "keep going" },
      agentName: "a", body: "Thoughts?", createdAt: 1, host: "mini",
    });
    expect(consult).toMatchObject({ view: "ask", note: "Thoughts?", reply: "optional", level: "passive" });
    const notify = agentNotificationForOperatorSignal({
      messageId: "m", signal: { kind: "notify", blocking: false, replyExpectation: "none" },
      agentName: "a", body: "Done with the pass.", createdAt: 1, host: "mini",
    });
    expect(notify).toMatchObject({ view: "text", title: "Shared an update", body: "Done with the pass.", level: "passive" });
  });

  test("only passive notifications go out without a sound", () => {
    expect(pushDeliveryForLevel("time-sensitive")).toEqual({ sound: "default", urgency: "interrupt" });
    expect(pushDeliveryForLevel("active")).toEqual({ sound: "default", urgency: "interrupt" });
    expect(pushDeliveryForLevel("passive")).toEqual({ sound: null, urgency: "silent" });
  });

  test("host name drops .local", () => {
    expect(notificationHostName("arts-mini.local")).toBe("arts-mini");
  });
});

const dialog = (body: string[]) => [
  ...body,
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and don't ask again for git status commands in /work/openscout",
  "   3. No, and tell Claude what to do differently (esc)",
  "",
  " Esc to cancel · Tab to amend",
].join("\n");

describe("permission request notifications", () => {
  test("a Bash dialog reads as a command with Claude's description", () => {
    const text = dialog([" Bash command", "", "   git status --short", "   Show working tree status", "", " Permission rule Bash requires confirmation for this command."]);
    expect(permissionDialogView(text)).toEqual({ view: "turn.approve.command", command: "git status --short", why: "Show working tree status" });
  });

  test("an edit dialog names the file", () => {
    const text = dialog([" Edit file", "   packages/protocol/src/agent-notifications.ts"]);
    expect(permissionDialogView(text)).toEqual({ view: "turn.approve.edit", files: [{ path: "packages/protocol/src/agent-notifications.ts", added: 0, removed: 0 }] });
  });

  test("an MCP call names the server and tool", () => {
    const text = dialog([" Tool use", "", "   scout - ask(to: \"pike\") (MCP)"]);
    expect(permissionDialogView(text)).toMatchObject({ view: "turn.approve.tool", tool: "scout ask" });
  });

  test("the trust dialog names the folder", () => {
    const text = " Accessing workspace:\n\n /work/openscout/web\n\n ❯ 1. Yes, I trust this folder\n   2. No, exit\n\n Enter to confirm · Esc to cancel";
    expect(permissionDialogView(text)).toEqual({ view: "turn.approve.tool", tool: "this folder", summary: "/work/openscout/web" });
  });

  test("scrollback above a dialog it cannot read never reaches the push", () => {
    // The reported push: the session's screen held the tail of a long markdown
    // ask above the dialog, and that text became the notification body.
    const text = dialog([
      "or file a new one with the observed evidence.",
      "",
      "## Setup",
      "- run the dev instance",
      "",
      " Some new dialog header",
      "   a line the parser does not know",
    ]);
    const n = agentNotificationForPermissionRequest({
      requestId: "permission-1", text, agentName: "web-schumann-15", agentId: "session-abc123",
      project: "web", host: "host-a", createdAt: 1, conversationId: "dm", messageId: "msg-ask", sessionId: "session-abc123",
    });
    const collapsed = collapseAgentNotification(n);
    expect(collapsed).toMatchObject({ title: "web-schumann-15 wants to use a tool", subtitle: "web", body: "" });
    expect(JSON.stringify(n)).not.toContain("observed evidence");
    expect(n).toMatchObject({
      level: "active",
      itemId: "permission-1",
      route: { open: "inbox", requestId: "permission-1", conversationId: "dm", messageId: "msg-ask", sessionId: "session-abc123" },
    });
  });

  test("a Bash permission reads like the Claude app's: who wants what, then what it is for", () => {
    const text = dialog([" Bash command", "", "   gh pr list --state open", "   List open pull requests", "", " Permission rule Bash requires confirmation for this command."]);
    const n = agentNotificationForPermissionRequest({ requestId: "p", text, agentName: "pike", agentId: "agent.pike", project: "scout", createdAt: 1 });
    expect(collapseAgentNotification(n)).toMatchObject({ title: "pike wants to run a command", subtitle: "scout", body: "List open pull requests", level: "active" });
  });
});
