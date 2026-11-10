import { scoutRuntimeHarness, scoutRuntimeLatestModelInFamily } from "./runtime-execution.js";

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

// Each slot follows the catalog: the newest enabled model in its family (or
// Codex tier), so a catalog update moves routing without editing this file.
// The fallback applies only when the catalog has no match.
type CatalogPick = { id: string; label: string };

function catalogModel(
  harness: string,
  matches: (model: { id: string; family?: string; label: string }) => boolean,
  fallback: CatalogPick,
  label: (model: { id: string; label: string; version?: string }) => string = (model) => model.label,
): CatalogPick {
  const models = (scoutRuntimeHarness(harness)?.models ?? []).filter((model) => model.enabled && matches(model));
  const model = models.find((entry) => entry.default) ?? models[0];
  return model ? { id: model.id, label: label(model) } : fallback;
}

function claudeFamily(family: string, fallback: CatalogPick): CatalogPick {
  const id = scoutRuntimeLatestModelInFamily("claude", family);
  const model = scoutRuntimeHarness("claude")?.models.find((entry) => entry.id === id);
  return model ? { id: model.id, label: model.label } : fallback;
}

/** Codex tiers share the GPT family; the id suffix names the tier. Catalog order is newest first. */
function codexTier(tier: string, fallback: CatalogPick): CatalogPick {
  return catalogModel(
    "codex",
    (model) => model.id.endsWith(`-${tier}`),
    fallback,
    (model) => `GPT-${model.version ?? model.label}`,
  );
}

function familyModel(harness: string, family: string, fallback: CatalogPick): CatalogPick {
  return catalogModel(harness, (model) => model.family === family, fallback);
}

