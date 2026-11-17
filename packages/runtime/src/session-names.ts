import {
  isWorkItemTerminalState,
  normalizeSessionName,
  resolveSessionName,
  SessionNameError,
  type AgentEndpoint,
  type CollaborationRecord,
  type NodeDefinition,
  type ObservedSessionInventory,
  type SessionNameDerivation,
  type SessionNameRecord,
  type SessionNameResolution,
  type SessionNameSetRequest,
  type SessionNameSetResult,
  type WorkItemRecord,
} from "@openscout/protocol";

import { observedHarness } from "./broker-observed-sessions-read.js";
import { endpointMatchesTargetSessionAddress } from "./runtime-session-address.js";
import type { ControlPlaneSqliteTransactionalDatabase } from "./sqlite-adapter.js";
import type { DiscoveredTranscript } from "./tail/types.js";

export { SessionNameError };

/** Why a set request failed, so the HTTP layer can pick a status. */
export class SessionNameTargetError extends SessionNameError {
  constructor(
    message: string,
    readonly code: "invalid_session_name" | "session_not_found" | "ambiguous_session",
    readonly candidates: Array<{ harness: string; nativeSessionId: string }> = [],
  ) {
    super(message);
  }
}

type SessionNameRow = {
  harness: string;
  native_session_id: string;
  name: string;
  set_by_actor_id: string;
  created_at: number;
  updated_at: number;
};

const sessionKey = (harness: string, nativeSessionId: string) => `${harness}\u0000${nativeSessionId}`;

