import type { TailEvent } from "./types.js";
export type TailRecentFilter = { sources?: string[]; kinds?: string[]; sessionId?: string; project?: string; cwd?: string; query?: string };

// Antigravity assigns native step numbers and can timestamp a whole parallel
// batch in the same millisecond. Cursors retain their original unpadded IDs.
const nativeStepOrder = new Intl.Collator("en", { numeric: true });
export function compareTailTimes(left: TailEvent, right: TailEvent): number {
  const delta = left.ts - right.ts;
  if (delta || left.source !== "antigravity" || right.source !== "antigravity" || left.sessionId !== right.sessionId) return delta;
  return nativeStepOrder.compare(left.id, right.id);
}

export function compareRecentEvents(left: TailEvent, right: TailEvent): number {
  return compareTailTimes(left, right) || left.id.localeCompare(right.id);
}

export function tailLineKey(event: TailEvent): string {
  if (event.source === "antigravity") return event.id;
  return [event.source, event.sessionId, event.ts, event.kind, event.summary].join("\u0000");
}

export function normalizedFilterSet(values: string[] | undefined): Set<string> | null {
  const normalized = values
    ?.map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return normalized && normalized.length > 0 ? new Set(normalized) : null;
}

function textMatches(value: string | null | undefined, query: string | null): boolean {
  if (!query) return true;
  return (value ?? "").toLowerCase().includes(query);
}

export function tailEventMatches(
  event: TailEvent,
  input: TailRecentFilter | undefined,
): boolean {
  const sources = normalizedFilterSet(input?.sources);
  if (sources && !sources.has(event.source.toLowerCase())) return false;

  const kinds = normalizedFilterSet(input?.kinds);
  if (kinds && !kinds.has(event.kind.toLowerCase())) return false;

  const sessionId = input?.sessionId?.trim();
  if (sessionId && event.sessionId !== sessionId) return false;

  const project = input?.project?.trim().toLowerCase();
  if (project && !textMatches(event.project, project)) return false;

  const cwd = input?.cwd?.trim().toLowerCase();
  if (cwd && !textMatches(event.cwd, cwd)) return false;

  const query = input?.query?.trim().toLowerCase();
  if (query) {
    const haystack = [
      event.source,
      event.kind,
      event.sessionId,
      event.project,
      event.cwd,
      event.harness,
      event.summary,
    ].join("\n").toLowerCase();
    if (!haystack.includes(query)) return false;
  }

  return true;
}
