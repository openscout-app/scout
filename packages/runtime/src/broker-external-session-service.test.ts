import { BrokerMessageService } from "./broker-message-service.js";
import { describe, expect, test } from "bun:test";
import type { AgentDefinition, AgentEndpoint, DeliveryIntent, FlightRecord, InvocationRequest, MessageRecord } from "@openscout/protocol";
import { BrokerExternalSessionService } from "./broker-external-session-service.js";
import { ExternalSessionTransportError, type ExternalSessionConnection } from "./external-session-transport.js";
import { classifyEndpoint } from "./broker-endpoint-selection.js";

function fixture(deliveryMode?: "cloud_cli") {
  const endpoints = new Map<string, AgentEndpoint>();
  const deliveries = new Map<string, DeliveryIntent>();
  const flights = new Map<string, FlightRecord>();
  const invocations = new Map<string, InvocationRequest>();
  const messages = new Map<string, MessageRecord>();
  const sent: string[] = [];
  const connection: ExternalSessionConnection = { id: "devin-team", ownerId: "remote-owner", agentId: "devin", provider: "devin", organizationId: "org-test", tokenEnv: "DEVIN_TOKEN", deliveryMode };
  let failure: Error | undefined;
  const transport = { inspect: async (id: string) => ({ nativeSessionId: `devin-${id.replace(/^devin-/, "")}`, state: "suspended" }),
    send: async (_id: string, body: string) => { sent.push(body); if (failure) throw failure; return { nativeSessionId: "devin-123456", state: "resuming" }; } };
  const options = { nodeId: "local", invocations: () => invocations.values(), actor: () => undefined, persistActor: async () => {},
    visitDeliveries: async (visitor: (d: DeliveryIntent) => void) => { for (const d of deliveries.values()) visitor(d); }, connections: () => [connection], transport: () => transport, endpoints: () => [...endpoints.values()],
    agent: (id: string) => id === "devin" ? { id, kind: "agent", authorityNodeId: "local" } as AgentDefinition : undefined,
    persistEndpoint: async (e: AgentEndpoint) => { endpoints.set(e.id, e); }, delivery: (id: string) => deliveries.get(id),
    recordDelivery: async (d: DeliveryIntent) => { deliveries.set(d.id, d); },
    mutateDelivery: async (id: string, update: (current: DeliveryIntent) => DeliveryIntent | null) => {
      const current = deliveries.get(id); if (!current) return;
      const next = update(current); if (next) deliveries.set(id, next); return next ?? current;
    }, invocation: (id: string) => invocations.get(id),
    flight: (id: string) => flights.get(id), recordFlight: async (f: FlightRecord) => { flights.set(f.invocationId, f); },
    postMessage: async (m: MessageRecord) => { messages.set(m.id, m); } };
  const service = new BrokerExternalSessionService(options);
  async function setup(id = "inv-1") {
    const receipt = await service.attach({ ownerId: "remote-owner", connectionId: connection.id, nativeSessionId: "123456" });
    const invocation: InvocationRequest = { id, requesterId: "operator", requesterNodeId: "local", targetAgentId: "devin", action: "consult", task: "Check the build", conversationId: "conversation", messageId: `message-${id}`, ensureAwake: true, stream: false, createdAt: Date.now(), execution: { targetSessionId: receipt.sessionId! } };
    invocations.set(id, invocation);
    flights.set(id, { id: `flight-${id}`, invocationId: id, requesterId: invocation.requesterId, targetAgentId: "devin", state: "queued" });
    return { invocation, receipt, endpoint: service.endpointFor(invocation)! };
  }
  function address() { return JSON.parse(sent[0]!.split("coordination metadata):\n")[1]!.split("\n")[0]!); }
  return { service, options, setup, sent, endpoints, deliveries, flights, messages, invocations, address, fail: (error: Error) => { failure = error; } };
}
describe("external session attachment", () => {
  test("cancellation racing durable delivery preparation fences provider submission", async () => {
    const f = fixture();
    const { invocation, endpoint } = await f.setup();
    const record = f.options.recordDelivery;
    f.options.recordDelivery = async delivery => {
      await record(delivery);
      f.flights.set(invocation.id, { ...f.flights.get(invocation.id)!, state: "cancelled" });
    };
    await f.service.dispatch(invocation, endpoint);
    expect(f.sent).toHaveLength(0);
    expect([...f.deliveries.values()][0]?.status).toBe("cancelled");
    expect(f.flights.get(invocation.id)?.state).toBe("cancelled");
  });
  test("Cloud CLI remains exact-session routable and requires the correlated MCP reply", async () => {
    const f = fixture("cloud_cli");
    const { invocation, endpoint, receipt } = await f.setup();
    expect(endpoint.transport).toBe("devin_cloud_cli");
    expect(receipt.returnTransport).toBe("cloud_cli");
    expect(classifyEndpoint(endpoint).supportedTransport).toBe(true);
    await f.service.dispatch(invocation, endpoint);
    expect(f.flights.get(invocation.id)?.state).toBe("waiting");
    await f.service.reply({ ...f.address(), ownerId: "remote-owner", body: "Done through MCP." });
    expect(f.flights.get(invocation.id)?.state).toBe("completed");
  });
  test("Cloud CLI rejects awake-only delivery before sending and preserves uncertain sends on recovery", async () => {
    const f = fixture("cloud_cli");
    const { invocation, endpoint } = await f.setup();
    await expect(f.service.dispatch({ ...invocation, ensureAwake: false }, endpoint)).rejects.toThrow("awake_only_delivery_unsupported");
    expect(f.sent).toHaveLength(0);
    f.fail(new ExternalSessionTransportError(true, "devin_cli_delivery_unconfirmed"));
    await f.service.dispatch(invocation, endpoint);
    await new BrokerExternalSessionService(f.options).dispatch(invocation, endpoint);
    expect(f.sent).toHaveLength(1);
    expect(f.flights.get(invocation.id)?.state).toBe("waiting");
  });
  test("idempotent verified attachment uses opaque routable handle, no new agent", async () => {
    const f = fixture(); const a = await f.setup(); const b = await f.setup();
    expect(a.receipt.sessionId).toMatch(/^sess\.[a-f0-9]{20}$/);
    expect(b.receipt.sessionId).toBe(a.receipt.sessionId);
    expect(f.endpoints.size).toBe(1);
    expect(classifyEndpoint(a.endpoint).supportedTransport).toBe(true);
    expect(f.service.endpointFor({ ...a.invocation, execution: undefined })).toBeUndefined();
    await expect(f.service.attach({ ownerId: "intruder", connectionId: "devin-team", nativeSessionId: "123456" })).rejects.toThrow("unavailable");
    expect(() => f.service.get({ ownerId: "intruder", sessionId: a.receipt.sessionId! })).toThrow("not_found");
  });
  test("provider acceptance is waiting; exact reply completes original flight once", async () => {
    const f = fixture(); const { invocation, endpoint, receipt } = await f.setup();
    await Promise.all([f.service.dispatch(invocation, endpoint), f.service.dispatch(invocation, endpoint)]);
    expect(f.sent).toHaveLength(1);
    expect(f.flights.get(invocation.id)?.state).toBe("waiting");
    expect([...f.deliveries.values()][0]?.status).toBe("acknowledged");
    const args = { ...f.address(), ownerId: "remote-owner", body: "Build passes." };
    await expect(f.service.reply({ ...args, replyToken: "wrong" })).rejects.toThrow("invalid");
    await expect(f.service.reply({ ...args, ownerId: "intruder" })).rejects.toThrow("not_found");
    const other = await f.service.attach({ ownerId: "remote-owner", connectionId: "devin-team", nativeSessionId: "654321" });
    await expect(f.service.reply({ ...args, sessionId: other.sessionId })).rejects.toThrow("invalid");
    expect((await f.service.reply(args)).duplicate).toBe(false);
    expect((await f.service.reply(args)).duplicate).toBe(true);
    await expect(f.service.reply({ ...args, body: "Changed" })).rejects.toThrow("conflict");
    expect(f.messages.size).toBe(1);
    expect([...f.messages.values()][0]).toMatchObject({ conversationId: "conversation", replyToMessageId: invocation.messageId, metadata: { sessionId: receipt.sessionId } });
    expect(f.flights.get(invocation.id)?.state).toBe("completed");
  });
  test("timeout and restart preserve uncertainty without duplicate provider send", async () => {
    const f = fixture(); const { invocation, endpoint } = await f.setup();
    f.fail(new ExternalSessionTransportError(true, "devin_transport_unconfirmed"));
    await f.service.dispatch(invocation, endpoint);
    const restarted = new BrokerExternalSessionService(f.options);
    await restarted.dispatch(invocation, endpoint);
    expect(f.sent).toHaveLength(1);
    expect([...f.deliveries.values()][0]?.metadata?.phase).toBe("unconfirmed");
    expect(f.flights.get(invocation.id)?.state).toBe("waiting");
    expect(restarted.hasPendingInvocation(invocation.id)).toBe(true);
    await restarted.reply({ ...f.address(), ownerId: "remote-owner", body: "Received despite timeout." });
    expect(f.flights.get(invocation.id)?.state).toBe("completed");
  });
  test("startup reconciles a crash between attempt persistence and flight update without sending", async () => {
    const f = fixture(); const { invocation, endpoint } = await f.setup();
    await f.service.dispatch(invocation, endpoint);
    const receipt = [...f.deliveries.values()][0]!;
    f.deliveries.set(receipt.id, { ...receipt, status: "sent", metadata: { ...receipt.metadata, phase: "sending" } });
    f.flights.set(invocation.id, { ...f.flights.get(invocation.id)!, state: "queued" });
    await new BrokerExternalSessionService(f.options).recover([invocation]);
    expect(f.flights.get(invocation.id)?.state).toBe("waiting");
    expect(f.sent).toHaveLength(1);
    expect(f.flights.get(invocation.id)?.summary).toContain("unconfirmed");
  });
  test("rejected delivery fails and does not retry; wake opt-out is honored", async () => {
    const f = fixture(); const { invocation, endpoint } = await f.setup();
    await expect(f.service.dispatch({ ...invocation, ensureAwake: false }, endpoint)).rejects.toThrow("suspended");
    expect(f.sent).toHaveLength(0);
    f.fail(new ExternalSessionTransportError(false, "devin_http_403"));
    await f.service.dispatch(invocation, endpoint);
    expect(f.flights.get(invocation.id)?.state).toBe("failed");
    await f.service.dispatch(invocation, endpoint);
    expect(f.sent).toHaveLength(1);
  });
  test("cancelled flights and incompatible harness overrides never reach the provider", async () => {
    const f = fixture(); const { invocation, endpoint } = await f.setup();
    await expect(f.service.dispatch({ ...invocation, execution: { ...invocation.execution, harness: "claude" } }, endpoint)).rejects.toThrow("harness_mismatch");
    f.flights.set(invocation.id, { ...f.flights.get(invocation.id)!, state: "cancelled" });
    await f.service.dispatch(invocation, endpoint);
    expect(f.sent).toHaveLength(0);
    expect(f.deliveries.size).toBe(0);
  });
  for (const outcome of ["ack", "error"] as const) {
    test(`late provider ${outcome} cannot overwrite a completed reply`, async () => {
      const f = fixture(); const { invocation, endpoint } = await f.setup();
      if (outcome === "error") f.fail(new ExternalSessionTransportError(true, "timeout"));
      const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
      const mutate = f.options.mutateDelivery; let first = true;
      f.options.mutateDelivery = async (id, update) => {
        if (first) { first = false; entered.resolve(); await release.promise; }
        return mutate(id, update);
      };
      const dispatch = f.service.dispatch(invocation, endpoint);
      await entered.promise;
      const args = { ...f.address(), ownerId: "remote-owner", body: "Already replied." };
      await f.service.reply(args);
      release.resolve(); await dispatch;
      expect([...f.deliveries.values()][0]?.status).toBe("completed");
      expect([...f.deliveries.values()][0]?.metadata?.replyBodyHash).toBeTruthy();
      expect((await f.service.reply(args)).duplicate).toBe(true);
    });
  }
  test("reply interrupted after real message persistence retries without duplicating or replacing it", async () => {
    const f = fixture(); const { invocation, endpoint } = await f.setup();
    await f.service.dispatch(invocation, endpoint);
    let writes = 0; let interrupt = true;
    const messageService = new BrokerMessageService({
      nodeId: "local", systemActorId: "system", createId: () => "unused",
      runtime: { peek: () => ({ messages: Object.fromEntries(f.messages) }), snapshot: () => ({ invocations: Object.fromEntries(f.invocations) }),
        conversation: () => undefined, agent: f.options.agent, flightForInvocation: f.options.flight },
      mesh: { authorityNodeForConversation: () => null, forwardConversationMessageToAuthority: async () => ({ forwarded: true }), forwardPeerBrokerDeliveries: async () => ({ forwarded: [], failed: [] }) },
      recordMessage: async (message) => { writes++; f.messages.set(message.id, message); return { deliveries: [], entries: [] }; },
      applyProjectedEntries: async () => {}, reconcileStaleLocalDeliveries: async () => {}, persistFlight: f.options.recordFlight,
      persistAcceptedReply: async () => { throw new Error("local reply must not checkpoint remote acceptance"); },
      activeLocalEndpointForAgent: () => undefined,
      authorizeReplyCompletion: (inv, message) => f.service.authorizesReplyCompletion(inv, message),
    });
    f.options.postMessage = async (message) => {
      await messageService.postConversationMessage(message);
      if (interrupt) { interrupt = false; throw new Error("crash after message commit"); }
    };
    const args = { ...f.address(), ownerId: "remote-owner", body: "Durable reply." };
    await expect(f.service.reply(args)).rejects.toThrow("crash after message commit");
    await new BrokerExternalSessionService(f.options).reply(args);
    expect(writes).toBe(1);
    expect(f.messages.size).toBe(1);
    expect([...f.deliveries.values()][0]?.status).toBe("completed");
    expect(f.flights.get(invocation.id)?.output).toBe("Durable reply.");
    expect(f.service.authorizesReplyCompletion(invocation, { ...[...f.messages.values()][0]!, id: "unrelated-message" })).toBe(false);
  });
  test("a removed connection cannot stop recovery of later persisted attempts", async () => {
    const f = fixture(); const first = await f.setup("inv-first"); const second = await f.setup("inv-second");
    await f.service.dispatch(second.invocation, second.endpoint);
    f.flights.set(second.invocation.id, { ...f.flights.get(second.invocation.id)!, state: "queued" });
    f.flights.set(first.invocation.id, { ...f.flights.get(first.invocation.id)!, state: "completed" });
    first.invocation.requesterId = "remote-owner";
    first.invocation.metadata = { returnAddress: { sessionId: first.receipt.sessionId } };
    f.options.connections = () => [];
    expect(await new BrokerExternalSessionService(f.options).recover([first.invocation, second.invocation])).toEqual([first.invocation.id]);
    expect(f.flights.get(second.invocation.id)?.state).toBe("waiting");
    expect(f.sent).toHaveLength(1);
  });
  test("return notifications only reach the requester's exact owned session and survive restart", async () => {
    const f = fixture(); const { invocation, receipt } = await f.setup();
    const request = { ...invocation, requesterId: "remote-owner", metadata: { returnAddress: { sessionId: receipt.sessionId } } };
    const flight: FlightRecord = { ...f.flights.get(invocation.id)!, state: "completed", output: "Reviewed." };
    await f.service.forwardResult({ ...request, requesterId: "different-owner" }, flight);
    expect(f.sent).toHaveLength(0);
    await f.service.forwardResult(request, flight);
    await new BrokerExternalSessionService(f.options).forwardResult(request, flight);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toContain("Reviewed.");
    expect([...f.deliveries.values()][0]?.metadata?.resultNotification).toBe(true);
  });
});

