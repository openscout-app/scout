import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCliFixture, isolatedEnvironment } from "./helpers/cli-fixture.mjs";

const packageDirectory = createCliFixture();

test("scout wrapper keeps short help focused and sends the full inventory to detailed help", () => {
  const output = execFileSync("bun", ["./bin/scout.mjs", "--help"], {
    cwd: packageDirectory,
    env: isolatedEnvironment(),
    encoding: "utf8",
  });

  assert.match(output, /\bsetup\b/);
  assert.match(output, /\bstatus\b/);
  assert.match(output, /\bdoctor\b/);
  assert.match(output, /scout help --detail/);
  assert.doesNotMatch(output, /Implicit ask shortcut/);
  assert.doesNotMatch(output, /\bscout dev\b/);

  const detailed = execFileSync("bun", ["./bin/scout.mjs", "help", "--detail"], {
    cwd: packageDirectory,
    env: isolatedEnvironment(),
    encoding: "utf8",
  });
  assert.match(detailed, /\bpair\b/);
  assert.match(detailed, /\bserver\b/);
  assert.match(detailed, /Implicit ask shortcut/);
  assert.match(detailed, /positional recipients are errors; use --to <agent>/);
  assert.match(detailed, /Compatibility:/);
  assert.match(detailed, /\binit\b/);
});

test("scout wrapper exposes current ask routing help", () => {
  const output = execFileSync("bun", ["./bin/scout.mjs", "ask", "--help"], {
    cwd: packageDirectory,
    env: isolatedEnvironment(),
    encoding: "utf8",
  });

  assert.match(output, /--project <path>/);
  assert.match(output, /returns on acceptance/);
  assert.match(output, /scout reply --ref/);
});

test("removed send fails with an argument-preserving rewrite before routing", () => {
  assert.throws(() => execFileSync("bun", ["./bin/scout.mjs", "send", "--tracked", "--to", "worker", "review this"], {
    cwd: packageDirectory, env: isolatedEnvironment(), encoding: "utf8", stdio: "pipe", timeout: 10_000,
  }), error => {
    assert.notEqual(error.status, 0);
    assert.match(error.stderr.toString(), /Nothing was sent/);
    assert.match(error.stderr.toString(), /scout ask --to worker 'review this'/);
    return true;
  });
});

test("scout wrapper rejects unsupported ask session reuse before routing", () => {
  assert.throws(
    () => execFileSync(
      "bun",
      ["./bin/scout.mjs", "ask", "--session", "reuse", "--harness", "codex", "smoke"],
      {
        cwd: packageDirectory,
        env: isolatedEnvironment(),
        encoding: "utf8",
        stdio: "pipe",
      },
    ),
    (error) => {
      assert.match(error.stderr.toString(), /invalid session: reuse/);
      return true;
    },
  );
});


test("implicit positional recipients fail with an explicit route rewrite", () => {
  assert.throws(() => execFileSync("bun", ["./bin/scout.mjs", "@worker", "--fyi", "news"], {
    cwd: packageDirectory, env: isolatedEnvironment(), encoding: "utf8", stdio: "pipe", timeout: 10_000,
  }), error => {
    assert.notEqual(error.status, 0);
    assert.match(error.stderr.toString(), /positional recipients were removed; use scout ask --to worker --fyi news/);
    return true;
  });
});
