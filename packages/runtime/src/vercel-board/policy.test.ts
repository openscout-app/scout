import { expect, test } from "bun:test";
import {
  VercelBoardDispatchRegistry, vercelBoardDecide, vercelBoardDispatchProblems, vercelBoardDispatchSettings, vercelBoardMergeTrust,
  type VercelBoardDispatchCandidate, type VercelBoardDispatchSettings,
} from "./policy.js";

const connection = { id: "c1", principal: "local:user:operator", profile: "scout", ownerAllowlist: ["local:user:operator", "local:user:teammate"], roles: ["scout", "builder", "reviewer"] };

function candidate(task: Partial<VercelBoardDispatchCandidate["task"]> = {}, extra: Partial<VercelBoardDispatchCandidate> = {}): VercelBoardDispatchCandidate {
  return {
    connection, channel: "work",
    task: { id: "t1", labels: {}, by: { principal: "local:user:operator", profile: "scout" }, origin: "scout", owner: "local:user:operator", for: null, needs: [], epoch: 0, ...task },
    agents: [
      { agentId: "agent-a", roles: ["builder"], capabilities: [], roleRank: { builder: 0 } },
      { agentId: "agent-b", roles: ["reviewer"], capabilities: [], roleRank: { reviewer: 1 } },
    ],
    history: { attempts: 0, lastEpoch: null, lastGotClaim: false, active: false },
    ...extra,
  };
}

const settings = (steps: string[], extra: Partial<VercelBoardDispatchSettings> = {}): VercelBoardDispatchSettings => ({ policy: "test", steps, trust: {}, labels: [], capabilities: {}, ...extra });

test("a chain runs its steps in order and records each in the trail", async () => {
  const decision = await vercelBoardDecide(candidate({ for: "local:user:operator+reviewer" }), settings(["guard:not-synced", "guard:operator-authored", "guard:first-claim", "resolve:for", "match:role", "pick:first"]));
  expect(decision).toMatchObject({ outcome: "claim", agentId: "agent-b", profile: "reviewer", step: "pick:first" });
  expect(decision.trail.map(entry => `${entry.step}:${entry.result}`)).toEqual([
    "guard:not-synced:pass", "guard:operator-authored:pass", "guard:first-claim:pass", "resolve:for:pass", "match:role:pass", "pick:first:claim",
  ]);
});

test("the author guard widens to the allowlist or anyone only when trust says so", async () => {
  const teammate = candidate({ by: { principal: "local:user:teammate", profile: null }, owner: "local:user:teammate", origin: "board" });
  const chain = ["guard:operator-authored", "pick:first"];
  expect(await vercelBoardDecide(teammate, settings(chain))).toMatchObject({ outcome: "skip", step: "guard:operator-authored" });
  expect(await vercelBoardDecide(teammate, settings(chain, { trust: { authors: "allowlist" } }))).toMatchObject({ outcome: "claim" });
  const stranger = candidate({ by: { principal: "local:user:stranger", profile: null }, owner: "local:user:stranger", origin: "board" });
  expect(await vercelBoardDecide(stranger, settings(chain, { trust: { authors: "allowlist" } }))).toMatchObject({ outcome: "skip" });
  expect(await vercelBoardDecide(stranger, settings(chain, { trust: { authors: "any" } }))).toMatchObject({ outcome: "claim" });
});

test("anyEpoch admits a task another worker let go, never one Scout itself let go", async () => {
  const chain = ["guard:first-claim", "pick:first"];
  const trust = { anyEpoch: true };
  expect(await vercelBoardDecide(candidate({ epoch: 2 }), settings(chain))).toMatchObject({ outcome: "skip" });
  expect(await vercelBoardDecide(candidate({ epoch: 2 }), settings(chain, { trust }))).toMatchObject({ outcome: "claim" });
  const ours = { history: { attempts: 1, lastEpoch: 2, lastGotClaim: true, active: false } };
  expect(await vercelBoardDecide(candidate({ epoch: 2 }, ours), settings(chain, { trust }))).toMatchObject({ outcome: "skip" });
  expect(await vercelBoardDecide(candidate({ epoch: 3 }, ours), settings(chain, { trust }))).toMatchObject({ outcome: "claim" });
  const refused = { history: { attempts: 1, lastEpoch: null, lastGotClaim: false, active: false } };
  expect(await vercelBoardDecide(candidate({ epoch: 3 }, refused), settings(chain, { trust }))).toMatchObject({ outcome: "skip" });
});

