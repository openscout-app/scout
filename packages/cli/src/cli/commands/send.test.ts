import { describe, expect, test } from "bun:test";

import {
  classifySendInteraction,
  formatScoutSendRoutingError,
  renderSendCommandHelp,
  renderTrackedSendReceipt,
} from "./send.ts";

describe("renderSendCommandHelp", () => {
  test("documents tell semantics and closed routing choices", () => {
    const help = renderSendCommandHelp();

    expect(help).toContain("Tell or update another agent or an explicit channel.");
    expect(help).toContain("--to <agent>");
    expect(help).toContain("body @mentions stay text");
    expect(help).toContain("one explicit @agent + no channel   -> DM");
    expect(help).toContain("multiple targets + no channel      -> error");
    expect(help).toContain("Use `scout ask` when the meaning is \"do this and get back to me.\"");
    expect(help).toContain("When in doubt, use ask.");
    expect(help).toContain("`scout ask` returns on acceptance");
    expect(help).toContain("--message-file <path>");
  });

  test("keeps FYI as the default and documents tracked work as opt-in", () => {
    const help = renderSendCommandHelp();

    expect(help).toContain("Tracked (opt-in):");
    expect(help).toContain("--tracked");
    expect(help).toContain("same as `scout ask`");
    expect(help).toContain("--tracked on them fails closed.");
    expect(help).toContain("`scout tell` is the explicit FYI spelling of a plain send");
  });
});

describe("classifySendInteraction", () => {
  test("directed sends are eligible for tracked work", () => {
    expect(classifySendInteraction({ targetLabel: "hudson", body: "review the parser" })).toBe("work");
    expect(classifySendInteraction({ targetLabel: "session:abc123", body: "continue" })).toBe("work");
    expect(classifySendInteraction({ targetLabel: "alias:review", body: "take another pass" })).toBe("work");
  });

  test("refs are replies, never new work", () => {
    expect(classifySendInteraction({
      targetLabel: "ref:7f3a9c21",
      targetRef: "7f3a9c21",
      body: "here is the answer",
    })).toBe("message");
  });

  test("channels and broadcast are message-only", () => {
    expect(classifySendInteraction({ targetLabel: "hudson", channel: "triage", body: "x" })).toBe("message");
    expect(classifySendInteraction({ targetLabel: "channel:triage", body: "x" })).toBe("message");
    expect(classifySendInteraction({ targetLabel: "broadcast", body: "x" })).toBe("message");
  });

  test("a legacy [ask:...] completion body is a reply, never new work", () => {
    expect(classifySendInteraction({
      targetLabel: "hudson",
      body: "[ask:flt-abc123] the review found two issues",
    })).toBe("message");
  });

  test("a missing target stays message-only (body mentions never create work)", () => {
    expect(classifySendInteraction({ body: "@hudson build passed" })).toBe("message");
  });
});

describe("renderTrackedSendReceipt", () => {
  const receipt = {
    ok: true,
    state: "queued" as const,
    ids: {
      targetAgentId: "hudson",
      invocationId: "inv-1",
      flightId: "flt-1",
      conversationId: "dm.hudson.me",
      bindingRef: "7f3a9c21",
    },
  };

  test("reports handles and the completion callback honestly", () => {
    const rendered = renderTrackedSendReceipt({ senderId: "me", receipt, replyMode: "notify", flight: null });
    expect(rendered).toContain("tracked send to hudson");
    expect(rendered).toContain("flight flt-1");
    expect(rendered).toContain("invocation inv-1");
    expect(rendered).toContain("DM dm.hudson.me");
    expect(rendered).toContain("ref:7f3a9c21");
    expect(rendered).toContain("Completion will be reported back to me");
    expect(rendered).toContain("not proof of receipt");
    expect(rendered).toContain("scout wait inv-1");
  });

  test("keeps the tracked result visible when notifications are suppressed", () => {
    const rendered = renderTrackedSendReceipt({ senderId: "me", receipt, replyMode: "none", flight: null });
    expect(rendered).toContain("Completion notifications suppressed");
    expect(rendered).toContain("scout wait inv-1");
  });

  test("reports the dispatch state separately from creation", () => {
    const rendered = renderTrackedSendReceipt({
      senderId: "me",
      receipt,
      replyMode: "notify",
      flight: { id: "flt-1", invocationId: "inv-1", requesterId: "me", targetAgentId: "hudson", state: "waking" },
    });
    expect(rendered).toContain("Dispatch state: waking.");
  });
});

describe("formatScoutSendRoutingError", () => {
  test("says plainly when there is no such target", () => {
    expect(formatScoutSendRoutingError({
      unresolvedTargets: ["@mars"],
      targetDiagnostic: {
        agentId: "@mars",
        state: "unknown",
        registrationKind: null,
        projectRoot: null,
      },
    })).toBe("there is no @mars; nothing was sent.");
  });

  test("does not decorate unresolved refs as agent handles", () => {
    expect(formatScoutSendRoutingError({
      unresolvedTargets: ["ref:msg-missing"],
      targetDiagnostic: {
        agentId: "ref:msg-missing",
        state: "unknown",
        registrationKind: null,
        projectRoot: null,
      },
    })).toBe("there is no ref:msg-missing; nothing was sent.");
  });

  test("lists candidates when a short handle is ambiguous", () => {
    const message = formatScoutSendRoutingError({
      unresolvedTargets: ["@vox"],
      targetDiagnostic: {
        state: "ambiguous",
        candidates: [
          { agentId: "vox.mini.codex", label: "@vox.harness:codex" },
          { agentId: "vox.mini.claude", label: "@vox.harness:claude" },
        ],
      },
    });

    expect(message).toContain("target @vox matches multiple agents");
    expect(message).toContain("@vox.harness:codex");
    expect(message).toContain("@vox.harness:claude");
    expect(message).toContain("scout send");
  });

  test("preserves harness-qualified recovery for a native session collision", () => {
    expect(formatScoutSendRoutingError({
      unresolvedTargets: ["session:native-shared"],
      targetDiagnostic: {
        state: "ambiguous",
        candidates: [],
        detail: "session:native-shared exists in multiple harnesses (claude, codex); use session:<harness>:native-shared",
      },
    })).toBe(
      "session:native-shared exists in multiple harnesses (claude, codex); use session:<harness>:native-shared Nothing was sent.",
    );
  });
});
