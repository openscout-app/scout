import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveOpenScoutHomeForEnv } from "@openscout/runtime/config";

/**
 * Graceful stop/restart: before the supervised tree comes down, wait for the
 * work it is carrying to finish.
 *
 * Only `waking` and `running` flights block. A `queued` flight has no harness
 * attached yet and the broker re-dispatches it at startup
 * (`recoverQueuedFlights`), so a restart costs it nothing. A running flight is
 * different: its harness is often a child of the broker (a Codex app-server,
 * a background Claude), and bouncing the tree kills the turn mid-flight.
 *
 * The flights table is read straight from SQLite rather than through the
 * broker, because a restart is exactly the tool you reach for when the broker
 * is wedged and not answering HTTP.
 */

export { DEFAULT_DRAIN_TIMEOUT_MS, parseDrainTimeout } from "../../bin/lifecycle-preflight.mjs";
/**
 * A flight still `running` after this long is treated as orphaned — its
 * harness died without the broker hearing. It is reported, but does not hold
 * the restart hostage.
 */
export const DEFAULT_STALE_FLIGHT_MS = 4 * 60 * 60_000;
const DRAIN_POLL_MS = 5_000;

export type ActiveFlight = {
  id: string;
  targetAgentId: string;
  state: string;
  startedAt: number | null;
  summary: string | null;
};

export type FleetDrainState = {
  blocking: ActiveFlight[];
  stale: ActiveFlight[];
};

export type FleetDrainResult = FleetDrainState & {
  idle: boolean;
  waitedMs: number;
};

export function resolveControlPlaneDbPath(env: NodeJS.ProcessEnv): string {
  const explicitPath = env.OPENSCOUT_CONTROL_PLANE_DB?.trim();
  if (explicitPath) return explicitPath;
  const controlHome = env.OPENSCOUT_CONTROL_HOME?.trim()
    || join(resolveOpenScoutHomeForEnv(env), "control-plane");
  return join(controlHome, "control-plane.sqlite");
}

export function readActiveFlights(dbPath: string): ActiveFlight[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    return db.query<{
      id: string;
      target_agent_id: string;
      state: string;
      started_at: number | null;
      summary: string | null;
    }, []>(
      "SELECT id, target_agent_id, state, started_at, summary FROM flights WHERE state IN ('waking', 'running') ORDER BY started_at",
    ).all().map((row) => ({
      id: row.id,
      targetAgentId: row.target_agent_id,
      state: row.state,
      startedAt: row.started_at,
      summary: row.summary,
    }));
  } finally {
    db.close();
  }
}

export function classifyActiveFlights(
  flights: ActiveFlight[],
  now: number,
  staleAfterMs: number = DEFAULT_STALE_FLIGHT_MS,
): FleetDrainState {
  const blocking: ActiveFlight[] = [];
  const stale: ActiveFlight[] = [];
  for (const flight of flights) {
    const age = flight.startedAt === null ? 0 : now - flight.startedAt;
    (age > staleAfterMs ? stale : blocking).push(flight);
  }
  return { blocking, stale };
}

export function describeActiveFlight(flight: ActiveFlight, now: number): string {
  const age = flight.startedAt === null ? "" : ` for ${formatDuration(now - flight.startedAt)}`;
  return `${flight.id} → ${flight.targetAgentId} (${flight.state}${age})`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export async function waitForIdleFleet(options: {
  readFlights: () => ActiveFlight[];
  timeoutMs: number;
  staleAfterMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onWaiting?: (state: FleetDrainState, waitedMs: number) => void;
}): Promise<FleetDrainResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? DRAIN_POLL_MS;
  const startedAt = now();
  let lastBlockingKey = "";

  while (true) {
    const state = classifyActiveFlights(options.readFlights(), now(), options.staleAfterMs);
    const waitedMs = now() - startedAt;
    if (state.blocking.length === 0) {
      return { ...state, idle: true, waitedMs };
    }
    if (waitedMs >= options.timeoutMs) {
      return { ...state, idle: false, waitedMs };
    }
    // Report when the set of blocking flights changes, not on every poll.
    const blockingKey = state.blocking.map((flight) => flight.id).join(",");
    if (blockingKey !== lastBlockingKey) {
      lastBlockingKey = blockingKey;
      options.onWaiting?.(state, waitedMs);
    }
    await sleep(Math.min(pollMs, Math.max(0, options.timeoutMs - waitedMs)));
  }
}
