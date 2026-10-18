import { describe, expect, test } from "bun:test";
import {
  buildOrchestrationAskArguments,
  orchestrationRuntimeRouteKey,
  renderOrchestrationAskCommand,
  type OrchestrationRuntimeRoute,
} from "@openscout/protocol";

import {
  parseAskCommandOptions,
  parseCardCreateCommandOptions,
  parseChannelCommandOptions,
  parseDoctorCommandOptions,
  parseInboxCommandOptions,
  parseImplicitAskCommandOptions,
  parseLatestCommandOptions,
  parseSendCommandOptions,
  parseWatchCommandOptions,
} from "./options.ts";

describe("parseDoctorCommandOptions", () => {
  test("accepts context, json, and native repair flags", () => {
    const options = parseDoctorCommandOptions(
      ["--context-root", "/tmp/repo", "--json", "--detail", "--fix", "--yes"],
      "/tmp/workspace",
    );

    expect(options.currentDirectory).toBe("/tmp/repo");
    expect(options.json).toBe(true);
    expect(options.detail).toBe(true);
    expect(options.fix).toBe(true);
    expect(options.yes).toBe(true);
  });

  test("requires --fix before --yes", () => {
    expect(() => parseDoctorCommandOptions(["--yes"], "/tmp/workspace")).toThrow("--yes requires --fix");
  });
});

describe("parseSendCommandOptions", () => {
  test("a plain send is not tracked", () => {
    const options = parseSendCommandOptions(["--to", "hudson", "branch", "pushed"], "/tmp/workspace");
    expect(options.tracked).toBe(false);
    expect(options.message).toBe("branch pushed");
  });

  test("parses --tracked and its flags instead of swallowing them into the body", () => {
    const options = parseSendCommandOptions(
      ["--tracked", "--to", "hudson", "--no-notifs", "run", "the", "sweep"],
      "/tmp/workspace",
    );
    expect(options.tracked).toBe(true);
    expect(options.noNotifs).toBe(true);
    expect(options.wait).toBe(false);
    expect(options.message).toBe("run the sweep");
  });

  test("parses a bounded wait budget", () => {
    const options = parseSendCommandOptions(
      ["--to", "hudson", "--tracked", "--wait", "--timeout", "300", "current", "blocker?"],
      "/tmp/workspace",
    );
    expect(options.wait).toBe(true);
    expect(options.timeoutSeconds).toBe(300);
    expect(options.message).toBe("current blocker?");
  });

  test("tracked-only flags require --tracked", () => {
    expect(() =>
      parseSendCommandOptions(["--to", "hudson", "--no-notifs", "hello"], "/tmp/workspace"),
    ).toThrow(/add --tracked/);
    expect(() =>
      parseSendCommandOptions(["--to", "hudson", "--wait", "hello"], "/tmp/workspace"),
    ).toThrow(/add --tracked/);
  });

  test("rejects --timeout without --wait and non-positive budgets", () => {
    expect(() =>
      parseSendCommandOptions(["--to", "hudson", "--tracked", "--timeout", "300", "hello"], "/tmp/workspace"),
    ).toThrow("--timeout requires --wait");
    expect(() =>
      parseSendCommandOptions(["--to", "hudson", "--tracked", "--wait", "--timeout", "0", "hello"], "/tmp/workspace"),
    ).toThrow("--timeout must be a positive number of seconds");
  });

  test("rejects --no-notifs with --wait", () => {
    expect(() =>
      parseSendCommandOptions(["--to", "hudson", "--tracked", "--wait", "--no-notifs", "hello"], "/tmp/workspace"),
    ).toThrow(/mutually exclusive/);
  });

  test("rejects repeated destinations instead of keeping the last one", () => {
    for (const args of [
      ["--to", "a", "--to", "b", "review"],
      ["--to", "a", "--ref", "7f3a9c21", "review"],
      ["--ref", "7f3a9c21", "--ref", "8e2b1d10", "review"],
    ]) {
      expect(() => parseSendCommandOptions(args, "/tmp/workspace")).toThrow(/exactly one destination/);
    }
  });

  test("accepts a message file as the primary body source", () => {
    const options = parseSendCommandOptions(
      ["--context-root", "/tmp/repo", "--message-file", "status.md"],
      "/tmp/workspace",
    );

    expect(options.message).toBe("");
    expect(options.messageFile).toBe("/tmp/repo/status.md");
    expect(options.currentDirectory).toBe("/tmp/repo");
  });

  test("accepts an explicit target without consuming body mentions", () => {
    const options = parseSendCommandOptions(
      ["--to", "hudson", "literal", "@codex", "stays", "text"],
      "/tmp/workspace",
    );

    expect(options.targetLabel).toBe("hudson");
    expect(options.message).toBe("literal @codex stays text");
  });

  test("accepts a binding ref target", () => {
    const options = parseSendCommandOptions(
      ["--ref", "7f3a9c21", "follow", "up"],
      "/tmp/workspace",
    );

    expect(options.targetLabel).toBe("ref:7f3a9c21");
    expect(options.targetRef).toBe("7f3a9c21");
    expect(options.message).toBe("follow up");
  });

  test("accepts a composer route target", () => {
    const options = parseSendCommandOptions(
      [">>", "hudson", "status", "is", "green"],
      "/tmp/workspace",
    );

    expect(options.targetLabel).toBe("hudson");
    expect(options.message).toBe("status is green");
  });

  test("accepts a composer route target handle", () => {
    const options = parseSendCommandOptions(
      [">>", "⌖mw-talkie", "status", "is", "green"],
      "/tmp/workspace",
    );

    expect(options.targetLabel).toBe("target:mw-talkie");
    expect(options.message).toBe("status is green");
  });

  test("accepts a composer route channel", () => {
    const options = parseSendCommandOptions(
      [">>", "channel:ops", "status", "is", "green"],
      "/tmp/workspace",
    );

    expect(options.channel).toBe("ops");
    expect(options.message).toBe("status is green");
  });

  test("accepts a wake flag for non-blocking visible turns", () => {
    const options = parseSendCommandOptions(
      ["--to", "hudson", "--wake", "please", "continue"],
      "/tmp/workspace",
    );

    expect(options.targetLabel).toBe("hudson");
    expect(options.wake).toBe(true);
    expect(options.message).toBe("please continue");
  });

  test("rejects mixing inline messages with a message file", () => {
    expect(() =>
      parseSendCommandOptions(
        ["--message-file", "status.md", "@hudson", "ready"],
        "/tmp/workspace",
      )).toThrow("provide either an inline message or --message-file/--body-file");
  });
});

