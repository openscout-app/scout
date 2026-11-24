import {
  assessCoreSetupCompletion, buildCoreServiceReport, describeCoreHarnessPresence,
  type CoreHealthObservation, type CoreReportHealthPayload, type CoreServiceReport,
} from "@openscout/runtime/setup";
import { requestScoutBrokerJsonWithTrace, ScoutBrokerHttpError } from "@openscout/runtime/broker-api";
import { resolveBrokerControlUrl, resolveOpenScoutInstanceName } from "@openscout/runtime/config";
import type { HarnessCatalogSnapshot } from "@openscout/runtime/harnesses";

export const APP_READINESS_UNCHECKED = Object.freeze({
  status: "not_checked" as const, reason: "private_app_scope" as const,
  detail: "Private app, local-edge CA and Web-PTY readiness belong to the app's diagnostics, not core readiness.",
});

function isHealth(value: unknown): value is CoreReportHealthPayload {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && typeof (value as { ok?: unknown }).ok === "boolean";
}

export function resolveScoutCoreReportTarget(env: NodeJS.ProcessEnv = process.env) {
  return {
    instance: resolveOpenScoutInstanceName(env),
    brokerUrl: env.OPENSCOUT_BROKER_URL?.trim() || resolveBrokerControlUrl(),
    ...(env.OPENSCOUT_NODE_ID?.trim() ? { expectedNodeId: env.OPENSCOUT_NODE_ID.trim() } : {}),
  };
}

/** Observe /health, not service installation or custody. Never infer the expected
 * identity from the same response that is being verified. */
export async function loadScoutCoreReport(input: {
  env?: NodeJS.ProcessEnv;
  catalog?: HarnessCatalogSnapshot;
  signal?: AbortSignal;
} = {}): Promise<CoreServiceReport> {
  const env = input.env ?? process.env;
  const target = resolveScoutCoreReportTarget(env);
  const observedTarget = { instance: target.instance, brokerUrl: target.brokerUrl };
  const signal = input.signal ?? AbortSignal.timeout(4_000);
  let health: CoreHealthObservation;
  try {
    const { value } = await requestScoutBrokerJsonWithTrace<unknown>(target.brokerUrl, "/health", {
      socketPath: env.OPENSCOUT_BROKER_SOCKET_PATH?.trim() || undefined, signal,
    });
    health = isHealth(value)
      ? { target: observedTarget, checkedAt: Date.now(), state: "observed", payload: value }
      : { target: observedTarget, checkedAt: Date.now(), state: "invalid_response", body: value ?? null, error: "Health response lacks boolean ok." };
  } catch (error) {
    if (error instanceof ScoutBrokerHttpError) {
      let body: unknown = error.body;
      try { body = JSON.parse(error.body); } catch { /* retain non-JSON refusal */ }
      health = isHealth(body)
        ? { target: observedTarget, checkedAt: Date.now(), state: "observed", payload: body, status: error.status }
        : { target: observedTarget, checkedAt: Date.now(), state: "refused", body, status: error.status, error: error.message };
    } else {
      health = { target: observedTarget, checkedAt: Date.now(),
        state: signal.aborted ? signal.reason?.name === "TimeoutError" ? "timed_out" : "cancelled" : "unavailable",
        error: error instanceof Error ? error.message : String(error) };
    }
  }
  return buildCoreServiceReport({ target, health, harnesses: input.catalog?.entries.map(entry =>
    describeCoreHarnessPresence({ harness: entry.harness, observation: {
      binaryPath: entry.readinessReport.binaryPath ?? null,
      source: entry.readinessReport.binarySource ?? "local catalog",
      observedAt: input.catalog!.generatedAt,
    } }),
  ) });
}

/** CLI presentation only. Core semantics come from the shared pure assessor;
 * foreground handoff describes acquisition, never a verified core. */
export function assessScoutSetupCompletion(input: {
  coreReport: CoreServiceReport;
  broker: { health: { ok: boolean }; reachable?: boolean; serviceAdapter?: string };
  brokerWarning?: string | null;
  brokerHandoff?: { command: string } | null;
  failures?: string[];
}) {
  const completion = assessCoreSetupCompletion({ report: input.coreReport,
    failures: [...(input.failures ?? []), ...(input.brokerWarning ? [input.brokerWarning] : [])] });
  const handoff = completion.outcome === "pending" && !input.broker.health.ok && input.broker.reachable !== true
    ? input.brokerHandoff : null;
  return {
    scope: "core" as const, appReadiness: APP_READINESS_UNCHECKED, coreCompletion: completion,
    outcome: completion.outcome === "failed" ? "failed" as const : handoff ? "handoff" as const
      : completion.outcome === "complete" ? "ready" as const : "running" as const,
    headline: handoff ? "Scout is set up. Start the broker to finish." : completion.headline,
    nextStep: handoff?.command ?? (completion.outcome === "failed" && !input.broker.health.ok && input.broker.serviceAdapter === "headless-foreground"
      ? "openscout-runtime broker" : completion.nextStep),
    alsoAvailable: ["scout whoami — check caller identity", "scout runtimes — inspect coding-agent presence", "scout --help — terminal and coding-agent tools"],
    webUrl: null, browserGuidance: null,
  };
}
export type ScoutSetupCompletion = ReturnType<typeof assessScoutSetupCompletion>;
