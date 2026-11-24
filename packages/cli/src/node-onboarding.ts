import { APP_READINESS_UNCHECKED, assessScoutSetupCompletion, loadScoutCoreReport } from "./lib/core/setup/readiness.ts";
import { parseSetupCommandOptions, parseScoutArgv, preflightLifecycle, QUICK_LINKS, SETUP_HELP } from "../bin/lifecycle-preflight.mjs";
import {
  brokerServiceStatus,
  type BrokerServiceStatus,
} from "@openscout/runtime/daemon";
import { loadHarnessCatalogSnapshot } from "@openscout/runtime/harness-catalog";
import {
  DEFAULT_LOCAL_CONFIG,
  loadLocalConfig,
  localConfigExists,
  localConfigPath,
  writeLocalConfig,
  type LocalConfig,
  resolveOpenScoutSupportPaths,
  resolveOperatorName,
} from "@openscout/runtime/config";
import {
  loadOpenScoutOnboardingState,
  markOpenScoutOnboardingCommand,
  runOpenScoutOnboardingSetup,
  saveOpenScoutOnboardingIdentity,
} from "@openscout/runtime/setup";
import {
  SCOUT_RUNTIME_CATALOG,
  parseScoutRuntimeCatalog,
  resolveScoutBrokerUrl,
  scoutBrokerPaths,
  scoutRuntimeDefaultHarness,
  scoutRuntimeDefaultModel,
  scoutRuntimeDefaultReasoningEffort,
  scoutRuntimeDefaultsByHarness,
  scoutRuntimeEffortCatalog,
  scoutRuntimeModelCatalog,
  type ScoutOwnedRuntimeCatalog,
  type ScoutRuntimeCapabilityCatalog,
} from "@openscout/runtime";
import { resolve } from "node:path";

type JsonMode = "plain" | "json";

type SetupOptions = {
  currentDirectory: string;
  sourceRoots: string[];
  defaultHarness: string | null;
  output: JsonMode;
};

type DoctorOptions = {
  currentDirectory: string;
  output: JsonMode;
  fix: boolean;
  yes: boolean;
};

type InitOptions = {
  force: boolean;
  brokerPort: number | null;
  webPort: number | null;
  pairingPort: number | null;
  host: string | null;
  webLocalName: string | null;
};

process.env.OPENSCOUT_RUNTIME_HOST ??= "node";

const input = parseScoutArgv(process.argv.slice(2));
const args = [input.command ?? "help", ...input.args, ...(input.outputMode === "json" ? ["--json"] : [])];
const command = args[0];

try {
  const help = preflightLifecycle(process.argv.slice(2), process.cwd(), { runtimeHost: "node" });
  if (help !== null) { console.log(help); }
  else if (input.helpRequested) { writeHelp(); }
  else switch (command) {
    case "--help":
    case "-h":
    case "help":
      writeHelp();
      break;
    case "init":
      runInitCommand(args.slice(1));
      break;
    case "config":
      await runConfigCommand(args.slice(1));
      break;
    case "setup":
      await runSetupCommand(args.slice(1));
      break;
    case "doctor":
      await runDoctorCommand(args.slice(1));
      break;
    case "runtimes":
      await runRuntimesCommand(args.slice(1));
      break;
    case "service":
      await runServiceCommand(args.slice(1));
      break;
    default:
      throw new Error(
        `Unsupported in the Node headless CLI: ${command}\n`
        + "Use Bun for the full interactive Scout CLI, or use one of: init, config, setup, doctor, runtimes, service status.",
      );
  }
} catch (error) {
  process.stderr.write(`${formatError(error)}\n`);
  process.exitCode = 1;
}

function writeHelp(): void {
  const version = process.env.SCOUT_APP_VERSION?.trim();
  process.stdout.write(`${version ? `Scout ${version}` : "Scout"} headless CLI

Usage:
  scout <command> [options]

Node-safe onboarding commands:
  scout init [--force]
  scout config set name <name>
  scout setup [--source-root <path>] [--default-harness <name>]
  scout doctor [--json]
  scout runtimes [--json]
  scout service status [--json]

Run the headless broker in the foreground with:
  openscout-runtime broker

The full interactive CLI still uses Bun for commands that depend on the desktop,
web server, native macOS service, or pairing runtimes.

${QUICK_LINKS}
`);
}

