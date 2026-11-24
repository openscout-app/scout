import type { DiscoveredTranscript, TailEvent } from "@openscout/runtime/harnesses";

import type { ObserveData, ObserveEvent } from "./service.ts";

const GROK_STREAMING_PHASES = new Set([
  "streaming_reasoning",
  "streaming_text",
  "tool_execution",
  "permission_prompt",
]);

const GROK_TOOL_STARTED = /^([A-Za-z][\w-]*) started$/;
const GROK_TOOL_COMPLETED = /^([A-Za-z][\w-]*) completed(?: · (.+))?$/;
const GROK_TOOL_WITH_ARG = /^([A-Za-z][\w-]*) · (.+?)(?: · (success|error|failed))?$/;
const CODEX_TOOL_CALL = /^([A-Za-z_][\w.-]*)\((.*)\)$/s;
const CLEAN_TOOL_CALL = /^([A-Za-z][\w-]*)(?:\s+([\s\S]+))?$/;
const CLEAN_RESULT_PREFIX = /^res:\s*([\s\S]*)$/;
const CLEAN_COMBINED_RESULT = /^([\s\S]+?)\s+->\s+res:\s*([\s\S]+)$/;
const CLEAN_RESULT_ERROR = /\b(?:failed|failure|exception|fatal|denied|traceback)\b|error:/i;

const NATIVE_DISCOVERED_FRESH_MS = 5 * 60_000;

const TAIL_ATTRIBUTION_LABEL = {
  "scout-managed": "scout",
  "hudson-managed": "hudson",
  unattributed: "native",
} as const;

function tailAttributionLabel(harness: TailEvent["harness"]): string {
  return TAIL_ATTRIBUTION_LABEL[harness] ?? harness;
}

function tailObserveEventDetail(
  event: Pick<TailEvent, "kind" | "source" | "harness" | "project" | "cwd">,
  transcript: DiscoveredTranscript,
): string | undefined {
  if (event.kind === "tool" || event.kind === "tool-result") {
    return undefined;
  }

  const workspace = transcript.project?.trim()
    || transcript.cwd?.trim()
    || event.project?.trim()
    || event.cwd?.trim();
  const origin = tailAttributionLabel(event.harness);
  return workspace ? `${workspace} · ${origin}` : `${event.source} · ${origin}`;
}

function isTailNoiseEvent(event: TailEvent): boolean {
  if (event.source === "cursor") {
    const summary = event.summary.trim().toLowerCase();
    return event.kind === "system"
      && (summary === "process sample" || summary.startsWith("process sample ·"));
  }
  if (event.source !== "grok") return false;

  const summary = event.summary.trim().toLowerCase();
  if (summary === "first token" || summary.startsWith("loop ")) {
    return true;
  }

  if (!summary.startsWith("phase ·")) return false;
  const phase = summary.slice("phase ·".length).trim();
  return GROK_STREAMING_PHASES.has(phase);
}

function filterTailEventsForDisplay(events: TailEvent[]): TailEvent[] {
  return events.filter((event) => !isTailNoiseEvent(event));
}

