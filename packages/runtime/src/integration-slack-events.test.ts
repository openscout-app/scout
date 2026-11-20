import { afterEach, expect, test } from "bun:test";
import { openControlPlaneSqliteDatabase, type ControlPlaneSqliteTransactionalDatabase } from "./sqlite-adapter.js";
import { migrateControlPlaneDatabaseSchema } from "./control-plane-migrations.js";
import { BrokerIntegrationSetupService } from "./broker-integration-setup.js";
import { IntegrationSlackDeliveryService } from "./integration-slack-delivery.js";
import { IntegrationSlackEvents } from "./integration-slack-events.js";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });
async function fixture() {
  const database = openControlPlaneSqliteDatabase(":memory:", { create: true }) as ControlPlaneSqliteTransactionalDatabase;
  cleanups.push(() => database.close?.()); migrateControlPlaneDatabaseSchema(database);
  let now = 1000;
  const setup = new BrokerIntegrationSetupService({ database, ownerRealmId: "realm", nodeId: "node", now: () => now,
    snapshot: () => ({ agents: { project: { id: "project", definitionId: "project", displayName: "Project", homeNodeId: "node", authorityNodeId: "node", metadata: { projectRoot: "/work/project" } }, second: { id: "second", definitionId: "second", displayName: "Second", homeNodeId: "node", authorityNodeId: "node", metadata: { projectRoot: "/work/second" } } }, endpoints: {} }) as never,
    verifyCredentials: async input => ({ teamId: "T1", appId: input.appId, botId: input.appId === "A1" ? "B1" : "B2", botUserId: input.appId === "A1" ? "UBOT" : "USECOND" }),
  });
  const op = setup.setup({ provider: "slack", mode: "project_agent", projectPath: "/work/project", workspaceId: "T1" }).operation;
  setup.resume(op.id, { action: "confirm_authority", expectedRevision: 1 }); setup.resume(op.id, { action: "register_app", expectedRevision: 2, appId: "A1" });
  await setup.attachCredentials(op.id, { expectedRevision: 3, reference: { backend: "secret_cli", appTokenKey: "APP", botTokenKey: "BOT" }, allowedUserIds: ["U1"], allowedChannelIds: ["C1"] });
  setup.setLifecycle(op.id, { action: "start", expectedRevision: 4 });
  const { grant } = setup.claimWorker(op.id);
  const events = new IntegrationSlackEvents(database, setup, () => now);
  const request = (body: Record<string, unknown>, service = events) => service.request(op.id, { ...body, token: grant.token, generation: grant.generation });
  const envelope = (eventId = "Ev1", ts = "100.1", thread = "100.1") => ({ envelope_id: `envelope-${eventId}`, type: "events_api", payload: { token: "UNUSED_SECRET_SENTINEL", event_id: eventId, team_id: "T1", api_app_id: "A1", event: { type: "app_mention", channel: "C1", user: "U1", ts, thread_ts: thread, text: "<@UBOT> task" } } });
  return { database, setup, events, request, envelope, grant, advance: (ms: number) => { now += ms; }, op };
}
test("persists an admitted event before returning acceptance and strips unused verification secrets", async () => {
  const f = await fixture(); expect(f.request({ action: "receive", envelope: f.envelope() }).accepted).toBe(true);
  const row = f.database.query<{ envelope_json: string }>("SELECT envelope_json FROM integration_slack_events").get()!;
  expect(row.envelope_json).not.toContain("UNUSED_SECRET_SENTINEL");
  const recovered = new IntegrationSlackEvents(f.database, f.setup);
  expect((f.request({ action: "pending" }, recovered).events as unknown[])).toHaveLength(1);
  f.request({ action: "receive", envelope: { ...f.envelope(), envelope_id: "retry-envelope" } });
  expect(f.database.query("SELECT * FROM integration_slack_events").all()).toHaveLength(1);
});
test("persists user-attributed operator posts and rejects bot-only messages", async () => {
  const f = await fixture();
  const operator = f.envelope();
  operator.payload.event.bot_id = "BCLIENT";
  expect(f.request({ action: "receive", envelope: operator }).accepted).toBe(true);

  const botOnly = f.envelope("EvBotOnly");
  botOnly.payload.event.bot_id = "BBOT";
  delete (botOnly.payload.event as Partial<typeof botOnly.payload.event>).user;
  expect(f.request({ action: "receive", envelope: botOnly }).accepted).toBe(false);

  const pending = f.request({ action: "pending" }).events as Array<{ envelope: typeof operator }>;
  expect(pending.map(row => row.envelope.payload.event_id)).toEqual(["Ev1"]);
  expect(pending[0]!.envelope.payload.event).toMatchObject({ user: "U1", bot_id: "BCLIENT" });
});

