import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { allGroups, changedFiles, dependentsOf, GROUPS, groupNamed, importClosure, ROOT, select } from "./test-groups.ts";

const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts as Record<string, string>;
const names = (paths: string[]) => select(paths).groups.map(([name]) => name);
const always = ["cli-happy", "remote-target-programs", "test-groups", "protocol", "release-scripts", "pairing-repo-checks"];
const scratch: string[] = [];
const temporary = () => { const dir = mkdtempSync(join(tmpdir(), "scout-test-groups-")); scratch.push(dir); return dir; };
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("suite parity", () => {
  test("the explicit root chains run exactly all registry steps in suite order", () => {
    expect(scripts["test:unit"]).toBe("bun run test:cli && bun run test:unit:source");
    const steps = allGroups().flatMap((group) => group.steps.map((step) => step.join(" ")));
    expect(steps[0]).toBe("bun run test:cli");
    expect(scripts["test:unit:source"]).toBe(steps.slice(1).join(" && "));
    expect(scripts["test:unit"]!.split(" && ").flatMap((step) => step === "bun run test:unit:source" ? scripts["test:unit:source"]!.split(" && ") : [step])).toEqual(steps);
    expect(new Set(GROUPS.map((group) => group.name)).size).toBe(GROUPS.length);
    expect(allGroups().map((group) => group.name)).not.toContain("pairing-repo-checks");
    for (const file of ["pairing-trust-owner-census", "pairing-v1-closure"]) {
      expect(scripts["test:pairing-capsule"]).toContain(`scripts/${file}.test.ts`);
      expect(groupNamed("pairing-repo-checks").steps.flat()).toContain(`scripts/${file}.test.ts`);
    }
  });

  test("package commands expose list, run and changed", () => {
    expect(scripts["test:groups"]).toBe("bun scripts/test-groups.ts list");
    expect(scripts["test:group"]).toBe("bun scripts/test-groups.ts run");
    expect(scripts["test:changed"]).toBe("bun scripts/test-groups.ts changed");
  });
});

describe("change selection", () => {
  test("protocol changes select its dependents, not independent harness packages", () => {
    const selected = names(["packages/protocol/src/records.ts"]);
    for (const group of ["protocol", "runtime", "pairing", "cli", "mesh-extension"]) expect(selected).toContain(group);
    expect(selected).not.toContain("agent-sessions");
    expect(selected).not.toContain("session-trace");
    expect(dependentsOf("packages/protocol")).toEqual(["packages/cli", "packages/mesh-extension", "packages/pairing", "packages/runtime"]);
  });

  test("agent-sessions changes select session-trace and the other dependents", () => {
    const selected = names(["packages/agent-sessions/src/index.ts"]);
    for (const group of ["agent-sessions", "session-trace", "runtime", "pairing", "cli", "mesh-extension"]) expect(selected).toContain(group);
  });

  test("dependency cycles do not include the starting package", () => {
    const graph = [{ name: "@openscout/a", dir: "a", deps: ["@openscout/b"] }, { name: "@openscout/b", dir: "b", deps: ["@openscout/a"] }];
    expect(dependentsOf("a", graph)).toEqual(["b"]);
  });

  test("docs-only and empty changes run exactly the always set", () => {
    expect(GROUPS.filter((group) => group.always).map((group) => group.name)).toEqual(always);
    expect(names(["docs/architecture.md", "AGENTS.md", "CONTRIBUTING.md", "llms.txt", "docs.json"])).toEqual(always);
    expect(names([])).toEqual(always);
  });

  test("unrelated runtime source does not select the capsule", () => {
    expect(names(["packages/runtime/src/mobile-push.ts"])).not.toContain("pairing-capsule");
    expect(names(["packages/agent-sessions/src/adapters/codex/transport.ts"])).not.toContain("pairing-capsule");
  });

  test("pairing-security selects the capsule without repeating repository checks", () => {
    for (const file of ["packages/runtime/src/pairing-security/trust-owner.ts", "packages/runtime/src/node-identity.ts"]) {
      const selected = names([file]);
      expect(selected).toContain("pairing-capsule");
      expect(selected).not.toContain("pairing-repo-checks");
      expect(selected).toContain("release-scripts");
      expect(selected).toContain("runtime");
    }
  });

  test("root manifests, lockfiles, CI and runner changes select the full suite", () => {
    for (const file of ["package.json", "bun.lock", "bun.lockb", "bunfig.toml", ".github/workflows/ci.yml", "scripts/test-groups.ts"]) {
      expect(select([file]).full).toBe(true);
      expect(names([file])).toEqual(allGroups().map((group) => group.name));
    }
  });

  test("Rust changes produce an actionable note, including with full-suite inputs", () => {
    const file = "crates/scoutd/src/main.rs";
    expect(names([file])).toEqual(always);
    for (const changed of [[file], ["package.json", file]]) {
      expect(select(changed).notes.join("\n")).toContain(`${file}: Rust; run the matching scoutd, tui or repo-service check`);
    }
  });

  test("shared root helpers select packages as well as root groups", () => {
    const selected = names(["scripts/fixtures/pairing-capsule.ts"]);
    expect(selected).toContain("pairing-capsule");
    expect(selected).toContain("runtime");
    expect(selected).toContain("pairing");
    expect(selected).toContain("cli");
    expect(selected).toContain("mesh-extension");
    expect(selected).not.toContain("pairing-repo-checks");
  });

  test("unknown inputs select the full suite rather than silently skipping tests", () => {
    expect(select(["scripts/new-helper.ts"]).full).toBe(true);
    expect(select(["new-config.json"]).full).toBe(true);
  });

  test("selection is unique and in registry order", () => {
    const selected = names(["packages/runtime/src/index.ts", "packages/protocol/src/index.ts", "packages/protocol/src/index.ts"]);
    expect(selected).toEqual(GROUPS.filter((group) => selected.includes(group.name)).map((group) => group.name));
  });
});

