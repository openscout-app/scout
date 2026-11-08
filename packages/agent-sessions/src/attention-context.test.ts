import { afterEach, expect, test } from "bun:test";
import { shapeAttentionContext, attentionContextBeforeBlock } from "./attention-context.js";
import { registerSecretValue, resetSecretRegistryForTests } from "./secret-redaction.js";
import type { TurnState } from "./state.js";

afterEach(resetSecretRegistryForTests);
test("last paragraph, whitespace, redaction, then suffix clipping", () => {
  registerSecretValue("invented-secret-value");
  expect(shapeAttentionContext("Discard this.\n\n Use\n invented-secret-value   now. ", "task")).toEqual({
    text: "Use [redacted] now.", source: "task", at: null,
  });
  const result = shapeAttentionContext("a".repeat(300) + " final sentence.", "assistant", 42)!;
  expect(result.text).toHaveLength(240);
  expect(result.text.startsWith("…")).toBe(true);
  expect(result.text.endsWith(" final sentence.")).toBe(true);
  expect(shapeAttentionContext("  ", "prompt")).toBeNull();
});
test("only text blocks before the target, never reasoning or later text", () => {
  const turn = { startedAt: 5, blocks: [
    { block: { id: "text", type: "text", text: "Checking the build." } },
    { block: { id: "thinking", type: "reasoning", text: "Private reasoning" } },
    { block: { id: "target", type: "action" } },
    { block: { id: "later", type: "text", text: "Too late" } },
  ] } as TurnState;
  expect(attentionContextBeforeBlock(turn, "target")).toEqual({ text: "Checking the build.", source: "assistant", at: 5 });
  expect(attentionContextBeforeBlock(turn, "missing")).toBeNull();
});
