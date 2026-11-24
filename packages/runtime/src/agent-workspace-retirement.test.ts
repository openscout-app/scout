import { afterEach, describe, expect, test } from "bun:test";
import type { AgentEndpoint } from "@openscout/protocol";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentWorkspace, SCOUT_WORKSPACES_DIRNAME } from "./agent-workspace.js";
import {
  listScoutWorktrees,
  resolveWorktreeRetirementSettings,
  scoutWorktreeProjectRoots,
  scoutWorktreeUsage,
  sweepScoutWorktrees,
  type WorktreeSweepInput,
} from "./agent-workspace-retirement.js";
import { createRuntimeRegistrySnapshot, type RuntimeRegistrySnapshot } from "./registry.js";
import { execSystemFile } from "./system-probes/exec.js";

const NODE = "node-1";
const DAY = 24 * 3_600_000;
const tempRoots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execSystemFile("git", args, { cwd, timeoutMs: 15_000 })).stdout;
}

async function makeRepo(): Promise<string> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-retire-")));
  tempRoots.push(root);
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n.scout-worktrees/\n");
  await git(root, "add", ".gitignore");
  await git(root, "commit", "-q", "-m", "init");
  return root;
}

async function agentWorktree(root: string, agent: string): Promise<string> {
  const created = await createAgentWorkspace(root, agent);
  if (!created) throw new Error("worktree not created");
  return realpathSync(created.path);
}

async function commitIn(worktree: string, file: string): Promise<void> {
  writeFileSync(join(worktree, file), `${file}\n`);
  await git(worktree, "add", file);
  await git(worktree, "commit", "-q", "-m", `add ${file}`);
}

async function branches(root: string): Promise<string[]> {
  return (await git(root, "branch", "--format=%(refname:short)")).split("\n").filter(Boolean);
}

function endpoint(overrides: Partial<AgentEndpoint> & { cwd: string }): AgentEndpoint {
  return {
    id: `endpoint.${overrides.agentId ?? "session-a"}`,
    agentId: "session-a",
    nodeId: NODE,
    transport: "tmux",
    harness: "claude",
    state: "offline",
    sessionId: "session-a",
    metadata: { source: "scout-cardless-session", cardless: true, startedAt: Date.now() - 3 * DAY },
    ...overrides,
  };
}

