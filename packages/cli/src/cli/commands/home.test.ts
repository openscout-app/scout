import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  registerActiveScoutBrokerService,
  unregisterActiveScoutBrokerService,
} from "@openscout/runtime/client";
import { createScoutCommandContext } from "../context.ts";
import { assertHomeMigrationWritersStopped, runHomeCommand } from "./home.ts";

const tempHomes: string[] = [];

function createSandboxHome() {
  const home = mkdtempSync(join(tmpdir(), "openscout-home-cli-test-"));
  tempHomes.push(home);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: process.env.PATH,
    // Point at a closed loopback port so tests never collide with a live host broker.
    OPENSCOUT_BROKER_URL: "http://127.0.0.1:1",
  };
  return { home, env };
}

afterEach(() => {
  for (const dir of tempHomes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("scout home CLI", () => {
  test("scout home status reports layout and pending moves in plain text and JSON", async () => {
    const { home, env } = createSandboxHome();
    mkdirSync(join(home, ".scout", "skills"), { recursive: true });
    writeFileSync(join(home, ".scout", "skills", "demo.md"), "# demo\n");
    mkdirSync(join(home, ".scout-desk"), { recursive: true });

    const plainLines: string[] = [];
    await runHomeCommand(
      createScoutCommandContext({ env, stdout: (line) => plainLines.push(line) }),
      ["status"],
    );
    const plain = plainLines.join("\n");
    expect(plain).toContain("OpenScout home:");
    expect(plain).toContain("Pending migration: 2 move(s)");
    expect(plain).toContain("scout home migrate --dry-run");

    const jsonLines: string[] = [];
    await runHomeCommand(
      createScoutCommandContext({ env, stdout: (line) => jsonLines.push(line), outputMode: "json" }),
      ["status"],
    );
    const parsed = JSON.parse(jsonLines.join("\n"));
    expect(parsed.migrationPending).toBe(true);
    expect(parsed.pendingMoves).toBe(2);
    expect(parsed.legacy.scout.exists).toBe(true);
    expect(parsed.legacy.desk.exists).toBe(true);
  });

  test("scout home migrate --dry-run previews moves without touching disk", async () => {
    const { home, env } = createSandboxHome();
    mkdirSync(join(home, ".scout", "artifacts"), { recursive: true });
    writeFileSync(join(home, ".scout", "artifacts", "note.txt"), "hello");
    mkdirSync(join(home, ".openscout", "release-evidence"), { recursive: true });

    const jsonLines: string[] = [];
    await runHomeCommand(
      createScoutCommandContext({ env, stdout: (line) => jsonLines.push(line) }),
      ["migrate", "--dry-run", "--json"],
    );
    const parsed = JSON.parse(jsonLines.join("\n"));
    expect(parsed.dryRun).toBe(true);
    expect(parsed.movedCount).toBe(0);
    expect(parsed.plan.moves.length).toBe(2);
    expect(existsSync(join(home, ".openscout", "state"))).toBe(false);
    expect(existsSync(join(home, ".scout", "artifacts", "note.txt"))).toBe(true);
  });

  test("scout home migrate --json executes migration with WAL checkpointing, 0700 pairing, and MOVED.md", async () => {
    const { home, env } = createSandboxHome();
    mkdirSync(join(home, ".scout", "pairing"), { recursive: true });
    writeFileSync(join(home, ".scout", "pairing", "key.json"), '{"k":1}');
    mkdirSync(join(home, ".scout", "work", "wt-keep"), { recursive: true });
    mkdirSync(join(home, ".openscout", "control-plane"), { recursive: true });

    const dbPath = join(home, ".openscout", "control-plane", "broker.sqlite");
    const db = new Database(dbPath, { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA wal_autocheckpoint = 0;");
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT);");
    db.query("INSERT INTO items (label) VALUES (?1);").run("cli-migrated");
    db.close();

    const jsonLines: string[] = [];
    await runHomeCommand(
      createScoutCommandContext({ env, stdout: (line) => jsonLines.push(line) }),
      ["migrate", "--json"],
      { assertWritersStopped: () => {} },
    );
    const parsed = JSON.parse(jsonLines.join("\n"));
    expect(parsed.dryRun).toBe(false);
    expect(parsed.movedCount).toBe(2);
    expect(parsed.journal.status).toBe("completed");
    expect(parsed.checkpointedDatabases).toContain(dbPath);

    // Verify migrated files, pairing mode 0700, worktree untouched, MOVED.md written
    expect(statSync(join(home, ".openscout", "state", "pairing")).mode & 0o777).toBe(0o700);
    expect(existsSync(join(home, ".scout", "work", "wt-keep"))).toBe(true);
    expect(existsSync(join(home, ".scout", "MOVED.md"))).toBe(true);
    expect(readFileSync(join(home, ".scout", "MOVED.md"), "utf8")).toContain("~/.openscout");

    const verifyDb = new Database(join(home, ".openscout", "state", "control-plane", "broker.sqlite"), { readonly: true });
    const rows = verifyDb.query("SELECT label FROM items;").all() as Array<{ label: string }>;
    verifyDb.close();
    expect(rows.map((row) => row.label)).toEqual(["cli-migrated"]);
  });

  test("scout home migrate refuses when a live broker responds on /health", async () => {
    const { home, env } = createSandboxHome();
    mkdirSync(join(home, ".scout", "skills"), { recursive: true });
    writeFileSync(join(home, ".scout", "skills", "stay.md"), "stay");

    const brokerUrl = "http://127.0.0.1:49999";
    registerActiveScoutBrokerService({
      baseUrl: brokerUrl,
      readHealth: async () => ({ ok: true, nodeId: "n1", meshId: null, counts: null }),
      readNode: async () => { throw new Error("unused"); },
      readSnapshot: async () => { throw new Error("unused"); },
      executeCommand: async () => { throw new Error("unused"); },
    });
    try {
      const liveEnv = { ...env, OPENSCOUT_BROKER_URL: brokerUrl };
      const context = createScoutCommandContext({ env: liveEnv, stdout: () => {} });
      await expect(runHomeCommand(context, ["migrate"])).rejects.toThrow(/broker is still running/i);
      expect(existsSync(join(home, ".scout", "skills", "stay.md"))).toBe(true);
      expect(existsSync(join(home, ".openscout", "skills"))).toBe(false);

      // Dry-run still works even while a broker is running, without touching disk.
      const dryLines: string[] = [];
      await runHomeCommand(
        createScoutCommandContext({ env: liveEnv, stdout: (line) => dryLines.push(line) }),
        ["migrate", "--dry-run", "--json"],
      );
      expect(JSON.parse(dryLines.join("\n")).dryRun).toBe(true);

      // Direct probe helper also fails clearly when probeBrokerReachable reports true.
      await expect(
        assertHomeMigrationWritersStopped(context, { probeBrokerReachable: async () => true }),
      ).rejects.toThrow(/Stop Scout services first/i);
    } finally {
      unregisterActiveScoutBrokerService(brokerUrl);
    }
  });

  test("renders help and rejects unknown subcommands or flags", async () => {
    const { env } = createSandboxHome();
    const lines: string[] = [];
    await runHomeCommand(
      createScoutCommandContext({ env, stdout: (line) => lines.push(line) }),
      ["--help"],
    );
    expect(lines.join("\n")).toContain("Usage: scout home status");
    expect(lines.join("\n")).toContain("scout home migrate [--dry-run] [--json]");

    await expect(
      runHomeCommand(createScoutCommandContext({ env, stdout: () => {} }), ["bogus"]),
    ).rejects.toThrow("unknown home subcommand");
    await expect(
      runHomeCommand(createScoutCommandContext({ env, stdout: () => {} }), ["status", "--dry-run"]),
    ).rejects.toThrow("unexpected argument");
  });

  test("scout home status and migrate report planned and applied host config updates", async () => {
    const { home, env } = createSandboxHome();
    const legacySupport = process.platform === "darwin"
      ? join(home, "Library", "Application Support", "OpenScout")
      : join(home, ".local", "share", "openscout");
    const hooksPath = join(home, ".gemini", "config", "hooks.json");
    mkdirSync(join(home, ".gemini", "config"), { recursive: true });
    writeFileSync(
      hooksPath,
      `${JSON.stringify({
        openscout: {
          Stop: [{ type: "command", command: `'${join(legacySupport, "runtime", "hooks", "openscout-antigravity-permission-hook.sh")}'` }],
        },
      }, null, 2)}\n`,
    );

    const statusLines: string[] = [];
    await runHomeCommand(
      createScoutCommandContext({ env, stdout: (line) => statusLines.push(line) }),
      ["status"],
    );
    expect(statusLines.join("\n")).toContain("1 host config update(s)");

    const dryLines: string[] = [];
    await runHomeCommand(
      createScoutCommandContext({ env, stdout: (line) => dryLines.push(line) }),
      ["migrate", "--dry-run"],
    );
    expect(dryLines.join("\n")).toContain(`[update] ${hooksPath} (antigravity-hooks, 1 reference(s))`);

    const migrateLines: string[] = [];
    await runHomeCommand(
      createScoutCommandContext({ env, stdout: (line) => migrateLines.push(line) }),
      ["migrate"],
      { assertWritersStopped: () => {} },
    );
    expect(migrateLines.join("\n")).toContain("host configs updated:");
    expect(migrateLines.join("\n")).toContain(`${hooksPath} (antigravity-hooks, 1 reference(s))`);
    expect(readFileSync(hooksPath, "utf8")).toContain(join(home, ".openscout", "state", "runtime", "hooks"));
  });
});
