import { afterEach, describe, expect, test } from "bun:test";
import { assertValidCollaborationRecord, type FlightRecord, type InvocationRequest, type QuestionRecord } from "@openscout/protocol";
import { BrokerPermissionService, PermissionDeliveryUnconfirmedError } from "./broker-permission-service.js";
import { configureManagedPermissionHandler, withManagedPermissionContext } from "./managed-permission.js";
import { parseTmuxPermission, waitForTmuxPermission } from "./tmux-permission.js";
import { waitForReadyComposer } from "./local-agents.js";

const trust = `old scrollback\nAccessing workspace:\n /tmp/project\nQuick safety check: Is this a project you trust?\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel`;
const tool = `Bash command\n rm -rf dist\nThis command requires approval\nDo you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again in this project\n   3. No\nEsc to cancel`;
const invocation = { id: "inv", targetAgentId: "agent", conversationId: "chn-test" } as InvocationRequest;
function harness() {
  const records = new Map<string, QuestionRecord>();
  const states: string[] = [];
  const notifications: QuestionRecord[] = [];
  let state = "running";
  const service = new BrokerPermissionService({
    operatorId: "operator", createId: () => "permission-1", record: async record => { assertValidCollaborationRecord(record); records.set(record.id, record); },
    read: id => records.get(id), flight: () => ({ id: "flt", state } as FlightRecord),
    transition: async (_, value) => { states.push(value); state = value; },
    notify: (_, record) => { notifications.push(record); }, sleep: async () => { await new Promise(resolve => setTimeout(resolve, 1)); },
  });
  return { service, records, states, notifications, cancel: () => { state = "cancelled"; } };
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
    await expect(h.service.decide(record.id, parseTmuxPermission(trust)!.version, "project")).rejects.toThrow("no live");
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
    await expect(h.service.decide("permission-1", "v", "once")).rejects.toThrow("no live");
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
