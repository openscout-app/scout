import { expect, test } from "bun:test";
import { parseWorkRetryOptions, WORK_RETRY_HELP } from "./work-retry.ts";
import { shouldEnsureBrokerUptodateForCommand } from "../uptodate.ts";

test("work-retry requires an explicit reusable attempt", () => {
  expect(parseWorkRetryOptions(["work-1", "--attempt", "1"])).toEqual({ workId: "work-1", attempt: 1 });
  expect(parseWorkRetryOptions(["--help"])).toBeNull();
  expect(WORK_RETRY_HELP).toContain("uncertain receipt");
  for (const args of [["work-1"], ["work-1", "--attempt", "0"], ["work-1", "--attempt", "1.5"], ["work-1", "--attempt", "1", "extra"]]) {
    expect(() => parseWorkRetryOptions(args)).toThrow("Usage: scout work-retry");
  }
  expect(shouldEnsureBrokerUptodateForCommand("work-retry", ["work-1", "--attempt", "1"])).toBe(false);
});
