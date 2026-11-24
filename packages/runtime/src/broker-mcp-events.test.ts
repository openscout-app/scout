import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CollaborationRecord, ConversationDefinition, FlightRecord, McpEventPrincipal } from "@openscout/protocol";
import { BrokerMcpEvents } from "./broker-mcp-events.js";
import type { BrokerJournalEntry } from "./broker-journal.js";
import type { WebhookPost } from "./mcp-event-webhook.js";

const p: McpEventPrincipal = { kind: "oauth", id: "grant-a", ownerKey: "owner:a", node: "default", agentId: "agent:a", userId: "github:1" };
const secret = `whsec_${Buffer.alloc(32, 1).toString("base64")}`;
const rotated = `whsec_${Buffer.alloc(32, 2).toString("base64")}`;
const subscribe = (extra = {}) => ({ name: "message.created", arguments: { channel_id: "channel:a" }, delivery: { mode: "webhook", url: "https://example.com/events", secret }, ...extra });
const message = (id: string, at: number, extra = {}) => ({ kind: "message.record", message: { id, conversationId: "channel:a", actorId: "agent:writer", body: "hello", createdAt: at, visibility: "workspace", ...extra } } as unknown as BrokerJournalEntry);
const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function fixture(post?: WebhookPost) {
  const dir = mkdtempSync(join(tmpdir(), "scout-mcp-events-test-"));
  let db = new Database(join(dir, "events.sqlite"));
  let now = 1_800_000_000_000;
  let verified = 0;
  const channel = { id: "channel:a", kind: "channel", participantIds: [p.agentId] } as ConversationDefinition;
  const flights = new Map<string, FlightRecord>();
  const work = new Map<string, CollaborationRecord>();
  const resources = { channel: (id: string) => id === channel.id ? channel : undefined, flight: (id: string) => flights.get(id), work: (id: string) => work.get(id) };
  const options = { now: () => now, post: post ?? (async (_url: string, body: string) => { verified++; return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }; }) };
  let service = new BrokerMcpEvents(db, resources, options);
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get service() { return service; }, get db() { return db; }, get now() { return now; }, get verified() { return verified; }, channel, flights, work,
    advance: (ms: number) => { now += ms; }, restart: () => { db.close(); db = new Database(join(dir, "events.sqlite")); service = new BrokerMcpEvents(db, resources, options); } };
}

test("subscriptions and pending deliveries survive restart, refresh is idempotent, verification cache is bounded", async () => {
  const f = fixture();
  const first = await f.service.subscribe(p, subscribe());
  f.advance(60_000);
  expect((await f.service.subscribe(p, subscribe())).id).toBe(first.id);
  // A different subscription at this principal's verified URL reuses its challenge.
  const flight = subscribe({ name: "flight.completed", arguments: {} });
  await f.service.subscribe(p, flight);
  expect(f.verified).toBe(1);
  f.service.capture([message("m1", f.now)]);
  f.restart();
  const job = f.service.claim(p.ownerKey, p.node)!;
  expect(job.subscriptionId).toBe(first.id);
  expect(JSON.parse(job.body).data.message_id).toBe("m1");
  expect(f.service.claim(p.ownerKey, p.node)).toBeNull();
  f.advance(61_000);
  const recovered = f.service.claim(p.ownerKey, p.node)!;
  expect(recovered.id).toBe(job.id); expect(recovered.lease).not.toBe(job.lease);
  f.service.settle(job.id, job.lease, 200); // stale workers cannot acknowledge a new lease
  expect(f.service.prepare(recovered.id, recovered.lease)).not.toBeNull();
  f.service.settle(recovered.id, recovered.lease, 503);
  expect(f.service.claim(p.ownerKey, p.node)).toBeNull();
  f.advance(1001);
  const retry = f.service.claim(p.ownerKey, p.node)!;
  expect(retry.body).toBe(job.body);
  f.service.settle(retry.id, retry.lease, 200);
  f.service.capture([message("m1", f.now)]);
  expect(f.service.claim(p.ownerKey, p.node)).toBeNull(); // source dedup survives successful ack
  f.advance(180_000);
  await f.service.subscribe(p, subscribe());
  expect(f.verified).toBe(2); // refreshing does not slide verification's five-minute window
});