function observeToolFieldsFromTailEvent(event: TailEvent): {
  tool?: string;
  arg?: string;
  result?: Record<string, string>;
} {
  if (event.kind !== "tool" && event.kind !== "tool-result") return {};

  const summary = event.summary.trim();
  if (!summary) return {};

  if (event.source === "claude" || event.source === "kimi") {
    const combined = summary.match(CLEAN_COMBINED_RESULT);
    if (combined?.[1] && combined[2]) {
      const call = combined[1].trim().match(CLEAN_TOOL_CALL);
      const preview = combined[2].trim();
      if (call?.[1] && /^[A-Z]/u.test(call[1])) {
        return {
          tool: call[1],
          arg: call[2]?.trim() || undefined,
          result: { outcome: CLEAN_RESULT_ERROR.test(preview) ? "error" : "success" },
        };
      }
      return {
        tool: "bash",
        arg: combined[1].trim(),
        result: { outcome: CLEAN_RESULT_ERROR.test(preview) ? "error" : "success" },
      };
    }
    const result = summary.match(CLEAN_RESULT_PREFIX);
    if (result) {
      const preview = result[1].trim();
      return {
        tool: "res",
        arg: preview || undefined,
        result: { outcome: CLEAN_RESULT_ERROR.test(preview) ? "error" : "success" },
      };
    }
    const call = summary.match(CLEAN_TOOL_CALL);
    if (call?.[1] && /^[A-Z]/u.test(call[1])) {
      return { tool: call[1], arg: call[2]?.trim() || undefined };
    }
    return { tool: "bash", arg: summary };
  }

  if (event.source === "grok") {
    const enriched = summary.match(GROK_TOOL_WITH_ARG);
    if (enriched?.[1] && enriched[2]) {
      const fields: { tool?: string; arg?: string; result?: Record<string, string> } = {
        tool: enriched[1],
        arg: enriched[2],
      };
      if (enriched[3]) fields.result = { outcome: enriched[3] };
      return fields;
    }
    const started = summary.match(GROK_TOOL_STARTED);
    if (started?.[1]) {
      return { tool: started[1], arg: "started" };
    }
    const completed = summary.match(GROK_TOOL_COMPLETED);
    if (completed?.[1]) {
      const fields: { tool?: string; arg?: string; result?: Record<string, string> } = {
        tool: completed[1],
        arg: "completed",
      };
      if (completed[2]) fields.result = { outcome: completed[2] };
      return fields;
    }
  }

  const fnCall = summary.match(CODEX_TOOL_CALL);
  if (fnCall?.[1]) {
    return { tool: fnCall[1], arg: fnCall[2]?.trim() || undefined };
  }

  const dotSep = summary.match(/^([A-Za-z_][\w.-]*) · (.+)$/);
  if (dotSep?.[1]) {
    return { tool: dotSep[1], arg: dotSep[2] };
  }

  const first = summary.split(/\s+/)[0];
  if (first && first.toLowerCase() !== event.source.toLowerCase()) {
    return { tool: first };
  }

  return {};
}

function tailEventKindToObserveKind(event: TailEvent): ObserveEvent["kind"] {
  if (
    event.source === "kimi"
    && event.kind === "system"
    && event.summary.trim().startsWith("[thinking] ")
  ) {
    return "think";
  }
  switch (event.kind) {
    case "assistant":
      return "message";
    case "tool":
    case "tool-result":
      return "tool";
    case "user":
      return "ask";
    case "system":
      return "system";
    default:
      return "note";
  }
}

export function buildObserveDataFromTail(
  transcript: DiscoveredTranscript,
  events: TailEvent[],
  current: boolean,
): ObserveData {
  const tail = filterTailEventsForDisplay(
    [...events].sort((left, right) => left.ts - right.ts),
  ).slice(-200);
  const sessionStart = tail[0]?.ts ?? transcript.mtimeMs;

  const observeEvents = tail.map((event): ObserveEvent => {
    const toolFields = observeToolFieldsFromTailEvent(event);
    return {
      id: event.id,
      t: Math.max(0, Math.round((event.ts - sessionStart) / 1000)),
      at: event.ts,
      kind: tailEventKindToObserveKind(event),
      text: event.source === "kimi"
        ? event.summary.replace(/^\[thinking\]\s+/u, "")
        : event.summary,
      tool: toolFields.tool,
      arg: toolFields.arg,
      result: toolFields.result,
      detail: tailObserveEventDetail(event, transcript),
      live: current && event.id === tail[tail.length - 1]?.id,
    };
  });

  const placeholderEvents: ObserveEvent[] = observeEvents.length > 0
    ? observeEvents
    : (Date.now() - transcript.mtimeMs <= NATIVE_DISCOVERED_FRESH_MS
        ? [{
            id: `${transcript.source}:${transcript.sessionId ?? "session"}:discovered`,
            t: 0,
            kind: "system",
            text: `Native ${transcript.source} transcript discovered.`,
            detail: transcript.cwd ?? transcript.transcriptPath,
          }]
        : []);

  return {
    events: placeholderEvents,
    files: [],
    live: current && observeEvents.length > 0,
    metadata: {
      session: {
        adapterType: transcript.source,
        cwd: transcript.cwd ?? undefined,
        externalSessionId: transcript.sessionId ?? undefined,
        sessionStart,
      },
    },
  };
}
