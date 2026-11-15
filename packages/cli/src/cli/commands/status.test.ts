import { afterAll, expect, test } from "bun:test";
import { createRuntimeRegistrySnapshot } from "@openscout/runtime/registry";
import { buildWorkStatuses, parseStatusCommandOptions, runStatusCommand, selectWorkStatuses } from "./status.ts";
import { shouldEnsureBrokerUptodateForCommand } from "../uptodate.ts";
import { createScoutCommandContext } from "../context.ts";

const originalBrokerUrl = process.env.OPENSCOUT_BROKER_URL;
const originalSocketPath = process.env.OPENSCOUT_BROKER_SOCKET_PATH;
const originalFetch = globalThis.fetch;

afterAll(() => {
  if (originalBrokerUrl === undefined) delete process.env.OPENSCOUT_BROKER_URL;
  else process.env.OPENSCOUT_BROKER_URL = originalBrokerUrl;
  if (originalSocketPath === undefined) delete process.env.OPENSCOUT_BROKER_SOCKET_PATH;
  else process.env.OPENSCOUT_BROKER_SOCKET_PATH = originalSocketPath;
  globalThis.fetch = originalFetch;
});

test("status cannot restart the broker and rejects ambiguous filter syntax", () => {
  expect(shouldEnsureBrokerUptodateForCommand("status")).toBe(false);
  expect(() => parseStatusCommandOptions(["--blocked"])).toThrow("require --all");
  expect(() => parseStatusCommandOptions(["--all", "--blocked", "--failed"])).toThrow("choose only one");
  expect(() => parseStatusCommandOptions(["--all", "flt-1"])).toThrow("not both");
  expect(() => parseStatusCommandOptions(["--all", "--next-actor"])).toThrow("requires");
});

test("blocked is explicit, old questions survive, failed and quiet work are distinct", () => {
  const snapshot = createRuntimeRegistrySnapshot({
    flights: {
      waiting: { id: "waiting", invocationId: "inv-1", requesterId: "parent", targetAgentId: "child", state: "waiting", summary: "Dependency unavailable" },
      running: { id: "running", invocationId: "inv-2", requesterId: "parent", targetAgentId: "child", state: "running", summary: "Previously blocked; now working" },
      failed: { id: "failed", invocationId: "inv-3", requesterId: "parent", targetAgentId: "child", state: "failed", error: "Failed check" },
    },
    collaborationRecords: {
      question: { id: "question", kind: "question", title: "Which target?", state: "open", acceptanceState: "none", createdById: "child", nextMoveOwnerId: "operator", createdAt: 1, updatedAt: 1 },
      answered: { id: "answered", kind: "question", title: "Which branch?", state: "answered", acceptanceState: "none", createdById: "child", createdAt: 1, updatedAt: 2 },
    },
  });
  const rows = buildWorkStatuses(snapshot);
  expect(selectWorkStatuses(rows, parseStatusCommandOptions(["--all", "--blocked"])).map(row => row.id).sort()).toEqual(["question", "waiting"]);
  expect(selectWorkStatuses(rows, parseStatusCommandOptions(["--all", "--failed"])).map(row => row.id)).toEqual(["failed"]);
  expect(selectWorkStatuses(rows, parseStatusCommandOptions(["--all", "--blocked", "--next-actor", "operator"])).map(row => row.id)).toEqual(["question"]);
  expect(rows.find(row => row.id === "waiting")?.nextActor).toBeNull();
});

test("exact and reference handles resolve and ambiguous bindings fail closed", () => {
  const snapshot = createRuntimeRegistrySnapshot({
    invocations: { inv: { id: "inv", requesterId: "parent", requesterNodeId: "node", targetAgentId: "child", action: "execute", task: "Build", messageId: "msg", ensureAwake: false, stream: false, createdAt: 1 } },
    flights: { flt: { id: "flt", invocationId: "inv", requesterId: "parent", targetAgentId: "child", state: "running", metadata: { bindingRef: "binding" } } },
  });
  const rows = buildWorkStatuses(snapshot);
  for (const ref of ["flt", "inv", "msg", "ref:binding"]) {
    expect(selectWorkStatuses(rows, parseStatusCommandOptions([ref]))[0]?.id).toBe("flt");
  }
  expect(() => selectWorkStatuses(rows, parseStatusCommandOptions(["missing"]))).toThrow("no work found");
  expect(() => selectWorkStatuses([...rows, { ...rows[0]!, id: "another" }], parseStatusCommandOptions(["ref:binding"]))).toThrow("ambiguous");
});

