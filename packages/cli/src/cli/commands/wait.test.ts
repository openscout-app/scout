import { describe, expect, test } from "bun:test";

import {
  parseWaitCommandOptions,
  renderWaitCommandHelp,
  renderWaitCommandResult,
} from "./wait.ts";

describe("renderWaitCommandHelp", () => {
  test("documents generic wait refs", () => {
    const help = renderWaitCommandHelp();

    expect(help).toContain("Usage: scout wait <ref>");
    expect(help).toContain("invocation id, flight id, message id, ref:<short-id>, or the session-… id it was sent to");
  });
});

describe("parseWaitCommandOptions", () => {
  test("parses a ref and timeout", () => {
    expect(parseWaitCommandOptions(["ref:abc123", "--timeout", "120"])).toEqual({
      command: "wait",
      ref: "ref:abc123",
      timeoutSeconds: 120,
    });
  });

  test("rejects extra positional args", () => {
    expect(() => parseWaitCommandOptions(["inv-1", "inv-2"])).toThrow("unexpected extra argument");
  });
});

describe("renderWaitCommandResult", () => {
  test("renders completed invocation output", () => {
    const output = renderWaitCommandResult({
      input: "ref:abc123",
      found: true,
      timedOut: false,
      resolution: {
        found: true,
        input: "ref:abc123",
        kind: "ref",
        invocationId: "inv-1",
        flightId: "flt-1",
        messageId: "msg-1",
        bindingRef: "abc123",
      },
      invocationId: "inv-1",
      flight: {
        id: "flt-1",
        invocationId: "inv-1",
        requesterId: "operator",
        targetAgentId: "codex",
        state: "completed",
        summary: "Review complete.",
        output: "Looks good.",
      },
      output: "Looks good.",
      summary: "Review complete.",
      error: null,
      nextAction: null,
    });

    expect(output).toContain("Invocation: inv-1");
    expect(output).toContain("Flight: flt-1");
    expect(output).toContain("Resolved: ref");
    expect(output).toContain("Output:\nLooks good.");
  });
});
