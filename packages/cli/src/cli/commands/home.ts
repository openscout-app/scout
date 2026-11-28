import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

import {
  maybeReadJsonFromActiveScoutBrokerService,
  requestScoutBrokerJson,
  ScoutBrokerHttpError,
} from "@openscout/runtime/client";
import {
  deriveOpenScoutInstanceLayout,
  inspectHomeLayoutStatus,
  resolveOpenScoutConfigReadPath,
  runHomeMigration,
  type HomeLayoutStatus,
  type HomeMigrationResult,
} from "@openscout/runtime/config";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

const HELP_FLAGS = new Set(["help", "--help", "-h"]);
const BROKER_PROBE_TIMEOUT_MS = 1_500;

export type RunHomeCommandDeps = {
  assertWritersStopped?: () => Promise<void> | void;
  now?: () => Date;
  renameImpl?: (source: string, target: string) => void;
};

function commandHome(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || homedir();
}

function normalizeControlHost(host: string | undefined): string {
  const trimmed = host?.trim();
  if (!trimmed || trimmed === "0.0.0.0" || trimmed === "::" || trimmed === "[::]") {
    return "127.0.0.1";
  }
  return trimmed;
}

function resolveBrokerProbeUrl(env: NodeJS.ProcessEnv): string {
  const explicit = env.OPENSCOUT_BROKER_URL?.trim() || env.OPENSCOUT_BROKER_INTERNAL_URL?.trim();
  if (explicit) {
    return explicit;
  }

  const home = commandHome(env);
  const layout = deriveOpenScoutInstanceLayout({ env, home });
  let fileHost: string | undefined;
  let filePort: number | undefined;
  const configPath = resolveOpenScoutConfigReadPath("config.json", env);
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
        host?: unknown;
        ports?: { broker?: unknown };
      };
      if (typeof parsed.host === "string" && parsed.host.trim()) {
        fileHost = parsed.host.trim();
      }
      if (typeof parsed.ports?.broker === "number" && Number.isInteger(parsed.ports.broker)) {
        filePort = parsed.ports.broker;
      }
    } catch {
      // ignore unreadable config
    }
  }

  const envPortRaw = env.OPENSCOUT_BROKER_PORT?.trim();
  const envPort = envPortRaw ? Number.parseInt(envPortRaw, 10) : undefined;
  const port = envPort && Number.isInteger(envPort) && envPort > 0 && envPort < 65536
    ? envPort
    : (filePort ?? layout.ports.broker);
  const host = normalizeControlHost(env.OPENSCOUT_BROKER_HOST || env.OPENSCOUT_HOST || fileHost);
  return `http://${host}:${port}`;
}

/**
 * Verify that the local Scout broker is not reachable before modifying home paths.
 * Throws ScoutCliError with clear operator instructions if the broker answers.
 */
export async function assertHomeMigrationWritersStopped(
  context: Pick<ScoutCommandContext, "env">,
  options: {
    probeBrokerReachable?: (brokerUrl: string, socketPath?: string) => Promise<boolean>;
  } = {},
): Promise<void> {
  const brokerUrl = resolveBrokerProbeUrl(context.env);
  const socketPath = context.env.OPENSCOUT_BROKER_SOCKET_PATH?.trim() || undefined;
  let reachable = false;

  if (options.probeBrokerReachable) {
    reachable = await options.probeBrokerReachable(brokerUrl, socketPath);
  } else {
    const active = await maybeReadJsonFromActiveScoutBrokerService(brokerUrl, "/health");
    if (active.handled) {
      reachable = true;
    } else {
      try {
        await requestScoutBrokerJson(brokerUrl, "/health", {
          socketPath,
          signal: AbortSignal.timeout(BROKER_PROBE_TIMEOUT_MS),
        });
        reachable = true;
      } catch (error) {
        if (error instanceof ScoutBrokerHttpError) {
          // Any HTTP response proves a broker listener is still up.
          reachable = true;
        }
      }
    }
  }

  if (reachable) {
    throw new ScoutCliError(
      `Scout broker is still running at ${brokerUrl}. Stop Scout services first (for example \`scout app stop\` or unload launchd/systemd) and re-run \`scout home migrate\`.`,
    );
  }
}

