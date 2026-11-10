#!/usr/bin/env node

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  statSync,
  renameSync,
  existsSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageExtensionChannel } from "../../runtime/scripts/stage-extension-channel.mjs";
import { stageScoutd } from "./stage-scoutd.mjs";
import { bundleRuntimeEntrypoints } from "./runtime-entrypoints.mjs";

import {
  bundleScoutKnowledgeIndexChildBun,
  getOpenScoutRepoRoot,
  REFLECT_METADATA_BANNER,
  verifyBundleStaticChecks,
} from "../../../scripts/bundle-core.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..");
const repoRoot = getOpenScoutRepoRoot();
const entryFile = resolve(packageDirectory, "src/main.ts");
const nodeEntryFile = resolve(packageDirectory, "src/node-main.ts");
const statuslineEntryFile = resolve(packageDirectory, "src/statusline.ts");
const outputDirectory = resolve(packageDirectory, "dist");
const outputFile = resolve(outputDirectory, "main.mjs");
const nodeOutputDirectory = resolve(outputDirectory, "node");
const nodeOutputFile = resolve(nodeOutputDirectory, "main.mjs");
const statuslineOutput = resolve(outputDirectory, "statusline.mjs");
const updateHelperEntry = resolve(packageDirectory, "src/update-helper.ts");
const updateHelperOutput = resolve(outputDirectory, "update-helper.mjs");
const knowledgeIndexChildOutput = resolve(outputDirectory, "knowledge-index-child.mjs");
const pairingRuntimeControllerOutput = resolve(outputDirectory, "pairing-runtime-controller.mjs");
const runtimeOutputDirectory = resolve(outputDirectory, "runtime");
const buildManifestOutput = resolve(outputDirectory, "build-manifest.json");

function gitOutput(args) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if ((result.status ?? 1) !== 0) return null;
  return result.stdout?.trim() ?? "";
}

function gitValue(args) {
  return gitOutput(args) || null;
}

function readPackageVersion() {
  try {
    const parsed = JSON.parse(readFileSync(resolve(packageDirectory, "package.json"), "utf8"));
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : null;
  } catch {
    return null;
  }
}

// This manifest is the artifact identity scoutd evaluates. Runtime status must
// describe the code that was actually bundled, not whichever commit happens to
// be checked out when a stale bundle is launched later.
const sourceStatus = gitOutput(["status", "--porcelain", "--untracked-files=normal"]);
const buildManifest = {
  schemaVersion: 1,
  packageName: "@openscout/scout",
  version: readPackageVersion(),
  commit: gitValue(["rev-parse", "HEAD"]),
  branch: gitValue(["rev-parse", "--abbrev-ref", "HEAD"]),
  sourceDirty: sourceStatus === null ? null : sourceStatus.length > 0,
  builtAt: new Date().toISOString(),
};

// The published @openscout/scout package root is what broker-process-manager's
// resolveScoutdCommand() treats as `runtimePackageDir` at runtime, and its first
// (preferred) package candidate is `<runtimePackageDir>/bin/scoutd`. Drop the
// prebuilt scoutd release artifact there so npm-installed users (no monorepo,
// no Rust toolchain) get a working broker service without falling back to
// building from source. The current package artifact is Apple Silicon macOS;
// support for other architectures should add first-class platform artifacts,
// not loosen this install path into source-build or cross-arch fallbacks.
const scoutdReleaseBinary = resolve(repoRoot, "target", "release", "scoutd");
const scoutdPackagedBinary = resolve(packageDirectory, "bin", "scoutd");
const scoutdSignScript = resolve(repoRoot, "scripts", "sign-scoutd.sh");

// Clean the complete output tree: a reused checkout must not repack stale app files.
rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });
stageExtensionChannel(outputDirectory, true);
rmSync(buildManifestOutput, { force: true });

