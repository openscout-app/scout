import { SCOUT_MODEL_TASTE, resolveScoutModelTaste, type ScoutModelTaste } from "./model-taste.js";
import { SCOUT_RUNTIME_CATALOG } from "./runtime-execution.js";
import type { ScoutOwnedRuntimeCatalog } from "./runtime-catalog-contract.js";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export const ORCHESTRATION_ROLE_IDS = [
  "product_judgment",
  "large_context_synthesis",
  "adversarial_critique",
  "evidence_inventory",
  "implementation",
  "code_review",
] as const;

export type OrchestrationRoleId = typeof ORCHESTRATION_ROLE_IDS[number];
export type QuotaPacingStatus = "underused" | "on_track" | "ahead" | "unknown";
export type QuotaAvailability = "abundant" | "available" | "guarded" | "constrained" | "unknown";
export type QuotaTelemetryConfidence = "fresh" | "stale" | "unknown";
export const ORCHESTRATION_ROUTING_BIASES = ["capability", "balanced", "quota"] as const;
export type OrchestrationRoutingBias = typeof ORCHESTRATION_ROUTING_BIASES[number];

export type ProviderUsageForMapping = {
  generatedAt: number;
  generatedAtLocal: string;
  providers: Array<{
    id: string;
    label: string;
    plan: string | null;
    windows: Array<{
      label: string;
      usedPercent: number;
      percentRemaining: number;
      windowMs?: number | null;
      resetAt: number | null;
      resetIn: string;
      freshness: {
        ageMs: number | null;
        label: string;
      };
    }>;
  }>;
};

export type QuotaWindowPacing = {
  label: string;
  usedPercent: number;
  percentRemaining: number;
  durationMs: number | null;
  elapsedPercent: number | null;
  paceRatio: number | null;
  projectedUsedPercent: number | null;
  status: QuotaPacingStatus;
  resetAt: number | null;
  resetIn: string;
  freshness: string;
  confidence: QuotaTelemetryConfidence;
};

export type ProviderPacingSummary = {
  providerId: string;
  providerLabel: string;
  plan: string | null;
  availability: QuotaAvailability;
  pacing: QuotaPacingStatus;
  confidence: QuotaTelemetryConfidence;
  minimumRemainingPercent: number | null;
  bindingWindow: string | null;
  nextResetAt: number | null;
  nextResetIn: string;
  windows: QuotaWindowPacing[];
};

export type OrchestrationRuntimeRoute = {
  providerId: string;
  harness: string;
  model: string | null;
  effort: string | null;
  profile: string | null;
};

export type OrchestrationRuntimeAlternative = {
  label: string;
  route: OrchestrationRuntimeRoute;
  score: number;
  fit: number;
  capability: string;
  caution: string;
  taskRationale: string;
  quotaRisk: boolean;
  quota: ProviderPacingSummary;
};

export type OrchestrationRuntimeAssignment = {
  role: OrchestrationRoleId;
  roleLabel: string;
  modelLabel: string;
  route: OrchestrationRuntimeRoute;
  score: number;
  fit: number;
  objective: string;
  taskRationale: string;
  capability: string;
  caution: string;
  assertion: string;
  quotaRisk: boolean;
  quotaRiskMessage: string | null;
  quota: ProviderPacingSummary;
  alternatives: OrchestrationRuntimeAlternative[];
};

export type OrchestrationModelGuidanceStatus =
  | "use_now"
  | "available"
  | "use_deliberately"
  | "probe_first"
  | "conserve";

export type OrchestrationModelGuidance = {
  modelLabel: string;
  route: OrchestrationRuntimeRoute;
  roles: Array<{ role: OrchestrationRoleId; label: string }>;
  strengths: string[];
  cautions: string[];
  guidance: OrchestrationModelGuidanceStatus;
  quotaRisk: boolean;
  quota: ProviderPacingSummary;
};

export type OrchestrationProviderMap = {
  generatedAt: number;
  generatedAtLocal: string;
  evaluatedAt: number;
  assignments: OrchestrationRuntimeAssignment[];
  bias: OrchestrationRoutingBias;
  models: OrchestrationModelGuidance[];
};

type RuntimeDefinition = {
  label: string;
  route: OrchestrationRuntimeRoute;
  capability: string;
  caution: string;
};

