import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VercelBoardDispatchConfig } from "@openscout/protocol";
import { LEAST_BUSY_POLICY, installPolicyExtension } from "../test-support/vercel-board-policy-extension.js";
import { vercelBoardExternalProblems, vercelBoardExternalSteps } from "./external-policy.js";
import {
  VercelBoardDispatchOverlay, vercelBoardDecide, vercelBoardDispatchProblems, vercelBoardDispatchRegistry,
  type VercelBoardDispatchCandidate, type VercelBoardDispatchSettings,
} from "./policy.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function home(): string {
  const root = mkdtempSync(join(tmpdir(), "scout-board-policy-"));
  roots.push(root);
  return root;
}

const connection = { id: "c1", principal: "local:user:operator", profile: "scout", ownerAllowlist: ["local:user:operator"], roles: ["scout", "builder", "reviewer"] };
const candidate = (): VercelBoardDispatchCandidate => ({
  connection, channel: "work",
  task: { id: "t1", labels: { area: "docs" }, by: { principal: "local:user:operator", profile: "scout" }, origin: "scout", owner: "local:user:operator", for: null, needs: [], epoch: 0 },
  agents: [
    { agentId: "agent-a", roles: ["builder"], capabilities: [] },
    { agentId: "agent-b", roles: ["builder"], capabilities: [] },
  ],
  history: { attempts: 0, lastEpoch: null, lastGotClaim: false, active: false },
});
const GUARDS = ["guard:not-synced", "guard:operator-authored", "guard:first-claim"];
const settings = (steps: string[]): VercelBoardDispatchSettings => ({ policy: "balanced", steps, trust: {}, labels: [], capabilities: {} });

/** A registry for one dispatch block, as the service builds it per connection. */
function registry(dispatch: VercelBoardDispatchConfig, env: NodeJS.ProcessEnv) {
  return new VercelBoardDispatchOverlay(vercelBoardDispatchRegistry, () => vercelBoardExternalSteps(dispatch, { env }));
}
const external = (digest: string, timeoutMs?: number): VercelBoardDispatchConfig => ({
  external: { "least-busy": { extension: "board-policy", digest, ...(timeoutMs ? { timeoutMs } : {}) } },
  policies: { balanced: [...GUARDS, "external:least-busy"] },
});

test("the example least-busy policy claims for the agent with the fewest recent claims", async () => {
  const ext = installPolicyExtension(home(), "board-policy", LEAST_BUSY_POLICY, { "counts.json": JSON.stringify({ "agent-a": 3, "agent-b": 1 }) });
  const dispatch = external(ext.digest());
  expect(vercelBoardDispatchProblems(dispatch, ["work"], registry(dispatch, ext.env))).toEqual([]);
  expect(vercelBoardExternalProblems(dispatch, { env: ext.env })).toEqual([]);
  const decision = await vercelBoardDecide(candidate(), settings([...GUARDS, "external:least-busy"]), registry(dispatch, ext.env));
  expect(decision).toMatchObject({ outcome: "claim", agentId: "agent-b", profile: "scout", step: "external:least-busy" });
  expect(decision.trail.at(-1)).toEqual({ step: "external:least-busy", result: "claim", note: "fewest recent claims: 1" });
});

test("the guards run before an external step: a synced task never reaches it", async () => {
  const ext = installPolicyExtension(home(), "board-policy", `#!/bin/sh\ntouch "$(dirname "$0")/ran"\necho '{"result":"claim","agentId":"agent-a"}'\n`);
  const dispatch = external(ext.digest());
  const synced = { ...candidate(), task: { ...candidate().task, origin: "slack" } };
  expect(await vercelBoardDecide(synced, settings([...GUARDS, "external:least-busy"]), registry(dispatch, ext.env))).toMatchObject({ outcome: "skip", step: "guard:not-synced" });
  expect(() => readFileSync(join(ext.dir, "bin/ran"))).toThrow();
});

