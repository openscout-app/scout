#!/usr/bin/env bun
/**
 * Named test groups for the Scout core.
 *
 *   bun run test:groups                  list the groups
 *   bun run test:group <name...>         run named groups; `all` is the full unit suite
 *   bun run test:changed [--base <ref>]  run the groups that a diff needs
 *
 * Options: `--plan` prints the selection and runs nothing. `--bail` stops at the
 * first failing group. `--with-dependents` (test:group) adds the packages that
 * depend on a named package.
 *
 * The full suite (`bun run test:unit`) stays the merge gate on the exact head.
 * `test:changed` is the handoff gate between rounds of work.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");

export interface TestGroup {
  name: string;
  summary: string;
  /** Commands, each run from the repository root. */
  steps: string[][];
  /** The package directory it tests. A change there, or in a package it depends on, selects it. */
  package?: string;
  /** Selected for every change. Kept to cheap groups. */
  always?: boolean;
  /** Test entries and non-imported inputs. Their import closure selects the group. */
  entries?: () => string[];
  /** Further paths that select the group, such as build inputs a compiled smoke uses. */
  triggers?: RegExp[];
  /** False when the group repeats part of another group, so `all` leaves it out. */
  inAll?: boolean;
}

const RELEASE_SCRIPT_TESTS = [
  "scripts/ship-release.test.mjs",
  "scripts/bump-version.test.mjs",
  "scripts/production-workflows.test.mjs",
  "scripts/release-notes.test.mjs",
  "scripts/bundle-core.test.mjs",
  "scripts/check-core-boundary.test.mjs",
  "scripts/check-packed-dependencies.test.mjs",
];

const PAIRING_REPO_CHECKS = ["scripts/pairing-trust-owner-census.test.ts", "scripts/pairing-v1-closure.test.ts"];

const pkgTest = (dir: string, script = "test") => [["bun", "run", "--cwd", dir, script]];

/** In the order the full suite runs them. `test:unit:source` must list the same steps (see the test). */
export const GROUPS: TestGroup[] = [
  { name: "cli-happy", summary: "CLI launcher and package tests (Node)", steps: [["bun", "run", "test:cli"]], package: "packages/cli", always: true },
  { name: "remote-target-programs", summary: "Static check of the remote target program registry", steps: [["bun", "run", "test:remote-target-programs"]], always: true },
  { name: "test-groups", summary: "This runner's own tests", steps: [["bun", "test", "scripts/test-groups.test.ts"]], always: true, entries: () => ["scripts/test-groups.test.ts"] },
  { name: "protocol", summary: "@openscout/protocol", steps: pkgTest("packages/protocol"), package: "packages/protocol", always: true },
  { name: "agent-sessions", summary: "@openscout/agent-sessions", steps: pkgTest("packages/agent-sessions"), package: "packages/agent-sessions" },
  { name: "runtime", summary: "@openscout/runtime, scenarios included, live tests excluded", steps: pkgTest("packages/runtime"), package: "packages/runtime" },
  { name: "pairing", summary: "@openscout/pairing (isolated)", steps: pkgTest("packages/pairing"), package: "packages/pairing" },
  { name: "cli", summary: "CLI and MCP source tests", steps: pkgTest("packages/cli", "test:source"), package: "packages/cli" },
  { name: "session-trace", summary: "@openscout/session-trace", steps: pkgTest("packages/session-trace"), package: "packages/session-trace" },
  { name: "release-scripts", summary: "Release, bump, workflow, bundle and boundary script tests (Node)", steps: [["node", "--test", ...RELEASE_SCRIPT_TESTS]], always: true, entries: () => RELEASE_SCRIPT_TESTS },
  { name: "mesh-extension", summary: "@openscout/mesh-extension", steps: pkgTest("packages/mesh-extension"), package: "packages/mesh-extension" },
  { name: "vercel-board-worker", summary: "@openscout/vercel-board-worker: the Vercel Board worker (Node)", steps: pkgTest("packages/vercel-board-worker"), package: "packages/vercel-board-worker" },
  {
    name: "pairing-capsule",
    summary: "Pairing trust owner process, cutover and reclamation tests, controls and Node 24 compiled smokes",
    steps: [["bun", "run", "test:pairing-capsule"]],
    entries: () => [
      ...scriptFiles("test:pairing-capsule", "test:pairing-cutover:compiled"),
      // Spawned/read by the process tests and mutation controls, not imported.
      "scripts/pairing-trust-owner-worker.ts",
      "scripts/pairing-cutover-worker.ts",
      "scripts/pairing-slot-reclamation-worker.ts",
      "scripts/pairing-quiescent-reclamation-worker.ts",
      "packages/runtime/src/pairing-security/trust-capsule.test.ts",
      "packages/runtime/src/pairing-security/trust-cutover.test.ts",
      "packages/runtime/scripts/stage-extension-channel.mjs",
      "scripts/generate-runtime-catalog.ts",
      "packages/protocol/src/runtime-catalog.v1.json",
    ],
    // The compiled smokes build the runtime, so its build inputs select the group too.
    triggers: [/^packages\/(runtime|agent-sessions)\/(package\.json|tsconfig[^/]*\.json)$/],
  },
  {
    name: "pairing-repo-checks",
    summary: "Repository-wide trust owner census and v1 closure (also inside pairing-capsule)",
    steps: [["bun", "test", "--isolate", ...PAIRING_REPO_CHECKS]],
    always: true,
    inAll: false,
  },
];