type RuntimeCandidate = RuntimeDefinition & {
  fit: number;
  taskRationale: string;
};

type RolePolicy = {
  label: string;
  objective: string;
  strategy: string;
  candidates: RuntimeCandidate[];
};

function rolePolicies(taste: ScoutModelTaste, catalog: ScoutOwnedRuntimeCatalog): Record<OrchestrationRoleId, RolePolicy> {
  const runtimes = resolveScoutModelTaste(taste, catalog);
  return Object.fromEntries(Object.entries(taste.roles).map(([id, role]) => [id, {
    label: role.label, objective: role.objective, strategy: role.strategy,
    // A candidate whose runtime the catalog cannot route is not offered.
    candidates: role.candidates.flatMap(candidate => {
      const runtime = runtimes[candidate.runtime];
      return runtime ? [{ ...runtime, fit: candidate.fit, taskRationale: candidate.rationale }] : [];
    }),
  }])) as Record<OrchestrationRoleId, RolePolicy>;
}

export function isOrchestrationRoleId(value: string): value is OrchestrationRoleId {
  return (ORCHESTRATION_ROLE_IDS as readonly string[]).includes(value);
}

export function isQuotaRisk(quota: ProviderPacingSummary): boolean {
  if (quota.availability === "constrained" || quota.availability === "guarded") return true;
  if (quota.minimumRemainingPercent !== null && quota.minimumRemainingPercent <= 20) return true;
  if (quota.pacing === "ahead" && (quota.minimumRemainingPercent ?? 100) <= 35) return true;
  return false;
}

export function isQuotaSafe(quota: ProviderPacingSummary): boolean {
  return quota.confidence === "fresh"
    && quota.minimumRemainingPercent !== null
    && !isQuotaRisk(quota);
}

export function quotaRiskDescription(quota: ProviderPacingSummary): string | null {
  if (!isQuotaRisk(quota)) return null;
  if (quota.minimumRemainingPercent !== null && quota.minimumRemainingPercent <= 15) {
    return `${quota.providerLabel} is near capacity (${quota.minimumRemainingPercent}% remaining). High risk of quota exhaustion.`;
  }
  if (quota.pacing === "ahead") {
    return `${quota.providerLabel} consumption rate exceeds window pace with limited buffer.`;
  }
  return `${quota.providerLabel} quota availability is ${quota.availability}. Failover recommended.`;
}

export function orchestrationRuntimeRouteKey(route: OrchestrationRuntimeRoute): string {
  return [route.providerId, route.harness, route.model, route.effort, route.profile].join("|");
}

export function orchestrationRuntimeRouteLabel(route: OrchestrationRuntimeRoute): string {
  return [
    route.profile ? `profile ${route.profile}` : route.harness,
    route.model,
    route.effort,
  ].filter(Boolean).join(" / ");
}

export function buildOrchestrationAskArguments(
  route: OrchestrationRuntimeRoute,
  request = "<request>",
): string[] {
  const normalizedProfile = route.profile?.trim().toLowerCase() ?? null;
  const profileCanSelectExactModel = normalizedProfile !== "opencode" && normalizedProfile !== "oc";
  const args = route.profile && profileCanSelectExactModel
    ? ["--profile", route.profile]
    : [
        "--harness",
        route.harness,
        ...(route.model ? ["--model", route.model] : []),
      ];
  if (route.effort) args.push("--effort", route.effort);
  args.push(request);
  return args;
}

export function renderOrchestrationAskCommand(
  route: OrchestrationRuntimeRoute,
  request = "<request>",
): string {
  return ["scout", "ask", ...buildOrchestrationAskArguments(route, request)]
    .map(shellQuoteArgument)
    .join(" ");
}

