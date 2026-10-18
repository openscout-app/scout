import { describe, expect, test } from "bun:test";

import { brokerDeliverRequestSchema, brokerInvocationRequestSchema, brokerInvocationRequestSchemaFor } from "./broker-command-boundary-schemas.js";

import { parseScoutRuntimeSpec, SCOUT_RUNTIME_CATALOG } from "@openscout/protocol";

const baseInvocation = {
  id: "inv-1",
  requesterId: "actor-a",
  requesterNodeId: "node-a",
  targetAgentId: "agent-b",
  action: "execute",
  task: "do the thing",
  ensureAwake: true,
  stream: false,
  createdAt: 1_700_000_000_000,
};

test("session-input wire intent is required and normalizes to the existing consult command", () => {
  const payload = { requestId: "mobile-1", body: "continue", intent: "session_input", sessionDelivery: "in_place_or_resume",
    target: { kind: "session_id", sessionId: "native", harness: "claude" } };
  expect(brokerDeliverRequestSchema.parse(payload)).toEqual({ ...payload, intent: "consult" });
  expect(brokerDeliverRequestSchema.safeParse({ ...payload, intent: "consult" }).success).toBe(false);
  expect(brokerDeliverRequestSchema.safeParse({ ...payload, sessionDelivery: undefined }).success).toBe(false);
  expect(brokerDeliverRequestSchema.safeParse({ body: "ordinary", intent: "consult" }).success).toBe(true);
});

describe("brokerInvocationRequestSchema execution.turnBudgetMs", () => {
  test("accepts an execution turn budget up to the 6 h bound", () => {
    const parsed = brokerInvocationRequestSchema.safeParse({
      ...baseInvocation,
      execution: { turnBudgetMs: 6 * 60 * 60_000 },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.execution?.turnBudgetMs).toBe(6 * 60 * 60_000);
    }
  });

  test("rejects a turn budget above 6 hours", () => {
    const parsed = brokerInvocationRequestSchema.safeParse({
      ...baseInvocation,
      execution: { turnBudgetMs: 6 * 60 * 60_000 + 1 },
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects non-positive and non-integer turn budgets", () => {
    for (const turnBudgetMs of [0, -1, 1.5]) {
      const parsed = brokerInvocationRequestSchema.safeParse({
        ...baseInvocation,
        execution: { turnBudgetMs },
      });
      expect(parsed.success).toBe(false);
    }
  });
});


test("new published model efforts traverse local grammar and the live broker boundary", () => {
  const catalog = structuredClone(SCOUT_RUNTIME_CATALOG);
  const codex = catalog.harnesses.find((harness) => harness.id === "codex")!;
  codex.models = codex.models.map((model) => ({ ...model, enabled: false, default: false }));
  codex.models.push({ id: "gpt-published-next", label: "Published Next", enabled: true, default: true, reasoningEfforts: ["max", "ultra"] });
  const parsed = parseScoutRuntimeSpec("codex/gpt-published-next/ultra");
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error);
  const liveBoundary = brokerInvocationRequestSchemaFor(catalog);
  expect(liveBoundary.safeParse({ ...baseInvocation, execution: parsed.value }).success).toBe(true);
  expect(liveBoundary.safeParse({ ...baseInvocation, execution: { ...parsed.value, reasoningEffort: "medium" } }).success).toBe(false);
  expect(liveBoundary.safeParse({ ...baseInvocation, execution: { harness: "codex", model: "gpt-6-astra", session: "new" } }).success).toBe(false);
  expect(liveBoundary.safeParse({ ...baseInvocation, execution: { harness: "codex", model: "gpt-6-astra", session: "reuse" } }).success).toBe(false);
  expect(liveBoundary.safeParse({ ...baseInvocation, execution: { harness: "codex", model: "gpt-6-astra", reasoningEffort: "high", session: "existing", targetSessionId: "old-task" } }).success).toBe(true);
  expect(liveBoundary.safeParse({ ...baseInvocation, execution: { harness: "codex" } }).success).toBe(true);
});


test("broker boundary validates family aliases using the live family's model-specific effort", () => {
  const catalog = structuredClone(SCOUT_RUNTIME_CATALOG);
  const claude = catalog.harnesses.find((harness) => harness.id === "claude")!;
  claude.models = [{ id: "claude-opus-future", label: "Future Opus", family: "Opus", enabled: true, default: true, reasoningEfforts: ["ultra"] }];
  const boundary = brokerInvocationRequestSchemaFor(catalog);
  expect(boundary.safeParse({ ...baseInvocation, execution: { harness: "claude", model: "opus", reasoningEffort: "ultra" } }).success).toBe(true);
  expect(boundary.safeParse({ ...baseInvocation, execution: { harness: "claude", model: "opus", reasoningEffort: "medium" } }).success).toBe(false);
});

test("explicit completion wire intent fences old brokers and cannot mix with session input", () => {
  const payload = { intent: "explicit_consult", body: "inspect", requestId: "stable", completion: { mode: "explicit" } };
  expect(brokerDeliverRequestSchema.parse(payload)).toEqual({ ...payload, intent: "consult" });
  expect(brokerDeliverRequestSchema.safeParse({ ...payload, intent: "consult" }).success).toBe(false);
  expect(brokerDeliverRequestSchema.safeParse({ ...payload, completion: undefined }).success).toBe(false);
  expect(brokerDeliverRequestSchema.safeParse({ ...payload, completion: { mode: "automatic" } }).success).toBe(false);
  expect(brokerDeliverRequestSchema.safeParse({ ...payload, sessionDelivery: "in_place_or_resume" }).success).toBe(false);
  expect(brokerDeliverRequestSchema.safeParse({ ...payload, completion: undefined, relation: { parentFlightId: "f", kind: "joined" } }).success).toBe(true);
  expect(brokerInvocationRequestSchema.safeParse({ ...baseInvocation, metadata: { completion: { mode: "explicit" } } }).success).toBe(false);
});
