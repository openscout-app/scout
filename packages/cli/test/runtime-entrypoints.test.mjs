import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { getOpenScoutRepoRoot, REFLECT_METADATA_BANNER } from "../../../scripts/bundle-core.mjs";
import { bundleRuntimeEntrypoints } from "../scripts/runtime-entrypoints.mjs";

test("installed runtime bundles start their sibling SQLite worker and preserve replayed records", () => {
  const repo = getOpenScoutRepoRoot();
  // Normal package dependencies remain resolvable, but neither the worker nor
  // its caller has a source-tree sibling to mask a missing packaged entrypoint.
  const root = mkdtempSync(join(repo, "packages/cli/node_modules/.runtime-bundle-test-"));
  const runtime = join(root, "dist/runtime");
  const runnerSource = join(root, "smoke.ts");
  const runner = join(runtime, "smoke.mjs");
  try {
    assert.equal(bundleRuntimeEntrypoints(repo, runtime), true);
    assert.equal(existsSync(join(runtime, "sqlite-projection-worker-entry.js")), true);
    assert.equal(existsSync(join(runtime, "sqlite-projection-worker-entry.ts")), false);
    cpSync(join(repo, "packages/runtime/drizzle"), join(root, "dist/drizzle"), { recursive: true });
    const sourceImport = (name) => JSON.stringify(join(repo, "packages/runtime/src", name));
    writeFileSync(runnerSource, `
import assert from "node:assert/strict";
import { join } from "node:path";
import { FileBackedBrokerJournal } from ${sourceImport("broker-journal.ts")};
import { WorkerSQLiteProjection } from ${sourceImport("sqlite-projection-worker.ts")};
import { resolveVercelBoardWorkerScript, VercelBoardWorkerSupervisor, VercelBoardWorkerTransport } from ${sourceImport("vercel-board/worker.ts")};
assert.equal(resolveVercelBoardWorkerScript(), join(import.meta.dir, "vercel-board-worker.mjs"));
const board = new VercelBoardWorkerSupervisor({
  target: {kind: "memory"}, profile: "scout", can: "work=read,post,react,label", credential: null,
});
try {
  const transport = new VercelBoardWorkerTransport(board);
  // Either answer proves the bundle started its sibling worker: only worker.mjs
  // sends the refusal, on a Node whose SQLite cannot bind numbered parameters.
  try { assert.ok((await transport.me()).principal); }
  catch (error) { assert.match(String(error?.message), /cannot bind numbered SQLite parameters/); }
} finally { board.stop(); }
const comparable = value => JSON.parse(JSON.stringify(value));
const control = process.argv[2];
const journalPath = join(control, "journal.jsonl");
const dbPath = join(control, "control.sqlite");
const journal = new FileBackedBrokerJournal(journalPath);
await journal.load();
const message = id => ({kind: "message.record", message: {
  id, actorId: "actor", conversationId: "conversation", originNodeId: "node",
  createdAt: 1700000000000, body: "body-" + id, visibility: "workspace",
  class: "agent", policy: "durable", metadata: { context: ["preserved"] },
}});
await journal.appendEntries([
  {kind: "node.upsert", node: {id: "node", name: "Node", meshId: "mesh", advertiseScope: "local", registeredAt: 1}},
  {kind: "actor.upsert", actor: {id: "actor", kind: "agent", displayName: "Actor", createdAt: 1700000000000, metadata: {}}},
  {kind: "conversation.upsert", conversation: {id: "conversation", kind: "channel", title: "Conversation", visibility: "workspace", shareMode: "local", authorityNodeId: "node", participantIds: ["actor"], createdAt: 1700000000000, metadata: {}}},
  message("startup"),
]);
let projection;
try {
  projection = new WorkerSQLiteProjection(dbPath, journalPath, journal);
  await projection.warm(); await projection.flush();
  assert.equal(projection.statusSnapshot().state, "ready");
  assert.deepEqual(comparable((await projection.readMessages(["startup"])).get("startup")), message("startup").message);
  await journal.appendEntries(message("suffix"));
  projection.notifyCommitted(); await projection.flush();
  assert.deepEqual(comparable((await projection.readMessages(["suffix"])).get("suffix")), message("suffix").message);
  projection.close();
  projection = new WorkerSQLiteProjection(dbPath, journalPath, journal);
  await projection.warm(); await projection.flush();
  const restored = await projection.readMessages(["startup", "suffix"]);
  assert.deepEqual([...restored.keys()].sort(), ["startup", "suffix"]);
  assert.deepEqual(comparable(restored.get("startup")), message("startup").message);
  assert.deepEqual(comparable(restored.get("suffix")), message("suffix").message);
  console.log(JSON.stringify({ready: true, startup: true, suffix: true, restart: true}));
} finally {
  projection?.close();
  await journal.close();
}
`);
    const build = spawnSync("bun", ["build", runnerSource, "--target=bun", "--format=esm", "--outfile", runner, REFLECT_METADATA_BANNER], {
      cwd: repo, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(build.status, 0, build.stderr || build.error?.message);
    rmSync(runnerSource);
    const run = spawnSync("bun", [runner, join(root, "control")], {
      cwd: root, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, OPENSCOUT_CONTROL_HOME: join(root, "control"), OPENSCOUT_SUPPORT_DIRECTORY: join(root, "support") },
    });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    assert.deepEqual(JSON.parse(run.stdout.trim().split("\n").at(-1)), { ready: true, startup: true, suffix: true, restart: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
