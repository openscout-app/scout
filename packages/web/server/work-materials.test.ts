import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AgentObservePayload, SessionRefObservePayload } from "./core/observe/service.ts";
import type { WebAgent, WebWorkDetail } from "./db-queries.ts";

const tempRoots = new Set<string>();
let agentObservePayload: AgentObservePayload | null = null;
let sessionObservePayload: SessionRefObservePayload | null = null;
let requestedSessionRefs: string[] = [];
const originalHome = process.env.HOME;
const originalProbesSocket = process.env.OPENSCOUT_PROBES_SOCKET;

const agents: WebAgent[] = [
  {
    id: "agent-1",
    definitionId: "agent",
    name: "Agent One",
    handle: null,
    agentClass: "general",
    harness: "codex",
    state: "available",
    projectRoot: null,
    cwd: null,
    updatedAt: 1,
    transport: null,
    selector: null,
    defaultSelector: null,
    nodeQualifier: null,
    workspaceQualifier: null,
    wakePolicy: null,
    capabilities: [],
    project: null,
    branch: null,
    role: null,
    model: null,
    harnessSessionId: null,
    harnessLogPath: null,
    conversationId: "dm.operator.agent-1",
    authorityNodeId: "node-1",
    authorityNodeName: "node-1",
    homeNodeId: "node-1",
    homeNodeName: "node-1",
    ownerId: null,
    ownerName: null,
    ownerHandle: null,
    staleLocalRegistration: false,
    retiredFromFleet: false,
    replacedByAgentId: null,
  },
];

mock.module("./db-queries.ts", () => ({
  queryAgents: () => agents,
  queryRuns: () => [],
  querySessionById: () => null,
}));

mock.module("./core/observe/service.ts", () => ({
  loadAgentObservePayload: async () => agentObservePayload,
  loadSessionRefObservePayload: async (id: string) => {
    requestedSessionRefs.push(id);
    return id === "scout-session-1" ? sessionObservePayload : null;
  },
}));

const { buildWorkMaterialsInventory, readWorkMaterialContent } = await import("./work-materials.ts");

mock.restore();

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  const home = makeTempRoot("openscout-work-materials-home-");
  process.env.HOME = home;
  // Git probes must fall back locally, not contact an operator-owned scoutd.
  process.env.OPENSCOUT_PROBES_SOCKET = join(home, "absent-probes.sock");
  agentObservePayload = null;
  sessionObservePayload = null;
  requestedSessionRefs = [];
  agents[0]!.cwd = null;
  agents[0]!.projectRoot = null;
});

