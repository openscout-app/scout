import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import type {
  CollaborationRecord,
  ControlEvent,
  FlightRecord,
  InvocationRequest,
  ScoutDeliverRequest,
  ScoutDeliverResponse,
} from "@openscout/protocol";
import { parseRolePassAnswer, SCOUT_PM_ROLE_ID } from "@openscout/protocol";

import { assignRole } from "./assigned-roles-store.js";
import { migrateControlPlaneDatabaseSchema } from "./control-plane-migrations.js";
import { buildRolePassBundle, rolePassBrief, rolePassDeliverRequest } from "./role-pass-runner.js";
import { RolePassService } from "./role-pass-service.js";
import { readRoleSlot, writeRoleSlot } from "./role-slots-store.js";
import type { ControlPlaneSqliteDatabase } from "./sqlite-adapter.js";

function card(id: string, title: string, state: string, extra: Partial<CollaborationRecord> = {}): CollaborationRecord {
  return {
    id, kind: "work_item", title, state, acceptanceState: "none", createdById: "operator", ownerId: "dev-agent",
    nextMoveOwnerId: "dev-agent", createdAt: 1, updatedAt: 10, ...extra,
  } as CollaborationRecord;
}

const STATIONS = [{ id: "doing", state: "working", name: "Doing" }, { id: "done", state: "done", name: "Done" }];

function setup() {
  const db = new Database(":memory:") as unknown as ControlPlaneSqliteDatabase;
  migrateControlPlaneDatabaseSchema(db);
  const pm = assignRole(db, { roleId: SCOUT_PM_ROLE_ID, agentId: "pm-agent", scope: { kind: "agent" }, assignedById: "operator" });
  const records = new Map<string, CollaborationRecord>([
    ["work-a", card("work-a", "Ship the slot", "working", { updatedAt: 30 })],
    ["work-b", card("work-b", "Fix the failed run", "waiting", { waitingOn: { kind: "actor", label: "operator" }, updatedAt: 20 })],
    ["work-c", card("work-c", "Old landing", "done", { updatedAt: 5 })],
  ]);
  let items = [
    { workId: "work-a", station: "doing", revision: 2 },
    { workId: "work-b", station: "doing", revision: 1 },
    { workId: "work-c", station: "done", revision: 4 },
  ];
  const invocations = new Map<string, InvocationRequest>();
  const flights = new Map<string, FlightRecord>();
  const delivered: ScoutDeliverRequest[] = [];
  const published: ControlEvent[] = [];
  const timers: Array<() => void> = [];
  const service = new RolePassService({
    nodeId: "node-1",
    openDb: () => db,
    work: { board: () => ({ lifecycle: { lifecycle: { stations: STATIONS } }, items }) },
    runtime: {
      invocation: (id) => invocations.get(id),
      flightForInvocation: (id) => [...flights.values()].find((flight) => flight.invocationId === id),
      collaborationRecord: (id) => records.get(id),
    },
    invocations: () => invocations.values(),
    deliver: async (request) => {
      delivered.push(request);
      const invocation = {
        id: `inv-${delivered.length}`, requesterId: request.requesterId!, requesterNodeId: "node-1", targetAgentId: request.targetAgentId!,
        action: "consult", task: request.body, ensureAwake: true, stream: false, createdAt: 100 + delivered.length, metadata: request.invocationMetadata,
      } as InvocationRequest;
      invocations.set(invocation.id, invocation);
      const flight = { id: `flight-${delivered.length}`, invocationId: invocation.id, requesterId: "system", targetAgentId: "pm-agent", state: "running" } as FlightRecord;
      flights.set(flight.id, flight);
      return { kind: "delivery", flight } as unknown as ScoutDeliverResponse;
    },
    publish: (event) => published.push(event),
    now: () => 1000,
    setTimer: (run) => { timers.push(run); return timers.length; },
    clearTimer: () => {},
  });
  return {
    db, pm, records, invocations, flights, delivered, published, service,
    setItems: (next: typeof items) => { items = next; },
    fireTimers: async () => { for (const run of timers.splice(0)) run(); await Promise.resolve(); await Promise.resolve(); },
  };
}