/** Changes that can affect any test: the full suite runs. */
const FULL_TRIGGERS = [/^scripts\/test-groups(?:\.test)?\.ts$/, /^\.(nvmrc|npmrc)$/, /^package\.json$/, /^bun\.lockb?$/, /^bunfig\.toml$/, /^tsconfig[^/]*\.json$/, /^\.(bun|node|nvm|tool)-?versions?$/, /^\.github\//];
/** Docs-only inputs covered by the always set. */
const NO_TESTS = [/^docs\//, /^(llms\.txt|docs\.json|LICENSE|NOTICE)$/, /^(?!packages\/)(.*\/)?[^/]+\.md$/];

export function groupNamed(name: string): TestGroup {
  const group = GROUPS.find((g) => g.name === name);
  if (!group) throw new Error(`unknown test group ${name}; run \`bun run test:groups\``);
  return group;
}

export function allGroups(): TestGroup[] {
  return GROUPS.filter((g) => g.inAll !== false);
}

// ---------------------------------------------------------------------------
// Package graph

interface PackageInfo { name: string; dir: string; deps: string[] }

let packageCache: PackageInfo[] | undefined;
export function packages(root = ROOT): PackageInfo[] {
  if (packageCache && root === ROOT) return packageCache;
  const out: PackageInfo[] = [];
  for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    const file = join(root, "packages", entry.name, "package.json");
    if (!entry.isDirectory() || !existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies }).filter((d) => d.startsWith("@openscout/"));
    out.push({ name: pkg.name, dir: `packages/${entry.name}`, deps });
  }
  if (root === ROOT) packageCache = out;
  return out;
}

/** Package directories that depend on `dir`, directly or through others. */
export function dependentsOf(dir: string, all = packages()): string[] {
  const byName = new Map(all.map((p) => [p.name, p.dir]));
  const found = new Set<string>([dir]);
  const visit = (target: string) => {
    for (const p of all) {
      if (found.has(p.dir)) continue;
      if (p.deps.some((d) => byName.get(d) === target)) { found.add(p.dir); visit(p.dir); }
    }
  };
  visit(dir);
  return [...found].filter((p) => p !== dir).sort();
}

// ---------------------------------------------------------------------------
// Import closure of root test entries

