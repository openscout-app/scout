import { expect, test } from "bun:test";
import { readNativeAppThreads } from "./native-threads.js";
const id = "01a15049-5c97-7010-9db7-924ebb000d2c";
test("only live app lock holders are discoverable, without a search index", async () => {
  const result = await readNativeAppThreads({ listLocks: async () => [id + ".lock", "dead0000-0000-0000.lock", "garbage.lock"], heldByApp: async thread => thread === id, metadata: async () => ({ cwd: "/work" }) });
  expect(result).toMatchObject({ available: true, truncated: false, threads: [{ sessionId: id, cwd: "/work", deliveryModes: ["draft", "submit"] }] });
  expect(result.threads).toHaveLength(1);
});
test("missing live inventory reports unavailable, not absence", async () => {
  expect(await readNativeAppThreads({ listLocks: async () => { throw new Error("unavailable"); } })).toEqual({ threads: [], available: false, truncated: false });
});
