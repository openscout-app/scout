import { describe, expect, test } from "bun:test";

import { formatScoutAskRoutingError, renderAskCommandHelp, renderScoutAskReceipt } from "./ask.ts";

describe("renderAskCommandHelp", () => {
  test("documents owned-work semantics and DM default routing", () => {
    const help = renderAskCommandHelp();

    expect(help).toContain("Ask one agent to do work or return a concrete answer.");
    expect(help).toContain("one target + no channel            -> DM");
    expect(help).toContain("If the meaning is \"do this and get back to me,\" use ask. When in doubt, use ask.");
    expect(help).toContain("Do not use send merely to avoid blocking");
    expect(help).toContain("--notify                          -> asynchronous ask");
    expect(help).toContain("--prompt-file <path>");
    expect(help).toContain("--reply-mode notify");
    expect(help).toContain("--label <label>");
    expect(help).toContain("--completion explicit");
    expect(help).toContain("--join-to <parent-flight-id>");
    expect(help).toContain("--continue-for <parent-flight-id>");
    expect(help).toContain("An early final is rejected and is not saved for later.");
    expect(help).toContain("--project <path>                   -> ask by repo/workspace path");
    expect(help).toContain("--harness <runtime> with no target");
    expect(help).toContain("scout ask --harness codex");
    expect(help).toContain("Use --project when you know the project path but do not want to look up or pin an agent id first.");
    expect(help).toContain("scout ask '>> project:../talkie compare auth against this branch'");
  });
});

describe("formatScoutAskRoutingError", () => {
  test("explains discovered targets with an explicit startup command", () => {
    expect(formatScoutAskRoutingError(
      {
        targetDiagnostic: {
          agentId: "talkie.arachs-mac-mini-local.master",
          state: "discovered",
          registrationKind: "discovered",
          projectRoot: "/tmp/dev/talkie",
        },
      },
      "talkie",
    )).toBe(
      'target @talkie is discovered but not online yet; nothing was sent. Start it with `scout up "/tmp/dev/talkie"` or wait for it to come online.',
    );
  });

  test("falls back to a generic undelivered message when there is no diagnostic", () => {
    expect(formatScoutAskRoutingError({}, "talkie")).toBe(
      "target @talkie is not currently routable; nothing was sent.",
    );
  });

  test("says plainly when there is no such target", () => {
    expect(formatScoutAskRoutingError(
      {
        targetDiagnostic: {
          agentId: "@mars",
          state: "unknown",
          registrationKind: null,
          projectRoot: null,
        },
      },
      "mars",
    )).toBe(
      "there is no @mars; nothing was sent.",
    );
  });

  test("calls out known but unavailable targets directly", () => {
    expect(formatScoutAskRoutingError(
      {
        targetDiagnostic: {
          agentId: "newell",
          state: "unavailable",
          detail: "Newell is currently offline with a manual wake policy, so the broker cannot bring it online without operator help.",
          wakePolicy: "manual",
          transport: "pairing_bridge",
          projectRoot: null,
        },
      },
      "newell",
    )).toContain("known but currently unavailable");
  });

  test("lists candidates when the short @name matches multiple agents", () => {
    const message = formatScoutAskRoutingError(
      {
        targetDiagnostic: {
          state: "ambiguous",
          candidates: [
            { agentId: "vox.mini.codex", label: "@vox.harness:codex" },
            { agentId: "vox.mini.claude", label: "@vox.harness:claude" },
          ],
        },
      },
      "vox",
    );
    expect(message).toContain("target @vox matches multiple agents");
    expect(message).toContain("@vox.harness:codex");
    expect(message).toContain("@vox.harness:claude");
    expect(message).toContain("Re-run with the fully qualified form");
  });

  test("preserves harness-qualified recovery for a native session collision", () => {
    const message = formatScoutAskRoutingError(
      {
        targetDiagnostic: {
          state: "ambiguous",
          candidates: [],
          detail: "session:native-shared exists in multiple harnesses (claude, codex); use session:<harness>:native-shared",
        },
      },
      "session:native-shared",
    );

    expect(message).toBe(
      "session:native-shared exists in multiple harnesses (claude, codex); use session:<harness>:native-shared Nothing was sent.",
    );
  });
});