test("filters, resource access, private messages, and owner/node scopes prevent disclosure", async () => {
  const f = fixture();
  await expect(f.service.subscribe({ ...p, agentId: "outsider" }, subscribe())).rejects.toThrow("not accessible");
  await f.service.subscribe(p, subscribe());
  f.service.capture([message("old", f.now - 1), message("private", f.now, { visibility: "private" }), message("system", f.now, { visibility: "system" }), message("audience", f.now, { audience: { recipientIds: [p.agentId] } }), message("other", f.now, { conversationId: "channel:b" }), message("public", f.now)]);
  expect(f.service.claim("owner:b", p.node)).toBeNull();
  expect(f.service.claim(p.ownerKey, "other")).toBeNull();
  const job = f.service.claim(p.ownerKey, p.node)!;
  expect(JSON.parse(job.body).data.message_id).toBe("public");
  f.channel.participantIds = [];
  const ended = f.service.prepare(job.id, job.lease)!;
  expect(JSON.parse(ended.body)).toEqual({ type: "terminated", error: { code: -32024, message: "Access revoked" } });
  expect(ended.id).toStartWith("msg_terminated_");
  expect(f.service.prepare(job.id, job.lease)).toBeNull();
  f.advance(61_000);
  expect(f.service.claim(p.ownerKey, p.node)).toBeNull();
});

test("expiry, TTL cap, secret rotation and unsubscribe govern already queued deliveries", async () => {
  const f = fixture();
  const first = await f.service.subscribe(p, subscribe({ ttlMs: 30 * 86_400_000 }));
  expect(Date.parse(first.refreshBefore) - f.now).toBe(7 * 86_400_000);
  f.service.capture([message("m1", f.now)]);
  const next = subscribe({ delivery: { mode: "webhook", url: "https://example.com/events", secret: rotated }, ttlMs: 120_000 });
  expect((await f.service.subscribe(p, next)).id).toBe(first.id);
  const job = f.service.claim(p.ownerKey, p.node)!;
  expect(job.secret).toBe(rotated); expect(job.previousSecret).toBe(secret);
  await expect(f.service.unsubscribe({ ...p, id: "different-grant" }, next)).rejects.toMatchObject({ code: -32023 });
  expect(f.service.prepare(job.id, job.lease)).not.toBeNull();
  await f.service.unsubscribe(p, next);
  await expect(f.service.unsubscribe(p, next)).rejects.toMatchObject({ code: -32023 });
  expect(f.service.prepare(job.id, job.lease)).toBeNull();
  await f.service.subscribe(p, subscribe({ ttlMs: 1 }));
  f.service.capture([message("m2", f.now)]); f.advance(2);
  expect(f.service.claim(p.ownerKey, p.node)).toBeNull();
});

test("failed callback verification never activates a subscription", async () => {
  const f = fixture(async () => ({ status: 302, body: "{}" }));
  await expect(f.service.subscribe(p, subscribe())).rejects.toMatchObject({ code: -32027 });
  f.service.capture([message("m1", f.now)]);
  expect(f.service.claim(p.ownerKey, p.node)).toBeNull();
});

test("unsubscribe waits for an in-progress verification and cancels its result", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const f = fixture(async (_url, body) => { await pending; return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }; });
  const creating = f.service.subscribe(p, subscribe());
  const stopping = f.service.unsubscribe(p, subscribe());
  finish(); await creating; await stopping;
  f.service.capture([message("m1", f.now)]);
  expect(f.service.claim(p.ownerKey, p.node)).toBeNull();
});

test("410 and 413 each drop one delivery, transient retries are bounded", async () => {
  const f = fixture(); await f.service.subscribe(p, subscribe());
  f.service.capture([message("m1", f.now)]);
  let job = f.service.claim(p.ownerKey, p.node)!;
  f.service.settle(job.id, job.lease, 413);
  f.service.capture([message("m2", f.now)]);
  for (let attempt = 0; attempt < 8; attempt++) {
    job = f.service.claim(p.ownerKey, p.node)!; expect(job).not.toBeNull();
    f.service.settle(job.id, job.lease, 503); f.advance(300_001);
  }
  expect(f.service.claim(p.ownerKey, p.node)).toBeNull();
  f.service.capture([message("m3", f.now)]); job = f.service.claim(p.ownerKey, p.node)!;
  f.service.settle(job.id, job.lease, 410);
  f.service.capture([message("m4", f.now)]);
  expect(f.service.claim(p.ownerKey, p.node)?.subscriptionId).toBe(job.subscriptionId);
});