describe("parseAskCommandOptions", () => {
  test("--on keeps the project path as typed, for the other machine to resolve", () => {
    const parsed = parseAskCommandOptions(
      ["--on", "archie", "--project", "~/renders/arsenal-x", "--runtime", "codex/gpt-6-astra/high", "build the arsenal"],
      "/Users/art/dev/openscout",
    );
    expect(parsed).toEqual(expect.objectContaining({
      onHost: "archie",
      projectPath: "~/renders/arsenal-x",
      harness: "codex",
      model: "gpt-6-astra",
      reasoningEffort: "high",
      session: "new",
      message: "build the arsenal",
    }));
  });

  test("--host is the same flag as --on", () => {
    expect(parseAskCommandOptions(["--host=archie", "--project", "/srv/x", "go"], "/tmp").onHost).toBe("archie");
  });

  test("--on without --project says what is missing", () => {
    expect(() => parseAskCommandOptions(["--on", "archie", "go"], "/tmp"))
      .toThrow("--on archie needs --project <path on archie>");
  });

  test("--on does not combine with an existing target", () => {
    expect(() => parseAskCommandOptions(["--on", "archie", "--project", "/srv/x", "--to", "@talkie", "go"], "/tmp"))
      .toThrow("drop --to/--ref/--profile");
  });

  test("round-trips orchestration advisor routes through supported ask flags", () => {
    const routes: OrchestrationRuntimeRoute[] = [
      {
        providerId: "claude",
        harness: "claude",
        model: "claude-fable-5",
        effort: "max",
        profile: "Fable",
      },
      {
        providerId: "codex",
        harness: "codex",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        profile: null,
      },
      {
        providerId: "opencode",
        harness: "opencode",
        model: "opencode-go/glm-5.2",
        effort: null,
        profile: "OpenCode",
      },
    ];

    const parsed = routes.map((route) => parseAskCommandOptions(
      buildOrchestrationAskArguments(route, "review this"),
      "/tmp/openscout",
    ));

    expect(parsed[0]).toEqual(expect.objectContaining({
      runtimeProfile: "fable",
      reasoningEffort: "max",
      message: "review this",
    }));
    expect(parsed[1]).toEqual(expect.objectContaining({
      harness: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      message: "review this",
    }));
    expect(parsed[2]).toEqual(expect.objectContaining({
      harness: "opencode",
      model: "opencode-go/glm-5.2",
      message: "review this",
    }));
    expect(renderOrchestrationAskCommand(routes[0]!)).toBe(
      "scout ask --profile Fable --effort max '<request>'",
    );
    expect(renderOrchestrationAskCommand(routes[2]!)).toBe(
      "scout ask --harness opencode --model opencode-go/glm-5.2 '<request>'",
    );
    expect(new Set(routes.map(orchestrationRuntimeRouteKey)).size).toBe(routes.length);
    const openCodeVariants = ["glm-5.2", "minimax-m3", "deepseek-v4-pro"].map((model) => ({
      providerId: "opencode",
      harness: "opencode",
      model: `opencode-go/${model}`,
      effort: null,
      profile: "OpenCode",
    } satisfies OrchestrationRuntimeRoute));
    expect(new Set(openCodeVariants.map(orchestrationRuntimeRouteKey)).size).toBe(3);
  });

  test("keeps direct --to routing as an existing target even for a reserved profile name", () => {
    const options = parseAskCommandOptions(
      ["--to", "Fable", "review", "this"],
      "/tmp/workspace",
    );

    expect(options.targetLabel).toBe("Fable");
    expect(options.runtimeProfile).toBeUndefined();
    expect(options.message).toBe("review this");
  });

  test("parses reserved bare profile names as fresh current-project routes", () => {
    const fable = parseAskCommandOptions(
      ["Fable", "to", "review", "this"],
      "/tmp/workspace",
    );
    const opus = parseAskCommandOptions(
      ["Opus", "with", "HIGH", "effort", "to", "fix", "the", "tests"],
      "/tmp/workspace",
    );

    expect(fable.runtimeProfile).toBe("fable");
    expect(fable.projectPath).toBeUndefined();
    expect(fable.session).toBeUndefined();
    expect(fable.message).toBe("review this");
    expect(opus.runtimeProfile).toBe("opus");
    expect(opus.reasoningEffort).toBe("high");
    expect(opus.message).toBe("fix the tests");
  });

  test("preserves explicit effort flags on bare runtime profiles", () => {
    const effort = parseAskCommandOptions(
      ["--effort", "high", "Opus", "to", "review", "this"],
      "/tmp/workspace",
    );
    const reasoningEffort = parseAskCommandOptions(
      ["--reasoning-effort=xhigh", "Fable", "to", "review", "this"],
      "/tmp/workspace",
    );

    expect(effort.runtimeProfile).toBe("opus");
    expect(effort.reasoningEffort).toBe("high");
    expect(reasoningEffort.runtimeProfile).toBe("fable");
    expect(reasoningEffort.reasoningEffort).toBe("xhigh");
  });

  test("rejects conflicting flag and natural-language efforts", () => {
    expect(() =>
      parseAskCommandOptions(
        ["--effort", "high", "Opus", "with", "xhigh", "effort", "to", "review", "this"],
        "/tmp/workspace",
      )).toThrow("conflicting runtime profile efforts");
  });

  test("parses explicit profile routes without overloading --to", () => {
    const options = parseAskCommandOptions(
      ["--profile", "Opus", "--effort", "medium", "review", "this"],
      "/tmp/workspace",
    );

    expect(options.runtimeProfile).toBe("opus");
    expect(options.reasoningEffort).toBe("medium");
    expect(options.targetLabel).toBeUndefined();
    expect(options.message).toBe("review this");
  });

  test("rejects effort for ACP runtime profiles", () => {
    expect(() =>
      parseAskCommandOptions(
        ["--profile", "Kimi", "--effort", "medium", "review", "this"],
        "/tmp/workspace",
      )).toThrow("kimi runtime profile does not support reasoning effort through its ACP transport");
  });

  test("carries effort for Grok, which sets it over ACP", () => {
    const options = parseAskCommandOptions(
      ["Grok", "with", "high", "effort", "to", "review", "this"],
      "/tmp/workspace",
    );

    expect(options.runtimeProfile).toBe("grok");
    expect(options.reasoningEffort).toBe("high");
  });

  test("normalizes the agent prefix to an exact existing handle", () => {
    const options = parseAskCommandOptions(
      ["agent", "Composer", "Review!", "to", "fix", "the", "tests"],
      "/tmp/workspace",
    );

    expect(options.existingTargetHandle).toBe("composer-review");
    expect(options.targetLabel).toBeUndefined();
    expect(options.message).toBe("fix the tests");
  });

  test("allows prompt files to supply natural profile and existing-handle bodies", () => {
    const profile = parseAskCommandOptions(
      ["Fable", "--prompt-file=review.md"],
      "/tmp/workspace",
    );
    const agent = parseAskCommandOptions(
      ["agent", "Composer", "Review", "to", "--prompt-file=fix.md"],
      "/tmp/workspace",
    );

    expect(profile.runtimeProfile).toBe("fable");
    expect(profile.message).toBe("");
    expect(profile.promptFile).toBe("/tmp/workspace/review.md");
    expect(agent.existingTargetHandle).toBe("composer-review");
    expect(agent.message).toBe("");
    expect(agent.promptFile).toBe("/tmp/workspace/fix.md");
  });

  test("accepts a prompt file as the primary body source", () => {
    const options = parseAskCommandOptions(
      ["--to", "hudson", "--prompt-file=handoff.md"],
      "/tmp/workspace",
    );

    expect(options.targetLabel).toBe("hudson");
    expect(options.message).toBe("");
    expect(options.promptFile).toBe("/tmp/workspace/handoff.md");
  });

  test("accepts --body-file as a prompt file alias", () => {
    const options = parseAskCommandOptions(
      ["--to", "hudson", "--body-file", "/tmp/handoff.md"],
      "/tmp/workspace",
    );

    expect(options.promptFile).toBe("/tmp/handoff.md");
  });

  test("accepts a binding ref target", () => {
    const options = parseAskCommandOptions(
      ["--ref=7f3a9c21", "continue"],
      "/tmp/workspace",
    );

    expect(options.targetLabel).toBe("ref:7f3a9c21");
    expect(options.targetRef).toBe("7f3a9c21");
    expect(options.message).toBe("continue");
  });

  test("accepts a composer route target", () => {
    const options = parseAskCommandOptions(
      [">>", "hudson", "review", "the", "parser"],
      "/tmp/workspace",
    );

    expect(options.targetLabel).toBe("hudson");
    expect(options.message).toBe("review the parser");
  });

  test("preserves harness-qualified session composer route targets", () => {
    const options = parseAskCommandOptions(
      [">>", "session:codex:native-thread-123", "continue", "there"],
      "/tmp/workspace",
    );

    expect(options.targetLabel).toBe("session:codex:native-thread-123");
    expect(options.message).toBe("continue there");
  });

  test("accepts an explicit project path target", () => {
    const options = parseAskCommandOptions(
      ["--project", "../talkie", "compare", "auth"],
      "/tmp/workspace",
    );

    expect(options.projectPath).toBe("/tmp/talkie");
    expect(options.targetLabel).toBeUndefined();
    expect(options.message).toBe("compare auth");
  });

  test("infers the current project when only a harness is provided", () => {
    const options = parseAskCommandOptions(
      ["--harness", "codex", "review", "this"],
      "/tmp/workspace",
    );

    expect(options.projectPath).toBe("/tmp/workspace");
    expect(options.targetLabel).toBeUndefined();
    expect(options.harness).toBe("codex");
    expect(options.session).toBe("new");
    expect(options.message).toBe("review this");
  });

  test("parses foreground session placement independently from reply mode", () => {
    const options = parseAskCommandOptions(
      ["--harness", "codex", "--foreground", "--notify", "review", "this"],
      "/tmp/workspace",
    );

    expect(options.placement).toBe("foreground");
    expect(options.replyMode).toBe("notify");
    expect(options.session).toBe("new");
  });

  test("parses attached placement for the running Codex app-server", () => {
    const options = parseAskCommandOptions(
      ["--harness", "codex", "--placement", "attached", "review"],
      "/tmp/workspace",
    );
    expect(options.placement).toBe("attached");
    expect(() => parseAskCommandOptions(
      ["--harness", "codex", "--foreground", "--placement", "attached", "review"],
      "/tmp/workspace",
    )).toThrow("conflicting placement");
  });

  test("rejects invalid and conflicting session placement", () => {
    expect(() => parseAskCommandOptions(
      ["--harness", "codex", "--placement", "visible", "review"],
      "/tmp/workspace",
    )).toThrow("invalid placement: visible");
    expect(() => parseAskCommandOptions(
      ["--harness", "codex", "--foreground", "--placement", "background", "review"],
      "/tmp/workspace",
    )).toThrow("conflicting placement");
  });

  test("parses exact runtime flags and a shell-safe RuntimeSpec", () => {
    const flags = parseAskCommandOptions(
      ["--project", "../talkie", "--harness", "codex", "--model", "gpt-5.6-sol", "--effort", "xhigh", "review"],
      "/tmp/openscout",
    );
    expect(flags).toEqual(expect.objectContaining({
      projectPath: "/tmp/talkie",
      harness: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      session: "new",
    }));

    const literal = parseAskCommandOptions(
      ["codex/gpt-5.6-sol/xhigh", "to", "review", "the", "diff"],
      "/tmp/openscout",
    );
    expect(literal).toEqual(expect.objectContaining({
      projectPath: "/tmp/openscout",
      runtimeLiteral: "codex/gpt-5.6-sol/xhigh",
      harness: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      message: "review the diff",
      session: "new",
    }));
  });

  test("uses profiles as presets and fails conflicting RuntimeSpec flags closed", () => {
    expect(parseAskCommandOptions(
      ["--profile", "fable", "--model", "claude-opus-5", "--effort", "max", "review"],
      "/tmp/openscout",
    )).toEqual(expect.objectContaining({
      runtimeProfile: "fable",
      model: "claude-opus-5",
      reasoningEffort: "max",
    }));
    expect(() => parseAskCommandOptions(
      ["--runtime", "codex/gpt-5.6-sol/xhigh", "--model", "gpt-5.6-terra", "review"],
      "/tmp/openscout",
    )).toThrow("conflicting runtime model");
  });

  test("narrows profile and natural RuntimeSpec launches to an explicit project", () => {
    expect(parseAskCommandOptions(
      ["--project", "../talkie", "--profile", "fable", "review"],
      "/tmp/openscout",
    )).toEqual(expect.objectContaining({
      projectPath: "/tmp/talkie",
      runtimeProfile: "fable",
      message: "review",
    }));
    expect(parseAskCommandOptions(
      ["--project", "../talkie", "codex/gpt-5.6-sol/xhigh", "to", "review"],
      "/tmp/openscout",
    )).toEqual(expect.objectContaining({
      projectPath: "/tmp/talkie",
      runtimeLiteral: "codex/gpt-5.6-sol/xhigh",
      harness: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
    }));
  });

  test("parses ask session preference flags", () => {
    const options = parseAskCommandOptions(
      ["--new", "--harness", "codex", "review", "this"],
      "/tmp/workspace",
    );

    expect(options.projectPath).toBe("/tmp/workspace");
    expect(options.session).toBe("new");
  });

  test("does not expose reuse as a CLI ask session preference", () => {
    expect(() =>
      parseAskCommandOptions(
        ["--session", "reuse", "--harness", "codex", "review", "this"],
        "/tmp/workspace",
      )).toThrow("invalid session: reuse");
  });

  test("accepts a composer project path target", () => {
    const options = parseAskCommandOptions(
      [">>", "project:../talkie", "compare", "auth"],
      "/tmp/workspace",
    );

    expect(options.projectPath).toBe("/tmp/talkie");
    expect(options.targetLabel).toBeUndefined();
    expect(options.message).toBe("compare auth");
  });

  test("rejects mixing agent and project path targets", () => {
    expect(() =>
      parseAskCommandOptions(
        ["--to", "hudson", "--project", "../talkie", "review"],
        "/tmp/workspace",
      )).toThrow("provide either --to/--ref or --project, not both");
  });

  test("accepts repeated labels", () => {
    const options = parseAskCommandOptions(
      ["--to", "hudson", "--label", "release:0.2.66", "--labels=goal:hook,release:0.2.66", "review"],
      "/tmp/workspace",
    );

    expect(options.labels).toEqual(["release:0.2.66", "goal:hook"]);
  });

  test("rejects mixing inline questions with a prompt file", () => {
    expect(() =>
      parseAskCommandOptions(
        ["--to", "hudson", "--prompt-file", "handoff.md", "review", "this"],
        "/tmp/workspace",
      )).toThrow("provide either an inline question or --prompt-file/--body-file");
  });
});

