import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WORK_LIFECYCLE,
  WORK_LIFECYCLE_SCHEMA,
  compileWorkLifecycle,
  decideWorkMove,
  validateWorkLifecycle,
  workLifecycleToXState,
  type WorkLifecycle,
} from "./work-lifecycle.js";

const machine = compileWorkLifecycle(DEFAULT_WORK_LIFECYCLE);
const item = (over: Record<string, unknown> = {}) => ({ state: "open" as const, ownerId: null, labels: [], waitingOn: null, ...over });

describe("work lifecycle", () => {
  test("default lifecycle is valid and maps states to primary stations", () => {
    expect(validateWorkLifecycle(DEFAULT_WORK_LIFECYCLE)).toEqual([]);
    expect(machine.stationForState("open")).toBe("ready");
    expect(machine.stationForState("working")).toBe("doing");
    expect(machine.stationForState("cancelled")).toBe("dropped");
    expect(machine.nextStations("review")).toEqual(["doing", "done", "dropped"]);
  });

  test("rejects a station that cannot reach a terminal station", () => {
    const doc: WorkLifecycle = {
      schema: WORK_LIFECYCLE_SCHEMA, id: "x", name: "X", version: 1,
      stations: [{ id: "a", name: "A", state: "open" }, { id: "b", name: "B", state: "working" }, { id: "z", name: "Z", state: "done" }],
      transitions: [{ from: "a", to: "b" }, { from: "b", to: "a" }],
    };
    expect(validateWorkLifecycle(doc).join(" ")).toContain("cannot reach");
  });

  test("denies a move that is not in the graph", () => {
    const d = decideWorkMove(machine, { item: item(), to: "review", moverId: "a" });
    expect(d.verdict).toBe("deny");
    expect(d.reasons[0]?.scope).toBe("graph");
  });

  test("holds Doing for anyone but the owner", () => {
    expect(decideWorkMove(machine, { item: item({ ownerId: "b" }), to: "doing", moverId: "a" }).verdict).toBe("hold");
    const ok = decideWorkMove(machine, { item: item({ ownerId: "a" }), to: "doing", moverId: "a" });
    expect(ok.verdict).toBe("allow");
    expect(ok.toState).toBe("working");
  });

  test("dropping needs a note and deny wins over hold", () => {
    expect(decideWorkMove(machine, { item: item(), to: "dropped", moverId: "a" }).verdict).toBe("deny");
    expect(decideWorkMove(machine, { item: item(), to: "dropped", moverId: "a", note: "dup" }).verdict).toBe("allow");
  });

  test("done with judges is pending review; unsettled children hold it", () => {
    const working = item({ state: "working", ownerId: "a" });
    const d = decideWorkMove(machine, { item: working, to: "done", moverId: "a", children: [{ state: "done" }] });
    expect(d.verdict).toBe("allow");
    expect(d.review).toBe("pending");
    expect(d.judges).toEqual(["definition-of-done"]);
    const held = decideWorkMove(machine, { item: working, to: "done", moverId: "a", children: [{ state: "working" }] });
    expect(held.verdict).toBe("hold");
    expect(held.review).toBe("not_needed");
  });

  test("placement wins over state, shadow rules never change the verdict", () => {
    const doc: WorkLifecycle = {
      ...DEFAULT_WORK_LIFECYCLE, id: "shadow",
      stations: DEFAULT_WORK_LIFECYCLE.stations.map((s) => s.id === "ready"
        ? { ...s, rules: [{ id: "ready-labelled", check: { kind: "has_label", label: "sized" }, effect: "deny", message: "Size it.", shadow: true }] }
        : s),
    };
    const m = compileWorkLifecycle(doc);
    const placed = item({ placement: { lifecycleId: "shadow", lifecycleVersion: 1, station: "backlog", revision: 1, movedAt: 0 } });
    const d = decideWorkMove(m, { item: placed, to: "ready", moverId: "a" });
    expect(d.from).toBe("backlog");
    expect(d.verdict).toBe("allow");
    expect(d.reasons.find((r) => r.ruleId === "ready-labelled")).toMatchObject({ outcome: "fail", shadow: true });
  });

  test("a placement whose station no longer matches the state falls back to the state", () => {
    const stale = item({ state: "done", placement: { lifecycleId: "scout.default", lifecycleVersion: 1, station: "doing", revision: 3, movedAt: 0 } });
    expect(decideWorkMove(machine, { item: stale, to: "doing", moverId: "a" }).from).toBe("done");
  });

  test("hash is stable and the XState export carries every station", () => {
    expect(compileWorkLifecycle(structuredClone(DEFAULT_WORK_LIFECYCLE)).hash).toBe(machine.hash);
    const x = workLifecycleToXState(machine) as { initial: string; states: Record<string, { on: Record<string, unknown> }> };
    expect(x.initial).toBe("ready");
    expect(Object.keys(x.states)).toEqual(machine.order);
    expect(x.states.doing!.on["MOVE.review"]).toEqual({ target: "review" });
  });
});