test("failed earlier work blocks its thread while another thread can progress", async () => {
  const f = await fixture();
  f.request({ action: "receive", envelope: f.envelope() });
  f.request({ action: "receive", envelope: f.envelope("Ev2", "100.2") });
  f.request({ action: "receive", envelope: f.envelope("Ev3", "200.1", "200.1") });
  const ids = () => (f.request({ action: "pending" }).events as Array<{ envelope: { payload: { event_id: string } } }>).map(event => event.envelope.payload.event_id);
  expect(ids()).toEqual(["Ev1", "Ev3"]);
  f.request({ action: "failed", eventId: "Ev1" }); expect(ids()).toEqual(["Ev3"]);
  f.advance(15_001); expect(ids()).toEqual(["Ev1", "Ev3"]);
  f.request({ action: "complete", eventId: "Ev1" }); expect(ids()).toEqual(["Ev2", "Ev3"]);
});
test("ignores out-of-policy events and revokes queue access when paused", async () => {
  const f = await fixture();
  const foreign = f.envelope(); foreign.payload.api_app_id = "AOTHER";
  expect(f.request({ action: "receive", envelope: foreign }).accepted).toBe(false);
  const wrongUser = f.envelope(); wrongUser.payload.event.user = "UOTHER";
  expect(f.request({ action: "receive", envelope: wrongUser }).accepted).toBe(false);
  expect(f.database.query("SELECT * FROM integration_slack_events").all()).toHaveLength(0);
  f.setup.setLifecycle(f.op.id, { action: "pause", expectedRevision: 5 });
  expect(() => f.request({ action: "pending" })).toThrow("revoked");
});

