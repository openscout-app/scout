import { describe, expect, test } from "bun:test";

import {
  agentNotificationActions,
  clampAgentNotification,
  collapseAgentNotification,
  nativeActorName,
  notificationPlainLine,
  sealedAgentNotification,
  type AgentNotification,
} from "./agent-notifications.js";

const base = {
  v: 1 as const,
  itemId: "item-1",
  sender: { name: "machiavelli", agentId: "agent.machiavelli" },
  project: "openscout",
  host: "studio",
  level: "active" as const,
  createdAt: 1,
};

describe("agent notifications", () => {
  test("a command approval says who wants to run a command, then what it is for", () => {
    const n: AgentNotification = {
      ...base,
      view: "turn.approve.command",
      command: "bash apps/ios/scripts/release.sh",
      why: "Ship the iOS build",
      risk: "high",
    };
    expect(collapseAgentNotification(n)).toEqual({
      title: "machiavelli wants to run a command",
      subtitle: "openscout on studio",
      body: "Ship the iOS build",
      headline: "Wants to run a command",
      category: "scout.approval",
      threadId: "scout.agent.agent.machiavelli",
      level: "active",
    });
    expect(agentNotificationActions(n)).toEqual(["approve", "deny"]);
  });

  test("a session started outside Scout reads as its harness, never its raw id", () => {
    const n: AgentNotification = {
      ...base,
      sender: { name: "native:claude:d158a9ca-2f1e-4c1a-9b7e-0c4b1f2a3d4e", agentId: "native:claude:d158a9ca-2f1e-4c1a-9b7e-0c4b1f2a3d4e" },
      view: "turn.approve.command",
      command: "rm -rf dist",
    };
    expect(collapseAgentNotification(n).title).toBe("Claude wants to run a command");
    expect(nativeActorName("native:codex:abc")).toBe("Codex");
    expect(nativeActorName("agent.machiavelli")).toBeNull();
  });

  test("the subtitle says where: the project on its host, or whichever is known", () => {
    const n: AgentNotification = { ...base, view: "turn.approve.command", command: "ls" };
    expect(collapseAgentNotification(n).subtitle).toBe("openscout on studio");
    expect(collapseAgentNotification({ ...n, host: undefined }).subtitle).toBe("openscout");
    expect(collapseAgentNotification({ ...n, project: undefined }).subtitle).toBe("studio");
  });

  test("a command without a description shows the command", () => {
    const n: AgentNotification = { ...base, view: "turn.approve.command", command: "git push origin main" };
    expect(collapseAgentNotification(n).body).toBe("git push origin main");
  });

  test("an edit names the one file it touches", () => {
    const one: AgentNotification = { ...base, view: "turn.approve.edit", files: [{ path: "src/a.ts", added: 3, removed: 1 }] };
    expect(collapseAgentNotification(one)).toMatchObject({ title: "machiavelli wants to edit a.ts", body: "src/a.ts" });
    const two: AgentNotification = {
      ...base,
      view: "turn.approve.edit",
      summary: "Rename the client",
      files: [{ path: "a.ts", added: 3, removed: 1 }, { path: "b.ts", added: 2, removed: 0 }],
    };
    expect(collapseAgentNotification(two)).toMatchObject({ title: "machiavelli wants to edit 2 files", body: "Rename the client" });
  });

  test("a choice question puts the question in the body and takes a reply", () => {
    const n: AgentNotification = { ...base, view: "turn.question.choice", question: "Which client?", options: ["In-process", "XPC"] };
    const collapsed = collapseAgentNotification(n);
    expect(collapsed.title).toBe("machiavelli asks you to choose");
    expect(collapsed.body).toBe("Which client?");
    expect(collapsed.category).toBe("scout.question");
    expect(agentNotificationActions(n)).toEqual(["reply"]);
  });

  test("an ask the agent waits on reads as waiting on your answer", () => {
    const n: AgentNotification = {
      ...base,
      level: "time-sensitive",
      view: "ask",
      note: "Ship to staging or prod?",
      reply: "required",
    };
    const collapsed = collapseAgentNotification(n);
    expect(collapsed.category).toBe("scout.question");
    expect(collapsed.title).toBe("machiavelli is waiting on your answer");
    expect(collapsed.body).toBe("Ship to staging or prod?");
  });

  test("a declared permission ask says so", () => {
    const n: AgentNotification = { ...base, view: "ask", note: "Write to /etc/hosts?", reply: "required", permission: true };
    expect(collapseAgentNotification(n).title).toBe("machiavelli needs your permission");
  });

  test("a long markdown ask shows its first line as plain text, never a slice from inside it", () => {
    const note = [
      "## Fix how pushes read",
      "",
      "The operator raised this from the **lock screen**. Reuse the open issue,",
      "or file a new one with the observed evidence.",
      "",
      "## Setup",
      "- run `bun test`",
    ].join("\n");
    const n: AgentNotification = { ...base, view: "ask", note, reply: "optional" };
    const collapsed = collapseAgentNotification(n);
    expect(collapsed.title).toBe("machiavelli would like your input");
    expect(collapsed.body).toBe("Fix how pushes read");
  });

  test("a failure is one plain line and the subtitle keeps the host when the project is missing", () => {
    const n: AgentNotification = {
      ...base,
      sender: { name: "pike" },
      project: undefined,
      level: "passive",
      view: "turn.failed",
      error: "the operation timed out",
    };
    const collapsed = collapseAgentNotification(n);
    expect(collapsed.title).toBe("pike stopped on an error");
    expect(collapsed.subtitle).toBe("studio");
    expect(collapsed.threadId).toBe("scout.agent.pike");
    expect(collapsed.body).toBe("the operation timed out");
  });

  test("work.done offers the link first only when an artifact has one", () => {
    const withLink: AgentNotification = { ...base, view: "work.done", summary: "Trimmed cache", artifacts: [{ kind: "pr", label: "PR", url: "https://x" }] };
    const without: AgentNotification = { ...base, view: "work.done", summary: "Trimmed cache" };
    expect(agentNotificationActions(withLink)).toEqual(["open_link", "open_chat"]);
    expect(agentNotificationActions(without)).toEqual(["open_chat"]);
    expect(collapseAgentNotification(without)).toMatchObject({ title: "machiavelli finished", body: "Trimmed cache" });
  });

  test("text keeps the agent as the title", () => {
    const n: AgentNotification = { ...base, level: "passive", view: "text", title: "Shared an update", body: "Done with the **pass**." };
    expect(collapseAgentNotification(n)).toMatchObject({ title: "machiavelli", body: "Shared an update\nDone with the pass." });
  });

  test("sealing marks only time-sensitive notifications urgent for older phones", () => {
    const ask: AgentNotification = { ...base, level: "time-sensitive", view: "ask", note: "Deploy?" };
    const approval: AgentNotification = { ...base, view: "turn.approve.tool", tool: "Read" };
    expect(sealedAgentNotification(ask)).toMatchObject({ urgent: true, lockScreen: { level: "time-sensitive" } });
    expect(sealedAgentNotification(approval)).toMatchObject({ urgent: false, lockScreen: { level: "active", title: "machiavelli wants to use Read" } });
  });

  test("clamp bounds long fields and lists", () => {
    const n: AgentNotification = {
      ...base,
      view: "turn.question.choice",
      question: "q".repeat(2000),
      options: Array.from({ length: 10 }, (_, i) => `option ${i}`),
    };
    const clamped = clampAgentNotification(n);
    if (clamped.view !== "turn.question.choice") throw new Error("view changed");
    expect(clamped.question.length).toBe(400);
    expect(clamped.question.endsWith("…")).toBe(true);
    expect(clamped.options).toHaveLength(6);
  });
});

