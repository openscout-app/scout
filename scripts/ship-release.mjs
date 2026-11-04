#!/usr/bin/env node
/**
 * Canonical package release entry point for the public Scout repository.
 *
 * Release preparation is intentionally separate. Execution only accepts an
 * already-versioned, reviewed, clean public main commit. Completed matching
 * release state is idempotent; partial immutable npm state fails closed.
 *
 * Package releases carry only the npm integrity receipt. They never claim the
 * repository's GitHub "Latest" release, which belongs to the release carrying
 * the downloadable native installer; existing release Latest state is preserved.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const CANONICAL_REPOSITORY = "https://github.com/openscout-app/scout";
const CANONICAL_GITHUB_REPOSITORY = "openscout-app/scout";

const PUBLIC_PACKAGES = [
  { dir: "packages/protocol", name: "@openscout/protocol" },
  { dir: "packages/cli", name: "@openscout/scout" },
];

const VERSION_MANIFESTS = [
  ".",
  "packages/agent-sessions",
  "packages/cli",
  "packages/protocol",
  "packages/runtime",
  "packages/session-trace",
  "packages/pairing",
];

const APP_VERSION_SOURCE = "packages/cli/src/lib/shared/product.ts";
const DOCS_VERSION_SOURCE = "docs.json";
// The MCP Registry entry names one exact npm version of the Scout package.
const REGISTRY_SERVER_SOURCE = "packages/cli/server.json";
const LOCKFILE_SOURCE = "bun.lock";
const APP_VERSION_PATTERN =
  /export const SCOUT_APP_VERSION = process\.env\.SCOUT_APP_VERSION\?\.trim\(\) \|\| "([^"]+)";/;

function usage() {
  return [
    "Usage:",
    "  node scripts/ship-release.mjs <version> [options]",
    "",
    "Example:",
    "  bun run ship -- <version>",
    "  bun run ship -- <version> --execute --yes",
    "",
    "Options:",
    "  --execute              Resume or run the package release.",
    "  --yes                  Required with --execute.",
    "  --phase <release|candidate|promote>",
    "                         Default release; candidate holds both Latest channels.",
    "  --auth <token|npm-login>",
    "                         Local authentication mode; token is the default.",
    "  --source <original-sha> --receipt-sha256 <digest>",
    "    --candidate-receipt-sha256 <digest>",
    "                         Finalize/promote original retained candidate using newer tooling.",
    "  --local-publish        Publish a stable release from this machine. Use only",
    "                         when the hosted workflow cannot run.",
    "  --release-notes-file <path>",
    "                         Use explicit GitHub release notes.",
    "",
    "The GitHub release carries the npm receipt and is created with --latest=false;",
    "GitHub Latest stays on the downloadable native installer release.",
    "",
    "Execution never bumps or commits. Prepare and merge the reviewed release",
    "version first, then run from a clean public main checkout.",
    "Stable releases publish from the hosted release-package-npm.yml workflow, so",
    "npm records provenance for them. Local execution needs --local-publish; it uses",
    "explicit local authentication and signed artifacts, without OIDC provenance.",
    "",
  ].join("\n");
}

function readSource(relativePath, source = null) {
  return source ? capture("git", ["show", `${source}:${relativePath}`]) : readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function readJson(relativePath, source = null) {
  return JSON.parse(readSource(relativePath, source));
}

function packageVersion(relativeDir, source = null) {
  const manifestPath = relativeDir === "." ? "package.json" : relativeDir + "/package.json";
  return readJson(manifestPath, source).version;
}

function parseArgs(argv) {
  const options = {
    execute: false,
    yes: false,
    phase: "release",
    releaseNotesFile: null,
    auth: process.env.SCOUT_NPM_AUTH_MODE ?? "token",
    source: null,
    receiptSha256: null,
    candidateReceiptSha256: null,
    localPublish: false,
  };
  let target = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--github-npm") {
      throw new Error(
        "--github-npm is disabled: hosted publication requires explicit workflow dispatch; "
          + "this command never falls back to hosted execution.",
      );
    }
    if (arg === "--execute") options.execute = true;
    else if (arg === "--local-publish") options.localPublish = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--phase") options.phase = argv[++index];
    else if (arg.startsWith("--phase=")) options.phase = arg.slice("--phase=".length);
    else if (["--source", "--receipt-sha256", "--candidate-receipt-sha256"].includes(arg)) {
      const key = { "--source": "source", "--receipt-sha256": "receiptSha256", "--candidate-receipt-sha256": "candidateReceiptSha256" }[arg];
      options[key] = argv[++index];
    }
    else if (arg === "--auth") {
      options.auth = argv[++index];
    } else if (arg.startsWith("--auth=")) {
      options.auth = arg.slice("--auth=".length);
    } else if (arg === "--release-notes-file") {
      options.releaseNotesFile = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--release-notes-file=")) {
      options.releaseNotesFile = arg.slice("--release-notes-file=".length);
    } else if (arg.startsWith("--")) {
      throw new Error("Unsupported release option: " + arg);
    } else if (target) {
      throw new Error("Unexpected extra argument: " + arg);
    } else {
      target = arg;
    }
  }

  if (!target) throw new Error("Missing release version target.");
  if (!["release", "candidate", "promote"].includes(options.phase)) throw new Error("--phase must be release, candidate or promote.");
  if (!["token", "npm-login"].includes(options.auth)) {
    throw new Error("--auth must be token or npm-login.");
  }
  if (options.source || options.receiptSha256 || options.candidateReceiptSha256) {
    if (options.phase === "release") throw new Error("Original retained identity is only supported for explicit candidate or promote phases.");
    if (!/^[a-f0-9]{40}$/.test(options.source ?? "") ||
        !/^[a-f0-9]{64}$/.test(options.receiptSha256 ?? "") ||
        !/^[a-f0-9]{64}$/.test(options.candidateReceiptSha256 ?? "")) {
      throw new Error("Original --source, --receipt-sha256 and --candidate-receipt-sha256 must all be supplied exactly.");
    }
    if (options.execute && options.auth !== "npm-login") throw new Error("Original candidate finalization/promotion requires --auth npm-login.");
  }
  if (!/^\d+\.\d+\.\d+$/.test(target)) {
    throw new Error("Invalid stable version: " + target);
  }
  if (options.releaseNotesFile && !existsSync(path.resolve(repoRoot, options.releaseNotesFile))) {
    throw new Error("Release notes file not found: " + options.releaseNotesFile);
  }
  return { version: target, options };
}

function commandLabel(command, args) {
  return [command, ...args].join(" ");
}

function run(command, args) {
  const label = commandLabel(command, args);
  console.log("\n$ " + label);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) throw new Error(label + " exited with " + result.status);
}

function capture(command, args) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function spawnCapture(command, args) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function normalizeGithubRemote(remote) {
  return remote
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/")
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");
}

function assertCleanWorktree() {
  const status = capture("git", ["status", "--porcelain", "--untracked-files=normal"]);
  if (status) {
    throw new Error(
      "Release execution requires a clean reviewed worktree; found:\n" + status,
    );
  }
}

function assertCanonicalLocalSource() {
  const remote = normalizeGithubRemote(capture("git", ["remote", "get-url", "origin"]));
  if (remote !== CANONICAL_REPOSITORY) {
    throw new Error("Release origin must be " + CANONICAL_REPOSITORY + ", got " + remote);
  }
  const branch = capture("git", ["branch", "--show-current"]);
  if (branch !== "main") {
    throw new Error("Release execution requires public main, got " + (branch || "detached HEAD"));
  }
}

function currentHead() {
  return capture("git", ["rev-parse", "HEAD^{commit}"]);
}

function fetchAndVerifyRemoteMain(expectedHead) {
  run("git", ["fetch", "--no-tags", "origin", "refs/heads/main"]);
  const fetchedMain = capture("git", ["rev-parse", "FETCH_HEAD^{commit}"]);
  const head = currentHead();
  if (head !== expectedHead) {
    throw new Error("Release HEAD changed during verification: " + expectedHead + " -> " + head);
  }
  if (head !== fetchedMain) {
    throw new Error("Release HEAD " + head + " does not match fetched origin/main " + fetchedMain);
  }
}

function readAppVersion(source = null) {
  const contents = readSource(APP_VERSION_SOURCE, source);
  const match = APP_VERSION_PATTERN.exec(contents);
  if (!match) throw new Error("Could not read SCOUT_APP_VERSION from " + APP_VERSION_SOURCE);
  return match[1];
}

function readRegistryServerVersions(source = null) {
  const server = readJson(REGISTRY_SERVER_SOURCE, source);
  const scoutPackage = server.packages?.find((entry) => entry.identifier === "@openscout/scout");
  return { server: server.version, package: scoutPackage?.version };
}

function lockfileWorkspaceVersion(relativePath, source = null) {
  const contents = readSource(LOCKFILE_SOURCE, source);
  const marker = `    "${relativePath}": {`;
  const start = contents.indexOf(marker);
  if (start < 0) throw new Error(`Could not find ${relativePath} in ${LOCKFILE_SOURCE}`);
  const nextWorkspace = contents.indexOf('\n    "', start + marker.length);
  const block = contents.slice(start, nextWorkspace >= 0 ? nextWorkspace : contents.length);
  const version = block.match(/"version"\s*:\s*"([^"]+)"/)?.[1];
  if (!version) throw new Error(`Could not read ${relativePath} version from ${LOCKFILE_SOURCE}`);
  return version;
}

function verifyReleaseVersion(version, source = null) {
  const drift = [];
  for (const relativeDir of VERSION_MANIFESTS) {
    const found = packageVersion(relativeDir, source);
    if (found !== version) drift.push(relativeDir + "=" + found);
  }
  const appVersion = readAppVersion(source);
  if (appVersion !== version) drift.push(APP_VERSION_SOURCE + "=" + appVersion);
  const docsVersion = readJson(DOCS_VERSION_SOURCE, source).version;
  if (docsVersion !== version) drift.push(DOCS_VERSION_SOURCE + "=" + docsVersion);
  const registryVersions = readRegistryServerVersions(source);
  if (registryVersions.server !== version) drift.push(REGISTRY_SERVER_SOURCE + "=" + registryVersions.server);
  if (registryVersions.package !== version) {
    drift.push(REGISTRY_SERVER_SOURCE + ":@openscout/scout=" + registryVersions.package);
  }
  for (const relativeDir of VERSION_MANIFESTS.filter((entry) => entry !== ".")) {
    const lockVersion = lockfileWorkspaceVersion(relativeDir, source);
    if (lockVersion !== version) drift.push(`${LOCKFILE_SOURCE}:${relativeDir}=${lockVersion}`);
  }
  if (drift.length > 0) {
    throw new Error("Reviewed release sources are not synced to " + version + ": " + drift.join(", "));
  }
  for (const pkg of PUBLIC_PACKAGES) {
    const manifest = readJson(pkg.dir + "/package.json", source);
    if (manifest.name !== pkg.name || manifest.version !== version) {
      throw new Error(
        "Published package identity mismatch in "
          + pkg.dir + ": " + manifest.name + "@" + manifest.version,
      );
    }
  }
}

function printVersionTable(version, source = null) {
  console.log("Release source verification:");
  for (const relativeDir of VERSION_MANIFESTS) {
    const label = relativeDir === "." ? "root package.json" : relativeDir + "/package.json";
    console.log("  " + label + ": " + packageVersion(relativeDir, source));
  }
  console.log("  " + APP_VERSION_SOURCE + ": " + readAppVersion(source));
  console.log("  " + DOCS_VERSION_SOURCE + ": " + readJson(DOCS_VERSION_SOURCE, source).version);
  console.log("  " + REGISTRY_SERVER_SOURCE + ": " + readRegistryServerVersions(source).server);
  console.log(`  ${LOCKFILE_SOURCE}: all workspace versions ${version}`);
  console.log("\nPublished package set:");
  for (const pkg of PUBLIC_PACKAGES) console.log("  " + pkg.name + "@" + version);
}

function hostedPublicationMessage(version, phase) {
  const tag = "v" + version;
  return [
    "Stable releases publish from GitHub Actions, so npm records provenance for them.",
    ...(phase === "candidate" ? [
      "The hosted workflow has no candidate hold: it publishes straight to npm latest.",
      "A held candidate needs --local-publish and has no npm provenance.",
    ] : []),
    "After the reviewed release merges, tag the tip of public main and dispatch before",
    "anything else merges; the workflow requires the tag to be main's tip:",
    "  git fetch <public remote> main",
    `  git tag -a ${tag} FETCH_HEAD -m "Scout ${version}"`,
    `  git push <public remote> refs/tags/${tag}`,
    `  gh workflow run release-package-npm.yml --repo openscout-app/scout --ref main -f tag=${tag} -f npm_tag=latest`,
    "Add --local-publish only when the hosted workflow cannot run. A local publish has no npm provenance.",
  ].join("\n");
}

function printPlan(version, options) {
  const tag = "v" + version;
  if (options.phase !== "release") {
    console.log(`\nLocal ${options.phase} steps:`);
    console.log("  DRY require clean current public main, exact reviewed version/source/tag and retained signed candidates");
    console.log("  DRY local " + options.auth + " authentication; no OIDC provenance");
    if (options.source) {
      console.log(`  DRY original candidate source ${options.source}; newer tooling HEAD never replaces artifact identity`);
      console.log("  DRY verify original tag, ancestry, receipt and candidate-marker digests, tarball bytes and complete registry pair");
      console.log("  DRY no build, tag creation or npm upload; partial pair requires separate candidate-only retained recovery");
      console.log(options.phase === "candidate"
        ? "  DRY finalize original candidate-receipt.json; prerelease --latest=false; both Latest channels held"
        : "  DRY verify original public candidate-receipt.json, explicitly promote exact complete pair, finalize --latest=false");
      return;
    }
    if (options.phase === "candidate") {
      console.log("  DRY create/verify exact public version tag; ship-npm.sh --prepare");
      console.log("  DRY ship-npm.sh --publish-candidate; --verify-candidate");
      console.log("  DRY retain and upload candidate-receipt.json; prerelease --latest=false");
      console.log("  DRY npm latest and GitHub Latest unchanged; validate exact candidates before promotion");
    } else {
      console.log("  DRY verify original retained bundle and public candidate-receipt.json before any mutation");
      console.log("  DRY ship-npm.sh --verify-candidate; --promote-prepared; --verify-published (no rebuild or npm upload)");
      console.log("  DRY attach ordinary receipt.json and finalize stable package release --latest=false");
      console.log("  DRY GitHub Latest remains with the native installer owner");
    }
    return;
  }
  console.log("\nRelease steps:");
  console.log("  DRY require clean openscout-app/scout main already versioned at " + version);
  console.log("  DRY git fetch --no-tags origin refs/heads/main");
  console.log("  DRY bash scripts/ship-npm.sh --verify-state");
  console.log("  DRY create or verify " + tag + " at HEAD");
  console.log(
    "  DRY git push --atomic origin HEAD:refs/heads/main refs/tags/"
      + tag + ":refs/tags/" + tag,
  );
  console.log("  DRY bash scripts/ship-npm.sh --prepare");
  console.log("  DRY bash scripts/ship-npm.sh --publish-prepared");
  console.log("  DRY local " + options.auth + " authentication; signed artifacts; no OIDC provenance");
  console.log("  DRY bash scripts/ship-npm.sh --verify-published");
  console.log("  DRY attach the exact npm integrity receipt to " + tag);
  const note = options.releaseNotesFile
    ? " --notes-file " + options.releaseNotesFile
    : " --generate-notes";
  console.log("  DRY create, finalize, or verify GitHub release " + tag + note + " --latest=false");
  console.log("  DRY leave GitHub Latest (downloadable native installer) unchanged");
}

function localTagCommit(tag) {
  const result = spawnCapture("git", ["rev-parse", "--verify", "refs/tags/" + tag + "^{commit}"]);
  if (result.status === 0) return result.stdout.trim();
  const diagnostic = (result.stdout || "") + "\n" + (result.stderr || "");
  if (/unknown revision|needed a single revision|ambiguous argument/i.test(diagnostic)) return null;
  throw new Error("Could not inspect local tag " + tag + ": " + diagnostic.trim());
}

function remoteTagCommit(tag) {
  const directRef = "refs/tags/" + tag;
  const peeledRef = directRef + "^{}";
  const result = spawnCapture("git", ["ls-remote", "--tags", "origin", directRef, peeledRef]);
  if (result.status !== 0) {
    throw new Error(
      "Could not inspect remote tag " + tag + ": "
        + ((result.stderr || result.stdout || "unknown error").trim()),
    );
  }
  const refs = new Map();
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [object, ref] = line.trim().split(/\s+/, 2);
    refs.set(ref, object);
  }
  return refs.get(peeledRef) ?? refs.get(directRef) ?? null;
}

function assertMatchingTagState(tag, expectedHead) {
  const local = localTagCommit(tag);
  if (local && local !== expectedHead) {
    throw new Error("Local tag " + tag + " points to " + local + ", expected " + expectedHead);
  }
  const remote = remoteTagCommit(tag);
  if (remote && remote !== expectedHead) {
    throw new Error("Remote tag " + tag + " points to " + remote + ", expected " + expectedHead);
  }
  return { local, remote };
}

function ensureRemoteTag(tag, expectedHead) {
  let state = assertMatchingTagState(tag, expectedHead);
  if (!state.local) {
    run("git", ["tag", "-a", tag, "-m", "Release " + tag, expectedHead]);
    state = assertMatchingTagState(tag, expectedHead);
  }
  if (!state.remote) {
    run("git", [
      "push", "--atomic", "origin",
      "HEAD:refs/heads/main",
      "refs/tags/" + tag + ":refs/tags/" + tag,
    ]);
    state = assertMatchingTagState(tag, expectedHead);
  }
  if (state.local !== expectedHead || state.remote !== expectedHead) {
    throw new Error("Could not establish matching local and remote " + tag + " state.");
  }
}

function inspectGithubRelease(tag) {
  const result = spawnCapture("gh", [
    "release", "view", tag,
    "--repo", CANONICAL_GITHUB_REPOSITORY,
    "--json", "tagName,isDraft,isPrerelease,url,assets",
  ]);
  if (result.status === 0) {
    let release;
    try {
      release = JSON.parse(result.stdout);
    } catch {
      throw new Error("Could not parse GitHub release state for " + tag + ".");
    }
    if (release.tagName !== tag) {
      throw new Error("GitHub release tag mismatch: " + release.tagName + ", expected " + tag);
    }
    return release;
  }
  const diagnostic = (result.stdout || "") + "\n" + (result.stderr || "");
  if (/release not found|not found|HTTP 404/i.test(diagnostic)) return null;
  throw new Error("Could not inspect GitHub release " + tag + ": " + diagnostic.trim());
}

function ensureGithubRelease(tag, options) {
  let release = inspectGithubRelease(tag);
  if (!release) {
    const args = [
      "release", "create", tag,
      "--repo", CANONICAL_GITHUB_REPOSITORY,
      "--verify-tag",
      "--title", "Scout " + tag,
      // A receipt-only package release must not displace the native installer
      // release that GitHub's /releases/latest downloads resolve to.
      "--latest=false",
    ];
    if (options.releaseNotesFile) args.push("--notes-file", options.releaseNotesFile);
    else args.push("--generate-notes");
    run("gh", args);
    release = inspectGithubRelease(tag);
  }
  if (!release) throw new Error("GitHub release " + tag + " was not observable after creation.");
  if (release.isDraft) {
    run("gh", [
      "release", "edit", tag,
      "--repo", CANONICAL_GITHUB_REPOSITORY,
      "--draft=false",
      "--latest=false",
    ]);
    release = inspectGithubRelease(tag);
  }
  if (release?.isPrerelease) {
    run("gh", [
      "release", "edit", tag,
      "--repo", CANONICAL_GITHUB_REPOSITORY,
      "--prerelease=false",
      "--latest=false",
    ]);
    release = inspectGithubRelease(tag);
  }
  if (!release || release.isDraft || release.isPrerelease) {
    throw new Error("GitHub release " + tag + " is not a final stable release.");
  }
  console.log("\nGitHub release: " + release.url);
  return release;
}

function npmReleaseReceiptPath(version, releaseSha) {
  if (process.env.SCOUT_NPM_RELEASE_STATE_DIR) {
    return path.resolve(repoRoot, process.env.SCOUT_NPM_RELEASE_STATE_DIR, "receipt.json");
  }
  const commonDirectory = capture("git", [
    "rev-parse", "--path-format=absolute", "--git-common-dir",
  ]);
  return path.join(
    commonDirectory,
    "scout-release",
    "npm",
    version + "-" + releaseSha,
    "receipt.json",
  );
}

function ensureGithubReceiptAsset(tag, receiptPath, assetName = "receipt.json", uploadMissing = true) {
  if (!existsSync(receiptPath) || !statSync(receiptPath).isFile()) {
    throw new Error("Verified npm release receipt is missing: " + receiptPath);
  }
  const expected = readFileSync(receiptPath);
  let release = inspectGithubRelease(tag);
  let asset = release?.assets?.find((candidate) => candidate.name === assetName);
  if (!asset) {
    if (!uploadMissing) throw new Error("Public candidate receipt is missing; promotion refused.");
    run("gh", [
      "release", "upload", tag, receiptPath,
      "--repo", CANONICAL_GITHUB_REPOSITORY,
    ]);
    release = inspectGithubRelease(tag);
    asset = release?.assets?.find((candidate) => candidate.name === assetName);
  }
  if (!asset || asset.size !== expected.length) {
    throw new Error("GitHub npm receipt asset size mismatch; refusing to overwrite it.");
  }
  const publicUrl = `https://github.com/${CANONICAL_GITHUB_REPOSITORY}/releases/download/${tag}/${assetName}`;
  const downloaded = execFileSync("curl", [
    "--disable", "--fail", "--location", "--silent", "--show-error",
    "--proto", "=https", "--proto-redir", "=https", "--max-time", "60", publicUrl,
  ], { maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  if (downloaded.length !== expected.length || digest(downloaded) !== digest(expected)) {
    throw new Error("Public GitHub npm receipt bytes differ from retained receipt; refusing overwrite.");
  }

  console.log((assetName === "receipt.json" ? "npm integrity receipt" : "npm candidate receipt") + ": " + asset.url);
}

function candidateReceiptPath(receiptPath) {
  return path.join(path.dirname(receiptPath), "candidate-receipt.json");
}

function candidateReceiptBytes(receiptPath, version, head) {
  const original = readFileSync(receiptPath);
  const receipt = JSON.parse(original);
  if (receipt.schemaVersion !== 1 || receipt.repository !== CANONICAL_REPOSITORY ||
      receipt.releaseVersion !== version || receipt.releaseSha !== head || receipt.authority !== "local-signed") {
    throw new Error("Candidate must bind the exact local public integrity receipt.");
  }
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    kind: "scout-npm-candidate",
    releaseState: "CANDIDATE",
    repository: receipt.repository,
    releaseVersion: version,
    releaseSha: head,
    authority: receipt.authority,
    provenance: "none",
    stagingTag: `scout-release-${version.replaceAll(".", "-")}`,
    integrityReceiptSha256: createHash("sha256").update(original).digest("hex"),
    packages: receipt.packages,
  }, null, 2) + "\n");
}

function verifyLocalCandidateReceipt(receiptPath, version, head, create = false) {
  const target = candidateReceiptPath(receiptPath);
  const expected = candidateReceiptBytes(receiptPath, version, head);
  if (!existsSync(target)) {
    if (!create) throw new Error("Original candidate receipt is missing; promotion refused.");
    writeFileSync(target, expected, { flag: "wx", mode: 0o600 });
  }
  if (!readFileSync(target).equals(expected)) throw new Error("Original candidate receipt disagrees with retained source/artifacts.");
  return target;
}

function ensureCandidateRelease(tag, options) {
  let release = inspectGithubRelease(tag);
  if (!release) {
    const args = ["release", "create", tag, "--repo", CANONICAL_GITHUB_REPOSITORY,
      "--verify-tag", "--title", `Scout ${tag} candidate`, "--prerelease", "--latest=false"];
    if (options.releaseNotesFile) args.push("--notes-file", options.releaseNotesFile);
    else args.push("--notes", "Candidate for validation. npm latest and GitHub Latest are not promoted by this phase.");
    run("gh", args);
    release = inspectGithubRelease(tag);
  }
  if (!release || release.isDraft || !release.isPrerelease) throw new Error("Candidate release must remain a non-draft prerelease.");
  return release;
}

function finalizeOriginalCandidate(version, options, toolingHead) {
  const source = options.source;
  const tag = "v" + version;
  if (process.env.SCOUT_NPM_RELEASE_STATE_DIR) throw new Error("Original candidate requires the Git-common-directory bundle; overrides refused.");
  const ancestry = spawnCapture("git", ["merge-base", "--is-ancestor", source, toolingHead]);
  if (ancestry.status !== 0) throw new Error("Original candidate source must be an ancestor of reviewed tooling HEAD.");
  const requireOriginalTag = () => {
    const tags = assertMatchingTagState(tag, source);
    if (tags.local !== source || tags.remote !== source) throw new Error("Original candidate requires both original local and remote tags; missing tags are not recreated.");
  };
  requireOriginalTag();
  const receiptPath = npmReleaseReceiptPath(version, source);
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  if (hash(readFileSync(receiptPath)) !== options.receiptSha256) throw new Error("Original integrity receipt SHA-256 mismatch.");
  const markerPath = verifyLocalCandidateReceipt(receiptPath, version, source);
  if (hash(readFileSync(markerPath)) !== options.candidateReceiptSha256) throw new Error("Original candidate receipt SHA-256 mismatch.");
  const retainedArgs = ["scripts/recover-local-npm-release.mjs", "--version", version, "--source", source,
    "--receipt-sha256", options.receiptSha256, "--candidate-receipt-sha256", options.candidateReceiptSha256,
    "--phase", options.phase];
  if (options.phase === "candidate") retainedArgs.push("--require-complete");
  // Read-only full retained/public byte verification before any GitHub or npm mutation.
  run("node", retainedArgs);
  const release = inspectGithubRelease(tag);
  if (options.phase === "candidate") {
    if (release && (release.isDraft || !release.isPrerelease)) throw new Error("Candidate cannot relabel a draft or stable release.");
    if (release?.assets?.some(asset => asset.name === "candidate-receipt.json")) ensureGithubReceiptAsset(tag, markerPath, "candidate-receipt.json", false);
  } else {
    if (!release || release.isDraft) throw new Error("Original candidate release is missing or draft.");
    ensureGithubReceiptAsset(tag, markerPath, "candidate-receipt.json", false);
  }
  fetchAndVerifyRemoteMain(toolingHead);
  assertCleanWorktree();
  requireOriginalTag();
  if (options.phase === "candidate") {
    ensureCandidateRelease(tag, options);
    ensureGithubReceiptAsset(tag, markerPath, "candidate-receipt.json");
  } else {
    run("node", [...retainedArgs, "--execute", "--yes", "--auth", "npm-login"]);
    ensureGithubRelease(tag, options);
    ensureGithubReceiptAsset(tag, receiptPath);
  }
  run("node", retainedArgs);
  requireOriginalTag();
  fetchAndVerifyRemoteMain(toolingHead);
  assertCleanWorktree();
  if (hash(readFileSync(receiptPath)) !== options.receiptSha256 || hash(readFileSync(markerPath)) !== options.candidateReceiptSha256) throw new Error("Original candidate receipts changed during finalization.");
  console.log(`Scout ${tag} ${options.phase} finalized from original source ${source}; reviewed tooling ${toolingHead}.`);
}

function main() {
  const { version, options } = parseArgs(process.argv.slice(2));
  verifyReleaseVersion(version, options.source);
  printVersionTable(version, options.source);
  printPlan(version, options);

  if (!options.execute) {
    if (options.localPublish || options.source || options.phase === "promote") {
      console.log(`\nDry run only. Re-run with --execute --yes${options.localPublish ? " --local-publish" : ""} after review and merge.`);
    } else {
      console.log("\nDry run only. Stable releases publish from GitHub Actions for npm provenance; --execute --yes prints the dispatch, and local execution also needs --local-publish.");
    }
    return;
  }
  if (!options.yes) throw new Error("Refusing to publish without --yes.");
  const [major, minor, patch] = version.split(".").map(Number);
  if (major === 0 && (minor < 2 || (minor === 2 && patch <= 90))) {
    throw new Error("Historical unsupported versions are read-only; select a reviewed unused version.");
  }
  if (process.env.GITHUB_ACTIONS === "true") {
    throw new Error("This entry point is local-only; dispatch release-package-npm.yml for hosted publication.");
  }
  // Every new upload goes through the hosted workflow. Promotion, retained-candidate
  // finalization, and a release whose local bundle already exists for this HEAD
  // only finish a local release that was already started. ship-npm.sh still
  // refuses to upload anything new unless --local-publish set the marker.
  const resumingLocalRelease = existsSync(npmReleaseReceiptPath(version, currentHead()));
  if (!options.localPublish && !options.source && options.phase !== "promote" && !resumingLocalRelease) {
    throw new Error(hostedPublicationMessage(version, options.phase));
  }
  if (options.localPublish) process.env.SCOUT_NPM_LOCAL_PUBLISH = "1";
  else delete process.env.SCOUT_NPM_LOCAL_PUBLISH;
  if (!options.localPublish && options.phase !== "promote") process.env.SCOUT_NPM_RESUME_ONLY = "1";
  else delete process.env.SCOUT_NPM_RESUME_ONLY;
  process.env.SCOUT_NPM_AUTH_MODE = options.auth;

  assertCanonicalLocalSource();
  assertCleanWorktree();
  const head = currentHead();
  fetchAndVerifyRemoteMain(head);
  assertCleanWorktree();
  if (options.source) {
    finalizeOriginalCandidate(version, options, head);
    return;
  }

  const tag = "v" + version;
  assertMatchingTagState(tag, head);
  run("bash", ["scripts/ship-npm.sh", "--verify-state"]);

  assertCleanWorktree();
  if (currentHead() !== head) throw new Error("Release HEAD changed during package verification.");
  fetchAndVerifyRemoteMain(head);
  assertCleanWorktree();
  const existingRelease = inspectGithubRelease(tag);
  if (options.phase === "candidate" && existingRelease && (existingRelease.isDraft || !existingRelease.isPrerelease)) {
    throw new Error("Candidate cannot relabel a draft or stable release.");
  }
  const receiptPath = npmReleaseReceiptPath(version, head);
  const retainedCandidate = existsSync(candidateReceiptPath(receiptPath)) ||
    existingRelease?.assets?.some(asset => asset.name === "candidate-receipt.json");
  if (options.phase === "release" && (!existingRelease || existingRelease.isPrerelease) && retainedCandidate) {
    throw new Error("This is a retained candidate; use explicit --phase promote after validation.");
  }
  if (options.phase === "promote") {
    const tags = assertMatchingTagState(tag, head);
    if (tags.local !== head || tags.remote !== head) throw new Error("Promotion requires the original exact candidate tag.");
    if (!existingRelease || existingRelease.isDraft) throw new Error("Original candidate release is missing or draft.");
    const candidatePath = verifyLocalCandidateReceipt(receiptPath, version, head);
    ensureGithubReceiptAsset(tag, candidatePath, "candidate-receipt.json", false);
    run("bash", ["scripts/ship-npm.sh", "--verify-candidate"]);
    run("bash", ["scripts/ship-npm.sh", "--promote-prepared"]);
    run("bash", ["scripts/ship-npm.sh", "--verify-published"]);
    ensureGithubRelease(tag, options);
    ensureGithubReceiptAsset(tag, receiptPath);
    if (remoteTagCommit(tag) !== head) throw new Error("Candidate tag changed during promotion.");
    console.log(`Scout ${tag} promoted from the exact retained candidate at ${head}.`);
    return;
  }
  ensureRemoteTag(tag, head);

  run("bash", ["scripts/ship-npm.sh", "--prepare"]);
  if (options.phase === "candidate") {
    const candidatePath = verifyLocalCandidateReceipt(receiptPath, version, head, true);
    // If a prior candidate exists, verify its bytes before another publication attempt.
    if (existingRelease?.assets?.some(asset => asset.name === "candidate-receipt.json")) {
      const prior = verifyLocalCandidateReceipt(receiptPath, version, head);
      ensureGithubReceiptAsset(tag, prior, "candidate-receipt.json", false);
    }
    run("bash", ["scripts/ship-npm.sh", "--publish-candidate"]);
    run("bash", ["scripts/ship-npm.sh", "--verify-candidate"]);
    ensureCandidateRelease(tag, options);
    ensureGithubReceiptAsset(tag, candidatePath, "candidate-receipt.json");
    if (remoteTagCommit(tag) !== head) throw new Error("Candidate tag changed during publication.");
    console.log(`Scout ${tag} candidate ready under scout-release-${version.replaceAll(".", "-")}; Latest channels unchanged.`);
    return;
  }
  run("bash", ["scripts/ship-npm.sh", "--publish-prepared"]);
  run("bash", ["scripts/ship-npm.sh", "--verify-published"]);
  ensureGithubRelease(tag, options);
  ensureGithubReceiptAsset(tag, npmReleaseReceiptPath(version, head));

  const finalTag = remoteTagCommit(tag);
  if (finalTag !== head) {
    throw new Error("Final remote tag verification failed: " + finalTag + ", expected " + head);
  }
  console.log("\nScout " + tag + " release complete at " + head + ".");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