function parseOutput(args: string[]): { output: JsonMode; rest: string[] } {
  let output: JsonMode = "plain";
  const rest: string[] = [];
  for (const arg of args) {
    if (arg === "--json") {
      output = "json";
      continue;
    }
    rest.push(arg);
  }
  return { output, rest };
}

function parseContextRoot(args: string[], defaultCurrentDirectory = process.cwd()): {
  currentDirectory: string;
  rest: string[];
} {
  let currentDirectory = defaultCurrentDirectory;
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--context-root" || arg.startsWith("--context-root=")) {
      const parsed = parseFlagValue(args, index, "--context-root");
      currentDirectory = resolve(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    rest.push(arg);
  }
  return { currentDirectory, rest };
}

function parseSetupOptions(args: string[]): SetupOptions {
  const { output, rest } = parseOutput(args);
  return { ...parseSetupCommandOptions(rest, process.cwd()), output };
}

function parseDoctorOptions(args: string[]): DoctorOptions {
  const { output, rest } = parseOutput(args);
  const parsed = parseContextRoot(rest);
  let fix = false;
  let yes = false;
  for (const arg of parsed.rest) {
    if (arg === "--fix") {
      fix = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      yes = true;
      continue;
    }
    throw new Error(`unexpected arguments for doctor: ${parsed.rest.join(" ")}`);
  }
  if (yes && !fix) {
    throw new Error("--yes requires --fix");
  }
  return {
    currentDirectory: parsed.currentDirectory,
    output,
    fix,
    yes,
  };
}

function parseInitOptions(args: string[]): InitOptions {
  const options: InitOptions = {
    force: false,
    brokerPort: null,
    webPort: null,
    pairingPort: null,
    host: null,
    webLocalName: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--force" || arg === "-f") {
      options.force = true;
      continue;
    }
    if (arg === "--broker-port" || arg.startsWith("--broker-port=")) {
      const value = parseFlagValue(args, index, "--broker-port");
      options.brokerPort = parsePort(value.value, "--broker-port");
      index = value.nextIndex;
      continue;
    }
    if (arg === "--web-port" || arg.startsWith("--web-port=")) {
      const value = parseFlagValue(args, index, "--web-port");
      options.webPort = parsePort(value.value, "--web-port");
      index = value.nextIndex;
      continue;
    }
    if (arg === "--pairing-port" || arg.startsWith("--pairing-port=")) {
      const value = parseFlagValue(args, index, "--pairing-port");
      options.pairingPort = parsePort(value.value, "--pairing-port");
      index = value.nextIndex;
      continue;
    }
    if (arg === "--host" || arg.startsWith("--host=")) {
      const value = parseFlagValue(args, index, "--host");
      options.host = value.value;
      index = value.nextIndex;
      continue;
    }
    if (arg === "--web-local-name" || arg.startsWith("--web-local-name=")) {
      const value = parseFlagValue(args, index, "--web-local-name");
      options.webLocalName = value.value;
      index = value.nextIndex;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  return options;
}

function parseFlagValue(args: string[], index: number, flag: string): { value: string; nextIndex: number } {
  const current = args[index] ?? "";
  if (current === flag) {
    const value = args[index + 1];
    if (!value) {
      throw new Error(`missing value for ${flag}`);
    }
    return { value, nextIndex: index + 1 };
  }
  const prefix = `${flag}=`;
  if (current.startsWith(prefix)) {
    const value = current.slice(prefix.length);
    if (!value) {
      throw new Error(`missing value for ${flag}`);
    }
    return { value, nextIndex: index };
  }
  throw new Error(`missing value for ${flag}`);
}

function parsePort(value: string, flag: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    throw new Error(`${flag}: invalid port ${value}`);
  }
  return port;
}