describe("parseImplicitAskCommandOptions", () => {
  test("recognizes reserved profiles and exact agent-prefix targets", () => {
    const opus = parseImplicitAskCommandOptions(
      ["Opus", "xhigh", "to", "review", "this"],
      "/tmp/workspace",
    );
    const agent = parseImplicitAskCommandOptions(
      ["agent", "Composer", "Review", "to", "fix", "the", "tests"],
      "/tmp/workspace",
    );

    expect(opus.runtimeProfile).toBe("opus");
    expect(opus.reasoningEffort).toBe("xhigh");
    expect(opus.message).toBe("review this");
    expect(agent.existingTargetHandle).toBe("composer-review");
    expect(agent.message).toBe("fix the tests");
  });

  test("allows prompt files to supply implicit natural target bodies", () => {
    const profile = parseImplicitAskCommandOptions(
      ["Opus", "--prompt-file=review.md"],
      "/tmp/workspace",
    );
    const agent = parseImplicitAskCommandOptions(
      ["agent", "Composer", "Review", "to", "--prompt-file=fix.md"],
      "/tmp/workspace",
    );

    expect(profile.runtimeProfile).toBe("opus");
    expect(profile.message).toBe("");
    expect(profile.promptFile).toBe("/tmp/workspace/review.md");
    expect(agent.existingTargetHandle).toBe("composer-review");
    expect(agent.message).toBe("");
    expect(agent.promptFile).toBe("/tmp/workspace/fix.md");
  });

  test("preserves flag effort for implicit bare profiles and rejects conflicts", () => {
    const options = parseImplicitAskCommandOptions(
      ["--effort", "high", "Opus", "to", "review", "this"],
      "/tmp/workspace",
    );

    expect(options.runtimeProfile).toBe("opus");
    expect(options.reasoningEffort).toBe("high");
    expect(() =>
      parseImplicitAskCommandOptions(
        ["--reasoning-effort=medium", "Fable", "xhigh", "to", "review", "this"],
        "/tmp/workspace",
      )).toThrow("conflicting runtime profile efforts");
  });

  test("rejects effort for implicit ACP runtime profiles", () => {
    expect(() =>
      parseImplicitAskCommandOptions(
        ["--effort", "high", "Kimi", "to", "review", "this"],
        "/tmp/workspace",
      )).toThrow("kimi runtime profile does not support reasoning effort through its ACP transport");
  });

  test("carries effort for an implicit Grok profile", () => {
    const options = parseImplicitAskCommandOptions(
      ["--effort", "high", "Grok", "to", "review", "this"],
      "/tmp/workspace",
    );

    expect(options.runtimeProfile).toBe("grok");
    expect(options.reasoningEffort).toBe("high");
  });

  test("extracts a target agent from natural language input", () => {
    const options = parseImplicitAskCommandOptions(
      ["hey", "@dewey", "can", "you", "review", "our", "docs?"],
      "/tmp/workspace",
    );

    expect(options.agentName).toBeNull();
    expect(options.targetLabel).toBe("dewey");
    expect(options.message).toBe("hey can you review our docs?");
    expect(options.currentDirectory).toBe("/tmp/workspace");
  });

  test("extracts shorthand harness and model target labels", () => {
    const options = parseImplicitAskCommandOptions(
      ["hey", "@lattices#codex?5.5", "can", "you", "review", "this?"],
      "/tmp/workspace",
    );

    expect(options.targetLabel).toBe("lattices#codex?5.5");
    expect(options.message).toBe("hey can you review this?");
  });

  test("parses ask flags before the freeform request", () => {
    const options = parseImplicitAskCommandOptions(
      ["--as", "vox", "--timeout", "900", "--label", "goal:ios-shell", "--context-root", "/tmp/repo", "@talkie", "take", "another", "pass"],
      "/tmp/workspace",
    );

    expect(options.agentName).toBe("vox");
    expect(options.timeoutSeconds).toBe(900);
    expect(options.labels).toEqual(["goal:ios-shell"]);
    expect(options.targetLabel).toBe("talkie");
    expect(options.message).toBe("take another pass");
    expect(options.currentDirectory).toBe("/tmp/repo");
  });

  test("parses non-blocking ask reply modes", () => {
    const notify = parseImplicitAskCommandOptions(
      ["--notify", "@talkie", "take", "another", "pass"],
      "/tmp/workspace",
    );
    const noWait = parseImplicitAskCommandOptions(
      ["--no-wait", "@talkie", "start", "the", "longer", "run"],
      "/tmp/workspace",
    );

    expect(notify.replyMode).toBe("notify");
    expect(noWait.replyMode).toBe("none");
  });

  test("infers the current project for implicit harness-only asks", () => {
    const options = parseImplicitAskCommandOptions(
      ["--harness", "codex", "review", "this"],
      "/tmp/workspace",
    );

    expect(options.projectPath).toBe("/tmp/workspace");
    expect(options.targetLabel).toBeUndefined();
    expect(options.harness).toBe("codex");
    expect(options.session).toBe("new");
    expect(options.message).toBe("review this");
  });

  test("parses exact runtime controls in implicit ask mode", () => {
    expect(parseImplicitAskCommandOptions(
      ["--runtime", "codex/gpt-5.6-sol/xhigh", "review", "the", "diff"],
      "/tmp/openscout",
    )).toEqual(expect.objectContaining({
      projectPath: "/tmp/openscout",
      runtimeLiteral: "codex/gpt-5.6-sol/xhigh",
      harness: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      session: "new",
    }));
  });

  test("extracts a target agent from the composer route operator", () => {
    const options = parseImplicitAskCommandOptions(
      ["hey", ">>", "dewey", "can", "you", "review", "our", "docs?"],
      "/tmp/workspace",
    );

    expect(options.targetLabel).toBe("dewey");
    expect(options.message).toBe("hey can you review our docs?");
  });

  test("extracts a target handle from the composer route operator", () => {
    const options = parseImplicitAskCommandOptions(
      ["please", ">>", "⌖mw-talkie", "continue", "there"],
      "/tmp/workspace",
    );

    expect(options.targetLabel).toBe("target:mw-talkie");
    expect(options.message).toBe("please continue there");
  });

  test("preserves harness-qualified session targets in implicit route operators", () => {
    const options = parseImplicitAskCommandOptions(
      ["please", ">>", "session:codex:native-thread-123", "continue", "there"],
      "/tmp/workspace",
    );

    expect(options.targetLabel).toBe("session:codex:native-thread-123");
    expect(options.message).toBe("please continue there");
  });

  test("accepts a prompt file with only a composer route target", () => {
    const options = parseImplicitAskCommandOptions(
      [">>", "talkie", "--prompt-file", "handoff.md"],
      "/tmp/workspace",
    );

    expect(options.targetLabel).toBe("talkie");
    expect(options.message).toBe("");
    expect(options.promptFile).toBe("/tmp/workspace/handoff.md");
  });

  test("accepts a prompt file with only an @agent mention", () => {
    const options = parseImplicitAskCommandOptions(
      ["@talkie", "--prompt-file", "handoff.md"],
      "/tmp/workspace",
    );

    expect(options.targetLabel).toBe("talkie");
    expect(options.message).toBe("");
    expect(options.promptFile).toBe("/tmp/workspace/handoff.md");
  });

  test("rejects natural language input without a mention", () => {
    expect(() =>
      parseImplicitAskCommandOptions(
        ["please", "review", "the", "docs"],
        "/tmp/workspace",
      )).toThrow("implicit ask requires >> target or an @agent mention");
  });

  test("rejects natural language input with multiple mentions", () => {
    expect(() =>
      parseImplicitAskCommandOptions(
        ["@dewey", "check", "with", "@hudson", "about", "this"],
        "/tmp/workspace",
      )).toThrow("implicit ask supports exactly one @agent mention");
  });
});

