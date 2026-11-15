/**
 * Projects the curated model worldview to publishable JSON.
 *
 *   bun scripts/generate-model-worldview.ts
 *
 * The TS picks (model-economics.ts) are the authority; this JSON is a
 * projection served at https://openscout.app/.well-known/model-worldview.json
 * so consumers (first: Linea) get pick changes as a data refresh, never a
 * code update. Never hand-edit the output — change the picks and rerun.
 *
 * Contract (schema 1): additive fields are free; bump `schema` only on a
 * breaking shape change, because consumers reject schemas they don't know
 * rather than guess at them.
 */
import { join } from "node:path";
import {
  buildModelWorldview,
  type ModelWorldview,
} from "../src/model-worldview.js";

export const PUBLISHED_MODEL_WORLDVIEW = join(
  import.meta.dir,
  "../../../landing/openscout.app/public/.well-known/model-worldview.json",
);

export function renderModelWorldview(worldview: ModelWorldview): string {
  return `${JSON.stringify(worldview, null, 2)}\n`;
}

export async function generateModelWorldviewFile(
  outputPath: string,
  generatedAt: string,
): Promise<ModelWorldview> {
  const worldview = buildModelWorldview(generatedAt);
  await Bun.write(outputPath, renderModelWorldview(worldview));
  return worldview;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--output" || !args[1]?.trim() || args[1].startsWith("--"))) throw new Error("Use --output <site JSON path> to project into the private website.");
  const outputPath = args[1] ?? PUBLISHED_MODEL_WORLDVIEW;
  const worldview = await generateModelWorldviewFile(
    outputPath,
    new Date().toISOString().slice(0, 10),
  );
  console.log(
    `wrote ${outputPath} (${worldview.families.length} families)`,
  );
}

if (import.meta.main) await main();