test("label trust merges with the channel's, taking the widest value of each field", () => {
  expect(vercelBoardMergeTrust({ authors: "allowlist" }, { authors: "operator", synced: ["slack"] }, { anyEpoch: true, synced: ["github"] }))
    .toEqual({ authors: "allowlist", synced: ["slack", "github"], anyEpoch: true });
  const config = { selfServe: [], dispatch: { channels: { work: { policy: "trusted-channel", labelTrust: [{ label: "src=slack", trust: { synced: ["slack"] } }] } } } };
  const plain = vercelBoardDispatchSettings(config, "work", {});
  const labelled = vercelBoardDispatchSettings(config, "work", { src: "slack" });
  expect("trust" in plain && plain.trust).toEqual({});
  expect("trust" in labelled && labelled.trust).toEqual({ synced: ["slack"] });
});

test("a step registered by name is a policy like the built-ins: here, one that prefers the agent with fewer recent claims", async () => {
  const registry = new VercelBoardDispatchRegistry();
  const recent: Record<string, number> = { "agent-a": 3, "agent-b": 0 };
  registry.register("pick:least-busy", {
    kind: "pick", summary: "Claim for the free agent with the fewest recent claims.",
    run: (_candidate, state) => {
      const agent = [...state.agents].sort((a, b) => (recent[a.agentId] ?? 0) - (recent[b.agentId] ?? 0))[0];
      return agent ? { result: "claim", agentId: agent.agentId } : { result: "skip", reason: "no free agent" };
    },
  });
  registry.registerPolicy("balanced", ["guard:not-synced", "guard:operator-authored", "guard:first-claim", "resolve:for", "match:role-or-any", "pick:least-busy"]);
  expect(vercelBoardDispatchProblems({ channels: { work: { policy: "balanced" } } }, ["work"], registry)).toEqual([]);
  const resolved = vercelBoardDispatchSettings({ dispatch: { channels: { work: { policy: "balanced" } } } }, "work", {}, registry);
  if ("error" in resolved) throw new Error(resolved.error);
  expect(await vercelBoardDecide(candidate(), resolved, registry)).toMatchObject({ outcome: "claim", agentId: "agent-b", profile: "scout", policy: "balanced" });
  // The built-in registry does not know it: a typo or a missing step fails before it is saved.
  expect(vercelBoardDispatchProblems({ channels: { work: { policy: "balanced" } } }, ["work"])).toEqual(["dispatch.channels.work.policy: no policy named balanced"]);
});

test("a step that throws, answers nonsense, or claims for an agent that is not free skips the task", async () => {
  const registry = new VercelBoardDispatchRegistry();
  registry.register("bad:throws", { kind: "external", summary: "", run: () => { throw new Error("boom"); } });
  registry.register("bad:nonsense", { kind: "external", summary: "", run: () => ({ result: "yes" }) as never });
  registry.register("bad:stranger", { kind: "external", summary: "", run: () => ({ result: "claim", agentId: "agent-z" }) });
  registry.register("bad:profile", { kind: "external", summary: "", run: () => ({ result: "claim", agentId: "agent-a", profile: "admin" }) });
  registry.register("bad:widen", { kind: "external", summary: "", run: () => ({ result: "pass", agents: [{ agentId: "agent-z", roles: [], capabilities: [] }] }) });
  for (const step of ["bad:throws", "bad:nonsense", "bad:stranger", "bad:profile"]) {
    expect(await vercelBoardDecide(candidate(), settings([step, "pick:first"]), registry)).toMatchObject({ outcome: "skip", step });
  }
  // A pass may only narrow the agents; an agent it adds is dropped.
  expect(await vercelBoardDecide(candidate(), settings(["bad:widen", "pick:first"]), registry)).toMatchObject({ outcome: "skip", step: "pick:first", reason: "no free agent" });
  expect(await vercelBoardDecide(candidate(), settings(["no:such-step"]), registry)).toMatchObject({ outcome: "skip", reason: "no step named no:such-step" });
  expect(await vercelBoardDecide(candidate(), settings(["guard:not-synced"]), registry)).toMatchObject({ outcome: "skip", reason: "no step claimed it" });
});
