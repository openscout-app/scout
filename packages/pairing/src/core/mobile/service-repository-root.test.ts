import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMobileRepositoryRoot } from "./service.ts";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scout-repository-"));
  temporaryRoots.push(root);
  const checkout = join(root, "main");
  await mkdir(join(checkout, ".git"), { recursive: true });
  return { root, checkout };
}

test("normal checkout resolves to its top level", async () => {
  const { checkout } = await fixture();
  expect(await readMobileRepositoryRoot(checkout)).toBe(checkout);
});

test("linked worktree resolves relative gitdir and commondir to the main checkout", async () => {
  const { root, checkout } = await fixture();
  const worktree = join(root, "linked");
  await mkdir(worktree);
  const gitDir = join(checkout, ".git", "worktrees", "linked");
  await mkdir(gitDir, { recursive: true });
  await writeFile(join(worktree, ".git"), "gitdir: ../main/.git/worktrees/linked\n");
  await writeFile(join(gitDir, "commondir"), "../..\n");
  expect(await readMobileRepositoryRoot(worktree)).toBe(checkout);
  await mkdir(join(worktree, "src"));
  expect(await readMobileRepositoryRoot(join(worktree, "src"))).toBe(checkout);
});

test("checkout subdirectory resolves to its top level", async () => {
  const { checkout } = await fixture();
  const subdirectory = join(checkout, "packages", "example");
  await mkdir(subdirectory, { recursive: true });
  expect(await readMobileRepositoryRoot(subdirectory)).toBe(checkout);
});

test("non-repository and unavailable paths resolve to null", async () => {
  const { root } = await fixture();
  expect(await readMobileRepositoryRoot(root)).toBeNull();
  expect(await readMobileRepositoryRoot(join(root, "missing"))).toBeNull();
});

test("invalid linked-worktree metadata resolves to null", async () => {
  const { root } = await fixture();
  const checkout = join(root, "broken");
  await mkdir(checkout);
  await writeFile(join(checkout, ".git"), "gitdir: ../missing\n");
  expect(await readMobileRepositoryRoot(checkout)).toBeNull();
});
