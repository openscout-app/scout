import { describe, expect, test } from "bun:test";

import {
  agentNotificationActions,
  clampAgentNotification,
  collapseAgentNotification,
  nativeActorName,
  notificationPlainLine,
  notificationSenderLabel,
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
  test("a command approval leads with the action and target, sender and project, then intent before command", () => {
    const n: AgentNotification = {
      ...base,
      view: "turn.approve.command",
      command: "bash apps/ios/scripts/release.sh",
      why: "Ship the iOS build",
      risk: "high",
      canAlwaysAllow: true,
    };
    expect(collapseAgentNotification(n)).toEqual({
      title: "Run release.sh",
      subtitle: "machiavelli · openscout",
      body: "Ship the iOS build\nbash apps/ios/scripts/release.sh",
      headline: "Wants to run a command",
      category: "scout.approval",
      threadId: "scout.agent.agent.machiavelli",
      level: "active",
    });
    expect(sealedAgentNotification(n).canAlwaysAllow).toBe(true);
    expect(agentNotificationActions(n)).toEqual(["approve", "deny"]);
  });

  test("a session started outside Scout reads as its harness, never its raw id", () => {
    const n: AgentNotification = {
      ...base,
      sender: { name: "native:claude:d158a9ca-2f1e-4c1a-9b7e-0c4b1f2a3d4e", agentId: "native:claude:d158a9ca-2f1e-4c1a-9b7e-0c4b1f2a3d4e" },
      view: "turn.approve.command",
      command: "rm -rf dist",
    };
    expect(collapseAgentNotification(n)).toMatchObject({
      title: "Delete files · openscout",
      subtitle: "Claude 3d4e · openscout",
      body: "rm -rf dist",
    });
    expect(nativeActorName("native:codex:abc")).toBe("Codex");
    expect(nativeActorName("agent.machiavelli")).toBeNull();
  });

  test("the sender reads as a short name and its roster number, never a handle", () => {
    // A dotted agent id loses its branch and host; the banner already says where.
    expect(notificationSenderLabel({ name: "pike.main.studio", code: "005" })).toBe("pike 005");
    expect(notificationSenderLabel({ name: "pike.main.studio" })).toBe("pike");
    // A generated handle reads as its harness, then its roster number.
    expect(notificationSenderLabel({ name: "session-mwfxl324-wqoium.feat-canvas.studio", harness: "codex", code: "012" }))
      .toBe("Codex 012");
    // Unnumbered, it keeps the last characters of its own id.
    expect(notificationSenderLabel({ name: "session-mw00fkgt-qbus4s.studio", harness: "claude-code" })).toBe("Claude us4s");
    expect(notificationSenderLabel({ name: "session-mw00fkgt-qbus4s.studio" })).toBe("Agent us4s");
    // A display name the operator chose stays as written.
    expect(notificationSenderLabel({ name: "Release captain", code: "007" })).toBe("Release captain 007");
    expect(notificationSenderLabel({ name: "codex" })).toBe("Codex");
    expect(notificationSenderLabel({ name: "a-very-long-agent-handle-that-goes-on-and-on.main.host" }).length).toBeLessThanOrEqual(24);

    const n: AgentNotification = {
      ...base,
      sender: { name: "session-mwfxl324-wqoium.feat-canvas.studio", harness: "codex", code: "012" },
      project: "webshop",
      host: "studio",
      view: "turn.approve.command",
      command: "git status",
      why: "Show working tree status",
    };
    expect(collapseAgentNotification(n)).toMatchObject({
      title: "Run git status",
      subtitle: "Codex 012 · webshop",
      body: "Show working tree status\ngit status",
    });
  });

  test("missing host or project leaves a clean title and subtitle", () => {
    const n: AgentNotification = { ...base, view: "turn.approve.command", command: "ls" };
    expect(collapseAgentNotification({ ...n, host: undefined })).toMatchObject({ title: "Run ls", subtitle: "machiavelli · openscout", body: "ls" });
    expect(collapseAgentNotification({ ...n, project: undefined }).subtitle).toBe("machiavelli · studio");
    expect(collapseAgentNotification({ ...n, host: "  ", project: "  " })).toMatchObject({ subtitle: "machiavelli", body: "ls" });
  });

  test("a command without a description shows the command", () => {
    const n: AgentNotification = { ...base, view: "turn.approve.command", command: "git push origin main" };
    expect(collapseAgentNotification(n)).toMatchObject({ title: "Push · main", headline: "Wants to push", body: "git push origin main" });
  });

  test("a command's title and body stay compact and structured for Watch and lock screen", () => {
    const collapse = (command: string, why?: string) =>
      collapseAgentNotification({ ...base, view: "turn.approve.command", command, ...(why ? { why } : {}) });

    expect(collapse("cd ~/dev/scout && git push -u origin fix/x")).toMatchObject({
      title: "Push · fix/x",
      body: "git push -u origin fix/x",
      headline: "Wants to push",
    });
    expect(collapse("git -C /Users/demo/dev/scout push --force-with-lease origin feat/x")).toMatchObject({
      title: "Force push · feat/x",
      body: "git push --force-with-lease origin feat/x",
      headline: "Wants to push",
    });
    expect(
      collapse(
        `gh pr create --repo owner/scout --title "Add always-allow" --head feat/mobile-always --base main --body-file /tmp/pr-body.md`,
        "Open PR for review",
      ),
    ).toMatchObject({
      title: "Open PR · owner/scout",
      body: "Add always-allow\nfeat/mobile-always → main",
      headline: "Wants to open a pull request",
    });
    expect(collapse("gh pr create --draft --title 'Fix'")).toMatchObject({
      title: "Draft PR · openscout",
      body: "Fix",
      headline: "Wants to open a pull request",
    });
    expect(collapse("gh pr merge 12 --squash --delete-branch")).toMatchObject({
      title: "Merge PR #12 · openscout",
      body: "squash · delete branch",
      headline: "Wants to merge a pull request",
    });
    expect(collapse("GIT_TRACE=1 git commit -m 'Ship watch cards'")).toMatchObject({
      title: "Commit · openscout",
      body: "Ship watch cards",
      headline: "Wants to commit",
    });
    expect(collapse("bun test")).toMatchObject({
      title: "Run bun test",
      body: "bun test",
      headline: "Wants to run a command",
    });
  });

  test("a long command is cut at a word, and its markdown-looking text is kept", () => {
    const long = `git push origin ${"feature/branch-name ".repeat(20)}`;
    const body = collapseAgentNotification({ ...base, view: "turn.approve.command", command: long }).body;
    expect(body.length).toBeLessThanOrEqual(160);
    expect(body.endsWith("…")).toBe(true);
    expect(body.startsWith("git push origin feature/branch-name")).toBe(true);
    const starred = collapseAgentNotification({ ...base, view: "turn.approve.command", command: "rm -rf *_tmp_*" }).body;
    expect(starred).toBe("rm -rf *_tmp_*");
    const multi = collapseAgentNotification({ ...base, view: "turn.approve.command", command: "git add .\ngit push" }).body;
    expect(multi).toBe("git add .; git push");
  });

  test("an edit names the one file it touches and puts summary before files", () => {
    const one: AgentNotification = { ...base, view: "turn.approve.edit", files: [{ path: "src/a.ts", added: 3, removed: 1 }] };
    expect(collapseAgentNotification(one)).toMatchObject({
      title: "Edit a.ts",
      subtitle: "machiavelli · openscout",
      headline: "Wants to edit a.ts",
      body: "src/a.ts (+3 -1)",
    });
    const two: AgentNotification = {
      ...base,
      view: "turn.approve.edit",
      summary: "Rename the client",
      files: [{ path: "a.ts", added: 3, removed: 1 }, { path: "b.ts", added: 2, removed: 0 }],
    };
    expect(collapseAgentNotification(two)).toMatchObject({
      title: "Edit 2 files",
      body: "Rename the client\na.ts (+3 -1), b.ts (+2 -0)",
    });
  });

  test("a choice question puts the question in the body and takes a reply", () => {
    const n: AgentNotification = { ...base, view: "turn.question.choice", question: "Which client?", context: "Both support streaming.", options: ["In-process", "XPC"] };
    const collapsed = collapseAgentNotification(n);
    expect(collapsed.body).toBe("machiavelli · openscout\nWhich client?\nBoth support streaming.");
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
    expect(collapsed.body).toBe("machiavelli · openscout\nReply needed\nShip to staging or prod?");
  });

  test("a declared permission ask says so", () => {
    const n: AgentNotification = { ...base, view: "ask", note: "Write to /etc/hosts?", reply: "required", permission: true };
    expect(collapseAgentNotification(n).body).toBe("machiavelli · openscout\nPermission requested\nWrite to /etc/hosts?");
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
    expect(collapsed.body).toBe("machiavelli · openscout\nInput welcome\nFix how pushes read");
  });

  test("a failure keeps the error and the originating host when the project is missing", () => {
    const n: AgentNotification = {
      ...base,
      sender: { name: "pike" },
      project: undefined,
      level: "passive",
      view: "turn.failed",
      error: "the operation timed out",
    };
    const collapsed = collapseAgentNotification(n);
    expect(collapsed.title).toBe("Scout on studio");
    expect(collapsed.subtitle).toBe("");
    expect(collapsed.threadId).toBe("scout.agent.pike");
    expect(collapsed.body).toBe("pike\nRun failed\nthe operation timed out");
  });

  test("work.done offers the link first only when an artifact has one", () => {
    const withLink: AgentNotification = { ...base, view: "work.done", summary: "Trimmed cache", artifacts: [{ kind: "pr", label: "PR", url: "https://x" }] };
    const without: AgentNotification = { ...base, view: "work.done", summary: "Trimmed cache" };
    expect(agentNotificationActions(withLink)).toEqual(["open_link", "open_chat"]);
    expect(agentNotificationActions(without)).toEqual(["open_chat"]);
    expect(collapseAgentNotification(without)).toMatchObject({ body: "machiavelli · openscout\nWork complete\nTrimmed cache" });
  });

  test("a text update keeps both its title and plain-text detail", () => {
    const n: AgentNotification = { ...base, level: "passive", view: "text", title: "Shared an update", body: "Done with the **pass**." };
    expect(collapseAgentNotification(n)).toMatchObject({ title: "Scout on studio", body: "machiavelli · openscout\nShared an update\nDone with the pass." });
  });

  test("sealing marks only time-sensitive notifications urgent for older phones", () => {
    const ask: AgentNotification = { ...base, level: "time-sensitive", view: "ask", note: "Deploy?" };
    const approval: AgentNotification = { ...base, view: "turn.approve.tool", tool: "Read" };
    expect(sealedAgentNotification(ask)).toMatchObject({ urgent: true, lockScreen: { level: "time-sensitive" } });
    expect(sealedAgentNotification(approval)).toMatchObject({ urgent: false, lockScreen: { level: "active", title: "Allow Read", subtitle: "machiavelli · openscout", body: "" } });
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

test("a tool approval puts its reason before its summary, with a summary fallback", () => {
  const notification: AgentNotification = { ...base, sender: { name: "Claude" }, view: "turn.approve.tool", tool: "EnterWorktree", summary: "target", why: "Creating an isolated workspace." };
  expect(sealedAgentNotification(notification).lockScreen).toMatchObject({
    title: "Allow EnterWorktree", subtitle: "Claude · openscout", body: "Creating an isolated workspace.\ntarget",
  });
  expect(collapseAgentNotification({ ...notification, why: undefined }).body).toBe("target");
  expect((clampAgentNotification({ ...notification, why: "x".repeat(1000) }) as typeof notification).why!.length).toBeLessThanOrEqual(240);
});