/** File paths named in root package.json scripts. */
function scriptFiles(...names: string[]): string[] {
  const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts as Record<string, string>;
  const files = new Set<string>();
  for (const name of names) {
    if (!scripts[name]) throw new Error(`missing package script ${name}`);
    for (const token of scripts[name]!.split(/\s+/)) {
      if (/\.(m?[jt]s)$/.test(token)) files.add(token);
    }
  }
  return [...files];
}

const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const transpilers = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }), js: new Bun.Transpiler({ loader: "js" }) };

function resolveSpecifier(from: string, spec: string): string[] {
  let base: string | undefined;
  if (spec.startsWith(".")) base = join(dirname(from), spec);
  else if (spec.startsWith("@openscout/")) {
    const [, pkgName, ...rest] = spec.split("/");
    const pkg = packages().find((p) => p.name === `@openscout/${pkgName}`);
    if (!pkg) return [];
    const manifest = JSON.parse(readFileSync(join(ROOT, pkg.dir, "package.json"), "utf8"));
    const exported = manifest.exports?.[rest.length ? `./${rest.join("/")}` : "."];
    const target = typeof exported === "string" ? exported : exported?.bun ?? exported?.import ?? exported?.default;
    base = typeof target === "string" ? join(pkg.dir, target) : join(pkg.dir, "src", rest.length ? rest.join("/") : "index");
  } else return [];
  // A compiled smoke imports dist; its source is what changes.
  base = base.replace(/^(packages\/[^/]+)\/dist\//, "$1/src/");
  const stem = base.replace(CODE, "");
  const candidates = [base, ...[".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx"].map((extension) => `${stem}${extension}`), ...["index.ts", "index.tsx", "index.js"].map((entry) => join(stem, entry))];
  for (const candidate of candidates) {
    const full = join(ROOT, candidate);
    if (existsSync(full) && statSync(full).isFile()) return [relative(ROOT, full)];
  }
  // Deleted imports still select their tests. With no file to resolve, retain
  // every candidate (including extensionless and .js-to-.ts source imports).
  return candidates;
}

export function importClosure(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!CODE.test(file) || /\.d\.[cm]?ts$/.test(file)) continue;
    const loader = /\.[jt]sx$/.test(file) ? "tsx" : /\.[cm]?ts$/.test(file) ? "ts" : "js";
    if (!existsSync(join(ROOT, file))) continue;
    let imports: { path: string }[];
    try { imports = transpilers[loader].scanImports(readFileSync(join(ROOT, file), "utf8").replace(/^#![^\n]*/, "")); }
    catch (error) { throw new Error(`cannot scan test dependency ${file}: ${error}`); }
    for (const { path } of imports) {
      for (const target of resolveSpecifier(file, path)) if (!seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

const closureCache = new Map<string, Set<string>>();
function closureOf(group: TestGroup): Set<string> {
  if (!group.entries) return new Set();
  let closure = closureCache.get(group.name);
  if (!closure) closureCache.set(group.name, closure = importClosure(group.entries()));
  return closure;
}

// ---------------------------------------------------------------------------
// Selection

export interface Selection {
  full: boolean;
  /** Group name → why it runs. In suite order. */
  groups: [string, string][];
  notes: string[];
}

export function select(changed: string[]): Selection {
  const reasons = new Map<string, string>();
  const notes: string[] = [];
  const add = (name: string, why: string) => { if (!reasons.has(name)) reasons.set(name, why); };
  const pkgs = packages();
  let full: string | undefined;

  for (const path of changed) {
    if (FULL_TRIGGERS.some((re) => re.test(path))) { full ??= path; continue; }
    if (NO_TESTS.some((re) => re.test(path))) continue;
    if (path.startsWith("crates/")) { notes.push(`${path}: Rust; run the matching scoutd, tui or repo-service check`); continue; }
    let claimed = false;
    const pkg = pkgs.find((p) => path.startsWith(`${p.dir}/`));
    if (pkg) {
      claimed = true;
      const own = GROUPS.filter((g) => g.package === pkg.dir);
      if (!own.length) notes.push(`${path}: ${pkg.dir} has no unit test group`);
      for (const g of own) add(g.name, `changed ${pkg.dir}`);
      for (const dep of dependentsOf(pkg.dir, pkgs)) {
        for (const g of GROUPS.filter((x) => x.package === dep)) add(g.name, `depends on ${pkg.dir}`);
      }
    }
    for (const g of GROUPS) {
      if (g.triggers?.some((re) => re.test(path)) || closureOf(g).has(path)) { claimed = true; add(g.name, `reads ${path}`); }
    }
    // A root helper can be shared by a capsule and package tests. Select both.
    const users = packageSourceImports(path);
    for (const dir of users) {
      claimed = true;
      for (const g of GROUPS.filter((x) => x.package === dir || (x.package && dependentsOf(dir, pkgs).includes(x.package)))) add(g.name, `imports ${path}`);
    }
    // Unknown inputs fail safe instead of assuming that no tests read them.
    if (!claimed) full ??= path;
  }

  if (full) {
    return { full: true, groups: allGroups().map((g) => [g.name, `full suite: ${full}`]), notes };
  }
  for (const g of GROUPS) if (g.always) add(g.name, "always");
  // The capsule already runs the repository-wide checks.
  if (reasons.has("pairing-capsule")) reasons.delete("pairing-repo-checks");
  return { full: false, groups: GROUPS.filter((g) => reasons.has(g.name)).map((g) => [g.name, reasons.get(g.name)!]), notes };
}

let packageClosures: Map<string, Set<string>> | undefined;
/** Packages that import a root helper, including through other root helpers. */
function packageSourceImports(path: string): string[] {
  if (!path.startsWith("scripts/")) return [];
  if (!packageClosures) {
    const closures = new Map<string, Set<string>>();
    for (const p of packages()) {
      const files: string[] = [];
      const walk = (dir: string) => {
        if (!existsSync(dir)) return;
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (["node_modules", "dist", "build"].includes(e.name)) continue;
          const full = join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (CODE.test(e.name)) files.push(relative(ROOT, full));
        }
      };
      walk(join(ROOT, p.dir, "src"));
      closures.set(p.dir, importClosure(files));
    }
    packageClosures = closures;
  }
  return [...packageClosures].filter(([, closure]) => closure.has(path)).map(([dir]) => dir);
}

// ---------------------------------------------------------------------------
// Git and running

function git(args: string[], root: string, separator = "\0"): string[] {
  const out = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${out.stderr.toString().trim()}`);
  return out.stdout.toString().split(separator).filter(Boolean);
}

/** Branch, staged, unstaged and untracked changes; both sides of renames. */
export function changedFiles(base: string, root = ROOT): string[] {
  const [mergeBase] = git(["merge-base", base, "HEAD"], root, "\n");
  if (!mergeBase) throw new Error(`no merge base for ${base} and HEAD`);
  return [...new Set([
    ...git(["diff", "--name-only", "--no-renames", "-z", mergeBase, "--"], root),
    ...git(["diff", "--cached", "--name-only", "--no-renames", "-z", mergeBase, "--"], root),
    ...git(["ls-files", "--others", "--exclude-standard", "-z"], root),
  ])].sort();
}

function nodeMajor(): number {
  const out = Bun.spawnSync(["node", "--version"], { stdout: "pipe", stderr: "ignore" });
  return Number(/^v(\d+)/.exec(out.stdout.toString())?.[1] ?? 0);
}

async function run(names: string[], bail: boolean): Promise<number> {
  if (names.includes("pairing-capsule") && nodeMajor() !== 24) {
    console.warn("[test-groups] pairing-capsule needs exactly Node 24 on PATH for its compiled smokes; it will fail on this node.");
  }
  const results: { name: string; code: number; seconds: number }[] = [];
  for (const name of names) {
    const group = groupNamed(name);
    const started = performance.now();
    let code = 0;
    console.log(`\n[test-groups] ${name}: ${group.summary}`);
    for (const step of group.steps) {
      console.log(`$ ${step.join(" ")}`);
      try {
        code = await Bun.spawn(step, { cwd: ROOT, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
      } catch (error) {
        console.error(`[test-groups] cannot start ${step[0]}: ${error}`);
        code = 1;
      }
      if (code !== 0) break;
    }
    results.push({ name, code, seconds: (performance.now() - started) / 1000 });
    if (code !== 0 && bail) break;
  }
  console.log("\n[test-groups] summary");
  for (const r of results) console.log(`  ${r.code === 0 ? "pass" : "FAIL"}  ${r.name.padEnd(24)} ${r.seconds.toFixed(1)}s`);
  const skipped = names.slice(results.length);
  if (skipped.length) console.log(`  skipped after failure: ${skipped.join(", ")}`);
  const failed = results.filter((r) => r.code !== 0);
  console.log(failed.length ? `[test-groups] ${failed.length} group(s) failed` : "[test-groups] all passed");
  return failed.length ? 1 : 0;
}

function printPlan(selection: Selection, changed?: string[]) {
  if (changed) console.log(`[test-groups] ${changed.length} changed file(s)${selection.full ? "; running the full suite" : ""}`);
  for (const [name, why] of selection.groups) console.log(`  ${name.padEnd(24)} ${why}`);
  for (const note of selection.notes) console.log(`  note: ${note}`);
}

export async function main(argv: string[]): Promise<number> {
  const [command = "list", ...rest] = argv;
  if (!["list", "run", "changed"].includes(command)) throw new Error(`unknown command ${command}; use list, run or changed`);
  const flags = new Set<string>();
  const positional: string[] = [];
  let base = "origin/main";
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--base" && command === "changed") {
      const value = rest[++i];
      if (!value || value.startsWith("--")) throw new Error("--base needs a Git ref");
      base = value;
    } else if (["--plan", "--bail"].includes(arg) || arg === "--with-dependents" && command === "run") flags.add(arg);
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg} for ${command}`);
    else positional.push(arg);
  }
  const plan = flags.has("--plan");
  const bail = flags.has("--bail");
  if (command !== "run" && positional.length) throw new Error(`${command} does not accept group names`);

  if (command === "list") {
    for (const g of GROUPS) {
      const tags = [g.always ? "always" : "", g.package ?? "", g.inAll === false ? "not in all" : ""].filter(Boolean).join(", ");
      console.log(`${g.name.padEnd(24)} ${g.summary}${tags ? ` [${tags}]` : ""}`);
    }
    return 0;
  }
  if (command === "run") {
    if (!positional.length) throw new Error("name one or more groups, or `all`; run `bun run test:groups`");
    // Validate every name, even when `all` is present. Run each once, in suite order.
    for (const name of positional) if (name !== "all") groupNamed(name);
    const selected = new Set(positional.includes("all") ? allGroups().map((g) => g.name) : positional);
    if (flags.has("--with-dependents")) {
      for (const name of [...selected]) {
        const dir = groupNamed(name).package;
        if (!dir) continue;
        for (const g of GROUPS) if (g.package && dependentsOf(dir).includes(g.package)) selected.add(g.name);
      }
    }
    const names = GROUPS.filter((g) => selected.has(g.name)).map((g) => g.name);
    if (plan) { names.forEach((n) => console.log(`  ${n}`)); return 0; }
    return run(names, bail);
  }
  const changed = changedFiles(base);
  const selection = select(changed);
  printPlan(selection, changed);
  if (plan) return 0;
  return run(selection.groups.map(([n]) => n), bail);
}

if (import.meta.main) {
  try { process.exit(await main(Bun.argv.slice(2))); }
  catch (error) { console.error(`[test-groups] ${error instanceof Error ? error.message : error}`); process.exit(2); }
}
