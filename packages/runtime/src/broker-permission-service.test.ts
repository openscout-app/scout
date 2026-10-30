import { afterEach, describe, expect, test } from "bun:test";
import { assertValidCollaborationRecord, type FlightRecord, type InvocationRequest, type QuestionRecord } from "@openscout/protocol";
import { BrokerPermissionService, PermissionDeliveryUnconfirmedError, PermissionRequestEndedError, type PermissionReattachment } from "./broker-permission-service.js";
import { configureManagedPermissionHandler, withManagedPermissionContext } from "./managed-permission.js";
import { parseTmuxPermission, tmuxPermissionPrompt, waitForTmuxPermission } from "./tmux-permission.js";
import { waitForReadyComposer } from "./local-agents.js";

const trust = `old scrollback\nAccessing workspace:\n /tmp/project\nQuick safety check: Is this a project you trust?\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel`;
const tool = `Bash command\n rm -rf dist\nThis command requires approval\nDo you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again in this project\n   3. No\nEsc to cancel`;
const invocation = { id: "inv", targetAgentId: "agent", conversationId: "chn-test" } as InvocationRequest;
function harness(options: { reattach?: (request: { sessionId: string; projectRoot: string; text: string }) => Promise<PermissionReattachment>; localInvocation?: boolean } = {}) {
  const records = new Map<string, QuestionRecord>();
  const states: string[] = [];
  const notifications: QuestionRecord[] = [];
  const lookups: string[] = [];
  let state = "running";
  const service = new BrokerPermissionService({
    operatorId: "operator", nodeId: "node", createId: () => "permission-1", record: async record => { assertValidCollaborationRecord(record); records.set(record.id, record); },
    read: id => records.get(id), requests: () => [...records.values()], flight: () => ({ id: "flt", state } as FlightRecord),
    localInvocation: () => options.localInvocation ?? true,
    reattach: async request => { lookups.push(request.sessionId); return options.reattach ? options.reattach(request) : { sessionOpen: false }; },
    transition: async (_, value) => { states.push(value); state = value; },
    notify: (_, record) => { notifications.push(record); }, sleep: async () => { await new Promise(resolve => setTimeout(resolve, 1)); },
  });
  return { service, records, states, notifications, lookups, cancel: () => { state = "cancelled"; } };
}
/** An open request as the previous runtime left it: durable record, no waiter. */
function orphan(h: ReturnType<typeof harness>, text: string, permissionRequest: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}, id = "permission-0"): QuestionRecord {
  const record: QuestionRecord = {
    id, kind: "question", state: "open", acceptanceState: "none", title: "Permission request", summary: text,
    createdById: "agent", askedById: "agent", ownerId: "operator", nextMoveOwnerId: "operator", conversationId: "chn-test",
    createdAt: 1, updatedAt: 1,
    metadata: { permissionRequest: { sessionId: "pane", projectRoot: "/tmp/project", nodeId: "node", invocationId: "inv", flightId: "flt",
      version: parseTmuxPermission(text, "/tmp/project")?.version ?? "v", decisions: ["project", "deny"], ...permissionRequest }, ...metadata },
  };
  assertValidCollaborationRecord(record);
  h.records.set(record.id, record);
  return record;
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 1));
  expect(predicate()).toBe(true);
}
afterEach(() => configureManagedPermissionHandler(undefined));
describe("managed permission lifecycle", () => {
  test("folder trust parks the flight, notifies once, sends keys to the same live pane and resumes composer readiness", async () => {
    const h = harness();
    configureManagedPermissionHandler((inv, prompt) => h.service.wait(inv, prompt));
    let pane = trust; let now = 0; const keys: string[][] = [];
    const wait = withManagedPermissionContext(invocation, () => waitForReadyComposer({
      sessionName: "pane-1", harnessLabel: "Claude", timeoutMs: 50, graceMs: 10, ceilingMs: 100,
      now: () => now, isAlive: () => true, captureTail: async () => pane, isReady: text => text === "ready",
      blockingDialog: text => parseTmuxPermission(text) ? "permission" : null,
      onBlockingDialog: text => waitForTmuxPermission({ sessionId: "pane-1", projectRoot: "/tmp/project", text,
        capture: async () => pane, alive: async () => true, send: async value => { keys.push(value); pane = "ready"; },
      }), sleep: async () => { now += 1; },
    }));
    await until(() => h.notifications.length === 1);
    const record = h.records.get("permission-1")!;
    expect(record).toMatchObject({ state: "open", nextMoveOwnerId: "operator", metadata: { permissionRequest: { sessionId: "pane-1", flightId: "flt", projectRoot: "/tmp/project" } } });
    expect(h.states).toEqual(["waiting"]);
    now = 60_000; // Human time does not consume the boot deadline.
    await h.service.decide(record.id, parseTmuxPermission(trust)!.version, "project");
    await wait;
    expect(keys).toEqual([["Down", "Enter"]]);
    expect(h.states).toEqual(["waiting", "running"]);
    expect(h.records.get(record.id)?.state).toBe("closed");
    await expect(h.service.decide(record.id, parseTmuxPermission(trust)!.version, "project")).rejects.toThrow("settled");
  });
  test.each(["once", "project", "deny"] as const)("tool %s is delivered exactly once", async decision => {
    const h = harness(); configureManagedPermissionHandler((inv, prompt) => h.service.wait(inv, prompt));
    let pane = tool; const sent: string[][] = [];
    const wait = withManagedPermissionContext(invocation, () => waitForTmuxPermission({ sessionId: "pane", projectRoot: "/tmp/project", text: tool,
      capture: async () => pane, alive: async () => true, send: async keys => { sent.push(keys); pane = "done"; },
    }));
    await until(() => h.notifications.length > 0);
    await h.service.decide("permission-1", parseTmuxPermission(tool)!.version, decision); await wait;
    expect(sent).toEqual([decision === "once" ? ["Enter"] : decision === "project" ? ["2"] : ["3"]]);
  });
  test("stale version and unsupported trust-once never write keys", async () => {
    const h = harness(); let sent = 0; let current = true;
    const wait = h.service.wait(invocation, { sessionId: "pane", projectRoot: "/tmp/project", text: trust, version: "v", decisions: ["project", "deny"],
      isCurrent: async () => current, answer: async () => { sent++; },
    });
    await until(() => h.notifications.length > 0);
    await expect(h.service.decide("permission-1", "stale", "project")).rejects.toThrow("changed");
    await expect(h.service.decide("permission-1", "v", "once")).rejects.toThrow("scope");
    expect(sent).toBe(0); current = false; await wait;
    expect(h.records.get("permission-1")?.answer).toBe("Prompt is no longer present");
  });
  test("ambiguous delivery fails the waiter and cannot replay", async () => {
    const h = harness(); let sent = 0;
    const wait = h.service.wait(invocation, { sessionId: "pane", projectRoot: "/p", text: "prompt", version: "v", decisions: ["once"],
      isCurrent: async () => true, answer: async () => { sent++; throw new Error("send failed"); },
    });
    const outcome = wait.catch(error => error.message);
    await until(() => h.notifications.length > 0);
    await expect(h.service.decide("permission-1", "v", "once")).rejects.toBeInstanceOf(PermissionDeliveryUnconfirmedError);
    expect(await outcome).toBe("send failed"); expect(sent).toBe(1);
    expect(h.records.get("permission-1")?.state).toBe("declined");
    await expect(h.service.decide("permission-1", "v", "once")).rejects.toThrow("settled");
  });
  test("ambiguous delivery cannot replay even when the close write also fails", async () => {
    const h = harness(); let sent = 0;
    const record = h.service["deps"].record;
    h.service["deps"].record = async (value: QuestionRecord) => {
      if (value.state === "declined") throw new Error("close persistence failed");
      return record(value);
    };
    const wait = h.service.wait(invocation, { sessionId: "pane", projectRoot: "/p", text: "prompt", version: "v", decisions: ["once"],
      isCurrent: async () => true, answer: async () => { sent++; throw new Error("send failed"); },
    });
    const outcome = wait.catch(error => error.message);
    await until(() => h.notifications.length > 0);
    await expect(h.service.decide("permission-1", "v", "once")).rejects.toBeInstanceOf(PermissionDeliveryUnconfirmedError);
    expect(await outcome).toBe("send failed");
    // The record is still open, but it carries the attempt mark; nothing may resend.
    expect(h.records.get("permission-1")?.state).toBe("open");
    await expect(h.service.decide("permission-1", "v", "once")).rejects.toThrow();
    expect(sent).toBe(1);
  });
  test("foreign session is not gated", async () => {
    expect(await waitForTmuxPermission({ sessionId: "foreign", projectRoot: "/p", text: trust,
      capture: async () => trust, alive: async () => true, send: async () => { throw new Error("must not send"); },
    })).toBe(false);
  });
  test("fingerprint ignores unrelated scrollback but binds selection and prompt", () => {
    expect(parseTmuxPermission(trust)?.version).toBe(parseTmuxPermission(`different history\n${trust}`)?.version);
    expect(parseTmuxPermission(trust.replace("/tmp/project", "/other"))?.version).not.toBe(parseTmuxPermission(trust)?.version);
    expect(parseTmuxPermission(trust)?.keys.once).toBeUndefined();
  });
});