const FABLE = claudeFamily("Fable", { id: "claude-fable-5", label: "Fable 5" });
const OPUS = claudeFamily("Opus", { id: "claude-opus-5-5", label: "Opus 5.5" });
const SONNET = claudeFamily("Sonnet", { id: "claude-sonnet-4-6", label: "Sonnet 4.6" });
const HAIKU = claudeFamily("Haiku", { id: "claude-haiku-4-5", label: "Haiku 4.5" });
const ASTRA = codexTier("astra", { id: "gpt-6-astra", label: "GPT-6 Astra" });
const SOL = codexTier("sol", { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" });
const LUNA = codexTier("luna", { id: "gpt-6-luna", label: "GPT-6 Luna" });
const GROK = familyModel("grok", "Grok", { id: "grok-4.6", label: "Grok 4.6" });
const GLM = familyModel("opencode", "GLM", { id: "opencode-go/glm-5.2", label: "GLM-5.2" });
const MINIMAX = familyModel("opencode", "MiniMax", { id: "opencode-go/minimax-m3", label: "MiniMax M3" });
const DEEPSEEK = familyModel("opencode", "DeepSeek", { id: "opencode-go/deepseek-v4-pro", label: "DeepSeek V4 Pro" });
const DEVIN = familyModel("devin", "SWE", { id: "swe-2-high", label: "SWE-2 High" });

const RUNTIMES = {
  fable: runtimeDefinition(
    FABLE.label, "claude", "claude", FABLE.id, "max", "Fable",
    "Product taste, design iteration, and premise-level critique.",
    "Spends the premium shared Claude allowance; keep it off routine mechanical work.",
  ),
  opus: runtimeDefinition(
    OPUS.label, "claude", "claude", OPUS.id, "high", "Opus",
    "Long-context synthesis, architecture, and coherent product reasoning.",
    "Premium shared Claude quota; avoid routine scans and repeated verification.",
  ),
  sonnet: runtimeDefinition(
    SONNET.label, "claude", "claude", SONNET.id, "high", null,
    "Strong generalist implementation with fast turns.",
    "Shares Claude's allowance; a poor pick while that pool is guarded.",
  ),
  haiku: runtimeDefinition(
    HAIKU.label, "claude", "claude", HAIKU.id, "low", null,
    "Fast narrow scans and classification inside the Claude harness.",
    "Light reasoning; a poor fit for broad synthesis.",
  ),
  astra: runtimeDefinition(
    ASTRA.label, "codex", "codex", ASTRA.id, "high", null,
    "Codex's most capable tier: hard reasoning, review, and research.",
    "The costliest Codex tier; use Sol for routine implementation.",
  ),
  sol: runtimeDefinition(
    SOL.label, "codex", "codex", SOL.id, "xhigh", null,
    "Load-bearing coding, multi-file refactors, debugging, and integration.",
    "Deep turns spend Codex quota quickly; keep them for work where failure is expensive.",
  ),
  luna: runtimeDefinition(
    LUNA.label, "codex", "codex", LUNA.id, "medium", null,
    "Inexpensive source mapping, test enumeration, and repeatable audit work.",
    "Keep it out of sole high-stakes judgment and final acceptance.",
  ),
  grok: runtimeDefinition(
    GROK.label, "grok", "grok", GROK.id, null, "Grok",
    "Independent assumption checking, deletion pressure, and adversarial critique.",
    "Not the sole implementation authority; check conclusions against the repository.",
  ),
  kimi: runtimeDefinition(
    "Kimi Code", "kimi", "kimi", null, null, "Kimi",
    "Dense repository and study synthesis through the native Kimi harness.",
    "The harness picks the model and quota telemetry can be stale; probe before a large fan-out.",
  ),
  glm: runtimeDefinition(
    GLM.label, "opencode", "opencode", GLM.id, null, "OpenCode",
    "Independent broad-context synthesis through OpenCode.",
    "OpenCode quota is not visible in Scout; start with a bounded canary.",
  ),
  minimax: runtimeDefinition(
    MINIMAX.label, "minimax", "opencode", MINIMAX.id, null, "OpenCode",
    "Cost-effective structured evidence collection and comparison.",
    "Verify load-bearing conclusions with a stronger reviewer.",
  ),
  deepseek: runtimeDefinition(
    DEEPSEEK.label, "opencode", "opencode", DEEPSEEK.id, null, "OpenCode",
    "Code-level review from an independent model lineage.",
    "Quota is opaque; not the sole acceptance authority.",
  ),
  devin: runtimeDefinition(
    `Devin ${DEVIN.label}`, "devin", "devin", DEVIN.id, null, null,
    "Autonomous implementation in its own environment.",
    "Devin quota is not visible in Scout; review its changes before they land.",
  ),
} as const;

// Each role's candidates come from three different provider pools, so a
// quota failover always lands on a fresh allowance and a different lineage.
const ROLE_POLICIES: Record<OrchestrationRoleId, RolePolicy> = {
  product_judgment: {
    label: "Product judgment",
    objective: "Strategic tradeoffs, UX prioritization, scope shaping, and high-level product decisions.",
    strategy: "Prefer models with product taste and clear tradeoff reasoning.",
    candidates: [
      roleCandidate("fable", 100, "Product taste, fast design iteration, and clear UX direction."),
      roleCandidate("astra", 92, "Technically grounded product decisions with execution realism."),
      roleCandidate("grok", 82, "An unfiltered view of feature bloat and scope."),
    ],
  },
  large_context_synthesis: {
    label: "Large-context synthesis",
    objective: "Repository-wide investigations, architectural archaeology, and multi-file synthesis.",
    strategy: "Prefer large effective context windows, and keep premium pools for work that needs them.",
    candidates: [
      roleCandidate("kimi", 100, "Native long-context retrieval on its own allowance."),
      roleCandidate("opus", 96, "Deep structural understanding across multi-package repositories."),
      roleCandidate("astra", 90, "A very large window with strong reasoning over it."),
    ],
  },
  adversarial_critique: {
    label: "Adversarial critique",
    objective: "Challenging design assumptions, finding UX and logic gaps, and applying deletion pressure.",
    strategy: "Prefer a lineage other than the authors', so critique is independent rather than agreeable.",
    candidates: [
      roleCandidate("grok", 100, "A contrarian lineage, edge-case discovery, and premise challenge."),
      roleCandidate("fable", 94, "Design critique and UX stress-testing."),
      roleCandidate("deepseek", 84, "A third lineage for a second opinion."),
    ],
  },
  evidence_inventory: {
    label: "Evidence inventory",
    objective: "Grep and AST inventory, reference tracing, log audit, and structured fact collection.",
    strategy: "Prefer fast, inexpensive models with precise structured output.",
    candidates: [
      roleCandidate("luna", 100, "Low-cost source tracing, test inventory, and reference mapping."),
      roleCandidate("haiku", 94, "Fast mechanical scans and categorization."),
      roleCandidate("minimax", 90, "Cost-effective evidence indexing and pattern enumeration."),
    ],
  },
  implementation: {
    label: "Implementation",
    objective: "Code creation, refactoring, type checking, unit tests, and bug fixing.",
    strategy: "Prefer strong coding models with high instruction following.",
    candidates: [
      roleCandidate("sol", 100, "Accurate multi-file refactors and complex logic."),
      roleCandidate("sonnet", 92, "Strong generalist coding with fast turns."),
      roleCandidate("devin", 84, "Autonomous implementation in a separate environment."),
    ],
  },
  code_review: {
    label: "Code review",
    objective: "Diff analysis, security audit, regression detection, and style conformity.",
    strategy: "Prefer a reviewer from a different lineage than the implementer, sensitive to subtle bugs.",
    candidates: [
      roleCandidate("opus", 100, "Architectural consistency and subtle invariant violations, from outside the Codex lineage."),
      roleCandidate("astra", 95, "Rigorous logic and boundary checking."),
      roleCandidate("deepseek", 87, "An independent second opinion on code-level edge cases."),
    ],
  },
};

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
  } = {},
): OrchestrationProviderMap {
  const now = finiteNumber(options.now) ?? Date.now();
  const bias = options.bias ?? "balanced";
  const quotaWeight = routingBiasWeight(bias);
  const summaries = new Map(
    report.providers.map((provider) => [provider.id, summarizeProviderPacing(provider, now)]),
  );
  const roles = options.role ? [options.role] : [...ORCHESTRATION_ROLE_IDS];
  const assignments = roles.map((role) => {
    const policy = ROLE_POLICIES[role];
    const ranked = policy.candidates
      .map((runtime) => {
        const quota = summaries.get(runtime.route.providerId) ?? unknownProviderSummary(runtime.route.providerId);
        return { runtime, quota, score: runtime.fit + quotaScoreAdjustment(quota, now) * quotaWeight };
      })
      .sort((left, right) => right.score - left.score || right.runtime.fit - left.runtime.fit);
    const selected = ranked[0]!;
    const quotaRisk = isQuotaRisk(selected.quota);
    const alternatives = ranked.slice(1);
    if (quotaRisk) {
      alternatives.sort((left, right) => {
        const leftRank = fallbackPreference(left, selected.runtime.route.providerId);
        const rightRank = fallbackPreference(right, selected.runtime.route.providerId);
        return leftRank - rightRank || right.score - left.score || right.runtime.fit - left.runtime.fit;
      });
    }
    return {
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
    };
  });
  const models = buildModelGuidance(roles, summaries, now);

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
): OrchestrationModelGuidance[] {
  const models = new Map<string, {
    runtime: RuntimeDefinition;
    roles: Array<{ role: OrchestrationRoleId; label: string }>;
  }>();

  for (const role of roles) {
    const policy = ROLE_POLICIES[role];
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

function runtimeDefinition(
  label: string,
  providerId: string,
  harness: string,
  model: string | null,
  effort: string | null,
  profile: string | null,
  capability: string,
  caution: string,
): RuntimeDefinition {
  return {
    label,
    route: { providerId, harness, model, effort, profile },
    capability,
    caution,
  };
}

function roleCandidate(runtimeId: keyof typeof RUNTIMES, fit: number, rationale?: string): RuntimeCandidate {
  return {
    ...RUNTIMES[runtimeId],
    fit,
    taskRationale: rationale ?? RUNTIMES[runtimeId].capability,
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