export function renderHomeCommandHelp(): string {
  return [
    "Usage: scout home status [--json]",
    "       scout home migrate [--dry-run] [--json]",
    "",
    "Inspect or migrate Scout's files into the unified ~/.openscout home layout",
    "(operator config/catalogs at top level, Scout-owned state under state/,",
    "rebuildable cache under cache/, sibling tools under .<tool>/).",
    "",
    "status    Show where ~/.openscout, ~/.scout, ~/.scout-desk, and the legacy",
    "          support directory stand and how many items are pending migration.",
    "migrate   Stop-checked, locked, WAL-checkpointed, journalled migration into",
    "          ~/.openscout. Refuses while the broker is still running.",
    "--dry-run Preview every planned move, conflict, skip, and refusal without",
    "          touching disk or taking the migration lock.",
    "--json    Emit structured JSON output.",
  ].join("\n");
}

function renderHomeStatus(status: HomeLayoutStatus): string {
  const hostUpdatesSuffix = status.pendingHostUpdates > 0
    ? `, ${status.pendingHostUpdates} host config update(s)`
    : "";
  const lines: string[] = [
    `OpenScout home: ${status.paths.openscoutHome}${status.openscoutHomeExists ? "" : " (not created yet)"}`,
    `  state:  ${status.paths.stateDir}${status.stateDirExists ? "" : " (not created yet)"}`,
    `  cache:  ${status.paths.cacheDir}${status.cacheDirExists ? "" : " (not created yet)"}`,
    `  desk:   ${status.paths.deskDir}${status.deskDirExists ? "" : " (not present)"}`,
    "",
    "Legacy locations:",
    `  ~/.scout:        ${status.legacy.scout.path} (${describeLegacyRoot(status.legacy.scout)})`,
    `  legacy support:  ${status.legacy.support.path} (${describeLegacyRoot(status.legacy.support)})`,
    `  ~/.scout-desk:   ${status.legacy.desk.path} (${describeLegacyRoot(status.legacy.desk)})`,
    "",
    `Pending migration: ${status.pendingMoves} move(s), ${status.conflicts} conflict(s), ${status.refused} refused, ${status.skipped} skipped${hostUpdatesSuffix}`,
  ];

  if (status.lock.held) {
    const holder = status.lock.info
      ? `pid ${status.lock.info.pid} since ${status.lock.info.startedAt}`
      : "holder unknown";
    lines.push(`Lock: held (${holder}) at ${status.lock.path}`);
  }
  if (status.journal.exists) {
    lines.push(
      `Journal: ${status.journal.status} (${status.journal.doneCount} done, ${status.journal.conflictCount} conflict, ${status.journal.pendingCount} pending)`,
    );
  }
  if (status.migrationPending) {
    lines.push("", "Next step: run `scout home migrate --dry-run` to preview, then stop services and run `scout home migrate`.");
  } else {
    lines.push("", "Home layout is up to date.");
  }
  return lines.join("\n");
}

function describeLegacyRoot(root: HomeLayoutStatus["legacy"]["scout"]): string {
  if (!root.exists) return "absent";
  if (root.isSymlink) return "symlink (refused)";
  if (root.movedMarkerExists) return "retired (MOVED.md present)";
  return "present";
}