test("cancelled flights never receive permission keys", async () => {
  const h = harness(); let sent = 0;
  const wait = h.service.wait(invocation, { sessionId: "pane", projectRoot: "/p", text: "prompt", version: "v", decisions: ["once"],
    isCurrent: async () => true, answer: async () => { sent++; },
  });
  const outcome = wait.catch(error => error.message);
  await until(() => h.notifications.length > 0); h.cancel();
  await expect(h.service.decide("permission-1", "v", "once")).rejects.toThrow("no longer active");
  expect(await outcome).toContain("no longer active"); expect(sent).toBe(0);
});

test("a stale tool dialog below a ready composer cannot be answered", () => {
  expect(parseTmuxPermission(`${tool}\n❯ `)).toBeNull();
  expect(parseTmuxPermission(`${trust}\n❯ `)).toBeNull();
});

test("a selection redraw is not a permission acknowledgement", async () => {
  configureManagedPermissionHandler(async (_, prompt) => {
    await prompt.answer("project");
  });
  let pane = trust; let capturesAfterSend = 0; let sent = false;
  await withManagedPermissionContext(invocation, () => waitForTmuxPermission({ sessionId: "pane", projectRoot: "/tmp/project", text: trust,
    alive: async () => true, capture: async () => {
      if (sent && ++capturesAfterSend > 1) pane = "ready";
      return pane;
    }, send: async () => { sent = true; pane = trust.replace("❯ No, exit", "  No, exit").replace("   Yes, I trust", " ❯ Yes, I trust"); },
  }));
  expect(capturesAfterSend).toBe(2);
});