export function buildOrchestrationProviderMap(
  report: ProviderUsageForMapping,
  options: {
    now?: number;
    role?: OrchestrationRoleId | null;
    bias?: OrchestrationRoutingBias;
    taste?: ScoutModelTaste;
    catalog?: ScoutOwnedRuntimeCatalog;
  } = {},
): OrchestrationProviderMap {
  const now = finiteNumber(options.now) ?? Date.now();
  const bias = options.bias ?? "balanced";
  const quotaWeight = routingBiasWeight(bias);
  const policies = rolePolicies(options.taste ?? SCOUT_MODEL_TASTE, options.catalog ?? SCOUT_RUNTIME_CATALOG);
  const summaries = new Map(
    report.providers.map((provider) => [provider.id, summarizeProviderPacing(provider, now)]),
  );
  const roles = options.role ? [options.role] : [...ORCHESTRATION_ROLE_IDS];
  // A role with no routable candidate gets no assignment rather than a guess.
  const assignments = roles.flatMap((role) => {
    const policy = policies[role];
    const ranked = policy.candidates
      .map((runtime) => {
        const quota = summaries.get(runtime.route.providerId) ?? unknownProviderSummary(runtime.route.providerId);
        return { runtime, quota, score: runtime.fit + quotaScoreAdjustment(quota, now) * quotaWeight };
      })
      .sort((left, right) => right.score - left.score || right.runtime.fit - left.runtime.fit);
    const selected = ranked[0];
    if (!selected) return [];
    const quotaRisk = isQuotaRisk(selected.quota);
    const alternatives = ranked.slice(1);
    if (quotaRisk) {
      alternatives.sort((left, right) => {
        const leftRank = fallbackPreference(left, selected.runtime.route.providerId);
        const rightRank = fallbackPreference(right, selected.runtime.route.providerId);
        return leftRank - rightRank || right.score - left.score || right.runtime.fit - left.runtime.fit;
      });
    }
    return [{
      role,
      roleLabel: policy.label,
      modelLabel: selected.runtime.label,
      route: selected.runtime.route,
      score: selected.score,
      fit: selected.runtime.fit,
      objective: policy.objective,
      taskRationale: selected.runtime.taskRationale,
      capability: selected.runtime.capability,
      caution: selected.runtime.caution,
      assertion: providerAssertion(selected.quota),
      quotaRisk,
      quotaRiskMessage: quotaRiskDescription(selected.quota),
      quota: selected.quota,
      alternatives: alternatives.slice(0, 2).map(({ runtime, quota, score }) => ({
        label: runtime.label,
        route: runtime.route,
        score,
        fit: runtime.fit,
        capability: runtime.capability,
        caution: runtime.caution,
        taskRationale: runtime.taskRationale,
        quotaRisk: isQuotaRisk(quota),
        quota,
      })),
    }];
  });
  const models = buildModelGuidance(roles, summaries, now, policies);

  return {
    generatedAt: report.generatedAt,
    generatedAtLocal: report.generatedAtLocal,
    evaluatedAt: now,
    assignments,
    models,
    bias,
  };
}

function buildModelGuidance(
  roles: OrchestrationRoleId[],
  summaries: Map<string, ProviderPacingSummary>,
  now: number,
  policies: Record<OrchestrationRoleId, RolePolicy>,
): OrchestrationModelGuidance[] {
  const models = new Map<string, {
    runtime: RuntimeDefinition;
    roles: Array<{ role: OrchestrationRoleId; label: string }>;
  }>();

  for (const role of roles) {
    const policy = policies[role];
    for (const candidate of policy.candidates) {
      const key = orchestrationRuntimeRouteKey(candidate.route);
      const existing = models.get(key);
      if (existing) {
        existing.roles.push({ role, label: policy.label });
      } else {
        models.set(key, {
          runtime: candidate,
          roles: [{ role, label: policy.label }],
        });
      }
    }
  }

  return [...models.values()].map(({ runtime, roles: mappedRoles }) => {
    const quota = summaries.get(runtime.route.providerId) ?? unknownProviderSummary(runtime.route.providerId);
    return {
      modelLabel: runtime.label,
      route: runtime.route,
      roles: mappedRoles,
      strengths: [runtime.capability],
      cautions: [runtime.caution],
      guidance: modelGuidanceStatus(quota, now),
      quotaRisk: isQuotaRisk(quota),
      quota,
    };
  });
}

export function renderOrchestrationProviderMap(map: OrchestrationProviderMap): string {
  const lines = [
    `Orchestration map · quota-aware · ${map.bias} bias · generated ${map.generatedAtLocal}`,
    "Dispatch roles are recommendations, not durable `scout role` assignments.",
  ];

  for (const assignment of map.assignments) {
    lines.push("", assignment.roleLabel);
    lines.push(`  ${assignment.modelLabel} · ${formatRoute(assignment.route)}`);
    lines.push(`  ${assignment.capability}`);
    lines.push(`  ${assignment.assertion}`);
    if (assignment.alternatives.length > 0) {
      lines.push(`  Alternatives: ${assignment.alternatives.map((alternative) => alternative.label).join(" · ")}`);
    }
  }

  return lines.join("\n");
}

