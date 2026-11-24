import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AdapterConfig } from "../../protocol/adapter.js";
import { AcpAdapter } from "../acp/adapter.js";

export function createAdapter(config: AdapterConfig) {
  const options = config.options ?? {};
  const installed = join(homedir(), ".local", "bin", "agy");
  return new AcpAdapter({
    ...config,
    options: {
      ...options,
      adapterType: "antigravity-acp",
      command: options.command ?? (existsSync(installed) ? installed : "agy"),
      args: options.args ?? ["acp", "--stdio"],
      // Antigravity uses the interactive CLI's cached Google sign-in.
      authMethodPreference: [],
      requireAuth: false,
    },
  });
}
