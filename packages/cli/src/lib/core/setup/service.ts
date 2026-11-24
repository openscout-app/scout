import { APP_READINESS_UNCHECKED, loadScoutCoreReport } from "./readiness.ts";
import type { CoreServiceReport } from "@openscout/runtime/setup";
import type { ScoutCapabilityMatrixSnapshot } from "@openscout/protocol";
import {
  loadResolvedRelayAgents,
  type ClaudeStatuslineInstallReport,
  type ProjectInventoryEntry,
  type ProjectInventoryError,
  type SetupResult,
  type ScoutSkillInstallReport,
  runOpenScoutOnboardingSetup,
  type OpenScoutBrokerHandoff,
  loadSystemProbeDoctorReport,
  type SystemProbeDoctorReport,
} from "@openscout/runtime/setup";
import { loadHarnessCatalogSnapshot } from "@openscout/runtime/harnesses";
import type { BrokerServiceStatus } from "@openscout/runtime/daemon";
import {
  getRuntimeBrokerServiceStatus,
} from "../../app/host/runtime-service-client.ts";
import { resolveOpenScoutSupportPaths } from "@openscout/runtime/config";
import { withScoutCoreCommandLock } from "./command-lock.ts";
import { readScoutCapabilityMatrix } from "../broker/service.ts";

export type ScoutDoctorReport = {
  currentDirectory: string;
  repoRoot: string;
  supportPaths: ReturnType<typeof resolveOpenScoutSupportPaths>;
  broker: BrokerServiceStatus;
  coreReport: CoreServiceReport;
  scope: "core";
  appReadiness: typeof APP_READINESS_UNCHECKED;
  systemProbes: SystemProbeDoctorReport;
  setup: Awaited<ReturnType<typeof loadResolvedRelayAgents>>;
  catalog: Awaited<ReturnType<typeof loadHarnessCatalogSnapshot>>;
  capabilities: ScoutCapabilityMatrixSnapshot | null;
};

export type ScoutSetupReport = {
  currentDirectory: string;
  setup: SetupResult;
  broker: BrokerServiceStatus;
  brokerWarning: string | null;
  /** Headless foreground adapter with no broker yet: an expected handoff, not a failure. */
  brokerHandoff: OpenScoutBrokerHandoff | null;
  coreReport: CoreServiceReport;
  scope: "core";
  appReadiness: typeof APP_READINESS_UNCHECKED;
  catalog: Awaited<ReturnType<typeof loadHarnessCatalogSnapshot>>;
  scoutSkill: ScoutSkillInstallReport;
  claudeStatusline: ClaudeStatuslineInstallReport;
};

export { loadScoutRuntimesReport, type ScoutRuntimesReport } from "./runtimes.ts";

export type ScoutProjectInventoryEntry = ProjectInventoryEntry;

export async function loadScoutDoctorReport(input: {
  currentDirectory: string;
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  onProjectInventoryEntry?: (entry: ProjectInventoryEntry) => void | Promise<void>;
  onProjectInventoryError?: (error: ProjectInventoryError) => void | Promise<void>;
}): Promise<ScoutDoctorReport> {
  return withScoutCoreCommandLock("doctor", async () => {
    const [broker, systemProbes, setup, catalog, capabilities] = await Promise.all([
      getRuntimeBrokerServiceStatus(),
      loadSystemProbeDoctorReport({ repoRoot: input.repoRoot }),
      loadResolvedRelayAgents({
        currentDirectory: input.currentDirectory,
        onProjectInventoryEntry: input.onProjectInventoryEntry,
        onProjectInventoryError: input.onProjectInventoryError,
      }),
      loadHarnessCatalogSnapshot({ localOnly: true }),
      readScoutCapabilityMatrix(),
    ]);

    return {
      coreReport: await loadScoutCoreReport({ env: input.env, catalog }),
      currentDirectory: input.currentDirectory,
      repoRoot: input.repoRoot,
      supportPaths: resolveOpenScoutSupportPaths(),
      broker,
      scope: "core",
      appReadiness: APP_READINESS_UNCHECKED,
      systemProbes,
      setup,
      catalog,
      capabilities,
    };
  });
}

export async function runScoutSetup(input: {
  currentDirectory: string;
  sourceRoots: string[];
  defaultHarness?: string | null;
}): Promise<ScoutSetupReport> {
  return withScoutCoreCommandLock("setup", async () => {
    const setupResult = await runOpenScoutOnboardingSetup({
      currentDirectory: input.currentDirectory,
      sourceRoots: input.sourceRoots,
      defaultHarness: input.defaultHarness,
    });

    return {
      coreReport: await loadScoutCoreReport({ catalog: setupResult.catalog }),
      currentDirectory: input.currentDirectory,
      setup: setupResult.setup,
      broker: setupResult.broker,
      brokerWarning: setupResult.brokerWarning,
      brokerHandoff: setupResult.brokerHandoff,
      scope: "core",
      appReadiness: APP_READINESS_UNCHECKED,
      catalog: setupResult.catalog,
      scoutSkill: setupResult.scoutSkill,
      claudeStatusline: setupResult.claudeStatusline,
    };
  });
}
