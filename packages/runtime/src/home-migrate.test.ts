import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HOME_MIGRATE_JOURNAL_FILENAME,
  HOME_MIGRATE_LOCK_FILENAME,
  HOME_MIGRATE_MOVED_FILENAME,
  HomeMigrationError,
  inspectHomeLayoutStatus,
  planHomeMigration,
  resolveHomeMigrationPaths,
  runHomeMigration,
  type HomeMigrationJournal,
} from "./home-migrate.ts";

const sandboxes: string[] = [];

function createSandbox(platform: NodeJS.Platform = "darwin", env: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), "openscout-home-migrate-test-"));
  sandboxes.push(home);
  const paths = resolveHomeMigrationPaths({ home, platform, env });
  return { home, platform, env, paths };
}

function createWalDatabase(dbPath: string, marker: string): void {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new Database(dbPath, { create: true });
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA wal_autocheckpoint = 0;");
    db.exec("CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, marker TEXT NOT NULL);");
    db.query("INSERT INTO entries (marker) VALUES (?1);").run(marker);
  } finally {
    db.close();
  }
}

function readDbMarkers(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.query("SELECT marker FROM entries ORDER BY id ASC;").all() as Array<{ marker: string }>;
    return rows.map((row) => row.marker);
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("planHomeMigration & runHomeMigration", () => {
  test("dry-run previews every move and conflict with zero disk mutations and no lock", async () => {
    const { home, platform, env, paths } = createSandbox("darwin");
    mkdirSync(join(paths.legacyScoutDir, "skills"), { recursive: true });
    writeFileSync(join(paths.legacyScoutDir, "skills", "custom.md"), "# skill\n");
    writeFileSync(join(paths.legacyScoutDir, "config.json"), '{"version":1}\n');
    mkdirSync(join(paths.legacyScoutDir, "work", "wt-1"), { recursive: true });
    mkdirSync(join(paths.openscoutHome, "control-plane"), { recursive: true });
    mkdirSync(join(paths.openscoutHome, "release-evidence"), { recursive: true });
    mkdirSync(paths.legacySupportDir, { recursive: true });
    writeFileSync(join(paths.legacySupportDir, "settings.json"), '{"ok":true}\n');
    writeFileSync(join(paths.legacySupportDir, "old.bak"), "backup");
    writeFileSync(join(paths.legacySupportDir, "scratch.tmp"), "temp");
    mkdirSync(paths.legacyDeskDir, { recursive: true });
    mkdirSync(join(home, ".fab"), { recursive: true });
    writeFileSync(join(home, ".fab", "keep.txt"), "fab-owned");

    const result = await runHomeMigration({ home, platform, env, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.movedCount).toBe(0);
    expect(result.plan.moves.length).toBeGreaterThanOrEqual(6);
    expect(result.plan.skipped.some((entry) => entry.source === join(paths.legacyScoutDir, "work") && entry.reason?.includes("git worktree move"))).toBe(true);
    expect(result.plan.skipped.some((entry) => entry.source.endsWith("old.bak"))).toBe(true);
    expect(result.plan.skipped.some((entry) => entry.source.endsWith("scratch.tmp"))).toBe(true);
    expect(result.plan.entries.some((entry) => entry.source.includes(".fab"))).toBe(false);

    // Zero disk mutations: no state dir, no cache dir, no lock, no journal, no MOVED.md.
    expect(existsSync(paths.stateDir)).toBe(false);
    expect(existsSync(paths.cacheDir)).toBe(false);
    expect(existsSync(paths.lockPath)).toBe(false);
    expect(existsSync(paths.journalPath)).toBe(false);
    expect(existsSync(join(paths.legacyScoutDir, HOME_MIGRATE_MOVED_FILENAME))).toBe(false);
    expect(existsSync(join(paths.legacyScoutDir, "skills", "custom.md"))).toBe(true);
    expect(existsSync(paths.legacyDeskDir)).toBe(true);
  });

  test("migrates all layout classes, checkpoints real SQLite WAL databases, enforces 0700 pairing, leaves work and .fab untouched, and writes MOVED.md", async () => {
    const { home, platform, env, paths } = createSandbox("darwin");

    // 1. Legacy ~/.scout operator catalogs, config fallbacks, state, and worktrees
    for (const dir of ["skills", "artifacts", "reports", "reviews"]) {
      mkdirSync(join(paths.legacyScoutDir, dir), { recursive: true });
      writeFileSync(join(paths.legacyScoutDir, dir, `${dir}.txt`), dir);
    }
    for (const file of ["config.json", "user.json", "project.json", "continuation-policy.json", "crew.json"]) {
      writeFileSync(join(paths.legacyScoutDir, file), JSON.stringify({ file }));
    }
    mkdirSync(join(paths.legacyScoutDir, "pairing"), { recursive: true });
    chmodSync(join(paths.legacyScoutDir, "pairing"), 0o755);
    writeFileSync(join(paths.legacyScoutDir, "pairing", "identity.key"), "secret");
    mkdirSync(join(paths.legacyScoutDir, "local-edge"), { recursive: true });
    mkdirSync(join(paths.legacyScoutDir, "world-team"), { recursive: true });
    mkdirSync(join(paths.legacyScoutDir, "world-team-history"), { recursive: true });
    mkdirSync(join(paths.legacyScoutDir, "work", "feature-branch"), { recursive: true });
    writeFileSync(join(paths.legacyScoutDir, "work", "feature-branch", ".git"), "gitdir: /repo/.git/worktrees/feature-branch\n");

    // 2. ~/.openscout state + cache (including real SQLite WAL DB with uncheckpointed rows)
    const brokerDbSource = join(paths.openscoutHome, "control-plane", "broker.sqlite");
    createWalDatabase(brokerDbSource, "wal-committed-row");
    for (const dir of ["relay", "instances", "work-archives", "backups"]) {
      mkdirSync(join(paths.openscoutHome, dir), { recursive: true });
      writeFileSync(join(paths.openscoutHome, dir, "marker.txt"), dir);
    }
    for (const dir of ["release-evidence", "evidence"]) {
      mkdirSync(join(paths.openscoutHome, dir), { recursive: true });
      writeFileSync(join(paths.openscoutHome, dir, "build.json"), "{}");
    }

    // 3. Legacy Application Support dir (including WAL DB, identity files, and stray .bak/.tmp)
    const supportRuntimeDb = join(paths.legacySupportDir, "runtime", "state.sqlite");
    createWalDatabase(supportRuntimeDb, "support-wal-row");
    for (const dir of ["logs", "deployments", "catalog"]) {
      mkdirSync(join(paths.legacySupportDir, dir), { recursive: true });
    }
    for (const file of [
      "settings.json",
      "relay-agents.json",
      "managed-installs.json",
      "agent-status.json",
      "workspace-state.json",
      ".host-info",
      "rpc-runtime-cutover-v1",
      "node-identity.json",
      "node-tls-identity.json",
    ]) {
      writeFileSync(join(paths.legacySupportDir, file), file);
    }
    writeFileSync(join(paths.legacySupportDir, "settings.json.bak"), "stray-bak");
    writeFileSync(join(paths.legacySupportDir, "partial.tmp"), "stray-tmp");

    // 4. Scout Desk and untouched ~/.fab
    mkdirSync(join(paths.legacyDeskDir, "grabs"), { recursive: true });
    writeFileSync(join(paths.legacyDeskDir, "grabs", "clip.txt"), "desk-grab");
    mkdirSync(join(home, ".fab"), { recursive: true });
    writeFileSync(join(home, ".fab", "config.json"), '{"fab":true}');

    let writerChecks = 0;
    const result = await runHomeMigration({
      home,
      platform,
      env,
      assertWritersStopped: () => {
        writerChecks += 1;
      },
      now: () => new Date("2026-11-28T12:00:00.000Z"),
    });

    expect(writerChecks).toBe(1);
    expect(result.dryRun).toBe(false);
    expect(result.resumed).toBe(false);
    expect(result.alreadyMigrated).toBe(false);
    expect(result.conflictCount).toBe(0);
    expect(result.journal?.status).toBe("completed");
    expect(existsSync(paths.lockPath)).toBe(false);

    // Operator catalogs & config moved to ~/.openscout top level
    for (const dir of ["skills", "artifacts", "reports", "reviews"]) {
      expect(readFileSync(join(paths.openscoutHome, dir, `${dir}.txt`), "utf8")).toBe(dir);
    }
    for (const file of ["config.json", "user.json", "project.json", "continuation-policy.json", "crew.json"]) {
      expect(existsSync(join(paths.openscoutHome, file))).toBe(true);
    }

    // Scout-owned state moved into ~/.openscout/state
    const movedBrokerDb = join(paths.stateDir, "control-plane", "broker.sqlite");
    const movedSupportDb = join(paths.stateDir, "runtime", "state.sqlite");
    expect(result.checkpointedDatabases).toContain(brokerDbSource);
    expect(result.checkpointedDatabases).toContain(supportRuntimeDb);
    expect(readDbMarkers(movedBrokerDb)).toEqual(["wal-committed-row"]);
    expect(readDbMarkers(movedSupportDb)).toEqual(["support-wal-row"]);
    // WAL files truncated (0 bytes or removed)
    for (const dbPath of [movedBrokerDb, movedSupportDb]) {
      const walPath = `${dbPath}-wal`;
      if (existsSync(walPath)) {
        expect(statSync(walPath).size).toBe(0);
      }
    }

    // Pairing directory mode enforced to 0700
    const movedPairingDir = join(paths.stateDir, "pairing");
    expect(existsSync(join(movedPairingDir, "identity.key"))).toBe(true);
    expect(statSync(movedPairingDir).mode & 0o777).toBe(0o700);

    for (const name of [
      "relay",
      "instances",
      "work-archives",
      "backups",
      "local-edge",
      "world-team",
      "world-team-history",
      "logs",
      "deployments",
      "catalog",
      "settings.json",
      "relay-agents.json",
      "managed-installs.json",
      "agent-status.json",
      "workspace-state.json",
      ".host-info",
      "rpc-runtime-cutover-v1",
      "node-identity.json",
      "node-tls-identity.json",
    ]) {
      expect(existsSync(join(paths.stateDir, name)), name).toBe(true);
    }

    // Stray .bak / .tmp skipped and NOT moved into state/
    expect(existsSync(join(paths.stateDir, "settings.json.bak"))).toBe(false);
    expect(existsSync(join(paths.stateDir, "partial.tmp"))).toBe(false);
    expect(existsSync(join(paths.legacySupportDir, "settings.json.bak"))).toBe(true);

    // Cache moved into ~/.openscout/cache
    expect(existsSync(join(paths.cacheDir, "release-evidence", "build.json"))).toBe(true);
    expect(existsSync(join(paths.cacheDir, "evidence", "build.json"))).toBe(true);

    // Scout Desk moved into ~/.openscout/.desk
    expect(existsSync(paths.legacyDeskDir)).toBe(false);
    expect(readFileSync(join(paths.deskDir, "grabs", "clip.txt"), "utf8")).toBe("desk-grab");

    // ~/.scout/work and ~/.fab completely untouched
    expect(existsSync(join(paths.legacyScoutDir, "work", "feature-branch", ".git"))).toBe(true);
    expect(existsSync(join(paths.openscoutHome, "work"))).toBe(false);
    expect(readFileSync(join(home, ".fab", "config.json"), "utf8")).toBe('{"fab":true}');

    // MOVED.md written in retired legacy folders that still exist
    const scoutMoved = join(paths.legacyScoutDir, HOME_MIGRATE_MOVED_FILENAME);
    const supportMoved = join(paths.legacySupportDir, HOME_MIGRATE_MOVED_FILENAME);
    expect(result.movedMarkers).toEqual([scoutMoved, supportMoved]);
    expect(readFileSync(scoutMoved, "utf8")).toContain("~/.openscout");
    expect(readFileSync(scoutMoved, "utf8")).toContain("git worktree move");
    expect(readFileSync(supportMoved, "utf8")).toContain("~/.openscout");

    // Second run is a clean idempotent no-op
    const secondRun = await runHomeMigration({ home, platform, env });
    expect(secondRun.alreadyMigrated).toBe(true);
    expect(secondRun.movedCount).toBe(0);
  });

  test("resolves Linux XDG_DATA_HOME and default ~/.local/share/openscout support paths", async () => {
    const customXdg = createSandbox("linux", { XDG_DATA_HOME: "/tmp/custom-xdg-ignored" });
    const xdgDir = join(customXdg.home, "xdg-data");
    const envWithXdg = { XDG_DATA_HOME: xdgDir };
    const xdgPaths = resolveHomeMigrationPaths({ home: customXdg.home, platform: "linux", env: envWithXdg });
    expect(xdgPaths.legacySupportDir).toBe(join(xdgDir, "openscout"));

    mkdirSync(xdgPaths.legacySupportDir, { recursive: true });
    writeFileSync(join(xdgPaths.legacySupportDir, "settings.json"), '{"linux":true}');
    const res = await runHomeMigration({ home: customXdg.home, platform: "linux", env: envWithXdg });
    expect(res.movedCount).toBe(1);
    expect(readFileSync(join(xdgPaths.stateDir, "settings.json"), "utf8")).toBe('{"linux":true}');

    const defaultLinux = createSandbox("linux", {});
    expect(defaultLinux.paths.legacySupportDir).toBe(join(defaultLinux.home, ".local", "share", "openscout"));
  });

  test("preserves conflicts with .legacy-YYYY-MM-DD and never merges two SQLite databases", async () => {
    const { home, platform, env, paths } = createSandbox("darwin");
    const targetDb = join(paths.stateDir, "control-plane", "broker.sqlite");
    const legacyDb = join(paths.openscoutHome, "control-plane", "broker.sqlite");
    createWalDatabase(targetDb, "current-state-row");
    createWalDatabase(legacyDb, "legacy-row");

    const result = await runHomeMigration({
      home,
      platform,
      env,
      now: () => new Date("2026-11-28T05:00:00.000Z"),
    });

    expect(result.conflictCount).toBe(1);
    expect(result.movedCount).toBe(0);
    const conflictDir = join(paths.stateDir, "control-plane.legacy-2026-11-28");
    expect(existsSync(conflictDir)).toBe(true);
    expect(existsSync(join(paths.openscoutHome, "control-plane"))).toBe(false);

    // Target DB retains ONLY its own data; legacy DB retains ONLY legacy data (never merged).
    expect(readDbMarkers(targetDb)).toEqual(["current-state-row"]);
    expect(readDbMarkers(join(conflictDir, "broker.sqlite"))).toEqual(["legacy-row"]);

    const journal = JSON.parse(readFileSync(paths.journalPath, "utf8")) as HomeMigrationJournal;
    expect(journal.status).toBe("completed");
    expect(journal.entries[0]?.status).toBe("conflict");
    expect(journal.entries[0]?.conflictTarget).toBe(conflictDir);
  });

  test("aborts immediately on EXDEV without copying or deleting source and releases lock", async () => {
    const { home, platform, env, paths } = createSandbox("darwin");
    mkdirSync(join(paths.legacyScoutDir, "skills"), { recursive: true });
    writeFileSync(join(paths.legacyScoutDir, "skills", "a.md"), "keep-me");

    let caught: unknown;
    try {
      await runHomeMigration({
        home,
        platform,
        env,
        renameImpl: () => {
          const err = new Error("EXDEV: cross-device link not permitted") as NodeJS.ErrnoException;
          err.code = "EXDEV";
          throw err;
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HomeMigrationError);
    expect((caught as HomeMigrationError).code).toBe("EXDEV");
    expect((caught as HomeMigrationError).message).toContain("EXDEV");

    // Source is completely intact, target was never copied, lock released, journal marked failed.
    expect(readFileSync(join(paths.legacyScoutDir, "skills", "a.md"), "utf8")).toBe("keep-me");
    expect(existsSync(join(paths.openscoutHome, "skills"))).toBe(false);
    expect(existsSync(paths.lockPath)).toBe(false);
    const journal = JSON.parse(readFileSync(paths.journalPath, "utf8")) as HomeMigrationJournal;
    expect(journal.status).toBe("failed");
    expect(journal.error).toContain("EXDEV");
  });

  test("refuses when exclusive lock is already held and does not remove the existing lock", async () => {
    const { home, platform, env, paths } = createSandbox("darwin");
    mkdirSync(join(paths.legacyScoutDir, "skills"), { recursive: true });
    mkdirSync(paths.stateDir, { recursive: true });
    writeFileSync(
      paths.lockPath,
      JSON.stringify({ pid: 99999, startedAt: "2026-11-28T00:00:00.000Z", command: "scout home migrate" }),
    );

    let caught: unknown;
    try {
      await runHomeMigration({ home, platform, env });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HomeMigrationError);
    expect((caught as HomeMigrationError).code).toBe("LOCK_HELD");
    expect((caught as HomeMigrationError).message).toContain("scout home migrate");
    expect((caught as HomeMigrationError).message).toContain("99999");
    expect(existsSync(paths.lockPath)).toBe(true);
    expect(existsSync(join(paths.legacyScoutDir, "skills"))).toBe(true);
    expect(existsSync(join(paths.openscoutHome, "skills"))).toBe(false);

    // Dry-run still succeeds without touching the lock.
    const dry = await runHomeMigration({ home, platform, env, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(existsSync(paths.lockPath)).toBe(true);
  });

  test("aborts before taking lock if assertWritersStopped fails", async () => {
    const { home, platform, env, paths } = createSandbox("darwin");
    mkdirSync(join(paths.legacyScoutDir, "skills"), { recursive: true });

    await expect(
      runHomeMigration({
        home,
        platform,
        env,
        assertWritersStopped: () => {
          throw new HomeMigrationError("WRITERS_RUNNING", "broker still running");
        },
      }),
    ).rejects.toThrow("broker still running");

    expect(existsSync(paths.stateDir)).toBe(false);
    expect(existsSync(paths.lockPath)).toBe(false);
    expect(existsSync(join(paths.legacyScoutDir, "skills"))).toBe(true);
  });

  test("resumes cleanly from an incomplete crash journal without deleting unconfirmed sources", async () => {
    const { home, platform, env, paths } = createSandbox("darwin");
    mkdirSync(join(paths.openscoutHome, "skills"), { recursive: true });
    writeFileSync(join(paths.openscoutHome, "skills", "already-moved.md"), "moved-before-crash");
    mkdirSync(join(paths.legacyScoutDir, "artifacts"), { recursive: true });
    writeFileSync(join(paths.legacyScoutDir, "artifacts", "pending.txt"), "still-at-source");
    mkdirSync(paths.stateDir, { recursive: true });

    const partialJournal: HomeMigrationJournal = {
      version: 1,
      startedAt: "2026-11-28T01:00:00.000Z",
      updatedAt: "2026-11-28T01:00:01.000Z",
      completedAt: null,
      status: "in_progress",
      openscoutHome: paths.openscoutHome,
      stateDir: paths.stateDir,
      cacheDir: paths.cacheDir,
      entries: [
        {
          id: "operator-catalog:1",
          category: "operator-catalog",
          sourceRoot: paths.legacyScoutDir,
          source: join(paths.legacyScoutDir, "skills"),
          target: join(paths.openscoutHome, "skills"),
          status: "pending",
          updatedAt: "2026-11-28T01:00:00.000Z",
        },
        {
          id: "operator-catalog:2",
          category: "operator-catalog",
          sourceRoot: paths.legacyScoutDir,
          source: join(paths.legacyScoutDir, "artifacts"),
          target: join(paths.openscoutHome, "artifacts"),
          status: "pending",
          updatedAt: "2026-11-28T01:00:00.000Z",
        },
      ],
      retiredRoots: [],
    };
    writeFileSync(paths.journalPath, JSON.stringify(partialJournal, null, 2));

    const result = await runHomeMigration({ home, platform, env });

    expect(result.resumed).toBe(true);
    expect(result.movedCount).toBe(2);
    expect(result.journal?.status).toBe("completed");
    expect(readFileSync(join(paths.openscoutHome, "skills", "already-moved.md"), "utf8")).toBe("moved-before-crash");
    expect(readFileSync(join(paths.openscoutHome, "artifacts", "pending.txt"), "utf8")).toBe("still-at-source");
    expect(existsSync(join(paths.legacyScoutDir, "artifacts"))).toBe(false);
    expect(existsSync(join(paths.legacyScoutDir, HOME_MIGRATE_MOVED_FILENAME))).toBe(true);
  });

  test("refuses symlink sources without moving symlinks or any sibling files", async () => {
    const { home, platform, env, paths } = createSandbox("darwin");
    const outsideTarget = join(home, "external-skills");
    mkdirSync(outsideTarget, { recursive: true });
    writeFileSync(join(outsideTarget, "a.md"), "external");
    mkdirSync(paths.legacyScoutDir, { recursive: true });
    symlinkSync(outsideTarget, join(paths.legacyScoutDir, "skills"));
    mkdirSync(join(paths.legacyScoutDir, "artifacts"), { recursive: true });
    writeFileSync(join(paths.legacyScoutDir, "artifacts", "keep.txt"), "untouched");

    const plan = planHomeMigration({ home, platform, env });
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0]?.source).toBe(join(paths.legacyScoutDir, "skills"));

    // Dry-run reports the refusal without throwing.
    const dry = await runHomeMigration({ home, platform, env, dryRun: true });
    expect(dry.refusedCount).toBe(1);

    // Real run refuses with SYMLINK_SOURCE and touches nothing.
    let caught: unknown;
    try {
      await runHomeMigration({ home, platform, env });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HomeMigrationError);
    expect((caught as HomeMigrationError).code).toBe("SYMLINK_SOURCE");
    expect(lstatSync(join(paths.legacyScoutDir, "skills")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(paths.legacyScoutDir, "artifacts", "keep.txt"))).toBe(true);
    expect(existsSync(join(paths.openscoutHome, "artifacts"))).toBe(false);
  });

  test("inspectHomeLayoutStatus reports pending moves, legacy roots, lock, and journal state", async () => {
    const { home, platform, env, paths } = createSandbox("darwin");
    mkdirSync(join(paths.legacyScoutDir, "skills"), { recursive: true });
    mkdirSync(paths.legacyDeskDir, { recursive: true });

    const before = inspectHomeLayoutStatus({ home, platform, env });
    expect(before.migrationPending).toBe(true);
    expect(before.pendingMoves).toBe(2);
    expect(before.legacy.scout.exists).toBe(true);
    expect(before.legacy.desk.exists).toBe(true);
    expect(before.journal.exists).toBe(false);

    await runHomeMigration({ home, platform, env });

    const after = inspectHomeLayoutStatus({ home, platform, env });
    expect(after.migrationPending).toBe(false);
    expect(after.pendingMoves).toBe(0);
    expect(after.legacy.scout.movedMarkerExists).toBe(true);
    expect(after.legacy.desk.exists).toBe(false);
    expect(after.deskDirExists).toBe(true);
    expect(after.journal.exists).toBe(true);
    expect(after.journal.status).toBe("completed");
    expect(after.journal.doneCount).toBe(2);
    expect(after.lock.held).toBe(false);
    expect(after.lock.path.endsWith(HOME_MIGRATE_LOCK_FILENAME)).toBe(true);
    expect(after.journal.path.endsWith(HOME_MIGRATE_JOURNAL_FILENAME)).toBe(true);
  });
});