describe("renderScoutAskReceipt", () => {
  test("makes offline queued delivery explicit in notify mode", () => {
    expect(renderScoutAskReceipt({
      replyMode: "notify",
      receipt: {
        ok: true,
        state: "queued",
        ids: {
          targetAgentId: "talkie-shell-claude",
          invocationId: "inv-1",
          flightId: "flt-1",
          conversationId: "dm.operator.talkie-shell-claude",
        },
      },
      flight: {
        id: "flt-1",
        invocationId: "inv-1",
        requesterId: "operator",
        targetAgentId: "talkie-shell-claude",
        state: "queued",
        summary: "Message stored for Talkie Shell Claude. Will deliver when online.",
        metadata: {
          dispatchOutcome: {
            status: "queued_until_online",
            reason: "no_runnable_endpoint",
          },
        },
      },
    })).toContain("Queued until target is online: Message stored for Talkie Shell Claude. Will deliver when online.");
  });

  test("calls out acknowledged dispatch separately from final completion", () => {
    expect(renderScoutAskReceipt({
      replyMode: "notify",
      receipt: {
        ok: true,
        state: "queued",
        ids: {
          targetAgentId: "openscout-card",
          invocationId: "inv-2",
          flightId: "flt-2",
        },
      },
      flight: {
        id: "flt-2",
        invocationId: "inv-2",
        requesterId: "operator",
        targetAgentId: "openscout-card",
        state: "running",
        summary: "Openscout Card acknowledged via spawn.",
      },
    })).toContain("Dispatch acknowledged: Openscout Card acknowledged via spawn.");
  });

  test("includes session alias pointers in ask receipts", () => {
    expect(renderScoutAskReceipt({
      replyMode: "notify",
      receipt: {
        ok: true,
        state: "queued",
        ids: {
          targetAgentId: "session-chopin-1",
          flightId: "flt-3",
          sessionAlias: "project-chopin",
          bindingRef: "abc12345",
        },
      },
      flight: {
        id: "flt-3",
        invocationId: "inv-3",
        requesterId: "operator",
        targetAgentId: "session-chopin-1",
        state: "running",
        summary: "alias project-chopin → session-chop…pin-1 (scope, codex) acknowledged via spawn.",
      },
    })).toContain("alias project-chopin");
  });
});