export function summarizeProviderPacing(
  provider: ProviderUsageForMapping["providers"][number],
  now: number,
): ProviderPacingSummary {
  const windows = provider.windows
    .filter((window) => !/^video\b/iu.test(window.label))
    .map((window) => paceQuotaWindow(window, now));
  const binding = [...windows].sort((left, right) => left.percentRemaining - right.percentRemaining)[0] ?? null;
  const paced = windows
    .filter((window) => window.paceRatio !== null)
    .sort((left, right) => right.paceRatio! - left.paceRatio!)[0] ?? null;
  const confidences = windows.map((window) => window.confidence);
  const confidence: QuotaTelemetryConfidence = confidences.includes("stale")
    ? "stale"
    : confidences.includes("fresh")
      ? "fresh"
      : "unknown";
  const nextReset = [...windows]
    .filter((window) => window.resetAt !== null && window.resetAt > now)
    .sort((left, right) => left.resetAt! - right.resetAt!)[0] ?? null;
  const minimumRemainingPercent = binding?.percentRemaining ?? null;

  return {
    providerId: provider.id,
    providerLabel: provider.label,
    plan: provider.plan,
    availability: availabilityFromRemaining(minimumRemainingPercent),
    pacing: paced?.status ?? "unknown",
    confidence,
    minimumRemainingPercent,
    bindingWindow: binding?.label ?? null,
    nextResetAt: nextReset?.resetAt ?? null,
    nextResetIn: nextReset?.resetIn ?? "",
    windows,
  };
}

function paceQuotaWindow(
  window: ProviderUsageForMapping["providers"][number]["windows"][number],
  now: number,
): QuotaWindowPacing {
  const durationMs = finiteNumber(window.windowMs) ?? inferWindowDurationMs(window.label, window.resetAt);
  const elapsedPercent = durationMs !== null && window.resetAt !== null
    ? roundPercent(clamp(100 - ((window.resetAt - now) / durationMs) * 100, 0, 100))
    : null;
  const paceRatio = elapsedPercent !== null && elapsedPercent >= 1
    ? roundRatio(window.usedPercent / elapsedPercent)
    : null;
  const projectedUsedPercent = paceRatio === null ? null : roundPercent(paceRatio * 100);
  const status = pacingStatus(window.usedPercent, elapsedPercent, paceRatio);
  const staleAfterMs = durationMs === null ? DAY_MS : Math.min(DAY_MS, Math.max(HOUR_MS, durationMs / 4));
  const confidence: QuotaTelemetryConfidence = window.freshness.ageMs === null
    ? "unknown"
    : window.freshness.ageMs > staleAfterMs
      ? "stale"
      : "fresh";

  return {
    label: window.label,
    usedPercent: window.usedPercent,
    percentRemaining: window.percentRemaining,
    durationMs,
    elapsedPercent,
    paceRatio,
    projectedUsedPercent,
    status,
    resetAt: window.resetAt,
    resetIn: window.resetIn,
    freshness: window.freshness.label,
    confidence,
  };
}

function modelGuidanceStatus(
  quota: ProviderPacingSummary,
  now: number,
): OrchestrationModelGuidanceStatus {
  if (isQuotaRisk(quota)) return "conserve";
  if (quota.confidence !== "fresh") return "probe_first";
  if (quota.availability === "constrained") return "conserve";
  if (
    quota.nextResetAt !== null
    && quota.nextResetAt > now
    && quota.nextResetAt - now <= DAY_MS
    && quota.pacing !== "ahead"
    && (quota.minimumRemainingPercent ?? 0) >= 10
  ) {
    return "use_now";
  }
  if (quota.availability === "guarded") return "conserve";
  if (quota.pacing === "ahead") return "use_deliberately";
  if (quota.availability === "abundant" && quota.pacing === "underused") return "use_now";
  return "available";
}

function routingBiasWeight(bias: OrchestrationRoutingBias): number {
  switch (bias) {
    case "capability": return 0.25;
    case "quota": return 1.75;
    case "balanced": return 1;
  }
}