test("completion events belong only to the requester/target; waiting emits on transitions", async () => {
  const f = fixture();
  const flight = { id: "f1", invocationId: "i1", state: "completed", requesterId: p.agentId, targetAgentId: "agent:b", completedAt: f.now } as FlightRecord;
  f.flights.set(flight.id, flight);
  const waiting = { id: "w1", kind: "work_item", state: "waiting", title: "Need input", createdById: p.agentId, updatedAt: f.now } as CollaborationRecord;
  f.work.set(waiting.id, { ...waiting, state: "working" } as CollaborationRecord);
  await f.service.subscribe(p, subscribe({ name: "flight.completed", arguments: {} }));
  await f.service.subscribe(p, subscribe({ name: "work.waiting", arguments: { work_id: "w1" } }));
  f.service.capture([{ kind: "flight.record", flight }, { kind: "collaboration.record", record: waiting }] as BrokerJournalEntry[]);
  for (const name of ["flight.completed", "work.waiting"]) { const job = f.service.claim(p.ownerKey, p.node)!; expect(JSON.parse(job.body).name).toBe(name); f.service.settle(job.id, job.lease, 200); }
  f.service.capture([{ kind: "flight.record", flight: { ...flight, id: "unrelated", requesterId: "x", targetAgentId: "y" } }, { kind: "collaboration.record", record: { ...waiting, updatedAt: f.now + 1 } }] as BrokerJournalEntry[]);
  expect(f.service.claim(p.ownerKey, p.node)).toBeNull();
});


test("refresh after expiration discards missed deliveries; preparation uses a newly rotated key", async () => {
  const f = fixture();
  await f.service.subscribe(p, subscribe({ ttlMs: 100 }));
  f.service.capture([message("missed", f.now)]);
  f.advance(101);
  await f.service.subscribe(p, subscribe());
  expect(f.service.claim(p.ownerKey, p.node)).toBeNull();
  f.service.capture([message("new", f.now)]);
  const job = f.service.claim(p.ownerKey, p.node)!;
  await f.service.subscribe(p, subscribe({ delivery: { mode: "webhook", url: "https://example.com/events", secret: rotated } }));
  expect(f.service.prepare(job.id, job.lease)).toMatchObject({ secret: rotated, previousSecret: secret });
});

test("queue overflow is isolated and dropped sources remain seen", async () => {
  const f = fixture();
  const full = await f.service.subscribe(p, subscribe());
  const fill = (id: string) => f.db.transaction(() => {
    const insert = f.db.query("INSERT INTO mcp_event_outbox (id, subscription_id, body, next_at) VALUES (?, ?, ?, ?)");
    for (let i = 0; i < 1000; i++) insert.run(`${id}:seed-${i}`, id, "{}", f.now);
  })();
  fill(full.id);
  const other = { ...p, id: "grant-b" };
  const healthy = await f.service.subscribe(other, subscribe());
  const batch = [message("overflow-1", f.now), message("overflow-2", f.now)];
  expect(() => f.service.capture(batch)).not.toThrow();
  const count = (id: string) => f.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM mcp_event_outbox WHERE subscription_id = ?").get(id)!.n;
  expect(count(full.id)).toBe(1000);
  expect(count(healthy.id)).toBe(2);
  f.db.query("DELETE FROM mcp_event_outbox").run();
  f.service.capture(batch);
  expect(count(full.id)).toBe(0);
  expect(count(healthy.id)).toBe(0);

  // Even when all queues are full, the source is consumed rather than replayed.
  fill(full.id);
  fill(healthy.id);
  expect(() => f.service.capture([message("all-full", f.now)])).not.toThrow();
  f.db.query("DELETE FROM mcp_event_outbox").run();
  f.service.capture([message("all-full", f.now)]);
  expect(count(full.id)).toBe(0);
  expect(count(healthy.id)).toBe(0);
});