describe("parseLatestCommandOptions", () => {
  test("accepts a channel filter and message mode", () => {
    const options = parseLatestCommandOptions(
      ["--channel", "homepage-polish", "--messages", "--limit", "1"],
      "/tmp/workspace",
    );

    expect(options.channel).toBe("homepage-polish");
    expect(options.messages).toBe(true);
    expect(options.limit).toBe(1);
  });

  test("rejects channel and conversation together", () => {
    expect(() =>
      parseLatestCommandOptions(
        ["--channel", "ops", "--conversation", "channel.ops"],
        "/tmp/workspace",
      )).toThrow("provide either --channel or --conversation, not both");
  });
});

describe("parseWatchCommandOptions", () => {
  test("accepts channel backlog flags", () => {
    const before = Date.now();
    const options = parseWatchCommandOptions(
      ["--channel", "homepage-polish", "--since", "1h", "--limit", "20", "--once"],
      "/tmp/workspace",
    );

    expect(options.channel).toBe("homepage-polish");
    expect(options.limit).toBe(20);
    expect(options.once).toBe(true);
    expect(options.since ?? 0).toBeGreaterThanOrEqual(before - 3_600_000 - 1_000);
    expect(options.since ?? 0).toBeLessThanOrEqual(Date.now() - 3_600_000 + 1_000);
  });

  test("accepts conversation backlog flags", () => {
    const options = parseWatchCommandOptions(
      ["--conversation", "dm.operator.hudson", "--since", "1700000000", "--limit", "20", "--once"],
      "/tmp/workspace",
    );

    expect(options.conversationId).toBe("dm.operator.hudson");
    expect(options.limit).toBe(20);
    expect(options.once).toBe(true);
    expect(options.since).toBe(1_700_000_000_000);
  });

  test("rejects channel and conversation together", () => {
    expect(() =>
      parseWatchCommandOptions(
        ["--channel", "ops", "--conversation", "dm.operator.hudson"],
        "/tmp/workspace",
      )).toThrow("provide either --channel or --conversation, not both");
  });
});

