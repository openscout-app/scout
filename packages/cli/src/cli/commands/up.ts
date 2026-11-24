import { parseUpCommandOptions, UP_HELP } from "../../../bin/lifecycle-preflight.mjs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { resolveLocalAgentByName } from "@openscout/runtime/harnesses";

import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { parseScoutLocalHarness } from "../../lib/core/broker/service.ts";
import { upScoutAgent } from "../../lib/core/agents/service.ts";
import { renderScoutUpResult } from "../../lib/ui/terminal/agents.ts";

function looksLikePath(value: string): boolean {
  return value.includes("/") || value.startsWith(".") || value.startsWith("~");
}

export async function runUpCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    context.output.writeText(UP_HELP);
    return;
  }
  let options;
  try { options = parseUpCommandOptions(args); }
  catch (error) { throw new ScoutCliError((error as Error).message); }
  const { target, harness, model, provider, reasoningEffort, permissionProfile } = options;
  let { agentName } = options;

  let projectPath: string;

  if (looksLikePath(target) || existsSync(resolve(target))) {
    projectPath = resolve(target);
  } else {
    const resolved = await resolveLocalAgentByName(target);
    if (!resolved) {
      const projectMatch = await resolveLocalAgentByName(target, { matchProjectName: true });
      if (projectMatch) {
        throw new ScoutCliError(
          `unknown agent "${target}" — that matches project "${projectMatch.projectRoot}", `
            + `but the registered agent is "${projectMatch.agentId}". `
            + `Use \`scout up ${projectMatch.agentId}\` or \`scout up "${projectMatch.projectRoot}"\`.`,
        );
      }
      throw new ScoutCliError(`unknown agent "${target}" — not a registered agent name or valid path`);
    }
    projectPath = resolved.projectRoot;
    agentName ??= resolved.definitionId;
  }

  const agent = await upScoutAgent({
    projectPath,
    agentName,
    harness: parseScoutLocalHarness(harness),
    model,
    provider,
    reasoningEffort,
    permissionProfile,
    currentDirectory: defaultScoutContextDirectory(context),
  });

  context.output.writeValue(agent, renderScoutUpResult);
}