describe("role pass bundle", () => {
  test("stamps every open card, reads no done card, and names what changed since the last slot", () => {
    const cards = [
      { workId: "work-a", revision: 2, station: "doing", stationName: "Doing", open: true },
      { workId: "work-b", revision: 1, station: "doing", stationName: "Doing", open: true },
      { workId: "work-c", revision: 4, station: "done", stationName: "Done", open: false },
      { workId: "work-d", revision: 7, station: "done", stationName: "Done", open: false },
    ];
    const { records } = setup();
    records.set("work-d", card("work-d", "Landed today", "done"));
    const bundle = buildRolePassBundle({
      assignmentId: "role-pm-1",
      slot: { assignmentId: "role-pm-1", roleId: "pm", version: 3, stamp: { "work-a": 2, "work-d": 6 }, sentences: [], writtenById: "pm-agent", writtenAt: 1 },
      cards,
      record: (id) => records.get(id),
    });

    expect(bundle.version).toBe(3);
    expect(bundle.open.map((c) => c.id)).toEqual(["work-a", "work-b"]);
    expect(bundle.changed.map((c) => [c.id, c.readRevision])).toEqual([["work-b", null], ["work-d", 6]]);
    expect(bundle.stamp).toEqual({ "work-a": 2, "work-b": 1, "work-d": 7 });
    expect(bundle.stamp).not.toHaveProperty("work-c");

    const brief = rolePassBrief(bundle);
    expect(brief).toContain("\"id\": \"work-b\"");
    expect(brief).toContain("\"waitingOn\": \"operator\"");
    expect(brief).not.toContain("Old landing");
  });

  test("the pass ask is a fresh session from the runtime, marked, with no work item", () => {
    const bundle = buildRolePassBundle({ assignmentId: "role-pm-1", slot: null, cards: [], record: () => undefined });
    const request = rolePassDeliverRequest({
      assignment: { id: "role-pm-1", roleId: "pm", agentId: "pm-agent" } as never, bundle, nodeId: "node-1", now: 5, reason: "page.open",
    });
    expect(request).toMatchObject({
      requesterId: "system", targetAgentId: "pm-agent", intent: "consult", execution: { session: "new", placement: "background" },
      invocationMetadata: { rolePass: "role-pm-1", rolePassVersion: 0, rolePassStamp: {}, rolePassReason: "page.open" },
    });
    expect(request.workItem).toBeUndefined();
    expect(request.collaborationRecordId).toBeUndefined();
  });

  test("the answer parser takes the last sentences block and nothing else", () => {
    expect(parseRolePassAnswer("Read three cards.\n```json\n{\"sentences\": [{\"text\": \"A\", \"cites\": [\"work-a\"]}]}\n```")).toEqual([{ text: "A", cites: ["work-a"] }]);
    expect(parseRolePassAnswer("{\"sentences\": []}")).toEqual([]);
    expect(parseRolePassAnswer("Nothing to report.")).toBeNull();
    expect(parseRolePassAnswer("```json\n{\"other\": 1}\n```")).toBeNull();
  });
});

describe("role pass service", () => {
  test("a work change starts one pass; its answer lands in the slot with the stamp code gave it", async () => {
    const h = setup();
    h.service.noteEvent({ id: "e1", kind: "collaboration.upserted", ts: 1, actorId: "operator", payload: { record: h.records.get("work-a")! } } as ControlEvent);
    await h.fireTimers();
    expect(h.delivered).toHaveLength(1);
    expect(h.service.runningPass(h.pm.id)).toEqual({ flightId: "flight-1" });
    // The lock holds: a page open returns the running pass.
    expect(await h.service.ensure(h.pm.id)).toEqual({ flightId: "flight-1", started: false, behind: true });

    const flight = { ...h.flights.get("flight-1")!, state: "completed", output: "Done.\n```json\n{\"sentences\": [{\"text\": \"work-b waits on the operator.\", \"cites\": [\"work-b\"]}]}\n```" } as FlightRecord;
    h.flights.set(flight.id, flight);
    expect(h.service.applyTerminalFlight(h.db, flight, h.invocations.get("inv-1"))).toContain(`wrote slot ${h.pm.id} v1`);
    expect(readRoleSlot(h.db, h.pm.id)).toMatchObject({ version: 1, stamp: { "work-a": 2, "work-b": 1 }, writtenById: "pm-agent" });
    expect(h.published).toEqual([expect.objectContaining({ kind: "role.slot.written", payload: { assignmentId: h.pm.id, roleId: "pm", version: 1 } })]);
    expect(h.service.runningPass(h.pm.id)).toBeNull();
    expect(await h.service.ensure(h.pm.id)).toEqual({ flightId: null, started: false, behind: false });
  });

  test("an answer that cites an unseen card, or lands on a newer slot, leaves the slot alone", async () => {
    const h = setup();
    await h.service.ensure(h.pm.id);
    const invocation = h.invocations.get("inv-1")!;
    const answer = (text: string) => ({ ...h.flights.get("flight-1")!, state: "completed", output: text } as FlightRecord);

    expect(h.service.applyTerminalFlight(h.db, answer("{\"sentences\": [{\"text\": \"Landed.\", \"cites\": [\"work-c\"]}]}"), invocation))
      .toContain("outside the stamp: work-c");
    expect(h.service.applyTerminalFlight(h.db, { ...answer("{\"sentences\": []}"), state: "failed" }, invocation)).toContain("pass failed");

    writeRoleSlot(h.db, { assignmentId: h.pm.id, actorId: "pm-agent", expectedVersion: 0, stamp: {}, sentences: [] });
    expect(h.service.applyTerminalFlight(h.db, answer("{\"sentences\": []}"), invocation)).toContain("409");
    expect(readRoleSlot(h.db, h.pm.id)?.version).toBe(1);
    expect(h.published).toHaveLength(0);
  });

  test("a pass that outlived a restart still holds the lock", async () => {
    const first = setup();
    await first.service.ensure(first.pm.id);
    const restarted = new RolePassService({
      nodeId: "node-1",
      openDb: () => first.db,
      work: { board: () => ({ lifecycle: { lifecycle: { stations: STATIONS } }, items: [] }) },
      runtime: {
        invocation: (id) => first.invocations.get(id),
        flightForInvocation: (id) => [...first.flights.values()].find((flight) => flight.invocationId === id),
        collaborationRecord: () => undefined,
      },
      invocations: () => first.invocations.values(),
      deliver: async () => { throw new Error("must not start a second pass"); },
      publish: () => {},
    });
    expect(restarted.runningPass(first.pm.id)).toEqual({ flightId: "flight-1" });
    expect(await restarted.ensure(first.pm.id)).toMatchObject({ flightId: "flight-1", started: false });
    restarted.stop();
  });
});