function sweepInput(
  root: string,
  overrides: Partial<WorktreeSweepInput> & { snapshot?: RuntimeRegistrySnapshot; alive?: (endpoint: AgentEndpoint) => boolean } = {},
): WorktreeSweepInput {
  const snapshot = overrides.snapshot ?? createRuntimeRegistrySnapshot({});
  return {
    projectRoots: [root],
    dryRun: false,
    trigger: "manual",
    settings: { enabled: true, idleHours: 24 },
    // Two days from now: git's own timestamps for these fresh repos read as idle.
    now: () => Date.now() + 2 * DAY,
    usage: (path) => scoutWorktreeUsage(snapshot, path, { nodeId: NODE, isEndpointAlive: overrides.alive ?? (() => false) }),
    ...overrides,
  };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("sweepScoutWorktrees", () => {
  test("retires a clean worktree whose branch is merged, with its ignored files", async () => {
    const root = await makeRepo();
    const worktree = await agentWorktree(root, "quill");
    await commitIn(worktree, "feature.txt");
    await git(root, "merge", "-q", "--ff-only", "scout/quill");
    mkdirSync(join(worktree, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(worktree, "node_modules", "pkg", "index.js"), "x".repeat(4096));

    const report = await sweepScoutWorktrees(sweepInput(root));

    expect(report.worktrees).toEqual([expect.objectContaining({ path: worktree, action: "retired", branchDeleted: true, reasons: [] })]);
    expect(report.retired).toBe(1);
    expect(report.approxBytesReclaimed).toBeGreaterThan(0);
    expect(report.errors).toEqual([]);
    expect(existsSync(worktree)).toBe(false);
    expect(await branches(root)).toEqual(["main"]);
    expect(await git(root, "worktree", "list", "--porcelain")).not.toContain(SCOUT_WORKSPACES_DIRNAME);
    // The merged commit stays reachable from main.
    expect(await git(root, "log", "--format=%s", "main")).toContain("add feature.txt");
  });

  test("a dry run reports what it would retire and changes nothing", async () => {
    const root = await makeRepo();
    const worktree = await agentWorktree(root, "quill");

    const report = await sweepScoutWorktrees(sweepInput(root, { dryRun: true }));

    expect(report.worktrees).toEqual([expect.objectContaining({ path: worktree, action: "would_retire" })]);
    expect(existsSync(worktree)).toBe(true);
    expect(await branches(root)).toContain("scout/quill");
  });

  test("keeps a worktree with uncommitted or untracked changes", async () => {
    const root = await makeRepo();
    const modified = await agentWorktree(root, "modified");
    writeFileSync(join(modified, ".gitignore"), "changed\n");
    const untracked = await agentWorktree(root, "untracked");
    writeFileSync(join(untracked, "notes.txt"), "draft\n");

    const report = await sweepScoutWorktrees(sweepInput(root));

    expect(report.retired).toBe(0);
    for (const path of [modified, untracked]) {
      const verdict = report.worktrees.find((entry) => entry.path === path);
      expect(verdict?.action).toBe("kept");
      expect(verdict?.reasons.join(" ")).toContain("uncommitted changes");
      expect(existsSync(path)).toBe(true);
    }
    expect(await branches(root)).toEqual(expect.arrayContaining(["scout/modified", "scout/untracked"]));
  });

  test("keeps a worktree whose branch has commits that are not merged", async () => {
    const root = await makeRepo();
    const worktree = await agentWorktree(root, "quill");
    await commitIn(worktree, "unmerged.txt");

    const report = await sweepScoutWorktrees(sweepInput(root));

    expect(report.worktrees).toEqual([expect.objectContaining({ action: "kept", reasons: ["scout/quill has commits not in main"] })]);
    expect(existsSync(worktree)).toBe(true);
    expect(await branches(root)).toContain("scout/quill");
  });

  test("keeps a worktree that a live session runs in", async () => {
    const root = await makeRepo();
    const worktree = await agentWorktree(root, "quill");
    const snapshot = createRuntimeRegistrySnapshot({ endpoints: { a: endpoint({ cwd: worktree, state: "idle" }) } });

    const report = await sweepScoutWorktrees(sweepInput(root, { snapshot, alive: () => true }));

    expect(report.worktrees[0]?.action).toBe("kept");
    expect(report.worktrees[0]?.reasons).toContain("live session session-a (idle)");
    expect(existsSync(worktree)).toBe(true);
  });

  test("keeps a worktree with an unfinished flight, or a registered agent that can be woken there", async () => {
    const root = await makeRepo();
    const flying = await agentWorktree(root, "flying");
    const carded = await agentWorktree(root, "carded");
    const snapshot = createRuntimeRegistrySnapshot({
      endpoints: {
        a: endpoint({ cwd: flying }),
        b: endpoint({ id: "endpoint.card-b", agentId: "card-b", cwd: carded, metadata: {} }),
      },
      agents: { "card-b": { id: "card-b", kind: "agent", displayName: "card-b" } as never },
      flights: { f: { id: "f", invocationId: "i", requesterId: "op", targetAgentId: "session-a", state: "running" } },
    });

    const report = await sweepScoutWorktrees(sweepInput(root, { snapshot }));

    expect(report.worktrees.find((entry) => entry.path === flying)?.reasons).toContain("flight in progress for session-a");
    expect(report.worktrees.find((entry) => entry.path === carded)?.reasons).toContain("registered agent card-b runs here and can be woken");
    expect(existsSync(flying) && existsSync(carded)).toBe(true);
  });

  test("keeps a worktree that was active within the idle threshold", async () => {
    const root = await makeRepo();
    const worktree = await agentWorktree(root, "quill");

    const report = await sweepScoutWorktrees(sweepInput(root, { now: () => Date.now() }));

    expect(report.worktrees[0]?.action).toBe("kept");
    expect(report.worktrees[0]?.reasons.join(" ")).toContain("under the 24h idle threshold");
    expect(existsSync(worktree)).toBe(true);
  });

  test("stops a dead cardless session's endpoint before it removes the folder", async () => {
    const root = await makeRepo();
    const worktree = await agentWorktree(root, "quill");
    const snapshot = createRuntimeRegistrySnapshot({ endpoints: { a: endpoint({ cwd: worktree }) } });
    const released: string[] = [];

    const report = await sweepScoutWorktrees(sweepInput(root, {
      snapshot,
      releaseEndpoints: async (endpoints) => {
        expect(existsSync(worktree)).toBe(true);
        released.push(...endpoints.map((entry) => entry.id));
      },
    }));

    expect(released).toEqual(["endpoint.session-a"]);
    expect(report.worktrees[0]).toMatchObject({ action: "retired", retiredEndpointIds: ["endpoint.session-a"] });
    expect(existsSync(worktree)).toBe(false);
  });

  test("keeps the worktree when its endpoint cannot be stopped", async () => {
    const root = await makeRepo();
    const worktree = await agentWorktree(root, "quill");
    const snapshot = createRuntimeRegistrySnapshot({ endpoints: { a: endpoint({ cwd: worktree }) } });

    const report = await sweepScoutWorktrees(sweepInput(root, {
      snapshot,
      releaseEndpoints: async () => { throw new Error("journal unavailable"); },
    }));

    expect(report.worktrees[0]).toMatchObject({ action: "kept", reasons: ["could not stop the session endpoint first: journal unavailable"] });
    expect(existsSync(worktree)).toBe(true);
  });

  test("never touches a worktree under .scout-worktrees on a branch Scout did not make", async () => {
    const root = await makeRepo();
    const worktree = join(root, SCOUT_WORKSPACES_DIRNAME, "mine");
    await git(root, "worktree", "add", "-q", "-b", "feature/mine", worktree);

    const report = await sweepScoutWorktrees(sweepInput(root));

    expect(report.worktrees).toEqual([expect.objectContaining({ path: realpathSync(worktree), action: "skipped" })]);
    expect(existsSync(worktree)).toBe(true);
    expect(await branches(root)).toContain("feature/mine");
  });

  test("never touches a worktree outside .scout-worktrees, even on a scout/ branch", async () => {
    const root = await makeRepo();
    const outside = join(root, "elsewhere", "quill");
    await git(root, "worktree", "add", "-q", "-b", "scout/quill", outside);

    const report = await sweepScoutWorktrees(sweepInput(root));
    expect(report.worktrees).toEqual([]);
    expect((await listScoutWorktrees(root)).candidates).toEqual([]);
    expect(existsSync(outside)).toBe(true);
    expect(await branches(root)).toContain("scout/quill");
  });

  test("never touches a locked worktree", async () => {
    const root = await makeRepo();
    const worktree = await agentWorktree(root, "quill");
    await git(root, "worktree", "lock", worktree);

    const report = await sweepScoutWorktrees(sweepInput(root));

    expect(report.worktrees[0]?.reasons).toContain("locked with git worktree lock");
    expect(existsSync(worktree)).toBe(true);
  });
});

describe("scoutWorktreeProjectRoots", () => {
  test("derives project roots from local endpoints that run in a .scout-worktrees folder", async () => {
    const root = await makeRepo();
    const worktree = await agentWorktree(root, "quill");
    const snapshot = createRuntimeRegistrySnapshot({
      endpoints: {
        a: endpoint({ cwd: worktree }),
        b: endpoint({ id: "endpoint.remote", nodeId: "node-2", cwd: "/elsewhere/.scout-worktrees/x" }),
      },
    });
    expect(scoutWorktreeProjectRoots(snapshot, NODE)).toEqual([root]);
  });
});

describe("resolveWorktreeRetirementSettings", () => {
  test("defaults to on after 24 idle hours, with a one-hour floor", () => {
    expect(resolveWorktreeRetirementSettings({})).toEqual({ enabled: true, idleHours: 24 });
    expect(resolveWorktreeRetirementSettings({ worktreeRetire: "off", worktreeRetireIdleHours: 0.25 })).toEqual({ enabled: false, idleHours: 1 });
    expect(resolveWorktreeRetirementSettings({ worktreeRetireIdleHours: 72 })).toEqual({ enabled: true, idleHours: 72 });
  });
});
