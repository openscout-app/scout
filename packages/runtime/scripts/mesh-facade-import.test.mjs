import assert from "node:assert/strict";
import { test } from "node:test";

test("importing the mesh facade does not change the host's metadata or decorator globals", async () => {
  const reflectKeys = Reflect.ownKeys(Reflect);
  const decorate = () => {};
  globalThis.__decorate = decorate;

  const { meshDialRank } = await import("@openscout/runtime/mesh");

  assert.equal(typeof meshDialRank, "function");
  assert.deepEqual(Reflect.ownKeys(Reflect), reflectKeys);
  assert.equal(globalThis.__decorate, decorate);
});
