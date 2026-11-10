import type { AgentEndpoint, ObservedSessionIdentity, ObservedSessionInventory, ObservedSessionRead } from "@openscout/protocol";
import { getCachedTailDiscovery } from "./tail/index.js";
import type { DiscoverySnapshot } from "./tail/types.js";

export const observedSessionKey = (identity: ObservedSessionIdentity) => JSON.stringify([identity.nodeId, identity.harness, identity.nativeSessionId]);
// Harness aliases only. Native identifiers are opaque and case-sensitive.
const harnessAliases = new Map([["claude-code", "claude"], ["claude-stream-json", "claude"], ["codex-app-server", "codex"], ["codex-exec", "codex"], ["pi-rpc", "pi"]]);
export const observedHarness = (value: string): string => harnessAliases.get(value) ?? value;
const valid = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f]/u.test(value);
export class ObservedSessionReadError extends Error {
  constructor(public status: number, public code: string, public candidates: unknown[] = [], public candidatesTruncated = false) { super(code); }
}
export type ObservedSessionReadDeps = { nodeId: string; readCache?: () => DiscoverySnapshot; readEndpoints?: () => Record<string, AgentEndpoint> };

export function buildObservedSessionInventory(deps: ObservedSessionReadDeps, limit = 100): ObservedSessionInventory {
  const cached = (deps.readCache ?? getCachedTailDiscovery)();
  const sourceStates = cached.readStatus?.sources.slice(0, 32) ?? [];
  const initialized = cached.readStatus?.initialized === true;
  const states = new Map(sourceStates.map(source => [observedHarness(source.harness), source]));
  const sessions = new Map<string, ObservedSessionRead>();
  const paths = new Map<string, string>();
  let truncated = cached.transcripts.length > 2_000 || (cached.readStatus?.sources.length ?? 0) > 32;
  for (const transcript of cached.transcripts.slice(0, 2_000)) {
    if (!valid(transcript.sessionId) || !valid(transcript.source)) continue; // Never invent identity from a filename.
    const identity = { nodeId: deps.nodeId, harness: observedHarness(transcript.source), nativeSessionId: transcript.sessionId };
    const key = observedSessionKey(identity), prior = sessions.get(key);
    if (prior) { if (paths.get(key) !== transcript.transcriptPath) prior.identityConflict = true; continue; }
    const conflict = cached.issues?.some(issue => issue.kind === "transcript_path_collision" && issue.sessionKey === `${transcript.source}:${transcript.sessionId}`) ?? false;
    sessions.set(key, { identity, links: [], cwd: transcript.cwd && transcript.cwd.length <= 4096 ? transcript.cwd : null,
      title: transcript.title?.slice(0, 512) ?? null, observedAt: cached.generatedAt,
      availability: initialized ? states.get(identity.harness)?.availability ?? "unknown" : "not_scanned", identityConflict: conflict });
    paths.set(key, transcript.transcriptPath);
  }
  let endpointsAvailable = false;
  if (deps.readEndpoints) {
    const endpoints = deps.readEndpoints(); endpointsAvailable = true;
    let count = 0;
    for (const id in endpoints) {
      if (!Object.hasOwn(endpoints, id)) continue;
      if (++count > 2_000) { truncated = true; break; }
      const endpoint = endpoints[id];
      if (endpoint.nodeId !== deps.nodeId || !valid(endpoint.agentId)) continue;
      // A session Scout resumed keeps the harness's own id in metadata, so
      // match every id the endpoint answers to, not only its sessionId.
      const nativeIds = new Set([endpoint.sessionId, endpoint.metadata?.nativeSessionId, endpoint.metadata?.externalSessionId].filter(valid));
      for (const nativeSessionId of nativeIds) {
        const row = sessions.get(observedSessionKey({ nodeId: deps.nodeId, harness: observedHarness(endpoint.harness), nativeSessionId }));
        if (!row || row.links.some(link => link.id === endpoint.agentId && link.kind === "agent")) continue;
        if (row.links.length >= 8) { truncated = true; continue; }
        row.links.push({ kind: "agent", id: endpoint.agentId });
      }
    }
  }
  const ordered = [...sessions.values()].sort((a, b) => observedSessionKey(a.identity).localeCompare(observedSessionKey(b.identity)));
  const availability = !initialized ? "not_scanned" : sourceStates.length && sourceStates.every(s => s.availability === "available") ? "available"
    : sourceStates.length && sourceStates.every(s => s.availability === "unavailable") ? "unavailable" : "partial";
  return { schema: "scout.observed-sessions/v1", nodeId: deps.nodeId, scannedAt: initialized ? cached.generatedAt : null,
    availability, sources: sourceStates, sessions: ordered.slice(0, limit),
    coverage: { kind: "cached_window", scope: cached.readStatus?.scope ?? null, truncated: truncated || ordered.length > limit,
      links: { agents: endpointsAvailable ? "available" : "unavailable", conversations: "unsupported", terminals: "unsupported" } } };
}

