/**
 * Session → terminal surface resolution.
 *
 * "Hop into terminal" needs one answer from any surface that shows an agent or
 * session: which live terminal surface, if any, is running it. This module is
 * that resolver, shared by the web server (`/api/terminal-sessions/resolve`),
 * the web client (hop menus), and thin clients such as the macOS HUD that ask
 * the server instead of shipping the matching rules.
 *
 * Matching is deliberately conservative — a false positive drops the operator
 * into someone else's terminal, which is worse than offering no hop at all.
 * The binds, strongest first:
 *
 * 1. A registered record's `sourceSessionId` — the harness-native id `scout
 *    session intake` stored when the session got its terminal home.
 * 2. A registered record's session metadata refs (thread id, conversation id,
 *    runtime/external session id) — same session, different spelling.
 * 3. A surface's `sessionName` equal to a ref — how discovered multiplexer
 *    sessions (`tmux-…`, `session-…`, harness-prefixed names) resolve.
 *
 * `agentId` contributes one weak candidate: its leading `session-…` segment —
 * the definition id Scout agents embed (`session-xxx.host.node`). Nothing else
 * binds an agent id to a terminal record, and a bare non-`session-` leading
 * segment is deliberately not trusted.
 */

import { AGENT_HARNESSES } from "./actors.js";
import type { TerminalSessionRecord, TerminalSurface } from "./terminal-sessions.js";

export type SessionTerminalHints = {
  /** Scout agent id, when the caller knows which agent owns the session. */
  agentId?: string | null;
  /** Session references: harness session ids, transcript ids, route refs. */
  sessionRefs?: readonly (string | null | undefined)[];
};

export type SessionTerminalResolution = {
  session: TerminalSessionRecord;
  surface: TerminalSurface;
  /** Which rule bound the session to the surface. */
  via: "sourceSessionId" | "metadata" | "sessionName";
};

/** Metadata keys a registered record may carry that name the same session. */
const SESSION_REF_METADATA_KEYS = [
  "threadId",
  "externalSessionId",
  "conversationId",
  "runtimeSessionId",
  "sessionId",
] as const;

/**
 * One ref becomes a small set of match candidates. Besides the cleaned ref
 * itself, a leading short `prefix:` token (a harness or `session:` namespace
 * marker, e.g. `claude:abc123`) contributes its suffix, since callers hand over
 * refs in both bare and scoped spellings.
 */
export function sessionRefCandidates(value: string | null | undefined): string[] {
  const trimmed = value?.trim();
  if (!trimmed) return [];
  const leaf = trimmed.split(/[\\/]/u).filter(Boolean).at(-1) ?? trimmed;
  const cleaned = leaf.endsWith(".jsonl") ? leaf.slice(0, -".jsonl".length) : leaf;
  if (!cleaned) return [];

  const candidates = new Set<string>([cleaned]);
  const scoped = /^([A-Za-z][A-Za-z0-9_-]{0,15}):(.+)$/u.exec(cleaned);
  if (scoped?.[2]) {
    candidates.add(scoped[2]);
    if (scoped[1] === "session") {
      const harnessScoped = /^([A-Za-z][A-Za-z0-9_-]{0,15}):(.+)$/u.exec(scoped[2]);
      if (harnessScoped?.[2]) candidates.add(harnessScoped[2]);
    }
  }
  return [...candidates];
}

/** All match candidates for a hints bag, deduplicated, order preserved. */
export function sessionHintCandidates(hints: SessionTerminalHints): string[] {
  const seen = new Set<string>();
  const agentRef = hints.agentId?.trim().split(".", 1)[0];
  if (agentRef?.startsWith("session-")) seen.add(agentRef);
  for (const ref of hints.sessionRefs ?? []) {
    for (const candidate of sessionRefCandidates(ref)) {
      seen.add(candidate);
    }
  }
  return [...seen];
}

