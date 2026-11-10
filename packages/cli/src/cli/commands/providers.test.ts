import { describe, expect, test } from "bun:test";

import {
  buildOrchestrationProviderMap,
  renderOrchestrationProviderMap,
} from "@openscout/protocol";
import { createScoutCommandContext, type ScoutCommandContext } from "../context.ts";
import {
  buildProviderUsageReport as buildPublicProviderUsageReport,
  parseProvidersCommandOptions,
  renderProviderUsageReport,
  renderProvidersCommandHelp,
  runProvidersCommand,
} from "./providers.ts";

const NOW = Date.UTC(2026, 7, 11, 18, 0, 0);
const GENERATED_AT = NOW - 2_000;

// Preserve the existing formatting/pacing scenarios while feeding the new
// public observation contract. Legacy dashboard-shaped data is test input only.
type FixtureWindow = { label?: string; fill?: number; usedLabel?: string; resetAt?: number; windowMs?: number; capturedAt?: number; source?: string };
type FixtureGauge = FixtureWindow & { id: string; kind?: string; windows?: FixtureWindow[]; unitLabel?: string; plan?: string };
type ServiceBudgetsPayload = { generatedAt?: number; gauges?: unknown[] };
function publicFixture(payload: ServiceBudgetsPayload) {
  const generatedAt = payload.generatedAt ?? NOW;
  const windows = (payload.gauges ?? []).flatMap(value => {
    const gauge = value as FixtureGauge;
    if (gauge.kind !== "quota") return [];
    const entries = Array.isArray(gauge.windows) && gauge.windows.length ? gauge.windows : [{ ...gauge, label: gauge.unitLabel }];
    return entries.flatMap((window: FixtureWindow, index: number) => {
      const usedPercent = typeof window.fill === "number" ? Math.round(Math.max(0, Math.min(1, window.fill)) * 1000) / 10 : Number.parseFloat(window.usedLabel ?? "NaN");
      if (!Number.isFinite(usedPercent)) return [];
      const capturedAt = window.capturedAt ?? gauge.capturedAt ?? generatedAt;
      return [{ id: `${gauge.id}:${index}`, provider: gauge.id, source: "provider_reported" as const,
        accountId: `account:${gauge.id}`, endpointId: `endpoint:${gauge.id}`, sessionId: `session:${gauge.id}`,
        label: window.label ?? "quota", usedPercent, percentRemaining: Math.round((100 - usedPercent) * 10) / 10,
        resetAt: window.resetAt ?? gauge.resetAt, windowMs: window.windowMs, capturedAt, ageMs: Math.max(0, generatedAt - capturedAt),
        planType: gauge.plan, observationSource: window.source ?? gauge.source ?? "provider report" }];
    });
  });
  return { schema: "scout.provider-quotas/v1" as const, generatedAt, availability: windows.length ? "available" as const : "unknown" as const,
    refresh: "unsupported" as const, windows, coverage: { endpointsScanned: (payload.gauges ?? []).length, truncated: false } };
}
const buildProviderUsageReport = (payload: ServiceBudgetsPayload, options: Parameters<typeof buildPublicProviderUsageReport>[1]) => buildPublicProviderUsageReport(publicFixture(payload), options);