/** A complete bounded lookup never silently picks between unlike identity kinds. */
export function selectObservedSession(inventory: ObservedSessionInventory, url: URL): ObservedSessionRead {
  const ref = url.searchParams.get("ref"), nodeId = url.searchParams.get("nodeId"), harness = url.searchParams.get("harness"), nativeSessionId = url.searchParams.get("nativeSessionId");
  if (ref !== null && (nodeId !== null || harness !== null || nativeSessionId !== null)) throw new ObservedSessionReadError(400, "mixed_session_selector");
  let matches: ObservedSessionRead[];
  if (ref !== null) {
    if (!valid(ref)) throw new ObservedSessionReadError(400, "invalid_session_selector");
    const candidates: Array<{ kind: string; id?: string; identity: ObservedSessionIdentity }> = [];
    outer: for (const row of inventory.sessions) {
      if (row.identity.nativeSessionId === ref) candidates.push({ kind: "observed_session", identity: row.identity });
      for (const link of row.links) if (link.id === ref) { candidates.push({ ...link, identity: row.identity }); if (candidates.length >= 128) break outer; }
      if (candidates.length >= 128) break;
    }
    if (candidates.length > 1) throw new ObservedSessionReadError(409, "ambiguous_session_ref", candidates, candidates.length >= 128);
    // Missing link domains or failed/bounded source reads cannot prove that a
    // single visible match is globally unique. Exact tuples remain usable.
    if (inventory.coverage.truncated || inventory.availability !== "available" || Object.values(inventory.coverage.links).some(status => status !== "available")) throw new ObservedSessionReadError(503, "session_lookup_incomplete");
    matches = candidates.length ? inventory.sessions.filter(row => observedSessionKey(row.identity) === observedSessionKey(candidates[0].identity)) : [];
  } else {
    if (![nodeId, harness, nativeSessionId].every(valid)) throw new ObservedSessionReadError(400, "invalid_session_selector");
    matches = inventory.sessions.filter(row => row.identity.nodeId === nodeId && row.identity.harness === observedHarness(harness!) && row.identity.nativeSessionId === nativeSessionId);
  }
  if (!matches.length) throw new ObservedSessionReadError(inventory.availability === "available" && !inventory.coverage.truncated ? 404 : 503,
    inventory.availability === "available" && !inventory.coverage.truncated ? "session_not_observed" : "session_inventory_unavailable");
  const row = matches[0];
  if (row.identityConflict) throw new ObservedSessionReadError(409, "ambiguous_session_identity", matches.map(row => ({ kind: "observed_session", identity: row.identity })));
  if (row.availability !== "available") throw new ObservedSessionReadError(503, "session_source_unavailable");
  return row;
}

export function readObservedSessions(deps: ObservedSessionReadDeps, url: URL, resolve: boolean): { status: number; body: unknown } {
  try {
    const allowed = resolve ? ["ref", "nodeId", "harness", "nativeSessionId"] : ["limit"];
    for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new ObservedSessionReadError(400, "invalid_session_query");
    const limit = Number(url.searchParams.get("limit") ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ObservedSessionReadError(400, "invalid_session_limit");
    const inventory = buildObservedSessionInventory(deps, resolve ? 2_000 : limit);
    return { status: 200, body: resolve ? { schema: "scout.observed-session/v1", session: selectObservedSession(inventory, url) } : inventory };
  } catch (error) {
    return error instanceof ObservedSessionReadError ? { status: error.status, body: { error: error.code, ...(error.candidates.length ? { candidates: error.candidates, candidatesTruncated: error.candidatesTruncated } : {}) } }
      : { status: 503, body: { error: "session_inventory_unavailable" } };
  }
}
