import { describe, expect, test } from "bun:test";
import { FirstSeenPermissionTracker, permissionShape } from "./first-seen.js";
import type { ContinuationAuditEntry } from "./grants.js";

describe("FirstSeenPermissionTracker", () => {
  test("groups file edits in the same project into one shape", () => {
    const tracker = new FirstSeenPermissionTracker();
    const first = tracker.observeAutoAllow({
      projectRoot: "/work/app",
      tool: "edit_file",
      command: "/work/app/a.swift",
    });
    const second = tracker.observeAutoAllow({
      projectRoot: "/work/app",
      tool: "Edit",
      command: "/work/app/b.swift",
    });
    expect(first.firstSeen).toBe(true);
    expect(first.label).toBe("Edit files");
    expect(second.firstSeen).toBe(false);
    expect(second.shapeKey).toBe(first.shapeKey);
  });

  test("normalizes shell command heads across paths and flags", () => {
    const a = permissionShape({
      projectRoot: "/work/scout",
      tool: "Bash",
      command: "cd /work/scout && git -C /work/scout status -sb",
    });
    const b = permissionShape({
      projectRoot: "/work/scout",
      tool: "run_command",
      command: "git status --short",
    });
    expect(a.shapeKey).toBe(b.shapeKey);
    expect(a.label).toBe("git status");
  });

  test("notifies on a brand-new command shape and stays quiet on repeats", () => {
    const tracker = new FirstSeenPermissionTracker();
    expect(tracker.observeAutoAllow({ projectRoot: "/work/scout", tool: "Bash", command: "swift test --filter foo" }).firstSeen).toBe(true);
    expect(tracker.observeAutoAllow({ projectRoot: "/work/scout", tool: "Bash", command: "swift test --filter bar" }).firstSeen).toBe(false);
    expect(tracker.observeAutoAllow({ projectRoot: "/work/scout", tool: "Bash", command: "xcodebuild build" }).firstSeen).toBe(true);
  });

  test("seeds from prior audit entries so daemon restarts do not re-notify", () => {
    const tracker = new FirstSeenPermissionTracker();
    const prior: ContinuationAuditEntry[] = [
      {
        at: Date.now() - 60_000,
        outcome: "sent",
        decision: "approved",
        via: "watcher",
        projectRoot: "/work/scout",
        tool: "Bash",
        command: "bun test packages/runtime",
        level: "workspace",
        grant: "project:/work/scout",
        risk: "workspace",
        keys: null,
        source: "rules",
        reason: "workspace continues workspace",
      },
      {
        at: Date.now() - 30_000,
        outcome: "asked",
        decision: "asked",
        projectRoot: "/work/scout",
        tool: "Bash",
        command: "xcodebuild build",
        level: "ask",
        grant: "default",
        risk: "unknown",
        keys: null,
        source: "rules",
        reason: "asked",
      },
    ];
    tracker.seed(prior);
    expect(tracker.observeAutoAllow({ projectRoot: "/work/scout", tool: "Bash", command: "bun test" }).firstSeen).toBe(false);
    // An asked-only entry was never approved, so a later auto-allow is still first-seen.
    expect(tracker.observeAutoAllow({ projectRoot: "/work/scout", tool: "Bash", command: "xcodebuild build" }).firstSeen).toBe(true);
  });
});
