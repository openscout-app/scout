import assert from "node:assert/strict";
import { test } from "node:test";

// The root, runtime, controller, and HTTP routes require Bun. These subpaths
// also support Node consumers through the package's emitted JS.
const nodeEntrypoints = [
  "host",
  "terminal",
  "pair-requests",
  "lan-beacon",
  "web-handoff",
  "artifacts",
  "answerer-claim",
];

for (const entrypoint of nodeEntrypoints) {
  const specifier = `@openscout/pairing/${entrypoint}`;
  test(`Node imports ${specifier} from dist`, async () => {
    assert.match(import.meta.resolve(specifier), /\/dist\/.+\.js$/);
    await import(specifier);
  });
}
