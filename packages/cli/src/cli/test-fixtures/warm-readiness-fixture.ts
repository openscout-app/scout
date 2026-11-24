import { expect } from "bun:test";
import { fileURLToPath } from "node:url";

const WARMUP_ARGUMENT = "--scout-fixture-imports-only";
const IMPORTS_READY = "scout-readiness-fixture-imports-ready\n";

// main.ts itself dispatches at module scope: never import it for warm-up.
// These are its value-import dependencies (plus the lazily imported context),
// not command invocations, runtime requests or native diagnostics.
export const readinessBootstrapImports = [
  "../extension-context.ts", "../command-unavailable.ts", "../core-bootstrap.ts",
  "../discovery.ts", "../context.ts", "../../lib/shared/product.ts",
  "../../../bin/lifecycle-preflight.mjs",
].map(path => fileURLToPath(new URL(path, import.meta.url))).concat(
  Bun.resolveSync("@openscout/runtime/config", import.meta.dir),
);

/** Insert after the synthetic fixture's imports/mocks, BEFORE any operation.
 * Only the import-only process exits here. Every real invocation runs afresh.
 */
export function readinessWarmupExit(imports: readonly string[] = []): string {
  return `if (process.argv[2] === ${JSON.stringify(WARMUP_ARGUMENT)}) {
    for (const module of ${JSON.stringify(imports)}) await import(module);
    process.stdout.write(${JSON.stringify(IMPORTS_READY)});
    process.exit(0);
  }`;
}

// Run from a setup hook, outside the test's operation budget. There is no retry,
// test-timeout increase or successful-result cache; only cold import I/O is warmed.
export async function warmReadinessFixture(fixture: string, options: {
  cwd?: string; env?: NodeJS.ProcessEnv;
} = {}): Promise<void> {
  const child = Bun.spawn([process.execPath, fixture, WARMUP_ARGUMENT], {
    ...options, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 4_000,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: IMPORTS_READY, stderr: "" });
}