describe("parseInboxCommandOptions", () => {
  test("accepts inferred identity inbox flags", () => {
    const before = Date.now();
    const options = parseInboxCommandOptions(
      ["--latest", "5", "--since", "30m"],
      "/tmp/workspace",
    );

    expect(options.agentName).toBeNull();
    expect(options.latest).toBe(5);
    expect(options.since ?? 0).toBeGreaterThanOrEqual(before - 1_800_000 - 1_000);
    expect(options.since ?? 0).toBeLessThanOrEqual(Date.now() - 1_800_000 + 1_000);
  });

  test("accepts an explicit inbox identity", () => {
    const options = parseInboxCommandOptions(
      ["--as", "hudson-site.main.mini", "--limit", "3"],
      "/tmp/workspace",
    );

    expect(options.agentName).toBe("hudson-site.main.mini");
    expect(options.latest).toBe(3);
  });
});

describe("parseChannelCommandOptions", () => {
  test("accepts latest messages for the default channel", () => {
    const options = parseChannelCommandOptions(
      ["--latest", "10"],
      "/tmp/workspace",
    );

    expect(options.latest).toBe(10);
    expect(options.channel).toBeUndefined();
    expect(options.markRead).toBe(false);
  });

  test("accepts a positional channel for latest messages", () => {
    const options = parseChannelCommandOptions(
      ["homepage-polish", "--latest=3"],
      "/tmp/workspace",
    );

    expect(options.channel).toBe("homepage-polish");
    expect(options.latest).toBe(3);
    expect(options.markRead).toBe(false);
  });

  test("accepts a positional channel for mark-read mode", () => {
    const options = parseChannelCommandOptions(
      ["triage", "--mark-read"],
      "/tmp/workspace",
    );

    expect(options.channel).toBe("triage");
    expect(options.latest).toBeUndefined();
    expect(options.markRead).toBe(true);
  });

  test("accepts clear as a mark-read alias", () => {
    const options = parseChannelCommandOptions(
      ["shared", "--clear"],
      "/tmp/workspace",
    );

    expect(options.channel).toBe("shared");
    expect(options.markRead).toBe(true);
  });

  test("rejects latest and mark-read together", () => {
    expect(() =>
      parseChannelCommandOptions(
        ["triage", "--latest=3", "--mark-read"],
        "/tmp/workspace",
      )).toThrow("provide either --latest or --mark-read, not both");
  });

  test("rejects a channel name without latest mode", () => {
    expect(() =>
      parseChannelCommandOptions(
        ["homepage-polish"],
        "/tmp/workspace",
      )).toThrow("channel name is only valid with --latest or --mark-read");
  });
});

