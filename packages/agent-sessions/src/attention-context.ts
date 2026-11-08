import { redactSecrets } from "./secret-redaction.js";
import type { TurnState } from "./state.js";

export type AttentionContext = {
  text: string;
  source: "assistant" | "prompt" | "task";
  at: number | null;
};

/** Only observed words: last paragraph, redacted before retaining its end. */
export function shapeAttentionContext(value: string | null | undefined, source: AttentionContext["source"], at: number | null = null): AttentionContext | null {
  const paragraph = value?.trim().split(/\n\s*\n/u).at(-1) ?? "";
  const clean = redactSecrets(paragraph.replace(/\s+/gu, " ").trim());
  if (!clean) return null;
  return { text: clean.length > 240 ? `…${clean.slice(-239)}` : clean, source, at: at !== null && Number.isFinite(at) ? at : null };
}

export function attentionContextBeforeBlock(turn: TurnState, blockId: string): AttentionContext | null {
  const index = turn.blocks.findIndex(({ block }) => block.id === blockId);
  for (let i = index - 1; i >= 0; i--) {
    const block = turn.blocks[i]!.block;
    if (block.type === "text") return shapeAttentionContext(block.text, "assistant", turn.startedAt);
  }
  return null;
}
