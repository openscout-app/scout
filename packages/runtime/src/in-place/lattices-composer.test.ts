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