// The Node-targeted CLI resolves the pairing package's closed dist exports.
const pairingBuild = spawnSync("bun", ["run", "--cwd", resolve(repoRoot, "packages/pairing"), "build"], {
  cwd: repoRoot, stdio: "inherit",
});
if ((pairingBuild.status ?? 1) !== 0) process.exit(pairingBuild.status ?? 1);

const chatResult = spawnSync("bun", ["build", resolve(packageDirectory, "src/chat-main.ts"), "--target=node", "--format=esm", "--outfile", resolve(outputDirectory, "chat.mjs")], { cwd: packageDirectory, stdio: "inherit" });
if ((chatResult.status ?? 1) !== 0) process.exit(chatResult.status ?? 1);

// Use --outdir so bun can emit WASM/asset side-files alongside the main bundle
const result = spawnSync(
  "bun",
  [
    "build",
    entryFile,
    "--target=bun",
    "--outdir",
    outputDirectory,
    REFLECT_METADATA_BANNER,
  ],
  { cwd: packageDirectory, stdio: "inherit" },
);

if ((result.status ?? 1) !== 0) {
  process.exit(result.status ?? 1);
}

const statuslineResult = spawnSync(
  "bun",
  ["build", statuslineEntryFile, "--target=bun", "--format=esm", "--outfile", statuslineOutput, REFLECT_METADATA_BANNER],
  { cwd: packageDirectory, stdio: "inherit" },
);

if ((statuslineResult.status ?? 1) !== 0) {
  process.exit(statuslineResult.status ?? 1);
}

const updateHelperResult = spawnSync("bun", ["build", updateHelperEntry, "--target=bun", "--format=esm", "--outfile", updateHelperOutput, REFLECT_METADATA_BANNER], { cwd: packageDirectory, stdio: "inherit" });
if ((updateHelperResult.status ?? 1) !== 0 || !verifyBundleStaticChecks(updateHelperOutput)) process.exit(1);

rmSync(nodeOutputDirectory, { recursive: true, force: true });
mkdirSync(nodeOutputDirectory, { recursive: true });
const nodeResult = spawnSync(
  "bun",
  ["build", nodeEntryFile, "--target=node", "--outdir", nodeOutputDirectory, REFLECT_METADATA_BANNER],
  { cwd: packageDirectory, stdio: "inherit" },
);

if ((nodeResult.status ?? 1) !== 0) {
  process.exit(nodeResult.status ?? 1);
}

if (!buildAndPackageScoutd()) {
  process.exit(1);
}

// Package the standalone session-indexing worker beside the CLI.
if (!bundleScoutKnowledgeIndexChildBun(repoRoot, knowledgeIndexChildOutput)) {
  process.exit(1);
}

if (!bundleRuntimeEntrypoints(repoRoot, runtimeOutputDirectory)) {
  process.exit(1);
}

// Ship the drizzle managed-migration folder (baseline + journal) with the
// package. resolveControlPlaneDrizzleMigrationsFolder() probes ../drizzle and
// ./drizzle around each bundle, so this one dist/drizzle copy serves both
// dist/main.mjs and the dist/runtime/*.mjs daemon bundles; without it the
// packaged CLI silently skips managed migrations.
const drizzleSourceDirectory = resolve(repoRoot, "packages", "runtime", "drizzle");
const drizzleOutputDirectory = resolve(outputDirectory, "drizzle");
rmSync(drizzleOutputDirectory, { recursive: true, force: true });
cpSync(drizzleSourceDirectory, drizzleOutputDirectory, { recursive: true });
if (!existsSync(resolve(drizzleOutputDirectory, "meta", "_journal.json"))) {
  console.error("  ERROR: dist/drizzle copy is missing meta/_journal.json.");
  process.exit(1);
}
console.log(`  copied managed migrations -> ${drizzleOutputDirectory}`);

