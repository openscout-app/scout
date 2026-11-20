import { expect, test } from "bun:test";
import { parseWorkRetryOptions, WORK_RETRY_HELP } from "./work-retry.ts";
import { shouldEnsureBrokerUptodateForCommand } from "../uptodate.ts";

test("work-retry defaults the attempt and accepts an explicit reusable one", () => {
  expect(parseWorkRetryOptions(["work-1"])).toEqual({ workId: "work-1" });
  expect(parseWorkRetryOptions(["work-1", "--attempt", "1"])).toEqual({ workId: "work-1", attempt: 1 });
  expect(parseWorkRetryOptions(["work-1", "--attempt=2"])).toEqual({ workId: "work-1", attempt: 2 });
  expect(parseWorkRetryOptions(["--help"])).toBeNull();
  expect(WORK_RETRY_HELP).toContain("uncertain receipt");
  for (const args of [["--attempt", "1"], ["work-1", "--attempt"], ["work-1", "--attempt", "0"], ["work-1", "--attempt", "1.5"],
    ["work-1", "--attempt", "1", "extra"], ["work-1", "--attempt=1", "extra"], ["work-1", "extra"]]) {
    expect(() => parseWorkRetryOptions(args)).toThrow("Usage: scout work-retry");
  }
  expect(shouldEnsureBrokerUptodateForCommand("work-retry", ["work-1", "--attempt", "1"])).toBe(false);
});