test("the extension reads the request without task text, in an environment without Scout's", async () => {
  const ext = installPolicyExtension(home(), "board-policy", `#!/bin/sh\ncat > "$(dirname "$0")/request.json"\nenv > "$(dirname "$0")/env.txt"\necho "$1" > "$(dirname "$0")/argv.txt"\necho '{"result":"skip","reason":"recorded"}'\n`);
  const dispatch = external(ext.digest());
  const env = { ...ext.env, VERCEL_BOARD_TEST_TOKEN: "never-pass-this", OPENSCOUT_BROKER_URL: "http://127.0.0.1:1" };
  const decision = await vercelBoardDecide(candidate(), settings([...GUARDS, "external:least-busy"]), registry(dispatch, env));
  expect(decision).toMatchObject({ outcome: "skip", reason: "recorded" });
  const request = JSON.parse(readFileSync(join(ext.dir, "bin/request.json"), "utf8"));
  expect(request).toMatchObject({ protocol: 1, step: "external:least-busy", candidate: { channel: "work", task: { id: "t1", labels: { area: "docs" } } }, settings: { policy: "balanced" } });
  expect(request.candidate.connection).toEqual({ id: "c1", principal: "local:user:operator", profile: "scout", roles: ["scout", "builder", "reviewer"] });
  expect(JSON.stringify(request)).not.toContain("text");
  const seen = readFileSync(join(ext.dir, "bin/env.txt"), "utf8");
  expect(seen).toContain("SCOUT_EXTENSION_HOOK=vercel-board-dispatch");
  expect(seen).not.toContain("never-pass-this");
  expect(seen).not.toContain("OPENSCOUT_");
  expect(readFileSync(join(ext.dir, "bin/argv.txt"), "utf8").trim()).toBe("vercel-board-dispatch");
});

test("a timeout, a failed exit, a bad answer, too much output or a claim for a busy agent skips the task", async () => {
  const cases: [string, string, RegExp][] = [
    ["slow", `#!/bin/sh\nsleep 5\necho '{"result":"claim","agentId":"agent-a"}'\n`, /timed out after 300 ms/],
    ["fails", `#!/bin/sh\necho '{"result":"claim","agentId":"agent-a"}'\nexit 3\n`, /exited 3/],
    ["prose", `#!/bin/sh\necho 'claim agent-a please'\n`, /other than JSON/],
    ["vague", `#!/bin/sh\necho '{"result":"maybe"}'\n`, /pass, skip or claim/],
    ["unsure", `#!/bin/sh\necho '{"result":"skip"}'\n`, /needs a reason/],
    ["loud", `#!/bin/sh\nhead -c 70000 /dev/zero | tr '\\\\0' a\n`, /more than 64 KiB/],
    ["stranger", `#!/bin/sh\necho '{"result":"claim","agentId":"agent-z"}'\n`, /not a free candidate/],
    ["outsider", `#!/bin/sh\necho '{"result":"claim","agentId":"agent-a","profile":"admin"}'\n`, /not one of the connection's roles/],
  ];
  for (const [name, script, reason] of cases) {
    const ext = installPolicyExtension(home(), "board-policy", script);
    const dispatch = external(ext.digest(), name === "slow" ? 300 : 10_000);
    const started = Date.now();
    const decision = await vercelBoardDecide(candidate(), settings([...GUARDS, "external:least-busy"]), registry(dispatch, ext.env));
    expect({ name, outcome: decision.outcome, step: decision.step }).toEqual({ name, outcome: "skip", step: "external:least-busy" });
    expect(decision.reason).toMatch(reason);
    if (name === "slow") expect(Date.now() - started).toBeLessThan(3_000);
  }
});

test("an unpinned, missing or changed extension is refused at save and skips at run", async () => {
  const root = home();
  const ext = installPolicyExtension(root, "board-policy", LEAST_BUSY_POLICY);
  const pinned = ext.digest();
  const wrong = external("0".repeat(64));
  expect(vercelBoardExternalProblems(wrong, { env: ext.env })).toEqual([`dispatch.external.least-busy: extension board-policy has digest ${pinned}, not the pinned ${"0".repeat(64)}`]);
  expect(vercelBoardExternalProblems({ external: { x: { extension: "not-installed", digest: pinned } } }, { env: ext.env })).toEqual(["dispatch.external.x: extension not-installed is not installed"]);
  // A chain that names an external step the block does not define is refused like any unknown step.
  const undefinedStep: VercelBoardDispatchConfig = { policies: { balanced: [...GUARDS, "external:other"] } };
  expect(vercelBoardDispatchProblems(undefinedStep, ["work"], registry(undefinedStep, ext.env))).toEqual(["dispatch.policies.balanced: no step named external:other"]);

  const dispatch = external(pinned);
  writeFileSync(join(ext.dir, "bin/policy"), `${LEAST_BUSY_POLICY}// changed\n`, { mode: 0o700 });
  const decision = await vercelBoardDecide(candidate(), settings([...GUARDS, "external:least-busy"]), registry(dispatch, ext.env));
  expect(decision).toMatchObject({ outcome: "skip", step: "external:least-busy" });
  expect(decision.reason).toContain(`not the pinned ${pinned}`);
});
