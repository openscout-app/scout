/**
 * Regenerates src/model-economics.generated.ts from models.dev.
 *
 *   bun scripts/generate-model-economics.ts
 *
 * Sibling of generate-model-windows.ts, same sourcing rules: models.dev
 * (https://models.dev/api.json) is the community catalog, and only each
 * model's native provider is trusted. Where windows answer "how much fits",
 * economics answers "what does a token cost and what can the model do":
 * input/output $ per 1M tokens, structured-output support, and release date.
 *
 * The curated layer (model-economics.ts) picks per-family tier winners over
 * this raw data; keep curation THERE, not here — this file is data only.
 */
import { join } from "node:path";

const SOURCE = "https://models.dev/api.json";

/** Model ids of labs with a native provider in PROVIDER_PRECEDENCE, as hosts resell them. */
function resold(id: string): boolean {
  return /^(glm|kimi|deepseek|minimax|claude|gpt|gemini|grok|llama|command)-/u.test(id.trim().toLowerCase());
}
const OUT = join(import.meta.dir, "../src/model-economics.generated.ts");

/**
 * Authoritative sources in explicit precedence order. Direct Google wins over
 * Vertex for duplicate Gemini ids. Vertex is admitted only as a fallback for
 * Google-native `gemini-*` rows; its Claude and third-party MaaS rows are not
 * Google-family models and must not enter this catalog under that label.
 */
export const PROVIDER_PRECEDENCE = [
  { providerId: "anthropic", family: "anthropic" },
  { providerId: "openai", family: "openai" },
  { providerId: "xai", family: "xai" },
  { providerId: "google", family: "google" },
  {
    providerId: "google-vertex",
    family: "google",
    accepts: (id: string) => id.trim().toLowerCase().startsWith("gemini-"),
  },
  { providerId: "minimax", family: "minimax" },
  // Mistral and Alibaba also resell other labs' models; those rows belong to
  // the native provider listed below (GLM is Z.ai's).
  { providerId: "mistral", family: "mistral", accepts: (id: string) => !resold(id) },
  { providerId: "deepseek", family: "deepseek" },
  { providerId: "alibaba", family: "alibaba", accepts: (id: string) => !resold(id) },
  { providerId: "moonshotai", family: "moonshotai" },
  { providerId: "zai", family: "zai" },
  { providerId: "groq", family: "groq" },
  { providerId: "cohere", family: "cohere" },
  { providerId: "meta", family: "meta" },
] as const;

function canonical(id: string): string {
  return id.trim().toLowerCase().replace(/[._]/gu, "-");
}

export type SourceModel = {
  cost?: { input?: number; output?: number };
  limit?: { context?: number };
  structured_output?: boolean;
  release_date?: string;
  name?: string;
};

export type SourceCatalog = Record<
  string,
  { models?: Record<string, SourceModel> }
>;

export type ModelEconomicsRow = {
  family: string;
  input: number;
  output: number;
  context?: number;
  structuredOutput?: boolean;
  released?: string;
};

type RowOrigin = {
  providerId: string;
  family: string;
  modelId: string;
  row: ModelEconomicsRow;
};

function sameRow(a: ModelEconomicsRow, b: ModelEconomicsRow): boolean {
  return a.family === b.family
    && a.input === b.input
    && a.output === b.output
    && a.context === b.context
    && a.structuredOutput === b.structuredOutput
    && a.released === b.released;
}

/** Build the catalog without depending on source-object property order. */
export function buildModelEconomicsRows(
  data: SourceCatalog,
): Map<string, ModelEconomicsRow> {
  const rows = new Map<string, ModelEconomicsRow>();
  const origins = new Map<string, RowOrigin>();

  for (const source of PROVIDER_PRECEDENCE) {
    const { providerId, family } = source;
    const provider = data[providerId];
    if (!provider) continue;

    for (const [id, model] of Object.entries(provider.models ?? {})) {
      if ("accepts" in source && !source.accepts(id)) continue;
      const input = model.cost?.input;
      const output = model.cost?.output;
      if (typeof input !== "number" || typeof output !== "number") continue;

      const key = canonical(id);
      const row: ModelEconomicsRow = {
        family,
        input,
        output,
        context: model.limit?.context,
        structuredOutput: model.structured_output,
        released: model.release_date,
      };
      const existing = origins.get(key);

      if (existing) {
        if (existing.family !== family) {
          throw new Error(
            `cross-family canonical model collision for ${JSON.stringify(key)}: `
              + `${existing.family}:${existing.providerId}/${existing.modelId} vs `
              + `${family}:${providerId}/${id}`,
          );
        }
        // Same-family source aliases follow PROVIDER_PRECEDENCE. In
        // particular, direct Google is authoritative over Google Vertex.
        if (existing.providerId !== providerId) continue;
        if (!sameRow(existing.row, row)) {
          throw new Error(
            `conflicting canonical aliases for ${providerId}/${key}: `
              + `${existing.modelId} vs ${id}`,
          );
        }
        continue;
      }

      rows.set(key, row);
      origins.set(key, { providerId, family, modelId: id, row });
    }
  }

  return rows;
}

export function renderModelEconomicsCatalog(
  rows: Map<string, ModelEconomicsRow>,
  providerCount: number,
  generatedAt: string,
): string {
  const sorted = [...rows.entries()].sort(([a], [b]) => a.localeCompare(b));
  const body = sorted
    .map(([k, v]) => {
      const fields = [
        `family: ${JSON.stringify(v.family)}`,
        `input: ${v.input}`,
        `output: ${v.output}`,
        v.context ? `context: ${v.context}` : null,
        v.structuredOutput === undefined ? null : `structuredOutput: ${v.structuredOutput}`,
        v.released ? `released: ${JSON.stringify(v.released)}` : null,
      ].filter(Boolean);
      return `  ${JSON.stringify(k)}: { ${fields.join(", ")} },`;
    })
    .join("\n");

  return `// AUTO-GENERATED — do not edit by hand.
// Source: ${SOURCE} (community model-metadata catalog, ~${providerCount} providers)
// Regenerate: bun scripts/generate-model-economics.ts
// Generated: ${generatedAt}
//
// Per-model economics from each model's native provider only: $ per 1M
// tokens (input/output), context window, structured-output support, release
// date. Curated tier picks layer over this in model-economics.ts.
// ${sorted.length} models.
export type ModelEconomicsEntry = {
  family: string;
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  context?: number;
  structuredOutput?: boolean;
  released?: string;
};

export const MODEL_ECONOMICS: Record<string, ModelEconomicsEntry> = {
${body}
};
`;
}

async function main(): Promise<void> {
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`models.dev fetch failed: ${res.status}`);
  const data = (await res.json()) as SourceCatalog;
  const rows = buildModelEconomicsRows(data);
  const out = renderModelEconomicsCatalog(
    rows,
    Object.keys(data).length,
    new Date().toISOString().slice(0, 10),
  );

  await Bun.write(OUT, out);
  console.log(`wrote ${rows.size} models from ${Object.keys(data).length} providers`);
}

if (import.meta.main) await main();