/**
 * The surface a hop should land on for a matched record. Session-level beats
 * pane-level (a hop into a multiplexer session wants its own layout, not a
 * pinned pane), and live beats detached or exited.
 */
export function preferredHopSurface(session: TerminalSessionRecord): TerminalSurface | null {
  const surfaces = session.surfaces.filter((surface) => surface.state !== "exited");
  if (surfaces.length === 0) return null;
  return (
    surfaces.find((surface) => !surface.paneId && surface.state === "live")
    ?? surfaces.find((surface) => !surface.paneId)
    ?? surfaces.find((surface) => surface.state === "live")
    ?? surfaces[0]
    ?? null
  );
}

/**
 * Resolve session/agent hints to a live terminal target, or null when nothing
 * provably matches. `sessions` should be the reconciled inventory — registered
 * records plus discovered host sessions (`/api/terminal-sessions` with
 * `includeDiscovered=1`).
 */
export function resolveSessionTerminalSurface(
  sessions: readonly TerminalSessionRecord[],
  hints: SessionTerminalHints,
): SessionTerminalResolution | null {
  const refs = new Set(sessionHintCandidates(hints));
  if (refs.size === 0) return null;

  const canonicalHarness = (value: string) => {
    const normalized = value.trim().toLowerCase().replace(/_/gu, "-");
    const alias = normalized === "claude-code" || normalized === "claude-stream-json" ? "claude"
      : normalized === "codex-app-server" || normalized === "codex-exec" ? "codex"
      : normalized === "pi-rpc" ? "pi"
      : normalized === "agy" || normalized === "google-antigravity" ? "antigravity" : normalized;
    return (AGENT_HARNESSES as readonly string[]).includes(alias) ? alias : null;
  };
  const qualifiedHarnesses = new Set<string>();
  for (const ref of hints.sessionRefs ?? []) {
    const scoped = /^(?:session:)?([^:/\\]+):/u.exec(ref?.trim() ?? "");
    const harness = scoped ? canonicalHarness(scoped[1]!) : null;
    if (harness) qualifiedHarnesses.add(harness);
  }
  // Conflicting scope hints cannot prove one target. Unknown/discovered
  // harnesses are eligible only for unqualified lookups.
  if (qualifiedHarnesses.size > 1) return null;
  const requestedHarness = [...qualifiedHarnesses][0];
  const eligible = sessions.filter((session) => !requestedHarness
    || canonicalHarness(session.harness) === requestedHarness);
  const registered = eligible.filter((session) => session.origin !== "discovered");

  const bySource: SessionTerminalResolution[] = [];
  for (const session of registered) {
    if (!session.sourceSessionId || !refs.has(session.sourceSessionId)) continue;
    const surface = preferredHopSurface(session);
    if (surface) bySource.push({ session, surface, via: "sourceSessionId" });
  }
  if (bySource.length > 0) return bySource.length === 1 ? bySource[0]! : null;

  const byMetadata: SessionTerminalResolution[] = [];
  for (const session of registered) {
    const metadata = session.metadata;
    if (!metadata) continue;
    const matched = SESSION_REF_METADATA_KEYS.some((key) => {
      const value = metadata[key];
      return typeof value === "string" && refs.has(value);
    });
    if (!matched) continue;
    const surface = preferredHopSurface(session);
    if (surface) byMetadata.push({ session, surface, via: "metadata" });
  }
  if (byMetadata.length > 0) return byMetadata.length === 1 ? byMetadata[0]! : null;

  const byName: SessionTerminalResolution[] = [];
  for (const session of eligible) {
    const matches = session.surfaces.filter((candidate) => candidate.state !== "exited" && refs.has(candidate.sessionName));
    const sessionLevel = matches.filter((candidate) => !candidate.paneId);
    const preferred = sessionLevel.length > 0 ? sessionLevel : matches;
    for (const surface of preferred) byName.push({ session, surface, via: "sessionName" });
  }
  return byName.length === 1 ? byName[0]! : null;
}