afterEach(() => {
  if (originalProbesSocket === undefined) delete process.env.OPENSCOUT_PROBES_SOCKET;
  else process.env.OPENSCOUT_PROBES_SOCKET = originalProbesSocket;
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function makeTempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempRoots.add(root);
  return root;
}

function runGit(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function initRepo(root: string): void {
  runGit(root, ["init"]);
  runGit(root, ["config", "user.email", "test@example.com"]);
  runGit(root, ["config", "user.name", "Test User"]);
  runGit(root, ["checkout", "-B", "main"]);
}

function commitAll(root: string, message: string): void {
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", message]);
}

function makeWork(): WebWorkDetail {
  return {
    id: "work-1",
    title: "Preview work",
    summary: null,
    ownerId: "agent-1",
    ownerName: "Agent One",
    nextMoveOwnerId: null,
    nextMoveOwnerName: null,
    conversationId: null,
    createdAt: 1,
    updatedAt: 1,
    parentId: null,
    parentTitle: null,
    state: "working",
    acceptanceState: "none",
    priority: null,
    currentPhase: "Working",
    attention: "silent",
    activeChildWorkCount: 0,
    activeFlightCount: 0,
    lastMeaningfulAt: 1,
    lastMeaningfulSummary: null,
    childWork: [],
    activeFlights: [],
    timeline: [],
  };
}

function useObservedFile(path: string, cwd: string | null): void {
  agentObservePayload = {
    agentId: "agent-1",
    source: "history",
    fidelity: "timestamped",
    historyPath: null,
    sessionId: "session-1",
    updatedAt: 1,
    data: {
      events: [],
      files: [
        {
          path,
          state: "read",
          touches: 1,
          lastT: 1,
        },
      ],
      metadata: {
        session: {
          adapterType: "codex",
          externalSessionId: "session-1",
          ...(cwd ? { cwd } : {}),
        },
      },
    },
  };
}

describe("readWorkMaterialContent", () => {
  test("does not serve rootless absolute trace-only paths", async () => {
    const root = makeTempRoot("openscout-work-materials-secret-");
    const secretPath = join(root, "secret.txt");
    writeFileSync(secretPath, "do not leak\n", "utf8");
    useObservedFile(secretPath, null);

    const result = await readWorkMaterialContent(makeWork(), `trace::${secretPath}`);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("rootless absolute trace path was unexpectedly readable");
    }
    expect(result.status).toBe(404);
    expect(result.error).toBe("material does not have a trusted local root");
  });

  test("serves git-backed absolute trace paths through the detected worktree root", async () => {
    const repoRoot = makeTempRoot("openscout-work-materials-repo-");
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
    const filePath = join(repoRoot, "preview.txt");
    writeFileSync(filePath, "rooted preview\n", "utf8");
    useObservedFile(filePath, repoRoot);

    const result = await readWorkMaterialContent(makeWork(), `${repoRoot}::preview.txt`);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`git-backed material was not readable: ${result.error}`);
    }
    expect(result.content.path).toBe("preview.txt");
    expect(result.content.uri).toBe(realpathSync(filePath));
    expect(result.content.content).toBe("rooted preview\n");
  });

  test("does not follow rooted material symlinks outside the trusted root", async () => {
    const repoRoot = makeTempRoot("openscout-work-materials-symlink-repo-");
    const outsideRoot = makeTempRoot("openscout-work-materials-symlink-outside-");
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
    const outsidePath = join(outsideRoot, "secret.txt");
    const linkPath = join(repoRoot, "linked-secret.txt");
    writeFileSync(outsidePath, "still do not leak\n", "utf8");
    symlinkSync(outsidePath, linkPath);
    useObservedFile(linkPath, repoRoot);

    const result = await readWorkMaterialContent(makeWork(), `${repoRoot}::linked-secret.txt`);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("symlink escape was unexpectedly readable");
    }
    expect(result.status).toBe(403);
    expect(result.error).toBe("material path is outside its trusted root");
  });
});

