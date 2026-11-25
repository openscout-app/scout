import type { TailEvent } from "./types.js";

/** Grok lifecycle phases that flood the tail during streaming without adding signal. */
const GROK_STREAMING_PHASES = new Set([
  "streaming_reasoning",
  "streaming_text",
  "tool_execution",
  "permission_prompt",
  "waiting_for_model",
]);

function isCodexChunkToolResult(summary: string): boolean {
  const trimmed = summary.trim();
  return trimmed.startsWith("-> Chunk ID:")
    || /^->\s+Wall time:/u.test(trimmed);
}

function isCursorProcessSample(event: TailEvent): boolean {
  if (event.source !== "cursor" || event.kind !== "system") return false;
  const summary = event.summary.trim().toLowerCase();
  return summary === "process sample" || summary.startsWith("process sample ·");
}

/** Consumer-side tail presentation policy — the firehose stays complete upstream. */
export function isTailNoiseEvent(event: TailEvent): boolean {
  // Cursor's process-monitor records remain available to discovery and in the
  // raw firehose, but their periodic snapshots are not user-authored activity.
  if (isCursorProcessSample(event)) return true;

  if (event.source === "grok") {
    const summary = event.summary.trim().toLowerCase();
    if (summary === "first token" || summary.startsWith("loop ")) {
      return true;
    }

    if (!summary.startsWith("phase ·")) return false;
    const phase = summary.slice("phase ·".length).trim();
    return GROK_STREAMING_PHASES.has(phase);
  }

  if (event.source !== "codex") return false;

  if (event.kind === "tool-result") {
    const summary = event.summary.trim();
    if (isCodexChunkToolResult(summary)) return true;
    if (/_end ·/u.test(summary)) return true;
    if (summary.startsWith("->")) return true;
  }

  if (event.kind !== "system") return false;

  const summary = event.summary.trim().toLowerCase();
  if (summary === "user_message" || summary === "agent_message") return true;
  if (summary === "[reasoning]") return true;
  if (summary.startsWith("turn context")) return true;
  if (summary.startsWith("tokens ·")) return true;
  if (summary.startsWith("session ")) return true;
  return false;
}

/** Plain CLI rows, shared with the broker so hidden rows cannot consume a backlog limit. */
export function isPlainTailEvent(event: TailEvent): boolean {
  if (isTailNoiseEvent(event) || (event.kind === "tool" && event.source !== "antigravity")) return false;
  const summary = event.summary.trim().toLowerCase();
  return !summary.startsWith("permission requested") && !summary.startsWith("permission allow");
}

export function filterTailEventsForDisplay(events: TailEvent[]): TailEvent[] {
  return events.filter((event) => !isTailNoiseEvent(event));
}
