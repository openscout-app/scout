#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parseScoutRuntimeCatalog } from "../packages/protocol/src/runtime-catalog.ts";

export const RUNTIME_CATALOG_SOURCE = "packages/protocol/src/runtime-catalog.v1.json";
export const RUNTIME_CATALOG_TS_OUTPUT = "packages/protocol/src/runtime-catalog.generated.ts";
export const RUNTIME_MODEL_WINDOWS_OUTPUT =
  "packages/agent-sessions/src/runtime-model-windows.generated.ts";
const LANDING_MIRROR_DIR = "landing/openscout.app/public/.well-known";
export const RUNTIME_CATALOG_LANDING_OUTPUT = `${LANDING_MIRROR_DIR}/runtime-catalog.v1.json`;
export const RUNTIME_CATALOG_PUBLIC_URL = "https://openscout.app/.well-known/runtime-catalog.v1.json";

export type CatalogOutput = {
  /** Repo-relative output path. */
  path: string;
  /** The exact bytes the file must contain. */
  content: string;
};

export function renderRuntimeCatalogTs(catalog: unknown): string {
  return `// Generated automatically from runtime-catalog.v1.json. Do not edit.\n\nexport const SCOUT_RUNTIME_CATALOG_DATA = ${JSON.stringify(catalog, null, 2)} as const;\n`;
}

export function renderModelContextWindows(catalog: { harnesses?: unknown[] }): string {
  const windows = Object.fromEntries((catalog.harnesses ?? []).flatMap((harness: { models?: unknown[] }) =>
    Array.isArray(harness.models) ? harness.models.flatMap((entry: unknown) => {
      const model = entry as { id?: unknown; contextWindowTokens?: unknown };
      return typeof model.id === "string"
        && Number.isInteger(model.contextWindowTokens)
        && Number(model.contextWindowTokens) > 0
        ? [[model.id.toLowerCase().replace(/[._]/gu, "-"), Number(model.contextWindowTokens)]]
        : [];
    }) : [],
  ));
  return `// Generated automatically from the Scout runtime catalog. Do not edit.\n\nexport const RUNTIME_MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = ${JSON.stringify(windows, null, 2)};\n`;
}

export function renderLandingMirror(catalog: unknown): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

/// Parse the source JSON and render every generated output in memory. The
/// landing mirror is only emitted when its directory exists — the site lives
/// in the private repo, so public checkouts skip it.
export async function renderCatalogOutputs(root: string): Promise<CatalogOutput[]> {
  const raw = await readFile(resolve(root, RUNTIME_CATALOG_SOURCE), "utf8");
  const catalog = JSON.parse(raw);
  const validated = parseScoutRuntimeCatalog(catalog);
  if (!validated.ok) {
    throw new Error(`runtime-catalog.v1.json is invalid: ${validated.errors.join("; ")}`);
  }
  const outputs: CatalogOutput[] = [
    { path: RUNTIME_CATALOG_TS_OUTPUT, content: renderRuntimeCatalogTs(catalog) },
    { path: RUNTIME_MODEL_WINDOWS_OUTPUT, content: renderModelContextWindows(catalog) },
  ];
  const tastePath = resolve(root, "packages/protocol/src/model-taste.v1.json");
  if (existsSync(tastePath)) {
    const taste = JSON.parse(await readFile(tastePath, "utf8"));
    outputs.push({ path: "packages/protocol/src/model-taste.generated.ts", content: `// Generated from model-taste.v1.json. Do not edit.\n\nexport const SCOUT_MODEL_TASTE_DATA = ${JSON.stringify(taste, null, 2)} as const;\n` });
  }
  if (existsSync(resolve(root, LANDING_MIRROR_DIR))) {
    outputs.push({ path: RUNTIME_CATALOG_LANDING_OUTPUT, content: renderLandingMirror(catalog) });
  }
  return outputs;
}

export type CatalogCheckResult = {
  path: string;
  match: boolean;
  /** First-difference hint when the bytes on disk drifted. */
  detail?: string;
};

function firstDifference(existing: string | null, rendered: string): string {
  if (existing === null) return "file is missing";
  const left = existing.split("\n");
  const right = rendered.split("\n");
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) {
      return `first difference at line ${index + 1}:\n        - ${left[index] ?? "<eof>"}\n        + ${right[index] ?? "<eof>"}`;
    }
  }
  return "contents differ";
}

/// Render every output and compare byte-for-byte with disk. Never writes.
export async function checkCatalogOutputs(root: string): Promise<CatalogCheckResult[]> {
  const outputs = await renderCatalogOutputs(root);
  const results: CatalogCheckResult[] = [];
  for (const output of outputs) {
    const existing = await readFile(resolve(root, output.path), "utf8").catch(() => null);
    const match = existing === output.content;
    results.push({
      path: output.path,
      match,
      ...(match ? {} : { detail: firstDifference(existing, output.content) }),
    });
  }
  return results;
}

/** Verify data publication independently of any app, CLI or package release. */
export async function verifyPublishedRuntimeCatalog(root: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const sourceData = JSON.parse(await readFile(resolve(root, RUNTIME_CATALOG_SOURCE), "utf8"));
  const source = parseScoutRuntimeCatalog(sourceData);
  if (!source.ok) throw new Error(`source catalog is invalid: ${source.errors.join("; ")}`);
  const response = await fetchImpl(RUNTIME_CATALOG_PUBLIC_URL, {
    headers: { accept: "application/json" }, cache: "no-cache", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`published catalog request failed: HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > 1_048_576) throw new Error("published catalog exceeds the client size limit");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("published catalog has no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 1_048_576) {
      await reader.cancel();
      throw new Error("published catalog exceeds the client size limit");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  const publishedText = new TextDecoder("utf-8", { fatal: true }).decode(body);
  const published = parseScoutRuntimeCatalog(JSON.parse(publishedText));
  if (!published.ok) throw new Error(`published catalog is invalid: ${published.errors.join("; ")}`);
  const expectedBytes = new TextEncoder().encode(renderLandingMirror(sourceData));
  if (body.length !== expectedBytes.length || body.some((byte, index) => byte !== expectedBytes[index])) {
    throw new Error(`published revision ${published.catalog.revision} does not match source revision ${source.catalog.revision} and contents`);
  }
  return published.catalog.revision;
}

async function main() {
  const root = resolve(import.meta.dir, "..");
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--check", "--verify-live"].includes(arg)) || args.length > 1) {
    throw new Error("Use no arguments to generate, --check for local drift, or --verify-live after site publication.");
  }
  if (args.includes("--verify-live")) {
    console.log(`Published runtime catalog matches source revision ${await verifyPublishedRuntimeCatalog(root)}.`);
    return;
  }
  if (args.includes("--check")) {
    const results = await checkCatalogOutputs(root);
    let failed = false;
    for (const result of results) {
      if (result.match) {
        console.log(`match  ${result.path}`);
      } else {
        failed = true;
        console.log(`NO MATCH  ${result.path}`);
        if (result.detail) console.log(`        ${result.detail}`);
      }
    }
    process.exit(failed ? 1 : 0);
  }
  for (const output of await renderCatalogOutputs(root)) {
    await writeFile(resolve(root, output.path), output.content);
    console.log(`wrote  ${relative(root, resolve(root, output.path))}`);
  }
}

if (import.meta.main) await main();
