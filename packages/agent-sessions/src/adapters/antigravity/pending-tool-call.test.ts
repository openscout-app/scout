import { describe, expect, test } from "bun:test";

import { registerSecretValue } from "../../secret-redaction.js";
import {
  describeAntigravityToolCall,
  findAntigravityPendingToolCall,
  findAntigravityPendingToolContext,
  formatAntigravityWaitingFor,
} from "./pending-tool-call.js";

function jsonl(...steps: Array<Record<string, unknown>>): string {
  return `${steps.map((step, step_index) => JSON.stringify({ step_index, created_at: "2026-11-24T20:00:00Z", status: "DONE", ...step })).join("\n")}\n`;
}

describe("findAntigravityPendingToolCall", () => {
  test("captures an unanswered ask_question with stringified JSON args and options", () => {
    const pending = findAntigravityPendingToolCall(jsonl(
      { type: "USER_INPUT", source: "USER_EXPLICIT", content: "<USER_REQUEST>Ship the nav update</USER_REQUEST>" },
      {
        type: "PLANNER_RESPONSE",
        source: "MODEL",
        tool_calls: [{
          name: "ask_question",
          args: {
            questions: JSON.stringify([{
              question: "Promote the 6-area sidebar into main now?",
              options: ["(Recommended) Yes, promote it", "Keep it on the branch"],
            }]),
          },
        }],
      },
    ));
    expect(pending).toMatchObject({
      tool: "ask_question",
      title: "Question",
      subject: "Promote the 6-area sidebar into main now?",
      detail: "(Recommended) Yes, promote it · Keep it on the branch",
    });
    expect(pending?.questions?.[0]?.options).toHaveLength(2);
    expect(formatAntigravityWaitingFor(pending!)).toBe("Question: Promote the 6-area sidebar into main now?");
  });

  test("clears ask_question once a GENERIC result or explicit USER_INPUT arrives", () => {
    const askStep = {
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      tool_calls: [{ name: "ask_question", args: { questions: JSON.stringify([{ question: "Continue?", options: ["Yes", "No"] }]) } }],
    };
    expect(findAntigravityPendingToolCall(jsonl(askStep, { type: "GENERIC", source: "MODEL", content: "Yes" }))).toBeNull();
    expect(findAntigravityPendingToolCall(jsonl(askStep, { type: "USER_INPUT", source: "USER_EXPLICIT", content: "Actually hold off" }))).toBeNull();
  });

  test("captures a step in CORTEX_STEP_STATUS_WAITING and redacts secrets from command args", () => {
    registerSecretValue("sk-test-1234567890abcdef", "test");
    const pending = findAntigravityPendingToolCall(jsonl({
      type: "RUN_COMMAND",
      status: "WAITING",
      content: "Waiting for approval",
    }));
    expect(pending).toMatchObject({ tool: "run_command", title: "Run command" });

    const hooked = findAntigravityPendingToolCall("", {
      hookTool: {
        id: "toolu_1",
        name: "run_command",
        args: {
          CommandLine: "curl -H 'Authorization: Bearer sk-test-1234567890abcdef' https://example.com",
          BypassSandbox: true,
          toolSummary: "Push PR branch",
        },
        at: 1_700_000_000_000,
      },
    });
    expect(hooked).toMatchObject({
      toolUseId: "toolu_1",
      title: "Unsandboxed command",
      detail: "Push PR branch",
      subjectKind: "command",
    });
    expect(hooked?.subject).not.toContain("sk-test-1234567890abcdef");
  });

  test("captures an executable plan artifact requesting feedback once the turn finishes", () => {
    const pending = findAntigravityPendingToolCall(jsonl(
      {
        type: "PLANNER_RESPONSE",
        source: "MODEL",
        tool_calls: [{
          name: "write_file",
          args: {
            Path: JSON.stringify("/tmp/brain/plan.md"),
            ArtifactMetadata: JSON.stringify({ Summary: "Navigation rollout plan", UserFacing: true, RequestFeedback: true }),
          },
        }],
      },
      { type: "GENERIC", source: "MODEL", content: "Wrote /tmp/brain/plan.md" },
      { type: "PLANNER_RESPONSE", source: "MODEL", content: "Review the plan and click Proceed when ready." },
    ));
    expect(pending).toMatchObject({
      title: "Plan approval",
      subject: "/tmp/brain/plan.md",
      detail: "Navigation rollout plan",
    });
  });

  test("extracts prompt or assistant context before the pending tool call", () => {
    const text = jsonl(
      { type: "USER_INPUT", source: "USER_EXPLICIT", content: "<USER_REQUEST>Open the fork PR</USER_REQUEST><ADDITIONAL_METADATA>secret</ADDITIONAL_METADATA>" },
      { type: "PLANNER_RESPONSE", source: "MODEL", content: "Opening the PR on arach/scout.", tool_calls: [{ name: "run_command", args: { CommandLine: "\"gh pr create\"", BypassSandbox: "true" } }] },
    );
    expect(findAntigravityPendingToolContext(text, "run_command")).toMatchObject({
      source: "assistant",
      text: "Opening the PR on arach/scout.",
    });
    expect(describeAntigravityToolCall("call_mcp_tool", { ServerName: "scout", ToolName: "ask", Arguments: { to: "sol" } })).toMatchObject({
      title: "scout - ask (MCP)",
    });
    expect(describeAntigravityToolCall("read_file", { Path: "/repo/src/index.ts", StartLine: "10", EndLine: "40" })).toMatchObject({
      title: "Read file",
      subject: "/repo/src/index.ts:10-40",
    });
  });

  test("passively picks up unresolved BypassSandbox and out-of-workspace file calls when the session is busy", () => {
    const stepAt = Date.parse("2026-11-24T20:00:00Z");
    const unsandboxed = jsonl({
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      tool_calls: [{
        name: "run_command",
        args: {
          CommandLine: JSON.stringify("git push origin feat/nav"),
          BypassSandbox: "true",
          toolSummary: JSON.stringify("Push branch"),
        },
      }],
    });
    // Debounces sub-second execution before surfacing passive approval state.
    expect(findAntigravityPendingToolCall(unsandboxed, { sessionBusy: true, now: stepAt + 500 })).toBeNull();
    expect(findAntigravityPendingToolCall(unsandboxed, { sessionBusy: true, now: stepAt + 2_500 })).toMatchObject({
      tool: "run_command",
      title: "Unsandboxed command",
      subject: "git push origin feat/nav",
      detail: "Push branch",
    });
    // Never reports stale approval prompts once the session is idle.
    expect(findAntigravityPendingToolCall(unsandboxed, { sessionBusy: false, now: stepAt + 5_000 })).toBeNull();

    const outsideWorkspace = jsonl({
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      tool_calls: [{
        name: "edit_file",
        args: { Path: JSON.stringify("/etc/hosts") },
      }],
    });
    expect(findAntigravityPendingToolCall(outsideWorkspace, {
      sessionBusy: true,
      workspaceRoot: "/workspace/project",
      now: stepAt + 2_500,
    })).toMatchObject({
      tool: "edit_file",
      title: "Edit file",
      subject: "/etc/hosts",
    });
  });
});
