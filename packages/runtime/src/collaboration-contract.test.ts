import { expect, test } from "bun:test";
import { buildCollaborationContractPrompt } from "./collaboration-contract.ts";

test("runtime operator escalation instructions use the supported CLI command", () => {
  const prompt = buildCollaborationContractPrompt("test-agent");
  expect(prompt).toContain('scout ask --operator');
  expect(prompt).not.toContain('scout need');
});