function runInitCommand(args: string[]): void {
  const options = parseInitOptions(args);
  const path = localConfigPath();
  const existed = localConfigExists();
  if (existed && !options.force) {
    process.stdout.write(`Scout local config already exists at ${path}\n${formatConfig(loadLocalConfig())}\n`);
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
  process.stdout.write(`${existed ? "Overwrote" : "Created"} ${path}\n${formatConfig(next)}\n`);
}

async function runConfigCommand(args: string[]): Promise<void> {
  const [subcommand, key, ...values] = args;
  if (subcommand === "set" && key === "name") {
    const name = values.join(" ").trim();
    if (!name) {
      throw new Error("config set name requires a value");
    }
    await saveOpenScoutOnboardingIdentity({ name, currentDirectory: process.cwd() });
    process.stdout.write(`Scout operator name set to ${name}\n`);
    return;
  }
  if ((subcommand === "get" || subcommand === "show") && (!key || key === "name")) {
    process.stdout.write(`${resolveOperatorName()}\n`);
    return;
  }
  throw new Error("Node headless config supports: scout config set name <name>, scout config get name");
}

async function runSetupCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(SETUP_HELP);
    return;
  }
  const options = parseSetupOptions(args);
  const report = await runOpenScoutOnboardingSetup({
    currentDirectory: options.currentDirectory,
    sourceRoots: options.sourceRoots,
    defaultHarness: options.defaultHarness,
  });
  const completion = assessScoutSetupCompletion({ ...report,
    coreReport: await loadScoutCoreReport({ catalog: report.catalog }),
    failures: [
      ...report.scoutSkill.entries.filter((entry) => entry.status === "error")
        .map((entry) => entry.error ?? `Skill install failed: ${entry.id}`),
      ...(report.claudeStatusline.status === "error"
        ? [report.claudeStatusline.error ?? "Claude statusline install failed"] : []),
    ],
  });
  if (completion.outcome === "failed") process.exitCode = 1;
  if (options.output === "json") {
    writeJson({ schema: "scout.setup.v2", ...report, ...completion });
    return;
  }

  const setup = report.setup;
  const lines = [
    completion.headline,
    `Scope: core only. ${APP_READINESS_UNCHECKED.detail}`,
    `Support directory: ${setup.supportDirectory}`,
    `Settings: ${setup.settingsPath}`,
    `Harness catalog: ${setup.harnessCatalogPath}`,
    `Agent registry: ${setup.relayAgentsPath}`,
    `Current project config: ${setup.currentProjectConfigPath ?? "not found"}`,
    `Project inventory: ${setup.projectInventory.length}`,
    `Broker service adapter: ${report.broker.serviceAdapter ?? "unknown"}`,
    `Broker URL: ${report.broker.brokerUrl}`,
    `Broker reachable: ${report.broker.reachable ? "yes" : "no"}`,
  ];
  if (report.brokerWarning) lines.push(`Error: ${report.brokerWarning}`);
  if (completion.outcome === "handoff" && report.brokerHandoff) {
    lines.push(report.brokerHandoff.detail);
  } else if (!report.broker.health.ok) {
    lines.push(`Health error: ${report.broker.health.error ?? "Broker health verification failed"}`);
  }
  for (const entry of report.scoutSkill.entries.filter((entry) => entry.status === "error")) lines.push(`Error: ${entry.error ?? `Skill install failed: ${entry.id}`}`);
  if (report.claudeStatusline.status === "error") lines.push(`Error: ${report.claudeStatusline.error ?? "Claude statusline install failed"}`);
  lines.push(`Logs: ${report.broker.stdoutLogPath} | ${report.broker.stderrLogPath}`);
  lines.push(`Next: ${completion.nextStep}`);
  if (completion.webUrl) lines.push(`Browser: ${completion.webUrl} (starts on demand)`);
  if (completion.browserGuidance) lines.push(completion.browserGuidance);
  lines.push("Also available:", ...completion.alsoAvailable.map((step) => `  ${step}`));
  process.stdout.write(`${lines.join("\n")}\n`);
}

