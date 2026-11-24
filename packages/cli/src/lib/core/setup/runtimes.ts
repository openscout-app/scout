import {
  SCOUT_RUNTIME_CATALOG, parseScoutRuntimeCatalog, scoutRuntimeDefaultHarness,
  scoutRuntimeDefaultModel, scoutRuntimeDefaultReasoningEffort, scoutRuntimeDefaultsByHarness,
  scoutRuntimeEffortCatalog, scoutRuntimeModelCatalog,
  type ScoutCapabilityMatrixSnapshot, type ScoutRuntimeCapabilityCatalog,
} from "@openscout/protocol";
import { loadHarnessCatalogSnapshot } from "@openscout/runtime/harness-catalog";
import { resolveExecutableFromSearch } from "@openscout/runtime/tool-resolution";
import { resolveBrokerControlUrl, resolveOpenScoutSupportPaths } from "@openscout/runtime/config";
import { requestScoutBrokerJson, ScoutBrokerHttpError } from "@openscout/runtime/broker-api";
import type { ScoutBrokerHealthPayload } from "@openscout/runtime/client";
import { withScoutCoreCommandLock } from "./command-lock.ts";

export type CoreRead<T> = { availability: "available"; value: T } | { availability: "unavailable"; status: number | null; reason: string };
export type CoreRuntimeHealth = { state: "working" | "impaired" | "inconclusive"; detail: string; observation: CoreRead<ScoutBrokerHealthPayload> };
export type ScoutRuntimesReport = {
  currentDirectory: string;
  harnessCatalogPath: string;
  catalog: Awaited<ReturnType<typeof loadHarnessCatalogSnapshot>>;
  capabilities: ScoutCapabilityMatrixSnapshot | null;
  runtimeCapabilities: ScoutRuntimeCapabilityCatalog;
  readinessPolicy: "path_and_env_file_evidence_only";
  appReadiness: { availability: "unavailable"; requiredForCore: false; reason: "private_app_not_inspected" };
  brokerReads: { catalog: CoreRead<unknown>; capabilities: CoreRead<unknown> };
  coreHealth: CoreRuntimeHealth;
};

async function read<T>(path: string, env: NodeJS.ProcessEnv): Promise<CoreRead<T>> {
  try {
    const value = await requestScoutBrokerJson<T>(env.OPENSCOUT_BROKER_URL?.trim() || resolveBrokerControlUrl(), path, {
      socketPath: env.OPENSCOUT_BROKER_SOCKET_PATH?.trim() || undefined, signal: AbortSignal.timeout(2_000),
    });
    return { availability: "available", value };
  } catch (error) {
    return { availability: "unavailable", status: error instanceof ScoutBrokerHttpError ? error.status : null, reason: "broker_read_unavailable" };
  }
}

/** Liveness alone is not write readiness. Preserve storage/projection/startup
 * evidence instead of allowing an optional app or fallback catalog to mask it. */
export function coreRuntimeHealth(observation: CoreRead<ScoutBrokerHealthPayload>): CoreRuntimeHealth {
  if (observation.availability === "unavailable") return { state: "inconclusive", detail: "Core broker health unavailable; no service was started or repaired.", observation };
  const health = observation.value;
  if (!health || typeof health.ok !== "boolean") return { state: "inconclusive", detail: "Invalid core broker health response.", observation: { availability: "unavailable", status: null, reason: "invalid_health_response" } };
  if (health.storage?.journal?.state === "failing") return { state: "impaired", detail: `Core journal writes failing: ${health.storage.journal.code ?? health.storage.journal.error}.`, observation };
  if (!health.ok || health.projection?.state === "degraded" || health.startup?.state === "degraded" || health.startup?.phase === "failed") return { state: "impaired", detail: "Core broker reports unhealthy storage, projection or startup; inspect the preserved health observation.", observation };
  if (health.projection?.state === "warming" || health.startup?.state === "restoring" || health.startup?.mutationsAdmitted === false) return { state: "inconclusive", detail: "Core broker is still restoring/warming; mutation readiness is not confirmed.", observation };
  return { state: "working", detail: "Core broker health responded OK; app readiness is not required.", observation };
}