const serviceBudgetsPayload: ServiceBudgetsPayload = {
  generatedAt: GENERATED_AT,
  gauges: [
    {
      id: "claude",
      label: "claude",
      kind: "quota",
      fill: 0.4,
      plan: "Max",
      capturedAt: NOW - 60_000,
      source: "provider report",
      windows: [
        {
          label: "5h",
          fill: 0.125,
          resetAt: NOW + 2 * 60 * 60_000,
          capturedAt: NOW - 60_000,
          source: "Claude local status",
        },
        {
          label: "7d",
          fill: 0.4,
          resetAt: NOW + 6 * 24 * 60 * 60_000,
          capturedAt: NOW - 90_000,
          source: "Claude local status",
        },
      ],
    },
    {
      id: "codex",
      label: "codex",
      kind: "quota",
      fill: 0.61,
      windows: [
        {
          label: "7d",
          fill: 0.61,
          resetAt: NOW + 5 * 24 * 60 * 60_000,
          capturedAt: NOW - 4_000,
          source: "Codex local session",
        },
      ],
    },
    {
      id: "nova-ai",
      label: "nova ai",
      kind: "quota",
      fill: 0.2,
      unitLabel: "weekly",
      resetAt: NOW + 7 * 24 * 60 * 60_000,
      capturedAt: NOW - 30_000,
      source: "provider report",
    },
    {
      id: "minimax",
      label: "minimax",
      kind: "quota",
      fill: 0.7,
      windows: [
        {
          label: "5h",
          fill: 0.2,
          resetAt: NOW + 3 * 60 * 60_000,
          capturedAt: NOW - 20_000,
          source: "MiniMax API",
        },
        {
          label: "7d",
          fill: 0.4,
          resetAt: NOW + 4 * 24 * 60 * 60_000,
          capturedAt: NOW - 20_000,
          source: "MiniMax API",
        },
        {
          label: "video 1d",
          fill: 0.6,
          resetAt: NOW + 20 * 60 * 60_000,
          capturedAt: NOW - 20_000,
          source: "MiniMax API",
        },
        {
          label: "video 7d",
          fill: 0.7,
          resetAt: NOW + 5 * 24 * 60 * 60_000,
          capturedAt: NOW - 20_000,
          source: "MiniMax API",
        },
      ],
    },
    {
      id: "cursor",
      label: "cursor",
      kind: "status",
      statusLabel: "Pro",
    },
  ],
};

const formatOptions = {
  now: NOW,
  locale: "en-US",
  timeZone: "UTC",
} as const;

