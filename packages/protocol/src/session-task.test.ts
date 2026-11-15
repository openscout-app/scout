import { describe, expect, test } from "bun:test";

import { resolveSessionTaskLink, sessionTaskHeadline } from "./session-task.js";

describe("sessionTaskHeadline", () => {
  test("returns the first line that says something, as plain text", () => {
    expect(sessionTaskHeadline("\n\n## Fix the **launch** name\n\nMore detail.")).toBe("Fix the launch name");
    expect(sessionTaskHeadline("   ")).toBeNull();
    expect(sessionTaskHeadline(null)).toBeNull();
  });

  test("names a continued task by its successor, not the predecessor's result", () => {
    const task = "Previous task inv-1 (completed):\nShipped #12.\n\nSuccessor task:\nLand the follow-up";
    expect(sessionTaskHeadline(task)).toBe("Land the follow-up");
  });

  test("cuts a long line at a word", () => {
    const headline = sessionTaskHeadline(`Carry ${"the work item link ".repeat(20)}`, 40);
    expect(headline!.length).toBeLessThanOrEqual(40);
    expect(headline!.endsWith("…")).toBe(true);
  });
});

describe("resolveSessionTaskLink", () => {
  const titles: Record<string, string> = { "work-1": "First work", "work-2": "Second work\n\nwith detail" };

  test("reads the latest ask and ignores wakes", () => {
    expect(resolveSessionTaskLink([
      { task: "Start", collaborationRecordId: "work-1", action: "consult", createdAt: 1 },
      { task: "Steer it", collaborationRecordId: "work-2", action: "consult", createdAt: 2 },
      { task: "wake", action: "wake", createdAt: 3 },
    ], (id) => titles[id])).toEqual({
      workItemId: "work-2",
      workItemTitle: "Second work",
      currentTask: "Steer it",
    });
  });

  test("keeps the task when the ask has no work item, and nulls everything without an ask", () => {
    expect(resolveSessionTaskLink([{ task: "Quick question", createdAt: 1 }], () => "unused")).toEqual({
      workItemId: null,
      workItemTitle: null,
      currentTask: "Quick question",
    });
    expect(resolveSessionTaskLink([], () => null)).toEqual({
      workItemId: null,
      workItemTitle: null,
      currentTask: null,
    });
  });

  test("keeps the work item id when its record is not readable", () => {
    expect(resolveSessionTaskLink([{ task: "Do it", collaborationRecordId: "work-9", createdAt: 1 }], () => undefined))
      .toEqual({ workItemId: "work-9", workItemTitle: null, currentTask: "Do it" });
  });
});