describe("parseCardCreateCommandOptions", () => {
  test("accepts an explicit model override", () => {
    const options = parseCardCreateCommandOptions(
      ["--name", "shellfix", "--harness", "pi", "--provider", "minimax", "--model", "MiniMax-M3", "--reasoning-effort", "xhigh", "/tmp/worktree"],
      "/tmp/workspace",
    );

    expect(options.agentName).toBe("shellfix");
    expect(options.harness).toBe("pi");
    expect(options.provider).toBe("minimax");
    expect(options.model).toBe("MiniMax-M3");
    expect(options.reasoningEffort).toBe("xhigh");
    expect(options.projectPath).toBe("/tmp/worktree");
  });
});


test("CLI preserves a newly published model and effort without bundled-model legality checks", () => {
  const literal = parseAskCommandOptions(["--runtime", "codex/gpt-published-next/ultra", "review"], "/repo");
  expect(literal).toMatchObject({ harness: "codex", model: "gpt-published-next", reasoningEffort: "ultra", message: "review", session: "new" });
  const natural = parseAskCommandOptions(["codex/gpt-published-next/max", "to", "review"], "/repo");
  expect(natural).toMatchObject({ harness: "codex", model: "gpt-published-next", reasoningEffort: "max", message: "review", session: "new" });
});


describe("explicit completion ask options", () => {
  test("keeps completion and join identity separate from the body", () => {
    expect(parseAskCommandOptions([
      "--to", "id:reviewer", "--completion", "explicit", "--join-to", "flight-parent",
      "--request-id", "child-command", "--notify", "Review this",
    ], "/tmp")).toMatchObject({
      completion: { mode: "explicit" }, relation: { kind: "joined", parentFlightId: "flight-parent" },
      requestId: "child-command", targetLabel: "id:reviewer", message: "Review this",
    });
    expect(parseAskCommandOptions(["--to", "session:worker", "--continue-for=parent", "Continue"], "/tmp"))
      .toMatchObject({ relation: { kind: "continuation", parentFlightId: "parent" }, message: "Continue" });
  });

  test("rejects unsupported modes and ambiguous parent relations", () => {
    expect(() => parseAskCommandOptions(["--completion", "automatic", "hi"], "/tmp")).toThrow("must be explicit");
    expect(() => parseAskCommandOptions(["--join-to", "one", "--continue-for", "two", "hi"], "/tmp"))
      .toThrow("mutually exclusive");
    expect(() => parseAskCommandOptions(["--join-to=", "hi"], "/tmp")).toThrow();
  });
});