function runtimeCapabilitiesForCatalog(
  catalog: Awaited<ReturnType<typeof loadHarnessCatalogSnapshot>>,
  runtimeCatalog: ScoutOwnedRuntimeCatalog = SCOUT_RUNTIME_CATALOG,
): ScoutRuntimeCapabilityCatalog {
  const defaultHarness = scoutRuntimeDefaultHarness(runtimeCatalog);
  const defaultModel = scoutRuntimeDefaultModel(defaultHarness ?? "", runtimeCatalog);
  return {
    schemaVersion: "openscout.runtime-capabilities.v1",
    catalogVersion: runtimeCatalog.schemaVersion,
    catalogRevision: runtimeCatalog.revision,
    generatedAt: Date.now(),
    scope: "global",
    defaults: {
      ...(defaultHarness ? { harness: defaultHarness } : {}),
      model: defaultModel,
      reasoningEffort: scoutRuntimeDefaultReasoningEffort(defaultHarness ?? "", defaultModel, runtimeCatalog),
    },
    defaultsByHarness: scoutRuntimeDefaultsByHarness(runtimeCatalog),
    harnesses: runtimeCatalog.harnesses
      .filter((entry) => entry.enabled)
      .map((entry) => {
        const readiness = catalog.entries.find((candidate) => candidate.harness === entry.id);
        return {
          id: entry.id,
          name: readiness?.name,
          label: entry.label,
          description: readiness?.description,
          state: readiness?.readinessReport.state,
          ready: readiness?.readinessReport.ready,
          detail: readiness?.readinessReport.detail,
        };
      }),
    models: scoutRuntimeModelCatalog(runtimeCatalog).map((model) => ({ ...model, harnesses: [...model.harnesses] })),
    efforts: scoutRuntimeEffortCatalog(runtimeCatalog).map((effort) => ({
      ...effort,
      harnesses: [...effort.harnesses],
      ...(effort.models ? { models: [...effort.models] } : {}),
    })),
  };
}

