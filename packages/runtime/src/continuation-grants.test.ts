import { describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendContinuationAudit,
  claimContinuationActuation,
  releaseContinuationActuation,
  DEFAULT_CONTINUATION_LEVEL,
  decideContinuation,
  loadContinuationPolicy,
  parseContinuationPolicy,
  resolveContinuationGrant,
} from "./continuation.js";

const pane = {
  herdrSession: "default",
  paneId: "w1:p2",
  terminalId: "term-p2",
  cwd: "/work/dev/openscout",
  foregroundCwd: "/work/dev/openscout/packages/web",
};

const BASH_PERMISSION = `
 Bash command

   bun test packages/web/server

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for this command
   3. No

 Esc to cancel · Tab to amend
`;

describe("continuation grants", () => {
  test("the default level continues nothing", () => {
    expect(DEFAULT_CONTINUATION_LEVEL).toBe("ask");
    expect(decideContinuation({ paneBody: BASH_PERMISSION }).act).toBe("notify");
  });

  test("no file, bad version, or junk is no grants", () => {
    const dir = mkdtempSync(join(tmpdir(), "continuation-grants-"));
    expect(loadContinuationPolicy(join(dir, "missing.json")).grants).toEqual([]);
    writeFileSync(join(dir, "junk.json"), "{not json");
    expect(loadContinuationPolicy(join(dir, "junk.json")).grants).toEqual([]);
    expect(parseContinuationPolicy({ version: 2, grants: [{ scope: "project", path: "/x", level: "silent" }] }).grants)
      .toEqual([]);
    expect(parseContinuationPolicy({ version: 1, grants: [{ scope: "project", path: "/x", level: "yolo" }] }).grants)
      .toEqual([]);
    expect(parseContinuationPolicy({ version: 1 }).allowModel).toBe(false);
  });

  test("refuses root and relative project paths", () => {
    const policy = parseContinuationPolicy({
      version: 1,
      grants: [
        { scope: "project", path: "/", level: "silent" },
        { scope: "project", path: "dev/openscout", level: "silent" },
      ],
    });
    expect(policy.grants).toEqual([]);
  });

  test("a pane with no grant is ask", () => {
    expect(resolveContinuationGrant(parseContinuationPolicy({ version: 1, grants: [] }), pane))
      .toEqual({ level: "ask", source: "default" });
  });

  test("a project grant applies only when every pane directory is inside it", () => {
    const policy = parseContinuationPolicy({
      version: 1,
      grants: [{ scope: "project", path: "/work/dev/openscout", level: "workspace" }],
    });
    expect(resolveContinuationGrant(policy, pane).level).toBe("workspace");
    expect(resolveContinuationGrant(policy, { ...pane, foregroundCwd: "/work/dev/other" }).level).toBe("ask");
    // Sibling prefix is not inside.
    expect(resolveContinuationGrant(policy, {
      ...pane,
      cwd: "/work/dev/openscout-worktrees/x",
      foregroundCwd: null,
    }).level).toBe("ask");
    expect(resolveContinuationGrant(policy, { ...pane, cwd: null, foregroundCwd: null }).level).toBe("ask");
  });

  test("the deepest project grant wins, and a session grant beats both", () => {
    const policy = parseContinuationPolicy({
      version: 1,
      grants: [
        { scope: "project", path: "/work/dev", level: "unattended" },
        { scope: "project", path: "/work/dev/openscout", level: "ask" },
        { scope: "session", herdrSession: "other", paneId: "w1:p2", level: "silent" },
      ],
    });
    expect(resolveContinuationGrant(policy, pane).level).toBe("ask");
    expect(resolveContinuationGrant(policy, { ...pane, herdrSession: "other" })).toEqual({
      level: "silent",
      source: "session:other:w1:p2",
    });
  });

  test("a pane straddling a narrower ask grant is ask", () => {
    const policy = parseContinuationPolicy({
      version: 1,
      grants: [
        { scope: "project", path: "/repo", level: "workspace" },
        { scope: "project", path: "/repo/sensitive", level: "ask" },
      ],
    });
    expect(resolveContinuationGrant(policy, {
      herdrSession: "s",
      paneId: "p",
      cwd: "/repo",
      foregroundCwd: "/repo/sensitive",
    }).level).toBe("ask");
    expect(resolveContinuationGrant(policy, {
      herdrSession: "s",
      paneId: "p",
      cwd: "/repo/src",
      foregroundCwd: "/repo",
    }).level).toBe("workspace");
  });

  test("a session grant does not leak to another session with the same pane id", () => {
    const policy = parseContinuationPolicy({
      version: 1,
      grants: [{ scope: "session", herdrSession: "a", paneId: "w1:p2", level: "silent" }],
    });
    expect(resolveContinuationGrant(policy, { ...pane, herdrSession: "b", cwd: null, foregroundCwd: null }).level)
      .toBe("ask");
  });

  test("audit appends JSON lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "continuation-audit-"));
    const path = join(dir, "logs", "audit.jsonl");
    const entry = {
      at: 1,
      outcome: "attempt" as const,
      herdrSession: "default",
      paneId: "term-p2",
      level: "workspace" as const,
      grant: "project:/x",
      command: "bun test",
      risk: "workspace",
      keys: ["enter"],
      source: "rules" as const,
      reason: "workspace continues workspace",
    };
    appendContinuationAudit(entry, path);
    appendContinuationAudit({ ...entry, outcome: "sent" }, path);
    const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.outcome)).toEqual(["attempt", "sent"]);
  });

  test("a claim is exclusive until it expires", () => {
    const dir = mkdtempSync(join(tmpdir(), "continuation-claim-"));
    // Pinned clock: on the real clock, a pause longer than the 20 ms ttl lets the
    // second short claim win. Anchored at real time because pruning reads real file mtimes.
    const now = Date.now();
    try {
      setSystemTime(new Date(now));
      expect(claimContinuationActuation("default:term-p2:bun test", 30_000, dir)).toBe(true);
      expect(claimContinuationActuation("default:term-p2:bun test", 30_000, dir)).toBe(false);
      expect(claimContinuationActuation("default:term-p2:curl", 30_000, dir)).toBe(true);
      expect(claimContinuationActuation("short", 20, dir)).toBe(true);
      expect(claimContinuationActuation("short", 20, dir)).toBe(false);
      setSystemTime(new Date(now + 60));
      expect(claimContinuationActuation("short", 20, dir)).toBe(true);
    } finally {
      setSystemTime();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("simultaneous claims never both win, including across a bucket edge", () => {
    const dir = mkdtempSync(join(tmpdir(), "continuation-claim-race-"));
    const ttl = 1_000;
    // Pinned clock, anchored near real time because pruning reads real file mtimes.
    const edge = (Math.floor(Date.now() / ttl) + 1) * ttl;
    const conflicting = [[edge - 1, edge - 1], [edge - 1, edge], [edge - 400, edge + 500], [edge, edge + ttl - 1]];
    try {
      for (const [round, [first, second]] of conflicting.entries()) {
        const key = `race-${round}`;
        setSystemTime(new Date(first));
        expect(claimContinuationActuation(key, ttl, dir)).toBe(true);
        setSystemTime(new Date(second));
        expect(claimContinuationActuation(key, ttl, dir)).toBe(false);
      }
      // Two ttls apart share no bucket, so both claims win.
      setSystemTime(new Date(edge));
      expect(claimContinuationActuation("spaced", ttl, dir)).toBe(true);
      setSystemTime(new Date(edge + 2 * ttl));
      expect(claimContinuationActuation("spaced", ttl, dir)).toBe(true);
    } finally {
      setSystemTime();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


test("failed input releases only this process's claim, so a retry can acquire it", () => {
  const dir = mkdtempSync(join(tmpdir(), "continuation-release-"));
  try {
    expect(claimContinuationActuation("failed-prompt", 30_000, dir)).toBe(true);
    expect(claimContinuationActuation("other-prompt", 30_000, dir)).toBe(true);
    releaseContinuationActuation("failed-prompt", dir);
    expect(claimContinuationActuation("failed-prompt", 30_000, dir)).toBe(true);
    expect(claimContinuationActuation("other-prompt", 30_000, dir)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a foreign process's claim is never released", () => {
  const dir = mkdtempSync(join(tmpdir(), "continuation-release-foreign-"));
  try {
    expect(claimContinuationActuation("foreign-prompt", 30_000, dir)).toBe(true);
    for (const name of readdirSync(dir)) writeFileSync(join(dir, name), `999999 ${Date.now()}\n`);
    releaseContinuationActuation("foreign-prompt", dir);
    expect(claimContinuationActuation("foreign-prompt", 30_000, dir)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