describe("ask receipt follow-up clarity", () => {
  const receipt = {
    ok: true, state: "queued" as const,
    ids: { targetAgentId: "project-hudson-3", invocationId: "inv-1", flightId: "flt-1", bindingRef: "abc12345" },
  };

  test("shares a work ticket separately from the completion wait command", () => {
    const text = renderScoutAskReceipt({ replyMode: "notify", receipt, links: {
      work: "http://scout.test/work/work-1", follow: "http://scout.test/work/work-1",
      tail: "http://scout.test/follow?view=tail&flightId=flt-1", session: null, agent: null,
    } });
    expect(text).toContain("Follow the task: http://scout.test/work/work-1");
    expect(text).toContain("scout wait ref:abc12345 --timeout 600");
    expect(text).not.toContain("view=tail");
  });

  test("notify shows destination, selected harness, and one wait command using the short ref", () => {
    const text = renderScoutAskReceipt({ replyMode: "notify", receipt: {
      ...receipt,
      executionResolution: {
        schemaVersion: "openscout.execution-resolution.v1",
        harness: { requested: "codex", resolved: "codex", drift: "unknown" },
        model: { drift: "unknown" }, reasoningEffort: { drift: "unknown" },
      },
    } });
    expect(text).toContain("Routed to project-hudson-3 · harness codex (selected) · ref:abc12345");
    expect(text).toContain("Scout will surface the completion when it arrives.");
    expect(text).toContain("Follow: scout wait ref:abc12345 --timeout 600");
    expect(text.match(/scout wait/g)).toHaveLength(1);
  });

  test("requested-only harness is not presented as confirmed execution", () => {
    const text = renderScoutAskReceipt({ replyMode: "notify", receipt: {
      ...receipt,
      executionResolution: {
        schemaVersion: "openscout.execution-resolution.v1",
        harness: { requested: "codex", drift: "unknown" },
        model: { drift: "unknown" }, reasoningEffort: { drift: "unknown" },
      },
    } });
    expect(text).toContain("harness codex (requested; unconfirmed)");
  });

  test("observed mismatch remains visible", () => {
    const text = renderScoutAskReceipt({ replyMode: "notify", receipt: {
      ...receipt,
      executionResolution: {
        schemaVersion: "openscout.execution-resolution.v1",
        harness: { requested: "codex", resolved: "codex", observed: "claude", drift: "mismatch" },
        model: { drift: "unknown" }, reasoningEffort: { drift: "unknown" },
      },
    } });
    expect(text).toContain("harness claude (observed; requested codex)");
  });

  test("dispatch metadata supplies harness when the receipt has no resolution", () => {
    const text = renderScoutAskReceipt({ replyMode: "notify", receipt, flight: {
      id: "flt-1", invocationId: "inv-1", requesterId: "operator", targetAgentId: "project-hudson-3", state: "running",
      metadata: { dispatchAck: { sessionId: "session-1", acknowledgedAt: 1, harness: "codex" } },
    } });
    expect(text).toContain("harness codex (dispatched)");
  });

  test("missing metadata stays unconfirmed and full handles remain usable fallbacks", () => {
    for (const replyMode of ["notify", "none"] as const) {
      const text = renderScoutAskReceipt({ replyMode, receipt: { ...receipt, ids: { targetAgentId: "codex-named-agent", invocationId: "inv-1", flightId: "flt-1" } } });
      expect(text).toContain("harness unconfirmed");
      expect(text).toContain("scout wait inv-1 --timeout 600");
    }
    expect(renderScoutAskReceipt({ replyMode: "none", receipt: { ...receipt, ids: { flightId: "flt-1" } } })).toContain("scout wait flt-1 --timeout 600");
  });

  test("already prefixed references are preserved and shell-sensitive references are quoted", () => {
    const render = (bindingRef: string) => renderScoutAskReceipt({ replyMode: "notify", receipt: { ...receipt, ids: { ...receipt.ids, bindingRef } } });
    expect(render("ref:abc12345")).toContain("scout wait ref:abc12345 --timeout 600");
    expect(render("ref:a'b")).toContain("scout wait 'ref:a'\\''b' --timeout 600");
  });

  test("terminal receipts preserve outcome and do not promise a future completion", () => {
    for (const state of ["completed", "failed", "cancelled"] as const) {
      const text = renderScoutAskReceipt({ replyMode: "notify", receipt, flight: {
        id: "flt-1", invocationId: "inv-1", requesterId: "operator", targetAgentId: "project-hudson-3", state, summary: "Recorded outcome",
      } });
      expect(text).toContain("Recorded outcome");
      expect(text).not.toContain("Scout will surface the completion");
      expect(text).toContain("scout wait ref:abc12345");
    }
  });

  test("newer dispatch does not inherit observed harness from an earlier receipt session", () => {
    const text = renderScoutAskReceipt({ replyMode: "notify", receipt: {
      ok: true, state: "queued", ids: { flightId: "flt-1" },
      executionResolution: {
        schemaVersion: "openscout.execution-resolution.v1", sessionId: "old-session",
        harness: { observed: "codex", drift: "match" }, model: { drift: "unknown" }, reasoningEffort: { drift: "unknown" },
      },
    }, flight: {
      id: "flt-1", invocationId: "inv-1", requesterId: "operator", targetAgentId: "worker", state: "running",
      metadata: { dispatchAck: { sessionId: "new-session", acknowledgedAt: 2, harness: "claude" } },
    } });
    expect(text).toContain("harness claude (dispatched)");
    expect(text).not.toContain("codex (observed)");
  });
});