describe("buildWorkMaterialsInventory", () => {
  test("finds materials through a cardless invocation's exact execution session", async () => {
    const repoRoot = makeTempRoot("openscout-work-materials-cardless-");
    initRepo(repoRoot);
    writeFileSync(join(repoRoot, "README.md"), "base\n");
    commitAll(repoRoot, "base");
    writeFileSync(join(repoRoot, "implementation.ts"), "export const ready = true;\n");
    // More unrelated shared-checkout changes than the inventory limit must
    // not crowd the current session's actual file out of the result.
    for (let index = 0; index < 90; index += 1) {
      writeFileSync(join(repoRoot, `unrelated-${index}.test.ts`), "// other work\n");
    }
    useObservedFile("implementation.ts", repoRoot);
    sessionObservePayload = {
      ...agentObservePayload!, kind: "broker", refId: "scout-session-1",
      agentId: "cardless-agent", sessionId: "native-session-1",
    };
    agentObservePayload = null;
    const work = makeWork();
    work.ownerId = "cardless-agent";
    work.primaryInvocation = {
      resolvedSessionId: "scout-session-1", targetSessionId: "old-session",
      targetAgentId: "cardless-agent", targetAgentName: "Worker",
      resolvedHarness: "claude", requestedHarness: "claude", conversationId: null,
    } as NonNullable<WebWorkDetail["primaryInvocation"]>;

    const inventory = await buildWorkMaterialsInventory(work);
    expect(requestedSessionRefs).toContain("scout-session-1");
    expect(requestedSessionRefs).not.toContain("old-session");
    expect(inventory.materials.find((file) => file.path === "implementation.ts")?.evidence).toContain("trace-read");
    expect(inventory.materials.filter((file) => file.path === "implementation.ts")).toHaveLength(1);
    expect(inventory.materials).toHaveLength(80);
    expect(inventory.sessions.find((session) => session.id === "native-session-1")?.cwd).toBe(repoRoot);
    expect(inventory.limitations).not.toContain("No related git repository was detected; inventory is trace-derived.");
  });

  test("uses the requested execution session when resolution is not yet recorded", async () => {
    const work = makeWork();
    work.primaryInvocation = {
      resolvedSessionId: null, targetSessionId: "scout-session-1",
      targetAgentId: "cardless-agent", targetAgentName: "Worker",
      resolvedHarness: null, requestedHarness: "claude", conversationId: null,
    } as NonNullable<WebWorkDetail["primaryInvocation"]>;
    await buildWorkMaterialsInventory(work);
    expect(requestedSessionRefs).toContain("scout-session-1");
  });

  test("reports branch contribution stats for committed files", async () => {
    const repoRoot = makeTempRoot("openscout-work-materials-branch-");
    initRepo(repoRoot);
    writeFileSync(join(repoRoot, "README.md"), "base\n", "utf8");
    commitAll(repoRoot, "base");
    runGit(repoRoot, ["checkout", "-b", "feature/materials"]);
    writeFileSync(join(repoRoot, "committed.ts"), "one\ntwo\n", "utf8");
    commitAll(repoRoot, "add committed material");
    writeFileSync(join(repoRoot, "committed.ts"), "one\ntwo\nthree\n", "utf8");
    agents[0]!.cwd = repoRoot;

    const inventory = await buildWorkMaterialsInventory(makeWork());
    const material = inventory.materials.find((entry) => entry.path === "committed.ts");

    expect(material).toBeDefined();
    expect(material?.diffStat).toEqual({
      branch: { additions: 2, deletions: 0 },
      inflight: { additions: 1, deletions: 0 },
    });
    expect(material?.evidence).toContain("git-diff");
  });

  test("keeps branch stats null on trunk and reports inflight edits", async () => {
    const repoRoot = makeTempRoot("openscout-work-materials-main-");
    initRepo(repoRoot);
    writeFileSync(join(repoRoot, "README.md"), "base\n", "utf8");
    commitAll(repoRoot, "base");
    writeFileSync(join(repoRoot, "README.md"), "base\nnext\n", "utf8");
    agents[0]!.cwd = repoRoot;

    const inventory = await buildWorkMaterialsInventory(makeWork());
    const material = inventory.materials.find((entry) => entry.path === "README.md");

    expect(material).toBeDefined();
    expect(material?.diffStat).toEqual({
      branch: null,
      inflight: { additions: 1, deletions: 0 },
    });
  });

  test("excludes default generated and dependency paths at indexing time", async () => {
    const repoRoot = makeTempRoot("openscout-work-materials-exclude-");
    initRepo(repoRoot);
    writeFileSync(join(repoRoot, "package.json"), "{}\n", "utf8");
    commitAll(repoRoot, "base");
    mkdirSync(join(repoRoot, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(repoRoot, "node_modules", "pkg", "README.md"), "dependency docs\n", "utf8");
    writeFileSync(join(repoRoot, "package.json"), "{\"changed\":true}\n", "utf8");
    agents[0]!.cwd = repoRoot;

    const inventory = await buildWorkMaterialsInventory(makeWork());

    expect(inventory.materials.some((entry) => entry.path.includes("node_modules/"))).toBe(false);
    expect(inventory.materials.find((entry) => entry.path === "package.json")?.kind).toBe("config");
  });

  test("does not classify every markdown file as documentation by default", async () => {
    const repoRoot = makeTempRoot("openscout-work-materials-markdown-default-");
    initRepo(repoRoot);
    writeFileSync(join(repoRoot, "package.json"), "{}\n", "utf8");
    commitAll(repoRoot, "base");
    writeFileSync(join(repoRoot, "notes.md"), "scratch notes\n", "utf8");
    agents[0]!.cwd = repoRoot;

    const inventory = await buildWorkMaterialsInventory(makeWork());

    expect(inventory.materials.find((entry) => entry.path === "notes.md")?.kind).toBe("other");
  });

  test("uses project heuristics to add local conventions without shipping them as defaults", async () => {
    const repoRoot = makeTempRoot("openscout-work-materials-project-heuristics-");
    initRepo(repoRoot);
    writeFileSync(join(repoRoot, "README.md"), "base\n", "utf8");
    commitAll(repoRoot, "base");
    mkdirSync(join(repoRoot, ".openscout"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".openscout", "heuristics.json"),
      JSON.stringify({ classify: { spec: { include: ["sco-*.md"] }, doc: { exclude: ["README.md"] } } }),
      "utf8",
    );
    writeFileSync(join(repoRoot, "sco-123.md"), "local convention\n", "utf8");
    writeFileSync(join(repoRoot, "README.md"), "base\nchanged\n", "utf8");
    agents[0]!.cwd = repoRoot;

    const inventory = await buildWorkMaterialsInventory(makeWork());

    expect(inventory.materials.find((entry) => entry.path === "sco-123.md")?.kind).toBe("spec");
    expect(inventory.materials.find((entry) => entry.path === "README.md")?.kind).toBe("other");
  });
});
