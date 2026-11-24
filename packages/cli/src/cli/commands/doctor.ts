import { loadScoutCoreReport, resolveScoutCoreReportTarget } from "../../lib/core/setup/readiness.ts";
import { loadHarnessCatalogSnapshot } from "@openscout/runtime/harnesses";
import { DOCTOR_HELP } from "../../../bin/lifecycle-preflight.mjs";
import { collectDoctorCheck, doctorBunReport, DOCTOR_CHECK_NAMES, runDoctorCheck, renderDoctorCheck, renderDoctorAssessment } from "../doctor-checks.ts";
import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { parseDoctorCommandOptions } from "../options.ts";
import {
  loadScoutDoctorReport,
} from "../../lib/core/setup/service.ts";
import { resolveScoutWorkspaceRoot } from "../../lib/shared/paths.ts";
import { scoutTuiNeedsDownload, SCOUT_TUI_INSTALL_OFFER } from "./tui.ts";
import {
  loadNativeScoutdDoctorReport,
  renderNativeScoutdDoctorSection,
} from "../scoutd.ts";
import {
  formatScoutDoctorStreamedProjectEntry,
  renderScoutDoctorStreamingLead,
  renderScoutDoctorTailAfterStream,
} from "../../lib/ui/terminal/setup.ts";
import { deriveOpenScoutInstanceLayout, resolveBrokerControlUrl } from "@openscout/runtime/config";

const DOCTOR_JSON_SCHEMA = "scout.doctor.core/v1" as const;

function writeDoctorJsonLine(context: ScoutCommandContext, payload: Record<string, unknown>): void {
  context.output.writeText(`${JSON.stringify({ schema: DOCTOR_JSON_SCHEMA, scope: "core", instance: doctorInstanceSummary(), bun: doctorBunReport(), ...payload })}\n`);
}

/** Which OpenScout instance (OPENSCOUT_INSTANCE / --instance) doctor is checking. */
function doctorInstanceSummary(): { name: string; brokerUrl: string; root: string | null } {
  const layout = deriveOpenScoutInstanceLayout();
  return { name: layout.name, brokerUrl: resolveBrokerControlUrl(), root: layout.root };
}

function renderDoctorInstanceLine(): string {
  const instance = doctorInstanceSummary();
  return `Instance: ${instance.name} (broker ${instance.brokerUrl}${instance.root ? `, root ${instance.root}` : ""})`;
}

export function renderDoctorCommandHelp(): string {
  return DOCTOR_HELP;
}

export async function runDoctorCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    context.output.writeText(renderDoctorCommandHelp());
    return;
  }
  const options = parseDoctorCommandOptions(args, defaultScoutContextDirectory(context));
  const outputJson = context.output.mode === "json" || options.json;
  if (!outputJson) {
    const bun = doctorBunReport();
    context.output.writeText(`${bun.supported ? "OK" : "FAIL"} Bun: ${bun.version ?? "not running"} (required >=${bun.minimum})${bun.supported ? "" : `; upgrade: ${bun.upgrade}`}`);
  }
  if (!outputJson && !options.detail && !options.fix) {
    context.output.writeText("Scout doctor — checking core readiness (6s per check)…");
    context.output.writeText(renderDoctorInstanceLine());
    const checks = await Promise.all(DOCTOR_CHECK_NAMES.map(async name => {
      const check = await runDoctorCheck(name, { cwd: options.currentDirectory, env: context.env });
      context.output.writeText(renderDoctorCheck(check));
      return check;
    }));
    context.output.writeText(renderDoctorAssessment(checks));
    // An offer only; doctor never downloads it.
    if (scoutTuiNeedsDownload({ env: context.env, cwd: options.currentDirectory })) {
      context.output.writeText(SCOUT_TUI_INSTALL_OFFER);
    }
    return;
  }
  const repoRoot = (() => {
    try {
      return resolveScoutWorkspaceRoot({
        currentDirectory: options.currentDirectory,
        env: context.env,
      });
    } catch {
      return options.currentDirectory;
    }
  })();

  if (!outputJson) {
    context.output.writeText(
      renderScoutDoctorStreamingLead({
        repoRoot,
        currentDirectory: options.currentDirectory,
      }),
    );
    const report = await loadScoutDoctorReport({
      currentDirectory: options.currentDirectory,
      repoRoot,
      env: context.env,
      onProjectInventoryEntry: (entry) => {
        context.output.writeText(formatScoutDoctorStreamedProjectEntry(entry));
      },
      onProjectInventoryError: (error) => {
        context.output.writeText(`  ! ${error.relativePath}: ${error.message}\n`);
      },
    });
    const native = await loadNativeScoutdDoctorReport({
      fix: options.fix,
      yes: options.yes,
      env: context.env,
    });
    if (report.setup.projectInventory.length === 0) {
      context.output.writeText("  No projects discovered yet.\n");
    }
    context.output.writeText(renderScoutDoctorTailAfterStream(report));
    context.output.writeText(renderDoctorCheck(await collectDoctorCheck("mesh-bridge", context)));
    const nativeSection = renderNativeScoutdDoctorSection(native);
    if (nativeSection) {
      context.output.writeText(nativeSection);
    }
    return;
  }

  writeDoctorJsonLine(context, { phase: "start", target: resolveScoutCoreReportTarget(context.env) });
  const catalog = await loadHarnessCatalogSnapshot({ localOnly: true });
  const report = await loadScoutCoreReport({ env: context.env, catalog });
  const native = options.fix ? await loadNativeScoutdDoctorReport({ fix: true, yes: options.yes, env: context.env }) : null;
  writeDoctorJsonLine(context, { phase: "complete", report, meshBridge: await collectDoctorCheck("mesh-bridge", context), ...(native ? { nativeDaemon: native } : {}) });
}
