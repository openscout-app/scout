/** Read-only projection of supplied observations. No I/O or service control. */
import type { BrokerStartupTrafficGateSnapshot } from "./broker-startup-traffic-gate.js";
import type { FileBackedBrokerJournal, BrokerJournalWriteStatus } from "./broker-journal.js";
import type { SQLiteProjectionStatusSnapshot } from "./sqlite-projection.js";
import type { BrokerStorageMaintenance } from "./broker-storage-maintenance.js";
import type { BrokerStorageMonitor } from "./broker-storage-pressure.js";

export type CoreReportTarget = {
  instance: string;
  brokerUrl: string;
  /** Optional expected identity, never inferred from process presence. */
  expectedNodeId?: string;
};
/** Structural subset of existing /health; full supplied fields are retained. */
export type CoreReportHealthPayload = {
  ok: boolean;
  nodeId?: string | null;
  startup?: BrokerStartupTrafficGateSnapshot & {
    journal?: ReturnType<FileBackedBrokerJournal["startupStatus"]>;
  };
  projection?: SQLiteProjectionStatusSnapshot;
  storage?: { journal: BrokerJournalWriteStatus };
  memory?: {
    storage?: ReturnType<BrokerStorageMonitor["status"]>;
    storageMaintenance?: ReturnType<BrokerStorageMaintenance["status"]>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
export type CoreHealthObservation = {
  target: Pick<CoreReportTarget, "instance" | "brokerUrl">;
  checkedAt: number | null;
} & (
  | { state: "observed"; payload: CoreReportHealthPayload; status?: number }
  | { state: "not_checked" | "unavailable" | "timed_out" | "cancelled" | "refused" | "invalid_response";
      error?: string; status?: number; body?: unknown }
);
export const CORE_OPTIONAL_CAPABILITIES = Object.freeze(["app", "local_edge", "pty", "native_supervision"] as const);
export type CoreOptionalCapability = typeof CORE_OPTIONAL_CAPABILITIES[number];
export type CoreOptionalObservation =
  | { availability: "not_checked"; evidence: null }
  | { availability: "available" | "unavailable"; evidence: {
      source: string; observedAt: number; scope: "machine" | "selected_instance"; detail: string;
    } };
export type CoreHarnessPresence = {
  harness: string;
  state: "found" | "missing" | "not_checked";
  binaryPath: string | null;
  evidence: { source: string; observedAt: number } | null;
  authentication: "not_checked";
  readiness: "not_checked";
};
/** PATH/catalog presence is not authenticated execution. Never returns "ready". */
export function describeCoreHarnessPresence(input: {
  harness: string;
  observation?: { binaryPath: string | null; source: string; observedAt: number };
}): CoreHarnessPresence {
  return {
    harness: input.harness,
    state: input.observation ? input.observation.binaryPath ? "found" : "missing" : "not_checked",
    binaryPath: input.observation?.binaryPath ?? null,
    evidence: input.observation ? { source: input.observation.source, observedAt: input.observation.observedAt } : null,
    authentication: "not_checked", readiness: "not_checked",
  };
}
export type CoreReportCheck = {
  name: "health" | "startup" | "projection" | "journal" | "storage";
  state: "working" | "starting" | "impaired" | "inconclusive" | "not_checked";
  detail: string;
};
export type CoreServiceReport = {
  schema: "scout.core-report/v1";
  observedAt: number;
  target: CoreReportTarget;
  /** Endpoint evidence is not an installed/loaded/owned service status. */
  custody: "not_assessed";
  service: {
    state: "working" | "starting" | "impaired" | "inconclusive";
    identity: "matched" | "unverified" | "mismatch";
    checks: CoreReportCheck[];
    health: CoreHealthObservation;
  };
  optional: Record<CoreOptionalCapability, CoreOptionalObservation>;
  harnesses: CoreHarnessPresence[];
};

export function buildCoreServiceReport(input: {
  target: CoreReportTarget;
  health: CoreHealthObservation;
  optional?: Partial<Record<CoreOptionalCapability, CoreOptionalObservation>>;
  harnesses?: readonly CoreHarnessPresence[];
  now?: number;
}): CoreServiceReport {
  // Snapshot caller data: later mutations cannot rewrite the evidence/result.
  const target = structuredClone(input.target), health = structuredClone(input.health);
  const optional = Object.fromEntries(CORE_OPTIONAL_CAPABILITIES.map(name =>
    [name, structuredClone(input.optional?.[name] ?? { availability: "not_checked", evidence: null })],
  )) as CoreServiceReport["optional"];
  const checks: CoreReportCheck[] = [];
  const add = (name: CoreReportCheck["name"], state: CoreReportCheck["state"], detail: string) => checks.push({ name, state, detail });
  const bound = Boolean(target.instance.trim() && target.brokerUrl.trim())
    && health.target.instance === target.instance && health.target.brokerUrl === target.brokerUrl;
  const payload = health.state === "observed" ? health.payload : null;
  const node = payload?.nodeId;
  const identity: CoreServiceReport["service"]["identity"] = !bound || (target.expectedNodeId && typeof node === "string" && node !== target.expectedNodeId)
    ? "mismatch" : target.expectedNodeId && node === target.expectedNodeId ? "matched" : "unverified";
  if (identity === "mismatch") {
    add("health", "inconclusive", "Observation does not match the selected endpoint, instance or expected node.");
  } else if (payload && target.expectedNodeId && identity !== "matched") {
    add("health", "inconclusive", "Health did not identify the expected node; selected-core readiness is unverified.");
  } else if (!payload || typeof payload.ok !== "boolean") {
    add("health", health.state === "not_checked" ? "not_checked" : "inconclusive",
      "No valid health response for the selected core; absence, timeout or refusal does not prove it stopped.");
  } else {
    const successStatus = health.status === undefined || (health.status >= 200 && health.status < 300);
    const validTime = health.checkedAt !== null && Number.isFinite(health.checkedAt) && health.checkedAt >= 0;
    add("health", !payload.ok || !successStatus ? "impaired" : validTime ? "working" : "inconclusive",
      !successStatus ? "Observed health payload arrived with a non-success HTTP status."
        : !payload.ok ? "Core reported unhealthy liveness." : validTime ? "Core liveness responded OK." : "Health observation time is unknown.");
    const startup = payload.startup;
    if (!startup) add("startup", "not_checked", "Startup evidence was not supplied.");
    else if (startup.error || startup.phase === "failed" || startup.state === "degraded"
      || startup.journal?.phase === "failed" || startup.journal?.error || startup.journal?.compactionDeferral) {
      add("startup", "impaired", "Startup or journal replay reported failure.");
    } else if (startup.state === "restoring" || startup.mutationsAdmitted === false
      || startup.coreReady === false || startup.historyReady === false
      || (startup.journal && startup.journal.phase !== "complete")) {
      add("startup", "starting", "Core recovery has not admitted all ordinary traffic.");
    } else add("startup", startup.state === "ready" && startup.mutationsAdmitted === true ? "working" : "inconclusive",
      "Startup admission evidence supplied.");

    const projection = payload.projection;
    if (!projection) add("projection", "not_checked", "Projection evidence was not supplied.");
    else if (projection.state === "degraded" || projection.state === "disabled"
      || (projection.quarantine
        ? (projection.quarantine.openCount ?? 0) + (projection.quarantine.deferredCount ?? 0) > 0
        : (projection.skips?.total ?? 0) > 0)) {
      add("projection", "impaired", "Core projection is unavailable, degraded, or has unapplied/quarantined records.");
    } else add("projection", projection.state === "ready" ? "working" : projection.state === "warming" ? "starting" : "inconclusive",
      "Projection state supplied.");

    const journal = payload.storage?.journal;
    add("journal", !journal ? "not_checked" : journal.state === "failing" ? "impaired" : journal.state === "ok" ? "working" : "inconclusive",
      !journal ? "Journal write evidence was not supplied." : journal.state === "failing"
        ? "Canonical journal writes are failing; liveness alone is not write readiness." : "Journal write state supplied.");

    const storage = payload.memory?.storage;
    const maintenanceFailure = payload.memory?.storageMaintenance?.phase === "error" || Boolean(payload.memory?.storageMaintenance?.lastError);
    add("storage", maintenanceFailure ? "impaired" : !storage ? "not_checked" : storage.state === "critical" || storage.state === "maintenance_needed" ? "impaired"
      : storage.detail || storage.state !== "ready" || (storage.checkedAt === null || !Number.isFinite(storage.checkedAt)) ? "inconclusive" : "working",
      maintenanceFailure ? "Core storage maintenance reported failure." : !storage ? "Cached storage evidence was not supplied." : storage.state === "critical" || storage.state === "maintenance_needed"
        ? "Core storage has disk pressure or requires maintenance." : "Cached storage measurement supplied; no new filesystem probe.");
  }
  for (const name of ["startup", "projection", "journal", "storage"] as const) {
    if (!checks.some(check => check.name === name)) add(name, "not_checked", "No matching core health evidence.");
  }
  const state = checks.some(check => check.state === "impaired") ? "impaired"
    : checks.some(check => check.state === "starting") ? "starting"
      : checks.some(check => check.state === "inconclusive" || check.state === "not_checked") ? "inconclusive" : "working";
  return {
    schema: "scout.core-report/v1", observedAt: input.now ?? Date.now(), target, custody: "not_assessed",
    service: { state, identity, checks, health }, optional,
    // Re-project presence rather than trusting a caller-supplied readiness label.
    harnesses: (input.harnesses ?? []).map(row => describeCoreHarnessPresence({
      harness: row.harness, ...(row.evidence ? { observation: { ...row.evidence, binaryPath: row.binaryPath } } : {}),
    })),
  };
}

export type CoreSetupCompletion = {
  schema: "scout.core-setup-completion/v1";
  scope: "core";
  outcome: "complete" | "pending" | "failed";
  headline: string;
  nextStep: string;
  failures: string[];
  report: CoreServiceReport;
};
/** Core completion does not depend on an app or an authenticated harness.
 * Supply only failures of required core setup operations, not optional offers. */
export function assessCoreSetupCompletion(input: {
  report: CoreServiceReport;
  failures?: readonly string[];
}): CoreSetupCompletion {
  const report = buildCoreServiceReport({
    target: input.report.target, health: input.report.service.health,
    optional: input.report.optional, harnesses: input.report.harnesses, now: input.report.observedAt,
  });
  const failures = [...(input.failures ?? [])];
  const failed = failures.length > 0 || report.service.state === "impaired";
  const identityConfirmed = Boolean(report.target.expectedNodeId?.trim()) && report.service.identity === "matched";
  const outcome = failed ? "failed" : report.service.state === "working" && identityConfirmed ? "complete" : "pending";
  const unsupplied = report.service.checks.filter(check => check.state === "not_checked").map(check => check.name);
  const onlyUnsupplied = unsupplied.length > 0
    && report.service.checks.every(check => check.state === "working" || check.state === "not_checked");
  const pendingReasons = [
    ...(!identityConfirmed ? [report.target.expectedNodeId?.trim()
      ? "Scout core identity is unverified for the selected instance and expected node."
      : "Scout core identity is unverified: no expected node was supplied."] : []),
    ...(onlyUnsupplied ? [`Health did not supply these checks: ${unsupplied.join(", ")}.`] : []),
  ];
  return {
    schema: "scout.core-setup-completion/v1", scope: "core", outcome, report, failures,
    headline: failed ? "Scout core needs attention." : outcome === "complete"
      ? "Scout core is available. Coding-agent sign-in has not been checked."
      : pendingReasons.join(" ") || "Scout core readiness is not confirmed.",
    nextStep: outcome !== "complete" ? "scout doctor" : report.harnesses.some(row => row.state === "found") ? "scout whoami" : "scout runtimes",
  };
}
