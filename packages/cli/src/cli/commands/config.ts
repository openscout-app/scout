import {
  createSettingsService,
  defaultProvisionalAgentNamesPath,
  describeProvisionalAgentNamePool,
  findUserConfigField,
  formatProvisionalAgentNamePoolSource,
  formatUserConfigFieldGet,
  formatUserConfigSetMessage,
  formatUserConfigUsageLines,
  listUserConfigFieldIds,
  listUserConfigSummaryLines,
  loadUserConfig,
  operatorCliActor,
  parseUserConfigFieldValue,
  resolveProvisionalAgentNamePool,
  saveUserConfig,
  seedProvisionalAgentNamesInUserConfig,
  writeProvisionalAgentNamesFile,
} from "@openscout/runtime";
import "./profile-hooks.ts";
import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";

async function runAgentNamesConfig(args: string[]): Promise<void> {
  const [action, ...rest] = args;

  if (!action || action === "show") {
    const config = loadUserConfig();
    const resolved = resolveProvisionalAgentNamePool(config);
    console.log(`agent-names: ${describeProvisionalAgentNamePool(config)}`);
    console.log(`source: ${formatProvisionalAgentNamePoolSource(resolved)}`);
    console.log(`drop-in path: ${defaultProvisionalAgentNamesPath()}`);
    if (resolved.names.length > 0) {
      console.log(`preview: ${resolved.names.slice(0, 12).join(", ")}${resolved.names.length > 12 ? ", …" : ""}`);
    }
    return;
  }

  if (action === "init") {
    const empty = rest.includes("--empty");
    const mode = rest.includes("--extend") ? "extend" : "replace";
    const config = seedProvisionalAgentNamesInUserConfig({ empty, mode });
    saveUserConfig(config);
    console.log(`Saved ${config.provisionalAgentNames?.length ?? 0} names to Scout settings (user.json)`);
    console.log(`mode: ${config.provisionalAgentNamesMode}`);
    console.log(empty
      ? "Edit with: scout config set agent-names ada,grace,linus"
      : "Trim or extend the list in settings, or switch mode with: scout config set agent-names-mode extend");
    return;
  }

  console.error("usage: scout config agent-names [show]");
  console.error("       scout config agent-names init [--empty] [--extend]");
  process.exit(1);
}

function printUsage(): never {
  for (const line of formatUserConfigUsageLines()) {
    console.error(line);
  }
  process.exit(1);
}

export async function runConfigCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const [subcommand, id, ...rest] = args;

  if (subcommand === "agent-names") {
    await runAgentNamesConfig(rest);
    return;
  }

  if (subcommand === "list") {
    for (const fieldId of listUserConfigFieldIds()) {
      console.log(fieldId);
    }
    return;
  }

  if (subcommand === "set" && id === "agent-names-init-file") {
    const empty = rest.includes("--empty");
    const path = writeProvisionalAgentNamesFile({ empty });
    console.log(`Wrote JSON name pool to ${path}`);
    console.log("Advanced override only — prefer scout config agent-names init for Scout settings.");
    return;
  }

  const field = id ? findUserConfigField(id) : undefined;

  if (subcommand === "set" && field) {
    let value: unknown;
    try {
      value = rest.length > 0 ? parseUserConfigFieldValue(field, rest) : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exit(1);
    }

    // `scout config set` is the profile part of `scout settings`: the same
    // service validates the value, writes it, and records it in the change log.
    try {
      await createSettingsService().set(field.id, value ?? null, {
        actor: operatorCliActor("scout config"),
        context: { currentDirectory: defaultScoutContextDirectory(context) },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exit(1);
    }
    console.log(formatUserConfigSetMessage(field, value));
    return;
  }

  if (subcommand === "get" && field) {
    console.log(formatUserConfigFieldGet(field, loadUserConfig()));
    return;
  }

  if (!subcommand || subcommand === "show") {
    for (const line of listUserConfigSummaryLines(loadUserConfig())) {
      console.log(line);
    }
    return;
  }

  if ((subcommand === "set" || subcommand === "get") && id && !field) {
    console.error(`unknown config id: ${id}`);
    console.error(`known ids: ${listUserConfigFieldIds().join(", ")}`);
    process.exit(1);
  }

  printUsage();
}