// Whether the broker service binary MUST be present when this build finishes.
// Publishing without it silently recreates the "Unable to locate scoutd"
// regression for npm-installed users, so any publish path must fail loudly.
// Ordinary dev builds (`npm run build` without Rust installed) only warn.
function scoutdIsRequired() {
  if (process.env.OPENSCOUT_REQUIRE_SCOUTD === "1") return true;
  if (process.env.OPENSCOUT_SKIP_SCOUTD === "1") return false;
  // npm sets these during `npm publish` / the prepack lifecycle.
  if (process.env.npm_command === "publish") return true;
  if (process.env.npm_lifecycle_event === "prepack") return true;
  return false;
}

function describeBinary(file) {
  const result = spawnSync("file", [file], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return (result.stdout || result.stderr || "").trim();
}

function scoutdIsExpectedPackageBinary(file) {
  return describeBinary(file).includes("Mach-O 64-bit executable arm64");
}

function buildAndPackageScoutd() {
  const required = scoutdIsRequired();
  const cargoScript = resolve(repoRoot, "scripts", "cargo.sh");

  console.log("  building scoutd (release)…");
  const build = spawnSync(
    "bash",
    [
      cargoScript,
      "build",
      "--release",
      "--manifest-path",
      resolve(repoRoot, "crates", "scoutd", "Cargo.toml"),
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        ...(buildManifest.commit ? { SCOUTD_GIT_SHA: buildManifest.commit } : {}),
      },
    },
  );

  if ((build.status ?? 1) !== 0) {
    // cargo.sh exits 127 when no cargo toolchain is found. A machine without
    // Rust can still package a prebuilt release binary (e.g. copied from
    // another build host); the format gate below still rejects wrong-arch
    // artifacts, so fall through to the shared validation/copy path.
    if (build.status === 127 && existsSync(scoutdReleaseBinary)) {
      console.warn("  WARN: cargo not found; packaging existing target/release/scoutd instead.");
    } else {
      const message =
        build.status === 127
          ? "cargo not found; cannot build the scoutd broker service binary"
          : `scoutd build failed (exit ${build.status ?? "unknown"})`;
      if (required) {
        console.error(`  ERROR: ${message}.`);
        console.error("  Publishing without scoutd would ship a broken broker service.");
        console.error("  Install Rust (https://rustup.rs) or set CARGO=/path/to/cargo, then retry.");
        return false;
      }
      console.warn(`  WARN: ${message}; skipping scoutd packaging (dev build).`);
      console.warn("  The broker service will not work from an npm install built this way.");
      return true;
    }
  }

  if (!existsSync(scoutdReleaseBinary)) {
    console.error(`  ERROR: scoutd build reported success but ${scoutdReleaseBinary} is missing.`);
    return !required;
  }

  if (!scoutdIsExpectedPackageBinary(scoutdReleaseBinary)) {
    const description = describeBinary(scoutdReleaseBinary) || "unknown binary format";
    const message = `scoutd package binary must be a macOS arm64 Mach-O (the current Apple Silicon release artifact), got: ${description}`;
    if (required) {
      console.error(`  ERROR: ${message}.`);
      console.error("  Publishing this binary would ship the wrong native executable for the current package.");
      return false;
    }
    console.warn(`  WARN: ${message}; skipping scoutd packaging (dev build).`);
    rmSync(scoutdPackagedBinary, { force: true });
    return true;
  }

  // NOTE/STOPGAP: we copy the host-built darwin-arm64 binary straight into the
  // package. Apple Silicon macOS is the first-class release path today. If
  // platform support expands, select first-class prebuilts per {os, cpu}
  // instead of accepting mismatched binaries or source-build fallbacks.
  // Stage, sign, then rename over the packaged path. The live supervisor runs
  // this exact file; writing or re-signing it in place rewrites the running
  // image, and the kernel SIGKILLs scoutd ("Code Signature Invalid"), taking
  // the broker, web server and every open lane down with it.
  const signatureRequired = required || process.env.OPENSCOUT_REQUIRE_SCOUTD_SIGN === "1";
  const staged = stageScoutd({
    sourceBinary: scoutdReleaseBinary,
    packagedBinary: scoutdPackagedBinary,
    requireSignature: signatureRequired,
    sign: (stagedBinary) => {
      const result = spawnSync("bash", [scoutdSignScript, scoutdReleaseBinary, stagedBinary], {
        cwd: repoRoot, stdio: "inherit",
      });
      const signed = (result.status ?? 1) === 0;
      if (!signed) {
        if (signatureRequired) console.error("  ERROR: scoutd signing failed.");
        else console.warn("  WARN: scoutd signing failed; continuing because this is a dev build.");
      }
      return signed;
    },
  });
  if (!staged) return false;
  const sizeMb = (statSync(scoutdPackagedBinary).size / (1024 * 1024)).toFixed(1);
  console.log(`  packaged scoutd -> ${scoutdPackagedBinary} (${sizeMb} MB, darwin-arm64)`);
  return true;
}

