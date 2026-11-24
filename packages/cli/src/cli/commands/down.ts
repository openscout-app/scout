import { resolveLocalAgentByName } from "@openscout/runtime/harnesses";

import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { downAllScoutAgents, downScoutAgent } from "../../lib/core/agents/service.ts";
import { renderScoutAgentStatusList, renderScoutDownResult } from "../../lib/ui/terminal/agents.ts";

export async function runDownCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const [target, ...rest] = args;
  if (!target || rest.length > 0) {
    throw new ScoutCliError("usage: scout down <name|--all>");
  }

  if (target === "--all") {
    const stopped = await downAllScoutAgents({
      currentDirectory: defaultScoutContextDirectory(context),
    });
    context.output.writeValue(stopped, renderScoutAgentStatusList);
    return;
  }

  // Try direct agentId first, fall back to short name resolution
  let agent = await downScoutAgent(target);
  if (!agent) {
    const resolved = await resolveLocalAgentByName(target);
    const projectMatch = resolved ?? await resolveLocalAgentByName(target, {
      matchProjectName: true,
    });
    if (projectMatch) {
      agent = await downScoutAgent(projectMatch.agentId);
    }
  }

  context.output.writeValue(agent, renderScoutDownResult);
}