/** No app discovery, shell/version/login probes or onboarding mutation. The
 * runtime owns the catalog/readiness model; CLI chooses its supported passive
 * policy and PATH resolver rather than copying that implementation. */
export async function loadScoutRuntimesReport(currentDirectory: string, env: NodeJS.ProcessEnv = process.env): Promise<ScoutRuntimesReport> {
  return withScoutCoreCommandLock("runtimes", async () => {
    const [catalog, live, capabilityRead, health] = await Promise.all([
      loadHarnessCatalogSnapshot({ env, localOnly: true, whichBinary: binary => resolveExecutableFromSearch({ env, names: [binary], commonDirectories: [] })?.path ?? null }),
      read<{ catalog?: unknown; warnings?: unknown }>("/v1/runtime-catalog", env),
      read<ScoutCapabilityMatrixSnapshot>("/v1/capabilities", env),
      read<ScoutBrokerHealthPayload>("/health", env),
    ]);
    const candidate = capabilityRead.availability === "available" ? capabilityRead.value : null;
    const capabilities: CoreRead<ScoutCapabilityMatrixSnapshot> = capabilityRead.availability === "unavailable" ? capabilityRead
      : candidate && Number.isFinite(candidate.generatedAt) && Array.isArray(candidate.sources) && candidate.sources.every(v => v && typeof v.kind === "string")
        && Array.isArray(candidate.capabilities) && candidate.capabilities.every(v => v && typeof v.readiness?.state === "string")
        && Array.isArray(candidate.warnings) && candidate.warnings.every(v => typeof v === "string") ? capabilityRead
        : { availability: "unavailable", status: null, reason: "invalid_capability_response" };
    const parsed = live.availability === "available" ? parseScoutRuntimeCatalog(live.value?.catalog) : null;
    const runtimeCatalog = parsed?.ok ? parsed.catalog : SCOUT_RUNTIME_CATALOG;
    const defaultHarness = scoutRuntimeDefaultHarness(runtimeCatalog);
    const defaultModel = scoutRuntimeDefaultModel(defaultHarness ?? "", runtimeCatalog);
    const warnings = live.availability === "available" && Array.isArray(live.value?.warnings) ? live.value.warnings.filter((v): v is string => typeof v === "string") : [];
    return {
      currentDirectory, harnessCatalogPath: resolveOpenScoutSupportPaths().harnessCatalogPath,
      catalog, capabilities: capabilities.availability === "available" ? capabilities.value : null,
      readinessPolicy: "path_and_env_file_evidence_only", appReadiness: { availability: "unavailable", requiredForCore: false, reason: "private_app_not_inspected" },
      brokerReads: { catalog: parsed?.ok ? live : live.availability === "unavailable" ? live : { availability: "unavailable", status: null, reason: "invalid_runtime_catalog_response" }, capabilities },
      coreHealth: coreRuntimeHealth(health),
      runtimeCapabilities: {
        schemaVersion: "openscout.runtime-capabilities.v1", catalogVersion: runtimeCatalog.schemaVersion,
        catalogRevision: runtimeCatalog.revision, generatedAt: Date.now(), scope: "global",
        defaults: { ...(defaultHarness ? { harness: defaultHarness } : {}), model: defaultModel, reasoningEffort: scoutRuntimeDefaultReasoningEffort(defaultHarness ?? "", defaultModel, runtimeCatalog) },
        defaultsByHarness: scoutRuntimeDefaultsByHarness(runtimeCatalog),
        harnesses: runtimeCatalog.harnesses.filter(entry => entry.enabled && entry.listed !== false).map(entry => {
          const readiness = catalog.entries.find(candidate => candidate.harness === entry.id);
          return { id: entry.id, name: readiness?.name, label: entry.label, description: readiness?.description, state: readiness?.readinessReport.state, ready: readiness?.readinessReport.ready, detail: readiness?.readinessReport.detail };
        }),
        models: scoutRuntimeModelCatalog(runtimeCatalog).map(model => ({ ...model, harnesses: [...model.harnesses] })),
        efforts: scoutRuntimeEffortCatalog(runtimeCatalog).map(effort => ({ ...effort, harnesses: [...effort.harnesses], ...(effort.models ? { models: [...effort.models] } : {}) })),
        ...(warnings.length ? { warnings } : {}),
      },
    };
  });
}