function quotaScoreAdjustment(quota: ProviderPacingSummary, now: number): number {
  let score = 0;
  switch (quota.availability) {
    case "abundant": score += 10; break;
    case "available": score += 5; break;
    case "guarded": score -= 5; break;
    case "constrained": score -= 30; break;
    case "unknown": score -= 2; break;
  }
  if (quota.pacing === "underused") score += 5;
  if (quota.pacing === "ahead") score -= 8;
  if (quota.confidence === "stale") score -= 8;
  if (quota.confidence === "unknown") score -= 3;
  if (
    quota.pacing === "underused"
    && quota.nextResetAt !== null
    && quota.nextResetAt > now
    && quota.nextResetAt - now <= 2 * DAY_MS
  ) {
    score += 3;
  }
  return score;
}

function providerAssertion(quota: ProviderPacingSummary): string {
  if (quota.minimumRemainingPercent === null) {
    return `${titleCase(quota.providerId)} quota telemetry unavailable; use a bounded canary before scaling.`;
  }
  const pace = quota.pacing === "on_track"
    ? "usage tracks elapsed time"
    : quota.pacing === "underused"
      ? "usage trails elapsed time"
      : quota.pacing === "ahead"
        ? "usage exceeds elapsed time"
        : "pace unknown";
  const reset = quota.nextResetIn ? ` · next reset ${quota.nextResetIn}` : "";
  return `${formatPercent(quota.minimumRemainingPercent)} minimum remaining · ${pace} · telemetry ${quota.confidence}${reset}.`;
}

function unknownProviderSummary(providerId: string): ProviderPacingSummary {
  return {
    providerId,
    providerLabel: titleCase(providerId),
    plan: null,
    availability: "unknown",
    pacing: "unknown",
    confidence: "unknown",
    minimumRemainingPercent: null,
    bindingWindow: null,
    nextResetAt: null,
    nextResetIn: "",
    windows: [],
  };
}

function inferWindowDurationMs(label: string, resetAt: number | null): number | null {
  const normalized = label.trim().toLowerCase();
  const duration = normalized.match(/(?:^|\s)(\d+(?:\.\d+)?)([hd])$/u);
  if (duration) {
    const value = Number(duration[1]);
    return duration[2] === "h" ? value * HOUR_MS : value * DAY_MS;
  }
  if (normalized === "weekly" || normalized === "week" || normalized === "7-day") return 7 * DAY_MS;
  if (normalized === "5-hour") return 5 * HOUR_MS;
  if (normalized === "monthly" || normalized === "month") {
    if (resetAt === null) return 30 * DAY_MS;
    const reset = new Date(resetAt);
    const prior = new Date(resetAt);
    prior.setUTCMonth(prior.getUTCMonth() - 1);
    const calendarDuration = reset.getTime() - prior.getTime();
    return calendarDuration > 0 ? calendarDuration : 30 * DAY_MS;
  }
  return null;
}

function pacingStatus(
  usedPercent: number,
  elapsedPercent: number | null,
  paceRatio: number | null,
): QuotaPacingStatus {
  if (elapsedPercent === null || paceRatio === null) return "unknown";
  const delta = usedPercent - elapsedPercent;
  if (paceRatio > 1.1 && delta > 3) return "ahead";
  if (paceRatio < 0.7 && delta < -10) return "underused";
  return "on_track";
}

function availabilityFromRemaining(remaining: number | null): QuotaAvailability {
  if (remaining === null) return "unknown";
  if (remaining >= 60) return "abundant";
  if (remaining >= 30) return "available";
  if (remaining >= 15) return "guarded";
  return "constrained";
}

function formatRoute(route: OrchestrationRuntimeRoute): string {
  return orchestrationRuntimeRouteLabel(route);
}

function fallbackPreference(
  candidate: { runtime: RuntimeCandidate; quota: ProviderPacingSummary },
  selectedProviderId: string,
): number {
  const quotaSafe = isQuotaSafe(candidate.quota);
  const providerDiverse = candidate.runtime.route.providerId !== selectedProviderId;
  if (quotaSafe && providerDiverse) return 0;
  if (quotaSafe) return 1;
  if (providerDiverse) return 2;
  return 3;
}

function shellQuoteArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ") || "Unknown";
}

function formatPercent(value: number): string {
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10;
}

function roundRatio(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
