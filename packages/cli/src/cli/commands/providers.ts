import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { requestScoutBrokerJson, ScoutBrokerHttpError } from "@openscout/runtime/client";
import { resolveBrokerControlUrl } from "@openscout/runtime/config";
import {
  buildOrchestrationProviderMap,
  isOrchestrationRoleId,
  ORCHESTRATION_ROLE_IDS,
  renderOrchestrationProviderMap,
} from "@openscout/protocol";
import type { OrchestrationRoleId, ProviderQuotaRead, ProviderQuotaReadWindow } from "@openscout/protocol";

const HELP_FLAGS = new Set(["--help", "-h", "help"]);
const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  anthropic: "Anthropic",
  openai: "OpenAI",
  codex: "Codex",
  cursor: "Cursor",
  github: "GitHub",
  grok: "Grok",
  kimi: "Kimi",
  minimax: "MiniMax",
};

/** CLI policy, not a claim that the runtime refreshed a provider. */
export const PROVIDER_QUOTA_STALE_AFTER_MS = 60 * 60_000;
export type ProviderQuotaPoolIdentity = {
  provider: string;
  accountId: string | null;
  userId: string | null;
  endpointId: string | null;
  sessionId: string | null;
  harness: string | null;
  transport: string | null;
};

export type ProviderUsageFreshness = {
  capturedAt: number | null;
  capturedAtIso: string | null;
  ageMs: number | null;
  label: string;
  stale: boolean;
};

export type ProviderUsageWindow = {
  /** Original account/endpoint/session facts, including provenance and capture age. */
  facts: ProviderQuotaReadWindow;
  label: string;
  usedPercent: number;
  percentRemaining: number;
  windowMs: number | null;
  resetAt: number | null;
  resetAtIso: string | null;
  resetAtLocal: string;
  resetIn: string;
  source: string;
  freshness: ProviderUsageFreshness;
};

export type ProviderUsageProvider = {
  poolId: string;
  identity: ProviderQuotaPoolIdentity;
  routingProviderId: string;
  id: string;
  label: string;
  plan: string | null;
  windows: ProviderUsageWindow[];
};

export type ProviderUsageReport = {
  schema: "scout.provider-usage/v1";
  availability: "available" | "stale" | "unknown";
  refresh: ProviderQuotaRead["refresh"];
  coverage: ProviderQuotaRead["coverage"];

  generatedAt: number;
  generatedAtIso: string;
  generatedAtLocal: string;
  providers: ProviderUsageProvider[];
};

export type ProvidersCommandOptions =
  | { command: "help" }
  | { command: "usage"; forceRefresh: boolean }
  | { command: "map"; forceRefresh: boolean; role: OrchestrationRoleId | null };

export type ProviderUsageFormatOptions = {
  now?: number;
  locale?: string | string[];
  timeZone?: string;
};

export type ProvidersCommandDependencies = ProviderUsageFormatOptions & {
  readJson?: typeof readProviderQuotaJson;
};

export function renderProvidersCommandHelp(): string {
  return [
    "Usage:",
    "  scout providers usage [--refresh | --cached] [--json]",
    "  scout providers map [--refresh | --cached] [--role <role>] [--json]",
    "",
    "Read passive runtime observations or build a quota-aware orchestration map.",
    "",
    "The usage view prints percent used, percent remaining, local reset time,",
    "source, and freshness for every provider quota window. The map combines",
    "those windows with a small role/model/provider policy; it recommends dispatches",
    "but does not create durable `scout role` assignments.",
    "",
    `Map roles: ${ORCHESTRATION_ROLE_IDS.join(", ")}`,
    "",
    "Options:",
    "  --refresh       Request refresh (default); runtime reports unsupported.",
    "                  Reads remain passive; no polling, app or dashboard refresh.",
    "  --cached        Read passive observations without requesting refresh.",
    "  --role <role>   Limit the orchestration map to one role.",
    "  --json          Emit structured JSON (global Scout flag).",
    "",
    "Usage keeps account/endpoint/session pools separate, with capture provenance.",
    "Unknown is not zero. Facts older than 1h or past reset are labeled stale.",
    "Map refuses unknown, stale, incomplete or ambiguous observed quota pools;",
    "there is no per-pool selector in this increment. Inspect usage instead.",
    "Map quota pools are observation provenance, not a dispatch account binding.",
    "",
    "Examples:",
    "  scout providers usage",
    "  scout providers map",
    "  scout providers map --role implementation --cached",
  ].join("\n");
}