describe("capsule dependencies", () => {
  test("closure includes canonical owner, node identity, workers and emitted source", () => {
    const closure = importClosure(groupNamed("pairing-capsule").entries!());
    for (const file of ["packages/runtime/src/pairing-security/trust-owner.ts", "packages/runtime/src/node-identity.ts", "scripts/pairing-cutover-worker.ts", "scripts/pairing-trust-owner-worker.ts", "scripts/fixtures/pairing-v1/pairing-security/trust-owner.ts"]) expect(closure.has(file)).toBe(true);
    expect([...closure].some((file) => file.includes("/dist/"))).toBe(false);
    expect(names(["scripts/pairing-cutover-worker.ts"])).toContain("pairing-capsule");
    expect(names(["scripts/pairing-slot-reclamation-worker.ts"])).toContain("pairing-capsule");
  });

  test("workspace exports are resolved, not guessed from their public subpath", () => {
    const closure = importClosure(["packages/pairing/src/fixtures/pairing-secure-local-reader.ts"]);
    expect(closure.has("packages/runtime/src/node-identity.ts")).toBe(true);
    expect(closure.has("packages/runtime/src/mesh/node-identity.ts")).toBe(false);
  });

  test("shebangs and deleted imports do not truncate the closure", () => {
    const root = temporary();
    const entry = join(root, "entry.ts"), dependency = join(root, "dependency.ts");
    writeFileSync(entry, '#!/usr/bin/env bun\nimport "./dependency.js";\n');
    writeFileSync(dependency, 'export const value = 1;\n');
    const expected = relative(ROOT, dependency);
    expect(importClosure([relative(ROOT, entry)]).has(expected)).toBe(true);
    rmSync(dependency);
    expect(importClosure([relative(ROOT, entry)]).has(expected)).toBe(true);
    writeFileSync(entry, 'import "./dependency";\n');
    expect(importClosure([relative(ROOT, entry)]).has(expected)).toBe(true);
  });

  test("invalid dependencies fail with a diagnostic rather than a partial closure", () => {
    const root = temporary(); const file = join(root, "invalid.ts");
    writeFileSync(file, "export const = ;");
    expect(() => importClosure([relative(ROOT, file)])).toThrow("cannot scan test dependency");
  });
});

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
}