function fromRow(row: SessionNameRow): SessionNameRecord {
  return {
    harness: row.harness,
    nativeSessionId: row.native_session_id,
    name: row.name,
    setByActorId: row.set_by_actor_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f]/u.test(value);

/** SQLite rows behind operator session names (`session_names`). */
export class SessionNameStore {
  private cache: Map<string, SessionNameRecord> | null = null;

  constructor(private readonly database: ControlPlaneSqliteTransactionalDatabase) {}

  private load(): Map<string, SessionNameRecord> {
    if (!this.cache) {
      const rows = this.database.query<SessionNameRow>(
        "SELECT * FROM session_names ORDER BY updated_at DESC",
      ).all();
      this.cache = new Map(rows.map((row) => [sessionKey(row.harness, row.native_session_id), fromRow(row)]));
    }
    return this.cache;
  }

  list(): SessionNameRecord[] {
    return [...this.load().values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  get(harness: string, nativeSessionId: string): SessionNameRecord | null {
    return this.load().get(sessionKey(harness, nativeSessionId)) ?? null;
  }

  upsert(record: SessionNameRecord): void {
    this.database.query(`
      INSERT INTO session_names (harness, native_session_id, name, set_by_actor_id, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT (harness, native_session_id) DO UPDATE SET
        name = excluded.name,
        set_by_actor_id = excluded.set_by_actor_id,
        updated_at = excluded.updated_at
    `).run(record.harness, record.nativeSessionId, record.name, record.setByActorId, record.createdAt, record.updatedAt);
    this.load().set(sessionKey(record.harness, record.nativeSessionId), record);
  }

  delete(harness: string, nativeSessionId: string): boolean {
    const existed = this.load().has(sessionKey(harness, nativeSessionId));
    this.database.query(
      "DELETE FROM session_names WHERE harness = ?1 AND native_session_id = ?2",
    ).run(harness, nativeSessionId);
    this.load().delete(sessionKey(harness, nativeSessionId));
    return existed;
  }
}

export type SessionNameServiceOptions = {
  store: SessionNameStore;
  nodeId: string;
  operatorActorId: string;
  /** Broker registry, read-only: endpoints, nodes and collaboration records. */
  registry: () => Readonly<{
    endpoints: Record<string, AgentEndpoint>;
    nodes: Record<string, NodeDefinition>;
    collaborationRecords: Record<string, CollaborationRecord>;
  }>;
  /** Cached harness transcripts (tail discovery); never forces a scan. */
  transcripts: () => readonly DiscoveredTranscript[];
  now?: () => number;
};

/** The work states that mean the owner is doing the work now. */
const CURRENT_WORK_STATES = new Set<WorkItemRecord["state"]>(["working", "waiting", "review"]);

/** Every native session id an endpoint answers to (resumed sessions keep the harness id in metadata). */
function endpointNativeIds(endpoint: AgentEndpoint): string[] {
  return [...new Set([
    endpoint.metadata?.nativeSessionId,
    endpoint.metadata?.externalSessionId,
    endpoint.sessionId,
  ].filter(validId))];
}

/**
 * Derived names: a session takes the title of the current work item owned by
 * an agent that points at that session and at no other. An agent with several
 * sessions cannot say which one is doing the work, so it names none of them.
 */
export function deriveSessionWorkTitles(input: {
  nodeId: string;
  endpoints: Record<string, AgentEndpoint>;
  collaborationRecords: Record<string, CollaborationRecord>;
}): Map<string, { name: string; from: SessionNameDerivation }> {
  const sessionsByAgent = new Map<string, Set<string>>();
  for (const id in input.endpoints) {
    if (!Object.hasOwn(input.endpoints, id)) continue;
    const endpoint = input.endpoints[id]!;
    if (endpoint.nodeId !== input.nodeId || !validId(endpoint.agentId) || !validId(endpoint.harness)) continue;
    const harness = observedHarness(endpoint.harness);
    // All ids of one endpoint name the same session; the harness's own id counts it once.
    const nativeIds = endpointNativeIds(endpoint);
    if (nativeIds.length === 0) continue;
    const keys = sessionsByAgent.get(endpoint.agentId) ?? new Set<string>();
    keys.add(sessionKey(harness, nativeIds[0]!));
    sessionsByAgent.set(endpoint.agentId, keys);
  }
  const workByAgent = new Map<string, WorkItemRecord>();
  for (const id in input.collaborationRecords) {
    if (!Object.hasOwn(input.collaborationRecords, id)) continue;
    const record = input.collaborationRecords[id]!;
    if (record.kind !== "work_item" || !record.ownerId || isWorkItemTerminalState(record.state)) continue;
    if (!CURRENT_WORK_STATES.has(record.state) || !record.title?.trim()) continue;
    const prior = workByAgent.get(record.ownerId);
    if (!prior || record.updatedAt > prior.updatedAt) workByAgent.set(record.ownerId, record);
  }
  const titles = new Map<string, { name: string; from: SessionNameDerivation; updatedAt: number }>();
  for (const [agentId, work] of workByAgent) {
    const sessions = sessionsByAgent.get(agentId);
    if (!sessions || sessions.size !== 1) continue;
    const name = normalizeDerived(work.title);
    if (!name) continue;
    // Every id the agent's endpoints answer to resolves to this name.
    for (const endpoint of Object.values(input.endpoints)) {
      if (endpoint.agentId !== agentId || endpoint.nodeId !== input.nodeId || !validId(endpoint.harness)) continue;
      const harness = observedHarness(endpoint.harness);
      for (const nativeId of endpointNativeIds(endpoint)) {
        const key = sessionKey(harness, nativeId);
        const prior = titles.get(key);
        if (!prior || work.updatedAt > prior.updatedAt) {
          titles.set(key, { name, from: { kind: "work_item", id: work.id, agentId }, updatedAt: work.updatedAt });
        }
      }
    }
  }
  return new Map([...titles].map(([key, value]) => [key, { name: value.name, from: value.from }]));
}

function normalizeDerived(title: string): string | null {
  try {
    return normalizeSessionName(title.slice(0, 400))?.slice(0, 120) ?? null;
  } catch {
    return null;
  }
}

export class SessionNameService {
  private readonly now: () => number;

  constructor(private readonly options: SessionNameServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  list(): SessionNameRecord[] {
    return this.options.store.list();
  }

  /** A resolver for many sessions at once; build it once per read. */
  resolver(): (harness: string, nativeSessionId: string, harnessTitle: string | null | undefined) => SessionNameResolution {
    const registry = this.options.registry();
    const derived = deriveSessionWorkTitles({
      nodeId: this.options.nodeId,
      endpoints: registry.endpoints,
      collaborationRecords: registry.collaborationRecords,
    });
    return (harness, nativeSessionId, harnessTitle) => {
      const normalized = observedHarness(harness);
      const work = derived.get(sessionKey(normalized, nativeSessionId));
      return resolveSessionName({
        operatorName: this.options.store.get(normalized, nativeSessionId)?.name ?? null,
        derivedName: work?.name ?? null,
        derivedFrom: work?.from ?? null,
        harnessTitle: harnessTitle ?? null,
      });
    };
  }

  /**
   * Names for broker endpoints: the operator's name or the current work title
   * of the session the endpoint answers to, or null to keep its own label.
   */
  endpointNamer(): (endpoint: AgentEndpoint) => string | null {
    const resolve = this.resolver();
    return (endpoint) => {
      if (!validId(endpoint.harness)) return null;
      for (const nativeId of endpointNativeIds(endpoint)) {
        const resolution = resolve(endpoint.harness, nativeId, null);
        if (resolution.source === "operator" || resolution.source === "work") return resolution.name;
      }
      return null;
    };
  }

  /** Tail discovery rows: `title` becomes the resolved name, the harness's own stays in `harnessTitle`. */
  applyToTranscripts<T extends DiscoveredTranscript>(transcripts: readonly T[]): T[] {
    const resolve = this.resolver();
    return transcripts.map((transcript) => {
      if (!validId(transcript.sessionId) || !validId(transcript.source)) return transcript;
      const resolution = resolve(transcript.source, transcript.sessionId, transcript.title);
      if (resolution.source !== "operator" && resolution.source !== "work") {
        return { ...transcript, harnessTitle: transcript.title ?? null, sessionName: null, sessionNameSource: null };
      }
      return {
        ...transcript,
        title: resolution.name,
        harnessTitle: transcript.title ?? null,
        sessionName: resolution.name,
        sessionNameSource: resolution.source,
      };
    });
  }

  applyToObservedInventory(inventory: ObservedSessionInventory): ObservedSessionInventory {
    const resolve = this.resolver();
    return {
      ...inventory,
      sessions: inventory.sessions.map((row) => {
        const resolution = resolve(row.identity.harness, row.identity.nativeSessionId, row.harnessTitle);
        return { ...row, title: resolution.name?.slice(0, 512) ?? null, titleSource: resolution.source };
      }),
    };
  }

  /** Resolves a selector to exactly one (harness, native session id), or throws. */
  resolveTarget(request: Pick<SessionNameSetRequest, "selector" | "harness" | "nativeSessionId">): { harness: string; nativeSessionId: string } {
    const harness = request.harness?.trim() ? observedHarness(request.harness.trim()) : null;
    const nativeSessionId = request.nativeSessionId?.trim() || null;
    if (harness && !validId(harness)) throw new SessionNameTargetError("invalid harness", "invalid_session_name");
    if (nativeSessionId) {
      if (!validId(nativeSessionId)) throw new SessionNameTargetError("invalid native session id", "invalid_session_name");
      if (harness) return { harness, nativeSessionId };
    }
    const selector = (request.selector?.trim() || nativeSessionId || "").replace(/^@+/u, "");
    if (!validId(selector)) {
      throw new SessionNameTargetError(
        "name a session: a native session id, <harness>:<id>, an agent id, or a session address",
        "invalid_session_name",
      );
    }
    const registry = this.options.registry();
    const transcripts = this.options.transcripts();
    const observed = new Set(
      transcripts
        .filter((transcript) => validId(transcript.sessionId) && validId(transcript.source))
        .map((transcript) => sessionKey(observedHarness(transcript.source), transcript.sessionId!)),
    );
    const candidates = new Map<string, { harness: string; nativeSessionId: string }>();
    const add = (candidateHarness: string, id: string) => {
      const normalized = observedHarness(candidateHarness);
      if (harness && normalized !== harness) return;
      candidates.set(sessionKey(normalized, id), { harness: normalized, nativeSessionId: id });
    };

    // <harness>:<id>, when the prefix is a harness this node knows.
    const prefixed = /^([a-z][a-z0-9-]*):(.+)$/u.exec(selector);
    const knownHarnesses = new Set([
      ...transcripts.map((transcript) => observedHarness(transcript.source)),
      ...Object.values(registry.endpoints).map((endpoint) => observedHarness(endpoint.harness)),
      "claude", "codex", "pi",
    ]);
    if (prefixed && prefixed[1] !== "session" && knownHarnesses.has(observedHarness(prefixed[1]!))) {
      if (!harness || observedHarness(prefixed[1]!) === harness) {
        return { harness: observedHarness(prefixed[1]!), nativeSessionId: prefixed[2]! };
      }
    }
    const bare = selector.replace(/^session:/u, "");

    for (const transcript of transcripts) {
      if (transcript.sessionId === bare && validId(transcript.source)) add(transcript.source, bare);
    }
    for (const endpoint of Object.values(registry.endpoints)) {
      if (endpoint.nodeId !== this.options.nodeId || !validId(endpoint.harness)) continue;
      const matches = endpoint.agentId === bare
        || endpoint.id === bare
        || endpointMatchesTargetSessionAddress(registry, endpoint, selector);
      if (!matches) continue;
      const nativeIds = endpointNativeIds(endpoint);
      const endpointHarness = observedHarness(endpoint.harness);
      // Prefer the id the harness's transcript uses; otherwise the harness's own id.
      const chosen = nativeIds.find((id) => observed.has(sessionKey(endpointHarness, id))) ?? nativeIds[0];
      if (chosen) add(endpoint.harness, chosen);
    }
    if (candidates.size === 0 && harness) {
      // An exact harness plus id names a session even before Scout has observed it.
      return { harness, nativeSessionId: bare };
    }
    if (candidates.size === 0) {
      throw new SessionNameTargetError(
        `no session on this node matches ${selector}. Pass --harness <name> with a native session id to name a session Scout has not observed yet.`,
        "session_not_found",
      );
    }
    if (candidates.size > 1) {
      throw new SessionNameTargetError(
        `${selector} matches ${candidates.size} sessions; pass --harness or use <harness>:<id>`,
        "ambiguous_session",
        [...candidates.values()],
      );
    }
    return [...candidates.values()][0]!;
  }

  set(request: SessionNameSetRequest): SessionNameSetResult {
    let name: string | null;
    try {
      name = normalizeSessionName(request.name);
    } catch (error) {
      throw new SessionNameTargetError(error instanceof Error ? error.message : String(error), "invalid_session_name");
    }
    const target = this.resolveTarget(request);
    const existing = this.options.store.get(target.harness, target.nativeSessionId);
    let action: SessionNameSetResult["action"];
    let record: SessionNameRecord | null;
    if (name === null) {
      action = this.options.store.delete(target.harness, target.nativeSessionId) ? "cleared" : "unchanged";
      record = null;
    } else if (existing?.name === name) {
      action = "unchanged";
      record = existing;
    } else {
      const now = this.now();
      record = {
        harness: target.harness,
        nativeSessionId: target.nativeSessionId,
        name,
        setByActorId: request.actorId?.trim() || this.options.operatorActorId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      this.options.store.upsert(record);
      action = "set";
    }
    const harnessTitle = this.options.transcripts()
      .find((transcript) => transcript.sessionId === target.nativeSessionId
        && validId(transcript.source) && observedHarness(transcript.source) === target.harness)?.title ?? null;
    return {
      ok: true,
      action,
      session: target,
      record,
      resolution: this.resolver()(target.harness, target.nativeSessionId, harnessTitle),
    };
  }
}
