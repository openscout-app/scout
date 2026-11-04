#!/usr/bin/env node
// Bumper for the release version and public npm package.
//
// Usage:
//   bun scripts/bump-version.mjs <new-version>    # e.g. 0.3.6-dev.1
//   node scripts/bump-version.mjs patch           # 0.2.38 -> 0.2.39
//   node scripts/bump-version.mjs minor           # 0.2.38 -> 0.3.0
//   node scripts/bump-version.mjs major           # 0.2.38 -> 1.0.0
//
// Walks every first-party package manifest that carries an OpenScout product
// version, rewrites their `version` fields, and rewrites pinned first-party
// package dependency ranges when needed.

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const RELEASE_MANIFESTS = [
  ".",
  "packages/agent-sessions",
  "packages/cli",
  "packages/protocol",
  "packages/runtime",
  "packages/session-trace",
  "packages/pairing",
];

const RELEASE_VERSION_SOURCES = [
  {
    path: "packages/cli/src/lib/shared/product.ts",
    pattern: /(export const SCOUT_APP_VERSION = process\.env\.SCOUT_APP_VERSION\?\.trim\(\) \|\| ")([^"]+)(";)/,
  },
];

const RELEASE_JSON_VERSION_FILES = ["docs.json"];
// The MCP Registry entry names one exact npm version of the Scout package, both
// as its own version and in its package entry. Both are rewritten in place so
// the file keeps its hand formatting.
const REGISTRY_SERVER_FILE = "packages/cli/server.json";
const REGISTRY_PACKAGE = "@openscout/scout";
const LOCKFILE_PATH = "bun.lock";
const LOCKFILE_WORKSPACES = RELEASE_MANIFESTS.filter((relativePath) => relativePath !== ".");

const DEP_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const BACKUP_FILENAME = ".package.json.publish-backup";

async function readPkg(dir) {
  return JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
}

async function writePkg(dir, pkg) {
  await fs.writeFile(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

function bumpSemver(current, kind) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) throw new Error(`Cannot parse semver: ${current}`);
  let [, maj, min, pat] = match;
  maj = Number(maj); min = Number(min); pat = Number(pat);
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  if (kind === "patch") return `${maj}.${min}.${pat + 1}`;
  throw new Error(`Unknown bump kind: ${kind}`);
}

function compareSemver(left, right) {
  const leftParts = left.split("-")[0].split(".").map(Number);
  const rightParts = right.split("-")[0].split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  const leftDev = left.match(/-dev\.(\d+)$/)?.[1];
  const rightDev = right.match(/-dev\.(\d+)$/)?.[1];
  if (leftDev === undefined) return rightDev === undefined ? 0 : 1;
  if (rightDev === undefined) return -1;
  return Number(leftDev) - Number(rightDev);
}

function registryServerVersions(contents) {
  const server = JSON.parse(contents);
  const scoutPackage = server.packages?.find((entry) => entry.identifier === REGISTRY_PACKAGE);
  return { server: server.version, package: scoutPackage?.version };
}

function rewriteRegistryServer(contents, currentVersion, nextVersion) {
  let replaced = 0;
  const rewritten = contents.replace(/("version"\s*:\s*")([^"]+)(")/g, (match, open, version, close) => {
    if (version !== currentVersion) return match;
    replaced += 1;
    return `${open}${nextVersion}${close}`;
  });
  const written = registryServerVersions(rewritten);
  if (replaced !== 2 || written.server !== nextVersion || written.package !== nextVersion) {
    throw new Error(`Could not rewrite the server and ${REGISTRY_PACKAGE} versions in ${REGISTRY_SERVER_FILE}`);
  }
  return rewritten;
}