test("old folder trust history does not hide the current tool permission", () => {
  expect(parseTmuxPermission(`${trust}\n${tool}`)).toEqual(parseTmuxPermission(tool));
});

describe("requests that outlive their waiter", () => {
  function pane(text: string) {
    const state = { text, sent: [] as string[][] };
    const bind = (shown = state.text) => tmuxPermissionPrompt({ sessionId: "pane", projectRoot: "/tmp/project", text: shown,
      capture: async () => state.text, alive: async () => true, send: async keys => { state.sent.push(keys); state.text = "ready"; },
    });
    return { state, reattach: async (): Promise<PermissionReattachment> => {
      const prompt = bind();
      return prompt ? { prompt, sessionOpen: true } : { sessionOpen: true };
    } };
  }

  test("a restart rebinds the request to the prompt its session still shows, and the answer reaches that pane", async () => {
    const live = pane(trust); const h = harness({ reattach: live.reattach });
    // The flight ended with the old runtime. The session is still waiting on its prompt.
    h.cancel();
    const record = orphan(h, parseTmuxPermission(trust, "/tmp/project")!.text);
    expect(await h.service.reconcile()).toEqual({ adopted: [record.id], closed: [], failed: [] });
    expect(h.records.get(record.id)?.state).toBe("open");
    await h.service.decide(record.id, parseTmuxPermission(trust)!.version, "project");
    expect(live.state.sent).toEqual([["Down", "Enter"]]);
    expect(h.records.get(record.id)).toMatchObject({ state: "closed", answer: "project" });
    expect(h.states).toEqual([]);
  });

  test("decide rebinds by itself when no sweep has run yet", async () => {
    const live = pane(tool); const h = harness({ reattach: live.reattach });
    h.cancel();
    const record = orphan(h, parseTmuxPermission(tool, "/tmp/project")!.text, { decisions: ["once", "project", "deny"] });
    await h.service.decide(record.id, parseTmuxPermission(tool)!.version, "deny");
    expect(live.state.sent).toEqual([["3"]]);
    expect(h.records.get(record.id)?.answer).toBe("deny");
  });

  test("a request nothing can answer is settled with the reason", async () => {
    const h = harness();
    // A record from before the node stamp, whose invocation this runtime ran.
    const record = orphan(h, trust, { nodeId: undefined });
    expect(await h.service.reconcile()).toEqual({ adopted: [], closed: [record.id], failed: [] });
    expect(h.records.get(record.id)).toMatchObject({ state: "declined", answer: "Nothing is waiting on this request any more." });
    await expect(h.service.decide(record.id, "v", "project")).rejects.toBeInstanceOf(PermissionRequestEndedError);
  });

  test("an open session that no longer shows the prompt ends the request and says the session is open", async () => {
    const h = harness({ reattach: async () => ({ sessionOpen: true }) });
    const record = orphan(h, trust);
    const error = await h.service.decide(record.id, "v", "project").catch(value => value);
    expect(error).toBeInstanceOf(PermissionRequestEndedError);
    expect(error).toMatchObject({ sessionOpen: true, message: "The session no longer shows this prompt." });
    expect(h.records.get(record.id)?.state).toBe("declined");
  });

  test("a rebound prompt answered in the terminal closes its request", async () => {
    const live = pane(trust); const h = harness({ reattach: live.reattach });
    const record = orphan(h, parseTmuxPermission(trust, "/tmp/project")!.text);
    await h.service.reconcile();
    live.state.text = "ready";
    await until(() => h.records.get(record.id)?.state === "closed");
    expect(h.records.get(record.id)?.answer).toBe("Prompt is no longer present");
    expect(live.state.sent).toEqual([]);
  });

  test("a moved cursor keeps the request, at the version shown now", async () => {
    const moved = trust.replace("❯ No, exit", "  No, exit").replace("   Yes, I trust", " ❯ Yes, I trust");
    const live = pane(moved); const h = harness({ reattach: live.reattach });
    const record = orphan(h, parseTmuxPermission(trust, "/tmp/project")!.text);
    await h.service.reconcile();
    const version = parseTmuxPermission(moved)!.version;
    expect(h.records.get(record.id)?.metadata?.permissionRequest).toMatchObject({ version, nodeId: "node", invocationId: "inv" });
    await expect(h.service.decide(record.id, parseTmuxPermission(trust)!.version, "project")).rejects.toThrow("changed");
    await h.service.decide(record.id, version, "project");
    expect(live.state.sent).toEqual([["Enter"]]);
  });

  test("an attempted decision is settled, never rebound and sent again", async () => {
    const live = pane(trust); const h = harness({ reattach: live.reattach });
    const record = orphan(h, trust, {}, { permissionActuation: { decision: "project", at: 1, status: "attempt" } });
    expect(await h.service.reconcile()).toEqual({ adopted: [], closed: [record.id], failed: [] });
    expect(h.lookups).toEqual([]); expect(live.state.sent).toEqual([]);
    expect(h.records.get(record.id)?.answer).toBe("A decision may already have been sent. Check the session.");
  });

  test("another host's request is never looked up or settled here", async () => {
    const h = harness({ localInvocation: false });
    const remote = orphan(h, trust, { nodeId: "other" });
    expect(await h.service.reconcile()).toEqual({ adopted: [], closed: [], failed: [] });
    await expect(h.service.decide(remote.id, "v", "project")).rejects.toThrow("another host");
    // Records from before the node stamp are placed by their invocation.
    const legacy = orphan(h, trust, { nodeId: undefined }, {}, "permission-legacy");
    expect(await h.service.reconcile()).toEqual({ adopted: [], closed: [], failed: [] });
    expect(h.lookups).toEqual([]);
    expect([h.records.get(remote.id)?.state, h.records.get(legacy.id)?.state]).toEqual(["open", "open"]);
  });

  test("a failed lookup leaves the request open for the next pass", async () => {
    const h = harness({ reattach: async () => { throw new Error("tmux timed out"); } });
    const record = orphan(h, trust);
    expect(await h.service.reconcile()).toEqual({ adopted: [], closed: [], failed: [record.id] });
    expect(h.records.get(record.id)?.state).toBe("open");
    await expect(h.service.decide(record.id, "v", "project")).rejects.toThrow("tmux timed out");
  });

  test("the operator can dismiss a request whose lookup keeps failing, and nothing is sent", async () => {
    const h = harness({ reattach: async () => { throw new Error("tmux timed out"); } });
    const record = orphan(h, trust);
    await h.service.reconcile();
    await h.service.dismiss(record.id);
    expect(h.records.get(record.id)).toMatchObject({ state: "declined", answer: "Dismissed by the operator", answeredById: "operator" });
    expect(h.lookups).toEqual(["pane"]);
    await expect(h.service.decide(record.id, "v", "project")).rejects.toBeInstanceOf(PermissionRequestEndedError);
    await expect(h.service.dismiss(record.id)).rejects.toBeInstanceOf(PermissionRequestEndedError);
  });

  test("another host's request can be dismissed here, without a lookup", async () => {
    const h = harness({ localInvocation: false });
    const remote = orphan(h, trust, { nodeId: "other" });
    await h.service.dismiss(remote.id);
    expect(h.records.get(remote.id)?.state).toBe("declined");
    expect(h.lookups).toEqual([]);
  });

  test("a request its session still waits on is answered, not dismissed", async () => {
    const live = pane(trust); const h = harness({ reattach: live.reattach });
    const record = orphan(h, parseTmuxPermission(trust, "/tmp/project")!.text);
    await h.service.reconcile();
    await expect(h.service.dismiss(record.id)).rejects.toThrow("still waiting");
    expect(h.records.get(record.id)?.state).toBe("open");
    await h.service.decide(record.id, parseTmuxPermission(trust)!.version, "project");
    expect(live.state.sent).toEqual([["Down", "Enter"]]);
  });

  test("an agent's question to the operator can be dismissed; a request to someone else cannot", async () => {
    const h = harness();
    const question = (id: string, ownerId: string): QuestionRecord => {
      const record: QuestionRecord = {
        id, kind: "question", state: "open", acceptanceState: "none", title: "Which branch?", summary: "Which branch?",
        createdById: "agent", askedById: "agent", ownerId, nextMoveOwnerId: ownerId, conversationId: "chn-test",
        createdAt: 1, updatedAt: 1, metadata: { operatorNeedMessageId: "msg-1", requestKind: "question" },
      };
      assertValidCollaborationRecord(record);
      h.records.set(id, record);
      return record;
    };
    const asked = question("operator-question:msg-1", "operator");
    await h.service.dismiss(asked.id);
    expect(h.records.get(asked.id)).toMatchObject({ state: "declined", answer: "Dismissed by the operator" });
    const other = question("question-2", "agent-2");
    await expect(h.service.dismiss(other.id)).rejects.toThrow("Only requests to the operator");
    expect(h.records.get(other.id)?.state).toBe("open");
    await expect(h.service.dismiss("missing")).rejects.toBeInstanceOf(PermissionRequestEndedError);
  });

  test("a recorded prompt matches its pane without the cursor", () => {
    for (const text of [trust, tool]) {
      const shown = parseTmuxPermission(text, "/tmp/project")!;
      expect(parseTmuxPermission(shown.text, "/tmp/project")).toEqual(shown);
    }
    const moved = trust.replace("❯ No, exit", "  No, exit").replace("   Yes, I trust", " ❯ Yes, I trust");
    expect(parseTmuxPermission(moved)!.identity).toBe(parseTmuxPermission(trust)!.identity);
    expect(parseTmuxPermission(moved)!.version).not.toBe(parseTmuxPermission(trust)!.version);
  });
});
