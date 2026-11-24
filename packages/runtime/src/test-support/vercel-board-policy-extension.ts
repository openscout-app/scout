import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findScoutExtension, scoutExtensionDigest } from "../scout-extensions.js";

/**
 * The example external dispatch policy from docs/vercel-board.md: claim for
 * the free agent with the fewest recent claims, read from a counts file next
 * to the command.
 */
export const LEAST_BUSY_POLICY = `#!/usr/bin/env bun
const request = JSON.parse(await Bun.stdin.text());
const counts = JSON.parse(await Bun.file(\`\${import.meta.dir}/counts.json\`).text().catch(() => "{}"));
const [agent] = [...request.state.agents].sort((a, b) => (counts[a.agentId] ?? 0) - (counts[b.agentId] ?? 0));
console.log(JSON.stringify(agent
  ? { result: "claim", agentId: agent.agentId, note: \`fewest recent claims: \${counts[agent.agentId] ?? 0}\` }
  : { result: "skip", reason: "no free agent" }));
`;

/** Install a policy extension under `root` (an OPENSCOUT_EXTENSIONS_HOME) the way `scout extensions install` lays one out. */
export function installPolicyExtension(root: string, name: string, script: string, files: Record<string, string> = {}): { env: NodeJS.ProcessEnv; dir: string; digest: () => string } {
  const dir = join(root, name);
  mkdirSync(join(dir, "bin"), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "extension.json"), JSON.stringify({ api: 1, command: "bin/policy", summary: "Test dispatch policy" }));
  writeFileSync(join(dir, "bin/policy"), script, { mode: 0o700 });
  chmodSync(join(dir, "bin/policy"), 0o700);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, "bin", file), text);
  const env: NodeJS.ProcessEnv = { HOME: root, PATH: process.env.PATH, OPENSCOUT_EXTENSIONS_HOME: root };
  return { env, dir, digest: () => scoutExtensionDigest(findScoutExtension(name, env)!) };
}