function renderHomeMigrationResult(result: HomeMigrationResult): string {
  if (result.dryRun) {
    const hostSuffix = result.plan.hostUpdates.length > 0
      ? `, ${result.plan.hostUpdates.length} host config update(s)`
      : "";
    const lines: string[] = [
      `Dry run: ${result.plan.moves.length} move(s), ${result.plan.conflicts.length} conflict(s), ${result.plan.refused.length} refused, ${result.plan.skipped.length} skipped${hostSuffix} (no files changed).`,
    ];
    for (const entry of result.plan.entries) {
      const target = entry.target ? ` -> ${entry.target}` : "";
      const note = entry.reason ? ` (${entry.reason})` : "";
      lines.push(`  [${entry.action}] ${entry.source}${target}${note}`);
    }
    for (const update of result.plan.hostUpdates) {
      lines.push(`  [update] ${update.path} (${update.kind}, ${update.replacements} reference(s))`);
    }
    return lines.join("\n");
  }

  if (result.alreadyMigrated) {
    const lines = [
      `Home layout at ${result.paths.openscoutHome} is already migrated; nothing to move.`,
    ];
    for (const entry of result.plan.skipped) {
      lines.push(`  [skip] ${entry.source}${entry.reason ? ` (${entry.reason})` : ""}`);
    }
    return lines.join("\n");
  }

  const lines: string[] = [
    `${result.resumed ? "Resumed and completed" : "Completed"} home migration into ${result.paths.openscoutHome}.`,
    `  moved: ${result.movedCount}, conflicts preserved: ${result.conflictCount}, skipped: ${result.skippedCount}`,
    `  SQLite databases checkpointed: ${result.checkpointedDatabases.length}`,
    `  journal: ${result.journalPath}`,
  ];
  if (result.updatedHostFiles.length > 0) {
    lines.push("  host configs updated:");
    for (const update of result.updatedHostFiles) {
      lines.push(`    ${update.path} (${update.kind}, ${update.replacements} reference(s))`);
    }
    if (result.updatedHostFiles.some((update) => update.kind === "launch-agent" || update.kind === "systemd-unit")) {
      lines.push("  note: reload the service definition when starting Scout back up.");
    }
  }
  if (result.movedMarkers.length > 0) {
    lines.push("  MOVED.md written:");
    for (const marker of result.movedMarkers) {
      lines.push(`    ${marker}`);
    }
  }
  for (const entry of result.plan.skipped) {
    lines.push(`  [skip] ${entry.source}${entry.reason ? ` (${entry.reason})` : ""}`);
  }
  return lines.join("\n");
}

function parseSubcommandFlags(
  subcommand: "status" | "migrate",
  args: string[],
): { dryRun: boolean; json: boolean; help: boolean } {
  let dryRun = false;
  let json = false;
  let help = false;

  for (const arg of args) {
    if (HELP_FLAGS.has(arg)) {
      help = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--dry-run" && subcommand === "migrate") {
      dryRun = true;
      continue;
    }
    throw new ScoutCliError(`unexpected argument for scout home ${subcommand}: ${arg}`);
  }

  return { dryRun, json, help };
}

function writeOutput<T>(
  context: ScoutCommandContext,
  forceJson: boolean,
  value: T,
  renderPlain: (data: T) => string,
): void {
  if (forceJson && context.output.mode !== "json") {
    context.output.writeText(JSON.stringify(value, null, 2));
    return;
  }
  context.output.writeValue(value, renderPlain);
}

export async function runHomeCommand(
  context: ScoutCommandContext,
  args: string[],
  deps: RunHomeCommandDeps = {},
): Promise<void> {
  const [first, ...rest] = args;
  if (first && HELP_FLAGS.has(first)) {
    context.output.writeText(renderHomeCommandHelp());
    return;
  }

  const subcommand = !first || first.startsWith("-") ? "status" : first;
  const flagArgs = !first || first.startsWith("-") ? args : rest;

  if (subcommand !== "status" && subcommand !== "migrate") {
    throw new ScoutCliError(`unknown home subcommand: ${subcommand} (try: scout home --help)`);
  }

  const parsed = parseSubcommandFlags(subcommand, flagArgs);
  if (parsed.help) {
    context.output.writeText(renderHomeCommandHelp());
    return;
  }

  const home = commandHome(context.env);

  if (subcommand === "status") {
    const status = inspectHomeLayoutStatus({ home, env: context.env });
    writeOutput(context, parsed.json, status, renderHomeStatus);
    return;
  }

  const result = await runHomeMigration({
    home,
    env: context.env,
    dryRun: parsed.dryRun,
    assertWritersStopped: parsed.dryRun
      ? undefined
      : (deps.assertWritersStopped ?? (() => assertHomeMigrationWritersStopped(context))),
    now: deps.now,
    renameImpl: deps.renameImpl,
  });

  writeOutput(context, parsed.json, result, renderHomeMigrationResult);
}
