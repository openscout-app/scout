import { describe, expect, test } from "bun:test";

import { taskReadyLine, taskReadyListed, taskReadyNotify } from "./task-ready.js";

describe("taskReadyLine", () => {
  test("takes the first prose line, without markdown", () => {
    expect(taskReadyLine("## Result\n\n- Opened [PR 12](https://x) with **two** `fixes`.\n- More")).toBe("Opened PR 12 with two fixes.");
  });
  test("skips code fences and falls back to a heading", () => {
    expect(taskReadyLine("```\nnoise\n```\n# Shipped")).toBe("Shipped");
    expect(taskReadyLine("   \n---\n")).toBe("");
  });
  test("cuts a long line at a word", () => {
    const line = taskReadyLine(`${"word ".repeat(80)}`, 40);
    expect(line.length).toBeLessThanOrEqual(40);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("taskReadyListed", () => {
  const ready = { state: "ready" as const, at: 10, summary: "Done.", nodeId: "n" };
  test("held Ready leaves the list until its work changes", () => {
    expect(taskReadyListed(ready)).toBe(true);
    expect(taskReadyListed({ ...ready, heldAt: 20 }, 15)).toBe(false);
    expect(taskReadyListed({ ...ready, heldAt: 20 }, 25)).toBe(true);
    expect(taskReadyListed({ ...ready, state: "continued" })).toBe(false);
  });
});

describe("taskReadyNotify", () => {
  test("the flight's mark wins over the ask's", () => {
    const on = { readyNotify: { on: true, byId: "operator", at: 1 } };
    const off = { readyNotify: { on: false, byId: "operator", at: 2 } };
    expect(taskReadyNotify({ metadata: on }, { metadata: {} })).toBe(true);
    expect(taskReadyNotify({ metadata: on }, { metadata: off })).toBe(false);
    expect(taskReadyNotify(undefined, undefined)).toBe(false);
  });
});
