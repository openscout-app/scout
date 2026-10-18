import { expect, test } from "bun:test";
import { submitLatticesComposer } from "./lattices-composer.js";
function snapshot(elements: unknown[], warnings: string[] = []) { return { ok: true, snapshotId: "s1", target: { wid: 123 }, warnings, elements }; }
const field = { id: "e1", role: "AXTextArea", enabled: true, value: "reply", focused: true };
test("content anchors focus then Return, and checks activity immediately before sending", async () => {
  const calls: string[] = [];
  await submitLatticesComposer("reply", async () => { calls.push("activity"); }, async method => { calls.push(method); return method === "computer.windowState" ? snapshot([field]) : { ok: true }; });
  expect(calls).toEqual(["computer.windowState", "computer.elementAction", "computer.windowState", "activity", "computer.pressKey"]);
});
test.each([[], [field, field], [{ ...field, value: "wrong" }], [{ ...field, role: "AXButton" }]])("ambiguous or missing exact composer never presses Return: %j", async elements => {
  let keys = 0;
  await expect(submitLatticesComposer("reply", async () => {}, async method => { if (method === "computer.pressKey") keys++; return snapshot(elements); })).rejects.toThrow();
  expect(keys).toBe(0);
});
test("a thread that becomes busy after focus is not submitted", async () => {
  let keys = 0;
  await expect(submitLatticesComposer("reply", async () => { throw new Error("busy"); }, async method => { if (method === "computer.pressKey") keys++; return method === "computer.windowState" ? snapshot([field]) : { ok: true }; })).rejects.toThrow("busy");
  expect(keys).toBe(0);
});

// Model Lattices' Swift Character-based, unflagged 240-character AX summary.
function latticesValue(value: string): string {
  const characters = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map(part => part.segment);
  return characters.length > 240 ? characters.slice(0, 237).join("") + "..." : value;
}

test.each(["x", "😀", "e\u0301"])("a truncated %s composer cannot impersonate an exact reply ending in ...", async character => {
  const requested = character.repeat(237) + "...";
  const differentComposer = character.repeat(237) + " NOT THE REQUESTED REPLY";
  expect(differentComposer).not.toBe(requested);
  expect(latticesValue(differentComposer)).toBe(requested);
  const calls: string[] = [];
  await expect(submitLatticesComposer(requested, async () => { calls.push("activity"); }, async method => {
    calls.push(method);
    return method === "computer.windowState" ? snapshot([{ ...field, value: latticesValue(differentComposer) }]) : { ok: true };
  })).rejects.toThrow("truncated");
  expect(calls).toEqual(["computer.windowState"]);
});

test.each([
  ["239 characters ending in ...", "x".repeat(236) + "..."],
  ["240 ASCII characters", "x".repeat(240)],
  ["240 emoji", "😀".repeat(240)],
])("an unambiguous boundary value remains submittable: %s", async (_label, text) => {
  const calls: string[] = [];
  await submitLatticesComposer(text, async () => { calls.push("activity"); }, async method => {
    calls.push(method);
    return method === "computer.windowState" ? snapshot([{ ...field, value: latticesValue(text) }]) : { ok: true };
  });
  expect(calls).toEqual(["computer.windowState", "computer.elementAction", "computer.windowState", "activity", "computer.pressKey"]);
});

test("a real long reply cannot match its truncated snapshot", async () => {
  const text = "x".repeat(241);
  const calls: string[] = [];
  await expect(submitLatticesComposer(text, async () => {}, async method => {
    calls.push(method);
    return snapshot([{ ...field, value: latticesValue(text) }]);
  })).rejects.toThrow();
  expect(calls).toEqual(["computer.windowState"]);
});

test("even a literal 240-character reply ending in ... needs full-value evidence", async () => {
  const text = "x".repeat(237) + "...";
  expect(latticesValue(text)).toBe(text);
  const calls: string[] = [];
  await expect(submitLatticesComposer(text, async () => {}, async method => {
    calls.push(method);
    return snapshot([{ ...field, value: text }]);
  })).rejects.toThrow("truncated");
  expect(calls).toEqual(["computer.windowState"]);
});

test("a composer that grows into a truncated value after focus is never submitted", async () => {
  let focused = false;
  const calls: string[] = [];
  await expect(submitLatticesComposer("reply", async () => { calls.push("activity"); }, async method => {
    calls.push(method);
    if (method === "computer.windowState") return snapshot([{ ...field, value: focused ? latticesValue("reply".repeat(100)) : "reply" }]);
    if (method === "computer.elementAction") focused = true;
    return { ok: true };
  })).rejects.toThrow("exact reply");
  expect(calls).toEqual(["computer.windowState", "computer.elementAction", "computer.windowState"]);
});