describe("MCP mailbox boundaries", () => {
  test("pagination is stable, owner and endpoint isolate acknowledgements, results cannot be replied to", async () => {
    const f = fixture();
    const a = await f.service.attach({ ownerId: "remote-owner", nativeSessionId: "a" });
    const b = await f.service.attach({ ownerId: "remote-owner", nativeSessionId: "b" });
    for (let i = 0; i < 4; i++) f.deliveries.set(`mail-${i}`, {
      id: `mail-${i}`, targetId: "remote-owner", targetKind: "agent", transport: "mcp_poll", reason: "thread_reply", policy: "durable", status: "accepted",
      metadata: { externalSession: true, endpointId: a.endpointId, attemptedAt: 100, mailboxBody: `Result ${i}`, resultNotification: true },
    });
    const page = await f.service.poll({ ownerId: "remote-owner", sessionId: a.sessionId!, limit: 2 });
    expect(page.items.map((i) => i.deliveryId)).toEqual(["mail-0", "mail-1"]);
    const next = await f.service.poll({ ownerId: "remote-owner", sessionId: a.sessionId!, limit: 2, cursor: page.nextCursor! });
    expect(next.items.map((i) => i.deliveryId)).toEqual(["mail-2", "mail-3"]);
    expect(next.nextCursor).toBeNull();
    expect((await f.service.poll({ ownerId: "remote-owner", sessionId: b.sessionId! })).items).toHaveLength(0);
    await expect(f.service.acknowledge({ ownerId: "intruder", sessionId: a.sessionId!, deliveryId: "mail-0" })).rejects.toThrow("not_found");
    await expect(f.service.acknowledge({ ownerId: "remote-owner", sessionId: b.sessionId!, deliveryId: "mail-0" })).rejects.toThrow("invalid");
    await expect(f.service.reply({ ownerId: "remote-owner", sessionId: a.sessionId!, deliveryId: "mail-0", body: "Forged reply" })).rejects.toThrow("invalid");
    await f.service.acknowledge({ ownerId: "remote-owner", sessionId: a.sessionId!, deliveryId: "mail-0" });
    expect((await f.service.poll({ ownerId: "remote-owner", sessionId: a.sessionId! })).items).toHaveLength(3);
  });
  test("concurrent enqueues cannot overrun the mailbox bound", async () => {
    const f = fixture();
    const a = await f.service.attach({ ownerId: "remote-owner", nativeSessionId: "a" });
    for (let i = 0; i < 999; i++) f.deliveries.set(`pending-${i}`, {
      id: `pending-${i}`, targetId: "remote-owner", targetKind: "agent", transport: "mcp_poll", reason: "thread_reply", policy: "durable", status: "accepted",
      metadata: { externalSession: true, endpointId: a.endpointId },
    });
    const jobs = await Promise.all([f.setup("capacity-a"), f.setup("capacity-b")]);
    const results = await Promise.allSettled(jobs.map(({ invocation }) => {
      invocation.requesterId = "remote-owner";
      invocation.metadata = { returnAddress: { sessionId: a.sessionId } };
      return f.service.forwardResult(invocation, { ...f.flights.get(invocation.id)!, state: "completed", output: "Done" });
    }));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect([...f.deliveries.values()].filter((d) => d.metadata?.endpointId === a.endpointId)).toHaveLength(1000);
  });
});

