import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { namedChannelNaturalKey, type AgentEndpoint, type FlightRecord, type ScoutDeliverResponse } from "@openscout/protocol";

import {
  createBrokerDaemonTestHarness,
  type TestConversationIdentity,
} from "./test-helpers/broker-daemon-harness.test";

const broker = createBrokerDaemonTestHarness();
type ContinuationReceipt = Extract<ScoutDeliverResponse, { kind: "delivery" }>;
type ContinuationNativeEvent = {
  event: string;
  pid: number;
  sessionId?: string;
  marker?: string;
  overlap?: boolean;
  duringHeldIdle?: boolean;
};

describe("broker daemon delivery routing", () => {
  test("accepts exact continuation while completed flight awaits endpoint idle persistence", async () => {
    const home = mkdtempSync(join(tmpdir(), "scout-continuation-gap-"));
    const gate = join(home, "idle-held");
    const release = join(home, "release-idle");
    const nativeLog = join(home, "native.jsonl");
    const fixture = join(home, "fixture-acp");
    const preload = join(home, "hold-idle.ts");
    mkdirSync(join(home, "project"));
    writeFileSync(nativeLog, "");
    writeFileSync(fixture, `#!/usr/bin/env bun
  import {appendFileSync,existsSync} from "node:fs";
  import {createInterface} from "node:readline";
  let active=0;
  const nativeSessionId="native-continuation-"+process.pid;
  const log=x=>appendFileSync(${JSON.stringify(nativeLog)},JSON.stringify({pid:process.pid,...x})+"\\n");
  log({event:"process:start"});
  createInterface({input:process.stdin}).on("line",async line=>{
   const {id,method,params={}}=JSON.parse(line);
   const reply=result=>console.log(JSON.stringify({jsonrpc:"2.0",id,result}));
   if(method==="initialize"){log({event:method});return reply({protocolVersion:1,agentCapabilities:{sessionCapabilities:{resume:{}}},agentInfo:{name:"fixture",version:"1"},authMethods:[{id:"xai.api_key"}]});}
   if(method==="session/new"){log({event:method,sessionId:nativeSessionId});return reply({sessionId:nativeSessionId,models:{currentModelId:"grok-4.6"}});}
   if(method==="session/resume")log({event:method,sessionId:params.sessionId});
   if(method!=="session/prompt")return reply({});
   const text=params.prompt.map(part=>part.text??"").join("\\n");
   const marker=text.includes("continuation-second")?"second":"first";
   log({event:"prompt",sessionId:params.sessionId,marker,overlap:active++>0,duringHeldIdle:existsSync(${JSON.stringify(gate)})&&!existsSync(${JSON.stringify(release)})});
   await Bun.sleep(30);
   console.log(JSON.stringify({jsonrpc:"2.0",method:"session/update",params:{sessionId:params.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"reply-"+marker}}}}));
   active--;log({event:"completed",sessionId:params.sessionId,marker});reply({stopReason:"end_turn"});
  });
  `);
    chmodSync(fixture, 0o700);
    // Delay only this test's first endpoint-idle write, after its completed flight
    // is already visible. There is no production hook, delay or timing guess.
    writeFileSync(preload, `
  import {existsSync,writeFileSync} from "node:fs";
  import {BrokerLocalInvocationService} from ${JSON.stringify(join(import.meta.dir, "broker-local-invocation-service.ts"))};
  const execute=BrokerLocalInvocationService.prototype.execute;
  let installed=false,held=false;
  BrokerLocalInvocationService.prototype.execute=function(invocation){
   if(!installed){
    installed=true;
    const persist=this.options.persistEndpoint;
    this.options.persistEndpoint=async endpoint=>{
     if(!held&&endpoint.state==="idle"&&this.options.runtime.flightForInvocation(endpoint.metadata?.lastInvocationId)?.state==="completed"){
      held=true;writeFileSync(${JSON.stringify(gate)},"held");
      const deadline=Date.now()+10000;
      while(!existsSync(${JSON.stringify(release)})){
       if(Date.now()>deadline)throw new Error("test idle gate expired");
       await Bun.sleep(5);
      }
     }
     return persist(endpoint);
    };
   }
   return execute.call(this,invocation);
  };
  `);
    broker.writeRelayAgentRegistry(join(home, "support"), {});
    const harness = await broker.startBroker({ controlHome: home, preload, env: {
      HOME: home, OPENSCOUT_HOME: join(home, "scout-home"), GROK_CLI_BIN: fixture,
      SCOUT_XAI_API_KEY: "owned-test-fixture", OPENSCOUT_CORE_AGENTS: "",
      OPENSCOUT_LOCAL_AGENT_SYNC_INTERVAL_MS: "0", OPENSCOUT_RUNTIME_CATALOG_REFRESH_MS: "86400000",
    } });
    await broker.seedBasicConversation(harness);
    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "fixture-agent", kind: "agent", definitionId: "fixture-agent", displayName: "Fixture Agent",
      agentClass: "general", capabilities: ["chat", "invoke"], wakePolicy: "on_demand",
      homeNodeId: harness.nodeId, authorityNodeId: harness.nodeId, advertiseScope: "local",
    });
    await broker.postJson(harness.baseUrl, "/v1/endpoints", {
      id: "fixture-endpoint", agentId: "fixture-agent", nodeId: harness.nodeId, harness: "grok",
      transport: "grok_acp", state: "idle", sessionId: "fixture-session", cwd: join(home, "project"),
      projectRoot: join(home, "project"), metadata: { model: "grok-4.6" },
    });
    const payload = (key: string) => ({ requestId: key,
      caller: { actorId: "operator", nodeId: harness.nodeId, currentDirectory: join(home, "project") },
      target: { kind: "session_id", sessionId: "fixture-session" }, intent: "consult", ensureAwake: true,
      execution: { session: "existing", targetSessionId: "fixture-session" }, body: key,
    });
    try {
      const first = await broker.postJson<ContinuationReceipt>(harness.baseUrl, "/v1/deliver", payload("continuation-first"));
      expect(first.accepted).toBe(true);
      await broker.waitFor(async () => existsSync(gate), value => value, { intervalMs: 10, attempts: 500 });
      expect(existsSync(gate)).toBe(true);
      const held = await broker.getJson<{ endpoints: Record<string, AgentEndpoint>; flights: Record<string, FlightRecord> }>(harness.baseUrl, "/v1/snapshot");
      expect(held.flights[first.flight!.id]?.state).toBe("completed");
      expect(held.endpoints["fixture-endpoint"]?.state).toBe("active");

      const second = await broker.postJson<ContinuationReceipt>(harness.baseUrl, "/v1/deliver", payload("continuation-second"));
      expect(second.accepted).toBe(true);
      expect(second.targetSessionId).toBe("fixture-session");
      expect(second.flight?.state).toBe("queued");
      const replay = await broker.postJson<ContinuationReceipt>(harness.baseUrl, "/v1/deliver", payload("continuation-second"));
      expect(replay.flight?.id).toBe(second.flight?.id);
      expect(readFileSync(nativeLog, "utf8").trim().split("\n").map(line => JSON.parse(line) as ContinuationNativeEvent)
        .filter(event => event.event === "prompt").map(event => event.marker)).toEqual(["first"]);

      writeFileSync(release, "released");
      const done = await broker.waitFor(() => broker.getJson<{ flight: FlightRecord }>(harness.baseUrl,
        "/v1/invocations/" + second.flight!.invocationId), value => value.flight.state === "completed", { intervalMs: 10 });
      expect(done.flight.state).toBe("completed");
      expect(done.flight.output).toBe("reply-second");
      const events = readFileSync(nativeLog, "utf8").trim().split("\n").map(line => JSON.parse(line) as ContinuationNativeEvent);
      const prompts = events.filter(event => event.event === "prompt");
      expect(prompts.map(event => event.marker)).toEqual(["first", "second"]);
      expect(events.filter(event => event.event === "process:start")).toHaveLength(1);
      expect(events.filter(event => event.event === "initialize")).toHaveLength(1);
      const sessions = events.filter(event => event.event === "session/new");
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.sessionId).toBe(`native-continuation-${sessions[0]!.pid}`);
      expect(events.filter(event => event.event === "session/resume")).toHaveLength(0);
      expect(new Set(events.map(event => event.pid)).size).toBe(1);
      expect(prompts.map(event => event.sessionId)).toEqual([sessions[0]!.sessionId, sessions[0]!.sessionId]);
      expect(events.some(event => event.overlap || event.duringHeldIdle)).toBe(false);
    } finally {
      writeFileSync(release, "released");
    }
  }, 20_000);

  test("accepts broker-owned delivery for a known receiving target", async () => {
    const harness = await broker.startBroker();

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "ghost",
      kind: "agent",
      definitionId: "ghost",
      displayName: "Ghost",
      handle: "ghost",
      labels: ["test"],
      selector: "@ghost",
      defaultSelector: "@ghost",
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });

    await broker.seedHangingReceiver(harness, "ghost");

    const response = await broker.postJson<{
      kind: string;
      accepted: boolean;
      routeKind: string;
      receipt?: {
        requestId: string;
        requesterId: string;
        requesterNodeId: string;
        targetAgentId?: string;
        targetLabel?: string;
        bindingRef?: string;
        messageId: string;
        flightId?: string;
      };
      targetAgentId?: string;
      bindingRef?: string;
      conversation?: TestConversationIdentity & { kind: string };
      message?: { id: string; conversationId: string; actorId: string; body: string };
      flight?: { id: string; state: string; targetAgentId: string };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-test-1",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "agent_label",
        label: "@ghost",
      },
      body: "@ghost are you there?",
      intent: "consult",
      createdAt: Date.now(),
    });

    expect(response.kind).toBe("delivery");
    expect(response.accepted).toBe(true);
    expect(response.routeKind).toBe("dm");
    expect(response.targetAgentId).toBe("ghost");
    expect(response.receipt?.requestId).toBe("deliver-test-1");
    expect(response.receipt?.requesterId).toBe("operator");
    expect(response.receipt?.requesterNodeId).toBe(harness.nodeId);
    expect(response.receipt?.targetAgentId).toBe("ghost");
    expect(response.receipt?.targetLabel).toBe("@ghost");
    expect(response.conversation?.kind).toBe("direct");
    expect(response.message?.conversationId).toBe(response.conversation?.id);
    expect(response.receipt?.messageId).toBe(response.message?.id);
    expect(response.flight?.state).toBe("queued");
    expect(response.flight?.targetAgentId).toBe("ghost");
    expect(response.receipt?.flightId).toBe(response.flight?.id);
    expect(response.bindingRef).toBe(response.flight?.id.slice(-8));
    expect(response.receipt?.bindingRef).toBe(response.bindingRef);

    const followup = await broker.postJson<{
      kind: string;
      accepted: boolean;
      targetAgentId?: string;
      bindingRef?: string;
      receipt?: { targetLabel?: string; bindingRef?: string };
      flight?: { targetAgentId: string };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-test-ref",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "binding_ref",
        ref: response.bindingRef,
      },
      body: "continue from the bound session",
      intent: "consult",
      createdAt: Date.now(),
    });

    expect(followup.kind).toBe("delivery");
    expect(followup.accepted).toBe(true);
    expect(followup.targetAgentId).toBe("ghost");
    expect(followup.receipt?.targetLabel).toBe("@ghost");
    expect(followup.receipt?.bindingRef).toBe(followup.bindingRef);
  }, 15_000);

  test("replays broker-owned work and reconciles its lost executor after restart", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const firstHarness = await broker.startBroker({ controlHome });

    await broker.postJson(firstHarness.baseUrl, "/v1/agents", {
      id: "durable-ghost",
      kind: "agent",
      definitionId: "durable-ghost",
      displayName: "Durable Ghost",
      handle: "durable-ghost",
      labels: ["test"],
      selector: "@durable-ghost",
      defaultSelector: "@durable-ghost",
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: firstHarness.nodeId,
      authorityNodeId: firstHarness.nodeId,
      advertiseScope: "local",
    });

    await broker.seedHangingReceiver(firstHarness, "durable-ghost");

    const response = await broker.postJson<{
      kind: string;
      accepted: boolean;
      message?: { id: string; conversationId: string; body: string };
      flight?: { id: string; invocationId: string; state: string; targetAgentId: string };
      receipt?: { messageId: string; flightId?: string };
    }>(firstHarness.baseUrl, "/v1/deliver", {
      id: "deliver-restart-consult",
      caller: {
        actorId: "operator",
        nodeId: firstHarness.nodeId,
      },
      target: {
        kind: "agent_label",
        label: "@durable-ghost",
      },
      body: "Survive a broker restart.",
      intent: "consult",
      createdAt: Date.now(),
    });

    expect(response.kind).toBe("delivery");
    expect(response.accepted).toBe(true);
    expect(response.message?.id).toBe(response.receipt?.messageId);
    expect(response.flight?.id).toBe(response.receipt?.flightId);
    expect(response.flight?.state).toBe("queued");

    // The fake executor is real and asynchronous. Capture a proven dispatched
    // state before restart rather than racing its pending -> running transition.
    await broker.waitFor(
      () => broker.getJson<{ flight: { state: string } }>(firstHarness.baseUrl, `/v1/invocations/${response.flight?.invocationId}`),
      snapshot => snapshot.flight?.state === "running",
    );

    firstHarness.child.kill();
    await firstHarness.child.exited.catch(() => {});
    broker.harnesses.delete(firstHarness);

    const secondHarness = await broker.startBroker({ controlHome });

    const messages = await broker.getJson<Array<{ id: string; body: string; conversationId: string }>>(
      secondHarness.baseUrl,
      `/v1/messages?conversationId=${encodeURIComponent(response.message?.conversationId ?? "")}`,
    );
    expect(messages).toContainEqual(expect.objectContaining({
      id: response.message?.id,
      body: "Survive a broker restart.",
    }));

    const invocationSnapshot = await broker.waitFor(() => broker.getJson<{
      invocation: { id: string; targetAgentId: string } | null;
      flight: { id: string; invocationId: string; targetAgentId: string; state: string; error?: string } | null;
    }>(secondHarness.baseUrl, `/v1/invocations/${response.flight?.invocationId}`),
      snapshot => snapshot.flight?.state === "failed");

    expect(invocationSnapshot.invocation).toEqual(expect.objectContaining({
      id: response.flight?.invocationId,
      targetAgentId: "durable-ghost",
    }));
    expect(invocationSnapshot.flight).toEqual(expect.objectContaining({
      id: response.flight?.id,
      invocationId: response.flight?.invocationId,
      targetAgentId: "durable-ghost",
      state: "failed",
    }));
    expect(invocationSnapshot.flight?.error).toContain("without a live broker task");

    const lifecycle = await broker.getJson<{
      invocationId: string;
      flightId: string;
      targetAgentId: string;
    }>(secondHarness.baseUrl, `/v1/invocations/${response.flight?.invocationId}/lifecycle`);
    expect(lifecycle).toEqual(expect.objectContaining({
      invocationId: response.flight?.invocationId,
      flightId: response.flight?.id,
      targetAgentId: "durable-ghost",
    }));

    // The flight commits before reconciliation writes its linked delivery.
    // Wait for that durable outcome, not just the earlier flight transition.
    const deliveries = await broker.waitFor(
      () => broker.getJson<Array<{
        messageId: string; targetId: string; status: string;
        metadata?: { flightId?: string; flightState?: string; failureDetail?: string };
      }>>(secondHarness.baseUrl,
        `/v1/deliveries?messageId=${encodeURIComponent(response.message?.id ?? "")}&targetId=durable-ghost`),
      rows => rows.some(delivery => delivery.messageId === response.message?.id
        && delivery.targetId === "durable-ghost" && delivery.status === "failed"
        && delivery.metadata?.flightId === response.flight?.id
        && delivery.metadata?.flightState === "failed"
        && delivery.metadata?.failureDetail?.includes("without a live broker task")),
    );
    expect(deliveries).toContainEqual(expect.objectContaining({
      messageId: response.message?.id,
      targetId: "durable-ghost",
      status: "failed",
    }));
  }, 20_000);

  test("routes operator and message refs as replies instead of failed deliveries", async () => {
    const harness = await broker.startBroker();

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "designer",
      kind: "agent",
      definitionId: "designer",
      displayName: "Designer",
      handle: "designer",
      labels: ["test"],
      selector: "@designer",
      defaultSelector: "@designer",
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });

    await broker.seedHangingReceiver(harness, "designer");

    const request = await broker.postJson<{
      kind: string;
      accepted: boolean;
      conversation?: { id: string; kind: string };
      message?: {
        id: string;
        conversationId: string;
        actorId: string;
        metadata?: { returnAddress?: { sessionId?: string } };
      };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-operator-request",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "agent_label",
        label: "@designer",
      },
      body: "please review the rail",
      intent: "tell",
      ensureAwake: false,
      replyToSessionId: "codex-thread-123",
      createdAt: Date.now(),
    });

    expect(request.kind).toBe("delivery");
    expect(request.accepted).toBe(true);
    expect(request.message?.actorId).toBe("operator");
    expect(request.message?.metadata?.returnAddress?.sessionId).toBe(
      "codex-thread-123",
    );

    const refReply = await broker.postJson<{
      kind: string;
      accepted: boolean;
      conversation?: { id: string; kind: string };
      message?: { id: string; conversationId: string; actorId: string; replyToMessageId?: string };
      receipt?: { targetLabel?: string };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-ref-reply",
      caller: {
        actorId: "designer",
        nodeId: harness.nodeId,
      },
      targetLabel: `ref:${request.message!.id}`,
      body: "review complete",
      intent: "tell",
      createdAt: Date.now(),
    });

    expect(refReply.kind).toBe("delivery");
    expect(refReply.accepted).toBe(true);
    expect(refReply.conversation?.id).toBe(request.conversation?.id);
    expect(refReply.message?.replyToMessageId).toBe(request.message?.id);
    expect(refReply.message?.actorId).toBe("designer");
    expect(refReply.receipt?.targetLabel).toBe(`ref:${request.message!.id}`);

    const operatorReply = await broker.postJson<{
      kind: string;
      accepted: boolean;
      targetAgentId?: string;
      conversation?: { id: string; kind: string };
      message?: { actorId: string; audience?: { notify?: string[]; reason?: string } };
      receipt?: { targetAgentId?: string; targetLabel?: string };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-operator-direct",
      caller: {
        actorId: "designer",
        nodeId: harness.nodeId,
      },
      targetLabel: "@operator",
      body: "thread reply fallback",
      intent: "tell",
      createdAt: Date.now(),
    });

    expect(operatorReply.kind).toBe("delivery");
    expect(operatorReply.accepted).toBe(true);
    expect(operatorReply.targetAgentId).toBe("operator");
    expect(operatorReply.receipt?.targetAgentId).toBe("operator");
    expect(operatorReply.receipt?.targetLabel).toBe("@operator");
    expect(operatorReply.message?.audience?.notify).toEqual(["operator"]);

    const snapshot = await broker.getJson<{
      messages: Record<string, { body: string; metadata?: Record<string, unknown> }>;
    }>(harness.baseUrl, "/v1/snapshot");
    expect(Object.values(snapshot.messages).some((message) => message.body.includes("Scout could not route"))).toBe(false);
  }, 15_000);

  test("dispatches a direct tell without requiring the sender to request wake", async () => {
    const harness = await broker.startBroker();

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "hudson",
      kind: "agent",
      definitionId: "hudson",
      displayName: "Hudson",
      handle: "hudson",
      labels: ["test"],
      selector: "@hudson",
      defaultSelector: "@hudson",
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });

    await broker.seedHangingReceiver(harness, "hudson");

    const response = await broker.postJson<{
      kind: string;
      accepted: boolean;
      routeKind: string;
      receipt?: {
        messageId: string;
        flightId?: string;
      };
      message?: { id: string; conversationId: string; body: string };
      flight?: { id: string; invocationId: string; state: string; targetAgentId: string };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-tell-1",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "agent_label",
        label: "@hudson",
      },
      body: "Can you take a look at this when you get a turn?",
      intent: "tell",
      createdAt: Date.now(),
    });

    expect(response.kind).toBe("delivery");
    expect(response.accepted).toBe(true);
    expect(response.routeKind).toBe("dm");
    expect(response.message?.body).toBe("Can you take a look at this when you get a turn?");
    expect(response.flight?.state).toBe("queued");
    expect(response.flight?.targetAgentId).toBe("hudson");
    expect(response.receipt?.flightId).toBe(response.flight?.id);

    const recorded = await broker.getJson<{
      invocation: {
        id: string;
        action: string;
        ensureAwake: boolean;
        execution?: { session?: string };
        metadata?: Record<string, unknown>;
      } | null;
      flight: { id: string; state: string } | null;
    }>(harness.baseUrl, `/v1/invocations/${response.flight?.invocationId}`);

    expect(recorded.invocation).toEqual(expect.objectContaining({
      action: "wake",
      ensureAwake: true,
      execution: { session: "new" },
      metadata: expect.objectContaining({
        sourceIntent: "direct_message",
      }),
    }));
    expect(recorded.flight?.id).toBe(response.flight?.id);

    const plannedDeliveries = await broker.getJson<Array<{ id: string; status: string; targetId: string }>>(
      harness.baseUrl,
      `/v1/deliveries?messageId=${encodeURIComponent(response.message?.id ?? "")}&targetId=hudson`,
    );
    expect(plannedDeliveries.length).toBeGreaterThan(0);
    expect(plannedDeliveries.every((delivery) => delivery.status === "pending")).toBe(true);

    const completedAt = Date.now();
    await broker.postJson(harness.baseUrl, "/v1/flights", {
      id: response.flight!.id,
      invocationId: response.flight!.invocationId,
      requesterId: "operator",
      targetAgentId: "hudson",
      state: "completed",
      summary: "Hudson received the message.",
      output: "Acknowledged.",
      startedAt: completedAt - 100,
      completedAt,
    });

    const completedDeliveries = await broker.getJson<Array<{ id: string; status: string; metadata?: Record<string, unknown> }>>(
      harness.baseUrl,
      `/v1/deliveries?messageId=${encodeURIComponent(response.message?.id ?? "")}&targetId=hudson&status=completed`,
    );
    expect(completedDeliveries.map((delivery) => delivery.id).sort()).toEqual(
      plannedDeliveries.map((delivery) => delivery.id).sort(),
    );
    expect(completedDeliveries).toContainEqual(expect.objectContaining({
      status: "completed",
      metadata: expect.objectContaining({
        flightId: response.flight?.id,
        invocationId: response.flight?.invocationId,
        flightState: "completed",
      }),
    }));
  }, 15_000);

  test("routes local Scout product labels without exposing the coordinator name", async () => {
    const harness = await broker.startBroker();

    const response = await broker.postJson<{
      kind: string;
      accepted: boolean;
      routeKind: string;
      targetAgentId?: string;
      receipt?: { targetAgentId?: string; targetLabel?: string; conversationId?: string };
      conversation?: TestConversationIdentity & { title: string };
      message?: {
        conversationId?: string;
        mentions?: Array<{ actorId: string; label: string }>;
      };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-scout-local",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "agent_label",
        label: "scout",
      },
      body: "local broker status",
      intent: "tell",
      createdAt: Date.now(),
      messageMetadata: {
        source: "scout-cli",
      },
    });

    expect(response.kind).toBe("delivery");
    expect(response.accepted).toBe(true);
    expect(response.targetAgentId).toBe("scout");
    expect(response.receipt?.targetAgentId).toBe("scout");
    expect(response.receipt?.targetLabel).toBe("Scout");
    broker.expectOpaqueDirectConversation(response.conversation, {
      participantIds: ["operator", "scout"],
    });
    expect(response.conversation?.title).toBe("Scout");
    expect(response.receipt?.conversationId).toBe(response.conversation?.id);
    expect(response.message?.conversationId).toBe(response.conversation?.id);
    expect(response.message?.mentions?.[0]).toEqual({ actorId: "scout", label: "@scout" });

    const legacyAlias = await broker.postJson<{
      kind: string;
      accepted: boolean;
      targetAgentId?: string;
      receipt?: { targetLabel?: string };
    }>(harness.baseUrl, "/v1/deliver", {
      id: "deliver-openscout-legacy-local",
      caller: {
        actorId: "operator",
        nodeId: harness.nodeId,
      },
      target: {
        kind: "agent_label",
        label: "openscout",
      },
      body: "legacy local alias",
      intent: "tell",
      createdAt: Date.now(),
    });

    expect(legacyAlias.kind).toBe("delivery");
    expect(legacyAlias.accepted).toBe(true);
    expect(legacyAlias.targetAgentId).toBe("scout");
    expect(legacyAlias.receipt?.targetLabel).toBe("Scout");
  }, 15_000);

  test("returns a broker question for manual offline targets it cannot wake", async () => {
    const harness = await broker.startBroker();

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "newell",
      kind: "agent",
      definitionId: "newell",
      displayName: "Newell",
      handle: "newell",
      labels: ["test"],
      selector: "@newell",
      defaultSelector: "@newell",
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "manual",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });

    const response = await broker.requestJson(harness.baseUrl, "/v1/deliver", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        id: "deliver-test-2",
        requesterId: "operator",
        requesterNodeId: harness.nodeId,
        targetLabel: "@newell",
        body: "@newell hello",
        intent: "consult",
        createdAt: Date.now(),
      }),
    });

    expect(response.status).toBe(409);
    const body = response.body as {
      kind: string;
      accepted: boolean;
      question?: {
        kind: string;
        askedLabel: string;
        target?: {
          agentId: string;
          reason: string;
        };
      };
    };
    expect(body.kind).toBe("question");
    expect(body.accepted).toBe(false);
    expect(body.question?.kind).toBe("unavailable");
    expect(body.question?.askedLabel).toBe("@newell");
    expect(body.question?.target?.agentId).toBe("newell");
    expect(body.question?.target?.reason).toBe("manual_wake_required");
  }, 15_000);

  test("returns a broker question for superseded direct targets before dispatch", async () => {
    const harness = await broker.startBroker();

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "ranger.main.mini",
      kind: "agent",
      definitionId: "ranger",
      nodeQualifier: "mini",
      workspaceQualifier: "main",
      selector: "@ranger.main.node:mini",
      defaultSelector: "@ranger",
      displayName: "Ranger",
      handle: "ranger",
      labels: ["relay", "project", "agent", "local-agent"],
      metadata: {
        staleLocalRegistration: true,
        projectRoot: "/tmp/openscout",
      },
      agentClass: "general",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });

    const response = await broker.requestJson(harness.baseUrl, "/v1/deliver", {
      method: "POST",
      body: JSON.stringify({
        id: "deliver-test-stale",
        requesterId: "operator",
        requesterNodeId: harness.nodeId,
        targetAgentId: "ranger.main.mini",
        targetLabel: "ranger.main.mini",
        body: "@ranger.main.mini hello",
        intent: "consult",
        createdAt: Date.now(),
      }),
    });

    expect(response.status).toBe(409);
    const body = response.body as {
      kind: string;
      accepted: boolean;
      question?: {
        kind: string;
        target?: {
          agentId?: string;
          reason?: string;
          detail?: string;
        };
      };
    };
    expect(body.kind).toBe("question");
    expect(body.accepted).toBe(false);
    expect(body.question?.kind).toBe("unavailable");
    expect(body.question?.target?.agentId).toBe("ranger.main.mini");
    expect(body.question?.target?.reason).toBe("superseded_registration");
    expect(body.question?.target?.detail).toContain("superseded local registration");

    const snapshot = await broker.getJson<{ flights: Record<string, unknown> }>(
      harness.baseUrl,
      "/v1/snapshot",
    );
    expect(Object.keys(snapshot.flights)).toHaveLength(0);
  }, 15_000);

  test("does not treat superseded endpoints as card-only routing targets", async () => {
    const harness = await broker.startBroker();
    const staleAt = Date.now() - 5_000;

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "ranger.main.mini",
      kind: "agent",
      definitionId: "ranger",
      nodeQualifier: "mini",
      workspaceQualifier: "main",
      selector: "@ranger.main.node:mini",
      defaultSelector: "@ranger",
      displayName: "Ranger",
      handle: "ranger",
      labels: ["relay", "project", "agent", "local-agent"],
      metadata: {
        projectRoot: "/tmp/openscout",
      },
      agentClass: "general",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });
    await broker.postJson(harness.baseUrl, "/v1/endpoints", {
      id: "endpoint-ranger-main",
      agentId: "ranger.main.mini",
      nodeId: harness.nodeId,
      harness: "codex",
      transport: "codex_app_server",
      state: "offline",
      sessionId: "relay-ranger-codex",
      cwd: "/tmp/openscout",
      projectRoot: "/tmp/openscout",
      metadata: {
        staleLocalRegistration: true,
        staleAt,
        replacedByAgentId: "ranger.current.mini",
      },
    });

    const response = await broker.requestJson(harness.baseUrl, "/v1/deliver", {
      method: "POST",
      body: JSON.stringify({
        id: "deliver-test-stale-endpoint",
        requesterId: "operator",
        requesterNodeId: harness.nodeId,
        targetAgentId: "ranger.main.mini",
        targetLabel: "ranger.main.mini",
        body: "@ranger.main.mini hello",
        intent: "consult",
        createdAt: Date.now(),
      }),
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ kind: "question", accepted: false,
      question: { kind: "unavailable", target: { agentId: "ranger.main.mini", reason: "superseded_registration" } } });
    const snapshot = await broker.getJson<{ flights: Record<string, unknown> }>(harness.baseUrl, "/v1/snapshot");
    expect(Object.keys(snapshot.flights)).toHaveLength(0);
  }, 15_000);

  test("returns a broker question when the requested session endpoint is not attachable", async () => {
    const harness = await broker.startBroker();
    const staleAt = Date.now() - 5_000;

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "ranger.main.mini",
      kind: "agent",
      definitionId: "ranger",
      nodeQualifier: "mini",
      workspaceQualifier: "main",
      selector: "@ranger.main.node:mini",
      defaultSelector: "@ranger",
      displayName: "Ranger",
      handle: "ranger",
      labels: ["relay", "project", "agent", "local-agent"],
      metadata: {
        projectRoot: "/tmp/openscout",
      },
      agentClass: "general",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });
    await broker.postJson(harness.baseUrl, "/v1/endpoints", {
      id: "endpoint-ranger-main",
      agentId: "ranger.main.mini",
      nodeId: harness.nodeId,
      harness: "codex",
      transport: "codex_app_server",
      state: "offline",
      sessionId: "relay-ranger-codex",
      cwd: "/tmp/openscout",
      projectRoot: "/tmp/openscout",
      metadata: {
        staleLocalRegistration: true,
        staleAt,
        replacedByAgentId: "ranger.current.mini",
      },
    });

    const response = await broker.requestJson(harness.baseUrl, "/v1/deliver", {
      method: "POST",
      body: JSON.stringify({
        id: "deliver-test-stale-session-endpoint",
        requesterId: "operator",
        requesterNodeId: harness.nodeId,
        target: {
          kind: "session_id",
          sessionId: "relay-ranger-codex",
        },
        body: "continue the exact session",
        intent: "consult",
        createdAt: Date.now(),
      }),
    });

    expect(response.status).toBe(409);
    const body = response.body as {
      kind: string;
      accepted: boolean;
      question?: {
        target?: {
          reason?: string;
          detail?: string;
        };
      };
      remediation?: {
        kind?: string;
      };
    };
    expect(body.kind).toBe("question");
    expect(body.accepted).toBe(false);
    expect(body.question?.target?.reason).toBe("session_reference_not_attachable");
    expect(body.question?.target?.detail).toContain("endpoint endpoint-ranger-main");
    expect(body.question?.target?.detail).toContain("replacement agent is ranger.current.mini");
    expect(body.remediation?.kind).toBe("session_reference_not_attachable");

    const snapshot = await broker.getJson<{ flights: Record<string, unknown> }>(
      harness.baseUrl,
      "/v1/snapshot",
    );
    expect(Object.keys(snapshot.flights)).toHaveLength(0);
  }, 15_000);

  test("reports replacement metadata for superseded direct targets", async () => {
    const harness = await broker.startBroker();

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "ranger.main.mini",
      kind: "agent",
      definitionId: "ranger",
      nodeQualifier: "mini",
      workspaceQualifier: "main",
      selector: "@ranger.main.node:mini",
      defaultSelector: "@ranger",
      displayName: "Ranger",
      handle: "ranger",
      labels: ["relay", "project", "agent", "local-agent"],
      metadata: {
        staleLocalRegistration: true,
        replacedByAgentId: "ranger.codex-vox-getting-started.mini",
        projectRoot: "/tmp/openscout",
      },
      agentClass: "general",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });
    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "ranger.codex-vox-getting-started.mini",
      kind: "agent",
      definitionId: "ranger",
      nodeQualifier: "mini",
      workspaceQualifier: "codex-vox-getting-started",
      selector: "@ranger.codex-vox-getting-started.node:mini",
      defaultSelector: "@ranger",
      displayName: "Ranger",
      handle: "ranger",
      labels: ["relay", "project", "agent", "local-agent"],
      metadata: {
        projectRoot: "/tmp/openscout",
      },
      agentClass: "general",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });

    const response = await broker.requestJson(harness.baseUrl, "/v1/deliver", {
      method: "POST",
      body: JSON.stringify({
        id: "deliver-test-stale-replaced",
        requesterId: "operator",
        requesterNodeId: harness.nodeId,
        targetAgentId: "ranger.main.mini",
        targetLabel: "ranger.main.mini",
        body: "@ranger.main.mini hello",
        intent: "consult",
        createdAt: Date.now(),
      }),
    });

    expect(response.status).toBe(409);
    const body = response.body as {
      kind: string;
      accepted: boolean;
      remediation?: {
        kind?: string;
        detail?: string;
      };
      question?: {
        kind: string;
        target?: {
          agentId?: string;
          reason?: string;
          detail?: string;
        };
      };
    };
    expect(body.kind).toBe("question");
    expect(body.accepted).toBe(false);
    expect(body.question?.kind).toBe("unavailable");
    expect(body.question?.target?.agentId).toBe("ranger.main.mini");
    expect(body.question?.target?.reason).toBe("superseded_registration");
    expect(body.question?.target?.detail).toContain("replacement agent is ranger.codex-vox-getting-started.mini");
    expect(body.remediation?.kind).toBe("use_current_registration");
  }, 15_000);

  test("does not resolve superseded label-only targets", async () => {
    const harness = await broker.startBroker();

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "ranger.main.mini",
      kind: "agent",
      definitionId: "ranger",
      nodeQualifier: "mini",
      workspaceQualifier: "main",
      selector: "@ranger.main.node:mini",
      defaultSelector: "@ranger",
      displayName: "Ranger",
      handle: "ranger",
      labels: ["relay", "project", "agent", "local-agent"],
      metadata: {
        staleLocalRegistration: true,
        projectRoot: "/tmp/openscout",
      },
      agentClass: "general",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });

    const response = await broker.requestJson(harness.baseUrl, "/v1/deliver", {
      method: "POST",
      body: JSON.stringify({
        id: "deliver-test-stale-label",
        requesterId: "operator",
        requesterNodeId: harness.nodeId,
        targetLabel: "@ranger",
        body: "@ranger hello",
        intent: "consult",
        createdAt: Date.now(),
      }),
    });

    expect(response.status).toBe(422);
    const body = response.body as {
      kind: string;
      accepted: boolean;
      reason?: string;
      rejection?: {
        kind?: string;
        askedLabel?: string;
        detail?: string;
      };
    };
    expect(body.kind).toBe("rejected");
    expect(body.accepted).toBe(false);
    expect(body.reason).toBe("unknown_target");
    expect(body.rejection?.kind).toBe("unknown");
    expect(body.rejection?.askedLabel).toBe("@ranger");

    const snapshot = await broker.getJson<{ flights: Record<string, unknown> }>(
      harness.baseUrl,
      "/v1/snapshot",
    );
    expect(Object.keys(snapshot.flights)).toHaveLength(0);
  }, 15_000);

  test("returns a broker question for last-seen-expired peer authority targets", async () => {
    const harness = await broker.startBroker();
    const stalePeerNodeId = "mini-peer";

    await broker.postJson(harness.baseUrl, "/v1/nodes", {
      id: stalePeerNodeId,
      meshId: "openscout",
      name: "Mini Peer",
      advertiseScope: "mesh",
      brokerUrl: "http://100.64.0.2:43110",
      registeredAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
      lastSeenAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
    });

    await broker.postJson(harness.baseUrl, "/v1/agents", {
      id: "arach.mini",
      kind: "agent",
      definitionId: "arach",
      nodeQualifier: "mini",
      selector: "@arach.node:mini",
      defaultSelector: "@arach",
      displayName: "Arach",
      handle: "arach",
      labels: ["relay", "project", "agent", "local-agent"],
      metadata: {
        projectRoot: "/Users/arach",
      },
      agentClass: "general",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "on_demand",
      homeNodeId: stalePeerNodeId,
      authorityNodeId: stalePeerNodeId,
      advertiseScope: "local",
    });

    const response = await broker.requestJson(harness.baseUrl, "/v1/deliver", {
      method: "POST",
      body: JSON.stringify({
        id: "deliver-test-stale-peer",
        requesterId: "codex",
        requesterNodeId: harness.nodeId,
        targetLabel: "@arach",
        body: "@arach local status update",
        intent: "tell",
        createdAt: Date.now(),
      }),
    });

    expect(response.status).toBe(409);
    const body = response.body as {
      kind: string;
      accepted: boolean;
      question?: {
        kind: string;
        askedLabel: string;
        target?: {
          agentId: string;
          reason: string;
          detail: string;
        };
      };
    };
    expect(body.kind).toBe("question");
    expect(body.accepted).toBe(false);
    expect(body.question?.kind).toBe("unavailable");
    expect(body.question?.askedLabel).toBe("@arach");
    expect(body.question?.target?.agentId).toBe("arach.mini");
    expect(body.question?.target?.reason).toBe("unknown");
    expect(body.question?.target?.detail).toContain("peer has not been seen recently");

    const snapshot = await broker.getJson<{ flights: Record<string, unknown> }>(
      harness.baseUrl,
      "/v1/snapshot",
    );
    expect(Object.keys(snapshot.flights)).toHaveLength(0);
  }, 15_000);

  test("rejects unknown delivery targets explicitly", async () => {
    const harness = await broker.startBroker();

    const response = await broker.requestJson(harness.baseUrl, "/v1/deliver", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        id: "deliver-test-unknown",
        requesterId: "operator",
        requesterNodeId: harness.nodeId,
        targetLabel: "@mars",
        body: "@mars finish the job",
        intent: "consult",
        createdAt: Date.now(),
      }),
    });

    expect(response.status).toBe(422);
    const body = response.body as {
      kind: string;
      accepted: boolean;
      reason?: string;
      rejection?: {
        kind: string;
        askedLabel: string;
        detail: string;
      };
    };
    expect(body.kind).toBe("rejected");
    expect(body.accepted).toBe(false);
    expect(body.reason).toBe("unknown_target");
    expect(body.rejection?.kind).toBe("unknown");
    expect(body.rejection?.askedLabel).toBe("@mars");
    expect(body.rejection?.detail).toContain("@mars");
  }, 15_000);
});
