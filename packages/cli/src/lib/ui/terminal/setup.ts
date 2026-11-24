import { renderCapabilitySnapshotSummary } from "./runtimes.ts";
export { renderScoutRuntimesReport } from "./runtimes.ts";
import { assessScoutSetupCompletion, type ScoutSetupCompletion } from "../../core/setup/readiness.ts";
import type {
  ScoutDoctorReport,
  ScoutProjectInventoryEntry,
  ScoutSetupReport,
} from "../../core/setup/service.ts";
import { deriveOpenScoutInstanceLayout } from "@openscout/runtime/config";

function renderInstanceLine(): string {
  const layout = deriveOpenScoutInstanceLayout();
  return `Instance: ${layout.name}${layout.root ? ` (root ${layout.root})` : ""}`;
}

function renderBrokerHealthTransportLines(
  broker: ScoutDoctorReport["broker"] | ScoutSetupReport["broker"],
): string[] {
  const lines = [
    `  Broker socket: ${broker.brokerSocketPath}`,
    `  Health transport: ${broker.health.transport ?? "unknown"}`,
  ];
  if (broker.health.socketFallbackError) {
    lines.push(`  Socket fallback: ${broker.health.socketFallbackError}`);
  }
  return lines;
}

export function renderScoutDoctorStreamingLead(input: { repoRoot: string; currentDirectory: string }): string {
  return [
    "Scout doctor",
    renderInstanceLine(),
    `Repo root: ${input.repoRoot}`,
    `Context root: ${input.currentDirectory}`,
    "",
    "Discovering projects…",
    "",
  ].join("\n");
}

