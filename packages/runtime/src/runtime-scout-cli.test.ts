import { afterEach, expect, test } from "bun:test";

import { resolveRuntimeScoutCliInvocation } from "./setup.js";

const saved = process.env.OPENSCOUT_SCOUT_COMMAND;
afterEach(() => {
  if (saved === undefined) delete process.env.OPENSCOUT_SCOUT_COMMAND;
  else process.env.OPENSCOUT_SCOUT_COMMAND = saved;
});

test("a hook runs the CLI beside this runtime, not whichever scout is on PATH", () => {
  delete process.env.OPENSCOUT_SCOUT_COMMAND;
  const invocation = resolveRuntimeScoutCliInvocation();
  expect(invocation).toContain("/packages/cli/src/main.ts'");
  expect(invocation!.startsWith("'")).toBe(true);
});

test("an explicit OPENSCOUT_SCOUT_COMMAND still wins", () => {
  process.env.OPENSCOUT_SCOUT_COMMAND = "/opt/scout/bin/scout";
  expect(resolveRuntimeScoutCliInvocation()).toBe("/opt/scout/bin/scout");
});