const pairingRuntimeControllerEntry = resolve(repoRoot, "packages", "pairing", "src", "pairing-runtime-controller.ts");
const pairingRuntimeControllerResult = spawnSync(
  "bun",
  ["build", pairingRuntimeControllerEntry, "--target=bun", "--format=esm", "--outfile", pairingRuntimeControllerOutput, REFLECT_METADATA_BANNER],
  { cwd: packageDirectory, stdio: "inherit" },
);

if ((pairingRuntimeControllerResult.status ?? 1) !== 0) {
  process.exit(pairingRuntimeControllerResult.status ?? 1);
}

// The mobile reader is a sibling of each bundle that can serve phone reads.
for (const directory of [outputDirectory, nodeOutputDirectory]) {
  const result = spawnSync("bun", ["build",
    resolve(repoRoot, "packages/pairing/src/db/mobile-read-worker-entry.ts"),
    "--target=bun", "--format=esm", "--outfile",
    resolve(directory, "mobile-read-worker-entry.js"), REFLECT_METADATA_BANNER,
  ], { cwd: packageDirectory, stdio: "inherit" });
  if ((result.status ?? 1) !== 0 || !verifyBundleStaticChecks(resolve(directory, "mobile-read-worker-entry.js"))) {
    process.exit(result.status || 1);
  }
}

// bun names the entry output after the source file (main.js); rename to main.mjs
const bunOutput = resolve(outputDirectory, "main.js");
if (existsSync(bunOutput) && bunOutput !== outputFile) {
  renameSync(bunOutput, outputFile);
}
const nodeBuiltOutput = resolve(nodeOutputDirectory, "node-main.js");
if (existsSync(nodeBuiltOutput) && nodeBuiltOutput !== nodeOutputFile) {
  renameSync(nodeBuiltOutput, nodeOutputFile);
}

function normalizeBunExecutable(path) {
  const built = readFileSync(path, "utf8");
  const normalized = built
    .replace(/^#![^\n]*\n/, "")
    .replace(/^\/\/ @bun\n/, "");

  writeFileSync(path, `#!/usr/bin/env bun\n${normalized}`);
  chmodSync(path, 0o755);
}

function normalizeNodeExecutable(path) {
  const built = readFileSync(path, "utf8");
  const normalized = built
    .replace(/^#![^\n]*\n/, "")
    .replace(/^\/\/ @bun\n/, "");

  writeFileSync(path, `#!/usr/bin/env node\n${normalized}`);
  chmodSync(path, 0o755);
}

normalizeBunExecutable(outputFile);
normalizeBunExecutable(statuslineOutput);
normalizeNodeExecutable(nodeOutputFile);

for (const built of [outputFile, statuslineOutput, nodeOutputFile, pairingRuntimeControllerOutput]) {
  if (!verifyBundleStaticChecks(built)) {
    process.exit(1);
  }
}

writeFileSync(buildManifestOutput, `${JSON.stringify(buildManifest, null, 2)}\n`);
console.log(`  wrote build identity -> ${buildManifestOutput}`);