test("cancelled mailbox work is never returned after cancellation, including restart recovery", async () => {
  const f = fixture(); const a = await f.service.attach({ ownerId: "remote-owner", nativeSessionId: "cancel-me" });
  const { invocation } = await f.setup("cancel-mailbox");
  invocation.targetAgentId = "remote-owner"; invocation.execution = { targetSessionId: a.sessionId! };
  await f.service.dispatch(invocation, f.service.endpointFor(invocation)!);
  const work = (await f.service.poll({ ownerId: "remote-owner", sessionId: a.sessionId! })).items[0]!;
  f.flights.set(invocation.id, { ...f.flights.get(invocation.id)!, state: "cancelled" });
  expect((await f.service.poll({ ownerId: "remote-owner", sessionId: a.sessionId! })).items).toHaveLength(0);
  const restarted = new BrokerExternalSessionService(f.options);
  await restarted.recover([invocation]);
  expect(f.deliveries.get(work.deliveryId)?.status).toBe("cancelled");
  expect((await restarted.acknowledge({ ownerId: "remote-owner", sessionId: a.sessionId!, deliveryId: work.deliveryId })).status).toBe("cancelled");
  expect((await restarted.poll({ ownerId: "remote-owner", sessionId: a.sessionId! })).items).toHaveLength(0);
  await expect(restarted.reply({ ownerId: "remote-owner", sessionId: a.sessionId!, deliveryId: work.deliveryId, body: "Too late" })).rejects.toThrow("terminal");
});