function lockfileWorkspaceVersion(contents, relativePath) {
  const marker = `    "${relativePath}": {`;
  const start = contents.indexOf(marker);
  if (start < 0) throw new Error(`Could not find ${relativePath} workspace in ${LOCKFILE_PATH}`);
  const nextWorkspace = contents.indexOf('\n    "', start + marker.length);
  const end = nextWorkspace >= 0 ? nextWorkspace : contents.length;
  const block = contents.slice(start, end);
  const match = /("version"\s*:\s*")([^"]+)(")/.exec(block);
  if (!match) throw new Error(`Could not find ${relativePath} version in ${LOCKFILE_PATH}`);
  return { version: match[2], start: start + match.index + match[1].length, end: start + match.index + match[1].length + match[2].length };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const arg = args.find((a) => !a.startsWith("--"));
  if (!arg) {
    console.error("Usage: bump-version.mjs <version | patch | minor | major> [--dry-run]");
    process.exit(1);
  }

  // Read current version from the public Scout package. All release manifests
  // are synced to that product stream.
  const anchor = await readPkg(path.join(REPO_ROOT, "packages/cli"));
  const currentVersion = anchor.version;

  const nextVersion = ["patch", "minor", "major"].includes(arg)
    ? bumpSemver(currentVersion, arg)
    : arg;

  if (!/^\d+\.\d+\.\d+(?:-dev\.(?:0|[1-9]\d*))?$/.test(nextVersion)) {
    console.error(`Invalid version: ${nextVersion}`);
    process.exit(1);
  }
  if (compareSemver(nextVersion, currentVersion) < 0) {
    throw new Error(`Refusing to downgrade the public release from ${currentVersion} to ${nextVersion}.`);
  }

  // Validate every version source before writing any of them. This keeps a
  // missing pattern or stale manifest from leaving a half-bumped worktree.
  for (const rel of RELEASE_MANIFESTS) {
    const pkg = await readPkg(path.join(REPO_ROOT, rel));
    if (pkg.version !== currentVersion) {
      throw new Error(
        `Release manifests are not lockstep before bump: ${rel}/package.json=${pkg.version}, `
          + `expected ${currentVersion}.`,
      );
    }
  }
  for (const source of RELEASE_VERSION_SOURCES) {
    const contents = await fs.readFile(path.join(REPO_ROOT, source.path), "utf8");
    const match = source.pattern.exec(contents);
    if (!match) throw new Error(`Could not find release version in ${source.path}`);
    if (match[2] !== currentVersion) {
      throw new Error(
        `Release sources are not lockstep before bump: ${source.path}=${match[2]}, `
          + `expected ${currentVersion}.`,
      );
    }
  }
  for (const relativePath of RELEASE_JSON_VERSION_FILES) {
    const contents = JSON.parse(await fs.readFile(path.join(REPO_ROOT, relativePath), "utf8"));
    if (contents.version !== currentVersion) {
      throw new Error(
        `Release sources are not lockstep before bump: ${relativePath}=${contents.version}, `
          + `expected ${currentVersion}.`,
      );
    }
  }
  const registryServerContents = await fs.readFile(path.join(REPO_ROOT, REGISTRY_SERVER_FILE), "utf8");
  const registryVersions = registryServerVersions(registryServerContents);
  if (registryVersions.server !== currentVersion || registryVersions.package !== currentVersion) {
    throw new Error(
      `Release sources are not lockstep before bump: ${REGISTRY_SERVER_FILE}=${registryVersions.server}, `
        + `${REGISTRY_PACKAGE}=${registryVersions.package}, expected ${currentVersion}.`,
    );
  }
  const registryServerRewrite = nextVersion === currentVersion
    ? registryServerContents
    : rewriteRegistryServer(registryServerContents, currentVersion, nextVersion);
  const lockfileContents = await fs.readFile(path.join(REPO_ROOT, LOCKFILE_PATH), "utf8");
  for (const relativePath of LOCKFILE_WORKSPACES) {
    const observed = lockfileWorkspaceVersion(lockfileContents, relativePath).version;
    if (observed !== currentVersion) {
      throw new Error(
        `Release lockfile is not lockstep before bump: ${relativePath}=${observed}, `
          + `expected ${currentVersion}.`,
      );
    }
  }

  // Map of package-name -> new-version (for pinned cross-package rewrites).
  const rewriteMap = new Map();
  for (const rel of RELEASE_MANIFESTS) {
    if (rel === ".") continue;
    const pkg = await readPkg(path.join(REPO_ROOT, rel));
    if (pkg.name) rewriteMap.set(pkg.name, nextVersion);
  }

  let touched = 0;
  for (const rel of RELEASE_MANIFESTS) {
    const dir = path.join(REPO_ROOT, rel);
    const pkg = await readPkg(dir);
    const priorVersion = pkg.version;
    let changed = false;

    if (pkg.version !== nextVersion) {
      pkg.version = nextVersion;
      changed = true;
    }

    for (const section of DEP_SECTIONS) {
      const deps = pkg[section];
      if (!deps) continue;
      for (const name of Object.keys(deps)) {
        const range = deps[name];
        if (typeof range !== "string") continue;
        if (range.startsWith("workspace:")) continue;
        if (!rewriteMap.has(name)) continue;
        const pinned = rewriteMap.get(name);
        if (range !== pinned) {
          deps[name] = pinned;
          changed = true;
        }
      }
    }

    if (changed) {
      if (!dryRun) await writePkg(dir, pkg);
      touched += 1;
      console.log(`  ${rel}: ${priorVersion} -> ${nextVersion}${dryRun ? " (dry)" : ""}`);
    }

    if (!dryRun) {
      // Clear any stale publish backup that would otherwise revert this bump.
      const backup = path.join(dir, BACKUP_FILENAME);
      if (existsSync(backup)) {
        await fs.unlink(backup);
        console.log(`  ${rel}: cleared stale ${BACKUP_FILENAME}`);
      }
    }
  }

  for (const source of RELEASE_VERSION_SOURCES) {
    const file = path.join(REPO_ROOT, source.path);
    const contents = await fs.readFile(file, "utf8");
    const match = source.pattern.exec(contents);
    if (!match) {
      throw new Error(`Could not find release version in ${source.path}`);
    }
    if (match[2] === nextVersion) continue;

    if (!dryRun) {
      await fs.writeFile(file, contents.replace(source.pattern, `$1${nextVersion}$3`));
    }
    touched += 1;
    console.log(`  ${source.path}: ${match[2]} -> ${nextVersion}${dryRun ? " (dry)" : ""}`);
  }

  for (const relativePath of RELEASE_JSON_VERSION_FILES) {
    const file = path.join(REPO_ROOT, relativePath);
    const contents = JSON.parse(await fs.readFile(file, "utf8"));
    const priorVersion = contents.version;
    if (priorVersion === nextVersion) continue;

    if (!dryRun) {
      contents.version = nextVersion;
      await fs.writeFile(file, `${JSON.stringify(contents, null, 2)}\n`);
    }
    touched += 1;
    console.log(`  ${relativePath}: ${priorVersion} -> ${nextVersion}${dryRun ? " (dry)" : ""}`);
  }

  if (registryServerRewrite !== registryServerContents) {
    if (!dryRun) await fs.writeFile(path.join(REPO_ROOT, REGISTRY_SERVER_FILE), registryServerRewrite);
    touched += 1;
    console.log(`  ${REGISTRY_SERVER_FILE}: ${currentVersion} -> ${nextVersion}${dryRun ? " (dry)" : ""}`);
  }

  let rewrittenLockfile = lockfileContents;
  let lockfileChanged = false;
  for (const relativePath of LOCKFILE_WORKSPACES) {
    const observed = lockfileWorkspaceVersion(rewrittenLockfile, relativePath);
    if (observed.version === nextVersion) continue;
    rewrittenLockfile =
      rewrittenLockfile.slice(0, observed.start)
      + nextVersion
      + rewrittenLockfile.slice(observed.end);
    lockfileChanged = true;
  }
  if (lockfileChanged) {
    if (!dryRun) await fs.writeFile(path.join(REPO_ROOT, LOCKFILE_PATH), rewrittenLockfile);
    touched += 1;
    console.log(`  ${LOCKFILE_PATH}: workspace versions -> ${nextVersion}${dryRun ? " (dry)" : ""}`);
  }

  if (touched === 0) {
    console.log(`\nAll release version sources are already ${nextVersion}.`);
    return;
  }

  console.log(`\n${dryRun ? "Would bump" : "Bumped"} ${touched} release version source(s) to ${nextVersion}.`);
}

await main();