test("recovers result watchers from canonical delivery and progress receipts without bridge caches", async () => {
  const f = await fixture();
  f.request({ action: "receive", envelope: f.envelope() });
  f.request({ action: "progress", eventId: "Ev1", progress: { ts: "101.1", mode: "text", title: "Task" } });
  const event = f.database.query<{ delivery_key: string }>("SELECT delivery_key FROM integration_slack_events").get()!;
  const response = { kind: "delivery", receipt: { conversationId: "conversation", messageId: "message" }, flight: { id: "flight", invocationId: "invocation" } };
  f.database.query("INSERT INTO integration_slack_deliveries (operation_id,event_key,channel_id,thread_ts,user_id,binding_revision,request_json,response_json,updated_at) VALUES (?1,?2,'C1','100.1','U1',1,'{}',?3,1000)")
    .run(f.op.id, event.delivery_key, JSON.stringify(response));
  f.request({ action: "complete", eventId: "Ev1" });
  const recovered = new IntegrationSlackEvents(f.database, f.setup);
  const bindings = f.request({ action: "watches" }, recovered).bindings as Array<Record<string, unknown>>;
  expect(bindings).toHaveLength(1);
  expect(bindings[0]).toMatchObject({ eventId: "Ev1", installationId: f.op.id, responseTs: "101.1", invocationId: "invocation", bindingRef: "message", projectPath: "/work/project" });
  f.request({ action: "result_complete", eventId: "Ev1" }, recovered);
  expect(f.request({ action: "watches" }, recovered).bindings).toEqual([]);
});

 test("multiple known project mentions produce guidance metadata and cannot dispatch", async () => {
  const f = await fixture();
  const second = f.setup.setup({ provider: "slack", mode: "project_agent", projectPath: "/work/second", workspaceId: "T1" }).operation;
  f.setup.resume(second.id, { action: "confirm_authority", expectedRevision: 1 });
  f.setup.resume(second.id, { action: "register_app", expectedRevision: 2, appId: "A2" });
  await f.setup.attachCredentials(second.id, { expectedRevision: 3, reference: { backend: "secret_cli", appTokenKey: "APP2", botTokenKey: "BOT2" }, allowedUserIds: ["U1"], allowedChannelIds: ["C1"] });
  const envelope = f.envelope(); envelope.payload.event.text = "<@UBOT> <@USECOND> fix it";
  expect(f.request({ action: "receive", envelope }).accepted).toBe(true);
  const pending = f.request({ action: "pending" }).events as Array<{ envelope: { routingIssue?: string } }>;
  expect(pending[0].envelope.routingIssue).toBe("ambiguous_project_mentions");
  let accepted = false;
  await expect(new IntegrationSlackDeliveryService(f.database, f.setup).deliver(f.op.id, { generation: f.grant.generation, token: f.grant.token, teamId: "T1", channelId: "C1", threadTs: "100.1", eventTs: "100.1", userId: "U1", userName: "Pilot", title: "Task", prompt: "Task", attachments: [] }, async () => { accepted = true; return {} as never; })).rejects.toThrow("Mention exactly one");
  expect(accepted).toBe(false);
  expect(f.setup.classifyMention(f.op.id, "<@UBOT> ask <@UHUMAN> about this")).toBe("addressed");
  expect(f.setup.classifyMention(f.op.id, "<@USECOND> task")).toBe("not_addressed");
  const single = f.envelope("Ev2", "100.2", "100.2");
  f.request({ action: "receive", envelope: { ...single, routingIssue: "ambiguous_project_mentions" } });
  const saved = f.database.query<{ envelope_json: string }>("SELECT envelope_json FROM integration_slack_events WHERE event_id = 'Ev2'").get()!;
  expect(JSON.parse(saved.envelope_json).routingIssue).toBeUndefined();
});

test("old thread revisions produce an explicit unavailable-thread receipt", async () => {
  const f = await fixture();
  f.database.query("INSERT INTO integration_slack_threads (operation_id,channel_id,thread_ts,binding_revision,binding_ref,updated_at) VALUES (?1,'C1','100.1',0,'old-message',1)").run(f.op.id);
  f.request({ action: "receive", envelope: f.envelope() });
  const pending = f.request({ action: "pending" }).events as Array<{ envelope: { routingIssue?: string } }>;
  expect(pending[0].envelope.routingIssue).toBe("binding_changed");
});

 test("result recovery pages beyond 100 unfinished watches and cycles without starving later results", async () => {
  const f = await fixture();
  for (let n = 1; n <= 101; n++) {
    f.request({ action: "receive", envelope: f.envelope(`Ev${n}`, `100.${n}`) });
    f.request({ action: "progress", eventId: `Ev${n}`, progress: { ts: `${200+n}.1`, mode: "text", title: "Task" } });
    const event = f.database.query<{ delivery_key: string }>("SELECT delivery_key FROM integration_slack_events WHERE event_id = ?1").get(`Ev${n}`)!;
    const response = { kind: "delivery", receipt: { conversationId: "conversation", messageId: `message${n}` }, flight: { id: `flight${n}`, invocationId: `invocation${n}` } };
    f.database.query("INSERT INTO integration_slack_deliveries (operation_id,event_key,channel_id,thread_ts,user_id,binding_revision,request_json,response_json,updated_at) VALUES (?1,?2,'C1','100.1','U1',1,'{}',?3,1000)").run(f.op.id, event.delivery_key, JSON.stringify(response));
  }
  const first = f.request({ action: "watches" });
  expect((first.bindings as unknown[])).toHaveLength(100);
  const second = f.request({ action: "watches", afterRowId: first.nextAfterRowId });
  expect((second.bindings as Array<{ eventId: string }>).map(row => row.eventId)).toEqual(["Ev101"]);
  expect(second.nextAfterRowId).toBe(0);
  expect((f.request({ action: "watches", afterRowId: second.nextAfterRowId }).bindings as unknown[])).toHaveLength(100);
});