export function parseProvidersCommandOptions(args: string[]): ProvidersCommandOptions {
  const action = args[0];
  if (!action || HELP_FLAGS.has(action)) return { command: "help" };
  if (action !== "usage" && action !== "map") {
    throw new ScoutCliError(`unknown providers action: ${action} (try: scout providers usage or scout providers map)`);
  }
  if (args.slice(1).some((arg) => HELP_FLAGS.has(arg))) return { command: "help" };

  let forceRefresh = true;
  let refreshMode: "refresh" | "cached" | null = null;
  let role: OrchestrationRoleId | null = null;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--refresh" || arg === "--cached") {
      const nextMode = arg === "--refresh" ? "refresh" : "cached";
      if (refreshMode && refreshMode !== nextMode) {
        throw new ScoutCliError(`providers ${action} accepts only one of --refresh or --cached`);
      }
      refreshMode = nextMode;
      forceRefresh = nextMode === "refresh";
      continue;
    }
    if (arg === "--role") {
      if (action !== "map") {
        throw new ScoutCliError("providers usage does not accept --role");
      }
      const nextRole = args[index + 1];
      if (!nextRole || !isOrchestrationRoleId(nextRole)) {
        throw new ScoutCliError(`providers map --role must be one of: ${ORCHESTRATION_ROLE_IDS.join(", ")}`);
      }
      role = nextRole;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new ScoutCliError(`unknown providers ${action} option: ${arg}`);
    }
    throw new ScoutCliError(`unexpected providers ${action} argument: ${arg}`);
  }
  return action === "usage"
    ? { command: "usage", forceRefresh }
    : { command: "map", forceRefresh, role };
}

export async function runProvidersCommand(
  context: ScoutCommandContext,
  args: string[],
  dependencies: ProvidersCommandDependencies = {},
): Promise<void> {
  const options = parseProvidersCommandOptions(args);
  if (options.command === "help") {
    context.output.writeText(renderProvidersCommandHelp());
    return;
  }

  const path = `/v1/provider-quotas?limit=200${options.forceRefresh ? "&refresh=1" : ""}`;
  const payload = await (dependencies.readJson ?? readProviderQuotaJson)<ProviderQuotaRead>(context, path);
  if (options.forceRefresh && payload.refresh !== "unsupported") throw new ScoutCliError("provider_quotas_invalid_response: passive runtime did not report refresh unsupported");
  const report = buildProviderUsageReport(payload, dependencies);
  if (options.command === "usage") {
    context.output.writeValue(report, renderProviderUsageReport);
    return;
  }
  const map = buildProviderQuotaMap(report, { now: dependencies.now, role: options.role });
  context.output.writeValue(map, value => [renderQuotaNotice(report), "Account binding is not enforced; quota pools identify observations, not dispatch credentials.", renderQuotaPools(report), renderOrchestrationProviderMap(value)].join("\n\n"));
}