export function formatScoutDoctorStreamedProjectEntry(project: ScoutProjectInventoryEntry): string {
  const harnesses = project.harnesses
    .map((entry) => `${entry.harness} (${entry.detail})`)
    .join(" | ");

  const lines = [
    `  - ${project.displayName} (${project.agentId})`,
    `    Root: ${project.projectRoot}`,
    `    Source root: ${project.sourceRoot}`,
    `    Relative path: ${project.relativePath}`,
    `    State: ${project.registrationKind === "configured" ? "configured agent" : "discovered project"}`,
    `    Default harness: ${project.defaultHarness}`,
    `    Harnesses: ${harnesses}`,
  ];
  if (project.projectConfigPath) {
    lines.push(`    Manifest: ${project.projectConfigPath}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderScoutDoctorTailAfterStream(report: ScoutDoctorReport): string {
  const roots = report.setup.settings.discovery.workspaceRoots;
  const n = report.setup.projectInventory.length;
  const lines = [
    "",
    `Project inventory: ${n} project${n === 1 ? "" : "s"} (streamed above).`,
    "",
    `Support directory: ${report.setup.supportDirectory}`,
    `Settings: ${report.setup.settingsPath}`,
    `Harness catalog: ${report.setup.harnessCatalogPath}`,
    `Agent registry: ${report.setup.relayAgentsPath}`,
    `Managed installs: ${report.setup.managedInstallsPath}`,
    `Current project config: ${report.setup.currentProjectConfigPath ?? "not found"}`,
    "",
    "Source roots:",
    ...(roots.length > 0 ? roots.map((root) => `  - ${root}`) : ["  (none — Scout is not scanning any parent folders for repos.)"]),
    ...(roots.length === 0
      ? [
          "",
          "Tip: Set discovery.workspaceRoots in your OpenScout settings file, or run `scout setup --source-root <path>`.",
        ]
      : []),
    ...(roots.length > 0 && n === 0
      ? [
          "",
          "Tip: Under each source root, projects need a signal such as .git, a language manifest (Cargo.toml,",
          "go.mod, pyproject.toml, Gemfile, Package.swift, …), or agent docs (CLAUDE.md, AGENTS.md).",
          "Symlinked directories are followed.",
        ]
      : []),
    "",
    "Agent defaults:",
    `  Harness: ${report.setup.settings.agents.defaultHarness}`,
    `  Capabilities: ${report.setup.settings.agents.defaultCapabilities.join(", ")}`,
    `  Session prefix: ${report.setup.settings.agents.sessionPrefix}`,
    "",
    "Base service:",
    `  Label: ${report.broker.label}`,
    `  Broker URL: ${report.broker.brokerUrl}`,
    ...renderBrokerHealthTransportLines(report.broker),
    `  Installed: ${report.broker.installed ? "yes" : "no"}`,
    `  Loaded: ${report.broker.loaded ? "yes" : "no"}`,
    `  Reachable: ${report.broker.reachable ? "yes" : "no"}`,
    ...(report.broker.serviceAdapter === "headless-foreground"
      ? ["  Lifecycle: foreground process (managed externally)"]
      : [`  LaunchAgent: ${report.broker.launchAgentPath}`, `  Bootout: ${report.broker.bootoutCommand}`]),
    `  Stdout: ${report.broker.stdoutLogPath}`,
    `  Stderr: ${report.broker.stderrLogPath}`,
    "",
    `Scope: core only. ${report.appReadiness.detail}`,
    ...report.coreReport.service.checks.map(check => `  ${check.name}: ${check.state} — ${check.detail}`),
    "",
    ...renderSystemProbes(report.systemProbes),
    "",
    `Known runtimes: ${report.catalog.entries.length}`,
  ];

  for (const entry of report.catalog.entries) {
    lines.push(`  - ${entry.label} (${entry.name})`);
    lines.push(`    State: ${entry.readinessReport.state}`);
    lines.push(`    Detail: ${entry.readinessReport.detail}`);
    if (entry.readinessReport.missing.length > 0) {
      lines.push(`    Missing: ${entry.readinessReport.missing.join(" | ")}`);
    }
  }

  lines.push("", ...renderCapabilitySnapshotSummary(report.capabilities));

  return lines.join("\n");
}

function renderProjectInventory(projects: ScoutProjectInventoryEntry[]): string[] {
  const lines = [`Project inventory: ${projects.length}`];
  if (projects.length === 0) {
    lines.push("  No projects discovered yet.");
    return lines;
  }

  for (const project of projects) {
    const harnesses = project.harnesses
      .map((entry) => `${entry.harness} (${entry.detail})`)
      .join(" | ");

    lines.push(`  - ${project.displayName} (${project.agentId})`);
    lines.push(`    Root: ${project.projectRoot}`);
    lines.push(`    Source root: ${project.sourceRoot}`);
    lines.push(`    Relative path: ${project.relativePath}`);
    lines.push(`    State: ${project.registrationKind === "configured" ? "configured agent" : "discovered project"}`);
    lines.push(`    Default harness: ${project.defaultHarness}`);
    lines.push(`    Harnesses: ${harnesses}`);
    if (project.projectConfigPath) {
      lines.push(`    Manifest: ${project.projectConfigPath}`);
    }
  }

  return lines;
}

function renderSystemProbes(report: ScoutDoctorReport["systemProbes"]): string[] {
  const lines = [
    "System probes:",
    `  Socket: ${report.socketPath}`,
    `  Socket exists: ${report.socketExists ? "yes" : "no"}`,
    `  Daemon observed: ${report.daemonObserved ? "yes" : "no"}`,
    `  Daemon version: ${report.daemonVersion ?? "-"}`,
    `  Capabilities: ${report.supportedProbeIds.length > 0 ? report.supportedProbeIds.join(", ") : "-"}`,
  ];
  if (report.lastError) {
    lines.push(`  Last scoutd error: ${report.lastError}`);
  }
  for (const family of report.families) {
    const fallback = family.fallbackSince
      ? `; fallback ${Math.round((family.fallbackAgeMs ?? 0) / 1000)}s: ${family.fallbackReason ?? "unknown"}`
      : "";
    lines.push(`  - ${family.id}: ${family.backend} (${family.status})${fallback}`);
  }
  for (const warning of report.warnings) {
    lines.push(`  Warning: ${warning}`);
  }
  return lines;
}

export function renderScoutDoctorReport(report: ScoutDoctorReport): string {
  const roots = report.setup.settings.discovery.workspaceRoots;
  const lines = [
    "Scout doctor",
    renderInstanceLine(),
    `Repo root: ${report.repoRoot}`,
    `Context root: ${report.currentDirectory}`,
    `Support directory: ${report.setup.supportDirectory}`,
    `Settings: ${report.setup.settingsPath}`,
    `Harness catalog: ${report.setup.harnessCatalogPath}`,
    `Agent registry: ${report.setup.relayAgentsPath}`,
    `Managed installs: ${report.setup.managedInstallsPath}`,
    `Current project config: ${report.setup.currentProjectConfigPath ?? "not found"}`,
    "",
    "Source roots:",
    ...(roots.length > 0 ? roots.map((root) => `  - ${root}`) : ["  (none — Scout is not scanning any parent folders for repos.)"]),
    ...(roots.length === 0
      ? [
          "",
          "Tip: Set discovery.workspaceRoots in your OpenScout settings file, or run `scout setup --source-root <path>`.",
        ]
      : []),
    ...(roots.length > 0 && report.setup.projectInventory.length === 0
      ? [
          "",
          "Tip: Under each source root, projects need a signal such as .git, a language manifest (Cargo.toml,",
          "go.mod, pyproject.toml, Gemfile, Package.swift, …), or agent docs (CLAUDE.md, AGENTS.md).",
          "Symlinked directories are followed.",
        ]
      : []),
    "",
    "Agent defaults:",
    `  Harness: ${report.setup.settings.agents.defaultHarness}`,
    `  Capabilities: ${report.setup.settings.agents.defaultCapabilities.join(", ")}`,
    `  Session prefix: ${report.setup.settings.agents.sessionPrefix}`,
    "",
    ...renderProjectInventory(report.setup.projectInventory),
    "",
    "Base service:",
    `  Label: ${report.broker.label}`,
    `  Broker URL: ${report.broker.brokerUrl}`,
    ...renderBrokerHealthTransportLines(report.broker),
    `  Installed: ${report.broker.installed ? "yes" : "no"}`,
    `  Loaded: ${report.broker.loaded ? "yes" : "no"}`,
    `  Reachable: ${report.broker.reachable ? "yes" : "no"}`,
    ...(report.broker.serviceAdapter === "headless-foreground"
      ? ["  Lifecycle: foreground process (managed externally)"]
      : [`  LaunchAgent: ${report.broker.launchAgentPath}`, `  Bootout: ${report.broker.bootoutCommand}`]),
    `  Stdout: ${report.broker.stdoutLogPath}`,
    `  Stderr: ${report.broker.stderrLogPath}`,
    "",
    `Scope: core only. ${report.appReadiness.detail}`,
    ...report.coreReport.service.checks.map(check => `  ${check.name}: ${check.state} — ${check.detail}`),
    "",
    ...renderSystemProbes(report.systemProbes),
    "",
    `Known runtimes: ${report.catalog.entries.length}`,
  ];

  for (const entry of report.catalog.entries) {
    lines.push(`  - ${entry.label} (${entry.name})`);
    lines.push(`    State: ${entry.readinessReport.state}`);
    lines.push(`    Detail: ${entry.readinessReport.detail}`);
    if (entry.readinessReport.missing.length > 0) {
      lines.push(`    Missing: ${entry.readinessReport.missing.join(" | ")}`);
    }
  }

  lines.push("", ...renderCapabilitySnapshotSummary(report.capabilities));

  return lines.join("\n");
}

export function renderScoutSetupReport(report: ScoutSetupReport, completion: ScoutSetupCompletion = assessScoutSetupCompletion(report)): string {
  const lines = [
    completion.headline,
    `Context root: ${report.currentDirectory}`,
    `Support directory: ${report.setup.supportDirectory}`,
    `Settings: ${report.setup.settingsPath}`,
    `Harness catalog: ${report.setup.harnessCatalogPath}`,
    `Agent registry: ${report.setup.relayAgentsPath}`,
    `Managed installs: ${report.setup.managedInstallsPath}`,
    `Claude statusline: ${report.claudeStatusline.status} (${report.claudeStatusline.wrapperPath})`,
    `Current project config: ${report.setup.currentProjectConfigPath ?? "not created"}`,
    `Created project config: ${report.setup.createdProjectConfig ? "yes" : "no"}`,
    "",
    "Source roots:",
    ...report.setup.settings.discovery.workspaceRoots.map((root) => `  - ${root}`),
    "",
    ...renderProjectInventory(report.setup.projectInventory),
    "",
    "Base service:",
    `  Label: ${report.broker.label}`,
    `  Broker URL: ${report.broker.brokerUrl}`,
    ...renderBrokerHealthTransportLines(report.broker),
    `  Reachable: ${report.broker.reachable ? "yes" : "no"}`,
    ...(report.broker.serviceAdapter === "headless-foreground"
      ? ["  Lifecycle: foreground process (managed externally)"]
      : [`  LaunchAgent: ${report.broker.launchAgentPath}`, `  Bootout: ${report.broker.bootoutCommand}`]),
    `  Logs: ${report.broker.stdoutLogPath} | ${report.broker.stderrLogPath}`,
  ];

  if (report.brokerWarning) {
    lines.push(`  Error: ${report.brokerWarning}`);
  }
  for (const entry of report.scoutSkill.entries.filter((entry) => entry.status === "error")) {
    lines.push(`  Error: ${entry.error ?? `Skill install failed: ${entry.id}`}`);
  }
  if (report.claudeStatusline.status === "error") lines.push(`  Error: ${report.claudeStatusline.error ?? "Claude statusline install failed"}`);
  if (completion.outcome === "handoff" && report.brokerHandoff) {
    lines.push(`  ${report.brokerHandoff.detail}`);
  } else if (!report.broker.health.ok) {
    lines.push(`  Health error: ${report.broker.health.error ?? "Broker health verification failed"}`);
  }

  lines.push("", `Scope: core only. ${report.appReadiness.detail}`);

  lines.push("", "Harnesses:");
  for (const entry of report.catalog.entries) {
    lines.push(`  - ${entry.label} (${entry.name})`);
    lines.push(`    State: ${entry.readinessReport.state}`);
    lines.push(`    Detail: ${entry.readinessReport.detail}`);
  }

  lines.push("", `Next: ${completion.nextStep}`);
  if (completion.webUrl) lines.push(`Browser: ${completion.webUrl} (starts on demand)`);
  if (completion.browserGuidance) lines.push(completion.browserGuidance);
  lines.push("", "Also available:", ...completion.alsoAvailable.map((step) => `  ${step}`));

  return lines.join("\n");
}
