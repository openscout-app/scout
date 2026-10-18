import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createCliFixture, isolatedEnvironment, temporaryDirectory } from "./helpers/cli-fixture.mjs";

const cli = join(createCliFixture(), "bin/scout.mjs");
const root = join(temporaryDirectory("scout-route-project-"), "sparse-routing-fixture");
mkdirSync(root);
writeFileSync(join(root, "README.md"), "Quartz instruments and musical notation.\n");
const requests = [];
const node = { id: "mini", name: "mini", hostName: "mini.local" };
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  requests.push([request.method, url.pathname]);
  const value = url.pathname === "/v1/node" ? node
    : url.pathname === "/v1/mesh/nodes" ? { mini: node }
    : url.pathname === "/v1/mesh/node-state" ? {
      kind: "mesh-node-state", version: 1, nodeId: node.id, name: node.name, observedAt: Date.now(),
      workload: { total: 2, truncated: false },
      roster: [
        { id: "a", title: "Builder", projectRoot: root, state: "working", lastSeenAt: Date.now() },
        { id: "unrelated", title: "Other", projectRoot: "/other", state: "working", lastSeenAt: Date.now() },
      ],
      sessions: { total: 0, truncated: false, items: [] },
      work: { total: 0, truncated: false, items: [] },
    }
    : url.pathname === "/v1/aliases" ? { bindings: [] }
    : url.pathname === "/v1/snapshot" ? {
      nodes: { mini: node }, agents: { a: { id: "a", homeNodeId: "mini", displayName: "Builder", metadata: { projectRoot: root } } },
      endpoints: {}, messages: {}, invocations: {},
    } : null;
  response.writeHead(value ? 200 : 404, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value ?? { error: "unsupported" }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
test.after(() => { server.closeAllConnections(); server.close(); });
const env = isolatedEnvironment({ OPENSCOUT_BROKER_URL: `http://127.0.0.1:${server.address().port}` });
// `where` is gated on the local search index, which is off by default.
mkdirSync(env.OPENSCOUT_SUPPORT_DIRECTORY, { recursive: true });
writeFileSync(join(env.OPENSCOUT_SUPPORT_DIRECTORY, "settings.json"), JSON.stringify({ knowledgeIndexEnabled: true }));
async function runCommand(command, ...args) {
  const child = spawn("bun", [cli, command, ...args, "--json"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const [code] = await once(child, "close"); clearTimeout(timeout);
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout);
}

const run = (...args) => runCommand("where", ...args);

test("packaged where stays offline until explicit index, captures feedback, never dispatches/restarts", async () => {
  assert.equal((await run("status")).targets, 0);
  assert.equal((await run("unknown topic")).outcome, "none");
  assert.deepEqual(requests, []);
  assert.equal((await run("index")).targets, 2);
  const result = await run("sparse-routing-fixture", "--explain");
  assert.equal(result.outcome, "resolved"); assert.equal(result.candidates[0].target.projectRoot, root);
  assert.equal((await run("on mini")).outcome, "none");
  assert.equal((await runCommand("route", "sparse-routing-fixture")).outcome, "resolved");
  assert.ok(result.candidates[0].score > 0);
  assert.ok(result.candidates.length <= 3);
  assert.deepEqual(await run("feedback", "sparse-routing-fixture", "--outcome", "used", "--target", result.candidates[0].target.id), { recorded: true });
  await run("index", "--full");
  const check = await runCommand("check", "sparse-routing-fixture", "on", "mini", "--since", "2h");
  assert.equal(check.routing.outcome, "resolved");
  assert.equal(check.activity.length, 1);
  assert.deepEqual(check.activity[0].live.machines[0].entries.map(row => row.id), ["a"]);
  const unmatched = await runCommand("check", "work on nonexistent");
  assert.equal(unmatched.routing.topic, "work on nonexistent");
  assert.deepEqual(unmatched.activity, []);
  assert.ok(requests.every(([method, path]) => method === "GET" && ["/v1/node", "/v1/snapshot", "/v1/aliases", "/v1/mesh/nodes", "/v1/mesh/node-state"].includes(path)));
});