/** Provider-only client until the separately reviewed shared reader lands. */
async function readProviderQuotaJson<T>(context: Pick<ScoutCommandContext, "env">, path: string): Promise<T> {
  try {
    return await requestScoutBrokerJson<T>(context.env.OPENSCOUT_BROKER_URL?.trim() || resolveBrokerControlUrl(), path, {
      socketPath: context.env.OPENSCOUT_BROKER_SOCKET_PATH?.trim() || undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (!(error instanceof ScoutBrokerHttpError)) throw error;
    // No runtime API change in this consumer PR. Keep HTTP status even while
    // the existing error class has no response-body field.
    throw new ScoutCliError(`Provider quotas unavailable: HTTP ${error.status}`);
  }
}

export function buildProviderUsageReport(
  payload: ProviderQuotaRead,
  options: ProviderUsageFormatOptions = {},
): ProviderUsageReport {
  if (payload.schema !== "scout.provider-quotas/v1" || !["available", "unknown"].includes(payload.availability)
    || !["unsupported", "not_requested"].includes(payload.refresh) || !Array.isArray(payload.windows)
    || !Number.isFinite(payload.generatedAt) || !Number.isFinite(new Date(payload.generatedAt).getTime())
    || typeof payload.coverage?.truncated !== "boolean" || !Number.isInteger(payload.coverage.endpointsScanned) || payload.coverage.endpointsScanned < 0
    || (payload.availability === "unknown") !== (payload.windows.length === 0)) throw new ScoutCliError("provider_quotas_invalid_response");
  const now = finiteNumber(options.now) ?? Date.now();
  const pools = new Map<string, ProviderUsageProvider>();
  for (const facts of payload.windows) {
    // IDs are opaque: do not trim, case-fold, or infer an account from a provider.
    if (typeof facts.id !== "string" || !facts.id || typeof facts.provider !== "string" || !facts.provider || !Number.isFinite(facts.ageMs) || facts.ageMs < 0 || !Number.isFinite(facts.capturedAt)
      || !Number.isFinite(new Date(facts.capturedAt).getTime()) || facts.capturedAt > payload.generatedAt || ![facts.resetAt, facts.windowMs].every(value => value === undefined || Number.isFinite(value))
      || (facts.resetAt !== undefined && !Number.isFinite(new Date(facts.resetAt).getTime()))) throw new ScoutCliError("provider_quotas_invalid_response");
    const identity: ProviderQuotaPoolIdentity = { provider: facts.provider, accountId: facts.accountId ?? null, userId: facts.userId ?? null,
      endpointId: facts.endpointId ?? null, sessionId: facts.sessionId ?? null, harness: facts.harness ?? null, transport: facts.transport ?? null };
    const poolId = JSON.stringify([identity.provider, identity.accountId, identity.userId, identity.endpointId, identity.sessionId, identity.harness, identity.transport, facts.planType ?? null, identity.accountId === null ? facts.id : null]);
    let pool = pools.get(poolId);
    if (!pool) {
      pool = { poolId, identity, id: facts.provider, routingProviderId: routingProviderId(facts.provider), label: providerLabel(facts.provider, null), plan: facts.planType ?? null, windows: [] };
      pools.set(poolId, pool);
    }
    const used = facts.usedPercent ?? (facts.percentRemaining !== undefined ? 100 - facts.percentRemaining
      : facts.used !== undefined && facts.limit !== undefined && facts.limit > 0 ? facts.used / facts.limit * 100 : NaN);
    if (!Number.isFinite(used) || used < 0 || used > 100 || (facts.percentRemaining !== undefined && (!Number.isFinite(facts.percentRemaining) || facts.percentRemaining < 0 || facts.percentRemaining > 100 || Math.abs(used + facts.percentRemaining - 100) > 0.2))) throw new ScoutCliError("provider_quotas_invalid_response");
    const resetAt = facts.resetAt ?? null;
    // Receipt age is authoritative; waiting at the client can only age a fact.
    const ageMs = Math.max(facts.ageMs, payload.generatedAt - facts.capturedAt) + Math.max(0, now - payload.generatedAt);
    pool.windows.push({ facts, label: legacyWindowLabel(facts.label), usedPercent: roundPercent(used),
      percentRemaining: roundPercent(facts.percentRemaining ?? 100 - used), windowMs: facts.windowMs ?? null,
      resetAt, resetAtIso: resetAt === null ? null : new Date(resetAt).toISOString(), resetAtLocal: resetAt === null ? "unknown" : formatLocalTimestamp(resetAt, now, options),
      resetIn: resetAt === null ? "" : formatRelativeTime(resetAt - now), source: facts.observationSource,
      freshness: { capturedAt: facts.capturedAt, capturedAtIso: new Date(facts.capturedAt).toISOString(), ageMs, label: formatAge(ageMs),
        stale: ageMs > PROVIDER_QUOTA_STALE_AFTER_MS || (resetAt !== null && resetAt <= now) },
    });
  }
  const providers = [...pools.values()];
  return { schema: "scout.provider-usage/v1", generatedAt: payload.generatedAt, generatedAtIso: new Date(payload.generatedAt).toISOString(),
    generatedAtLocal: formatLocalTimestamp(payload.generatedAt, now, options), providers,
    availability: providers.length === 0 ? "unknown" : providers.every(pool => pool.windows.every(window => window.freshness.stale)) ? "stale" : "available",
    refresh: payload.refresh, coverage: payload.coverage,
  };
}

function routingProviderId(provider: string): string {
  return provider === "openai" ? "codex" : provider === "anthropic" ? "claude" : provider;
}

/** Never feed duplicate provider IDs to a mapper whose Map would pick the last account. */
export function buildProviderQuotaMap(report: ProviderUsageReport, options: { now?: number; role?: OrchestrationRoleId | null } = {}) {
  if (!report.providers.length) throw new ScoutCliError("provider_quotas_unknown: no approved observed quota facts; unknown is not zero");
  if (report.coverage.truncated) throw new ScoutCliError("provider_quota_coverage_incomplete: map requires complete observation coverage");
  const seen = new Set<string>();
  for (const pool of report.providers) {
    if (seen.has(pool.routingProviderId)) throw new ScoutCliError(`provider_quota_pool_ambiguous: ${pool.routingProviderId}; inspect providers usage; per-pool map selection is unsupported`);
    seen.add(pool.routingProviderId);
    if (!pool.identity.endpointId || !pool.identity.accountId) throw new ScoutCliError("provider_quota_identity_unknown: map needs observed endpoint and account identity; user identity is not an account");
    if (pool.windows.some(window => window.freshness.stale)) throw new ScoutCliError("provider_quotas_stale: map cannot use stale observations; --refresh is unsupported");
  }
  const map = buildOrchestrationProviderMap({ ...report, providers: report.providers.map(pool => ({ ...pool, id: pool.routingProviderId })) }, options);
  const supported = new Set(map.models.map(model => model.route.providerId));
  if (report.providers.some(pool => !supported.has(pool.routingProviderId))) throw new ScoutCliError("provider_quota_provider_unsupported: no routing policy for an observed provider");
  return { ...map, quotaRead: report, quotaBasis: report.providers.map(pool => ({ providerId: pool.routingProviderId, poolId: pool.poolId, identity: pool.identity })),
    accountBinding: "not_enforced" as const };
}

function renderQuotaNotice(report: ProviderUsageReport): string {
  return [report.refresh === "unsupported" ? "Refresh unsupported: passive runtime observations only; no provider was polled." : "Passive runtime observations; refresh not requested.",
    ...(report.coverage.truncated ? ["Incomplete observation coverage; no completeness claim."] : [])].join("\n");
}

const displayIdentity = (value: string | null): string => value === null ? "(unknown)" : JSON.stringify(value);

function renderQuotaPools(report: ProviderUsageReport): string {
  return report.providers.map(pool => `${pool.label}${pool.plan ? ` · ${pool.plan}` : ""} · account ${displayIdentity(pool.identity.accountId)} · user ${displayIdentity(pool.identity.userId)} · endpoint ${displayIdentity(pool.identity.endpointId)} · session ${displayIdentity(pool.identity.sessionId)} · harness ${displayIdentity(pool.identity.harness)} · transport ${displayIdentity(pool.identity.transport)}`).join("\n");
}

export function renderProviderUsageReport(report: ProviderUsageReport): string {
  const notice = renderQuotaNotice(report);
  if (report.availability === "unknown") return `${notice}\n\nProvider quota availability unknown: no approved observations are available. Unknown is not zero.\nOpen a provider session that reports quota metadata; --refresh cannot poll it.`;
  const windowCount = report.providers.reduce((count, provider) => count + provider.windows.length, 0);
  const lines = [notice, `Provider usage · ${windowCount} ${windowCount === 1 ? "window" : "windows"} · generated ${report.generatedAtLocal}`,
    ...(report.availability === "stale" ? ["Stale observations only; these are historical facts, not current capacity."] : [])];
  for (const pool of report.providers) {
    lines.push("", renderQuotaPools({ ...report, providers: [pool] }));
    for (const window of pool.windows) {
      lines.push(`  ${window.label}  ${formatPercent(window.usedPercent)} used · ${formatPercent(window.percentRemaining)} remaining · resets ${window.resetAtLocal}${window.resetIn ? ` (${window.resetIn})` : ""}`);
      lines.push(`      ${window.source} · updated ${window.freshness.label}${window.freshness.stale ? " · STALE (historical observation)" : ""}`);
    }
  }
  return lines.join("\n");
}

function formatLocalTimestamp(
  timestamp: number,
  now: number,
  options: ProviderUsageFormatOptions,
): string {
  const date = new Date(timestamp);
  const includeYear = date.getFullYear() !== new Date(now).getFullYear();
  return new Intl.DateTimeFormat(options.locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" as const } : {}),
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(date);
}

function formatRelativeTime(deltaMs: number): string {
  const past = deltaMs < 0;
  const absoluteMs = Math.abs(deltaMs);
  const minutes = Math.floor(absoluteMs / 60_000);
  let value: string;
  if (minutes < 1) {
    value = "less than 1m";
  } else if (minutes < 60) {
    value = `${minutes}m`;
  } else if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    value = remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
  } else {
    const days = Math.floor(minutes / (24 * 60));
    const hours = Math.floor((minutes % (24 * 60)) / 60);
    value = hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  return past ? `${value} ago` : `in ${value}`;
}

function formatAge(ageMs: number): string {
  if (ageMs < 5_000) return "just now";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1_000)}s ago`;
  if (ageMs < 60 * 60_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 24 * 60 * 60_000) {
    const hours = Math.floor(ageMs / (60 * 60_000));
    const minutes = Math.floor((ageMs % (60 * 60_000)) / 60_000);
    return minutes > 0 ? `${hours}h ${minutes}m ago` : `${hours}h ago`;
  }
  const days = Math.floor(ageMs / (24 * 60 * 60_000));
  const hours = Math.floor((ageMs % (24 * 60 * 60_000)) / (60 * 60_000));
  return hours > 0 ? `${days}d ${hours}h ago` : `${days}d ago`;
}

function legacyWindowLabel(label: string | null): string {
  if (label === "weekly") return "7d";
  if (label === "req/h") return "1h";
  return label ?? "quota";
}

function providerLabel(id: string, label: string | null): string {
  const normalized = id.trim().toLowerCase();
  if (PROVIDER_LABELS[normalized]) return PROVIDER_LABELS[normalized]!;
  const source = label ?? id;
  return source
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ") || "Unknown";
}

function formatPercent(percent: number): string {
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

function roundPercent(percent: number): number {
  return Math.round(percent * 10) / 10;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
