import type { RuntimeEnv } from "./portable-types.js";
import { buildUserSpawnEnvironment } from "./instance.js";
type ManagedAgentEnvironmentOptions = {
  agentName: string;
  currentDirectory: string;
  crewRole?: string;
};

function managedAgentEnvironmentEntries(
  options: ManagedAgentEnvironmentOptions,
): Array<[key: string, value: string]> {
  const agentName = options.agentName.trim();
  const currentDirectory = options.currentDirectory.trim();
  const crewRole = options.crewRole?.trim() ?? "";
  const entries: Array<[key: string, value: string]> = [
    ["OPENSCOUT_AGENT", agentName],
    ["OPENSCOUT_SETUP_CWD", currentDirectory],
    ["OPENSCOUT_MANAGED_AGENT", "1"],
    ...(crewRole ? [["OPENSCOUT_CREW_ROLE", crewRole] as [string, string]] : []),
  ];

  return entries.filter(([, value]) => value.length > 0);
}

export function buildManagedAgentEnvironment(
  options: ManagedAgentEnvironmentOptions & {
    baseEnv?: RuntimeEnv;
  },
): RuntimeEnv {
  // Agents are user-facing spawns: no instance-derived env, only the client
  // pointer to the broker that launched them (OPENSCOUT_CLIENT_INSTANCE).
  const env: RuntimeEnv = buildUserSpawnEnvironment(options.baseEnv ?? process.env);

  for (const [key, value] of managedAgentEnvironmentEntries(options)) {
    env[key] = value;
  }

  return env;
}

export function buildManagedAgentShellExports(
  options: ManagedAgentEnvironmentOptions,
): string[] {
  return managedAgentEnvironmentEntries(options)
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`);
}
