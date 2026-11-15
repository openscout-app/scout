import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { buildScoutAskReceipt, buildScoutAskRoute } from "./ask.ts";

describe("buildScoutAskRoute", () => {
  test("keeps direct --to values as existing agent-label routes", () => {
    expect(buildScoutAskRoute({
      to: "Fable",
      currentDirectory: "/tmp/openscout",
    })).toEqual({
      kind: "agent_label",
      label: "Fable",
    });
  });

  test("builds explicit broker runtime-profile routes for the current project", () => {
    expect(buildScoutAskRoute({
      to: "",
      runtimeProfile: "opus",
      currentDirectory: "/tmp/openscout",
      reasoningEffort: "high",
    })).toEqual({
      kind: "runtime_profile",
      profile: "opus",
      projectPath: "/tmp/openscout",
      reasoningEffort: "high",
    });
  });

  test("normalizes a runtime profile's inferred project path to an absolute path", () => {
    expect(buildScoutAskRoute({
      to: "",
      runtimeProfile: "fable",
      currentDirectory: "relative/project",
    })).toEqual({
      kind: "runtime_profile",
      profile: "fable",
      projectPath: resolve("relative/project"),
    });
  });

  test("uses an explicit project to narrow a runtime-profile launch", () => {
    expect(buildScoutAskRoute({
      to: "",
      runtimeProfile: "fable",
      projectPath: "../talkie",
      currentDirectory: "/tmp/openscout",
    })).toEqual({
      kind: "runtime_profile",
      profile: "fable",
      projectPath: "/tmp/talkie",
    });
  });

  test("builds a distinct exact existing-handle route", () => {
    expect(buildScoutAskRoute({
      to: "",
      existingHandle: "@composer-review",
      currentDirectory: "/tmp/openscout",
    })).toEqual({
      kind: "existing_handle",
      handle: "composer-review",
      value: "@composer-review",
    });
  });

  test("preserves explicit route-alias scope without changing direct target semantics", () => {
    expect(buildScoutAskRoute({
      to: "alias:review",
      currentDirectory: "/tmp/openscout",
      aliasScope: { projectRoot: "/tmp/talkie", nodeId: "mini" },
    })).toEqual({
      kind: "route_alias",
      alias: "review",
      value: "alias:review",
      scope: { projectRoot: "/tmp/talkie", nodeId: "mini" },
    });
  });

  test("routes a copied session address to that exact host-scoped session", () => {
    expect(buildScoutAskRoute({
      to: "sess.6773faf3c863ce885044@arts-mini",
      currentDirectory: "/tmp/openscout",
    })).toEqual({
      kind: "session_id",
      sessionId: "sess.6773faf3c863ce885044",
      host: "arts-mini",
      value: "session:sess.6773faf3c863ce885044@arts-mini",
    });
  });
});

describe("buildScoutAskReceipt", () => {
  const sessionId = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
  const sessionTarget = {
    target: { kind: "session_id" as const, sessionId, value: `session:${sessionId}` },
    display: `session:${sessionId}`,
  };

  test("a refused exact session says why, with the runtime's code", () => {
    const receipt = buildScoutAskReceipt({
      target: sessionTarget,
      currentDirectory: "/tmp/openscout",
      result: {
        usedBroker: true,
        targetDiagnostic: {
          agentId: `session:${sessionId}`,
          state: "unknown",
          registrationKind: null,
          projectRoot: null,
          detail: `session ${sessionId} is already running without a verified Scout endpoint`,
          sessionWakeReason: "session_live_unbound",
        },
      },
    });

    expect(receipt.ok).toBe(false);
    expect(receipt.state).toBe("failed");
    expect(receipt.error).toEqual({
      code: "target_unroutable",
      message: `session ${sessionId} is already running without a verified Scout endpoint`,
      reason: "session_live_unbound",
    });
    // An agent search cannot find another route to an exact session id.
    expect(receipt.next).toBeUndefined();
  });

  test("a refusal with a code and no detail still reports the code", () => {
    const receipt = buildScoutAskReceipt({
      target: sessionTarget,
      currentDirectory: "/tmp/openscout",
      result: {
        usedBroker: true,
        targetDiagnostic: {
          agentId: `session:${sessionId}`,
          state: "unknown",
          registrationKind: null,
          projectRoot: null,
          sessionWakeReason: "session_unknown",
        },
      },
    });
    expect(receipt.error).toEqual({ code: "target_unroutable", message: "session_unknown", reason: "session_unknown" });
  });

  test("an unknown agent label keeps its search hint and gains the reason", () => {
    const receipt = buildScoutAskReceipt({
      target: { target: { kind: "agent_label", label: "@nobody" }, display: "@nobody" },
      currentDirectory: "/tmp/openscout",
      result: {
        usedBroker: true,
        targetDiagnostic: {
          agentId: "@nobody",
          state: "unknown",
          registrationKind: null,
          projectRoot: null,
          detail: "no agent matches @nobody",
        },
      },
    });
    expect(receipt.next?.tool).toBe("agents_search");
    expect(receipt.error).toEqual({ code: "target_unroutable", message: "no agent matches @nobody" });
  });

  test("an accepted ask carries no error", () => {
    const receipt = buildScoutAskReceipt({
      target: sessionTarget,
      currentDirectory: "/tmp/openscout",
      result: { usedBroker: true, accepted: true, conversationId: "c1", messageId: "m1" },
    });
    expect(receipt.ok).toBe(true);
    expect(receipt.error).toBeUndefined();
  });
});