test("a /v1/snapshot read failure reports the endpoint and unknown work status", async () => {
  process.env.OPENSCOUT_BROKER_URL = "http://broker.test";
  process.env.OPENSCOUT_BROKER_SOCKET_PATH = "/nonexistent/openscout-status-test.sock";
  const requested: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    requested.push(`${request.method} ${url.pathname}`);
    if (url.pathname === "/v1/snapshot") {
      return new Response(JSON.stringify({ error: "snapshot exploded" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const context = createScoutCommandContext({
    cwd: "/tmp/openscout-test",
    env: {},
    stdout: () => undefined,
    stderr: () => undefined,
    isTty: false,
  });

  await expect(runStatusCommand(context, ["--all"]))
    .rejects
    .toThrow("/v1/snapshot read failed");
  await expect(runStatusCommand(context, ["--all"]))
    .rejects
    .toThrow("work status is unknown");
  expect(requested).toContain("GET /v1/snapshot");
});

test("operator question resolves only on an exact operator reply, never an unrelated message", () => {
  const snapshot = createRuntimeRegistrySnapshot();
  snapshot.messages.question = { id: "question", conversationId: "dm", actorId: "child", originNodeId: "node", class: "agent", body: "Which target should I use?", visibility: "private", policy: "durable", createdAt: 1, metadata: { operatorSignal: { kind: "need", question: "Which target should I use?" } } };
  snapshot.messages.reply = { ...snapshot.messages.question, id: "reply", metadata: {}, actorId: "operator", body: "Other topic", createdAt: 2 };
  expect(buildWorkStatuses(snapshot)[0]?.blocked).toBe(true);
  snapshot.messages.reply.replyToMessageId = "question";
  expect(buildWorkStatuses(snapshot)[0]?.state).toBe("answered");
  snapshot.messages.reply.actorId = "another-agent";
  expect(buildWorkStatuses(snapshot)[0]?.blocked).toBe(true);
});

test("plain status provides orientation without reading the broker", async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("orientation must not read broker"); }) as unknown as typeof fetch;
  try {
    const lines: string[] = [];
    await runStatusCommand(createScoutCommandContext({ stdout: line => lines.push(line) }), []);
    expect(lines.join("\n")).toContain("Health has not been checked");
    expect(lines.join("\n")).toContain("scout status <handle>");
    expect(parseStatusCommandOptions([]).overview).toBe(true);
    expect(parseStatusCommandOptions(["--help"]).help).toBe(true);
  } finally { globalThis.fetch = savedFetch; }
});

test("flight status exposes observed assignee and broker-captured final answer", () => {
  const snapshot = createRuntimeRegistrySnapshot({
    endpoints: { ep: { id: "ep", agentId: "child", nodeId: "node", harness: "codex", transport: "local_socket", state: "idle",
      cwd: "/work/project", sessionId: "native", metadata: { model: "gpt-test", pid: 123 } } },
    flights: { flt: { id: "flt", invocationId: "inv", requesterId: "parent", targetAgentId: "child", state: "completed",
      output: "Done: https://github.com/openscout-app/scout/pull/123" } },
  });
  const row = buildWorkStatuses(snapshot)[0]!;
  expect(row.assignee).toEqual({ harness: "codex", model: "gpt-test", cwd: "/work/project", pid: 123, sessionId: "native" });
  expect(row.answer).toContain("/pull/123");
});

test("a session handle resolves to the task that session is running, else its last one", () => {
  const invocation = (id: string, createdAt: number) => ({ id, requesterId: "parent", requesterNodeId: "node", targetAgentId: "session-abc", action: "execute" as const, task: id, messageId: `msg-${id}`, ensureAwake: false, stream: false, createdAt });
  const flight = (id: string, invocationId: string, state: "running" | "completed", startedAt: number) => ({ id, invocationId, requesterId: "parent", targetAgentId: "session-abc", state, startedAt });
  const running = buildWorkStatuses(createRuntimeRegistrySnapshot({
    invocations: { old: invocation("old", 1), now: invocation("now", 2) },
    flights: { "flt-old": flight("flt-old", "old", "completed", 10), "flt-now": flight("flt-now", "now", "running", 5) },
  }));
  expect(selectWorkStatuses(running, parseStatusCommandOptions(["session-abc"]))[0]?.id).toBe("flt-now");
  const finished = buildWorkStatuses(createRuntimeRegistrySnapshot({
    invocations: { old: invocation("old", 1), now: invocation("now", 2) },
    flights: { "flt-old": flight("flt-old", "old", "completed", 10), "flt-now": flight("flt-now", "now", "completed", 20) },
  }));
  expect(selectWorkStatuses(finished, parseStatusCommandOptions(["session-abc"]))[0]?.id).toBe("flt-now");
  expect(() => selectWorkStatuses(finished, parseStatusCommandOptions(["session-other"]))).toThrow("no work found");
});
