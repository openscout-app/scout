import { expect, test } from "bun:test";
import { scoutUserSpawnEnvironment } from "./scout-state-paths.js";

test("attribution key files never reach harness environments", () => {
  const env = scoutUserSpawnEnvironment({ ...process.env, OPENSCOUT_ATTRIBUTION_KEY_FILE: "/private/attribution-key" });
  expect(env.OPENSCOUT_ATTRIBUTION_KEY_FILE).toBeUndefined();
});