test("poll backfills a result after capacity frees without restarting", async () => {
  const f = fixture(); const a = await f.service.attach({ ownerId: "operator", nativeSessionId: "return-here" });
  for (let i = 0; i < 1000; i++) f.deliveries.set(`full-${i}`, {
    id: `full-${i}`, targetId: "operator", targetKind: "agent", transport: "mcp_poll", reason: "thread_reply", policy: "durable", status: "accepted",
    metadata: { externalSession: true, endpointId: a.endpointId, resultNotification: true, attemptedAt: 1 },
  });
  const { invocation } = await f.setup("overflow-result");
  invocation.metadata = { returnAddress: { sessionId: a.sessionId } };
  const flight = { ...f.flights.get(invocation.id)!, state: "completed" as const, output: "Recovered result" }; f.flights.set(invocation.id, flight);
  await expect(f.service.forwardResult(invocation, flight)).rejects.toThrow("mailbox_full");
  await f.service.acknowledge({ ownerId: "operator", sessionId: a.sessionId!, deliveryId: "full-0" });
  await f.service.poll({ ownerId: "operator", sessionId: a.sessionId! });
  const notifications = [...f.deliveries.values()].filter((d) => d.invocationId === invocation.id);
  expect(notifications).toHaveLength(1);
  expect(notifications[0]?.metadata?.mailboxBody).toContain("Recovered result");
  await f.service.poll({ ownerId: "operator", sessionId: a.sessionId! });
  expect([...f.deliveries.values()].filter((d) => d.invocationId === invocation.id)).toHaveLength(1);
});

test("mailbox attachment rechecks authority after waiting behind another attachment", async () => {
  const f = fixture();
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const service = new BrokerExternalSessionService({ ...f.options, persistActor: async () => { entered(); await pending; } });
  const first = service.attach({ ownerId: "guest", nativeSessionId: "first" });
  await started;
  let active = true;
  const second = service.attach({ ownerId: "guest", nativeSessionId: "second", authorize: () => { if (!active) throw new Error("grant_inactive"); } });
  const rejected = second.then(() => "unexpected success", (error: Error) => error.message);
  active = false;
  release();
  await first;
  expect(await rejected).toBe("grant_inactive");
  expect(f.endpoints.size).toBe(1);
});