test("Git selection includes branch, staged, unstaged, deleted, untracked and renamed paths", () => {
  const root = temporary();
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  for (const file of ["rename.ts", "deleted.ts", "unstaged.ts", "staged-reverted.ts"]) writeFileSync(join(root, file), file);
  git(root, "add", "."); git(root, "commit", "-qm", "Initial fixture"); git(root, "branch", "base");
  writeFileSync(join(root, "branch.ts"), "branch");
  git(root, "add", "."); git(root, "commit", "-qm", "Branch fixture");
  renameSync(join(root, "rename.ts"), join(root, "renamed.ts"));
  rmSync(join(root, "deleted.ts"));
  writeFileSync(join(root, "staged.ts"), "staged");
  writeFileSync(join(root, "staged-reverted.ts"), "staged change"); git(root, "add", ".");
  writeFileSync(join(root, "staged-reverted.ts"), "staged-reverted.ts");
  writeFileSync(join(root, "unstaged.ts"), "unstaged");
  writeFileSync(join(root, " untracked\nfile.ts"), "untracked");
  writeFileSync(join(root, ".gitignore"), "ignored.ts\n");
  writeFileSync(join(root, "ignored.ts"), "ignored");
  expect(changedFiles("base", root)).toEqual([" untracked\nfile.ts", ".gitignore", "branch.ts", "deleted.ts", "rename.ts", "renamed.ts", "staged-reverted.ts", "staged.ts", "unstaged.ts"]);
  expect(() => changedFiles("missing-base", root)).toThrow("failed");
});

function cli(args: string[], env = process.env) {
  const result = Bun.spawnSync([process.execPath, join(ROOT, "scripts/test-groups.ts"), ...args], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

describe("command line", () => {
  test("list reports groups; plan deduplicates names in suite order", () => {
    const list = cli(["list", "--plan"]);
    expect(list.code).toBe(0);
    for (const group of GROUPS) expect(list.out).toContain(group.name);
    const plan = cli(["run", "release-scripts", "protocol", "protocol", "--plan"]);
    expect(plan.code).toBe(0);
    expect(plan.out.trim().split(/\s+/)).toEqual(["protocol", "release-scripts"]);
    expect(plan.out).not.toContain("$ ");
    expect(cli(["run", "all", "--plan"]).out.trim().split(/\s+/)).toEqual(allGroups().map((group) => group.name));
  });

  test("with-dependents adds the package graph without independent packages", () => {
    const result = cli(["run", "protocol", "--with-dependents", "--plan"]);
    expect(result.code).toBe(0);
    expect(result.out.trim().split(/\s+/)).toEqual(["cli-happy", "protocol", "runtime", "pairing", "cli", "mesh-extension"]);
    expect(cli(["run", "agent-sessions", "--with-dependents", "--plan"]).out).toContain("session-trace");
  });

  test("invalid names, options and missing values fail before running tests", () => {
    for (const args of [["run"], ["run", "all", "typo"], ["run", "protocol", "--typo"], ["changed", "--base"], ["changed", "--base", "--plan"], ["changed", "protocol"], ["list", "--base", "HEAD"], ["typo"]]) {
      const result = cli(args);
      expect(result.code).toBe(2);
      expect(result.err).toContain("[test-groups]");
      expect(result.out).not.toContain("$ ");
    }
  });

  test("changed accepts a base override and plan never executes a group", () => {
    const result = cli(["changed", "--base", "HEAD", "--plan"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("changed file(s)");
    expect(result.out).not.toContain("$ ");
    const missing = cli(["changed", "--base", "refs/heads/nonexistent-test-groups-base", "--plan"]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("git merge-base");
  });

  test("failed groups continue by default, --bail stops, and either returns failure", () => {
    const root = temporary(); const bin = join(root, "bin"); mkdirSync(bin);
    const log = join(root, "invocations");
    writeFileSync(join(bin, "bun"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_GROUP_LOG"\ncase "$*" in *packages/protocol*) exit 7 ;; *) exit 0 ;; esac\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_GROUP_LOG: log };
    const continued = cli(["run", "protocol", "agent-sessions"], env);
    expect(continued.code).toBe(1);
    expect(continued.out).toContain("1 group(s) failed");
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
    writeFileSync(log, "");
    const bailed = cli(["run", "protocol", "agent-sessions", "--bail"], env);
    expect(bailed.code).toBe(1);
    expect(bailed.out).toContain("skipped after failure: agent-sessions");
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  });
});
