import type { TailEvent } from "./types.js";
export type TailRecentFilter = { sources?: string[]; kinds?: string[]; sessionId?: string; project?: string; cwd?: string; query?: string };

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
