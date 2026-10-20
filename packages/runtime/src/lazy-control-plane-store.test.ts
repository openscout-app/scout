import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { BrokerRouteAliasStore } from "./broker-route-alias-store.js";
import { LazyControlPlaneStore } from "./lazy-control-plane-store.js";
import type {
  ControlPlaneSqliteDatabase,
  ControlPlaneSqliteStatement,
} from "./sqlite-adapter.js";
import type { SQLiteControlPlaneStore } from "./sqlite-store.js";

describe("LazyControlPlaneStore", () => {
  test("wires projection, aliases, and trust without opening SQLite", () => {
    let openings = 0;
    const store = fakeStore();
    const shared = new LazyControlPlaneStore(() => {
      openings += 1;
      return store;
    });

    const routeAliases = new BrokerRouteAliasStore(shared.routeAliasDatabase);
    const projectionFactory = shared.createProjectionStore;
    const trustedPeers = shared;

    expect(routeAliases).toBeDefined();
    expect(projectionFactory).toBeDefined();
    expect(trustedPeers).toBeDefined();
    expect(openings).toBe(0);

    expect(routeAliases.list({
      ownerRealmId: "mesh-1",
      projectKey: "project-1",
      nodeId: "node-1",
    })).toEqual([]);
    expect(openings).toBe(1);
    expect(projectionFactory("ignored.sqlite")).toBe(store);
    expect(openings).toBe(1);
    expect(shared.listTrustedPeers()).toEqual([]);
    expect(openings).toBe(1);
  });

  test("reopens after projection ownership closes the current store", () => {
    let openings = 0;
    const shared = new LazyControlPlaneStore(() => {
      openings += 1;
      return fakeStore();
    });

    const first = shared.get();
    first.close();
    const second = shared.get();

    expect(first.isClosed).toBe(true);
    expect(second).not.toBe(first);
    expect(openings).toBe(2);
    shared.close();
  });

  test("coordination transactions reserve the WAL writer before reading", () => {
    const root = mkdtempSync(join(tmpdir(), "scout-coordination-writer-"));
    const writer = new Database(join(root, "state.sqlite"));
    const projection = new Database(join(root, "state.sqlite"));
    try {
      writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE counter(value INTEGER); INSERT INTO counter VALUES(0)");
      projection.exec("PRAGMA busy_timeout=0");
      const shared = new LazyControlPlaneStore(() => ({ ...fakeStore(), writerDb: writer }));
      let competingWriterBlocked = false;
      const update = shared.routeAliasDatabase.transaction(() => {
        writer.query("SELECT value FROM counter").get();
        // The projection worker can commit on another connection between the
        // coordination read and write. A deferred transaction cannot upgrade
        // that stale read snapshot, even with busy_timeout configured.
        try { projection.query("UPDATE counter SET value=value+10").run(); }
        catch (error) { competingWriterBlocked = (error as { code?: string }).code === "SQLITE_BUSY"; }
        writer.query("UPDATE counter SET value=value+1").run();
        return "committed";
      });
      expect(update()).toBe("committed");
      expect(competingWriterBlocked).toBe(true);
      expect(writer.query("SELECT value FROM counter").get()).toEqual({ value: 1 });
      // The reservation is released, so the worker can make progress afterward.
      projection.query("UPDATE counter SET value=value+10").run();
      expect(writer.query("SELECT value FROM counter").get()).toEqual({ value: 11 });
    } finally { projection.close(); writer.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("closing an unused provider does not construct its store", () => {
    let openings = 0;
    const shared = new LazyControlPlaneStore(() => {
      openings += 1;
      return fakeStore();
    });

    shared.close();
    shared.close();

    expect(openings).toBe(0);
    expect(() => shared.get()).toThrow("control-plane SQLite store is closed");
  });
});

function fakeStore(): SQLiteControlPlaneStore {
  let closed = false;
  const statement: ControlPlaneSqliteStatement = {
    all: () => [],
    get: () => null,
    run: () => undefined,
  };
  const database: ControlPlaneSqliteDatabase = {
    exec: () => undefined,
    query: () => statement,
  };
  return {
    get isClosed() {
      return closed;
    },
    writerDb: database,
    trustedPeer: () => undefined,
    listTrustedPeers: () => [],
    knownTrustedPeerKey: () => false,
    upsertTrustedPeer: () => undefined,
    revokeTrustedPeer: () => false,
    claimPeerNonce: () => true,
    compactAndPruneMeshNodes: () => ({
      rehomedNodeCount: 0,
      prunedNodeCount: 0,
      rehomedMappings: [],
    }),
    close: () => {
      closed = true;
    },
  } as unknown as SQLiteControlPlaneStore;
}
