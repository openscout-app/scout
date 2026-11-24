import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execSystemFile } from "@openscout/runtime/setup";
import { createScoutCommandContext } from "../context.ts";
import { scoutCommandHelp } from "../command-help.ts";
import { shouldEnsureBrokerUptodateForCommand } from "../uptodate.ts";
import { loadScoutCommandHandler } from "./index.ts";
import { parseWorktreeCommandOptions } from "./worktree.ts";

test("parses worktree options and rejects invalid invocations", () => {
  expect(parseWorktreeCommandOptions(["list"], "/work")).toEqual({
    command: "list", projectRoot: "/work", dryRun: false, json: false,
  });
  expect(parseWorktreeCommandOptions(["gc", "--project", "repo", "--base=topic", "--dry-run", "--json"], "/work"))
    .toEqual({ command: "gc", projectRoot: "/work/repo", baseRef: "topic", dryRun: true, json: true });
  expect(parseWorktreeCommandOptions(["--help"], "/work")).toBeNull();
  expect(parseWorktreeCommandOptions(["list", "--base", "help"], "/work")).toMatchObject({ baseRef: "help" });
  expect(() => parseWorktreeCommandOptions(["list", "--dry-run"], "/work")).toThrow("only to scout worktree gc");
  expect(() => parseWorktreeCommandOptions(["gc", "--base", "--json"], "/work")).toThrow("--base requires");
  expect(() => parseWorktreeCommandOptions(["gc", "--force"], "/work")).toThrow("Unknown worktree option");
  expect(() => parseWorktreeCommandOptions(["gc", "--project="], "/work")).toThrow("--project requires");
  expect(() => parseWorktreeCommandOptions(["prune"], "/work")).toThrow("Use scout worktree list or scout worktree gc");
});

test("registers worktree help and never requests a broker restart", () => {
  const help = scoutCommandHelp(["worktree"], "test");
  expect(help).toMatchObject({ provider: "builtin", subcommands: { list: {}, gc: {} } });
  expect(scoutCommandHelp(["worktree", "gc"], "test")).toMatchObject({
    flags: expect.arrayContaining([{ name: "--dry-run", takesValue: false }, { name: "--base", takesValue: true }]),
  });
  expect(shouldEnsureBrokerUptodateForCommand("worktree", ["gc"])).toBe(false);
});

test("reports local live sessions in JSON and previews offline without mutating worktrees", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "scout-cli-worktree-")));
  const workspaceDir = join(root, ".scout-worktrees");
  const active = join(workspaceDir, "live");
  const candidate = join(workspaceDir, "candidate");
  const requests = new Set<string>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.add(path);
      if (path === "/v1/node") return Response.json({ id: "local-test-node" });
      if (path === "/v1/endpoints") return Response.json({ endpoints: [
        { nodeId: "local-test-node", state: "working", cwd: join(active, "src") },
        { nodeId: "local-test-node", state: "stopped", cwd: candidate },
        { nodeId: "remote-test-node", state: "working", cwd: candidate },
      ] });
      return new Response(null, { status: 404 });
    },
  });
  try {
    const git = async (...args: string[]) => (await execSystemFile("git", args, { cwd: root, timeoutMs: 10_000 })).stdout;
    await git("init", "-q", "-b", "main");
    await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "Initial", "--allow-empty");
    await mkdir(workspaceDir);
    await git("worktree", "add", "-q", "-b", "scout/live", active);
    await git("worktree", "add", "-q", "-b", "scout/candidate", candidate);
    await mkdir(join(active, "src"));

    const stdout: string[] = [];
    const stderr: string[] = [];
    const brokerUrl = server.url.href;
    const context = createScoutCommandContext({
      cwd: root, env: { OPENSCOUT_BROKER_URL: brokerUrl },
      stdout: line => stdout.push(line), stderr: line => stderr.push(line),
    });
    const run = await loadScoutCommandHandler("worktree");
    await run(context, ["gc", "--dry-run", "--json"]);
    const report = JSON.parse(stdout.pop()!);
    expect(report).toMatchObject({ dryRun: true, projectRoot: root });
    expect(report.worktrees).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: active, action: "skipped", skipReason: "active" }),
      expect.objectContaining({ path: candidate, action: "would_remove" }),
    ]));
    expect(new Set(requests)).toEqual(new Set(["/v1/node", "/v1/endpoints"]));
    expect(stderr).toEqual([]);

    await server.stop(true);
    await run({ ...context, cwd: active }, ["gc", "--project", root, "--dry-run"]);
    expect(stdout.pop()).toContain(`would remove: ${candidate}`);
    expect(stderr[0]).toContain("could not check active sessions");
    const registrations = await git("worktree", "list", "--porcelain");
    expect(registrations).toContain(active);
    expect(registrations).toContain(candidate);
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