describe("notificationPlainLine", () => {
  test("strips markdown markers, links, emphasis, and code", () => {
    expect(notificationPlainLine("# **Ship** the [build](https://x.test) with `bun run ship`")).toBe("Ship the build with bun run ship");
    expect(notificationPlainLine("> - [ ] _review_ the diff")).toBe("review the diff");
    expect(notificationPlainLine("keep snake_case_names intact")).toBe("keep snake_case_names intact");
  });

  test("skips blank lines, rules, and fences; uses fenced text only when nothing else is there", () => {
    expect(notificationPlainLine("\n---\n```sh\nrm -rf build\n```\nClean the build folder")).toBe("Clean the build folder");
    expect(notificationPlainLine("```sh\nrm -rf build\n```")).toBe("rm -rf build");
  });

  test("cuts a long line at a sentence, else at a word", () => {
    const sentence = `Check the deploy before I go further. ${"More context follows here. ".repeat(10)}`;
    expect(notificationPlainLine(sentence, 60)).toBe("Check the deploy before I go further.");
    const words = "word ".repeat(40);
    const cut = notificationPlainLine(words, 30);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(30);
  });
});

test("tool approval why is the lock-screen body, old summary still works", () => {
  const notification: AgentNotification = { ...base, view: "turn.approve.tool", tool: "EnterWorktree", summary: "target", why: "Creating an isolated workspace." };
  expect(sealedAgentNotification(notification).lockScreen.body).toBe("Creating an isolated workspace.");
  expect(collapseAgentNotification({ ...notification, why: undefined }).body).toBe("target");
  expect((clampAgentNotification({ ...notification, why: "x".repeat(1000) }) as typeof notification).why!.length).toBeLessThanOrEqual(240);
});
