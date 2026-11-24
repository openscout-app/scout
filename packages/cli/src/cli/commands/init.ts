import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import {
  DEFAULT_LOCAL_CONFIG,
  loadLocalConfig,
  localConfigExists,
  localConfigPath,
  writeLocalConfig,
  type LocalConfig,
} from "@openscout/runtime/config";

type InitOptions = {
  force: boolean;
  brokerPort: number | null;
  webPort: number | null;
  pairingPort: number | null;
  host: string | null;
  webLocalName: string | null;
};

function parseInitOptions(args: string[]): InitOptions {
  const options: InitOptions = {
    force: false,
    brokerPort: null,
    webPort: null,
    pairingPort: null,
    host: null,
    webLocalName: null,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--force" || arg === "-f") {
      options.force = true;
      continue;
    }
    const [key, inlineValue] = arg.split("=", 2) as [string, string | undefined];
    const value = inlineValue ?? args[i + 1];
    const consumeNext = inlineValue === undefined;
    switch (key) {
      case "--broker-port":
        options.brokerPort = parsePortFlag(key, value);
        if (consumeNext) i += 1;
        break;
      case "--web-port":
        options.webPort = parsePortFlag(key, value);
        if (consumeNext) i += 1;
        break;
      case "--pairing-port":
        options.pairingPort = parsePortFlag(key, value);
        if (consumeNext) i += 1;
        break;
      case "--host":
        if (!value) throw new ScoutCliError(`${key} requires a value`);
        options.host = value;
        if (consumeNext) i += 1;
        break;
      case "--web-local-name":
        if (!value) throw new ScoutCliError(`${key} requires a value`);
        options.webLocalName = value;
        if (consumeNext) i += 1;
        break;
      default:
        throw new ScoutCliError(`unknown option: ${arg}`);
    }
  }

  return options;
}

function parsePortFlag(flag: string, raw: string | undefined): number {
  if (!raw) throw new ScoutCliError(`${flag} requires a value`);
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    throw new ScoutCliError(`${flag}: invalid port ${raw}`);
  }
  return port;
}

export async function runInitCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const options = parseInitOptions(args);
  const path = localConfigPath();
  const existed = localConfigExists();

  if (existed && !options.force) {
    const existing = loadLocalConfig();
    context.output.writeText(
      `Scout local config already exists at ${path}\n` +
        formatConfig(existing) +
        `\nRun \`scout init --force\` to overwrite.\n`,
    );
    return;
  }

  const next: LocalConfig = {
    version: 1,
    host: options.host ?? DEFAULT_LOCAL_CONFIG.host,
    webLocalName: options.webLocalName ?? DEFAULT_LOCAL_CONFIG.webLocalName,
    ports: {
      broker: options.brokerPort ?? DEFAULT_LOCAL_CONFIG.ports.broker,
      web: options.webPort ?? DEFAULT_LOCAL_CONFIG.ports.web,
      pairing: options.pairingPort ?? DEFAULT_LOCAL_CONFIG.ports.pairing,
    },
  };

  writeLocalConfig(next);

  const verb = existed ? "Overwrote" : "Created";
  context.output.writeText(
    `${verb} ${path}\n` + formatConfig(next) + "\n",
  );
}

function formatConfig(config: LocalConfig): string {
  const host = config.host ?? DEFAULT_LOCAL_CONFIG.host;
  const ports = config.ports ?? {};
  return [
    `  host:    ${host}`,
    `  web URL: ${config.webLocalName ?? "(machine hostname under scout.local)"}`,
    `  broker:  ${ports.broker ?? DEFAULT_LOCAL_CONFIG.ports.broker}`,
    `  web:     ${ports.web ?? DEFAULT_LOCAL_CONFIG.ports.web}`,
    `  pairing: ${ports.pairing ?? DEFAULT_LOCAL_CONFIG.ports.pairing}`,
  ].join("\n");
}