async function loadBrokerRuntimeCatalog(): Promise<ScoutOwnedRuntimeCatalog | null> {
  try {
    const response = await fetch(new URL(scoutBrokerPaths.v1.runtimeCatalog, resolveScoutBrokerUrl()), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const value = await response.json() as { catalog?: unknown };
    const parsed = parseScoutRuntimeCatalog(value.catalog);
    return parsed.ok ? parsed.catalog : null;
  } catch {
    return null;
  }
}

async function runDoctorCommand(args: string[]): Promise<void> {
  const options = parseDoctorOptions(args);
  const broker = await brokerServiceStatus();
  const catalog = await loadHarnessCatalogSnapshot({ localOnly: true });
  const state = await markOpenScoutOnboardingCommand({
    command: "doctor",
    currentDirectory: options.currentDirectory,
    broker,
    catalog,
  });
  const support = resolveOpenScoutSupportPaths();
  const report = {
    schema: "scout.doctor.core.node/v1",
    coreReport: await loadScoutCoreReport({ catalog }),
    scope: "core",
    appReadiness: APP_READINESS_UNCHECKED,
    currentDirectory: options.currentDirectory,
    support,
    broker,
    catalog,
    onboarding: state,
    nativeRepairs: {
      requested: options.fix,
      yes: options.yes,
      supported: false,
      detail: "Node headless doctor does not run macOS scoutd repairs.",
    },
  };
  if (options.output === "json") {
    writeJson(report);
    return;
  }
  process.stdout.write(`${formatDoctor(report)}\n`);
}

async function runRuntimesCommand(args: string[]): Promise<void> {
  const { output, rest } = parseOutput(args);
  const parsed = parseContextRoot(rest);
  if (parsed.rest.length > 0) {
    throw new Error(`unexpected arguments for runtimes: ${parsed.rest.join(" ")}`);
  }
  const [catalog, runtimeCatalog] = await Promise.all([
    loadHarnessCatalogSnapshot(),
    loadBrokerRuntimeCatalog(),
  ]);
  const runtimeCapabilities = runtimeCapabilitiesForCatalog(catalog, runtimeCatalog ?? SCOUT_RUNTIME_CATALOG);
  const state = await markOpenScoutOnboardingCommand({
    command: "runtimes",
    currentDirectory: parsed.currentDirectory,
    catalog,
  });
  const report = { currentDirectory: parsed.currentDirectory, catalog, runtimeCapabilities, onboarding: state };
  if (output === "json") {
    writeJson(report);
    return;
  }
  const lines = [`Known runtimes: ${catalog.entries.length}`];
  for (const entry of catalog.entries) {
    lines.push(`  - ${entry.label} (${entry.name})`);
    lines.push(`    State: ${entry.readinessReport.state}`);
    lines.push(`    Detail: ${entry.readinessReport.detail}`);
  }
  lines.push("", "Exact runtime capabilities:");
  for (const harness of runtimeCapabilities.harnesses) {
    const models = runtimeCapabilities.models
      .filter((model) => model.harnesses.includes(harness.id))
      .map((model) => model.id);
    const efforts = runtimeCapabilities.efforts
      .filter((effort) => effort.harnesses.includes(harness.id))
      .map((effort) => effort.id);
    lines.push(`  - ${harness.id}`);
    lines.push(`    Models: ${models.join(", ") || "not selectable"}`);
    lines.push(`    Efforts: ${efforts.join(", ") || "not selectable"}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function runServiceCommand(args: string[]): Promise<void> {
  const [subcommand = "status", ...rest] = args;
  if (subcommand !== "status") {
    throw new Error("Node headless service command supports only: scout service status");
  }
  const { output, rest: remaining } = parseOutput(rest);
  if (remaining.length > 0) {
    throw new Error(`unexpected arguments for service status: ${remaining.join(" ")}`);
  }
  const status = await brokerServiceStatus();
  if (output === "json") {
    writeJson(status);
    return;
  }
  process.stdout.write(`${formatBrokerStatus(status)}\n`);
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

function formatBrokerStatus(status: BrokerServiceStatus): string {
  return [
    `service adapter: ${status.serviceAdapter ?? "unknown"}`,
    `label: ${status.label}`,
    `broker url: ${status.brokerUrl}`,
    `broker socket: ${status.brokerSocketPath}`,
    `loaded: ${status.loaded ? "yes" : "no"}`,
    `reachable: ${status.reachable ? "yes" : "no"}`,
    `health: ${status.health.ok ? "ok" : status.health.error ?? "unreachable"}`,
    `runtime freshness: ${status.runtimeFreshness?.state ?? "unavailable"}`,
    ...(status.runtimeFreshness ? [`runtime detail: ${status.runtimeFreshness.detail}`] : []),
  ].join("\n");
}

function formatDoctor(report: {
  currentDirectory: string;
  support: ReturnType<typeof resolveOpenScoutSupportPaths>;
  broker: BrokerServiceStatus;
  catalog: Awaited<ReturnType<typeof loadHarnessCatalogSnapshot>>;
  onboarding: Awaited<ReturnType<typeof loadOpenScoutOnboardingState>>;
  nativeRepairs: {
    requested: boolean;
    yes: boolean;
    supported: boolean;
    detail: string;
  };
}): string {
  const lines = [
    "Scout doctor",
    `Scope: core only. ${APP_READINESS_UNCHECKED.detail}`,
    `Context root: ${report.currentDirectory}`,
    `Support directory: ${report.support.supportDirectory}`,
    `Settings: ${report.support.settingsPath}`,
    `Broker service adapter: ${report.broker.serviceAdapter ?? "unknown"}`,
    `Broker URL: ${report.broker.brokerUrl}`,
    `Broker reachable: ${report.broker.reachable ? "yes" : "no"}`,
    `Runtime freshness: ${report.broker.runtimeFreshness?.state ?? "unavailable"}`,
    `Known runtimes: ${report.catalog.entries.length}`,
    `Onboarding needed: ${report.onboarding.needed ? "yes" : "no"}`,
  ];
  if (report.nativeRepairs.requested) {
    lines.push(`Native repairs: ${report.nativeRepairs.detail}`);
  }
  if (report.broker.runtimeFreshness) {
    lines.push(`Runtime detail: ${report.broker.runtimeFreshness.detail}`);
  }
  return lines.join("\n");
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
