import { deriveOpenScoutInstanceLayout, selectCliOpenScoutInstance } from "@openscout/runtime/config";

/** Match CLI home selection without claiming an instance, loading settings or starting a service. */
export function scoutDiscoveryEnv(env: NodeJS.ProcessEnv, instance?: string | null): NodeJS.ProcessEnv {
  const selected = { ...env };
  if (instance) selected.OPENSCOUT_INSTANCE = instance;
  const name = selectCliOpenScoutInstance(selected);
  if (name !== "prod") {
    const layout = deriveOpenScoutInstanceLayout({ env: selected, name, home: env.HOME });
    selected.OPENSCOUT_HOME = layout.openscoutHome;
  }
  return selected;
}
