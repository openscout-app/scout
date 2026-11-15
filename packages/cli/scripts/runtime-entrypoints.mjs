import { mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { REFLECT_METADATA_BANNER, verifyBundleStaticChecks } from "../../../scripts/bundle-core.mjs";

/** Build installed runtime entrypoints together with their sibling workers. */
export function bundleRuntimeEntrypoints(repoRoot, outputDirectory) {
  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });
  const entries = [
    ["base", "base-daemon.ts", "base-daemon.mjs"],
    ["broker", "broker-daemon.ts", "broker-daemon.mjs"],
    ["service", "broker-process-manager.ts", "broker-process-manager.mjs"],
    ["discover", "mesh-discover.ts", "mesh-discover.mjs"],
    // WorkerSQLiteProjection resolves this exact sibling name from the broker
    // bundle. Source .ts loading and tsc output do not cover the npm dist tree.
    ["sqlite projection worker", "sqlite-projection-worker-entry.ts", "sqlite-projection-worker-entry.js"],
    // BrokerHealthResponder resolves this sibling name the same way.
    ["health responder worker", "broker-health-responder-worker-entry.ts", "broker-health-responder-worker-entry.js"],
    // runSandboxedFunction resolves this sibling name the same way.
    ["callback sandbox worker", "task-callback-sandbox-worker-entry.ts", "task-callback-sandbox-worker-entry.js"],
  ];
  for (const [label, source, output] of entries) {
    const entryFile = resolve(repoRoot, "packages", "runtime", "src", source);
    const outputFile = resolve(outputDirectory, output);
    const result = spawnSync("bun", [
      "build", entryFile, "--target=bun", "--format=esm", "--outfile", outputFile, REFLECT_METADATA_BANNER,
    ], { cwd: repoRoot, stdio: "inherit" });
    if ((result.status ?? 1) !== 0 || !verifyBundleStaticChecks(outputFile)) return false;
    console.log(`  bundled runtime ${label} -> ${outputFile}`);
  }
  return true;
}
