import type { CrewWhoAmISummary } from "@openscout/protocol";
import {
  buildCrewWhoAmISummary,
  checkCrewState,
  createLocalCrewReachabilityChecker,
  loadCrewState,
  resolveCrewRoleForAsk,
  type CrewHostAvailability,
  type CrewReachabilityChecker,
  type CrewRoleAskResolution,
  type LoadedCrewState,
} from "@openscout/runtime/crew";

import { loadScoutMeshOverview, type ScoutMeshOverview } from "../mesh/overview.ts";

export function createCliCrewReachabilityChecker(options: {
  env?: NodeJS.ProcessEnv;
  loadMeshOverview?: (machine?: string) => Promise<ScoutMeshOverview>;
  hostTimeoutMs?: number;
} = {}): CrewReachabilityChecker {
  const meshLoader = options.loadMeshOverview ?? ((machine?: string) => loadScoutMeshOverview(machine ? { machine } : {}));
  const hostTimeoutMs = options.hostTimeoutMs ?? 2_000;
  const hostCache = new Map<string, Promise<CrewHostAvailability>>();

  const checkHost = (host: string): Promise<CrewHostAvailability> => {
    const key = host.trim().toLowerCase();
    const cached = hostCache.get(key);
    if (cached) return cached;

    const pending = (async (): Promise<CrewHostAvailability> => {
      try {
        const overview = await Promise.race([
          meshLoader(host),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), hostTimeoutMs)),
        ]);
        if (!overview) {
          return {
            host,
            reachable: false,
            detail: `mesh host "${host}" did not answer within ${hostTimeoutMs}ms`,
          };
        }
        const match = overview.machines.find(
          (machine) => machine.host.toLowerCase() === key
            || machine.nodeId.toLowerCase() === key
            || machine.nodeName?.toLowerCase() === key,
        );
        if (!match) {
          return {
            host,
            reachable: false,
            detail: `mesh host "${host}" is not registered on this mesh`,
          };
        }
        if (match.reach !== "answering") {
          return {
            host,
            reachable: false,
            local: match.local,
            detail: `mesh host "${match.host}" did not answer (${match.error})`,
          };
        }
        return {
          host,
          reachable: true,
          local: match.local,
          detail: match.local
            ? `local host "${match.host}" is reachable`
            : `mesh host "${match.host}" answered`,
        };
      } catch (error) {
        return {
          host,
          reachable: false,
          detail: `mesh host "${host}" reachability check failed (${error instanceof Error ? error.message : String(error)})`,
        };
      }
    })();

    hostCache.set(key, pending);
    return pending;
  };

  return createLocalCrewReachabilityChecker({
    env: options.env,
    checkHost,
  });
}

export async function resolveCliCrewRoleForAsk(
  role: string,
  options: {
    currentDirectory?: string;
    projectRoot?: string | null;
    env?: NodeJS.ProcessEnv;
    checker?: CrewReachabilityChecker;
    loadMeshOverview?: (machine?: string) => Promise<ScoutMeshOverview>;
  } = {},
): Promise<CrewRoleAskResolution> {
  const checker = options.checker ?? createCliCrewReachabilityChecker({
    env: options.env,
    loadMeshOverview: options.loadMeshOverview,
  });
  return resolveCrewRoleForAsk(role, {
    currentDirectory: options.currentDirectory,
    projectRoot: options.projectRoot,
    env: options.env,
    checker,
  });
}

export async function loadCliCrewWhoAmISummary(options: {
  currentDirectory?: string;
  projectRoot?: string | null;
  env?: NodeJS.ProcessEnv;
  activeRole?: string | null;
  checker?: CrewReachabilityChecker;
  loadMeshOverview?: (machine?: string) => Promise<ScoutMeshOverview>;
  state?: LoadedCrewState;
} = {}): Promise<CrewWhoAmISummary | null> {
  const env = options.env ?? process.env;
  const activeRole = options.activeRole !== undefined
    ? options.activeRole
    : env.OPENSCOUT_CREW_ROLE?.trim() || null;

  const state = options.state ?? loadCrewState({
    currentDirectory: options.currentDirectory,
    projectRoot: options.projectRoot,
    env,
  });

  if (Object.keys(state.roles).length === 0 && !activeRole) {
    return null;
  }

  const checker = options.checker ?? createCliCrewReachabilityChecker({
    env,
    loadMeshOverview: options.loadMeshOverview,
  });
  const check = await checkCrewState(state, checker);
  return buildCrewWhoAmISummary({ state, check, activeRole });
}