describe("providers command", () => {
  test("documents the passive usage view and structured output", () => {
    const help = renderProvidersCommandHelp();

    expect(help).toContain("scout providers usage");
    expect(help).toContain("scout providers map");
    expect(help).toContain("every provider quota window");
    expect(help).toContain("--cached");
    expect(help).toContain("--json");
  });

  test("defaults to requesting refresh and accepts an explicit cached read", () => {
    expect(parseProvidersCommandOptions(["usage"])).toEqual({
      command: "usage",
      forceRefresh: true,
    });
    expect(parseProvidersCommandOptions(["usage", "--cached"])).toEqual({
      command: "usage",
      forceRefresh: false,
    });
    expect(parseProvidersCommandOptions(["map", "--role", "implementation", "--cached"])).toEqual({
      command: "map",
      forceRefresh: false,
      role: "implementation",
    });
    expect(() => parseProvidersCommandOptions(["map", "--role", "unknown"]))
      .toThrow("must be one of");
    expect(() => parseProvidersCommandOptions(["usage", "--role", "implementation"]))
      .toThrow("does not accept --role");
    expect(() => parseProvidersCommandOptions(["usage", "--refresh", "--cached"]))
      .toThrow("only one of --refresh or --cached");
  });

  test("preserves every quota window and future providers", () => {
    const report = buildProviderUsageReport(serviceBudgetsPayload, formatOptions);

    expect(report.providers.map((provider) => provider.id)).toEqual([
      "claude",
      "codex",
      "nova-ai",
      "minimax",
    ]);
    expect(report.providers[0]?.windows.map((window) => window.label)).toEqual(["5h", "7d"]);
    expect(report.providers[1]?.windows.map((window) => window.label)).toEqual(["7d"]);
    expect(report.providers[2]).toMatchObject({
      label: "Nova Ai",
      windows: [{ label: "7d", usedPercent: 20, percentRemaining: 80 }],
    });
    expect(report.providers[3]?.windows.map((window) => window.label)).toEqual([
      "5h",
      "7d",
      "video 1d",
      "video 7d",
    ]);
    expect(report.providers[0]?.windows[0]).toMatchObject({
      usedPercent: 12.5,
      percentRemaining: 87.5,
      resetAtIso: "2026-08-11T20:00:00.000Z",
      resetIn: "in 2h",
      source: "Claude local status",
      freshness: {
        capturedAt: NOW - 60_000,
        ageMs: 60_000,
        label: "1m ago",
      },
    });
    expect(report.providers[0]?.windows[0]?.resetAtLocal)
      .toMatch(/^Tue, Aug 11(?: at|,) 8:00 PM UTC$/u);
  });

  test("maps orchestration roles using capability fit and multi-window pacing", () => {
    const report = buildProviderUsageReport({
      generatedAt: NOW,
      gauges: [
        ...serviceBudgetsPayload.gauges as unknown[],
        {
          id: "kimi",
          label: "kimi",
          kind: "quota",
          fill: 0.367,
          plan: "Advanced",
          windows: [
            {
              label: "5h",
              fill: 0,
              windowMs: 5 * 60 * 60_000,
              resetAt: NOW + 2 * 60 * 60_000,
              capturedAt: NOW,
              source: "Kimi API",
            },
            {
              label: "7d",
              fill: 0.367,
              windowMs: 7 * 24 * 60 * 60_000,
              resetAt: NOW + 30 * 60 * 60_000,
              capturedAt: NOW,
              source: "Kimi API",
            },
            {
              label: "monthly",
              fill: 0.3288,
              windowMs: 31 * 24 * 60 * 60_000,
              resetAt: NOW + 20 * 24 * 60 * 60_000,
              capturedAt: NOW,
              source: "Kimi dashboard",
            },
          ],
        },
        {
          id: "grok",
          label: "grok",
          kind: "quota",
          fill: 0.08,
          windows: [{
            label: "7d",
            fill: 0.08,
            windowMs: 7 * 24 * 60 * 60_000,
            resetAt: NOW + 24 * 60 * 60_000,
            capturedAt: NOW,
            source: "Grok local billing",
          }],
        },
      ],
    }, formatOptions);
    const map = buildOrchestrationProviderMap(report, { now: NOW });

    expect(map.assignments.find((assignment) => assignment.role === "large_context_synthesis"))
      .toMatchObject({
        modelLabel: "Kimi Code",
        route: { providerId: "kimi", harness: "kimi", profile: "Kimi" },
        fit: 100,
        objective: expect.stringContaining("Repository-wide investigations"),
        taskRationale: expect.stringContaining("long-context retrieval"),
        quotaRisk: false,
        quotaRiskMessage: null,
        caution: expect.stringContaining("probe before a large fan-out"),
        quota: {
          availability: "abundant",
          pacing: "on_track",
          minimumRemainingPercent: 63.3,
          bindingWindow: "7d",
        },
        alternatives: [
          expect.objectContaining({
            label: expect.stringMatching(/^Opus 5/),
            fit: 96,
            taskRationale: expect.stringContaining("structural understanding"),
            quotaRisk: false,
            capability: expect.stringContaining("Long-context synthesis"),
            caution: expect.stringContaining("Premium shared Claude quota"),
          }),
          expect.anything(),
        ],
      });
    expect(map.assignments.find((assignment) => assignment.role === "adversarial_critique"))
      .toMatchObject({ modelLabel: "Grok 4.6" });
    expect(map.assignments.find((assignment) => assignment.role === "implementation"))
      .toMatchObject({ modelLabel: "GPT-6.1 Sol" });
    expect(map.models.find((model) => model.modelLabel === "Kimi Code")).toMatchObject({
      guidance: "use_now",
      quotaRisk: false,
      roles: [{ role: "large_context_synthesis", label: "Large-context synthesis" }],
      strengths: [expect.stringContaining("Dense repository")],
      cautions: [expect.stringContaining("quota telemetry can be stale")],
    });
    expect(map.models.find((model) => model.modelLabel === "Grok 4.6"))
      .toMatchObject({ guidance: "use_now" });


    const quotaBiasedMap = buildOrchestrationProviderMap(report, { now: NOW, bias: "quota" });
    expect(quotaBiasedMap.bias).toBe("quota");
    expect(quotaBiasedMap.assignments.find((assignment) => assignment.role === "product_judgment"))
      .toMatchObject({ modelLabel: "Grok 4.6" });

    const capabilityBiasedMap = buildOrchestrationProviderMap(report, { now: NOW, bias: "capability" });
    expect(capabilityBiasedMap.bias).toBe("capability");
    expect(capabilityBiasedMap.assignments.find((assignment) => assignment.role === "product_judgment"))
      .toMatchObject({ modelLabel: "Fable 5.2" });
    const rendered = renderOrchestrationProviderMap(map);
    expect(rendered).toContain("Orchestration map · quota-aware");
    expect(rendered).toContain("Large-context synthesis");
    expect(rendered).toContain("63.3% minimum remaining · usage tracks elapsed time · telemetry fresh");
    expect(rendered).toContain("not durable `scout role` assignments");
  });

  test("falls back from a constrained preferred provider", () => {
    const report = buildProviderUsageReport({
      generatedAt: NOW,
      gauges: [
        {
          id: "claude",
          label: "claude",
          kind: "quota",
          fill: 0.95,
          windows: [{
            label: "7d",
            fill: 0.95,
            windowMs: 7 * 24 * 60 * 60_000,
            resetAt: NOW + 5 * 24 * 60 * 60_000,
            capturedAt: NOW,
            source: "Claude local status",
          }],
        },
        {
          id: "codex",
          label: "codex",
          kind: "quota",
          fill: 0.1,
          windows: [{
            label: "7d",
            fill: 0.1,
            windowMs: 7 * 24 * 60 * 60_000,
            resetAt: NOW + 3 * 24 * 60 * 60_000,
            capturedAt: NOW,
            source: "Codex local session",
          }],
        },
      ],
    }, formatOptions);
    const map = buildOrchestrationProviderMap(report, {
      now: NOW,
      role: "product_judgment",
    });

    expect(map.assignments).toHaveLength(1);
    expect(map.assignments[0]).toMatchObject({
      role: "product_judgment",
      modelLabel: "GPT-6 Astra",
      route: { providerId: "codex" },
      quotaRisk: false,
      quotaRiskMessage: null,
      alternatives: expect.arrayContaining([
        expect.objectContaining({
          label: "Fable 5.2",
          quotaRisk: true,
        }),
      ]),
    });
  });

  test("prefers a quota-safe provider fallback and keeps risk guidance consistent", () => {
    const report = buildProviderUsageReport({
      generatedAt: NOW,
      gauges: [
        {
          id: "codex",
          label: "codex",
          kind: "quota",
          fill: 0.8,
          windows: [{
            label: "7d",
            fill: 0.8,
            windowMs: 7 * 24 * 60 * 60_000,
            resetAt: NOW + 60 * 60_000,
            capturedAt: NOW,
            source: "Codex local session",
          }],
        },
        {
          id: "claude",
          label: "claude",
          kind: "quota",
          fill: 0.5,
          windows: [{
            label: "7d",
            fill: 0.5,
            windowMs: 7 * 24 * 60 * 60_000,
            resetAt: NOW + 3.5 * 24 * 60 * 60_000,
            capturedAt: NOW,
            source: "Claude local status",
          }],
        },
      ],
    }, formatOptions);
    const map = buildOrchestrationProviderMap(report, {
      now: NOW,
      role: "implementation",
    });

    const assignment = map.assignments[0]!;
    expect(assignment).toMatchObject({
      modelLabel: "Sonnet 5.5",
      route: { providerId: "claude" },
      quotaRisk: false,
    });
    expect(assignment.alternatives[0]).toMatchObject({
      label: "GPT-6.1 Sol",
      route: { providerId: "codex" },
      quotaRisk: true,
    });
    expect(assignment.alternatives[1]).toMatchObject({
      label: "Devin SWE-2 High",
      route: { providerId: "devin" },
      quotaRisk: false,
      quota: { confidence: "unknown" },
    });
    expect(map.models.find((model) => model.modelLabel === "GPT-6.1 Sol"))
      .toMatchObject({ guidance: "conserve", quotaRisk: true });
  });

  test("does not call unknown telemetry a quota-safe fallback", () => {
    const report = buildProviderUsageReport({
      generatedAt: NOW,
      gauges: [
        {
          id: "codex",
          label: "codex",
          kind: "quota",
          fill: 0.8,
          windows: [{
            label: "7d",
            fill: 0.8,
            windowMs: 7 * 24 * 60 * 60_000,
            resetAt: NOW + 60 * 60_000,
            capturedAt: NOW,
            source: "Codex local session",
          }],
        },
        {
          id: "claude",
          label: "claude",
          kind: "quota",
          fill: 0.5,
          windows: [{
            label: "7d",
            fill: 0.5,
            windowMs: 7 * 24 * 60 * 60_000,
            resetAt: NOW + 3.5 * 24 * 60 * 60_000,
            capturedAt: NOW,
            source: "Claude local status",
          }],
        },
      ],
    }, formatOptions);
    const map = buildOrchestrationProviderMap(report, {
      now: NOW,
      role: "evidence_inventory",
      bias: "capability",
    });

    const assignment = map.assignments[0]!;
    expect(assignment).toMatchObject({ modelLabel: "GPT-6 Luna", quotaRisk: true });
    expect(assignment.alternatives[0]).toMatchObject({
      label: "Haiku 5.5",
      quotaRisk: false,
      quota: { confidence: "fresh", minimumRemainingPercent: 50 },
    });
    expect(assignment.alternatives[1]).toMatchObject({
      label: "MiniMax M3",
      quotaRisk: false,
      quota: { confidence: "unknown", minimumRemainingPercent: null },
    });
    expect(map.models.find((model) => model.modelLabel === "MiniMax M3"))
      .toMatchObject({ guidance: "probe_first", quotaRisk: false });
  });

  test("renders a compact local-time view with source and freshness", () => {
    const rendered = renderProviderUsageReport(
      buildProviderUsageReport(serviceBudgetsPayload, formatOptions),
    );

    expect(rendered).toContain("Provider usage · 8 windows");
    expect(rendered).toContain("Claude · Max");
    expect(rendered).toContain("5h  12.5% used · 87.5% remaining");
    expect(rendered).toMatch(/Tue, Aug 11(?: at|,) 8:00 PM UTC \(in 2h\)/u);
    expect(rendered).toContain("Claude local status · updated 1m ago");
    expect(rendered).toContain("Codex local session · updated just now");
    expect(rendered).toContain("video 7d  70% used · 30% remaining");
    expect(rendered).not.toContain("Cursor");
  });

  test("requests refresh without claiming a poll and emits public structured JSON", async () => {
    const stdout: string[] = [];
    const paths: string[] = [];
    const context = createScoutCommandContext({
      cwd: "/tmp/openscout-test",
      env: {},
      outputMode: "json",
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
      isTty: false,
    });

    await runProvidersCommand(context, ["usage"], {
      ...formatOptions,
      readJson: async <T>(_context: Pick<ScoutCommandContext, "env">, path: string): Promise<T> => {
        paths.push(path);
        return publicFixture(serviceBudgetsPayload) as T;
      },
    });

    expect(paths).toEqual(["/v1/provider-quotas?limit=200&refresh=1"]);
    expect(JSON.parse(stdout[0]!).refresh).toBe("unsupported");
    const report = JSON.parse(stdout.join("\n"));
    expect(report).toMatchObject({
      generatedAt: GENERATED_AT,
      generatedAtIso: "2026-08-11T17:59:58.000Z",
    });
    expect(report.providers[0]).toMatchObject({
      id: "claude",
      plan: "Max",
    });
    expect(report.providers[0].windows[0]).toMatchObject({
      label: "5h",
      usedPercent: 12.5,
      percentRemaining: 87.5,
      resetAt: NOW + 2 * 60 * 60_000,
      source: "Claude local status",
      freshness: { ageMs: 60_000, label: "1m ago" },
    });
  });

  test("renders an actionable empty state", () => {
    const rendered = renderProviderUsageReport(buildProviderUsageReport({
      generatedAt: NOW,
      gauges: [],
    }, formatOptions));

    expect(rendered).toContain("Provider quota availability unknown");
    expect(rendered).not.toContain("0 windows");
    expect(rendered).toContain("--refresh cannot poll");
  });
});
